// Admin Overview: the landing page's site summary, first-run state and health history.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { kvs } from "@forge/kvs";
import { incrMetric, METRIC_NAMES, getInstallationKey } from "../lib/jira-api.js";
import { hydrateFieldForGovernance } from "../lib/snapshot-engine.js";
import {
  ensureProjectStoreReady,
  readSnapshotMeta,
  loadSnapshotFields,
  listSnapshotProjects,
  loadProjectActivity,
  countFieldSummariesByStatus,
  countOldScopeKeyRows,
  readWorkflowSnapshotMeta,
  readScreenCrossSummary,
  recordHealthSnapshot,
  loadPriorHealthDimensions,
  readFullScanMeta,
  loadHealthHistory,
} from "../lib/project-store.js";
import { computeSiteHealth } from "../lib/health-score.js";
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
} from "../lib/site-health.js";
import { summarizeAdoption } from "../lib/project-adoption.js";
import { fullScanStageCatalog, readStageProducedCounts } from "../lib/full-scan-runner.js";
import { readAutomationAnalysis } from "../lib/store/automation.js";
import {
  normalizeFieldName,
  buildDuplicateNameCountMap,
  summarizeFindings,
  summarizeFindingsByCode,
} from "../lib/analysis.js";
import { logger, fallbackOn } from "../lib/logger.js";
import { ADMIN_CONFIG_KEY, DEFAULT_FIRST_RUN, readAdminConfig } from "./admin-config.js";

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

export const FIRST_RUN_ACK_STEPS = ["evidence-rule", "share-macro"];

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
    readAutomationAnalysis(installationKey).catch(
      fallbackOn("first_run.automation_read_failed", null, { installationKey }),
    ),
    readWorkflowSnapshotMeta(installationKey).catch(
      fallbackOn("first_run.workflow_meta_read_failed", null, { installationKey }),
    ),
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
      detail:
        "Zero is what makes something look safe to delete, so Observatory only shows a zero when a scan actually looked and found none. Anything it has not measured says so instead. Every screen depends on that distinction.",
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
      detail:
        "The Confluence macro gives a read-only view of fields, screens, boards and workflows, filtered to whatever projects each reader can already browse in Jira. It is how this stops being a tool only one person opens.",
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
export async function firstRunArrivals(installationKey, { anySnapshot, meta }) {
  if (!anySnapshot) return { available: false, landed: [], pending: [] };
  // A site whose snapshots predate stage bookkeeping, or whose meta row did not survive,
  // has nothing to say here. Rendering the catalog anyway would put fifteen "not started"
  // rows in front of an admin whose estate has in fact been read -- worse than silence.
  if (!meta?.stages?.length) return { available: false, landed: [], pending: [] };

  // The only read here that can fail. Losing it costs the counts, not the list: a stage that
  // landed is still reported as landed, and what is unknown is how many -- said by omitting
  // the number rather than by printing a zero.
  const counts = await readStageProducedCounts(installationKey, "full").catch(
    fallbackOn("first_run.stage_counts_read_failed", {}, { installationKey }),
  );

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
  const [
    meta,
    summaryCounts,
    config,
    legacySummaryCount,
    workflow,
    screens,
    issueTypeOverview,
    userOverview,
    assetOverview,
    accessOverview,
    estateOverview,
    boardOverview,
    driftHealth,
    filterOverview,
    dashboardOverview,
    automationAnalysis,
    fieldConfigOverview,
  ] = await Promise.all([
    readSnapshotMeta(installationKey),
    // Counted in SQL rather than loaded. This used to pull up to 5,000 summary rows --
    // including two LONGTEXT columns -- across the wire, and use them for a count grouped by
    // status and a total. Same six integers, one row back.
    countFieldSummariesByStatus(installationKey).catch(
      fallbackOn("overview.summary_counts_failed", () => ({ counts: null, total: 0 }), { installationKey }),
    ),
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
    readAutomationAnalysis(installationKey).catch(
      fallbackOn("overview.automation_load_failed", () => null, { installationKey }),
    ),
    buildFieldConfigOverview(installationKey),
  ]);

  // The rates are computed at analysis time and stored, so the score never needs the rules.
  const automation = automationAnalysis?.estate?.health ?? { available: false };

  const jobCounts = summaryCounts.counts ?? { queued: 0, building: 0, ready: 0, failed: 0, cancelled: 0, unbuilt: 0 };

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
        hydrateFieldForGovernance(f, null, dup.get(normalizeFieldName(f.name)) ?? 1, config.governanceThresholds),
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
      const activity = await loadProjectActivity(installationKey).catch(
        fallbackOn("overview.project_activity_load_failed", () => new Map(), { installationKey }),
      );
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

  const priorHealthValues = await loadPriorHealthDimensions(installationKey).catch(
    fallbackOn("overview.prior_health_load_failed", () => ({}), { installationKey }),
  );

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
      percent:
        meta?.totalFields > 0 ? Math.min(100, Math.round(((meta.processedFields || 0) / meta.totalFields) * 100)) : 0,
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
export async function getHealthHistory({ payload, context }) {
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
  const dimensions = Object.entries(latest.dimensions)
    .map(([key, score]) => {
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
    })
    .sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0));

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
