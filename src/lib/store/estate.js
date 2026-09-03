// Storage for the estate-config pillar: the global value lists (resolutions, priorities),
// versioned. One table, `kind` discriminated. Imports only from core.js -- one arrow, no
// cycle. Full replace per scope: a site has tens of these, so the build finishes in one
// invocation and never appends to a partial version.

import { sql } from "@forge/sql";
import {
  chunkArray,
  ensureProjectStoreReady,
  toNumber,
  withSqlRetry,
} from "./core.js";

const BATCH = 50;

export async function replaceEstateSnapshot(scopeKey, version, { resolutions = [], priorities = [] } = {}) {
  await ensureProjectStoreReady();

  await withSqlRetry(() =>
    sql.prepare(`DELETE FROM snapshot_estate_values WHERE scope_key = ?`).bindParams(scopeKey).execute()
  );

  const rows = [
    ...resolutions.map((r, i) => ({ kind: "resolution", ...r, sortOrder: r.sortOrder ?? i })),
    ...priorities.map((p, i) => ({ kind: "priority", ...p, sortOrder: p.sortOrder ?? i })),
  ];

  for (const b of chunkArray(rows, BATCH)) {
    const valuesSql = b.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = b.flatMap((r) => [
      scopeKey, version, String(r.kind), String(r.id),
      r.name || null, r.description || null, r.isDefault ? 1 : 0, Number(r.sortOrder) || 0,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_estate_values
          (scope_key, version, kind, item_id, name, description, is_default, sort_order)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description),
          is_default = VALUES(is_default), sort_order = VALUES(sort_order)
      `).bindParams(...params).execute()
    );
  }
}

export async function loadEstateValues(scopeKey, version, kind) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT kind, item_id, name, description, is_default, sort_order
      FROM snapshot_estate_values
      WHERE scope_key = ? AND version = ? AND kind = ?
      ORDER BY sort_order ASC, name ASC
    `).bindParams(scopeKey, version, String(kind)).execute()
  );
  return (result.rows || []).map((row) => ({
    id: row.item_id,
    name: row.name || row.item_id,
    description: row.description || "",
    isDefault: Boolean(toNumber(row.is_default)),
    sortOrder: toNumber(row.sort_order),
  }));
}

export async function readEstateSnapshotMeta(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT state, version, started_at, completed_at, refreshed_at,
             total_resolutions, total_priorities, last_error
      FROM estate_snapshot_meta WHERE scope_key = ?
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
    totalResolutions: toNumber(row.total_resolutions),
    totalPriorities: toNumber(row.total_priorities),
    lastError: row.last_error || null,
  };
}

export async function writeEstateSnapshotMeta(scopeKey, patch = {}) {
  await ensureProjectStoreReady();
  const current = (await readEstateSnapshotMeta(scopeKey)) || {};
  const next = { ...current, ...patch };

  await withSqlRetry(() =>
    sql.prepare(`
      INSERT INTO estate_snapshot_meta
        (scope_key, state, version, started_at, completed_at, refreshed_at,
         total_resolutions, total_priorities, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        state = VALUES(state),
        version = VALUES(version),
        started_at = VALUES(started_at),
        completed_at = VALUES(completed_at),
        refreshed_at = VALUES(refreshed_at),
        total_resolutions = VALUES(total_resolutions),
        total_priorities = VALUES(total_priorities),
        last_error = VALUES(last_error)
    `).bindParams(
      scopeKey,
      next.state || "idle",
      next.version || null,
      next.startedAt || null,
      next.completedAt || null,
      next.refreshedAt || null,
      next.totalResolutions ?? 0,
      next.totalPriorities ?? 0,
      next.lastError || null
    ).execute()
  );
}
