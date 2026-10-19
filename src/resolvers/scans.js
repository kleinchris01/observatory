// Scans: full and quick site scans, the issue crawl, the delta issue scan, and snapshot cancel/clear.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { route } from "@forge/api";
import { kvs } from "@forge/kvs";
import {
  incrMetric,
  METRIC_NAMES,
  makeJobToken,
  getInstallationKey,
  mapWithConcurrency,
  jiraRequest,
  ISSUE_SCAN_PAGE_SIZE,
  ISSUE_SCAN_WORKERS,
} from "../lib/jira-api.js";
import { queueIssueScanWorker, completeIssueScanFinalization } from "../lib/scan-engine.js";
import { hydrateFieldForGovernance } from "../lib/snapshot-engine.js";
import {
  ensureProjectStoreReady,
  readSnapshotMeta,
  writeSnapshotMeta,
  clearAllSnapshotData,
  loadSnapshotFields,
  listSnapshotProjects,
  readFilterSnapshotMeta,
  readDashboardSnapshotMeta,
  readIssueScanMeta,
  writeIssueScanMeta,
  readIssueScanWorker,
  updateIssueScanWorker,
  tryClaimIssueScanFinalization,
  upsertProjectTotalsForDelta,
  upsertDeltaFieldProjectUsage,
  upsertRqtFieldHits,
  upsertRqtIssueKeys,
  upsertRqtValueIssueKeys,
  upsertRqtFieldIssueKeys,
  readRecentFullScanRuns,
  recordHealthSnapshot,
  loadPriorHealthDimensions,
  readFullScanMeta,
} from "../lib/project-store.js";
import { attachUniqueIssueCounts, captureSiteHealth } from "../lib/site-health.js";
import {
  startFullScan,
  fullScanStageCatalog,
  startQuickScan,
  quickScanStageCatalog,
  recoverStalledScan,
  resumeScanRun,
  cancelScan,
  readStageProducedCounts,
} from "../lib/full-scan-runner.js";
import { FULL_SCAN_STALL_MS, MAX_SCAN_TOTAL_MS } from "../lib/full-scan.js";
import { readAutomationAnalysis } from "../lib/store/automation.js";
import {
  STRUCTURAL_SYSTEM_FIELDS,
  isFieldValueNonEmpty,
  collectIssueRqtValues,
  buildDuplicateNameCountMap,
} from "../lib/analysis.js";
import { buildFieldJql, getFieldNumericId } from "../lib/transform.js";
import { inventorySnapshotQueue } from "../lib/queues.js";
import { logger, fallbackOn, ignoreWith, errorContext } from "../lib/logger.js";
import { ADMIN_CONFIG_KEY, readAdminConfig } from "./admin-config.js";
import { computeAndStoreScreenCross } from "./screens.js";

export async function cancelSnapshot({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  // Hard-stop: null out buildingVersion so every running build's version-check fails,
  // regardless of how many are active or what state they think they're in.
  await writeSnapshotMeta(installationKey, {
    state: "cancelled",
    buildingVersion: null,
    lastError: null,
  });
  return { cancelled: true };
}

// The literal a caller must send to confirm a destructive clear. The admin bundle is
// built separately and cannot import from here, so ClearSnapshotControl in admin.jsx
// carries its own copy of this string -- if you change it, change it there too, or
// admins get told to type a word the server will reject.
export const CLEAR_SNAPSHOT_CONFIRMATION = "DELETE";

export async function clearSnapshot({ payload, context }) {
  await ensureProjectStoreReady();

  // Re-checked server-side even though the UI gates on it. The UI check is there to make
  // the action deliberate; this one is there because a resolver is reachable without the
  // UI, and "irreversibly delete everything" should not be a bare invoke() away.
  const confirmation = String(payload?.confirmation ?? "").trim();
  if (confirmation !== CLEAR_SNAPSHOT_CONFIRMATION) {
    return {
      cleared: false,
      error: `Confirmation text did not match. Type ${CLEAR_SNAPSHOT_CONFIRMATION} to confirm.`,
    };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { cleared: false, error: "Read-only mode is enabled. Disable it before clearing snapshot data." };
  }

  const installationKey = getInstallationKey(context);

  // Cancel before deleting, not after. A build running against the version we are about
  // to wipe would otherwise keep writing rows into the tables behind us, leaving the
  // installation in exactly the half-populated state this action is meant to escape.
  await writeSnapshotMeta(installationKey, {
    state: "cancelled",
    buildingVersion: null,
    lastError: null,
  });

  const result = await clearAllSnapshotData(installationKey);
  logger.info("clearSnapshot.done", {
    totalRowsDeleted: result.totalRowsDeleted,
    tableCount: Object.keys(result.deleted).length,
  });

  return { cleared: true, ...result };
}

// Start the one scan that runs everything.
//
// Every pillar already had its own build button on its own tab, which meant "scan the site"
// was a checklist: know which six to press, and in what order, or the tabs disagree with each
// other afterwards. This is that checklist made into one action.
//
// Automation is deliberately not included. Jira publishes no API to enumerate automation
// rules -- that pillar is fed by importing a rule export by hand -- and a scan that silently
// skipped it while claiming to run everything would be worse than one that says what it covers.
export async function startFullSiteScan({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { started: false, error: "Read-only mode is enabled. Disable it before running a scan." };
  }

  return startFullScan(installationKey);
}

// The one "Resume" button, context-aware:
//
//  - a scan that FINISHED with failed pillars  -> resumeScanRun: put the failed/skipped
//    stages back to pending and walk them again, leaving the ones that built alone.
//  - a scan still "running" but wedged          -> recoverStalledScan(force): re-kick the
//    orchestrator loop from its last checkpoint.
//
// Neither is gated on read-only mode: finishing or unwedging a scan that already started is
// cleanup, not a new scan.
export async function resumeSiteScan({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readFullScanMeta(installationKey).catch(() => null);
  if (meta?.state === "completed-with-failures") {
    return resumeScanRun(installationKey);
  }
  return recoverStalledScan(installationKey, { force: true });
}

// Stop a running full or quick scan outright. Writes the terminal "cancelled" state, which
// is what frees the shared meta row for a fresh run -- a scan wedged in "running" otherwise
// blocks every future scan, with no way out from the UI.
export async function cancelSiteScan({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  return cancelScan(installationKey);
}

// The full/quick scan's "Record site health" stage, wired to its dependencies here.
//
// captureSiteHealth is dependency-injected on purpose -- site-health.js stays testable
// without the Forge modules -- and full-scan-runner.js cannot supply the deps itself without
// importing this file, which would be a module cycle. So the orchestrator dynamic-imports
// this wrapper, the same way it reaches runDeltaIssueScanJob for the issues-delta stage.
// captureSiteHealth never throws; a missing dep would fail the scan, which is exactly the
// bug this replaces.
export async function captureSiteHealthForScan(installationKey) {
  return captureSiteHealth(installationKey, {
    readSnapshotMeta,
    loadSnapshotFields,
    listSnapshotProjects,
    attachUniqueIssueCounts,
    buildDuplicateNameCountMap,
    hydrateFieldForGovernance,
    readAdminConfig,
    readAutomationAnalysis,
    recordHealthSnapshot,
    loadPriorHealthDimensions,
    computeScreenCross: computeAndStoreScreenCross,
  });
}

// The two structural handoff stages -- filters and dashboards -- run on their own queue and
// checkpoint their progress into their own meta row. The orchestrator only knows "running"
// vs "done"; this reaches past it to the sub-build so the stage row can show a real count
// rather than an indeterminate sweep. The issue crawl has its own live view already.
export async function handoffStageProgress(installationKey, currentStage) {
  try {
    if (currentStage === "filters") {
      const m = await readFilterSnapshotMeta(installationKey);
      if (!m) return null;
      return {
        processed: Number(m.processed) || 0,
        total: Number(m.totalExpected) || 0,
        lastError: m.lastError || null,
      };
    }
    if (currentStage === "dashboards") {
      const m = await readDashboardSnapshotMeta(installationKey);
      if (!m) return null;
      // The dashboard build runs in three phases -- enumerate, walk gadgets, resolve gadget
      // configs -- and the count means something different in each. Naming the phase is what
      // turns "3,836 of 5,226" from a mystery into "resolving what each gadget points at".
      const phaseLabels = {
        list: "listing dashboards",
        gadgets: "reading each dashboard's gadgets",
        configs: "resolving what each gadget points at",
      };
      let phase = null;
      try {
        phase = JSON.parse(m.buildCursor || "null")?.phase || null;
      } catch {
        phase = null;
      }
      return {
        processed: Number(m.processed) || 0,
        total: Number(m.totalExpected) || 0,
        lastError: m.lastError || null,
        note: phase ? phaseLabels[phase] || null : null,
      };
    }
  } catch {
    return null;
  }
  return null;
}

// Kick stall recovery from the status read itself, when the meta says a scan is running but
// its heartbeat has gone quiet past the stall window.
//
// The hourly scheduled trigger is the backstop, but "up to an hour wedged" is not good
// enough when an admin is sitting on the page watching it. The status resolver is polled
// every few seconds while a scan runs, so this heals within one poll of the stall -- exactly
// when someone is looking. recoverStalledScan self-gates (it re-reads the meta, no-ops a
// healthy run, and is bounded by MAX_SCAN_RECOVERIES), so firing it here is safe. Fire and
// forget: the kick's effect shows on the next poll, and the current response must not wait
// on a queue push.
export function maybeRecoverStalledScan(installationKey, meta) {
  if (meta?.state !== "running") return;
  const now = Date.now();
  const lastBeat = Date.parse(meta.updatedAt || meta.startedAt || "") || 0;
  const startedMs = Date.parse(meta.startedAt || "") || 0;

  // Two triggers: a heartbeat that has gone quiet past the stall window (a wedged loop), or
  // a run that has been going past its absolute wall-clock ceiling (a zombie whose loop
  // still ticks but never finishes). recoverStalledScan handles both -- it fails the run out
  // on the second. Fire and forget: the effect shows on the next poll.
  const stalled = lastBeat && now - lastBeat > FULL_SCAN_STALL_MS;
  const overLimit = startedMs && now - startedMs > MAX_SCAN_TOTAL_MS;
  if (!stalled && !overLimit) return;

  recoverStalledScan(installationKey).catch(fallbackOn("scan.autorecover_failed", null, { installationKey }));
}

// Recent runs for run-over-run deltas, plus what each pillar currently holds.
//
// liveStageCounts is read from the pillar metas EVERY time, not just mid-scan: a run that was
// cancelled, or finished before this bookkeeping existed, has no full_scan_runs row, and
// without the live read every stage on the page shows "Produced —". The pillar metas are the
// source of truth and always readable. Both are best-effort -- the page degrades rather than
// erroring if either read fails.
export async function scanRunHistory(installationKey, scanType) {
  const [recentRuns, liveStageCounts] = await Promise.all([
    readRecentFullScanRuns(installationKey, { scanType, limit: 8 }).catch(
      fallbackOn("scan.recent_runs_read_failed", [], { installationKey }),
    ),
    readStageProducedCounts(installationKey, scanType).catch(
      fallbackOn("scan.live_counts_read_failed", {}, { installationKey }),
    ),
  ]);
  return { recentRuns, liveStageCounts };
}

// Progress for the Scans tab: one row per stage, plus the catalog so the tab can render the
// full list before a scan has ever run rather than an empty panel.
export async function getFullScanStatus({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  const meta = await readFullScanMeta(installationKey).catch(
    fallbackOn("full_scan.meta_read_failed", null, { installationKey }),
  );

  // A row with no scanType at all predates the quick-scan split and is treated as a full
  // scan's own row, so a scan started just before this shipped still renders correctly.
  const isFull = !meta?.scanType || meta.scanType === "full";
  const currentStage = isFull ? meta?.currentStage || null : null;
  if (isFull) maybeRecoverStalledScan(installationKey, meta);
  const { recentRuns, liveStageCounts } = await scanRunHistory(installationKey, "full");

  return {
    catalog: fullScanStageCatalog(),
    state: isFull ? meta?.state || "idle" : "idle",
    stages: isFull && meta?.stages?.length ? meta.stages : null,
    currentStage,
    currentStageProgress: currentStage ? await handoffStageProgress(installationKey, currentStage) : null,
    startedAt: isFull ? meta?.startedAt || null : null,
    completedAt: isFull ? meta?.completedAt || null : null,
    updatedAt: isFull ? meta?.updatedAt || null : null,
    lastError: isFull ? meta?.lastError || null : null,
    // How many full retry passes over the stage list this run has taken. Surfaced so the
    // page can show "sweep 2 of 2" rather than the rail silently resetting.
    sweep: isFull ? Number(meta?.sweep) || 0 : 0,
    recentRuns,
    liveStageCounts,
    // So the panel can say "a quick scan is running" rather than rendering an idle full-scan
    // panel with no explanation for why the button is disabled.
    blockedByOtherScan: meta?.state === "running" && !isFull,
  };
}

// The quick scan's manual trigger. windowHours defaults to the stored schedule's, so a manual
// "run now" between scheduled runs asks the same question the schedule would have -- "what
// changed since the window" -- rather than an arbitrary different one.
export async function startQuickSiteScan({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { started: false, error: "Read-only mode is enabled. Disable it before running a scan." };
  }

  const windowHours =
    Number(payload?.windowHours) ||
    Number(adminConfig.quickScanSchedule?.windowHours) ||
    DELTA_ISSUE_SCAN_DEFAULT_WINDOW_HOURS;
  return startQuickScan(installationKey, { quickScanWindowHours: windowHours });
}

// Progress for the quick scan, same shape as getFullScanStatus so the tab can render both
// with one component.
export async function getQuickScanStatus({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  const meta = await readFullScanMeta(installationKey).catch(
    fallbackOn("quick_scan.meta_read_failed", null, { installationKey }),
  );

  const isQuick = meta?.scanType === "quick";
  const currentStage = isQuick ? meta?.currentStage || null : null;
  if (isQuick) maybeRecoverStalledScan(installationKey, meta);
  const { recentRuns, liveStageCounts } = await scanRunHistory(installationKey, "quick");

  return {
    catalog: quickScanStageCatalog(),
    // Only reported as belonging to THIS scan type when the shared meta row actually says so
    // -- a full scan's stages must never render on the quick scan panel just because it is
    // the most recent thing to have used the shared row.
    state: isQuick ? meta?.state || "idle" : "idle",
    stages: isQuick && meta?.stages?.length ? meta.stages : null,
    currentStage,
    currentStageProgress: currentStage ? await handoffStageProgress(installationKey, currentStage) : null,
    startedAt: meta?.scanType === "quick" ? meta?.startedAt || null : null,
    completedAt: meta?.scanType === "quick" ? meta?.completedAt || null : null,
    updatedAt: meta?.scanType === "quick" ? meta?.updatedAt || null : null,
    lastError: meta?.scanType === "quick" ? meta?.lastError || null : null,
    sweep: isQuick ? Number(meta?.sweep) || 0 : 0,
    recentRuns,
    liveStageCounts,
    windowHours: meta?.scanType === "quick" ? meta?.quickScanWindowHours : null,
    // So the panel can say "a full scan is running" rather than rendering an idle quick-scan
    // panel with no explanation for why the button is disabled.
    blockedByOtherScan: meta?.state === "running" && meta?.scanType !== "quick",
  };
}

// Bookkeeping for the scheduled trigger, not the save-config resolver: this writes one field
// with no payload validation, because the caller is this app's own scheduler rather than user
// input. Kept separate from saveAdminConfigResolver so a scheduled run can never accidentally
// pass through the same path a person's config edit does and clobber a field they were mid-way
// through changing.
export async function recordQuickScanScheduledRun(at) {
  const current = await readAdminConfig();
  await kvs.set(ADMIN_CONFIG_KEY, {
    ...current,
    quickScanSchedule: { ...current.quickScanSchedule, lastScheduledRunAt: at },
  });
}

export async function startIssueScan({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const currentMeta = await readIssueScanMeta(installationKey);
  if (currentMeta?.state === "building" || currentMeta?.state === "queued") {
    return { started: false, reason: "already-running", meta: currentMeta };
  }

  const jobToken = makeJobToken();
  await writeIssueScanMeta(installationKey, {
    state: "queued",
    jobToken,
    lastError: null,
    progressLog: [{ t: new Date().toISOString(), msg: "Issue scan queued" }],
  });

  try {
    await inventorySnapshotQueue.push({
      body: { jobType: "run-issue-scan", installationKey },
    });
  } catch (pushError) {
    await writeIssueScanMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: `Queue push failed: ${pushError?.message || String(pushError)}`,
      progressLog: [
        { t: new Date().toISOString(), msg: `Failed to queue scan: ${pushError?.message || String(pushError)}` },
      ],
    }).catch(ignoreWith("scan.queue_failure_write_failed", { installationKey }));
    throw pushError;
  }

  return { started: true, jobToken };
}

export async function resumeIssueScan({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const currentMeta = await readIssueScanMeta(installationKey);

  if (!currentMeta) {
    return { resumed: false, reason: "no-scan" };
  }

  if (currentMeta.state === "ready") {
    return { resumed: false, reason: "already-complete", meta: currentMeta };
  }

  const jobToken = currentMeta.jobToken || makeJobToken();
  const progressLog = [
    ...(currentMeta.progressLog || []).slice(-180),
    { t: new Date().toISOString(), msg: "Resume requested; re-queueing incomplete workers from saved checkpoint" },
  ];

  // Mark scan as building again (preserving all existing progress state)
  const meta = await writeIssueScanMeta(installationKey, {
    ...currentMeta,
    state: "building",
    jobToken,
    completedAt: null,
    lastError: null,
    progressLog,
  });

  // Re-queue only workers that haven't finished â€” do NOT call the coordinator
  // (the coordinator wipes all accumulated data and starts over)
  const queueErrors = [];
  let anyRequeued = false;
  for (let workerId = 0; workerId < ISSUE_SCAN_WORKERS; workerId++) {
    const worker = await readIssueScanWorker(installationKey, workerId).catch(
      fallbackOn("scan.worker_read_failed", null, { workerId }),
    );
    if (!worker || worker.status === "done") continue;
    anyRequeued = true;
    // Reset failed workers back to queued so they can run again
    if (worker.status === "failed") {
      await updateIssueScanWorker(installationKey, workerId, { status: "queued", lastError: null }).catch(
        ignoreWith("scan.worker_requeue_write_failed", { workerId }),
      );
    }
    try {
      await queueIssueScanWorker(installationKey, workerId);
    } catch (pushError) {
      queueErrors.push(`worker ${workerId}: ${pushError?.message || String(pushError)}`);
    }
  }

  if (queueErrors.length > 0) {
    const errMsg = `Resume partially failed: ${queueErrors.join("; ")}`;
    await writeIssueScanMeta(installationKey, { state: "failed", lastError: errMsg }).catch(
      ignoreWith("scan.resume_failure_write_failed", { installationKey }),
    );
    throw new Error(errMsg);
  }

  // Every worker already reported "done", so nothing got re-queued above â€” no worker
  // invocation will ever run again to trigger finalization, since that's the only place
  // it's attempted. This happens when the last worker finished mid-cancel: its own
  // finalization claim was rejected because state wasn't "building" at that instant, and
  // the CAS above (which just set state back to "building") is the only thing that makes
  // finalization claimable again. Without this, the scan is stuck at 100%/state=building
  // forever, since re-running resumeIssueScan repeats the exact same no-op indefinitely.
  if (!anyRequeued && (meta?.processedPages ?? 0) >= (meta?.totalPages ?? 0) && (meta?.totalPages ?? 0) > 0) {
    const claimed = await tryClaimIssueScanFinalization(installationKey, jobToken);
    if (claimed) {
      await completeIssueScanFinalization(installationKey, "resumeIssueScan");
      const finalizedMeta = await readIssueScanMeta(installationKey);
      return { resumed: true, jobToken, meta: finalizedMeta, finalizedDirectly: true };
    }
  }

  return { resumed: true, jobToken, meta };
}

// A scan that stops making progress must eventually say so.
//
// Nothing moved a wedged scan out of "building". Workers could fail repeatedly -- the
// audit log shows runs of "400 Bad Request" -- and the job would sit in "building"
// indefinitely, which is worse than failing twice over: the state is a lie, and the admin
// UI polls a "running" job every 15 seconds for as long as a tab is open. One stuck scan
// and one forgotten browser tab is an overnight of SQL for no work.
//
// Progress is judged by the newest progress-log entry rather than startedAt, because a
// long scan legitimately runs for hours -- an hour of silence is the signal, not an hour
// of running.
export const STUCK_SCAN_MS = 30 * 60 * 1000;

export function isScanStuck(meta, now = Date.now()) {
  if (!meta) return false;
  if (meta.state !== "building" && meta.state !== "finalizing") return false;
  const stamps = (meta.progressLog || [])
    .map((entry) => new Date(entry?.t).getTime())
    .filter((n) => Number.isFinite(n));
  const startedAt = new Date(meta.startedAt).getTime();
  // With no usable timestamp at all there is nothing to measure silence against, so the
  // scan is left alone rather than failed on a guess.
  const last = stamps.length ? Math.max(...stamps) : Number.isFinite(startedAt) ? startedAt : null;
  if (last === null) return false;
  return now - last > STUCK_SCAN_MS;
}

export async function getIssueScanStatus({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  let meta = await readIssueScanMeta(installationKey);

  // Fail it here rather than in a scheduled job: this resolver is what an open admin tab
  // polls, so the read that would otherwise keep a dead scan alive is the one that ends it.
  if (isScanStuck(meta)) {
    const minutes = Math.round(STUCK_SCAN_MS / 60000);
    await writeIssueScanMeta(installationKey, {
      ...meta,
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: `No progress for over ${minutes} minutes; marked failed. Resume from checkpoint to continue.`,
      progressLog: [
        ...(meta.progressLog || []).slice(-180),
        {
          t: new Date().toISOString(),
          msg: `Scan stalled — no progress for over ${minutes} minutes. Marked failed; resume to retry from the saved checkpoint.`,
        },
      ],
    }).catch(ignoreWith("scan.stuck_write_failed", { installationKey }));
    meta = await readIssueScanMeta(installationKey);
    return { meta: meta || null };
  }

  // "finalizing" is an internal transition state — surface it as "building" to the UI
  if (meta?.state === "finalizing") return { meta: { ...meta, state: "building" } };
  return { meta: meta || null };
}

export async function cancelIssueScan({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const current = await readIssueScanMeta(installationKey);
  if (!current || current.state === "idle" || current.state === "ready") {
    return { cancelled: false, reason: "not-running" };
  }

  await writeIssueScanMeta(installationKey, {
    state: "cancelled",
    completedAt: new Date().toISOString(),
    progressLog: [
      ...(current.progressLog || []).slice(-80),
      { t: new Date().toISOString(), msg: "Scan cancelled by user" },
    ],
  });

  return { cancelled: true };
}

// ----- Delta issue scan -----

// Exported so the quick-scan orchestrator (full-scan-runner.js) can read the same meta row
// this file's own delta-scan resolvers read. Not imported there statically -- resolvers.js
// already imports startQuickScan/runQuickScanStep from full-scan-runner.js, and a static
// import back the other way would be a module cycle. full-scan-runner.js reaches this and
// runDeltaIssueScanJob via a dynamic import instead, the same escape hatch scan-engine.js
// already uses for the same reason.
export const DELTA_SCOPE_SUFFIX = "::delta";

export const DELTA_ISSUE_SCAN_MAX_PAGES = 200;

// cap at ~20,000 issues per delta run
export const DELTA_ISSUE_SCAN_DEFAULT_WINDOW_HOURS = 24;

export async function runDeltaIssueScanJob(installationKey, windowHours = DELTA_ISSUE_SCAN_DEFAULT_WINDOW_HOURS) {
  const deltaScopeKey = `${installationKey}${DELTA_SCOPE_SUFFIX}`;
  const progressLog = [];

  function logEntry(msg) {
    progressLog.push({ t: new Date().toISOString(), msg });
    if (progressLog.length > 100) progressLog.shift();
    logger.info("runDeltaIssueScanJob.progress", { msg });
  }

  try {
    await ensureProjectStoreReady();

    const existing = await readIssueScanMeta(deltaScopeKey);
    if (existing?.state === "building") {
      const startedMs = existing.startedAt ? new Date(existing.startedAt).getTime() : 0;
      if (startedMs && Date.now() - startedMs < 10 * 60 * 1000) {
        logger.info("runDeltaIssueScanJob.already_in_progress_skipping");
        return;
      }
    }

    const windowDays = Math.max(1, Math.round(windowHours / 24));
    const jql = `created >= "-${windowDays}d" OR updated >= "-${windowDays}d" ORDER BY issueKey ASC`;
    logEntry(`Starting ${windowHours}h delta scan`);

    let totalDeltaIssues = 0;
    try {
      const countData = await jiraRequest(route`/rest/api/3/search/jql`, {
        method: "POST",
        body: JSON.stringify({ jql, maxResults: 0, fields: [] }),
      });
      totalDeltaIssues = Number(countData?.total ?? 0);
    } catch (error) {
      // Progress totals only -- the delta scan runs regardless. Logged because a zero
      // total makes the progress bar claim completion immediately, which reads as a
      // finished scan rather than an unknown one.
      logger.warn("delta.total_count_failed", {
        installationKey: deltaScopeKey,
        error: String(error?.message || error),
      });
    }

    const totalDeltaPages = Math.ceil(totalDeltaIssues / ISSUE_SCAN_PAGE_SIZE);
    logEntry(
      `${totalDeltaIssues.toLocaleString()} issues created/updated in last ${windowDays}d (${totalDeltaPages} pages)`,
    );

    await writeIssueScanMeta(deltaScopeKey, {
      state: "building",
      jobToken: makeJobToken(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      totalIssues: totalDeltaIssues,
      processedIssues: 0,
      processedPages: 0,
      totalPages: totalDeltaPages,
      nextPageToken: null,
      nextStartAt: 0,
      lastError: null,
      progressLog: [...progressLog],
    });

    // Map<fieldId, Map<projectId, { count, key, name }>> â€” same structure as baseline scan
    const fieldProjectCounts = new Map();
    const affectedProjects = new Map();
    const rqtFieldHits = new Map();
    const rqtIssueBuffer = [];
    const rqtValueBuffer = []; // { rqtValue, issueKey }
    const rqtFieldIssueBuffer = []; // { fieldId, issueKey }
    let cursorToken = null;
    let pagesScanned = 0;
    let issuesScanned = 0;

    while (pagesScanned < DELTA_ISSUE_SCAN_MAX_PAGES) {
      const reqBody = { jql, maxResults: ISSUE_SCAN_PAGE_SIZE, fields: ["*all"], fieldsByKeys: false };
      if (cursorToken) reqBody.nextPageToken = cursorToken;

      const data = await jiraRequest(route`/rest/api/3/search/jql`, {
        method: "POST",
        body: JSON.stringify(reqBody),
      });

      const issues = data?.issues || [];
      for (const issue of issues) {
        const projectId = String(issue.fields?.project?.id || "");
        if (!projectId) continue;
        const projectKey = String(issue.fields?.project?.key || "");
        const projectName = String(issue.fields?.project?.name || projectKey);

        affectedProjects.set(projectId, { key: projectKey, name: projectName });

        for (const [fieldId, value] of Object.entries(issue.fields || {})) {
          if (STRUCTURAL_SYSTEM_FIELDS.has(fieldId)) continue;
          if (!isFieldValueNonEmpty(value)) continue;

          let byProject = fieldProjectCounts.get(fieldId);
          if (!byProject) {
            byProject = new Map();
            fieldProjectCounts.set(fieldId, byProject);
          }
          const entry = byProject.get(projectId) || { count: 0, key: projectKey, name: projectName };
          entry.count++;
          byProject.set(projectId, entry);
        }

        const issueRqt = collectIssueRqtValues(issue.fields, issue.fields?.summary);
        for (const [fieldId, values] of issueRqt) {
          const rqtEntry = rqtFieldHits.get(fieldId) || { count: 0, values: new Set() };
          rqtEntry.count++;
          for (const v of values) rqtEntry.values.add(v);
          rqtFieldHits.set(fieldId, rqtEntry);
        }

        if (issueRqt.size > 0 && issue.key) {
          rqtIssueBuffer.push({
            projectKey,
            issueType: issue.fields?.issuetype?.name || "Unknown",
            issueKey: issue.key,
          });
          const allValues = new Set();
          for (const vals of issueRqt.values()) for (const v of vals) allValues.add(v);
          for (const v of allValues) rqtValueBuffer.push({ rqtValue: v, issueKey: issue.key });
        }
        if (issueRqt.size > 0 && issue.key) {
          for (const fieldId of issueRqt.keys()) {
            rqtFieldIssueBuffer.push({ fieldId, issueKey: issue.key });
          }
        }
      }

      issuesScanned += issues.length;
      pagesScanned++;
      cursorToken = data?.nextPageToken || null;

      if (pagesScanned % 5 === 0) {
        await writeIssueScanMeta(deltaScopeKey, {
          processedIssues: issuesScanned,
          processedPages: pagesScanned,
          progressLog: [...progressLog],
        }).catch(ignoreWith("delta.progress_write_failed", { installationKey }));
      }

      if (!cursorToken || issues.length === 0) break;
    }

    if (pagesScanned >= DELTA_ISSUE_SCAN_MAX_PAGES) {
      logEntry(`Delta cap reached (${DELTA_ISSUE_SCAN_MAX_PAGES} pages) â€” results may be partial`);
    }

    logEntry(
      `Scanned ${issuesScanned.toLocaleString()} delta issues â€” ${fieldProjectCounts.size} fields across ${affectedProjects.size} projects`,
    );

    if (rqtFieldHits.size > 0) {
      await upsertRqtFieldHits(installationKey, rqtFieldHits).catch((e) => {
        logger.error("runDeltaIssueScanJob.rqt_flush_error", errorContext(e));
      });
      logEntry(`RQT index updated â€” ${rqtFieldHits.size} field(s) with RQT values`);
    }
    if (rqtIssueBuffer.length > 0) {
      await upsertRqtIssueKeys(installationKey, rqtIssueBuffer).catch((e) => {
        logger.error("runDeltaIssueScanJob.rqt_issue_key_flush_error", errorContext(e));
      });
      logEntry(`RQT issue keys updated â€” ${rqtIssueBuffer.length} issue(s)`);
    }
    if (rqtValueBuffer.length > 0) {
      await upsertRqtValueIssueKeys(installationKey, rqtValueBuffer).catch((e) => {
        logger.error("runDeltaIssueScanJob.rqt_value_index_flush_error", errorContext(e));
      });
    }
    if (rqtFieldIssueBuffer.length > 0) {
      await upsertRqtFieldIssueKeys(installationKey, rqtFieldIssueBuffer).catch((e) => {
        logger.error("runDeltaIssueScanJob.rqt_field_issue_index_flush_error", errorContext(e));
      });
    }

    // Update project totals (accurate: re-count total issues per affected project)
    const projectRows = [];
    if (affectedProjects.size > 0) {
      const projectEntries = Array.from(affectedProjects.entries());
      const counts = await mapWithConcurrency(projectEntries, 4, async ([projectId, proj]) => {
        try {
          const safeKey = proj.key.replace(/"/g, '\\"');
          const countData = await jiraRequest(route`/rest/api/3/search/jql`, {
            method: "POST",
            body: JSON.stringify({ jql: `project = "${safeKey}"`, maxResults: 0, fields: [] }),
          });
          return {
            projectId,
            projectKey: proj.key,
            projectName: proj.name,
            uniqueIssueCount: Number(countData?.total ?? 0),
          };
        } catch {
          return null;
        }
      });
      projectRows.push(...counts.filter(Boolean));
      await upsertProjectTotalsForDelta(installationKey, projectRows);
      logEntry(`Updated total issue counts for ${projectRows.length} project${projectRows.length !== 1 ? "s" : ""}`);
    }

    // Update fieldÃ—project usage: for each touched pair, get accurate total count via JQL
    const snapshotMeta = await readSnapshotMeta(installationKey);
    let fieldProjectPairsUpdated = 0;

    if (snapshotMeta?.version && fieldProjectCounts.size > 0) {
      const touchedPairs = [];
      for (const [fieldId, byProject] of fieldProjectCounts) {
        for (const [projectId, proj] of byProject) {
          touchedPairs.push({
            fieldId,
            projectId,
            projectKey: proj.key,
            projectName: proj.name,
            deltaCount: proj.count,
          });
        }
      }
      touchedPairs.sort((a, b) => b.deltaCount - a.deltaCount);
      const cappedPairs = touchedPairs.slice(0, 500);
      if (touchedPairs.length > 500) {
        logEntry(`Capped fieldÃ—project count queries at 500 of ${touchedPairs.length} pairs`);
      }

      logEntry(`Running ${cappedPairs.length} fieldÃ—project count queries...`);

      const usageRows = await mapWithConcurrency(
        cappedPairs,
        6,
        async ({ fieldId, projectId, projectKey, projectName }) => {
          try {
            const numericId = getFieldNumericId(fieldId);
            const fieldSelector = numericId ? `cf[${numericId}]` : fieldId;
            const safeKey = projectKey.replace(/"/g, '\\"');
            const countData = await jiraRequest(route`/rest/api/3/search/jql`, {
              method: "POST",
              body: JSON.stringify({
                jql: `project = "${safeKey}" AND ${fieldSelector} is not EMPTY`,
                maxResults: 0,
                fields: [],
              }),
            });
            return {
              fieldId,
              projectId,
              projectKey,
              projectName,
              issueCount: Number(countData?.total ?? 0),
              jql: buildFieldJql(fieldId, projectKey),
            };
          } catch {
            return null;
          }
        },
      );

      const validRows = usageRows.filter(Boolean).filter((r) => r.issueCount > 0);
      fieldProjectPairsUpdated = await upsertDeltaFieldProjectUsage(installationKey, snapshotMeta.version, validRows);
      logEntry(`Updated ${fieldProjectPairsUpdated} fieldÃ—project usage rows in snapshot`);
    } else if (!snapshotMeta?.version) {
      logEntry("No snapshot found â€” skipping field usage update (run a snapshot first)");
    }

    await writeIssueScanMeta(deltaScopeKey, {
      state: "ready",
      completedAt: new Date().toISOString(),
      processedIssues: issuesScanned,
      processedPages: pagesScanned,
      totalIssues: totalDeltaIssues,
      totalPages: totalDeltaPages,
      nextPageToken: null,
      nextStartAt: 0,
      lastError: null,
      projectsUpdated: projectRows.length,
      fieldProjectPairsUpdated,
      progressLog: [...progressLog],
    });
  } catch (error) {
    await writeIssueScanMeta(deltaScopeKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: error?.message || String(error),
      progressLog: [
        ...progressLog,
        { t: new Date().toISOString(), msg: `Delta scan failed: ${error?.message || error}` },
      ],
    }).catch(ignoreWith("delta.failure_write_failed", { installationKey }));
    logger.error("runDeltaIssueScanJob.failed", errorContext(error));
  }
}

export async function startDeltaIssueScan({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const deltaScopeKey = `${installationKey}${DELTA_SCOPE_SUFFIX}`;

  const existing = await readIssueScanMeta(deltaScopeKey);
  if (existing?.state === "building" || existing?.state === "queued") {
    return { started: false, reason: "already-running" };
  }

  try {
    await writeIssueScanMeta(deltaScopeKey, {
      state: "queued",
      progressLog: [{ t: new Date().toISOString(), msg: "Delta scan queued" }],
    });
    await inventorySnapshotQueue.push({
      body: { jobType: "run-delta-issue-scan", installationKey },
    });
    return { started: true };
  } catch (pushError) {
    await writeIssueScanMeta(deltaScopeKey, {
      state: "failed",
      lastError: `Queue push failed: ${pushError?.message || pushError}`,
    }).catch(ignoreWith("delta.completion_write_failed", { installationKey }));
    throw pushError;
  }
}

export async function getDeltaIssueScanStatus({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const deltaScopeKey = `${installationKey}${DELTA_SCOPE_SUFFIX}`;
  const meta = await readIssueScanMeta(deltaScopeKey);
  return { meta: meta || null };
}
