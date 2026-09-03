// The inputs to the site health score, and the capture that records it.
//
// These four builders lived inside resolvers.js as private functions, which meant the score
// could only ever be computed while rendering the Overview. That was fine while a person
// looking at the page was the only thing that produced a measurement -- and wrong the moment
// a scan needed to record one, because scan-engine importing resolvers would invert the
// dependency direction the rest of this codebase keeps clean.
//
// So they live here, and both callers import them: the Overview to render, and the scan
// orchestrator to record. One implementation, so the number on the page and the number in
// the history can never disagree about how it was derived.

import { computeSiteHealth } from "./health-score.js";
import { isLikelyAppProvidedField, normalizeFieldName } from "./analysis.js";
import {
  computeSchemeCategoryBalance,
  findDuplicateStatusGroups,
  findOrphanedStatuses,
  summarizeWorkflowInsights,
} from "./workflow-insights.js";
import { fallbackOn } from "./logger.js";
import {
  loadIssueScanProjectTotals,
  loadProjectActivity,
  loadFilters,
  readFilterSnapshotMeta,
  loadDashboards,
  readDashboardSnapshotMeta,
  loadScreenGovernanceSummary,
  loadStatusIssueCounts,
  loadStatusesCatalog,
  loadWorkflowSchemeStatuses,
  loadWorkflowSchemes,
  readScreenSnapshotMeta,
  readWorkflowSnapshotMeta,
  readIssueTypeSnapshotMeta,
  loadIssueTypes,
  readAssetSnapshotMeta,
  loadAssetSchemas,
  loadAssetObjectTypes,
  loadAssetAttributes,
  readAccessSnapshotMeta,
  loadSchemes,
  loadSchemeHolders,
  loadSchemeLevels,
  loadSchemeProjects,
  readEstateSnapshotMeta,
  loadEstateValues,
  loadIssueTypeSchemes,
  loadIssueTypeSchemeItems,
  readUserSnapshotMeta,
  loadUsers,
  loadUserGovernanceSummary,
} from "./project-store.js";
// Imported from the automation store directly: project-store.js re-exports the other eight
// store modules but not this one, because the automation pillar is written by an import
// rather than built by a snapshot job and never needed to be part of that surface.
import { loadStatusAutomationReferences, readAutomationPart } from "./store/automation.js";
import { summarizeAdoption } from "./project-adoption.js";
import { summarizeFilters, summarizeFilterHealth } from "./filter-insights.js";
import { summarizeDashboards, summarizeDashboardHealth } from "./dashboard-insights.js";
import { summarizeIssueTypeInsights, summarizeIssueTypeHealth } from "./issuetype-insights.js";
import { summarizeAssetInsights, summarizeAssetHealth } from "./asset-insights.js";
import { summarizeEstateInsights, summarizeEstateHealth } from "./estate-insights.js";
import {
  summarizePermissionInsights, summarizePermissionHealth,
  summarizeSecurityInsights, summarizeSecurityHealth,
  summarizeNotificationInsights, summarizeNotificationHealth,
} from "./access-insights.js";
import { buildOwnershipIndex, summarizeOrphanedOwnership } from "./user-ownership.js";

// Top finding-type/field-type breakdowns are capped -- Overview is a glance-level
// summary, not the full Field Browser, and shipping ~1500 hydrated fields' worth of
// distinct titles/types to the client would dwarf the rest of the payload for no benefit.
const DASHBOARD_TOP_N = 8;

export function buildFieldUsageInsights(hydratedFields) {
  const findingsBySeverity = { high: 0, medium: 0, low: 0 };
  const findingsByTitle = new Map();
  const fieldTypeCounts = new Map();
  const origin = { builtin: 0, appProvided: 0, custom: 0 };
  const nameGroups = new Map();

  for (const f of hydratedFields) {
    for (const reason of f.findings?.reasons || []) {
      // "duplicate-naming" is deliberately kept OUT of the severity roll-up. It has its own
      // scored dimension (field-naming, built from duplicateClusters below), and folding it
      // into findingsBySeverity too would charge the same defect twice inside the fields
      // pillar -- once per cluster and again per field in the cluster. It still appears in
      // findingsByType, which is the tab's informational breakdown, not a score input.
      if (reason.code !== "duplicate-naming" && reason.severity in findingsBySeverity) {
        findingsBySeverity[reason.severity]++;
      }
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

// Attach the distinct-issue count per project, where the Universal Scan has measured one.
//
// listSnapshotProjects returns SUM(issue_count) over snapshot_project_usage, which holds
// one row per field x project. That sum is FIELD FILLS, not issues: an issue carrying 90
// populated fields contributes 90. On a site whose median project has 90 fields that
// inflates by roughly two orders of magnitude, which is how a few hundred thousand issues
// render as twenty million.
//
// issue_scan_project_totals.unique_issue_count is the real figure -- distinct issues seen
// per project during the scan. It is only populated by a Universal Scan, so uniqueIssueCount
// stays null on sites that have only run per-field summary builds. Callers must treat null
// as "not measured" and say so, rather than falling back to the fills figure under an
// issue-shaped label.
export async function attachUniqueIssueCounts(installationKey, projects) {
  const totals = await loadIssueScanProjectTotals(installationKey)
    .catch(fallbackOn("overview.project_totals_load_failed", () => [], { installationKey }));

  if (!totals.length) return projects.map((p) => ({ ...p, uniqueIssueCount: null }));

  const byProjectId = new Map(totals.map((t) => [String(t.projectId), t.uniqueIssueCount]));
  return projects.map((project) => {
    const measured = byProjectId.get(String(project.projectId));
    return {
      ...project,
      uniqueIssueCount: Number.isFinite(measured) ? measured : null,
    };
  });
}

function percentile(sortedValues, fraction) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * fraction));
  return sortedValues[index];
}

export function buildProjectInsights(projects) {
  // True when the Universal Scan has measured distinct issues for at least one project.
  // Partial coverage still counts: a project the scan has not reached keeps a null and is
  // rendered as unmeasured rather than as zero.
  const hasUniqueCounts = projects.some((p) => p.uniqueIssueCount != null);

  // The figure every downstream number should be built on. Falls back to fills only when
  // nothing has been measured, and `hasUniqueCounts` tells the caller which it is looking at.
  const volumeOf = (p) => (hasUniqueCounts ? (p.uniqueIssueCount ?? 0) : p.totalIssueCount);

  const topByIssueVolume = [...projects]
    .sort((a, b) => volumeOf(b) - volumeOf(a))
    .slice(0, DASHBOARD_TOP_N)
    .map((p) => ({
      projectKey: p.projectKey,
      projectName: p.projectName,
      totalIssueCount: p.totalIssueCount,
      uniqueIssueCount: p.uniqueIssueCount ?? null,
      volume: volumeOf(p),
    }));

  const topByFieldCount = [...projects]
    .sort((a, b) => b.fieldCount - a.fieldCount)
    .slice(0, DASHBOARD_TOP_N)
    .map((p) => ({ projectKey: p.projectKey, projectName: p.projectName, fieldCount: p.fieldCount }));

  // Distribution, not just leaders. A "top 8 by field count" list is unreadable without
  // knowing what normal looks like: 40 fields is unremarkable on a site whose median is 38
  // and a serious outlier on one whose median is 6.
  const fieldCounts = projects.map((p) => p.fieldCount).sort((a, b) => a - b);
  const medianFieldCount = percentile(fieldCounts, 0.5);
  const p90FieldCount = percentile(fieldCounts, 0.9);
  // Sum of field fills across the site. Kept and reported, but never labelled as issues.
  const totalFieldFills = projects.reduce((sum, p) => sum + p.totalIssueCount, 0);
  const totalUniqueIssues = hasUniqueCounts
    ? projects.reduce((sum, p) => sum + (p.uniqueIssueCount ?? 0), 0)
    : null;

  // Configured well past the site norm. Guarded against a degenerate median: on a site
  // where the median project has one field, "twice the median" is noise, so require an
  // absolute floor as well.
  //
  // This used to require light issue volume too, and was still labelled -- here, in the
  // health score, and on the Overview -- as "projects configured well past the norm". Those
  // are different claims, and the AND made the compound one impossible to trip on an active
  // site: a project with 90 fields and 90 fields' worth of work is over-configured by any
  // reasonable reading and was counted as neither. The site read 0 over-configured projects
  // and scored 100 for project consistency while carrying plenty of both.
  //
  // So the two claims are now two measures. This one is the shape of the estate; the idle
  // subset below is the cleanup worklist.
  const totalVolume = projects.reduce((sum, p) => sum + volumeOf(p), 0);
  const overConfiguredFloor = Math.max(10, medianFieldCount * 2);
  const isOverConfigured = (p) => p.fieldCount >= overConfiguredFloor;

  // The volume side must use the measured figure, not the fills sum. Against fills the
  // absolute floor of 50 could never bind -- an average project's fills run to six figures
  // -- so the test silently collapsed to the relative term alone.
  //
  // measuredVolumeOf, not volumeOf. volumeOf coerces an unmeasured project to 0 so it can
  // be summed and sorted, which is right for a total and wrong for a predicate: once the
  // scan has measured ANY project, every project it has not reached yet would read as
  // carrying no work at all, and a partial scan would report most of the site as abandoned.
  // null here means "not measured", and a comparison against null is false, which is the
  // answer we want -- no claim either way.
  const measuredVolumeOf = (p) => (hasUniqueCounts ? p.uniqueIssueCount ?? null : p.totalIssueCount);
  const lightVolumeCeiling = Math.max(50, totalVolume / Math.max(1, projects.length) / 4);
  const isIdle = (p) => measuredVolumeOf(p) !== null && measuredVolumeOf(p) < lightVolumeCeiling;

  const shapeProject = (p) => ({
    projectKey: p.projectKey,
    projectName: p.projectName,
    fieldCount: p.fieldCount,
    totalIssueCount: p.totalIssueCount,
    uniqueIssueCount: p.uniqueIssueCount ?? null,
    volume: volumeOf(p),
  });

  const overConfiguredAll = projects.filter(isOverConfigured).sort((a, b) => b.fieldCount - a.fieldCount);
  const overConfigured = overConfiguredAll.slice(0, DASHBOARD_TOP_N).map(shapeProject);

  // Over-configured AND carrying little work. Where field governance conversations start,
  // because the cost is real and the usage is not.
  const idleOverConfiguredAll = overConfiguredAll.filter(isIdle);
  const idleOverConfigured = idleOverConfiguredAll.slice(0, DASHBOARD_TOP_N).map(shapeProject);

  // Fields configured, no work recorded at all -- either abandoned or never started.
  //
  // Tested against volumeOf rather than totalIssueCount. That field counts field FILLS, so
  // "no issues" meant "not one populated field value anywhere", which almost nothing
  // satisfies; where the scan has measured distinct issues, zero issues is the real test.
  const unusedProjectsAll = projects
    .filter((p) => p.fieldCount > 0 && measuredVolumeOf(p) === 0)
    .sort((a, b) => b.fieldCount - a.fieldCount);
  const unusedProjects = unusedProjectsAll
    .slice(0, DASHBOARD_TOP_N)
    .map((p) => ({ projectKey: p.projectKey, projectName: p.projectName, fieldCount: p.fieldCount }));

  // Staleness is a per-project signal the field view never surfaces: a project can carry
  // 60 fields and 40,000 issues and still have had nothing touched in a year.
  const now = Date.now();
  const STALE_MS = 180 * 24 * 60 * 60 * 1000;
  const staleProjectsAll = projects
    .filter((p) => {
      const at = Date.parse(p.latestIssueUpdatedAt || "");
      return p.totalIssueCount > 0 && Number.isFinite(at) && now - at > STALE_MS;
    })
    .sort((a, b) => Date.parse(a.latestIssueUpdatedAt) - Date.parse(b.latestIssueUpdatedAt));
  const staleProjects = staleProjectsAll
    .slice(0, DASHBOARD_TOP_N)
    .map((p) => ({
      projectKey: p.projectKey,
      projectName: p.projectName,
      fieldCount: p.fieldCount,
      latestIssueUpdatedAt: p.latestIssueUpdatedAt,
    }));

  return {
    totalProjects: projects.length,
    // Both figures, named for what they are. `hasUniqueCounts` tells the UI which one it
    // may present as issues -- there is deliberately no single `totalIssues` key, because
    // that name is what let field fills be rendered as an issue count in the first place.
    totalFieldFills,
    totalUniqueIssues,
    hasUniqueCounts,
    medianFieldCount,
    p90FieldCount,
    // The threshold the counts below were derived from, so a reader can judge the finding
    // rather than take the number on trust.
    overConfiguredFloor,
    topByIssueVolume,
    topByFieldCount,
    // Display lists, capped at DASHBOARD_TOP_N -- the Overview is a glance, not a census.
    overConfigured,
    idleOverConfigured,
    unusedProjects,
    staleProjects,
    // Uncapped totals, and the reason they exist.
    //
    // The health score used to derive its rate from the LENGTHS of the lists above. Those
    // are sliced to eight, so the numerator could never exceed sixteen however irregular
    // the estate was: on a 200-project site the worst achievable project-consistency rate
    // was 8%, comfortably inside a 25% tolerance, and the dimension was pinned near 100 by
    // construction. A rate has to be built from a count of the whole population.
    overConfiguredCount: overConfiguredAll.length,
    idleOverConfiguredCount: idleOverConfiguredAll.length,
    unusedProjectCount: unusedProjectsAll.length,
    staleProjectCount: staleProjectsAll.length,
  };
}

// Workflow health for the Overview, as a summary rather than a second inventory.
//
// Entirely best-effort and entirely optional: the workflow snapshot is versioned
// separately from the field snapshot and may never have been built. Overview is the
// landing page, so nothing here may throw and nothing may block -- a missing workflow
// snapshot renders as a prompt to build one, not as an error.
export async function buildWorkflowOverview(installationKey) {
  try {
    const meta = await readWorkflowSnapshotMeta(installationKey);
    if (!meta?.version) return { available: false, state: meta?.state || "idle" };

    const [schemes, statuses, schemeStatuses] = await Promise.all([
      loadWorkflowSchemes(installationKey, meta.version),
      loadStatusesCatalog(installationKey, meta.version),
      loadWorkflowSchemeStatuses(installationKey, meta.version),
    ]);
    const issueCounts = await loadStatusIssueCounts(installationKey).catch(fallbackOn("resolver.status_counts_load_failed", () => new Map(), { installationKey }));
    const hasIssueCounts = issueCounts.size > 0;
    const schemeStatusesAvailable = schemeStatuses.length > 0;

    const duplicateGroups = findDuplicateStatusGroups(statuses);

    // Which of the unreachable statuses a rule actually references.
    //
    // Loaded here rather than left to the caller because the health score reads this
    // summary, and without it the score cannot tell a dead status from one an automation
    // rule transitions into. Best-effort: no automation analysis, or a failed lookup,
    // leaves this null and the affected dimensions say so rather than assuming zero.
    const provisionalOrphans = schemeStatusesAvailable
      ? findOrphanedStatuses(statuses, schemeStatuses, hasIssueCounts ? issueCounts : null)
      : [];
    const automationByStatus = provisionalOrphans.length
      ? await loadStatusAutomationReferences(
          installationKey,
          provisionalOrphans.map((o) => o.name).filter(Boolean)
        ).catch(fallbackOn("overview.status_automation_lookup_failed", () => null, { installationKey }))
      : null;

    const orphans = schemeStatusesAvailable
      ? findOrphanedStatuses(statuses, schemeStatuses, hasIssueCounts ? issueCounts : null, automationByStatus)
      : [];
    const balance = schemeStatusesAvailable
      ? computeSchemeCategoryBalance(schemes, schemeStatuses, statuses)
      : [];

    // Schemes governing more than one project are where standardization has any leverage:
    // a scheme used once is a bespoke process by definition.
    const sharedSchemes = schemes.filter((s) => (s.projectCount ?? 0) > 1).length;

    return {
      available: true,
      state: meta.state || "idle",
      refreshedAt: meta.refreshedAt || null,
      schemeCount: schemes.length,
      statusCount: statuses.length,
      sharedSchemes,
      schemeStatusesAvailable,
      hasIssueCounts,
      ...summarizeWorkflowInsights({ duplicateGroups, orphans, balance }),
    };
  } catch (error) {
    console.warn("buildWorkflowOverview failed:", error?.message || error);
    return { available: false, state: "error" };
  }
}

// Saved filter health for the Overview.
//
// Mirrors buildWorkflowOverview and buildScreenOverview, including their failure posture: a
// pillar that cannot be built reports unavailable and the score excludes it, rather than
// 500ing an overview that has five other pillars to show.
//
// `projectKeys` is passed in rather than loaded here, because the caller already has the
// project list and loading it twice to answer one join would double the cost of the page.
// Without it the broken-project check is skipped and says so -- "no broken references" and
// "nobody looked" are different claims.
export async function buildFilterOverview(installationKey, { projectKeys = null, typeNames = null } = {}) {
  try {
    const meta = await readFilterSnapshotMeta(installationKey);
    if (!meta?.version) return { available: false, state: meta?.state || "idle", lastError: meta?.lastError || null };

    const filters = await loadFilters(installationKey, meta.version);
    const summary = summarizeFilters(filters, { projectKeys, typeNames });

    return {
      available: summary.available,
      state: meta.state || "idle",
      refreshedAt: meta.refreshedAt || null,
      lastError: meta.lastError || null,
      ...summary,
      // The full per-filter list stays on the tab. The Overview needs the counts and the
      // worst few, not five hundred rows.
      filters: undefined,
      duplicateGroups: undefined,
      brokenProjects: undefined,
      unknownTypeRefs: undefined,
      worst: summary.filters.slice(0, 8).map((f) => ({
        id: f.id, name: f.name, ownerName: f.ownerName,
        subscriptionCount: f.subscriptionCount,
        code: f.findings[0]?.code ?? null,
      })),
      health: summarizeFilterHealth(summary),
    };
  } catch (error) {
    console.warn("buildFilterOverview failed:", error?.message || error);
    return { available: false, state: "error" };
  }
}

// Dashboard health for the Overview.
//
// Mirrors buildFilterOverview, including its failure posture: a pillar that cannot be built
// reports unavailable and the score excludes it, rather than 500ing an overview that has six
// other pillars to show.
export async function buildDashboardOverview(installationKey) {
  try {
    const meta = await readDashboardSnapshotMeta(installationKey);
    if (!meta?.version) return { available: false, state: meta?.state || "idle", lastError: meta?.lastError || null };

    const dashboards = await loadDashboards(installationKey, meta.version);
    const summary = summarizeDashboards(dashboards);

    return {
      available: summary.available,
      state: meta.state || "idle",
      refreshedAt: meta.refreshedAt || null,
      lastError: meta.lastError || null,
      // Carried so the tab can caveat its own number: a pass that reached 180 of 200
      // dashboards cannot claim any of the other 20 is empty.
      gadgetsWalked: meta.gadgetsWalked,
      ...summary,
      // The full per-dashboard list stays on the tab.
      dashboards: undefined,
      worst: summary.dashboards.slice(0, 8).map((d) => ({
        id: d.id, name: d.name, ownerName: d.ownerName,
        popularity: d.popularity, code: d.findings[0]?.code ?? null,
      })),
      health: summarizeDashboardHealth(summary),
    };
  } catch (error) {
    console.warn("buildDashboardOverview failed:", error?.message || error);
    return { available: false, state: "error" };
  }
}

// Screen health for the Overview, as aggregate counts rather than a second inventory.
//
// Mirrors buildWorkflowOverview, including its failure posture: a screens pillar that cannot
// be built reports unavailable and the score excludes it, rather than 500ing an overview
// that has nine other pillars to show.
export async function buildScreenOverview(installationKey) {
  try {
    // Both versions, because "is this screen reachable" spans two pillars: the scheme chain
    // lives in the screen snapshot and the transitions that open a screen live in the
    // workflow one. Without the second, reachability is unknowable rather than clean.
    const [meta, workflowMeta] = await Promise.all([
      readScreenSnapshotMeta(installationKey),
      readWorkflowSnapshotMeta(installationKey).catch(() => null),
    ]);
    if (!meta?.version) {
      return { available: false, state: meta?.state || "idle", lastError: meta?.lastError || null };
    }
    return {
      available: true,
      state: meta.state,
      refreshedAt: meta.refreshedAt || null,
      lastError: meta.lastError || null,
      ...(await loadScreenGovernanceSummary(installationKey, meta.version, {
        workflowVersion: workflowMeta?.version || null,
      })),
    };
  } catch (error) {
    console.warn("buildScreenOverview failed:", error?.message || error);
    return { available: false, state: "error" };
  }
}


// Issue type health for the Overview.
//
// Mirrors buildScreenOverview, including its failure posture: a pillar that cannot be built
// reports unavailable and the score excludes it, rather than 500ing an overview that has
// seven other pillars to show. `.health` is what feeds computeSiteHealth; the rest is for
// the tab.
export async function buildIssueTypeOverview(installationKey) {
  try {
    const meta = await readIssueTypeSnapshotMeta(installationKey);
    if (!meta?.version) return { available: false, state: meta?.state || "idle", lastError: meta?.lastError || null };

    const [types, schemes, schemeItems] = await Promise.all([
      loadIssueTypes(installationKey, meta.version),
      loadIssueTypeSchemes(installationKey, meta.version),
      loadIssueTypeSchemeItems(installationKey, meta.version),
    ]);
    const summary = summarizeIssueTypeInsights({ types, schemes, schemeItems });

    return {
      available: summary.available,
      state: meta.state || "idle",
      refreshedAt: meta.refreshedAt || null,
      lastError: meta.lastError || null,
      ...summary,
      // The full catalog stays on the tab.
      duplicateGroups: summary.duplicateGroups,
      orphanTypes: summary.orphanTypes,
      flaggedSchemes: summary.flaggedSchemes,
      // The set of defined type names, lowercased -- the filter pillar joins its JQL type
      // references against this to find saved searches that name a type nothing defines.
      typeNames: new Set(types.map((t) => String(t.name || "").toLowerCase()).filter(Boolean)),
      health: summarizeIssueTypeHealth(summary),
    };
  } catch (error) {
    console.warn("buildIssueTypeOverview failed:", error?.message || error);
    return { available: false, state: "error" };
  }
}

// The People pillar's health inputs: how many licensed accounts are deactivated, and how
// much owned config (filters / dashboards / rules) belongs to an account not in the roster.
export async function buildUserOverview(installationKey) {
  try {
    const meta = await readUserSnapshotMeta(installationKey);
    if (!meta?.version) return { available: false, state: meta?.state || "idle", lastError: meta?.lastError || null };

    const [users, summary, ownership, ruleUserIndex] = await Promise.all([
      loadUsers(installationKey, meta.version),
      loadUserGovernanceSummary(installationKey, meta.version),
      buildOwnershipIndex(installationKey).catch(() => ({ byAccount: new Map(), available: {} })),
      Promise.resolve().then(() => readAutomationPart(installationKey, "users")).catch(() => null),
    ]);

    const rosterIds = new Set(users.map((u) => u.accountId));
    const orphaned = summarizeOrphanedOwnership(ownership, rosterIds);
    const totalUsers = Number(summary?.totalUsers) || users.length;
    const deactivatedUsers = Math.max(0, totalUsers - (Number(summary?.activeUsers) || totalUsers));

    // People an automation rule names, and how many of those are not on the roster -- a rule
    // routing work to someone who has left. Estate counts only; the finding is on the Overview.
    let automationRefUsers = 0;
    let orphanedAutomationRefUsers = 0;
    for (const entry of ruleUserIndex?.entries ?? []) {
      automationRefUsers += 1;
      if (!rosterIds.has(String(entry.label))) orphanedAutomationRefUsers += 1;
    }

    return {
      available: totalUsers > 0,
      state: meta.state || "idle",
      refreshedAt: meta.refreshedAt || null,
      lastError: meta.lastError || null,
      totalUsers,
      deactivatedUsers,
      automationRefUsers,
      orphanedAutomationRefUsers,
      ...orphaned,
      health: {
        available: totalUsers > 0,
        totalUsers,
        deactivatedUsers,
        orphanedArtifacts: orphaned.orphanedArtifacts,
        ownedArtifactTotal: orphaned.ownedArtifactTotal,
      },
    };
  } catch (error) {
    console.warn("buildUserOverview failed:", error?.message || error);
    return { available: false, state: "error" };
  }
}

// The JSM Assets pillar's inputs: the schema / object-type / attribute structure, and the
// four things wrong with it a scan can find. `assetsEnabled: false` is a distinct outcome
// -- the build ran and Assets is not licensed on this site -- and the score treats that
// pillar as not-applicable rather than scoring it zero.
export async function buildAssetOverview(installationKey) {
  try {
    const meta = await readAssetSnapshotMeta(installationKey);
    if (!meta?.version && meta?.state !== "unavailable") {
      return { available: false, state: meta?.state || "idle", lastError: meta?.lastError || null };
    }

    if (meta?.state === "unavailable") {
      const summary = summarizeAssetInsights({ assetsEnabled: false });
      return {
        available: false,
        assetsEnabled: false,
        state: "unavailable",
        refreshedAt: meta?.refreshedAt || null,
        lastError: meta?.lastError || null,
        ...summary,
        health: summarizeAssetHealth(summary),
      };
    }

    const [schemas, objectTypes, attributes] = await Promise.all([
      loadAssetSchemas(installationKey, meta.version),
      loadAssetObjectTypes(installationKey, meta.version),
      loadAssetAttributes(installationKey, meta.version),
    ]);
    const summary = summarizeAssetInsights({ schemas, objectTypes, attributes, assetsEnabled: true });

    return {
      available: summary.available,
      assetsEnabled: true,
      state: meta.state || "idle",
      refreshedAt: meta.refreshedAt || null,
      workspaceId: meta.workspaceId || null,
      lastError: meta.lastError || null,
      ...summary,
      health: summarizeAssetHealth(summary),
    };
  } catch (error) {
    console.warn("buildAssetOverview failed:", error?.message || error);
    return { available: false, state: "error" };
  }
}

// The access pillar's inputs: permission, issue-security and notification schemes, and the
// governance signal for each -- least-privilege violations, data black holes, fragile
// routing, plus off-roster grants (the People cross-pillar join). Returns one object per
// scheme type, each with its own `health` block feeding a distinct pillar.
export async function buildAccessOverview(installationKey) {
  try {
    const meta = await readAccessSnapshotMeta(installationKey);
    if (!meta?.version) return { available: false, state: meta?.state || "idle", lastError: meta?.lastError || null };

    // Roster accountIds for the "grant to someone off the roster" checks.
    let rosterAccountIds = new Set();
    const userMeta = await readUserSnapshotMeta(installationKey).catch(() => null);
    if (userMeta?.version) {
      const users = await loadUsers(installationKey, userMeta.version).catch(() => []);
      rosterAccountIds = new Set(users.map((u) => u.accountId));
    }

    const [
      permSchemes, permHolders, permProjects,
      secSchemes, secHolders, secProjects, levels,
      notifSchemes, notifHolders, notifProjects,
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
    ]);

    const permissions = summarizePermissionInsights({ schemes: permSchemes, holders: permHolders, schemeProjects: permProjects, rosterAccountIds });
    const security = summarizeSecurityInsights({ schemes: secSchemes, levels, holders: secHolders, schemeProjects: secProjects, rosterAccountIds });
    const notifications = summarizeNotificationInsights({ schemes: notifSchemes, holders: notifHolders, schemeProjects: notifProjects, rosterAccountIds });

    return {
      available: true,
      state: meta.state || "idle",
      refreshedAt: meta.refreshedAt || null,
      lastError: meta.lastError || null,
      permissions: { ...permissions, health: summarizePermissionHealth(permissions) },
      security: { ...security, health: summarizeSecurityHealth(security) },
      notifications: { ...notifications, health: summarizeNotificationHealth(notifications) },
    };
  } catch (error) {
    console.warn("buildAccessOverview failed:", error?.message || error);
    return { available: false, state: "error" };
  }
}

// The estate-config pillar's input: the global value lists (resolutions, priorities) and
// the near-duplicate-name read over each. Same tri-state posture as every other pillar.
export async function buildEstateOverview(installationKey) {
  try {
    const meta = await readEstateSnapshotMeta(installationKey);
    if (!meta?.version) return { available: false, state: meta?.state || "idle", lastError: meta?.lastError || null };

    const [resolutions, priorities] = await Promise.all([
      loadEstateValues(installationKey, meta.version, "resolution"),
      loadEstateValues(installationKey, meta.version, "priority"),
    ]);

    const summary = summarizeEstateInsights({ resolutions, priorities });
    return {
      ...summary,
      state: meta.state || "idle",
      refreshedAt: meta.refreshedAt || null,
      lastError: meta.lastError || null,
      health: summarizeEstateHealth(summary),
    };
  } catch (error) {
    console.warn("buildEstateOverview failed:", error?.message || error);
    return { available: false, state: "error" };
  }
}

// Compute the score from scratch and record it.
//
// The one entry point anything outside the Overview should use. It gathers the same five
// inputs the Overview does, so a measurement recorded by a scan is the same measurement a
// person would have seen had they opened the page at that moment.
//
// Never throws. Every caller is a pipeline finishing successfully, and a scan that reported
// failure because its bookkeeping row could not be written would be lying about the scan.
export async function captureSiteHealth(installationKey, deps) {
  const {
    readSnapshotMeta,
    loadSnapshotFields,
    listSnapshotProjects,
    attachUniqueIssueCounts,
    buildDuplicateNameCountMap,
    hydrateFieldForGovernance,
    readAdminConfig,
    readAutomationAnalysis,
    recordHealthSnapshot,
  } = deps || {};

  // Called with no deps once, from the scan orchestrator, and it crashed every scan's health
  // stage. Degrade to a no-op rather than throw: a scan that reported failure because its
  // bookkeeping row could not be written would be lying about the scan.
  if (typeof readSnapshotMeta !== "function" || typeof recordHealthSnapshot !== "function") {
    return { recorded: false, reason: "missing-deps" };
  }

  try {
    const [meta, config, workflow, screens, issueTypeOverview, userOverview, assetOverview, accessOverview, estateOverview, automationAnalysis] = await Promise.all([
      readSnapshotMeta(installationKey),
      readAdminConfig(),
      buildWorkflowOverview(installationKey),
      buildScreenOverview(installationKey),
      buildIssueTypeOverview(installationKey),
      buildUserOverview(installationKey),
      buildAssetOverview(installationKey),
      buildAccessOverview(installationKey),
      buildEstateOverview(installationKey),
      readAutomationAnalysis(installationKey).catch(() => null),
    ]);
    let filters = null;
    let dashboards = null;

    let fieldUsage = null;
    let projects = null;
    let adoption = null;
    if (meta?.version) {
      const [fields, rawProjects] = await Promise.all([
        loadSnapshotFields(installationKey, meta.version),
        listSnapshotProjects(installationKey, meta.version),
      ]);
      const withCounts = await attachUniqueIssueCounts(installationKey, rawProjects);
      const dup = buildDuplicateNameCountMap(fields);
      const hydrated = fields.map((f) =>
        hydrateFieldForGovernance(f, null, dup.get(normalizeFieldName(f.name)) ?? 1, config.governanceThresholds)
      );
      fieldUsage = buildFieldUsageInsights(hydrated);
      projects = buildProjectInsights(withCounts);

      // Adoption reads the same project rows the shape insights do, plus the activity
      // series. Best-effort: a site scanned before issue dates were captured has no
      // activity, and the dimension reports itself unmeasured rather than scoring a rate
      // it could not derive.
      const activity = await loadProjectActivity(installationKey)
        .catch(fallbackOn("overview.project_activity_load_failed", () => new Map(), { installationKey }));
      adoption = summarizeAdoption(withCounts, activity);

      // The project keys the filter pillar needs for its broken-reference join, taken from
      // the rows already loaded rather than fetched again. `typeNames` is the same idea for
      // the JQL issue-type join, reusing what the issue-type overview already loaded.
      const projectKeys = new Set(withCounts.map((p) => p.projectKey).filter(Boolean));
      filters = (await buildFilterOverview(installationKey, { projectKeys, typeNames: issueTypeOverview?.typeNames ?? null })).health ?? null;
      dashboards = (await buildDashboardOverview(installationKey)).health ?? null;
    }

    const health = computeSiteHealth({
      fieldUsage,
      workflow,
      projects,
      automation: automationAnalysis?.estate?.health ?? { available: false },
      screens,
      adoption,
      filters,
      dashboards,
      issueTypes: issueTypeOverview?.health ?? null,
      users: userOverview?.health ?? null,
      assets: assetOverview?.health ?? null,
      permissions: accessOverview?.permissions?.health ?? null,
      security: accessOverview?.security?.health ?? null,
      notifications: accessOverview?.notifications?.health ?? null,
      estate: estateOverview?.health ?? null,
      tolerances: config?.healthTolerances,
    });

    await recordHealthSnapshot(installationKey, health);
    return { captured: true, score: health.score };
  } catch (error) {
    console.warn("captureSiteHealth: failed", error?.message || error);
    return { captured: false };
  }
}
