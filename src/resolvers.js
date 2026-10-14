import { route } from "@forge/api";
import { kvs } from "@forge/kvs";
import {
  incrMetric,
  METRIC_NAMES,
  makeJobToken,
  getInstallationKey,
  mapWithConcurrency,
  getFieldProjectAssociations,
  jiraRequest,
  getDistinctIssueCountForFields,
  getLiveFieldProjectUsage,
  collectRecentFieldProjectCandidates,
  PROJECT_USAGE_PAGE_SIZE,
  PROJECTS_VIEW_PAGE_SIZE,
  MAX_ACTIVE_PROJECT_USAGE_JOBS,
  MAX_AUTOQUEUED_REPORT_FIELDS,
  MAX_AUTOQUEUED_REPORT_ISSUE_BUDGET,
  ISSUE_SCAN_PAGE_SIZE,
  ISSUE_SCAN_WORKERS,
  getBrowsableProjectIds,
  createJiraIssue,
  updateJiraIssue,
  searchIssuesPage,
} from "./lib/jira-api.js";
import { queueIssueScanWorker, completeIssueScanFinalization } from "./lib/scan-engine.js";
import { pillarUnavailable, agentOk, agentNotFound, rankMatches, clampResults } from "./lib/rovo-agents.js";
import {
  hydrateFieldForGovernance,
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
  listAuditEvents,
  loadSnapshotFields,
  loadSnapshotField,
  loadAllSnapshotProjectUsage,
  loadAnySnapshotProjectUsage,
  listSnapshotProjects,
  loadProjectActivity,
  loadFilters,
  readFilterSnapshotMeta,
  loadFilterReferencesFor,
  loadFilterReferenceCounts,
  loadDashboards,
  readDashboardSnapshotMeta,
  loadSnapshotProjectFields,
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
  countOldScopeKeyRows,
  migrateOldScopeKeys,
  upsertProjectTotalsForDelta,
  upsertDeltaFieldProjectUsage,
  upsertRqtFieldHits,
  upsertRqtIssueKeys,
  upsertRqtValueIssueKeys,
  upsertRqtFieldIssueKeys,
  loadRqtFieldIndex,
  readWorkflowSnapshotMeta,
  loadTransitionsTouchingStatus,
  transitionAwareWorkflowVersion,
  readRecentFullScanRuns,
  loadWorkflowSchemes,
  loadWorkflowSchemeProjects,
  loadWorkflowSchemeForProject,
  loadStatusesCatalog,
  loadWorkflowSchemeStatuses,
  loadStatusIssueCounts,
  loadStatusHistoryCounts,
  readScreenSnapshotMeta,
  loadScreensForField,
  loadScreenSchemes,
  loadScreenSchemeOperations,
  loadItssMappings,
  loadItssProjects,
  readScreenCrossSummary,
  loadScreensForProject,
  readIssueTypeSnapshotMeta,
  loadIssueTypes,
  loadIssueTypeSchemeItems,
  readUserSnapshotMeta,
  loadUsers,
  readAccessSnapshotMeta,
  loadProjectSchemes,
  loadProjectRoleActors,
  readDriftSnapshotMeta,
  loadConfigChanges,
  changeCursorOf,
  readBoardSnapshotMeta,
  loadBoards,
  loadBoardColumns,
  recordHealthSnapshot,
  loadPriorHealthDimensions,
  readFullScanMeta,
  loadHealthHistory,
  recordRemediationTicket,
  loadRemediationTickets,
  getRemediationEpic,
  loadTicketedItemIds,
  loadTicketedItems,
  loadHierarchyNodes,
  recordHierarchyNode,
  currentPeriod,
  readUsageMeta,
  loadUsageTally,
  loadArchivedProjects,
  loadArchivedFieldUsage,
  USAGE_PILLARS,
  USAGE_WINDOW_DAYS,
} from "./lib/project-store.js";
import { getPlaybook, groupBounded, listPlaybookCatalog, REMEDIATION_FINDING_INDEX } from "./lib/remediation-playbooks.js";
import { ensureInitiativeFor, ROOT_NODE } from "./lib/remediation-hierarchy.js";
import { computeRemediationMetrics } from "./lib/remediation-metrics.js";
import { queueRemediationSync } from "./lib/remediation-sync.js";
import { renderADF } from "./lib/adf.js";
import { queueWorkflowSnapshotBuild, isWorkflowBuildStale, queueStatusHistoryBuild } from "./lib/workflow-engine.js";
import { getWorkflowRuleUsage, getWorkflowRules, getWorkflowRestrictions, getWorkflowRuleInsights, loadFieldWorkflowEvidence } from "./lib/workflow-rule-reads.js";
import { getFieldConfigInventory, getFieldConfigItems, getFieldBehaviour } from "./lib/fieldconfig-reads.js";
import { summarizeBoardInsights } from "./lib/board-insights.js";
import { buildPillarReport, unavailableReport, isPillarReportKey, countScreenProjects, REPORT_ROW_LIMIT } from "./lib/pillar-reports.js";
import { parseOql, evaluate as evaluateOql, sortEntities as sortOqlEntities, pinnedPillars } from "./lib/oql.js";
import { buildOqlCatalog, buildEntityIndex, OQL_PILLARS, CHURN_WINDOW_DAYS } from "./lib/oql-index.js";
import { summarizeEstateInsights } from "./lib/estate-insights.js";
import { summarizeIssueTypeInsights } from "./lib/issuetype-insights.js";
import { summarizeAssetInsights } from "./lib/asset-insights.js";
import { computeSiteHealth } from "./lib/health-score.js";
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
import { summarizeAdoption } from "./lib/project-adoption.js";
import { summarizeFilters } from "./lib/filter-insights.js";
import { summarizeDashboards } from "./lib/dashboard-insights.js";
import { startFullScan, fullScanStageCatalog, startQuickScan, quickScanStageCatalog, recoverStalledScan, resumeScanRun, cancelScan, readStageProducedCounts } from "./lib/full-scan-runner.js";
import { FULL_SCAN_STALL_MS, MAX_SCAN_TOTAL_MS } from "./lib/full-scan.js";
import { getSiteBaseUrl, normalizeSiteOrigin } from "./lib/jira-api.js";
import {
  findDuplicateStatusGroups,
  findOrphanedStatuses,
  computeSchemeCategoryBalance,
  summarizeWorkflowInsights,
} from "./lib/workflow-insights.js";
import { assessFieldDeletion, assessStatusDeletion, summarizeDeletionSafety } from "./lib/deletion-safety.js";
import { activeRosterIds, buildOwnershipIndex } from "./lib/user-ownership.js";
import {
  hydrateRuleDirectory,
  assessAutomationEvidence,
} from "./lib/automation-analysis.js";
import {
  readAutomationAnalysis,
  readAutomationPart,
  loadRulesForProject,
  loadStatusAutomationReferences,
  loadGlobalRulesAffectingProject,
} from "./lib/store/automation.js";
import {
  STRUCTURAL_SYSTEM_FIELDS,
  isFieldValueNonEmpty,
  collectIssueRqtValues,
  summarizeProjectUsageCapacity,
  normalizeFieldName,
  buildDuplicateNameCountMap,
  isJiraBuiltinField,
  filterInventoryFields,
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
} from "./lib/validate.js";
import {
  ADMIN_CONFIG_KEY,
  DEFAULT_FIRST_RUN,
  readAdminConfig,
  getAdminConfigResolver,
  saveAdminConfigResolver,
} from "./resolvers/admin-config.js";
import {
  callerAccountId,
  browsableOrAll,
  viewerProjects,
} from "./resolvers/viewer.js";
import { withAdminGuard, withAuditTrail } from "./resolvers/admin-guard.js";
import { probeServiceManagementApi } from "./resolvers/jsm.js";
import { checkMacroAccess } from "./resolvers/macro-access.js";
import { getIssueTypeInventory, buildIssueTypeInventory } from "./resolvers/issue-types.js";
import {
  getUserInventory,
  getUserDetails,
  collectRuleUserReferences,
  buildUserInventory,
} from "./resolvers/people.js";
import {
  getAccessInventory,
  buildAccessInventory,
  probeGlobalPermissions,
  loadActiveRoster,
} from "./resolvers/access.js";
import {
  getAssetInventory,
  buildAssetInventory,
  buildAssetTypeCountCrawl,
  probeAssetsApi,
} from "./resolvers/assets.js";
import { getBoardInventory, buildBoardInventory } from "./resolvers/boards.js";
import { CHANGE_WINDOW_DAYS, getChangeHistory, buildChangeHistory } from "./resolvers/changes.js";
import { getEstateInventory, buildEstateInventory } from "./resolvers/estate.js";
import { getRqtIndex, searchRqtValue } from "./resolvers/rqt.js";
import {
  getMacroFilters,
  getMacroDashboards,
  getMacroScreens,
  getMacroIssueTypes,
  getMacroBoards,
  getMacroWorkflows,
} from "./resolvers/macro.js";
import {
  loadFiltersWithFindings,
  getFilterInventory,
  buildFilterInventory,
  getFieldFilterCounts,
  getFieldDashboardCounts,
  getDashboardUsage,
  getFilterUsage,
  getDashboardInventory,
  buildDashboardInventory,
} from "./resolvers/filters-dashboards.js";
import {
  getScreenInventory,
  getFieldScreenCounts,
  getFieldScreenReachability,
  buildScreenInventory,
  probeScreenFetchCost,
  getScreenFieldCrossSignal,
  computeAndStoreScreenCross,
  getScreenFieldReportInputs,
  getProjectScreenReportInputs,
  loadAllScreenPages,
} from "./resolvers/screens.js";
import {
  getAutomationInsights,
  saveAutomationAnalysis,
  saveAutomationIndex,
  getAutomationCascades,
  getCascadeGraph,
  getAutomationBlast,
  getStatusAutomationUsage,
  getAutomationIndex,
  getAutomationFieldUsage,
  getAutomationFieldCounts,
  probeAutomationApi,
  loadAutomationForAgent,
  ruleDirectoryMap,
} from "./resolvers/automation.js";
import {
  getFieldInventory,
  buildFieldConfigInventory,
  getFieldDetails,
  getFilteredFieldIds,
  searchFieldOptions,
  getFieldOptions,
} from "./resolvers/fields.js";
export { getScreenFieldCrossSignal, computeAndStoreScreenCross } from "./resolvers/screens.js";
export { __clearMacroAccessCache, MacroAccessError, withMacroAccessGuard } from "./resolvers/macro-access.js";
export { __resetAdminCheckCache, AdminPermissionError } from "./resolvers/admin-guard.js";
export { readAdminConfig, getAdminConfigResolver, saveAdminConfigResolver } from "./resolvers/admin-config.js";

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
// The count cap alone is not enough: a Forge resolver is killed at ~25s, and on a slow site
// one issue create plus its row write takes ~3-4s, so 20 never fit -- the invocation died
// around task 7, the UI got no itemsRemaining back and stopped, and a create cut off mid-flight
// could land in Jira unrecorded. No new task starts once this much of the invocation has
// gone; the UI chains the next batch off itemsRemaining.
const REMEDIATION_TIME_BUDGET_MS = 15000;

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
      // Every quarter's work, not just the latest: a task still open under last quarter's
      // epic is open work on this finding, and the tab lists and counts it.
      allTaskCount: periods.reduce((n, p) => n + p.tasks.length, 0),
      allOpenCount: periods.reduce((n, p) => n + openOf(p.tasks), 0),
      previousPeriods: periods.slice(1).map((p) => ({
        period: p.period,
        epicKey: p.epic?.issueKey ?? null,
        epicStatusCategory: p.epic?.lastStatusCategory ?? null,
        taskCount: p.tasks.length,
        openCount: openOf(p.tasks),
        tasks: p.tasks,
      })),
    };
  });

  // The latest time the sync reached any ticket. Null means it never has, which the tab says in
  // those words rather than implying the tickets were checked and found untouched.
  const lastSyncedAt = tickets.reduce((latest, t) => (t.syncedAt && (!latest || t.syncedAt > latest) ? t.syncedAt : latest), null);

  // The catalog and the finding index travel with the tickets, so neither the Remediation tab
  // nor the Overview keeps its own copy of which playbooks exist or which finding each covers.
  // The quarter's hierarchy, when it is on: whether it is set up and where its top item is.
  const rc = (await readAdminConfig().catch(() => ({})))?.remediation || {};
  let hierarchy = null;
  if (rc.hierarchyEnabled) {
    const nodes = await loadHierarchyNodes(installationKey, period)
      .catch(fallbackOn("remediation.hierarchy_read_failed", () => new Map(), { installationKey }));
    hierarchy = {
      enabled: true,
      rootKey: nodes.get(ROOT_NODE)?.issueKey || null,
      initiativeCount: [...nodes.keys()].filter((k) => k.startsWith("initiative:")).length,
    };
  }

  return {
    available: tickets.length > 0,
    total: tickets.length,
    lastSyncedAt,
    period,
    hierarchy,
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

// Usage per item for one pillar: how many issues, how many in the last 90 days, and when last,
// counted by the issue crawl (store/usage.js). Tri-state like everything else -- no complete
// crawl yet is "not measured", never a table of zeros -- and `basis` travels with the numbers
// so the tab labels them from the same rule that counted them.
async function getPillarUsage({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  const pillar = String(payload?.pillar || "");
  const spec = USAGE_PILLARS[pillar];
  if (!spec) return { available: false, reason: "unknown-pillar", pillar, items: {} };
  const base = { pillar, basis: spec.basis, windowDays: USAGE_WINDOW_DAYS };
  const meta = await readUsageMeta(installationKey)
    .catch(fallbackOn("usage.meta_read_failed", () => null, { installationKey }));
  if (!meta) return { ...base, available: false, reason: "no-crawl", items: {} };
  const tally = await loadUsageTally(installationKey, pillar);
  return {
    ...base,
    available: true,
    windowDays: meta.windowDays || USAGE_WINDOW_DAYS,
    measuredAt: meta.measuredAt,
    items: Object.fromEntries(tally),
  };
}

// "Sync now": queues the same job the scheduled trigger queues, run by the queue consumer,
// which has the time a few thousand tickets need and a resolver does not. It reads Jira and writes only
// Observatory's own rows, so it is not behind the read-only-mode gate -- the scheduled sync
// is not either.
async function syncRemediationNow({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  return queueRemediationSync(getInstallationKey(context));
}

// What ensureInitiativeFor needs, bound to this site and quarter.
async function hierarchyDeps(installationKey, period) {
  return {
    nodes: await loadHierarchyNodes(installationKey, period),
    existing: new Map(),
    searchIssuesPage,
    createJiraIssue,
    recordHierarchyNode,
  };
}

// "Organise under initiatives": puts this quarter's epics under their pillar's initiative,
// creating or adopting the quarter's Product and Initiatives as needed. Only epics whose parent
// is not already the right initiative are edited. Time-budgeted like the task create, with the
// rest handed back as `remaining` for the tab to ask for again.
async function organiseRemediationHierarchy({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  const startedAt = Date.now();
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) return { error: "Read-only mode is enabled. Disable it before changing remediation tickets." };
  const rc = adminConfig.remediation || {};
  if (!rc.projectKey) return { error: "No remediation project is configured. Set one in Configuration → Remediation first." };
  if (!rc.hierarchyEnabled) return { error: "The remediation hierarchy is off. Turn it on in Configuration → Remediation first." };
  const accountId = callerAccountId(context);
  if (!accountId) return { error: "Could not identify the calling user." };

  const period = currentPeriod();
  const epics = (await loadRemediationTickets(installationKey)).filter((t) => t.isEpic && t.period === period);
  if (!epics.length) return { ok: true, period, organised: 0, alreadyPlaced: 0, remaining: 0, failures: [] };

  // Each epic's current parent, in one search.
  const keys = epics.map((e) => e.issueKey);
  const current = await searchIssuesPage(`issuekey in (${keys.join(", ")})`, ["parent"], Math.min(keys.length, 100));
  const parentOf = new Map(current.map((i) => [i.key, i.fields?.parent?.key || null]));

  const deps = await hierarchyDeps(installationKey, period);
  let organised = 0;
  let alreadyPlaced = 0;
  let attempted = 0;
  const failures = [];
  for (const epic of epics) {
    if (attempted > 0 && Date.now() - startedAt > REMEDIATION_TIME_BUDGET_MS) break;
    attempted += 1;
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential: nodes are created once and reused
      const { initiativeKey } = await ensureInitiativeFor(
        { scopeKey: installationKey, period, pillar: epic.pillar, config: rc, projectKey: rc.projectKey, accountId }, deps,
      );
      if (parentOf.get(epic.issueKey) === initiativeKey) { alreadyPlaced += 1; continue; }
      // eslint-disable-next-line no-await-in-loop
      await updateJiraIssue(epic.issueKey, { parent: { key: initiativeKey } }, { asUser: true });
      organised += 1;
    } catch (error) {
      failures.push({ epicKey: epic.issueKey, error: String(error?.message || error) });
    }
  }
  logger.info("remediation.hierarchy_organised", { installationKey, period, organised, alreadyPlaced, failures: failures.length });
  return {
    ok: true, period, organised, alreadyPlaced,
    rootKey: deps.nodes.get(ROOT_NODE)?.issueKey || null,
    remaining: Math.max(0, epics.length - attempted),
    failures,
  };
}

async function createRemediationEpic({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  const startedAt = Date.now();
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
    // The quarter's Product and this pillar's Initiative first, when the hierarchy is on: the
    // first epic of a quarter brings them with it (found and adopted if they already exist).
    let initiativeKey = null;
    if (rc.hierarchyEnabled) {
      try {
        ({ initiativeKey } = await ensureInitiativeFor(
          { scopeKey: installationKey, period, pillar, config: rc, projectKey: rc.projectKey, accountId },
          await hierarchyDeps(installationKey, period),
        ));
      } catch (error) {
        return { error: `Placing the epic under its initiative failed: ${error?.message || error}. Check the Product and Initiative issue types in Configuration → Remediation, or turn the hierarchy off.` };
      }
    }
    try {
      const fields = {
        project: { key: rc.projectKey },
        issuetype: { name: rc.epicIssueType || "Epic" },
        summary: `${period}: ${playbook.epicSummary(items.length)}`.slice(0, 250),
        description: renderADF(playbook.epicDescription({ count: items.length, origin })),
        labels: playbook.labels,
        reporter: { id: accountId },
        ...(initiativeKey ? { parent: { key: initiativeKey } } : {}),
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
  let attempted = 0;
  const failures = [];
  for (const it of batch) {
    // Always attempt at least one, so a slow epic create cannot stall the chain at zero.
    if (attempted > 0 && Date.now() - startedAt > REMEDIATION_TIME_BUDGET_MS) break;
    attempted += 1;
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
    itemsRemaining: Math.max(0, todo.length - attempted),
    failures,
  };
}

// The current items behind one remediation finding -- what "Create remediation" actually
// tickets. Every branch here re-reads the same snapshot rows the finding's own tab already
// loads (getUserInventory's roster, getBoardInventory's insights, getWorkflowInsights'
// orphans, getFieldInventory's governance findings) rather than re-deriving the join, so a
// finding and its remediation candidates can never disagree about what is currently flagged.
//
// Each item comes back marked with the open ticket that already holds it, if any -- decided by
// loadTicketedItems, the same rule createRemediationEpic skips by. The tab used to work that
// out itself from the current quarter's tasks only, so after a quarter rolled over it offered
// to ticket items still open under last quarter's epic, and the button "ran" and created
// nothing: the server skipped every one.
async function getRemediationCandidates({ payload, context }) {
  const result = await loadRemediationCandidates({ payload, context });
  if (!result?.items?.length) return result;
  const installationKey = getInstallationKey(context);
  const findingKey = String(payload?.findingKey || "");
  const ticketed = await loadTicketedItems(installationKey, findingKey, currentPeriod())
    .catch(fallbackOn("remediation.candidates_ticketed_failed", () => null, { installationKey, findingKey }));
  if (!ticketed) return result;
  return {
    ...result,
    items: result.items.map((it) => {
      const t = ticketed.get(String(it.id ?? it.name));
      return t ? { ...it, ticketed: t } : it;
    }),
  };
}

async function loadRemediationCandidates({ payload, context }) {
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
  const dashboards = await loadDashboards(installationKey, meta.version);
  // Broken gadgets are only known for gadgets whose filter was probed. A snapshot built before
  // the probe existed has filter gadgets with no state at all, and an empty list from it is
  // "not checked", not "clean". (A site with no filter gadgets is genuinely clean.)
  if (code === "broken-gadget") {
    const filterGadgets = dashboards.flatMap((d) => d.gadgets || []).filter((g) => g.filterId);
    if (filterGadgets.length && !filterGadgets.some((g) => g.filterState)) {
      return { available: false, reason: "not-probed", items: [] };
    }
  }
  const summary = summarizeDashboards(dashboards);
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

// What archived projects say about each field, for assessFieldDeletion: the values counted in
// a project before it was archived (`held`), and archived projects the field is configured in
// whose values were never counted (`unknown`). Archived issues are invisible to Jira's search,
// so this is the only evidence there is. Reach is read live per field -- a global context
// reaches every archived project; otherwise the field's project associations decide.
async function archivedEvidenceForFields(installationKey, fieldIds) {
  const list = await loadArchivedProjects(installationKey);
  const out = new Map();
  if (!list || !list.available) {
    const reason = !list
      ? "Archived projects have not been checked yet. They are read at the end of each full scan."
      : `The list of archived projects could not be read (${list.error || "refused"}), so values hidden in them cannot be ruled out.`;
    for (const id of fieldIds) out.set(id, { available: false, reason });
    return out;
  }
  if (!list.projects.length) {
    for (const id of fieldIds) out.set(id, { available: true, held: [], unknown: [] });
    return out;
  }
  const archivedIds = new Map(list.projects.map((p) => [p.id, p]));
  const usage = await loadArchivedFieldUsage(installationKey, fieldIds);
  await mapWithConcurrency(fieldIds, 4, async (fieldId) => {
    const held = (usage.get(fieldId) || []).filter((r) => archivedIds.has(r.projectId));
    const heldIds = new Set(held.map((r) => r.projectId));
    let reach = [];
    let reachUnknown = false;
    try {
      // A missing summary only means "global context unknown"; the associations still answer.
      let summary = null;
      try { summary = await loadFieldSummary(installationKey, fieldId); } catch { summary = null; }
      if (summary?.hasGlobalContext) {
        reach = list.projects;
      } else {
        const associated = await getFieldProjectAssociations(fieldId);
        reach = associated.map((a) => archivedIds.get(String(a.id))).filter(Boolean);
      }
    } catch {
      reachUnknown = true;
    }
    // An archived project Jira reports as holding no issues cannot hide any values.
    const unknown = reach
      .filter((p) => !heldIds.has(p.id) && p.issueCount !== 0)
      .map((p) => ({ projectKey: p.key, issueCount: p.issueCount }));
    out.set(fieldId, { available: true, held, unknown, reachUnknown });
  });
  return out;
}

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

  const archivedById = await archivedEvidenceForFields(installationKey, fieldIds)
    .catch(fallbackOn("deletion_safety.archived_failed", () => null, { installationKey }));

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
      archived: archivedById
        ? archivedById.get(fieldId) || null
        : { available: false, reason: "Archived projects could not be checked for this field." },
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
  getPillarUsage,          // Admin read: issues, last 90 days and last used, per item of one pillar
  createRemediationEpic,   // Mutating: creates a Jira epic + tasks for a governance finding
  organiseRemediationHierarchy, // Mutating: puts this quarter's epics under their pillar initiatives
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
  probeServiceManagementApi,                   // Admin read: what the JSM API answers, per JSM pillar and build stage
  probeScreenFetchCost,                        // Admin read: samples the cost of a full screen inventory pass
  migrateNamespaceKeys,                        // Mutating: rewrites scope keys across every table
};

// Order matters: the guard runs first, so an unauthorized caller is recorded as `denied`
// and never reaches the action, rather than producing both a denial and a failed action.
export const ADMIN_ONLY_FUNCTIONS = withAdminGuard(withAuditTrail(RAW_ADMIN_ONLY_FUNCTIONS));

// Unwrapped originals, for tests that need to exercise a resolver's own logic without
// standing up a permission mock. Never register these on a handler.
export const __RAW_ADMIN_ONLY_FUNCTIONS = RAW_ADMIN_ONLY_FUNCTIONS;

