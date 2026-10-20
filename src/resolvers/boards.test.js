import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks } from "./test-harness.js";
import { __RAW_ADMIN_ONLY_FUNCTIONS } from "../resolvers.js";

const { getBoardInventory, buildBoardInventory } = __RAW_ADMIN_ONLY_FUNCTIONS;

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

describe("getBoardInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("reports never-built when no snapshot exists", async () => {
    mocks.readBoardSnapshotMeta.mockResolvedValue(null);
    const result = await getBoardInventory(ctx);
    expect(result).toMatchObject({ neverBuilt: true, boards: [] });
    expect(result.summary.total).toBe(0);
    expect(mocks.loadBoards).not.toHaveBeenCalled();
  });

  test("joins columns onto boards and summarises the estate", async () => {
    mocks.readBoardSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "v1",
      refreshedAt: "2026-09-09T00:00:00Z",
      boardsUnreadable: 1,
    });
    mocks.loadBoards.mockResolvedValue([
      {
        boardId: "1",
        name: "Scrum",
        type: "scrum",
        locationType: "project",
        locationKey: "AAA",
        filterId: "4001",
        configReadable: true,
        columnCount: 2,
      },
      {
        boardId: "2",
        name: "Mine",
        type: "kanban",
        locationType: "user",
        locationName: "Alex",
        filterId: null,
        configReadable: true,
        columnCount: 1,
      },
      {
        boardId: "3",
        name: "TM",
        type: "simple",
        locationType: "project",
        locationKey: "BBB",
        filterId: null,
        configReadable: false,
        columnCount: 0,
      },
    ]);
    mocks.loadBoardColumns.mockResolvedValue([
      { boardId: "1", index: 0, name: "To Do", statusIds: ["1"] },
      { boardId: "1", index: 1, name: "Done", statusIds: ["5"] },
      { boardId: "2", index: 0, name: "Backlog", statusIds: [] },
    ]);

    const result = await getBoardInventory(ctx);

    expect(result.neverBuilt).toBe(false);
    expect(result.boards).toHaveLength(3);
    expect(result.boards.find((b) => b.boardId === "1").columns).toHaveLength(2);
    expect(result.boards.find((b) => b.boardId === "2").unmappedColumns).toBe(1);
    expect(result.summary).toMatchObject({
      total: 3,
      personal: 1,
      unreadable: 1,
      // board 2: config readable, no filter
      missingFilter: 1,
      totalColumns: 3,
    });
    expect(result.summary.byType).toEqual({ scrum: 1, kanban: 1, simple: 1 });
  });

  test("joins against the filter and status snapshots and flags a deleted backing filter", async () => {
    mocks.readBoardSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1", refreshedAt: "x" });
    mocks.loadBoards.mockResolvedValue([
      {
        boardId: "1",
        name: "Scrum",
        type: "scrum",
        locationType: "project",
        locationKey: "AAA",
        filterId: "GONE",
        configReadable: true,
        columnCount: 1,
      },
    ]);
    mocks.loadBoardColumns.mockResolvedValue([{ boardId: "1", index: 0, name: "To Do", statusIds: ["1", "deleted"] }]);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "fv1" });
    mocks.loadFilters.mockResolvedValue([{ id: "4001", ownerActive: true }]); // no filter GONE
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "wv1" });
    mocks.loadStatusesCatalog.mockResolvedValue([{ id: "1", name: "To Do" }]); // no status "deleted"

    const result = await getBoardInventory(ctx);

    expect(result.insights).toMatchObject({
      missingFilter: 1,
      staleColumnBoards: 1,
      joinedFilters: true,
      joinedStatuses: true,
    });
    expect(result.summary.brokenFilter).toBe(1);
    expect(result.summary.staleColumnBoards).toBe(1);
    // Per-board codes, uncapped, for the pillar report.
    expect(result.boards[0].issues).toEqual(["backing-filter-deleted", "stale-column-status"]);
  });

  test("reports the joins as not-run when the other snapshots are absent", async () => {
    mocks.readBoardSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1", refreshedAt: "x" });
    mocks.loadBoards.mockResolvedValue([
      {
        boardId: "1",
        name: "B",
        type: "scrum",
        locationType: "project",
        filterId: "4001",
        configReadable: true,
        columnCount: 0,
      },
    ]);
    mocks.loadBoardColumns.mockResolvedValue([]);
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    mocks.readWorkflowSnapshotMeta.mockResolvedValue(null);

    const result = await getBoardInventory(ctx);
    expect(result.insights).toMatchObject({ joinedFilters: false, joinedStatuses: false, missingFilter: 0 });
  });
});

describe("buildBoardInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("queues a build when nothing is running", async () => {
    mocks.readBoardSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.readAdminConfig?.mockResolvedValue?.({ readOnlyMode: false });

    const result = await buildBoardInventory(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueBoardSnapshotBuild).toHaveBeenCalledWith("test-install");
  });

  test("refuses while a live build is running", async () => {
    mocks.readBoardSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isBoardBuildStale.mockReturnValue(false);

    const result = await buildBoardInventory(ctx);

    expect(result).toMatchObject({ queued: false, reason: "already-building" });
    expect(mocks.queueBoardSnapshotBuild).not.toHaveBeenCalled();
  });
});
