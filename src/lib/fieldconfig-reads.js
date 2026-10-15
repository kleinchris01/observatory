// Read resolvers over the field behaviour snapshot (fieldconfig-engine.js). Registered in the
// admin registry in resolvers.js, so the admin guard covers every one of them.
//
// Tri-state like the rest of the app: no snapshot is `neverBuilt` / available:false, never an
// empty list that reads as "no field is required anywhere".

import { incrMetric, METRIC_NAMES, getInstallationKey } from "./jira-api.js";
import {
  ensureProjectStoreReady,
  readFieldConfigSnapshotMeta,
  loadFieldConfigSchemes,
  loadFieldConfigConfigs,
  loadFieldConfigMappings,
  loadFieldConfigSchemeProjects,
  loadFieldConfigItemsForField,
  loadFieldConfigItemsForOwner,
  readIssueTypeSnapshotMeta,
  loadIssueTypes,
  readSnapshotMeta,
  loadSnapshotFields,
} from "./project-store.js";
import { SOURCE_LABEL } from "./fieldconfig-insights.js";
import { isFieldConfigBuildStale } from "./fieldconfig-engine.js";
import { pillarUnavailable, agentOk, agentNotFound, rankMatches, clampResults } from "./rovo-agents.js";

// Jira's system fields by id, for labels: the field snapshot carries custom fields only.
const SYSTEM_FIELD_NAMES = {
  summary: "Summary",
  description: "Description",
  assignee: "Assignee",
  reporter: "Reporter",
  priority: "Priority",
  labels: "Labels",
  components: "Components",
  fixVersions: "Fix versions",
  versions: "Affects versions",
  duedate: "Due date",
  environment: "Environment",
  timetracking: "Time tracking",
  attachment: "Attachment",
  issuelinks: "Linked issues",
  resolution: "Resolution",
  security: "Security level",
  worklog: "Log work",
  comment: "Comment",
  parent: "Parent",
  issuetype: "Work type",
  project: "Project",
};

async function namesFor(installationKey) {
  const [typeMeta, fieldMeta] = await Promise.all([
    readIssueTypeSnapshotMeta(installationKey).catch(() => null),
    readSnapshotMeta(installationKey).catch(() => null),
  ]);
  const [types, fields] = await Promise.all([
    typeMeta?.version ? loadIssueTypes(installationKey, typeMeta.version).catch(() => []) : [],
    fieldMeta?.version ? loadSnapshotFields(installationKey, fieldMeta.version).catch(() => []) : [],
  ]);
  const typeNames = new Map(types.map((t) => [String(t.id), t.name]));
  const fieldNames = new Map(fields.map((f) => [String(f.id), f.name]));
  return {
    workType: (id) =>
      id === "*"
        ? "All work types"
        : id === "default"
          ? "Default (unmapped work types)"
          : typeNames.get(String(id)) || `Work type ${id}`,
    field: (id) => fieldNames.get(String(id)) || SYSTEM_FIELD_NAMES[id] || id,
  };
}

function snapshotStatus(meta) {
  return {
    state: meta?.state || "idle",
    staleBuild: isFieldConfigBuildStale(meta),
    refreshedAt: meta?.refreshedAt || null,
    startedAt: meta?.startedAt || null,
    lastError: meta?.lastError || null,
    source: meta?.source || null,
    sourceLabel: meta?.source ? SOURCE_LABEL[meta.source] || meta.source : null,
    fallbackReason: meta?.fallbackReason || null,
    unreadOwners: meta?.unreadOwners ?? 0,
  };
}

// The whole pillar for the tab: schemes with their projects, legacy configurations with the
// schemes and work types that route to them, the stored findings, and the summary.
export async function getFieldConfigInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const meta = await readFieldConfigSnapshotMeta(installationKey);
  if (!meta?.version) {
    return {
      ...snapshotStatus(meta),
      neverBuilt: true,
      schemes: [],
      configs: [],
      summary: null,
      inconsistentRequired: [],
    };
  }

  const [schemes, configs, mappings, projects, names] = await Promise.all([
    loadFieldConfigSchemes(installationKey, meta.version),
    loadFieldConfigConfigs(installationKey, meta.version),
    loadFieldConfigMappings(installationKey, meta.version),
    loadFieldConfigSchemeProjects(installationKey, meta.version),
    namesFor(installationKey),
  ]);

  const projectsByScheme = new Map();
  for (const p of projects) {
    if (!projectsByScheme.has(p.schemeId)) projectsByScheme.set(p.schemeId, []);
    projectsByScheme
      .get(p.schemeId)
      .push({ projectId: p.projectId, projectKey: p.projectKey, projectName: p.projectName });
  }
  const configName = new Map(configs.map((c) => [c.id, c.name]));
  const schemeName = new Map(schemes.map((s) => [s.id, s.name]));
  const routesByScheme = new Map();
  const routesByConfig = new Map();
  for (const m of mappings) {
    const route = {
      schemeId: m.schemeId,
      schemeName: schemeName.get(m.schemeId) || m.schemeId,
      workTypeId: m.workTypeId,
      workTypeName: names.workType(m.workTypeId),
      configId: m.configId,
      configName: configName.get(m.configId) || m.configId,
    };
    if (!routesByScheme.has(m.schemeId)) routesByScheme.set(m.schemeId, []);
    routesByScheme.get(m.schemeId).push(route);
    if (!routesByConfig.has(m.configId)) routesByConfig.set(m.configId, []);
    routesByConfig.get(m.configId).push(route);
  }

  return {
    ...snapshotStatus(meta),
    neverBuilt: false,
    summary: meta.summary,
    schemes: schemes.map((s) => {
      const list = projectsByScheme.get(s.id) || [];
      return {
        ...s,
        projects: list.slice(0, 50),
        projectsTruncated: list.length > 50,
        routes: routesByScheme.get(s.id) || [],
      };
    }),
    configs: configs.map((c) => ({
      ...c,
      requiredHidden: c.requiredHidden.map((id) => ({ fieldId: id, fieldName: names.field(id) })),
      routes: routesByConfig.get(c.id) || [],
    })),
    inconsistentRequired: (meta.inconsistentRequired || [])
      .slice(0, 100)
      .map((r) => ({ ...r, fieldName: names.field(r.fieldId) })),
  };
}

// One scheme's (current model) or configuration's (legacy) fields, paged.
export async function getFieldConfigItems({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const ownerKind = payload?.ownerKind === "config" ? "config" : "scheme";
  const ownerId = String(payload?.ownerId || "").trim();
  if (!ownerId) throw new Error("ownerId is required");

  const meta = await readFieldConfigSnapshotMeta(installationKey);
  if (!meta?.version) return { available: false, reason: "no-snapshot", items: [], total: 0 };

  const [page, names] = await Promise.all([
    loadFieldConfigItemsForOwner(installationKey, meta.version, ownerKind, ownerId, {
      offset: payload?.offset,
      limit: payload?.limit,
      requiredOnly: payload?.requiredOnly === true,
    }),
    namesFor(installationKey),
  ]);
  return {
    available: true,
    refreshedAt: meta.refreshedAt || null,
    source: meta.source,
    // Legacy items are only the notable ones: every other field in the configuration is
    // visible and optional, which the tab says rather than listing three thousand rows.
    notableOnly: ownerKind === "config",
    total: page.total,
    items: page.items.map((i) => ({
      ...i,
      fieldName: names.field(i.fieldId),
      workTypeName: names.workType(i.workTypeId),
      restrictedToNames: (i.restrictedTo || []).map(names.workType),
    })),
  };
}

// What every scheme or configuration does to one field: the field card's question. Covers
// the absences too -- on field schemes, a measured scheme that does not associate the field
// means the field does not exist in that scheme's projects at all.
export async function getFieldBehaviour({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const fieldId = String(payload?.fieldId || "").trim();
  if (!fieldId) throw new Error("fieldId is required");

  const meta = await readFieldConfigSnapshotMeta(installationKey);
  if (!meta?.version) return { available: false, reason: "no-snapshot", fieldId };

  const [items, schemes, configs, mappings, projects, names] = await Promise.all([
    loadFieldConfigItemsForField(installationKey, meta.version, fieldId),
    loadFieldConfigSchemes(installationKey, meta.version),
    loadFieldConfigConfigs(installationKey, meta.version),
    loadFieldConfigMappings(installationKey, meta.version),
    loadFieldConfigSchemeProjects(installationKey, meta.version),
    namesFor(installationKey),
  ]);
  const projectKeys = new Map();
  for (const p of projects) {
    if (!projectKeys.has(p.schemeId)) projectKeys.set(p.schemeId, []);
    projectKeys.get(p.schemeId).push(p.projectKey);
  }
  const base = {
    available: true,
    refreshedAt: meta.refreshedAt || null,
    source: meta.source,
    sourceLabel: SOURCE_LABEL[meta.source] || meta.source,
    fieldId,
    fieldName: names.field(fieldId),
  };

  if (meta.source === "field-schemes") {
    const byScheme = new Map();
    for (const item of items) {
      if (!byScheme.has(item.ownerId)) byScheme.set(item.ownerId, []);
      byScheme.get(item.ownerId).push(item);
    }
    const rows = schemes
      .filter((s) => s.projectCount > 0 || s.isDefault)
      .map((s) => {
        const own = byScheme.get(s.id) || [];
        const baseItem = own.find((i) => i.workTypeId === "*");
        return {
          ownerKind: "scheme",
          id: s.id,
          name: s.name,
          projectCount: s.projectCount,
          projectKeys: (projectKeys.get(s.id) || []).slice(0, 12),
          measured: s.measured,
          associated: s.measured ? Boolean(baseItem) : null,
          required: baseItem ? Boolean(baseItem.required) : null,
          description: baseItem?.description || null,
          renderer: baseItem?.renderer || null,
          restrictedTo: (baseItem?.restrictedTo || []).map(names.workType),
          overrides: own
            .filter((i) => i.workTypeId !== "*")
            .map((i) => ({
              workTypeName: names.workType(i.workTypeId),
              required: i.required,
              description: i.description,
            })),
        };
      });
    return {
      ...base,
      requiredIn: rows.filter((r) => r.required).length,
      missingFrom: rows.filter((r) => r.associated === false),
      owners: rows,
    };
  }

  // Legacy: a configuration either has a notable item for the field, or -- when its items
  // were read -- the field is visible and optional there.
  const itemByConfig = new Map(items.filter((i) => i.ownerKind === "config").map((i) => [i.ownerId, i]));
  const schemeById = new Map(schemes.map((s) => [s.id, s]));
  const routes = new Map();
  for (const m of mappings) {
    if (!routes.has(m.configId)) routes.set(m.configId, []);
    const scheme = schemeById.get(m.schemeId);
    routes
      .get(m.configId)
      .push({
        schemeName: scheme?.name || m.schemeId,
        workTypeName: names.workType(m.workTypeId),
        projectKeys: (projectKeys.get(m.schemeId) || []).slice(0, 12),
        projectCount: scheme?.projectCount || 0,
      });
  }
  const rows = configs
    .filter((c) => c.used || itemByConfig.has(c.id))
    .map((c) => {
      const item = itemByConfig.get(c.id);
      return {
        ownerKind: "config",
        id: c.id,
        name: c.name,
        used: c.used,
        measured: c.itemsRead,
        hidden: item ? Boolean(item.hidden) : c.itemsRead ? false : null,
        required: item ? Boolean(item.required) : c.itemsRead ? false : null,
        description: item?.description || null,
        renderer: item?.renderer || null,
        routes: routes.get(c.id) || [],
      };
    });
  return {
    ...base,
    requiredIn: rows.filter((r) => r.required).length,
    hiddenIn: rows.filter((r) => r.hidden).length,
    conflicts: rows.filter((r) => r.required && r.hidden),
    owners: rows,
  };
}

// ── Rovo: field scheme expert ─────────────────────────────────────────────────────────────
//
// Three thin wrappers over the reads above, on the shared agent contract (rovo-agents.js):
// a result, or an explicit "field schemes-unavailable", always with refreshedAt.

const PILLAR = "field schemes";

// A field id from a name or an id, via the field snapshot. Null when nothing matches.
async function resolveFieldId(installationKey, query) {
  const q = String(query || "").trim();
  if (!q) return null;
  if (/^customfield_\d+$/.test(q) || SYSTEM_FIELD_NAMES[q]) return q;
  const fieldMeta = await readSnapshotMeta(installationKey).catch(() => null);
  const fields = fieldMeta?.version ? await loadSnapshotFields(installationKey, fieldMeta.version).catch(() => []) : [];
  const system = Object.entries(SYSTEM_FIELD_NAMES).map(([id, name]) => ({ id, name }));
  const [hit] = rankMatches([...fields, ...system], q, (f) => [f.name, f.id], 1);
  return hit?.id || null;
}

export async function rovoFieldConfigSearch(payload, context) {
  const query = String(payload?.query || "").trim();
  const limit = clampResults(payload?.maxResults, 8, 20);
  if (!query) return { status: "error", message: "A search query is required." };

  const inv = await getFieldConfigInventory({ context });
  if (inv.neverBuilt) return pillarUnavailable(PILLAR, { state: inv.state, refreshedAt: null });

  const shape = (o) => ({
    id: o.id,
    name: o.name,
    isDefault: o.isDefault,
    projectCount: o.projectCount ?? null,
    findings: o.codes,
  });
  return agentOk(inv.refreshedAt, {
    query,
    model: inv.sourceLabel,
    schemes: rankMatches(
      inv.schemes,
      query,
      (s) => [s.name, s.id, ...(s.projects || []).map((p) => p.projectKey)],
      limit,
    ).map(shape),
    configurations: rankMatches(inv.configs, query, (c) => [c.name, c.id], limit).map(shape),
  });
}

export async function rovoFieldConfigInspect(payload, context) {
  const identifier = String(payload?.identifier || "").trim();
  if (!identifier) return { status: "error", message: "A scheme or configuration name is required." };

  const inv = await getFieldConfigInventory({ context });
  if (inv.neverBuilt) return pillarUnavailable(PILLAR, { state: inv.state, refreshedAt: null });

  const [scheme] = rankMatches(inv.schemes, identifier, (s) => [s.name, s.id], 1);
  const [config] = rankMatches(inv.configs, identifier, (c) => [c.name, c.id], 1);
  const target =
    scheme && (!config || scheme.name?.toLowerCase() === identifier.toLowerCase())
      ? { kind: "scheme", row: scheme }
      : config
        ? { kind: "config", row: config }
        : null;
  if (!target) return agentNotFound(inv.refreshedAt, `No field scheme or configuration matches "${identifier}".`);

  const required = await getFieldConfigItems({
    payload: { ownerKind: target.kind, ownerId: target.row.id, requiredOnly: true, limit: 100 },
    context,
  });
  return agentOk(inv.refreshedAt, {
    model: inv.sourceLabel,
    kind: target.kind === "scheme" ? "scheme" : "field configuration",
    name: target.row.name,
    id: target.row.id,
    isDefault: target.row.isDefault,
    findings: target.row.codes,
    duplicateOf: target.row.duplicateOf,
    projects: (target.row.projects || []).map((p) => p.projectKey),
    projectCount: target.row.projectCount ?? null,
    routes: (target.row.routes || []).map((r) => `${r.schemeName}: ${r.workTypeName} -> ${r.configName}`),
    requiredHiddenFields: (target.row.requiredHidden || []).map((f) => f.fieldName),
    requiredFields: required.available
      ? required.items.map((i) => (i.workTypeId === "*" ? i.fieldName : `${i.fieldName} (${i.workTypeName})`))
      : null,
    requiredFieldsTotal: required.available ? required.total : null,
  });
}

export async function rovoFieldConfigImpact(payload, context) {
  const installationKey = getInstallationKey(context);
  const fieldId = await resolveFieldId(installationKey, payload?.field);
  if (!fieldId) return { status: "error", message: "Name a field (its name or id, e.g. customfield_10021)." };

  const behaviour = await getFieldBehaviour({ payload: { fieldId }, context });
  if (!behaviour.available) return pillarUnavailable(PILLAR, { state: "idle", refreshedAt: null });

  return agentOk(behaviour.refreshedAt, {
    model: behaviour.sourceLabel,
    field: { id: fieldId, name: behaviour.fieldName },
    requiredIn: behaviour.requiredIn,
    hiddenIn: behaviour.hiddenIn ?? null,
    requiredButHiddenIn: (behaviour.conflicts || []).map((c) => c.name),
    notAvailableIn: (behaviour.missingFrom || []).map((m) => ({ scheme: m.name, projectCount: m.projectCount })),
    owners: behaviour.owners.map((o) => ({
      name: o.name,
      kind: o.ownerKind === "scheme" ? "field scheme" : "field configuration",
      measured: o.measured,
      associated: o.associated ?? null,
      required: o.required,
      hidden: o.hidden ?? null,
      restrictedTo: o.restrictedTo || [],
      workTypeOverrides: o.overrides || [],
      usedBy: o.routes
        ? o.routes.map((r) => `${r.schemeName} (${r.workTypeName}, ${r.projectCount} projects)`)
        : o.projectKeys || [],
    })),
  });
}
