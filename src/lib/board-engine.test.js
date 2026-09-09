import { vi, describe, test, expect, beforeEach } from "vitest";

vi.mock("./jira-api.js", () => ({
  incrMetric: vi.fn(),
  METRIC_NAMES: {
    jiraRequest: "jiraRequest",
    boardSnapshotStarted: "a",
    boardSnapshotCompleted: "b",
    boardSnapshotFailed: "c",
  },
  getBoardPage: vi.fn(),
  getBoardConfiguration: vi.fn(),
  mapWithConcurrency: async (items, _n, fn) => Promise.all(items.map(fn)),
}));
vi.mock("./queues.js", () => ({ inventorySnapshotQueue: { push: vi.fn() } }));
vi.mock("./logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./project-store.js", () => ({
  ensureProjectStoreReady: vi.fn(),
  writeBoardSnapshotMeta: vi.fn(),
  readBoardSnapshotMeta: vi.fn(),
  replaceBoardSnapshot: vi.fn(),
}));

import {
  shapeBoard,
  shapeBoardConfig,
  isBoardBuildStale,
  enumerateBoards,
  queueBoardSnapshotBuild,
  buildBoardSnapshot,
} from "./board-engine.js";
import * as jiraApi from "./jira-api.js";
import { inventorySnapshotQueue } from "./queues.js";
import { replaceBoardSnapshot, writeBoardSnapshotMeta } from "./project-store.js";

beforeEach(() => vi.clearAllMocks());

describe("shapeBoard", () => {
  test("reads a project board's location", () => {
    const row = shapeBoard({ id: 12, name: "PT2 board", type: "scrum", location: { projectId: 100, projectKey: "PT2", projectName: "Prototype & Test" } });
    expect(row).toMatchObject({
      boardId: "12", name: "PT2 board", type: "scrum",
      locationType: "project", locationId: 100, locationKey: "PT2", locationName: "Prototype & Test",
      configReadable: false, columnCount: 0,
    });
  });

  test("reads a personal board's location as a user", () => {
    const row = shapeBoard({ id: 5, name: "My work", type: "kanban", location: { userAccountId: "abc123", displayName: "Alex" } });
    expect(row).toMatchObject({ locationType: "user", locationId: "abc123", locationKey: null, locationName: "Alex" });
  });

  test("returns null for an entry with no id", () => {
    expect(shapeBoard({ name: "orphan" })).toBeNull();
  });
});

describe("shapeBoardConfig", () => {
  test("pulls the backing filter, sub-query, fields and columns", () => {
    const config = shapeBoardConfig({
      filter: { id: 4001 },
      subQuery: { query: "labels = urgent" },
      estimation: { field: { fieldId: "customfield_10016", displayName: "Story Points" } },
      ranking: { rankCustomFieldId: 10019 },
      columnConfig: {
        columns: [
          { name: "To Do", statuses: [{ id: "1" }, { id: "10000" }] },
          { name: "In Progress", statuses: [{ id: "3" }], min: 1, max: 4 },
          { name: "Done", statuses: [{ id: "5" }] },
        ],
      },
    });
    expect(config.filterId).toBe("4001");
    expect(config.subQuery).toBe("labels = urgent");
    expect(config.estimationField).toBe("Story Points");
    expect(config.rankingField).toBe("10019");
    expect(config.columns).toHaveLength(3);
    expect(config.columns[0]).toEqual({ index: 0, name: "To Do", statusIds: ["1", "10000"], min: null, max: null });
    expect(config.columns[1]).toMatchObject({ name: "In Progress", statusIds: ["3"], min: 1, max: 4 });
  });

  test("degrades missing sections to null and an empty column list", () => {
    expect(shapeBoardConfig({})).toEqual({
      filterId: null, subQuery: null, estimationField: null, rankingField: null, columns: [],
    });
  });
});

describe("isBoardBuildStale", () => {
  test("false unless building, true past the window", () => {
    expect(isBoardBuildStale({ state: "ready" })).toBe(false);
    expect(isBoardBuildStale({ state: "building", startedAt: new Date().toISOString() })).toBe(false);
    expect(isBoardBuildStale({ state: "building", startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() })).toBe(true);
    expect(isBoardBuildStale({ state: "building", startedAt: "not-a-date" })).toBe(true);
  });
});

describe("enumerateBoards", () => {
  test("pages until isLast and shapes every entry", async () => {
    jiraApi.getBoardPage
      .mockResolvedValueOnce({ isLast: false, values: [{ id: 1, name: "A" }, { id: 2, name: "B" }] })
      .mockResolvedValueOnce({ isLast: true, values: [{ id: 3, name: "C" }] });

    const boards = await enumerateBoards();

    expect(boards.map((b) => b.boardId)).toEqual(["1", "2", "3"]);
    expect(jiraApi.getBoardPage).toHaveBeenNthCalledWith(1, 0, 50);
    expect(jiraApi.getBoardPage).toHaveBeenNthCalledWith(2, 2, 50);
  });

  test("stops on an empty page even without isLast", async () => {
    jiraApi.getBoardPage.mockResolvedValueOnce({ values: [] });
    expect(await enumerateBoards()).toEqual([]);
    expect(jiraApi.getBoardPage).toHaveBeenCalledTimes(1);
  });
});

describe("queueBoardSnapshotBuild", () => {
  test("marks building then pushes the job", async () => {
    await queueBoardSnapshotBuild("inst");
    expect(writeBoardSnapshotMeta).toHaveBeenCalledWith("inst", expect.objectContaining({ state: "building" }));
    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith({ body: { jobType: "build-board-snapshot", installationKey: "inst" } });
  });
});

describe("buildBoardSnapshot", () => {
  test("enumerates, walks config, and marks the meta ready with totals", async () => {
    jiraApi.getBoardPage.mockResolvedValueOnce({
      isLast: true,
      values: [
        { id: 1, name: "Scrum", type: "scrum", location: { projectId: 10, projectKey: "AAA" } },
        { id: 2, name: "Kanban", type: "kanban", location: { projectId: 11, projectKey: "BBB" } },
      ],
    });
    jiraApi.getBoardConfiguration.mockImplementation(async (id) => ({
      filter: { id: `f${id}` },
      columnConfig: { columns: [{ name: "To Do", statuses: [{ id: "1" }] }, { name: "Done", statuses: [{ id: "5" }] }] },
    }));

    const result = await buildBoardSnapshot("inst");

    expect(result).toMatchObject({ boards: 2, columns: 4, unreadable: 0 });
    const [, version, payload] = replaceBoardSnapshot.mock.calls[0];
    expect(version).toEqual(expect.any(String));
    expect(payload.boards).toHaveLength(2);
    expect(payload.boards[0]).toMatchObject({ filterId: "f1", columnCount: 2, configReadable: true });
    expect(payload.columns).toHaveLength(4);
    expect(payload.columns[0]).toMatchObject({ boardId: "1", index: 0, name: "To Do", statusIds: "1" });
    expect(writeBoardSnapshotMeta).toHaveBeenLastCalledWith("inst", expect.objectContaining({
      state: "ready", totalBoards: 2, totalColumns: 4, boardsUnreadable: 0,
    }));
  });

  test("counts a board whose configuration 404s as unreadable rather than failing the build", async () => {
    jiraApi.getBoardPage.mockResolvedValueOnce({
      isLast: true,
      values: [
        { id: 1, name: "Company", type: "scrum", location: { projectId: 10, projectKey: "AAA" } },
        { id: 2, name: "Team-managed", type: "simple", location: { projectId: 11, projectKey: "BBB" } },
      ],
    });
    jiraApi.getBoardConfiguration.mockImplementation(async (id) => {
      if (String(id) === "2") throw Object.assign(new Error("not found"), { status: 404 });
      return { filter: { id: "f1" }, columnConfig: { columns: [{ name: "Done", statuses: [{ id: "5" }] }] } };
    });

    const result = await buildBoardSnapshot("inst");

    expect(result).toMatchObject({ boards: 2, columns: 1, unreadable: 1 });
    const [, , payload] = replaceBoardSnapshot.mock.calls[0];
    expect(payload.boards.find((b) => b.boardId === "2")).toMatchObject({ configReadable: false, filterId: null, columnCount: 0 });
    expect(writeBoardSnapshotMeta).toHaveBeenLastCalledWith("inst", expect.objectContaining({ state: "ready", boardsUnreadable: 1 }));
  });

  test("marks the build failed and rethrows on a hard error", async () => {
    jiraApi.getBoardPage.mockResolvedValueOnce({ isLast: true, values: [] });
    replaceBoardSnapshot.mockRejectedValueOnce(new Error("sql down"));

    await expect(buildBoardSnapshot("inst")).rejects.toThrow("sql down");
    expect(writeBoardSnapshotMeta).toHaveBeenLastCalledWith("inst", expect.objectContaining({ state: "failed" }));
  });
});
