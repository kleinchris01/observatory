import {
  incrMetric,
  METRIC_NAMES,
  getInstallationKey,
  getLiveFieldProjectUsage,
  PROJECT_USAGE_PAGE_SIZE,
  getBrowsableProjectIds,
} from "./lib/jira-api.js";
import { pillarUnavailable, agentOk, agentNotFound, rankMatches, clampResults } from "./lib/rovo-agents.js";
import {
  ensureProjectStoreReady,
  readSnapshotMeta,
  loadSnapshotFields,
  loadWorkflowSchemeProjects,
  readDriftSnapshotMeta,
  loadConfigChanges,
} from "./lib/project-store.js";
import { getWorkflowRuleUsage, getWorkflowRules, getWorkflowRestrictions, getWorkflowRuleInsights } from "./lib/workflow-rule-reads.js";
import { getFieldConfigInventory, getFieldConfigItems, getFieldBehaviour } from "./lib/fieldconfig-reads.js";
// Moved out of this file so a scan can record a measurement without importing the
// resolver layer. Same implementation, both callers.
import {
  findDuplicateStatusGroups,
  computeSchemeCategoryBalance,
} from "./lib/workflow-insights.js";
import {
  assessAutomationEvidence,
} from "./lib/automation-analysis.js";
import {
  loadStatusAutomationReferences,
} from "./lib/store/automation.js";
import {
  filterInventoryFields,
  sortInventoryFields,
} from "./lib/analysis.js";
import {
  getAdminConfigResolver,
  saveAdminConfigResolver,
} from "./resolvers/admin-config.js";
import {
  viewerProjects,
} from "./resolvers/viewer.js";
import { withAdminGuard, withAuditTrail } from "./resolvers/admin-guard.js";
import { probeServiceManagementApi } from "./resolvers/jsm.js";
import { checkMacroAccess } from "./resolvers/macro-access.js";
import { getIssueTypeInventory, buildIssueTypeInventory } from "./resolvers/issue-types.js";
import {
  getUserInventory,
  getUserDetails,
  getHandoverReport,
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
import { getChangeHistory, buildChangeHistory } from "./resolvers/changes.js";
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
  getScreenFieldReportInputs,
  getProjectScreenReportInputs,
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
import {
  getWorkflowInventory,
  getWorkflowInsights,
  loadWorkflowForAgent,
  statusRow,
  computeStatusDetail,
  getStatusDetail,
} from "./resolvers/workflows.js";
import { getDeletionSafety } from "./resolvers/deletion-safety.js";
import {
  getProjectUsageJobs,
  refreshRecentProjectUsage,
  cancelProjectUsageJob,
  restartProjectUsageJob,
  resumeProjectUsageJob,
  getSavedReports,
  saveReportDefinition,
  deleteReportDefinition,
  getProjectUsageReport,
  startProjectUsageReportJob,
  getProjectUsageReportJob,
  getProjectsView,
  restoreProjectUsageCache,
} from "./resolvers/project-usage.js";
import {
  cancelSnapshot,
  clearSnapshot,
  startFullSiteScan,
  resumeSiteScan,
  cancelSiteScan,
  getFullScanStatus,
  startQuickSiteScan,
  getQuickScanStatus,
  startIssueScan,
  resumeIssueScan,
  getIssueScanStatus,
  cancelIssueScan,
  startDeltaIssueScan,
  getDeltaIssueScanStatus,
} from "./resolvers/scans.js";
import {
  getRemediationTickets,
  getRemediationVerification,
  applyRemediationVerification,
  getRemediationMetrics,
  syncRemediationNow,
  organiseRemediationHierarchy,
  createRemediationEpic,
  getRemediationCandidates,
} from "./resolvers/remediation.js";
import {
  getFirstRunState,
  setFirstRunState,
  getAdminOverview,
  getHealthHistory,
} from "./resolvers/overview.js";
import {
  getPillarUsage,
  getPillarHealth,
  getPillarReport,
  runOqlQuery,
} from "./resolvers/reports.js";
import { getProjectOverview } from "./resolvers/project-overview.js";
import { getAuditLog, migrateNamespaceKeys } from "./resolvers/admin-tools.js";
export { migrateNamespaceKeys } from "./resolvers/admin-tools.js";
export { OQL_RESULT_LIMIT } from "./resolvers/reports.js";
export { getFirstRunState, setFirstRunState, getAdminOverview } from "./resolvers/overview.js";
export {
  CLEAR_SNAPSHOT_CONFIRMATION,
  captureSiteHealthForScan,
  recordQuickScanScheduledRun,
  STUCK_SCAN_MS,
  isScanStuck,
  DELTA_SCOPE_SUFFIX,
  DELTA_ISSUE_SCAN_DEFAULT_WINDOW_HOURS,
  runDeltaIssueScanJob,
} from "./resolvers/scans.js";
export { getDeletionSafety } from "./resolvers/deletion-safety.js";
export { getScreenFieldCrossSignal, computeAndStoreScreenCross } from "./resolvers/screens.js";
export { __clearMacroAccessCache, MacroAccessError, withMacroAccessGuard } from "./resolvers/macro-access.js";
export { __resetAdminCheckCache, AdminPermissionError } from "./resolvers/admin-guard.js";
export { readAdminConfig, getAdminConfigResolver, saveAdminConfigResolver } from "./resolvers/admin-config.js";









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
  getHandoverReport,       // Admin read: what depends on one person's account, for offboarding
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
  getRemediationVerification,   // Admin read: did each remediation task's fix hold, per the latest scan
  applyRemediationVerification, // Mutating: reopens regressed tasks / closes fixed ones, with a comment, as the admin
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

