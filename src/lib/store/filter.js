// Persistence for the saved filter inventory.
//
// Follows store/screen.js: one versioned snapshot, replaced wholesale, with a meta row
// carrying build state. Imports only from core.js, so there is one arrow and no cycle.

import { sql } from "@forge/sql";
import {
  chunkArray,
  ensureProjectStoreReady,
  toNumber,
  withSqlRetry,
} from "./core.js";

// Rows per statement. Filters bind 15 params each, which is the widest row in this codebase,
// so the batch is correspondingly smaller -- the ceiling that binds is total bound parameters
// per statement, not rows.
const FILTER_BATCH = 20;
const REF_BATCH = 60;

export async function readFilterSnapshotMeta(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT version, state, started_at, completed_at, refreshed_at, total_filters, last_error,
             building_version, build_token, build_cursor, processed, total_expected, updated_at
      FROM filter_snapshot_meta WHERE scope_key = ?
    `).bindParams(scopeKey).execute()
  );
  const row = result.rows?.[0];
  if (!row) return null;
  return {
    version: row.version || null,
    state: row.state || "idle",
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    refreshedAt: row.refreshed_at || null,
    totalFilters: toNumber(row.total_filters),
    lastError: row.last_error || null,
    buildingVersion: row.building_version || null,
    buildToken: row.build_token || null,
    buildCursor: row.build_cursor || null,
    processed: toNumber(row.processed),
    totalExpected: toNumber(row.total_expected),
    updatedAt: row.updated_at || null,
  };
}

// Merge-patch, like the other snapshot metas: a caller marking a build finished should not
// have to restate the version it did not change.
export async function writeFilterSnapshotMeta(scopeKey, patch = {}) {
  await ensureProjectStoreReady();
  const current = (await readFilterSnapshotMeta(scopeKey)) || {};
  const next = { ...current, ...patch };

  await withSqlRetry(() =>
    sql.prepare(`
      INSERT INTO filter_snapshot_meta
        (scope_key, version, state, started_at, completed_at, refreshed_at, total_filters, last_error,
         building_version, build_token, build_cursor, processed, total_expected, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        version = VALUES(version),
        state = VALUES(state),
        started_at = VALUES(started_at),
        completed_at = VALUES(completed_at),
        refreshed_at = VALUES(refreshed_at),
        total_filters = VALUES(total_filters),
        last_error = VALUES(last_error),
        building_version = VALUES(building_version),
        build_token = VALUES(build_token),
        build_cursor = VALUES(build_cursor),
        processed = VALUES(processed),
        total_expected = VALUES(total_expected),
        updated_at = VALUES(updated_at)
    `).bindParams(
      scopeKey,
      next.version || null,
      next.state || "idle",
      next.startedAt || null,
      next.completedAt || null,
      next.refreshedAt || null,
      Number(next.totalFilters) || 0,
      next.lastError || null,
      next.buildingVersion || null,
      next.buildToken || null,
      next.buildCursor || null,
      Number(next.processed) || 0,
      Number(next.totalExpected) || 0,
      next.updatedAt || null
    ).execute()
  );
  return next;
}

// Replace one version wholesale.
//
// Replace, never merge: a rebuild describes the estate as it now stands, so a filter somebody
// deleted has to disappear here too -- otherwise it keeps protecting a field from cleanup
// forever, which is the exact failure this pillar exists to prevent in the other direction.
// Drop anything already stored under a version.
//
// Split out of replaceFilterSnapshot so a resumable build can clear ONCE at the start and then
// append chunk by chunk. A chunked build that cleared on every write would delete the pages it
// had already fetched, and never finish no matter how long it ran.
export async function clearFilterSnapshotVersion(scopeKey, version) {
  await ensureProjectStoreReady();

  for (const table of ["snapshot_filters", "snapshot_filter_refs", "snapshot_filter_shares"]) {
    await withSqlRetry(() =>
      sql.prepare(`DELETE FROM ${table} WHERE scope_key = ? AND version = ?`)
        .bindParams(scopeKey, version).execute()
    );
  }
}

// Append one chunk's rows to a version, leaving whatever is already there.
//
// INSERT IGNORE throughout, so a chunk redelivered by the queue is idempotent: Forge can
// deliver a message more than once, and a resumable build must survive that without doubling
// its own rows.
export async function appendFilterSnapshot(scopeKey, version, { filters = [], refs = [], shares = [] }) {
  await ensureProjectStoreReady();

  for (const batch of chunkArray(filters, FILTER_BATCH)) {
    // 16 placeholders for 16 columns. It was 15 for years -- see store-sql-arity.test.js.
    const values = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((f) => [
      scopeKey, version, String(f.id),
      f.name ?? null, f.description ?? null, f.jql ?? null,
      // Truncated to what the index column holds. Only used for equality grouping, so a
      // collision between two 512-character searches is a duplicate reported that a human
      // then reads -- not a wrong answer acted on automatically.
      (f.jqlNormalized ?? "").slice(0, 512) || null,
      f.ownerAccountId ?? null, f.ownerName ?? null,
      // Tri-state: 1 active, 0 deactivated, NULL when the owner is gone entirely.
      f.ownerActive === null || f.ownerActive === undefined ? null : (f.ownerActive ? 1 : 0),
      Number(f.subscriptionCount) || 0,
      Number(f.favouritedCount) || 0,
      f.sharedWithEveryone ? 1 : 0,
      Number(f.shareCount) || 0,
      f.lastUsedAt ?? null,
      f.viewUrl ?? null,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT IGNORE INTO snapshot_filters
          (scope_key, version, filter_id, name, description, jql, jql_normalized,
           owner_account_id, owner_name, owner_active, subscription_count, favourited_count,
           shared_with_everyone, share_count, last_used_at, view_url)
        VALUES ${values}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(refs, REF_BATCH)) {
    const values = batch.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((r) => [scopeKey, version, String(r.filterId), r.kind, String(r.label).slice(0, 191)]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT IGNORE INTO snapshot_filter_refs (scope_key, version, filter_id, kind, label)
        VALUES ${values}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(shares, REF_BATCH)) {
    const values = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((s) => [
      scopeKey, version, String(s.filterId), Number(s.index) || 0,
      s.type ?? "unknown", s.targetId ?? null, s.targetName ?? null, s.roleId ?? null,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT IGNORE INTO snapshot_filter_shares
          (scope_key, version, filter_id, share_index, share_type, target_id, target_name, role_id)
        VALUES ${values}
      `).bindParams(...params).execute()
    );
  }

  return { filters: filters.length, refs: refs.length, shares: shares.length };
}

// Clear a version and write it in one call. The single-invocation shape, kept because the
// non-chunked callers and their tests are still correct -- it is now composed of the two
// halves above rather than being a third implementation of them.
export async function replaceFilterSnapshot(scopeKey, version, payload = {}) {
  await clearFilterSnapshotVersion(scopeKey, version);
  return appendFilterSnapshot(scopeKey, version, payload);
}

// Every filter in a version, with its shares folded back in.
//
// Loaded whole rather than paged: the reference site's filter count is in the hundreds, the
// analysis needs all of them at once to find duplicates, and the tab filters client-side over
// what it already has.
export async function loadFilters(scopeKey, version) {
  await ensureProjectStoreReady();

  const [filterRows, shareRows, refRows] = await Promise.all([
    withSqlRetry(() => sql.prepare(`
      SELECT filter_id, name, description, jql, jql_normalized, owner_account_id, owner_name,
             owner_active, subscription_count, favourited_count, shared_with_everyone,
             share_count, last_used_at, view_url
      FROM snapshot_filters WHERE scope_key = ? AND version = ?
      ORDER BY name ASC
    `).bindParams(scopeKey, version).execute()),
    withSqlRetry(() => sql.prepare(`
      SELECT filter_id, share_type, target_id, target_name, role_id
      FROM snapshot_filter_shares WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()),
    withSqlRetry(() => sql.prepare(`
      SELECT filter_id, kind, label
      FROM snapshot_filter_refs WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()),
  ]);

  const sharesByFilter = new Map();
  for (const row of shareRows.rows || []) {
    const id = String(row.filter_id);
    if (!sharesByFilter.has(id)) sharesByFilter.set(id, []);
    sharesByFilter.get(id).push({
      type: row.share_type, targetId: row.target_id, targetName: row.target_name, roleId: row.role_id,
    });
  }

  const refsByFilter = new Map();
  for (const row of refRows.rows || []) {
    const id = String(row.filter_id);
    if (!refsByFilter.has(id)) refsByFilter.set(id, { field: [], project: [], status: [] });
    const bucket = refsByFilter.get(id);
    if (bucket[row.kind]) bucket[row.kind].push(row.label);
  }

  return (filterRows.rows || []).map((row) => {
    const id = String(row.filter_id);
    const refs = refsByFilter.get(id) || { field: [], project: [], status: [] };
    return {
      id,
      name: row.name || id,
      description: row.description || "",
      jql: row.jql || "",
      jqlNormalized: row.jql_normalized || "",
      ownerAccountId: row.owner_account_id || null,
      ownerName: row.owner_name || null,
      // Rebuilt into the shape filter-insights.js reads, so that module needs no knowledge
      // of how a row is stored.
      owner: row.owner_account_id === null && row.owner_name === null
        ? null
        : { accountId: row.owner_account_id, displayName: row.owner_name, active: row.owner_active === null ? true : toNumber(row.owner_active) === 1 },
      ownerActive: row.owner_active === null ? null : toNumber(row.owner_active) === 1,
      subscriptionCount: toNumber(row.subscription_count),
      favouritedCount: toNumber(row.favourited_count),
      sharedWithEveryone: toNumber(row.shared_with_everyone) === 1,
      shareCount: toNumber(row.share_count),
      lastUsedAt: row.last_used_at || null,
      viewUrl: row.view_url || null,
      shares: sharesByFilter.get(id) || [],
      fieldRefs: refs.field,
      projectRefs: refs.project,
      statusRefs: refs.status,
    };
  });
}

// Which filters reference one field or status.
//
// The cross-pillar read, and the reason the refs table has its own index. The Field Browser
// asks this per expanded field, so it has to be a query rather than a scan of every filter.
export async function loadFilterReferencesFor(scopeKey, version, kind, label, limit = 200) {
  await ensureProjectStoreReady();
  // Interpolated, never bound: Forge SQL rejects a placeholder in LIMIT, which makes coercing
  // it to a bounded integer here the only thing between a caller and an injection.
  const cap = Math.max(1, Math.min(1000, Math.trunc(Number(limit)) || 200));

  const rows = await withSqlRetry(() =>
    sql.prepare(`
      SELECT f.filter_id, f.name, f.owner_name, f.owner_active, f.subscription_count, f.last_used_at
      FROM snapshot_filter_refs r
      JOIN snapshot_filters f
        ON f.scope_key = r.scope_key AND f.version = r.version AND f.filter_id = r.filter_id
      WHERE r.scope_key = ? AND r.version = ? AND r.kind = ? AND LOWER(r.label) = LOWER(?)
      ORDER BY f.name ASC
      LIMIT ${cap}
    `).bindParams(scopeKey, version, kind, label).execute()
  );

  const counted = await withSqlRetry(() =>
    sql.prepare(`
      SELECT COUNT(*) AS total FROM snapshot_filter_refs
      WHERE scope_key = ? AND version = ? AND kind = ? AND LOWER(label) = LOWER(?)
    `).bindParams(scopeKey, version, kind, label).execute()
  );

  return {
    total: toNumber(counted.rows?.[0]?.total),
    filters: (rows.rows || []).map((row) => ({
      id: String(row.filter_id),
      name: row.name || String(row.filter_id),
      ownerName: row.owner_name || null,
      ownerActive: row.owner_active === null ? null : toNumber(row.owner_active) === 1,
      subscriptionCount: toNumber(row.subscription_count),
      lastUsedAt: row.last_used_at || null,
    })),
  };
}

// Counts per label, for a page of fields at once.
//
// Batched for the same reason loadStatusAutomationReferences is: the Field Browser shows
// twenty-five fields a page, and asking per field is twenty-five round trips to render one
// list.
export async function loadFilterReferenceCounts(scopeKey, version, kind, labels = []) {
  await ensureProjectStoreReady();
  const names = [...new Set((labels || []).map((l) => String(l || "").trim()).filter(Boolean))];
  if (!names.length) return {};

  const out = {};
  for (const batch of chunkArray(names, 100)) {
    const placeholders = batch.map(() => "LOWER(?)").join(", ");
    const result = await withSqlRetry(() =>
      sql.prepare(`
        SELECT LOWER(label) AS label, COUNT(DISTINCT filter_id) AS filter_count
        FROM snapshot_filter_refs
        WHERE scope_key = ? AND version = ? AND kind = ? AND LOWER(label) IN (${placeholders})
        GROUP BY LOWER(label)
      `).bindParams(scopeKey, version, kind, ...batch).execute()
    );
    for (const row of result.rows || []) out[String(row.label)] = toNumber(row.filter_count);
  }
  return out;
}

// Drop every version except the one named. Mirrors the other snapshots' pruning.
export async function pruneFilterSnapshots(scopeKey, keepVersion) {
  await ensureProjectStoreReady();
  for (const table of ["snapshot_filters", "snapshot_filter_refs", "snapshot_filter_shares"]) {
    await withSqlRetry(() =>
      sql.prepare(`DELETE FROM ${table} WHERE scope_key = ? AND version <> ?`)
        .bindParams(scopeKey, keepVersion).execute()
    );
  }
}
