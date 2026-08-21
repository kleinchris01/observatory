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

    // Build one JQL filter per worker covering all its assigned projects
    const workerJqls = bins.map((bin) =>
      bin.keys.length === 0 ? null : `project IN (${bin.keys.map((k) => `"${k}"`).join(", ")})`
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

export async function runIssueScanWorkerV2(installationKey, workerId) {
  const tag = `runIssueScanWorker[${workerId}]`;
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
    let currentNextPageToken = worker.nextPageToken || null;
    let pageCount = 0;
    let issueCount = 0;

    for (let page = 0; page < ISSUE_SCAN_CHUNK_PAGES; page++) {
      // With ISSUE_SCAN_FLUSH_EVERY_PAGES >= ISSUE_SCAN_CHUNK_PAGES this never fires and
      // the single end-of-chunk flush below does the work. Kept rather than deleted so
      // lowering the constant restores mid-chunk flushing without a code change.
      if (page > 0 && page % ISSUE_SCAN_FLUSH_EVERY_PAGES === 0) {
        if (fieldProjectCounts.size > 0 || projectTotals.size > 0) {
          await flushIssueScanCounts(installationKey, fieldProjectCounts, projectTotals);
          await flushIssueScanActivity(installationKey, projectMonths);
          projectMonths.clear();
          fieldProjectCounts.clear();
          projectTotals.clear();
        }
        if (rqtFieldHits.size > 0) {
          await upsertRqtFieldHits(installationKey, rqtFieldHits).catch(ignoreWith("scan.rqt_field_flush_failed", { installationKey }));
          rqtFieldHits.clear();
        }
        if (pendingIssues > 0) {
          const updMid = await atomicAccumulateIssueScanProgress(installationKey, 0, pendingIssues).catch(fallbackOn("scan.progress_accumulate_failed", null, { installationKey }));
          if (updMid) {
            const cur = updMid.processedIssues ?? 0;
            const prev = cur - pendingIssues;
            if (Math.floor(prev / 5000) < Math.floor(cur / 5000)) {
              await appendIssueScanLogEntry(installationKey, `${cur.toLocaleString()} issues scanned`).catch(ignoreWith("scan.log_append_failed", { installationKey }));
            }
          }
          worker = await updateIssueScanWorker(installationKey, workerId, {
            status: "building",
            nextPageToken: currentNextPageToken,
            processedIssues: Number(worker.processedIssues || 0) + issueCount,
            processedPages: Number(worker.processedPages || 0) + pageCount,
            lastError: null,
          }) || worker;
          issueCount = 0;
          pageCount = 0;
          pendingIssues = 0;
        }
      }

      if (page > 0 && page % ISSUE_SCAN_CANCEL_CHECK_EVERY_PAGES === 0) {
        const cancelCheck = await readIssueScanMeta(installationKey);
        if (cancelCheck?.state === "cancelled") {
          console.log(`${tag}: scan cancelled`);
          return;
        }
      }

      const reqBody = {
        jql: worker.jqlFilter,
        maxResults: ISSUE_SCAN_PAGE_SIZE,
        fields: scanFields,
        fieldsByKeys: false,
      };
      if (currentNextPageToken) reqBody.nextPageToken = currentNextPageToken;

      let data;
      try {
        data = await jiraRequest(route`/rest/api/3/search/jql`, {
          method: "POST",
          body: JSON.stringify(reqBody),
        });
      } catch (searchErr) {
        const errStr = String(searchErr?.message || searchErr || "");
        const is400 = errStr.includes("400") || searchErr?.statusCode === 400 || searchErr?.status === 400;
        if (is400 && currentNextPageToken) {
          // Cursor token expired — flush buffered data and restart this worker from the beginning
          console.warn(`${tag}: 400 on paginated search — nextPageToken likely expired; flushing and restarting worker`);
          await appendIssueScanLogEntry(installationKey, `Worker ${workerId}: page token expired (400), restarting from page 1`).catch(ignoreWith("scan.log_append_failed", { workerId }));
          if (fieldProjectCounts.size > 0 || projectTotals.size > 0) {
            await flushIssueScanCounts(installationKey, fieldProjectCounts, projectTotals).catch(ignoreWith("scan.count_flush_failed_on_token_reset", { workerId }));
            await flushIssueScanActivity(installationKey, projectMonths).catch(ignoreWith("scan.activity_flush_failed_on_token_reset", { workerId }));
            fieldProjectCounts.clear(); projectTotals.clear(); projectMonths.clear();
          }
          if (rqtFieldHits.size > 0) { await upsertRqtFieldHits(installationKey, rqtFieldHits).catch(ignoreWith("scan.rqt_field_flush_failed", { workerId })); rqtFieldHits.clear(); }
          if (rqtIssueBuffer.length > 0) { await upsertRqtIssueKeys(installationKey, rqtIssueBuffer).catch(ignoreWith("scan.rqt_issue_flush_failed", { workerId })); rqtIssueBuffer.length = 0; }
          if (rqtValueBuffer.length > 0) { await upsertRqtValueIssueKeys(installationKey, rqtValueBuffer).catch(ignoreWith("scan.rqt_value_flush_failed", { workerId })); rqtValueBuffer.length = 0; }
          if (rqtFieldIssueBuffer.length > 0) { await upsertRqtFieldIssueKeys(installationKey, rqtFieldIssueBuffer).catch(ignoreWith("scan.rqt_field_issue_flush_failed", { workerId })); rqtFieldIssueBuffer.length = 0; }
          await updateIssueScanWorker(installationKey, workerId, {
            status: "queued", nextPageToken: null, lastError: "Page token expired; restarting from beginning",
          }).catch(ignoreWith("scan.token_reset_write_failed", { workerId }));
          await queueIssueScanWorker(installationKey, workerId);
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
      currentNextPageToken = newNextPageToken;
      if (!newNextPageToken || issues.length === 0) break;
      await sleep(ISSUE_SCAN_INTER_PAGE_DELAY_MS);
    }

    if (fieldProjectCounts.size > 0 || projectTotals.size > 0) {
      await flushIssueScanCounts(installationKey, fieldProjectCounts, projectTotals);
    }
    if (statusCounts.size > 0) {
      // Best-effort, like the RQT flushes below: per-status counts power the insights
      // view, and losing them must never fail a scan whose primary output is field usage.
      await flushIssueScanStatusCounts(installationKey, statusCounts).catch((e) => {
        console.error(`${tag}: status count flush error`, e?.message || e);
      });
      statusCounts.clear();
    }
    if (rqtFieldHits.size > 0) {
      await upsertRqtFieldHits(installationKey, rqtFieldHits).catch((e) => {
        console.error(`${tag}: RQT flush error`, e?.message || e);
      });
    }
    if (rqtIssueBuffer.length > 0) {
      await upsertRqtIssueKeys(installationKey, rqtIssueBuffer).catch((e) => {
        console.error(`${tag}: RQT issue key flush error`, e?.message || e);
      });
    }
    if (rqtValueBuffer.length > 0) {
      await upsertRqtValueIssueKeys(installationKey, rqtValueBuffer).catch((e) => {
        console.error(`${tag}: RQT value index flush error`, e?.message || e);
      });
    }
    if (rqtFieldIssueBuffer.length > 0) {
      await upsertRqtFieldIssueKeys(installationKey, rqtFieldIssueBuffer).catch((e) => {
        console.error(`RQT field issue index flush error`, e?.message || e);
      });
    }

    const processedIssues = Number(worker.processedIssues || 0) + issueCount;
    const processedPages = Number(worker.processedPages || 0) + pageCount;
    const isDone = !currentNextPageToken;
    await updateIssueScanWorker(installationKey, workerId, {
      status: isDone ? "done" : "queued",
      nextPageToken: currentNextPageToken,
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
