import { vi, describe, test, expect, beforeEach } from "vitest";

// The projection arithmetic is the part worth pinning. Its whole job is to say whether a
// full pass fits one queue invocation, and two stories are waiting on that answer -- an
// arithmetic error here does not produce a wrong number, it produces the wrong plan.

vi.mock("./jira-api.js", () => ({
  getAllScreens: vi.fn(),
  getScreenTabs: vi.fn(),
  getScreenTabFields: vi.fn(),
  getScanTelemetry: vi.fn(() => ({ rl429Count: 0, rlRetryCount: 0 })),
  mapWithConcurrency: async (items, _c, fn) => {
    const out = [];
    for (const item of items) out.push(await fn(item));
    return out;
  },
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  fallbackOn: () => () => undefined,
  ignoreWith: () => () => undefined,
}));

import {
  sampleScreens,
  projectFullPassCost,
  measureScreenFetchCost,
  CONSUMER_BUDGET_MS,
  SAFE_BUDGET_FRACTION,
} from "./screen-probe.js";
import { getAllScreens, getScreenTabs, getScreenTabFields, getScanTelemetry } from "./jira-api.js";

beforeEach(() => vi.clearAllMocks());

describe("sampleScreens", () => {
  test("returns everything when the catalog is smaller than the sample", () => {
    const screens = [{ id: 1 }, { id: 2 }];
    expect(sampleScreens(screens, 25)).toHaveLength(2);
  });

  test("draws without replacement", () => {
    const screens = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    const picked = sampleScreens(screens, 10);
    expect(picked).toHaveLength(10);
    expect(new Set(picked.map((s) => s.id)).size).toBe(10);
  });

  // Screens come back in roughly creation order, and the oldest are systematically the
  // sprawling ones everything else was cloned from. Taking the head would measure the
  // wrong end of the distribution, and would do it the same way every run.
  test("does not simply take the head of the list", () => {
    const screens = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    // Deterministic non-zero picker: always draw from the middle of the remaining pool.
    const picked = sampleScreens(screens, 5, () => 0.5);
    expect(picked.map((s) => s.id)).not.toEqual([0, 1, 2, 3, 4]);
  });

  test("never leaves the pool with a hole in it", () => {
    const screens = Array.from({ length: 8 }, (_, i) => ({ id: i }));
    const picked = sampleScreens(screens, 8, () => 0.999);
    expect(picked.filter(Boolean)).toHaveLength(8);
  });
});

describe("projectFullPassCost", () => {
  const base = {
    totalScreens: 500,
    screenListCalls: 5,
    tabCounts: [1, 1, 2, 2, 3],
    measuredCalls: 100,
    measuredMs: 20000, // 200ms per call
  };

  test("projects one tabs call plus one fields call per tab, across every screen", () => {
    const p = projectFullPassCost(base);
    // mean tabs 1.8 -> 500 * (1 + 1.8) = 1400, plus 5 screen-list calls
    expect(p.meanTabsPerScreen).toBe(1.8);
    expect(p.projectedCalls).toBe(1405);
  });

  test("derives per-call cost from observed wall time, not a nominal interval", () => {
    const p = projectFullPassCost(base);
    expect(p.msPerCall).toBe(200);
    expect(p.projectedMs).toBe(1405 * 200);
  });

  // The mean hides the thing that decides whether batching is needed. A flat 2 tabs
  // everywhere and a mean of 2 with a max of 19 are different engineering problems.
  test("reports the tail alongside the mean", () => {
    const p = projectFullPassCost({ ...base, tabCounts: [1, 1, 1, 1, 19] });
    expect(p.meanTabsPerScreen).toBe(4.6);
    expect(p.medianTabsPerScreen).toBe(1);
    expect(p.maxTabsPerScreen).toBe(19);
  });

  test("judges fit against a fraction of the budget, not the raw ceiling", () => {
    const budget = CONSUMER_BUDGET_MS * SAFE_BUDGET_FRACTION;
    expect(budget).toBeLessThan(CONSUMER_BUDGET_MS);

    // Sized to land between the safe budget and the hard ceiling: a pass that would
    // "fit" against 900s but leaves no room for promotion or a retry.
    const p = projectFullPassCost({
      totalScreens: 1000, screenListCalls: 10, tabCounts: [3],
      measuredCalls: 100, measuredMs: 20000,
    });
    expect(p.projectedMs).toBeGreaterThan(budget);
    expect(p.projectedMs).toBeLessThan(CONSUMER_BUDGET_MS * 2);
    expect(p.fitsOneInvocation).toBe(false);
  });

  test("a small site fits comfortably", () => {
    const p = projectFullPassCost({
      totalScreens: 40, screenListCalls: 1, tabCounts: [1, 1, 2],
      measuredCalls: 50, measuredMs: 10000,
    });
    expect(p.fitsOneInvocation).toBe(true);
  });

  test("does not claim a fit when nothing was measured", () => {
    const p = projectFullPassCost({
      totalScreens: 0, screenListCalls: 1, tabCounts: [], measuredCalls: 0, measuredMs: 0,
    });
    expect(p.projectedMs).toBe(0);
    // Zero duration is absence of evidence, not proof of a fast pass.
    expect(p.fitsOneInvocation).toBe(false);
  });
});

describe("measureScreenFetchCost", () => {
  test("says so plainly when the site returns no screens", async () => {
    getAllScreens.mockResolvedValue([]);
    const result = await measureScreenFetchCost();

    expect(result.totalScreens).toBe(0);
    // Ambiguous on purpose: an empty result and a missing scope look identical here, and
    // the note must not resolve that ambiguity in favour of the reassuring reading.
    expect(result.note).toMatch(/scopes are not yet granted/i);
  });

  test("measures tabs and fields across the sample", async () => {
    getAllScreens.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    getScreenTabs.mockResolvedValue([{ id: 10 }, { id: 11 }]);
    getScreenTabFields.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);

    const result = await measureScreenFetchCost({ sampleSize: 2 });

    expect(result.totalScreens).toBe(2);
    expect(result.sampledScreens).toBe(2);
    expect(result.meanTabsPerScreen).toBe(2);
    expect(result.meanFieldsPerScreen).toBe(6);
    // 1 screen-list + per screen (1 tabs + 2 fields) x 2 = 7
    expect(result.measuredCalls).toBe(7);
  });

  // Counting a screen we could not read as zero tabs would drag the mean down and make the
  // projection optimistic -- understating exactly the cost the probe exists to surface.
  test("excludes unreadable screens from the distribution rather than scoring them zero", async () => {
    getAllScreens.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    getScreenTabs
      .mockResolvedValueOnce([{ id: 10 }, { id: 11 }, { id: 12 }])
      .mockRejectedValueOnce(new Error("403 forbidden"));
    getScreenTabFields.mockResolvedValue([]);

    const result = await measureScreenFetchCost({ sampleSize: 2 });

    expect(result.failureCount).toBe(1);
    expect(result.sampledScreens).toBe(1);
    expect(result.meanTabsPerScreen).toBe(3);
  });

  test("a failing tab read does not abort the pass", async () => {
    getAllScreens.mockResolvedValue([{ id: 1 }]);
    getScreenTabs.mockResolvedValue([{ id: 10 }, { id: 11 }]);
    getScreenTabFields
      .mockRejectedValueOnce(new Error("500"))
      .mockResolvedValueOnce([{ id: "a" }]);

    const result = await measureScreenFetchCost({ sampleSize: 1 });

    expect(result.ok).toBe(true);
    expect(result.failureCount).toBe(1);
    expect(result.sampledScreens).toBe(1);
  });

  // The counters are process-global, so an absolute reading would attribute whatever else
  // ran on this container to the probe.
  test("attributes rate-limit pressure by difference, not absolute reading", async () => {
    getScanTelemetry
      .mockReturnValueOnce({ rl429Count: 12, rlRetryCount: 30 })
      .mockReturnValueOnce({ rl429Count: 15, rlRetryCount: 38 });
    getAllScreens.mockResolvedValue([{ id: 1 }]);
    getScreenTabs.mockResolvedValue([]);

    const result = await measureScreenFetchCost({ sampleSize: 1 });

    expect(result.rateLimit).toEqual({ hit429: 3, retries: 8 });
  });

  test("caps the reported failure list while keeping the true count", async () => {
    getAllScreens.mockResolvedValue(Array.from({ length: 30 }, (_, i) => ({ id: i })));
    getScreenTabs.mockRejectedValue(new Error("nope"));

    const result = await measureScreenFetchCost({ sampleSize: 30 });

    expect(result.failureCount).toBe(30);
    expect(result.failures).toHaveLength(10);
  });
});
