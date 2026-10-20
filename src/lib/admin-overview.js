// The admin Overview's aggregation, as pure functions over data that has already been loaded.
//
// Split out of getAdminOverview in src/resolvers/overview.js (docs/resolvers-refactor.md,
// follow-up 2). The resolver keeps the reads -- twenty pillar summaries in parallel, the field
// and project snapshot, project activity, the stored screen cross -- and the logging around
// them; everything it does with them afterwards lives here, where it is tested on plain data.

import { buildFieldUsageInsights, buildProjectInsights } from "./site-health.js";
import { summarizeAdoption } from "./project-adoption.js";
import { summarizeFindings, summarizeFindingsByCode } from "./analysis.js";

export const EMPTY_DASHBOARD = {
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

export const EMPTY_FINDINGS_SUMMARY = { adminAttention: 0, risky: 0, cleanup: 0, standardize: 0 };

const EMPTY_JOB_COUNTS = { queued: 0, building: 0, ready: 0, failed: 0, cancelled: 0, unbuilt: 0 };

// The field-summary job counts, or all zeros when the count query failed.
export function jobCountsOf(summaryCounts) {
  return summaryCounts?.counts ?? { ...EMPTY_JOB_COUNTS };
}

// Adoption travels beside the shape insights rather than inside them: one asks how a project is
// configured and the other asks whether anyone is using it, and folding them together is what
// let a three-week-old project read as abandoned.
//
// Only the counts and a short worst-first list reach the Overview. The full per-project series
// is what the Projects tab loads, and shipping 200 projects' worth of monthly history with the
// landing page would dwarf everything else on it.
export function overviewAdoption(adoption) {
  return {
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
        projectKey: row.projectKey,
        projectName: row.projectName,
        declineFrom: row.declineFrom,
        peakMonth: row.peakMonth,
        peakIssues: row.peakIssues,
        issuesPerDay: row.issuesPerDay,
        recentIssuesPerDay: row.recentIssuesPerDay,
        momentum: row.momentum,
        score: row.score,
      })),
  };
}

// Findings and the dashboard cards, from fields already hydrated for governance against the
// current thresholds and projects already carrying their unique issue counts.
export function buildOverviewDashboard({ hydrated, projects, activity }) {
  return {
    findingsSummary: summarizeFindings(hydrated),
    // The counts several Overview cards each need -- "23 fields with a dead-configuration
    // ratio" is a specific reason code, not one of the four coarse categories findingsSummary
    // already tracks, and only this join knows the number.
    findingsByCode: summarizeFindingsByCode(hydrated),
    dashboard: {
      fieldUsage: buildFieldUsageInsights(hydrated),
      projects: buildProjectInsights(projects),
      adoption: overviewAdoption(summarizeAdoption(projects, activity)),
    },
  };
}

// The automation pillar's health, which the analysis computes and stores so the score never
// needs the rules, plus the block the Overview returns.
//
// The whole health summary, not just three headline fields. While this was trimmed to
// {available, refreshedAt, ruleCount}, every automation problem the analysis had already found
// was invisible on the landing page that exists to surface problems.
export function overviewAutomation(automationAnalysis) {
  const health = automationAnalysis?.estate?.health ?? { available: false };
  return {
    health,
    summary: {
      ...health,
      available: Boolean(health?.available),
      refreshedAt: automationAnalysis?.refreshedAt ?? null,
      ruleCount: health?.ruleCount ?? 0,
    },
  };
}

// The inputs computeSiteHealth scores, from each pillar's overview. A pillar that could not be
// read passes null and is scored as unmeasured, never as zero.
export function siteHealthInputs({
  dashboard,
  workflow,
  automationHealth,
  screens,
  screenCross,
  filterOverview,
  dashboardOverview,
  issueTypeOverview,
  userOverview,
  assetOverview,
  accessOverview,
  estateOverview,
  fieldConfigOverview,
  boardOverview,
  jsmOverview,
  driftHealth,
  config,
  priorValues,
}) {
  return {
    fieldUsage: dashboard?.fieldUsage,
    workflow,
    projects: dashboard?.projects,
    automation: automationHealth,
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
    requestTypes: jsmOverview?.health?.requestTypes ?? null,
    queues: jsmOverview?.health?.queues ?? null,
    slas: jsmOverview?.health?.slas ?? null,
    customers: jsmOverview?.health?.customers ?? null,
    drift: driftHealth,
    // Workflow, project and automation dimensions were scored against hardcoded constants
    // while every field rule was tunable. Same config surface now feeds both.
    tolerances: config?.healthTolerances,
    targets: config?.healthTargets,
    priorValues,
  };
}
