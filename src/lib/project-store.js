import { sql, migrationRunner } from "@forge/sql";

const CREATE_SNAPSHOT_FIELDS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_fields (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    field_id VARCHAR(191) NOT NULL,
    name TEXT NOT NULL,
    description TEXT NULL,
    type VARCHAR(255) NULL,
    primitive_type VARCHAR(255) NULL,
    custom_type TEXT NULL,
    searcher_key TEXT NULL,
    usage_count BIGINT NOT NULL,
    configured_project_count BIGINT NOT NULL,
    total_issue_count BIGINT NOT NULL,
    active_project_count BIGINT NOT NULL,
    field_jql TEXT NULL,
    findings_json LONGTEXT NULL,
    PRIMARY KEY (scope_key, version, field_id)
  )
`;

const CREATE_FIELD_SUMMARIES_TABLE = `
  CREATE TABLE IF NOT EXISTS field_summaries (
    scope_key VARCHAR(191) NOT NULL,
    field_id VARCHAR(191) NOT NULL,
    refreshed_at VARCHAR(64) NOT NULL,
    field_json LONGTEXT NOT NULL,
    field_jql TEXT NULL,
    configured_project_count BIGINT NOT NULL,
    has_global_context TINYINT(1) NOT NULL,
    active_project_count BIGINT NOT NULL,
    total_issue_count BIGINT NOT NULL,
    active_projects_json LONGTEXT NOT NULL,
    contexts_json LONGTEXT NOT NULL,
    findings_json LONGTEXT NULL,
    summary_status VARCHAR(32) NOT NULL,
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    last_error TEXT NULL,
    progress_log LONGTEXT NULL,
    job_token VARCHAR(96) NULL,
    processed_issue_count BIGINT NOT NULL DEFAULT 0,
    estimated_issue_total BIGINT NOT NULL DEFAULT 0,
    next_start_at BIGINT NOT NULL DEFAULT 0,
    next_page_token TEXT NULL,
    PRIMARY KEY (scope_key, field_id)
  )
`;

const CREATE_SNAPSHOT_PROJECT_USAGE_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_project_usage (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    field_id VARCHAR(191) NOT NULL,
    project_id VARCHAR(191) NOT NULL,
    project_key VARCHAR(191) NOT NULL,
    project_name TEXT NOT NULL,
    issue_count BIGINT NOT NULL,
    jql TEXT NULL,
    latest_field_change_at VARCHAR(64) NULL,
    latest_issue_key VARCHAR(64) NULL,
    latest_issue_updated_at VARCHAR(64) NULL,
    PRIMARY KEY (scope_key, version, field_id, project_id)
  )
`;

const CREATE_SUMMARY_REFRESH_INDEX = `
  CREATE INDEX idx_field_summaries_scope_refresh
  ON field_summaries (scope_key, refreshed_at)
`;

const CREATE_SNAPSHOT_PROJECT_USAGE_INDEX = `
  CREATE INDEX idx_snapshot_project_usage_field
  ON snapshot_project_usage (scope_key, version, field_id, issue_count)
`;

const CREATE_SNAPSHOT_META_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_meta (
    scope_key VARCHAR(191) NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'idle',
    version VARCHAR(64) NULL,
    job_token VARCHAR(96) NULL,
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    refreshed_at VARCHAR(64) NULL,
    total_fields INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    PRIMARY KEY (scope_key)
  )
`;

const CREATE_SAVED_REPORTS_TABLE = `
  CREATE TABLE IF NOT EXISTS saved_reports (
    scope_key VARCHAR(191) NOT NULL,
    report_id VARCHAR(96) NOT NULL,
    name VARCHAR(255) NOT NULL,
    field_ids_json LONGTEXT NOT NULL,
    created_at VARCHAR(64) NOT NULL,
    updated_at VARCHAR(64) NOT NULL,
    PRIMARY KEY (scope_key, report_id)
  )
`;

const CREATE_REPORT_JOBS_TABLE = `
  CREATE TABLE IF NOT EXISTS report_jobs (
    scope_key VARCHAR(191) NOT NULL,
    job_id VARCHAR(96) NOT NULL,
    report_name VARCHAR(255) NOT NULL,
    status VARCHAR(32) NOT NULL,
    field_ids_json LONGTEXT NOT NULL,
    processed_fields BIGINT NOT NULL DEFAULT 0,
    total_fields BIGINT NOT NULL DEFAULT 0,
    next_offset BIGINT NOT NULL DEFAULT 0,
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    refreshed_at VARCHAR(64) NOT NULL,
    last_error TEXT NULL,
    progress_log LONGTEXT NULL,
    result_json LONGTEXT NULL,
    PRIMARY KEY (scope_key, job_id)
  )
`;

const CREATE_ISSUE_SCAN_META_TABLE = `
  CREATE TABLE IF NOT EXISTS issue_scan_meta (
    scope_key VARCHAR(191) NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'idle',
    job_token VARCHAR(96) NULL,
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    total_pages INTEGER NOT NULL DEFAULT 0,
    processed_pages INTEGER NOT NULL DEFAULT 0,
    total_issues BIGINT NOT NULL DEFAULT 0,
    processed_issues BIGINT NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    progress_log LONGTEXT NULL,
    next_start_at BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key)
  )
`;

const CREATE_ISSUE_SCAN_BUFFER_TABLE = `
  CREATE TABLE IF NOT EXISTS issue_scan_buffer (
    scope_key VARCHAR(191) NOT NULL,
    field_id VARCHAR(191) NOT NULL,
    project_id VARCHAR(191) NOT NULL,
    project_key VARCHAR(191) NOT NULL,
    project_name TEXT NOT NULL,
    issue_count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, field_id, project_id)
  )
`;

const CREATE_ISSUE_SCAN_PROJECT_TOTALS_TABLE = `
  CREATE TABLE IF NOT EXISTS issue_scan_project_totals (
    scope_key VARCHAR(191) NOT NULL,
    project_id VARCHAR(191) NOT NULL,
    project_key VARCHAR(191) NOT NULL,
    project_name TEXT NOT NULL,
    unique_issue_count BIGINT NOT NULL DEFAULT 0,
    scanned_at VARCHAR(64) NULL,
    PRIMARY KEY (scope_key, project_id)
  )
`;

const CREATE_ISSUE_SCAN_WORKERS_TABLE = `
  CREATE TABLE IF NOT EXISTS issue_scan_workers (
    scope_key VARCHAR(191) NOT NULL,
    worker_id INTEGER NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'queued',
    jql_filter LONGTEXT NULL,
    field_ids_json LONGTEXT NULL,
    next_page_token TEXT NULL,
    processed_pages BIGINT NOT NULL DEFAULT 0,
    processed_issues BIGINT NOT NULL DEFAULT 0,
    updated_at VARCHAR(64) NOT NULL,
    last_error TEXT NULL,
    PRIMARY KEY (scope_key, worker_id)
  )
`;

const CREATE_FIELD_OPTIONS_CACHE_TABLE = `
  CREATE TABLE IF NOT EXISTS field_options_cache (
    scope_key VARCHAR(191) NOT NULL,
    field_id VARCHAR(191) NOT NULL,
    context_id VARCHAR(191) NOT NULL,
    context_name TEXT NOT NULL,
    is_global_context TINYINT(1) NOT NULL DEFAULT 0,
    option_id VARCHAR(191) NOT NULL,
    option_value TEXT NOT NULL,
    disabled TINYINT(1) NOT NULL DEFAULT 0,
    refreshed_at VARCHAR(64) NOT NULL,
    PRIMARY KEY (scope_key, field_id, context_id, option_id)
  )
`;

const CREATE_RQT_FIELD_INDEX_TABLE = `
  CREATE TABLE IF NOT EXISTS rqt_field_index (
    scope_key VARCHAR(191) NOT NULL,
    field_id VARCHAR(191) NOT NULL,
    field_name TEXT NOT NULL,
    issue_count BIGINT NOT NULL DEFAULT 0,
    unique_value_count BIGINT NOT NULL DEFAULT 0,
    sample_values_json LONGTEXT NULL,
    refreshed_at VARCHAR(64) NULL,
    PRIMARY KEY (scope_key, field_id)
  )
`;

const CREATE_RQT_ISSUE_KEYS_TABLE = `
  CREATE TABLE IF NOT EXISTS rqt_issue_keys (
    scope_key VARCHAR(191) NOT NULL,
    project_key VARCHAR(64) NOT NULL,
    issue_type VARCHAR(128) NOT NULL DEFAULT '',
    issue_key VARCHAR(64) NOT NULL,
    PRIMARY KEY (scope_key, issue_key)
  )
`;

const CREATE_RQT_VALUE_ISSUE_INDEX_TABLE = `
  CREATE TABLE IF NOT EXISTS rqt_value_issue_index (
    scope_key VARCHAR(191) NOT NULL,
    rqt_value VARCHAR(64) NOT NULL,
    issue_key VARCHAR(64) NOT NULL,
    PRIMARY KEY (scope_key, rqt_value, issue_key)
  )
`;

const CREATE_RQT_FIELD_ISSUE_INDEX_TABLE = `
  CREATE TABLE IF NOT EXISTS rqt_field_issue_index (
    scope_key VARCHAR(191) NOT NULL,
    field_id VARCHAR(128) NOT NULL,
    issue_key VARCHAR(64) NOT NULL,
    PRIMARY KEY (scope_key, field_id, issue_key)
  )
`;

const projectStoreMigrations = migrationRunner
  .enqueue("v001_create_snapshot_fields_table", CREATE_SNAPSHOT_FIELDS_TABLE)
  .enqueue("v002_create_field_summaries_table", CREATE_FIELD_SUMMARIES_TABLE)
  .enqueue("v003_create_field_summaries_refresh_index", CREATE_SUMMARY_REFRESH_INDEX)
  .enqueue("v004_create_snapshot_project_usage_table", CREATE_SNAPSHOT_PROJECT_USAGE_TABLE)
  .enqueue("v005_create_snapshot_project_usage_index", CREATE_SNAPSHOT_PROJECT_USAGE_INDEX)
  .enqueue("v006_alter_snapshot_fields_add_fingerprint", "ALTER TABLE snapshot_fields ADD COLUMN project_usage_fingerprint VARCHAR(128) NULL")
  .enqueue("v007_create_snapshot_meta_table", CREATE_SNAPSHOT_META_TABLE)
  .enqueue("v008_alter_snapshot_fields_add_usage_status", "ALTER TABLE snapshot_fields ADD COLUMN usage_status VARCHAR(32) NOT NULL DEFAULT 'ready'")
  .enqueue("v009_alter_snapshot_fields_add_usage_status_detail", "ALTER TABLE snapshot_fields ADD COLUMN usage_status_detail TEXT NULL")
  .enqueue("v010_alter_snapshot_meta_add_job_token", "ALTER TABLE snapshot_meta ADD COLUMN job_token VARCHAR(96) NULL")
  .enqueue("v011_alter_snapshot_meta_add_processed_fields", "ALTER TABLE snapshot_meta ADD COLUMN processed_fields INTEGER NOT NULL DEFAULT 0")
  .enqueue("v012_alter_snapshot_meta_add_progress_log", "ALTER TABLE snapshot_meta ADD COLUMN progress_log LONGTEXT NULL")
  .enqueue("v013_alter_snapshot_meta_add_building_version", "ALTER TABLE snapshot_meta ADD COLUMN building_version VARCHAR(64) NULL")
  .enqueue("v014_alter_field_summaries_add_started_at", "ALTER TABLE field_summaries ADD COLUMN started_at VARCHAR(64) NULL")
  .enqueue("v015_alter_field_summaries_add_completed_at", "ALTER TABLE field_summaries ADD COLUMN completed_at VARCHAR(64) NULL")
  .enqueue("v016_alter_field_summaries_add_last_error", "ALTER TABLE field_summaries ADD COLUMN last_error TEXT NULL")
  .enqueue("v017_alter_field_summaries_add_progress_log", "ALTER TABLE field_summaries ADD COLUMN progress_log LONGTEXT NULL")
  .enqueue("v018_alter_field_summaries_add_job_token", "ALTER TABLE field_summaries ADD COLUMN job_token VARCHAR(96) NULL")
  .enqueue("v019_alter_field_summaries_add_processed_issue_count", "ALTER TABLE field_summaries ADD COLUMN processed_issue_count BIGINT NOT NULL DEFAULT 0")
  .enqueue("v020_alter_field_summaries_add_estimated_issue_total", "ALTER TABLE field_summaries ADD COLUMN estimated_issue_total BIGINT NOT NULL DEFAULT 0")
  .enqueue("v021_alter_field_summaries_add_next_start_at", "ALTER TABLE field_summaries ADD COLUMN next_start_at BIGINT NOT NULL DEFAULT 0")
  .enqueue("v022_alter_field_summaries_add_next_page_token", "ALTER TABLE field_summaries ADD COLUMN next_page_token TEXT NULL")
  .enqueue("v023_create_saved_reports_table", CREATE_SAVED_REPORTS_TABLE)
  .enqueue("v024_alter_snapshot_project_usage_add_latest_field_change_at", "ALTER TABLE snapshot_project_usage ADD COLUMN latest_field_change_at VARCHAR(64) NULL")
  .enqueue("v025_alter_snapshot_project_usage_add_latest_issue_key", "ALTER TABLE snapshot_project_usage ADD COLUMN latest_issue_key VARCHAR(64) NULL")
  .enqueue("v026_alter_snapshot_project_usage_add_latest_issue_updated_at", "ALTER TABLE snapshot_project_usage ADD COLUMN latest_issue_updated_at VARCHAR(64) NULL")
  .enqueue("v027_create_report_jobs_table", CREATE_REPORT_JOBS_TABLE)
  .enqueue("v028_create_issue_scan_meta_table", CREATE_ISSUE_SCAN_META_TABLE)
  .enqueue("v029_create_issue_scan_buffer_table", CREATE_ISSUE_SCAN_BUFFER_TABLE)
  .enqueue("v030_create_issue_scan_project_totals_table", CREATE_ISSUE_SCAN_PROJECT_TOTALS_TABLE)
  .enqueue("v031_alter_issue_scan_meta_add_next_page_token", "ALTER TABLE issue_scan_meta ADD COLUMN next_page_token TEXT NULL")
  .enqueue("v032_alter_issue_scan_meta_add_next_start_at", "ALTER TABLE issue_scan_meta ADD COLUMN IF NOT EXISTS next_start_at BIGINT NULL DEFAULT 0")
  .enqueue("v033_create_issue_scan_workers_table", CREATE_ISSUE_SCAN_WORKERS_TABLE)
  .enqueue("v034_create_field_options_cache_table", CREATE_FIELD_OPTIONS_CACHE_TABLE)
  .enqueue("v035_create_rqt_field_index_table", CREATE_RQT_FIELD_INDEX_TABLE)
  .enqueue("v036_create_rqt_issue_keys_table", CREATE_RQT_ISSUE_KEYS_TABLE)
  .enqueue("v037_create_rqt_value_issue_index_table", CREATE_RQT_VALUE_ISSUE_INDEX_TABLE)
  .enqueue("v038_create_rqt_field_issue_index_table", CREATE_RQT_FIELD_ISSUE_INDEX_TABLE);
  // v037 creates rqt_value_issue_index(scope_key, rqt_value, issue_key)
  // v038 creates rqt_field_issue_index(scope_key, field_id, issue_key)

let migrationPromise = null;

export function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function safeParseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function toNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

export function isSqlRateLimitError(error) {
  return error?.code === "RATE_LIMIT_EXCEEDED" || error?.responseDetails?.status === 429;
}

export async function withSqlRetry(operation) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isSqlRateLimitError(error) || attempt === 5) {
        throw error;
      }

      const delayMs = Math.min(8000, 250 * (2 ** attempt)) + Math.floor(Math.random() * 150);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function ensureProjectStoreReady() {
  if (!migrationPromise) {
    migrationPromise = projectStoreMigrations.run().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  return migrationPromise;
}

export async function replaceSnapshotFields(scopeKey, version, fields) {
  await ensureProjectStoreReady();

  await sql
    .prepare("DELETE FROM snapshot_fields WHERE scope_key = ?")
    .bindParams(scopeKey)
    .execute();

  for (const field of fields) {
    await sql
      .prepare(`
        INSERT INTO snapshot_fields (
          scope_key, version, field_id, name, description, type, primitive_type, custom_type,
          searcher_key, usage_count, configured_project_count, total_issue_count,
          active_project_count, usage_status, usage_status_detail, project_usage_fingerprint, field_jql, findings_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bindParams(
        scopeKey,
        version,
        field.id,
        field.name,
        field.description || "",
        field.type || null,
        field.primitiveType || null,
        field.customType || null,
        field.searcherKey || null,
        field.usageCount ?? field.configuredProjectCount ?? 0,
        field.configuredProjectCount ?? field.usageCount ?? 0,
        field.totalIssueCount ?? 0,
        field.activeProjectCount ?? 0,
        field.usageStatus || "ready",
        field.usageStatusDetail || null,
        field.projectUsageFingerprint || null,
        field.fieldJql || null,
        JSON.stringify(field.findings || null)
      )
      .execute();
  }
}

export async function appendSnapshotFields(scopeKey, version, fields) {
  await ensureProjectStoreReady();

  if (!fields.length) return;

  for (const batch of chunkArray(fields, 50)) {
    const valuesSql = batch
      .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .join(", ");
    const params = batch.flatMap((field) => ([
      scopeKey,
      version,
      field.id,
      field.name,
      field.description || "",
      field.type || null,
      field.primitiveType || null,
      field.customType || null,
      field.searcherKey || null,
      field.usageCount ?? field.configuredProjectCount ?? 0,
      field.configuredProjectCount ?? field.usageCount ?? 0,
      field.totalIssueCount ?? 0,
      field.activeProjectCount ?? 0,
      field.usageStatus || "ready",
      field.usageStatusDetail || null,
      field.projectUsageFingerprint || null,
      field.fieldJql || null,
      JSON.stringify(field.findings || null),
    ]));

    await withSqlRetry(() =>
      sql
        .prepare(`
          INSERT INTO snapshot_fields (
            scope_key, version, field_id, name, description, type, primitive_type, custom_type,
            searcher_key, usage_count, configured_project_count, total_issue_count,
            active_project_count, usage_status, usage_status_detail, project_usage_fingerprint, field_jql, findings_json
          )
          VALUES ${valuesSql}
        `)
        .bindParams(...params)
        .execute()
    );
  }
}

export async function loadSnapshotFields(scopeKey, version) {
  await ensureProjectStoreReady();

  const result = await sql
    .prepare(`
      SELECT
        field_id,
        name,
        description,
        type,
        primitive_type,
        custom_type,
        searcher_key,
        usage_count,
        configured_project_count,
        total_issue_count,
        active_project_count,
        usage_status,
        usage_status_detail,
        project_usage_fingerprint,
        field_jql,
        findings_json
      FROM snapshot_fields
      WHERE scope_key = ? AND version = ?
      ORDER BY LOWER(name) ASC, field_id ASC
    `)
    .bindParams(scopeKey, version)
    .execute();

  return (result.rows || []).map((row) => ({
    id: row.field_id,
    name: row.name,
    description: row.description || "",
    type: row.type || "unknown",
    primitiveType: row.primitive_type || null,
    customType: row.custom_type || null,
    searcherKey: row.searcher_key || null,
    usageCount: toNumber(row.usage_count),
    configuredProjectCount: toNumber(row.configured_project_count),
    totalIssueCount: toNumber(row.total_issue_count),
    activeProjectCount: toNumber(row.active_project_count),
    usageStatus: row.usage_status || "ready",
    usageStatusDetail: row.usage_status_detail || null,
    projectUsageFingerprint: row.project_usage_fingerprint || null,
    fieldJql: row.field_jql || null,
    findings: safeParseJson(row.findings_json, null),
  }));
}

export async function loadSnapshotField(scopeKey, version, fieldId) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() => sql
    .prepare(`
      SELECT
        field_id,
        name,
        description,
        type,
        primitive_type,
        custom_type,
        searcher_key,
        usage_count,
        configured_project_count,
        total_issue_count,
        active_project_count,
        usage_status,
        usage_status_detail,
        project_usage_fingerprint,
        field_jql,
        findings_json
      FROM snapshot_fields
      WHERE scope_key = ? AND version = ? AND field_id = ?
      LIMIT 1
    `)
    .bindParams(scopeKey, version, fieldId)
    .execute());

  const row = result.rows?.[0];
  if (!row) {
    return null;
  }

  return {
    id: row.field_id,
    name: row.name,
    description: row.description || "",
    type: row.type || "unknown",
    primitiveType: row.primitive_type || null,
    customType: row.custom_type || null,
    searcherKey: row.searcher_key || null,
    usageCount: toNumber(row.usage_count),
    configuredProjectCount: toNumber(row.configured_project_count),
    totalIssueCount: toNumber(row.total_issue_count),
    activeProjectCount: toNumber(row.active_project_count),
    usageStatus: row.usage_status || "ready",
    usageStatusDetail: row.usage_status_detail || null,
    projectUsageFingerprint: row.project_usage_fingerprint || null,
    fieldJql: row.field_jql || null,
    findings: safeParseJson(row.findings_json, null),
  };
}

export async function replaceSnapshotProjectUsage(scopeKey, version, rows) {
  await ensureProjectStoreReady();

  await sql
    .prepare("DELETE FROM snapshot_project_usage WHERE scope_key = ?")
    .bindParams(scopeKey)
    .execute();

  for (const row of rows) {
    await sql
      .prepare(`
        INSERT INTO snapshot_project_usage (
          scope_key, version, field_id, project_id, project_key, project_name, issue_count, jql,
          latest_field_change_at, latest_issue_key, latest_issue_updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bindParams(
        scopeKey,
        version,
        row.fieldId,
        row.projectId,
        row.projectKey,
        row.projectName,
        row.issueCount ?? 0,
        row.jql || null,
        row.latestFieldChangeAt || null,
        row.latestIssueKey || null,
        row.latestIssueUpdatedAt || null
      )
      .execute();
  }
}

export async function appendSnapshotProjectUsage(scopeKey, version, rows) {
  await ensureProjectStoreReady();

  if (!rows.length) return;

  for (const batch of chunkArray(rows, 100)) {
    const valuesSql = batch
      .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .join(", ");
    const params = batch.flatMap((row) => ([
      scopeKey,
      version,
      row.fieldId,
      row.projectId,
      row.projectKey,
      row.projectName,
      row.issueCount ?? 0,
      row.jql || null,
      row.latestFieldChangeAt || null,
      row.latestIssueKey || null,
      row.latestIssueUpdatedAt || null,
    ]));

    await sql
      .prepare(`
        INSERT INTO snapshot_project_usage (
          scope_key, version, field_id, project_id, project_key, project_name, issue_count, jql,
          latest_field_change_at, latest_issue_key, latest_issue_updated_at
        )
        VALUES ${valuesSql}
      `)
      .bindParams(...params)
      .execute();
  }
}

export async function copySnapshotField(scopeKey, fromVersion, toVersion, fieldId) {
  await ensureProjectStoreReady();

  await sql
    .prepare(`
      INSERT INTO snapshot_fields (
        scope_key, version, field_id, name, description, type, primitive_type, custom_type,
        searcher_key, usage_count, configured_project_count, total_issue_count,
        active_project_count, usage_status, usage_status_detail, project_usage_fingerprint, field_jql, findings_json
      )
      SELECT
        scope_key, ?, field_id, name, description, type, primitive_type, custom_type,
        searcher_key, usage_count, configured_project_count, total_issue_count,
        active_project_count, usage_status, usage_status_detail, project_usage_fingerprint, field_jql, findings_json
      FROM snapshot_fields
      WHERE scope_key = ? AND version = ? AND field_id = ?
    `)
    .bindParams(toVersion, scopeKey, fromVersion, fieldId)
    .execute();
}

export async function copySnapshotProjectUsage(scopeKey, fromVersion, toVersion, fieldId) {
  await ensureProjectStoreReady();

  await sql
    .prepare(`
      INSERT INTO snapshot_project_usage (
        scope_key, version, field_id, project_id, project_key, project_name, issue_count, jql,
        latest_field_change_at, latest_issue_key, latest_issue_updated_at
      )
      SELECT
        scope_key, ?, field_id, project_id, project_key, project_name, issue_count, jql,
        latest_field_change_at, latest_issue_key, latest_issue_updated_at
      FROM snapshot_project_usage
      WHERE scope_key = ? AND version = ? AND field_id = ?
    `)
    .bindParams(toVersion, scopeKey, fromVersion, fieldId)
    .execute();
}

export async function loadSnapshotProjectUsage(scopeKey, version, fieldId, limit = 50, offset = 0) {
  await ensureProjectStoreReady();

  const safeLimit = Math.max(1, Math.min(1000, Math.trunc(Number(limit)) || 50));
  const safeOffset = Math.max(0, Math.trunc(Number(offset)) || 0);

  const result = await sql
    .prepare(`
        SELECT
          project_id,
          project_key,
          project_name,
          issue_count,
          jql,
          latest_field_change_at,
          latest_issue_key,
          latest_issue_updated_at
      FROM snapshot_project_usage
      WHERE scope_key = ? AND version = ? AND field_id = ?
      ORDER BY issue_count DESC, project_key ASC
      LIMIT ${safeLimit} OFFSET ${safeOffset}
    `)
    .bindParams(scopeKey, version, fieldId)
    .execute();

  return (result.rows || []).map((row) => ({
    projectId: row.project_id,
    projectKey: row.project_key,
    projectName: row.project_name,
    issueCount: toNumber(row.issue_count),
    jql: row.jql || null,
    latestFieldChangeAt: row.latest_field_change_at || null,
    latestIssueKey: row.latest_issue_key || null,
    latestIssueUpdatedAt: row.latest_issue_updated_at || null,
  }));
}

export async function loadAllSnapshotProjectUsage(scopeKey, version, fieldId) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() => sql
    .prepare(`
        SELECT
          project_id,
          project_key,
          project_name,
          issue_count,
          jql,
          latest_field_change_at,
          latest_issue_key,
          latest_issue_updated_at
      FROM snapshot_project_usage
      WHERE scope_key = ? AND version = ? AND field_id = ?
      ORDER BY issue_count DESC, project_key ASC
    `)
    .bindParams(scopeKey, version, fieldId)
    .execute());

  return (result.rows || []).map((row) => ({
    projectId: row.project_id,
    projectKey: row.project_key,
    projectName: row.project_name,
    issueCount: toNumber(row.issue_count),
    jql: row.jql || null,
    latestFieldChangeAt: row.latest_field_change_at || null,
    latestIssueKey: row.latest_issue_key || null,
    latestIssueUpdatedAt: row.latest_issue_updated_at || null,
  }));
}

export async function loadAnySnapshotProjectUsage(scopeKey, fieldId) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() => sql
    .prepare(`
        SELECT
          project_id,
          project_key,
          project_name,
          issue_count,
          jql,
          latest_field_change_at,
          latest_issue_key,
          latest_issue_updated_at
      FROM snapshot_project_usage
      WHERE scope_key = ? AND field_id = ?
      ORDER BY issue_count DESC, project_key ASC
    `)
    .bindParams(scopeKey, fieldId)
    .execute());

  return (result.rows || []).map((row) => ({
    projectId: row.project_id,
    projectKey: row.project_key,
    projectName: row.project_name,
    issueCount: toNumber(row.issue_count),
    jql: row.jql || null,
    latestFieldChangeAt: row.latest_field_change_at || null,
    latestIssueKey: row.latest_issue_key || null,
    latestIssueUpdatedAt: row.latest_issue_updated_at || null,
  }));
}

export async function listSnapshotProjects(scopeKey, version, query = "") {
  await ensureProjectStoreReady();

  const normalizedQuery = String(query || "").trim();
  const whereClauses = ["scope_key = ?", "version = ?"];
  const params = [scopeKey, version];

  if (normalizedQuery) {
    whereClauses.push("(project_key LIKE ? OR project_name LIKE ?)");
    const likeValue = `%${normalizedQuery}%`;
    params.push(likeValue, likeValue);
  }

  const result = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT
          project_id,
          project_key,
          project_name,
          COUNT(*) AS field_count,
          SUM(issue_count) AS total_issue_count,
          MAX(latest_issue_updated_at) AS latest_issue_updated_at
        FROM snapshot_project_usage
        WHERE ${whereClauses.join(" AND ")}
        GROUP BY project_id, project_key, project_name
        ORDER BY total_issue_count DESC, project_key ASC
      `)
      .bindParams(...params)
      .execute()
  );

  return (result.rows || []).map((row) => ({
    projectId: row.project_id,
    projectKey: row.project_key,
    projectName: row.project_name,
    fieldCount: toNumber(row.field_count),
    totalIssueCount: toNumber(row.total_issue_count),
    latestIssueUpdatedAt: row.latest_issue_updated_at || null,
  }));
}

export async function loadSnapshotProjectFields(scopeKey, version, projectId, filters = {}) {
  await ensureProjectStoreReady();

  const safeLimit = Math.max(1, Math.min(200, Math.trunc(Number(filters.limit)) || 25));
  const safeOffset = Math.max(0, Math.trunc(Number(filters.offset)) || 0);
  const normalizedQuery = String(filters.query || "").trim();
  const normalizedType = String(filters.type || "all").trim() || "all";
  const normalizedSort = String(filters.sortBy || "issues-desc").trim() || "issues-desc";

  const whereClauses = ["pu.scope_key = ?", "pu.version = ?", "pu.project_id = ?"];
  const params = [scopeKey, version, projectId];

  if (normalizedQuery) {
    whereClauses.push("(sf.name LIKE ? OR sf.field_id LIKE ? OR sf.description LIKE ?)");
    const likeValue = `%${normalizedQuery}%`;
    params.push(likeValue, likeValue, likeValue);
  }

  if (normalizedType !== "all") {
    whereClauses.push("sf.type = ?");
    params.push(normalizedType);
  }

  let orderBy = "pu.issue_count DESC, sf.name ASC";
  if (normalizedSort === "issues-asc") {
    orderBy = "pu.issue_count ASC, sf.name ASC";
  } else if (normalizedSort === "name-asc") {
    orderBy = "sf.name ASC, pu.issue_count DESC";
  } else if (normalizedSort === "name-desc") {
    orderBy = "sf.name DESC, pu.issue_count DESC";
  } else if (normalizedSort === "updated-desc") {
    orderBy = "COALESCE(pu.latest_issue_updated_at, '') DESC, pu.issue_count DESC, sf.name ASC";
  } else if (normalizedSort === "updated-asc") {
    orderBy = "COALESCE(pu.latest_issue_updated_at, '9999-12-31T23:59:59.999Z') ASC, pu.issue_count DESC, sf.name ASC";
  }

  const countResult = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT COUNT(*) AS total
        FROM snapshot_project_usage pu
        LEFT JOIN snapshot_fields sf
          ON sf.scope_key = pu.scope_key
          AND sf.version = pu.version
          AND sf.field_id = pu.field_id
        WHERE ${whereClauses.join(" AND ")}
      `)
      .bindParams(...params)
      .execute()
  );

  const total = toNumber(countResult.rows?.[0]?.total, 0);

  const result = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT
          pu.field_id,
          pu.issue_count,
          pu.jql,
          pu.latest_field_change_at,
          pu.latest_issue_key,
          pu.latest_issue_updated_at,
          sf.name,
          sf.description,
          sf.type,
          sf.configured_project_count,
          sf.total_issue_count,
          sf.active_project_count,
          sf.findings_json
        FROM snapshot_project_usage pu
        LEFT JOIN snapshot_fields sf
          ON sf.scope_key = pu.scope_key
          AND sf.version = pu.version
          AND sf.field_id = pu.field_id
        WHERE ${whereClauses.join(" AND ")}
        ORDER BY ${orderBy}
        LIMIT ${safeLimit} OFFSET ${safeOffset}
      `)
      .bindParams(...params)
      .execute()
  );

  return {
    total,
    rows: (result.rows || []).map((row) => ({
      fieldId: row.field_id,
      fieldName: row.name || row.field_id,
      description: row.description || "",
      fieldType: row.type || "unknown",
      configuredProjectCount: toNumber(row.configured_project_count),
      totalIssueCount: toNumber(row.total_issue_count),
      activeProjectCount: toNumber(row.active_project_count),
      issueCount: toNumber(row.issue_count),
      jql: row.jql || null,
      latestFieldChangeAt: row.latest_field_change_at || null,
      latestIssueKey: row.latest_issue_key || null,
      latestIssueUpdatedAt: row.latest_issue_updated_at || null,
      findings: safeParseJson(row.findings_json, null),
    })),
  };
}

export async function countSnapshotProjectUsage(scopeKey, version, fieldId) {
  await ensureProjectStoreReady();

  const result = await sql
    .prepare(`
      SELECT COUNT(*) AS total
      FROM snapshot_project_usage
      WHERE scope_key = ? AND version = ? AND field_id = ?
    `)
    .bindParams(scopeKey, version, fieldId)
    .execute();

  return toNumber(result.rows?.[0]?.total, 0);
}

export async function loadSnapshotFieldIssueSums(scopeKey, version) {
  await ensureProjectStoreReady();

  const result = await sql
    .prepare(`
      SELECT field_id, SUM(issue_count) AS total_issue_count
      FROM snapshot_project_usage
      WHERE scope_key = ? AND version = ?
      GROUP BY field_id
    `)
    .bindParams(scopeKey, version)
    .execute();

  return new Map((result.rows || []).map((row) => [row.field_id, toNumber(row.total_issue_count)]));
}

export async function sumSnapshotFieldIssueCount(scopeKey, version, fieldId) {
  await ensureProjectStoreReady();

  const result = await sql
    .prepare(`
      SELECT SUM(issue_count) AS total_issue_count
      FROM snapshot_project_usage
      WHERE scope_key = ? AND version = ? AND field_id = ?
    `)
    .bindParams(scopeKey, version, fieldId)
    .execute();

  return toNumber(result.rows?.[0]?.total_issue_count, 0);
}

export async function getSnapshotProcessedFieldIds(scopeKey, version) {
  await ensureProjectStoreReady();

  const result = await sql
    .prepare("SELECT field_id FROM snapshot_fields WHERE scope_key = ? AND version = ?")
    .bindParams(scopeKey, version)
    .execute();

  return new Set((result.rows || []).map((row) => row.field_id));
}

export async function replaceFieldOptionsCache(scopeKey, fieldId, optionsByContext) {
  await ensureProjectStoreReady();
  const refreshedAt = new Date().toISOString();

  await withSqlRetry(() =>
    sql
      .prepare("DELETE FROM field_options_cache WHERE scope_key = ? AND field_id = ?")
      .bindParams(scopeKey, fieldId)
      .execute()
  );

  const rows = [];
  for (const ctx of optionsByContext || []) {
    for (const opt of ctx.options || []) {
      rows.push([
        String(ctx.contextId || ""),
        String(ctx.contextName || "Default context"),
        ctx.isGlobalContext ? 1 : 0,
        String(opt.id || ""),
        String(opt.value || ""),
        opt.disabled ? 1 : 0,
      ]);
    }
  }
  if (!rows.length) return { refreshedAt, optionCount: 0 };

  for (const batch of chunkArray(rows, 100)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap(([contextId, contextName, isGlobalContext, optionId, optionValue, disabled]) => [
      scopeKey,
      fieldId,
      contextId,
      contextName,
      isGlobalContext,
      optionId,
      optionValue,
      disabled,
      refreshedAt,
    ]);

    await withSqlRetry(() =>
      sql
        .prepare(`
          INSERT INTO field_options_cache (
            scope_key, field_id, context_id, context_name, is_global_context,
            option_id, option_value, disabled, refreshed_at
          )
          VALUES ${valuesSql}
        `)
        .bindParams(...params)
        .execute()
    );
  }

  return { refreshedAt, optionCount: rows.length };
}

export async function loadFieldOptionsCache(scopeKey, fieldId) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT context_id, context_name, is_global_context, option_id, option_value, disabled, refreshed_at
        FROM field_options_cache
        WHERE scope_key = ? AND field_id = ?
        ORDER BY context_name ASC, option_value ASC
      `)
      .bindParams(scopeKey, fieldId)
      .execute()
  );

  const byContext = new Map();
  let refreshedAt = null;
  for (const row of result.rows || []) {
    const contextId = String(row.context_id || "");
    if (!byContext.has(contextId)) {
      byContext.set(contextId, {
        contextId,
        contextName: String(row.context_name || "Default context"),
        isGlobalContext: Boolean(row.is_global_context),
        options: [],
      });
    }
    refreshedAt = row.refreshed_at || refreshedAt;
    byContext.get(contextId).options.push({
      id: String(row.option_id || ""),
      value: String(row.option_value || ""),
      disabled: Boolean(row.disabled),
    });
  }

  return {
    refreshedAt,
    optionsByContext: Array.from(byContext.values()),
  };
}

export async function searchFieldOptionsCache(scopeKey, optionQuery, limit = 200) {
  await ensureProjectStoreReady();
  const q = String(optionQuery || "").trim();
  if (!q) return [];
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
  const result = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT field_id, COUNT(*) AS match_count, MAX(refreshed_at) AS refreshed_at
        FROM field_options_cache
        WHERE scope_key = ? AND LOWER(option_value) LIKE ?
        GROUP BY field_id
        ORDER BY match_count DESC, field_id ASC
        LIMIT ${safeLimit}
      `)
      .bindParams(scopeKey, `%${q.toLowerCase()}%`)
      .execute()
  );

  return (result.rows || []).map((row) => ({
    fieldId: String(row.field_id || ""),
    matchCount: toNumber(row.match_count),
    refreshedAt: row.refreshed_at || null,
  }));
}

export async function clearSnapshotVersion(scopeKey, version) {
  await ensureProjectStoreReady();

  await sql
    .prepare("DELETE FROM snapshot_project_usage WHERE scope_key = ? AND version = ?")
    .bindParams(scopeKey, version)
    .execute();

  await sql
    .prepare("DELETE FROM snapshot_fields WHERE scope_key = ? AND version = ?")
    .bindParams(scopeKey, version)
    .execute();
}

export async function clearOtherSnapshotVersions(scopeKey, version) {
  await ensureProjectStoreReady();

  await sql
    .prepare("DELETE FROM snapshot_project_usage WHERE scope_key = ? AND version <> ?")
    .bindParams(scopeKey, version)
    .execute();

  await sql
    .prepare("DELETE FROM snapshot_fields WHERE scope_key = ? AND version <> ?")
    .bindParams(scopeKey, version)
    .execute();
}

// Copy all project-usage rows from any older snapshot version into the current version,
// preserving the historical per-field cache built up by individual field scans.
// INSERT IGNORE means rows already written for the new version (fresh per-field scans)
// are not overwritten — new data always wins.
export async function carryForwardSnapshotProjectUsage(scopeKey, newVersion) {
  await ensureProjectStoreReady();

  await withSqlRetry(() =>
    sql
      .prepare(`
        INSERT IGNORE INTO snapshot_project_usage
          (scope_key, version, field_id, project_id, project_key, project_name,
           issue_count, jql, latest_field_change_at, latest_issue_key, latest_issue_updated_at)
        SELECT
          scope_key, ?, field_id, project_id, project_key, project_name,
          issue_count, jql, latest_field_change_at, latest_issue_key, latest_issue_updated_at
        FROM snapshot_project_usage
        WHERE scope_key = ? AND version <> ?
      `)
      .bindParams(newVersion, scopeKey, newVersion)
      .execute()
  );
}

// Restore snapshot_project_usage from field_summaries.active_projects_json (full replace per field).
// Called explicitly by the UI restore button. Overwrites existing rows for each field.
export async function restoreSnapshotProjectUsageFromSummaries(scopeKey, version) {
  return fillSnapshotProjectUsageFromSummaries(scopeKey, version, false);
}

// Fill missing snapshot_project_usage gaps from field_summaries (INSERT IGNORE — never overwrites).
// Safe to call unconditionally at snapshot completion to recover from data loss without touching fresh data.
export async function fillSnapshotProjectUsageFromSummaries(scopeKey, version, ignoreExisting = true) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT field_id, active_projects_json, field_jql
        FROM field_summaries
        WHERE scope_key = ? AND summary_status = 'ready' AND active_project_count > 0
      `)
      .bindParams(scopeKey)
      .execute()
  );

  const summaryRows = result.rows || [];
  let fieldsRestored = 0;
  let rowsInserted = 0;

  for (const summaryRow of summaryRows) {
    const fieldId = summaryRow.field_id;
    const activeProjects = safeParseJson(summaryRow.active_projects_json, []);
    if (!Array.isArray(activeProjects) || !activeProjects.length) continue;

    const rows = activeProjects
      .filter((p) => p?.projectId && p?.projectKey)
      .map((p) => ({
        fieldId,
        projectId: String(p.projectId),
        projectKey: String(p.projectKey),
        projectName: String(p.projectName || p.projectKey || ""),
        issueCount: Number(p.issueCount ?? 0),
        jql: p.jql || summaryRow.field_jql || null,
        latestFieldChangeAt: p.latestFieldChangeAt || null,
        latestIssueKey: p.latestIssueKey || null,
        latestIssueUpdatedAt: p.latestIssueUpdatedAt || null,
      }));

    if (!rows.length) continue;

    if (!ignoreExisting) {
      await withSqlRetry(() =>
        sql
          .prepare("DELETE FROM snapshot_project_usage WHERE scope_key = ? AND version = ? AND field_id = ?")
          .bindParams(scopeKey, version, fieldId)
          .execute()
      );
    }

    for (const batch of chunkArray(rows, 50)) {
      const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const params = batch.flatMap((row) => [
        scopeKey, version, row.fieldId, row.projectId, row.projectKey, row.projectName,
        row.issueCount, row.jql, row.latestFieldChangeAt, row.latestIssueKey, row.latestIssueUpdatedAt,
      ]);

      const insertSql = ignoreExisting
        ? `INSERT IGNORE INTO snapshot_project_usage
              (scope_key, version, field_id, project_id, project_key, project_name,
               issue_count, jql, latest_field_change_at, latest_issue_key, latest_issue_updated_at)
            VALUES ${valuesSql}`
        : `INSERT INTO snapshot_project_usage
              (scope_key, version, field_id, project_id, project_key, project_name,
               issue_count, jql, latest_field_change_at, latest_issue_key, latest_issue_updated_at)
            VALUES ${valuesSql}`;

      await withSqlRetry(() =>
        sql
          .prepare(insertSql)
          .bindParams(...params)
          .execute()
      );
    }

    fieldsRestored += 1;
    rowsInserted += rows.length;
  }

  return { fieldsRestored, rowsInserted };
}

export async function replaceSnapshotField(scopeKey, version, field) {
  await ensureProjectStoreReady();

  await sql
    .prepare("DELETE FROM snapshot_fields WHERE scope_key = ? AND version = ? AND field_id = ?")
    .bindParams(scopeKey, version, field.id)
    .execute();

  await appendSnapshotFields(scopeKey, version, [field]);
}

export async function replaceSnapshotProjectUsageForField(scopeKey, version, fieldId, rows) {
  await ensureProjectStoreReady();

  await sql
    .prepare("DELETE FROM snapshot_project_usage WHERE scope_key = ? AND version = ? AND field_id = ?")
    .bindParams(scopeKey, version, fieldId)
    .execute();

  if (rows.length) {
    await appendSnapshotProjectUsage(scopeKey, version, rows.map((row) => ({
      fieldId,
      projectId: row.projectId,
      projectKey: row.projectKey,
      projectName: row.projectName,
      issueCount: row.issueCount,
      jql: row.jql || null,
    })));
  }
}

export async function replaceFieldSummary(scopeKey, fieldId, summary) {
  await ensureProjectStoreReady();

  await sql
    .prepare(`
      INSERT INTO field_summaries (
        scope_key, field_id, refreshed_at, field_json, field_jql, configured_project_count,
        has_global_context, active_project_count, total_issue_count, active_projects_json,
        contexts_json, findings_json, summary_status, started_at, completed_at, last_error, progress_log,
        job_token, processed_issue_count, estimated_issue_total, next_start_at, next_page_token
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        refreshed_at = VALUES(refreshed_at),
        field_json = VALUES(field_json),
        field_jql = VALUES(field_jql),
        configured_project_count = VALUES(configured_project_count),
        has_global_context = VALUES(has_global_context),
        active_project_count = VALUES(active_project_count),
        total_issue_count = VALUES(total_issue_count),
        active_projects_json = VALUES(active_projects_json),
        contexts_json = VALUES(contexts_json),
        findings_json = VALUES(findings_json),
        summary_status = VALUES(summary_status),
        started_at = VALUES(started_at),
        completed_at = VALUES(completed_at),
        last_error = VALUES(last_error),
        progress_log = VALUES(progress_log),
        job_token = VALUES(job_token),
        processed_issue_count = VALUES(processed_issue_count),
        estimated_issue_total = VALUES(estimated_issue_total),
        next_start_at = VALUES(next_start_at),
        next_page_token = VALUES(next_page_token)
    `)
    .bindParams(
      scopeKey,
      fieldId,
      summary.refreshedAt,
      JSON.stringify(summary.field),
      summary.fieldJql || null,
      summary.configuredProjectCount ?? 0,
      summary.hasGlobalContext ? 1 : 0,
      summary.activeProjectCount ?? 0,
      summary.totalIssueCount ?? 0,
      JSON.stringify(summary.activeProjects || []),
      JSON.stringify(summary.contexts || []),
      JSON.stringify(summary.findings || null),
      summary.summaryStatus || "ready",
      summary.startedAt || null,
      summary.completedAt || null,
      summary.lastError || null,
      JSON.stringify(summary.progressLog || []),
      summary.jobToken || null,
      summary.processedIssueCount ?? 0,
      summary.estimatedIssueTotal ?? 0,
      summary.nextStartAt ?? 0,
      summary.nextPageToken || null
    )
    .execute();
}

export async function loadFieldSummary(scopeKey, fieldId) {
  await ensureProjectStoreReady();

  const result = await sql
    .prepare(`
      SELECT
        refreshed_at,
        field_json,
        field_jql,
        configured_project_count,
        has_global_context,
        active_project_count,
        total_issue_count,
        active_projects_json,
        contexts_json,
        findings_json,
        summary_status,
        started_at,
        completed_at,
        last_error,
        progress_log,
        job_token,
        processed_issue_count,
        estimated_issue_total,
        next_start_at,
        next_page_token
      FROM field_summaries
      WHERE scope_key = ? AND field_id = ?
    `)
    .bindParams(scopeKey, fieldId)
    .execute();

  const row = result.rows?.[0];
  if (!row) {
    return null;
  }

  return {
    fieldId,
    refreshedAt: row.refreshed_at,
    field: safeParseJson(row.field_json, null),
    fieldJql: row.field_jql || null,
    configuredProjectCount: toNumber(row.configured_project_count),
    hasGlobalContext: Boolean(row.has_global_context),
    activeProjectCount: toNumber(row.active_project_count),
    totalIssueCount: toNumber(row.total_issue_count),
    activeProjects: safeParseJson(row.active_projects_json, []),
    contexts: safeParseJson(row.contexts_json, []),
    findings: safeParseJson(row.findings_json, null),
    summaryStatus: row.summary_status || "ready",
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    lastError: row.last_error || null,
    progressLog: safeParseJson(row.progress_log, []),
    jobToken: row.job_token || null,
    processedIssueCount: toNumber(row.processed_issue_count),
    estimatedIssueTotal: toNumber(row.estimated_issue_total),
    nextStartAt: toNumber(row.next_start_at),
    nextPageToken: row.next_page_token || null,
  };
}

export async function listFieldSummaries(scopeKey, limit = 200) {
  await ensureProjectStoreReady();

  const safeLimit = Math.max(1, Math.min(5000, Math.trunc(Number(limit)) || 200));
  const result = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT
          field_id,
          refreshed_at,
          field_json,
          configured_project_count,
          active_project_count,
          total_issue_count,
          summary_status,
          started_at,
          completed_at,
          last_error,
          progress_log,
          job_token,
          processed_issue_count,
          estimated_issue_total,
          next_start_at,
          next_page_token
        FROM field_summaries
        WHERE scope_key = ?
        ORDER BY
          CASE summary_status
            WHEN 'building' THEN 0
            WHEN 'queued' THEN 1
            WHEN 'failed' THEN 2
            ELSE 3
          END,
          COALESCE(started_at, refreshed_at) DESC
        LIMIT ${safeLimit}
      `)
      .bindParams(scopeKey)
      .execute()
  );

  return (result.rows || []).map((row) => ({
    fieldId: row.field_id,
    refreshedAt: row.refreshed_at || null,
    field: safeParseJson(row.field_json, null),
    configuredProjectCount: toNumber(row.configured_project_count),
    activeProjectCount: toNumber(row.active_project_count),
    totalIssueCount: toNumber(row.total_issue_count),
    summaryStatus: row.summary_status || "ready",
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    lastError: row.last_error || null,
    progressLog: safeParseJson(row.progress_log, []),
    jobToken: row.job_token || null,
    processedIssueCount: toNumber(row.processed_issue_count),
    estimatedIssueTotal: toNumber(row.estimated_issue_total),
    nextStartAt: toNumber(row.next_start_at),
    nextPageToken: row.next_page_token || null,
  }));
}

export async function listSavedReports(scopeKey) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT report_id, name, field_ids_json, created_at, updated_at
        FROM saved_reports
        WHERE scope_key = ?
        ORDER BY updated_at DESC, name ASC
      `)
      .bindParams(scopeKey)
      .execute()
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
      .prepare(`
        INSERT INTO saved_reports (
          scope_key, report_id, name, field_ids_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          field_ids_json = VALUES(field_ids_json),
          updated_at = VALUES(updated_at)
      `)
      .bindParams(
        scopeKey,
        report.reportId,
        report.name,
        JSON.stringify(report.fieldIds || []),
        report.createdAt || now,
        report.updatedAt || now
      )
      .execute()
  );
}

export async function deleteSavedReport(scopeKey, reportId) {
  await ensureProjectStoreReady();

  await withSqlRetry(() =>
    sql
      .prepare("DELETE FROM saved_reports WHERE scope_key = ? AND report_id = ?")
      .bindParams(scopeKey, reportId)
      .execute()
  );
}

export async function replaceReportJob(scopeKey, jobId, job) {
  await ensureProjectStoreReady();

  await withSqlRetry(() =>
    sql
      .prepare(`
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
      `)
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
        job.result ? JSON.stringify(job.result) : null
      )
      .execute()
  );
}

export async function loadReportJob(scopeKey, jobId) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() =>
    sql
      .prepare(`
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
      `)
      .bindParams(scopeKey, jobId)
      .execute()
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

export async function readSnapshotMeta(scopeKey) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() =>
    sql
      .prepare("SELECT state, version, building_version, job_token, started_at, completed_at, refreshed_at, total_fields, last_error, processed_fields, progress_log FROM snapshot_meta WHERE scope_key = ? LIMIT 1")
      .bindParams(scopeKey)
      .execute()
  );

  const row = result.rows?.[0];
  if (!row) return null;

  return {
    state: row.state || "idle",
    version: row.version || null,
    buildingVersion: row.building_version || null,
    jobToken: row.job_token || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    refreshedAt: row.refreshed_at || null,
    totalFields: toNumber(row.total_fields),
    lastError: row.last_error || null,
    processedFields: toNumber(row.processed_fields),
    progressLog: safeParseJson(row.progress_log, []),
  };
}

export async function readIssueScanMeta(scopeKey) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT state, job_token, started_at, completed_at, total_pages, processed_pages,
               total_issues, processed_issues, last_error, progress_log, next_page_token, next_start_at
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
    ...(current || {}),
    ...patch,
  };

  const progressLogJson = Array.isArray(next.progressLog)
    ? JSON.stringify(next.progressLog)
    : (next.progressLog || null);

  await withSqlRetry(() =>
    sql
      .prepare(`
        INSERT INTO issue_scan_meta (
          scope_key, state, job_token, started_at, completed_at,
           total_pages, processed_pages, total_issues, processed_issues, last_error, progress_log,
           next_page_token, next_start_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          next_start_at = VALUES(next_start_at)
      `)
      .bindParams(
        scopeKey, next.state, next.jobToken, next.startedAt, next.completedAt,
        next.totalPages, next.processedPages, next.totalIssues, next.processedIssues,
        next.lastError, progressLogJson, next.nextPageToken || null, next.nextStartAt ?? 0
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
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((worker) => [
      scopeKey,
      worker.workerId,
      worker.status || "queued",
      worker.jqlFilter || null,
      worker.fieldIds ? JSON.stringify(worker.fieldIds) : null,
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
            scope_key, worker_id, status, jql_filter, field_ids_json, next_page_token,
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
        SELECT worker_id, status, jql_filter, field_ids_json, next_page_token,
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

  for (const batch of chunkArray(rows, 50)) {
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

export async function upsertProjectTotalsForDelta(scopeKey, rows) {
  if (!rows.length) return;
  await ensureProjectStoreReady();
  const now = new Date().toISOString();
  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((r) => [scopeKey, r.projectId, r.projectKey, r.projectName, r.uniqueIssueCount, now]);
    await withSqlRetry(() =>
      sql
        .prepare(`
          INSERT INTO issue_scan_project_totals (scope_key, project_id, project_key, project_name, unique_issue_count, scanned_at)
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
export async function upsertDeltaFieldProjectUsage(scopeKey, version, rows) {
  if (!rows.length) return 0;
  await ensureProjectStoreReady();

  const BATCH = 50;
  let rowsInserted = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((r) => [
      scopeKey, version, r.fieldId, r.projectId, r.projectKey, r.projectName, r.issueCount, r.jql,
    ]);
    await withSqlRetry(() =>
      sql
        .prepare(`
          INSERT INTO snapshot_project_usage
            (scope_key, version, field_id, project_id, project_key, project_name, issue_count, jql)
          VALUES ${valuesSql}
          ON DUPLICATE KEY UPDATE
            project_key = VALUES(project_key),
            project_name = VALUES(project_name),
            issue_count = VALUES(issue_count),
            jql = VALUES(jql)
        `)
        .bindParams(...params)
        .execute()
    );
    rowsInserted += batch.length;
  }

  return rowsInserted;
}

// Promote field×project counts from issue_scan_buffer into snapshot_project_usage.
// This is intentionally non-destructive until a field's new rows have been written:
// 1. upsert new/changed rows for the field
// 2. delete stale rows for that same field that are absent from the completed scan
// 3. update active_project_count in snapshot_fields
// Existing cached usage for unrelated fields is never touched by the universe scan.
export async function promoteIssueScanToSnapshotProjectUsage(scopeKey, version) {
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
  if (!bufferRows.length) return { fieldsPromoted: 0, rowsInserted: 0 };

  // Group by field_id
  const byField = new Map();
  for (const row of bufferRows) {
    if (!byField.has(row.field_id)) byField.set(row.field_id, []);
    byField.get(row.field_id).push(row);
  }

  let fieldsPromoted = 0;
  let rowsInserted = 0;

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

    for (const batch of chunkArray(usageRows, 50)) {
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

    // Keep active_project_count in snapshot_fields in sync
    await withSqlRetry(() =>
      sql
        .prepare("UPDATE snapshot_fields SET active_project_count = ? WHERE scope_key = ? AND version = ? AND field_id = ?")
        .bindParams(usageRows.length, scopeKey, version, fieldId)
        .execute()
    );

    fieldsPromoted += 1;
    rowsInserted += usageRows.length;
  }

  return { fieldsPromoted, rowsInserted };
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
export async function appendIssueScanLogEntry(scopeKey, msg) {
  const meta = await readIssueScanMeta(scopeKey).catch(() => null);
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

export async function writeSnapshotMeta(scopeKey, patch) {
  await ensureProjectStoreReady();

  const current = await readSnapshotMeta(scopeKey);
  const next = {
    state: "idle",
    version: null,
    buildingVersion: null,
    jobToken: null,
    startedAt: null,
    completedAt: null,
    refreshedAt: null,
    totalFields: 0,
    lastError: null,
    processedFields: 0,
    progressLog: [],
    ...(current || {}),
    ...patch,
  };

  const progressLogJson = Array.isArray(next.progressLog)
    ? JSON.stringify(next.progressLog)
    : (next.progressLog || null);

  await withSqlRetry(() =>
    sql
      .prepare(`
        INSERT INTO snapshot_meta (scope_key, state, version, building_version, job_token, started_at, completed_at, refreshed_at, total_fields, last_error, processed_fields, progress_log)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          state = VALUES(state),
          version = VALUES(version),
          building_version = VALUES(building_version),
          job_token = VALUES(job_token),
          started_at = VALUES(started_at),
          completed_at = VALUES(completed_at),
          refreshed_at = VALUES(refreshed_at),
          total_fields = VALUES(total_fields),
          last_error = VALUES(last_error),
          processed_fields = VALUES(processed_fields),
          progress_log = VALUES(progress_log)
      `)
      .bindParams(scopeKey, next.state, next.version, next.buildingVersion, next.jobToken, next.startedAt, next.completedAt, next.refreshedAt, next.totalFields, next.lastError, next.processedFields, progressLogJson)
      .execute()
  );

  return next;
}

function deriveOldScopeKey(newScopeKey) {
  // normalized: "ari:cloud:::site_UUID" → old Confluence: "ari:cloud:confluence::site_UUID"
  const candidate = newScopeKey.replace("ari:cloud:::", "ari:cloud:confluence::");
  return candidate === newScopeKey ? null : candidate;
}

export async function countOldScopeKeyRows(newScopeKey) {
  await ensureProjectStoreReady();

  const oldScopeKey = deriveOldScopeKey(newScopeKey);
  if (!oldScopeKey) return 0;

  const [summaryResult, usageResult, metaResult] = await Promise.all([
    withSqlRetry(() =>
      sql.prepare("SELECT COUNT(*) AS cnt FROM field_summaries WHERE scope_key = ?")
        .bindParams(oldScopeKey).execute()
    ),
    withSqlRetry(() =>
      sql.prepare("SELECT COUNT(*) AS cnt FROM snapshot_project_usage WHERE scope_key = ?")
        .bindParams(oldScopeKey).execute()
    ),
    withSqlRetry(() =>
      sql.prepare("SELECT COUNT(*) AS cnt FROM snapshot_meta WHERE scope_key = ?")
        .bindParams(oldScopeKey).execute()
    ),
  ]);

  return (
    toNumber(summaryResult.rows?.[0]?.cnt, 0) +
    toNumber(usageResult.rows?.[0]?.cnt, 0) +
    toNumber(metaResult.rows?.[0]?.cnt, 0)
  );
}

export async function clearRqtFieldIndex(scopeKey) {
  await ensureProjectStoreReady();
  await withSqlRetry(() =>
    sql.prepare("DELETE FROM rqt_field_index WHERE scope_key = ?")
      .bindParams(scopeKey)
      .execute()
  );
}

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
      sql.prepare("SELECT sample_values_json, unique_value_count FROM rqt_field_index WHERE scope_key = ? AND field_id = ? LIMIT 1")
        .bindParams(scopeKey, fieldId)
        .execute()
    );
    const existingRow = existing.rows?.[0];
    const existingValues = safeParseJson(existingRow?.sample_values_json, []);
    const existingUniqueCount = toNumber(existingRow?.unique_value_count, 0);

    const merged = new Set([...existingValues, ...values]);
    const newUniqueCount = existingUniqueCount + values.size;
    const sampleValues = Array.from(merged).slice(0, MAX_SAMPLE_VALUES);

    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO rqt_field_index (scope_key, field_id, field_name, issue_count, unique_value_count, sample_values_json, refreshed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          field_name = VALUES(field_name),
          issue_count = issue_count + VALUES(issue_count),
          unique_value_count = VALUES(unique_value_count),
          sample_values_json = VALUES(sample_values_json),
          refreshed_at = VALUES(refreshed_at)
      `)
        .bindParams(scopeKey, fieldId, fieldName || fieldId, count, newUniqueCount, JSON.stringify(sampleValues), now)
        .execute()
    );
  }
}

export async function loadRqtFieldIndex(scopeKey) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT field_id, field_name, issue_count, unique_value_count, sample_values_json, refreshed_at
      FROM rqt_field_index
      WHERE scope_key = ?
      ORDER BY issue_count DESC, field_id ASC
    `)
      .bindParams(scopeKey)
      .execute()
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
    sql.prepare("DELETE FROM rqt_issue_keys WHERE scope_key = ?")
      .bindParams(scopeKey)
      .execute()
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
      scopeKey, projectKey, issueType || "", issueKey,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`INSERT IGNORE INTO rqt_issue_keys (scope_key, project_key, issue_type, issue_key) VALUES ${placeholders}`)
        .bindParams(...params)
        .execute()
    );
  }
}

export async function loadRqtIssueKeys(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT project_key, issue_type, issue_key
      FROM rqt_issue_keys
      WHERE scope_key = ?
      ORDER BY project_key ASC, issue_type ASC, issue_key ASC
    `)
      .bindParams(scopeKey)
      .execute()
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
    sql.prepare("DELETE FROM rqt_value_issue_index WHERE scope_key = ?")
      .bindParams(scopeKey)
      .execute()
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
      sql.prepare(`INSERT IGNORE INTO rqt_value_issue_index (scope_key, rqt_value, issue_key) VALUES ${placeholders}`)
        .bindParams(...params)
        .execute()
    );
  }
}

export async function loadRqtValueFrequency(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT rqt_value, COUNT(*) as cnt
      FROM rqt_value_issue_index
      WHERE scope_key = ?
      GROUP BY rqt_value
      ORDER BY cnt DESC
      LIMIT 100
    `)
      .bindParams(scopeKey)
      .execute()
  );
  return (result.rows || []).map((row) => ({ value: row.rqt_value, count: toNumber(row.cnt) }));
}

export async function searchRqtValueIssueKeys(scopeKey, rqtValue) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare("SELECT issue_key FROM rqt_value_issue_index WHERE scope_key = ? AND rqt_value = ?")
      .bindParams(scopeKey, rqtValue)
      .execute()
  );
  return (result.rows || []).map((row) => row.issue_key);
}

export async function loadIssueRqtValues(scopeKey) {
  const result = await withSqlRetry(() =>
    sql.prepare("SELECT issue_key, rqt_value FROM rqt_value_issue_index WHERE scope_key = ?")
      .bindParams(scopeKey).execute()
  );
  const map = {};
  for (const row of (result.rows || [])) {
    if (!map[row.issue_key]) map[row.issue_key] = [];
    map[row.issue_key].push(row.rqt_value);
  }
  return map;
}

export async function clearRqtFieldIssueIndex(scopeKey) {
  await withSqlRetry(() =>
    sql.prepare("DELETE FROM rqt_field_issue_index WHERE scope_key = ?")
      .bindParams(scopeKey).execute()
  );
}

export async function upsertRqtFieldIssueKeys(scopeKey, entries) {
  // entries: [{ fieldId, issueKey }]
  for (let i = 0; i < entries.length; i += 50) {
    const batch = entries.slice(i, i + 50);
    const placeholders = batch.map(() => "(?, ?, ?)").join(", ");
    const params = batch.flatMap(e => [scopeKey, e.fieldId, e.issueKey]);
    await withSqlRetry(() =>
      sql.prepare(`INSERT IGNORE INTO rqt_field_issue_index (scope_key, field_id, issue_key) VALUES ${placeholders}`)
        .bindParams(...params).execute()
    );
  }
}

export async function loadRqtFieldIssueIndex(scopeKey) {
  const result = await withSqlRetry(() =>
    sql.prepare("SELECT field_id, issue_key FROM rqt_field_issue_index WHERE scope_key = ?")
      .bindParams(scopeKey).execute()
  );
  const map = {};
  for (const row of (result.rows || [])) {
    if (!map[row.field_id]) map[row.field_id] = [];
    map[row.field_id].push(row.issue_key);
  }
  return map;
}

export async function migrateOldScopeKeys(newScopeKey) {
  await ensureProjectStoreReady();

  const oldScopeKey = deriveOldScopeKey(newScopeKey);
  if (!oldScopeKey) return { skipped: true, migratedSummaries: 0, migratedUsage: 0, migratedReports: 0 };

  // Resolve versions: old snapshot version (for project usage) and new snapshot version
  const [oldMetaResult, newMetaResult] = await Promise.all([
    withSqlRetry(() =>
      sql.prepare("SELECT version FROM snapshot_meta WHERE scope_key = ?")
        .bindParams(oldScopeKey).execute()
    ),
    withSqlRetry(() =>
      sql.prepare("SELECT version FROM snapshot_meta WHERE scope_key = ?")
        .bindParams(newScopeKey).execute()
    ),
  ]);
  const oldVersion = oldMetaResult.rows?.[0]?.version || null;
  const newVersion = newMetaResult.rows?.[0]?.version || null;

  // Migrate snapshot_project_usage (version-keyed: remap old version → new version)
  let migratedUsage = 0;
  if (oldVersion && newVersion) {
    const usageInsert = await withSqlRetry(() =>
      sql.prepare(`
        INSERT IGNORE INTO snapshot_project_usage
          (scope_key, version, field_id, project_id, project_key, project_name,
           issue_count, jql, latest_field_change_at, latest_issue_key, latest_issue_updated_at)
        SELECT
          ?, ?, field_id, project_id, project_key, project_name,
          issue_count, jql, latest_field_change_at, latest_issue_key, latest_issue_updated_at
        FROM snapshot_project_usage
        WHERE scope_key = ? AND version = ?
      `)
        .bindParams(newScopeKey, newVersion, oldScopeKey, oldVersion)
        .execute()
    );
    migratedUsage = toNumber(usageInsert?.rowsAffected, 0);
  }

  // Migrate field_summaries (not version-keyed)
  const summaryInsert = await withSqlRetry(() =>
    sql.prepare(`
      INSERT IGNORE INTO field_summaries
        (scope_key, field_id, refreshed_at, field_json, field_jql, configured_project_count,
         has_global_context, active_project_count, total_issue_count, active_projects_json,
         contexts_json, findings_json, summary_status, started_at, completed_at, last_error,
         progress_log, job_token, processed_issue_count, estimated_issue_total,
         next_start_at, next_page_token)
      SELECT
        ?, field_id, refreshed_at, field_json, field_jql, configured_project_count,
        has_global_context, active_project_count, total_issue_count, active_projects_json,
        contexts_json, findings_json, summary_status, started_at, completed_at, last_error,
        progress_log, job_token, processed_issue_count, estimated_issue_total,
        next_start_at, next_page_token
      FROM field_summaries
      WHERE scope_key = ?
    `)
      .bindParams(newScopeKey, oldScopeKey)
      .execute()
  );
  const migratedSummaries = toNumber(summaryInsert?.rowsAffected, 0);

  // Migrate saved_reports
  const reportInsert = await withSqlRetry(() =>
    sql.prepare(`
      INSERT IGNORE INTO saved_reports (scope_key, report_id, name, field_ids_json, created_at, updated_at)
      SELECT ?, report_id, name, field_ids_json, created_at, updated_at
      FROM saved_reports WHERE scope_key = ?
    `)
      .bindParams(newScopeKey, oldScopeKey)
      .execute()
  );
  const migratedReports = toNumber(reportInsert?.rowsAffected, 0);

  // Clean up all old-key rows across every table
  await Promise.all([
    withSqlRetry(() => sql.prepare("DELETE FROM field_summaries WHERE scope_key = ?").bindParams(oldScopeKey).execute()),
    withSqlRetry(() => sql.prepare("DELETE FROM saved_reports WHERE scope_key = ?").bindParams(oldScopeKey).execute()),
    withSqlRetry(() => sql.prepare("DELETE FROM snapshot_project_usage WHERE scope_key = ?").bindParams(oldScopeKey).execute()),
    withSqlRetry(() => sql.prepare("DELETE FROM snapshot_fields WHERE scope_key = ?").bindParams(oldScopeKey).execute()),
    withSqlRetry(() => sql.prepare("DELETE FROM snapshot_meta WHERE scope_key = ?").bindParams(oldScopeKey).execute()),
    withSqlRetry(() => sql.prepare("DELETE FROM issue_scan_meta WHERE scope_key = ?").bindParams(oldScopeKey).execute()),
    withSqlRetry(() => sql.prepare("DELETE FROM issue_scan_buffer WHERE scope_key = ?").bindParams(oldScopeKey).execute()),
    withSqlRetry(() => sql.prepare("DELETE FROM issue_scan_project_totals WHERE scope_key = ?").bindParams(oldScopeKey).execute()),
    withSqlRetry(() => sql.prepare("DELETE FROM issue_scan_workers WHERE scope_key = ?").bindParams(oldScopeKey).execute()),
    withSqlRetry(() => sql.prepare("DELETE FROM field_options_cache WHERE scope_key = ?").bindParams(oldScopeKey).execute()),
    withSqlRetry(() => sql.prepare("DELETE FROM rqt_field_index WHERE scope_key = ?").bindParams(oldScopeKey).execute()),
    withSqlRetry(() => sql.prepare("DELETE FROM rqt_issue_keys WHERE scope_key = ?").bindParams(oldScopeKey).execute()),
    withSqlRetry(() => sql.prepare("DELETE FROM rqt_value_issue_index WHERE scope_key = ?").bindParams(oldScopeKey).execute()),
    withSqlRetry(() => sql.prepare("DELETE FROM rqt_field_issue_index WHERE scope_key = ?").bindParams(oldScopeKey).execute()),
  ]);

  return { skipped: false, migratedUsage, migratedSummaries, migratedReports };
}
