import { makeResolver } from "@forge/resolver";
import { logger, fallbackOn, ignoreWith, errorContext } from "./lib/logger.js";
import { incrMetric, METRIC_NAMES, getInstallationKey, sanitizeCacheKeyPart } from "./lib/jira-api.js";
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
import { buildFieldConfigSnapshot } from "./lib/fieldconfig-engine.js";
import { syncRemediationTickets, queueRemediationSync } from "./lib/remediation-sync.js";
import { buildBoardSnapshot } from "./lib/board-engine.js";
import { buildDriftSnapshot } from "./lib/drift-engine.js";
import { runFullScanStep, runQuickScanStep, startQuickScan, recoverStalledScan } from "./lib/full-scan-runner.js";
import { buildFilterSnapshot } from "./lib/filter-engine.js";
import { buildDashboardSnapshot } from "./lib/dashboard-engine.js";
import {
  ensureProjectStoreReady,
  readSnapshotMeta,
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
  withMacroAccessGuard,
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
      logger.info("runRetentionCleanup.pruned_snapshot_data", {
        fieldsDeleted: snapshotPruned.fieldsDeleted,
        usageRowsDeleted: snapshotPruned.usageRowsDeleted,
      });
    }
  } else {
    logger.info("runRetentionCleanup.no_active_snapshot");
  }

  const reportPruned = await pruneStaleReportJobs(installationKey);
  if (reportPruned.jobsDeleted > 0) {
    logger.info("runRetentionCleanup.pruned_report_jobs", { jobsDeleted: reportPruned.jobsDeleted });
  }

  const auditPruned = await pruneOldAuditEvents(installationKey);
  if (auditPruned.eventsDeleted > 0) {
    logger.info("runRetentionCleanup.pruned_audit_events", { eventsDeleted: auditPruned.eventsDeleted });
  }

  const changesPruned = await pruneOldConfigChanges(installationKey);
  if (changesPruned.changesDeleted > 0) {
    logger.info("runRetentionCleanup.pruned_config_changes", { changesDeleted: changesPruned.changesDeleted });
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
  logger.info("runRetentionCleanup.complete", summary);

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
  const minAgeMs = config.autoSnapshotFrequency === "daily" ? 20 * 60 * 60 * 1000 : 6 * 24 * 60 * 60 * 1000;

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
  const due =
    schedule.frequency === "daily"
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

// 8am / 12pm / 4pm Pacific, as fixed UTC hours: Forge has no timezone-aware scheduling (the
// trigger itself still fires hourly, the finest interval the platform offers -- same
// constraint quickScanScheduleCheck lives with), so "Pacific business hours" has to be baked
// in as a fixed UTC offset rather than computed. Fixed at PST (UTC-8), not adjusted for
// daylight saving: during PDT this lands at 7am/11am/3pm Pacific instead, an hour earlier.
// Honest about that rather than pulling in a timezone library for three numbers -- the same
// trade quickScanScheduleCheck's own UTC-only comparison already makes.
const REMEDIATION_SYNC_HOURS_UTC = new Set([16, 20, 0]); // 8am, 12pm, 4pm PST

// Checked every time the trigger fires (hourly) but only acts on the three hours above --
// re-reads live status and assignee for every open remediation ticket from Jira and writes it
// back. Its own trigger rather than folded into quickScanScheduleCheck above -- unrelated
// concerns (scan scheduling vs. remediation tracking) that happen to share a cadence is not a
// reason to share a function, and a failure in one should never be able to stop the other
// from running.
export async function remediationSyncCheck(_event, context) {
  if (!REMEDIATION_SYNC_HOURS_UTC.has(new Date().getUTCHours())) {
    return { skipped: true, reason: "outside business hours" };
  }
  const installationKey = getInstallationKey(context);
  // Queued, not run here: see queueRemediationSync.
  return queueRemediationSync(installationKey).catch((error) => {
    logger.error("remediation.sync_watchdog_failed", { installationKey, error: error?.message || String(error) });
    return { queued: false, error: error?.message || String(error) };
  });
}

export async function runProjectStorageMigrations() {
  incrMetric(METRIC_NAMES.sqlMigrate);
  await ensureProjectStoreReady();
  return { ok: true };
}

// Where a resumable queue step ended up, as one searchable word.
function stepOutcome(result) {
  if (result?.completed) return "completed";
  if (result?.checkpointed) return "checkpointed";
  if (result?.waiting) return "waiting";
  if (result?.handedOff) return "handed-off";
  if (result?.advanced) return "advanced";
  return result?.reason || "no-op";
}

export async function consumeSnapshot(event) {
  incrMetric(METRIC_NAMES.snapshotConsumer);
  const installationKey = sanitizeCacheKeyPart(event?.body?.installationKey || event?.installationKey || "global");
  const jobType = event?.body?.jobType || "run-snapshot";
  try {
    if (jobType === "build-field-summary") {
      const version = String(event?.body?.version || "");
      const fieldId = String(event?.body?.fieldId || "");
      const jobToken = String(event?.body?.jobToken || "");
      const startAt = Math.max(0, Number(event?.body?.startAt) || 0);
      const nextPageToken = String(event?.body?.nextPageToken || "");
      if (!version || !fieldId) {
        logger.warn("consumeSnapshot.job_missing_input", { job: "build-field-summary" });
        return;
      }

      const snapshotField = await loadSnapshotField(installationKey, version, fieldId);
      if (!snapshotField) {
        logger.warn("consumeSnapshot.field_not_found", { job: "build-field-summary", fieldId });
        return;
      }

      await processFieldSummaryChunk(installationKey, version, snapshotField, jobToken, startAt, nextPageToken || null);
      return;
    }

    if (jobType === "refresh-field-project-delta") {
      const version = String(event?.body?.version || "");
      const fieldId = String(event?.body?.fieldId || "");
      const jobToken = String(event?.body?.jobToken || "");
      const projectKeys = Array.isArray(event?.body?.projectKeys) ? event.body.projectKeys : [];
      const windowHours = Number(event?.body?.windowHours || 24);
      if (!version || !fieldId || !jobToken) {
        logger.warn("consumeSnapshot.job_missing_input", { job: "refresh-field-project-delta" });
        return;
      }

      const snapshotField = await loadSnapshotField(installationKey, version, fieldId);
      if (!snapshotField) {
        logger.warn("consumeSnapshot.field_not_found", { job: "refresh-field-project-delta", fieldId });
        return;
      }

      await processFieldUsageDelta(installationKey, version, snapshotField, jobToken, projectKeys, windowHours);
      return;
    }

    if (jobType === "build-project-usage-report") {
      const version = String(event?.body?.version || "");
      const jobId = String(event?.body?.jobId || "");
      if (!version || !jobId) {
        logger.warn("consumeSnapshot.job_missing_input", { job: "build-project-usage-report" });
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
        logger.warn("consumeSnapshot.job_missing_input", { job: "cache-field-options" });
        return;
      }
      const result = await cacheFieldOptionsForField(installationKey, fieldId);
      logger.info("cache-field-options.done", { optionCount: result.optionCount || 0, fieldId });
      return;
    }

    if (jobType === "restore-project-usage") {
      const version = String(event?.body?.version || "");
      if (!version) {
        logger.warn("consumeSnapshot.job_missing_input", { job: "restore-project-usage" });
        return;
      }
      const result = await restoreSnapshotProjectUsageFromSummaries(installationKey, version);
      logger.info("restore-project-usage.done", {
        fieldsRestored: result.fieldsRestored,
        rowsInserted: result.rowsInserted,
      });
      return;
    }

    if (jobType === "run-delta-issue-scan") {
      const windowHours = Number(event?.body?.windowHours || DELTA_ISSUE_SCAN_DEFAULT_WINDOW_HOURS);
      await runDeltaIssueScanJob(installationKey, windowHours);
      return;
    }

    if (jobType === "build-status-history") {
      const result = await buildStatusHistorySnapshot(installationKey);
      logger.info("build-status-history.done", { measured: result?.measured ?? 0, failed: result?.failed ?? 0 });
      return;
    }

    if (jobType === "build-workflow-snapshot") {
      const result = await buildWorkflowSnapshot(installationKey);
      logger.info("build-workflow-snapshot.done", {
        schemeCount: result?.schemeCount ?? 0,
        statusCount: result?.statusCount ?? 0,
        projectCount: result?.projectCount ?? 0,
      });
      return;
    }

    if (jobType === "build-dashboard-snapshot") {
      const result = await buildDashboardSnapshot(installationKey, event?.body || {});
      // The walked count is logged alongside the totals, not only when it falls short. A pass
      // that could not read every gadget list is a different artifact from one that did, and
      // the log is where that gets noticed first.
      logger.info("build-dashboard-snapshot.step", { outcome: stepOutcome(result), processed: result?.processed });
      return;
    }

    // One scan that runs everything. Each step is its own invocation, so a stage gets a fresh
    // 900s budget rather than the remainder of the previous stage's.
    if (jobType === "run-full-scan") {
      const result = await runFullScanStep(installationKey, event?.body || {});
      logger.info("run-full-scan.step", {
        outcome: stepOutcome(result),
        stage: result?.stage,
        done: result?.done,
        total: result?.total,
        failed: result?.failed,
        skipped: result?.skipped,
        polls: result?.polls,
      });
      return;
    }

    // The quick scan's sibling step. Same engine, same shared meta row, different stage list --
    // see full-scan-runner.js for why the two must never be allowed to run concurrently.
    if (jobType === "run-quick-scan") {
      const result = await runQuickScanStep(installationKey, event?.body || {});
      logger.info("run-quick-scan.step", {
        outcome: stepOutcome(result),
        stage: result?.stage,
        done: result?.done,
        total: result?.total,
        failed: result?.failed,
        skipped: result?.skipped,
        polls: result?.polls,
      });
      return;
    }

    if (jobType === "build-filter-snapshot") {
      // The whole event body travels, not just the key: a resumable build checkpoints and
      // re-queues itself with a token, and the chunk needs that token to tell its own
      // continuation apart from a second person clicking Rebuild.
      const result = await buildFilterSnapshot(installationKey, event?.body || {});
      logger.info("build-filter-snapshot.step", {
        outcome: stepOutcome(result),
        processed: result?.processed,
        totalExpected: result?.totalExpected,
      });
      return;
    }

    if (jobType === "build-screen-snapshot") {
      const result = await buildScreenSnapshot(installationKey);
      // Unresolved screens are logged alongside the totals, not only when non-zero. A pass
      // that could not read part of the catalog is a different artifact from one that read
      // all of it, and the log is where that gets noticed first.
      logger.info("build-screen-snapshot.done", {
        screens: result?.screens ?? 0,
        fields: result?.fields ?? 0,
        unresolvedScreens: result?.unresolvedScreens ?? 0,
      });
      return;
    }

    if (jobType === "build-issue-type-snapshot") {
      const result = await buildIssueTypeSnapshot(installationKey);
      logger.info("build-issue-type-snapshot.done", {
        issueTypes: result?.issueTypes ?? 0,
        schemes: result?.schemes ?? 0,
      });
      return;
    }

    if (jobType === "build-user-snapshot") {
      const result = await buildUserSnapshot(installationKey);
      logger.info("build-user-snapshot.done", { users: result?.users ?? 0, groups: result?.groups ?? 0 });
      return;
    }

    if (jobType === "build-asset-snapshot") {
      const result = await buildAssetSnapshot(installationKey);
      if (result?.unavailable) logger.info("build-asset-snapshot.unavailable", { reason: result.reason });
      else {
        logger.info("build-asset-snapshot.done", {
          schemas: result?.schemas ?? 0,
          objectTypes: result?.objectTypes ?? 0,
          attributes: result?.attributes ?? 0,
        });
      }
      return;
    }

    if (jobType === "build-asset-type-counts") {
      const result = await buildAssetTypeCounts(installationKey);
      if (result?.queued === false) logger.info("build-asset-type-counts.skipped", { reason: result.reason });
      else {
        logger.info("build-asset-type-counts.done", {
          measured: result?.measured ?? 0,
          unmeasured: result?.unmeasured ?? 0,
          total: result?.total ?? 0,
        });
      }
      return;
    }

    if (jobType === "build-access-snapshot") {
      const result = await buildAccessSnapshot(installationKey);
      logger.info("build-access-snapshot.done", {
        permission: result?.permission ?? 0,
        security: result?.security ?? 0,
        notification: result?.notification ?? 0,
      });
      return;
    }

    if (jobType === "build-estate-snapshot") {
      const result = await buildEstateSnapshot(installationKey);
      logger.info("build-estate-snapshot.done", {
        resolutions: result?.resolutions ?? 0,
        priorities: result?.priorities ?? 0,
      });
      return;
    }

    if (jobType === "build-fieldconfig-snapshot") {
      const result = await buildFieldConfigSnapshot(installationKey);
      logger.info("build-fieldconfig-snapshot.done", {
        source: result?.source ?? "?",
        schemes: result?.schemes ?? 0,
        configs: result?.configs ?? 0,
        unread: result?.unread ?? 0,
      });
      return;
    }

    // "Sync now" from the Remediation tab. Queued rather than run in the resolver: a resolver
    // has seconds, and a few thousand tickets need minutes.
    if (jobType === "sync-remediation") {
      const result = await syncRemediationTickets(installationKey);
      logger.info("sync-remediation.done", { updated: result?.updated ?? 0, checked: result?.checked ?? 0 });
      return;
    }

    if (jobType === "build-board-snapshot") {
      const result = await buildBoardSnapshot(installationKey);
      logger.info("build-board-snapshot.done", {
        boards: result?.boards ?? 0,
        columns: result?.columns ?? 0,
        unreadable: result?.unreadable ?? 0,
      });
      return;
    }

    if (jobType === "build-drift-snapshot") {
      const result = await buildDriftSnapshot(installationKey);
      logger.info("build-drift-snapshot.done", { changes: result?.changes ?? 0, seeded: result?.seeded ?? [] });
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
      const existing = fieldId
        ? await loadFieldSummary(installationKey, fieldId).catch(
            fallbackOn("consumer.summary_load_failed", null, { fieldId }),
          )
        : null;
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
      const existing = jobId
        ? await loadReportJob(installationKey, jobId).catch(
            fallbackOn("consumer.report_job_load_failed", null, { jobId }),
          )
        : null;
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
    logger.error("consumeSnapshot.unhandled_error", errorContext(error));
  }
}

// The macro handler applies the macro's group restriction to every read, not just to the
// checkMacroAccess call the page makes first. Without it the restriction only hid the UI.
export const handler = makeResolver(withMacroAccessGuard(SHARED_RESOLVER_FUNCTIONS));

// Every admin-only function -- including getAdminConfig/saveAdminConfig/getAdminOverview/
// migrateNamespaceKeys, which used to be spread in here individually -- now comes from
// ADMIN_ONLY_FUNCTIONS, which applies the Jira ADMINISTER guard to the whole registry.
// Anything added here directly would bypass that guard, so don't.
export const adminHandler = makeResolver({
  ...SHARED_RESOLVER_FUNCTIONS,
  ...ADMIN_ONLY_FUNCTIONS,
});

// ── Rovo action routing ──────────────────────────────────────────────────────
//
// One Forge function per agent rather than one per action: the app descriptor has a hard
// size limit (257 KB), every function adds to it, and the field schemes agent pushed it over.
// Each agent's actions are told apart by their one required input, which no other action of
// that agent declares -- search takes `query`, inspect `identifier`, impact `name` (or
// `field`). Missing all three falls through to search, which answers with its own
// "a search query is required" rather than a guess.
export function routeAgentAction({ search, inspect, impact, impactInput = "name" }) {
  return async (payload, context) => {
    const has = (key) => payload?.[key] != null && String(payload[key]).trim() !== "";
    if (has(impactInput)) return impact(payload, context);
    if (has("identifier")) return inspect(payload, context);
    return search(payload, context);
  };
}

export const rovoWorkflowAction = routeAgentAction({
  search: rovoWorkflowSearch,
  inspect: rovoWorkflowInspect,
  impact: rovoWorkflowImpact,
});
export const rovoIssueTypeAction = routeAgentAction({
  search: rovoIssueTypeSearch,
  inspect: rovoIssueTypeInspect,
  impact: rovoIssueTypeImpact,
});
export const rovoAccessAction = routeAgentAction({
  search: rovoAccessSearch,
  inspect: rovoAccessInspect,
  impact: rovoAccessImpact,
});
export const rovoAssetAction = routeAgentAction({
  search: rovoAssetSearch,
  inspect: rovoAssetInspect,
  impact: rovoAssetImpact,
});
export const rovoScreenAction = routeAgentAction({
  search: rovoScreenSearch,
  inspect: rovoScreenInspect,
  impact: rovoScreenImpact,
});
export const rovoFieldConfigAction = routeAgentAction({
  search: rovoFieldConfigSearch,
  inspect: rovoFieldConfigInspect,
  impact: rovoFieldConfigImpact,
  impactInput: "field",
});

export { rovoSearchFields, rovoInspectField };
export { rovoSearchAutomationRules, rovoInspectAutomationRule, rovoAutomationUsage };
export { rovoWorkflowSearch, rovoWorkflowInspect, rovoWorkflowImpact };
export { rovoIssueTypeSearch, rovoIssueTypeInspect, rovoIssueTypeImpact };
export { rovoAccessSearch, rovoAccessInspect, rovoAccessImpact };
export { rovoPeopleSearch, rovoPeopleInspect, rovoPeopleImpact };
export { rovoAssetSearch, rovoAssetInspect, rovoAssetImpact };
export { rovoEstateSearch, rovoEstateInspect };
import { rovoFieldConfigSearch, rovoFieldConfigInspect, rovoFieldConfigImpact } from "./lib/fieldconfig-reads.js";
export { rovoFieldConfigSearch, rovoFieldConfigInspect, rovoFieldConfigImpact };
export { rovoScreenSearch, rovoScreenInspect, rovoScreenImpact };
export { rovoChangeSearch, rovoChangeInspect };
export { rovoProjectSearch, rovoProjectInspect };
