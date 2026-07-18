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

import { SHARED_RESOLVER_FUNCTIONS, ADMIN_ONLY_FUNCTIONS } from "./resolvers.js";

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
});

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
