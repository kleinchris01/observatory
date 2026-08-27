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
  { key: "fields", label: "Field snapshot", needs: [], mode: "inline" },
  { key: "status-history", label: "Status history", needs: ["workflows"], mode: "inline" },
  {
    key: "issues",
    label: "Issue crawl",
    needs: ["fields"],
    // Handed off rather than run inline. The crawl is a multi-worker, multi-invocation
    // machine with its own resumption state; wrapping it in this one would be a second
    // implementation of something that already works.
    mode: "handoff",
  },
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
// large site with a long lookback window can still run for tens of minutes.
export const FULL_SCAN_MAX_POLLS = { issues: 480, "issues-delta": 240, default: 60 };

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

export function initialStages(stageDefinitions = FULL_SCAN_STAGES) {
  return stageDefinitions.map((stage) => ({
    key: stage.key,
    label: stage.label,
    state: "pending",
    startedAt: null,
    completedAt: null,
    error: null,
  }));
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
    if (!stage || stage.state !== "pending") continue;

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
