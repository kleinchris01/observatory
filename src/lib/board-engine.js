// Builds the boards snapshot: every agile board, where it lives, the saved filter behind it,
// and its column-to-status mapping.
//
// Two phases in one invocation, like the screen build before it went resumable: a paginated
// list, then one configuration call per board. A site's board count is in the low hundreds,
// so this fits one consumer invocation -- if a site is ever found where it does not, this
// gains a cursor the way the dashboard build did. A board whose configuration endpoint 404s
// (team-managed boards often do) is still listed; its column and backing-filter facts are
// recorded as unknown rather than dropped, and counted in `boardsUnreadable`.

import { logger } from "./logger.js";
import { inventorySnapshotQueue } from "./queues.js";
import {
  incrMetric,
  METRIC_NAMES,
  getBoardPage,
  getBoardConfiguration,
  mapWithConcurrency,
} from "./jira-api.js";
import {
  ensureProjectStoreReady,
  writeBoardSnapshotMeta,
  readBoardSnapshotMeta,
  replaceBoardSnapshot,
} from "./project-store.js";

// Matches the other structural builds: the consumer ceiling is 900s, plus a minute so a
// build finishing right at the limit is never declared stale out from under itself.
export const BOARD_BUILD_STALE_MS = 16 * 60 * 1000;

// One configuration request per board; 4 in flight, matching the app's own limiter rather
// than racing it -- the same concurrency the screen and dashboard walks use.
export const BOARD_CONFIG_CONCURRENCY = 4;

export const BOARD_PAGE_SIZE = 50;

// A hard ceiling on enumeration so a misbehaving endpoint that never sets isLast cannot spin
// forever. 200 pages is 10,000 boards -- far past any real site.
export const BOARD_MAX_PAGES = 200;

export function isBoardBuildStale(meta, now = Date.now()) {
  if (meta?.state !== "building") return false;
  const startedAt = Date.parse(meta?.startedAt || "");
  if (!Number.isFinite(startedAt)) return true;
  return now - startedAt > BOARD_BUILD_STALE_MS;
}

// Jira's board-list entry -> the row shape the store writes. Pure, so the shredding is
// testable without a Jira. `location` is a union: a project board carries projectId/projectKey,
// a personal board carries a userAccountId and a displayName.
export function shapeBoard(raw) {
  const id = String(raw?.id ?? "").trim();
  if (!id) return null;
  const loc = raw?.location || {};
  const locationType = loc.projectId != null || loc.projectKey ? "project"
    : loc.userAccountId || loc.userId ? "user"
      : loc.type || null;
  return {
    boardId: id,
    name: raw?.name ?? null,
    type: raw?.type ?? null,
    locationType,
    locationId: loc.projectId ?? loc.userAccountId ?? loc.userId ?? null,
    locationKey: loc.projectKey ?? null,
    locationName: loc.projectName ?? loc.name ?? loc.displayName ?? null,
    // Filled by the config walk; null until then and null forever if it 404s.
    filterId: null,
    subQuery: null,
    estimationField: null,
    rankingField: null,
    columnCount: 0,
    configReadable: false,
  };
}

// A board's configuration payload -> the fields the snapshot keeps, plus the flattened
// columns. Pure. Missing sections degrade to null / [] rather than throwing.
export function shapeBoardConfig(raw) {
  const columnsRaw = Array.isArray(raw?.columnConfig?.columns) ? raw.columnConfig.columns : [];
  const columns = columnsRaw.map((col, index) => ({
    index,
    name: col?.name ?? null,
    statusIds: (Array.isArray(col?.statuses) ? col.statuses : [])
      .map((s) => String(s?.id ?? "").trim())
      .filter(Boolean),
    min: col?.min != null ? Number(col.min) : null,
    max: col?.max != null ? Number(col.max) : null,
  }));
  return {
    filterId: raw?.filter?.id != null ? String(raw.filter.id) : null,
    subQuery: raw?.subQuery?.query ?? null,
    estimationField: raw?.estimation?.field?.displayName ?? raw?.estimation?.field?.fieldId ?? null,
    rankingField: raw?.ranking?.rankCustomFieldId != null ? String(raw.ranking.rankCustomFieldId) : null,
    columns,
  };
}

// Walk every page of the board list. Drives its own pagination off `isLast` because the
// agile endpoint's `total` is unreliable on large sites.
export async function enumerateBoards() {
  const boards = [];
  let startAt = 0;
  for (let page = 0; page < BOARD_MAX_PAGES; page++) {
    incrMetric(METRIC_NAMES.jiraRequest);
    const data = await getBoardPage(startAt, BOARD_PAGE_SIZE);
    const values = Array.isArray(data?.values) ? data.values : [];
    for (const entry of values) {
      const shaped = shapeBoard(entry);
      if (shaped) boards.push(shaped);
    }
    startAt += values.length;
    if (!values.length || data?.isLast === true) break;
  }
  return boards;
}

export async function queueBoardSnapshotBuild(installationKey) {
  await ensureProjectStoreReady();
  await writeBoardSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });
  await inventorySnapshotQueue.push({ body: { jobType: "build-board-snapshot", installationKey } });
}

export async function buildBoardSnapshot(installationKey) {
  incrMetric(METRIC_NAMES.boardSnapshotStarted);
  await ensureProjectStoreReady();
  await writeBoardSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });

  try {
    const version = String(Date.now());
    const boards = await enumerateBoards();

    let unreadable = 0;
    const columns = [];

    await mapWithConcurrency(boards, BOARD_CONFIG_CONCURRENCY, async (board) => {
      try {
        incrMetric(METRIC_NAMES.jiraRequest);
        const config = shapeBoardConfig(await getBoardConfiguration(board.boardId));
        board.filterId = config.filterId;
        board.subQuery = config.subQuery;
        board.estimationField = config.estimationField;
        board.rankingField = config.rankingField;
        board.columnCount = config.columns.length;
        board.configReadable = true;
        for (const col of config.columns) {
          columns.push({
            boardId: board.boardId,
            index: col.index,
            name: col.name,
            statusIds: col.statusIds.join(","),
            min: col.min,
            max: col.max,
          });
        }
      } catch (error) {
        // One unreadable board, not a dead build -- team-managed boards routinely 404 here.
        unreadable += 1;
        logger.warn("board-snapshot.config_failed", {
          installationKey, boardId: board.boardId, error: String(error?.message || error),
        });
      }
    });

    await replaceBoardSnapshot(installationKey, version, { boards, columns });

    const completedAt = new Date().toISOString();
    await writeBoardSnapshotMeta(installationKey, {
      state: "ready",
      version,
      completedAt,
      refreshedAt: completedAt,
      totalBoards: boards.length,
      totalColumns: columns.length,
      boardsUnreadable: unreadable,
      lastError: null,
    });

    incrMetric(METRIC_NAMES.boardSnapshotCompleted);
    logger.info("board-snapshot.completed", {
      version, boards: boards.length, columns: columns.length, unreadable,
    });
    return { version, boards: boards.length, columns: columns.length, unreadable };
  } catch (error) {
    incrMetric(METRIC_NAMES.boardSnapshotFailed);
    const message = String(error?.message || error);
    logger.error("board-snapshot.failed", { error: message });
    await writeBoardSnapshotMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: message,
    });
    throw error;
  }
}
