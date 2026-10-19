import { vi, describe, test, expect, beforeEach } from "vitest";

// Storage for the boards pillar. Tested directly against a mocked Forge SQL, like
// store/estate.test.js -- an unscoped DELETE or a bind-arity bug hides here.

vi.mock("@forge/sql", () => {
  const runner = { enqueue: () => runner, run: vi.fn().mockResolvedValue(undefined) };
  return {
    sql: {
      prepare: vi.fn().mockReturnValue({
        bindParams: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
      }),
    },
    migrationRunner: runner,
  };
});

import { sql } from "@forge/sql";
import {
  replaceBoardSnapshot,
  loadBoards,
  loadBoardColumns,
  readBoardSnapshotMeta,
  writeBoardSnapshotMeta,
} from "./boards.js";

let issued = [];
let nextRows = [];

function harness() {
  issued = [];
  sql.prepare.mockImplementation((statement) => {
    const entry = { statement: String(statement), params: null };
    issued.push(entry);
    const stub = {
      bindParams: (...params) => {
        entry.params = params;
        return stub;
      },
      execute: () => Promise.resolve({ rows: nextRows }),
    };
    return stub;
  });
}

const find = (match) => issued.find((e) => e.statement.includes(match));
const findAll = (match) => issued.filter((e) => e.statement.includes(match));
const mockRows = (rows) => {
  nextRows = rows;
};

beforeEach(() => {
  vi.clearAllMocks();
  nextRows = [];
  harness();
});

describe("replaceBoardSnapshot", () => {
  test("deletes only this scope from both tables, then inserts boards (15 cols) and columns (8 cols)", async () => {
    await replaceBoardSnapshot("inst", "v1", {
      boards: [
        {
          boardId: "1",
          name: "Scrum",
          type: "scrum",
          locationType: "project",
          locationId: 10,
          locationKey: "AAA",
          locationName: "Alpha",
          filterId: 4001,
          subQuery: "labels = x",
          estimationField: "Story Points",
          rankingField: 10019,
          columnCount: 2,
          configReadable: true,
        },
      ],
      columns: [
        { boardId: "1", index: 0, name: "To Do", statusIds: "1,2", min: null, max: null },
        { boardId: "1", index: 1, name: "Done", statusIds: "5", min: 1, max: 4 },
      ],
    });

    const delBoards = find("DELETE FROM snapshot_boards");
    expect(delBoards.statement).toContain("WHERE scope_key = ?");
    expect(delBoards.params).toEqual(["inst"]);
    expect(find("DELETE FROM snapshot_board_columns").params).toEqual(["inst"]);

    const insBoards = find("INSERT INTO snapshot_boards");
    expect(insBoards.params).toHaveLength(15);
    expect(insBoards.params.slice(0, 6)).toEqual(["inst", "v1", "1", "Scrum", "scrum", "project"]);
    // ids are stringified, config_readable is 1
    expect(insBoards.params[6]).toBe("10");
    expect(insBoards.params[9]).toBe("4001");
    expect(insBoards.params[14]).toBe(1);

    const insCols = find("INSERT INTO snapshot_board_columns");
    expect(insCols.params).toHaveLength(16); // 8 cols * 2 rows
    expect(insCols.params.slice(0, 8)).toEqual(["inst", "v1", "1", 0, "To Do", "1,2", null, null]);
    expect(insCols.params.slice(8, 16)).toEqual(["inst", "v1", "1", 1, "Done", "5", 1, 4]);
  });

  test("clears both tables even with nothing to write", async () => {
    await replaceBoardSnapshot("inst", "v1", {});
    expect(find("DELETE FROM snapshot_boards")).toBeTruthy();
    expect(find("DELETE FROM snapshot_board_columns")).toBeTruthy();
    expect(find("INSERT INTO snapshot_boards")).toBeUndefined();
    expect(find("INSERT INTO snapshot_board_columns")).toBeUndefined();
  });

  test("config_readable is 0 when the board's configuration could not be read", async () => {
    await replaceBoardSnapshot("inst", "v1", {
      boards: [{ boardId: "9", name: "Team-managed", configReadable: false }],
    });
    expect(find("INSERT INTO snapshot_boards").params[14]).toBe(0);
  });
});

describe("loadBoards", () => {
  test("scopes by scope+version and maps the rows", async () => {
    mockRows([
      {
        board_id: "1",
        name: "Scrum",
        type: "scrum",
        location_type: "project",
        location_id: "10",
        location_key: "AAA",
        location_name: "Alpha",
        filter_id: "4001",
        sub_query: null,
        estimation_field: "Story Points",
        ranking_field: "10019",
        column_count: 3,
        config_readable: 1,
      },
    ]);
    const rows = await loadBoards("inst", "v1");
    expect(rows[0]).toEqual({
      boardId: "1",
      name: "Scrum",
      type: "scrum",
      locationType: "project",
      locationId: "10",
      locationKey: "AAA",
      locationName: "Alpha",
      filterId: "4001",
      subQuery: null,
      estimationField: "Story Points",
      rankingField: "10019",
      columnCount: 3,
      configReadable: true,
    });
    expect(find("FROM snapshot_boards").params).toEqual(["inst", "v1"]);
  });
});

describe("loadBoardColumns", () => {
  test("splits the status id list and can scope to one board", async () => {
    mockRows([
      { board_id: "1", column_index: 0, name: "To Do", status_ids: "1,2,3", min_constraint: null, max_constraint: 5 },
    ]);
    const cols = await loadBoardColumns("inst", "v1", "1");
    expect(cols[0]).toEqual({ boardId: "1", index: 0, name: "To Do", statusIds: ["1", "2", "3"], min: null, max: 5 });
    expect(find("FROM snapshot_board_columns").params).toEqual(["inst", "v1", "1"]);
  });

  test("omits the board filter when no board id is given", async () => {
    mockRows([]);
    await loadBoardColumns("inst", "v1");
    expect(find("FROM snapshot_board_columns").params).toEqual(["inst", "v1"]);
  });
});

describe("board snapshot meta", () => {
  test("readBoardSnapshotMeta returns null with no row", async () => {
    mockRows([]);
    expect(await readBoardSnapshotMeta("inst")).toBeNull();
  });

  test("writeBoardSnapshotMeta upserts the totals", async () => {
    mockRows([]);
    await writeBoardSnapshotMeta("inst", {
      state: "ready",
      version: "v2",
      totalBoards: 40,
      totalColumns: 190,
      boardsUnreadable: 3,
    });
    const up = find("INSERT INTO board_snapshot_meta");
    expect(up.statement).toContain("ON DUPLICATE KEY UPDATE");
    expect(up.params[0]).toBe("inst");
    expect(up.params).toContain(40);
    expect(up.params).toContain(190);
    expect(up.params).toContain(3);
  });

  test("writeBoardSnapshotMeta merges onto the existing row", async () => {
    mockRows([{ state: "building", version: "v1", total_boards: 40, total_columns: 190, boards_unreadable: 0 }]);
    await writeBoardSnapshotMeta("inst", { state: "failed", lastError: "boom" });
    const up = findAll("INSERT INTO board_snapshot_meta").pop();
    expect(up.params[1]).toBe("failed");
    expect(up.params).toContain("boom");
    // totals carried forward from the read
    expect(up.params).toContain(40);
  });
});
