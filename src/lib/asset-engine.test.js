import { vi, describe, test, expect, beforeEach } from "vitest";

// What to pin: the three normalizers (an object-reference attribute keeps its target type id
// and nothing else does), and buildAssetSnapshot's three terminal states -- ready, "Assets
// not licensed here" (a clean non-failure), and a real failure.

vi.mock("./jira-api.js", () => ({
  incrMetric: vi.fn(),
  METRIC_NAMES: {
    assetSnapshotStarted: "asset-snapshot-started",
    assetSnapshotCompleted: "asset-snapshot-completed",
    assetSnapshotFailed: "asset-snapshot-failed",
    assetTypeCountStarted: "asset-type-count-started",
    assetTypeCountCompleted: "asset-type-count-completed",
    assetTypeCountFailed: "asset-type-count-failed",
  },
  getAssetsWorkspaceId: vi.fn(),
  requestAtlassianJson: vi.fn(),
  mapWithConcurrency: vi.fn(async (items, _c, fn) => {
    const out = [];
    for (let i = 0; i < items.length; i++) out.push(await fn(items[i], i));
    return out;
  }),
}));

vi.mock("./queues.js", () => ({ inventorySnapshotQueue: { push: vi.fn() } }));

vi.mock("./project-store.js", () => ({
  ensureProjectStoreReady: vi.fn(),
  writeAssetSnapshotMeta: vi.fn(),
  readAssetSnapshotMeta: vi.fn(),
  replaceAssetSnapshot: vi.fn(),
  loadAssetObjectTypes: vi.fn(),
  replaceAssetTypeCounts: vi.fn(),
  writeAssetTypeCountMeta: vi.fn(),
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  normalizeSchema,
  normalizeObjectType,
  normalizeAttribute,
  isAssetBuildStale,
  buildAssetSnapshot,
  queueAssetSnapshotBuild,
  buildObjectTypeCountQuery,
  parseAqlTotalCount,
  buildAssetTypeCounts,
  queueAssetTypeCountBuild,
} from "./asset-engine.js";
import { getAssetsWorkspaceId, requestAtlassianJson } from "./jira-api.js";
import { inventorySnapshotQueue } from "./queues.js";
import {
  replaceAssetSnapshot, writeAssetSnapshotMeta,
  readAssetSnapshotMeta, loadAssetObjectTypes,
  replaceAssetTypeCounts, writeAssetTypeCountMeta,
} from "./project-store.js";

beforeEach(() => vi.clearAllMocks());

describe("normalizers", () => {
  test("normalizeSchema keeps the per-schema totals the list API already returns", () => {
    expect(normalizeSchema({ id: 3, name: "Infra", objectSchemaKey: "INFRA", objectTypeCount: 12, objectCount: 4200 }))
      .toEqual({ id: "3", name: "Infra", schemaKey: "INFRA", description: null, objectTypeCount: 12, objectCount: 4200 });
  });

  test("normalizeObjectType carries parent and abstract as the hierarchy signals", () => {
    const t = normalizeObjectType({ id: 9, name: "Server", parentObjectTypeId: 4, abstractObjectType: true, inherited: false }, "1");
    expect(t).toMatchObject({ id: "9", schemaId: "1", name: "Server", parentId: "4", abstract: true, inherited: false });
  });

  test("normalizeAttribute keeps a target type id only for an object reference", () => {
    const ref = normalizeAttribute({ id: 1, name: "Depends on", type: 1, referenceObjectTypeId: 55, objectType: { id: 9 } }, "1");
    expect(ref).toMatchObject({ dataType: "reference", referenceObjectTypeId: "55", objectTypeId: "9" });

    const text = normalizeAttribute({ id: 2, name: "Hostname", type: 0, defaultType: { name: "Text" }, referenceObjectTypeId: 55, objectType: { id: 9 } }, "1");
    // type 0 is not a reference: the stray referenceObjectTypeId is dropped, not trusted.
    expect(text).toMatchObject({ dataType: "default", referenceObjectTypeId: null });
  });
});

describe("isAssetBuildStale", () => {
  test("false unless building, true past the window or with no heartbeat", () => {
    expect(isAssetBuildStale({ state: "ready" })).toBe(false);
    expect(isAssetBuildStale({ state: "building", startedAt: new Date().toISOString() })).toBe(false);
    expect(isAssetBuildStale({ state: "building", startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() })).toBe(true);
    expect(isAssetBuildStale({ state: "building" })).toBe(true);
  });
});

describe("queueAssetSnapshotBuild", () => {
  test("marks building then pushes the job", async () => {
    await queueAssetSnapshotBuild("inst");
    expect(writeAssetSnapshotMeta).toHaveBeenCalledWith("inst", expect.objectContaining({ state: "building" }));
    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith({
      body: { jobType: "build-asset-snapshot", installationKey: "inst" },
    });
  });
});

describe("buildAssetSnapshot", () => {
  test("writes the schema / type / attribute structure and a ready meta", async () => {
    getAssetsWorkspaceId.mockResolvedValue("ws-1");
    requestAtlassianJson.mockImplementation(async (path) => {
      if (path.endsWith("/objectschema/list")) return [{ id: 1, name: "Infra", objectTypeCount: 2, objectCount: 10 }];
      if (path.endsWith("/objecttypes/flat")) return [{ id: 9, name: "Server", objectSchemaId: 1 }, { id: 10, name: "App", parentObjectTypeId: 9, objectSchemaId: 1 }];
      if (path.endsWith("/attributes")) return [
        { id: 100, name: "Name", type: 0, system: true, objectType: { id: 9 } },
        { id: 101, name: "Runs on", type: 1, referenceObjectTypeId: 9, objectType: { id: 10 } },
      ];
      return [];
    });

    const result = await buildAssetSnapshot("inst");

    expect(result).toMatchObject({ schemas: 1, objectTypes: 2, attributes: 2 });
    const [, version, payload] = replaceAssetSnapshot.mock.calls[0];
    expect(version).toEqual(expect.any(String));
    expect(payload.schemas).toHaveLength(1);
    expect(payload.objectTypes.map((t) => t.name).sort()).toEqual(["App", "Server"]);
    expect(payload.attributes.find((a) => a.name === "Runs on").referenceObjectTypeId).toBe("9");
    expect(writeAssetSnapshotMeta).toHaveBeenLastCalledWith("inst", expect.objectContaining({
      state: "ready", assetsEnabled: true, totalSchemas: 1, totalObjectTypes: 2, totalAttributes: 2,
    }));
  });

  test("records a clean 'not enabled' state when the site has no workspace", async () => {
    getAssetsWorkspaceId.mockResolvedValue(null);

    const result = await buildAssetSnapshot("inst");

    expect(result).toMatchObject({ unavailable: true });
    expect(replaceAssetSnapshot).not.toHaveBeenCalled();
    expect(writeAssetSnapshotMeta).toHaveBeenLastCalledWith("inst", expect.objectContaining({
      state: "unavailable", assetsEnabled: false,
    }));
  });

  test("treats a 403 from the schema list as 'not enabled', not a failure", async () => {
    getAssetsWorkspaceId.mockResolvedValue("ws-1");
    const denied = new Error("gateway 403");
    denied.status = 403;
    requestAtlassianJson.mockRejectedValueOnce(denied);

    const result = await buildAssetSnapshot("inst");

    expect(result).toMatchObject({ unavailable: true });
    expect(writeAssetSnapshotMeta).toHaveBeenLastCalledWith("inst", expect.objectContaining({ state: "unavailable" }));
  });

  test("marks the build failed and rethrows on a real error", async () => {
    getAssetsWorkspaceId.mockResolvedValue("ws-1");
    const boom = new Error("gateway 500");
    boom.status = 500;
    requestAtlassianJson.mockRejectedValueOnce(boom);

    await expect(buildAssetSnapshot("inst")).rejects.toThrow("gateway 500");
    expect(writeAssetSnapshotMeta).toHaveBeenLastCalledWith("inst", expect.objectContaining({ state: "failed" }));
  });
});

describe("buildObjectTypeCountQuery", () => {
  test("disambiguates by schema and escapes a quote in the type name", () => {
    expect(buildObjectTypeCountQuery("3", 'Server "prod"'))
      .toBe('objectSchemaId = 3 AND objectType = "Server \\"prod\\""');
  });
});

describe("parseAqlTotalCount", () => {
  test("reads the first count-shaped key it recognises", () => {
    expect(parseAqlTotalCount({ totalFilterCount: 42 })).toBe(42);
    expect(parseAqlTotalCount({ total: 0 })).toBe(0);
    expect(parseAqlTotalCount({ totalCount: 7 })).toBe(7);
  });

  test("returns null rather than 0 for a shape it does not recognise", () => {
    expect(parseAqlTotalCount({ objectEntries: [] })).toBeNull();
    expect(parseAqlTotalCount(null)).toBeNull();
  });
});

describe("queueAssetTypeCountBuild", () => {
  test("marks building then pushes the job", async () => {
    await queueAssetTypeCountBuild("inst");
    expect(writeAssetTypeCountMeta).toHaveBeenCalledWith("inst", expect.objectContaining({ state: "building" }));
    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith({
      body: { jobType: "build-asset-type-counts", installationKey: "inst" },
    });
  });
});

describe("buildAssetTypeCounts", () => {
  test("skips without a structure snapshot rather than crawling nothing", async () => {
    readAssetSnapshotMeta.mockResolvedValue(null);

    const result = await buildAssetTypeCounts("inst");

    expect(result).toMatchObject({ queued: false, reason: "no-structure-snapshot" });
    expect(loadAssetObjectTypes).not.toHaveBeenCalled();
    expect(writeAssetTypeCountMeta).toHaveBeenLastCalledWith("inst", expect.objectContaining({ state: "idle" }));
  });

  test("counts every concrete type, skips abstract ones, and tallies unmeasured on a per-type failure", async () => {
    readAssetSnapshotMeta.mockResolvedValue({ version: "v1", workspaceId: "ws-1" });
    loadAssetObjectTypes.mockResolvedValue([
      { id: "9", schemaId: "1", name: "Server", abstract: false },
      { id: "10", schemaId: "1", name: "Base", abstract: true },
      { id: "11", schemaId: "1", name: "Laptop", abstract: false },
    ]);
    requestAtlassianJson.mockImplementation(async (path, { body }) => {
      if (body.qlQuery.includes("Server")) return { totalFilterCount: 42 };
      throw new Error("gateway 500");
    });

    const result = await buildAssetTypeCounts("inst");

    expect(result).toEqual({ measured: 1, unmeasured: 1, total: 2 });
    expect(replaceAssetTypeCounts).toHaveBeenCalledWith("inst", [
      expect.objectContaining({ objectTypeId: "9", objectCount: 42 }),
    ]);
    expect(writeAssetTypeCountMeta).toHaveBeenLastCalledWith("inst", expect.objectContaining({
      state: "ready", measuredTypes: 1, unmeasuredTypes: 1,
    }));
  });

  test("records a type as unmeasured, not zero, when the response has no count-shaped key", async () => {
    readAssetSnapshotMeta.mockResolvedValue({ version: "v1", workspaceId: "ws-1" });
    loadAssetObjectTypes.mockResolvedValue([{ id: "9", schemaId: "1", name: "Server", abstract: false }]);
    requestAtlassianJson.mockResolvedValue({ objectEntries: [] });

    const result = await buildAssetTypeCounts("inst");

    expect(result).toEqual({ measured: 0, unmeasured: 1, total: 1 });
    expect(replaceAssetTypeCounts).toHaveBeenCalledWith("inst", []);
  });
});
