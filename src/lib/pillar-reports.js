// Pillar reports: one exportable inventory per pillar, in one shape.
//
// Every pillar tab already renders its inventory, but each in its own dialect -- a roster
// here, a paginated table there, a tree of schemes somewhere else. The Reports tab needs the
// opposite: the same questions answered the same way for every pillar. What is there, how
// much of it, which rows carry a finding, and how fresh is the snapshot it came from.
//
// So each pillar gets a pure builder that takes the data its own resolver already loads and
// returns rows under a declared column list. finalizeReport then applies the rules every
// report shares, so no builder can drift from them:
//
//   - `findings` is always the last column and always a list of finding codes. A row with
//     no findings has an empty list, never a missing cell.
//   - Flagged rows sort first. A capped report must never drop the rows worth reading to
//     keep ones that are fine.
//   - `status` is "ok" or "unavailable", with a reason. An unbuilt pillar is never an empty
//     report -- the same tri-state rule the health score and the Rovo actions follow.
//   - `refreshedAt` always travels with the rows, so an export says how old it is.
//
// Builders are pure and take plain inputs; the resolver does the I/O. That split is what
// makes each pillar's mapping testable without standing up a store.

import { findDuplicateTypeNames, findOrphanTypes } from "./issuetype-insights.js";
import { findDuplicateStatusGroups } from "./workflow-insights.js";
import {
  findBareTypes,
  findBrokenHierarchy,
  findBrokenReferences,
  findEmptyObjectTypes,
} from "./asset-insights.js";
import { analyzeDashboard } from "./dashboard-insights.js";

// A report is a download, not a page -- but it still crosses the Forge invoke boundary as
// one payload. 5,000 rows of ten short columns is comfortably under the response limit;
// past it the report says it was truncated and by how much rather than failing outright.
export const REPORT_ROW_LIMIT = 5000;

// The registry. Order is the order the Reports tab lists them in, which follows the admin
// nav so a pillar is in the same place on both. `health` names the governance pillars
// (HEALTH_PILLARS keys) whose score belongs beside this report.
export const PILLAR_REPORTS = [
  { key: "fields", label: "Fields", entity: "custom fields", health: ["fields"] },
  { key: "projects", label: "Projects", entity: "projects", health: ["projects"] },
  { key: "workflows", label: "Workflows", entity: "workflow schemes", health: ["workflows"] },
  { key: "issueTypes", label: "Issue types", entity: "issue types", health: ["issueTypes"] },
  { key: "priorities", label: "Priorities & resolutions", entity: "values", health: ["estate"] },
  { key: "people", label: "People", entity: "licensed users", health: ["users"] },
  { key: "assets", label: "Assets", entity: "object types", health: ["assets"] },
  { key: "access", label: "Access", entity: "schemes and roles", health: ["permissions", "security", "notifications", "roles"] },
  { key: "screens", label: "Screens", entity: "screens", health: ["screens"] },
  { key: "filters", label: "Saved filters", entity: "filters", health: ["filters"] },
  { key: "dashboards", label: "Dashboards", entity: "dashboards", health: ["dashboards"] },
  { key: "boards", label: "Boards", entity: "boards", health: ["boards"] },
  { key: "automation", label: "Automation", entity: "rules", health: ["automation"] },
  { key: "changes", label: "Changes", entity: "changes", health: ["drift"], findings: false },
];

const REPORT_BY_KEY = new Map(PILLAR_REPORTS.map((r) => [r.key, r]));

export function isPillarReportKey(key) {
  return REPORT_BY_KEY.has(String(key || ""));
}

const FINDINGS_COLUMN = { key: "findings", label: "Findings", kind: "list" };

function describe(key) {
  const def = REPORT_BY_KEY.get(key);
  if (!def) throw new Error(`Unknown pillar report "${key}"`);
  return def;
}

export function unavailableReport(key, reason) {
  const def = describe(key);
  return {
    pillar: def.key,
    label: def.label,
    entity: def.entity,
    healthPillars: def.health,
    status: "unavailable",
    reason: reason || "This pillar has not been scanned yet.",
    refreshedAt: null,
    columns: [],
    rows: [],
    total: 0,
    truncated: false,
    flaggedCount: 0,
    summary: [],
    notes: [],
  };
}

export function finalizeReport(key, { refreshedAt = null, columns = [], rows = [], summary = [], notes = [] }, { limit = REPORT_ROW_LIMIT } = {}) {
  const def = describe(key);
  const hasFindings = def.findings !== false;

  const normalized = rows.map((row) => (hasFindings
    ? { ...row, findings: Array.isArray(row.findings) ? [...new Set(row.findings.filter(Boolean))] : [] }
    : row));

  // Stable: within the flagged and unflagged halves, the builder's own order stands.
  const ordered = hasFindings
    ? [...normalized.filter((r) => r.findings.length > 0), ...normalized.filter((r) => r.findings.length === 0)]
    : normalized;

  const flaggedCount = hasFindings ? normalized.filter((r) => r.findings.length > 0).length : 0;
  const truncated = ordered.length > limit;

  return {
    pillar: def.key,
    label: def.label,
    entity: def.entity,
    // The governance pillars scored beside this report, so the tab needs no second map.
    healthPillars: def.health,
    status: "ok",
    reason: null,
    refreshedAt: toIso(refreshedAt),
    columns: hasFindings ? [...columns, FINDINGS_COLUMN] : columns,
    rows: truncated ? ordered.slice(0, limit) : ordered,
    total: ordered.length,
    truncated,
    flaggedCount,
    // The two tiles every report opens with, then the pillar's own.
    summary: [
      { label: capitalize(def.entity), value: ordered.length },
      ...(hasFindings
        ? [{ label: "With findings", value: flaggedCount, tone: flaggedCount > 0 ? "warning" : "success" }]
        : []),
      ...summary,
    ],
    notes: [
      ...notes,
      ...(truncated ? [`Showing the first ${limit.toLocaleString("en-US")} of ${ordered.length.toLocaleString("en-US")} ${def.entity}, flagged rows first.`] : []),
    ],
  };
}

function toIso(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return new Date(value).toISOString();
  return String(value);
}

function capitalize(text) {
  const s = String(text || "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function count(rows, predicate) {
  return rows.filter(predicate).length;
}

// ── Builders ────────────────────────────────────────────────────────────────
//
// Each takes the inputs the resolver gathered and returns the finalizeReport body. None of
// them may invent a finding: every code here is one the pillar's own analysis already
// produces, or a fact read straight off the row (a scheme with no projects).

function buildFieldsReport({ refreshedAt, fields = [] }) {
  const rows = fields.map((f) => ({
    id: f.id,
    name: f.name,
    type: f.type || "unknown",
    system: Boolean(f.isSystemField),
    configuredProjects: Number(f.configuredProjectCount) || 0,
    activeProjects: Number(f.activeProjectCount) || 0,
    issues: Number(f.totalIssueCount) || 0,
    // hydrateFieldForGovernance attaches { reasons: [...] }, not a bare list.
    findings: (f.findings?.reasons || []).map((r) => r.code),
  }));
  return {
    refreshedAt,
    columns: [
      { key: "id", label: "Field ID", kind: "text" },
      { key: "name", label: "Name", kind: "text" },
      { key: "type", label: "Type", kind: "text" },
      { key: "system", label: "System", kind: "boolean" },
      { key: "configuredProjects", label: "Configured projects", kind: "number" },
      { key: "activeProjects", label: "Projects with values", kind: "number" },
      { key: "issues", label: "Issues with values", kind: "number" },
    ],
    rows,
    summary: [
      { label: "Never populated", value: count(rows, (r) => !r.system && r.issues === 0), tone: "warning" },
    ],
  };
}

function buildProjectsReport({ refreshedAt, projects = [], adoption = null }) {
  const adoptionById = new Map((adoption?.projects || []).map((a) => [String(a.projectId), a]));
  // The headline counts suppress fell-off / never-adopted when the activity histogram is
  // stale; the per-row flags must follow the same rule or the export contradicts the score.
  const judge = adoption?.available && !adoption?.dataStale;
  const rows = projects.map((p) => {
    const a = adoptionById.get(String(p.projectId));
    const judgeable = judge && a?.measured && a?.oldEnough;
    return {
      key: p.projectKey,
      name: p.projectName,
      fields: Number(p.fieldCount) || 0,
      issues: p.uniqueIssueCount ?? null,
      issuesPerDay: a?.measured ? round(a.issuesPerDay, 2) : null,
      adoption: a?.score ?? null,
      lastIssueCreated: a?.lastIssueCreatedAt ?? null,
      findings: [
        judgeable && a.fellOff ? "fell-off" : null,
        judgeable && a.neverAdopted ? "never-adopted" : null,
      ],
    };
  });
  const notes = [];
  if (!adoption?.available) notes.push("Adoption is unmeasured: no issue activity has been captured. Run a Universal Scan.");
  else if (adoption.dataStale) notes.push("Adoption flags are suppressed: the activity data behind them is stale.");
  return {
    refreshedAt,
    columns: [
      { key: "key", label: "Key", kind: "text" },
      { key: "name", label: "Name", kind: "text" },
      { key: "fields", label: "Fields in use", kind: "number" },
      { key: "issues", label: "Issues", kind: "number" },
      { key: "issuesPerDay", label: "Issues / day", kind: "number" },
      { key: "adoption", label: "Adoption score", kind: "number" },
      { key: "lastIssueCreated", label: "Last issue created", kind: "date" },
    ],
    rows,
    notes,
  };
}

function buildWorkflowsReport({ refreshedAt, schemes = [], statusCount = null }) {
  const rows = schemes.map((s) => ({
    id: s.id,
    name: s.name,
    defaultWorkflow: s.defaultWorkflow || null,
    mappedIssueTypes: s.issueTypeMapping && typeof s.issueTypeMapping === "object" ? Object.keys(s.issueTypeMapping).length : 0,
    projects: Number(s.projectCount) || 0,
    findings: [(Number(s.projectCount) || 0) === 0 ? "unused-scheme" : null],
  }));
  return {
    refreshedAt,
    columns: [
      { key: "id", label: "Scheme ID", kind: "text" },
      { key: "name", label: "Name", kind: "text" },
      { key: "defaultWorkflow", label: "Default workflow", kind: "text" },
      { key: "mappedIssueTypes", label: "Issue type mappings", kind: "number" },
      { key: "projects", label: "Projects", kind: "number" },
    ],
    rows,
    summary: statusCount != null ? [{ label: "Statuses", value: statusCount }] : [],
  };
}

function buildIssueTypesReport({ refreshedAt, issueTypes = [], schemeItems = [], usage = null }) {
  const orphanIds = new Set(findOrphanTypes(issueTypes, schemeItems).map((t) => String(t.id)));
  const duplicateIds = new Set(findDuplicateTypeNames(issueTypes).flatMap((g) => g.types.map((t) => String(t.id))));
  const rows = issueTypes.map((t) => ({
    id: t.id,
    name: t.name,
    level: t.subtask ? "Sub-task" : (Number(t.hierarchyLevel) || 0) > 0 ? `Level ${t.hierarchyLevel}` : "Standard",
    scope: t.scopeProjectId ? "Team-managed" : "Global",
    issues: t.issueCount ?? null,
    projects: t.usedInProjects ?? null,
    findings: [
      // A team-managed type is in no scheme by construction; calling it orphaned would be a
      // false finding on every next-gen project.
      orphanIds.has(String(t.id)) && !t.scopeProjectId ? "no-scheme" : null,
      duplicateIds.has(String(t.id)) ? "duplicate-name" : null,
    ],
  }));
  const notes = [];
  if (usage && usage.measurement !== "measured") notes.push("Issue counts are not fully measured yet; blank means unmeasured, not zero.");
  return {
    refreshedAt,
    columns: [
      { key: "id", label: "ID", kind: "text" },
      { key: "name", label: "Name", kind: "text" },
      { key: "level", label: "Hierarchy", kind: "text" },
      { key: "scope", label: "Scope", kind: "text" },
      { key: "issues", label: "Issues", kind: "number" },
      { key: "projects", label: "Projects", kind: "number" },
    ],
    rows,
    notes,
  };
}

function buildPrioritiesReport({ refreshedAt, resolutions = [], priorities = [] }) {
  const flag = (items) => new Set(findDuplicateStatusGroups(items).flatMap((g) => g.statuses.map((s) => String(s.id))));
  const dupResolutions = flag(resolutions);
  const dupPriorities = flag(priorities);
  const toRow = (kind, dupes) => (v) => ({
    kind,
    id: v.id,
    name: v.name,
    isDefault: Boolean(v.isDefault),
    description: v.description || "",
    findings: [dupes.has(String(v.id)) ? "near-duplicate-name" : null],
  });
  return {
    refreshedAt,
    columns: [
      { key: "kind", label: "List", kind: "text" },
      { key: "id", label: "ID", kind: "text" },
      { key: "name", label: "Name", kind: "text" },
      { key: "isDefault", label: "Default", kind: "boolean" },
      { key: "description", label: "Description", kind: "text" },
    ],
    rows: [...priorities.map(toRow("Priority", dupPriorities)), ...resolutions.map(toRow("Resolution", dupResolutions))],
    summary: [
      { label: "Priorities", value: priorities.length },
      { label: "Resolutions", value: resolutions.length },
    ],
  };
}

function buildPeopleReport({ refreshedAt, users = [] }) {
  const rows = users.map((u) => ({
    name: u.displayName,
    accountId: u.accountId,
    active: Boolean(u.active),
    accountType: u.accountType || null,
    products: (u.applications || []).map((a) => a.name),
    accessGroups: (u.groups || []).length,
    ownedFilters: Number(u.ownedFilters) || 0,
    ownedDashboards: Number(u.ownedDashboards) || 0,
    automationRefs: Number(u.automationRefs) || 0,
    // A deactivated account that still owns things is the pillar's orphaned-ownership
    // finding at the row level: everything it owns disappears if the account is deleted.
    findings: [
      !u.active && (Number(u.ownedFilters) || 0) + (Number(u.ownedDashboards) || 0) > 0 ? "inactive-owner" : null,
      !u.active && (Number(u.automationRefs) || 0) > 0 ? "inactive-in-automation" : null,
    ],
  }));
  return {
    refreshedAt,
    columns: [
      { key: "name", label: "Name", kind: "text" },
      { key: "accountId", label: "Account ID", kind: "text" },
      { key: "active", label: "Active", kind: "boolean" },
      { key: "accountType", label: "Account type", kind: "text" },
      { key: "products", label: "Products", kind: "list" },
      { key: "accessGroups", label: "Access groups", kind: "number" },
      { key: "ownedFilters", label: "Owned filters", kind: "number" },
      { key: "ownedDashboards", label: "Owned dashboards", kind: "number" },
      { key: "automationRefs", label: "Automation references", kind: "number" },
    ],
    rows,
    summary: [{ label: "Inactive", value: count(rows, (r) => !r.active), tone: "neutral" }],
  };
}

function buildAssetsReport({ refreshedAt, schemas = [], objectTypes = [], attributes = [], typeCounts = [] }) {
  const schemaName = new Map(schemas.map((s) => [String(s.id), s.name]));
  const ids = (list) => new Set(list.map((t) => String(t.id)));
  const bare = ids(findBareTypes(objectTypes, attributes));
  const brokenParent = ids(findBrokenHierarchy(objectTypes));
  const empty = ids(findEmptyObjectTypes(objectTypes, typeCounts));
  const brokenRefTypes = new Set(findBrokenReferences(attributes, objectTypes).map((a) => String(a.objectTypeId)));
  const attrCount = new Map();
  for (const a of attributes) {
    if (a.objectTypeId == null) continue;
    attrCount.set(String(a.objectTypeId), (attrCount.get(String(a.objectTypeId)) || 0) + 1);
  }
  const objectCount = new Map(typeCounts.map((c) => [String(c.objectTypeId), Number(c.objectCount) || 0]));

  const rows = objectTypes.map((t) => {
    const id = String(t.id);
    return {
      schema: schemaName.get(String(t.schemaId)) || t.schemaId,
      id,
      name: t.name,
      abstract: Boolean(t.abstract),
      attributes: attrCount.get(id) || 0,
      objects: objectCount.has(id) ? objectCount.get(id) : null,
      findings: [
        bare.has(id) ? "no-custom-attributes" : null,
        brokenParent.has(id) ? "missing-parent" : null,
        brokenRefTypes.has(id) ? "broken-reference" : null,
        empty.has(id) ? "no-objects" : null,
      ],
    };
  });
  return {
    refreshedAt,
    columns: [
      { key: "schema", label: "Schema", kind: "text" },
      { key: "id", label: "Type ID", kind: "text" },
      { key: "name", label: "Object type", kind: "text" },
      { key: "abstract", label: "Abstract", kind: "boolean" },
      { key: "attributes", label: "Attributes", kind: "number" },
      { key: "objects", label: "Objects", kind: "number" },
    ],
    rows,
    summary: [{ label: "Schemas", value: schemas.length }],
    notes: typeCounts.length ? [] : ["Object counts have not been crawled; the Objects column is blank rather than zero."],
  };
}

const ACCESS_KINDS = [
  { key: "permissions", label: "Permission scheme", unused: "unassigned-scheme" },
  { key: "security", label: "Issue security scheme", unused: "unassigned-scheme" },
  { key: "notifications", label: "Notification scheme", unused: "unassigned-scheme" },
  // For roles, projectCount is "projects where the role has a real actor" -- so zero means
  // the role is empty everywhere, a different fact from an unassigned scheme.
  { key: "roles", label: "Project role", unused: "no-actors" },
];

function buildAccessReport({ refreshedAt, inventory = {} }) {
  const rows = [];
  for (const kind of ACCESS_KINDS) {
    const section = inventory[kind.key];
    if (!section) continue;
    const holderCount = new Map();
    for (const h of section.holders || []) holderCount.set(h.schemeId, (holderCount.get(h.schemeId) || 0) + 1);
    for (const s of section.schemes || []) {
      const projects = Number(s.projectCount) || 0;
      rows.push({
        type: kind.label,
        id: s.id,
        name: s.name,
        isDefault: Boolean(s.isDefault),
        projects,
        grants: holderCount.get(s.id) || 0,
        findings: [projects === 0 && !s.isDefault ? kind.unused : null],
      });
    }
  }
  return {
    refreshedAt,
    columns: [
      { key: "type", label: "Type", kind: "text" },
      { key: "id", label: "ID", kind: "text" },
      { key: "name", label: "Name", kind: "text" },
      { key: "isDefault", label: "Default", kind: "boolean" },
      { key: "projects", label: "Projects", kind: "number" },
      { key: "grants", label: "Grants / holders", kind: "number" },
    ],
    rows,
  };
}

// How many projects each screen reaches through the scheme chain: screen -> screen scheme
// (operation) -> issue type screen scheme (mapping) -> projects. Transition screens are not
// in this chain, so a screen only a workflow opens reaches zero projects here -- which is why
// the column is "through screen schemes", and why "unreached" is a separate, workflow-aware
// finding.
export function countScreenProjects({ operations = [], mappings = [], itssProjects = [] } = {}) {
  const projectsByItss = new Map();
  for (const p of itssProjects) {
    const key = String(p.itssId);
    if (!projectsByItss.has(key)) projectsByItss.set(key, new Set());
    projectsByItss.get(key).add(String(p.projectId));
  }
  const itssBySchemeId = new Map();
  for (const m of mappings) {
    if (m.screenSchemeId == null) continue;
    const key = String(m.screenSchemeId);
    if (!itssBySchemeId.has(key)) itssBySchemeId.set(key, new Set());
    itssBySchemeId.get(key).add(String(m.itssId));
  }
  const projectsByScreen = new Map();
  for (const op of operations) {
    if (op.screenId == null || op.dangling) continue;
    const screen = String(op.screenId);
    if (!projectsByScreen.has(screen)) projectsByScreen.set(screen, new Set());
    for (const itss of itssBySchemeId.get(String(op.schemeId)) || []) {
      for (const project of projectsByItss.get(itss) || []) projectsByScreen.get(screen).add(project);
    }
  }
  return new Map([...projectsByScreen].map(([screen, set]) => [screen, set.size]));
}

function buildScreensReport({ refreshedAt, screens = [], unreachedIds = null, projectsByScreen = null }) {
  const rows = screens.map((s) => ({
    id: s.screenId,
    name: s.name,
    tabs: Number(s.tabCount) || 0,
    fields: Number(s.fieldCount) || 0,
    // Null when the scheme chain was not loaded: unknown, not zero.
    projects: projectsByScreen ? projectsByScreen.get(String(s.screenId)) || 0 : null,
    findings: [
      s.tabsResolved !== "resolved" ? "unreadable" : null,
      s.tabsResolved === "resolved" && (Number(s.fieldCount) || 0) === 0 ? "empty" : null,
      unreachedIds?.has(String(s.screenId)) ? "unreached" : null,
    ],
  }));
  return {
    refreshedAt,
    columns: [
      { key: "id", label: "Screen ID", kind: "text" },
      { key: "name", label: "Name", kind: "text" },
      { key: "tabs", label: "Tabs", kind: "number" },
      { key: "fields", label: "Fields", kind: "number" },
      { key: "projects", label: "Projects (through screen schemes)", kind: "number" },
    ],
    rows,
    notes: unreachedIds ? [] : ["Reachability was not checked: no workflow inventory has been built."],
  };
}

function buildFiltersReport({ refreshedAt, filters = [] }) {
  const rows = filters.map((f) => ({
    id: f.id,
    name: f.name,
    owner: f.ownerName || null,
    ownerActive: f.ownerActive,
    sharedWithEveryone: Boolean(f.sharedWithEveryone),
    subscriptions: Number(f.subscriptionCount) || 0,
    favourites: Number(f.favouritedCount) || 0,
    lastUsed: f.lastUsedAt || null,
    findings: (f.findings || []).map((x) => x.code),
  }));
  return {
    refreshedAt,
    columns: [
      { key: "id", label: "Filter ID", kind: "text" },
      { key: "name", label: "Name", kind: "text" },
      { key: "owner", label: "Owner", kind: "text" },
      { key: "ownerActive", label: "Owner active", kind: "boolean" },
      { key: "sharedWithEveryone", label: "Shared with everyone", kind: "boolean" },
      { key: "subscriptions", label: "Subscriptions", kind: "number" },
      { key: "favourites", label: "Favourites", kind: "number" },
      { key: "lastUsed", label: "Last used", kind: "date" },
    ],
    rows,
  };
}

function buildDashboardsReport({ refreshedAt, dashboards = [] }) {
  const rows = dashboards.map((d) => ({
    id: d.id,
    name: d.name,
    owner: d.ownerName || null,
    ownerActive: d.ownerActive,
    gadgets: d.gadgetCount ?? null,
    favourites: Number(d.popularity) || 0,
    sharedWithEveryone: Boolean(d.sharedWithEveryone),
    editableByEveryone: Boolean(d.editableByEveryone),
    findings: analyzeDashboard(d).map((x) => x.code),
  }));
  return {
    refreshedAt,
    columns: [
      { key: "id", label: "Dashboard ID", kind: "text" },
      { key: "name", label: "Name", kind: "text" },
      { key: "owner", label: "Owner", kind: "text" },
      { key: "ownerActive", label: "Owner active", kind: "boolean" },
      { key: "gadgets", label: "Gadgets", kind: "number" },
      { key: "favourites", label: "Favourites", kind: "number" },
      { key: "sharedWithEveryone", label: "Shared with everyone", kind: "boolean" },
      { key: "editableByEveryone", label: "Editable by everyone", kind: "boolean" },
    ],
    rows,
  };
}

function buildBoardsReport({ refreshedAt, boards = [] }) {
  const rows = boards.map((b) => ({
    id: b.boardId,
    name: b.name,
    type: b.type || null,
    location: b.locationKey || b.locationName || null,
    filterId: b.filterId || null,
    columns: Number(b.columnCount) || (b.columns || []).length,
    findings: [
      !b.configReadable ? "config-unreadable" : null,
      ...(b.issues || []),
    ],
  }));
  return {
    refreshedAt,
    columns: [
      { key: "id", label: "Board ID", kind: "text" },
      { key: "name", label: "Name", kind: "text" },
      { key: "type", label: "Type", kind: "text" },
      { key: "location", label: "Location", kind: "text" },
      { key: "filterId", label: "Backing filter", kind: "text" },
      { key: "columns", label: "Columns", kind: "number" },
    ],
    rows,
  };
}

function buildAutomationReport({ refreshedAt, rules = [], findingsPreview = [], findingsTotal = 0 }) {
  const risksByRule = new Map(findingsPreview.map((f) => [String(f.id), (f.r || []).map((r) => r.c)]));
  const rows = rules.map((r) => ({
    id: r.id,
    name: r.name,
    enabled: Boolean(r.enabled),
    trigger: r.triggerType || null,
    projects: r.projectCount ?? null,
    author: r.authorAccountId || null,
    findings: risksByRule.get(String(r.id)) || [],
  }));
  const notes = [];
  // The stored analysis keeps only the highest-severity findings. Saying so is the
  // difference between "these rules are clean" and "these rules were not listed".
  if (findingsTotal > findingsPreview.length) {
    notes.push(`Findings are listed for the ${findingsPreview.length} highest-severity rules of ${findingsTotal} flagged; open the Automation tab for the rest.`);
  }
  return {
    refreshedAt,
    columns: [
      { key: "id", label: "Rule ID", kind: "text" },
      { key: "name", label: "Name", kind: "text" },
      { key: "enabled", label: "Enabled", kind: "boolean" },
      { key: "trigger", label: "Trigger", kind: "text" },
      { key: "projects", label: "Projects", kind: "number" },
      { key: "author", label: "Author account", kind: "text" },
    ],
    rows,
    summary: [
      { label: "Enabled", value: count(rows, (r) => r.enabled) },
      { label: "Flagged in analysis", value: findingsTotal, tone: findingsTotal > 0 ? "warning" : "success" },
    ],
    notes,
  };
}

function buildChangesReport({ refreshedAt, changes = [], windowDays = 30 }) {
  const rows = changes.map((c) => ({
    detectedAt: c.detectedAt,
    pillar: c.pillar,
    entityType: c.entityType,
    entity: c.label || c.entityId,
    change: c.changeKind,
    summary: c.summary || "",
  }));
  return {
    refreshedAt,
    columns: [
      { key: "detectedAt", label: "Detected", kind: "date" },
      { key: "pillar", label: "Pillar", kind: "text" },
      { key: "entityType", label: "Entity type", kind: "text" },
      { key: "entity", label: "Entity", kind: "text" },
      { key: "change", label: "Change", kind: "text" },
      { key: "summary", label: "Summary", kind: "text" },
    ],
    rows,
    summary: ["added", "removed", "modified"].map((kind) => ({
      label: capitalize(kind),
      value: count(rows, (r) => r.change === kind),
    })),
    notes: [`Changes detected in the trailing ${windowDays} days.`],
  };
}

function round(value, places) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const f = 10 ** places;
  return Math.round(Number(value) * f) / f;
}

export const PILLAR_REPORT_BUILDERS = {
  fields: buildFieldsReport,
  projects: buildProjectsReport,
  workflows: buildWorkflowsReport,
  issueTypes: buildIssueTypesReport,
  priorities: buildPrioritiesReport,
  people: buildPeopleReport,
  assets: buildAssetsReport,
  access: buildAccessReport,
  screens: buildScreensReport,
  filters: buildFiltersReport,
  dashboards: buildDashboardsReport,
  boards: buildBoardsReport,
  automation: buildAutomationReport,
  changes: buildChangesReport,
};

export function buildPillarReport(key, input, options) {
  const builder = PILLAR_REPORT_BUILDERS[key];
  if (!builder) throw new Error(`Unknown pillar report "${key}"`);
  return finalizeReport(key, builder(input || {}), options);
}
