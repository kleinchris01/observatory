// Field snapshots and per-project usage: the app's primary dataset.
//
// Split out of project-store.js; imports only from core.js.

import { sql } from "@forge/sql";
import {
  chunkArray,
  ensureProjectStoreReady,
  safeParseJson,
  toNumber,
  withSqlRetry,
} from "./core.js";

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

// Just the id -> name pairs for a given set of field ids. For drill-downs that arrive
// holding field ids (the People tab's "appears in these fields") and need labels without
// pulling the whole catalogue's LONGTEXT columns across the wire.
export async function loadSnapshotFieldNames(scopeKey, version, fieldIds = []) {
  await ensureProjectStoreReady();
  const ids = [...new Set(fieldIds.map(String))].filter(Boolean);
  if (!ids.length) return new Map();

  const out = new Map();
  for (const batch of chunkArray(ids, 100)) {
    const placeholders = batch.map(() => "?").join(", ");
    const result = await withSqlRetry(() =>
      sql
        .prepare(`
          SELECT field_id, name FROM snapshot_fields
          WHERE scope_key = ? AND version = ? AND field_id IN (${placeholders})
        `)
        .bindParams(scopeKey, version, ...batch)
        .execute()
    );
    for (const row of result.rows || []) out.set(String(row.field_id), row.name || String(row.field_id));
  }
  return out;
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

// Every populated field x project pair on the site, for the screen cross-signal.
//
// Only pairs that actually hold values: a row with issue_count 0 says the field was looked
// for in that project and not found, which the cross reads from the ABSENCE of a row here
// against the presence of one in the reachability map. Carrying the zeros would double the
// result set to say the same thing.
//
// Capped, and the cap is reported rather than silently applied. A finding derived from a
// truncated left side would understate the estate, and understating is the direction that
// gets acted on.
export async function loadPopulatedProjectUsage(scopeKey, version, { limit = 20000 } = {}) {
  await ensureProjectStoreReady();
  const safeLimit = Math.max(1, Math.min(50000, Math.trunc(Number(limit)) || 20000));

  const result = await withSqlRetry(() => sql
    .prepare(`
      SELECT field_id, project_id, project_key, project_name, issue_count
      FROM snapshot_project_usage
      WHERE scope_key = ? AND version = ? AND issue_count > 0
      ORDER BY issue_count DESC, field_id ASC
      LIMIT ${safeLimit + 1}
    `)
    .bindParams(scopeKey, version)
    .execute());

  const rows = result.rows || [];
  const truncated = rows.length > safeLimit;

  return {
    truncated,
    limit: safeLimit,
    rows: rows.slice(0, safeLimit).map((row) => ({
      fieldId: String(row.field_id),
      projectId: String(row.project_id),
      projectKey: row.project_key,
      projectName: row.project_name,
      issueCount: toNumber(row.issue_count),
    })),
  };
}

// Every populated field x project pair, as bare ids, read in full -- for form clutter.
//
// loadPopulatedProjectUsage above is capped and sorted by volume, which is right for
// invisible data (a truncated left side can only understate it) and exactly wrong for form
// clutter, which reads a MISSING pair as "never filled": every low-volume pair past the cap
// became a finding. So clutter gets its own read, keyset-paged to completion, carrying only
// the two ids it needs. The ceiling is a guard against a runaway loop, not a sampling cap;
// hitting it is reported, and the caller withholds the finding rather than guess.
export async function loadPopulatedFieldProjectPairs(scopeKey, version, { minIssues = 0, pageSize = 10000, ceiling = 500000 } = {}) {
  await ensureProjectStoreReady();
  const floor = Math.max(0, Math.trunc(Number(minIssues)) || 0);
  const size = Math.max(1, Math.min(20000, Math.trunc(Number(pageSize)) || 10000));

  const pairs = new Set();
  let lastField = "";
  let lastProject = "";
  for (;;) {
    const result = await withSqlRetry(() => sql
      .prepare(`
        SELECT field_id, project_id
        FROM snapshot_project_usage
        WHERE scope_key = ? AND version = ? AND issue_count > ?
          AND (field_id > ? OR (field_id = ? AND project_id > ?))
        ORDER BY field_id ASC, project_id ASC
        LIMIT ${size}
      `)
      .bindParams(scopeKey, version, floor, lastField, lastField, lastProject)
      .execute());

    const rows = result.rows || [];
    for (const row of rows) pairs.add(`${row.project_id}|${row.field_id}`);
    if (rows.length < size) return { pairs, complete: true };
    if (pairs.size >= ceiling) return { pairs, complete: false };
    const last = rows[rows.length - 1];
    lastField = String(last.field_id);
    lastProject = String(last.project_id);
  }
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
          sf.custom_type,
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
      customType: row.custom_type || "",
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

// TTL note: field option caches are overwritten on each scan but never explicitly expired.
// Consider adding a cached_at column and pruning entries older than 90 days if storage grows.

// TTL note: field option caches are overwritten on each scan but never explicitly expired.
// Consider adding a cached_at column and pruning entries older than 90 days if storage grows.
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

// Tables wiped by a full snapshot clear, in deletion order. The field snapshot and the
// issue-scan state go together deliberately: scan meta records the version it promoted
// into, so leaving it behind after wiping snapshot_fields produces a scan that believes
// it has already populated a version that no longer exists -- which is the exact
// corruption this operation exists to recover from.
//
// Deliberately NOT here:
//   saved_reports      user-authored definitions, not derived data -- clearing the
//                      snapshot must not destroy someone's saved work
//   workflow tables    separate pipeline, separately versioned, unaffected by field state
//   rqt_* tables       keyed by issue rather than snapshot version, so they stay valid
const SNAPSHOT_CLEAR_TABLES = [
  "snapshot_project_usage",
  "snapshot_fields",
  "field_summaries",
  "field_options_cache",
  "issue_scan_buffer",
  "issue_scan_workers",
  "issue_scan_project_totals",
  "issue_scan_meta",
  "report_jobs",
  "snapshot_meta",
];

// Wipe every derived field-snapshot table for one installation, returning per-table row
// counts so the caller can report exactly what was destroyed rather than claiming success
// blindly. snapshot_meta is deleted last: while it exists the UI still reports a state,
// so if this fails partway the app shows "ready" over incomplete data for as short a
// window as possible.

// Wipe every derived field-snapshot table for one installation, returning per-table row
// counts so the caller can report exactly what was destroyed rather than claiming success
// blindly. snapshot_meta is deleted last: while it exists the UI still reports a state,
// so if this fails partway the app shows "ready" over incomplete data for as short a
// window as possible.
export async function clearAllSnapshotData(scopeKey) {
  await ensureProjectStoreReady();

  const deleted = {};
  for (const table of SNAPSHOT_CLEAR_TABLES) {
    const result = await withSqlRetry(() =>
      sql.prepare(`DELETE FROM ${table} WHERE scope_key = ?`).bindParams(scopeKey).execute()
    );
    deleted[table] = toNumber(result?.rowsAffected, 0);
  }

  const totalRowsDeleted = Object.values(deleted).reduce((sum, n) => sum + n, 0);
  return { deleted, totalRowsDeleted };
}

// Copy all project-usage rows from any older snapshot version into the current version,
// preserving the historical per-field cache built up by individual field scans.
// INSERT IGNORE means rows already written for the new version (fresh per-field scans)
// are not overwritten — new data always wins.

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

// Restore snapshot_project_usage from field_summaries.active_projects_json (full replace per field).
// Called explicitly by the UI restore button. Overwrites existing rows for each field.
export async function restoreSnapshotProjectUsageFromSummaries(scopeKey, version) {
  return fillSnapshotProjectUsageFromSummaries(scopeKey, version, false);
}

// Fill missing snapshot_project_usage gaps from field_summaries (INSERT IGNORE — never overwrites).
// Safe to call unconditionally at snapshot completion to recover from data loss without touching fresh data.

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

// Re-sync snapshot_fields.active_project_count from the real per-project row counts in
// snapshot_project_usage. Every field record written during a rebuild (runSnapshot) starts
// with active_project_count hardcoded to 0 -- the carry-forward/fill steps above restore the
// underlying per-project rows for the new version but never touch that summary column, so
// without this it stays at 0 indefinitely for any field the *next* Universal Scan doesn't
// happen to also touch, even though its real usage data is sitting right there. Call this
// after both carry-forward steps have finished inserting rows for the version.

// Re-sync snapshot_fields.active_project_count from the real per-project row counts in
// snapshot_project_usage. Every field record written during a rebuild (runSnapshot) starts
// with active_project_count hardcoded to 0 -- the carry-forward/fill steps above restore the
// underlying per-project rows for the new version but never touch that summary column, so
// without this it stays at 0 indefinitely for any field the *next* Universal Scan doesn't
// happen to also touch, even though its real usage data is sitting right there. Call this
// after both carry-forward steps have finished inserting rows for the version.
export async function syncActiveProjectCountsFromUsage(scopeKey, version) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT field_id, COUNT(*) AS active_count
        FROM snapshot_project_usage
        WHERE scope_key = ? AND version = ?
        GROUP BY field_id
      `)
      .bindParams(scopeKey, version)
      .execute()
  );

  const rows = result.rows || [];
  for (const row of rows) {
    await withSqlRetry(() =>
      sql
        .prepare("UPDATE snapshot_fields SET active_project_count = ? WHERE scope_key = ? AND version = ? AND field_id = ?")
        .bindParams(toNumber(row.active_count), scopeKey, version, row.field_id)
        .execute()
    );
  }

  return { fieldsSynced: rows.length };
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

// How many field summaries sit in each state, without loading any of them.
//
// The Overview called listFieldSummaries(scopeKey, 5000) and used the result for exactly two
// things: a count grouped by status, and the total. That query selects field_json and
// progress_log -- both LONGTEXT -- so the landing page was pulling up to five thousand rows
// of blobs across the wire to produce six integers, on every visit.
//
// Same numbers, one row back. The shape is deliberately identical to what the caller built
// by hand so the substitution is provably behaviour-preserving: an unrecognised status still
// falls into `unbuilt`, because that is what the loop it replaces did.
export async function countFieldSummariesByStatus(scopeKey) {
  await ensureProjectStoreReady();

  const result = await withSqlRetry(() =>
    sql
      .prepare(`
        SELECT summary_status, COUNT(*) AS total
        FROM field_summaries
        WHERE scope_key = ?
        GROUP BY summary_status
      `)
      .bindParams(scopeKey)
      .execute()
  );

  const counts = { queued: 0, building: 0, ready: 0, failed: 0, cancelled: 0, unbuilt: 0 };
  let total = 0;
  for (const row of result.rows || []) {
    const state = row.summary_status || "unbuilt";
    const n = toNumber(row.total);
    total += n;
    if (state in counts) counts[state] += n;
    else counts.unbuilt += n;
  }
  return { counts, total };
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

// Batch-update field metadata (name/description/type/schema) for fields whose Jira
// definition changed since the snapshot version was last written — used by
// syncFieldCatalog's rename/retype detection. Never touches usage numbers or findings.

// Batch-update field metadata (name/description/type/schema) for fields whose Jira
// definition changed since the snapshot version was last written — used by
// syncFieldCatalog's rename/retype detection. Never touches usage numbers or findings.
export async function updateSnapshotFieldMetadata(scopeKey, version, fields) {
  await ensureProjectStoreReady();
  for (const field of fields) {
    await withSqlRetry(() =>
      sql
        .prepare(`
          UPDATE snapshot_fields
          SET name = ?, description = ?, type = ?, primitive_type = ?, custom_type = ?, searcher_key = ?
          WHERE scope_key = ? AND version = ? AND field_id = ?
        `)
        .bindParams(field.name, field.description, field.type, field.primitiveType, field.customType, field.searcherKey, scopeKey, version, field.id)
        .execute()
    );
  }
  return { updatedCount: fields.length };
}

// Batch-update governance findings (and flip usage_status to "ready") for fields whose
// usage numbers just changed — used by refreshGovernanceFindingsForFields after a
// Universal Scan promotes fresh totalIssueCount/activeProjectCount numbers.

// Batch-update governance findings (and flip usage_status to "ready") for fields whose
// usage numbers just changed — used by refreshGovernanceFindingsForFields after a
// Universal Scan promotes fresh totalIssueCount/activeProjectCount numbers.
export async function updateSnapshotFieldFindings(scopeKey, version, updates) {
  await ensureProjectStoreReady();
  for (const update of updates) {
    await withSqlRetry(() =>
      sql
        .prepare(`
          UPDATE snapshot_fields
          SET findings_json = ?, usage_status = 'ready', usage_status_detail = NULL
          WHERE scope_key = ? AND version = ? AND field_id = ?
        `)
        .bindParams(JSON.stringify(update.findings || null), scopeKey, version, update.id)
        .execute()
    );
  }
  return { updatedCount: updates.length };
}

// Roll per-project "last field change" timestamps up to one value per field, so the
// staleness governance rule can ask "when was this field last touched anywhere?" without
// loading every usage row. Fields with no recorded change date are simply absent from the
// returned map — see daysSince() in analysis.js for why absent must not mean "not stale".

// Roll per-project "last field change" timestamps up to one value per field, so the
// staleness governance rule can ask "when was this field last touched anywhere?" without
// loading every usage row. Fields with no recorded change date are simply absent from the
// returned map — see daysSince() in analysis.js for why absent must not mean "not stale".
export async function loadFieldLastChangeMap(scopeKey, version, fieldIds = null) {
  await ensureProjectStoreReady();

  const ids = Array.isArray(fieldIds) ? fieldIds.filter(Boolean).map(String) : null;
  if (ids && !ids.length) return new Map();

  const map = new Map();
  // Chunked so a large fieldIds list can't blow past the bind-parameter ceiling.
  const batches = ids ? chunkArray(ids, 100) : [null];

  for (const batch of batches) {
    const filterSql = batch ? ` AND field_id IN (${batch.map(() => "?").join(", ")})` : "";
    const params = batch ? [scopeKey, version, ...batch] : [scopeKey, version];
    const result = await withSqlRetry(() =>
      sql
        .prepare(`
          SELECT field_id, MAX(latest_field_change_at) AS last_change_at
          FROM snapshot_project_usage
          WHERE scope_key = ? AND version = ? AND latest_field_change_at IS NOT NULL${filterSql}
          GROUP BY field_id
        `)
        .bindParams(...params)
        .execute()
    );
    for (const row of result.rows || []) {
      if (row?.field_id && row?.last_change_at) map.set(String(row.field_id), String(row.last_change_at));
    }
  }

  return map;
}

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

export async function pruneOldSnapshotVersions(scopeKey, keepVersion) {
  await ensureProjectStoreReady();

  const fieldsResult = await withSqlRetry(() =>
    sql
      .prepare("DELETE FROM snapshot_fields WHERE scope_key = ? AND version != ?")
      .bindParams(scopeKey, keepVersion)
      .execute()
  );

  const usageResult = await withSqlRetry(() =>
    sql
      .prepare("DELETE FROM snapshot_project_usage WHERE scope_key = ? AND version != ?")
      .bindParams(scopeKey, keepVersion)
      .execute()
  );

  return {
    fieldsDeleted: toNumber(fieldsResult?.rowsAffected, 0),
    usageRowsDeleted: toNumber(usageResult?.rowsAffected, 0),
  };
}

// Write one audit row. Never throws: an audit failure must not become the reason a
// legitimate admin action fails, and must not become a way to block one either. Failures
// are surfaced to the structured log so a silently broken audit trail is still visible.

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
    withSqlRetry(() => sql.prepare("DELETE FROM snapshot_workflow_schemes WHERE scope_key = ?").bindParams(oldScopeKey).execute()),
    withSqlRetry(() => sql.prepare("DELETE FROM snapshot_workflow_scheme_projects WHERE scope_key = ?").bindParams(oldScopeKey).execute()),
    withSqlRetry(() => sql.prepare("DELETE FROM snapshot_statuses WHERE scope_key = ?").bindParams(oldScopeKey).execute()),
    withSqlRetry(() => sql.prepare("DELETE FROM workflow_snapshot_meta WHERE scope_key = ?").bindParams(oldScopeKey).execute()),
  ]);

  return { skipped: false, migratedUsage, migratedSummaries, migratedReports };
}

// ---------------------------------------------------------------------------
// Workflow scheme / status inventory (Workflow & Status Tracking, Phase 1)
// ---------------------------------------------------------------------------

// Full replace, mirroring replaceSnapshotFields: delete this scope's rows, then
// insert the fresh set. Workflow schemes/statuses are small site-wide catalogs
// (no resume/append path needed, unlike the custom-field snapshot).
