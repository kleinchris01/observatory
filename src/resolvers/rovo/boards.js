// Rovo actions. Board actions for Rovo: search, inspect and impact.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES } from "../../lib/jira-api.js";
import { pillarUnavailable, agentOk, agentNotFound, rankMatches, clampResults } from "../../lib/rovo-agents.js";
import { getBoardInventory } from "../boards.js";

// ── Rovo: boards expert ────────────────────────────────────────────────────
//
// Agile boards, their backing filter and column mapping, over getBoardInventory (which runs
// the filter and status joins). Impact answers "which boards use this filter or status" --
// what would break if it changed.

export async function rovoBoardSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const query = String(payload?.query || "").trim();
    const type = String(payload?.type || "any")
      .trim()
      .toLowerCase();
    const limit = clampResults(payload?.maxResults, 10, 25);
    if (!query) return { status: "error", message: "A search query is required." };

    const inv = await getBoardInventory({ context });
    if (inv.neverBuilt) return pillarUnavailable("boards", { state: inv.state, refreshedAt: null });

    let rows = inv.boards || [];
    if (["scrum", "kanban", "simple"].includes(type)) rows = rows.filter((b) => b.type === type);
    const matches = rankMatches(rows, query, (b) => [b.name, b.locationKey, b.locationName], limit);

    return agentOk(inv.refreshedAt || null, {
      query,
      boards: matches.map((b) => ({
        boardId: b.boardId,
        name: b.name,
        type: b.type,
        location:
          b.locationType === "user" ? `personal (${b.locationName || "unknown"})` : b.locationKey || "no project",
        backingFilterId: b.filterId,
        columnCount: b.columnCount,
        configReadable: b.configReadable,
      })),
      total: rows.length,
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoBoardSearch failed:", error);
    throw error;
  }
}

export async function rovoBoardInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const boardId = String(payload?.boardId || "").trim();
    const name = String(payload?.name || "").trim();
    if (!boardId && !name) return { status: "error", message: "A boardId or name is required. Use search first." };

    const inv = await getBoardInventory({ context });
    if (inv.neverBuilt) return pillarUnavailable("boards", { state: inv.state, refreshedAt: null });

    const rows = inv.boards || [];
    const board = boardId
      ? rows.find((b) => String(b.boardId) === boardId)
      : rows.find((b) => String(b.name || "").toLowerCase() === name.toLowerCase());
    if (!board)
      return agentNotFound(
        inv.refreshedAt || null,
        `No board ${boardId ? `with id ${boardId}` : `named "${name}"`} in the current snapshot.`,
      );

    const flagged = (inv.insights?.flagged || []).find((f) => String(f.boardId) === String(board.boardId));

    return agentOk(inv.refreshedAt || null, {
      board: {
        boardId: board.boardId,
        name: board.name,
        type: board.type,
        location:
          board.locationType === "user"
            ? `personal (${board.locationName || "unknown"})`
            : board.locationKey || "no project",
        backingFilterId: board.filterId,
        estimationField: board.estimationField || null,
        rankingField: board.rankingField || null,
        subQuery: board.subQuery || null,
        configReadable: board.configReadable,
      },
      columns: (board.columns || []).map((c) => ({
        index: c.index,
        name: c.name,
        statusCount: (c.statusIds || []).length,
      })),
      unmappedColumns: board.unmappedColumns,
      issues: flagged?.issues || [],
      joinsRun: { filters: inv.insights?.joinedFilters ?? false, statuses: inv.insights?.joinedStatuses ?? false },
      dataCaveat:
        "Board administrators are not exposed by the public REST API, so 'who can change this board' is not captured -- it is governed by the backing filter's edit permissions.",
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoBoardInspect failed:", error);
    throw error;
  }
}

export async function rovoBoardImpact(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const filterId = String(payload?.filterId || "").trim();
    const statusId = String(payload?.statusId || "").trim();
    if (!filterId && !statusId) {
      return {
        status: "error",
        message:
          "A filterId or statusId is required -- this answers which boards would break if that filter or status changed.",
      };
    }

    const inv = await getBoardInventory({ context });
    if (inv.neverBuilt) return pillarUnavailable("boards", { state: inv.state, refreshedAt: null });

    const rows = inv.boards || [];
    const byFilter = filterId ? rows.filter((b) => String(b.filterId) === filterId) : [];
    const byStatus = statusId
      ? rows.filter((b) => (b.columns || []).some((c) => (c.statusIds || []).map(String).includes(statusId)))
      : [];

    return agentOk(inv.refreshedAt || null, {
      filterId: filterId || null,
      statusId: statusId || null,
      boardsBackedByFilter: byFilter.map((b) => ({ boardId: b.boardId, name: b.name, type: b.type })),
      boardsMappingStatus: byStatus.map((b) => ({
        boardId: b.boardId,
        name: b.name,
        columns: (b.columns || []).filter((c) => (c.statusIds || []).map(String).includes(statusId)).map((c) => c.name),
      })),
      verdict: byFilter.length + byStatus.length === 0 ? "no-board-references-it" : "referenced",
      verdictCaveat:
        "Only boards whose configuration was readable are covered -- team-managed boards whose /configuration endpoint 404'd are not in this answer.",
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoBoardImpact failed:", error);
    throw error;
  }
}
