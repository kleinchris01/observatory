import { vi, describe, test, expect, beforeEach } from "vitest";

// Storage for configuration drift: the entity-digest state and the append-only change log.
// Tested directly against a mocked Forge SQL, like store/issuetype.test.js -- an unscoped
// DELETE or a tuple-vs-column arity bug hides here and nowhere a wholesale project-store
// mock could see it.

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
  loadEntityDigests,
  replaceEntityDigests,
  appendConfigChanges,
  loadConfigChanges,
  changeCursorOf,
  loadConfigChangeSummary,
  countTrackedEntities,
  pruneOldConfigChanges,
  readDriftSnapshotMeta,
  writeDriftSnapshotMeta,
} from "./drift.js";

let issued = [];
let nextRows = [];

function harness() {
  issued = [];
  sql.prepare.mockImplementation((statement) => {
    const entry = { statement: String(statement), params: null };
    issued.push(entry);
    const stub = {
      bindParams: (...params) => { entry.params = params; return stub; },
      execute: () => Promise.resolve({ rows: nextRows, rowsAffected: nextRows.length }),
    };
    return stub;
  });
}

const statements = () => issued.map((e) => e.statement);
const find = (match) => issued.find((e) => e.statement.includes(match));
const mockRows = (rows) => { nextRows = rows; };

beforeEach(() => {
  vi.clearAllMocks();
  nextRows = [];
  harness();
});

describe("loadEntityDigests", () => {
  test("scopes by scope_key + pillar and parses fields_json", async () => {
    mockRows([{ entity_type: "status", entity_id: "1", label: "Open", digest: "abcd1234", fields_json: '{"name":"Open"}' }]);
    const rows = await loadEntityDigests("inst", "workflow");
    expect(rows).toEqual([{ entityType: "status", entityId: "1", label: "Open", digest: "abcd1234", fields: { name: "Open" } }]);
    const q = find("FROM snapshot_entity_digest");
    expect(q.statement).toContain("WHERE scope_key = ? AND pillar = ?");
    expect(q.params).toEqual(["inst", "workflow"]);
  });
});

describe("replaceEntityDigests", () => {
  test("deletes only this scope+pillar, then batch-inserts the current set", async () => {
    await replaceEntityDigests("inst", "access", [
      { entityType: "permission-scheme", entityId: "1", label: "Prod", digest: "d1", fields: { name: "Prod" } },
      { entityType: "permission-grant", entityId: "1:BROWSE:anyone:", label: "x", digest: "d2", fields: {} },
    ]);
    const del = find("DELETE FROM snapshot_entity_digest");
    expect(del.statement).toContain("WHERE scope_key = ? AND pillar = ?");
    expect(del.params).toEqual(["inst", "access"]);

    const ins = find("INSERT INTO snapshot_entity_digest");
    // 7 columns, 2 rows -> 14 bound params.
    expect(ins.params).toHaveLength(14);
    expect(ins.params.slice(0, 7)).toEqual(["inst", "access", "permission-scheme", "1", "Prod", "d1", '{"name":"Prod"}']);
  });

  test("still clears the pillar when handed an empty set", async () => {
    await replaceEntityDigests("inst", "fields", []);
    expect(statements().filter((s) => s.includes("DELETE FROM snapshot_entity_digest"))).toHaveLength(1);
    expect(statements().some((s) => s.includes("INSERT INTO snapshot_entity_digest"))).toBe(false);
  });
});

describe("appendConfigChanges", () => {
  test("no-ops on an empty list", async () => {
    await appendConfigChanges("inst", []);
    expect(sql.prepare).not.toHaveBeenCalled();
  });

  test("inserts one row per change with 10 columns each", async () => {
    await appendConfigChanges("inst", [
      { changeId: "v1-00000", detectedAt: "2026-09-03T00:00:00Z", scanVersion: "v1", pillar: "access", entityType: "permission-scheme", entityId: "1", label: "Prod", changeKind: "added", summary: "Permission scheme \"Prod\" added" },
    ]);
    const ins = find("INSERT INTO config_change_log");
    expect(ins.params).toHaveLength(10);
    expect(ins.params[1]).toBe("v1-00000");
    expect(ins.params[8]).toBe("added");
  });
});

describe("loadConfigChanges", () => {
  test("applies the optional filters and the keyset cursor, newest first", async () => {
    mockRows([]);
    await loadConfigChanges("inst", { pillar: "access", kind: "modified", before: "2026-09-01T00:00:00Z", limit: 25 });
    const q = find("FROM config_change_log");
    expect(q.statement).toContain("ORDER BY detected_at DESC");
    expect(q.statement).toContain("pillar = ?");
    expect(q.statement).toContain("change_kind = ?");
    expect(q.statement).toContain("detected_at < ?");
    expect(q.params).toEqual(["inst", "access", "modified", "2026-09-01T00:00:00Z"]);
  });

  // Every row from one drift pass shares a detected_at. A cursor of detected_at alone
  // skipped the rest of that pass on the next page.
  test("pages within a single pass on the compound cursor", async () => {
    mockRows([]);
    await loadConfigChanges("inst", { before: "2026-09-01T00:00:00Z|v9-00042", limit: 25 });
    const q = find("FROM config_change_log");
    expect(q.statement).toContain("(detected_at < ? OR (detected_at = ? AND change_id < ?))");
    expect(q.statement).toContain("ORDER BY detected_at DESC, change_id DESC");
    expect(q.params).toEqual(["inst", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z", "v9-00042"]);
  });

  test("with no filters, only scope_key is bound", async () => {
    mockRows([]);
    await loadConfigChanges("inst", {});
    expect(find("FROM config_change_log").params).toEqual(["inst"]);
  });
});

describe("changeCursorOf", () => {
  test("carries the change id so the next page resumes inside the same pass", () => {
    expect(changeCursorOf({ detectedAt: "2026-09-01T00:00:00Z", changeId: "v9-00042" })).toBe("2026-09-01T00:00:00Z|v9-00042");
  });

  test("falls back to the timestamp alone, and to null for no row", () => {
    expect(changeCursorOf({ detectedAt: "2026-09-01T00:00:00Z" })).toBe("2026-09-01T00:00:00Z");
    expect(changeCursorOf(null)).toBeNull();
  });
});

describe("loadConfigChangeSummary", () => {
  test("rolls the grouped counts into byPillar / byKind / total", async () => {
    mockRows([
      { pillar: "access", change_kind: "added", n: 3 },
      { pillar: "access", change_kind: "removed", n: 1 },
      { pillar: "workflow", change_kind: "modified", n: 2 },
    ]);
    const s = await loadConfigChangeSummary("inst", "2026-08-01T00:00:00Z");
    expect(s.total).toBe(6);
    expect(s.byPillar).toEqual({ access: 4, workflow: 2 });
    expect(s.byKind).toEqual({ added: 3, removed: 1, modified: 2 });
  });
});

describe("countTrackedEntities", () => {
  test("scopes the count by scope_key only, across every pillar", async () => {
    mockRows([{ n: 41 }]);
    const n = await countTrackedEntities("inst");
    expect(n).toBe(41);
    const stmt = find("COUNT(*)");
    expect(stmt.statement).toContain("FROM snapshot_entity_digest WHERE scope_key = ?");
    expect(stmt.params).toEqual(["inst"]);
  });
});

describe("pruneOldConfigChanges", () => {
  test("deletes rows older than the cutoff for this scope only", async () => {
    mockRows([{}, {}]);
    const r = await pruneOldConfigChanges("inst", 1000);
    expect(r.changesDeleted).toBe(2);
    const del = find("DELETE FROM config_change_log");
    expect(del.statement).toContain("WHERE scope_key = ? AND detected_at < ?");
    expect(del.params[0]).toBe("inst");
  });
});

describe("drift snapshot meta", () => {
  test("readDriftSnapshotMeta returns null when there is no row", async () => {
    mockRows([]);
    expect(await readDriftSnapshotMeta("inst")).toBeNull();
  });

  test("readDriftSnapshotMeta splits seeded_pillars back into an array", async () => {
    mockRows([{ state: "ready", version: "v1", last_run_changes: 4, total_changes: 40, seeded_pillars: "fields,access" }]);
    const m = await readDriftSnapshotMeta("inst");
    expect(m).toMatchObject({ state: "ready", version: "v1", lastRunChanges: 4, totalChanges: 40, seededPillars: ["fields", "access"] });
  });

  test("writeDriftSnapshotMeta upserts, joining seededPillars to a CSV", async () => {
    mockRows([]); // readback inside write finds nothing
    await writeDriftSnapshotMeta("inst", { state: "ready", version: "v2", lastRunChanges: 2, totalChanges: 12, seededPillars: ["fields"] });
    const up = find("INSERT INTO drift_snapshot_meta");
    expect(up.statement).toContain("ON DUPLICATE KEY UPDATE");
    expect(up.params[0]).toBe("inst");
    expect(up.params).toContain("fields");
  });
});
