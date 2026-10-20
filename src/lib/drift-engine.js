// Configuration drift: what changed in the estate's configuration since the last scan.
//
// Every other pillar full-replaces its snapshot, so there is nothing to diff after the
// fact. This stage is the exception. After the inventory stages have run, it:
//
//   1. loads each pillar's current entity set (schemes, statuses, fields, ...)
//   2. reduces each entity to a digest of its STRUCTURAL fields only -- never usage counts,
//      which move every scan and would bury the signal
//   3. diffs that against the digests stored from the previous pass
//   4. appends one row per add / remove / modify to config_change_log
//   5. replaces the stored digests with the current set
//
// The first pass for a pillar records nothing -- it seeds the digests silently, so the
// timeline starts at the first change rather than with a wall of "everything was added".

import { logger } from "./logger.js";
import { inventorySnapshotQueue } from "./queues.js";
import { incrMetric, METRIC_NAMES } from "./jira-api.js";
import {
  ensureProjectStoreReady,
  readDriftSnapshotMeta,
  writeDriftSnapshotMeta,
  loadEntityDigests,
  replaceEntityDigests,
  appendConfigChanges,
  readSnapshotMeta,
  readWorkflowSnapshotMeta,
  readIssueTypeSnapshotMeta,
  readAccessSnapshotMeta,
  readFilterSnapshotMeta,
  readDashboardSnapshotMeta,
  readEstateSnapshotMeta,
  loadEstateValues,
  readJsmSnapshotMeta,
  loadJsmRequestTypes,
  loadJsmQueues,
  loadJsmOrganizations,
  loadJsmSlas,
  loadSnapshotFields,
  loadStatusesCatalog,
  loadWorkflowSchemes,
  loadIssueTypes,
  loadIssueTypeSchemes,
  loadSchemes,
  loadSchemeHolders,
  loadSchemeLevels,
  loadFilters,
  loadDashboards,
  readFieldConfigSnapshotMeta,
  loadFieldConfigSchemes,
  loadFieldConfigConfigs,
  loadFieldConfigSchemeProjects,
  readScreenSnapshotMeta,
  loadScreensPage,
  loadScreenSchemes,
  loadIssueTypeScreenSchemes,
  loadItssMappings,
  loadItssProjects,
  loadScreenFieldLayout,
  readBoardSnapshotMeta,
  loadBoards,
  loadBoardColumns,
  readUserSnapshotMeta,
  loadUsers,
  readAssetSnapshotMeta,
  loadAssetSchemas,
  loadAssetObjectTypes,
  loadAssetAttributes,
  loadWorkflowsCatalog,
  loadWorkflowStructure,
  loadProjectWorkflowSchemeMap,
  loadIssueTypeSchemeProjects,
  loadSchemeProjects,
} from "./project-store.js";
// Not re-exported by project-store.js; every other caller imports it from here too.
import { readAutomationPart } from "./store/automation.js";

export const DRIFT_BUILD_STALE_MS = 16 * 60 * 1000;

export function isDriftBuildStale(meta, now = Date.now()) {
  if (meta?.state !== "building") return false;
  const startedAt = Date.parse(meta?.startedAt || "");
  if (!Number.isFinite(startedAt)) return true;
  return now - startedAt > DRIFT_BUILD_STALE_MS;
}

// FNV-1a, 32-bit, hex. No crypto dependency, deterministic, and collisions are irrelevant
// here -- a clash just means one change goes unrecorded, not a wrong one recorded.
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// Stable stringify: keys sorted, so { a, b } and { b, a } digest the same.
export function digestFields(fields) {
  const norm = (v) => {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.map(norm);
    if (typeof v === "object") {
      return Object.keys(v).sort().reduce((acc, k) => { acc[k] = norm(v[k]); return acc; }, {});
    }
    return v;
  };
  return fnv1a(JSON.stringify(norm(fields ?? {})));
}

// ── Per-pillar entity contributors ──────────────────────────────────────────
//
// Each returns a flat list of { entityType, entityId, label, fields }. `fields` is the
// object that gets digested -- put only what an admin would call a configuration change in
// it. An entity whose identity IS its content (a single permission grant) carries an empty
// `fields`, so it can only be added or removed, never "modified".

async function collectFields(installationKey, version) {
  const rows = await loadSnapshotFields(installationKey, version);
  return rows.map((f) => ({
    entityType: "field",
    entityId: f.id,
    label: f.name,
    fields: {
      name: f.name,
      type: f.type,
      primitiveType: f.primitiveType,
      customType: f.customType,
      searcherKey: f.searcherKey,
      configuredProjectCount: f.configuredProjectCount,
    },
  }));
}

async function collectWorkflow(installationKey, version) {
  const [statuses, schemes] = await Promise.all([
    loadStatusesCatalog(installationKey, version),
    loadWorkflowSchemes(installationKey, version),
  ]);
  return [
    ...statuses.map((s) => ({
      entityType: "status",
      entityId: s.id,
      label: s.name,
      fields: { name: s.name, statusCategory: s.statusCategory },
    })),
    ...schemes.map((s) => ({
      entityType: "workflow-scheme",
      entityId: s.id,
      label: s.name,
      fields: {
        name: s.name,
        description: s.description,
        defaultWorkflow: s.defaultWorkflow,
        projectCount: s.projectCount,
        mapping: s.issueTypeMapping || null,
      },
    })),
  ];
}

async function collectIssueTypes(installationKey, version) {
  const [types, schemes] = await Promise.all([
    loadIssueTypes(installationKey, version),
    loadIssueTypeSchemes(installationKey, version),
  ]);
  return [
    ...types.map((t) => ({
      entityType: "issue-type",
      entityId: t.id,
      label: t.name,
      fields: {
        name: t.name, description: t.description, subtask: t.subtask,
        hierarchyLevel: t.hierarchyLevel, scopeProjectId: t.scopeProjectId,
      },
    })),
    ...schemes.map((s) => ({
      entityType: "issue-type-scheme",
      entityId: s.schemeId,
      label: s.name,
      fields: {
        name: s.name, description: s.description,
        defaultIssueTypeId: s.defaultIssueTypeId, isDefault: s.isDefault, projectCount: s.projectCount,
      },
    })),
  ];
}

async function collectAccess(installationKey, version) {
  const out = [];
  for (const type of ["permission", "security", "notification", "project-role"]) {
    const [schemes, holders] = await Promise.all([
      loadSchemes(installationKey, version, type),
      loadSchemeHolders(installationKey, version, type),
    ]);
    for (const s of schemes) {
      out.push({
        entityType: `${type}-scheme`,
        entityId: s.id,
        label: s.name,
        fields: { name: s.name, description: s.description, isDefault: s.isDefault, defaultLevelId: s.defaultLevelId },
      });
    }
    for (const h of holders) {
      // Identity is the whole grant. Existence-only: added / removed, never modified.
      out.push({
        entityType: `${type}-grant`,
        entityId: `${h.schemeId}:${h.context}:${h.holderType}:${h.holderValue}`,
        label: `${h.contextLabel || h.context} → ${h.holderType}${h.holderLabel ? ` (${h.holderLabel})` : ""}`,
        fields: {},
      });
    }
  }
  const levels = await loadSchemeLevels(installationKey, version);
  for (const l of levels) {
    out.push({
      entityType: "security-level",
      entityId: `${l.schemeId}:${l.id}`,
      label: l.name,
      fields: { name: l.name, description: l.description, isDefault: l.isDefault },
    });
  }
  return out;
}

async function collectFilters(installationKey, version) {
  const rows = await loadFilters(installationKey, version);
  return rows.map((f) => ({
    entityType: "filter",
    entityId: String(f.id),
    label: f.name,
    fields: {
      name: f.name,
      jql: f.jql || null,
      ownerAccountId: f.ownerAccountId || null,
      sharedWithEveryone: Boolean(f.sharedWithEveryone),
    },
  }));
}

async function collectDashboards(installationKey, version) {
  const rows = await loadDashboards(installationKey, version);
  return rows.map((d) => ({
    entityType: "dashboard",
    entityId: String(d.id),
    label: d.name,
    fields: {
      name: d.name,
      ownerAccountId: d.ownerAccountId || null,
      sharedWithEveryone: Boolean(d.sharedWithEveryone),
      editableByEveryone: Boolean(d.editableByEveryone),
      gadgetCount: d.gadgetCount ?? null,
    },
  }));
}

async function collectEstate(installationKey, version) {
  const [resolutions, priorities] = await Promise.all([
    loadEstateValues(installationKey, version, "resolution"),
    loadEstateValues(installationKey, version, "priority"),
  ]);
  return [
    ...resolutions.map((r) => ({
      entityType: "resolution", entityId: r.id, label: r.name,
      fields: { name: r.name, description: r.description, isDefault: r.isDefault },
    })),
    ...priorities.map((p) => ({
      entityType: "priority", entityId: p.id, label: p.name,
      fields: { name: p.name, description: p.description, isDefault: p.isDefault },
    })),
  ];
}

// Jira Service Management: what a customer can ask for, what agents work from, and which
// organizations exist. Structure only -- request volume, queue backlogs and member counts move
// every hour and are not configuration. An SLA's goals and calendars have no endpoint, so all
// that is tracked of an SLA is that it exists: one appearing or disappearing is a real change.
async function collectJsm(installationKey, version) {
  const [requestTypes, queues, organizations, slas] = await Promise.all([
    loadJsmRequestTypes(installationKey, version),
    loadJsmQueues(installationKey, version),
    loadJsmOrganizations(installationKey, version),
    loadJsmSlas(installationKey, version),
  ]);
  const slaNames = new Map(slas.map((s) => [s.fieldId, s.fieldName]));
  return [
    ...[...slaNames].map(([fieldId, name]) => ({
      entityType: "sla", entityId: fieldId, label: name,
      fields: { name },
    })),
    ...requestTypes.map((r) => ({
      entityType: "request-type", entityId: `${r.deskId}:${r.id}`, label: r.name,
      fields: {
        name: r.name, hasDescription: r.hasDescription, issueTypeId: r.issueTypeId,
        groupIds: [...r.groupIds].sort().join(","),
        ...(r.fieldCount === null ? {} : { fieldCount: r.fieldCount, requiredFieldCount: r.requiredFieldCount }),
      },
    })),
    ...queues.map((q) => ({
      entityType: "queue", entityId: `${q.deskId}:${q.id}`, label: q.name,
      fields: { name: q.name, jql: q.jql },
    })),
    ...organizations.map((o) => ({
      entityType: "organization", entityId: o.id, label: o.name,
      fields: { name: o.name },
    })),
  ];
}

// Field schemes (or legacy schemes and configurations), plus which scheme each project is on --
// moving a project to another field scheme changes what it requires as surely as editing the
// scheme does. Counts are digested only where the owner's fields were read, so an owner the
// last build ran out of time on is not reported as "changed".
async function collectFieldConfigs(installationKey, version) {
  const [schemes, configs, assignments] = await Promise.all([
    loadFieldConfigSchemes(installationKey, version),
    loadFieldConfigConfigs(installationKey, version),
    loadFieldConfigSchemeProjects(installationKey, version),
  ]);
  const schemeName = new Map(schemes.map((s) => [s.id, s.name]));
  return [
    ...schemes.map((s) => ({
      entityType: "field-scheme", entityId: s.id, label: s.name,
      fields: {
        name: s.name, description: s.description, isDefault: s.isDefault,
        ...(s.measured === false ? {} : { fieldCount: s.fieldCount, requiredCount: s.requiredCount, restrictedCount: s.restrictedCount }),
      },
    })),
    ...configs.map((c) => ({
      entityType: "field-configuration", entityId: c.id, label: c.name,
      fields: {
        name: c.name, description: c.description, isDefault: c.isDefault,
        ...(c.itemsRead ? { requiredCount: c.requiredCount, hiddenCount: c.hiddenCount, requiredHidden: c.requiredHidden } : {}),
      },
    })),
    ...assignments.map((a) => ({
      entityType: "field-scheme-assignment", entityId: a.projectId, label: a.projectKey,
      fields: { scheme: schemeName.get(a.schemeId) || a.schemeId },
    })),
  ];
}

// ── The rest of the estate ───────────────────────────────────────────────────
//
// Each of these is its own drift pillar rather than more entities in an existing one, so a
// site upgrading to this build seeds them silently instead of reporting every screen, board
// and workflow as "added" on the first pass.

// Workflows themselves, with their transitions and the rules on them. Rules are digested only
// when the snapshot read them (workflowRules non-null), so a build that skipped rule capture
// is not reported as every rule being removed.
async function collectWorkflowDetail(installationKey, version) {
  const [meta, workflows, structure] = await Promise.all([
    readWorkflowSnapshotMeta(installationKey),
    loadWorkflowsCatalog(installationKey, version),
    loadWorkflowStructure(installationKey, version),
  ]);
  const rulesRead = meta?.workflowRules != null;
  const transitionsBy = new Map();
  for (const t of structure.transitions) {
    if (!transitionsBy.has(t.workflowName)) transitionsBy.set(t.workflowName, []);
    transitionsBy.get(t.workflowName).push(`${t.transitionId}:${t.name || ""}:${t.type || ""}:${t.from.join("+")}>${t.to || ""}`);
  }
  const rulesBy = new Map();
  for (const r of structure.rules) {
    if (!rulesBy.has(r.workflowName)) rulesBy.set(r.workflowName, []);
    rulesBy.get(r.workflowName).push(`${r.transitionId}:${r.kind}:${r.key || ""}`);
  }
  return workflows.map((w) => ({
    entityType: "workflow",
    entityId: w.name,
    label: w.name,
    fields: {
      scope: w.scopeType,
      scopeProjectId: w.scopeProjectId,
      transitions: transitionsBy.get(w.name) || [],
      ...(rulesRead ? { rules: rulesBy.get(w.name) || [] } : {}),
    },
  }));
}

// Screens with their tab-and-field layout, screen schemes with what each operation opens, and
// issue type screen schemes with their work-type mapping. A screen whose tabs could not be read
// carries no layout, so a failed read is not a "change".
async function collectScreens(installationKey, version) {
  const screens = [];
  for (let offset = 0; ; offset += 200) {
    // eslint-disable-next-line no-await-in-loop -- paged read, each page needs the last
    const page = await loadScreensPage(installationKey, version, { limit: 200, offset });
    screens.push(...page.rows);
    if (page.rows.length < 200 || screens.length >= page.total) break;
  }
  const [layout, schemes, itss, mappings] = await Promise.all([
    loadScreenFieldLayout(installationKey, version),
    loadScreenSchemes(installationKey, version),
    loadIssueTypeScreenSchemes(installationKey, version),
    loadItssMappings(installationKey, version),
  ]);
  const mappingBy = new Map();
  for (const m of mappings) {
    if (!mappingBy.has(m.itssId)) mappingBy.set(m.itssId, []);
    mappingBy.get(m.itssId).push(`${m.isDefault ? "default" : m.issueTypeId}=${m.screenSchemeId || ""}`);
  }
  return [
    ...screens.map((sc) => ({
      entityType: "screen",
      entityId: String(sc.screenId),
      label: sc.name,
      fields: {
        name: sc.name,
        description: sc.description,
        ...(sc.tabsResolved === "resolved" ? { layout: layout.get(String(sc.screenId)) || [] } : {}),
      },
    })),
    ...schemes.map((sc) => ({
      entityType: "screen-scheme",
      entityId: String(sc.schemeId),
      label: sc.name,
      fields: { name: sc.name, description: sc.description, screens: sc.screens || null },
    })),
    ...itss.map((it) => ({
      entityType: "issue-type-screen-scheme",
      entityId: String(it.itssId),
      label: it.name,
      fields: { name: it.name, description: it.description, mapping: (mappingBy.get(it.itssId) || []).sort() },
    })),
  ];
}

// Boards: what they show (filter, location, type) and how (columns and their statuses).
// Columns are digested only for boards whose configuration could be read.
async function collectBoards(installationKey, version) {
  const [boards, columns] = await Promise.all([
    loadBoards(installationKey, version),
    loadBoardColumns(installationKey, version),
  ]);
  const columnsBy = new Map();
  for (const c of columns) {
    if (!columnsBy.has(c.boardId)) columnsBy.set(c.boardId, []);
    columnsBy.get(c.boardId).push(`${c.name || ""}:${c.statusIds.join("+")}`);
  }
  return boards.map((b) => ({
    entityType: "board",
    entityId: String(b.boardId),
    label: b.name,
    fields: {
      name: b.name,
      type: b.type,
      location: b.locationKey || b.locationId,
      filterId: b.filterId,
      subQuery: b.subQuery,
      estimationField: b.estimationField,
      rankingField: b.rankingField,
      ...(b.configReadable ? { columns: columnsBy.get(b.boardId) || [] } : {}),
    },
  }));
}

// People: licence and access-group membership only -- never activity, which moves every day
// and is personal data the change log has no business keeping.
async function collectPeople(installationKey, version) {
  const users = await loadUsers(installationKey, version);
  return users.map((u) => ({
    entityType: "user",
    entityId: u.accountId,
    label: u.displayName,
    fields: {
      active: u.active,
      accountType: u.accountType,
      products: u.applications.map((a) => a.key).sort(),
      groups: u.groups.map((g) => g.id).sort(),
    },
  }));
}

// Assets structure: schemas, object types and attributes. Never objects, which are data.
async function collectAssets(installationKey, version) {
  const [schemas, types, attributes] = await Promise.all([
    loadAssetSchemas(installationKey, version),
    loadAssetObjectTypes(installationKey, version),
    loadAssetAttributes(installationKey, version),
  ]);
  return [
    ...schemas.map((sc) => ({
      entityType: "asset-schema",
      entityId: String(sc.id),
      label: sc.name,
      fields: { name: sc.name, key: sc.schemaKey, description: sc.description },
    })),
    ...types.map((t) => ({
      entityType: "asset-object-type",
      entityId: String(t.id),
      label: t.name,
      fields: { name: t.name, description: t.description, schemaId: t.schemaId, parentId: t.parentId, abstract: t.abstract },
    })),
    ...attributes.map((a) => ({
      entityType: "asset-attribute",
      entityId: `${a.objectTypeId || a.schemaId}:${a.id}`,
      label: a.name,
      fields: { name: a.name, dataType: a.dataType, references: a.referenceObjectTypeId },
    })),
  ];
}

// Automation, from the imported rule export. It only moves when a new export is imported, so
// a change here is dated to the import, not to when the rule was edited in Jira.
async function readAutomationMeta(installationKey) {
  const analysis = await readAutomationPart(installationKey, "analysis");
  return analysis?.refreshedAt ? { version: String(analysis.refreshedAt) } : null;
}

async function collectAutomation(installationKey) {
  const directory = await readAutomationPart(installationKey, "directory");
  if (!Array.isArray(directory?.rules)) return null;
  return directory.rules.map(([id, name, enabled, trigger, projectCount, author]) => ({
    entityType: "automation-rule",
    entityId: String(id),
    label: name,
    fields: { name, enabled: Boolean(enabled), trigger: trigger || null, projectCount: projectCount ?? null, author: author || null },
  }));
}

// Projects, as the schemes each one runs on: workflow, issue type, screen, permission,
// notification and issue security (field schemes are tracked by their own pillar). A project
// moved to another scheme changes how it behaves as surely as editing the scheme does. Only
// sources whose inventory exists contribute, so an unbuilt pillar is not reported as a change.
const PROJECT_SOURCE_METAS = [readWorkflowSnapshotMeta, readIssueTypeSnapshotMeta, readScreenSnapshotMeta, readAccessSnapshotMeta];

async function readProjectSourcesMeta(installationKey) {
  const metas = await Promise.all(PROJECT_SOURCE_METAS.map((read) => read(installationKey).catch(() => null)));
  return metas.some((m) => m?.version) ? { version: "composite" } : null;
}

async function collectProjects(installationKey) {
  const [wfMeta, itMeta, scMeta, acMeta] = await Promise.all(
    PROJECT_SOURCE_METAS.map((read) => read(installationKey).catch(() => null))
  );
  const projects = new Map();
  const set = (projectId, key, name, slot, value) => {
    const id = String(projectId);
    if (!projects.has(id)) projects.set(id, { key: id, name: null, fields: {} });
    const p = projects.get(id);
    if (key) p.key = key;
    if (name) p.name = name;
    p.fields[slot] = value;
  };

  if (wfMeta?.version) {
    const map = await loadProjectWorkflowSchemeMap(installationKey, wfMeta.version);
    for (const [projectId, sc] of map) set(projectId, null, null, "workflowScheme", sc.name || sc.schemeId);
  }
  if (itMeta?.version) {
    const [rows, schemes] = await Promise.all([
      loadIssueTypeSchemeProjects(installationKey, itMeta.version),
      loadIssueTypeSchemes(installationKey, itMeta.version),
    ]);
    const name = new Map(schemes.map((sc) => [String(sc.schemeId), sc.name]));
    for (const r of rows) set(r.projectId, r.projectKey, r.projectName, "issueTypeScheme", name.get(String(r.schemeId)) || r.schemeId);
  }
  if (scMeta?.version) {
    const [rows, itss] = await Promise.all([
      loadItssProjects(installationKey, scMeta.version),
      loadIssueTypeScreenSchemes(installationKey, scMeta.version),
    ]);
    const name = new Map(itss.map((it) => [String(it.itssId), it.name]));
    for (const r of rows) set(r.projectId, r.projectKey, r.projectName, "screenScheme", name.get(String(r.itssId)) || r.itssId);
  }
  if (acMeta?.version) {
    for (const [type, slot] of [["permission", "permissionScheme"], ["notification", "notificationScheme"], ["security", "securityScheme"]]) {
      // eslint-disable-next-line no-await-in-loop -- three small reads
      const [rows, schemes] = await Promise.all([
        loadSchemeProjects(installationKey, acMeta.version, type),
        loadSchemes(installationKey, acMeta.version, type),
      ]);
      const name = new Map(schemes.map((sc) => [String(sc.id), sc.name]));
      for (const r of rows) set(r.projectId, r.projectKey, r.projectName, slot, name.get(String(r.schemeId)) || r.schemeId);
    }
  }
  return [...projects.entries()].map(([id, p]) => ({
    entityType: "project",
    entityId: id,
    label: p.key,
    fields: { name: p.name, ...p.fields },
  }));
}

// The registry. `health` names the scored pillars each source covers (checked by
// pillar-completeness.test.js: every scored pillar must have one). `readMeta` returns the pillar's snapshot meta -- a falsy `version` means the
// inventory has never been built, so the pillar is skipped rather than reported as emptied.
export const DRIFT_PILLARS = [
  { pillar: "fields", health: ["fields"], label: "Fields", readMeta: readSnapshotMeta, collect: collectFields },
  { pillar: "workflow", health: ["workflows"], label: "Workflows", readMeta: readWorkflowSnapshotMeta, collect: collectWorkflow },
  { pillar: "issueTypes", health: ["issueTypes"], label: "Issue types", readMeta: readIssueTypeSnapshotMeta, collect: collectIssueTypes },
  { pillar: "access", health: ["permissions", "security", "notifications", "roles"], label: "Access", readMeta: readAccessSnapshotMeta, collect: collectAccess },
  { pillar: "estate", health: ["estate"], label: "Priorities & resolutions", readMeta: readEstateSnapshotMeta, collect: collectEstate },
  { pillar: "fieldConfigs", health: ["fieldConfigs"], label: "Field schemes", readMeta: readFieldConfigSnapshotMeta, collect: collectFieldConfigs },
  { pillar: "filters", health: ["filters"], label: "Saved filters", readMeta: readFilterSnapshotMeta, collect: collectFilters },
  { pillar: "dashboards", health: ["dashboards"], label: "Dashboards", readMeta: readDashboardSnapshotMeta, collect: collectDashboards },
  { pillar: "workflowRules", health: ["workflows"], label: "Workflows & transition rules", readMeta: readWorkflowSnapshotMeta, collect: collectWorkflowDetail },
  { pillar: "screens", health: ["screens"], label: "Screens", readMeta: readScreenSnapshotMeta, collect: collectScreens },
  { pillar: "projects", health: ["projects"], label: "Projects", readMeta: readProjectSourcesMeta, collect: collectProjects },
  { pillar: "boards", health: ["boards"], label: "Boards", readMeta: readBoardSnapshotMeta, collect: collectBoards },
  { pillar: "people", health: ["users"], label: "People", readMeta: readUserSnapshotMeta, collect: collectPeople },
  { pillar: "assets", health: ["assets"], label: "Assets", readMeta: readAssetSnapshotMeta, collect: collectAssets },
  { pillar: "jsm", health: ["requestTypes", "queues", "slas", "customers"], label: "Service management", readMeta: readJsmSnapshotMeta, collect: collectJsm },
  { pillar: "automation", health: ["automation"], label: "Automation", readMeta: readAutomationMeta, collect: collectAutomation },
];

// ── Diff ────────────────────────────────────────────────────────────────────

const TYPE_NOUNS = {
  field: "Field",
  status: "Status",
  "workflow-scheme": "Workflow scheme",
  "issue-type": "Issue type",
  "issue-type-scheme": "Issue type scheme",
  resolution: "Resolution",
  priority: "Priority",
  "permission-scheme": "Permission scheme",
  "security-scheme": "Issue security scheme",
  "notification-scheme": "Notification scheme",
  "permission-grant": "Permission grant",
  "security-grant": "Security level member",
  "notification-grant": "Notification recipient",
  "project-role-scheme": "Project role",
  "project-role-grant": "Project role actor",
  "security-level": "Security level",
  filter: "Saved filter",
  dashboard: "Dashboard",
  "field-scheme": "Field scheme",
  "field-configuration": "Field configuration",
  "field-scheme-assignment": "Project field scheme",
  workflow: "Workflow",
  screen: "Screen",
  "screen-scheme": "Screen scheme",
  "issue-type-screen-scheme": "Issue type screen scheme",
  project: "Project",
  board: "Board",
  user: "Licensed user",
  "asset-schema": "Assets schema",
  "asset-object-type": "Assets object type",
  "asset-attribute": "Assets attribute",
  "automation-rule": "Automation rule",
};

function noun(entityType) {
  return TYPE_NOUNS[entityType] || entityType;
}

// The human sentence for one change. For a modify, name the fields that actually differ.
function summarize(kind, entityType, label, prevFields, nextFields) {
  const what = label ? `${noun(entityType)} "${label}"` : noun(entityType);
  if (kind === "added") return `${what} added`;
  if (kind === "removed") return `${what} removed`;
  const changed = [];
  const keys = new Set([...Object.keys(prevFields || {}), ...Object.keys(nextFields || {})]);
  for (const k of keys) {
    const a = JSON.stringify((prevFields || {})[k] ?? null);
    const b = JSON.stringify((nextFields || {})[k] ?? null);
    if (a !== b) changed.push(k);
  }
  return changed.length
    ? `${what} changed: ${changed.join(", ")}`
    : `${what} reconfigured`;
}

// Compare the previous digest rows against the freshly collected entities. Keyed by
// entityType + entityId within a pillar.
export function diffEntitySets(prevRows = [], nextEntities = []) {
  const prev = new Map(prevRows.map((r) => [`${r.entityType} ${r.entityId}`, r]));
  const next = new Map(nextEntities.map((e) => [`${e.entityType} ${e.entityId}`, e]));

  const changes = [];
  for (const [key, e] of next) {
    const digest = digestFields(e.fields);
    const before = prev.get(key);
    if (!before) {
      changes.push({ changeKind: "added", entityType: e.entityType, entityId: e.entityId, label: e.label, summary: summarize("added", e.entityType, e.label) });
    } else if (before.digest !== digest) {
      changes.push({
        changeKind: "modified", entityType: e.entityType, entityId: e.entityId, label: e.label,
        summary: summarize("modified", e.entityType, e.label, before.fields, e.fields),
      });
    }
  }
  for (const [key, r] of prev) {
    if (!next.has(key)) {
      changes.push({ changeKind: "removed", entityType: r.entityType, entityId: r.entityId, label: r.label, summary: summarize("removed", r.entityType, r.label) });
    }
  }
  return changes;
}

// The entities in the shape replaceEntityDigests wants (digest computed here).
function toDigestRows(entities) {
  return entities.map((e) => ({
    entityType: e.entityType, entityId: e.entityId, label: e.label,
    digest: digestFields(e.fields), fields: e.fields,
  }));
}

// ── Orchestrator ────────────────────────────────────────────────────────────

export async function queueDriftSnapshotBuild(installationKey) {
  await ensureProjectStoreReady();
  await writeDriftSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });
  await inventorySnapshotQueue.push({ body: { jobType: "build-drift-snapshot", installationKey } });
}

export async function buildDriftSnapshot(installationKey) {
  incrMetric(METRIC_NAMES.driftSnapshotStarted);
  await ensureProjectStoreReady();
  await writeDriftSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });

  try {
    const version = String(Date.now());
    const detectedAt = new Date().toISOString();
    const prevMeta = await readDriftSnapshotMeta(installationKey);

    const allChangeRows = [];
    const seededThisRun = [];
    let seq = 0;

    for (const spec of DRIFT_PILLARS) {
      const meta = await spec.readMeta(installationKey).catch(() => null);
      if (!meta?.version) continue; // inventory never built -- skip, don't report as emptied

      const [entities, prevRows] = await Promise.all([
        spec.collect(installationKey, meta.version).catch((err) => {
          logger.warn("drift.collect_failed", { pillar: spec.pillar, error: String(err?.message || err) });
          return null;
        }),
        loadEntityDigests(installationKey, spec.pillar),
      ]);
      if (entities === null) continue; // a load failed -- leave this pillar's digests untouched

      // First time we have ever digested this pillar: seed silently.
      if (prevRows.length === 0) {
        await replaceEntityDigests(installationKey, spec.pillar, toDigestRows(entities));
        seededThisRun.push(spec.pillar);
        continue;
      }

      const changes = diffEntitySets(prevRows, entities);
      for (const c of changes) {
        allChangeRows.push({
          changeId: `${version}-${String(seq++).padStart(5, "0")}`,
          detectedAt,
          scanVersion: version,
          pillar: spec.pillar,
          ...c,
        });
      }
      await replaceEntityDigests(installationKey, spec.pillar, toDigestRows(entities));
    }

    if (allChangeRows.length) {
      await appendConfigChanges(installationKey, allChangeRows);
    }

    const completedAt = new Date().toISOString();
    const seededPillars = [...new Set([...(prevMeta?.seededPillars || []), ...seededThisRun])];
    await writeDriftSnapshotMeta(installationKey, {
      state: "ready",
      version,
      completedAt,
      refreshedAt: completedAt,
      lastRunChanges: allChangeRows.length,
      totalChanges: (prevMeta?.totalChanges || 0) + allChangeRows.length,
      seededPillars,
      lastError: null,
    });

    incrMetric(METRIC_NAMES.driftSnapshotCompleted);
    logger.info("drift-snapshot.completed", { version, changes: allChangeRows.length, seeded: seededThisRun });
    return { version, changes: allChangeRows.length, seeded: seededThisRun };
  } catch (error) {
    incrMetric(METRIC_NAMES.driftSnapshotFailed);
    const message = String(error?.message || error);
    logger.error("drift-snapshot.failed", { error: message });
    await writeDriftSnapshotMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: message,
    });
    throw error;
  }
}
