// Storage for the boards pillar: agile boards and their column-to-status mapping, versioned.
// Two tables -- one row per board, one per column -- fully replaced per scope. A site has a
// few hundred boards at most, so the build finishes in one invocation and never appends to a
// partial version. Imports only from core.js: one arrow, no cycle.

import { sql } from "@forge/sql";
import { chunkArray, ensureProjectStoreReady, toNumber, withSqlRetry } from "./core.js";

const BATCH = 50;

// Replace the whole board snapshot for a scope at a version. `boards` are the shaped rows
// from board-engine; `columns` is the flattened [{ boardId, index, name, statusIds, min, max }].
export async function replaceBoardSnapshot(scopeKey, version, { boards = [], columns = [] } = {}) {
  await ensureProjectStoreReady();

  await withSqlRetry(() =>
    sql.prepare(`DELETE FROM snapshot_boards WHERE scope_key = ?`).bindParams(scopeKey).execute(),
  );
  await withSqlRetry(() =>
    sql.prepare(`DELETE FROM snapshot_board_columns WHERE scope_key = ?`).bindParams(scopeKey).execute(),
  );

  for (const b of chunkArray(boards, BATCH)) {
    const valuesSql = b.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = b.flatMap((row) => [
      scopeKey,
      version,
      String(row.boardId),
      row.name || null,
      row.type || null,
      row.locationType || null,
      row.locationId != null ? String(row.locationId) : null,
      row.locationKey || null,
      row.locationName || null,
      row.filterId != null ? String(row.filterId) : null,
      row.subQuery || null,
      row.estimationField || null,
      row.rankingField != null ? String(row.rankingField) : null,
      Number(row.columnCount) || 0,
      row.configReadable === false ? 0 : 1,
    ]);
    await withSqlRetry(() =>
      sql
        .prepare(
          `
        INSERT INTO snapshot_boards
          (scope_key, version, board_id, name, type, location_type, location_id,
           location_key, location_name, filter_id, sub_query, estimation_field,
           ranking_field, column_count, config_readable)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE name = VALUES(name), type = VALUES(type),
          location_type = VALUES(location_type), location_id = VALUES(location_id),
          location_key = VALUES(location_key), location_name = VALUES(location_name),
          filter_id = VALUES(filter_id), sub_query = VALUES(sub_query),
          estimation_field = VALUES(estimation_field), ranking_field = VALUES(ranking_field),
          column_count = VALUES(column_count), config_readable = VALUES(config_readable)
      `,
        )
        .bindParams(...params)
        .execute(),
    );
  }

  for (const c of chunkArray(columns, BATCH)) {
    const valuesSql = c.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = c.flatMap((row) => [
      scopeKey,
      version,
      String(row.boardId),
      Number(row.index) || 0,
      row.name || null,
      row.statusIds || null,
      row.min != null ? Number(row.min) : null,
      row.max != null ? Number(row.max) : null,
    ]);
    await withSqlRetry(() =>
      sql
        .prepare(
          `
        INSERT INTO snapshot_board_columns
          (scope_key, version, board_id, column_index, name, status_ids, min_constraint, max_constraint)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE name = VALUES(name), status_ids = VALUES(status_ids),
          min_constraint = VALUES(min_constraint), max_constraint = VALUES(max_constraint)
      `,
        )
        .bindParams(...params)
        .execute(),
    );
  }
}

export async function loadBoards(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT board_id, name, type, location_type, location_id, location_key, location_name,
             filter_id, sub_query, estimation_field, ranking_field, column_count, config_readable
      FROM snapshot_boards
      WHERE scope_key = ? AND version = ?
      ORDER BY name ASC, board_id ASC
    `,
      )
      .bindParams(scopeKey, version)
      .execute(),
  );
  return (result.rows || []).map((row) => ({
    boardId: row.board_id,
    name: row.name || row.board_id,
    type: row.type || null,
    locationType: row.location_type || null,
    locationId: row.location_id || null,
    locationKey: row.location_key || null,
    locationName: row.location_name || null,
    filterId: row.filter_id || null,
    subQuery: row.sub_query || null,
    estimationField: row.estimation_field || null,
    rankingField: row.ranking_field || null,
    columnCount: toNumber(row.column_count),
    configReadable: Boolean(toNumber(row.config_readable)),
  }));
}

export async function loadBoardColumns(scopeKey, version, boardId = null) {
  await ensureProjectStoreReady();
  const where = boardId != null ? `scope_key = ? AND version = ? AND board_id = ?` : `scope_key = ? AND version = ?`;
  const params = boardId != null ? [scopeKey, version, String(boardId)] : [scopeKey, version];
  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT board_id, column_index, name, status_ids, min_constraint, max_constraint
      FROM snapshot_board_columns
      WHERE ${where}
      ORDER BY board_id ASC, column_index ASC
    `,
      )
      .bindParams(...params)
      .execute(),
  );
  return (result.rows || []).map((row) => ({
    boardId: row.board_id,
    index: toNumber(row.column_index),
    name: row.name || null,
    statusIds: row.status_ids ? String(row.status_ids).split(",").filter(Boolean) : [],
    min: row.min_constraint != null ? toNumber(row.min_constraint) : null,
    max: row.max_constraint != null ? toNumber(row.max_constraint) : null,
  }));
}

export async function readBoardSnapshotMeta(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql
      .prepare(
        `
      SELECT state, version, started_at, completed_at, refreshed_at,
             total_boards, total_columns, boards_unreadable, last_error
      FROM board_snapshot_meta WHERE scope_key = ?
    `,
      )
      .bindParams(scopeKey)
      .execute(),
  );
  const row = result.rows?.[0];
  if (!row) return null;
  return {
    state: row.state || "idle",
    version: row.version || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    refreshedAt: row.refreshed_at || null,
    totalBoards: toNumber(row.total_boards),
    totalColumns: toNumber(row.total_columns),
    boardsUnreadable: toNumber(row.boards_unreadable),
    lastError: row.last_error || null,
  };
}

export async function writeBoardSnapshotMeta(scopeKey, patch = {}) {
  await ensureProjectStoreReady();
  const current = (await readBoardSnapshotMeta(scopeKey)) || {};
  const next = { ...current, ...patch };

  await withSqlRetry(() =>
    sql
      .prepare(
        `
      INSERT INTO board_snapshot_meta
        (scope_key, state, version, started_at, completed_at, refreshed_at,
         total_boards, total_columns, boards_unreadable, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        state = VALUES(state),
        version = VALUES(version),
        started_at = VALUES(started_at),
        completed_at = VALUES(completed_at),
        refreshed_at = VALUES(refreshed_at),
        total_boards = VALUES(total_boards),
        total_columns = VALUES(total_columns),
        boards_unreadable = VALUES(boards_unreadable),
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
        next.totalBoards ?? 0,
        next.totalColumns ?? 0,
        next.boardsUnreadable ?? 0,
        next.lastError || null,
      )
      .execute(),
  );
}
