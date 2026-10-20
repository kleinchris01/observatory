import { inventorySnapshotQueue } from "./queues.js";
import { logger, fallbackOn, ignoreWith, errorContext } from "./logger.js";
import {
  incrMetric,
  METRIC_NAMES,
  makeJobToken,
  setSnapshotLogger,
  sleep,
  mapWithConcurrency,
  getFieldTotalIssueCount,
  getFieldConfiguredProjectCount,
  getAllCustomFields,
  getAllSystemFields,
  getProjectBreakdownByIssueScan,
  searchProjectFieldUsage,
  SNAPSHOT_CONCURRENCY,
  SNAPSHOT_PROGRESS_FLUSH_INTERVAL_MS,
  SNAPSHOT_DB_BATCH_SIZE,
  FIELD_SUMMARY_QUEUE_STALE_AFTER_MS,
  FIELD_SUMMARY_BUILD_STALE_AFTER_MS,
  PROJECT_USAGE_ISSUE_SCAN_PAGE_SIZE,
  PROJECT_USAGE_SCAN_PAGES_PER_JOB,
  resetJiraRateLimiterState,
  resetScanTelemetry,
  getScanTelemetry,
} from "./jira-api.js";
import {
  ensureProjectStoreReady,
  readSnapshotMeta,
  writeSnapshotMeta,
  clearSnapshotVersion,
  clearOtherSnapshotVersions,
  appendSnapshotFields,
  replaceSnapshotProjectUsageForField,
  loadSnapshotField,
  loadSnapshotFields,
  loadFieldSummary,
  replaceFieldSummary,
  getSnapshotProcessedFieldIds,
  carryForwardSnapshotProjectUsage,
  fillSnapshotProjectUsageFromSummaries,
  pruneOldSnapshotVersions,
  updateSnapshotFieldMetadata,
  updateSnapshotFieldFindings,
  loadFieldLastChangeMap,
  loadArchivedFieldUsage,
  syncActiveProjectCountsFromUsage,
  readFullScanMeta,
} from "./project-store.js";
import {
  USAGE_STATUS_READY,
  USAGE_STATUS_UNAVAILABLE,
  mergeProjectUsageCounts,
  normalizeFieldName,
  buildGovernanceFindings,
  buildInventoryRecord,
  isJiraBuiltinField,
  isPlatformProvidedField,
  buildDuplicateNameCountMap,
} from "./analysis.js";
import { buildOverallFieldJql, getFieldNumericId, getFieldTypeLabel } from "./transform.js";

// ----- hydrateFieldForGovernance -----

// Newest per-project field-change timestamp across a summary's active projects — the
// field-level "last touched" signal the staleness rule keys off. Mirrors what
// loadFieldLastChangeMap does in SQL, for the detail path where projects are already loaded.
export function latestChangeAcrossProjects(activeProjects) {
  let newest = null;
  for (const project of Array.isArray(activeProjects) ? activeProjects : []) {
    const at = project?.latestFieldChangeAt;
    if (!at) continue;
    const ts = new Date(at).getTime();
    if (!Number.isFinite(ts)) continue;
    if (newest === null || ts > newest.ts) newest = { ts, at: String(at) };
  }
  return newest?.at ?? null;
}

export function hydrateFieldForGovernance(field, summary, duplicateNameCount = 1, thresholds = {}) {
  const activeProjectCount = Number(summary?.activeProjectCount ?? field?.activeProjectCount ?? 0);
  const totalIssueCount = Number(summary?.totalIssueCount ?? field?.totalIssueCount ?? 0);
  const configuredProjectCount = Number(
    field?.configuredProjectCount ?? field?.usageCount ?? summary?.configuredProjectCount ?? 0,
  );
  const usageStatus = field?.usageStatus ?? USAGE_STATUS_READY;
  const usageStatusDetail = field?.usageStatusDetail || null;

  const isSystemField = !String(field.id || "").startsWith("customfield_");
  const platformProvided = isPlatformProvidedField(field);
  const contexts = Array.isArray(summary?.contexts) ? summary.contexts : [];
  const contextCount = contexts.length;
  const hasGlobalContext = Boolean(summary?.hasGlobalContext || contexts.some((c) => c.isGlobal));
  return {
    ...field,
    configuredProjectCount,
    usageCount: configuredProjectCount,
    activeProjectCount,
    totalIssueCount,
    isJiraBuiltin: isJiraBuiltinField(field),
    isSystemField,
    findings: buildGovernanceFindings(
      field,
      {
        configuredProjectCount,
        totalIssueCount,
        activeProjectCount,
        duplicateNameCount,
        usageStatus,
        usageStatusDetail,
        isSystemField,
        isPlatformProvidedField: platformProvided,
        contextCount,
        hasGlobalContext,
        lastFieldChangeAt: latestChangeAcrossProjects(summary?.activeProjects),
        // Loaded with the field (loadSnapshotFields). Without it every re-hydration -- Overview,
        // health, reports, remediation -- undid the archived-projects fix and flagged fields
        // whose only data is in archived projects as unused.
        archivedIssueCount: field?.archivedIssueCount ?? 0,
      },
      thresholds,
    ),
  };
}

// Every snapshot field hydrated for governance against the given thresholds, each knowing how
// many fields share its normalised name. The one computation the Overview's field counts and
// the remediation field epics both come from, so an epic's task count matches its card.
export function hydrateFieldsForGovernance(fields, thresholds = {}) {
  const dup = buildDuplicateNameCountMap(fields);
  return fields.map((f) => hydrateFieldForGovernance(f, null, dup.get(normalizeFieldName(f.name)) ?? 1, thresholds));
}

// ----- Queue helpers -----

// Stop and re-queue a build that has been running this long, rather than letting Forge kill
// the invocation at its 900s consumer ceiling. Same reasoning as FILTER_CHUNK_PAGES: leave
// enough of the budget that the checkpoint write and the re-queue always land. runSnapshot's
// per-field REST loop is rate-limited, so on a large estate a single invocation never gets
// close to finishing -- it has to chunk, and this is where a chunk ends.
export const SNAPSHOT_SOFT_BUDGET_MS = 11 * 60 * 1000;

// A build stuck in "building" with no fresh heartbeat for this long is treated as abandoned
// rather than in flight. Mirrors BUILD_STALE_MS in resumable-build.js and its siblings: the
// consumer ceiling is 900s, plus a minute so a chunk finishing right at the limit is never
// declared stale out from under itself. runSnapshot bumps startedAt on every chunk, so this
// measures the CURRENT chunk's age, not the whole build's.
export const SNAPSHOT_BUILD_STALE_MS = 16 * 60 * 1000;

// True when a build was started but can no longer be running -- a chunk killed by a deploy,
// an error outside the try, or a queue message that never arrived. Without this the row
// stays "building" forever and blocks every future rebuild.
export function isSnapshotBuildStale(meta, now = Date.now(), staleMs = SNAPSHOT_BUILD_STALE_MS) {
  if (meta?.state !== "building") return false;
  const heartbeat = Date.parse(meta?.startedAt || "");
  if (!Number.isFinite(heartbeat)) return true;
  return now - heartbeat > staleMs;
}

export async function queueSnapshotBuild(installationKey, jobToken = null) {
  await inventorySnapshotQueue.push({
    // The token rides along only on a build's own re-queued continuation. runSnapshot uses it
    // to tell "my next chunk" apart from "a second consumer started while I was running",
    // which the duplicate guard would otherwise reject identically.
    body: { jobType: "run-snapshot", installationKey, ...(jobToken ? { jobToken } : {}) },
  });
}

export async function queueFieldSummaryBuild(
  installationKey,
  version,
  fieldId,
  jobToken,
  startAt = 0,
  nextPageToken = "",
) {
  if (!installationKey || !version || !fieldId || !jobToken) {
    throw new Error("Invalid field summary queue payload");
  }
  await inventorySnapshotQueue.push({
    body: { jobType: "build-field-summary", installationKey, version, fieldId, jobToken, startAt, nextPageToken },
  });
}

export async function queueFieldUsageDeltaRefresh(
  installationKey,
  version,
  fieldId,
  jobToken,
  projectKeys = [],
  windowHours = 24,
) {
  if (!installationKey || !version || !fieldId || !jobToken) {
    throw new Error("Invalid field usage delta queue payload");
  }
  await inventorySnapshotQueue.push({
    body: {
      jobType: "refresh-field-project-delta",
      installationKey,
      version,
      fieldId,
      jobToken,
      projectKeys,
      windowHours,
    },
  });
}

export async function queueReportBuild(installationKey, version, jobId) {
  if (!installationKey || !version || !jobId) {
    throw new Error("Invalid report build queue payload");
  }
  await inventorySnapshotQueue.push({
    body: {
      jobType: "build-project-usage-report",
      installationKey,
      version,
      jobId,
    },
  });
}

export async function queueProjectUsageRestore(installationKey, version) {
  await inventorySnapshotQueue.push({
    body: { jobType: "restore-project-usage", installationKey, version },
  });
}

export async function tryQueueFieldSummaryBuild(
  installationKey,
  version,
  fieldId,
  jobToken,
  startAt = 0,
  nextPageToken = "",
) {
  if (!installationKey || !version || !fieldId || !jobToken) {
    return { queued: false, reason: "invalid-payload" };
  }

  try {
    await queueFieldSummaryBuild(installationKey, version, fieldId, jobToken, startAt, nextPageToken);
    return { queued: true };
  } catch (error) {
    const message = String(error?.message || "");
    if (
      message.toLowerCase().includes("too many requests") ||
      message.toLowerCase().includes("cyclic invocation") ||
      message.toLowerCase().includes("limit on cyclic invocation") ||
      message.toLowerCase().includes("400 bad request")
    ) {
      return { queued: false, reason: "queue-backpressure", error };
    }
    throw error;
  }
}

export async function queueFieldSummaryContinuationWithRetry(
  installationKey,
  version,
  fieldId,
  jobToken,
  startAt = 0,
  nextPageToken = "",
) {
  const retryDelaysMs = [0, 1500, 3000, 5000];
  let lastResult = { queued: false, reason: "queue-backpressure" };

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    if (retryDelaysMs[attempt] > 0) {
      await sleep(retryDelaysMs[attempt]);
    }

    lastResult = await tryQueueFieldSummaryBuild(installationKey, version, fieldId, jobToken, startAt, nextPageToken);

    if (lastResult.queued) {
      return { queued: true, attempts: attempt + 1 };
    }

    if (lastResult.reason !== "queue-backpressure") {
      return { ...lastResult, attempts: attempt + 1 };
    }
  }

  return { ...lastResult, attempts: retryDelaysMs.length };
}

export async function queueFieldUsageDeltaRefreshWithRetry(
  installationKey,
  version,
  fieldId,
  jobToken,
  projectKeys = [],
  windowHours = 24,
) {
  const retryDelaysMs = [0, 1500, 3000, 5000];
  let lastResult = { queued: false, reason: "queue-backpressure" };

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    if (retryDelaysMs[attempt] > 0) {
      await sleep(retryDelaysMs[attempt]);
    }

    try {
      await queueFieldUsageDeltaRefresh(installationKey, version, fieldId, jobToken, projectKeys, windowHours);
      return { queued: true, attempts: attempt + 1 };
    } catch (error) {
      const message = String(error?.message || "");
      if (
        message.toLowerCase().includes("too many requests") ||
        message.toLowerCase().includes("cyclic invocation") ||
        message.toLowerCase().includes("limit on cyclic invocation") ||
        message.toLowerCase().includes("400 bad request")
      ) {
        lastResult = { queued: false, reason: "queue-backpressure", error };
        continue;
      }
      throw error;
    }
  }

  return { ...lastResult, attempts: retryDelaysMs.length };
}

export async function ensureFieldSummaryJobRunning(installationKey, version, fieldId, summary, snapshotField = null) {
  if (!summary || !version || !fieldId) {
    return summary;
  }

  if (summary.summaryStatus !== "queued" && summary.summaryStatus !== "building") {
    return summary;
  }

  const now = Date.now();
  const refreshedAtMs = summary.refreshedAt ? new Date(summary.refreshedAt).getTime() : 0;
  const startedAtMs = summary.startedAt ? new Date(summary.startedAt).getTime() : 0;
  const queuedIsStale =
    summary.summaryStatus === "queued" && refreshedAtMs > 0 && now - refreshedAtMs > FIELD_SUMMARY_QUEUE_STALE_AFTER_MS;
  const buildIsStale =
    summary.summaryStatus === "building" &&
    ((startedAtMs > 0 && now - startedAtMs > FIELD_SUMMARY_BUILD_STALE_AFTER_MS) ||
      (refreshedAtMs > 0 && now - refreshedAtMs > FIELD_SUMMARY_BUILD_STALE_AFTER_MS));

  if (!queuedIsStale && !buildIsStale) {
    return summary;
  }

  const fieldRecord =
    snapshotField ||
    summary.field ||
    (await loadSnapshotField(installationKey, version, fieldId).catch(
      fallbackOn("snapshot.field_load_failed", null, { fieldId }),
    ));
  if (!fieldRecord) {
    return summary;
  }

  const progressLog = [
    ...(summary.progressLog || []),
    {
      t: new Date().toISOString(),
      msg: queuedIsStale
        ? "Queued job appeared stalled; re-queueing from checkpoint"
        : "Background job appeared stalled; re-queueing from checkpoint",
    },
  ].slice(-100);

  const recoveredJobToken = summary.jobToken || makeJobToken();
  const recoveredSummary = {
    ...summary,
    fieldId,
    refreshedAt: new Date().toISOString(),
    field: fieldRecord,
    summaryStatus: "queued",
    completedAt: null,
    lastError: null,
    progressLog,
    jobToken: recoveredJobToken,
  };

  await replaceFieldSummary(installationKey, fieldId, recoveredSummary);
  const queueResult = await tryQueueFieldSummaryBuild(
    installationKey,
    version,
    fieldId,
    recoveredJobToken,
    recoveredSummary.processedIssueCount || recoveredSummary.nextStartAt || 0,
    recoveredSummary.nextPageToken || "",
  );

  if (!queueResult.queued) {
    await replaceFieldSummary(installationKey, fieldId, {
      ...recoveredSummary,
      progressLog: [
        ...progressLog,
        { t: new Date().toISOString(), msg: "Re-queue deferred due to queue backpressure; try Refresh jobs again" },
      ].slice(-100),
    });
  }

  return recoveredSummary;
}

export async function requeueStaleSnapshotBuild(installationKey, meta) {
  const currentMeta = meta || (await readSnapshotMeta(installationKey));
  if (!isSnapshotBuildStale(currentMeta)) {
    return currentMeta;
  }

  const queueToken = makeJobToken();
  await writeSnapshotMeta(installationKey, {
    state: "queued",
    jobToken: queueToken,
    lastError: currentMeta?.lastError || "Previous build stalled; re-queuing from checkpoint.",
  });

  const claimed = await readSnapshotMeta(installationKey);
  if (claimed?.jobToken === queueToken) {
    await queueSnapshotBuild(installationKey, queueToken);
    return claimed;
  }

  return claimed || currentMeta;
}

// ----- processFieldSummaryChunk -----

export async function processFieldSummaryChunk(
  scopeKey,
  version,
  snapshotField,
  jobToken,
  _startAt = 0,
  nextPageToken = null,
  maxPages = PROJECT_USAGE_SCAN_PAGES_PER_JOB,
) {
  const fieldId = snapshotField.id;
  const existing = await loadFieldSummary(scopeKey, fieldId);
  if (!existing || existing.jobToken !== jobToken || existing.summaryStatus === "cancelled") {
    return;
  }

  const progressLog = [...(existing.progressLog || [])];
  const addJobLog = (msg) => {
    progressLog.push({ t: new Date().toISOString(), msg });
    if (progressLog.length > 100) progressLog.shift();
  };

  if (existing.summaryStatus === "queued") {
    incrMetric(METRIC_NAMES.projectUsageJobStarted);
    addJobLog(`Started project-usage build for ${snapshotField.name} (${fieldId})`);
  }

  addJobLog(
    `Scanning up to ${(PROJECT_USAGE_ISSUE_SCAN_PAGE_SIZE * maxPages).toLocaleString()} matching issues for project usage`,
  );

  let scan;
  try {
    scan = await getProjectBreakdownByIssueScan(fieldId, nextPageToken || existing.nextPageToken || null, maxPages);
  } catch (scanError) {
    if (isExpiredPageTokenError(scanError)) {
      addJobLog("Jira page cursor expired; restarting scan from the beginning");
      await replaceFieldSummary(scopeKey, fieldId, {
        ...existing,
        summaryStatus: "queued",
        nextPageToken: null,
        processedIssueCount: 0,
        nextStartAt: 0,
        activeProjects: [],
        progressLog,
      });
      await queueFieldSummaryContinuationWithRetry(scopeKey, version, fieldId, jobToken, 0, "");
      return;
    }
    throw scanError;
  }
  const mergedProjects = mergeProjectUsageCounts(existing.activeProjects || [], scan.projects);
  const processedIssueCount = Number(existing.processedIssueCount || 0) + Number(scan.scannedIssueCount || 0);
  const estimatedIssueTotal = Number(
    scan.totalIssues || existing.estimatedIssueTotal || snapshotField.totalIssueCount || 0,
  );
  const sourceIssueTotal = Number(snapshotField.totalIssueCount || existing.totalIssueCount || 0);
  const totalIssueCount = mergedProjects.reduce((sum, project) => sum + Number(project.issueCount || 0), 0);
  const isComplete = scan.isComplete || processedIssueCount >= estimatedIssueTotal;

  addJobLog(
    estimatedIssueTotal > 0
      ? `Processed ${processedIssueCount.toLocaleString()} of ${estimatedIssueTotal.toLocaleString()} matching issues`
      : `Processed ${processedIssueCount.toLocaleString()} matching issues`,
  );

  const baseSummary = {
    refreshedAt: new Date().toISOString(),
    field: snapshotField,
    fieldJql: snapshotField.fieldJql || buildOverallFieldJql(fieldId),
    configuredProjectCount: snapshotField.configuredProjectCount ?? snapshotField.usageCount ?? 0,
    hasGlobalContext: false,
    activeProjectCount: mergedProjects.length,
    totalIssueCount: Math.max(totalIssueCount, sourceIssueTotal),
    activeProjects: mergedProjects,
    contexts: existing.contexts || [],
    findings: snapshotField.findings || null,
    startedAt: existing.startedAt || new Date().toISOString(),
    completedAt: isComplete ? new Date().toISOString() : null,
    lastError: null,
    progressLog,
    jobToken,
    processedIssueCount,
    estimatedIssueTotal,
    nextStartAt: processedIssueCount,
    nextPageToken: scan.nextPageToken,
  };

  if (scan.paginationBroken) {
    addJobLog(
      `Field scan pagination broke after ${processedIssueCount.toLocaleString()} of ${estimatedIssueTotal.toLocaleString()} issues; Jira did not return a continuation token`,
    );
    await replaceFieldSummary(scopeKey, fieldId, {
      ...baseSummary,
      totalIssueCount: Math.max(sourceIssueTotal, processedIssueCount),
      summaryStatus: "failed",
      completedAt: new Date().toISOString(),
      lastError: "Project usage pagination ended unexpectedly before all matching issues were scanned",
      progressLog,
    });
    incrMetric(METRIC_NAMES.projectUsageJobFailed);
    return;
  }

  if (isComplete) {
    if (mergedProjects.length === 0 && sourceIssueTotal > 0) {
      addJobLog(
        `Completed matching-issue scan but found 0 active projects despite ${sourceIssueTotal.toLocaleString()} populated issues`,
      );
      await replaceFieldSummary(scopeKey, fieldId, {
        ...baseSummary,
        totalIssueCount: sourceIssueTotal,
        summaryStatus: "failed",
        completedAt: new Date().toISOString(),
        lastError: "Project usage scan found no active projects despite populated issues",
        progressLog,
      });
      incrMetric(METRIC_NAMES.projectUsageJobFailed);
      return;
    }
    await replaceSnapshotProjectUsageForField(scopeKey, version, fieldId, mergedProjects);
    addJobLog(`Cached ${mergedProjects.length} project usage rows`);
    await replaceFieldSummary(scopeKey, fieldId, {
      ...baseSummary,
      summaryStatus: "ready",
      completedAt: new Date().toISOString(),
      progressLog,
    });
    incrMetric(METRIC_NAMES.projectUsageJobCompleted);
    return;
  }

  await replaceFieldSummary(scopeKey, fieldId, {
    ...baseSummary,
    summaryStatus: "building",
  });

  const queueResult = await queueFieldSummaryContinuationWithRetry(
    scopeKey,
    version,
    fieldId,
    jobToken,
    processedIssueCount,
    scan.nextPageToken || "",
  );

  if (!queueResult.queued) {
    addJobLog(
      `Automatic continuation could not be scheduled after ${processedIssueCount.toLocaleString()} scanned issues; job remains queued at checkpoint`,
    );
    await replaceFieldSummary(scopeKey, fieldId, {
      ...baseSummary,
      summaryStatus: "queued",
      progressLog,
    });
    return;
  }

  if (queueResult.attempts > 1) {
    addJobLog(
      `Scheduled continuation after ${processedIssueCount.toLocaleString()} scanned issues (${queueResult.attempts} queue attempts)`,
    );
  }
}

// ----- processFieldUsageDelta -----

export async function processFieldUsageDelta(
  scopeKey,
  version,
  snapshotField,
  jobToken,
  projectKeys = [],
  windowHours = 24,
) {
  const fieldId = snapshotField.id;
  const existing = await loadFieldSummary(scopeKey, fieldId);
  if (!existing || existing.jobToken !== jobToken || existing.summaryStatus === "cancelled") {
    return;
  }

  const normalizedProjectKeys = Array.from(
    new Set((projectKeys || []).map((value) => String(value || "").trim()).filter(Boolean)),
  );
  if (!normalizedProjectKeys.length) {
    await replaceFieldSummary(scopeKey, fieldId, {
      ...existing,
      refreshedAt: new Date().toISOString(),
      summaryStatus: "ready",
      completedAt: new Date().toISOString(),
      lastError: null,
      progressLog: [
        ...(existing.progressLog || []).slice(-80),
        {
          t: new Date().toISOString(),
          msg: `No affected projects were found for the last ${windowHours}h incremental refresh`,
        },
      ].slice(-100),
    });
    return;
  }

  const progressLog = [...(existing.progressLog || [])];
  const addJobLog = (msg) => {
    progressLog.push({ t: new Date().toISOString(), msg });
    if (progressLog.length > 100) progressLog.shift();
  };

  addJobLog(
    `Started incremental project-usage refresh for ${snapshotField.name} across ${normalizedProjectKeys.length} affected projects`,
  );
  incrMetric(METRIC_NAMES.projectUsageDeltaStarted);

  await replaceFieldSummary(scopeKey, fieldId, {
    ...existing,
    refreshedAt: new Date().toISOString(),
    summaryStatus: "building",
    startedAt: existing.startedAt || new Date().toISOString(),
    completedAt: null,
    lastError: null,
    progressLog,
  });

  const currentByProjectKey = new Map(
    (existing.activeProjects || []).map((project) => [project.projectKey, { ...project }]),
  );
  const refreshedProjects = await mapWithConcurrency(normalizedProjectKeys, 2, async (projectKey) => {
    const usage = await searchProjectFieldUsage(fieldId, projectKey);
    if (usage.issueCount <= 0) {
      return { projectKey, remove: true };
    }
    const prior = currentByProjectKey.get(projectKey);
    const project =
      usage.project ||
      (prior
        ? { id: prior.projectId, key: prior.projectKey, name: prior.projectName }
        : { id: projectKey, key: projectKey, name: projectKey });
    return buildProjectUsageRecord({
      project,
      fieldId,
      issueCount: usage.issueCount,
      latestIssue: usage.latestIssue,
    });
  });

  for (const project of refreshedProjects) {
    if (!project) continue;
    if (project.remove) {
      currentByProjectKey.delete(project.projectKey);
      continue;
    }
    currentByProjectKey.set(project.projectKey, project);
  }

  const nextProjects = Array.from(currentByProjectKey.values()).sort(
    (left, right) =>
      Number(right.issueCount || 0) - Number(left.issueCount || 0) || left.projectKey.localeCompare(right.projectKey),
  );
  const nextTotalIssueCount = nextProjects.reduce((sum, project) => sum + Number(project.issueCount || 0), 0);

  await replaceSnapshotProjectUsageForField(scopeKey, version, fieldId, nextProjects);
  await replaceFieldSummary(scopeKey, fieldId, {
    ...existing,
    refreshedAt: new Date().toISOString(),
    field: snapshotField,
    fieldJql: existing.fieldJql || snapshotField.fieldJql || buildOverallFieldJql(fieldId),
    configuredProjectCount:
      existing.configuredProjectCount ?? snapshotField.configuredProjectCount ?? snapshotField.usageCount ?? 0,
    totalIssueCount: Math.max(nextTotalIssueCount, Number(snapshotField.totalIssueCount || 0)),
    activeProjectCount: nextProjects.length,
    activeProjects: nextProjects,
    summaryStatus: "ready",
    completedAt: new Date().toISOString(),
    lastError: null,
    progressLog: [
      ...progressLog,
      {
        t: new Date().toISOString(),
        msg: `Incremental refresh complete for ${normalizedProjectKeys.length} affected projects`,
      },
    ].slice(-100),
  });
  incrMetric(METRIC_NAMES.projectUsageDeltaCompleted);
}

// ----- buildProjectUsageRecord (re-exported from transform via jira-api) -----
import { buildProjectUsageRecord } from "./transform.js";

// ----- isExpiredPageTokenError (used locally) -----
function isExpiredPageTokenError(error) {
  return (
    Number(error?.status) === 400 &&
    String(error?.message || "")
      .toLowerCase()
      .includes("next page token")
  );
}

// ----- fetchFieldCatalog -----

// The only place field discovery happens — everything else (Universal Scan's
// syncFieldCatalog included) treats this as the source of truth for "what fields exist."
export async function fetchFieldCatalog() {
  const [customFields, systemFields] = await Promise.all([
    getAllCustomFields(),
    getAllSystemFields().catch(fallbackOn("snapshot.system_fields_load_failed", () => [])),
  ]);
  return [...customFields, ...systemFields.map((f) => ({ ...f, isSystemField: true }))];
}

// ----- syncFieldCatalog -----

// Fast field-discovery/metadata refresh — called at the start of every Universal Scan run
// (see runIssueScanCoordinator in scan-engine.js) so newly-created or renamed fields show
// up in the inventory without waiting for the next full runSnapshot(). Deliberately does
// NOT call getFieldTotalIssueCount — that's the expensive, rate-limited per-field REST loop
// that caused the original stuck-at-88% bug; Universal Scan supplies totalIssueCount itself
// from its own crawl (see promoteIssueScanToSnapshotProjectUsage's syncTotalIssueCount option).
export async function syncFieldCatalog(installationKey, version) {
  const allFields = await fetchFieldCatalog();
  const existingRows = await loadSnapshotFields(installationKey, version);
  const existingById = new Map(existingRows.map((row) => [row.id, row]));

  const newFields = [];
  const changedFields = [];
  for (const field of allFields) {
    const existing = existingById.get(field.id);
    const typeLabel = getFieldTypeLabel(field);
    const primitiveType = field.schema?.type || "unknown";
    const customType = field.schema?.custom || null;
    const searcherKey = field.searcherKey || null;
    const description = field.description || "";
    if (!existing) {
      newFields.push(field);
      continue;
    }
    if (
      existing.name !== field.name ||
      existing.description !== description ||
      existing.type !== typeLabel ||
      existing.primitiveType !== primitiveType ||
      existing.customType !== customType ||
      existing.searcherKey !== searcherKey
    ) {
      changedFields.push({
        id: field.id,
        name: field.name,
        description,
        type: typeLabel,
        primitiveType,
        customType,
        searcherKey,
      });
    }
  }

  const nameCountMap = buildDuplicateNameCountMap(allFields);

  const newRecords = await mapWithConcurrency(newFields, SNAPSHOT_CONCURRENCY, async (field) => {
    let configuredProjectCount = 0;
    if (!field.isSystemField) {
      configuredProjectCount = await getFieldConfiguredProjectCount(field.id);
      if (configuredProjectCount < 0) configuredProjectCount = 0; // -1 = timeout/unknown, not "0 projects"
    }
    const duplicateNameCount = nameCountMap.get(normalizeFieldName(field.name)) ?? 1;
    const usageStatusDetail = "Newly discovered field; usage not yet crawled.";
    const findings = buildGovernanceFindings(field, {
      configuredProjectCount,
      totalIssueCount: 0,
      activeProjectCount: 0,
      duplicateNameCount,
      usageStatus: USAGE_STATUS_UNAVAILABLE,
      usageStatusDetail,
      isSystemField: Boolean(field.isSystemField),
      isPlatformProvidedField: isPlatformProvidedField(field),
    });
    return buildInventoryRecord(field, {
      configuredProjectCount,
      activeProjectCount: 0,
      totalIssueCount: 0,
      usageStatus: USAGE_STATUS_UNAVAILABLE,
      usageStatusDetail,
      findings,
    });
  });

  if (newRecords.length) {
    await appendSnapshotFields(installationKey, version, newRecords);
  }
  if (changedFields.length) {
    await updateSnapshotFieldMetadata(installationKey, version, changedFields);
  }

  return {
    newFieldCount: newRecords.length,
    changedFieldCount: changedFields.length,
    totalCatalogCount: allFields.length,
  };
}

// ----- refreshGovernanceFindingsForFields -----

// Recomputes governance findings for a specific set of already-known fields using numbers
// already on their snapshot_fields row (no REST calls) — called after
// promoteIssueScanToSnapshotProjectUsage updates totalIssueCount/activeProjectCount from a
// completed Universal Scan crawl, so findings reflect real crawl data instead of going stale.
export async function refreshGovernanceFindingsForFields(installationKey, version, fieldIds) {
  if (!fieldIds || !fieldIds.length) return { updatedCount: 0 };
  const allFields = await loadSnapshotFields(installationKey, version);
  const nameCountMap = buildDuplicateNameCountMap(allFields);
  const idSet = new Set(fieldIds);

  // Best-effort: if the rollup query fails, findings still recompute without the
  // staleness signal rather than losing the whole refresh.
  const lastChangeMap = await loadFieldLastChangeMap(installationKey, version, fieldIds).catch((err) => {
    logger.warn("refreshGovernanceFindingsForFields.last_change_rollup_failed", errorContext(err));
    return new Map();
  });
  // Values counted in projects since archived: data the crawl cannot see, so a field holding
  // them is never flagged as unused. Best-effort like the rollup above.
  const archivedUsage = await loadArchivedFieldUsage(installationKey, fieldIds).catch((err) => {
    logger.warn("refreshGovernanceFindingsForFields.archived_usage_read_failed", errorContext(err));
    return new Map();
  });

  const updates = allFields
    .filter((field) => idSet.has(field.id))
    .map((field) => {
      const isSystemField = !String(field.id || "").startsWith("customfield_");
      const duplicateNameCount = nameCountMap.get(normalizeFieldName(field.name)) ?? 1;
      const findings = buildGovernanceFindings(field, {
        configuredProjectCount: field.configuredProjectCount,
        totalIssueCount: field.totalIssueCount,
        activeProjectCount: field.activeProjectCount,
        duplicateNameCount,
        usageStatus: USAGE_STATUS_READY,
        usageStatusDetail: null,
        isSystemField,
        isPlatformProvidedField: isPlatformProvidedField(field),
        lastFieldChangeAt: lastChangeMap.get(field.id) ?? null,
        archivedIssueCount: (archivedUsage.get(String(field.id)) || []).reduce((n, r) => n + (r.issueCount || 0), 0),
      });
      return { id: field.id, findings };
    });

  if (updates.length) {
    await updateSnapshotFieldFindings(installationKey, version, updates);
  }
  return { updatedCount: updates.length };
}

// ----- runSnapshot -----

class CancelError extends Error {
  constructor() {
    super("Build cancelled by user");
    this.isCancelError = true;
  }
}

export async function runSnapshot(installationKey, { continuationToken = null } = {}) {
  logger.info("snapshot.start", { installationKey });
  incrMetric(METRIC_NAMES.inventorySnapshot);
  const runStartMs = Date.now();
  const progressLog = [];
  let processedCount = 0;
  let skipCount = 0;
  let totalCount = 0;
  let progressInterval = null;
  let cancelled = false;
  // Set when this chunk has used its share of the invocation budget. Remaining fields are
  // skipped, the walk unwinds, and the build re-queues itself to continue rather than being
  // killed mid-field by Forge at the 900s ceiling.
  let budgetExhausted = false;
  let version = null;
  let buildToken = null;
  const pendingFieldRecords = [];

  // Reset telemetry for this invocation and expose logEntry to withRetry
  resetScanTelemetry();
  resetJiraRateLimiterState();

  function logEntry(msg) {
    const entry = { t: new Date().toISOString(), msg };
    progressLog.push(entry);
    if (progressLog.length > 200) progressLog.shift();
    logger.info("runSnapshot.progress", { msg });
  }
  setSnapshotLogger(logEntry);

  async function flushProgress() {
    try {
      await writeSnapshotMeta(installationKey, {
        processedFields: processedCount,
        totalFields: totalCount,
        progressLog: [...progressLog],
      });
    } catch (error) {
      // Progress reporting only; the build continues either way. Debug rather than warn
      // because this fires on a timer and a transient failure is expected under load --
      // but a run where it fails EVERY time looks like a frozen progress bar, and this
      // is the only thing that would explain it.
      logger.debug("snapshot.progress_write_failed", {
        installationKey,
        error: String(error?.message || error),
      });
    }
  }

  async function flushPendingFieldRecords() {
    if (!pendingFieldRecords.length) return;
    const batch = pendingFieldRecords.splice(0, pendingFieldRecords.length);
    await appendSnapshotFields(installationKey, version, batch);
  }

  try {
    await ensureProjectStoreReady();

    const existingMeta = await readSnapshotMeta(installationKey);

    let resuming = false;

    if (existingMeta?.state === "building") {
      // A continuation this build re-queued for itself carries the build token back. That is
      // not a duplicate consumer -- it is this build picking up its own next chunk, and it
      // must be let through even though the row is fresh ("building", just heartbeated).
      const isOwnContinuation = Boolean(
        continuationToken && existingMeta.jobToken && continuationToken === existingMeta.jobToken,
      );
      if (!isOwnContinuation && !isSnapshotBuildStale(existingMeta)) {
        logger.info("runSnapshot.duplicate_skipping");
        return;
      }
      if (existingMeta.buildingVersion) {
        version = existingMeta.buildingVersion;
        buildToken = existingMeta.jobToken || makeJobToken();
        resuming = true;
        logger.info("runSnapshot.resuming_build", { mode: isOwnContinuation ? "in-flight" : "stale", version });
      } else {
        logger.info("runSnapshot.build_without_version_restarting");
      }
    } else if (existingMeta?.state === "queued" && existingMeta.buildingVersion) {
      // Re-queued from a stale/stuck build (see requeueStaleSnapshotBuild) — state was
      // flipped to "queued" purely as a hand-off signal for this consumer invocation, but
      // the checkpoint (buildingVersion) must still be honored here, or the build silently
      // restarts from field 0 and discards every field already completed.
      version = existingMeta.buildingVersion;
      buildToken = existingMeta.jobToken || makeJobToken();
      resuming = true;
      logger.info("runSnapshot.resuming_requeued_build", { version });
    }

    if (!version) {
      version = String(Date.now());
      buildToken = makeJobToken();
      await clearSnapshotVersion(installationKey, version);
    }

    if (resuming && Array.isArray(existingMeta.progressLog)) {
      progressLog.push(...existingMeta.progressLog.slice(-80));
    }
    processedCount = resuming ? existingMeta.processedFields || 0 : 0;

    await writeSnapshotMeta(installationKey, {
      state: "building",
      buildingVersion: version,
      jobToken: buildToken,
      // Bumped on every chunk, not just the first: isSnapshotBuildStale reads this, so it
      // has to mean "the current chunk started here", not "the whole build started here" --
      // otherwise a long multi-chunk build would be declared stale while still working.
      startedAt: new Date().toISOString(),
      completedAt: null,
      lastError: null,
      processedFields: processedCount,
      progressLog: [...progressLog],
    });

    // Race-check: if multiple queue consumers started concurrently, only the last writer
    // of buildingVersion proceeds. Others detect the mismatch and exit cleanly.
    const raceCheck = await readSnapshotMeta(installationKey);
    if (raceCheck?.buildingVersion !== version) {
      logger.info("runSnapshot.lost_startup_race", { version, buildingVersion: raceCheck?.buildingVersion });
      return;
    }

    progressInterval = setInterval(() => {
      flushProgress().catch(ignoreWith("snapshot.progress_flush_failed", { installationKey }));
    }, SNAPSHOT_PROGRESS_FLUSH_INTERVAL_MS);

    const allFields = await fetchFieldCatalog();
    totalCount = allFields.length;

    const nameCountMap = buildDuplicateNameCountMap(allFields);

    // Checkpoint: skip fields already written to DB in this version
    let alreadyDoneIds = new Set();
    if (resuming) {
      alreadyDoneIds = await getSnapshotProcessedFieldIds(installationKey, version);
      skipCount = alreadyDoneIds.size;
      processedCount = skipCount;
      logEntry(`Resuming — ${skipCount} of ${totalCount} fields already done, ${totalCount - skipCount} remaining`);
    } else {
      logEntry(`Found ${totalCount} custom fields — starting build`);
    }

    const fieldsToProcess = allFields.filter((f) => !alreadyDoneIds.has(f.id));

    await mapWithConcurrency(fieldsToProcess, SNAPSHOT_CONCURRENCY, async (field, index) => {
      if (cancelled) throw new CancelError();

      // This chunk has had its share of the invocation. Stop taking new fields -- the walk
      // unwinds fast (every remaining worker returns here), then the block after the map
      // flushes what is done and re-queues to continue. Not a throw: the fields already
      // processed are real progress, not something to roll back.
      if (budgetExhausted || Date.now() - runStartMs > SNAPSHOT_SOFT_BUDGET_MS) {
        budgetExhausted = true;
        return;
      }

      // Poll DB every 50 fields to pick up a cancel signal written by the resolver.
      // Also exit if a newer build has taken over the buildingVersion slot.
      if ((index + 1) % 50 === 0) {
        const currentMeta = await readSnapshotMeta(installationKey);
        if (currentMeta?.state !== "building" || currentMeta?.buildingVersion !== version) {
          cancelled = true;
          throw new CancelError();
        }
      }

      let totalIssueCount = 0;
      let configuredProjectCount = 0;
      let activeProjectCount = 0;
      let timedOut = false;
      const fieldsDone = skipCount + index + 1;
      const fieldTag = `[${fieldsDone}/${totalCount}] ${field.name} (${field.id})`;
      const t0 = Date.now();

      logEntry(`⋯ ${fieldTag} — querying`);

      // System fields are globally available — skip context/project association endpoint,
      // use JQL directly. Custom fields use project count to gate the issue count call.
      try {
        if (field.isSystemField) {
          totalIssueCount = await getFieldTotalIssueCount(field.id);
          configuredProjectCount = 0; // global — not tracked per-project context
        } else {
          configuredProjectCount = await getFieldConfiguredProjectCount(field.id);
          // -1 means the project-association lookup itself timed out/errored — we don't
          // know whether this field has any configured projects, so don't treat it as 0
          // and don't ask for an issue count we can't trust either.
          if (configuredProjectCount === -1) {
            timedOut = true;
          } else if (configuredProjectCount > 0 && getFieldNumericId(field.id)) {
            totalIssueCount = await getFieldTotalIssueCount(field.id);
          }
        }
        if (totalIssueCount === -1) timedOut = true;
        activeProjectCount = 0;
        const elapsed = Date.now() - t0;
        if (timedOut) {
          logEntry(`⏱ ${fieldTag} — count timed out (${elapsed}ms)`);
        } else if (totalIssueCount > 0) {
          logEntry(
            `✓ ${fieldTag} — ${field.isSystemField ? "global" : `${configuredProjectCount} projects`}, ${totalIssueCount.toLocaleString()} issues (${elapsed}ms)`,
          );
        } else if (!field.isSystemField && configuredProjectCount > 0) {
          logEntry(`○ ${fieldTag} — ${configuredProjectCount} projects, 0 issues (${elapsed}ms)`);
        } else {
          logEntry(`— ${fieldTag} — 0 issues (${elapsed}ms)`);
        }
      } catch (usageErr) {
        const elapsed = Date.now() - t0;
        logEntry(`✗ ${fieldTag} — ERROR: ${usageErr?.message} (${elapsed}ms)`);
        logger.warn("runSnapshot.usage_stats_failed", { fieldId: field.id, error: usageErr?.message });
      }

      // A timed-out/-1 count is unknown, not zero — store 0 so the record shape stays
      // valid, but flag usageStatus as unavailable below so governance findings that
      // depend on "confirmed zero usage" don't fire off a guess.
      const resolvedIssueCount = totalIssueCount < 0 ? 0 : totalIssueCount;
      const resolvedConfiguredProjectCount = configuredProjectCount < 0 ? 0 : configuredProjectCount;
      const usageStatus = timedOut ? USAGE_STATUS_UNAVAILABLE : USAGE_STATUS_READY;
      const usageStatusDetail = timedOut
        ? "Usage count timed out during the background snapshot; will be retried on the next build."
        : null;

      const duplicateNameCount = nameCountMap.get(normalizeFieldName(field.name)) ?? 1;

      const findings = buildGovernanceFindings(field, {
        configuredProjectCount: resolvedConfiguredProjectCount,
        totalIssueCount: resolvedIssueCount,
        activeProjectCount,
        duplicateNameCount,
        usageStatus,
        usageStatusDetail,
        isSystemField: Boolean(field.isSystemField),
        isPlatformProvidedField: isPlatformProvidedField(field),
      });

      const record = buildInventoryRecord(field, {
        configuredProjectCount: resolvedConfiguredProjectCount,
        activeProjectCount,
        totalIssueCount: resolvedIssueCount,
        usageStatus,
        usageStatusDetail,
        findings,
      });

      // Write field record — per-project breakdown populated on-demand in getFieldDetails
      pendingFieldRecords.push(record);
      if (pendingFieldRecords.length >= SNAPSHOT_DB_BATCH_SIZE) {
        await flushPendingFieldRecords();
      }
      processedCount = skipCount + index + 1;
    });

    // Ran out of invocation budget before every field was done. Flush what this chunk
    // produced, checkpoint, and re-queue from here -- the next invocation resumes off the
    // DB rows via getSnapshotProcessedFieldIds. No finalization: carry-forward, pruning and
    // the ready state only happen once the walk actually completes.
    if (budgetExhausted) {
      await flushPendingFieldRecords();
      const doneIds = await getSnapshotProcessedFieldIds(installationKey, version).catch(() => null);
      const doneCount = doneIds ? doneIds.size : processedCount;
      logEntry(`Chunk budget reached — ${doneCount} of ${totalCount} fields done; re-queueing to continue`);
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
      }

      await writeSnapshotMeta(installationKey, {
        state: "building",
        buildingVersion: version,
        jobToken: buildToken,
        startedAt: new Date().toISOString(),
        completedAt: null,
        lastError: null,
        processedFields: doneCount,
        totalFields: totalCount,
        progressLog: [...progressLog],
      });

      // Only the writer that still owns the version re-queues, so a build that lost the
      // race above does not push a continuation for a version nobody will publish.
      const owner = await readSnapshotMeta(installationKey);
      if (owner?.buildingVersion === version) {
        await queueSnapshotBuild(installationKey, buildToken);
      }
      logger.info("snapshot.chunk_checkpointed", {
        installationKey,
        version,
        processedFields: doneCount,
        totalFields: totalCount,
      });
      return;
    }

    const { rl429Count, rlRetryCount } = getScanTelemetry();
    logEntry(`Finalizing — ${totalCount} fields complete | 429s: ${rl429Count} retries: ${rlRetryCount}`);
    await flushPendingFieldRecords();
    // Preserve historical per-field project usage built up by individual field scans.
    // Must run before clearOtherSnapshotVersions or the old data is lost.
    await carryForwardSnapshotProjectUsage(installationKey, version);
    await clearOtherSnapshotVersions(installationKey, version);

    // Fill any gaps in project usage from field_summaries (INSERT IGNORE — won't touch data that carried forward).
    // This recovers silently from version-transition data loss without overwriting fresh per-field scan results.
    const fillResult = await fillSnapshotProjectUsageFromSummaries(installationKey, version);
    if (fillResult.rowsInserted > 0) {
      logEntry(
        `Filled ${fillResult.fieldsRestored} fields (${fillResult.rowsInserted} project rows) from field summaries`,
      );
    }

    // Every field record above was written with active_project_count hardcoded to 0 --
    // re-sync it from the per-project rows the two steps above just restored, or the
    // list view (and governance findings computed from it) silently disagree with the
    // per-field detail view until the next Universal Scan happens to touch each field.
    const syncResult = await syncActiveProjectCountsFromUsage(installationKey, version);
    if (syncResult.fieldsSynced > 0) {
      logEntry(`Synced active project counts for ${syncResult.fieldsSynced} fields`);
    }

    const refreshedAt = new Date().toISOString();
    clearInterval(progressInterval);
    progressInterval = null;

    await writeSnapshotMeta(installationKey, {
      state: "ready",
      version,
      buildingVersion: null,
      jobToken: null,
      completedAt: refreshedAt,
      refreshedAt,
      totalFields: totalCount,
      processedFields: totalCount,
      progressLog: [...progressLog],
      lastError: null,
    });

    // Prune previous snapshot versions (best-effort — don't fail the snapshot if cleanup errors)
    try {
      const pruned = await pruneOldSnapshotVersions(installationKey, version);
      if (pruned.fieldsDeleted > 0 || pruned.usageRowsDeleted > 0) {
        logEntry(`Pruned old snapshot data: ${pruned.fieldsDeleted} fields, ${pruned.usageRowsDeleted} usage rows`);
      }
    } catch (pruneErr) {
      logger.warn("pruneOldSnapshotVersions.failed", errorContext(pruneErr));
    }

    logger.info("snapshot.complete", { installationKey, version, processedFields: totalCount, skipped: skipCount });

    // The follow-on delta scan keeps per-project usage counts fresh between full builds --
    // but NOT when a full scan is orchestrating this build. The full scan's very next stage
    // is a complete issue crawl that recomputes those same counts, so the delta is redundant
    // there, and running its own paginated crawl + 500 count queries concurrently with the
    // crawl's five workers is what pushed the installation past its cyclic-invocation limit
    // and knocked a crawl worker over. The full scan owns issue counting; stay out of it.
    const fullScan = await readFullScanMeta(installationKey).catch(() => null);
    if (fullScan?.state === "running") {
      logger.info("snapshot.delta_skipped_full_scan_running", { installationKey });
    } else {
      try {
        await inventorySnapshotQueue.push({ body: { jobType: "run-delta-issue-scan", installationKey } });
      } catch (error) {
        // The snapshot itself is complete and committed; only the follow-on delta scan was
        // lost. Worth a warning: usage counts then quietly stop refreshing until the next
        // full build, which presents as stale data rather than as a failure.
        logger.warn("snapshot.delta_queue_failed", {
          installationKey,
          error: String(error?.message || error),
        });
      }
    }
  } catch (err) {
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
    // Before writing back, verify we still own the build slot.
    // A newer build may have taken over — don't clobber its state.
    const finalMeta = await readSnapshotMeta(installationKey).catch(
      fallbackOn("snapshot.final_meta_read_failed", null, { installationKey }),
    );
    const stillOwner = finalMeta?.buildingVersion === version;

    if (err?.isCancelError) {
      logEntry(`Build cancelled — ${processedCount} of ${totalCount} fields processed`);
      if (stillOwner) {
        await writeSnapshotMeta(installationKey, {
          state: "cancelled",
          buildingVersion: null,
          lastError: null,
          processedFields: processedCount,
          progressLog: [...progressLog],
        }).catch(ignoreWith("snapshot.failure_state_write_failed", { installationKey }));
      }
    } else {
      logger.error("snapshot.failed", { installationKey, version, error: err?.message });
      logger.error("runSnapshot.failed", errorContext(err));
      if (stillOwner) {
        // Keep state as "building" (not "failed") so stale-build detection can resume
        await writeSnapshotMeta(installationKey, {
          state: "building",
          lastError: err?.message || String(err),
          processedFields: processedCount,
          progressLog: [...progressLog],
        }).catch(ignoreWith("snapshot.failure_state_write_failed", { installationKey }));
      }
    }
  } finally {
    if (progressInterval) clearInterval(progressInterval);
    setSnapshotLogger(null);
  }
}
