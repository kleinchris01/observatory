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
  loadScreenGovernanceSummary,
  loadStatusIssueCounts,
  loadStatusesCatalog,
  loadWorkflowSchemeStatuses,
  loadWorkflowSchemes,
  readScreenSnapshotMeta,
  readWorkflowSnapshotMeta,
} from "./project-store.js";

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

  // Configured well past the site norm while carrying little actual work. These are where
  // field governance conversations start, because the cost is real and the usage is not.
  // Guarded against a degenerate median: on a site where the median project has one field,
  // "twice the median" is noise, so require an absolute floor as well.
  //
  // The volume side must use volumeOf, not the fills sum. Against fills the absolute floor
  // of 50 could never bind -- an average project's fills run to six figures -- so the test
  // silently collapsed to the relative term alone.
  const totalVolume = projects.reduce((sum, p) => sum + volumeOf(p), 0);
  const overConfiguredFloor = Math.max(10, medianFieldCount * 2);
  const lightVolumeCeiling = Math.max(50, totalVolume / Math.max(1, projects.length) / 4);
  const overConfigured = projects
    .filter((p) => p.fieldCount >= overConfiguredFloor && volumeOf(p) < lightVolumeCeiling)
    .sort((a, b) => b.fieldCount - a.fieldCount)
    .slice(0, DASHBOARD_TOP_N)
    .map((p) => ({
      projectKey: p.projectKey,
      projectName: p.projectName,
      fieldCount: p.fieldCount,
      totalIssueCount: p.totalIssueCount,
      uniqueIssueCount: p.uniqueIssueCount ?? null,
      volume: volumeOf(p),
    }));

  // Fields configured, no issues recorded at all -- either abandoned or never started.
  const unusedProjects = projects
    .filter((p) => p.fieldCount > 0 && p.totalIssueCount === 0)
    .sort((a, b) => b.fieldCount - a.fieldCount)
    .slice(0, DASHBOARD_TOP_N)
    .map((p) => ({ projectKey: p.projectKey, projectName: p.projectName, fieldCount: p.fieldCount }));

  // Staleness is a per-project signal the field view never surfaces: a project can carry
  // 60 fields and 40,000 issues and still have had nothing touched in a year.
  const now = Date.now();
  const STALE_MS = 180 * 24 * 60 * 60 * 1000;
  const staleProjects = projects
    .filter((p) => {
      const at = Date.parse(p.latestIssueUpdatedAt || "");
      return p.totalIssueCount > 0 && Number.isFinite(at) && now - at > STALE_MS;
    })
    .sort((a, b) => Date.parse(a.latestIssueUpdatedAt) - Date.parse(b.latestIssueUpdatedAt))
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
    topByIssueVolume,
    topByFieldCount,
    overConfigured,
    unusedProjects,
    staleProjects,
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
    const orphans = schemeStatusesAvailable
      ? findOrphanedStatuses(statuses, schemeStatuses, hasIssueCounts ? issueCounts : null)
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

// Screen health for the Overview, as aggregate counts rather than a second inventory.
//
// Mirrors buildWorkflowOverview, including its failure posture: a screens pillar that cannot
// be built reports unavailable and the score excludes it, rather than 500ing an overview
// that has nine other pillars to show.
export async function buildScreenOverview(installationKey) {
  try {
    const meta = await readScreenSnapshotMeta(installationKey);
    if (!meta?.version) {
      return { available: false, state: meta?.state || "idle", lastError: meta?.lastError || null };
    }
    return {
      available: true,
      state: meta.state,
      refreshedAt: meta.refreshedAt || null,
      lastError: meta.lastError || null,
      ...(await loadScreenGovernanceSummary(installationKey, meta.version)),
    };
  } catch (error) {
    console.warn("buildScreenOverview failed:", error?.message || error);
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
  } = deps;

  try {
    const [meta, config, workflow, screens, automationAnalysis] = await Promise.all([
      readSnapshotMeta(installationKey),
      readAdminConfig(),
      buildWorkflowOverview(installationKey),
      buildScreenOverview(installationKey),
      readAutomationAnalysis(installationKey).catch(() => null),
    ]);

    let fieldUsage = null;
    let projects = null;
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
    }

    const health = computeSiteHealth({
      fieldUsage,
      workflow,
      projects,
      automation: automationAnalysis?.estate?.health ?? { available: false },
      screens,
      tolerances: config?.healthTolerances,
    });

    await recordHealthSnapshot(installationKey, health);
    return { captured: true, score: health.score };
  } catch (error) {
    console.warn("captureSiteHealth: failed", error?.message || error);
    return { captured: false };
  }
}
