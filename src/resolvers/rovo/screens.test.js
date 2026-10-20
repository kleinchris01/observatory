import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, ctxWithAccount } from "../test-harness.js";
import { rovoScreenSearch, rovoScreenInspect, rovoScreenImpact } from "../../resolvers.js";

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// Rovo screen agent
// ---------------------------------------------------------------------------
describe("rovo screen agent", () => {
  const ctx = () => ctxWithAccount();

  function seed() {
    mocks.readScreenSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "sv1",
      refreshedAt: "2026-09-02T00:00:00.000Z",
    });
    mocks.loadScreensPage.mockResolvedValue({
      total: 2,
      rows: [
        {
          screenId: "100",
          name: "Default Create Screen",
          fieldCount: 30,
          tabCount: 2,
          projectCount: 40,
          tabs: [{ name: "Field Tab", fields: [1, 2] }],
        },
        { screenId: "101", name: "Bug Screen", fieldCount: 12, tabCount: 1, projectCount: 3 },
      ],
    });
    mocks.loadScreenSchemes.mockResolvedValue([{ id: "5", name: "Default Screen Scheme" }]);
    mocks.loadScreenSchemeOperations.mockResolvedValue([
      { schemeId: "5", schemeName: "Default Screen Scheme", operation: "default", screenId: "100" },
    ]);
    mocks.loadIssueTypeScreenSchemes.mockResolvedValue([]);
  }

  test("search: unavailable with no snapshot", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);
    const r = await rovoScreenSearch({ query: "create" }, ctx());
    expect(r.status).toBe("screens-unavailable");
  });

  test("search: ranks screen and scheme matches", async () => {
    seed();
    const r = await rovoScreenSearch({ query: "screen" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.screenSchemes.map((s) => s.name)).toContain("Default Screen Scheme");
  });

  test("inspect: a screen returns tabs and field count", async () => {
    seed();
    const r = await rovoScreenInspect({ identifier: "Default Create Screen" }, ctx());
    expect(r.kind).toBe("screen");
    expect(r.screen.fieldCount).toBe(30);
    expect(r.screen.tabs[0]).toMatchObject({ name: "Field Tab", fieldCount: 2 });
  });

  test("inspect: a scheme returns its operation mapping", async () => {
    seed();
    const r = await rovoScreenInspect({ identifier: "Default Screen Scheme" }, ctx());
    expect(r.kind).toBe("scheme");
    expect(r.operations[0]).toMatchObject({ operation: "default", screenId: "100" });
  });

  test("impact: a screen a scheme operation points at is 'routed'", async () => {
    seed();
    const r = await rovoScreenImpact({ name: "Default Create Screen" }, ctx());
    expect(r.verdict).toBe("routed");
    expect(r.routedBySchemeCount).toBe(1);
  });

  test("impact: a screen nothing points at is 'nothing-routes-to-it'", async () => {
    seed();
    const r = await rovoScreenImpact({ name: "Bug Screen" }, ctx());
    expect(r.verdict).toBe("nothing-routes-to-it");
  });
});
