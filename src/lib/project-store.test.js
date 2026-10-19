import { vi, describe, test, expect, afterEach } from "vitest";

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
  chunkArray,
  safeParseJson,
  toNumber,
  isSqlRateLimitError,
  withSqlRetry,
  describeSqlError,
  attachSqlErrorDetail,
  loadFieldLastChangeMap,
  clearAllSnapshotData,
} from "./project-store.js";

afterEach(() => vi.restoreAllMocks());

// Replaces the module-level sql.prepare mock with one that records the SQL text and bound
// params per call and returns queued row sets, so query shape can be asserted directly.
function mockSqlQueries(rowSets) {
  const calls = [];
  let i = 0;
  sql.prepare.mockImplementation((text) => {
    const call = { text, params: null };
    calls.push(call);
    return {
      bindParams: (...params) => {
        call.params = params;
        return {
          execute: async () => ({ rows: rowSets[i++] ?? [] }),
        };
      },
    };
  });
  return calls;
}

// ── chunkArray ────────────────────────────────────────────────────────────────

describe("chunkArray", () => {
  test("splits array into chunks of given size", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("returns a single chunk when size exceeds array length", () => {
    expect(chunkArray([1, 2], 10)).toEqual([[1, 2]]);
  });

  test("returns empty array for empty input", () => {
    expect(chunkArray([], 5)).toEqual([]);
  });

  test("handles chunk size of 1", () => {
    expect(chunkArray(["a", "b", "c"], 1)).toEqual([["a"], ["b"], ["c"]]);
  });
});

// ── safeParseJson ─────────────────────────────────────────────────────────────

describe("safeParseJson", () => {
  test("parses valid JSON", () => {
    expect(safeParseJson('{"key":"val"}', null)).toEqual({ key: "val" });
    expect(safeParseJson("[1,2,3]", null)).toEqual([1, 2, 3]);
  });

  test("returns fallback for invalid JSON", () => {
    expect(safeParseJson("{bad json}", [])).toEqual([]);
    expect(safeParseJson("undefined", null)).toBeNull();
  });

  test("returns fallback for falsy input", () => {
    expect(safeParseJson(null, "default")).toBe("default");
    expect(safeParseJson("", "default")).toBe("default");
    expect(safeParseJson(0, "default")).toBe("default");
  });
});

// ── toNumber ──────────────────────────────────────────────────────────────────

describe("toNumber", () => {
  test("converts numeric strings", () => {
    expect(toNumber("42")).toBe(42);
    expect(toNumber("3.14")).toBeCloseTo(3.14);
  });

  test("returns 0 (default fallback) for NaN values", () => {
    expect(toNumber("not a number")).toBe(0);
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
  });

  test("uses custom fallback", () => {
    expect(toNumber("bad", -1)).toBe(-1);
  });

  test("handles Infinity as non-finite (returns fallback)", () => {
    expect(toNumber(Infinity)).toBe(0);
    expect(toNumber(-Infinity)).toBe(0);
  });

  test("passes through finite numbers unchanged", () => {
    expect(toNumber(0)).toBe(0);
    expect(toNumber(-5)).toBe(-5);
  });
});

// ── isSqlRateLimitError ───────────────────────────────────────────────────────

describe("isSqlRateLimitError", () => {
  test("returns true for RATE_LIMIT_EXCEEDED code", () => {
    expect(isSqlRateLimitError({ code: "RATE_LIMIT_EXCEEDED" })).toBe(true);
  });

  test("returns true for responseDetails.status === 429", () => {
    expect(isSqlRateLimitError({ responseDetails: { status: 429 } })).toBe(true);
  });

  test("returns false for other error codes", () => {
    expect(isSqlRateLimitError({ code: "SOME_OTHER_ERROR" })).toBe(false);
    expect(isSqlRateLimitError({ responseDetails: { status: 500 } })).toBe(false);
  });

  test("returns false for null/undefined", () => {
    expect(isSqlRateLimitError(null)).toBe(false);
    expect(isSqlRateLimitError(undefined)).toBe(false);
  });
});

// ── SQL error detail ──────────────────────────────────────────────────────────
//
// Forge SQL answers every statement MySQL rejected with the same sentence, "Unknown SQL
// execution error", and puts what actually went wrong in the fields beside it. Three
// separate defects in this codebase reached production wearing that sentence. These pin the
// fields being read back out.

// Shaped the way @forge/sql's ForgeSQLAPIError constructs itself: message and code hoisted,
// everything the service sent that it could not name folded into `context`.
function forgeSqlError({
  message = "Unknown SQL execution error",
  code = "UNKNOWN_ERROR",
  suggestion,
  context,
  status,
  traceId,
} = {}) {
  const error = new Error(message);
  error.name = "ForgeSQLError";
  error.code = code;
  if (suggestion) error.suggestion = suggestion;
  error.context = context;
  error.responseDetails = { status, statusText: "Bad Request", traceId };
  return error;
}

describe("describeSqlError", () => {
  test("pulls out the code, the trace id and the status", () => {
    const detail = describeSqlError(forgeSqlError({ status: 400, traceId: "abc123" }));

    expect(detail).toContain("code=UNKNOWN_ERROR");
    // The trace id is the single most valuable field: it is what Atlassian support needs to
    // look the failure up on their side, and it was being dropped with everything else.
    expect(detail).toContain("trace=abc123");
    expect(detail).toContain("status=400");
  });

  test("serialises the whole context rather than picking known keys out of it", () => {
    // The next unfamiliar failure will put its cause in a field nobody has thought of yet.
    const detail = describeSqlError(
      forgeSqlError({
        context: { responseText: "Data too long for column 'context' at row 14", somethingNew: "keep me" },
      }),
    );

    expect(detail).toContain("Data too long for column");
    expect(detail).toContain("somethingNew");
  });

  test("truncates a context too large to belong in a message", () => {
    const detail = describeSqlError(forgeSqlError({ context: { responseText: "x".repeat(5000) } }));

    expect(detail.length).toBeLessThan(1000);
    expect(detail).toContain("…");
  });

  test("says nothing when there is nothing to say", () => {
    // A plain Error carries none of these fields, which is every non-SQL failure in the app.
    expect(describeSqlError(new Error("plain"))).toBeNull();
    // And a SQL error stripped of everything worth reporting adds nothing to its own message.
    expect(describeSqlError({ message: "bare", context: {}, responseDetails: {} })).toBeNull();
    expect(describeSqlError(null)).toBeNull();
    expect(describeSqlError("not an error")).toBeNull();
  });
});

describe("attachSqlErrorDetail", () => {
  test("puts the detail on the message, which is the part that propagates", () => {
    // Every engine's catch does String(error.message), writes it to a pillar's meta, and the
    // Scans tab renders it. The message is the only field that survives that journey.
    const error = attachSqlErrorDetail(forgeSqlError({ traceId: "t-1", context: { responseText: "Duplicate entry" } }));

    expect(error.message).toContain("Unknown SQL execution error");
    expect(error.message).toContain("trace=t-1");
    expect(error.message).toContain("Duplicate entry");
  });

  test("attaches once, however many wrappers the error crosses", () => {
    const error = forgeSqlError({ traceId: "t-2" });
    attachSqlErrorDetail(error);
    attachSqlErrorDetail(error);
    attachSqlErrorDetail(error);

    expect(error.message.match(/trace=t-2/g)).toHaveLength(1);
  });

  test("returns the error untouched when there is no detail to add", () => {
    const error = new Error("plain");
    expect(attachSqlErrorDetail(error)).toBe(error);
    expect(error.message).toBe("plain");
  });

  test("a frozen error still throws, just without the detail", () => {
    // Diagnostics must never be the thing that fails. Before this the error propagated
    // bare; the worst this can do is leave it exactly that way.
    const error = Object.freeze(forgeSqlError({ traceId: "t-3" }));
    expect(() => attachSqlErrorDetail(error)).not.toThrow();
  });

  test("survives a context that cannot be serialised", () => {
    const circular = {};
    circular.self = circular;
    const detail = describeSqlError(forgeSqlError({ context: circular }));

    expect(detail).toContain("code=UNKNOWN_ERROR");
  });
});

// ── withSqlRetry ──────────────────────────────────────────────────────────────

describe("withSqlRetry", () => {
  test("returns result of successful operation on first try", async () => {
    const op = vi.fn().mockResolvedValue("success");
    expect(await withSqlRetry(op)).toBe("success");
    expect(op).toHaveBeenCalledTimes(1);
  });

  test("retries on RATE_LIMIT_EXCEEDED and eventually resolves", async () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn) => {
      fn();
      return 0;
    });
    const op = vi.fn().mockRejectedValueOnce({ code: "RATE_LIMIT_EXCEEDED" }).mockResolvedValue("ok");
    expect(await withSqlRetry(op)).toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });

  test("propagates non-rate-limit errors immediately without retry", async () => {
    const fatal = new Error("fatal");
    fatal.code = "SYNTAX_ERROR";
    const op = vi.fn().mockRejectedValue(fatal);
    await expect(withSqlRetry(op)).rejects.toThrow("fatal");
    expect(op).toHaveBeenCalledTimes(1);
  });

  test("enriches the error on its way out, at the one point every SQL call passes through", async () => {
    // 333 call sites reach SQL through this wrapper. Attaching the detail anywhere else
    // would mean editing every engine's catch block and still missing the next one written.
    const op = vi.fn().mockRejectedValue(
      forgeSqlError({
        traceId: "trace-9",
        context: { responseText: "Data too long for column 'context' at row 14" },
      }),
    );

    await expect(withSqlRetry(op)).rejects.toThrow(/Data too long for column/);
    await expect(withSqlRetry(op)).rejects.toThrow(/trace=trace-9/);
  });

  test("a rate-limited error that exhausts its retries is enriched too", async () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn) => {
      fn();
      return 0;
    });
    const op = vi.fn().mockRejectedValue(forgeSqlError({ code: "RATE_LIMIT_EXCEEDED", traceId: "trace-10" }));

    await expect(withSqlRetry(op)).rejects.toThrow(/trace=trace-10/);
    expect(op).toHaveBeenCalledTimes(6);
  });

  test("throws after exhausting all retries on persistent rate limiting", async () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn) => {
      fn();
      return 0;
    });
    const rateLimitError = { code: "RATE_LIMIT_EXCEEDED" };
    const op = vi.fn().mockRejectedValue(rateLimitError);
    await expect(withSqlRetry(op)).rejects.toMatchObject({ code: "RATE_LIMIT_EXCEEDED" });
    expect(op).toHaveBeenCalledTimes(6);
  });
});

// ── loadFieldLastChangeMap ────────────────────────────────────────────────────

describe("loadFieldLastChangeMap", () => {
  test("maps field ids to their newest change timestamp", async () => {
    mockSqlQueries([
      [
        { field_id: "customfield_1", last_change_at: "2024-01-01T00:00:00.000Z" },
        { field_id: "customfield_2", last_change_at: "2026-06-01T00:00:00.000Z" },
      ],
    ]);

    const map = await loadFieldLastChangeMap("scope", "v1", ["customfield_1", "customfield_2"]);

    expect(map.get("customfield_1")).toBe("2024-01-01T00:00:00.000Z");
    expect(map.get("customfield_2")).toBe("2026-06-01T00:00:00.000Z");
    expect(map.size).toBe(2);
  });

  test("aggregates with MAX and excludes NULL change dates at the query level", async () => {
    const calls = mockSqlQueries([[]]);

    await loadFieldLastChangeMap("scope", "v1", ["customfield_1"]);

    expect(calls[0].text).toContain("MAX(latest_field_change_at)");
    expect(calls[0].text).toContain("latest_field_change_at IS NOT NULL");
    expect(calls[0].text).toContain("GROUP BY field_id");
  });

  test("scopes the query by scope key and version and filters to the requested ids", async () => {
    const calls = mockSqlQueries([[]]);

    await loadFieldLastChangeMap("scope-a", "v7", ["customfield_1", "customfield_2"]);

    expect(calls[0].text).toContain("field_id IN (?, ?)");
    expect(calls[0].params).toEqual(["scope-a", "v7", "customfield_1", "customfield_2"]);
  });

  test("omits the IN filter entirely when no field ids are given", async () => {
    const calls = mockSqlQueries([[]]);

    await loadFieldLastChangeMap("scope", "v1", null);

    expect(calls[0].text).not.toContain("field_id IN");
    expect(calls[0].params).toEqual(["scope", "v1"]);
  });

  test("returns an empty map without querying when fieldIds is an empty array", async () => {
    const calls = mockSqlQueries([[]]);

    const map = await loadFieldLastChangeMap("scope", "v1", []);

    expect(map.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("chunks large id lists into separate queries and merges the results", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `customfield_${i}`);
    const calls = mockSqlQueries([
      [{ field_id: "customfield_0", last_change_at: "2024-01-01T00:00:00.000Z" }],
      [{ field_id: "customfield_100", last_change_at: "2025-01-01T00:00:00.000Z" }],
      [{ field_id: "customfield_200", last_change_at: "2026-01-01T00:00:00.000Z" }],
    ]);

    const map = await loadFieldLastChangeMap("scope", "v1", ids);

    expect(calls).toHaveLength(3);
    expect(map.size).toBe(3);
    expect(map.get("customfield_200")).toBe("2026-01-01T00:00:00.000Z");
  });

  test("skips rows with a missing field id or null aggregate", async () => {
    mockSqlQueries([
      [
        { field_id: "customfield_1", last_change_at: null },
        { field_id: null, last_change_at: "2026-01-01T00:00:00.000Z" },
        { field_id: "customfield_3", last_change_at: "2026-02-02T00:00:00.000Z" },
      ],
    ]);

    const map = await loadFieldLastChangeMap("scope", "v1", null);

    expect(map.size).toBe(1);
    expect(map.get("customfield_3")).toBe("2026-02-02T00:00:00.000Z");
  });
});

// ── clearAllSnapshotData ──────────────────────────────────────────────────────
//
// Every assertion here is really about blast radius. The function deletes without
// a version filter, so the set of tables it touches -- and the set it must not --
// is the whole safety contract.

// Records SQL text and params per call, returning a fixed rowsAffected so the
// per-table counts can be asserted. The shared mockSqlQueries helper returns
// `rows`, which this function does not read.
function mockDeletes(rowsAffected = 1) {
  const calls = [];
  sql.prepare.mockImplementation((text) => {
    const call = { text, params: null };
    calls.push(call);
    return {
      bindParams: (...params) => {
        call.params = params;
        return { execute: async () => ({ rowsAffected }) };
      },
    };
  });
  return calls;
}

describe("clearAllSnapshotData", () => {
  test("deletes from every derived snapshot table, scoped to the installation", async () => {
    const calls = mockDeletes();

    await clearAllSnapshotData("scope-1");

    const tables = calls.map((c) => c.text.match(/DELETE FROM (\w+)/)[1]);
    expect(tables).toEqual([
      "snapshot_project_usage",
      "snapshot_fields",
      "field_summaries",
      "field_options_cache",
      "issue_scan_buffer",
      "issue_scan_workers",
      "issue_scan_project_totals",
      "issue_scan_meta",
      "report_jobs",
      "snapshot_meta",
    ]);
    for (const call of calls) {
      expect(call.text).toContain("WHERE scope_key = ?");
      expect(call.params).toEqual(["scope-1"]);
    }
  });

  test("never touches saved reports, workflow data, or the RQT index", async () => {
    const calls = mockDeletes();

    await clearAllSnapshotData("scope-1");

    const sqlText = calls.map((c) => c.text).join(" ");
    expect(sqlText).not.toContain("saved_reports");
    expect(sqlText).not.toContain("rqt_");
    expect(sqlText).not.toContain("workflow");
    expect(sqlText).not.toContain("snapshot_statuses");
  });

  test("deletes snapshot_meta last so the app never reports ready over wiped data", async () => {
    const calls = mockDeletes();

    await clearAllSnapshotData("scope-1");

    expect(calls[calls.length - 1].text).toContain("snapshot_meta");
  });

  test("returns per-table and total row counts", async () => {
    mockDeletes(7);

    const result = await clearAllSnapshotData("scope-1");

    expect(result.deleted.snapshot_fields).toBe(7);
    expect(result.deleted.snapshot_meta).toBe(7);
    expect(result.totalRowsDeleted).toBe(70);
  });

  test("treats a missing rowsAffected as zero rather than NaN", async () => {
    const calls = [];
    sql.prepare.mockImplementation((text) => {
      calls.push(text);
      return { bindParams: () => ({ execute: async () => ({}) }) };
    });

    const result = await clearAllSnapshotData("scope-1");

    expect(result.totalRowsDeleted).toBe(0);
    expect(Number.isNaN(result.totalRowsDeleted)).toBe(false);
  });
});
