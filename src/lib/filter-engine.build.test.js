import { vi, describe, test, expect, beforeEach } from "vitest";

// The build path, kept apart from the pure shaping tests because it needs a mocked Jira and a
// mocked store. What is pinned here is what a real site broke on: an estate too large to fetch
// inside one Forge invocation. Single-pass, that was a silent kill -- the row said "building"
// forever and the tab showed a spinner with nothing behind it. Chunked, the same estate takes
// several invocations and finishes.
//
// So the tests that matter are the ones that would pass just as happily against the old
// single-pass build if they were written loosely: that a chunk STOPS after its page budget,
// that it resumes from where it stopped, and that it only publishes when the cursor is spent.

vi.mock("./jira-api.js", () => ({
  incrMetric: vi.fn(),
  METRIC_NAMES: { jiraRequest: "jira-request" },
  getFilterPage: vi.fn(),
  makeJobToken: () => "test-token",
}));

vi.mock("./queues.js", () => ({
  inventorySnapshotQueue: { push: vi.fn() },
}));

vi.mock("./project-store.js", () => ({
  ensureProjectStoreReady: vi.fn(),
  readFilterSnapshotMeta: vi.fn(),
  writeFilterSnapshotMeta: vi.fn(),
  clearFilterSnapshotVersion: vi.fn(),
  appendFilterSnapshot: vi.fn(),
  pruneFilterSnapshots: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  fallbackOn: () => () => undefined,
  ignoreWith: () => () => undefined,
}));

import {
  buildFilterSnapshot,
  queueFilterSnapshotBuild,
  FILTER_CHUNK_PAGES,
  FILTER_PAGE_SIZE,
} from "./filter-engine.js";
import { getFilterPage } from "./jira-api.js";
import { inventorySnapshotQueue } from "./queues.js";
import {
  readFilterSnapshotMeta,
  writeFilterSnapshotMeta,
  clearFilterSnapshotVersion,
  appendFilterSnapshot,
} from "./project-store.js";

const rawFilter = (id) => ({
  id, name: `Filter ${id}`, jql: "project = ADVEV",
  owner: { accountId: "a1", displayName: "Bob", active: true },
  sharePermissions: [], subscriptions: { size: 0, items: [] }, favouritedCount: 0,
});

// A page of `size` filters out of `total`, numbered from `startAt` so the test can prove the
// build resumed at the right offset rather than restarting.
const page = (startAt, size, total) => ({
  values: Array.from({ length: size }, (_, i) => rawFilter(String(startAt + i))),
  total,
  isLast: startAt + size >= total,
});

// The meta row as it stands after the last writeMeta call -- what the next invocation reads.
const metaAfterLastWrite = () => {
  const calls = writeFilterSnapshotMeta.mock.calls;
  return calls.length ? calls[calls.length - 1][1] : null;
};

const building = (over = {}) => ({
  state: "building",
  buildingVersion: "v-1",
  buildToken: "test-token",
  buildCursor: null,
  processed: 0,
  totalExpected: 0,
  updatedAt: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  writeFilterSnapshotMeta.mockResolvedValue({});
  clearFilterSnapshotVersion.mockResolvedValue(undefined);
  appendFilterSnapshot.mockResolvedValue(undefined);
  getFilterPage.mockImplementation(async (startAt) => page(startAt, FILTER_PAGE_SIZE, 10_000));
});

describe("starting a build", () => {
  test("writes an in-flight version and a token, and queues with the envelope", async () => {
    readFilterSnapshotMeta.mockResolvedValue(null);

    const result = await queueFilterSnapshotBuild("inst", { now: 1234 });

    expect(result).toMatchObject({ queued: true, version: "1234" });
    // The published version is NOT set here. A reader must never see a half-built snapshot as
    // current, so the in-flight version travels separately until the build finishes.
    const patch = metaAfterLastWrite();
    expect(patch.version).toBeUndefined();
    expect(patch).toMatchObject({ state: "building", buildingVersion: "1234", processed: 0 });

    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith({
      body: { jobType: "build-filter-snapshot", installationKey: "inst", buildToken: "test-token" },
    });
  });

  test("refuses a second build while one is genuinely running", async () => {
    readFilterSnapshotMeta.mockResolvedValue(building({ updatedAt: new Date().toISOString() }));

    const result = await queueFilterSnapshotBuild("inst");

    expect(result).toMatchObject({ queued: false, reason: "already-building" });
    expect(inventorySnapshotQueue.push).not.toHaveBeenCalled();
  });

  test("allows a rebuild over a build that stopped heartbeating", async () => {
    readFilterSnapshotMeta.mockResolvedValue(building({
      updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }));

    expect((await queueFilterSnapshotBuild("inst")).queued).toBe(true);
  });
});

describe("running a chunk", () => {
  test("stops after its page budget instead of trying to finish the estate", async () => {
    readFilterSnapshotMeta.mockResolvedValue(building());

    const result = await buildFilterSnapshot("inst", { buildToken: "test-token" });

    // The whole point. 10,000 filters is 200 pages; a chunk does FILTER_CHUNK_PAGES and stops,
    // which is why it survives an estate no single invocation could read.
    expect(getFilterPage).toHaveBeenCalledTimes(FILTER_CHUNK_PAGES);
    expect(result).toMatchObject({ checkpointed: true });
    expect(result.completed).toBeUndefined();

    // Checkpointed, not published: still building, and the cursor says where to resume.
    const patch = metaAfterLastWrite();
    expect(patch.state).toBe("building");
    expect(patch.version).toBeUndefined();
    expect(JSON.parse(patch.buildCursor)).toMatchObject({
      startAt: FILTER_CHUNK_PAGES * FILTER_PAGE_SIZE,
    });

    // And it queued itself again, carrying the same token.
    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith({
      body: { jobType: "build-filter-snapshot", installationKey: "inst", buildToken: "test-token" },
    });
  });

  test("resumes from the cursor rather than starting over", async () => {
    readFilterSnapshotMeta.mockResolvedValue(building({
      buildCursor: JSON.stringify({ startAt: 500, total: 10_000 }),
      processed: 500,
    }));

    await buildFilterSnapshot("inst", { buildToken: "test-token" });

    // First fetch of this chunk picks up at 500, not 0. A build that restarted here would
    // never terminate on an estate larger than one chunk.
    expect(getFilterPage).toHaveBeenNthCalledWith(1, 500, FILTER_PAGE_SIZE);
    // Progress accumulates across invocations rather than resetting.
    expect(metaAfterLastWrite().processed).toBe(500 + FILTER_CHUNK_PAGES * FILTER_PAGE_SIZE);
  });

  test("publishes the version only when the cursor is spent", async () => {
    // 60 filters left: two pages, well inside one chunk.
    readFilterSnapshotMeta.mockResolvedValue(building({ buildCursor: JSON.stringify({ startAt: 0, total: 60 }) }));
    getFilterPage.mockImplementation(async (startAt) =>
      page(startAt, Math.min(FILTER_PAGE_SIZE, 60 - startAt), 60));

    const result = await buildFilterSnapshot("inst", { buildToken: "test-token" });

    expect(result).toMatchObject({ completed: true, processed: 60 });
    const patch = metaAfterLastWrite();
    expect(patch).toMatchObject({ state: "ready", version: "v-1", totalFilters: 60, buildCursor: null });
    // No further work queued once it is done.
    expect(inventorySnapshotQueue.push).not.toHaveBeenCalled();
  });

  test("appends rather than replacing, so earlier chunks survive", async () => {
    readFilterSnapshotMeta.mockResolvedValue(building({ buildCursor: JSON.stringify({ startAt: 500, total: 10_000 }) }));

    await buildFilterSnapshot("inst", { buildToken: "test-token" });

    // A chunked build that cleared its version on every write would delete the pages it had
    // already fetched and never finish, however long it ran. Clearing happens once, at start.
    expect(clearFilterSnapshotVersion).not.toHaveBeenCalled();
    expect(appendFilterSnapshot).toHaveBeenCalledWith("inst", "v-1", expect.objectContaining({
      filters: expect.any(Array),
    }));
  });
});

describe("messages that should not be acted on", () => {
  test("ignores a chunk belonging to a superseded build", async () => {
    readFilterSnapshotMeta.mockResolvedValue(building({ buildToken: "current" }));

    const result = await buildFilterSnapshot("inst", { buildToken: "an-older-run" });

    // Rebuilding over a stale build leaves the old run's message in flight. Acting on it would
    // interleave its rows with the new run's under a different version.
    expect(result).toMatchObject({ ignored: true, reason: "stale-token" });
    expect(getFilterPage).not.toHaveBeenCalled();
  });

  test("ignores a chunk for a build that already finished", async () => {
    readFilterSnapshotMeta.mockResolvedValue({ state: "ready", version: "v-1" });

    const result = await buildFilterSnapshot("inst", { buildToken: "test-token" });

    expect(result).toMatchObject({ ignored: true, reason: "not-building" });
    expect(appendFilterSnapshot).not.toHaveBeenCalled();
  });

  test("stops on an empty page even when total claims more remain", async () => {
    readFilterSnapshotMeta.mockResolvedValue(building({ buildCursor: JSON.stringify({ startAt: 0, total: 500 }) }));
    getFilterPage.mockResolvedValue({ values: [], total: 500 });

    const result = await buildFilterSnapshot("inst", { buildToken: "test-token" });

    // Without this guard the chunk spins on the same offset until the invocation is killed --
    // the same failure the build was rewritten to avoid, reintroduced from the other end.
    expect(getFilterPage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ completed: true });
  });
});

describe("failure", () => {
  test("records the error and stops rather than looping", async () => {
    readFilterSnapshotMeta.mockResolvedValue(building());
    getFilterPage.mockRejectedValueOnce(new Error("401 scope does not match"));

    await expect(buildFilterSnapshot("inst", { buildToken: "test-token" })).rejects.toThrow(/401/);

    expect(metaAfterLastWrite()).toMatchObject({
      state: "failed",
      buildCursor: null,
      lastError: expect.stringContaining("401"),
    });
  });

  test("fails a build whose in-flight version went missing, instead of looping on it", async () => {
    readFilterSnapshotMeta.mockResolvedValue(building({ buildingVersion: null }));

    const result = await buildFilterSnapshot("inst", { buildToken: "test-token" });

    expect(result).toMatchObject({ failed: true });
    expect(metaAfterLastWrite().state).toBe("failed");
  });
});
