// Project usage: per-project field usage jobs, saved reports, the usage report and the Projects view.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import {
  incrMetric,
  METRIC_NAMES,
  makeJobToken,
  getInstallationKey,
  getDistinctIssueCountForFields,
  collectRecentFieldProjectCandidates,
  PROJECTS_VIEW_PAGE_SIZE,
  MAX_ACTIVE_PROJECT_USAGE_JOBS,
  MAX_AUTOQUEUED_REPORT_FIELDS,
  MAX_AUTOQUEUED_REPORT_ISSUE_BUDGET,
  getBrowsableProjectIds,
} from "../lib/jira-api.js";
import {
  queueReportBuild,
  queueFieldSummaryContinuationWithRetry,
  queueFieldUsageDeltaRefreshWithRetry,
  processFieldSummaryChunk,
  queueProjectUsageRestore,
} from "../lib/snapshot-engine.js";
import {
  ensureProjectStoreReady,
  readSnapshotMeta,
  loadSnapshotField,
  loadAllSnapshotProjectUsage,
  loadAnySnapshotProjectUsage,
  listSnapshotProjects,
  loadProjectActivity,
  loadSnapshotProjectFields,
  loadFieldSummary,
  replaceFieldSummary,
  listFieldSummaries,
  replaceSnapshotProjectUsageForField,
  listSavedReports,
  saveSavedReport,
  deleteSavedReport,
  replaceReportJob,
  loadReportJob,
  readIssueScanMeta,
  readWorkflowSnapshotMeta,
  loadWorkflowSchemeProjects,
  loadWorkflowSchemeForProject,
} from "../lib/project-store.js";
import { attachUniqueIssueCounts } from "../lib/site-health.js";
import { summarizeAdoption } from "../lib/project-adoption.js";
import { summarizeProjectUsageCapacity, isJiraBuiltinField, filterProjectUsageByBrowsable } from "../lib/analysis.js";
import { buildFieldJql, buildOverallFieldJql } from "../lib/transform.js";
import { fallbackOn, logger, errorContext } from "../lib/logger.js";
import { requireNonEmptyString, requirePositiveInt, requireArray, optionalString } from "../lib/validate.js";

export async function getProjectUsageJobs({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const jobs = await listFieldSummaries(installationKey, 200);

  return {
    jobs: jobs.map((job, index) => ({
      fieldId: job.fieldId || jobs[index]?.fieldId,
      fieldName: job.field?.name || job.fieldId,
      fieldType: job.field?.type || "unknown",
      summaryStatus: job.summaryStatus,
      configuredProjectCount: job.configuredProjectCount,
      activeProjectCount: job.activeProjectCount,
      totalIssueCount: job.totalIssueCount,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      refreshedAt: job.refreshedAt,
      lastError: job.lastError,
      progressLog: job.progressLog || [],
      processedIssueCount: job.processedIssueCount || 0,
      estimatedIssueTotal: job.estimatedIssueTotal || 0,
      nextStartAt: job.nextStartAt || 0,
      percentComplete:
        job.estimatedIssueTotal > 0
          ? Math.min(100, Math.round(((job.processedIssueCount || 0) / job.estimatedIssueTotal) * 100))
          : job.summaryStatus === "ready"
            ? 100
            : 0,
    })),
  };
}

export async function refreshRecentProjectUsage({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    throw new Error("No completed snapshot available â€” build one first.");
  }

  const hours = Math.max(1, Math.min(168, Math.trunc(Number(payload?.hours)) || 24));
  const maxIssues = Math.max(50, Math.min(2000, Math.trunc(Number(payload?.maxIssues)) || 500));
  const recent = await collectRecentFieldProjectCandidates(hours, maxIssues);
  const allSummaries = await listFieldSummaries(installationKey, 5000).catch(
    fallbackOn("resolver.summaries_load_failed", () => [], { installationKey }),
  );
  const summaryByFieldId = new Map(allSummaries.map((summary) => [summary.fieldId, summary]));

  let queuedCount = 0;
  let fullRebuildCount = 0;
  for (const candidate of recent.fields) {
    const fieldId = String(candidate.fieldId || "").trim();
    if (!fieldId) continue;

    const snapshotField = await loadSnapshotField(installationKey, meta.version, fieldId).catch(
      fallbackOn("resolver.snapshot_field_load_failed", null, { fieldId }),
    );
    if (!snapshotField) continue;

    const summary = summaryByFieldId.get(fieldId) || null;
    if (!summary || summary.summaryStatus !== "ready") {
      const queued = await ensureProjectUsageJobQueued(installationKey, meta.version, snapshotField, summary);
      if (queued.queued) {
        queuedCount++;
        fullRebuildCount++;
      }
      continue;
    }

    const jobToken = makeJobToken();
    await replaceFieldSummary(installationKey, fieldId, {
      ...summary,
      refreshedAt: new Date().toISOString(),
      field: summary.field || snapshotField,
      fieldJql: summary.fieldJql || snapshotField.fieldJql || buildOverallFieldJql(fieldId),
      summaryStatus: "queued",
      completedAt: null,
      lastError: null,
      progressLog: [
        ...(summary.progressLog || []).slice(-80),
        {
          t: new Date().toISOString(),
          msg: `Queued incremental project-usage refresh from issues updated in the last ${hours}h`,
        },
      ].slice(-100),
      jobToken,
    });

    const queueResult = await queueFieldUsageDeltaRefreshWithRetry(
      installationKey,
      meta.version,
      fieldId,
      jobToken,
      candidate.projectKeys,
      hours,
    );

    if (!queueResult.queued) {
      await replaceFieldSummary(installationKey, fieldId, {
        ...summary,
        refreshedAt: new Date().toISOString(),
        field: summary.field || snapshotField,
        fieldJql: summary.fieldJql || snapshotField.fieldJql || buildOverallFieldJql(fieldId),
        summaryStatus: "deferred",
        completedAt: summary.completedAt || null,
        lastError: null,
        progressLog: [
          ...(summary.progressLog || []).slice(-80),
          {
            t: new Date().toISOString(),
            msg: `Deferred incremental refresh after ${queueResult.attempts || 1} queue attempts`,
          },
        ].slice(-100),
        jobToken,
      });
      continue;
    }

    queuedCount++;
  }

  return {
    queuedCount,
    fullRebuildCount,
    scannedIssues: recent.scannedIssues,
    changedFieldCount: recent.fields.length,
    windowHours: hours,
  };
}

export async function cancelProjectUsageJob({ payload, context }) {
  await ensureProjectStoreReady();
  const fieldId = String(payload?.fieldId || "").trim();
  if (!fieldId) throw new Error("fieldId is required");

  const installationKey = getInstallationKey(context);
  const existing = await loadFieldSummary(installationKey, fieldId);
  if (!existing) {
    return { cancelled: false, reason: "not-found" };
  }

  await replaceFieldSummary(installationKey, fieldId, {
    ...existing,
    summaryStatus: "cancelled",
    completedAt: new Date().toISOString(),
    progressLog: [...(existing.progressLog || []), { t: new Date().toISOString(), msg: "Job cancelled by user" }],
  });

  return { cancelled: true };
}

export async function restartProjectUsageJob({ payload, context }) {
  await ensureProjectStoreReady();
  const fieldId = String(payload?.fieldId || "").trim();
  if (!fieldId) throw new Error("fieldId is required");

  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    throw new Error("No completed snapshot available â€” build one first.");
  }

  const snapshotField = await loadSnapshotField(installationKey, meta.version, fieldId);
  if (!snapshotField) {
    throw new Error(`Field not found in snapshot: ${fieldId}`);
  }

  const jobToken = makeJobToken();
  await replaceSnapshotProjectUsageForField(installationKey, meta.version, fieldId, []);
  await replaceFieldSummary(installationKey, fieldId, {
    refreshedAt: new Date().toISOString(),
    field: snapshotField,
    fieldJql: snapshotField.fieldJql || buildOverallFieldJql(fieldId),
    configuredProjectCount: snapshotField.configuredProjectCount ?? snapshotField.usageCount ?? 0,
    hasGlobalContext: false,
    activeProjectCount: 0,
    totalIssueCount: snapshotField.totalIssueCount ?? 0,
    activeProjects: [],
    contexts: [],
    findings: snapshotField.findings || null,
    summaryStatus: "queued",
    startedAt: null,
    completedAt: null,
    lastError: null,
    progressLog: [{ t: new Date().toISOString(), msg: "Queued fresh project-usage background job" }],
    jobToken,
    processedIssueCount: 0,
    estimatedIssueTotal: snapshotField.totalIssueCount ?? 0,
    nextStartAt: 0,
    nextPageToken: null,
  });
  await processFieldSummaryChunk(installationKey, meta.version, snapshotField, jobToken, 0, null, 1);

  return { queued: true, fieldId };
}

export async function resumeProjectUsageJob({ payload, context }) {
  await ensureProjectStoreReady();
  const fieldId = String(payload?.fieldId || "").trim();
  if (!fieldId) throw new Error("fieldId is required");

  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    throw new Error("No completed snapshot available â€” build one first.");
  }

  const [snapshotField, existing] = await Promise.all([
    loadSnapshotField(installationKey, meta.version, fieldId),
    loadFieldSummary(installationKey, fieldId),
  ]);
  if (!snapshotField) {
    throw new Error(`Field not found in snapshot: ${fieldId}`);
  }
  if (!existing) {
    throw new Error(`No existing project-usage job state found for ${fieldId}`);
  }
  if (existing.summaryStatus === "queued" || existing.summaryStatus === "building") {
    return { queued: false, fieldId, reason: "already-running" };
  }

  const jobToken = makeJobToken();
  const resumedSummary = {
    ...existing,
    refreshedAt: new Date().toISOString(),
    field: snapshotField,
    fieldJql: existing.fieldJql || snapshotField.fieldJql || buildOverallFieldJql(fieldId),
    configuredProjectCount:
      existing.configuredProjectCount ?? snapshotField.configuredProjectCount ?? snapshotField.usageCount ?? 0,
    totalIssueCount: Math.max(existing.totalIssueCount ?? 0, snapshotField.totalIssueCount ?? 0),
    findings: existing.findings || snapshotField.findings || null,
    summaryStatus: "queued",
    completedAt: null,
    lastError: null,
    progressLog: [
      ...(existing.progressLog || []).slice(-80),
      {
        t: new Date().toISOString(),
        msg: `Resuming project-usage build from ${Number(existing.processedIssueCount || 0).toLocaleString()} scanned issues`,
      },
    ].slice(-100),
    jobToken,
  };

  await replaceFieldSummary(installationKey, fieldId, resumedSummary);
  await processFieldSummaryChunk(
    installationKey,
    meta.version,
    snapshotField,
    jobToken,
    Number(existing.processedIssueCount || existing.nextStartAt || 0),
    existing.nextPageToken || null,
    1,
  );

  return {
    queued: true,
    fieldId,
    resumedFrom: Number(existing.processedIssueCount || 0),
  };
}

export async function ensureProjectUsageJobQueued(installationKey, version, snapshotField, existingSummary = null) {
  if (!snapshotField?.id) {
    return { queued: false, reason: "missing-field" };
  }

  if (Number(snapshotField.totalIssueCount || 0) <= 0) {
    return { queued: false, reason: "no-issues" };
  }

  const fieldId = snapshotField.id;
  const summary =
    existingSummary ||
    (await loadFieldSummary(installationKey, fieldId).catch(
      fallbackOn("resolver.field_summary_load_failed", null, { fieldId }),
    ));
  if (summary?.summaryStatus === "queued" || summary?.summaryStatus === "building") {
    return { queued: false, reason: "already-running" };
  }

  const jobToken = makeJobToken();
  await replaceSnapshotProjectUsageForField(installationKey, version, fieldId, []);
  await replaceFieldSummary(installationKey, fieldId, {
    refreshedAt: new Date().toISOString(),
    field: snapshotField,
    fieldJql: snapshotField.fieldJql || buildOverallFieldJql(fieldId),
    configuredProjectCount: snapshotField.configuredProjectCount ?? snapshotField.usageCount ?? 0,
    hasGlobalContext: false,
    activeProjectCount: 0,
    totalIssueCount: snapshotField.totalIssueCount ?? 0,
    activeProjects: [],
    contexts: summary?.contexts || [],
    findings: snapshotField.findings || null,
    summaryStatus: "queued",
    startedAt: null,
    completedAt: null,
    lastError: null,
    progressLog: [
      ...(summary?.progressLog || []).slice(-40),
      { t: new Date().toISOString(), msg: "Queued project-usage build for report generation" },
    ],
    jobToken,
    processedIssueCount: 0,
    estimatedIssueTotal: snapshotField.totalIssueCount ?? 0,
    nextStartAt: 0,
    nextPageToken: null,
  });
  const queueResult = await queueFieldSummaryContinuationWithRetry(installationKey, version, fieldId, jobToken, 0, "");
  if (!queueResult.queued) {
    await replaceFieldSummary(installationKey, fieldId, {
      refreshedAt: new Date().toISOString(),
      field: snapshotField,
      fieldJql: snapshotField.fieldJql || buildOverallFieldJql(fieldId),
      configuredProjectCount: snapshotField.configuredProjectCount ?? snapshotField.usageCount ?? 0,
      hasGlobalContext: false,
      activeProjectCount: 0,
      totalIssueCount: snapshotField.totalIssueCount ?? 0,
      activeProjects: [],
      contexts: summary?.contexts || [],
      findings: snapshotField.findings || null,
      summaryStatus: "deferred",
      startedAt: null,
      completedAt: null,
      lastError: null,
      progressLog: [
        ...(summary?.progressLog || []).slice(-40),
        {
          t: new Date().toISOString(),
          msg: `Queue backpressure hit while starting project-usage build after ${queueResult.attempts || 1} queue attempt${(queueResult.attempts || 1) === 1 ? "" : "s"}; job deferred`,
        },
      ],
      jobToken,
      processedIssueCount: 0,
      estimatedIssueTotal: snapshotField.totalIssueCount ?? 0,
      nextStartAt: 0,
      nextPageToken: null,
    });
    return { queued: false, reason: "queue-backpressure" };
  }
  return { queued: true, reason: "queued" };
}

export async function ensureDeferredProjectUsageJobRecorded(
  installationKey,
  snapshotField,
  existingSummary = null,
  reason = "deferred",
) {
  if (!snapshotField?.id) {
    return;
  }

  const fieldId = snapshotField.id;
  const summary =
    existingSummary ||
    (await loadFieldSummary(installationKey, fieldId).catch(
      fallbackOn("resolver.field_summary_load_failed", null, { fieldId }),
    ));
  if (
    summary?.summaryStatus === "queued" ||
    summary?.summaryStatus === "building" ||
    summary?.summaryStatus === "ready"
  ) {
    return;
  }

  const reasonMessages = {
    "deferred-active-job-cap": "Deferred project-usage build because the active job cap has been reached",
    "deferred-field-cap": "Deferred project-usage build because the per-report field queue cap has been reached",
    "deferred-issue-budget": "Deferred project-usage build because the report issue budget has been reached",
    "queue-backpressure": "Deferred project-usage build because the Forge queue is under backpressure",
  };

  await replaceFieldSummary(installationKey, fieldId, {
    refreshedAt: new Date().toISOString(),
    field: snapshotField,
    fieldJql: snapshotField.fieldJql || buildOverallFieldJql(fieldId),
    configuredProjectCount: snapshotField.configuredProjectCount ?? snapshotField.usageCount ?? 0,
    hasGlobalContext: false,
    activeProjectCount: summary?.activeProjectCount ?? 0,
    totalIssueCount: snapshotField.totalIssueCount ?? summary?.totalIssueCount ?? 0,
    activeProjects: summary?.activeProjects || [],
    contexts: summary?.contexts || [],
    findings: summary?.findings || snapshotField.findings || null,
    summaryStatus: "deferred",
    startedAt: summary?.startedAt || null,
    completedAt: summary?.completedAt || null,
    lastError: null,
    progressLog: [
      ...(summary?.progressLog || []).slice(-40),
      {
        t: new Date().toISOString(),
        msg: reasonMessages[reason] || "Deferred project-usage build for later execution",
      },
    ].slice(-100),
    jobToken: summary?.jobToken || makeJobToken(),
    processedIssueCount: Number(summary?.processedIssueCount || 0),
    estimatedIssueTotal: snapshotField.totalIssueCount ?? summary?.estimatedIssueTotal ?? 0,
    nextStartAt: Number(summary?.nextStartAt || summary?.processedIssueCount || 0),
    nextPageToken: summary?.nextPageToken || null,
  });
}

export async function getSavedReports({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const reports = await listSavedReports(installationKey);
  return { reports };
}

export async function saveReportDefinition({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  // Input validation
  requireNonEmptyString(payload?.name, "name");
  if ((payload?.name || "").trim().length > 200) throw new Error("name must not exceed 200 characters");
  const rawFieldIds = requireArray(payload?.fieldIds, "fieldIds");
  if (rawFieldIds.length < 1) throw new Error("fieldIds must contain at least 1 element");
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const name = String(payload?.name || "").trim();
  const fieldIds = Array.from(
    new Set((payload?.fieldIds || []).map((value) => String(value || "").trim()).filter(Boolean)),
  );
  const reportId = String(payload?.reportId || "").trim() || makeJobToken();

  if (!name) throw new Error("Report name is required.");
  if (!fieldIds.length) throw new Error("Select at least one field to save a report.");

  const existingReports = await listSavedReports(installationKey);
  const existing = existingReports.find((report) => report.reportId === reportId);
  await saveSavedReport(installationKey, {
    reportId,
    name,
    fieldIds,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  return getSavedReports({ context });
}

export async function deleteReportDefinition({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  // Input validation
  requireNonEmptyString(payload?.reportId, "reportId");
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const reportId = String(payload?.reportId || "").trim();
  if (!reportId) throw new Error("reportId is required");

  await deleteSavedReport(installationKey, reportId);
  return getSavedReports({ context });
}

export async function getProjectUsageReport({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const fieldIds = Array.from(
    new Set((payload?.fieldIds || []).map((value) => String(value || "").trim()).filter(Boolean)),
  );
  if (!fieldIds.length) {
    return { fields: [], projects: [] };
  }

  // Optional project scope. When a report is built from a set of screens, the only projects
  // worth showing are the ones those screens are actually applied to -- every other column
  // would be a field this report has nothing to say about. An empty/absent list means "no
  // scope", the report's original site-wide behaviour.
  const scopeProjectIds = new Set(
    (payload?.projectIds || []).map((value) => String(value || "").trim()).filter(Boolean),
  );

  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    throw new Error("No completed snapshot available â€” build one first.");
  }

  const pendingFields = [];
  const allSummaries = await listFieldSummaries(installationKey, 5000).catch(
    fallbackOn("resolver.summaries_load_failed", () => [], { installationKey }),
  );
  const summaryByFieldId = new Map(allSummaries.map((summary) => [summary.fieldId, summary]));
  const queueCandidates = [];
  const rows = await Promise.all(
    fieldIds.map(async (fieldId) => {
      const [field, projectUsage, fieldSummary] = await Promise.all([
        loadSnapshotField(installationKey, meta.version, fieldId),
        loadAllSnapshotProjectUsage(installationKey, meta.version, fieldId),
        loadFieldSummary(installationKey, fieldId).catch(
          fallbackOn("resolver.field_summary_load_failed", () => summaryByFieldId.get(fieldId) || null, { fieldId }),
        ),
      ]);
      if (!field) {
        return null;
      }

      // Fallback chain when current-version snapshot_project_usage is empty:
      // 1. Any-version snapshot data (handles post-migration version mismatch)
      // 2. field_summaries.activeProjects (populated by Field Usage Jobs)
      let finalProjects = projectUsage;
      if (!finalProjects.length) {
        finalProjects = await loadAnySnapshotProjectUsage(installationKey, fieldId).catch(
          fallbackOn("resolver.any_project_usage_load_failed", () => [], { fieldId }),
        );
      }
      if (!finalProjects.length) {
        finalProjects = (fieldSummary?.activeProjects || []).map((p) => ({
          projectId: p.projectId,
          projectKey: p.projectKey,
          projectName: p.projectName,
          issueCount: p.issueCount || 0,
          jql: p.jql || buildFieldJql(fieldId, p.projectKey),
          latestFieldChangeAt: null,
          latestIssueKey: null,
          latestIssueUpdatedAt: null,
        }));
      }

      const derivedTotalIssueCount =
        field.totalIssueCount ||
        fieldSummary?.totalIssueCount ||
        finalProjects.reduce((s, p) => s + (p.issueCount || 0), 0) ||
        0;

      if (!finalProjects.length && derivedTotalIssueCount > 0) {
        if (fieldSummary?.summaryStatus === "queued" || fieldSummary?.summaryStatus === "building") {
          pendingFields.push({
            fieldId: field.id,
            fieldName: field.name,
            summaryStatus: fieldSummary.summaryStatus,
            reason: "already-running",
          });
        } else {
          queueCandidates.push({
            field,
            fieldSummary,
            issueCount: derivedTotalIssueCount,
          });
        }
      }

      return {
        fieldId: field.id,
        fieldName: field.name,
        fieldType: field.type,
        totalIssueCount: derivedTotalIssueCount,
        activeProjectCount: field.activeProjectCount || finalProjects.length || 0,
        fieldJql: field.fieldJql || buildOverallFieldJql(field.id),
        projects: finalProjects,
      };
    }),
  );

  const queueCapacity = summarizeProjectUsageCapacity(allSummaries);
  let runningJobCount = queueCapacity.runningJobCount;
  let runningIssueBudget = queueCapacity.runningIssueBudget;
  let newlyQueuedFieldCount = 0;
  let newlyQueuedIssueBudget = 0;
  const sortedCandidates = queueCandidates.sort(
    (left, right) => left.issueCount - right.issueCount || left.field.name.localeCompare(right.field.name),
  );

  for (const candidate of sortedCandidates) {
    const candidateIssueCount = candidate.issueCount;
    let reason = null;

    if (runningJobCount >= MAX_ACTIVE_PROJECT_USAGE_JOBS) {
      reason = "deferred-active-job-cap";
    } else if (newlyQueuedFieldCount >= MAX_AUTOQUEUED_REPORT_FIELDS) {
      reason = "deferred-field-cap";
    } else if (
      runningIssueBudget + newlyQueuedIssueBudget + candidateIssueCount > MAX_AUTOQUEUED_REPORT_ISSUE_BUDGET &&
      (newlyQueuedFieldCount > 0 || runningJobCount > 0)
    ) {
      reason = "deferred-issue-budget";
    }

    if (reason) {
      await ensureDeferredProjectUsageJobRecorded(installationKey, candidate.field, candidate.fieldSummary, reason);
      pendingFields.push({
        fieldId: candidate.field.id,
        fieldName: candidate.field.name,
        summaryStatus: "deferred",
        reason,
      });
      continue;
    }

    const queued = await ensureProjectUsageJobQueued(
      installationKey,
      meta.version,
      candidate.field,
      candidate.fieldSummary,
    );

    if (queued.queued) {
      pendingFields.push({
        fieldId: candidate.field.id,
        fieldName: candidate.field.name,
        summaryStatus: "queued",
        reason: "project-usage-missing",
      });
      runningJobCount++;
      runningIssueBudget += candidateIssueCount;
      newlyQueuedFieldCount++;
      newlyQueuedIssueBudget += candidateIssueCount;
      continue;
    }

    pendingFields.push({
      fieldId: candidate.field.id,
      fieldName: candidate.field.name,
      summaryStatus: queued.reason === "already-running" ? "queued" : "deferred",
      reason: queued.reason || "project-usage-missing",
    });
  }

  let fields = rows.filter(Boolean);

  // Narrow every field to the scoped projects, and recompute the two per-field totals from
  // what is left so the row does not show a site-wide count beside scoped cells. A field with
  // no usage in scope stays in the report as a zero row -- it IS on one of the chosen
  // screens, and "on the form, never filled" is exactly the finding this view exists for.
  if (scopeProjectIds.size) {
    fields = fields.map((field) => {
      const scoped = field.projects.filter((p) => scopeProjectIds.has(String(p.projectId)));
      return {
        ...field,
        projects: scoped,
        activeProjectCount: scoped.length,
        totalIssueCount: scoped.reduce((sum, p) => sum + (p.issueCount || 0), 0),
      };
    });
  }

  const projectMap = new Map();

  // Under a scope, seed the columns from the scope itself, not just from projects that
  // happened to have a usage row -- otherwise a scoped project where none of these fields
  // are filled drops out of the matrix, which is the opposite of what the report is for.
  if (scopeProjectIds.size && meta?.version) {
    const scoped = await listSnapshotProjects(installationKey, meta.version).catch(
      fallbackOn("report.scope_projects_load_failed", () => [], { installationKey }),
    );
    for (const project of scoped) {
      if (scopeProjectIds.has(String(project.projectId))) {
        projectMap.set(String(project.projectId), {
          projectId: String(project.projectId),
          projectKey: project.projectKey,
          projectName: project.projectName,
        });
      }
    }
  }

  for (const field of fields) {
    for (const project of field.projects) {
      if (!projectMap.has(project.projectId)) {
        projectMap.set(project.projectId, {
          projectId: project.projectId,
          projectKey: project.projectKey,
          projectName: project.projectName,
        });
      }
    }
  }

  const projects = Array.from(projectMap.values()).sort(
    (left, right) =>
      left.projectKey.localeCompare(right.projectKey) || left.projectName.localeCompare(right.projectName),
  );

  const uniqueIssueCount = await getDistinctIssueCountForFields(fields.map((field) => field.fieldId));

  // Never surface a project's identity to a viewer who lacks Browse Projects on
  // it -- one bulk permission check for every project touched by this report.
  const browsableProjectIds = await getBrowsableProjectIds(
    context?.accountId,
    projects.map((p) => p.projectId),
  );
  const filtered = filterProjectUsageByBrowsable(
    { fields, projects, pendingFields, uniqueIssueCount },
    browsableProjectIds,
  );

  return filtered;
}

export async function startProjectUsageReportJob({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  // Input validation
  const rawFieldIds = requireArray(payload?.fieldIds, "fieldIds");
  if (rawFieldIds.length < 1) throw new Error("fieldIds must contain at least 1 element");
  await ensureProjectStoreReady();
  const fieldIds = Array.from(
    new Set((payload?.fieldIds || []).map((value) => String(value || "").trim()).filter(Boolean)),
  );
  if (!fieldIds.length) {
    throw new Error("Select at least one field for the report.");
  }

  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    throw new Error("No completed snapshot available â€” build one first.");
  }

  const jobId = makeJobToken();
  const reportName = String(payload?.reportName || "").trim() || "Project Usage Report";
  await replaceReportJob(installationKey, jobId, {
    reportName,
    status: "queued",
    fieldIds,
    processedFields: 0,
    totalFields: fieldIds.length,
    nextOffset: 0,
    startedAt: null,
    completedAt: null,
    refreshedAt: new Date().toISOString(),
    lastError: null,
    progressLog: [
      { t: new Date().toISOString(), msg: `Queued report build for ${fieldIds.length.toLocaleString()} fields` },
    ],
    result: { fields: [], projects: [], pendingFields: [], uniqueIssueCount: null },
  });
  await queueReportBuild(installationKey, meta.version, jobId);
  return { jobId };
}

export async function getProjectUsageReportJob({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const jobId = String(payload?.jobId || "").trim();
  if (!jobId) {
    return { job: null };
  }
  const job = await loadReportJob(installationKey, jobId);
  if (!job) {
    return { job: null };
  }

  // Filter at READ time using the CURRENT caller's own permissions, not the
  // admin who originally started the job -- this is the only enforcement point
  // for stored report results, since the same job can be read by many
  // different people (with different Browse Projects access) over time.
  const candidateProjectIds = (job.result?.projects || []).map((p) => p.projectId);
  const browsableProjectIds = await getBrowsableProjectIds(context?.accountId, candidateProjectIds);
  const filteredResult = job.result ? filterProjectUsageByBrowsable(job.result, browsableProjectIds) : job.result;

  return {
    job: {
      ...job,
      result: filteredResult,
      percentComplete:
        job.totalFields > 0 ? Math.min(100, Math.round((job.processedFields / job.totalFields) * 100)) : 0,
    },
  };
}

export async function getProjectsView({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  // Input validation
  if (payload?.page !== undefined && payload?.page !== null) requirePositiveInt(payload.page, "page");
  optionalString(payload?.projectId, "projectId");
  optionalString(payload?.fieldType, "fieldType");
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    return {
      projects: [],
      availableTypes: [],
      selectedProject: null,
      fields: [],
      totalFields: 0,
      page: 1,
      totalPages: 1,
      pageSize: PROJECTS_VIEW_PAGE_SIZE,
      refreshedAt: null,
    };
  }

  const projectQuery = String(payload?.projectQuery || "").trim();
  const fieldQuery = String(payload?.fieldQuery || "").trim();
  const fieldType = String(payload?.fieldType || "all").trim() || "all";
  const sortBy = String(payload?.sortBy || "issues-desc").trim() || "issues-desc";
  const requestedPage = Math.max(1, Math.trunc(Number(payload?.page)) || 1);

  const [rawProjects, issueScanMeta] = await Promise.all([
    listSnapshotProjects(installationKey, meta.version, projectQuery),
    readIssueScanMeta(installationKey).catch(fallbackOn("resolver.scan_meta_read_failed", null, { installationKey })),
  ]);

  // ProjectsTab has always been written to prefer uniqueIssueCount and fall back to
  // "fills" -- but nothing ever populated it, so the fallback was permanent and the
  // correct branch was unreachable. Attach it here.
  const allProjects = await attachUniqueIssueCounts(installationKey, rawProjects);

  // Adoption for every project the rail can show, so it can be sorted and filtered by it.
  // Best-effort: a site scanned before issue dates were captured renders the rail exactly as
  // it does today, with the adoption panel reporting itself unmeasured.
  const activity = await loadProjectActivity(installationKey).catch(
    fallbackOn("projects.activity_load_failed", () => new Map(), { installationKey }),
  );

  // Only show projects the CALLING user actually has Browse Projects
  // permission on -- never surface another project's name/existence to
  // someone who can't see it in Jira itself.
  const browsableProjectIds = await getBrowsableProjectIds(
    context?.accountId,
    allProjects.map((p) => p.projectId),
  );
  const projects = allProjects.filter((p) => browsableProjectIds.has(String(p.projectId)));

  // Scored across the projects the reader may browse, not across the site.
  //
  // A percentile is only meaningful against a population, and the population a reader can
  // reason about is the one in front of them. Scoring against every project on the site would
  // put a project in the 90th percentile of a list they cannot see the rest of.
  const adoption = summarizeAdoption(projects, activity);
  const adoptionByProject = new Map(adoption.projects.map((row) => [String(row.projectId), row]));

  const selectedProjectId = String(payload?.projectId || "").trim() || projects[0]?.projectId || "";
  const selectedProject = projects.find((project) => project.projectId === selectedProjectId) || projects[0] || null;
  // The rail carries only what it sorts and filters on. The monthly series is per selected
  // project, because 200 projects' worth of history is not a sidebar.
  const railAdoption = (project) => {
    const row = adoptionByProject.get(String(project.projectId));
    if (!row?.measured) return null;
    return {
      score: row.score,
      issuesPerDay: row.issuesPerDay,
      recentIssuesPerDay: row.recentIssuesPerDay,
      momentum: row.momentum,
      ageDays: row.ageDays,
      firstIssueCreatedAt: row.firstIssueCreatedAt,
      // Decline flags are held back site-wide while the activity histogram is stale -- the
      // same suppression summarizeAdoption applies to the headline counts, carried to the
      // rail so it does not paint every project with a "fell off" tag the data cannot support.
      fellOff: adoption.dataStale ? false : row.fellOff,
      neverAdopted: adoption.dataStale ? false : row.neverAdopted,
      declineFrom: adoption.dataStale ? null : row.declineFrom,
    };
  };

  if (!selectedProject) {
    return {
      projects: [],
      availableTypes: [],
      selectedProject: null,
      fields: [],
      totalFields: 0,
      page: 1,
      totalPages: 1,
      pageSize: PROJECTS_VIEW_PAGE_SIZE,
      refreshedAt: meta.refreshedAt || null,
      issueScan: issueScanMeta
        ? {
            state: issueScanMeta.state,
            completedAt: issueScanMeta.completedAt,
            totalIssues: issueScanMeta.totalIssues,
            processedIssues: issueScanMeta.processedIssues,
            totalPages: issueScanMeta.totalPages,
            processedPages: issueScanMeta.processedPages,
            lastError: issueScanMeta.lastError,
          }
        : null,
    };
  }

  const offset = (requestedPage - 1) * PROJECTS_VIEW_PAGE_SIZE;
  const projectFieldsResult = await loadSnapshotProjectFields(
    installationKey,
    meta.version,
    selectedProject.projectId,
    {
      query: fieldQuery,
      type: fieldType,
      sortBy,
      limit: PROJECTS_VIEW_PAGE_SIZE,
      offset,
    },
  );

  // Which workflow scheme governs the selected project, and how many other projects
  // share it. Best-effort: the workflow snapshot is versioned independently of the field
  // snapshot and may not have been built at all, in which case the Projects tab simply
  // omits the panel rather than erroring. Never let a missing workflow snapshot break
  // the field view, which is the reason anyone opened this tab.
  const workflowScheme = await (async () => {
    try {
      const wfMeta = await readWorkflowSnapshotMeta(installationKey);
      if (!wfMeta?.version) return null;

      const scheme = await loadWorkflowSchemeForProject(installationKey, wfMeta.version, selectedProject.projectId);
      if (!scheme) return null;

      // Sharing count is computed from the projects the VIEWER can browse, matching the
      // enforcement in getWorkflowInventory -- otherwise "shared with 12 projects" leaks
      // the existence of projects this user cannot see.
      const schemeProjects = await loadWorkflowSchemeProjects(installationKey, wfMeta.version, scheme.schemeId);
      const browsable = await getBrowsableProjectIds(
        context?.accountId,
        schemeProjects.map((p) => p.projectId),
      );
      const visible = schemeProjects.filter((p) => browsable.has(String(p.projectId)));

      return {
        schemeId: scheme.schemeId,
        name: scheme.name,
        description: scheme.description,
        sharedWithCount: Math.max(0, visible.length - 1),
        siblingProjects: visible
          .filter((p) => String(p.projectId) !== String(selectedProject.projectId))
          .slice(0, 12)
          .map((p) => ({ projectId: p.projectId, projectKey: p.projectKey, projectName: p.projectName })),
        refreshedAt: wfMeta.refreshedAt || null,
      };
    } catch (error) {
      logger.warn("getProjectsView.workflow_scheme_lookup_failed", errorContext(error));
      return null;
    }
  })();

  const fields = projectFieldsResult.rows.map((field) => ({
    fieldId: field.fieldId,
    fieldName: field.fieldName,
    description: field.description,
    fieldType: field.fieldType,
    configuredProjectCount: field.configuredProjectCount,
    totalIssueCount: field.totalIssueCount,
    activeProjectCount: field.activeProjectCount,
    issueCount: field.issueCount,
    jql: field.jql || buildFieldJql(selectedProject.projectKey, field.fieldId),
    latestFieldChangeAt: field.latestFieldChangeAt,
    latestIssueKey: field.latestIssueKey,
    latestIssueUpdatedAt: field.latestIssueUpdatedAt,
    findings: field.findings || null,
    isJiraBuiltin: isJiraBuiltinField({ customType: field.customType }),
  }));

  const availableTypes = Array.from(
    new Set(projectFieldsResult.rows.map((field) => field.fieldType).filter(Boolean)),
  ).sort((left, right) => left.localeCompare(right));
  const totalFields = Number(projectFieldsResult.total || 0);
  const totalPages = Math.max(1, Math.ceil(totalFields / PROJECTS_VIEW_PAGE_SIZE));

  return {
    projects: projects.map((project) => ({ ...project, adoption: railAdoption(project) })),
    availableTypes,
    selectedProject,
    // The selected project's adoption in full, monthly series included. This is what dates a
    // decline: "fell off in 2023-04" comes from the shape, not from a single number.
    selectedAdoption: selectedProject ? (adoptionByProject.get(String(selectedProject.projectId)) ?? null) : null,
    // What normal looks like here, so a rate has something to be read against.
    adoptionContext: {
      available: adoption.available,
      medianIssuesPerDay: adoption.medianIssuesPerDay,
      measuredProjects: adoption.measuredProjects,
      totalProjects: adoption.totalProjects,
      // So the panel can say "activity data ends 2026-01, the last scan didn't finish"
      // instead of presenting a stale recent rate as a measurement.
      dataThroughMonth: adoption.dataThroughMonth,
      dataStale: adoption.dataStale,
    },
    workflowScheme,
    fields,
    totalFields,
    page: Math.min(requestedPage, totalPages),
    totalPages,
    pageSize: PROJECTS_VIEW_PAGE_SIZE,
    refreshedAt: meta.refreshedAt || null,
    issueScan: issueScanMeta
      ? {
          state: issueScanMeta.state,
          completedAt: issueScanMeta.completedAt,
          totalIssues: issueScanMeta.totalIssues,
          processedIssues: issueScanMeta.processedIssues,
          totalPages: issueScanMeta.totalPages,
          processedPages: issueScanMeta.processedPages,
          lastError: issueScanMeta.lastError,
        }
      : null,
  };
}

export async function restoreProjectUsageCache({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    return { started: false, reason: "no-snapshot" };
  }
  await queueProjectUsageRestore(installationKey, meta.version);
  return { started: true, version: meta.version };
}
