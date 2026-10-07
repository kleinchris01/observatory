// Workflow schemes, the status catalog, and per-status usage counts.
//
// Split out of project-store.js; imports only from core.js.

import { sql } from "@forge/sql";
import {
  chunkArray,
  deleteScopeInChunks,
  ensureProjectStoreReady,
  safeParseJson,
  toNumber,
  withSqlRetry,
} from "./core.js";

// Full replace, mirroring replaceSnapshotFields: delete this scope's rows, then
// insert the fresh set. Workflow schemes/statuses are small site-wide catalogs
// (no resume/append path needed, unlike the custom-field snapshot).
export async function replaceWorkflowSnapshot(scopeKey, version, { schemes = [], schemeProjects = [], statuses = [], schemeStatuses = [], transitionScreens = [], workflowRules = null }) {
  await ensureProjectStoreReady();

  await withSqlRetry(() => sql.prepare("DELETE FROM snapshot_workflow_schemes WHERE scope_key = ?").bindParams(scopeKey).execute());
  await withSqlRetry(() => sql.prepare("DELETE FROM snapshot_workflow_scheme_projects WHERE scope_key = ?").bindParams(scopeKey).execute());
  await withSqlRetry(() => sql.prepare("DELETE FROM snapshot_statuses WHERE scope_key = ?").bindParams(scopeKey).execute());
  await withSqlRetry(() => sql.prepare("DELETE FROM snapshot_workflow_statuses WHERE scope_key = ?").bindParams(scopeKey).execute());
  await withSqlRetry(() => sql.prepare("DELETE FROM snapshot_transition_screens WHERE scope_key = ?").bindParams(scopeKey).execute());
  // The rule tables run to tens of thousands of rows on a large site, so each DELETE is
  // bounded -- one unbounded statement is what tripped TiDB's memory quota on the access tables.
  for (const table of WORKFLOW_RULE_TABLES) await deleteScopeInChunks(table, scopeKey);

  for (const batch of chunkArray(schemes, 50)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((scheme) => [
      scopeKey, version, scheme.id, scheme.name, scheme.description || null,
      scheme.defaultWorkflow || null, JSON.stringify(scheme.issueTypeMapping || null),
      scheme.projectCount ?? 0, JSON.stringify(scheme.findings || null),
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_workflow_schemes
          (scope_key, version, scheme_id, name, description, default_workflow, issue_type_mapping_json, project_count, findings_json)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(schemeProjects, 50)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((row) => [
      scopeKey, version, row.schemeId, row.projectId, row.projectKey, row.projectName,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_workflow_scheme_projects
          (scope_key, version, scheme_id, project_id, project_key, project_name)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(statuses, 50)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((status) => [
      scopeKey, version, status.id, status.name, status.statusCategory || null,
      JSON.stringify(status.findings || null),
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_statuses (scope_key, version, status_id, name, status_category, findings_json)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(schemeStatuses, 150)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((row) => [scopeKey, version, row.schemeId, row.statusId]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_workflow_statuses (scope_key, version, scheme_id, status_id)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(transitionScreens, 50)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((row) => [
      scopeKey, version, String(row.workflowName), String(row.transitionId),
      row.transitionName || null, row.toStatus == null ? null : String(row.toStatus),
      String(row.screenId),
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_transition_screens
          (scope_key, version, workflow_name, transition_id, transition_name, to_status, screen_id)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  if (workflowRules) await insertWorkflowRuleRows(scopeKey, version, workflowRules);
}

const WORKFLOW_RULE_TABLES = [
  "snapshot_workflows",
  "snapshot_workflow_refs",
  "snapshot_workflow_rules",
  "snapshot_workflow_properties",
  "snapshot_workflow_transitions",
];

// INSERT IGNORE on every table: a duplicate key from an unexpected workflow payload costs
// that one row, never the whole workflow snapshot -- the scheme and status inventory this
// is written alongside is worth more than any one rule.
async function insertWorkflowRuleRows(scopeKey, version, { workflows = [], transitions = [], rules = [], properties = [], refs = [] }) {
  for (const batch of chunkArray(workflows, 50)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((row) => [
      scopeKey, version, String(row.workflowName), row.workflowId == null ? null : String(row.workflowId).slice(0, 64),
      row.scopeType || null, row.scopeProjectId || null, Number(row.statusCount) || 0,
      Number(row.transitionCount) || 0, Number(row.ruleCount) || 0, Number(row.schemeCount) || 0,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT IGNORE INTO snapshot_workflows
          (scope_key, version, workflow_name, workflow_id, scope_type, scope_project_id, status_count, transition_count, rule_count, scheme_count)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(transitions, 50)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((row) => [
      scopeKey, version, String(row.workflowName), String(row.transitionId),
      row.transitionName == null ? null : String(row.transitionName).slice(0, 255),
      row.transitionType || null, JSON.stringify(row.fromStatusIds || []),
      row.toStatusId == null ? null : String(row.toStatusId), Number(row.ruleCount) || 0,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT IGNORE INTO snapshot_workflow_transitions
          (scope_key, version, workflow_name, transition_id, transition_name, transition_type, from_status_ids, to_status_id, rule_count)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(rules, 100)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((row) => [
      scopeKey, version, String(row.workflowName), String(row.transitionId), Number(row.ruleSeq),
      row.kind, row.ruleKey == null ? null : String(row.ruleKey).slice(0, 191),
      row.summary == null ? null : String(row.summary).slice(0, 500),
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT IGNORE INTO snapshot_workflow_rules
          (scope_key, version, workflow_name, transition_id, rule_seq, rule_kind, rule_key, summary)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  // A key set twice on one owner keeps the first, which is the one Jira applies.
  for (const batch of chunkArray(properties, 100)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((row) => [
      scopeKey, version, String(row.workflowName), row.ownerKind, String(row.ownerId),
      String(row.key).slice(0, 160), row.value == null ? null : String(row.value),
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT IGNORE INTO snapshot_workflow_properties
          (scope_key, version, workflow_name, owner_kind, owner_id, prop_key, prop_value)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(refs, 100)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((row) => [
      scopeKey, version, Number(row.seq), row.refType, String(row.refId),
      row.refLabel == null ? null : String(row.refLabel).slice(0, 255),
      row.refMissing == null ? null : (row.refMissing ? 1 : 0),
      String(row.workflowName), row.source, row.ownerKind, String(row.ownerId),
      row.ruleSeq == null ? null : Number(row.ruleSeq),
      row.propKey == null ? null : String(row.propKey).slice(0, 160),
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_workflow_refs
          (scope_key, version, seq, ref_type, ref_id, ref_label, ref_missing, workflow_name, source, owner_kind, owner_id, rule_seq, prop_key)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }
}

function mapRefRow(row) {
  return {
    refType: row.ref_type,
    refId: row.ref_id,
    refLabel: row.ref_label || null,
    refMissing: row.ref_missing == null ? null : Boolean(Number(row.ref_missing)),
    workflowName: row.workflow_name,
    source: row.source,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    ruleSeq: row.rule_seq == null ? null : toNumber(row.rule_seq),
    propKey: row.prop_key || null,
    propValue: row.prop_value ?? null,
    transitionName: row.transition_name || null,
    transitionType: row.transition_type || null,
    fromStatusIds: safeParseJson(row.from_status_ids, []),
    toStatusId: row.to_status_id || null,
    ruleKind: row.rule_kind || null,
    ruleKey: row.rule_key || null,
    summary: row.summary || null,
  };
}

// Every workflow rule or property that points at one thing (a field id, a group id, ...),
// with the transition or status it sits on and the rule or property doing the pointing.
// One indexed read plus three joins, so the field card and the group lookup can ask freely.
export async function loadWorkflowRefsFor(scopeKey, version, refType, refIds) {
  await ensureProjectStoreReady();
  const ids = (Array.isArray(refIds) ? refIds : [refIds]).filter(Boolean).map(String);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT r.ref_type, r.ref_id, r.ref_label, r.ref_missing, r.workflow_name, r.source,
             r.owner_kind, r.owner_id, r.rule_seq, r.prop_key,
             t.transition_name, t.transition_type, t.from_status_ids, t.to_status_id,
             ru.rule_kind, ru.rule_key, ru.summary,
             p.prop_value
      FROM snapshot_workflow_refs r
      LEFT JOIN snapshot_workflow_transitions t
        ON t.scope_key = r.scope_key AND t.version = r.version AND t.workflow_name = r.workflow_name
       AND r.owner_kind = 'transition' AND t.transition_id = r.owner_id
      LEFT JOIN snapshot_workflow_rules ru
        ON ru.scope_key = r.scope_key AND ru.version = r.version AND ru.workflow_name = r.workflow_name
       AND ru.transition_id = r.owner_id AND ru.rule_seq = r.rule_seq
      LEFT JOIN snapshot_workflow_properties p
        ON p.scope_key = r.scope_key AND p.version = r.version AND p.workflow_name = r.workflow_name
       AND p.owner_kind = r.owner_kind AND p.owner_id = r.owner_id AND p.prop_key = r.prop_key
      WHERE r.scope_key = ? AND r.version = ? AND r.ref_type = ? AND r.ref_id IN (${placeholders})
      ORDER BY r.workflow_name ASC, r.seq ASC
      LIMIT 2000
    `).bindParams(scopeKey, version, String(refType), ...ids).execute()
  );
  return (result.rows || []).map(mapRefRow);
}

// Every reference of the given types. The broken-reference check needs the whole set to
// compare against the field and group catalogues; it is bounded by what a site's workflows
// name, which is hundreds of rows, not the tens of thousands of rule rows.
export async function loadWorkflowRefsByType(scopeKey, version, refTypes = []) {
  await ensureProjectStoreReady();
  const types = refTypes.filter(Boolean).map(String);
  if (!types.length) return [];
  const placeholders = types.map(() => "?").join(", ");
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT ref_type, ref_id, ref_label, ref_missing, workflow_name, source, owner_kind, owner_id, rule_seq, prop_key
      FROM snapshot_workflow_refs
      WHERE scope_key = ? AND version = ? AND ref_type IN (${placeholders})
      ORDER BY workflow_name ASC, seq ASC
      LIMIT 20000
    `).bindParams(scopeKey, version, ...types).execute()
  );
  return (result.rows || []).map(mapRefRow);
}

// Every property set on one status, in every workflow that uses it. What the status drawer
// shows under "what this status restricts".
export async function loadStatusWorkflowProperties(scopeKey, version, statusId) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT workflow_name, prop_key, prop_value
      FROM snapshot_workflow_properties
      WHERE scope_key = ? AND version = ? AND owner_kind = 'status' AND owner_id = ?
      ORDER BY workflow_name ASC, prop_key ASC
      LIMIT 2000
    `).bindParams(scopeKey, version, String(statusId)).execute()
  );
  return (result.rows || []).map((row) => ({
    workflowName: row.workflow_name,
    key: row.prop_key,
    value: row.prop_value ?? "",
  }));
}

// The references belonging to the rule row aliased `ru`, as a correlated subquery.
const RULE_REF_EXISTS = `
  SELECT 1 FROM snapshot_workflow_refs r
  WHERE r.scope_key = ru.scope_key AND r.version = ru.version AND r.workflow_name = ru.workflow_name
    AND r.source = 'rule' AND r.owner_id = ru.transition_id AND r.rule_seq = ru.rule_seq`;

// LIKE treats % and _ as wildcards; a search for "edit_group" means those characters.
function likePattern(text) {
  return `%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// A page of rules for the Workflows tab, ordered by workflow then transition. `query`
// matches workflow name, transition name, rule key -- or the id or name of anything the rule
// points at, which is what makes "where is Onsite Modification validated" one search.
// `kind` narrows to one rule kind; `brokenOnly` to rules naming something that is gone.
export async function loadWorkflowRulesPage(scopeKey, version, { query = "", kind = null, brokenOnly = false, offset = 0, limit = 50 } = {}) {
  await ensureProjectStoreReady();
  const where = ["ru.scope_key = ?", "ru.version = ?"];
  const params = [scopeKey, version];
  if (kind) {
    where.push("ru.rule_kind = ?");
    params.push(String(kind));
  }
  const q = String(query || "").trim().toLowerCase();
  if (q) {
    where.push(`(LOWER(ru.workflow_name) LIKE ? OR LOWER(t.transition_name) LIKE ? OR LOWER(ru.rule_key) LIKE ?
      OR EXISTS (${RULE_REF_EXISTS} AND (LOWER(r.ref_id) LIKE ? OR LOWER(r.ref_label) LIKE ?)))`);
    const like = likePattern(q);
    params.push(like, like, like, like, like);
  }
  if (brokenOnly) where.push(`EXISTS (${RULE_REF_EXISTS} AND r.ref_missing = 1)`);
  // Forge SQL rejects placeholders in LIMIT/OFFSET, so both are clamped integers.
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(Number(limit)) || 50));
  const safeOffset = Math.max(0, Math.trunc(Number(offset)) || 0);

  const from = `
    FROM snapshot_workflow_rules ru
    LEFT JOIN snapshot_workflow_transitions t
      ON t.scope_key = ru.scope_key AND t.version = ru.version
     AND t.workflow_name = ru.workflow_name AND t.transition_id = ru.transition_id
    WHERE ${where.join(" AND ")}
  `;
  const [rows, count] = await Promise.all([
    withSqlRetry(() =>
      sql.prepare(`
        SELECT ru.workflow_name, ru.transition_id, ru.rule_seq, ru.rule_kind, ru.rule_key, ru.summary,
               t.transition_name, t.transition_type, t.from_status_ids, t.to_status_id
        ${from}
        ORDER BY ru.workflow_name ASC, t.transition_name ASC, ru.rule_seq ASC
        LIMIT ${safeLimit} OFFSET ${safeOffset}
      `).bindParams(...params).execute()
    ),
    withSqlRetry(() => sql.prepare(`SELECT COUNT(*) AS n ${from}`).bindParams(...params).execute()),
  ]);

  return {
    total: toNumber(count.rows?.[0]?.n, 0),
    rules: (rows.rows || []).map((row) => ({
      workflowName: row.workflow_name,
      transitionId: row.transition_id,
      ruleSeq: toNumber(row.rule_seq),
      kind: row.rule_kind,
      ruleKey: row.rule_key || null,
      summary: row.summary || null,
      transitionName: row.transition_name || row.transition_id,
      transitionType: row.transition_type || null,
      fromStatusIds: safeParseJson(row.from_status_ids, []),
      toStatusId: row.to_status_id || null,
    })),
  };
}

// The references one page of rules carries, for its "points at" column.
export async function loadRefsForRules(scopeKey, version, keys = []) {
  await ensureProjectStoreReady();
  if (!keys.length) return [];
  const clauses = keys.map(() => "(workflow_name = ? AND owner_id = ? AND rule_seq = ?)").join(" OR ");
  const params = keys.flatMap((k) => [String(k.workflowName), String(k.transitionId), Number(k.ruleSeq)]);
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT ref_type, ref_id, ref_label, ref_missing, workflow_name, source, owner_kind, owner_id, rule_seq, prop_key
      FROM snapshot_workflow_refs
      WHERE scope_key = ? AND version = ? AND source = 'rule' AND (${clauses})
      ORDER BY seq ASC
    `).bindParams(scopeKey, version, ...params).execute()
  );
  return (result.rows || []).map(mapRefRow);
}

// Every property that restricts something (jira.permission.*, jira.issue.editable, the JSM
// approval field), across all workflows. Bounded by what workflows set, which is small.
export async function loadRestrictingProperties(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT workflow_name, owner_kind, owner_id, prop_key, prop_value
      FROM snapshot_workflow_properties
      WHERE scope_key = ? AND version = ?
        AND (prop_key LIKE 'jira.permission.%' OR prop_key = 'jira.issue.editable' OR prop_key = 'approval.field.id')
      ORDER BY workflow_name ASC, owner_kind ASC, owner_id ASC, prop_key ASC
      LIMIT 10000
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    workflowName: row.workflow_name,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    key: row.prop_key,
    value: row.prop_value ?? "",
  }));
}

// Every workflow with its counts and how many project-attached schemes use it. A few
// hundred rows on a large site, so loaded whole.
export async function loadWorkflowsCatalog(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT workflow_name, workflow_id, scope_type, scope_project_id, status_count, transition_count, rule_count, scheme_count
      FROM snapshot_workflows
      WHERE scope_key = ? AND version = ?
      ORDER BY workflow_name ASC
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    name: row.workflow_name,
    id: row.workflow_id || null,
    scopeType: row.scope_type || null,
    scopeProjectId: row.scope_project_id || null,
    statusCount: toNumber(row.status_count, 0),
    transitionCount: toNumber(row.transition_count, 0),
    ruleCount: toNumber(row.rule_count, 0),
    schemeCount: toNumber(row.scheme_count, 0),
  }));
}

// Every transition that opens a screen, for one workflow snapshot version.
//
// Bounded by workflows x transitions-with-screens, which is far smaller than it sounds --
// most transitions open nothing -- so this loads whole rather than paging.
export async function loadTransitionScreens(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT workflow_name, transition_id, transition_name, to_status, screen_id
      FROM snapshot_transition_screens
      WHERE scope_key = ? AND version = ?
      ORDER BY workflow_name ASC, transition_name ASC
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    workflowName: row.workflow_name,
    transitionId: row.transition_id,
    transitionName: row.transition_name || row.transition_id,
    toStatus: row.to_status || null,
    screenId: row.screen_id,
  }));
}

// Which transitions open one screen. The reverse direction, for the screen detail panel --
// served by idx_snapshot_transition_screens_screen rather than a scan.
export async function loadTransitionsForScreen(scopeKey, version, screenId) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT workflow_name, transition_id, transition_name, to_status
      FROM snapshot_transition_screens
      WHERE scope_key = ? AND version = ? AND screen_id = ?
      ORDER BY workflow_name ASC, transition_name ASC
    `).bindParams(scopeKey, version, String(screenId)).execute()
  );
  return (result.rows || []).map((row) => ({
    workflowName: row.workflow_name,
    transitionId: row.transition_id,
    transitionName: row.transition_name || row.transition_id,
    toStatus: row.to_status || null,
  }));
}

// The set of screen ids any transition opens, as strings.
//
// Deliberately the whole set rather than a per-screen check: the screen catalog needs to
// subtract these from its unreached count, and asking per screen would be 760 queries to
// answer one number.
export async function loadTransitionScreenIds(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT DISTINCT screen_id
      FROM snapshot_transition_screens
      WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()
  );
  return new Set((result.rows || []).map((row) => String(row.screen_id)));
}

// Every scheme -> status pair for one snapshot version. Small enough to load whole: it is
// bounded by schemes x statuses-per-scheme, and the insight functions need the full set to
// tell a referenced status from an orphaned one.

// Every scheme -> status pair for one snapshot version. Small enough to load whole: it is
// bounded by schemes x statuses-per-scheme, and the insight functions need the full set to
// tell a referenced status from an orphaned one.
export async function loadWorkflowSchemeStatuses(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT scheme_id, status_id
      FROM snapshot_workflow_statuses
      WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({ schemeId: row.scheme_id, statusId: row.status_id }));
}

// status_id -> total issues across every project, from the last completed universe scan.
// Returns an empty map when no scan has run; callers must treat that as "unknown" rather
// than "zero", because zero is a claim that a status is safe to delete.

// status_id -> total issues across every project, from the last completed universe scan.
// Returns an empty map when no scan has run; callers must treat that as "unknown" rather
// than "zero", because zero is a claim that a status is safe to delete.
export async function loadStatusIssueCounts(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT status_id, SUM(issue_count) AS total
      FROM issue_scan_status_totals
      WHERE scope_key = ?
      GROUP BY status_id
    `).bindParams(scopeKey).execute()
  );
  const counts = new Map();
  for (const row of result.rows || []) {
    if (row?.status_id) counts.set(String(row.status_id), toNumber(row.total));
  }
  return counts;
}

// status_id -> issues that have ever been in it. Empty map means "never measured", which
// callers must not render as zero.

// status_id -> issues that have ever been in it. Empty map means "never measured", which
// callers must not render as zero.
export async function loadStatusHistoryCounts(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT status_id, ever_count, measured_at
      FROM status_history_totals
      WHERE scope_key = ?
    `).bindParams(scopeKey).execute()
  );
  const counts = new Map();
  let measuredAt = null;
  for (const row of result.rows || []) {
    if (!row?.status_id) continue;
    counts.set(String(row.status_id), toNumber(row.ever_count));
    if (row.measured_at && (!measuredAt || row.measured_at > measuredAt)) measuredAt = row.measured_at;
  }
  return { counts, measuredAt };
}

// Upsert rather than replace: a run where some statuses timed out must not delete the
// counts it did not re-measure.

// Upsert rather than replace: a run where some statuses timed out must not delete the
// counts it did not re-measure.
export async function upsertStatusHistoryCounts(scopeKey, counts, measuredAt) {
  await ensureProjectStoreReady();
  const rows = [...counts.entries()].filter(([statusId]) => statusId);
  if (!rows.length) return;

  for (const batch of chunkArray(rows, 100)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?)").join(", ");
    const params = batch.flatMap(([statusId, count]) => [scopeKey, String(statusId), Number(count) || 0, measuredAt]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO status_history_totals (scope_key, status_id, ever_count, measured_at)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE ever_count = VALUES(ever_count), measured_at = VALUES(measured_at)
      `).bindParams(...params).execute()
    );
  }
}

export async function clearStatusIssueCounts(scopeKey) {
  await ensureProjectStoreReady();
  await withSqlRetry(() =>
    sql.prepare("DELETE FROM issue_scan_status_totals WHERE scope_key = ?").bindParams(scopeKey).execute()
  );
}

// Accumulate per-status counts from a worker chunk.
//
// ON DUPLICATE KEY UPDATE rather than INSERT: workers run in parallel over disjoint
// project sets, but a single status is reached from many projects and each worker flushes
// several times per run, so rows are additive across both dimensions.

// Accumulate per-status counts from a worker chunk.
//
// ON DUPLICATE KEY UPDATE rather than INSERT: workers run in parallel over disjoint
// project sets, but a single status is reached from many projects and each worker flushes
// several times per run, so rows are additive across both dimensions.
export async function flushIssueScanStatusCounts(scopeKey, statusCounts) {
  // statusCounts: Map<`statusId|projectId`, { statusId, statusName, statusCategory, projectId, projectKey, count }>
  await ensureProjectStoreReady();
  const rows = [...statusCounts.values()].filter((row) => row?.statusId && row?.projectId);
  if (!rows.length) return;

  for (const batch of chunkArray(rows, 100)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((row) => [
      scopeKey, row.statusId, row.projectId, row.statusName || null,
      row.statusCategory || null, row.projectKey || null, row.count,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO issue_scan_status_totals
          (scope_key, status_id, project_id, status_name, status_category, project_key, issue_count)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE issue_count = issue_count + VALUES(issue_count)
      `).bindParams(...params).execute()
    );
  }
}

export async function loadWorkflowSchemes(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT scheme_id, name, description, default_workflow, issue_type_mapping_json, project_count, findings_json
      FROM snapshot_workflow_schemes
      WHERE scope_key = ? AND version = ?
      ORDER BY name ASC
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    id: row.scheme_id,
    name: row.name,
    description: row.description || "",
    defaultWorkflow: row.default_workflow || null,
    issueTypeMapping: safeParseJson(row.issue_type_mapping_json, null),
    projectCount: toNumber(row.project_count),
    findings: safeParseJson(row.findings_json, null),
  }));
}

export async function loadWorkflowSchemeProjects(scopeKey, version, schemeId) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT project_id, project_key, project_name
      FROM snapshot_workflow_scheme_projects
      WHERE scope_key = ? AND version = ? AND scheme_id = ?
      ORDER BY project_name ASC
    `).bindParams(scopeKey, version, schemeId).execute()
  );
  return (result.rows || []).map((row) => ({
    projectId: row.project_id,
    projectKey: row.project_key,
    projectName: row.project_name,
  }));
}

// Reverse lookup for the Projects tab (Phase 4): which scheme does this project use.

// Reverse lookup for the Projects tab (Phase 4): which scheme does this project use.
export async function loadWorkflowSchemeForProject(scopeKey, version, projectId) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT wsp.scheme_id, ws.name, ws.description
      FROM snapshot_workflow_scheme_projects wsp
      JOIN snapshot_workflow_schemes ws
        ON ws.scope_key = wsp.scope_key AND ws.version = wsp.version AND ws.scheme_id = wsp.scheme_id
      WHERE wsp.scope_key = ? AND wsp.version = ? AND wsp.project_id = ?
      LIMIT 1
    `).bindParams(scopeKey, version, projectId).execute()
  );
  const row = result.rows?.[0];
  if (!row) return null;
  return { schemeId: row.scheme_id, name: row.name, description: row.description || "" };
}

// project_id -> { schemeId, name } for every project in one query.
//
// The per-project loadWorkflowSchemeForProject above is right for a single lookup, but
// reports enrich every project in the result set -- on a 140-project site that would be
// 140 round trips, against the one Forge quota this app actually pushes against. One
// join returns the whole mapping instead.

// project_id -> { schemeId, name } for every project in one query.
//
// The per-project loadWorkflowSchemeForProject above is right for a single lookup, but
// reports enrich every project in the result set -- on a 140-project site that would be
// 140 round trips, against the one Forge quota this app actually pushes against. One
// join returns the whole mapping instead.
export async function loadProjectWorkflowSchemeMap(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT wsp.project_id, wsp.scheme_id, ws.name
      FROM snapshot_workflow_scheme_projects wsp
      JOIN snapshot_workflow_schemes ws
        ON ws.scope_key = wsp.scope_key AND ws.version = wsp.version AND ws.scheme_id = wsp.scheme_id
      WHERE wsp.scope_key = ? AND wsp.version = ?
    `).bindParams(scopeKey, version).execute()
  );
  const map = new Map();
  for (const row of result.rows || []) {
    if (row?.project_id) {
      map.set(String(row.project_id), { schemeId: row.scheme_id, name: row.name });
    }
  }
  return map;
}

export async function loadStatusesCatalog(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT status_id, name, status_category, findings_json
      FROM snapshot_statuses
      WHERE scope_key = ? AND version = ?
      ORDER BY name ASC
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    id: row.status_id,
    name: row.name,
    statusCategory: row.status_category || null,
    findings: safeParseJson(row.findings_json, null),
  }));
}

export async function readWorkflowSnapshotMeta(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT state, version, started_at, completed_at, refreshed_at, total_schemes, transition_screens, workflow_rules, last_error
      FROM workflow_snapshot_meta
      WHERE scope_key = ?
      LIMIT 1
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
    totalSchemes: toNumber(row.total_schemes),
    // null when this snapshot predates transition capture -- deliberately NOT coerced to 0,
    // because 0 means the build looked and found none.
    transitionScreens: row.transition_screens == null ? null : toNumber(row.transition_screens),
    // Same contract: null = rules never read for this snapshot, a number = they were.
    workflowRules: row.workflow_rules == null ? null : toNumber(row.workflow_rules),
    lastError: row.last_error || null,
  };
}

// The workflow version to cross screens against -- or null when that snapshot never read
// transitions. A screen is "unreached" only if neither the scheme chain nor a transition
// opens it; passing a version whose transitions were never read turns every
// transition-opened screen into an unreached one, which is the premise for deleting it.
export function transitionAwareWorkflowVersion(meta) {
  return meta?.version && meta.transitionScreens != null ? meta.version : null;
}

export async function writeWorkflowSnapshotMeta(scopeKey, patch) {
  await ensureProjectStoreReady();
  const current = await readWorkflowSnapshotMeta(scopeKey);
  const next = {
    state: "idle",
    version: null,
    startedAt: null,
    completedAt: null,
    refreshedAt: null,
    totalSchemes: 0,
    lastError: null,
    ...(current || {}),
    ...patch,
  };

  await withSqlRetry(() =>
    sql.prepare(`
      INSERT INTO workflow_snapshot_meta (scope_key, state, version, started_at, completed_at, refreshed_at, total_schemes, transition_screens, workflow_rules, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        state = VALUES(state),
        version = VALUES(version),
        started_at = VALUES(started_at),
        completed_at = VALUES(completed_at),
        refreshed_at = VALUES(refreshed_at),
        total_schemes = VALUES(total_schemes),
        transition_screens = VALUES(transition_screens),
        workflow_rules = VALUES(workflow_rules),
        last_error = VALUES(last_error)
    `).bindParams(scopeKey, next.state, next.version, next.startedAt, next.completedAt, next.refreshedAt, next.totalSchemes, next.transitionScreens ?? null, next.workflowRules ?? null, next.lastError).execute()
  );

  return next;
}

// Every transition into or out of one status, across every workflow -- active or not. Which
// workflows contain a status is a deletion question in its own right: Jira refuses to delete a
// status any workflow uses, whether or not a project's scheme reaches that workflow.
export async function loadTransitionsTouchingStatus(scopeKey, version, statusId) {
  await ensureProjectStoreReady();
  const id = String(statusId);
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT workflow_name, transition_id, transition_name, transition_type, from_status_ids, to_status_id, rule_count
      FROM snapshot_workflow_transitions
      WHERE scope_key = ? AND version = ? AND (to_status_id = ? OR from_status_ids LIKE ?)
      ORDER BY workflow_name ASC, transition_name ASC
      LIMIT 2000
    `).bindParams(scopeKey, version, id, `%"${id.replace(/[\%_"]/g, "")}"%`).execute()
  );
  return (result.rows || []).map((row) => ({
    workflowName: row.workflow_name,
    transitionId: row.transition_id,
    transitionName: row.transition_name || row.transition_id,
    transitionType: row.transition_type || null,
    fromStatusIds: safeParseJson(row.from_status_ids, []),
    toStatusId: row.to_status_id || null,
    ruleCount: toNumber(row.rule_count, 0),
  }))
    // The LIKE is a prefilter; a status id that is a substring of another ("1" in "10") is
    // excluded here, where the parsed list can be checked exactly.
    .filter((t) => t.toStatusId === id || t.fromStatusIds.map(String).includes(id));
}

// Each workflow's transitions and rules in two reads, for the change log. Rules are the
// structured kind and key only (never the summary text, which is presentation): a validator
// swapped for another is a change, a reworded summary is not.
export async function loadWorkflowStructure(scopeKey, version) {
  await ensureProjectStoreReady();
  const [transitions, rules] = await Promise.all([
    withSqlRetry(() =>
      sql.prepare(`
        SELECT workflow_name, transition_id, transition_name, transition_type, from_status_ids, to_status_id
        FROM snapshot_workflow_transitions
        WHERE scope_key = ? AND version = ?
        ORDER BY workflow_name ASC, transition_id ASC
      `).bindParams(scopeKey, version).execute()
    ),
    withSqlRetry(() =>
      sql.prepare(`
        SELECT workflow_name, transition_id, rule_seq, rule_kind, rule_key
        FROM snapshot_workflow_rules
        WHERE scope_key = ? AND version = ?
        ORDER BY workflow_name ASC, transition_id ASC, rule_seq ASC
      `).bindParams(scopeKey, version).execute()
    ),
  ]);
  return {
    transitions: (transitions.rows || []).map((r) => ({
      workflowName: r.workflow_name,
      transitionId: String(r.transition_id),
      name: r.transition_name || null,
      type: r.transition_type || null,
      from: r.from_status_ids ? String(r.from_status_ids).split(",").filter(Boolean).sort() : [],
      to: r.to_status_id || null,
    })),
    rules: (rules.rows || []).map((r) => ({
      workflowName: r.workflow_name,
      transitionId: String(r.transition_id),
      kind: r.rule_kind,
      key: r.rule_key || null,
    })),
  };
}
