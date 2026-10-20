import { vi, beforeEach } from "vitest";

// Shared scaffold for the resolver test files, split out of src/resolvers.test.js
// (docs/resolvers-refactor.md, follow-up 3). Import it FIRST in a test file: importing it
// registers every vi.mock below before ../resolvers.js loads, so each file gets the same mocked
// lib layer the single file had. Not a test file: excluded from collection and from coverage.

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

export const mocks = {
  getAllJiraProjects: vi.fn(),
  probeEndpoint: vi.fn(),
  getPermissionCatalog: vi.fn(async () => ({})),
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
  summarizeRecentDenials: vi.fn().mockResolvedValue({ denials: 0, actors: 0, latestAt: null }),
  loadSnapshotFields: vi.fn(),
  loadSnapshotField: vi.fn(),
  loadSnapshotProjectUsage: vi.fn(),
  loadAllSnapshotProjectUsage: vi.fn(),
  loadAnySnapshotProjectUsage: vi.fn(),
  listSnapshotProjects: vi.fn(async () => []),
  loadProjectActivity: vi.fn(async () => new Map()),
  loadFilters: vi.fn(async () => []),
  readFilterSnapshotMeta: vi.fn(async () => null),
  readFullScanMeta: vi.fn(async () => null),
  writeFullScanMeta: vi.fn(async () => ({})),
  createJiraIssue: vi.fn(async () => ({ id: "10001", key: "OPS-1", self: "https://x/OPS-1" })),
  transitionIssueWithComment: vi.fn(async (issueKey) => ({
    issueKey,
    transitioned: true,
    commented: true,
    toStatus: "To Do",
    reason: null,
  })),
  updateJiraIssue: vi.fn(async () => {}),
  searchIssuesPage: vi.fn(async () => []),
  loadHierarchyNodes: vi.fn(async () => new Map()),
  recordHierarchyNode: vi.fn(async () => {}),
  recordRemediationTicket: vi.fn(async () => undefined),
  loadRemediationTickets: vi.fn(async () => []),
  getRemediationEpic: vi.fn(async () => null),
  // Pinned so ticket summaries and period grouping are deterministic across the calendar.
  currentPeriod: vi.fn(() => "2026-Q3"),
  getSiteBaseUrl: vi.fn(async () => "https://test.atlassian.net"),
  loadTicketedItemIds: vi.fn(async () => new Set()),
  loadTicketedItems: vi.fn(async () => new Map()),
  readUsageMeta: vi.fn(async () => null),
  // Default: archived projects were read and there are none, so existing verdicts stand.
  loadArchivedProjects: vi.fn(async () => ({
    available: true,
    checkedAt: "2026-10-01T00:00:00Z",
    error: null,
    projects: [],
  })),
  loadArchivedFieldUsage: vi.fn(async () => new Map()),
  getFieldProjectAssociations: vi.fn(async () => []),
  loadUsageTally: vi.fn(async () => new Map()),
  readRecentFullScanRuns: vi.fn(async () => []),
  recoverStalledScan: vi.fn(async () => ({ recovered: false, reason: "healthy" })),
  resumeScanRun: vi.fn(async () => ({ resumed: true, retrying: ["dashboards"] })),
  loadDashboardsForFilters: vi.fn(async () => []),
  loadFieldNamesForFilterIds: vi.fn(async () => new Map()),
  loadFilterNamesForIds: vi.fn(async () => new Map()),
  countGadgetConfigCoverage: vi.fn(async () => ({ total: 0, walked: 0 })),
  pruneFilterSnapshots: vi.fn(),
  pruneDashboardSnapshots: vi.fn(),
  clearFilterSnapshotVersion: vi.fn(),
  appendFilterSnapshot: vi.fn(),
  clearDashboardSnapshotVersion: vi.fn(),
  appendDashboardSnapshot: vi.fn(),
  writeFilterSnapshotMeta: vi.fn(async () => ({})),
  loadFilterReferencesFor: vi.fn(async () => ({ total: 0, filters: [] })),
  loadFilterReferenceCounts: vi.fn(async () => ({})),
  loadFilterIdsForLabels: vi.fn(async () => new Map()),
  loadGadgetCountsForFilterIds: vi.fn(async () => new Map()),
  loadDashboards: vi.fn(async () => []),
  readDashboardSnapshotMeta: vi.fn(async () => null),
  writeDashboardSnapshotMeta: vi.fn(async () => ({})),
  loadIssueScanProjectTotals: vi.fn(),
  loadSnapshotProjectFields: vi.fn(),
  countSnapshotProjectUsage: vi.fn(),
  loadFieldSummary: vi.fn(),
  replaceFieldSummary: vi.fn().mockResolvedValue(undefined),
  countFieldSummariesByStatus: vi.fn(async () => ({
    counts: { queued: 0, building: 0, ready: 0, failed: 0, cancelled: 0, unbuilt: 0 },
    total: 0,
  })),
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
  loadFieldTypeUsage: vi.fn().mockResolvedValue([]),
  loadFieldUserUsage: vi.fn().mockResolvedValue({ distinctUsers: 0, issueTotal: 0, top: [] }),
  loadUserFieldAppearances: vi.fn().mockResolvedValue([]),
  loadSnapshotFieldNames: vi.fn().mockResolvedValue(new Map()),
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
  loadWorkflowRefsFor: vi.fn(async () => []),
  readFieldConfigSnapshotMeta: vi.fn(async () => null),
  loadTransitionsTouchingStatus: vi.fn(async () => []),
  loadStatusWorkflowProperties: vi.fn(async () => []),
  loadWorkflowRefsByType: vi.fn(async () => []),
  loadWorkflowsCatalog: vi.fn(async () => []),
  readAutomationAnalysis: vi.fn(),
  replaceAutomationCascades: vi.fn(async () => 0),
  replaceAutomationBlast: vi.fn(async () => 0),
  loadBlastSummary: vi.fn(async () => ({ available: false, total: 0, byTier: {}, estateWideCount: 0 })),
  loadBlastRules: vi.fn(async () => ({ rules: [], total: 0 })),
  loadCascadeSummary: vi.fn(async () => ({ edges: 0, pairs: 0, selfTriggeringRules: 0, fields: 0 })),
  loadCascades: vi.fn(async () => ({ cascades: [], total: 0 })),
  loadCascadeEdges: vi.fn(async () => []),
  loadRuleDirectoryFor: vi.fn(async () => new Map()),
  writeAutomationAnalysis: vi.fn(),
  readAutomationPart: vi.fn(),
  writeAutomationPart: vi.fn(),
  replaceAutomationReferences: vi.fn(),
  replaceAutomationRules: vi.fn(),
  replaceAutomationFindings: vi.fn(),
  loadAutomationReferencesFor: vi.fn(),
  loadWorkflowSchemes: vi.fn(),
  loadWorkflowSchemeProjects: vi.fn(),
  loadProjectWorkflowSchemeMap: vi.fn(async () => new Map()),
  loadWorkflowSchemeForProject: vi.fn().mockResolvedValue(null),
  loadStatusesCatalog: vi.fn(),
  loadWorkflowSchemeStatuses: vi.fn(),
  loadStatusIssueCounts: vi.fn(),
  loadStatusHistoryCounts: vi.fn(),

  // screen store + screen-engine.js
  readScreenSnapshotMeta: vi.fn(),
  loadScreensPage: vi.fn(),
  loadScreensForProjects: vi.fn(async () => []),
  loadScreensForField: vi.fn(),
  loadScreenSchemes: vi.fn(),
  loadScreenSchemeOperations: vi.fn(),
  loadIssueTypeScreenSchemes: vi.fn(),
  loadItssMappings: vi.fn(async () => []),
  loadItssProjects: vi.fn(async () => []),
  loadScreensWithFieldsByIds: vi.fn(async () => []),
  loadScreenGovernanceSummary: vi.fn(),
  loadFieldReachabilityByProject: vi.fn(async () => []),
  loadProjectScreenCoverage: vi.fn(async () => []),
  loadPopulatedProjectUsage: vi.fn(async () => ({ rows: [], truncated: false, limit: 20000 })),
  loadPopulatedFieldProjectPairs: vi.fn(async () => ({ pairs: new Set(), complete: true })),
  writeScreenCrossSummary: vi.fn(async () => ({})),
  readScreenCrossSummary: vi.fn(async () => null),
  loadScreenCountsForFields: vi.fn(),
  loadScreenDistributions: vi.fn(),
  loadScreensForProject: vi.fn(),

  // issue-type store + issuetype-engine.js
  readIssueTypeSnapshotMeta: vi.fn(),
  loadIssueTypes: vi.fn(async () => []),
  loadIssueTypeSchemes: vi.fn(async () => []),
  loadIssueTypeSchemeItems: vi.fn(async () => []),
  loadIssueTypeSchemeProjects: vi.fn(async () => []),
  loadIssueTypeSchemeForProject: vi.fn(async () => null),
  loadIssueTypeGovernanceSummary: vi.fn(async () => null),
  queueIssueTypeSnapshotBuild: vi.fn(),
  isIssueTypeBuildStale: vi.fn(() => false),

  // user store + user-engine.js
  readUserSnapshotMeta: vi.fn(),
  loadUserActivity: vi.fn(async () => []),
  loadEstateValueTotals: vi.fn(async () => []),
  loadIssueTypeTotals: vi.fn(async () => []),
  loadUsers: vi.fn(async () => []),
  loadUserGovernanceSummary: vi.fn(async () => null),
  queueUserSnapshotBuild: vi.fn(),
  isUserBuildStale: vi.fn(() => false),

  // asset store + asset-engine.js
  readAssetSnapshotMeta: vi.fn(),
  loadAssetSchemas: vi.fn(async () => []),
  loadAssetObjectTypes: vi.fn(async () => []),
  loadAssetAttributes: vi.fn(async () => []),
  loadAssetTypeCounts: vi.fn(async () => []),
  readAssetTypeCountMeta: vi.fn(async () => null),
  queueAssetSnapshotBuild: vi.fn(),
  isAssetBuildStale: vi.fn(() => false),
  queueAssetTypeCountBuild: vi.fn(),
  isAssetTypeCountBuildStale: vi.fn(() => false),

  // access store + access-engine.js
  readAccessSnapshotMeta: vi.fn(),
  loadSchemes: vi.fn(async () => []),
  loadSchemeHolders: vi.fn(async () => []),
  loadSchemeLevels: vi.fn(async () => []),
  loadSchemeProjects: vi.fn(async () => []),
  loadSchemesGrantingHolder: vi.fn(async () => []),
  loadProjectSchemes: vi.fn(async () => []),
  loadProjectRoleActors: vi.fn(async () => []),
  queueAccessSnapshotBuild: vi.fn(),
  isAccessBuildStale: vi.fn(() => false),

  // drift store + drift-engine.js
  readDriftSnapshotMeta: vi.fn(),
  loadConfigChanges: vi.fn(async () => []),
  loadConfigChangeSummary: vi.fn(async () => ({
    total: 0,
    byPillar: {},
    byKind: { added: 0, removed: 0, modified: 0 },
  })),
  queueDriftSnapshotBuild: vi.fn(),
  isDriftBuildStale: vi.fn(() => false),

  // estate store + estate-engine.js
  readEstateSnapshotMeta: vi.fn(),
  loadEstateValues: vi.fn(async () => []),
  queueEstateSnapshotBuild: vi.fn(),
  queueFieldConfigSnapshotBuild: vi.fn(),
  isFieldConfigBuildStale: vi.fn(() => false),
  getFieldConfigInventory: vi.fn(),
  isEstateBuildStale: vi.fn(() => false),

  // board store + board-engine.js
  readBoardSnapshotMeta: vi.fn(async () => null),
  loadBoards: vi.fn(async () => []),
  loadBoardColumns: vi.fn(async () => []),
  queueBoardSnapshotBuild: vi.fn(),
  isBoardBuildStale: vi.fn(() => false),

  loadRulesForProject: vi.fn(),
  loadStatusAutomationReferences: vi.fn(),
  loadGlobalRulesAffectingProject: vi.fn(),
  recordHealthSnapshot: vi.fn(),
  loadPriorHealthDimensions: vi.fn(async () => ({})),
  loadHealthHistory: vi.fn(),
  queueScreenSnapshotBuild: vi.fn(),
  isScreenBuildStale: vi.fn(() => false),

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
};

vi.mock("@forge/kvs", () => ({ kvs: { get: mocks.kvsGet, set: mocks.kvsSet } }));

vi.mock("@forge/api", () => ({
  default: { asApp: () => ({ requestJira: mocks.apiAsAppRequestJira }) },
  route: (strings, ...vals) => strings.reduce((acc, s, i) => acc + s + (vals[i] ?? ""), ""),
}));

vi.mock("../lib/queues.js", () => ({
  inventorySnapshotQueue: { push: mocks.queuePush },
}));

vi.mock("../lib/scan-engine.js", () => ({
  queueIssueScanWorker: mocks.queueIssueScanWorker,
  completeIssueScanFinalization: mocks.completeIssueScanFinalization,
}));

vi.mock("../lib/store/automation.js", () => ({
  readAutomationAnalysis: mocks.readAutomationAnalysis,
  writeAutomationAnalysis: mocks.writeAutomationAnalysis,
  readAutomationPart: mocks.readAutomationPart,
  writeAutomationPart: mocks.writeAutomationPart,
  replaceAutomationReferences: mocks.replaceAutomationReferences,
  replaceAutomationRules: mocks.replaceAutomationRules,
  replaceAutomationFindings: mocks.replaceAutomationFindings,
  replaceAutomationCascades: mocks.replaceAutomationCascades,
  replaceAutomationBlast: mocks.replaceAutomationBlast,
  loadBlastSummary: mocks.loadBlastSummary,
  loadBlastRules: mocks.loadBlastRules,
  loadCascadeSummary: mocks.loadCascadeSummary,
  loadCascades: mocks.loadCascades,
  loadCascadeEdges: mocks.loadCascadeEdges,
  loadRuleDirectoryFor: mocks.loadRuleDirectoryFor,
  loadAutomationReferencesFor: mocks.loadAutomationReferencesFor,
  loadRulesForProject: mocks.loadRulesForProject,
  loadStatusAutomationReferences: mocks.loadStatusAutomationReferences,
  loadGlobalRulesAffectingProject: mocks.loadGlobalRulesAffectingProject,
  AUTOMATION_PARTS: {
    analysis: "a:",
    fields: "f:",
    statuses: "s:",
    issueTypes: "it:",
    users: "u:",
    directory: "d:",
    findings: "fi:",
    cascades: "c:",
  },
  MAX_PREVIEW_FINDINGS: 20,
  MAX_STORED_CASCADES: 150,
  MAX_STORED_CROSS_RULE: 100,
}));

vi.mock("../lib/project-store.js", () => ({
  ensureProjectStoreReady: mocks.ensureProjectStoreReady,
  readSnapshotMeta: mocks.readSnapshotMeta,
  writeSnapshotMeta: mocks.writeSnapshotMeta,
  clearAllSnapshotData: mocks.clearAllSnapshotData,
  recordAuditEvent: mocks.recordAuditEvent,
  listAuditEvents: mocks.listAuditEvents,
  summarizeRecentDenials: mocks.summarizeRecentDenials,
  loadSnapshotFields: mocks.loadSnapshotFields,
  loadSnapshotField: mocks.loadSnapshotField,
  loadSnapshotProjectUsage: mocks.loadSnapshotProjectUsage,
  loadAllSnapshotProjectUsage: mocks.loadAllSnapshotProjectUsage,
  loadAnySnapshotProjectUsage: mocks.loadAnySnapshotProjectUsage,
  listSnapshotProjects: mocks.listSnapshotProjects,
  loadIssueScanProjectTotals: mocks.loadIssueScanProjectTotals,
  loadProjectActivity: mocks.loadProjectActivity,
  loadFilters: mocks.loadFilters,
  readFilterSnapshotMeta: mocks.readFilterSnapshotMeta,
  readFullScanMeta: mocks.readFullScanMeta,
  writeFullScanMeta: mocks.writeFullScanMeta,
  readRecentFullScanRuns: mocks.readRecentFullScanRuns,
  loadDashboardsForFilters: mocks.loadDashboardsForFilters,
  loadFieldNamesForFilterIds: mocks.loadFieldNamesForFilterIds,
  loadFilterNamesForIds: mocks.loadFilterNamesForIds,
  countGadgetConfigCoverage: mocks.countGadgetConfigCoverage,
  pruneFilterSnapshots: mocks.pruneFilterSnapshots,
  pruneDashboardSnapshots: mocks.pruneDashboardSnapshots,
  clearFilterSnapshotVersion: mocks.clearFilterSnapshotVersion,
  appendFilterSnapshot: mocks.appendFilterSnapshot,
  clearDashboardSnapshotVersion: mocks.clearDashboardSnapshotVersion,
  appendDashboardSnapshot: mocks.appendDashboardSnapshot,
  writeFilterSnapshotMeta: mocks.writeFilterSnapshotMeta,
  loadFilterReferencesFor: mocks.loadFilterReferencesFor,
  loadFilterReferenceCounts: mocks.loadFilterReferenceCounts,
  loadFilterIdsForLabels: mocks.loadFilterIdsForLabels,
  loadGadgetCountsForFilterIds: mocks.loadGadgetCountsForFilterIds,
  loadDashboards: mocks.loadDashboards,
  readDashboardSnapshotMeta: mocks.readDashboardSnapshotMeta,
  writeDashboardSnapshotMeta: mocks.writeDashboardSnapshotMeta,
  loadSnapshotProjectFields: mocks.loadSnapshotProjectFields,
  countSnapshotProjectUsage: mocks.countSnapshotProjectUsage,
  loadFieldSummary: mocks.loadFieldSummary,
  replaceFieldSummary: mocks.replaceFieldSummary,
  listFieldSummaries: mocks.listFieldSummaries,
  countFieldSummariesByStatus: mocks.countFieldSummariesByStatus,
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
  loadFieldTypeUsage: mocks.loadFieldTypeUsage,
  loadFieldUserUsage: mocks.loadFieldUserUsage,
  loadUserFieldAppearances: mocks.loadUserFieldAppearances,
  loadSnapshotFieldNames: mocks.loadSnapshotFieldNames,
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
  loadWorkflowRefsFor: mocks.loadWorkflowRefsFor,
  readFieldConfigSnapshotMeta: mocks.readFieldConfigSnapshotMeta,
  loadTransitionsTouchingStatus: mocks.loadTransitionsTouchingStatus,
  loadStatusWorkflowProperties: mocks.loadStatusWorkflowProperties,
  loadWorkflowRefsByType: mocks.loadWorkflowRefsByType,
  loadWorkflowsCatalog: mocks.loadWorkflowsCatalog,
  readScreenSnapshotMeta: mocks.readScreenSnapshotMeta,
  loadScreensPage: mocks.loadScreensPage,
  loadScreensForField: mocks.loadScreensForField,
  loadScreensForProjects: mocks.loadScreensForProjects,
  loadScreenSchemes: mocks.loadScreenSchemes,
  loadScreenSchemeOperations: mocks.loadScreenSchemeOperations,
  loadIssueTypeScreenSchemes: mocks.loadIssueTypeScreenSchemes,
  loadItssMappings: mocks.loadItssMappings,
  loadItssProjects: mocks.loadItssProjects,
  loadScreensWithFieldsByIds: mocks.loadScreensWithFieldsByIds,
  loadScreenGovernanceSummary: mocks.loadScreenGovernanceSummary,
  loadFieldReachabilityByProject: mocks.loadFieldReachabilityByProject,
  loadProjectScreenCoverage: mocks.loadProjectScreenCoverage,
  loadPopulatedProjectUsage: mocks.loadPopulatedProjectUsage,
  loadPopulatedFieldProjectPairs: mocks.loadPopulatedFieldProjectPairs,
  // Pure; the real rule, so a test's workflow meta decides reachability as it would live.
  transitionAwareWorkflowVersion: (meta) => (meta?.version && meta.transitionScreens != null ? meta.version : null),
  writeScreenCrossSummary: mocks.writeScreenCrossSummary,
  readScreenCrossSummary: mocks.readScreenCrossSummary,
  loadScreenCountsForFields: mocks.loadScreenCountsForFields,
  loadScreenDistributions: mocks.loadScreenDistributions,
  loadScreensForProject: mocks.loadScreensForProject,
  readIssueTypeSnapshotMeta: mocks.readIssueTypeSnapshotMeta,
  loadIssueTypes: mocks.loadIssueTypes,
  loadIssueTypeSchemes: mocks.loadIssueTypeSchemes,
  loadIssueTypeSchemeItems: mocks.loadIssueTypeSchemeItems,
  loadIssueTypeSchemeProjects: mocks.loadIssueTypeSchemeProjects,
  loadIssueTypeSchemeForProject: mocks.loadIssueTypeSchemeForProject,
  loadIssueTypeGovernanceSummary: mocks.loadIssueTypeGovernanceSummary,
  readUserSnapshotMeta: mocks.readUserSnapshotMeta,
  loadUsers: mocks.loadUsers,
  loadUserActivity: mocks.loadUserActivity,
  loadEstateValueTotals: mocks.loadEstateValueTotals,
  loadIssueTypeTotals: mocks.loadIssueTypeTotals,
  loadUserGovernanceSummary: mocks.loadUserGovernanceSummary,
  readAssetSnapshotMeta: mocks.readAssetSnapshotMeta,
  readAccessSnapshotMeta: mocks.readAccessSnapshotMeta,
  loadSchemes: mocks.loadSchemes,
  loadSchemeHolders: mocks.loadSchemeHolders,
  loadSchemeLevels: mocks.loadSchemeLevels,
  loadSchemeProjects: mocks.loadSchemeProjects,
  loadSchemesGrantingHolder: mocks.loadSchemesGrantingHolder,
  loadProjectSchemes: mocks.loadProjectSchemes,
  loadProjectRoleActors: mocks.loadProjectRoleActors,
  readDriftSnapshotMeta: mocks.readDriftSnapshotMeta,
  loadConfigChanges: mocks.loadConfigChanges,
  changeCursorOf: (row) => (row?.changeId ? `${row.detectedAt}|${row.changeId}` : (row?.detectedAt ?? null)),
  loadConfigChangeSummary: mocks.loadConfigChangeSummary,
  readEstateSnapshotMeta: mocks.readEstateSnapshotMeta,
  loadEstateValues: mocks.loadEstateValues,
  readBoardSnapshotMeta: mocks.readBoardSnapshotMeta,
  loadBoards: mocks.loadBoards,
  loadBoardColumns: mocks.loadBoardColumns,
  loadAssetSchemas: mocks.loadAssetSchemas,
  loadAssetObjectTypes: mocks.loadAssetObjectTypes,
  loadAssetAttributes: mocks.loadAssetAttributes,
  loadAssetTypeCounts: mocks.loadAssetTypeCounts,
  readAssetTypeCountMeta: mocks.readAssetTypeCountMeta,
  recordHealthSnapshot: mocks.recordHealthSnapshot,
  loadPriorHealthDimensions: mocks.loadPriorHealthDimensions,
  loadHealthHistory: mocks.loadHealthHistory,
  // Real values, not mocks: the resolver whitelists the sort token against these, so a
  // vi.fn() here would make every sort fall back to the default and hide a regression.
  DEFAULT_SCREEN_SORT: "fields-desc",
  SCREEN_SORT_KEYS: ["fields-desc", "fields-asc", "name-asc", "name-desc", "tabs-desc", "id-asc", "unresolved-first"],
  loadWorkflowSchemes: mocks.loadWorkflowSchemes,
  loadWorkflowSchemeProjects: mocks.loadWorkflowSchemeProjects,
  loadProjectWorkflowSchemeMap: mocks.loadProjectWorkflowSchemeMap,
  loadWorkflowSchemeForProject: mocks.loadWorkflowSchemeForProject,
  loadStatusesCatalog: mocks.loadStatusesCatalog,
  loadWorkflowSchemeStatuses: mocks.loadWorkflowSchemeStatuses,
  loadStatusIssueCounts: mocks.loadStatusIssueCounts,
  loadStatusHistoryCounts: mocks.loadStatusHistoryCounts,
  recordRemediationTicket: mocks.recordRemediationTicket,
  loadRemediationTickets: mocks.loadRemediationTickets,
  getRemediationEpic: mocks.getRemediationEpic,
  loadTicketedItemIds: mocks.loadTicketedItemIds,
  loadTicketedItems: mocks.loadTicketedItems,
  currentPeriod: mocks.currentPeriod,
  readUsageMeta: mocks.readUsageMeta,
  loadArchivedProjects: mocks.loadArchivedProjects,
  loadArchivedFieldUsage: mocks.loadArchivedFieldUsage,
  loadHierarchyNodes: mocks.loadHierarchyNodes,
  recordHierarchyNode: mocks.recordHierarchyNode,
  loadUsageTally: mocks.loadUsageTally,
  USAGE_PILLARS: { field: { basis: "updated" }, issuetype: { basis: "created" }, resolution: { basis: "resolved" } },
  USAGE_WINDOW_DAYS: 90,
}));

vi.mock("../lib/screen-engine.js", () => ({
  queueScreenSnapshotBuild: mocks.queueScreenSnapshotBuild,
  isScreenBuildStale: mocks.isScreenBuildStale,
}));

vi.mock("../lib/issuetype-engine.js", () => ({
  queueIssueTypeSnapshotBuild: mocks.queueIssueTypeSnapshotBuild,
  isIssueTypeBuildStale: mocks.isIssueTypeBuildStale,
}));

vi.mock("../lib/user-engine.js", () => ({
  queueUserSnapshotBuild: mocks.queueUserSnapshotBuild,
  isUserBuildStale: mocks.isUserBuildStale,
}));

vi.mock("../lib/asset-engine.js", () => ({
  queueAssetSnapshotBuild: mocks.queueAssetSnapshotBuild,
  isAssetBuildStale: mocks.isAssetBuildStale,
  queueAssetTypeCountBuild: mocks.queueAssetTypeCountBuild,
  isAssetTypeCountBuildStale: mocks.isAssetTypeCountBuildStale,
}));

vi.mock("../lib/access-engine.js", () => ({
  queueAccessSnapshotBuild: mocks.queueAccessSnapshotBuild,
  isAccessBuildStale: mocks.isAccessBuildStale,
}));

vi.mock("../lib/drift-engine.js", () => ({
  queueDriftSnapshotBuild: mocks.queueDriftSnapshotBuild,
  isDriftBuildStale: mocks.isDriftBuildStale,
  DRIFT_PILLARS: [
    { pillar: "fields", label: "Fields" },
    { pillar: "workflow", label: "Workflows" },
    { pillar: "issueTypes", label: "Issue types" },
    { pillar: "access", label: "Access" },
    { pillar: "estate", label: "Priorities & resolutions" },
    { pillar: "filters", label: "Saved filters" },
    { pillar: "dashboards", label: "Dashboards" },
  ],
}));

vi.mock("../lib/estate-engine.js", () => ({
  queueEstateSnapshotBuild: mocks.queueEstateSnapshotBuild,
  isEstateBuildStale: mocks.isEstateBuildStale,
}));

vi.mock("../lib/board-engine.js", () => ({
  queueBoardSnapshotBuild: mocks.queueBoardSnapshotBuild,
  isBoardBuildStale: mocks.isBoardBuildStale,
}));

vi.mock("../lib/fieldconfig-engine.js", () => ({
  queueFieldConfigSnapshotBuild: mocks.queueFieldConfigSnapshotBuild,
  isFieldConfigBuildStale: mocks.isFieldConfigBuildStale,
}));

vi.mock("../lib/fieldconfig-reads.js", () => ({
  getFieldConfigInventory: mocks.getFieldConfigInventory,
  getFieldConfigItems: vi.fn(),
  getFieldBehaviour: vi.fn(),
}));

vi.mock("../lib/workflow-engine.js", () => ({
  buildWorkflowSnapshot: mocks.buildWorkflowSnapshot,
  queueWorkflowSnapshotBuild: mocks.queueWorkflowSnapshotBuild,
  queueStatusHistoryBuild: mocks.queueStatusHistoryBuild,
  isWorkflowBuildStale: mocks.isWorkflowBuildStale,
}));

vi.mock("../lib/jira-api.js", () => ({
  METRIC_NAMES: {
    inventorySnapshot: "inventory-snapshot",
    resolver: "resolver",
    resolverFailed: "resolver-failed",
    rovoInspectField: "rovo-inspect-field",
    rovoSearchFields: "rovo-search-fields",
  },
  incrMetric: mocks.incrMetric,
  // The site URL remediation tickets link against; the normalizer is the real one's logic.
  getSiteBaseUrl: mocks.getSiteBaseUrl,
  normalizeSiteOrigin: (v) => {
    try {
      const u = new URL(String(v || ""));
      return u.protocol === "https:" ? u.origin : null;
    } catch {
      return null;
    }
  },
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
  createJiraIssue: mocks.createJiraIssue,
  transitionIssueWithComment: mocks.transitionIssueWithComment,
  updateJiraIssue: mocks.updateJiraIssue,
  getFieldProjectAssociations: mocks.getFieldProjectAssociations,
  searchIssuesPage: mocks.searchIssuesPage,
  getAllJiraProjects: mocks.getAllJiraProjects,
  probeEndpoint: mocks.probeEndpoint,
  getPermissionCatalog: mocks.getPermissionCatalog,
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

vi.mock("../lib/full-scan-runner.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual, // keeps the real, pure fullScanStageCatalog / quickScanStageCatalog
    recoverStalledScan: mocks.recoverStalledScan,
    resumeScanRun: mocks.resumeScanRun,
  };
});

vi.mock("../lib/snapshot-engine.js", async (importOriginal) => {
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

export function manyFieldIds(count) {
  return Array.from({ length: count }, (_, i) => `customfield_${i}`);
}

export function snapshotField(overrides = {}) {
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

// Every resolver test file calls this once: reset all mocks and restore the defaults below
// before each test, exactly as the single resolvers.test.js did.
export function installResolverTestDefaults() {
  beforeEach(async () => {
    // Dynamic, not a static import: a static one would load the mocked modules before `mocks`
    // above is defined.
    const { __clearMacroAccessCache } = await import("./macro-access.js");
    vi.clearAllMocks();
    __clearMacroAccessCache();
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
    mocks.getBrowsableProjectIds.mockImplementation(
      async (_accountId, projectIds) => new Set((projectIds || []).map(String)),
    );
    mocks.readWorkflowSnapshotMeta.mockResolvedValue(null);
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);
    // Default: no licensed-user roster. The People pillar then reports unavailable rather
    // than being scored on absent data, the same posture as screens and automation above.
    mocks.readUserSnapshotMeta.mockResolvedValue(null);
    // Default: no Assets snapshot. The Assets pillar reports unmeasured, same posture.
    mocks.readAssetSnapshotMeta.mockResolvedValue(null);
    // Default: no access snapshot. The three access pillars report unmeasured.
    mocks.readAccessSnapshotMeta.mockResolvedValue(null);
    // Default: no drift snapshot. getChangeHistory reports never-built.
    mocks.readDriftSnapshotMeta.mockResolvedValue(null);
    // Default: no estate snapshot. The estate pillar reports unmeasured.
    mocks.readEstateSnapshotMeta.mockResolvedValue(null);
    // Defaults the single file never declared: each was left behind by an earlier describe
    // (clearAllMocks keeps implementations), so later tests passed on leaked state. Split
    // into separate files they ran without it. Same "nothing built yet" posture as above.
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue(null);
    mocks.readAutomationPart.mockResolvedValue(null);
    mocks.loadScreensPage.mockResolvedValue({ total: 0, rows: [] });
    mocks.loadScreensForField.mockResolvedValue([]);
    mocks.loadScreenSchemes.mockResolvedValue([]);
    mocks.loadScreenSchemeOperations.mockResolvedValue([]);
    mocks.loadIssueTypeScreenSchemes.mockResolvedValue([]);
    mocks.loadScreenGovernanceSummary.mockResolvedValue({});
    mocks.loadScreenCountsForFields.mockResolvedValue({});
    mocks.loadScreenDistributions.mockResolvedValue({
      sizeBuckets: [],
      largestScreens: [],
      mostSharedFields: [],
      operationMix: [],
    });
    mocks.loadScreensForProject.mockResolvedValue([]);
    mocks.loadRulesForProject.mockResolvedValue([]);
    mocks.loadStatusAutomationReferences.mockResolvedValue({});
    mocks.loadGlobalRulesAffectingProject.mockResolvedValue([]);
    mocks.recordHealthSnapshot.mockResolvedValue({ recorded: true });
    mocks.loadHealthHistory.mockResolvedValue([]);
    mocks.queueScreenSnapshotBuild.mockResolvedValue(undefined);
    mocks.isScreenBuildStale.mockReturnValue(false);
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
}

export function ctxWithAccount(accountId = "user-1") {
  return { accountId };
}
