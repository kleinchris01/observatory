import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, ctxWithAccount } from "../test-harness.js";
import { rovoChangeSearch, rovoChangeInspect } from "../../resolvers.js";

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// Rovo configuration change agent
// ---------------------------------------------------------------------------
describe("rovo change agent", () => {
  const ctx = () => ctxWithAccount();

  function seed() {
    mocks.readDriftSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "dv1",
      refreshedAt: "2026-09-03T00:00:00.000Z",
      totalChanges: 3,
    });
    mocks.loadConfigChanges.mockResolvedValue([
      {
        detectedAt: "2026-09-03",
        pillar: "workflows",
        entityType: "status",
        label: "In Review",
        changeKind: "modified",
        summary: "category changed",
      },
      {
        detectedAt: "2026-09-02",
        pillar: "access",
        entityType: "scheme",
        label: "Default Permission Scheme",
        changeKind: "modified",
        summary: "holder added",
      },
      {
        detectedAt: "2026-08-20",
        pillar: "workflows",
        entityType: "status",
        label: "In Review",
        changeKind: "added",
        summary: "created",
      },
    ]);
  }

  test("search: unavailable with no drift snapshot", async () => {
    mocks.readDriftSnapshotMeta.mockResolvedValue(null);
    const r = await rovoChangeSearch({ query: "review" }, ctx());
    expect(r.status).toBe("configuration changes-unavailable");
  });

  test("search: phrase-matches the entity label", async () => {
    seed();
    const r = await rovoChangeSearch({ query: "review" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.changes.every((c) => c.label === "In Review")).toBe(true);
    expect(r.totalRecorded).toBe(3);
  });

  test("search: no phrase lists recent changes", async () => {
    seed();
    const r = await rovoChangeSearch({}, ctx());
    expect(r.changes.length).toBe(3);
  });

  test("inspect: returns the full history for one entity", async () => {
    seed();
    const r = await rovoChangeInspect({ label: "In Review" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.changeCount).toBe(2);
    expect(r.history.map((h) => h.kind).sort()).toEqual(["added", "modified"]);
  });

  test("inspect: an entity with no recorded change is not-found", async () => {
    seed();
    const r = await rovoChangeInspect({ label: "Never Touched" }, ctx());
    expect(r.status).toBe("not-found");
  });
});
