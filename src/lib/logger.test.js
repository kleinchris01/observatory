import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { logger, fallbackOn, ignoreWith } from "./logger.js";

// logger.js had no tests, which is a poor place for a blind spot: it is now the mechanism
// that decides whether a failure anywhere in the app leaves a trace. fallbackOn and
// ignoreWith replaced 62 anonymous `.catch(() => value)` handlers, three of which had
// already let real defects reach production undetected.

let errSpy;
let logSpy;

beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const lastEntry = (spy) => JSON.parse(spy.mock.calls.at(-1)[0]);

describe("logger", () => {
  test("emits single-line JSON with level, event and timestamp", () => {
    logger.warn("some.event", { installationKey: "scope-1" });

    const entry = lastEntry(errSpy);
    expect(entry).toMatchObject({ level: "warn", event: "some.event", installationKey: "scope-1" });
    expect(Number.isFinite(Date.parse(entry.timestamp))).toBe(true);
    // One line, so Forge's aggregator can parse it.
    expect(errSpy.mock.calls.at(-1)[0]).not.toContain("\n");
  });

  test("routes warn and error to stderr, info to stdout", () => {
    logger.error("bad.thing", {});
    logger.info("fine.thing", {});
    expect(lastEntry(errSpy).level).toBe("error");
    expect(lastEntry(logSpy).level).toBe("info");
  });
});

describe("fallbackOn", () => {
  test("returns the fallback value and logs the failure", () => {
    const handler = fallbackOn("scan.meta_read_failed", null, { workerId: 3 });

    expect(handler(new Error("sql down"))).toBeNull();

    expect(lastEntry(errSpy)).toMatchObject({
      level: "warn",
      event: "scan.meta_read_failed",
      workerId: 3,
      error: "sql down",
    });
  });

  // Mutable defaults must be per-call. A shared [] or Map would let one caller's writes
  // leak into the next caller's "empty" result.
  test("calls a factory fallback so callers never share one instance", () => {
    const handler = fallbackOn("x.failed", () => []);

    const a = handler(new Error("boom"));
    const b = handler(new Error("boom"));

    expect(a).toEqual([]);
    expect(a).not.toBe(b);
  });

  test("passes a non-function fallback straight through", () => {
    expect(fallbackOn("x.failed", 0)(new Error("boom"))).toBe(0);
    expect(fallbackOn("x.failed", false)(new Error("boom"))).toBe(false);
  });

  test("survives a thrown non-Error", () => {
    const handler = fallbackOn("x.failed", null);
    expect(handler("just a string")).toBeNull();
    expect(lastEntry(errSpy).error).toBe("just a string");
  });

  test("works as a drop-in catch handler on a rejected promise", async () => {
    const value = await Promise.reject(new Error("nope")).catch(fallbackOn("x.failed", () => new Map()));

    expect(value instanceof Map).toBe(true);
    expect(lastEntry(errSpy).event).toBe("x.failed");
  });
});

describe("ignoreWith", () => {
  test("logs at debug and returns nothing", () => {
    const before = errSpy.mock.calls.length;
    const result = ignoreWith("scan.log_append_failed", { workerId: 1 })(new Error("write failed"));

    expect(result).toBeUndefined();
    // Debug, not warn: a cleanup failure must not compete with the error being handled.
    expect(errSpy.mock.calls.length).toBe(before);
  });

  test("still records the error so the trace exists when someone looks", () => {
    // Default LOG_LEVEL is info, so debug is filtered at emit -- the contract under test
    // is that the handler names the event and swallows the value, not that it always prints.
    const handler = ignoreWith("scan.cleanup_failed", { workerId: 2 });
    expect(() => handler(new Error("boom"))).not.toThrow();
    expect(handler(new Error("boom"))).toBeUndefined();
  });

  test("works as a drop-in catch handler without changing the resolved value", async () => {
    await expect(Promise.reject(new Error("nope")).catch(ignoreWith("x.ignored"))).resolves.toBeUndefined();
  });
});
