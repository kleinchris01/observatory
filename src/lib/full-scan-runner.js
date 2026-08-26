// The wiring the full-scan orchestrator never had.
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

import { logger, ignoreWith } from "./logger.js";
import { makeJobToken } from "./jira-api.js";
import { inventorySnapshotQueue } from "./queues.js";
import {
  FULL_SCAN_STAGES,
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

// What each stage actually does.
//
// `run` for an inline stage: do the work, return, stage is done. `start` + `poll` for a
// handoff stage: kick off a machine that has its own invocations and state, then ask it
// whether it has finished.
//
// Automation is absent on purpose, not by oversight. Jira publishes no API to enumerate
// automation rules -- that pillar is fed by importing a rule export by hand -- so a scan that
// silently included it would be claiming coverage it does not have.
export const STAGE_RUNNERS = {
  workflows: { run: (key) => buildWorkflowSnapshot(key) },
  screens: { run: (key) => buildScreenSnapshot(key) },
  fields: { run: (key) => runSnapshot(key) },
  "status-history": { run: (key) => buildStatusHistorySnapshot(key) },
  health: { run: (key) => captureSiteHealth(key) },

  filters: {
    start: (key) => queueFilterSnapshotBuild(key),
    poll: async (key) => {
      const meta = await readFilterSnapshotMeta(key);
      return handoffStageState(meta, { stale: isFilterBuildStale(meta) });
    },
  },
  dashboards: {
    start: (key) => queueDashboardSnapshotBuild(key),
    poll: async (key) => {
      const meta = await readDashboardSnapshotMeta(key);
      return handoffStageState(meta, { stale: isDashboardBuildStale(meta) });
    },
  },
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
};

// Queue the orchestrator's next step. `delaySeconds` is what makes waiting on a handoff stage
// cheap: without it the orchestrator would spin an invocation every few hundred milliseconds
// asking a thirty-minute crawl whether it was done yet.
export async function queueFullScanStep(installationKey, stageKey, jobToken, delaySeconds = 0) {
  await inventorySnapshotQueue.push({
    body: { jobType: "run-full-scan", installationKey, stage: stageKey, jobToken },
    ...(delaySeconds > 0 ? { delayInSeconds: delaySeconds } : {}),
  });
}

/**
 * Begin a full scan, or decline to.
 */
export async function startFullScan(installationKey, { now = Date.now() } = {}) {
  await ensureProjectStoreReady();
  const existing = await readFullScanMeta(installationKey);

  if (existing?.state === "running") {
    return { started: false, reason: "already-running", meta: existing };
  }

  const jobToken = makeJobToken();
  const stages = initialStages();
  const startedAt = new Date(now).toISOString();

  await writeFullScanMeta(installationKey, {
    state: "running",
    jobToken,
    currentStage: null,
    stages,
    startedAt,
    completedAt: null,
    updatedAt: startedAt,
    lastError: null,
    polls: 0,
  });

  await queueFullScanStep(installationKey, null, jobToken);
  logger.info("full-scan.started", { installationKey, jobToken, stages: stages.length });
  return { started: true, jobToken };
}

/**
 * One step of a running full scan. This is what the queue consumer calls.
 *
 * A step either advances to the next pending stage, or waits on the handoff stage already in
 * flight. Every path ends by either queueing the next step or writing a terminal state, so the
 * scan cannot stall silently -- the failure mode this whole design exists to avoid.
 */
export async function runFullScanStep(installationKey, message = {}, { now = Date.now() } = {}) {
  await ensureProjectStoreReady();
  const meta = await readFullScanMeta(installationKey);

  if (meta?.state !== "running") {
    logger.info("full-scan.step_ignored_not_running", { installationKey, state: meta?.state ?? null });
    return { ignored: true, reason: "not-running" };
  }

  // A step from a superseded run. Same reasoning as the build token on a resumable build: a
  // cancelled or restarted scan can leave a message in flight, and acting on it would advance
  // a stage list that no longer exists.
  if (message.jobToken && meta.jobToken && message.jobToken !== meta.jobToken) {
    logger.warn("full-scan.step_ignored_stale_token", { installationKey });
    return { ignored: true, reason: "stale-token" };
  }

  let stages = meta.stages || initialStages();

  // ── Waiting on a handoff stage already in flight ────────────────────────────
  if (meta.currentStage) {
    const runner = STAGE_RUNNERS[meta.currentStage];
    const polls = Number(meta.polls || 0) + 1;
    const verdict = await runner.poll(installationKey);

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
        logger.warn("full-scan.stage_abandoned", { installationKey, stage: meta.currentStage, polls });
        return advance(installationKey, stages, meta.jobToken, now);
      }

      await writeFullScanMeta(installationKey, { polls, updatedAt: new Date(now).toISOString() });
      await queueFullScanStep(installationKey, meta.currentStage, meta.jobToken, FULL_SCAN_POLL_DELAY_SECONDS);
      return { waiting: true, stage: meta.currentStage, polls };
    }

    stages = markStage(stages, meta.currentStage, {
      state: verdict,
      completedAt: new Date(now).toISOString(),
      error: verdict === "failed" ? "The stage reported a failure. See that tab for details." : null,
    });
    logger.info("full-scan.stage_finished", { installationKey, stage: meta.currentStage, verdict });
    return advance(installationKey, stages, meta.jobToken, now);
  }

  // ── Starting the next stage ─────────────────────────────────────────────────
  const definition = nextStage(stages);
  if (!definition) return finish(installationKey, stages, now);

  if (definition.blockedBy) {
    // A dependency failed. Skipped rather than run against stale inputs: a status history
    // built on a workflow snapshot that did not refresh is not a partial result, it is a
    // wrong one, and wrong is worse than missing here.
    stages = markStage(stages, definition.key, {
      state: "skipped",
      completedAt: new Date(now).toISOString(),
      error: `Skipped because ${definition.blockedBy} did not complete.`,
    });
    return advance(installationKey, stages, meta.jobToken, now);
  }

  const runner = STAGE_RUNNERS[definition.key];
  if (!runner) {
    stages = markStage(stages, definition.key, {
      state: "failed",
      completedAt: new Date(now).toISOString(),
      error: "No runner is registered for this stage.",
    });
    return advance(installationKey, stages, meta.jobToken, now);
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
      await runner.start(installationKey);
      await queueFullScanStep(installationKey, definition.key, meta.jobToken, FULL_SCAN_POLL_DELAY_SECONDS);
      logger.info("full-scan.stage_handed_off", { installationKey, stage: definition.key });
      return { handedOff: true, stage: definition.key };
    }

    await runner.run(installationKey);
    stages = markStage(stages, definition.key, { state: "done", completedAt: new Date(now).toISOString() });
    logger.info("full-scan.stage_done", { installationKey, stage: definition.key });
  } catch (error) {
    // One stage failing does not fail the scan. Four of the eight are independent, and an
    // admin whose screen inventory 401s still wants the workflow and field data the same run
    // would have produced.
    const message_ = String(error?.message || error);
    stages = markStage(stages, definition.key, {
      state: "failed",
      completedAt: new Date(now).toISOString(),
      error: message_.slice(0, 300),
    });
    logger.error("full-scan.stage_failed", { installationKey, stage: definition.key, error: message_ });
  }

  return advance(installationKey, stages, meta.jobToken, now);
}

// Persist progress and take the next step, or finish.
async function advance(installationKey, stages, jobToken, now) {
  const summary = summarizeStages(stages);
  if (summary.complete) return finish(installationKey, stages, now);

  await writeFullScanMeta(installationKey, {
    stages,
    currentStage: null,
    polls: 0,
    updatedAt: new Date(now).toISOString(),
  });
  await queueFullScanStep(installationKey, null, jobToken);
  return { advanced: true, done: summary.done, total: summary.total };
}

async function finish(installationKey, stages, now) {
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

  logger.info("full-scan.completed", { installationKey, ...summary });
  return { completed: true, ...summary };
}

// Stage metadata for the UI, so the tab does not have to duplicate the list.
export function fullScanStageCatalog() {
  return FULL_SCAN_STAGES.map(({ key, label, needs, mode }) => ({ key, label, needs, mode }));
}
