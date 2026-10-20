import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks } from "./test-harness.js";
import { __RAW_ADMIN_ONLY_FUNCTIONS } from "../resolvers.js";

const { getAssetInventory, buildAssetInventory, buildAssetTypeCountCrawl } = __RAW_ADMIN_ONLY_FUNCTIONS;

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

describe("probeAssetsApi", () => {
  const probeAssetsApi = __RAW_ADMIN_ONLY_FUNCTIONS.probeAssetsApi;

  test("reports Assets not enabled when the workspace hop fails, and never touches the gateway", async () => {
    mocks.probeEndpoint.mockResolvedValue({ path: "w", status: 404, ok: false, ms: 4, sample: "no" });

    const result = await probeAssetsApi({ context: {} });

    expect(result).toMatchObject({ assetsEnabled: false, workspaceId: null });
    expect(mocks.probeStargateEndpoint).not.toHaveBeenCalled();
  });

  test("probes the Assets gateway endpoints once a workspace is discovered", async () => {
    mocks.probeEndpoint.mockResolvedValue({
      path: "w",
      status: 200,
      ok: true,
      ms: 4,
      sample: '{"values":[{"workspaceId":"ws-1"}]}',
    });
    mocks.probeStargateEndpoint.mockResolvedValue({
      path: "s",
      status: 200,
      ok: true,
      ms: 6,
      sample: '{"objectSchemas":[{"id":"1"}]}',
    });

    const result = await probeAssetsApi({ context: {} });

    expect(result.workspaceId).toBe("ws-1");
    const gatewayPaths = mocks.probeStargateEndpoint.mock.calls.map((c) => c[0]);
    expect(gatewayPaths.some((p) => p.includes("/jsm/assets/workspace/ws-1/v1/objectschema/list"))).toBe(true);
  });
});

describe("getAssetInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("reports never-built when no snapshot exists", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue(null);
    const result = await getAssetInventory(ctx);
    expect(result).toMatchObject({ neverBuilt: true, schemas: [], governance: null });
  });

  test("surfaces 'Assets not enabled' as a first-class state, not an empty catalogue", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({
      state: "unavailable",
      assetsEnabled: false,
      lastError: "no workspace",
    });
    const result = await getAssetInventory(ctx);
    expect(result).toMatchObject({ state: "unavailable", assetsEnabled: false, neverBuilt: false });
    expect(result.governance).toMatchObject({ assetsEnabled: false });
    expect(mocks.loadAssetSchemas).not.toHaveBeenCalled();
  });

  test("returns the structure and the governance summary when built", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "v1",
      assetsEnabled: true,
      workspaceId: "ws-1",
    });
    mocks.loadAssetSchemas.mockResolvedValue([
      { id: "1", name: "Infra", objectTypeCount: 2, objectCount: 40 },
      { id: "2", name: "Empty", objectTypeCount: 0, objectCount: 0 },
    ]);
    mocks.loadAssetObjectTypes.mockResolvedValue([
      { id: "9", schemaId: "1", name: "Server", parentId: null, abstract: false },
    ]);
    mocks.loadAssetAttributes.mockResolvedValue([
      { id: "a", objectTypeId: "9", name: "OS", referenceObjectTypeId: "404", system: false },
    ]);

    const result = await getAssetInventory(ctx);

    expect(result).toMatchObject({ state: "ready", assetsEnabled: true, version: "v1", workspaceId: "ws-1" });
    expect(result.schemas).toHaveLength(2);
    expect(result.governance).toMatchObject({ deadSchemaCount: 1, brokenReferenceCount: 1 });
  });

  test("folds the object-count crawl's rows and meta in alongside the structure", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "v1",
      assetsEnabled: true,
      workspaceId: "ws-1",
    });
    mocks.loadAssetSchemas.mockResolvedValue([{ id: "1", name: "Infra", objectTypeCount: 1, objectCount: 10 }]);
    mocks.loadAssetObjectTypes.mockResolvedValue([
      { id: "9", schemaId: "1", name: "Server", parentId: null, abstract: false },
    ]);
    mocks.loadAssetTypeCounts.mockResolvedValue([{ objectTypeId: "9", schemaId: "1", objectCount: 0 }]);
    mocks.readAssetTypeCountMeta.mockResolvedValue({
      state: "ready",
      refreshedAt: "2026-09-16T00:00:00Z",
      measuredTypes: 1,
      unmeasuredTypes: 0,
    });

    const result = await getAssetInventory(ctx);

    expect(result.typeCounts).toEqual([{ objectTypeId: "9", schemaId: "1", objectCount: 0 }]);
    expect(result.governance).toMatchObject({ countsMeasured: true, emptyObjectTypeCount: 1 });
    expect(result.typeCountCrawl).toMatchObject({ state: "ready", measuredTypes: 1, unmeasuredTypes: 0 });
  });
});

describe("buildAssetTypeCountCrawl", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("refuses without a structure snapshot to crawl against", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue(null);
    const result = await buildAssetTypeCountCrawl(ctx);
    expect(result).toMatchObject({ queued: false });
    expect(mocks.queueAssetTypeCountBuild).not.toHaveBeenCalled();
  });

  test("queues the crawl when a structure snapshot exists and nothing is running", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.readAssetTypeCountMeta.mockResolvedValue({ state: "idle" });
    mocks.readAdminConfig?.mockResolvedValue?.({ readOnlyMode: false });

    const result = await buildAssetTypeCountCrawl(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueAssetTypeCountBuild).toHaveBeenCalledWith("test-install");
  });

  test("refuses while its own crawl is already running", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.readAssetTypeCountMeta.mockResolvedValue({ state: "building" });
    mocks.isAssetTypeCountBuildStale.mockReturnValue(false);

    const result = await buildAssetTypeCountCrawl(ctx);

    expect(result).toMatchObject({ queued: false, reason: "already-building" });
    expect(mocks.queueAssetTypeCountBuild).not.toHaveBeenCalled();
  });
});

describe("buildAssetInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("queues a build when nothing is running", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.readAdminConfig?.mockResolvedValue?.({ readOnlyMode: false });

    const result = await buildAssetInventory(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueAssetSnapshotBuild).toHaveBeenCalledWith("test-install");
  });

  test("refuses while a live build is running", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isAssetBuildStale.mockReturnValue(false);

    const result = await buildAssetInventory(ctx);

    expect(result).toMatchObject({ queued: false, reason: "already-building" });
    expect(mocks.queueAssetSnapshotBuild).not.toHaveBeenCalled();
  });
});
