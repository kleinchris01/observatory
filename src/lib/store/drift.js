// Configuration drift: the entity-digest state and the append-only change log.
//
// Imports only from core.js -- one arrow, no cycle. Two write paths:
//   replaceEntityDigests(pillar, rows)  full-replace the digest state for one pillar
//   appendConfigChanges(rows)           append detected changes to the timeline
// and the reads the Changes tab / resolver need.

import { sql } from "@forge/sql";
import {
  chunkArray,
  ensureProjectStoreReady,
  safeParseJson,
  toNumber,
  withSqlRetry,
} from "./core.js";

const BATCH = 50;

// ── Entity digests: the state the next drift pass diffs against ───────────────

export async function loadEntityDigests(scopeKey, pillar) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT entity_type, entity_id, label, digest, fields_json
      FROM snapshot_entity_digest
      WHERE scope_key = ? AND pillar = ?
    `).bindParams(scopeKey, String(pillar)).execute()
  );
  return (result.rows || []).map((row) => ({
    entityType: row.entity_type,
    entityId: row.entity_id,
    label: row.label || null,
    digest: row.digest,
    fields: safeParseJson(row.fields_json, null),
  }));
}

// Full replace for one pillar: delete every digest row for (scope, pillar), then insert the
// current set. A pillar with no entities this pass ends up with zero rows, which is correct
// -- it means the inventory came back empty, and the diff that produced this call already
// recorded the removals.
export async function replaceEntityDigests(scopeKey, pillar, entities = []) {
  await ensureProjectStoreReady();

  await withSqlRetry(() =>
    sql.prepare(`DELETE FROM snapshot_entity_digest WHERE scope_key = ? AND pillar = ?`)
      .bindParams(scopeKey, String(pillar)).execute()
  );

  for (const b of chunkArray(entities, BATCH)) {
    const valuesSql = b.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = b.flatMap((e) => [
      scopeKey, String(pillar), String(e.entityType), String(e.entityId),
      e.label == null ? null : String(e.label).slice(0, 255), String(e.digest),
      e.fields == null ? null : JSON.stringify(e.fields),
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_entity_digest (scope_key, pillar, entity_type, entity_id, label, digest, fields_json)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE label = VALUES(label), digest = VALUES(digest), fields_json = VALUES(fields_json)
      `).bindParams(...params).execute()
    );
  }
}

// ── Change log: the append-only timeline ─────────────────────────────────────

export async function appendConfigChanges(scopeKey, rows = []) {
  if (!rows.length) return;
  await ensureProjectStoreReady();

  for (const b of chunkArray(rows, BATCH)) {
    const valuesSql = b.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = b.flatMap((r) => [
      scopeKey, String(r.changeId), String(r.detectedAt), r.scanVersion == null ? null : String(r.scanVersion),
      String(r.pillar), String(r.entityType), String(r.entityId),
      r.label == null ? null : String(r.label).slice(0, 255),
      String(r.changeKind), r.summary == null ? null : String(r.summary).slice(0, 1024),
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO config_change_log
          (scope_key, change_id, detected_at, scan_version, pillar, entity_type, entity_id, label, change_kind, summary)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE summary = VALUES(summary)
      `).bindParams(...params).execute()
    );
  }
}

// One page of the timeline, newest first. `pillar` / `kind` / `since` are optional filters;
// `before` is the keyset cursor (a detected_at value from the previous page's last row).
export async function loadConfigChanges(scopeKey, {
  pillar = null, kind = null, since = null, before = null, limit = 100,
} = {}) {
  await ensureProjectStoreReady();
  const clauses = ["scope_key = ?"];
  const params = [scopeKey];
  if (pillar) { clauses.push("pillar = ?"); params.push(String(pillar)); }
  if (kind) { clauses.push("change_kind = ?"); params.push(String(kind)); }
  if (since) { clauses.push("detected_at >= ?"); params.push(String(since)); }
  if (before) { clauses.push("detected_at < ?"); params.push(String(before)); }
  const capped = Math.max(1, Math.min(500, Number(limit) || 100));

  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT change_id, detected_at, scan_version, pillar, entity_type, entity_id, label, change_kind, summary
      FROM config_change_log
      WHERE ${clauses.join(" AND ")}
      ORDER BY detected_at DESC, change_id DESC
      LIMIT ${capped}
    `).bindParams(...params).execute()
  );
  return (result.rows || []).map((row) => ({
    changeId: row.change_id,
    detectedAt: row.detected_at,
    scanVersion: row.scan_version || null,
    pillar: row.pillar,
    entityType: row.entity_type,
    entityId: row.entity_id,
    label: row.label || null,
    changeKind: row.change_kind,
    summary: row.summary || null,
  }));
}

// Counts by pillar and by kind over a trailing window -- the Changes tab's headline, and
// the input to the (future) drift signal in the score.
export async function loadConfigChangeSummary(scopeKey, sinceIso) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT pillar, change_kind, COUNT(*) AS n
      FROM config_change_log
      WHERE scope_key = ? AND detected_at >= ?
      GROUP BY pillar, change_kind
    `).bindParams(scopeKey, String(sinceIso)).execute()
  );
  const byPillar = {};
  const byKind = { added: 0, removed: 0, modified: 0 };
  let total = 0;
  for (const row of result.rows || []) {
    const n = toNumber(row.n);
    total += n;
    byKind[row.change_kind] = (byKind[row.change_kind] || 0) + n;
    byPillar[row.pillar] = (byPillar[row.pillar] || 0) + n;
  }
  return { total, byPillar, byKind };
}

export async function pruneOldConfigChanges(scopeKey, olderThanMs = 400 * 24 * 60 * 60 * 1000) {
  await ensureProjectStoreReady();
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const result = await withSqlRetry(() =>
    sql.prepare(`DELETE FROM config_change_log WHERE scope_key = ? AND detected_at < ?`)
      .bindParams(scopeKey, cutoff).execute()
  );
  return { changesDeleted: toNumber(result?.rowsAffected, 0) };
}

// ── Meta ─────────────────────────────────────────────────────────────────────

export async function readDriftSnapshotMeta(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT state, version, started_at, completed_at, refreshed_at,
             last_run_changes, total_changes, seeded_pillars, last_error
      FROM drift_snapshot_meta WHERE scope_key = ?
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
    lastRunChanges: toNumber(row.last_run_changes),
    totalChanges: toNumber(row.total_changes),
    seededPillars: row.seeded_pillars ? String(row.seeded_pillars).split(",").filter(Boolean) : [],
    lastError: row.last_error || null,
  };
}

export async function writeDriftSnapshotMeta(scopeKey, patch = {}) {
  await ensureProjectStoreReady();
  const current = (await readDriftSnapshotMeta(scopeKey)) || {};
  const next = { ...current, ...patch };

  await withSqlRetry(() =>
    sql.prepare(`
      INSERT INTO drift_snapshot_meta
        (scope_key, state, version, started_at, completed_at, refreshed_at,
         last_run_changes, total_changes, seeded_pillars, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        state = VALUES(state),
        version = VALUES(version),
        started_at = VALUES(started_at),
        completed_at = VALUES(completed_at),
        refreshed_at = VALUES(refreshed_at),
        last_run_changes = VALUES(last_run_changes),
        total_changes = VALUES(total_changes),
        seeded_pillars = VALUES(seeded_pillars),
        last_error = VALUES(last_error)
    `).bindParams(
      scopeKey,
      next.state || "idle",
      next.version || null,
      next.startedAt || null,
      next.completedAt || null,
      next.refreshedAt || null,
      next.lastRunChanges ?? 0,
      next.totalChanges ?? 0,
      Array.isArray(next.seededPillars) ? next.seededPillars.join(",") : (next.seededPillars || null),
      next.lastError || null
    ).execute()
  );
}
