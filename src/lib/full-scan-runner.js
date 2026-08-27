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
  initialStages,
  nextStage,
  markStage,
  summarizeStages,
  handoffStageState,
  maxPollsFor,
} from "./full-scan.js";
import {
  ensureProjectStoreReady,
  readFullScanMeta,
  writeFullScanMeta,
  readFilterSnapshotMeta,
  readDashboardSnapshotMeta,
  readIssueScanMeta,
} from "./project-store.js";
import { isFilterBuildStale, queueFilterSnapshotBuild } from "./filter-engine.js";
import { isDashboardBuildStale, queueDashboardSnapshotBuild } from "./dashboard-engine.js";
import { buildWorkflowSnapshot, buildStatusHistorySnapshot } from "./workflow-engine.js";
import { buildScreenSnapshot } from "./screen-engine.js";
import { runSnapshot } from "./snapshot-engine.js";
import { runIssueScanCoordinator } from "./scan-engine.js";
import { captureSiteHealth } from "./site-health.js";

// The four structural stages, shared verbatim between full and quick scan.
//
// Filters, dashboards, screens and workflow schemes have no "changed since" signal anywhere
// in the Jira APIs this app calls -- filter/search and dashboard/search take no
// modified-since parameter, and the objects they return carry no last-edited timestamp at
// all. There is no cheaper version of these four to run on a schedule, so quick scan runs
// them exactly like full scan does: in full, every time.
const workflows = { run: (key) => buildWorkflowSnapshot(key) };
const screens = { run: (key) => buildScreenSnapshot(key) };
const statusHistory = { run: (key) => buildStatusHistorySnapshot(key) };
const health = { run: (key) => captureSiteHealth(key) };
const filters = {
  start: (key) => queueFilterSnapshotBuild(key),
  poll: async (key) => {
    const meta = await readFilterSnapshotMeta(key);
    return handoffStageState(meta, { stale: isFilterBuildStale(meta) });
  },
};
const dashboards = {
  start: (key) => queueDashboardSnapshotBuild(key),
  poll: async (key) => {
    const meta = await readDashboardSnapshotMeta(key);
    return handoffStageState(meta, { stale: isDashboardBuildStale(meta) });
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
  fields: { run: (key) => runSnapshot(key) },
  "status-history": statusHistory,
  issues: {
    start: (key) => runIssueScanCoordinator(key),
    poll: async (key) => {
      const meta = await readIssueScanMeta(key);
      // The issue crawl spells its running state "building" like the rest, but it also has a
      // "cancelled" that handoffStageState treats as failed -- a user who stopped the crawl
      // wanted it stopped, and carrying on to the next stage as if it had finished would
      // record a health score over data nobody agreed to collect.
      return handoffStageState(meta);
    },
  },
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
      return handoffStageState(meta);
    },
  },
  "status-history": statusHistory,
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
    const polls = Number(meta.polls || 0) + 1;
    const verdict = await runner.poll(installationKey, meta);

    if (verdict === "running") {
      if (polls > maxPollsFor(meta.currentStage)) {
        // The stage stopped reporting without ever writing a terminal state. Fail the stage,
        // not the scan: whatever it was building is a separate pillar, and the stages that do
        // not depend on it still have value.
        stages = markStage(stages, meta.currentStage, {
          state: "failed",
          completedAt: new Date(now).toISOString(),
          error: "Stage stopped reporting progress and was abandoned.",
        });
        logger.warn(`${spec.scanType}-scan.stage_abandoned`, { installationKey, stage: meta.currentStage, polls });
        return advance(spec, installationKey, stages, meta.jobToken, now);
      }

      await writeFullScanMeta(installationKey, { polls, updatedAt: new Date(now).toISOString() });
      await queueScanStep(spec, installationKey, meta.currentStage, meta.jobToken, FULL_SCAN_POLL_DELAY_SECONDS);
      return { waiting: true, stage: meta.currentStage, polls };
    }

    stages = markStage(stages, meta.currentStage, {
      state: verdict,
      completedAt: new Date(now).toISOString(),
      error: verdict === "failed" ? "The stage reported a failure. See that tab for details." : null,
    });
    logger.info(`${spec.scanType}-scan.stage_finished`, { installationKey, stage: meta.currentStage, verdict });
    return advance(spec, installationKey, stages, meta.jobToken, now);
  }

  // ── Starting the next stage ─────────────────────────────────────────────────
  const definition = nextStage(stages, spec.stageDefs);
  if (!definition) return finish(spec, installationKey, stages, now);

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

  stages = markStage(stages, definition.key, { state: "running", startedAt: new Date(now).toISOString() });
  await writeFullScanMeta(installationKey, {
    stages,
    currentStage: definition.mode === "handoff" ? definition.key : null,
    polls: 0,
    updatedAt: new Date(now).toISOString(),
  });

  try {
    if (definition.mode === "handoff") {
      await runner.start(installationKey, meta);
      await queueScanStep(spec, installationKey, definition.key, meta.jobToken, FULL_SCAN_POLL_DELAY_SECONDS);
      logger.info(`${spec.scanType}-scan.stage_handed_off`, { installationKey, stage: definition.key });
      return { handedOff: true, stage: definition.key };
    }

    await runner.run(installationKey);
    stages = markStage(stages, definition.key, { state: "done", completedAt: new Date(now).toISOString() });
    logger.info(`${spec.scanType}-scan.stage_done`, { installationKey, stage: definition.key });
  } catch (error) {
    // One stage failing does not fail the scan. Most stages are independent, and an admin
    // whose screen inventory 401s still wants the workflow and field data the same run would
    // have produced.
    const message_ = String(error?.message || error);
    stages = markStage(stages, definition.key, {
      state: "failed",
      completedAt: new Date(now).toISOString(),
      error: message_.slice(0, 300),
    });
    logger.error(`${spec.scanType}-scan.stage_failed`, { installationKey, stage: definition.key, error: message_ });
  }

  return advance(spec, installationKey, stages, meta.jobToken, now);
}

// Persist progress and take the next step, or finish.
async function advance(spec, installationKey, stages, jobToken, now) {
  const summary = summarizeStages(stages);
  if (summary.complete) return finish(spec, installationKey, stages, now);

  await writeFullScanMeta(installationKey, {
    stages,
    currentStage: null,
    polls: 0,
    updatedAt: new Date(now).toISOString(),
  });
  await queueScanStep(spec, installationKey, null, jobToken);
  return { advanced: true, done: summary.done, total: summary.total };
}

async function finish(spec, installationKey, stages, now) {
  const summary = summarizeStages(stages);
  const completedAt = new Date(now).toISOString();

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
    lastError: summary.failed || summary.skipped
      ? `${summary.failed} failed, ${summary.skipped} skipped of ${summary.total} stages.`
      : null,
  });

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

// Stage metadata for the UI, so the tab does not have to duplicate either list.
export function fullScanStageCatalog() {
  return FULL_SCAN_STAGES.map(({ key, label, needs, mode }) => ({ key, label, needs, mode }));
}

export function quickScanStageCatalog() {
  return QUICK_SCAN_STAGES.map(({ key, label, needs, mode }) => ({ key, label, needs, mode }));
}
