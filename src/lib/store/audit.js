// Append-only record of privileged actions. A security control, not a log.
//
// Split out of project-store.js; imports only from core.js.

import { sql } from "@forge/sql";
import { ensureProjectStoreReady, toNumber, withSqlRetry } from "./core.js";

// Write one audit row. Never throws: an audit failure must not become the reason a
// legitimate admin action fails, and must not become a way to block one either. Failures
// are surfaced to the structured log so a silently broken audit trail is still visible.
export async function recordAuditEvent(scopeKey, { actorId, action, outcome, detail } = {}) {
  try {
    await ensureProjectStoreReady();
    await withSqlRetry(() =>
      sql
        .prepare(
          `
          INSERT INTO audit_log (scope_key, at, actor_id, action, outcome, detail)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        )
        .bindParams(
          scopeKey,
          new Date().toISOString(),
          actorId ? String(actorId).slice(0, 128) : null,
          String(action || "unknown").slice(0, 128),
          String(outcome || "unknown").slice(0, 32),
          detail ? String(detail).slice(0, 2000) : null,
        )
        .execute(),
    );
    return { recorded: true };
  } catch (error) {
    console.error("recordAuditEvent: failed to write audit row", error?.message || error);
    return { recorded: false };
  }
}

export async function listAuditEvents(scopeKey, limit = 200) {
  await ensureProjectStoreReady();
  const capped = Math.max(1, Math.min(1000, Number(limit) || 200));
  // LIMIT is interpolated, not bound. Forge SQL rejects a placeholder there with an
  // opaque "Unknown SQL execution error", which is why the audit viewer never worked --
  // every other query in this codebase already interpolates its limit. Safe because
  // `capped` is clamped to an integer between 1 and 1000 above; it never reaches SQL as
  // caller-controlled text.
  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `SELECT at, actor_id, action, outcome, detail FROM audit_log WHERE scope_key = ? ORDER BY at DESC LIMIT ${capped}`,
      )
      .bindParams(scopeKey)
      .execute(),
  );
  return (result?.rows || []).map((row) => ({
    at: row.at,
    actorId: row.actor_id || null,
    action: row.action,
    outcome: row.outcome,
    detail: row.detail || null,
  }));
}

// 180 days, far longer than the 7 kept for report jobs: this is the record you reach for
// when asking "who cleared the snapshot in March", and that question is usually asked
// long after the fact.
export async function pruneOldAuditEvents(scopeKey, olderThanMs = 180 * 24 * 60 * 60 * 1000) {
  await ensureProjectStoreReady();
  const cutoffIso = new Date(Date.now() - olderThanMs).toISOString();
  const result = await withSqlRetry(() =>
    sql.prepare("DELETE FROM audit_log WHERE scope_key = ? AND at < ?").bindParams(scopeKey, cutoffIso).execute(),
  );
  return { eventsDeleted: toNumber(result?.rowsAffected, 0) };
}
