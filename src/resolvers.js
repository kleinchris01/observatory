import { kvs } from "@forge/kvs";
import {
  incrMetric,
  METRIC_NAMES,
  getInstallationKey,
  mapWithConcurrency,
  getLiveFieldProjectUsage,
  PROJECT_USAGE_PAGE_SIZE,
  getBrowsableProjectIds,
  createJiraIssue,
  updateJiraIssue,
  searchIssuesPage,
  transitionIssueWithComment,
} from "./lib/jira-api.js";
import { pillarUnavailable, agentOk, agentNotFound, rankMatches, clampResults } from "./lib/rovo-agents.js";
import {
  hydrateFieldForGovernance,
} from "./lib/snapshot-engine.js";
import {
  ensureProjectStoreReady,
  readSnapshotMeta,
  listAuditEvents,
  loadSnapshotFields,
  listSnapshotProjects,
  loadProjectActivity,
  loadFilters,
  readFilterSnapshotMeta,
  loadFilterReferencesFor,
  loadFilterReferenceCounts,
  loadDashboards,
  readDashboardSnapshotMeta,
  countFieldSummariesByStatus,
  countOldScopeKeyRows,
  migrateOldScopeKeys,
  readWorkflowSnapshotMeta,
  transitionAwareWorkflowVersion,
  loadWorkflowSchemes,
  loadWorkflowSchemeProjects,
  loadWorkflowSchemeForProject,
  loadStatusesCatalog,
  loadWorkflowSchemeStatuses,
  loadStatusIssueCounts,
  readScreenSnapshotMeta,
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
  USAGE_PILLARS,
  USAGE_WINDOW_DAYS,
} from "./lib/project-store.js";
import { getPlaybook, groupBounded, listPlaybookCatalog, REMEDIATION_FINDING_INDEX } from "./lib/remediation-playbooks.js";
import { ensureInitiativeFor, ROOT_NODE } from "./lib/remediation-hierarchy.js";
import { computeRemediationMetrics } from "./lib/remediation-metrics.js";
import { queueRemediationSync } from "./lib/remediation-sync.js";
import { renderADF } from "./lib/adf.js";
import { verifyTickets, verificationComment, targetCategory } from "./lib/remediation-verify.js";
import { getWorkflowRuleUsage, getWorkflowRules, getWorkflowRestrictions, getWorkflowRuleInsights } from "./lib/workflow-rule-reads.js";
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
} from "./lib/site-health.js";
import { summarizeAdoption } from "./lib/project-adoption.js";
import { summarizeFilters } from "./lib/filter-insights.js";
import { summarizeDashboards } from "./lib/dashboard-insights.js";
import { fullScanStageCatalog, readStageProducedCounts } from "./lib/full-scan-runner.js";
import { getSiteBaseUrl, normalizeSiteOrigin } from "./lib/jira-api.js";
import {
  findDuplicateStatusGroups,
  findOrphanedStatuses,
  computeSchemeCategoryBalance,
} from "./lib/workflow-insights.js";
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
  normalizeFieldName,
  buildDuplicateNameCountMap,
  filterInventoryFields,
  sortInventoryFields,
  summarizeFindings,
  summarizeFindingsByCode,
} from "./lib/analysis.js";
import { logger, fallbackOn } from "./lib/logger.js";
import {
  requireNonEmptyString,
  optionalPositiveInt,
  requireArray,
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
  getHandoverReport,
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
import {
  getWorkflowInventory,
  computeBoardStatusIds,
  computeWorkflowInsightsFull,
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
// Did the fixes hold? Every remediation task checked against the latest scan: closed and no
// longer flagged (held), closed but still flagged (regressed), open but already fixed, or still
// open. Candidates come from the same loaders that created the tasks, so item ids match.
// Admin read; it changes nothing in Jira.
async function getRemediationVerification({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  const tickets = await loadRemediationTickets(installationKey);
  const findingKeys = [...new Set(tickets.filter((t) => !t.isEpic).map((t) => t.findingKey))];
  const current = new Map();
  await mapWithConcurrency(findingKeys, 3, async (findingKey) => {
    try {
      const result = await loadRemediationCandidates({ payload: { findingKey }, context });
      current.set(findingKey, result?.available === false
        ? { available: false, ids: new Set(), reason: result.reason || "unavailable" }
        : { available: true, ids: new Set((result?.items || []).map((it) => String(it.id ?? it.name))) });
    } catch (error) {
      logger.warn("remediation.verify_candidates_failed", { installationKey, findingKey, error: String(error?.message || error) });
      current.set(findingKey, { available: false, ids: new Set(), reason: "error" });
    }
  });
  const labels = Object.fromEntries(listPlaybookCatalog().map((p) => [p.key, p.label]));
  return { checkedAt: new Date().toISOString(), labels, ...verifyTickets({ tickets, current }) };
}

// Act on verification: reopen tasks whose fix did not hold, close tasks whose item is fixed.
// Explicit admin action only -- the page lists the candidates, an admin chooses them. Verdicts
// are recomputed here rather than trusted from the page, so a task that changed since the page
// loaded is left alone and says why. Each task gets a comment explaining the move, written as
// the admin. Mutating and audited.
const MAX_VERIFICATION_APPLY = 50;
async function applyRemediationVerification({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  requireArray(payload?.issueKeys, "issueKeys");
  const issueKeys = [...new Set(payload.issueKeys.map(String))].slice(0, MAX_VERIFICATION_APPLY);

  const verification = await getRemediationVerification({ context });
  const byKey = new Map(verification.rows.map((r) => [r.issueKey, r]));
  const results = [];
  for (const issueKey of issueKeys) {
    const row = byKey.get(issueKey);
    const target = row ? targetCategory(row.verdict) : null;
    if (!target) {
      results.push({
        issueKey, transitioned: false, commented: false,
        reason: row ? `Its verdict is now "${row.verdict}", so it was left as it is.` : "Not an Observatory remediation task.",
      });
      continue;
    }
    const text = verificationComment(row, { checkedAt: verification.checkedAt, findingLabel: verification.labels[row.findingKey] });
    try {
      // eslint-disable-next-line no-await-in-loop -- one ticket at a time; each is a write.
      results.push(await transitionIssueWithComment(issueKey, { target, commentBody: renderADF(text), asUser: true }));
    } catch (error) {
      results.push({ issueKey, transitioned: false, commented: false, reason: String(error?.message || error) });
    }
  }
  // Pull the new statuses back now rather than at the next hourly sync.
  await queueRemediationSync(installationKey).catch(fallbackOn("remediation.verify_sync_queue_failed", null, { installationKey }));
  return { results, applied: results.filter((r) => r.transitioned).length, skipped: payload.issueKeys.length - issueKeys.length };
}

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

