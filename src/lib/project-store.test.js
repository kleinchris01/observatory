import { vi, describe, test, expect, beforeEach, afterEach } from "vitest";

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

import {
  chunkArray,
  safeParseJson,
  toNumber,
  isSqlRateLimitError,
  withSqlRetry,
} from "./project-store.js";

afterEach(() => vi.restoreAllMocks());

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

// ── withSqlRetry ──────────────────────────────────────────────────────────────

describe("withSqlRetry", () => {
  test("returns result of successful operation on first try", async () => {
    const op = vi.fn().mockResolvedValue("success");
    expect(await withSqlRetry(op)).toBe("success");
    expect(op).toHaveBeenCalledTimes(1);
  });

  test("retries on RATE_LIMIT_EXCEEDED and eventually resolves", async () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn) => { fn(); return 0; });
    const op = vi.fn()
      .mockRejectedValueOnce({ code: "RATE_LIMIT_EXCEEDED" })
      .mockResolvedValue("ok");
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

  test("throws after exhausting all retries on persistent rate limiting", async () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn) => { fn(); return 0; });
    const rateLimitError = { code: "RATE_LIMIT_EXCEEDED" };
    const op = vi.fn().mockRejectedValue(rateLimitError);
    await expect(withSqlRetry(op)).rejects.toMatchObject({ code: "RATE_LIMIT_EXCEEDED" });
    expect(op).toHaveBeenCalledTimes(6);
  });
});
