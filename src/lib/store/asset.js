// The JSM Assets (CMDB) pillar: object schemas, their hierarchical object types, and those
// types' attributes -- structure only, versioned.
//
// Same shape as store/issuetype.js: imports only from core.js so there is one arrow and no
// cycle, and the write path is a full replace per scope. A site has 1-30 schemas, low
// hundreds of object types and low thousands of attributes, so the build completes inside
// one invocation and never appends to a partial version.

import { sql } from "@forge/sql";
import {
  chunkArray,
  ensureProjectStoreReady,
  toNumber,
  withSqlRetry,
} from "./core.js";

const DEFAULT_BATCH_SIZE = 50;

export async function replaceAssetSnapshot(scopeKey, version, {
  schemas = [],
  objectTypes = [],
  attributes = [],
} = {}) {
  await ensureProjectStoreReady();

  for (const table of [
    "snapshot_asset_schemas",
    "snapshot_asset_object_types",
    "snapshot_asset_attributes",
  ]) {
    await withSqlRetry(() =>
      sql.prepare(`DELETE FROM ${table} WHERE scope_key = ?`).bindParams(scopeKey).execute()
    );
  }

  for (const batch of chunkArray(schemas, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((s) => [
      scopeKey, version, String(s.id), s.name || null, s.schemaKey || null,
      s.description || null, Number(s.objectTypeCount) || 0, Number(s.objectCount) || 0,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_asset_schemas
          (scope_key, version, schema_id, name, schema_key, description, object_type_count, object_count)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(objectTypes, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((t) => [
      scopeKey, version, String(t.id), String(t.schemaId), t.name || null, t.description || null,
      t.parentId == null ? null : String(t.parentId),
      t.inherited ? 1 : 0,
      t.abstract ? 1 : 0,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_asset_object_types
          (scope_key, version, object_type_id, schema_id, name, description, parent_id, inherited, is_abstract)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(attributes, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((a) => [
      scopeKey, version, String(a.id),
      a.objectTypeId == null ? null : String(a.objectTypeId),
      String(a.schemaId), a.name || null, a.dataType || null,
      a.referenceObjectTypeId == null ? null : String(a.referenceObjectTypeId),
      a.system ? 1 : 0,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_asset_attributes
          (scope_key, version, attribute_id, object_type_id, schema_id, name, data_type, reference_object_type_id, is_system)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function loadAssetSchemas(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT schema_id, name, schema_key, description, object_type_count, object_count
      FROM snapshot_asset_schemas
      WHERE scope_key = ? AND version = ?
      ORDER BY object_count DESC, name ASC
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    id: row.schema_id,
    name: row.name || row.schema_id,
    schemaKey: row.schema_key || "",
    description: row.description || "",
    objectTypeCount: toNumber(row.object_type_count),
    objectCount: toNumber(row.object_count),
  }));
}

export async function loadAssetObjectTypes(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT object_type_id, schema_id, name, description, parent_id, inherited, is_abstract
      FROM snapshot_asset_object_types
      WHERE scope_key = ? AND version = ?
      ORDER BY schema_id ASC, name ASC
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    id: row.object_type_id,
    schemaId: row.schema_id,
    name: row.name || row.object_type_id,
    description: row.description || "",
    parentId: row.parent_id || null,
    inherited: Boolean(toNumber(row.inherited)),
    abstract: Boolean(toNumber(row.is_abstract)),
  }));
}

export async function loadAssetAttributes(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT attribute_id, object_type_id, schema_id, name, data_type, reference_object_type_id, is_system
      FROM snapshot_asset_attributes
      WHERE scope_key = ? AND version = ?
      ORDER BY object_type_id ASC, name ASC
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    id: row.attribute_id,
    objectTypeId: row.object_type_id || null,
    schemaId: row.schema_id,
    name: row.name || row.attribute_id,
    dataType: row.data_type || "unknown",
    referenceObjectTypeId: row.reference_object_type_id || null,
    system: Boolean(toNumber(row.is_system)),
  }));
}

// Aggregates for the pillar overview and the health score, in SQL rather than by loading
// the catalogue.
export async function loadAssetGovernanceSummary(scopeKey, version) {
  await ensureProjectStoreReady();

  const schemas = await withSqlRetry(() =>
    sql.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN object_type_count = 0 OR object_count = 0 THEN 1 ELSE 0 END) AS dead
      FROM snapshot_asset_schemas
      WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()
  );

  const types = await withSqlRetry(() =>
    sql.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN is_abstract = 1 THEN 1 ELSE 0 END) AS abstract_types,
        SUM(CASE
          WHEN parent_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM snapshot_asset_object_types p
            WHERE p.scope_key = t.scope_key AND p.version = t.version AND p.object_type_id = t.parent_id
          ) THEN 1 ELSE 0 END) AS orphan_types
      FROM snapshot_asset_object_types t
      WHERE t.scope_key = ? AND t.version = ?
    `).bindParams(scopeKey, version).execute()
  );

  const attrs = await withSqlRetry(() =>
    sql.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN reference_object_type_id IS NOT NULL THEN 1 ELSE 0 END) AS reference_attrs,
        SUM(CASE
          WHEN reference_object_type_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM snapshot_asset_object_types o
            WHERE o.scope_key = a.scope_key AND o.version = a.version AND o.object_type_id = a.reference_object_type_id
          ) THEN 1 ELSE 0 END) AS broken_reference_attrs,
        SUM(CASE
          WHEN object_type_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM snapshot_asset_object_types o
            WHERE o.scope_key = a.scope_key AND o.version = a.version AND o.object_type_id = a.object_type_id
          ) THEN 1 ELSE 0 END) AS orphan_attrs
      FROM snapshot_asset_attributes a
      WHERE a.scope_key = ? AND a.version = ?
    `).bindParams(scopeKey, version).execute()
  );

  const schemaRow = schemas.rows?.[0] || {};
  const typeRow = types.rows?.[0] || {};
  const attrRow = attrs.rows?.[0] || {};

  return {
    totalSchemas: toNumber(schemaRow.total),
    deadSchemas: toNumber(schemaRow.dead),
    totalObjectTypes: toNumber(typeRow.total),
    abstractObjectTypes: toNumber(typeRow.abstract_types),
    orphanObjectTypes: toNumber(typeRow.orphan_types),
    totalAttributes: toNumber(attrRow.total),
    referenceAttributes: toNumber(attrRow.reference_attrs),
    brokenReferenceAttributes: toNumber(attrRow.broken_reference_attrs),
    orphanAttributes: toNumber(attrRow.orphan_attrs),
  };
}

// ── Meta ─────────────────────────────────────────────────────────────────────

export async function readAssetSnapshotMeta(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT state, version, started_at, completed_at, refreshed_at, workspace_id,
             assets_enabled, total_schemas, total_object_types, total_attributes, last_error
      FROM asset_snapshot_meta WHERE scope_key = ?
    `).bindParams(scopeKey).execute()
  );
  const row = result.rows?.[0];
  if (!row) return null;
  return {
    state: row.state || "idle",
    version: row.version || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    refreshedAt: row.refreshed_at || null,
    workspaceId: row.workspace_id || null,
    assetsEnabled: Boolean(toNumber(row.assets_enabled)),
    totalSchemas: toNumber(row.total_schemas),
    totalObjectTypes: toNumber(row.total_object_types),
    totalAttributes: toNumber(row.total_attributes),
    lastError: row.last_error || null,
  };
}

export async function writeAssetSnapshotMeta(scopeKey, patch = {}) {
  await ensureProjectStoreReady();
  const current = (await readAssetSnapshotMeta(scopeKey)) || {};
  const next = { ...current, ...patch };

  await withSqlRetry(() =>
    sql.prepare(`
      INSERT INTO asset_snapshot_meta
        (scope_key, state, version, started_at, completed_at, refreshed_at, workspace_id,
         assets_enabled, total_schemas, total_object_types, total_attributes, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        state = VALUES(state),
        version = VALUES(version),
        started_at = VALUES(started_at),
        completed_at = VALUES(completed_at),
        refreshed_at = VALUES(refreshed_at),
        workspace_id = VALUES(workspace_id),
        assets_enabled = VALUES(assets_enabled),
        total_schemas = VALUES(total_schemas),
        total_object_types = VALUES(total_object_types),
        total_attributes = VALUES(total_attributes),
        last_error = VALUES(last_error)
    `).bindParams(
      scopeKey,
      next.state || "idle",
      next.version || null,
      next.startedAt || null,
      next.completedAt || null,
      next.refreshedAt || null,
      next.workspaceId || null,
      next.assetsEnabled ? 1 : 0,
      next.totalSchemas ?? 0,
      next.totalObjectTypes ?? 0,
      next.totalAttributes ?? 0,
      next.lastError || null
    ).execute()
  );
}
