import { inventorySnapshotQueue } from "./queues.js";
import { logger } from "./logger.js";
import {
  incrMetric,
  METRIC_NAMES,
  makeJobToken,
  getInstallationKey,
  isSnapshotStale,
  setSnapshotLogger,
  sleep,
  jiraRequest,
  paginate,
  mapWithConcurrency,
  getJitterMs,
  withRetry,
  scheduleRateLimitedRequest,
  getFieldContexts,
  getFieldTotalIssueCount,
  getFieldConfiguredProjectCount,
  getAllCustomFields,
  getAllSystemFields,
  getProjectBreakdownByIssueScan,
  searchProjectFieldUsage,
  withTimeout,
  sanitizeCacheKeyPart,
  SNAPSHOT_CONCURRENCY,
  SNAPSHOT_PROGRESS_FLUSH_INTERVAL_MS,
  SNAPSHOT_DB_BATCH_SIZE,
  FIELD_SUMMARY_QUEUE_STALE_AFTER_MS,
  FIELD_SUMMARY_BUILD_STALE_AFTER_MS,
  PROJECT_USAGE_ISSUE_SCAN_PAGE_SIZE,
  PROJECT_USAGE_SCAN_PAGES_PER_JOB,
  BASE_JIRA_REQUEST_INTERVAL_MS,
  BASE_JIRA_CONCURRENCY,
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
  loadFieldSummary,
  replaceFieldSummary,
  getSnapshotProcessedFieldIds,
  carryForwardSnapshotProjectUsage,
  restoreSnapshotProjectUsageFromSummaries,
  fillSnapshotProjectUsageFromSummaries,
  replaceFieldOptionsCache,
  pruneOldSnapshotVersions,
} from "./project-store.js";
import {
  USAGE_STATUS_READY,
  mergeProjectUsageCounts,
  summarizeProjectUsageCapacity,
  normalizeFieldName,
  buildGovernanceFindings,
  buildInventoryRecord,
  isJiraBuiltinField,
  buildDuplicateNameCountMap,
  isSelectFieldType,
} from "./analysis.js";
import { buildOverallFieldJql, getFieldNumericId } from "./transform.js";

// ----- hydrateFieldForGovernance -----

export function hydrateFieldForGovernance(field, summary, duplicateNameCount = 1, thresholds = {}) {
  const activeProjectCount = Number(summary?.activeProjectCount ?? field?.activeProjectCount ?? 0);
  const totalIssueCount = Number(summary?.totalIssueCount ?? field?.totalIssueCount ?? 0);
  const configuredProjectCount = Number(field?.configuredProjectCount ?? field?.usageCount ?? summary?.configuredProjectCount ?? 0);
  const usageStatus = field?.usageStatus ?? USAGE_STATUS_READY;
  const usageStatusDetail = field?.usageStatusDetail || null;

  const isSystemField = !String(field.id || "").startsWith("customfield_");
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
    findings: buildGovernanceFindings(field, {
      configuredProjectCount,
      totalIssueCount,
      activeProjectCount,
      duplicateNameCount,
      usageStatus,
      usageStatusDetail,
      isSystemField,
      contextCount,
      hasGlobalContext,
    }, thresholds),
  };
}

// ----- Queue helpers -----

export async function queueSnapshotBuild(installationKey) {
  await inventorySnapshotQueue.push({
    body: { jobType: "run-snapshot", installationKey },
  });
}

export async function queueFieldSummaryBuild(installationKey, version, fieldId, jobToken, startAt = 0, nextPageToken = "") {
  if (!installationKey || !version || !fieldId || !jobToken) {
    throw new Error("Invalid field summary queue payload");
  }
  await inventorySnapshotQueue.push({
    body: { jobType: "build-field-summary", installationKey, version, fieldId, jobToken, startAt, nextPageToken },
  });
}

export async function queueFieldUsageDeltaRefresh(installationKey, version, fieldId, jobToken, projectKeys = [], windowHours = 24) {
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

export async function tryQueueFieldSummaryBuild(installationKey, version, fieldId, jobToken, startAt = 0, nextPageToken = "") {
  if (!installationKey || !version || !fieldId || !jobToken) {
    return { queued: false, reason: "invalid-payload" };
  }

  try {
    await queueFieldSummaryBuild(installationKey, version, fieldId, jobToken, startAt, nextPageToken);
    return { queued: true };
  } catch (error) {
    const message = String(error?.message || "");
    if (
      message.toLowerCase().includes("too many requests")
      || message.toLowerCase().includes("cyclic invocation")
      || message.toLowerCase().includes("limit on cyclic invocation")
      || message.toLowerCase().includes("400 bad request")
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
  nextPageToken = ""
) {
  const retryDelaysMs = [0, 1500, 3000, 5000];
  let lastResult = { queued: false, reason: "queue-backpressure" };

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    if (retryDelaysMs[attempt] > 0) {
      await sleep(retryDelaysMs[attempt]);
    }

    lastResult = await tryQueueFieldSummaryBuild(
      installationKey,
      version,
      fieldId,
      jobToken,
      startAt,
      nextPageToken
    );

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
  windowHours = 24
) {
  const retryDelaysMs = [0, 1500, 3000, 5000];
  let lastResult = { queued: false, reason: "queue-backpressure" };

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    if (retryDelaysMs[attempt] > 0) {
      await sleep(retryDelaysMs[attempt]);
    }

    try {
      await queueFieldUsageDeltaRefresh(
        installationKey,
        version,
        fieldId,
        jobToken,
        projectKeys,
        windowHours
      );
      return { queued: true, attempts: attempt + 1 };
    } catch (error) {
      const message = String(error?.message || "");
      if (
        message.toLowerCase().includes("too many requests")
        || message.toLowerCase().includes("cyclic invocation")
        || message.toLowerCase().includes("limit on cyclic invocation")
        || message.toLowerCase().includes("400 bad request")
      ) {
        lastResult = { queued: false, reason: "queue-backpressure", error };
        continue;
      }
      throw error;
    }
  }

  return { ...lastResult, attempts: retryDelaysMs.length };
}

export async function topOffDeferredFieldSummaryJobs(installationKey, version, jobs = []) {
  const capacity = summarizeProjectUsageCapacity(jobs);
  let availableSlots = Math.max(0, 3 - capacity.runningJobCount);
  if (!availableSlots) {
    return jobs;
  }

  const queuedContinuations = jobs
    .filter((job) => job.fieldId && job.summaryStatus === "queued" && Number(job.processedIssueCount || 0) > 0)
    .sort((left, right) => {
      const leftRef = new Date(left.refreshedAt || left.startedAt || 0).getTime();
      const rightRef = new Date(right.refreshedAt || right.startedAt || 0).getTime();
      return leftRef - rightRef;
    });

  if (!queuedContinuations.length) {
    return jobs;
  }

  const nextJobs = [...jobs];
  for (const job of queuedContinuations) {
    if (!availableSlots) break;

    const queueResult = await tryQueueFieldSummaryBuild(
      installationKey,
      version,
      job.fieldId,
      job.jobToken || makeJobToken(),
      Number(job.processedIssueCount || job.nextStartAt || 0),
      job.nextPageToken || ""
    );

    if (!queueResult.queued) {
      break;
    }

    const fullJob = await loadFieldSummary(installationKey, job.fieldId).catch(() => job);
    const updatedJob = {
      ...fullJob,
      fieldId: job.fieldId,
      refreshedAt: new Date().toISOString(),
      summaryStatus: "building",
      lastError: null,
      progressLog: [
        ...(fullJob?.progressLog || []),
        { t: new Date().toISOString(), msg: "Resuming queued continuation under current job cap" },
      ].slice(-100),
    };
    await replaceFieldSummary(installationKey, job.fieldId, updatedJob);
    const index = nextJobs.findIndex((candidate) => candidate.fieldId === job.fieldId);
    if (index >= 0) {
      nextJobs[index] = updatedJob;
    }
    availableSlots--;
  }

  return nextJobs;
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
    summary.summaryStatus === "queued" &&
    refreshedAtMs > 0 &&
    (now - refreshedAtMs) > FIELD_SUMMARY_QUEUE_STALE_AFTER_MS;
  const buildIsStale =
    summary.summaryStatus === "building" &&
    ((startedAtMs > 0 && (now - startedAtMs) > FIELD_SUMMARY_BUILD_STALE_AFTER_MS) ||
      (refreshedAtMs > 0 && (now - refreshedAtMs) > FIELD_SUMMARY_BUILD_STALE_AFTER_MS));

  if (!queuedIsStale && !buildIsStale) {
    return summary;
  }

  const fieldRecord = snapshotField || summary.field || await loadSnapshotField(installationKey, version, fieldId).catch(() => null);
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
    recoveredSummary.nextPageToken || ""
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
  const currentMeta = meta || await readSnapshotMeta(installationKey);
  const startedMs = currentMeta?.startedAt ? new Date(currentMeta.startedAt).getTime() : 0;
  const buildIsStuck =
    currentMeta?.state === "building" &&
    (!startedMs || (Date.now() - startedMs > 20 * 60 * 1000));

  if (!buildIsStuck) {
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
    await queueSnapshotBuild(installationKey);
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
  startAt = 0,
  nextPageToken = null,
  maxPages = PROJECT_USAGE_SCAN_PAGES_PER_JOB
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
    `Scanning up to ${(PROJECT_USAGE_ISSUE_SCAN_PAGE_SIZE * maxPages).toLocaleString()} matching issues for project usage`
  );

  let scan;
  try {
    scan = await getProjectBreakdownByIssueScan(
      fieldId,
      nextPageToken || existing.nextPageToken || null,
      maxPages
    );
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
  const estimatedIssueTotal = Number(scan.totalIssues || existing.estimatedIssueTotal || snapshotField.totalIssueCount || 0);
  const sourceIssueTotal = Number(snapshotField.totalIssueCount || existing.totalIssueCount || 0);
  const totalIssueCount = mergedProjects.reduce((sum, project) => sum + Number(project.issueCount || 0), 0);
  const isComplete = scan.isComplete || processedIssueCount >= estimatedIssueTotal;

  addJobLog(
    estimatedIssueTotal > 0
      ? `Processed ${processedIssueCount.toLocaleString()} of ${estimatedIssueTotal.toLocaleString()} matching issues`
      : `Processed ${processedIssueCount.toLocaleString()} matching issues`
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
      `Field scan pagination broke after ${processedIssueCount.toLocaleString()} of ${estimatedIssueTotal.toLocaleString()} issues; Jira did not return a continuation token`
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
        `Completed matching-issue scan but found 0 active projects despite ${sourceIssueTotal.toLocaleString()} populated issues`
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
    scan.nextPageToken || ""
  );

  if (!queueResult.queued) {
    addJobLog(
      `Automatic continuation could not be scheduled after ${processedIssueCount.toLocaleString()} scanned issues; job remains queued at checkpoint`
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
      `Scheduled continuation after ${processedIssueCount.toLocaleString()} scanned issues (${queueResult.attempts} queue attempts)`
    );
  }
}

// ----- processFieldUsageDelta -----

export async function processFieldUsageDelta(scopeKey, version, snapshotField, jobToken, projectKeys = [], windowHours = 24) {
  const fieldId = snapshotField.id;
  const existing = await loadFieldSummary(scopeKey, fieldId);
  if (!existing || existing.jobToken !== jobToken || existing.summaryStatus === "cancelled") {
    return;
  }

  const normalizedProjectKeys = Array.from(new Set((projectKeys || []).map((value) => String(value || "").trim()).filter(Boolean)));
  if (!normalizedProjectKeys.length) {
    await replaceFieldSummary(scopeKey, fieldId, {
      ...existing,
      refreshedAt: new Date().toISOString(),
      summaryStatus: "ready",
      completedAt: new Date().toISOString(),
      lastError: null,
      progressLog: [
        ...(existing.progressLog || []).slice(-80),
        { t: new Date().toISOString(), msg: `No affected projects were found for the last ${windowHours}h incremental refresh` },
      ].slice(-100),
    });
    return;
  }

  const progressLog = [...(existing.progressLog || [])];
  const addJobLog = (msg) => {
    progressLog.push({ t: new Date().toISOString(), msg });
    if (progressLog.length > 100) progressLog.shift();
  };

  addJobLog(`Started incremental project-usage refresh for ${snapshotField.name} across ${normalizedProjectKeys.length} affected projects`);
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

  const currentByProjectKey = new Map((existing.activeProjects || []).map((project) => [project.projectKey, { ...project }]));
  const refreshedProjects = await mapWithConcurrency(normalizedProjectKeys, 2, async (projectKey) => {
    const usage = await searchProjectFieldUsage(fieldId, projectKey);
    if (usage.issueCount <= 0) {
      return { projectKey, remove: true };
    }
    const prior = currentByProjectKey.get(projectKey);
    const project =
      usage.project
      || (prior ? { id: prior.projectId, key: prior.projectKey, name: prior.projectName } : { id: projectKey, key: projectKey, name: projectKey });
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

  const nextProjects = Array.from(currentByProjectKey.values())
    .sort((left, right) => Number(right.issueCount || 0) - Number(left.issueCount || 0) || left.projectKey.localeCompare(right.projectKey));
  const nextTotalIssueCount = nextProjects.reduce((sum, project) => sum + Number(project.issueCount || 0), 0);

  await replaceSnapshotProjectUsageForField(scopeKey, version, fieldId, nextProjects);
  await replaceFieldSummary(scopeKey, fieldId, {
    ...existing,
    refreshedAt: new Date().toISOString(),
    field: snapshotField,
    fieldJql: existing.fieldJql || snapshotField.fieldJql || buildOverallFieldJql(fieldId),
    configuredProjectCount: existing.configuredProjectCount ?? snapshotField.configuredProjectCount ?? snapshotField.usageCount ?? 0,
    totalIssueCount: Math.max(nextTotalIssueCount, Number(snapshotField.totalIssueCount || 0)),
    activeProjectCount: nextProjects.length,
    activeProjects: nextProjects,
    summaryStatus: "ready",
    completedAt: new Date().toISOString(),
    lastError: null,
    progressLog: [
      ...progressLog,
      { t: new Date().toISOString(), msg: `Incremental refresh complete for ${normalizedProjectKeys.length} affected projects` },
    ].slice(-100),
  });
  incrMetric(METRIC_NAMES.projectUsageDeltaCompleted);
}

// ----- buildProjectUsageRecord (re-exported from transform via jira-api) -----
import { buildProjectUsageRecord } from "./transform.js";

// ----- isExpiredPageTokenError (used locally) -----
function isExpiredPageTokenError(error) {
  return Number(error?.status) === 400 && String(error?.message || "").toLowerCase().includes("next page token");
}

// ----- runSnapshot -----

class CancelError extends Error {
  constructor() {
    super("Build cancelled by user");
    this.isCancelError = true;
  }
}

export async function runSnapshot(installationKey) {
  logger.info("snapshot.start", { installationKey });
  incrMetric(METRIC_NAMES.inventorySnapshot);
  const progressLog = [];
  let processedCount = 0;
  let skipCount = 0;
  let totalCount = 0;
  let progressInterval = null;
  let cancelled = false;
  let version = null;
  const pendingFieldRecords = [];

  // Reset telemetry for this invocation and expose logEntry to withRetry
  resetScanTelemetry();
  resetJiraRateLimiterState();

  function logEntry(msg) {
    const entry = { t: new Date().toISOString(), msg };
    progressLog.push(entry);
    if (progressLog.length > 200) progressLog.shift();
    console.log(`runSnapshot: ${msg}`);
  }
  setSnapshotLogger(logEntry);

  async function flushProgress() {
    try {
      await writeSnapshotMeta(installationKey, {
        processedFields: processedCount,
        totalFields: totalCount,
        progressLog: [...progressLog],
      });
    } catch {}
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
      const startedMs = existingMeta?.startedAt ? new Date(existingMeta.startedAt).getTime() : 0;
      const isStale = Date.now() - startedMs > 16 * 60 * 1000;
      if (!isStale) {
        console.log("runSnapshot: build already in progress, skipping duplicate");
        return;
      }
      if (existingMeta.buildingVersion) {
        version = existingMeta.buildingVersion;
        resuming = true;
        console.log(`runSnapshot: resuming stale build (version ${version})`);
      } else {
        console.log("runSnapshot: existing build had no version, starting fresh");
      }
    }

    if (!version) {
      version = String(Date.now());
      await clearSnapshotVersion(installationKey, version);
    }

    if (resuming && Array.isArray(existingMeta.progressLog)) {
      progressLog.push(...existingMeta.progressLog.slice(-80));
    }
    processedCount = resuming ? (existingMeta.processedFields || 0) : 0;

    await writeSnapshotMeta(installationKey, {
      state: "building",
      buildingVersion: version,
      startedAt: resuming ? existingMeta.startedAt : new Date().toISOString(),
      completedAt: null,
      lastError: null,
      processedFields: processedCount,
      progressLog: [...progressLog],
    });

    // Race-check: if multiple queue consumers started concurrently, only the last writer
    // of buildingVersion proceeds. Others detect the mismatch and exit cleanly.
    const raceCheck = await readSnapshotMeta(installationKey);
    if (raceCheck?.buildingVersion !== version) {
      console.log(`runSnapshot: lost startup race (our=${version} winner=${raceCheck?.buildingVersion}) — exiting`);
      return;
    }

    progressInterval = setInterval(() => {
      flushProgress().catch(() => {});
    }, SNAPSHOT_PROGRESS_FLUSH_INTERVAL_MS);

    const [customFields, systemFields] = await Promise.all([
      getAllCustomFields(),
      getAllSystemFields().catch(() => []),
    ]);
    const allFields = [
      ...customFields,
      ...systemFields.map((f) => ({ ...f, isSystemField: true })),
    ];
    totalCount = allFields.length;

    const nameCountMap = new Map();
    for (const field of allFields) {
      const key = normalizeFieldName(field.name);
      nameCountMap.set(key, (nameCountMap.get(key) || 0) + 1);
    }

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
          if (configuredProjectCount > 0 && getFieldNumericId(field.id)) {
            totalIssueCount = await getFieldTotalIssueCount(field.id);
          }
        }
        activeProjectCount = 0;
        const elapsed = Date.now() - t0;
        if (totalIssueCount > 0) {
          logEntry(`✓ ${fieldTag} — ${field.isSystemField ? "global" : `${configuredProjectCount} projects`}, ${totalIssueCount.toLocaleString()} issues (${elapsed}ms)`);
        } else if (totalIssueCount === -1) {
          logEntry(`⏱ ${fieldTag} — count timed out (${elapsed}ms)`);
        } else if (!field.isSystemField && configuredProjectCount > 0) {
          logEntry(`○ ${fieldTag} — ${configuredProjectCount} projects, 0 issues (${elapsed}ms)`);
        } else {
          logEntry(`— ${fieldTag} — 0 issues (${elapsed}ms)`);
        }
      } catch (usageErr) {
        const elapsed = Date.now() - t0;
        logEntry(`✗ ${fieldTag} — ERROR: ${usageErr?.message} (${elapsed}ms)`);
        console.warn(`runSnapshot: usage stats failed for ${field.id}: ${usageErr?.message}`);
      }

      // -1 means the count query timed out — store 0 so the record is valid,
      // governance findings won't fire for "unknown" fields
      const resolvedIssueCount = totalIssueCount < 0 ? 0 : totalIssueCount;

      const duplicateNameCount = nameCountMap.get(normalizeFieldName(field.name)) ?? 1;

      const findings = buildGovernanceFindings(field, {
        configuredProjectCount,
        totalIssueCount: resolvedIssueCount,
        activeProjectCount,
        duplicateNameCount,
        usageStatus: USAGE_STATUS_READY,
        usageStatusDetail: null,
        isSystemField: Boolean(field.isSystemField),
      });

      const record = buildInventoryRecord(field, {
        configuredProjectCount,
        activeProjectCount,
        totalIssueCount: resolvedIssueCount,
        usageStatus: USAGE_STATUS_READY,
        usageStatusDetail: null,
        findings,
      });

      // Write field record — per-project breakdown populated on-demand in getFieldDetails
      pendingFieldRecords.push(record);
      if (pendingFieldRecords.length >= SNAPSHOT_DB_BATCH_SIZE) {
        await flushPendingFieldRecords();
      }
      processedCount = skipCount + index + 1;
    });

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
      logEntry(`Filled ${fillResult.fieldsRestored} fields (${fillResult.rowsInserted} project rows) from field summaries`);
    }

    const refreshedAt = new Date().toISOString();
    clearInterval(progressInterval);
    progressInterval = null;

    await writeSnapshotMeta(installationKey, {
      state: "ready",
      version,
      buildingVersion: null,
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
      console.warn("pruneOldSnapshotVersions failed (non-fatal):", pruneErr?.message);
    }

    logger.info("snapshot.complete", { installationKey, version, processedFields: totalCount, skipped: skipCount });
    try {
      await inventorySnapshotQueue.push({ body: { jobType: "run-delta-issue-scan", installationKey } });
    } catch { /* non-critical */ }
  } catch (err) {
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
    // Before writing back, verify we still own the build slot.
    // A newer build may have taken over — don't clobber its state.
    const finalMeta = await readSnapshotMeta(installationKey).catch(() => null);
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
        }).catch(() => {});
      }
    } else {
      logger.error("snapshot.failed", { installationKey, version, error: err?.message });
      console.error("runSnapshot failed:", err?.message || err);
      if (stillOwner) {
        // Keep state as "building" (not "failed") so stale-build detection can resume
        await writeSnapshotMeta(installationKey, {
          state: "building",
          lastError: err?.message || String(err),
          processedFields: processedCount,
          progressLog: [...progressLog],
        }).catch(() => {});
      }
    }
  } finally {
    if (progressInterval) clearInterval(progressInterval);
    setSnapshotLogger(null);
  }
}
