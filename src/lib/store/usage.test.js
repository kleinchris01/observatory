import { vi, describe, test, expect, beforeEach } from "vitest";

// Usage per item (store/usage.js), against a mocked Forge SQL like the other store tests:
// an unscoped DELETE, a non-additive flush or an ungated promote would hide here.

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
import { flushUsageBuffer, promoteUsageTally, readUsageMeta, loadUsageTally, USAGE_PILLARS, USAGE_WINDOW_DAYS } from "./usage.js";

let issued = [];
let rowsFor = () => [];

beforeEach(() => {
  vi.clearAllMocks();
  issued = [];
  rowsFor = () => [];
  sql.prepare.mockImplementation((statement) => {
    const entry = { statement: String(statement), params: null };
    issued.push(entry);
    const stub = {
      bindParams: (...params) => { entry.params = params; return stub; },
      execute: () => Promise.resolve({ rows: rowsFor(entry.statement) }),
    };
    return stub;
  });
});

const find = (match) => issued.find((e) => (match instanceof RegExp ? match.test(e.statement) : e.statement.includes(match)));

describe("flushUsageBuffer", () => {
  test("adds totals and keeps the latest date, per pillar, item and project", async () => {
    const buffer = new Map([
      ["field|cf1|10", { pillar: "field", entityId: "cf1", projectId: "10", projectKey: "ABC", total: 3, recent: 1, lastAt: "2026-10-01T00:00:00.000Z" }],
      ["status|5|10", { pillar: "status", entityId: "5", projectId: "10", projectKey: "ABC", total: 2, recent: 0, lastAt: null }],
    ]);
    await flushUsageBuffer("inst", buffer);
    const insert = find("INSERT INTO issue_scan_usage_buffer");
    expect(insert.statement).toContain("total = total + VALUES(total)");
    expect(insert.statement).toContain("recent = recent + VALUES(recent)");
    expect(insert.statement).toContain("GREATEST(last_at, VALUES(last_at))");
    expect(insert.params).toEqual([
      "inst", "field", "cf1", "10", "ABC", 3, 1, "2026-10-01T00:00:00.000Z",
      "inst", "status", "5", "10", "ABC", 2, 0, null,
    ]);
  });

  test("writes nothing for an empty buffer", async () => {
    await flushUsageBuffer("inst", new Map());
    expect(find("INSERT INTO issue_scan_usage_buffer")).toBeUndefined();
  });
});

describe("promoteUsageTally", () => {
  test("a partial crawl promotes nothing, so the last good figures stay", async () => {
    const r = await promoteUsageTally("inst", { coverageComplete: false });
    expect(r).toEqual({ promoted: false, entities: 0 });
    expect(issued.some((e) => /usage_tally|issue_scan_usage_buffer/.test(e.statement))).toBe(false);
  });

  test("a complete crawl folds projects into one row per item, drops items it never saw, and stamps the meta", async () => {
    rowsFor = (st) => (st.includes("FROM issue_scan_usage_buffer")
      ? [{ pillar: "field", entity_id: "cf1", total: "7", recent: "2", last_at: "2026-10-02T00:00:00.000Z", project_count: "3" }]
      : []);
    const now = new Date("2026-10-07T00:00:00.000Z");
    const r = await promoteUsageTally("inst", { coverageComplete: true, now });

    expect(r).toEqual({ promoted: true, entities: 1, measuredAt: now.toISOString() });
    const select = find("FROM issue_scan_usage_buffer");
    expect(select.statement).toContain("GROUP BY pillar, entity_id");
    expect(select.params).toEqual(["inst"]);
    expect(find(/INSERT INTO usage_tally\s*\(/).params).toEqual(["inst", "field", "cf1", 7, 2, "2026-10-02T00:00:00.000Z", 3, now.toISOString()]);
    // Old rows go only after the new ones are written, and only this site's.
    const del = find("DELETE FROM usage_tally");
    expect(issued.indexOf(del)).toBeGreaterThan(issued.indexOf(find(/INSERT INTO usage_tally\s*\(/)));
    expect(del.statement).toContain("WHERE scope_key = ? AND measured_at <> ?");
    expect(del.params).toEqual(["inst", now.toISOString()]);
    expect(find("INSERT INTO usage_tally_meta").params).toEqual(["inst", now.toISOString(), USAGE_WINDOW_DAYS]);
  });
});

describe("reads", () => {
  test("loadUsageTally maps one pillar's rows to numbers", async () => {
    rowsFor = () => [{ entity_id: "10001", total: "12", recent: "4", last_at: "2026-09-30T00:00:00.000Z", project_count: "2" }];
    const map = await loadUsageTally("inst", "issuetype");
    expect(find("FROM usage_tally WHERE").params).toEqual(["inst", "issuetype"]);
    expect(map.get("10001")).toEqual({ total: 12, recent: 4, lastAt: "2026-09-30T00:00:00.000Z", projectCount: 2 });
  });

  test("readUsageMeta is null before any complete crawl", async () => {
    expect(await readUsageMeta("inst")).toBeNull();
    rowsFor = () => [{ measured_at: "2026-10-07T00:00:00.000Z", window_days: "90" }];
    expect(await readUsageMeta("inst")).toEqual({ measuredAt: "2026-10-07T00:00:00.000Z", windowDays: 90 });
  });

  test("every crawled pillar names its date basis", () => {
    for (const spec of Object.values(USAGE_PILLARS)) expect(["created", "updated", "resolved"]).toContain(spec.basis);
  });
});
