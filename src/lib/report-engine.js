import {
  incrMetric,
  METRIC_NAMES,
  getDistinctIssueCountForFields,
  REPORT_JOB_FIELD_BATCH_SIZE,
} from "./jira-api.js";
import {
  loadSnapshotField,
  loadAllSnapshotProjectUsage,
  loadReportJob,
  replaceReportJob,
  readWorkflowSnapshotMeta,
  loadProjectWorkflowSchemeMap,
} from "./project-store.js";
import { queueReportBuild } from "./snapshot-engine.js";
import { buildOverallFieldJql } from "./transform.js";

export async function buildProjectUsageReportResult(installationKey, version, fieldIds, offset = 0, partialResult = null) {
  const fields = Array.isArray(partialResult?.fields) ? [...partialResult.fields] : [];
  const projectMap = new Map(
    Array.isArray(partialResult?.projects)
      ? partialResult.projects.map((project) => [project.projectId, project])
      : []
  );
  const pendingFields = Array.isArray(partialResult?.pendingFields) ? [...partialResult.pendingFields] : [];

  const batchFieldIds = fieldIds.slice(offset, offset + REPORT_JOB_FIELD_BATCH_SIZE);
  for (const fieldId of batchFieldIds) {
    const [field, projectUsage] = await Promise.all([
      loadSnapshotField(installationKey, version, fieldId),
      loadAllSnapshotProjectUsage(installationKey, version, fieldId),
    ]);
    if (!field) {
      continue;
    }

    if (!projectUsage.length && Number(field.totalIssueCount || 0) > 0) {
      pendingFields.push({
        fieldId: field.id,
        fieldName: field.name,
        summaryStatus: "missing",
        reason: "project-usage-missing",
      });
    }

    fields.push({
      fieldId: field.id,
      fieldName: field.name,
      fieldType: field.type,
      totalIssueCount: field.totalIssueCount ?? 0,
      activeProjectCount: field.activeProjectCount ?? 0,
      fieldJql: field.fieldJql || buildOverallFieldJql(field.id),
      projects: projectUsage,
    });

    for (const project of projectUsage) {
      if (!projectMap.has(project.projectId)) {
        projectMap.set(project.projectId, {
          projectId: project.projectId,
          projectKey: project.projectKey,
          projectName: project.projectName,
        });
      }
    }
  }

  const nextOffset = offset + batchFieldIds.length;
  const isComplete = nextOffset >= fieldIds.length;

  // Annotate each project with the workflow scheme governing it. Two projects on the same
  // scheme are meant to run the same process, so a report showing them with very different
  // field sets is the standardization signal -- which is only visible when the report
  // carries both. One bulk query, and only on the final chunk: the map is the same for
  // every batch, so fetching it per chunk would repeat identical work.
  //
  // Best-effort throughout. The workflow snapshot is versioned separately and may not
  // exist; a report must never fail because of that.
  let projects = Array.from(projectMap.values());
  if (isComplete) {
    try {
      const wfMeta = await readWorkflowSnapshotMeta(installationKey);
      if (wfMeta?.version) {
        const schemeByProject = await loadProjectWorkflowSchemeMap(installationKey, wfMeta.version);
        projects = projects.map((project) => {
          const scheme = schemeByProject.get(String(project.projectId));
          return scheme ? { ...project, workflowSchemeId: scheme.schemeId, workflowSchemeName: scheme.name } : project;
        });
      }
    } catch (error) {
      console.warn("buildProjectUsageReportResult: workflow scheme annotation failed:", error?.message || error);
    }
  }

  return {
    result: {
      fields,
      projects: projects.sort(
        (left, right) => left.projectKey.localeCompare(right.projectKey) || left.projectName.localeCompare(right.projectName)
      ),
      pendingFields,
      uniqueIssueCount: partialResult?.uniqueIssueCount ?? null,
    },
    processedFields: nextOffset,
    nextOffset,
    isComplete,
  };
}

export async function processProjectUsageReportJob(scopeKey, version, jobId) {
  const existing = await loadReportJob(scopeKey, jobId);
  if (!existing || existing.status === "cancelled" || existing.status === "ready") {
    return;
  }

  const progressLog = [...(existing.progressLog || [])];
  const addLog = (msg) => {
    progressLog.push({ t: new Date().toISOString(), msg });
    if (progressLog.length > 100) progressLog.shift();
  };

  if (existing.status === "queued") {
    incrMetric(METRIC_NAMES.reportJobStarted);
    addLog(`Started report build for ${existing.reportName}`);
  }

  addLog(`Processing fields ${existing.nextOffset + 1}-${Math.min(existing.totalFields, existing.nextOffset + REPORT_JOB_FIELD_BATCH_SIZE)} of ${existing.totalFields}`);

  const next = await buildProjectUsageReportResult(
    scopeKey,
    version,
    existing.fieldIds,
    Number(existing.nextOffset || 0),
    existing.result || null
  );

  if (next.isComplete) {
    const uniqueIssueCount = await getDistinctIssueCountForFields(next.result.fields.map((field) => field.fieldId));
    next.result.uniqueIssueCount = uniqueIssueCount;
    addLog(`Completed report build for ${existing.reportName}`);
    await replaceReportJob(scopeKey, jobId, {
      ...existing,
      status: "ready",
      processedFields: next.processedFields,
      nextOffset: next.nextOffset,
      completedAt: new Date().toISOString(),
      refreshedAt: new Date().toISOString(),
      progressLog,
      result: next.result,
      lastError: null,
    });
    incrMetric(METRIC_NAMES.reportJobCompleted);
    return;
  }

  await replaceReportJob(scopeKey, jobId, {
    ...existing,
    status: "building",
    startedAt: existing.startedAt || new Date().toISOString(),
    processedFields: next.processedFields,
    nextOffset: next.nextOffset,
    refreshedAt: new Date().toISOString(),
    progressLog,
    result: next.result,
    lastError: null,
  });

  await queueReportBuild(scopeKey, version, jobId);
}
