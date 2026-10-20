import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, ctxWithAccount } from "../test-harness.js";
import { rovoEstateSearch, rovoEstateInspect } from "../../resolvers.js";

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// Rovo priorities & resolutions agent
// ---------------------------------------------------------------------------
describe("rovo estate agent", () => {
  const ctx = () => ctxWithAccount();

  function seed() {
    mocks.readEstateSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "e1",
      refreshedAt: "2026-09-03T00:00:00.000Z",
    });
    mocks.loadEstateValues.mockImplementation(async (_k, _v, kind) => {
      if (kind === "resolution")
        return [
          { id: "1", name: "Done", isDefault: true },
          { id: "2", name: "Fixed", isDefault: false },
        ];
      return [
        { id: "1", name: "High", isDefault: false },
        { id: "2", name: "Low", isDefault: false },
      ];
    });
  }

  test("search: unavailable with no snapshot", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValue(null);
    const r = await rovoEstateSearch({ query: "done" }, ctx());
    expect(r.status).toBe("priorities & resolutions-unavailable");
  });

  test("search: matches resolutions and priorities", async () => {
    seed();
    const r = await rovoEstateSearch({ query: "done" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.resolutions.map((x) => x.name)).toContain("Done");
  });

  test("inspect: reports counts and whether each list has a default", async () => {
    seed();
    const r = await rovoEstateInspect({}, ctx());
    expect(r.status).toBe("ok");
    expect(r.resolutions.hasDefault).toBe(true);
    expect(r.priorities.hasDefault).toBe(false);
  });

  test("inspect: list filter narrows the response", async () => {
    seed();
    const r = await rovoEstateInspect({ list: "priorities" }, ctx());
    expect(r).not.toHaveProperty("resolutions");
    expect(r.priorities.count).toBe(2);
  });
});
