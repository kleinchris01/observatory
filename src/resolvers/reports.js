// Reports and search: pillar health and reports, per-item usage, and OQL across every pillar.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES, getInstallationKey } from "../lib/jira-api.js";
import { hydrateFieldForGovernance } from "../lib/snapshot-engine.js";
import {
  ensureProjectStoreReady,
  readSnapshotMeta,
  loadSnapshotFields,
  listSnapshotProjects,
  loadProjectActivity,
  readFilterSnapshotMeta,
  loadDashboards,
  readDashboardSnapshotMeta,
  readWorkflowSnapshotMeta,
  transitionAwareWorkflowVersion,
  loadWorkflowSchemes,
  loadStatusesCatalog,
  readScreenSnapshotMeta,
  loadScreenSchemeOperations,
  loadItssMappings,
  loadItssProjects,
  readScreenCrossSummary,
  loadIssueTypeSchemeItems,
  readDriftSnapshotMeta,
  loadConfigChanges,
  changeCursorOf,
  loadHealthHistory,
  readUsageMeta,
  loadUsageTally,
  USAGE_PILLARS,
  USAGE_WINDOW_DAYS,
} from "../lib/project-store.js";
import { getFieldConfigInventory } from "../lib/fieldconfig-reads.js";
import {
  buildPillarReport,
  unavailableReport,
  isPillarReportKey,
  countScreenProjects,
  REPORT_ROW_LIMIT,
} from "../lib/pillar-reports.js";
import { parseOql, evaluate as evaluateOql, sortEntities as sortOqlEntities, pinnedPillars } from "../lib/oql.js";
import { buildOqlCatalog, buildEntityIndex, OQL_PILLARS, CHURN_WINDOW_DAYS } from "../lib/oql-index.js";
import { rankEntityMatches, ENTITY_SEARCH_MIN_TERM } from "../lib/entity-search.js";
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
  buildJsmOverview,
  buildDriftHealthOverview,
  attachUniqueIssueCounts,
} from "../lib/site-health.js";
import { summarizeAdoption } from "../lib/project-adoption.js";
import { hydrateRuleDirectory } from "../lib/automation-analysis.js";
import { readAutomationAnalysis, readAutomationPart } from "../lib/store/automation.js";
import { normalizeFieldName, buildDuplicateNameCountMap } from "../lib/analysis.js";
import { logger, fallbackOn } from "../lib/logger.js";
import { requireNonEmptyString } from "../lib/validate.js";
import { readAdminConfig } from "./admin-config.js";
import { getIssueTypeInventory } from "./issue-types.js";
import { getUserInventory } from "./people.js";
import { getAccessInventory } from "./access.js";
import { getAssetInventory } from "./assets.js";
import { getBoardInventory } from "./boards.js";
import { CHANGE_WINDOW_DAYS } from "./changes.js";
import { getEstateInventory } from "./estate.js";
import { loadJsmView } from "./jsm.js";
import { loadFiltersWithFindings } from "./filters-dashboards.js";
import { loadAllScreenPages } from "./screens.js";

// Usage per item for one pillar: how many issues, how many in the last 90 days, and when last,
// counted by the issue crawl (store/usage.js). Tri-state like everything else -- no complete
// crawl yet is "not measured", never a table of zeros -- and `basis` travels with the numbers
// so the tab labels them from the same rule that counted them.
export async function getPillarUsage({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  const pillar = String(payload?.pillar || "");
  const spec = USAGE_PILLARS[pillar];
  if (!spec) return { available: false, reason: "unknown-pillar", pillar, items: {} };
  const base = { pillar, basis: spec.basis, windowDays: USAGE_WINDOW_DAYS };
  const meta = await readUsageMeta(installationKey).catch(
    fallbackOn("usage.meta_read_failed", () => null, { installationKey }),
  );
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
export const PILLAR_INPUTS = {
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
  requestTypes: ["jsm"],
  queues: ["jsm"],
  slas: ["jsm"],
  customers: ["jsm"],
};

export async function getPillarHealth({ payload, context }) {
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
  const [
    workflow,
    screens,
    filterOverview,
    dashboardOverview,
    issueTypeOverview,
    userOverview,
    assetOverview,
    accessOverview,
    estateOverview,
    boardOverview,
    driftHealth,
    automationAnalysis,
    fieldConfigOverview,
    jsmOverview,
  ] = await Promise.all([
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
      ? readAutomationAnalysis(installationKey).catch(
          fallbackOn("pillar-health.automation_load_failed", () => null, { installationKey }),
        )
      : Promise.resolve(null),
    needs.has("fieldConfigs") ? buildFieldConfigOverview(installationKey) : Promise.resolve(null),
    needs.has("jsm") ? buildJsmOverview(installationKey) : Promise.resolve(null),
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
          fieldUsage = buildFieldUsageInsights(
            fields.map((f) =>
              hydrateFieldForGovernance(f, null, dup.get(normalizeFieldName(f.name)) ?? 1, config.governanceThresholds),
            ),
          );
        }

        if (needs.has("projects") || needs.has("adoption")) {
          const withCounts = await attachUniqueIssueCounts(
            installationKey,
            await listSnapshotProjects(installationKey, meta.version),
          );
          projects = buildProjectInsights(withCounts);
          // Best-effort, like every optional pillar input: a site scanned before issue dates
          // were captured has no activity, and the dimension says so rather than scoring zero.
          const activity = await loadProjectActivity(installationKey).catch(
            fallbackOn("pillar-health.project_activity_load_failed", () => new Map(), { installationKey }),
          );
          adoption = summarizeAdoption(withCounts, activity);
        }
      } catch (error) {
        logger.warn("pillar-health.field_inputs_failed", { installationKey, error: String(error?.message || error) });
      }
    }
  }

  const screenCross = await readScreenCrossSummary(installationKey).catch(
    fallbackOn("macro.screen_cross_read_failed", () => null, { installationKey }),
  );

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
    requestTypes: jsmOverview?.health?.requestTypes ?? null,
    queues: jsmOverview?.health?.queues ?? null,
    slas: jsmOverview?.health?.slas ?? null,
    customers: jsmOverview?.health?.customers ?? null,
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
  const recorded = await loadHealthHistory(installationKey, { days: 1 }).catch(
    fallbackOn("pillar-health.history_load_failed", () => [], { installationKey }),
  );
  const latest = recorded[recorded.length - 1] ?? null;

  return { pillar, score: latest?.score ?? null, grade: latest?.grade ?? null };
}

// One pillar's inventory as an exportable report, in the shape every pillar shares -- see
// pillar-reports.js for the contract. This is only the I/O: each branch loads what that
// pillar's own tab already loads (reusing its resolver where one returns the full list) and
// hands it to the pure builder.
//
// An unbuilt pillar returns status "unavailable" with the reason, never an empty report.
export async function getPillarReport({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const key = requireNonEmptyString(payload?.pillar, "pillar");
  if (!isPillarReportKey(key)) throw new Error(`Unknown pillar report "${key}"`);

  const input = await loadPillarReportInput(key, { installationKey, context });
  if (input.unavailable) return unavailableReport(key, input.unavailable);
  return buildPillarReport(key, input);
}

export const notBuilt = (what) => `No ${what} inventory has been built yet. Run a scan from the Scans tab.`;

// OQL: one query across every pillar's report rows (see src/lib/oql.js, oql-index.js).
//
// Parses before it loads anything, so a typo costs nothing. A query that pins its pillars
// (`pillar = screens AND ...`) loads only those; anything else loads every pillar, a few at a
// time. A pillar that is unbuilt or fails to load is returned as such in `pillars`, never
// silently left out -- "no matches" and "not searched" are different answers.
export const OQL_RESULT_LIMIT = 1000;

export const OQL_LOAD_CONCURRENCY = 3;

// Every named pillar's full report, a few at a time. A pillar that is unbuilt or throws comes
// back as an unavailable report rather than being dropped, so callers can say which pillars
// they could not search. Shared by OQL and the Ctrl+K entity search.
async function loadOqlReports(keys, { installationKey, context }) {
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
        reports[i] = unavailableReport(
          key,
          "This pillar could not be read just now. Try again, or rebuild it from the Scans tab.",
        );
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(OQL_LOAD_CONCURRENCY, keys.length) }, worker));
  return reports;
}

export async function runOqlQuery({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const text = String(payload?.query ?? "").slice(0, 2000);
  const now = new Date();

  const parsed = parseOql(text, buildOqlCatalog(), { now });
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const pinned = pinnedPillars(parsed.query.where);
  const keys = OQL_PILLARS.map((p) => p.key).filter((key) => !pinned || pinned.has(key));
  const reports = await loadOqlReports(keys, { installationKey, context });

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

// Ctrl+K: find an item by name or ID across every pillar and rank it for jumping to, not for
// attention (see src/lib/entity-search.js). Same loading as OQL, without the churn window --
// a jump-to box has no use for it. `unavailable` names the pillars that were not searched, so
// "no results" is never claimed for a pillar that was never read.
export async function searchEntities({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  const term = String(payload?.term ?? "")
    .trim()
    .slice(0, 200);
  if (term.length < ENTITY_SEARCH_MIN_TERM) return { ok: true, term, total: 0, results: [], unavailable: [] };

  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const reports = await loadOqlReports(
    OQL_PILLARS.map((p) => p.key),
    { installationKey, context },
  );
  const index = buildEntityIndex(reports);
  const { total, results } = rankEntityMatches(index.entities, term, { limit: payload?.limit });
  return {
    ok: true,
    term,
    total,
    results,
    unavailable: index.pillars
      .filter((p) => p.status !== "ok")
      .map((p) => ({ key: p.key, label: p.label, reason: p.reason })),
  };
}

// The change log's trailing churn window, or null when no drift pass has ever run -- churn is
// then unmeasured, not zero. Keyset pages of 500, capped: past the cap the counts are floors,
// which still rank the busiest items high.
export const OQL_CHURN_CHANGE_CAP = 20000;

export async function loadOqlChurnWindow(installationKey, now) {
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

export async function loadPillarReportInput(key, { installationKey, context }) {
  switch (key) {
    case "fields": {
      const meta = await readSnapshotMeta(installationKey);
      if (!meta?.version) return { unavailable: notBuilt("field") };
      const [fields, config] = await Promise.all([
        loadSnapshotFields(installationKey, meta.version),
        readAdminConfig(),
      ]);
      const dup = buildDuplicateNameCountMap(fields);
      return {
        refreshedAt: meta.refreshedAt || meta.completedAt,
        fields: fields.map((f) =>
          hydrateFieldForGovernance(f, null, dup.get(normalizeFieldName(f.name)) ?? 1, config.governanceThresholds),
        ),
      };
    }
    case "projects": {
      const meta = await readSnapshotMeta(installationKey);
      if (!meta?.version) return { unavailable: notBuilt("project") };
      const projects = await attachUniqueIssueCounts(
        installationKey,
        await listSnapshotProjects(installationKey, meta.version),
      );
      const activity = await loadProjectActivity(installationKey).catch(
        fallbackOn("pillar-report.project_activity_load_failed", () => new Map(), { installationKey }),
      );
      return {
        refreshedAt: meta.refreshedAt || meta.completedAt,
        projects,
        adoption: summarizeAdoption(projects, activity),
      };
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
      return {
        refreshedAt: inventory.refreshedAt,
        issueTypes: inventory.issueTypes,
        schemeItems,
        usage: inventory.usage,
      };
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
        ? new Set(
            (await loadAllScreenPages(installationKey, meta.version, { workflowVersion, filter: "unreached" })).map(
              (r) => String(r.screenId),
            ),
          )
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
    case "jsm": {
      const view = await loadJsmView(installationKey);
      if (view.neverBuilt) return { unavailable: notBuilt("Service Management") };
      return view;
    }
    case "automation": {
      const [analysis, directory] = await Promise.all([
        readAutomationAnalysis(installationKey).catch(() => null),
        readAutomationPart(installationKey, "directory").catch(() => null),
      ]);
      if (!directory)
        return { unavailable: "No automation rules have been imported yet. Import them from the Automation tab." };
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
