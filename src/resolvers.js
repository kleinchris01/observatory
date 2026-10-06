import api, { route } from "@forge/api";
import { kvs } from "@forge/kvs";
import {
  incrMetric,
  METRIC_NAMES,
  makeJobToken,
  getInstallationKey,
  callerHasJiraAdmin,
  mapWithConcurrency,
  jiraRequest,
  getDistinctIssueCountForFields,
  getLiveFieldProjectUsage,
  loadFieldContexts,
  collectRecentFieldProjectCandidates,
  PROJECT_USAGE_PAGE_SIZE,
  PROJECTS_VIEW_PAGE_SIZE,
  MAX_ACTIVE_PROJECT_USAGE_JOBS,
  MAX_AUTOQUEUED_REPORT_FIELDS,
  MAX_AUTOQUEUED_REPORT_ISSUE_BUDGET,
  ISSUE_SCAN_PAGE_SIZE,
  ISSUE_SCAN_WORKERS,
  BASE_JIRA_CONCURRENCY,
  loadFieldOptionsFromJira,
  getBrowsableProjectIds,
  createJiraIssue,
} from "./lib/jira-api.js";
import { queueIssueScanWorker, completeIssueScanFinalization } from "./lib/scan-engine.js";
import { pillarUnavailable, agentOk, agentNotFound, rankMatches, clampResults } from "./lib/rovo-agents.js";
import {
  requeueStaleSnapshotBuild,
  hydrateFieldForGovernance,
  ensureFieldSummaryJobRunning,
  queueSnapshotBuild,
  queueReportBuild,
  queueFieldSummaryContinuationWithRetry,
  queueFieldUsageDeltaRefreshWithRetry,
  processFieldSummaryChunk,
  queueProjectUsageRestore,
} from "./lib/snapshot-engine.js";
import {
  ensureProjectStoreReady,
  readSnapshotMeta,
  writeSnapshotMeta,
  clearAllSnapshotData,
  recordAuditEvent,
  listAuditEvents,
  loadSnapshotFields,
  loadSnapshotField,
  loadSnapshotFieldNames,
  loadSnapshotProjectUsage,
  loadAllSnapshotProjectUsage,
  loadAnySnapshotProjectUsage,
  listSnapshotProjects,
  loadIssueScanProjectTotals,
  loadProjectActivity,
  loadFilters,
  readFilterSnapshotMeta,
  writeFilterSnapshotMeta,
  loadFilterReferencesFor,
  loadDashboardsForFilters,
  loadFieldNamesForFilterIds,
  loadFilterNamesForIds,
  loadFilterIdsForLabels,
  loadGadgetCountsForFilterIds,
  countGadgetConfigCoverage,
  loadFilterReferenceCounts,
  loadDashboards,
  readDashboardSnapshotMeta,
  writeDashboardSnapshotMeta,
  loadSnapshotProjectFields,
  countSnapshotProjectUsage,
  loadFieldSummary,
  replaceFieldSummary,
  listFieldSummaries,
  countFieldSummariesByStatus,
  replaceSnapshotProjectUsageForField,
  listSavedReports,
  saveSavedReport,
  deleteSavedReport,
  replaceReportJob,
  loadReportJob,
  readIssueScanMeta,
  writeIssueScanMeta,
  readIssueScanWorker,
  updateIssueScanWorker,
  tryClaimIssueScanFinalization,
  replaceFieldOptionsCache,
  loadFieldOptionsCache,
  searchFieldOptionsCache,
  countOldScopeKeyRows,
  migrateOldScopeKeys,
  loadSnapshotFieldIssueSums,
  sumSnapshotFieldIssueCount,
  loadFieldTypeUsage,
  loadFieldUserUsage,
  loadUserFieldAppearances,
  upsertProjectTotalsForDelta,
  upsertDeltaFieldProjectUsage,
  upsertRqtFieldHits,
  upsertRqtIssueKeys,
  upsertRqtValueIssueKeys,
  upsertRqtFieldIssueKeys,
  loadRqtFieldIndex,
  loadRqtIssueKeys,
  loadRqtValueFrequency,
  searchRqtValueIssueKeys,
  loadRqtFieldIssueIndex,
  loadIssueRqtValues,
  readWorkflowSnapshotMeta,
  loadTransitionsTouchingStatus,
  transitionAwareWorkflowVersion,
  readRecentFullScanRuns,
  loadWorkflowSchemes,
  loadWorkflowSchemeProjects,
  loadProjectWorkflowSchemeMap,
  loadWorkflowSchemeForProject,
  loadStatusesCatalog,
  loadWorkflowSchemeStatuses,
  loadStatusIssueCounts,
  loadStatusHistoryCounts,
  readScreenSnapshotMeta,
  loadScreensPage,
  loadScreensForField,
  loadScreenSchemes,
  loadScreenSchemeOperations,
  loadIssueTypeScreenSchemes,
  loadItssMappings,
  loadItssProjects,
  loadScreensWithFieldsByIds,
  loadScreenGovernanceSummary,
  loadFieldReachabilityByProject,
  loadProjectScreenCoverage,
  loadPopulatedProjectUsage,
  loadPopulatedFieldProjectPairs,
  writeScreenCrossSummary,
  readScreenCrossSummary,
  loadScreenCountsForFields,
  loadScreenDistributions,
  loadScreensForProject,
  loadScreensForProjects,
  DEFAULT_SCREEN_SORT,
  SCREEN_SORT_KEYS,
  readIssueTypeSnapshotMeta,
  loadIssueTypes,
  loadIssueTypeSchemes,
  loadIssueTypeSchemeItems,
  loadIssueTypeSchemeProjects,
  loadIssueTypeSchemeForProject,
  loadIssueTypeGovernanceSummary,
  loadIssueTypeTotals,
  readUserSnapshotMeta,
  loadUsers,
  loadUserGovernanceSummary,
  readAssetSnapshotMeta,
  loadAssetSchemas,
  loadAssetObjectTypes,
  loadAssetAttributes,
  loadAssetTypeCounts,
  readAssetTypeCountMeta,
  readAccessSnapshotMeta,
  loadSchemes,
  loadSchemeHolders,
  loadSchemeLevels,
  loadSchemeProjects,
  loadSchemesGrantingHolder,
  loadProjectSchemes,
  loadProjectRoleActors,
  readDriftSnapshotMeta,
  loadConfigChanges,
  changeCursorOf,
  loadConfigChangeSummary,
  readEstateSnapshotMeta,
  loadUserActivity,
  readFieldConfigSnapshotMeta,
  loadEstateValues,
  loadEstateValueTotals,
  readBoardSnapshotMeta,
  loadBoards,
  loadBoardColumns,
  recordHealthSnapshot,
  loadPriorHealthDimensions,
  readFullScanMeta,
  loadHealthHistory,
  loadTransitionScreens,
  recordRemediationTicket,
  loadRemediationTickets,
  getRemediationEpic,
  loadTicketedItemIds,
  currentPeriod,
} from "./lib/project-store.js";
import { getPlaybook, groupBounded, listPlaybookCatalog, REMEDIATION_FINDING_INDEX } from "./lib/remediation-playbooks.js";
import { computeRemediationMetrics } from "./lib/remediation-metrics.js";
import { queueRemediationSync } from "./lib/remediation-sync.js";
import { renderADF } from "./lib/adf.js";
import { queueWorkflowSnapshotBuild, isWorkflowBuildStale, queueStatusHistoryBuild } from "./lib/workflow-engine.js";
import { getWorkflowRuleUsage, getWorkflowRules, getWorkflowRestrictions, getWorkflowRuleInsights, loadFieldWorkflowEvidence } from "./lib/workflow-rule-reads.js";
import { getFieldConfigInventory, getFieldConfigItems, getFieldBehaviour } from "./lib/fieldconfig-reads.js";
import { queueFieldConfigSnapshotBuild, isFieldConfigBuildStale } from "./lib/fieldconfig-engine.js";
import { measureScreenFetchCost, probeScreenEndpoints, DEFAULT_SAMPLE_SIZE } from "./lib/screen-probe.js";
import { probeAssetsApi as probeAssetsApiProbe } from "./lib/asset-probe.js";
import { queueScreenSnapshotBuild, isScreenBuildStale } from "./lib/screen-engine.js";
import { queueIssueTypeSnapshotBuild, isIssueTypeBuildStale } from "./lib/issuetype-engine.js";
import { queueUserSnapshotBuild, isUserBuildStale } from "./lib/user-engine.js";
import { queueAssetSnapshotBuild, isAssetBuildStale, queueAssetTypeCountBuild, isAssetTypeCountBuildStale } from "./lib/asset-engine.js";
import { queueAccessSnapshotBuild, isAccessBuildStale } from "./lib/access-engine.js";
import { queueDriftSnapshotBuild, isDriftBuildStale, DRIFT_PILLARS } from "./lib/drift-engine.js";
import { queueEstateSnapshotBuild, isEstateBuildStale } from "./lib/estate-engine.js";
import { queueBoardSnapshotBuild, isBoardBuildStale } from "./lib/board-engine.js";
import { summarizeBoardInsights, boardIssues, indexFiltersById } from "./lib/board-insights.js";
import { buildPillarReport, unavailableReport, isPillarReportKey, countScreenProjects, REPORT_ROW_LIMIT } from "./lib/pillar-reports.js";
import { parseOql, evaluate as evaluateOql, sortEntities as sortOqlEntities, pinnedPillars } from "./lib/oql.js";
import { buildOqlCatalog, buildEntityIndex, OQL_PILLARS, CHURN_WINDOW_DAYS } from "./lib/oql-index.js";
import { attachEstateUsage, summarizeEstateInsights } from "./lib/estate-insights.js";
import { summarizeIssueTypeInsights } from "./lib/issuetype-insights.js";
import { summarizeAssetInsights } from "./lib/asset-insights.js";
import {
  summarizePermissionInsights, summarizeSecurityInsights, summarizeNotificationInsights,
  summarizeRoleInsights,
} from "./lib/access-insights.js";
import { computeSiteHealth, DEFAULT_HEALTH_TOLERANCES, DEFAULT_HEALTH_TARGETS } from "./lib/health-score.js";
// Moved out of this file so a scan can record a measurement without importing the
// resolver layer. Same implementation, both callers.
import {
  buildFieldUsageInsights,
  buildProjectInsights,
  buildWorkflowOverview,
  buildScreenOverview,
  buildFilterOverview,
  buildDashboardOverview,
  buildIssueTypeOverview,
  buildUserOverview,
  buildAssetOverview,
  buildAccessOverview,
  buildEstateOverview,
  buildFieldConfigOverview,
  buildBoardOverview,
  buildDriftHealthOverview,
  attachUniqueIssueCounts,
  captureSiteHealth,
} from "./lib/site-health.js";
import { summarizeAdoption, computeProjectAdoption } from "./lib/project-adoption.js";
import { summarizeFilters, summarizeFilterHealth } from "./lib/filter-insights.js";
import { summarizeDashboards, summarizeDashboardHealth } from "./lib/dashboard-insights.js";
import { isFilterBuildStale, queueFilterSnapshotBuild } from "./lib/filter-engine.js";
import { filterRows, sortFilters, filterFindingCounts, FILTER_SORTS } from "./lib/filter-query.js";
import { isDashboardBuildStale, queueDashboardSnapshotBuild } from "./lib/dashboard-engine.js";
import { startFullScan, fullScanStageCatalog, startQuickScan, quickScanStageCatalog, recoverStalledScan, resumeScanRun, cancelScan, readStageProducedCounts } from "./lib/full-scan-runner.js";
import { FULL_SCAN_STALL_MS, MAX_SCAN_TOTAL_MS } from "./lib/full-scan.js";
import { probeEndpoint, probeStargateEndpoint, getCloudId, getAllJiraProjects, getPermissionCatalog, getSiteBaseUrl, normalizeSiteOrigin } from "./lib/jira-api.js";
import {
  findDuplicateStatusGroups,
  findOrphanedStatuses,
  computeSchemeCategoryBalance,
  summarizeWorkflowInsights,
} from "./lib/workflow-insights.js";
import { summarizeScreenFieldCross } from "./lib/screen-insights.js";
import { assessFieldDeletion, assessStatusDeletion, summarizeDeletionSafety } from "./lib/deletion-safety.js";
import { analyzeCascadeGraph, MAX_CHAIN_DEPTH } from "./lib/cascade-graph.js";
import { activeRosterIds, buildOwnershipIndex, summarizeOrphanedOwnership, classifyUserActivity } from "./lib/user-ownership.js";
import {
  hydrateRuleDirectory,
  assessAutomationEvidence,
  DEFAULT_ANALYSIS_STALE_AFTER_DAYS,
} from "./lib/automation-analysis.js";
import {
  readAutomationAnalysis,
  writeAutomationAnalysis,
  readAutomationPart,
  writeAutomationPart,
  replaceAutomationReferences,
  replaceAutomationRules,
  loadRulesForProject,
  loadStatusAutomationReferences,
  loadGlobalRulesAffectingProject,
  replaceAutomationFindings,
  replaceAutomationCascades,
  replaceAutomationBlast,
  loadBlastSummary,
  loadBlastRules,
  loadCascadeSummary,
  loadCascades,
  loadCascadeEdges,
  loadRuleDirectoryFor,
  loadAutomationReferencesFor,
  AUTOMATION_PARTS,
  MAX_PREVIEW_FINDINGS,
  MAX_STORED_CASCADES,
  MAX_STORED_CROSS_RULE,
} from "./lib/store/automation.js";
import {
  STRUCTURAL_SYSTEM_FIELDS,
  isFieldValueNonEmpty,
  collectIssueRqtValues,
  buildRqtJql,
  summarizeProjectUsageCapacity,
  normalizeFieldName,
  buildDuplicateNameCountMap,
  isJiraBuiltinField,
  isLikelyAppProvidedField,
  DEFAULT_GOVERNANCE_THRESHOLDS,
  filterInventoryFields,
  applyFindingsFilter,
  sortInventoryFields,
  summarizeFindings,
  summarizeFindingsByCode,
  filterProjectUsageByBrowsable,
} from "./lib/analysis.js";
import {
  buildFieldJql,
  buildOverallFieldJql,
  getFieldNumericId,
} from "./lib/transform.js";
import { inventorySnapshotQueue } from "./lib/queues.js";
import { logger, fallbackOn, ignoreWith } from "./lib/logger.js";
import {
  requireNonEmptyString,
  requirePositiveInt,
  requireBoundedInt,
  optionalPositiveInt,
  requireArray,
  optionalString,
  optionalEnum,
} from "./lib/validate.js";

// ---------------------------------------------------------------------------
// PII / data-retention audit note
// ---------------------------------------------------------------------------
// What user-derived data is persisted by this app:
//
//   progressLog entries  â€” Human-readable status messages written during
//     snapshot, issue-scan, and project-usage-job runs. These contain only
//     counts, timestamps, and field/project names â€” no issue content and no
//     Jira user IDs or account IDs.
//
//   scan statistics  â€” issue_scan_meta rows store counts (processedIssues,
//     totalIssues, pagesScanned) and timing only. No issue content is
//     persisted; the scanner reads issues at runtime and discards them after
//     aggregation.
//
//   fieldOptionsCache  â€” The replaceFieldOptionsCache / loadFieldOptionsCache
//     functions store field option *labels* as returned by the Jira Fields
//     API. These labels may contain user-entered values (e.g. option names
//     typed by a Jira admin). They are stored as-is to support the
//     searchFieldOptions resolver.
//
//   field_summaries / snapshot_fields  â€” Store field metadata (name, type,
//     project/issue counts) from the Jira custom fields catalogue. No issue
//     body content or user-identifiable data beyond field configuration is
//     stored.
//
// Recommended retention review:
//   Review annually and whenever a GDPR/data-subject access or erasure
//   request arrives. The KVS key ADMIN_CONFIG_KEY and all installation-scoped
//   keys can be enumerated via the project-store helpers for targeted erasure.
// ---------------------------------------------------------------------------

// ----- Admin config -----

const ADMIN_CONFIG_KEY = "atlasiq-admin-config";

const DEFAULT_MACRO_ACCESS = {
  restrictAccess: false,
  allowedGroups: [],
};

// Quick scan's schedule. dayOfWeek only matters when frequency is "weekly" -- 0 is Sunday, to
// match Date#getUTCDay() and the way most people say a day of the week.
//
// windowHours defaults to matching the interval (weekly -> 168h, daily -> 24h) but can be set
// wider than the interval on purpose: a schedule that is sometimes late for reasons outside
// this app's control (Forge's own scheduling looseness, a site down for maintenance) should
// still catch everything that changed, not lose the gap in between. Narrower than the
// interval would be the opposite mistake -- a quiet hole between two quick scans that nothing
// ever re-checks.
// What the admin has explicitly acknowledged during first run, and whether they have put
// the panel away. Only ACKNOWLEDGEMENTS live here -- a human confirming they have read
// something is a real fact with nowhere else to live. Every step that describes the state of
// the estate is derived from that estate on read, never stored: a stored flag drifts, lies
// after a data wipe, and survives a reinstall it should not.
const DEFAULT_FIRST_RUN = {
  acknowledged: [],
  dismissed: false,
};

const DEFAULT_QUICK_SCAN_SCHEDULE = {
  enabled: false,
  frequency: "weekly",
  dayOfWeek: 0,
  hourUtc: 0,
  windowHours: 168,
  lastScheduledRunAt: null,
};

const DEFAULT_REMEDIATION_CONFIG = {
  // The project remediation epics and tasks are created in. Empty means "not set up yet" --
  // every create action refuses until an admin picks one.
  projectKey: "",
  epicIssueType: "Epic",
  taskIssueType: "Task",
  // Optional: an accountId every created task is assigned to. Empty means unassigned.
  defaultAssigneeAccountId: "",
};

const DEFAULT_ADMIN_CONFIG = {
  readOnlyMode: false,
  apiConcurrency: BASE_JIRA_CONCURRENCY,
  // How old an imported automation analysis may be before its answers stop being treated as
  // current. 7 days matches the macro's existing snapshot warning and the Quick Scan panel's
  // full-scan age, so an admin meets one staleness rule across the product rather than three.
  automationStaleAfterDays: DEFAULT_ANALYSIS_STALE_AFTER_DAYS,
  autoSnapshotEnabled: false,
  autoSnapshotFrequency: "weekly",
  governanceThresholds: DEFAULT_GOVERNANCE_THRESHOLDS,
  macroAccess: DEFAULT_MACRO_ACCESS,
  quickScanSchedule: DEFAULT_QUICK_SCAN_SCHEDULE,
  remediation: DEFAULT_REMEDIATION_CONFIG,
  firstRun: DEFAULT_FIRST_RUN,
};

export async function readAdminConfig() {
  try {
    const stored = await kvs.get(ADMIN_CONFIG_KEY);
    if (!stored) return DEFAULT_ADMIN_CONFIG;
    return {
      ...DEFAULT_ADMIN_CONFIG,
      ...stored,
      governanceThresholds: {
        ...DEFAULT_GOVERNANCE_THRESHOLDS,
        ...(stored.governanceThresholds || {}),
      },
      macroAccess: {
        ...DEFAULT_MACRO_ACCESS,
        ...(stored.macroAccess || {}),
      },
      quickScanSchedule: {
        ...DEFAULT_QUICK_SCAN_SCHEDULE,
        ...(stored.quickScanSchedule || {}),
      },
      remediation: {
        ...DEFAULT_REMEDIATION_CONFIG,
        ...(stored.remediation || {}),
      },
      firstRun: {
        ...DEFAULT_FIRST_RUN,
        ...(stored.firstRun || {}),
      },
    };
  } catch {
    return DEFAULT_ADMIN_CONFIG;
  }
}

export async function getAdminConfigResolver(_payload, _context) {
  return readAdminConfig();
}

export async function saveAdminConfigResolver({ payload }) {
  // Input validation for admin config shape
  const cfg = payload || {};
  if (cfg.apiConcurrency !== undefined && cfg.apiConcurrency !== null) {
    requireBoundedInt(cfg.apiConcurrency, "apiConcurrency", 1, 20);
  }
  // Bounded at both ends on purpose. Zero or negative would make every analysis stale and
  // the pillar would answer "unknown" forever; an unbounded upper end would let someone set
  // it high enough to silence the warning permanently, which is the same as removing it.
  if (cfg.automationStaleAfterDays !== undefined && cfg.automationStaleAfterDays !== null) {
    requireBoundedInt(cfg.automationStaleAfterDays, "automationStaleAfterDays", 1, 90);
  }
  if (cfg.autoSnapshotFrequency !== undefined && cfg.autoSnapshotFrequency !== null) {
    optionalEnum(cfg.autoSnapshotFrequency, "autoSnapshotFrequency", ["daily", "weekly", "monthly"], null);
  }
  const thresholds = cfg.governanceThresholds || {};
  const thresholdKeys = [
    "unusedFieldDaysThreshold",
    "lowUsageIssueThreshold",
    "highUsageIssueThreshold",
    "highProjectCountThreshold",
  ];
  for (const key of thresholdKeys) {
    if (thresholds[key] !== undefined && thresholds[key] !== null) {
      requirePositiveInt(thresholds[key], `governanceThresholds.${key}`);
    }
  }
  // Health tolerances are rates, not counts: the share of an estate at which a dimension
  // bottoms out. Validated as a fraction so a value typed as a percentage (15 rather than
  // 0.15) is rejected here rather than silently zeroing that dimension for everyone.
  const tolerances = cfg.healthTolerances || {};
  for (const key of Object.keys(DEFAULT_HEALTH_TOLERANCES)) {
    const value = tolerances[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
      throw new Error(`healthTolerances.${key} must be a rate greater than 0 and at most 1`);
    }
  }
  // v2 scoring targets: each is { target, floor } as rates in [0,1]. Only the shape is
  // enforced here -- resolveHealthTargets rejects a degenerate pair for the direction and
  // keeps the default, so a bad band costs one tuned dimension, not the score.
  const healthTargets = cfg.healthTargets || {};
  for (const key of Object.keys(DEFAULT_HEALTH_TARGETS)) {
    const band = healthTargets[key];
    if (band === undefined || band === null) continue;
    if (typeof band !== "object" || Array.isArray(band)) {
      throw new Error(`healthTargets.${key} must be an object with target and floor rates`);
    }
    for (const field of ["target", "floor"]) {
      const v = band[field];
      if (v === undefined || v === null) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
        throw new Error(`healthTargets.${key}.${field} must be a rate between 0 and 1`);
      }
    }
  }
  // Remediation ticketing target. Every field is optional here; a create action does its
  // own "is this actually set up" check. What is enforced is the shape, so a typo cannot
  // wedge issue creation for everyone — a project KEY, not a name or an id, and issue-type
  // names that are non-empty strings.
  if (cfg.remediation) {
    const rem = cfg.remediation;
    if (rem.projectKey !== undefined && rem.projectKey !== null && rem.projectKey !== "") {
      if (typeof rem.projectKey !== "string" || !/^[A-Za-z][A-Za-z0-9_]{1,49}$/.test(rem.projectKey)) {
        throw new Error("remediation.projectKey must be a Jira project key (letters, digits and underscores, starting with a letter).");
      }
    }
    for (const key of ["epicIssueType", "taskIssueType"]) {
      if (rem[key] !== undefined && rem[key] !== null && rem[key] !== "") {
        if (typeof rem[key] !== "string" || rem[key].length > 100) {
          throw new Error(`remediation.${key} must be an issue type name.`);
        }
      }
    }
    if (rem.defaultAssigneeAccountId !== undefined && rem.defaultAssigneeAccountId !== null && rem.defaultAssigneeAccountId !== "") {
      if (typeof rem.defaultAssigneeAccountId !== "string" || rem.defaultAssigneeAccountId.length > 128) {
        throw new Error("remediation.defaultAssigneeAccountId must be an Atlassian accountId.");
      }
    }
  }
  if (cfg.quickScanSchedule) {
    const sched = cfg.quickScanSchedule;
    if (sched.frequency !== undefined && sched.frequency !== null) {
      optionalEnum(sched.frequency, "quickScanSchedule.frequency", ["daily", "weekly"], null);
    }
    if (sched.dayOfWeek !== undefined && sched.dayOfWeek !== null) {
      requireBoundedInt(sched.dayOfWeek, "quickScanSchedule.dayOfWeek", 0, 6);
    }
    if (sched.hourUtc !== undefined && sched.hourUtc !== null) {
      requireBoundedInt(sched.hourUtc, "quickScanSchedule.hourUtc", 0, 23);
    }
    if (sched.windowHours !== undefined && sched.windowHours !== null) {
      requireBoundedInt(sched.windowHours, "quickScanSchedule.windowHours", 1, 24 * 90);
    }
  }
  const current = await readAdminConfig();
  const updated = {
    ...current,
    ...(payload || {}),
    governanceThresholds: {
      ...current.governanceThresholds,
      ...(payload?.governanceThresholds || {}),
    },
    healthTolerances: {
      ...current.healthTolerances,
      ...(payload?.healthTolerances || {}),
    },
    healthTargets: {
      ...current.healthTargets,
      ...(payload?.healthTargets || {}),
    },
    macroAccess: {
      ...current.macroAccess,
      ...(payload?.macroAccess || {}),
    },
    quickScanSchedule: {
      ...current.quickScanSchedule,
      ...(payload?.quickScanSchedule || {}),
    },
    remediation: {
      ...current.remediation,
      ...(payload?.remediation || {}),
    },
    firstRun: {
      ...current.firstRun,
      ...(payload?.firstRun || {}),
    },
  };
  updated.apiConcurrency = Math.max(1, Math.min(10, Number(updated.apiConcurrency) || BASE_JIRA_CONCURRENCY));
  // Clamped as well as validated, so a value that reached storage some other way (an older
  // build, a hand-edited record) still lands inside the band rather than disabling the gate.
  updated.automationStaleAfterDays = Math.max(1, Math.min(90,
    Number(updated.automationStaleAfterDays) || DEFAULT_ANALYSIS_STALE_AFTER_DAYS));
  await kvs.set(ADMIN_CONFIG_KEY, updated);
  return { ok: true, config: updated };
}

// How many projects this viewer can Browse, for the macro's scope statement.
//
// Best-effort and separate from the access decision: a viewer who is allowed in but whose
// project count cannot be established sees the generic "scoped to the projects you can
// browse" rather than being refused. Null means unknown, 0 means genuinely none -- and the
// macro says something different for each, because "you have no access to anything" is a
// thing somebody needs to be told plainly rather than left to infer from empty tabs.
async function viewerProjectCount(context) {
  try {
    const installationKey = getInstallationKey(context);
    const scope = await viewerProjects(installationKey, context);
    return scope.available ? scope.projects.length : null;
  } catch {
    return null;
  }
}

// The group-membership answer, cached briefly per account and group list. The macro makes
// several reads per page load, and every one of them is now gated, so without this each
// would cost a Jira round trip. Same 60-second window, and the same accepted risk, as the
// admin check: a viewer removed from the group keeps access for up to a minute.
const MACRO_ACCESS_TTL_MS = 60 * 1000;
const macroAccessCache = new Map();

export function __clearMacroAccessCache() {
  macroAccessCache.clear();
}

// One decision, used both by checkMacroAccess (which the macro asks before rendering) and by
// withMacroAccessGuard (which every macro read passes through). Before the guard existed the
// restriction was only a UI decision: the macro hid itself, but any Confluence user could
// invoke getMacroFields and the rest directly. `failedOpen` marks the accepted risk in
// SECURITY_CHECKLIST.md 1.3: a failed group lookup grants access rather than blanking the page.
async function macroAccessDecision(context) {
  try {
    const config = await readAdminConfig();
    const { restrictAccess, allowedGroups } = config.macroAccess || {};

    if (!restrictAccess) return { allowed: true };

    const groups = (allowedGroups || []).filter(Boolean);
    if (!groups.length) {
      return {
        allowed: false,
        reason: "Macro access is restricted but no allowed groups have been configured. Contact your Jira administrator.",
      };
    }

    const accountId = context?.accountId;
    if (!accountId) {
      return { allowed: false, reason: "Please sign in to Jira to view this Observatory." };
    }

    const cacheKey = `${accountId}|${JSON.stringify(groups)}`;
    const cached = macroAccessCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.decision;

    const resp = await api.asApp().requestJira(
      route`/rest/api/3/user/groups?accountId=${accountId}`,
      { headers: { Accept: "application/json" } }
    );

    if (!resp.ok) {
      console.error("checkMacroAccess: group lookup failed", resp.status);
      // Fail open -- do not block on an API error. Not cached, so the next call retries.
      return { allowed: true, failedOpen: true };
    }

    const userGroups = await resp.json();
    const userGroupNames = Array.isArray(userGroups) ? userGroups.map((g) => g.name) : [];
    const hasAccess = groups.some((g) => userGroupNames.includes(g));

    const decision = hasAccess
      ? { allowed: true }
      : {
          allowed: false,
          reason: "You don't have permission to view this Observatory. Contact your Jira administrator to request access.",
        };
    macroAccessCache.set(cacheKey, { decision, expires: Date.now() + MACRO_ACCESS_TTL_MS });
    return decision;
  } catch (err) {
    console.error("checkMacroAccess error:", err);
    return { allowed: true, failedOpen: true }; // fail open
  }
}

async function checkMacroAccess({ context }) {
  const decision = await macroAccessDecision(context);
  if (!decision.allowed) return { allowed: false, reason: decision.reason };
  // On a failed lookup the count is left unknown rather than guessed at, which the macro
  // renders as its generic scope line.
  return { allowed: true, projectCount: decision.failedOpen ? null : await viewerProjectCount(context) };
}

export class MacroAccessError extends Error {
  constructor(reason) {
    super(reason || "You don't have permission to view this Observatory.");
    this.name = "MacroAccessError";
  }
}

// Applied to the macro handler's registry in index.js. Not applied on the admin handler:
// the admin page is gated by Jira ADMINISTER, and the macro's group list is a setting about
// Confluence readers, not admins.
export function withMacroAccessGuard(functions) {
  return Object.fromEntries(
    Object.entries(functions).map(([name, fn]) => {
      // The check itself must stay callable, or a denied viewer could not be told why.
      if (name === "checkMacroAccess") return [name, fn];
      return [
        name,
        async (req) => {
          const decision = await macroAccessDecision(req?.context);
          if (!decision.allowed) {
            logger.warn("macro.denied", { action: name, actorId: req?.context?.accountId || null });
            throw new MacroAccessError(decision.reason);
          }
          return fn(req);
        },
      ];
    })
  );
}

// ----- Inventory UI helpers -----

const OPTION_SEARCH_FIELD_BATCH_SIZE = 10;

// Labels for Jira's issue-type hierarchy levels. Only -1, 0 and 1 are standard; a site with
// custom hierarchy above Epic has levels 2+, which the caller labels "Level N" rather than
// inventing a name. Keyed by the raw integer Jira returns, not by an ordinal.
const HIERARCHY_LEVEL_LABELS = {
  "-1": "Sub-task",
  0: "Base (Story, Task, Bug)",
  1: "Epic",
};

// ----- Resolvers -----

async function getFieldInventory({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    await ensureProjectStoreReady();
    const filters = payload || {};
    // Input validation
    if (filters.page !== undefined && filters.page !== null) requirePositiveInt(filters.page, "page");
    if (filters.pageSize !== undefined && filters.pageSize !== null) requireBoundedInt(filters.pageSize, "pageSize", 1, 100);
    optionalString(filters.sort, "sort");
    optionalString(filters.fieldType, "fieldType");
    optionalString(filters.search, "search");
    const installationKey = getInstallationKey(context);
    const pageSize = Math.max(1, Math.min(50, Number(filters.pageSize) || 10));
    const requestedPage = Math.max(1, Number(filters.page) || 1);
    const sortBy = filters.sortBy || "name-asc";
    const query = filters.query || "";
    const optionQuery = String(filters.optionQuery || "").trim();
    const type = filters.type || "all";
    const findingsFilter = filters.findingsFilter || "all";
    const projectUsageFilter = filters.projectUsageFilter || "all";
    const minIssuesWithValue = filters.minIssuesWithValue ?? "";
    const maxIssuesWithValue = filters.maxIssuesWithValue ?? "";
    const fieldOrigin = String(filters.fieldOrigin || "all").trim() || "all";
    const minActiveProjects = filters.minActiveProjects ?? "";
    const maxActiveProjects = filters.maxActiveProjects ?? "";
    const minContexts = filters.minContexts ?? "";
    const maxContexts = filters.maxContexts ?? "";
    const duplicateNamesOnly = Boolean(filters.duplicateNamesOnly);
    const hasDescription = filters.hasDescription || "all";
    const hideSystemFields = Boolean(filters.hideSystemFields);

    const [meta_initial, adminConfig] = await Promise.all([
      readSnapshotMeta(installationKey),
      readAdminConfig(),
    ]);
    let meta = meta_initial;

    if (filters.forceRefresh && meta?.state === "building") {
      meta = await requeueStaleSnapshotBuild(installationKey, meta);
    }

    // Only reset a job that was ALREADY stuck in "queued" before this request came in --
    // not one this request just transitioned into "queued" via requeueStaleSnapshotBuild
    // above, otherwise a successful requeue is undone on the very next line every time.
    if (filters.forceRefresh && meta_initial?.state === "queued" && meta?.state === "queued") {
      // Queue job never started â€” reset so forceRefresh can re-enqueue
      await writeSnapshotMeta(installationKey, {
        state: "idle",
        lastError: "Queue job did not start; reset by manual refresh.",
      });
      meta = await readSnapshotMeta(installationKey);
    }

    // Computed from the final state (after any recovery above), not the state the
    // request started with, so a reset-to-idle above can trigger a fresh requeue in
    // this same call instead of silently requiring a second click.
    const alreadyActive = meta?.state === "building" || meta?.state === "queued";
    const shouldQueue = Boolean(filters.forceRefresh && !alreadyActive && !adminConfig.readOnlyMode);

    if (shouldQueue) {
      // Claim the queue slot with a unique token, then verify we won before actually pushing.
      // This prevents two concurrent getFieldInventory calls from both enqueuing a build.
      const queueToken = makeJobToken();
      await writeSnapshotMeta(installationKey, { state: "queued", jobToken: queueToken, lastError: null });
      const claimed = await readSnapshotMeta(installationKey);
      if (claimed?.jobToken === queueToken) {
        await queueSnapshotBuild(installationKey);
      }
      meta = claimed || meta;
    }

    const snapshotStatus = {
      state: meta?.state || "idle",
      refreshedAt: meta?.refreshedAt || null,
      startedAt: meta?.startedAt || null,
      completedAt: meta?.completedAt || null,
      itemCount: meta?.totalFields || 0,
      processedFields: meta?.processedFields || 0,
      lastError: meta?.lastError || null,
      progressLog: meta?.progressLog || [],
    };

    const buildTotal = meta?.totalFields || 0;
    const buildProcessed = meta?.processedFields || 0;
    const buildProgress = (meta?.state === "building" || meta?.state === "queued")
      ? {
          status: meta.state,
          startedAt: meta?.startedAt || null,
          totalFields: buildTotal,
          processedFields: buildProcessed,
          percent: buildTotal > 0 ? Math.round((buildProcessed / buildTotal) * 100) : 0,
          progressLog: meta?.progressLog || [],
        }
      : null;

    // No snapshot data at all yet â€” return empty while the first build runs
    if (!meta?.version) {
      return {
        refreshedAt: null,
        total: 0,
        page: 1,
        pageSize,
        totalPages: 1,
        availableTypes: [],
        fields: [],
        findingsSummary: null,
        snapshotStatus,
        buildProgress,
        readOnlyMode: adminConfig.readOnlyMode,
      };
    }

    // Load from last good version â€” works for "ready", "building" (shows stale), and "failed"
    const [snapshotFields, fieldSummaries, issueSumsMap] = await Promise.all([
      loadSnapshotFields(installationKey, meta.version),
      listFieldSummaries(installationKey, 5000).catch(fallbackOn("inventory.summaries_load_failed", () => [], { installationKey })),
      loadSnapshotFieldIssueSums(installationKey, meta.version).catch(fallbackOn("inventory.issue_sums_load_failed", () => new Map(), { installationKey })),
    ]);
    const summaryByFieldId = new Map(fieldSummaries.map((summary) => [summary.fieldId, summary]));
    const duplicateNameCounts = buildDuplicateNameCountMap(snapshotFields);
    const allFields = snapshotFields.map((field) => {
      const summary = summaryByFieldId.get(field.id);
      const derivedIssueCount = summary?.totalIssueCount || field.totalIssueCount || issueSumsMap.get(field.id) || 0;
      if (!summary) {
        return hydrateFieldForGovernance({
          ...field,
          totalIssueCount: derivedIssueCount,
          projectUsageBuilt: derivedIssueCount <= 0,
          projectUsageState: derivedIssueCount <= 0 ? "not-needed" : "unbuilt",
        }, null, duplicateNameCounts.get(normalizeFieldName(field.name)) ?? 1, adminConfig.governanceThresholds);
      }
      const inferredBuilt = summary.summaryStatus === "ready";
      return hydrateFieldForGovernance({
        ...field,
        activeProjectCount: summary.activeProjectCount ?? field.activeProjectCount,
        totalIssueCount: derivedIssueCount,
        projectUsageBuilt: inferredBuilt,
        projectUsageState: summary.summaryStatus || (inferredBuilt ? "ready" : "unbuilt"),
      }, summary, duplicateNameCounts.get(normalizeFieldName(field.name)) ?? 1, adminConfig.governanceThresholds);
    });

    const optionMatches = optionQuery ? await searchFieldOptionsCache(installationKey, optionQuery, 5000) : null;
    const optionMatchedFieldIds = optionMatches ? new Set(optionMatches.map((match) => match.fieldId)) : null;
    const optionFilteredFields = optionMatchedFieldIds
      ? allFields.filter((field) => optionMatchedFieldIds.has(field.id))
      : allFields;
    const filteredFields = sortInventoryFields(
      applyFindingsFilter(
        filterInventoryFields(optionFilteredFields, query, type, projectUsageFilter, maxIssuesWithValue, fieldOrigin, minIssuesWithValue, {
          minActiveProjects, maxActiveProjects, minContexts, maxContexts, duplicateNamesOnly, hasDescription, hideSystemFields,
        }),
        findingsFilter
      ),
      sortBy
    );

    const total = filteredFields.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const startIndex = (page - 1) * pageSize;
    const availableTypes = Array.from(new Set(allFields.map((f) => f.type))).filter(Boolean).sort();

    return {
      refreshedAt: meta.refreshedAt,
      total,
      page,
      pageSize,
      totalPages,
      availableTypes,
      fields: filteredFields.slice(startIndex, startIndex + pageSize),
      findingsSummary: summarizeFindings(filteredFields),
      snapshotStatus,
      buildProgress,
      readOnlyMode: adminConfig.readOnlyMode,
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getFieldInventory failed:", error);
    throw error;
  }
}

async function getWorkflowInventory({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    await ensureProjectStoreReady();
    const filters = payload || {};
    if (filters.page !== undefined && filters.page !== null) requirePositiveInt(filters.page, "page");
    if (filters.pageSize !== undefined && filters.pageSize !== null) requireBoundedInt(filters.pageSize, "pageSize", 1, 100);
    optionalString(filters.search, "search");

    const installationKey = getInstallationKey(context);
    const pageSize = Math.max(1, Math.min(50, Number(filters.pageSize) || 10));
    const requestedPage = Math.max(1, Number(filters.page) || 1);
    const search = String(filters.search || "").trim().toLowerCase();

    let meta = await readWorkflowSnapshotMeta(installationKey);
    // A stale "building" row does not block a rebuild. Without this, one invocation killed
    // mid-build leaves the state permanently "building" and silently suppresses every
    // subsequent refresh -- the button appears to do nothing, with no error to explain it.
    const alreadyBuilding = meta?.state === "building" && !isWorkflowBuildStale(meta);
    const shouldBuild = Boolean(filters.forceRefresh && !alreadyBuilding);

    if (shouldBuild) {
      // Queued, not awaited: the build runs in the consumer (timeoutSeconds: 900) because
      // it cannot fit in this resolver's 25s. The response therefore reports state
      // "building" with no version yet, and the UI polls until the consumer finishes.
      await queueWorkflowSnapshotBuild(installationKey);
      meta = await readWorkflowSnapshotMeta(installationKey);
    }

    // Measuring "ever been in" is a separate, opt-in cost: one JQL WAS query per status.
    // Queued for the same reason the workflow build is -- a few hundred history queries
    // will not fit in a resolver invocation.
    if (filters.measureHistory && meta?.version) {
      await queueStatusHistoryBuild(installationKey);
    }

    const snapshotStatus = {
      state: meta?.state || "idle",
      version: meta?.version || null,
      startedAt: meta?.startedAt || null,
      completedAt: meta?.completedAt || null,
      refreshedAt: meta?.refreshedAt || null,
      totalSchemes: meta?.totalSchemes || 0,
      lastError: meta?.lastError || null,
    };

    if (!meta?.version) {
      return {
        schemes: [], statuses: [], page: requestedPage, pageSize,
        totalCount: 0, totalPages: 0, snapshotStatus,
      };
    }

    const [schemes, rawStatuses, currentCounts, history] = await Promise.all([
      loadWorkflowSchemes(installationKey, meta.version),
      loadStatusesCatalog(installationKey, meta.version),
      // Both are optional and measured by different mechanisms, so each failure degrades
      // to "unknown" rather than to zero -- zero is what makes a status look deletable.
      loadStatusIssueCounts(installationKey).catch(fallbackOn("workflow.status_counts_load_failed", () => new Map(), { installationKey })),
      loadStatusHistoryCounts(installationKey).catch(fallbackOn("workflow.status_history_load_failed", () => ({ counts: new Map(), measuredAt: null }), { installationKey })),
    ]);

    const hasCurrentCounts = currentCounts.size > 0;
    const hasHistoryCounts = history.counts.size > 0;
    const statuses = rawStatuses.map((status) => {
      const id = String(status.statusId ?? status.id);
      const issueCount = hasCurrentCounts ? Number(currentCounts.get(id) ?? 0) : null;
      const everCount = hasHistoryCounts ? (history.counts.get(id) ?? null) : null;
      return {
        ...status,
        issueCount,
        everCount,
        // Issues that passed through and left. Only meaningful when both measures exist,
        // and floored at zero because the two are sampled at different times and a status
        // can gain issues between them.
        departedCount: issueCount !== null && everCount !== null ? Math.max(0, everCount - issueCount) : null,
      };
    });

    // Search and page BEFORE the per-scheme enrichment below, never after.
    //
    // Enrichment costs one SQL lookup plus one permission check per scheme. Running it
    // across every scheme to then return a 10-row page is work proportional to the site
    // rather than the page: on a 142-scheme site that is 284 round trips per read, which
    // blew the resolver's 25s limit and hung the tab. Filtering here is equivalent --
    // search reads only name/description, which come from the scheme row itself, and
    // enrichment adds fields without ever removing a scheme, so neither the membership
    // of `searched` nor totalCount depends on it.
    const searched = search
      ? schemes.filter((s) =>
          s.name.toLowerCase().includes(search) || (s.description || "").toLowerCase().includes(search))
      : schemes;

    const totalCount = searched.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const startIndex = (requestedPage - 1) * pageSize;
    const pageOfSchemes = searched.slice(startIndex, startIndex + pageSize);

    // Never surface a scheme's project count as-computed from projects the
    // viewer can't browse â€” recompute from only the browsable subset, same
    // enforcement point as getFieldInventory / getProjectUsageReport (PR #19).
    const enrichedPage = await mapWithConcurrency(pageOfSchemes, 8, async (scheme) => {
      const projects = await loadWorkflowSchemeProjects(installationKey, meta.version, scheme.id);
      const browsableProjectIds = await getBrowsableProjectIds(
        context?.accountId,
        projects.map((p) => p.projectId)
      );
      const visibleProjects = projects.filter((p) => browsableProjectIds.has(String(p.projectId)));
      return {
        ...scheme,
        projectCount: visibleProjects.length,
        // The rows are already loaded and permission-filtered to compute the count, so
        // returning them costs nothing and saves the UI a round trip per expanded scheme.
        // Capped because a site-wide default scheme can govern every project, and the
        // expanded panel is a sample rather than an export.
        projects: visibleProjects.slice(0, 60),
        projectsTruncated: visibleProjects.length > 60,
      };
    });

    return {
      schemes: enrichedPage,
      statuses,
      page: requestedPage,
      pageSize,
      totalCount,
      totalPages,
      snapshotStatus,
      statusCounts: {
        hasCurrentCounts,
        hasHistoryCounts,
        historyMeasuredAt: history.measuredAt,
      },
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getWorkflowInventory failed:", error);
    throw error;
  }
}

// Every status id any board column maps, across the whole board estate. Best-effort: null
// (not an empty Set) when no board snapshot exists, so a caller can tell "no board uses
// this" from "boards were never inventoried" -- the same distinction every other cross-
// pillar join in this file makes, and the reason a board-side finding was invisible to the
// status-reachability answer until this existed: an empty result and a missing one used to
// look identical to findOrphanedStatuses.
async function computeBoardStatusIds(installationKey) {
  const boardMeta = await readBoardSnapshotMeta(installationKey).catch(() => null);
  if (!boardMeta?.version) return null;
  const columns = await loadBoardColumns(installationKey, boardMeta.version).catch(() => null);
  if (!columns) return null;
  const ids = new Set();
  for (const col of columns) for (const id of col.statusIds || []) ids.add(String(id));
  return ids;
}

// Governance findings derived from the workflow snapshot: duplicate status names,
// statuses no scheme can reach, and schemes whose category balance looks wrong.
//
// Site-wide analysis rather than a page: every finding needs the whole catalog to be
// computed at all -- you cannot tell a duplicate from a unique name by looking at ten
// rows. The inputs are bounded by the status catalog (hundreds, not millions) and the
// work is pure computation over already-loaded rows, so this stays inside a resolver.
//
// No permission filtering here, deliberately: statuses and schemes are site-level Jira
// configuration, not project data, and this resolver returns no project names or issue
// keys. The per-scheme project counts that DO need filtering live in
// getWorkflowInventory, which enforces them.
// The workflow findings, uncapped: duplicate groups, per-scheme category balance, and the
// orphaned statuses with their automation / board reachability joined in. getWorkflowInsights
// trims these for the tab; remediation reads them whole, so an epic tickets every item its
// finding counts -- from the same computation, never a second derivation of it.
async function computeWorkflowInsightsFull(installationKey, version) {
  const [schemes, statuses, schemeStatuses] = await Promise.all([
    loadWorkflowSchemes(installationKey, version),
    loadStatusesCatalog(installationKey, version),
    loadWorkflowSchemeStatuses(installationKey, version),
  ]);

  // Issue counts are optional. They come from the universe scan, which is versioned
  // independently and may never have run -- an empty map means "unknown", and every
  // downstream claim about a status being safe to delete is suppressed accordingly.
  const issueCounts = await loadStatusIssueCounts(installationKey).catch(fallbackOn("insights.status_counts_load_failed", () => new Map(), { installationKey }));
  const hasIssueCounts = issueCounts.size > 0;

  // "Ever been in" is measured separately from "currently in": the first comes from JQL
  // WAS queries, the second from the universe scan. They refresh independently, so each
  // is reported with its own availability flag rather than assumed to arrive together.
  const history = await loadStatusHistoryCounts(installationKey).catch(fallbackOn("insights.status_history_load_failed", () => ({ counts: new Map(), measuredAt: null }), { installationKey }));
  const hasHistoryCounts = history.counts.size > 0;

  // The scheme->status mapping is best-effort in the build: if the workflow expansion
  // failed, every status looks orphaned and every scheme looks empty. Say so rather
  // than presenting a confidently wrong catalogue of findings.
  const schemeStatusesAvailable = schemeStatuses.length > 0;

  const duplicateGroups = findDuplicateStatusGroups(statuses);
  const balance = schemeStatusesAvailable
    ? computeSchemeCategoryBalance(schemes, schemeStatuses, statuses)
    : [];

  // Which of these statuses an automation rule actually references.
  //
  // The tab has carried a blanket caveat since before the automation pillar existed:
  // "Automation rules are not included. Jira does not expose them to Forge apps." That
  // was true then; it stopped being true when rule exports started being shredded into
  // automation_references, where every status a rule reads, writes or transitions to is a
  // row. A warning that applies to every status tells a reader nothing about any status.
  //
  // Looked up BEFORE the orphan list is built rather than joined onto it afterwards.
  // Joining afterwards meant the per-status answer and the summary disagreed: the rows
  // knew which statuses a rule held open, and summarizeWorkflowInsights -- which the
  // health score reads -- did not, so it counted every one of them as dead configuration.
  //
  // Best-effort: no automation analysis means the caveat is still the honest answer, so
  // failure here degrades to the old warning rather than to a false all-clear.
  //
  // Computed only when the underlying data supports them. Deriving these and then
  // hiding the lists still leaked the numbers into the summary, which rendered
  // "435 unreachable statuses" directly above a warning saying the data was missing.
  const provisionalOrphans = schemeStatusesAvailable
    ? findOrphanedStatuses(statuses, schemeStatuses, hasIssueCounts ? issueCounts : null)
    : [];

  let automationByStatus = null;
  if (provisionalOrphans.length) {
    try {
      automationByStatus = await loadStatusAutomationReferences(
        installationKey,
        provisionalOrphans.map((o) => o.name).filter(Boolean)
      );
    } catch (error) {
      logger.warn("workflow-insights.status_automation_lookup_failed", {
        installationKey, error: String(error?.message || error),
      });
    }
  }

  // Board columns are the other thing that holds a status open with no scheme and no rule
  // touching it -- see computeBoardStatusIds. Best-effort, same reasoning as automation
  // above: no board inventory degrades to "not checked" rather than a false all-clear.
  const boardStatusIds = await computeBoardStatusIds(installationKey).catch((error) => {
    logger.warn("workflow-insights.status_board_lookup_failed", {
      installationKey, error: String(error?.message || error),
    });
    return null;
  });

  const orphans = schemeStatusesAvailable
    ? findOrphanedStatuses(statuses, schemeStatuses, hasIssueCounts ? issueCounts : null, automationByStatus, boardStatusIds)
    : [];

  return {
    schemes, statuses, schemeStatusesAvailable, issueCounts, hasIssueCounts, history, hasHistoryCounts,
    duplicateGroups, balance, orphans, automationByStatus,
  };
}

async function getWorkflowInsights({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    await ensureProjectStoreReady();
    const installationKey = getInstallationKey(context);

    const meta = await readWorkflowSnapshotMeta(installationKey);
    if (!meta?.version) {
      return {
        available: false,
        reason: "no-snapshot",
        snapshotStatus: { state: meta?.state || "idle", refreshedAt: null },
      };
    }

    const {
      statuses, schemeStatusesAvailable, issueCounts, hasIssueCounts, history, hasHistoryCounts,
      duplicateGroups, balance, orphans, automationByStatus,
    } = await computeWorkflowInsightsFull(installationKey, meta.version);
    const orphanPage = orphans.slice(0, 200);

    return {
      available: true,
      schemeStatusesAvailable,
      hasIssueCounts,
      hasHistoryCounts,
      historyMeasuredAt: history.measuredAt,
      summary: summarizeWorkflowInsights({ duplicateGroups, orphans, balance }),
      duplicateGroups: duplicateGroups.slice(0, 100).map((group) => ({
        ...group,
        statuses: group.statuses.map((s) => ({
          statusId: String(s.statusId ?? s.id),
          name: s.name,
          statusCategory: s.statusCategory || null,
          issueCount: hasIssueCounts ? Number(issueCounts.get(String(s.statusId ?? s.id)) ?? 0) : null,
          everCount: hasHistoryCounts ? (history.counts.get(String(s.statusId ?? s.id)) ?? null) : null,
        })),
      })),
      // Already carries automationRuleCount, ruleOnly and a safeToRemove that accounts for
      // rules -- findOrphanedStatuses was given the references above, so there is nothing
      // left to join on here.
      orphans: orphanPage,
      // Whether the per-status answer is available at all, so the tab can drop the blanket
      // warning rather than showing it alongside evidence that contradicts it.
      automationChecked: Boolean(automationByStatus),
      balance: balance.slice(0, 100),
      statusTotals: {
        catalogCount: statuses.length,
        withIssues: hasIssueCounts ? [...issueCounts.values()].filter((n) => n > 0).length : null,
      },
      snapshotStatus: {
        state: meta.state || "idle",
        refreshedAt: meta.refreshedAt || null,
      },
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getWorkflowInsights failed:", error);
    throw error;
  }
}

// ── Macro viewer pillars ──────────────────────────────────────────────────────────────────
//
// The Confluence macro shows a viewer the projects they can Browse and the filters,
// dashboards and workflows attached to those projects -- nothing about a project they cannot
// already see in Jira. Every one of these SHARED resolvers starts from the same browsable
// set, exactly as the macro's Projects tab already does. They carry no governance findings:
// a macro viewer browses, an admin governs.

const MACRO_PILLAR_PAGE_SIZE = 20;

function macroPaginate(rows, page, pageSize = MACRO_PILLAR_PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (current - 1) * pageSize;
  return { slice: rows.slice(start, start + pageSize), page: current, pageSize, totalPages };
}

// The account behind a call, wherever the runtime put it. A resolver invocation carries it
// on context.accountId; a Rovo agent action's context nests it under principal, or -- for an
// agent-identity invocation with no end user -- does not carry one at all.
function callerAccountId(context) {
  return (
    context?.accountId ||
    context?.principal?.accountId ||
    context?.context?.accountId ||
    context?.principal?.id ||
    null
  );
}

// Browse-permission filter that degrades to "trust the snapshot" when there is no caller to
// check against. Observatory is an admin-only app and its snapshots only ever hold what the
// app itself (asApp, broad read scopes) could see, so a Rovo agent action -- which reaches
// here with no user principal -- gets the project set the app already has rather than an
// empty one. Every resolver-driven caller still carries an accountId and stays filtered.
async function browsableOrAll(context, projectIds) {
  const ids = (projectIds || []).map(String);
  const accountId = callerAccountId(context);
  if (!accountId) return new Set(ids);
  return getBrowsableProjectIds(accountId, ids);
}

// The viewer's browsable projects, with both id and key -- filters reference a project by
// KEY (from JQL), dashboard shares and the workflow map by ID.
async function viewerProjects(installationKey, context) {
  const fieldMeta = await readSnapshotMeta(installationKey).catch(() => null);
  if (!fieldMeta?.version) return { available: false, projectIds: new Set(), projectKeys: new Set(), projects: [] };

  const all = await listSnapshotProjects(installationKey, fieldMeta.version).catch(() => []);
  const browsable = await browsableOrAll(context, all.map((p) => p.projectId));
  const projects = all
    .filter((p) => browsable.has(String(p.projectId)))
    .map((p) => ({ projectId: String(p.projectId), projectKey: p.projectKey, projectName: p.projectName }));

  return {
    available: true,
    projectIds: new Set(projects.map((p) => p.projectId)),
    projectKeys: new Set(projects.map((p) => String(p.projectKey || "").toLowerCase())),
    projects,
  };
}

async function getMacroFilters({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const query = String(payload?.query || "").trim().toLowerCase();

  const meta = await readFilterSnapshotMeta(installationKey).catch(
    fallbackOn("macro_filters.meta_read_failed", null, { installationKey })
  );
  const scope = await viewerProjects(installationKey, context);
  if (!meta?.version || !scope.available) {
    return { available: false, reason: "no-inventory", filters: [], projectCount: scope.projects.length, page: 1, pageSize: MACRO_PILLAR_PAGE_SIZE, totalPages: 0, total: 0, matchedTotal: 0 };
  }

  const all = await loadFilters(installationKey, meta.version).catch(() => []);
  const browsableIds = scope.projectIds;

  const mine = all
    .map((f) => {
      // A filter is "in scope" if its JQL names a browsable project, or it is shared to one.
      const refProjects = (f.projectRefs || []).filter((k) => scope.projectKeys.has(String(k).toLowerCase()));
      const sharedToProject = (f.shares || []).some((s) => s.type === "project" && browsableIds.has(String(s.targetId)));
      if (!refProjects.length && !sharedToProject) return null;
      return {
        id: f.id,
        name: f.name,
        jql: f.jql || "",
        owner: f.ownerName || null,
        projects: refProjects,
        fields: f.fieldRefs || [],
        viewUrl: f.viewUrl || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  const matched = query
    ? mine.filter((f) => f.name.toLowerCase().includes(query) || f.jql.toLowerCase().includes(query))
    : mine;
  const { slice, page, pageSize, totalPages } = macroPaginate(matched, payload?.page);

  return {
    available: true,
    filters: slice,
    projectCount: scope.projects.length,
    page, pageSize, totalPages,
    total: mine.length,
    matchedTotal: matched.length,
    snapshotRefreshedAt: meta.refreshedAt || meta.completedAt || null,
  };
}

async function getMacroDashboards({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const query = String(payload?.query || "").trim().toLowerCase();

  const dashMeta = await readDashboardSnapshotMeta(installationKey).catch(
    fallbackOn("macro_dashboards.meta_read_failed", null, { installationKey })
  );
  const scope = await viewerProjects(installationKey, context);
  if (!dashMeta?.version || !scope.available) {
    return { available: false, reason: "no-inventory", dashboards: [], projectCount: scope.projects.length, page: 1, pageSize: MACRO_PILLAR_PAGE_SIZE, totalPages: 0, total: 0, matchedTotal: 0 };
  }

  const filterMeta = await readFilterSnapshotMeta(installationKey).catch(() => null);
  const [all, allFilters] = await Promise.all([
    loadDashboards(installationKey, dashMeta.version).catch(() => []),
    filterMeta?.version ? loadFilters(installationKey, filterMeta.version).catch(() => []) : Promise.resolve([]),
  ]);

  // Filter ids whose JQL names a browsable project -- so a dashboard is in scope if a gadget
  // points at one, not only if the dashboard itself is shared to the project.
  const inScopeFilterIds = new Set(
    allFilters
      .filter((f) => (f.projectRefs || []).some((k) => scope.projectKeys.has(String(k).toLowerCase())))
      .map((f) => String(f.id))
  );
  const fieldsByFilterId = new Map(allFilters.map((f) => [String(f.id), f.fieldRefs || []]));

  const mine = all
    .map((d) => {
      const gadgets = d.gadgets || [];
      const gadgetFilterIds = [...new Set(gadgets.map((g) => g.filterId).filter(Boolean).map(String))];
      const sharedToProject = (d.shares || []).some((s) => s.type === "project" && scope.projectIds.has(String(s.targetId)));
      const backedByScopedFilter = gadgetFilterIds.some((id) => inScopeFilterIds.has(id));
      if (!sharedToProject && !backedByScopedFilter) return null;
      const fields = [...new Set(gadgetFilterIds.flatMap((id) => fieldsByFilterId.get(id) || []))].sort();
      return {
        id: d.id,
        name: d.name,
        owner: d.ownerName || null,
        gadgetCount: d.gadgetCount ?? gadgets.length,
        fields,
        sharedToProject,
        viewUrl: d.viewUrl || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  const matched = query
    ? mine.filter((d) => d.name.toLowerCase().includes(query) || d.fields.some((x) => x.toLowerCase().includes(query)))
    : mine;
  const { slice, page, pageSize, totalPages } = macroPaginate(matched, payload?.page);

  return {
    available: true,
    dashboards: slice,
    projectCount: scope.projects.length,
    fieldsResolved: Boolean(filterMeta?.version),
    page, pageSize, totalPages,
    total: mine.length,
    matchedTotal: matched.length,
    snapshotRefreshedAt: dashMeta.refreshedAt || dashMeta.completedAt || null,
  };
}

// -- Three more macro pillars, all scoped the same way -----------------------
//
// The macro browses and reports; the admin page governs. That split is deliberate and these
// keep it -- they carry inventory and no governance findings, because a finding is a
// judgement an admin acts on and a viewer cannot.
//
// What they do NOT carry is just as deliberate. Access schemes, the people roster, Assets
// and the automation findings stay admin-only: the first two are a disclosure risk in a
// panel anyone in Confluence can open, and automation findings include plaintext-credential
// hits, which is the last thing to put on a wiki page.
//
// Every one filters through viewerProjects, so a viewer sees their own estate and is told
// so, rather than seeing the site's and wondering which half is theirs.

async function getMacroScreens({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readScreenSnapshotMeta(installationKey).catch(
    fallbackOn("macro_screens.meta_read_failed", null, { installationKey })
  );
  const scope = await viewerProjects(installationKey, context);
  if (!meta?.version || !scope.available) {
    return { available: false, reason: "no-inventory", projects: [], projectCount: scope.projects.length };
  }

  const rows = await loadScreensForProjects(installationKey, meta.version, [...scope.projectIds])
    .catch(fallbackOn("macro_screens.load_failed", [], { installationKey }));

  const byProject = new Map(scope.projects.map((p) => [p.projectId, { ...p, screens: [] }]));
  for (const row of rows) {
    const entry = byProject.get(row.projectId);
    if (!entry) continue;
    entry.screens.push({
      screenId: row.screenId,
      name: row.name,
      fieldCount: row.fieldCount,
      tabCount: row.tabCount,
      // "Could not be read" is not "has no fields". The viewer is the person about to ask
      // why their form looks different, so the distinction has to survive to the panel.
      unreadable: row.tabsResolved !== "resolved",
      operations: [row.onCreate && "create", row.onEdit && "edit", row.onView && "view"].filter(Boolean),
    });
  }

  const projects = [...byProject.values()]
    .map((p) => ({
      ...p,
      screens: p.screens.sort((a, b) => b.fieldCount - a.fieldCount || a.name.localeCompare(b.name)),
      // The number anyone actually came to argue about: how long the form is that every
      // person filing an issue here has to get through.
      createFieldCount: p.screens.filter((s) => s.operations.includes("create"))
        .reduce((n, s) => Math.max(n, s.fieldCount), 0),
    }))
    .sort((a, b) => b.createFieldCount - a.createFieldCount || a.projectKey.localeCompare(b.projectKey));

  return {
    available: true,
    refreshedAt: meta.refreshedAt || null,
    projectCount: projects.length,
    projects,
  };
}

async function getMacroIssueTypes({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readIssueTypeSnapshotMeta(installationKey).catch(
    fallbackOn("macro_issue_types.meta_read_failed", null, { installationKey })
  );
  const scope = await viewerProjects(installationKey, context);
  if (!meta?.version || !scope.available) {
    return { available: false, reason: "no-inventory", schemes: [], projectCount: scope.projects.length };
  }

  const [types, items, schemeProjects, schemes] = await Promise.all([
    loadIssueTypes(installationKey, meta.version).catch(() => []),
    loadIssueTypeSchemeItems(installationKey, meta.version).catch(() => []),
    loadIssueTypeSchemeProjects(installationKey, meta.version).catch(() => []),
    loadIssueTypeSchemes(installationKey, meta.version).catch(() => []),
  ]);
  // The project rows carry no scheme name, so it comes from the scheme table. Falling back
  // to the id would show a viewer a number where a name belongs.
  const schemeNameById = new Map(schemes.map((sc) => [String(sc.schemeId), sc.name]));

  const typeById = new Map(types.map((t) => [String(t.id), t]));
  const membersByScheme = new Map();
  for (const item of items) {
    if (!membersByScheme.has(item.schemeId)) membersByScheme.set(item.schemeId, []);
    const type = typeById.get(String(item.issueTypeId));
    membersByScheme.get(item.schemeId).push({
      id: item.issueTypeId,
      name: type?.name || null,
      subtask: type?.subtask ?? null,
      // A scheme naming a type the catalogue no longer holds is worth showing, not hiding.
      missing: !type,
    });
  }

  // Grouped by scheme rather than listed per project: projects sharing a scheme are meant to
  // run the same set, so the grouping IS the information -- and a project sitting alone in a
  // group is the question worth asking.
  const bySchemeId = new Map();
  for (const row of schemeProjects) {
    if (!scope.projectIds.has(String(row.projectId))) continue;
    const key = String(row.schemeId);
    if (!bySchemeId.has(key)) {
      bySchemeId.set(key, {
        schemeId: key,
        name: schemeNameById.get(key) || key,
        projects: [],
        issueTypes: membersByScheme.get(row.schemeId) || [],
      });
    }
    bySchemeId.get(key).projects.push(row.projectKey);
  }

  const grouped = [...bySchemeId.values()]
    .map((s) => ({ ...s, projects: s.projects.sort() }))
    .sort((a, b) => b.projects.length - a.projects.length || a.name.localeCompare(b.name));

  return {
    available: true,
    refreshedAt: meta.refreshedAt || null,
    projectCount: scope.projects.length,
    schemes: grouped,
  };
}

async function getMacroBoards({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readBoardSnapshotMeta(installationKey).catch(
    fallbackOn("macro_boards.meta_read_failed", null, { installationKey })
  );
  const scope = await viewerProjects(installationKey, context);
  if (!meta?.version || !scope.available) {
    return { available: false, reason: "no-inventory", boards: [], projectCount: scope.projects.length };
  }

  const all = await loadBoards(installationKey, meta.version)
    .catch(fallbackOn("macro_boards.load_failed", [], { installationKey }));

  const keyById = new Map(scope.projects.map((p) => [p.projectId, p.projectKey]));
  const boards = all
    .filter((b) => b.locationType === "project" && scope.projectIds.has(String(b.locationId)))
    .map((b) => ({
      boardId: b.boardId,
      name: b.name,
      type: b.type,
      projectKey: keyById.get(String(b.locationId)) || b.locationKey || null,
      columnCount: b.columnCount,
      // The one fact a viewer can act on without being an admin: a board whose configuration
      // could not be read -- team-managed boards routinely 404 -- shows them something this
      // page cannot describe, and saying so is the only honest option.
      configReadable: b.configReadable,
    }))
    .sort((a, b) => String(a.projectKey || "").localeCompare(String(b.projectKey || "")) || a.name.localeCompare(b.name));

  return {
    available: true,
    refreshedAt: meta.refreshedAt || null,
    projectCount: scope.projects.length,
    boards,
  };
}

async function getMacroWorkflows({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readWorkflowSnapshotMeta(installationKey).catch(
    fallbackOn("macro_workflows.meta_read_failed", null, { installationKey })
  );
  const scope = await viewerProjects(installationKey, context);
  if (!meta?.version || !scope.available) {
    return { available: false, reason: "no-inventory", schemes: [], statuses: [], projectCount: scope.projects.length };
  }

  const [schemeMap, schemeStatuses, catalog] = await Promise.all([
    loadProjectWorkflowSchemeMap(installationKey, meta.version).catch(() => new Map()),
    loadWorkflowSchemeStatuses(installationKey, meta.version).catch(() => []),
    loadStatusesCatalog(installationKey, meta.version).catch(() => []),
  ]);

  // scheme id -> its statuses
  const statusIdsByScheme = new Map();
  for (const { schemeId, statusId } of schemeStatuses) {
    if (!statusIdsByScheme.has(schemeId)) statusIdsByScheme.set(schemeId, new Set());
    statusIdsByScheme.get(schemeId).add(String(statusId));
  }
  const statusName = new Map(catalog.map((s) => [String(s.id), s]));

  // The browsable projects, grouped by the workflow scheme they run.
  const bySchemeId = new Map();
  for (const project of scope.projects) {
    const mapped = schemeMap.get(String(project.projectId));
    if (!mapped) continue;
    const key = String(mapped.schemeId);
    if (!bySchemeId.has(key)) {
      bySchemeId.set(key, { schemeId: key, name: mapped.name || key, projects: [], statuses: [] });
    }
    bySchemeId.get(key).projects.push(project.projectKey);
  }

  const usedStatusIds = new Set();
  const schemes = [...bySchemeId.values()].map((s) => {
    const ids = [...(statusIdsByScheme.get(s.schemeId) || [])];
    ids.forEach((id) => usedStatusIds.add(id));
    return {
      ...s,
      projects: s.projects.sort(),
      statuses: ids
        .map((id) => statusName.get(id))
        .filter(Boolean)
        .map((st) => ({ id: String(st.id), name: st.name, category: st.statusCategory || "Uncategorised" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }).sort((a, b) => b.projects.length - a.projects.length || a.name.localeCompare(b.name));

  // The de-duplicated status list across every scheme the viewer's projects run.
  const statuses = [...usedStatusIds]
    .map((id) => statusName.get(id))
    .filter(Boolean)
    .map((st) => ({ id: String(st.id), name: st.name, category: st.statusCategory || "Uncategorised" }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    available: true,
    schemes,
    statuses,
    projectCount: scope.projects.length,
    snapshotRefreshedAt: meta.refreshedAt || meta.completedAt || null,
  };
}


// Governance findings over the site's automation rules.
//
// Admin-only, unlike getWorkflowInsights. Workflow insights describe configuration shared
// with every user; this returns rule names, the projects they act on, and the external
// hosts they post to -- an inventory of the site's outbound integrations, which is not
// something an arbitrary authenticated user should be able to enumerate.
//
// Reads the stored analysis rather than computing one. Deriving it needs every rule, and
// the rules are neither held here nor cheap to fetch; the build path writes the document
// this reads. No document means the analysis has never been built, which is the normal
// state on a fresh install and renders as an empty state rather than an error.
// ── Screen and scheme inventory ──────────────────────────────────────────────

// Read path for the Screens surface. Mirrors getWorkflowInventory: one call returns the
// meta, a page of screens, and the two scheme layers, so the tab renders from a single
// round trip rather than four.
async function getScreenInventory({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readScreenSnapshotMeta(installationKey);
  const staleBuild = isScreenBuildStale(meta);

  // No snapshot has ever completed. Report that plainly rather than returning empty rows
  // that read as "this site has no screens" -- the two are opposite claims.
  if (!meta?.version) {
    return {
      state: meta?.state || "idle",
      staleBuild,
      // Carried even with no version: the first build runs for minutes before it produces
      // one, and the UI needs something to show for that time other than "nothing here".
      startedAt: meta?.startedAt || null,
      version: null,
      screens: { total: 0, rows: [] },
      screenSchemes: [],
      schemeOperations: [],
      issueTypeScreenSchemes: [],
      lastError: meta?.lastError || null,
      neverBuilt: true,
    };
  }

  const page = Math.max(1, Number(payload?.page) || 1);
  const pageSize = Math.max(1, Math.min(100, Number(payload?.pageSize) || 25));
  const search = optionalString(payload?.search, "search") || "";

  // The workflow snapshot's version, for the transition layer. Screens and workflows
  // rebuild independently, so this is resolved per request rather than assumed to match.
  const workflowMeta = await readWorkflowSnapshotMeta(installationKey).catch(() => null);

  const [screens, screenSchemes, schemeOperations, issueTypeScreenSchemes, distributions, governance, transitionScreens] = await Promise.all([
    loadScreensPage(installationKey, meta.version, {
      limit: pageSize,
      offset: (page - 1) * pageSize,
      search,
      // Passed straight through; the store whitelists it. Sorting has to happen in SQL
      // because the tab shows 25 of ~760 screens -- sorting the page in the browser would
      // reorder an arbitrary slice and present it as the top of the catalog.
      sort: optionalString(payload?.sort, "sort") || DEFAULT_SCREEN_SORT,
      // Which finding the reader arrived from, if they arrived from one. Whitelisted by the
      // store, and dropped there when it needs a workflow snapshot that does not exist --
      // the result says which of those happened rather than silently showing everything.
      filter: optionalString(payload?.filter, "filter") || null,
      workflowVersion: transitionAwareWorkflowVersion(workflowMeta),
    }),
    loadScreenSchemes(installationKey, meta.version),
    loadScreenSchemeOperations(installationKey, meta.version),
    loadIssueTypeScreenSchemes(installationKey, meta.version),
    loadScreenDistributions(installationKey, meta.version),
    loadScreenGovernanceSummary(installationKey, meta.version, { workflowVersion: transitionAwareWorkflowVersion(workflowMeta) }),
    workflowMeta?.version
      ? loadTransitionScreens(installationKey, workflowMeta.version)
      : Promise.resolve([]),
  ]);

  return {
    state: meta.state,
    staleBuild,
    startedAt: meta.startedAt || null,
    version: meta.version,
    refreshedAt: meta.refreshedAt,
    completedAt: meta.completedAt,
    totalScreens: meta.totalScreens,
    totalSchemes: meta.totalSchemes,
    // Surfaced at the top level, not buried in the rows. A pass that could not read part
    // of the catalog caps every finding built on it, and the reader needs that before the
    // numbers rather than after.
    unresolvedScreens: meta.unresolvedScreens,
    lastError: meta.lastError || null,
    page,
    pageSize,
    // Echoed back so the toolbar reflects what the rows were actually ordered by,
    // including when an unrecognised token fell back to the default.
    sort: SCREEN_SORT_KEYS.includes(String(payload?.sort || "")) ? String(payload.sort) : DEFAULT_SCREEN_SORT,
    screens,
    screenSchemes,
    schemeOperations,
    issueTypeScreenSchemes,
    // The second route to a screen. Sent whole rather than per screen: the list is bounded
    // by transitions-that-open-a-screen, which is far smaller than the screen catalog, and
    // the tab groups it by screen client-side to avoid a query per expanded row.
    // Aggregates for the tab's own overview, so it stops being a list with no summary.
    distributions,
    governance,
    transitionScreens,
    // Three states, not two. A workflow snapshot EXISTING is not the same as that snapshot
    // having looked for transition screens: every inventory built before the capture shipped
    // has none recorded, and reporting that as "no transition opens a screen" states a fact
    // the build never established. transitionScreens is null on those, a number on the rest.
    transitionsAvailable: workflowMeta?.transitionScreens != null,
    transitionsReason: workflowMeta?.version && workflowMeta.transitionScreens == null
      ? "The last workflow build could not read this site's workflows, so which screens transitions open is unknown. Screens are not called unreached until it can. Rebuild from the Workflows tab; if this persists, check the build's log for the workflow read error."
      : null,
    neverBuilt: false,
  };
}

// Screen counts for a page of fields, for the chip on each Field Browser card.
//
// Mirrors getAutomationFieldCounts, including its posture on a missing snapshot: reports
// available: false rather than a map of zeroes, because "no screen inventory" and "this
// field is on no screen" are opposite claims and the second is a premise for deleting it.
async function getFieldScreenCounts({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readScreenSnapshotMeta(installationKey);
  if (!meta?.version) {
    return { available: false, reason: "No screen inventory has been built yet.", counts: {} };
  }

  const fieldIds = Array.isArray(payload?.fieldIds) ? payload.fieldIds.slice(0, 500) : [];
  return {
    available: true,
    version: meta.version,
    refreshedAt: meta.refreshedAt,
    // Carried with the counts so a card can caveat its own number: a build that could not
    // read 30 screens cannot claim a field is on none of them.
    unresolvedScreens: meta.unresolvedScreens,
    counts: await loadScreenCountsForFields(installationKey, meta.version, fieldIds),
  };
}

// Which screens carry one field, for the field detail panel.
async function getFieldScreenReachability({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const fieldId = requireNonEmptyString(payload?.fieldId, "fieldId");

  const meta = await readScreenSnapshotMeta(installationKey);
  if (!meta?.version) {
    // Tri-state again: "no screen snapshot" is not "this field is on no screen", and the
    // second is the premise of a delete recommendation.
    return { available: false, reason: "No screen inventory has been built yet.", screens: [] };
  }

  return {
    available: true,
    version: meta.version,
    refreshedAt: meta.refreshedAt,
    unresolvedScreens: meta.unresolvedScreens,
    screens: await loadScreensForField(installationKey, meta.version, fieldId),
  };
}

async function buildScreenInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readScreenSnapshotMeta(installationKey);
  // Suppress only a build that is both building AND not stale. A wedged row would
  // otherwise block every future rebuild with no way out of the UI.
  if (meta?.state === "building" && !isScreenBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before building the screen inventory." };
  }

  await queueScreenSnapshotBuild(installationKey);
  return { queued: true };
}

// Read path for the Issue Types surface. Mirrors getScreenInventory: one call returns the
// meta, the type catalog grouped by hierarchy level, the schemes with their ordered
// membership resolved, and -- best-effort from the screen snapshot -- the issue-type ->
// screen-scheme routing layer, so the tab renders from a single round trip.
async function getIssueTypeInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readIssueTypeSnapshotMeta(installationKey);
  const staleBuild = isIssueTypeBuildStale(meta);

  // No snapshot has ever completed. Report that plainly rather than empty lists that read
  // as "this site has no issue types" -- the opposite claim.
  if (!meta?.version) {
    return {
      state: meta?.state || "idle",
      staleBuild,
      startedAt: meta?.startedAt || null,
      version: null,
      issueTypes: [],
      hierarchy: [],
      schemes: [],
      governance: null,
      issueTypeScreenSchemes: [],
      lastError: meta?.lastError || null,
      neverBuilt: true,
    };
  }

  const [issueTypes, schemes, schemeItems, schemeProjects, governance] = await Promise.all([
    loadIssueTypes(installationKey, meta.version),
    loadIssueTypeSchemes(installationKey, meta.version),
    loadIssueTypeSchemeItems(installationKey, meta.version),
    loadIssueTypeSchemeProjects(installationKey, meta.version),
    loadIssueTypeGovernanceSummary(installationKey, meta.version),
  ]);

  const typeById = new Map(issueTypes.map((t) => [String(t.id), t]));

  // Group the catalog by Jira's hierarchy level, highest first (Epic and any custom levels
  // above it, then base, then sub-task at -1). The level number is carried alongside the
  // label so the tab does not have to hard-code a mapping that a custom hierarchy breaks.
  const byLevel = new Map();
  for (const type of issueTypes) {
    const level = Number(type.hierarchyLevel) || 0;
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(type);
  }
  const hierarchyRaw = [...byLevel.keys()]
    .sort((a, b) => b - a)
    .map((level) => ({
      level,
      label: HIERARCHY_LEVEL_LABELS[level] || (level < 0 ? "Sub-task" : `Level ${level}`),
      types: byLevel.get(level),
    }));

  // Resolve each scheme's ordered membership against the catalog. A member id the catalog
  // does not contain is kept with a null name rather than dropped: a scheme allowing a type
  // that no longer exists is a finding, not noise.
  const membersByScheme = new Map();
  for (const item of schemeItems) {
    if (!membersByScheme.has(item.schemeId)) membersByScheme.set(item.schemeId, []);
    const type = typeById.get(String(item.issueTypeId));
    membersByScheme.get(item.schemeId).push({
      id: item.issueTypeId,
      name: type?.name || null,
      hierarchyLevel: type?.hierarchyLevel ?? null,
      subtask: type?.subtask ?? null,
      missing: !type,
    });
  }
  const projectsByScheme = new Map();
  for (const row of schemeProjects) {
    if (!projectsByScheme.has(row.schemeId)) projectsByScheme.set(row.schemeId, []);
    projectsByScheme.get(row.schemeId).push({
      projectId: row.projectId,
      projectKey: row.projectKey,
      projectName: row.projectName,
    });
  }
  const schemesResolved = schemes.map((s) => ({
    ...s,
    defaultIssueTypeName: s.defaultIssueTypeId ? (typeById.get(String(s.defaultIssueTypeId))?.name || null) : null,
    issueTypes: membersByScheme.get(s.schemeId) || [],
    projects: (projectsByScheme.get(s.schemeId) || []).sort((a, b) => a.projectKey.localeCompare(b.projectKey)),
  }));

  // The tier below: issue-type -> screen-scheme routing, from the screen snapshot. Sent so
  // the tab can show, per issue type screen scheme, which screen scheme each type resolves
  // to. Best-effort -- the screen pillar refreshes on its own cadence and may not have run.
  let issueTypeScreenSchemes = [];
  try {
    const screenMeta = await readScreenSnapshotMeta(installationKey);
    if (screenMeta?.version) {
      const [itss, itssMappings] = await Promise.all([
        loadIssueTypeScreenSchemes(installationKey, screenMeta.version),
        loadItssMappings(installationKey, screenMeta.version),
      ]);
      const mappingsByItss = new Map();
      for (const m of itssMappings) {
        if (!mappingsByItss.has(m.itssId)) mappingsByItss.set(m.itssId, []);
        mappingsByItss.get(m.itssId).push({
          issueTypeId: m.issueTypeId,
          issueTypeName: m.issueTypeId === "default" ? "All unmapped types" : (typeById.get(String(m.issueTypeId))?.name || null),
          screenSchemeId: m.screenSchemeId,
          isDefault: m.isDefault,
        });
      }
      issueTypeScreenSchemes = itss.map((s) => ({
        ...s,
        mappings: mappingsByItss.get(s.itssId) || [],
      }));
    }
  } catch (error) {
    // A screen-snapshot read failing must not take the issue-type tab down with it.
    console.error("getIssueTypeInventory: screen-scheme layer unavailable:", error?.message || error);
  }

  // Per-type issue counts from the crawl, and the tri-state that makes them safe to read.
  //
  // Zero is what makes a type look safe to delete, so it is only ever asserted when a crawl
  // actually completed. Three outcomes, never collapsed into two:
  //   measured     a full scan finished and this type has a count (possibly a real zero)
  //   not-measured no crawl has completed, so no type has a count
  //   partial      a crawl ran but did not finish, so a missing row means "not reached",
  //                not "nobody uses it"
  const usage = await (async () => {
    try {
      const scanMeta = await readIssueScanMeta(installationKey);
      const state = scanMeta?.state || null;
      if (state !== "ready" && state !== "building" && state !== "failed") {
        return { measurement: "not-measured", byType: new Map(), measuredAt: null };
      }
      const rows = await loadIssueTypeTotals(installationKey);
      if (!rows.length && state !== "ready") {
        return { measurement: "not-measured", byType: new Map(), measuredAt: null };
      }
      return {
        // A crawl that is still running, or that failed part-way, has counted SOME projects.
        // Calling that "measured" would report a half-walked estate's silence as evidence.
        measurement: state === "ready" ? "measured" : "partial",
        byType: new Map(rows.map((r) => [String(r.issueTypeId), r])),
        measuredAt: scanMeta?.completedAt || null,
      };
    } catch (error) {
      // A counting failure is not a count of zero -- the distinction CONNECT-4091 exists for.
      console.error("getIssueTypeInventory: usage unavailable:", error?.message || error);
      return { measurement: "measurement-failed", byType: new Map(), measuredAt: null };
    }
  })();

  const withUsage = (type) => {
    const row = usage.byType.get(String(type.id));
    return {
      ...type,
      // null, not 0, wherever the count is not evidence. The tab renders the three states
      // differently and must never show a dash as a zero.
      issueCount: usage.measurement === "measured" ? (row?.issueCount ?? 0) : (row?.issueCount ?? null),
      usedInProjects: row?.projectCount ?? null,
    };
  };

  return {
    state: meta.state,
    staleBuild,
    startedAt: meta.startedAt || null,
    version: meta.version,
    refreshedAt: meta.refreshedAt,
    completedAt: meta.completedAt,
    usage: { measurement: usage.measurement, measuredAt: usage.measuredAt },
    totalTypes: meta.totalTypes,
    totalSchemes: meta.totalSchemes,
    lastError: meta.lastError || null,
    issueTypes: issueTypes.map(withUsage),
    hierarchy: hierarchyRaw.map((h) => ({ ...h, types: h.types.map(withUsage) })),
    schemes: schemesResolved,
    governance,
    // The finding-shaped detail behind the governance counts: near-duplicate name groups,
    // the orphan list, and the schemes whose type set does not hang together. Computed from
    // the rows already loaded above so the tab renders findings without a second round trip.
    governanceFindings: summarizeIssueTypeInsights({ types: issueTypes, schemes, schemeItems }),
    issueTypeScreenSchemes,
    neverBuilt: false,
  };
}

async function buildIssueTypeInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readIssueTypeSnapshotMeta(installationKey);
  // Suppress only a build that is both building AND not stale, matching buildScreenInventory:
  // a wedged row must never block every future rebuild with no way out of the UI.
  if (meta?.state === "building" && !isIssueTypeBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before building the issue type inventory." };
  }

  await queueIssueTypeSnapshotBuild(installationKey);
  return { queued: true };
}

// The People pillar's read: the licensed-user roster with each user's products and access
// groups, plus the site's own seat numbers for the header.
async function getUserInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readUserSnapshotMeta(installationKey);
  const staleBuild = isUserBuildStale(meta);

  if (!meta?.version) {
    return {
      state: meta?.state || "idle",
      staleBuild,
      startedAt: meta?.startedAt || null,
      version: null,
      users: [],
      applicationSummary: [],
      governance: null,
      lastError: meta?.lastError || null,
      neverBuilt: true,
    };
  }

  const [users, governance, ownership, ruleUserIndex] = await Promise.all([
    loadUsers(installationKey, meta.version),
    loadUserGovernanceSummary(installationKey, meta.version),
    buildOwnershipIndex(installationKey).catch(() => ({ byAccount: new Map(), available: {} })),
    readAutomationPart(installationKey, "users").catch(() => null),
  ]);

  // accountId -> how many DISTINCT rules name this person. Built once from the automation
  // user index so the roster can show it without a per-user lookup.
  const ruleRefCountByAccount = new Map();
  for (const entry of ruleUserIndex?.entries ?? []) {
    const ids = new Set([...(entry.write ?? []), ...(entry.read ?? []), ...(entry.trigger ?? [])]);
    ruleRefCountByAccount.set(String(entry.label), ids.size);
  }

  const rosterIds = activeRosterIds(users);
  // Last activity and the dormant flag per account -- the same classification the score uses,
  // so the roster lists exactly the accounts the dormant-licences dimension counted.
  const activity = classifyUserActivity(
    users,
    await loadUserActivity(installationKey, [...rosterIds]).catch(fallbackOn("people.activity_load_failed", () => [], { installationKey }))
  );
  const withOwnership = users.map((u) => {
    const owned = ownership.byAccount.get(u.accountId);
    const act = activity.byAccount.get(String(u.accountId));
    return {
      ...u,
      ownedFilters: owned?.filters.length ?? 0,
      ownedDashboards: owned?.dashboards.length ?? 0,
      authoredRules: owned?.rules.length ?? 0,
      automationRefs: ruleRefCountByAccount.get(u.accountId) ?? 0,
      lastActivityAt: act?.lastActivityAt ?? null,
      // true / false where the crawl measured the account, null where it did not.
      dormant: act?.dormant ?? null,
    };
  });

  const orphaned = summarizeOrphanedOwnership(ownership, rosterIds);

  // People an automation rule names who are not on the licensed roster -- a rule assigning
  // work to a deactivated or unlicensed account. Estate-level count; the People tab lists
  // them per rule from getUserDetails.
  let automationRefUsers = 0;
  let orphanedAutomationRefUsers = 0;
  for (const accountId of ruleRefCountByAccount.keys()) {
    automationRefUsers += 1;
    if (!rosterIds.has(accountId)) orphanedAutomationRefUsers += 1;
  }

  return {
    state: meta.state || "ready",
    staleBuild,
    startedAt: meta.startedAt || null,
    refreshedAt: meta.refreshedAt || null,
    version: meta.version,
    users: withOwnership,
    applicationSummary: meta.applicationSummary || [],
    governance: {
      ...governance, ...orphaned, automationRefUsers, orphanedAutomationRefUsers,
      activityMeasured: activity.measured,
      measuredAccounts: activity.measuredAccounts,
      dormantAccounts: activity.dormantAccounts,
      dormantAfterDays: activity.dormantAfterDays,
    },
    automationRefsAvailable: Boolean(ruleUserIndex),
    ownershipAvailable: ownership.available,
    lastError: meta.lastError || null,
    neverBuilt: false,
  };
}

// One user's full cross-pillar footprint: products, groups, and the filters, dashboards and
// automation rules they own. The roster gives counts; this gives the lists.
async function getUserDetails({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const accountId = String(payload?.accountId || "");
  if (!accountId) throw new Error("accountId is required");

  const meta = await readUserSnapshotMeta(installationKey);
  if (!meta?.version) return { available: false, reason: "no-roster" };

  const [fieldMeta, accessMeta] = await Promise.all([
    readSnapshotMeta(installationKey).catch(() => null),
    readAccessSnapshotMeta(installationKey).catch(() => null),
  ]);

  const [users, ownership, ruleUserIndex, ruleDirectoryDoc, fieldAppearanceRows, grantedBySchemes] = await Promise.all([
    loadUsers(installationKey, meta.version),
    buildOwnershipIndex(installationKey).catch(() => ({ byAccount: new Map(), available: {} })),
    readAutomationPart(installationKey, "users").catch(() => null),
    readAutomationPart(installationKey, "directory").catch(() => null),
    fieldMeta?.version
      ? loadUserFieldAppearances(installationKey, fieldMeta.version, accountId).catch(() => [])
      : Promise.resolve([]),
    accessMeta?.version
      ? loadSchemesGrantingHolder(installationKey, accessMeta.version, "user", accountId).catch(() => [])
      : Promise.resolve([]),
  ]);

  const user = users.find((u) => u.accountId === accountId) || null;
  const owned = ownership.byAccount.get(accountId) || { filters: [], dashboards: [], rules: [] };

  // Grants via GROUP membership, not just a direct grant on the account. This is the common
  // case, not the edge case: a permission or notification scheme naming a person directly is
  // the anti-pattern the comment below calls out, but most real grants run through a group,
  // and grantedBySchemes above -- holder_type = "user" only -- could not see a single one of
  // them. A scheme granting to "jira-administrators" was invisible here even for an account
  // that IS one, which is exactly the footprint this resolver exists to show.
  let grantedByGroups = [];
  if (accessMeta?.version && user?.groups?.length) {
    const perGroup = await Promise.all(
      user.groups.map((g) =>
        loadSchemesGrantingHolder(installationKey, accessMeta.version, "group", g.id)
          .then((rows) => rows.map((r) => ({ ...r, viaGroup: g.name || g.id })))
          .catch(() => [])
      )
    );
    grantedByGroups = perGroup.flat();
  }

  // The rules that NAME this person -- assign to them, condition on them being the assignee,
  // set a user field to their account. Distinct from authoredRules (rules they own): a
  // deactivated account can still be the assignee half a dozen rules route work to.
  const referencedInRules = collectRuleUserReferences(accountId, ruleUserIndex, ruleDirectoryDoc);

  // The user-picker fields this account holds a value in, from the last full crawl. Names
  // joined from the field snapshot. Empty until a scan has run since this feature landed.
  let fieldAppearances = [];
  if (fieldAppearanceRows.length && fieldMeta?.version) {
    const names = await loadSnapshotFieldNames(installationKey, fieldMeta.version, fieldAppearanceRows.map((r) => r.fieldId)).catch(() => new Map());
    fieldAppearances = fieldAppearanceRows.map((r) => ({
      fieldId: r.fieldId,
      fieldName: names.get(r.fieldId) || r.fieldId,
      issueCount: r.issueCount,
    }));
  }

  return {
    available: true,
    inRoster: Boolean(user),
    user: user || { accountId, displayName: accountId, applications: [], groups: [], active: null },
    ownedFilters: owned.filters,
    ownedDashboards: owned.dashboards,
    authoredRules: owned.rules,
    referencedInRules,
    fieldAppearances,
    // Permission grants, security-level memberships and notification recipients that name
    // this account directly (a direct grant is an anti-pattern -- it should be a role).
    grantedBySchemes,
    // The same, via a group this account belongs to. Each entry carries which group earned
    // it (viaGroup), because "you have this via jira-administrators" and "you have this via
    // marketing-contractors" are different facts even when the scheme is the same one.
    grantedByGroups,
    automationRefsAvailable: Boolean(ruleUserIndex),
    fieldAppearancesAvailable: Boolean(fieldMeta?.version),
    accessGrantsAvailable: Boolean(accessMeta?.version),
    ownershipAvailable: ownership.available,
  };
}

// One account's entry in the automation user index, joined to rule names. `direction` is
// "write" when a rule assigns/sets the account and "read" when it only conditions on it --
// the write side is what breaks loudest if the account goes away.
function collectRuleUserReferences(accountId, userIndex, directoryDoc) {
  const entry = (userIndex?.entries ?? []).find((e) => String(e.label) === String(accountId));
  if (!entry) return [];
  const names = directoryDoc ? hydrateRuleDirectory(directoryDoc) : new Map();
  const byId = new Map();
  for (const direction of ["write", "read", "trigger"]) {
    for (const ruleId of entry[direction] ?? []) {
      const existing = byId.get(ruleId);
      const rule = names.get(ruleId);
      if (existing) {
        if (direction === "write") existing.direction = "write";
      } else {
        byId.set(ruleId, {
          id: ruleId,
          name: rule?.name || `Rule ${ruleId}`,
          enabled: rule?.enabled ?? null,
          direction,
        });
      }
    }
  }
  return [...byId.values()];
}

async function buildUserInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readUserSnapshotMeta(installationKey);
  if (meta?.state === "building" && !isUserBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before building the people inventory." };
  }

  await queueUserSnapshotBuild(installationKey);
  return { queued: true };
}

// The JSM Assets (CMDB) pillar's read: object schemas, their object types and those types'
// attributes, plus the governance summary. `assetsEnabled: false` is a first-class state --
// the build ran and Assets is not licensed here -- and the tab renders the explanation
// rather than an empty catalogue.
async function getAssetInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readAssetSnapshotMeta(installationKey);
  const staleBuild = isAssetBuildStale(meta);

  if (meta?.state === "unavailable") {
    return {
      state: "unavailable",
      assetsEnabled: false,
      staleBuild: false,
      refreshedAt: meta?.refreshedAt || null,
      workspaceId: meta?.workspaceId || null,
      schemas: [],
      objectTypes: [],
      attributes: [],
      governance: summarizeAssetInsights({ assetsEnabled: false }),
      lastError: meta?.lastError || null,
      neverBuilt: false,
    };
  }

  if (!meta?.version) {
    return {
      state: meta?.state || "idle",
      assetsEnabled: null,
      staleBuild,
      startedAt: meta?.startedAt || null,
      version: null,
      schemas: [],
      objectTypes: [],
      attributes: [],
      governance: null,
      lastError: meta?.lastError || null,
      neverBuilt: true,
    };
  }

  const [schemas, objectTypes, attributes, typeCounts, countMeta] = await Promise.all([
    loadAssetSchemas(installationKey, meta.version),
    loadAssetObjectTypes(installationKey, meta.version),
    loadAssetAttributes(installationKey, meta.version),
    loadAssetTypeCounts(installationKey),
    readAssetTypeCountMeta(installationKey),
  ]);

  const governance = summarizeAssetInsights({ schemas, objectTypes, attributes, typeCounts, assetsEnabled: true });

  return {
    state: meta.state || "ready",
    assetsEnabled: true,
    staleBuild,
    startedAt: meta.startedAt || null,
    refreshedAt: meta.refreshedAt || null,
    version: meta.version,
    workspaceId: meta.workspaceId || null,
    schemas,
    objectTypes,
    attributes,
    // Keyed by objectTypeId so the tab can join it onto the type list it already has,
    // rather than requiring a second round trip once someone has run the crawl.
    typeCounts,
    governance,
    lastError: meta.lastError || null,
    neverBuilt: false,
    typeCountCrawl: {
      state: countMeta?.state || "idle",
      staleBuild: isAssetTypeCountBuildStale(countMeta),
      refreshedAt: countMeta?.refreshedAt || null,
      measuredTypes: countMeta?.measuredTypes || 0,
      unmeasuredTypes: countMeta?.unmeasuredTypes || 0,
      lastError: countMeta?.lastError || null,
    },
  };
}

async function buildAssetInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readAssetSnapshotMeta(installationKey);
  if (meta?.state === "building" && !isAssetBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before building the Assets inventory." };
  }

  await queueAssetSnapshotBuild(installationKey);
  return { queued: true };
}

// The object-count crawl: a separate job from the structure build, so it has its own
// "already building" guard against its own meta rather than the structure's.
async function buildAssetTypeCountCrawl({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const structureMeta = await readAssetSnapshotMeta(installationKey);
  if (!structureMeta?.version) {
    return { queued: false, error: "No Assets structure inventory yet. Build that first." };
  }

  const countMeta = await readAssetTypeCountMeta(installationKey);
  if (countMeta?.state === "building" && !isAssetTypeCountBuildStale(countMeta)) {
    return { queued: false, reason: "already-building", meta: countMeta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before crawling object counts." };
  }

  await queueAssetTypeCountBuild(installationKey);
  return { queued: true };
}

// The access pillar's read: permission / issue-security / notification schemes, their
// holders and project assignments, with the governance summary for each type. Roster
// accountIds are joined in so an off-roster grant reads as such.
// The second argument is internal: Forge only ever passes the request. Remediation calls this
// with listLimit: Infinity to read every flagged item rather than the tab's first 25.
async function getAccessInventory({ context }, { listLimit = 25 } = {}) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readAccessSnapshotMeta(installationKey);
  const staleBuild = isAccessBuildStale(meta);

  if (!meta?.version) {
    return {
      state: meta?.state || "idle",
      staleBuild,
      startedAt: meta?.startedAt || null,
      version: null,
      permissions: null,
      security: null,
      notifications: null,
      lastError: meta?.lastError || null,
      neverBuilt: true,
    };
  }

  const rosterAccountIds = (await loadActiveRoster(installationKey)) || new Set();

  const [
    permSchemes, permHolders, permProjects,
    secSchemes, secHolders, secProjects, levels,
    notifSchemes, notifHolders, notifProjects,
    roleSchemes, roleHolders,
  ] = await Promise.all([
    loadSchemes(installationKey, meta.version, "permission"),
    loadSchemeHolders(installationKey, meta.version, "permission"),
    loadSchemeProjects(installationKey, meta.version, "permission"),
    loadSchemes(installationKey, meta.version, "security"),
    loadSchemeHolders(installationKey, meta.version, "security"),
    loadSchemeProjects(installationKey, meta.version, "security"),
    loadSchemeLevels(installationKey, meta.version),
    loadSchemes(installationKey, meta.version, "notification"),
    loadSchemeHolders(installationKey, meta.version, "notification"),
    loadSchemeProjects(installationKey, meta.version, "notification"),
    loadSchemes(installationKey, meta.version, "project-role"),
    loadSchemeHolders(installationKey, meta.version, "project-role"),
  ]);

  const projectCountFor = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(r.schemeId, (m.get(r.schemeId) || 0) + 1);
    return m;
  };

  const decorate = (schemes, projRows) => {
    const counts = projectCountFor(projRows);
    return schemes.map((s) => ({ ...s, projectCount: counts.get(s.id) || 0 }));
  };

  return {
    state: meta.state || "ready",
    staleBuild,
    startedAt: meta.startedAt || null,
    refreshedAt: meta.refreshedAt || null,
    version: meta.version,
    neverBuilt: false,
    lastError: meta.lastError || null,
    permissions: {
      schemes: decorate(permSchemes, permProjects),
      holders: permHolders,
      governance: summarizePermissionInsights({ schemes: permSchemes, holders: permHolders, schemeProjects: permProjects, rosterAccountIds, listLimit }),
    },
    security: {
      schemes: decorate(secSchemes, secProjects),
      levels,
      holders: secHolders,
      governance: summarizeSecurityInsights({ schemes: secSchemes, levels, holders: secHolders, schemeProjects: secProjects, rosterAccountIds, listLimit }),
    },
    notifications: {
      schemes: decorate(notifSchemes, notifProjects),
      holders: notifHolders,
      governance: summarizeNotificationInsights({ schemes: notifSchemes, holders: notifHolders, schemeProjects: notifProjects, rosterAccountIds, listLimit }),
    },
    roles: {
      // projectCount here means "on how many projects does this role have at least one
      // real actor", built from the role holder rows rather than a schemeProjects table.
      schemes: (() => {
        const withActor = new Map();
        for (const h of roleHolders) {
          if (h.holderType === "user" || h.holderType === "group") {
            if (!withActor.has(h.schemeId)) withActor.set(h.schemeId, new Set());
            withActor.get(h.schemeId).add(h.context);
          }
        }
        return roleSchemes.map((s) => ({ ...s, projectCount: withActor.get(s.id)?.size || 0 }));
      })(),
      holders: roleHolders,
      governance: summarizeRoleInsights({ roles: roleSchemes, holders: roleHolders, rosterAccountIds, listLimit }),
    },
  };
}

async function buildAccessInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readAccessSnapshotMeta(installationKey);
  if (meta?.state === "building" && !isAccessBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before building the access inventory." };
  }

  await queueAccessSnapshotBuild(installationKey);
  return { queued: true };
}

// The configuration change-history timeline: one page of detected adds / removes / modifies
// across every pillar drift tracks, plus a trailing-window summary for the headline. Keyset
// pagination on detected_at -- `before` is the last row's detectedAt from the previous page.
const CHANGE_WINDOW_DAYS = 30;

async function getChangeHistory({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readDriftSnapshotMeta(installationKey);
  const staleBuild = isDriftBuildStale(meta);

  if (!meta?.version) {
    return {
      state: meta?.state || "idle",
      staleBuild,
      startedAt: meta?.startedAt || null,
      neverBuilt: true,
      trackedPillars: DRIFT_PILLARS.map((p) => ({ key: p.pillar, label: p.label })),
      changes: [],
      summary: { total: 0, byPillar: {}, byKind: { added: 0, removed: 0, modified: 0 } },
      lastError: meta?.lastError || null,
    };
  }

  const pillar = payload?.pillar && payload.pillar !== "all" ? String(payload.pillar) : null;
  const kind = payload?.kind && payload.kind !== "all" ? String(payload.kind) : null;
  const before = payload?.before ? String(payload.before) : null;
  const limit = Math.max(1, Math.min(200, Number(payload?.limit) || 100));
  const windowStart = new Date(Date.now() - CHANGE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [changes, summary] = await Promise.all([
    loadConfigChanges(installationKey, { pillar, kind, before, limit: limit + 1 }),
    loadConfigChangeSummary(installationKey, windowStart),
  ]);

  const hasMore = changes.length > limit;
  return {
    state: meta.state || "ready",
    staleBuild,
    refreshedAt: meta.refreshedAt || null,
    neverBuilt: false,
    lastRunChanges: meta.lastRunChanges || 0,
    totalChanges: meta.totalChanges || 0,
    seededPillars: meta.seededPillars || [],
    trackedPillars: DRIFT_PILLARS.map((p) => ({ key: p.pillar, label: p.label })),
    windowDays: CHANGE_WINDOW_DAYS,
    changes: hasMore ? changes.slice(0, limit) : changes,
    nextCursor: hasMore ? changeCursorOf(changes[limit - 1]) : null,
    summary,
    lastError: meta.lastError || null,
  };
}

async function buildChangeHistory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readDriftSnapshotMeta(installationKey);
  if (meta?.state === "building" && !isDriftBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before running a drift pass." };
  }

  await queueDriftSnapshotBuild(installationKey);
  return { queued: true };
}

// The estate-config pillar's read: the global value lists (resolutions, priorities) with
// the near-duplicate-name governance summary over each.
async function getEstateInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readEstateSnapshotMeta(installationKey);
  const staleBuild = isEstateBuildStale(meta);

  if (!meta?.version) {
    return {
      state: meta?.state || "idle",
      staleBuild,
      startedAt: meta?.startedAt || null,
      neverBuilt: true,
      resolutions: [],
      priorities: [],
      governance: summarizeEstateInsights({}),
      lastError: meta?.lastError || null,
    };
  }

  const [rawResolutions, rawPriorities, totals] = await Promise.all([
    loadEstateValues(installationKey, meta.version, "resolution"),
    loadEstateValues(installationKey, meta.version, "priority"),
    // Usage from the issue crawl. Without it every row read "Not measured", though the crawl
    // had counted issues per value all along; only the Overview attached the counts.
    loadEstateValueTotals(installationKey).catch(fallbackOn("estate.usage_load_failed", [], { installationKey })),
  ]);
  const { resolutions, priorities, usageMeasured, unresolvedIssueCount } = attachEstateUsage({
    resolutions: rawResolutions,
    priorities: rawPriorities,
    totals,
  });

  return {
    state: meta.state || "ready",
    staleBuild,
    refreshedAt: meta.refreshedAt || null,
    neverBuilt: false,
    lastError: meta.lastError || null,
    resolutions,
    priorities,
    usageMeasured,
    unresolvedIssueCount,
    governance: summarizeEstateInsights({ resolutions, priorities }),
  };
}

async function buildEstateInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readEstateSnapshotMeta(installationKey);
  if (meta?.state === "building" && !isEstateBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before building the priorities/resolutions inventory." };
  }

  await queueEstateSnapshotBuild(installationKey);
  return { queued: true };
}

// Queue a field scheme / field configuration build. Same guard as every other inventory:
// a live build is not doubled, a wedged one is not honoured, and read-only mode refuses.
async function buildFieldConfigInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readFieldConfigSnapshotMeta(installationKey);
  if (meta?.state === "building" && !isFieldConfigBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before building the field scheme inventory." };
  }

  await queueFieldConfigSnapshotBuild(installationKey);
  return { queued: true };
}

// The boards pillar's read: every agile board with its backing filter, location and column
// mapping. Structure only -- the cross-pillar joins (broken backing filter, statuses not
// mapped to a column, personal boards owned by inactive users) and the governance score
// arrive with B2/B3.
async function getBoardInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readBoardSnapshotMeta(installationKey);
  const staleBuild = isBoardBuildStale(meta);

  if (!meta?.version) {
    return {
      state: meta?.state || "idle",
      staleBuild,
      startedAt: meta?.startedAt || null,
      neverBuilt: true,
      boards: [],
      summary: { total: 0, byType: {}, personal: 0, unreadable: 0, missingFilter: 0, totalColumns: 0 },
      lastError: meta?.lastError || null,
    };
  }

  const [boards, columns, filterMeta, workflowMeta] = await Promise.all([
    loadBoards(installationKey, meta.version),
    loadBoardColumns(installationKey, meta.version),
    readFilterSnapshotMeta(installationKey).catch(() => null),
    readWorkflowSnapshotMeta(installationKey).catch(() => null),
  ]);

  // The two cross-pillar joins. Each is best-effort: a missing snapshot means that check did
  // not run, which summarizeBoardInsights reports as joinedFilters / joinedStatuses rather
  // than as a clean bill of health.
  const [filters, statusCatalog] = await Promise.all([
    filterMeta?.version ? loadFilters(installationKey, filterMeta.version).catch(() => null) : Promise.resolve(null),
    workflowMeta?.version ? loadStatusesCatalog(installationKey, workflowMeta.version).catch(() => null) : Promise.resolve(null),
  ]);
  const knownStatusIds = statusCatalog ? new Set(statusCatalog.map((s) => String(s.id ?? s.statusId))) : null;

  const columnsByBoard = new Map();
  for (const col of columns) {
    if (!columnsByBoard.has(col.boardId)) columnsByBoard.set(col.boardId, []);
    columnsByBoard.get(col.boardId).push(col);
  }

  const filterById = indexFiltersById(filters);
  const rows = boards.map((board) => {
    const cols = columnsByBoard.get(board.boardId) || [];
    const withColumns = {
      ...board,
      columns: cols,
      unmappedColumns: cols.filter((c) => c.statusIds.length === 0).length,
    };
    // Every board's own finding codes, uncapped -- insights.flagged stops at 50, and the
    // pillar report needs the full set.
    return { ...withColumns, issues: boardIssues(withColumns, filterById, knownStatusIds) };
  });

  const byType = {};
  for (const board of rows) {
    const key = board.type || "unknown";
    byType[key] = (byType[key] || 0) + 1;
  }

  const insights = summarizeBoardInsights({ boards: rows, filters, knownStatusIds });

  return {
    state: meta.state || "ready",
    staleBuild,
    refreshedAt: meta.refreshedAt || null,
    neverBuilt: false,
    lastError: meta.lastError || null,
    boards: rows,
    insights,
    summary: {
      total: rows.length,
      byType,
      personal: rows.filter((board) => board.locationType === "user").length,
      // Boards whose /configuration endpoint 404'd -- their column and filter facts are unknown.
      unreadable: Number(meta.boardsUnreadable) || 0,
      // Config was readable but named no backing filter.
      missingFilter: rows.filter((board) => board.configReadable && !board.filterId).length,
      // Config named a filter id that is not in the filter snapshot -- deleted out from under it.
      brokenFilter: insights.missingFilter,
      inactiveFilterOwner: insights.inactiveFilterOwner,
      staleColumnBoards: insights.staleColumnBoards,
      totalColumns: columns.length,
    },
  };
}

async function buildBoardInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readBoardSnapshotMeta(installationKey);
  if (meta?.state === "building" && !isBoardBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before building the board inventory." };
  }

  await queueBoardSnapshotBuild(installationKey);
  return { queued: true };
}

async function getAutomationInsights({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const analysis = await readAutomationAnalysis(installationKey);

    if (!analysis) {
      return {
        available: false,
        reason: "no-analysis",
        refreshedAt: null,
      };
    }

    // Decided here rather than in the browser so the tab, the Rovo agent and the field panel
    // all take the same view of whether this import is still current. indexRequired is false
    // because this is the estate summary, not a per-entity lookup -- only the age applies.
    const cfg = await readAdminConfig().catch(() => null);
    const evidence = assessAutomationEvidence({
      indexRequired: false,
      refreshedAt: analysis.refreshedAt ?? null,
      staleAfterDays: Number(cfg?.automationStaleAfterDays) || DEFAULT_ANALYSIS_STALE_AFTER_DAYS,
    });

    return {
      available: true,
      refreshedAt: analysis.refreshedAt ?? null,
      evidence,
      source: analysis.source ?? "unknown",
      estate: analysis.estate ?? null,
      // A preview for the overview. The Findings section fetches the full list separately;
      // sending 675 rows with the first paint would slow every visit to pay for one section.
      findingsPreview: analysis.findingsPreview ?? [],
      findingsTotal: analysis.findingsTotal ?? (analysis.findingsPreview?.length ?? 0),
      cascades: analysis.cascades ?? [],
      cascadesTotal: analysis.cascadesTotal ?? (analysis.cascades?.length ?? 0),
      selfTriggeringTotal: analysis.selfTriggeringTotal ?? 0,
      // The three cross-rule checks. Null, not zero, on an analysis saved before they were
      // stored: those imports were never measured for them, and the tab says so.
      ...crossRuleSection(analysis),
      // The blast-radius tier histogram for the overview. Null on an analysis imported
      // before blast scoring existed — the tab shows a "re-import" prompt for that section.
      blast: analysis.blast ?? null,
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getAutomationInsights failed:", error);
    throw error;
  }
}

// The cross-rule lists, keyed so the getter and the saver agree on the names.
const CROSS_RULE_KEYS = ["eventCascades", "competingPairs", "fieldContradictions"];

// Saving: totals come from the payload (they describe the estate, not the capped list);
// a payload without a list leaves the check unmeasured rather than recording zero.
function storedCrossRule(document) {
  const out = {};
  for (const key of CROSS_RULE_KEYS) {
    const list = document[key];
    if (!Array.isArray(list)) continue;
    const total = Number(document[`${key}Total`]);
    out[key] = list.slice(0, MAX_STORED_CROSS_RULE);
    out[`${key}Total`] = Number.isFinite(total) && total >= list.length ? total : list.length;
  }
  return out;
}

// Reading: null when the stored analysis predates the check.
function crossRuleSection(analysis) {
  const out = {};
  for (const key of CROSS_RULE_KEYS) {
    const measured = Array.isArray(analysis[key]);
    out[key] = measured ? analysis[key] : [];
    out[`${key}Total`] = measured ? (Number(analysis[`${key}Total`]) || analysis[key].length) : null;
  }
  return out;
}

// The blast rollup is admin-supplied like the rest of the analysis payload. An admin can
// already read everything in it, so the risk is a malformed shape wedging the overview, not
// disclosure — every field is coerced and the top list is capped.
function sanitizeBlastSummary(blast) {
  if (!blast || typeof blast !== "object" || Array.isArray(blast)) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const tiers = blast.byTier && typeof blast.byTier === "object" ? blast.byTier : {};
  return {
    available: Boolean(blast.available),
    total: num(blast.total),
    byTier: {
      estate: num(tiers.estate),
      "cross-project": num(tiers["cross-project"]),
      project: num(tiers.project),
      contained: num(tiers.contained),
    },
    estateWideCount: num(blast.estateWideCount),
    estateWideShare: num(blast.estateWideShare),
    estateWideCredentialCount: num(blast.estateWideCredentialCount),
    estimatedCount: num(blast.estimatedCount),
    top: Array.isArray(blast.top)
      ? blast.top.slice(0, 20).map((r) => ({
          ruleId: String(r?.ruleId ?? ""),
          score: num(r?.score),
          tier: String(r?.tier ?? "contained").slice(0, 20),
        }))
      : [],
  };
}


// Store an analysis built by the admin's browser from an exported rule file.
//
// The site's rules are not reachable from the backend yet: the Automation API needs scopes
// this app does not hold, and adding them requires the admin to re-consent. Meanwhile the
// same export file already gets produced weekly for the committed rule snapshot, so this
// takes the analysis the browser derived from that file. The whole 9 MB export never
// crosses the invoke boundary -- only the bounded document, around 130 KB.
//
// The payload is admin-supplied and therefore validated, not trusted. An admin can already
// read everything in it, so the risk is not disclosure; it is a malformed or oversized
// document wedging the tab for everyone, or a client-side cap regression quietly writing a
// value too large for KVS to hold. Caps are re-applied here rather than assumed.
async function saveAutomationAnalysis({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const document = payload?.analysis;

    if (!document || typeof document !== "object" || Array.isArray(document)) {
      throw new Error("analysis must be an object");
    }
    if (document.schemaVersion !== 1) {
      throw new Error(`unsupported analysis schemaVersion: ${document.schemaVersion}`);
    }
    if (!document.estate || typeof document.estate !== "object") {
      throw new Error("analysis.estate is required");
    }

    const preview = Array.isArray(document.findingsPreview) ? document.findingsPreview : [];
    const cascades = Array.isArray(document.cascades) ? document.cascades : [];

    const stored = {
      schemaVersion: 1,
      // Server clock, not the browser's. A workstation with a skewed clock would otherwise
      // stamp an analysis as hours old or hours in the future, and the staleness warning
      // this drives is the reason anyone trusts the numbers.
      refreshedAt: Date.now(),
      source: typeof document.source === "string" ? document.source.slice(0, 64) : "unknown",
      estate: document.estate,
      // A short preview for the overview only; the full list lives under its own part.
      findingsPreview: preview.slice(0, MAX_PREVIEW_FINDINGS),
      // Totals describe the estate, not the truncated list, so they are taken from the
      // payload rather than recomputed from what survived slicing.
      findingsTotal: Number(document.findingsTotal) || preview.length,
      cascades: cascades.slice(0, MAX_STORED_CASCADES),
      cascadesTotal: Number(document.cascadesTotal) || cascades.length,
      selfTriggeringTotal: Number(document.selfTriggeringTotal) || 0,
      // The three cross-rule checks. These were computed by the analysis and then dropped
      // here, so the tab's tiles read 0 on every site whatever the rules did.
      ...storedCrossRule(document),
      // The blast-radius rollup: a tier histogram and the two health inputs. Small, and read
      // on first paint, so it rides here rather than costing a SQL round trip. The per-rule
      // scores are shredded into automation_rule_blast by the "blast" index part.
      blast: sanitizeBlastSummary(document.blast),
    };

    await writeAutomationAnalysis(installationKey, stored);

    logger.info("automation.analysis_saved", {
      installationKey,
      ruleCount: stored.estate?.ruleCount ?? null,
      findingsTotal: stored.findingsTotal,
      source: stored.source,
    });

    return { saved: true, refreshedAt: stored.refreshedAt };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("saveAutomationAnalysis failed:", error);
    throw error;
  }
}


// Store one of the supporting index documents: the field index, the status index, or the
// rule directory.
//
// Written separately from the analysis, and deliberately BEFORE it. The analysis document
// is what getAutomationInsights checks to decide whether anything has been built, so
// writing it last makes it the commit point: if the browser fails partway through an
// import, the tab keeps showing its empty state rather than an estate summary whose Fields
// section is missing or belongs to a previous build.
async function saveAutomationIndex({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const part = payload?.part;
    const document = payload?.document;

    // The analysis has its own resolver, with its own validation and the server clock
    // stamp. Routing it through here would bypass both.
    if (part === "analysis" || !isAutomationIndexPart(part)) {
      throw new Error(`unknown automation index part: ${part}`);
    }
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      throw new Error("document must be an object");
    }
    if (document.schemaVersion !== 1) {
      throw new Error(`unsupported index schemaVersion: ${document.schemaVersion}`);
    }

    // SQL-only parts skip the KVS copy entirely. Cascades are the reason that distinction
    // exists: 1,457 edges is precisely the shape that does not belong in a document with a
    // 240 KB ceiling, and the cap that ceiling forced is what this whole change removes.
    if (!SQL_ONLY_AUTOMATION_PARTS.has(part)) {
      await writeAutomationPart(installationKey, part, document);
    }

    // Also shred into SQL, where the caps do not apply and the cross-pillar join is a real
    // indexed query rather than a string match over a loaded document.
    //
    // The KVS write stays for now: the tab still reads documents, and keeping both means
    // this can land without a coordinated UI change. Best-effort by design -- a SQL failure
    // must not fail the import, because the KVS copy already succeeded and is what the UI
    // currently renders. It is logged rather than swallowed silently.
    let rowsWritten = null;
    try {
      if (part === "fields" || part === "statuses") {
        const other = part === "fields" ? "statuses" : "fields";
        const existing = await readAutomationPart(installationKey, other);
        rowsWritten = await replaceAutomationReferences(installationKey, {
          fields: part === "fields" ? document : existing,
          statuses: part === "statuses" ? document : existing,
        });
      } else if (part === "directory") {
        rowsWritten = await replaceAutomationRules(installationKey, document);
      } else if (part === "findings") {
        rowsWritten = await replaceAutomationFindings(installationKey, document);
      } else if (part === "cascades") {
        rowsWritten = await replaceAutomationCascades(installationKey, document);
      } else if (part === "blast") {
        rowsWritten = await replaceAutomationBlast(installationKey, document);
      }
    } catch (sqlError) {
      logger.warn("automation.sql_index_failed", {
        installationKey,
        part,
        error: String(sqlError?.message || sqlError),
      });
      // For the document-backed parts a SQL failure is recoverable: the KVS copy succeeded
      // and is what the tab currently renders. For a SQL-only part there is no second copy,
      // so swallowing it would leave the estate summary claiming cascades that were never
      // written and a Cascades section that is silently empty.
      if (SQL_ONLY_AUTOMATION_PARTS.has(part)) throw sqlError;
    }

    return { saved: true, part, rowsWritten };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("saveAutomationIndex failed:", error);
    throw error;
  }
}


// The saved filter inventory, with its governance findings.
//
// Everything is derived at read time from the snapshot rather than stored pre-analysed: the
// analysis is pure over a few hundred rows, and storing it would mean a second thing to keep
// in step with the filters -- a stored finding and a rebuilt snapshot can disagree, and a
// derived one cannot.
// Every saved filter with its findings attached, plus the summary those findings came from.
// Shared by the paginated Filters tab read and the pillar report, which needs every row.
async function loadFiltersWithFindings(installationKey, version) {
  const [filters, snapshotMeta] = await Promise.all([
    loadFilters(installationKey, version),
    readSnapshotMeta(installationKey),
  ]);

  // The project catalog, for the broken-reference join. Best-effort: without it that one
  // finding is skipped and `projectsChecked` says so, rather than reporting zero broken
  // references because nobody looked.
  let projectKeys = null;
  if (snapshotMeta?.version) {
    const projects = await listSnapshotProjects(installationKey, snapshotMeta.version)
      .catch(fallbackOn("filters.project_keys_load_failed", () => [], { installationKey }));
    // Both the key and the display name: JQL accepts `project = KEY` and
    // `project = "Display Name"` equally, and a filter written the second way was being
    // reported as broken -- a project that genuinely exists, referenced by a name this set
    // never carried, indistinguishable from a real dangling reference to the check below.
    if (projects.length) {
      projectKeys = new Set(
        projects.flatMap((p) => [p.projectKey, p.projectName]).filter(Boolean)
      );
    }
  }

  // The issue type catalog, for the "JQL names a type nothing defines" join. Same
  // best-effort posture: skipped and flagged rather than reported as zero.
  let typeNames = null;
  const itMeta = await readIssueTypeSnapshotMeta(installationKey).catch(() => null);
  if (itMeta?.version) {
    const types = await loadIssueTypes(installationKey, itMeta.version)
      .catch(fallbackOn("filters.type_names_load_failed", () => [], { installationKey }));
    if (types.length) typeNames = new Set(types.map((t) => String(t.name || "").toLowerCase()).filter(Boolean));
  }

  const summary = summarizeFilters(filters, { projectKeys, typeNames });
  // `summary.filters` is analyzeFilter's own output -- every filter with findings attached,
  // unbounded, sorted worst-first. It exists so buildFilterOverview (the Overview's "worst"
  // list) can slice(0, 8) from it. Spreading the whole summary into this response used to
  // ship that unbounded list a SECOND time, in full, on top of the complete `allFilters`
  // array below -- every filter with a finding sent twice. At 4,115 filters that duplication
  // was a meaningful share of what overflowed the response.
  const { filters: analyzedFilters, ...summaryForWire } = summary;

  // The findings computed above, attached back onto the row shape the tab actually renders,
  // by id. Without this the tab had to reconstruct it client-side by joining `allFilters`
  // (no findings) against `summary.filters` (findings, but only the flagged subset) -- the
  // exact duplication this removes, from the other direction.
  const findingsById = new Map(analyzedFilters.map((f) => [f.id, f.findings]));
  const withFindings = filters.map((f) => ({ ...f, findings: findingsById.get(f.id) ?? [] }));
  return { summary, summaryForWire, withFindings };
}

async function getFilterInventory({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const params = payload || {};
    if (params.page !== undefined && params.page !== null) requirePositiveInt(params.page, "page");
    if (params.pageSize !== undefined && params.pageSize !== null) requireBoundedInt(params.pageSize, "pageSize", 1, 100);
    optionalString(params.search, "search");
    optionalString(params.finding, "finding");
    optionalString(params.sort, "sort");

    const installationKey = getInstallationKey(context);
    const meta = await readFilterSnapshotMeta(installationKey);

    if (!meta?.version) {
      return {
        available: false,
        state: meta?.state || "idle",
        lastError: meta?.lastError || null,
        // A build that died mid-flight would otherwise suppress every future rebuild, so the
        // tab needs to know it can offer the button again. Named staleBuild because that is
        // what the screen pillar already calls it -- the flag means the same thing on every
        // surface, and a second name for it is how one of them ends up not reading it.
        staleBuild: isFilterBuildStale(meta),
        neverBuilt: true,
      };
    }

    const { summaryForWire, summary, withFindings } = await loadFiltersWithFindings(installationKey, meta.version);

    // Filter, search and sort HERE, over the full in-memory list, and ship only one page.
    // The full list already exists in memory for the summary above; the fix is not to avoid
    // holding it, it is to stop SENDING all of it. Same logic the tab used to run in the
    // browser, moved verbatim into filter-query.js so server and client can never disagree
    // about which filters match.
    const pageSize = Math.max(1, Math.min(100, Number(params.pageSize) || 25));
    const requestedPage = Math.max(1, Number(params.page) || 1);
    const search = String(params.search || "");
    const finding = String(params.finding || "all");
    const sort = FILTER_SORTS.includes(params.sort) ? params.sort : "findings";

    const matched = sortFilters(filterRows(withFindings, { search, finding }), sort);
    const matchedTotal = matched.length;
    const totalPages = Math.max(1, Math.ceil(matchedTotal / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const startIndex = (page - 1) * pageSize;

    return {
      available: true,
      state: meta.state || "idle",
      staleBuild: isFilterBuildStale(meta),
      version: meta.version,
      refreshedAt: meta.refreshedAt || null,
      lastError: meta.lastError || null,
      ...summaryForWire,
      health: summarizeFilterHealth(summary),
      // Counts for the finding rail, over the FULL list -- these describe the whole
      // inventory, not just the current page, so the rail must not recompute them from a
      // page that may hold none of a given kind.
      findingCounts: filterFindingCounts(withFindings),
      // The current page of the FILTERED, SORTED result. `matchedTotal` is how many filters
      // match the current search/finding -- distinct from `total` above, which is the whole
      // inventory regardless of what is currently being searched for.
      matchedTotal,
      page,
      pageSize,
      totalPages,
      filters: matched.slice(startIndex, startIndex + pageSize),
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getFilterInventory failed:", error);
    throw error;
  }
}

// Queue a rebuild of the filter inventory.
async function buildFilterInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readFilterSnapshotMeta(installationKey);
  // Suppress only a build that is both building AND not stale. A wedged row would otherwise
  // block every future rebuild with no way out of the UI.
  if (meta?.state === "building" && !isFilterBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before building the filter inventory." };
  }

  // Starting the build is the harness's job now, not this resolver's. It writes the in-flight
  // version, the token and the zeroed progress in one place, so the queue message and the meta
  // row can never disagree about which build is running.
  return queueFilterSnapshotBuild(installationKey);
}

// How many saved filters reference each field on a page.
//
// Mirrors getFieldScreenCounts exactly, including its posture: an unbuilt inventory reports
// available:false so the chip renders as unknown rather than as zero. "No filter uses this
// field" is permission to delete it; "we have not looked" is not, and the two must never
// render the same.
//
// Batched because the Field Browser shows twenty-five fields a page, and asking per field is
// twenty-five round trips to draw one column.
async function getFieldFilterCounts({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readFilterSnapshotMeta(installationKey);
  if (!meta?.version) {
    return { available: false, reason: "No saved filter inventory has been built yet.", counts: {} };
  }

  // Filters name fields the way a person writes JQL -- by NAME for most fields, and by
  // cf[10001] for the escape hatch -- so the lookup is by name, with the id as a fallback.
  // The field catalog is what maps one to the other, and the caller already has it.
  const fields = Array.isArray(payload?.fields) ? payload.fields.slice(0, 500) : [];
  const labels = [];
  const labelToField = new Map();
  for (const field of fields) {
    for (const label of [field?.name, field?.id].filter(Boolean)) {
      const key = String(label).toLowerCase();
      labels.push(String(label));
      if (!labelToField.has(key)) labelToField.set(key, String(field.id));
    }
  }

  const byLabel = await loadFilterReferenceCounts(installationKey, meta.version, "field", labels);

  // Folded back onto the field id, taking the larger when a field is referenced both ways.
  // Summing would double-count a filter that names the same field by name and by id.
  const counts = {};
  for (const [label, count] of Object.entries(byLabel)) {
    const fieldId = labelToField.get(label);
    if (!fieldId) continue;
    counts[fieldId] = Math.max(counts[fieldId] ?? 0, count);
  }

  return { available: true, version: meta.version, refreshedAt: meta.refreshedAt, counts };
}

// How many dashboard gadgets reach each of a page of fields, in one bulk pass.
//
// The always-visible header stat tile needs an instant answer for a whole page of fields, so
// it cannot afford getDashboardUsage's per-field chain -- that resolver is built to describe
// ONE field's dashboards in full (names, owners, which gadget), not to answer a plain count for
// fifty fields at once. This mirrors getFieldFilterCounts's shape instead: bulk in, bulk out,
// counts only.
//
// Chain is field -> filter ids naming it -> gadgets configured to show one of those filters.
// A field is counted through the UNION of filter ids across its name and id labels, not the
// sum -- summing would double the count for a filter that happens to be found under both.
async function getFieldDashboardCounts({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const [filterMeta, dashboardMeta] = await Promise.all([
    readFilterSnapshotMeta(installationKey),
    readDashboardSnapshotMeta(installationKey),
  ]);
  // Both inventories are required, and which one is missing changes what an admin builds
  // next, so the reason says which rather than collapsing to one "unavailable".
  if (!filterMeta?.version) {
    return { available: false, reason: "No saved filter inventory has been built yet.", counts: {} };
  }
  if (!dashboardMeta?.version) {
    return { available: false, reason: "No dashboard inventory has been built yet.", counts: {} };
  }

  const fields = Array.isArray(payload?.fields) ? payload.fields.slice(0, 500) : [];
  const labels = [];
  const labelToFieldIds = new Map();
  for (const field of fields) {
    for (const label of [field?.name, field?.id].filter(Boolean)) {
      const key = String(label).toLowerCase();
      labels.push(String(label));
      if (!labelToFieldIds.has(key)) labelToFieldIds.set(key, new Set());
      labelToFieldIds.get(key).add(String(field.id));
    }
  }

  const filterIdsByLabel = await loadFilterIdsForLabels(installationKey, filterMeta.version, "field", labels);

  // Union first, so a filter found under both a field's name and its id is only ever counted
  // once against that field.
  const filterIdsByFieldId = new Map();
  for (const [label, filterIds] of filterIdsByLabel) {
    for (const fieldId of labelToFieldIds.get(label) || []) {
      if (!filterIdsByFieldId.has(fieldId)) filterIdsByFieldId.set(fieldId, new Set());
      for (const id of filterIds) filterIdsByFieldId.get(fieldId).add(id);
    }
  }

  const allFilterIds = [...new Set([...filterIdsByFieldId.values()].flatMap((s) => [...s]))];
  // Skipped rather than called with nothing to ask about: a page of fields none of which any
  // filter names is the common case for a freshly opened Field Browser page, and there is no
  // reason to round-trip to SQL to learn what is already known.
  const gadgetCountsByFilterId = allFilterIds.length
    ? await loadGadgetCountsForFilterIds(installationKey, dashboardMeta.version, allFilterIds)
    : new Map();

  const counts = {};
  for (const [fieldId, filterIds] of filterIdsByFieldId) {
    let total = 0;
    for (const filterId of filterIds) total += gadgetCountsByFilterId.get(filterId) || 0;
    counts[fieldId] = total;
  }

  return {
    available: true,
    filterVersion: filterMeta.version,
    dashboardVersion: dashboardMeta.version,
    counts,
  };
}

// Which saved filters reference one field or status.
//
// The second half of the cross-pillar answer. The Field Browser already says which automation
// rules write a field; this says which saved searches would silently start returning the wrong
// answer if it went away.
// Which dashboards depend on a field, and where on them.
//
// Resolved as a chain rather than a guess: field -> the filters whose JQL names it ->
// the gadgets configured to show those filters -> the dashboards those gadgets sit on. Every
// leg is an exact join, which is what makes the answer safe to act on. Matching gadget titles
// against filter names would have been far cheaper and right most of the time, and "most of
// the time" is not a basis for deleting a field.
async function getDashboardUsage({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const label = String(payload?.label ?? "").trim();
    if (!label) throw new Error("label is required");

    const [dashMeta, filterMeta] = await Promise.all([
      readDashboardSnapshotMeta(installationKey),
      readFilterSnapshotMeta(installationKey),
    ]);

    // Both halves are required, and which one is missing changes what an admin has to do, so
    // they are reported separately rather than as one "unavailable".
    if (!dashMeta?.version) return { available: false, reason: "no-dashboard-inventory", label };
    if (!filterMeta?.version) return { available: false, reason: "no-filter-inventory", label };

    // Leg one: the filters that name this field.
    const filterRefs = await loadFilterReferencesFor(installationKey, filterMeta.version, "field", label);
    const filterIds = (filterRefs?.filters || []).map((f) => String(f.id)).filter(Boolean);

    const coverage = await countGadgetConfigCoverage(installationKey, dashMeta.version);
    // A config walk that did not finish cannot support "no dashboard uses this field". The
    // count of what it reached travels so the tab can say how complete the answer is, rather
    // than presenting a partial join as a clean bill of health.
    const complete = coverage.total === 0 || coverage.walked >= coverage.total;

    if (!filterIds.length) {
      return {
        available: true, label, total: 0, dashboards: [], viaFilters: 0,
        coverage, complete,
      };
    }

    // Leg two: the dashboards whose gadgets point at those filters.
    const rows = await loadDashboardsForFilters(installationKey, dashMeta.version, filterIds);
    const byFilter = new Map((filterRefs?.filters || []).map((f) => [String(f.id), f.name]));

    // One entry per dashboard, carrying which gadgets and which filters got us there -- a
    // dashboard reached through three gadgets is one dashboard, not three findings.
    const byDashboard = new Map();
    for (const row of rows) {
      const entry = byDashboard.get(row.dashboardId) || {
        id: row.dashboardId,
        name: row.dashboardName,
        ownerName: row.ownerName,
        popularity: row.popularity,
        viewUrl: row.viewUrl,
        via: [],
      };
      entry.via.push({
        gadgetTitle: row.gadgetTitle,
        filterId: row.filterId,
        filterName: byFilter.get(row.filterId) || null,
      });
      byDashboard.set(row.dashboardId, entry);
    }

    const dashboards = [...byDashboard.values()].sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    return {
      available: true,
      label,
      total: dashboards.length,
      viaFilters: filterIds.length,
      dashboards,
      coverage,
      complete,
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getDashboardUsage failed:", error);
    throw error;
  }
}

async function getFilterUsage({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const kind = payload?.kind === "status" ? "status" : payload?.kind === "project" ? "project" : "field";
    const label = String(payload?.label ?? "").trim();
    if (!label) throw new Error("label is required");

    const meta = await readFilterSnapshotMeta(installationKey);
    // No inventory is "we have not looked", never "no filter uses this". Saying the second
    // with nothing behind it is the false reassurance this whole pillar exists to stop.
    if (!meta?.version) return { available: false, reason: "no-inventory", label };

    const result = await loadFilterReferencesFor(installationKey, meta.version, kind, label);
    return { available: true, label, kind, ...result };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getFilterUsage failed:", error);
    throw error;
  }
}

// The dashboard inventory, with its governance findings.
//
// Derived at read time from the snapshot rather than stored pre-analysed, like the filter
// pillar: the analysis is pure over a few hundred rows, and a stored finding can disagree
// with a rebuilt snapshot where a derived one cannot.
async function getDashboardInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const meta = await readDashboardSnapshotMeta(installationKey);

    if (!meta?.version) {
      return {
        available: false,
        state: meta?.state || "idle",
        lastError: meta?.lastError || null,
        // A build that died mid-flight would otherwise suppress every future rebuild, so the
        // tab needs to know it can offer the button again. Named staleBuild to match the
        // screen and filter pillars -- one idea, one name, or a surface forgets to read it.
        staleBuild: isDashboardBuildStale(meta),
        neverBuilt: true,
      };
    }

    const dashboards = await loadDashboards(installationKey, meta.version);
    const summary = summarizeDashboards(dashboards);

    // What each dashboard depends on. The gadget -> filter join already ran during the build;
    // this is the second half, filter -> field, done once in bulk rather than once per
    // dashboard -- a site with a few hundred dashboards and a shared handful of filters would
    // otherwise re-run the same lookup for every dashboard that reuses a filter.
    const filterMeta = await readFilterSnapshotMeta(installationKey)
      .catch(fallbackOn("dashboard_inventory.filter_meta_read_failed", null, { installationKey }));

    let fieldRefsAvailable = false;
    if (filterMeta?.version) {
      const filterIds = [...new Set(
        dashboards.flatMap((d) => (d.gadgets || []).map((g) => g.filterId).filter(Boolean))
      )];
      if (filterIds.length) {
        // Two independent joins off the same filter id list: which fields a filter touches
        // (already existed, rolled up per dashboard) and what the filter is actually called
        // (new -- a gadget's config only ever carries the id). Neither failing should sink
        // the other, so each gets its own fallback rather than one Promise.all rejecting both.
        const [fieldsByFilter, filterNamesById] = await Promise.all([
          loadFieldNamesForFilterIds(installationKey, filterMeta.version, filterIds)
            .catch(fallbackOn("dashboard_inventory.field_join_failed", new Map(), { installationKey })),
          loadFilterNamesForIds(installationKey, filterMeta.version, filterIds)
            .catch(fallbackOn("dashboard_inventory.filter_name_join_failed", new Map(), { installationKey })),
        ]);
        for (const dashboard of dashboards) {
          const names = new Set();
          for (const gadget of dashboard.gadgets || []) {
            if (!gadget.filterId) continue;
            // Per-gadget, not just rolled into the dashboard total -- "this dashboard depends
            // on Story Points somewhere" and "gadget X depends on Story Points" are different
            // claims, and only the second one tells a reader which gadget breaks.
            const gadgetFieldRefs = fieldsByFilter.get(gadget.filterId) || [];
            gadget.fieldRefs = gadgetFieldRefs;
            gadget.filterName = filterNamesById.get(gadget.filterId)?.name ?? null;
            gadget.filterViewUrl = filterNamesById.get(gadget.filterId)?.viewUrl ?? null;
            for (const name of gadgetFieldRefs) names.add(name);
          }
          dashboard.fieldRefs = [...names].sort();
        }
      } else {
        for (const dashboard of dashboards) dashboard.fieldRefs = [];
      }
      fieldRefsAvailable = true;
    } else {
      // Tri-state, like everywhere else this join is attempted: no filter inventory means
      // "we have not looked", never "this dashboard depends on nothing" -- at the gadget
      // level too, for any gadget that does have a filter id waiting to be resolved.
      for (const dashboard of dashboards) {
        dashboard.fieldRefs = null;
        for (const gadget of dashboard.gadgets || []) {
          if (gadget.filterId) { gadget.fieldRefs = null; gadget.filterName = null; gadget.filterViewUrl = null; }
        }
      }
    }

    return {
      available: true,
      state: meta.state || "idle",
      // Carried on this path too: a rebuild over an existing snapshot wedges exactly the
      // same way, and reporting it only on the never-built path leaves that case stuck.
      staleBuild: isDashboardBuildStale(meta),
      version: meta.version,
      refreshedAt: meta.refreshedAt || null,
      lastError: meta.lastError || null,
      // How much of the estate the gadget walk actually reached. Without this the tab would
      // present a partial pass as a complete one.
      gadgetsWalked: meta.gadgetsWalked,
      // Enumeration pages Jira's dashboard/search returned a permanent 400 on and the build
      // stepped over rather than failing on. Non-zero means the inventory is missing up to
      // ~50 dashboards per page skipped -- same "say what we couldn't read" reason as above.
      pagesUnreadable: meta.pagesUnreadable || 0,
      // Whether the filter -> field join could run at all, separate from whether any one
      // dashboard's fieldRefs came back empty.
      fieldRefsAvailable,
      ...summary,
      health: summarizeDashboardHealth(summary),
      // Sent whole rather than paged. A few hundred dashboards is one fetch the tab already
      // pays for, and paging server-side would make client-side filtering impossible without
      // re-querying on every keystroke.
      allDashboards: dashboards,
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getDashboardInventory failed:", error);
    throw error;
  }
}

// Queue a rebuild of the dashboard inventory.
async function buildDashboardInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readDashboardSnapshotMeta(installationKey);
  // Suppress only a build that is both building AND not stale. A wedged row would otherwise
  // block every future rebuild with no way out of the UI.
  if (meta?.state === "building" && !isDashboardBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before building the dashboard inventory." };
  }

  // Wrapped in `body`, like every other push here. The consumer reads event?.body?.jobType,
  // so a bare payload arrives bodyless and Forge rejects the invocation outright.
  // The harness owns starting a build -- see buildFilterInventory.
  return queueDashboardSnapshotBuild(installationKey);
}

// Parts that are written to SQL and nowhere else.
//
// Everything in AUTOMATION_PARTS has a KVS document behind it; cascades deliberately do not.
// Kept as its own set rather than a flag on the parts map so the map keeps meaning exactly
// "these have a storage key".
const SQL_ONLY_AUTOMATION_PARTS = new Set(["cascades", "blast"]);

function isAutomationIndexPart(part) {
  return Object.prototype.hasOwnProperty.call(AUTOMATION_PARTS, part)
    || SQL_ONLY_AUTOMATION_PARTS.has(part);
}

// A page of cascades, filtered.
//
// The tab used to render whatever survived MAX_STORED_CASCADES -- 150 of this site's 1,457
// -- grouped in the browser. That grouping was only correct because the stored set WAS the
// whole page; grouping a page of a larger set splits one relationship across a page boundary
// and renders it twice. So both the filtering and the grouping happen in SQL, and the total
// counts groups rather than edges so a reader is never paged toward a number they cannot
// reach.
async function getAutomationCascades({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const page = Math.max(1, Math.trunc(Number(payload?.page)) || 1);
    const pageSize = Math.max(1, Math.min(200, Math.trunc(Number(payload?.pageSize)) || 50));

    const [summary, result] = await Promise.all([
      loadCascadeSummary(installationKey),
      loadCascades(installationKey, {
        search: String(payload?.search ?? "").slice(0, 200),
        kind: ["all", "self", "cross"].includes(payload?.kind) ? payload.kind : "all",
        ruleId: payload?.ruleId ? String(payload.ruleId) : null,
        direction: payload?.direction === "target" ? "target" : "source",
        field: payload?.field ? String(payload.field) : null,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
    ]);

    return {
      // Zero edges and no analysis are different states. A site whose rules genuinely
      // cascade nowhere should read as clean, not as unbuilt.
      available: summary.edges > 0,
      summary,
      cascades: result.cascades,
      total: result.total,
      page,
      pageSize,
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getAutomationCascades failed:", error);
    throw error;
  }
}

// The multi-rule picture: loops, and the chains that are not loops.
//
// This is what the cap made impossible rather than merely incomplete. A chain A -> B -> C is
// found by walking the edge set, and walking a set truncated at 150 finds chains that stop
// where the truncation did -- so the answer was not "fewer chains", it was "wrong chains".
//
// Computed on demand rather than stored. The walk is a few milliseconds over this site's
// 1,143 unique edges, and storing its output would mean a second thing to keep in step with
// the edges: a stored chain list and a re-imported estate can disagree, and a derived one
// cannot.
async function getCascadeGraph({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const maxDepth = Math.max(2, Math.min(MAX_CHAIN_DEPTH, Math.trunc(Number(payload?.maxDepth)) || MAX_CHAIN_DEPTH));

    const edges = await loadCascadeEdges(installationKey);
    if (!edges.length) return { available: false, reason: "no-cascades" };

    // Names are attached after the walk rather than carried through it. The graph only needs
    // ids, and joining 1,457 rows to the directory to compute something that uses ids would
    // be paying for names on every edge to render them on a few hundred.
    const analysis = analyzeCascadeGraph(edges, { maxDepth });
    const involved = new Set([
      ...analysis.loops.flatMap((loop) => loop.ruleIds),
      ...analysis.chains.flatMap((chain) => chain.ruleIds),
    ]);
    const directory = await loadRuleDirectoryFor(installationKey, [...involved]);

    const hydrate = (step) => ({
      ...step,
      name: directory.get(String(step.id))?.name ?? step.name,
      enabled: directory.get(String(step.id))?.enabled ?? null,
    });

    return {
      available: true,
      ruleCount: analysis.ruleCount,
      edgeCount: analysis.edgeCount,
      rulesInLoops: analysis.rulesInLoops,
      deepestChain: analysis.deepestChain,
      // Reported, never silent. A truncated answer presented as complete is worse than a
      // smaller one that says what it left out.
      truncated: analysis.truncated,
      maxDepth,
      loops: analysis.loops.map((loop) => ({
        ...loop,
        ruleNames: loop.ruleIds.map((id) => directory.get(String(id))?.name ?? id),
        path: loop.path.map(hydrate),
      })),
      chains: analysis.chains.map((chain) => ({ ...chain, steps: chain.steps.map(hydrate) })),
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getCascadeGraph failed:", error);
    throw error;
  }
}

// One page of rules ordered by blast radius, most first.
//
// The overview shows the tier histogram from the analysis document; this backs the
// sortable list and carries the factor breakdown so the drawer can explain a score without
// the raw rules it was built from.
async function getAutomationBlast({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const page = Math.max(1, Math.trunc(Number(payload?.page)) || 1);
    const pageSize = Math.max(1, Math.min(200, Math.trunc(Number(payload?.pageSize)) || 50));
    const tier = typeof payload?.tier === "string" ? payload.tier : null;
    const search = typeof payload?.search === "string" ? payload.search : "";

    const { rules, total } = await loadBlastRules(installationKey, {
      tier,
      search,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    return { available: total > 0 || page > 1, rules, total, page, pageSize };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getAutomationBlast failed:", error);
    throw error;
  }
}

// ── Remediation ticketing ──────────────────────────────────────────────────
//
// The one place Observatory writes to Jira. A governance finding becomes an epic in a
// project the admin configures, and each item to fix becomes a task under it. Every write
// is as the calling admin (attribution + their permissions), behind the read-only-mode
// gate, and audited. Idempotent: the epic is keyed on the finding and a task on the item,
// so re-running only fills in what is missing.

// A synchronous resolver creates a bounded batch. A finding with hundreds of items is
// finished by the queued job (a later change); this covers the common case in one click.
const MAX_SYNC_REMEDIATION_TASKS = 20;

async function getRemediationTickets({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const findingKey = payload?.findingKey ? String(payload.findingKey) : null;
  const tickets = await loadRemediationTickets(installationKey, findingKey);

  // Grouped by finding: the most recent quarter's epic and tasks, which is what the UI works
  // on, plus a one-line summary of each earlier quarter, so a finding that keeps coming back
  // reads as such. `isCurrent` says whether that latest epic is this quarter's -- if not, the
  // next "Create remediation" opens a new one. `open` counts anything not "done".
  const period = currentPeriod();
  const byFinding = new Map();
  for (const t of tickets) {
    if (!byFinding.has(t.findingKey)) byFinding.set(t.findingKey, { findingKey: t.findingKey, pillar: t.pillar, periods: new Map() });
    const f = byFinding.get(t.findingKey);
    if (!f.periods.has(t.period)) f.periods.set(t.period, { period: t.period, epic: null, tasks: [] });
    const p = f.periods.get(t.period);
    if (t.isEpic) p.epic = t;
    else p.tasks.push(t);
  }
  const openOf = (tasks) => tasks.filter((t) => t.lastStatusCategory !== "done").length;
  const groups = [...byFinding.values()].map((f) => {
    const periods = [...f.periods.values()].sort((a, b) => String(b.period).localeCompare(String(a.period)));
    const latest = periods[0];
    return {
      findingKey: f.findingKey,
      pillar: f.pillar,
      period: latest.period,
      isCurrent: latest.period === period,
      epic: latest.epic,
      tasks: latest.tasks,
      taskCount: latest.tasks.length,
      openCount: openOf(latest.tasks),
      previousPeriods: periods.slice(1).map((p) => ({
        period: p.period,
        epicKey: p.epic?.issueKey ?? null,
        epicStatusCategory: p.epic?.lastStatusCategory ?? null,
        taskCount: p.tasks.length,
        openCount: openOf(p.tasks),
      })),
    };
  });

  // The latest time the sync reached any ticket. Null means it never has, which the tab says in
  // those words rather than implying the tickets were checked and found untouched.
  const lastSyncedAt = tickets.reduce((latest, t) => (t.syncedAt && (!latest || t.syncedAt > latest) ? t.syncedAt : latest), null);

  // The catalog and the finding index travel with the tickets, so neither the Remediation tab
  // nor the Overview keeps its own copy of which playbooks exist or which finding each covers.
  return {
    available: tickets.length > 0,
    total: tickets.length,
    lastSyncedAt,
    period,
    groups,
    catalog: listPlaybookCatalog(),
    findingIndex: REMEDIATION_FINDING_INDEX,
  };
}

// Progress metrics for the Remediation tab: burn-down, throughput, time to close, ageing, and
// where the open work sits. The numbers come from computeRemediationMetrics, a pure function
// over the stored ticket rows; this only loads them. `scope` is "quarter" (default) or "all".
async function getRemediationMetrics({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const scope = payload?.scope === "all" ? "all" : "quarter";
  const tickets = await loadRemediationTickets(installationKey);
  const labels = Object.fromEntries(listPlaybookCatalog().map((entry) => [entry.key, entry.label]));
  return computeRemediationMetrics({ tickets, now: new Date(), period: currentPeriod(), scope, labels });
}

// "Sync now": queues the same job the scheduled trigger queues, run by the queue consumer,
// which has the time a few thousand tickets need and a resolver does not. It reads Jira and writes only
// Observatory's own rows, so it is not behind the read-only-mode gate -- the scheduled sync
// is not either.
async function syncRemediationNow({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  return queueRemediationSync(getInstallationKey(context));
}

async function createRemediationEpic({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const findingKey = String(payload?.findingKey || "").trim();
  const playbook = getPlaybook(findingKey);
  if (!playbook) return { error: `No remediation playbook for "${findingKey}".` };

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { error: "Read-only mode is enabled. Disable it before creating remediation tickets." };
  }

  const rc = adminConfig.remediation || {};
  if (!rc.projectKey) {
    return { error: "No remediation project is configured. Set one in Configuration → Remediation first." };
  }

  const accountId = callerAccountId(context);
  if (!accountId) return { error: "Could not identify the calling user, so the tickets would have no reporter." };

  const rawItems = Array.isArray(payload?.items) ? payload.items : [];
  const items = rawItems
    .filter((it) => it && (it.id != null || it.name))
    .map((it) => ({ ...it, id: String(it.id ?? it.name), name: it.name != null ? String(it.name).slice(0, 240) : null }));
  const pillar = payload?.pillar ? String(payload.pillar) : playbook.pillar;
  const nowIso = () => new Date().toISOString();
  // Every ticket links straight to what it is about. The invocation context carries the site
  // URL; serverInfo is the fallback. Neither is required -- without one, tickets go out unlinked.
  const origin = normalizeSiteOrigin(context?.siteUrl) || await getSiteBaseUrl();

  // One epic per finding per calendar quarter. Within the quarter a second click adds only
  // the tasks still missing; the next quarter starts a fresh epic carrying what is flagged
  // then (loadTicketedItemIds decides which items that is).
  const period = currentPeriod();
  let epic = await getRemediationEpic(installationKey, findingKey, period);
  let epicCreated = false;
  if (!epic) {
    try {
      const fields = {
        project: { key: rc.projectKey },
        issuetype: { name: rc.epicIssueType || "Epic" },
        summary: `${period}: ${playbook.epicSummary(items.length)}`.slice(0, 250),
        description: renderADF(playbook.epicDescription({ count: items.length, origin })),
        labels: playbook.labels,
        reporter: { id: accountId },
      };
      const created = await createJiraIssue(fields, { asUser: true });
      await recordRemediationTicket(installationKey, {
        findingKey, period, pillar, isEpic: true,
        issueKey: created.key, issueId: created.id, epicKey: created.key,
        summary: fields.summary, createdBy: accountId, createdAt: nowIso(),
      });
      epic = { issueKey: created.key, issueId: created.id };
      epicCreated = true;
    } catch (error) {
      return { error: `Creating the epic failed: ${error?.message || error}` };
    }
  }

  const alreadyTicketed = await loadTicketedItemIds(installationKey, findingKey, period);
  const todo = items.filter((it) => !alreadyTicketed.has(it.id));
  const batch = todo.slice(0, MAX_SYNC_REMEDIATION_TASKS);

  let tasksCreated = 0;
  const failures = [];
  for (const it of batch) {
    const fields = {
      project: { key: rc.projectKey },
      issuetype: { name: rc.taskIssueType || "Task" },
      summary: playbook.taskSummary(it).slice(0, 250),
      description: renderADF(playbook.taskDescription(it, { origin })),
      labels: playbook.labels,
      parent: { key: epic.issueKey },
      reporter: { id: accountId },
    };
    if (rc.defaultAssigneeAccountId) fields.assignee = { id: rc.defaultAssigneeAccountId };
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential on purpose: each task links
      // to the epic and issue creation is rate-limited and non-idempotent.
      const created = await createJiraIssue(fields, { asUser: true });
      // eslint-disable-next-line no-await-in-loop
      await recordRemediationTicket(installationKey, {
        findingKey, period, pillar, itemId: it.id,
        issueKey: created.key, issueId: created.id, epicKey: epic.issueKey,
        summary: fields.summary, createdBy: accountId, createdAt: nowIso(),
      });
      tasksCreated += 1;
    } catch (error) {
      failures.push({ itemId: it.id, error: String(error?.message || error) });
    }
  }

  logger.info("remediation.epic_created", {
    installationKey, findingKey, epicKey: epic.issueKey, epicCreated,
    tasksCreated, itemsTotal: items.length, failures: failures.length,
  });

  return {
    ok: true,
    epicKey: epic.issueKey,
    epicCreated,
    period,
    tasksCreated,
    itemsTotal: items.length,
    itemsRemaining: Math.max(0, todo.length - batch.length),
    failures,
  };
}

// The current items behind one remediation finding -- what "Create remediation" actually
// tickets. Every branch here re-reads the same snapshot rows the finding's own tab already
// loads (getUserInventory's roster, getBoardInventory's insights, getWorkflowInsights'
// orphans, getFieldInventory's governance findings) rather than re-deriving the join, so a
// finding and its remediation candidates can never disagree about what is currently flagged.
async function getRemediationCandidates({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  const findingKey = String(payload?.findingKey || "");

  if (findingKey === "filter-ownership") {
    const meta = await readFilterSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
    const filters = await loadFilters(installationKey, meta.version);
    const summary = summarizeFilters(filters);
    const items = summary.filters
      .filter((f) => f.findings.some((finding) => finding.code === "orphaned-owner"))
      .map((f) => ({
        id: String(f.id),
        name: f.name || null,
        ownerName: f.owner?.displayName || null,
        ownerActive: f.owner ? f.owner.active !== false : false,
        subscriptionCount: Number(f.subscriptionCount) || 0,
      }));
    return { available: true, items };
  }

  if (findingKey === "dashboard-ownership") {
    const meta = await readDashboardSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
    const dashboards = await loadDashboards(installationKey, meta.version);
    const summary = summarizeDashboards(dashboards);
    const items = summary.dashboards
      .filter((d) => d.findings.some((finding) => finding.code === "orphaned-owner"))
      .map((d) => ({
        id: String(d.id),
        name: d.name || null,
        ownerName: d.owner?.displayName || null,
        popularity: Number(d.popularity) || 0,
      }));
    return { available: true, items };
  }

  // Licensed accounts still sitting in a Jira access group after Jira deactivated them --
  // each one a paid seat and a login that returns with its old access intact if reactivated.
  // Same roster the People tab reads; a user is a candidate when it is both deactivated AND
  // still carries at least one licence-granting group (a deactivated account in no group is
  // not costing a seat, so it is not a remediation target).
  if (findingKey === "user-licence-hygiene") {
    const meta = await readUserSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
    const users = await loadUsers(installationKey, meta.version);
    const items = users
      .filter((u) => u.active === false && (u.groups || []).length > 0)
      .map((u) => ({
        id: u.accountId,
        accountId: u.accountId,
        displayName: u.displayName || null,
        groups: (u.groups || []).map((g) => g.name || g.id),
      }));
    return { available: true, items };
  }

  // Filters, dashboards and automation rules owned by an account that has fallen off the
  // licensed roster -- the account is gone or unlicensed, but Jira has not yet garbage-
  // collected what it owns. buildOwnershipIndex already carries the per-artifact id/name;
  // this just flattens the accounts not on the roster into one ticketable list.
  if (findingKey === "user-ownership") {
    const meta = await readUserSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
    const users = await loadUsers(installationKey, meta.version);
    const rosterIds = activeRosterIds(users);
    const ownership = await buildOwnershipIndex(installationKey);
    const items = [];
    for (const [accountId, owned] of ownership.byAccount) {
      if (rosterIds.has(accountId)) continue;
      for (const f of owned.filters) items.push({ id: `filter:${f.id}`, kind: "filter", name: f.name || null });
      for (const d of owned.dashboards) items.push({ id: `dashboard:${d.id}`, kind: "dashboard", name: d.name || null });
      for (const r of owned.rules) items.push({ id: `rule:${r.id}`, kind: "automation rule", name: r.name || null });
    }
    return { available: true, items };
  }

  // Statuses no workflow scheme reaches, no automation rule transitions into, AND no board
  // column maps -- the same basis the "status-reachability" health dimension scores, so the
  // epic's item count matches the number the finding itself reports. Requires the
  // scheme->status mapping; without it every status looks orphaned, which is why
  // status-reachability is unavailable rather than wrong in that case.
  if (findingKey === "status-reachability") {
    const meta = await readWorkflowSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
    const [statuses, schemeStatuses] = await Promise.all([
      loadStatusesCatalog(installationKey, meta.version),
      loadWorkflowSchemeStatuses(installationKey, meta.version),
    ]);
    if (schemeStatuses.length === 0) return { available: false, reason: "no-scheme-mapping", items: [] };
    const issueCounts = await loadStatusIssueCounts(installationKey).catch(() => new Map());
    const hasIssueCounts = issueCounts.size > 0;
    const provisional = findOrphanedStatuses(statuses, schemeStatuses, hasIssueCounts ? issueCounts : null);
    // A status only a rule reaches, only a board column maps, or only a saved filter's JQL
    // names is not safe to retire -- ask the same three sources rovoWorkflowImpact's
    // assessStatusDeletion checks before deciding, rather than treating "not yet checked" as
    // "nothing uses it". The filter check was missing here until now: a status a filter's
    // JQL still names could be auto-ticketed for retirement by this very playbook while the
    // status detail drawer, reading the same data through rovoWorkflowImpact, already said
    // "in use" -- two answers to the same question is exactly what a shared check prevents.
    const provisionalNames = provisional.map((o) => o.name).filter(Boolean);
    const [automationByStatus, boardStatusIds, filterMeta] = await Promise.all([
      provisionalNames.length
        ? loadStatusAutomationReferences(installationKey, provisionalNames).catch(() => null)
        : Promise.resolve(null),
      computeBoardStatusIds(installationKey).catch(() => null),
      readFilterSnapshotMeta(installationKey).catch(() => null),
    ]);
    const filterCountByStatus = filterMeta?.version && provisionalNames.length
      ? await loadFilterReferenceCounts(installationKey, filterMeta.version, "status", provisionalNames).catch(() => null)
      : null;
    const orphans = findOrphanedStatuses(statuses, schemeStatuses, hasIssueCounts ? issueCounts : null, automationByStatus, boardStatusIds);
    const items = orphans
      .filter((o) => !o.ruleOnly && !o.boardOnly)
      .filter((o) => !(filterCountByStatus && (filterCountByStatus[String(o.name || "").toLowerCase()] ?? 0) > 0))
      .map((o) => ({
        id: o.statusId,
        name: o.name,
        category: o.statusCategory,
        everCount: o.issueCount,
      }));
    return { available: true, items };
  }

  // Boards with no live backing filter -- none set, the filter was deleted, or the filter's
  // owner is deactivated. Column-mapping issues are a separate health dimension
  // ("board-columns") with no playbook, so they are deliberately excluded here even though
  // summarizeBoardInsights flags both kinds on the same board.
  if (findingKey === "board-backing") {
    const meta = await readBoardSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
    const [boards, columns, filterMeta] = await Promise.all([
      loadBoards(installationKey, meta.version),
      loadBoardColumns(installationKey, meta.version),
      readFilterSnapshotMeta(installationKey).catch(() => null),
    ]);
    const filters = filterMeta?.version ? await loadFilters(installationKey, filterMeta.version).catch(() => null) : null;
    const columnsByBoard = new Map();
    for (const col of columns) {
      if (!columnsByBoard.has(col.boardId)) columnsByBoard.set(col.boardId, []);
      columnsByBoard.get(col.boardId).push(col);
    }
    const rows = boards.map((board) => ({ ...board, columns: columnsByBoard.get(board.boardId) || [] }));
    const insights = summarizeBoardInsights({ boards: rows, filters });
    const BACKING_ISSUES = new Set(["no-backing-filter", "backing-filter-deleted", "backing-filter-owner-inactive"]);
    const items = insights.flagged
      .filter((b) => b.issues.some((code) => BACKING_ISSUES.has(code)))
      .map((b) => ({ id: b.boardId, name: b.name || null, type: b.type || null, issues: b.issues }));
    return { available: true, items };
  }

  // Custom fields with zero contexts, zero configuration and zero recorded issue usage --
  // the "orphaned" governance rule from analysis.js, read straight off the stored findings
  // JSON rather than re-run here, so the candidate list can never disagree with the badge
  // the Field Browser shows for the same field.
  const NO_ISSUE_CODES = new Set(["orphaned", "configured-no-issues"]);
  if (findingKey === "field-cleanup") {
    // Hydrated against the current thresholds, exactly as getAdminOverview counts the
    // finding -- the stored findings reflect whatever thresholds applied at scan time.
    const fields = await hydratedFields(installationKey);
    if (!fields) return { available: false, reason: "no-snapshot", items: [] };
    const items = fields
      // Stored findings are buildGovernanceFindings' object ({ reasons, tags, ... }), not a
      // list. This read `.some()` straight off that object and threw on every real site; the
      // unit test mocked an array, which is the only reason it ever passed.
      // Both codes the Overview's "no populated issues" finding counts, so the epic's task
      // count matches the number on the Overview.
      .filter((f) => (f.findings?.reasons || []).some((finding) => NO_ISSUE_CODES.has(finding.code)))
      .map((f) => ({
        id: f.id,
        name: f.name || null,
        type: f.type || null,
        description: f.description || null,
        reason: (f.findings.reasons.find((r) => NO_ISSUE_CODES.has(r.code)) || {}).code,
      }));
    return { available: true, items };
  }

  // Filters sharing identical JQL -- summarizeFilters already groups these for the tab
  // (duplicateGroups); this is that same computation, not a second one.
  if (findingKey === "filter-duplicates") {
    const meta = await readFilterSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
    const filters = await loadFilters(installationKey, meta.version);
    const summary = summarizeFilters(filters);
    const items = summary.duplicateGroups.map((g) => ({
      id: g.key,
      jql: g.jql,
      count: g.count,
      filters: g.filters,
    }));
    return { available: true, items };
  }

  // A filter's JQL naming a project or issue type the site does not define -- the two
  // "references something that doesn't exist" findings summarizeFilters already computes,
  // folded into one playbook since the fix (correct the JQL) is the same shape for both.
  // Needs the project catalog and the issue type catalog to join against; each degrades to
  // "not checked" independently, matching summarizeFilters' own projectsChecked/typesChecked
  // tri-state.
  if (findingKey === "filter-scope") {
    const meta = await readFilterSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
    const filters = await loadFilters(installationKey, meta.version);

    const fieldMeta = await readSnapshotMeta(installationKey).catch(() => null);
    let projectKeys = null;
    if (fieldMeta?.version) {
      const projects = await listSnapshotProjects(installationKey, fieldMeta.version).catch(() => []);
      if (projects.length) projectKeys = new Set(projects.flatMap((p) => [p.projectKey, p.projectName]).filter(Boolean));
    }

    const itMeta = await readIssueTypeSnapshotMeta(installationKey).catch(() => null);
    let typeNames = null;
    if (itMeta?.version) {
      const types = await loadIssueTypes(installationKey, itMeta.version).catch(() => []);
      if (types.length) typeNames = new Set(types.map((t) => String(t.name || "").toLowerCase()).filter(Boolean));
    }

    if (!projectKeys && !typeNames) return { available: false, reason: "no-catalog", items: [] };

    const summary = summarizeFilters(filters, { projectKeys, typeNames });
    const items = [
      ...summary.brokenProjects.map((f) => ({ id: `${f.id}:project`, name: f.name, ownerName: f.ownerName, missing: f.missing, refKind: "project" })),
      ...summary.unknownTypeRefs.map((f) => ({ id: `${f.id}:type`, name: f.name, ownerName: f.ownerName, missing: f.missing, refKind: "type" })),
    ];
    return { available: true, items };
  }

  // A field configured for a project (it is in the field's context) but on no screen that
  // project's issue types route to -- getScreenFieldCrossSignal is the widest join in the
  // app and already computes this for the tab; called directly rather than re-derived here.
  if (findingKey === "screen-unreachable-fields") {
    const cross = await getScreenFieldCrossSignal({ payload: {}, context }).catch(() => null);
    if (!cross?.available) return { available: false, reason: cross ? "no-snapshot" : "error", items: [] };
    const items = (cross.unreachableFields || []).map((f) => ({ id: f.fieldId, fieldId: f.fieldId, fieldName: f.fieldName }));
    return { available: true, items };
  }

  // Issue types on no scheme at all. getIssueTypeInventory computes two different
  // "governance" things: `.governance` is aggregate counts from SQL (loadIssueTypeGovernance
  // Summary, for the health score), and `.governanceFindings` is the live per-item
  // computation (summarizeIssueTypeInsights, for the tab) that actually carries the list --
  // this reads the second one, the same one the Issue Types tab does.
  if (findingKey === "issue-type-reach") {
    const inv = await getIssueTypeInventory({ context });
    if (inv.neverBuilt || !inv.version) return { available: false, reason: "no-snapshot", items: [] };
    const items = (inv.governanceFindings?.orphanTypes || []).map((t) => ({ id: t.id, name: t.name, subtask: t.subtask }));
    return { available: true, items };
  }

  // Issue types sharing an identical, spacing-only, or single-character-different name --
  // same governanceFindings computation as above, a different list on it.
  if (findingKey === "issue-type-naming") {
    const inv = await getIssueTypeInventory({ context });
    if (inv.neverBuilt || !inv.version) return { available: false, reason: "no-snapshot", items: [] };
    const items = (inv.governanceFindings?.duplicateGroups || []).map((g) => ({ id: g.key, key: g.key, kind: g.kind, count: g.count, types: g.types }));
    return { available: true, items };
  }

  // JSM Assets schemas with no object types or no objects -- getAssetInventory's own
  // governance summary already computes this for the tab.
  if (findingKey === "asset-schema-hygiene") {
    const inv = await getAssetInventory({ context });
    if (!inv.governance?.available) return { available: false, reason: inv.assetsEnabled === false ? "assets-not-enabled" : "no-snapshot", items: [] };
    const items = (inv.governance.deadSchemas || []).map((s) => ({
      id: s.id, name: s.name, reason: s.reason, objectTypeCount: s.objectTypeCount, objectCount: s.objectCount,
    }));
    return { available: true, items };
  }

  // Non-abstract JSM Assets object types carrying zero objects in the last measured crawl --
  // same governance summary, gated on the object-count crawl having ever run (countsMeasured)
  // since an unmeasured type must never render as an empty one.
  if (findingKey === "asset-type-usage") {
    const inv = await getAssetInventory({ context });
    if (!inv.governance?.available) return { available: false, reason: inv.assetsEnabled === false ? "assets-not-enabled" : "no-snapshot", items: [] };
    if (!inv.governance.countsMeasured) return { available: false, reason: "no-object-count-crawl", items: [] };
    const items = (inv.governance.emptyObjectTypes || []).map((t) => ({ id: t.id, name: t.name, schemaId: t.schemaId }));
    return { available: true, items };
  }

  const loader = REMEDIATION_CANDIDATE_LOADERS[findingKey];
  if (loader) return loader({ installationKey, context });

  return { available: false, reason: "not-connected", items: [] };
}

// Candidate loaders for the playbooks built on definePlaybook. A map rather than more
// branches above: each entry reads the same inventory its pillar's tab reads, so a finding's
// count and its epic's task count come from one computation. Items carry the fields the
// playbook's task template and links use.
async function accessGovernance(context) {
  const inv = await getAccessInventory({ context }, { listLimit: Infinity });
  return inv.neverBuilt ? null : inv;
}
const ACCESS_UNAVAILABLE = { available: false, reason: "no-snapshot", items: [] };

const REMEDIATION_CANDIDATE_LOADERS = {
  "permission-risky": async ({ context }) => {
    const inv = await accessGovernance(context);
    if (!inv) return ACCESS_UNAVAILABLE;
    return { available: true, items: inv.permissions.governance.riskySchemes.map((sc) => ({ ...sc, id: String(sc.id) })) };
  },

  "access-unused-schemes": async ({ context }) => {
    const inv = await accessGovernance(context);
    if (!inv) return ACCESS_UNAVAILABLE;
    const tag = (type, list) => list.map((sc) => ({ id: `${type}:${sc.id}`, type, schemeId: String(sc.id), name: sc.name }));
    return {
      available: true,
      items: [
        ...tag("permission", inv.permissions.governance.unusedSchemes),
        ...tag("security", inv.security.governance.unusedSchemes),
        ...tag("notification", inv.notifications.governance.unusedSchemes),
      ],
    };
  },

  "security-broken-levels": async ({ context }) => {
    const inv = await accessGovernance(context);
    if (!inv) return ACCESS_UNAVAILABLE;
    const g = inv.security.governance;
    return {
      available: true,
      items: [
        ...(g.noLevelSchemes || []).map((sc) => ({ id: `scheme:${sc.id}`, kind: "no-levels", schemeId: String(sc.id), schemeName: sc.name })),
        ...(g.emptyLevels || []).map((l) => ({ id: `level:${l.schemeId}:${l.levelId}`, kind: "empty-level", schemeId: String(l.schemeId), schemeName: l.schemeName, levelId: String(l.levelId), levelName: l.levelName })),
      ],
    };
  },

  "notification-fragile": async ({ context }) => {
    const inv = await accessGovernance(context);
    if (!inv) return ACCESS_UNAVAILABLE;
    return { available: true, items: inv.notifications.governance.fragileSchemes.map((sc) => ({ ...sc, id: String(sc.id) })) };
  },

  "role-empty-admin": async ({ context }) => {
    const inv = await accessGovernance(context);
    if (!inv) return ACCESS_UNAVAILABLE;
    return {
      available: true,
      items: inv.roles.governance.projectsMissingAdminActor.map((p) => ({ id: String(p.projectId ?? p.projectKey), projectKey: p.projectKey, role: p.role })),
    };
  },

  // Bounded: grouped by project (bundled past 50), per the playbook's granularity.
  "role-offroster-actors": async ({ context }) => {
    const inv = await accessGovernance(context);
    if (!inv) return ACCESS_UNAVAILABLE;
    const groups = groupBounded(inv.roles.governance.offRosterMemberships, { keyOf: (m) => m.projectKey, max: 50 });
    return { available: true, items: groups };
  },
  // ── Filters and dashboards: the same analysis their tabs run, every row ──
  "filters-zombie-subscriptions": ({ installationKey }) => filterItemsWith(installationKey, "subscribed-but-unused"),
  "filters-shared-everyone": ({ installationKey }) => filterItemsWith(installationKey, "shared-with-everyone"),
  "filters-public": ({ installationKey }) => filterItemsWith(installationKey, "shared-publicly"),
  "people-dormant-licences": async ({ context }) => {
    const inv = await getUserInventory({ context });
    if (inv.neverBuilt) return { available: false, reason: "no-roster", items: [] };
    if (!inv.governance?.activityMeasured) return { available: false, reason: "no-activity", items: [] };
    return {
      available: true,
      items: inv.users.filter((u) => u.dormant === true).map((u) => ({
        id: u.accountId,
        accountId: u.accountId,
        displayName: u.displayName,
        lastActivityAt: u.lastActivityAt,
        products: (u.applications || []).map((a) => a.name),
        groups: (u.groups || []).map((g) => g.name),
        ownedCount: (u.ownedFilters || 0) + (u.ownedDashboards || 0) + (u.authoredRules || 0),
      })),
    };
  },
  "dashboards-public": ({ installationKey }) => dashboardItemsWith(installationKey, "shared-publicly"),
  "dashboards-broken-gadgets": ({ installationKey }) => dashboardItemsWith(installationKey, "broken-gadget"),
  "dashboards-open-edit": ({ installationKey }) => dashboardItemsWith(installationKey, "editable-by-everyone"),
  "dashboards-empty": ({ installationKey }) => dashboardItemsWith(installationKey, "empty"),
  "dashboards-published-unused": ({ installationKey }) => dashboardItemsWith(installationKey, "published-unused"),

  // One item per off-roster account an automation rule names, with the rules that name it --
  // the same join getUserInventory counts and getUserDetails lists.
  "people-offroster-automation-refs": async ({ installationKey }) => {
    const meta = await readUserSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
    const [users, userIndex, directory] = await Promise.all([
      loadUsers(installationKey, meta.version),
      readAutomationPart(installationKey, "users").catch(() => null),
      readAutomationPart(installationKey, "directory").catch(() => null),
    ]);
    if (!userIndex) return { available: false, reason: "no-automation-index", items: [] };
    const roster = activeRosterIds(users);
    const items = (userIndex.entries || [])
      .map((e) => String(e.label))
      .filter((accountId) => !roster.has(accountId))
      .map((accountId) => {
        const rules = collectRuleUserReferences(accountId, userIndex, directory);
        return { id: accountId, accountId, ruleCount: rules.length, rules };
      })
      .filter((it) => it.ruleCount > 0);
    return { available: true, items };
  },

  "issue-type-hierarchy": async ({ installationKey, context }) => {
    const insights = await issueTypeInsightsFull(installationKey, context);
    if (!insights) return { available: false, reason: "no-snapshot", items: [] };
    return {
      available: true,
      items: insights.flaggedSchemes.map((sc) => ({
        id: sc.schemeId, schemeId: sc.schemeId, name: sc.name, projectCount: sc.projectCount, flags: sc.flags.map((f) => f.message),
      })),
    };
  },

  "issue-type-unused-schemes": async ({ installationKey, context }) => {
    const insights = await issueTypeInsightsFull(installationKey, context);
    if (!insights) return { available: false, reason: "no-snapshot", items: [] };
    return { available: true, items: insights.unusedSchemes.map((sc) => ({ id: sc.schemeId, schemeId: sc.schemeId, name: sc.name })) };
  },

  "estate-duplicate-priorities": ({ context }) => estateGroups(context, "priorityDuplicateGroups"),
  "estate-duplicate-resolutions": ({ context }) => estateGroups(context, "resolutionDuplicateGroups"),

  "asset-broken-references": async ({ context }) => {
    const a = await assetInsightsFull(context);
    if (!a.available) return a.result;
    const attrById = new Map(a.inv.attributes.map((x) => [String(x.id), x]));
    const typeById = new Map(a.inv.objectTypes.map((t) => [String(t.id), t]));
    return {
      available: true,
      items: a.insights.brokenReferences.map((r) => ({
        ...r,
        schemaId: attrById.get(String(r.id))?.schemaId ?? typeById.get(String(r.objectTypeId))?.schemaId ?? null,
        objectTypeName: typeById.get(String(r.objectTypeId))?.name ?? null,
      })),
    };
  },
  "asset-broken-hierarchy": async ({ context }) => {
    const a = await assetInsightsFull(context);
    return a.available ? { available: true, items: a.insights.brokenHierarchy } : a.result;
  },
  "asset-bare-types": async ({ context }) => {
    const a = await assetInsightsFull(context);
    return a.available ? { available: true, items: a.insights.bareTypes } : a.result;
  },
};

// ── Fields, workflows, projects, screens, automation ───────────────────────

Object.assign(REMEDIATION_CANDIDATE_LOADERS, {
  "field-admin-attention": ({ installationKey }) => fieldItems(installationKey, (f) => (f.findings?.tags?.adminAttention ? f.findings.reasons : null)),
  "field-risky": ({ installationKey }) => fieldItems(installationKey, (f) => (f.findings?.tags?.risky ? f.findings.reasons.filter((r) => r.category === "risky") : null)),
  "field-global-context-low-usage": ({ installationKey }) => fieldItems(installationKey, reasonsWithCode("global-context-low-usage")),
  "field-dead-configuration": ({ installationKey }) => fieldItems(installationKey, reasonsWithCode("dead-configuration")),
  "field-stale": ({ installationKey }) => fieldItems(installationKey, reasonsWithCode("stale")),
  "field-context-sprawl": ({ installationKey }) => fieldItems(installationKey, reasonsWithCode("context-sprawl")),
  "field-missing-description": ({ installationKey }) => fieldItems(installationKey, reasonsWithCode("missing-description")),

  "workflow-duplicate-statuses": ({ installationKey }) => workflowItems(installationKey, (w) => w.duplicateGroups.map((g) => ({
    id: g.key,
    key: g.key,
    kind: g.kind,
    count: g.count,
    statuses: g.statuses.map((st) => {
      const statusId = String(st.statusId ?? st.id);
      return { statusId, name: st.name, issueCount: w.hasIssueCounts ? Number(w.issueCounts.get(statusId) ?? 0) : null };
    }),
  }))),
  "rule-only-statuses": ({ installationKey }) => workflowItems(installationKey, (w) => w.orphans
    .filter((o) => o.ruleOnly)
    .map((o) => ({ id: String(o.statusId), name: o.name, automationRuleCount: o.automationRuleCount ?? null, issueCount: o.issueCount ?? null }))),
  "unreachable-with-issues": ({ installationKey }) => workflowItems(installationKey, (w) => w.orphans
    .filter((o) => !o.ruleOnly && (o.issueCount ?? 0) > 0)
    .map((o) => ({ id: String(o.statusId), name: o.name, issueCount: o.issueCount }))),
  // ── Field schemes / configurations: all three from the stored findings ──
  "fieldconfig-required-hidden": async ({ context }) => {
    const inv = await getFieldConfigInventory({ context });
    if (inv.neverBuilt) return { available: false, reason: "no-snapshot", items: [] };
    return {
      available: true,
      items: inv.configs.filter((c) => c.requiredHidden.length).map((c) => ({
        id: c.id, sourceId: c.sourceId, name: c.name,
        fieldNames: c.requiredHidden.map((f) => f.fieldName),
        usedBy: (c.routes || []).map((r) => `${r.schemeName} (${r.workTypeName})`),
      })),
    };
  },
  "fieldconfig-unused": async ({ context }) => {
    const inv = await getFieldConfigInventory({ context });
    if (inv.neverBuilt) return { available: false, reason: "no-snapshot", items: [] };
    const pick = (rows, kind) => rows.filter((r) => r.codes.includes("unused")).map((r) => ({ id: r.id, sourceId: r.sourceId, name: r.name, kind }));
    return { available: true, items: [...pick(inv.schemes, "scheme"), ...pick(inv.configs, "config")] };
  },
  "fieldconfig-duplicates": async ({ context }) => {
    const inv = await getFieldConfigInventory({ context });
    if (inv.neverBuilt) return { available: false, reason: "no-snapshot", items: [] };
    const groups = [];
    for (const [rows, kind] of [[inv.schemes, "scheme"], [inv.configs, "config"]]) {
      const byId = new Map(rows.map((r) => [r.id, r]));
      const byKeep = new Map();
      for (const row of rows) {
        if (!row.duplicateOf) continue;
        if (!byKeep.has(row.duplicateOf)) byKeep.set(row.duplicateOf, [row.duplicateOf]);
        byKeep.get(row.duplicateOf).push(row.id);
      }
      for (const [keep, members] of byKeep) {
        groups.push({
          id: `${kind}:${keep}`, kind, keep, keepName: byId.get(keep)?.name || keep, members,
          memberNames: members.map((m) => byId.get(m)?.name || m),
          memberSourceIds: members.map((m) => byId.get(m)?.sourceId || null),
          name: byId.get(keep)?.name || keep, count: members.length,
        });
      }
    }
    return { available: true, items: groups };
  },
  "workflow-broken-references": async ({ context }) => {
    const insights = await getWorkflowRuleInsights({ context });
    if (!insights.available) return { available: false, reason: insights.reason, items: [] };
    const byWorkflow = new Map();
    for (const ref of insights.brokenRefs) {
      if (!byWorkflow.has(ref.workflowName)) byWorkflow.set(ref.workflowName, []);
      byWorkflow.get(ref.workflowName).push({
        type: ref.type,
        id: ref.id,
        where: ref.status ? `status ${ref.status.name}` : `transition ${ref.transitionId}`,
      });
    }
    return {
      available: true,
      items: [...byWorkflow.entries()].map(([name, refs]) => ({ id: name, name, count: refs.length, refs })),
    };
  },
  "workflows-inactive": async ({ context }) => {
    const insights = await getWorkflowRuleInsights({ context });
    if (!insights.available) return { available: false, reason: insights.reason, items: [] };
    return {
      available: true,
      items: insights.inactive.map((w) => ({ id: w.name, name: w.name, statusCount: w.statusCount, ruleCount: w.ruleCount })),
    };
  },
  "workflow-scheme-structure": ({ installationKey }) => workflowItems(installationKey, (w) => w.balance
    .filter((b) => b.flags.length > 0)
    .map((b) => ({ id: b.schemeId, name: b.name, projectCount: b.projectCount, flags: b.flags.map((f) => f.message) }))),

  "project-over-configured": ({ installationKey }) => projectItems(installationKey, ({ insights }) => {
    const idle = new Set(insights.idleOverConfigured.map((p) => p.projectKey));
    return insights.overConfigured.map((p) => ({ id: p.projectKey, ...p, idle: idle.has(p.projectKey) }));
  }),
  "unused-projects": ({ installationKey }) => projectItems(installationKey, ({ insights }) => insights.unusedProjects.map((p) => ({ id: p.projectKey, ...p }))),
  "stale-projects": ({ installationKey }) => projectItems(installationKey, ({ insights }) => insights.staleProjects.map((p) => ({ id: p.projectKey, ...p }))),
  "projects-fell-off": ({ installationKey }) => projectItems(installationKey, ({ adoption }) => adoptionFlagged(adoption, "fellOff")),
  "projects-never-adopted": ({ installationKey }) => projectItems(installationKey, ({ adoption }) => adoptionFlagged(adoption, "neverAdopted")),

  "screen-empty": ({ installationKey }) => screenItems(installationKey, "empty"),
  "screen-unresolved": ({ installationKey }) => screenItems(installationKey, "unresolved"),
  "screen-unreached": ({ installationKey }) => screenItems(installationKey, "unreached", { needsWorkflow: true }),
  "screen-transition-only": ({ installationKey }) => screenItems(installationKey, "transition-only", { needsWorkflow: true }),
  // One task per screen scheme, listing each operation that points at a missing screen.
  "screen-dangling": async ({ installationKey }) => {
    const meta = await readScreenSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
    const [ops, schemes] = await Promise.all([
      loadScreenSchemeOperations(installationKey, meta.version),
      loadScreenSchemes(installationKey, meta.version),
    ]);
    const names = new Map(schemes.map((sc) => [String(sc.schemeId), sc.name]));
    const bySchemeId = new Map();
    for (const op of ops.filter((o) => o.dangling)) {
      const id = String(op.schemeId);
      if (!bySchemeId.has(id)) bySchemeId.set(id, { id, name: names.get(id) || null, operations: [] });
      bySchemeId.get(id).operations.push({ operation: op.operation, screenId: op.screenId || null });
    }
    return { available: true, items: [...bySchemeId.values()] };
  },
  "screen-unused-schemes": async ({ installationKey }) => {
    const meta = await readScreenSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
    const schemes = await loadScreenSchemes(installationKey, meta.version);
    return { available: true, items: schemes.filter((sc) => (sc.issueTypeSchemeCount ?? 0) === 0).map((sc) => ({ id: String(sc.schemeId), name: sc.name })) };
  },

  "automation-disabled": async ({ installationKey }) => {
    const directory = await readAutomationPart(installationKey, "directory").catch(() => null);
    if (!directory) return { available: false, reason: "no-automation-index", items: [] };
    return { available: true, items: [...hydrateRuleDirectory(directory).values()].filter((r) => !r.enabled) };
  },
  "automation-credentials": ({ installationKey }) => automationRiskItems(installationKey, "embedded-credential", "credentialRuleCount"),
  "automation-external": ({ installationKey }) => automationRiskItems(installationKey, "external-http", "externalHttpCount"),
  "automation-inert": ({ installationKey }) => automationRiskItems(installationKey, "no-actions", "noActionCount"),
  "automation-self-triggering": async ({ installationKey }) => {
    const [analysis, directory] = await Promise.all([
      readAutomationAnalysis(installationKey).catch(() => null),
      readAutomationPart(installationKey, "directory").catch(() => null),
    ]);
    if (!analysis) return { available: false, reason: "no-analysis", items: [] };
    const rules = directory ? hydrateRuleDirectory(directory) : new Map();
    const seen = new Map();
    for (const c of analysis.cascades || []) {
      if (!c.selfTriggering || seen.has(String(c.sourceId))) continue;
      const rule = rules.get(c.sourceId) || rules.get(Number(c.sourceId)) || {};
      seen.set(String(c.sourceId), { ...rule, id: c.sourceId, name: rule.name || c.sourceName || null });
    }
    return partialOf([...seen.values()], analysis.estate?.health?.selfTriggeringCount);
  },
});

// Every field, hydrated for governance against the CURRENT thresholds -- the computation
// getAdminOverview's field counts come from, so each field epic matches its Overview number.
async function hydratedFields(installationKey) {
  const meta = await readSnapshotMeta(installationKey).catch(() => null);
  if (!meta?.version) return null;
  const [fields, config] = await Promise.all([loadSnapshotFields(installationKey, meta.version), readAdminConfig()]);
  const dup = buildDuplicateNameCountMap(fields);
  return fields.map((f) => hydrateFieldForGovernance(f, null, dup.get(normalizeFieldName(f.name)) ?? 1, config.governanceThresholds));
}

const reasonsWithCode = (code) => (f) => {
  const hits = (f.findings?.reasons || []).filter((r) => r.code === code);
  return hits.length ? hits : null;
};

// `reasonsOf(field)` returns the reasons that put the field in this finding, or null.
async function fieldItems(installationKey, reasonsOf) {
  const fields = await hydratedFields(installationKey);
  if (!fields) return { available: false, reason: "no-snapshot", items: [] };
  const items = [];
  for (const f of fields) {
    const reasons = reasonsOf(f);
    if (!reasons) continue;
    items.push({
      id: f.id,
      name: f.name || null,
      type: f.type || null,
      configuredProjectCount: f.configuredProjectCount ?? null,
      totalIssueCount: f.totalIssueCount ?? null,
      reasons: reasons.map((r) => r.title || r.detail || r.code),
    });
  }
  return { available: true, items };
}

async function workflowItems(installationKey, pick) {
  const meta = await readWorkflowSnapshotMeta(installationKey).catch(() => null);
  if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
  const w = await computeWorkflowInsightsFull(installationKey, meta.version);
  if (!w.schemeStatusesAvailable) return { available: false, reason: "no-scheme-mapping", items: [] };
  return { available: true, items: pick(w) };
}

async function projectItems(installationKey, pick) {
  const meta = await readSnapshotMeta(installationKey).catch(() => null);
  if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
  const projects = await attachUniqueIssueCounts(installationKey, await listSnapshotProjects(installationKey, meta.version));
  const activity = await loadProjectActivity(installationKey)
    .catch(fallbackOn("remediation.project_activity_load_failed", () => new Map(), { installationKey }));
  return {
    available: true,
    items: pick({ insights: buildProjectInsights(projects, { listLimit: Infinity }), adoption: summarizeAdoption(projects, activity) }),
  };
}

// The adoption flags, on exactly the terms the Overview counts them: judged projects only
// (measured, old enough), and nothing at all while the activity data is stale.
function adoptionFlagged(adoption, flag) {
  if (!adoption?.available || adoption.dataStale) return [];
  return adoption.projects
    .filter((p) => p.measured && p.oldEnough && p[flag])
    .map((p) => ({
      id: p.projectKey,
      projectKey: p.projectKey,
      projectName: p.projectName,
      issuesPerDay: p.issuesPerDay != null ? Math.round(p.issuesPerDay * 100) / 100 : null,
      recentIssuesPerDay: p.recentIssuesPerDay != null ? Math.round(p.recentIssuesPerDay * 100) / 100 : null,
      peakMonth: p.peakMonth || null,
      ageDays: p.ageDays ?? null,
    }));
}

async function screenItems(installationKey, filter, { needsWorkflow = false } = {}) {
  const meta = await readScreenSnapshotMeta(installationKey).catch(() => null);
  if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
  const workflowMeta = await readWorkflowSnapshotMeta(installationKey).catch(() => null);
  // A screen a transition opens is in use, so "unreached" needs a snapshot that read them.
  const workflowVersion = transitionAwareWorkflowVersion(workflowMeta);
  if (needsWorkflow && !workflowVersion) {
    return { available: false, reason: workflowMeta?.version ? "transitions-unknown" : "no-workflow-snapshot", items: [] };
  }
  const rows = await loadAllScreenPages(installationKey, meta.version, { workflowVersion, filter });
  return { available: true, items: rows.map((r) => ({ id: String(r.screenId), name: r.name, tabCount: r.tabCount, fieldCount: r.fieldCount })) };
}

// The stored analysis keeps a preview of the highest-severity rules, not every flagged
// rule. `partial` and `expected` say so, so the tab can state how many are not listed
// rather than present the preview as the whole finding.
async function automationRiskItems(installationKey, riskCode, countKey) {
  const analysis = await readAutomationAnalysis(installationKey).catch(() => null);
  if (!analysis) return { available: false, reason: "no-analysis", items: [] };
  const items = (analysis.findingsPreview || [])
    .filter((f) => (f.r || []).some((r) => r.c === riskCode))
    .map((f) => ({
      id: f.id,
      name: f.n || null,
      enabled: f.e === 1,
      triggerType: f.t || null,
      projectCount: f.p ?? null,
      hosts: (f.r || []).find((r) => r.c === riskCode)?.h || [],
    }));
  return partialOf(items, analysis.estate?.health?.[countKey]);
}

function partialOf(items, expected) {
  const total = Number(expected);
  return Number.isFinite(total) && total > items.length
    ? { available: true, partial: true, expected: total, items }
    : { available: true, items };
}

async function filterItemsWith(installationKey, code) {
  const meta = await readFilterSnapshotMeta(installationKey).catch(() => null);
  if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
  const { withFindings } = await loadFiltersWithFindings(installationKey, meta.version);
  const items = withFindings
    .filter((f) => (f.findings || []).some((x) => x.code === code))
    .map((f) => ({
      id: String(f.id),
      name: f.name || null,
      ownerName: f.owner?.displayName || f.ownerName || null,
      subscriptionCount: Number(f.subscriptionCount) || 0,
      favouritedCount: Number(f.favouritedCount) || 0,
      lastUsedAt: f.lastUsedAt || null,
    }));
  return { available: true, items };
}

async function dashboardItemsWith(installationKey, code) {
  const meta = await readDashboardSnapshotMeta(installationKey).catch(() => null);
  if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
  const summary = summarizeDashboards(await loadDashboards(installationKey, meta.version));
  const items = summary.dashboards
    .filter((d) => (d.findings || []).some((x) => x.code === code))
    .map((d) => ({
      id: String(d.id),
      name: d.name || null,
      ownerName: d.owner?.displayName || d.ownerName || null,
      popularity: Number(d.popularity) || 0,
      gadgetCount: d.gadgetCount ?? null,
      // The broken gadgets themselves, for the broken-gadget playbook; empty for the rest.
      brokenGadgets: (d.findings || []).find((x) => x.code === "broken-gadget")?.gadgets || [],
    }));
  return { available: true, items };
}

// The issue type findings, uncapped. getIssueTypeInventory does not return the flat scheme
// membership, so it is read alongside -- the same pairing the issue types pillar report uses.
async function issueTypeInsightsFull(installationKey, context) {
  const inv = await getIssueTypeInventory({ context });
  if (inv.neverBuilt || !inv.version) return null;
  const schemeItems = await loadIssueTypeSchemeItems(installationKey, inv.version);
  return summarizeIssueTypeInsights({ types: inv.issueTypes, schemes: inv.schemes, schemeItems, listLimit: Infinity });
}

async function estateGroups(context, listKey) {
  const inv = await getEstateInventory({ context });
  if (inv.neverBuilt) return { available: false, reason: "no-snapshot", items: [] };
  const insights = summarizeEstateInsights({ resolutions: inv.resolutions, priorities: inv.priorities, listLimit: Infinity });
  return { available: true, items: insights[listKey].map((g) => ({ id: g.key, ...g })) };
}

async function assetInsightsFull(context) {
  const inv = await getAssetInventory({ context });
  if (inv.assetsEnabled === false) return { available: false, result: { available: false, reason: "assets-not-enabled", items: [] } };
  if (!inv.governance?.available) return { available: false, result: { available: false, reason: "no-snapshot", items: [] } };
  const insights = summarizeAssetInsights({
    schemas: inv.schemas, objectTypes: inv.objectTypes, attributes: inv.attributes, typeCounts: inv.typeCounts || [], assetsEnabled: true, listLimit: Infinity,
  });
  return { available: true, inv, insights };
}

// Which rules reference one status, by direction.
//
// The Workflows tab has been able to say "17 rules" against an unreachable status since the
// references moved to SQL, and a count is where the question starts rather than where it
// ends: an admin looking at a status they want to delete needs the rule names, and needs to
// know whether a rule TRANSITIONS INTO it -- which keeps it alive -- or merely reads it in a
// condition, which does not.
async function getStatusAutomationUsage({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const statusName = String(payload?.statusName ?? "").trim();
    if (!statusName) throw new Error("statusName is required");

    const hit = await loadAutomationReferencesFor(installationKey, "status", statusName)
      .catch(fallbackOn("automation.sql_status_reference_read_failed", () => null, { installationKey }));

    // No analysis and no references are different answers. "No rule touches this status" is
    // permission to delete it; "we have not looked" is not, and this pillar exists because
    // the two used to be indistinguishable.
    if (!hit) return { available: false, reason: "no-analysis", label: statusName };

    const group = (direction) => {
      const rows = hit.references.filter((r) => r.direction === direction);
      return {
        count: rows.length,
        rules: rows.map((r) => ({
          id: r.rule_id,
          name: r.name ?? `Rule ${r.rule_id}`,
          enabled: r.enabled === null || r.enabled === undefined ? null : r.enabled === 1,
        })),
      };
    };

    return {
      available: true,
      label: statusName,
      referenced: hit.total > 0,
      ruleCount: hit.ruleCount,
      // Direction is the whole point. A rule that transitions INTO a status keeps it in use;
      // one that reads it in a condition breaks if it disappears but does not keep it alive.
      write: group("write"),
      read: group("read"),
      trigger: group("trigger"),
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getStatusAutomationUsage failed:", error);
    throw error;
  }
}


// A rule that creates an issue of a type, or scopes its trigger to one, names that type by
// numeric id -- only conditions and JQL carry the display name. So the issue-type index
// arrives labelled with a mix of ids and names, and the tab was rendering "10022" where the
// Issue Types tab says "Incident". Resolved here, against the issue-type inventory, rather
// than in the browser-side analysis: the id -> name map is the inventory's to own, and the
// analysis pipeline is shared with the backend importer which has no reason to load it.
//
// Relabelling can collide -- one rule referencing a type by id and another by name produces
// two entries that are the same type -- so entries that land on the same name are merged.
// Swap each entry's id label for a human name from `nameById`, merging any entries that
// land on the same name (an issue type a rule referenced by id AND another by name; two
// accounts that share a display name). Shared by the issue-type and user index resolvers.
function relabelIndexEntries(entries, nameById) {
  if (!nameById.size) return entries;
  const merged = new Map();
  for (const entry of entries) {
    const label = nameById.get(String(entry.label)) ?? entry.label;
    const key = String(label).toLowerCase();
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...entry, label });
      continue;
    }
    for (const dir of ["write", "read", "trigger"]) {
      existing[dir] = [...new Set([...(existing[dir] ?? []), ...(entry[dir] ?? [])])].slice(0, 50);
      existing[`${dir}Count`] = (existing[`${dir}Count`] ?? 0) + (entry[`${dir}Count`] ?? 0);
    }
    existing.total = existing.writeCount + existing.readCount + existing.triggerCount;
    existing.ruleCount = new Set([...existing.write, ...existing.read, ...existing.trigger]).size;
    existing.enabledRules = (existing.enabledRules ?? 0) + (entry.enabledRules ?? 0);
    existing.disabledRules = (existing.disabledRules ?? 0) + (entry.disabledRules ?? 0);
  }
  return [...merged.values()].sort((a, b) => b.total - a.total || String(a.label).localeCompare(String(b.label)));
}

async function resolveIssueTypeIndexLabels(installationKey, entries) {
  const meta = await readIssueTypeSnapshotMeta(installationKey).catch(() => null);
  if (!meta?.version) return entries;
  const types = await loadIssueTypes(installationKey, meta.version).catch(() => []);
  const nameById = new Map(types.map((t) => [String(t.id), t.name]).filter(([, name]) => name));
  return relabelIndexEntries(entries, nameById);
}

// An automation user index arrives keyed by accountId. Resolve those to display names from
// the licensed-user roster; an id with no roster row (a deleted or unlicensed account) is
// left as the id and reads as an orphaned reference.
async function resolveUserIndexLabels(installationKey, entries) {
  const meta = await readUserSnapshotMeta(installationKey).catch(() => null);
  if (!meta?.version) return entries;
  const users = await loadUsers(installationKey, meta.version).catch(() => []);
  const nameById = new Map(users.map((u) => [String(u.accountId), u.displayName]).filter(([, name]) => name));
  return relabelIndexEntries(entries, nameById);
}

// Fetch a supporting index on demand. The field index is ~116 KB; sending it with the
// first paint would slow the tab for every visit that never opens the Fields section.
async function getAutomationIndex({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const part = payload?.part;
    if (part === "analysis" || !Object.prototype.hasOwnProperty.call(AUTOMATION_PARTS, part)) {
      throw new Error(`unknown automation index part: ${part}`);
    }

    const document = await readAutomationPart(installationKey, part);
    if (!document) return { available: false, part, reason: "no-index" };

    const rawEntries = document.entries ?? [];
    const entries = part === "issueTypes"
      ? await resolveIssueTypeIndexLabels(installationKey, rawEntries)
      : part === "users"
        ? await resolveUserIndexLabels(installationKey, rawEntries)
        : rawEntries;

    return {
      available: true,
      part,
      total: entries === rawEntries ? (document.total ?? 0) : entries.length,
      entries,
      rules: document.rules ?? [],
      // Sent whole rather than paged. All 675 on the reference site are 144 KB in compact
      // form, which is one fetch the section already pays for; paging server-side would
      // mean a round trip per page and would make client-side filtering impossible without
      // re-querying on every keystroke.
      findings: document.findings ?? [],
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getAutomationIndex failed:", error);
    throw error;
  }
}


// Which automation rules touch one field.
//
// This is the join the whole automation pillar exists for. The Field Browser's other
// sections describe how a field is configured and how many issues carry a value; none of
// them can tell you that deleting it will break a rule. Answering that per field is what
// turns "735 fields are referenced" into something a person can act on.
//
// Resolved server-side rather than by shipping the field index to the browser: the index is
// 131 KB, the Field Browser shows ten fields a page, and only the expanded one needs an
// answer.
async function getAutomationFieldUsage({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const fieldName = String(payload?.fieldName ?? "").trim();
    const fieldId = String(payload?.fieldId ?? "").trim();
    if (!fieldName && !fieldId) throw new Error("fieldName or fieldId is required");

    // SQL first. This is the read the move to rows was for: one indexed query returning
    // the references for this field, instead of loading a ~131 KB index plus a ~129 KB
    // directory and matching a lowercased string in memory -- the same cost whether the
    // question was about one field or all of them.
    //
    // Falls back to the documents when SQL has no rows for the label. An install that
    // imported before the tables existed still has its KVS copies and no rows, and would
    // otherwise be told "not referenced" -- the exact false reassurance this pillar exists
    // to prevent. The fallback goes when a re-import is guaranteed, not before.
    const sqlHit = await loadAutomationReferencesFor(installationKey, "field", fieldName || fieldId)
      .catch(fallbackOn("automation.sql_reference_read_failed", () => null, { installationKey }));

    if (sqlHit?.total > 0) {
      const group = (direction) => {
        const rows = sqlHit.references.filter((r) => r.direction === direction);
        return {
          count: rows.length,
          rules: rows.map((r) => ({
            id: r.rule_id,
            name: r.name ?? `Rule ${r.rule_id}`,
            enabled: r.enabled === null || r.enabled === undefined ? null : r.enabled === 1,
            triggerType: null,
          })),
        };
      };
      return {
        available: true,
        referenced: true,
        source: "sql",
        label: fieldName || fieldId,
        write: group("write"),
        read: group("read"),
        trigger: group("trigger"),
      };
    }

    const [index, directory] = await Promise.all([
      readAutomationPart(installationKey, "fields"),
      readAutomationPart(installationKey, "directory"),
    ]);

    // Distinct from "no rule touches this field". Saying "not referenced" with no analysis
    // behind it is exactly the false reassurance this pillar was built to stop.
    if (!index) return { available: false, reason: "no-analysis" };

    // Extraction records a name or an id depending on how the rule addressed the field, so
    // both are matched. Names are compared case-insensitively because rules are written by
    // hand and casing drifts.
    const wantedName = fieldName.toLowerCase();
    const entry = (index.entries ?? []).find((e) => {
      const label = String(e.label ?? "");
      return (wantedName && label.toLowerCase() === wantedName) || (fieldId && label === fieldId);
    });

    if (!entry) return { available: true, referenced: false };

    const byId = new Map(
      (directory?.rules ?? []).map(([id, name, enabled, triggerType]) => [
        id,
        { id, name, enabled: enabled === 1, triggerType: triggerType || null },
      ])
    );
    // A rule missing from the directory still counts. Dropping it would understate the
    // dependency, which is the one direction this must never err in.
    const expand = (ids = [], count = 0) => ({
      count,
      rules: ids.map((id) => byId.get(id) ?? { id, name: `Rule ${id}`, enabled: null, triggerType: null }),
    });

    return {
      available: true,
      referenced: true,
      source: "kvs",
      label: entry.label,
      write: expand(entry.write, entry.writeCount),
      read: expand(entry.read, entry.readCount),
      trigger: expand(entry.trigger, entry.triggerCount),
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getAutomationFieldUsage failed:", error);
    throw error;
  }
}


// Automation rule counts for a page of fields, in one call.
//
// The Field Browser shows ten fields at a time and the counts sit on the collapsed header,
// so they are needed for every row before anyone expands anything. Ten separate lookups
// would each re-read the same 131 KB index; this reads it once and answers for the page.
//
// Only counts come back. The rule names belong to getAutomationFieldUsage, which runs when
// a card is actually expanded.
const MAX_BATCH_FIELDS = 100;

async function getAutomationFieldCounts({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const requested = Array.isArray(payload?.fields) ? payload.fields.slice(0, MAX_BATCH_FIELDS) : [];
    if (requested.length === 0) return { available: true, counts: {} };

    const index = await readAutomationPart(installationKey, "fields");
    if (!index) return { available: false, reason: "no-analysis", counts: {} };

    // One pass over the index rather than a scan per field: the page asks about ten fields
    // and the index holds hundreds.
    const byLabel = new Map();
    for (const entry of index.entries ?? []) {
      byLabel.set(String(entry.label ?? "").toLowerCase(), entry);
    }

    const counts = {};
    for (const field of requested) {
      const id = String(field?.id ?? "");
      const name = String(field?.name ?? "");
      if (!id && !name) continue;
      const entry = byLabel.get(name.toLowerCase()) ?? byLabel.get(id.toLowerCase());
      // Keyed on the field id the caller sent, so the client does not have to re-match.
      counts[id || name] = entry
        ? {
            enabled: entry.enabledRules ?? 0,
            disabled: entry.disabledRules ?? 0,
            total: entry.ruleCount ?? 0,
          }
        : { enabled: 0, disabled: 0, total: 0 };
    }

    return { available: true, counts };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getAutomationFieldCounts failed:", error);
    throw error;
  }
}


// Probe the endpoints that might expose Jira Automation rules.
//
// Automation is a real blind spot in the findings this app produces: "this status is
// unreachable and never used" is a claim made without looking at automation rules. If a
// rule transitions issues into that status, or sets that field, the finding is wrong --
// and someone could delete something load-bearing on our advice.
//
// Jira Automation came from the Code Barrel acquisition and its REST surface has
// historically been undocumented. Rather than assert which path works, this asks, and
// Answers what a full screen inventory pass would cost, by sampling rather than doing one.
//
// Exists because the screen pipeline's cost turns on tabs-per-screen, which is unknowable
// without asking the site. Building the fetcher first and discovering the number afterwards
// means building it twice. Read-only, admin-only, and it never throws -- like the
// automation probe, a diagnostic that can fail the page it runs on is worse than none.
async function probeScreenFetchCost({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  const requested = Math.trunc(Number(payload?.sampleSize)) || DEFAULT_SAMPLE_SIZE;
  // Bounded: below 5 the tail is invisible, and above 100 the probe becomes the expense it
  // was written to avoid.
  const sampleSize = Math.max(5, Math.min(100, requested));

  try {
    return await measureScreenFetchCost({ sampleSize });
  } catch (error) {
    const message = String(error?.message || error);
    logger.warn("screen-probe.failed", { error: message });

    // On an authorization failure, stop guessing and ask each endpoint directly.
    //
    // The first live run failed with 401 "scope does not match" and this returned a hint
    // saying the install needed upgrading. That was wrong -- the install was already on the
    // version carrying the scopes. A hint that confidently names the wrong cause is worse
    // than no hint, because it sends the reader somewhere that cannot help.
    //
    // Every scope name is confirmed present in Atlassian's registry, so the open question
    // is which endpoint each one authorizes. Probing answers that; reasoning did not.
    const isAuthFailure = /\b401\b|\b403\b|scope does not match/i.test(message);
    let endpoints = null;
    if (isAuthFailure) {
      endpoints = await probeScreenEndpoints().catch(() => null);
    }

    return {
      ok: false,
      error: message,
      endpoints,
      hint: isAuthFailure
        ? "Authorization failure. The table below shows which screen endpoints accept the app's scopes and which reject them â€” a 404 is a pass, since it means the scope was accepted and only the placeholder id was wrong."
        : null,
    };
  }
}

// reports exactly what each one returned. Admin-only, read-only, and it never throws:
// a diagnostic that can fail the page it runs on is worse than no diagnostic.
// Confirms what the JSM Assets API answers on this site -- the first step of the Assets
// pillar, done as a probe because Assets is a gateway API whose exact endpoint spelling and
// availability (JSM Premium only) are worth verifying before an engine is built on them.
async function probeAssetsApi() {
  incrMetric(METRIC_NAMES.resolver);
  return probeAssetsApiProbe();
}

// Global permissions: does the Jira Cloud REST API let this app enumerate WHO HOLDS each
// global permission (ADMINISTER, SYSTEM_ADMIN, CREATE_SHARED_OBJECTS, ...)? As of writing
// it exposes only the permission CATALOG, not the grants -- this probe confirms that
// against the live site before an access-pillar view is built on it. Admin-only,
// read-only, never throws.
async function probeGlobalPermissions() {
  incrMetric(METRIC_NAMES.resolver);
  const rows = [];
  const tryEndpoint = async (path, note) => {
    try {
      const data = await probeEndpoint(path);
      rows.push({ path, ok: data.ok, status: data.status, note, sample: data.sample ?? null });
    } catch (err) {
      rows.push({ path, ok: false, status: null, note, error: String(err?.message || err) });
    }
  };

  await tryEndpoint("/rest/api/3/permissions", "The permission catalog — definitions only, no holders");
  await tryEndpoint("/rest/api/3/permissions/check", "Bulk permission check for the current user — not an enumeration");

  let catalog = {};
  try {
    catalog = await getPermissionCatalog();
  } catch { /* reflected in rows above */ }
  const globalKeys = Object.values(catalog)
    .filter((p) => String(p?.type || "").toUpperCase() === "GLOBAL")
    .map((p) => p.key);

  return {
    // The catalog read is expected to succeed; grant enumeration is what is missing.
    catalogAvailable: globalKeys.length > 0,
    globalPermissionKeys: globalKeys,
    grantEnumerationAvailable: false,
    rows,
    hint: "Jira Cloud's REST API returns the global-permission catalog but no endpoint that lists which groups hold each one. A global-permissions governance view is blocked on that gap; the access pillar covers PROJECT permission schemes, which the API does expose.",
  };
}

async function probeAutomationApi({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);

  // One real project id, because the legacy rule endpoint is project-scoped.
  let projectId = null;
  try {
    const projects = await getAllJiraProjects();
    projectId = projects?.[0]?.id ? String(projects[0].id) : null;
  } catch (error) {
    logger.warn("automation-probe.project_lookup_failed", { error: String(error?.message || error) });
  }

  // Both scopes are probed, because rules live in two places and the goal is to extract
  // the JSON for all of them. GLOBAL is a pseudo-project id in the legacy Code Barrel
  // scheme -- global rules are addressed as if they belonged to a project called GLOBAL.
  const candidates = [
    { scope: "global", path: "/rest/cb-automation/latest/project/GLOBAL/rule" },
    { scope: "global", path: "/rest/cb-automation/latest/rule" },
    { scope: "global", path: "/rest/api/3/automation/rule" },
    ...(projectId
      ? [{ scope: "project", path: `/rest/cb-automation/latest/project/${projectId}/rule` }]
      : []),
  ];

  // The automation API lives on api.atlassian.com, not on the site. Every site-relative
  // path returned 401 because it was asked of the wrong server -- requestJira cannot reach
  // the gateway, so those go through Stargate instead.
  const cloudId = getCloudId(context);
  if (cloudId) {
    candidates.push(
      { scope: "global", via: "stargate", path: `https://api.atlassian.com/automation/public/jira/${cloudId}/rest/v1/rule` },
      { scope: "global", via: "stargate", path: `https://api.atlassian.com/automation/public/jira/${cloudId}/rest/v1/rule/search` },
      // Gateway-relative as well, in case Stargate prefixes the host itself. One of the
      // two forms will be accepted and the other will say why it was not.
      { scope: "global", via: "stargate", path: `/automation/public/jira/${cloudId}/rest/v1/rule` },
    );
  }

  const results = [];
  for (const { scope, path, via } of candidates) {
    const result = via === "stargate" ? await probeStargateEndpoint(path) : await probeEndpoint(path);
    // A 200 is not the same as usable JSON -- Jira can answer with an HTML login page or
    // an error envelope. Record whether the body actually looks like a rule collection.
    const looksLikeRules = /"(rules|values|id)"\s*:/.test(result.sample || "");
    results.push({ ...result, scope, via: via || "site", looksLikeRules });
    logger.info("automation-probe.result", {
      scope, via: via || "site", path: result.path, status: result.status,
      ok: result.ok, ms: result.ms, looksLikeRules, sample: result.sample,
    });
  }

  const reachable = results.filter((r) => r.ok && r.looksLikeRules);
  logger.info("automation-probe.summary", {
    installationKey,
    probed: results.length,
    reachable: reachable.length,
    reachablePaths: reachable.map((r) => r.path),
  });

  return { projectId, cloudId, results, reachable: reachable.map((r) => r.path) };
}

async function getFieldDetails({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    await ensureProjectStoreReady();
    // Input validation
    requireNonEmptyString(payload?.fieldId, "fieldId");
    const fieldId = payload?.fieldId;
    if (!fieldId) throw new Error("fieldId is required");
    const usagePage = Math.max(1, Number(payload?.usagePage) || 1);
    const usagePageSize = Math.max(1, Math.min(25, Number(payload?.usagePageSize) || PROJECT_USAGE_PAGE_SIZE));
    const installationKey = getInstallationKey(context);

    const meta = await readSnapshotMeta(installationKey);
    if (!meta?.version) throw new Error("No completed snapshot available â€” build one first.");

    const offset = (usagePage - 1) * usagePageSize;
    const [snapshotField, projectUsageRows, projectCount, rawFieldSummary, projectUsageIssueSum, issueTypeUsage, userValueUsage] = await Promise.all([
      loadSnapshotField(installationKey, meta.version, fieldId),
      loadSnapshotProjectUsage(installationKey, meta.version, fieldId, usagePageSize, offset),
      countSnapshotProjectUsage(installationKey, meta.version, fieldId),
      loadFieldSummary(installationKey, fieldId),
      sumSnapshotFieldIssueCount(installationKey, meta.version, fieldId),
      // The field x issue-type axis from the last full crawl. Empty when the crawl predates
      // this feature or has not run since -- the UI treats [] as "not measured yet".
      loadFieldTypeUsage(installationKey, meta.version, fieldId).catch(() => []),
      // The field x user axis: how many distinct people hold a value, and the top holders.
      // Only populated for user-picker fields (and assignee/reporter). Names are resolved
      // against the licensed-user roster below so a deleted account still shows something.
      loadFieldUserUsage(installationKey, meta.version, fieldId).catch(() => ({ distinctUsers: 0, issueTotal: 0, top: [] })),
    ]);

    if (!snapshotField) throw new Error(`Field not found in snapshot: ${fieldId}`);

    // Prefer the roster's current display name over the one the crawl captured, and mark an
    // account that is no longer licensed -- a picker still pointing at someone who has left.
    if (userValueUsage?.top?.length) {
      const userMeta = await readUserSnapshotMeta(installationKey).catch(() => null);
      const roster = userMeta?.version
        ? await loadUsers(installationKey, userMeta.version).catch(() => [])
        : [];
      const rosterById = new Map(roster.map((u) => [u.accountId, u]));
      userValueUsage.top = userValueUsage.top.map((row) => {
        const person = rosterById.get(row.accountId);
        return {
          ...row,
          displayName: person?.displayName || row.displayName || row.accountId,
          onRoster: userMeta?.version ? Boolean(person) : null,
        };
      });
    }
    const fieldSummary = await ensureFieldSummaryJobRunning(
      installationKey,
      meta.version,
      fieldId,
      rawFieldSummary,
      snapshotField
    );

    let finalProjectRows = projectUsageRows;
    let finalProjectCount = projectCount;
    let finalContexts = fieldSummary?.contexts || [];
    let summaryStatus = fieldSummary?.summaryStatus || "ready";
    const hasBrokenReadySummary = Boolean(
      fieldSummary &&
      fieldSummary.summaryStatus === "ready" &&
      (fieldSummary.activeProjectCount > 0 || snapshotField.activeProjectCount > 0) &&
      (!Array.isArray(fieldSummary.activeProjects) || fieldSummary.activeProjects.length === 0) &&
      projectCount === 0
    );

    if (fieldSummary && !hasBrokenReadySummary) {
      if (projectCount === 0 && Array.isArray(fieldSummary.activeProjects) && fieldSummary.activeProjects.length > 0) {
        finalProjectCount = fieldSummary.activeProjectCount || fieldSummary.activeProjects.length;
        finalProjectRows = fieldSummary.activeProjects
          .slice(offset, offset + usagePageSize)
          .map((project) => ({
            projectId: project.projectId,
            projectKey: project.projectKey,
            projectName: project.projectName,
            issueCount: project.issueCount,
            jql: project.jql,
          }));
      } else if (fieldSummary.activeProjectCount > 0) {
        finalProjectCount = fieldSummary.activeProjectCount;
      }
    }

    if (hasBrokenReadySummary) {
      summaryStatus = "failed";
    } else if (!fieldSummary && !finalProjectRows.length && projectCount === 0 && snapshotField.totalIssueCount > 0) {
      summaryStatus = "idle";
    }

    if (!finalContexts.length) {
      try {
        finalContexts = await loadFieldContexts(fieldId);
        if (fieldSummary) {
          await replaceFieldSummary(installationKey, fieldId, {
            ...fieldSummary,
            refreshedAt: new Date().toISOString(),
            contexts: finalContexts,
          });
        }
      } catch (contextError) {
        console.warn(`getFieldDetails: context load failed for ${fieldId}: ${contextError?.message || contextError}`);
      }
    }

    const duplicateNameCounts = buildDuplicateNameCountMap(
      await loadSnapshotFields(installationKey, meta.version)
    );
    const hydratedField = hydrateFieldForGovernance({
      ...snapshotField,
      activeProjectCount: finalProjectCount,
      totalIssueCount: fieldSummary?.totalIssueCount || snapshotField.totalIssueCount || projectUsageIssueSum || 0,
    }, fieldSummary, duplicateNameCounts.get(normalizeFieldName(snapshotField.name)) ?? 1);

    // Never surface a project's identity to a viewer who lacks Browse Projects
    // on it in Jira. finalProjectCount/pagination totals are left as-is (a bare
    // number doesn't reveal a project's identity, same tradeoff already
    // accepted for field-inventory aggregate counts) -- only row-level identity
    // is filtered here.
    const browsableProjectIds = await getBrowsableProjectIds(
      context?.accountId,
      finalProjectRows.map((row) => row.projectId)
    );
    finalProjectRows = finalProjectRows.filter((row) => browsableProjectIds.has(String(row.projectId)));

    const projectUsage = finalProjectRows.map((row) => ({
      projectId: row.projectId,
      projectKey: row.projectKey,
      projectName: row.projectName,
      issueCount: row.issueCount,
      jql: row.jql || buildFieldJql(fieldId, row.projectKey),
      latestFieldChangeAt: null,
      latestIssueKey: null,
      latestIssueUpdatedAt: null,
    }));

    return {
      refreshedAt: meta.refreshedAt,
      field: {
        ...hydratedField,
        numericId: getFieldNumericId(snapshotField.id),
      },
      fieldJql: snapshotField.fieldJql || buildOverallFieldJql(fieldId),
      activeProjectCount: finalProjectCount,
      totalIssueCount: hydratedField.totalIssueCount,
      findings: hydratedField.findings || null,
      contexts: finalContexts,
      projects: projectUsage,
      issueTypeUsage,
      userValueUsage,
      projectUsagePage: usagePage,
      projectUsagePageSize: usagePageSize,
      projectUsageTotalProjects: finalProjectCount,
      projectUsageTotalPages: Math.max(1, Math.ceil(finalProjectCount / usagePageSize)),
      summaryStatus,
      processedIssueCount: fieldSummary?.processedIssueCount || 0,
      estimatedIssueTotal: fieldSummary?.estimatedIssueTotal || snapshotField.totalIssueCount || 0,
      progressLog: fieldSummary?.progressLog || [],
      startedAt: fieldSummary?.startedAt || null,
      completedAt: fieldSummary?.completedAt || null,
      lastError: fieldSummary?.lastError || null,
    };
  } catch (error) {
    console.error("getFieldDetails failed:", error);
    throw error;
  }
}

async function cancelSnapshot({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  // Hard-stop: null out buildingVersion so every running build's version-check fails,
  // regardless of how many are active or what state they think they're in.
  await writeSnapshotMeta(installationKey, {
    state: "cancelled",
    buildingVersion: null,
    lastError: null,
  });
  return { cancelled: true };
}

// The literal a caller must send to confirm a destructive clear. The admin bundle is
// built separately and cannot import from here, so ClearSnapshotControl in admin.jsx
// carries its own copy of this string -- if you change it, change it there too, or
// admins get told to type a word the server will reject.
export const CLEAR_SNAPSHOT_CONFIRMATION = "DELETE";

async function clearSnapshot({ payload, context }) {
  await ensureProjectStoreReady();

  // Re-checked server-side even though the UI gates on it. The UI check is there to make
  // the action deliberate; this one is there because a resolver is reachable without the
  // UI, and "irreversibly delete everything" should not be a bare invoke() away.
  const confirmation = String(payload?.confirmation ?? "").trim();
  if (confirmation !== CLEAR_SNAPSHOT_CONFIRMATION) {
    return {
      cleared: false,
      error: `Confirmation text did not match. Type ${CLEAR_SNAPSHOT_CONFIRMATION} to confirm.`,
    };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { cleared: false, error: "Read-only mode is enabled. Disable it before clearing snapshot data." };
  }

  const installationKey = getInstallationKey(context);

  // Cancel before deleting, not after. A build running against the version we are about
  // to wipe would otherwise keep writing rows into the tables behind us, leaving the
  // installation in exactly the half-populated state this action is meant to escape.
  await writeSnapshotMeta(installationKey, {
    state: "cancelled",
    buildingVersion: null,
    lastError: null,
  });

  const result = await clearAllSnapshotData(installationKey);
  console.log(`clearSnapshot: deleted ${result.totalRowsDeleted} rows across ${Object.keys(result.deleted).length} tables`);

  return { cleared: true, ...result };
}

// Admin read. Guarded like everything else in the registry, but deliberately NOT in
// AUDITED_ADMIN_ACTIONS -- auditing reads of the audit log is a loop that buries the
// events worth finding, and this exposes nothing an admin could not already query.
async function getAuditLog({ payload, context }) {
  await ensureProjectStoreReady();
  const limit = optionalPositiveInt(payload?.limit, "limit", 100, 1000);
  const installationKey = getInstallationKey(context);
  const events = await listAuditEvents(installationKey, limit);
  return { events, limit };
}

async function getProjectUsageJobs({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const jobs = await listFieldSummaries(installationKey, 200);

  return {
    jobs: jobs.map((job, index) => ({
      fieldId: job.fieldId || jobs[index]?.fieldId,
      fieldName: job.field?.name || job.fieldId,
      fieldType: job.field?.type || "unknown",
      summaryStatus: job.summaryStatus,
      configuredProjectCount: job.configuredProjectCount,
      activeProjectCount: job.activeProjectCount,
      totalIssueCount: job.totalIssueCount,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      refreshedAt: job.refreshedAt,
      lastError: job.lastError,
      progressLog: job.progressLog || [],
      processedIssueCount: job.processedIssueCount || 0,
      estimatedIssueTotal: job.estimatedIssueTotal || 0,
      nextStartAt: job.nextStartAt || 0,
      percentComplete: job.estimatedIssueTotal > 0
        ? Math.min(100, Math.round(((job.processedIssueCount || 0) / job.estimatedIssueTotal) * 100))
        : (job.summaryStatus === "ready" ? 100 : 0),
    })),
  };
}

async function refreshRecentProjectUsage({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    throw new Error("No completed snapshot available â€” build one first.");
  }

  const hours = Math.max(1, Math.min(168, Math.trunc(Number(payload?.hours)) || 24));
  const maxIssues = Math.max(50, Math.min(2000, Math.trunc(Number(payload?.maxIssues)) || 500));
  const recent = await collectRecentFieldProjectCandidates(hours, maxIssues);
  const allSummaries = await listFieldSummaries(installationKey, 5000).catch(fallbackOn("resolver.summaries_load_failed", () => [], { installationKey }));
  const summaryByFieldId = new Map(allSummaries.map((summary) => [summary.fieldId, summary]));

  let queuedCount = 0;
  let fullRebuildCount = 0;
  for (const candidate of recent.fields) {
    const fieldId = String(candidate.fieldId || "").trim();
    if (!fieldId) continue;

    const snapshotField = await loadSnapshotField(installationKey, meta.version, fieldId).catch(fallbackOn("resolver.snapshot_field_load_failed", null, { fieldId }));
    if (!snapshotField) continue;

    const summary = summaryByFieldId.get(fieldId) || null;
    if (!summary || summary.summaryStatus !== "ready") {
      const queued = await ensureProjectUsageJobQueued(installationKey, meta.version, snapshotField, summary);
      if (queued.queued) {
        queuedCount++;
        fullRebuildCount++;
      }
      continue;
    }

    const jobToken = makeJobToken();
    await replaceFieldSummary(installationKey, fieldId, {
      ...summary,
      refreshedAt: new Date().toISOString(),
      field: summary.field || snapshotField,
      fieldJql: summary.fieldJql || snapshotField.fieldJql || buildOverallFieldJql(fieldId),
      summaryStatus: "queued",
      completedAt: null,
      lastError: null,
      progressLog: [
        ...(summary.progressLog || []).slice(-80),
        {
          t: new Date().toISOString(),
          msg: `Queued incremental project-usage refresh from issues updated in the last ${hours}h`,
        },
      ].slice(-100),
      jobToken,
    });

    const queueResult = await queueFieldUsageDeltaRefreshWithRetry(
      installationKey,
      meta.version,
      fieldId,
      jobToken,
      candidate.projectKeys,
      hours
    );

    if (!queueResult.queued) {
      await replaceFieldSummary(installationKey, fieldId, {
        ...summary,
        refreshedAt: new Date().toISOString(),
        field: summary.field || snapshotField,
        fieldJql: summary.fieldJql || snapshotField.fieldJql || buildOverallFieldJql(fieldId),
        summaryStatus: "deferred",
        completedAt: summary.completedAt || null,
        lastError: null,
        progressLog: [
          ...(summary.progressLog || []).slice(-80),
          {
            t: new Date().toISOString(),
            msg: `Deferred incremental refresh after ${queueResult.attempts || 1} queue attempts`,
          },
        ].slice(-100),
        jobToken,
      });
      continue;
    }

    queuedCount++;
  }

  return {
    queuedCount,
    fullRebuildCount,
    scannedIssues: recent.scannedIssues,
    changedFieldCount: recent.fields.length,
    windowHours: hours,
  };
}

async function cancelProjectUsageJob({ payload, context }) {
  await ensureProjectStoreReady();
  const fieldId = String(payload?.fieldId || "").trim();
  if (!fieldId) throw new Error("fieldId is required");

  const installationKey = getInstallationKey(context);
  const existing = await loadFieldSummary(installationKey, fieldId);
  if (!existing) {
    return { cancelled: false, reason: "not-found" };
  }

  await replaceFieldSummary(installationKey, fieldId, {
    ...existing,
    summaryStatus: "cancelled",
    completedAt: new Date().toISOString(),
    progressLog: [
      ...(existing.progressLog || []),
      { t: new Date().toISOString(), msg: "Job cancelled by user" },
    ],
  });

  return { cancelled: true };
}

async function restartProjectUsageJob({ payload, context }) {
  await ensureProjectStoreReady();
  const fieldId = String(payload?.fieldId || "").trim();
  if (!fieldId) throw new Error("fieldId is required");

  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    throw new Error("No completed snapshot available â€” build one first.");
  }

  const snapshotField = await loadSnapshotField(installationKey, meta.version, fieldId);
  if (!snapshotField) {
    throw new Error(`Field not found in snapshot: ${fieldId}`);
  }

  const jobToken = makeJobToken();
  await replaceSnapshotProjectUsageForField(installationKey, meta.version, fieldId, []);
  await replaceFieldSummary(installationKey, fieldId, {
    refreshedAt: new Date().toISOString(),
    field: snapshotField,
    fieldJql: snapshotField.fieldJql || buildOverallFieldJql(fieldId),
    configuredProjectCount: snapshotField.configuredProjectCount ?? snapshotField.usageCount ?? 0,
    hasGlobalContext: false,
    activeProjectCount: 0,
    totalIssueCount: snapshotField.totalIssueCount ?? 0,
    activeProjects: [],
    contexts: [],
    findings: snapshotField.findings || null,
    summaryStatus: "queued",
    startedAt: null,
    completedAt: null,
    lastError: null,
    progressLog: [{ t: new Date().toISOString(), msg: "Queued fresh project-usage background job" }],
    jobToken,
    processedIssueCount: 0,
    estimatedIssueTotal: snapshotField.totalIssueCount ?? 0,
    nextStartAt: 0,
    nextPageToken: null,
  });
  await processFieldSummaryChunk(
    installationKey,
    meta.version,
    snapshotField,
    jobToken,
    0,
    null,
    1
  );

  return { queued: true, fieldId };
}

async function resumeProjectUsageJob({ payload, context }) {
  await ensureProjectStoreReady();
  const fieldId = String(payload?.fieldId || "").trim();
  if (!fieldId) throw new Error("fieldId is required");

  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    throw new Error("No completed snapshot available â€” build one first.");
  }

  const [snapshotField, existing] = await Promise.all([
    loadSnapshotField(installationKey, meta.version, fieldId),
    loadFieldSummary(installationKey, fieldId),
  ]);
  if (!snapshotField) {
    throw new Error(`Field not found in snapshot: ${fieldId}`);
  }
  if (!existing) {
    throw new Error(`No existing project-usage job state found for ${fieldId}`);
  }
  if (existing.summaryStatus === "queued" || existing.summaryStatus === "building") {
    return { queued: false, fieldId, reason: "already-running" };
  }

  const jobToken = makeJobToken();
  const resumedSummary = {
    ...existing,
    refreshedAt: new Date().toISOString(),
    field: snapshotField,
    fieldJql: existing.fieldJql || snapshotField.fieldJql || buildOverallFieldJql(fieldId),
    configuredProjectCount: existing.configuredProjectCount ?? snapshotField.configuredProjectCount ?? snapshotField.usageCount ?? 0,
    totalIssueCount: Math.max(existing.totalIssueCount ?? 0, snapshotField.totalIssueCount ?? 0),
    findings: existing.findings || snapshotField.findings || null,
    summaryStatus: "queued",
    completedAt: null,
    lastError: null,
    progressLog: [
      ...(existing.progressLog || []).slice(-80),
      {
        t: new Date().toISOString(),
        msg: `Resuming project-usage build from ${Number(existing.processedIssueCount || 0).toLocaleString()} scanned issues`,
      },
    ].slice(-100),
    jobToken,
  };

  await replaceFieldSummary(installationKey, fieldId, resumedSummary);
  await processFieldSummaryChunk(
    installationKey,
    meta.version,
    snapshotField,
    jobToken,
    Number(existing.processedIssueCount || existing.nextStartAt || 0),
    existing.nextPageToken || null,
    1
  );

  return {
    queued: true,
    fieldId,
    resumedFrom: Number(existing.processedIssueCount || 0),
  };
}

async function ensureProjectUsageJobQueued(installationKey, version, snapshotField, existingSummary = null) {
  if (!snapshotField?.id) {
    return { queued: false, reason: "missing-field" };
  }

  if (Number(snapshotField.totalIssueCount || 0) <= 0) {
    return { queued: false, reason: "no-issues" };
  }

  const fieldId = snapshotField.id;
  const summary = existingSummary || await loadFieldSummary(installationKey, fieldId).catch(fallbackOn("resolver.field_summary_load_failed", null, { fieldId }));
  if (summary?.summaryStatus === "queued" || summary?.summaryStatus === "building") {
    return { queued: false, reason: "already-running" };
  }

  const jobToken = makeJobToken();
  await replaceSnapshotProjectUsageForField(installationKey, version, fieldId, []);
  await replaceFieldSummary(installationKey, fieldId, {
    refreshedAt: new Date().toISOString(),
    field: snapshotField,
    fieldJql: snapshotField.fieldJql || buildOverallFieldJql(fieldId),
    configuredProjectCount: snapshotField.configuredProjectCount ?? snapshotField.usageCount ?? 0,
    hasGlobalContext: false,
    activeProjectCount: 0,
    totalIssueCount: snapshotField.totalIssueCount ?? 0,
    activeProjects: [],
    contexts: summary?.contexts || [],
    findings: snapshotField.findings || null,
    summaryStatus: "queued",
    startedAt: null,
    completedAt: null,
    lastError: null,
    progressLog: [
      ...(summary?.progressLog || []).slice(-40),
      { t: new Date().toISOString(), msg: "Queued project-usage build for report generation" },
    ],
    jobToken,
    processedIssueCount: 0,
    estimatedIssueTotal: snapshotField.totalIssueCount ?? 0,
    nextStartAt: 0,
    nextPageToken: null,
  });
  const queueResult = await queueFieldSummaryContinuationWithRetry(
    installationKey,
    version,
    fieldId,
    jobToken,
    0,
    ""
  );
  if (!queueResult.queued) {
    await replaceFieldSummary(installationKey, fieldId, {
      refreshedAt: new Date().toISOString(),
      field: snapshotField,
      fieldJql: snapshotField.fieldJql || buildOverallFieldJql(fieldId),
      configuredProjectCount: snapshotField.configuredProjectCount ?? snapshotField.usageCount ?? 0,
      hasGlobalContext: false,
      activeProjectCount: 0,
      totalIssueCount: snapshotField.totalIssueCount ?? 0,
      activeProjects: [],
      contexts: summary?.contexts || [],
      findings: snapshotField.findings || null,
      summaryStatus: "deferred",
      startedAt: null,
      completedAt: null,
      lastError: null,
      progressLog: [
        ...(summary?.progressLog || []).slice(-40),
        {
          t: new Date().toISOString(),
          msg: `Queue backpressure hit while starting project-usage build after ${queueResult.attempts || 1} queue attempt${(queueResult.attempts || 1) === 1 ? "" : "s"}; job deferred`,
        },
      ],
      jobToken,
      processedIssueCount: 0,
      estimatedIssueTotal: snapshotField.totalIssueCount ?? 0,
      nextStartAt: 0,
      nextPageToken: null,
    });
    return { queued: false, reason: "queue-backpressure" };
  }
  return { queued: true, reason: "queued" };
}

async function ensureDeferredProjectUsageJobRecorded(installationKey, snapshotField, existingSummary = null, reason = "deferred") {
  if (!snapshotField?.id) {
    return;
  }

  const fieldId = snapshotField.id;
  const summary = existingSummary || await loadFieldSummary(installationKey, fieldId).catch(fallbackOn("resolver.field_summary_load_failed", null, { fieldId }));
  if (summary?.summaryStatus === "queued" || summary?.summaryStatus === "building" || summary?.summaryStatus === "ready") {
    return;
  }

  const reasonMessages = {
    "deferred-active-job-cap": "Deferred project-usage build because the active job cap has been reached",
    "deferred-field-cap": "Deferred project-usage build because the per-report field queue cap has been reached",
    "deferred-issue-budget": "Deferred project-usage build because the report issue budget has been reached",
    "queue-backpressure": "Deferred project-usage build because the Forge queue is under backpressure",
  };

  await replaceFieldSummary(installationKey, fieldId, {
    refreshedAt: new Date().toISOString(),
    field: snapshotField,
    fieldJql: snapshotField.fieldJql || buildOverallFieldJql(fieldId),
    configuredProjectCount: snapshotField.configuredProjectCount ?? snapshotField.usageCount ?? 0,
    hasGlobalContext: false,
    activeProjectCount: summary?.activeProjectCount ?? 0,
    totalIssueCount: snapshotField.totalIssueCount ?? summary?.totalIssueCount ?? 0,
    activeProjects: summary?.activeProjects || [],
    contexts: summary?.contexts || [],
    findings: summary?.findings || snapshotField.findings || null,
    summaryStatus: "deferred",
    startedAt: summary?.startedAt || null,
    completedAt: summary?.completedAt || null,
    lastError: null,
    progressLog: [
      ...(summary?.progressLog || []).slice(-40),
      { t: new Date().toISOString(), msg: reasonMessages[reason] || "Deferred project-usage build for later execution" },
    ].slice(-100),
    jobToken: summary?.jobToken || makeJobToken(),
    processedIssueCount: Number(summary?.processedIssueCount || 0),
    estimatedIssueTotal: snapshotField.totalIssueCount ?? summary?.estimatedIssueTotal ?? 0,
    nextStartAt: Number(summary?.nextStartAt || summary?.processedIssueCount || 0),
    nextPageToken: summary?.nextPageToken || null,
  });
}

async function getSavedReports({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const reports = await listSavedReports(installationKey);
  return { reports };
}

async function saveReportDefinition({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  // Input validation
  requireNonEmptyString(payload?.name, "name");
  if ((payload?.name || "").trim().length > 200) throw new Error("name must not exceed 200 characters");
  const rawFieldIds = requireArray(payload?.fieldIds, "fieldIds");
  if (rawFieldIds.length < 1) throw new Error("fieldIds must contain at least 1 element");
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const name = String(payload?.name || "").trim();
  const fieldIds = Array.from(new Set((payload?.fieldIds || []).map((value) => String(value || "").trim()).filter(Boolean)));
  const reportId = String(payload?.reportId || "").trim() || makeJobToken();

  if (!name) throw new Error("Report name is required.");
  if (!fieldIds.length) throw new Error("Select at least one field to save a report.");

  const existingReports = await listSavedReports(installationKey);
  const existing = existingReports.find((report) => report.reportId === reportId);
  await saveSavedReport(installationKey, {
    reportId,
    name,
    fieldIds,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  return getSavedReports({ context });
}

async function deleteReportDefinition({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  // Input validation
  requireNonEmptyString(payload?.reportId, "reportId");
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const reportId = String(payload?.reportId || "").trim();
  if (!reportId) throw new Error("reportId is required");

  await deleteSavedReport(installationKey, reportId);
  return getSavedReports({ context });
}

async function getProjectUsageReport({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const fieldIds = Array.from(new Set((payload?.fieldIds || []).map((value) => String(value || "").trim()).filter(Boolean)));
  if (!fieldIds.length) {
    return { fields: [], projects: [] };
  }

  // Optional project scope. When a report is built from a set of screens, the only projects
  // worth showing are the ones those screens are actually applied to -- every other column
  // would be a field this report has nothing to say about. An empty/absent list means "no
  // scope", the report's original site-wide behaviour.
  const scopeProjectIds = new Set(
    (payload?.projectIds || []).map((value) => String(value || "").trim()).filter(Boolean)
  );

  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    throw new Error("No completed snapshot available â€” build one first.");
  }

  const pendingFields = [];
  const allSummaries = await listFieldSummaries(installationKey, 5000).catch(fallbackOn("resolver.summaries_load_failed", () => [], { installationKey }));
  const summaryByFieldId = new Map(allSummaries.map((summary) => [summary.fieldId, summary]));
  const queueCandidates = [];
  const rows = await Promise.all(fieldIds.map(async (fieldId) => {
    const [field, projectUsage, fieldSummary] = await Promise.all([
      loadSnapshotField(installationKey, meta.version, fieldId),
      loadAllSnapshotProjectUsage(installationKey, meta.version, fieldId),
      loadFieldSummary(installationKey, fieldId).catch(fallbackOn("resolver.field_summary_load_failed", () => summaryByFieldId.get(fieldId) || null, { fieldId })),
    ]);
    if (!field) {
      return null;
    }

    // Fallback chain when current-version snapshot_project_usage is empty:
    // 1. Any-version snapshot data (handles post-migration version mismatch)
    // 2. field_summaries.activeProjects (populated by Field Usage Jobs)
    let finalProjects = projectUsage;
    if (!finalProjects.length) {
      finalProjects = await loadAnySnapshotProjectUsage(installationKey, fieldId).catch(fallbackOn("resolver.any_project_usage_load_failed", () => [], { fieldId }));
    }
    if (!finalProjects.length) {
      finalProjects = (fieldSummary?.activeProjects || []).map((p) => ({
        projectId: p.projectId,
        projectKey: p.projectKey,
        projectName: p.projectName,
        issueCount: p.issueCount || 0,
        jql: p.jql || buildFieldJql(fieldId, p.projectKey),
        latestFieldChangeAt: null,
        latestIssueKey: null,
        latestIssueUpdatedAt: null,
      }));
    }

    const derivedTotalIssueCount = field.totalIssueCount
      || fieldSummary?.totalIssueCount
      || finalProjects.reduce((s, p) => s + (p.issueCount || 0), 0)
      || 0;

    if (!finalProjects.length && derivedTotalIssueCount > 0) {
      if (fieldSummary?.summaryStatus === "queued" || fieldSummary?.summaryStatus === "building") {
        pendingFields.push({
          fieldId: field.id,
          fieldName: field.name,
          summaryStatus: fieldSummary.summaryStatus,
          reason: "already-running",
        });
      } else {
        queueCandidates.push({
          field,
          fieldSummary,
          issueCount: derivedTotalIssueCount,
        });
      }
    }

    return {
      fieldId: field.id,
      fieldName: field.name,
      fieldType: field.type,
      totalIssueCount: derivedTotalIssueCount,
      activeProjectCount: field.activeProjectCount || finalProjects.length || 0,
      fieldJql: field.fieldJql || buildOverallFieldJql(field.id),
      projects: finalProjects,
    };
  }));

  const queueCapacity = summarizeProjectUsageCapacity(allSummaries);
  let runningJobCount = queueCapacity.runningJobCount;
  let runningIssueBudget = queueCapacity.runningIssueBudget;
  let newlyQueuedFieldCount = 0;
  let newlyQueuedIssueBudget = 0;
  const sortedCandidates = queueCandidates.sort((left, right) =>
    left.issueCount - right.issueCount || left.field.name.localeCompare(right.field.name)
  );

  for (const candidate of sortedCandidates) {
    const candidateIssueCount = candidate.issueCount;
    let reason = null;

    if (runningJobCount >= MAX_ACTIVE_PROJECT_USAGE_JOBS) {
      reason = "deferred-active-job-cap";
    } else if (newlyQueuedFieldCount >= MAX_AUTOQUEUED_REPORT_FIELDS) {
      reason = "deferred-field-cap";
    } else if (
      (runningIssueBudget + newlyQueuedIssueBudget + candidateIssueCount) > MAX_AUTOQUEUED_REPORT_ISSUE_BUDGET
      && (newlyQueuedFieldCount > 0 || runningJobCount > 0)
    ) {
      reason = "deferred-issue-budget";
    }

    if (reason) {
      await ensureDeferredProjectUsageJobRecorded(
        installationKey,
        candidate.field,
        candidate.fieldSummary,
        reason
      );
      pendingFields.push({
        fieldId: candidate.field.id,
        fieldName: candidate.field.name,
        summaryStatus: "deferred",
        reason,
      });
      continue;
    }

    const queued = await ensureProjectUsageJobQueued(
      installationKey,
      meta.version,
      candidate.field,
      candidate.fieldSummary
    );

    if (queued.queued) {
      pendingFields.push({
        fieldId: candidate.field.id,
        fieldName: candidate.field.name,
        summaryStatus: "queued",
        reason: "project-usage-missing",
      });
      runningJobCount++;
      runningIssueBudget += candidateIssueCount;
      newlyQueuedFieldCount++;
      newlyQueuedIssueBudget += candidateIssueCount;
      continue;
    }

    pendingFields.push({
      fieldId: candidate.field.id,
      fieldName: candidate.field.name,
      summaryStatus: queued.reason === "already-running" ? "queued" : "deferred",
      reason: queued.reason || "project-usage-missing",
    });
  }

  let fields = rows.filter(Boolean);

  // Narrow every field to the scoped projects, and recompute the two per-field totals from
  // what is left so the row does not show a site-wide count beside scoped cells. A field with
  // no usage in scope stays in the report as a zero row -- it IS on one of the chosen
  // screens, and "on the form, never filled" is exactly the finding this view exists for.
  if (scopeProjectIds.size) {
    fields = fields.map((field) => {
      const scoped = field.projects.filter((p) => scopeProjectIds.has(String(p.projectId)));
      return {
        ...field,
        projects: scoped,
        activeProjectCount: scoped.length,
        totalIssueCount: scoped.reduce((sum, p) => sum + (p.issueCount || 0), 0),
      };
    });
  }

  const projectMap = new Map();

  // Under a scope, seed the columns from the scope itself, not just from projects that
  // happened to have a usage row -- otherwise a scoped project where none of these fields
  // are filled drops out of the matrix, which is the opposite of what the report is for.
  if (scopeProjectIds.size && meta?.version) {
    const scoped = await listSnapshotProjects(installationKey, meta.version).catch(
      fallbackOn("report.scope_projects_load_failed", () => [], { installationKey })
    );
    for (const project of scoped) {
      if (scopeProjectIds.has(String(project.projectId))) {
        projectMap.set(String(project.projectId), {
          projectId: String(project.projectId),
          projectKey: project.projectKey,
          projectName: project.projectName,
        });
      }
    }
  }

  for (const field of fields) {
    for (const project of field.projects) {
      if (!projectMap.has(project.projectId)) {
        projectMap.set(project.projectId, {
          projectId: project.projectId,
          projectKey: project.projectKey,
          projectName: project.projectName,
        });
      }
    }
  }

  const projects = Array.from(projectMap.values()).sort(
    (left, right) => left.projectKey.localeCompare(right.projectKey) || left.projectName.localeCompare(right.projectName)
  );

  const uniqueIssueCount = await getDistinctIssueCountForFields(fields.map((field) => field.fieldId));

  // Never surface a project's identity to a viewer who lacks Browse Projects on
  // it -- one bulk permission check for every project touched by this report.
  const browsableProjectIds = await getBrowsableProjectIds(
    context?.accountId,
    projects.map((p) => p.projectId)
  );
  const filtered = filterProjectUsageByBrowsable({ fields, projects, pendingFields, uniqueIssueCount }, browsableProjectIds);

  return filtered;
}

// The projects a set of screens is actually applied to, walking the screen -> screen scheme
// -> ITSS -> project chain (the reverse of loadScreensForProject). A screen only reaches a
// project if a screen scheme's operation points at it, an issue type screen scheme maps that
// scheme, and a project uses that ITSS.
async function screensToProjects(installationKey, version, screenIds) {
  const screenSet = new Set(screenIds.map(String));
  const [ops, mappings, itssProjects] = await Promise.all([
    loadScreenSchemeOperations(installationKey, version).catch(() => []),
    loadItssMappings(installationKey, version).catch(() => []),
    loadItssProjects(installationKey, version).catch(() => []),
  ]);

  const schemeIds = new Set(ops.filter((o) => screenSet.has(String(o.screenId))).map((o) => String(o.schemeId)));
  const itssIds = new Set(
    mappings.filter((m) => m.screenSchemeId && schemeIds.has(String(m.screenSchemeId))).map((m) => String(m.itssId))
  );

  const byProject = new Map();
  for (const row of itssProjects) {
    if (!itssIds.has(String(row.itssId))) continue;
    byProject.set(String(row.projectId), {
      projectId: String(row.projectId),
      projectKey: row.projectKey || "",
      projectName: row.projectName || "",
    });
  }
  return [...byProject.values()];
}

// "Build a field report from these screens." Returns the field union across the chosen
// screens and the projects those screens reach, so the Reports tab can pre-fill the field
// selection and scope the matrix to just the projects the report has something to say about.
// The cross-signal: screen reachability crossed with where field values actually exist.
//
// Costs no new Jira call. Both halves are already on disk -- the screen inventory the
// Screens tab reads, and the field x project usage the Field Browser reads -- and neither
// alone can answer the question this produces. See screen-insights.js for the four states
// and why two of them are invisible to every other pillar.
//
// Two snapshots with independent versions, so both are read and reported: a cross between a
// fresh screen build and a three-week-old field snapshot is a real answer about two
// different days, and the caller is told which days.
// The Deletion Safety report: every pillar's evidence about one field, in one answer.
//
// This is the product's thesis rendered as an artifact. Each pillar already held a piece of
// it and none could settle the question alone -- and the pieces were never joined, so the
// only way to answer "is this safe to delete" was to open five tabs and hold the result in
// your head.
//
// Bounded rather than resumable. The report-job contract exists and would let this run over
// the whole catalogue, but the answer is read one field at a time by somebody about to make
// a decision, and a synchronous call that refuses the 51st field is more honest than a job
// that quietly takes an hour. The remainder is reported, never silently dropped.
const MAX_DELETION_SAFETY_FIELDS = 50;

export async function getDeletionSafety({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const requested = Array.isArray(payload?.fieldIds) ? payload.fieldIds.map(String).filter(Boolean) : [];
  if (!requested.length) return { available: false, reason: "No field was named.", fields: [], total: 0 };

  const fieldIds = requested.slice(0, MAX_DELETION_SAFETY_FIELDS);
  const skipped = requested.length - fieldIds.length;

  const [fieldMeta, screenMeta, filterMeta, dashMeta] = await Promise.all([
    readSnapshotMeta(installationKey),
    readScreenSnapshotMeta(installationKey).catch(() => null),
    readFilterSnapshotMeta(installationKey).catch(() => null),
    readDashboardSnapshotMeta(installationKey).catch(() => null),
  ]);

  // The one hard prerequisite. Without the field snapshot there is no catalogue to name the
  // fields, and a verdict about a field the app cannot describe is not worth printing.
  if (!fieldMeta?.version) {
    return {
      available: false,
      reason: "No field snapshot has been built yet, so there is nothing to assess. Run a full scan from the Scans tab.",
      fields: [], total: 0,
    };
  }

  const [catalog, automationParts, rqtRows, crossSummary] = await Promise.all([
    loadSnapshotFields(installationKey, fieldMeta.version).catch(() => null),
    loadAutomationForAgent(installationKey).catch(() => null),
    loadRqtFieldIndex(installationKey).catch(() => null),
    // Only to answer the invisible-data blocker. Read, not recomputed: the widest join in
    // the app has no business running behind a per-field question.
    getScreenFieldCrossSignal({ payload: {}, context }).catch(() => null),
  ]);

  // Null means the catalogue read FAILED; an empty array means it was read and is empty.
  // The difference matters more here than it looks: the automation, filter and dashboard
  // joins all key on the field's NAME, so without the catalogue they match nothing and
  // return clean -- three pillars silently not consulted, reported as three pillars
  // consulted and clear. That is the exact failure this whole report exists to prevent.
  const catalogAvailable = Array.isArray(catalog);
  const byId = new Map((catalog || []).map((f) => [String(f.id), f]));
  const rqtById = new Map((rqtRows || []).map((r) => [String(r.fieldId ?? r.field_id), r]));
  const invisibleById = new Map(
    (crossSummary?.available ? crossSummary.invisibleData : []).map((f) => [String(f.fieldId), f])
  );

  const automationIndex = automationParts?.fields ?? null;
  const automationEvidence = automationParts?.analysis
    ? assessAutomationEvidence({
        index: automationIndex,
        refreshedAt: automationParts.analysis.refreshedAt ?? null,
        staleAfterDays: automationParts.staleAfterDays,
      })
    : null;

  // Workflow rules naming these fields: one indexed read for the whole batch. Null when no
  // snapshot has captured rules, which the assessor reports as a gap rather than a pass.
  const workflowEvidence = await loadFieldWorkflowEvidence(installationKey, fieldIds)
    .catch(fallbackOn("deletion_safety.workflow_rules_failed", () => null, { installationKey }));

  const assessments = [];
  for (const fieldId of fieldIds) {
    const field = byId.get(fieldId) || { id: fieldId, name: null };
    // No name, no name-keyed join. Passing these as unavailable makes them gaps, which is
    // what they are, instead of empty results that read as evidence of absence.
    const nameKnown = Boolean(field.name);

    // Automation matches by NAME, which is how the index is keyed. An entry found is real
    // evidence; an entry missing is only evidence when the index is complete and current,
    // which is what automationEvidence decides.
    const entry = (automationIndex?.entries ?? [])
      .find((e) => String(e.label ?? "").toLowerCase() === String(field.name ?? "").toLowerCase());

    const [screens, filters, dashboards] = await Promise.all([
      screenMeta?.version
        ? loadScreensForField(installationKey, screenMeta.version, fieldId)
            .then((rows) => ({ available: true, screens: rows, unresolvedScreens: Number(screenMeta.unresolvedScreens) || 0 }))
            .catch(() => null)
        : Promise.resolve(null),
      filterMeta?.version && nameKnown
        ? loadFilterReferencesFor(installationKey, filterMeta.version, "field", field.name)
            .then((rows) => ({ available: true, count: rows.length, names: rows.map((r) => r.name).filter(Boolean) }))
            .catch(() => null)
        : Promise.resolve(null),
      dashMeta?.version && nameKnown
        ? getDashboardUsage({ payload: { label: field.name }, context })
            .then((d) => (d?.available
              ? { available: true, count: Number(d.total) || 0, names: (d.dashboards || []).map((x) => x.name).filter(Boolean) }
              : null))
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    assessments.push(assessFieldDeletion({
      field,
      usage: catalogAvailable && byId.has(fieldId)
        ? { totalIssueCount: field.totalIssueCount, activeProjectCount: field.activeProjectCount }
        : null,
      screens,
      automation: nameKnown && (entry || automationEvidence)
        ? {
            available: Boolean(automationParts?.analysis),
            writeCount: entry?.writeCount ?? 0,
            readCount: entry?.readCount ?? 0,
            triggerCount: entry?.triggerCount ?? 0,
            evidence: automationEvidence,
          }
        : null,
      filters,
      dashboards,
      rqt: rqtById.size > 0 || rqtRows
        ? { available: true, issueCount: Number(rqtById.get(fieldId)?.issueCount) || 0 }
        : null,
      invisibleData: invisibleById.get(fieldId) || null,
      workflowRules: workflowEvidence?.get(fieldId) ?? null,
    }));
  }

  return {
    available: true,
    ...summarizeDeletionSafety(assessments),
    // Named rather than dropped. A report that silently answered 50 of 80 questions would be
    // worse than one that refused.
    skipped,
    maxFields: MAX_DELETION_SAFETY_FIELDS,
    // Per-pillar freshness: the halves refresh independently and the verdict is only as
    // current as the oldest one it drew on.
    freshness: {
      fields: fieldMeta.refreshedAt || null,
      screens: screenMeta?.refreshedAt || null,
      filters: filterMeta?.refreshedAt || null,
      dashboards: dashMeta?.refreshedAt || null,
      automation: automationParts?.analysis?.refreshedAt ?? null,
    },
  };
}

export async function getScreenFieldCrossSignal({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const [screenMeta, fieldMeta] = await Promise.all([
    readScreenSnapshotMeta(installationKey),
    readSnapshotMeta(installationKey),
  ]);

  // Either half missing makes the cross meaningless rather than empty. Saying which half is
  // missing is the difference between a next step and a shrug.
  if (!screenMeta?.version || !fieldMeta?.version) {
    return {
      available: false,
      reason: !screenMeta?.version
        ? "No screen inventory has been built yet. Build one from the Screens tab or run a full scan."
        : "No field snapshot has been built yet, so there is no usage to cross the screens against.",
      screenRefreshedAt: screenMeta?.refreshedAt || null,
      fieldRefreshedAt: fieldMeta?.refreshedAt || null,
      invisibleData: [],
      formClutter: [],
      unreachableFields: [],
    };
  }

  const clutterMaxIssues = Math.max(0, Number(payload?.clutterMaxIssues) || 0);
  const summary = await runScreenFieldCross(installationKey, screenMeta, fieldMeta, { clutterMaxIssues });

  return {
    ...summary,
    // Per-pillar freshness, because the two halves refresh independently and a verdict that
    // blends them is only as current as the older one.
    screenRefreshedAt: screenMeta.refreshedAt || null,
    fieldRefreshedAt: fieldMeta.refreshedAt || null,
  };
}

// The join itself, shared by the on-demand read above and the scan stage below so the tab
// and the health score can never be computing it two different ways.
//
// This is the widest join in the app: every project's screen chain down to each screen's
// fields, against every populated field x project pair. Fine once on a queue consumer;
// deliberately never on the Overview read, which takes the stored summary instead.
async function runScreenFieldCross(installationKey, screenMeta, fieldMeta, { clutterMaxIssues = 0 } = {}) {
  const [reachabilityRows, coverage, usageRead, catalog, pairRead] = await Promise.all([
    loadFieldReachabilityByProject(installationKey, screenMeta.version),
    loadProjectScreenCoverage(installationKey, screenMeta.version),
    loadPopulatedProjectUsage(installationKey, fieldMeta.version),
    loadSnapshotFields(installationKey, fieldMeta.version).catch(() => []),
    // Form clutter reads a missing pair as "never filled", so it needs every pair, not the
    // capped top of the list invisible data can live with. A failed read withholds it.
    loadPopulatedFieldProjectPairs(installationKey, fieldMeta.version, { minIssues: clutterMaxIssues })
      .catch(fallbackOn("screen_cross.pairs_load_failed", { pairs: null, complete: false }, { installationKey })),
  ]);

  const fields = new Map((catalog || []).map((f) => [String(f.id), { name: f.name }]));

  return summarizeScreenFieldCross({
    reachabilityRows,
    coverage,
    usage: usageRead.rows,
    usageTruncated: usageRead.truncated,
    fieldIds: [...fields.keys()],
    fields,
    clutterMaxIssues,
    populatedPairs: pairRead.pairs || new Set(),
    pairsComplete: Boolean(pairRead.pairs) && pairRead.complete,
    // Never tallied by the issue crawl, so never absent for a reason that means anything.
    unmeasuredFieldIds: STRUCTURAL_SYSTEM_FIELDS,
  });
}

// Run on the health stage of every scan, where an expensive join belongs, and persist only
// the counts. Returns the same shape the score consumes so the caller does not have to read
// back what it just wrote.
//
// Best-effort by construction: a site with no screen inventory, or a failure in either half,
// leaves the two dimensions unavailable rather than failing the health stage. An absent
// dimension is excluded from the mean; a thrown one would cost the whole score.
export async function computeAndStoreScreenCross(installationKey) {
  try {
    const [screenMeta, fieldMeta] = await Promise.all([
      readScreenSnapshotMeta(installationKey),
      readSnapshotMeta(installationKey),
    ]);
    if (!screenMeta?.version || !fieldMeta?.version) return null;

    const summary = await runScreenFieldCross(installationKey, screenMeta, fieldMeta);
    if (!summary.available) return summary;

    await writeScreenCrossSummary(installationKey, {
      ...summary,
      screenVersion: screenMeta.version,
      fieldVersion: fieldMeta.version,
      computedAt: new Date().toISOString(),
    }).catch(ignoreWith("screen_cross.summary_write_failed", { installationKey }));

    return summary;
  } catch (error) {
    logger.warn("screen_cross.compute_failed", { installationKey, error: String(error?.message || error) });
    return null;
  }
}

async function getScreenFieldReportInputs({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const screenIds = Array.from(new Set(requireArray(payload?.screenIds, "screenIds").map((v) => String(v || "").trim()).filter(Boolean)));
  if (!screenIds.length) throw new Error("Select at least one screen.");

  const meta = await readScreenSnapshotMeta(installationKey);
  if (!meta?.version) return { available: false, reason: "No screen inventory has been built yet." };

  const screens = await loadScreensWithFieldsByIds(installationKey, meta.version, screenIds);
  const fieldMap = new Map();
  for (const screen of screens) {
    for (const field of screen.fields) {
      if (!fieldMap.has(field.fieldId)) fieldMap.set(field.fieldId, field.fieldName);
    }
  }

  const projects = await screensToProjects(installationKey, meta.version, screenIds);
  // Only projects the caller may browse, for the same reason getProjectUsageReport filters:
  // the report must never be the one place a project's existence leaks.
  const browsable = await getBrowsableProjectIds(context?.accountId, projects.map((p) => p.projectId));
  const scopedProjects = projects.filter((p) => browsable.has(String(p.projectId)));

  return {
    available: true,
    fieldIds: [...fieldMap.keys()],
    fields: [...fieldMap.entries()].map(([fieldId, fieldName]) => ({ fieldId, fieldName })),
    projectIds: scopedProjects.map((p) => p.projectId),
    projects: scopedProjects,
    screens: screens.map((s) => ({ screenId: s.screenId, name: s.name, fieldCount: s.fields.length, tabsResolved: s.tabsResolved })),
    // Screens the caller asked for that the catalog does not have, or whose tabs the build
    // could not read -- so the tab can say the field list may be incomplete.
    unresolvedScreens: screens.filter((s) => s.tabsResolved !== "resolved").map((s) => s.name),
    missingScreenIds: screenIds.filter((id) => !screens.some((s) => s.screenId === id)),
  };
}

// "Build a field report from this project's screens, organised by screen scheme." The
// project has one issue type screen scheme; that ITSS maps issue types to screen schemes,
// each of which routes create/edit/view operations to screens. Grouped by screen scheme so
// the caller can pick which parts of the process to report on.
async function getProjectScreenReportInputs({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const projectId = requireNonEmptyString(payload?.projectId, "projectId");

  const browsable = await getBrowsableProjectIds(context?.accountId, [projectId]);
  if (!browsable.has(String(projectId))) {
    return { available: false, reason: "You do not have Browse Projects on this project." };
  }

  const meta = await readScreenSnapshotMeta(installationKey);
  if (!meta?.version) return { available: false, reason: "No screen inventory has been built yet." };

  const [itssProjects, mappings, ops, schemes] = await Promise.all([
    loadItssProjects(installationKey, meta.version).catch(() => []),
    loadItssMappings(installationKey, meta.version).catch(() => []),
    loadScreenSchemeOperations(installationKey, meta.version).catch(() => []),
    loadScreenSchemes(installationKey, meta.version).catch(() => []),
  ]);

  const itssIds = new Set(itssProjects.filter((p) => String(p.projectId) === String(projectId)).map((p) => String(p.itssId)));
  if (!itssIds.size) {
    return { available: true, projectId, itss: [], reason: "This project's screens could not be resolved through an issue type screen scheme." };
  }

  const schemeName = new Map(schemes.map((s) => [String(s.schemeId), s.name]));
  const projectMappings = mappings.filter((m) => itssIds.has(String(m.itssId)) && m.screenSchemeId);

  // scheme id -> { issueTypeCount, isDefault, screenIds }
  const bySchemeId = new Map();
  for (const m of projectMappings) {
    const key = String(m.screenSchemeId);
    if (!bySchemeId.has(key)) bySchemeId.set(key, { schemeId: key, issueTypeCount: 0, isDefault: false, screenIds: new Set() });
    const entry = bySchemeId.get(key);
    entry.issueTypeCount += 1;
    if (m.isDefault) entry.isDefault = true;
  }
  for (const o of ops) {
    const entry = bySchemeId.get(String(o.schemeId));
    if (entry && o.screenId) entry.screenIds.add(String(o.screenId));
  }

  const allScreenIds = [...new Set([...bySchemeId.values()].flatMap((e) => [...e.screenIds]))];
  const screens = await loadScreensWithFieldsByIds(installationKey, meta.version, allScreenIds);
  const screenById = new Map(screens.map((s) => [s.screenId, s]));

  const schemeGroups = [...bySchemeId.values()]
    .map((entry) => {
      const groupScreens = [...entry.screenIds]
        .map((id) => screenById.get(id))
        .filter(Boolean)
        .map((s) => ({ screenId: s.screenId, name: s.name, fieldIds: s.fields.map((f) => f.fieldId), fieldCount: s.fields.length }));
      const fieldIds = [...new Set(groupScreens.flatMap((s) => s.fieldIds))];
      return {
        schemeId: entry.schemeId,
        schemeName: schemeName.get(entry.schemeId) || entry.schemeId,
        issueTypeCount: entry.issueTypeCount,
        isDefault: entry.isDefault,
        screens: groupScreens,
        fieldIds,
      };
    })
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.fieldIds.length - a.fieldIds.length || a.schemeName.localeCompare(b.schemeName));

  return {
    available: true,
    projectId,
    scopeProjectIds: [String(projectId)],
    schemes: schemeGroups,
    allFieldIds: [...new Set(schemeGroups.flatMap((g) => g.fieldIds))],
  };
}

async function startProjectUsageReportJob({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  // Input validation
  const rawFieldIds = requireArray(payload?.fieldIds, "fieldIds");
  if (rawFieldIds.length < 1) throw new Error("fieldIds must contain at least 1 element");
  await ensureProjectStoreReady();
  const fieldIds = Array.from(new Set((payload?.fieldIds || []).map((value) => String(value || "").trim()).filter(Boolean)));
  if (!fieldIds.length) {
    throw new Error("Select at least one field for the report.");
  }

  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    throw new Error("No completed snapshot available â€” build one first.");
  }

  const jobId = makeJobToken();
  const reportName = String(payload?.reportName || "").trim() || "Project Usage Report";
  await replaceReportJob(installationKey, jobId, {
    reportName,
    status: "queued",
    fieldIds,
    processedFields: 0,
    totalFields: fieldIds.length,
    nextOffset: 0,
    startedAt: null,
    completedAt: null,
    refreshedAt: new Date().toISOString(),
    lastError: null,
    progressLog: [{ t: new Date().toISOString(), msg: `Queued report build for ${fieldIds.length.toLocaleString()} fields` }],
    result: { fields: [], projects: [], pendingFields: [], uniqueIssueCount: null },
  });
  await queueReportBuild(installationKey, meta.version, jobId);
  return { jobId };
}

async function getProjectUsageReportJob({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const jobId = String(payload?.jobId || "").trim();
  if (!jobId) {
    return { job: null };
  }
  const job = await loadReportJob(installationKey, jobId);
  if (!job) {
    return { job: null };
  }

  // Filter at READ time using the CURRENT caller's own permissions, not the
  // admin who originally started the job -- this is the only enforcement point
  // for stored report results, since the same job can be read by many
  // different people (with different Browse Projects access) over time.
  const candidateProjectIds = (job.result?.projects || []).map((p) => p.projectId);
  const browsableProjectIds = await getBrowsableProjectIds(context?.accountId, candidateProjectIds);
  const filteredResult = job.result ? filterProjectUsageByBrowsable(job.result, browsableProjectIds) : job.result;

  return {
    job: {
      ...job,
      result: filteredResult,
      percentComplete: job.totalFields > 0 ? Math.min(100, Math.round((job.processedFields / job.totalFields) * 100)) : 0,
    },
  };
}

async function getProjectsView({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  // Input validation
  if (payload?.page !== undefined && payload?.page !== null) requirePositiveInt(payload.page, "page");
  optionalString(payload?.projectId, "projectId");
  optionalString(payload?.fieldType, "fieldType");
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    return {
      projects: [],
      availableTypes: [],
      selectedProject: null,
      fields: [],
      totalFields: 0,
      page: 1,
      totalPages: 1,
      pageSize: PROJECTS_VIEW_PAGE_SIZE,
      refreshedAt: null,
    };
  }

  const projectQuery = String(payload?.projectQuery || "").trim();
  const fieldQuery = String(payload?.fieldQuery || "").trim();
  const fieldType = String(payload?.fieldType || "all").trim() || "all";
  const sortBy = String(payload?.sortBy || "issues-desc").trim() || "issues-desc";
  const requestedPage = Math.max(1, Math.trunc(Number(payload?.page)) || 1);

  const [rawProjects, issueScanMeta] = await Promise.all([
    listSnapshotProjects(installationKey, meta.version, projectQuery),
    readIssueScanMeta(installationKey).catch(fallbackOn("resolver.scan_meta_read_failed", null, { installationKey })),
  ]);

  // ProjectsTab has always been written to prefer uniqueIssueCount and fall back to
  // "fills" -- but nothing ever populated it, so the fallback was permanent and the
  // correct branch was unreachable. Attach it here.
  const allProjects = await attachUniqueIssueCounts(installationKey, rawProjects);

  // Adoption for every project the rail can show, so it can be sorted and filtered by it.
  // Best-effort: a site scanned before issue dates were captured renders the rail exactly as
  // it does today, with the adoption panel reporting itself unmeasured.
  const activity = await loadProjectActivity(installationKey)
    .catch(fallbackOn("projects.activity_load_failed", () => new Map(), { installationKey }));

  // Only show projects the CALLING user actually has Browse Projects
  // permission on -- never surface another project's name/existence to
  // someone who can't see it in Jira itself.
  const browsableProjectIds = await getBrowsableProjectIds(
    context?.accountId,
    allProjects.map((p) => p.projectId)
  );
  const projects = allProjects.filter((p) => browsableProjectIds.has(String(p.projectId)));

  // Scored across the projects the reader may browse, not across the site.
  //
  // A percentile is only meaningful against a population, and the population a reader can
  // reason about is the one in front of them. Scoring against every project on the site would
  // put a project in the 90th percentile of a list they cannot see the rest of.
  const adoption = summarizeAdoption(projects, activity);
  const adoptionByProject = new Map(adoption.projects.map((row) => [String(row.projectId), row]));

  const selectedProjectId = String(payload?.projectId || "").trim() || projects[0]?.projectId || "";
  const selectedProject = projects.find((project) => project.projectId === selectedProjectId) || projects[0] || null;
  // The rail carries only what it sorts and filters on. The monthly series is per selected
  // project, because 200 projects' worth of history is not a sidebar.
  const railAdoption = (project) => {
    const row = adoptionByProject.get(String(project.projectId));
    if (!row?.measured) return null;
    return {
      score: row.score, issuesPerDay: row.issuesPerDay, recentIssuesPerDay: row.recentIssuesPerDay,
      momentum: row.momentum, ageDays: row.ageDays, firstIssueCreatedAt: row.firstIssueCreatedAt,
      // Decline flags are held back site-wide while the activity histogram is stale -- the
      // same suppression summarizeAdoption applies to the headline counts, carried to the
      // rail so it does not paint every project with a "fell off" tag the data cannot support.
      fellOff: adoption.dataStale ? false : row.fellOff,
      neverAdopted: adoption.dataStale ? false : row.neverAdopted,
      declineFrom: adoption.dataStale ? null : row.declineFrom,
    };
  };

  if (!selectedProject) {
    return {
      projects: [],
      availableTypes: [],
      selectedProject: null,
      fields: [],
      totalFields: 0,
      page: 1,
      totalPages: 1,
      pageSize: PROJECTS_VIEW_PAGE_SIZE,
      refreshedAt: meta.refreshedAt || null,
      issueScan: issueScanMeta ? {
        state: issueScanMeta.state,
        completedAt: issueScanMeta.completedAt,
        totalIssues: issueScanMeta.totalIssues,
        processedIssues: issueScanMeta.processedIssues,
        totalPages: issueScanMeta.totalPages,
        processedPages: issueScanMeta.processedPages,
        lastError: issueScanMeta.lastError,
      } : null,
    };
  }

  const offset = (requestedPage - 1) * PROJECTS_VIEW_PAGE_SIZE;
  const projectFieldsResult = await loadSnapshotProjectFields(
    installationKey,
    meta.version,
    selectedProject.projectId,
    {
      query: fieldQuery,
      type: fieldType,
      sortBy,
      limit: PROJECTS_VIEW_PAGE_SIZE,
      offset,
    }
  );

  // Which workflow scheme governs the selected project, and how many other projects
  // share it. Best-effort: the workflow snapshot is versioned independently of the field
  // snapshot and may not have been built at all, in which case the Projects tab simply
  // omits the panel rather than erroring. Never let a missing workflow snapshot break
  // the field view, which is the reason anyone opened this tab.
  const workflowScheme = await (async () => {
    try {
      const wfMeta = await readWorkflowSnapshotMeta(installationKey);
      if (!wfMeta?.version) return null;

      const scheme = await loadWorkflowSchemeForProject(
        installationKey, wfMeta.version, selectedProject.projectId
      );
      if (!scheme) return null;

      // Sharing count is computed from the projects the VIEWER can browse, matching the
      // enforcement in getWorkflowInventory -- otherwise "shared with 12 projects" leaks
      // the existence of projects this user cannot see.
      const schemeProjects = await loadWorkflowSchemeProjects(
        installationKey, wfMeta.version, scheme.schemeId
      );
      const browsable = await getBrowsableProjectIds(
        context?.accountId, schemeProjects.map((p) => p.projectId)
      );
      const visible = schemeProjects.filter((p) => browsable.has(String(p.projectId)));

      return {
        schemeId: scheme.schemeId,
        name: scheme.name,
        description: scheme.description,
        sharedWithCount: Math.max(0, visible.length - 1),
        siblingProjects: visible
          .filter((p) => String(p.projectId) !== String(selectedProject.projectId))
          .slice(0, 12)
          .map((p) => ({ projectId: p.projectId, projectKey: p.projectKey, projectName: p.projectName })),
        refreshedAt: wfMeta.refreshedAt || null,
      };
    } catch (error) {
      console.warn("getProjectsView: workflow scheme lookup failed:", error?.message || error);
      return null;
    }
  })();

  const fields = projectFieldsResult.rows.map((field) => ({
    fieldId: field.fieldId,
    fieldName: field.fieldName,
    description: field.description,
    fieldType: field.fieldType,
    configuredProjectCount: field.configuredProjectCount,
    totalIssueCount: field.totalIssueCount,
    activeProjectCount: field.activeProjectCount,
    issueCount: field.issueCount,
    jql: field.jql || buildFieldJql(selectedProject.projectKey, field.fieldId),
    latestFieldChangeAt: field.latestFieldChangeAt,
    latestIssueKey: field.latestIssueKey,
    latestIssueUpdatedAt: field.latestIssueUpdatedAt,
    findings: field.findings || null,
    isJiraBuiltin: isJiraBuiltinField({ customType: field.customType }),
  }));

  const availableTypes = Array.from(
    new Set(projectFieldsResult.rows.map((field) => field.fieldType).filter(Boolean))
  ).sort((left, right) => left.localeCompare(right));
  const totalFields = Number(projectFieldsResult.total || 0);
  const totalPages = Math.max(1, Math.ceil(totalFields / PROJECTS_VIEW_PAGE_SIZE));

  return {
    projects: projects.map((project) => ({ ...project, adoption: railAdoption(project) })),
    availableTypes,
    selectedProject,
    // The selected project's adoption in full, monthly series included. This is what dates a
    // decline: "fell off in 2023-04" comes from the shape, not from a single number.
    selectedAdoption: selectedProject
      ? adoptionByProject.get(String(selectedProject.projectId)) ?? null
      : null,
    // What normal looks like here, so a rate has something to be read against.
    adoptionContext: {
      available: adoption.available,
      medianIssuesPerDay: adoption.medianIssuesPerDay,
      measuredProjects: adoption.measuredProjects,
      totalProjects: adoption.totalProjects,
      // So the panel can say "activity data ends 2026-01, the last scan didn't finish"
      // instead of presenting a stale recent rate as a measurement.
      dataThroughMonth: adoption.dataThroughMonth,
      dataStale: adoption.dataStale,
    },
    workflowScheme,
    fields,
    totalFields,
    page: Math.min(requestedPage, totalPages),
    totalPages,
    pageSize: PROJECTS_VIEW_PAGE_SIZE,
    refreshedAt: meta.refreshedAt || null,
    issueScan: issueScanMeta ? {
      state: issueScanMeta.state,
      completedAt: issueScanMeta.completedAt,
      totalIssues: issueScanMeta.totalIssues,
      processedIssues: issueScanMeta.processedIssues,
      totalPages: issueScanMeta.totalPages,
      processedPages: issueScanMeta.processedPages,
      lastError: issueScanMeta.lastError,
    } : null,
  };
}

async function getFilteredFieldIds({ payload, context }) {
  // Input validation
  optionalString(payload?.fieldType, "fieldType");
  optionalString(payload?.sort, "sort");
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    return { fieldIds: [] };
  }

  const query = String(payload?.query || "").trim();
  const optionQuery = String(payload?.optionQuery || "").trim();
  const type = String(payload?.type || "all").trim() || "all";
  const findingsFilter = String(payload?.findingsFilter || "all").trim() || "all";
  const projectUsageFilter = String(payload?.projectUsageFilter || "all").trim() || "all";
  const minIssuesWithValue = payload?.minIssuesWithValue ?? "";
  const maxIssuesWithValue = payload?.maxIssuesWithValue ?? "";
  const fieldOrigin = String(payload?.fieldOrigin || "all").trim() || "all";
  const sortBy = String(payload?.sortBy || "name-asc").trim() || "name-asc";
  const minActiveProjects = payload?.minActiveProjects ?? "";
  const maxActiveProjects = payload?.maxActiveProjects ?? "";
  const minContexts = payload?.minContexts ?? "";
  const maxContexts = payload?.maxContexts ?? "";
  const duplicateNamesOnly = Boolean(payload?.duplicateNamesOnly);
  const hasDescription = payload?.hasDescription || "all";
  const hideSystemFields = Boolean(payload?.hideSystemFields);
  const snapshotFields = await loadSnapshotFields(installationKey, meta.version);
  const fieldSummaries = await listFieldSummaries(installationKey, 5000).catch(fallbackOn("resolver.summaries_load_failed", () => [], { installationKey }));
  const summaryByFieldId = new Map(fieldSummaries.map((summary) => [summary.fieldId, summary]));
  const duplicateNameCounts = buildDuplicateNameCountMap(snapshotFields);
  const allFields = snapshotFields.map((field) => {
    const summary = summaryByFieldId.get(field.id);
    if (!summary) {
      return hydrateFieldForGovernance({
        ...field,
        projectUsageBuilt: Number(field.totalIssueCount || 0) <= 0,
        projectUsageState: Number(field.totalIssueCount || 0) <= 0 ? "not-needed" : "unbuilt",
      }, null, duplicateNameCounts.get(normalizeFieldName(field.name)) ?? 1);
    }
    const inferredBuilt = summary.summaryStatus === "ready";
    return hydrateFieldForGovernance({
      ...field,
      activeProjectCount: summary.activeProjectCount ?? field.activeProjectCount,
      totalIssueCount: summary.totalIssueCount ?? field.totalIssueCount,
      projectUsageBuilt: inferredBuilt,
      projectUsageState: summary.summaryStatus || (inferredBuilt ? "ready" : "unbuilt"),
    }, summary, duplicateNameCounts.get(normalizeFieldName(field.name)) ?? 1);
  });
  const optionMatches = optionQuery ? await searchFieldOptionsCache(installationKey, optionQuery, 5000) : null;
  const optionMatchedFieldIds = optionMatches ? new Set(optionMatches.map((match) => match.fieldId)) : null;
  const optionFilteredFields = optionMatchedFieldIds
    ? allFields.filter((field) => optionMatchedFieldIds.has(field.id))
    : allFields;
  const filtered = sortInventoryFields(
    applyFindingsFilter(
      filterInventoryFields(optionFilteredFields, query, type, projectUsageFilter, maxIssuesWithValue, fieldOrigin, minIssuesWithValue, {
        minActiveProjects, maxActiveProjects, minContexts, maxContexts, duplicateNamesOnly, hasDescription, hideSystemFields,
      }),
      findingsFilter
    ),
    sortBy
  );
  return { fieldIds: filtered.map((field) => field.id) };
}

async function searchFieldOptions({ payload, context }) {
  // Input validation
  requireNonEmptyString(payload?.fieldId, "fieldId");
  if (payload?.query !== undefined && payload?.query !== null) requireNonEmptyString(payload.query, "query");
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const optionQuery = String(payload?.optionQuery || "").trim();
  if (!optionQuery) {
    return { status: "empty", matches: [], nextIndex: 0, done: true, scanned: 0, totalCandidates: 0 };
  }

  const matches = await searchFieldOptionsCache(installationKey, optionQuery, 500);

  return {
    status: "ok",
    optionQuery,
    matches: matches.map((match) => match.fieldId),
    nextIndex: matches.length,
    done: true,
    scanned: matches.length,
    totalCandidates: matches.length,
  };
}

// Start the one scan that runs everything.
//
// Every pillar already had its own build button on its own tab, which meant "scan the site"
// was a checklist: know which six to press, and in what order, or the tabs disagree with each
// other afterwards. This is that checklist made into one action.
//
// Automation is deliberately not included. Jira publishes no API to enumerate automation
// rules -- that pillar is fed by importing a rule export by hand -- and a scan that silently
// skipped it while claiming to run everything would be worse than one that says what it covers.
async function startFullSiteScan({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { started: false, error: "Read-only mode is enabled. Disable it before running a scan." };
  }

  return startFullScan(installationKey);
}

// The one "Resume" button, context-aware:
//
//  - a scan that FINISHED with failed pillars  -> resumeScanRun: put the failed/skipped
//    stages back to pending and walk them again, leaving the ones that built alone.
//  - a scan still "running" but wedged          -> recoverStalledScan(force): re-kick the
//    orchestrator loop from its last checkpoint.
//
// Neither is gated on read-only mode: finishing or unwedging a scan that already started is
// cleanup, not a new scan.
async function resumeSiteScan({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readFullScanMeta(installationKey).catch(() => null);
  if (meta?.state === "completed-with-failures") {
    return resumeScanRun(installationKey);
  }
  return recoverStalledScan(installationKey, { force: true });
}

// Stop a running full or quick scan outright. Writes the terminal "cancelled" state, which
// is what frees the shared meta row for a fresh run -- a scan wedged in "running" otherwise
// blocks every future scan, with no way out from the UI.
async function cancelSiteScan({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  return cancelScan(installationKey);
}

// The full/quick scan's "Record site health" stage, wired to its dependencies here.
//
// captureSiteHealth is dependency-injected on purpose -- site-health.js stays testable
// without the Forge modules -- and full-scan-runner.js cannot supply the deps itself without
// importing this file, which would be a module cycle. So the orchestrator dynamic-imports
// this wrapper, the same way it reaches runDeltaIssueScanJob for the issues-delta stage.
// captureSiteHealth never throws; a missing dep would fail the scan, which is exactly the
// bug this replaces.
export async function captureSiteHealthForScan(installationKey) {
  return captureSiteHealth(installationKey, {
    readSnapshotMeta,
    loadSnapshotFields,
    listSnapshotProjects,
    attachUniqueIssueCounts,
    buildDuplicateNameCountMap,
    hydrateFieldForGovernance,
    readAdminConfig,
    readAutomationAnalysis,
    recordHealthSnapshot,
    loadPriorHealthDimensions,
    computeScreenCross: computeAndStoreScreenCross,
  });
}

// The two structural handoff stages -- filters and dashboards -- run on their own queue and
// checkpoint their progress into their own meta row. The orchestrator only knows "running"
// vs "done"; this reaches past it to the sub-build so the stage row can show a real count
// rather than an indeterminate sweep. The issue crawl has its own live view already.
async function handoffStageProgress(installationKey, currentStage) {
  try {
    if (currentStage === "filters") {
      const m = await readFilterSnapshotMeta(installationKey);
      if (!m) return null;
      return { processed: Number(m.processed) || 0, total: Number(m.totalExpected) || 0, lastError: m.lastError || null };
    }
    if (currentStage === "dashboards") {
      const m = await readDashboardSnapshotMeta(installationKey);
      if (!m) return null;
      // The dashboard build runs in three phases -- enumerate, walk gadgets, resolve gadget
      // configs -- and the count means something different in each. Naming the phase is what
      // turns "3,836 of 5,226" from a mystery into "resolving what each gadget points at".
      const phaseLabels = {
        list: "listing dashboards",
        gadgets: "reading each dashboard's gadgets",
        configs: "resolving what each gadget points at",
      };
      let phase = null;
      try { phase = JSON.parse(m.buildCursor || "null")?.phase || null; } catch { phase = null; }
      return {
        processed: Number(m.processed) || 0,
        total: Number(m.totalExpected) || 0,
        lastError: m.lastError || null,
        note: phase ? phaseLabels[phase] || null : null,
      };
    }
  } catch {
    return null;
  }
  return null;
}

// Kick stall recovery from the status read itself, when the meta says a scan is running but
// its heartbeat has gone quiet past the stall window.
//
// The hourly scheduled trigger is the backstop, but "up to an hour wedged" is not good
// enough when an admin is sitting on the page watching it. The status resolver is polled
// every few seconds while a scan runs, so this heals within one poll of the stall -- exactly
// when someone is looking. recoverStalledScan self-gates (it re-reads the meta, no-ops a
// healthy run, and is bounded by MAX_SCAN_RECOVERIES), so firing it here is safe. Fire and
// forget: the kick's effect shows on the next poll, and the current response must not wait
// on a queue push.
function maybeRecoverStalledScan(installationKey, meta) {
  if (meta?.state !== "running") return;
  const now = Date.now();
  const lastBeat = Date.parse(meta.updatedAt || meta.startedAt || "") || 0;
  const startedMs = Date.parse(meta.startedAt || "") || 0;

  // Two triggers: a heartbeat that has gone quiet past the stall window (a wedged loop), or
  // a run that has been going past its absolute wall-clock ceiling (a zombie whose loop
  // still ticks but never finishes). recoverStalledScan handles both -- it fails the run out
  // on the second. Fire and forget: the effect shows on the next poll.
  const stalled = lastBeat && now - lastBeat > FULL_SCAN_STALL_MS;
  const overLimit = startedMs && now - startedMs > MAX_SCAN_TOTAL_MS;
  if (!stalled && !overLimit) return;

  recoverStalledScan(installationKey).catch(
    fallbackOn("scan.autorecover_failed", null, { installationKey })
  );
}

// Recent runs for run-over-run deltas, plus what each pillar currently holds.
//
// liveStageCounts is read from the pillar metas EVERY time, not just mid-scan: a run that was
// cancelled, or finished before this bookkeeping existed, has no full_scan_runs row, and
// without the live read every stage on the page shows "Produced —". The pillar metas are the
// source of truth and always readable. Both are best-effort -- the page degrades rather than
// erroring if either read fails.
async function scanRunHistory(installationKey, scanType) {
  const [recentRuns, liveStageCounts] = await Promise.all([
    readRecentFullScanRuns(installationKey, { scanType, limit: 8 })
      .catch(fallbackOn("scan.recent_runs_read_failed", [], { installationKey })),
    readStageProducedCounts(installationKey, scanType)
      .catch(fallbackOn("scan.live_counts_read_failed", {}, { installationKey })),
  ]);
  return { recentRuns, liveStageCounts };
}

// Progress for the Scans tab: one row per stage, plus the catalog so the tab can render the
// full list before a scan has ever run rather than an empty panel.
async function getFullScanStatus({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  const meta = await readFullScanMeta(installationKey).catch(
    fallbackOn("full_scan.meta_read_failed", null, { installationKey })
  );

  // A row with no scanType at all predates the quick-scan split and is treated as a full
  // scan's own row, so a scan started just before this shipped still renders correctly.
  const isFull = !meta?.scanType || meta.scanType === "full";
  const currentStage = isFull ? (meta?.currentStage || null) : null;
  if (isFull) maybeRecoverStalledScan(installationKey, meta);
  const { recentRuns, liveStageCounts } = await scanRunHistory(installationKey, "full");

  return {
    catalog: fullScanStageCatalog(),
    state: isFull ? (meta?.state || "idle") : "idle",
    stages: isFull && meta?.stages?.length ? meta.stages : null,
    currentStage,
    currentStageProgress: currentStage ? await handoffStageProgress(installationKey, currentStage) : null,
    startedAt: isFull ? (meta?.startedAt || null) : null,
    completedAt: isFull ? (meta?.completedAt || null) : null,
    updatedAt: isFull ? (meta?.updatedAt || null) : null,
    lastError: isFull ? (meta?.lastError || null) : null,
    // How many full retry passes over the stage list this run has taken. Surfaced so the
    // page can show "sweep 2 of 2" rather than the rail silently resetting.
    sweep: isFull ? (Number(meta?.sweep) || 0) : 0,
    recentRuns,
    liveStageCounts,
    // So the panel can say "a quick scan is running" rather than rendering an idle full-scan
    // panel with no explanation for why the button is disabled.
    blockedByOtherScan: meta?.state === "running" && !isFull,
  };
}

// The quick scan's manual trigger. windowHours defaults to the stored schedule's, so a manual
// "run now" between scheduled runs asks the same question the schedule would have -- "what
// changed since the window" -- rather than an arbitrary different one.
async function startQuickSiteScan({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { started: false, error: "Read-only mode is enabled. Disable it before running a scan." };
  }

  const windowHours = Number(payload?.windowHours) || Number(adminConfig.quickScanSchedule?.windowHours) || DELTA_ISSUE_SCAN_DEFAULT_WINDOW_HOURS;
  return startQuickScan(installationKey, { quickScanWindowHours: windowHours });
}

// Progress for the quick scan, same shape as getFullScanStatus so the tab can render both
// with one component.
async function getQuickScanStatus({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  const meta = await readFullScanMeta(installationKey).catch(
    fallbackOn("quick_scan.meta_read_failed", null, { installationKey })
  );

  const isQuick = meta?.scanType === "quick";
  const currentStage = isQuick ? (meta?.currentStage || null) : null;
  if (isQuick) maybeRecoverStalledScan(installationKey, meta);
  const { recentRuns, liveStageCounts } = await scanRunHistory(installationKey, "quick");

  return {
    catalog: quickScanStageCatalog(),
    // Only reported as belonging to THIS scan type when the shared meta row actually says so
    // -- a full scan's stages must never render on the quick scan panel just because it is
    // the most recent thing to have used the shared row.
    state: isQuick ? (meta?.state || "idle") : "idle",
    stages: isQuick && meta?.stages?.length ? meta.stages : null,
    currentStage,
    currentStageProgress: currentStage ? await handoffStageProgress(installationKey, currentStage) : null,
    startedAt: meta?.scanType === "quick" ? (meta?.startedAt || null) : null,
    completedAt: meta?.scanType === "quick" ? (meta?.completedAt || null) : null,
    updatedAt: meta?.scanType === "quick" ? (meta?.updatedAt || null) : null,
    lastError: meta?.scanType === "quick" ? (meta?.lastError || null) : null,
    sweep: isQuick ? (Number(meta?.sweep) || 0) : 0,
    recentRuns,
    liveStageCounts,
    windowHours: meta?.scanType === "quick" ? meta?.quickScanWindowHours : null,
    // So the panel can say "a full scan is running" rather than rendering an idle quick-scan
    // panel with no explanation for why the button is disabled.
    blockedByOtherScan: meta?.state === "running" && meta?.scanType !== "quick",
  };
}

// Bookkeeping for the scheduled trigger, not the save-config resolver: this writes one field
// with no payload validation, because the caller is this app's own scheduler rather than user
// input. Kept separate from saveAdminConfigResolver so a scheduled run can never accidentally
// pass through the same path a person's config edit does and clobber a field they were mid-way
// through changing.
export async function recordQuickScanScheduledRun(at) {
  const current = await readAdminConfig();
  await kvs.set(ADMIN_CONFIG_KEY, {
    ...current,
    quickScanSchedule: { ...current.quickScanSchedule, lastScheduledRunAt: at },
  });
}

async function startIssueScan({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const currentMeta = await readIssueScanMeta(installationKey);
  if (currentMeta?.state === "building" || currentMeta?.state === "queued") {
    return { started: false, reason: "already-running", meta: currentMeta };
  }

  const jobToken = makeJobToken();
  await writeIssueScanMeta(installationKey, {
    state: "queued",
    jobToken,
    lastError: null,
    progressLog: [{ t: new Date().toISOString(), msg: "Issue scan queued" }],
  });

  try {
    await inventorySnapshotQueue.push({
      body: { jobType: "run-issue-scan", installationKey },
    });
  } catch (pushError) {
    await writeIssueScanMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: `Queue push failed: ${pushError?.message || String(pushError)}`,
      progressLog: [{ t: new Date().toISOString(), msg: `Failed to queue scan: ${pushError?.message || String(pushError)}` }],
    }).catch(ignoreWith("scan.queue_failure_write_failed", { installationKey }));
    throw pushError;
  }

  return { started: true, jobToken };
}

async function resumeIssueScan({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const currentMeta = await readIssueScanMeta(installationKey);

  if (!currentMeta) {
    return { resumed: false, reason: "no-scan" };
  }

  if (currentMeta.state === "ready") {
    return { resumed: false, reason: "already-complete", meta: currentMeta };
  }

  const jobToken = currentMeta.jobToken || makeJobToken();
  const progressLog = [
    ...(currentMeta.progressLog || []).slice(-180),
    { t: new Date().toISOString(), msg: "Resume requested; re-queueing incomplete workers from saved checkpoint" },
  ];

  // Mark scan as building again (preserving all existing progress state)
  const meta = await writeIssueScanMeta(installationKey, {
    ...currentMeta,
    state: "building",
    jobToken,
    completedAt: null,
    lastError: null,
    progressLog,
  });

  // Re-queue only workers that haven't finished â€” do NOT call the coordinator
  // (the coordinator wipes all accumulated data and starts over)
  const queueErrors = [];
  let anyRequeued = false;
  for (let workerId = 0; workerId < ISSUE_SCAN_WORKERS; workerId++) {
    const worker = await readIssueScanWorker(installationKey, workerId).catch(fallbackOn("scan.worker_read_failed", null, { workerId }));
    if (!worker || worker.status === "done") continue;
    anyRequeued = true;
    // Reset failed workers back to queued so they can run again
    if (worker.status === "failed") {
      await updateIssueScanWorker(installationKey, workerId, { status: "queued", lastError: null }).catch(ignoreWith("scan.worker_requeue_write_failed", { workerId }));
    }
    try {
      await queueIssueScanWorker(installationKey, workerId);
    } catch (pushError) {
      queueErrors.push(`worker ${workerId}: ${pushError?.message || String(pushError)}`);
    }
  }

  if (queueErrors.length > 0) {
    const errMsg = `Resume partially failed: ${queueErrors.join("; ")}`;
    await writeIssueScanMeta(installationKey, { state: "failed", lastError: errMsg }).catch(ignoreWith("scan.resume_failure_write_failed", { installationKey }));
    throw new Error(errMsg);
  }

  // Every worker already reported "done", so nothing got re-queued above â€” no worker
  // invocation will ever run again to trigger finalization, since that's the only place
  // it's attempted. This happens when the last worker finished mid-cancel: its own
  // finalization claim was rejected because state wasn't "building" at that instant, and
  // the CAS above (which just set state back to "building") is the only thing that makes
  // finalization claimable again. Without this, the scan is stuck at 100%/state=building
  // forever, since re-running resumeIssueScan repeats the exact same no-op indefinitely.
  if (!anyRequeued && (meta?.processedPages ?? 0) >= (meta?.totalPages ?? 0) && (meta?.totalPages ?? 0) > 0) {
    const claimed = await tryClaimIssueScanFinalization(installationKey, jobToken);
    if (claimed) {
      await completeIssueScanFinalization(installationKey, "resumeIssueScan");
      const finalizedMeta = await readIssueScanMeta(installationKey);
      return { resumed: true, jobToken, meta: finalizedMeta, finalizedDirectly: true };
    }
  }

  return { resumed: true, jobToken, meta };
}

// A scan that stops making progress must eventually say so.
//
// Nothing moved a wedged scan out of "building". Workers could fail repeatedly -- the
// audit log shows runs of "400 Bad Request" -- and the job would sit in "building"
// indefinitely, which is worse than failing twice over: the state is a lie, and the admin
// UI polls a "running" job every 15 seconds for as long as a tab is open. One stuck scan
// and one forgotten browser tab is an overnight of SQL for no work.
//
// Progress is judged by the newest progress-log entry rather than startedAt, because a
// long scan legitimately runs for hours -- an hour of silence is the signal, not an hour
// of running.
export const STUCK_SCAN_MS = 30 * 60 * 1000;

export function isScanStuck(meta, now = Date.now()) {
  if (!meta) return false;
  if (meta.state !== "building" && meta.state !== "finalizing") return false;
  const stamps = (meta.progressLog || [])
    .map((entry) => new Date(entry?.t).getTime())
    .filter((n) => Number.isFinite(n));
  const startedAt = new Date(meta.startedAt).getTime();
  // With no usable timestamp at all there is nothing to measure silence against, so the
  // scan is left alone rather than failed on a guess.
  const last = stamps.length ? Math.max(...stamps) : (Number.isFinite(startedAt) ? startedAt : null);
  if (last === null) return false;
  return now - last > STUCK_SCAN_MS;
}

async function getIssueScanStatus({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  let meta = await readIssueScanMeta(installationKey);

  // Fail it here rather than in a scheduled job: this resolver is what an open admin tab
  // polls, so the read that would otherwise keep a dead scan alive is the one that ends it.
  if (isScanStuck(meta)) {
    const minutes = Math.round(STUCK_SCAN_MS / 60000);
    await writeIssueScanMeta(installationKey, {
      ...meta,
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: `No progress for over ${minutes} minutes; marked failed. Resume from checkpoint to continue.`,
      progressLog: [
        ...(meta.progressLog || []).slice(-180),
        { t: new Date().toISOString(), msg: `Scan stalled — no progress for over ${minutes} minutes. Marked failed; resume to retry from the saved checkpoint.` },
      ],
    }).catch(ignoreWith("scan.stuck_write_failed", { installationKey }));
    meta = await readIssueScanMeta(installationKey);
    return { meta: meta || null };
  }

  // "finalizing" is an internal transition state — surface it as "building" to the UI
  if (meta?.state === "finalizing") return { meta: { ...meta, state: "building" } };
  return { meta: meta || null };
}

async function cancelIssueScan({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const current = await readIssueScanMeta(installationKey);
  if (!current || current.state === "idle" || current.state === "ready") {
    return { cancelled: false, reason: "not-running" };
  }

  await writeIssueScanMeta(installationKey, {
    state: "cancelled",
    completedAt: new Date().toISOString(),
    progressLog: [
      ...(current.progressLog || []).slice(-80),
      { t: new Date().toISOString(), msg: "Scan cancelled by user" },
    ],
  });

  return { cancelled: true };
}

async function restoreProjectUsageCache({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    return { started: false, reason: "no-snapshot" };
  }
  await queueProjectUsageRestore(installationKey, meta.version);
  return { started: true, version: meta.version };
}

// ----- Rovo agent actions -----

function formatFieldCandidate(field) {
  return {
    id: field.id,
    name: field.name,
    type: field.type,
    description: field.description || "",
    activeProjectCount: field.activeProjectCount ?? 0,
    totalIssueCount: field.totalIssueCount ?? 0,
    fieldJql: field.fieldJql,
    findings: field.findings || null,
  };
}

function findFieldFromSnapshot(fields, identifier) {
  const n = String(identifier || "").trim().toLowerCase();
  if (!n) return null;
  return (
    fields.find((f) => f.id.toLowerCase() === n) ||
    fields.find((f) => f.name.trim().toLowerCase() === n) ||
    fields.find((f) => f.name.trim().toLowerCase().startsWith(n)) ||
    fields.find((f) =>
      [f.name, f.id, f.description].filter(Boolean).some((v) => v.toLowerCase().includes(n))
    ) ||
    null
  );
}

async function getSnapshotFieldsForAgent(installationKey) {
  await ensureProjectStoreReady();
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    return { fields: [], meta: null, status: { state: meta?.state || "idle" } };
  }
  const fields = await loadSnapshotFields(installationKey, meta.version);
  return { fields, meta, status: { state: meta.state, refreshedAt: meta.refreshedAt } };
}

export async function rovoSearchFields(payload, context) {
  incrMetric(METRIC_NAMES.rovoSearchFields);
  const installationKey = getInstallationKey(context);
  const query = String(payload?.query || "").trim();
  const fieldType = String(payload?.fieldType || "all").trim() || "all";
  const sortBy = String(payload?.sortBy || "usage-desc").trim() || "usage-desc";
  const maxResults = Math.max(1, Math.min(10, Number(payload?.maxResults) || 5));

  if (!query) return { status: "error", message: "A search query is required." };

  const { fields, meta, status } = await getSnapshotFieldsForAgent(installationKey);
  if (!meta) {
    return {
      status: "snapshot-unavailable",
      snapshotStatus: status,
      message: "No snapshot available yet â€” building one now.",
      matches: [],
    };
  }

  const matches = sortInventoryFields(filterInventoryFields(fields, query, fieldType), sortBy).slice(0, maxResults);
  return {
    status: "ok",
    snapshotRefreshedAt: meta.refreshedAt,
    query,
    totalMatches: matches.length,
    matches: matches.map(formatFieldCandidate),
  };
}

export async function rovoInspectField(payload, context) {
  incrMetric(METRIC_NAMES.rovoInspectField);
  const installationKey = getInstallationKey(context);
  const fieldIdentifier = String(payload?.fieldIdentifier || "").trim();
  const usagePage = Math.max(1, Number(payload?.projectPage) || 1);

  if (!fieldIdentifier) return { status: "error", message: "A field identifier is required." };

  const { fields, meta, status } = await getSnapshotFieldsForAgent(installationKey);
  if (!meta) {
    return { status: "snapshot-unavailable", snapshotStatus: status, message: "No snapshot available yet." };
  }

  const matchedField = findFieldFromSnapshot(fields, fieldIdentifier);
  if (!matchedField) {
    return { status: "not-found", snapshotRefreshedAt: meta.refreshedAt, message: `No field matched "${fieldIdentifier}".` };
  }

  const {
    projectUsage: rawProjectUsage,
    total: projectCount,
    totalIssueCount,
  } = await getLiveFieldProjectUsage(matchedField.id, usagePage, PROJECT_USAGE_PAGE_SIZE);

  // Never surface a project's identity to a Rovo caller who lacks Browse
  // Projects on it. projectCount/pagination totals are left as-is, same
  // bare-number tradeoff already accepted elsewhere in this file.
  const browsableProjectIds = await getBrowsableProjectIds(
    context?.accountId,
    rawProjectUsage.map((p) => p.projectId)
  );
  const projectUsage = rawProjectUsage.filter((p) => browsableProjectIds.has(String(p.projectId)));

  return {
    status: "ok",
    snapshotRefreshedAt: meta.refreshedAt,
    field: formatFieldCandidate(matchedField),
    governance: {
      activeProjectCount: projectCount,
      totalIssueCount,
      fieldJql: matchedField.fieldJql,
      findings: matchedField.findings || null,
      projectUsagePage: usagePage,
      projectUsageTotalPages: Math.max(1, Math.ceil(projectCount / PROJECT_USAGE_PAGE_SIZE)),
      projectUsageTotalProjects: projectCount,
    },
    projectUsage: projectUsage.map((p) => ({
      projectKey: p.projectKey,
      projectName: p.projectName,
      issueCount: p.issueCount,
      jql: p.jql,
    })),
  };
}

// ── Rovo: workflow & status expert ──────────────────────────────────────────
//
// Three actions over the workflow snapshot, all reusing the loaders getWorkflowInsights
// already uses so the agent and the tab never disagree. Every path returns refreshedAt and
// an explicit "workflows-unavailable" when no snapshot exists.

async function loadWorkflowForAgent(installationKey) {
  const meta = await readWorkflowSnapshotMeta(installationKey);
  if (!meta?.version) {
    return { available: false, snapshotStatus: { state: meta?.state || "idle", refreshedAt: null } };
  }
  const [schemes, statuses, schemeStatuses] = await Promise.all([
    loadWorkflowSchemes(installationKey, meta.version),
    loadStatusesCatalog(installationKey, meta.version),
    loadWorkflowSchemeStatuses(installationKey, meta.version),
  ]);
  const issueCounts = await loadStatusIssueCounts(installationKey).catch(() => new Map());
  const history = await loadStatusHistoryCounts(installationKey).catch(() => ({ counts: new Map(), measuredAt: null }));
  return {
    available: true,
    refreshedAt: meta.refreshedAt || null,
    meta,
    schemes,
    statuses,
    schemeStatuses,
    issueCounts,
    hasIssueCounts: issueCounts.size > 0,
    historyCounts: history.counts,
    hasHistoryCounts: history.counts.size > 0,
  };
}

function statusRow(status, wf) {
  const id = String(status.statusId ?? status.id);
  return {
    statusId: id,
    name: status.name,
    category: status.statusCategory || status.category || null,
    issueCount: wf.hasIssueCounts ? Number(wf.issueCounts.get(id) ?? 0) : null,
    everCount: wf.hasHistoryCounts ? (wf.historyCounts.get(id) ?? null) : null,
  };
}

export async function rovoWorkflowSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const query = String(payload?.query || "").trim();
    const kind = String(payload?.kind || "any").trim().toLowerCase();
    const limit = clampResults(payload?.maxResults, 8, 20);
    if (!query) return { status: "error", message: "A search query is required." };

    const wf = await loadWorkflowForAgent(installationKey);
    if (!wf.available) return pillarUnavailable("workflows", wf.snapshotStatus);

    const schemeMatches = kind === "status" ? [] :
      rankMatches(wf.schemes, query, (s) => [s.name, s.schemeId, s.description], limit);
    const statusMatches = kind === "scheme" ? [] :
      rankMatches(wf.statuses, query, (s) => [s.name, s.statusId ?? s.id], limit);

    return agentOk(wf.refreshedAt, {
      query,
      schemes: schemeMatches.map((s) => ({
        schemeId: s.schemeId, name: s.name, description: s.description || null,
        defaultWorkflow: s.defaultWorkflow || null, projectCount: s.projectCount ?? null,
      })),
      statuses: statusMatches.map((s) => statusRow(s, wf)),
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoWorkflowSearch failed:", error);
    throw error;
  }
}

export async function rovoWorkflowInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const identifier = String(payload?.identifier || "").trim();
    if (!identifier) return { status: "error", message: "A scheme or status name is required." };

    const wf = await loadWorkflowForAgent(installationKey);
    if (!wf.available) return pillarUnavailable("workflows", wf.snapshotStatus);
    const idLower = identifier.toLowerCase();

    const scheme = wf.schemes.find(
      (s) => String(s.schemeId) === identifier || String(s.name || "").toLowerCase() === idLower
    );
    if (scheme) {
      const balance = computeSchemeCategoryBalance([scheme], wf.schemeStatuses, wf.statuses)[0] || null;
      const statusIds = new Set(
        wf.schemeStatuses.filter((p) => String(p.schemeId) === String(scheme.schemeId)).map((p) => String(p.statusId))
      );
      const projects = await loadWorkflowSchemeProjects(installationKey, wf.meta.version, scheme.schemeId).catch(() => []);
      return agentOk(wf.refreshedAt, {
        kind: "scheme",
        scheme: {
          schemeId: scheme.schemeId, name: scheme.name, description: scheme.description || null,
          defaultWorkflow: scheme.defaultWorkflow || null,
        },
        statuses: wf.statuses.filter((s) => statusIds.has(String(s.statusId ?? s.id))).map((s) => statusRow(s, wf)),
        categoryBalance: balance,
        projects: projects.slice(0, 50).map((p) => ({ projectKey: p.projectKey, projectName: p.projectName })),
        projectCount: projects.length,
      });
    }

    const status = wf.statuses.find(
      (s) => String(s.statusId ?? s.id) === identifier || String(s.name || "").toLowerCase() === idLower
    );
    if (!status) return agentNotFound(wf.refreshedAt, `No workflow scheme or status matched "${identifier}".`);

    const sid = String(status.statusId ?? status.id);
    const reachingSchemeIds = new Set(
      wf.schemeStatuses.filter((p) => String(p.statusId) === sid).map((p) => String(p.schemeId))
    );
    const dupGroup = findDuplicateStatusGroups(wf.statuses).find((g) =>
      g.statuses.some((s) => String(s.statusId ?? s.id) === sid)
    );
    const automation = await loadStatusAutomationReferences(installationKey, [status.name]).catch(() => null);

    return agentOk(wf.refreshedAt, {
      kind: "status",
      subject: statusRow(status, wf),
      reachedBySchemes: wf.schemes
        .filter((s) => reachingSchemeIds.has(String(s.schemeId)))
        .map((s) => ({ schemeId: s.schemeId, name: s.name })),
      reachedBySchemeCount: reachingSchemeIds.size,
      duplicateSiblings: dupGroup
        ? dupGroup.statuses.filter((s) => String(s.statusId ?? s.id) !== sid).map((s) => ({ statusId: String(s.statusId ?? s.id), name: s.name, kind: dupGroup.kind }))
        : [],
      automationChecked: Boolean(automation),
      automationRules: automation?.[status.name.toLowerCase()] || automation?.[status.name] || null,
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoWorkflowInspect failed:", error);
    throw error;
  }
}

// Everything known about one status, for the status drawer and the workflow agent's impact
// answer alike -- one function, so the tab and Rovo cannot give two different verdicts.
//
// `lookup` is { statusId } or { name }. Returns { available: false, ... } when no workflow
// snapshot exists and { found: false } when the status is not in the catalogue.
async function computeStatusDetail(installationKey, context, lookup) {
  const wf = await loadWorkflowForAgent(installationKey);
  if (!wf.available) return { available: false, snapshotStatus: wf.snapshotStatus };

  const byId = lookup?.statusId != null && lookup.statusId !== "" ? String(lookup.statusId) : null;
  const byName = String(lookup?.name || "").trim().toLowerCase();
  const status = wf.statuses.find((s) => (byId
    ? String(s.statusId ?? s.id) === byId
    : String(s.name || "").toLowerCase() === byName));
  if (!status) return { available: true, found: false, refreshedAt: wf.refreshedAt };

  const sid = String(status.statusId ?? status.id);
  const reachingSchemeIds = new Set(
    wf.schemeStatuses.filter((p) => String(p.statusId) === sid).map((p) => String(p.schemeId))
  );
  const reachingSchemes = wf.schemes.filter((s) => reachingSchemeIds.has(String(s.schemeId)));
  let projectCount = 0;
  const projectSample = [];
  for (const scheme of reachingSchemes.slice(0, 25)) {
    const projects = await loadWorkflowSchemeProjects(installationKey, wf.meta.version, scheme.schemeId).catch(() => []);
    projectCount += projects.length;
    for (const p of projects.slice(0, 10)) projectSample.push(p.projectKey);
  }
  const automation = await loadStatusAutomationReferences(installationKey, [status.name]).catch(() => null);
  const rules = automation?.[status.name.toLowerCase()] || automation?.[status.name] || null;

  // Board columns and saved filters: joins over data other pillars already hold.
  const boardStatusIds = await computeBoardStatusIds(installationKey).catch(() => null);
  const onBoard = boardStatusIds ? boardStatusIds.has(sid) : null;
  const filterUsage = await getFilterUsage({ payload: { kind: "status", label: status.name }, context }).catch(() => null);
  const referencingFilters = filterUsage?.available ? filterUsage.filters : null;
  const issueCount = wf.hasIssueCounts ? Number(wf.issueCounts.get(sid) ?? 0) : null;

  // The workflows that contain it, from the transitions read with the rules, and what those
  // workflows enforce while an issue sits in it. Only when the snapshot read the rules:
  // without them "in no workflow" would be a claim nobody checked.
  const rulesRead = wf.meta.workflowRules != null;
  const [transitions, ruleUsage, restrictions] = rulesRead
    ? await Promise.all([
        loadTransitionsTouchingStatus(installationKey, wf.meta.version, sid).catch(() => null),
        getWorkflowRuleUsage({ payload: { refType: "status", refId: sid }, context }).catch(() => null),
        getWorkflowRestrictions({ payload: { statusId: sid }, context }).catch(() => null),
      ])
    : [null, null, null];
  const workflowNames = transitions ? [...new Set(transitions.map((t) => t.workflowName))] : null;

  const assessment = assessStatusDeletion({
    status,
    schemes: { reachedByCount: reachingSchemeIds.size },
    issueUsage: issueCount === null ? null : { count: issueCount },
    automation: automation ? { available: true, writeCount: rules?.ruleCount ?? 0 } : null,
    boards: boardStatusIds ? { available: true, onBoard } : null,
    filters: referencingFilters
      ? { available: true, count: referencingFilters.length, names: referencingFilters.map((f) => f.name) }
      : null,
    workflows: workflowNames
      ? { available: true, count: workflowNames.length, names: workflowNames, ruleRefCount: ruleUsage?.available ? ruleUsage.total : 0 }
      : null,
  });

  return {
    available: true,
    found: true,
    refreshedAt: wf.refreshedAt,
    status,
    statusRow: statusRow(status, wf),
    reachingSchemes,
    reachingSchemeCount: reachingSchemeIds.size,
    projectCount,
    projectSample: [...new Set(projectSample)].slice(0, 20),
    automationChecked: Boolean(automation),
    automationRules: rules,
    boardChecked: boardStatusIds !== null,
    onBoard,
    referencingFilters,
    issueCount,
    everCount: wf.hasHistoryCounts ? (wf.historyCounts.get(sid) ?? null) : null,
    rulesRead,
    workflowNames,
    transitions,
    ruleUsage,
    restrictions,
    assessment,
  };
}

export async function rovoWorkflowImpact(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const name = String(payload?.name || "").trim();
    if (!name) return { status: "error", message: "A status name is required." };

    const d = await computeStatusDetail(installationKey, context, { name });
    if (!d.available) return pillarUnavailable("workflows", d.snapshotStatus);
    if (!d.found) return agentNotFound(d.refreshedAt, `No status named "${name}" is in the catalogue.`);

    return agentOk(d.refreshedAt, {
      subject: d.statusRow,
      reachedBySchemes: d.reachingSchemes.map((s) => ({ schemeId: s.schemeId, name: s.name })),
      reachedBySchemeCount: d.reachingSchemeCount,
      governedProjectCount: d.projectCount,
      projectSample: d.projectSample,
      automationChecked: d.automationChecked,
      automationRules: d.automationRules,
      boardChecked: d.boardChecked,
      onAnyBoard: d.onBoard,
      filtersChecked: Boolean(d.referencingFilters),
      referencingFilters: d.referencingFilters
        ? d.referencingFilters.slice(0, 10).map((f) => ({ id: f.id, name: f.name }))
        : null,
      referencingFilterCount: d.referencingFilters ? d.referencingFilters.length : null,
      issueCount: d.issueCount,
      everCount: d.everCount,
      workflowsChecked: d.workflowNames !== null,
      inWorkflows: d.workflowNames,
      restrictions: d.restrictions?.available
        ? d.restrictions.restrictions.map((r) => ({ workflow: r.workflowName, restriction: r.description, holder: r.holder?.label || r.holder?.id || null }))
        : null,
      verdict: d.assessment.verdict,
      blockers: d.assessment.blockers,
      gaps: d.assessment.gaps,
      verdictCaveat:
        "This covers workflow schemes, the workflows that contain the status, issue counts, " +
        "board columns, saved filter JQL and (where an analysis exists) automation. It does " +
        "not cover dashboards built directly on a status without a saved filter, or apps.",
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoWorkflowImpact failed:", error);
    throw error;
  }
}

// The status drawer: everything about one status, with its deletion verdict.
async function getStatusDetail({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const statusId = requireNonEmptyString(String(payload?.statusId ?? ""), "statusId");

  const d = await computeStatusDetail(installationKey, context, { statusId });
  if (!d.available) return { available: false, reason: "no-snapshot" };
  if (!d.found) return { available: true, found: false, refreshedAt: d.refreshedAt };

  const names = new Map();
  // Names for the transition endpoints come from the restriction/rule readers' status map;
  // here the catalogue the detail already loaded is enough.
  const wfStatuses = await loadWorkflowForAgent(installationKey).then((wf) => wf.statuses || []).catch(() => []);
  for (const s of wfStatuses) names.set(String(s.statusId ?? s.id), s.name);
  const sid = d.statusRow.statusId;
  const label = (id) => (id == null ? null : names.get(String(id)) || `Status ${id}`);

  return {
    available: true,
    found: true,
    refreshedAt: d.refreshedAt,
    status: d.statusRow,
    schemes: d.reachingSchemes.map((s) => ({ schemeId: s.schemeId, name: s.name, projectCount: s.projectCount ?? null })),
    schemeCount: d.reachingSchemeCount,
    projectCount: d.projectCount,
    projectSample: d.projectSample,
    rulesRead: d.rulesRead,
    workflows: d.workflowNames,
    // Into and out of the status, with how many rules each carries -- "who can put an issue
    // here, and what has to be true first".
    transitions: d.transitions
      ? d.transitions.slice(0, 200).map((t) => ({
          workflowName: t.workflowName,
          name: t.transitionName,
          direction: t.toStatusId === sid ? "into" : "out",
          from: t.transitionType === "INITIAL" ? ["Create"] : !t.fromStatusIds.length ? ["Any status"] : t.fromStatusIds.map(label),
          to: label(t.toStatusId),
          ruleCount: t.ruleCount,
        }))
      : null,
    restrictions: d.restrictions,
    ruleUsage: d.ruleUsage,
    automationChecked: d.automationChecked,
    boardChecked: d.boardChecked,
    onBoard: d.onBoard,
    filters: d.referencingFilters ? d.referencingFilters.slice(0, 20).map((f) => ({ id: f.id, name: f.name })) : null,
    verdict: d.assessment.verdict,
    headline: d.assessment.headline,
    blockers: d.assessment.blockers,
    gaps: d.assessment.gaps,
    caveat: d.assessment.caveat,
  };
}

// ── Rovo: issue type expert ─────────────────────────────────────────────────
//
// Thin wrappers over getIssueTypeInventory so the agent and the tab read the same rows.

export async function rovoIssueTypeSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const query = String(payload?.query || "").trim();
    const kind = String(payload?.kind || "any").trim().toLowerCase();
    const limit = clampResults(payload?.maxResults, 8, 20);
    if (!query) return { status: "error", message: "A search query is required." };

    const inv = await getIssueTypeInventory({ context });
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("issue types", { state: inv.state, refreshedAt: null });

    const types = kind === "scheme" ? [] :
      rankMatches(inv.issueTypes, query, (t) => [t.name, t.id, t.description], limit);
    const schemes = kind === "type" ? [] :
      rankMatches(inv.schemes, query, (s) => [s.name, s.schemeId, s.description], limit);

    return agentOk(inv.refreshedAt || null, {
      query,
      issueTypes: types.map((t) => ({
        id: t.id, name: t.name, hierarchyLevel: t.hierarchyLevel ?? null,
        subtask: Boolean(t.subtask), description: t.description || null,
      })),
      schemes: schemes.map((s) => ({
        schemeId: s.schemeId, name: s.name, isDefault: Boolean(s.isDefault),
        projectCount: (s.projects || []).length, typeCount: (s.issueTypes || []).length,
      })),
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoIssueTypeSearch failed:", error);
    throw error;
  }
}

export async function rovoIssueTypeInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const identifier = String(payload?.identifier || "").trim();
    if (!identifier) return { status: "error", message: "An issue type or scheme name is required." };
    const inv = await getIssueTypeInventory({ context });
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("issue types", { state: inv.state, refreshedAt: null });
    const idLower = identifier.toLowerCase();

    const scheme = (inv.schemes || []).find(
      (s) => String(s.schemeId) === identifier || String(s.name || "").toLowerCase() === idLower
    );
    if (scheme) {
      return agentOk(inv.refreshedAt || null, {
        kind: "scheme",
        scheme: {
          schemeId: scheme.schemeId, name: scheme.name, isDefault: Boolean(scheme.isDefault),
          defaultIssueType: scheme.defaultIssueTypeName || null,
        },
        issueTypes: (scheme.issueTypes || []).map((t) => ({ id: t.id, name: t.name, missing: Boolean(t.missing), hierarchyLevel: t.hierarchyLevel ?? null })),
        projects: (scheme.projects || []).slice(0, 50).map((p) => ({ projectKey: p.projectKey, projectName: p.projectName })),
        projectCount: (scheme.projects || []).length,
      });
    }

    const type = (inv.issueTypes || []).find(
      (t) => String(t.id) === identifier || String(t.name || "").toLowerCase() === idLower
    );
    if (!type) return agentNotFound(inv.refreshedAt || null, `No issue type or scheme matched "${identifier}".`);

    const reachingSchemes = (inv.schemes || []).filter((s) => (s.issueTypes || []).some((m) => String(m.id) === String(type.id)));
    return agentOk(inv.refreshedAt || null, {
      kind: "type",
      issueType: { id: type.id, name: type.name, hierarchyLevel: type.hierarchyLevel ?? null, subtask: Boolean(type.subtask), description: type.description || null },
      reachedBySchemes: reachingSchemes.map((s) => ({ schemeId: s.schemeId, name: s.name })),
      reachedBySchemeCount: reachingSchemes.length,
      governedProjectCount: reachingSchemes.reduce((n, s) => n + (s.projects || []).length, 0),
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoIssueTypeInspect failed:", error);
    throw error;
  }
}

export async function rovoIssueTypeImpact(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const name = String(payload?.name || "").trim();
    if (!name) return { status: "error", message: "An issue type name is required." };
    const inv = await getIssueTypeInventory({ context });
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("issue types", { state: inv.state, refreshedAt: null });

    const type = (inv.issueTypes || []).find((t) => String(t.name || "").toLowerCase() === name.toLowerCase());
    if (!type) return agentNotFound(inv.refreshedAt || null, `No issue type named "${name}" is in the catalogue.`);

    const reachingSchemes = (inv.schemes || []).filter((s) => (s.issueTypes || []).some((m) => String(m.id) === String(type.id)));
    const projectSample = [];
    for (const s of reachingSchemes) for (const p of (s.projects || []).slice(0, 10)) projectSample.push(p.projectKey);

    return agentOk(inv.refreshedAt || null, {
      issueType: { id: type.id, name: type.name, hierarchyLevel: type.hierarchyLevel ?? null },
      reachedBySchemes: reachingSchemes.map((s) => ({ schemeId: s.schemeId, name: s.name })),
      reachedBySchemeCount: reachingSchemes.length,
      governedProjectCount: reachingSchemes.reduce((n, s) => n + (s.projects || []).length, 0),
      projectSample: [...new Set(projectSample)].slice(0, 20),
      verdict: reachingSchemes.length === 0 ? "no-scheme-reaches-it" : "in-use",
      verdictCaveat:
        "This covers issue type schemes and their project assignments. It does not measure how many issues of the type exist unless the universe scan has run, and does not cover automation, boards or apps.",
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoIssueTypeImpact failed:", error);
    throw error;
  }
}

// ── Rovo: access expert ─────────────────────────────────────────────────────
//
// Permission / issue-security / notification schemes and project roles, over
// getAccessInventory. `family` selects which scheme set.

const ACCESS_FAMILIES = ["permissions", "security", "notifications", "roles"];

function accessSchemeList(inv, family) {
  if (family && ACCESS_FAMILIES.includes(family)) return { [family]: inv[family]?.schemes || [] };
  return Object.fromEntries(ACCESS_FAMILIES.map((f) => [f, inv[f]?.schemes || []]));
}

export async function rovoAccessSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const query = String(payload?.query || "").trim();
    const family = String(payload?.family || "").trim().toLowerCase();
    const limit = clampResults(payload?.maxResults, 8, 20);
    if (!query) return { status: "error", message: "A search query is required." };

    const inv = await getAccessInventory({ context });
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("access", { state: inv.state, refreshedAt: null });

    const sets = accessSchemeList(inv, family);
    const matches = {};
    for (const [f, schemes] of Object.entries(sets)) {
      matches[f] = rankMatches(schemes, query, (s) => [s.name, s.id, s.description], limit)
        .map((s) => ({ id: s.id, name: s.name, description: s.description || null, projectCount: s.projectCount ?? null }));
    }
    return agentOk(inv.refreshedAt || null, { query, schemes: matches });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoAccessSearch failed:", error);
    throw error;
  }
}

// The active roster's accountIds, or null when no people snapshot exists (so an off-roster
// flag is unknown, not false).
async function loadActiveRoster(installationKey) {
  const userMeta = await readUserSnapshotMeta(installationKey).catch(() => null);
  if (!userMeta?.version) return null;
  const users = await loadUsers(installationKey, userMeta.version).catch(() => []);
  return activeRosterIds(users);
}

// One stored holder row, as the access agent reports it. The row carries the grant in
// context/contextLabel (permission key, notification event, security level or project) and
// the holder in holderValue/holderLabel. The agent used to read holderName, permission and
// offRoster, none of which exist on the row, so every grant came back null, nobody was ever
// off-roster, and a search by group name compared against the group id.
function describeAccessHolder(h, rosterIds) {
  return {
    type: h.holderType,
    value: h.holderLabel || h.holderValue || null,
    id: h.holderValue || null,
    grants: h.contextLabel || h.context || null,
    offRoster: h.holderType === "user" && h.holderValue
      ? (rosterIds ? !rosterIds.has(h.holderValue) : null)
      : false,
  };
}

export async function rovoAccessInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const identifier = String(payload?.identifier || "").trim();
    if (!identifier) return { status: "error", message: "A scheme name is required." };
    const inv = await getAccessInventory({ context });
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("access", { state: inv.state, refreshedAt: null });
    const idLower = identifier.toLowerCase();

    for (const family of ACCESS_FAMILIES) {
      const schemes = inv[family]?.schemes || [];
      const scheme = schemes.find((s) => String(s.id) === identifier || String(s.name || "").toLowerCase() === idLower);
      if (!scheme) continue;
      const holders = (inv[family]?.holders || []).filter((h) => String(h.schemeId) === String(scheme.id));
      const rosterIds = await loadActiveRoster(getInstallationKey(context));
      return agentOk(inv.refreshedAt || null, {
        family,
        scheme: { id: scheme.id, name: scheme.name, description: scheme.description || null, projectCount: scheme.projectCount ?? null },
        holders: holders.slice(0, 100).map((h) => {
          const d = describeAccessHolder(h, rosterIds);
          return { type: d.type, value: d.value, id: d.id, permission: d.grants, offRoster: d.offRoster };
        }),
        holderCount: holders.length,
        findings: inv[family]?.governance?.findings || inv[family]?.governance || null,
      });
    }
    return agentNotFound(inv.refreshedAt || null, `No permission, issue-security, notification scheme or project role matched "${identifier}".`);
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoAccessInspect failed:", error);
    throw error;
  }
}

export async function rovoAccessImpact(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const name = String(payload?.name || "").trim();
    if (!name) return { status: "error", message: "An account id, group name or display name is required." };
    const inv = await getAccessInventory({ context });
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("access", { state: inv.state, refreshedAt: null });
    const needle = name.toLowerCase();
    const rosterIds = await loadActiveRoster(getInstallationKey(context));

    const naming = [];
    for (const family of ACCESS_FAMILIES) {
      const schemes = new Map((inv[family]?.schemes || []).map((s) => [String(s.id), s.name]));
      for (const h of inv[family]?.holders || []) {
        // Matched on the label (group or display name) and the stored id (group id or
        // accountId), so a group name, a group id or an accountId all find the holder.
        const label = String(h.holderLabel || "").toLowerCase();
        const id = String(h.holderValue || "").toLowerCase();
        if (id === needle || label === needle || (label && label.includes(needle))) {
          const d = describeAccessHolder(h, rosterIds);
          naming.push({
            family,
            scheme: schemes.get(String(h.schemeId)) || String(h.schemeId),
            as: d.type,
            holder: d.value,
            grants: d.grants,
            offRoster: d.offRoster,
          });
        }
      }
    }

    return agentOk(inv.refreshedAt || null, {
      subject: name,
      namedIn: naming.slice(0, 200),
      namedInCount: naming.length,
      verdict: naming.length === 0 ? "not-named-in-any-scheme" : "named-in-schemes",
      verdictCaveat:
        "This covers permission, issue-security and notification schemes and project roles. It does not cover global permissions (Jira exposes no grant list for those), board or filter shares, or app-level access.",
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoAccessImpact failed:", error);
    throw error;
  }
}

// ── Rovo: people expert ─────────────────────────────────────────────────────
//
// The roster and the ownership / reference graph, over getUserInventory and getUserDetails.

export async function rovoPeopleSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const query = String(payload?.query || "").trim();
    const limit = clampResults(payload?.maxResults, 8, 20);
    if (!query) return { status: "error", message: "A search query is required." };

    const inv = await getUserInventory({ context });
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("people", { state: inv.state, refreshedAt: null });

    const users = rankMatches(inv.users, query, (u) => [u.displayName, u.accountId], limit);
    const groups = new Map();
    for (const u of inv.users) for (const g of u.groups || []) {
      if (!groups.has(g.id)) groups.set(g.id, { id: g.id, name: g.name, memberCount: 0 });
      groups.get(g.id).memberCount += 1;
    }
    const groupMatches = rankMatches([...groups.values()], query, (g) => [g.name, g.id], limit);

    return agentOk(inv.refreshedAt || null, {
      query,
      users: users.map((u) => ({
        accountId: u.accountId, displayName: u.displayName, active: u.active !== false,
        ownedFilters: u.ownedFilters ?? 0, ownedDashboards: u.ownedDashboards ?? 0,
        authoredRules: u.authoredRules ?? 0, automationRefs: u.automationRefs ?? 0,
      })),
      groups: groupMatches,
      rosterSize: inv.users.length,
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoPeopleSearch failed:", error);
    throw error;
  }
}

export async function rovoPeopleInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const accountId = String(payload?.accountId || "").trim();
    if (!accountId) return { status: "error", message: "An accountId is required. Use search first to resolve a name." };
    const details = await getUserDetails({ payload: { accountId }, context });
    if (!details.available) return pillarUnavailable("people", { state: "idle", refreshedAt: null });

    return agentOk(null, {
      accountId,
      inRoster: Boolean(details.inRoster),
      user: {
        displayName: details.user?.displayName || accountId,
        active: details.user?.active ?? null,
        products: details.user?.applications || details.user?.products || [],
        groups: (details.user?.groups || []).map((g) => g.name || g.id),
      },
      ownedFilters: (details.ownedFilters || []).length,
      ownedDashboards: (details.ownedDashboards || []).length,
      authoredRules: (details.authoredRules || []).length,
      referencedInRules: (details.referencedInRules || []).map((r) => ({ id: r.id, name: r.name, direction: r.direction })),
      grantedBySchemes: (details.grantedBySchemes || []).map((s) => ({ scheme: s.schemeName || s.name, family: s.schemeType || s.family, grants: s.permission || s.level || s.eventName || null })),
      fieldAppearances: (details.fieldAppearances || []).map((f) => ({ field: f.fieldName, issueCount: f.issueCount })),
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoPeopleInspect failed:", error);
    throw error;
  }
}

export async function rovoPeopleImpact(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const accountId = String(payload?.accountId || "").trim();
    if (!accountId) return { status: "error", message: "An accountId is required." };
    const details = await getUserDetails({ payload: { accountId }, context });
    if (!details.available) return pillarUnavailable("people", { state: "idle", refreshedAt: null });

    const ownedFilters = (details.ownedFilters || []).length;
    const ownedDashboards = (details.ownedDashboards || []).length;
    const authoredRules = (details.authoredRules || []).length;
    const writeRefs = (details.referencedInRules || []).filter((r) => r.direction === "write");
    const directGrants = (details.grantedBySchemes || []).length;
    // Grants via a group are deduplicated by scheme+context: two groups both granting the
    // same permission on the same scheme is one fact about the account, not two, and
    // counting it twice would make a well-organized site (grants via role-shaped groups)
    // look more exposed than a badly-organized one (the same grant added directly twice).
    const groupGrantKeys = new Set(
      (details.grantedByGroups || []).map((g) => `${g.schemeType}:${g.schemeId}:${g.context}`)
    );
    const groupGrants = groupGrantKeys.size;
    const anything = ownedFilters + ownedDashboards + authoredRules + (details.referencedInRules || []).length + directGrants + groupGrants;

    return agentOk(null, {
      accountId,
      displayName: details.user?.displayName || accountId,
      active: details.user?.active ?? null,
      ownedFilters, ownedDashboards, authoredRules,
      rulesRoutingWorkHere: writeRefs.map((r) => ({ id: r.id, name: r.name })),
      referencedInRuleCount: (details.referencedInRules || []).length,
      directSchemeGrants: directGrants,
      // Most real access runs through a group, not a direct grant -- this was invisible here
      // until now even for an account holding admin purely via group membership.
      groupSchemeGrants: groupGrants,
      grantedViaGroups: [...new Set((details.grantedByGroups || []).map((g) => g.viaGroup))].slice(0, 20),
      verdict: anything === 0 ? "no-cross-pillar-footprint" : "has-footprint",
      verdictCaveat:
        "Deactivating an account leaves its filters, dashboards and rules ownerless (boards and any dashboard on a wall break), any rule that routes work to it stops assigning, " +
        "and any access held through a group membership is what actually changes -- direct grants on the account are rare by design. " +
        "This does not cover board leads, project leads, or app-specific ownership.",
      dataCaveats: {
        automation: details.automationRefsAvailable ? "checked" : "no automation analysis imported",
        access: details.accessGrantsAvailable ? "checked" : "no access snapshot built",
        fields: details.fieldAppearancesAvailable ? "checked" : "no field crawl since this landed",
      },
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoPeopleImpact failed:", error);
    throw error;
  }
}

// ── Rovo: assets (CMDB) expert ──────────────────────────────────────────────
//
// Object schemas, hierarchical object types and their attributes, over getAssetInventory.

export async function rovoAssetSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const query = String(payload?.query || "").trim();
    const kind = String(payload?.kind || "any").trim().toLowerCase();
    const limit = clampResults(payload?.maxResults, 8, 20);
    if (!query) return { status: "error", message: "A search query is required." };

    const inv = await getAssetInventory({ context });
    if (inv.state === "unavailable" || inv.assetsEnabled === false) {
      return { status: "assets-not-enabled", message: "JSM Assets is not enabled on this site (it needs JSM Premium or Enterprise), so there is no object structure to search." };
    }
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("assets", { state: inv.state, refreshedAt: null });

    const schemas = kind === "type" ? [] : rankMatches(inv.schemas, query, (s) => [s.name, s.objectSchemaKey, s.key], limit);
    const types = kind === "schema" ? [] : rankMatches(inv.objectTypes, query, (t) => [t.name], limit);

    return agentOk(inv.refreshedAt || null, {
      query,
      schemas: schemas.map((s) => ({ id: s.id, name: s.name, key: s.objectSchemaKey || s.key || null, objectTypeCount: s.objectTypeCount ?? null })),
      objectTypes: types.map((t) => ({ id: t.id, name: t.name, schemaId: t.objectSchemaId ?? t.schemaId ?? null, parentId: t.parentObjectTypeId ?? t.parentId ?? null })),
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoAssetSearch failed:", error);
    throw error;
  }
}

export async function rovoAssetInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const identifier = String(payload?.identifier || "").trim();
    if (!identifier) return { status: "error", message: "An object schema or object type name is required." };
    const inv = await getAssetInventory({ context });
    if (inv.state === "unavailable" || inv.assetsEnabled === false) {
      return { status: "assets-not-enabled", message: "JSM Assets is not enabled on this site." };
    }
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("assets", { state: inv.state, refreshedAt: null });
    const idLower = identifier.toLowerCase();

    const schema = (inv.schemas || []).find((s) => String(s.id) === identifier || String(s.name || "").toLowerCase() === idLower);
    if (schema) {
      const types = (inv.objectTypes || []).filter((t) => String(t.objectSchemaId ?? t.schemaId) === String(schema.id));
      return agentOk(inv.refreshedAt || null, {
        kind: "schema",
        schema: { id: schema.id, name: schema.name, key: schema.objectSchemaKey || schema.key || null },
        objectTypes: types.slice(0, 100).map((t) => ({ id: t.id, name: t.name, parentId: t.parentObjectTypeId ?? t.parentId ?? null })),
        objectTypeCount: types.length,
      });
    }

    const type = (inv.objectTypes || []).find((t) => String(t.id) === identifier || String(t.name || "").toLowerCase() === idLower);
    if (!type) return agentNotFound(inv.refreshedAt || null, `No object schema or object type matched "${identifier}".`);

    const attrs = (inv.attributes || []).filter((a) => String(a.objectTypeId ?? a.typeId) === String(type.id));
    const children = (inv.objectTypes || []).filter((t) => String(t.parentObjectTypeId ?? t.parentId) === String(type.id));
    const referencedBy = (inv.attributes || []).filter((a) => String(a.referenceObjectTypeId ?? a.referenceTypeId) === String(type.id));

    return agentOk(inv.refreshedAt || null, {
      kind: "type",
      objectType: { id: type.id, name: type.name, schemaId: type.objectSchemaId ?? type.schemaId ?? null, parentId: type.parentObjectTypeId ?? type.parentId ?? null },
      attributes: attrs.slice(0, 100).map((a) => ({ name: a.name, type: a.type || a.dataType || null, referenceType: a.referenceObjectTypeName || null })),
      attributeCount: attrs.length,
      childTypes: children.map((c) => ({ id: c.id, name: c.name })),
      referencedByAttributeCount: referencedBy.length,
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoAssetInspect failed:", error);
    throw error;
  }
}

export async function rovoAssetImpact(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const name = String(payload?.name || "").trim();
    if (!name) return { status: "error", message: "An object type name is required." };
    const inv = await getAssetInventory({ context });
    if (inv.state === "unavailable" || inv.assetsEnabled === false) {
      return { status: "assets-not-enabled", message: "JSM Assets is not enabled on this site." };
    }
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("assets", { state: inv.state, refreshedAt: null });

    const type = (inv.objectTypes || []).find((t) => String(t.name || "").toLowerCase() === name.toLowerCase());
    if (!type) return agentNotFound(inv.refreshedAt || null, `No object type named "${name}" was found.`);

    const children = (inv.objectTypes || []).filter((t) => String(t.parentObjectTypeId ?? t.parentId) === String(type.id));
    const referencingAttrs = (inv.attributes || []).filter((a) => String(a.referenceObjectTypeId ?? a.referenceTypeId) === String(type.id));

    return agentOk(inv.refreshedAt || null, {
      objectType: { id: type.id, name: type.name },
      childTypes: children.map((c) => ({ id: c.id, name: c.name })),
      childTypeCount: children.length,
      referencedByAttributes: referencingAttrs.slice(0, 100).map((a) => ({ attribute: a.name, onType: a.objectTypeName || a.objectTypeId })),
      referencedByAttributeCount: referencingAttrs.length,
      verdict: children.length === 0 && referencingAttrs.length === 0 ? "nothing-references-it" : "referenced",
      verdictCaveat:
        "This covers the object type hierarchy and reference attributes within Assets. It does not cover the objects themselves, Assets automation, or object-reference custom fields on Jira issues.",
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoAssetImpact failed:", error);
    throw error;
  }
}

// ── Rovo: priorities & resolutions expert ───────────────────────────────────
//
// The two global value lists, over getEstateInventory. Search + inspect only: priority
// schemes (which projects use which list) are not captured, so there is no "impact".

export async function rovoEstateSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const query = String(payload?.query || "").trim();
    const kind = String(payload?.kind || "any").trim().toLowerCase();
    const limit = clampResults(payload?.maxResults, 10, 20);
    if (!query) return { status: "error", message: "A search query is required." };

    const inv = await getEstateInventory({ context });
    if (inv.neverBuilt) return pillarUnavailable("priorities & resolutions", { state: inv.state, refreshedAt: null });

    const resolutions = kind === "priority" ? [] : rankMatches(inv.resolutions, query, (r) => [r.name, r.description], limit);
    const priorities = kind === "resolution" ? [] : rankMatches(inv.priorities, query, (p) => [p.name, p.description], limit);

    return agentOk(inv.refreshedAt || null, {
      query,
      resolutions: resolutions.map((r) => ({ id: r.id, name: r.name, isDefault: Boolean(r.isDefault), description: r.description || null })),
      priorities: priorities.map((p) => ({ id: p.id, name: p.name, isDefault: Boolean(p.isDefault), description: p.description || null })),
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoEstateSearch failed:", error);
    throw error;
  }
}

export async function rovoEstateInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const kind = String(payload?.list || "both").trim().toLowerCase();
    const inv = await getEstateInventory({ context });
    if (inv.neverBuilt) return pillarUnavailable("priorities & resolutions", { state: inv.state, refreshedAt: null });

    const shape = (rows) => ({
      count: rows.length,
      hasDefault: rows.some((r) => r.isDefault),
      values: rows.map((r) => ({ name: r.name, isDefault: Boolean(r.isDefault) })),
    });
    const out = { status: "ok", refreshedAt: inv.refreshedAt || null, findings: inv.governance?.findings || inv.governance || null };
    if (kind !== "priorities") out.resolutions = shape(inv.resolutions || []);
    if (kind !== "resolutions") out.priorities = shape(inv.priorities || []);
    return out;
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoEstateInspect failed:", error);
    throw error;
  }
}

// ── Rovo: screen expert ────────────────────────────────────────────────────
//
// Screens, their tabs and fields, and the scheme chain that routes to them, over
// getScreenInventory (which pages screens -- the agent asks for a large page).

export async function rovoScreenSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const query = String(payload?.query || "").trim();
    const kind = String(payload?.kind || "any").trim().toLowerCase();
    const limit = clampResults(payload?.maxResults, 8, 20);
    if (!query) return { status: "error", message: "A search query is required." };

    const inv = await getScreenInventory({ payload: { pageSize: 100, search: kind === "scheme" ? "" : query }, context });
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("screens", { state: inv.state, refreshedAt: null });

    const screenRows = kind === "scheme" ? [] : (inv.screens?.rows || inv.screens || []);
    const screens = rankMatches(screenRows, query, (s) => [s.name, s.id, s.screenId], limit);
    const schemes = kind === "screen" ? [] :
      rankMatches(inv.screenSchemes || [], query, (s) => [s.name, s.id], limit);

    return agentOk(inv.refreshedAt || null, {
      query,
      screens: screens.map((s) => ({
        screenId: s.screenId ?? s.id, name: s.name,
        fieldCount: s.fieldCount ?? s.totalFields ?? null,
        tabCount: s.tabCount ?? null,
        reachedByProjectCount: s.projectCount ?? s.reachableProjectCount ?? null,
      })),
      screenSchemes: schemes.map((s) => ({ id: s.id, name: s.name })),
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoScreenSearch failed:", error);
    throw error;
  }
}

export async function rovoScreenInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const identifier = String(payload?.identifier || "").trim();
    if (!identifier) return { status: "error", message: "A screen or screen scheme name is required." };
    const inv = await getScreenInventory({ payload: { pageSize: 100, search: identifier }, context });
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("screens", { state: inv.state, refreshedAt: null });
    const idLower = identifier.toLowerCase();

    const scheme = (inv.screenSchemes || []).find((s) => String(s.id) === identifier || String(s.name || "").toLowerCase() === idLower);
    if (scheme) {
      const ops = (inv.schemeOperations || []).filter((o) => String(o.schemeId) === String(scheme.id));
      return agentOk(inv.refreshedAt || null, {
        kind: "scheme",
        scheme: { id: scheme.id, name: scheme.name },
        operations: ops.map((o) => ({ operation: o.operation, screenId: o.screenId, screenName: o.screenName || null, inherited: Boolean(o.inherited) })),
      });
    }

    const rows = inv.screens?.rows || inv.screens || [];
    const screen = rows.find((s) => String(s.screenId ?? s.id) === identifier || String(s.name || "").toLowerCase() === idLower);
    if (!screen) return agentNotFound(inv.refreshedAt || null, `No screen or screen scheme matched "${identifier}" on the current page. Try a more exact name.`);

    return agentOk(inv.refreshedAt || null, {
      kind: "screen",
      screen: {
        screenId: screen.screenId ?? screen.id, name: screen.name,
        fieldCount: screen.fieldCount ?? screen.totalFields ?? null,
        tabCount: screen.tabCount ?? null,
        tabs: (screen.tabs || []).map((t) => ({ name: t.name, fieldCount: (t.fields || []).length })),
        findings: screen.findings || null,
        unresolved: Boolean(screen.unresolved),
      },
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoScreenInspect failed:", error);
    throw error;
  }
}

export async function rovoScreenImpact(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const name = String(payload?.name || "").trim();
    if (!name) return { status: "error", message: "A screen name is required." };
    const inv = await getScreenInventory({ payload: { pageSize: 100, search: name }, context });
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("screens", { state: inv.state, refreshedAt: null });

    const rows = inv.screens?.rows || inv.screens || [];
    const screen = rows.find((s) => String(s.name || "").toLowerCase() === name.toLowerCase());
    if (!screen) return agentNotFound(inv.refreshedAt || null, `No screen named "${name}" was found on the current page.`);

    const sid = String(screen.screenId ?? screen.id);
    const ops = (inv.schemeOperations || []).filter((o) => String(o.screenId) === sid);
    const schemeIds = new Set(ops.map((o) => String(o.schemeId)));
    const transitions = (inv.transitionScreens || []).filter((t) => String(t.screenId) === sid);

    return agentOk(inv.refreshedAt || null, {
      screen: { screenId: sid, name: screen.name, fieldCount: screen.fieldCount ?? screen.totalFields ?? null },
      routedBySchemeOperations: ops.map((o) => ({ scheme: o.schemeName || o.schemeId, operation: o.operation })),
      routedBySchemeCount: schemeIds.size,
      openedByTransitionCount: transitions.length,
      reachedByProjectCount: screen.projectCount ?? screen.reachableProjectCount ?? null,
      verdict: schemeIds.size === 0 && transitions.length === 0 ? "nothing-routes-to-it" : "routed",
      verdictCaveat:
        "This covers screen scheme operation mappings and workflow transition screens (where the workflow inventory recorded them). Reachability by project depends on the issue-type-screen-scheme chain, which may be partial.",
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoScreenImpact failed:", error);
    throw error;
  }
}

// ── Rovo: boards expert ────────────────────────────────────────────────────
//
// Agile boards, their backing filter and column mapping, over getBoardInventory (which runs
// the filter and status joins). Impact answers "which boards use this filter or status" --
// what would break if it changed.

export async function rovoBoardSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const query = String(payload?.query || "").trim();
    const type = String(payload?.type || "any").trim().toLowerCase();
    const limit = clampResults(payload?.maxResults, 10, 25);
    if (!query) return { status: "error", message: "A search query is required." };

    const inv = await getBoardInventory({ context });
    if (inv.neverBuilt) return pillarUnavailable("boards", { state: inv.state, refreshedAt: null });

    let rows = inv.boards || [];
    if (["scrum", "kanban", "simple"].includes(type)) rows = rows.filter((b) => b.type === type);
    const matches = rankMatches(rows, query, (b) => [b.name, b.locationKey, b.locationName], limit);

    return agentOk(inv.refreshedAt || null, {
      query,
      boards: matches.map((b) => ({
        boardId: b.boardId,
        name: b.name,
        type: b.type,
        location: b.locationType === "user" ? `personal (${b.locationName || "unknown"})` : (b.locationKey || "no project"),
        backingFilterId: b.filterId,
        columnCount: b.columnCount,
        configReadable: b.configReadable,
      })),
      total: rows.length,
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoBoardSearch failed:", error);
    throw error;
  }
}

export async function rovoBoardInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const boardId = String(payload?.boardId || "").trim();
    const name = String(payload?.name || "").trim();
    if (!boardId && !name) return { status: "error", message: "A boardId or name is required. Use search first." };

    const inv = await getBoardInventory({ context });
    if (inv.neverBuilt) return pillarUnavailable("boards", { state: inv.state, refreshedAt: null });

    const rows = inv.boards || [];
    const board = boardId
      ? rows.find((b) => String(b.boardId) === boardId)
      : rows.find((b) => String(b.name || "").toLowerCase() === name.toLowerCase());
    if (!board) return agentNotFound(inv.refreshedAt || null, `No board ${boardId ? `with id ${boardId}` : `named "${name}"`} in the current snapshot.`);

    const flagged = (inv.insights?.flagged || []).find((f) => String(f.boardId) === String(board.boardId));

    return agentOk(inv.refreshedAt || null, {
      board: {
        boardId: board.boardId,
        name: board.name,
        type: board.type,
        location: board.locationType === "user" ? `personal (${board.locationName || "unknown"})` : (board.locationKey || "no project"),
        backingFilterId: board.filterId,
        estimationField: board.estimationField || null,
        rankingField: board.rankingField || null,
        subQuery: board.subQuery || null,
        configReadable: board.configReadable,
      },
      columns: (board.columns || []).map((c) => ({ index: c.index, name: c.name, statusCount: (c.statusIds || []).length })),
      unmappedColumns: board.unmappedColumns,
      issues: flagged?.issues || [],
      joinsRun: { filters: inv.insights?.joinedFilters ?? false, statuses: inv.insights?.joinedStatuses ?? false },
      dataCaveat:
        "Board administrators are not exposed by the public REST API, so 'who can change this board' is not captured -- it is governed by the backing filter's edit permissions.",
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoBoardInspect failed:", error);
    throw error;
  }
}

export async function rovoBoardImpact(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const filterId = String(payload?.filterId || "").trim();
    const statusId = String(payload?.statusId || "").trim();
    if (!filterId && !statusId) {
      return { status: "error", message: "A filterId or statusId is required -- this answers which boards would break if that filter or status changed." };
    }

    const inv = await getBoardInventory({ context });
    if (inv.neverBuilt) return pillarUnavailable("boards", { state: inv.state, refreshedAt: null });

    const rows = inv.boards || [];
    const byFilter = filterId ? rows.filter((b) => String(b.filterId) === filterId) : [];
    const byStatus = statusId
      ? rows.filter((b) => (b.columns || []).some((c) => (c.statusIds || []).map(String).includes(statusId)))
      : [];

    return agentOk(inv.refreshedAt || null, {
      filterId: filterId || null,
      statusId: statusId || null,
      boardsBackedByFilter: byFilter.map((b) => ({ boardId: b.boardId, name: b.name, type: b.type })),
      boardsMappingStatus: byStatus.map((b) => ({
        boardId: b.boardId,
        name: b.name,
        columns: (b.columns || [])
          .filter((c) => (c.statusIds || []).map(String).includes(statusId))
          .map((c) => c.name),
      })),
      verdict: (byFilter.length + byStatus.length) === 0 ? "no-board-references-it" : "referenced",
      verdictCaveat:
        "Only boards whose configuration was readable are covered -- team-managed boards whose /configuration endpoint 404'd are not in this answer.",
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoBoardImpact failed:", error);
    throw error;
  }
}

// ── Rovo: configuration change expert ──────────────────────────────────────
//
// The change-history timeline, over loadConfigChanges. Search filters by pillar/kind and
// substring-matches the label; inspect returns one entity's whole recorded history.

export async function rovoChangeSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    await ensureProjectStoreReady();
    const installationKey = getInstallationKey(context);
    const query = String(payload?.query || "").trim().toLowerCase();
    const pillar = payload?.pillar && payload.pillar !== "all" ? String(payload.pillar) : null;
    const kind = payload?.kind && payload.kind !== "all" ? String(payload.kind) : null;
    const limit = clampResults(payload?.maxResults, 20, 100);

    const meta = await readDriftSnapshotMeta(installationKey);
    if (!meta?.version) return pillarUnavailable("configuration changes", { state: meta?.state || "idle", refreshedAt: null });

    const rows = await loadConfigChanges(installationKey, { pillar, kind, limit: 300 });
    const filtered = (query
      ? rows.filter((r) => String(r.label || "").toLowerCase().includes(query) || String(r.summary || "").toLowerCase().includes(query))
      : rows
    ).slice(0, limit);

    return agentOk(meta.refreshedAt || null, {
      query: query || null, pillar, kind,
      totalRecorded: meta.totalChanges || 0,
      changes: filtered.map((r) => ({
        detectedAt: r.detectedAt, pillar: r.pillar, entityType: r.entityType,
        label: r.label, kind: r.changeKind, summary: r.summary,
      })),
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoChangeSearch failed:", error);
    throw error;
  }
}

export async function rovoChangeInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    await ensureProjectStoreReady();
    const installationKey = getInstallationKey(context);
    const label = String(payload?.label || "").trim();
    if (!label) return { status: "error", message: "The name of a scheme, status, field, filter or other entity is required." };

    const meta = await readDriftSnapshotMeta(installationKey);
    if (!meta?.version) return pillarUnavailable("configuration changes", { state: meta?.state || "idle", refreshedAt: null });

    const rows = await loadConfigChanges(installationKey, { limit: 500 });
    const forEntity = rows.filter((r) => String(r.label || "").toLowerCase() === label.toLowerCase());
    if (!forEntity.length) {
      return agentNotFound(meta.refreshedAt || null,
        `No recorded configuration change names "${label}". Either it has not changed since the drift baseline was set, or it is not one of the tracked entity kinds.`);
    }

    return agentOk(meta.refreshedAt || null, {
      label,
      pillar: forEntity[0].pillar,
      entityType: forEntity[0].entityType,
      changeCount: forEntity.length,
      history: forEntity.map((r) => ({ detectedAt: r.detectedAt, kind: r.changeKind, summary: r.summary })),
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoChangeInspect failed:", error);
    throw error;
  }
}

// ── Rovo: project expert ───────────────────────────────────────────────────
//
// Per-project scheme identity, adoption and field usage, over getProjectOverview. Read
// only what the viewer can Browse, exactly as getProjectOverview does.

export async function rovoProjectSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const query = String(payload?.query || "").trim();
    const limit = clampResults(payload?.maxResults, 8, 20);
    if (!query) return { status: "error", message: "A search query is required." };

    const vp = await viewerProjects(installationKey, context);
    if (!vp.available) return pillarUnavailable("projects", { state: "idle", refreshedAt: null });

    const matches = rankMatches(vp.projects, query, (p) => [p.projectKey, p.projectName], limit);
    return agentOk(null, {
      query,
      projects: matches.map((p) => ({ projectId: p.projectId, projectKey: p.projectKey, projectName: p.projectName })),
      browsableProjectCount: vp.projects.length,
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoProjectSearch failed:", error);
    throw error;
  }
}

export async function rovoProjectInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    let projectId = String(payload?.projectId || "").trim();
    const projectKey = String(payload?.projectKey || "").trim();

    if (!projectId) {
      if (!projectKey) return { status: "error", message: "A projectId or projectKey is required. Use search first." };
      const vp = await viewerProjects(installationKey, context);
      const hit = vp.projects.find((p) => String(p.projectKey || "").toLowerCase() === projectKey.toLowerCase());
      if (!hit) return agentNotFound(null, `No browsable project has the key "${projectKey}".`);
      projectId = hit.projectId;
    }

    const ov = await getProjectOverview({ payload: { projectId, projectKey }, context });
    if (!ov.available) return { status: "not-authorised", message: ov.reason || "You do not have Browse Projects on this project." };

    // Read off the keys getProjectOverview actually returns. This used to read projectType,
    // lead, workflowScheme, roleActors and fieldsInUse, none of which the overview has, so the
    // agent answered every project with no workflow scheme, no roles and no lead.
    return agentOk(ov.refreshedAt || null, {
      project: { projectId, projectKey: ov.projectKey || projectKey, projectName: ov.projectName || null },
      workflowScheme: ov.workflow?.available
        ? (ov.workflow.scheme ? { id: ov.workflow.scheme.schemeId ?? null, name: ov.workflow.scheme.name } : null)
        : { available: false, reason: ov.workflow?.reason || null },
      schemes: ov.schemes || null,
      roles: ov.roles || null,
      boards: ov.boards || null,
      adoption: ov.adoption || null,
      dataCaveats:
        "Project type, lead and category are not collected yet, so they are unknown rather than empty. Project activity and archetype-divergence measurement are not built yet.",
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoProjectInspect failed:", error);
    throw error;
  }
}

// ── Rovo: automation expert ──────────────────────────────────────────────────
//
// The agent answers only from the stored analysis. It has no route to the live rules, so
// every path here reports the analysis's own staleness and returns an explicit
// "analysis-unavailable" rather than an empty result -- an agent that says "no rules use
// that field" when nothing has been analyzed is worse than one that says it does not know,
// because the user acts on the first and asks again after the second.

async function loadAutomationForAgent(installationKey) {
  const [analysis, fields, statuses, directory, findings, config] = await Promise.all([
    readAutomationAnalysis(installationKey),
    readAutomationPart(installationKey, "fields"),
    readAutomationPart(installationKey, "statuses"),
    readAutomationPart(installationKey, "directory"),
    readAutomationPart(installationKey, "findings"),
    // The staleness threshold travels with the data, so no caller can forget to apply it.
    readAdminConfig().catch(() => null),
  ]);
  const staleAfterDays = Number(config?.automationStaleAfterDays) || DEFAULT_ANALYSIS_STALE_AFTER_DAYS;
  return { analysis, fields, statuses, directory, findings, staleAfterDays };
}

function ruleDirectoryMap(directory) {
  return new Map(
    (directory?.rules ?? []).map(([id, name, enabled, triggerType, projectCount]) => [
      id,
      { id, name, enabled: enabled === 1, triggerType: triggerType || null, projectCount },
    ])
  );
}

const RISK_SENTENCES = {
  "embedded-credential": "stores a credential in plaintext that anyone who can view the rule can read",
  "no-actions": "has a trigger but no actions",
  "external-http": "sends data to a host outside Atlassian",
  disabled: "is disabled",
};

export async function rovoSearchAutomationRules(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  const query = String(payload?.query || "").trim();
  const maxResults = Math.max(1, Math.min(20, Number(payload?.maxResults) || 10));
  const stateFilter = String(payload?.state || "any").toLowerCase();

  const { analysis, directory, findings, staleAfterDays } = await loadAutomationForAgent(installationKey);
  if (!analysis || !directory) {
    return {
      status: "analysis-unavailable",
      message: "No automation analysis has been built for this site yet. An administrator can build one from the Automation tab by importing a rule export.",
    };
  }

  if (!query) return { status: "error", message: "A search query is required." };

  const riskByRuleId = new Map();
  for (const row of findings?.findings ?? []) {
    riskByRuleId.set(row.id, (row.r ?? []).map((r) => r.c));
  }

  const term = query.toLowerCase();
  const matches = [];
  for (const rule of ruleDirectoryMap(directory).values()) {
    if (!String(rule.name || "").toLowerCase().includes(term)) continue;
    if (stateFilter === "enabled" && !rule.enabled) continue;
    if (stateFilter === "disabled" && rule.enabled) continue;
    matches.push({
      ruleId: rule.id,
      name: rule.name,
      state: rule.enabled ? "ENABLED" : "DISABLED",
      trigger: rule.triggerType,
      projectCount: rule.projectCount,
      findings: riskByRuleId.get(rule.id) ?? [],
    });
  }

  // Enabled first: a disabled rule cannot be the cause of anything happening now, which is
  // what most questions are actually about.
  matches.sort((a, b) => (a.state === b.state ? 0 : a.state === "ENABLED" ? -1 : 1));

  return {
    status: "ok",
    // Age travels with a search result too. A rule created after the last import simply is
    // not here, and "no rule matched" would otherwise read as "no such rule exists".
    analysisRefreshedAt: analysis.refreshedAt ?? null,
    evidence: assessAutomationEvidence({
      indexRequired: false, // a directory search consults no index; only the age applies
      refreshedAt: analysis.refreshedAt ?? null,
      staleAfterDays,
    }),
    totalRules: directory.total ?? 0,
    matchCount: matches.length,
    matches: matches.slice(0, maxResults),
  };
}

export async function rovoInspectAutomationRule(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  const identifier = String(payload?.ruleIdentifier || "").trim();
  if (!identifier) return { status: "error", message: "A rule id or name is required." };

  const { analysis, directory, findings, fields, statuses, staleAfterDays } = await loadAutomationForAgent(installationKey);
  if (!analysis || !directory) {
    return { status: "analysis-unavailable", message: "No automation analysis has been built for this site yet." };
  }
  const evidence = assessAutomationEvidence({
    index: fields,
    refreshedAt: analysis.refreshedAt ?? null,
    staleAfterDays,
  });

  const byId = ruleDirectoryMap(directory);
  const wanted = identifier.toLowerCase();
  const rule =
    byId.get(Number(identifier)) ??
    [...byId.values()].find((r) => String(r.name || "").toLowerCase() === wanted) ??
    [...byId.values()].find((r) => String(r.name || "").toLowerCase().includes(wanted));

  if (!rule) return { status: "not-found", message: `No automation rule matched "${identifier}".` };

  // Which fields and statuses this rule touches, derived by scanning the indexes for its id.
  const touches = (index, kind) => {
    const out = [];
    for (const entry of index?.entries ?? []) {
      for (const direction of ["write", "read", "trigger"]) {
        if ((entry[direction] ?? []).includes(rule.id)) out.push({ [kind]: entry.label, direction });
      }
    }
    return out;
  };

  const findingRow = (findings?.findings ?? []).find((f) => f.id === rule.id);

  return {
    status: "ok",
    analysisRefreshedAt: evidence.refreshedAt,
    evidence,
    rule: {
      ruleId: rule.id,
      name: rule.name,
      state: rule.enabled ? "ENABLED" : "DISABLED",
      trigger: rule.triggerType,
      projectCount: rule.projectCount,
    },
    fieldsTouched: touches(fields, "field"),
    statusesTouched: touches(statuses, "status"),
    findings: (findingRow?.r ?? []).map((r) => ({
      code: r.c,
      severity: r.s,
      summary: RISK_SENTENCES[r.c] ? `This rule ${RISK_SENTENCES[r.c]}.` : r.c,
      hosts: r.h,
      disabledForDays: r.d,
    })),
    // Stated rather than implied. The indexes cap stored rule ids at 50 per direction, so a
    // rule touching a very heavily referenced field can be missing from this list -- and on
    // top of that the analysis itself may be old, which the blockers spell out.
    caveat: [
      "Field and status lists are derived from a capped index and may omit references on fields used by more than 50 rules in one direction.",
      ...evidence.blockers.map((b) => b.message),
    ].join(" "),
  };
}

export async function rovoAutomationUsage(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  const name = String(payload?.name || "").trim();
  const kind = String(payload?.kind || "field").toLowerCase() === "status" ? "status" : "field";
  if (!name) return { status: "error", message: "A field or status name is required." };

  const { analysis, fields, statuses, directory, staleAfterDays } = await loadAutomationForAgent(installationKey);
  if (!analysis) {
    return { status: "analysis-unavailable", message: "No automation analysis has been built for this site yet." };
  }

  const index = kind === "status" ? statuses : fields;
  // Settled once, before anything is claimed. `evidence` decides whether this answer is
  // allowed to be a verdict at all; without it an absence from a capped or three-week-old
  // index read exactly like a clean bill of health.
  const evidence = assessAutomationEvidence({
    index,
    refreshedAt: analysis.refreshedAt ?? null,
    staleAfterDays,
  });
  const entry = (index?.entries ?? []).find((e) => String(e.label ?? "").toLowerCase() === name.toLowerCase());

  if (!entry) {
    // The branch this whole assessment exists for. "We looked and found nothing" and "we
    // have not really looked" are different claims and only one of them justifies a
    // deletion, so when the index cannot carry the weight this degrades to unknown with
    // the reason attached rather than returning safeToDelete: true.
    if (!evidence.absenceIsEvidence) {
      return {
        status: "unknown",
        analysisRefreshedAt: evidence.refreshedAt,
        evidence,
        message: `Whether any automation rule touches the ${kind} "${name}" cannot be established from this analysis.`,
        // Not false -- false would claim rules DO reference it. Null is the third state.
        safeToDelete: null,
        guidance: evidence.blockers.map((b) => b.message).join(" "),
      };
    }
    return {
      status: "not-referenced",
      analysisRefreshedAt: evidence.refreshedAt,
      evidence,
      message: `No automation rule reads, writes or triggers on the ${kind} "${name}".`,
      safeToDelete: kind === "field",
    };
  }

  const byId = ruleDirectoryMap(directory);
  const expand = (ids = []) => ids.map((id) => {
    const r = byId.get(id);
    return { ruleId: id, name: r?.name ?? `Rule ${id}`, state: r ? (r.enabled ? "ENABLED" : "DISABLED") : "UNKNOWN" };
  });

  const referenced = entry.writeCount > 0 || entry.readCount > 0 || entry.triggerCount > 0;

  return {
    status: "ok",
    analysisRefreshedAt: evidence.refreshedAt,
    evidence,
    kind,
    name: entry.label,
    ruleCount: entry.ruleCount ?? 0,
    enabledRules: entry.enabledRules ?? 0,
    disabledRules: entry.disabledRules ?? 0,
    writtenBy: { count: entry.writeCount, rules: expand(entry.write) },
    readBy: { count: entry.readCount, rules: expand(entry.read) },
    triggers: { count: entry.triggerCount, rules: expand(entry.trigger) },
    // The single most important thing this action exists to say, and now a tri-state.
    //
    // A reference that WAS found is positive evidence and survives a stale analysis -- a
    // rule that wrote this field a fortnight ago almost certainly still does, and "no" is
    // the cautious answer anyway. An entry found with no references in any direction is an
    // absence claim like the not-found branch above, so it answers to the same test.
    safeToDelete: referenced ? false : (evidence.absenceIsEvidence ? true : null),
    guidance: entry.writeCount > 0
      ? `Deleting this ${kind} would break ${entry.writeCount} rule(s) that write to it.`
      : referenced
        ? "No rule writes this, but rules that read it will misbehave if it is removed."
        : evidence.blockers.map((b) => b.message).join(" ") || "No rule references this.",
  };
}

const EMPTY_DASHBOARD = {
  fieldUsage: {
    totalFields: 0,
    findingsBySeverity: { high: 0, medium: 0, low: 0 },
    findingsByType: [],
    fieldTypeBreakdown: [],
    origin: { builtin: 0, appProvided: 0, custom: 0 },
    duplicateClusters: 0,
  },
  projects: { totalProjects: 0, topByIssueVolume: [], topByFieldCount: [] },
};

// -- First run --------------------------------------------------------------
//
// This app is useless for the first few hours of its life. Nothing it says is worth reading
// until a scan has walked the estate, and on a real site that is a multi-hour job -- so the
// design problem is not explaining the product, it is making a long wait feel like arrival
// rather than absence.
//
// Two things come back here. A five-step checklist, and an arrivals list: every scan stage
// that has landed, what it produced, and when. The second is the one that earns the wait --
// fifteen stages become fifteen small moments, each a section the admin can open NOW while
// the issue crawl runs for another two hours.
//
// Steps are DERIVED wherever the estate can answer for itself. Only the two that describe a
// human having read something are acknowledged, and those are marked as such so the panel
// never shows a tick that means "somebody clicked" as though it meant "this is true".

const FIRST_RUN_ACK_STEPS = ["evidence-rule", "share-macro"];

export async function getFirstRunState({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  // Every read degrades to "not measured", which is the honest answer for a checklist: a
  // step whose evidence could not be read shows as outstanding rather than as done. Each one
  // is named, because a first-run panel that silently reports a scanned site as unscanned is
  // precisely the kind of confident wrong answer the degradation helpers exist to surface.
  const [config, fieldMeta, scanMeta, automation, workflowMeta] = await Promise.all([
    readAdminConfig().catch(fallbackOn("first_run.config_read_failed", null, { installationKey })),
    readSnapshotMeta(installationKey).catch(fallbackOn("first_run.field_meta_read_failed", null, { installationKey })),
    readFullScanMeta(installationKey).catch(fallbackOn("first_run.scan_meta_read_failed", null, { installationKey })),
    readAutomationAnalysis(installationKey).catch(fallbackOn("first_run.automation_read_failed", null, { installationKey })),
    readWorkflowSnapshotMeta(installationKey).catch(fallbackOn("first_run.workflow_meta_read_failed", null, { installationKey })),
  ]);

  const acknowledged = new Set(config?.firstRun?.acknowledged || []);
  const scanRunning = scanMeta?.state === "running";

  // "A scan has produced something" rather than "a scan run finished". A site whose full
  // scan was cancelled half way still has four pillars on disk and is past this step; a site
  // that has never run one has nothing, whatever any bookkeeping row says.
  const anySnapshot = Boolean(fieldMeta?.version || workflowMeta?.version);

  const steps = [
    {
      key: "first-scan",
      title: "Run the first scan",
      done: anySnapshot,
      kind: "derived",
      detail: anySnapshot
        ? "Your estate has been read at least once."
        : "Observatory reads every project, field, screen, workflow and board on this site. The first pass is typically 2-4 hours, most of it the issue crawl — it runs on Atlassian's servers, so you can close this tab.",
      cta: anySnapshot ? null : { label: "Go to Scans", tab: "scans" },
    },
    {
      key: "evidence-rule",
      title: 'Understand "not measured"',
      done: acknowledged.has("evidence-rule"),
      kind: "acknowledged",
      detail: "Zero is what makes something look safe to delete, so Observatory only shows a zero when a scan actually looked and found none. Anything it has not measured says so instead. Every screen depends on that distinction.",
    },
    {
      key: "import-automation",
      title: "Import your automation rules",
      done: Boolean(automation),
      kind: "derived",
      detail: Boolean(automation)
        ? "Automation references are in play, so findings about fields and statuses account for them."
        : "Jira publishes no API that lets an app read automation rules, so this one is exported rather than scanned. Until you import it, Observatory will not claim a field or status is unreferenced — it will say unknown.",
      cta: Boolean(automation) ? null : { label: "Go to Automation", tab: "automation" },
    },
    {
      key: "scan-schedule",
      title: "Set a scan schedule",
      done: Boolean(config?.quickScanSchedule?.enabled),
      kind: "derived",
      detail: config?.quickScanSchedule?.enabled
        ? "A quick scan runs on a schedule, so the estate stays fresh without anyone remembering."
        : "A quick scan re-reads everything except the full issue crawl. Without one, every number here ages until somebody runs a scan by hand.",
      cta: config?.quickScanSchedule?.enabled ? null : { label: "Go to Scans", tab: "scans" },
    },
    {
      key: "share-macro",
      title: "Share it with the people who ask you questions",
      done: acknowledged.has("share-macro"),
      kind: "acknowledged",
      detail: "The Confluence macro gives a read-only view of fields, screens, boards and workflows, filtered to whatever projects each reader can already browse in Jira. It is how this stops being a tool only one person opens.",
    },
  ];

  const remaining = steps.filter((step) => !step.done).length;

  return {
    // Gone once every step is done, without anyone dismissing it: a checklist that lingers
    // after completion is clutter with a tick in it, sitting permanently at the top of the
    // page an admin opens most. It comes back on its own if the estate regresses -- a wiped
    // snapshot puts the scan step back -- which is the upside of deriving rather than storing.
    show: !config?.firstRun?.dismissed && remaining > 0,
    dismissed: Boolean(config?.firstRun?.dismissed),
    remaining,
    steps,
    scanRunning,
    arrivals: await firstRunArrivals(installationKey, { anySnapshot, meta: scanMeta }),
  };
}

// What has landed, newest first, and what is still coming.
//
// Built from the stage rows the orchestrator already writes and the produced counts the
// pillar metas already hold. Nothing new is measured here -- this is the same data the Scans
// tab renders as a pipeline, turned round to read as arrivals.
async function firstRunArrivals(installationKey, { anySnapshot, meta }) {
  if (!anySnapshot) return { available: false, landed: [], pending: [] };
  // A site whose snapshots predate stage bookkeeping, or whose meta row did not survive,
  // has nothing to say here. Rendering the catalog anyway would put fifteen "not started"
  // rows in front of an admin whose estate has in fact been read -- worse than silence.
  if (!meta?.stages?.length) return { available: false, landed: [], pending: [] };

  // The only read here that can fail. Losing it costs the counts, not the list: a stage that
  // landed is still reported as landed, and what is unknown is how many -- said by omitting
  // the number rather than by printing a zero.
  const counts = await readStageProducedCounts(installationKey, "full")
    .catch(fallbackOn("first_run.stage_counts_read_failed", {}, { installationKey }));

  const landed = [];
  const pending = [];
  const byKey = new Map(meta.stages.map((row) => [row.key, row]));

  for (const stage of fullScanStageCatalog()) {
    const row = byKey.get(stage.key);
    const produced = counts?.[stage.key];
    const entry = {
      key: stage.key,
      label: stage.label,
      state: row?.state || "pending",
      completedAt: row?.completedAt || null,
      produced: Number.isFinite(Number(produced)) ? Number(produced) : null,
      // Not every stage produces a countable thing -- health records a score, drift appends
      // to a timeline. Saying "produced --" for those reads as a failure rather than as a
      // stage that simply does not count anything.
      countable: produced != null,
      error: row?.error || null,
    };
    if (entry.state === "done") landed.push(entry);
    else if (entry.state !== "skipped") pending.push(entry);
  }

  landed.sort((a, b) => String(b.completedAt || "").localeCompare(String(a.completedAt || "")));
  return { available: true, landed, pending };
}

// Ticking an acknowledgement, or putting the panel away. The only first-run state that is
// written rather than derived.
export async function setFirstRunState({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  const config = await readAdminConfig();
  const current = config.firstRun || DEFAULT_FIRST_RUN;

  const next = { ...current };
  if (payload?.acknowledge) {
    const key = String(payload.acknowledge);
    // Only the two steps that are genuinely an acknowledgement. Accepting an arbitrary key
    // would let a caller tick a DERIVED step, which is the one thing this must never do --
    // those describe the estate, and the estate is the only thing entitled to answer.
    if (!FIRST_RUN_ACK_STEPS.includes(key)) {
      return { ok: false, error: `"${key}" is derived from the estate and cannot be acknowledged.` };
    }
    next.acknowledged = [...new Set([...(current.acknowledged || []), key])];
  }
  if (payload?.dismissed !== undefined) next.dismissed = Boolean(payload.dismissed);

  await kvs.set(ADMIN_CONFIG_KEY, { ...config, firstRun: next });
  return { ok: true, firstRun: next };
}

export async function getAdminOverview({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const [meta, summaryCounts, config, legacySummaryCount, workflow, screens, issueTypeOverview, userOverview, assetOverview, accessOverview, estateOverview, boardOverview, driftHealth, filterOverview, dashboardOverview, automationAnalysis, fieldConfigOverview] = await Promise.all([
    readSnapshotMeta(installationKey),
    // Counted in SQL rather than loaded. This used to pull up to 5,000 summary rows --
    // including two LONGTEXT columns -- across the wire, and use them for a count grouped by
    // status and a total. Same six integers, one row back.
    countFieldSummariesByStatus(installationKey)
      .catch(fallbackOn("overview.summary_counts_failed", () => ({ counts: null, total: 0 }), { installationKey })),
    readAdminConfig(),
    countOldScopeKeyRows(installationKey).catch(fallbackOn("overview.legacy_row_count_failed", 0, { installationKey })),
    buildWorkflowOverview(installationKey),
    buildScreenOverview(installationKey),
    buildIssueTypeOverview(installationKey),
    buildUserOverview(installationKey),
    buildAssetOverview(installationKey),
    buildAccessOverview(installationKey),
    buildEstateOverview(installationKey),
    buildBoardOverview(installationKey),
    buildDriftHealthOverview(installationKey),
    // Without the project catalog the broken-reference check is skipped and says so. Passing
    // it would mean loading the project list before this Promise.all rather than inside the
    // dashboard build below, which is a bigger cost than the one finding is worth here -- the
    // Filters tab does the full join when somebody opens it.
    buildFilterOverview(installationKey),
    buildDashboardOverview(installationKey),
    // Falls back to null rather than failing the overview. The automation dimensions then
    // report as unavailable, which is the same thing a fresh install shows -- an overview
    // that 500s because one optional input is missing is worse than one missing a section.
    readAutomationAnalysis(installationKey).catch(fallbackOn("overview.automation_load_failed", () => null, { installationKey })),
    buildFieldConfigOverview(installationKey),
  ]);

  // The rates are computed at analysis time and stored, so the score never needs the rules.
  const automation = automationAnalysis?.estate?.health ?? { available: false };

  const jobCounts = summaryCounts.counts
    ?? { queued: 0, building: 0, ready: 0, failed: 0, cancelled: 0, unbuilt: 0 };

  let findingsSummary = { adminAttention: 0, risky: 0, cleanup: 0, standardize: 0 };
  let findingsByCode = {};
  let dashboard = EMPTY_DASHBOARD;
  if (meta?.version) {
    try {
      const [fields, rawProjects] = await Promise.all([
        loadSnapshotFields(installationKey, meta.version),
        listSnapshotProjects(installationKey, meta.version),
      ]);
      const projects = await attachUniqueIssueCounts(installationKey, rawProjects);
      const dup = buildDuplicateNameCountMap(fields);
      const hydrated = fields.map((f) =>
        hydrateFieldForGovernance(f, null, dup.get(normalizeFieldName(f.name)) ?? 1, config.governanceThresholds)
      );
      findingsSummary = summarizeFindings(hydrated);
      // The counts several new Overview cards each need -- "23 fields with a dead-
      // configuration ratio" is a specific reason code, not one of the four coarse
      // categories findingsSummary already tracks, and only this join knows the number.
      findingsByCode = summarizeFindingsByCode(hydrated);
      // Adoption travels beside the shape insights rather than inside them: one asks how a
      // project is configured and the other asks whether anyone is using it, and folding
      // them together is what let a three-week-old project read as abandoned.
      //
      // Only the counts and a short worst-first list reach the Overview. The full per-project
      // series is what the Projects tab loads, and shipping 200 projects' worth of monthly
      // history with the landing page would dwarf everything else on it.
      const activity = await loadProjectActivity(installationKey)
        .catch(fallbackOn("overview.project_activity_load_failed", () => new Map(), { installationKey }));
      const adoption = summarizeAdoption(projects, activity);

      dashboard = {
        fieldUsage: buildFieldUsageInsights(hydrated),
        projects: buildProjectInsights(projects),
        adoption: {
          available: adoption.available,
          measuredProjects: adoption.measuredProjects,
          judgeableProjects: adoption.judgeableProjects,
          fellOffCount: adoption.fellOffCount,
          neverAdoptedCount: adoption.neverAdoptedCount,
          medianIssuesPerDay: adoption.medianIssuesPerDay,
          dataThroughMonth: adoption.dataThroughMonth,
          dataStale: adoption.dataStale,
          // Most recent decline first: the ones somebody might still remember the reason for.
          fellOff: adoption.projects
            .filter((row) => row.fellOff)
            .sort((a, b) => String(b.declineFrom || "").localeCompare(String(a.declineFrom || "")))
            .slice(0, 8)
            .map((row) => ({
              projectKey: row.projectKey, projectName: row.projectName,
              declineFrom: row.declineFrom, peakMonth: row.peakMonth, peakIssues: row.peakIssues,
              issuesPerDay: row.issuesPerDay, recentIssuesPerDay: row.recentIssuesPerDay,
              momentum: row.momentum, score: row.score,
            })),
        },
      };
    } catch (error) {
      // Overview must still render its job counts and config if the dashboard build
      // fails -- but an empty dashboard and a site with no data look identical on
      // screen, so the difference has to exist in the logs.
      logger.warn("overview.dashboard_build_failed", {
        installationKey,
        version: meta.version,
        error: String(error?.message || error),
      });
    }
  }

  const priorHealthValues = await loadPriorHealthDimensions(installationKey)
    .catch(fallbackOn("overview.prior_health_load_failed", () => ({}), { installationKey }));

  // The stored cross summary, not a fresh cross. Recomputing the widest join in the app on
  // every Overview read would make the heaviest read in the product heavier still; the scan
  // computes it and this reports what it found -- or reports it stale, if either snapshot
  // has been rebuilt since.
  const screenCross = await readScreenCrossSummary(installationKey, {
    screenVersion: screens?.version ?? null,
    fieldVersion: dashboard?.fieldUsage?.version ?? null,
  }).catch(fallbackOn("overview.screen_cross_read_failed", () => null, { installationKey }));

  const health = computeSiteHealth({
    fieldUsage: dashboard?.fieldUsage,
    workflow,
    projects: dashboard?.projects,
    automation,
    screens,
    screenCross,
    filters: filterOverview?.health ?? null,
    dashboards: dashboardOverview?.health ?? null,
    issueTypes: issueTypeOverview?.health ?? null,
    users: userOverview?.health ?? null,
    assets: assetOverview?.health ?? null,
    permissions: accessOverview?.permissions?.health ?? null,
    security: accessOverview?.security?.health ?? null,
    notifications: accessOverview?.notifications?.health ?? null,
    roles: accessOverview?.roles?.health ?? null,
    estate: estateOverview?.health ?? null,
    fieldConfigs: fieldConfigOverview?.health ?? null,
    boards: boardOverview?.health ?? null,
    drift: driftHealth,
    // Workflow, project and automation dimensions were scored against hardcoded constants
    // while every field rule was tunable. Same config surface now feeds both.
    tolerances: config?.healthTolerances,
    targets: config?.healthTargets,
    priorValues: priorHealthValues,
  });

  // Recorded here because this is the only place the score is computed, and the series
  // cannot be back-filled -- a day with no row is a hole in the record forever. Upserted per
  // day, so opening the overview twice costs one row, and opening it after a cleanup
  // replaces the morning's worse number with the afternoon's better one.
  //
  // recordHealthSnapshot swallows its own errors: an overview that failed because a history
  // row could not be written would be strictly worse than one with a gap in a chart.
  await recordHealthSnapshot(installationKey, health);

  return {
    config,
    snapshot: {
      state: meta?.state || "idle",
      refreshedAt: meta?.refreshedAt || null,
      startedAt: meta?.startedAt || null,
      completedAt: meta?.completedAt || null,
      totalFields: meta?.totalFields || 0,
      processedFields: meta?.processedFields || 0,
      percent: meta?.totalFields > 0
        ? Math.min(100, Math.round(((meta.processedFields || 0) / meta.totalFields) * 100))
        : 0,
      lastError: meta?.lastError || null,
      progressLog: (meta?.progressLog || []).slice(-50),
    },
    jobCounts,
    findingsSummary,
    findingsByCode,
    workflow,
    screens,
    issueTypes: issueTypeOverview,
    users: userOverview,
    assets: assetOverview,
    access: accessOverview,
    estate: estateOverview,
    fieldConfigs: fieldConfigOverview,
    boards: boardOverview,
    // The counts the Overview's findings list needs, not just the score's rate. Same lesson
    // the automation pillar learned: trimming this to the headline fields made every problem
    // the analysis had already found invisible on the page that exists to surface problems.
    filters: filterOverview,
    dashboards: dashboardOverview,
    health,
    // The whole health summary, not just the three headline fields it used to carry. The
    // overview's findings list needs the same counts the score does -- while this was
    // trimmed to {available, refreshedAt, ruleCount}, every automation problem the analysis
    // had already found was invisible on the landing page that exists to surface problems.
    automation: {
      ...automation,
      available: Boolean(automation?.available),
      refreshedAt: automationAnalysis?.refreshedAt ?? null,
      ruleCount: automation?.ruleCount ?? 0,
    },
    dashboard,
    totalSummaries: summaryCounts.total,
    legacySummaryCount,
  };
}

// The health series, plus the deltas that make it readable.
//
// Deltas are computed here rather than in the browser so "improved by 12" means the same
// thing on every surface -- and so a dimension that appeared partway through the window is
// reported as new rather than as an improvement from zero, which would be a lie about work
// nobody did.
async function getHealthHistory({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const days = Math.max(7, Math.min(365, Number(payload?.days) || 90));

  const series = await loadHealthHistory(installationKey, { days });
  if (series.length === 0) {
    // Tri-state, as everywhere else: no history is not a flat line at zero.
    return { available: false, reason: "No health has been recorded yet.", series: [], dimensions: [], days };
  }

  const first = series[0];
  const latest = series[series.length - 1];

  // Per-dimension movement across the window. Keyed on what the LATEST measurement scored,
  // because a dimension that has since stopped being measured cannot be reported on.
  const dimensions = Object.entries(latest.dimensions).map(([key, score]) => {
    const firstScore = first.dimensions?.[key];
    const known = typeof firstScore === "number";
    return {
      key,
      score,
      first: known ? firstScore : null,
      // null, never 0, when the dimension did not exist at the start of the window --
      // "new measurement" and "no change" are different facts.
      delta: known ? score - firstScore : null,
      points: series.map((entry) => ({
        day: entry.day,
        score: typeof entry.dimensions?.[key] === "number" ? entry.dimensions[key] : null,
      })),
    };
  }).sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0));

  return {
    available: true,
    days,
    series,
    latest,
    first,
    // A single measurement is a point, not a trend, and the UI has to be able to say so
    // rather than drawing a line through one dot.
    hasTrend: series.length > 1,
    delta: series.length > 1 ? latest.score - first.score : null,
    dimensions,
  };
}

// One pillar of the health score, for the tab that pillar is about.
//
// The score already groups its dimensions into exactly the tabs this app has, so the
// governance stats each tab wants are computed the moment the Overview is. Serving one
// pillar rather than the whole score keeps a tab from shipping four pillars of data it will
// not render -- and keeps the Workflows tab from having to know how Screens is scored.
// Which inputs each pillar's dimensions are actually derived from.
//
// The whole reason this map exists: getPillarHealth used to compute the ENTIRE site health --
// every builder, every load, all ~1,600 fields hydrated -- and then throw away five of the
// six pillars it produced. Opening the Screens tab cost the same twenty-odd SQL round trips
// as the Overview to render one small panel, and the Filters tab added a second one.
//
// Declared rather than inferred, so adding a dimension to a pillar is a one-line change here
// and a missing entry is a pillar that renders empty rather than one that silently loads
// everything again.
const PILLAR_INPUTS = {
  fields: ["fieldUsage"],
  filters: ["filters"],
  dashboards: ["dashboards"],
  workflows: ["workflow"],
  screens: ["screens"],
  issueTypes: ["issueTypes"],
  users: ["users"],
  assets: ["assets"],
  permissions: ["access"],
  security: ["access"],
  notifications: ["access"],
  roles: ["access"],
  estate: ["estate"],
  boards: ["boards"],
  automation: ["automation"],
  projects: ["projects", "adoption"],
  drift: ["drift"],
  fieldConfigs: ["fieldConfigs"],
};

async function getPillarHealth({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const key = requireNonEmptyString(payload?.pillar, "pillar");

  const needs = new Set(PILLAR_INPUTS[key] ?? []);
  const config = await readAdminConfig();

  // Only what this pillar is scored from. Everything else stays null, which computeSiteHealth
  // already reports as unavailable -- and unavailable dimensions from other pillars are
  // discarded below anyway, so the returned pillar is byte-identical to what the full
  // computation produced for it.
  const [workflow, screens, filterOverview, dashboardOverview, issueTypeOverview, userOverview, assetOverview, accessOverview, estateOverview, boardOverview, driftHealth, automationAnalysis, fieldConfigOverview] = await Promise.all([
    needs.has("workflow") ? buildWorkflowOverview(installationKey) : Promise.resolve(null),
    needs.has("screens") ? buildScreenOverview(installationKey) : Promise.resolve(null),
    needs.has("filters") ? buildFilterOverview(installationKey) : Promise.resolve(null),
    needs.has("dashboards") ? buildDashboardOverview(installationKey) : Promise.resolve(null),
    needs.has("issueTypes") ? buildIssueTypeOverview(installationKey) : Promise.resolve(null),
    needs.has("users") ? buildUserOverview(installationKey) : Promise.resolve(null),
    needs.has("assets") ? buildAssetOverview(installationKey) : Promise.resolve(null),
    needs.has("access") ? buildAccessOverview(installationKey) : Promise.resolve(null),
    needs.has("estate") ? buildEstateOverview(installationKey) : Promise.resolve(null),
    needs.has("boards") ? buildBoardOverview(installationKey) : Promise.resolve(null),
    needs.has("drift") ? buildDriftHealthOverview(installationKey) : Promise.resolve(null),
    needs.has("automation")
      ? readAutomationAnalysis(installationKey).catch(fallbackOn("pillar-health.automation_load_failed", () => null, { installationKey }))
      : Promise.resolve(null),
    needs.has("fieldConfigs") ? buildFieldConfigOverview(installationKey) : Promise.resolve(null),
  ]);

  let fieldUsage = null;
  let projects = null;
  let adoption = null;

  // The expensive branch, and now the one most pillars skip entirely: loading every field in
  // the snapshot and hydrating it for governance. Only the fields and projects pillars need
  // any of it.
  if (needs.has("fieldUsage") || needs.has("projects") || needs.has("adoption")) {
    const meta = await readSnapshotMeta(installationKey);
    if (meta?.version) {
      try {
        if (needs.has("fieldUsage")) {
          const fields = await loadSnapshotFields(installationKey, meta.version);
          const dup = buildDuplicateNameCountMap(fields);
          fieldUsage = buildFieldUsageInsights(fields.map((f) =>
            hydrateFieldForGovernance(f, null, dup.get(normalizeFieldName(f.name)) ?? 1, config.governanceThresholds)
          ));
        }

        if (needs.has("projects") || needs.has("adoption")) {
          const withCounts = await attachUniqueIssueCounts(
            installationKey,
            await listSnapshotProjects(installationKey, meta.version)
          );
          projects = buildProjectInsights(withCounts);
          // Best-effort, like every optional pillar input: a site scanned before issue dates
          // were captured has no activity, and the dimension says so rather than scoring zero.
          const activity = await loadProjectActivity(installationKey)
            .catch(fallbackOn("pillar-health.project_activity_load_failed", () => new Map(), { installationKey }));
          adoption = summarizeAdoption(withCounts, activity);
        }
      } catch (error) {
        logger.warn("pillar-health.field_inputs_failed", { installationKey, error: String(error?.message || error) });
      }
    }
  }

  const screenCross = await readScreenCrossSummary(installationKey)
    .catch(fallbackOn("macro.screen_cross_read_failed", () => null, { installationKey }));

  const health = computeSiteHealth({
    fieldUsage,
    workflow,
    projects,
    automation: automationAnalysis?.estate?.health ?? { available: false },
    screens,
    screenCross,
    adoption,
    filters: filterOverview?.health ?? null,
    dashboards: dashboardOverview?.health ?? null,
    issueTypes: issueTypeOverview?.health ?? null,
    users: userOverview?.health ?? null,
    assets: assetOverview?.health ?? null,
    permissions: accessOverview?.permissions?.health ?? null,
    security: accessOverview?.security?.health ?? null,
    notifications: accessOverview?.notifications?.health ?? null,
    roles: accessOverview?.roles?.health ?? null,
    estate: estateOverview?.health ?? null,
    fieldConfigs: fieldConfigOverview?.health ?? null,
    boards: boardOverview?.health ?? null,
    drift: driftHealth,
    tolerances: config?.healthTolerances,
    targets: config?.healthTargets,
  });

  const pillar = (health.pillars || []).find((p) => p.key === key) || null;

  // The site score comes from the recorded history, not from this computation.
  //
  // It cannot come from here any more: `health` above is scored from one pillar's inputs, so
  // its headline is the score of that pillar alone. Returning it as the site score would be
  // a smaller number wearing a bigger label. The last recorded measurement is the real one,
  // and null when nothing has been recorded -- which is honest rather than approximate.
  const recorded = await loadHealthHistory(installationKey, { days: 1 })
    .catch(fallbackOn("pillar-health.history_load_failed", () => [], { installationKey }));
  const latest = recorded[recorded.length - 1] ?? null;

  return { pillar, score: latest?.score ?? null, grade: latest?.grade ?? null };
}

// One pillar's inventory as an exportable report, in the shape every pillar shares -- see
// pillar-reports.js for the contract. This is only the I/O: each branch loads what that
// pillar's own tab already loads (reusing its resolver where one returns the full list) and
// hands it to the pure builder.
//
// An unbuilt pillar returns status "unavailable" with the reason, never an empty report.
async function getPillarReport({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const key = requireNonEmptyString(payload?.pillar, "pillar");
  if (!isPillarReportKey(key)) throw new Error(`Unknown pillar report "${key}"`);

  const input = await loadPillarReportInput(key, { installationKey, context });
  if (input.unavailable) return unavailableReport(key, input.unavailable);
  return buildPillarReport(key, input);
}

const notBuilt = (what) => `No ${what} inventory has been built yet. Run a scan from the Scans tab.`;

// OQL: one query across every pillar's report rows (see src/lib/oql.js, oql-index.js).
//
// Parses before it loads anything, so a typo costs nothing. A query that pins its pillars
// (`pillar = screens AND ...`) loads only those; anything else loads every pillar, a few at a
// time. A pillar that is unbuilt or fails to load is returned as such in `pillars`, never
// silently left out -- "no matches" and "not searched" are different answers.
export const OQL_RESULT_LIMIT = 1000;
const OQL_LOAD_CONCURRENCY = 3;

async function runOqlQuery({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const text = String(payload?.query ?? "").slice(0, 2000);
  const now = new Date();

  const parsed = parseOql(text, buildOqlCatalog(), { now });
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const pinned = pinnedPillars(parsed.query.where);
  const keys = OQL_PILLARS.map((p) => p.key).filter((key) => !pinned || pinned.has(key));
  const reports = new Array(keys.length);
  let cursor = 0;
  async function worker() {
    while (cursor < keys.length) {
      const i = cursor++;
      const key = keys[i];
      try {
        // eslint-disable-next-line no-await-in-loop -- bounded by OQL_LOAD_CONCURRENCY workers
        const input = await loadPillarReportInput(key, { installationKey, context });
        reports[i] = input.unavailable
          ? unavailableReport(key, input.unavailable)
          : buildPillarReport(key, input, { limit: Infinity });
      } catch (error) {
        logger.warn("oql.pillar_load_failed", { installationKey, pillar: key, error: String(error?.message || error) });
        reports[i] = unavailableReport(key, "This pillar could not be read just now. Try again, or rebuild it from the Scans tab.");
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(OQL_LOAD_CONCURRENCY, keys.length) }, worker));

  const changes = await loadOqlChurnWindow(installationKey, now);
  const index = buildEntityIndex(reports, { changes, now });
  const matched = index.entities.filter((entity) => evaluateOql(parsed.query.where, entity));
  const ordered = sortOqlEntities(matched, parsed.query.orderBy);
  const discoveryCodes = [...new Set(index.entities.flatMap((e) => e.discoveries))].sort();

  return {
    ok: true,
    query: text,
    ranAt: now.toISOString(),
    total: ordered.length,
    truncated: ordered.length > OQL_RESULT_LIMIT,
    results: ordered.slice(0, OQL_RESULT_LIMIT),
    pillars: index.pillars,
    thresholds: index.thresholds,
    churnMeasured: Boolean(changes),
    discoveryCodes,
  };
}

// The change log's trailing churn window, or null when no drift pass has ever run -- churn is
// then unmeasured, not zero. Keyset pages of 500, capped: past the cap the counts are floors,
// which still rank the busiest items high.
const OQL_CHURN_CHANGE_CAP = 20000;
async function loadOqlChurnWindow(installationKey, now) {
  try {
    const meta = await readDriftSnapshotMeta(installationKey);
    if (!meta?.version) return null;
    const since = new Date(now.getTime() - CHURN_WINDOW_DAYS * 86400000).toISOString();
    const changes = [];
    let before = null;
    while (changes.length < OQL_CHURN_CHANGE_CAP) {
      // eslint-disable-next-line no-await-in-loop -- keyset paging: each page needs the last
      const page = await loadConfigChanges(installationKey, { since, before, limit: 500 });
      changes.push(...page);
      if (page.length < 500) break;
      before = changeCursorOf(page[page.length - 1]);
    }
    return changes;
  } catch (error) {
    logger.warn("oql.churn_load_failed", { installationKey, error: String(error?.message || error) });
    return null;
  }
}

async function loadPillarReportInput(key, { installationKey, context }) {
  switch (key) {
    case "fields": {
      const meta = await readSnapshotMeta(installationKey);
      if (!meta?.version) return { unavailable: notBuilt("field") };
      const [fields, config] = await Promise.all([loadSnapshotFields(installationKey, meta.version), readAdminConfig()]);
      const dup = buildDuplicateNameCountMap(fields);
      return {
        refreshedAt: meta.refreshedAt || meta.completedAt,
        fields: fields.map((f) =>
          hydrateFieldForGovernance(f, null, dup.get(normalizeFieldName(f.name)) ?? 1, config.governanceThresholds)),
      };
    }
    case "projects": {
      const meta = await readSnapshotMeta(installationKey);
      if (!meta?.version) return { unavailable: notBuilt("project") };
      const projects = await attachUniqueIssueCounts(installationKey, await listSnapshotProjects(installationKey, meta.version));
      const activity = await loadProjectActivity(installationKey)
        .catch(fallbackOn("pillar-report.project_activity_load_failed", () => new Map(), { installationKey }));
      return { refreshedAt: meta.refreshedAt || meta.completedAt, projects, adoption: summarizeAdoption(projects, activity) };
    }
    case "workflows": {
      const meta = await readWorkflowSnapshotMeta(installationKey);
      if (!meta?.version) return { unavailable: notBuilt("workflow") };
      const [schemes, statuses] = await Promise.all([
        loadWorkflowSchemes(installationKey, meta.version),
        loadStatusesCatalog(installationKey, meta.version).catch(() => null),
      ]);
      return { refreshedAt: meta.refreshedAt, schemes, statusCount: statuses ? statuses.length : null };
    }
    case "issueTypes": {
      const inventory = await getIssueTypeInventory({ context });
      if (inventory.neverBuilt) return { unavailable: notBuilt("issue type") };
      const schemeItems = await loadIssueTypeSchemeItems(installationKey, inventory.version);
      return { refreshedAt: inventory.refreshedAt, issueTypes: inventory.issueTypes, schemeItems, usage: inventory.usage };
    }
    case "fieldConfigs": {
      const inventory = await getFieldConfigInventory({ context });
      if (inventory.neverBuilt) return { unavailable: notBuilt("field scheme") };
      return inventory;
    }
    case "priorities": {
      const inventory = await getEstateInventory({ context });
      if (inventory.neverBuilt) return { unavailable: notBuilt("priority and resolution") };
      return inventory;
    }
    case "people": {
      const inventory = await getUserInventory({ context });
      if (inventory.neverBuilt) return { unavailable: notBuilt("people") };
      return inventory;
    }
    case "assets": {
      const inventory = await getAssetInventory({ context });
      if (inventory.assetsEnabled === false) return { unavailable: "JSM Assets is not available on this site." };
      if (inventory.neverBuilt) return { unavailable: notBuilt("Assets") };
      return inventory;
    }
    case "access": {
      const inventory = await getAccessInventory({ context });
      if (inventory.neverBuilt) return { unavailable: notBuilt("access") };
      return { refreshedAt: inventory.refreshedAt, inventory };
    }
    case "screens": {
      const meta = await readScreenSnapshotMeta(installationKey);
      if (!meta?.version) return { unavailable: notBuilt("screen") };
      const workflowMeta = await readWorkflowSnapshotMeta(installationKey).catch(() => null);
      const workflowVersion = transitionAwareWorkflowVersion(workflowMeta);
      const screens = await loadAllScreenPages(installationKey, meta.version, { workflowVersion });
      const unreachedIds = workflowVersion
        ? new Set((await loadAllScreenPages(installationKey, meta.version, { workflowVersion, filter: "unreached" })).map((r) => String(r.screenId)))
        : null;
      const [operations, mappings, itssProjects] = await Promise.all([
        loadScreenSchemeOperations(installationKey, meta.version),
        loadItssMappings(installationKey, meta.version),
        loadItssProjects(installationKey, meta.version),
      ]).catch(fallbackOn("pillar-report.screen_scheme_chain_failed", () => [null, null, null], { installationKey }));
      const projectsByScreen = operations ? countScreenProjects({ operations, mappings, itssProjects }) : null;
      return { refreshedAt: meta.refreshedAt, screens, unreachedIds, projectsByScreen };
    }
    case "filters": {
      const meta = await readFilterSnapshotMeta(installationKey);
      if (!meta?.version) return { unavailable: notBuilt("saved filter") };
      const { withFindings } = await loadFiltersWithFindings(installationKey, meta.version);
      return { refreshedAt: meta.refreshedAt, filters: withFindings };
    }
    case "dashboards": {
      const meta = await readDashboardSnapshotMeta(installationKey);
      if (!meta?.version) return { unavailable: notBuilt("dashboard") };
      return { refreshedAt: meta.refreshedAt, dashboards: await loadDashboards(installationKey, meta.version) };
    }
    case "boards": {
      const inventory = await getBoardInventory({ context });
      if (inventory.neverBuilt) return { unavailable: notBuilt("board") };
      return inventory;
    }
    case "automation": {
      const [analysis, directory] = await Promise.all([
        readAutomationAnalysis(installationKey).catch(() => null),
        readAutomationPart(installationKey, "directory").catch(() => null),
      ]);
      if (!directory) return { unavailable: "No automation rules have been imported yet. Import them from the Automation tab." };
      return {
        refreshedAt: analysis?.refreshedAt ?? directory.refreshedAt ?? null,
        rules: [...hydrateRuleDirectory(directory).values()],
        findingsPreview: analysis?.findingsPreview ?? [],
        findingsTotal: analysis?.findingsTotal ?? 0,
      };
    }
    case "changes": {
      const meta = await readDriftSnapshotMeta(installationKey);
      if (!meta?.version) return { unavailable: "No configuration drift pass has run yet." };
      const since = new Date(Date.now() - CHANGE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const changes = [];
      let before = null;
      // Keyset pages of 500 until the window is exhausted or the report cap is passed.
      while (changes.length <= REPORT_ROW_LIMIT) {
        const page = await loadConfigChanges(installationKey, { since, before, limit: 500 });
        changes.push(...page);
        if (page.length < 500) break;
        before = changeCursorOf(page[page.length - 1]);
      }
      return { refreshedAt: meta.refreshedAt, changes, windowDays: CHANGE_WINDOW_DAYS };
    }
    default:
      throw new Error(`Unknown pillar report "${key}"`);
  }
}

// Every screen, in pages of the store's maximum. Stops one page past the report cap so the
// report can still say it was truncated.
async function loadAllScreenPages(installationKey, version, { workflowVersion = null, filter = null } = {}) {
  const rows = [];
  for (let offset = 0; rows.length <= REPORT_ROW_LIMIT; offset += 200) {
    const page = await loadScreensPage(installationKey, version, { limit: 200, offset, filter, workflowVersion });
    rows.push(...page.rows);
    if (page.rows.length < 200) break;
  }
  return rows;
}

// Everything that touches one project, across every pillar.
//
// This is the view the Projects tab existed to give and could not: it had the field list and
// a workflow scheme wedged in beside it, and no way to say which forms a project routes to
// or which automation rules fire in it. Both joins existed as data and neither had a query.
//
// Each pillar is independent and independently unavailable. A project whose screen inventory
// has never been built reports screens as unknown and still shows its workflow, fields and
// rules -- the alternative is one unbuilt pillar blanking the whole page.
// A project's overall health, rolled up from the pillar signals rather than compressed into
// one invented number. The app's rule everywhere else: publish the rate the judgement came
// from, because "ADVEV scores 41" tells an admin nothing they can act on.
//
// The band is deliberately coarse -- "needs a look" vs "looks fine" -- and only the signals
// carry detail. `configHeavy` is the one principled threshold: 3x the site's own median
// fills-per-issue, the same median-derived approach the field pillar already uses.
function buildProjectHealthRollup({ perIssue, siteMedianPerIssue, adoption, automation, screens, workflow }) {
  const signals = [];

  if (adoption?.measured) {
    const tone = adoption.fellOff ? "critical" : adoption.neverAdopted ? "warning"
      : (adoption.score ?? 0) >= 66 ? "success" : "neutral";
    signals.push({
      key: "adoption",
      label: "Adoption",
      value: adoption.score ?? "—",
      detail: adoption.fellOff ? "running far below its own historical rate"
        : adoption.neverAdopted ? "never picked up — under an issue a month across its life"
        : adoption.volumePercentile != null ? `busier than ${adoption.volumePercentile}% of projects here`
        : "measured",
      tone,
    });
  } else {
    signals.push({
      key: "adoption",
      label: "Adoption",
      value: "—",
      detail: adoption?.dataStale ? "activity data is stale — the last full scan didn't finish"
        : "no scanned activity yet",
      tone: "neutral",
    });
  }

  const ratio = perIssue != null && siteMedianPerIssue ? perIssue / siteMedianPerIssue : null;
  const configHeavy = ratio != null && ratio >= 3;
  signals.push({
    key: "configuration",
    label: "Configuration weight",
    value: perIssue != null ? `${perIssue.toFixed(1)} fields/issue` : "—",
    detail: perIssue == null ? "needs a Universal Scan for issue counts"
      : siteMedianPerIssue ? `site median ${siteMedianPerIssue.toFixed(1)}${ratio >= 2 ? ` — ${ratio.toFixed(1)}× heavier` : ""}`
      : "how much of the form gets filled",
    tone: ratio != null && ratio >= 6 ? "critical" : configHeavy ? "warning" : "neutral",
  });

  if (automation?.available) {
    signals.push({
      key: "automation",
      label: "Automation",
      value: automation.enabledCount,
      detail: `${automation.enabledCount} active${automation.disabledCount ? `, ${automation.disabledCount} disabled` : ""} scoped here`,
      // A soft flag at a round number: a project carrying dozens of its own rules is a
      // maintenance surface, not a defect. 40 is where "complex" starts to read as "nobody
      // fully understands this any more".
      tone: automation.enabledCount >= 40 ? "warning" : "neutral",
    });
  }

  if (screens?.available) {
    const readable = (screens.screens || []).filter((s) => s.tabsResolved === "resolved").length;
    signals.push({
      key: "forms",
      label: "Forms",
      value: readable,
      detail: screens.unresolvedScreens > 0
        ? `${screens.unresolvedScreens} screens on this site could not be read`
        : "screens this project routes to",
      tone: screens.unresolvedScreens > 0 ? "warning" : "neutral",
    });
  }

  if (workflow?.available && workflow.scheme) {
    signals.push({
      key: "process",
      label: "Process",
      value: workflow.scheme.sharedWithCount > 0 ? "shared" : "local",
      detail: workflow.scheme.sharedWithCount > 0
        ? `workflow scheme shared with ${workflow.scheme.sharedWithCount} other ${workflow.scheme.sharedWithCount === 1 ? "project" : "projects"}`
        : "workflow scheme used only here",
      tone: "neutral",
    });
  }

  const worst = signals.some((s) => s.tone === "critical") ? "critical"
    : signals.some((s) => s.tone === "warning") ? "warning" : "healthy";

  return {
    band: worst,
    headline: worst === "critical" ? "Needs attention"
      : worst === "warning" ? "Worth a look" : "Looks healthy",
    signals,
  };
}

async function getProjectOverview({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const projectId = requireNonEmptyString(payload?.projectId, "projectId");
  const projectKeyHint = typeof payload?.projectKey === "string" ? payload.projectKey.trim() : "";

  // Permission first, and before any pillar is read. Every other project read in this file
  // filters by browsable project, and a cross-pillar view must not become the one place a
  // caller can learn about a project they cannot see. browsableOrAll keeps that check for
  // every resolver caller and only relaxes it for a Rovo agent action, which arrives with no
  // user principal to check against (see its comment).
  const browsable = await browsableOrAll(context, [projectId]);
  if (!browsable.has(String(projectId))) {
    return { available: false, reason: "You do not have Browse Projects on this project." };
  }

  const [fieldMeta, workflowMeta, screenMeta, filterMeta, accessMeta, boardMeta] = await Promise.all([
    readSnapshotMeta(installationKey),
    readWorkflowSnapshotMeta(installationKey).catch(() => null),
    readScreenSnapshotMeta(installationKey).catch(() => null),
    readFilterSnapshotMeta(installationKey).catch(() => null),
    readAccessSnapshotMeta(installationKey).catch(() => null),
    readBoardSnapshotMeta(installationKey).catch(() => null),
  ]);

  // The agile boards whose location is this project. loadBoards returns the whole estate for
  // a version -- a few hundred rows -- so filtering in memory is cheaper than a scoped query.
  const projectBoards = boardMeta?.version
    ? (await loadBoards(installationKey, boardMeta.version).catch(() => []))
        .filter((b) => b.locationType === "project" &&
          (String(b.locationId) === String(projectId) ||
           (projectKeyHint && String(b.locationKey || "").toLowerCase() === projectKeyHint.toLowerCase())))
    : [];

  // The project's own row, plus every browsable project's activity -- needed both for this
  // project's fills-per-issue and for the site median it is judged against, and for the
  // adoption percentile, which is only meaningful against a population.
  const allProjectsRaw = fieldMeta?.version
    ? await listSnapshotProjects(installationKey, fieldMeta.version).catch(() => [])
    : [];
  const allProjects = await attachUniqueIssueCounts(installationKey, allProjectsRaw).catch(() => allProjectsRaw);
  const thisProject = allProjects.find((p) => String(p.projectId) === String(projectId)) || null;
  const projectKey = projectKeyHint || thisProject?.projectKey || "";

  const [scheme, screens, rules, globalRules, projectFilters, activityByProject, projectSchemeRows, projectRoleRows] = await Promise.all([
    workflowMeta?.version
      ? loadWorkflowSchemeForProject(installationKey, workflowMeta.version, projectId).catch(() => null)
      : Promise.resolve(null),
    screenMeta?.version
      ? loadScreensForProject(installationKey, screenMeta.version, projectId).catch(() => null)
      : Promise.resolve(null),
    loadRulesForProject(installationKey, projectId).catch(() => null),
    // Needs the field snapshot: the evidence is field usage in this project, so without it
    // there is nothing to infer from and the list is withheld rather than guessed at.
    fieldMeta?.version
      ? loadGlobalRulesAffectingProject(installationKey, fieldMeta.version, projectId).catch(() => null)
      : Promise.resolve(null),
    // Filters whose JQL names this project. The filter snapshot already indexes project refs
    // pulled out of each filter's JQL, so this is the same join the field pillar uses.
    filterMeta?.version && projectKey
      ? loadFilterReferencesFor(installationKey, filterMeta.version, "project", projectKey).catch(() => null)
      : Promise.resolve(null),
    loadProjectActivity(installationKey).catch(() => new Map()),
    accessMeta?.version
      ? loadProjectSchemes(installationKey, accessMeta.version, projectId).catch(() => null)
      : Promise.resolve(null),
    accessMeta?.version
      ? loadProjectRoleActors(installationKey, accessMeta.version, projectId).catch(() => null)
      : Promise.resolve(null),
  ]);

  const workflowPillar = workflowMeta?.version
    ? { available: true, scheme }
    : { available: false, reason: "No workflow inventory has been built yet." };
  const screensPillar = screenMeta?.version && screens
    ? { available: true, screens, unresolvedScreens: screenMeta.unresolvedScreens || 0 }
    : { available: false, reason: "No screen inventory has been built yet." };
  const automationPillar = rules
    ? {
      available: true,
      rules,
      enabledCount: rules.filter((r) => r.enabled).length,
      disabledCount: rules.filter((r) => !r.enabled).length,
      globalRules: globalRules || [],
      globalRulesAvailable: Boolean(globalRules),
      globalRulesReason: globalRules ? null : "Needs the field snapshot to tell which site-wide rules act on this project.",
    }
    : { available: false, reason: "No automation analysis has been built yet." };

  // Adoption for this project, scored against every browsable project so its percentile means
  // something. Reuses summarizeAdoption rather than re-deriving the site median here.
  let adoptionRow = null;
  let siteMedianPerIssue = null;
  if (thisProject) {
    const adoption = summarizeAdoption(allProjects, activityByProject);
    adoptionRow = adoption.projects.find((r) => String(r.projectId) === String(projectId)) || null;
    if (adoptionRow) adoptionRow.dataStale = adoption.dataStale;
    const perIssueValues = allProjects
      .map((p) => {
        const f = Number(p.totalIssueCount), u = Number(p.uniqueIssueCount);
        return Number.isFinite(f) && Number.isFinite(u) && u > 0 ? f / u : null;
      })
      .filter((v) => v != null)
      .sort((a, b) => a - b);
    siteMedianPerIssue = perIssueValues.length ? perIssueValues[Math.floor(perIssueValues.length / 2)] : null;
  }

  const thisFills = Number(thisProject?.totalIssueCount);
  const thisIssues = Number(thisProject?.uniqueIssueCount);
  const perIssue = Number.isFinite(thisFills) && Number.isFinite(thisIssues) && thisIssues > 0
    ? thisFills / thisIssues
    : null;

  return {
    available: true,
    projectId,
    projectKey: projectKey || null,
    projectName: thisProject?.projectName || null,
    // When the field snapshot this view is anchored on was built. Null with no snapshot.
    refreshedAt: fieldMeta?.refreshedAt || null,
    // Tri-state per pillar, never an empty list standing in for an unbuilt one. "No rule
    // touches this project" and "no automation analysis exists" are opposite claims, and
    // only one of them means the project is simple.
    workflow: workflowPillar,
    screens: screensPillar,
    automation: automationPillar,
    // Filters whose JQL scopes to this project -- the ones that break, or narrow, if it is
    // renamed or archived. Tri-state like the rest: no filter snapshot is not "no filters".
    filters: filterMeta?.version
      ? {
        available: true,
        total: projectFilters?.total ?? 0,
        filters: projectFilters?.filters ?? [],
      }
      : { available: false, reason: "No saved-filter inventory has been built yet." },
    adoption: adoptionRow,
    // The permission / issue-security / notification scheme this project uses, each flagged
    // if it is the site default. Tri-state like the rest.
    schemes: accessMeta?.version
      ? {
        available: true,
        permission: (projectSchemeRows || []).find((s) => s.schemeType === "permission") || null,
        security: (projectSchemeRows || []).find((s) => s.schemeType === "security") || null,
        notification: (projectSchemeRows || []).find((s) => s.schemeType === "notification") || null,
      }
      : { available: false, reason: "No access scheme inventory has been built yet." },
    // Project-role actors, grouped by role. An "empty" holder means the role exists here
    // with nobody in it.
    roles: accessMeta?.version
      ? {
        available: true,
        byRole: Object.values((projectRoleRows || []).reduce((acc, r) => {
          const key = r.roleId;
          acc[key] = acc[key] || { roleId: r.roleId, roleName: r.roleName, actors: [] };
          if (r.holderType === "user" || r.holderType === "group") {
            acc[key].actors.push({ type: r.holderType, value: r.holderValue, label: r.holderLabel });
          }
          return acc;
        }, {})),
      }
      : { available: false, reason: "No access scheme inventory has been built yet." },
    // The agile boards that live in this project, with their backing filter and column state.
    // Tri-state like the rest: no board snapshot is not "no boards".
    boards: boardMeta?.version
      ? {
        available: true,
        boards: projectBoards.map((b) => ({
          boardId: b.boardId,
          name: b.name,
          type: b.type,
          filterId: b.filterId,
          columnCount: b.columnCount,
          configReadable: b.configReadable,
        })),
      }
      : { available: false, reason: "No board inventory has been built yet." },
    // One rolled-up read of the project's overall health, from the pillar signals above.
    health: buildProjectHealthRollup({
      perIssue,
      siteMedianPerIssue,
      adoption: adoptionRow,
      automation: automationPillar,
      screens: screensPillar,
      workflow: workflowPillar,
    }),
    fields: { available: Boolean(fieldMeta?.version) },
  };
}

export async function migrateNamespaceKeys({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const result = await migrateOldScopeKeys(installationKey);
  return result;
}

// ----- Delta issue scan -----

// Exported so the quick-scan orchestrator (full-scan-runner.js) can read the same meta row
// this file's own delta-scan resolvers read. Not imported there statically -- resolvers.js
// already imports startQuickScan/runQuickScanStep from full-scan-runner.js, and a static
// import back the other way would be a module cycle. full-scan-runner.js reaches this and
// runDeltaIssueScanJob via a dynamic import instead, the same escape hatch scan-engine.js
// already uses for the same reason.
export const DELTA_SCOPE_SUFFIX = "::delta";
const DELTA_ISSUE_SCAN_MAX_PAGES = 200; // cap at ~20,000 issues per delta run
export const DELTA_ISSUE_SCAN_DEFAULT_WINDOW_HOURS = 24;

export async function runDeltaIssueScanJob(installationKey, windowHours = DELTA_ISSUE_SCAN_DEFAULT_WINDOW_HOURS) {
  const deltaScopeKey = `${installationKey}${DELTA_SCOPE_SUFFIX}`;
  const progressLog = [];

  function logEntry(msg) {
    progressLog.push({ t: new Date().toISOString(), msg });
    if (progressLog.length > 100) progressLog.shift();
    console.log(`runDeltaIssueScanJob: ${msg}`);
  }

  try {
    await ensureProjectStoreReady();

    const existing = await readIssueScanMeta(deltaScopeKey);
    if (existing?.state === "building") {
      const startedMs = existing.startedAt ? new Date(existing.startedAt).getTime() : 0;
      if (startedMs && (Date.now() - startedMs) < 10 * 60 * 1000) {
        console.log("runDeltaIssueScanJob: already in progress, skipping");
        return;
      }
    }

    const windowDays = Math.max(1, Math.round(windowHours / 24));
    const jql = `created >= "-${windowDays}d" OR updated >= "-${windowDays}d" ORDER BY issueKey ASC`;
    logEntry(`Starting ${windowHours}h delta scan`);

    let totalDeltaIssues = 0;
    try {
      const countData = await jiraRequest(route`/rest/api/3/search/jql`, {
        method: "POST",
        body: JSON.stringify({ jql, maxResults: 0, fields: [] }),
      });
      totalDeltaIssues = Number(countData?.total ?? 0);
    } catch (error) {
      // Progress totals only -- the delta scan runs regardless. Logged because a zero
      // total makes the progress bar claim completion immediately, which reads as a
      // finished scan rather than an unknown one.
      logger.warn("delta.total_count_failed", {
        installationKey: deltaScopeKey,
        error: String(error?.message || error),
      });
    }

    const totalDeltaPages = Math.ceil(totalDeltaIssues / ISSUE_SCAN_PAGE_SIZE);
    logEntry(`${totalDeltaIssues.toLocaleString()} issues created/updated in last ${windowDays}d (${totalDeltaPages} pages)`);

    await writeIssueScanMeta(deltaScopeKey, {
      state: "building",
      jobToken: makeJobToken(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      totalIssues: totalDeltaIssues,
      processedIssues: 0,
      processedPages: 0,
      totalPages: totalDeltaPages,
      nextPageToken: null,
      nextStartAt: 0,
      lastError: null,
      progressLog: [...progressLog],
    });

    // Map<fieldId, Map<projectId, { count, key, name }>> â€” same structure as baseline scan
    const fieldProjectCounts = new Map();
    const affectedProjects = new Map();
    const rqtFieldHits = new Map();
    const rqtIssueBuffer = [];
    const rqtValueBuffer = []; // { rqtValue, issueKey }
    const rqtFieldIssueBuffer = []; // { fieldId, issueKey }
    let cursorToken = null;
    let pagesScanned = 0;
    let issuesScanned = 0;

    while (pagesScanned < DELTA_ISSUE_SCAN_MAX_PAGES) {
      const reqBody = { jql, maxResults: ISSUE_SCAN_PAGE_SIZE, fields: ["*all"], fieldsByKeys: false };
      if (cursorToken) reqBody.nextPageToken = cursorToken;

      const data = await jiraRequest(route`/rest/api/3/search/jql`, {
        method: "POST",
        body: JSON.stringify(reqBody),
      });

      const issues = data?.issues || [];
      for (const issue of issues) {
        const projectId = String(issue.fields?.project?.id || "");
        if (!projectId) continue;
        const projectKey = String(issue.fields?.project?.key || "");
        const projectName = String(issue.fields?.project?.name || projectKey);

        affectedProjects.set(projectId, { key: projectKey, name: projectName });

        for (const [fieldId, value] of Object.entries(issue.fields || {})) {
          if (STRUCTURAL_SYSTEM_FIELDS.has(fieldId)) continue;
          if (!isFieldValueNonEmpty(value)) continue;

          let byProject = fieldProjectCounts.get(fieldId);
          if (!byProject) {
            byProject = new Map();
            fieldProjectCounts.set(fieldId, byProject);
          }
          const entry = byProject.get(projectId) || { count: 0, key: projectKey, name: projectName };
          entry.count++;
          byProject.set(projectId, entry);
        }

        const issueRqt = collectIssueRqtValues(issue.fields, issue.fields?.summary);
        for (const [fieldId, values] of issueRqt) {
          const rqtEntry = rqtFieldHits.get(fieldId) || { count: 0, values: new Set() };
          rqtEntry.count++;
          for (const v of values) rqtEntry.values.add(v);
          rqtFieldHits.set(fieldId, rqtEntry);
        }

        if (issueRqt.size > 0 && issue.key) {
          rqtIssueBuffer.push({
            projectKey,
            issueType: issue.fields?.issuetype?.name || "Unknown",
            issueKey: issue.key,
          });
          const allValues = new Set();
          for (const vals of issueRqt.values()) for (const v of vals) allValues.add(v);
          for (const v of allValues) rqtValueBuffer.push({ rqtValue: v, issueKey: issue.key });
        }
        if (issueRqt.size > 0 && issue.key) {
          for (const fieldId of issueRqt.keys()) {
            rqtFieldIssueBuffer.push({ fieldId, issueKey: issue.key });
          }
        }
      }

      issuesScanned += issues.length;
      pagesScanned++;
      cursorToken = data?.nextPageToken || null;

      if (pagesScanned % 5 === 0) {
        await writeIssueScanMeta(deltaScopeKey, {
          processedIssues: issuesScanned,
          processedPages: pagesScanned,
          progressLog: [...progressLog],
        }).catch(ignoreWith("delta.progress_write_failed", { installationKey }));
      }

      if (!cursorToken || issues.length === 0) break;
    }

    if (pagesScanned >= DELTA_ISSUE_SCAN_MAX_PAGES) {
      logEntry(`Delta cap reached (${DELTA_ISSUE_SCAN_MAX_PAGES} pages) â€” results may be partial`);
    }

    logEntry(`Scanned ${issuesScanned.toLocaleString()} delta issues â€” ${fieldProjectCounts.size} fields across ${affectedProjects.size} projects`);

    if (rqtFieldHits.size > 0) {
      await upsertRqtFieldHits(installationKey, rqtFieldHits).catch((e) => {
        console.error("runDeltaIssueScanJob: RQT flush error", e?.message || e);
      });
      logEntry(`RQT index updated â€” ${rqtFieldHits.size} field(s) with RQT values`);
    }
    if (rqtIssueBuffer.length > 0) {
      await upsertRqtIssueKeys(installationKey, rqtIssueBuffer).catch((e) => {
        console.error("runDeltaIssueScanJob: RQT issue key flush error", e?.message || e);
      });
      logEntry(`RQT issue keys updated â€” ${rqtIssueBuffer.length} issue(s)`);
    }
    if (rqtValueBuffer.length > 0) {
      await upsertRqtValueIssueKeys(installationKey, rqtValueBuffer).catch((e) => {
        console.error("runDeltaIssueScanJob: RQT value index flush error", e?.message || e);
      });
    }
    if (rqtFieldIssueBuffer.length > 0) {
      await upsertRqtFieldIssueKeys(installationKey, rqtFieldIssueBuffer).catch((e) => {
        console.error(`RQT field issue index flush error`, e?.message || e);
      });
    }

    // Update project totals (accurate: re-count total issues per affected project)
    const projectRows = [];
    if (affectedProjects.size > 0) {
      const projectEntries = Array.from(affectedProjects.entries());
      const counts = await mapWithConcurrency(projectEntries, 4, async ([projectId, proj]) => {
        try {
          const safeKey = proj.key.replace(/"/g, '\\"');
          const countData = await jiraRequest(route`/rest/api/3/search/jql`, {
            method: "POST",
            body: JSON.stringify({ jql: `project = "${safeKey}"`, maxResults: 0, fields: [] }),
          });
          return { projectId, projectKey: proj.key, projectName: proj.name, uniqueIssueCount: Number(countData?.total ?? 0) };
        } catch {
          return null;
        }
      });
      projectRows.push(...counts.filter(Boolean));
      await upsertProjectTotalsForDelta(installationKey, projectRows);
      logEntry(`Updated total issue counts for ${projectRows.length} project${projectRows.length !== 1 ? "s" : ""}`);
    }

    // Update fieldÃ—project usage: for each touched pair, get accurate total count via JQL
    const snapshotMeta = await readSnapshotMeta(installationKey);
    let fieldProjectPairsUpdated = 0;

    if (snapshotMeta?.version && fieldProjectCounts.size > 0) {
      const touchedPairs = [];
      for (const [fieldId, byProject] of fieldProjectCounts) {
        for (const [projectId, proj] of byProject) {
          touchedPairs.push({ fieldId, projectId, projectKey: proj.key, projectName: proj.name, deltaCount: proj.count });
        }
      }
      touchedPairs.sort((a, b) => b.deltaCount - a.deltaCount);
      const cappedPairs = touchedPairs.slice(0, 500);
      if (touchedPairs.length > 500) {
        logEntry(`Capped fieldÃ—project count queries at 500 of ${touchedPairs.length} pairs`);
      }

      logEntry(`Running ${cappedPairs.length} fieldÃ—project count queries...`);

      const usageRows = await mapWithConcurrency(cappedPairs, 6, async ({ fieldId, projectId, projectKey, projectName }) => {
        try {
          const numericId = getFieldNumericId(fieldId);
          const fieldSelector = numericId ? `cf[${numericId}]` : fieldId;
          const safeKey = projectKey.replace(/"/g, '\\"');
          const countData = await jiraRequest(route`/rest/api/3/search/jql`, {
            method: "POST",
            body: JSON.stringify({
              jql: `project = "${safeKey}" AND ${fieldSelector} is not EMPTY`,
              maxResults: 0,
              fields: [],
            }),
          });
          return {
            fieldId,
            projectId,
            projectKey,
            projectName,
            issueCount: Number(countData?.total ?? 0),
            jql: buildFieldJql(fieldId, projectKey),
          };
        } catch {
          return null;
        }
      });

      const validRows = usageRows.filter(Boolean).filter((r) => r.issueCount > 0);
      fieldProjectPairsUpdated = await upsertDeltaFieldProjectUsage(installationKey, snapshotMeta.version, validRows);
      logEntry(`Updated ${fieldProjectPairsUpdated} fieldÃ—project usage rows in snapshot`);
    } else if (!snapshotMeta?.version) {
      logEntry("No snapshot found â€” skipping field usage update (run a snapshot first)");
    }

    await writeIssueScanMeta(deltaScopeKey, {
      state: "ready",
      completedAt: new Date().toISOString(),
      processedIssues: issuesScanned,
      processedPages: pagesScanned,
      totalIssues: totalDeltaIssues,
      totalPages: totalDeltaPages,
      nextPageToken: null,
      nextStartAt: 0,
      lastError: null,
      projectsUpdated: projectRows.length,
      fieldProjectPairsUpdated,
      progressLog: [...progressLog],
    });

  } catch (error) {
    await writeIssueScanMeta(deltaScopeKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: error?.message || String(error),
      progressLog: [...progressLog, { t: new Date().toISOString(), msg: `Delta scan failed: ${error?.message || error}` }],
    }).catch(ignoreWith("delta.failure_write_failed", { installationKey }));
    console.error("runDeltaIssueScanJob failed:", error?.message || error);
  }
}

async function startDeltaIssueScan({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const deltaScopeKey = `${installationKey}${DELTA_SCOPE_SUFFIX}`;

  const existing = await readIssueScanMeta(deltaScopeKey);
  if (existing?.state === "building" || existing?.state === "queued") {
    return { started: false, reason: "already-running" };
  }

  try {
    await writeIssueScanMeta(deltaScopeKey, {
      state: "queued",
      progressLog: [{ t: new Date().toISOString(), msg: "Delta scan queued" }],
    });
    await inventorySnapshotQueue.push({
      body: { jobType: "run-delta-issue-scan", installationKey },
    });
    return { started: true };
  } catch (pushError) {
    await writeIssueScanMeta(deltaScopeKey, {
      state: "failed",
      lastError: `Queue push failed: ${pushError?.message || pushError}`,
    }).catch(ignoreWith("delta.completion_write_failed", { installationKey }));
    throw pushError;
  }
}

async function getDeltaIssueScanStatus({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const deltaScopeKey = `${installationKey}${DELTA_SCOPE_SUFFIX}`;
  const meta = await readIssueScanMeta(deltaScopeKey);
  return { meta: meta || null };
}

async function getRqtIndex({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const [rqtFields, snapshotMeta, issuesByProject, rqtValueFrequency, issueRqtValues, fieldIssueIndex] = await Promise.all([
    loadRqtFieldIndex(installationKey),
    readSnapshotMeta(installationKey),
    loadRqtIssueKeys(installationKey),
    loadRqtValueFrequency(installationKey),
    loadIssueRqtValues(installationKey),
    loadRqtFieldIssueIndex(installationKey),
  ]);

  // Enrich field names from the live snapshot if available
  if (snapshotMeta?.version && rqtFields.length > 0) {
    try {
      const snapshotFields = await loadSnapshotFields(installationKey, snapshotMeta.version);
      const nameMap = {};
      for (const f of snapshotFields) nameMap[f.id] = f.name;
      for (const r of rqtFields) {
        if (nameMap[r.fieldId]) r.fieldName = nameMap[r.fieldId];
      }
    } catch (error) {
      // Best-effort: the RQT index is usable with raw field ids, just less readable.
      logger.warn("rqt.name_enrichment_failed", {
        installationKey,
        error: String(error?.message || error),
      });
    }
  }

  const jql = buildRqtJql(rqtFields.map((r) => r.fieldId));
  const allValues = [...new Set(rqtFields.flatMap((r) => r.sampleValues))].sort();
  const totalIssues = rqtFields.reduce((sum, r) => sum + r.issueCount, 0);
  const refreshedAt = rqtFields[0]?.refreshedAt || null;

  const totalUniqueIssues = issuesByProject.reduce((sum, p) => sum + p.total, 0);

  return {
    fields: rqtFields,
    jql,
    uniqueValues: allValues,
    totalIssues,
    totalUniqueIssues,
    issuesByProject,
    rqtValueFrequency,
    refreshedAt,
    fieldCount: rqtFields.length,
    issueRqtValues,
    fieldIssueIndex,
  };
}

async function searchRqtValue({ payload, context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const rqtValue = String(payload?.rqtValue || "").trim().toUpperCase();
  if (!rqtValue) return { issueKeys: [] };
  const issueKeys = await searchRqtValueIssueKeys(installationKey, rqtValue);
  return { issueKeys };
}

async function getFieldOptions({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    await ensureProjectStoreReady();
    const fieldId = String(payload?.fieldId || "");
    const projectKeys = Array.isArray(payload?.projectKeys) ? payload.projectKeys.filter(Boolean) : [];

    if (!fieldId) return { fieldId: "", optionsByContext: [] };

    let { optionsByContext, refreshedAt } = await loadFieldOptionsCache(getInstallationKey(context), fieldId);
    if (!optionsByContext.length || payload?.forceRefresh) {
      optionsByContext = await loadFieldOptionsFromJira(fieldId);
      const cacheResult = await replaceFieldOptionsCache(getInstallationKey(context), fieldId, optionsByContext);
      refreshedAt = cacheResult.refreshedAt;
    }

    if (projectKeys.length > 0) {
      const numericId = getFieldNumericId(fieldId);
      const fieldSelector = numericId ? `cf[${numericId}]` : fieldId;
      const projectFilter = `project in (${projectKeys.map((k) => `"${k.replace(/"/g, '\\"')}"`).join(", ")})`;

      const allOptions = [];
      const seenIds = new Set();
      for (const ctx of optionsByContext) {
        for (const opt of ctx.options) {
          if (!seenIds.has(opt.id) && !opt.disabled) {
            seenIds.add(opt.id);
            allOptions.push(opt);
          }
          if (allOptions.length >= 100) break;
        }
        if (allOptions.length >= 100) break;
      }

      const counts = await mapWithConcurrency(allOptions, 4, async (opt) => {
        try {
          const safeValue = opt.value.replace(/"/g, '\\"');
          const data = await jiraRequest(route`/rest/api/3/search/jql`, {
            method: "POST",
            body: JSON.stringify({ jql: `${projectFilter} AND ${fieldSelector} = "${safeValue}"`, maxResults: 0, fields: [] }),
          });
          return { id: opt.id, issueCount: Number(data?.total ?? 0) };
        } catch {
          return { id: opt.id, issueCount: null };
        }
      });

      const countById = new Map(counts.map((c) => [c.id, c.issueCount]));
      for (const ctx of optionsByContext) {
        for (const opt of ctx.options) {
          if (countById.has(opt.id)) opt.issueCount = countById.get(opt.id);
        }
      }
    }

    return { fieldId, optionsByContext, refreshedAt };
  } catch (error) {
    console.error("getFieldOptions failed:", error);
    throw error;
  }
}

// Functions registered on BOTH handler (macro, end-user) and adminHandler.
// All entries here must be safe for any authenticated Confluence user to call:
// pure reads, no sensitive admin data, no mutation of stored state.
export const SHARED_RESOLVER_FUNCTIONS = {
  checkMacroAccess,        // Read-only: checks group membership for macro access gating
  getFieldInventory,       // Read-only: returns paginated snapshot of custom field inventory
  getWorkflowInventory,    // Read-only: returns paginated snapshot of workflow scheme / status inventory
  getWorkflowInsights,     // Read-only: derived governance findings over the workflow snapshot
  getFieldDetails,         // Read-only: returns detailed field data for a single field
  getProjectsView,         // Read-only: returns per-project field usage view
  getFilteredFieldIds,     // Read-only: returns filtered and sorted field ID list
  getFieldOptions,         // Read-only: returns field option values from cache or Jira
  searchFieldOptions,      // Read-only: searches cached field option labels
  getSavedReports,         // Read-only: lists saved report definitions
  getProjectUsageReportJob, // Read-only: polls async report job status
  getProjectUsageReport,   // Read-only: returns project usage data for given fields
  getMacroFilters,         // Read-only: saved filters attached to the viewer's browsable projects
  getMacroDashboards,      // Read-only: dashboards attached to the viewer's browsable projects
  getMacroWorkflows,       // Read-only: workflow schemes + statuses for the viewer's browsable projects
  getMacroScreens,         // Read-only: the forms the viewer's projects route to
  getMacroIssueTypes,      // Read-only: issue type schemes governing the viewer's projects
  getMacroBoards,          // Read-only: agile boards living in the viewer's projects
};

// â”€â”€ Admin authorization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// The jira:adminPage module controls who can SEE the admin page. It does not control
// who can reach its resolver: an invoke() is an authenticated app endpoint, and module
// placement is a UI affordance, not an authorization boundary. Every function below
// therefore verifies the calling user holds Jira ADMINISTER before running.
//
// The check is applied by wrapping the registry rather than by calling a helper inside
// each function, so a function added to ADMIN_ONLY_FUNCTIONS is guarded by construction.
// Remembering to add a guard is exactly the kind of thing that gets forgotten once.

const ADMIN_CHECK_TTL_MS = 60 * 1000;
const adminCheckCache = new Map();

// Forge reuses warm invocations, so this cache survives across calls within one container
// and spares a Jira round trip per admin read -- getIssueScanStatus is polled every 15s
// for the length of a scan. The cost is that a revoked admin keeps access for up to 60s.
// Accepted, and recorded in SECURITY_CHECKLIST.md.
async function isCallerJiraAdmin(accountId) {
  if (!accountId) return false;
  const cached = adminCheckCache.get(accountId);
  if (cached && cached.expires > Date.now()) return cached.allowed;

  const allowed = await callerHasJiraAdmin(accountId);
  adminCheckCache.set(accountId, { allowed, expires: Date.now() + ADMIN_CHECK_TTL_MS });
  return allowed;
}

export function __resetAdminCheckCache() {
  adminCheckCache.clear();
}

// recordAuditEvent already swallows its own failures, but this layer must not depend on
// that: if writing the audit row ever did throw, an unguarded await here would turn a
// broken audit table into a total outage of every admin action -- and into a denial-of-
// service anyone able to break that table could trigger. Availability wins over
// completeness here; the loss is loud in the structured log rather than silent.
async function safeAudit(scopeKey, event) {
  try {
    await recordAuditEvent(scopeKey, event);
  } catch (error) {
    logger.error("audit.write_failed", { action: event?.action, error: error?.message || String(error) });
  }
}

export class AdminPermissionError extends Error {
  constructor() {
    super("This action requires Jira administrator permission.");
    this.name = "AdminPermissionError";
  }
}

function withAdminGuard(functions) {
  return Object.fromEntries(
    Object.entries(functions).map(([name, fn]) => [
      name,
      async (req) => {
        const accountId = req?.context?.accountId || null;
        if (!(await isCallerJiraAdmin(accountId))) {
          // Denials are audited: a burst of them is the signal that someone is probing
          // the resolver directly, which is the whole reason this guard exists.
          const installationKey = getInstallationKey(req?.context);
          await safeAudit(installationKey, {
            actorId: accountId,
            action: name,
            outcome: "denied",
            detail: "Caller does not hold Jira ADMINISTER permission",
          });
          logger.warn("auth.denied", { action: name, actorId: accountId });
          throw new AdminPermissionError();
        }
        return fn(req);
      },
    ])
  );
}

// Actions worth a permanent record: they mutate state, destroy data, or change the rules
// the governance engine runs by. Admin *reads* are not audited -- they are frequent
// (polled during scans) and recording them would bury the events that matter.
const AUDITED_ADMIN_ACTIONS = new Set([
  "startFullSiteScan",
  "startQuickSiteScan",
  "resumeSiteScan",
  "cancelSiteScan",
  "startIssueScan",
  "resumeIssueScan",
  "cancelIssueScan",
  "startDeltaIssueScan",
  "cancelSnapshot",
  "clearSnapshot",
  "cancelProjectUsageJob",
  "restartProjectUsageJob",
  "resumeProjectUsageJob",
  "restoreProjectUsageCache",
  "refreshRecentProjectUsage",
  "saveReportDefinition",
  "deleteReportDefinition",
  "saveAdminConfig",
  "migrateNamespaceKeys",
  "buildScreenInventory",
  "buildIssueTypeInventory",
  "buildUserInventory",
  "buildAssetInventory",
  "buildAccessInventory",
  "buildChangeHistory",
  "buildEstateInventory",
  "buildFieldConfigInventory",
  "buildBoardInventory",
  "createRemediationEpic",
  "syncRemediationNow",
]);

function withAuditTrail(functions) {
  return Object.fromEntries(
    Object.entries(functions).map(([name, fn]) => [
      name,
      !AUDITED_ADMIN_ACTIONS.has(name)
        ? fn
        : async (req) => {
            const accountId = req?.context?.accountId || null;
            const installationKey = getInstallationKey(req?.context);
            try {
              const result = await fn(req);
              await safeAudit(installationKey, {
                actorId: accountId,
                action: name,
                outcome: "allowed",
                // Resolvers signal a refusal by returning a shape rather than throwing
                // (clearSnapshot's confirmation mismatch, read-only mode), so carry that
                // through instead of recording a blocked action as a completed one.
                detail: result && result.error ? `Refused: ${result.error}` : null,
              });
              return result;
            } catch (error) {
              await safeAudit(installationKey, {
                actorId: accountId,
                action: name,
                outcome: "failed",
                detail: error?.message || String(error),
              });
              throw error;
            }
          },
    ])
  );
}

// Functions registered on adminHandler ONLY.
// Any function that mutates data, triggers background jobs, modifies config,
// or exposes governance internals must live here and nowhere else.
//
// Exported through withAdminGuard + withAuditTrail -- see above. Add new entries to the
// raw object; the wrapping is applied to the whole registry at export.
const RAW_ADMIN_ONLY_FUNCTIONS = {
  // Issue scan lifecycle â€” trigger and cancel full fieldÃ—issue scans
  startFullSiteScan,       // Mutating: queues the one scan that runs every pillar
  startQuickSiteScan,      // Mutating: queues the quick scan (full structural + delta issues)
  resumeSiteScan,          // Mutating: re-kicks a stalled full/quick scan orchestrator
  cancelSiteScan,          // Mutating: hard-stops a running full/quick scan, freeing the meta row
  getQuickScanStatus,      // Admin read: per-stage progress of the quick scan
  getFirstRunState,        // Admin read: the first-run checklist and the arrivals list
  setFirstRunState,        // Admin write: acknowledge a first-run step, or dismiss the panel
  getFullScanStatus,       // Admin read: per-stage progress of the full scan
  startIssueScan,          // Mutating: queues a full issue scan job
  resumeIssueScan,         // Mutating: re-queues incomplete issue scan workers
  cancelIssueScan,         // Mutating: hard-stops the running issue scan
  getIssueScanStatus,      // Admin read: exposes raw scan meta including progressLog

  // Delta issue scan â€” lightweight incremental scan
  startDeltaIssueScan,     // Mutating: queues a delta (incremental) issue scan job
  getDeltaIssueScanStatus, // Admin read: exposes delta scan meta

  // Snapshot lifecycle
  cancelSnapshot,          // Mutating: cancels in-progress snapshot build
  clearSnapshot,           // Mutating: irreversibly deletes all derived snapshot data

  // Automation rule analysis
  getAutomationInsights,   // Admin read: enumerates rule names, project scope and outbound hosts
  getAutomationIndex,      // Admin read: field / status reference index and the rule directory
  getAutomationFieldUsage, // Admin read: the automation rules that touch one field
  getAutomationFieldCounts, // Admin read: enabled/disabled rule counts for a page of fields
  saveAutomationAnalysis,  // Mutating: replaces the stored automation analysis document
  saveAutomationIndex,     // Mutating: replaces one supporting index document

  // Project usage job management
  getProjectUsageJobs,     // Admin read: lists all field-level project-usage jobs with logs
  cancelProjectUsageJob,   // Mutating: cancels a running project-usage job
  restartProjectUsageJob,  // Mutating: wipes and re-queues a project-usage job from scratch
  resumeProjectUsageJob,   // Mutating: resumes a paused/failed project-usage job
  refreshRecentProjectUsage, // Mutating: triggers incremental refresh based on recent issue changes
  restoreProjectUsageCache,  // Mutating: queues full restoration of project-usage from summaries

  // Report management â€” write operations on stored report definitions and async jobs
  saveReportDefinition,    // Mutating: creates or updates a saved report definition
  deleteReportDefinition,  // Mutating: deletes a saved report definition
  startProjectUsageReportJob, // Mutating: triggers an async project-usage report build job

  // RQT (required-query-token) index â€” internal governance analytics
  getRqtIndex,             // Admin read: returns RQT field index and issue sample data
  searchRqtValue,          // Admin read: looks up issues by RQT value token

  // Audit trail
  // Screen and scheme inventory
  getScreenInventory,      // Admin read: screens, tabs, schemes and their mappings
  getFieldScreenCounts,    // Admin read: screen counts for a page of fields
  getFieldScreenReachability, // Admin read: which screens carry one field
  buildScreenInventory,    // Mutating: queues a full screen and scheme snapshot build

  // Issue type inventory
  getIssueTypeInventory,   // Admin read: issue types by hierarchy, schemes and their routing
  buildIssueTypeInventory, // Mutating: queues a full issue type and scheme snapshot build

  // People pillar
  getUserInventory,        // Admin read: the licensed-user roster with products, access groups and ownership counts
  getUserDetails,          // Admin read: one user's owned filters / dashboards / automation rules
  buildUserInventory,      // Mutating: queues a licensed-user roster build

  // JSM Assets (CMDB) pillar
  getAssetInventory,       // Admin read: object schemas, their object types and attributes, with the governance summary
  buildAssetInventory,     // Mutating: queues a JSM Assets structure snapshot build
  buildAssetTypeCountCrawl, // Mutating: queues the opt-in per-object-type AQL count crawl

  // Access pillar (permission / issue-security / notification schemes)
  getAccessInventory,      // Admin read: the scheme types + project roles, their holders and project assignments, with governance
  buildAccessInventory,    // Mutating: queues an access scheme snapshot build
  probeGlobalPermissions,  // Admin read: whether the REST API exposes global-permission grants on this site

  // Configuration drift (the change-history timeline)
  getChangeHistory,        // Admin read: one page of detected config changes + a trailing-window summary
  buildChangeHistory,      // Mutating: queues a standalone drift pass

  // Estate config (the global value lists — resolutions, priorities)
  getEstateInventory,      // Admin read: the resolution and priority lists with the duplicate-name governance summary
  buildEstateInventory,    // Mutating: queues an estate-config snapshot build

  // Boards pillar (agile boards, their backing filters and column mapping)
  getBoardInventory,       // Admin read: every board with its filter, location and columns (structure only for now)
  buildBoardInventory,     // Mutating: queues a board snapshot build

  getAutomationCascades,   // Admin read: one filtered page of cascade relationships
  getCascadeGraph,         // Admin read: loops and multi-rule chains across every edge
  getAutomationBlast,      // Admin read: one page of rules ordered by blast radius
  getRemediationTickets,   // Admin read: remediation epics and tasks, grouped by finding
  getRemediationMetrics,   // Admin read: remediation burn-down, throughput and ageing
  createRemediationEpic,   // Mutating: creates a Jira epic + tasks for a governance finding
  syncRemediationNow,      // Mutating: queues a remediation status sync from Jira
  getRemediationCandidates,// Admin read: current items behind one finding, ready to ticket
  getStatusAutomationUsage,// Admin read: which rules reference one status, by direction
  getWorkflowRuleUsage,    // Admin read: workflow rules and properties pointing at one field, group, role...
  getWorkflowRules,        // Admin read: one page of transition conditions, validators and post-functions
  getWorkflowRestrictions, // Admin read: what each status locks down (edit, comment...) and to whom
  getWorkflowRuleInsights, // Admin read: workflow inventory, broken rule references, inactive workflows
  getFieldConfigInventory, // Admin read: field schemes / configurations, their projects and findings
  getFieldConfigItems,     // Admin read: one scheme's or configuration's fields, paged
  getFieldBehaviour,       // Admin read: what every scheme or configuration does to one field
  buildFieldConfigInventory, // Mutating: queues a field scheme / configuration build
  getStatusDetail,         // Admin read: one status -- schemes, workflows, transitions, restrictions, deletion verdict
  getDashboardInventory,   // Admin read: dashboards, their gadgets and their findings
  buildDashboardInventory, // Mutating: queues a rebuild of the dashboard snapshot
  getFilterInventory,      // Admin read: saved filters, their findings and their references
  buildFilterInventory,    // Mutating: queues a rebuild of the saved filter snapshot
  getFilterUsage,
  getDashboardUsage,       // Admin read: which dashboards reach a field, via which gadget
  getFieldFilterCounts,    // Admin read: saved-filter counts for a page of fields
  getFieldDashboardCounts, // Admin read: dashboard-gadget counts for a page of fields
  getHealthHistory,        // Admin read: the site health series and per-dimension deltas
  getPillarHealth,         // Admin read: one pillar of the score, for the tab it is about
  getPillarReport,         // Admin read: one pillar's inventory as a normalized, exportable report
  runOqlQuery,             // Admin read: an OQL query across every pillar's inventory
  getProjectOverview,      // Admin read: every pillar that touches one project
  getDeletionSafety,            // Admin read: every pillar's evidence about deleting a field
  getScreenFieldCrossSignal,    // Admin read: screen reachability crossed with field usage
  getScreenFieldReportInputs,   // Admin read: field union + project scope for a set of screens
  getProjectScreenReportInputs, // Admin read: a project's screens grouped by screen scheme
  getAuditLog,             // Admin read: returns recent privileged-action records

  // Admin page surface. These were previously registered directly onto adminHandler in
  // index.js, which meant they sat outside this registry and therefore outside its
  // guard -- saveAdminConfig, which rewrites governance thresholds AND the macro access
  // group list, was reachable by any caller who could invoke it. Registered here so the
  // guard covers them like everything else.
  getAdminConfig: getAdminConfigResolver,      // Admin read: returns full admin config
  saveAdminConfig: saveAdminConfigResolver,    // Mutating: rewrites thresholds and access control
  getAdminOverview,                            // Admin read: dashboard aggregate
  probeAutomationApi,                          // Admin read: reports which Jira endpoints answer, for diagnosis
  probeAssetsApi,                              // Admin read: confirms the JSM Assets API and workspace on this site
  probeScreenFetchCost,                        // Admin read: samples the cost of a full screen inventory pass
  migrateNamespaceKeys,                        // Mutating: rewrites scope keys across every table
};

// Order matters: the guard runs first, so an unauthorized caller is recorded as `denied`
// and never reaches the action, rather than producing both a denial and a failed action.
export const ADMIN_ONLY_FUNCTIONS = withAdminGuard(withAuditTrail(RAW_ADMIN_ONLY_FUNCTIONS));

// Unwrapped originals, for tests that need to exercise a resolver's own logic without
// standing up a permission mock. Never register these on a handler.
export const __RAW_ADMIN_ONLY_FUNCTIONS = RAW_ADMIN_ONLY_FUNCTIONS;

