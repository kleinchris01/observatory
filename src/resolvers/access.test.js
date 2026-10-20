import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks } from "./test-harness.js";
import { __RAW_ADMIN_ONLY_FUNCTIONS } from "../resolvers.js";

const { getAccessInventory, buildAccessInventory, probeGlobalPermissions } = __RAW_ADMIN_ONLY_FUNCTIONS;

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

describe("getAccessInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("reports never-built when no snapshot exists", async () => {
    mocks.readAccessSnapshotMeta.mockResolvedValue(null);
    const result = await getAccessInventory(ctx);
    expect(result).toMatchObject({ neverBuilt: true, permissions: null, security: null, notifications: null });
    expect(mocks.loadSchemes).not.toHaveBeenCalled();
  });

  test("returns the three scheme families with a project count and a governance summary each", async () => {
    mocks.readAccessSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "v1",
      refreshedAt: "2026-09-01T00:00:00Z",
    });
    mocks.readUserSnapshotMeta.mockResolvedValue({ version: "u1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "acc-1" }]);
    mocks.loadSchemes.mockImplementation(async (_k, _v, type) => {
      if (type === "permission")
        return [
          { id: "1", name: "Prod", isDefault: false },
          { id: "3", name: "Legacy", isDefault: false },
        ];
      if (type === "security") return [{ id: "s1", name: "Restricted", defaultLevelId: "L1" }];
      if (type === "notification") return [{ id: "n1", name: "Prod notif", isDefault: false }];
      if (type === "project-role") return [{ id: "10002", name: "Administrators" }];
      return [];
    });
    mocks.loadSchemeHolders.mockImplementation(async (_k, _v, type) => {
      if (type === "permission")
        return [{ schemeId: "3", context: "BROWSE_PROJECTS", holderType: "anyone", holderValue: "" }];
      if (type === "notification")
        return [{ schemeId: "n1", context: "1", holderType: "user", holderValue: "acc-gone" }];
      if (type === "project-role")
        return [
          { schemeId: "10002", context: "1", contextLabel: "OPS", holderType: "group", holderValue: "g-admins" },
          { schemeId: "10002", context: "2", contextLabel: "DEV", holderType: "empty", holderValue: "" },
        ];
      return [];
    });
    mocks.loadSchemeProjects.mockImplementation(async (_k, _v, type) =>
      type === "permission" ? [{ schemeId: "1", projectId: "10" }] : [],
    );
    mocks.loadSchemeLevels.mockResolvedValue([{ schemeId: "s1", id: "L1", name: "Internal" }]);

    const result = await getAccessInventory(ctx);

    expect(result.neverBuilt).toBe(false);
    expect(result.permissions.schemes.find((s) => s.id === "1").projectCount).toBe(1);
    expect(result.permissions.governance).toMatchObject({ available: true, riskySchemeCount: 1, unusedSchemeCount: 1 });
    expect(result.security.governance).toMatchObject({ available: true, noLevelSchemeCount: 0 });
    expect(result.notifications.governance).toMatchObject({ fragileSchemeCount: 1 });
    // Project roles folded in: OPS has a group in Administrators, DEV does not.
    expect(result.roles.schemes.find((s) => s.id === "10002").projectCount).toBe(1);
    expect(result.roles.governance).toMatchObject({ available: true, projectsMissingAdminActorCount: 1 });
  });
});

describe("probeGlobalPermissions", () => {
  test("reports the catalog is readable but grant enumeration is not available", async () => {
    mocks.probeEndpoint.mockResolvedValue({ path: "x", ok: true, status: 200, sample: "{}" });
    mocks.getPermissionCatalog.mockResolvedValue({
      ADMINISTER: { key: "ADMINISTER", type: "GLOBAL" },
      BROWSE_PROJECTS: { key: "BROWSE_PROJECTS", type: "PROJECT" },
    });

    const result = await probeGlobalPermissions();

    expect(result.catalogAvailable).toBe(true);
    expect(result.grantEnumerationAvailable).toBe(false);
    expect(result.globalPermissionKeys).toEqual(["ADMINISTER"]);
    expect(result.rows.length).toBeGreaterThan(0);
  });
});

describe("buildAccessInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("queues a build when nothing is running", async () => {
    mocks.readAccessSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.readAdminConfig?.mockResolvedValue?.({ readOnlyMode: false });

    const result = await buildAccessInventory(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueAccessSnapshotBuild).toHaveBeenCalledWith("test-install");
  });

  test("refuses while a live build is running", async () => {
    mocks.readAccessSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isAccessBuildStale.mockReturnValue(false);

    const result = await buildAccessInventory(ctx);

    expect(result).toMatchObject({ queued: false, reason: "already-building" });
    expect(mocks.queueAccessSnapshotBuild).not.toHaveBeenCalled();
  });
});
