import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, ctxWithAccount } from "../test-harness.js";
import { rovoPeopleSearch, rovoPeopleInspect, rovoPeopleImpact } from "../../resolvers.js";

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// Rovo people agent
// ---------------------------------------------------------------------------
describe("rovo people agent", () => {
  const ctx = () => ctxWithAccount();

  function seedRoster() {
    mocks.readUserSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "u1",
      refreshedAt: "2026-09-03T00:00:00.000Z",
    });
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readAccessSnapshotMeta.mockResolvedValue(null);
    mocks.readAutomationPart.mockResolvedValue(null);
    mocks.loadSchemesGrantingHolder.mockResolvedValue([]);
    mocks.loadUsers.mockResolvedValue([
      {
        accountId: "acc-1",
        displayName: "Dana Ops",
        active: true,
        groups: [{ id: "g1", name: "ops-team" }],
        applications: ["jira-software"],
      },
      { accountId: "acc-2", displayName: "Sam Gone", active: false, groups: [], applications: [] },
    ]);
    mocks.loadUserGovernanceSummary.mockResolvedValue({ totalUsers: 2, activeUsers: 1 });
  }

  test("search: unavailable with no roster", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue(null);
    const r = await rovoPeopleSearch({ query: "dana" }, ctx());
    expect(r.status).toBe("people-unavailable");
  });

  test("search: resolves a display name to an account and surfaces groups", async () => {
    seedRoster();
    const r = await rovoPeopleSearch({ query: "ops" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.users.map((u) => u.accountId)).toContain("acc-1");
    expect(r.groups.map((g) => g.name)).toContain("ops-team");
    expect(r.rosterSize).toBe(2);
  });

  test("search: empty query errors", async () => {
    const r = await rovoPeopleSearch({ query: "" }, ctx());
    expect(r.status).toBe("error");
  });

  test("inspect: requires an accountId", async () => {
    const r = await rovoPeopleInspect({}, ctx());
    expect(r.status).toBe("error");
  });

  test("inspect: unavailable when getUserDetails has no roster", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue(null);
    const r = await rovoPeopleInspect({ accountId: "acc-1" }, ctx());
    expect(r.status).toBe("people-unavailable");
  });

  test("inspect: returns a footprint shape for a known account", async () => {
    seedRoster();
    const r = await rovoPeopleInspect({ accountId: "acc-1" }, ctx());
    expect(r.status).toBe("ok");
    expect(r).toHaveProperty("ownedFilters");
    expect(r).toHaveProperty("referencedInRules");
  });

  test("impact: returns a verdict and per-source data caveats", async () => {
    seedRoster();
    const r = await rovoPeopleImpact({ accountId: "acc-2" }, ctx());
    expect(r.status).toBe("ok");
    expect(["no-cross-pillar-footprint", "has-footprint"]).toContain(r.verdict);
    expect(r.dataCaveats).toHaveProperty("automation");
    expect(r.verdictCaveat).toMatch(/ownerless/);
  });

  // Cross-pillar (Access via groups): most real access runs through a group, and a scheme
  // granting to a group the account belongs to used to be invisible to this verdict entirely
  // -- an account holding admin purely via group membership read as "no footprint".
  test("impact: has-footprint from a group-granted scheme alone, with no direct grant, owned artifact or rule reference", async () => {
    seedRoster();
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    mocks.loadSchemesGrantingHolder.mockImplementation((_i, _v, holderType, holderValue) => {
      if (holderType === "group" && holderValue === "g1") {
        return Promise.resolve([
          { schemeType: "permission", schemeId: "1", schemeName: "Prod", context: "ADMINISTER_PROJECTS" },
        ]);
      }
      return Promise.resolve([]);
    });

    const r = await rovoPeopleImpact({ accountId: "acc-1" }, ctx()); // acc-1 is in group g1
    expect(r.verdict).toBe("has-footprint");
    expect(r.groupSchemeGrants).toBe(1);
    expect(r.grantedViaGroups).toEqual(["ops-team"]);
    expect(r.verdictCaveat).toMatch(/held through a group membership/);
  });

  test("impact: two groups granting the same scheme count once, not twice", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "u1" });
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readAutomationPart.mockResolvedValue(null);
    mocks.loadUsers.mockResolvedValue([
      {
        accountId: "acc-1",
        displayName: "Dana Ops",
        active: true,
        groups: [
          { id: "g1", name: "ops-team" },
          { id: "g2", name: "ops-leads" },
        ],
        applications: [],
      },
    ]);
    mocks.loadUserGovernanceSummary.mockResolvedValue({ totalUsers: 1, activeUsers: 1 });
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    mocks.loadSchemesGrantingHolder.mockImplementation((_i, _v, holderType) => {
      if (holderType === "group") {
        return Promise.resolve([
          { schemeType: "permission", schemeId: "1", schemeName: "Prod", context: "ADMINISTER_PROJECTS" },
        ]);
      }
      return Promise.resolve([]);
    });

    const r = await rovoPeopleImpact({ accountId: "acc-1" }, ctx());
    expect(r.groupSchemeGrants).toBe(1);
    expect(r.grantedViaGroups.sort()).toEqual(["ops-leads", "ops-team"]);
  });

  test("impact: no cross-pillar footprint when no groups grant anything", async () => {
    seedRoster();
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    mocks.loadSchemesGrantingHolder.mockResolvedValue([]);
    const r = await rovoPeopleImpact({ accountId: "acc-2" }, ctx()); // acc-2 has no groups
    expect(r.groupSchemeGrants).toBe(0);
    expect(r.grantedViaGroups).toEqual([]);
  });
});
