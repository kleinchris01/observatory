// Archived projects: Jira hides their issues from search, so the issue crawl cannot see them
// and any field data living only there looks like no data at all. Two things are kept:
//
//   archived_projects + archived_projects_meta -- which projects are archived right now, read
//     at the end of each full crawl. Tri-state: never read, read, or refused (with why).
//   field_archived_usage -- the last per-project field counts Observatory saw for a project
//     before it was archived. The crawl's promote step deletes a project's counts once the
//     crawl stops seeing it; these are copied out first, so "this field held 2,340 values in
//     TT" survives the archiving. Cleared for a project once it is restored and counted live.
//
// Imports only from core.js: one arrow, no cycle.

import { sql } from "@forge/sql";
import { chunkArray, ensureProjectStoreReady, toNumber, withSqlRetry } from "./core.js";

// Replace the archived list. `available: false` records that Jira refused, so readers report
// "could not check" rather than "none archived".
export async function replaceArchivedProjects(
  scopeKey,
  projects = [],
  { available = true, error = null, now = new Date() } = {},
) {
  await ensureProjectStoreReady();
  const checkedAt = now.toISOString();
  if (available) {
    await withSqlRetry(() =>
      sql.prepare("DELETE FROM archived_projects WHERE scope_key = ?").bindParams(scopeKey).execute(),
    );
    for (const batch of chunkArray(projects, 100)) {
      const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
      const params = batch.flatMap((p) => [
        scopeKey,
        String(p.id),
        p.key || null,
        p.name || null,
        p.archivedAt || null,
        p.issueCount != null ? Number(p.issueCount) : null,
        checkedAt,
      ]);
      await withSqlRetry(() =>
        sql
          .prepare(
            `
          INSERT INTO archived_projects (scope_key, project_id, project_key, project_name, archived_at, issue_count, checked_at)
          VALUES ${valuesSql}
        `,
          )
          .bindParams(...params)
          .execute(),
      );
    }
  }
  await withSqlRetry(() =>
    sql
      .prepare(
        `
      INSERT INTO archived_projects_meta (scope_key, checked_at, available, last_error) VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE checked_at = VALUES(checked_at), available = VALUES(available), last_error = VALUES(last_error)
    `,
      )
      .bindParams(scopeKey, checkedAt, available ? 1 : 0, error ? String(error).slice(0, 500) : null)
      .execute(),
  );
}

// { checkedAt, available, error, projects: [{ id, key, name, archivedAt, issueCount }] }, or
// null when the list has never been read.
export async function loadArchivedProjects(scopeKey) {
  await ensureProjectStoreReady();
  const meta = await withSqlRetry(() =>
    sql
      .prepare("SELECT checked_at, available, last_error FROM archived_projects_meta WHERE scope_key = ?")
      .bindParams(scopeKey)
      .execute(),
  );
  const m = meta.rows?.[0];
  if (!m) return null;
  const rows = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT project_id, project_key, project_name, archived_at, issue_count
      FROM archived_projects WHERE scope_key = ? ORDER BY project_key ASC
    `,
      )
      .bindParams(scopeKey)
      .execute(),
  );
  return {
    checkedAt: m.checked_at,
    available: Boolean(toNumber(m.available)),
    error: m.last_error || null,
    projects: (rows.rows || []).map((r) => ({
      id: String(r.project_id),
      key: r.project_key || String(r.project_id),
      name: r.project_name || null,
      archivedAt: r.archived_at || null,
      issueCount: r.issue_count == null ? null : toNumber(r.issue_count),
    })),
  };
}

// Copy the current field counts of now-archived projects out of snapshot_project_usage before
// the crawl's promote deletes them. A row already copied is refreshed only when the snapshot
// still has it -- once a project's live rows are gone, its saved counts stay as they were.
export async function preserveArchivedFieldUsage(scopeKey, version, archivedProjectIds = [], now = new Date()) {
  await ensureProjectStoreReady();
  const ids = [...new Set(archivedProjectIds.map(String))];
  let copied = 0;
  for (const batch of chunkArray(ids, 100)) {
    const placeholders = batch.map(() => "?").join(", ");
    // eslint-disable-next-line no-await-in-loop -- batched
    const result = await withSqlRetry(() =>
      sql
        .prepare(
          `
        SELECT field_id, project_id, project_key, issue_count
        FROM snapshot_project_usage
        WHERE scope_key = ? AND version = ? AND project_id IN (${placeholders}) AND issue_count > 0
      `,
        )
        .bindParams(scopeKey, version, ...batch)
        .execute(),
    );
    const rows = result.rows || [];
    for (const chunk of chunkArray(rows, 100)) {
      const valuesSql = chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
      const params = chunk.flatMap((r) => [
        scopeKey,
        r.field_id,
        String(r.project_id),
        r.project_key || null,
        toNumber(r.issue_count),
        now.toISOString(),
      ]);
      // eslint-disable-next-line no-await-in-loop
      await withSqlRetry(() =>
        sql
          .prepare(
            `
          INSERT INTO field_archived_usage (scope_key, field_id, project_id, project_key, issue_count, last_seen_at)
          VALUES ${valuesSql}
          ON DUPLICATE KEY UPDATE project_key = VALUES(project_key), issue_count = VALUES(issue_count), last_seen_at = VALUES(last_seen_at)
        `,
          )
          .bindParams(...params)
          .execute(),
      );
    }
    copied += rows.length;
  }
  return { copied };
}

// A restored project is counted live again, so its saved archived counts go. Only called with
// a list Jira actually returned -- never on a refused read, which would wipe everything.
export async function pruneRestoredArchivedUsage(scopeKey, archivedProjectIds = []) {
  await ensureProjectStoreReady();
  const ids = [...new Set(archivedProjectIds.map(String))];
  if (!ids.length) {
    await withSqlRetry(() =>
      sql.prepare("DELETE FROM field_archived_usage WHERE scope_key = ?").bindParams(scopeKey).execute(),
    );
    return;
  }
  const placeholders = ids.map(() => "?").join(", ");
  await withSqlRetry(() =>
    sql
      .prepare(`DELETE FROM field_archived_usage WHERE scope_key = ? AND project_id NOT IN (${placeholders})`)
      .bindParams(scopeKey, ...ids)
      .execute(),
  );
}

// Map<fieldId, [{ projectId, projectKey, issueCount, lastSeenAt }]>, for the given fields or all.
export async function loadArchivedFieldUsage(scopeKey, fieldIds = null) {
  await ensureProjectStoreReady();
  const out = new Map();
  const push = (rows) => {
    for (const r of rows || []) {
      const id = String(r.field_id);
      if (!out.has(id)) out.set(id, []);
      out
        .get(id)
        .push({
          projectId: String(r.project_id),
          projectKey: r.project_key || String(r.project_id),
          issueCount: toNumber(r.issue_count),
          lastSeenAt: r.last_seen_at || null,
        });
    }
  };
  if (fieldIds) {
    for (const batch of chunkArray([...new Set(fieldIds.map(String))], 100)) {
      if (!batch.length) continue;
      const placeholders = batch.map(() => "?").join(", ");
      // eslint-disable-next-line no-await-in-loop
      const result = await withSqlRetry(() =>
        sql
          .prepare(
            `
          SELECT field_id, project_id, project_key, issue_count, last_seen_at
          FROM field_archived_usage WHERE scope_key = ? AND field_id IN (${placeholders})
        `,
          )
          .bindParams(scopeKey, ...batch)
          .execute(),
      );
      push(result.rows);
    }
  } else {
    const result = await withSqlRetry(() =>
      sql
        .prepare(
          "SELECT field_id, project_id, project_key, issue_count, last_seen_at FROM field_archived_usage WHERE scope_key = ?",
        )
        .bindParams(scopeKey)
        .execute(),
    );
    push(result.rows);
  }
  return out;
}
