// The issue type pillar: the type catalog, the schemes that gate which types a project may
// use, their ordered membership and their project assignments.
//
// Sits one tier above store/screen.js's issue-type -> screen layer
// (snapshot_issue_type_screen_schemes). Same shape as that module: imports only from
// core.js so there is one arrow and no cycle, and the write path is a full replace per
// scope matching replaceScreenSnapshot. The scheme layers are tens of rows and the type
// catalog low hundreds, so the build completes inside one invocation and never appends to
// a partial version.

import { sql } from "@forge/sql";
import {
  chunkArray,
  ensureProjectStoreReady,
  toNumber,
  withSqlRetry,
} from "./core.js";

const DEFAULT_BATCH_SIZE = 50;

export async function replaceIssueTypeSnapshot(scopeKey, version, {
  issueTypes = [],
  schemes = [],
  schemeItems = [],
  schemeProjects = [],
} = {}) {
  await ensureProjectStoreReady();

  // Scoped deletes, every one of them. An unscoped DELETE in a multi-tenant Forge app
  // destroys another customer's data, and project-store.writes.test.js asserts this
  // mechanically rather than trusting review to catch it.
  for (const table of [
    "snapshot_issue_types",
    "snapshot_issue_type_schemes",
    "snapshot_issue_type_scheme_items",
    "snapshot_issue_type_scheme_projects",
  ]) {
    await withSqlRetry(() =>
      sql.prepare(`DELETE FROM ${table} WHERE scope_key = ?`).bindParams(scopeKey).execute()
    );
  }

  for (const batch of chunkArray(issueTypes, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((t) => [
      scopeKey, version, String(t.id), t.name || null, t.description || null,
      t.subtask ? 1 : 0, Number.isFinite(Number(t.hierarchyLevel)) ? Number(t.hierarchyLevel) : 0,
      t.scopeProjectId == null ? null : String(t.scopeProjectId),
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_issue_types
          (scope_key, version, issue_type_id, name, description, subtask, hierarchy_level, scope_project_id)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(schemes, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((s) => [
      scopeKey, version, String(s.id), s.name || null, s.description || null,
      s.defaultIssueTypeId == null ? null : String(s.defaultIssueTypeId),
      s.isDefault ? 1 : 0, s.projectCount ?? 0,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_issue_type_schemes
          (scope_key, version, scheme_id, name, description, default_issue_type_id, is_default, project_count)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(schemeItems, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((it) => [
      scopeKey, version, String(it.schemeId), String(it.issueTypeId), it.itemIndex ?? 0,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_issue_type_scheme_items
          (scope_key, version, scheme_id, issue_type_id, item_index)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(schemeProjects, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((p) => [
      scopeKey, version, String(p.schemeId), String(p.projectId),
      p.projectKey || null, p.projectName || null,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_issue_type_scheme_projects
          (scope_key, version, scheme_id, project_id, project_key, project_name)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function loadIssueTypes(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT issue_type_id, name, description, subtask, hierarchy_level, scope_project_id
      FROM snapshot_issue_types
      WHERE scope_key = ? AND version = ?
      ORDER BY hierarchy_level DESC, name ASC, issue_type_id ASC
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    id: row.issue_type_id,
    name: row.name || row.issue_type_id,
    description: row.description || "",
    subtask: Boolean(toNumber(row.subtask)),
    hierarchyLevel: toNumber(row.hierarchy_level),
    // NULL means global (usable by classic projects); a value means the type belongs to one
    // team-managed project and nothing else can use it. Two opposite facts, kept apart.
    scopeProjectId: row.scope_project_id || null,
  }));
}

export async function loadIssueTypeSchemes(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT scheme_id, name, description, default_issue_type_id, is_default, project_count
      FROM snapshot_issue_type_schemes
      WHERE scope_key = ? AND version = ?
      ORDER BY project_count DESC, name ASC
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    schemeId: row.scheme_id,
    name: row.name || row.scheme_id,
    description: row.description || "",
    defaultIssueTypeId: row.default_issue_type_id || null,
    isDefault: Boolean(toNumber(row.is_default)),
    projectCount: toNumber(row.project_count),
  }));
}

// Ordered membership. Returned as a flat list carrying item_index rather than pre-grouped:
// the resolver joins it against the type catalog and groups it there, and a flat list is
// one query where a per-scheme fetch would be dozens.
export async function loadIssueTypeSchemeItems(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT scheme_id, issue_type_id, item_index
      FROM snapshot_issue_type_scheme_items
      WHERE scope_key = ? AND version = ?
      ORDER BY scheme_id ASC, item_index ASC
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    schemeId: row.scheme_id,
    issueTypeId: row.issue_type_id,
    itemIndex: toNumber(row.item_index),
  }));
}

export async function loadIssueTypeSchemeProjects(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT scheme_id, project_id, project_key, project_name
      FROM snapshot_issue_type_scheme_projects
      WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    schemeId: row.scheme_id,
    projectId: row.project_id,
    projectKey: row.project_key || "",
    projectName: row.project_name || "",
  }));
}

// Which issue type scheme governs one project, and the types it allows -- the project-view
// read. One query down the same chain the screen pillar walks for screens.
export async function loadIssueTypeSchemeForProject(scopeKey, version, projectId) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT s.scheme_id, s.name, s.description, s.default_issue_type_id, s.is_default,
             t.issue_type_id, t.name AS type_name, t.subtask, t.hierarchy_level, i.item_index
      FROM snapshot_issue_type_scheme_projects p
      JOIN snapshot_issue_type_schemes s
        ON s.scope_key = p.scope_key AND s.version = p.version AND s.scheme_id = p.scheme_id
      LEFT JOIN snapshot_issue_type_scheme_items i
        ON i.scope_key = p.scope_key AND i.version = p.version AND i.scheme_id = p.scheme_id
      LEFT JOIN snapshot_issue_types t
        ON t.scope_key = p.scope_key AND t.version = p.version AND t.issue_type_id = i.issue_type_id
      WHERE p.scope_key = ? AND p.version = ? AND p.project_id = ?
      ORDER BY i.item_index ASC
    `).bindParams(scopeKey, version, String(projectId)).execute()
  );
  const rows = result.rows || [];
  if (!rows.length) return null;

  const first = rows[0];
  return {
    schemeId: first.scheme_id,
    name: first.name || first.scheme_id,
    description: first.description || "",
    defaultIssueTypeId: first.default_issue_type_id || null,
    isDefault: Boolean(toNumber(first.is_default)),
    issueTypes: rows
      .filter((r) => r.issue_type_id != null)
      .map((r) => ({
        id: r.issue_type_id,
        name: r.type_name || r.issue_type_id,
        subtask: Boolean(toNumber(r.subtask)),
        hierarchyLevel: toNumber(r.hierarchy_level),
        itemIndex: toNumber(r.item_index),
      })),
  };
}

// Aggregates for the pillar overview, computed in SQL rather than by loading the catalog.
export async function loadIssueTypeGovernanceSummary(scopeKey, version) {
  await ensureProjectStoreReady();

  const types = await withSqlRetry(() =>
    sql.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN subtask = 1 THEN 1 ELSE 0 END) AS subtasks,
        SUM(CASE WHEN scope_project_id IS NOT NULL THEN 1 ELSE 0 END) AS project_scoped,
        COUNT(DISTINCT hierarchy_level) AS hierarchy_levels
      FROM snapshot_issue_types
      WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()
  );

  // A scheme no project is assigned to allows types nowhere -- the "unused scheme" finding.
  const schemes = await withSqlRetry(() =>
    sql.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN project_count = 0 THEN 1 ELSE 0 END) AS unused
      FROM snapshot_issue_type_schemes
      WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()
  );

  // Types on no scheme at all: present in the catalog, allowed by nothing, so no project can
  // ever create one. Sub-tasks are excluded only when the site has no sub-task-bearing
  // scheme -- otherwise a legitimately-unused sub-task type reads the same as a real orphan.
  const orphanTypes = await withSqlRetry(() =>
    sql.prepare(`
      SELECT COUNT(*) AS orphan
      FROM snapshot_issue_types t
      WHERE t.scope_key = ? AND t.version = ?
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_issue_type_scheme_items i
          WHERE i.scope_key = t.scope_key AND i.version = t.version AND i.issue_type_id = t.issue_type_id
        )
    `).bindParams(scopeKey, version).execute()
  );

  const typeRow = types.rows?.[0] || {};
  const schemeRow = schemes.rows?.[0] || {};

  return {
    totalTypes: toNumber(typeRow.total),
    subtaskTypes: toNumber(typeRow.subtasks),
    projectScopedTypes: toNumber(typeRow.project_scoped),
    hierarchyLevels: toNumber(typeRow.hierarchy_levels),
    totalSchemes: toNumber(schemeRow.total),
    unusedSchemes: toNumber(schemeRow.unused),
    orphanTypes: toNumber(orphanTypes.rows?.[0]?.orphan),
  };
}

// ── Meta ─────────────────────────────────────────────────────────────────────

export async function readIssueTypeSnapshotMeta(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT state, version, started_at, completed_at, refreshed_at,
             total_types, total_schemes, last_error
      FROM issue_type_snapshot_meta WHERE scope_key = ?
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
    totalTypes: toNumber(row.total_types),
    totalSchemes: toNumber(row.total_schemes),
    lastError: row.last_error || null,
  };
}

// Merge-patch over the current row, like writeScreenSnapshotMeta: callers patch the fields
// they own and never have to restate the rest.
export async function writeIssueTypeSnapshotMeta(scopeKey, patch = {}) {
  await ensureProjectStoreReady();
  const current = (await readIssueTypeSnapshotMeta(scopeKey)) || {};
  const next = { ...current, ...patch };

  await withSqlRetry(() =>
    sql.prepare(`
      INSERT INTO issue_type_snapshot_meta
        (scope_key, state, version, started_at, completed_at, refreshed_at,
         total_types, total_schemes, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        state = VALUES(state),
        version = VALUES(version),
        started_at = VALUES(started_at),
        completed_at = VALUES(completed_at),
        refreshed_at = VALUES(refreshed_at),
        total_types = VALUES(total_types),
        total_schemes = VALUES(total_schemes),
        last_error = VALUES(last_error)
    `).bindParams(
      scopeKey,
      next.state || "idle",
      next.version || null,
      next.startedAt || null,
      next.completedAt || null,
      next.refreshedAt || null,
      next.totalTypes ?? 0,
      next.totalSchemes ?? 0,
      next.lastError || null
    ).execute()
  );
}
