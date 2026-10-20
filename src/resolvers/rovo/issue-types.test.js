import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, ctxWithAccount } from "../test-harness.js";
import { rovoIssueTypeSearch, rovoIssueTypeInspect, rovoIssueTypeImpact } from "../../resolvers.js";

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// Rovo issue type agent
// ---------------------------------------------------------------------------
describe("rovo issue type agent", () => {
  const ctx = () => ctxWithAccount();

  function seed() {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({
      version: "v3",
      state: "ready",
      refreshedAt: "2026-09-02T00:00:00.000Z",
    });
    mocks.loadIssueTypes.mockResolvedValue([
      { id: "10", name: "Bug", hierarchyLevel: 0, subtask: false, description: "a defect" },
      { id: "11", name: "Change Request", hierarchyLevel: 0, subtask: false, description: "" },
      { id: "12", name: "Sub-task", hierarchyLevel: -1, subtask: true, description: "" },
    ]);
    mocks.loadIssueTypeSchemes.mockResolvedValue([
      { schemeId: "s1", name: "Default Issue Type Scheme", isDefault: true, defaultIssueTypeId: "10" },
      { schemeId: "s2", name: "Ops Scheme", isDefault: false },
    ]);
    mocks.loadIssueTypeSchemeItems.mockResolvedValue([
      { schemeId: "s1", issueTypeId: "10" },
      { schemeId: "s1", issueTypeId: "11" },
    ]);
    mocks.loadIssueTypeSchemeProjects.mockResolvedValue([
      { schemeId: "s1", projectId: "1", projectKey: "ABC", projectName: "Alpha" },
    ]);
  }

  test("search: unavailable with no snapshot", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "idle" });
    const r = await rovoIssueTypeSearch({ query: "bug" }, ctx());
    expect(r.status).toBe("issue types-unavailable");
  });

  test("search: ranks type and scheme matches", async () => {
    seed();
    const r = await rovoIssueTypeSearch({ query: "change" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.refreshedAt).toBe("2026-09-02T00:00:00.000Z");
    expect(r.issueTypes.map((t) => t.name)).toContain("Change Request");
  });

  test("inspect: a scheme lists its members and projects", async () => {
    seed();
    const r = await rovoIssueTypeInspect({ identifier: "Default Issue Type Scheme" }, ctx());
    expect(r.kind).toBe("scheme");
    expect(r.issueTypes.map((t) => t.name).sort()).toEqual(["Bug", "Change Request"]);
    expect(r.projects).toEqual([{ projectKey: "ABC", projectName: "Alpha" }]);
  });

  test("inspect: a type reports which schemes reach it", async () => {
    seed();
    const r = await rovoIssueTypeInspect({ identifier: "Bug" }, ctx());
    expect(r.kind).toBe("type");
    expect(r.reachedBySchemeCount).toBe(1);
  });

  test("impact: a type no scheme reaches is no-scheme-reaches-it", async () => {
    seed();
    const r = await rovoIssueTypeImpact({ name: "Sub-task" }, ctx());
    expect(r.verdict).toBe("no-scheme-reaches-it");
    expect(r.reachedBySchemeCount).toBe(0);
  });

  test("impact: unknown type is not-found", async () => {
    seed();
    const r = await rovoIssueTypeImpact({ name: "Ghost" }, ctx());
    expect(r.status).toBe("not-found");
  });
});
