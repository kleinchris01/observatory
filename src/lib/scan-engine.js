import { inventorySnapshotQueue } from "./queues.js";
import { logger, fallbackOn, ignoreWith } from "./logger.js";
import {
  jiraRequest,
  sleep,
  incrMetric,
  METRIC_NAMES,
  makeJobToken,
  getAllJiraProjectKeys,
  loadFieldOptionsFromJira,
  getScanTelemetry,
  resetScanTelemetry,
  mapWithConcurrency,
  withTimeout,
  ISSUE_SCAN_PAGE_SIZE,
  ISSUE_SCAN_WORKERS,
  ISSUE_SCAN_SLICES_PER_WORKER,
  ISSUE_SCAN_INTER_PAGE_DELAY_MS,
  ISSUE_SCAN_FLUSH_EVERY_PAGES,
  ISSUE_SCAN_CANCEL_CHECK_EVERY_PAGES,
} from "./jira-api.js";
import {
  ensureProjectStoreReady,
  readSnapshotMeta,
  writeSnapshotMeta,
  clearSnapshotVersion,
  writeIssueScanMeta,
  readIssueScanMeta,
  clearIssueScanBuffer,
  clearIssueScanBufferForProjects,
  replaceIssueScanWorkers,
  readIssueScanWorker,
  updateIssueScanWorker,
  replaceFieldOptionsCache,
  flushIssueScanCounts,
  flushIssueScanTypeCounts,
  flushIssueScanFieldUserCounts,
  flushIssueScanActivity,
  promoteIssueScanActivity,
  flushIssueScanStatusCounts,
  clearStatusIssueCounts,
  finalizeIssueScan,
  clearRqtFieldIndex,
  upsertRqtFieldHits,
  clearRqtIssueKeys,
  upsertRqtIssueKeys,
  clearRqtValueIndex,
  upsertRqtValueIssueKeys,
  clearRqtFieldIssueIndex,
  upsertRqtFieldIssueKeys,
  atomicAccumulateIssueScanProgress,
  appendIssueScanLogEntry,
  tryClaimIssueScanFinalization,
  loadIssueScanProjectTotals,
  promoteIssueScanToSnapshotProjectUsage,
  promoteIssueScanFieldTypeUsage,
  promoteIssueScanFieldUserUsage,
} from "./project-store.js";
import {
  STRUCTURAL_SYSTEM_FIELDS,
  isFieldValueNonEmpty,
  collectIssueRqtValues,
  isSelectFieldType,
  getRetryDelayMs,
} from "./analysis.js";
import { syncFieldCatalog, refreshGovernanceFindingsForFields } from "./snapshot-engine.js";
import { route } from "@forge/api";

// Pages one slice crawls per invocation before it checkpoints and re-queues the worker.
//
// Raised from 10 to 25: the re-queue is a Forge async-event push, and five workers x three
// slices re-queuing every 10 pages is what was bursting the installation's event rate limit
// on a large site (seen as "400 Bad Request" / "Limits ... exceeded" on the push). At 25 the
// worker re-queues ~2.5x less often. Memory is still bounded -- maybeFlush drains every
// ISSUE_SCAN_FLUSH_EVERY_PAGES regardless -- and 25 pages x 3 concurrent slices is a few
// minutes of wall-clock even under heavy 429 backoff, well inside the 900s consumer budget.
const ISSUE_SCAN_CHUNK_PAGES = 25;

// How many times one slice may restart before the scan gives up on it alone.
//
// Bounded because a slice whose JQL Jira simply will not accept would otherwise restart
// forever, and a scan that never finishes is worse than one that finishes and says which
// projects it could not read.
const MAX_SLICE_RESTARTS = 3;
const ISSUE_SCAN_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
const ISSUE_COUNT_TIMEOUT_MS = 8000;

export function isJiraRateLimitError(error) {
  return Number(error?.status) === 429;
}

// The accountIds carried by a field value, if any. A user-picker value is
// { accountId, displayName, ... }; a multi-user picker is an array of those. Anything
// without an accountId contributes nothing, so the caller's tally stays empty for every
// non-user field.
export function accountsInValue(value) {
  const out = [];
  const push = (v) => {
    if (v && typeof v === "object" && typeof v.accountId === "string" && v.accountId) {
      out.push({ accountId: v.accountId, displayName: typeof v.displayName === "string" ? v.displayName : null });
    }
  };
  if (Array.isArray(value)) value.forEach(push);
  else push(value);
  return out;
}

// A Forge PLATFORM limit, not a Jira one. The async-events queue caps how many jobs one
// installation may have in flight; past that, push() is rejected with one of these. It is
// transient -- the ceiling clears within seconds as running jobs drain -- so a push that
// hits it is worth retrying rather than treating as a hard failure. Same phrases the
// consumer's last-resort catch in index.js already keys off.
export function isForgeBackpressureError(error) {
  if (error?.code === "RATE_LIMIT_EXCEEDED") return true;
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("too many requests") ||
    message.includes("rate limit") ||
    message.includes("cyclic invocation") ||
    message.includes("limits for the current installation have been exceeded")
  );
}

// Whether a FAILED queue push is the platform pushing back rather than a real bug. The
// events API rejects a burst with any of the backpressure phrases above OR, seen live, a
// bare "400 Bad Request" -- and in a push the body is a fixed {jobType, installationKey,
// workerId}, so a 400 here is never a malformed payload, it is "you are pushing too fast".
// Scoped to the push path deliberately: a Jira 400 (bad JQL, expired page token) is a
// different animal and is handled by the slice-restart logic.
function isQueuePushRejection(error) {
  if (isForgeBackpressureError(error)) return true;
  if (Number(error?.status) === 400 || Number(error?.statusCode) === 400) return true;
  return /\b400\b/.test(String(error?.message || error || ""));
}

// How many times a worker re-queue is retried before the push is allowed to fail. Eight
// attempts back off ~3s, 6s, 12s, 24s, 45s, 45s, 45s -- around three minutes, long enough
// to ride out a cyclic-invocation ceiling that clears once other chains drain. If it still
// will not land after that, the worker PAUSES rather than fails (see the catch in
// runIssueScanWorkerV2): its checkpoint is intact and reviveStalledIssueScanWorkers
// re-queues it from a fresh chain.
const ISSUE_SCAN_WORKER_PUSH_ATTEMPTS = 8;

export function isExpiredPageTokenError(error) {
  return Number(error?.status) === 400 && String(error?.message || "").toLowerCase().includes("next page token");
}

export async function queueIssueScanChunk(installationKey, progressLog = [], nextStartAt = 0) {
  const retryDelaysMs = [0, 2000, 5000];
  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    if (retryDelaysMs[attempt] > 0) await sleep(retryDelaysMs[attempt]);
    try {
      await inventorySnapshotQueue.push({
        body: { jobType: "run-issue-scan", installationKey },
      });
      return true;
    } catch (pushError) {
      if (attempt < retryDelaysMs.length - 1) continue;
      const delayMs = ISSUE_SCAN_RATE_LIMIT_COOLDOWN_MS;
      const queuedLog = [
        ...progressLog,
        {
          t: new Date().toISOString(),
          msg: `Queue backpressure hit; pausing universe scan for ${Math.round(delayMs / 1000)}s before retry`,
        },
      ];
      await writeIssueScanMeta(installationKey, {
        state: "queued",
        nextStartAt: nextStartAt || (Date.now() + delayMs),
        lastError: null,
        progressLog: queuedLog,
      }).catch(ignoreWith("scan.backpressure_meta_write_failed", { installationKey }));
      return false;
    }
  }
  return false;
}

// Re-queue one worker, riding out a transient Forge queue rejection rather than letting it
// kill the worker.
//
// The worker's crawl state (slice cursors, counts) is already checkpointed to its own row
// before this is called, so a failed push loses no progress -- but nothing else re-queues a
// worker mid-scan, so a push that never lands means that worker's projects silently keep
// last scan's numbers. A queue-limit rejection (see isQueuePushRejection) is transient;
// retry it. A genuinely different error is rethrown at once -- retrying that just delays the
// real failure.
//
// `delaySeconds` staggers the workers off each other: without it five of them re-queue in
// the same instant every chunk, and that lockstep burst is what pushes the installation's
// event rate over its limit in the first place.
export async function queueIssueScanWorker(installationKey, workerId, { delaySeconds = 0 } = {}) {
  const body = { jobType: "run-issue-scan-worker", installationKey, workerId };
  for (let attempt = 1; attempt <= ISSUE_SCAN_WORKER_PUSH_ATTEMPTS; attempt++) {
    try {
      await inventorySnapshotQueue.push({
        body,
        ...(delaySeconds > 0 ? { delayInSeconds: Math.min(900, Math.round(delaySeconds)) } : {}),
      });
      return;
    } catch (error) {
      if (!isQueuePushRejection(error) || attempt === ISSUE_SCAN_WORKER_PUSH_ATTEMPTS) {
        // Tag an exhausted queue-limit rejection so the worker catch pauses (keeps its
        // slot open for a later revive) instead of closing it and finalizing a partial run.
        if (isQueuePushRejection(error)) error.isQueueBackpressureExhausted = true;
        throw error;
      }
      const backoffMs = Math.min(45000, 3000 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 1000);
      logger.warn("scan.worker_requeue_backpressure", { installationKey, workerId, attempt, backoffMs });
      await sleep(backoffMs);
    }
  }
}

// The marker runIssueScanWorkerV2 writes on a worker it parked because its self-re-queue
// could not clear the Forge cyclic-invocation ceiling. reviveStalledIssueScanWorkers keys
// off exactly this so it can never race a worker the coordinator has only just queued.
const WORKER_PAUSED_MARKER = "Paused on a Forge queue limit";

// Re-queue any crawl worker that PAUSED because its own re-queue could not land.
//
// A worker re-queues itself every chunk. When that push cannot clear a Forge cyclic-invocation
// ceiling -- several chains re-queuing at once -- the worker writes its checkpoint, marks
// itself `queued` with WORKER_PAUSED_MARKER, and stops (see the catch in runIssueScanWorkerV2).
// Nothing in the worker's own chain can restart it then, by definition. This runs from OUTSIDE
// that chain -- the full scan's issues poll every 30s, and the hourly watchdog -- so its
// re-queue starts a fresh chain clear of the ceiling.
//
// Deliberately narrow: only a worker carrying the pause marker is touched. A freshly
// coordinator-queued worker has no marker, and an in-flight worker is `building`, so neither
// can be double-queued from here. Finalisation cannot fire while the paused worker holds its
// slot open (it was never accumulated), so this is what lets a transient limit self-heal
// with full coverage instead of dropping ~30k issues and reporting clean.
export async function reviveStalledIssueScanWorkers(installationKey) {
  const meta = await readIssueScanMeta(installationKey).catch(() => null);
  if (meta?.state !== "building") return { revived: 0, checked: 0 };

  const workers = await Promise.all(
    Array.from({ length: ISSUE_SCAN_WORKERS }, (_, workerId) =>
      readIssueScanWorker(installationKey, workerId).catch(() => null))
  );

  let revived = 0;
  for (let workerId = 0; workerId < workers.length; workerId++) {
    const worker = workers[workerId];
    if (!worker) continue;
    if (worker.status !== "queued") continue;
    if (!String(worker.lastError || "").includes(WORKER_PAUSED_MARKER)) continue;

    try {
      // Clear the marker first so a second watchdog tick a moment later does not re-queue the
      // same worker while its restart message is still in flight.
      await updateIssueScanWorker(installationKey, workerId, { lastError: null })
        .catch(ignoreWith("scan.worker_revive_marker_clear_failed", { workerId }));
      await queueIssueScanWorker(installationKey, workerId, { delaySeconds: 1 + workerId });
      revived += 1;
      logger.warn("scan.worker_revived", { installationKey, workerId });
    } catch (error) {
      // The ceiling is still hot. Put the marker back so the next tick retries -- the worker's
      // slot stays open, so nothing finalises without it.
      await updateIssueScanWorker(installationKey, workerId, {
        lastError: `${WORKER_PAUSED_MARKER}; resuming automatically once platform limits clear.`,
      }).catch(ignoreWith("scan.worker_revive_marker_restore_failed", { workerId }));
      logger.warn("scan.worker_revive_deferred", { installationKey, workerId, error: String(error?.message || error) });
    }
  }
  return { revived, checked: workers.filter(Boolean).length };
}

export async function queueFieldOptionsCache(installationKey, fieldId) {
  await inventorySnapshotQueue.push({
    body: { jobType: "cache-field-options", installationKey, fieldId },
  });
}

export async function cacheFieldOptionsForField(installationKey, fieldId) {
  if (!fieldId) return { fieldId, optionCount: 0 };
  const optionsByContext = await loadFieldOptionsFromJira(fieldId);
  const result = await replaceFieldOptionsCache(installationKey, fieldId, optionsByContext);
  return { fieldId, ...result };
}

export async function completeIssueScanFinalization(installationKey, tag, workerError = null) {
  try {
    console.log(`${tag}: finalizing scan...`);
    await finalizeIssueScan(installationKey);

    // Promote the month histogram from its buffer, per project. Best-effort: a failure here
    // leaves the last good series in place, which is the whole point of the buffer -- it is
    // strictly better to keep last week's activity than to lose it because a promote query
    // timed out.
    const activityPromoted = await promoteIssueScanActivity(installationKey)
      .catch(fallbackOn("scan.activity_promote_failed", { projectsPromoted: 0, rowsInserted: 0 }, { installationKey }));
    console.log(`${tag}: promoted activity for ${activityPromoted.projectsPromoted} projects (${activityPromoted.rowsInserted} rows)`);

    // Read every worker's final state once, up front: it decides both whether the crawl's
    // totals can be trusted as authoritative AND whether this run carries a coverage caveat.
    const workers = await Promise.all(
      Array.from({ length: ISSUE_SCAN_WORKERS }, (_, workerId) =>
        readIssueScanWorker(installationKey, workerId).catch(fallbackOn("scan.worker_read_failed", null, { workerId })))
    );
    const scanCoverageComplete = workers.every((worker) => !worker || worker.status === "done");
    const unfinished = workers
      .map((worker, workerId) => ({ workerId, worker }))
      .filter(({ worker }) => worker && worker.status !== "done");
    // Never let a partial crawl report as clean. `workerError` from the caller wins if given;
    // otherwise derive the caveat from the workers themselves. This line was silently `null`
    // before — the finalize write clobbered the "worker N stopped" note the catch had just
    // written, so a run that dropped tens of thousands of issues showed a green tick.
    const coverageCaveat = workerError
      || (unfinished.length
        ? `${unfinished.length} of ${ISSUE_SCAN_WORKERS} crawl workers did not finish `
          + `(${unfinished.map(({ workerId, worker }) => `worker ${workerId}: ${worker.lastError || worker.status}`).join("; ")}). `
          + `Their projects keep their previous issue counts — re-run the scan to complete them.`
        : null);

    const snapshotMeta = await readSnapshotMeta(installationKey);
    if (snapshotMeta?.version) {
      // Only trust the crawl's totals as authoritative (and zero out fields it never saw)
      // when every worker actually finished — a field absent from a partial crawl's buffer
      // is "not yet crawled," not "confirmed zero," and treating it as the latter would
      // erase good data from a previous run.
      const promoted = await promoteIssueScanToSnapshotProjectUsage(installationKey, snapshotMeta.version, { syncTotalIssueCount: scanCoverageComplete });
      console.log(`${tag}: promoted ${promoted.fieldsPromoted} fields (${promoted.rowsInserted} rows)${scanCoverageComplete ? ", totals synced" : ""}`);

      // The field x issue-type axis, promoted the same way and gated the same way: a field
      // absent from a partial crawl's buffer is "not yet crawled", not "used on no type".
      const typePromoted = await promoteIssueScanFieldTypeUsage(installationKey, snapshotMeta.version, { coverageComplete: scanCoverageComplete })
        .catch(fallbackOn("scan.field_type_promote_failed", { fieldsPromoted: 0, rowsInserted: 0 }, { installationKey }));
      console.log(`${tag}: promoted issue-type usage for ${typePromoted.fieldsPromoted} fields (${typePromoted.rowsInserted} rows)`);

      // The field x user axis: which people a user-picker field references. Same gating.
      const userPromoted = await promoteIssueScanFieldUserUsage(installationKey, snapshotMeta.version, { coverageComplete: scanCoverageComplete })
        .catch(fallbackOn("scan.field_user_promote_failed", { fieldsPromoted: 0, rowsInserted: 0 }, { installationKey }));
      console.log(`${tag}: promoted user-picker usage for ${userPromoted.fieldsPromoted} fields (${userPromoted.rowsInserted} rows)`);

      if (promoted.touchedFieldIds?.length) {
        const refreshed = await refreshGovernanceFindingsForFields(installationKey, snapshotMeta.version, promoted.touchedFieldIds).catch((err) => {
          console.warn(`${tag}: refreshGovernanceFindingsForFields failed:`, err?.message || err);
          return { updatedCount: 0 };
        });
        console.log(`${tag}: refreshed findings for ${refreshed.updatedCount} fields`);
      }
    }

    const finalMeta = await readIssueScanMeta(installationKey);
    const completionTimestamp = new Date().toISOString();
    const completedProgressLog = [
      ...((finalMeta?.progressLog || []).slice(-40)),
      {
        t: completionTimestamp,
        msg: coverageCaveat
          ? `Scan complete with partial coverage - ${(finalMeta?.processedIssues || 0).toLocaleString()} issues. ${coverageCaveat}`
          : `Scan complete - ${(finalMeta?.processedIssues || 0).toLocaleString()} issues`,
      },
    ];
    const prevScanHistory = (finalMeta?.scanHistory || []).slice(-14);
    await writeIssueScanMeta(installationKey, {
      state: "ready",
      completedAt: completionTimestamp,
      nextPageToken: null,
      nextStartAt: 0,
      lastError: coverageCaveat,
      progressLog: completedProgressLog,
      scanHistory: [
        ...prevScanHistory,
        {
          startedAt: finalMeta?.startedAt || null,
          completedAt: completionTimestamp,
          processedIssues: finalMeta?.processedIssues || 0,
          progressLog: completedProgressLog.slice(-30),
        },
      ],
    });
    console.log(`${tag}: scan finalized and marked ready`);
    logger.info("scan.finalized", { installationKey, processedIssues: finalMeta?.processedIssues || 0 });
  } catch (error) {
    const message = error?.message || String(error);
    logger.error("scan.finalization_failed", { installationKey, error: message });
    console.error(`${tag}: finalization failed:`, message);
    const finalMeta = await readIssueScanMeta(installationKey).catch(fallbackOn("scan.final_meta_read_failed", null, { installationKey }));
    await writeIssueScanMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      nextPageToken: null,
      nextStartAt: 0,
      lastError: `Finalization failed: ${message}`,
      progressLog: [
        ...((finalMeta?.progressLog || []).slice(-40)),
        { t: new Date().toISOString(), msg: `Finalization failed - ${message}` },
      ],
    }).catch(ignoreWith("scan.finalization_failure_write_failed", { installationKey }));
  }
}

export async function runIssueScanCoordinator(installationKey) {
  try {
    await ensureProjectStoreReady();

    const existing = await readIssueScanMeta(installationKey);
    if (existing?.state !== "queued") {
      console.log("runIssueScanCoordinator: not in queued state, skipping");
      return;
    }

    logger.info("scan.coordinator.start", { installationKey });
    const log = (msg) => console.log(`runIssueScanCoordinator: ${msg}`);

    log("Fetching all project keys...");
    const allProjectKeys = await getAllJiraProjectKeys();

    if (allProjectKeys.length === 0) {
      await writeIssueScanMeta(installationKey, {
        state: "ready",
        completedAt: new Date().toISOString(),
        totalIssues: 0,
        processedIssues: 0,
        totalPages: 0,
        processedPages: 0,
        progressLog: [{ t: new Date().toISOString(), msg: "No projects found — scan skipped" }],
      });
      return;
    }

    // Get site-wide issue count for progress tracking
    log("Fetching site-wide issue count...");
    // Never swallow this failure silently. `null?.count ?? 0` renders a failed count as a
    // confident "Site-wide issue count: 0", which is indistinguishable from a site that
    // genuinely has no issues -- and sends whoever reads the log chasing the wrong thing.
    // jiraRequest already builds a message carrying the HTTP status and response body; the
    // only reason it was ever invisible is that it was discarded here.
    const globalCountResult = await withTimeout(
      jiraRequest(route`/rest/api/3/search/approximate-count`, {
        method: "POST",
        body: JSON.stringify({ jql: "project is not empty" }),
      }),
      ISSUE_COUNT_TIMEOUT_MS
    ).catch((error) => {
      logger.warn("scan.coordinator.global_count_failed", {
        message: error?.message || String(error),
        status: error?.status ?? null,
      });
      return null;
    });
    const totalEstimatedIssues = Number(globalCountResult?.count ?? 0);
    log(
      globalCountResult
        ? `Site-wide issue count: ${totalEstimatedIssues.toLocaleString()}`
        : "Site-wide issue count UNAVAILABLE (count API failed) — progress totals will be unreliable"
    );

    // Get per-project approximate counts to load-balance workers.
    // Prefer historical data; fall back to live approximate-count for unknown projects.
    const knownTotals = await loadIssueScanProjectTotals(installationKey).catch(fallbackOn("scan.project_totals_load_failed", () => [], { installationKey }));
    const issueCountByKey = new Map(knownTotals.map((r) => [r.projectKey, r.uniqueIssueCount]));
    const unknownKeys = allProjectKeys.filter((k) => !issueCountByKey.has(k));
    if (unknownKeys.length > 0) {
      log(`Fetching approximate counts for ${unknownKeys.length} unknown projects...`);
      const APPROX_BATCH = 8;
      // Per-key failures fall back to a nominal 100 so bin-packing can still proceed, but
      // they are counted and reported. Silently substituting 100 for every project turns a
      // total API outage into a scan that looks like it is working on plausible data.
      // Aggregated rather than logged per key: 142 identical stack traces bury the signal.
      let approxFailures = 0;
      let firstApproxError = null;
      for (let i = 0; i < unknownKeys.length; i += APPROX_BATCH) {
        const batch = unknownKeys.slice(i, i + APPROX_BATCH);
        const results = await Promise.all(
          batch.map((key) =>
            withTimeout(
              jiraRequest(route`/rest/api/3/search/approximate-count`, {
                method: "POST",
                body: JSON.stringify({ jql: `project = "${key}"` }),
              }),
              ISSUE_COUNT_TIMEOUT_MS
            )
              .then((r) => [key, Number(r?.count ?? 0)])
              .catch((error) => {
                approxFailures++;
                if (!firstApproxError) {
                  firstApproxError = { message: error?.message || String(error), status: error?.status ?? null };
                }
                return [key, 100];
              })
          )
        );
        for (const [key, count] of results) issueCountByKey.set(key, count || 1);
        if (i + APPROX_BATCH < unknownKeys.length) await sleep(150);
      }
      if (approxFailures > 0) {
        logger.warn("scan.coordinator.approx_count_failures", {
          failed: approxFailures,
          total: unknownKeys.length,
          firstError: firstApproxError,
        });
        log(`Approximate count failed for ${approxFailures}/${unknownKeys.length} projects: ${firstApproxError?.message || "unknown error"}`);
      }
    }

    // Greedy bin-pack: assign projects to ISSUE_SCAN_WORKERS bins so each bin has
    // approximately equal total issue count. Sort largest-first (LPT heuristic).
    const sortedKeys = [...allProjectKeys].sort(
      (a, b) => (issueCountByKey.get(b) ?? 1) - (issueCountByKey.get(a) ?? 1)
    );
    const bins = Array.from({ length: ISSUE_SCAN_WORKERS }, () => ({ keys: [], count: 0 }));
    for (const key of sortedKeys) {
      const smallest = bins.reduce((min, b) => b.count < min.count ? b : min);
      smallest.keys.push(key);
      smallest.count += issueCountByKey.get(key) ?? 1;
    }

    // Build one JQL filter per worker covering all its assigned projects. Kept because it is
    // still what a single-slice worker crawls, and what the logs and older rows refer to.
    const workerJqls = bins.map((bin) =>
      bin.keys.length === 0 ? null : `project IN (${bin.keys.map((k) => `"${k}"`).join(", ")})`
    );

    // And the slices within each worker -- see sliceProjectKeys. This is where the throughput
    // comes from: the same five invocations, each now using the request concurrency it was
    // always permitted instead of one page at a time.
    const workerSlices = bins.map((bin) =>
      bin.keys.length === 0 ? [] : sliceProjectKeys(bin.keys, issueCountByKey, ISSUE_SCAN_SLICES_PER_WORKER)
    );

    // Keep the field inventory in sync with Jira before crawling — every scan run
    // re-checks for new/renamed fields via a fast metadata-only call (no per-field issue
    // counting), so newly created custom fields are targeted by this same run instead of
    // waiting for the next full snapshot build.
    let snapshotMeta = await readSnapshotMeta(installationKey);
    if (snapshotMeta?.state === "building") {
      // A manual/scheduled runSnapshot() is actively writing this version — don't race it.
      log("Skipping field catalog sync — a snapshot build is currently in progress");
    } else {
      try {
        const isColdStart = !snapshotMeta?.version;
        const version = snapshotMeta?.version || String(Date.now());
        if (isColdStart) await clearSnapshotVersion(installationKey, version);
        const syncResult = await syncFieldCatalog(installationKey, version);
        log(`Field catalog synced — ${syncResult.newFieldCount} new, ${syncResult.changedFieldCount} changed, ${syncResult.totalCatalogCount} total`);
        const now = new Date().toISOString();
        await writeSnapshotMeta(installationKey, isColdStart
          ? { state: "ready", version, buildingVersion: null, startedAt: now, completedAt: now, refreshedAt: now, totalFields: syncResult.totalCatalogCount, processedFields: syncResult.totalCatalogCount, lastError: null }
          : { totalFields: syncResult.totalCatalogCount });
        snapshotMeta = await readSnapshotMeta(installationKey);
      } catch (syncError) {
        // Discovery must never block the crawl itself — fall through and use whatever
        // inventory already exists (or none, via the "*all" fields fallback below).
        log(`Field catalog sync failed (continuing with existing inventory): ${syncError?.message}`);
      }
    }

    // Targeted fields from the active snapshot — smaller payloads, faster per-page processing
    let fieldIds = null;
    if (snapshotMeta?.version) {
      const { loadSnapshotFields } = await import("./project-store.js");
      const snapshotFields = await loadSnapshotFields(installationKey, snapshotMeta.version);
      const ids = new Set(snapshotFields.map((field) => field.id));
      // "created" alongside "project", for the same reason: neither is a custom field, and
      // a targeted scan that omits it cannot say how old a project is or when work in it
      // stopped. One more field on a payload already carrying hundreds.
      if (ids.size > 0) fieldIds = ["project", "created", ...ids];
      const selectFields = snapshotFields.filter((field) => isSelectFieldType(field.type));
      for (const field of selectFields) {
        try {
          await queueFieldOptionsCache(installationKey, field.id);
        } catch (pushError) {
          console.warn(`runIssueScanCoordinator: failed to queue option cache for ${field.id}:`, pushError?.message || pushError);
        }
      }
    }

    log(`Starting ${ISSUE_SCAN_WORKERS} workers across ${allProjectKeys.length} projects (${totalEstimatedIssues.toLocaleString()} issues on site)`);

    await clearIssueScanBuffer(installationKey);
    // Status totals accumulate with ON DUPLICATE KEY UPDATE, so a fresh run must start
    // from empty -- otherwise a re-scan doubles every count.
    await clearStatusIssueCounts(installationKey).catch(ignoreWith("scan.status_totals_clear_failed", { installationKey }));
    await clearRqtFieldIndex(installationKey);
    await clearRqtIssueKeys(installationKey);
    await clearRqtValueIndex(installationKey);
    await clearRqtFieldIssueIndex(installationKey);
    await writeIssueScanMeta(installationKey, {
      state: "building",
      startedAt: new Date().toISOString(),
      completedAt: null,
      totalPages: ISSUE_SCAN_WORKERS,  // one slot per worker; finalization fires when all done
      processedPages: 0,
      totalIssues: totalEstimatedIssues,
      processedIssues: 0,
      nextPageToken: null,
      nextStartAt: 0,
      lastError: null,
      progressLog: [{ t: new Date().toISOString(), msg: `Starting ${ISSUE_SCAN_WORKERS} workers — ${totalEstimatedIssues.toLocaleString()} issues on site` }],
    });

    await replaceIssueScanWorkers(
      installationKey,
      workerJqls.map((jqlFilter, workerId) => ({
        workerId,
        status: "queued",
        jqlFilter,
        slices: workerSlices[workerId],
        fieldIds,
      }))
    );

    for (let i = 0; i < ISSUE_SCAN_WORKERS; i++) {
      // Fan the workers out a couple of seconds apart rather than all in one instant -- same
      // reason the mid-crawl re-queue is staggered.
      await queueIssueScanWorker(installationKey, i, { delaySeconds: i * 2 });
    }

    log(`All ${ISSUE_SCAN_WORKERS} workers queued`);
    logger.info("scan.coordinator.workers_queued", { installationKey, workers: ISSUE_SCAN_WORKERS });
  } catch (error) {
    logger.error("scan.coordinator.failed", { installationKey, error: error?.message });
    console.error("runIssueScanCoordinator failed:", error?.message || error);
    await writeIssueScanMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: error?.message || String(error),
    }).catch(ignoreWith("scan.coordinator_failure_write_failed", { installationKey }));
  }
}

// A worker's slices, in the shape the crawl loop wants.
//
// Older worker rows -- and any scan already in flight when this deployed -- have a single
// jqlFilter and a single nextPageToken and no slices at all. Rather than branch the crawl on
// which shape it got, those are presented as one slice. The loop then has exactly one path,
// and a scan running across the deploy finishes on its original cursor instead of restarting.
export function normalizeWorkerSlices(worker) {
  const stored = Array.isArray(worker?.slices) ? worker.slices : null;
  if (stored && stored.length) {
    return stored.map((slice, index) => ({
      id: Number(slice.id ?? index),
      jql: slice.jql,
      token: slice.token || null,
      done: Boolean(slice.done),
      keys: Array.isArray(slice.keys) ? slice.keys : null,
      pages: Number(slice.pages) || 0,
      issues: Number(slice.issues) || 0,
      // Restarts have to survive the trip through SQL. A slice restarts at most once per
      // invocation, so a counter that reset each time could never reach its cap -- a slice
      // whose JQL Jira simply will not accept would restart forever, one invocation apiece,
      // and the scan would never finish or fail.
      restarts: Number(slice.restarts) || 0,
      abandoned: Boolean(slice.abandoned),
    }));
  }

  if (!worker?.jqlFilter) return [];
  return [{
    id: 0,
    jql: worker.jqlFilter,
    // No key list on a pre-slice worker row, so a restart cannot delete its own contribution
    // exactly. runSlice checks for this and declines to re-crawl rather than double-counting.
    keys: null,
    token: worker.nextPageToken || null,
    done: false,
    pages: Number(worker.processedPages) || 0,
    issues: Number(worker.processedIssues) || 0,
    // Same shape as a stored slice, so the crawl has one slice type and not two.
    restarts: 0,
    abandoned: false,
  }];
}

// Split one worker's projects into slices of roughly equal issue volume.
//
// The same greedy largest-first bin-pack the coordinator uses to divide projects between
// workers, applied one level down. Balance matters more here than there: slices run
// concurrently inside a single invocation, so the invocation is only as fast as its slowest
// slice, and one slice holding a 200k-issue project while the others idle wastes the
// concurrency this exists to use.
//
// A worker with fewer projects than slices simply gets fewer slices. A single project cannot
// be split -- there is no cursor-safe way to partition one project's issues across queries
// without risking double-counting or gaps -- so a site whose volume sits in one giant project
// is the case this does not help, and it is honest about that rather than pretending.
export function sliceProjectKeys(keys, issueCountByKey, sliceCount) {
  const usable = Math.max(1, Math.min(sliceCount, keys.length));
  const bins = Array.from({ length: usable }, () => ({ keys: [], count: 0 }));
  const sorted = [...keys].sort((a, b) => (issueCountByKey.get(b) ?? 1) - (issueCountByKey.get(a) ?? 1));
  for (const key of sorted) {
    const smallest = bins.reduce((min, b) => (b.count < min.count ? b : min));
    smallest.keys.push(key);
    smallest.count += issueCountByKey.get(key) ?? 1;
  }
  return bins
    .filter((bin) => bin.keys.length > 0)
    .map((bin, id) => ({
      id,
      // Carried alongside the JQL, not parsed back out of it when needed. A restarting slice
      // has to delete exactly what it contributed, and slices own disjoint projects, so the
      // key list IS that contribution.
      keys: bin.keys,
      jql: `project IN (${bin.keys.map((k) => `"${k}"`).join(", ")})`,
      token: null,
      done: false,
      pages: 0,
      issues: 0,
    }));
}

export async function runIssueScanWorkerV2(installationKey, workerId) {
  const tag = `runIssueScanWorker[${workerId}]`;
  // The rate-limit counters are module state, and module state in Forge is per invocation.
  // Reset here so what gets reported below is this chunk's pressure and not a leftover total
  // from whatever else ran in this container -- a field snapshot build, a screen probe.
  resetScanTelemetry();
  let pendingIssues = 0;
  const fieldProjectCounts = new Map();
  // fieldId -> Map<issueTypeId, { count, name }>. The third axis of field usage: which issue
  // types actually carry a value. Same cost as fieldProjectCounts -- an accumulator over data
  // already on every issue (the crawl requests "*all") -- no extra Jira traffic.
  const fieldTypeCounts = new Map();
  // fieldId -> Map<accountId, { count, name }>. The fourth axis: which PEOPLE a user-picker
  // field actually references. Populated only for values that carry an accountId, so it stays
  // empty for every non-user field. Same zero-cost accumulator over data already on the issue.
  const fieldUserCounts = new Map();
  const projectTotals = new Map();
  // One entry per project per month, carrying the exact first and last issue seen in it.
  // Keyed the same way the row is, so a flush is a straight map over the values.
  const projectMonths = new Map();
  // `${statusId}|${projectId}` -> { statusId, statusName, statusCategory, projectId, projectKey, count }
  const statusCounts = new Map();
  const rqtFieldHits = new Map();
  const rqtIssueBuffer = [];
  const rqtValueBuffer = []; // { rqtValue, issueKey }
  const rqtFieldIssueBuffer = []; // { fieldId, issueKey }

  try {
    await ensureProjectStoreReady();

    const meta = await readIssueScanMeta(installationKey);
    if (meta?.state !== "building") {
      console.log(`${tag}: scan state is ${meta?.state || "missing"}, skipping`);
      return;
    }

    let worker = await readIssueScanWorker(installationKey, workerId);
    if (!worker) throw new Error(`Missing worker checkpoint for worker ${workerId}`);
    if (worker.status === "done") {
      console.log(`${tag}: already done`);
      return;
    }
    if (worker.status === "building" && worker.updatedAt) {
      const ageMs = Date.now() - new Date(worker.updatedAt).getTime();
      if (Number.isFinite(ageMs) && ageMs < 2 * 60 * 1000) {
        console.log(`${tag}: worker already active, skipping duplicate event`);
        return;
      }
    }

    if (!worker.jqlFilter) {
      console.log(`${tag}: no projects assigned, marking done`);
      await updateIssueScanWorker(installationKey, workerId, { status: "done", nextPageToken: null, lastError: null });
      const updatedMeta = await atomicAccumulateIssueScanProgress(installationKey, 1, 0).catch(fallbackOn("scan.progress_accumulate_failed", null, { installationKey }));
      if (updatedMeta && updatedMeta.processedPages >= updatedMeta.totalPages && updatedMeta.totalPages > 0) {
        const claimToken = makeJobToken();
        const claimed = await tryClaimIssueScanFinalization(installationKey, claimToken).catch(fallbackOn("scan.finalization_claim_failed", false, { installationKey }));
        if (claimed) await completeIssueScanFinalization(installationKey, tag);
      }
      return;
    }

    await updateIssueScanWorker(installationKey, workerId, { status: "building", lastError: null });

    const scanFields = Array.isArray(worker.fieldIds) && worker.fieldIds.length ? worker.fieldIds : ["*all"];

    // Slices: the concurrency this worker was always allowed and never used.
    //
    // Pagination is inherently sequential -- page N+1 needs the cursor from page N -- so a
    // worker crawling one JQL has exactly ONE request in flight, then sleeps, then does the
    // next. Meanwhile BASE_JIRA_CONCURRENCY permits four. Five workers against a budget sized
    // for twenty is why a measured run sat at ~6.9s per page and ~64 issues/sec site-wide.
    //
    // Each worker already owns a bin-packed set of DISJOINT projects, so splitting them into
    // independent JQL slices needs no coordination: separate queries, separate cursors, no
    // overlap to de-duplicate. Running them concurrently within the one invocation multiplies
    // throughput without adding a single Forge invocation, which is the point -- more workers
    // would buy the same parallelism while multiplying invocations, and each invocation gets
    // its OWN in-memory limiter, so N of them cannot coordinate a backoff between themselves.
    // Concentrating the concurrency under one limiter is what keeps 429 handling coherent.
    const slices = normalizeWorkerSlices(worker);

    let pageCount = 0;
    let issueCount = 0;
    let cancelled = false;

    // Buffers are drained on a serialized chain rather than whenever a slice feels like it.
    //
    // Two slices flushing at once would race the clear() against each other's writes. The
    // snapshot-and-clear below happens synchronously before any await, so pages accumulating
    // during a flush land in the fresh maps and are not lost with the old ones -- which is the
    // bug the obvious version of this has.
    let pagesSinceFlush = 0;
    let flushChain = Promise.resolve();

    async function drainBuffers() {
      const counts = new Map(fieldProjectCounts);
      const typeCounts = new Map(fieldTypeCounts);
      const userCounts = new Map(fieldUserCounts);
      const totals = new Map(projectTotals);
      const months = new Map(projectMonths);
      const statuses = new Map(statusCounts);
      const rqtHits = new Map(rqtFieldHits);
      const rqtIssues = rqtIssueBuffer.splice(0);
      const rqtValues = rqtValueBuffer.splice(0);
      const rqtFieldIssues = rqtFieldIssueBuffer.splice(0);
      fieldProjectCounts.clear();
      fieldTypeCounts.clear();
      fieldUserCounts.clear();
      projectTotals.clear();
      projectMonths.clear();
      statusCounts.clear();
      rqtFieldHits.clear();

      if (counts.size > 0 || totals.size > 0) {
        await flushIssueScanCounts(installationKey, counts, totals).catch(ignoreWith("scan.count_flush_failed", { workerId }));
        await flushIssueScanActivity(installationKey, months).catch(ignoreWith("scan.activity_flush_failed", { workerId }));
      }
      if (userCounts.size > 0) {
        await flushIssueScanFieldUserCounts(installationKey, userCounts).catch(ignoreWith("scan.field_user_flush_failed", { workerId }));
      }
      if (typeCounts.size > 0) {
        await flushIssueScanTypeCounts(installationKey, typeCounts).catch(ignoreWith("scan.type_flush_failed", { workerId }));
      }
      if (statuses.size > 0) {
        await flushIssueScanStatusCounts(installationKey, statuses).catch(ignoreWith("scan.status_flush_failed", { workerId }));
      }
      if (rqtHits.size > 0) await upsertRqtFieldHits(installationKey, rqtHits).catch(ignoreWith("scan.rqt_field_flush_failed", { workerId }));
      if (rqtIssues.length > 0) await upsertRqtIssueKeys(installationKey, rqtIssues).catch(ignoreWith("scan.rqt_issue_flush_failed", { workerId }));
      if (rqtValues.length > 0) await upsertRqtValueIssueKeys(installationKey, rqtValues).catch(ignoreWith("scan.rqt_value_flush_failed", { workerId }));
      if (rqtFieldIssues.length > 0) await upsertRqtFieldIssueKeys(installationKey, rqtFieldIssues).catch(ignoreWith("scan.rqt_field_issue_flush_failed", { workerId }));
    }

    // Bounds memory. Slices run in parallel, so an invocation now processes
    // ISSUE_SCAN_SLICES_PER_WORKER x ISSUE_SCAN_CHUNK_PAGES pages in the wall-clock time one
    // slice used to take. Without a mid-chunk drain that is the same multiple of buffered
    // rows held at once.
    function maybeFlush() {
      if (pagesSinceFlush < ISSUE_SCAN_FLUSH_EVERY_PAGES) return flushChain;
      pagesSinceFlush = 0;
      flushChain = flushChain.then(drainBuffers);
      return flushChain;
    }

    async function runSlice(slice) {
      for (let page = 0; page < ISSUE_SCAN_CHUNK_PAGES; page++) {
        if (cancelled || slice.done) return;

        if (page > 0 && page % ISSUE_SCAN_CANCEL_CHECK_EVERY_PAGES === 0) {
          const cancelCheck = await readIssueScanMeta(installationKey);
          if (cancelCheck?.state === "cancelled") {
            console.log(`${tag}: scan cancelled`);
            cancelled = true;
            return;
          }
        }

        const reqBody = {
          jql: slice.jql,
          maxResults: ISSUE_SCAN_PAGE_SIZE,
          fields: scanFields,
          fieldsByKeys: false,
        };
        if (slice.token) reqBody.nextPageToken = slice.token;

        let data;
        try {
          data = await jiraRequest(route`/rest/api/3/search/jql`, {
            method: "POST",
            body: JSON.stringify(reqBody),
          });
        } catch (searchErr) {
          const errStr = String(searchErr?.message || searchErr || "");
          const is400 = errStr.includes("400") || searchErr?.statusCode === 400 || searchErr?.status === 400;

          // A 400 restarts this slice. It does not kill the worker, and it certainly does
          // not kill the scan.
          //
          // Previously only a 400 WITH a cursor was treated as recoverable, on the theory that
          // it meant an expired page token. A 400 without one fell through to the rethrow
          // below, which failed the worker, which marked the entire scan failed -- so a single
          // refused request threw away a crawl of 150,000 issues that was otherwise working.
          // That is what has been happening on this site, repeatedly.
          //
          // Whatever the cause, the right response is the same: this slice restarts from its
          // first page and the other slices, and the other four workers, carry on. Re-crawled
          // pages are absorbed by the flush upserts, which are keyed by project and field.
          if (is400) {
            slice.restarts = Number(slice.restarts || 0) + 1;

            logger.error("scan.search_rejected", {
              installationKey,
              workerId,
              sliceId: slice.id,
              hadCursor: Boolean(slice.token),
              restarts: slice.restarts,
              jqlLength: String(slice.jql || "").length,
              jqlPreview: String(slice.jql || "").slice(0, 300),
              fieldCount: Array.isArray(scanFields) ? scanFields.length : null,
              error: errStr.slice(0, 500),
            });

            if (slice.restarts > MAX_SLICE_RESTARTS) {
              // Restarting is not working. Give up on this slice alone rather than looping on
              // it forever -- the projects it covers go uncounted, and the scan says so, which
              // is a better outcome than a scan that never finishes.
              slice.done = true;
              slice.abandoned = true;
              await appendIssueScanLogEntry(
                installationKey,
                `Worker ${workerId} slice ${slice.id}: abandoned after ${slice.restarts} failed restarts — its projects are not counted in this scan`
              ).catch(ignoreWith("scan.log_append_failed", { workerId }));
              return;
            }

            // Re-crawling double-counts unless what this slice already contributed is
            // removed first. The count flush is additive --
            // `issue_count = issue_count + VALUES(issue_count)` -- so a page counted twice is
            // counted twice, and the result is a project reporting more field values per issue
            // than it has fields. Slices own disjoint projects, so deleting the buffer rows
            // for this slice's keys removes exactly its contribution and nobody else's.
            //
            // Without a key list -- a worker row written before slices existed -- that
            // subtraction cannot be made exact, so the slice stops here instead. Losing the
            // rest of one slice's coverage is recoverable and visible. Silently inflated
            // counts are neither.
            if (!Array.isArray(slice.keys) || slice.keys.length === 0) {
              slice.done = true;
              slice.abandoned = true;
              await appendIssueScanLogEntry(
                installationKey,
                `Worker ${workerId}: search rejected (400) and this worker predates per-slice tracking, so it cannot restart without double-counting — stopping it instead. Start a fresh scan to recrawl these projects.`
              ).catch(ignoreWith("scan.log_append_failed", { workerId }));
              return;
            }

            await clearIssueScanBufferForProjects(installationKey, slice.keys)
              .catch(ignoreWith("scan.buffer_clear_failed", { workerId, sliceId: slice.id }));

            await appendIssueScanLogEntry(
              installationKey,
              `Worker ${workerId} slice ${slice.id}: search rejected (400)${slice.token ? ", page token likely expired" : ""} — cleared its counts and restarting from page 1 (attempt ${slice.restarts})`
            ).catch(ignoreWith("scan.log_append_failed", { workerId }));
            slice.token = null;
            slice.pages = 0;
            slice.issues = 0;
            return;
          }
          throw searchErr;
        }

        const issues = data?.issues || [];
        const newNextPageToken = data?.nextPageToken || null;

      for (const issue of issues) {
        const projectId = String(issue.fields?.project?.id || "");
        if (!projectId) continue;
        const projectKey_ = String(issue.fields?.project?.key || "");
        const projectName = String(issue.fields?.project?.name || projectKey_);

        const projEntry = projectTotals.get(projectId) || { count: 0, key: projectKey_, name: projectName };
        projEntry.count++;
        projectTotals.set(projectId, projEntry);

        // When the work happened, which is the whole basis of an adoption rate. Skipped
        // rather than defaulted when Jira did not return it: a scan built before this field
        // was requested has no dates, and a project dated "today" because the value was
        // missing would read as brand new and wildly under-adopted.
        const created = issue.fields?.created;
        if (typeof created === "string" && created.length >= 7) {
          const month = created.slice(0, 7);
          const monthKey = `${projectId}|${month}`;
          const monthEntry = projectMonths.get(monthKey)
            || { projectId, month, count: 0, first: created, last: created };
          monthEntry.count++;
          if (created < monthEntry.first) monthEntry.first = created;
          if (created > monthEntry.last) monthEntry.last = created;
          projectMonths.set(monthKey, monthEntry);
        }

        // Status is already on every issue -- a universe scan requests "*all" -- so
        // counting it here costs no extra Jira traffic, only an accumulator. Keyed by
        // status AND project so a scheme's balance can later be weighted by real issue
        // volume rather than by how many statuses someone defined.
        const status = issue.fields?.status;
        const statusId = status?.id ? String(status.id) : "";
        if (statusId) {
          const statusKey = `${statusId}|${projectId}`;
          const statusEntry = statusCounts.get(statusKey) || {
            statusId,
            statusName: status?.name || null,
            statusCategory: status?.statusCategory?.name || status?.statusCategory?.key || null,
            projectId,
            projectKey: projectKey_,
            count: 0,
          };
          statusEntry.count++;
          statusCounts.set(statusKey, statusEntry);
        }

        const issueType = issue.fields?.issuetype;
        const issueTypeId = issueType?.id ? String(issueType.id) : "";
        const issueTypeName = issueType?.name || issueTypeId;

        for (const [fieldId, value] of Object.entries(issue.fields || {})) {
          if (STRUCTURAL_SYSTEM_FIELDS.has(fieldId)) continue;
          if (!isFieldValueNonEmpty(value)) continue;
          let byProject = fieldProjectCounts.get(fieldId);
          if (!byProject) {
            byProject = new Map();
            fieldProjectCounts.set(fieldId, byProject);
          }
          const entry = byProject.get(projectId) || { count: 0, key: projectKey_, name: projectName };
          entry.count++;
          byProject.set(projectId, entry);

          // Same value, second axis: which issue type is carrying it.
          if (issueTypeId) {
            let byType = fieldTypeCounts.get(fieldId);
            if (!byType) {
              byType = new Map();
              fieldTypeCounts.set(fieldId, byType);
            }
            const typeEntry = byType.get(issueTypeId) || { count: 0, name: issueTypeName };
            typeEntry.count++;
            byType.set(issueTypeId, typeEntry);
          }

          // Fourth axis: if the value is a user (or list of users), which people. Nothing is
          // tallied for a non-user value, so this Map only ever contains user-picker fields.
          const accounts = accountsInValue(value);
          if (accounts.length) {
            let byAccount = fieldUserCounts.get(fieldId);
            if (!byAccount) {
              byAccount = new Map();
              fieldUserCounts.set(fieldId, byAccount);
            }
            for (const { accountId, displayName } of accounts) {
              const acctEntry = byAccount.get(accountId) || { count: 0, name: displayName || null };
              acctEntry.count++;
              if (!acctEntry.name && displayName) acctEntry.name = displayName;
              byAccount.set(accountId, acctEntry);
            }
          }
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
            projectKey: projectKey_,
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

        pageCount++;
        issueCount += issues.length;
        pendingIssues += issues.length;
        slice.pages = Number(slice.pages || 0) + 1;
        slice.issues = Number(slice.issues || 0) + issues.length;
        slice.token = newNextPageToken;
        pagesSinceFlush++;
        await maybeFlush();

        if (!newNextPageToken || issues.length === 0) {
          slice.done = true;
          return;
        }
        await sleep(ISSUE_SCAN_INTER_PAGE_DELAY_MS);
      }
    }

    await Promise.all(slices.filter((slice) => !slice.done).map(runSlice));
    // Any drain still queued has to land before the checkpoint below, or the worker would
    // record progress for rows that are still only in memory.
    await flushChain;

    if (cancelled) return;


    // One drain, same code path as the mid-chunk ones. This used to be a second, hand-rolled
    // copy of the same eight flushes, which is how the two drifted -- the mid-chunk version
    // never flushed statusCounts.
    await drainBuffers();

    const processedIssues = Number(worker.processedIssues || 0) + issueCount;
    const processedPages = Number(worker.processedPages || 0) + pageCount;

    // Surfaced rather than merely collected.
    //
    // getScanTelemetry() existed, and scan-engine imported it and never called it -- so the
    // 429 count was measured on every request and shown to nobody for the one scan most
    // likely to provoke it. Slices make that number the deciding input for
    // ISSUE_SCAN_SLICES_PER_WORKER, so it goes where an admin already looks.
    //
    // Per invocation and labelled as such. There is no counter shared across workers, and
    // presenting one chunk's number as a scan-wide total would be worse than not showing it.
    const { rl429Count, rlRetryCount } = getScanTelemetry();
    await appendIssueScanLogEntry(
      installationKey,
      `Worker ${workerId}: +${issueCount.toLocaleString()} issues over ${pageCount} ${pageCount === 1 ? "page" : "pages"}` +
      ` across ${slices.length} ${slices.length === 1 ? "slice" : "slices"}` +
      ` — this chunk: ${rl429Count} rate-limited, ${rlRetryCount} retried` +
      ` (${processedIssues.toLocaleString()} total for this worker)`
    ).catch(ignoreWith("scan.log_append_failed", { workerId }));
    // Done only when every slice is done. A worker with one slice still holding a cursor has
    // more of its own projects to crawl, however finished the others are.
    const isDone = slices.every((slice) => slice.done);
    await updateIssueScanWorker(installationKey, workerId, {
      status: isDone ? "done" : "queued",
      slices,
      // Kept in step with slice 0 purely so anything still reading the old single-cursor
      // column sees something coherent. The slices array is the real state.
      nextPageToken: slices[0]?.token || null,
      processedIssues,
      processedPages,
      lastError: null,
    });

    const updatedMeta = await atomicAccumulateIssueScanProgress(installationKey, isDone ? 1 : 0, pendingIssues);
    pendingIssues = 0;

    if (!isDone) {
      // Stagger the re-queue by a few seconds, keyed off the worker id plus jitter. Four
      // workers checkpointing every ~10 pages otherwise re-queue in the same instant, and
      // that lockstep burst is what trips the installation's queue limit.
      await queueIssueScanWorker(installationKey, workerId, {
        delaySeconds: 2 + workerId * 2 + Math.floor(Math.random() * 6),
      });
      console.log(`${tag}: checkpointed - ${processedIssues} issues, ${processedPages} pages; requeued`);
      return;
    }

    console.log(`${tag}: done - ${processedIssues} issues, ${processedPages} pages`);
    if ((updatedMeta?.processedPages ?? 0) >= (updatedMeta?.totalPages ?? 0) && (updatedMeta?.totalPages ?? 0) > 0) {
      const claimToken = makeJobToken();
      const claimed = await tryClaimIssueScanFinalization(installationKey, claimToken);
      if (claimed) await completeIssueScanFinalization(installationKey, tag);
    }
  } catch (error) {
    // One worker failing fails ONE WORKER.
    //
    // This used to write state:"failed" onto the scan itself, so a single refused request in
    // one of five workers threw away everything the other four had crawled -- and the run
    // showed as failed even though 120,000 of 150,000 issues had been counted and stored.
    // The failure was real; making it fatal to the whole scan was the defect.
    //
    // The worker's slot is still counted as finished, because finalization fires when every
    // slot reports in. Without that, four healthy workers would sit at "building" forever
    // waiting on a fifth that is never coming back.
    const errMsg = error?.message || String(error);
    console.error(`${tag} failed:`, errMsg);

    // A Forge queue limit that outlasted every re-queue retry is a PAUSE, not a failure.
    // The worker's slices and cursors are already checkpointed, so leave its slot OPEN --
    // do NOT accumulate it (that is what keeps finalization waiting) and mark it "queued"
    // so reviveStalledIssueScanWorkers re-queues it from a fresh chain once the ceiling
    // clears. Finalizing here would drop this worker's projects and still mark the run
    // clean. The full scan's issues poll keeps waiting; its 4-hour frozen-signature guard
    // is the backstop if the limit never clears.
    if (error?.isQueueBackpressureExhausted) {
      await updateIssueScanWorker(installationKey, workerId, {
        status: "queued",
        lastError: `${WORKER_PAUSED_MARKER}; resuming automatically once platform limits clear.`,
      }).catch(ignoreWith("scan.worker_pause_write_failed", { workerId }));
      await appendIssueScanLogEntry(
        installationKey,
        `Worker ${workerId} paused: the Forge async-queue limit held through every retry. Its progress is saved and it resumes automatically once the limit clears — no issues are lost.`
      ).catch(ignoreWith("scan.log_append_failed", { workerId }));
      await writeIssueScanMeta(installationKey, {
        lastError: `Worker ${workerId} paused on a Forge queue limit — resuming automatically.`,
      }).catch(ignoreWith("scan.worker_pause_meta_write_failed", { workerId }));
      logger.warn("scan.worker_paused_backpressure", { installationKey, workerId });
      return;
    }

    // A different error, or a queue-limit that we are choosing to stop retrying: close the
    // slot so the other workers are not held at "building" forever waiting on a fifth that
    // is not coming back. The projects keep last scan's numbers (the partial-coverage gate
    // in completeIssueScanFinalization), so nothing is corrupted. A Jira 400 (bad JQL,
    // expired page token) is handled inside runSlice and never reaches here.
    const backpressure = isQueuePushRejection(error);
    const workerNote = backpressure
      ? `Worker ${workerId} stopped: the Forge async-queue limit for this installation held through every retry. Its projects keep their previous counts — re-run the scan once platform limits reset.`
      : `Worker ${workerId} failed - ${errMsg}. The other workers continue; this worker's projects may be incompletely counted.`;

    await updateIssueScanWorker(installationKey, workerId, { status: "failed", lastError: backpressure ? "Forge queue limit persisted through retries" : errMsg })
      .catch(ignoreWith("scan.worker_failure_write_failed", { workerId }));
    await appendIssueScanLogEntry(installationKey, workerNote)
      .catch(ignoreWith("scan.log_append_failed", { workerId }));

    const updatedMeta = await atomicAccumulateIssueScanProgress(installationKey, 1, 0)
      .catch(fallbackOn("scan.progress_accumulate_failed", null, { installationKey }));

    // Record which worker fell over, without declaring the run dead. The scan finishes and
    // reports partial coverage, which an admin can act on -- "failed" with no data cannot be.
    await writeIssueScanMeta(installationKey, {
      lastError: backpressure
        ? `Worker ${workerId} stopped on a Forge queue limit — re-run the scan to finish its projects.`
        : `Worker ${workerId} failed - ${errMsg}`,
    }).catch(ignoreWith("scan.worker_failure_meta_write_failed", { workerId }));

    if ((updatedMeta?.processedPages ?? 0) >= (updatedMeta?.totalPages ?? 0) && (updatedMeta?.totalPages ?? 0) > 0) {
      const claimToken = makeJobToken();
      const claimed = await tryClaimIssueScanFinalization(installationKey, claimToken)
        .catch(fallbackOn("scan.finalization_claim_failed", false, { installationKey }));
      if (claimed) await completeIssueScanFinalization(installationKey, tag);
    }
  }
}
