// Storage for the field behaviour pillar (fieldconfig-engine.js): field schemes or legacy
// field configuration schemes, the projects on each, legacy configurations and their
// work-type mappings, and the per-field items. Versioned, full replace per scope.
//
// Findings are computed at build time (fieldconfig-insights.js) and stored on the scheme and
// configuration rows, so no read ever has to load every item to answer a question.

import { sql } from "@forge/sql";
import {
  chunkArray,
  deleteScopeInChunks,
  ensureProjectStoreReady,
  safeParseJson,
  toNumber,
  withSqlRetry,
} from "./core.js";

const TABLES = [
  "snapshot_fieldcfg_items",
  "snapshot_fieldcfg_mappings",
  "snapshot_fieldcfg_configs",
  "snapshot_fieldcfg_scheme_projects",
  "snapshot_fieldcfg_schemes",
];

const tri = (v) => (v == null ? null : v ? 1 : 0);
const fromTri = (v) => (v == null ? null : Boolean(toNumber(v)));

export async function replaceFieldConfigSnapshot(
  scopeKey,
  version,
  { schemes = [], schemeProjects = [], configs = [], mappings = [], items = [] } = {},
) {
  await ensureProjectStoreReady();
  // Items can run to tens of thousands of rows on a migrated site, so every DELETE is bounded.
  for (const table of TABLES) await deleteScopeInChunks(table, scopeKey);

  for (const batch of chunkArray(schemes, 50)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((s) => [
      scopeKey,
      version,
      String(s.id),
      s.source,
      s.sourceId ?? null,
      s.name == null ? null : String(s.name).slice(0, 255),
      s.description || null,
      s.isDefault ? 1 : 0,
      Number(s.projectCount) || 0,
      tri(s.measured),
      s.fieldCount == null ? null : Number(s.fieldCount),
      Number(s.requiredCount) || 0,
      Number(s.restrictedCount) || 0,
      JSON.stringify(s.codes || []),
      s.duplicateOf || null,
    ]);
    await withSqlRetry(() =>
      sql
        .prepare(
          `
        INSERT IGNORE INTO snapshot_fieldcfg_schemes
          (scope_key, version, scheme_id, source, source_id, name, description, is_default,
           project_count, measured, field_count, required_count, restricted_count, finding_codes, duplicate_of)
        VALUES ${valuesSql}
      `,
        )
        .bindParams(...params)
        .execute(),
    );
  }

  for (const batch of chunkArray(schemeProjects, 100)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((r) => [
      scopeKey,
      version,
      String(r.schemeId),
      String(r.projectId),
      r.projectKey || null,
      r.projectName || null,
    ]);
    await withSqlRetry(() =>
      sql
        .prepare(
          `
        INSERT IGNORE INTO snapshot_fieldcfg_scheme_projects
          (scope_key, version, scheme_id, project_id, project_key, project_name)
        VALUES ${valuesSql}
      `,
        )
        .bindParams(...params)
        .execute(),
    );
  }

  for (const batch of chunkArray(configs, 50)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((c) => [
      scopeKey,
      version,
      String(c.id),
      c.sourceId ?? null,
      c.name == null ? null : String(c.name).slice(0, 255),
      c.description || null,
      c.isDefault ? 1 : 0,
      c.used ? 1 : 0,
      c.itemsRead ? 1 : 0,
      c.totalFieldCount == null ? null : Number(c.totalFieldCount),
      Number(c.notableCount) || 0,
      Number(c.requiredCount) || 0,
      Number(c.hiddenCount) || 0,
      JSON.stringify(c.requiredHidden || []),
      JSON.stringify(c.codes || []),
      c.duplicateOf || null,
    ]);
    await withSqlRetry(() =>
      sql
        .prepare(
          `
        INSERT IGNORE INTO snapshot_fieldcfg_configs
          (scope_key, version, config_id, source_id, name, description, is_default, used, items_read,
           total_field_count, notable_count, required_count, hidden_count, required_hidden, finding_codes, duplicate_of)
        VALUES ${valuesSql}
      `,
        )
        .bindParams(...params)
        .execute(),
    );
  }

  for (const batch of chunkArray(mappings, 100)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((m) => [
      scopeKey,
      version,
      String(m.schemeId),
      String(m.workTypeId),
      String(m.configId),
    ]);
    await withSqlRetry(() =>
      sql
        .prepare(
          `
        INSERT IGNORE INTO snapshot_fieldcfg_mappings
          (scope_key, version, scheme_id, work_type_id, config_id)
        VALUES ${valuesSql}
      `,
        )
        .bindParams(...params)
        .execute(),
    );
  }

  for (const batch of chunkArray(items, 100)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((i) => [
      scopeKey,
      version,
      i.ownerKind,
      String(i.ownerId),
      String(i.workTypeId),
      String(i.fieldId).slice(0, 128),
      tri(i.associated),
      tri(i.hidden),
      tri(i.required),
      i.description == null ? null : String(i.description).slice(0, 2000),
      i.renderer == null ? null : String(i.renderer).slice(0, 64),
      (i.restrictedTo || []).length ? JSON.stringify(i.restrictedTo) : null,
    ]);
    await withSqlRetry(() =>
      sql
        .prepare(
          `
        INSERT IGNORE INTO snapshot_fieldcfg_items
          (scope_key, version, owner_kind, owner_id, work_type_id, field_id, associated, hidden, required, description, renderer, restricted_to)
        VALUES ${valuesSql}
      `,
        )
        .bindParams(...params)
        .execute(),
    );
  }
}

function mapScheme(row) {
  return {
    id: row.scheme_id,
    source: row.source,
    sourceId: row.source_id || null,
    name: row.name || row.scheme_id,
    description: row.description || "",
    isDefault: Boolean(toNumber(row.is_default)),
    projectCount: toNumber(row.project_count, 0),
    measured: fromTri(row.measured),
    fieldCount: row.field_count == null ? null : toNumber(row.field_count),
    requiredCount: toNumber(row.required_count, 0),
    restrictedCount: toNumber(row.restricted_count, 0),
    codes: safeParseJson(row.finding_codes, []),
    duplicateOf: row.duplicate_of || null,
  };
}

function mapConfig(row) {
  return {
    id: row.config_id,
    sourceId: row.source_id || null,
    name: row.name || row.config_id,
    description: row.description || "",
    isDefault: Boolean(toNumber(row.is_default)),
    used: Boolean(toNumber(row.used)),
    itemsRead: Boolean(toNumber(row.items_read)),
    totalFieldCount: row.total_field_count == null ? null : toNumber(row.total_field_count),
    notableCount: toNumber(row.notable_count, 0),
    requiredCount: toNumber(row.required_count, 0),
    hiddenCount: toNumber(row.hidden_count, 0),
    requiredHidden: safeParseJson(row.required_hidden, []),
    codes: safeParseJson(row.finding_codes, []),
    duplicateOf: row.duplicate_of || null,
  };
}

// Schemes and configurations are tens to low hundreds of rows: loaded whole.
export async function loadFieldConfigSchemes(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT scheme_id, source, source_id, name, description, is_default, project_count, measured,
             field_count, required_count, restricted_count, finding_codes, duplicate_of
      FROM snapshot_fieldcfg_schemes
      WHERE scope_key = ? AND version = ?
      ORDER BY is_default DESC, name ASC
    `,
      )
      .bindParams(scopeKey, version)
      .execute(),
  );
  return (result.rows || []).map(mapScheme);
}

export async function loadFieldConfigConfigs(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT config_id, source_id, name, description, is_default, used, items_read, total_field_count,
             notable_count, required_count, hidden_count, required_hidden, finding_codes, duplicate_of
      FROM snapshot_fieldcfg_configs
      WHERE scope_key = ? AND version = ?
      ORDER BY is_default DESC, name ASC
    `,
      )
      .bindParams(scopeKey, version)
      .execute(),
  );
  return (result.rows || []).map(mapConfig);
}

export async function loadFieldConfigMappings(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT scheme_id, work_type_id, config_id
      FROM snapshot_fieldcfg_mappings
      WHERE scope_key = ? AND version = ?
    `,
      )
      .bindParams(scopeKey, version)
      .execute(),
  );
  return (result.rows || []).map((row) => ({
    schemeId: row.scheme_id,
    workTypeId: row.work_type_id,
    configId: row.config_id,
  }));
}

// Every scheme -> project pair. Bounded by the project count.
export async function loadFieldConfigSchemeProjects(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT scheme_id, project_id, project_key, project_name
      FROM snapshot_fieldcfg_scheme_projects
      WHERE scope_key = ? AND version = ?
      ORDER BY project_key ASC
    `,
      )
      .bindParams(scopeKey, version)
      .execute(),
  );
  return (result.rows || []).map((row) => ({
    schemeId: row.scheme_id,
    projectId: row.project_id,
    projectKey: row.project_key,
    projectName: row.project_name,
  }));
}

function mapItem(row) {
  return {
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    workTypeId: row.work_type_id,
    fieldId: row.field_id,
    associated: fromTri(row.associated),
    hidden: fromTri(row.hidden),
    required: fromTri(row.required),
    description: row.description || null,
    renderer: row.renderer || null,
    restrictedTo: safeParseJson(row.restricted_to, []),
  };
}

// Every item for one field, across every scheme or configuration: the field card's question.
export async function loadFieldConfigItemsForField(scopeKey, version, fieldId) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT owner_kind, owner_id, work_type_id, field_id, associated, hidden, required, description, renderer, restricted_to
      FROM snapshot_fieldcfg_items
      WHERE scope_key = ? AND version = ? AND field_id = ?
      ORDER BY owner_id ASC, work_type_id ASC
      LIMIT 2000
    `,
      )
      .bindParams(scopeKey, version, String(fieldId))
      .execute(),
  );
  return (result.rows || []).map(mapItem);
}

// One scheme's or configuration's items, paged, for the tab's detail view.
export async function loadFieldConfigItemsForOwner(
  scopeKey,
  version,
  ownerKind,
  ownerId,
  { offset = 0, limit = 200, requiredOnly = false } = {},
) {
  await ensureProjectStoreReady();
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 200));
  const safeOffset = Math.max(0, Math.trunc(Number(offset)) || 0);
  const where =
    "scope_key = ? AND version = ? AND owner_kind = ? AND owner_id = ?" + (requiredOnly ? " AND required = 1" : "");
  const params = [scopeKey, version, String(ownerKind), String(ownerId)];
  const [rows, count] = await Promise.all([
    withSqlRetry(() =>
      sql
        .prepare(
          `
        SELECT owner_kind, owner_id, work_type_id, field_id, associated, hidden, required, description, renderer, restricted_to
        FROM snapshot_fieldcfg_items
        WHERE ${where}
        ORDER BY field_id ASC, work_type_id ASC
        LIMIT ${safeLimit} OFFSET ${safeOffset}
      `,
        )
        .bindParams(...params)
        .execute(),
    ),
    withSqlRetry(() =>
      sql
        .prepare(`SELECT COUNT(*) AS n FROM snapshot_fieldcfg_items WHERE ${where}`)
        .bindParams(...params)
        .execute(),
    ),
  ]);
  return { total: toNumber(count.rows?.[0]?.n, 0), items: (rows.rows || []).map(mapItem) };
}

export async function readFieldConfigSnapshotMeta(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT state, version, started_at, completed_at, refreshed_at, source, fallback_reason,
             total_schemes, total_configs, unread_owners, summary_json, inconsistent_json, last_error
      FROM fieldconfig_snapshot_meta WHERE scope_key = ?
    `,
      )
      .bindParams(scopeKey)
      .execute(),
  );
  const row = result.rows?.[0];
  if (!row) return null;
  return {
    state: row.state || "idle",
    version: row.version || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    refreshedAt: row.refreshed_at || null,
    source: row.source || null,
    fallbackReason: row.fallback_reason || null,
    totalSchemes: toNumber(row.total_schemes, 0),
    totalConfigs: toNumber(row.total_configs, 0),
    unreadOwners: toNumber(row.unread_owners, 0),
    summary: safeParseJson(row.summary_json, null),
    inconsistentRequired: safeParseJson(row.inconsistent_json, []),
    lastError: row.last_error || null,
  };
}

export async function writeFieldConfigSnapshotMeta(scopeKey, patch = {}) {
  await ensureProjectStoreReady();
  const current = (await readFieldConfigSnapshotMeta(scopeKey)) || {};
  const next = { ...current, ...patch };
  await withSqlRetry(() =>
    sql
      .prepare(
        `
      INSERT INTO fieldconfig_snapshot_meta
        (scope_key, state, version, started_at, completed_at, refreshed_at, source, fallback_reason,
         total_schemes, total_configs, unread_owners, summary_json, inconsistent_json, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        state = VALUES(state),
        version = VALUES(version),
        started_at = VALUES(started_at),
        completed_at = VALUES(completed_at),
        refreshed_at = VALUES(refreshed_at),
        source = VALUES(source),
        fallback_reason = VALUES(fallback_reason),
        total_schemes = VALUES(total_schemes),
        total_configs = VALUES(total_configs),
        unread_owners = VALUES(unread_owners),
        summary_json = VALUES(summary_json),
        inconsistent_json = VALUES(inconsistent_json),
        last_error = VALUES(last_error)
    `,
      )
      .bindParams(
        scopeKey,
        next.state || "idle",
        next.version || null,
        next.startedAt || null,
        next.completedAt || null,
        next.refreshedAt || null,
        next.source || null,
        next.fallbackReason ? String(next.fallbackReason).slice(0, 500) : null,
        next.totalSchemes ?? 0,
        next.totalConfigs ?? 0,
        next.unreadOwners ?? 0,
        next.summary ? JSON.stringify(next.summary) : null,
        next.inconsistentRequired ? JSON.stringify(next.inconsistentRequired) : null,
        next.lastError || null,
      )
      .execute(),
  );
}
