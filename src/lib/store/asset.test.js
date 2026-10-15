import { vi, describe, test, expect, beforeEach } from "vitest";

// The object-count crawl's own storage: an unscoped DELETE or a tuple arity bug hides here
// and nowhere a wholesale project-store mock could see it, like drift.test.js and
// issuetype.test.js. Tested against a mocked Forge SQL.

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
  replaceAssetTypeCounts,
  loadAssetTypeCounts,
  readAssetTypeCountMeta,
  writeAssetTypeCountMeta,
} from "./asset.js";

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
      execute: () => Promise.resolve({ rows: nextRows, rowsAffected: nextRows.length }),
    };
    return stub;
  });
}

const find = (match) => issued.find((e) => e.statement.includes(match));
const mockRows = (rows) => {
  nextRows = rows;
};

beforeEach(() => {
  vi.clearAllMocks();
  nextRows = [];
  harness();
});

describe("replaceAssetTypeCounts", () => {
  test("deletes only this scope's counts, then batch-inserts the current set", async () => {
    await replaceAssetTypeCounts("inst", [
      { objectTypeId: "10", schemaId: "1", objectCount: 42, measuredAt: "2026-09-16T00:00:00Z" },
      { objectTypeId: "11", schemaId: "1", objectCount: 0, measuredAt: "2026-09-16T00:00:00Z" },
    ]);

    const del = find("DELETE FROM snapshot_asset_type_counts");
    expect(del.statement).toContain("WHERE scope_key = ?");
    expect(del.params).toEqual(["inst"]);

    const ins = find("INSERT INTO snapshot_asset_type_counts");
    // 5 columns, 2 rows -> 10 bound params.
    expect(ins.params).toHaveLength(10);
    expect(ins.params.slice(0, 5)).toEqual(["inst", "10", "1", 42, "2026-09-16T00:00:00Z"]);
  });

  test("still clears this scope when handed an empty set", async () => {
    await replaceAssetTypeCounts("inst", []);
    expect(statementsOf(issued).filter((s) => s.includes("DELETE FROM snapshot_asset_type_counts"))).toHaveLength(1);
    expect(statementsOf(issued).some((s) => s.includes("INSERT INTO snapshot_asset_type_counts"))).toBe(false);
  });
});

function statementsOf(list) {
  return list.map((e) => e.statement);
}

describe("loadAssetTypeCounts", () => {
  test("scopes by scope_key only and coerces the count", async () => {
    mockRows([{ object_type_id: "10", schema_id: "1", object_count: "42", measured_at: "2026-09-16T00:00:00Z" }]);
    const rows = await loadAssetTypeCounts("inst");
    expect(rows).toEqual([{ objectTypeId: "10", schemaId: "1", objectCount: 42, measuredAt: "2026-09-16T00:00:00Z" }]);
    const q = find("FROM snapshot_asset_type_counts");
    expect(q.params).toEqual(["inst"]);
  });
});

describe("asset type count meta", () => {
  test("readAssetTypeCountMeta returns null when no row exists", async () => {
    mockRows([]);
    expect(await readAssetTypeCountMeta("inst")).toBeNull();
  });

  test("writeAssetTypeCountMeta merges the patch onto the current row and upserts", async () => {
    mockRows([{ state: "building", started_at: "t0", measured_types: 0, unmeasured_types: 0 }]);
    await writeAssetTypeCountMeta("inst", { state: "ready", completedAt: "t1", measuredTypes: 12, unmeasuredTypes: 1 });

    const ins = find("INSERT INTO asset_type_count_meta");
    expect(ins.params).toEqual(["inst", "ready", "t0", "t1", null, 12, 1, null]);
  });
});
