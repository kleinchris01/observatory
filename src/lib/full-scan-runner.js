// The wiring the full-scan orchestrator never had, plus its quick-scan sibling.
//
// full-scan.js has been in this repo, tested, since v069 -- stage order, dependency skipping,
// partial-failure semantics, a table to hold the state. Nothing called any of it. Every pillar
// kept its own build button on its own tab, and "scan the site" meant knowing which six
// buttons to press and in what order. This module is the part that was missing: it maps each
// stage to the engine that does the work, and steps the state machine.
//
// Deliberately the only place that knows both halves. full-scan.js stays pure so its ordering
// rules can be tested without a Jira or a database, and the engines stay unaware they are part
// of a larger scan.
//
// Full scan and quick scan share ONE engine below, parameterized by a "spec" -- which stage
// list, which runner for each stage, which queue job type. They also share one meta row per
// installation and one mutual-exclusion check, deliberately: both would otherwise try to run
// queueFilterSnapshotBuild (and every other handoff stage) against the SAME underlying
// inventory at the same time. A full scan and a quick scan racing each other is not two scans
// running faster, it is two builds corrupting each other's checkpoints.

import { logger } from "./logger.js";
import { makeJobToken } from "./jira-api.js";
import { inventorySnapshotQueue } from "./queues.js";
import {
  FULL_SCAN_STAGES,
  QUICK_SCAN_STAGES,
  FULL_SCAN_POLL_DELAY_SECONDS,
  FULL_SCAN_STALL_MS,
  MAX_SCAN_RECOVERIES,
  MAX_SCAN_TOTAL_MS,
  MAX_SCAN_SWEEPS,
  scanRetryDelaySeconds,
  initialStages,
  nextStage,
  markStage,
  summarizeStages,
  handoffStageState,
  retryStageOrFail,
  maxPollsFor,
} from "./full-scan.js";
import {
  ensureProjectStoreReady,
  readFullScanMeta,
  writeFullScanMeta,
  readFilterSnapshotMeta,
  readDashboardSnapshotMeta,
  readIssueScanMeta,
  writeIssueScanMeta,
  readWorkflowSnapshotMeta,
  readScreenSnapshotMeta,
  readIssueTypeSnapshotMeta,
  readAccessSnapshotMeta,
  readEstateSnapshotMeta,
  readFieldConfigSnapshotMeta,
  readBoardSnapshotMeta,
  readUserSnapshotMeta,
  readAssetSnapshotMeta,
  readJsmSnapshotMeta,
  readDriftSnapshotMeta,
  readSnapshotMeta,
  recordFullScanRun,
} from "./project-store.js";
import { isFilterBuildStale, queueFilterSnapshotBuild } from "./filter-engine.js";
import { isDashboardBuildStale, queueDashboardSnapshotBuild } from "./dashboard-engine.js";
import { buildWorkflowSnapshot, buildStatusHistorySnapshot } from "./workflow-engine.js";
import { buildScreenSnapshot } from "./screen-engine.js";
import { buildIssueTypeSnapshot } from "./issuetype-engine.js";
import { buildAccessSnapshot } from "./access-engine.js";
import { buildEstateSnapshot } from "./estate-engine.js";
import { buildFieldConfigSnapshot } from "./fieldconfig-engine.js";
import { buildBoardSnapshot } from "./board-engine.js";
import { buildUserSnapshot } from "./user-engine.js";
import { buildAssetSnapshot } from "./asset-engine.js";
import { buildJsmSnapshot } from "./jsm-engine.js";
import { buildDriftSnapshot } from "./drift-engine.js";
import { queueSnapshotBuild, isSnapshotBuildStale, requeueStaleSnapshotBuild } from "./snapshot-engine.js";
import { runIssueScanCoordinator, reviveStalledIssueScanWorkers } from "./scan-engine.js";

// The four structural stages, shared verbatim between full and quick scan.
//
// Filters, dashboards, screens and workflow schemes have no "changed since" signal anywhere
// in the Jira APIs this app calls -- filter/search and dashboard/search take no
// modified-since parameter, and the objects they return carry no last-edited timestamp at
// all. There is no cheaper version of these four to run on a schedule, so quick scan runs
// them exactly like full scan does: in full, every time.
const workflows = { run: (key) => buildWorkflowSnapshot(key) };
const screens = { run: (key) => buildScreenSnapshot(key) };
const issueTypes = { run: (key) => buildIssueTypeSnapshot(key) };
const access = { run: (key) => buildAccessSnapshot(key) };
const estate = { run: (key) => buildEstateSnapshot(key) };
const fieldConfigs = { run: (key) => buildFieldConfigSnapshot(key) };
const boards = { run: (key) => buildBoardSnapshot(key) };
const people = { run: (key) => buildUserSnapshot(key) };
// Returns { unavailable: true, reason } off JSM Premium rather than throwing, so this stage
// completes on a site without Assets and the pillar reports not-applicable. Nothing to
// special-case here -- the engine already made "not enabled" a terminal success.
const assets = { run: (key) => buildAssetSnapshot(key) };
// Same terminal-success contract as Assets: a site with no service desk completes the stage.
const jsm = { run: (key) => buildJsmSnapshot(key) };
const drift = { run: (key) => buildDriftSnapshot(key) };
const statusHistory = { run: (key) => buildStatusHistorySnapshot(key) };

// captureSiteHealth is dependency-injected so site-health.js stays testable without the Forge
// modules -- it takes a `deps` object it destructures with no default, and was being called
// here with one argument, so EVERY scan's health stage crashed with "Cannot destructure
// property 'readSnapshotMeta' of 'deps'". resolvers.js has every dep in scope; it is reached
// by dynamic import to dodge the cycle (resolvers.js imports startQuickScan from this file),
// exactly as issues-delta reaches runDeltaIssueScanJob.
const health = {
  run: async (key) => {
    const { captureSiteHealthForScan } = await import("../resolvers.js");
    await captureSiteHealthForScan(key);
  },
};

// A cheap signature of a handoff sub-build's progress. When it changes between polls the
// build is alive and working, however slowly, so the orchestrator resets its patience
// counter rather than counting down to "abandoned".
const buildSig = (meta) => (meta ? `${meta.state ?? ""}|${meta.processed ?? ""}|${meta.updatedAt ?? ""}` : null);

const filters = {
  start: (key) => queueFilterSnapshotBuild(key),
  poll: async (key) => {
    const meta = await readFilterSnapshotMeta(key);
    return {
      state: handoffStageState(meta, { stale: isFilterBuildStale(meta) }),
      sig: buildSig(meta),
      lastError: meta?.lastError ?? null,
    };
  },
};
const dashboards = {
  start: (key) => queueDashboardSnapshotBuild(key),
  poll: async (key) => {
    const meta = await readDashboardSnapshotMeta(key);
    return {
      state: handoffStageState(meta, { stale: isDashboardBuildStale(meta) }),
      sig: buildSig(meta),
      lastError: meta?.lastError ?? null,
    };
  },
};

// The field snapshot. Unlike filters and dashboards it is NOT failed-and-restarted when it
// goes stale -- runSnapshot checkpoints every field to the DB, so a killed chunk is resumed
// from where it stopped, not from zero. The poll re-queues a stale chunk itself and keeps
// reporting "running"; the orchestrator's own frozen-signature guard (no change in
// processedFields across maxPolls) is the backstop if a resume never makes progress.
const fields = {
  start: (key) => queueSnapshotBuild(key),
  poll: async (key) => {
    let meta = await readSnapshotMeta(key);
    if (isSnapshotBuildStale(meta)) {
      meta = await requeueStaleSnapshotBuild(key, meta);
    }
    return {
      state: handoffStageState(meta),
      sig: meta ? `${meta.state ?? ""}|${meta.processedFields ?? ""}|${meta.buildingVersion ?? ""}` : null,
      lastError: meta?.lastError ?? null,
    };
  },
};

// What each FULL-scan stage actually does.
//
// `run` for an inline stage: do the work, return, stage is done. `start` + `poll` for a
// handoff stage: kick off a machine that has its own invocations and state, then ask it
// whether it has finished.
//
// Automation is absent on purpose, not by oversight. Jira publishes no API to enumerate
// automation rules -- that pillar is fed by importing a rule export by hand -- so a scan that
// silently included it would be claiming coverage it does not have.
export const STAGE_RUNNERS = {
  workflows,
  screens,
  filters,
  dashboards,
  fields,
  "status-history": statusHistory,
  "issue-types": issueTypes,
  "field-configs": fieldConfigs,
  access,
  estate,
  issues: {
    // Move the crawl's own meta into "queued" BEFORE handing off. runIssueScanCoordinator
    // refuses to run from any other state -- so without this it reads the previous run's
    // "ready" row, logs "not in queued state, skipping", and the very next poll reads that
    // same stale "ready" and marks the stage done one poll interval later: a whole-site
    // crawl "finishing" in ~31 seconds over data nobody re-collected. The coordinator does
    // its own full counter/worker reset once it is in "queued", so nothing else is cleared
    // here. Mirrors the standalone startIssueScan resolver, minus the queue push -- the
    // orchestrator polls the meta itself rather than routing through the run-issue-scan job.
    start: async (key) => {
      await writeIssueScanMeta(key, {
        state: "queued",
        jobToken: makeJobToken(),
        lastError: null,
        progressLog: [{ t: new Date().toISOString(), msg: "Issue crawl queued by full scan" }],
      });
      await runIssueScanCoordinator(key);
    },
    poll: async (key) => {
      // Re-kick any worker that paused on a Forge queue limit. This poll runs on the
      // orchestrator's chain, not the crawl's, so its re-queue starts fresh and lands even
      // when the crawl's own chain is against the ceiling. A paused worker holds its slot
      // open, so finalisation waits for it -- this is what turns a transient limit into a
      // pause-and-resume instead of a dropped ~30k issues marked clean.
      await reviveStalledIssueScanWorkers(key).catch(() => ({ revived: 0 }));
      const meta = await readIssueScanMeta(key);
      // The issue crawl spells its running state "building" like the rest, but it also has a
      // "cancelled" that handoffStageState treats as failed -- a user who stopped the crawl
      // wanted it stopped, and carrying on to the next stage as if it had finished would
      // record a health score over data nobody agreed to collect.
      return { state: handoffStageState(meta), sig: buildSig(meta), lastError: meta?.lastError ?? null };
    },
  },
  boards,
  people,
  assets,
  jsm,
  drift,
  health,
};

// What each QUICK-scan stage does. Four are the identical full-refetch objects above; the
// fifth -- issues-delta -- is the one place quick scan actually differs.
//
// runDeltaIssueScanJob lives in resolvers.js, and resolvers.js already imports
// startQuickScan/runQuickScanStep from THIS file, so a static import back the other way would
// be a module cycle -- resolvers.js would still be mid-initialization the first time this
// file's top level ran. Reached with a dynamic import instead, resolved lazily inside the
// closures below rather than at module load, which is the same escape hatch scan-engine.js
// already uses to reach project-store.js for the identical reason.
//
// windowHours is not a closure variable -- it cannot be, because orchestration is queue-driven
// across many separate invocations. It is read back from the meta row each time this stage's
// start() runs, having been written there once when the scan began.
export const QUICK_SCAN_RUNNERS = {
  workflows,
  screens,
  filters,
  dashboards,
  "issues-delta": {
    start: async (key, meta) => {
      const { runDeltaIssueScanJob } = await import("../resolvers.js");
      await runDeltaIssueScanJob(key, Number(meta?.quickScanWindowHours) || undefined);
    },
    poll: async (key) => {
      const { DELTA_SCOPE_SUFFIX } = await import("../resolvers.js");
      const meta = await readIssueScanMeta(`${key}${DELTA_SCOPE_SUFFIX}`);
      return { state: handoffStageState(meta), sig: buildSig(meta), lastError: meta?.lastError ?? null };
    },
  },
  "status-history": statusHistory,
  "issue-types": issueTypes,
  "field-configs": fieldConfigs,
  access,
  estate,
  boards,
  people,
  assets,
  jsm,
  drift,
  health,
};

// One spec per scan type. Everything below this line is generic over `spec` and knows
// nothing about which pillars exist -- that knowledge lives entirely in these two objects and
// in full-scan.js's two stage lists.
const FULL_SCAN_SPEC = {
  scanType: "full",
  jobType: "run-full-scan",
  stageDefs: FULL_SCAN_STAGES,
  runners: STAGE_RUNNERS,
};

const QUICK_SCAN_SPEC = {
  scanType: "quick",
  jobType: "run-quick-scan",
  stageDefs: QUICK_SCAN_STAGES,
  runners: QUICK_SCAN_RUNNERS,
};

// Queue the orchestrator's next step. `delaySeconds` is what makes waiting on a handoff stage
// cheap: without it the orchestrator would spin an invocation every few hundred milliseconds
// asking a thirty-minute crawl whether it was done yet.
async function queueScanStep(spec, installationKey, stageKey, jobToken, delaySeconds = 0) {
  await inventorySnapshotQueue.push({
    body: { jobType: spec.jobType, installationKey, stage: stageKey, jobToken },
    ...(delaySeconds > 0 ? { delayInSeconds: delaySeconds } : {}),
  });
}

/**
 * Begin a scan, or decline to. Shared by full and quick scan: both write the same meta row,
 * and both refuse to start over EITHER type already running, because they would otherwise
 * race each other over the same handoff-stage builds.
 */
async function startScan(spec, installationKey, { now = Date.now(), quickScanWindowHours } = {}) {
  await ensureProjectStoreReady();
  const existing = await readFullScanMeta(installationKey);

  if (existing?.state === "running") {
    return { started: false, reason: "already-running", meta: existing };
  }

  const jobToken = makeJobToken();
  const stages = initialStages(spec.stageDefs);
  const startedAt = new Date(now).toISOString();

  await writeFullScanMeta(installationKey, {
    state: "running",
    scanType: spec.scanType,
    jobToken,
    currentStage: null,
    stages,
    startedAt,
    completedAt: null,
    updatedAt: startedAt,
    lastError: null,
    polls: 0,
    recoveryCount: 0,
    sweep: 0,
    stageProgressSig: null,
    // Cleared on every start, not just quick-scan starts, so a full scan run after a quick
    // scan never accidentally inherits a stale window from the previous run's meta row.
    quickScanWindowHours: spec.scanType === "quick" ? Number(quickScanWindowHours) || null : null,
  });

  await queueScanStep(spec, installationKey, null, jobToken);
  logger.info(`${spec.scanType}-scan.started`, { installationKey, jobToken, stages: stages.length });
  return { started: true, jobToken };
}

/**
 * One step of a running scan. This is what the queue consumer calls, for whichever jobType
 * it was invoked with.
 *
 * A step either advances to the next pending stage, or waits on the handoff stage already in
 * flight. Every path ends by either queueing the next step or writing a terminal state, so the
 * scan cannot stall silently -- the failure mode this whole design exists to avoid.
 */
async function runScanStep(spec, installationKey, message = {}, { now = Date.now() } = {}) {
  await ensureProjectStoreReady();
  const meta = await readFullScanMeta(installationKey);

  if (meta?.state !== "running") {
    logger.info(`${spec.scanType}-scan.step_ignored_not_running`, { installationKey, state: meta?.state ?? null });
    return { ignored: true, reason: "not-running" };
  }

  // A step meant for the OTHER scan type. Cannot happen through normal operation -- the two
  // never run concurrently -- but a message queued just before a cancel-and-restart under the
  // other type could still arrive after the switch, and acting on it would step a stage list
  // that no longer matches what is stored.
  if (meta.scanType && meta.scanType !== spec.scanType) {
    logger.warn(`${spec.scanType}-scan.step_ignored_wrong_type`, { installationKey, actual: meta.scanType });
    return { ignored: true, reason: "wrong-scan-type" };
  }

  // A step from a superseded run. Same reasoning as the build token on a resumable build: a
  // cancelled or restarted scan can leave a message in flight, and acting on it would advance
  // a stage list that no longer exists.
  if (message.jobToken && meta.jobToken && message.jobToken !== meta.jobToken) {
    logger.warn(`${spec.scanType}-scan.step_ignored_stale_token`, { installationKey });
    return { ignored: true, reason: "stale-token" };
  }

  let stages = meta.stages || initialStages(spec.stageDefs);

  // ── Waiting on a handoff stage already in flight ────────────────────────────
  if (meta.currentStage) {
    const runner = spec.runners[meta.currentStage];
    const polled = await runner.poll(installationKey, meta);
    const verdict = typeof polled === "string" ? polled : polled.state;
    const sig = typeof polled === "object" && polled ? (polled.sig ?? null) : null;
    const subError = typeof polled === "object" && polled ? (polled.lastError ?? null) : null;

    if (verdict === "running") {
      // The sub-build's own progress signature moved since the last poll -- it is alive and
      // working, however slowly, so patience resets. Only a build that is genuinely FROZEN
      // counts down to a retry.
      const progressed = sig != null && sig !== (meta.stageProgressSig ?? null);
      const polls = progressed ? 1 : Number(meta.polls || 0) + 1;

      if (!progressed && polls > maxPollsFor(meta.currentStage)) {
        const {
          stages: next,
          retried,
          attempts,
        } = retryStageOrFail(stages, meta.currentStage, subError || "the stage stopped reporting progress", { now });
        logger.warn(`${spec.scanType}-scan.stage_${retried ? "retry_frozen" : "abandoned"}`, {
          installationKey,
          stage: meta.currentStage,
          polls,
        });
        return advance(spec, installationKey, next, meta.jobToken, now, {
          delaySeconds: retried ? scanRetryDelaySeconds(attempts) : 0,
        });
      }

      await writeFullScanMeta(installationKey, {
        polls,
        stageProgressSig: sig ?? meta.stageProgressSig ?? null,
        updatedAt: new Date(now).toISOString(),
      });
      await queueScanStep(spec, installationKey, meta.currentStage, meta.jobToken, FULL_SCAN_POLL_DELAY_SECONDS);
      return { waiting: true, stage: meta.currentStage, polls };
    }

    if (verdict === "failed") {
      // The pillar's own build reported failure. Retry the stage rather than marking it
      // failed on the first bad run -- a scan should exhaust its retries before it tells
      // anyone a pillar did not build.
      const {
        stages: next,
        retried,
        attempts,
      } = retryStageOrFail(stages, meta.currentStage, subError || "the pillar build reported a failure", { now });
      logger.warn(`${spec.scanType}-scan.stage_${retried ? "retry_failed" : "failed"}`, {
        installationKey,
        stage: meta.currentStage,
      });
      return advance(spec, installationKey, next, meta.jobToken, now, {
        delaySeconds: retried ? scanRetryDelaySeconds(attempts) : 0,
      });
    }

    // A handoff pillar can finish "ready" while still carrying a caveat -- the issue crawl
    // reports ready even when a worker fell over and its projects kept last run's counts.
    // The stage is genuinely done (there is nothing left to wait on), but the caveat rides
    // along on `error` so the Scans tab shows it rather than a clean green tick over a
    // partial result.
    stages = markStage(stages, meta.currentStage, {
      state: "done",
      completedAt: new Date(now).toISOString(),
      error: subError || null,
    });
    logger.info(`${spec.scanType}-scan.stage_finished`, {
      installationKey,
      stage: meta.currentStage,
      verdict,
      caveat: subError || undefined,
    });
    return advance(spec, installationKey, stages, meta.jobToken, now);
  }

  // ── Starting the next stage ─────────────────────────────────────────────────
  const definition = nextStage(stages, spec.stageDefs);
  if (!definition) {
    // nextStage returns null mid-scan only when the earliest unfinished stage is already
    // running -- an inline stage whose invocation is still going, or one left running by a
    // killed invocation. Its own step advances the scan when it lands, so this step yields
    // rather than re-queueing (which would spin) or advancing (which would run a LATER
    // stage out of order). A stage that is genuinely dead gets reset by the stall watchdog.
    const summary = summarizeStages(stages);
    if (!summary.complete) {
      const inflight = stages.find((s) => s.state === "running");
      logger.info(`${spec.scanType}-scan.step_yielded`, { installationKey, stage: inflight?.key ?? null });
      return { yielded: true, stage: inflight?.key ?? null };
    }
    return advance(spec, installationKey, stages, meta.jobToken, now);
  }

  if (definition.blockedBy) {
    // A dependency failed. Skipped rather than run against stale inputs: a status history
    // built on a workflow snapshot that did not refresh is not a partial result, it is a
    // wrong one, and wrong is worse than missing here.
    stages = markStage(stages, definition.key, {
      state: "skipped",
      completedAt: new Date(now).toISOString(),
      error: `Skipped because ${definition.blockedBy} did not complete.`,
    });
    return advance(spec, installationKey, stages, meta.jobToken, now);
  }

  const runner = spec.runners[definition.key];
  if (!runner) {
    stages = markStage(stages, definition.key, {
      state: "failed",
      completedAt: new Date(now).toISOString(),
      error: "No runner is registered for this stage.",
    });
    return advance(spec, installationKey, stages, meta.jobToken, now);
  }

  const stageStartMs = Date.now();
  stages = markStage(stages, definition.key, { state: "running", startedAt: new Date(now).toISOString() });
  await writeFullScanMeta(installationKey, {
    stages,
    currentStage: definition.mode === "handoff" ? definition.key : null,
    polls: 0,
    // A stage just started -- the run is making progress, so any recovery credit spent on
    // an earlier stall is cleared. The watchdog's budget only counts consecutive stalls.
    recoveryCount: 0,
    // Fresh stage: forget the previous handoff sub-build's progress signature so this one's
    // first real progress reads as movement, not as a match against a stale value.
    stageProgressSig: null,
    updatedAt: new Date(now).toISOString(),
  });

  let retryDelaySeconds = 0;
  try {
    if (definition.mode === "handoff") {
      await runner.start(installationKey, meta);
      await queueScanStep(spec, installationKey, definition.key, meta.jobToken, FULL_SCAN_POLL_DELAY_SECONDS);
      logger.info(`${spec.scanType}-scan.stage_handed_off`, {
        installationKey,
        stage: definition.key,
        attempts: definition.attempts ?? 0,
      });
      return { handedOff: true, stage: definition.key };
    }

    await runner.run(installationKey);
    // Anchored on `now` (so a test's injected clock still controls the timestamp) but
    // carrying the REAL elapsed of the inline run. Without this, startedAt and completedAt
    // are both `new Date(now)` -- one frozen clock per invocation -- so every inline stage
    // recorded a 0s duration while only the polled handoff stages got real ones.
    const completedAt = new Date(now + Math.max(0, Date.now() - stageStartMs)).toISOString();
    stages = markStage(stages, definition.key, { state: "done", completedAt, error: null });
    logger.info(`${spec.scanType}-scan.stage_done`, { installationKey, stage: definition.key });
  } catch (error) {
    // A stage that threw is retried rather than failed on the first bad run. Most stages are
    // independent, and the scan should exhaust its retries before it tells anyone a pillar
    // did not build -- see retryStageOrFail and the sweep in advance().
    const message_ = String(error?.message || error);
    const { stages: next, retried, attempts } = retryStageOrFail(stages, definition.key, message_, { now });
    stages = next;
    retryDelaySeconds = retried ? scanRetryDelaySeconds(attempts) : 0;
    logger[retried ? "warn" : "error"](`${spec.scanType}-scan.stage_${retried ? "retry_threw" : "failed"}`, {
      installationKey,
      stage: definition.key,
      error: message_,
    });
  }

  return advance(spec, installationKey, stages, meta.jobToken, now, { delaySeconds: retryDelaySeconds });
}

// Persist progress and take the next step, or -- once every stage has resolved -- sweep the
// failures/skips back to pending for another whole pass before finally finishing.
//
// `delaySeconds` backs off the next step: 0 for a normal advance (a stage just finished),
// but scanRetryDelaySeconds(attempt) when this advance follows a retry, so a stage failing
// on a transient error is not re-run instantly.
async function advance(spec, installationKey, stages, jobToken, now, { delaySeconds = 0 } = {}) {
  const summary = summarizeStages(stages);

  if (!summary.complete) {
    await writeFullScanMeta(installationKey, {
      stages,
      currentStage: null,
      polls: 0,
      // A stage just resolved -- forward progress -- so the watchdog's consecutive-stall
      // budget resets. See recoverStalledScan.
      recoveryCount: 0,
      stageProgressSig: null,
      updatedAt: new Date(now).toISOString(),
    });
    await queueScanStep(spec, installationKey, null, jobToken, delaySeconds);
    return { advanced: true, done: summary.done, total: summary.total };
  }

  // Every stage is in a terminal state. If any failed or was skipped, reset the whole set of
  // them and sweep again -- a scan should try every reasonable time before it reports that a
  // pillar did not build. Bounded by MAX_SCAN_SWEEPS so this can never loop forever.
  if (summary.failed > 0 || summary.skipped > 0) {
    const meta = await readFullScanMeta(installationKey);
    const sweep = Number(meta?.sweep || 0);
    if (sweep < MAX_SCAN_SWEEPS) {
      const reset = stages.map((stage) =>
        stage.state === "failed" || stage.state === "skipped"
          ? { ...stage, state: "pending", startedAt: null, completedAt: null, attempts: 0, error: null }
          : stage,
      );
      await writeFullScanMeta(installationKey, {
        stages: reset,
        currentStage: null,
        polls: 0,
        recoveryCount: 0,
        stageProgressSig: null,
        sweep: sweep + 1,
        updatedAt: new Date(now).toISOString(),
      });
      await queueScanStep(spec, installationKey, null, jobToken);
      logger.warn(`${spec.scanType}-scan.retry_sweep`, {
        installationKey,
        sweep: sweep + 1,
        failed: summary.failed,
        skipped: summary.skipped,
      });
      return { sweeping: true, sweep: sweep + 1, failed: summary.failed, skipped: summary.skipped };
    }
  }

  return finish(spec, installationKey, stages, now);
}

// What each stage produced, read back from the pillar it drives.
//
// Best-effort and defensive: this feeds the scan page's "4,115 filters, +38 vs last run"
// line, and a meta read that throws must not be allowed to turn a finished scan into a
// failed one. Every source is wrapped, every miss is just an absent key. Exported so the
// status resolver can show the same counts live, before the run has finished and been
// recorded.
export async function readStageProducedCounts(installationKey, scanType) {
  const out = {};
  const put = async (key, read, pick) => {
    try {
      const meta = await read(installationKey);
      const value = meta ? pick(meta) : null;
      if (value != null && Number.isFinite(Number(value))) out[key] = Number(value);
    } catch {
      /* absent key, not a failure */
    }
  };

  await Promise.all([
    put("workflows", readWorkflowSnapshotMeta, (m) => m.totalSchemes),
    put("screens", readScreenSnapshotMeta, (m) => m.totalScreens),
    put("issue-types", readIssueTypeSnapshotMeta, (m) => m.totalTypes),
    put(
      "access",
      readAccessSnapshotMeta,
      (m) =>
        m.totalPermissionSchemes + m.totalSecuritySchemes + m.totalNotificationSchemes + (m.totalProjectRoles || 0),
    ),
    put("estate", readEstateSnapshotMeta, (m) => m.totalResolutions + m.totalPriorities),
    // Schemes plus legacy configurations: the owners whose fields were walked.
    put("field-configs", readFieldConfigSnapshotMeta, (m) => m.totalSchemes + m.totalConfigs),
    put("boards", readBoardSnapshotMeta, (m) => m.totalBoards),
    put("people", readUserSnapshotMeta, (m) => m.totalUsers),
    // Object types rather than schemas: a site with three schemas and 400 types has done far
    // more work than the schema count suggests, and zero here on an Assets-less site is a
    // true count, not a failure -- the stage's own state carries that distinction.
    put("assets", readAssetSnapshotMeta, (m) => m.totalObjectTypes),
    put("jsm", readJsmSnapshotMeta, (m) => m.totalRequestTypes + m.totalQueues),
    put("drift", readDriftSnapshotMeta, (m) => m.lastRunChanges),
    put("filters", readFilterSnapshotMeta, (m) => m.totalFilters),
    put("dashboards", readDashboardSnapshotMeta, (m) => m.totalDashboards),
    put("fields", readSnapshotMeta, (m) => m.totalFields),
    put("issues", readIssueScanMeta, (m) => m.processedIssues || m.totalIssues),
  ]);

  if (scanType === "quick") {
    try {
      const { DELTA_SCOPE_SUFFIX } = await import("../resolvers.js");
      const delta = await readIssueScanMeta(`${installationKey}${DELTA_SCOPE_SUFFIX}`);
      if (delta?.processedIssues != null) out["issues-delta"] = Number(delta.processedIssues);
    } catch {
      /* absent key */
    }
  }

  return out;
}

// Fold the run's stage list and its produced-counts into the shape full_scan_runs stores:
// one entry per stage with its own timing, retry count and headline number.
function buildStageRecords(stages, summary) {
  return (stages || []).map((stage) => {
    const startMs = Date.parse(stage.startedAt || "");
    const endMs = Date.parse(stage.completedAt || "");
    const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : null;
    return {
      key: stage.key,
      state: stage.state,
      startedAt: stage.startedAt || null,
      completedAt: stage.completedAt || null,
      durationMs,
      attempts: Number(stage.attempts) || 0,
      error: stage.error || null,
      count: Object.prototype.hasOwnProperty.call(summary, stage.key) ? summary[stage.key] : null,
    };
  });
}

async function finish(spec, installationKey, stages, now) {
  const summary = summarizeStages(stages);
  const completedAt = new Date(now).toISOString();

  // Read the meta BEFORE the terminal write clears jobToken -- the run id and the sweep count
  // both live on it and the history row needs them.
  const priorMeta = await readFullScanMeta(installationKey).catch(() => null);

  await writeFullScanMeta(installationKey, {
    // "completed-with-failures" rather than plain success whenever anything failed or was
    // skipped. A green tick over a stage that did not run is exactly the kind of thing people
    // act on, and this app exists to stop that.
    state: summary.state,
    stages,
    currentStage: null,
    jobToken: null,
    completedAt,
    updatedAt: completedAt,
    lastError:
      summary.failed || summary.skipped
        ? `${summary.failed} failed, ${summary.skipped} skipped of ${summary.total} stages.`
        : null,
  });

  // Record the run for run-over-run comparison. After the terminal write, and swallowing its
  // own errors: the scan is already finished and marked: a failed history insert is a missing
  // chart point, not a failed scan.
  try {
    const runSummary = await readStageProducedCounts(installationKey, spec.scanType);
    const startedAt = priorMeta?.startedAt || null;
    const startMs = Date.parse(startedAt || "");
    await recordFullScanRun(installationKey, {
      runId: priorMeta?.jobToken || `${spec.scanType}-${completedAt}`,
      scanType: spec.scanType,
      state: summary.state,
      startedAt,
      completedAt,
      durationMs: Number.isFinite(startMs) ? Date.parse(completedAt) - startMs : 0,
      failedCount: summary.failed,
      skippedCount: summary.skipped,
      totalStages: summary.total,
      sweep: Number(priorMeta?.sweep) || 0,
      stages: buildStageRecords(stages, runSummary),
      summary: runSummary,
    });
  } catch (error) {
    logger.warn(`${spec.scanType}-scan.run_history_write_failed`, {
      installationKey,
      error: String(error?.message || error),
    });
  }

  logger.info(`${spec.scanType}-scan.completed`, { installationKey, ...summary });
  return { completed: true, ...summary };
}

// ── Public surface: thin, named wrappers over the generic engine above ──────────────────────

export async function startFullScan(installationKey, opts = {}) {
  return startScan(FULL_SCAN_SPEC, installationKey, opts);
}

export async function runFullScanStep(installationKey, message = {}, opts = {}) {
  return runScanStep(FULL_SCAN_SPEC, installationKey, message, opts);
}

export async function startQuickScan(installationKey, opts = {}) {
  return startScan(QUICK_SCAN_SPEC, installationKey, opts);
}

export async function runQuickScanStep(installationKey, message = {}, opts = {}) {
  return runScanStep(QUICK_SCAN_SPEC, installationKey, message, opts);
}

/**
 * Restart a run whose orchestrator loop has stopped stepping.
 *
 * The step machine above cannot recover from a lost queue message, because the thing that
 * would notice -- runScanStep -- is exactly what stopped being called. This is invoked from
 * outside that loop, on the hourly trigger, and re-enters it from the last checkpoint.
 *
 * A run is "stalled" only when it says it is running AND its own meta row has not been
 * touched in FULL_SCAN_STALL_MS. A live loop writes updatedAt on every poll, so a
 * legitimately long issue crawl is never mistaken for a wedge. `force` skips the time check
 * for the operator-driven "Resume" button, which the UI only shows once it already believes
 * the run is stuck.
 *
 * After MAX_SCAN_RECOVERIES consecutive kicks with no forward progress, the run is failed
 * out -- any stage still marked "running" becomes "failed" and the scan finishes
 * completed-with-failures. Left "running", it would block every future scan from starting.
 */
export async function recoverStalledScan(installationKey, { now = Date.now(), force = false } = {}) {
  await ensureProjectStoreReady();
  const meta = await readFullScanMeta(installationKey);

  if (meta?.state !== "running") return { recovered: false, reason: "not-running" };

  const spec = meta.scanType === "quick" ? QUICK_SCAN_SPEC : FULL_SCAN_SPEC;
  let stages = meta.stages || initialStages(spec.stageDefs);

  // Absolute wall-clock ceiling, checked BEFORE the heartbeat. A scan whose loop keeps
  // ticking -- writing updatedAt every poll -- but never reaches finish() is a zombie:
  // stages retry, sweeps run, recoveries reset the counter, and it can stay "running" for
  // days (seen at 86 hours). Nothing else catches that, because every per-stage and
  // per-stall guard resets on the smallest sign of progress. Past the ceiling the run is
  // failed out regardless of how healthy its heartbeat looks.
  const startedMs = Date.parse(meta.startedAt || "") || 0;
  if (startedMs && now - startedMs > MAX_SCAN_TOTAL_MS) {
    const completedAt = new Date(now).toISOString();
    stages = stages.map((stage) => {
      if (stage.state === "running" || stage.state === "pending") {
        return {
          ...stage,
          state: stage.state === "running" ? "failed" : "skipped",
          completedAt,
          error: `Scan exceeded its ${Math.round(MAX_SCAN_TOTAL_MS / 3_600_000)}-hour limit and was stopped.`,
        };
      }
      return stage;
    });
    logger.error(`${spec.scanType}-scan.total_duration_exceeded`, {
      installationKey,
      hours: ((now - startedMs) / 3_600_000).toFixed(1),
    });
    return finish(spec, installationKey, stages, now);
  }

  const lastBeat = Date.parse(meta.updatedAt || meta.startedAt || "") || 0;
  if (!force && now - lastBeat <= FULL_SCAN_STALL_MS) {
    return { recovered: false, reason: "healthy" };
  }

  const recoveryCount = Number(meta.recoveryCount || 0);

  if (recoveryCount >= MAX_SCAN_RECOVERIES) {
    const completedAt = new Date(now).toISOString();
    stages = stages.map((stage) => {
      if (stage.state === "running") {
        return {
          ...stage,
          state: "failed",
          completedAt,
          error: "Stage stopped responding and was abandoned after repeated recovery attempts.",
        };
      }
      if (stage.state === "pending") {
        return { ...stage, state: "skipped", completedAt, error: "Scan abandoned before this stage ran." };
      }
      return stage;
    });
    logger.error(`${spec.scanType}-scan.recovery_exhausted`, { installationKey, recoveryCount });
    return finish(spec, installationKey, stages, now);
  }

  // An inline stage killed mid-invocation is left marked "running" with nothing driving it;
  // nextStage yields at it and the scan would sit forever. Reset it so this recovery step
  // re-runs it. A handoff stage in flight is tracked by currentStage and resumes through its
  // own poll rather than being re-run from scratch, so leave those.
  if (!meta.currentStage) {
    stages = stages.map((stage) =>
      stage.state === "running" ? { ...stage, state: "pending", startedAt: null } : stage,
    );
  }

  // Rotate the job token. "Stalled" is an inference from a quiet heartbeat, and Forge queue
  // delivery is at-least-once, not exactly-once -- the step we think is lost may just be
  // slow. Without a fresh token, that delayed step arrives after this recovery has re-queued
  // and both loops run, each calling nextStage against the same list: the out-of-order stage
  // execution this whole recovery path is supposed to fix. The new token makes runScanStep
  // reject the older message as stale.
  const freshToken = makeJobToken();

  await writeFullScanMeta(installationKey, {
    stages,
    jobToken: freshToken,
    recoveryCount: recoveryCount + 1,
    updatedAt: new Date(now).toISOString(),
  });
  await queueScanStep(spec, installationKey, meta.currentStage || null, freshToken);
  logger.warn(`${spec.scanType}-scan.recovered_stall`, {
    installationKey,
    stage: meta.currentStage || null,
    recoveryCount: recoveryCount + 1,
  });
  return { recovered: true, stage: meta.currentStage || null, recoveryCount: recoveryCount + 1 };
}

/**
 * Pick a finished-with-failures run back up, retrying only the stages that did not build.
 *
 * A persistent 4xx from one pillar used to end the whole scan at "completed-with-failures"
 * with no way forward but a full re-run -- redoing every pillar that succeeded. This resets
 * the failed and skipped stages to pending (attempts cleared), leaves the done ones alone,
 * and puts the run back to "running" with a fresh token and a fresh startedAt (so the
 * 8-hour ceiling measures the resumed leg, not the original). The orchestrator then walks
 * the remaining stages in order, exactly as it would a fresh scan.
 *
 * Not gated on read-only mode: finishing a scan that already ran is not a new scan.
 */
export async function resumeScanRun(installationKey, { now = Date.now() } = {}) {
  await ensureProjectStoreReady();
  const meta = await readFullScanMeta(installationKey);

  if (meta?.state !== "completed-with-failures") {
    return { resumed: false, reason: "nothing-to-resume", state: meta?.state ?? null };
  }

  const spec = meta.scanType === "quick" ? QUICK_SCAN_SPEC : FULL_SCAN_SPEC;
  const toRetry = (meta.stages || []).filter((s) => s.state === "failed" || s.state === "skipped");
  if (!toRetry.length) {
    return { resumed: false, reason: "nothing-to-resume", state: meta.state };
  }

  const stages = (meta.stages || []).map((stage) =>
    stage.state === "failed" || stage.state === "skipped"
      ? { ...stage, state: "pending", startedAt: null, completedAt: null, attempts: 0, error: null }
      : stage,
  );
  const freshToken = makeJobToken();
  const startedAt = new Date(now).toISOString();

  await writeFullScanMeta(installationKey, {
    state: "running",
    jobToken: freshToken,
    currentStage: null,
    stages,
    startedAt,
    completedAt: null,
    updatedAt: startedAt,
    lastError: null,
    polls: 0,
    recoveryCount: 0,
    sweep: 0,
    stageProgressSig: null,
  });
  await queueScanStep(spec, installationKey, null, freshToken);
  logger.info(`${spec.scanType}-scan.resumed`, { installationKey, retrying: toRetry.map((s) => s.key) });
  return { resumed: true, retrying: toRetry.map((s) => s.key) };
}

/**
 * Stop a running full or quick scan on request.
 *
 * Clears the job token so any step still in the queue is ignored as a stale message, marks
 * whatever was in flight as failed and anything not yet reached as skipped, and writes the
 * terminal "cancelled" state -- which is what lets startScan begin a fresh run afterwards.
 */
export async function cancelScan(installationKey, { now = Date.now() } = {}) {
  await ensureProjectStoreReady();
  const meta = await readFullScanMeta(installationKey);

  if (meta?.state !== "running") return { cancelled: false, reason: "not-running" };

  const completedAt = new Date(now).toISOString();
  const stages = (meta.stages || []).map((stage) => {
    if (stage.state === "running") {
      return { ...stage, state: "failed", completedAt, error: "Scan cancelled while this stage was running." };
    }
    if (stage.state === "pending") {
      return { ...stage, state: "skipped", completedAt, error: "Scan cancelled before this stage ran." };
    }
    return stage;
  });

  await writeFullScanMeta(installationKey, {
    state: "cancelled",
    stages,
    currentStage: null,
    jobToken: null,
    completedAt,
    updatedAt: completedAt,
    lastError: "Scan cancelled by an administrator.",
  });
  logger.warn(`${meta.scanType || "full"}-scan.cancelled`, { installationKey });
  return { cancelled: true, scanType: meta.scanType || "full" };
}

// Stage metadata for the UI, so the tab does not have to duplicate either list.
export function fullScanStageCatalog() {
  return FULL_SCAN_STAGES.map(({ key, label, needs, mode }) => ({ key, label, needs, mode }));
}

export function quickScanStageCatalog() {
  return QUICK_SCAN_STAGES.map(({ key, label, needs, mode }) => ({ key, label, needs, mode }));
}
