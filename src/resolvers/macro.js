// Confluence macro pillar reads, each scoped to the projects the viewer can browse.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES, getInstallationKey } from "../lib/jira-api.js";
import {
  ensureProjectStoreReady,
  loadFilters,
  readFilterSnapshotMeta,
  loadDashboards,
  readDashboardSnapshotMeta,
  readWorkflowSnapshotMeta,
  loadProjectWorkflowSchemeMap,
  loadStatusesCatalog,
  loadWorkflowSchemeStatuses,
  readScreenSnapshotMeta,
  loadScreensForProjects,
  readIssueTypeSnapshotMeta,
  loadIssueTypes,
  loadIssueTypeSchemes,
  loadIssueTypeSchemeItems,
  loadIssueTypeSchemeProjects,
  readBoardSnapshotMeta,
  loadBoards,
} from "../lib/project-store.js";
import { fallbackOn } from "../lib/logger.js";
import { MACRO_PILLAR_PAGE_SIZE, macroPaginate, viewerProjects } from "./viewer.js";

export async function getMacroFilters({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const query = String(payload?.query || "")
    .trim()
    .toLowerCase();

  const meta = await readFilterSnapshotMeta(installationKey).catch(
    fallbackOn("macro_filters.meta_read_failed", null, { installationKey }),
  );
  const scope = await viewerProjects(installationKey, context);
  if (!meta?.version || !scope.available) {
    return {
      available: false,
      reason: "no-inventory",
      filters: [],
      projectCount: scope.projects.length,
      page: 1,
      pageSize: MACRO_PILLAR_PAGE_SIZE,
      totalPages: 0,
      total: 0,
      matchedTotal: 0,
    };
  }

  const all = await loadFilters(installationKey, meta.version).catch(() => []);
  const browsableIds = scope.projectIds;

  const mine = all
    .map((f) => {
      // A filter is "in scope" if its JQL names a browsable project, or it is shared to one.
      const refProjects = (f.projectRefs || []).filter((k) => scope.projectKeys.has(String(k).toLowerCase()));
      const sharedToProject = (f.shares || []).some(
        (s) => s.type === "project" && browsableIds.has(String(s.targetId)),
      );
      if (!refProjects.length && !sharedToProject) return null;
      return {
        id: f.id,
        name: f.name,
        jql: f.jql || "",
        owner: f.ownerName || null,
        projects: refProjects,
        fields: f.fieldRefs || [],
        viewUrl: f.viewUrl || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  const matched = query
    ? mine.filter((f) => f.name.toLowerCase().includes(query) || f.jql.toLowerCase().includes(query))
    : mine;
  const { slice, page, pageSize, totalPages } = macroPaginate(matched, payload?.page);

  return {
    available: true,
    filters: slice,
    projectCount: scope.projects.length,
    page,
    pageSize,
    totalPages,
    total: mine.length,
    matchedTotal: matched.length,
    snapshotRefreshedAt: meta.refreshedAt || meta.completedAt || null,
  };
}

export async function getMacroDashboards({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const query = String(payload?.query || "")
    .trim()
    .toLowerCase();

  const dashMeta = await readDashboardSnapshotMeta(installationKey).catch(
    fallbackOn("macro_dashboards.meta_read_failed", null, { installationKey }),
  );
  const scope = await viewerProjects(installationKey, context);
  if (!dashMeta?.version || !scope.available) {
    return {
      available: false,
      reason: "no-inventory",
      dashboards: [],
      projectCount: scope.projects.length,
      page: 1,
      pageSize: MACRO_PILLAR_PAGE_SIZE,
      totalPages: 0,
      total: 0,
      matchedTotal: 0,
    };
  }

  const filterMeta = await readFilterSnapshotMeta(installationKey).catch(() => null);
  const [all, allFilters] = await Promise.all([
    loadDashboards(installationKey, dashMeta.version).catch(() => []),
    filterMeta?.version ? loadFilters(installationKey, filterMeta.version).catch(() => []) : Promise.resolve([]),
  ]);

  // Filter ids whose JQL names a browsable project -- so a dashboard is in scope if a gadget
  // points at one, not only if the dashboard itself is shared to the project.
  const inScopeFilterIds = new Set(
    allFilters
      .filter((f) => (f.projectRefs || []).some((k) => scope.projectKeys.has(String(k).toLowerCase())))
      .map((f) => String(f.id)),
  );
  const fieldsByFilterId = new Map(allFilters.map((f) => [String(f.id), f.fieldRefs || []]));

  const mine = all
    .map((d) => {
      const gadgets = d.gadgets || [];
      const gadgetFilterIds = [
        ...new Set(
          gadgets
            .map((g) => g.filterId)
            .filter(Boolean)
            .map(String),
        ),
      ];
      const sharedToProject = (d.shares || []).some(
        (s) => s.type === "project" && scope.projectIds.has(String(s.targetId)),
      );
      const backedByScopedFilter = gadgetFilterIds.some((id) => inScopeFilterIds.has(id));
      if (!sharedToProject && !backedByScopedFilter) return null;
      const fields = [...new Set(gadgetFilterIds.flatMap((id) => fieldsByFilterId.get(id) || []))].sort();
      return {
        id: d.id,
        name: d.name,
        owner: d.ownerName || null,
        gadgetCount: d.gadgetCount ?? gadgets.length,
        fields,
        sharedToProject,
        viewUrl: d.viewUrl || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  const matched = query
    ? mine.filter((d) => d.name.toLowerCase().includes(query) || d.fields.some((x) => x.toLowerCase().includes(query)))
    : mine;
  const { slice, page, pageSize, totalPages } = macroPaginate(matched, payload?.page);

  return {
    available: true,
    dashboards: slice,
    projectCount: scope.projects.length,
    fieldsResolved: Boolean(filterMeta?.version),
    page,
    pageSize,
    totalPages,
    total: mine.length,
    matchedTotal: matched.length,
    snapshotRefreshedAt: dashMeta.refreshedAt || dashMeta.completedAt || null,
  };
}

// -- Three more macro pillars, all scoped the same way -----------------------
//
// The macro browses and reports; the admin page governs. That split is deliberate and these
// keep it -- they carry inventory and no governance findings, because a finding is a
// judgement an admin acts on and a viewer cannot.
//
// What they do NOT carry is just as deliberate. Access schemes, the people roster, Assets
// and the automation findings stay admin-only: the first two are a disclosure risk in a
// panel anyone in Confluence can open, and automation findings include plaintext-credential
// hits, which is the last thing to put on a wiki page.
//
// Every one filters through viewerProjects, so a viewer sees their own estate and is told
// so, rather than seeing the site's and wondering which half is theirs.

export async function getMacroScreens({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readScreenSnapshotMeta(installationKey).catch(
    fallbackOn("macro_screens.meta_read_failed", null, { installationKey }),
  );
  const scope = await viewerProjects(installationKey, context);
  if (!meta?.version || !scope.available) {
    return { available: false, reason: "no-inventory", projects: [], projectCount: scope.projects.length };
  }

  const rows = await loadScreensForProjects(installationKey, meta.version, [...scope.projectIds]).catch(
    fallbackOn("macro_screens.load_failed", [], { installationKey }),
  );

  const byProject = new Map(scope.projects.map((p) => [p.projectId, { ...p, screens: [] }]));
  for (const row of rows) {
    const entry = byProject.get(row.projectId);
    if (!entry) continue;
    entry.screens.push({
      screenId: row.screenId,
      name: row.name,
      fieldCount: row.fieldCount,
      tabCount: row.tabCount,
      // "Could not be read" is not "has no fields". The viewer is the person about to ask
      // why their form looks different, so the distinction has to survive to the panel.
      unreadable: row.tabsResolved !== "resolved",
      operations: [row.onCreate && "create", row.onEdit && "edit", row.onView && "view"].filter(Boolean),
    });
  }

  const projects = [...byProject.values()]
    .map((p) => ({
      ...p,
      screens: p.screens.sort((a, b) => b.fieldCount - a.fieldCount || a.name.localeCompare(b.name)),
      // The number anyone actually came to argue about: how long the form is that every
      // person filing an issue here has to get through.
      createFieldCount: p.screens
        .filter((s) => s.operations.includes("create"))
        .reduce((n, s) => Math.max(n, s.fieldCount), 0),
    }))
    .sort((a, b) => b.createFieldCount - a.createFieldCount || a.projectKey.localeCompare(b.projectKey));

  return {
    available: true,
    refreshedAt: meta.refreshedAt || null,
    projectCount: projects.length,
    projects,
  };
}

export async function getMacroIssueTypes({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readIssueTypeSnapshotMeta(installationKey).catch(
    fallbackOn("macro_issue_types.meta_read_failed", null, { installationKey }),
  );
  const scope = await viewerProjects(installationKey, context);
  if (!meta?.version || !scope.available) {
    return { available: false, reason: "no-inventory", schemes: [], projectCount: scope.projects.length };
  }

  const [types, items, schemeProjects, schemes] = await Promise.all([
    loadIssueTypes(installationKey, meta.version).catch(() => []),
    loadIssueTypeSchemeItems(installationKey, meta.version).catch(() => []),
    loadIssueTypeSchemeProjects(installationKey, meta.version).catch(() => []),
    loadIssueTypeSchemes(installationKey, meta.version).catch(() => []),
  ]);
  // The project rows carry no scheme name, so it comes from the scheme table. Falling back
  // to the id would show a viewer a number where a name belongs.
  const schemeNameById = new Map(schemes.map((sc) => [String(sc.schemeId), sc.name]));

  const typeById = new Map(types.map((t) => [String(t.id), t]));
  const membersByScheme = new Map();
  for (const item of items) {
    if (!membersByScheme.has(item.schemeId)) membersByScheme.set(item.schemeId, []);
    const type = typeById.get(String(item.issueTypeId));
    membersByScheme.get(item.schemeId).push({
      id: item.issueTypeId,
      name: type?.name || null,
      subtask: type?.subtask ?? null,
      // A scheme naming a type the catalogue no longer holds is worth showing, not hiding.
      missing: !type,
    });
  }

  // Grouped by scheme rather than listed per project: projects sharing a scheme are meant to
  // run the same set, so the grouping IS the information -- and a project sitting alone in a
  // group is the question worth asking.
  const bySchemeId = new Map();
  for (const row of schemeProjects) {
    if (!scope.projectIds.has(String(row.projectId))) continue;
    const key = String(row.schemeId);
    if (!bySchemeId.has(key)) {
      bySchemeId.set(key, {
        schemeId: key,
        name: schemeNameById.get(key) || key,
        projects: [],
        issueTypes: membersByScheme.get(row.schemeId) || [],
      });
    }
    bySchemeId.get(key).projects.push(row.projectKey);
  }

  const grouped = [...bySchemeId.values()]
    .map((s) => ({ ...s, projects: s.projects.sort() }))
    .sort((a, b) => b.projects.length - a.projects.length || a.name.localeCompare(b.name));

  return {
    available: true,
    refreshedAt: meta.refreshedAt || null,
    projectCount: scope.projects.length,
    schemes: grouped,
  };
}

export async function getMacroBoards({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readBoardSnapshotMeta(installationKey).catch(
    fallbackOn("macro_boards.meta_read_failed", null, { installationKey }),
  );
  const scope = await viewerProjects(installationKey, context);
  if (!meta?.version || !scope.available) {
    return { available: false, reason: "no-inventory", boards: [], projectCount: scope.projects.length };
  }

  const all = await loadBoards(installationKey, meta.version).catch(
    fallbackOn("macro_boards.load_failed", [], { installationKey }),
  );

  const keyById = new Map(scope.projects.map((p) => [p.projectId, p.projectKey]));
  const boards = all
    .filter((b) => b.locationType === "project" && scope.projectIds.has(String(b.locationId)))
    .map((b) => ({
      boardId: b.boardId,
      name: b.name,
      type: b.type,
      projectKey: keyById.get(String(b.locationId)) || b.locationKey || null,
      columnCount: b.columnCount,
      // The one fact a viewer can act on without being an admin: a board whose configuration
      // could not be read -- team-managed boards routinely 404 -- shows them something this
      // page cannot describe, and saying so is the only honest option.
      configReadable: b.configReadable,
    }))
    .sort(
      (a, b) => String(a.projectKey || "").localeCompare(String(b.projectKey || "")) || a.name.localeCompare(b.name),
    );

  return {
    available: true,
    refreshedAt: meta.refreshedAt || null,
    projectCount: scope.projects.length,
    boards,
  };
}

export async function getMacroWorkflows({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readWorkflowSnapshotMeta(installationKey).catch(
    fallbackOn("macro_workflows.meta_read_failed", null, { installationKey }),
  );
  const scope = await viewerProjects(installationKey, context);
  if (!meta?.version || !scope.available) {
    return { available: false, reason: "no-inventory", schemes: [], statuses: [], projectCount: scope.projects.length };
  }

  const [schemeMap, schemeStatuses, catalog] = await Promise.all([
    loadProjectWorkflowSchemeMap(installationKey, meta.version).catch(() => new Map()),
    loadWorkflowSchemeStatuses(installationKey, meta.version).catch(() => []),
    loadStatusesCatalog(installationKey, meta.version).catch(() => []),
  ]);

  // scheme id -> its statuses
  const statusIdsByScheme = new Map();
  for (const { schemeId, statusId } of schemeStatuses) {
    if (!statusIdsByScheme.has(schemeId)) statusIdsByScheme.set(schemeId, new Set());
    statusIdsByScheme.get(schemeId).add(String(statusId));
  }
  const statusName = new Map(catalog.map((s) => [String(s.id), s]));

  // The browsable projects, grouped by the workflow scheme they run.
  const bySchemeId = new Map();
  for (const project of scope.projects) {
    const mapped = schemeMap.get(String(project.projectId));
    if (!mapped) continue;
    const key = String(mapped.schemeId);
    if (!bySchemeId.has(key)) {
      bySchemeId.set(key, { schemeId: key, name: mapped.name || key, projects: [], statuses: [] });
    }
    bySchemeId.get(key).projects.push(project.projectKey);
  }

  const usedStatusIds = new Set();
  const schemes = [...bySchemeId.values()]
    .map((s) => {
      const ids = [...(statusIdsByScheme.get(s.schemeId) || [])];
      ids.forEach((id) => usedStatusIds.add(id));
      return {
        ...s,
        projects: s.projects.sort(),
        statuses: ids
          .map((id) => statusName.get(id))
          .filter(Boolean)
          .map((st) => ({ id: String(st.id), name: st.name, category: st.statusCategory || "Uncategorised" }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    })
    .sort((a, b) => b.projects.length - a.projects.length || a.name.localeCompare(b.name));

  // The de-duplicated status list across every scheme the viewer's projects run.
  const statuses = [...usedStatusIds]
    .map((id) => statusName.get(id))
    .filter(Boolean)
    .map((st) => ({ id: String(st.id), name: st.name, category: st.statusCategory || "Uncategorised" }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    available: true,
    schemes,
    statuses,
    projectCount: scope.projects.length,
    snapshotRefreshedAt: meta.refreshedAt || meta.completedAt || null,
  };
}
