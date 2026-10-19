// One scan that runs everything.
//
// Every pipeline here already existed and was already a queue job. What was missing was
// anything above them: an admin had to know that the "Universe Scan" scans issues but not
// screens, that the workflow inventory is a different button on a different tab, that the
// status history is a third, and that running them in the wrong order leaves the tabs
// disagreeing with each other. Five things to sequence by hand is a checklist, not a scan.
//
// Automation is deliberately not a stage. Jira publishes no API to enumerate automation
// rules -- the analysis is fed by importing a rule export by hand -- so a "run everything"
// that silently skipped it would be worse than one that says what it covers.

import { inventorySnapshotQueue } from "./queues.js";
import { logger } from "./logger.js";
import { FULL_SCAN_STALL_MS } from "./scan-timing.js";

// Order matters, and it is not the dependency order alone.
//
// Structural inventories run first because they take minutes and each one makes a tab
// useful the moment it lands. The issue crawl runs last because it is the long pole -- on a
// large site it is hours -- and putting it first would mean nothing else appeared until it
// finished. Health records at the end, when every input it scores has been refreshed.
//
// `needs` is the real dependency, asserted rather than assumed: status history joins against
// the workflow snapshot, and the issue crawl needs the field catalog to know what to count.
export const FULL_SCAN_STAGES = [
  {
    key: "workflows",
    label: "Workflow & status inventory",
    needs: [],
    // Runs inline: it fits inside one consumer invocation, and chaining through the queue
    // gives the next stage a fresh 900s rather than spending this one's remainder.
    mode: "inline",
  },
  { key: "screens", label: "Screen & scheme inventory", needs: [], mode: "inline" },
  // Cheapest structural stage by a wide margin: one paginated endpoint with everything
  // expanded, ~40 calls for 2,000 filters, no per-item walk. It earns its place early
  // because the field snapshot below is the thing its references protect.
  //
  // Handoff, not inline, since the resumable rewrite. The filter build no longer finishes in
  // one invocation by design -- it chunks, checkpoints and re-queues itself -- so the
  // orchestrator starts it and waits for its meta row to reach a terminal state.
  { key: "filters", label: "Saved filter inventory", needs: [], mode: "handoff" },
  // One call to enumerate, then one per dashboard for its gadgets. Between the filter build
  // (one paginated endpoint) and the screen build (a tab and field walk under every screen).
  // Handoff for the same reason, and more so: enumerating is one paginated search but the
  // gadget walk is one request per dashboard, which is what killed it as a single pass.
  { key: "dashboards", label: "Dashboard inventory", needs: [], mode: "handoff" },
  // Handoff, not inline, and this was the last stage to learn that lesson. runSnapshot walks
  // every custom field doing a rate-limited REST call or two apiece; on a large estate that
  // does not fit in one 900s consumer invocation, so run inline it was killed mid-walk every
  // time -- the orchestrator sat inside the call, never re-queued, and the hourly watchdog
  // burned three recovery attempts before failing the stage out. It now checkpoints and
  // re-queues itself like the filter and dashboard builds; the orchestrator starts it and
  // polls its meta row for a terminal state.
  { key: "fields", label: "Field snapshot", needs: [], mode: "handoff" },
  { key: "status-history", label: "Status history", needs: ["workflows"], mode: "inline" },
  // The issue type catalog and the schemes that gate which types a project may use. A
  // structural inventory like screens and workflows, and cheap -- a few hundred types, low
  // hundreds of schemes, one paginated call each. Ordered here rather than up with the other
  // structural stages only so it lands before the multi-hour issue crawl below without
  // disturbing the dependency-blocking cases the earlier stages exercise; it needs nothing,
  // so its position is a scheduling choice, not a correctness one.
  { key: "issue-types", label: "Issue type inventory", needs: [], mode: "inline" },
  // What Jira enforces on each field per project and work type: field schemes, or legacy
  // field configuration schemes + configurations on a site not yet migrated. Inline: the
  // per-owner item walk runs under its own time budget inside the consumer ceiling and
  // records what it did not reach as unread rather than overrunning.
  { key: "field-configs", label: "Field scheme / configuration inventory", needs: [], mode: "inline" },
  // Permission, issue-security and notification schemes with their holders and project
  // assignments. Structural and cheap -- dozens of schemes, one bulk call each plus one
  // per-project call for the permission scheme (Jira has no bulk for that one), best-effort.
  { key: "access", label: "Access scheme inventory", needs: [], mode: "inline" },
  // The two global value lists (resolutions, priorities). Two paginated calls, no per-item
  // walk -- the cheapest structural stage here.
  { key: "estate", label: "Priorities & resolutions inventory", needs: [], mode: "inline" },
  // Agile boards: one paginated list, then one configuration call per board. Heavier than
  // the value lists but lighter than the screen walk, and independent -- inline like the
  // other structural stages.
  { key: "boards", label: "Board inventory", needs: [], mode: "inline" },
  // The licensed-user roster: the access groups behind each application role, then one
  // paginated member walk per group at concurrency 3. Bounded by group count, not user
  // count, so it sits with the structural stages rather than near the crawl.
  //
  // It was outside the pipeline entirely until now -- buildable only from a queued job the
  // People tab fires -- which meant a scored pillar could report a roster months older than
  // everything beside it with nothing on screen saying so. buildUserSnapshot throws rather
  // than publishing an empty roster when the app cannot read application roles, and that is
  // the right outcome here too: the stage fails loudly and the pillar reports it did not
  // build, instead of the roster silently staying stale.
  { key: "people", label: "Licensed user roster", needs: [], mode: "inline" },
  // JSM Assets structure. Same story -- a scored pillar that never refreshed with the scan.
  //
  // Off Premium this is not an error: buildAssetSnapshot resolves the workspace first and
  // writes a terminal "unavailable" state rather than throwing, so on a site without Assets
  // this stage completes normally and the pillar reports not-applicable. That is why it can
  // sit unconditionally in the list instead of being gated on an edition check nothing else
  // in the pipeline performs.
  { key: "assets", label: "Assets (CMDB) structure", needs: [], mode: "inline" },
  {
    key: "issues",
    label: "Issue crawl",
    needs: ["fields"],
    // Handed off rather than run inline. The crawl is a multi-worker, multi-invocation
    // machine with its own resumption state; wrapping it in this one would be a second
    // implementation of something that already works.
    mode: "handoff",
  },
  // Diffs every inventory this scan just refreshed against the digests kept from the last
  // one, and appends the deltas to the change-history timeline. Runs after every inventory
  // stage and before health, so a future "deviation from baseline" signal can feed the score.
  { key: "drift", label: "Configuration drift", needs: [], mode: "inline" },
  { key: "health", label: "Record site health", needs: [], mode: "inline" },
];

// The quick scan: the same estate, minus the one thing Jira cannot tell us has changed.
//
// Issues carry an `updated` timestamp and JQL can filter on it -- `updated >= "-7d"` is a real
// query, and it is what the existing delta issue scan already runs. Filters, dashboards,
// screens and workflow schemes carry no such thing: their list/search endpoints have no
// modified-since parameter, and the objects Jira returns do not expose a last-edited
// timestamp at all (a filter's only date field is when someone last RAN it, not edited it).
// There is no query that means "just the ones that changed this week," because Jira does not
// keep that fact anywhere this app can read.
//
// So those four stages run in FULL every time a quick scan runs. That is a deliberate choice,
// not an oversight: a full walk of filters, dashboards, screens and workflow schemes is a few
// hundred to a few thousand calls, nothing next to the issue crawl, and pretending it can be
// windowed when it cannot would make "quick scan" a promise this app cannot keep for those
// four stages. What "quick" actually bounds is the one stage that dominates a full scan's
// wall-clock: the issue crawl, windowed to whatever the schedule configures.
//
// fields and issues collapse into ONE stage here, not two. The delta issue query already
// updates field x project usage counts in the same pass it counts issues -- see
// runDeltaIssueScanJob -- so a separate field-catalog stage has nothing left to do that the
// delta crawl does not already cover.
export const QUICK_SCAN_STAGES = [
  { key: "workflows", label: "Workflow & status inventory (full)", needs: [], mode: "inline" },
  { key: "screens", label: "Screen & scheme inventory (full)", needs: [], mode: "inline" },
  { key: "filters", label: "Saved filter inventory (full)", needs: [], mode: "handoff" },
  { key: "dashboards", label: "Dashboard inventory (full)", needs: [], mode: "handoff" },
  {
    key: "issues-delta",
    label: "Issues & field usage (changed since window)",
    needs: [],
    // Handed off, like the full crawl: it is a multi-page walk with its own resumption
    // bookkeeping, and wrapping it in this orchestrator would be a second implementation of
    // something that already works.
    mode: "handoff",
  },
  { key: "status-history", label: "Status history (full)", needs: ["workflows"], mode: "inline" },
  // Same full-refetch structural stage as in a full scan -- Jira has no changed-since signal
  // for issue types or their schemes either, so quick scan runs it in full like the other
  // four. Ordered after the delta crawl for the same reason it sits late in the full list.
  { key: "issue-types", label: "Issue type inventory (full)", needs: [], mode: "inline" },
  // No changed-since signal for field schemes or configurations either.
  { key: "field-configs", label: "Field scheme / configuration inventory (full)", needs: [], mode: "inline" },
  // Same full-refetch structural stage as a full scan -- Jira exposes no changed-since
  // signal for permission / security / notification schemes either.
  { key: "access", label: "Access scheme inventory (full)", needs: [], mode: "inline" },
  { key: "estate", label: "Priorities & resolutions inventory (full)", needs: [], mode: "inline" },
  // Boards carry no changed-since signal either, so quick scan refetches them in full like
  // the other structural stages.
  { key: "boards", label: "Board inventory (full)", needs: [], mode: "inline" },
  // Neither the roster nor the Assets structure has a changed-since signal either -- group
  // membership and object-type definitions carry no last-modified this app can query -- so
  // quick scan refetches both in full, like every other structural stage here.
  { key: "people", label: "Licensed user roster (full)", needs: [], mode: "inline" },
  { key: "assets", label: "Assets (CMDB) structure (full)", needs: [], mode: "inline" },
  { key: "drift", label: "Configuration drift", needs: [], mode: "inline" },
  { key: "health", label: "Record site health", needs: [], mode: "inline" },
];

export const QUICK_SCAN_STAGE_KEYS = QUICK_SCAN_STAGES.map((s) => s.key);

// How long the orchestrator will wait on a handoff stage before calling it dead.
//
// Waiting is a delayed re-queue of the orchestrator itself, so this is a count of polls rather
// than a duration -- multiply by FULL_SCAN_POLL_DELAY_SECONDS for wall-clock. The issue crawl
// gets far longer than the others because it legitimately runs for tens of minutes on a large
// site, and declaring it dead at the same threshold as a filter build would abort exactly the
// scan people care most about.
export const FULL_SCAN_POLL_DELAY_SECONDS = 30;
// issues-delta shares the issue crawl's generous ceiling: it is windowed, not unbounded, but a
// large site with a long lookback window can still run for tens of minutes. The default now
// only bounds a build that is genuinely FROZEN -- a handoff stage whose sub-build keeps
// advancing its own progress resets this count (see runScanStep), so a slow-but-alive filter
// or dashboard build is never abandoned for taking a while.
export const FULL_SCAN_MAX_POLLS = { issues: 480, "issues-delta": 240, default: 90 };

// How many times a single stage is retried before it is allowed to fail.
//
// A stage that throws, or a handoff whose sub-build reports failure, or one that freezes past
// the poll ceiling -- all three go back to `pending` and run again rather than being marked
// failed on the first bad outcome. Only after this many attempts does the stage actually fail.
export const MAX_STAGE_ATTEMPTS = 3;

// Capped exponential backoff before a stage retry runs, in SECONDS. Same shape as the HTTP
// retry in analysis.js -- min(cap, base * 2^n) + jitter -- so a stage failing on a transient
// 4xx/5xx (a 400 the endpoint throws under load, a rate-limit storm) is not hammered on a
// fixed 20s loop but backs off: ~20s, ~40s, ~80s. `attempt` is 1-based.
export function scanRetryDelaySeconds(attempt = 1) {
  const n = Math.max(0, (Number(attempt) || 1) - 1);
  return Math.min(300, 20 * 2 ** n) + Math.floor(Math.random() * 10);
}

// After every stage has resolved, if any FAILED or was SKIPPED, the whole set of them is
// reset to pending and the scan sweeps again -- up to this many times. Combined with
// MAX_STAGE_ATTEMPTS this is ~9 attempts at a flaky stage before the scan finally settles
// for "completed-with-failures". A scan should exhaust every reasonable retry before it
// tells someone a pillar did not build.
export const MAX_SCAN_SWEEPS = 2;

export function maxPollsFor(stageKey) {
  return FULL_SCAN_MAX_POLLS[stageKey] ?? FULL_SCAN_MAX_POLLS.default;
}

// A handoff stage's verdict, read from whatever meta row that pillar keeps.
//
// Every pillar spells its own progress differently but they all agree on the two endings, so
// this maps to three words the orchestrator understands. Anything unrecognised counts as still
// running: a stage is only declared finished on positive evidence, never on the absence of it.
export function handoffStageState(meta, { stale = false } = {}) {
  if (stale) return "failed";
  if (!meta) return "running";
  if (meta.state === "ready") return "done";
  if (meta.state === "failed") return "failed";
  if (meta.state === "cancelled") return "failed";
  return "running";
}

export const FULL_SCAN_STAGE_KEYS = FULL_SCAN_STAGES.map((s) => s.key);

// A stage older than this is treated as abandoned rather than in flight.
//
// Matches the workflow build's ceiling for the same reason: the consumer tops out at
// timeoutSeconds 900, so nothing legitimately running can still be working past it, plus a
// minute so a stage finishing right at the limit is never declared stale out from under it.
export const FULL_SCAN_STAGE_STALE_MS = 16 * 60 * 1000;

// How long the whole orchestrator can go without touching its own meta row before a
// watchdog treats the run as wedged rather than working.
//
// The orchestrator writes updatedAt on every step -- each handoff poll, each stage
// transition -- so a live loop keeps this fresh no matter how long the scan legitimately
// runs. A frozen updatedAt means the loop itself stopped: a lost queue message, or a
// consumer killed after starting a stage but before it could re-queue the next step.
// Nothing inside runScanStep can detect that, because runScanStep is what stopped being
// called. 20 minutes clears the 900s consumer ceiling plus the 30s poll delay with room to
// spare, and sits well inside the hourly cadence of the trigger that runs the watchdog.
export { FULL_SCAN_STALL_MS };

// How many times the watchdog will re-kick a stalled run before giving up on it.
//
// Reset to zero on every real stage transition, so this only climbs across *consecutive*
// stalls with no forward progress in between -- three of those, roughly three hours at the
// hourly cadence, is a run that is not coming back. It is then failed out rather than left
// "running" forever, which is the state that blocks every future scan from starting.
export const MAX_SCAN_RECOVERIES = 3;

// The hard wall on a single run's wall-clock, checked ahead of every progress-based guard.
//
// Every other limit here -- stage attempts, retry sweeps, consecutive-stall recoveries --
// resets on the smallest sign of progress, so a run that keeps limping forward (a stage
// retries, a recovery re-kicks, the loop writes updatedAt) can stay "running" indefinitely
// without any of them tripping. One was seen at 86 hours. Past this ceiling the run is
// failed out regardless of how healthy it looks: 8 hours is longer than the issue crawl
// takes on the largest sites measured, and a scan still going after that is not going to
// finish.
export const MAX_SCAN_TOTAL_MS = 8 * 60 * 60 * 1000;

export function initialStages(stageDefinitions = FULL_SCAN_STAGES) {
  return stageDefinitions.map((stage) => ({
    key: stage.key,
    label: stage.label,
    state: "pending",
    startedAt: null,
    completedAt: null,
    error: null,
    attempts: 0,
  }));
}

// A stage had a bad outcome. If it has attempts left, put it back to pending so the next
// step runs it again; only once the attempts are spent does it actually fail. Returns the
// updated stage list plus whether a retry was scheduled.
export function retryStageOrFail(stages, key, reason, { now = Date.now() } = {}) {
  const stage = stages.find((s) => s.key === key);
  const attempts = Number(stage?.attempts || 0) + 1;
  const detail = String(reason || "unknown error").slice(0, 260);

  if (attempts < MAX_STAGE_ATTEMPTS) {
    return {
      stages: markStage(stages, key, {
        state: "pending",
        startedAt: null,
        completedAt: null,
        attempts,
        error: `Attempt ${attempts} failed (${detail}); retrying.`,
      }),
      retried: true,
      attempts,
    };
  }
  return {
    stages: markStage(stages, key, {
      state: "failed",
      completedAt: new Date(now).toISOString(),
      attempts,
      error: `Failed after ${attempts} attempts. Last error: ${detail}`,
    }),
    retried: false,
    attempts,
  };
}

// The next stage to run, or null when the scan is done.
//
// Skips stages whose dependencies failed rather than running them against stale inputs: a
// status history built from a workflow snapshot that did not refresh is not a partial
// result, it is a wrong one.
export function nextStage(stages = [], stageDefinitions = FULL_SCAN_STAGES) {
  const byKey = new Map(stages.map((s) => [s.key, s]));
  for (const definition of stageDefinitions) {
    const stage = byKey.get(definition.key);
    if (!stage) continue;

    // Terminal -- step past it.
    if (stage.state === "done" || stage.state === "failed" || stage.state === "skipped") continue;

    // The earliest stage that has not finished. If it is already running it is in flight and
    // there is nothing to start -- returning a LATER pending stage here is exactly how a
    // second orchestrator loop (a delayed-not-lost queue message, or a recovery kick racing
    // the original) ends up running stages concurrently and out of order: status history and
    // health completing while the field snapshot they depend on is still going.
    if (stage.state === "running") return null;

    // It is pending. It can only be blocked by a dependency that finished WITHOUT succeeding
    // -- a dependency that simply has not run yet is an earlier stage, and the loop would
    // have already returned (or yielded) at it.
    const blocked = definition.needs.find((need) => {
      const dependency = byKey.get(need);
      return dependency && (dependency.state === "failed" || dependency.state === "skipped");
    });
    if (blocked) return { ...definition, blockedBy: blocked };
    return definition;
  }
  return null;
}

// A stage failing does not fail the scan.
//
// Four of the six are independent, and an admin whose screen inventory 401s still wants the
// workflow and field data the same run would have produced. The scan reports "completed with
// failures" rather than throwing the whole pass away -- but it never reports plain success,
// because a green tick over a stage that did not run is the kind of thing people act on.
export function summarizeStages(stages = []) {
  const failed = stages.filter((s) => s.state === "failed");
  const skipped = stages.filter((s) => s.state === "skipped");
  const done = stages.filter((s) => s.state === "done");

  return {
    total: stages.length,
    done: done.length,
    failed: failed.length,
    skipped: skipped.length,
    complete: stages.every((s) => ["done", "failed", "skipped"].includes(s.state)),
    state: failed.length || skipped.length ? "completed-with-failures" : "ready",
  };
}

export function markStage(stages, key, patch) {
  return stages.map((stage) => (stage.key === key ? { ...stage, ...patch } : stage));
}

// Queue the next step of a running scan. One job per stage, so each gets its own invocation
// budget instead of sharing one.
export async function queueFullScanStage(installationKey, stageKey, jobToken) {
  // Wrapped in `body`, like every other push in this codebase. The consumer reads
  // event?.body?.jobType, so a bare payload arrives bodyless and Forge rejects the
  // invocation with "Event body must be an object".
  //
  // This has always been wrong here and never surfaced, because nothing calls this function:
  // the full-scan orchestrator is queued by no resolver and consumed by no handler. Fixed
  // while it is in front of us rather than left as a trap for whoever wires it up.
  await inventorySnapshotQueue.push({
    body: {
      jobType: "run-full-scan",
      installationKey,
      stage: stageKey,
      jobToken,
    },
  });
  logger.info("full-scan.stage_queued", { installationKey, stage: stageKey });
}
