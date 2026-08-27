// Site health over time.
//
// The score was always a way into the findings rather than a finding itself, and the
// question it could never answer was the one that matters most: did cleaning that up
// actually help? A single number on a landing page cannot say. A series can.
//
// Split out like store/workflow.js and store/screen.js; imports only from core.js, so there
// is one arrow and no cycle to reason about.

import { sql } from "@forge/sql";
import {
  ensureProjectStoreReady,
  safeParseJson,
  toNumber,
  withSqlRetry,
} from "./core.js";

// The UTC day a measurement belongs to.
//
// UTC rather than local: the row is keyed on it, and a key that shifts with the reader's
// timezone would write two rows for one day for an admin in Sydney and none for the same
// day next week.
export function measurementDay(at = Date.now()) {
  return new Date(at).toISOString().slice(0, 10);
}

// One row per scope per day, upserted.
//
// Upsert rather than insert: an admin who fixes duplicate statuses and rebuilds three times
// in an afternoon should see the afternoon's result, not three points of noise. The last
// measurement of a day wins, which is also the one reflecting the most cleanup.
//
// Never throws. This is bookkeeping attached to a read path -- an overview that 500s because
// its history row could not be written would be a strictly worse product than one with a gap
// in a chart.
export async function recordHealthSnapshot(scopeKey, health, at = Date.now()) {
  if (!scopeKey || !health || health.score === null || health.score === undefined) {
    return { recorded: false, reason: "nothing to record" };
  }

  try {
    await ensureProjectStoreReady();

    // {key: score} for scored dimensions only. An unavailable dimension is omitted rather
    // than stored as null, so a gap in the chart means "not measured that day" instead of
    // "measured as zero" -- the same distinction the score itself is careful about.
    const dimensions = {};
    for (const dimension of health.dimensions || []) {
      if (dimension?.available && dimension.key) dimensions[dimension.key] = dimension.score;
    }

    const measuredAt = new Date(at).toISOString();
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO health_history
          (scope_key, measured_on, measured_at, score, grade, dimensions_scored, dimensions_total, dimensions_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          measured_at = VALUES(measured_at),
          score = VALUES(score),
          grade = VALUES(grade),
          dimensions_scored = VALUES(dimensions_scored),
          dimensions_total = VALUES(dimensions_total),
          dimensions_json = VALUES(dimensions_json)
      `).bindParams(
        scopeKey,
        measurementDay(at),
        measuredAt,
        health.score,
        health.grade || null,
        health.dimensionsScored ?? 0,
        health.dimensionsTotal ?? 0,
        JSON.stringify(dimensions)
      ).execute()
    );
    return { recorded: true };
  } catch (error) {
    console.warn("recordHealthSnapshot: failed to write history row", error?.message || error);
    return { recorded: false };
  }
}

// The series, oldest first.
//
// Oldest first because every consumer plots it left to right; reversing in the UI is one
// more place for the direction to be got wrong.
export async function loadHealthHistory(scopeKey, { days = 90 } = {}) {
  await ensureProjectStoreReady();
  // Clamped and interpolated, never bound: Forge SQL rejects a placeholder in LIMIT with an
  // opaque "Unknown SQL execution error", which is the rule the whole storage layer follows.
  const capped = Math.max(1, Math.min(365, Math.trunc(Number(days)) || 90));

  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT measured_on, measured_at, score, grade, dimensions_scored, dimensions_total, dimensions_json
      FROM health_history
      WHERE scope_key = ?
      ORDER BY measured_on DESC
      LIMIT ${capped}
    `).bindParams(scopeKey).execute()
  );

  return (result.rows || []).map((row) => ({
    day: row.measured_on,
    measuredAt: row.measured_at,
    score: toNumber(row.score),
    grade: row.grade || null,
    dimensionsScored: toNumber(row.dimensions_scored),
    dimensionsTotal: toNumber(row.dimensions_total),
    dimensions: safeParseJson(row.dimensions_json, {}) || {},
  })).reverse();
}

// 400 days, longer than any other retention here.
//
// Deliberately: this table exists to answer "is the estate getting better", and a year is
// the shortest window in which that question has a useful answer. 400 rows per scope is
// nothing, and pruning it aggressively would defeat the only reason it exists.
export async function pruneHealthHistory(scopeKey, olderThanDays = 400) {
  await ensureProjectStoreReady();
  const cutoff = measurementDay(Date.now() - Math.max(1, olderThanDays) * 24 * 60 * 60 * 1000);
  const result = await withSqlRetry(() =>
    sql.prepare("DELETE FROM health_history WHERE scope_key = ? AND measured_on < ?")
      .bindParams(scopeKey, cutoff).execute()
  );
  return { deleted: toNumber(result?.affectedRows ?? result?.rowsAffected, 0), cutoff };
}

// ── Full scan orchestration state ───────────────────────────────────────────
//
// Kept beside the health history rather than in its own module because the two are the same
// story: the scan is what refreshes every input, and the health row is what it produces at
// the end. Nothing else reads either.

export async function readFullScanMeta(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT state, job_token, current_stage, stages_json, started_at, completed_at, last_error,
             updated_at, polls, scan_type, quick_scan_window_hours
      FROM full_scan_meta WHERE scope_key = ?
    `).bindParams(scopeKey).execute()
  );
  const row = result.rows?.[0];
  if (!row) return null;
  return {
    state: row.state || "idle",
    jobToken: row.job_token || null,
    currentStage: row.current_stage || null,
    stages: safeParseJson(row.stages_json, []) || [],
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    lastError: row.last_error || null,
    // Heartbeat, and how many times the orchestrator has waited on the stage currently in
    // flight. Both added when the orchestrator was finally wired: a handoff stage that dies
    // without writing a terminal state would otherwise hold the whole scan open forever.
    updatedAt: row.updated_at || null,
    polls: toNumber(row.polls),
    // "full" | "quick" | null (a row that predates the quick-scan split, or has never run).
    // Both scan types share this one row deliberately -- they must never run concurrently,
    // since both would otherwise race the same handoff-stage builds -- so which one is
    // currently running has to be recorded, not inferred from the stage list alone.
    scanType: row.scan_type || null,
    // The lookback window a quick scan was started with. Not a closure variable: orchestration
    // is queue-driven across many invocations, so the issues-delta stage rereads this from the
    // row at the moment it actually starts, however many steps into the scan that is.
    quickScanWindowHours: row.quick_scan_window_hours === null || row.quick_scan_window_hours === undefined
      ? null
      : toNumber(row.quick_scan_window_hours),
  };
}

// Merge-patch, like the other snapshot metas: a caller advancing one stage should not have
// to restate the started-at timestamp it does not own.
export async function writeFullScanMeta(scopeKey, patch = {}) {
  await ensureProjectStoreReady();
  const current = (await readFullScanMeta(scopeKey)) || {};
  const next = { ...current, ...patch };

  await withSqlRetry(() =>
    sql.prepare(`
      INSERT INTO full_scan_meta
        (scope_key, state, job_token, current_stage, stages_json, started_at, completed_at,
         last_error, updated_at, polls, scan_type, quick_scan_window_hours)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        state = VALUES(state),
        job_token = VALUES(job_token),
        current_stage = VALUES(current_stage),
        stages_json = VALUES(stages_json),
        started_at = VALUES(started_at),
        completed_at = VALUES(completed_at),
        last_error = VALUES(last_error),
        updated_at = VALUES(updated_at),
        polls = VALUES(polls),
        scan_type = VALUES(scan_type),
        quick_scan_window_hours = VALUES(quick_scan_window_hours)
    `).bindParams(
      scopeKey,
      next.state || "idle",
      next.jobToken || null,
      next.currentStage || null,
      JSON.stringify(next.stages || []),
      next.startedAt || null,
      next.completedAt || null,
      next.lastError || null,
      next.updatedAt || null,
      Number(next.polls) || 0,
      next.scanType || null,
      next.quickScanWindowHours === null || next.quickScanWindowHours === undefined
        ? null
        : Number(next.quickScanWindowHours)
    ).execute()
  );
  return next;
}
