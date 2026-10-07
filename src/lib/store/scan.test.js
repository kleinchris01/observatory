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
  flushIssueScanTypeCounts,
  flushIssueScanFieldUserCounts,
  promoteIssueScanFieldUserUsage,
  loadFieldUserUsage,
  loadUserFieldAppearances,
  promoteIssueScanFieldTypeUsage,
  loadFieldTypeUsage,
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
  test("clears every buffer and never touches the live activity table", async () => {
    await clearIssueScanBuffer("inst");

    const targets = writes().map((e) => e.statement);
    expect(targets.some((s) => /DELETE FROM issue_scan_buffer WHERE scope_key = \?/.test(s))).toBe(true);
    expect(targets.some((s) => /DELETE FROM issue_scan_activity_buffer WHERE scope_key = \?/.test(s))).toBe(true);
    expect(targets.some((s) => /DELETE FROM issue_scan_type_buffer WHERE scope_key = \?/.test(s))).toBe(true);
    // The per-item usage buffer is additive too; usage_tally (the last good figures) stays.
    expect(targets.some((s) => /DELETE FROM issue_scan_usage_buffer WHERE scope_key = \?/.test(s))).toBe(true);
    expect(targets.some((s) => /DELETE FROM usage_tally/.test(s))).toBe(false);
    // The live series is the last good snapshot -- clearing it up front is exactly the bug.
    expect(targets.some((s) => /DELETE FROM issue_scan_project_activity/.test(s))).toBe(false);
  });
});

describe("flushIssueScanTypeCounts", () => {
  test("accumulates field x issue-type counts into the buffer", async () => {
    const counts = new Map([
      ["customfield_100", new Map([
        ["10001", { count: 12, name: "Bug" }],
        ["10002", { count: 3, name: "Incident" }],
      ])],
    ]);

    await flushIssueScanTypeCounts("inst", counts);

    const insert = writes().find((e) => e.statement.startsWith("INSERT"));
    expect(insert.statement).toMatch(/INSERT INTO issue_scan_type_buffer/);
    expect(insert.statement).toMatch(/issue_count = issue_count \+ VALUES\(issue_count\)/);
    expect(insert.params).toEqual([
      "inst", "customfield_100", "10001", "Bug", 12,
      "inst", "customfield_100", "10002", "Incident", 3,
    ]);
  });

  test("does nothing when there is nothing to flush", async () => {
    await flushIssueScanTypeCounts("inst", new Map());
    expect(writes()).toEqual([]);
  });
});

describe("promoteIssueScanFieldTypeUsage", () => {
  test("upserts this run's rows and drops the field's stale types", async () => {
    rowsFor = (entry) => entry.statement.startsWith("SELECT")
      ? [
          { field_id: "customfield_1", issue_type_id: "10001", issue_type_name: "Bug", issue_count: 40 },
          { field_id: "customfield_1", issue_type_id: "10002", issue_type_name: "Task", issue_count: 5 },
        ]
      : [];

    const result = await promoteIssueScanFieldTypeUsage("inst", "v9");

    const stmts = writes().map((e) => e.statement);
    expect(stmts.some((s) => /INSERT INTO snapshot_field_type_usage/.test(s))).toBe(true);
    const del = writes().find((e) => e.statement.startsWith("DELETE"));
    expect(del.statement).toMatch(/issue_type_id NOT IN \(\?, \?\)/);
    expect(del.params).toEqual(["inst", "v9", "customfield_1", "10001", "10002"]);
    expect(result).toEqual({ fieldsPromoted: 1, rowsInserted: 2 });
  });

  test("with full coverage, clears usage for fields the crawl never saw", async () => {
    rowsFor = (entry) => entry.statement.startsWith("SELECT")
      ? [{ field_id: "customfield_1", issue_type_id: "10001", issue_type_name: "Bug", issue_count: 40 }]
      : [];

    await promoteIssueScanFieldTypeUsage("inst", "v9", { coverageComplete: true });

    const del = writes().find((e) => /field_id NOT IN/.test(e.statement));
    expect(del.statement).toMatch(/DELETE FROM snapshot_field_type_usage/);
    expect(del.params).toEqual(["inst", "v9", "customfield_1"]);
  });
});

describe("loadFieldTypeUsage", () => {
  test("returns typed rows ordered by the query, biggest first", async () => {
    rowsFor = () => [
      { issue_type_id: "10001", issue_type_name: "Bug", issue_count: 40 },
      { issue_type_id: "10002", issue_type_name: "Task", issue_count: 5 },
    ];

    const rows = await loadFieldTypeUsage("inst", "v9", "customfield_1");

    expect(rows).toEqual([
      { issueTypeId: "10001", issueTypeName: "Bug", issueCount: 40 },
      { issueTypeId: "10002", issueTypeName: "Task", issueCount: 5 },
    ]);
    expect(issued.at(-1).statement).toMatch(/ORDER BY issue_count DESC/);
  });
});

describe("field x user (user-picker value) usage", () => {
  test("flushIssueScanFieldUserCounts accumulates field x account into the buffer", async () => {
    const counts = new Map([
      ["customfield_500", new Map([
        ["acc-1", { count: 8, name: "Ann" }],
        ["acc-2", { count: 2, name: null }],
      ])],
    ]);

    await flushIssueScanFieldUserCounts("inst", counts);

    const insert = writes().find((e) => e.statement.startsWith("INSERT"));
    expect(insert.statement).toMatch(/INSERT INTO issue_scan_field_user_buffer/);
    expect(insert.statement).toMatch(/issue_count = issue_count \+ VALUES\(issue_count\)/);
    expect(insert.params).toEqual([
      "inst", "customfield_500", "acc-1", "Ann", 8,
      "inst", "customfield_500", "acc-2", null, 2,
    ]);
  });

  test("promoteIssueScanFieldUserUsage upserts and drops the field's stale accounts", async () => {
    rowsFor = (entry) => entry.statement.startsWith("SELECT")
      ? [
          { field_id: "customfield_500", account_id: "acc-1", display_name: "Ann", issue_count: 30 },
          { field_id: "customfield_500", account_id: "acc-2", display_name: "Bo", issue_count: 4 },
        ]
      : [];

    const result = await promoteIssueScanFieldUserUsage("inst", "v9");

    const stmts = writes().map((e) => e.statement);
    expect(stmts.some((s) => /INSERT INTO snapshot_field_user_usage/.test(s))).toBe(true);
    const del = writes().find((e) => /account_id NOT IN/.test(e.statement));
    expect(del.params).toEqual(["inst", "v9", "customfield_500", "acc-1", "acc-2"]);
    expect(result).toEqual({ fieldsPromoted: 1, rowsInserted: 2 });
  });

  test("loadFieldUserUsage returns the top holders and a distinct-user total", async () => {
    rowsFor = (entry) => /COUNT\(\*\) AS distinct_users/.test(entry.statement)
      ? [{ distinct_users: 42, issue_total: 500 }]
      : [
          { account_id: "acc-1", display_name: "Ann", issue_count: 30 },
          { account_id: "acc-2", display_name: null, issue_count: 4 },
        ];

    const usage = await loadFieldUserUsage("inst", "v9", "customfield_500");

    expect(usage.distinctUsers).toBe(42);
    expect(usage.issueTotal).toBe(500);
    expect(usage.top).toEqual([
      { accountId: "acc-1", displayName: "Ann", issueCount: 30 },
      { accountId: "acc-2", displayName: null, issueCount: 4 },
    ]);
  });

  test("loadUserFieldAppearances returns every field one account is a value in", async () => {
    rowsFor = () => [
      { field_id: "customfield_500", issue_count: 30 },
      { field_id: "assignee", issue_count: 900 },
    ];

    const rows = await loadUserFieldAppearances("inst", "v9", "acc-1");

    expect(rows).toEqual([
      { fieldId: "customfield_500", issueCount: 30 },
      { fieldId: "assignee", issueCount: 900 },
    ]);
    expect(issued.at(-1).statement).toMatch(/WHERE scope_key = \? AND version = \? AND account_id = \?/);
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
