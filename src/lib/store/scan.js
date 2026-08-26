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
  // per month, incremented as pages arrive -- so it has to be cleared for the same reason.
  // Left behind, a re-scan would add a second lifetime of issues on top of the first and
  // every rate derived from it would double.
  await withSqlRetry(() =>
    sql
      .prepare("DELETE FROM issue_scan_project_activity WHERE scope_key = ?")
      .bindParams(scopeKey)
      .execute()
  );
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

// One row per project per month, with the exact first and last issue seen inside it.
//
// The boundaries are stored per month rather than per project so this table needs no second
// table beside it: the site's first issue is the first_created_at of a project's earliest
// month, and its last is the last_created_at of the latest. Month granularity alone would
// put a three-week-old project's age anywhere between one day and six weeks.
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
          INSERT INTO issue_scan_project_activity
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
