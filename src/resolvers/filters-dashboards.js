// Filters and dashboards pillars: inventories, builds, and the field/filter/dashboard usage joins.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES, getInstallationKey } from "../lib/jira-api.js";
import {
  ensureProjectStoreReady,
  readSnapshotMeta,
  listSnapshotProjects,
  loadFilters,
  readFilterSnapshotMeta,
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
  readIssueTypeSnapshotMeta,
  loadIssueTypes,
} from "../lib/project-store.js";
import { summarizeFilters, summarizeFilterHealth } from "../lib/filter-insights.js";
import { summarizeDashboards, summarizeDashboardHealth } from "../lib/dashboard-insights.js";
import { isFilterBuildStale, queueFilterSnapshotBuild } from "../lib/filter-engine.js";
import { filterRows, sortFilters, filterFindingCounts, FILTER_SORTS } from "../lib/filter-query.js";
import { isDashboardBuildStale, queueDashboardSnapshotBuild } from "../lib/dashboard-engine.js";
import { fallbackOn, logger, errorContext } from "../lib/logger.js";
import { requirePositiveInt, requireBoundedInt, optionalString } from "../lib/validate.js";
import { readAdminConfig } from "./admin-config.js";

// The saved filter inventory, with its governance findings.
//
// Everything is derived at read time from the snapshot rather than stored pre-analysed: the
// analysis is pure over a few hundred rows, and storing it would mean a second thing to keep
// in step with the filters -- a stored finding and a rebuilt snapshot can disagree, and a
// derived one cannot.
// Every saved filter with its findings attached, plus the summary those findings came from.
// Shared by the paginated Filters tab read and the pillar report, which needs every row.
export async function loadFiltersWithFindings(installationKey, version) {
  const [filters, snapshotMeta] = await Promise.all([
    loadFilters(installationKey, version),
    readSnapshotMeta(installationKey),
  ]);

  // The project catalog, for the broken-reference join. Best-effort: without it that one
  // finding is skipped and `projectsChecked` says so, rather than reporting zero broken
  // references because nobody looked.
  let projectKeys = null;
  if (snapshotMeta?.version) {
    const projects = await listSnapshotProjects(installationKey, snapshotMeta.version).catch(
      fallbackOn("filters.project_keys_load_failed", () => [], { installationKey }),
    );
    // Both the key and the display name: JQL accepts `project = KEY` and
    // `project = "Display Name"` equally, and a filter written the second way was being
    // reported as broken -- a project that genuinely exists, referenced by a name this set
    // never carried, indistinguishable from a real dangling reference to the check below.
    if (projects.length) {
      projectKeys = new Set(projects.flatMap((p) => [p.projectKey, p.projectName]).filter(Boolean));
    }
  }

  // The issue type catalog, for the "JQL names a type nothing defines" join. Same
  // best-effort posture: skipped and flagged rather than reported as zero.
  let typeNames = null;
  const itMeta = await readIssueTypeSnapshotMeta(installationKey).catch(() => null);
  if (itMeta?.version) {
    const types = await loadIssueTypes(installationKey, itMeta.version).catch(
      fallbackOn("filters.type_names_load_failed", () => [], { installationKey }),
    );
    if (types.length) typeNames = new Set(types.map((t) => String(t.name || "").toLowerCase()).filter(Boolean));
  }

  const summary = summarizeFilters(filters, { projectKeys, typeNames });
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
  return { summary, summaryForWire, withFindings };
}

export async function getFilterInventory({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const params = payload || {};
    if (params.page !== undefined && params.page !== null) requirePositiveInt(params.page, "page");
    if (params.pageSize !== undefined && params.pageSize !== null)
      requireBoundedInt(params.pageSize, "pageSize", 1, 100);
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

    const { summaryForWire, summary, withFindings } = await loadFiltersWithFindings(installationKey, meta.version);

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
    logger.error("getFilterInventory.failed", errorContext(error));
    throw error;
  }
}

// Queue a rebuild of the filter inventory.
export async function buildFilterInventory({ context }) {
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
export async function getFieldFilterCounts({ payload, context }) {
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
export async function getFieldDashboardCounts({ payload, context }) {
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
export async function getDashboardUsage({ payload, context }) {
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
        available: true,
        label,
        total: 0,
        dashboards: [],
        viaFilters: 0,
        coverage,
        complete,
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
    logger.error("getDashboardUsage.failed", errorContext(error));
    throw error;
  }
}

export async function getFilterUsage({ payload, context }) {
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
    logger.error("getFilterUsage.failed", errorContext(error));
    throw error;
  }
}

// The dashboard inventory, with its governance findings.
//
// Derived at read time from the snapshot rather than stored pre-analysed, like the filter
// pillar: the analysis is pure over a few hundred rows, and a stored finding can disagree
// with a rebuilt snapshot where a derived one cannot.
export async function getDashboardInventory({ context }) {
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
    const filterMeta = await readFilterSnapshotMeta(installationKey).catch(
      fallbackOn("dashboard_inventory.filter_meta_read_failed", null, { installationKey }),
    );

    let fieldRefsAvailable = false;
    if (filterMeta?.version) {
      const filterIds = [
        ...new Set(dashboards.flatMap((d) => (d.gadgets || []).map((g) => g.filterId).filter(Boolean))),
      ];
      if (filterIds.length) {
        // Two independent joins off the same filter id list: which fields a filter touches
        // (already existed, rolled up per dashboard) and what the filter is actually called
        // (new -- a gadget's config only ever carries the id). Neither failing should sink
        // the other, so each gets its own fallback rather than one Promise.all rejecting both.
        const [fieldsByFilter, filterNamesById] = await Promise.all([
          loadFieldNamesForFilterIds(installationKey, filterMeta.version, filterIds).catch(
            fallbackOn("dashboard_inventory.field_join_failed", new Map(), { installationKey }),
          ),
          loadFilterNamesForIds(installationKey, filterMeta.version, filterIds).catch(
            fallbackOn("dashboard_inventory.filter_name_join_failed", new Map(), { installationKey }),
          ),
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
          if (gadget.filterId) {
            gadget.fieldRefs = null;
            gadget.filterName = null;
            gadget.filterViewUrl = null;
          }
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
      // Enumeration pages Jira's dashboard/search returned a permanent 400 on and the build
      // stepped over rather than failing on. Non-zero means the inventory is missing up to
      // ~50 dashboards per page skipped -- same "say what we couldn't read" reason as above.
      pagesUnreadable: meta.pagesUnreadable || 0,
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
    logger.error("getDashboardInventory.failed", errorContext(error));
    throw error;
  }
}

// Queue a rebuild of the dashboard inventory.
export async function buildDashboardInventory({ context }) {
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
