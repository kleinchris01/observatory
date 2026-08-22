import { vi, describe, test, expect, beforeEach } from "vitest";

// The build path, kept apart from the pure shaping tests because it needs a mocked Jira and
// a mocked store. What is pinned here is what a real site broke on: a fetch that cannot
// finish inside Forge's invocation ceiling. Hard-killed, it leaves the meta row saying
// "building" forever and the tab has nothing to show but a spinner. Bounded, it fails on its
// own terms and says how far it got.

vi.mock("./jira-api.js", () => ({
  incrMetric: vi.fn(),
  METRIC_NAMES: { jiraRequest: "jira-request" },
  getAllFilters: vi.fn(),
}));

vi.mock("./project-store.js", () => ({
  ensureProjectStoreReady: vi.fn(),
  readFilterSnapshotMeta: vi.fn(),
  writeFilterSnapshotMeta: vi.fn(),
  replaceFilterSnapshot: vi.fn(),
  pruneFilterSnapshots: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  fallbackOn: () => () => undefined,
  ignoreWith: () => () => undefined,
}));

import { buildFilterSnapshot, FILTER_FETCH_BUDGET_MS } from "./filter-engine.js";
import { getAllFilters } from "./jira-api.js";
import {
  readFilterSnapshotMeta,
  writeFilterSnapshotMeta,
  replaceFilterSnapshot,
} from "./project-store.js";

const rawFilter = (id) => ({
  id, name: `Filter ${id}`, jql: "project = ADVEV",
  owner: { accountId: "a1", displayName: "Bob", active: true },
  sharePermissions: [], subscriptions: { size: 0, items: [] }, favouritedCount: 0,
});

// The state each write left behind, in order -- the sequence is the point, not any one call.
const statesWritten = () =>
  writeFilterSnapshotMeta.mock.calls.map(([, patch]) => patch);

beforeEach(() => {
  vi.clearAllMocks();
  readFilterSnapshotMeta.mockResolvedValue(null);
  writeFilterSnapshotMeta.mockResolvedValue({});
  replaceFilterSnapshot.mockResolvedValue(undefined);
});

describe("buildFilterSnapshot time budget", () => {
  test("gives up on its own terms rather than being killed mid-fetch", async () => {
    // A fetch whose pages keep arriving after the budget has already elapsed.
    getAllFilters.mockImplementation(async ({ onPage }) => {
      vi.setSystemTime(new Date(Date.now() + FILTER_FETCH_BUDGET_MS + 1000));
      await onPage({ fetched: 3400, total: 9000, startAt: 3400 });
      return [];
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T00:00:00.000Z"));
    // Rethrown after the failure is recorded, which is the engine's existing contract: the
    // consumer logs it and counts the metric. What matters is that the row is written first,
    // so the tab has something to say either way.
    await expect(buildFilterSnapshot("inst", { now: Date.now() }))
      .rejects.toThrow(/more saved filters than one pass can read/);
    vi.useRealTimers();

    const failure = statesWritten().find((p) => p.state === "failed");
    expect(failure).toBeTruthy();
    // The count is the diagnostic. "Something went wrong" would leave the next person
    // guessing at whether it was scope, auth, or size.
    expect(failure.lastError).toMatch(/3400 filters/);
    expect(failure.lastError).toMatch(/time limit/i);

    // Critically: no snapshot is committed. A partial one would report every filter it never
    // read as free of findings, which is the false all-clear this app exists to refuse.
    expect(replaceFilterSnapshot).not.toHaveBeenCalled();
  });

  test("records progress while a long fetch is still running", async () => {
    getAllFilters.mockImplementation(async ({ onPage }) => {
      await onPage({ fetched: 50, total: 500, startAt: 50 });
      // Past the throttle interval, so this one is written.
      vi.setSystemTime(new Date(Date.now() + 45_000));
      await onPage({ fetched: 100, total: 500, startAt: 100 });
      return [rawFilter("1")];
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T00:00:00.000Z"));
    await buildFilterSnapshot("inst", { now: Date.now() });
    vi.useRealTimers();

    // A row that says how far it got, so a build killed anyway still leaves a trail.
    expect(statesWritten().some((p) => p.totalFilters === 100)).toBe(true);
  });

  test("a build that finishes in time is untouched by any of this", async () => {
    getAllFilters.mockImplementation(async ({ onPage }) => {
      await onPage({ fetched: 2, total: 2, startAt: 2 });
      return [rawFilter("1"), rawFilter("2")];
    });

    const result = await buildFilterSnapshot("inst");

    expect(result.built).toBe(true);
    expect(result.filters).toBe(2);
    expect(replaceFilterSnapshot).toHaveBeenCalled();
    expect(statesWritten().some((p) => p.state === "failed")).toBe(false);
    expect(statesWritten().find((p) => p.state === "ready")).toMatchObject({ totalFilters: 2 });
  });
});
