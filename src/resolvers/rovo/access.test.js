import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, ctxWithAccount } from "../test-harness.js";
import { rovoAccessSearch, rovoAccessInspect, rovoAccessImpact } from "../../resolvers.js";

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// Rovo access agent
// ---------------------------------------------------------------------------
describe("rovo access agent", () => {
  const ctx = () => ctxWithAccount();

  function seed() {
    mocks.readAccessSnapshotMeta.mockResolvedValue({
      version: "v2",
      state: "ready",
      refreshedAt: "2026-09-03T00:00:00.000Z",
    });
    mocks.readUserSnapshotMeta.mockResolvedValue(null);
    mocks.loadSchemes.mockImplementation(async (_k, _v, family) => {
      if (family === "permission") return [{ id: "p1", name: "Default Permission Scheme", description: "" }];
      if (family === "notification") return [{ id: "n1", name: "Default Notification Scheme", description: "" }];
      return [];
    });
    mocks.loadSchemeHolders.mockImplementation(async (_k, _v, family) => {
      // The real stored shape (store/access.js loadSchemeHolders). These fixtures used to
      // carry holderName, permission and offRoster, matching what the agent wrongly read,
      // which is how a resolver returning null grants passed its tests.
      if (family === "permission")
        return [
          {
            schemeId: "p1",
            context: "ADMINISTER_PROJECTS",
            contextLabel: "Administer Projects",
            holderType: "group",
            holderValue: "grp-1",
            holderLabel: "jira-administrators",
          },
          {
            schemeId: "p1",
            context: "BROWSE_PROJECTS",
            contextLabel: "Browse Projects",
            holderType: "anyone",
            holderValue: "",
            holderLabel: null,
          },
          {
            schemeId: "p1",
            context: "BROWSE_PROJECTS",
            contextLabel: "Browse Projects",
            holderType: "user",
            holderValue: "acc-gone",
            holderLabel: "Sam Gone",
          },
        ];
      return [];
    });
    mocks.loadSchemeProjects.mockResolvedValue([{ schemeId: "p1", projectId: "1" }]);
    mocks.loadSchemeLevels.mockResolvedValue([]);
  }

  test("search: unavailable with no snapshot", async () => {
    mocks.readAccessSnapshotMeta.mockResolvedValue({ state: "idle" });
    const r = await rovoAccessSearch({ query: "default" }, ctx());
    expect(r.status).toBe("access-unavailable");
  });

  test("search: matches per family", async () => {
    seed();
    const r = await rovoAccessSearch({ query: "default" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.schemes.permissions.map((s) => s.name)).toContain("Default Permission Scheme");
    expect(r.schemes.notifications.map((s) => s.name)).toContain("Default Notification Scheme");
  });

  test("search: family filter narrows to one set", async () => {
    seed();
    const r = await rovoAccessSearch({ query: "default", family: "permissions" }, ctx());
    expect(Object.keys(r.schemes)).toEqual(["permissions"]);
  });

  test("inspect: a scheme returns its holders and holder count", async () => {
    seed();
    const r = await rovoAccessInspect({ identifier: "Default Permission Scheme" }, ctx());
    expect(r.family).toBe("permissions");
    expect(r.holderCount).toBe(3);
    expect(r.holders.map((h) => h.value)).toContain("jira-administrators");
    expect(r.holders.find((h) => h.value === "jira-administrators")).toMatchObject({
      id: "grp-1",
      permission: "Administer Projects",
      offRoster: false,
    });
  });

  test("inspect: a user holder is off-roster when the people snapshot does not list them", async () => {
    seed();
    mocks.readUserSnapshotMeta.mockResolvedValue({ version: "u1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "acc-1", active: true }]);
    const r = await rovoAccessInspect({ identifier: "Default Permission Scheme" }, ctx());
    expect(r.holders.find((h) => h.id === "acc-gone").offRoster).toBe(true);
  });

  // No people snapshot: whether a user is on the roster is unknown, not "no".
  test("inspect: off-roster is unknown when there is no people snapshot", async () => {
    seed();
    const r = await rovoAccessInspect({ identifier: "Default Permission Scheme" }, ctx());
    expect(r.holders.find((h) => h.id === "acc-gone").offRoster).toBeNull();
  });

  test("inspect: unknown scheme is not-found", async () => {
    seed();
    const r = await rovoAccessInspect({ identifier: "Nope" }, ctx());
    expect(r.status).toBe("not-found");
  });

  test("impact: a group names in schemes reports where and how", async () => {
    seed();
    const r = await rovoAccessImpact({ name: "jira-administrators" }, ctx());
    expect(r.verdict).toBe("named-in-schemes");
    expect(r.namedIn[0]).toMatchObject({
      family: "permissions",
      as: "group",
      holder: "jira-administrators",
      grants: "Administer Projects",
    });
    expect(r.verdictCaveat).toMatch(/global permissions/);
  });

  test("impact: finds a group by its id as well as its name", async () => {
    seed();
    const r = await rovoAccessImpact({ name: "grp-1" }, ctx());
    expect(r.namedInCount).toBe(1);
  });

  test("impact: an unnamed account is not-named-in-any-scheme", async () => {
    seed();
    const r = await rovoAccessImpact({ name: "5b10ffffffffffffffffffff" }, ctx());
    expect(r.verdict).toBe("not-named-in-any-scheme");
    expect(r.namedInCount).toBe(0);
  });
});
