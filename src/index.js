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
  isForgeBackpressureError,
  reviveStalledIssueScanWorkers,
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
import { buildIssueTypeSnapshot } from "./lib/issuetype-engine.js";
import { buildUserSnapshot } from "./lib/user-engine.js";
import { buildAssetSnapshot, buildAssetTypeCounts } from "./lib/asset-engine.js";
import { buildAccessSnapshot } from "./lib/access-engine.js";
import { buildEstateSnapshot } from "./lib/estate-engine.js";
import { buildBoardSnapshot } from "./lib/board-engine.js";
import { buildDriftSnapshot } from "./lib/drift-engine.js";
import { runFullScanStep, runQuickScanStep, startQuickScan, recoverStalledScan } from "./lib/full-scan-runner.js";
import { buildFilterSnapshot } from "./lib/filter-engine.js";
import { buildDashboardSnapshot } from "./lib/dashboard-engine.js";
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
  pruneOldConfigChanges,
} from "./lib/project-store.js";
import {
  readAdminConfig,
  runDeltaIssueScanJob,
  DELTA_ISSUE_SCAN_DEFAULT_WINDOW_HOURS,
  recordQuickScanScheduledRun,
  rovoSearchFields,
  rovoInspectField,
  rovoSearchAutomationRules,
  rovoInspectAutomationRule,
  rovoAutomationUsage,
  rovoWorkflowSearch,
  rovoWorkflowInspect,
  rovoWorkflowImpact,
  rovoIssueTypeSearch,
  rovoIssueTypeInspect,
  rovoIssueTypeImpact,
  rovoAccessSearch,
  rovoAccessInspect,
  rovoAccessImpact,
  rovoPeopleSearch,
  rovoPeopleInspect,
  rovoPeopleImpact,
  rovoAssetSearch,
  rovoAssetInspect,
  rovoAssetImpact,
  rovoEstateSearch,
  rovoEstateInspect,
  rovoScreenSearch,
  rovoScreenInspect,
  rovoScreenImpact,
  rovoChangeSearch,
  rovoChangeInspect,
  rovoProjectSearch,
  rovoProjectInspect,
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

  const changesPruned = await pruneOldConfigChanges(installationKey);
  if (changesPruned.changesDeleted > 0) {
    console.log(`runRetentionCleanup: pruned ${changesPruned.changesDeleted} config-change rows older than 400 days`);
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
    configChangesDeleted: changesPruned.changesDeleted,
  };
  console.log(
    `runRetentionCleanup: complete — ${summary.snapshotFieldsDeleted} fields, `
    + `${summary.snapshotUsageRowsDeleted} usage rows, ${summary.reportJobsDeleted} report jobs, `
    + `${summary.auditEventsDeleted} audit events, ${summary.configChangesDeleted} config-change rows`
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

// Fires roughly hourly (the finest interval Forge scheduled triggers offer) and checks the
// stored schedule against the current hour -- Forge has no cron/day-of-week trigger, so "runs
// Sunday at midnight" has to be implemented as "fires every hour, most of which do nothing."
//
// dayOfWeek and hourUtc are compared in UTC because that is what Date's own UTC accessors give
// for free without a timezone library, and because a scheduled trigger's exact firing instant
// already has Forge's own slop in it -- offering false minute-level precision on top of that
// would be worse than being honest that this is accurate to the hour, in UTC.
export async function quickScanScheduleCheck(_event, context) {
  const installationKey = getInstallationKey(context);

  // Runs every hour whether or not scheduled quick scans are enabled. A full or quick scan
  // whose orchestrator loop stopped -- a lost queue message, a consumer killed before it
  // re-queued the next step -- leaves the shared meta row stuck at "running", and that
  // blocks every future scan, scheduled or manual, until something clears it. This trigger
  // is the only automated path that revisits it, so the watchdog runs before the schedule
  // gate, not after.
  const recovery = await recoverStalledScan(installationKey).catch((error) => {
    logger.error("scan.watchdog_failed", { installationKey, error: error?.message || String(error) });
    return { recovered: false, reason: "error" };
  });

  // Same idea one level down: an issue-crawl worker that paused on a Forge queue limit needs
  // a kick from outside its own (blocked) chain. The full scan's issues poll does this every
  // 30s while it is waiting; this covers a standalone crawl, which has no poller of its own.
  await reviveStalledIssueScanWorkers(installationKey).catch((error) => {
    logger.warn("scan.worker_revive_watchdog_failed", { installationKey, error: error?.message || String(error) });
  });

  const config = await readAdminConfig();
  const schedule = config.quickScanSchedule;
  if (!schedule?.enabled) return { skipped: true, reason: "disabled", recovery };

  const now = new Date();
  const due = schedule.frequency === "daily"
    ? now.getUTCHours() === schedule.hourUtc
    : now.getUTCDay() === schedule.dayOfWeek && now.getUTCHours() === schedule.hourUtc;

  if (!due) return { skipped: true, reason: "not due yet", recovery };

  // The due WINDOW is a whole hour wide and this fires roughly hourly, so without this guard
  // a trigger that fires twice in one hour -- Forge's delivery is at-least-once, not
  // exactly-once -- would start the quick scan twice. 45 minutes is comfortably inside one
  // hour and comfortably outside "the same firing running twice."
  const lastRun = schedule.lastScheduledRunAt ? new Date(schedule.lastScheduledRunAt).getTime() : 0;
  if (Date.now() - lastRun < 45 * 60 * 1000) {
    return { skipped: true, reason: "already ran this hour", recovery };
  }

  const result = await startQuickScan(installationKey, { quickScanWindowHours: schedule.windowHours });

  if (result?.started) {
    await recordQuickScanScheduledRun(new Date().toISOString());
    incrMetric(METRIC_NAMES.snapshotScheduler);
  }

  return { ...result, recovery };
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

    if (jobType === "build-dashboard-snapshot") {
      const result = await buildDashboardSnapshot(installationKey, event?.body || {});
      // The walked count is logged alongside the totals, not only when it falls short. A pass
      // that could not read every gadget list is a different artifact from one that did, and
      // the log is where that gets noticed first.
      console.log(
        result?.completed
          ? `build-dashboard-snapshot: completed - ${result.processed} items`
          : result?.checkpointed
            ? `build-dashboard-snapshot: checkpointed - ${result.processed} items; requeued`
            : `build-dashboard-snapshot: ${result?.reason || "no-op"}`
      );
      return;
    }

    // One scan that runs everything. Each step is its own invocation, so a stage gets a fresh
    // 900s budget rather than the remainder of the previous stage's.
    if (jobType === "run-full-scan") {
      const result = await runFullScanStep(installationKey, event?.body || {});
      console.log(
        result?.completed
          ? `run-full-scan: complete - ${result.done}/${result.total} stages, ${result.failed} failed, ${result.skipped} skipped`
          : result?.waiting
            ? `run-full-scan: waiting on ${result.stage} (poll ${result.polls})`
            : result?.handedOff
              ? `run-full-scan: handed off to ${result.stage}`
              : result?.advanced
                ? `run-full-scan: ${result.done}/${result.total} stages done`
                : `run-full-scan: ${result?.reason || "no-op"}`
      );
      return;
    }

    // The quick scan's sibling step. Same engine, same shared meta row, different stage list --
    // see full-scan-runner.js for why the two must never be allowed to run concurrently.
    if (jobType === "run-quick-scan") {
      const result = await runQuickScanStep(installationKey, event?.body || {});
      console.log(
        result?.completed
          ? `run-quick-scan: complete - ${result.done}/${result.total} stages, ${result.failed} failed, ${result.skipped} skipped`
          : result?.waiting
            ? `run-quick-scan: waiting on ${result.stage} (poll ${result.polls})`
            : result?.handedOff
              ? `run-quick-scan: handed off to ${result.stage}`
              : result?.advanced
                ? `run-quick-scan: ${result.done}/${result.total} stages done`
                : `run-quick-scan: ${result?.reason || "no-op"}`
      );
      return;
    }

    if (jobType === "build-filter-snapshot") {
      // The whole event body travels, not just the key: a resumable build checkpoints and
      // re-queues itself with a token, and the chunk needs that token to tell its own
      // continuation apart from a second person clicking Rebuild.
      const result = await buildFilterSnapshot(installationKey, event?.body || {});
      console.log(
        result?.completed
          ? `build-filter-snapshot: completed - ${result.processed} filters`
          : result?.checkpointed
            ? `build-filter-snapshot: checkpointed - ${result.processed}/${result.totalExpected || "?"} filters; requeued`
            : `build-filter-snapshot: ${result?.reason || "no-op"}`
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

    if (jobType === "build-issue-type-snapshot") {
      const result = await buildIssueTypeSnapshot(installationKey);
      console.log(
        `build-issue-type-snapshot: ${result?.issueTypes ?? 0} issue types, ${result?.schemes ?? 0} schemes`
      );
      return;
    }

    if (jobType === "build-user-snapshot") {
      const result = await buildUserSnapshot(installationKey);
      console.log(
        `build-user-snapshot: ${result?.users ?? 0} licensed users across ${result?.groups ?? 0} access groups`
      );
      return;
    }

    if (jobType === "build-asset-snapshot") {
      const result = await buildAssetSnapshot(installationKey);
      console.log(
        result?.unavailable
          ? `build-asset-snapshot: Assets not enabled — ${result.reason}`
          : `build-asset-snapshot: ${result?.schemas ?? 0} schemas, ${result?.objectTypes ?? 0} object types, ${result?.attributes ?? 0} attributes`
      );
      return;
    }

    if (jobType === "build-asset-type-counts") {
      const result = await buildAssetTypeCounts(installationKey);
      console.log(
        result?.queued === false
          ? `build-asset-type-counts: skipped — ${result.reason}`
          : `build-asset-type-counts: ${result?.measured ?? 0} measured, ${result?.unmeasured ?? 0} unmeasured, of ${result?.total ?? 0} concrete object types`
      );
      return;
    }

    if (jobType === "build-access-snapshot") {
      const result = await buildAccessSnapshot(installationKey);
      console.log(
        `build-access-snapshot: ${result?.permission ?? 0} permission, ${result?.security ?? 0} security, ${result?.notification ?? 0} notification schemes`
      );
      return;
    }

    if (jobType === "build-estate-snapshot") {
      const result = await buildEstateSnapshot(installationKey);
      console.log(
        `build-estate-snapshot: ${result?.resolutions ?? 0} resolutions, ${result?.priorities ?? 0} priorities`
      );
      return;
    }

    if (jobType === "build-board-snapshot") {
      const result = await buildBoardSnapshot(installationKey);
      console.log(
        `build-board-snapshot: ${result?.boards ?? 0} boards, ${result?.columns ?? 0} columns, ${result?.unreadable ?? 0} unreadable`
      );
      return;
    }

    if (jobType === "build-drift-snapshot") {
      const result = await buildDriftSnapshot(installationKey);
      console.log(
        `build-drift-snapshot: ${result?.changes ?? 0} changes recorded${result?.seeded?.length ? `, seeded ${result.seeded.join(", ")}` : ""}`
      );
      return;
    }

    // jobToken is present only on a continuation the build re-queued for itself (it chunks
    // now, rather than trying to finish inside one 900s invocation). runSnapshot uses it to
    // resume its own next chunk without being turned away by the duplicate-build guard.
    await runSnapshot(installationKey, { continuationToken: event?.body?.jobToken || null });
  } catch (error) {
    incrMetric(METRIC_NAMES.snapshotConsumerFailed);
    // Last-resort catch — runSnapshot already handles its own errors, but never rethrow
    // here regardless, because Forge would retry the message indefinitely.
    if (jobType === "build-field-summary") {
      const fieldId = String(event?.body?.fieldId || "");
      const existing = fieldId ? await loadFieldSummary(installationKey, fieldId).catch(fallbackOn("consumer.summary_load_failed", null, { fieldId })) : null;
      if (existing) {
        const message = String(error?.message || "Unknown error");
        const isRecoverableQueuePressure = isForgeBackpressureError(error);
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
export { rovoWorkflowSearch, rovoWorkflowInspect, rovoWorkflowImpact };
export { rovoIssueTypeSearch, rovoIssueTypeInspect, rovoIssueTypeImpact };
export { rovoAccessSearch, rovoAccessInspect, rovoAccessImpact };
export { rovoPeopleSearch, rovoPeopleInspect, rovoPeopleImpact };
export { rovoAssetSearch, rovoAssetInspect, rovoAssetImpact };
export { rovoEstateSearch, rovoEstateInspect };
export { rovoScreenSearch, rovoScreenInspect, rovoScreenImpact };
export { rovoChangeSearch, rovoChangeInspect };
export { rovoProjectSearch, rovoProjectInspect };
