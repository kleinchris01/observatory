import { vi, describe, test, expect, beforeEach } from "vitest";

// Storage for the estate-config pillar. Tested directly against a mocked Forge SQL, like
// store/issuetype.test.js -- an unscoped DELETE or an arity bug hides here.

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
  replaceEstateSnapshot,
  loadEstateValues,
  readEstateSnapshotMeta,
  writeEstateSnapshotMeta,
} from "./estate.js";

let issued = [];
let nextRows = [];

function harness() {
  issued = [];
  sql.prepare.mockImplementation((statement) => {
    const entry = { statement: String(statement), params: null };
    issued.push(entry);
    const stub = {
      bindParams: (...params) => { entry.params = params; return stub; },
      execute: () => Promise.resolve({ rows: nextRows }),
    };
    return stub;
  });
}

const find = (match) => issued.find((e) => e.statement.includes(match));
const mockRows = (rows) => { nextRows = rows; };

beforeEach(() => {
  vi.clearAllMocks();
  nextRows = [];
  harness();
});

describe("replaceEstateSnapshot", () => {
  test("deletes only this scope, then inserts resolutions and priorities with 8 columns each", async () => {
    await replaceEstateSnapshot("inst", "v1", {
      resolutions: [{ id: "1", name: "Done", isDefault: true }],
      priorities: [{ id: "10", name: "High" }, { id: "11", name: "Low" }],
    });

    const del = find("DELETE FROM snapshot_estate_values");
    expect(del.statement).toContain("WHERE scope_key = ?");
    expect(del.params).toEqual(["inst"]);

    const ins = find("INSERT INTO snapshot_estate_values");
    // 8 columns * 3 rows
    expect(ins.params).toHaveLength(24);
    expect(ins.params.slice(0, 8)).toEqual(["inst", "v1", "resolution", "1", "Done", null, 1, 0]);
    expect(ins.params.slice(16, 24)).toEqual(["inst", "v1", "priority", "11", "Low", null, 0, 1]);
  });

  test("clears the pillar even with nothing to write", async () => {
    await replaceEstateSnapshot("inst", "v1", {});
    expect(find("DELETE FROM snapshot_estate_values")).toBeTruthy();
    expect(find("INSERT INTO snapshot_estate_values")).toBeUndefined();
  });
});

describe("loadEstateValues", () => {
  test("scopes by scope+version+kind and maps the rows", async () => {
    mockRows([{ kind: "resolution", item_id: "1", name: "Done", description: "d", is_default: 1, sort_order: 0 }]);
    const rows = await loadEstateValues("inst", "v1", "resolution");
    expect(rows).toEqual([{ id: "1", name: "Done", description: "d", isDefault: true, sortOrder: 0 }]);
    expect(find("FROM snapshot_estate_values").params).toEqual(["inst", "v1", "resolution"]);
  });
});

describe("estate snapshot meta", () => {
  test("readEstateSnapshotMeta returns null with no row", async () => {
    mockRows([]);
    expect(await readEstateSnapshotMeta("inst")).toBeNull();
  });

  test("writeEstateSnapshotMeta upserts the totals", async () => {
    mockRows([]);
    await writeEstateSnapshotMeta("inst", { state: "ready", version: "v2", totalResolutions: 7, totalPriorities: 5 });
    const up = find("INSERT INTO estate_snapshot_meta");
    expect(up.statement).toContain("ON DUPLICATE KEY UPDATE");
    expect(up.params[0]).toBe("inst");
    expect(up.params).toContain(7);
    expect(up.params).toContain(5);
  });
});
