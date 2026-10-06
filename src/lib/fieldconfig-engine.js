// Builds the field behaviour snapshot: what Jira enforces on each field, per project and per
// work type -- required, hidden, description, renderer -- and which fields a project has at
// all.
//
// Two models, one snapshot. Jira is retiring field configurations and field configuration
// schemes in favour of field schemes (GA, progressive rollout from June 2026):
//
//   legacy   project -> field configuration scheme -> (work type -> field configuration)
//                                                        -> items: hidden / required / ...
//   current  project -> field scheme -> associated fields: required / description /
//                                       renderer, overridable per work type, optionally
//                                       restricted to some work types
//
// Which one a site is on is not something the app can know in advance, and a site can be
// mid-migration. So the build asks the current endpoint first and falls back to the legacy
// pair, records which one answered (`source`), and normalises both into one row shape so the
// score, the tab and the field card never branch on the model more than they must.

import { logger } from "./logger.js";
import { inventorySnapshotQueue } from "./queues.js";
import {
  incrMetric,
  METRIC_NAMES,
  getAllJiraProjects,
  getAllFieldSchemes,
  getFieldSchemeProjectAssignments,
  getFieldSchemeFields,
  getAllFieldConfigurations,
  getFieldConfigurationItems,
  getAllFieldConfigurationSchemes,
  getFieldConfigurationSchemeMappings,
  getFieldConfigurationSchemeProjects,
  mapWithConcurrency,
} from "./jira-api.js";
import {
  ensureProjectStoreReady,
  writeFieldConfigSnapshotMeta,
  replaceFieldConfigSnapshot,
} from "./project-store.js";
import { analyzeFieldBehaviour } from "./fieldconfig-insights.js";

export const FIELD_CONFIG_BUILD_STALE_MS = 16 * 60 * 1000;

// How long the per-configuration item walk may run before it stops and records the rest as
// unread. The consumer ceiling is 900s; this leaves room for the list calls before it and the
// writes after it. A site with three hundred configurations and three thousand fields is
// thousands of calls, and a build killed mid-walk publishes nothing at all.
export const ITEM_WALK_BUDGET_MS = 9 * 60 * 1000;

export const SOURCE = { FIELD_SCHEMES: "field-schemes", LEGACY: "field-configurations" };

// The legacy model's implicit scheme: projects assigned no field configuration scheme use the
// default field configuration for every work type.
export const LEGACY_DEFAULT_SCHEME_ID = "fcs:default";

export function isFieldConfigBuildStale(meta, now = Date.now()) {
  if (meta?.state !== "building") return false;
  const startedAt = Date.parse(meta?.startedAt || "");
  if (!Number.isFinite(startedAt)) return true;
  return now - startedAt > FIELD_CONFIG_BUILD_STALE_MS;
}

export async function queueFieldConfigSnapshotBuild(installationKey) {
  await ensureProjectStoreReady();
  await writeFieldConfigSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });
  await inventorySnapshotQueue.push({ body: { jobType: "build-fieldconfig-snapshot", installationKey } });
}

const str = (v) => (v == null || v === "" ? null : String(v));
const bool = (v) => v === true || v === "true";

function projectRow(schemeId, projectId, projectsById) {
  const project = projectsById.get(String(projectId));
  return {
    schemeId,
    projectId: String(projectId),
    projectKey: project?.key || "UNKNOWN",
    projectName: project?.name || "Unknown project",
  };
}

// ── Current model ────────────────────────────────────────────────────────────────────────

// One associated field -> its base row plus one row per work-type override.
export function normalizeSchemeField(schemeId, raw) {
  const fieldId = str(raw?.fieldId);
  if (!fieldId) return [];
  const params = raw?.parameters || {};
  const rows = [{
    ownerKind: "scheme",
    ownerId: schemeId,
    workTypeId: "*",
    fieldId,
    associated: true,
    hidden: null,
    required: bool(params.isRequired),
    description: str(params.description),
    renderer: str(params.rendererType),
    restrictedTo: (raw?.restrictedToWorkTypes || []).map(String),
  }];
  for (const override of raw?.workTypeParameters || []) {
    const workTypeId = str(override?.workTypeId);
    if (!workTypeId) continue;
    rows.push({
      ownerKind: "scheme",
      ownerId: schemeId,
      workTypeId,
      fieldId,
      associated: true,
      hidden: null,
      required: override.isRequired == null ? null : bool(override.isRequired),
      description: str(override.description),
      renderer: str(override.rendererType),
      restrictedTo: [],
    });
  }
  return rows;
}

// ── Legacy model ─────────────────────────────────────────────────────────────────────────

// A legacy item worth keeping. Every field appears in every configuration; one that is
// visible, optional, undescribed and on the default renderer says nothing a reader needs,
// and keeping them would be configurations x fields rows of noise.
export function isNotableItem(raw) {
  return bool(raw?.isHidden) || bool(raw?.isRequired) || Boolean(str(raw?.description));
}

export function normalizeConfigItem(configId, raw) {
  return {
    ownerKind: "config",
    ownerId: configId,
    workTypeId: "*",
    fieldId: String(raw.id),
    associated: null,
    hidden: bool(raw.isHidden),
    required: bool(raw.isRequired),
    description: str(raw.description),
    renderer: str(raw.renderer),
    restrictedTo: [],
  };
}

// Item walk under a time budget, used configurations first. Returns the rows read and, per
// configuration, whether its items were read -- an unread configuration is "unmeasured",
// never "has no required fields".
export async function walkWithBudget(owners, fetchItems, toRows, { budgetMs = ITEM_WALK_BUDGET_MS, now = Date.now, concurrency = 6 } = {}) {
  const started = now();
  const rows = [];
  const read = new Map();
  await mapWithConcurrency(owners, concurrency, async (owner) => {
    if (now() - started > budgetMs) {
      read.set(owner.id, { read: false, fieldCount: null, reason: "time budget" });
      return;
    }
    try {
      const items = await fetchItems(owner.sourceId);
      rows.push(...toRows(owner.id, items));
      read.set(owner.id, { read: true, fieldCount: items.length });
    } catch (error) {
      read.set(owner.id, { read: false, fieldCount: null, reason: String(error?.message || error).slice(0, 200) });
    }
  });
  return { rows, read };
}

// ── Build ────────────────────────────────────────────────────────────────────────────────

async function readCurrentModel(projectsById, walkOptions) {
  const rawSchemes = await getAllFieldSchemes();
  if (!rawSchemes.length) return null;

  const schemes = rawSchemes
    .filter((s) => s?.id != null)
    .map((s) => ({
      id: `fs:${s.id}`,
      sourceId: String(s.id),
      source: SOURCE.FIELD_SCHEMES,
      name: s.name || null,
      description: s.description || null,
      isDefault: Boolean(s.isDefault),
      declaredFieldCount: s.fieldsCount == null ? null : Number(s.fieldsCount),
    }));

  const assignments = await getFieldSchemeProjectAssignments();
  const schemeProjects = assignments
    .filter((a) => a?.projectId != null && a?.schemeId != null)
    .map((a) => projectRow(`fs:${a.schemeId}`, a.projectId, projectsById));

  // Used schemes first, so a walk that runs out of budget has read the ones that matter.
  const used = new Set(schemeProjects.map((p) => p.schemeId));
  const ordered = [...schemes].sort((a, b) => Number(used.has(b.id)) - Number(used.has(a.id)));
  const { rows, read } = await walkWithBudget(
    ordered,
    getFieldSchemeFields,
    (schemeId, items) => items.flatMap((raw) => normalizeSchemeField(schemeId, raw)),
    walkOptions
  );

  return { source: SOURCE.FIELD_SCHEMES, schemes, schemeProjects, configs: [], mappings: [], items: rows, read };
}

async function readLegacyModel(projectsById, projects, walkOptions) {
  const [rawConfigs, rawSchemes, rawMappings] = await Promise.all([
    getAllFieldConfigurations(),
    getAllFieldConfigurationSchemes(),
    getFieldConfigurationSchemeMappings(),
  ]);
  if (!rawConfigs.length) return null;

  const configs = rawConfigs
    .filter((c) => c?.id != null)
    .map((c) => ({
      id: `fc:${c.id}`,
      sourceId: String(c.id),
      name: c.name || null,
      description: c.description || null,
      isDefault: Boolean(c.isDefault),
    }));
  const defaultConfig = configs.find((c) => c.isDefault) || null;

  const schemes = rawSchemes
    .filter((s) => s?.id != null)
    .map((s) => ({
      id: `fcs:${s.id}`,
      sourceId: String(s.id),
      source: SOURCE.LEGACY,
      name: s.name || null,
      description: s.description || null,
      isDefault: false,
      declaredFieldCount: null,
    }));
  // The implicit scheme every unassigned project is on.
  schemes.unshift({
    id: LEGACY_DEFAULT_SCHEME_ID,
    sourceId: null,
    source: SOURCE.LEGACY,
    name: "Default field configuration scheme",
    description: "Projects with no field configuration scheme use the default field configuration for every work type.",
    isDefault: true,
    declaredFieldCount: null,
  });

  const mappings = rawMappings
    .filter((m) => m?.fieldConfigurationSchemeId != null && m?.fieldConfigurationId != null)
    .map((m) => ({
      schemeId: `fcs:${m.fieldConfigurationSchemeId}`,
      workTypeId: str(m.issueTypeId) || "default",
      configId: `fc:${m.fieldConfigurationId}`,
    }));
  if (defaultConfig) mappings.push({ schemeId: LEGACY_DEFAULT_SCHEME_ID, workTypeId: "default", configId: defaultConfig.id });

  const projectRows = await getFieldConfigurationSchemeProjects(projects.map((p) => p.id));
  const schemeProjects = [];
  for (const row of projectRows) {
    const schemeId = row?.fieldConfigurationScheme?.id != null ? `fcs:${row.fieldConfigurationScheme.id}` : LEGACY_DEFAULT_SCHEME_ID;
    for (const projectId of row?.projectIds || []) schemeProjects.push(projectRow(schemeId, projectId, projectsById));
  }

  // A configuration is used when a scheme some project uses maps to it.
  const usedSchemes = new Set(schemeProjects.map((p) => p.schemeId));
  const usedConfigs = new Set(mappings.filter((m) => usedSchemes.has(m.schemeId)).map((m) => m.configId));
  const ordered = [...configs].sort((a, b) => Number(usedConfigs.has(b.id)) - Number(usedConfigs.has(a.id)));
  const { rows, read } = await walkWithBudget(
    ordered,
    getFieldConfigurationItems,
    (configId, items) => items.filter((raw) => raw?.id != null && isNotableItem(raw)).map((raw) => normalizeConfigItem(configId, raw)),
    walkOptions
  );

  return { source: SOURCE.LEGACY, schemes, schemeProjects, configs, mappings, items: rows, read };
}

// Which model answered, with the reason the other did not. Exported for its test: this is
// the decision that, wrong, makes the whole pillar describe a model the site no longer has.
export async function readFieldBehaviour({ projects, walkOptions } = {}) {
  const projectsById = new Map(projects.map((p) => [String(p.id), p]));
  let currentError = null;
  try {
    const current = await readCurrentModel(projectsById, walkOptions);
    if (current) return { ...current, fallbackReason: null };
  } catch (error) {
    currentError = String(error?.message || error).slice(0, 300);
  }
  const legacy = await readLegacyModel(projectsById, projects, walkOptions);
  if (legacy) return { ...legacy, fallbackReason: currentError || "no field schemes on this site" };
  throw new Error(`Neither field schemes nor field configurations could be read${currentError ? `: ${currentError}` : ""}`);
}

export async function buildFieldConfigSnapshot(installationKey, { walkOptions } = {}) {
  incrMetric(METRIC_NAMES.fieldConfigSnapshotStarted);
  await ensureProjectStoreReady();
  await writeFieldConfigSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });

  try {
    const version = String(Date.now());
    const projects = await getAllJiraProjects();
    const model = await readFieldBehaviour({ projects, walkOptions });

    const ownerRead = (id) => model.read.get(id) || { read: false, fieldCount: null };
    const analysis = analyzeFieldBehaviour({
      source: model.source,
      schemes: model.schemes.map((s) => ({
        ...s,
        // Current model: the scheme owns its fields. Legacy: it only routes, so whether it
        // is measured is decided from the configurations it maps to.
        fieldsRead: model.source === SOURCE.FIELD_SCHEMES ? ownerRead(s.id).read : null,
      })),
      schemeProjects: model.schemeProjects,
      configs: model.configs.map((c) => ({ ...c, itemsRead: ownerRead(c.id).read, totalFieldCount: ownerRead(c.id).fieldCount })),
      mappings: model.mappings,
      items: model.items,
    });
    const fieldCount = new Map();
    for (const item of model.items) {
      if (item.workTypeId === "*") fieldCount.set(item.ownerId, (fieldCount.get(item.ownerId) || 0) + 1);
    }
    const schemes = analysis.schemes.map((s) => ({ ...s, fieldCount: model.source === SOURCE.FIELD_SCHEMES ? (fieldCount.get(s.id) || 0) : null }));
    const configs = analysis.configs.map((c) => ({ ...c, notableCount: fieldCount.get(c.id) || 0 }));

    await replaceFieldConfigSnapshot(installationKey, version, {
      schemes,
      schemeProjects: model.schemeProjects,
      configs,
      mappings: model.mappings,
      items: model.items,
    });

    const unread = [...model.read.values()].filter((r) => !r.read).length;
    const completedAt = new Date().toISOString();
    await writeFieldConfigSnapshotMeta(installationKey, {
      state: "ready",
      version,
      completedAt,
      refreshedAt: completedAt,
      source: model.source,
      fallbackReason: model.fallbackReason,
      totalSchemes: schemes.length,
      totalConfigs: configs.length,
      unreadOwners: unread,
      summary: analysis.summary,
      inconsistentRequired: analysis.inconsistentRequired,
      lastError: null,
    });

    incrMetric(METRIC_NAMES.fieldConfigSnapshotCompleted);
    logger.info("fieldconfig-snapshot.completed", {
      version, source: model.source, fallbackReason: model.fallbackReason,
      schemes: schemes.length, configs: configs.length, items: model.items.length, unread,
    });
    return { version, source: model.source, schemes: schemes.length, configs: configs.length, items: model.items.length, unread };
  } catch (error) {
    incrMetric(METRIC_NAMES.fieldConfigSnapshotFailed);
    const message = String(error?.message || error);
    logger.error("fieldconfig-snapshot.failed", { error: message });
    await writeFieldConfigSnapshotMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: message,
    });
    throw error;
  }
}
