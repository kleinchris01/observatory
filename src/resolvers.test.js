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
  getAllJiraProjects: vi.fn(),
  probeEndpoint: vi.fn(),
  probeStargateEndpoint: vi.fn(),
  getCloudId: vi.fn(),
  kvsGet: vi.fn(),
  kvsSet: vi.fn(),
  apiAsAppRequestJira: vi.fn(),

  // project-store.js -- every named export resolvers.js imports, since
  // vi.mock replaces the whole module. Stubbed vi.fn() defaults are safe for
  // groups that don't exercise them; later groups configure return values.
  ensureProjectStoreReady: vi.fn().mockResolvedValue(undefined),
  readSnapshotMeta: vi.fn(),
  writeSnapshotMeta: vi.fn().mockResolvedValue(undefined),
  clearAllSnapshotData: vi.fn().mockResolvedValue({ deleted: {}, totalRowsDeleted: 0 }),
  recordAuditEvent: vi.fn().mockResolvedValue({ recorded: true }),
  listAuditEvents: vi.fn().mockResolvedValue([]),
  loadSnapshotFields: vi.fn(),
  loadSnapshotField: vi.fn(),
  loadSnapshotProjectUsage: vi.fn(),
  loadAllSnapshotProjectUsage: vi.fn(),
  loadAnySnapshotProjectUsage: vi.fn(),
  listSnapshotProjects: vi.fn(),
  loadIssueScanProjectTotals: vi.fn(),
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
  tryClaimIssueScanFinalization: vi.fn().mockResolvedValue(false),
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
  readWorkflowSnapshotMeta: vi.fn(),
  readAutomationAnalysis: vi.fn(),
  writeAutomationAnalysis: vi.fn(),
  readAutomationPart: vi.fn(),
  writeAutomationPart: vi.fn(),
  loadWorkflowSchemes: vi.fn(),
  loadWorkflowSchemeProjects: vi.fn(),
  loadWorkflowSchemeForProject: vi.fn().mockResolvedValue(null),
  loadStatusesCatalog: vi.fn(),
  loadWorkflowSchemeStatuses: vi.fn(),
  loadStatusIssueCounts: vi.fn(),
  loadStatusHistoryCounts: vi.fn(),

  // workflow-engine.js
  buildWorkflowSnapshot: vi.fn(),
  queueWorkflowSnapshotBuild: vi.fn(),
  queueStatusHistoryBuild: vi.fn(),
  // Pure and covered directly in workflow-engine.test.js; mocked here so these tests can
  // state "the row is stale" as a premise rather than manufacturing timestamps.
  isWorkflowBuildStale: vi.fn(() => false),

  // jira-api.js
  incrMetric: vi.fn(),
  makeJobToken: vi.fn(() => "job-token-1"),
  getInstallationKey: vi.fn(() => "test-install"),
  callerHasJiraAdmin: vi.fn().mockResolvedValue(true),
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
  completeIssueScanFinalization: vi.fn().mockResolvedValue(undefined),

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
  completeIssueScanFinalization: mocks.completeIssueScanFinalization,
}));

vi.mock("./lib/store/automation.js", () => ({
  readAutomationAnalysis: mocks.readAutomationAnalysis,
  writeAutomationAnalysis: mocks.writeAutomationAnalysis,
  readAutomationPart: mocks.readAutomationPart,
  writeAutomationPart: mocks.writeAutomationPart,
  AUTOMATION_PARTS: { analysis: "a:", fields: "f:", statuses: "s:", directory: "d:", findings: "fi:" },
  MAX_PREVIEW_FINDINGS: 20,
  MAX_STORED_CASCADES: 150,
}));

vi.mock("./lib/project-store.js", () => ({
  ensureProjectStoreReady: mocks.ensureProjectStoreReady,
  readSnapshotMeta: mocks.readSnapshotMeta,
  writeSnapshotMeta: mocks.writeSnapshotMeta,
  clearAllSnapshotData: mocks.clearAllSnapshotData,
  recordAuditEvent: mocks.recordAuditEvent,
  listAuditEvents: mocks.listAuditEvents,
  loadSnapshotFields: mocks.loadSnapshotFields,
  loadSnapshotField: mocks.loadSnapshotField,
  loadSnapshotProjectUsage: mocks.loadSnapshotProjectUsage,
  loadAllSnapshotProjectUsage: mocks.loadAllSnapshotProjectUsage,
  loadAnySnapshotProjectUsage: mocks.loadAnySnapshotProjectUsage,
  listSnapshotProjects: mocks.listSnapshotProjects,
  loadIssueScanProjectTotals: mocks.loadIssueScanProjectTotals,
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
  tryClaimIssueScanFinalization: mocks.tryClaimIssueScanFinalization,
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
  readWorkflowSnapshotMeta: mocks.readWorkflowSnapshotMeta,
  loadWorkflowSchemes: mocks.loadWorkflowSchemes,
  loadWorkflowSchemeProjects: mocks.loadWorkflowSchemeProjects,
  loadWorkflowSchemeForProject: mocks.loadWorkflowSchemeForProject,
  loadStatusesCatalog: mocks.loadStatusesCatalog,
  loadWorkflowSchemeStatuses: mocks.loadWorkflowSchemeStatuses,
  loadStatusIssueCounts: mocks.loadStatusIssueCounts,
  loadStatusHistoryCounts: mocks.loadStatusHistoryCounts,
}));

vi.mock("./lib/workflow-engine.js", () => ({
  buildWorkflowSnapshot: mocks.buildWorkflowSnapshot,
  queueWorkflowSnapshotBuild: mocks.queueWorkflowSnapshotBuild,
  queueStatusHistoryBuild: mocks.queueStatusHistoryBuild,
  isWorkflowBuildStale: mocks.isWorkflowBuildStale,
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
  callerHasJiraAdmin: mocks.callerHasJiraAdmin,
  mapWithConcurrency: mocks.mapWithConcurrency,
  jiraRequest: mocks.jiraRequest,
  getDistinctIssueCountForFields: mocks.getDistinctIssueCountForFields,
  getLiveFieldProjectUsage: mocks.getLiveFieldProjectUsage,
  loadFieldContexts: mocks.loadFieldContexts,
  collectRecentFieldProjectCandidates: mocks.collectRecentFieldProjectCandidates,
  loadFieldOptionsFromJira: mocks.loadFieldOptionsFromJira,
  getBrowsableProjectIds: mocks.getBrowsableProjectIds,
  getAllJiraProjects: mocks.getAllJiraProjects,
  probeEndpoint: mocks.probeEndpoint,
  probeStargateEndpoint: mocks.probeStargateEndpoint,
  getCloudId: mocks.getCloudId,
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
  __RAW_ADMIN_ONLY_FUNCTIONS,
  runDeltaIssueScanJob,
  rovoSearchFields,
  rovoInspectField,
  rovoSearchAutomationRules,
  rovoInspectAutomationRule,
  rovoAutomationUsage,
  migrateNamespaceKeys,
  CLEAR_SNAPSHOT_CONFIRMATION,
  __RAW_ADMIN_ONLY_FUNCTIONS,
  __resetAdminCheckCache,
  AdminPermissionError,
  isScanStuck,
} from "./resolvers.js";

const {
  saveReportDefinition,
  startProjectUsageReportJob,
  getAutomationInsights,
  saveAutomationAnalysis,
  getAutomationIndex,
  saveAutomationIndex,
  getAutomationFieldUsage,
  getAutomationFieldCounts,
} = __RAW_ADMIN_ONLY_FUNCTIONS;

const {
  checkMacroAccess,
  getFieldInventory,
  getWorkflowInventory,
  getWorkflowInsights,
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
  clearSnapshot,
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
} = { ...SHARED_RESOLVER_FUNCTIONS, ...__RAW_ADMIN_ONLY_FUNCTIONS };

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
  // Default: no Universal Scan has measured distinct issues. Every existing case then
  // exercises the unmeasured path, which is the one that must never present fills as issues.
  mocks.loadIssueScanProjectTotals.mockResolvedValue([]);
  mocks.searchFieldOptionsCache.mockResolvedValue([]);
  mocks.loadSnapshotFieldIssueSums.mockResolvedValue(new Map());
  mocks.sumSnapshotFieldIssueCount.mockResolvedValue(0);
  mocks.getInstallationKey.mockReturnValue("test-install");
  // Default: no automation analysis. getAdminOverview treats it as an optional input, so
  // every existing case exercises the path where the automation dimensions report
  // unavailable rather than being scored on absent data.
  mocks.readAutomationAnalysis.mockResolvedValue(null);
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
  mocks.readWorkflowSnapshotMeta.mockResolvedValue(null);
  mocks.loadWorkflowSchemes.mockResolvedValue([]);
  mocks.loadWorkflowSchemeProjects.mockResolvedValue([]);
  mocks.loadStatusesCatalog.mockResolvedValue([]);
  mocks.loadWorkflowSchemeStatuses.mockResolvedValue([]);
  mocks.loadStatusIssueCounts.mockResolvedValue(new Map());
  mocks.loadStatusHistoryCounts.mockResolvedValue({ counts: new Map(), measuredAt: null });
  mocks.buildWorkflowSnapshot.mockResolvedValue({ version: "v1", schemeCount: 0, statusCount: 0, projectCount: 0 });
  mocks.queueWorkflowSnapshotBuild.mockResolvedValue(undefined);
  mocks.queueStatusHistoryBuild.mockResolvedValue(undefined);
  mocks.isWorkflowBuildStale.mockReturnValue(false);
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

  // Regression test: requeueStaleSnapshotBuild transitions state "building" -> "queued"
  // in this same request. A prior bug re-read that fresh "queued" state as if it were a
  // stuck leftover from an earlier request and immediately reset it back to "idle",
  // silently undoing the requeue every time (this is what broke the admin "Force resume
  // (stalled)" button — see the plan file for the full trace).
  test("force-refresh on a stuck 'building' state does NOT undo the requeue it just performed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, state: "building" });
    mocks.requeueStaleSnapshotBuild.mockResolvedValue({ version: 1, state: "queued", jobToken: "requeue-token" });
    mocks.kvsGet.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([]);

    const result = await getFieldInventory({ payload: { forceRefresh: true }, context: {} });

    // Must NOT reset the fresh "queued" state back to "idle"
    expect(mocks.writeSnapshotMeta).not.toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({ state: "idle" })
    );
    // Already active (queued) after the requeue, so no separate/duplicate queue push
    expect(mocks.queueSnapshotBuild).not.toHaveBeenCalled();
    expect(result.snapshotStatus.state).toBe("queued");
  });

  // The reset-to-idle path is still correct for a job that was ALREADY stuck in
  // "queued" before this request started (not one this request just produced) --
  // and, since shouldQueue is now computed after the reset, it should also push a
  // fresh build in the same call rather than requiring a second click.
  test("force-refresh resets an already-stuck 'queued' state to idle and re-queues a fresh build in the same call", async () => {
    mocks.readSnapshotMeta
      .mockResolvedValueOnce({ version: 1, state: "queued", jobToken: "stale-token" }) // initial read
      .mockResolvedValueOnce({ version: 1, state: "idle" }) // after reset-to-idle write
      .mockResolvedValueOnce({ version: 1, state: "queued", jobToken: "job-token-1" }); // post-claim verify
    mocks.kvsGet.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([]);

    const result = await getFieldInventory({ payload: { forceRefresh: true }, context: {} });

    expect(mocks.writeSnapshotMeta).toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({ state: "idle", lastError: "Queue job did not start; reset by manual refresh." })
    );
    expect(mocks.queueSnapshotBuild).toHaveBeenCalledTimes(1);
    expect(result.snapshotStatus.state).toBe("queued");
  });

  test("propagates errors and increments the failure metric", async () => {
    mocks.readSnapshotMeta.mockRejectedValue(new Error("SQL connection lost"));
    await expect(getFieldInventory({ payload: {}, context: {} })).rejects.toThrow("SQL connection lost");
    expect(mocks.incrMetric).toHaveBeenCalledWith("resolver-failed");
  });
});

// ---------------------------------------------------------------------------
// getWorkflowInventory
// ---------------------------------------------------------------------------
describe("getWorkflowInventory", () => {
  function workflowScheme(overrides = {}) {
    return {
      id: "scheme-1", name: "Default Workflow Scheme", description: "",
      defaultWorkflow: "Software Simplified Workflow", issueTypeMapping: null,
      projectCount: 2, findings: null,
      ...overrides,
    };
  }

  test("returns an empty, non-error shape when no workflow snapshot has ever completed", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue(null);
    const result = await getWorkflowInventory({ payload: {}, context: ctxWithAccount() });
    expect(result.schemes).toEqual([]);
    expect(result.statuses).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.snapshotStatus.state).toBe("idle");
    expect(mocks.loadWorkflowSchemes).not.toHaveBeenCalled();
  });

  test("returns paginated schemes and the status catalog from the latest snapshot version", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready", totalSchemes: 2 });
    mocks.loadWorkflowSchemes.mockResolvedValue([
      workflowScheme({ id: "scheme-1", name: "Alpha Scheme" }),
      workflowScheme({ id: "scheme-2", name: "Beta Scheme" }),
    ]);
    mocks.loadWorkflowSchemeProjects.mockResolvedValue([
      { projectId: "10", projectKey: "ALPHA", projectName: "Alpha" },
      { projectId: "11", projectKey: "BRAVO", projectName: "Bravo" },
    ]);
    mocks.loadStatusesCatalog.mockResolvedValue([{ id: "1", name: "To Do", statusCategory: "To Do" }]);

    const result = await getWorkflowInventory({ payload: { pageSize: 1, page: 1 }, context: ctxWithAccount() });

    expect(result.totalCount).toBe(2);
    expect(result.schemes).toHaveLength(1);
    expect(result.totalPages).toBe(2);
    // Statuses now carry both usage measures. Null rather than 0 for each: they are
    // measured by separate jobs and neither had run here, so "unknown" is the truth.
    expect(result.statuses).toEqual([{
      id: "1", name: "To Do", statusCategory: "To Do",
      issueCount: null, everCount: null, departedCount: null,
    }]);
  });

  test("filters search by scheme name and description", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([
      workflowScheme({ id: "scheme-1", name: "Bug Triage Scheme" }),
      workflowScheme({ id: "scheme-2", name: "Default Scheme", description: "used for bugs too" }),
      workflowScheme({ id: "scheme-3", name: "Something Else" }),
    ]);
    mocks.loadWorkflowSchemeProjects.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([]);

    const result = await getWorkflowInventory({ payload: { search: "bug" }, context: ctxWithAccount() });

    expect(result.schemes.map((s) => s.id).sort()).toEqual(["scheme-1", "scheme-2"]);
  });

  // The build is queued to the consumer (timeoutSeconds: 900) rather than run inline: it
  // walks every project's workflow scheme, which does not fit in a resolver's 25s budget.
  test("force-refresh queues the build instead of running it in the resolver", async () => {
    mocks.readWorkflowSnapshotMeta
      .mockResolvedValueOnce({ version: null, state: "idle" }) // initial read
      .mockResolvedValueOnce({ version: null, state: "building" }); // post-queue read
    mocks.loadWorkflowSchemes.mockResolvedValue([workflowScheme()]);
    mocks.loadWorkflowSchemeProjects.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([]);

    const result = await getWorkflowInventory({ payload: { forceRefresh: true }, context: ctxWithAccount() });

    expect(mocks.queueWorkflowSnapshotBuild).toHaveBeenCalledWith("test-install");
    expect(mocks.buildWorkflowSnapshot).not.toHaveBeenCalled();
    // Reports the queued build so the UI can poll rather than showing "never built".
    expect(result.snapshotStatus.state).toBe("building");
  });

  test("does not trigger a second build while one is already in progress", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: null, state: "building" });
    mocks.isWorkflowBuildStale.mockReturnValue(false);

    await getWorkflowInventory({ payload: { forceRefresh: true }, context: ctxWithAccount() });

    expect(mocks.queueWorkflowSnapshotBuild).not.toHaveBeenCalled();
  });

  // The wedge this fixes: an invocation killed mid-build leaves state "building" with no
  // catch ever running, and every later refresh was suppressed as "already building" --
  // the button silently did nothing, forever, with no error to explain it.
  test("re-queues a build when a stale 'building' row is blocking it", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: null, state: "building" });
    mocks.isWorkflowBuildStale.mockReturnValue(true);

    await getWorkflowInventory({ payload: { forceRefresh: true }, context: ctxWithAccount() });

    expect(mocks.queueWorkflowSnapshotBuild).toHaveBeenCalledWith("test-install");
  });

  // Enriching every scheme to return one page is work proportional to the site, not the
  // page: at 142 schemes it was 284 round trips per read and the resolver hit its 25s
  // limit, hanging the tab on "Loading...". Cost must track pageSize.
  test("enriches only the requested page, not every scheme on the site", async () => {
    const manySchemes = Array.from({ length: 142 }, (_, i) =>
      workflowScheme({ id: `scheme-${i}`, name: `Scheme ${i}` })
    );
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue(manySchemes);
    mocks.loadWorkflowSchemeProjects.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([]);

    const result = await getWorkflowInventory({
      payload: { page: 1, pageSize: 10 },
      context: ctxWithAccount(),
    });

    expect(result.schemes).toHaveLength(10);
    expect(result.totalCount).toBe(142);
    expect(mocks.loadWorkflowSchemeProjects).toHaveBeenCalledTimes(10);
    expect(mocks.getBrowsableProjectIds).toHaveBeenCalledTimes(10);
  });

  test("still reports the full total when a search matches more than one page", async () => {
    const manySchemes = Array.from({ length: 30 }, (_, i) =>
      workflowScheme({ id: `scheme-${i}`, name: `Payments ${i}` })
    );
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([
      ...manySchemes,
      workflowScheme({ id: "other", name: "Unrelated" }),
    ]);
    mocks.loadWorkflowSchemeProjects.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([]);

    const result = await getWorkflowInventory({
      payload: { search: "payments", page: 1, pageSize: 10 },
      context: ctxWithAccount(),
    });

    // Search must be applied across the whole set even though only a page is enriched.
    expect(result.totalCount).toBe(30);
    expect(result.schemes).toHaveLength(10);
    expect(mocks.loadWorkflowSchemeProjects).toHaveBeenCalledTimes(10);
  });


  // "Currently in" and "ever been in" come from different jobs (the universe scan and JQL
  // WAS queries) and refresh independently, so each is reported with its own availability
  // flag. Reporting an unmeasured status as 0 is what would make it look safe to delete.
  test("reports both usage measures on each status when both have been measured", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([{ id: "1", name: "Parking Lot", statusCategory: "To Do" }]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map([["1", 792]]));
    mocks.loadStatusHistoryCounts.mockResolvedValue({ counts: new Map([["1", 4000]]), measuredAt: "2026-08-03T12:00:00Z" });

    const result = await getWorkflowInventory({ payload: {}, context: ctxWithAccount() });

    expect(result.statuses[0]).toMatchObject({ issueCount: 792, everCount: 4000, departedCount: 3208 });
    expect(result.statusCounts).toMatchObject({ hasCurrentCounts: true, hasHistoryCounts: true });
  });

  test("leaves the historical measure unknown when only the scan has run", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([{ id: "1", name: "Backlog", statusCategory: "To Do" }]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map([["1", 9423]]));

    const result = await getWorkflowInventory({ payload: {}, context: ctxWithAccount() });

    expect(result.statuses[0]).toMatchObject({ issueCount: 9423, everCount: null, departedCount: null });
    expect(result.statusCounts.hasHistoryCounts).toBe(false);
  });

  // The two measures are sampled at different times, so a status can gain issues between
  // them. A negative "departed" would be nonsense on screen.
  test("floors departed at zero when the current count exceeds the historical one", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([{ id: "1", name: "Active", statusCategory: "In Progress" }]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map([["1", 50]]));
    mocks.loadStatusHistoryCounts.mockResolvedValue({ counts: new Map([["1", 40]]), measuredAt: "x" });

    const result = await getWorkflowInventory({ payload: {}, context: ctxWithAccount() });

    expect(result.statuses[0].departedCount).toBe(0);
  });

  test("queues the history measurement only when asked and a snapshot exists", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([]);

    await getWorkflowInventory({ payload: { measureHistory: true }, context: ctxWithAccount() });
    expect(mocks.queueStatusHistoryBuild).toHaveBeenCalledWith("test-install");

    mocks.queueStatusHistoryBuild.mockClear();
    await getWorkflowInventory({ payload: {}, context: ctxWithAccount() });
    expect(mocks.queueStatusHistoryBuild).not.toHaveBeenCalled();
  });

  test("does not queue a history measurement with no snapshot to measure against", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: null, state: "idle" });

    await getWorkflowInventory({ payload: { measureHistory: true }, context: ctxWithAccount() });

    expect(mocks.queueStatusHistoryBuild).not.toHaveBeenCalled();
  });

  test("degrades to unknown when the count lookups fail", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([{ id: "1", name: "Done", statusCategory: "Done" }]);
    mocks.loadStatusIssueCounts.mockRejectedValue(new Error("sql down"));
    mocks.loadStatusHistoryCounts.mockRejectedValue(new Error("sql down"));

    const result = await getWorkflowInventory({ payload: {}, context: ctxWithAccount() });

    expect(result.statuses[0]).toMatchObject({ issueCount: null, everCount: null });
  });

  test("never surfaces a scheme's project count from projects the viewer can't browse", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([workflowScheme({ id: "scheme-1", projectCount: 2 })]);
    mocks.loadWorkflowSchemeProjects.mockResolvedValue([
      { projectId: "10", projectKey: "VISIBLE", projectName: "Visible Project" },
      { projectId: "11", projectKey: "HIDDEN", projectName: "Hidden Project" },
    ]);
    mocks.loadStatusesCatalog.mockResolvedValue([]);
    mocks.getBrowsableProjectIds.mockImplementation(async () => new Set(["10"])); // only project 10 is browsable

    const result = await getWorkflowInventory({ payload: {}, context: ctxWithAccount("less-privileged-user") });

    expect(result.schemes[0].projectCount).toBe(1);
  });

  test("validates page and pageSize bounds", async () => {
    await expect(getWorkflowInventory({ payload: { page: 0 }, context: ctxWithAccount() })).rejects.toThrow(/page/);
    await expect(getWorkflowInventory({ payload: { pageSize: 500 }, context: ctxWithAccount() })).rejects.toThrow(/pageSize/);
  });

  test("propagates errors and increments the failure metric", async () => {
    mocks.readWorkflowSnapshotMeta.mockRejectedValue(new Error("SQL connection lost"));
    await expect(getWorkflowInventory({ payload: {}, context: ctxWithAccount() })).rejects.toThrow("SQL connection lost");
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

    // objectContaining, because the shape now also carries uniqueIssueCount. This test is
    // about which projects survive the permission filter, not about their field set.
    expect(result.projects).toEqual([
      expect.objectContaining({ projectId: "10", projectKey: "ABC", projectName: "Alpha" }),
    ]);
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


  // The dashboard-building branch had never executed: every existing case either omitted
  // the snapshot version or asserted only on findingsSummary. These cover the project
  // shape analysis and the workflow roll-up that the Overview actually renders.
  test("builds project insights with distribution, not just leaders", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "1", projectKey: "A", projectName: "Alpha", fieldCount: 4, totalIssueCount: 900, latestIssueUpdatedAt: new Date().toISOString() },
      { projectId: "2", projectKey: "B", projectName: "Bravo", fieldCount: 6, totalIssueCount: 400, latestIssueUpdatedAt: new Date().toISOString() },
      { projectId: "3", projectKey: "C", projectName: "Charlie", fieldCount: 40, totalIssueCount: 2, latestIssueUpdatedAt: new Date().toISOString() },
      { projectId: "4", projectKey: "D", projectName: "Delta", fieldCount: 3, totalIssueCount: 0, latestIssueUpdatedAt: null },
    ]);

    const result = await getAdminOverview({ context: {} });
    const projects = result.dashboard.projects;

    expect(projects.totalProjects).toBe(4);
    expect(projects.totalFieldFills).toBe(1302);
    expect(projects.medianFieldCount).toBeGreaterThan(0);
    // Fields configured but nothing ever filed -- abandoned or never started.
    expect(projects.unusedProjects.map((p) => p.projectKey)).toContain("D");
    // Far above the norm while carrying almost no work.
    expect(projects.overConfigured.map((p) => p.projectKey)).toContain("C");
  });

  // ── Field fills are not issues ────────────────────────────────────────────
  //
  // snapshot_project_usage holds one row per field x project, so SUM(issue_count) counts
  // an issue once for every populated field on it. The Overview presented that sum as
  // "Issues covered", overstating a 317k-issue site as 19.7 million.

  test("reports field fills and distinct issues as separate figures", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "1", projectKey: "A", projectName: "Alpha", fieldCount: 90, totalIssueCount: 90000, latestIssueUpdatedAt: null },
      { projectId: "2", projectKey: "B", projectName: "Bravo", fieldCount: 40, totalIssueCount: 20000, latestIssueUpdatedAt: null },
    ]);
    mocks.loadIssueScanProjectTotals.mockResolvedValue([
      { projectId: "1", projectKey: "A", projectName: "Alpha", uniqueIssueCount: 1000 },
      { projectId: "2", projectKey: "B", projectName: "Bravo", uniqueIssueCount: 500 },
    ]);

    const projects = (await getAdminOverview({ context: {} })).dashboard.projects;

    expect(projects.hasUniqueCounts).toBe(true);
    expect(projects.totalUniqueIssues).toBe(1500);
    expect(projects.totalFieldFills).toBe(110000);
    // The old key is gone deliberately: "totalIssues" is the name that let a fills figure
    // be rendered as an issue count without anyone noticing.
    expect(projects.totalIssues).toBeUndefined();
  });

  test("marks issue counts unmeasured rather than substituting fills", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "1", projectKey: "A", projectName: "Alpha", fieldCount: 90, totalIssueCount: 90000, latestIssueUpdatedAt: null },
    ]);
    mocks.loadIssueScanProjectTotals.mockResolvedValue([]);

    const projects = (await getAdminOverview({ context: {} })).dashboard.projects;

    expect(projects.hasUniqueCounts).toBe(false);
    expect(projects.totalUniqueIssues).toBeNull();
    expect(projects.totalFieldFills).toBe(90000);
  });

  test("ranks the volume list by distinct issues once they are measured", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    // BIG has more fills but fewer issues -- it simply has more fields configured. Ranking
    // on fills puts the wrong project at the top of a list titled "highest issue volume".
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "1", projectKey: "BIG", projectName: "Big", fieldCount: 200, totalIssueCount: 200000, latestIssueUpdatedAt: null },
      { projectId: "2", projectKey: "BUSY", projectName: "Busy", fieldCount: 10, totalIssueCount: 50000, latestIssueUpdatedAt: null },
    ]);
    mocks.loadIssueScanProjectTotals.mockResolvedValue([
      { projectId: "1", projectKey: "BIG", projectName: "Big", uniqueIssueCount: 1000 },
      { projectId: "2", projectKey: "BUSY", projectName: "Busy", uniqueIssueCount: 5000 },
    ]);

    const projects = (await getAdminOverview({ context: {} })).dashboard.projects;

    expect(projects.topByIssueVolume.map((p) => p.projectKey)).toEqual(["BUSY", "BIG"]);
    expect(projects.topByIssueVolume[0].volume).toBe(5000);
  });

  test("treats a project the scan never reached as unmeasured, not as zero", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "1", projectKey: "SEEN", projectName: "Seen", fieldCount: 10, totalIssueCount: 5000, latestIssueUpdatedAt: null },
      { projectId: "2", projectKey: "MISSED", projectName: "Missed", fieldCount: 10, totalIssueCount: 4000, latestIssueUpdatedAt: null },
    ]);
    mocks.loadIssueScanProjectTotals.mockResolvedValue([
      { projectId: "1", projectKey: "SEEN", projectName: "Seen", uniqueIssueCount: 300 },
    ]);

    const projects = (await getAdminOverview({ context: {} })).dashboard.projects;

    const missed = projects.topByIssueVolume.find((p) => p.projectKey === "MISSED");
    expect(missed.uniqueIssueCount).toBeNull();
    // Excluded from the site total rather than contributing a fabricated zero.
    expect(projects.totalUniqueIssues).toBe(300);
  });

  test("survives the project-totals lookup failing", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "1", projectKey: "A", projectName: "Alpha", fieldCount: 5, totalIssueCount: 100, latestIssueUpdatedAt: null },
    ]);
    mocks.loadIssueScanProjectTotals.mockRejectedValue(new Error("SQL unavailable"));

    const projects = (await getAdminOverview({ context: {} })).dashboard.projects;

    // Degrades to unmeasured. A failed lookup must not silently promote fills to issues.
    expect(projects.hasUniqueCounts).toBe(false);
    expect(projects.totalFieldFills).toBe(100);
  });

  test("flags projects with no activity in over six months", async () => {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "1", projectKey: "STALE", projectName: "Stale", fieldCount: 5, totalIssueCount: 100, latestIssueUpdatedAt: old },
      { projectId: "2", projectKey: "FRESH", projectName: "Fresh", fieldCount: 5, totalIssueCount: 100, latestIssueUpdatedAt: new Date().toISOString() },
    ]);

    const result = await getAdminOverview({ context: {} });

    expect(result.dashboard.projects.staleProjects.map((p) => p.projectKey)).toEqual(["STALE"]);
  });

  test("includes a workflow roll-up when a workflow snapshot exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready", refreshedAt: "2026-08-03T00:00:00Z" });
    mocks.loadWorkflowSchemes.mockResolvedValue([
      { id: "s1", name: "Shared", projectCount: 4 },
      { id: "s2", name: "Bespoke", projectCount: 1 },
    ]);
    mocks.loadStatusesCatalog.mockResolvedValue([
      { statusId: "1", name: "Backlog", statusCategory: "To Do" },
      { statusId: "2", name: "Back Log", statusCategory: "To Do" },
    ]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([{ schemeId: "s1", statusId: "1" }]);

    const result = await getAdminOverview({ context: {} });

    expect(result.workflow.available).toBe(true);
    expect(result.workflow.schemeCount).toBe(2);
    // Only schemes governing more than one project give standardization any leverage.
    expect(result.workflow.sharedSchemes).toBe(1);
    expect(result.workflow.duplicateGroupCount).toBe(1);
  });

  test("reports the workflow roll-up as unavailable when no snapshot has been built", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readWorkflowSnapshotMeta.mockResolvedValue(null);

    const result = await getAdminOverview({ context: {} });

    expect(result.workflow).toEqual({ available: false, state: "idle" });
  });

  // Overview is the landing page: a workflow failure must degrade to a prompt, never an error.
  test("survives the workflow roll-up throwing", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readWorkflowSnapshotMeta.mockRejectedValue(new Error("sql down"));

    const result = await getAdminOverview({ context: {} });

    expect(result.workflow).toEqual({ available: false, state: "error" });
  });


  // The worst silent handler in the codebase was a bare `catch {}` around this build:
  // an empty dashboard and a site with no data render identically, so the difference
  // has to exist in the logs.
  test("logs and still returns an overview when the dashboard build throws", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockRejectedValue(new Error("sql down"));

    const result = await getAdminOverview({ context: {} });

    // Job counts and config still render; only the dashboard degrades.
    expect(result.jobCounts).toBeDefined();
    expect(result.dashboard).toBeDefined();
  });

  test("degrades the legacy row count without failing the overview", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockRejectedValue(new Error("sql down"));

    const result = await getAdminOverview({ context: {} });

    expect(result.legacySummaryCount).toBe(0);
  });

  test("does not fail the whole overview if the findings computation throws", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockRejectedValue(new Error("SQL error"));

    const result = await getAdminOverview({ context: {} });

    expect(result.findingsSummary).toEqual({ adminAttention: 0, risky: 0, cleanup: 0, standardize: 0 });
    expect(result.dashboard.fieldUsage.totalFields).toBe(0);
    expect(result.dashboard.projects.totalProjects).toBe(0);
  });

  test("computes dashboard field-usage and project insights from the latest snapshot", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockResolvedValue([
      snapshotField({ id: "customfield_1", name: "Story Points", type: "number" }),
      snapshotField({ id: "customfield_2", name: "Story Points", type: "number" }), // duplicate name -> one cluster
      snapshotField({
        id: "customfield_3",
        name: "Epic Link",
        type: "text",
        customType: "com.atlassian.jira.plugin.system.customfieldtypes:epic-link",
      }),
    ]);
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "1", projectKey: "AAA", projectName: "Alpha", fieldCount: 5, totalIssueCount: 100 },
      { projectId: "2", projectKey: "BBB", projectName: "Beta", fieldCount: 10, totalIssueCount: 50 },
    ]);

    const result = await getAdminOverview({ context: {} });

    expect(result.dashboard.fieldUsage.totalFields).toBe(3);
    expect(result.dashboard.fieldUsage.duplicateClusters).toBe(1);
    expect(result.dashboard.fieldUsage.origin.builtin).toBe(1);
    expect(result.dashboard.fieldUsage.origin.custom).toBe(2);
    expect(result.dashboard.projects.totalProjects).toBe(2);
    expect(result.dashboard.projects.topByIssueVolume[0]).toEqual(
      expect.objectContaining({ projectKey: "AAA", totalIssueCount: 100 })
    );
    expect(result.dashboard.projects.topByFieldCount[0]).toEqual(
      expect.objectContaining({ projectKey: "BBB", fieldCount: 10 })
    );
  });

  test("returns the empty dashboard shape when no snapshot version exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);

    const result = await getAdminOverview({ context: {} });

    expect(result.dashboard.fieldUsage.totalFields).toBe(0);
    expect(result.dashboard.projects.totalProjects).toBe(0);
    expect(mocks.listSnapshotProjects).not.toHaveBeenCalled();
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

  // Regression test: a worker can finish (marking itself "done") right after a cancel
  // sets state to "cancelled", so its own finalization claim is rejected (it requires
  // state === "building"). Resume would previously just re-set state to "building" and
  // then skip every worker in the requeue loop because they're all already "done" --
  // leaving the scan stuck at 100%/state=building forever with no further attempt to
  // finalize. It must finalize directly in that case instead of silently no-op'ing.
  test("finalizes directly when every worker already reports done but the scan was never finalized", async () => {
    mocks.readIssueScanMeta
      .mockResolvedValueOnce({ state: "cancelled", jobToken: "old-token", progressLog: [] })
      .mockResolvedValue({ state: "ready", processedIssues: 322835 });
    mocks.writeIssueScanMeta.mockResolvedValue({ state: "building", processedPages: 5, totalPages: 5 });
    mocks.readIssueScanWorker.mockResolvedValue({ status: "done" });
    mocks.tryClaimIssueScanFinalization.mockResolvedValue(true);

    const result = await resumeIssueScan({ context: {} });

    expect(mocks.queueIssueScanWorker).not.toHaveBeenCalled();
    expect(mocks.tryClaimIssueScanFinalization).toHaveBeenCalledWith("test-install", "old-token");
    expect(mocks.completeIssueScanFinalization).toHaveBeenCalledWith("test-install", "resumeIssueScan");
    expect(result.resumed).toBe(true);
    expect(result.finalizedDirectly).toBe(true);
    expect(result.meta.state).toBe("ready");
  });

  test("does not finalize when the finalization claim loses a race to a concurrent finalizer", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "cancelled", jobToken: "old-token", progressLog: [] });
    mocks.writeIssueScanMeta.mockResolvedValue({ state: "building", processedPages: 5, totalPages: 5 });
    mocks.readIssueScanWorker.mockResolvedValue({ status: "done" });
    mocks.tryClaimIssueScanFinalization.mockResolvedValue(false);

    const result = await resumeIssueScan({ context: {} });

    expect(mocks.completeIssueScanFinalization).not.toHaveBeenCalled();
    expect(result.resumed).toBe(true);
    expect(result.finalizedDirectly).toBeUndefined();
  });

  test("does not attempt finalization when workers are done but pages are incomplete", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "cancelled", jobToken: "old-token", progressLog: [] });
    mocks.writeIssueScanMeta.mockResolvedValue({ state: "building", processedPages: 3, totalPages: 5 });
    mocks.readIssueScanWorker.mockResolvedValue({ status: "done" });

    const result = await resumeIssueScan({ context: {} });

    expect(mocks.tryClaimIssueScanFinalization).not.toHaveBeenCalled();
    expect(result.resumed).toBe(true);
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

// ---------------------------------------------------------------------------
// clearSnapshot
//
// The only irreversible operation in the app. These tests exist mainly to pin
// the things that make it *safe*: the confirmation is enforced server-side and
// not just in the UI, read-only mode blocks it, and the running build is
// cancelled before any DELETE runs -- an in-flight build would otherwise keep
// writing rows into the tables behind the delete.
// ---------------------------------------------------------------------------
describe("clearSnapshot", () => {
  beforeEach(() => {
    mocks.clearAllSnapshotData.mockResolvedValue({
      deleted: { snapshot_fields: 120, snapshot_project_usage: 4300 },
      totalRowsDeleted: 4420,
    });
  });

  test("refuses when the confirmation text is missing", async () => {
    const result = await clearSnapshot({ payload: {}, context: {} });

    expect(result.cleared).toBe(false);
    expect(result.error).toContain(CLEAR_SNAPSHOT_CONFIRMATION);
    expect(mocks.clearAllSnapshotData).not.toHaveBeenCalled();
  });

  test("refuses when the confirmation text does not match", async () => {
    const result = await clearSnapshot({ payload: { confirmation: "delete" }, context: {} });

    expect(result.cleared).toBe(false);
    expect(mocks.clearAllSnapshotData).not.toHaveBeenCalled();
  });

  test("accepts the confirmation with surrounding whitespace", async () => {
    const result = await clearSnapshot({
      payload: { confirmation: `  ${CLEAR_SNAPSHOT_CONFIRMATION}  ` },
      context: {},
    });

    expect(result.cleared).toBe(true);
    expect(mocks.clearAllSnapshotData).toHaveBeenCalledWith("test-install");
  });

  test("refuses while read-only mode is enabled", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true });

    const result = await clearSnapshot({
      payload: { confirmation: CLEAR_SNAPSHOT_CONFIRMATION },
      context: {},
    });

    expect(result.cleared).toBe(false);
    expect(result.error).toMatch(/read-only/i);
    expect(mocks.clearAllSnapshotData).not.toHaveBeenCalled();
  });

  test("cancels the in-flight build before deleting anything", async () => {
    const order = [];
    mocks.writeSnapshotMeta.mockImplementation(async () => { order.push("cancel"); });
    mocks.clearAllSnapshotData.mockImplementation(async () => {
      order.push("delete");
      return { deleted: {}, totalRowsDeleted: 0 };
    });

    await clearSnapshot({ payload: { confirmation: CLEAR_SNAPSHOT_CONFIRMATION }, context: {} });

    expect(order).toEqual(["cancel", "delete"]);
    expect(mocks.writeSnapshotMeta).toHaveBeenCalledWith("test-install", {
      state: "cancelled",
      buildingVersion: null,
      lastError: null,
    });
  });

  test("returns the per-table row counts so the UI can report what was destroyed", async () => {
    const result = await clearSnapshot({
      payload: { confirmation: CLEAR_SNAPSHOT_CONFIRMATION },
      context: {},
    });

    expect(result).toEqual({
      cleared: true,
      deleted: { snapshot_fields: 120, snapshot_project_usage: 4300 },
      totalRowsDeleted: 4420,
    });
  });

  test("is registered admin-only and never on the shared macro resolver", () => {
    expect(ADMIN_ONLY_FUNCTIONS.clearSnapshot).toBeDefined();
    expect(SHARED_RESOLVER_FUNCTIONS.clearSnapshot).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Admin authorization guard
//
// Before this existed, the ONLY thing standing between an arbitrary authenticated
// user and clearSnapshot / saveAdminConfig / migrateNamespaceKeys was that the
// jira:adminPage module decides who sees the admin *page*. An invoke() does not
// go through the page. These tests assert the boundary is now in the resolver,
// where it belongs, and that it is applied to the whole registry rather than
// remembered function by function.
// ---------------------------------------------------------------------------
describe("admin authorization guard", () => {
  const ADMIN_CTX = { context: { accountId: "acct-admin" }, payload: {} };

  beforeEach(() => {
    __resetAdminCheckCache();
    mocks.callerHasJiraAdmin.mockResolvedValue(true);
  });

  test("every admin-only function is wrapped, not just the ones someone remembered", () => {
    // The guard is applied to the registry, so raw and wrapped must have identical
    // key sets and no entry may be the raw function itself.
    expect(Object.keys(ADMIN_ONLY_FUNCTIONS).sort()).toEqual(Object.keys(__RAW_ADMIN_ONLY_FUNCTIONS).sort());
    for (const [name, fn] of Object.entries(ADMIN_ONLY_FUNCTIONS)) {
      expect(fn, `${name} is unwrapped`).not.toBe(__RAW_ADMIN_ONLY_FUNCTIONS[name]);
    }
  });

  test("rejects a caller without Jira ADMINISTER", async () => {
    mocks.callerHasJiraAdmin.mockResolvedValue(false);

    await expect(ADMIN_ONLY_FUNCTIONS.clearSnapshot(ADMIN_CTX)).rejects.toThrow(AdminPermissionError);
    expect(mocks.clearAllSnapshotData).not.toHaveBeenCalled();
  });

  test("rejects an anonymous caller without even asking Jira", async () => {
    await expect(ADMIN_ONLY_FUNCTIONS.clearSnapshot({ context: {}, payload: {} })).rejects.toThrow(AdminPermissionError);
    expect(mocks.callerHasJiraAdmin).not.toHaveBeenCalled();
  });

  test("allows a caller who holds Jira ADMINISTER", async () => {
    await expect(
      ADMIN_ONLY_FUNCTIONS.clearSnapshot({ context: { accountId: "acct-admin" }, payload: { confirmation: CLEAR_SNAPSHOT_CONFIRMATION } })
    ).resolves.toMatchObject({ cleared: true });
  });

  test("guards the config and overview resolvers that used to bypass the registry", async () => {
    mocks.callerHasJiraAdmin.mockResolvedValue(false);

    for (const name of ["getAdminConfig", "saveAdminConfig", "getAdminOverview", "migrateNamespaceKeys"]) {
      await expect(ADMIN_ONLY_FUNCTIONS[name](ADMIN_CTX), name).rejects.toThrow(AdminPermissionError);
    }
  });

  test("records a denial in the audit log", async () => {
    mocks.callerHasJiraAdmin.mockResolvedValue(false);

    await expect(ADMIN_ONLY_FUNCTIONS.startIssueScan(ADMIN_CTX)).rejects.toThrow();

    expect(mocks.recordAuditEvent).toHaveBeenCalledWith("test-install", expect.objectContaining({
      actorId: "acct-admin",
      action: "startIssueScan",
      outcome: "denied",
    }));
  });

  test("caches the permission answer instead of asking Jira on every call", async () => {
    await ADMIN_ONLY_FUNCTIONS.getIssueScanStatus(ADMIN_CTX);
    await ADMIN_ONLY_FUNCTIONS.getIssueScanStatus(ADMIN_CTX);
    await ADMIN_ONLY_FUNCTIONS.getIssueScanStatus(ADMIN_CTX);

    expect(mocks.callerHasJiraAdmin).toHaveBeenCalledTimes(1);
  });

  test("caches per account, so one admin does not authorise everyone", async () => {
    mocks.callerHasJiraAdmin.mockImplementation(async (id) => id === "acct-admin");

    await expect(ADMIN_ONLY_FUNCTIONS.getIssueScanStatus(ADMIN_CTX)).resolves.toBeDefined();
    await expect(
      ADMIN_ONLY_FUNCTIONS.getIssueScanStatus({ context: { accountId: "acct-other" }, payload: {} })
    ).rejects.toThrow(AdminPermissionError);
  });
});

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------
describe("audit trail", () => {
  const ADMIN_CTX = { context: { accountId: "acct-admin" }, payload: {} };

  beforeEach(() => {
    __resetAdminCheckCache();
    mocks.callerHasJiraAdmin.mockResolvedValue(true);
  });

  test("records a completed privileged action", async () => {
    await ADMIN_ONLY_FUNCTIONS.cancelSnapshot(ADMIN_CTX);

    expect(mocks.recordAuditEvent).toHaveBeenCalledWith("test-install", expect.objectContaining({
      actorId: "acct-admin",
      action: "cancelSnapshot",
      outcome: "allowed",
    }));
  });

  // Several resolvers signal refusal by returning { error } rather than throwing.
  // Recording those as plain successes would make the audit log say an action
  // happened when it did not.
  test("records a returned refusal as refused, not as a completed action", async () => {
    await ADMIN_ONLY_FUNCTIONS.clearSnapshot({ context: { accountId: "acct-admin" }, payload: { confirmation: "nope" } });

    expect(mocks.recordAuditEvent).toHaveBeenCalledWith("test-install", expect.objectContaining({
      action: "clearSnapshot",
      outcome: "allowed",
      detail: expect.stringContaining("Refused:"),
    }));
  });

  test("records a thrown failure and still propagates the error", async () => {
    mocks.clearAllSnapshotData.mockRejectedValueOnce(new Error("sql exploded"));

    await expect(
      ADMIN_ONLY_FUNCTIONS.clearSnapshot({ context: { accountId: "acct-admin" }, payload: { confirmation: CLEAR_SNAPSHOT_CONFIRMATION } })
    ).rejects.toThrow("sql exploded");

    expect(mocks.recordAuditEvent).toHaveBeenCalledWith("test-install", expect.objectContaining({
      action: "clearSnapshot",
      outcome: "failed",
      detail: expect.stringContaining("sql exploded"),
    }));
  });

  // Admin reads are polled every 15s for the length of a scan. Auditing them would
  // bury the handful of events anyone actually wants to find.
  test("does not audit high-frequency admin reads", async () => {
    await ADMIN_ONLY_FUNCTIONS.getIssueScanStatus(ADMIN_CTX);
    expect(mocks.recordAuditEvent).not.toHaveBeenCalled();
  });

  // A broken audit table must not become an outage of every admin action -- nor a
  // denial-of-service that anyone able to break that table can trigger.
  test("an audit write failure never blocks the action", async () => {
    mocks.recordAuditEvent.mockRejectedValueOnce(new Error("audit table gone"));

    await expect(ADMIN_ONLY_FUNCTIONS.cancelSnapshot(ADMIN_CTX)).resolves.toEqual({ cancelled: true });
  });

  test("an audit write failure never turns a denial into a server error", async () => {
    mocks.callerHasJiraAdmin.mockResolvedValue(false);
    mocks.recordAuditEvent.mockRejectedValueOnce(new Error("audit table gone"));

    await expect(ADMIN_ONLY_FUNCTIONS.cancelSnapshot(ADMIN_CTX)).rejects.toThrow(AdminPermissionError);
  });
});

// ---------------------------------------------------------------------------
// getAuditLog
// ---------------------------------------------------------------------------
describe("getAuditLog", () => {
  const ADMIN_CTX = { context: { accountId: "acct-admin" }, payload: {} };

  beforeEach(() => {
    __resetAdminCheckCache();
    mocks.callerHasJiraAdmin.mockResolvedValue(true);
    mocks.listAuditEvents.mockResolvedValue([
      { at: "2026-07-31T10:00:00Z", actorId: "acct-1", action: "clearSnapshot", outcome: "allowed", detail: null },
    ]);
  });

  test("returns events for the installation with a default limit", async () => {
    const result = await ADMIN_ONLY_FUNCTIONS.getAuditLog(ADMIN_CTX);

    expect(mocks.listAuditEvents).toHaveBeenCalledWith("test-install", 100);
    expect(result.events).toHaveLength(1);
    expect(result.limit).toBe(100);
  });

  test("honours a caller-supplied limit", async () => {
    await ADMIN_ONLY_FUNCTIONS.getAuditLog({ context: { accountId: "acct-admin" }, payload: { limit: 500 } });
    expect(mocks.listAuditEvents).toHaveBeenCalledWith("test-install", 500);
  });

  test("rejects a limit above the allowed ceiling", async () => {
    await expect(
      ADMIN_ONLY_FUNCTIONS.getAuditLog({ context: { accountId: "acct-admin" }, payload: { limit: 99999 } })
    ).rejects.toThrow(/limit/i);
  });

  // Reading the audit log is not itself an audited event -- that loop would bury the
  // events worth finding, and it exposes nothing an admin could not already query.
  test("reading the audit log is not itself audited", async () => {
    await ADMIN_ONLY_FUNCTIONS.getAuditLog(ADMIN_CTX);
    expect(mocks.recordAuditEvent).not.toHaveBeenCalled();
  });

  test("is admin-guarded and never on the shared macro resolver", async () => {
    expect(SHARED_RESOLVER_FUNCTIONS.getAuditLog).toBeUndefined();

    mocks.callerHasJiraAdmin.mockResolvedValue(false);
    await expect(ADMIN_ONLY_FUNCTIONS.getAuditLog(ADMIN_CTX)).rejects.toThrow(AdminPermissionError);
  });
});

// ---------------------------------------------------------------------------
// getProjectsView — workflow correlation
//
// Two projects on the same workflow scheme are meant to run the same process, so
// divergent field usage between them is a standardization signal. Surfacing it means
// the Projects tab has to carry both, without ever letting the workflow snapshot --
// which is versioned separately and may not exist -- break the field view.
// ---------------------------------------------------------------------------
describe("getProjectsView workflow correlation", () => {
  function baseProjects() {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha" },
      { projectId: "20", projectKey: "XYZ", projectName: "Zulu" },
    ]);
    mocks.readIssueScanMeta.mockResolvedValue(null);
    mocks.loadSnapshotProjectFields.mockResolvedValue({ rows: [], total: 0 });
  }

  beforeEach(() => {
    baseProjects();
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "wf-1", refreshedAt: "2026-07-31T10:00:00Z" });
    mocks.loadWorkflowSchemeForProject.mockResolvedValue({
      schemeId: "s1", name: "ADVEV Standard", description: "Engineering default",
    });
    mocks.loadWorkflowSchemeProjects.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha" },
      { projectId: "20", projectKey: "XYZ", projectName: "Zulu" },
      { projectId: "30", projectKey: "QRS", projectName: "Quebec" },
    ]);
  });

  test("returns the scheme governing the selected project", async () => {
    const result = await getProjectsView({ payload: {}, context: {} });

    expect(result.workflowScheme.name).toBe("ADVEV Standard");
    expect(result.workflowScheme.schemeId).toBe("s1");
  });

  // "Shared with N" must count only projects the viewer can browse, or it discloses
  // that projects they cannot see exist.
  test("counts siblings from the viewer's browsable projects only", async () => {
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["10", "20"]));

    const result = await getProjectsView({ payload: {}, context: { accountId: "acct-1" } });

    expect(result.workflowScheme.sharedWithCount).toBe(1);
    expect(result.workflowScheme.siblingProjects.map((p) => p.projectKey)).toEqual(["XYZ"]);
  });

  test("excludes the selected project from its own sibling list", async () => {
    const result = await getProjectsView({ payload: { projectId: "10" }, context: {} });

    expect(result.workflowScheme.siblingProjects.some((p) => p.projectId === "10")).toBe(false);
  });

  test("reports zero when the scheme governs only this project", async () => {
    mocks.loadWorkflowSchemeProjects.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha" },
    ]);

    const result = await getProjectsView({ payload: {}, context: {} });

    expect(result.workflowScheme.sharedWithCount).toBe(0);
    expect(result.workflowScheme.siblingProjects).toEqual([]);
  });

  test("returns null when no workflow snapshot has been built", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue(null);

    const result = await getProjectsView({ payload: {}, context: {} });

    expect(result.workflowScheme).toBeNull();
    expect(mocks.loadWorkflowSchemeForProject).not.toHaveBeenCalled();
  });

  test("returns null when the project belongs to no scheme", async () => {
    mocks.loadWorkflowSchemeForProject.mockResolvedValue(null);

    const result = await getProjectsView({ payload: {}, context: {} });
    expect(result.workflowScheme).toBeNull();
  });

  // The field view is the reason anyone opened this tab.
  test("a workflow lookup failure never breaks the field view", async () => {
    mocks.loadWorkflowSchemeForProject.mockRejectedValue(new Error("workflow tables missing"));

    const result = await getProjectsView({ payload: {}, context: {} });

    expect(result.workflowScheme).toBeNull();
    expect(result.selectedProject.projectId).toBe("10");
    expect(result.projects).toHaveLength(2);
  });
});

describe("getAutomationInsights", () => {
  const doc = {
    schemaVersion: 1,
    refreshedAt: 1754400000000,
    source: "export-file",
    estate: { ruleCount: 1477, enabledCount: 874, disabledCount: 603 },
    findingsPreview: [{ id: 1, n: "Send to approval", s: "high", r: [{ c: "embedded-credential", s: "high" }] }],
    findingsTotal: 675,
    cascades: [{ sourceId: 1, targetId: 2, field: "Actual SEOBD", selfTriggering: false }],
    cascadesTotal: 1457,
    selfTriggeringTotal: 123,
  };

  test("reports unavailable rather than empty when the analysis has never been built", async () => {
    mocks.readAutomationAnalysis.mockResolvedValue(null);

    const result = await getAutomationInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.available).toBe(false);
    expect(result.reason).toBe("no-analysis");
  });

  test("returns the stored estate and findings", async () => {
    mocks.readAutomationAnalysis.mockResolvedValue(doc);

    const result = await getAutomationInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.available).toBe(true);
    expect(result.estate).toMatchObject({ ruleCount: 1477, enabledCount: 874 });
    expect(result.findingsPreview).toHaveLength(1);
    expect(result.refreshedAt).toBe(1754400000000);
  });

  // The stored lists are capped. Reporting only what survived truncation would present a
  // partial list as the complete set of problems on the site.
  test("reports the true totals alongside the truncated lists", async () => {
    mocks.readAutomationAnalysis.mockResolvedValue(doc);

    const result = await getAutomationInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.findingsTotal).toBe(675);
    expect(result.cascadesTotal).toBe(1457);
    expect(result.selfTriggeringTotal).toBe(123);
  });

  test("falls back to list lengths when a document predates the total fields", async () => {
    mocks.readAutomationAnalysis.mockResolvedValue({ ...doc, findingsTotal: undefined, cascadesTotal: undefined });

    const result = await getAutomationInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.findingsTotal).toBe(1);
    expect(result.cascadesTotal).toBe(1);
  });

  // A document written by an older build can be missing any of these. Each field falls back
  // to an empty value rather than reaching the client as undefined, where the tab would
  // render "undefined rules" or throw on a map of nothing.
  test("fills every absent field rather than passing undefined to the tab", async () => {
    mocks.readAutomationAnalysis.mockResolvedValue({ schemaVersion: 1 });

    const result = await getAutomationInsights({ payload: {}, context: ctxWithAccount() });

    expect(result).toMatchObject({
      available: true,
      refreshedAt: null,
      source: "unknown",
      estate: null,
      findingsPreview: [],
      findingsTotal: 0,
      cascades: [],
      cascadesTotal: 0,
      selfTriggeringTotal: 0,
    });
  });

  // The preview exists for the overview only. Sending 675 rows with the first paint would
  // slow every visit to pay for a section most of them never open.
  test("sends only a preview, leaving the full list to its own fetch", async () => {
    mocks.readAutomationAnalysis.mockResolvedValue(doc);

    const result = await getAutomationInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.findingsPreview.length).toBeLessThan(result.findingsTotal);
    expect(result).not.toHaveProperty("findings");
  });

  test("propagates a storage failure rather than reporting a clean estate", async () => {
    mocks.readAutomationAnalysis.mockRejectedValue(new Error("kvs exploded"));

    await expect(getAutomationInsights({ payload: {}, context: ctxWithAccount() })).rejects.toThrow("kvs exploded");
  });

  // Rule names, project scope and outbound hosts together describe the site's integration
  // surface. This must not be reachable from the macro handler.
  test("is registered admin-only, not shared with the macro handler", () => {
    expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toContain("getAutomationInsights");
    expect(Object.keys(SHARED_RESOLVER_FUNCTIONS)).not.toContain("getAutomationInsights");
  });
});

// A scan wedged in "building" is worse than one that failed: the state is a lie, and the
// admin UI polls a "running" job every 15 seconds for as long as a tab is open.
describe("isScanStuck", () => {
  const MIN = 60 * 1000;
  const at = (msAgo) => new Date(Date.now() - msAgo).toISOString();

  test("leaves a scan alone while it is still logging progress", () => {
    expect(isScanStuck({ state: "building", progressLog: [{ t: at(2 * MIN) }] })).toBe(false);
  });

  test("flags a building scan that has gone quiet past the ceiling", () => {
    expect(isScanStuck({ state: "building", progressLog: [{ t: at(45 * MIN) }] })).toBe(true);
  });

  // A long scan legitimately runs for hours; silence is the signal, not elapsed time.
  test("measures silence from the newest entry, not the oldest", () => {
    const meta = { state: "building", progressLog: [{ t: at(300 * MIN) }, { t: at(1 * MIN) }] };
    expect(isScanStuck(meta)).toBe(false);
  });

  test("covers finalizing, which is also a state a scan can wedge in", () => {
    expect(isScanStuck({ state: "finalizing", progressLog: [{ t: at(45 * MIN) }] })).toBe(true);
  });

  test.each([["ready"], ["failed"], ["cancelled"], ["idle"]])(
    "never touches a scan already in %s",
    (state) => {
      expect(isScanStuck({ state, progressLog: [{ t: at(600 * MIN) }] })).toBe(false);
    }
  );

  test("falls back to startedAt when the log is empty", () => {
    expect(isScanStuck({ state: "building", progressLog: [], startedAt: at(45 * MIN) })).toBe(true);
    expect(isScanStuck({ state: "building", progressLog: [], startedAt: at(2 * MIN) })).toBe(false);
  });

  // Failing a scan on a guess would be worse than leaving it: resume discards no work,
  // but a wrongly-failed scan reads as a defect the admin has to investigate.
  test("leaves a scan alone when there is no usable timestamp at all", () => {
    expect(isScanStuck({ state: "building", progressLog: [] })).toBe(false);
    expect(isScanStuck({ state: "building", progressLog: [{ t: "not-a-date" }] })).toBe(false);
  });

  test("handles absent meta", () => {
    expect(isScanStuck(null)).toBe(false);
    expect(isScanStuck(undefined)).toBe(false);
  });
});

describe("saveAutomationAnalysis", () => {
  const valid = {
    schemaVersion: 1,
    source: "export-file",
    estate: { ruleCount: 1477, enabledCount: 874, disabledCount: 603 },
    findingsPreview: [{ id: 1, n: "r", s: "high", r: [] }],
    findingsTotal: 675,
    cascades: [{ sourceId: 1, targetId: 2, selfTriggering: false }],
    cascadesTotal: 1457,
    selfTriggeringTotal: 123,
  };

  beforeEach(() => {
    mocks.writeAutomationAnalysis.mockResolvedValue(undefined);
  });

  test("stores a valid document under the installation scope", async () => {
    const result = await saveAutomationAnalysis({ payload: { analysis: valid }, context: ctxWithAccount() });

    expect(result.saved).toBe(true);
    const [, stored] = mocks.writeAutomationAnalysis.mock.calls[0];
    expect(stored).toMatchObject({ schemaVersion: 1, estate: valid.estate, findingsTotal: 675, cascadesTotal: 1457 });
  });

  // A skewed workstation clock would otherwise stamp the analysis hours out, and that
  // timestamp is what the staleness warning is built on.
  test("stamps the server clock, not the browser's", async () => {
    const before = Date.now();
    await saveAutomationAnalysis({
      payload: { analysis: { ...valid, refreshedAt: 111 } },
      context: ctxWithAccount(),
    });

    const [, stored] = mocks.writeAutomationAnalysis.mock.calls[0];
    expect(stored.refreshedAt).toBeGreaterThanOrEqual(before);
  });

  // The client applies these caps too. Re-applying them here means a client regression
  // cannot write a value too large for KVS to hold.
  test("re-applies the size caps rather than trusting the client", async () => {
    const oversized = {
      ...valid,
      findingsPreview: Array.from({ length: 500 }, (_, i) => ({ id: i, r: [] })),
      cascades: Array.from({ length: 400 }, (_, i) => ({ sourceId: i, targetId: i })),
    };

    await saveAutomationAnalysis({ payload: { analysis: oversized }, context: ctxWithAccount() });

    const [, stored] = mocks.writeAutomationAnalysis.mock.calls[0];
    expect(stored.findingsPreview).toHaveLength(20);
    expect(stored.cascades).toHaveLength(150);
  });

  test("keeps the estate totals even when the lists are truncated", async () => {
    await saveAutomationAnalysis({ payload: { analysis: valid }, context: ctxWithAccount() });

    const [, stored] = mocks.writeAutomationAnalysis.mock.calls[0];
    expect(stored.findingsTotal).toBe(675);
    expect(stored.cascadesTotal).toBe(1457);
  });

  test("rejects a document with no estate", async () => {
    await expect(
      saveAutomationAnalysis({ payload: { analysis: { schemaVersion: 1 } }, context: ctxWithAccount() })
    ).rejects.toThrow(/estate is required/);
    expect(mocks.writeAutomationAnalysis).not.toHaveBeenCalled();
  });

  test("rejects an unsupported schema version", async () => {
    await expect(
      saveAutomationAnalysis({ payload: { analysis: { ...valid, schemaVersion: 2 } }, context: ctxWithAccount() })
    ).rejects.toThrow(/schemaVersion/);
  });

  test("rejects a non-object payload", async () => {
    await expect(
      saveAutomationAnalysis({ payload: { analysis: [1, 2, 3] }, context: ctxWithAccount() })
    ).rejects.toThrow(/must be an object/);
  });

  test("is registered admin-only", () => {
    expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toContain("saveAutomationAnalysis");
    expect(Object.keys(SHARED_RESOLVER_FUNCTIONS)).not.toContain("saveAutomationAnalysis");
  });
});

describe("saveAutomationIndex", () => {
  beforeEach(() => {
    mocks.writeAutomationPart.mockResolvedValue(undefined);
  });

  test("stores a field index under its own part", async () => {
    const doc = { schemaVersion: 1, kind: "field", total: 735, entries: [] };
    const result = await saveAutomationIndex({ payload: { part: "fields", document: doc }, context: ctxWithAccount() });

    expect(result).toMatchObject({ saved: true, part: "fields" });
    expect(mocks.writeAutomationPart).toHaveBeenCalledWith(expect.any(String), "fields", doc);
  });

  // The analysis has its own resolver, with validation and the server-clock stamp. Routing
  // it through here would bypass both.
  test("refuses to write the analysis part", async () => {
    await expect(
      saveAutomationIndex({ payload: { part: "analysis", document: { schemaVersion: 1 } }, context: ctxWithAccount() })
    ).rejects.toThrow(/unknown automation index part/);
    expect(mocks.writeAutomationPart).not.toHaveBeenCalled();
  });

  test("refuses an unknown part rather than writing to a computed key", async () => {
    await expect(
      saveAutomationIndex({ payload: { part: "__proto__", document: { schemaVersion: 1 } }, context: ctxWithAccount() })
    ).rejects.toThrow(/unknown automation index part/);
  });

  test("rejects a document with the wrong schema version", async () => {
    await expect(
      saveAutomationIndex({ payload: { part: "fields", document: { schemaVersion: 9 } }, context: ctxWithAccount() })
    ).rejects.toThrow(/schemaVersion/);
  });

  test("rejects a non-object document", async () => {
    await expect(
      saveAutomationIndex({ payload: { part: "fields", document: [] }, context: ctxWithAccount() })
    ).rejects.toThrow(/must be an object/);
  });
});

describe("getAutomationIndex", () => {
  test("returns the stored entries and total", async () => {
    mocks.readAutomationPart.mockResolvedValue({ schemaVersion: 1, total: 735, entries: [{ label: "Story Points" }] });

    const result = await getAutomationIndex({ payload: { part: "fields" }, context: ctxWithAccount() });

    expect(result).toMatchObject({ available: true, part: "fields", total: 735 });
    expect(result.entries).toHaveLength(1);
  });

  test("returns the rule tuples for the directory part", async () => {
    mocks.readAutomationPart.mockResolvedValue({ schemaVersion: 1, total: 2, rules: [[1, "A", 1, "t", 0]] });

    const result = await getAutomationIndex({ payload: { part: "directory" }, context: ctxWithAccount() });

    expect(result.rules).toEqual([[1, "A", 1, "t", 0]]);
  });

  // Distinct from an empty index: the section says "re-import to build this" rather than
  // "this site references no fields", which would be a claim the data does not support.
  test("reports unavailable when the index has never been built", async () => {
    mocks.readAutomationPart.mockResolvedValue(null);

    const result = await getAutomationIndex({ payload: { part: "statuses" }, context: ctxWithAccount() });

    expect(result).toMatchObject({ available: false, reason: "no-index" });
  });

  test("refuses an unknown part", async () => {
    await expect(
      getAutomationIndex({ payload: { part: "secrets" }, context: ctxWithAccount() })
    ).rejects.toThrow(/unknown automation index part/);
  });

  test("both index resolvers are admin-only", () => {
    for (const name of ["getAutomationIndex", "saveAutomationIndex"]) {
      expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toContain(name);
      expect(Object.keys(SHARED_RESOLVER_FUNCTIONS)).not.toContain(name);
    }
  });
});

describe("getAutomationFieldUsage", () => {
  const fieldsIndex = {
    schemaVersion: 1, total: 2,
    entries: [
      { label: "Story Points", writeCount: 2, readCount: 1, triggerCount: 0, write: [10, 11], read: [12], trigger: [] },
      { label: "customfield_23054", writeCount: 1, readCount: 0, triggerCount: 0, write: [13], read: [], trigger: [] },
    ],
  };
  const directory = {
    schemaVersion: 1, total: 4,
    rules: [
      [10, "Populate points", 1, "jira.issue.field.changed", 1],
      [11, "Copy to subtasks", 0, "jira.manual.trigger.issue", 1],
      [12, "Check points set", 1, "jira.jql.scheduled", 0],
      [13, "Set prototype", 1, null, 0],
    ],
  };

  function stubParts({ fields = fieldsIndex, dir = directory } = {}) {
    mocks.readAutomationPart.mockImplementation((_key, part) =>
      Promise.resolve(part === "fields" ? fields : part === "directory" ? dir : null)
    );
  }

  test("names the rules that touch the field, grouped by direction", async () => {
    stubParts();

    const result = await getAutomationFieldUsage({ payload: { fieldName: "Story Points", fieldId: "customfield_1" }, context: ctxWithAccount() });

    expect(result).toMatchObject({ available: true, referenced: true, label: "Story Points" });
    expect(result.write.rules.map((r) => r.name)).toEqual(["Populate points", "Copy to subtasks"]);
    expect(result.read.rules.map((r) => r.name)).toEqual(["Check points set"]);
    expect(result.trigger.count).toBe(0);
  });

  test("carries each rule's enabled state, since a disabled rule is not currently a dependency", async () => {
    stubParts();

    const result = await getAutomationFieldUsage({ payload: { fieldName: "Story Points" }, context: ctxWithAccount() });

    expect(result.write.rules.find((r) => r.name === "Copy to subtasks").enabled).toBe(false);
    expect(result.write.rules.find((r) => r.name === "Populate points").enabled).toBe(true);
  });

  test("matches on field id when the rule addressed the field that way", async () => {
    stubParts();

    const result = await getAutomationFieldUsage({ payload: { fieldId: "customfield_23054", fieldName: "Requested Prototype" }, context: ctxWithAccount() });

    expect(result.referenced).toBe(true);
    expect(result.write.rules[0].name).toBe("Set prototype");
  });

  test("matches names case-insensitively, because rule authors' casing drifts", async () => {
    stubParts();

    const result = await getAutomationFieldUsage({ payload: { fieldName: "story points" }, context: ctxWithAccount() });

    expect(result.referenced).toBe(true);
  });

  test("reports a field no rule touches as referenced:false", async () => {
    stubParts();

    const result = await getAutomationFieldUsage({ payload: { fieldName: "Unused Field" }, context: ctxWithAccount() });

    expect(result).toMatchObject({ available: true, referenced: false });
  });

  // The distinction the whole pillar exists for. "No analysis" must never render as "no
  // rules use this field", which is the false reassurance that gets a field deleted.
  test("reports unavailable, not unreferenced, when no analysis has been built", async () => {
    mocks.readAutomationPart.mockResolvedValue(null);

    const result = await getAutomationFieldUsage({ payload: { fieldName: "Story Points" }, context: ctxWithAccount() });

    expect(result).toMatchObject({ available: false, reason: "no-analysis" });
    expect(result.referenced).toBeUndefined();
  });

  test("keeps a rule the directory does not name rather than dropping the dependency", async () => {
    stubParts({ dir: { schemaVersion: 1, total: 0, rules: [] } });

    const result = await getAutomationFieldUsage({ payload: { fieldName: "Story Points" }, context: ctxWithAccount() });

    expect(result.write.rules).toHaveLength(2);
    expect(result.write.rules[0].name).toBe("Rule 10");
  });

  test("requires a field to look up", async () => {
    await expect(getAutomationFieldUsage({ payload: {}, context: ctxWithAccount() })).rejects.toThrow(/fieldName or fieldId/);
  });

  test("is admin-only", () => {
    expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toContain("getAutomationFieldUsage");
    expect(Object.keys(SHARED_RESOLVER_FUNCTIONS)).not.toContain("getAutomationFieldUsage");
  });
});

describe("getAutomationFieldCounts", () => {
  const index = {
    schemaVersion: 1, total: 2,
    entries: [
      { label: "Story Points", ruleCount: 5, enabledRules: 3, disabledRules: 2, write: [], read: [], trigger: [] },
      { label: "customfield_23054", ruleCount: 1, enabledRules: 1, disabledRules: 0, write: [], read: [], trigger: [] },
    ],
  };

  test("answers for a whole page of fields in one read of the index", async () => {
    mocks.readAutomationPart.mockResolvedValue(index);

    const result = await getAutomationFieldCounts({
      payload: { fields: [{ id: "cf_1", name: "Story Points" }, { id: "customfield_23054", name: "Requested Prototype" }] },
      context: ctxWithAccount(),
    });

    expect(mocks.readAutomationPart).toHaveBeenCalledTimes(1);
    expect(result.counts.cf_1).toEqual({ enabled: 3, disabled: 2, total: 5 });
    expect(result.counts.customfield_23054).toEqual({ enabled: 1, disabled: 0, total: 1 });
  });

  test("returns zeroes for a field no rule touches", async () => {
    mocks.readAutomationPart.mockResolvedValue(index);

    const result = await getAutomationFieldCounts({
      payload: { fields: [{ id: "cf_9", name: "Unused" }] },
      context: ctxWithAccount(),
    });

    expect(result.counts.cf_9).toEqual({ enabled: 0, disabled: 0, total: 0 });
  });

  // The chips render an em dash for this, not 0. "Never measured" is not "nothing uses it".
  test("reports unavailable when no analysis has been built", async () => {
    mocks.readAutomationPart.mockResolvedValue(null);

    const result = await getAutomationFieldCounts({
      payload: { fields: [{ id: "cf_1", name: "Story Points" }] },
      context: ctxWithAccount(),
    });

    expect(result).toMatchObject({ available: false, reason: "no-analysis" });
    expect(result.counts).toEqual({});
  });

  test("caps the batch so one call cannot ask about the whole estate", async () => {
    mocks.readAutomationPart.mockResolvedValue(index);
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `cf_${i}`, name: `F${i}` }));

    const result = await getAutomationFieldCounts({ payload: { fields: many }, context: ctxWithAccount() });

    expect(Object.keys(result.counts)).toHaveLength(100);
  });

  test("handles an empty request without reading storage", async () => {
    const result = await getAutomationFieldCounts({ payload: { fields: [] }, context: ctxWithAccount() });
    expect(result).toEqual({ available: true, counts: {} });
    expect(mocks.readAutomationPart).not.toHaveBeenCalled();
  });
});

describe("Rovo automation agent actions", () => {
  const directory = {
    schemaVersion: 1, total: 3,
    rules: [
      [10, "Copy fields to subtasks", 1, "jira.issue.field.changed", 2],
      // Shares the word "approval" with rule 12 so the enabled-first ordering is actually
      // exercised rather than being the only match.
      [11, "Old approval cleanup", 0, "jira.jql.scheduled", 0],
      [12, "Send to approval", 1, "jira.issue.event.trigger:created", 1],
    ],
  };
  const fields = {
    schemaVersion: 1, total: 1,
    entries: [{ label: "Story Points", writeCount: 1, readCount: 1, triggerCount: 0, ruleCount: 2, enabledRules: 1, disabledRules: 1, write: [10], read: [11], trigger: [] }],
  };
  const statuses = { schemaVersion: 1, total: 0, entries: [] };
  const findings = {
    schemaVersion: 1, total: 1,
    findings: [{ id: 12, n: "Send to approval", s: "high", r: [{ c: "embedded-credential", s: "high" }] }],
  };

  function stubAll({ analysis = { schemaVersion: 1, refreshedAt: 1754400000000 } } = {}) {
    mocks.readAutomationAnalysis.mockResolvedValue(analysis);
    mocks.readAutomationPart.mockImplementation((_k, part) =>
      Promise.resolve({ fields, statuses, directory, findings }[part] ?? null)
    );
  }

  describe("rovoSearchAutomationRules", () => {
    test("matches rules by name and reports their state and findings", async () => {
      stubAll();
      const result = await rovoSearchAutomationRules({ query: "approval" }, {});

      expect(result.status).toBe("ok");
      expect(result.matches[0]).toMatchObject({ ruleId: 12, name: "Send to approval", state: "ENABLED" });
      expect(result.matches[0].findings).toContain("embedded-credential");
    });

    test("lists enabled rules first, since a disabled rule explains nothing happening now", async () => {
      stubAll();
      const result = await rovoSearchAutomationRules({ query: "approval" }, {});

      expect(result.matches).toHaveLength(2);
      expect(result.matches.map((m) => m.state)).toEqual(["ENABLED", "DISABLED"]);
    });

    test("filters by state when asked", async () => {
      stubAll();
      const result = await rovoSearchAutomationRules({ query: "", state: "disabled" }, {});
      expect(result.status).toBe("error");

      const disabled = await rovoSearchAutomationRules({ query: "cleanup", state: "disabled" }, {});
      expect(disabled.matches.map((m) => m.ruleId)).toEqual([11]);
    });

    // The agent must never answer "no rules" from an absent analysis.
    test("reports analysis-unavailable rather than an empty match list", async () => {
      mocks.readAutomationAnalysis.mockResolvedValue(null);
      mocks.readAutomationPart.mockResolvedValue(null);

      const result = await rovoSearchAutomationRules({ query: "anything" }, {});

      expect(result.status).toBe("analysis-unavailable");
      expect(result.matches).toBeUndefined();
    });

    test("carries the analysis age so the agent can caveat a stale answer", async () => {
      stubAll();
      const result = await rovoSearchAutomationRules({ query: "approval" }, {});
      expect(result.analysisRefreshedAt).toBe(1754400000000);
    });
  });

  describe("rovoInspectAutomationRule", () => {
    test("resolves a rule by numeric id", async () => {
      stubAll();
      const result = await rovoInspectAutomationRule({ ruleIdentifier: "12" }, {});
      expect(result.rule).toMatchObject({ ruleId: 12, name: "Send to approval", state: "ENABLED" });
    });

    test("resolves a rule by partial name", async () => {
      stubAll();
      const result = await rovoInspectAutomationRule({ ruleIdentifier: "subtasks" }, {});
      expect(result.rule.ruleId).toBe(10);
    });

    test("lists the fields the rule touches and in which direction", async () => {
      stubAll();
      const result = await rovoInspectAutomationRule({ ruleIdentifier: "10" }, {});
      expect(result.fieldsTouched).toContainEqual({ field: "Story Points", direction: "write" });
    });

    test("turns a risk code into a sentence the agent can say out loud", async () => {
      stubAll();
      const result = await rovoInspectAutomationRule({ ruleIdentifier: "12" }, {});
      expect(result.findings[0].summary).toMatch(/anyone who can view the rule can read/i);
    });

    test("states the index cap as a caveat rather than implying the list is complete", async () => {
      stubAll();
      const result = await rovoInspectAutomationRule({ ruleIdentifier: "12" }, {});
      expect(result.caveat).toMatch(/capped index/i);
    });

    test("reports not-found for an unknown rule", async () => {
      stubAll();
      const result = await rovoInspectAutomationRule({ ruleIdentifier: "nonexistent" }, {});
      expect(result.status).toBe("not-found");
    });
  });

  describe("rovoAutomationUsage", () => {
    test("answers the deletion question directly", async () => {
      stubAll();
      const result = await rovoAutomationUsage({ name: "Story Points" }, {});

      expect(result.status).toBe("ok");
      expect(result.safeToDelete).toBe(false);
      expect(result.guidance).toMatch(/would break 1 rule/i);
      expect(result.writtenBy.rules[0]).toMatchObject({ name: "Copy fields to subtasks", state: "ENABLED" });
    });

    test("splits enabled from disabled, since only one of them runs today", async () => {
      stubAll();
      const result = await rovoAutomationUsage({ name: "Story Points" }, {});
      expect(result).toMatchObject({ enabledRules: 1, disabledRules: 1, ruleCount: 2 });
    });

    test("says a field is unreferenced only when an analysis exists", async () => {
      stubAll();
      const result = await rovoAutomationUsage({ name: "Never Used" }, {});
      expect(result).toMatchObject({ status: "not-referenced", safeToDelete: true });
    });

    test("refuses to answer at all when no analysis has been built", async () => {
      mocks.readAutomationAnalysis.mockResolvedValue(null);
      mocks.readAutomationPart.mockResolvedValue(null);

      const result = await rovoAutomationUsage({ name: "Story Points" }, {});

      expect(result.status).toBe("analysis-unavailable");
      expect(result.safeToDelete).toBeUndefined();
    });

    test("looks in the status index when asked about a status", async () => {
      stubAll();
      const result = await rovoAutomationUsage({ name: "Done", kind: "status" }, {});
      expect(result.status).toBe("not-referenced");
      // A status is never "safe to delete" on automation evidence alone.
      expect(result.safeToDelete).toBe(false);
    });
  });
});

// Insight findings are site-wide by necessity -- a duplicate cannot be spotted from a
// single page -- so these tests focus on what the resolver is allowed to CLAIM, which is
// bounded by which upstream data actually exists.
describe("getWorkflowInsights", () => {
  const status = (id, name, statusCategory = "In Progress") => ({ statusId: String(id), name, statusCategory });

  test("reports unavailable rather than empty when no snapshot exists", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: null, state: "idle" });

    const result = await getWorkflowInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.available).toBe(false);
    expect(result.reason).toBe("no-snapshot");
  });

  test("finds duplicate status names across the catalog", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([
      status(1, "Backlog"), status(2, "Back Log"), status(3, "Delivered"),
    ]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([{ schemeId: "s1", statusId: "1" }]);

    const result = await getWorkflowInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.available).toBe(true);
    expect(result.summary.duplicateGroupCount).toBe(1);
    expect(result.summary.reducibleStatusCount).toBe(1);
  });

  // The scan is versioned independently of the workflow snapshot and may never have run.
  // "No issue counts" must never be reported as "zero issues", because zero is what makes
  // an unreachable status safe to delete.
  test("never claims a status is unused when the scan has not run", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([status(1, "Orphaned")]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([{ schemeId: "s1", statusId: "99" }]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map());

    const result = await getWorkflowInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.hasIssueCounts).toBe(false);
    expect(result.orphans[0].issueCount).toBeNull();
    expect(result.orphans[0].safeToRemove).toBe(false);
    expect(result.summary.safeToRemoveCount).toBe(0);
  });

  test("marks a never-used orphan as safe once scan counts exist", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([status(1, "Orphaned"), status(2, "Used Once")]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([{ schemeId: "s1", statusId: "99" }]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map([["1", 0], ["2", 5]]));

    const result = await getWorkflowInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.hasIssueCounts).toBe(true);
    expect(result.summary.safeToRemoveCount).toBe(1);
  });

  // If Jira did not return workflow statuses, EVERY status looks orphaned and EVERY
  // scheme looks empty. Suppress both rather than publishing confident nonsense.
  test("suppresses orphan and balance findings when scheme-status data is missing", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([{ id: "s1", name: "Alpha", projectCount: 2 }]);
    mocks.loadStatusesCatalog.mockResolvedValue([status(1, "A"), status(2, "B")]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([]);

    const result = await getWorkflowInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.schemeStatusesAvailable).toBe(false);
    expect(result.orphans).toEqual([]);
    expect(result.balance).toEqual([]);
  });

  test("survives the scan count lookup failing", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([status(1, "A")]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([{ schemeId: "s1", statusId: "1" }]);
    mocks.loadStatusIssueCounts.mockRejectedValue(new Error("sql down"));

    const result = await getWorkflowInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.available).toBe(true);
    expect(result.hasIssueCounts).toBe(false);
  });
});

// Automation is a blind spot in the workflow findings: a status can look unreachable while
// a rule still transitions issues into it. Jira's automation API is undocumented, so this
// resolver asks which endpoints answer instead of assuming — and must never fail the page
// it runs on.
describe("probeAutomationApi", () => {
  // Admin-only resolvers are exported wrapped in withAdminGuard + withAuditTrail. The raw
  // registry exists so a test can exercise the resolver's own logic without standing up a
  // permission mock.
  const probeAutomationApi = __RAW_ADMIN_ONLY_FUNCTIONS.probeAutomationApi;

  beforeEach(() => {
    mocks.getAllJiraProjects.mockResolvedValue([{ id: "10000", key: "ALPHA", name: "Alpha" }]);
    mocks.getCloudId.mockReturnValue("11111111-2222-3333-4444-555555555555");
    mocks.probeStargateEndpoint.mockResolvedValue({ path: "s", status: 404, ok: false, ms: 5, sample: "" });
  });

  test("probes both global and project scopes", async () => {
    mocks.probeEndpoint.mockResolvedValue({ path: "x", status: 404, ok: false, ms: 5, sample: "not found" });

    const result = await probeAutomationApi({ context: {} });

    const scopes = new Set(result.results.map((r) => r.scope));
    expect(scopes.has("global")).toBe(true);
    expect(scopes.has("project")).toBe(true);
    // Asserted on what was REQUESTED, not on the returned row: the stub returns a canned
    // path, so checking the result would test the mock rather than the resolver.
    const requested = mocks.probeEndpoint.mock.calls.map((c) => c[0]);
    expect(requested.some((path) => path.includes("10000"))).toBe(true);
    expect(requested.some((path) => path.includes("GLOBAL"))).toBe(true);

    // The documented automation API lives on api.atlassian.com, not the site, so it has to
    // go through Stargate -- asking the site for it is what produced the first round of
    // 401s.
    const viaGateway = mocks.probeStargateEndpoint.mock.calls.map((c) => c[0]);
    expect(viaGateway.some((path) => path.includes("/automation/public/jira/"))).toBe(true);
    expect(viaGateway.every((path) => path.includes("11111111-2222"))).toBe(true);
    expect(viaGateway.some((path) => path.startsWith("https://api.atlassian.com/"))).toBe(true);
  });

  // A 200 is not the same as usable JSON: Jira can answer with an HTML login page or an
  // error envelope, and treating that as success would report extraction as possible when
  // it is not.
  test("counts an endpoint as reachable only when the body looks like rules", async () => {
    mocks.probeEndpoint
      .mockResolvedValueOnce({ path: "a", status: 200, ok: true, ms: 5, sample: "<html>login</html>" })
      .mockResolvedValue({ path: "b", status: 200, ok: true, ms: 5, sample: '{"rules":[{"id":1}]}' });

    const result = await probeAutomationApi({ context: {} });

    expect(result.reachable).not.toContain("a");
    expect(result.reachable.length).toBeGreaterThan(0);
  });

  test("reports nothing reachable when every endpoint rejects", async () => {
    mocks.probeEndpoint.mockResolvedValue({ path: "x", status: 401, ok: false, ms: 5, sample: "scope does not match" });

    const result = await probeAutomationApi({ context: {} });

    expect(result.reachable).toEqual([]);
    expect(result.results.every((r) => r.looksLikeRules === false)).toBe(true);
  });

  // A diagnostic that can fail the page it runs on is worse than no diagnostic.
  test("still probes the global scope when the project lookup fails", async () => {
    mocks.getAllJiraProjects.mockRejectedValue(new Error("403"));
    mocks.probeEndpoint.mockResolvedValue({ path: "x", status: 404, ok: false, ms: 5, sample: "" });

    const result = await probeAutomationApi({ context: {} });

    expect(result.projectId).toBeNull();
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every((r) => r.scope === "global")).toBe(true);
  });
});


// The documented automation API is on api.atlassian.com and keyed by cloud id. Probing the
// site for it is what produced the first round of 401s.
describe("probeAutomationApi — gateway transport", () => {
  const probeAutomationApi = __RAW_ADMIN_ONLY_FUNCTIONS.probeAutomationApi;

  test("skips the gateway probes when no cloud id can be derived", async () => {
    mocks.getAllJiraProjects.mockResolvedValue([]);
    mocks.getCloudId.mockReturnValue(null);
    mocks.probeEndpoint.mockResolvedValue({ path: "x", status: 401, ok: false, ms: 5, sample: "" });

    const result = await probeAutomationApi({ context: {} });

    expect(mocks.probeStargateEndpoint).not.toHaveBeenCalled();
    expect(result.cloudId).toBeNull();
    // The site-relative probes still run, so the panel is never empty.
    expect(result.results.length).toBeGreaterThan(0);
  });

  test("labels each row with the transport that produced it", async () => {
    mocks.getAllJiraProjects.mockResolvedValue([{ id: "10000" }]);
    mocks.getCloudId.mockReturnValue("11111111-2222-3333-4444-555555555555");
    mocks.probeEndpoint.mockResolvedValue({ path: "x", status: 401, ok: false, ms: 5, sample: "" });
    mocks.probeStargateEndpoint.mockResolvedValue({ path: "s", status: 200, ok: true, ms: 5, sample: '{"values":[]}' });

    const result = await probeAutomationApi({ context: {} });

    // Without this the table cannot explain why two identical-looking paths behave
    // differently, which is exactly the confusion that cost a round of probing.
    expect(result.results.some((r) => r.via === "stargate")).toBe(true);
    expect(result.results.some((r) => r.via === "site")).toBe(true);
  });
});
