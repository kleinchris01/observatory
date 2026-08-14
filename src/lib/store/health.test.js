import { vi, describe, test, expect, beforeEach } from "vitest";

// Site health over time.
//
// The score could never answer the question it existed to raise: did cleaning that up help?
// These tests pin the two properties that make the series trustworthy -- one row per day so
// a busy afternoon is not three points of noise, and an unmeasured dimension omitted rather
// than stored as zero.

vi.mock("@forge/sql", () => {
  const runner = { enqueue: () => runner, run: vi.fn().mockResolvedValue(undefined) };
  return {
    sql: {
      prepare: vi.fn().mockReturnValue({
        bindParams: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
      }),
      executeInTransaction: vi.fn().mockResolvedValue(undefined),
    },
    migrationRunner: runner,
  };
});

import { sql } from "@forge/sql";
import {
  recordHealthSnapshot,
  loadHealthHistory,
  pruneHealthHistory,
  measurementDay,
} from "./health.js";

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

const health = (over = {}) => ({
  score: 58,
  grade: "E",
  dimensionsScored: 11,
  dimensionsTotal: 13,
  dimensions: [
    { key: "field-naming", available: true, score: 79 },
    { key: "field-governance", available: true, score: 17 },
    { key: "screen-hygiene", available: false, score: null, reason: "No screen inventory yet." },
  ],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  nextRows = [];
  harness();
});

describe("measurementDay", () => {
  test("keys on the UTC day, so a reader's timezone cannot split one day into two rows", () => {
    expect(measurementDay(Date.parse("2026-08-13T23:30:00Z"))).toBe("2026-08-13");
    expect(measurementDay(Date.parse("2026-08-14T00:30:00Z"))).toBe("2026-08-14");
  });
});

describe("recordHealthSnapshot", () => {
  test("upserts one row per day rather than appending a point per visit", async () => {
    await recordHealthSnapshot("scope-1", health());

    const statement = issued[0].statement;
    expect(statement).toContain("INSERT INTO health_history");
    expect(statement).toContain("ON DUPLICATE KEY UPDATE");
    // The day, not the timestamp, is what the key collapses on.
    expect(issued[0].params[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // The same distinction the score itself is careful about: a gap must mean "not measured",
  // never "measured as zero".
  test("omits unavailable dimensions instead of storing them as zero", async () => {
    await recordHealthSnapshot("scope-1", health());

    const stored = JSON.parse(issued[0].params.at(-1));
    expect(stored).toEqual({ "field-naming": 79, "field-governance": 17 });
    expect(stored).not.toHaveProperty("screen-hygiene");
  });

  test("records nothing when the site has no score at all", async () => {
    const result = await recordHealthSnapshot("scope-1", health({ score: null }));

    expect(result.recorded).toBe(false);
    expect(issued).toHaveLength(0);
  });

  // Bookkeeping attached to a read path. An overview that 500s because a history row could
  // not be written would be strictly worse than one with a gap in a chart.
  test("never throws when the write fails", async () => {
    sql.prepare.mockImplementation(() => { throw new Error("Unknown SQL execution error"); });

    await expect(recordHealthSnapshot("scope-1", health())).resolves.toEqual({ recorded: false });
  });

  test("ignores a call with no scope", async () => {
    expect((await recordHealthSnapshot(null, health())).recorded).toBe(false);
  });
});

describe("loadHealthHistory", () => {
  test("returns the series oldest first, so every consumer plots it the same way", async () => {
    nextRows = [
      { measured_on: "2026-08-13", measured_at: "t3", score: 58, dimensions_json: "{}" },
      { measured_on: "2026-08-12", measured_at: "t2", score: 55, dimensions_json: "{}" },
      { measured_on: "2026-08-11", measured_at: "t1", score: 51, dimensions_json: "{}" },
    ];

    const series = await loadHealthHistory("scope-1");

    expect(series.map((row) => row.day)).toEqual(["2026-08-11", "2026-08-12", "2026-08-13"]);
  });

  // Forge SQL rejects a placeholder in LIMIT with an opaque error; the whole storage layer
  // interpolates a clamped integer instead.
  test("clamps the window and interpolates it rather than binding it", async () => {
    await loadHealthHistory("scope-1", { days: 99999 });

    expect(issued[0].statement).toContain("LIMIT 365");
    expect(issued[0].params).toEqual(["scope-1"]);
  });

  test("survives an unparseable dimensions blob", async () => {
    nextRows = [{ measured_on: "2026-08-13", score: 58, dimensions_json: "{not json" }];
    expect((await loadHealthHistory("scope-1"))[0].dimensions).toEqual({});
  });
});

describe("pruneHealthHistory", () => {
  // 400 days, longer than any other retention here: this table exists to answer "is the
  // estate getting better", and a year is the shortest window where that has an answer.
  test("keeps well over a year and scopes the delete", async () => {
    await pruneHealthHistory("scope-1");

    expect(issued[0].statement).toContain("WHERE scope_key = ?");
    expect(issued[0].params[0]).toBe("scope-1");
    const cutoff = Date.parse(issued[0].params[1]);
    expect(Date.now() - cutoff).toBeGreaterThan(365 * 24 * 60 * 60 * 1000);
  });
});
