import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks } from "./test-harness.js";
import { __RAW_ADMIN_ONLY_FUNCTIONS } from "../resolvers.js";

const { getUserInventory, getUserDetails, buildUserInventory } = __RAW_ADMIN_ONLY_FUNCTIONS;

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

describe("getUserInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("reports never-built rather than an empty roster", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue(null);
    const result = await getUserInventory(ctx);
    expect(result).toMatchObject({ neverBuilt: true, users: [], applicationSummary: [] });
  });

  test("returns the roster, seat summary and governance once built", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "v1",
      refreshedAt: "2026-09-02T00:00:00.000Z",
      applicationSummary: [{ key: "jira-software", numberOfSeats: 5, userCount: 3 }],
    });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.loadUserGovernanceSummary.mockResolvedValue({
      totalUsers: 1,
      activeUsers: 1,
      appUsers: 0,
      multiProductUsers: 0,
    });

    const result = await getUserInventory(ctx);

    expect(result).toMatchObject({
      neverBuilt: false,
      version: "v1",
      users: [{ accountId: "a1" }],
      applicationSummary: [{ key: "jira-software" }],
      governance: { totalUsers: 1 },
    });
  });

  test("attaches per-user ownership counts and an estate orphan count", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.loadUserGovernanceSummary.mockResolvedValue({ totalUsers: 1 });
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "d1" });
    mocks.loadFilters.mockResolvedValue([
      { id: "10", name: "Ann filter", ownerAccountId: "a1" },
      { id: "11", name: "Ghost filter", ownerAccountId: "gone" },
    ]);
    mocks.loadDashboards.mockResolvedValue([{ dashboardId: "20", name: "Ann dash", ownerAccountId: "a1" }]);
    mocks.readAutomationPart.mockResolvedValue(null);

    const result = await getUserInventory(ctx);

    expect(result.users[0]).toMatchObject({ ownedFilters: 1, ownedDashboards: 1, authoredRules: 0 });
    // The filter owned by "gone" (not in the roster) is an orphan.
    expect(result.governance).toMatchObject({ orphanedFilters: 1, orphanedOwners: 1 });
  });

  test("counts the automation rules that name each account, and the off-roster ones", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.loadUserGovernanceSummary.mockResolvedValue({ totalUsers: 1 });
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    mocks.readDashboardSnapshotMeta.mockResolvedValue(null);
    mocks.readAutomationPart.mockImplementation((_k, part) =>
      part === "users"
        ? Promise.resolve({
            entries: [
              { label: "a1", write: [1, 2], read: [2], trigger: [] },
              { label: "gone", write: [3], read: [], trigger: [] },
            ],
          })
        : Promise.resolve(null),
    );

    const result = await getUserInventory(ctx);

    // a1 is named by two distinct rules (1 and 2).
    expect(result.users[0].automationRefs).toBe(2);
    expect(result.automationRefsAvailable).toBe(true);
    expect(result.governance).toMatchObject({ automationRefUsers: 2, orphanedAutomationRefUsers: 1 });
  });
});

describe("getUserDetails", () => {
  const ctx = { payload: { accountId: "a1" }, context: { installContext: "ari:cloud:jira::site/x" } };

  test("returns the user's owned filters and dashboards as lists", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "d1" });
    mocks.loadFilters.mockResolvedValue([{ id: "10", name: "Ann filter", ownerAccountId: "a1", viewUrl: "u" }]);
    mocks.loadDashboards.mockResolvedValue([{ dashboardId: "20", name: "Ann dash", ownerAccountId: "a1" }]);
    mocks.readAutomationPart.mockResolvedValue(null);

    const result = await getUserDetails(ctx);

    expect(result).toMatchObject({
      available: true,
      inRoster: true,
      ownedFilters: [{ id: "10", name: "Ann filter" }],
      ownedDashboards: [{ id: "20", name: "Ann dash" }],
      authoredRules: [],
    });
  });

  test("reports no-roster when nothing has been built", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue(null);
    expect(await getUserDetails(ctx)).toMatchObject({ available: false });
  });

  test("lists the user-picker fields this account is a value in, joined to field names", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readAutomationPart.mockResolvedValue(null);
    mocks.loadUserFieldAppearances.mockResolvedValue([
      { fieldId: "customfield_500", issueCount: 30 },
      { fieldId: "assignee", issueCount: 900 },
    ]);
    mocks.loadSnapshotFieldNames.mockResolvedValue(
      new Map([
        ["customfield_500", "Reviewer"],
        ["assignee", "Assignee"],
      ]),
    );

    const result = await getUserDetails(ctx);

    expect(result.fieldAppearancesAvailable).toBe(true);
    expect(result.fieldAppearances).toEqual([
      { fieldId: "customfield_500", fieldName: "Reviewer", issueCount: 30 },
      { fieldId: "assignee", fieldName: "Assignee", issueCount: 900 },
    ]);
  });

  test("lists the automation rules that name this account, joined to rule names", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    mocks.readDashboardSnapshotMeta.mockResolvedValue(null);
    mocks.readAutomationPart.mockImplementation((_k, part) => {
      if (part === "users") return Promise.resolve({ entries: [{ label: "a1", write: [7], read: [9], trigger: [] }] });
      if (part === "directory")
        return Promise.resolve({
          rules: [
            [7, "Assign to Ann", 1, "t", 0],
            [9, "Escalate", 0, "t", 0],
          ],
        });
      return Promise.resolve(null);
    });

    const result = await getUserDetails(ctx);

    expect(result.automationRefsAvailable).toBe(true);
    expect(result.referencedInRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 7, name: "Assign to Ann", direction: "write", enabled: true }),
        expect.objectContaining({ id: 9, name: "Escalate", direction: "read", enabled: false }),
      ]),
    );
  });

  // Cross-pillar (Access): permission grants, security-level memberships and notification
  // recipients that name this account directly.
  test("lists the schemes that name this account directly when the access inventory exists", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.readAutomationPart.mockResolvedValue(null);
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    mocks.loadSchemesGrantingHolder.mockResolvedValue([
      {
        schemeType: "permission",
        schemeId: "1",
        schemeName: "Prod",
        context: "ADMINISTER_PROJECTS",
        contextLabel: "Administer Projects",
      },
    ]);

    const result = await getUserDetails(ctx);

    expect(result.accessGrantsAvailable).toBe(true);
    expect(result.grantedBySchemes).toEqual([
      expect.objectContaining({ schemeType: "permission", schemeName: "Prod", contextLabel: "Administer Projects" }),
    ]);
    expect(mocks.loadSchemesGrantingHolder).toHaveBeenCalledWith("test-install", "a1", "user", "a1");
  });

  // Cross-pillar (Access): the common case, not the edge case -- most real grants run
  // through a group, not a direct grant on the account, and grantedBySchemes (holder_type =
  // "user" only) could not see a single one of them.
  test("lists schemes granted via a group this account belongs to, distinct from direct grants", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadUsers.mockResolvedValue([
      {
        accountId: "a1",
        displayName: "Ann",
        applications: [],
        groups: [
          { id: "g1", name: "jira-administrators" },
          { id: "g2", name: "marketing-contractors" },
        ],
      },
    ]);
    mocks.readAutomationPart.mockResolvedValue(null);
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    mocks.loadSchemesGrantingHolder.mockImplementation((_install, _version, holderType, holderValue) => {
      if (holderType === "user") return Promise.resolve([]);
      if (holderType === "group" && holderValue === "g1") {
        return Promise.resolve([
          {
            schemeType: "permission",
            schemeId: "1",
            schemeName: "Prod",
            context: "ADMINISTER_PROJECTS",
            contextLabel: "Administer Projects",
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const result = await getUserDetails(ctx);

    expect(result.grantedBySchemes).toEqual([]);
    expect(result.grantedByGroups).toEqual([
      expect.objectContaining({
        schemeName: "Prod",
        contextLabel: "Administer Projects",
        viaGroup: "jira-administrators",
      }),
    ]);
    expect(mocks.loadSchemesGrantingHolder).toHaveBeenCalledWith("test-install", "a1", "group", "g1");
    expect(mocks.loadSchemesGrantingHolder).toHaveBeenCalledWith("test-install", "a1", "group", "g2");
  });

  test("does not query group grants when the account belongs to no groups", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.readAutomationPart.mockResolvedValue(null);
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    mocks.loadSchemesGrantingHolder.mockResolvedValue([]);

    const result = await getUserDetails(ctx);

    expect(result.grantedByGroups).toEqual([]);
    expect(mocks.loadSchemesGrantingHolder).toHaveBeenCalledTimes(1); // the direct-user check only
  });

  test("reports access grants unavailable when the access inventory has not been built", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.readAutomationPart.mockResolvedValue(null);
    mocks.readAccessSnapshotMeta.mockResolvedValue(null);

    const result = await getUserDetails(ctx);

    expect(result.accessGrantsAvailable).toBe(false);
    expect(result.grantedBySchemes).toEqual([]);
  });
});

describe("buildUserInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("queues a build when nothing is running", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.readAdminConfig?.mockResolvedValue?.({ readOnlyMode: false });

    const result = await buildUserInventory(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueUserSnapshotBuild).toHaveBeenCalledWith("test-install");
  });

  test("refuses while a live build is running", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isUserBuildStale.mockReturnValue(false);

    const result = await buildUserInventory(ctx);

    expect(result).toMatchObject({ queued: false, reason: "already-building" });
    expect(mocks.queueUserSnapshotBuild).not.toHaveBeenCalled();
  });
});
