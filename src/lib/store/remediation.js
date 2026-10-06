// Storage for remediation ticketing: the Jira issues Observatory created for a governance
// finding. One row per issue -- the epic (item_id = '') and one task per item to fix -- per
// calendar quarter ("2026-Q3"). Each finding gets one epic per quarter; every quarter's rows
// are kept, so the history of how a finding was worked, and whether it came back, survives.
// Imports only from core.js: one arrow, no cycle.

import { sql } from "@forge/sql";
import {
  chunkArray,
  ensureProjectStoreReady,
  toNumber,
  withSqlRetry,
} from "./core.js";

const EPIC_ITEM_ID = "";

// The calendar quarter a date falls in, as "2026-Q3" (UTC). Remediation's unit of time: one
// epic per finding per quarter.
export function currentPeriod(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}
const BATCH = 50;

// Upsert one ticket row. `row` carries whatever changed -- creation writes the identity and
// created_* fields, a later sync writes only last_status / assignee / synced_at.
export async function recordRemediationTicket(scopeKey, row = {}) {
  await ensureProjectStoreReady();
  const itemId = row.isEpic ? EPIC_ITEM_ID : String(row.itemId ?? "");
  await withSqlRetry(() =>
    sql.prepare(`
      INSERT INTO remediation_tickets_v2
        (scope_key, finding_key, period, pillar, item_id, issue_key, issue_id, is_epic, epic_key,
         summary, last_status, last_status_category, assignee_account_id, assignee_name,
         created_by, created_at, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      String(row.period || currentPeriod()),
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
    period: row.period || null,
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
    doneAt: row.done_at || null,
    statusChangedAt: row.status_changed_at || null,
  };
}

// Every ticket, or every ticket for one finding, newest epic first.
export async function loadRemediationTickets(scopeKey, findingKey = null) {
  await ensureProjectStoreReady();
  const where = findingKey ? "scope_key = ? AND finding_key = ?" : "scope_key = ?";
  const params = findingKey ? [scopeKey, String(findingKey)] : [scopeKey];
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT * FROM remediation_tickets_v2
      WHERE ${where}
      ORDER BY period DESC, is_epic DESC, created_at ASC
    `).bindParams(...params).execute()
  );
  return (result.rows || []).map(mapRow);
}

// The finding's epic for one quarter, or null if that quarter has none yet.
export async function getRemediationEpic(scopeKey, findingKey, period = currentPeriod()) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT * FROM remediation_tickets_v2
      WHERE scope_key = ? AND finding_key = ? AND period = ? AND item_id = ?
    `).bindParams(scopeKey, String(findingKey), String(period), EPIC_ITEM_ID).execute()
  );
  const row = result.rows?.[0];
  return row ? mapRow(row) : null;
}

// Every ticket the sync re-reads from Jira:
//   - anything not known to be done. A row that has never synced (last_status_category NULL) is
//     exactly as open as one Jira has confirmed is not done; skipping it would leave a freshly
//     created ticket without a first status until something else touched it.
//   - anything that reached Done since `reopenWindowStart`. A ticket reopened in Jira must come
//     back as open; without this, the sync stopped reading a ticket the moment it was Done and
//     a reopen was never seen.
//   - anything done with no done_at yet, so rows from before done_at existed get their date.
// ISO timestamps in UTC ("2026-09-28T16:00:00.000Z") compare correctly as strings.
export async function loadRemediationTicketsToSync(scopeKey, reopenWindowStart) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT * FROM remediation_tickets_v2
      WHERE scope_key = ?
        AND (last_status_category IS NULL OR last_status_category != 'done'
             OR done_at IS NULL OR done_at >= ?)
    `).bindParams(scopeKey, String(reopenWindowStart)).execute()
  );
  return (result.rows || []).map(mapRow);
}

// The item ids a new task must skip for this finding in this quarter -- the idempotency set
// the task-creation job diffs against so it never doubles up:
//   - anything already ticketed this quarter, and
//   - anything with a task from an earlier quarter that is still open -- it is still being
//     worked under that quarter's epic, and a second task for it would be a duplicate.
// An item whose earlier task is done but which is flagged again is NOT in the set: it came
// back, and this quarter's epic is where it belongs.
export async function loadTicketedItemIds(scopeKey, findingKey, period = currentPeriod()) {
  return new Set((await loadTicketedItems(scopeKey, findingKey, period)).keys());
}

// The same set, with the ticket that holds each item -- so the Remediation tab can say an item
// is still being worked under an earlier quarter's epic instead of offering to ticket it again.
// The one place the rule lives; loadTicketedItemIds is this, keys only.
export async function loadTicketedItems(scopeKey, findingKey, period = currentPeriod()) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT item_id, issue_key, epic_key, period FROM remediation_tickets_v2
      WHERE scope_key = ? AND finding_key = ? AND is_epic = 0
        AND (period = ? OR last_status_category IS NULL OR last_status_category != 'done')
    `).bindParams(scopeKey, String(findingKey), String(period)).execute()
  );
  return new Map((result.rows || []).map((r) => [
    String(r.item_id),
    { issueKey: r.issue_key, epicKey: r.epic_key || null, period: r.period || null },
  ]));
}

// Refresh the live fields from a Jira read (the hourly sync). Never touches identity.
export async function updateRemediationSync(scopeKey, issueKey, patch = {}) {
  await ensureProjectStoreReady();
  await withSqlRetry(() =>
    sql.prepare(`
      UPDATE remediation_tickets_v2
      SET last_status = ?, last_status_category = ?, assignee_account_id = ?, assignee_name = ?, synced_at = ?,
          done_at = ?, status_changed_at = ?
      WHERE scope_key = ? AND issue_key = ?
    `).bindParams(
      patch.lastStatus || null,
      patch.lastStatusCategory || null,
      patch.assigneeAccountId || null,
      patch.assigneeName || null,
      patch.syncedAt || new Date().toISOString(),
      patch.doneAt || null,
      patch.statusChangedAt || null,
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
