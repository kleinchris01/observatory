import { describe, test, expect } from "vitest";
import { shapeDashboard, shapeGadget, isDashboardBuildStale, DASHBOARD_BUILD_STALE_MS } from "./dashboard-engine.js";

// The shapes this has to survive are things a real tenant produces: a deleted owner, a view
// URL under either of two key names, permissions absent entirely.

const raw = (over = {}) => ({
  id: 10100,
  name: "Delivery overview",
  description: "What shipped this sprint",
  owner: { accountId: "a1", displayName: "Bob", active: true },
  sharePermissions: [{ type: "project", project: { id: "1", name: "ADVEV" } }],
  editPermissions: [],
  popularity: 7,
  view: "https://example.atlassian.net/jira/dashboards/10100",
  ...over,
});

describe("shapeDashboard", () => {
  test("flattens a dashboard into its row and its shares", () => {
    const shaped = shapeDashboard(raw());

    expect(shaped.dashboard).toMatchObject({
      id: "10100", name: "Delivery overview", ownerAccountId: "a1", ownerActive: true,
      popularity: 7, sharedWithEveryone: false, editableByEveryone: false, shareCount: 1,
    });
    expect(shaped.shares).toHaveLength(1);
    expect(shaped.shares[0]).toMatchObject({ kind: "view", type: "project", targetName: "ADVEV" });
  });

  // The gadget walk fills this in. A dashboard the walk never reaches keeps null, and the
  // analysis reads that as unmeasured rather than as empty.
  test("starts with an unknown gadget count rather than zero", () => {
    expect(shapeDashboard(raw()).dashboard.gadgetCount).toBeNull();
  });

  test("keeps owner state tri-valued", () => {
    expect(shapeDashboard(raw()).dashboard.ownerActive).toBe(true);
    expect(shapeDashboard(raw({ owner: { accountId: "a", displayName: "B", active: false } })).dashboard.ownerActive).toBe(false);
    // Jira omits `owner` entirely once the account is deleted, which is the case that takes
    // the dashboard with it.
    expect(shapeDashboard(raw({ owner: null })).dashboard.ownerActive).toBeNull();
  });

  test("separates view permissions from edit permissions", () => {
    const shaped = shapeDashboard(raw({
      sharePermissions: [{ type: "global" }],
      editPermissions: [{ type: "group", group: { groupId: "g1", name: "admins" } }],
    }));

    expect(shaped.dashboard.sharedWithEveryone).toBe(true);
    expect(shaped.dashboard.editableByEveryone).toBe(false);
    expect(shaped.shares.map((s) => s.kind)).toEqual(["view", "edit"]);
  });

  test("flags a dashboard anyone can rewrite", () => {
    const shaped = shapeDashboard(raw({ editPermissions: [{ type: "global" }] }));
    expect(shaped.dashboard.editableByEveryone).toBe(true);
  });

  test("reads the view URL under either key Jira uses", () => {
    expect(shapeDashboard(raw()).dashboard.viewUrl).toContain("/dashboards/10100");
    expect(shapeDashboard(raw({ view: undefined, viewUrl: "https://x/y" })).dashboard.viewUrl).toBe("https://x/y");
  });

  test("falls back to favouritedCount when popularity is absent", () => {
    expect(shapeDashboard(raw({ popularity: undefined, favouritedCount: 4 })).dashboard.popularity).toBe(4);
  });

  test("rejects a dashboard with no id rather than storing a blank key", () => {
    // One malformed entry must not cost the rest.
    expect(shapeDashboard({ name: "No id" })).toBeNull();
    expect(shapeDashboard(null)).toBeNull();
  });

  test("survives a dashboard with no permissions at all", () => {
    const shaped = shapeDashboard(raw({ sharePermissions: undefined, editPermissions: undefined }));
    expect(shaped.dashboard.shareCount).toBe(0);
    expect(shaped.shares).toEqual([]);
  });
});

describe("shapeGadget", () => {
  test("keeps the handle a later pass will join on", () => {
    // Gadget CONFIGURATION -- which filter it reads -- needs per-gadget properties. The
    // module key is stored so that join can be added without a re-enumeration.
    const gadget = shapeGadget("10100", { id: 1, title: "Filter Results", moduleKey: "com.atlassian:filter-results", position: { row: 0, column: 1 } });
    expect(gadget).toMatchObject({
      dashboardId: "10100", id: "1", title: "Filter Results",
      moduleKey: "com.atlassian:filter-results", row: 0, column: 1,
    });
  });

  test("falls back to the uri when there is no module key", () => {
    expect(shapeGadget("1", { id: 2, uri: "rest/gadget/1.0/x" }).moduleKey).toBe("rest/gadget/1.0/x");
  });

  test("rejects a gadget with no id", () => {
    expect(shapeGadget("1", { title: "Nameless" })).toBeNull();
  });
});

describe("isDashboardBuildStale", () => {
  // A Forge invocation timeout is a hard kill: state is marked "building" before the first
  // API call and the catch that would mark it failed never runs.
  const now = Date.parse("2026-08-21T12:00:00Z");

  test("is not stale while a build could still be running", () => {
    expect(isDashboardBuildStale({ state: "building", startedAt: new Date(now - 60_000).toISOString() }, now)).toBe(false);
  });

  test("is stale once no invocation could still be alive", () => {
    expect(isDashboardBuildStale({ state: "building", startedAt: new Date(now - DASHBOARD_BUILD_STALE_MS - 1000).toISOString() }, now)).toBe(true);
  });

  test("treats a building row with no start time as stale", () => {
    expect(isDashboardBuildStale({ state: "building" }, now)).toBe(true);
  });

  test("says nothing about a row that is not building", () => {
    expect(isDashboardBuildStale({ state: "ready" }, now)).toBe(false);
    expect(isDashboardBuildStale(null, now)).toBe(false);
  });
});
