// Usage per item: three numbers for every field, status, issue type, priority, resolution,
// security level, person and project -- how many issues, how many in the last 90 days, and
// when last -- counted by the issue crawl over data it already reads.
//
// Lifecycle, the same buffer-and-promote shape as the other crawl counters:
//   1. cleared when a crawl starts (clearIssueScanBuffer, store/scan.js)
//   2. flushUsageBuffer from every worker drain -- additive, per project
//   3. cleared per project when a slice restarts (clearIssueScanBufferForProjects), so its
//      pages are not counted twice
//   4. promoteUsageTally at finalization, and only when every worker finished: a partial
//      crawl must not replace the last good figures
// Imports only from core.js: one arrow, no cycle.

import { sql } from "@forge/sql";
import { chunkArray, ensureProjectStoreReady, toNumber, withSqlRetry } from "./core.js";

export const USAGE_WINDOW_DAYS = 90;

// The pillars the crawl counts, and what each one's numbers are counted on. `basis` names the
// issue date behind `recent` and `last_at`; the UI labels the three numbers from it, so a
// count and its label can never disagree.
export const USAGE_PILLARS = {
  field: { basis: "updated" },
  status: { basis: "updated" },
  issuetype: { basis: "created" },
  priority: { basis: "created" },
  resolution: { basis: "resolved" },
  securitylevel: { basis: "updated" },
  user: { basis: "updated" },
  project: { basis: "created" },
};

const BATCH = 100;

// buffer: Map<key, { pillar, entityId, projectId, projectKey, total, recent, lastAt }>
export async function flushUsageBuffer(scopeKey, buffer) {
  await ensureProjectStoreReady();
  const rows = [...buffer.values()].filter((r) => r?.pillar && r?.entityId && r?.projectId);
  if (!rows.length) return;
  for (const batch of chunkArray(rows, BATCH)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((r) => [
      scopeKey, r.pillar, String(r.entityId), String(r.projectId), r.projectKey || null,
      r.total || 0, r.recent || 0, r.lastAt || null,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO issue_scan_usage_buffer
          (scope_key, pillar, entity_id, project_id, project_key, total, recent, last_at)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE
          total = total + VALUES(total),
          recent = recent + VALUES(recent),
          last_at = CASE
            WHEN last_at IS NULL THEN VALUES(last_at)
            WHEN VALUES(last_at) IS NULL THEN last_at
            ELSE GREATEST(last_at, VALUES(last_at))
          END
      `).bindParams(...params).execute()
    );
  }
}

// Folds the buffer into usage_tally. Rows are upserted with the new measured_at first and the
// stale ones removed after, so a promote that dies partway leaves the old figures readable
// rather than an empty table. Gated by the caller on full crawl coverage.
export async function promoteUsageTally(scopeKey, { coverageComplete = false, now = new Date() } = {}) {
  await ensureProjectStoreReady();
  if (!coverageComplete) return { promoted: false, entities: 0 };

  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT pillar, entity_id,
             SUM(total) AS total, SUM(recent) AS recent, MAX(last_at) AS last_at,
             SUM(CASE WHEN total > 0 THEN 1 ELSE 0 END) AS project_count
      FROM issue_scan_usage_buffer
      WHERE scope_key = ?
      GROUP BY pillar, entity_id
    `).bindParams(scopeKey).execute()
  );
  const rows = result.rows || [];
  const measuredAt = now.toISOString();

  for (const batch of chunkArray(rows, BATCH)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((r) => [
      scopeKey, r.pillar, r.entity_id, toNumber(r.total), toNumber(r.recent), r.last_at || null,
      toNumber(r.project_count), measuredAt,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO usage_tally
          (scope_key, pillar, entity_id, total, recent, last_at, project_count, measured_at)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE
          total = VALUES(total), recent = VALUES(recent), last_at = VALUES(last_at),
          project_count = VALUES(project_count), measured_at = VALUES(measured_at)
      `).bindParams(...params).execute()
    );
  }

  // Anything this crawl never saw is gone from the site (or from every issue), so its old
  // figures go too. Safe only because coverage was complete.
  await withSqlRetry(() =>
    sql.prepare("DELETE FROM usage_tally WHERE scope_key = ? AND measured_at <> ?")
      .bindParams(scopeKey, measuredAt).execute()
  );
  await withSqlRetry(() =>
    sql.prepare(`
      INSERT INTO usage_tally_meta (scope_key, measured_at, window_days) VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE measured_at = VALUES(measured_at), window_days = VALUES(window_days)
    `).bindParams(scopeKey, measuredAt, USAGE_WINDOW_DAYS).execute()
  );
  return { promoted: true, entities: rows.length, measuredAt };
}

export async function readUsageMeta(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare("SELECT measured_at, window_days FROM usage_tally_meta WHERE scope_key = ?")
      .bindParams(scopeKey).execute()
  );
  const row = result.rows?.[0];
  return row ? { measuredAt: row.measured_at, windowDays: toNumber(row.window_days) } : null;
}

// Every item of one pillar: Map<entityId, { total, recent, lastAt, projectCount }>.
export async function loadUsageTally(scopeKey, pillar) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT entity_id, total, recent, last_at, project_count
      FROM usage_tally WHERE scope_key = ? AND pillar = ?
    `).bindParams(scopeKey, String(pillar)).execute()
  );
  return new Map((result.rows || []).map((r) => [
    String(r.entity_id),
    { total: toNumber(r.total), recent: toNumber(r.recent), lastAt: r.last_at || null, projectCount: toNumber(r.project_count) },
  ]));
}
