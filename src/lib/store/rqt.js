// The RQT value index built during a universe scan.
//
// Split out of project-store.js; imports only from core.js.

import { sql } from "@forge/sql";
import { ensureProjectStoreReady, safeParseJson, toNumber, withSqlRetry } from "./core.js";

export async function clearRqtFieldIndex(scopeKey) {
  await ensureProjectStoreReady();
  await withSqlRetry(() =>
    sql.prepare("DELETE FROM rqt_field_index WHERE scope_key = ?").bindParams(scopeKey).execute(),
  );
}

// hits: Map<fieldId, { fieldName: string, count: number, values: Set<string> }>
// Merges into existing rows — accumulates across worker flushes.

// hits: Map<fieldId, { fieldName: string, count: number, values: Set<string> }>
// Merges into existing rows — accumulates across worker flushes.
export async function upsertRqtFieldHits(scopeKey, hits) {
  await ensureProjectStoreReady();
  if (!hits.size) return;

  const MAX_SAMPLE_VALUES = 200;
  const now = new Date().toISOString();

  for (const [fieldId, { fieldName, count, values }] of hits) {
    // Load existing sample values so we can merge without duplicates
    const existing = await withSqlRetry(() =>
      sql
        .prepare(
          "SELECT sample_values_json, unique_value_count FROM rqt_field_index WHERE scope_key = ? AND field_id = ? LIMIT 1",
        )
        .bindParams(scopeKey, fieldId)
        .execute(),
    );
    const existingRow = existing.rows?.[0];
    const existingValues = safeParseJson(existingRow?.sample_values_json, []);
    const existingUniqueCount = toNumber(existingRow?.unique_value_count, 0);

    const merged = new Set([...existingValues, ...values]);
    const newUniqueCount = existingUniqueCount + values.size;
    const sampleValues = Array.from(merged).slice(0, MAX_SAMPLE_VALUES);

    await withSqlRetry(() =>
      sql
        .prepare(
          `
        INSERT INTO rqt_field_index (scope_key, field_id, field_name, issue_count, unique_value_count, sample_values_json, refreshed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          field_name = VALUES(field_name),
          issue_count = issue_count + VALUES(issue_count),
          unique_value_count = VALUES(unique_value_count),
          sample_values_json = VALUES(sample_values_json),
          refreshed_at = VALUES(refreshed_at)
      `,
        )
        .bindParams(scopeKey, fieldId, fieldName || fieldId, count, newUniqueCount, JSON.stringify(sampleValues), now)
        .execute(),
    );
  }
}

export async function loadRqtFieldIndex(scopeKey) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT field_id, field_name, issue_count, unique_value_count, sample_values_json, refreshed_at
      FROM rqt_field_index
      WHERE scope_key = ?
      ORDER BY issue_count DESC, field_id ASC
    `,
      )
      .bindParams(scopeKey)
      .execute(),
  );

  return (result.rows || []).map((row) => ({
    fieldId: row.field_id,
    fieldName: row.field_name || row.field_id,
    issueCount: toNumber(row.issue_count),
    uniqueValueCount: toNumber(row.unique_value_count),
    sampleValues: safeParseJson(row.sample_values_json, []),
    refreshedAt: row.refreshed_at || null,
  }));
}

export async function clearRqtIssueKeys(scopeKey) {
  await ensureProjectStoreReady();
  await withSqlRetry(() =>
    sql.prepare("DELETE FROM rqt_issue_keys WHERE scope_key = ?").bindParams(scopeKey).execute(),
  );
}

export async function upsertRqtIssueKeys(scopeKey, keys) {
  if (!keys?.length) return;
  await ensureProjectStoreReady();
  const BATCH = 50;
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    const placeholders = batch.map(() => "(?, ?, ?, ?)").join(", ");
    const params = batch.flatMap(({ projectKey, issueType, issueKey }) => [
      scopeKey,
      projectKey,
      issueType || "",
      issueKey,
    ]);
    await withSqlRetry(() =>
      sql
        .prepare(
          `INSERT IGNORE INTO rqt_issue_keys (scope_key, project_key, issue_type, issue_key) VALUES ${placeholders}`,
        )
        .bindParams(...params)
        .execute(),
    );
  }
}

export async function loadRqtIssueKeys(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT project_key, issue_type, issue_key
      FROM rqt_issue_keys
      WHERE scope_key = ?
      ORDER BY project_key ASC, issue_type ASC, issue_key ASC
    `,
      )
      .bindParams(scopeKey)
      .execute(),
  );

  // Group: projectKey → issueType → [issueKeys]
  const byProject = new Map();
  for (const row of result.rows || []) {
    const pk = row.project_key || "UNKNOWN";
    const it = row.issue_type || "Unknown";
    if (!byProject.has(pk)) byProject.set(pk, new Map());
    const byType = byProject.get(pk);
    if (!byType.has(it)) byType.set(it, []);
    byType.get(it).push(row.issue_key);
  }

  return Array.from(byProject.entries())
    .map(([projectKey, byType]) => {
      const types = Array.from(byType.entries())
        .map(([issueType, issues]) => ({ issueType, issues, count: issues.length }))
        .sort((a, b) => b.count - a.count);
      const total = types.reduce((s, t) => s + t.count, 0);
      return { projectKey, types, total };
    })
    .sort((a, b) => b.total - a.total);
}

export async function clearRqtValueIndex(scopeKey) {
  await ensureProjectStoreReady();
  await withSqlRetry(() =>
    sql.prepare("DELETE FROM rqt_value_issue_index WHERE scope_key = ?").bindParams(scopeKey).execute(),
  );
}

export async function upsertRqtValueIssueKeys(scopeKey, entries) {
  if (!entries?.length) return;
  await ensureProjectStoreReady();
  const BATCH = 25;
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const placeholders = batch.map(() => "(?, ?, ?)").join(", ");
    const params = batch.flatMap(({ rqtValue, issueKey }) => [scopeKey, rqtValue, issueKey]);
    await withSqlRetry(() =>
      sql
        .prepare(`INSERT IGNORE INTO rqt_value_issue_index (scope_key, rqt_value, issue_key) VALUES ${placeholders}`)
        .bindParams(...params)
        .execute(),
    );
  }
}

export async function loadRqtValueFrequency(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT rqt_value, COUNT(*) as cnt
      FROM rqt_value_issue_index
      WHERE scope_key = ?
      GROUP BY rqt_value
      ORDER BY cnt DESC
      LIMIT 100
    `,
      )
      .bindParams(scopeKey)
      .execute(),
  );
  return (result.rows || []).map((row) => ({ value: row.rqt_value, count: toNumber(row.cnt) }));
}

export async function searchRqtValueIssueKeys(scopeKey, rqtValue) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare("SELECT issue_key FROM rqt_value_issue_index WHERE scope_key = ? AND rqt_value = ?")
      .bindParams(scopeKey, rqtValue)
      .execute(),
  );
  return (result.rows || []).map((row) => row.issue_key);
}

export async function loadIssueRqtValues(scopeKey) {
  const result = await withSqlRetry(() =>
    sql
      .prepare("SELECT issue_key, rqt_value FROM rqt_value_issue_index WHERE scope_key = ?")
      .bindParams(scopeKey)
      .execute(),
  );
  const map = {};
  for (const row of result.rows || []) {
    if (!map[row.issue_key]) map[row.issue_key] = [];
    map[row.issue_key].push(row.rqt_value);
  }
  return map;
}

export async function clearRqtFieldIssueIndex(scopeKey) {
  await withSqlRetry(() =>
    sql.prepare("DELETE FROM rqt_field_issue_index WHERE scope_key = ?").bindParams(scopeKey).execute(),
  );
}

export async function upsertRqtFieldIssueKeys(scopeKey, entries) {
  // entries: [{ fieldId, issueKey }]
  for (let i = 0; i < entries.length; i += 50) {
    const batch = entries.slice(i, i + 50);
    const placeholders = batch.map(() => "(?, ?, ?)").join(", ");
    const params = batch.flatMap((e) => [scopeKey, e.fieldId, e.issueKey]);
    await withSqlRetry(() =>
      sql
        .prepare(`INSERT IGNORE INTO rqt_field_issue_index (scope_key, field_id, issue_key) VALUES ${placeholders}`)
        .bindParams(...params)
        .execute(),
    );
  }
}

export async function loadRqtFieldIssueIndex(scopeKey) {
  const result = await withSqlRetry(() =>
    sql
      .prepare("SELECT field_id, issue_key FROM rqt_field_issue_index WHERE scope_key = ?")
      .bindParams(scopeKey)
      .execute(),
  );
  const map = {};
  for (const row of result.rows || []) {
    if (!map[row.field_id]) map[row.field_id] = [];
    map[row.field_id].push(row.issue_key);
  }
  return map;
}
