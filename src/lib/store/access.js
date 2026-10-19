// The access pillar: permission schemes, issue-security schemes and notification schemes,
// their holders, and their project assignments -- one shape, one set of tables.
//
// Imports only from core.js so there is one arrow and no cycle. Full replace per scope, and
// every version is fresh, so nothing here collides with a row already on disk.
//
// All four writes carry ON DUPLICATE KEY UPDATE anyway. Most of the store deliberately does
// not -- a duplicate there means the engine emitted the same entity twice, which is a bug
// worth failing on. This pillar is the exception because its four tables are filled from
// SEVEN Jira endpoints (three paginated scheme lists, security levels and their members,
// the site role catalog, and per-project role actors) and merged into one shape. A repeated
// row is a quirk of somebody else's pagination, not a defect here, and losing the whole
// access pillar to one is the worse trade. Holders and scheme-projects always had it; the
// other two did not, for no reason anyone recorded.

import { sql } from "@forge/sql";
import { chunkArray, deleteScopeInChunks, ensureProjectStoreReady, toNumber, withSqlRetry } from "./core.js";

const BATCH = 50;

export async function replaceAccessSnapshot(
  scopeKey,
  version,
  { schemes = [], holders = [], levels = [], schemeProjects = [] } = {},
) {
  await ensureProjectStoreReady();

  // Was a single unbounded `DELETE FROM table WHERE scope_key = ?` -- with no version pruning
  // anywhere else in this pillar, that statement was wiping EVERY historical version's rows in
  // one shot, and grew large enough in production to exceed TiDB's per-query memory quota
  // (error 8175). Scoping to "AND version <> ?" keeps only the version being written (matching
  // the pruning convention already used by dashboard.js/filter.js/snapshot.js), and
  // deleteScopeInChunks bounds each individual DELETE regardless of how large the existing
  // backlog is.
  for (const table of [
    "snapshot_schemes",
    "snapshot_scheme_holders",
    "snapshot_scheme_levels",
    "snapshot_scheme_projects",
  ]) {
    await deleteScopeInChunks(table, scopeKey, {
      extraWhereSql: " AND version <> ?",
      extraParams: [version],
    });
  }

  for (const b of chunkArray(schemes, BATCH)) {
    const valuesSql = b.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = b.flatMap((s) => [
      scopeKey,
      version,
      String(s.schemeType),
      String(s.id),
      s.name || null,
      s.description || null,
      s.isDefault ? 1 : 0,
      s.defaultLevelId == null ? null : String(s.defaultLevelId),
    ]);
    await withSqlRetry(() =>
      sql
        .prepare(
          `
        INSERT INTO snapshot_schemes
          (scope_key, version, scheme_type, scheme_id, name, description, is_default, default_level_id)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description)
      `,
        )
        .bindParams(...params)
        .execute(),
    );
  }

  for (const b of chunkArray(holders, BATCH)) {
    const valuesSql = b.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = b.flatMap((h) => [
      scopeKey,
      version,
      String(h.schemeType),
      String(h.schemeId),
      String(h.context ?? ""),
      h.contextLabel || null,
      String(h.holderType),
      String(h.holderValue ?? ""),
      h.holderLabel || null,
    ]);
    await withSqlRetry(() =>
      sql
        .prepare(
          `
        INSERT INTO snapshot_scheme_holders
          (scope_key, version, scheme_type, scheme_id, context, context_label, holder_type, holder_value, holder_label)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE context_label = VALUES(context_label), holder_label = VALUES(holder_label)
      `,
        )
        .bindParams(...params)
        .execute(),
    );
  }

  for (const b of chunkArray(levels, BATCH)) {
    const valuesSql = b.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = b.flatMap((l) => [
      scopeKey,
      version,
      String(l.schemeId),
      String(l.id),
      l.name || null,
      l.description || null,
      l.isDefault ? 1 : 0,
    ]);
    await withSqlRetry(() =>
      sql
        .prepare(
          `
        INSERT INTO snapshot_scheme_levels
          (scope_key, version, scheme_id, level_id, name, description, is_default)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description)
      `,
        )
        .bindParams(...params)
        .execute(),
    );
  }

  for (const b of chunkArray(schemeProjects, BATCH)) {
    const valuesSql = b.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = b.flatMap((p) => [
      scopeKey,
      version,
      String(p.schemeType),
      String(p.schemeId),
      String(p.projectId),
      p.projectKey || null,
      p.projectName || null,
    ]);
    await withSqlRetry(() =>
      sql
        .prepare(
          `
        INSERT INTO snapshot_scheme_projects
          (scope_key, version, scheme_type, scheme_id, project_id, project_key, project_name)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE project_key = VALUES(project_key), project_name = VALUES(project_name)
      `,
        )
        .bindParams(...params)
        .execute(),
    );
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function loadSchemes(scopeKey, version, schemeType) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT scheme_id, name, description, is_default, default_level_id
      FROM snapshot_schemes
      WHERE scope_key = ? AND version = ? AND scheme_type = ?
      ORDER BY name ASC, scheme_id ASC
    `,
      )
      .bindParams(scopeKey, version, String(schemeType))
      .execute(),
  );
  return (result.rows || []).map((row) => ({
    id: row.scheme_id,
    name: row.name || row.scheme_id,
    description: row.description || "",
    isDefault: Boolean(toNumber(row.is_default)),
    defaultLevelId: row.default_level_id || null,
  }));
}

export async function loadSchemeHolders(scopeKey, version, schemeType) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT scheme_id, context, context_label, holder_type, holder_value, holder_label
      FROM snapshot_scheme_holders
      WHERE scope_key = ? AND version = ? AND scheme_type = ?
    `,
      )
      .bindParams(scopeKey, version, String(schemeType))
      .execute(),
  );
  return (result.rows || []).map((row) => ({
    schemeId: row.scheme_id,
    context: row.context,
    contextLabel: row.context_label || row.context,
    holderType: row.holder_type,
    holderValue: row.holder_value || "",
    holderLabel: row.holder_label || null,
  }));
}

export async function loadSchemeLevels(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT scheme_id, level_id, name, description, is_default
      FROM snapshot_scheme_levels
      WHERE scope_key = ? AND version = ?
      ORDER BY scheme_id ASC, name ASC
    `,
      )
      .bindParams(scopeKey, version)
      .execute(),
  );
  return (result.rows || []).map((row) => ({
    schemeId: row.scheme_id,
    id: row.level_id,
    name: row.name || row.level_id,
    description: row.description || "",
    isDefault: Boolean(toNumber(row.is_default)),
  }));
}

export async function loadSchemeProjects(scopeKey, version, schemeType) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT scheme_id, project_id, project_key, project_name
      FROM snapshot_scheme_projects
      WHERE scope_key = ? AND version = ? AND scheme_type = ?
    `,
      )
      .bindParams(scopeKey, version, String(schemeType))
      .execute(),
  );
  return (result.rows || []).map((row) => ({
    schemeId: row.scheme_id,
    projectId: row.project_id,
    projectKey: row.project_key || "",
    projectName: row.project_name || "",
  }));
}

// Cross-pillar (People): every scheme that names one account / group / role directly, with
// the permission or level or event it grants. Used by getUserDetails.
export async function loadSchemesGrantingHolder(scopeKey, version, holderType, holderValue) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT h.scheme_type, h.scheme_id, s.name AS scheme_name, h.context, h.context_label
      FROM snapshot_scheme_holders h
      LEFT JOIN snapshot_schemes s
        ON s.scope_key = h.scope_key AND s.version = h.version
       AND s.scheme_type = h.scheme_type AND s.scheme_id = h.scheme_id
      WHERE h.scope_key = ? AND h.version = ? AND h.holder_type = ? AND h.holder_value = ?
    `,
      )
      .bindParams(scopeKey, version, String(holderType), String(holderValue))
      .execute(),
  );
  return (result.rows || []).map((row) => ({
    schemeType: row.scheme_type,
    schemeId: row.scheme_id,
    schemeName: row.scheme_name || row.scheme_id,
    context: row.context,
    contextLabel: row.context_label || row.context,
  }));
}

// Cross-pillar (Projects): the project-role actors for one project, grouped by role. An
// "empty" holder_type row means the role exists on the project with nobody in it.
export async function loadProjectRoleActors(scopeKey, version, projectId) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT h.scheme_id, s.name AS role_name, h.holder_type, h.holder_value, h.holder_label
      FROM snapshot_scheme_holders h
      LEFT JOIN snapshot_schemes s
        ON s.scope_key = h.scope_key AND s.version = h.version
       AND s.scheme_type = h.scheme_type AND s.scheme_id = h.scheme_id
      WHERE h.scope_key = ? AND h.version = ? AND h.scheme_type = 'project-role' AND h.context = ?
      ORDER BY s.name ASC
    `,
      )
      .bindParams(scopeKey, version, String(projectId))
      .execute(),
  );
  return (result.rows || []).map((row) => ({
    roleId: row.scheme_id,
    roleName: row.role_name || row.scheme_id,
    holderType: row.holder_type,
    holderValue: row.holder_value || "",
    holderLabel: row.holder_label || null,
  }));
}

// Cross-pillar (Projects): the three schemes one project uses, with a "default scheme" flag.
export async function loadProjectSchemes(scopeKey, version, projectId) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT p.scheme_type, p.scheme_id, s.name AS scheme_name, s.is_default, s.default_level_id
      FROM snapshot_scheme_projects p
      LEFT JOIN snapshot_schemes s
        ON s.scope_key = p.scope_key AND s.version = p.version
       AND s.scheme_type = p.scheme_type AND s.scheme_id = p.scheme_id
      WHERE p.scope_key = ? AND p.version = ? AND p.project_id = ?
    `,
      )
      .bindParams(scopeKey, version, String(projectId))
      .execute(),
  );
  return (result.rows || []).map((row) => ({
    schemeType: row.scheme_type,
    schemeId: row.scheme_id,
    schemeName: row.scheme_name || row.scheme_id,
    isDefault: Boolean(toNumber(row.is_default)),
    defaultLevelId: row.default_level_id || null,
  }));
}

// ── Meta ─────────────────────────────────────────────────────────────────────

export async function readAccessSnapshotMeta(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT state, version, started_at, completed_at, refreshed_at,
             total_permission_schemes, total_security_schemes, total_notification_schemes,
             total_project_roles, last_error
      FROM access_snapshot_meta WHERE scope_key = ?
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
    totalPermissionSchemes: toNumber(row.total_permission_schemes),
    totalSecuritySchemes: toNumber(row.total_security_schemes),
    totalNotificationSchemes: toNumber(row.total_notification_schemes),
    totalProjectRoles: toNumber(row.total_project_roles),
    lastError: row.last_error || null,
  };
}

export async function writeAccessSnapshotMeta(scopeKey, patch = {}) {
  await ensureProjectStoreReady();
  const current = (await readAccessSnapshotMeta(scopeKey)) || {};
  const next = { ...current, ...patch };

  await withSqlRetry(() =>
    sql
      .prepare(
        `
      INSERT INTO access_snapshot_meta
        (scope_key, state, version, started_at, completed_at, refreshed_at,
         total_permission_schemes, total_security_schemes, total_notification_schemes,
         total_project_roles, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        state = VALUES(state),
        version = VALUES(version),
        started_at = VALUES(started_at),
        completed_at = VALUES(completed_at),
        refreshed_at = VALUES(refreshed_at),
        total_permission_schemes = VALUES(total_permission_schemes),
        total_security_schemes = VALUES(total_security_schemes),
        total_notification_schemes = VALUES(total_notification_schemes),
        total_project_roles = VALUES(total_project_roles),
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
        next.totalPermissionSchemes ?? 0,
        next.totalSecuritySchemes ?? 0,
        next.totalNotificationSchemes ?? 0,
        next.totalProjectRoles ?? 0,
        next.lastError || null,
      )
      .execute(),
  );
}
