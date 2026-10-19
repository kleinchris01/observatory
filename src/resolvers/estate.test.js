import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks } from "./test-harness.js";
import { __RAW_ADMIN_ONLY_FUNCTIONS } from "../resolvers.js";

const { getEstateInventory, buildEstateInventory } = __RAW_ADMIN_ONLY_FUNCTIONS;

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

describe("getEstateInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("reports never-built when no snapshot exists", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValue(null);
    const result = await getEstateInventory(ctx);
    expect(result).toMatchObject({ neverBuilt: true, resolutions: [], priorities: [] });
    expect(result.governance.available).toBe(false);
    expect(mocks.loadEstateValues).not.toHaveBeenCalled();
  });

  test("returns both lists with the duplicate-name governance summary", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "v1",
      refreshedAt: "2026-09-03T00:00:00Z",
    });
    mocks.loadEstateValues.mockImplementation(async (_k, _v, kind) =>
      kind === "resolution"
        ? [
            { id: "1", name: "Done", isDefault: true },
            { id: "2", name: "done" },
          ]
        : [{ id: "10", name: "High", isDefault: true }],
    );

    const result = await getEstateInventory(ctx);

    expect(result.neverBuilt).toBe(false);
    expect(result.resolutions).toHaveLength(2);
    expect(result.governance).toMatchObject({
      available: true,
      resolutionDuplicateGroupCount: 1,
      reducibleResolutionCount: 1,
    });
  });

  // The crawl counted issues per value all along; only the Overview attached them, so every
  // row on the tab read "Not measured".
  test("attaches the crawl's issue counts to each value", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadEstateValues.mockImplementation(async (_k, _v, kind) =>
      kind === "resolution" ? [{ id: "1", name: "Done" }] : [{ id: "10", name: "High" }],
    );
    mocks.loadEstateValueTotals.mockResolvedValueOnce([
      { kind: "resolution", valueId: "1", issueCount: 500 },
      { kind: "resolution", valueId: "", issueCount: 12 },
    ]);

    const result = await getEstateInventory(ctx);

    expect(result.resolutions[0].issueCount).toBe(500);
    expect(result.priorities[0].issueCount).toBe(0);
    expect(result.usageMeasured).toBe(true);
    expect(result.unresolvedIssueCount).toBe(12);
  });

  test("keeps counts unmeasured when the totals cannot be read", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadEstateValues.mockResolvedValue([{ id: "1", name: "Done" }]);
    mocks.loadEstateValueTotals.mockRejectedValueOnce(new Error("sql down"));

    const result = await getEstateInventory(ctx);

    expect(result.resolutions[0].issueCount).toBeNull();
    expect(result.usageMeasured).toBe(false);
  });
});

describe("buildEstateInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("queues a build when nothing is running", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.readAdminConfig?.mockResolvedValue?.({ readOnlyMode: false });

    const result = await buildEstateInventory(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueEstateSnapshotBuild).toHaveBeenCalledWith("test-install");
  });

  test("refuses while a live build is running", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isEstateBuildStale.mockReturnValue(false);

    const result = await buildEstateInventory(ctx);

    expect(result).toMatchObject({ queued: false, reason: "already-building" });
    expect(mocks.queueEstateSnapshotBuild).not.toHaveBeenCalled();
  });
});
