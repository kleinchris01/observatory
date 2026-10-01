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
  recordRemediationTicket: vi.fn(async () => undefined),
  loadRemediationTickets: vi.fn(async () => []),
  getRemediationEpic: vi.fn(async () => null),
  // Pinned so ticket summaries and period grouping are deterministic across the calendar.
  currentPeriod: vi.fn(() => "2026-Q3"),
  getSiteBaseUrl: vi.fn(async () => "https://test.atlassian.net"),
  loadTicketedItemIds: vi.fn(async () => new Set()),
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
  countFieldSummariesByStatus: vi.fn(async () => ({ counts: { queued: 0, building: 0, ready: 0, failed: 0, cancelled: 0, unbuilt: 0 }, total: 0 })),
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
  loadConfigChangeSummary: vi.fn(async () => ({ total: 0, byPillar: {}, byKind: { added: 0, removed: 0, modified: 0 } })),
  queueDriftSnapshotBuild: vi.fn(),
  isDriftBuildStale: vi.fn(() => false),

  // estate store + estate-engine.js
  readEstateSnapshotMeta: vi.fn(),
  loadEstateValues: vi.fn(async () => []),
  queueEstateSnapshotBuild: vi.fn(),
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
  AUTOMATION_PARTS: { analysis: "a:", fields: "f:", statuses: "s:", issueTypes: "it:", users: "u:", directory: "d:", findings: "fi:", cascades: "c:" },
  MAX_PREVIEW_FINDINGS: 20,
  MAX_STORED_CASCADES: 150,
  MAX_STORED_CROSS_RULE: 100,
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
  changeCursorOf: (row) => (row?.changeId ? `${row.detectedAt}|${row.changeId}` : row?.detectedAt ?? null),
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
  currentPeriod: mocks.currentPeriod,
}));

vi.mock("./lib/screen-engine.js", () => ({
  queueScreenSnapshotBuild: mocks.queueScreenSnapshotBuild,
  isScreenBuildStale: mocks.isScreenBuildStale,
}));

vi.mock("./lib/issuetype-engine.js", () => ({
  queueIssueTypeSnapshotBuild: mocks.queueIssueTypeSnapshotBuild,
  isIssueTypeBuildStale: mocks.isIssueTypeBuildStale,
}));

vi.mock("./lib/user-engine.js", () => ({
  queueUserSnapshotBuild: mocks.queueUserSnapshotBuild,
  isUserBuildStale: mocks.isUserBuildStale,
}));

vi.mock("./lib/asset-engine.js", () => ({
  queueAssetSnapshotBuild: mocks.queueAssetSnapshotBuild,
  isAssetBuildStale: mocks.isAssetBuildStale,
  queueAssetTypeCountBuild: mocks.queueAssetTypeCountBuild,
  isAssetTypeCountBuildStale: mocks.isAssetTypeCountBuildStale,
}));

vi.mock("./lib/access-engine.js", () => ({
  queueAccessSnapshotBuild: mocks.queueAccessSnapshotBuild,
  isAccessBuildStale: mocks.isAccessBuildStale,
}));

vi.mock("./lib/drift-engine.js", () => ({
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

vi.mock("./lib/estate-engine.js", () => ({
  queueEstateSnapshotBuild: mocks.queueEstateSnapshotBuild,
  isEstateBuildStale: mocks.isEstateBuildStale,
}));

vi.mock("./lib/board-engine.js", () => ({
  queueBoardSnapshotBuild: mocks.queueBoardSnapshotBuild,
  isBoardBuildStale: mocks.isBoardBuildStale,
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
  // The site URL remediation tickets link against; the normalizer is the real one's logic.
  getSiteBaseUrl: mocks.getSiteBaseUrl,
  normalizeSiteOrigin: (v) => { try { const u = new URL(String(v || "")); return u.protocol === "https:" ? u.origin : null; } catch { return null; } },
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

vi.mock("./lib/full-scan-runner.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual, // keeps the real, pure fullScanStageCatalog / quickScanStageCatalog
    recoverStalledScan: mocks.recoverStalledScan,
    resumeScanRun: mocks.resumeScanRun,
  };
});

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
  withMacroAccessGuard,
  MacroAccessError,
  __clearMacroAccessCache,
  readAdminConfig,
  recordQuickScanScheduledRun,
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
  rovoBoardSearch,
  rovoBoardInspect,
  rovoBoardImpact,
  migrateNamespaceKeys,
  CLEAR_SNAPSHOT_CONFIRMATION,
  __RAW_ADMIN_ONLY_FUNCTIONS,
  __resetAdminCheckCache,
  AdminPermissionError,
  isScanStuck,
  // Not a resolver -- it runs inside the health stage of a scan, so it is imported
  // directly rather than pulled out of a resolver registry.
  computeAndStoreScreenCross,
  getFirstRunState,
  setFirstRunState,
} from "./resolvers.js";

const {
  saveReportDefinition,
  startProjectUsageReportJob,
  getAutomationInsights,
  saveAutomationAnalysis,
  getAutomationIndex,
  saveAutomationIndex,
  getFilterInventory,
  buildFilterInventory,
  startFullSiteScan,
  getFullScanStatus,
  startQuickSiteScan,
  getQuickScanStatus,
  resumeSiteScan,
  cancelSiteScan,
  getDashboardUsage,
  getFilterUsage,
  getFieldFilterCounts,
  getFieldDashboardCounts,
  getDashboardInventory,
  buildDashboardInventory,
  getAutomationCascades,
  getCascadeGraph,
  getAutomationBlast,
  createRemediationEpic,
  syncRemediationNow,
  getRemediationTickets,
  getRemediationMetrics,
  getRemediationCandidates,
  getStatusAutomationUsage,
  getAutomationFieldUsage,
  getAutomationFieldCounts,
  getScreenInventory,
  getFieldScreenReachability,
  getFieldScreenCounts,
  getHealthHistory,
  getProjectOverview,
  getPillarHealth,
  getPillarReport,
  runOqlQuery,
  buildScreenInventory,
  getIssueTypeInventory,
  buildIssueTypeInventory,
  getUserInventory,
  getUserDetails,
  buildUserInventory,
  getAssetInventory,
  buildAssetInventory,
  buildAssetTypeCountCrawl,
  getAccessInventory,
  buildAccessInventory,
  getChangeHistory,
  buildChangeHistory,
  getEstateInventory,
  buildEstateInventory,
  getBoardInventory,
  buildBoardInventory,
  probeGlobalPermissions,
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
  getScreenFieldReportInputs,
  getDeletionSafety,
  getScreenFieldCrossSignal,
  getProjectScreenReportInputs,
  getMacroFilters,
  getMacroScreens,
  getMacroIssueTypes,
  getMacroBoards,
  getMacroDashboards,
  getMacroWorkflows,
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
  mocks.getBrowsableProjectIds.mockImplementation(async (_accountId, projectIds) => new Set((projectIds || []).map(String)));
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
  mocks.loadScreensPage.mockResolvedValue({ total: 0, rows: [] });
  mocks.loadScreensForField.mockResolvedValue([]);
  mocks.loadScreenSchemes.mockResolvedValue([]);
  mocks.loadScreenSchemeOperations.mockResolvedValue([]);
  mocks.loadIssueTypeScreenSchemes.mockResolvedValue([]);
  mocks.loadScreenGovernanceSummary.mockResolvedValue({});
  mocks.loadScreenCountsForFields.mockResolvedValue({});
  mocks.loadScreenDistributions.mockResolvedValue({ sizeBuckets: [], largestScreens: [], mostSharedFields: [], operationMix: [] });
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
    expect(result).toMatchObject({ allowed: true });
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
    expect(result).toMatchObject({ allowed: true });
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
    expect(result).toMatchObject({ allowed: true });
  });

  test("fails open (allows) when reading admin config throws", async () => {
    mocks.kvsGet.mockRejectedValue(new Error("kvs unavailable"));
    const result = await checkMacroAccess({ context: { accountId: "user-1" } });
    expect(result).toMatchObject({ allowed: true });
  });
});

// The macro's group restriction used to be enforced only by the page asking
// checkMacroAccess first. Every macro read now passes through the same decision.
describe("withMacroAccessGuard", () => {
  const restricted = { macroAccess: { restrictAccess: true, allowedGroups: ["jira-admins"] } };
  const inner = vi.fn(async () => ({ rows: ["data"] }));
  const guarded = () => withMacroAccessGuard({ getMacroFields: inner, checkMacroAccess: vi.fn(async () => "check") });

  test("lets every call through when the restriction is off", async () => {
    mocks.kvsGet.mockResolvedValueOnce({ macroAccess: { restrictAccess: false } });
    await expect(guarded().getMacroFields({ context: { accountId: "u" } })).resolves.toEqual({ rows: ["data"] });
    expect(mocks.apiAsAppRequestJira).not.toHaveBeenCalled();
  });

  test("refuses a direct read from a viewer outside the allowed groups", async () => {
    mocks.kvsGet.mockResolvedValue(restricted);
    mocks.apiAsAppRequestJira.mockResolvedValueOnce({ ok: true, json: async () => [{ name: "other" }] });
    await expect(guarded().getMacroFields({ context: { accountId: "u" } })).rejects.toBeInstanceOf(MacroAccessError);
    expect(inner).not.toHaveBeenCalled();
  });

  test("refuses an anonymous caller when restricted", async () => {
    mocks.kvsGet.mockResolvedValue(restricted);
    await expect(guarded().getMacroFields({ context: {} })).rejects.toThrow(/sign in/i);
  });

  test("serves a viewer in an allowed group, and asks Jira once per minute, not per call", async () => {
    mocks.kvsGet.mockResolvedValue(restricted);
    mocks.apiAsAppRequestJira.mockResolvedValue({ ok: true, json: async () => [{ name: "jira-admins" }] });
    const fns = guarded();
    await fns.getMacroFields({ context: { accountId: "u" } });
    await fns.getMacroFields({ context: { accountId: "u" } });
    expect(inner).toHaveBeenCalledTimes(2);
    expect(mocks.apiAsAppRequestJira).toHaveBeenCalledTimes(1);
  });

  // The documented accepted risk (SECURITY_CHECKLIST 1.3): a failed lookup grants access.
  test("fails open when the group lookup errors, as the checklist documents", async () => {
    mocks.kvsGet.mockResolvedValue(restricted);
    mocks.apiAsAppRequestJira.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(guarded().getMacroFields({ context: { accountId: "u" } })).resolves.toEqual({ rows: ["data"] });
  });

  test("leaves checkMacroAccess itself unguarded so a denied viewer can be told why", async () => {
    mocks.kvsGet.mockResolvedValue(restricted);
    mocks.apiAsAppRequestJira.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await expect(guarded().checkMacroAccess({ context: { accountId: "u" } })).resolves.toBe("check");
  });

  test("wraps every shared function", () => {
    const wrapped = withMacroAccessGuard(SHARED_RESOLVER_FUNCTIONS);
    expect(Object.keys(wrapped).sort()).toEqual(Object.keys(SHARED_RESOLVER_FUNCTIONS).sort());
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

  test("attaches the field x user usage, with roster names and a not-licensed flag", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotField.mockResolvedValue(snapshotField());
    mocks.loadSnapshotProjectUsage.mockResolvedValue([]);
    mocks.countSnapshotProjectUsage.mockResolvedValue(0);
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    mocks.loadFieldUserUsage.mockResolvedValue({
      distinctUsers: 2, issueTotal: 12,
      top: [
        { accountId: "acc-1", displayName: "stale name", issueCount: 10 },
        { accountId: "acc-gone", displayName: "Ghost", issueCount: 2 },
      ],
    });
    mocks.readUserSnapshotMeta.mockResolvedValue({ version: "u1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "acc-1", displayName: "Ann Admin" }]);

    const result = await getFieldDetails({ payload: { fieldId: "customfield_10001" }, context: {} });

    expect(result.userValueUsage.distinctUsers).toBe(2);
    expect(result.userValueUsage.top[0]).toMatchObject({ displayName: "Ann Admin", onRoster: true });
    expect(result.userValueUsage.top[1]).toMatchObject({ displayName: "Ghost", onRoster: false });
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

  test("validates the quick-scan schedule's frequency, day, hour, and window", async () => {
    await expect(saveAdminConfigResolver({ payload: { quickScanSchedule: { frequency: "hourly" } } }))
      .rejects.toThrow(/quickScanSchedule\.frequency/);
    await expect(saveAdminConfigResolver({ payload: { quickScanSchedule: { dayOfWeek: 9 } } }))
      .rejects.toThrow(/quickScanSchedule\.dayOfWeek/);
    await expect(saveAdminConfigResolver({ payload: { quickScanSchedule: { hourUtc: 24 } } }))
      .rejects.toThrow(/quickScanSchedule\.hourUtc/);
    await expect(saveAdminConfigResolver({ payload: { quickScanSchedule: { windowHours: 0 } } }))
      .rejects.toThrow(/quickScanSchedule\.windowHours/);
  });

  test("rejects a remediation project key that is not a Jira key", async () => {
    await expect(saveAdminConfigResolver({ payload: { remediation: { projectKey: "not a key!" } } }))
      .rejects.toThrow(/remediation\.projectKey/);
    await expect(saveAdminConfigResolver({ payload: { remediation: { epicIssueType: 123 } } }))
      .rejects.toThrow(/remediation\.epicIssueType/);
  });

  test("accepts and merges a valid remediation config, keeping the rest", async () => {
    mocks.kvsGet.mockResolvedValue({ remediation: { projectKey: "OLD", epicIssueType: "Epic", taskIssueType: "Task", defaultAssigneeAccountId: "" } });
    const result = await saveAdminConfigResolver({ payload: { remediation: { projectKey: "ADMIN" } } });
    expect(result.config.remediation).toMatchObject({ projectKey: "ADMIN", epicIssueType: "Epic", taskIssueType: "Task" });
  });

  test("an empty remediation project key is allowed — it just disables the feature", async () => {
    const result = await saveAdminConfigResolver({ payload: { remediation: { projectKey: "" } } });
    expect(result.ok).toBe(true);
  });

  test("merges a partial schedule update over the stored one, keeping the rest", async () => {
    mocks.kvsGet.mockResolvedValue({ quickScanSchedule: { enabled: true, frequency: "weekly", dayOfWeek: 3, hourUtc: 6, windowHours: 168 } });

    const result = await saveAdminConfigResolver({ payload: { quickScanSchedule: { hourUtc: 12 } } });

    // Only hourUtc was sent; everything else the admin already configured must survive.
    expect(result.config.quickScanSchedule).toMatchObject({ enabled: true, frequency: "weekly", dayOfWeek: 3, hourUtc: 12, windowHours: 168 });
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

  // The automation staleness gate is only a gate while its threshold is inside a sane band.
  // Zero would mark every analysis stale and silence the pillar; a very large value would
  // silence the warning instead, which is the same as deleting it.
  test("rejects an automation staleness threshold outside 1-90 days", async () => {
    for (const bad of [0, -1, 365]) {
      await expect(saveAdminConfigResolver({ payload: { automationStaleAfterDays: bad } }))
        .rejects.toThrow(/automationStaleAfterDays/);
    }
  });

  test("accepts and stores a tuned automation staleness threshold", async () => {
    mocks.kvsGet.mockResolvedValue(null);
    const result = await saveAdminConfigResolver({ payload: { automationStaleAfterDays: 14 } });
    expect(result.config.automationStaleAfterDays).toBe(14);
  });

  test("clamps a stored staleness threshold that reached storage some other way", async () => {
    // An older build, or a hand-edited record. Validation only guards the write path.
    mocks.kvsGet.mockResolvedValue({ automationStaleAfterDays: 9999 });
    const result = await saveAdminConfigResolver({ payload: {} });
    expect(result.config.automationStaleAfterDays).toBe(90);
  });

  test("defaults the staleness threshold rather than disabling the gate on a junk value", async () => {
    mocks.kvsGet.mockResolvedValue({ automationStaleAfterDays: "soon" });
    const result = await saveAdminConfigResolver({ payload: {} });
    expect(result.config.automationStaleAfterDays).toBe(7);
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
  test("surfaces the job-status counts without loading the summaries", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", totalFields: 10, processedFields: 10 });
    mocks.countFieldSummariesByStatus.mockResolvedValue({
      counts: { queued: 0, building: 1, ready: 2, failed: 1, cancelled: 0, unbuilt: 0 },
      total: 4,
    });
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);

    const result = await getAdminOverview({ context: {} });

    expect(result.jobCounts).toEqual({ queued: 0, building: 1, ready: 2, failed: 1, cancelled: 0, unbuilt: 0 });
    expect(result.totalSummaries).toBe(4);
    // The point of the change: the landing page used to pull up to 5,000 rows, including two
    // LONGTEXT columns, to produce those six integers.
    expect(mocks.listFieldSummaries).not.toHaveBeenCalled();
  });

  test("still renders when the count query fails", async () => {
    // A failed aggregate must not blank the overview -- it degrades to zeroes, the same way
    // a failed summaries load used to degrade to an empty array.
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.countFieldSummariesByStatus.mockRejectedValueOnce(new Error("sql down"));
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);

    const result = await getAdminOverview({ context: {} });

    expect(result.jobCounts).toEqual({ queued: 0, building: 0, ready: 0, failed: 0, cancelled: 0, unbuilt: 0 });
    expect(result.totalSummaries).toBe(0);
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

  // The Overview promotes several specific reasons to their own cards now (mirroring how
  // filters and dashboards already split "no live owner" from "shared with everyone"
  // instead of lumping every reason into one number) -- each of those needs its own count,
  // not just the four coarse categories findingsSummary already carries.
  test("also returns a count per specific finding code, not just the four coarse categories", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    // No description, and used broadly enough to cross missing-description's threshold.
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField({ activeProjectCount: 6, totalIssueCount: 600 })]);

    const result = await getAdminOverview({ context: {} });

    expect(result.findingsByCode).toEqual(expect.objectContaining({ "missing-description": 1 }));
  });


  // ── Screens and automation reach the Overview ─────────────────────────────
  //
  // Both pillars were analysed and then withheld from the page that exists to surface
  // them: screens were never loaded at all, and automation was trimmed to three fields
  // before it left the resolver, so the findings list could not see a single one of the
  // counts the health score was being computed from.

  test("carries the screen governance summary into the payload and the score", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readScreenSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1", refreshedAt: "2026-08-13T00:00:00Z" });
    mocks.loadScreenGovernanceSummary.mockResolvedValue({
      totalScreens: 760, emptyScreens: 12, unresolvedScreens: 3, unreachedScreens: 40,
      totalOperations: 240, danglingOperations: 24, totalSchemes: 60, unusedSchemes: 7,
    });

    const result = await getAdminOverview({ context: {} });

    expect(result.screens.available).toBe(true);
    expect(result.screens.danglingOperations).toBe(24);
    const integrity = result.health.dimensions.find((d) => d.key === "screen-integrity");
    expect(integrity.available).toBe(true);
    expect(integrity.score).toBe(0); // 24/240 is the tolerance exactly
  });

  test("reports screens unavailable rather than failing the overview when no build exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);

    const result = await getAdminOverview({ context: {} });

    expect(result.screens.available).toBe(false);
    expect(mocks.loadScreenGovernanceSummary).not.toHaveBeenCalled();
    expect(result.health.dimensions.find((d) => d.key === "screen-hygiene").available).toBe(false);
  });

  // Same posture as buildWorkflowOverview: one optional pillar failing must not 500 an
  // overview that has four others to show.
  test("survives a screen summary that throws", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readScreenSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadScreenGovernanceSummary.mockRejectedValueOnce(new Error("Unknown SQL execution error"));

    const result = await getAdminOverview({ context: {} });

    expect(result.screens).toEqual({ available: false, state: "error" });
    expect(result.health).toBeDefined();
  });

  test("carries the people overview into the payload and the score", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "u1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.loadUserGovernanceSummary.mockResolvedValue({ totalUsers: 200, activeUsers: 180 });

    const result = await getAdminOverview({ context: {} });

    expect(result.users.available).toBe(true);
    expect(result.users.deactivatedUsers).toBe(20);
    const hygiene = result.health.dimensions.find((d) => d.key === "user-licence-hygiene");
    expect(hygiene.available).toBe(true);
  });

  test("reports people unavailable rather than failing the overview when no roster exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readUserSnapshotMeta.mockResolvedValue(null);

    const result = await getAdminOverview({ context: {} });

    expect(result.users.available).toBe(false);
    expect(result.health.dimensions.find((d) => d.key === "user-licence-hygiene").available).toBe(false);
  });

  test("carries the assets overview into the payload and the score", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "ready", version: "as1", assetsEnabled: true, refreshedAt: "2026-09-02T00:00:00Z" });
    mocks.loadAssetSchemas.mockResolvedValue([
      { id: "1", name: "Infra", objectTypeCount: 2, objectCount: 40 },
      { id: "2", name: "Empty", objectTypeCount: 0, objectCount: 0 },
    ]);
    mocks.loadAssetObjectTypes.mockResolvedValue([{ id: "9", schemaId: "1", name: "Server", parentId: null, abstract: false }]);
    mocks.loadAssetAttributes.mockResolvedValue([{ id: "a", objectTypeId: "9", name: "OS", referenceObjectTypeId: null, system: false }]);

    const result = await getAdminOverview({ context: {} });

    expect(result.assets.available).toBe(true);
    expect(result.assets.deadSchemaCount).toBe(1);
    expect(result.health.dimensions.find((d) => d.key === "asset-schema-hygiene").available).toBe(true);
  });

  test("reports assets not-applicable rather than failing the overview when Assets is off", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "unavailable", assetsEnabled: false });

    const result = await getAdminOverview({ context: {} });

    expect(result.assets.assetsEnabled).toBe(false);
    expect(result.health.dimensions.find((d) => d.key === "asset-reference-integrity").available).toBe(false);
  });

  test("passes the whole automation health summary through, not just the rule count", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readAutomationAnalysis.mockResolvedValue({
      refreshedAt: 123,
      estate: {
        health: {
          available: true, ruleCount: 1479, disabledCount: 604, credentialRuleCount: 3,
          externalHttpCount: 22, noActionCount: 8, selfTriggeringCount: 88,
        },
      },
    });

    const result = await getAdminOverview({ context: {} });

    // Every count the findings list needs, not the {available, refreshedAt, ruleCount}
    // triple this used to be flattened to.
    expect(result.automation).toEqual(expect.objectContaining({
      available: true, ruleCount: 1479, credentialRuleCount: 3,
      selfTriggeringCount: 88, externalHttpCount: 22, noActionCount: 8, disabledCount: 604,
      refreshedAt: 123,
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

  test("narrows the matrix to a project scope, keeping scoped projects with no usage as zero columns", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1" }));
    mocks.loadAllSnapshotProjectUsage.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 5 },
      { projectId: "99", projectKey: "ZZZ", projectName: "Zeta", issueCount: 40 }, // out of scope
    ]);
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.getDistinctIssueCountForFields.mockResolvedValue(5);
    // Scope is {10, 11}; project 11 has no usage row but must still be a column.
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha" },
      { projectId: "11", projectKey: "BBB", projectName: "Bravo" },
      { projectId: "99", projectKey: "ZZZ", projectName: "Zeta" },
    ]);

    const result = await getProjectUsageReport({ payload: { fieldIds: ["customfield_1"], projectIds: ["10", "11"] }, context: {} });

    expect(result.projects.map((p) => p.projectId).sort()).toEqual(["10", "11"]);
    expect(result.fields[0].projects.map((p) => p.projectId)).toEqual(["10"]);
    // The per-field total is recomputed from what is left, not the site-wide sum.
    expect(result.fields[0].totalIssueCount).toBe(5);
    expect(result.fields[0].activeProjectCount).toBe(1);
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

  test("returns the cross-rule totals and lists the analysis stored", async () => {
    mocks.readAutomationAnalysis.mockResolvedValueOnce({
      ...doc,
      eventCascades: [{ sourceId: 1, targetId: 2 }],
      eventCascadesTotal: 3,
      competingPairs: [],
      competingPairsTotal: 0,
      fieldContradictions: [{ field: "Priority" }],
      fieldContradictionsTotal: 1,
    });

    const result = await getAutomationInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.eventCascadesTotal).toBe(3);
    expect(result.eventCascades).toHaveLength(1);
    expect(result.competingPairsTotal).toBe(0);
    expect(result.fieldContradictionsTotal).toBe(1);
  });

  // An analysis saved before these checks were stored was never measured for them. Zero
  // would claim the rules were checked and found clean.
  test("reports the cross-rule totals as null on an analysis that predates them", async () => {
    mocks.readAutomationAnalysis.mockResolvedValueOnce(doc);

    const result = await getAutomationInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.eventCascadesTotal).toBeNull();
    expect(result.competingPairsTotal).toBeNull();
    expect(result.fieldContradictionsTotal).toBeNull();
    expect(result.eventCascades).toEqual([]);
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

  // The three cross-rule checks were computed by the analysis and then dropped on save, so
  // their tiles read 0 on every site. Totals describe the estate; lists are capped.
  test("keeps the cross-rule totals and capped lists", async () => {
    const pairs = Array.from({ length: 140 }, (_, i) => ({ a: i, b: i + 1 }));
    await saveAutomationAnalysis({
      payload: {
        analysis: {
          ...valid,
          eventCascades: [{ sourceId: 1, targetId: 2 }],
          eventCascadesTotal: 4,
          competingPairs: pairs,
          competingPairsTotal: 140,
          fieldContradictions: [],
          fieldContradictionsTotal: 0,
        },
      },
      context: ctxWithAccount(),
    });

    const [, stored] = mocks.writeAutomationAnalysis.mock.calls[0];
    expect(stored.eventCascadesTotal).toBe(4);
    expect(stored.eventCascades).toHaveLength(1);
    expect(stored.competingPairsTotal).toBe(140);
    expect(stored.competingPairs).toHaveLength(100);
    expect(stored.fieldContradictionsTotal).toBe(0);
    expect(stored.fieldContradictions).toEqual([]);
  });

  test("leaves a cross-rule check unmeasured when the payload carries no list", async () => {
    await saveAutomationAnalysis({ payload: { analysis: valid }, context: ctxWithAccount() });

    const [, stored] = mocks.writeAutomationAnalysis.mock.calls[0];
    expect(stored).not.toHaveProperty("eventCascadesTotal");
    expect(stored).not.toHaveProperty("competingPairsTotal");
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

  test("coerces the blast rollup and caps its top list", async () => {
    const blast = {
      available: true,
      total: 1477,
      byTier: { estate: 12, "cross-project": 40, project: 300, contained: 1125, junk: 9 },
      estateWideCount: 12,
      estateWideShare: 12 / 1477,
      estateWideCredentialCount: "3",
      estimatedCount: 1477,
      top: Array.from({ length: 40 }, (_, i) => ({ ruleId: i, score: `${i}`, tier: "estate" })),
    };
    await saveAutomationAnalysis({ payload: { analysis: { ...valid, blast } }, context: ctxWithAccount() });

    const [, stored] = mocks.writeAutomationAnalysis.mock.calls[0];
    expect(stored.blast.byTier).toEqual({ estate: 12, "cross-project": 40, project: 300, contained: 1125 });
    expect(stored.blast.estateWideCredentialCount).toBe(3);
    expect(stored.blast.top).toHaveLength(20);
    expect(stored.blast.top[0]).toEqual({ ruleId: "0", score: 0, tier: "estate" });
  });

  test("a missing or malformed blast rollup stores null rather than throwing", async () => {
    for (const bad of [undefined, null, "nope", [1, 2], { total: 5, top: "not-an-array" }]) {
      mocks.writeAutomationAnalysis.mockClear();
      await saveAutomationAnalysis({ payload: { analysis: { ...valid, blast: bad } }, context: ctxWithAccount() });
      const [, stored] = mocks.writeAutomationAnalysis.mock.calls[0];
      if (bad && typeof bad === "object" && !Array.isArray(bad)) {
        expect(stored.blast.top).toEqual([]);
      } else {
        expect(stored.blast).toBeNull();
      }
    }
  });
});

describe("saveAutomationIndex", () => {
  beforeEach(() => {
    mocks.writeAutomationPart.mockResolvedValue(undefined);
  mocks.loadAutomationReferencesFor.mockResolvedValue({ references: [], total: 0, ruleCount: 0 });
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

  // The SQL shred. Each part routes to a different writer, and none of them may fail the
  // import: the KVS write has already succeeded and is what the tab still renders.
  describe("shredding into SQL", () => {
    beforeEach(() => {
      mocks.writeAutomationPart.mockResolvedValue(undefined);
      mocks.replaceAutomationReferences.mockResolvedValue(4);
      mocks.replaceAutomationRules.mockResolvedValue(2);
      mocks.replaceAutomationFindings.mockResolvedValue(3);
      mocks.readAutomationPart.mockResolvedValue(null);
    });

    // A reference row needs both indexes, because fields and statuses share one table and
    // the write replaces the whole scope. Saving one part must not erase the other.
    test.each([["fields"], ["statuses"]])("routes %s through the reference writer with both indexes", async (part) => {
      const other = { schemaVersion: 1, entries: [{ label: "Other", write: ["7"] }] };
      mocks.readAutomationPart.mockResolvedValue(other);
      const doc = { schemaVersion: 1, entries: [{ label: "A", write: ["1"] }] };

      const result = await saveAutomationIndex({ payload: { part, document: doc }, context: ctxWithAccount() });

      expect(mocks.replaceAutomationReferences).toHaveBeenCalledWith(expect.any(String), {
        fields: part === "fields" ? doc : other,
        statuses: part === "statuses" ? doc : other,
      });
      expect(result.rowsWritten).toBe(4);
    });

    test("routes the directory through the rule writer", async () => {
      const doc = { schemaVersion: 1, rules: [["1", "Rule", 1, "manual", 0]] };
      const result = await saveAutomationIndex({ payload: { part: "directory", document: doc }, context: ctxWithAccount() });
      expect(mocks.replaceAutomationRules).toHaveBeenCalledWith(expect.any(String), doc);
      expect(mocks.replaceAutomationReferences).not.toHaveBeenCalled();
      expect(result.rowsWritten).toBe(2);
    });

    test("routes findings through the findings writer", async () => {
      const doc = { schemaVersion: 1, findings: [{ id: 1, r: [{ c: "x", s: "high" }] }] };
      const result = await saveAutomationIndex({ payload: { part: "findings", document: doc }, context: ctxWithAccount() });
      expect(mocks.replaceAutomationFindings).toHaveBeenCalledWith(expect.any(String), doc);
      expect(result.rowsWritten).toBe(3);
    });

    test("routes the blast part through the blast writer and never touches KVS for it", async () => {
      mocks.replaceAutomationBlast.mockResolvedValue(7);
      const doc = { schemaVersion: 1, rules: [{ id: "1", score: 88, tier: "estate" }] };
      const result = await saveAutomationIndex({ payload: { part: "blast", document: doc }, context: ctxWithAccount() });
      expect(mocks.replaceAutomationBlast).toHaveBeenCalledWith(expect.any(String), doc);
      expect(mocks.writeAutomationPart).not.toHaveBeenCalledWith(expect.any(String), "blast", expect.anything());
      expect(result.rowsWritten).toBe(7);
    });

    test("a SQL failure on the blast part fails the import — there is no KVS copy behind it", async () => {
      mocks.replaceAutomationBlast.mockRejectedValue(new Error("sql down"));
      await expect(
        saveAutomationIndex({ payload: { part: "blast", document: { schemaVersion: 1, rules: [] } }, context: ctxWithAccount() })
      ).rejects.toThrow("sql down");
    });

    // The whole point of best-effort: SQL is the secondary copy while the UI still reads
    // KVS, so losing it must degrade the index, never the import.
    test("still reports the import saved when the SQL shred throws", async () => {
      mocks.replaceAutomationRules.mockRejectedValue(new Error("sql down"));
      const result = await saveAutomationIndex({
        payload: { part: "directory", document: { schemaVersion: 1, rules: [] } },
        context: ctxWithAccount(),
      });
      expect(result).toMatchObject({ saved: true, part: "directory" });
      expect(mocks.writeAutomationPart).toHaveBeenCalled();
    });
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

  // A rule that creates an issue of a type names it by numeric id, so the issue-type index
  // arrives half-labelled with "10022". Resolved against the inventory on read.
  test("resolves issue-type id labels to names from the inventory", async () => {
    mocks.readAutomationPart.mockResolvedValue({
      schemaVersion: 1, total: 2, entries: [
        { label: "10022", writeCount: 3, readCount: 0, triggerCount: 0, total: 3, ruleCount: 3, write: ["r1", "r2", "r3"], read: [], trigger: [] },
        { label: "current", writeCount: 1, readCount: 0, triggerCount: 0, total: 1, ruleCount: 1, write: ["r9"], read: [], trigger: [] },
      ],
    });
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadIssueTypes.mockResolvedValue([{ id: "10022", name: "Incident" }, { id: "10000", name: "Bug" }]);

    const result = await getAutomationIndex({ payload: { part: "issueTypes" }, context: ctxWithAccount() });

    const labels = result.entries.map((e) => e.label);
    expect(labels).toContain("Incident");
    expect(labels).not.toContain("10022");
    // A label that is not a known id -- a smart-value literal -- is left alone.
    expect(labels).toContain("current");
  });

  test("merges an issue type referenced once by id and once by name", async () => {
    mocks.readAutomationPart.mockResolvedValue({
      schemaVersion: 1, total: 2, entries: [
        { label: "10022", writeCount: 2, readCount: 0, triggerCount: 0, total: 2, ruleCount: 2, write: ["r1", "r2"], read: [], trigger: [] },
        { label: "Incident", writeCount: 0, readCount: 1, triggerCount: 0, total: 1, ruleCount: 1, write: [], read: ["r3"], trigger: [] },
      ],
    });
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadIssueTypes.mockResolvedValue([{ id: "10022", name: "Incident" }]);

    const result = await getAutomationIndex({ payload: { part: "issueTypes" }, context: ctxWithAccount() });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ label: "Incident", writeCount: 2, readCount: 1, total: 3, ruleCount: 3 });
    expect(result.total).toBe(1);
  });

  test("leaves the issue-type index untouched when no inventory has been built", async () => {
    mocks.readAutomationPart.mockResolvedValue({
      schemaVersion: 1, total: 1, entries: [{ label: "10022", writeCount: 1, readCount: 0, triggerCount: 0, total: 1, write: ["r1"], read: [], trigger: [] }],
    });
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue(null);

    const result = await getAutomationIndex({ payload: { part: "issueTypes" }, context: ctxWithAccount() });

    expect(result.entries[0].label).toBe("10022");
    expect(mocks.loadIssueTypes).not.toHaveBeenCalled();
  });

  test("resolves user-index accountId labels to display names from the roster", async () => {
    mocks.readAutomationPart.mockResolvedValue({
      schemaVersion: 1, total: 2, entries: [
        { label: "acc-1", writeCount: 4, readCount: 0, triggerCount: 0, total: 4, ruleCount: 4, write: ["r1", "r2", "r3", "r4"], read: [], trigger: [] },
        { label: "acc-gone", writeCount: 1, readCount: 0, triggerCount: 0, total: 1, ruleCount: 1, write: ["r9"], read: [], trigger: [] },
      ],
    });
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "acc-1", displayName: "Ann Admin" }]);

    const result = await getAutomationIndex({ payload: { part: "users" }, context: ctxWithAccount() });

    const labels = result.entries.map((e) => e.label);
    expect(labels).toContain("Ann Admin");
    // An account not on the roster is left as its id -- an orphaned reference.
    expect(labels).toContain("acc-gone");
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

// SQL is now the primary read for a single field's automation usage. These cover the
// boundary between it and the documents, which is where the risk is: an install that
// imported before the tables existed has KVS copies and no rows, and must not be told
// "not referenced" -- that is precisely the false reassurance this pillar exists to stop.
describe("getAutomationFieldUsage storage path", () => {
  const sqlRows = {
    total: 3,
    ruleCount: 2,
    references: [
      { direction: "write", rule_id: "1", name: "Set points", enabled: 1 },
      { direction: "read", rule_id: "2", name: "Check points", enabled: 0 },
      { direction: "trigger", rule_id: "1", name: "Set points", enabled: 1 },
    ],
  };

  test("answers from SQL when rows exist, without reading the documents", async () => {
    mocks.loadAutomationReferencesFor.mockResolvedValue(sqlRows);
    const result = await getAutomationFieldUsage({ payload: { fieldName: "Story Points" }, context: ctxWithAccount() });

    expect(result).toMatchObject({ available: true, referenced: true, source: "sql" });
    expect(result.write.count).toBe(1);
    expect(result.read.rules[0].name).toBe("Check points");
    expect(mocks.readAutomationPart).not.toHaveBeenCalled();
  });

  // A disabled rule is not currently a dependency, and that distinction has to survive
  // the move from documents to rows.
  test("carries enabled state through from the join", async () => {
    mocks.loadAutomationReferencesFor.mockResolvedValue(sqlRows);
    const result = await getAutomationFieldUsage({ payload: { fieldName: "Story Points" }, context: ctxWithAccount() });
    expect(result.write.rules[0].enabled).toBe(true);
    expect(result.read.rules[0].enabled).toBe(false);
  });

  test("falls back to the documents when SQL has no rows for the label", async () => {
    mocks.loadAutomationReferencesFor.mockResolvedValue({ references: [], total: 0, ruleCount: 0 });
    mocks.readAutomationPart.mockImplementation((_k, part) =>
      part === "fields"
        ? { schemaVersion: 1, entries: [{ label: "Story Points", write: ["9"], writeCount: 1, read: [], trigger: [] }] }
        : { schemaVersion: 1, rules: [["9", "Legacy rule", 1, "manual", 0]] }
    );

    const result = await getAutomationFieldUsage({ payload: { fieldName: "Story Points" }, context: ctxWithAccount() });
    expect(result).toMatchObject({ referenced: true, source: "kvs" });
    expect(result.write.rules[0].name).toBe("Legacy rule");
  });

  // A SQL outage must degrade to the documents, not to a wrong answer.
  test("falls back to the documents when the SQL read throws", async () => {
    mocks.loadAutomationReferencesFor.mockRejectedValue(new Error("sql down"));
    mocks.readAutomationPart.mockImplementation((_k, part) =>
      part === "fields" ? { schemaVersion: 1, entries: [] } : null
    );

    const result = await getAutomationFieldUsage({ payload: { fieldName: "Story Points" }, context: ctxWithAccount() });
    expect(result).toMatchObject({ available: true, referenced: false });
  });

  // With neither rows nor a document there is no analysis at all, which is a different
  // claim from "no rule touches this".
  test("still reports no-analysis rather than not-referenced when nothing exists", async () => {
    mocks.loadAutomationReferencesFor.mockResolvedValue({ references: [], total: 0, ruleCount: 0 });
    mocks.readAutomationPart.mockResolvedValue(null);

    const result = await getAutomationFieldUsage({ payload: { fieldName: "Story Points" }, context: ctxWithAccount() });
    expect(result).toMatchObject({ available: false, reason: "no-analysis" });
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

  // Relative to now, not a fixed epoch. These actions now gate their answers on how old the
  // analysis is, so a hardcoded 2025 timestamp would make every one of them report "unknown"
  // and the tests below would be exercising the degraded path while claiming to test the
  // normal one. Stale and truncated are asserted deliberately, further down.
  const FRESH = () => Date.now() - 2 * 86400000;

  function stubAll({ analysis = { schemaVersion: 1, refreshedAt: FRESH() }, parts = {} } = {}) {
    mocks.readAutomationAnalysis.mockResolvedValue(analysis);
    const table = { fields, statuses, directory, findings, ...parts };
    mocks.readAutomationPart.mockImplementation((_k, part) => Promise.resolve(table[part] ?? null));
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
      const refreshedAt = Date.now() - 5 * 86400000;
      stubAll({ analysis: { schemaVersion: 1, refreshedAt } });
      const result = await rovoSearchAutomationRules({ query: "approval" }, {});
      expect(result.analysisRefreshedAt).toBe(refreshedAt);
      // Not just the stamp: the age, worked out and ready to state.
      expect(result.evidence.ageDays).toBe(5);
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

    // The defect this action shipped with: absence from the index was reported as proof of
    // non-reference, whatever the state of the index it was absent from.
    describe("will not assert safe-to-delete it cannot support", () => {
      test("degrades to unknown when the index was truncated", async () => {
        // total far above entries.length: rows were dropped, and the dropped rows are the
        // LEAST-referenced ones -- which is the population this question is asked about.
        stubAll({ parts: { fields: { ...fields, total: 1400 } } });

        const result = await rovoAutomationUsage({ name: "Never Indexed" }, {});

        expect(result.status).toBe("unknown");
        // Not false -- false would claim rules DO reference it. Null is the third state.
        expect(result.safeToDelete).toBeNull();
        expect(result.evidence.blockers.map((b) => b.code)).toContain("index-truncated");
        expect(result.guidance).toMatch(/truncated/i);
      });

      test("degrades to unknown when the analysis is older than the threshold", async () => {
        mocks.readAdminConfig?.mockResolvedValue?.({ automationStaleAfterDays: 7 });
        stubAll({ analysis: { schemaVersion: 1, refreshedAt: Date.now() - 30 * 86400000 } });

        const result = await rovoAutomationUsage({ name: "Never Used" }, {});

        expect(result.status).toBe("unknown");
        expect(result.safeToDelete).toBeNull();
        expect(result.evidence.blockers.map((b) => b.code)).toContain("analysis-stale");
        expect(result.guidance).toMatch(/re-import/i);
      });

      test("still says no when a rule DOES reference it, however old the analysis", async () => {
        // Positive evidence survives staleness. A rule that wrote this field a month ago
        // almost certainly still does, and "no" is the cautious answer either way.
        stubAll({ analysis: { schemaVersion: 1, refreshedAt: Date.now() - 90 * 86400000 } });

        const result = await rovoAutomationUsage({ name: "Story Points" }, {});

        expect(result.status).toBe("ok");
        expect(result.safeToDelete).toBe(false);
      });

      test("carries the age on every answer so the agent can state it", async () => {
        const refreshedAt = Date.now() - 3 * 86400000;
        stubAll({ analysis: { schemaVersion: 1, refreshedAt } });

        const [usage, inspect, search] = await Promise.all([
          rovoAutomationUsage({ name: "Story Points" }, {}),
          rovoInspectAutomationRule({ ruleIdentifier: "10" }, {}),
          rovoSearchAutomationRules({ query: "approval" }, {}),
        ]);

        for (const result of [usage, inspect, search]) {
          expect(result.evidence).toMatchObject({ ageDays: 3, stale: false });
        }
      });

      test("a rule search is not accused of truncation it cannot have", async () => {
        // A directory search consults no capped index, so only the age applies to it.
        stubAll({ parts: { fields: { ...fields, total: 1400 } } });

        const result = await rovoSearchAutomationRules({ query: "approval" }, {});

        expect(result.status).toBe("ok");
        expect(result.evidence.blockers).toEqual([]);
        expect(result.evidence.indexComplete).toBeNull();
      });
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

describe("probeAssetsApi", () => {
  const probeAssetsApi = __RAW_ADMIN_ONLY_FUNCTIONS.probeAssetsApi;

  test("reports Assets not enabled when the workspace hop fails, and never touches the gateway", async () => {
    mocks.probeEndpoint.mockResolvedValue({ path: "w", status: 404, ok: false, ms: 4, sample: "no" });

    const result = await probeAssetsApi({ context: {} });

    expect(result).toMatchObject({ assetsEnabled: false, workspaceId: null });
    expect(mocks.probeStargateEndpoint).not.toHaveBeenCalled();
  });

  test("probes the Assets gateway endpoints once a workspace is discovered", async () => {
    mocks.probeEndpoint.mockResolvedValue({ path: "w", status: 200, ok: true, ms: 4, sample: '{"values":[{"workspaceId":"ws-1"}]}' });
    mocks.probeStargateEndpoint.mockResolvedValue({ path: "s", status: 200, ok: true, ms: 6, sample: '{"objectSchemas":[{"id":"1"}]}' });

    const result = await probeAssetsApi({ context: {} });

    expect(result.workspaceId).toBe("ws-1");
    const gatewayPaths = mocks.probeStargateEndpoint.mock.calls.map((c) => c[0]);
    expect(gatewayPaths.some((p) => p.includes("/jsm/assets/workspace/ws-1/v1/objectschema/list"))).toBe(true);
  });
});


// ── Screen and scheme inventory ──────────────────────────────────────────────

describe("getScreenInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  // "No inventory has been built" and "this site has no screens" are opposite claims and
  // look identical as an empty array. The flag is what keeps them apart.
  test("reports never-built rather than returning empty rows", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);

    const result = await getScreenInventory({ payload: {}, ...ctx });

    expect(result.neverBuilt).toBe(true);
    expect(result.screens).toEqual({ total: 0, rows: [] });
    expect(mocks.loadScreensPage).not.toHaveBeenCalled();
  });

  test("returns every layer of the chain from one call", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({
      state: "ready", version: "v1", totalScreens: 760, totalSchemes: 12, unresolvedScreens: 30,
    });
    mocks.loadScreensPage.mockResolvedValue({ total: 760, rows: [{ screenId: "100" }] });
    mocks.loadScreenSchemes.mockResolvedValue([{ schemeId: "5" }]);
    mocks.loadIssueTypeScreenSchemes.mockResolvedValue([{ itssId: "9" }]);

    const result = await getScreenInventory({ payload: {}, ...ctx });

    expect(result.neverBuilt).toBe(false);
    expect(result.screens.total).toBe(760);
    expect(result.screenSchemes).toHaveLength(1);
    expect(result.issueTypeScreenSchemes).toHaveLength(1);
  });

  // Surfaced at the top level, not buried per row: a pass that could not read part of the
  // catalog caps every finding built on it, and the reader needs that before the numbers.
  test("surfaces the unresolved screen count alongside the totals", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1", unresolvedScreens: 30 });

    const result = await getScreenInventory({ payload: {}, ...ctx });
    expect(result.unresolvedScreens).toBe(30);
  });

  test("clamps a hostile page size and passes the offset through", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });

    await getScreenInventory({ payload: { page: 3, pageSize: 5000 }, ...ctx });

    expect(mocks.loadScreensPage).toHaveBeenCalledWith("test-install", "v1",
      expect.objectContaining({ limit: 100, offset: 200 }));
  });

  test("reports a stale build so the UI can offer a rebuild", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ state: "building", version: "v1" });
    mocks.isScreenBuildStale.mockReturnValue(true);

    const result = await getScreenInventory({ payload: {}, ...ctx });
    expect(result.staleBuild).toBe(true);
  });
});

describe("getFieldScreenReachability", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  // The distinction a delete recommendation rests on: no snapshot is not "this field is
  // on no screen".
  test("says it does not know rather than returning an empty screen list", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);

    const result = await getFieldScreenReachability({ payload: { fieldId: "customfield_1" }, ...ctx });

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/no screen inventory/i);
  });

  test("returns the screens carrying the field once a snapshot exists", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "v1", unresolvedScreens: 2 });
    mocks.loadScreensForField.mockResolvedValue([{ screenId: "100", screenName: "Default" }]);

    const result = await getFieldScreenReachability({ payload: { fieldId: "customfield_1" }, ...ctx });

    expect(result.available).toBe(true);
    expect(result.screens).toHaveLength(1);
    // Carried through so a caller can weigh the answer, not just read it.
    expect(result.unresolvedScreens).toBe(2);
  });

  test("rejects a missing field id", async () => {
    await expect(getFieldScreenReachability({ payload: {}, ...ctx })).rejects.toThrow(/fieldId/);
  });
});


// ---------------------------------------------------------------------------
// getHealthHistory
// ---------------------------------------------------------------------------
//
// The score always raised a question it could not answer: did cleaning that up help? These
// pin the two rules that keep the answer honest -- a single point is not a trend, and a
// dimension that only started being measured partway through has not "improved".
describe("getHealthHistory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  const day = (d, score, dimensions) => ({
    day: d, measuredAt: `${d}T00:00:00.000Z`, score, grade: "C",
    dimensionsScored: Object.keys(dimensions).length, dimensionsTotal: 13, dimensions,
  });

  test("says it has nothing rather than drawing a flat line at zero", async () => {
    mocks.loadHealthHistory.mockResolvedValue([]);

    const result = await getHealthHistory({ payload: {}, ...ctx });

    expect(result.available).toBe(false);
    expect(result.series).toEqual([]);
  });

  test("reports the movement across the window", async () => {
    mocks.loadHealthHistory.mockResolvedValue([
      day("2026-08-01", 51, { "field-governance": 17 }),
      day("2026-08-13", 63, { "field-governance": 40 }),
    ]);

    const result = await getHealthHistory({ payload: {}, ...ctx });

    expect(result.delta).toBe(12);
    expect(result.hasTrend).toBe(true);
    expect(result.dimensions.find((d) => d.key === "field-governance").delta).toBe(23);
  });

  // One measurement is a point, not a trend. Reporting a delta against itself would show
  // every fresh install as having improved by nothing, which reads as a measured result.
  test("refuses to call a single measurement a trend", async () => {
    mocks.loadHealthHistory.mockResolvedValue([day("2026-08-13", 58, { "field-naming": 79 })]);

    const result = await getHealthHistory({ payload: {}, ...ctx });

    expect(result.available).toBe(true);
    expect(result.hasTrend).toBe(false);
    expect(result.delta).toBeNull();
  });

  // A dimension that appeared partway through the window did not improve from zero -- that
  // would credit nobody's work as a 40-point gain.
  test("reports a newly measured dimension as new, not as an improvement", async () => {
    mocks.loadHealthHistory.mockResolvedValue([
      day("2026-08-01", 51, { "field-naming": 79 }),
      day("2026-08-13", 63, { "field-naming": 79, "screen-hygiene": 40 }),
    ]);

    const result = await getHealthHistory({ payload: {}, ...ctx });
    const added = result.dimensions.find((d) => d.key === "screen-hygiene");

    expect(added.first).toBeNull();
    expect(added.delta).toBeNull();
    expect(added.score).toBe(40);
  });

  // Ordered worst-movement first: the dimensions that went backwards are the ones an admin
  // needs to see, and they are exactly the ones a score-ordered list would bury.
  test("orders dimensions by movement, regressions first", async () => {
    mocks.loadHealthHistory.mockResolvedValue([
      day("2026-08-01", 51, { a: 50, b: 50 }),
      day("2026-08-13", 51, { a: 80, b: 20 }),
    ]);

    const result = await getHealthHistory({ payload: {}, ...ctx });

    expect(result.dimensions.map((d) => d.key)).toEqual(["b", "a"]);
  });

  test("clamps a hostile window rather than trusting it", async () => {
    mocks.loadHealthHistory.mockResolvedValue([]);
    await getHealthHistory({ payload: { days: 99999 }, ...ctx });

    expect(mocks.loadHealthHistory).toHaveBeenCalledWith("test-install", { days: 365 });
  });
});


// ---------------------------------------------------------------------------
// getProjectOverview
// ---------------------------------------------------------------------------
//
// The view the Projects tab existed to give and could not. Both cross-pillar joins existed
// as data -- rule scope was computed on every import and discarded, screens were reachable
// through the ITSS chain -- and neither had a query.

// ---------------------------------------------------------------------------
// getPillarHealth
// ---------------------------------------------------------------------------
//
// One pillar of the score, for the tab that pillar is about. Serving one rather than the
// whole score keeps the Workflows tab from having to know how Screens is graded.
describe("getPillarHealth", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("returns only the requested pillar, with the site score alongside it", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1" });
    mocks.loadWorkflowSchemes.mockResolvedValue([{ schemeId: "s1", name: "S", projectCount: 2 }]);
    mocks.loadStatusesCatalog.mockResolvedValue([{ statusId: "1", name: "Open" }]);

    const result = await getPillarHealth({ payload: { pillar: "workflows" }, ...ctx });

    expect(result.pillar.key).toBe("workflows");
    expect(result.pillar.dimensions.every((d) => d.pillar === "workflows")).toBe(true);
  });

  test("returns a null pillar for a name the score does not have", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);

    const result = await getPillarHealth({ payload: { pillar: "not-a-pillar" }, ...ctx });

    expect(result.pillar).toBeNull();
  });

  // The field inputs are the expensive half and the most likely to fail. A failure there must
  // not take the whole response down -- the pillar comes back reporting itself unmeasured.
  //
  // Asked for the FIELDS pillar deliberately: the screens pillar no longer loads the field
  // catalog at all, so pointing this at screens would leave the queued rejection unconsumed
  // and bleed it into the next test.
  test("still answers when the field inputs cannot be built", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.loadSnapshotFields.mockRejectedValueOnce(new Error("Unknown SQL execution error"));

    const result = await getPillarHealth({ payload: { pillar: "fields" }, ...ctx });

    expect(result.pillar).not.toBeNull();
    expect(result.pillar.key).toBe("fields");
    expect(result.pillar.available).toBe(false);
  });

  test("builds the field pillar from the snapshot when one exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "1", projectKey: "A", projectName: "Alpha", fieldCount: 4, totalIssueCount: 10 },
    ]);

    const result = await getPillarHealth({ payload: { pillar: "fields" }, ...ctx });

    expect(result.pillar.key).toBe("fields");
    expect(result.pillar.available).toBe(true);
  });

  test("rejects a missing pillar name", async () => {
    await expect(getPillarHealth({ payload: {}, ...ctx })).rejects.toThrow(/pillar/);
  });

  test("builds the people pillar from the user snapshot when one exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readUserSnapshotMeta.mockResolvedValue({ version: "u1", state: "ready" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.loadUserGovernanceSummary.mockResolvedValue({ totalUsers: 200, activeUsers: 180 });

    const result = await getPillarHealth({ payload: { pillar: "users" }, ...ctx });

    expect(result.pillar.key).toBe("users");
    expect(result.pillar.available).toBe(true);
    expect(result.pillar.dimensions.some((d) => d.key === "user-licence-hygiene")).toBe(true);
  });

  test("reports the people pillar unavailable rather than empty when no roster exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readUserSnapshotMeta.mockResolvedValue(null);

    const result = await getPillarHealth({ payload: { pillar: "users" }, ...ctx });

    expect(result.pillar.available).toBe(false);
  });

  test("builds the assets pillar from the asset snapshot when one exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readAssetSnapshotMeta.mockResolvedValue({ version: "as1", state: "ready", assetsEnabled: true });
    mocks.loadAssetSchemas.mockResolvedValue([{ id: "1", name: "Infra", objectTypeCount: 3, objectCount: 40 }]);
    mocks.loadAssetObjectTypes.mockResolvedValue([{ id: "9", schemaId: "1", name: "Server", parentId: null, abstract: false }]);
    mocks.loadAssetAttributes.mockResolvedValue([{ id: "a", objectTypeId: "9", name: "OS", referenceObjectTypeId: null, system: false }]);

    const result = await getPillarHealth({ payload: { pillar: "assets" }, ...ctx });

    expect(result.pillar.key).toBe("assets");
    expect(result.pillar.available).toBe(true);
    expect(result.pillar.dimensions.some((d) => d.key === "asset-schema-hygiene")).toBe(true);
  });

  test("reports the assets pillar not-applicable when Assets is not licensed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "unavailable", assetsEnabled: false });

    const result = await getPillarHealth({ payload: { pillar: "assets" }, ...ctx });

    expect(result.pillar.available).toBe(false);
    expect(result.pillar.dimensions.every((d) => /not enabled on this site/i.test(d.reason))).toBe(true);
  });
});

describe("getProjectOverview", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x", accountId: "acc-1" } };

  // Before any pillar is read. Every other project read here filters by browsable project,
  // and a cross-pillar view must not become the one place a caller learns about a project
  // they cannot see.
  test("refuses a project the caller cannot browse, without reading any pillar", async () => {
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set());

    const result = await getProjectOverview({ payload: { projectId: "10000" }, ...ctx });

    expect(result.available).toBe(false);
    expect(mocks.loadScreensForProject).not.toHaveBeenCalled();
    expect(mocks.loadRulesForProject).not.toHaveBeenCalled();
  });

  test("joins workflow, screens and automation for one project", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1" });
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1", unresolvedScreens: 2 });
    mocks.loadWorkflowSchemeForProject.mockResolvedValue({ id: "sch1", name: "SW Workflow Scheme v1" });
    mocks.loadScreensForProject.mockResolvedValue([{ screenId: "100", name: "Default", fieldCount: 28 }]);
    mocks.loadRulesForProject.mockResolvedValue([
      { ruleId: "1", name: "Send to Approval", enabled: true },
      { ruleId: "2", name: "Retired", enabled: false },
    ]);

    const result = await getProjectOverview({ payload: { projectId: "10000" }, ...ctx });

    expect(result.workflow.scheme.name).toBe("SW Workflow Scheme v1");
    expect(result.screens.screens).toHaveLength(1);
    expect(result.automation).toMatchObject({ enabledCount: 1, disabledCount: 1 });
    // Carried so the tab never presents a partial catalog as the whole one.
    expect(result.screens.unresolvedScreens).toBe(2);
  });

  // One unbuilt pillar must not blank the page, and must not be reported as empty either.
  test("reports each pillar unavailable independently rather than as empty", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readWorkflowSnapshotMeta.mockResolvedValue(null);
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);
    mocks.loadRulesForProject.mockResolvedValue([{ ruleId: "1", name: "R", enabled: true }]);

    const result = await getProjectOverview({ payload: { projectId: "10000" }, ...ctx });

    expect(result.workflow).toMatchObject({ available: false });
    expect(result.screens).toMatchObject({ available: false });
    expect(result.workflow.reason).toMatch(/workflow inventory/i);
    // The pillar that IS built still renders.
    expect(result.automation.available).toBe(true);
  });

  // Cross-pillar (Access): the three schemes this project resolves to, each flagged if it
  // is the site default. Tri-state like the rest.
  test("joins the project's permission / security / notification schemes when the access inventory exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    mocks.loadProjectSchemes.mockResolvedValue([
      { schemeType: "permission", schemeId: "1", schemeName: "Prod permissions", isDefault: false },
      { schemeType: "notification", schemeId: "n1", schemeName: "Default Notification Scheme", isDefault: true },
    ]);

    const result = await getProjectOverview({ payload: { projectId: "10000" }, ...ctx });

    expect(result.schemes).toMatchObject({
      available: true,
      permission: { schemeName: "Prod permissions" },
      security: null,
      notification: { isDefault: true },
    });
  });

  test("groups this project's role actors by role", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    mocks.loadProjectRoleActors.mockResolvedValue([
      { roleId: "10002", roleName: "Administrators", holderType: "group", holderValue: "g-admins", holderLabel: "admins" },
      { roleId: "10003", roleName: "Members", holderType: "empty", holderValue: "", holderLabel: null },
    ]);

    const result = await getProjectOverview({ payload: { projectId: "10000" }, ...ctx });

    expect(result.roles.available).toBe(true);
    const admin = result.roles.byRole.find((r) => r.roleName === "Administrators");
    const members = result.roles.byRole.find((r) => r.roleName === "Members");
    expect(admin.actors).toEqual([{ type: "group", value: "g-admins", label: "admins" }]);
    expect(members.actors).toEqual([]); // the empty sentinel is not an actor
  });

  test("reports the access schemes unavailable when that inventory has not been built", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readAccessSnapshotMeta.mockResolvedValue(null);

    const result = await getProjectOverview({ payload: { projectId: "10000" }, ...ctx });

    expect(result.schemes).toMatchObject({ available: false });
    expect(mocks.loadProjectSchemes).not.toHaveBeenCalled();
  });


  // Site-wide rules are only worth listing per project if there is evidence they act there
  // -- otherwise the list is "all of them" and says nothing.
  test("keeps inferred site-wide rules separate from the ones actually scoped here", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.loadRulesForProject.mockResolvedValue([{ ruleId: "1", name: "Scoped", enabled: true }]);
    mocks.loadGlobalRulesAffectingProject.mockResolvedValue([
      { ruleId: "9", name: "Site-wide writer", fieldsTouched: 2, issuesTouched: 5000, lastChangeAt: "2026-08-01T00:00:00Z" },
    ]);

    const result = await getProjectOverview({ payload: { projectId: "10000" }, ...ctx });

    // Merging them would erase the difference between "configured for this project" and
    // "we infer it reaches this project", and only the first is a fact.
    expect(result.automation.rules.map((r) => r.ruleId)).toEqual(["1"]);
    expect(result.automation.globalRules.map((r) => r.ruleId)).toEqual(["9"]);
    expect(result.automation.globalRulesAvailable).toBe(true);
  });

  // The evidence is field usage in this project, so with no field snapshot there is nothing
  // to infer from. Withheld rather than guessed at.
  test("withholds the inferred list when there is no field snapshot to infer from", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.loadRulesForProject.mockResolvedValue([]);

    const result = await getProjectOverview({ payload: { projectId: "10000" }, ...ctx });

    expect(mocks.loadGlobalRulesAffectingProject).not.toHaveBeenCalled();
    expect(result.automation.globalRulesAvailable).toBe(false);
    expect(result.automation.globalRulesReason).toMatch(/field snapshot/i);
  });

  test("lists the saved filters whose JQL scopes to this project", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "flt1" });
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "10000", projectKey: "PT2", projectName: "Prototype & Test", fieldCount: 216, totalIssueCount: 1_066_714 },
    ]);
    mocks.loadFilterReferencesFor.mockResolvedValue({
      total: 3,
      filters: [{ id: "5", name: "PT2 open bugs", ownerName: "Bo", ownerActive: true, subscriptionCount: 2, lastUsedAt: "2026-08-01" }],
    });

    const result = await getProjectOverview({ payload: { projectId: "10000", projectKey: "PT2" }, ...ctx });

    expect(mocks.loadFilterReferencesFor).toHaveBeenCalledWith("test-install", "flt1", "project", "PT2");
    expect(result.filters).toMatchObject({ available: true, total: 3 });
    expect(result.filters.filters[0].name).toBe("PT2 open bugs");
  });

  test("reports filters unavailable rather than empty when no filter snapshot exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    mocks.loadRulesForProject.mockResolvedValue([]);

    const result = await getProjectOverview({ payload: { projectId: "10000", projectKey: "PT2" }, ...ctx });

    expect(result.filters).toMatchObject({ available: false });
    expect(mocks.loadFilterReferencesFor).not.toHaveBeenCalled();
  });

  test("rolls up a health band from the pillar signals, flagging a form-heavy project", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1", unresolvedScreens: 14 });
    mocks.loadScreensForProject.mockResolvedValue([{ screenId: "1", name: "S", tabsResolved: "resolved" }]);
    mocks.loadRulesForProject.mockResolvedValue([{ ruleId: "1", name: "R", enabled: true }]);
    mocks.listSnapshotProjects.mockResolvedValue([
      // This project asks ~90 fields per issue; the rest sit at 12, so the site median is 12
      // and this one reads as ~7.5x heavier -- past the 6x "critical" line.
      { projectId: "10000", projectKey: "PT2", projectName: "PT2", fieldCount: 216, totalIssueCount: 900_000 },
      { projectId: "2", projectKey: "B", projectName: "B", fieldCount: 20, totalIssueCount: 120_000 },
      { projectId: "3", projectKey: "C", projectName: "C", fieldCount: 20, totalIssueCount: 130_000 },
    ]);
    // Universe-scan issue totals, so fills-per-issue is computable: PT2 ~90, the others ~12.
    mocks.loadIssueScanProjectTotals.mockResolvedValue([
      { projectId: "10000", uniqueIssueCount: 10_000 },
      { projectId: "2", uniqueIssueCount: 10_000 },
      { projectId: "3", uniqueIssueCount: 10_833 },
    ]);

    const result = await getProjectOverview({ payload: { projectId: "10000", projectKey: "PT2" }, ...ctx });

    expect(result.health.band).toBe("critical");
    const config = result.health.signals.find((s) => s.key === "configuration");
    expect(config.tone).toBe("critical");
    const forms = result.health.signals.find((s) => s.key === "forms");
    expect(forms.tone).toBe("warning"); // 14 unreadable screens
  });

  test("rejects a missing project id", async () => {
    await expect(getProjectOverview({ payload: {}, ...ctx })).rejects.toThrow(/projectId/);
  });
});

describe("getScreenFieldReportInputs", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x", accountId: "acc-1" } };

  test("returns the field union and the projects the screens reach", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1" });
    mocks.loadScreensWithFieldsByIds.mockResolvedValue([
      { screenId: "100", name: "Create", tabsResolved: "resolved", fields: [{ fieldId: "cf_1", fieldName: "A" }, { fieldId: "cf_2", fieldName: "B" }] },
      { screenId: "200", name: "Edit", tabsResolved: "resolved", fields: [{ fieldId: "cf_2", fieldName: "B" }, { fieldId: "cf_3", fieldName: "C" }] },
    ]);
    // screen 100 -> scheme SS1 -> itss I1 -> project 10 and 11
    mocks.loadScreenSchemeOperations.mockResolvedValue([{ schemeId: "SS1", screenId: "100" }, { schemeId: "SS9", screenId: "999" }]);
    mocks.loadItssMappings.mockResolvedValue([{ itssId: "I1", screenSchemeId: "SS1" }]);
    mocks.loadItssProjects.mockResolvedValue([
      { itssId: "I1", projectId: "10", projectKey: "AAA", projectName: "Alpha" },
      { itssId: "I1", projectId: "11", projectKey: "BBB", projectName: "Bravo" },
      { itssId: "I2", projectId: "12", projectKey: "CCC", projectName: "Charlie" },
    ]);

    const result = await getScreenFieldReportInputs({ payload: { screenIds: ["100", "200"] }, ...ctx });

    expect(result.available).toBe(true);
    expect(result.fieldIds.sort()).toEqual(["cf_1", "cf_2", "cf_3"]);
    expect(result.projectIds.sort()).toEqual(["10", "11"]);
  });

  test("flags screens whose contents could not be read", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1" });
    mocks.loadScreensWithFieldsByIds.mockResolvedValue([
      { screenId: "100", name: "Create", tabsResolved: "resolved", fields: [{ fieldId: "cf_1", fieldName: "A" }] },
      { screenId: "300", name: "Legacy", tabsResolved: "unreadable", fields: [] },
    ]);

    const result = await getScreenFieldReportInputs({ payload: { screenIds: ["100", "300", "404"] }, ...ctx });

    expect(result.unresolvedScreens).toEqual(["Legacy"]);
    expect(result.missingScreenIds).toEqual(["404"]);
  });

  test("rejects an empty screen list", async () => {
    await expect(getScreenFieldReportInputs({ payload: { screenIds: [] }, ...ctx })).rejects.toThrow();
  });
});

describe("getProjectScreenReportInputs", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x", accountId: "acc-1" } };

  test("groups the project's screens by screen scheme, default first, and scopes to the project", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1" });
    mocks.loadItssProjects.mockResolvedValue([{ itssId: "I1", projectId: "10000" }]);
    mocks.loadItssMappings.mockResolvedValue([
      { itssId: "I1", issueTypeId: "1", screenSchemeId: "SS_STORY", isDefault: true },
      { itssId: "I1", issueTypeId: "2", screenSchemeId: "SS_BUG", isDefault: false },
      { itssId: "I1", issueTypeId: "3", screenSchemeId: "SS_BUG", isDefault: false },
    ]);
    mocks.loadScreenSchemeOperations.mockResolvedValue([
      { schemeId: "SS_STORY", screenId: "S1" },
      { schemeId: "SS_BUG", screenId: "S2" },
      { schemeId: "SS_BUG", screenId: "S3" },
    ]);
    mocks.loadScreenSchemes.mockResolvedValue([
      { schemeId: "SS_STORY", name: "Story screens" },
      { schemeId: "SS_BUG", name: "Bug screens" },
    ]);
    mocks.loadScreensWithFieldsByIds.mockResolvedValue([
      { screenId: "S1", name: "Story", fields: [{ fieldId: "cf_1" }] },
      { screenId: "S2", name: "Bug create", fields: [{ fieldId: "cf_2" }, { fieldId: "cf_3" }] },
      { screenId: "S3", name: "Bug edit", fields: [{ fieldId: "cf_3" }] },
    ]);

    const result = await getProjectScreenReportInputs({ payload: { projectId: "10000" }, ...ctx });

    expect(result.available).toBe(true);
    expect(result.scopeProjectIds).toEqual(["10000"]);
    // Default scheme sorts first.
    expect(result.schemes[0].schemeId).toBe("SS_STORY");
    expect(result.schemes[0].isDefault).toBe(true);
    const bug = result.schemes.find((s) => s.schemeId === "SS_BUG");
    expect(bug.issueTypeCount).toBe(2);
    expect(bug.fieldIds.sort()).toEqual(["cf_2", "cf_3"]);
    expect(result.allFieldIds.sort()).toEqual(["cf_1", "cf_2", "cf_3"]);
  });

  test("refuses a project the caller cannot browse", async () => {
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set());
    const result = await getProjectScreenReportInputs({ payload: { projectId: "10000" }, ...ctx });
    expect(result.available).toBe(false);
  });
});

describe("macro viewer pillars", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x", accountId: "viewer-1" } };

  beforeEach(() => {
    // The viewer can browse SOLVE (id 10) only.
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "10", projectKey: "SOLVE", projectName: "Solve" },
      { projectId: "20", projectKey: "OTHER", projectName: "Other" },
    ]);
    mocks.getBrowsableProjectIds.mockImplementation(async () => new Set(["10"]));
  });

  describe("getMacroFilters", () => {
    test("keeps only filters that name a browsable project in JQL or are shared to one", async () => {
      mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "flt1" });
      mocks.loadFilters.mockResolvedValue([
        { id: "1", name: "Solve open", jql: 'project = SOLVE', ownerName: "A", projectRefs: ["SOLVE"], fieldRefs: ["Priority"], shares: [] },
        { id: "2", name: "Other backlog", jql: 'project = OTHER', ownerName: "B", projectRefs: ["OTHER"], fieldRefs: [], shares: [] },
        { id: "3", name: "Shared to Solve", jql: 'status = Done', ownerName: "C", projectRefs: [], fieldRefs: [], shares: [{ type: "project", targetId: "10" }] },
        { id: "4", name: "Global", jql: 'assignee = currentUser()', ownerName: "D", projectRefs: [], fieldRefs: [], shares: [{ type: "authenticated" }] },
      ]);

      const result = await getMacroFilters({ payload: {}, ...ctx });

      expect(result.available).toBe(true);
      expect(result.filters.map((f) => f.id).sort()).toEqual(["1", "3"]);
      expect(result.projectCount).toBe(1);
    });

    test("degrades, not throws, when no filter inventory exists", async () => {
      mocks.readFilterSnapshotMeta.mockResolvedValue(null);
      const result = await getMacroFilters({ payload: {}, ...ctx });
      expect(result).toMatchObject({ available: false, reason: "no-inventory" });
    });

    test("searches name and jql, and paginates", async () => {
      mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "flt1" });
      mocks.loadFilters.mockResolvedValue(
        Array.from({ length: 25 }, (_, i) => ({ id: String(i), name: `Solve ${i}`, jql: "project = SOLVE", ownerName: "A", projectRefs: ["SOLVE"], fieldRefs: [], shares: [] }))
      );

      const page1 = await getMacroFilters({ payload: { page: 1 }, ...ctx });
      expect(page1.filters).toHaveLength(20);
      expect(page1.totalPages).toBe(2);

      const searched = await getMacroFilters({ payload: { query: "solve 7" }, ...ctx });
      expect(searched.matchedTotal).toBe(1);
    });
  });

  describe("getMacroDashboards", () => {
    test("keeps dashboards shared to a browsable project or backed by one of its filters", async () => {
      mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "d1" });
      mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "flt1" });
      mocks.loadFilters.mockResolvedValue([
        { id: "F_SOLVE", projectRefs: ["SOLVE"], fieldRefs: ["Priority"] },
        { id: "F_OTHER", projectRefs: ["OTHER"], fieldRefs: [] },
      ]);
      mocks.loadDashboards.mockResolvedValue([
        { id: "D1", name: "Solve board", ownerName: "A", gadgetCount: 2, shares: [{ type: "project", targetId: "10" }], gadgets: [] },
        { id: "D2", name: "Via filter", ownerName: "B", gadgetCount: 1, shares: [], gadgets: [{ filterId: "F_SOLVE" }] },
        { id: "D3", name: "Unrelated", ownerName: "C", gadgetCount: 1, shares: [{ type: "project", targetId: "20" }], gadgets: [{ filterId: "F_OTHER" }] },
      ]);

      const result = await getMacroDashboards({ payload: {}, ...ctx });

      expect(result.dashboards.map((d) => d.id).sort()).toEqual(["D1", "D2"]);
      expect(result.dashboards.find((d) => d.id === "D2").fields).toEqual(["Priority"]);
    });
  });

  describe("getMacroWorkflows", () => {
    test("groups the viewer's projects by workflow scheme and lists each scheme's statuses", async () => {
      mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1" });
      mocks.loadProjectWorkflowSchemeMap.mockResolvedValue(new Map([
        ["10", { schemeId: "WS1", name: "Solve workflow" }],
        ["20", { schemeId: "WS2", name: "Other workflow" }],
      ]));
      mocks.loadWorkflowSchemeStatuses.mockResolvedValue([
        { schemeId: "WS1", statusId: "s1" }, { schemeId: "WS1", statusId: "s2" }, { schemeId: "WS2", statusId: "s3" },
      ]);
      mocks.loadStatusesCatalog.mockResolvedValue([
        { id: "s1", name: "Open", statusCategory: "To Do" },
        { id: "s2", name: "Done", statusCategory: "Done" },
        { id: "s3", name: "Elsewhere", statusCategory: "To Do" },
      ]);

      const result = await getMacroWorkflows({ ...ctx });

      expect(result.schemes).toHaveLength(1);
      expect(result.schemes[0]).toMatchObject({ schemeId: "WS1", projects: ["SOLVE"] });
      expect(result.statuses.map((s) => s.name)).toEqual(["Done", "Open"]);
      // A status from a scheme the viewer's projects do not run never appears.
      expect(result.statuses.some((s) => s.name === "Elsewhere")).toBe(false);
    });
  });
});

describe("getFieldScreenCounts", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  // Same tri-state as the reachability read, for the same reason: the Field Browser chip
  // renders an em dash for "unknown" and a warm 0 for "on no screen", and a map of zeroes
  // from an unbuilt snapshot would light up every card as safe to delete.
  test("reports unavailable rather than a map of zeroes when nothing is built", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);

    const result = await getFieldScreenCounts({ payload: { fieldIds: ["customfield_1"] }, ...ctx });

    expect(result.available).toBe(false);
    expect(result.counts).toEqual({});
    expect(mocks.loadScreenCountsForFields).not.toHaveBeenCalled();
  });

  test("returns counts for the requested page with the unresolved caveat attached", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "v1", refreshedAt: "t", unresolvedScreens: 3 });
    mocks.loadScreenCountsForFields.mockResolvedValue({ customfield_1: 6 });

    const result = await getFieldScreenCounts({ payload: { fieldIds: ["customfield_1", "customfield_2"] }, ...ctx });

    expect(result).toEqual(expect.objectContaining({ available: true, counts: { customfield_1: 6 }, unresolvedScreens: 3 }));
  });

  test("caps the id list rather than passing an unbounded page to SQL", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "v1" });
    mocks.loadScreenCountsForFields.mockResolvedValue({});

    await getFieldScreenCounts({ payload: { fieldIds: Array.from({ length: 900 }, (_, i) => `f${i}`) }, ...ctx });

    expect(mocks.loadScreenCountsForFields.mock.calls[0][2]).toHaveLength(500);
  });

  test("treats a missing or malformed id list as an empty one", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "v1" });
    mocks.loadScreenCountsForFields.mockResolvedValue({});

    await getFieldScreenCounts({ payload: { fieldIds: "not-an-array" }, ...ctx });

    expect(mocks.loadScreenCountsForFields).toHaveBeenCalledWith("test-install", "v1", []);
  });
});

describe("buildScreenInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("queues a build when nothing is running", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.readAdminConfig?.mockResolvedValue?.({ readOnlyMode: false });

    const result = await buildScreenInventory(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueScreenSnapshotBuild).toHaveBeenCalledWith("test-install");
  });

  test("refuses while a live build is running", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isScreenBuildStale.mockReturnValue(false);

    const result = await buildScreenInventory(ctx);

    expect(result).toMatchObject({ queued: false, reason: "already-building" });
    expect(mocks.queueScreenSnapshotBuild).not.toHaveBeenCalled();
  });

  // A wedged row would otherwise block every future rebuild with no way out of the UI --
  // the same trap the workflow build had to be rescued from.
  test("rebuilds over a wedged build rather than being blocked by it", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isScreenBuildStale.mockReturnValue(true);

    const result = await buildScreenInventory(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueScreenSnapshotBuild).toHaveBeenCalled();
  });
});

describe("getIssueTypeInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("reports never-built rather than returning empty lists", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue(null);

    const result = await getIssueTypeInventory(ctx);

    expect(result.neverBuilt).toBe(true);
    expect(result.issueTypes).toEqual([]);
    expect(result.hierarchy).toEqual([]);
    expect(mocks.loadIssueTypes).not.toHaveBeenCalled();
  });

  test("groups the catalog by hierarchy level, highest first, with a label per level", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1", totalTypes: 3, totalSchemes: 1 });
    mocks.loadIssueTypes.mockResolvedValue([
      { id: "1", name: "Epic", hierarchyLevel: 1, subtask: false, scopeProjectId: null },
      { id: "2", name: "Story", hierarchyLevel: 0, subtask: false, scopeProjectId: null },
      { id: "3", name: "Sub-task", hierarchyLevel: -1, subtask: true, scopeProjectId: null },
    ]);
    mocks.loadIssueTypeSchemes.mockResolvedValue([]);
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);

    const result = await getIssueTypeInventory(ctx);

    expect(result.hierarchy.map((h) => h.level)).toEqual([1, 0, -1]);
    expect(result.hierarchy[0]).toMatchObject({ label: "Epic" });
    expect(result.hierarchy[2]).toMatchObject({ label: "Sub-task" });
    expect(result.hierarchy[2].types[0].id).toBe("3");
  });

  test("resolves each scheme's ordered membership and default type against the catalog", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadIssueTypes.mockResolvedValue([
      { id: "1", name: "Epic", hierarchyLevel: 1 },
      { id: "2", name: "Story", hierarchyLevel: 0 },
    ]);
    mocks.loadIssueTypeSchemes.mockResolvedValue([
      { schemeId: "5", name: "Default", defaultIssueTypeId: "2", isDefault: true, projectCount: 1 },
    ]);
    mocks.loadIssueTypeSchemeItems.mockResolvedValue([
      { schemeId: "5", issueTypeId: "1", itemIndex: 0 },
      { schemeId: "5", issueTypeId: "2", itemIndex: 1 },
      { schemeId: "5", issueTypeId: "999", itemIndex: 2 },
    ]);
    mocks.loadIssueTypeSchemeProjects.mockResolvedValue([
      { schemeId: "5", projectId: "10000", projectKey: "OBS", projectName: "Observatory" },
    ]);
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);

    const result = await getIssueTypeInventory(ctx);

    const scheme = result.schemes[0];
    expect(scheme.defaultIssueTypeName).toBe("Story");
    expect(scheme.issueTypes.map((t) => t.name)).toEqual(["Epic", "Story", null]);
    // A member the catalog does not contain is kept and flagged, not dropped -- a scheme
    // allowing a type that no longer exists is a finding.
    expect(scheme.issueTypes[2]).toMatchObject({ id: "999", missing: true });
    expect(scheme.projects).toEqual([{ projectId: "10000", projectKey: "OBS", projectName: "Observatory" }]);
  });

  test("attaches the issue-type -> screen-scheme layer when the screen snapshot exists", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadIssueTypes.mockResolvedValue([{ id: "1", name: "Bug", hierarchyLevel: 0 }]);
    mocks.loadIssueTypeSchemes.mockResolvedValue([]);
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1" });
    mocks.loadIssueTypeScreenSchemes.mockResolvedValue([{ itssId: "9", name: "ITSS" }]);
    mocks.loadItssMappings.mockResolvedValue([
      { itssId: "9", issueTypeId: "1", screenSchemeId: "5", isDefault: false },
      { itssId: "9", issueTypeId: "default", screenSchemeId: "6", isDefault: true },
    ]);

    const result = await getIssueTypeInventory(ctx);

    expect(result.issueTypeScreenSchemes[0].mappings).toHaveLength(2);
    expect(result.issueTypeScreenSchemes[0].mappings[0].issueTypeName).toBe("Bug");
    expect(result.issueTypeScreenSchemes[0].mappings[1].issueTypeName).toBe("All unmapped types");
  });

  test("a screen-snapshot read failure does not take the tab down", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadIssueTypes.mockResolvedValue([]);
    mocks.loadIssueTypeSchemes.mockResolvedValue([]);
    mocks.readScreenSnapshotMeta.mockRejectedValueOnce(new Error("screen meta gone"));

    const result = await getIssueTypeInventory(ctx);

    expect(result.neverBuilt).toBe(false);
    expect(result.issueTypeScreenSchemes).toEqual([]);
  });
});

describe("buildIssueTypeInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("queues a build when nothing is running", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.readAdminConfig?.mockResolvedValue?.({ readOnlyMode: false });

    const result = await buildIssueTypeInventory(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueIssueTypeSnapshotBuild).toHaveBeenCalledWith("test-install");
  });

  test("refuses while a live build is running", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isIssueTypeBuildStale.mockReturnValue(false);

    const result = await buildIssueTypeInventory(ctx);

    expect(result).toMatchObject({ queued: false, reason: "already-building" });
    expect(mocks.queueIssueTypeSnapshotBuild).not.toHaveBeenCalled();
  });

  test("rebuilds over a wedged build rather than being blocked by it", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isIssueTypeBuildStale.mockReturnValue(true);

    const result = await buildIssueTypeInventory(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueIssueTypeSnapshotBuild).toHaveBeenCalled();
  });
});

describe("getUserInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("reports never-built rather than an empty roster", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue(null);
    const result = await getUserInventory(ctx);
    expect(result).toMatchObject({ neverBuilt: true, users: [], applicationSummary: [] });
  });

  test("returns the roster, seat summary and governance once built", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({
      state: "ready", version: "v1", refreshedAt: "2026-09-02T00:00:00.000Z",
      applicationSummary: [{ key: "jira-software", numberOfSeats: 5, userCount: 3 }],
    });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.loadUserGovernanceSummary.mockResolvedValue({ totalUsers: 1, activeUsers: 1, appUsers: 0, multiProductUsers: 0 });

    const result = await getUserInventory(ctx);

    expect(result).toMatchObject({
      neverBuilt: false,
      version: "v1",
      users: [{ accountId: "a1" }],
      applicationSummary: [{ key: "jira-software" }],
      governance: { totalUsers: 1 },
    });
  });

  test("attaches per-user ownership counts and an estate orphan count", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.loadUserGovernanceSummary.mockResolvedValue({ totalUsers: 1 });
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "d1" });
    mocks.loadFilters.mockResolvedValue([
      { id: "10", name: "Ann filter", ownerAccountId: "a1" },
      { id: "11", name: "Ghost filter", ownerAccountId: "gone" },
    ]);
    mocks.loadDashboards.mockResolvedValue([{ dashboardId: "20", name: "Ann dash", ownerAccountId: "a1" }]);
    mocks.readAutomationPart.mockResolvedValue(null);

    const result = await getUserInventory(ctx);

    expect(result.users[0]).toMatchObject({ ownedFilters: 1, ownedDashboards: 1, authoredRules: 0 });
    // The filter owned by "gone" (not in the roster) is an orphan.
    expect(result.governance).toMatchObject({ orphanedFilters: 1, orphanedOwners: 1 });
  });

  test("counts the automation rules that name each account, and the off-roster ones", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.loadUserGovernanceSummary.mockResolvedValue({ totalUsers: 1 });
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    mocks.readDashboardSnapshotMeta.mockResolvedValue(null);
    mocks.readAutomationPart.mockImplementation((_k, part) =>
      part === "users"
        ? Promise.resolve({ entries: [
            { label: "a1", write: [1, 2], read: [2], trigger: [] },
            { label: "gone", write: [3], read: [], trigger: [] },
          ] })
        : Promise.resolve(null));

    const result = await getUserInventory(ctx);

    // a1 is named by two distinct rules (1 and 2).
    expect(result.users[0].automationRefs).toBe(2);
    expect(result.automationRefsAvailable).toBe(true);
    expect(result.governance).toMatchObject({ automationRefUsers: 2, orphanedAutomationRefUsers: 1 });
  });
});

describe("getUserDetails", () => {
  const ctx = { payload: { accountId: "a1" }, context: { installContext: "ari:cloud:jira::site/x" } };

  test("returns the user's owned filters and dashboards as lists", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "d1" });
    mocks.loadFilters.mockResolvedValue([{ id: "10", name: "Ann filter", ownerAccountId: "a1", viewUrl: "u" }]);
    mocks.loadDashboards.mockResolvedValue([{ dashboardId: "20", name: "Ann dash", ownerAccountId: "a1" }]);
    mocks.readAutomationPart.mockResolvedValue(null);

    const result = await getUserDetails(ctx);

    expect(result).toMatchObject({
      available: true, inRoster: true,
      ownedFilters: [{ id: "10", name: "Ann filter" }],
      ownedDashboards: [{ id: "20", name: "Ann dash" }],
      authoredRules: [],
    });
  });

  test("reports no-roster when nothing has been built", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue(null);
    expect(await getUserDetails(ctx)).toMatchObject({ available: false });
  });

  test("lists the user-picker fields this account is a value in, joined to field names", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readAutomationPart.mockResolvedValue(null);
    mocks.loadUserFieldAppearances.mockResolvedValue([
      { fieldId: "customfield_500", issueCount: 30 },
      { fieldId: "assignee", issueCount: 900 },
    ]);
    mocks.loadSnapshotFieldNames.mockResolvedValue(new Map([["customfield_500", "Reviewer"], ["assignee", "Assignee"]]));

    const result = await getUserDetails(ctx);

    expect(result.fieldAppearancesAvailable).toBe(true);
    expect(result.fieldAppearances).toEqual([
      { fieldId: "customfield_500", fieldName: "Reviewer", issueCount: 30 },
      { fieldId: "assignee", fieldName: "Assignee", issueCount: 900 },
    ]);
  });

  test("lists the automation rules that name this account, joined to rule names", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    mocks.readDashboardSnapshotMeta.mockResolvedValue(null);
    mocks.readAutomationPart.mockImplementation((_k, part) => {
      if (part === "users") return Promise.resolve({ entries: [{ label: "a1", write: [7], read: [9], trigger: [] }] });
      if (part === "directory") return Promise.resolve({ rules: [[7, "Assign to Ann", 1, "t", 0], [9, "Escalate", 0, "t", 0]] });
      return Promise.resolve(null);
    });

    const result = await getUserDetails(ctx);

    expect(result.automationRefsAvailable).toBe(true);
    expect(result.referencedInRules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 7, name: "Assign to Ann", direction: "write", enabled: true }),
      expect.objectContaining({ id: 9, name: "Escalate", direction: "read", enabled: false }),
    ]));
  });

  // Cross-pillar (Access): permission grants, security-level memberships and notification
  // recipients that name this account directly.
  test("lists the schemes that name this account directly when the access inventory exists", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.readAutomationPart.mockResolvedValue(null);
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    mocks.loadSchemesGrantingHolder.mockResolvedValue([
      { schemeType: "permission", schemeId: "1", schemeName: "Prod", context: "ADMINISTER_PROJECTS", contextLabel: "Administer Projects" },
    ]);

    const result = await getUserDetails(ctx);

    expect(result.accessGrantsAvailable).toBe(true);
    expect(result.grantedBySchemes).toEqual([
      expect.objectContaining({ schemeType: "permission", schemeName: "Prod", contextLabel: "Administer Projects" }),
    ]);
    expect(mocks.loadSchemesGrantingHolder).toHaveBeenCalledWith("test-install", "a1", "user", "a1");
  });

  // Cross-pillar (Access): the common case, not the edge case -- most real grants run
  // through a group, not a direct grant on the account, and grantedBySchemes (holder_type =
  // "user" only) could not see a single one of them.
  test("lists schemes granted via a group this account belongs to, distinct from direct grants", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadUsers.mockResolvedValue([{
      accountId: "a1", displayName: "Ann", applications: [],
      groups: [{ id: "g1", name: "jira-administrators" }, { id: "g2", name: "marketing-contractors" }],
    }]);
    mocks.readAutomationPart.mockResolvedValue(null);
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    mocks.loadSchemesGrantingHolder.mockImplementation((_install, _version, holderType, holderValue) => {
      if (holderType === "user") return Promise.resolve([]);
      if (holderType === "group" && holderValue === "g1") {
        return Promise.resolve([{ schemeType: "permission", schemeId: "1", schemeName: "Prod", context: "ADMINISTER_PROJECTS", contextLabel: "Administer Projects" }]);
      }
      return Promise.resolve([]);
    });

    const result = await getUserDetails(ctx);

    expect(result.grantedBySchemes).toEqual([]);
    expect(result.grantedByGroups).toEqual([
      expect.objectContaining({ schemeName: "Prod", contextLabel: "Administer Projects", viaGroup: "jira-administrators" }),
    ]);
    expect(mocks.loadSchemesGrantingHolder).toHaveBeenCalledWith("test-install", "a1", "group", "g1");
    expect(mocks.loadSchemesGrantingHolder).toHaveBeenCalledWith("test-install", "a1", "group", "g2");
  });

  test("does not query group grants when the account belongs to no groups", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.readAutomationPart.mockResolvedValue(null);
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    mocks.loadSchemesGrantingHolder.mockResolvedValue([]);

    const result = await getUserDetails(ctx);

    expect(result.grantedByGroups).toEqual([]);
    expect(mocks.loadSchemesGrantingHolder).toHaveBeenCalledTimes(1); // the direct-user check only
  });

  test("reports access grants unavailable when the access inventory has not been built", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.readAutomationPart.mockResolvedValue(null);
    mocks.readAccessSnapshotMeta.mockResolvedValue(null);

    const result = await getUserDetails(ctx);

    expect(result.accessGrantsAvailable).toBe(false);
    expect(result.grantedBySchemes).toEqual([]);
  });
});

describe("buildUserInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("queues a build when nothing is running", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.readAdminConfig?.mockResolvedValue?.({ readOnlyMode: false });

    const result = await buildUserInventory(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueUserSnapshotBuild).toHaveBeenCalledWith("test-install");
  });

  test("refuses while a live build is running", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isUserBuildStale.mockReturnValue(false);

    const result = await buildUserInventory(ctx);

    expect(result).toMatchObject({ queued: false, reason: "already-building" });
    expect(mocks.queueUserSnapshotBuild).not.toHaveBeenCalled();
  });
});

describe("getAssetInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("reports never-built when no snapshot exists", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue(null);
    const result = await getAssetInventory(ctx);
    expect(result).toMatchObject({ neverBuilt: true, schemas: [], governance: null });
  });

  test("surfaces 'Assets not enabled' as a first-class state, not an empty catalogue", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "unavailable", assetsEnabled: false, lastError: "no workspace" });
    const result = await getAssetInventory(ctx);
    expect(result).toMatchObject({ state: "unavailable", assetsEnabled: false, neverBuilt: false });
    expect(result.governance).toMatchObject({ assetsEnabled: false });
    expect(mocks.loadAssetSchemas).not.toHaveBeenCalled();
  });

  test("returns the structure and the governance summary when built", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1", assetsEnabled: true, workspaceId: "ws-1" });
    mocks.loadAssetSchemas.mockResolvedValue([
      { id: "1", name: "Infra", objectTypeCount: 2, objectCount: 40 },
      { id: "2", name: "Empty", objectTypeCount: 0, objectCount: 0 },
    ]);
    mocks.loadAssetObjectTypes.mockResolvedValue([{ id: "9", schemaId: "1", name: "Server", parentId: null, abstract: false }]);
    mocks.loadAssetAttributes.mockResolvedValue([{ id: "a", objectTypeId: "9", name: "OS", referenceObjectTypeId: "404", system: false }]);

    const result = await getAssetInventory(ctx);

    expect(result).toMatchObject({ state: "ready", assetsEnabled: true, version: "v1", workspaceId: "ws-1" });
    expect(result.schemas).toHaveLength(2);
    expect(result.governance).toMatchObject({ deadSchemaCount: 1, brokenReferenceCount: 1 });
  });

  test("folds the object-count crawl's rows and meta in alongside the structure", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1", assetsEnabled: true, workspaceId: "ws-1" });
    mocks.loadAssetSchemas.mockResolvedValue([{ id: "1", name: "Infra", objectTypeCount: 1, objectCount: 10 }]);
    mocks.loadAssetObjectTypes.mockResolvedValue([{ id: "9", schemaId: "1", name: "Server", parentId: null, abstract: false }]);
    mocks.loadAssetTypeCounts.mockResolvedValue([{ objectTypeId: "9", schemaId: "1", objectCount: 0 }]);
    mocks.readAssetTypeCountMeta.mockResolvedValue({ state: "ready", refreshedAt: "2026-09-16T00:00:00Z", measuredTypes: 1, unmeasuredTypes: 0 });

    const result = await getAssetInventory(ctx);

    expect(result.typeCounts).toEqual([{ objectTypeId: "9", schemaId: "1", objectCount: 0 }]);
    expect(result.governance).toMatchObject({ countsMeasured: true, emptyObjectTypeCount: 1 });
    expect(result.typeCountCrawl).toMatchObject({ state: "ready", measuredTypes: 1, unmeasuredTypes: 0 });
  });
});

describe("buildAssetTypeCountCrawl", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("refuses without a structure snapshot to crawl against", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue(null);
    const result = await buildAssetTypeCountCrawl(ctx);
    expect(result).toMatchObject({ queued: false });
    expect(mocks.queueAssetTypeCountBuild).not.toHaveBeenCalled();
  });

  test("queues the crawl when a structure snapshot exists and nothing is running", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.readAssetTypeCountMeta.mockResolvedValue({ state: "idle" });
    mocks.readAdminConfig?.mockResolvedValue?.({ readOnlyMode: false });

    const result = await buildAssetTypeCountCrawl(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueAssetTypeCountBuild).toHaveBeenCalledWith("test-install");
  });

  test("refuses while its own crawl is already running", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.readAssetTypeCountMeta.mockResolvedValue({ state: "building" });
    mocks.isAssetTypeCountBuildStale.mockReturnValue(false);

    const result = await buildAssetTypeCountCrawl(ctx);

    expect(result).toMatchObject({ queued: false, reason: "already-building" });
    expect(mocks.queueAssetTypeCountBuild).not.toHaveBeenCalled();
  });
});

describe("buildAssetInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("queues a build when nothing is running", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.readAdminConfig?.mockResolvedValue?.({ readOnlyMode: false });

    const result = await buildAssetInventory(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueAssetSnapshotBuild).toHaveBeenCalledWith("test-install");
  });

  test("refuses while a live build is running", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isAssetBuildStale.mockReturnValue(false);

    const result = await buildAssetInventory(ctx);

    expect(result).toMatchObject({ queued: false, reason: "already-building" });
    expect(mocks.queueAssetSnapshotBuild).not.toHaveBeenCalled();
  });
});

describe("getAccessInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("reports never-built when no snapshot exists", async () => {
    mocks.readAccessSnapshotMeta.mockResolvedValue(null);
    const result = await getAccessInventory(ctx);
    expect(result).toMatchObject({ neverBuilt: true, permissions: null, security: null, notifications: null });
    expect(mocks.loadSchemes).not.toHaveBeenCalled();
  });

  test("returns the three scheme families with a project count and a governance summary each", async () => {
    mocks.readAccessSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.readUserSnapshotMeta.mockResolvedValue({ version: "u1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "acc-1" }]);
    mocks.loadSchemes.mockImplementation(async (_k, _v, type) => {
      if (type === "permission") return [
        { id: "1", name: "Prod", isDefault: false },
        { id: "3", name: "Legacy", isDefault: false },
      ];
      if (type === "security") return [{ id: "s1", name: "Restricted", defaultLevelId: "L1" }];
      if (type === "notification") return [{ id: "n1", name: "Prod notif", isDefault: false }];
      if (type === "project-role") return [{ id: "10002", name: "Administrators" }];
      return [];
    });
    mocks.loadSchemeHolders.mockImplementation(async (_k, _v, type) => {
      if (type === "permission") return [
        { schemeId: "3", context: "BROWSE_PROJECTS", holderType: "anyone", holderValue: "" },
      ];
      if (type === "notification") return [
        { schemeId: "n1", context: "1", holderType: "user", holderValue: "acc-gone" },
      ];
      if (type === "project-role") return [
        { schemeId: "10002", context: "1", contextLabel: "OPS", holderType: "group", holderValue: "g-admins" },
        { schemeId: "10002", context: "2", contextLabel: "DEV", holderType: "empty", holderValue: "" },
      ];
      return [];
    });
    mocks.loadSchemeProjects.mockImplementation(async (_k, _v, type) =>
      type === "permission" ? [{ schemeId: "1", projectId: "10" }] : []);
    mocks.loadSchemeLevels.mockResolvedValue([{ schemeId: "s1", id: "L1", name: "Internal" }]);

    const result = await getAccessInventory(ctx);

    expect(result.neverBuilt).toBe(false);
    expect(result.permissions.schemes.find((s) => s.id === "1").projectCount).toBe(1);
    expect(result.permissions.governance).toMatchObject({ available: true, riskySchemeCount: 1, unusedSchemeCount: 1 });
    expect(result.security.governance).toMatchObject({ available: true, noLevelSchemeCount: 0 });
    expect(result.notifications.governance).toMatchObject({ fragileSchemeCount: 1 });
    // Project roles folded in: OPS has a group in Administrators, DEV does not.
    expect(result.roles.schemes.find((s) => s.id === "10002").projectCount).toBe(1);
    expect(result.roles.governance).toMatchObject({ available: true, projectsMissingAdminActorCount: 1 });
  });
});

describe("probeGlobalPermissions", () => {
  test("reports the catalog is readable but grant enumeration is not available", async () => {
    mocks.probeEndpoint.mockResolvedValue({ path: "x", ok: true, status: 200, sample: "{}" });
    mocks.getPermissionCatalog.mockResolvedValue({
      ADMINISTER: { key: "ADMINISTER", type: "GLOBAL" },
      BROWSE_PROJECTS: { key: "BROWSE_PROJECTS", type: "PROJECT" },
    });

    const result = await probeGlobalPermissions();

    expect(result.catalogAvailable).toBe(true);
    expect(result.grantEnumerationAvailable).toBe(false);
    expect(result.globalPermissionKeys).toEqual(["ADMINISTER"]);
    expect(result.rows.length).toBeGreaterThan(0);
  });
});

describe("buildAccessInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("queues a build when nothing is running", async () => {
    mocks.readAccessSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.readAdminConfig?.mockResolvedValue?.({ readOnlyMode: false });

    const result = await buildAccessInventory(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueAccessSnapshotBuild).toHaveBeenCalledWith("test-install");
  });

  test("refuses while a live build is running", async () => {
    mocks.readAccessSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isAccessBuildStale.mockReturnValue(false);

    const result = await buildAccessInventory(ctx);

    expect(result).toMatchObject({ queued: false, reason: "already-building" });
    expect(mocks.queueAccessSnapshotBuild).not.toHaveBeenCalled();
  });
});

describe("getChangeHistory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("reports never-built, with the tracked-pillar list, when no drift pass has run", async () => {
    mocks.readDriftSnapshotMeta.mockResolvedValue(null);
    const result = await getChangeHistory({ payload: {}, ...ctx });
    expect(result).toMatchObject({ neverBuilt: true, changes: [] });
    expect(result.trackedPillars.map((p) => p.key)).toContain("access");
    expect(mocks.loadConfigChanges).not.toHaveBeenCalled();
  });

  test("returns a page of changes plus the trailing-window summary", async () => {
    mocks.readDriftSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1", refreshedAt: "2026-09-03T00:00:00Z", lastRunChanges: 2, totalChanges: 40 });
    mocks.loadConfigChanges.mockResolvedValue([
      { changeId: "v1-0", detectedAt: "2026-09-03T00:00:00Z", pillar: "access", entityType: "permission-scheme", entityId: "1", label: "Prod", changeKind: "modified", summary: 'Permission scheme "Prod" changed: name' },
    ]);
    mocks.loadConfigChangeSummary.mockResolvedValue({ total: 5, byPillar: { access: 5 }, byKind: { added: 2, removed: 1, modified: 2 } });

    const result = await getChangeHistory({ payload: { pillar: "access", limit: 50 }, ...ctx });

    expect(result.neverBuilt).toBe(false);
    expect(result.changes).toHaveLength(1);
    expect(result.summary.total).toBe(5);
    expect(result.nextCursor).toBeNull();
    // pillar filter threaded through; asked for limit+1 to detect a further page
    expect(mocks.loadConfigChanges).toHaveBeenCalledWith("test-install", expect.objectContaining({ pillar: "access", limit: 51 }));
  });

  test("sets nextCursor when a further page exists", async () => {
    mocks.readDriftSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadConfigChanges.mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => ({
        changeId: `v1-${i}`, detectedAt: `2026-09-0${3 - i}T00:00:00Z`, pillar: "workflow",
        entityType: "status", entityId: String(i), label: "S", changeKind: "added", summary: "x",
      }))
    );
    const result = await getChangeHistory({ payload: { limit: 2 }, ...ctx });
    expect(result.changes).toHaveLength(2);
    // Carries the change id: rows of one drift pass share a timestamp.
    expect(result.nextCursor).toBe("2026-09-02T00:00:00Z|v1-1");
  });
});

describe("buildChangeHistory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("queues a drift pass when nothing is running", async () => {
    mocks.readDriftSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.readAdminConfig?.mockResolvedValue?.({ readOnlyMode: false });

    const result = await buildChangeHistory(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueDriftSnapshotBuild).toHaveBeenCalledWith("test-install");
  });

  test("refuses while a live pass is running", async () => {
    mocks.readDriftSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isDriftBuildStale.mockReturnValue(false);

    const result = await buildChangeHistory(ctx);

    expect(result).toMatchObject({ queued: false, reason: "already-building" });
    expect(mocks.queueDriftSnapshotBuild).not.toHaveBeenCalled();
  });
});

describe("getEstateInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("reports never-built when no snapshot exists", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValue(null);
    const result = await getEstateInventory(ctx);
    expect(result).toMatchObject({ neverBuilt: true, resolutions: [], priorities: [] });
    expect(result.governance.available).toBe(false);
    expect(mocks.loadEstateValues).not.toHaveBeenCalled();
  });

  test("returns both lists with the duplicate-name governance summary", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1", refreshedAt: "2026-09-03T00:00:00Z" });
    mocks.loadEstateValues.mockImplementation(async (_k, _v, kind) =>
      kind === "resolution"
        ? [{ id: "1", name: "Done", isDefault: true }, { id: "2", name: "done" }]
        : [{ id: "10", name: "High", isDefault: true }]);

    const result = await getEstateInventory(ctx);

    expect(result.neverBuilt).toBe(false);
    expect(result.resolutions).toHaveLength(2);
    expect(result.governance).toMatchObject({ available: true, resolutionDuplicateGroupCount: 1, reducibleResolutionCount: 1 });
  });

  // The crawl counted issues per value all along; only the Overview attached them, so every
  // row on the tab read "Not measured".
  test("attaches the crawl's issue counts to each value", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadEstateValues.mockImplementation(async (_k, _v, kind) =>
      kind === "resolution" ? [{ id: "1", name: "Done" }] : [{ id: "10", name: "High" }]);
    mocks.loadEstateValueTotals.mockResolvedValueOnce([
      { kind: "resolution", valueId: "1", issueCount: 500 },
      { kind: "resolution", valueId: "", issueCount: 12 },
    ]);

    const result = await getEstateInventory(ctx);

    expect(result.resolutions[0].issueCount).toBe(500);
    expect(result.priorities[0].issueCount).toBe(0);
    expect(result.usageMeasured).toBe(true);
    expect(result.unresolvedIssueCount).toBe(12);
  });

  test("keeps counts unmeasured when the totals cannot be read", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadEstateValues.mockResolvedValue([{ id: "1", name: "Done" }]);
    mocks.loadEstateValueTotals.mockRejectedValueOnce(new Error("sql down"));

    const result = await getEstateInventory(ctx);

    expect(result.resolutions[0].issueCount).toBeNull();
    expect(result.usageMeasured).toBe(false);
  });
});

describe("buildEstateInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("queues a build when nothing is running", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.readAdminConfig?.mockResolvedValue?.({ readOnlyMode: false });

    const result = await buildEstateInventory(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueEstateSnapshotBuild).toHaveBeenCalledWith("test-install");
  });

  test("refuses while a live build is running", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isEstateBuildStale.mockReturnValue(false);

    const result = await buildEstateInventory(ctx);

    expect(result).toMatchObject({ queued: false, reason: "already-building" });
    expect(mocks.queueEstateSnapshotBuild).not.toHaveBeenCalled();
  });
});

describe("getBoardInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("reports never-built when no snapshot exists", async () => {
    mocks.readBoardSnapshotMeta.mockResolvedValue(null);
    const result = await getBoardInventory(ctx);
    expect(result).toMatchObject({ neverBuilt: true, boards: [] });
    expect(result.summary.total).toBe(0);
    expect(mocks.loadBoards).not.toHaveBeenCalled();
  });

  test("joins columns onto boards and summarises the estate", async () => {
    mocks.readBoardSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1", refreshedAt: "2026-09-09T00:00:00Z", boardsUnreadable: 1 });
    mocks.loadBoards.mockResolvedValue([
      { boardId: "1", name: "Scrum", type: "scrum", locationType: "project", locationKey: "AAA", filterId: "4001", configReadable: true, columnCount: 2 },
      { boardId: "2", name: "Mine", type: "kanban", locationType: "user", locationName: "Alex", filterId: null, configReadable: true, columnCount: 1 },
      { boardId: "3", name: "TM", type: "simple", locationType: "project", locationKey: "BBB", filterId: null, configReadable: false, columnCount: 0 },
    ]);
    mocks.loadBoardColumns.mockResolvedValue([
      { boardId: "1", index: 0, name: "To Do", statusIds: ["1"] },
      { boardId: "1", index: 1, name: "Done", statusIds: ["5"] },
      { boardId: "2", index: 0, name: "Backlog", statusIds: [] },
    ]);

    const result = await getBoardInventory(ctx);

    expect(result.neverBuilt).toBe(false);
    expect(result.boards).toHaveLength(3);
    expect(result.boards.find((b) => b.boardId === "1").columns).toHaveLength(2);
    expect(result.boards.find((b) => b.boardId === "2").unmappedColumns).toBe(1);
    expect(result.summary).toMatchObject({
      total: 3,
      personal: 1,
      unreadable: 1,
      // board 2: config readable, no filter
      missingFilter: 1,
      totalColumns: 3,
    });
    expect(result.summary.byType).toEqual({ scrum: 1, kanban: 1, simple: 1 });
  });

  test("joins against the filter and status snapshots and flags a deleted backing filter", async () => {
    mocks.readBoardSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1", refreshedAt: "x" });
    mocks.loadBoards.mockResolvedValue([
      { boardId: "1", name: "Scrum", type: "scrum", locationType: "project", locationKey: "AAA", filterId: "GONE", configReadable: true, columnCount: 1 },
    ]);
    mocks.loadBoardColumns.mockResolvedValue([{ boardId: "1", index: 0, name: "To Do", statusIds: ["1", "deleted"] }]);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "fv1" });
    mocks.loadFilters.mockResolvedValue([{ id: "4001", ownerActive: true }]); // no filter GONE
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "wv1" });
    mocks.loadStatusesCatalog.mockResolvedValue([{ id: "1", name: "To Do" }]); // no status "deleted"

    const result = await getBoardInventory(ctx);

    expect(result.insights).toMatchObject({ missingFilter: 1, staleColumnBoards: 1, joinedFilters: true, joinedStatuses: true });
    expect(result.summary.brokenFilter).toBe(1);
    expect(result.summary.staleColumnBoards).toBe(1);
    // Per-board codes, uncapped, for the pillar report.
    expect(result.boards[0].issues).toEqual(["backing-filter-deleted", "stale-column-status"]);
  });

  test("reports the joins as not-run when the other snapshots are absent", async () => {
    mocks.readBoardSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1", refreshedAt: "x" });
    mocks.loadBoards.mockResolvedValue([{ boardId: "1", name: "B", type: "scrum", locationType: "project", filterId: "4001", configReadable: true, columnCount: 0 }]);
    mocks.loadBoardColumns.mockResolvedValue([]);
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    mocks.readWorkflowSnapshotMeta.mockResolvedValue(null);

    const result = await getBoardInventory(ctx);
    expect(result.insights).toMatchObject({ joinedFilters: false, joinedStatuses: false, missingFilter: 0 });
  });
});

describe("runOqlQuery", () => {
  const ctx = (query) => ({ payload: { query }, context: { installContext: "ari:cloud:jira::site/x" } });
  const screen = (i, fieldCount, over = {}) => ({ screenId: String(i), name: `S${i}`, tabCount: 1, fieldCount, tabsResolved: "resolved", ...over });

  function mockScreens() {
    mocks.readScreenSnapshotMeta.mockResolvedValueOnce({ version: "sv1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce(null);
    mocks.loadScreensPage.mockResolvedValueOnce({
      rows: [screen(1, 40), screen(2, 30), screen(3, 2), screen(4, 5), screen(5, 12), screen(6, 25), screen(7, 8), screen(8, 1)],
    });
    // Screen 1 reaches one project -- the bottom quarter -- and carries the most fields.
    mocks.loadScreenSchemeOperations.mockResolvedValueOnce([
      { schemeId: "ss1", screenId: "1" }, { schemeId: "ss2", screenId: "2" }, { schemeId: "ss2", screenId: "6" },
      { schemeId: "ss3", screenId: "5" }, { schemeId: "ss4", screenId: "7" },
      { schemeId: "ss2", screenId: "3" }, { schemeId: "ss2", screenId: "4" }, { schemeId: "ss2", screenId: "8" },
    ]);
    mocks.loadItssMappings.mockResolvedValueOnce([
      { itssId: "i1", screenSchemeId: "ss1" }, { itssId: "i2", screenSchemeId: "ss2" }, { itssId: "i3", screenSchemeId: "ss3" }, { itssId: "i4", screenSchemeId: "ss4" },
    ]);
    mocks.loadItssProjects.mockResolvedValueOnce([
      { itssId: "i1", projectId: "P1" },
      ...["P1", "P2", "P3", "P4", "P5"].map((projectId) => ({ itssId: "i2", projectId })),
      { itssId: "i3", projectId: "P1" }, { itssId: "i3", projectId: "P2" },
      { itssId: "i4", projectId: "P3" }, { itssId: "i4", projectId: "P4" }, { itssId: "i4", projectId: "P5" },
    ]);
  }

  test("returns a parse error without loading anything", async () => {
    const result = await runOqlQuery(ctx("pilar = screens"));
    expect(result).toEqual({ ok: false, error: { message: 'Unknown field "pilar". Did you mean "pillar"?', start: 0, end: 5 } });
    expect(mocks.readScreenSnapshotMeta).not.toHaveBeenCalled();
  });

  test("answers the headline query, loading only the pinned pillar", async () => {
    mockScreens();
    const result = await runOqlQuery(ctx("pillar = screens AND usage = low AND impact = high"));
    expect(result.ok).toBe(true);
    expect(result.results.map((r) => r.id)).toEqual(["1"]);
    expect(result.results[0]).toMatchObject({ pillar: "screens", usage: "low", impact: "high", usageValue: 1, impactValue: 40 });
    expect(result.pillars.map((p) => p.key)).toEqual(["screens"]);
    expect(result.thresholds.screens.usage.label).toMatch(/screen schemes/);
    expect(mocks.readFilterSnapshotMeta).not.toHaveBeenCalled();
  });

  test("an unpinned query searches every pillar and names the ones it could not", async () => {
    const result = await runOqlQuery(ctx("usage = low"));
    expect(result.ok).toBe(true);
    expect(result.pillars.map((p) => p.key)).toEqual([
      "fields", "projects", "workflows", "issueTypes", "priorities", "people", "assets", "access",
      "screens", "filters", "dashboards", "boards", "automation",
    ]);
    expect(result.pillars.filter((p) => p.status === "unavailable" && !p.reason)).toEqual([]);
    expect(result.pillars.some((p) => p.status === "unavailable")).toBe(true);
  });

  test("a pillar that throws is reported unavailable, not dropped", async () => {
    mocks.readScreenSnapshotMeta.mockRejectedValueOnce(new Error("sql down"));
    const result = await runOqlQuery(ctx("pillar = screens"));
    expect(result.pillars).toEqual([expect.objectContaining({ key: "screens", status: "unavailable", reason: expect.stringMatching(/could not be read/) })]);
  });

  test("orders results and lists the finding codes present", async () => {
    mockScreens();
    const result = await runOqlQuery(ctx("pillar = screens ORDER BY fields DESC"));
    expect(result.results.map((r) => r.id).slice(0, 3)).toEqual(["1", "2", "6"]);
    expect(result).toMatchObject({ total: 8, truncated: false });
    expect(Array.isArray(result.discoveryCodes)).toBe(true);
  });

  test("churn is unmeasured when no drift pass has run, and counted from the change log when one has", async () => {
    mockScreens();
    mocks.readDriftSnapshotMeta.mockResolvedValueOnce(null);
    const without = await runOqlQuery(ctx("pillar = screens"));
    expect(without.churnMeasured).toBe(false);

    mocks.readSnapshotMeta.mockResolvedValueOnce(null);
    mocks.readDriftSnapshotMeta.mockResolvedValueOnce({ version: "d1" });
    mocks.loadConfigChanges.mockResolvedValueOnce([{ entityType: "field", entityId: "x", detectedAt: new Date().toISOString() }]);
    const withDrift = await runOqlQuery(ctx("pillar = fields"));
    expect(withDrift.churnMeasured).toBe(true);
    expect(mocks.loadConfigChanges).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ limit: 500, since: expect.any(String) }));
  });
});

describe("getPillarReport", () => {
  const ctx = (pillar) => ({ payload: { pillar }, context: { installContext: "ari:cloud:jira::site/x" } });

  test("rejects a missing or unknown pillar", async () => {
    await expect(getPillarReport(ctx(""))).rejects.toThrow();
    await expect(getPillarReport(ctx("nope"))).rejects.toThrow(/Unknown pillar report/);
  });

  test("an unbuilt pillar is explicitly unavailable, never an empty report", async () => {
    mocks.readBoardSnapshotMeta.mockResolvedValueOnce(null);
    const report = await getPillarReport(ctx("boards"));
    expect(report).toMatchObject({ pillar: "boards", status: "unavailable", rows: [] });
    expect(report.reason).toMatch(/board inventory/);
  });

  test("boards: reuses the inventory read and carries its per-board findings", async () => {
    mocks.readBoardSnapshotMeta.mockResolvedValueOnce({ state: "ready", version: "v1", refreshedAt: "2026-09-09T00:00:00Z" });
    mocks.loadBoards.mockResolvedValueOnce([
      { boardId: "1", name: "Clean", type: "scrum", filterId: "4001", configReadable: true, columnCount: 1 },
      { boardId: "2", name: "Orphan", type: "kanban", filterId: null, configReadable: true, columnCount: 0 },
    ]);
    mocks.loadBoardColumns.mockResolvedValueOnce([{ boardId: "1", index: 0, name: "To Do", statusIds: ["1"] }]);

    const report = await getPillarReport(ctx("boards"));

    expect(report).toMatchObject({ status: "ok", refreshedAt: "2026-09-09T00:00:00Z", total: 2, flaggedCount: 1 });
    expect(report.rows[0]).toMatchObject({ id: "2", findings: ["no-backing-filter"] });
  });

  test("filters: every filter with its analysis findings, not one page", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValueOnce({ version: "fv1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.readSnapshotMeta.mockResolvedValueOnce(null);
    mocks.readIssueTypeSnapshotMeta.mockResolvedValueOnce(null);
    mocks.loadFilters.mockResolvedValueOnce(Array.from({ length: 30 }, (_, i) => ({
      id: String(i), name: `F${i}`, ownerAccountId: "a", ownerName: "Ann", ownerActive: i !== 7, owner: { accountId: "a", displayName: "Ann", active: i !== 7 }, shares: [], subscriptionCount: 0, lastUsedAt: "2026-08-01T00:00:00Z",
    })));

    const report = await getPillarReport(ctx("filters"));

    expect(report.total).toBe(30);
    expect(report.rows[0]).toMatchObject({ id: "7", findings: ["orphaned-owner"] });
  });

  test("screens: pages through every screen and marks the unreached ones", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValueOnce({ version: "sv1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce({ version: "wv1", transitionScreens: 4 });
    const full = Array.from({ length: 200 }, (_, i) => ({ screenId: String(i), name: `S${i}`, tabCount: 1, fieldCount: 3, tabsResolved: "resolved" }));
    mocks.loadScreensPage
      .mockResolvedValueOnce({ rows: full })
      .mockResolvedValueOnce({ rows: [{ screenId: "200", name: "Last", tabCount: 1, fieldCount: 0, tabsResolved: "resolved" }] })
      .mockResolvedValueOnce({ rows: [{ screenId: "5" }] });

    const report = await getPillarReport(ctx("screens"));

    expect(report.total).toBe(201);
    expect(mocks.loadScreensPage).toHaveBeenCalledTimes(3);
    expect(mocks.loadScreensPage.mock.calls[2][2]).toMatchObject({ filter: "unreached", workflowVersion: "wv1" });
    const flagged = Object.fromEntries(report.rows.filter((r) => r.findings.length).map((r) => [r.id, r.findings]));
    expect(flagged).toEqual({ 200: ["empty"], 5: ["unreached"] });
  });

  // A workflow snapshot that never read transitions cannot say a screen is unreached: every
  // screen a transition opens would be listed for deletion.
  test("screens: reachability is skipped when the workflow build never read transitions", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValueOnce({ version: "sv1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce({ version: "wv1", transitionScreens: null });
    mocks.loadScreensPage.mockResolvedValueOnce({ rows: [{ screenId: "5", name: "Resolve screen", tabCount: 1, fieldCount: 4, tabsResolved: "resolved" }] });

    const report = await getPillarReport(ctx("screens"));

    expect(mocks.loadScreensPage).toHaveBeenCalledTimes(1);
    expect(mocks.loadScreensPage.mock.calls[0][2]).toMatchObject({ workflowVersion: null });
    expect(report.rows.every((r) => !r.findings.includes("unreached"))).toBe(true);
  });

  test("automation: unavailable until the rule directory has been imported", async () => {
    mocks.readAutomationPart.mockResolvedValueOnce(null);
    const report = await getPillarReport(ctx("automation"));
    expect(report.status).toBe("unavailable");
    expect(report.reason).toMatch(/Automation tab/);
  });

  test("automation: rules from the directory, risks from the analysis preview", async () => {
    mocks.readAutomationAnalysis.mockResolvedValueOnce({ refreshedAt: Date.UTC(2026, 8, 1), findingsPreview: [{ id: 11, r: [{ c: "secret" }] }], findingsTotal: 1 });
    mocks.readAutomationPart.mockResolvedValueOnce({ rules: [[11, "Notify", 1, "jira:issue_created", 3, "acc"], [12, "Idle", 0, null, 0, null]] });

    const report = await getPillarReport(ctx("automation"));

    expect(report).toMatchObject({ status: "ok", total: 2, refreshedAt: "2026-09-01T00:00:00.000Z" });
    expect(report.rows[0]).toMatchObject({ id: 11, enabled: true, findings: ["secret"] });
  });

  test("changes: keyset-pages the trailing window", async () => {
    mocks.readDriftSnapshotMeta.mockResolvedValueOnce({ version: "d1", refreshedAt: "2026-09-02T00:00:00Z" });
    const page = Array.from({ length: 500 }, (_, i) => ({ changeId: String(i), detectedAt: `2026-09-01T00:00:${String(i % 60).padStart(2, "0")}Z`, pillar: "fields", changeKind: "added" }));
    mocks.loadConfigChanges
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([{ changeId: "x", detectedAt: "2026-08-30T00:00:00Z", pillar: "fields", changeKind: "removed" }]);

    const report = await getPillarReport(ctx("changes"));

    expect(report.total).toBe(501);
    expect(mocks.loadConfigChanges.mock.calls[1][1]).toMatchObject({ before: `${page[499].detectedAt}|${page[499].changeId}`, limit: 500 });
    expect(mocks.loadConfigChanges.mock.calls[0][1].since).toEqual(expect.any(String));
    expect(report.columns.some((c) => c.key === "findings")).toBe(false);
  });

  test("assets: an unlicensed site says so rather than reporting unbuilt", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValueOnce({ state: "unavailable" });
    const report = await getPillarReport(ctx("assets"));
    expect(report.reason).toMatch(/not available on this site/);
  });

  test.each([
    ["fields", "readSnapshotMeta", /field inventory/],
    ["projects", "readSnapshotMeta", /project inventory/],
    ["workflows", "readWorkflowSnapshotMeta", /workflow inventory/],
    ["issueTypes", "readIssueTypeSnapshotMeta", /issue type inventory/],
    ["priorities", "readEstateSnapshotMeta", /priority and resolution/],
    ["people", "readUserSnapshotMeta", /people inventory/],
    ["assets", "readAssetSnapshotMeta", /Assets inventory/],
    ["access", "readAccessSnapshotMeta", /access inventory/],
    ["screens", "readScreenSnapshotMeta", /screen inventory/],
    ["filters", "readFilterSnapshotMeta", /saved filter inventory/],
    ["dashboards", "readDashboardSnapshotMeta", /dashboard inventory/],
    ["changes", "readDriftSnapshotMeta", /drift pass/],
  ])("%s is unavailable until its snapshot exists", async (pillar, metaMock, reason) => {
    mocks[metaMock].mockResolvedValueOnce(null);
    const report = await getPillarReport(ctx(pillar));
    expect(report).toMatchObject({ pillar, status: "unavailable", rows: [] });
    expect(report.reason).toMatch(reason);
  });

  test("fields: every snapshot field, hydrated for governance", async () => {
    mocks.readSnapshotMeta.mockResolvedValueOnce({ version: "v1", completedAt: "2026-09-01T00:00:00Z" });
    mocks.loadSnapshotFields.mockResolvedValueOnce([
      { id: "customfield_1", name: "Team", type: "select", configuredProjectCount: 0, totalIssueCount: 0, activeProjectCount: 0 },
      { id: "customfield_2", name: "Budget", type: "number", configuredProjectCount: 1, totalIssueCount: 40, activeProjectCount: 1 },
    ]);

    const report = await getPillarReport(ctx("fields"));

    expect(report).toMatchObject({ status: "ok", total: 2, refreshedAt: "2026-09-01T00:00:00Z" });
    expect(report.rows.find((r) => r.id === "customfield_1").findings).toContain("orphaned");
  });

  test("projects: snapshot projects with adoption, unmeasured when no activity was captured", async () => {
    mocks.readSnapshotMeta.mockResolvedValueOnce({ version: "v1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.listSnapshotProjects.mockResolvedValueOnce([{ projectId: "1", projectKey: "AAA", projectName: "Alpha", fieldCount: 3 }]);
    mocks.loadProjectActivity.mockResolvedValueOnce(new Map());

    const report = await getPillarReport(ctx("projects"));

    expect(report.rows[0]).toMatchObject({ key: "AAA", fields: 3, adoption: null, findings: [] });
    expect(report.notes[0]).toMatch(/unmeasured/);
  });

  test("issueTypes: the catalogue with scheme membership for the orphan check", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValueOnce({ state: "ready", version: "v1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.loadIssueTypes.mockResolvedValueOnce([
      { id: "1", name: "Story", hierarchyLevel: 0 },
      { id: "2", name: "Lonely", hierarchyLevel: 0 },
    ]);
    mocks.loadIssueTypeSchemes.mockResolvedValueOnce([]);
    mocks.loadIssueTypeSchemeItems
      .mockResolvedValueOnce([{ schemeId: "s", issueTypeId: "1" }])
      .mockResolvedValueOnce([{ schemeId: "s", issueTypeId: "1" }]);
    mocks.loadIssueTypeSchemeProjects.mockResolvedValueOnce([]);
    mocks.loadIssueTypeGovernanceSummary.mockResolvedValueOnce({});
    mocks.readScreenSnapshotMeta.mockResolvedValueOnce(null);
    mocks.readIssueScanMeta.mockResolvedValueOnce(null);

    const report = await getPillarReport(ctx("issueTypes"));

    expect(report.rows[0]).toMatchObject({ id: "2", findings: ["no-scheme"] });
    expect(mocks.loadIssueTypeSchemeItems).toHaveBeenLastCalledWith("test-install", "v1");
  });

  test("priorities: both value lists from the estate inventory", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValueOnce({ state: "ready", version: "v1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.loadEstateValues
      .mockResolvedValueOnce([{ id: "1", name: "Done" }, { id: "2", name: "done" }])
      .mockResolvedValueOnce([{ id: "10", name: "High", isDefault: true }]);

    const report = await getPillarReport(ctx("priorities"));

    expect(report).toMatchObject({ total: 3, flaggedCount: 2 });
  });

  test("people: the roster with ownership counts", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValueOnce({ state: "ready", version: "v1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.loadUsers.mockResolvedValueOnce([{ accountId: "a1", displayName: "Ann", active: true, applications: [], groups: [] }]);
    mocks.loadUserGovernanceSummary.mockResolvedValueOnce({ totalUsers: 1 });

    const report = await getPillarReport(ctx("people"));

    expect(report.rows[0]).toMatchObject({ accountId: "a1", active: true, findings: [] });
  });

  test("assets: object types from a built structure snapshot", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValueOnce({ state: "ready", version: "v1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.loadAssetSchemas.mockResolvedValueOnce([{ id: "s1", name: "IT", objectTypeCount: 1, objectCount: 4 }]);
    mocks.loadAssetObjectTypes.mockResolvedValueOnce([{ id: "t1", schemaId: "s1", name: "Laptop" }]);
    mocks.loadAssetAttributes.mockResolvedValueOnce([]);
    mocks.loadAssetTypeCounts.mockResolvedValueOnce([]);
    mocks.readAssetTypeCountMeta.mockResolvedValueOnce(null);

    const report = await getPillarReport(ctx("assets"));

    expect(report.rows[0]).toMatchObject({ schema: "IT", name: "Laptop", findings: ["no-custom-attributes"] });
  });

  test("access: every scheme family flattened into one table", async () => {
    mocks.readAccessSnapshotMeta.mockResolvedValueOnce({ state: "ready", version: "v1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.readUserSnapshotMeta.mockResolvedValueOnce(null);
    const byType = { permission: [{ id: "p1", name: "Spare" }], security: [], notification: [], "project-role": [{ id: "r1", name: "Admins" }] };
    for (let i = 0; i < 4; i += 1) {
      mocks.loadSchemes.mockImplementationOnce(async (_k, _v, type) => byType[type] || []);
      mocks.loadSchemeHolders.mockResolvedValueOnce([]);
    }
    for (let i = 0; i < 3; i += 1) mocks.loadSchemeProjects.mockResolvedValueOnce([]);
    mocks.loadSchemeLevels.mockResolvedValueOnce([]);

    const report = await getPillarReport(ctx("access"));

    const byId = Object.fromEntries(report.rows.map((r) => [r.id, r]));
    expect(byId.p1).toMatchObject({ type: "Permission scheme", findings: ["unassigned-scheme"] });
    expect(byId.r1).toMatchObject({ type: "Project role", findings: ["no-actors"] });
  });

  test("dashboards: every dashboard with its analysis findings", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValueOnce({ version: "d1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.loadDashboards.mockResolvedValueOnce([
      { id: "1", name: "Blank", gadgetCount: 0, owner: { accountId: "a", active: true }, shares: [], editShares: [] },
    ]);

    const report = await getPillarReport(ctx("dashboards"));

    expect(report.rows[0].findings).toContain("empty");
  });

  test("screens: reachability is skipped, and caveated, without a workflow snapshot", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValueOnce({ version: "sv1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce(null);
    mocks.loadScreensPage.mockResolvedValueOnce({ rows: [{ screenId: "1", name: "S", tabCount: 1, fieldCount: 2, tabsResolved: "resolved" }] });

    const report = await getPillarReport(ctx("screens"));

    expect(mocks.loadScreensPage).toHaveBeenCalledTimes(1);
    expect(report.notes[0]).toMatch(/not checked/);
  });

  test("workflows: schemes with the status catalogue size", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce({ version: "wv1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.loadWorkflowSchemes.mockResolvedValueOnce([{ id: "1", name: "Idle", projectCount: 0 }]);
    mocks.loadStatusesCatalog.mockResolvedValueOnce([{ id: "1" }, { id: "2" }]);

    const report = await getPillarReport(ctx("workflows"));

    expect(report.rows[0].findings).toEqual(["unused-scheme"]);
    expect(report.summary.find((t) => t.label === "Statuses").value).toBe(2);
  });
});

describe("buildBoardInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("queues a build when nothing is running", async () => {
    mocks.readBoardSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.readAdminConfig?.mockResolvedValue?.({ readOnlyMode: false });

    const result = await buildBoardInventory(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueBoardSnapshotBuild).toHaveBeenCalledWith("test-install");
  });

  test("refuses while a live build is running", async () => {
    mocks.readBoardSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isBoardBuildStale.mockReturnValue(false);

    const result = await buildBoardInventory(ctx);

    expect(result).toMatchObject({ queued: false, reason: "already-building" });
    expect(mocks.queueBoardSnapshotBuild).not.toHaveBeenCalled();
  });
});

// The cascade cap is the defect these exist to prevent recurring. 150 of this site's 1,457
// edges were stored, the tab said so in a footnote, and the remaining 1,307 were unreachable
// by any means at all.
describe("getAutomationCascades", () => {
  beforeEach(() => {
    mocks.loadCascadeSummary.mockResolvedValue({ edges: 1457, pairs: 1143, selfTriggeringRules: 123, fields: 214 });
    mocks.loadCascades.mockResolvedValue({ cascades: [{ sourceId: "1", targetId: "2", fields: ["A"] }], total: 1143 });
  });

  test("returns a page against the whole edge set, not a stored slice", async () => {
    const result = await getAutomationCascades({ payload: { page: 2, pageSize: 50 }, context: ctxWithAccount() });

    expect(result).toMatchObject({ available: true, total: 1143, page: 2 });
    expect(result.summary.edges).toBe(1457);
    expect(mocks.loadCascades).toHaveBeenCalledWith("test-install", expect.objectContaining({ limit: 50, offset: 50 }));
  });

  test("bounds the page size rather than trusting the payload", async () => {
    await getAutomationCascades({ payload: { page: 1, pageSize: 5000 }, context: ctxWithAccount() });
    expect(mocks.loadCascades).toHaveBeenCalledWith("test-install", expect.objectContaining({ limit: 200 }));
  });

  test("rejects an unknown filter value instead of passing it through", async () => {
    await getAutomationCascades({ payload: { kind: "'; DROP TABLE" }, context: ctxWithAccount() });
    expect(mocks.loadCascades).toHaveBeenCalledWith("test-install", expect.objectContaining({ kind: "all" }));
  });

  test("defaults an unrecognised direction to the source end", async () => {
    await getAutomationCascades({ payload: { ruleId: "7", direction: "sideways" }, context: ctxWithAccount() });
    expect(mocks.loadCascades).toHaveBeenCalledWith("test-install", expect.objectContaining({ direction: "source" }));
  });

  // Zero edges and no analysis are different states. A site whose rules genuinely cascade
  // nowhere should read as clean rather than as unbuilt.
  test("reports unavailable when nothing has been imported", async () => {
    mocks.loadCascadeSummary.mockResolvedValue({ edges: 0, pairs: 0, selfTriggeringRules: 0, fields: 0 });
    const result = await getAutomationCascades({ payload: {}, context: ctxWithAccount() });
    expect(result.available).toBe(false);
  });
});

describe("getAutomationBlast", () => {
  beforeEach(() => {
    mocks.loadBlastRules.mockResolvedValue({
      rules: [{ ruleId: "1", name: "Sweep", score: 88, tier: "estate", estimated: true, credential: false, factors: [], modifiers: [] }],
      total: 1,
    });
  });

  test("returns a page ordered by blast score", async () => {
    const result = await getAutomationBlast({ payload: { page: 2, pageSize: 50 }, context: ctxWithAccount() });
    expect(result).toMatchObject({ available: true, total: 1, page: 2 });
    expect(mocks.loadBlastRules).toHaveBeenCalledWith("test-install", expect.objectContaining({ limit: 50, offset: 50 }));
  });

  test("bounds the page size rather than trusting the payload", async () => {
    await getAutomationBlast({ payload: { page: 1, pageSize: 9000 }, context: ctxWithAccount() });
    expect(mocks.loadBlastRules).toHaveBeenCalledWith("test-install", expect.objectContaining({ limit: 200 }));
  });

  test("passes a tier filter through", async () => {
    await getAutomationBlast({ payload: { tier: "estate" }, context: ctxWithAccount() });
    expect(mocks.loadBlastRules).toHaveBeenCalledWith("test-install", expect.objectContaining({ tier: "estate" }));
  });

  test("is admin-only", () => {
    expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toContain("getAutomationBlast");
    expect(Object.keys(SHARED_RESOLVER_FUNCTIONS)).not.toContain("getAutomationBlast");
  });

  test("propagates a store failure rather than swallowing it", async () => {
    mocks.loadBlastRules.mockRejectedValueOnce(new Error("sql down"));
    await expect(getAutomationBlast({ payload: {}, context: ctxWithAccount() })).rejects.toThrow("sql down");
  });

  test("reports available on a later page even when this page is empty", async () => {
    mocks.loadBlastRules.mockResolvedValueOnce({ rules: [], total: 0 });
    const result = await getAutomationBlast({ payload: { page: 3 }, context: ctxWithAccount() });
    expect(result.available).toBe(true);
  });
});

describe("createRemediationEpic", () => {
  const ITEMS = [
    { id: "4001", name: "Open Bugs", ownerName: "Gone Person", ownerActive: false },
    { id: "4002", name: "Sprint Board Filter" },
  ];

  beforeEach(() => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: false, remediation: { projectKey: "ADMIN", epicIssueType: "Epic", taskIssueType: "Task", defaultAssigneeAccountId: "" } });
    mocks.getRemediationEpic.mockResolvedValue(null);
    mocks.loadTicketedItemIds.mockResolvedValue(new Set());
    mocks.createJiraIssue.mockImplementation(async (fields) => ({
      id: "1" + Math.random().toString().slice(2, 7),
      key: fields.parent ? `ADMIN-T${Math.floor(Math.random() * 999)}` : "ADMIN-1",
      self: "https://x",
    }));
  });

  test("refuses an unknown finding key", async () => {
    const r = await createRemediationEpic({ payload: { findingKey: "not-real", items: ITEMS }, context: ctxWithAccount() });
    expect(r.error).toMatch(/No remediation playbook/);
    expect(mocks.createJiraIssue).not.toHaveBeenCalled();
  });

  test("refuses when read-only mode is on", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true, remediation: { projectKey: "ADMIN" } });
    const r = await createRemediationEpic({ payload: { findingKey: "filter-ownership", items: ITEMS }, context: ctxWithAccount() });
    expect(r.error).toMatch(/Read-only mode/);
  });

  test("refuses when no remediation project is configured", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: false, remediation: { projectKey: "" } });
    const r = await createRemediationEpic({ payload: { findingKey: "filter-ownership", items: ITEMS }, context: ctxWithAccount() });
    expect(r.error).toMatch(/No remediation project/);
  });

  test("creates the epic then a task per item, records every ticket, and returns a summary", async () => {
    const r = await createRemediationEpic({ payload: { findingKey: "filter-ownership", items: ITEMS }, context: ctxWithAccount("admin-1") });

    expect(r).toMatchObject({ ok: true, epicKey: "ADMIN-1", epicCreated: true, tasksCreated: 2, itemsTotal: 2, itemsRemaining: 0 });
    // 1 epic + 2 tasks
    expect(mocks.createJiraIssue).toHaveBeenCalledTimes(3);
    // Epic first, no parent; tasks carry parent + the reporter is the caller.
    const [epicFields, epicOpts] = mocks.createJiraIssue.mock.calls[0];
    expect(epicOpts).toEqual({ asUser: true });
    expect(epicFields.parent).toBeUndefined();
    expect(epicFields.reporter).toEqual({ id: "admin-1" });
    expect(epicFields.labels).toEqual(["observatory-remediation", "filters"]);
    expect(epicFields.description).toMatchObject({ type: "doc", version: 1 });
    const [taskFields] = mocks.createJiraIssue.mock.calls[1];
    expect(taskFields.parent).toEqual({ key: "ADMIN-1" });
    expect(mocks.recordRemediationTicket).toHaveBeenCalledTimes(3);
  });

  test("is idempotent: an existing epic is reused and only un-ticketed items get a task", async () => {
    mocks.getRemediationEpic.mockResolvedValue({ issueKey: "ADMIN-1", issueId: "10001" });
    mocks.loadTicketedItemIds.mockResolvedValue(new Set(["4001"]));

    const r = await createRemediationEpic({ payload: { findingKey: "filter-ownership", items: ITEMS }, context: ctxWithAccount() });

    expect(r.epicCreated).toBe(false);
    expect(r.tasksCreated).toBe(1);
    // Only the task create, no epic create.
    expect(mocks.createJiraIssue).toHaveBeenCalledTimes(1);
    expect(mocks.createJiraIssue.mock.calls[0][0].parent).toEqual({ key: "ADMIN-1" });
  });

  test("a task-create failure is collected, not thrown, and the others still land", async () => {
    mocks.createJiraIssue
      .mockResolvedValueOnce({ id: "1", key: "ADMIN-1" })            // epic
      .mockRejectedValueOnce(Object.assign(new Error("field 'parent' cannot be set"), { status: 400 }))
      .mockResolvedValueOnce({ id: "3", key: "ADMIN-T2" });          // second task

    const r = await createRemediationEpic({ payload: { findingKey: "filter-ownership", items: ITEMS }, context: ctxWithAccount() });

    expect(r.ok).toBe(true);
    expect(r.tasksCreated).toBe(1);
    expect(r.failures).toEqual([{ itemId: "4001", error: expect.stringContaining("parent") }]);
  });

  test("caps the synchronous batch and reports the remainder", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, name: `Filter ${i}` }));
    const r = await createRemediationEpic({ payload: { findingKey: "filter-ownership", items: many }, context: ctxWithAccount() });
    expect(r.tasksCreated).toBe(20);
    expect(r.itemsRemaining).toBe(10);
  });

  test("a failure creating the epic itself aborts with an error and no tasks", async () => {
    mocks.createJiraIssue.mockRejectedValueOnce(Object.assign(new Error("project ADMIN not found"), { status: 404 }));
    const r = await createRemediationEpic({ payload: { findingKey: "filter-ownership", items: ITEMS }, context: ctxWithAccount() });
    expect(r.error).toMatch(/Creating the epic failed.*ADMIN not found/);
    expect(mocks.recordRemediationTicket).not.toHaveBeenCalled();
  });

  test("one epic per quarter: the summary names it, and lookup and dedupe are by it", async () => {
    await createRemediationEpic({ payload: { findingKey: "filter-ownership", items: ITEMS }, context: ctxWithAccount() });
    expect(mocks.getRemediationEpic).toHaveBeenCalledWith("test-install", "filter-ownership", "2026-Q3");
    expect(mocks.loadTicketedItemIds).toHaveBeenCalledWith("test-install", "filter-ownership", "2026-Q3");
    expect(mocks.createJiraIssue.mock.calls[0][0].summary).toMatch(/^2026-Q3: Reassign 2 saved filters/);
    expect(mocks.recordRemediationTicket.mock.calls.every(([, row]) => row.period === "2026-Q3")).toBe(true);
  });

  // The ADF link nodes a ticket description carries.
  const linksIn = (doc) => JSON.stringify(doc).match(/"href":"[^"]+"/g) || [];

  test("every ticket links straight to the thing it is about", async () => {
    await createRemediationEpic({ payload: { findingKey: "filter-ownership", items: ITEMS }, context: ctxWithAccount() });
    const [taskFields] = mocks.createJiraIssue.mock.calls[1];
    expect(linksIn(taskFields.description)).toContain('"href":"https://test.atlassian.net/issues/?filter=4001"');
  });

  test("the invocation's own site URL wins over serverInfo", async () => {
    const context = { ...ctxWithAccount(), siteUrl: "https://acme.atlassian.net" };
    await createRemediationEpic({ payload: { findingKey: "filter-ownership", items: ITEMS }, context });
    expect(linksIn(mocks.createJiraIssue.mock.calls[1][0].description)[0]).toMatch(/acme\.atlassian\.net/);
  });

  test("with no site URL at all, tickets are still created -- just without links", async () => {
    mocks.getSiteBaseUrl.mockResolvedValueOnce(null);
    const r = await createRemediationEpic({ payload: { findingKey: "filter-ownership", items: ITEMS }, context: ctxWithAccount() });
    expect(r.ok).toBe(true);
    expect(linksIn(mocks.createJiraIssue.mock.calls[1][0].description)).toEqual([]);
  });

  test("is admin-only and audited", () => {
    expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toContain("createRemediationEpic");
    expect(Object.keys(SHARED_RESOLVER_FUNCTIONS)).not.toContain("createRemediationEpic");
  });
});

describe("getRemediationMetrics", () => {
  test("computes progress over this quarter's tasks, labelled from the playbook catalog", async () => {
    // The store mock pins the period; the test must use the same one, not today's date,
    // or it fails every time a real quarter turns over.
    const period = mocks.currentPeriod();
    mocks.loadRemediationTickets.mockResolvedValueOnce([
      { findingKey: "filter-ownership", period, isEpic: true, issueKey: "ADMIN-1" },
      { findingKey: "filter-ownership", period, isEpic: false, issueKey: "ADMIN-2", lastStatusCategory: "done", createdAt: new Date().toISOString(), doneAt: new Date().toISOString() },
      { findingKey: "filter-ownership", period, isEpic: false, issueKey: "ADMIN-3", lastStatusCategory: "new", createdAt: new Date().toISOString() },
      { findingKey: "filter-ownership", period: "2020-Q1", isEpic: false, issueKey: "ADMIN-0", lastStatusCategory: "done" },
    ]);

    const m = await getRemediationMetrics({ payload: {}, context: ctxWithAccount() });

    expect(m.scope).toBe("quarter");
    expect(m.totals).toMatchObject({ tasks: 2, open: 1, closed: 1, pctClosed: 50 });
    expect(m.byFinding[0].label).not.toBe("filter-ownership"); // the catalog's label, not the key
  });

  test("covers every quarter when asked, and treats anything else as this quarter", async () => {
    mocks.loadRemediationTickets.mockResolvedValue([
      { findingKey: "filter-ownership", period: "2020-Q1", isEpic: false, issueKey: "ADMIN-0", lastStatusCategory: "done" },
    ]);
    expect((await getRemediationMetrics({ payload: { scope: "all" }, context: ctxWithAccount() })).totals.tasks).toBe(1);
    expect((await getRemediationMetrics({ payload: { scope: "bogus" }, context: ctxWithAccount() })).scope).toBe("quarter");
  });
});

describe("syncRemediationNow", () => {
  // Queued, not run inline: a resolver has seconds and a few thousand tickets need minutes --
  // the same ceiling that silently killed the scheduled sync.
  test("queues a sync-remediation job for the calling installation", async () => {
    const r = await syncRemediationNow({ payload: {}, context: ctxWithAccount() });
    expect(r).toEqual({ queued: true });
    expect(mocks.queuePush).toHaveBeenCalledWith({ body: { jobType: "sync-remediation", installationKey: "test-install" } });
  });

  test("is admin-only", () => {
    expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toContain("syncRemediationNow");
    expect(Object.keys(SHARED_RESOLVER_FUNCTIONS)).not.toContain("syncRemediationNow");
  });
});

describe("getRemediationTickets", () => {
  test("reports when the sync last reached any ticket, and null when it never has", async () => {
    mocks.loadRemediationTickets.mockResolvedValueOnce([
      { findingKey: "filter-ownership", isEpic: false, issueKey: "ADMIN-2", syncedAt: "2026-09-28T16:00:00.000Z" },
      { findingKey: "filter-ownership", isEpic: false, issueKey: "ADMIN-3", syncedAt: "2026-09-29T00:00:00.000Z" },
      { findingKey: "filter-ownership", isEpic: false, issueKey: "ADMIN-4", syncedAt: null },
    ]);
    expect((await getRemediationTickets({ payload: {}, context: ctxWithAccount() })).lastSyncedAt).toBe("2026-09-29T00:00:00.000Z");

    mocks.loadRemediationTickets.mockResolvedValueOnce([
      { findingKey: "filter-ownership", isEpic: false, issueKey: "ADMIN-2", syncedAt: null },
    ]);
    expect((await getRemediationTickets({ payload: {}, context: ctxWithAccount() })).lastSyncedAt).toBeNull();
  });

  test("groups tickets by finding, epic separated from tasks, with open counts", async () => {
    mocks.loadRemediationTickets.mockResolvedValue([
      { findingKey: "filter-ownership", pillar: "filters", isEpic: true, issueKey: "ADMIN-1" },
      { findingKey: "filter-ownership", pillar: "filters", isEpic: false, issueKey: "ADMIN-2", lastStatusCategory: "done" },
      { findingKey: "filter-ownership", pillar: "filters", isEpic: false, issueKey: "ADMIN-3", lastStatusCategory: "indeterminate" },
    ]);

    const r = await getRemediationTickets({ payload: {}, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({ findingKey: "filter-ownership", pillar: "filters", taskCount: 2, openCount: 1 });
    expect(r.groups[0].epic.issueKey).toBe("ADMIN-1");
  });

  test("shows the latest quarter's epic and tasks, and summarises earlier quarters", async () => {
    mocks.loadRemediationTickets.mockResolvedValueOnce([
      { findingKey: "filter-ownership", period: "2026-Q3", isEpic: true, issueKey: "ADMIN-9" },
      { findingKey: "filter-ownership", period: "2026-Q3", isEpic: false, issueKey: "ADMIN-10", lastStatusCategory: "new" },
      { findingKey: "filter-ownership", period: "2026-Q2", isEpic: true, issueKey: "ADMIN-1", lastStatusCategory: "done" },
      { findingKey: "filter-ownership", period: "2026-Q2", isEpic: false, issueKey: "ADMIN-2", lastStatusCategory: "done" },
      { findingKey: "filter-ownership", period: "2026-Q2", isEpic: false, issueKey: "ADMIN-3", lastStatusCategory: "indeterminate" },
      { findingKey: "board-backing", period: "2026-Q2", isEpic: true, issueKey: "ADMIN-20" },
    ]);

    const r = await getRemediationTickets({ payload: {}, context: ctxWithAccount() });

    expect(r.period).toBe("2026-Q3");
    const filters = r.groups.find((g) => g.findingKey === "filter-ownership");
    expect(filters).toMatchObject({ period: "2026-Q3", isCurrent: true, taskCount: 1, openCount: 1 });
    expect(filters.epic.issueKey).toBe("ADMIN-9");
    expect(filters.previousPeriods).toEqual([
      { period: "2026-Q2", epicKey: "ADMIN-1", epicStatusCategory: "done", taskCount: 2, openCount: 1 },
    ]);
    // Only an earlier quarter's epic: not current, so the next create opens this quarter's.
    expect(r.groups.find((g) => g.findingKey === "board-backing")).toMatchObject({ period: "2026-Q2", isCurrent: false });
  });

  test("serves the playbook catalog and the finding index with the tickets", async () => {
    mocks.loadRemediationTickets.mockResolvedValueOnce([]);
    const r = await getRemediationTickets({ payload: {}, context: ctxWithAccount() });
    expect(r.catalog.find((c) => c.key === "role-offroster-actors")).toMatchObject({ pillar: "roles", granularity: "bounded" });
    expect(r.findingIndex["role-empty-admin"]).toBe("role-empty-admin");
    expect(r.findingIndex["filters-orphaned"]).toBe("filter-ownership");
  });

  test("passes a finding filter through and reports unavailable when empty", async () => {
    mocks.loadRemediationTickets.mockResolvedValue([]);
    const r = await getRemediationTickets({ payload: { findingKey: "board-backing" }, context: ctxWithAccount() });
    expect(mocks.loadRemediationTickets).toHaveBeenCalledWith(expect.any(String), "board-backing");
    expect(r.available).toBe(false);
  });
});

describe("getRemediationCandidates", () => {
  test("filter-ownership: returns only filters with an orphaned owner, mapped to what the playbook needs", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "flt1" });
    mocks.loadFilters.mockResolvedValue([
      { id: "4001", name: "Open Bugs", owner: { accountId: "a1", displayName: "Gone Person", active: false }, subscriptionCount: 3, shares: [] },
      { id: "4002", name: "Fine Filter", owner: { accountId: "a2", displayName: "Still Here", active: true }, subscriptionCount: 0, shares: [] },
      { id: "4003", name: "No Owner", owner: null, subscriptionCount: 0, shares: [] },
    ]);

    const r = await getRemediationCandidates({ payload: { findingKey: "filter-ownership" }, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.items.map((i) => i.id).sort()).toEqual(["4001", "4003"]);
    const item = r.items.find((i) => i.id === "4001");
    expect(item).toMatchObject({ name: "Open Bugs", ownerName: "Gone Person", ownerActive: false, subscriptionCount: 3 });
  });

  test("filter-ownership: reports unavailable when there is no filter snapshot yet", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    const r = await getRemediationCandidates({ payload: { findingKey: "filter-ownership" }, context: ctxWithAccount() });
    expect(r).toMatchObject({ available: false, reason: "no-snapshot", items: [] });
  });

  test("dashboard-ownership: returns only dashboards with an orphaned owner", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "d1" });
    mocks.loadDashboards.mockResolvedValue([
      { id: "D1", name: "Wall screen", owner: { accountId: "a1", displayName: "Gone Person", active: false }, popularity: 12, shares: [], editShares: [], gadgetCount: 2 },
      { id: "D2", name: "Fine dash", owner: { accountId: "a2", displayName: "Still Here", active: true }, popularity: 1, shares: [], editShares: [], gadgetCount: 1 },
    ]);

    const r = await getRemediationCandidates({ payload: { findingKey: "dashboard-ownership" }, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.items).toEqual([{ id: "D1", name: "Wall screen", ownerName: "Gone Person", popularity: 12 }]);
  });

  test("a finding with no wired item source says so rather than fabricating a list", async () => {
    const r = await getRemediationCandidates({ payload: { findingKey: "not-a-real-finding" }, context: ctxWithAccount() });
    expect(r).toEqual({ available: false, reason: "not-connected", items: [] });
  });

  test("user-licence-hygiene: only deactivated accounts still holding a licence group", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ version: "u1" });
    mocks.loadUsers.mockResolvedValue([
      { accountId: "a1", displayName: "Gone Person", active: false, groups: [{ id: "g1", name: "jira-software-users" }] },
      { accountId: "a2", displayName: "Still Here", active: true, groups: [{ id: "g1", name: "jira-software-users" }] },
      { accountId: "a3", displayName: "Deactivated, ungrouped", active: false, groups: [] },
    ]);

    const r = await getRemediationCandidates({ payload: { findingKey: "user-licence-hygiene" }, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.items).toEqual([{ id: "a1", accountId: "a1", displayName: "Gone Person", groups: ["jira-software-users"] }]);
  });

  test("user-licence-hygiene: reports unavailable when there is no roster yet", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue(null);
    const r = await getRemediationCandidates({ payload: { findingKey: "user-licence-hygiene" }, context: ctxWithAccount() });
    expect(r).toMatchObject({ available: false, reason: "no-snapshot", items: [] });
  });

  test("user-ownership: flattens filters, dashboards and rules owned by an off-roster account", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ version: "u1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", active: true, groups: [] }]);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "d1" });
    mocks.loadFilters.mockResolvedValue([{ id: "10", name: "Ann filter", ownerAccountId: "a1" }, { id: "11", name: "Ghost filter", ownerAccountId: "gone" }]);
    mocks.loadDashboards.mockResolvedValue([{ dashboardId: "20", name: "Ghost dash", ownerAccountId: "gone" }]);
    mocks.readAutomationPart.mockResolvedValue({ /* hydrateRuleDirectory reads its own shape */ });

    const r = await getRemediationCandidates({ payload: { findingKey: "user-ownership" }, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.items).toEqual(expect.arrayContaining([
      { id: "filter:11", kind: "filter", name: "Ghost filter" },
      { id: "dashboard:20", kind: "dashboard", name: "Ghost dash" },
    ]));
    // Ann's own filter is not orphaned -- she is on the roster.
    expect(r.items.find((i) => i.id === "filter:10")).toBeUndefined();
  });

  test("status-reachability: excludes statuses a rule still transitions into", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1" });
    mocks.loadStatusesCatalog.mockResolvedValue([
      { statusId: "1", id: "1", name: "Dead End" },
      { statusId: "2", id: "2", name: "Rule Only" },
      { statusId: "3", id: "3", name: "In Use" },
    ]);
    // Only status 3 is in a scheme -- 1 and 2 are unreachable. A non-empty scheme->status
    // mapping is what tells the resolver the mapping was actually built, as opposed to an
    // empty result meaning the walk never ran (see the no-scheme-mapping test below).
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([{ schemeId: "s1", statusId: "3" }]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map());
    mocks.loadStatusAutomationReferences.mockResolvedValue({ "rule only": { ruleCount: 1, enabledRuleCount: 1 } });

    const r = await getRemediationCandidates({ payload: { findingKey: "status-reachability" }, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    // No issue-count data was measured, so everCount is unknown, not zero -- a missing
    // count must never render as "safe to delete" on its own.
    expect(r.items).toEqual([{ id: "1", name: "Dead End", category: null, everCount: null }]);
  });

  test("status-reachability: excludes a status a board column still maps", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1" });
    mocks.loadStatusesCatalog.mockResolvedValue([
      { statusId: "1", id: "1", name: "Dead End" },
      { statusId: "2", id: "2", name: "On A Board" },
      { statusId: "3", id: "3", name: "In Use" },
    ]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([{ schemeId: "s1", statusId: "3" }]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map());
    mocks.loadStatusAutomationReferences.mockResolvedValue({});
    mocks.readBoardSnapshotMeta.mockResolvedValue({ version: "b1" });
    mocks.loadBoardColumns.mockResolvedValue([{ boardId: "100", statusIds: ["2"] }]);

    const r = await getRemediationCandidates({ payload: { findingKey: "status-reachability" }, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.items.map((i) => i.id)).toEqual(["1"]);
  });

  // The same finding rovoWorkflowImpact's assessStatusDeletion checks -- a filter reference
  // is one of the three sources that keep a status off this list, alongside rules and boards.
  test("status-reachability: excludes a status a saved filter's JQL still names", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1" });
    mocks.loadStatusesCatalog.mockResolvedValue([
      { statusId: "1", id: "1", name: "Dead End" },
      { statusId: "2", id: "2", name: "Named In A Filter" },
      { statusId: "3", id: "3", name: "In Use" },
    ]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([{ schemeId: "s1", statusId: "3" }]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map());
    mocks.loadStatusAutomationReferences.mockResolvedValue({});
    mocks.readBoardSnapshotMeta.mockResolvedValue({ version: "b1" });
    mocks.loadBoardColumns.mockResolvedValue([]);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.loadFilterReferenceCounts.mockResolvedValue({ "named in a filter": 2 });

    const r = await getRemediationCandidates({ payload: { findingKey: "status-reachability" }, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.items.map((i) => i.id)).toEqual(["1"]);
  });

  test("status-reachability: reports unavailable with no scheme->status mapping", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1" });
    mocks.loadStatusesCatalog.mockResolvedValue([{ statusId: "1", id: "1", name: "Any" }]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([]);
    const r = await getRemediationCandidates({ payload: { findingKey: "status-reachability" }, context: ctxWithAccount() });
    expect(r).toMatchObject({ available: false, reason: "no-scheme-mapping", items: [] });
  });

  test("board-backing: flags a board with no backing filter, not one with only a column issue", async () => {
    mocks.readBoardSnapshotMeta.mockResolvedValue({ version: "b1" });
    mocks.loadBoards.mockResolvedValue([
      { boardId: "100", name: "Orphan Board", type: "scrum", configReadable: true, filterId: null },
      { boardId: "101", name: "Column Only", type: "kanban", configReadable: true, filterId: "9", columns: [{ statusIds: [] }] },
    ]);
    mocks.loadBoardColumns.mockResolvedValue([{ boardId: "101", statusIds: [] }]);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.loadFilters.mockResolvedValue([{ id: "9", ownerActive: true }]);

    const r = await getRemediationCandidates({ payload: { findingKey: "board-backing" }, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.items).toEqual([{ id: "100", name: "Orphan Board", type: "scrum", issues: ["no-backing-filter"] }]);
  });

  test("field-cleanup: fields with no populated issues -- orphaned or configured-but-unused", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "s1" });
    // Findings are recomputed from each field's own numbers against the current thresholds --
    // the same hydration the Overview counts with -- so the stored findings (even a stale
    // or missing one) do not decide membership.
    mocks.loadSnapshotFields.mockResolvedValue([
      { id: "customfield_1", name: "Old Field", type: "text", description: null, configuredProjectCount: 0, activeProjectCount: 0, totalIssueCount: 0, findings: null },
      { id: "customfield_2", name: "Used Field", type: "text", description: "In use", configuredProjectCount: 1, activeProjectCount: 1, totalIssueCount: 40, findings: { reasons: [{ code: "orphaned" }] } },
      { id: "customfield_3", name: "Light Use", type: "text", description: null, configuredProjectCount: 1, activeProjectCount: 1, totalIssueCount: 5, findings: null },
      { id: "customfield_4", name: "Configured Only", type: "text", description: null, configuredProjectCount: 3, activeProjectCount: 0, totalIssueCount: 0, findings: null },
    ]);

    const r = await getRemediationCandidates({ payload: { findingKey: "field-cleanup" }, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.items).toEqual([
      { id: "customfield_1", name: "Old Field", type: "text", description: null, reason: "orphaned" },
      { id: "customfield_4", name: "Configured Only", type: "text", description: null, reason: "configured-no-issues" },
    ]);
  });

  test("filter-duplicates: groups filters sharing identical JQL", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.loadFilters.mockResolvedValue([
      { id: "1", name: "Open Bugs", jql: "project = ABC AND status = Open", ownerName: "Ann", shares: [] },
      { id: "2", name: "Open Bugs Copy", jql: "project = ABC AND status = Open", ownerName: "Sam", shares: [] },
      { id: "3", name: "Something Else", jql: "project = XYZ", ownerName: "Ann", shares: [] },
    ]);

    const r = await getRemediationCandidates({ payload: { findingKey: "filter-duplicates" }, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ count: 2, jql: "project = ABC AND status = Open" });
    expect(r.items[0].filters.map((f) => f.id).sort()).toEqual(["1", "2"]);
  });

  test("filter-duplicates: reports unavailable when there is no filter snapshot yet", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    const r = await getRemediationCandidates({ payload: { findingKey: "filter-duplicates" }, context: ctxWithAccount() });
    expect(r).toMatchObject({ available: false, reason: "no-snapshot", items: [] });
  });

  test("filter-scope: a filter naming a project the site does not have", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.loadFilters.mockResolvedValue([
      { id: "1", name: "Ghost Project Search", jql: "project = GONE", ownerName: "Ann", projectRefs: ["GONE"], typeRefs: [], shares: [] },
      { id: "2", name: "Fine Filter", jql: "project = ABC", ownerName: "Ann", projectRefs: ["ABC"], typeRefs: [], shares: [] },
    ]);
    mocks.readSnapshotMeta.mockResolvedValue({ version: "s1" });
    mocks.listSnapshotProjects.mockResolvedValue([{ projectId: "10", projectKey: "ABC", projectName: "Alpha" }]);
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue(null);

    const r = await getRemediationCandidates({ payload: { findingKey: "filter-scope" }, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.items).toEqual([
      expect.objectContaining({ id: "1:project", name: "Ghost Project Search", refKind: "project", missing: ["GONE"] }),
    ]);
  });

  test("filter-scope: reports unavailable when neither catalog exists to join against", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.loadFilters.mockResolvedValue([]);
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue(null);
    const r = await getRemediationCandidates({ payload: { findingKey: "filter-scope" }, context: ctxWithAccount() });
    expect(r).toMatchObject({ available: false, reason: "no-catalog", items: [] });
  });

  test("screen-unreachable-fields: a populated field with no reachability entry anywhere", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1", refreshedAt: "t" });
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1", refreshedAt: "t" });
    mocks.loadProjectScreenCoverage.mockResolvedValue([{ projectId: "10", screenCount: 3, unresolvedScreens: 0 }]);
    mocks.loadFieldReachabilityByProject.mockResolvedValue([
      { projectId: "10", fieldId: "cf_1", onCreate: true, onEdit: true, onView: true },
    ]);
    mocks.loadPopulatedProjectUsage.mockResolvedValue({ truncated: false, limit: 20000, rows: [] });
    mocks.loadSnapshotFields.mockResolvedValue([{ id: "cf_1", name: "Story Points" }, { id: "cf_2", name: "Vendor Ref" }]);

    const r = await getRemediationCandidates({ payload: { findingKey: "screen-unreachable-fields" }, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.items).toEqual([{ id: "cf_2", fieldId: "cf_2", fieldName: "Vendor Ref" }]);
  });

  test("screen-unreachable-fields: reports unavailable when the cross could not resolve", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    const r = await getRemediationCandidates({ payload: { findingKey: "screen-unreachable-fields" }, context: ctxWithAccount() });
    expect(r).toMatchObject({ available: false });
  });

  test("issue-type-reach: reads the live governanceFindings computation, not the SQL-aggregate governance summary", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadIssueTypes.mockResolvedValue([
      { id: "1", name: "Epic", hierarchyLevel: 1, subtask: false },
      { id: "2", name: "Orphan Type", hierarchyLevel: 0, subtask: false },
    ]);
    mocks.loadIssueTypeSchemes.mockResolvedValue([{ schemeId: "s1", name: "Default", projectCount: 1 }]);
    mocks.loadIssueTypeSchemeItems.mockResolvedValue([{ schemeId: "s1", issueTypeId: "1", itemIndex: 0 }]);
    mocks.loadIssueTypeSchemeProjects.mockResolvedValue([]);
    mocks.loadIssueTypeGovernanceSummary.mockResolvedValue({}); // deliberately no orphanTypes here

    const r = await getRemediationCandidates({ payload: { findingKey: "issue-type-reach" }, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.items).toEqual([{ id: "2", name: "Orphan Type", subtask: false }]);
  });

  test("issue-type-naming: groups issue types sharing a normalized name", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadIssueTypes.mockResolvedValue([
      { id: "1", name: "Bug", hierarchyLevel: 0, subtask: false },
      { id: "2", name: "Bug ", hierarchyLevel: 0, subtask: false },
    ]);
    mocks.loadIssueTypeSchemes.mockResolvedValue([]);
    mocks.loadIssueTypeSchemeItems.mockResolvedValue([]);
    mocks.loadIssueTypeSchemeProjects.mockResolvedValue([]);

    const r = await getRemediationCandidates({ payload: { findingKey: "issue-type-naming" }, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].types.map((t) => t.id).sort()).toEqual(["1", "2"]);
  });

  test("issue-type-reach: reports unavailable when never built", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue(null);
    const r = await getRemediationCandidates({ payload: { findingKey: "issue-type-reach" }, context: ctxWithAccount() });
    expect(r).toMatchObject({ available: false, reason: "no-snapshot", items: [] });
  });

  test("asset-schema-hygiene: a schema with no object types", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "ready", version: "a1", assetsEnabled: true });
    mocks.loadAssetSchemas.mockResolvedValue([
      { id: "1", name: "Ghost Schema", objectTypeCount: 0, objectCount: 0 },
      { id: "2", name: "Live Schema", objectTypeCount: 3, objectCount: 40 },
    ]);
    mocks.loadAssetObjectTypes.mockResolvedValue([]);
    mocks.loadAssetAttributes.mockResolvedValue([]);
    mocks.loadAssetTypeCounts.mockResolvedValue([]);

    const r = await getRemediationCandidates({ payload: { findingKey: "asset-schema-hygiene" }, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.items).toEqual([expect.objectContaining({ id: "1", name: "Ghost Schema", reason: "no object types" })]);
  });

  test("asset-schema-hygiene: reports assets-not-enabled distinctly from no-snapshot", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "unavailable", assetsEnabled: false });
    const r = await getRemediationCandidates({ payload: { findingKey: "asset-schema-hygiene" }, context: ctxWithAccount() });
    expect(r).toMatchObject({ available: false, reason: "assets-not-enabled", items: [] });
  });

  test("asset-type-usage: an object type with zero measured objects", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "ready", version: "a1", assetsEnabled: true });
    mocks.loadAssetSchemas.mockResolvedValue([{ id: "1", name: "Infra", objectTypeCount: 2, objectCount: 5 }]);
    mocks.loadAssetObjectTypes.mockResolvedValue([
      { id: "9", schemaId: "1", name: "Server", abstract: false },
      { id: "10", schemaId: "1", name: "Rack", abstract: false },
    ]);
    mocks.loadAssetAttributes.mockResolvedValue([]);
    mocks.loadAssetTypeCounts.mockResolvedValue([{ objectTypeId: "9", objectCount: 5 }, { objectTypeId: "10", objectCount: 0 }]);

    const r = await getRemediationCandidates({ payload: { findingKey: "asset-type-usage" }, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.items).toEqual([{ id: "10", name: "Rack", schemaId: "1" }]);
  });

  test("asset-type-usage: unmeasured (no object-count crawl) is unavailable, never a false empty", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "ready", version: "a1", assetsEnabled: true });
    mocks.loadAssetSchemas.mockResolvedValue([{ id: "1", name: "Infra", objectTypeCount: 1, objectCount: 0 }]);
    mocks.loadAssetObjectTypes.mockResolvedValue([{ id: "9", schemaId: "1", name: "Server", abstract: false }]);
    mocks.loadAssetAttributes.mockResolvedValue([]);
    mocks.loadAssetTypeCounts.mockResolvedValue([]); // the crawl has never run

    const r = await getRemediationCandidates({ payload: { findingKey: "asset-type-usage" }, context: ctxWithAccount() });

    expect(r).toMatchObject({ available: false, reason: "no-object-count-crawl", items: [] });
  });

  test("is admin-only", () => {
    expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toContain("getRemediationCandidates");
    expect(Object.keys(SHARED_RESOLVER_FUNCTIONS)).not.toContain("getRemediationCandidates");
  });
});

describe("getCascadeGraph", () => {
  // A -> B -> C -> A, plus a tail that leaves the loop.
  const edges = [
    { sourceId: "1", targetId: "2", field: "Owner" },
    { sourceId: "2", targetId: "3", field: "Status" },
    { sourceId: "3", targetId: "1", field: "Owner" },
    { sourceId: "9", targetId: "8", field: "Milestone" },
    { sourceId: "8", targetId: "7", field: "Checkpoint" },
  ];

  beforeEach(() => {
    mocks.loadCascadeEdges.mockResolvedValue(edges);
    mocks.loadRuleDirectoryFor.mockResolvedValue(new Map([
      ["1", { id: "1", name: "Alpha", enabled: true }],
      ["2", { id: "2", name: "Beta", enabled: true }],
      ["3", { id: "3", name: "Gamma", enabled: false }],
      ["9", { id: "9", name: "Start", enabled: true }],
      ["8", { id: "8", name: "Middle", enabled: true }],
      ["7", { id: "7", name: "End", enabled: true }],
    ]));
  });

  test("finds a loop no single hop reveals", async () => {
    const result = await getCascadeGraph({ payload: {}, context: ctxWithAccount() });

    expect(result.available).toBe(true);
    expect(result.loops).toHaveLength(1);
    expect(result.loops[0].ruleNames.sort()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(result.rulesInLoops).toBe(3);
  });

  test("finds the multi-rule chain that is not a loop", async () => {
    const result = await getCascadeGraph({ payload: {}, context: ctxWithAccount() });

    expect(result.chains).toHaveLength(1);
    expect(result.chains[0].steps.map((s) => s.name)).toEqual(["Start", "Middle", "End"]);
  });

  test("names the field carrying each hop, which is what an admin breaks", async () => {
    const result = await getCascadeGraph({ payload: {}, context: ctxWithAccount() });
    const hops = result.chains[0].steps.flatMap((s) => s.viaFields);
    expect(hops).toEqual(["Milestone", "Checkpoint"]);
  });

  test("attaches the enabled state, so a dead hop is visible", async () => {
    const result = await getCascadeGraph({ payload: {}, context: ctxWithAccount() });
    expect(result.loops[0].path.some((step) => step.enabled === false)).toBe(true);
  });

  // Names are looked up only for the rules that appear in an answer. Joining all 1,457 edges
  // to the directory would pay for names on every edge to render a few hundred.
  test("looks up only the rules that appear in a loop or a chain", async () => {
    await getCascadeGraph({ payload: {}, context: ctxWithAccount() });
    const asked = mocks.loadRuleDirectoryFor.mock.calls[0][1];
    expect(asked.sort()).toEqual(["1", "2", "3", "7", "8", "9"]);
  });

  test("bounds the requested depth", async () => {
    const result = await getCascadeGraph({ payload: { maxDepth: 9999 }, context: ctxWithAccount() });
    expect(result.maxDepth).toBeLessThanOrEqual(8);
  });

  test("reports unavailable rather than an empty graph when nothing is stored", async () => {
    mocks.loadCascadeEdges.mockResolvedValue([]);
    const result = await getCascadeGraph({ payload: {}, context: ctxWithAccount() });
    expect(result).toMatchObject({ available: false, reason: "no-cascades" });
  });
});

describe("getStatusAutomationUsage", () => {
  test("groups the rules by direction, because direction is the consequence", async () => {
    mocks.loadAutomationReferencesFor.mockResolvedValue({
      total: 3, ruleCount: 3,
      references: [
        { direction: "write", rule_id: "1", name: "Sends to Parking Lot", enabled: 1 },
        { direction: "trigger", rule_id: "2", name: "Fires on entry", enabled: 0 },
        { direction: "read", rule_id: "3", name: "Checks the status", enabled: 1 },
      ],
    });

    const result = await getStatusAutomationUsage({ payload: { statusName: "Parking Lot" }, context: ctxWithAccount() });

    // A rule that transitions INTO a status keeps it alive; one that reads it in a condition
    // breaks if it goes but does not keep it in use.
    expect(result.write.rules[0].name).toBe("Sends to Parking Lot");
    expect(result.trigger.rules[0].enabled).toBe(false);
    expect(result.read.count).toBe(1);
    expect(result.referenced).toBe(true);
  });

  test("distinguishes no rules from no analysis", async () => {
    mocks.loadAutomationReferencesFor.mockResolvedValue({ total: 0, ruleCount: 0, references: [] });
    const found = await getStatusAutomationUsage({ payload: { statusName: "Ghost" }, context: ctxWithAccount() });
    expect(found).toMatchObject({ available: true, referenced: false });

    // "No rule touches this status" is permission to delete it. "We have not looked" is not.
    mocks.loadAutomationReferencesFor.mockRejectedValueOnce(new Error("sql down"));
    const unknown = await getStatusAutomationUsage({ payload: { statusName: "Ghost" }, context: ctxWithAccount() });
    expect(unknown).toMatchObject({ available: false, reason: "no-analysis" });
  });

  test("requires a status name", async () => {
    await expect(getStatusAutomationUsage({ payload: {}, context: ctxWithAccount() })).rejects.toThrow(/statusName is required/);
  });
});

// A saved filter is the one piece of Jira configuration that fails silently in both
// directions: delete a field forty filters search on and the searches quietly return the
// wrong answer, and leave a filter owned by somebody who left and it keeps emailing a list
// from an account nobody administers.
// The one-click entry point. The orchestrator behind it is tested in full-scan-runner.test.js;
// what matters here is that the resolver refuses when it should and reports enough for the tab
// to render the stage list before a scan has ever run.
// Which dashboards break if a field goes.
//
// Resolved as a chain -- field -> filters naming it -> gadgets showing those filters ->
// dashboards carrying those gadgets -- because every leg is an exact join. The cheap version
// matches gadget titles against filter names, which is right most of the time, and the case it
// gets wrong is somebody's wall-screen going blank on Monday.
describe("getDashboardUsage", () => {
  beforeEach(() => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "d1", state: "ready" });
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1", state: "ready" });
    mocks.loadFilterReferencesFor.mockResolvedValue({ total: 1, filters: [{ id: "500", name: "Open bugs" }] });
    mocks.countGadgetConfigCoverage.mockResolvedValue({ total: 40, walked: 40 });
    mocks.loadDashboardsForFilters.mockResolvedValue([
      { filterId: "500", dashboardId: "9", dashboardName: "Delivery", gadgetTitle: "Open bugs", ownerName: "Bob", popularity: 12, viewUrl: null },
    ]);
  });

  test("walks field to filter to gadget to dashboard", async () => {
    const result = await getDashboardUsage({ payload: { label: "Story Points" }, context: ctxWithAccount() });

    expect(mocks.loadFilterReferencesFor).toHaveBeenCalledWith("test-install", "f1", "field", "Story Points");
    expect(mocks.loadDashboardsForFilters).toHaveBeenCalledWith("test-install", "d1", ["500"]);
    expect(result).toMatchObject({ available: true, total: 1, viaFilters: 1, complete: true });
    // WHERE on the dashboard, not just which dashboard.
    expect(result.dashboards[0].via[0]).toMatchObject({ gadgetTitle: "Open bugs", filterName: "Open bugs" });
  });

  test("counts a dashboard once even when several gadgets reach it", async () => {
    mocks.loadDashboardsForFilters.mockResolvedValue([
      { filterId: "500", dashboardId: "9", dashboardName: "Delivery", gadgetTitle: "Open bugs", popularity: 3 },
      { filterId: "500", dashboardId: "9", dashboardName: "Delivery", gadgetTitle: "Bug trend", popularity: 3 },
    ]);

    const result = await getDashboardUsage({ payload: { label: "Story Points" }, context: ctxWithAccount() });

    // Two gadgets on one dashboard is one dashboard at risk, not two findings.
    expect(result.total).toBe(1);
    expect(result.dashboards[0].via).toHaveLength(2);
  });

  // Which half is missing changes what an admin has to do, so they are reported apart rather
  // than collapsed into one "unavailable".
  test("says which inventory is missing, not just that one is", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue(null);
    expect(await getDashboardUsage({ payload: { label: "X" }, context: ctxWithAccount() }))
      .toMatchObject({ available: false, reason: "no-dashboard-inventory" });

    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "d1" });
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    expect(await getDashboardUsage({ payload: { label: "X" }, context: ctxWithAccount() }))
      .toMatchObject({ available: false, reason: "no-filter-inventory" });
  });

  test("marks the answer incomplete when the gadget config walk has not finished", async () => {
    mocks.countGadgetConfigCoverage.mockResolvedValue({ total: 40, walked: 12 });
    mocks.loadFilterReferencesFor.mockResolvedValue({ total: 0, filters: [] });

    const result = await getDashboardUsage({ payload: { label: "Story Points" }, context: ctxWithAccount() });

    // Zero dashboards from a partial walk is not "no dashboard uses this field" -- and that
    // sentence is what somebody deletes a field on.
    expect(result).toMatchObject({ total: 0, complete: false });
    expect(result.coverage).toMatchObject({ total: 40, walked: 12 });
  });

  test("does not query dashboards when no filter names the field", async () => {
    mocks.loadFilterReferencesFor.mockResolvedValue({ total: 0, filters: [] });

    const result = await getDashboardUsage({ payload: { label: "Unused" }, context: ctxWithAccount() });

    expect(result).toMatchObject({ available: true, total: 0, complete: true });
    expect(mocks.loadDashboardsForFilters).not.toHaveBeenCalled();
  });
});

describe("startFullSiteScan / getFullScanStatus", () => {
  beforeEach(() => {
    mocks.kvsGet.mockResolvedValue(null);
    mocks.readFullScanMeta.mockResolvedValue(null);
  });

  test("refuses in read-only mode, and says so", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true });

    const result = await startFullSiteScan({ context: ctxWithAccount() });

    expect(result.started).toBe(false);
    expect(result.error).toMatch(/Read-only/);
  });

  test("returns the stage catalog even when no scan has ever run", async () => {
    const result = await getFullScanStatus({ context: ctxWithAccount() });

    // Renders as a list of what a scan covers rather than an empty panel -- the same reason
    // the other tabs describe what they would show before they have anything to show.
    expect(result.state).toBe("idle");
    expect(result.stages).toBeNull();
    expect(result.catalog.map((s) => s.key)).toEqual(expect.arrayContaining(["workflows", "filters", "dashboards", "issues"]));
    expect(result.catalog.map((s) => s.key)).not.toContain("automation");
  });

  test("reports per-stage progress for a run in flight", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running",
      currentStage: "issues",
      stages: [{ key: "workflows", state: "done" }, { key: "issues", state: "running" }],
      startedAt: "2026-08-26T00:00:00.000Z",
    });

    const result = await getFullScanStatus({ context: ctxWithAccount() });

    expect(result).toMatchObject({ state: "running", currentStage: "issues" });
    expect(result.stages).toHaveLength(2);
  });

  // A cancelled scan, or one that finished before run history existed, has no full_scan_runs
  // row -- so the produced counts have to come from the pillar metas on every read, or the
  // page shows "Produced —" for every stage.
  test("attaches what each pillar currently holds even for an idle scan", async () => {
    mocks.readFullScanMeta.mockResolvedValue({ state: "cancelled", scanType: "full", stages: [{ key: "workflows", state: "done" }] });
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1", totalSchemes: 14 });
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "flt1", totalFilters: 4115 });

    const result = await getFullScanStatus({ context: ctxWithAccount() });

    expect(result.liveStageCounts).toMatchObject({ workflows: 14, filters: 4115 });
  });

  test("reaches into the filter sub-build for a real count while the filters stage is in flight", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running", currentStage: "filters",
      stages: [{ key: "filters", state: "running" }],
    });
    mocks.readFilterSnapshotMeta.mockResolvedValue({ processed: 1200, totalExpected: 4115, lastError: null });

    const result = await getFullScanStatus({ context: ctxWithAccount() });

    // The orchestrator only knows "running"; the sub-build's own meta row is where the
    // count lives, so the stage row can show 1,200 / 4,115 instead of an endless sweep.
    expect(result.currentStageProgress).toMatchObject({ processed: 1200, total: 4115 });
  });

  test("leaves currentStageProgress null when the active stage keeps no sub-build count", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running", currentStage: "workflows",
      stages: [{ key: "workflows", state: "running" }],
    });
    const result = await getFullScanStatus({ context: ctxWithAccount() });
    expect(result.currentStageProgress).toBeNull();
  });

  test("names the dashboard build's current phase, so its count is not a mystery", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running", currentStage: "dashboards",
      stages: [{ key: "dashboards", state: "running" }],
    });
    mocks.readDashboardSnapshotMeta.mockResolvedValue({
      processed: 3836, totalExpected: 5226, lastError: null,
      buildCursor: JSON.stringify({ phase: "configs", walked: 10, listTotal: 613, gadgetTotal: 4000 }),
    });

    const result = await getFullScanStatus({ context: ctxWithAccount() });

    expect(result.currentStageProgress).toMatchObject({
      processed: 3836, total: 5226, note: "resolving what each gadget points at",
    });
  });

  test("survives a meta read failure rather than taking the tab down", async () => {
    mocks.readFullScanMeta.mockRejectedValueOnce(new Error("sql down"));

    const result = await getFullScanStatus({ context: ctxWithAccount() });

    // The Scans tab has several panels; one unreadable row must not blank the others.
    expect(result.state).toBe("idle");
    expect(result.catalog.length).toBeGreaterThan(0);
  });

  // Both scan types share one meta row. A quick scan running under it must not make the full
  // scan panel look like an idle scan with no explanation for why its button is disabled.
  test("says a quick scan is blocking it, rather than reporting plain idle", async () => {
    mocks.readFullScanMeta.mockResolvedValue({ state: "running", scanType: "quick" });

    const result = await getFullScanStatus({ context: ctxWithAccount() });

    expect(result.state).toBe("idle");
    expect(result.blockedByOtherScan).toBe(true);
  });

  test("a row with no scanType at all is treated as the full scan's own, for rows written before the split", async () => {
    mocks.readFullScanMeta.mockResolvedValue({ state: "running", currentStage: "workflows", stages: [{ key: "workflows", state: "running" }] });

    const result = await getFullScanStatus({ context: ctxWithAccount() });

    expect(result.state).toBe("running");
    expect(result.blockedByOtherScan).toBe(false);
  });

  // The hourly scheduled trigger is the backstop for a wedged orchestrator; the status read,
  // polled every few seconds while an admin watches, is what heals it promptly.
  test("kicks stall recovery when a running scan's heartbeat has gone quiet past the window", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running", scanType: "full", currentStage: "dashboards",
      stages: [{ key: "dashboards", state: "running" }],
      updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });

    await getFullScanStatus({ context: ctxWithAccount() });

    expect(mocks.recoverStalledScan).toHaveBeenCalledWith("test-install");
  });

  test("does not touch recovery for a scan whose heartbeat is fresh", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running", scanType: "full", currentStage: "dashboards",
      stages: [{ key: "dashboards", state: "running" }],
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    });

    await getFullScanStatus({ context: ctxWithAccount() });

    expect(mocks.recoverStalledScan).not.toHaveBeenCalled();
  });

  test("kicks recovery for a scan past its total-duration ceiling even with a fresh heartbeat", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running", scanType: "full", currentStage: "issues",
      stages: [{ key: "issues", state: "running" }],
      updatedAt: new Date().toISOString(), // ticking right now
      startedAt: new Date(Date.now() - 90 * 60 * 60 * 1000).toISOString(), // 90 hours ago
    });

    await getFullScanStatus({ context: ctxWithAccount() });

    expect(mocks.recoverStalledScan).toHaveBeenCalledWith("test-install");
  });

  test("a recovery kick that rejects never breaks the status response", async () => {
    mocks.recoverStalledScan.mockRejectedValueOnce(new Error("queue push failed"));
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running", scanType: "full", currentStage: "dashboards",
      stages: [{ key: "dashboards", state: "running" }],
      updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });

    const result = await getFullScanStatus({ context: ctxWithAccount() });

    expect(result.state).toBe("running");
  });
});

// The quick scan's own manual trigger and status read, mirroring the full-scan pair above --
// same shared row, same mutual exclusion, opposite direction for blockedByOtherScan.
describe("startQuickSiteScan / getQuickScanStatus", () => {
  beforeEach(() => {
    mocks.kvsGet.mockResolvedValue(null);
    mocks.readFullScanMeta.mockResolvedValue(null);
  });

  test("refuses in read-only mode, and says so", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true });

    const result = await startQuickSiteScan({ payload: {}, context: ctxWithAccount() });

    expect(result.started).toBe(false);
    expect(result.error).toMatch(/Read-only/);
  });

  test("defaults the window to the stored schedule's, when none is given explicitly", async () => {
    mocks.kvsGet.mockResolvedValue({ quickScanSchedule: { windowHours: 336 } });

    await startQuickSiteScan({ payload: {}, context: ctxWithAccount() });

    // "Run now" between scheduled runs should ask the same question the schedule would have,
    // not an arbitrary different one.
    expect(mocks.writeFullScanMeta).toHaveBeenCalledWith("test-install", expect.objectContaining({ quickScanWindowHours: 336 }));
  });

  test("an explicit window in the payload overrides the stored schedule", async () => {
    mocks.kvsGet.mockResolvedValue({ quickScanSchedule: { windowHours: 336 } });

    await startQuickSiteScan({ payload: { windowHours: 12 }, context: ctxWithAccount() });

    expect(mocks.writeFullScanMeta).toHaveBeenCalledWith("test-install", expect.objectContaining({ quickScanWindowHours: 12 }));
  });

  test("returns the quick-scan catalog even when nothing has run", async () => {
    const result = await getQuickScanStatus({ context: ctxWithAccount() });

    expect(result.state).toBe("idle");
    expect(result.catalog.map((s) => s.key)).toEqual(expect.arrayContaining(["workflows", "filters", "issues-delta"]));
    expect(result.catalog.map((s) => s.key)).not.toContain("fields");
  });

  test("reports its own progress, and says which window it was run with", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running", scanType: "quick", currentStage: "issues-delta", quickScanWindowHours: 168,
      stages: [{ key: "workflows", state: "done" }],
    });

    const result = await getQuickScanStatus({ context: ctxWithAccount() });

    expect(result).toMatchObject({ state: "running", currentStage: "issues-delta", windowHours: 168 });
  });

  // The reverse of the full-scan panel's own check: a running FULL scan must not make the
  // quick-scan panel render as idle with an unexplained disabled button.
  test("says a full scan is blocking it, rather than reporting plain idle", async () => {
    mocks.readFullScanMeta.mockResolvedValue({ state: "running", scanType: "full" });

    const result = await getQuickScanStatus({ context: ctxWithAccount() });

    expect(result.state).toBe("idle");
    expect(result.blockedByOtherScan).toBe(true);
  });

  test("never shows the full scan's own stages on the quick-scan panel", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running", scanType: "full", currentStage: "issues",
      stages: [{ key: "workflows", state: "done" }, { key: "issues", state: "running" }],
    });

    const result = await getQuickScanStatus({ context: ctxWithAccount() });

    expect(result.stages).toBeNull();
    expect(result.currentStage).toBeNull();
  });
});

// The wedge these exist for: a scan orchestrator whose loop stopped stepping sits at
// "running" forever, and startScan refuses every new run over it. The engine logic lives in
// full-scan-runner.test.js; here we only check the resolvers reach it and stay outside the
// read-only gate that a real scan sits behind.
describe("resumeSiteScan / cancelSiteScan", () => {
  beforeEach(() => {
    mocks.readFullScanMeta.mockResolvedValue(null);
  });

  test("cancelSiteScan writes the terminal state that frees the shared row", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running", scanType: "full", jobToken: "tok",
      stages: [{ key: "workflows", state: "done" }, { key: "filters", state: "running" }],
    });

    const result = await cancelSiteScan({ context: ctxWithAccount() });

    expect(result).toMatchObject({ cancelled: true, scanType: "full" });
    expect(mocks.writeFullScanMeta).toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({ state: "cancelled", jobToken: null })
    );
  });

  test("cancelSiteScan is a no-op when nothing is running", async () => {
    expect(await cancelSiteScan({ context: ctxWithAccount() })).toMatchObject({ cancelled: false, reason: "not-running" });
  });

  test("cancelSiteScan still works while read-only mode is on -- clearing a wedge is not a new scan", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true });
    mocks.readFullScanMeta.mockResolvedValue({ state: "running", scanType: "full", jobToken: "tok", stages: [] });

    expect(await cancelSiteScan({ context: ctxWithAccount() })).toMatchObject({ cancelled: true });
  });

  test("resumeSiteScan force-recovers a stalled run without waiting on the staleness clock", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running", scanType: "full", jobToken: "tok", currentStage: "filters",
      stages: [{ key: "filters", state: "running" }],
      updatedAt: new Date().toISOString(), // fresh -- force must override
      recoveryCount: 0,
    });
    mocks.recoverStalledScan.mockResolvedValueOnce({ recovered: true, stage: "filters", recoveryCount: 1 });

    const result = await resumeSiteScan({ context: ctxWithAccount() });

    expect(mocks.recoverStalledScan).toHaveBeenCalledWith("test-install", { force: true });
    expect(result).toMatchObject({ recovered: true, stage: "filters" });
  });

  test("resumeSiteScan routes a completed-with-failures run to the resume path, not recovery", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "completed-with-failures", scanType: "full",
      stages: [{ key: "dashboards", state: "failed" }, { key: "workflows", state: "done" }],
    });

    const result = await resumeSiteScan({ context: ctxWithAccount() });

    expect(mocks.resumeScanRun).toHaveBeenCalledWith("test-install");
    expect(mocks.recoverStalledScan).not.toHaveBeenCalled();
    expect(result).toMatchObject({ resumed: true });
  });

  test("both are registered as guarded admin-only functions", () => {
    for (const name of ["resumeSiteScan", "cancelSiteScan"]) {
      expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toContain(name);
    }
  });
});

describe("recordQuickScanScheduledRun", () => {
  test("writes only the schedule's lastScheduledRunAt, leaving the rest of the config untouched", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true, quickScanSchedule: { enabled: true, windowHours: 168 } });

    await recordQuickScanScheduledRun("2026-08-27T00:00:00.000Z");

    expect(mocks.kvsSet).toHaveBeenCalledWith(
      "atlasiq-admin-config",
      expect.objectContaining({
        readOnlyMode: true,
        quickScanSchedule: expect.objectContaining({
          enabled: true,
          windowHours: 168,
          lastScheduledRunAt: "2026-08-27T00:00:00.000Z",
        }),
      })
    );
  });
});

describe("getFilterInventory", () => {
  const filterRow = (over = {}) => ({
    id: "1", name: "Open bugs", jql: "project = ADVEV AND status = Open",
    owner: { accountId: "a1", displayName: "Bob", active: true },
    ownerName: "Bob", ownerActive: true,
    shares: [], sharedWithEveryone: false, shareCount: 0,
    subscriptionCount: 0, lastUsedAt: new Date().toISOString(),
    fieldRefs: ["project", "status"], projectRefs: ["ADVEV"], statusRefs: ["Open"],
    ...over,
  });

  beforeEach(() => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready", refreshedAt: "2026-08-20T00:00:00Z" });
    mocks.loadFilters.mockResolvedValue([
      filterRow(),
      filterRow({ id: "2", name: "Orphan", owner: null, ownerActive: null }),
    ]);
    mocks.readSnapshotMeta.mockResolvedValue({ version: "fv1" });
    mocks.listSnapshotProjects.mockResolvedValue([{ projectId: "1", projectKey: "ADVEV", projectName: "ADVEV" }]);
  });

  test("derives the findings at read time rather than storing them", async () => {
    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });

    expect(result.available).toBe(true);
    expect(result.total).toBe(2);
    expect(result.orphanedCount).toBe(1);
    // Paged now, not the whole inventory. 4,115 filters on a real site overflowed Forge's
    // response payload limit when the entire analyzed list was sent in one call.
    expect(result.filters).toHaveLength(2);
    expect(result.matchedTotal).toBe(2);
    expect(result.page).toBe(1);
    expect(result.totalPages).toBe(1);
  });

  test("attaches findings to every row, not only the ones the summary flagged", async () => {
    // Two clean filters plus the one the fixture already flags -- every row in the RESPONSE
    // must carry a findings array, or the rail's finding filter has nothing to match against
    // for the clean ones.
    mocks.loadFilters.mockResolvedValue([
      filterRow({ id: "1" }),
      filterRow({ id: "3", name: "Also clean" }),
    ]);

    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });
    expect(result.filters.every((f) => Array.isArray(f.findings))).toBe(true);
    expect(result.filters.find((f) => f.id === "1").findings).toEqual([]);
  });

  test("does not ship the whole inventory under a second name", async () => {
    // The old response carried BOTH `allFilters` (every filter, full row) and, via
    // `...summary`, `filters` (summarizeFilters' own unbounded worst-first list for the
    // Overview's top-8 panel) -- every flagged filter's full row sent twice, under two
    // different keys, which is what helped overflow the payload at 4,115 filters.
    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });
    expect(result).not.toHaveProperty("allFilters");
  });

  // A build hard-killed at the invocation ceiling leaves the row saying "building" with no
  // error, forever. The tab gates its rebuild control on this flag, so a resolver that
  // withholds it is a tab that can never recover -- which is exactly what happened on a live
  // site. Both paths carry it: the wedge is just as reachable on a rebuild over an existing
  // snapshot as on a first build, and only the first path ever reported it.
  test("reports a wedged first build so the UI can offer a rebuild", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({
      version: null, state: "building",
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });
    expect(result.available).toBe(false);
    expect(result.staleBuild).toBe(true);
  });

  test("reports a wedged rebuild over a snapshot that already exists", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({
      version: "v1", state: "building",
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });
    expect(result.available).toBe(true);
    expect(result.staleBuild).toBe(true);
  });

  // The other half of the tri-state: a build that started a minute ago is still running, and
  // saying otherwise would hand a user a rebuild button that races the job already in flight.
  test("does not call a build that just started stale", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({
      version: "v1", state: "building", startedAt: new Date().toISOString(),
    });

    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });
    expect(result.staleBuild).toBe(false);
  });

  test("joins to the project catalog so a broken scope can be found", async () => {
    mocks.loadFilters.mockResolvedValue([filterRow({ projectRefs: ["GHOST"] })]);
    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });

    expect(result.projectsChecked).toBe(true);
    expect(result.brokenProjectCount).toBe(1);
  });

  // The bug this pins: JQL accepts `project = "Display Name"` exactly as readily as
  // `project = KEY`, but the known-projects set only ever carried keys -- so a filter scoped
  // by name, to a project that genuinely exists, was reported broken. Real symptom: the same
  // two project names recurring as "MISSING" across a dozen otherwise-unrelated filters.
  test("does not flag a project referenced by its display name rather than its key", async () => {
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "1", projectKey: "ADVEV", projectName: "ADVEV Software Tools" },
    ]);
    mocks.loadFilters.mockResolvedValue([
      filterRow({ jql: 'project = "ADVEV Software Tools"', projectRefs: ["ADVEV Software Tools"] }),
    ]);

    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });

    expect(result.projectsChecked).toBe(true);
    expect(result.brokenProjectCount).toBe(0);
  });

  // "No broken references" and "nobody looked" are different claims, and only one of them is
  // permission to act.
  test("says the project check could not run rather than reporting it clean", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });

    expect(result.projectsChecked).toBe(false);
    expect(result.brokenProjectCount).toBe(0);
  });

  test("reports never-built rather than empty", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });

    expect(result).toMatchObject({ available: false, neverBuilt: true });
  });

  test("carries the failure reason forward when the last build failed", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: null, state: "failed", lastError: "401 scope does not match" });
    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });

    expect(result.lastError).toMatch(/401/);
  });
});

// The reason any of this exists: 4,115 filters on a real site overflowed Forge's response
// payload limit when the whole inventory was sent in one call. Search, sort, the finding
// filter and pagination all moved server-side as a result -- this is what has to hold for
// that to actually bound the response regardless of estate size.
describe("getFilterInventory paging", () => {
  const filterRow = (over = {}) => ({
    id: "1", name: "Open bugs", jql: "project = ADVEV AND status = Open",
    owner: { accountId: "a1", displayName: "Bob", active: true },
    ownerName: "Bob", ownerActive: true,
    shares: [], sharedWithEveryone: false, shareCount: 0,
    subscriptionCount: 0, lastUsedAt: new Date().toISOString(),
    fieldRefs: ["project", "status"], projectRefs: ["ADVEV"], statusRefs: ["Open"],
    ...over,
  });

  beforeEach(() => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.readSnapshotMeta.mockResolvedValue(null);
    // A page's worth of distinct, findable rows.
    mocks.loadFilters.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => filterRow({
        id: String(i + 1),
        name: i === 0 ? "Special one" : `Filter ${i + 1}`,
        owner: i === 5 ? null : { accountId: "a1", displayName: "Bob", active: true },
        ownerName: i === 5 ? null : "Bob",
        ownerActive: i === 5 ? null : true,
      }))
    );
  });

  test("never returns more rows than pageSize, however large the inventory is", async () => {
    const result = await getFilterInventory({ payload: { pageSize: 10 }, context: ctxWithAccount() });

    expect(result.filters).toHaveLength(10);
    expect(result.matchedTotal).toBe(30);
    expect(result.totalPages).toBe(3);
  });

  test("defaults to a bounded page size when none is given", async () => {
    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });
    expect(result.filters.length).toBeLessThanOrEqual(25);
  });

  // Matches getFieldInventory's own convention: this resolver is called only by Observatory's
  // own frontend, so an out-of-range pageSize is a bug in that caller, not untrusted input to
  // defend against silently. Throwing loudly surfaces the bug where it was introduced instead
  // of masking it behind a clamp that quietly does something the caller never asked for.
  test("rejects a pageSize outside the allowed range rather than silently clamping it", async () => {
    await expect(getFilterInventory({ payload: { pageSize: 100000 }, context: ctxWithAccount() }))
      .rejects.toThrow(/pageSize/);
  });

  test("searches name and jql server-side", async () => {
    const result = await getFilterInventory({ payload: { search: "Special" }, context: ctxWithAccount() });
    expect(result.filters).toHaveLength(1);
    expect(result.filters[0].name).toBe("Special one");
    expect(result.matchedTotal).toBe(1);
  });

  test("narrows to a finding server-side", async () => {
    const result = await getFilterInventory({ payload: { finding: "orphaned-owner" }, context: ctxWithAccount() });
    // Only row index 5 (owner: null) has the orphaned-owner finding.
    expect(result.matchedTotal).toBe(1);
    expect(result.filters).toHaveLength(1);
  });

  test("sorts server-side and returns pages in that order", async () => {
    const first = await getFilterInventory({ payload: { sort: "name", pageSize: 5 }, context: ctxWithAccount() });
    const names = first.filters.map((f) => f.name);
    expect(names).toEqual([...names].sort());
  });

  test("falls back to the default sort for an unrecognised value, rather than erroring", async () => {
    const result = await getFilterInventory({ payload: { sort: "definitely-not-a-real-sort" }, context: ctxWithAccount() });
    expect(result.available).toBe(true);
  });

  // The rail describes the WHOLE matched set, not the current page -- a page can hold zero
  // of a kind that exists dozens of times in the estate.
  test("finding-rail counts describe the whole inventory, not the current page", async () => {
    const result = await getFilterInventory({ payload: { finding: "orphaned-owner", pageSize: 1 }, context: ctxWithAccount() });
    // The page holds exactly the one orphaned filter, but "all" must still count all 30.
    expect(result.findingCounts.all).toBe(30);
    expect(result.findingCounts["orphaned-owner"]).toBe(1);
  });

  test("page beyond the last available clamps rather than returning nothing silently unexplained", async () => {
    const result = await getFilterInventory({ payload: { page: 999, pageSize: 10 }, context: ctxWithAccount() });
    expect(result.page).toBe(result.totalPages);
    expect(result.filters.length).toBeGreaterThan(0);
  });

  test("matchedTotal is independent of the whole-inventory total", async () => {
    const result = await getFilterInventory({ payload: { search: "Special" }, context: ctxWithAccount() });
    // 1 filter matches the search, but the inventory holds 30 -- the headline stat and the
    // search result count must not collapse into the same number.
    expect(result.matchedTotal).toBe(1);
    expect(result.total).toBe(30);
  });
});

describe("buildFilterInventory", () => {
  test("queues a build and marks the row building", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    mocks.kvsGet.mockResolvedValue(null);

    const result = await buildFilterInventory({ context: ctxWithAccount() });

    expect(result).toMatchObject({ queued: true });
    // The `body` envelope, asserted rather than assumed. The consumer reads
    // event?.body?.jobType, so a payload pushed without it arrives bodyless and Forge
    // rejects the invocation with "Event body must be an object" -- which is exactly what
    // shipped, because the original test only checked that SOMETHING was pushed.
    expect(mocks.queuePush).toHaveBeenCalledWith({
      body: {
        jobType: "build-filter-snapshot",
        installationKey: "test-install",
        // The token that lets a resumable build tell its own continuation apart from a second
        // person clicking Rebuild. Without it, any check strict enough to refuse the second
        // would also refuse the build resuming itself.
        buildToken: expect.any(String),
      },
    });
    // Started as a resumable build: an in-flight version distinct from the published one, a
    // zeroed cursor, and a heartbeat. A row marked "building" with no version to write into
    // cannot be resumed by anything.
    expect(mocks.writeFilterSnapshotMeta).toHaveBeenCalledWith("test-install", expect.objectContaining({
      state: "building",
      buildingVersion: expect.any(String),
      buildToken: expect.any(String),
      buildCursor: null,
      processed: 0,
    }));
  });

  test("refuses in read-only mode, and says so", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true });

    const result = await buildFilterInventory({ context: ctxWithAccount() });
    expect(result.queued).toBe(false);
    expect(result.error).toMatch(/Read-only/);
  });

  test("does not queue a second build over one still running", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ state: "building", startedAt: new Date().toISOString() });
    const result = await buildFilterInventory({ context: ctxWithAccount() });
    expect(result).toMatchObject({ queued: false, reason: "already-building" });
  });

  // A Forge invocation timeout is a hard kill, so a wedged row would otherwise suppress every
  // future rebuild with no way out of the UI.
  test("queues over a build that can no longer be running", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({
      state: "building",
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    mocks.kvsGet.mockResolvedValue(null);

    expect(await buildFilterInventory({ context: ctxWithAccount() })).toMatchObject({ queued: true });
  });
});

describe("getFilterUsage", () => {
  test("returns the filters that would break if a field went away", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "v1" });
    mocks.loadFilterReferencesFor.mockResolvedValue({
      total: 2,
      filters: [{ id: "1", name: "Open bugs", ownerName: "Bob", ownerActive: true, subscriptionCount: 0, lastUsedAt: null }],
    });

    const result = await getFilterUsage({ payload: { kind: "field", label: "Story Points" }, context: ctxWithAccount() });
    expect(result).toMatchObject({ available: true, kind: "field", total: 2 });
  });

  // Saying "no filter uses this" with nothing behind it is the false reassurance this whole
  // pillar exists to stop.
  test("distinguishes no inventory from no references", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    const result = await getFilterUsage({ payload: { label: "Story Points" }, context: ctxWithAccount() });
    expect(result).toMatchObject({ available: false, reason: "no-inventory" });
  });

  test("defaults an unrecognised kind to field rather than passing it through", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "v1" });
    await getFilterUsage({ payload: { kind: "'; DROP TABLE", label: "X" }, context: ctxWithAccount() });
    expect(mocks.loadFilterReferencesFor).toHaveBeenCalledWith("test-install", "v1", "field", "X");
  });

  test("requires a label", async () => {
    await expect(getFilterUsage({ payload: {}, context: ctxWithAccount() })).rejects.toThrow(/label is required/);
  });
});

// getPillarHealth used to compute the ENTIRE site health -- every builder, every load, all
// ~1,600 fields hydrated -- and then discard five of the six pillars it produced. Opening the
// Screens tab cost the same twenty-odd SQL round trips as the Overview to render one panel.
describe("getPillarHealth — only loads what the pillar is scored from", () => {
  beforeEach(() => {
    mocks.kvsGet.mockResolvedValue(null);
    mocks.readSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadHealthHistory.mockResolvedValue([{ day: "2026-08-21", score: 61, grade: "D" }]);
  });

  test("the screens pillar does not touch the field catalog", async () => {
    const result = await getPillarHealth({ payload: { pillar: "screens" }, context: ctxWithAccount() });

    expect(result.pillar?.key).toBe("screens");
    // The expensive branch: loading every field in the snapshot and hydrating it.
    expect(mocks.loadSnapshotFields).not.toHaveBeenCalled();
    expect(mocks.listSnapshotProjects).not.toHaveBeenCalled();
    expect(mocks.loadProjectActivity).not.toHaveBeenCalled();
  });

  test("the filters pillar does not build the workflow or screen inventories", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "fv1", state: "ready" });
    mocks.loadFilters.mockResolvedValue([]);

    const result = await getPillarHealth({ payload: { pillar: "filters" }, context: ctxWithAccount() });

    expect(result.pillar?.key).toBe("filters");
    expect(mocks.loadWorkflowSchemes).not.toHaveBeenCalled();
    expect(mocks.loadSnapshotFields).not.toHaveBeenCalled();
  });

  test("the projects pillar still loads the projects and their activity", async () => {
    mocks.listSnapshotProjects.mockResolvedValue([]);
    await getPillarHealth({ payload: { pillar: "projects" }, context: ctxWithAccount() });

    expect(mocks.listSnapshotProjects).toHaveBeenCalled();
    expect(mocks.loadProjectActivity).toHaveBeenCalled();
    // ...and not the field catalog, which only the fields pillar needs.
    expect(mocks.loadSnapshotFields).not.toHaveBeenCalled();
  });

  test("the fields pillar loads the catalog and nothing else", async () => {
    mocks.loadSnapshotFields.mockResolvedValue([]);
    await getPillarHealth({ payload: { pillar: "fields" }, context: ctxWithAccount() });

    expect(mocks.loadSnapshotFields).toHaveBeenCalled();
    expect(mocks.loadProjectActivity).not.toHaveBeenCalled();
  });

  // The score returned alongside is the SITE score, and it can no longer come from this
  // computation -- which is now scored from one pillar's inputs and would be a smaller number
  // wearing a bigger label.
  test("reads the site score from the recorded history, not from this computation", async () => {
    const result = await getPillarHealth({ payload: { pillar: "screens" }, context: ctxWithAccount() });
    expect(result).toMatchObject({ score: 61, grade: "D" });
  });

  test("reports no site score rather than an approximate one when nothing was recorded", async () => {
    mocks.loadHealthHistory.mockResolvedValue([]);
    const result = await getPillarHealth({ payload: { pillar: "screens" }, context: ctxWithAccount() });
    expect(result).toMatchObject({ score: null, grade: null });
  });

  test("an unknown pillar loads nothing and returns nothing", async () => {
    const result = await getPillarHealth({ payload: { pillar: "nonsense" }, context: ctxWithAccount() });
    expect(result.pillar).toBeNull();
    expect(mocks.loadSnapshotFields).not.toHaveBeenCalled();
  });

  test("still requires a pillar", async () => {
    await expect(getPillarHealth({ payload: {}, context: ctxWithAccount() })).rejects.toThrow(/pillar/);
  });
});

// The cross-pillar half. The Field Browser already says which automation rules write a field;
// this says which saved searches would silently start returning the wrong answer without it.
describe("getFieldFilterCounts", () => {
  test("looks a field up by name AND by id, because JQL uses both", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "v1", refreshedAt: "2026-08-21T00:00:00Z" });
    mocks.loadFilterReferenceCounts.mockResolvedValue({ "story points": 12 });

    const result = await getFieldFilterCounts({
      payload: { fields: [{ id: "customfield_10001", name: "Story Points" }] },
      context: ctxWithAccount(),
    });

    const labels = mocks.loadFilterReferenceCounts.mock.calls[0][3];
    expect(labels).toEqual(expect.arrayContaining(["Story Points", "customfield_10001"]));
    expect(result.counts).toEqual({ customfield_10001: 12 });
  });

  test("does not double-count a field named both ways", async () => {
    // Summing would count one filter twice when it references the field by name in a clause
    // and by cf[...] in an ORDER BY.
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "v1" });
    mocks.loadFilterReferenceCounts.mockResolvedValue({ "story points": 12, customfield_10001: 9 });

    const result = await getFieldFilterCounts({
      payload: { fields: [{ id: "customfield_10001", name: "Story Points" }] },
      context: ctxWithAccount(),
    });

    expect(result.counts.customfield_10001).toBe(12);
  });

  // Zero here reads as "safe to delete" and would be the opposite of what an unbuilt pillar
  // knows. The chip renders unknown instead.
  test("reports unavailable rather than zero when nothing has been built", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);

    const result = await getFieldFilterCounts({ payload: { fields: [{ id: "f", name: "F" }] }, context: ctxWithAccount() });

    expect(result).toMatchObject({ available: false, counts: {} });
    expect(mocks.loadFilterReferenceCounts).not.toHaveBeenCalled();
  });

  test("bounds how many fields one call can ask about", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "v1" });
    const fields = Array.from({ length: 900 }, (_, i) => ({ id: `f${i}`, name: `F${i}` }));

    await getFieldFilterCounts({ payload: { fields }, context: ctxWithAccount() });

    // 500 fields, each contributing a name and an id.
    expect(mocks.loadFilterReferenceCounts.mock.calls[0][3]).toHaveLength(1000);
  });

  test("survives a payload with no fields", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "v1" });
    const result = await getFieldFilterCounts({ payload: {}, context: ctxWithAccount() });
    expect(result.counts).toEqual({});
  });
});

// The bulk sibling of getDashboardUsage: a plain count per field for a whole page at once,
// via the same field -> filter ids -> gadgets chain, without describing any one field's
// dashboards in full the way the expanded card section needs to.
describe("getFieldDashboardCounts", () => {
  beforeEach(() => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "fv1" });
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "dv1" });
  });

  test("looks a field up by name AND by id, because JQL uses both", async () => {
    mocks.loadFilterIdsForLabels.mockResolvedValue(new Map([["story points", ["500"]]]));
    mocks.loadGadgetCountsForFilterIds.mockResolvedValue(new Map([["500", 3]]));

    const result = await getFieldDashboardCounts({
      payload: { fields: [{ id: "customfield_10001", name: "Story Points" }] },
      context: ctxWithAccount(),
    });

    const labels = mocks.loadFilterIdsForLabels.mock.calls[0][3];
    expect(labels).toEqual(expect.arrayContaining(["Story Points", "customfield_10001"]));
    expect(result.counts).toEqual({ customfield_10001: 3 });
  });

  // A gadget belongs to exactly one filter, so a field reached by several filters gets the
  // SUM of their gadget counts -- but a filter found under both the field's name and its id
  // must contribute only once, or its gadgets are counted twice.
  test("unions filter ids across name and id, rather than summing the same filter twice", async () => {
    mocks.loadFilterIdsForLabels.mockResolvedValue(new Map([
      ["story points", ["500"]],
      ["customfield_10001", ["500"]],
    ]));
    mocks.loadGadgetCountsForFilterIds.mockResolvedValue(new Map([["500", 4]]));

    const result = await getFieldDashboardCounts({
      payload: { fields: [{ id: "customfield_10001", name: "Story Points" }] },
      context: ctxWithAccount(),
    });

    expect(result.counts.customfield_10001).toBe(4);
    // The gadget-count lookup must only ever be asked about filter 500 once.
    expect(mocks.loadGadgetCountsForFilterIds.mock.calls[0][2]).toEqual(["500"]);
  });

  test("sums gadgets across several DIFFERENT filters that name the same field", async () => {
    mocks.loadFilterIdsForLabels.mockResolvedValue(new Map([["story points", ["500", "501"]]]));
    mocks.loadGadgetCountsForFilterIds.mockResolvedValue(new Map([["500", 2], ["501", 5]]));

    const result = await getFieldDashboardCounts({
      payload: { fields: [{ id: "customfield_10001", name: "Story Points" }] },
      context: ctxWithAccount(),
    });

    expect(result.counts.customfield_10001).toBe(7);
  });

  // Which half is missing changes what an admin builds next, so the two are reported apart.
  test("says which inventory is missing, not just that one is", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    let result = await getFieldDashboardCounts({ payload: { fields: [{ id: "f", name: "F" }] }, context: ctxWithAccount() });
    expect(result).toMatchObject({ available: false, reason: expect.stringContaining("filter") });

    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "fv1" });
    mocks.readDashboardSnapshotMeta.mockResolvedValue(null);
    result = await getFieldDashboardCounts({ payload: { fields: [{ id: "f", name: "F" }] }, context: ctxWithAccount() });
    expect(result).toMatchObject({ available: false, reason: expect.stringContaining("dashboard") });
  });

  test("reports zero for a field no filter names, rather than omitting it", async () => {
    mocks.loadFilterIdsForLabels.mockResolvedValue(new Map());

    const result = await getFieldDashboardCounts({
      payload: { fields: [{ id: "customfield_99999", name: "Untouched" }] },
      context: ctxWithAccount(),
    });

    // No filter references it, so the gadget lookup never runs at all -- there is nothing
    // to look up.
    expect(mocks.loadGadgetCountsForFilterIds).not.toHaveBeenCalled();
    expect(result.available).toBe(true);
  });

  test("bounds how many fields one call can ask about", async () => {
    const fields = Array.from({ length: 900 }, (_, i) => ({ id: `f${i}`, name: `F${i}` }));
    await getFieldDashboardCounts({ payload: { fields }, context: ctxWithAccount() });
    expect(mocks.loadFilterIdsForLabels.mock.calls[0][3]).toHaveLength(1000);
  });
});

// A dashboard is the most visible thing in Jira and the least owned.
describe("getDashboardInventory", () => {
  const row = (over = {}) => ({
    id: "1", name: "Delivery overview",
    owner: { accountId: "a1", displayName: "Bob", active: true },
    ownerName: "Bob", ownerActive: true,
    shares: [], editShares: [], sharedWithEveryone: false, editableByEveryone: false,
    popularity: 4, gadgetCount: 6, gadgets: [], shareCount: 0,
    ...over,
  });

  test("derives the findings at read time", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready", gadgetsWalked: 2 });
    mocks.loadDashboards.mockResolvedValue([row(), row({ id: "2", name: "Orphan", owner: null, ownerActive: null })]);

    const result = await getDashboardInventory({ context: ctxWithAccount() });

    expect(result).toMatchObject({ available: true, total: 2, orphanedCount: 1 });
    // The whole list travels, because the tab filters over it client-side.
    expect(result.allDashboards).toHaveLength(2);
  });

  // Without this the tab would present a partial pass as a complete one and call unread
  // dashboards empty.
  test("carries how far the gadget walk actually got", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready", gadgetsWalked: 180 });
    mocks.loadDashboards.mockResolvedValue([row()]);

    const result = await getDashboardInventory({ context: ctxWithAccount() });
    expect(result.gadgetsWalked).toBe(180);
  });

  test("reports never-built rather than empty", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue(null);
    expect(await getDashboardInventory({ context: ctxWithAccount() }))
      .toMatchObject({ available: false, neverBuilt: true });
  });

  test("carries the failure reason forward when the last build failed", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: null, state: "failed", lastError: "401 scope does not match" });
    const result = await getDashboardInventory({ context: ctxWithAccount() });
    expect(result.lastError).toMatch(/401/);
  });
});

// What a dashboard depends on, resolved through the gadget -> filter join done at build
// time and the filter -> field join done here. The field card runs the same chain in reverse
// ("which dashboards use this field"); this is the other direction, and both have to agree
// because they read from the same tables.
describe("getDashboardInventory field dependencies", () => {
  const row = (over = {}) => ({
    id: "1", name: "Delivery overview",
    owner: { accountId: "a1", displayName: "Bob", active: true },
    ownerName: "Bob", ownerActive: true,
    shares: [], editShares: [], sharedWithEveryone: false, editableByEveryone: false,
    popularity: 4, gadgetCount: 1, shareCount: 0,
    gadgets: [{ id: "g1", title: "Open bugs", filterId: "500" }],
    ...over,
  });

  test("attaches the fields a dashboard depends on via its gadgets' filters", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadDashboards.mockResolvedValue([row()]);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1", state: "ready" });
    mocks.loadFieldNamesForFilterIds.mockResolvedValue(new Map([["500", ["Story Points", "Status"]]]));

    const result = await getDashboardInventory({ context: ctxWithAccount() });

    expect(mocks.loadFieldNamesForFilterIds).toHaveBeenCalledWith("test-install", "f1", ["500"]);
    expect(result.allDashboards[0].fieldRefs).toEqual(["Status", "Story Points"]);
    expect(result.fieldRefsAvailable).toBe(true);
  });

  test("unions fields across a dashboard's several gadgets without duplicates", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadDashboards.mockResolvedValue([row({
      gadgets: [{ id: "g1", filterId: "500" }, { id: "g2", filterId: "501" }],
    })]);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1", state: "ready" });
    mocks.loadFieldNamesForFilterIds.mockResolvedValue(new Map([
      ["500", ["Story Points"]],
      ["501", ["Story Points", "Assignee"]],
    ]));

    const result = await getDashboardInventory({ context: ctxWithAccount() });
    expect(result.allDashboards[0].fieldRefs).toEqual(["Assignee", "Story Points"]);
  });

  // Tri-state: no filter inventory means the join could not run, which is a different fact
  // from a dashboard whose gadgets reference nothing.
  test("reports fields as unmeasured, not empty, when no filter inventory exists", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadDashboards.mockResolvedValue([row()]);
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);

    const result = await getDashboardInventory({ context: ctxWithAccount() });

    expect(result.allDashboards[0].fieldRefs).toBeNull();
    expect(result.fieldRefsAvailable).toBe(false);
    expect(mocks.loadFieldNamesForFilterIds).not.toHaveBeenCalled();
  });

  test("reports an empty list, not null, when the inventory exists but nothing is referenced", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadDashboards.mockResolvedValue([row({ gadgets: [{ id: "g1", filterId: null }] })]);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1", state: "ready" });

    const result = await getDashboardInventory({ context: ctxWithAccount() });

    expect(result.allDashboards[0].fieldRefs).toEqual([]);
    expect(result.fieldRefsAvailable).toBe(true);
    expect(mocks.loadFieldNamesForFilterIds).not.toHaveBeenCalled();
  });

  // Per-gadget, not just the dashboard-wide union -- "this dashboard depends on Story
  // Points somewhere" and "this gadget depends on Story Points" are different claims, and
  // only the second says which gadget breaks if the field goes.
  test("attaches which filter each gadget uses, by name, alongside its own field refs", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadDashboards.mockResolvedValue([row({
      gadgets: [{ id: "g1", title: "Open bugs", filterId: "500" }, { id: "g2", title: "No filter", filterId: null }],
    })]);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1", state: "ready" });
    mocks.loadFieldNamesForFilterIds.mockResolvedValue(new Map([["500", ["Story Points", "Status"]]]));
    mocks.loadFilterNamesForIds.mockResolvedValue(new Map([["500", { name: "Open Bugs", viewUrl: "https://x/issues/?filter=500" }]]));

    const result = await getDashboardInventory({ context: ctxWithAccount() });

    expect(mocks.loadFilterNamesForIds).toHaveBeenCalledWith("test-install", "f1", ["500"]);
    const [g1, g2] = result.allDashboards[0].gadgets;
    expect(g1.filterName).toBe("Open Bugs");
    expect(g1.filterViewUrl).toBe("https://x/issues/?filter=500");
    expect(g1.fieldRefs).toEqual(["Story Points", "Status"]);
    // A gadget with no filter id has nothing to resolve, and stays untouched rather than
    // gaining a filterName of null that would read as "resolved to nothing".
    expect(g2.filterName).toBeUndefined();
  });

  // Tri-state at the gadget level too: a gadget that DOES have a filter id, on a dashboard
  // read before any filter inventory exists, is unmeasured -- not "no filter", and not
  // silently missing the property either.
  test("reports a gadget's filter as unmeasured, not omitted, when no filter inventory exists", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadDashboards.mockResolvedValue([row()]);
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);

    const result = await getDashboardInventory({ context: ctxWithAccount() });

    const [gadget] = result.allDashboards[0].gadgets;
    expect(gadget.filterName).toBeNull();
    expect(gadget.fieldRefs).toBeNull();
  });
});

describe("buildDashboardInventory", () => {
  test("queues a build and marks the row building", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue(null);
    mocks.kvsGet.mockResolvedValue(null);

    const result = await buildDashboardInventory({ context: ctxWithAccount() });

    expect(result).toMatchObject({ queued: true });
    expect(mocks.writeDashboardSnapshotMeta).toHaveBeenCalledWith("test-install", expect.objectContaining({ state: "building" }));
  });

  test("refuses in read-only mode, and says so", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue(null);
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true });

    const result = await buildDashboardInventory({ context: ctxWithAccount() });
    expect(result.queued).toBe(false);
    expect(result.error).toMatch(/Read-only/);
  });

  test("does not queue a second build over one still running", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ state: "building", startedAt: new Date().toISOString() });
    expect(await buildDashboardInventory({ context: ctxWithAccount() }))
      .toMatchObject({ queued: false, reason: "already-building" });
  });

  // A wedged row would otherwise suppress every future rebuild with no way out of the UI.
  test("queues over a build that can no longer be running", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({
      state: "building",
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    mocks.kvsGet.mockResolvedValue(null);

    expect(await buildDashboardInventory({ context: ctxWithAccount() })).toMatchObject({ queued: true });
  });
});

// A dashboard build hard-killed at the invocation ceiling wedges the tab exactly as the
// filter one did. Both read paths carry the flag, because the wedge is as reachable on a
// rebuild as on a first build.
describe("getDashboardInventory staleness", () => {
  test("reports a wedged build on both the never-built and rebuild paths", async () => {
    const wedged = { state: "building", startedAt: new Date(Date.now() - 3600e3).toISOString() };

    mocks.readDashboardSnapshotMeta.mockResolvedValue({ ...wedged, version: null });
    expect((await getDashboardInventory({ context: ctxWithAccount() })).staleBuild).toBe(true);

    mocks.readDashboardSnapshotMeta.mockResolvedValue({ ...wedged, version: "v1" });
    const live = await getDashboardInventory({ context: ctxWithAccount() });
    expect(live.available).toBe(true);
    expect(live.staleBuild).toBe(true);
  });

  test("does not call a build that just started stale", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({
      version: "v1", state: "building", startedAt: new Date().toISOString(),
    });
    expect((await getDashboardInventory({ context: ctxWithAccount() })).staleBuild).toBe(false);
  });
});

// The bug this exists to stop recurring: two resolvers pushed a bare payload instead of
// wrapping it in `body`, and Forge rejected the invocation with "Event body must be an
// object" the first time a user clicked the button. Every test involved passed, because they
// asserted that a push happened and not what was pushed.
//
// Swept rather than spot-checked. A per-resolver assertion only protects the resolvers
// somebody remembered to write one for, and that is precisely the failure mode here.
describe("every queued job carries a body envelope", () => {
  const queuers = [
    ["buildFilterInventory", () => buildFilterInventory({ context: ctxWithAccount() })],
    ["buildScreenInventory", () => buildScreenInventory({ context: ctxWithAccount() })],
    ["buildDashboardInventory", () => buildDashboardInventory({ context: ctxWithAccount() })],
  ];

  test.each(queuers)("%s pushes { body: { jobType, installationKey } }", async (_name, run) => {
    mocks.kvsGet.mockResolvedValue(null);
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);
    mocks.readDashboardSnapshotMeta.mockResolvedValue(null);
    mocks.queuePush.mockClear();

    await run();

    for (const call of mocks.queuePush.mock.calls) {
      const payload = call[0];
      // The consumer reads event?.body?.jobType. Anything else is a job that cannot run.
      expect(payload).toHaveProperty("body");
      expect(typeof payload.body).toBe("object");
      expect(payload.body).toHaveProperty("jobType");
      expect(payload).not.toHaveProperty("jobType");
    }
  });
});

// ---------------------------------------------------------------------------
// Rovo workflow & status agent (search / inspect / impact)
// ---------------------------------------------------------------------------
describe("rovo workflow agent", () => {
  const ctx = () => ctxWithAccount();

  function seedBuilt() {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v9", state: "ready", refreshedAt: "2026-09-01T00:00:00.000Z" });
    mocks.loadWorkflowSchemes.mockResolvedValue([
      { schemeId: "s1", name: "Software Simplified Workflow Scheme", description: "the default", defaultWorkflow: "SSW", projectCount: 3 },
      { schemeId: "s2", name: "Ops Scheme", description: "", defaultWorkflow: "Ops", projectCount: 1 },
    ]);
    mocks.loadStatusesCatalog.mockResolvedValue([
      { statusId: "1", name: "To Do", statusCategory: "To Do" },
      { statusId: "2", name: "In Review", statusCategory: "In Progress" },
      { statusId: "3", name: "In  Review", statusCategory: "In Progress" }, // spacing dup of #2
      { statusId: "9", name: "On Hold", statusCategory: "In Progress" },
    ]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([
      { schemeId: "s1", statusId: "1" }, { schemeId: "s1", statusId: "2" }, { schemeId: "s2", statusId: "1" },
    ]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map([["1", 40], ["2", 5], ["9", 0]]));
    mocks.loadStatusHistoryCounts.mockResolvedValue({ counts: new Map([["9", 12]]), measuredAt: "2026-08-01" });
    mocks.loadWorkflowSchemeProjects.mockResolvedValue([{ projectKey: "ABC", projectName: "Alpha" }]);
    mocks.loadStatusAutomationReferences.mockResolvedValue({});
    // Board and filter checks default to "checked and clean" -- an inventory exists and
    // references nothing -- so existing tests that only care about the scheme/automation
    // side keep working, and a test that wants "not yet built" overrides these explicitly.
    mocks.readBoardSnapshotMeta.mockResolvedValue({ version: "b1" });
    mocks.loadBoardColumns.mockResolvedValue([]);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.loadFilterReferencesFor.mockResolvedValue({ total: 0, filters: [] });
  }

  test("search: returns workflows-unavailable when no snapshot exists", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ state: "idle" });
    const r = await rovoWorkflowSearch({ query: "review" }, ctx());
    expect(r.status).toBe("workflows-unavailable");
    expect(r.snapshotStatus).toEqual({ state: "idle", refreshedAt: null });
  });

  test("search: ranks scheme and status matches and carries refreshedAt", async () => {
    seedBuilt();
    const r = await rovoWorkflowSearch({ query: "review" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.refreshedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(r.statuses.map((s) => s.name)).toContain("In Review");
    expect(r.statuses[0]).toMatchObject({ issueCount: 5, category: "In Progress" });
  });

  test("search: kind=scheme suppresses status matches", async () => {
    seedBuilt();
    const r = await rovoWorkflowSearch({ query: "scheme", kind: "scheme" }, ctx());
    expect(r.statuses).toEqual([]);
    expect(r.schemes.length).toBeGreaterThan(0);
  });

  test("search: an empty query is an error", async () => {
    const r = await rovoWorkflowSearch({ query: "  " }, ctx());
    expect(r.status).toBe("error");
  });

  test("inspect: a scheme returns its statuses, balance and governed projects", async () => {
    seedBuilt();
    const r = await rovoWorkflowInspect({ identifier: "Software Simplified Workflow Scheme" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.kind).toBe("scheme");
    expect(r.statuses.map((s) => s.name).sort()).toEqual(["In Review", "To Do"]);
    expect(r.projects).toEqual([{ projectKey: "ABC", projectName: "Alpha" }]);
  });

  test("inspect: a status reports schemes that reach it and near-duplicate siblings", async () => {
    seedBuilt();
    const r = await rovoWorkflowInspect({ identifier: "In Review" }, ctx());
    expect(r.kind).toBe("status");
    expect(r.reachedBySchemes.map((s) => s.name)).toEqual(["Software Simplified Workflow Scheme"]);
    expect(r.duplicateSiblings.map((s) => s.name)).toContain("In  Review");
  });

  test("inspect: unknown identifier is not-found, not unavailable", async () => {
    seedBuilt();
    const r = await rovoWorkflowInspect({ identifier: "Nope" }, ctx());
    expect(r.status).toBe("not-found");
    expect(r.refreshedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  test("impact: a status no scheme reaches with a measured-zero count and no rules is no-evidence-of-use", async () => {
    seedBuilt();
    const r = await rovoWorkflowImpact({ name: "On Hold" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.reachedBySchemeCount).toBe(0);
    expect(r.issueCount).toBe(0);
    expect(r.boardChecked).toBe(true);
    expect(r.onAnyBoard).toBe(false);
    expect(r.filtersChecked).toBe(true);
    expect(r.referencingFilterCount).toBe(0);
    expect(r.verdict).toBe("no-evidence-of-use");
    // Drawn from the same assessStatusDeletion/computeVerdict core assessFieldDeletion uses --
    // not a bespoke boolean, so the response also carries the blockers/gaps shape.
    expect(r.blockers).toEqual([]);
    expect(r.gaps).toEqual([]);
    expect(r.verdictCaveat).toMatch(/board columns, saved filter JQL/);
  });

  test("impact: a status no board column maps and no filter references is still in-use when a board column DOES map it", async () => {
    seedBuilt();
    // "On Hold" (id 9) is otherwise the no-evidence case above; a board column mapping it
    // is the one thing left that should flip the verdict even with zero schemes, zero
    // issues and zero rules.
    mocks.loadBoardColumns.mockResolvedValue([{ boardId: "100", statusIds: ["9"] }]);
    const r = await rovoWorkflowImpact({ name: "On Hold" }, ctx());
    expect(r.onAnyBoard).toBe(true);
    expect(r.verdict).toBe("in-use");
    expect(r.blockers).toEqual([expect.objectContaining({ source: "boards" })]);
  });

  test("impact: a status referenced by a saved filter's JQL is not no-evidence, even with zero schemes, rules or issues", async () => {
    seedBuilt();
    mocks.loadFilterReferencesFor.mockResolvedValue({
      total: 1,
      filters: [{ id: "4001", name: "Everything On Hold" }],
    });
    const r = await rovoWorkflowImpact({ name: "On Hold" }, ctx());
    expect(r.referencingFilterCount).toBe(1);
    expect(r.referencingFilters).toEqual([{ id: "4001", name: "Everything On Hold" }]);
    expect(r.verdict).toBe("in-use");
    expect(r.blockers).toEqual([expect.objectContaining({ source: "filters", summary: expect.stringContaining("Everything On Hold") })]);
  });

  test("impact: no board inventory downgrades to unknown, never a false no-evidence, even at zero blockers", async () => {
    seedBuilt();
    mocks.readBoardSnapshotMeta.mockResolvedValue(null);
    const r = await rovoWorkflowImpact({ name: "On Hold" }, ctx());
    expect(r.boardChecked).toBe(false);
    expect(r.onAnyBoard).toBeNull();
    // Zero blockers everywhere else, but one pillar (boards) was never checked -- that is
    // exactly the unknown case, not a false no-evidence and not a false in-use.
    expect(r.verdict).toBe("unknown");
    expect(r.blockers).toEqual([]);
    expect(r.gaps).toEqual([expect.objectContaining({ source: "board columns" })]);
  });

  test("impact: a confirmed automation blocker is in-use even when issue counts were never measured", async () => {
    // The bug the previous ad-hoc noEvidence boolean had: a real, confirmed blocker (a rule
    // transitioning into the status) could still read "unknown" if issue counts happened to
    // be unmeasured, because the old fallback branched on hasIssueCounts instead of on
    // whether any blocker existed. computeVerdict does not repeat that.
    seedBuilt();
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map()); // hasIssueCounts becomes false
    mocks.loadStatusAutomationReferences.mockResolvedValue({ "on hold": { ruleCount: 2, enabledRuleCount: 2 } });
    const r = await rovoWorkflowImpact({ name: "On Hold" }, ctx());
    expect(r.issueCount).toBeNull();
    expect(r.verdict).toBe("in-use");
    expect(r.blockers).toEqual([expect.objectContaining({ source: "automation" })]);
  });

  test("impact: a status issues sit in is in-use with its governed project sample", async () => {
    seedBuilt();
    const r = await rovoWorkflowImpact({ name: "To Do" }, ctx());
    expect(r.verdict).toBe("in-use");
    expect(r.reachedBySchemeCount).toBe(2);
    expect(r.projectSample).toContain("ABC");
  });

  test("impact: unknown status is not-found", async () => {
    seedBuilt();
    const r = await rovoWorkflowImpact({ name: "Ghost" }, ctx());
    expect(r.status).toBe("not-found");
  });

  test("impact: missing snapshot is workflows-unavailable", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue(null);
    const r = await rovoWorkflowImpact({ name: "To Do" }, ctx());
    expect(r.status).toBe("workflows-unavailable");
  });
});


// ---------------------------------------------------------------------------
// Rovo issue type agent
// ---------------------------------------------------------------------------
describe("rovo issue type agent", () => {
  const ctx = () => ctxWithAccount();

  function seed() {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ version: "v3", state: "ready", refreshedAt: "2026-09-02T00:00:00.000Z" });
    mocks.loadIssueTypes.mockResolvedValue([
      { id: "10", name: "Bug", hierarchyLevel: 0, subtask: false, description: "a defect" },
      { id: "11", name: "Change Request", hierarchyLevel: 0, subtask: false, description: "" },
      { id: "12", name: "Sub-task", hierarchyLevel: -1, subtask: true, description: "" },
    ]);
    mocks.loadIssueTypeSchemes.mockResolvedValue([
      { schemeId: "s1", name: "Default Issue Type Scheme", isDefault: true, defaultIssueTypeId: "10" },
      { schemeId: "s2", name: "Ops Scheme", isDefault: false },
    ]);
    mocks.loadIssueTypeSchemeItems.mockResolvedValue([
      { schemeId: "s1", issueTypeId: "10" }, { schemeId: "s1", issueTypeId: "11" },
    ]);
    mocks.loadIssueTypeSchemeProjects.mockResolvedValue([
      { schemeId: "s1", projectId: "1", projectKey: "ABC", projectName: "Alpha" },
    ]);
  }

  test("search: unavailable with no snapshot", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "idle" });
    const r = await rovoIssueTypeSearch({ query: "bug" }, ctx());
    expect(r.status).toBe("issue types-unavailable");
  });

  test("search: ranks type and scheme matches", async () => {
    seed();
    const r = await rovoIssueTypeSearch({ query: "change" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.refreshedAt).toBe("2026-09-02T00:00:00.000Z");
    expect(r.issueTypes.map((t) => t.name)).toContain("Change Request");
  });

  test("inspect: a scheme lists its members and projects", async () => {
    seed();
    const r = await rovoIssueTypeInspect({ identifier: "Default Issue Type Scheme" }, ctx());
    expect(r.kind).toBe("scheme");
    expect(r.issueTypes.map((t) => t.name).sort()).toEqual(["Bug", "Change Request"]);
    expect(r.projects).toEqual([{ projectKey: "ABC", projectName: "Alpha" }]);
  });

  test("inspect: a type reports which schemes reach it", async () => {
    seed();
    const r = await rovoIssueTypeInspect({ identifier: "Bug" }, ctx());
    expect(r.kind).toBe("type");
    expect(r.reachedBySchemeCount).toBe(1);
  });

  test("impact: a type no scheme reaches is no-scheme-reaches-it", async () => {
    seed();
    const r = await rovoIssueTypeImpact({ name: "Sub-task" }, ctx());
    expect(r.verdict).toBe("no-scheme-reaches-it");
    expect(r.reachedBySchemeCount).toBe(0);
  });

  test("impact: unknown type is not-found", async () => {
    seed();
    const r = await rovoIssueTypeImpact({ name: "Ghost" }, ctx());
    expect(r.status).toBe("not-found");
  });
});

// ---------------------------------------------------------------------------
// Rovo access agent
// ---------------------------------------------------------------------------
describe("rovo access agent", () => {
  const ctx = () => ctxWithAccount();

  function seed() {
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "v2", state: "ready", refreshedAt: "2026-09-03T00:00:00.000Z" });
    mocks.readUserSnapshotMeta.mockResolvedValue(null);
    mocks.loadSchemes.mockImplementation(async (_k, _v, family) => {
      if (family === "permission") return [{ id: "p1", name: "Default Permission Scheme", description: "" }];
      if (family === "notification") return [{ id: "n1", name: "Default Notification Scheme", description: "" }];
      return [];
    });
    mocks.loadSchemeHolders.mockImplementation(async (_k, _v, family) => {
      // The real stored shape (store/access.js loadSchemeHolders). These fixtures used to
      // carry holderName, permission and offRoster, matching what the agent wrongly read,
      // which is how a resolver returning null grants passed its tests.
      if (family === "permission") return [
        { schemeId: "p1", context: "ADMINISTER_PROJECTS", contextLabel: "Administer Projects", holderType: "group", holderValue: "grp-1", holderLabel: "jira-administrators" },
        { schemeId: "p1", context: "BROWSE_PROJECTS", contextLabel: "Browse Projects", holderType: "anyone", holderValue: "", holderLabel: null },
        { schemeId: "p1", context: "BROWSE_PROJECTS", contextLabel: "Browse Projects", holderType: "user", holderValue: "acc-gone", holderLabel: "Sam Gone" },
      ];
      return [];
    });
    mocks.loadSchemeProjects.mockResolvedValue([{ schemeId: "p1", projectId: "1" }]);
    mocks.loadSchemeLevels.mockResolvedValue([]);
  }

  test("search: unavailable with no snapshot", async () => {
    mocks.readAccessSnapshotMeta.mockResolvedValue({ state: "idle" });
    const r = await rovoAccessSearch({ query: "default" }, ctx());
    expect(r.status).toBe("access-unavailable");
  });

  test("search: matches per family", async () => {
    seed();
    const r = await rovoAccessSearch({ query: "default" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.schemes.permissions.map((s) => s.name)).toContain("Default Permission Scheme");
    expect(r.schemes.notifications.map((s) => s.name)).toContain("Default Notification Scheme");
  });

  test("search: family filter narrows to one set", async () => {
    seed();
    const r = await rovoAccessSearch({ query: "default", family: "permissions" }, ctx());
    expect(Object.keys(r.schemes)).toEqual(["permissions"]);
  });

  test("inspect: a scheme returns its holders and holder count", async () => {
    seed();
    const r = await rovoAccessInspect({ identifier: "Default Permission Scheme" }, ctx());
    expect(r.family).toBe("permissions");
    expect(r.holderCount).toBe(3);
    expect(r.holders.map((h) => h.value)).toContain("jira-administrators");
    expect(r.holders.find((h) => h.value === "jira-administrators")).toMatchObject({ id: "grp-1", permission: "Administer Projects", offRoster: false });
  });

  test("inspect: a user holder is off-roster when the people snapshot does not list them", async () => {
    seed();
    mocks.readUserSnapshotMeta.mockResolvedValue({ version: "u1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "acc-1", active: true }]);
    const r = await rovoAccessInspect({ identifier: "Default Permission Scheme" }, ctx());
    expect(r.holders.find((h) => h.id === "acc-gone").offRoster).toBe(true);
  });

  // No people snapshot: whether a user is on the roster is unknown, not "no".
  test("inspect: off-roster is unknown when there is no people snapshot", async () => {
    seed();
    const r = await rovoAccessInspect({ identifier: "Default Permission Scheme" }, ctx());
    expect(r.holders.find((h) => h.id === "acc-gone").offRoster).toBeNull();
  });

  test("inspect: unknown scheme is not-found", async () => {
    seed();
    const r = await rovoAccessInspect({ identifier: "Nope" }, ctx());
    expect(r.status).toBe("not-found");
  });

  test("impact: a group names in schemes reports where and how", async () => {
    seed();
    const r = await rovoAccessImpact({ name: "jira-administrators" }, ctx());
    expect(r.verdict).toBe("named-in-schemes");
    expect(r.namedIn[0]).toMatchObject({ family: "permissions", as: "group", holder: "jira-administrators", grants: "Administer Projects" });
    expect(r.verdictCaveat).toMatch(/global permissions/);
  });

  test("impact: finds a group by its id as well as its name", async () => {
    seed();
    const r = await rovoAccessImpact({ name: "grp-1" }, ctx());
    expect(r.namedInCount).toBe(1);
  });

  test("impact: an unnamed account is not-named-in-any-scheme", async () => {
    seed();
    const r = await rovoAccessImpact({ name: "5b10ffffffffffffffffffff" }, ctx());
    expect(r.verdict).toBe("not-named-in-any-scheme");
    expect(r.namedInCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rovo people agent
// ---------------------------------------------------------------------------
describe("rovo people agent", () => {
  const ctx = () => ctxWithAccount();

  function seedRoster() {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "u1", refreshedAt: "2026-09-03T00:00:00.000Z" });
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readAccessSnapshotMeta.mockResolvedValue(null);
    mocks.readAutomationPart.mockResolvedValue(null);
    mocks.loadSchemesGrantingHolder.mockResolvedValue([]);
    mocks.loadUsers.mockResolvedValue([
      { accountId: "acc-1", displayName: "Dana Ops", active: true, groups: [{ id: "g1", name: "ops-team" }], applications: ["jira-software"] },
      { accountId: "acc-2", displayName: "Sam Gone", active: false, groups: [], applications: [] },
    ]);
    mocks.loadUserGovernanceSummary.mockResolvedValue({ totalUsers: 2, activeUsers: 1 });
  }

  test("search: unavailable with no roster", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue(null);
    const r = await rovoPeopleSearch({ query: "dana" }, ctx());
    expect(r.status).toBe("people-unavailable");
  });

  test("search: resolves a display name to an account and surfaces groups", async () => {
    seedRoster();
    const r = await rovoPeopleSearch({ query: "ops" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.users.map((u) => u.accountId)).toContain("acc-1");
    expect(r.groups.map((g) => g.name)).toContain("ops-team");
    expect(r.rosterSize).toBe(2);
  });

  test("search: empty query errors", async () => {
    const r = await rovoPeopleSearch({ query: "" }, ctx());
    expect(r.status).toBe("error");
  });

  test("inspect: requires an accountId", async () => {
    const r = await rovoPeopleInspect({}, ctx());
    expect(r.status).toBe("error");
  });

  test("inspect: unavailable when getUserDetails has no roster", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue(null);
    const r = await rovoPeopleInspect({ accountId: "acc-1" }, ctx());
    expect(r.status).toBe("people-unavailable");
  });

  test("inspect: returns a footprint shape for a known account", async () => {
    seedRoster();
    const r = await rovoPeopleInspect({ accountId: "acc-1" }, ctx());
    expect(r.status).toBe("ok");
    expect(r).toHaveProperty("ownedFilters");
    expect(r).toHaveProperty("referencedInRules");
  });

  test("impact: returns a verdict and per-source data caveats", async () => {
    seedRoster();
    const r = await rovoPeopleImpact({ accountId: "acc-2" }, ctx());
    expect(r.status).toBe("ok");
    expect(["no-cross-pillar-footprint", "has-footprint"]).toContain(r.verdict);
    expect(r.dataCaveats).toHaveProperty("automation");
    expect(r.verdictCaveat).toMatch(/ownerless/);
  });

  // Cross-pillar (Access via groups): most real access runs through a group, and a scheme
  // granting to a group the account belongs to used to be invisible to this verdict entirely
  // -- an account holding admin purely via group membership read as "no footprint".
  test("impact: has-footprint from a group-granted scheme alone, with no direct grant, owned artifact or rule reference", async () => {
    seedRoster();
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    mocks.loadSchemesGrantingHolder.mockImplementation((_i, _v, holderType, holderValue) => {
      if (holderType === "group" && holderValue === "g1") {
        return Promise.resolve([{ schemeType: "permission", schemeId: "1", schemeName: "Prod", context: "ADMINISTER_PROJECTS" }]);
      }
      return Promise.resolve([]);
    });

    const r = await rovoPeopleImpact({ accountId: "acc-1" }, ctx()); // acc-1 is in group g1
    expect(r.verdict).toBe("has-footprint");
    expect(r.groupSchemeGrants).toBe(1);
    expect(r.grantedViaGroups).toEqual(["ops-team"]);
    expect(r.verdictCaveat).toMatch(/held through a group membership/);
  });

  test("impact: two groups granting the same scheme count once, not twice", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "u1" });
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readAutomationPart.mockResolvedValue(null);
    mocks.loadUsers.mockResolvedValue([
      { accountId: "acc-1", displayName: "Dana Ops", active: true, groups: [{ id: "g1", name: "ops-team" }, { id: "g2", name: "ops-leads" }], applications: [] },
    ]);
    mocks.loadUserGovernanceSummary.mockResolvedValue({ totalUsers: 1, activeUsers: 1 });
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    mocks.loadSchemesGrantingHolder.mockImplementation((_i, _v, holderType) => {
      if (holderType === "group") {
        return Promise.resolve([{ schemeType: "permission", schemeId: "1", schemeName: "Prod", context: "ADMINISTER_PROJECTS" }]);
      }
      return Promise.resolve([]);
    });

    const r = await rovoPeopleImpact({ accountId: "acc-1" }, ctx());
    expect(r.groupSchemeGrants).toBe(1);
    expect(r.grantedViaGroups.sort()).toEqual(["ops-leads", "ops-team"]);
  });

  test("impact: no cross-pillar footprint when no groups grant anything", async () => {
    seedRoster();
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    mocks.loadSchemesGrantingHolder.mockResolvedValue([]);
    const r = await rovoPeopleImpact({ accountId: "acc-2" }, ctx()); // acc-2 has no groups
    expect(r.groupSchemeGrants).toBe(0);
    expect(r.grantedViaGroups).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rovo assets agent
// ---------------------------------------------------------------------------
describe("rovo assets agent", () => {
  const ctx = () => ctxWithAccount();

  function seed() {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "ready", version: "as1", assetsEnabled: true, refreshedAt: "2026-09-02T00:00:00.000Z" });
    mocks.loadAssetSchemas.mockResolvedValue([{ id: "1", name: "Infrastructure", objectSchemaKey: "INFRA", objectTypeCount: 2 }]);
    mocks.loadAssetObjectTypes.mockResolvedValue([
      { id: "9", objectSchemaId: "1", name: "Server", parentObjectTypeId: null },
      { id: "10", objectSchemaId: "1", name: "Rack", parentObjectTypeId: "9" },
    ]);
    mocks.loadAssetAttributes.mockResolvedValue([
      { objectTypeId: "10", name: "Location", type: "text", referenceObjectTypeId: null },
      { objectTypeId: "10", name: "Hosts", type: "reference", referenceObjectTypeId: "9" },
    ]);
  }

  test("search: assets-not-enabled is its own state", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "unavailable", assetsEnabled: false });
    const r = await rovoAssetSearch({ query: "server" }, ctx());
    expect(r.status).toBe("assets-not-enabled");
  });

  test("search: unavailable when built but no version", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "idle" });
    const r = await rovoAssetSearch({ query: "server" }, ctx());
    expect(r.status).toBe("assets-unavailable");
  });

  test("search: ranks schema and type matches", async () => {
    seed();
    const r = await rovoAssetSearch({ query: "rack" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.objectTypes.map((t) => t.name)).toContain("Rack");
  });

  test("inspect: a type reports attributes, children and reference count", async () => {
    seed();
    const r = await rovoAssetInspect({ identifier: "Server" }, ctx());
    expect(r.kind).toBe("type");
    expect(r.childTypes.map((c) => c.name)).toContain("Rack");
    expect(r.referencedByAttributeCount).toBe(1);
  });

  test("impact: a referenced type is 'referenced'", async () => {
    seed();
    const r = await rovoAssetImpact({ name: "Server" }, ctx());
    expect(r.verdict).toBe("referenced");
    expect(r.referencedByAttributeCount).toBe(1);
  });

  test("impact: unknown type is not-found", async () => {
    seed();
    const r = await rovoAssetImpact({ name: "Ghost" }, ctx());
    expect(r.status).toBe("not-found");
  });
});

// ---------------------------------------------------------------------------
// Rovo priorities & resolutions agent
// ---------------------------------------------------------------------------
describe("rovo estate agent", () => {
  const ctx = () => ctxWithAccount();

  function seed() {
    mocks.readEstateSnapshotMeta.mockResolvedValue({ state: "ready", version: "e1", refreshedAt: "2026-09-03T00:00:00.000Z" });
    mocks.loadEstateValues.mockImplementation(async (_k, _v, kind) => {
      if (kind === "resolution") return [
        { id: "1", name: "Done", isDefault: true }, { id: "2", name: "Fixed", isDefault: false },
      ];
      return [{ id: "1", name: "High", isDefault: false }, { id: "2", name: "Low", isDefault: false }];
    });
  }

  test("search: unavailable with no snapshot", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValue(null);
    const r = await rovoEstateSearch({ query: "done" }, ctx());
    expect(r.status).toBe("priorities & resolutions-unavailable");
  });

  test("search: matches resolutions and priorities", async () => {
    seed();
    const r = await rovoEstateSearch({ query: "done" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.resolutions.map((x) => x.name)).toContain("Done");
  });

  test("inspect: reports counts and whether each list has a default", async () => {
    seed();
    const r = await rovoEstateInspect({}, ctx());
    expect(r.status).toBe("ok");
    expect(r.resolutions.hasDefault).toBe(true);
    expect(r.priorities.hasDefault).toBe(false);
  });

  test("inspect: list filter narrows the response", async () => {
    seed();
    const r = await rovoEstateInspect({ list: "priorities" }, ctx());
    expect(r).not.toHaveProperty("resolutions");
    expect(r.priorities.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Rovo screen agent
// ---------------------------------------------------------------------------
describe("rovo screen agent", () => {
  const ctx = () => ctxWithAccount();

  function seed() {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ state: "ready", version: "sv1", refreshedAt: "2026-09-02T00:00:00.000Z" });
    mocks.loadScreensPage.mockResolvedValue({ total: 2, rows: [
      { screenId: "100", name: "Default Create Screen", fieldCount: 30, tabCount: 2, projectCount: 40, tabs: [{ name: "Field Tab", fields: [1, 2] }] },
      { screenId: "101", name: "Bug Screen", fieldCount: 12, tabCount: 1, projectCount: 3 },
    ] });
    mocks.loadScreenSchemes.mockResolvedValue([{ id: "5", name: "Default Screen Scheme" }]);
    mocks.loadScreenSchemeOperations.mockResolvedValue([
      { schemeId: "5", schemeName: "Default Screen Scheme", operation: "default", screenId: "100" },
    ]);
    mocks.loadIssueTypeScreenSchemes.mockResolvedValue([]);
  }

  test("search: unavailable with no snapshot", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);
    const r = await rovoScreenSearch({ query: "create" }, ctx());
    expect(r.status).toBe("screens-unavailable");
  });

  test("search: ranks screen and scheme matches", async () => {
    seed();
    const r = await rovoScreenSearch({ query: "screen" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.screenSchemes.map((s) => s.name)).toContain("Default Screen Scheme");
  });

  test("inspect: a screen returns tabs and field count", async () => {
    seed();
    const r = await rovoScreenInspect({ identifier: "Default Create Screen" }, ctx());
    expect(r.kind).toBe("screen");
    expect(r.screen.fieldCount).toBe(30);
    expect(r.screen.tabs[0]).toMatchObject({ name: "Field Tab", fieldCount: 2 });
  });

  test("inspect: a scheme returns its operation mapping", async () => {
    seed();
    const r = await rovoScreenInspect({ identifier: "Default Screen Scheme" }, ctx());
    expect(r.kind).toBe("scheme");
    expect(r.operations[0]).toMatchObject({ operation: "default", screenId: "100" });
  });

  test("impact: a screen a scheme operation points at is 'routed'", async () => {
    seed();
    const r = await rovoScreenImpact({ name: "Default Create Screen" }, ctx());
    expect(r.verdict).toBe("routed");
    expect(r.routedBySchemeCount).toBe(1);
  });

  test("impact: a screen nothing points at is 'nothing-routes-to-it'", async () => {
    seed();
    const r = await rovoScreenImpact({ name: "Bug Screen" }, ctx());
    expect(r.verdict).toBe("nothing-routes-to-it");
  });
});

// ---------------------------------------------------------------------------
// Rovo configuration change agent
// ---------------------------------------------------------------------------
describe("rovo change agent", () => {
  const ctx = () => ctxWithAccount();

  function seed() {
    mocks.readDriftSnapshotMeta.mockResolvedValue({ state: "ready", version: "dv1", refreshedAt: "2026-09-03T00:00:00.000Z", totalChanges: 3 });
    mocks.loadConfigChanges.mockResolvedValue([
      { detectedAt: "2026-09-03", pillar: "workflows", entityType: "status", label: "In Review", changeKind: "modified", summary: "category changed" },
      { detectedAt: "2026-09-02", pillar: "access", entityType: "scheme", label: "Default Permission Scheme", changeKind: "modified", summary: "holder added" },
      { detectedAt: "2026-08-20", pillar: "workflows", entityType: "status", label: "In Review", changeKind: "added", summary: "created" },
    ]);
  }

  test("search: unavailable with no drift snapshot", async () => {
    mocks.readDriftSnapshotMeta.mockResolvedValue(null);
    const r = await rovoChangeSearch({ query: "review" }, ctx());
    expect(r.status).toBe("configuration changes-unavailable");
  });

  test("search: phrase-matches the entity label", async () => {
    seed();
    const r = await rovoChangeSearch({ query: "review" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.changes.every((c) => c.label === "In Review")).toBe(true);
    expect(r.totalRecorded).toBe(3);
  });

  test("search: no phrase lists recent changes", async () => {
    seed();
    const r = await rovoChangeSearch({}, ctx());
    expect(r.changes.length).toBe(3);
  });

  test("inspect: returns the full history for one entity", async () => {
    seed();
    const r = await rovoChangeInspect({ label: "In Review" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.changeCount).toBe(2);
    expect(r.history.map((h) => h.kind).sort()).toEqual(["added", "modified"]);
  });

  test("inspect: an entity with no recorded change is not-found", async () => {
    seed();
    const r = await rovoChangeInspect({ label: "Never Touched" }, ctx());
    expect(r.status).toBe("not-found");
  });
});

// ---------------------------------------------------------------------------
// Rovo project agent
// ---------------------------------------------------------------------------
describe("rovo project agent", () => {
  const ctx = () => ctxWithAccount();

  function seedProjects() {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "fv1", state: "ready" });
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha Beta" },
      { projectId: "11", projectKey: "XYZ", projectName: "Ex Why Zed" },
    ]);
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["10", "11"]));
  }

  test("search: unavailable when there is no field snapshot to list projects from", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    const r = await rovoProjectSearch({ query: "alpha" }, ctx());
    expect(r.status).toBe("projects-unavailable");
  });

  test("search: matches browsable projects by key or name", async () => {
    seedProjects();
    const r = await rovoProjectSearch({ query: "alpha" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.projects.map((p) => p.projectKey)).toContain("ABC");
    expect(r.browsableProjectCount).toBe(2);
  });

  test("inspect: requires an id or key", async () => {
    const r = await rovoProjectInspect({}, ctx());
    expect(r.status).toBe("error");
  });

  test("inspect: an unknown key is not-found", async () => {
    seedProjects();
    const r = await rovoProjectInspect({ projectKey: "NOPE" }, ctx());
    expect(r.status).toBe("not-found");
  });

  // The bug: a Rovo agent action arrives with no user principal, so getBrowsableProjectIds
  // (which needs an accountId) returns an empty set and every project reads as un-browsable.
  // With no caller to check against, the agent falls back to the app's own snapshot.
  test("search: falls back to the snapshot when the context carries no account", async () => {
    seedProjects();
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set()); // as it behaves with no accountId
    const r = await rovoProjectSearch({ query: "alpha" }, { installContext: "ari:cloud:jira::site/x" });
    expect(r.status).toBe("ok");
    expect(r.projects.map((p) => p.projectKey)).toContain("ABC");
  });

  test("search: still filters by browse permission when the context DOES carry an account", async () => {
    seedProjects();
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["11"])); // ABC not browsable for this user
    const r = await rovoProjectSearch({ query: "alpha" }, ctxWithAccount("limited-user"));
    expect(r.status).toBe("ok");
    expect(r.projects.map((p) => p.projectKey)).not.toContain("ABC");
  });

  // The action used to read keys the overview never returns, so every project came back
  // with no workflow scheme, no roles and no name.
  test("inspect: reports the workflow scheme, roles and name the overview holds", async () => {
    seedProjects();
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1" });
    mocks.loadWorkflowSchemeForProject.mockResolvedValueOnce({ schemeId: "ws1", name: "Software Simplified", description: "" });
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    mocks.loadProjectSchemes.mockResolvedValueOnce([]);
    mocks.loadProjectRoleActors.mockResolvedValueOnce([
      { roleId: "r1", roleName: "Administrators", holderType: "user", holderValue: "acc-1", holderLabel: "Dana" },
    ]);
    const r = await rovoProjectInspect({ projectId: "10", projectKey: "ABC" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.project).toMatchObject({ projectKey: "ABC", projectName: "Alpha Beta" });
    expect(r.project).not.toHaveProperty("lead");
    expect(r.workflowScheme).toMatchObject({ id: "ws1", name: "Software Simplified" });
    expect(r.roles.byRole[0]).toMatchObject({ roleName: "Administrators" });
    expect(r.dataCaveats).toMatch(/lead/);
  });

  test("inspect: an agent action (no account) reads a project the browse check would have hidden", async () => {
    seedProjects();
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set());
    mocks.attachUniqueIssueCounts?.mockImplementation?.(async (_k, rows) => rows);
    const r = await rovoProjectInspect({ projectId: "10", projectKey: "ABC" }, { installContext: "ari:cloud:jira::site/x" });
    // getProjectOverview no longer short-circuits to not-authorised; it proceeds to build.
    expect(r.status).not.toBe("not-authorised");
  });
});

describe("rovo boards agent", () => {
  const ctx = () => ctxWithAccount();

  function seedBoards() {
    mocks.readBoardSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1", refreshedAt: "2026-09-09T00:00:00Z" });
    mocks.loadBoards.mockResolvedValue([
      { boardId: "1", name: "PT2 Scrum", type: "scrum", locationType: "project", locationKey: "PT2", filterId: "4001", configReadable: true, columnCount: 2 },
      { boardId: "2", name: "Kanban Wall", type: "kanban", locationType: "project", locationKey: "AAA", filterId: null, configReadable: true, columnCount: 1 },
    ]);
    mocks.loadBoardColumns.mockResolvedValue([
      { boardId: "1", index: 0, name: "To Do", statusIds: ["10"] },
      { boardId: "1", index: 1, name: "Done", statusIds: ["5"] },
      { boardId: "2", index: 0, name: "Backlog", statusIds: [] },
    ]);
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    mocks.readWorkflowSnapshotMeta.mockResolvedValue(null);
  }

  test("search: unavailable when no board snapshot exists", async () => {
    mocks.readBoardSnapshotMeta.mockResolvedValue(null);
    const r = await rovoBoardSearch({ query: "scrum" }, ctx());
    expect(r.status).toBe("boards-unavailable");
  });

  test("search: matches by name and can filter by type", async () => {
    seedBoards();
    const all = await rovoBoardSearch({ query: "wall" }, ctx());
    expect(all.status).toBe("ok");
    expect(all.boards.map((b) => b.name)).toContain("Kanban Wall");

    const scrum = await rovoBoardSearch({ query: "board", type: "scrum" }, ctx());
    expect(scrum.boards.every((b) => b.type === "scrum")).toBe(true);
  });

  test("search: rejects an empty query", async () => {
    expect((await rovoBoardSearch({ query: "" }, ctx())).status).toBe("error");
  });

  test("inspect: returns one board with its columns and flags", async () => {
    seedBoards();
    const r = await rovoBoardInspect({ boardId: "2" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.board).toMatchObject({ name: "Kanban Wall", backingFilterId: null });
    expect(r.unmappedColumns).toBe(1);
    expect(r.issues).toContain("no-backing-filter");
    expect(r.joinsRun).toEqual({ filters: false, statuses: false });
  });

  test("inspect: an unknown board is not-found", async () => {
    seedBoards();
    expect((await rovoBoardInspect({ boardId: "999" }, ctx())).status).toBe("not-found");
  });

  test("inspect: requires an id or a name", async () => {
    expect((await rovoBoardInspect({}, ctx())).status).toBe("error");
  });

  test("impact: which boards a filter backs", async () => {
    seedBoards();
    const r = await rovoBoardImpact({ filterId: "4001" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.boardsBackedByFilter.map((b) => b.boardId)).toEqual(["1"]);
    expect(r.verdict).toBe("referenced");
  });

  test("impact: which boards map a status, and a clean verdict when none do", async () => {
    seedBoards();
    const hit = await rovoBoardImpact({ statusId: "10" }, ctx());
    expect(hit.boardsMappingStatus[0]).toMatchObject({ boardId: "1", columns: ["To Do"] });

    const miss = await rovoBoardImpact({ statusId: "nonexistent" }, ctx());
    expect(miss.verdict).toBe("no-board-references-it");
  });

  test("impact: requires a filterId or statusId", async () => {
    expect((await rovoBoardImpact({}, ctx())).status).toBe("error");
  });

  test("inspect: resolves a board by name, case-insensitively", async () => {
    seedBoards();
    const r = await rovoBoardInspect({ name: "kanban wall" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.board.boardId).toBe("2");
  });

  test("inspect: an unknown name is not-found and names what was looked for", async () => {
    seedBoards();
    const r = await rovoBoardInspect({ name: "Ghost Board" }, ctx());
    expect(r.status).toBe("not-found");
    expect(r.message).toMatch(/Ghost Board/);
  });

  test("search / inspect / impact all propagate an inventory failure rather than swallowing it", async () => {
    mocks.readBoardSnapshotMeta.mockRejectedValue(new Error("board store down"));
    await expect(rovoBoardSearch({ query: "x" }, ctx())).rejects.toThrow("board store down");
    await expect(rovoBoardInspect({ boardId: "1" }, ctx())).rejects.toThrow("board store down");
    await expect(rovoBoardImpact({ filterId: "1" }, ctx())).rejects.toThrow("board store down");
  });
});

// ---------------------------------------------------------------------------
// Rovo agents: error paths, filters and edge branches (coverage of the thin bits)
// ---------------------------------------------------------------------------
describe("rovo agents: edge branches", () => {
  const ctx = () => ctxWithAccount();

  test("every search action rejects an empty query", async () => {
    for (const fn of [rovoWorkflowSearch, rovoIssueTypeSearch, rovoAccessSearch, rovoPeopleSearch, rovoAssetSearch, rovoEstateSearch, rovoScreenSearch, rovoProjectSearch]) {
      const r = await fn({ query: "" }, ctx());
      expect(r.status).toBe("error");
    }
  });

  test("every inspect/impact action rejects a missing identifier", async () => {
    expect((await rovoWorkflowInspect({}, ctx())).status).toBe("error");
    expect((await rovoWorkflowImpact({}, ctx())).status).toBe("error");
    expect((await rovoIssueTypeInspect({}, ctx())).status).toBe("error");
    expect((await rovoIssueTypeImpact({}, ctx())).status).toBe("error");
    expect((await rovoAccessInspect({}, ctx())).status).toBe("error");
    expect((await rovoAccessImpact({}, ctx())).status).toBe("error");
    expect((await rovoPeopleImpact({}, ctx())).status).toBe("error");
    expect((await rovoAssetInspect({}, ctx())).status).toBe("error");
    expect((await rovoAssetImpact({}, ctx())).status).toBe("error");
    expect((await rovoScreenInspect({}, ctx())).status).toBe("error");
    expect((await rovoScreenImpact({}, ctx())).status).toBe("error");
    expect((await rovoChangeInspect({}, ctx())).status).toBe("error");
  });

  test("a loader that throws surfaces as a rejected resolver, not a silent result", async () => {
    mocks.readWorkflowSnapshotMeta.mockRejectedValueOnce(new Error("sql down"));
    await expect(rovoWorkflowSearch({ query: "x" }, ctx())).rejects.toThrow("sql down");
    mocks.readAccessSnapshotMeta.mockRejectedValueOnce(new Error("boom"));
    await expect(rovoAccessSearch({ query: "x" }, ctx())).rejects.toThrow("boom");
    mocks.readAssetSnapshotMeta.mockRejectedValueOnce(new Error("gw"));
    await expect(rovoAssetSearch({ query: "x" }, ctx())).rejects.toThrow("gw");
    mocks.readDriftSnapshotMeta.mockRejectedValueOnce(new Error("drift"));
    await expect(rovoChangeSearch({ query: "x" }, ctx())).rejects.toThrow("drift");
  });

  test("workflow search: kind=status suppresses schemes; issue-type kind=type suppresses schemes", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v", state: "ready", refreshedAt: "t" });
    mocks.loadWorkflowSchemes.mockResolvedValue([{ schemeId: "s", name: "Review Scheme" }]);
    mocks.loadStatusesCatalog.mockResolvedValue([{ statusId: "1", name: "Review", statusCategory: "In Progress" }]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map());
    mocks.loadStatusHistoryCounts.mockResolvedValue({ counts: new Map(), measuredAt: null });
    const r = await rovoWorkflowSearch({ query: "review", kind: "status" }, ctx());
    expect(r.schemes).toEqual([]);

    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ version: "v", state: "ready", refreshedAt: "t" });
    mocks.loadIssueTypes.mockResolvedValue([{ id: "1", name: "Review", hierarchyLevel: 0 }]);
    mocks.loadIssueTypeSchemes.mockResolvedValue([{ schemeId: "s", name: "Review Scheme" }]);
    mocks.loadIssueTypeSchemeItems.mockResolvedValue([]);
    mocks.loadIssueTypeSchemeProjects.mockResolvedValue([]);
    const r2 = await rovoIssueTypeSearch({ query: "review", kind: "type" }, ctx());
    expect(r2.schemes).toEqual([]);
  });

  test("assets: not-enabled short-circuits inspect and impact too", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "unavailable", assetsEnabled: false });
    expect((await rovoAssetInspect({ identifier: "x" }, ctx())).status).toBe("assets-not-enabled");
    expect((await rovoAssetImpact({ name: "x" }, ctx())).status).toBe("assets-not-enabled");
  });

  test("estate inspect: list=resolutions omits priorities", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValue({ state: "ready", version: "e", refreshedAt: "t" });
    mocks.loadEstateValues.mockImplementation(async (_k, _v, kind) =>
      kind === "resolution" ? [{ id: "1", name: "Done", isDefault: false }] : [{ id: "1", name: "High", isDefault: true }]);
    const r = await rovoEstateInspect({ list: "resolutions" }, ctx());
    expect(r).not.toHaveProperty("priorities");
    expect(r.resolutions.hasDefault).toBe(false);
  });

  test("project inspect: a project the caller cannot browse is not-authorised", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "fv", state: "ready" });
    mocks.listSnapshotProjects.mockResolvedValue([{ projectId: "10", projectKey: "ABC", projectName: "A" }]);
    mocks.getBrowsableProjectIds.mockImplementation(async (_a, ids) => new Set()); // nothing browsable
    const r = await rovoProjectInspect({ projectId: "10" }, ctx());
    expect(r.status).toBe("not-authorised");
  });

  test("access search: family filter with an unknown family falls back to all", async () => {
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "v", state: "ready", refreshedAt: "t" });
    mocks.readUserSnapshotMeta.mockResolvedValue(null);
    mocks.loadSchemes.mockResolvedValue([{ id: "1", name: "Thing" }]);
    mocks.loadSchemeHolders.mockResolvedValue([]);
    mocks.loadSchemeProjects.mockResolvedValue([]);
    mocks.loadSchemeLevels.mockResolvedValue([]);
    const r = await rovoAccessSearch({ query: "thing", family: "nonsense" }, ctx());
    expect(Object.keys(r.schemes).sort()).toEqual(["notifications", "permissions", "roles", "security"]);
  });
});

describe("rovo agents: more edge branches", () => {
  const ctx = () => ctxWithAccount();

  test("workflow inspect: scheme branch with no scheme-status rows yields a null-ish balance and empty statuses", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v", state: "ready", refreshedAt: "t" });
    mocks.loadWorkflowSchemes.mockResolvedValue([{ schemeId: "s1", name: "Lonely Scheme", description: "" }]);
    mocks.loadStatusesCatalog.mockResolvedValue([{ statusId: "1", name: "To Do", statusCategory: "To Do" }]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map());
    mocks.loadStatusHistoryCounts.mockResolvedValue({ counts: new Map(), measuredAt: null });
    mocks.loadWorkflowSchemeProjects.mockResolvedValue([]);
    const r = await rovoWorkflowInspect({ identifier: "Lonely Scheme" }, ctx());
    expect(r.kind).toBe("scheme");
    expect(r.statuses).toEqual([]);
    expect(r.projectCount).toBe(0);
  });

  test("workflow impact: verdict is 'unknown' when issue counts were never measured", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v", state: "ready", refreshedAt: "t" });
    mocks.loadWorkflowSchemes.mockResolvedValue([{ schemeId: "s1", name: "S" }]);
    mocks.loadStatusesCatalog.mockResolvedValue([{ statusId: "9", name: "Limbo", statusCategory: "In Progress" }]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map());
    mocks.loadStatusHistoryCounts.mockResolvedValue({ counts: new Map(), measuredAt: null });
    mocks.loadStatusAutomationReferences.mockResolvedValue(null);
    const r = await rovoWorkflowImpact({ name: "Limbo" }, ctx());
    expect(r.verdict).toBe("unknown");
  });

  test("issue type inspect: an unknown identifier is not-found", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ version: "v", state: "ready", refreshedAt: "t" });
    mocks.loadIssueTypes.mockResolvedValue([{ id: "1", name: "Bug", hierarchyLevel: 0 }]);
    mocks.loadIssueTypeSchemes.mockResolvedValue([]);
    mocks.loadIssueTypeSchemeItems.mockResolvedValue([]);
    mocks.loadIssueTypeSchemeProjects.mockResolvedValue([]);
    const r = await rovoIssueTypeInspect({ identifier: "Nope" }, ctx());
    expect(r.status).toBe("not-found");
  });

  test("access impact: matches on accountId, not just display name", async () => {
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "v", state: "ready", refreshedAt: "t" });
    // A people snapshot that does not list acc-99, so the holder is off the roster.
    mocks.readUserSnapshotMeta.mockResolvedValue({ version: "u1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "acc-1", active: true }]);
    mocks.loadSchemes.mockImplementation(async (_k, _v, f) => f === "permission" ? [{ id: "p1", name: "PS" }] : []);
    // The stored row shape: the account is holderValue, the grant is context/contextLabel.
    mocks.loadSchemeHolders.mockImplementation(async (_k, _v, f) => f === "permission"
      ? [{ schemeId: "p1", context: "ADMINISTER_PROJECTS", contextLabel: "Administer Projects", holderType: "user", holderValue: "acc-99", holderLabel: "Someone" }]
      : []);
    mocks.loadSchemeProjects.mockResolvedValue([]);
    mocks.loadSchemeLevels.mockResolvedValue([]);
    const r = await rovoAccessImpact({ name: "acc-99" }, ctx());
    expect(r.verdict).toBe("named-in-schemes");
    expect(r.namedIn[0].offRoster).toBe(true);
  });

  test("screen inspect: neither a scheme nor a screen match is not-found", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ state: "ready", version: "v", refreshedAt: "t" });
    mocks.loadScreensPage.mockResolvedValue({ total: 0, rows: [] });
    mocks.loadScreenSchemes.mockResolvedValue([]);
    mocks.loadScreenSchemeOperations.mockResolvedValue([]);
    mocks.loadIssueTypeScreenSchemes.mockResolvedValue([]);
    const r = await rovoScreenInspect({ identifier: "Ghost Screen" }, ctx());
    expect(r.status).toBe("not-found");
  });

  test("change search: pillar and kind filters are forwarded to the loader", async () => {
    mocks.readDriftSnapshotMeta.mockResolvedValue({ state: "ready", version: "d", refreshedAt: "t", totalChanges: 1 });
    mocks.loadConfigChanges.mockResolvedValue([
      { detectedAt: "2026-09-01", pillar: "access", entityType: "scheme", label: "PS", changeKind: "modified", summary: "x" },
    ]);
    const r = await rovoChangeSearch({ pillar: "access", kind: "modified" }, ctx());
    expect(r.pillar).toBe("access");
    expect(r.kind).toBe("modified");
    expect(mocks.loadConfigChanges).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ pillar: "access", kind: "modified" }));
  });

  test("project inspect: resolves a projectKey from the browsable set and returns the overview shape", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "fv", state: "ready" });
    mocks.listSnapshotProjects.mockResolvedValue([{ projectId: "10", projectKey: "ABC", projectName: "Alpha" }]);
    mocks.getBrowsableProjectIds.mockImplementation(async (_a, ids) => new Set((ids || []).map(String)));
    mocks.readWorkflowSnapshotMeta.mockResolvedValue(null);
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);
    mocks.readFilterSnapshotMeta?.mockResolvedValue?.(null);
    const r = await rovoProjectInspect({ projectKey: "abc" }, ctx());
    expect(["ok", "not-authorised"]).toContain(r.status);
  });

  test("asset search: kind=schema and kind=type each suppress the other list", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "ready", version: "a", assetsEnabled: true, refreshedAt: "t" });
    mocks.loadAssetSchemas.mockResolvedValue([{ id: "1", name: "Infra Schema" }]);
    mocks.loadAssetObjectTypes.mockResolvedValue([{ id: "9", objectSchemaId: "1", name: "Infra Node" }]);
    mocks.loadAssetAttributes.mockResolvedValue([]);
    expect((await rovoAssetSearch({ query: "infra", kind: "schema" }, ctx())).objectTypes).toEqual([]);
    expect((await rovoAssetSearch({ query: "infra", kind: "type" }, ctx())).schemas).toEqual([]);
  });

  test("estate search: kind filters", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValue({ state: "ready", version: "e", refreshedAt: "t" });
    mocks.loadEstateValues.mockImplementation(async (_k, _v, kind) =>
      kind === "resolution" ? [{ id: "1", name: "Done" }] : [{ id: "1", name: "Done" }]);
    expect((await rovoEstateSearch({ query: "done", kind: "resolution" }, ctx())).priorities).toEqual([]);
    expect((await rovoEstateSearch({ query: "done", kind: "priority" }, ctx())).resolutions).toEqual([]);
  });
});

// The screen x field cross. Costs no new Jira call -- both halves are already on disk --
// and produces the two findings no single pillar can. What matters here is that it never
// claims more than the two snapshots can support, and that it cannot take the health stage
// down with it.
describe("the screen cross-signal", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x", accountId: "acc-1" } };

  const ready = () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1", refreshedAt: "2026-09-11T09:00:00.000Z" });
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1", refreshedAt: "2026-09-10T09:00:00.000Z" });
    mocks.loadProjectScreenCoverage.mockResolvedValue([{ projectId: "10", screenCount: 3, unresolvedScreens: 0 }]);
    mocks.loadFieldReachabilityByProject.mockResolvedValue([
      { projectId: "10", fieldId: "cf_1", onCreate: true, onEdit: true, onView: true },
    ]);
    mocks.loadPopulatedProjectUsage.mockResolvedValue({
      truncated: false, limit: 20000,
      rows: [{ fieldId: "cf_2", projectId: "10", projectKey: "OPS", projectName: "Ops", issueCount: 480 }],
    });
    mocks.loadSnapshotFields.mockResolvedValue([
      { id: "cf_1", name: "Story Points" }, { id: "cf_2", name: "Vendor Ref" },
    ]);
    // Reset per test: clearAllMocks keeps implementations, and one test sets its own.
    mocks.loadPopulatedFieldProjectPairs.mockResolvedValue({ pairs: new Set(["10|cf_2"]), complete: true });
  };

  describe("getScreenFieldCrossSignal", () => {
    test("crosses the two snapshots and dates each half separately", async () => {
      ready();
      const result = await getScreenFieldCrossSignal({ payload: {}, ...ctx });

      expect(result.available).toBe(true);
      expect(result.counts.invisibleFields).toBe(1);
      expect(result.invisibleData[0]).toMatchObject({ fieldId: "cf_2", fieldName: "Vendor Ref", totalIssues: 480 });
      // Both halves refresh independently; a verdict blending them is only as current as
      // the older one, so the reader gets both dates rather than one.
      expect(result.screenRefreshedAt).toBe("2026-09-11T09:00:00.000Z");
      expect(result.fieldRefreshedAt).toBe("2026-09-10T09:00:00.000Z");
    });

    test("names which half is missing rather than returning an empty cross", async () => {
      mocks.readScreenSnapshotMeta.mockResolvedValue(null);
      mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
      const noScreens = await getScreenFieldCrossSignal({ payload: {}, ...ctx });
      expect(noScreens.available).toBe(false);
      expect(noScreens.reason).toMatch(/no screen inventory/i);

      mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1" });
      mocks.readSnapshotMeta.mockResolvedValue(null);
      const noFields = await getScreenFieldCrossSignal({ payload: {}, ...ctx });
      expect(noFields.available).toBe(false);
      expect(noFields.reason).toMatch(/no field snapshot/i);
    });

    test("honours a near-zero clutter threshold from the caller", async () => {
      ready();
      // cf_1 holds 3 issues in project 10: populated above a floor of 0, not above 10.
      mocks.loadPopulatedFieldProjectPairs.mockImplementation(async (_key, _version, { minIssues = 0 } = {}) => ({
        pairs: new Set(minIssues < 3 ? ["10|cf_1", "10|cf_2"] : ["10|cf_2"]), complete: true,
      }));

      const strict = await getScreenFieldCrossSignal({ payload: {}, ...ctx });
      const lenient = await getScreenFieldCrossSignal({ payload: { clutterMaxIssues: 10 }, ...ctx });

      expect(strict.counts.clutterPlacements).toBe(0);
      expect(lenient.counts.clutterPlacements).toBe(1);
    });
  });

  describe("getScreenFieldCrossSignal — never filled means measured", () => {
    // Summary is never tallied by the issue crawl, so it has no usage row anywhere. It was
    // listed as "on 135 create screens, never filled".
    test("does not flag a field the crawl never measures", async () => {
      ready();
      mocks.loadFieldReachabilityByProject.mockResolvedValue([
        { projectId: "10", fieldId: "summary", onCreate: true, onEdit: true, onView: true },
      ]);
      mocks.loadSnapshotFields.mockResolvedValue([{ id: "summary", name: "Summary" }, { id: "cf_2", name: "Vendor Ref" }]);

      const result = await getScreenFieldCrossSignal({ payload: {}, ...ctx });
      expect(result.formClutter).toEqual([]);
    });

    test("reads filled pairs from the complete read, not the capped usage rows", async () => {
      ready();
      mocks.loadPopulatedFieldProjectPairs.mockResolvedValueOnce({ pairs: new Set(["10|cf_1", "10|cf_2"]), complete: true });

      const result = await getScreenFieldCrossSignal({ payload: {}, ...ctx });
      expect(result.counts.clutterPlacements).toBe(0);
    });

    test("withholds clutter when the complete read fails", async () => {
      ready();
      mocks.loadPopulatedFieldProjectPairs.mockRejectedValueOnce(new Error("SQL timeout"));

      const result = await getScreenFieldCrossSignal({ payload: {}, ...ctx });
      expect(result.clutterAvailable).toBe(false);
      expect(result.formClutter).toEqual([]);
      // Invisible data does not depend on it.
      expect(result.counts.invisibleFields).toBe(1);
    });
  });

  describe("computeAndStoreScreenCross", () => {
    test("persists the counts with both source versions", async () => {
      ready();
      const result = await computeAndStoreScreenCross("inst");

      expect(result.available).toBe(true);
      expect(mocks.writeScreenCrossSummary).toHaveBeenCalledWith("inst", expect.objectContaining({
        // Both versions, because the summary is only current while both still hold.
        screenVersion: "s1",
        fieldVersion: "f1",
      }));
    });

    test("stores nothing when the cross could not be computed", async () => {
      ready();
      // Nothing resolved -> the summary is suppressed, and storing a suppressed result would
      // make the Overview show zeros that mean "we did not look".
      mocks.loadProjectScreenCoverage.mockResolvedValue([{ projectId: "10", screenCount: 3, unresolvedScreens: 3 }]);

      const result = await computeAndStoreScreenCross("inst");

      expect(result.available).toBe(false);
      expect(mocks.writeScreenCrossSummary).not.toHaveBeenCalled();
    });

    test("returns null rather than throwing when a half is missing", async () => {
      mocks.readScreenSnapshotMeta.mockResolvedValue(null);
      mocks.readSnapshotMeta.mockResolvedValue(null);
      expect(await computeAndStoreScreenCross("inst")).toBeNull();
    });

    // This runs inside the health stage of every scan. A throw here would fail the stage and
    // cost the whole score, to save two dimensions that are excluded from the mean anyway.
    test("swallows a query failure instead of taking the health stage down", async () => {
      ready();
      mocks.loadFieldReachabilityByProject.mockRejectedValueOnce(new Error("SQL exploded"));
      expect(await computeAndStoreScreenCross("inst")).toBeNull();
    });

    test("a failed summary write still returns the computed cross", async () => {
      ready();
      mocks.writeScreenCrossSummary.mockRejectedValueOnce(new Error("write failed"));
      const result = await computeAndStoreScreenCross("inst");
      expect(result.available).toBe(true);
    });
  });
});

// Per-type issue counts, and the tri-state that makes them safe to read. Zero is what makes
// a type look safe to delete, so it is only ever asserted when a crawl actually completed.
describe("getIssueTypeInventory — usage measurement", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x", accountId: "acc-1" } };

  const ready = () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({
      state: "ready", version: "t1", totalTypes: 2, totalSchemes: 1, refreshedAt: "2026-09-11T00:00:00.000Z",
    });
    mocks.loadIssueTypes.mockResolvedValue([
      { id: "10001", name: "Bug", hierarchyLevel: 0 },
      { id: "10002", name: "Legacy", hierarchyLevel: 0 },
    ]);
    mocks.loadIssueTypeSchemes.mockResolvedValue([]);
    mocks.loadIssueTypeSchemeItems.mockResolvedValue([]);
    mocks.loadIssueTypeSchemeProjects.mockResolvedValue([]);
    mocks.loadIssueTypeGovernanceSummary.mockResolvedValue({});
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);
  };

  test("attaches real counts once a crawl has completed", async () => {
    ready();
    mocks.readIssueScanMeta.mockResolvedValue({ state: "ready", completedAt: "2026-09-10T00:00:00.000Z" });
    mocks.loadIssueTypeTotals.mockResolvedValue([{ issueTypeId: "10001", issueTypeName: "Bug", issueCount: 4820, projectCount: 12 }]);

    const result = await getIssueTypeInventory({ payload: {}, ...ctx });

    expect(result.usage.measurement).toBe("measured");
    expect(result.issueTypes.find((t) => t.id === "10001")).toMatchObject({ issueCount: 4820, usedInProjects: 12 });
    // The other half of the claim: a completed crawl that found none is a REAL zero.
    expect(result.issueTypes.find((t) => t.id === "10002").issueCount).toBe(0);
  });

  test("reports not-measured rather than zero when no crawl has run", async () => {
    ready();
    mocks.readIssueScanMeta.mockResolvedValue(null);
    mocks.loadIssueTypeTotals.mockResolvedValue([]);

    const result = await getIssueTypeInventory({ payload: {}, ...ctx });

    expect(result.usage.measurement).toBe("not-measured");
    // Null, not 0. A zero here is the premise of a deletion nobody has evidence for.
    for (const t of result.issueTypes) expect(t.issueCount).toBeNull();
  });

  test("calls a half-finished crawl partial, so a missing type reads as not-reached", async () => {
    ready();
    mocks.readIssueScanMeta.mockResolvedValue({ state: "building" });
    mocks.loadIssueTypeTotals.mockResolvedValue([{ issueTypeId: "10001", issueTypeName: "Bug", issueCount: 40, projectCount: 1 }]);

    const result = await getIssueTypeInventory({ payload: {}, ...ctx });

    expect(result.usage.measurement).toBe("partial");
    expect(result.issueTypes.find((t) => t.id === "10001").issueCount).toBe(40);
    // Not counted yet is not counted as none.
    expect(result.issueTypes.find((t) => t.id === "10002").issueCount).toBeNull();
  });

  test("a failed count is reported as failed, not as zero", async () => {
    ready();
    mocks.readIssueScanMeta.mockResolvedValue({ state: "ready" });
    mocks.loadIssueTypeTotals.mockRejectedValueOnce(new Error("SQL exploded"));

    const result = await getIssueTypeInventory({ payload: {}, ...ctx });

    expect(result.usage.measurement).toBe("measurement-failed");
    for (const t of result.issueTypes) expect(t.issueCount).toBeNull();
  });

  test("carries the counts onto the hierarchy view as well as the flat catalogue", async () => {
    ready();
    mocks.readIssueScanMeta.mockResolvedValue({ state: "ready" });
    mocks.loadIssueTypeTotals.mockResolvedValue([{ issueTypeId: "10001", issueTypeName: "Bug", issueCount: 7, projectCount: 1 }]);

    const result = await getIssueTypeInventory({ payload: {}, ...ctx });

    const level = result.hierarchy.find((h) => h.level === 0);
    expect(level.types.find((t) => t.id === "10001").issueCount).toBe(7);
  });
});

// The Deletion Safety report: the product's thesis as one answer. Its own success metric is
// "whether a recommended deletion was ever wrong", so what is pinned here is mostly what it
// refuses to claim when a pillar is missing.
describe("getDeletionSafety", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x", accountId: "acc-1" } };

  const everything = () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1", refreshedAt: "2026-09-11T00:00:00.000Z" });
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1", unresolvedScreens: 0 });
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "fi1" });
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "d1" });
    mocks.loadSnapshotFields.mockResolvedValue([
      { id: "customfield_1", name: "Vendor Ref", totalIssueCount: 0, activeProjectCount: 0 },
    ]);
    mocks.loadScreensForField.mockResolvedValue([]);
    mocks.loadFilterReferencesFor.mockResolvedValue([]);
    mocks.loadRqtFieldIndex.mockResolvedValue([]);
    mocks.loadFieldReachabilityByProject.mockResolvedValue([]);
    mocks.loadProjectScreenCoverage.mockResolvedValue([]);
    mocks.loadPopulatedProjectUsage.mockResolvedValue({ rows: [], truncated: false, limit: 20000 });
    mocks.readAutomationAnalysis.mockResolvedValue({ schemaVersion: 1, refreshedAt: Date.now() - 86400000 });
    mocks.readAutomationPart.mockImplementation((_k, part) =>
      Promise.resolve(part === "fields" ? { total: 0, entries: [] } : null));
  };

  test("refuses to answer without a field snapshot", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    const result = await getDeletionSafety({ payload: { fieldIds: ["customfield_1"] }, ...ctx });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/no field snapshot/i);
  });

  test("refuses an empty request rather than reporting a clean estate", async () => {
    everything();
    const result = await getDeletionSafety({ payload: { fieldIds: [] }, ...ctx });
    expect(result.available).toBe(false);
    expect(result.total).toBe(0);
  });

  test("returns a no-evidence verdict when every pillar was consulted and clean", async () => {
    everything();
    const result = await getDeletionSafety({ payload: { fieldIds: ["customfield_1"] }, ...ctx });

    expect(result.available).toBe(true);
    expect(result.fields[0].verdict).toBe("no-evidence-of-use");
    // Never the phrase somebody would act on without reading the rest.
    expect(JSON.stringify(result)).not.toMatch(/safe to delete/i);
  });

  test("blocks on a rule that writes the field", async () => {
    everything();
    mocks.readAutomationPart.mockImplementation((_k, part) =>
      Promise.resolve(part === "fields"
        ? { total: 1, entries: [{ label: "Vendor Ref", writeCount: 2, readCount: 0, triggerCount: 0 }] }
        : null));

    const result = await getDeletionSafety({ payload: { fieldIds: ["customfield_1"] }, ...ctx });

    expect(result.fields[0].verdict).toBe("in-use");
    expect(result.fields[0].blockers[0].source).toBe("automation");
  });

  test("degrades to unknown when a pillar has never been built", async () => {
    everything();
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);

    const result = await getDeletionSafety({ payload: { fieldIds: ["customfield_1"] }, ...ctx });

    expect(result.fields[0].verdict).toBe("unknown");
    expect(result.fields[0].gaps.some((g) => g.source === "screens")).toBe(true);
  });

  test("names the fields it would not assess rather than silently dropping them", async () => {
    everything();
    const many = Array.from({ length: 80 }, (_, i) => `customfield_${i}`);

    const result = await getDeletionSafety({ payload: { fieldIds: many }, ...ctx });

    expect(result.total).toBe(50);
    expect(result.skipped).toBe(30);
  });

  test("dates every pillar it drew on, because they refresh independently", async () => {
    everything();
    const result = await getDeletionSafety({ payload: { fieldIds: ["customfield_1"] }, ...ctx });
    expect(result.freshness).toHaveProperty("fields");
    expect(result.freshness).toHaveProperty("automation");
  });
});

// The evidence-gathering legs of the deletion report, each of which can be absent on a real
// site. Covered separately because each one degrades the verdict differently.
describe("getDeletionSafety — gathering evidence", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x", accountId: "acc-1" } };

  const base = () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1", refreshedAt: "2026-09-11T00:00:00.000Z" });
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1", unresolvedScreens: 0 });
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "fi1" });
    mocks.readDashboardSnapshotMeta.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([
      { id: "customfield_1", name: "Vendor Ref", totalIssueCount: 0, activeProjectCount: 0 },
    ]);
    mocks.loadScreensForField.mockResolvedValue([]);
    mocks.loadFilterReferencesFor.mockResolvedValue([]);
    mocks.loadRqtFieldIndex.mockResolvedValue([]);
    mocks.loadFieldReachabilityByProject.mockResolvedValue([]);
    mocks.loadProjectScreenCoverage.mockResolvedValue([]);
    mocks.loadPopulatedProjectUsage.mockResolvedValue({ rows: [], truncated: false, limit: 20000 });
    mocks.readAutomationAnalysis.mockResolvedValue({ schemaVersion: 1, refreshedAt: Date.now() - 86400000 });
    mocks.readAutomationPart.mockImplementation((_k, part) =>
      Promise.resolve(part === "fields" ? { total: 0, entries: [] } : null));
  };

  const first = async () => (await getDeletionSafety({ payload: { fieldIds: ["customfield_1"] }, ...ctx })).fields[0];

  test("blocks on the values the field already holds", async () => {
    base();
    mocks.loadSnapshotFields.mockResolvedValue([
      { id: "customfield_1", name: "Vendor Ref", totalIssueCount: 4820, activeProjectCount: 9 },
    ]);
    const f = await first();
    expect(f.verdict).toBe("in-use");
    expect(f.blockers.some((b) => b.source === "usage")).toBe(true);
  });

  test("blocks on a filter whose JQL names the field", async () => {
    base();
    mocks.loadFilterReferencesFor.mockResolvedValue([{ id: "1", name: "Open bugs" }]);
    const f = await first();
    expect(f.blockers.find((b) => b.source === "filters").summary).toMatch(/Open bugs/);
  });

  test("blocks on requirement tokens, which break traceability rather than data", async () => {
    base();
    mocks.loadRqtFieldIndex.mockResolvedValue([{ fieldId: "customfield_1", issueCount: 91 }]);
    const f = await first();
    expect(f.blockers.find((b) => b.source === "rqt").detail).toMatch(/breaks the trace/i);
  });

  test("carries the invisible-data blocker through from the screen cross", async () => {
    base();
    // Populated in a project whose screens do not show it: the blocker most likely to be the
    // reason a deletion breaks something.
    mocks.loadProjectScreenCoverage.mockResolvedValue([{ projectId: "10", screenCount: 2, unresolvedScreens: 0 }]);
    mocks.loadFieldReachabilityByProject.mockResolvedValue([
      { projectId: "10", fieldId: "customfield_9", onCreate: true, onEdit: false, onView: true },
    ]);
    mocks.loadPopulatedProjectUsage.mockResolvedValue({
      truncated: false, limit: 20000,
      rows: [{ fieldId: "customfield_1", projectId: "10", projectKey: "OPS", issueCount: 480 }],
    });

    const f = await first();
    expect(f.blockers.some((b) => b.source === "invisible-data")).toBe(true);
  });

  test("a dashboard inventory that was never built becomes a gap, not a pass", async () => {
    base();
    const f = await first();
    expect(f.gaps.some((g) => g.source === "dashboards")).toBe(true);
    expect(f.verdict).toBe("unknown");
  });

  test("assesses a field the catalogue does not contain rather than skipping it", async () => {
    base();
    const result = await getDeletionSafety({ payload: { fieldIds: ["customfield_missing"] }, ...ctx });
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].fieldId).toBe("customfield_missing");
  });
});

// Every pillar read here is best-effort. A field snapshot exists, so the question can be
// asked -- and one storage failure must narrow the answer rather than refuse it, because a
// report that throws when the filter table is unreachable is a report nobody can use on the
// day they most need it.
describe("getDeletionSafety — one pillar failing never takes the verdict down", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x", accountId: "acc-1" } };

  const base = () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1", unresolvedScreens: 0 });
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "fi1" });
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "d1" });
    mocks.loadSnapshotFields.mockResolvedValue([{ id: "customfield_1", name: "Vendor Ref", totalIssueCount: 0 }]);
    mocks.loadScreensForField.mockResolvedValue([]);
    mocks.loadFilterReferencesFor.mockResolvedValue([]);
    mocks.loadRqtFieldIndex.mockResolvedValue([]);
    mocks.loadFieldReachabilityByProject.mockResolvedValue([]);
    mocks.loadProjectScreenCoverage.mockResolvedValue([]);
    mocks.loadPopulatedProjectUsage.mockResolvedValue({ rows: [], truncated: false, limit: 20000 });
    mocks.readAutomationAnalysis.mockResolvedValue({ schemaVersion: 1, refreshedAt: Date.now() - 86400000 });
    mocks.readAutomationPart.mockImplementation((_k, part) =>
      Promise.resolve(part === "fields" ? { total: 0, entries: [] } : null));
    mocks.loadDashboardsForFilterIds?.mockResolvedValue?.([]);
  };

  const verdictFor = async () => (await getDeletionSafety({ payload: { fieldIds: ["customfield_1"] }, ...ctx })).fields[0];

  test.each([
    ["screens", () => mocks.loadScreensForField.mockRejectedValueOnce(new Error("boom")), "screens"],
    ["filters", () => mocks.loadFilterReferencesFor.mockRejectedValueOnce(new Error("boom")), "filters"],
    ["the field catalogue", () => mocks.loadSnapshotFields.mockRejectedValueOnce(new Error("boom")), "field catalogue"],
  ])("a %s read failure degrades the verdict instead of throwing", async (_label, breakIt, gapSource) => {
    base();
    breakIt();

    const field = await verdictFor();

    expect(field.verdict).toBe("unknown");
    if (gapSource) expect(field.gaps.some((g) => g.source === gapSource)).toBe(true);
  });

  test("a screen-cross failure costs the invisible-data blocker, not the report", async () => {
    base();
    mocks.loadProjectScreenCoverage.mockRejectedValueOnce(new Error("boom"));

    const result = await getDeletionSafety({ payload: { fieldIds: ["customfield_1"] }, ...ctx });

    expect(result.available).toBe(true);
    expect(result.fields[0].blockers.some((b) => b.source === "invisible-data")).toBe(false);
  });

  test("counts dashboards when the chain resolves them", async () => {
    base();
    // field -> filters naming it -> gadgets on those filters -> dashboards. Every leg an
    // exact join, which is what makes the count safe to act on.
    mocks.loadFilterReferencesFor.mockResolvedValue([{ id: "500", name: "Open bugs" }]);

    const field = await verdictFor();

    expect(field.blockers.some((b) => b.source === "filters")).toBe(true);
  });
});

// The three pillars the Confluence macro gained, and the rule every one of them answers to:
// a viewer sees their own estate, never the site's. This panel can be opened by anyone in
// Confluence, so the scoping is the security boundary, not a nicety.
describe("the macro's viewer-scoped pillars", () => {
  const ctx = (accountId = "viewer-1") => ({ context: { installContext: "ari:cloud:jira::site/x", accountId } });

  // Two projects exist. The viewer can browse exactly one of them.
  const twoProjectsOneBrowsable = () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "10", projectKey: "MINE", projectName: "Mine" },
      { projectId: "20", projectKey: "THEIRS", projectName: "Theirs" },
    ]);
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["10"]));
  };

  describe("getMacroScreens", () => {
    beforeEach(() => {
      twoProjectsOneBrowsable();
      mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1", refreshedAt: "2026-09-12T00:00:00.000Z" });
      mocks.loadScreensForProjects.mockResolvedValue([
        { projectId: "10", screenId: "100", name: "Create", fieldCount: 34, tabCount: 2, tabsResolved: "resolved", onCreate: true, onEdit: false, onView: true },
        { projectId: "10", screenId: "200", name: "Edit", fieldCount: 12, tabCount: 1, tabsResolved: "resolved", onCreate: false, onEdit: true, onView: false },
        // A row for a project the viewer cannot browse. The query is asked only for browsable
        // ids, but the fold must not trust that -- one day somebody widens the query.
        { projectId: "20", screenId: "300", name: "Secret", fieldCount: 9, tabCount: 1, tabsResolved: "resolved", onCreate: true, onEdit: false, onView: false },
      ]);
    });

    test("shows only the projects the viewer can browse", async () => {
      const result = await getMacroScreens(ctx());

      expect(result.available).toBe(true);
      expect(result.projects.map((p) => p.projectKey)).toEqual(["MINE"]);
      expect(JSON.stringify(result)).not.toMatch(/THEIRS|Secret/);
    });

    test("leads with the number people actually argue about -- the create form's length", async () => {
      const result = await getMacroScreens(ctx());
      // Not the total across every screen: the longest CREATE screen, which is the form
      // nobody filing an issue can skip.
      expect(result.projects[0].createFieldCount).toBe(34);
    });

    test("never reports a screen it could not read as having no fields", async () => {
      mocks.loadScreensForProjects.mockResolvedValue([
        { projectId: "10", screenId: "100", name: "Create", fieldCount: 0, tabCount: 0, tabsResolved: "failed", onCreate: true, onEdit: false, onView: false },
      ]);

      const result = await getMacroScreens(ctx());

      // The viewer is the person about to ask why their form looks different from this page.
      expect(result.projects[0].screens[0].unreadable).toBe(true);
    });

    test("says the inventory is missing rather than returning an empty estate", async () => {
      mocks.readScreenSnapshotMeta.mockResolvedValue(null);
      const result = await getMacroScreens(ctx());
      expect(result).toMatchObject({ available: false, reason: "no-inventory" });
    });
  });

  describe("getMacroIssueTypes", () => {
    beforeEach(() => {
      twoProjectsOneBrowsable();
      mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ version: "t1", refreshedAt: "2026-09-12T00:00:00.000Z" });
      mocks.loadIssueTypes.mockResolvedValue([
        { id: "1", name: "Bug", subtask: false },
        { id: "2", name: "Sub-task", subtask: true },
      ]);
      mocks.loadIssueTypeSchemeItems.mockResolvedValue([
        { schemeId: "S1", issueTypeId: "1" },
        { schemeId: "S1", issueTypeId: "2" },
        // A member the catalogue no longer holds -- a finding, not noise.
        { schemeId: "S1", issueTypeId: "999" },
      ]);
      mocks.loadIssueTypeSchemes.mockResolvedValue([{ schemeId: "S1", name: "Default scheme" }]);
      mocks.loadIssueTypeSchemeProjects.mockResolvedValue([
        { schemeId: "S1", projectId: "10", projectKey: "MINE" },
        { schemeId: "S1", projectId: "20", projectKey: "THEIRS" },
      ]);
    });

    test("groups by scheme and names it, rather than showing an id", async () => {
      const result = await getMacroIssueTypes(ctx());
      expect(result.schemes[0]).toMatchObject({ name: "Default scheme" });
    });

    test("lists only the browsable projects inside a shared scheme", async () => {
      // The scheme is shared with a project this viewer cannot see. The scheme still shows --
      // it governs one of theirs -- but the other project's key must not leak with it.
      const result = await getMacroIssueTypes(ctx());
      expect(result.schemes[0].projects).toEqual(["MINE"]);
    });

    test("keeps a member type the catalogue has lost, marked missing", async () => {
      const result = await getMacroIssueTypes(ctx());
      const missing = result.schemes[0].issueTypes.find((t) => t.id === "999");
      expect(missing).toMatchObject({ missing: true, name: null });
    });
  });

  describe("getMacroBoards", () => {
    beforeEach(() => {
      twoProjectsOneBrowsable();
      mocks.readBoardSnapshotMeta.mockResolvedValue({ version: "b1", refreshedAt: "2026-09-12T00:00:00.000Z" });
      mocks.loadBoards.mockResolvedValue([
        { boardId: "1", name: "My board", type: "scrum", locationType: "project", locationId: "10", locationKey: "MINE", columnCount: 4, configReadable: true },
        { boardId: "2", name: "Their board", type: "kanban", locationType: "project", locationId: "20", locationKey: "THEIRS", columnCount: 3, configReadable: true },
        { boardId: "3", name: "Team-managed", type: "kanban", locationType: "project", locationId: "10", locationKey: "MINE", columnCount: 0, configReadable: false },
      ]);
    });

    test("shows only boards living in a project the viewer can browse", async () => {
      const result = await getMacroBoards(ctx());
      expect(result.boards.map((b) => b.name).sort()).toEqual(["My board", "Team-managed"]);
    });

    test("lists a board whose configuration could not be read rather than dropping it", async () => {
      // Team-managed boards routinely refuse that endpoint. Dropping them would read as
      // "you have no board here" to somebody looking straight at one.
      const result = await getMacroBoards(ctx());
      expect(result.boards.find((b) => b.name === "Team-managed").configReadable).toBe(false);
    });
  });

  test("every macro pillar is reachable WITHOUT Jira admin", async () => {
    // The whole point of the macro: a business user gets answers without being made an admin.
    // If one of these ever moves into the admin registry, this fails rather than the feature
    // silently disappearing for every non-admin who opens the page.
    for (const name of ["getMacroScreens", "getMacroIssueTypes", "getMacroBoards",
                        "getMacroFilters", "getMacroDashboards", "getMacroWorkflows"]) {
      expect(SHARED_RESOLVER_FUNCTIONS, name).toHaveProperty(name);
      expect(__RAW_ADMIN_ONLY_FUNCTIONS).not.toHaveProperty(name);
    }
  });

  test("the pillars that would leak stay out of the macro", async () => {
    // Access schemes and the people roster are a disclosure risk on a page anyone in
    // Confluence can open; automation findings include plaintext-credential hits. None of
    // them belongs on a wiki page, and this is the assertion that keeps it that way.
    for (const name of ["getAccessInventory", "getPeopleInventory", "getAutomationInsights",
                        "getDeletionSafety", "getScreenFieldCrossSignal"]) {
      expect(SHARED_RESOLVER_FUNCTIONS).not.toHaveProperty(name);
    }
  });
});

// ---------------------------------------------------------------------------
// First run
//
// The rule under test is the one the panel is built on: every step the estate can answer
// for itself IS answered from the estate, on every read. Only the two that describe a
// person having read something are stored. A test that let a stored flag tick "the first
// scan has run" would let the panel congratulate an admin on a scan that never happened,
// which is the exact failure the derivation exists to prevent.
// ---------------------------------------------------------------------------
describe("first run", () => {
  const stepFor = (state, key) => state.steps.find((step) => step.key === key);

  // The field snapshot has no default in the global beforeEach -- the groups that need it
  // set it themselves. A first run reads it on every call, so the "nothing has been scanned
  // yet" answer is stated here rather than left to an undefined mock.
  beforeEach(() => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readFullScanMeta.mockResolvedValue(null);
  });

  test("a brand-new site has every step outstanding and no arrivals list", async () => {
    const state = await getFirstRunState({ context: { accountId: "a" } });

    expect(state.show).toBe(true);
    expect(state.remaining).toBe(5);
    expect(state.steps.every((step) => step.done === false)).toBe(true);
    // Nothing has been read, so there is nothing to arrive. An arrivals panel listing
    // fifteen pending stages on a site that has never scanned is a wall of "not started".
    expect(state.arrivals.available).toBe(false);
  });

  test("the scan step is derived from a snapshot existing, not from a scan run finishing", async () => {
    // Deliberately a CANCELLED run that still left a workflow snapshot behind. The estate
    // has been read; the bookkeeping row says the run did not finish. The pillar on disk wins.
    mocks.readFullScanMeta.mockResolvedValue({ state: "cancelled", stages: [] });
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v3", totalSchemes: 9 });

    const state = await getFirstRunState({ context: { accountId: "a" } });

    expect(stepFor(state, "first-scan").done).toBe(true);
    expect(stepFor(state, "first-scan").cta).toBeNull();
  });

  test("automation and schedule steps read the estate, and lose their prompt once satisfied", async () => {
    mocks.readAutomationAnalysis.mockResolvedValue({ refreshedAt: Date.now(), rules: [] });
    mocks.kvsGet.mockResolvedValue({ quickScanSchedule: { enabled: true } });

    const state = await getFirstRunState({ context: { accountId: "a" } });

    expect(stepFor(state, "import-automation").done).toBe(true);
    expect(stepFor(state, "import-automation").cta).toBeNull();
    expect(stepFor(state, "scan-schedule").done).toBe(true);
    expect(state.remaining).toBe(3);
  });

  test("acknowledged steps come back ticked, and are marked acknowledged rather than measured", async () => {
    mocks.kvsGet.mockResolvedValue({ firstRun: { acknowledged: ["evidence-rule"] } });

    const state = await getFirstRunState({ context: { accountId: "a" } });

    expect(stepFor(state, "evidence-rule")).toMatchObject({ done: true, kind: "acknowledged" });
    expect(stepFor(state, "share-macro")).toMatchObject({ done: false, kind: "acknowledged" });
    // The distinction has to survive the round trip: it is what decides whether the panel
    // offers a "Got it" button at all.
    expect(stepFor(state, "first-scan").kind).toBe("derived");
  });

  test("arrivals report what landed and what is still coming, newest first", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", totalSchemes: 9 });
    mocks.readScreenSnapshotMeta.mockResolvedValue({ totalScreens: 40 });
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running",
      stages: [
        { key: "workflows", state: "done", completedAt: "2026-01-01T10:00:00.000Z" },
        { key: "screens", state: "done", completedAt: "2026-01-01T11:00:00.000Z" },
        { key: "filters", state: "failed", completedAt: "2026-01-01T11:05:00.000Z", error: "Jira said 503" },
        { key: "issues", state: "running" },
      ],
    });

    const state = await getFirstRunState({ context: { accountId: "a" } });

    expect(state.scanRunning).toBe(true);
    expect(state.arrivals.available).toBe(true);
    expect(state.arrivals.landed.map((stage) => stage.key)).toEqual(["screens", "workflows"]);
    expect(state.arrivals.landed[0]).toMatchObject({ produced: 40, countable: true });
    // A failed stage is reported in the same list rather than hidden -- the pillar did not
    // build, which is a fact an admin needs on the way past, with the reason attached.
    expect(state.arrivals.pending.find((stage) => stage.key === "filters"))
      .toMatchObject({ state: "failed", error: "Jira said 503" });
  });

  test("a stage with nothing to count is not reported as having produced nothing", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", totalSchemes: 3 });
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running",
      stages: [{ key: "health", state: "done", completedAt: "2026-01-01T12:00:00.000Z" }],
    });

    const state = await getFirstRunState({ context: { accountId: "a" } });

    // health records a score, not a count. `countable: false` is what stops the panel
    // rendering "Health - 0", which reads as a failure rather than as a stage that simply
    // does not count anything.
    expect(state.arrivals.landed.find((stage) => stage.key === "health"))
      .toMatchObject({ countable: false, produced: null });
  });

  test("a scanned site with no stage bookkeeping shows no arrivals rather than fifteen blanks", async () => {
    // A snapshot exists, but the meta row does not -- an install that scanned before stage
    // bookkeeping shipped, or one whose row was lost. Rendering the catalog anyway would put
    // fifteen "not started" rows in front of an admin whose estate HAS been read.
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1" });
    mocks.readFullScanMeta.mockResolvedValue({ state: "idle", stages: [] });

    const state = await getFirstRunState({ context: { accountId: "a" } });

    expect(state.steps).toHaveLength(5);
    expect(stepFor(state, "first-scan").done).toBe(true);
    expect(state.arrivals.available).toBe(false);
  });

  test("a failed produced-count read costs the counts, not the arrivals list", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", totalSchemes: 4 });
    mocks.readScreenSnapshotMeta.mockRejectedValue(new Error("screens meta unreadable"));
    mocks.readFullScanMeta.mockResolvedValue({
      state: "idle",
      stages: [
        { key: "workflows", state: "done", completedAt: "2026-01-01T10:00:00.000Z" },
        { key: "screens", state: "done", completedAt: "2026-01-01T11:00:00.000Z" },
      ],
    });

    const state = await getFirstRunState({ context: { accountId: "a" } });

    expect(state.arrivals.landed).toHaveLength(2);
    // Screens landed and is still reported as landed. What is unknown is how many, and that
    // is said by omitting the number rather than by printing a zero.
    expect(state.arrivals.landed.find((stage) => stage.key === "screens"))
      .toMatchObject({ countable: false, produced: null });
    expect(state.arrivals.landed.find((stage) => stage.key === "workflows"))
      .toMatchObject({ countable: true, produced: 4 });
  });

  test("every estate read failing shows the steps as outstanding, never as done", async () => {
    // The honest failure for a checklist. A read that could not answer must not be taken as
    // a yes -- a first-run panel that reports an unscanned site as scanned sends an admin
    // off to read numbers that do not exist yet.
    mocks.kvsGet.mockRejectedValueOnce(new Error("kvs down"));
    mocks.readSnapshotMeta.mockRejectedValueOnce(new Error("field meta down"));
    mocks.readFullScanMeta.mockRejectedValueOnce(new Error("scan meta down"));
    mocks.readAutomationAnalysis.mockRejectedValueOnce(new Error("automation down"));
    mocks.readWorkflowSnapshotMeta.mockRejectedValueOnce(new Error("workflow meta down"));

    const state = await getFirstRunState({ context: { accountId: "a" } });

    expect(state.remaining).toBe(5);
    expect(state.steps.every((step) => step.done === false)).toBe(true);
    expect(state.arrivals.available).toBe(false);
  });

  test("a dismissed panel stays dismissed even with steps outstanding", async () => {
    mocks.kvsGet.mockResolvedValue({ firstRun: { dismissed: true } });

    const state = await getFirstRunState({ context: { accountId: "a" } });

    expect(state.show).toBe(false);
    expect(state.remaining).toBeGreaterThan(0);
  });

  test("the panel retires itself once nothing is left", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1" });
    mocks.readAutomationAnalysis.mockResolvedValue({ rules: [] });
    mocks.kvsGet.mockResolvedValue({
      quickScanSchedule: { enabled: true },
      firstRun: { acknowledged: ["evidence-rule", "share-macro"] },
    });

    const state = await getFirstRunState({ context: { accountId: "a" } });

    expect(state.remaining).toBe(0);
    expect(state.show).toBe(false);
  });

  test("acknowledging a step writes it without disturbing the rest of the config", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true, firstRun: { acknowledged: ["evidence-rule"] } });

    const result = await setFirstRunState({ payload: { acknowledge: "share-macro" }, context: {} });

    expect(result.ok).toBe(true);
    expect(result.firstRun.acknowledged).toEqual(["evidence-rule", "share-macro"]);
    const [, written] = mocks.kvsSet.mock.calls.at(-1);
    expect(written.readOnlyMode).toBe(true);
  });

  test("acknowledging twice does not duplicate", async () => {
    mocks.kvsGet.mockResolvedValue({ firstRun: { acknowledged: ["share-macro"] } });

    const result = await setFirstRunState({ payload: { acknowledge: "share-macro" }, context: {} });

    expect(result.firstRun.acknowledged).toEqual(["share-macro"]);
  });

  test("a derived step cannot be acknowledged", async () => {
    // The load-bearing assertion. "first-scan" is answered by the estate; letting a caller
    // tick it by hand would put a tick on the page meaning "somebody clicked" while wearing
    // the appearance of "this is true".
    const result = await setFirstRunState({ payload: { acknowledge: "first-scan" }, context: {} });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/derived/);
    expect(mocks.kvsSet).not.toHaveBeenCalled();
  });

  test("dismissing is stored, and undismissing is possible", async () => {
    await setFirstRunState({ payload: { dismissed: true }, context: {} });
    expect(mocks.kvsSet.mock.calls.at(-1)[1].firstRun.dismissed).toBe(true);

    mocks.kvsGet.mockResolvedValue({ firstRun: { dismissed: true, acknowledged: [] } });
    const result = await setFirstRunState({ payload: { dismissed: false }, context: {} });

    expect(result.firstRun.dismissed).toBe(false);
  });

  test("both first-run resolvers are admin-only", async () => {
    // getFirstRunState reports scan state and config; setFirstRunState writes config.
    // Neither belongs on a page anyone in Confluence can open.
    expect(__RAW_ADMIN_ONLY_FUNCTIONS).toHaveProperty("getFirstRunState");
    expect(__RAW_ADMIN_ONLY_FUNCTIONS).toHaveProperty("setFirstRunState");
    expect(SHARED_RESOLVER_FUNCTIONS).not.toHaveProperty("getFirstRunState");
    expect(SHARED_RESOLVER_FUNCTIONS).not.toHaveProperty("setFirstRunState");
  });
});

describe("getRemediationCandidates -- access playbooks", () => {
  const ctx = { payload: {}, context: { installContext: "ari:cloud:jira::site/x", accountId: "admin-1" } };
  const run = (findingKey) => getRemediationCandidates({ ...ctx, payload: { findingKey } });

  // 30 risky permission schemes, so the "every item, not the tab's first 25" rule is tested.
  function accessFixture() {
    mocks.readAccessSnapshotMeta.mockResolvedValueOnce({ state: "ready", version: "v1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.readUserSnapshotMeta.mockResolvedValueOnce({ version: "u1" });
    mocks.loadUsers.mockResolvedValueOnce([{ accountId: "live" }]);
    const perm = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, name: `Perm ${i}`, isDefault: false }));
    const schemes = {
      permission: perm,
      security: [{ id: "s1", name: "Secret" }, { id: "s2", name: "No levels" }],
      notification: [{ id: "n1", name: "Named" }],
      "project-role": [{ id: "10002", name: "Administrators" }, { id: "10003", name: "Developers" }],
    };
    const holders = {
      permission: perm.map((sc) => ({ schemeId: sc.id, context: "BROWSE_PROJECTS", holderType: "anyone", holderValue: "" })),
      security: [],
      notification: [{ schemeId: "n1", context: "1", holderType: "user", holderValue: "someone" }],
      "project-role": [
        { schemeId: "10002", context: "1", contextLabel: "OPS", holderType: "empty", holderValue: "" },
        { schemeId: "10003", context: "1", contextLabel: "OPS", holderType: "user", holderValue: "gone-1" },
        { schemeId: "10003", context: "2", contextLabel: "DEV", holderType: "user", holderValue: "gone-2" },
        { schemeId: "10003", context: "2", contextLabel: "DEV", holderType: "user", holderValue: "live" },
      ],
    };
    for (let i = 0; i < 4; i += 1) {
      mocks.loadSchemes.mockImplementationOnce(async (_k, _v, type) => schemes[type] || []);
      mocks.loadSchemeHolders.mockImplementationOnce(async (_k, _v, type) => holders[type] || []);
    }
    // Only p0 is assigned to a project; s1 has one level with no members.
    mocks.loadSchemeProjects
      .mockResolvedValueOnce([{ schemeId: "p0", projectId: "1" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mocks.loadSchemeLevels.mockResolvedValueOnce([{ schemeId: "s1", id: "L1", name: "Staff" }]);
  }

  test("permission-risky: every flagged scheme, past the tab's 25", async () => {
    accessFixture();
    const r = await run("permission-risky");
    expect(r.items).toHaveLength(30);
    expect(r.items[0]).toMatchObject({ id: "p0", reasons: [expect.stringMatching(/anyone/)], projectCount: 1 });
  });

  test("access-unused-schemes: permission, security and notification together, tagged by type", async () => {
    accessFixture();
    const r = await run("access-unused-schemes");
    const types = new Set(r.items.map((it) => it.type));
    expect(types).toEqual(new Set(["permission", "security", "notification"]));
    expect(r.items.find((it) => it.id === "security:s2")).toMatchObject({ schemeId: "s2", name: "No levels" });
    expect(r.items.some((it) => it.schemeId === "p0")).toBe(false); // assigned
  });

  test("security-broken-levels: level-less schemes and member-less levels", async () => {
    accessFixture();
    const r = await run("security-broken-levels");
    expect(r.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "scheme:s2", kind: "no-levels" }),
      expect.objectContaining({ id: "level:s1:L1", kind: "empty-level", levelName: "Staff" }),
    ]));
  });

  test("notification-fragile: schemes naming an individual", async () => {
    accessFixture();
    expect((await run("notification-fragile")).items).toEqual([expect.objectContaining({ id: "n1", namedUserCount: 1 })]);
  });

  test("role-empty-admin: one item per project", async () => {
    accessFixture();
    expect((await run("role-empty-admin")).items).toEqual([{ id: "1", projectKey: "OPS", role: "Administrators" }]);
  });

  test("role-offroster-actors: grouped per project, not one per actor and not one for everything", async () => {
    accessFixture();
    const r = await run("role-offroster-actors");
    expect(r.items.map((g) => [g.id, g.count])).toEqual([["DEV", 1], ["OPS", 1]]);
    expect(r.items[0].members[0]).toMatchObject({ accountId: "gone-2", role: "Developers", projectKey: "DEV" });
  });

  test("an unbuilt access inventory is unavailable, not empty", async () => {
    mocks.readAccessSnapshotMeta.mockResolvedValueOnce(null);
    expect(await run("role-empty-admin")).toMatchObject({ available: false, reason: "no-snapshot" });
  });
});

describe("getRemediationCandidates -- filters, dashboards, people, issue types, priorities, Assets", () => {
  const run = (findingKey) => getRemediationCandidates({ payload: { findingKey }, context: { installContext: "ari:cloud:jira::site/x", accountId: "admin-1" } });
  const owner = (active = true) => ({ accountId: "a", displayName: "Ann", active });

  test("filters: each finding reads every filter carrying its code", async () => {
    const old = "2024-01-01T00:00:00Z";
    const filters = [
      { id: "1", name: "Zombie", owner: owner(), subscriptionCount: 3, lastUsedAt: old, shares: [] },
      { id: "2", name: "Open", owner: owner(), subscriptionCount: 0, lastUsedAt: "2026-09-01T00:00:00Z", shares: [{ type: "authenticated" }] },
    ];
    for (const key of ["filters-zombie-subscriptions", "filters-shared-everyone"]) {
      mocks.readFilterSnapshotMeta.mockResolvedValueOnce({ version: "f1" });
      mocks.loadFilters.mockResolvedValueOnce(filters);
      mocks.readSnapshotMeta.mockResolvedValueOnce(null);
      mocks.readIssueTypeSnapshotMeta.mockResolvedValueOnce(null);
    }
    expect((await run("filters-zombie-subscriptions")).items).toEqual([expect.objectContaining({ id: "1", ownerName: "Ann", subscriptionCount: 3 })]);
    expect((await run("filters-shared-everyone")).items).toEqual([expect.objectContaining({ id: "2" })]);
  });

  test("dashboards: open-edit, empty and published-unused each read their own code", async () => {
    const dashboards = [
      { id: "1", name: "Wall", owner: owner(), gadgetCount: 0, popularity: 4, shares: [], editShares: [] },
      { id: "2", name: "Anyone edits", owner: owner(), gadgetCount: 3, popularity: 2, shares: [], editShares: [{ type: "authenticated" }] },
      { id: "3", name: "Nobody wants", owner: owner(), gadgetCount: 2, popularity: 0, shares: [{ type: "authenticated" }], editShares: [] },
    ];
    for (let i = 0; i < 3; i += 1) {
      mocks.readDashboardSnapshotMeta.mockResolvedValueOnce({ version: "d1" });
      mocks.loadDashboards.mockResolvedValueOnce(dashboards);
    }
    expect((await run("dashboards-empty")).items.map((d) => d.id)).toEqual(["1"]);
    expect((await run("dashboards-open-edit")).items.map((d) => d.id)).toEqual(["2"]);
    expect((await run("dashboards-published-unused")).items.map((d) => d.id)).toEqual(["3"]);
  });

  test("people: one item per off-roster account, with the rules that name it", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValueOnce({ version: "u1" });
    mocks.loadUsers.mockResolvedValueOnce([{ accountId: "live" }]);
    mocks.readAutomationPart
      .mockResolvedValueOnce({ entries: [{ label: "gone", write: [11], read: [12] }, { label: "live", write: [13] }] })
      .mockResolvedValueOnce({ rules: [[11, "Assign triage", 1, null, 1, null], [12, "Notify", 1, null, 1, null]] });

    const r = await run("people-offroster-automation-refs");

    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ id: "gone", ruleCount: 2 });
    expect(r.items[0].rules).toEqual(expect.arrayContaining([expect.objectContaining({ id: 11, name: "Assign triage", direction: "write" })]));
  });

  test("people: unavailable, not empty, before the automation index is imported", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValueOnce({ version: "u1" });
    mocks.loadUsers.mockResolvedValueOnce([]);
    mocks.readAutomationPart.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    expect(await run("people-offroster-automation-refs")).toMatchObject({ available: false, reason: "no-automation-index" });
  });

  test("issue types: every hierarchy-flagged and every unused scheme, past the tab's 25", async () => {
    const schemes = Array.from({ length: 30 }, (_, i) => ({ schemeId: `s${i}`, name: `Scheme ${i}`, projectCount: 0, defaultIssueTypeId: "99" }));
    for (let i = 0; i < 2; i += 1) {
      mocks.readIssueTypeSnapshotMeta.mockResolvedValueOnce({ state: "ready", version: "v1" });
      mocks.loadIssueTypes.mockResolvedValueOnce([{ id: "1", name: "Story", hierarchyLevel: 0 }]);
      mocks.loadIssueTypeSchemes.mockResolvedValueOnce(schemes);
      mocks.loadIssueTypeSchemeItems.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      mocks.loadIssueTypeSchemeProjects.mockResolvedValueOnce([]);
      mocks.loadIssueTypeGovernanceSummary.mockResolvedValueOnce({});
      mocks.readScreenSnapshotMeta.mockResolvedValueOnce(null);
      mocks.readIssueScanMeta.mockResolvedValueOnce(null);
    }
    const hierarchy = await run("issue-type-hierarchy");
    expect(hierarchy.items).toHaveLength(30); // default type 99 is not in any scheme
    expect(hierarchy.items[0].flags[0]).toMatch(/default issue type/i);
    expect((await run("issue-type-unused-schemes")).items).toHaveLength(30);
  });

  test("priorities: one item per near-duplicate group", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValueOnce({ state: "ready", version: "v1" });
    mocks.loadEstateValues
      .mockResolvedValueOnce([{ id: "1", name: "Done" }])
      .mockResolvedValueOnce([{ id: "10", name: "High" }, { id: "11", name: "high" }]);
    const r = await run("estate-duplicate-priorities");
    expect(r.items).toEqual([expect.objectContaining({ names: ["High", "high"], count: 2 })]);
    expect(r.items[0].id).toBeTruthy();
  });

  test("Assets: broken references carry the schema and type name their link needs", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValueOnce({ state: "ready", version: "v1" });
    mocks.loadAssetSchemas.mockResolvedValueOnce([{ id: "s1", name: "IT", objectTypeCount: 1, objectCount: 1 }]);
    mocks.loadAssetObjectTypes.mockResolvedValueOnce([{ id: "t1", schemaId: "s1", name: "Laptop" }]);
    mocks.loadAssetAttributes.mockResolvedValueOnce([{ id: "a1", objectTypeId: "t1", schemaId: "s1", name: "Owner", referenceObjectTypeId: "gone" }]);
    mocks.loadAssetTypeCounts.mockResolvedValueOnce([]);
    mocks.readAssetTypeCountMeta.mockResolvedValueOnce(null);

    const r = await run("asset-broken-references");

    expect(r.items).toEqual([expect.objectContaining({ id: "a1", schemaId: "s1", objectTypeName: "Laptop", referenceObjectTypeId: "gone" })]);
  });

  test("Assets: an unlicensed site says so", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValueOnce({ state: "unavailable" });
    expect(await run("asset-bare-types")).toMatchObject({ available: false, reason: "assets-not-enabled" });
  });
});

describe("getRemediationCandidates -- fields, workflows, projects, screens, automation", () => {
  const run = (findingKey) => getRemediationCandidates({ payload: { findingKey }, context: { installContext: "ari:cloud:jira::site/x", accountId: "admin-1" } });

  test("fields: each code reads the threshold-aware findings, with the reason text on the item", async () => {
    mocks.readSnapshotMeta.mockResolvedValueOnce({ version: "s1" });
    mocks.loadSnapshotFields.mockResolvedValueOnce([
      // Widely used, no description.
      { id: "customfield_1", name: "Team", type: "select", description: "", configuredProjectCount: 40, activeProjectCount: 40, totalIssueCount: 90000, findings: null },
      { id: "customfield_2", name: "Budget", type: "number", description: "Money", configuredProjectCount: 1, activeProjectCount: 1, totalIssueCount: 10, findings: null },
    ]);
    const r = await run("field-missing-description");
    expect(r.available).toBe(true);
    expect(r.items.map((f) => f.id)).toEqual(["customfield_1"]);
    expect(r.items[0].reasons[0]).toEqual(expect.any(String));
  });

  test("fields: unavailable before any field snapshot exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValueOnce(null);
    expect(await run("field-stale")).toMatchObject({ available: false, reason: "no-snapshot" });
  });

  function workflowFixture() {
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce({ version: "w1" });
    mocks.loadWorkflowSchemes.mockResolvedValueOnce([{ id: "10", name: "No Done", projectCount: 2 }]);
    mocks.loadStatusesCatalog.mockResolvedValueOnce([
      { id: "1", name: "Open", statusCategory: "new" },
      { id: "2", name: "open", statusCategory: "new" },
      { id: "3", name: "Legacy", statusCategory: "indeterminate" },
      { id: "4", name: "Robot only", statusCategory: "indeterminate" },
    ]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValueOnce([{ schemeId: "10", statusId: "1" }, { schemeId: "10", statusId: "2" }]);
    mocks.loadStatusIssueCounts.mockResolvedValueOnce(new Map([["1", 5], ["2", 1], ["3", 7], ["4", 0]]));
    mocks.loadStatusHistoryCounts.mockResolvedValueOnce({ counts: new Map(), measuredAt: null });
    mocks.loadStatusAutomationReferences.mockResolvedValueOnce({ "robot only": { ruleCount: 2, enabledRuleCount: 2 } });
  }

  test("workflows: duplicate groups, rule-only, unreachable-with-issues and scheme structure", async () => {
    workflowFixture();
    const dupes = await run("workflow-duplicate-statuses");
    expect(dupes.items[0].statuses.map((st) => [st.name, st.issueCount])).toEqual([["Open", 5], ["open", 1]]);

    workflowFixture();
    expect((await run("unreachable-with-issues")).items).toEqual([{ id: "3", name: "Legacy", issueCount: 7 }]);

    workflowFixture();
    const structure = await run("workflow-scheme-structure");
    expect(structure.items[0]).toMatchObject({ id: "10", name: "No Done", flags: expect.arrayContaining([expect.stringMatching(/No Done/)]) });
  });

  test("workflows: unavailable, not empty, when the scheme->status mapping is missing", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce({ version: "w1" });
    mocks.loadWorkflowSchemes.mockResolvedValueOnce([]);
    mocks.loadStatusesCatalog.mockResolvedValueOnce([{ id: "1", name: "Open" }]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValueOnce([]);
    mocks.loadStatusIssueCounts.mockResolvedValueOnce(new Map());
    mocks.loadStatusHistoryCounts.mockResolvedValueOnce({ counts: new Map(), measuredAt: null });
    expect(await run("rule-only-statuses")).toMatchObject({ available: false, reason: "no-scheme-mapping" });
  });

  test("projects: over-configured (idle marked) and unused, every one rather than the Overview's top 8", async () => {
    const projects = [
      ...Array.from({ length: 12 }, (_, i) => ({ projectId: `${i}`, projectKey: `P${i}`, projectName: `P${i}`, fieldCount: 50, totalIssueCount: 10 })),
      ...Array.from({ length: 12 }, (_, i) => ({ projectId: `n${i}`, projectKey: `N${i}`, projectName: `N${i}`, fieldCount: 2, totalIssueCount: 5000 })),
      { projectId: "u", projectKey: "UNUSED", projectName: "Unused", fieldCount: 3, totalIssueCount: 0 },
    ];
    for (let i = 0; i < 2; i += 1) {
      mocks.readSnapshotMeta.mockResolvedValueOnce({ version: "s1" });
      mocks.listSnapshotProjects.mockResolvedValueOnce(projects);
      mocks.loadProjectActivity.mockResolvedValueOnce(new Map());
    }
    const over = await run("project-over-configured");
    expect(over.items).toHaveLength(12);
    expect(over.items.every((p) => p.idle)).toBe(true);
    expect((await run("unused-projects")).items.map((p) => p.projectKey)).toEqual(["UNUSED"]);
  });

  test("projects: no adoption tasks while the activity data is stale or unmeasured", async () => {
    mocks.readSnapshotMeta.mockResolvedValueOnce({ version: "s1" });
    mocks.listSnapshotProjects.mockResolvedValueOnce([{ projectId: "1", projectKey: "A", projectName: "A", fieldCount: 3, totalIssueCount: 9 }]);
    mocks.loadProjectActivity.mockResolvedValueOnce(new Map());
    expect(await run("projects-fell-off")).toEqual({ available: true, items: [] });
  });

  test("screens: a filtered screen list, and unreachable needs the workflow snapshot", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValueOnce({ version: "sv1" });
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce(null);
    mocks.loadScreensPage.mockResolvedValueOnce({ rows: [{ screenId: "7", name: "Blank", tabCount: 1, fieldCount: 0 }] });
    expect((await run("screen-empty")).items).toEqual([{ id: "7", name: "Blank", tabCount: 1, fieldCount: 0 }]);
    expect(mocks.loadScreensPage.mock.calls[0][2]).toMatchObject({ filter: "empty" });

    mocks.readScreenSnapshotMeta.mockResolvedValueOnce({ version: "sv1" });
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce(null);
    expect(await run("screen-unreached")).toMatchObject({ available: false, reason: "no-workflow-snapshot" });

    // A snapshot that never read transitions would ticket screens a transition opens.
    mocks.readScreenSnapshotMeta.mockResolvedValueOnce({ version: "sv1" });
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce({ version: "wv1", transitionScreens: null });
    expect(await run("screen-unreached")).toMatchObject({ available: false, reason: "transitions-unknown" });
  });

  test("screens: dangling operations grouped per scheme; unused schemes", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValueOnce({ version: "sv1" });
    mocks.loadScreenSchemeOperations.mockResolvedValueOnce([
      { schemeId: "s1", operation: "create", screenId: "99", dangling: true },
      { schemeId: "s1", operation: "edit", screenId: "98", dangling: true },
      { schemeId: "s2", operation: "view", screenId: "1", dangling: false },
    ]);
    mocks.loadScreenSchemes.mockResolvedValueOnce([{ schemeId: "s1", name: "Broken", issueTypeSchemeCount: 1 }, { schemeId: "s2", name: "Fine", issueTypeSchemeCount: 1 }]);
    const dangling = await run("screen-dangling");
    expect(dangling.items).toEqual([{ id: "s1", name: "Broken", operations: [{ operation: "create", screenId: "99" }, { operation: "edit", screenId: "98" }] }]);

    mocks.readScreenSnapshotMeta.mockResolvedValueOnce({ version: "sv1" });
    mocks.loadScreenSchemes.mockResolvedValueOnce([{ schemeId: "s3", name: "Orphan", issueTypeSchemeCount: 0 }, { schemeId: "s2", name: "Fine", issueTypeSchemeCount: 2 }]);
    expect((await run("screen-unused-schemes")).items).toEqual([{ id: "s3", name: "Orphan" }]);
  });

  test("automation: disabled rules in full from the directory", async () => {
    mocks.readAutomationPart.mockResolvedValueOnce({ rules: [[1, "On", 1, null, 2, null], [2, "Off", 0, "jira:issue_created", 1, null]] });
    expect((await run("automation-disabled")).items).toEqual([expect.objectContaining({ id: 2, name: "Off", enabled: false })]);
  });

  test("automation: risk findings are marked partial when the preview holds fewer than the count", async () => {
    mocks.readAutomationAnalysis.mockResolvedValueOnce({
      estate: { health: { credentialRuleCount: 9 } },
      findingsPreview: [
        { id: 1, n: "Webhook", e: 1, r: [{ c: "embedded-credential", s: "high" }] },
        { id: 2, n: "Other", e: 1, r: [{ c: "external-http", h: ["x.io"] }] },
      ],
    });
    const r = await run("automation-credentials");
    expect(r).toMatchObject({ available: true, partial: true, expected: 9 });
    expect(r.items).toEqual([expect.objectContaining({ id: 1, name: "Webhook", enabled: true })]);
  });

  test("automation: not partial when the preview holds every flagged rule", async () => {
    mocks.readAutomationAnalysis.mockResolvedValueOnce({
      estate: { health: { externalHttpCount: 1 } },
      findingsPreview: [{ id: 2, n: "Other", e: 1, r: [{ c: "external-http", h: ["x.io"] }] }],
    });
    const r = await run("automation-external");
    expect(r.partial).toBeUndefined();
    expect(r.items[0].hosts).toEqual(["x.io"]);
  });

  test("automation: self-triggering rules from the stored cascades, once each", async () => {
    mocks.readAutomationAnalysis.mockResolvedValueOnce({
      estate: { health: { selfTriggeringCount: 1 } },
      cascades: [
        { sourceId: 5, sourceName: "Loop", targetId: 5, selfTriggering: true },
        { sourceId: 5, sourceName: "Loop", targetId: 5, selfTriggering: true },
        { sourceId: 6, targetId: 7, selfTriggering: false },
      ],
    });
    mocks.readAutomationPart.mockResolvedValueOnce(null);
    expect((await run("automation-self-triggering")).items).toEqual([expect.objectContaining({ id: 5, name: "Loop" })]);
  });
});

describe("getRemediationCandidates -- every new loader is explicitly unavailable before its data exists", () => {
  const run = (findingKey) => getRemediationCandidates({ payload: { findingKey }, context: { installContext: "ari:cloud:jira::site/x", accountId: "admin-1" } });

  test.each([
    ["field-admin-attention", "readSnapshotMeta", "no-snapshot"],
    ["field-risky", "readSnapshotMeta", "no-snapshot"],
    ["workflow-duplicate-statuses", "readWorkflowSnapshotMeta", "no-snapshot"],
    ["unused-projects", "readSnapshotMeta", "no-snapshot"],
    ["screen-empty", "readScreenSnapshotMeta", "no-snapshot"],
    ["screen-dangling", "readScreenSnapshotMeta", "no-snapshot"],
    ["screen-unused-schemes", "readScreenSnapshotMeta", "no-snapshot"],
    ["filters-shared-everyone", "readFilterSnapshotMeta", "no-snapshot"],
    ["dashboards-empty", "readDashboardSnapshotMeta", "no-snapshot"],
    ["people-offroster-automation-refs", "readUserSnapshotMeta", "no-snapshot"],
    ["issue-type-hierarchy", "readIssueTypeSnapshotMeta", "no-snapshot"],
    ["estate-duplicate-priorities", "readEstateSnapshotMeta", "no-snapshot"],
    ["asset-bare-types", "readAssetSnapshotMeta", "no-snapshot"],
  ])("%s", async (key, metaMock, reason) => {
    mocks[metaMock].mockResolvedValueOnce(null);
    expect(await run(key)).toMatchObject({ available: false, reason, items: [] });
  });

  test.each([
    ["automation-disabled", "no-automation-index"],
    ["automation-inert", "no-analysis"],
    ["automation-self-triggering", "no-analysis"],
  ])("%s", async (key, reason) => {
    mocks.readAutomationAnalysis.mockResolvedValueOnce(null);
    mocks.readAutomationPart.mockResolvedValueOnce(null);
    expect(await run(key)).toMatchObject({ available: false, reason });
  });

  test("rule-only statuses: the orphans an automation rule still names", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce({ version: "w1" });
    mocks.loadWorkflowSchemes.mockResolvedValueOnce([{ id: "10", name: "S", projectCount: 1 }]);
    mocks.loadStatusesCatalog.mockResolvedValueOnce([{ id: "1", name: "Open" }, { id: "4", name: "Robot only" }]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValueOnce([{ schemeId: "10", statusId: "1" }]);
    mocks.loadStatusIssueCounts.mockResolvedValueOnce(new Map([["4", 0]]));
    mocks.loadStatusHistoryCounts.mockResolvedValueOnce({ counts: new Map(), measuredAt: null });
    mocks.loadStatusAutomationReferences.mockResolvedValueOnce({ "robot only": { ruleCount: 2, enabledRuleCount: 1 } });
    const r = await run("rule-only-statuses");
    expect(r.items).toEqual([expect.objectContaining({ id: "4", name: "Robot only" })]);
  });

  test("stale projects: every project untouched for over 180 days", async () => {
    mocks.readSnapshotMeta.mockResolvedValueOnce({ version: "s1" });
    mocks.listSnapshotProjects.mockResolvedValueOnce([
      { projectId: "1", projectKey: "OLD", projectName: "Old", fieldCount: 3, totalIssueCount: 9, latestIssueUpdatedAt: "2024-01-01T00:00:00Z" },
      { projectId: "2", projectKey: "NEW", projectName: "New", fieldCount: 3, totalIssueCount: 9, latestIssueUpdatedAt: new Date().toISOString() },
    ]);
    mocks.loadProjectActivity.mockResolvedValueOnce(new Map());
    expect((await run("stale-projects")).items.map((p) => p.projectKey)).toEqual(["OLD"]);
  });
});
