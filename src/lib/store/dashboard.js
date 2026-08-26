// Persistence for the dashboard inventory.
//
// Follows store/filter.js: one versioned snapshot, replaced wholesale, with a meta row
// carrying build state. Imports only from core.js, so there is one arrow and no cycle.

import { sql } from "@forge/sql";
import {
  chunkArray,
  ensureProjectStoreReady,
  toNumber,
  withSqlRetry,
} from "./core.js";

const DASHBOARD_BATCH = 25;
const CHILD_BATCH = 60;

export async function readDashboardSnapshotMeta(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT version, state, started_at, completed_at, refreshed_at,
             total_dashboards, gadgets_walked, last_error,
             building_version, build_token, build_cursor, processed, total_expected, updated_at
      FROM dashboard_snapshot_meta WHERE scope_key = ?
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
    totalDashboards: toNumber(row.total_dashboards),
    gadgetsWalked: toNumber(row.gadgets_walked),
    lastError: row.last_error || null,
    buildingVersion: row.building_version || null,
    buildToken: row.build_token || null,
    buildCursor: row.build_cursor || null,
    processed: toNumber(row.processed),
    totalExpected: toNumber(row.total_expected),
    updatedAt: row.updated_at || null,
  };
}

// Merge-patch, like every other snapshot meta here: a caller marking a build finished should
// not have to restate the version it did not change.
export async function writeDashboardSnapshotMeta(scopeKey, patch = {}) {
  await ensureProjectStoreReady();
  const current = (await readDashboardSnapshotMeta(scopeKey)) || {};
  const next = { ...current, ...patch };

  await withSqlRetry(() =>
    sql.prepare(`
      INSERT INTO dashboard_snapshot_meta
        (scope_key, version, state, started_at, completed_at, refreshed_at,
         total_dashboards, gadgets_walked, last_error,
         building_version, build_token, build_cursor, processed, total_expected, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        version = VALUES(version),
        state = VALUES(state),
        started_at = VALUES(started_at),
        completed_at = VALUES(completed_at),
        refreshed_at = VALUES(refreshed_at),
        total_dashboards = VALUES(total_dashboards),
        gadgets_walked = VALUES(gadgets_walked),
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
      Number(next.totalDashboards) || 0,
      Number(next.gadgetsWalked) || 0,
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
// Replace, never merge: a rebuild describes the estate as it now stands, so a dashboard
// somebody deleted has to disappear here too rather than lingering as a finding nobody can
// act on.
// Drop anything already stored under a version. See the filter store for why this is split
// out: a chunked build clears once, then appends.
export async function clearDashboardSnapshotVersion(scopeKey, version) {
  await ensureProjectStoreReady();

  for (const table of ["snapshot_dashboards", "snapshot_dashboard_gadgets", "snapshot_dashboard_shares"]) {
    await withSqlRetry(() =>
      sql.prepare(`DELETE FROM ${table} WHERE scope_key = ? AND version = ?`)
        .bindParams(scopeKey, version).execute()
    );
  }
}

// Append one chunk's rows to a version. INSERT IGNORE throughout, so a redelivered queue
// message cannot double-count.
export async function appendDashboardSnapshot(scopeKey, version, { dashboards = [], gadgets = [], shares = [], gadgetCounts = [] }) {
  await ensureProjectStoreReady();

  for (const batch of chunkArray(dashboards, DASHBOARD_BATCH)) {
    const values = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((d) => [
      scopeKey, version, String(d.id),
      d.name ?? null, d.description ?? null,
      d.ownerAccountId ?? null, d.ownerName ?? null,
      d.ownerActive === null || d.ownerActive === undefined ? null : (d.ownerActive ? 1 : 0),
      Number(d.popularity) || 0,
      // NULL, not 0: the gadget walk not reaching a dashboard is a different fact from it
      // having no gadgets, and only one of them is a finding.
      d.gadgetCount === null || d.gadgetCount === undefined ? null : Number(d.gadgetCount),
      d.sharedWithEveryone ? 1 : 0,
      d.editableByEveryone ? 1 : 0,
      Number(d.shareCount) || 0,
      d.viewUrl ?? null,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT IGNORE INTO snapshot_dashboards
          (scope_key, version, dashboard_id, name, description, owner_account_id, owner_name,
           owner_active, popularity, gadget_count, shared_with_everyone, editable_by_everyone,
           share_count, view_url)
        VALUES ${values}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(gadgets, CHILD_BATCH)) {
    const values = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((g) => [
      scopeKey, version, String(g.dashboardId), String(g.id),
      g.title ?? null, g.moduleKey ?? null,
      g.row === null || g.row === undefined ? null : Number(g.row),
      g.column === null || g.column === undefined ? null : Number(g.column),
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT IGNORE INTO snapshot_dashboard_gadgets
          (scope_key, version, dashboard_id, gadget_id, title, module_key, position_row, position_column)
        VALUES ${values}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(shares, CHILD_BATCH)) {
    const values = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((s) => [
      scopeKey, version, String(s.dashboardId), s.kind, Number(s.index) || 0,
      s.type ?? "unknown", s.targetId ?? null, s.targetName ?? null,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT IGNORE INTO snapshot_dashboard_shares
          (scope_key, version, dashboard_id, permission_kind, share_index, share_type, target_id, target_name)
        VALUES ${values}
      `).bindParams(...params).execute()
    );
  }

  // Gadget counts arrive in phase two, after the dashboards themselves are stored. Written
  // one at a time rather than batched: the set is at most DASHBOARD_GADGET_CHUNK per chunk,
  // and a per-row UPDATE keeps "walked but unreadable" (null) distinguishable from "not yet
  // walked" (also null, but with no UPDATE having happened) via gadgets_walked in meta.
  for (const entry of gadgetCounts) {
    await withSqlRetry(() =>
      sql.prepare(`
        UPDATE snapshot_dashboards SET gadget_count = ?, gadget_walk_done = 1
        WHERE scope_key = ? AND version = ? AND dashboard_id = ?
      `).bindParams(
        entry.gadgetCount === null || entry.gadgetCount === undefined ? null : Number(entry.gadgetCount),
        scopeKey, version, String(entry.id)
      ).execute()
    );
  }

  return { dashboards: dashboards.length, gadgets: gadgets.length, shares: shares.length };
}

// Gadgets whose configuration has not been read yet.
//
// The queue for the config phase, read from SQL each chunk rather than carried in the cursor
// so a redelivered message re-reads what is actually still missing. Same shape and same reason
// as loadDashboardIdsNeedingGadgets.
export async function loadGadgetsNeedingConfig(scopeKey, version, limit = 40) {
  await ensureProjectStoreReady();
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 40));
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT dashboard_id, gadget_id FROM snapshot_dashboard_gadgets
      WHERE scope_key = ? AND version = ? AND config_walk_done = 0
      ORDER BY dashboard_id, gadget_id
      LIMIT ${safeLimit}
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((r) => ({
    dashboardId: String(r.dashboard_id),
    gadgetId: String(r.gadget_id),
  }));
}

// Record what a gadget points at. A null filterId is still a result -- it means the gadget was
// read and references no filter -- which is why config_walk_done is set either way.
export async function recordGadgetConfigs(scopeKey, version, entries = []) {
  await ensureProjectStoreReady();
  for (const entry of entries) {
    await withSqlRetry(() =>
      sql.prepare(`
        UPDATE snapshot_dashboard_gadgets
        SET filter_id = ?, config_walk_done = 1
        WHERE scope_key = ? AND version = ? AND dashboard_id = ? AND gadget_id = ?
      `).bindParams(
        entry.filterId ? String(entry.filterId) : null,
        scopeKey, version, String(entry.dashboardId), String(entry.gadgetId)
      ).execute()
    );
  }
  return { recorded: entries.length };
}

// Which dashboards reach a given filter, and through which gadget.
//
// The second leg of dashboard -> gadget -> filter -> field. Returns the gadget title as well
// as the dashboard, because "Sprint Health" tells a reader where on the dashboard to look in a
// way the dashboard name alone does not.
export async function loadDashboardsForFilters(scopeKey, version, filterIds = []) {
  await ensureProjectStoreReady();
  const ids = [...new Set(filterIds.filter(Boolean).map(String))];
  if (!ids.length) return [];

  const rows = [];
  for (const batch of chunkArray(ids, 50)) {
    const placeholders = batch.map(() => "?").join(", ");
    const result = await withSqlRetry(() =>
      sql.prepare(`
        SELECT g.filter_id, g.dashboard_id, g.gadget_id, g.title AS gadget_title,
               d.name AS dashboard_name, d.view_url, d.owner_name, d.popularity
        FROM snapshot_dashboard_gadgets g
        JOIN snapshot_dashboards d
          ON d.scope_key = g.scope_key AND d.version = g.version AND d.dashboard_id = g.dashboard_id
        WHERE g.scope_key = ? AND g.version = ? AND g.filter_id IN (${placeholders})
      `).bindParams(scopeKey, version, ...batch).execute()
    );
    rows.push(...(result.rows || []));
  }

  return rows.map((r) => ({
    filterId: String(r.filter_id),
    dashboardId: String(r.dashboard_id),
    dashboardName: r.dashboard_name || null,
    gadgetTitle: r.gadget_title || null,
    ownerName: r.owner_name || null,
    popularity: toNumber(r.popularity),
    viewUrl: r.view_url || null,
  }));
}

// How much of the config walk actually completed, so a caller can say "none found" honestly.
export async function countGadgetConfigCoverage(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT COUNT(*) AS total, SUM(config_walk_done) AS walked
      FROM snapshot_dashboard_gadgets WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()
  );
  const row = result.rows?.[0] || {};
  return { total: toNumber(row.total), walked: toNumber(row.walked) };
}

// Dashboards in a version whose gadget list has not been walked yet.
//
// The queue for phase two. Read from SQL each chunk rather than carried in the cursor, so a
// redelivered message re-reads what is ACTUALLY still missing instead of trusting a list that
// may already have been processed. That is what makes the phase idempotent.
//
// `gadget_walk_done` rather than `gadget_count IS NULL`, because null is also the answer for a
// dashboard that was walked and could not be read -- retrying those forever would mean the
// build never terminates on a site with one broken dashboard.
export async function loadDashboardIdsNeedingGadgets(scopeKey, version, limit = 60) {
  await ensureProjectStoreReady();
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 60));
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT dashboard_id FROM snapshot_dashboards
      WHERE scope_key = ? AND version = ? AND gadget_walk_done = 0
      ORDER BY dashboard_id
      LIMIT ${safeLimit}
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((r) => String(r.dashboard_id));
}

// Clear a version and write it in one call, for the non-chunked callers.
export async function replaceDashboardSnapshot(scopeKey, version, payload = {}) {
  await clearDashboardSnapshotVersion(scopeKey, version);
  return appendDashboardSnapshot(scopeKey, version, payload);
}

// Every dashboard in a version, with its shares and gadget titles folded back in.
//
// Loaded whole rather than paged: a site's dashboard count is in the hundreds at most, the
// analysis needs all of them to compute rates, and the tab filters client-side over what it
// already has.
export async function loadDashboards(scopeKey, version) {
  await ensureProjectStoreReady();

  const [dashboardRows, shareRows, gadgetRows] = await Promise.all([
    withSqlRetry(() => sql.prepare(`
      SELECT dashboard_id, name, description, owner_account_id, owner_name, owner_active,
             popularity, gadget_count, shared_with_everyone, editable_by_everyone,
             share_count, view_url
      FROM snapshot_dashboards WHERE scope_key = ? AND version = ?
      ORDER BY popularity DESC, name ASC
    `).bindParams(scopeKey, version).execute()),
    withSqlRetry(() => sql.prepare(`
      SELECT dashboard_id, permission_kind, share_type, target_id, target_name
      FROM snapshot_dashboard_shares WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()),
    withSqlRetry(() => sql.prepare(`
      SELECT dashboard_id, gadget_id, title, module_key, filter_id
      FROM snapshot_dashboard_gadgets WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()),
  ]);

  const sharesByDashboard = new Map();
  const editSharesByDashboard = new Map();
  for (const row of shareRows.rows || []) {
    const id = String(row.dashboard_id);
    const target = row.permission_kind === "edit" ? editSharesByDashboard : sharesByDashboard;
    if (!target.has(id)) target.set(id, []);
    target.get(id).push({ type: row.share_type, targetId: row.target_id, targetName: row.target_name });
  }

  const gadgetsByDashboard = new Map();
  for (const row of gadgetRows.rows || []) {
    const id = String(row.dashboard_id);
    if (!gadgetsByDashboard.has(id)) gadgetsByDashboard.set(id, []);
    gadgetsByDashboard.get(id).push({
      id: String(row.gadget_id), title: row.title || null, moduleKey: row.module_key || null,
      filterId: row.filter_id ? String(row.filter_id) : null,
    });
  }

  return (dashboardRows.rows || []).map((row) => {
    const id = String(row.dashboard_id);
    return {
      id,
      name: row.name || id,
      description: row.description || "",
      ownerAccountId: row.owner_account_id || null,
      ownerName: row.owner_name || null,
      // Rebuilt into the shape dashboard-insights.js reads, so that module needs no knowledge
      // of how a row is stored.
      owner: row.owner_account_id === null && row.owner_name === null
        ? null
        : { accountId: row.owner_account_id, displayName: row.owner_name, active: row.owner_active === null ? true : toNumber(row.owner_active) === 1 },
      ownerActive: row.owner_active === null ? null : toNumber(row.owner_active) === 1,
      popularity: toNumber(row.popularity),
      // Preserved as null rather than coerced: "not walked" is not "no gadgets".
      gadgetCount: row.gadget_count === null || row.gadget_count === undefined ? null : toNumber(row.gadget_count),
      sharedWithEveryone: toNumber(row.shared_with_everyone) === 1,
      editableByEveryone: toNumber(row.editable_by_everyone) === 1,
      shareCount: toNumber(row.share_count),
      viewUrl: row.view_url || null,
      shares: sharesByDashboard.get(id) || [],
      editShares: editSharesByDashboard.get(id) || [],
      gadgets: gadgetsByDashboard.get(id) || [],
    };
  });
}

// Drop every version except the one named. Mirrors the other snapshots' pruning.
export async function pruneDashboardSnapshots(scopeKey, keepVersion) {
  await ensureProjectStoreReady();
  for (const table of ["snapshot_dashboards", "snapshot_dashboard_gadgets", "snapshot_dashboard_shares"]) {
    await withSqlRetry(() =>
      sql.prepare(`DELETE FROM ${table} WHERE scope_key = ? AND version <> ?`)
        .bindParams(scopeKey, keepVersion).execute()
    );
  }
}
