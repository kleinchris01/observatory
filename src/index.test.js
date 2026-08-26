import { describe, test, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// index.js is the Forge entry point: scheduled triggers, the queue consumer's job
// router, and the two resolver handler registries. The router is the reason this
// file matters most -- a mistyped jobType silently no-ops in production, and only
// a test asserting the dispatch table catches it.

vi.mock("./lib/jira-api.js", () => ({
  incrMetric: vi.fn(),
  METRIC_NAMES: {
    snapshotScheduler: "snapshot-scheduler",
    snapshotConsumer: "snapshot-consumer",
    snapshotConsumerFailed: "snapshot-consumer-failed",
    sqlMigrate: "sql-migrate",
    projectUsageJobFailed: "project-usage-job-failed",
    reportJobFailed: "report-job-failed",
  },
  getInstallationKey: vi.fn(() => "scope-1"),
  sanitizeCacheKeyPart: vi.fn((v) => String(v || "global")),
}));

vi.mock("./lib/workflow-engine.js", () => ({
  buildWorkflowSnapshot: vi.fn().mockResolvedValue({ schemeCount: 2, statusCount: 5, projectCount: 9 }),
  buildStatusHistorySnapshot: vi.fn().mockResolvedValue({ measured: 40, failed: 0 }),
}));

vi.mock("./lib/screen-engine.js", () => ({
  buildScreenSnapshot: vi.fn().mockResolvedValue({ screens: 760, fields: 21888, unresolvedScreens: 1 }),
}));

vi.mock("./lib/filter-engine.js", () => ({
  buildFilterSnapshot: vi.fn().mockResolvedValue({ built: true, version: "v1", filters: 412, refs: 1840 }),
}));

vi.mock("./lib/dashboard-engine.js", () => ({
  buildDashboardSnapshot: vi.fn().mockResolvedValue({ built: true, version: "v1", dashboards: 212, gadgets: 900, walked: 212 }),
}));

vi.mock("./lib/scan-engine.js", () => ({
  runIssueScanCoordinator: vi.fn().mockResolvedValue(undefined),
  runIssueScanWorkerV2: vi.fn().mockResolvedValue(undefined),
  cacheFieldOptionsForField: vi.fn().mockResolvedValue({ optionCount: 3 }),
}));

vi.mock("./lib/snapshot-engine.js", () => ({
  runSnapshot: vi.fn().mockResolvedValue(undefined),
  queueSnapshotBuild: vi.fn().mockResolvedValue(undefined),
  processFieldSummaryChunk: vi.fn().mockResolvedValue(undefined),
  processFieldUsageDelta: vi.fn().mockResolvedValue(undefined),
  requeueStaleSnapshotBuild: vi.fn().mockResolvedValue(null),
}));

vi.mock("./lib/report-engine.js", () => ({
  processProjectUsageReportJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./lib/project-store.js", () => ({
  ensureProjectStoreReady: vi.fn().mockResolvedValue(undefined),
  readSnapshotMeta: vi.fn().mockResolvedValue(null),
  writeSnapshotMeta: vi.fn().mockResolvedValue(undefined),
  loadSnapshotField: vi.fn().mockResolvedValue({ id: "customfield_1" }),
  loadFieldSummary: vi.fn().mockResolvedValue(null),
  replaceFieldSummary: vi.fn().mockResolvedValue(undefined),
  loadReportJob: vi.fn().mockResolvedValue(null),
  replaceReportJob: vi.fn().mockResolvedValue(undefined),
  restoreSnapshotProjectUsageFromSummaries: vi.fn().mockResolvedValue({ fieldsRestored: 2, rowsInserted: 5 }),
  pruneOldSnapshotVersions: vi.fn().mockResolvedValue({ fieldsDeleted: 0, usageRowsDeleted: 0 }),
  pruneStaleReportJobs: vi.fn().mockResolvedValue({ jobsDeleted: 0 }),
  pruneOldAuditEvents: vi.fn().mockResolvedValue({ eventsDeleted: 0 }),
}));

vi.mock("./resolvers.js", () => ({
  readAdminConfig: vi.fn().mockResolvedValue({ autoSnapshotEnabled: true, autoSnapshotFrequency: "daily" }),
  runDeltaIssueScanJob: vi.fn().mockResolvedValue(undefined),
  DELTA_ISSUE_SCAN_DEFAULT_WINDOW_HOURS: 24,
  rovoSearchFields: vi.fn(),
  rovoInspectField: vi.fn(),
  rovoSearchAutomationRules: vi.fn(),
  rovoInspectAutomationRule: vi.fn(),
  rovoAutomationUsage: vi.fn(),
  SHARED_RESOLVER_FUNCTIONS: { getFieldInventory: vi.fn() },
  ADMIN_ONLY_FUNCTIONS: { startIssueScan: vi.fn() },
  getAdminConfigResolver: vi.fn(),
  saveAdminConfigResolver: vi.fn(),
  getAdminOverview: vi.fn(),
  migrateNamespaceKeys: vi.fn(),
}));

// Self-contained on purpose: vi.mock factories are hoisted above const
// declarations, so this cannot close over an outer variable. Returning the
// function map lets the tests below assert on what each handler exposes.
vi.mock("@forge/resolver", () => ({ makeResolver: (fns) => ({ __registered: fns }) }));

import {
  runRetentionCleanup,
  autoSnapshotCheck,
  runProjectStorageMigrations,
  consumeSnapshot,
  handler,
  adminHandler,
} from "./index.js";
import {
  readSnapshotMeta,
  writeSnapshotMeta,
  ensureProjectStoreReady,
  pruneOldSnapshotVersions,
  pruneStaleReportJobs,
  pruneOldAuditEvents,
  restoreSnapshotProjectUsageFromSummaries,
  loadSnapshotField,
  loadFieldSummary,
  replaceFieldSummary,
  loadReportJob,
  replaceReportJob,
} from "./lib/project-store.js";
import {
  runSnapshot,
  queueSnapshotBuild,
  processFieldSummaryChunk,
  processFieldUsageDelta,
  requeueStaleSnapshotBuild,
} from "./lib/snapshot-engine.js";
import {
  runIssueScanCoordinator,
  runIssueScanWorkerV2,
  cacheFieldOptionsForField,
} from "./lib/scan-engine.js";
import { processProjectUsageReportJob } from "./lib/report-engine.js";
import { buildWorkflowSnapshot, buildStatusHistorySnapshot } from "./lib/workflow-engine.js";
import { buildScreenSnapshot } from "./lib/screen-engine.js";
import { buildFilterSnapshot } from "./lib/filter-engine.js";
import { buildDashboardSnapshot } from "./lib/dashboard-engine.js";
import { readAdminConfig, runDeltaIssueScanJob, ADMIN_ONLY_FUNCTIONS, SHARED_RESOLVER_FUNCTIONS } from "./resolvers.js";

const CONTEXT = { installContext: "ari:cloud:jira::site/UUID" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  readSnapshotMeta.mockResolvedValue(null);
  readAdminConfig.mockResolvedValue({ autoSnapshotEnabled: true, autoSnapshotFrequency: "daily" });
  requeueStaleSnapshotBuild.mockResolvedValue(null);
  pruneOldSnapshotVersions.mockResolvedValue({ fieldsDeleted: 0, usageRowsDeleted: 0 });
  pruneStaleReportJobs.mockResolvedValue({ jobsDeleted: 0 });
  pruneOldAuditEvents.mockResolvedValue({ eventsDeleted: 0 });
});

// ── Retention ─────────────────────────────────────────────────────────────────

describe("runRetentionCleanup", () => {
  test("prunes old snapshot versions and stale report jobs", async () => {
    readSnapshotMeta.mockResolvedValue({ version: "v9" });
    pruneOldSnapshotVersions.mockResolvedValue({ fieldsDeleted: 3, usageRowsDeleted: 7 });
    pruneStaleReportJobs.mockResolvedValue({ jobsDeleted: 2 });

    await expect(runRetentionCleanup({}, CONTEXT)).resolves.toEqual({
      activeVersion: "v9",
      snapshotFieldsDeleted: 3,
      snapshotUsageRowsDeleted: 7,
      reportJobsDeleted: 2,
      auditEventsDeleted: 0,
    });
    expect(pruneOldSnapshotVersions).toHaveBeenCalledWith("scope-1", "v9");
  });

  // Without an active version there is no "keep this one" anchor, so pruning could
  // delete the only snapshot the app has.
  test("skips snapshot pruning when there is no active version", async () => {
    readSnapshotMeta.mockResolvedValue(null);

    const result = await runRetentionCleanup({}, CONTEXT);
    expect(pruneOldSnapshotVersions).not.toHaveBeenCalled();
    expect(result.activeVersion).toBeNull();
  });

  test("still prunes report jobs when no snapshot exists", async () => {
    readSnapshotMeta.mockResolvedValue(null);
    await runRetentionCleanup({}, CONTEXT);
    expect(pruneStaleReportJobs).toHaveBeenCalledWith("scope-1");
  });

  test("prunes audit events and reports the count", async () => {
    readSnapshotMeta.mockResolvedValue({ version: "v9" });
    pruneOldAuditEvents.mockResolvedValue({ eventsDeleted: 12 });

    const result = await runRetentionCleanup({}, CONTEXT);

    expect(pruneOldAuditEvents).toHaveBeenCalledWith("scope-1");
    expect(result.auditEventsDeleted).toBe(12);
  });

  // A run that deletes nothing used to log nothing at all, which made "ran and found
  // nothing" indistinguishable from "the trigger never fired" -- the exact question
  // asked right after wiring a trigger up.
  test("always logs a completion summary, even when nothing was deleted", async () => {
    readSnapshotMeta.mockResolvedValue(null);

    await runRetentionCleanup({}, CONTEXT);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("runRetentionCleanup: complete"));
  });
});

// ── Scheduled entry points ────────────────────────────────────────────────────

describe("autoSnapshotCheck", () => {
  test("does nothing when auto-snapshot is disabled", async () => {
    readAdminConfig.mockResolvedValue({ autoSnapshotEnabled: false });

    await expect(autoSnapshotCheck({}, CONTEXT)).resolves.toEqual({ skipped: true, reason: "disabled" });
    expect(queueSnapshotBuild).not.toHaveBeenCalled();
  });

  test("queues a build when none has ever run", async () => {
    readSnapshotMeta.mockResolvedValue(null);
    await expect(autoSnapshotCheck({}, CONTEXT)).resolves.toEqual({ queued: true });
    expect(queueSnapshotBuild).toHaveBeenCalledWith("scope-1");
  });

  test("skips when a build is already queued", async () => {
    readSnapshotMeta.mockResolvedValue({ state: "queued" });
    await expect(autoSnapshotCheck({}, CONTEXT)).resolves.toEqual({ skipped: true, reason: "already running" });
    expect(queueSnapshotBuild).not.toHaveBeenCalled();
  });

  test("skips when a healthy build is in progress", async () => {
    readSnapshotMeta.mockResolvedValue({ state: "building" });
    requeueStaleSnapshotBuild.mockResolvedValue(null);

    await expect(autoSnapshotCheck({}, CONTEXT)).resolves.toEqual({ skipped: true, reason: "already running" });
  });

  // A build whose consumer invocation was killed sits in "building" forever. This
  // daily check is the only automated path that ever revisits it.
  test("requeues a build that has been stuck in building", async () => {
    readSnapshotMeta.mockResolvedValue({ state: "building" });
    requeueStaleSnapshotBuild.mockResolvedValue({ state: "queued" });

    await expect(autoSnapshotCheck({}, CONTEXT)).resolves.toEqual({ requeuedStale: true });
  });

  test("skips when the last daily run is too recent", async () => {
    readSnapshotMeta.mockResolvedValue({ state: "ready", refreshedAt: new Date().toISOString() });

    await expect(autoSnapshotCheck({}, CONTEXT)).resolves.toEqual({ skipped: true, reason: "not due yet" });
  });

  test("queues once a daily snapshot is older than the interval", async () => {
    readSnapshotMeta.mockResolvedValue({
      state: "ready",
      refreshedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });

    await expect(autoSnapshotCheck({}, CONTEXT)).resolves.toEqual({ queued: true });
  });

  test("applies a longer interval on the weekly setting", async () => {
    readAdminConfig.mockResolvedValue({ autoSnapshotEnabled: true, autoSnapshotFrequency: "weekly" });
    readSnapshotMeta.mockResolvedValue({
      state: "ready",
      refreshedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Two days old is due under "daily" but not under "weekly".
    await expect(autoSnapshotCheck({}, CONTEXT)).resolves.toEqual({ skipped: true, reason: "not due yet" });
  });
});

describe("runProjectStorageMigrations", () => {
  test("readies the store and reports success", async () => {
    await expect(runProjectStorageMigrations()).resolves.toEqual({ ok: true });
    expect(ensureProjectStoreReady).toHaveBeenCalled();
  });
});

// ── Queue job router ──────────────────────────────────────────────────────────

describe("consumeSnapshot job routing", () => {
  const event = (body) => ({ body: { installationKey: "scope-1", ...body } });

  test("defaults to a full snapshot when no jobType is given", async () => {
    await consumeSnapshot(event({}));
    expect(runSnapshot).toHaveBeenCalledWith("scope-1");
  });

  test("routes run-snapshot to the snapshot engine", async () => {
    await consumeSnapshot(event({ jobType: "run-snapshot" }));
    expect(runSnapshot).toHaveBeenCalledWith("scope-1");
  });

  test("routes build-field-summary with its cursor state", async () => {
    await consumeSnapshot(event({
      jobType: "build-field-summary",
      version: "v1",
      fieldId: "customfield_1",
      jobToken: "tok",
      startAt: 100,
      nextPageToken: "page-2",
    }));

    expect(processFieldSummaryChunk).toHaveBeenCalledWith(
      "scope-1", "v1", { id: "customfield_1" }, "tok", 100, "page-2",
    );
  });

  test("passes a null page token on the first field-summary chunk", async () => {
    await consumeSnapshot(event({
      jobType: "build-field-summary", version: "v1", fieldId: "customfield_1", jobToken: "tok",
    }));
    expect(processFieldSummaryChunk).toHaveBeenCalledWith("scope-1", "v1", expect.anything(), "tok", 0, null);
  });

  // Dropping a malformed message is deliberate: throwing would make Forge redeliver
  // it forever.
  test("drops a field-summary job with no version or fieldId", async () => {
    await consumeSnapshot(event({ jobType: "build-field-summary", fieldId: "customfield_1" }));
    expect(processFieldSummaryChunk).not.toHaveBeenCalled();
  });

  test("drops a field-summary job whose field is absent from the snapshot", async () => {
    loadSnapshotField.mockResolvedValueOnce(null);
    await consumeSnapshot(event({
      jobType: "build-field-summary", version: "v1", fieldId: "gone", jobToken: "tok",
    }));
    expect(processFieldSummaryChunk).not.toHaveBeenCalled();
  });

  test("routes refresh-field-project-delta with its project scope", async () => {
    await consumeSnapshot(event({
      jobType: "refresh-field-project-delta",
      version: "v1",
      fieldId: "customfield_1",
      jobToken: "tok",
      projectKeys: ["AAA"],
      windowHours: 48,
    }));

    expect(processFieldUsageDelta).toHaveBeenCalledWith(
      "scope-1", "v1", { id: "customfield_1" }, "tok", ["AAA"], 48,
    );
  });

  test("drops a delta refresh with no job token", async () => {
    await consumeSnapshot(event({
      jobType: "refresh-field-project-delta", version: "v1", fieldId: "customfield_1",
    }));
    expect(processFieldUsageDelta).not.toHaveBeenCalled();
  });

  test("routes build-project-usage-report to the report engine", async () => {
    await consumeSnapshot(event({ jobType: "build-project-usage-report", version: "v1", jobId: "job-1" }));
    expect(processProjectUsageReportJob).toHaveBeenCalledWith("scope-1", "v1", "job-1");
  });

  test("drops a report job with no jobId", async () => {
    await consumeSnapshot(event({ jobType: "build-project-usage-report", version: "v1" }));
    expect(processProjectUsageReportJob).not.toHaveBeenCalled();
  });

  test("routes run-issue-scan to the coordinator", async () => {
    await consumeSnapshot(event({ jobType: "run-issue-scan" }));
    expect(runIssueScanCoordinator).toHaveBeenCalledWith("scope-1");
  });

  // The workflow build moved onto the queue because it cannot fit in a 25s resolver;
  // this is the route that makes that possible.
  test("routes build-workflow-snapshot to the workflow engine", async () => {
    await consumeSnapshot(event({ jobType: "build-workflow-snapshot" }));
    expect(buildWorkflowSnapshot).toHaveBeenCalledWith("scope-1");
  });

  test("a failing workflow build does not rethrow, so Forge will not retry it forever", async () => {
    buildWorkflowSnapshot.mockRejectedValueOnce(new Error("jira down"));
    await expect(consumeSnapshot(event({ jobType: "build-workflow-snapshot" }))).resolves.toBeUndefined();
  });

  // Sized by measurement rather than assumption: a full screen pass projects to ~4.9
  // minutes, which fits the 900s consumer and does not fit a 25s resolver.
  test("routes build-screen-snapshot to the screen engine", async () => {
    await consumeSnapshot(event({ jobType: "build-screen-snapshot" }));
    expect(buildScreenSnapshot).toHaveBeenCalledWith("scope-1");
  });

  // The cheapest structural build here: one paginated endpoint with everything expanded, so
  // ~40 calls for 2,000 filters and no per-item walk.
  test("routes build-filter-snapshot to the filter engine, message and all", async () => {
    await consumeSnapshot(event({ jobType: "build-filter-snapshot", buildToken: "tok-1" }));
    // The whole body travels, not just the key. The filter build is resumable: it re-queues
    // itself with a token, and a chunk that never sees that token cannot tell its own
    // continuation from a second person clicking Rebuild.
    expect(buildFilterSnapshot).toHaveBeenCalledWith(
      "scope-1",
      expect.objectContaining({ jobType: "build-filter-snapshot", buildToken: "tok-1" })
    );
  });

  test("routes build-dashboard-snapshot to the dashboard engine, message and all", async () => {
    await consumeSnapshot(event({ jobType: "build-dashboard-snapshot", buildToken: "tok-2" }));
    // Resumable, like the filter build: the token has to reach the chunk or it cannot tell its
    // own continuation from a fresh Rebuild.
    expect(buildDashboardSnapshot).toHaveBeenCalledWith(
      "scope-1",
      expect.objectContaining({ jobType: "build-dashboard-snapshot", buildToken: "tok-2" })
    );
  });

  test("a failing dashboard build does not rethrow, so Forge will not retry it forever", async () => {
    buildDashboardSnapshot.mockRejectedValueOnce(new Error("401 scope does not match"));
    await expect(consumeSnapshot(event({ jobType: "build-dashboard-snapshot" }))).resolves.toBeUndefined();
  });

  // The walked count is logged alongside the totals, not only when it falls short: a pass
  // that could not read every gadget list is a different artifact from one that did.
  test("logs how far the gadget walk got, even when the build returns nothing", async () => {
    buildDashboardSnapshot.mockResolvedValueOnce(undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await consumeSnapshot(event({ jobType: "build-dashboard-snapshot" }));

    expect(log).toHaveBeenCalledWith(expect.stringContaining("0 dashboards"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("0 walked"));
    log.mockRestore();
  });

  test("a failing filter build does not rethrow, so Forge will not retry it forever", async () => {
    buildFilterSnapshot.mockRejectedValueOnce(new Error("401 scope does not match"));
    await expect(consumeSnapshot(event({ jobType: "build-filter-snapshot" }))).resolves.toBeUndefined();
  });

  // The three outcomes a chunk can have are logged differently, because "checkpointed" and
  // "completed" mean very different things to somebody reading the logs to find out whether a
  // build is progressing or stuck.
  test("distinguishes a checkpointed chunk from a completed build in the log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    buildFilterSnapshot.mockResolvedValueOnce({ checkpointed: true, processed: 500, totalExpected: 4000 });
    await consumeSnapshot(event({ jobType: "build-filter-snapshot" }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("checkpointed - 500/4000"));

    buildFilterSnapshot.mockResolvedValueOnce({ completed: true, processed: 4000 });
    await consumeSnapshot(event({ jobType: "build-filter-snapshot" }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("completed - 4000 filters"));

    log.mockRestore();
  });

  test("says so rather than logging undefined when a chunk is ignored", async () => {
    buildFilterSnapshot.mockResolvedValueOnce(undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await consumeSnapshot(event({ jobType: "build-filter-snapshot" }));

    expect(log).toHaveBeenCalledWith(expect.stringContaining("no-op"));
    log.mockRestore();
  });

  test("a failing screen build does not rethrow, so Forge will not retry it forever", async () => {
    buildScreenSnapshot.mockRejectedValueOnce(new Error("jira down"));
    await expect(consumeSnapshot(event({ jobType: "build-screen-snapshot" }))).resolves.toBeUndefined();
  });

  // The completion log reads counts off the engine's return value. A build that resolves
  // without one must still log a line rather than printing "undefined screens" -- the log
  // is where a partial pass gets noticed, so it has to survive the shape it is given.
  test("logs zeroes rather than undefined when the build returns no counts", async () => {
    buildScreenSnapshot.mockResolvedValueOnce(undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await consumeSnapshot(event({ jobType: "build-screen-snapshot" }));

    expect(log).toHaveBeenCalledWith(expect.stringContaining("0 screens"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("0 unresolved"));
    log.mockRestore();
  });

  // Measuring "ever been in" is its own queued job so it never competes with the
  // universe scan and can be run on demand.
  test("routes build-status-history to the status history builder", async () => {
    await consumeSnapshot(event({ jobType: "build-status-history" }));
    expect(buildStatusHistorySnapshot).toHaveBeenCalledWith("scope-1");
  });

  test("a failing status history build does not rethrow", async () => {
    buildStatusHistorySnapshot.mockRejectedValueOnce(new Error("jira down"));
    await expect(consumeSnapshot(event({ jobType: "build-status-history" }))).resolves.toBeUndefined();
  });

  test("routes run-issue-scan-worker with its worker id", async () => {
    await consumeSnapshot(event({ jobType: "run-issue-scan-worker", workerId: 3 }));
    expect(runIssueScanWorkerV2).toHaveBeenCalledWith("scope-1", 3);
  });

  test("defaults worker zero when the id is absent", async () => {
    await consumeSnapshot(event({ jobType: "run-issue-scan-worker" }));
    expect(runIssueScanWorkerV2).toHaveBeenCalledWith("scope-1", 0);
  });

  test("routes cache-field-options for a field", async () => {
    await consumeSnapshot(event({ jobType: "cache-field-options", fieldId: "customfield_1" }));
    expect(cacheFieldOptionsForField).toHaveBeenCalledWith("scope-1", "customfield_1");
  });

  test("drops a cache-field-options job with no fieldId", async () => {
    await consumeSnapshot(event({ jobType: "cache-field-options" }));
    expect(cacheFieldOptionsForField).not.toHaveBeenCalled();
  });

  test("routes restore-project-usage for a version", async () => {
    await consumeSnapshot(event({ jobType: "restore-project-usage", version: "v1" }));
    expect(restoreSnapshotProjectUsageFromSummaries).toHaveBeenCalledWith("scope-1", "v1");
  });

  test("drops a restore job with no version", async () => {
    await consumeSnapshot(event({ jobType: "restore-project-usage" }));
    expect(restoreSnapshotProjectUsageFromSummaries).not.toHaveBeenCalled();
  });

  test("routes run-delta-issue-scan with its window", async () => {
    await consumeSnapshot(event({ jobType: "run-delta-issue-scan", windowHours: 12 }));
    expect(runDeltaIssueScanJob).toHaveBeenCalledWith("scope-1", 12);
  });

  test("applies the default window when none is supplied", async () => {
    await consumeSnapshot(event({ jobType: "run-delta-issue-scan" }));
    expect(runDeltaIssueScanJob).toHaveBeenCalledWith("scope-1", 24);
  });

  // An unrecognised jobType falling through to a full snapshot is the current
  // contract; pinning it means a future dispatch-table edit has to be deliberate.
  test("falls through to a full snapshot for an unknown jobType", async () => {
    await consumeSnapshot(event({ jobType: "totally-unknown" }));
    expect(runSnapshot).toHaveBeenCalledWith("scope-1");
  });

  test("falls back to the global scope when no installation key is present", async () => {
    await consumeSnapshot({ body: { jobType: "run-issue-scan" } });
    expect(runIssueScanCoordinator).toHaveBeenCalledWith("global");
  });
});

describe("consumeSnapshot error handling", () => {
  const event = (body) => ({ body: { installationKey: "scope-1", ...body } });

  // Rethrowing would make Forge redeliver the message indefinitely.
  test("never rethrows a job failure", async () => {
    runSnapshot.mockRejectedValueOnce(new Error("snapshot exploded"));
    await expect(consumeSnapshot(event({ jobType: "run-snapshot" }))).resolves.toBeUndefined();
  });

  test("marks a failed field-summary job failed and records the error", async () => {
    processFieldSummaryChunk.mockRejectedValueOnce(new Error("chunk failed"));
    loadFieldSummary.mockResolvedValueOnce({ progressLog: [] });

    await consumeSnapshot(event({
      jobType: "build-field-summary", version: "v1", fieldId: "customfield_1", jobToken: "tok",
    }));

    const saved = replaceFieldSummary.mock.calls[0][2];
    expect(saved.summaryStatus).toBe("failed");
    expect(saved.lastError).toContain("chunk failed");
    expect(saved.completedAt).toBeTruthy();
  });

  // Backpressure is transient. Leaving the job queued rather than failed means the
  // continuation can pick it up instead of an admin having to restart it by hand.
  test.each([
    "Too Many Requests",
    "Cyclic invocation detected",
    "Limits for the current installation have been exceeded",
  ])("leaves a field-summary job queued after backpressure: %s", async (message) => {
    processFieldSummaryChunk.mockRejectedValueOnce(new Error(message));
    loadFieldSummary.mockResolvedValueOnce({ progressLog: [] });

    await consumeSnapshot(event({
      jobType: "build-field-summary", version: "v1", fieldId: "customfield_1", jobToken: "tok",
    }));

    const saved = replaceFieldSummary.mock.calls[0][2];
    expect(saved.summaryStatus).toBe("queued");
    expect(saved.lastError).toBeNull();
    expect(saved.completedAt).toBeNull();
  });

  test("does not write a summary when the field has no existing record", async () => {
    processFieldSummaryChunk.mockRejectedValueOnce(new Error("chunk failed"));
    loadFieldSummary.mockResolvedValueOnce(null);

    await consumeSnapshot(event({
      jobType: "build-field-summary", version: "v1", fieldId: "customfield_1", jobToken: "tok",
    }));
    expect(replaceFieldSummary).not.toHaveBeenCalled();
  });

  test("caps the field-summary progress log at 100 entries", async () => {
    processFieldSummaryChunk.mockRejectedValueOnce(new Error("chunk failed"));
    loadFieldSummary.mockResolvedValueOnce({
      progressLog: Array.from({ length: 150 }, (_, i) => ({ t: "t", msg: `e${i}` })),
    });

    await consumeSnapshot(event({
      jobType: "build-field-summary", version: "v1", fieldId: "customfield_1", jobToken: "tok",
    }));

    expect(replaceFieldSummary.mock.calls[0][2].progressLog).toHaveLength(100);
  });

  test("marks a failed report job failed and records the error", async () => {
    processProjectUsageReportJob.mockRejectedValueOnce(new Error("report failed"));
    loadReportJob.mockResolvedValueOnce({ progressLog: [] });

    await consumeSnapshot(event({ jobType: "build-project-usage-report", version: "v1", jobId: "job-1" }));

    const saved = replaceReportJob.mock.calls[0][2];
    expect(saved.status).toBe("failed");
    expect(saved.lastError).toContain("report failed");
  });

  test("does not write a report job that no longer exists", async () => {
    processProjectUsageReportJob.mockRejectedValueOnce(new Error("report failed"));
    loadReportJob.mockResolvedValueOnce(null);

    await consumeSnapshot(event({ jobType: "build-project-usage-report", version: "v1", jobId: "job-1" }));
    expect(replaceReportJob).not.toHaveBeenCalled();
  });
});

// ── Resolver registries ───────────────────────────────────────────────────────
//
// The macro handler must expose ONLY the shared read functions. Anything mutating
// leaking into it would be reachable from a Confluence page.

describe("resolver handler registries", () => {
  test("the macro handler exposes only shared functions", () => {
    const registered = handler.__registered;
    for (const name of Object.keys(ADMIN_ONLY_FUNCTIONS)) {
      expect(registered).not.toHaveProperty(name);
    }
    for (const name of Object.keys(SHARED_RESOLVER_FUNCTIONS)) {
      expect(registered).toHaveProperty(name);
    }
  });

  test("the admin handler exposes shared plus admin-only functions", () => {
    const registered = adminHandler.__registered;
    for (const name of [...Object.keys(SHARED_RESOLVER_FUNCTIONS), ...Object.keys(ADMIN_ONLY_FUNCTIONS)]) {
      expect(registered).toHaveProperty(name);
    }
  });

  // These four used to be spread onto adminHandler directly here in index.js, which
  // put them outside ADMIN_ONLY_FUNCTIONS and therefore outside its admin guard. They
  // now arrive via that registry, so this asserts index.js adds nothing of its own --
  // anything spread in directly would be unguarded.
  test("the admin handler registers nothing beyond the two guarded registries", () => {
    const registered = Object.keys(adminHandler.__registered);
    const expected = new Set([
      ...Object.keys(SHARED_RESOLVER_FUNCTIONS),
      ...Object.keys(ADMIN_ONLY_FUNCTIONS),
    ]);
    expect(registered.filter((name) => !expected.has(name))).toEqual([]);
  });

  test("config mutation is not reachable from the macro handler", () => {
    expect(handler.__registered).not.toHaveProperty("saveAdminConfig");
  });
});

// ---------------------------------------------------------------------------
// Manifest wiring
//
// runRetentionCleanup existed and worked for months while bound to no manifest
// function, so nothing could ever call it -- RUNBOOK.md even told operators to
// invoke it directly, which was impossible. A unit test cannot catch that class
// of bug, because the function itself is fine. This reads the manifest and
// asserts every exported entry point is actually reachable.
// ---------------------------------------------------------------------------
describe("manifest wiring", () => {
  const manifest = readFileSync(new URL("../manifest.yml", import.meta.url), "utf8");

  test("runRetentionCleanup is bound to a function and a scheduled trigger", () => {
    expect(manifest).toContain("handler: index.runRetentionCleanup");
    expect(manifest).toMatch(/key: retention-cleanup-trigger[\s\S]*?function: retention-cleanup/);
  });

  test("retention runs on a different schedule than auto-snapshot", () => {
    const events = manifest.match(/avi:scheduled:\w+/g) || [];
    expect(events).toContain("avi:scheduled:daily");
    expect(events).toContain("avi:scheduled:weekly");
  });

  // Deliberately checks "is exported", not "is a function": the two resolver entry
  // points are objects built by makeResolver, while the triggers and the consumer are
  // plain functions. What matters is that Forge can resolve the name at all -- a
  // manifest pointing at a missing export fails only at invocation time, in production.
  test("every index.* handler in the manifest is a real export", async () => {
    const handlers = [...manifest.matchAll(/handler: index\.(\w+)/g)].map((m) => m[1]);
    const module = await import("./index.js");

    expect(handlers.length).toBeGreaterThan(0);
    for (const name of handlers) {
      expect(module[name], `manifest references index.${name}`).toBeDefined();
    }
  });

  test("scheduleSnapshot is gone from both the code and the manifest", async () => {
    const module = await import("./index.js");
    expect(module.scheduleSnapshot).toBeUndefined();
    expect(manifest).not.toContain("scheduleSnapshot");
  });
});
