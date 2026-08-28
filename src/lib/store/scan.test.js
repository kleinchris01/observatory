import { vi, describe, test, expect, beforeEach } from "vitest";

// The issue-scan store, focused on the month histogram's buffer/promote path.
//
// The activity histogram used to be written straight into its live table and wiped at the
// start of every scan. A crawl that died partway -- the normal failure mode on a large site
// -- then left the live table holding only the oldest months it had reached, and every
// adoption rate derived from it read as a collapse. These tests pin the fix: writes land in
// a buffer, the live table is never cleared up front, and promotion is per project so a
// partial run cannot erase a project it never revisited.

vi.mock("@forge/sql", () => {
  const runner = { enqueue: () => runner, run: vi.fn().mockResolvedValue(undefined) };
  return {
    sql: {
      prepare: vi.fn(),
      executeInTransaction: vi.fn().mockResolvedValue(undefined),
    },
    migrationRunner: runner,
  };
});

import { sql } from "@forge/sql";
import {
  clearIssueScanBuffer,
  flushIssueScanActivity,
  promoteIssueScanActivity,
} from "./scan.js";

let issued = [];
let rowsFor = () => [];

function harness() {
  issued = [];
  sql.prepare.mockImplementation((statement) => {
    const entry = { statement: String(statement).replace(/\s+/g, " ").trim(), params: null };
    issued.push(entry);
    const stub = {
      bindParams: (...params) => { entry.params = params; return stub; },
      execute: () => Promise.resolve({ rows: rowsFor(entry) }),
    };
    return stub;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rowsFor = () => [];
  harness();
});

const writes = () => issued.filter((e) => /^(INSERT|DELETE|UPDATE)/.test(e.statement));

describe("clearIssueScanBuffer", () => {
  test("clears both buffers and never touches the live activity table", async () => {
    await clearIssueScanBuffer("inst");

    const targets = writes().map((e) => e.statement);
    expect(targets.some((s) => /DELETE FROM issue_scan_buffer WHERE scope_key = \?/.test(s))).toBe(true);
    expect(targets.some((s) => /DELETE FROM issue_scan_activity_buffer WHERE scope_key = \?/.test(s))).toBe(true);
    // The live series is the last good snapshot -- clearing it up front is exactly the bug.
    expect(targets.some((s) => /DELETE FROM issue_scan_project_activity/.test(s))).toBe(false);
  });
});

describe("flushIssueScanActivity", () => {
  test("accumulates into the buffer, not the live table", async () => {
    const months = new Map([
      ["10000|2026-01", { projectId: "10000", month: "2026-01", count: 7, first: "2026-01-02T00:00:00.000Z", last: "2026-01-30T00:00:00.000Z" }],
    ]);

    await flushIssueScanActivity("inst", months);

    const insert = writes().find((e) => e.statement.startsWith("INSERT"));
    expect(insert.statement).toMatch(/INSERT INTO issue_scan_activity_buffer/);
    expect(insert.statement).toMatch(/issue_count = issue_count \+ VALUES\(issue_count\)/);
    expect(insert.params).toEqual(["inst", "10000", "2026-01", 7, "2026-01-02T00:00:00.000Z", "2026-01-30T00:00:00.000Z"]);
  });

  test("does nothing when there are no months to flush", async () => {
    await flushIssueScanActivity("inst", new Map());
    expect(writes()).toEqual([]);
  });
});

describe("promoteIssueScanActivity", () => {
  test("an empty buffer promotes nothing rather than wiping the live table", async () => {
    rowsFor = () => [];

    const result = await promoteIssueScanActivity("inst");

    expect(result).toEqual({ projectsPromoted: 0, rowsInserted: 0 });
    expect(writes().some((e) => /DELETE FROM issue_scan_project_activity/.test(e.statement))).toBe(false);
  });

  test("replaces the live rows of each buffered project and leaves the rest alone", async () => {
    const buffer = [
      { project_id: "10000", month: "2026-05", issue_count: 12, first_created_at: "a", last_created_at: "b" },
      { project_id: "10000", month: "2026-06", issue_count: 3, first_created_at: "a", last_created_at: "c" },
      { project_id: "10001", month: "2026-06", issue_count: 40, first_created_at: "d", last_created_at: "e" },
    ];
    rowsFor = (entry) => (entry.statement.startsWith("SELECT") ? buffer : []);

    const result = await promoteIssueScanActivity("inst");

    expect(result).toEqual({ projectsPromoted: 2, rowsInserted: 3 });

    const del = writes().find((e) => e.statement.startsWith("DELETE"));
    // Scoped to exactly the project ids the crawl re-counted -- never a global DELETE.
    expect(del.statement).toMatch(/DELETE FROM issue_scan_project_activity WHERE scope_key = \? AND project_id IN \(\?, \?\)/);
    expect(del.params).toEqual(["inst", "10000", "10001"]);

    const ins = writes().find((e) => e.statement.startsWith("INSERT"));
    expect(ins.statement).toMatch(/INSERT INTO issue_scan_project_activity/);
    // Straight copy: no ON DUPLICATE KEY accumulation, the DELETE already cleared the way.
    expect(ins.statement).not.toMatch(/ON DUPLICATE KEY/);
    expect(ins.params).toEqual([
      "inst", "10000", "2026-05", 12, "a", "b",
      "inst", "10000", "2026-06", 3, "a", "c",
      "inst", "10001", "2026-06", 40, "d", "e",
    ]);
  });
});
