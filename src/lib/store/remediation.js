// Storage for remediation ticketing: the Jira issues Observatory created for a governance
// finding. One row per issue -- the epic (item_id = '') and one task per item to fix.
// Imports only from core.js: one arrow, no cycle.

import { sql } from "@forge/sql";
import {
  chunkArray,
  ensureProjectStoreReady,
  toNumber,
  withSqlRetry,
} from "./core.js";

const EPIC_ITEM_ID = "";
const BATCH = 50;

// Upsert one ticket row. `row` carries whatever changed -- creation writes the identity and
// created_* fields, a later sync writes only last_status / assignee / synced_at.
export async function recordRemediationTicket(scopeKey, row = {}) {
  await ensureProjectStoreReady();
  const itemId = row.isEpic ? EPIC_ITEM_ID : String(row.itemId ?? "");
  await withSqlRetry(() =>
    sql.prepare(`
      INSERT INTO remediation_tickets
        (scope_key, finding_key, pillar, item_id, issue_key, issue_id, is_epic, epic_key,
         summary, last_status, last_status_category, assignee_account_id, assignee_name,
         created_by, created_at, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        pillar = VALUES(pillar),
        issue_key = VALUES(issue_key),
        issue_id = VALUES(issue_id),
        is_epic = VALUES(is_epic),
        epic_key = VALUES(epic_key),
        summary = VALUES(summary),
        last_status = COALESCE(VALUES(last_status), last_status),
        last_status_category = COALESCE(VALUES(last_status_category), last_status_category),
        assignee_account_id = COALESCE(VALUES(assignee_account_id), assignee_account_id),
        assignee_name = COALESCE(VALUES(assignee_name), assignee_name),
        created_by = COALESCE(VALUES(created_by), created_by),
        created_at = COALESCE(VALUES(created_at), created_at),
        synced_at = COALESCE(VALUES(synced_at), synced_at)
    `).bindParams(
      scopeKey,
      String(row.findingKey ?? ""),
      row.pillar || null,
      itemId,
      String(row.issueKey ?? ""),
      row.issueId != null ? String(row.issueId) : null,
      row.isEpic ? 1 : 0,
      row.epicKey || null,
      row.summary ? String(row.summary).slice(0, 500) : null,
      row.lastStatus || null,
      row.lastStatusCategory || null,
      row.assigneeAccountId || null,
      row.assigneeName || null,
      row.createdBy || null,
      row.createdAt || null,
      row.syncedAt || null,
    ).execute()
  );
}

function mapRow(row) {
  return {
    findingKey: row.finding_key,
    pillar: row.pillar || null,
    itemId: row.item_id,
    issueKey: row.issue_key,
    issueId: row.issue_id || null,
    isEpic: Boolean(toNumber(row.is_epic)),
    epicKey: row.epic_key || null,
    summary: row.summary || null,
    lastStatus: row.last_status || null,
    lastStatusCategory: row.last_status_category || null,
    assigneeAccountId: row.assignee_account_id || null,
    assigneeName: row.assignee_name || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at || null,
    syncedAt: row.synced_at || null,
  };
}

// Every ticket, or every ticket for one finding, newest epic first.
export async function loadRemediationTickets(scopeKey, findingKey = null) {
  await ensureProjectStoreReady();
  const where = findingKey ? "scope_key = ? AND finding_key = ?" : "scope_key = ?";
  const params = findingKey ? [scopeKey, String(findingKey)] : [scopeKey];
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT * FROM remediation_tickets
      WHERE ${where}
      ORDER BY is_epic DESC, created_at ASC
    `).bindParams(...params).execute()
  );
  return (result.rows || []).map(mapRow);
}

// The epic row for a finding, or null if none has been created.
export async function getRemediationEpic(scopeKey, findingKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT * FROM remediation_tickets
      WHERE scope_key = ? AND finding_key = ? AND item_id = ?
    `).bindParams(scopeKey, String(findingKey), EPIC_ITEM_ID).execute()
  );
  const row = result.rows?.[0];
  return row ? mapRow(row) : null;
}

// Every ticket not already known to be done -- what the hourly sync re-reads from Jira.
// "Not done" rather than "in progress": a row that has never synced (last_status_category
// NULL) is exactly as open as one Jira has confirmed is not done, and skipping it would mean
// a freshly created ticket never gets its first status read until something else touches it.
export async function loadOpenRemediationTickets(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT * FROM remediation_tickets
      WHERE scope_key = ? AND (last_status_category IS NULL OR last_status_category != 'done')
    `).bindParams(scopeKey).execute()
  );
  return (result.rows || []).map(mapRow);
}

// The item ids that already have a task under this finding -- the idempotency set the
// task-creation job diffs against so it never doubles up.
export async function loadTicketedItemIds(scopeKey, findingKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT item_id FROM remediation_tickets
      WHERE scope_key = ? AND finding_key = ? AND is_epic = 0
    `).bindParams(scopeKey, String(findingKey)).execute()
  );
  return new Set((result.rows || []).map((r) => String(r.item_id)));
}

// Refresh the live fields from a Jira read (the hourly sync). Never touches identity.
export async function updateRemediationSync(scopeKey, issueKey, patch = {}) {
  await ensureProjectStoreReady();
  await withSqlRetry(() =>
    sql.prepare(`
      UPDATE remediation_tickets
      SET last_status = ?, last_status_category = ?, assignee_account_id = ?, assignee_name = ?, synced_at = ?
      WHERE scope_key = ? AND issue_key = ?
    `).bindParams(
      patch.lastStatus || null,
      patch.lastStatusCategory || null,
      patch.assigneeAccountId || null,
      patch.assigneeName || null,
      patch.syncedAt || new Date().toISOString(),
      scopeKey,
      String(issueKey),
    ).execute()
  );
}

// Bulk record, for the task-creation job writing a batch of new task rows at once.
export async function recordRemediationTickets(scopeKey, rows = []) {
  for (const batch of chunkArray(rows, BATCH)) {
    for (const row of batch) {
      // eslint-disable-next-line no-await-in-loop
      await recordRemediationTicket(scopeKey, row);
    }
  }
}
