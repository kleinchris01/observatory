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
} from "./lib/jira-api.js";
import { queueIssueScanWorker, completeIssueScanFinalization } from "./lib/scan-engine.js";
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
  loadWorkflowSchemes,
  loadWorkflowSchemeProjects,
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
  loadScreenGovernanceSummary,
  loadScreenCountsForFields,
  loadScreenDistributions,
  loadScreensForProject,
  DEFAULT_SCREEN_SORT,
  SCREEN_SORT_KEYS,
  recordHealthSnapshot,
  readFullScanMeta,
  loadHealthHistory,
  loadTransitionScreens,
} from "./lib/project-store.js";
import { queueWorkflowSnapshotBuild, isWorkflowBuildStale, queueStatusHistoryBuild } from "./lib/workflow-engine.js";
import { measureScreenFetchCost, probeScreenEndpoints, DEFAULT_SAMPLE_SIZE } from "./lib/screen-probe.js";
import { queueScreenSnapshotBuild, isScreenBuildStale } from "./lib/screen-engine.js";
import { computeSiteHealth, DEFAULT_HEALTH_TOLERANCES } from "./lib/health-score.js";
// Moved out of this file so a scan can record a measurement without importing the
// resolver layer. Same implementation, both callers.
import {
  buildFieldUsageInsights,
  buildProjectInsights,
  buildWorkflowOverview,
  buildScreenOverview,
  buildFilterOverview,
  buildDashboardOverview,
  attachUniqueIssueCounts,
} from "./lib/site-health.js";
import { summarizeAdoption, computeProjectAdoption } from "./lib/project-adoption.js";
import { summarizeFilters, summarizeFilterHealth } from "./lib/filter-insights.js";
import { summarizeDashboards, summarizeDashboardHealth } from "./lib/dashboard-insights.js";
import { isFilterBuildStale, queueFilterSnapshotBuild } from "./lib/filter-engine.js";
import { filterRows, sortFilters, filterFindingCounts, FILTER_SORTS } from "./lib/filter-query.js";
import { isDashboardBuildStale, queueDashboardSnapshotBuild } from "./lib/dashboard-engine.js";
import { startFullScan, fullScanStageCatalog, startQuickScan, quickScanStageCatalog, recoverStalledScan, cancelScan } from "./lib/full-scan-runner.js";
import { probeEndpoint, probeStargateEndpoint, getCloudId, getAllJiraProjects } from "./lib/jira-api.js";
import {
  findDuplicateStatusGroups,
  findOrphanedStatuses,
  computeSchemeCategoryBalance,
  summarizeWorkflowInsights,
} from "./lib/workflow-insights.js";
import { analyzeCascadeGraph, MAX_CHAIN_DEPTH } from "./lib/cascade-graph.js";
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
  loadCascadeSummary,
  loadCascades,
  loadCascadeEdges,
  loadRuleDirectoryFor,
  loadAutomationReferencesFor,
  AUTOMATION_PARTS,
  MAX_PREVIEW_FINDINGS,
  MAX_STORED_CASCADES,
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
const DEFAULT_QUICK_SCAN_SCHEDULE = {
  enabled: false,
  frequency: "weekly",
  dayOfWeek: 0,
  hourUtc: 0,
  windowHours: 168,
  lastScheduledRunAt: null,
};

const DEFAULT_ADMIN_CONFIG = {
  readOnlyMode: false,
  apiConcurrency: BASE_JIRA_CONCURRENCY,
  autoSnapshotEnabled: false,
  autoSnapshotFrequency: "weekly",
  governanceThresholds: DEFAULT_GOVERNANCE_THRESHOLDS,
  macroAccess: DEFAULT_MACRO_ACCESS,
  quickScanSchedule: DEFAULT_QUICK_SCAN_SCHEDULE,
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
    macroAccess: {
      ...current.macroAccess,
      ...(payload?.macroAccess || {}),
    },
    quickScanSchedule: {
      ...current.quickScanSchedule,
      ...(payload?.quickScanSchedule || {}),
    },
  };
  updated.apiConcurrency = Math.max(1, Math.min(10, Number(updated.apiConcurrency) || BASE_JIRA_CONCURRENCY));
  await kvs.set(ADMIN_CONFIG_KEY, updated);
  return { ok: true, config: updated };
}

async function checkMacroAccess({ context }) {
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

    const resp = await api.asApp().requestJira(
      route`/rest/api/3/user/groups?accountId=${accountId}`,
      { headers: { Accept: "application/json" } }
    );

    if (!resp.ok) {
      console.error("checkMacroAccess: group lookup failed", resp.status);
      return { allowed: true }; // fail open â€” don't block on API error
    }

    const userGroups = await resp.json();
    const userGroupNames = Array.isArray(userGroups) ? userGroups.map((g) => g.name) : [];
    const hasAccess = groups.some((g) => userGroupNames.includes(g));

    return hasAccess
      ? { allowed: true }
      : {
          allowed: false,
          reason: "You don't have permission to view this Observatory. Contact your Jira administrator to request access.",
        };
  } catch (err) {
    console.error("checkMacroAccess error:", err);
    return { allowed: true }; // fail open
  }
}

// ----- Inventory UI helpers -----

const OPTION_SEARCH_FIELD_BATCH_SIZE = 10;

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

    const [schemes, statuses, schemeStatuses] = await Promise.all([
      loadWorkflowSchemes(installationKey, meta.version),
      loadStatusesCatalog(installationKey, meta.version),
      loadWorkflowSchemeStatuses(installationKey, meta.version),
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

    const orphans = schemeStatusesAvailable
      ? findOrphanedStatuses(statuses, schemeStatuses, hasIssueCounts ? issueCounts : null, automationByStatus)
      : [];
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
      workflowVersion: workflowMeta?.version || null,
    }),
    loadScreenSchemes(installationKey, meta.version),
    loadScreenSchemeOperations(installationKey, meta.version),
    loadIssueTypeScreenSchemes(installationKey, meta.version),
    loadScreenDistributions(installationKey, meta.version),
    loadScreenGovernanceSummary(installationKey, meta.version, { workflowVersion: workflowMeta?.version || null }),
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
      ? "This workflow inventory was built before transition capture existed. Rebuild it from the Workflows tab to see which screens transitions open."
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

    return {
      available: true,
      refreshedAt: analysis.refreshedAt ?? null,
      source: analysis.source ?? "unknown",
      estate: analysis.estate ?? null,
      // A preview for the overview. The Findings section fetches the full list separately;
      // sending 675 rows with the first paint would slow every visit to pay for one section.
      findingsPreview: analysis.findingsPreview ?? [],
      findingsTotal: analysis.findingsTotal ?? (analysis.findingsPreview?.length ?? 0),
      cascades: analysis.cascades ?? [],
      cascadesTotal: analysis.cascadesTotal ?? (analysis.cascades?.length ?? 0),
      selfTriggeringTotal: analysis.selfTriggeringTotal ?? 0,
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getAutomationInsights failed:", error);
    throw error;
  }
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

    const [filters, snapshotMeta] = await Promise.all([
      loadFilters(installationKey, meta.version),
      readSnapshotMeta(installationKey),
    ]);

    // The project catalog, for the broken-reference join. Best-effort: without it that one
    // finding is skipped and `projectsChecked` says so, rather than reporting zero broken
    // references because nobody looked.
    let projectKeys = null;
    if (snapshotMeta?.version) {
      const projects = await listSnapshotProjects(installationKey, snapshotMeta.version)
        .catch(fallbackOn("filters.project_keys_load_failed", () => [], { installationKey }));
      if (projects.length) projectKeys = new Set(projects.map((p) => p.projectKey).filter(Boolean));
    }

    const summary = summarizeFilters(filters, { projectKeys });
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
const SQL_ONLY_AUTOMATION_PARTS = new Set(["cascades"]);

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

    return {
      available: true,
      part,
      total: document.total ?? 0,
      entries: document.entries ?? [],
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
    const [snapshotField, projectUsageRows, projectCount, rawFieldSummary, projectUsageIssueSum] = await Promise.all([
      loadSnapshotField(installationKey, meta.version, fieldId),
      loadSnapshotProjectUsage(installationKey, meta.version, fieldId, usagePageSize, offset),
      countSnapshotProjectUsage(installationKey, meta.version, fieldId),
      loadFieldSummary(installationKey, fieldId),
      sumSnapshotFieldIssueCount(installationKey, meta.version, fieldId),
    ]);

    if (!snapshotField) throw new Error(`Field not found in snapshot: ${fieldId}`);
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

  const fields = rows.filter(Boolean);
  const projectMap = new Map();
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
      fellOff: row.fellOff, neverAdopted: row.neverAdopted, declineFrom: row.declineFrom,
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

// Recovery for a full or quick scan whose orchestrator loop has stopped stepping -- a lost
// queue message, or a consumer killed before it could re-queue the next step. The hourly
// trigger runs the same check on its own; this is the "don't make me wait for the top of
// the hour" button. `force` skips the staleness check because the UI only offers this once
// it already believes the run is stuck. Not gated on read-only mode: clearing a wedge is
// cleanup, not a new scan.
async function resumeSiteScan({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
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
      return { processed: Number(m.processed) || 0, total: Number(m.totalExpected) || 0, lastError: m.lastError || null };
    }
  } catch {
    return null;
  }
  return null;
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

// ── Rovo: automation expert ──────────────────────────────────────────────────
//
// The agent answers only from the stored analysis. It has no route to the live rules, so
// every path here reports the analysis's own staleness and returns an explicit
// "analysis-unavailable" rather than an empty result -- an agent that says "no rules use
// that field" when nothing has been analyzed is worse than one that says it does not know,
// because the user acts on the first and asks again after the second.

async function loadAutomationForAgent(installationKey) {
  const [analysis, fields, statuses, directory, findings] = await Promise.all([
    readAutomationAnalysis(installationKey),
    readAutomationPart(installationKey, "fields"),
    readAutomationPart(installationKey, "statuses"),
    readAutomationPart(installationKey, "directory"),
    readAutomationPart(installationKey, "findings"),
  ]);
  return { analysis, fields, statuses, directory, findings };
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

  const { analysis, directory, findings } = await loadAutomationForAgent(installationKey);
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
    analysisRefreshedAt: analysis.refreshedAt ?? null,
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

  const { analysis, directory, findings, fields, statuses } = await loadAutomationForAgent(installationKey);
  if (!analysis || !directory) {
    return { status: "analysis-unavailable", message: "No automation analysis has been built for this site yet." };
  }

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
    analysisRefreshedAt: analysis.refreshedAt ?? null,
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
    // rule touching a very heavily referenced field can be missing from this list.
    caveat: "Field and status lists are derived from a capped index and may omit references on fields used by more than 50 rules in one direction.",
  };
}

export async function rovoAutomationUsage(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  const name = String(payload?.name || "").trim();
  const kind = String(payload?.kind || "field").toLowerCase() === "status" ? "status" : "field";
  if (!name) return { status: "error", message: "A field or status name is required." };

  const { analysis, fields, statuses, directory } = await loadAutomationForAgent(installationKey);
  if (!analysis) {
    return { status: "analysis-unavailable", message: "No automation analysis has been built for this site yet." };
  }

  const index = kind === "status" ? statuses : fields;
  const entry = (index?.entries ?? []).find((e) => String(e.label ?? "").toLowerCase() === name.toLowerCase());

  if (!entry) {
    return {
      status: "not-referenced",
      analysisRefreshedAt: analysis.refreshedAt ?? null,
      message: `No automation rule reads, writes or triggers on the ${kind} "${name}".`,
      safeToDelete: kind === "field",
    };
  }

  const byId = ruleDirectoryMap(directory);
  const expand = (ids = []) => ids.map((id) => {
    const r = byId.get(id);
    return { ruleId: id, name: r?.name ?? `Rule ${id}`, state: r ? (r.enabled ? "ENABLED" : "DISABLED") : "UNKNOWN" };
  });

  return {
    status: "ok",
    analysisRefreshedAt: analysis.refreshedAt ?? null,
    kind,
    name: entry.label,
    ruleCount: entry.ruleCount ?? 0,
    enabledRules: entry.enabledRules ?? 0,
    disabledRules: entry.disabledRules ?? 0,
    writtenBy: { count: entry.writeCount, rules: expand(entry.write) },
    readBy: { count: entry.readCount, rules: expand(entry.read) },
    triggers: { count: entry.triggerCount, rules: expand(entry.trigger) },
    // The single most important thing this action exists to say.
    safeToDelete: entry.writeCount === 0 && entry.readCount === 0 && entry.triggerCount === 0,
    guidance: entry.writeCount > 0
      ? `Deleting this ${kind} would break ${entry.writeCount} rule(s) that write to it.`
      : "No rule writes this, but rules that read it will misbehave if it is removed.",
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

export async function getAdminOverview({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const [meta, summaryCounts, config, legacySummaryCount, workflow, screens, filterOverview, dashboardOverview, automationAnalysis] = await Promise.all([
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

  const health = computeSiteHealth({
    fieldUsage: dashboard?.fieldUsage,
    workflow,
    projects: dashboard?.projects,
    automation,
    screens,
    filters: filterOverview?.health ?? null,
    dashboards: dashboardOverview?.health ?? null,
    // Workflow, project and automation dimensions were scored against hardcoded constants
    // while every field rule was tunable. Same config surface now feeds both.
    tolerances: config?.healthTolerances,
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
  automation: ["automation"],
  projects: ["projects", "adoption"],
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
  const [workflow, screens, filterOverview, dashboardOverview, automationAnalysis] = await Promise.all([
    needs.has("workflow") ? buildWorkflowOverview(installationKey) : Promise.resolve(null),
    needs.has("screens") ? buildScreenOverview(installationKey) : Promise.resolve(null),
    needs.has("filters") ? buildFilterOverview(installationKey) : Promise.resolve(null),
    needs.has("dashboards") ? buildDashboardOverview(installationKey) : Promise.resolve(null),
    needs.has("automation")
      ? readAutomationAnalysis(installationKey).catch(fallbackOn("pillar-health.automation_load_failed", () => null, { installationKey }))
      : Promise.resolve(null),
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

  const health = computeSiteHealth({
    fieldUsage,
    workflow,
    projects,
    automation: automationAnalysis?.estate?.health ?? { available: false },
    screens,
    adoption,
    filters: filterOverview?.health ?? null,
    dashboards: dashboardOverview?.health ?? null,
    tolerances: config?.healthTolerances,
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

// Everything that touches one project, across every pillar.
//
// This is the view the Projects tab existed to give and could not: it had the field list and
// a workflow scheme wedged in beside it, and no way to say which forms a project routes to
// or which automation rules fire in it. Both joins existed as data and neither had a query.
//
// Each pillar is independent and independently unavailable. A project whose screen inventory
// has never been built reports screens as unknown and still shows its workflow, fields and
// rules -- the alternative is one unbuilt pillar blanking the whole page.
async function getProjectOverview({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const projectId = requireNonEmptyString(payload?.projectId, "projectId");

  // Permission first, and before any pillar is read. Every other project read in this file
  // filters by browsable project, and a cross-pillar view must not become the one place a
  // caller can learn about a project they cannot see.
  const browsable = await getBrowsableProjectIds(context?.accountId, [projectId]);
  if (!browsable.has(String(projectId))) {
    return { available: false, reason: "You do not have Browse Projects on this project." };
  }

  const [fieldMeta, workflowMeta, screenMeta] = await Promise.all([
    readSnapshotMeta(installationKey),
    readWorkflowSnapshotMeta(installationKey).catch(() => null),
    readScreenSnapshotMeta(installationKey).catch(() => null),
  ]);

  const [scheme, screens, rules, globalRules] = await Promise.all([
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
  ]);

  return {
    available: true,
    projectId,
    // Tri-state per pillar, never an empty list standing in for an unbuilt one. "No rule
    // touches this project" and "no automation analysis exists" are opposite claims, and
    // only one of them means the project is simple.
    workflow: workflowMeta?.version
      ? { available: true, scheme }
      : { available: false, reason: "No workflow inventory has been built yet." },
    screens: screenMeta?.version && screens
      ? {
        available: true,
        screens,
        // Reported so the tab never presents a partial catalog as the whole one.
        unresolvedScreens: screenMeta.unresolvedScreens || 0,
      }
      : { available: false, reason: "No screen inventory has been built yet." },
    automation: rules
      ? {
        available: true,
        rules,
        enabledCount: rules.filter((r) => r.enabled).length,
        disabledCount: rules.filter((r) => !r.enabled).length,
        // Site-wide rules with evidence they act here, kept separate from the scoped ones.
        // Merging them would erase the distinction between "this rule is configured for
        // this project" and "we infer this rule reaches it", and only the first is a fact.
        globalRules: globalRules || [],
        globalRulesAvailable: Boolean(globalRules),
        globalRulesReason: globalRules
          ? null
          : "Needs the field snapshot to tell which site-wide rules act on this project.",
      }
      : { available: false, reason: "No automation analysis has been built yet." },
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

  getAutomationCascades,   // Admin read: one filtered page of cascade relationships
  getCascadeGraph,         // Admin read: loops and multi-rule chains across every edge
  getStatusAutomationUsage,// Admin read: which rules reference one status, by direction
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
  getProjectOverview,      // Admin read: every pillar that touches one project
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
  probeScreenFetchCost,                        // Admin read: samples the cost of a full screen inventory pass
  migrateNamespaceKeys,                        // Mutating: rewrites scope keys across every table
};

// Order matters: the guard runs first, so an unauthorized caller is recorded as `denied`
// and never reaches the action, rather than producing both a denial and a failed action.
export const ADMIN_ONLY_FUNCTIONS = withAdminGuard(withAuditTrail(RAW_ADMIN_ONLY_FUNCTIONS));

// Unwrapped originals, for tests that need to exercise a resolver's own logic without
// standing up a permission mock. Never register these on a handler.
export const __RAW_ADMIN_ONLY_FUNCTIONS = RAW_ADMIN_ONLY_FUNCTIONS;

