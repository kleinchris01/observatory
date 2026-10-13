// Boards pillar: inventory read and snapshot build.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES, getInstallationKey } from "../lib/jira-api.js";
import {
  ensureProjectStoreReady,
  loadFilters,
  readFilterSnapshotMeta,
  readWorkflowSnapshotMeta,
  loadStatusesCatalog,
  readBoardSnapshotMeta,
  loadBoards,
  loadBoardColumns,
} from "../lib/project-store.js";
import { queueBoardSnapshotBuild, isBoardBuildStale } from "../lib/board-engine.js";
import { summarizeBoardInsights, boardIssues, indexFiltersById } from "../lib/board-insights.js";
import { readAdminConfig } from "./admin-config.js";

// The boards pillar's read: every agile board with its backing filter, location and column
// mapping. Structure only -- the cross-pillar joins (broken backing filter, statuses not
// mapped to a column, personal boards owned by inactive users) and the governance score
// arrive with B2/B3.
export async function getBoardInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readBoardSnapshotMeta(installationKey);
  const staleBuild = isBoardBuildStale(meta);

  if (!meta?.version) {
    return {
      state: meta?.state || "idle",
      staleBuild,
      startedAt: meta?.startedAt || null,
      neverBuilt: true,
      boards: [],
      summary: { total: 0, byType: {}, personal: 0, unreadable: 0, missingFilter: 0, totalColumns: 0 },
      lastError: meta?.lastError || null,
    };
  }

  const [boards, columns, filterMeta, workflowMeta] = await Promise.all([
    loadBoards(installationKey, meta.version),
    loadBoardColumns(installationKey, meta.version),
    readFilterSnapshotMeta(installationKey).catch(() => null),
    readWorkflowSnapshotMeta(installationKey).catch(() => null),
  ]);

  // The two cross-pillar joins. Each is best-effort: a missing snapshot means that check did
  // not run, which summarizeBoardInsights reports as joinedFilters / joinedStatuses rather
  // than as a clean bill of health.
  const [filters, statusCatalog] = await Promise.all([
    filterMeta?.version ? loadFilters(installationKey, filterMeta.version).catch(() => null) : Promise.resolve(null),
    workflowMeta?.version ? loadStatusesCatalog(installationKey, workflowMeta.version).catch(() => null) : Promise.resolve(null),
  ]);
  const knownStatusIds = statusCatalog ? new Set(statusCatalog.map((s) => String(s.id ?? s.statusId))) : null;

  const columnsByBoard = new Map();
  for (const col of columns) {
    if (!columnsByBoard.has(col.boardId)) columnsByBoard.set(col.boardId, []);
    columnsByBoard.get(col.boardId).push(col);
  }

  const filterById = indexFiltersById(filters);
  const rows = boards.map((board) => {
    const cols = columnsByBoard.get(board.boardId) || [];
    const withColumns = {
      ...board,
      columns: cols,
      unmappedColumns: cols.filter((c) => c.statusIds.length === 0).length,
    };
    // Every board's own finding codes, uncapped -- insights.flagged stops at 50, and the
    // pillar report needs the full set.
    return { ...withColumns, issues: boardIssues(withColumns, filterById, knownStatusIds) };
  });

  const byType = {};
  for (const board of rows) {
    const key = board.type || "unknown";
    byType[key] = (byType[key] || 0) + 1;
  }

  const insights = summarizeBoardInsights({ boards: rows, filters, knownStatusIds });

  return {
    state: meta.state || "ready",
    staleBuild,
    refreshedAt: meta.refreshedAt || null,
    neverBuilt: false,
    lastError: meta.lastError || null,
    boards: rows,
    insights,
    summary: {
      total: rows.length,
      byType,
      personal: rows.filter((board) => board.locationType === "user").length,
      // Boards whose /configuration endpoint 404'd -- their column and filter facts are unknown.
      unreadable: Number(meta.boardsUnreadable) || 0,
      // Config was readable but named no backing filter.
      missingFilter: rows.filter((board) => board.configReadable && !board.filterId).length,
      // Config named a filter id that is not in the filter snapshot -- deleted out from under it.
      brokenFilter: insights.missingFilter,
      inactiveFilterOwner: insights.inactiveFilterOwner,
      staleColumnBoards: insights.staleColumnBoards,
      totalColumns: columns.length,
    },
  };
}

export async function buildBoardInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readBoardSnapshotMeta(installationKey);
  if (meta?.state === "building" && !isBoardBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before building the board inventory." };
  }

  await queueBoardSnapshotBuild(installationKey);
  return { queued: true };
}
