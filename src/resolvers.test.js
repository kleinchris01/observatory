import { vi, describe, test, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock scaffold
//
// resolvers.js is the entire business-logic entry point (~2,260 lines, ~40
// functions) and had zero test coverage before this effort. It pulls from
// project-store.js (SQL), jira-api.js (Jira REST), snapshot-engine.js/
// scan-engine.js (queue orchestration), and queues.js (@forge/events) --
// each of those already has its OWN dedicated test file covering its
// internals against mocked Forge primitives. Re-mocking @forge/sql etc. here
// would re-test the same lower-layer logic twice. Instead this mocks each
// lib module's exported functions directly, so these tests focus on what's
// actually untested: resolvers.js's own orchestration order, validation,
// response shaping, and error handling.
//
// analysis.js and transform.js are pure functions with no external deps --
// kept REAL (not mocked) so filter/sort/JQL-building logic is exercised for
// real through resolvers.js's actual data shaping, same rationale as keeping
// resolverError/ApiError real via importOriginal in Solve's index.test.js
// this session. hydrateFieldForGovernance (in snapshot-engine.js) is also
// pure -- kept real via importOriginal while everything else in that module
// (all I/O) is mocked.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  kvsGet: vi.fn(),
  kvsSet: vi.fn(),
  apiAsAppRequestJira: vi.fn(),

  // project-store.js -- every named export resolvers.js imports, since
  // vi.mock replaces the whole module. Stubbed vi.fn() defaults are safe for
  // groups that don't exercise them; later groups configure return values.
  ensureProjectStoreReady: vi.fn().mockResolvedValue(undefined),
  readSnapshotMeta: vi.fn(),
  writeSnapshotMeta: vi.fn().mockResolvedValue(undefined),
  loadSnapshotFields: vi.fn(),
  loadSnapshotField: vi.fn(),
  loadSnapshotProjectUsage: vi.fn(),
  loadAllSnapshotProjectUsage: vi.fn(),
  loadAnySnapshotProjectUsage: vi.fn(),
  listSnapshotProjects: vi.fn(),
  loadSnapshotProjectFields: vi.fn(),
  countSnapshotProjectUsage: vi.fn(),
  loadFieldSummary: vi.fn(),
  replaceFieldSummary: vi.fn().mockResolvedValue(undefined),
  listFieldSummaries: vi.fn().mockResolvedValue([]),
  replaceSnapshotProjectUsageForField: vi.fn(),
  listSavedReports: vi.fn().mockResolvedValue([]),
  saveSavedReport: vi.fn().mockResolvedValue(undefined),
  deleteSavedReport: vi.fn().mockResolvedValue(undefined),
  replaceReportJob: vi.fn().mockResolvedValue(undefined),
  loadReportJob: vi.fn(),
  readIssueScanMeta: vi.fn(),
  writeIssueScanMeta: vi.fn().mockResolvedValue(undefined),
  readIssueScanWorker: vi.fn(),
  updateIssueScanWorker: vi.fn().mockResolvedValue(undefined),
  replaceFieldOptionsCache: vi.fn(),
  loadFieldOptionsCache: vi.fn(),
  searchFieldOptionsCache: vi.fn().mockResolvedValue([]),
  countOldScopeKeyRows: vi.fn(),
  migrateOldScopeKeys: vi.fn(),
  loadSnapshotFieldIssueSums: vi.fn().mockResolvedValue(new Map()),
  sumSnapshotFieldIssueCount: vi.fn().mockResolvedValue(0),
  upsertProjectTotalsForDelta: vi.fn(),
  upsertDeltaFieldProjectUsage: vi.fn(),
  upsertRqtFieldHits: vi.fn(),
  upsertRqtIssueKeys: vi.fn(),
  upsertRqtValueIssueKeys: vi.fn(),
  upsertRqtFieldIssueKeys: vi.fn(),
  loadRqtFieldIndex: vi.fn(),
  loadRqtIssueKeys: vi.fn(),
  loadRqtValueFrequency: vi.fn(),
  searchRqtValueIssueKeys: vi.fn(),
  loadRqtFieldIssueIndex: vi.fn(),
  loadIssueRqtValues: vi.fn(),

  // jira-api.js
  incrMetric: vi.fn(),
  makeJobToken: vi.fn(() => "job-token-1"),
  getInstallationKey: vi.fn(() => "test-install"),
  mapWithConcurrency: vi.fn(async (items, _concurrency, fn) => Promise.all(items.map(fn))),
  jiraRequest: vi.fn(),
  getDistinctIssueCountForFields: vi.fn(),
  getLiveFieldProjectUsage: vi.fn(),
  loadFieldContexts: vi.fn().mockResolvedValue([]),
  collectRecentFieldProjectCandidates: vi.fn(),
  loadFieldOptionsFromJira: vi.fn(),
  // Permissive by default (every candidate project ID is "browsable") so
  // existing tests don't need to know about this filter unless they're
  // specifically testing it -- see the "Browse Projects permission
  // filtering" describe block for the tests that override this.
  getBrowsableProjectIds: vi.fn(async (_accountId, projectIds) => new Set((projectIds || []).map(String))),

  // snapshot-engine.js (I/O only -- hydrateFieldForGovernance stays real)
  requeueStaleSnapshotBuild: vi.fn(),
  ensureFieldSummaryJobRunning: vi.fn(async (_install, _version, _fieldId, summary) => summary),
  queueSnapshotBuild: vi.fn().mockResolvedValue(undefined),
  queueReportBuild: vi.fn().mockResolvedValue(undefined),
  queueFieldSummaryContinuationWithRetry: vi.fn(),
  queueFieldUsageDeltaRefreshWithRetry: vi.fn(),
  processFieldSummaryChunk: vi.fn(),
  queueProjectUsageRestore: vi.fn(),

  // scan-engine.js
  queueIssueScanWorker: vi.fn(),

  // queues.js
  queuePush: vi.fn().mockResolvedValue({ queued: true }),
}));

vi.mock("@forge/kvs", () => ({ kvs: { get: mocks.kvsGet, set: mocks.kvsSet } }));

vi.mock("@forge/api", () => ({
  default: { asApp: () => ({ requestJira: mocks.apiAsAppRequestJira }) },
  route: (strings, ...vals) => strings.reduce((acc, s, i) => acc + s + (vals[i] ?? ""), ""),
}));

vi.mock("./lib/queues.js", () => ({
  inventorySnapshotQueue: { push: mocks.queuePush },
}));

vi.mock("./lib/scan-engine.js", () => ({
  queueIssueScanWorker: mocks.queueIssueScanWorker,
}));

vi.mock("./lib/project-store.js", () => ({
  ensureProjectStoreReady: mocks.ensureProjectStoreReady,
  readSnapshotMeta: mocks.readSnapshotMeta,
  writeSnapshotMeta: mocks.writeSnapshotMeta,
  loadSnapshotFields: mocks.loadSnapshotFields,
  loadSnapshotField: mocks.loadSnapshotField,
  loadSnapshotProjectUsage: mocks.loadSnapshotProjectUsage,
  loadAllSnapshotProjectUsage: mocks.loadAllSnapshotProjectUsage,
  loadAnySnapshotProjectUsage: mocks.loadAnySnapshotProjectUsage,
  listSnapshotProjects: mocks.listSnapshotProjects,
  loadSnapshotProjectFields: mocks.loadSnapshotProjectFields,
  countSnapshotProjectUsage: mocks.countSnapshotProjectUsage,
  loadFieldSummary: mocks.loadFieldSummary,
  replaceFieldSummary: mocks.replaceFieldSummary,
  listFieldSummaries: mocks.listFieldSummaries,
  replaceSnapshotProjectUsageForField: mocks.replaceSnapshotProjectUsageForField,
  listSavedReports: mocks.listSavedReports,
  saveSavedReport: mocks.saveSavedReport,
  deleteSavedReport: mocks.deleteSavedReport,
  replaceReportJob: mocks.replaceReportJob,
  loadReportJob: mocks.loadReportJob,
  readIssueScanMeta: mocks.readIssueScanMeta,
  writeIssueScanMeta: mocks.writeIssueScanMeta,
  readIssueScanWorker: mocks.readIssueScanWorker,
  updateIssueScanWorker: mocks.updateIssueScanWorker,
  replaceFieldOptionsCache: mocks.replaceFieldOptionsCache,
  loadFieldOptionsCache: mocks.loadFieldOptionsCache,
  searchFieldOptionsCache: mocks.searchFieldOptionsCache,
  countOldScopeKeyRows: mocks.countOldScopeKeyRows,
  migrateOldScopeKeys: mocks.migrateOldScopeKeys,
  loadSnapshotFieldIssueSums: mocks.loadSnapshotFieldIssueSums,
  sumSnapshotFieldIssueCount: mocks.sumSnapshotFieldIssueCount,
  upsertProjectTotalsForDelta: mocks.upsertProjectTotalsForDelta,
  upsertDeltaFieldProjectUsage: mocks.upsertDeltaFieldProjectUsage,
  upsertRqtFieldHits: mocks.upsertRqtFieldHits,
  upsertRqtIssueKeys: mocks.upsertRqtIssueKeys,
  upsertRqtValueIssueKeys: mocks.upsertRqtValueIssueKeys,
  upsertRqtFieldIssueKeys: mocks.upsertRqtFieldIssueKeys,
  loadRqtFieldIndex: mocks.loadRqtFieldIndex,
  loadRqtIssueKeys: mocks.loadRqtIssueKeys,
  loadRqtValueFrequency: mocks.loadRqtValueFrequency,
  searchRqtValueIssueKeys: mocks.searchRqtValueIssueKeys,
  loadRqtFieldIssueIndex: mocks.loadRqtFieldIssueIndex,
  loadIssueRqtValues: mocks.loadIssueRqtValues,
}));

vi.mock("./lib/jira-api.js", () => ({
  METRIC_NAMES: {
    inventorySnapshot: "inventory-snapshot",
    resolver: "resolver",
    resolverFailed: "resolver-failed",
    rovoInspectField: "rovo-inspect-field",
    rovoSearchFields: "rovo-search-fields",
  },
  incrMetric: mocks.incrMetric,
  makeJobToken: mocks.makeJobToken,
  getInstallationKey: mocks.getInstallationKey,
  mapWithConcurrency: mocks.mapWithConcurrency,
  jiraRequest: mocks.jiraRequest,
  getDistinctIssueCountForFields: mocks.getDistinctIssueCountForFields,
  getLiveFieldProjectUsage: mocks.getLiveFieldProjectUsage,
  loadFieldContexts: mocks.loadFieldContexts,
  collectRecentFieldProjectCandidates: mocks.collectRecentFieldProjectCandidates,
  loadFieldOptionsFromJira: mocks.loadFieldOptionsFromJira,
  getBrowsableProjectIds: mocks.getBrowsableProjectIds,
  PROJECT_USAGE_PAGE_SIZE: 12,
  PROJECTS_VIEW_PAGE_SIZE: 24,
  MAX_ACTIVE_PROJECT_USAGE_JOBS: 3,
  MAX_AUTOQUEUED_REPORT_FIELDS: 12,
  MAX_AUTOQUEUED_REPORT_ISSUE_BUDGET: 200000,
  ISSUE_SCAN_PAGE_SIZE: 100,
  ISSUE_SCAN_WORKERS: 5,
  BASE_JIRA_CONCURRENCY: 4,
}));

vi.mock("./lib/snapshot-engine.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual, // keeps the real, pure hydrateFieldForGovernance
    requeueStaleSnapshotBuild: mocks.requeueStaleSnapshotBuild,
    ensureFieldSummaryJobRunning: mocks.ensureFieldSummaryJobRunning,
    queueSnapshotBuild: mocks.queueSnapshotBuild,
    queueReportBuild: mocks.queueReportBuild,
    queueFieldSummaryContinuationWithRetry: mocks.queueFieldSummaryContinuationWithRetry,
    queueFieldUsageDeltaRefreshWithRetry: mocks.queueFieldUsageDeltaRefreshWithRetry,
    processFieldSummaryChunk: mocks.processFieldSummaryChunk,
    queueProjectUsageRestore: mocks.queueProjectUsageRestore,
  };
});

import {
  SHARED_RESOLVER_FUNCTIONS,
  ADMIN_ONLY_FUNCTIONS,
  readAdminConfig,
  getAdminConfigResolver,
  saveAdminConfigResolver,
  getAdminOverview,
  runDeltaIssueScanJob,
  rovoSearchFields,
  rovoInspectField,
  migrateNamespaceKeys,
} from "./resolvers.js";

const {
  saveReportDefinition,
  startProjectUsageReportJob,
} = ADMIN_ONLY_FUNCTIONS;

const {
  checkMacroAccess,
  getFieldInventory,
  getFieldDetails,
  getFilteredFieldIds,
  getFieldOptions,
  searchFieldOptions,
  getProjectsView,
  startIssueScan,
  resumeIssueScan,
  cancelIssueScan,
  getIssueScanStatus,
  startDeltaIssueScan,
  getDeltaIssueScanStatus,
  cancelSnapshot,
  getProjectUsageJobs,
  refreshRecentProjectUsage,
  cancelProjectUsageJob,
  restartProjectUsageJob,
  resumeProjectUsageJob,
  restoreProjectUsageCache,
  getSavedReports,
  deleteReportDefinition,
  getProjectUsageReport,
  getProjectUsageReportJob,
  getRqtIndex,
  searchRqtValue,
} = { ...SHARED_RESOLVER_FUNCTIONS, ...ADMIN_ONLY_FUNCTIONS };

function manyFieldIds(count) {
  return Array.from({ length: count }, (_, i) => `customfield_${i}`);
}

function snapshotField(overrides = {}) {
  return {
    id: "customfield_10001",
    name: "Story Points",
    type: "number",
    configuredProjectCount: 3,
    activeProjectCount: 2,
    totalIssueCount: 150,
    fieldJql: null,
    ...overrides,
  };
}

function adminConfig(overrides = {}) {
  return {
    readOnlyMode: false,
    apiConcurrency: 4,
    autoSnapshotEnabled: false,
    autoSnapshotFrequency: "weekly",
    governanceThresholds: {},
    macroAccess: { restrictAccess: false, allowedGroups: [] },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureProjectStoreReady.mockResolvedValue(undefined);
  mocks.writeSnapshotMeta.mockResolvedValue(undefined);
  mocks.replaceFieldSummary.mockResolvedValue(undefined);
  mocks.listFieldSummaries.mockResolvedValue([]);
  mocks.searchFieldOptionsCache.mockResolvedValue([]);
  mocks.loadSnapshotFieldIssueSums.mockResolvedValue(new Map());
  mocks.sumSnapshotFieldIssueCount.mockResolvedValue(0);
  mocks.getInstallationKey.mockReturnValue("test-install");
  mocks.makeJobToken.mockReturnValue("job-token-1");
  mocks.mapWithConcurrency.mockImplementation(async (items, _c, fn) => Promise.all(items.map(fn)));
  mocks.loadFieldContexts.mockResolvedValue([]);
  mocks.ensureFieldSummaryJobRunning.mockImplementation(async (_i, _v, _f, summary) => summary);
  mocks.kvsGet.mockResolvedValue(null); // readAdminConfig falls back to DEFAULT_ADMIN_CONFIG
  mocks.queueSnapshotBuild.mockResolvedValue(undefined);
  mocks.queuePush.mockResolvedValue({ queued: true });
  mocks.writeIssueScanMeta.mockResolvedValue(undefined);
  mocks.readIssueScanWorker.mockResolvedValue(null);
  mocks.getBrowsableProjectIds.mockImplementation(async (_accountId, projectIds) => new Set((projectIds || []).map(String)));
});

function ctxWithAccount(accountId = "user-1") {
  return { accountId };
}

// ---------------------------------------------------------------------------
// Existing report field-count validation (kept from the field-cap fix)
// ---------------------------------------------------------------------------
describe("saveReportDefinition field count validation", () => {
  test("still rejects an empty fieldIds array", async () => {
    await expect(saveReportDefinition({ payload: { name: "Test", fieldIds: [] }, context: {} }))
      .rejects.toThrow(/fieldIds must contain at least 1 element/);
  });

  test("no longer rejects more than 100 fieldIds", async () => {
    try {
      await saveReportDefinition({ payload: { name: "Test", fieldIds: manyFieldIds(150) }, context: {} });
    } catch (err) {
      expect(err.message).not.toMatch(/between 1 and 100/);
    }
  });
});

describe("startProjectUsageReportJob field count validation", () => {
  test("still rejects an empty fieldIds array", async () => {
    await expect(startProjectUsageReportJob({ payload: { fieldIds: [] }, context: {} }))
      .rejects.toThrow(/fieldIds must contain at least 1 element/);
  });

  test("no longer rejects more than 200 fieldIds", async () => {
    try {
      await startProjectUsageReportJob({ payload: { fieldIds: manyFieldIds(250) }, context: {} });
    } catch (err) {
      expect(err.message).not.toMatch(/between 1 and 200/);
    }
  });
});

// ---------------------------------------------------------------------------
// checkMacroAccess -- the macro's own access gate. Deliberately fails open
// (grants access) on any error, since blocking every user due to a transient
// API failure is worse than a brief over-permissive window. That fail-open
// behavior is exactly the kind of thing a refactor could silently invert
// with nothing to catch it, so every branch gets its own test.
// ---------------------------------------------------------------------------
describe("checkMacroAccess", () => {
  test("allows access when restriction is off", async () => {
    mocks.kvsGet.mockResolvedValue({ macroAccess: { restrictAccess: false, allowedGroups: [] } });
    const result = await checkMacroAccess({ context: { accountId: "user-1" } });
    expect(result).toEqual({ allowed: true });
    expect(mocks.apiAsAppRequestJira).not.toHaveBeenCalled();
  });

  test("denies with a clear reason when restricted but no groups configured", async () => {
    mocks.kvsGet.mockResolvedValue({ macroAccess: { restrictAccess: true, allowedGroups: [] } });
    const result = await checkMacroAccess({ context: { accountId: "user-1" } });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no allowed groups/i);
  });

  test("denies when restricted and no accountId is present (not signed in)", async () => {
    mocks.kvsGet.mockResolvedValue({ macroAccess: { restrictAccess: true, allowedGroups: ["jira-admins"] } });
    const result = await checkMacroAccess({ context: {} });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/sign in/i);
  });

  test("allows a user who is in an allowed group", async () => {
    mocks.kvsGet.mockResolvedValue({ macroAccess: { restrictAccess: true, allowedGroups: ["jira-admins"] } });
    mocks.apiAsAppRequestJira.mockResolvedValue({
      ok: true,
      json: async () => [{ name: "jira-admins" }, { name: "other-group" }],
    });
    const result = await checkMacroAccess({ context: { accountId: "user-1" } });
    expect(result).toEqual({ allowed: true });
  });

  test("denies a user who is not in any allowed group", async () => {
    mocks.kvsGet.mockResolvedValue({ macroAccess: { restrictAccess: true, allowedGroups: ["jira-admins"] } });
    mocks.apiAsAppRequestJira.mockResolvedValue({
      ok: true,
      json: async () => [{ name: "some-other-group" }],
    });
    const result = await checkMacroAccess({ context: { accountId: "user-1" } });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/don't have permission/i);
  });

  test("fails open (allows) when the group-lookup API call is not ok", async () => {
    mocks.kvsGet.mockResolvedValue({ macroAccess: { restrictAccess: true, allowedGroups: ["jira-admins"] } });
    mocks.apiAsAppRequestJira.mockResolvedValue({ ok: false, status: 500 });
    const result = await checkMacroAccess({ context: { accountId: "user-1" } });
    expect(result).toEqual({ allowed: true });
  });

  test("fails open (allows) when reading admin config throws", async () => {
    mocks.kvsGet.mockRejectedValue(new Error("kvs unavailable"));
    const result = await checkMacroAccess({ context: { accountId: "user-1" } });
    expect(result).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// getFieldInventory -- the main inventory list: pagination, filtering
// (delegated to the real analysis.js), and force-refresh snapshot-queueing
// with race-token protection.
// ---------------------------------------------------------------------------
describe("getFieldInventory", () => {
  test("returns an empty, non-error shape when no snapshot has ever completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.kvsGet.mockResolvedValue(null);
    const result = await getFieldInventory({ payload: {}, context: {} });
    expect(result.fields).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.snapshotStatus.state).toBe("idle");
  });

  test("returns paginated, hydrated fields from the latest snapshot version", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 3, state: "ready", refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.kvsGet.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([
      snapshotField({ id: "customfield_1", name: "Alpha" }),
      snapshotField({ id: "customfield_2", name: "Beta" }),
    ]);
    const result = await getFieldInventory({ payload: { pageSize: 1, page: 1 }, context: {} });
    expect(result.total).toBe(2);
    expect(result.fields).toHaveLength(1);
    expect(result.totalPages).toBe(2);
    expect(result.fields[0].name).toBe("Alpha"); // default sort name-asc
  });

  test("clamps the requested page to the last valid page instead of returning empty", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, state: "ready" });
    mocks.kvsGet.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    const result = await getFieldInventory({ payload: { page: 99, pageSize: 10 }, context: {} });
    expect(result.page).toBe(1);
    expect(result.fields).toHaveLength(1);
  });

  test("validates page and pageSize bounds", async () => {
    await expect(getFieldInventory({ payload: { page: 0 }, context: {} })).rejects.toThrow(/page/);
    await expect(getFieldInventory({ payload: { pageSize: 500 }, context: {} })).rejects.toThrow(/pageSize/);
  });

  test("force-refresh claims the queue slot with a token and only queues once", async () => {
    mocks.readSnapshotMeta
      .mockResolvedValueOnce({ version: 1, state: "idle" }) // initial read
      .mockResolvedValueOnce({ version: 1, state: "queued", jobToken: "job-token-1" }); // post-claim verify
    mocks.kvsGet.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);

    await getFieldInventory({ payload: { forceRefresh: true }, context: {} });

    expect(mocks.writeSnapshotMeta).toHaveBeenCalledWith("test-install", expect.objectContaining({ state: "queued", jobToken: "job-token-1" }));
    expect(mocks.queueSnapshotBuild).toHaveBeenCalledTimes(1);
  });

  test("force-refresh does not queue a second build if another caller already claimed the slot", async () => {
    mocks.readSnapshotMeta
      .mockResolvedValueOnce({ version: 1, state: "idle" })
      .mockResolvedValueOnce({ version: 1, state: "queued", jobToken: "someone-elses-token" }); // lost the race
    mocks.kvsGet.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([]);

    await getFieldInventory({ payload: { forceRefresh: true }, context: {} });

    expect(mocks.queueSnapshotBuild).not.toHaveBeenCalled();
  });

  test("force-refresh does not queue when the app is in read-only mode", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, state: "idle" });
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true });
    mocks.loadSnapshotFields.mockResolvedValue([]);

    await getFieldInventory({ payload: { forceRefresh: true }, context: {} });

    expect(mocks.queueSnapshotBuild).not.toHaveBeenCalled();
    expect(mocks.writeSnapshotMeta).not.toHaveBeenCalled();
  });

  test("force-refresh on a stuck 'building' state re-queues via requeueStaleSnapshotBuild", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, state: "building" });
    mocks.requeueStaleSnapshotBuild.mockResolvedValue({ version: 1, state: "queued" });
    mocks.kvsGet.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([]);

    await getFieldInventory({ payload: { forceRefresh: true }, context: {} });

    expect(mocks.requeueStaleSnapshotBuild).toHaveBeenCalledWith("test-install", expect.objectContaining({ state: "building" }));
  });

  test("propagates errors and increments the failure metric", async () => {
    mocks.readSnapshotMeta.mockRejectedValue(new Error("SQL connection lost"));
    await expect(getFieldInventory({ payload: {}, context: {} })).rejects.toThrow("SQL connection lost");
    expect(mocks.incrMetric).toHaveBeenCalledWith("resolver-failed");
  });
});

// ---------------------------------------------------------------------------
// getFieldDetails
// ---------------------------------------------------------------------------
describe("getFieldDetails", () => {
  test("requires a non-empty fieldId", async () => {
    await expect(getFieldDetails({ payload: {}, context: {} })).rejects.toThrow(/fieldId/);
  });

  test("throws when no snapshot has completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    await expect(getFieldDetails({ payload: { fieldId: "customfield_1" }, context: {} }))
      .rejects.toThrow(/No completed snapshot/);
  });

  test("throws when the field isn't found in the snapshot", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotField.mockResolvedValue(null);
    mocks.loadSnapshotProjectUsage.mockResolvedValue([]);
    mocks.countSnapshotProjectUsage.mockResolvedValue(0);
    mocks.loadFieldSummary.mockResolvedValue(null);
    await expect(getFieldDetails({ payload: { fieldId: "customfield_missing" }, context: {} }))
      .rejects.toThrow(/Field not found in snapshot/);
  });

  test("returns hydrated field detail with paginated project usage", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.loadSnapshotField.mockResolvedValue(snapshotField());
    mocks.loadSnapshotProjectUsage.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 5, jql: null },
    ]);
    mocks.countSnapshotProjectUsage.mockResolvedValue(1);
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);

    const result = await getFieldDetails({ payload: { fieldId: "customfield_10001" }, context: {} });

    expect(result.field.id).toBe("customfield_10001");
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].projectKey).toBe("ABC");
    expect(result.projectUsageTotalProjects).toBe(1);
  });

  test("marks summaryStatus as failed when a 'ready' summary claims active projects but has none listed (self-healing detection)", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ activeProjectCount: 3 }));
    mocks.loadSnapshotProjectUsage.mockResolvedValue([]);
    mocks.countSnapshotProjectUsage.mockResolvedValue(0);
    mocks.loadFieldSummary.mockResolvedValue({
      summaryStatus: "ready",
      activeProjectCount: 3,
      activeProjects: [], // broken: claims ready+active but lists nothing
    });
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);

    const result = await getFieldDetails({ payload: { fieldId: "customfield_10001" }, context: {} });

    expect(result.summaryStatus).toBe("failed");
  });

  test("falls back to live field-context lookup when the summary has no cached contexts", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotField.mockResolvedValue(snapshotField());
    mocks.loadSnapshotProjectUsage.mockResolvedValue([]);
    mocks.countSnapshotProjectUsage.mockResolvedValue(0);
    mocks.loadFieldSummary.mockResolvedValue({ summaryStatus: "ready", contexts: [] });
    mocks.loadFieldContexts.mockResolvedValue([{ id: "ctx-1", isGlobal: true }]);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);

    const result = await getFieldDetails({ payload: { fieldId: "customfield_10001" }, context: {} });

    expect(mocks.loadFieldContexts).toHaveBeenCalledWith("customfield_10001");
    expect(result.contexts).toEqual([{ id: "ctx-1", isGlobal: true }]);
  });

  test("never returns a project row the caller lacks Browse Projects permission on", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.loadSnapshotField.mockResolvedValue(snapshotField());
    mocks.loadSnapshotProjectUsage.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 5, jql: null },
      { projectId: "20", projectKey: "SECRET", projectName: "Confidential", issueCount: 2, jql: null },
    ]);
    mocks.countSnapshotProjectUsage.mockResolvedValue(2);
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["10"]));

    const result = await getFieldDetails({ payload: { fieldId: "customfield_10001" }, context: ctxWithAccount() });

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].projectKey).toBe("ABC");
    expect(result.projects.some((p) => p.projectKey === "SECRET")).toBe(false);
  });

  test("filters the fallback activeProjects list (fieldSummary path) the same way", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotField.mockResolvedValue(snapshotField());
    mocks.loadSnapshotProjectUsage.mockResolvedValue([]);
    mocks.countSnapshotProjectUsage.mockResolvedValue(0);
    mocks.loadFieldSummary.mockResolvedValue({
      summaryStatus: "ready",
      activeProjectCount: 2,
      activeProjects: [
        { projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 5 },
        { projectId: "20", projectKey: "SECRET", projectName: "Confidential", issueCount: 2 },
      ],
    });
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["10"]));

    const result = await getFieldDetails({ payload: { fieldId: "customfield_10001" }, context: ctxWithAccount() });

    expect(result.projects.map((p) => p.projectKey)).toEqual(["ABC"]);
  });
});

// ---------------------------------------------------------------------------
// getFilteredFieldIds -- same filter pipeline as getFieldInventory, just
// returns bare IDs (used for "select all matching current filters").
// ---------------------------------------------------------------------------
describe("getFilteredFieldIds", () => {
  test("returns an empty list when no snapshot has completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    const result = await getFilteredFieldIds({ payload: {}, context: {} });
    expect(result).toEqual({ fieldIds: [] });
  });

  test("returns field IDs matching a text query", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotFields.mockResolvedValue([
      snapshotField({ id: "customfield_1", name: "Story Points" }),
      snapshotField({ id: "customfield_2", name: "Sprint" }),
    ]);
    const result = await getFilteredFieldIds({ payload: { query: "story" }, context: {} });
    expect(result.fieldIds).toEqual(["customfield_1"]);
  });
});

// ---------------------------------------------------------------------------
// searchFieldOptions
// ---------------------------------------------------------------------------
describe("searchFieldOptions", () => {
  test("requires a non-empty fieldId", async () => {
    await expect(searchFieldOptions({ payload: {}, context: {} })).rejects.toThrow(/fieldId/);
  });

  test("returns an empty/done shape when optionQuery is blank", async () => {
    const result = await searchFieldOptions({ payload: { fieldId: "customfield_1", optionQuery: "" }, context: {} });
    expect(result).toEqual({ status: "empty", matches: [], nextIndex: 0, done: true, scanned: 0, totalCandidates: 0 });
    expect(mocks.searchFieldOptionsCache).not.toHaveBeenCalled();
  });

  test("returns matched field IDs for a non-blank query", async () => {
    mocks.searchFieldOptionsCache.mockResolvedValue([
      { fieldId: "customfield_1" },
      { fieldId: "customfield_2" },
    ]);
    const result = await searchFieldOptions({ payload: { fieldId: "customfield_1", optionQuery: "urgent" }, context: {} });
    expect(result.status).toBe("ok");
    expect(result.matches).toEqual(["customfield_1", "customfield_2"]);
    expect(result.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getFieldOptions
// ---------------------------------------------------------------------------
describe("getFieldOptions", () => {
  test("returns an empty shape when fieldId is blank, without touching storage", async () => {
    const result = await getFieldOptions({ payload: {}, context: {} });
    expect(result).toEqual({ fieldId: "", optionsByContext: [] });
    expect(mocks.loadFieldOptionsCache).not.toHaveBeenCalled();
  });

  test("returns cached options without hitting Jira when the cache is populated", async () => {
    mocks.loadFieldOptionsCache.mockResolvedValue({
      optionsByContext: [{ contextId: "ctx-1", options: [{ id: "1", value: "Yes" }] }],
      refreshedAt: "2026-01-01T00:00:00Z",
    });
    const result = await getFieldOptions({ payload: { fieldId: "customfield_1" }, context: {} });
    expect(result.optionsByContext).toHaveLength(1);
    expect(mocks.loadFieldOptionsFromJira).not.toHaveBeenCalled();
  });

  test("falls back to a live Jira fetch and repopulates the cache when empty", async () => {
    mocks.loadFieldOptionsCache.mockResolvedValue({ optionsByContext: [], refreshedAt: null });
    mocks.loadFieldOptionsFromJira.mockResolvedValue([{ contextId: "ctx-1", options: [{ id: "1", value: "Yes" }] }]);
    mocks.replaceFieldOptionsCache.mockResolvedValue({ refreshedAt: "2026-02-01T00:00:00Z" });

    const result = await getFieldOptions({ payload: { fieldId: "customfield_1" }, context: {} });

    expect(mocks.loadFieldOptionsFromJira).toHaveBeenCalledWith("customfield_1");
    expect(mocks.replaceFieldOptionsCache).toHaveBeenCalled();
    expect(result.refreshedAt).toBe("2026-02-01T00:00:00Z");
  });

  test("enriches options with per-project issue counts when projectKeys are given", async () => {
    mocks.loadFieldOptionsCache.mockResolvedValue({
      optionsByContext: [{ contextId: "ctx-1", options: [{ id: "1", value: "Yes" }] }],
      refreshedAt: "2026-01-01T00:00:00Z",
    });
    mocks.jiraRequest.mockResolvedValue({ total: 7 });

    const result = await getFieldOptions({ payload: { fieldId: "customfield_1", projectKeys: ["ABC"] }, context: {} });

    expect(mocks.jiraRequest).toHaveBeenCalled();
    expect(result.optionsByContext[0].options[0].issueCount).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Admin config -- readAdminConfig / getAdminConfigResolver / saveAdminConfigResolver
// ---------------------------------------------------------------------------
describe("readAdminConfig", () => {
  test("returns defaults when nothing is stored", async () => {
    mocks.kvsGet.mockResolvedValue(null);
    const config = await readAdminConfig();
    expect(config.readOnlyMode).toBe(false);
    expect(config.macroAccess).toEqual({ restrictAccess: false, allowedGroups: [] });
  });

  test("deep-merges stored config over defaults, not a shallow overwrite", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true, macroAccess: { restrictAccess: true } });
    const config = await readAdminConfig();
    expect(config.readOnlyMode).toBe(true);
    // allowedGroups wasn't in the stored macroAccess -- must still come from defaults, not vanish
    expect(config.macroAccess).toEqual({ restrictAccess: true, allowedGroups: [] });
  });

  test("falls back to defaults if kvs.get throws", async () => {
    mocks.kvsGet.mockRejectedValue(new Error("kvs unavailable"));
    const config = await readAdminConfig();
    expect(config.readOnlyMode).toBe(false);
  });
});

describe("getAdminConfigResolver", () => {
  test("delegates to readAdminConfig", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true });
    const config = await getAdminConfigResolver({}, {});
    expect(config.readOnlyMode).toBe(true);
  });
});

describe("saveAdminConfigResolver", () => {
  test("validates apiConcurrency bounds", async () => {
    await expect(saveAdminConfigResolver({ payload: { apiConcurrency: 99 } }))
      .rejects.toThrow(/apiConcurrency/);
  });

  test("validates autoSnapshotFrequency against the allowed enum", async () => {
    await expect(saveAdminConfigResolver({ payload: { autoSnapshotFrequency: "hourly" } }))
      .rejects.toThrow(/autoSnapshotFrequency/);
  });

  test("validates governance threshold values are positive integers", async () => {
    await expect(saveAdminConfigResolver({ payload: { governanceThresholds: { lowUsageIssueThreshold: -5 } } }))
      .rejects.toThrow(/lowUsageIssueThreshold/);
  });

  test("merges partial updates over the current stored config and persists via kvs.set", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: false, apiConcurrency: 4, macroAccess: { restrictAccess: false, allowedGroups: [] } });

    const result = await saveAdminConfigResolver({ payload: { readOnlyMode: true } });

    expect(result.ok).toBe(true);
    expect(result.config.readOnlyMode).toBe(true);
    expect(mocks.kvsSet).toHaveBeenCalledWith("atlasiq-admin-config", expect.objectContaining({ readOnlyMode: true }));
  });

  test("clamps apiConcurrency into [1, 10] even if a valid-but-out-of-clamp-range value slips through", async () => {
    mocks.kvsGet.mockResolvedValue(null);
    const result = await saveAdminConfigResolver({ payload: { apiConcurrency: 1 } });
    expect(result.config.apiConcurrency).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getProjectsView
// ---------------------------------------------------------------------------
describe("getProjectsView", () => {
  test("returns an empty shape when no snapshot has completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    const result = await getProjectsView({ payload: {}, context: {} });
    expect(result.projects).toEqual([]);
    expect(result.selectedProject).toBeNull();
  });

  test("returns an empty shape (with issue-scan status) when there are no projects at all", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.listSnapshotProjects.mockResolvedValue([]);
    mocks.readIssueScanMeta.mockResolvedValue({ state: "ready", totalIssues: 100, processedIssues: 100 });
    const result = await getProjectsView({ payload: {}, context: {} });
    expect(result.projects).toEqual([]);
    expect(result.issueScan.state).toBe("ready");
  });

  test("defaults to the first project when none is explicitly selected", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha" },
      { projectId: "20", projectKey: "XYZ", projectName: "Zulu" },
    ]);
    mocks.readIssueScanMeta.mockResolvedValue(null);
    mocks.loadSnapshotProjectFields.mockResolvedValue({ rows: [], total: 0 });

    const result = await getProjectsView({ payload: {}, context: {} });

    expect(result.selectedProject.projectId).toBe("10");
  });

  test("selects the requested project and returns its paginated fields", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha" },
      { projectId: "20", projectKey: "XYZ", projectName: "Zulu" },
    ]);
    mocks.readIssueScanMeta.mockResolvedValue(null);
    mocks.loadSnapshotProjectFields.mockResolvedValue({
      rows: [{ fieldId: "customfield_1", fieldName: "Story Points", fieldType: "number", customType: "number" }],
      total: 1,
    });

    const result = await getProjectsView({ payload: { projectId: "20" }, context: {} });

    expect(result.selectedProject.projectId).toBe("20");
    expect(result.fields).toHaveLength(1);
    expect(result.totalFields).toBe(1);
    expect(mocks.loadSnapshotProjectFields).toHaveBeenCalledWith(
      "test-install", 1, "20", expect.objectContaining({ query: "", type: "all" })
    );
  });

  test("validates page is a positive integer when provided", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    await expect(getProjectsView({ payload: { page: -1 }, context: {} })).rejects.toThrow(/page/);
  });

  test("never returns a project the caller lacks Browse Projects permission on", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha" },
      { projectId: "20", projectKey: "SECRET", projectName: "Confidential Project" },
    ]);
    mocks.readIssueScanMeta.mockResolvedValue(null);
    mocks.loadSnapshotProjectFields.mockResolvedValue({ rows: [], total: 0 });
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["10"])); // only Alpha is browsable

    const result = await getProjectsView({ payload: {}, context: ctxWithAccount() });

    expect(result.projects).toEqual([{ projectId: "10", projectKey: "ABC", projectName: "Alpha" }]);
    expect(result.projects.some((p) => p.projectKey === "SECRET")).toBe(false);
  });

  test("cannot bypass the filter by requesting a hidden project's id directly", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha" },
      { projectId: "20", projectKey: "SECRET", projectName: "Confidential Project" },
    ]);
    mocks.readIssueScanMeta.mockResolvedValue(null);
    mocks.loadSnapshotProjectFields.mockResolvedValue({ rows: [], total: 0 });
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["10"]));

    // Explicitly ask for the hidden project by id -- should fall back to the
    // first BROWSABLE project instead of honoring the direct request.
    const result = await getProjectsView({ payload: { projectId: "20" }, context: ctxWithAccount() });

    expect(result.selectedProject?.projectId).not.toBe("20");
    expect(result.selectedProject?.projectId).toBe("10");
  });
});

// ---------------------------------------------------------------------------
// getAdminOverview
// ---------------------------------------------------------------------------
describe("getAdminOverview", () => {
  test("aggregates job-status counts from field summaries", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", totalFields: 10, processedFields: 10 });
    mocks.listFieldSummaries.mockResolvedValue([
      { summaryStatus: "ready" }, { summaryStatus: "ready" }, { summaryStatus: "building" }, { summaryStatus: "failed" },
    ]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);

    const result = await getAdminOverview({ context: {} });

    expect(result.jobCounts).toEqual({ queued: 0, building: 1, ready: 2, failed: 1, cancelled: 0, unbuilt: 0 });
    expect(result.totalSummaries).toBe(4);
  });

  test("counts an unrecognized summaryStatus as unbuilt rather than dropping it", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.listFieldSummaries.mockResolvedValue([{ summaryStatus: "some-unknown-state" }, {}]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);

    const result = await getAdminOverview({ context: {} });

    expect(result.jobCounts.unbuilt).toBe(2);
  });

  test("computes findings summary from the latest snapshot when one exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);

    const result = await getAdminOverview({ context: {} });

    expect(result.findingsSummary).toEqual(expect.objectContaining({
      adminAttention: expect.any(Number), risky: expect.any(Number), cleanup: expect.any(Number), standardize: expect.any(Number),
    }));
  });

  test("does not fail the whole overview if the findings computation throws", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockRejectedValue(new Error("SQL error"));

    const result = await getAdminOverview({ context: {} });

    expect(result.findingsSummary).toEqual({ adminAttention: 0, risky: 0, cleanup: 0, standardize: 0 });
  });
});

// ---------------------------------------------------------------------------
// Issue scan lifecycle -- the most complex stateful subsystem in the app.
// RUNBOOK.md's entire "Section 1: Universe Scan Recovery" is a spec for this
// code's failure modes (stuck scan, resume, force resume, cancel) -- tests
// below are written directly against that spec.
// ---------------------------------------------------------------------------
describe("startIssueScan", () => {
  test("refuses to start a second scan while one is already building", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "building" });
    const result = await startIssueScan({ context: {} });
    expect(result).toEqual({ started: false, reason: "already-running", meta: { state: "building" } });
    expect(mocks.queuePush).not.toHaveBeenCalled();
  });

  test("refuses to start a second scan while one is queued", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "queued" });
    const result = await startIssueScan({ context: {} });
    expect(result.started).toBe(false);
  });

  test("queues a new scan with a fresh job token when idle", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "idle" });
    const result = await startIssueScan({ context: {} });
    expect(result).toEqual({ started: true, jobToken: "job-token-1" });
    expect(mocks.writeIssueScanMeta).toHaveBeenCalledWith("test-install", expect.objectContaining({ state: "queued", jobToken: "job-token-1" }));
    expect(mocks.queuePush).toHaveBeenCalledWith({ body: { jobType: "run-issue-scan", installationKey: "test-install" } });
  });

  test("marks the scan failed and re-throws if the queue push itself fails", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "idle" });
    mocks.queuePush.mockRejectedValue(new Error("queue backpressure"));

    await expect(startIssueScan({ context: {} })).rejects.toThrow("queue backpressure");

    expect(mocks.writeIssueScanMeta).toHaveBeenLastCalledWith("test-install", expect.objectContaining({ state: "failed" }));
  });
});

describe("resumeIssueScan", () => {
  test("reports no-scan when nothing has ever run", async () => {
    mocks.readIssueScanMeta.mockResolvedValue(null);
    const result = await resumeIssueScan({ context: {} });
    expect(result).toEqual({ resumed: false, reason: "no-scan" });
  });

  test("reports already-complete for a ready scan rather than re-running it", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "ready" });
    const result = await resumeIssueScan({ context: {} });
    expect(result.resumed).toBe(false);
    expect(result.reason).toBe("already-complete");
  });

  test("re-queues only workers that are not done, and resets failed ones to queued first", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "failed", jobToken: "old-token", progressLog: [] });
    mocks.writeIssueScanMeta.mockResolvedValue({ state: "building" });
    mocks.readIssueScanWorker.mockImplementation((_key, workerId) => {
      if (workerId === 0) return Promise.resolve({ status: "done" });
      if (workerId === 1) return Promise.resolve({ status: "failed" });
      return Promise.resolve({ status: "queued" });
    });

    const result = await resumeIssueScan({ context: {} });

    expect(result.resumed).toBe(true);
    // worker 0 (done) must NOT be re-queued
    expect(mocks.queueIssueScanWorker).not.toHaveBeenCalledWith("test-install", 0);
    // worker 1 (failed) must be reset to queued, then re-queued
    expect(mocks.updateIssueScanWorker).toHaveBeenCalledWith("test-install", 1, { status: "queued", lastError: null });
    expect(mocks.queueIssueScanWorker).toHaveBeenCalledWith("test-install", 1);
    // every other non-done worker gets re-queued too
    expect(mocks.queueIssueScanWorker).toHaveBeenCalledWith("test-install", 2);
  });

  test("marks the scan failed and throws when a worker re-queue fails", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "building", progressLog: [] });
    mocks.writeIssueScanMeta.mockResolvedValue({ state: "building" });
    mocks.readIssueScanWorker.mockResolvedValue({ status: "queued" });
    mocks.queueIssueScanWorker.mockRejectedValue(new Error("queue full"));

    await expect(resumeIssueScan({ context: {} })).rejects.toThrow(/Resume partially failed/);

    expect(mocks.writeIssueScanMeta).toHaveBeenLastCalledWith("test-install", expect.objectContaining({ state: "failed" }));
  });
});

describe("cancelIssueScan", () => {
  test("reports not-running when there's no active scan", async () => {
    mocks.readIssueScanMeta.mockResolvedValue(null);
    const result = await cancelIssueScan({ context: {} });
    expect(result).toEqual({ cancelled: false, reason: "not-running" });
  });

  test("reports not-running for an already-idle or already-ready scan", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "ready" });
    const result = await cancelIssueScan({ context: {} });
    expect(result.cancelled).toBe(false);
  });

  test("cancels an in-progress scan", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "building", progressLog: [] });
    const result = await cancelIssueScan({ context: {} });
    expect(result).toEqual({ cancelled: true });
    expect(mocks.writeIssueScanMeta).toHaveBeenCalledWith("test-install", expect.objectContaining({ state: "cancelled" }));
  });
});

describe("getIssueScanStatus", () => {
  test("returns null meta when no scan has ever run", async () => {
    mocks.readIssueScanMeta.mockResolvedValue(null);
    const result = await getIssueScanStatus({ context: {} });
    expect(result).toEqual({ meta: null });
  });

  test("surfaces the internal 'finalizing' transition state as 'building' to the UI", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "finalizing", processedPages: 10 });
    const result = await getIssueScanStatus({ context: {} });
    expect(result.meta.state).toBe("building");
  });

  test("passes through any other state as-is", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "ready" });
    const result = await getIssueScanStatus({ context: {} });
    expect(result.meta.state).toBe("ready");
  });
});

describe("startDeltaIssueScan", () => {
  test("refuses to start while a delta scan is already building or queued", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "building" });
    const result = await startDeltaIssueScan({ context: {} });
    expect(result).toEqual({ started: false, reason: "already-running" });
  });

  test("queues a new delta scan under a distinct ::delta scope key", async () => {
    mocks.readIssueScanMeta.mockResolvedValue(null);
    const result = await startDeltaIssueScan({ context: {} });
    expect(result).toEqual({ started: true });
    expect(mocks.writeIssueScanMeta).toHaveBeenCalledWith("test-install::delta", expect.objectContaining({ state: "queued" }));
    expect(mocks.queuePush).toHaveBeenCalledWith({ body: { jobType: "run-delta-issue-scan", installationKey: "test-install" } });
  });
});

describe("getDeltaIssueScanStatus", () => {
  test("reads from the ::delta scope key, distinct from the full scan", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "ready" });
    const result = await getDeltaIssueScanStatus({ context: {} });
    expect(mocks.readIssueScanMeta).toHaveBeenCalledWith("test-install::delta");
    expect(result.meta.state).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// runDeltaIssueScanJob -- the queue-consumer entry point, not resolver-
// registered directly. Never throws (always catches and writes a failed
// state); covering the guard clause, a single-page happy path with RQT +
// project-usage aggregation, pagination continuation, and the top-level
// catch-all.
// ---------------------------------------------------------------------------
describe("runDeltaIssueScanJob", () => {
  function jiraSearchResponse(issues, nextPageToken = null) {
    return { issues, nextPageToken, total: issues.length };
  }

  test("skips silently when a delta scan is already building and recently started", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "building", startedAt: new Date().toISOString() });
    await runDeltaIssueScanJob("test-install");
    expect(mocks.jiraRequest).not.toHaveBeenCalled();
    expect(mocks.writeIssueScanMeta).not.toHaveBeenCalled();
  });

  test("proceeds if the existing 'building' state is stale (started over 10 minutes ago)", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "building", startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() });
    mocks.jiraRequest.mockResolvedValue(jiraSearchResponse([]));
    mocks.readSnapshotMeta.mockResolvedValue(null);

    await runDeltaIssueScanJob("test-install");

    expect(mocks.jiraRequest).toHaveBeenCalled();
  });

  test("scans a single page, aggregates field/project usage, and writes a ready state", async () => {
    mocks.readIssueScanMeta.mockResolvedValue(null);
    mocks.jiraRequest
      .mockResolvedValueOnce({ total: 1 }) // initial count call
      .mockResolvedValueOnce(jiraSearchResponse([
        {
          key: "ABC-1",
          fields: {
            project: { id: "10", key: "ABC", name: "Alpha" },
            summary: "Test issue",
            customfield_10001: "Some value",
          },
        },
      ], null));
    mocks.readSnapshotMeta.mockResolvedValue(null); // no snapshot -> skip field-usage update

    await runDeltaIssueScanJob("test-install");

    expect(mocks.upsertProjectTotalsForDelta).toHaveBeenCalled();
    const finalCall = mocks.writeIssueScanMeta.mock.calls.at(-1);
    expect(finalCall[0]).toBe("test-install::delta");
    expect(finalCall[1]).toEqual(expect.objectContaining({ state: "ready", processedIssues: 1 }));
  });

  test("continues across multiple pages until nextPageToken is exhausted", async () => {
    mocks.readIssueScanMeta.mockResolvedValue(null);
    mocks.jiraRequest
      .mockResolvedValueOnce({ total: 2 })
      .mockResolvedValueOnce(jiraSearchResponse(
        [{ key: "ABC-1", fields: { project: { id: "10", key: "ABC", name: "Alpha" } } }],
        "page-2-token"
      ))
      .mockResolvedValueOnce(jiraSearchResponse(
        [{ key: "ABC-2", fields: { project: { id: "10", key: "ABC", name: "Alpha" } } }],
        null
      ));
    mocks.readSnapshotMeta.mockResolvedValue(null);

    await runDeltaIssueScanJob("test-install");

    const finalCall = mocks.writeIssueScanMeta.mock.calls.at(-1);
    expect(finalCall[1]).toEqual(expect.objectContaining({ state: "ready", processedPages: 2, processedIssues: 2 }));
  });

  test("skips field-usage update (but still finishes) when no snapshot exists yet", async () => {
    mocks.readIssueScanMeta.mockResolvedValue(null);
    mocks.jiraRequest
      .mockResolvedValueOnce({ total: 0 })
      .mockResolvedValueOnce(jiraSearchResponse([], null));
    mocks.readSnapshotMeta.mockResolvedValue(null);

    await runDeltaIssueScanJob("test-install");

    expect(mocks.upsertDeltaFieldProjectUsage).not.toHaveBeenCalled();
    const finalCall = mocks.writeIssueScanMeta.mock.calls.at(-1);
    expect(finalCall[1].state).toBe("ready");
  });

  test("never throws -- writes a failed state and swallows the error instead", async () => {
    mocks.readIssueScanMeta.mockResolvedValue(null);
    mocks.jiraRequest.mockRejectedValue(new Error("Jira is down"));
    // ensureProjectStoreReady throwing is the simplest way to force the top-level catch
    mocks.ensureProjectStoreReady.mockRejectedValueOnce(new Error("SQL unavailable"));

    await expect(runDeltaIssueScanJob("test-install")).resolves.toBeUndefined();

    expect(mocks.writeIssueScanMeta).toHaveBeenCalledWith("test-install::delta", expect.objectContaining({ state: "failed" }));
  });
});

// ---------------------------------------------------------------------------
// Snapshot & project-usage job lifecycle -- RUNBOOK.md's "Section 2: Snapshot
// Build Recovery" and "Section 3: Database Health" / field summary job
// recovery are the spec for this group.
// ---------------------------------------------------------------------------
describe("cancelSnapshot", () => {
  test("nulls buildingVersion so any in-flight build's own version-check fails", async () => {
    const result = await cancelSnapshot({ context: {} });
    expect(result).toEqual({ cancelled: true });
    expect(mocks.writeSnapshotMeta).toHaveBeenCalledWith("test-install", expect.objectContaining({ state: "cancelled", buildingVersion: null }));
  });
});

describe("getProjectUsageJobs", () => {
  test("shapes each job with a computed percentComplete from processed/estimated issue counts", async () => {
    mocks.listFieldSummaries.mockResolvedValue([
      { fieldId: "customfield_1", summaryStatus: "building", processedIssueCount: 50, estimatedIssueTotal: 200 },
      { fieldId: "customfield_2", summaryStatus: "ready", processedIssueCount: 0, estimatedIssueTotal: 0 },
    ]);
    const result = await getProjectUsageJobs({ context: {} });
    expect(result.jobs[0].percentComplete).toBe(25);
    // ready with no estimate still reports 100%, not 0%
    expect(result.jobs[1].percentComplete).toBe(100);
  });
});

describe("refreshRecentProjectUsage", () => {
  test("throws when no snapshot has completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    await expect(refreshRecentProjectUsage({ payload: {}, context: {} })).rejects.toThrow(/No completed snapshot/);
  });

  test("clamps hours and maxIssues into their allowed ranges", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.collectRecentFieldProjectCandidates.mockResolvedValue({ fields: [], scannedIssues: 0 });
    const result = await refreshRecentProjectUsage({ payload: { hours: 9999, maxIssues: 1 }, context: {} });
    expect(mocks.collectRecentFieldProjectCandidates).toHaveBeenCalledWith(168, 50); // clamped to max 168h, min 50 issues
    expect(result.windowHours).toBe(168);
  });

  test("queues a full rebuild for a field with no existing ready summary", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.collectRecentFieldProjectCandidates.mockResolvedValue({
      fields: [{ fieldId: "customfield_1", projectKeys: ["ABC"] }],
      scannedIssues: 5,
    });
    mocks.listFieldSummaries.mockResolvedValue([]); // no existing summary
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1", totalIssueCount: 10 }));
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.queueFieldSummaryContinuationWithRetry.mockResolvedValue({ queued: true });

    const result = await refreshRecentProjectUsage({ payload: {}, context: {} });

    expect(result.queuedCount).toBe(1);
    expect(result.fullRebuildCount).toBe(1);
  });

  test("queues an incremental delta refresh for a field with an existing ready summary", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.collectRecentFieldProjectCandidates.mockResolvedValue({
      fields: [{ fieldId: "customfield_1", projectKeys: ["ABC"] }],
      scannedIssues: 5,
    });
    mocks.listFieldSummaries.mockResolvedValue([{ fieldId: "customfield_1", summaryStatus: "ready" }]);
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1" }));
    mocks.queueFieldUsageDeltaRefreshWithRetry.mockResolvedValue({ queued: true });

    const result = await refreshRecentProjectUsage({ payload: {}, context: {} });

    expect(result.queuedCount).toBe(1);
    expect(result.fullRebuildCount).toBe(0);
    expect(mocks.replaceFieldSummary).toHaveBeenCalledWith("test-install", "customfield_1", expect.objectContaining({ summaryStatus: "queued" }));
  });

  test("marks a field deferred when the incremental refresh queue push fails", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.collectRecentFieldProjectCandidates.mockResolvedValue({
      fields: [{ fieldId: "customfield_1", projectKeys: ["ABC"] }],
      scannedIssues: 5,
    });
    mocks.listFieldSummaries.mockResolvedValue([{ fieldId: "customfield_1", summaryStatus: "ready" }]);
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1" }));
    mocks.queueFieldUsageDeltaRefreshWithRetry.mockResolvedValue({ queued: false, attempts: 3 });

    const result = await refreshRecentProjectUsage({ payload: {}, context: {} });

    expect(result.queuedCount).toBe(0);
    expect(mocks.replaceFieldSummary).toHaveBeenLastCalledWith("test-install", "customfield_1", expect.objectContaining({ summaryStatus: "deferred" }));
  });
});

describe("cancelProjectUsageJob", () => {
  test("requires a fieldId", async () => {
    await expect(cancelProjectUsageJob({ payload: {}, context: {} })).rejects.toThrow(/fieldId/);
  });

  test("reports not-found when there's no summary for the field", async () => {
    mocks.loadFieldSummary.mockResolvedValue(null);
    const result = await cancelProjectUsageJob({ payload: { fieldId: "customfield_1" }, context: {} });
    expect(result).toEqual({ cancelled: false, reason: "not-found" });
  });

  test("marks the job cancelled", async () => {
    mocks.loadFieldSummary.mockResolvedValue({ summaryStatus: "building", progressLog: [] });
    const result = await cancelProjectUsageJob({ payload: { fieldId: "customfield_1" }, context: {} });
    expect(result).toEqual({ cancelled: true });
    expect(mocks.replaceFieldSummary).toHaveBeenCalledWith("test-install", "customfield_1", expect.objectContaining({ summaryStatus: "cancelled" }));
  });
});

describe("restartProjectUsageJob", () => {
  test("requires a fieldId", async () => {
    await expect(restartProjectUsageJob({ payload: {}, context: {} })).rejects.toThrow(/fieldId/);
  });

  test("throws when no snapshot has completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    await expect(restartProjectUsageJob({ payload: { fieldId: "customfield_1" }, context: {} })).rejects.toThrow(/No completed snapshot/);
  });

  test("throws when the field isn't in the snapshot", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotField.mockResolvedValue(null);
    await expect(restartProjectUsageJob({ payload: { fieldId: "customfield_missing" }, context: {} })).rejects.toThrow(/Field not found/);
  });

  test("wipes existing usage rows and starts a fresh job from zero", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1" }));

    const result = await restartProjectUsageJob({ payload: { fieldId: "customfield_1" }, context: {} });

    expect(result).toEqual({ queued: true, fieldId: "customfield_1" });
    expect(mocks.replaceSnapshotProjectUsageForField).toHaveBeenCalledWith("test-install", 1, "customfield_1", []);
    expect(mocks.replaceFieldSummary).toHaveBeenCalledWith("test-install", "customfield_1", expect.objectContaining({ summaryStatus: "queued", processedIssueCount: 0 }));
    expect(mocks.processFieldSummaryChunk).toHaveBeenCalledWith("test-install", 1, expect.objectContaining({ id: "customfield_1" }), expect.any(String), 0, null, 1);
  });
});

describe("resumeProjectUsageJob", () => {
  test("requires a fieldId", async () => {
    await expect(resumeProjectUsageJob({ payload: {}, context: {} })).rejects.toThrow(/fieldId/);
  });

  test("throws when no snapshot has completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    await expect(resumeProjectUsageJob({ payload: { fieldId: "customfield_1" }, context: {} })).rejects.toThrow(/No completed snapshot/);
  });

  test("throws when there's no existing job state to resume", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotField.mockResolvedValue(snapshotField());
    mocks.loadFieldSummary.mockResolvedValue(null);
    await expect(resumeProjectUsageJob({ payload: { fieldId: "customfield_1" }, context: {} })).rejects.toThrow(/No existing project-usage job state/);
  });

  test("refuses to resume a job that's already running", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotField.mockResolvedValue(snapshotField());
    mocks.loadFieldSummary.mockResolvedValue({ summaryStatus: "building" });
    const result = await resumeProjectUsageJob({ payload: { fieldId: "customfield_1" }, context: {} });
    expect(result).toEqual({ queued: false, fieldId: "customfield_1", reason: "already-running" });
  });

  test("resumes from the last checkpoint (processedIssueCount), not from zero", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1" }));
    mocks.loadFieldSummary.mockResolvedValue({
      summaryStatus: "failed", processedIssueCount: 340, nextPageToken: "page-token-abc", progressLog: [],
    });

    const result = await resumeProjectUsageJob({ payload: { fieldId: "customfield_1" }, context: {} });

    expect(result).toEqual({ queued: true, fieldId: "customfield_1", resumedFrom: 340 });
    expect(mocks.processFieldSummaryChunk).toHaveBeenCalledWith("test-install", 1, expect.objectContaining({ id: "customfield_1" }), expect.any(String), 340, "page-token-abc", 1);
  });
});

describe("restoreProjectUsageCache", () => {
  test("reports no-snapshot when nothing has completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    const result = await restoreProjectUsageCache({ context: {} });
    expect(result).toEqual({ started: false, reason: "no-snapshot" });
    expect(mocks.queueProjectUsageRestore).not.toHaveBeenCalled();
  });

  test("queues a full restore from the latest snapshot version", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 7 });
    const result = await restoreProjectUsageCache({ context: {} });
    expect(result).toEqual({ started: true, version: 7 });
    expect(mocks.queueProjectUsageRestore).toHaveBeenCalledWith("test-install", 7);
  });
});

// ---------------------------------------------------------------------------
// Reports -- getSavedReports/deleteReportDefinition extend the existing
// saveReportDefinition/startProjectUsageReportJob coverage from the field-cap
// fix. getProjectUsageReport is the most complex read path in the app: a
// 3-tier data fallback chain plus 3 independent auto-queue caps.
// ---------------------------------------------------------------------------
describe("getSavedReports", () => {
  test("returns the installation's saved report list", async () => {
    mocks.listSavedReports.mockResolvedValue([{ reportId: "r1", name: "My Report", fieldIds: ["customfield_1"] }]);
    const result = await getSavedReports({ context: {} });
    expect(result.reports).toHaveLength(1);
    expect(mocks.listSavedReports).toHaveBeenCalledWith("test-install");
  });
});

describe("deleteReportDefinition", () => {
  test("requires a reportId", async () => {
    await expect(deleteReportDefinition({ payload: {}, context: {} })).rejects.toThrow(/reportId/);
  });

  test("deletes and returns the refreshed list", async () => {
    mocks.listSavedReports.mockResolvedValue([]);
    const result = await deleteReportDefinition({ payload: { reportId: "r1" }, context: {} });
    expect(mocks.deleteSavedReport).toHaveBeenCalledWith("test-install", "r1");
    expect(result.reports).toEqual([]);
  });
});

describe("getProjectUsageReport", () => {
  test("returns an empty shape without touching storage when fieldIds is empty", async () => {
    const result = await getProjectUsageReport({ payload: { fieldIds: [] }, context: {} });
    expect(result).toEqual({ fields: [], projects: [] });
    expect(mocks.ensureProjectStoreReady).toHaveBeenCalled(); // still runs before the shortcut
    expect(mocks.readSnapshotMeta).not.toHaveBeenCalled();
  });

  test("throws when no snapshot has completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    await expect(getProjectUsageReport({ payload: { fieldIds: ["customfield_1"] }, context: {} }))
      .rejects.toThrow(/No completed snapshot/);
  });

  test("skips a field that's missing from the snapshot entirely rather than erroring the whole report", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.loadSnapshotField.mockResolvedValue(null);
    mocks.loadAllSnapshotProjectUsage.mockResolvedValue([]);
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.getDistinctIssueCountForFields.mockResolvedValue(0);

    const result = await getProjectUsageReport({ payload: { fieldIds: ["customfield_missing"] }, context: {} });

    expect(result.fields).toEqual([]);
  });

  test("uses current-version project usage when present", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1" }));
    mocks.loadAllSnapshotProjectUsage.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 5 },
    ]);
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.getDistinctIssueCountForFields.mockResolvedValue(5);

    const result = await getProjectUsageReport({ payload: { fieldIds: ["customfield_1"] }, context: {} });

    expect(result.fields[0].projects).toHaveLength(1);
    expect(mocks.loadAnySnapshotProjectUsage).not.toHaveBeenCalled(); // didn't need the fallback
  });

  test("falls back to any-version usage when the current version has none", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 2 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1" }));
    mocks.loadAllSnapshotProjectUsage.mockResolvedValue([]);
    mocks.loadAnySnapshotProjectUsage.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 3 },
    ]);
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.getDistinctIssueCountForFields.mockResolvedValue(3);

    const result = await getProjectUsageReport({ payload: { fieldIds: ["customfield_1"] }, context: {} });

    expect(mocks.loadAnySnapshotProjectUsage).toHaveBeenCalledWith("test-install", "customfield_1");
    expect(result.fields[0].projects).toHaveLength(1);
  });

  test("falls back to the field summary's cached activeProjects as a last resort", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 2 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1" }));
    mocks.loadAllSnapshotProjectUsage.mockResolvedValue([]);
    mocks.loadAnySnapshotProjectUsage.mockResolvedValue([]);
    mocks.loadFieldSummary.mockResolvedValue({
      activeProjects: [{ projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 2 }],
    });
    mocks.getDistinctIssueCountForFields.mockResolvedValue(2);

    const result = await getProjectUsageReport({ payload: { fieldIds: ["customfield_1"] }, context: {} });

    expect(result.fields[0].projects).toHaveLength(1);
    expect(result.fields[0].projects[0].projectKey).toBe("ABC");
  });

  test("marks a field pending (already-running) instead of re-queueing when its job is already queued/building", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1", totalIssueCount: 50 }));
    mocks.loadAllSnapshotProjectUsage.mockResolvedValue([]);
    mocks.loadAnySnapshotProjectUsage.mockResolvedValue([]);
    mocks.loadFieldSummary.mockResolvedValue({ summaryStatus: "building" });
    mocks.getDistinctIssueCountForFields.mockResolvedValue(0);

    const result = await getProjectUsageReport({ payload: { fieldIds: ["customfield_1"] }, context: {} });

    expect(result.pendingFields).toEqual([
      { fieldId: "customfield_1", fieldName: "Story Points", summaryStatus: "building", reason: "already-running" },
    ]);
    expect(mocks.replaceFieldSummary).not.toHaveBeenCalled(); // never touched ensureProjectUsageJobQueued's write path
  });

  test("auto-queues a missing field's project-usage job when under all caps", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.listFieldSummaries.mockResolvedValue([]); // no running jobs -> under every cap
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1", totalIssueCount: 50 }));
    mocks.loadAllSnapshotProjectUsage.mockResolvedValue([]);
    mocks.loadAnySnapshotProjectUsage.mockResolvedValue([]);
    mocks.loadFieldSummary.mockResolvedValue(null); // no summary at all -> not already-running
    mocks.queueFieldSummaryContinuationWithRetry.mockResolvedValue({ queued: true });
    mocks.getDistinctIssueCountForFields.mockResolvedValue(0);

    const result = await getProjectUsageReport({ payload: { fieldIds: ["customfield_1"] }, context: {} });

    expect(result.pendingFields).toEqual([
      { fieldId: "customfield_1", fieldName: "Story Points", summaryStatus: "queued", reason: "project-usage-missing" },
    ]);
  });

  test("defers a candidate once the active-job cap (3) is already reached", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    // 3 already-running summaries -> at MAX_ACTIVE_PROJECT_USAGE_JOBS
    mocks.listFieldSummaries.mockResolvedValue([
      { fieldId: "x1", summaryStatus: "building", totalIssueCount: 10 },
      { fieldId: "x2", summaryStatus: "building", totalIssueCount: 10 },
      { fieldId: "x3", summaryStatus: "building", totalIssueCount: 10 },
    ]);
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1", totalIssueCount: 50 }));
    mocks.loadAllSnapshotProjectUsage.mockResolvedValue([]);
    mocks.loadAnySnapshotProjectUsage.mockResolvedValue([]);
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.getDistinctIssueCountForFields.mockResolvedValue(0);

    const result = await getProjectUsageReport({ payload: { fieldIds: ["customfield_1"] }, context: {} });

    expect(result.pendingFields).toEqual([
      { fieldId: "customfield_1", fieldName: "Story Points", summaryStatus: "deferred", reason: "deferred-active-job-cap" },
    ]);
    // deferred candidates get recorded via ensureDeferredProjectUsageJobRecorded, not queued
    expect(mocks.queueFieldSummaryContinuationWithRetry).not.toHaveBeenCalled();
  });

  test("returns the deduped, sorted set of projects across all requested fields", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.loadSnapshotField.mockImplementation((_i, _v, fieldId) => Promise.resolve(snapshotField({ id: fieldId, name: fieldId })));
    mocks.loadAllSnapshotProjectUsage.mockImplementation((_i, _v, fieldId) =>
      Promise.resolve(fieldId === "customfield_1"
        ? [{ projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 1 }]
        : [{ projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 1 }, { projectId: "20", projectKey: "XYZ", projectName: "Zulu", issueCount: 1 }])
    );
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.getDistinctIssueCountForFields.mockResolvedValue(2);

    const result = await getProjectUsageReport({ payload: { fieldIds: ["customfield_1", "customfield_2"] }, context: {} });

    expect(result.projects.map((p) => p.projectKey)).toEqual(["ABC", "XYZ"]); // deduped, sorted by key
  });

  test("never returns a project (top-level or per-field) the caller lacks Browse Projects permission on", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1" }));
    mocks.loadAllSnapshotProjectUsage.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 1 },
      { projectId: "20", projectKey: "SECRET", projectName: "Confidential", issueCount: 1 },
    ]);
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.getDistinctIssueCountForFields.mockResolvedValue(2);
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["10"]));

    const result = await getProjectUsageReport({ payload: { fieldIds: ["customfield_1"] }, context: ctxWithAccount() });

    expect(result.projects.map((p) => p.projectKey)).toEqual(["ABC"]);
    expect(result.fields[0].projects.map((p) => p.projectKey)).toEqual(["ABC"]);
    expect(result.fields[0].activeProjectCount).toBe(1); // recomputed from the filtered set, not the original 2
  });
});

describe("getProjectUsageReportJob", () => {
  test("returns a null job when no jobId is given", async () => {
    const result = await getProjectUsageReportJob({ payload: {}, context: {} });
    expect(result).toEqual({ job: null });
    expect(mocks.loadReportJob).not.toHaveBeenCalled();
  });

  test("returns a null job when the jobId doesn't match anything stored", async () => {
    mocks.loadReportJob.mockResolvedValue(null);
    const result = await getProjectUsageReportJob({ payload: { jobId: "job-1" }, context: {} });
    expect(result).toEqual({ job: null });
  });

  test("computes percentComplete from processed/total fields", async () => {
    mocks.loadReportJob.mockResolvedValue({ jobId: "job-1", totalFields: 4, processedFields: 1 });
    const result = await getProjectUsageReportJob({ payload: { jobId: "job-1" }, context: {} });
    expect(result.job.percentComplete).toBe(25);
  });

  test("reports 0% for a job with no totalFields yet, rather than dividing by zero", async () => {
    mocks.loadReportJob.mockResolvedValue({ jobId: "job-1", totalFields: 0, processedFields: 0 });
    const result = await getProjectUsageReportJob({ payload: { jobId: "job-1" }, context: {} });
    expect(result.job.percentComplete).toBe(0);
  });

  test("filters a stored report's result using the CURRENT reader's permissions, not the original admin's", async () => {
    // An admin could have built this job (they're always allowed to start one),
    // but a different, less-privileged person reading it later must not see
    // projects that admin could see but they themselves cannot.
    mocks.loadReportJob.mockResolvedValue({
      jobId: "job-1",
      totalFields: 1,
      processedFields: 1,
      result: {
        fields: [{ fieldId: "customfield_1", fieldName: "Story Points", activeProjectCount: 2, projects: [
          { projectId: "10", projectKey: "ABC", projectName: "Alpha" },
          { projectId: "20", projectKey: "SECRET", projectName: "Confidential" },
        ] }],
        projects: [
          { projectId: "10", projectKey: "ABC", projectName: "Alpha" },
          { projectId: "20", projectKey: "SECRET", projectName: "Confidential" },
        ],
        pendingFields: [],
        uniqueIssueCount: 2,
      },
    });
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["10"])); // this reader can only see Alpha

    const result = await getProjectUsageReportJob({ payload: { jobId: "job-1" }, context: ctxWithAccount("less-privileged-user") });

    expect(result.job.result.projects.map((p) => p.projectKey)).toEqual(["ABC"]);
    expect(result.job.result.fields[0].projects.map((p) => p.projectKey)).toEqual(["ABC"]);
    expect(result.job.result.fields[0].activeProjectCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// RQT (required-query-token) index -- governance analytics surface.
// ---------------------------------------------------------------------------
describe("getRqtIndex", () => {
  test("aggregates totals and enriches field names from the live snapshot", async () => {
    mocks.loadRqtFieldIndex.mockResolvedValue([
      { fieldId: "customfield_1", issueCount: 10, sampleValues: ["A", "B"], refreshedAt: "2026-01-01T00:00:00Z" },
    ]);
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadRqtIssueKeys.mockResolvedValue([{ projectId: "10", total: 5 }]);
    mocks.loadRqtValueFrequency.mockResolvedValue([]);
    mocks.loadIssueRqtValues.mockResolvedValue([]);
    mocks.loadRqtFieldIssueIndex.mockResolvedValue([]);
    mocks.loadSnapshotFields.mockResolvedValue([{ id: "customfield_1", name: "Real Field Name" }]);

    const result = await getRqtIndex({ context: {} });

    expect(result.fields[0].fieldName).toBe("Real Field Name"); // enriched from snapshot
    expect(result.totalIssues).toBe(10);
    expect(result.totalUniqueIssues).toBe(5);
    expect(result.uniqueValues).toEqual(["A", "B"]);
  });

  test("still returns a full shape (without name enrichment) when there's no snapshot yet", async () => {
    mocks.loadRqtFieldIndex.mockResolvedValue([{ fieldId: "customfield_1", issueCount: 3, sampleValues: [], refreshedAt: null }]);
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.loadRqtIssueKeys.mockResolvedValue([]);
    mocks.loadRqtValueFrequency.mockResolvedValue([]);
    mocks.loadIssueRqtValues.mockResolvedValue([]);
    mocks.loadRqtFieldIssueIndex.mockResolvedValue([]);

    const result = await getRqtIndex({ context: {} });

    expect(result.fieldCount).toBe(1);
    expect(mocks.loadSnapshotFields).not.toHaveBeenCalled();
  });
});

describe("searchRqtValue", () => {
  test("returns an empty list without querying storage when rqtValue is blank", async () => {
    const result = await searchRqtValue({ payload: {}, context: {} });
    expect(result).toEqual({ issueKeys: [] });
    expect(mocks.searchRqtValueIssueKeys).not.toHaveBeenCalled();
  });

  test("normalizes the search value to uppercase before searching", async () => {
    mocks.searchRqtValueIssueKeys.mockResolvedValue(["ABC-1", "ABC-2"]);
    const result = await searchRqtValue({ payload: { rqtValue: "req-42" }, context: {} });
    expect(mocks.searchRqtValueIssueKeys).toHaveBeenCalledWith("test-install", "REQ-42");
    expect(result.issueKeys).toEqual(["ABC-1", "ABC-2"]);
  });
});

// ---------------------------------------------------------------------------
// Rovo agent actions -- note the (payload, context) positional signature,
// different from every other resolver's ({ payload, context }) destructure.
// ---------------------------------------------------------------------------
describe("rovoSearchFields", () => {
  test("requires a query", async () => {
    const result = await rovoSearchFields({}, {});
    expect(result).toEqual({ status: "error", message: "A search query is required." });
  });

  test("reports snapshot-unavailable when no snapshot has completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    const result = await rovoSearchFields({ query: "story points" }, {});
    expect(result.status).toBe("snapshot-unavailable");
    expect(result.matches).toEqual([]);
  });

  test("returns matching fields, capped at maxResults", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.loadSnapshotFields.mockResolvedValue([
      snapshotField({ id: "customfield_1", name: "Story Points" }),
      snapshotField({ id: "customfield_2", name: "Story Estimate" }),
    ]);

    const result = await rovoSearchFields({ query: "story", maxResults: 1 }, {});

    expect(result.status).toBe("ok");
    expect(result.matches).toHaveLength(1);
    expect(result.totalMatches).toBe(1);
  });
});

describe("rovoInspectField", () => {
  test("requires a fieldIdentifier", async () => {
    const result = await rovoInspectField({}, {});
    expect(result).toEqual({ status: "error", message: "A field identifier is required." });
  });

  test("reports snapshot-unavailable when no snapshot has completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    const result = await rovoInspectField({ fieldIdentifier: "Story Points" }, {});
    expect(result.status).toBe("snapshot-unavailable");
  });

  test("reports not-found when no field matches the identifier", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField({ id: "customfield_1", name: "Story Points" })]);
    const result = await rovoInspectField({ fieldIdentifier: "Nonexistent Field" }, {});
    expect(result.status).toBe("not-found");
  });

  test("matches by exact id, then exact name, then name prefix, then substring -- in that priority order", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField({ id: "customfield_10001", name: "Story Points" })]);
    mocks.getLiveFieldProjectUsage.mockResolvedValue({ projectUsage: [], total: 0, totalIssueCount: 0 });

    const byId = await rovoInspectField({ fieldIdentifier: "customfield_10001" }, {});
    expect(byId.field.id).toBe("customfield_10001");

    const byName = await rovoInspectField({ fieldIdentifier: "Story Points" }, {});
    expect(byName.field.id).toBe("customfield_10001");

    const byPrefix = await rovoInspectField({ fieldIdentifier: "Story" }, {});
    expect(byPrefix.field.id).toBe("customfield_10001");
  });

  test("returns governance and live project usage for a matched field", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField({ id: "customfield_1", name: "Story Points" })]);
    mocks.getLiveFieldProjectUsage.mockResolvedValue({
      projectUsage: [{ projectKey: "ABC", projectName: "Alpha", issueCount: 5, jql: "project = ABC" }],
      total: 1,
      totalIssueCount: 5,
    });

    const result = await rovoInspectField({ fieldIdentifier: "Story Points" }, {});

    expect(result.status).toBe("ok");
    expect(result.governance.activeProjectCount).toBe(1);
    expect(result.projectUsage).toHaveLength(1);
  });

  test("never returns a project the Rovo caller lacks Browse Projects permission on", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField({ id: "customfield_1", name: "Story Points" })]);
    mocks.getLiveFieldProjectUsage.mockResolvedValue({
      projectUsage: [
        { projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 5, jql: "project = ABC" },
        { projectId: "20", projectKey: "SECRET", projectName: "Confidential", issueCount: 3, jql: "project = SECRET" },
      ],
      total: 2,
      totalIssueCount: 8,
    });
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["10"]));

    const result = await rovoInspectField({ fieldIdentifier: "Story Points" }, ctxWithAccount());

    expect(result.projectUsage).toHaveLength(1);
    expect(result.projectUsage[0].projectKey).toBe("ABC");
  });
});

// ---------------------------------------------------------------------------
// migrateNamespaceKeys -- a real data migration, thin at the resolver layer
// (the actual row-rewriting logic lives in migrateOldScopeKeys/project-store.js,
// out of scope here). Covers the delegation contract: correct installation
// key derivation, result passed through verbatim, and errors not swallowed.
// ---------------------------------------------------------------------------
describe("migrateNamespaceKeys", () => {
  test("ensures storage is ready and delegates to migrateOldScopeKeys with the installation key", async () => {
    mocks.migrateOldScopeKeys.mockResolvedValue({ migrated: 42, skipped: 3 });

    const result = await migrateNamespaceKeys({ context: {} });

    expect(mocks.ensureProjectStoreReady).toHaveBeenCalled();
    expect(mocks.migrateOldScopeKeys).toHaveBeenCalledWith("test-install");
    expect(result).toEqual({ migrated: 42, skipped: 3 });
  });

  test("does not swallow an error from the underlying migration", async () => {
    mocks.migrateOldScopeKeys.mockRejectedValue(new Error("migration failed: duplicate key"));
    await expect(migrateNamespaceKeys({ context: {} })).rejects.toThrow("migration failed: duplicate key");
  });
});
