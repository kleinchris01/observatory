// Workflow schemes, the status catalog, and per-status usage counts.
//
// Split out of project-store.js; imports only from core.js.

import { sql } from "@forge/sql";
import {
  chunkArray,
  ensureProjectStoreReady,
  safeParseJson,
  toNumber,
  withSqlRetry,
} from "./core.js";

// Full replace, mirroring replaceSnapshotFields: delete this scope's rows, then
// insert the fresh set. Workflow schemes/statuses are small site-wide catalogs
// (no resume/append path needed, unlike the custom-field snapshot).
export async function replaceWorkflowSnapshot(scopeKey, version, { schemes = [], schemeProjects = [], statuses = [], schemeStatuses = [] }) {
  await ensureProjectStoreReady();

  await withSqlRetry(() => sql.prepare("DELETE FROM snapshot_workflow_schemes WHERE scope_key = ?").bindParams(scopeKey).execute());
  await withSqlRetry(() => sql.prepare("DELETE FROM snapshot_workflow_scheme_projects WHERE scope_key = ?").bindParams(scopeKey).execute());
  await withSqlRetry(() => sql.prepare("DELETE FROM snapshot_statuses WHERE scope_key = ?").bindParams(scopeKey).execute());
  await withSqlRetry(() => sql.prepare("DELETE FROM snapshot_workflow_statuses WHERE scope_key = ?").bindParams(scopeKey).execute());

  for (const batch of chunkArray(schemes, 50)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((scheme) => [
      scopeKey, version, scheme.id, scheme.name, scheme.description || null,
      scheme.defaultWorkflow || null, JSON.stringify(scheme.issueTypeMapping || null),
      scheme.projectCount ?? 0, JSON.stringify(scheme.findings || null),
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_workflow_schemes
          (scope_key, version, scheme_id, name, description, default_workflow, issue_type_mapping_json, project_count, findings_json)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(schemeProjects, 50)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((row) => [
      scopeKey, version, row.schemeId, row.projectId, row.projectKey, row.projectName,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_workflow_scheme_projects
          (scope_key, version, scheme_id, project_id, project_key, project_name)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(statuses, 50)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((status) => [
      scopeKey, version, status.id, status.name, status.statusCategory || null,
      JSON.stringify(status.findings || null),
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_statuses (scope_key, version, status_id, name, status_category, findings_json)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(schemeStatuses, 150)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((row) => [scopeKey, version, row.schemeId, row.statusId]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_workflow_statuses (scope_key, version, scheme_id, status_id)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }
}

// Every scheme -> status pair for one snapshot version. Small enough to load whole: it is
// bounded by schemes x statuses-per-scheme, and the insight functions need the full set to
// tell a referenced status from an orphaned one.

// Every scheme -> status pair for one snapshot version. Small enough to load whole: it is
// bounded by schemes x statuses-per-scheme, and the insight functions need the full set to
// tell a referenced status from an orphaned one.
export async function loadWorkflowSchemeStatuses(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT scheme_id, status_id
      FROM snapshot_workflow_statuses
      WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({ schemeId: row.scheme_id, statusId: row.status_id }));
}

// status_id -> total issues across every project, from the last completed universe scan.
// Returns an empty map when no scan has run; callers must treat that as "unknown" rather
// than "zero", because zero is a claim that a status is safe to delete.

// status_id -> total issues across every project, from the last completed universe scan.
// Returns an empty map when no scan has run; callers must treat that as "unknown" rather
// than "zero", because zero is a claim that a status is safe to delete.
export async function loadStatusIssueCounts(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT status_id, SUM(issue_count) AS total
      FROM issue_scan_status_totals
      WHERE scope_key = ?
      GROUP BY status_id
    `).bindParams(scopeKey).execute()
  );
  const counts = new Map();
  for (const row of result.rows || []) {
    if (row?.status_id) counts.set(String(row.status_id), toNumber(row.total));
  }
  return counts;
}

// status_id -> issues that have ever been in it. Empty map means "never measured", which
// callers must not render as zero.

// status_id -> issues that have ever been in it. Empty map means "never measured", which
// callers must not render as zero.
export async function loadStatusHistoryCounts(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT status_id, ever_count, measured_at
      FROM status_history_totals
      WHERE scope_key = ?
    `).bindParams(scopeKey).execute()
  );
  const counts = new Map();
  let measuredAt = null;
  for (const row of result.rows || []) {
    if (!row?.status_id) continue;
    counts.set(String(row.status_id), toNumber(row.ever_count));
    if (row.measured_at && (!measuredAt || row.measured_at > measuredAt)) measuredAt = row.measured_at;
  }
  return { counts, measuredAt };
}

// Upsert rather than replace: a run where some statuses timed out must not delete the
// counts it did not re-measure.

// Upsert rather than replace: a run where some statuses timed out must not delete the
// counts it did not re-measure.
export async function upsertStatusHistoryCounts(scopeKey, counts, measuredAt) {
  await ensureProjectStoreReady();
  const rows = [...counts.entries()].filter(([statusId]) => statusId);
  if (!rows.length) return;

  for (const batch of chunkArray(rows, 100)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?)").join(", ");
    const params = batch.flatMap(([statusId, count]) => [scopeKey, String(statusId), Number(count) || 0, measuredAt]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO status_history_totals (scope_key, status_id, ever_count, measured_at)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE ever_count = VALUES(ever_count), measured_at = VALUES(measured_at)
      `).bindParams(...params).execute()
    );
  }
}

export async function clearStatusIssueCounts(scopeKey) {
  await ensureProjectStoreReady();
  await withSqlRetry(() =>
    sql.prepare("DELETE FROM issue_scan_status_totals WHERE scope_key = ?").bindParams(scopeKey).execute()
  );
}

// Accumulate per-status counts from a worker chunk.
//
// ON DUPLICATE KEY UPDATE rather than INSERT: workers run in parallel over disjoint
// project sets, but a single status is reached from many projects and each worker flushes
// several times per run, so rows are additive across both dimensions.

// Accumulate per-status counts from a worker chunk.
//
// ON DUPLICATE KEY UPDATE rather than INSERT: workers run in parallel over disjoint
// project sets, but a single status is reached from many projects and each worker flushes
// several times per run, so rows are additive across both dimensions.
export async function flushIssueScanStatusCounts(scopeKey, statusCounts) {
  // statusCounts: Map<`statusId|projectId`, { statusId, statusName, statusCategory, projectId, projectKey, count }>
  await ensureProjectStoreReady();
  const rows = [...statusCounts.values()].filter((row) => row?.statusId && row?.projectId);
  if (!rows.length) return;

  for (const batch of chunkArray(rows, 100)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((row) => [
      scopeKey, row.statusId, row.projectId, row.statusName || null,
      row.statusCategory || null, row.projectKey || null, row.count,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO issue_scan_status_totals
          (scope_key, status_id, project_id, status_name, status_category, project_key, issue_count)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE issue_count = issue_count + VALUES(issue_count)
      `).bindParams(...params).execute()
    );
  }
}

export async function loadWorkflowSchemes(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT scheme_id, name, description, default_workflow, issue_type_mapping_json, project_count, findings_json
      FROM snapshot_workflow_schemes
      WHERE scope_key = ? AND version = ?
      ORDER BY name ASC
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    id: row.scheme_id,
    name: row.name,
    description: row.description || "",
    defaultWorkflow: row.default_workflow || null,
    issueTypeMapping: safeParseJson(row.issue_type_mapping_json, null),
    projectCount: toNumber(row.project_count),
    findings: safeParseJson(row.findings_json, null),
  }));
}

export async function loadWorkflowSchemeProjects(scopeKey, version, schemeId) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT project_id, project_key, project_name
      FROM snapshot_workflow_scheme_projects
      WHERE scope_key = ? AND version = ? AND scheme_id = ?
      ORDER BY project_name ASC
    `).bindParams(scopeKey, version, schemeId).execute()
  );
  return (result.rows || []).map((row) => ({
    projectId: row.project_id,
    projectKey: row.project_key,
    projectName: row.project_name,
  }));
}

// Reverse lookup for the Projects tab (Phase 4): which scheme does this project use.

// Reverse lookup for the Projects tab (Phase 4): which scheme does this project use.
export async function loadWorkflowSchemeForProject(scopeKey, version, projectId) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT wsp.scheme_id, ws.name, ws.description
      FROM snapshot_workflow_scheme_projects wsp
      JOIN snapshot_workflow_schemes ws
        ON ws.scope_key = wsp.scope_key AND ws.version = wsp.version AND ws.scheme_id = wsp.scheme_id
      WHERE wsp.scope_key = ? AND wsp.version = ? AND wsp.project_id = ?
      LIMIT 1
    `).bindParams(scopeKey, version, projectId).execute()
  );
  const row = result.rows?.[0];
  if (!row) return null;
  return { schemeId: row.scheme_id, name: row.name, description: row.description || "" };
}

// project_id -> { schemeId, name } for every project in one query.
//
// The per-project loadWorkflowSchemeForProject above is right for a single lookup, but
// reports enrich every project in the result set -- on a 140-project site that would be
// 140 round trips, against the one Forge quota this app actually pushes against. One
// join returns the whole mapping instead.

// project_id -> { schemeId, name } for every project in one query.
//
// The per-project loadWorkflowSchemeForProject above is right for a single lookup, but
// reports enrich every project in the result set -- on a 140-project site that would be
// 140 round trips, against the one Forge quota this app actually pushes against. One
// join returns the whole mapping instead.
export async function loadProjectWorkflowSchemeMap(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT wsp.project_id, wsp.scheme_id, ws.name
      FROM snapshot_workflow_scheme_projects wsp
      JOIN snapshot_workflow_schemes ws
        ON ws.scope_key = wsp.scope_key AND ws.version = wsp.version AND ws.scheme_id = wsp.scheme_id
      WHERE wsp.scope_key = ? AND wsp.version = ?
    `).bindParams(scopeKey, version).execute()
  );
  const map = new Map();
  for (const row of result.rows || []) {
    if (row?.project_id) {
      map.set(String(row.project_id), { schemeId: row.scheme_id, name: row.name });
    }
  }
  return map;
}

export async function loadStatusesCatalog(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT status_id, name, status_category, findings_json
      FROM snapshot_statuses
      WHERE scope_key = ? AND version = ?
      ORDER BY name ASC
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    id: row.status_id,
    name: row.name,
    statusCategory: row.status_category || null,
    findings: safeParseJson(row.findings_json, null),
  }));
}

export async function readWorkflowSnapshotMeta(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT state, version, started_at, completed_at, refreshed_at, total_schemes, last_error
      FROM workflow_snapshot_meta
      WHERE scope_key = ?
      LIMIT 1
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
    totalSchemes: toNumber(row.total_schemes),
    lastError: row.last_error || null,
  };
}

export async function writeWorkflowSnapshotMeta(scopeKey, patch) {
  await ensureProjectStoreReady();
  const current = await readWorkflowSnapshotMeta(scopeKey);
  const next = {
    state: "idle",
    version: null,
    startedAt: null,
    completedAt: null,
    refreshedAt: null,
    totalSchemes: 0,
    lastError: null,
    ...(current || {}),
    ...patch,
  };

  await withSqlRetry(() =>
    sql.prepare(`
      INSERT INTO workflow_snapshot_meta (scope_key, state, version, started_at, completed_at, refreshed_at, total_schemes, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        state = VALUES(state),
        version = VALUES(version),
        started_at = VALUES(started_at),
        completed_at = VALUES(completed_at),
        refreshed_at = VALUES(refreshed_at),
        total_schemes = VALUES(total_schemes),
        last_error = VALUES(last_error)
    `).bindParams(scopeKey, next.state, next.version, next.startedAt, next.completedAt, next.refreshedAt, next.totalSchemes, next.lastError).execute()
  );

  return next;
}
