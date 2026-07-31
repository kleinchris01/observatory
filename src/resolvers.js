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
  loadSnapshotFields,
  loadSnapshotField,
  loadSnapshotProjectUsage,
  loadAllSnapshotProjectUsage,
  loadAnySnapshotProjectUsage,
  listSnapshotProjects,
  loadSnapshotProjectFields,
  countSnapshotProjectUsage,
  loadFieldSummary,
  replaceFieldSummary,
  listFieldSummaries,
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
  loadStatusesCatalog,
} from "./lib/project-store.js";
import { buildWorkflowSnapshot } from "./lib/workflow-engine.js";
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
  filterProjectUsageByBrowsable,
} from "./lib/analysis.js";
import {
  buildFieldJql,
  buildOverallFieldJql,
  getFieldNumericId,
} from "./lib/transform.js";
import { inventorySnapshotQueue } from "./lib/queues.js";
import { logger } from "./lib/logger.js";
import {
  requireNonEmptyString,
  requirePositiveInt,
  requireBoundedInt,
  requireArray,
  optionalString,
  optionalEnum,
} from "./lib/validate.js";

// ---------------------------------------------------------------------------
// PII / data-retention audit note
// ---------------------------------------------------------------------------
// What user-derived data is persisted by this app:
//
//   progressLog entries  — Human-readable status messages written during
//     snapshot, issue-scan, and project-usage-job runs. These contain only
//     counts, timestamps, and field/project names — no issue content and no
//     Jira user IDs or account IDs.
//
//   scan statistics  — issue_scan_meta rows store counts (processedIssues,
//     totalIssues, pagesScanned) and timing only. No issue content is
//     persisted; the scanner reads issues at runtime and discards them after
//     aggregation.
//
//   fieldOptionsCache  — The replaceFieldOptionsCache / loadFieldOptionsCache
//     functions store field option *labels* as returned by the Jira Fields
//     API. These labels may contain user-entered values (e.g. option names
//     typed by a Jira admin). They are stored as-is to support the
//     searchFieldOptions resolver.
//
//   field_summaries / snapshot_fields  — Store field metadata (name, type,
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

const DEFAULT_ADMIN_CONFIG = {
  readOnlyMode: false,
  apiConcurrency: BASE_JIRA_CONCURRENCY,
  autoSnapshotEnabled: false,
  autoSnapshotFrequency: "weekly",
  governanceThresholds: DEFAULT_GOVERNANCE_THRESHOLDS,
  macroAccess: DEFAULT_MACRO_ACCESS,
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
  const current = await readAdminConfig();
  const updated = {
    ...current,
    ...(payload || {}),
    governanceThresholds: {
      ...current.governanceThresholds,
      ...(payload?.governanceThresholds || {}),
    },
    macroAccess: {
      ...current.macroAccess,
      ...(payload?.macroAccess || {}),
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
      return { allowed: true }; // fail open — don't block on API error
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
      // Queue job never started — reset so forceRefresh can re-enqueue
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

    // No snapshot data at all yet — return empty while the first build runs
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

    // Load from last good version — works for "ready", "building" (shows stale), and "failed"
    const [snapshotFields, fieldSummaries, issueSumsMap] = await Promise.all([
      loadSnapshotFields(installationKey, meta.version),
      listFieldSummaries(installationKey, 5000).catch(() => []),
      loadSnapshotFieldIssueSums(installationKey, meta.version).catch(() => new Map()),
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
          minActiveProjects, maxActiveProjects, minContexts, maxContexts, duplicateNamesOnly, hasDescription,
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
    const alreadyBuilding = meta?.state === "building";
    const shouldBuild = Boolean(filters.forceRefresh && !alreadyBuilding);

    if (shouldBuild) {
      await buildWorkflowSnapshot(installationKey);
      meta = await readWorkflowSnapshotMeta(installationKey);
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

    const [schemes, statuses] = await Promise.all([
      loadWorkflowSchemes(installationKey, meta.version),
      loadStatusesCatalog(installationKey, meta.version),
    ]);

    // Never surface a scheme's project count as-computed from projects the
    // viewer can't browse — recompute from only the browsable subset, same
    // enforcement point as getFieldInventory / getProjectUsageReport (PR #19).
    const filteredSchemes = await mapWithConcurrency(schemes, 8, async (scheme) => {
      const projects = await loadWorkflowSchemeProjects(installationKey, meta.version, scheme.id);
      const browsableProjectIds = await getBrowsableProjectIds(
        context?.accountId,
        projects.map((p) => p.projectId)
      );
      const visibleProjectCount = projects.filter((p) => browsableProjectIds.has(String(p.projectId))).length;
      return { ...scheme, projectCount: visibleProjectCount };
    });

    const searched = search
      ? filteredSchemes.filter((s) =>
          s.name.toLowerCase().includes(search) || (s.description || "").toLowerCase().includes(search))
      : filteredSchemes;

    const totalCount = searched.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const startIndex = (requestedPage - 1) * pageSize;

    return {
      schemes: searched.slice(startIndex, startIndex + pageSize),
      statuses,
      page: requestedPage,
      pageSize,
      totalCount,
      totalPages,
      snapshotStatus,
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getWorkflowInventory failed:", error);
    throw error;
  }
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
    if (!meta?.version) throw new Error("No completed snapshot available — build one first.");

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
    throw new Error("No completed snapshot available — build one first.");
  }

  const hours = Math.max(1, Math.min(168, Math.trunc(Number(payload?.hours)) || 24));
  const maxIssues = Math.max(50, Math.min(2000, Math.trunc(Number(payload?.maxIssues)) || 500));
  const recent = await collectRecentFieldProjectCandidates(hours, maxIssues);
  const allSummaries = await listFieldSummaries(installationKey, 5000).catch(() => []);
  const summaryByFieldId = new Map(allSummaries.map((summary) => [summary.fieldId, summary]));

  let queuedCount = 0;
  let fullRebuildCount = 0;
  for (const candidate of recent.fields) {
    const fieldId = String(candidate.fieldId || "").trim();
    if (!fieldId) continue;

    const snapshotField = await loadSnapshotField(installationKey, meta.version, fieldId).catch(() => null);
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
    throw new Error("No completed snapshot available — build one first.");
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
    throw new Error("No completed snapshot available — build one first.");
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
  const summary = existingSummary || await loadFieldSummary(installationKey, fieldId).catch(() => null);
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
  const summary = existingSummary || await loadFieldSummary(installationKey, fieldId).catch(() => null);
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
    throw new Error("No completed snapshot available — build one first.");
  }

  const pendingFields = [];
  const allSummaries = await listFieldSummaries(installationKey, 5000).catch(() => []);
  const summaryByFieldId = new Map(allSummaries.map((summary) => [summary.fieldId, summary]));
  const queueCandidates = [];
  const rows = await Promise.all(fieldIds.map(async (fieldId) => {
    const [field, projectUsage, fieldSummary] = await Promise.all([
      loadSnapshotField(installationKey, meta.version, fieldId),
      loadAllSnapshotProjectUsage(installationKey, meta.version, fieldId),
      loadFieldSummary(installationKey, fieldId).catch(() => summaryByFieldId.get(fieldId) || null),
    ]);
    if (!field) {
      return null;
    }

    // Fallback chain when current-version snapshot_project_usage is empty:
    // 1. Any-version snapshot data (handles post-migration version mismatch)
    // 2. field_summaries.activeProjects (populated by Field Usage Jobs)
    let finalProjects = projectUsage;
    if (!finalProjects.length) {
      finalProjects = await loadAnySnapshotProjectUsage(installationKey, fieldId).catch(() => []);
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
    throw new Error("No completed snapshot available — build one first.");
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

  const [allProjects, issueScanMeta] = await Promise.all([
    listSnapshotProjects(installationKey, meta.version, projectQuery),
    readIssueScanMeta(installationKey).catch(() => null),
  ]);

  // Only show projects the CALLING user actually has Browse Projects
  // permission on -- never surface another project's name/existence to
  // someone who can't see it in Jira itself.
  const browsableProjectIds = await getBrowsableProjectIds(
    context?.accountId,
    allProjects.map((p) => p.projectId)
  );
  const projects = allProjects.filter((p) => browsableProjectIds.has(String(p.projectId)));

  const selectedProjectId = String(payload?.projectId || "").trim() || projects[0]?.projectId || "";
  const selectedProject = projects.find((project) => project.projectId === selectedProjectId) || projects[0] || null;

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
    projects,
    availableTypes,
    selectedProject,
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
  const snapshotFields = await loadSnapshotFields(installationKey, meta.version);
  const fieldSummaries = await listFieldSummaries(installationKey, 5000).catch(() => []);
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
        minActiveProjects, maxActiveProjects, minContexts, maxContexts, duplicateNamesOnly, hasDescription,
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
    }).catch(() => {});
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

  // Re-queue only workers that haven't finished — do NOT call the coordinator
  // (the coordinator wipes all accumulated data and starts over)
  const queueErrors = [];
  let anyRequeued = false;
  for (let workerId = 0; workerId < ISSUE_SCAN_WORKERS; workerId++) {
    const worker = await readIssueScanWorker(installationKey, workerId).catch(() => null);
    if (!worker || worker.status === "done") continue;
    anyRequeued = true;
    // Reset failed workers back to queued so they can run again
    if (worker.status === "failed") {
      await updateIssueScanWorker(installationKey, workerId, { status: "queued", lastError: null }).catch(() => {});
    }
    try {
      await queueIssueScanWorker(installationKey, workerId);
    } catch (pushError) {
      queueErrors.push(`worker ${workerId}: ${pushError?.message || String(pushError)}`);
    }
  }

  if (queueErrors.length > 0) {
    const errMsg = `Resume partially failed: ${queueErrors.join("; ")}`;
    await writeIssueScanMeta(installationKey, { state: "failed", lastError: errMsg }).catch(() => {});
    throw new Error(errMsg);
  }

  // Every worker already reported "done", so nothing got re-queued above — no worker
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

async function getIssueScanStatus({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const meta = await readIssueScanMeta(installationKey);
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
      message: "No snapshot available yet — building one now.",
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

// Top finding-type/field-type breakdowns are capped -- Overview is a glance-level
// summary, not the full Field Browser, and shipping ~1500 hydrated fields' worth of
// distinct titles/types to the client would dwarf the rest of the payload for no benefit.
const DASHBOARD_TOP_N = 8;

function buildFieldUsageInsights(hydratedFields) {
  const findingsBySeverity = { high: 0, medium: 0, low: 0 };
  const findingsByTitle = new Map();
  const fieldTypeCounts = new Map();
  const origin = { builtin: 0, appProvided: 0, custom: 0 };
  const nameGroups = new Map();

  for (const f of hydratedFields) {
    for (const reason of f.findings?.reasons || []) {
      if (reason.severity in findingsBySeverity) findingsBySeverity[reason.severity]++;
      findingsByTitle.set(reason.title, (findingsByTitle.get(reason.title) || 0) + 1);
    }

    const typeLabel = f.type || "Unknown";
    fieldTypeCounts.set(typeLabel, (fieldTypeCounts.get(typeLabel) || 0) + 1);

    if (!f.isSystemField) {
      if (f.isJiraBuiltin) origin.builtin++;
      else if (isLikelyAppProvidedField(f)) origin.appProvided++;
      else origin.custom++;
    }

    nameGroups.set(normalizeFieldName(f.name), (nameGroups.get(normalizeFieldName(f.name)) || 0) + 1);
  }

  const findingsByType = [...findingsByTitle.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, DASHBOARD_TOP_N)
    .map(([title, count]) => ({ title, count }));

  const fieldTypeBreakdown = [...fieldTypeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, DASHBOARD_TOP_N)
    .map(([type, count]) => ({ type, count }));

  const duplicateClusters = [...nameGroups.values()].filter((n) => n > 1).length;

  return {
    totalFields: hydratedFields.length,
    findingsBySeverity,
    findingsByType,
    fieldTypeBreakdown,
    origin,
    duplicateClusters,
  };
}

function buildProjectInsights(projects) {
  const topByIssueVolume = [...projects]
    .sort((a, b) => b.totalIssueCount - a.totalIssueCount)
    .slice(0, DASHBOARD_TOP_N)
    .map((p) => ({ projectKey: p.projectKey, projectName: p.projectName, totalIssueCount: p.totalIssueCount }));

  const topByFieldCount = [...projects]
    .sort((a, b) => b.fieldCount - a.fieldCount)
    .slice(0, DASHBOARD_TOP_N)
    .map((p) => ({ projectKey: p.projectKey, projectName: p.projectName, fieldCount: p.fieldCount }));

  return { totalProjects: projects.length, topByIssueVolume, topByFieldCount };
}

export async function getAdminOverview({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const [meta, summaries, config, legacySummaryCount] = await Promise.all([
    readSnapshotMeta(installationKey),
    listFieldSummaries(installationKey, 5000).catch(() => []),
    readAdminConfig(),
    countOldScopeKeyRows(installationKey).catch(() => 0),
  ]);

  const jobCounts = { queued: 0, building: 0, ready: 0, failed: 0, cancelled: 0, unbuilt: 0 };
  for (const s of summaries) {
    const state = s.summaryStatus || "unbuilt";
    if (state in jobCounts) jobCounts[state]++;
    else jobCounts.unbuilt++;
  }

  let findingsSummary = { adminAttention: 0, risky: 0, cleanup: 0, standardize: 0 };
  let dashboard = EMPTY_DASHBOARD;
  if (meta?.version) {
    try {
      const [fields, projects] = await Promise.all([
        loadSnapshotFields(installationKey, meta.version),
        listSnapshotProjects(installationKey, meta.version),
      ]);
      const dup = buildDuplicateNameCountMap(fields);
      const hydrated = fields.map((f) =>
        hydrateFieldForGovernance(f, null, dup.get(normalizeFieldName(f.name)) ?? 1, config.governanceThresholds)
      );
      findingsSummary = summarizeFindings(hydrated);
      dashboard = {
        fieldUsage: buildFieldUsageInsights(hydrated),
        projects: buildProjectInsights(projects),
      };
    } catch {}
  }

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
    dashboard,
    totalSummaries: summaries.length,
    legacySummaryCount,
  };
}

export async function migrateNamespaceKeys({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const result = await migrateOldScopeKeys(installationKey);
  return result;
}

// ----- Delta issue scan -----

const DELTA_SCOPE_SUFFIX = "::delta";
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
    } catch { /* non-critical */ }

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

    // Map<fieldId, Map<projectId, { count, key, name }>> — same structure as baseline scan
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
        }).catch(() => {});
      }

      if (!cursorToken || issues.length === 0) break;
    }

    if (pagesScanned >= DELTA_ISSUE_SCAN_MAX_PAGES) {
      logEntry(`Delta cap reached (${DELTA_ISSUE_SCAN_MAX_PAGES} pages) — results may be partial`);
    }

    logEntry(`Scanned ${issuesScanned.toLocaleString()} delta issues — ${fieldProjectCounts.size} fields across ${affectedProjects.size} projects`);

    if (rqtFieldHits.size > 0) {
      await upsertRqtFieldHits(installationKey, rqtFieldHits).catch((e) => {
        console.error("runDeltaIssueScanJob: RQT flush error", e?.message || e);
      });
      logEntry(`RQT index updated — ${rqtFieldHits.size} field(s) with RQT values`);
    }
    if (rqtIssueBuffer.length > 0) {
      await upsertRqtIssueKeys(installationKey, rqtIssueBuffer).catch((e) => {
        console.error("runDeltaIssueScanJob: RQT issue key flush error", e?.message || e);
      });
      logEntry(`RQT issue keys updated — ${rqtIssueBuffer.length} issue(s)`);
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

    // Update field×project usage: for each touched pair, get accurate total count via JQL
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
        logEntry(`Capped field×project count queries at 500 of ${touchedPairs.length} pairs`);
      }

      logEntry(`Running ${cappedPairs.length} field×project count queries...`);

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
      logEntry(`Updated ${fieldProjectPairsUpdated} field×project usage rows in snapshot`);
    } else if (!snapshotMeta?.version) {
      logEntry("No snapshot found — skipping field usage update (run a snapshot first)");
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
    }).catch(() => {});
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
    }).catch(() => {});
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
    } catch {
      // Name enrichment is best-effort
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
  getFieldDetails,         // Read-only: returns detailed field data for a single field
  getProjectsView,         // Read-only: returns per-project field usage view
  getFilteredFieldIds,     // Read-only: returns filtered and sorted field ID list
  getFieldOptions,         // Read-only: returns field option values from cache or Jira
  searchFieldOptions,      // Read-only: searches cached field option labels
  getSavedReports,         // Read-only: lists saved report definitions
  getProjectUsageReportJob, // Read-only: polls async report job status
  getProjectUsageReport,   // Read-only: returns project usage data for given fields
};

// ── Admin authorization ──────────────────────────────────────────────────────
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
  // Issue scan lifecycle — trigger and cancel full field×issue scans
  startIssueScan,          // Mutating: queues a full issue scan job
  resumeIssueScan,         // Mutating: re-queues incomplete issue scan workers
  cancelIssueScan,         // Mutating: hard-stops the running issue scan
  getIssueScanStatus,      // Admin read: exposes raw scan meta including progressLog

  // Delta issue scan — lightweight incremental scan
  startDeltaIssueScan,     // Mutating: queues a delta (incremental) issue scan job
  getDeltaIssueScanStatus, // Admin read: exposes delta scan meta

  // Snapshot lifecycle
  cancelSnapshot,          // Mutating: cancels in-progress snapshot build
  clearSnapshot,           // Mutating: irreversibly deletes all derived snapshot data

  // Project usage job management
  getProjectUsageJobs,     // Admin read: lists all field-level project-usage jobs with logs
  cancelProjectUsageJob,   // Mutating: cancels a running project-usage job
  restartProjectUsageJob,  // Mutating: wipes and re-queues a project-usage job from scratch
  resumeProjectUsageJob,   // Mutating: resumes a paused/failed project-usage job
  refreshRecentProjectUsage, // Mutating: triggers incremental refresh based on recent issue changes
  restoreProjectUsageCache,  // Mutating: queues full restoration of project-usage from summaries

  // Report management — write operations on stored report definitions and async jobs
  saveReportDefinition,    // Mutating: creates or updates a saved report definition
  deleteReportDefinition,  // Mutating: deletes a saved report definition
  startProjectUsageReportJob, // Mutating: triggers an async project-usage report build job

  // RQT (required-query-token) index — internal governance analytics
  getRqtIndex,             // Admin read: returns RQT field index and issue sample data
  searchRqtValue,          // Admin read: looks up issues by RQT value token

  // Admin page surface. These were previously registered directly onto adminHandler in
  // index.js, which meant they sat outside this registry and therefore outside its
  // guard -- saveAdminConfig, which rewrites governance thresholds AND the macro access
  // group list, was reachable by any caller who could invoke it. Registered here so the
  // guard covers them like everything else.
  getAdminConfig: getAdminConfigResolver,      // Admin read: returns full admin config
  saveAdminConfig: saveAdminConfigResolver,    // Mutating: rewrites thresholds and access control
  getAdminOverview,                            // Admin read: dashboard aggregate
  migrateNamespaceKeys,                        // Mutating: rewrites scope keys across every table
};

// Order matters: the guard runs first, so an unauthorized caller is recorded as `denied`
// and never reaches the action, rather than producing both a denial and a failed action.
export const ADMIN_ONLY_FUNCTIONS = withAdminGuard(withAuditTrail(RAW_ADMIN_ONLY_FUNCTIONS));

// Unwrapped originals, for tests that need to exercise a resolver's own logic without
// standing up a permission mock. Never register these on a handler.
export const __RAW_ADMIN_ONLY_FUNCTIONS = RAW_ADMIN_ONLY_FUNCTIONS;
