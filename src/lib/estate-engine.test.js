import { vi, describe, test, expect, beforeEach } from "vitest";

vi.mock("./jira-api.js", () => ({
  incrMetric: vi.fn(),
  METRIC_NAMES: { estateSnapshotStarted: "a", estateSnapshotCompleted: "b", estateSnapshotFailed: "c" },
  getAllResolutions: vi.fn(async () => []),
  getAllPriorities: vi.fn(async () => []),
}));
vi.mock("./queues.js", () => ({ inventorySnapshotQueue: { push: vi.fn() } }));
vi.mock("./logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./project-store.js", () => ({
  ensureProjectStoreReady: vi.fn(),
  writeEstateSnapshotMeta: vi.fn(),
  readEstateSnapshotMeta: vi.fn(),
  replaceEstateSnapshot: vi.fn(),
}));

import { normalizeValue, isEstateBuildStale, queueEstateSnapshotBuild, buildEstateSnapshot } from "./estate-engine.js";
import * as jiraApi from "./jira-api.js";
import { inventorySnapshotQueue } from "./queues.js";
import { replaceEstateSnapshot, writeEstateSnapshotMeta } from "./project-store.js";

beforeEach(() => vi.clearAllMocks());

describe("normalizeValue", () => {
  test("stringifies the id, keeps isDefault, and stamps the sort order", () => {
    expect(normalizeValue({ id: 10001, name: "Done", isDefault: true }, 3))
      .toEqual({ id: "10001", name: "Done", description: null, isDefault: true, sortOrder: 3 });
  });
});

describe("isEstateBuildStale", () => {
  test("false unless building, true past the window", () => {
    expect(isEstateBuildStale({ state: "ready" })).toBe(false);
    expect(isEstateBuildStale({ state: "building", startedAt: new Date().toISOString() })).toBe(false);
    expect(isEstateBuildStale({ state: "building", startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() })).toBe(true);
  });
});

describe("queueEstateSnapshotBuild", () => {
  test("marks building then pushes the job", async () => {
    await queueEstateSnapshotBuild("inst");
    expect(writeEstateSnapshotMeta).toHaveBeenCalledWith("inst", expect.objectContaining({ state: "building" }));
    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith({ body: { jobType: "build-estate-snapshot", installationKey: "inst" } });
  });
});

describe("buildEstateSnapshot", () => {
  test("writes both lists and marks the meta ready with totals", async () => {
    jiraApi.getAllResolutions.mockResolvedValue([{ id: "1", name: "Done", isDefault: true }, { id: "2", name: "Fixed" }]);
    jiraApi.getAllPriorities.mockResolvedValue([{ id: "10", name: "High" }]);

    const result = await buildEstateSnapshot("inst");

    expect(result).toMatchObject({ resolutions: 2, priorities: 1 });
    const [, version, payload] = replaceEstateSnapshot.mock.calls[0];
    expect(version).toEqual(expect.any(String));
    expect(payload.resolutions).toHaveLength(2);
    expect(payload.priorities).toHaveLength(1);
    expect(writeEstateSnapshotMeta).toHaveBeenLastCalledWith("inst", expect.objectContaining({
      state: "ready", totalResolutions: 2, totalPriorities: 1,
    }));
  });

  test("marks the build failed and rethrows on a hard error", async () => {
    jiraApi.getAllResolutions.mockResolvedValue([]);
    jiraApi.getAllPriorities.mockResolvedValue([]);
    replaceEstateSnapshot.mockRejectedValueOnce(new Error("sql down"));

    await expect(buildEstateSnapshot("inst")).rejects.toThrow("sql down");
    expect(writeEstateSnapshotMeta).toHaveBeenLastCalledWith("inst", expect.objectContaining({ state: "failed" }));
  });
});
