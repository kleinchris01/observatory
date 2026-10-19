import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, ctxWithAccount } from "../test-harness.js";
import { rovoBoardSearch, rovoBoardInspect, rovoBoardImpact } from "../../resolvers.js";

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

describe("rovo boards agent", () => {
  const ctx = () => ctxWithAccount();

  function seedBoards() {
    mocks.readBoardSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "v1",
      refreshedAt: "2026-09-09T00:00:00Z",
    });
    mocks.loadBoards.mockResolvedValue([
      {
        boardId: "1",
        name: "PT2 Scrum",
        type: "scrum",
        locationType: "project",
        locationKey: "PT2",
        filterId: "4001",
        configReadable: true,
        columnCount: 2,
      },
      {
        boardId: "2",
        name: "Kanban Wall",
        type: "kanban",
        locationType: "project",
        locationKey: "AAA",
        filterId: null,
        configReadable: true,
        columnCount: 1,
      },
    ]);
    mocks.loadBoardColumns.mockResolvedValue([
      { boardId: "1", index: 0, name: "To Do", statusIds: ["10"] },
      { boardId: "1", index: 1, name: "Done", statusIds: ["5"] },
      { boardId: "2", index: 0, name: "Backlog", statusIds: [] },
    ]);
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    mocks.readWorkflowSnapshotMeta.mockResolvedValue(null);
  }

  test("search: unavailable when no board snapshot exists", async () => {
    mocks.readBoardSnapshotMeta.mockResolvedValue(null);
    const r = await rovoBoardSearch({ query: "scrum" }, ctx());
    expect(r.status).toBe("boards-unavailable");
  });

  test("search: matches by name and can filter by type", async () => {
    seedBoards();
    const all = await rovoBoardSearch({ query: "wall" }, ctx());
    expect(all.status).toBe("ok");
    expect(all.boards.map((b) => b.name)).toContain("Kanban Wall");

    const scrum = await rovoBoardSearch({ query: "board", type: "scrum" }, ctx());
    expect(scrum.boards.every((b) => b.type === "scrum")).toBe(true);
  });

  test("search: rejects an empty query", async () => {
    expect((await rovoBoardSearch({ query: "" }, ctx())).status).toBe("error");
  });

  test("inspect: returns one board with its columns and flags", async () => {
    seedBoards();
    const r = await rovoBoardInspect({ boardId: "2" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.board).toMatchObject({ name: "Kanban Wall", backingFilterId: null });
    expect(r.unmappedColumns).toBe(1);
    expect(r.issues).toContain("no-backing-filter");
    expect(r.joinsRun).toEqual({ filters: false, statuses: false });
  });

  test("inspect: an unknown board is not-found", async () => {
    seedBoards();
    expect((await rovoBoardInspect({ boardId: "999" }, ctx())).status).toBe("not-found");
  });

  test("inspect: requires an id or a name", async () => {
    expect((await rovoBoardInspect({}, ctx())).status).toBe("error");
  });

  test("impact: which boards a filter backs", async () => {
    seedBoards();
    const r = await rovoBoardImpact({ filterId: "4001" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.boardsBackedByFilter.map((b) => b.boardId)).toEqual(["1"]);
    expect(r.verdict).toBe("referenced");
  });

  test("impact: which boards map a status, and a clean verdict when none do", async () => {
    seedBoards();
    const hit = await rovoBoardImpact({ statusId: "10" }, ctx());
    expect(hit.boardsMappingStatus[0]).toMatchObject({ boardId: "1", columns: ["To Do"] });

    const miss = await rovoBoardImpact({ statusId: "nonexistent" }, ctx());
    expect(miss.verdict).toBe("no-board-references-it");
  });

  test("impact: requires a filterId or statusId", async () => {
    expect((await rovoBoardImpact({}, ctx())).status).toBe("error");
  });

  test("inspect: resolves a board by name, case-insensitively", async () => {
    seedBoards();
    const r = await rovoBoardInspect({ name: "kanban wall" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.board.boardId).toBe("2");
  });

  test("inspect: an unknown name is not-found and names what was looked for", async () => {
    seedBoards();
    const r = await rovoBoardInspect({ name: "Ghost Board" }, ctx());
    expect(r.status).toBe("not-found");
    expect(r.message).toMatch(/Ghost Board/);
  });

  test("search / inspect / impact all propagate an inventory failure rather than swallowing it", async () => {
    mocks.readBoardSnapshotMeta.mockRejectedValue(new Error("board store down"));
    await expect(rovoBoardSearch({ query: "x" }, ctx())).rejects.toThrow("board store down");
    await expect(rovoBoardInspect({ boardId: "1" }, ctx())).rejects.toThrow("board store down");
    await expect(rovoBoardImpact({ filterId: "1" }, ctx())).rejects.toThrow("board store down");
  });
});
