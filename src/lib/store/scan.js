// Universe and delta scan state -- meta, workers, buffers and promotion.
//
// Split out of project-store.js; imports only from core.js.

import { sql } from "@forge/sql";
import { fallbackOn } from "../logger.js";
import {
  chunkArray,
  ensureProjectStoreReady,
  safeParseJson,
  toNumber,
  withSqlRetry,
} from "./core.js";

export async function readIssueScanMeta(scopeKey) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT state, job_token, started_at, completed_at, total_pages, processed_pages,
               total_issues, processed_issues, last_error, progress_log, next_page_token, next_start_at,
               scan_history
        FROM issue_scan_meta
        WHERE scope_key = ?
        LIMIT 1
      `)
      .bindParams(scopeKey)
      .execute()
  );

  const row = result.rows?.[0];
  if (!row) return null;

  return {
    state: row.state || "idle",
    jobToken: row.job_token || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    totalPages: toNumber(row.total_pages),
    processedPages: toNumber(row.processed_pages),
    totalIssues: toNumber(row.total_issues),
    processedIssues: toNumber(row.processed_issues),
    lastError: row.last_error || null,
    progressLog: safeParseJson(row.progress_log, []),
    nextPageToken: row.next_page_token || null,
    nextStartAt: toNumber(row.next_start_at),
    scanHistory: safeParseJson(row.scan_history, []),
  };
}

export async function writeIssueScanMeta(scopeKey, patch) {
  await ensureProjectStoreReady();

  const current = await readIssueScanMeta(scopeKey);
  const next = {
    state: "idle",
    jobToken: null,
    startedAt: null,
    completedAt: null,
    totalPages: 0,
    processedPages: 0,
    totalIssues: 0,
    processedIssues: 0,
    lastError: null,
    progressLog: [],
    nextPageToken: null,
    nextStartAt: 0,
    scanHistory: [],
    ...(current || {}),
    ...patch,
  };

  const progressLogJson = Array.isArray(next.progressLog)
    ? JSON.stringify(next.progressLog)
    : (next.progressLog || null);
  const scanHistoryJson = Array.isArray(next.scanHistory)
    ? JSON.stringify(next.scanHistory)
    : (next.scanHistory || null);

  await withSqlRetry(() =>
    sql
      .prepare(`
        INSERT INTO issue_scan_meta (
          scope_key, state, job_token, started_at, completed_at,
           total_pages, processed_pages, total_issues, processed_issues, last_error, progress_log,
           next_page_token, next_start_at, scan_history
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          state = VALUES(state),
          job_token = VALUES(job_token),
          started_at = VALUES(started_at),
          completed_at = VALUES(completed_at),
          total_pages = VALUES(total_pages),
          processed_pages = VALUES(processed_pages),
          total_issues = VALUES(total_issues),
          processed_issues = VALUES(processed_issues),
          last_error = VALUES(last_error),
          progress_log = VALUES(progress_log),
          next_page_token = VALUES(next_page_token),
          next_start_at = VALUES(next_start_at),
          scan_history = VALUES(scan_history)
      `)
      .bindParams(
        scopeKey, next.state, next.jobToken, next.startedAt, next.completedAt,
        next.totalPages, next.processedPages, next.totalIssues, next.processedIssues,
        next.lastError, progressLogJson, next.nextPageToken || null, next.nextStartAt ?? 0,
        scanHistoryJson
      )
      .execute()
  );

  return next;
}

export async function clearIssueScanBuffer(scopeKey) {
  await ensureProjectStoreReady();

  await withSqlRetry(() =>
    sql
      .prepare("DELETE FROM issue_scan_buffer WHERE scope_key = ?")
      .bindParams(scopeKey)
      .execute()
  );

  // The activity histogram accumulates the same way the buffer does -- one row per project
  // per month, incremented as pages arrive -- so its staging buffer is cleared for the same
  // reason: left behind, a re-scan would add a second lifetime of issues on top of the first
  // and every rate derived from it would double.
  //
  // Only the buffer. The live issue_scan_project_activity table is left alone here and
  // rebuilt per project at finalization -- a crawl that dies partway must not be able to
  // destroy the last good series, which is exactly what wiping the live table up front did.
  await withSqlRetry(() =>
    sql
      .prepare("DELETE FROM issue_scan_activity_buffer WHERE scope_key = ?")
      .bindParams(scopeKey)
      .execute()
  );

  // The field x issue-type accumulator, cleared for the same reason: a re-scan on top of
  // last run's rows would add a second lifetime of issues to every count.
  await withSqlRetry(() =>
    sql
      .prepare("DELETE FROM issue_scan_type_buffer WHERE scope_key = ?")
      .bindParams(scopeKey)
      .execute()
  );

  // The field x user (user-picker value) accumulator -- same lifecycle, same reason.
  await withSqlRetry(() =>
    sql
      .prepare("DELETE FROM issue_scan_field_user_buffer WHERE scope_key = ?")
      .bindParams(scopeKey)
      .execute()
  );

  // The three additive counters. Same reason again: every one of them accumulates with
  // ON DUPLICATE KEY UPDATE ... + VALUES(), so a second scan over unswept rows would report
  // two lifetimes of issues as one.
  //
  // User activity is the exception that still belongs here. Its timestamp is a MAX and would
  // survive a re-scan correctly, but its issue_count is additive -- and an account that has
  // since been removed from every issue should stop appearing, which only a clear achieves.
  for (const table of ["issue_scan_type_totals", "issue_scan_estate_totals", "issue_scan_user_activity"]) {
    await withSqlRetry(() =>
      sql.prepare(`DELETE FROM ${table} WHERE scope_key = ?`).bindParams(scopeKey).execute()
    );
  }
}

export async function resetIssueScanWorkers(scopeKey) {
  await ensureProjectStoreReady();

  await withSqlRetry(() =>
    sql
      .prepare("DELETE FROM issue_scan_workers WHERE scope_key = ?")
      .bindParams(scopeKey)
      .execute()
  );
}

export async function replaceIssueScanWorkers(scopeKey, workers) {
  await ensureProjectStoreReady();
  await resetIssueScanWorkers(scopeKey);

  if (!workers.length) return;
  const now = new Date().toISOString();
  for (const batch of chunkArray(workers, 50)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((worker) => [
      scopeKey,
      worker.workerId,
      worker.status || "queued",
      worker.jqlFilter || null,
      worker.fieldIds ? JSON.stringify(worker.fieldIds) : null,
      worker.slices ? JSON.stringify(worker.slices) : null,
      worker.nextPageToken || null,
      worker.processedPages || 0,
      worker.processedIssues || 0,
      now,
      worker.lastError || null,
    ]);

    await withSqlRetry(() =>
      sql
        .prepare(`
          INSERT INTO issue_scan_workers (
            scope_key, worker_id, status, jql_filter, field_ids_json, slices_json, next_page_token,
            processed_pages, processed_issues, updated_at, last_error
          )
          VALUES ${valuesSql}
        `)
        .bindParams(...params)
        .execute()
    );
  }
}

export async function readIssueScanWorker(scopeKey, workerId) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT worker_id, status, jql_filter, field_ids_json, slices_json, next_page_token,
               processed_pages, processed_issues, updated_at, last_error
        FROM issue_scan_workers
        WHERE scope_key = ? AND worker_id = ?
        LIMIT 1
      `)
      .bindParams(scopeKey, workerId)
      .execute()
  );

  const row = result.rows?.[0];
  if (!row) return null;
  return {
    workerId: toNumber(row.worker_id),
    status: row.status || "queued",
    jqlFilter: row.jql_filter || null,
    fieldIds: safeParseJson(row.field_ids_json, null),
    slices: safeParseJson(row.slices_json, null),
    nextPageToken: row.next_page_token || null,
    processedPages: toNumber(row.processed_pages),
    processedIssues: toNumber(row.processed_issues),
    updatedAt: row.updated_at || null,
    lastError: row.last_error || null,
  };
}

export async function updateIssueScanWorker(scopeKey, workerId, patch) {
  await ensureProjectStoreReady();
  const current = await readIssueScanWorker(scopeKey, workerId);
  if (!current) return null;

  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  await withSqlRetry(() =>
    sql
      .prepare(`
        UPDATE issue_scan_workers
        SET status = ?,
            jql_filter = ?,
            field_ids_json = ?,
            slices_json = ?,
            next_page_token = ?,
            processed_pages = ?,
            processed_issues = ?,
            updated_at = ?,
            last_error = ?
        WHERE scope_key = ? AND worker_id = ?
      `)
      .bindParams(
        next.status || "queued",
        next.jqlFilter || null,
        next.fieldIds ? JSON.stringify(next.fieldIds) : null,
        next.slices ? JSON.stringify(next.slices) : null,
        next.nextPageToken || null,
        next.processedPages || 0,
        next.processedIssues || 0,
        next.updatedAt,
        next.lastError || null,
        scopeKey,
        workerId
      )
      .execute()
  );

  return next;
}

// One buffer row per project per month, with the exact first and last issue seen inside it.
//
// Writes land in issue_scan_activity_buffer, not the live table -- promoteIssueScanActivity
// moves them across when the scan finalizes. The boundaries are stored per month rather than
// per project so no second table is needed to date a project: the site's first issue is the
// first_created_at of a project's earliest month, and its last is the last_created_at of the
// latest. Month granularity alone would put a three-week-old project's age anywhere between
// one day and six weeks.
//
// LEAST and GREATEST over ISO-8601 strings, which sort lexicographically -- and guarded with
// COALESCE, because LEAST(NULL, x) is NULL in MySQL and the first flush for a month always
// meets a NULL.
export async function flushIssueScanActivity(scopeKey, projectMonths) {
  // projectMonths: Map<`${projectId}|${month}`, { projectId, month, count, first, last }>
  if (!projectMonths?.size) return;
  await ensureProjectStoreReady();

  const rows = [...projectMonths.values()];
  for (const batch of chunkArray(rows, 100)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((entry) => [
      scopeKey, entry.projectId, entry.month, entry.count, entry.first, entry.last,
    ]);

    await withSqlRetry(() =>
      sql
        .prepare(`
          INSERT INTO issue_scan_activity_buffer
            (scope_key, project_id, month, issue_count, first_created_at, last_created_at)
          VALUES ${valuesSql}
          ON DUPLICATE KEY UPDATE
            issue_count = issue_count + VALUES(issue_count),
            first_created_at = LEAST(COALESCE(first_created_at, VALUES(first_created_at)), VALUES(first_created_at)),
            last_created_at = GREATEST(COALESCE(last_created_at, VALUES(last_created_at)), VALUES(last_created_at))
        `)
        .bindParams(...params)
        .execute()
    );
  }
}

// Promote the crawl's month histogram from its buffer into the live table.
//
// Per project, never a global swap: a scan that only reached 50 of 200 projects must leave
// the other 150 projects' last-good series exactly as it found them. A project the crawl did
// cover is replaced wholesale -- delete its live rows, insert the buffer's -- because the
// buffer holds that project's complete recount for this run.
//
// Runs once, at finalization. An empty buffer promotes nothing rather than deleting
// everything: a crawl that counted no issues at all has nothing to say about any project.
export async function promoteIssueScanActivity(scopeKey) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT project_id, month, issue_count, first_created_at, last_created_at
        FROM issue_scan_activity_buffer
        WHERE scope_key = ?
      `)
      .bindParams(scopeKey)
      .execute()
  );

  const rows = result.rows || [];
  if (!rows.length) return { projectsPromoted: 0, rowsInserted: 0 };

  const projectIds = [...new Set(rows.map((row) => String(row.project_id)))];

  for (const batch of chunkArray(projectIds, 50)) {
    const placeholders = batch.map(() => "?").join(", ");
    await withSqlRetry(() =>
      sql
        .prepare(`DELETE FROM issue_scan_project_activity WHERE scope_key = ? AND project_id IN (${placeholders})`)
        .bindParams(scopeKey, ...batch)
        .execute()
    );
  }

  for (const batch of chunkArray(rows, 100)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((row) => [
      scopeKey, String(row.project_id), row.month, toNumber(row.issue_count),
      row.first_created_at, row.last_created_at,
    ]);
    await withSqlRetry(() =>
      sql
        .prepare(`
          INSERT INTO issue_scan_project_activity
            (scope_key, project_id, month, issue_count, first_created_at, last_created_at)
          VALUES ${valuesSql}
        `)
        .bindParams(...params)
        .execute()
    );
  }

  return { projectsPromoted: projectIds.length, rowsInserted: rows.length };
}

// Every project's activity, oldest month first.
//
// Returned whole rather than paged: the reference site has 200 projects averaging a few
// years, so this is a few thousand rows of three columns, and every consumer -- the rail's
// sort, the adoption panel, the health dimension -- needs the whole series to compute a rate
// against the site.
export async function loadProjectActivity(scopeKey) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT project_id, month, issue_count, first_created_at, last_created_at
      FROM issue_scan_project_activity
      WHERE scope_key = ?
      ORDER BY project_id ASC, month ASC
    `).bindParams(scopeKey).execute()
  );

  const byProject = new Map();
  for (const row of result.rows || []) {
    const projectId = String(row.project_id);
    if (!byProject.has(projectId)) {
      byProject.set(projectId, { projectId, months: [], firstIssueCreatedAt: null, lastIssueCreatedAt: null });
    }
    const entry = byProject.get(projectId);
    entry.months.push({ month: row.month, issueCount: toNumber(row.issue_count) });
    // Rows arrive oldest month first, so the first non-null lower bound is the project's
    // first issue and the last non-null upper bound is its most recent.
    if (row.first_created_at && !entry.firstIssueCreatedAt) entry.firstIssueCreatedAt = row.first_created_at;
    if (row.last_created_at) entry.lastIssueCreatedAt = row.last_created_at;
  }
  return byProject;
}

export async function flushIssueScanCounts(scopeKey, fieldProjectCounts, projectTotals) {
  // fieldProjectCounts: Map<fieldId, Map<projectId, { count, key, name }>>
  // projectTotals: Map<projectId, { count, key, name }>
  await ensureProjectStoreReady();

  const rows = [];

  for (const [fieldId, byProject] of fieldProjectCounts) {
    for (const [projectId, entry] of byProject) {
      rows.push([fieldId, projectId, entry.key, entry.name, entry.count]);
    }
  }

  for (const [projectId, entry] of projectTotals) {
    rows.push(["__PROJECT_TOTAL__", projectId, entry.key, entry.name, entry.count]);
  }

  if (!rows.length) return;

  // 150, not 50: this is the hottest write path in the app -- one call per worker chunk
  // on a site with thousands of field x project pairs -- and SQL *request count* is the
  // Forge quota that binds first, well before compute or storage. At 6 bound params per
  // row this is 900 per statement, comfortably inside the placeholder ceiling.
  for (const batch of chunkArray(rows, 150)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap(([fieldId, projectId, key, name, count]) => [
      scopeKey, fieldId, projectId, key, name, count,
    ]);

    await withSqlRetry(() =>
      sql
        .prepare(`
          INSERT INTO issue_scan_buffer (scope_key, field_id, project_id, project_key, project_name, issue_count)
          VALUES ${valuesSql}
          ON DUPLICATE KEY UPDATE issue_count = issue_count + VALUES(issue_count)
        `)
        .bindParams(...params)
        .execute()
    );
  }
}

// Stage field x issue-type counts from a crawl chunk.
// fieldTypeCounts: Map<fieldId, Map<issueTypeId, { count, name }>>
export async function flushIssueScanTypeCounts(scopeKey, fieldTypeCounts) {
  await ensureProjectStoreReady();

  const rows = [];
  for (const [fieldId, byType] of fieldTypeCounts) {
    for (const [issueTypeId, entry] of byType) {
      rows.push([fieldId, issueTypeId, entry.name || issueTypeId, entry.count]);
    }
  }
  if (!rows.length) return;

  // Same 150-row batch as flushIssueScanCounts, and the same reason: SQL request count is
  // the binding Forge quota, not row size. 4 bound params x 150 = 600 per statement.
  for (const batch of chunkArray(rows, 150)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap(([fieldId, typeId, typeName, count]) => [
      scopeKey, fieldId, typeId, typeName, count,
    ]);
    await withSqlRetry(() =>
      sql
        .prepare(`
          INSERT INTO issue_scan_type_buffer (scope_key, field_id, issue_type_id, issue_type_name, issue_count)
          VALUES ${valuesSql}
          ON DUPLICATE KEY UPDATE
            issue_type_name = VALUES(issue_type_name),
            issue_count = issue_count + VALUES(issue_count)
        `)
        .bindParams(...params)
        .execute()
    );
  }
}

// Promote field x issue-type counts from issue_scan_type_buffer into snapshot_field_type_usage
// for the version the field snapshot just built. Non-destructive per field, like
// promoteIssueScanToSnapshotProjectUsage: upsert this run's rows, then drop that field's
// stale rows. A field with no rows in the buffer is left alone unless the scan had full
// coverage -- then its usage is a confirmed zero and its rows for this version are cleared.
export async function promoteIssueScanFieldTypeUsage(scopeKey, version, { coverageComplete = false } = {}) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT field_id, issue_type_id, issue_type_name, issue_count
        FROM issue_scan_type_buffer
        WHERE scope_key = ?
        ORDER BY field_id, issue_count DESC
      `)
      .bindParams(scopeKey)
      .execute()
  );

  const bufferRows = result.rows || [];
  const byField = new Map();
  for (const row of bufferRows) {
    if (!byField.has(row.field_id)) byField.set(row.field_id, []);
    byField.get(row.field_id).push(row);
  }

  let fieldsPromoted = 0;
  let rowsInserted = 0;

  for (const [fieldId, fieldRows] of byField) {
    for (const batch of chunkArray(fieldRows, 100)) {
      const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
      const params = batch.flatMap((r) => [
        scopeKey, version, fieldId, String(r.issue_type_id), String(r.issue_type_name || r.issue_type_id), toNumber(r.issue_count),
      ]);
      await withSqlRetry(() =>
        sql
          .prepare(`
            INSERT INTO snapshot_field_type_usage
              (scope_key, version, field_id, issue_type_id, issue_type_name, issue_count)
            VALUES ${valuesSql}
            ON DUPLICATE KEY UPDATE
              issue_type_name = VALUES(issue_type_name),
              issue_count = VALUES(issue_count)
          `)
          .bindParams(...params)
          .execute()
      );
    }

    const keptTypeIds = fieldRows.map((r) => String(r.issue_type_id));
    const placeholders = keptTypeIds.map(() => "?").join(", ");
    await withSqlRetry(() =>
      sql
        .prepare(`
          DELETE FROM snapshot_field_type_usage
          WHERE scope_key = ? AND version = ? AND field_id = ?
            AND issue_type_id NOT IN (${placeholders})
        `)
        .bindParams(scopeKey, version, fieldId, ...keptTypeIds)
        .execute()
    );

    fieldsPromoted += 1;
    rowsInserted += fieldRows.length;
  }

  if (coverageComplete && byField.size) {
    // A field the crawl covered fully and never saw carrying a typed value has no type
    // usage -- clear whatever this version had for it.
    const crawled = Array.from(byField.keys());
    const placeholders = crawled.map(() => "?").join(", ");
    await withSqlRetry(() =>
      sql
        .prepare(`
          DELETE FROM snapshot_field_type_usage
          WHERE scope_key = ? AND version = ? AND field_id NOT IN (${placeholders})
        `)
        .bindParams(scopeKey, version, ...crawled)
        .execute()
    );
  }

  return { fieldsPromoted, rowsInserted };
}

// Every issue type a field carries a value on, for one version. Newest/biggest first.
export async function loadFieldTypeUsage(scopeKey, version, fieldId) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT issue_type_id, issue_type_name, issue_count
        FROM snapshot_field_type_usage
        WHERE scope_key = ? AND version = ? AND field_id = ?
        ORDER BY issue_count DESC, issue_type_name ASC
      `)
      .bindParams(scopeKey, version, String(fieldId))
      .execute()
  );

  return (result.rows || []).map((row) => ({
    issueTypeId: String(row.issue_type_id),
    issueTypeName: String(row.issue_type_name || row.issue_type_id),
    issueCount: toNumber(row.issue_count),
  }));
}

// ── Field x user (user-picker value) usage ───────────────────────────────────
// Carbon copy of the field x issue-type buffer/promote/load trio: the crawl stages
// per-field per-account counts, the finalize promotes them into the current version, and
// two reads serve the Field Browser (field -> people) and the People tab (person -> fields).

export async function flushIssueScanFieldUserCounts(scopeKey, fieldUserCounts) {
  await ensureProjectStoreReady();

  const rows = [];
  for (const [fieldId, byAccount] of fieldUserCounts) {
    for (const [accountId, entry] of byAccount) {
      rows.push([fieldId, accountId, entry.name || null, entry.count]);
    }
  }
  if (!rows.length) return;

  for (const batch of chunkArray(rows, 150)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap(([fieldId, accountId, name, count]) => [
      scopeKey, fieldId, accountId, name, count,
    ]);
    await withSqlRetry(() =>
      sql
        .prepare(`
          INSERT INTO issue_scan_field_user_buffer (scope_key, field_id, account_id, display_name, issue_count)
          VALUES ${valuesSql}
          ON DUPLICATE KEY UPDATE
            display_name = COALESCE(VALUES(display_name), display_name),
            issue_count = issue_count + VALUES(issue_count)
        `)
        .bindParams(...params)
        .execute()
    );
  }
}

export async function promoteIssueScanFieldUserUsage(scopeKey, version, { coverageComplete = false } = {}) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT field_id, account_id, display_name, issue_count
        FROM issue_scan_field_user_buffer
        WHERE scope_key = ?
        ORDER BY field_id, issue_count DESC
      `)
      .bindParams(scopeKey)
      .execute()
  );

  const byField = new Map();
  for (const row of result.rows || []) {
    if (!byField.has(row.field_id)) byField.set(row.field_id, []);
    byField.get(row.field_id).push(row);
  }

  let fieldsPromoted = 0;
  let rowsInserted = 0;

  for (const [fieldId, fieldRows] of byField) {
    for (const batch of chunkArray(fieldRows, 100)) {
      const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
      const params = batch.flatMap((r) => [
        scopeKey, version, fieldId, String(r.account_id), r.display_name ?? null, toNumber(r.issue_count),
      ]);
      await withSqlRetry(() =>
        sql
          .prepare(`
            INSERT INTO snapshot_field_user_usage
              (scope_key, version, field_id, account_id, display_name, issue_count)
            VALUES ${valuesSql}
            ON DUPLICATE KEY UPDATE
              display_name = COALESCE(VALUES(display_name), display_name),
              issue_count = VALUES(issue_count)
          `)
          .bindParams(...params)
          .execute()
      );
    }

    const keptAccounts = fieldRows.map((r) => String(r.account_id));
    const placeholders = keptAccounts.map(() => "?").join(", ");
    await withSqlRetry(() =>
      sql
        .prepare(`
          DELETE FROM snapshot_field_user_usage
          WHERE scope_key = ? AND version = ? AND field_id = ?
            AND account_id NOT IN (${placeholders})
        `)
        .bindParams(scopeKey, version, fieldId, ...keptAccounts)
        .execute()
    );

    fieldsPromoted += 1;
    rowsInserted += fieldRows.length;
  }

  if (coverageComplete && byField.size) {
    const crawled = Array.from(byField.keys());
    const placeholders = crawled.map(() => "?").join(", ");
    await withSqlRetry(() =>
      sql
        .prepare(`
          DELETE FROM snapshot_field_user_usage
          WHERE scope_key = ? AND version = ? AND field_id NOT IN (${placeholders})
        `)
        .bindParams(scopeKey, version, ...crawled)
        .execute()
    );
  }

  return { fieldsPromoted, rowsInserted };
}

// Field Browser: the people who hold a value in one field, biggest first, plus the
// distinct-account total the header needs.
export async function loadFieldUserUsage(scopeKey, version, fieldId, { limit = 25 } = {}) {
  await ensureProjectStoreReady();

  const [rows, total] = await Promise.all([
    withSqlRetry(() =>
      sql
        .prepare(`
          SELECT account_id, display_name, issue_count
          FROM snapshot_field_user_usage
          WHERE scope_key = ? AND version = ? AND field_id = ?
          ORDER BY issue_count DESC, account_id ASC
          LIMIT ${Number(limit) || 25}
        `)
        .bindParams(scopeKey, version, String(fieldId))
        .execute()
    ),
    withSqlRetry(() =>
      sql
        .prepare(`
          SELECT COUNT(*) AS distinct_users, COALESCE(SUM(issue_count), 0) AS issue_total
          FROM snapshot_field_user_usage
          WHERE scope_key = ? AND version = ? AND field_id = ?
        `)
        .bindParams(scopeKey, version, String(fieldId))
        .execute()
    ),
  ]);

  return {
    distinctUsers: toNumber(total.rows?.[0]?.distinct_users),
    issueTotal: toNumber(total.rows?.[0]?.issue_total),
    top: (rows.rows || []).map((row) => ({
      accountId: String(row.account_id),
      displayName: row.display_name || null,
      issueCount: toNumber(row.issue_count),
    })),
  };
}

// People tab: every user-picker field one account appears in, biggest first.
export async function loadUserFieldAppearances(scopeKey, version, accountId) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT field_id, issue_count
        FROM snapshot_field_user_usage
        WHERE scope_key = ? AND version = ? AND account_id = ?
        ORDER BY issue_count DESC, field_id ASC
      `)
      .bindParams(scopeKey, version, String(accountId))
      .execute()
  );

  return (result.rows || []).map((row) => ({
    fieldId: String(row.field_id),
    issueCount: toNumber(row.issue_count),
  }));
}

export async function finalizeIssueScan(scopeKey) {
  await ensureProjectStoreReady();
  const now = new Date().toISOString();

  const result = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT project_id, project_key, project_name, issue_count
        FROM issue_scan_buffer
        WHERE scope_key = ? AND field_id = '__PROJECT_TOTAL__'
      `)
      .bindParams(scopeKey)
      .execute()
  );

  const rows = result.rows || [];
  if (!rows.length) return;

  for (const batch of chunkArray(rows, 50)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((row) => [
      scopeKey, row.project_id, row.project_key, row.project_name,
      toNumber(row.issue_count), now,
    ]);

    await withSqlRetry(() =>
      sql
        .prepare(`
          INSERT INTO issue_scan_project_totals (
            scope_key, project_id, project_key, project_name, unique_issue_count, scanned_at
          )
          VALUES ${valuesSql}
          ON DUPLICATE KEY UPDATE
            project_key = VALUES(project_key),
            project_name = VALUES(project_name),
            unique_issue_count = VALUES(unique_issue_count),
            scanned_at = VALUES(scanned_at)
        `)
        .bindParams(...params)
        .execute()
    );
  }
}

// Upsert accurate field×project usage counts from a delta scan into snapshot_project_usage.
// Each row must have: { fieldId, projectId, projectKey, projectName, issueCount, jql }
// Uses ON DUPLICATE KEY UPDATE to overwrite counts — never deletes rows (delta can't know about removals).

// Promote field×project counts from issue_scan_buffer into snapshot_project_usage.
// This is intentionally non-destructive until a field's new rows have been written:
// 1. upsert new/changed rows for the field
// 2. delete stale rows for that same field that are absent from the completed scan
// 3. update active_project_count (and, when syncTotalIssueCount is true, total_issue_count) in snapshot_fields
// Existing cached usage for unrelated fields is never touched by the universe scan.
//
// syncTotalIssueCount should only be true when the scan covered every project (all
// workers finished "done") -- otherwise a field simply absent from this run's buffer is
// indistinguishable from "never crawled" and treating it as a confirmed zero would erase
// good data from a previous run.
export async function promoteIssueScanToSnapshotProjectUsage(scopeKey, version, { syncTotalIssueCount = false } = {}) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT field_id, project_id, project_key, project_name, issue_count
        FROM issue_scan_buffer
        WHERE scope_key = ? AND field_id <> '__PROJECT_TOTAL__'
        ORDER BY field_id, issue_count DESC
      `)
      .bindParams(scopeKey)
      .execute()
  );

  const bufferRows = result.rows || [];
  if (!bufferRows.length) return { fieldsPromoted: 0, rowsInserted: 0, touchedFieldIds: [] };

  // Group by field_id
  const byField = new Map();
  for (const row of bufferRows) {
    if (!byField.has(row.field_id)) byField.set(row.field_id, []);
    byField.get(row.field_id).push(row);
  }

  let fieldsPromoted = 0;
  let rowsInserted = 0;
  const touchedFieldIds = [];

  for (const [fieldId, fieldRows] of byField) {
    // Generate JQL for each row — same formula used everywhere else in the app
    const numericId = String(fieldId).match(/customfield_(\d+)/)?.[1];
    const fieldSelector = numericId ? `cf[${numericId}]` : fieldId;

    const usageRows = fieldRows.map((row) => {
      const safeKey = String(row.project_key || "").replace(/"/g, '\\"');
      return {
        projectId: String(row.project_id),
        projectKey: String(row.project_key),
        projectName: String(row.project_name || row.project_key || ""),
        issueCount: toNumber(row.issue_count),
        jql: `project = "${safeKey}" AND ${fieldSelector} is not EMPTY`,
      };
    });

    // Runs once per field at promote time, so on a 1,570-field site this loop's chunk
    // size is a direct multiplier on the scan's total SQL request count. 11 params per
    // row x 100 = 1,100 per statement.
    for (const batch of chunkArray(usageRows, 100)) {
      const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const params = batch.flatMap((r) => [
        scopeKey, version, fieldId, r.projectId, r.projectKey, r.projectName,
        r.issueCount, r.jql, null, null, null,
      ]);
      await withSqlRetry(() =>
        sql
          .prepare(`
            INSERT INTO snapshot_project_usage
              (scope_key, version, field_id, project_id, project_key, project_name,
                issue_count, jql, latest_field_change_at, latest_issue_key, latest_issue_updated_at)
            VALUES ${valuesSql}
            ON DUPLICATE KEY UPDATE
              project_key = VALUES(project_key),
              project_name = VALUES(project_name),
              issue_count = VALUES(issue_count),
              jql = VALUES(jql),
              latest_field_change_at = COALESCE(snapshot_project_usage.latest_field_change_at, VALUES(latest_field_change_at)),
              latest_issue_key = COALESCE(snapshot_project_usage.latest_issue_key, VALUES(latest_issue_key)),
              latest_issue_updated_at = COALESCE(snapshot_project_usage.latest_issue_updated_at, VALUES(latest_issue_updated_at))
          `)
          .bindParams(...params)
          .execute()
      );
    }

    const staleProjectIds = fieldRows.map((row) => String(row.project_id));
    if (staleProjectIds.length) {
      const placeholders = staleProjectIds.map(() => "?").join(", ");
      await withSqlRetry(() =>
        sql
          .prepare(`
            DELETE FROM snapshot_project_usage
            WHERE scope_key = ? AND version = ? AND field_id = ?
              AND project_id NOT IN (${placeholders})
          `)
          .bindParams(scopeKey, version, fieldId, ...staleProjectIds)
          .execute()
      );
    }

    // Keep active_project_count (and, once the scan has full coverage, total_issue_count)
    // in snapshot_fields in sync
    const totalIssueCount = usageRows.reduce((sum, r) => sum + r.issueCount, 0);
    if (syncTotalIssueCount) {
      await withSqlRetry(() =>
        sql
          .prepare("UPDATE snapshot_fields SET active_project_count = ?, total_issue_count = ? WHERE scope_key = ? AND version = ? AND field_id = ?")
          .bindParams(usageRows.length, totalIssueCount, scopeKey, version, fieldId)
          .execute()
      );
    } else {
      await withSqlRetry(() =>
        sql
          .prepare("UPDATE snapshot_fields SET active_project_count = ? WHERE scope_key = ? AND version = ? AND field_id = ?")
          .bindParams(usageRows.length, scopeKey, version, fieldId)
          .execute()
      );
    }

    touchedFieldIds.push(fieldId);
    fieldsPromoted += 1;
    rowsInserted += usageRows.length;
  }

  if (syncTotalIssueCount) {
    // Full scan coverage means a field with NO rows in issue_scan_buffer genuinely has
    // zero usage across every project — zero it out and drop its stale per-project rows.
    const crawledFieldIds = Array.from(byField.keys());
    const placeholders = crawledFieldIds.map(() => "?").join(", ");
    const absentResult = await withSqlRetry(() =>
      sql
        .prepare(`
          SELECT field_id FROM snapshot_fields
          WHERE scope_key = ? AND version = ? AND field_id NOT IN (${placeholders})
        `)
        .bindParams(scopeKey, version, ...crawledFieldIds)
        .execute()
    );
    const absentFieldIds = (absentResult.rows || []).map((row) => row.field_id);
    for (const fieldId of absentFieldIds) {
      await withSqlRetry(() =>
        sql
          .prepare("UPDATE snapshot_fields SET active_project_count = 0, total_issue_count = 0 WHERE scope_key = ? AND version = ? AND field_id = ?")
          .bindParams(scopeKey, version, fieldId)
          .execute()
      );
      await withSqlRetry(() =>
        sql
          .prepare("DELETE FROM snapshot_project_usage WHERE scope_key = ? AND version = ? AND field_id = ?")
          .bindParams(scopeKey, version, fieldId)
          .execute()
      );
      touchedFieldIds.push(fieldId);
    }
  }

  return { fieldsPromoted, rowsInserted, touchedFieldIds };
}

export async function loadIssueScanProjectTotals(scopeKey) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT project_id, project_key, project_name, unique_issue_count, scanned_at
        FROM issue_scan_project_totals
        WHERE scope_key = ?
        ORDER BY unique_issue_count DESC, project_key ASC
      `)
      .bindParams(scopeKey)
      .execute()
  );

  return (result.rows || []).map((row) => ({
    projectId: row.project_id,
    projectKey: row.project_key,
    projectName: row.project_name,
    uniqueIssueCount: toNumber(row.unique_issue_count),
    scannedAt: row.scanned_at || null,
  }));
}

// Atomically adds to processedPages and processedIssues without a read-modify-write race.
// Multiple concurrent project workers can call this safely.

// Atomically adds to processedPages and processedIssues without a read-modify-write race.
// Multiple concurrent project workers can call this safely.
export async function atomicAccumulateIssueScanProgress(scopeKey, pages, issues) {
  await withSqlRetry(() =>
    sql
      .prepare(`
        UPDATE issue_scan_meta
        SET processed_pages = processed_pages + ?,
            processed_issues = processed_issues + ?
        WHERE scope_key = ?
      `)
      .bindParams(pages, issues, scopeKey)
      .execute()
  );
  return readIssueScanMeta(scopeKey);
}

// Appends a single log entry to progress_log without touching numeric counters.
// Concurrent callers may occasionally overwrite each other's entry — acceptable for display-only data.

// Appends a single log entry to progress_log without touching numeric counters.
// Concurrent callers may occasionally overwrite each other's entry — acceptable for display-only data.
export async function appendIssueScanLogEntry(scopeKey, msg) {
  const meta = await readIssueScanMeta(scopeKey).catch(fallbackOn("store.scan_meta_read_failed", null, { scopeKey }));
  if (!meta) return;
  const log = Array.isArray(meta.progressLog) ? meta.progressLog : [];
  const updated = [...log, { t: new Date().toISOString(), msg }].slice(-100);
  await withSqlRetry(() =>
    sql
      .prepare(`UPDATE issue_scan_meta SET progress_log = ? WHERE scope_key = ?`)
      .bindParams(JSON.stringify(updated), scopeKey)
      .execute()
  );
}

// Atomically transitions state from 'building' → 'finalizing' and stamps job_token.
// Returns true only for the one worker that wins the transition.

// Atomically transitions state from 'building' → 'finalizing' and stamps job_token.
// Returns true only for the one worker that wins the transition.
export async function tryClaimIssueScanFinalization(scopeKey, claimToken) {
  await withSqlRetry(() =>
    sql
      .prepare(`
        UPDATE issue_scan_meta
        SET state = 'finalizing', job_token = ?
        WHERE scope_key = ? AND state = 'building'
          AND processed_pages >= total_pages AND total_pages > 0
      `)
      .bindParams(claimToken, scopeKey)
      .execute()
  );
  const meta = await readIssueScanMeta(scopeKey);
  return meta?.state === "finalizing" && meta?.jobToken === claimToken;
}

// Remove one slice's contribution to the count buffer.
//
// The buffer accumulates -- `issue_count = issue_count + VALUES(issue_count)` -- so a slice
// that re-crawls pages it already counted counts them twice, and the project ends up reporting
// more field values per issue than it has fields. Slices own disjoint sets of projects, so a
// slice's contribution is exactly the buffer rows for its project keys, and deleting them
// before a restart makes the recrawl idempotent.
//
// Keyed on project_key rather than project_id because the slice carries keys: that is what its
// JQL was built from, and the ids are not known until issues come back.
export async function clearIssueScanBufferForProjects(scopeKey, projectKeys = []) {
  await ensureProjectStoreReady();
  const keys = [...new Set(projectKeys.filter(Boolean).map(String))];
  if (!keys.length) return { cleared: 0 };

  for (const batch of chunkArray(keys, 50)) {
    const placeholders = batch.map(() => "?").join(", ");
    await withSqlRetry(() =>
      sql.prepare(`DELETE FROM issue_scan_buffer WHERE scope_key = ? AND project_key IN (${placeholders})`)
        .bindParams(scopeKey, ...batch).execute()
    );
  }
  return { cleared: keys.length };
}

// ── The three crawl counters ─────────────────────────────────────────────────
//
// All additive, all flushed from the same drain as the field counts. Workers run over
// disjoint project sets but a single issue type, priority or person is reached from many
// projects, and each worker flushes several times per run -- so rows accumulate across both
// dimensions rather than being replaced.

export async function flushIssueScanTypeTotals(scopeKey, typeTotals) {
  // typeTotals: Map<`issueTypeId|projectId`, { issueTypeId, issueTypeName, projectId, projectKey, count }>
  await ensureProjectStoreReady();
  const rows = [...typeTotals.values()].filter((r) => r?.issueTypeId && r?.projectId);
  if (!rows.length) return;

  for (const batch of chunkArray(rows, 100)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((r) => [
      scopeKey, r.issueTypeId, r.projectId, r.issueTypeName || null, r.projectKey || null, r.count,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO issue_scan_type_totals
          (scope_key, issue_type_id, project_id, issue_type_name, project_key, issue_count)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE issue_count = issue_count + VALUES(issue_count)
      `).bindParams(...params).execute()
    );
  }
}

export async function flushIssueScanEstateTotals(scopeKey, estateTotals) {
  // estateTotals: Map<`kind|valueId`, { kind, valueId, valueName, count }>
  // valueId is "" for an unset priority or resolution, which is a real answer.
  await ensureProjectStoreReady();
  const rows = [...estateTotals.values()].filter((r) => r?.kind);
  if (!rows.length) return;

  for (const batch of chunkArray(rows, 100)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((r) => [scopeKey, r.kind, r.valueId ?? "", r.valueName || null, r.count]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO issue_scan_estate_totals (scope_key, kind, value_id, value_name, issue_count)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE issue_count = issue_count + VALUES(issue_count)
      `).bindParams(...params).execute()
    );
  }
}

export async function flushIssueScanUserActivity(scopeKey, userActivity) {
  // userActivity: Map<accountId, { accountId, displayName, lastActivityAt, count }>
  await ensureProjectStoreReady();
  const rows = [...userActivity.values()].filter((r) => r?.accountId);
  if (!rows.length) return;

  for (const batch of chunkArray(rows, 100)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((r) => [
      scopeKey, r.accountId, r.displayName || null, r.lastActivityAt || null, r.count,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO issue_scan_user_activity
          (scope_key, account_id, display_name, last_activity_at, issue_count)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE
          -- GREATEST, not assignment: workers land out of order, so the newest timestamp has
          -- to win regardless of which flush arrives last. A row that only ever moves forward
          -- cannot be walked backwards by a late-arriving older page.
          last_activity_at = GREATEST(COALESCE(last_activity_at, ''), COALESCE(VALUES(last_activity_at), '')),
          display_name = COALESCE(VALUES(display_name), display_name),
          issue_count = issue_count + VALUES(issue_count)
      `).bindParams(...params).execute()
    );
  }
}

// Per-issue-type totals, folded across projects. The Issue Types tab's missing column.
export async function loadIssueTypeTotals(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT issue_type_id, MAX(issue_type_name) AS issue_type_name,
             SUM(issue_count) AS issue_count, COUNT(DISTINCT project_id) AS project_count
      FROM issue_scan_type_totals
      WHERE scope_key = ?
      GROUP BY issue_type_id
    `).bindParams(scopeKey).execute()
  );
  return (result.rows || []).map((row) => ({
    issueTypeId: String(row.issue_type_id),
    issueTypeName: row.issue_type_name || null,
    issueCount: toNumber(row.issue_count),
    projectCount: toNumber(row.project_count),
  }));
}

export async function loadEstateValueTotals(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT kind, value_id, value_name, issue_count
      FROM issue_scan_estate_totals
      WHERE scope_key = ?
    `).bindParams(scopeKey).execute()
  );
  return (result.rows || []).map((row) => ({
    kind: row.kind,
    valueId: String(row.value_id ?? ""),
    valueName: row.value_name || null,
    issueCount: toNumber(row.issue_count),
  }));
}

export async function loadUserActivity(scopeKey, accountIds = null) {
  await ensureProjectStoreReady();

  if (Array.isArray(accountIds) && accountIds.length === 0) return [];

  const out = [];
  const batches = Array.isArray(accountIds) ? chunkArray(accountIds, 200) : [null];

  for (const batch of batches) {
    const where = batch
      ? `scope_key = ? AND account_id IN (${batch.map(() => "?").join(", ")})`
      : "scope_key = ?";
    const params = batch ? [scopeKey, ...batch] : [scopeKey];
    const result = await withSqlRetry(() =>
      sql.prepare(`
        SELECT account_id, display_name, last_activity_at, issue_count
        FROM issue_scan_user_activity
        WHERE ${where}
      `).bindParams(...params).execute()
    );
    for (const row of result.rows || []) {
      out.push({
        accountId: String(row.account_id),
        displayName: row.display_name || null,
        // Empty string is what GREATEST leaves when nothing ever carried a timestamp. Null
        // is the honest shape for "no activity date known" -- not the epoch, and not today.
        lastActivityAt: row.last_activity_at || null,
        issueCount: toNumber(row.issue_count),
      });
    }
  }
  return out;
}
