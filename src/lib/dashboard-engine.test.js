import { describe, test, expect, vi, beforeEach } from "vitest";
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

// runChunk phase progression: the fix here is the totalExpected the later phases report.
// Before it, gadget-walk and config-walk work was summed onto the phase-one count while the
// denominator stayed at the dashboard total, so a real build showed "3,836 of 613 (100%)".
vi.mock("./jira-api.js", () => ({
  incrMetric: vi.fn(),
  METRIC_NAMES: { jiraRequest: "jiraRequest" },
  getDashboardPage: vi.fn(),
  getDashboardGadgets: vi.fn(async () => []),
  getGadgetFilterId: vi.fn(async () => null),
  mapWithConcurrency: async (items, _n, fn) => Promise.all(items.map(fn)),
}));
vi.mock("./logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./queues.js", () => ({ inventorySnapshotQueue: { push: vi.fn() } }));
vi.mock("./project-store.js", () => ({
  ensureProjectStoreReady: vi.fn(),
  readDashboardSnapshotMeta: vi.fn(),
  writeDashboardSnapshotMeta: vi.fn(),
  clearDashboardSnapshotVersion: vi.fn(),
  appendDashboardSnapshot: vi.fn(),
  loadDashboardIdsNeedingGadgets: vi.fn(),
  loadGadgetsNeedingConfig: vi.fn(),
  recordGadgetConfigs: vi.fn(),
  countGadgetConfigCoverage: vi.fn(),
  pruneDashboardSnapshots: vi.fn(),
}));

describe("dashboardBuildSpec.runChunk — phase-aware progress", () => {
  let jira, store, spec;
  beforeEach(async () => {
    vi.clearAllMocks();
    jira = await import("./jira-api.js");
    store = await import("./project-store.js");
    ({ dashboardBuildSpec: spec } = await import("./dashboard-engine.js"));
  });

  test("the list phase reports the dashboard total and hands listTotal forward", async () => {
    jira.getDashboardPage.mockResolvedValue({ values: [], total: 613, isLast: true });
    const r = await spec.runChunk({ installationKey: "i", version: "v", cursor: { phase: "list" } });
    expect(r.totalExpected).toBe(613);
    expect(r.cursor).toEqual({ phase: "gadgets", listTotal: 613, skippedPages: 0 });
  });

  test("the gadget phase doubles the denominator — one walk per dashboard on top of listing", async () => {
    store.loadDashboardIdsNeedingGadgets.mockResolvedValue(["1", "2"]);
    jira.getDashboardGadgets.mockResolvedValue([]);
    const r = await spec.runChunk({ installationKey: "i", version: "v", cursor: { phase: "gadgets", listTotal: 613, walked: 0 } });
    expect(r.totalExpected).toBe(1226);
    expect(r.cursor).toMatchObject({ phase: "gadgets", listTotal: 613 });
  });

  test("entering the config phase adds the real gadget count to the denominator", async () => {
    store.loadDashboardIdsNeedingGadgets.mockResolvedValue([]);
    store.countGadgetConfigCoverage.mockResolvedValue({ total: 4000, walked: 0 });
    const r = await spec.runChunk({ installationKey: "i", version: "v", cursor: { phase: "gadgets", listTotal: 613 } });
    expect(r.totalExpected).toBe(613 * 2 + 4000);
    expect(r.cursor).toEqual({ phase: "configs", walked: 0, listTotal: 613, gadgetTotal: 4000, skippedPages: 0 });
  });

  test("the config phase keeps the cumulative denominator steady across its chunks", async () => {
    store.loadGadgetsNeedingConfig.mockResolvedValue([{ dashboardId: "1", gadgetId: "g1" }]);
    store.recordGadgetConfigs.mockResolvedValue({ recorded: 1 });
    const r = await spec.runChunk({ installationKey: "i", version: "v", cursor: { phase: "configs", walked: 0, listTotal: 613, gadgetTotal: 4000 } });
    expect(r.totalExpected).toBe(5226);
    expect(r.done).toBe(false);
  });

  test("a config chunk resumed from a pre-fix cursor leaves the meta's total alone", async () => {
    store.loadGadgetsNeedingConfig.mockResolvedValue([]);
    const r = await spec.runChunk({ installationKey: "i", version: "v", cursor: { phase: "configs", walked: 0 } });
    expect(r.done).toBe(true);
    expect(r.totalExpected).toBeUndefined();
  });

  test("the finished build records how many dashboards it found, so the scan page can show it", async () => {
    store.loadGadgetsNeedingConfig.mockResolvedValue([]);
    const done = await spec.runChunk({ installationKey: "i", version: "v", cursor: { phase: "configs", walked: 7, listTotal: 613, gadgetTotal: 4000 } });
    expect(done.done).toBe(true);
    expect(spec.finalize({ result: done })).toMatchObject({ totalDashboards: 613, gadgetsWalked: 7 });
  });
});

describe("dashboardBuildSpec.runChunk — a failing chunk retries before it fails the build", () => {
  let jira, store, spec;
  beforeEach(async () => {
    vi.clearAllMocks();
    jira = await import("./jira-api.js");
    store = await import("./project-store.js");
    ({ dashboardBuildSpec: spec } = await import("./dashboard-engine.js"));
  });

  const retryable = (status) => Object.assign(new Error(`Jira request failed (${status})`), { status });

  // A TRANSIENT page error (429, 5xx) is worth retrying at the same offset, so it goes back
  // through the chunk-error counter and re-queues the same chunk untouched.
  test("a 503 on the search page re-queues the same chunk instead of throwing", async () => {
    jira.getDashboardPage.mockRejectedValue(retryable(503));

    const r = await spec.runChunk({ installationKey: "i", version: "v", cursor: { phase: "list", startAt: 50, total: 613 } });

    expect(r.done).toBe(false);
    expect(r.cursor).toMatchObject({ phase: "list", startAt: 50, total: 613, chunkErrors: 1 });
  });

  test("keeps carrying the count, then lets the build fail once the transient budget is spent", async () => {
    jira.getDashboardPage.mockRejectedValue(retryable(503));

    const near = await spec.runChunk({ installationKey: "i", version: "v", cursor: { phase: "list", chunkErrors: 2 } });
    expect(near.done).toBe(false);
    expect(near.cursor.chunkErrors).toBe(3);

    await expect(
      spec.runChunk({ installationKey: "i", version: "v", cursor: { phase: "list", chunkErrors: 3 } })
    ).rejects.toThrow(/503/);
  });

  test("a good chunk after a bad one drops the counter", async () => {
    jira.getDashboardPage.mockResolvedValue({ values: [], total: 0, isLast: true });

    const r = await spec.runChunk({ installationKey: "i", version: "v", cursor: { phase: "list", chunkErrors: 2 } });

    expect(r.done).toBe(false);
    expect(r.cursor).not.toHaveProperty("chunkErrors"); // moved to the gadgets phase, clean cursor
  });

  // The bug this fixes: a NON-retryable 400 (dashboard/search 400s permanently past certain
  // offsets) used to burn the chunk-error budget and then fail the whole build -- and the
  // orchestrator would restart the stage from zero and hit the same page again, nine times
  // over. Now that one page is skipped like a malformed entry and the build carries on.
  test("a non-retryable 400 on a page skips it and advances rather than failing the build", async () => {
    jira.getDashboardPage
      .mockRejectedValueOnce(new Error("Jira request failed (400): bad startAt"))
      .mockResolvedValue({ values: [], total: 613, isLast: true });

    const r = await spec.runChunk({ installationKey: "i", version: "v", cursor: { phase: "list", startAt: 100, total: 613 } });

    expect(r.done).toBe(false);
    // No chunkErrors -- this is not a retry. The bad page is stepped over and enumeration
    // continues in the same invocation, reaching isLast and handing off to the gadget phase.
    expect(r.cursor).not.toHaveProperty("chunkErrors");
    expect(r.cursor).toMatchObject({ phase: "gadgets", listTotal: 613, skippedPages: 1 });
  });

  test("skipped-page count rides the cursor through every phase to the scan page", async () => {
    store.loadGadgetsNeedingConfig.mockResolvedValue([]);
    const done = await spec.runChunk({
      installationKey: "i", version: "v",
      cursor: { phase: "configs", walked: 7, listTotal: 613, gadgetTotal: 4000, skippedPages: 3 },
    });
    expect(done.done).toBe(true);
    expect(spec.finalize({ result: done })).toMatchObject({ totalDashboards: 613, pagesUnreadable: 3 });
  });

  test("gives up only once too many pages are individually unreadable", async () => {
    jira.getDashboardPage.mockRejectedValue(new Error("Jira request failed (400): bad startAt"));

    // total unknown (0), so the offset guard never ends the phase -- only the skip ceiling does.
    await expect(
      spec.runChunk({ installationKey: "i", version: "v", cursor: { phase: "list", skippedPages: 20, chunkErrors: 3 } })
    ).rejects.toThrow(/unreadable/);
  });
});
