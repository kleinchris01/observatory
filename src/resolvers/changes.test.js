import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks } from "./test-harness.js";
import { __RAW_ADMIN_ONLY_FUNCTIONS } from "../resolvers.js";

const { getChangeHistory, buildChangeHistory } = __RAW_ADMIN_ONLY_FUNCTIONS;

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

describe("getChangeHistory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("reports never-built, with the tracked-pillar list, when no drift pass has run", async () => {
    mocks.readDriftSnapshotMeta.mockResolvedValue(null);
    const result = await getChangeHistory({ payload: {}, ...ctx });
    expect(result).toMatchObject({ neverBuilt: true, changes: [] });
    expect(result.trackedPillars.map((p) => p.key)).toContain("access");
    expect(mocks.loadConfigChanges).not.toHaveBeenCalled();
  });

  test("returns a page of changes plus the trailing-window summary", async () => {
    mocks.readDriftSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "v1",
      refreshedAt: "2026-09-03T00:00:00Z",
      lastRunChanges: 2,
      totalChanges: 40,
    });
    mocks.loadConfigChanges.mockResolvedValue([
      {
        changeId: "v1-0",
        detectedAt: "2026-09-03T00:00:00Z",
        pillar: "access",
        entityType: "permission-scheme",
        entityId: "1",
        label: "Prod",
        changeKind: "modified",
        summary: 'Permission scheme "Prod" changed: name',
      },
    ]);
    mocks.loadConfigChangeSummary.mockResolvedValue({
      total: 5,
      byPillar: { access: 5 },
      byKind: { added: 2, removed: 1, modified: 2 },
    });

    const result = await getChangeHistory({ payload: { pillar: "access", limit: 50 }, ...ctx });

    expect(result.neverBuilt).toBe(false);
    expect(result.changes).toHaveLength(1);
    expect(result.summary.total).toBe(5);
    expect(result.nextCursor).toBeNull();
    // pillar filter threaded through; asked for limit+1 to detect a further page
    expect(mocks.loadConfigChanges).toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({ pillar: "access", limit: 51 }),
    );
  });

  test("sets nextCursor when a further page exists", async () => {
    mocks.readDriftSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadConfigChanges.mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => ({
        changeId: `v1-${i}`,
        detectedAt: `2026-09-0${3 - i}T00:00:00Z`,
        pillar: "workflow",
        entityType: "status",
        entityId: String(i),
        label: "S",
        changeKind: "added",
        summary: "x",
      })),
    );
    const result = await getChangeHistory({ payload: { limit: 2 }, ...ctx });
    expect(result.changes).toHaveLength(2);
    // Carries the change id: rows of one drift pass share a timestamp.
    expect(result.nextCursor).toBe("2026-09-02T00:00:00Z|v1-1");
  });
});

describe("buildChangeHistory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("queues a drift pass when nothing is running", async () => {
    mocks.readDriftSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.readAdminConfig?.mockResolvedValue?.({ readOnlyMode: false });

    const result = await buildChangeHistory(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueDriftSnapshotBuild).toHaveBeenCalledWith("test-install");
  });

  test("refuses while a live pass is running", async () => {
    mocks.readDriftSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isDriftBuildStale.mockReturnValue(false);

    const result = await buildChangeHistory(ctx);

    expect(result).toMatchObject({ queued: false, reason: "already-building" });
    expect(mocks.queueDriftSnapshotBuild).not.toHaveBeenCalled();
  });
});
