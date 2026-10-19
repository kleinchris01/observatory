import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, ctxWithAccount } from "../test-harness.js";
import { rovoAssetSearch, rovoAssetInspect, rovoAssetImpact } from "../../resolvers.js";

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// Rovo assets agent
// ---------------------------------------------------------------------------
describe("rovo assets agent", () => {
  const ctx = () => ctxWithAccount();

  function seed() {
    mocks.readAssetSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "as1",
      assetsEnabled: true,
      refreshedAt: "2026-09-02T00:00:00.000Z",
    });
    mocks.loadAssetSchemas.mockResolvedValue([
      { id: "1", name: "Infrastructure", objectSchemaKey: "INFRA", objectTypeCount: 2 },
    ]);
    mocks.loadAssetObjectTypes.mockResolvedValue([
      { id: "9", objectSchemaId: "1", name: "Server", parentObjectTypeId: null },
      { id: "10", objectSchemaId: "1", name: "Rack", parentObjectTypeId: "9" },
    ]);
    mocks.loadAssetAttributes.mockResolvedValue([
      { objectTypeId: "10", name: "Location", type: "text", referenceObjectTypeId: null },
      { objectTypeId: "10", name: "Hosts", type: "reference", referenceObjectTypeId: "9" },
    ]);
  }

  test("search: assets-not-enabled is its own state", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "unavailable", assetsEnabled: false });
    const r = await rovoAssetSearch({ query: "server" }, ctx());
    expect(r.status).toBe("assets-not-enabled");
  });

  test("search: unavailable when built but no version", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "idle" });
    const r = await rovoAssetSearch({ query: "server" }, ctx());
    expect(r.status).toBe("assets-unavailable");
  });

  test("search: ranks schema and type matches", async () => {
    seed();
    const r = await rovoAssetSearch({ query: "rack" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.objectTypes.map((t) => t.name)).toContain("Rack");
  });

  test("inspect: a type reports attributes, children and reference count", async () => {
    seed();
    const r = await rovoAssetInspect({ identifier: "Server" }, ctx());
    expect(r.kind).toBe("type");
    expect(r.childTypes.map((c) => c.name)).toContain("Rack");
    expect(r.referencedByAttributeCount).toBe(1);
  });

  test("impact: a referenced type is 'referenced'", async () => {
    seed();
    const r = await rovoAssetImpact({ name: "Server" }, ctx());
    expect(r.verdict).toBe("referenced");
    expect(r.referencedByAttributeCount).toBe(1);
  });

  test("impact: unknown type is not-found", async () => {
    seed();
    const r = await rovoAssetImpact({ name: "Ghost" }, ctx());
    expect(r.status).toBe("not-found");
  });
});
