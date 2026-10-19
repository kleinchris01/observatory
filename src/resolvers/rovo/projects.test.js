import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, ctxWithAccount } from "../test-harness.js";
import { rovoProjectSearch, rovoProjectInspect } from "../../resolvers.js";

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// Rovo project agent
// ---------------------------------------------------------------------------
describe("rovo project agent", () => {
  const ctx = () => ctxWithAccount();

  function seedProjects() {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "fv1", state: "ready" });
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha Beta" },
      { projectId: "11", projectKey: "XYZ", projectName: "Ex Why Zed" },
    ]);
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["10", "11"]));
  }

  test("search: unavailable when there is no field snapshot to list projects from", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    const r = await rovoProjectSearch({ query: "alpha" }, ctx());
    expect(r.status).toBe("projects-unavailable");
  });

  test("search: matches browsable projects by key or name", async () => {
    seedProjects();
    const r = await rovoProjectSearch({ query: "alpha" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.projects.map((p) => p.projectKey)).toContain("ABC");
    expect(r.browsableProjectCount).toBe(2);
  });

  test("inspect: requires an id or key", async () => {
    const r = await rovoProjectInspect({}, ctx());
    expect(r.status).toBe("error");
  });

  test("inspect: an unknown key is not-found", async () => {
    seedProjects();
    const r = await rovoProjectInspect({ projectKey: "NOPE" }, ctx());
    expect(r.status).toBe("not-found");
  });

  // The bug: a Rovo agent action arrives with no user principal, so getBrowsableProjectIds
  // (which needs an accountId) returns an empty set and every project reads as un-browsable.
  // With no caller to check against, the agent falls back to the app's own snapshot.
  test("search: falls back to the snapshot when the context carries no account", async () => {
    seedProjects();
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set()); // as it behaves with no accountId
    const r = await rovoProjectSearch({ query: "alpha" }, { installContext: "ari:cloud:jira::site/x" });
    expect(r.status).toBe("ok");
    expect(r.projects.map((p) => p.projectKey)).toContain("ABC");
  });

  test("search: still filters by browse permission when the context DOES carry an account", async () => {
    seedProjects();
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["11"])); // ABC not browsable for this user
    const r = await rovoProjectSearch({ query: "alpha" }, ctxWithAccount("limited-user"));
    expect(r.status).toBe("ok");
    expect(r.projects.map((p) => p.projectKey)).not.toContain("ABC");
  });

  // The action used to read keys the overview never returns, so every project came back
  // with no workflow scheme, no roles and no name.
  test("inspect: reports the workflow scheme, roles and name the overview holds", async () => {
    seedProjects();
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1" });
    mocks.loadWorkflowSchemeForProject.mockResolvedValueOnce({
      schemeId: "ws1",
      name: "Software Simplified",
      description: "",
    });
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    mocks.loadProjectSchemes.mockResolvedValueOnce([]);
    mocks.loadProjectRoleActors.mockResolvedValueOnce([
      { roleId: "r1", roleName: "Administrators", holderType: "user", holderValue: "acc-1", holderLabel: "Dana" },
    ]);
    const r = await rovoProjectInspect({ projectId: "10", projectKey: "ABC" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.project).toMatchObject({ projectKey: "ABC", projectName: "Alpha Beta" });
    expect(r.project).not.toHaveProperty("lead");
    expect(r.workflowScheme).toMatchObject({ id: "ws1", name: "Software Simplified" });
    expect(r.roles.byRole[0]).toMatchObject({ roleName: "Administrators" });
    expect(r.dataCaveats).toMatch(/lead/);
  });

  test("inspect: an agent action (no account) reads a project the browse check would have hidden", async () => {
    seedProjects();
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set());
    mocks.attachUniqueIssueCounts?.mockImplementation?.(async (_k, rows) => rows);
    const r = await rovoProjectInspect(
      { projectId: "10", projectKey: "ABC" },
      { installContext: "ari:cloud:jira::site/x" },
    );
    // getProjectOverview no longer short-circuits to not-authorised; it proceeds to build.
    expect(r.status).not.toBe("not-authorised");
  });
});
