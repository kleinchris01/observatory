// Screens, tabs, screen fields, and the two scheme layers above them.
//
// Split out like store/workflow.js; imports only from core.js, so there is one arrow and
// no cycle to reason about.
//
// The write path is a full replace per scope, matching replaceWorkflowSnapshot. Screens are
// a site-wide catalog with no resume path: the live measurement (CONNECT-4137) put a full
// pass at ~1,528 calls and ~4.9 minutes against a 900s consumer, so the build completes
// inside one invocation and never needs to append to a partial version.

import { sql } from "@forge/sql";
import {
  chunkArray,
  ensureProjectStoreReady,
  safeParseJson,
  toNumber,
  withSqlRetry,
} from "./core.js";

// Field rows dominate this snapshot -- ~22,000 on the reference site against ~760 screens
// and tens of schemes -- so they get their own smaller batch. Every row carries 7 bind
// params, and Forge SQL has a bind-parameter ceiling that a 50-row batch would approach.
const FIELD_BATCH_SIZE = 40;
const DEFAULT_BATCH_SIZE = 50;

export async function replaceScreenSnapshot(scopeKey, version, {
  screens = [],
  tabs = [],
  fields = [],
  screenSchemes = [],
  schemeOperations = [],
  issueTypeScreenSchemes = [],
  itssMappings = [],
  itssProjects = [],
} = {}) {
  await ensureProjectStoreReady();

  // Scoped deletes, every one of them. An unscoped DELETE in a multi-tenant Forge app
  // destroys another customer's data, and project-store.writes.test.js asserts this
  // mechanically rather than trusting review to catch it.
  for (const table of [
    "snapshot_screens",
    "snapshot_screen_tabs",
    "snapshot_screen_fields",
    "snapshot_screen_schemes",
    "snapshot_screen_scheme_operations",
    "snapshot_issue_type_screen_schemes",
    "snapshot_itss_mappings",
    "snapshot_itss_projects",
  ]) {
    await withSqlRetry(() =>
      sql.prepare(`DELETE FROM ${table} WHERE scope_key = ?`).bindParams(scopeKey).execute()
    );
  }

  for (const batch of chunkArray(screens, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((s) => [
      scopeKey, version, String(s.id), s.name || null, s.description || null,
      s.tabCount ?? 0, s.fieldCount ?? 0,
      s.tabsResolved || "resolved", s.unresolvedReason || null,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_screens
          (scope_key, version, screen_id, name, description, tab_count, field_count, tabs_resolved, unresolved_reason)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(tabs, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((t) => [
      scopeKey, version, String(t.screenId), String(t.tabId),
      t.name || null, t.tabIndex ?? 0, t.fieldCount ?? 0,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_screen_tabs
          (scope_key, version, screen_id, tab_id, name, tab_index, field_count)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(fields, FIELD_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((f) => [
      scopeKey, version, String(f.screenId), String(f.tabId), String(f.fieldId),
      f.fieldName || null, f.tabIndex ?? 0, f.fieldIndex ?? 0,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_screen_fields
          (scope_key, version, screen_id, tab_id, field_id, field_name, tab_index, field_index)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(screenSchemes, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((s) => [
      scopeKey, version, String(s.id), s.name || null, s.description || null,
      JSON.stringify(s.screens || null),
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_screen_schemes
          (scope_key, version, scheme_id, name, description, screens_json)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(schemeOperations, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((op) => [
      scopeKey, version, String(op.schemeId), op.operation,
      op.screenId == null ? null : String(op.screenId),
      op.inherited ? 1 : 0, op.dangling ? 1 : 0,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_screen_scheme_operations
          (scope_key, version, scheme_id, operation, screen_id, inherited, dangling)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(issueTypeScreenSchemes, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((s) => [
      scopeKey, version, String(s.id), s.name || null, s.description || null, s.projectCount ?? 0,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_issue_type_screen_schemes
          (scope_key, version, itss_id, name, description, project_count)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(itssMappings, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((m) => [
      scopeKey, version, String(m.itssId), String(m.issueTypeId),
      m.screenSchemeId == null ? null : String(m.screenSchemeId),
      m.isDefault ? 1 : 0,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_itss_mappings
          (scope_key, version, itss_id, issue_type_id, screen_scheme_id, is_default)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(itssProjects, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((p) => [
      scopeKey, version, String(p.itssId), String(p.projectId),
      p.projectKey || null, p.projectName || null,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_itss_projects
          (scope_key, version, itss_id, project_id, project_key, project_name)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function loadScreensPage(scopeKey, version, { limit = 50, offset = 0, search = "" } = {}) {
  await ensureProjectStoreReady();

  const safeLimit = Math.max(1, Math.min(200, Math.trunc(Number(limit)) || 50));
  const safeOffset = Math.max(0, Math.trunc(Number(offset)) || 0);

  const where = ["scope_key = ?", "version = ?"];
  const params = [scopeKey, version];
  const term = String(search || "").trim();
  if (term) {
    where.push("(name LIKE ? OR screen_id LIKE ?)");
    params.push(`%${term}%`, `%${term}%`);
  }

  const countResult = await withSqlRetry(() =>
    sql.prepare(`SELECT COUNT(*) AS total FROM snapshot_screens WHERE ${where.join(" AND ")}`)
      .bindParams(...params).execute()
  );

  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT screen_id, name, description, tab_count, field_count, tabs_resolved, unresolved_reason
      FROM snapshot_screens
      WHERE ${where.join(" AND ")}
      ORDER BY field_count DESC, name ASC
      LIMIT ${safeLimit} OFFSET ${safeOffset}
    `).bindParams(...params).execute()
  );

  return {
    total: toNumber(countResult.rows?.[0]?.total, 0),
    rows: (result.rows || []).map(mapScreenRow),
  };
}

function mapScreenRow(row) {
  return {
    screenId: row.screen_id,
    name: row.name || row.screen_id,
    description: row.description || "",
    tabCount: toNumber(row.tab_count),
    fieldCount: toNumber(row.field_count),
    // Never collapsed to a boolean. "resolved", "unresolved" and the reason behind the
    // second are three different facts, and a finding built on the wrong one is worse
    // than no finding.
    tabsResolved: row.tabs_resolved || "resolved",
    unresolvedReason: row.unresolved_reason || null,
  };
}

export async function loadScreenFields(scopeKey, version, screenId) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT tab_id, field_id, field_name, tab_index, field_index
      FROM snapshot_screen_fields
      WHERE scope_key = ? AND version = ? AND screen_id = ?
      ORDER BY tab_index ASC, field_index ASC
    `).bindParams(scopeKey, version, String(screenId)).execute()
  );
  return (result.rows || []).map((row) => ({
    tabId: row.tab_id,
    fieldId: row.field_id,
    fieldName: row.field_name || row.field_id,
    tabIndex: toNumber(row.tab_index),
    fieldIndex: toNumber(row.field_index),
  }));
}

// Which screens carry one field. The reverse direction of the same table, and the read the
// field detail panel needs -- served by idx_snapshot_screen_fields_field rather than a scan.
export async function loadScreensForField(scopeKey, version, fieldId) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT f.screen_id, f.tab_id, f.tab_index, f.field_index, s.name AS screen_name
      FROM snapshot_screen_fields f
      LEFT JOIN snapshot_screens s
        ON s.scope_key = f.scope_key AND s.version = f.version AND s.screen_id = f.screen_id
      WHERE f.scope_key = ? AND f.version = ? AND f.field_id = ?
      ORDER BY s.name ASC
    `).bindParams(scopeKey, version, String(fieldId)).execute()
  );
  return (result.rows || []).map((row) => ({
    screenId: row.screen_id,
    screenName: row.screen_name || row.screen_id,
    tabId: row.tab_id,
    tabIndex: toNumber(row.tab_index),
    fieldIndex: toNumber(row.field_index),
  }));
}

export async function loadScreenSchemes(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT scheme_id, name, description, screens_json
      FROM snapshot_screen_schemes
      WHERE scope_key = ? AND version = ?
      ORDER BY name ASC
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    schemeId: row.scheme_id,
    name: row.name || row.scheme_id,
    description: row.description || "",
    screens: safeParseJson(row.screens_json, null),
  }));
}

export async function loadScreenSchemeOperations(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT scheme_id, operation, screen_id, inherited, dangling
      FROM snapshot_screen_scheme_operations
      WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    schemeId: row.scheme_id,
    operation: row.operation,
    screenId: row.screen_id,
    inherited: Boolean(toNumber(row.inherited)),
    dangling: Boolean(toNumber(row.dangling)),
  }));
}

export async function loadIssueTypeScreenSchemes(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT itss_id, name, description, project_count
      FROM snapshot_issue_type_screen_schemes
      WHERE scope_key = ? AND version = ?
      ORDER BY project_count DESC, name ASC
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    itssId: row.itss_id,
    name: row.name || row.itss_id,
    description: row.description || "",
    projectCount: toNumber(row.project_count),
  }));
}

export async function loadItssMappings(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT itss_id, issue_type_id, screen_scheme_id, is_default
      FROM snapshot_itss_mappings
      WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    itssId: row.itss_id,
    issueTypeId: row.issue_type_id,
    screenSchemeId: row.screen_scheme_id,
    isDefault: Boolean(toNumber(row.is_default)),
  }));
}

export async function loadItssProjects(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT itss_id, project_id, project_key, project_name
      FROM snapshot_itss_projects
      WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    itssId: row.itss_id,
    projectId: row.project_id,
    projectKey: row.project_key || "",
    projectName: row.project_name || "",
  }));
}

// ── Meta ─────────────────────────────────────────────────────────────────────

export async function readScreenSnapshotMeta(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT state, version, started_at, completed_at, refreshed_at,
             total_screens, total_schemes, unresolved_screens, last_error
      FROM screen_snapshot_meta WHERE scope_key = ?
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
    totalScreens: toNumber(row.total_screens),
    totalSchemes: toNumber(row.total_schemes),
    unresolvedScreens: toNumber(row.unresolved_screens),
    lastError: row.last_error || null,
  };
}

// Merge-patch over the current row, like writeWorkflowSnapshotMeta: callers patch the two
// or three fields they own and never have to restate the rest.
export async function writeScreenSnapshotMeta(scopeKey, patch = {}) {
  await ensureProjectStoreReady();
  const current = (await readScreenSnapshotMeta(scopeKey)) || {};
  const next = { ...current, ...patch };

  await withSqlRetry(() =>
    sql.prepare(`
      INSERT INTO screen_snapshot_meta
        (scope_key, state, version, started_at, completed_at, refreshed_at,
         total_screens, total_schemes, unresolved_screens, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        state = VALUES(state),
        version = VALUES(version),
        started_at = VALUES(started_at),
        completed_at = VALUES(completed_at),
        refreshed_at = VALUES(refreshed_at),
        total_screens = VALUES(total_screens),
        total_schemes = VALUES(total_schemes),
        unresolved_screens = VALUES(unresolved_screens),
        last_error = VALUES(last_error)
    `).bindParams(
      scopeKey,
      next.state || "idle",
      next.version || null,
      next.startedAt || null,
      next.completedAt || null,
      next.refreshedAt || null,
      next.totalScreens ?? 0,
      next.totalSchemes ?? 0,
      next.unresolvedScreens ?? 0,
      next.lastError || null
    ).execute()
  );
}
