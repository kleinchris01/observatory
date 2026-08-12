import { makeResolver } from "@forge/resolver";
import { logger, fallbackOn, ignoreWith } from "./lib/logger.js";
import {
  incrMetric,
  METRIC_NAMES,
  getInstallationKey,
  sanitizeCacheKeyPart,
} from "./lib/jira-api.js";
import {
  runIssueScanCoordinator,
  runIssueScanWorkerV2,
  cacheFieldOptionsForField,
} from "./lib/scan-engine.js";
import {
  runSnapshot,
  queueSnapshotBuild,
  processFieldSummaryChunk,
  processFieldUsageDelta,
  requeueStaleSnapshotBuild,
} from "./lib/snapshot-engine.js";
import { processProjectUsageReportJob } from "./lib/report-engine.js";
import { buildWorkflowSnapshot, buildStatusHistorySnapshot } from "./lib/workflow-engine.js";
import { buildScreenSnapshot } from "./lib/screen-engine.js";
import {
  ensureProjectStoreReady,
  readSnapshotMeta,
  writeSnapshotMeta,
  loadSnapshotField,
  loadFieldSummary,
  replaceFieldSummary,
  loadReportJob,
  replaceReportJob,
  restoreSnapshotProjectUsageFromSummaries,
  pruneOldSnapshotVersions,
  pruneStaleReportJobs,
  pruneOldAuditEvents,
} from "./lib/project-store.js";
import {
  readAdminConfig,
  runDeltaIssueScanJob,
  DELTA_ISSUE_SCAN_DEFAULT_WINDOW_HOURS,
  rovoSearchFields,
  rovoInspectField,
  rovoSearchAutomationRules,
  rovoInspectAutomationRule,
  rovoAutomationUsage,
  SHARED_RESOLVER_FUNCTIONS,
  ADMIN_ONLY_FUNCTIONS,
} from "./resolvers.js";

export async function runRetentionCleanup(_event, context) {
  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  const activeVersion = meta?.version || null;

  let snapshotPruned = { fieldsDeleted: 0, usageRowsDeleted: 0 };
  if (activeVersion) {
    snapshotPruned = await pruneOldSnapshotVersions(installationKey, activeVersion);
    if (snapshotPruned.fieldsDeleted > 0 || snapshotPruned.usageRowsDeleted > 0) {
      console.log(
        `runRetentionCleanup: pruned old snapshot data — ${snapshotPruned.fieldsDeleted} fields, ${snapshotPruned.usageRowsDeleted} usage rows`
      );
    }
  } else {
    console.log("runRetentionCleanup: no active snapshot version found, skipping snapshot prune");
  }

  const reportPruned = await pruneStaleReportJobs(installationKey);
  if (reportPruned.jobsDeleted > 0) {
    console.log(`runRetentionCleanup: pruned ${reportPruned.jobsDeleted} stale report jobs`);
  }

  const auditPruned = await pruneOldAuditEvents(installationKey);
  if (auditPruned.eventsDeleted > 0) {
    console.log(`runRetentionCleanup: pruned ${auditPruned.eventsDeleted} audit events older than 180 days`);
  }

  // Unconditional, unlike the per-prune lines above, which only fire when something was
  // actually deleted. Without this a clean run logs nothing at all, and "no output" is
  // indistinguishable from "the trigger never fired" -- which matters most right after
  // wiring a trigger up.
  const summary = {
    activeVersion,
    snapshotFieldsDeleted: snapshotPruned.fieldsDeleted,
    snapshotUsageRowsDeleted: snapshotPruned.usageRowsDeleted,
    reportJobsDeleted: reportPruned.jobsDeleted,
    auditEventsDeleted: auditPruned.eventsDeleted,
  };
  console.log(
    `runRetentionCleanup: complete — ${summary.snapshotFieldsDeleted} fields, `
    + `${summary.snapshotUsageRowsDeleted} usage rows, ${summary.reportJobsDeleted} report jobs, `
    + `${summary.auditEventsDeleted} audit events`
  );

  return summary;
}

export async function autoSnapshotCheck(_event, context) {
  const config = await readAdminConfig();
  if (!config.autoSnapshotEnabled) return { skipped: true, reason: "disabled" };

  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);

  if (meta?.state === "building") {
    // A build stuck in "building" for a long time (e.g. the consumer invocation was
    // killed mid-run and never got a chance to update state) would otherwise sit here
    // forever — this daily check is the only automated path that ever revisits it, so
    // it must actively requeue stale builds instead of unconditionally skipping them.
    const requeued = await requeueStaleSnapshotBuild(installationKey, meta);
    if (requeued?.state === "queued") {
      return { requeuedStale: true };
    }
    return { skipped: true, reason: "already running" };
  }

  if (meta?.state === "queued") {
    return { skipped: true, reason: "already running" };
  }

  const lastRun = meta?.refreshedAt ? new Date(meta.refreshedAt).getTime() : 0;
  const minAgeMs = config.autoSnapshotFrequency === "daily"
    ? 20 * 60 * 60 * 1000
    : 6 * 24 * 60 * 60 * 1000;

  if (Date.now() - lastRun < minAgeMs) {
    return { skipped: true, reason: "not due yet" };
  }

  await queueSnapshotBuild(installationKey);
  incrMetric(METRIC_NAMES.snapshotScheduler);
  return { queued: true };
}

export async function runProjectStorageMigrations() {
  incrMetric(METRIC_NAMES.sqlMigrate);
  await ensureProjectStoreReady();
  return { ok: true };
}

export async function consumeSnapshot(event) {
  incrMetric(METRIC_NAMES.snapshotConsumer);
  const installationKey = sanitizeCacheKeyPart(
    event?.body?.installationKey || event?.installationKey || "global"
  );
  const jobType = event?.body?.jobType || "run-snapshot";
  try {
    if (jobType === "build-field-summary") {
      const version = String(event?.body?.version || "");
      const fieldId = String(event?.body?.fieldId || "");
      const jobToken = String(event?.body?.jobToken || "");
      const startAt = Math.max(0, Number(event?.body?.startAt) || 0);
      const nextPageToken = String(event?.body?.nextPageToken || "");
      if (!version || !fieldId) {
        console.warn("consumeSnapshot: missing version or fieldId for build-field-summary job");
        return;
      }

      const snapshotField = await loadSnapshotField(installationKey, version, fieldId);
      if (!snapshotField) {
        console.warn(`consumeSnapshot: snapshot field not found for summary build: ${fieldId}`);
        return;
      }

      await processFieldSummaryChunk(
        installationKey,
        version,
        snapshotField,
        jobToken,
        startAt,
        nextPageToken || null
      );
      return;
    }

    if (jobType === "refresh-field-project-delta") {
      const version = String(event?.body?.version || "");
      const fieldId = String(event?.body?.fieldId || "");
      const jobToken = String(event?.body?.jobToken || "");
      const projectKeys = Array.isArray(event?.body?.projectKeys) ? event.body.projectKeys : [];
      const windowHours = Number(event?.body?.windowHours || 24);
      if (!version || !fieldId || !jobToken) {
        console.warn("consumeSnapshot: missing version or fieldId for refresh-field-project-delta job");
        return;
      }

      const snapshotField = await loadSnapshotField(installationKey, version, fieldId);
      if (!snapshotField) {
        console.warn(`consumeSnapshot: snapshot field not found for incremental refresh: ${fieldId}`);
        return;
      }

      await processFieldUsageDelta(
        installationKey,
        version,
        snapshotField,
        jobToken,
        projectKeys,
        windowHours
      );
      return;
    }

    if (jobType === "build-project-usage-report") {
      const version = String(event?.body?.version || "");
      const jobId = String(event?.body?.jobId || "");
      if (!version || !jobId) {
        console.warn("consumeSnapshot: missing version or jobId for build-project-usage-report job");
        return;
      }

      await processProjectUsageReportJob(installationKey, version, jobId);
      return;
    }

    if (jobType === "run-issue-scan") {
      await runIssueScanCoordinator(installationKey);
      return;
    }

    if (jobType === "run-issue-scan-worker") {
      const workerId = Number(event?.body?.workerId ?? 0);
      await runIssueScanWorkerV2(installationKey, workerId);
      return;
    }

    if (jobType === "cache-field-options") {
      const fieldId = String(event?.body?.fieldId || "");
      if (!fieldId) {
        console.warn("consumeSnapshot: missing fieldId for cache-field-options job");
        return;
      }
      const result = await cacheFieldOptionsForField(installationKey, fieldId);
      console.log(`cache-field-options: cached ${result.optionCount || 0} options for ${fieldId}`);
      return;
    }

    if (jobType === "restore-project-usage") {
      const version = String(event?.body?.version || "");
      if (!version) {
        console.warn("consumeSnapshot: missing version for restore-project-usage job");
        return;
      }
      const result = await restoreSnapshotProjectUsageFromSummaries(installationKey, version);
      console.log(`restore-project-usage: restored ${result.fieldsRestored} fields, ${result.rowsInserted} rows`);
      return;
    }

    if (jobType === "run-delta-issue-scan") {
      const windowHours = Number(event?.body?.windowHours || DELTA_ISSUE_SCAN_DEFAULT_WINDOW_HOURS);
      await runDeltaIssueScanJob(installationKey, windowHours);
      return;
    }

    if (jobType === "build-status-history") {
      const result = await buildStatusHistorySnapshot(installationKey);
      console.log(`build-status-history: measured ${result?.measured ?? 0} statuses, ${result?.failed ?? 0} failed`);
      return;
    }

    if (jobType === "build-workflow-snapshot") {
      const result = await buildWorkflowSnapshot(installationKey);
      console.log(
        `build-workflow-snapshot: ${result?.schemeCount ?? 0} schemes, ${result?.statusCount ?? 0} statuses, ${result?.projectCount ?? 0} projects`
      );
      return;
    }

    if (jobType === "build-screen-snapshot") {
      const result = await buildScreenSnapshot(installationKey);
      // Unresolved screens are logged alongside the totals, not only when non-zero. A pass
      // that could not read part of the catalog is a different artifact from one that read
      // all of it, and the log is where that gets noticed first.
      console.log(
        `build-screen-snapshot: ${result?.screens ?? 0} screens, ${result?.fields ?? 0} field placements, ${result?.unresolvedScreens ?? 0} unresolved`
      );
      return;
    }

    await runSnapshot(installationKey);
  } catch (error) {
    incrMetric(METRIC_NAMES.snapshotConsumerFailed);
    // Last-resort catch — runSnapshot already handles its own errors, but never rethrow
    // here regardless, because Forge would retry the message indefinitely.
    if (jobType === "build-field-summary") {
      const fieldId = String(event?.body?.fieldId || "");
      const existing = fieldId ? await loadFieldSummary(installationKey, fieldId).catch(fallbackOn("consumer.summary_load_failed", null, { fieldId })) : null;
      if (existing) {
        const message = String(error?.message || "Unknown error");
        const isRecoverableQueuePressure =
          message.toLowerCase().includes("too many requests")
          || message.toLowerCase().includes("cyclic invocation")
          || message.toLowerCase().includes("limits for the current installation have been exceeded");
        await replaceFieldSummary(installationKey, fieldId, {
          ...existing,
          refreshedAt: new Date().toISOString(),
          summaryStatus: isRecoverableQueuePressure ? "queued" : "failed",
          completedAt: isRecoverableQueuePressure ? null : new Date().toISOString(),
          lastError: isRecoverableQueuePressure ? null : message,
          progressLog: [
            ...(existing.progressLog || []),
            {
              t: new Date().toISOString(),
              msg: isRecoverableQueuePressure
                ? `Backpressure encountered: ${message}. Leaving job queued for safe continuation.`
                : `${jobType === "refresh-field-project-delta" ? "Incremental refresh failed" : "Job failed"}: ${message}`,
            },
          ].slice(-100),
        }).catch(ignoreWith("consumer.summary_failure_write_failed", { installationKey }));
        if (!isRecoverableQueuePressure) {
          incrMetric(METRIC_NAMES.projectUsageJobFailed);
        }
      }
    }
    if (jobType === "build-project-usage-report") {
      const jobId = String(event?.body?.jobId || "");
      const existing = jobId ? await loadReportJob(installationKey, jobId).catch(fallbackOn("consumer.report_job_load_failed", null, { jobId })) : null;
      if (existing) {
        const message = String(error?.message || "Unknown error");
        await replaceReportJob(installationKey, jobId, {
          ...existing,
          status: "failed",
          completedAt: new Date().toISOString(),
          refreshedAt: new Date().toISOString(),
          lastError: message,
          progressLog: [
            ...(existing.progressLog || []),
            { t: new Date().toISOString(), msg: `Report job failed: ${message}` },
          ].slice(-100),
        }).catch(ignoreWith("consumer.report_failure_write_failed", { installationKey }));
        incrMetric(METRIC_NAMES.reportJobFailed);
      }
    }
    console.error("consumeSnapshot unhandled error:", error?.message || error);
  }
}

export const handler = makeResolver(SHARED_RESOLVER_FUNCTIONS);

// Every admin-only function -- including getAdminConfig/saveAdminConfig/getAdminOverview/
// migrateNamespaceKeys, which used to be spread in here individually -- now comes from
// ADMIN_ONLY_FUNCTIONS, which applies the Jira ADMINISTER guard to the whole registry.
// Anything added here directly would bypass that guard, so don't.
export const adminHandler = makeResolver({
  ...SHARED_RESOLVER_FUNCTIONS,
  ...ADMIN_ONLY_FUNCTIONS,
});

export { rovoSearchFields, rovoInspectField };
export { rovoSearchAutomationRules, rovoInspectAutomationRule, rovoAutomationUsage };
