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
  replaceIssueScanWorkers,
  readIssueScanWorker,
  updateIssueScanWorker,
  replaceFieldOptionsCache,
  flushIssueScanCounts,
  flushIssueScanActivity,
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

const ISSUE_SCAN_CHUNK_PAGES = 10;
const ISSUE_SCAN_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
const ISSUE_COUNT_TIMEOUT_MS = 8000;

export function isJiraRateLimitError(error) {
  return Number(error?.status) === 429;
}

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

export async function queueIssueScanWorker(installationKey, workerId) {
  await inventorySnapshotQueue.push({
    body: { jobType: "run-issue-scan-worker", installationKey, workerId },
  });
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

    const snapshotMeta = await readSnapshotMeta(installationKey);
    if (snapshotMeta?.version) {
      // Only trust the crawl's totals as authoritative (and zero out fields it never saw)
      // when every worker actually finished — a field absent from a partial crawl's buffer
      // is "not yet crawled," not "confirmed zero," and treating it as the latter would
      // erase good data from a previous run.
      const workers = await Promise.all(
        Array.from({ length: ISSUE_SCAN_WORKERS }, (_, workerId) =>
          readIssueScanWorker(installationKey, workerId).catch(fallbackOn("scan.worker_read_failed", null, { workerId })))
      );
      const scanCoverageComplete = workers.every((worker) => !worker || worker.status === "done");

      const promoted = await promoteIssueScanToSnapshotProjectUsage(installationKey, snapshotMeta.version, { syncTotalIssueCount: scanCoverageComplete });
      console.log(`${tag}: promoted ${promoted.fieldsPromoted} fields (${promoted.rowsInserted} rows)${scanCoverageComplete ? ", totals synced" : ""}`);

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
      { t: completionTimestamp, msg: `Scan complete - ${(finalMeta?.processedIssues || 0).toLocaleString()} issues` },
    ];
    const prevScanHistory = (finalMeta?.scanHistory || []).slice(-14);
    await writeIssueScanMeta(installationKey, {
      state: "ready",
      completedAt: completionTimestamp,
      nextPageToken: null,
      nextStartAt: 0,
      lastError: workerError,
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
      await queueIssueScanWorker(installationKey, i);
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
      pages: Number(slice.pages) || 0,
      issues: Number(slice.issues) || 0,
    }));
  }

  if (!worker?.jqlFilter) return [];
  return [{
    id: 0,
    jql: worker.jqlFilter,
    token: worker.nextPageToken || null,
    done: false,
    pages: Number(worker.processedPages) || 0,
    issues: Number(worker.processedIssues) || 0,
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
      const totals = new Map(projectTotals);
      const months = new Map(projectMonths);
      const statuses = new Map(statusCounts);
      const rqtHits = new Map(rqtFieldHits);
      const rqtIssues = rqtIssueBuffer.splice(0);
      const rqtValues = rqtValueBuffer.splice(0);
      const rqtFieldIssues = rqtFieldIssueBuffer.splice(0);
      fieldProjectCounts.clear();
      projectTotals.clear();
      projectMonths.clear();
      statusCounts.clear();
      rqtFieldHits.clear();

      if (counts.size > 0 || totals.size > 0) {
        await flushIssueScanCounts(installationKey, counts, totals).catch(ignoreWith("scan.count_flush_failed", { workerId }));
        await flushIssueScanActivity(installationKey, months).catch(ignoreWith("scan.activity_flush_failed", { workerId }));
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

          // A 400 with no cursor is not an expired token, so it falls through to the rethrow
          // below and kills the worker -- and with it the whole scan. It has happened on this
          // site repeatedly and was never diagnosable, because the only thing recorded was
          // "400 Bad Request": no JQL, no field count, no indication of which of the two
          // things a search can be rejected for was at fault. Record the shape of the request
          // that was refused, so the next occurrence is a question with an answer.
          if (is400 && !slice.token) {
            logger.error("scan.search_rejected_on_first_page", {
              installationKey,
              workerId,
              sliceId: slice.id,
              jqlLength: String(slice.jql || "").length,
              jqlPreview: String(slice.jql || "").slice(0, 300),
              fieldCount: Array.isArray(scanFields) ? scanFields.length : null,
              error: errStr.slice(0, 500),
            });
          }

          if (is400 && slice.token) {
            // Cursor expired. Restart THIS slice only -- the others hold their own valid
            // cursors and there is no reason to make them re-crawl. Buffered rows are keyed by
            // project and re-counted on the retry, which the flush upserts absorb.
            console.warn(`${tag}: 400 on paginated search for slice ${slice.id} — token expired; restarting that slice`);
            await appendIssueScanLogEntry(
              installationKey,
              `Worker ${workerId} slice ${slice.id}: page token expired (400), restarting that slice from page 1`
            ).catch(ignoreWith("scan.log_append_failed", { workerId }));
            slice.token = null;
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
      await queueIssueScanWorker(installationKey, workerId);
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
    const errMsg = error?.message || String(error);
    console.error(`${tag} failed:`, errMsg);
    await updateIssueScanWorker(installationKey, workerId, { status: "failed", lastError: errMsg }).catch(ignoreWith("scan.worker_failure_write_failed", { workerId }));
    await appendIssueScanLogEntry(installationKey, `Worker ${workerId} failed - ${errMsg}`).catch(ignoreWith("scan.log_append_failed", { workerId }));
    await writeIssueScanMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      nextPageToken: null,
      nextStartAt: 0,
      lastError: `Worker ${workerId} failed - ${errMsg}`,
    }).catch(ignoreWith("scan.worker_failure_meta_write_failed", { workerId }));
  }
}
