// Storage for the Jira Service Management pillars. Imports only from core.js -- one arrow, no
// cycle. Full replace per scope: the build reads the whole JSM estate in one invocation under
// its own time budget, so it never appends to a partial version.
//
// Nothing here holds a person. Desks keep a customer COUNT; organizations keep their own name
// (a company, not a person) and a member COUNT.

import { sql } from "@forge/sql";
import { chunkArray, ensureProjectStoreReady, safeParseJson, toNumber, withSqlRetry } from "./core.js";

const BATCH = 50;
const nullableInt = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const nullableFlag = (v) => (v === null || v === undefined ? null : v ? 1 : 0);
const readInt = (v) => (v === null || v === undefined ? null : toNumber(v));

const TABLES = [
  "snapshot_jsm_desks",
  "snapshot_jsm_request_types",
  "snapshot_jsm_request_type_fields",
  "snapshot_jsm_queues",
  "snapshot_jsm_slas",
  "snapshot_jsm_organizations",
];

async function insertRows(table, columns, rows, toParams) {
  for (const b of chunkArray(rows, BATCH)) {
    const placeholder = `(${columns.map(() => "?").join(", ")})`;
    const valuesSql = b.map(() => placeholder).join(", ");
    await withSqlRetry(() =>
      sql
        .prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${valuesSql}`)
        .bindParams(...b.flatMap(toParams))
        .execute(),
    );
  }
}

export async function replaceJsmSnapshot(
  scopeKey,
  version,
  { desks = [], requestTypes = [], requestTypeFields = [], queues = [], slas = [], organizations = [] } = {},
) {
  await ensureProjectStoreReady();
  for (const table of TABLES) {
    await withSqlRetry(() => sql.prepare(`DELETE FROM ${table} WHERE scope_key = ?`).bindParams(scopeKey).execute());
  }

  await insertRows(
    "snapshot_jsm_desks",
    [
      "scope_key",
      "version",
      "desk_id",
      "project_id",
      "project_key",
      "project_name",
      "portal_group_count",
      "customer_count",
      "customers_complete",
      "org_count",
    ],
    desks,
    (d) => [
      scopeKey,
      version,
      String(d.deskId),
      d.projectId != null ? String(d.projectId) : null,
      d.projectKey || null,
      d.projectName || null,
      nullableInt(d.portalGroupCount),
      nullableInt(d.customerCount),
      nullableFlag(d.customersComplete),
      nullableInt(d.orgCount),
    ],
  );

  await insertRows(
    "snapshot_jsm_request_types",
    [
      "scope_key",
      "version",
      "desk_id",
      "request_type_id",
      "name",
      "has_description",
      "issue_type_id",
      "group_ids",
      "field_count",
      "required_field_count",
      "issue_count",
      "recent_count",
    ],
    requestTypes,
    (r) => [
      scopeKey,
      version,
      String(r.deskId),
      String(r.id),
      r.name || null,
      r.hasDescription ? 1 : 0,
      r.issueTypeId != null ? String(r.issueTypeId) : null,
      (r.groupIds || []).join(",").slice(0, 500) || null,
      nullableInt(r.fieldCount),
      nullableInt(r.requiredFieldCount),
      nullableInt(r.issueCount),
      nullableInt(r.recentCount),
    ],
  );

  await insertRows(
    "snapshot_jsm_request_type_fields",
    ["scope_key", "version", "desk_id", "request_type_id", "field_id", "label", "required"],
    requestTypeFields,
    (f) => [
      scopeKey,
      version,
      String(f.deskId),
      String(f.requestTypeId),
      String(f.fieldId),
      f.label ? String(f.label).slice(0, 255) : null,
      f.required ? 1 : 0,
    ],
  );

  await insertRows(
    "snapshot_jsm_queues",
    ["scope_key", "version", "desk_id", "queue_id", "name", "jql", "issue_count", "broken_refs"],
    queues,
    (q) => [
      scopeKey,
      version,
      String(q.deskId),
      String(q.id),
      q.name || null,
      q.jql || null,
      nullableInt(q.issueCount),
      // null = not checked (catalog unread); "" = checked, nothing broken.
      Array.isArray(q.brokenRefs) ? q.brokenRefs.join(",").slice(0, 500) : null,
    ],
  );

  await insertRows(
    "snapshot_jsm_slas",
    ["scope_key", "version", "desk_id", "field_id", "field_name", "active_count", "breached_count"],
    slas,
    (s) => [
      scopeKey,
      version,
      String(s.deskId),
      String(s.fieldId),
      s.fieldName || null,
      nullableInt(s.activeCount),
      nullableInt(s.breachedCount),
    ],
  );

  await insertRows(
    "snapshot_jsm_organizations",
    ["scope_key", "version", "org_id", "name", "member_count", "members_complete", "desk_count"],
    organizations,
    (o) => [
      scopeKey,
      version,
      String(o.id),
      o.name || null,
      nullableInt(o.memberCount),
      nullableFlag(o.membersComplete),
      nullableInt(o.deskCount),
    ],
  );
}

async function select(query, ...params) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(query)
      .bindParams(...params)
      .execute(),
  );
  return result.rows || [];
}

export async function loadJsmDesks(scopeKey, version) {
  const rows = await select(
    `SELECT desk_id, project_id, project_key, project_name, portal_group_count, customer_count,
            customers_complete, org_count
     FROM snapshot_jsm_desks WHERE scope_key = ? AND version = ? ORDER BY project_key ASC`,
    scopeKey,
    version,
  );
  return rows.map((r) => ({
    deskId: String(r.desk_id),
    projectId: r.project_id || null,
    projectKey: r.project_key || null,
    projectName: r.project_name || null,
    portalGroupCount: readInt(r.portal_group_count),
    customerCount: readInt(r.customer_count),
    customersComplete:
      r.customers_complete === null || r.customers_complete === undefined
        ? null
        : Boolean(toNumber(r.customers_complete)),
    orgCount: readInt(r.org_count),
  }));
}

export async function loadJsmRequestTypes(scopeKey, version) {
  const rows = await select(
    `SELECT desk_id, request_type_id, name, has_description, issue_type_id, group_ids, field_count,
            required_field_count, issue_count, recent_count
     FROM snapshot_jsm_request_types WHERE scope_key = ? AND version = ? ORDER BY desk_id ASC, name ASC`,
    scopeKey,
    version,
  );
  return rows.map((r) => ({
    deskId: String(r.desk_id),
    id: String(r.request_type_id),
    name: r.name || String(r.request_type_id),
    hasDescription: Boolean(toNumber(r.has_description)),
    issueTypeId: r.issue_type_id || null,
    groupIds: r.group_ids ? String(r.group_ids).split(",").filter(Boolean) : [],
    fieldCount: readInt(r.field_count),
    requiredFieldCount: readInt(r.required_field_count),
    issueCount: readInt(r.issue_count),
    recentCount: readInt(r.recent_count),
  }));
}

export async function loadJsmRequestTypeFields(scopeKey, version, { fieldId = null } = {}) {
  const rows = fieldId
    ? await select(
        `SELECT desk_id, request_type_id, field_id, label, required FROM snapshot_jsm_request_type_fields
         WHERE scope_key = ? AND version = ? AND field_id = ?`,
        scopeKey,
        version,
        String(fieldId),
      )
    : await select(
        `SELECT desk_id, request_type_id, field_id, label, required FROM snapshot_jsm_request_type_fields
         WHERE scope_key = ? AND version = ?`,
        scopeKey,
        version,
      );
  return rows.map((r) => ({
    deskId: String(r.desk_id),
    requestTypeId: String(r.request_type_id),
    fieldId: String(r.field_id),
    label: r.label || null,
    required: Boolean(toNumber(r.required)),
  }));
}

export async function loadJsmQueues(scopeKey, version) {
  const rows = await select(
    `SELECT desk_id, queue_id, name, jql, issue_count, broken_refs
     FROM snapshot_jsm_queues WHERE scope_key = ? AND version = ? ORDER BY desk_id ASC, name ASC`,
    scopeKey,
    version,
  );
  return rows.map((r) => ({
    deskId: String(r.desk_id),
    id: String(r.queue_id),
    name: r.name || String(r.queue_id),
    jql: r.jql || "",
    issueCount: readInt(r.issue_count),
    brokenRefs:
      r.broken_refs === null || r.broken_refs === undefined ? null : String(r.broken_refs).split(",").filter(Boolean),
  }));
}

export async function loadJsmSlas(scopeKey, version) {
  const rows = await select(
    `SELECT desk_id, field_id, field_name, active_count, breached_count
     FROM snapshot_jsm_slas WHERE scope_key = ? AND version = ? ORDER BY field_name ASC`,
    scopeKey,
    version,
  );
  return rows.map((r) => ({
    deskId: String(r.desk_id),
    fieldId: String(r.field_id),
    fieldName: r.field_name || String(r.field_id),
    activeCount: readInt(r.active_count),
    breachedCount: readInt(r.breached_count),
  }));
}

export async function loadJsmOrganizations(scopeKey, version) {
  const rows = await select(
    `SELECT org_id, name, member_count, members_complete, desk_count
     FROM snapshot_jsm_organizations WHERE scope_key = ? AND version = ? ORDER BY name ASC`,
    scopeKey,
    version,
  );
  return rows.map((r) => ({
    id: String(r.org_id),
    name: r.name || String(r.org_id),
    memberCount: readInt(r.member_count),
    membersComplete:
      r.members_complete === null || r.members_complete === undefined ? null : Boolean(toNumber(r.members_complete)),
    deskCount: readInt(r.desk_count),
  }));
}

export async function readJsmSnapshotMeta(scopeKey) {
  const rows = await select(
    `SELECT state, version, started_at, completed_at, refreshed_at, jsm_enabled, total_desks,
            total_request_types, total_queues, total_organizations, unread_count, summary_json, last_error
     FROM jsm_snapshot_meta WHERE scope_key = ?`,
    scopeKey,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    state: row.state || "idle",
    version: row.version || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    refreshedAt: row.refreshed_at || null,
    jsmEnabled: row.jsm_enabled === null || row.jsm_enabled === undefined ? true : Boolean(toNumber(row.jsm_enabled)),
    totalDesks: toNumber(row.total_desks),
    totalRequestTypes: toNumber(row.total_request_types),
    totalQueues: toNumber(row.total_queues),
    totalOrganizations: toNumber(row.total_organizations),
    unreadCount: toNumber(row.unread_count),
    summary: safeParseJson(row.summary_json, null),
    lastError: row.last_error || null,
  };
}

export async function writeJsmSnapshotMeta(scopeKey, patch = {}) {
  await ensureProjectStoreReady();
  const current = (await readJsmSnapshotMeta(scopeKey)) || {};
  const next = { ...current, ...patch };
  await withSqlRetry(() =>
    sql
      .prepare(
        `
      INSERT INTO jsm_snapshot_meta
        (scope_key, state, version, started_at, completed_at, refreshed_at, jsm_enabled, total_desks,
         total_request_types, total_queues, total_organizations, unread_count, summary_json, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        state = VALUES(state),
        version = VALUES(version),
        started_at = VALUES(started_at),
        completed_at = VALUES(completed_at),
        refreshed_at = VALUES(refreshed_at),
        jsm_enabled = VALUES(jsm_enabled),
        total_desks = VALUES(total_desks),
        total_request_types = VALUES(total_request_types),
        total_queues = VALUES(total_queues),
        total_organizations = VALUES(total_organizations),
        unread_count = VALUES(unread_count),
        summary_json = VALUES(summary_json),
        last_error = VALUES(last_error)
    `,
      )
      .bindParams(
        scopeKey,
        next.state || "idle",
        next.version || null,
        next.startedAt || null,
        next.completedAt || null,
        next.refreshedAt || null,
        next.jsmEnabled === false ? 0 : 1,
        next.totalDesks ?? 0,
        next.totalRequestTypes ?? 0,
        next.totalQueues ?? 0,
        next.totalOrganizations ?? 0,
        next.unreadCount ?? 0,
        next.summary ? JSON.stringify(next.summary) : null,
        next.lastError || null,
      )
      .execute(),
  );
}
