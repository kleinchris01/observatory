// The People pillar: the licensed-user roster and which Jira products each user holds.
//
// Same shape as store/issuetype.js -- imports only from core.js so there is one arrow and no
// cycle, and the write path is a full replace per scope. The roster is enumerated from the
// members of the application-access groups (see getApplicationRoles / getGroupMembers), so
// it is bounded by the site's licence count and completes inside one invocation.
//
// Project roles, activity and ownership joins are follow-up work and land in their own
// tables; this module is the catalog tier.

import { sql } from "@forge/sql";
import {
  chunkArray,
  ensureProjectStoreReady,
  safeParseJson,
  toNumber,
  withSqlRetry,
} from "./core.js";

const DEFAULT_BATCH_SIZE = 50;

export async function replaceUserSnapshot(scopeKey, version, { users = [], access = [] } = {}) {
  await ensureProjectStoreReady();

  // Scoped deletes only -- an unscoped DELETE in a multi-tenant Forge app destroys another
  // customer's data, and project-store.writes.test.js asserts this mechanically.
  for (const table of ["snapshot_users", "snapshot_user_access"]) {
    await withSqlRetry(() =>
      sql.prepare(`DELETE FROM ${table} WHERE scope_key = ?`).bindParams(scopeKey).execute()
    );
  }

  for (const batch of chunkArray(users, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((u) => [
      scopeKey, version, String(u.accountId),
      u.displayName || null,
      u.active === false ? 0 : 1,
      u.accountType || null,
      u.avatarUrl || null,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_users
          (scope_key, version, account_id, display_name, active, account_type, avatar_url)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(access, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((a) => [
      scopeKey, version, String(a.accountId),
      String(a.applicationKey), a.applicationName || null,
      String(a.viaGroupId), a.viaGroupName || null,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_user_access
          (scope_key, version, account_id, application_key, application_name, via_group_id, via_group_name)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

// The roster, each user carrying the distinct products they hold and the access groups they
// hold them through. One query with a join rather than a per-user fetch.
export async function loadUsers(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT u.account_id, u.display_name, u.active, u.account_type, u.avatar_url,
             a.application_key, a.application_name, a.via_group_id, a.via_group_name
      FROM snapshot_users u
      LEFT JOIN snapshot_user_access a
        ON a.scope_key = u.scope_key AND a.version = u.version AND a.account_id = u.account_id
      WHERE u.scope_key = ? AND u.version = ?
      ORDER BY u.display_name ASC, u.account_id ASC
    `).bindParams(scopeKey, version).execute()
  );

  const byAccount = new Map();
  for (const row of result.rows || []) {
    const accountId = row.account_id;
    if (!byAccount.has(accountId)) {
      byAccount.set(accountId, {
        accountId,
        displayName: row.display_name || accountId,
        active: Boolean(toNumber(row.active)),
        accountType: row.account_type || null,
        avatarUrl: row.avatar_url || null,
        applications: [],
        groups: [],
      });
    }
    const user = byAccount.get(accountId);
    if (row.application_key && !user.applications.some((p) => p.key === row.application_key)) {
      user.applications.push({ key: row.application_key, name: row.application_name || row.application_key });
    }
    if (row.via_group_id && !user.groups.some((g) => g.id === row.via_group_id)) {
      user.groups.push({ id: row.via_group_id, name: row.via_group_name || row.via_group_id });
    }
  }
  return [...byAccount.values()];
}

// Aggregates for the pillar overview, computed in SQL rather than by loading the roster.
export async function loadUserGovernanceSummary(scopeKey, version) {
  await ensureProjectStoreReady();

  const users = await withSqlRetry(() =>
    sql.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active_count,
        SUM(CASE WHEN account_type = 'app' THEN 1 ELSE 0 END) AS app_count
      FROM snapshot_users
      WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()
  );

  // Users who hold more than one product licence -- the multi-product seats an admin most
  // often wants to review.
  const multiProduct = await withSqlRetry(() =>
    sql.prepare(`
      SELECT COUNT(*) AS multi FROM (
        SELECT account_id
        FROM snapshot_user_access
        WHERE scope_key = ? AND version = ?
        GROUP BY account_id
        HAVING COUNT(DISTINCT application_key) > 1
      ) t
    `).bindParams(scopeKey, version).execute()
  );

  const row = users.rows?.[0] || {};
  return {
    totalUsers: toNumber(row.total),
    activeUsers: toNumber(row.active_count),
    appUsers: toNumber(row.app_count),
    multiProductUsers: toNumber(multiProduct.rows?.[0]?.multi),
  };
}

// ── Meta ─────────────────────────────────────────────────────────────────────

export async function readUserSnapshotMeta(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT state, version, started_at, completed_at, refreshed_at,
             total_users, active_users, application_summary, last_error
      FROM user_snapshot_meta WHERE scope_key = ?
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
    totalUsers: toNumber(row.total_users),
    activeUsers: toNumber(row.active_users),
    applicationSummary: safeParseJson(row.application_summary, []),
    lastError: row.last_error || null,
  };
}

// Merge-patch over the current row, like writeIssueTypeSnapshotMeta.
export async function writeUserSnapshotMeta(scopeKey, patch = {}) {
  await ensureProjectStoreReady();
  const current = (await readUserSnapshotMeta(scopeKey)) || {};
  const next = { ...current, ...patch };
  const summaryJson = Array.isArray(next.applicationSummary)
    ? JSON.stringify(next.applicationSummary)
    : (next.applicationSummary || null);

  await withSqlRetry(() =>
    sql.prepare(`
      INSERT INTO user_snapshot_meta
        (scope_key, state, version, started_at, completed_at, refreshed_at,
         total_users, active_users, application_summary, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        state = VALUES(state),
        version = VALUES(version),
        started_at = VALUES(started_at),
        completed_at = VALUES(completed_at),
        refreshed_at = VALUES(refreshed_at),
        total_users = VALUES(total_users),
        active_users = VALUES(active_users),
        application_summary = VALUES(application_summary),
        last_error = VALUES(last_error)
    `).bindParams(
      scopeKey,
      next.state || "idle",
      next.version || null,
      next.startedAt || null,
      next.completedAt || null,
      next.refreshedAt || null,
      toNumber(next.totalUsers),
      toNumber(next.activeUsers),
      summaryJson,
      next.lastError || null
    ).execute()
  );
  return next;
}
