// Saved report definitions and async report jobs.
//
// Split out of project-store.js; imports only from core.js.

import { sql } from "@forge/sql";
import { ensureProjectStoreReady, safeParseJson, toNumber, withSqlRetry } from "./core.js";

export async function listSavedReports(scopeKey) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
        SELECT report_id, name, field_ids_json, created_at, updated_at
        FROM saved_reports
        WHERE scope_key = ?
        ORDER BY updated_at DESC, name ASC
      `,
      )
      .bindParams(scopeKey)
      .execute(),
  );

  return (result.rows || []).map((row) => ({
    reportId: row.report_id,
    name: row.name,
    fieldIds: safeParseJson(row.field_ids_json, []),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  }));
}

export async function saveSavedReport(scopeKey, report) {
  await ensureProjectStoreReady();

  const now = new Date().toISOString();
  await withSqlRetry(() =>
    sql
      .prepare(
        `
        INSERT INTO saved_reports (
          scope_key, report_id, name, field_ids_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          field_ids_json = VALUES(field_ids_json),
          updated_at = VALUES(updated_at)
      `,
      )
      .bindParams(
        scopeKey,
        report.reportId,
        report.name,
        JSON.stringify(report.fieldIds || []),
        report.createdAt || now,
        report.updatedAt || now,
      )
      .execute(),
  );
}

export async function deleteSavedReport(scopeKey, reportId) {
  await ensureProjectStoreReady();

  await withSqlRetry(() =>
    sql
      .prepare("DELETE FROM saved_reports WHERE scope_key = ? AND report_id = ?")
      .bindParams(scopeKey, reportId)
      .execute(),
  );
}

export async function replaceReportJob(scopeKey, jobId, job) {
  await ensureProjectStoreReady();

  await withSqlRetry(() =>
    sql
      .prepare(
        `
        INSERT INTO report_jobs (
          scope_key, job_id, report_name, status, field_ids_json, processed_fields, total_fields,
          next_offset, started_at, completed_at, refreshed_at, last_error, progress_log, result_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          report_name = VALUES(report_name),
          status = VALUES(status),
          field_ids_json = VALUES(field_ids_json),
          processed_fields = VALUES(processed_fields),
          total_fields = VALUES(total_fields),
          next_offset = VALUES(next_offset),
          started_at = VALUES(started_at),
          completed_at = VALUES(completed_at),
          refreshed_at = VALUES(refreshed_at),
          last_error = VALUES(last_error),
          progress_log = VALUES(progress_log),
          result_json = VALUES(result_json)
      `,
      )
      .bindParams(
        scopeKey,
        jobId,
        job.reportName || "Project Usage Report",
        job.status || "queued",
        JSON.stringify(job.fieldIds || []),
        job.processedFields ?? 0,
        job.totalFields ?? 0,
        job.nextOffset ?? 0,
        job.startedAt || null,
        job.completedAt || null,
        job.refreshedAt || new Date().toISOString(),
        job.lastError || null,
        JSON.stringify(job.progressLog || []),
        job.result ? JSON.stringify(job.result) : null,
      )
      .execute(),
  );
}

export async function loadReportJob(scopeKey, jobId) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
        SELECT
          job_id,
          report_name,
          status,
          field_ids_json,
          processed_fields,
          total_fields,
          next_offset,
          started_at,
          completed_at,
          refreshed_at,
          last_error,
          progress_log,
          result_json
        FROM report_jobs
        WHERE scope_key = ? AND job_id = ?
        LIMIT 1
      `,
      )
      .bindParams(scopeKey, jobId)
      .execute(),
  );

  const row = result.rows?.[0];
  if (!row) {
    return null;
  }

  return {
    jobId: row.job_id,
    reportName: row.report_name,
    status: row.status || "queued",
    fieldIds: safeParseJson(row.field_ids_json, []),
    processedFields: toNumber(row.processed_fields),
    totalFields: toNumber(row.total_fields),
    nextOffset: toNumber(row.next_offset),
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    refreshedAt: row.refreshed_at || null,
    lastError: row.last_error || null,
    progressLog: safeParseJson(row.progress_log, []),
    result: safeParseJson(row.result_json, null),
  };
}

export async function pruneStaleReportJobs(scopeKey, olderThanMs = 7 * 24 * 60 * 60 * 1000) {
  await ensureProjectStoreReady();

  const cutoffIso = new Date(Date.now() - olderThanMs).toISOString();

  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
        DELETE FROM report_jobs
        WHERE scope_key = ?
          AND completed_at IS NOT NULL
          AND completed_at < ?
      `,
      )
      .bindParams(scopeKey, cutoffIso)
      .execute(),
  );

  return { jobsDeleted: toNumber(result?.rowsAffected, 0) };
}
