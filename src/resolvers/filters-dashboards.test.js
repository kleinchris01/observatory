import { describe, test, expect, beforeEach } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, ctxWithAccount } from "./test-harness.js";
import { __RAW_ADMIN_ONLY_FUNCTIONS } from "../resolvers.js";

const {
  getFilterInventory,
  buildFilterInventory,
  getDashboardUsage,
  getFilterUsage,
  getFieldFilterCounts,
  getFieldDashboardCounts,
  getDashboardInventory,
  buildDashboardInventory,
  buildScreenInventory,
} = __RAW_ADMIN_ONLY_FUNCTIONS;

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// A saved filter is the one piece of Jira configuration that fails silently in both
// directions: delete a field forty filters search on and the searches quietly return the
// wrong answer, and leave a filter owned by somebody who left and it keeps emailing a list
// from an account nobody administers.
// The one-click entry point. The orchestrator behind it is tested in full-scan-runner.test.js;
// what matters here is that the resolver refuses when it should and reports enough for the tab
// to render the stage list before a scan has ever run.
// Which dashboards break if a field goes.
//
// Resolved as a chain -- field -> filters naming it -> gadgets showing those filters ->
// dashboards carrying those gadgets -- because every leg is an exact join. The cheap version
// matches gadget titles against filter names, which is right most of the time, and the case it
// gets wrong is somebody's wall-screen going blank on Monday.
describe("getDashboardUsage", () => {
  beforeEach(() => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "d1", state: "ready" });
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1", state: "ready" });
    mocks.loadFilterReferencesFor.mockResolvedValue({ total: 1, filters: [{ id: "500", name: "Open bugs" }] });
    mocks.countGadgetConfigCoverage.mockResolvedValue({ total: 40, walked: 40 });
    mocks.loadDashboardsForFilters.mockResolvedValue([
      {
        filterId: "500",
        dashboardId: "9",
        dashboardName: "Delivery",
        gadgetTitle: "Open bugs",
        ownerName: "Bob",
        popularity: 12,
        viewUrl: null,
      },
    ]);
  });

  test("walks field to filter to gadget to dashboard", async () => {
    const result = await getDashboardUsage({ payload: { label: "Story Points" }, context: ctxWithAccount() });

    expect(mocks.loadFilterReferencesFor).toHaveBeenCalledWith("test-install", "f1", "field", "Story Points");
    expect(mocks.loadDashboardsForFilters).toHaveBeenCalledWith("test-install", "d1", ["500"]);
    expect(result).toMatchObject({ available: true, total: 1, viaFilters: 1, complete: true });
    // WHERE on the dashboard, not just which dashboard.
    expect(result.dashboards[0].via[0]).toMatchObject({ gadgetTitle: "Open bugs", filterName: "Open bugs" });
  });

  test("counts a dashboard once even when several gadgets reach it", async () => {
    mocks.loadDashboardsForFilters.mockResolvedValue([
      { filterId: "500", dashboardId: "9", dashboardName: "Delivery", gadgetTitle: "Open bugs", popularity: 3 },
      { filterId: "500", dashboardId: "9", dashboardName: "Delivery", gadgetTitle: "Bug trend", popularity: 3 },
    ]);

    const result = await getDashboardUsage({ payload: { label: "Story Points" }, context: ctxWithAccount() });

    // Two gadgets on one dashboard is one dashboard at risk, not two findings.
    expect(result.total).toBe(1);
    expect(result.dashboards[0].via).toHaveLength(2);
  });

  // Which half is missing changes what an admin has to do, so they are reported apart rather
  // than collapsed into one "unavailable".
  test("says which inventory is missing, not just that one is", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue(null);
    expect(await getDashboardUsage({ payload: { label: "X" }, context: ctxWithAccount() })).toMatchObject({
      available: false,
      reason: "no-dashboard-inventory",
    });

    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "d1" });
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    expect(await getDashboardUsage({ payload: { label: "X" }, context: ctxWithAccount() })).toMatchObject({
      available: false,
      reason: "no-filter-inventory",
    });
  });

  test("marks the answer incomplete when the gadget config walk has not finished", async () => {
    mocks.countGadgetConfigCoverage.mockResolvedValue({ total: 40, walked: 12 });
    mocks.loadFilterReferencesFor.mockResolvedValue({ total: 0, filters: [] });

    const result = await getDashboardUsage({ payload: { label: "Story Points" }, context: ctxWithAccount() });

    // Zero dashboards from a partial walk is not "no dashboard uses this field" -- and that
    // sentence is what somebody deletes a field on.
    expect(result).toMatchObject({ total: 0, complete: false });
    expect(result.coverage).toMatchObject({ total: 40, walked: 12 });
  });

  test("does not query dashboards when no filter names the field", async () => {
    mocks.loadFilterReferencesFor.mockResolvedValue({ total: 0, filters: [] });

    const result = await getDashboardUsage({ payload: { label: "Unused" }, context: ctxWithAccount() });

    expect(result).toMatchObject({ available: true, total: 0, complete: true });
    expect(mocks.loadDashboardsForFilters).not.toHaveBeenCalled();
  });
});

describe("getFilterInventory", () => {
  const filterRow = (over = {}) => ({
    id: "1",
    name: "Open bugs",
    jql: "project = ADVEV AND status = Open",
    owner: { accountId: "a1", displayName: "Bob", active: true },
    ownerName: "Bob",
    ownerActive: true,
    shares: [],
    sharedWithEveryone: false,
    shareCount: 0,
    subscriptionCount: 0,
    lastUsedAt: new Date().toISOString(),
    fieldRefs: ["project", "status"],
    projectRefs: ["ADVEV"],
    statusRefs: ["Open"],
    ...over,
  });

  beforeEach(() => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({
      version: "v1",
      state: "ready",
      refreshedAt: "2026-08-20T00:00:00Z",
    });
    mocks.loadFilters.mockResolvedValue([
      filterRow(),
      filterRow({ id: "2", name: "Orphan", owner: null, ownerActive: null }),
    ]);
    mocks.readSnapshotMeta.mockResolvedValue({ version: "fv1" });
    mocks.listSnapshotProjects.mockResolvedValue([{ projectId: "1", projectKey: "ADVEV", projectName: "ADVEV" }]);
  });

  test("derives the findings at read time rather than storing them", async () => {
    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });

    expect(result.available).toBe(true);
    expect(result.total).toBe(2);
    expect(result.orphanedCount).toBe(1);
    // Paged now, not the whole inventory. 4,115 filters on a real site overflowed Forge's
    // response payload limit when the entire analyzed list was sent in one call.
    expect(result.filters).toHaveLength(2);
    expect(result.matchedTotal).toBe(2);
    expect(result.page).toBe(1);
    expect(result.totalPages).toBe(1);
  });

  test("attaches findings to every row, not only the ones the summary flagged", async () => {
    // Two clean filters plus the one the fixture already flags -- every row in the RESPONSE
    // must carry a findings array, or the rail's finding filter has nothing to match against
    // for the clean ones.
    mocks.loadFilters.mockResolvedValue([filterRow({ id: "1" }), filterRow({ id: "3", name: "Also clean" })]);

    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });
    expect(result.filters.every((f) => Array.isArray(f.findings))).toBe(true);
    expect(result.filters.find((f) => f.id === "1").findings).toEqual([]);
  });

  test("does not ship the whole inventory under a second name", async () => {
    // The old response carried BOTH `allFilters` (every filter, full row) and, via
    // `...summary`, `filters` (summarizeFilters' own unbounded worst-first list for the
    // Overview's top-8 panel) -- every flagged filter's full row sent twice, under two
    // different keys, which is what helped overflow the payload at 4,115 filters.
    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });
    expect(result).not.toHaveProperty("allFilters");
  });

  // A build hard-killed at the invocation ceiling leaves the row saying "building" with no
  // error, forever. The tab gates its rebuild control on this flag, so a resolver that
  // withholds it is a tab that can never recover -- which is exactly what happened on a live
  // site. Both paths carry it: the wedge is just as reachable on a rebuild over an existing
  // snapshot as on a first build, and only the first path ever reported it.
  test("reports a wedged first build so the UI can offer a rebuild", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({
      version: null,
      state: "building",
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });
    expect(result.available).toBe(false);
    expect(result.staleBuild).toBe(true);
  });

  test("reports a wedged rebuild over a snapshot that already exists", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({
      version: "v1",
      state: "building",
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });
    expect(result.available).toBe(true);
    expect(result.staleBuild).toBe(true);
  });

  // The other half of the tri-state: a build that started a minute ago is still running, and
  // saying otherwise would hand a user a rebuild button that races the job already in flight.
  test("does not call a build that just started stale", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({
      version: "v1",
      state: "building",
      startedAt: new Date().toISOString(),
    });

    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });
    expect(result.staleBuild).toBe(false);
  });

  test("joins to the project catalog so a broken scope can be found", async () => {
    mocks.loadFilters.mockResolvedValue([filterRow({ projectRefs: ["GHOST"] })]);
    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });

    expect(result.projectsChecked).toBe(true);
    expect(result.brokenProjectCount).toBe(1);
  });

  // The bug this pins: JQL accepts `project = "Display Name"` exactly as readily as
  // `project = KEY`, but the known-projects set only ever carried keys -- so a filter scoped
  // by name, to a project that genuinely exists, was reported broken. Real symptom: the same
  // two project names recurring as "MISSING" across a dozen otherwise-unrelated filters.
  test("does not flag a project referenced by its display name rather than its key", async () => {
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "1", projectKey: "ADVEV", projectName: "ADVEV Software Tools" },
    ]);
    mocks.loadFilters.mockResolvedValue([
      filterRow({ jql: 'project = "ADVEV Software Tools"', projectRefs: ["ADVEV Software Tools"] }),
    ]);

    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });

    expect(result.projectsChecked).toBe(true);
    expect(result.brokenProjectCount).toBe(0);
  });

  // "No broken references" and "nobody looked" are different claims, and only one of them is
  // permission to act.
  test("says the project check could not run rather than reporting it clean", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });

    expect(result.projectsChecked).toBe(false);
    expect(result.brokenProjectCount).toBe(0);
  });

  test("reports never-built rather than empty", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });

    expect(result).toMatchObject({ available: false, neverBuilt: true });
  });

  test("carries the failure reason forward when the last build failed", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({
      version: null,
      state: "failed",
      lastError: "401 scope does not match",
    });
    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });

    expect(result.lastError).toMatch(/401/);
  });
});

// The reason any of this exists: 4,115 filters on a real site overflowed Forge's response
// payload limit when the whole inventory was sent in one call. Search, sort, the finding
// filter and pagination all moved server-side as a result -- this is what has to hold for
// that to actually bound the response regardless of estate size.
describe("getFilterInventory paging", () => {
  const filterRow = (over = {}) => ({
    id: "1",
    name: "Open bugs",
    jql: "project = ADVEV AND status = Open",
    owner: { accountId: "a1", displayName: "Bob", active: true },
    ownerName: "Bob",
    ownerActive: true,
    shares: [],
    sharedWithEveryone: false,
    shareCount: 0,
    subscriptionCount: 0,
    lastUsedAt: new Date().toISOString(),
    fieldRefs: ["project", "status"],
    projectRefs: ["ADVEV"],
    statusRefs: ["Open"],
    ...over,
  });

  beforeEach(() => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.readSnapshotMeta.mockResolvedValue(null);
    // A page's worth of distinct, findable rows.
    mocks.loadFilters.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) =>
        filterRow({
          id: String(i + 1),
          name: i === 0 ? "Special one" : `Filter ${i + 1}`,
          owner: i === 5 ? null : { accountId: "a1", displayName: "Bob", active: true },
          ownerName: i === 5 ? null : "Bob",
          ownerActive: i === 5 ? null : true,
        }),
      ),
    );
  });

  test("never returns more rows than pageSize, however large the inventory is", async () => {
    const result = await getFilterInventory({ payload: { pageSize: 10 }, context: ctxWithAccount() });

    expect(result.filters).toHaveLength(10);
    expect(result.matchedTotal).toBe(30);
    expect(result.totalPages).toBe(3);
  });

  test("defaults to a bounded page size when none is given", async () => {
    const result = await getFilterInventory({ payload: {}, context: ctxWithAccount() });
    expect(result.filters.length).toBeLessThanOrEqual(25);
  });

  // Matches getFieldInventory's own convention: this resolver is called only by Observatory's
  // own frontend, so an out-of-range pageSize is a bug in that caller, not untrusted input to
  // defend against silently. Throwing loudly surfaces the bug where it was introduced instead
  // of masking it behind a clamp that quietly does something the caller never asked for.
  test("rejects a pageSize outside the allowed range rather than silently clamping it", async () => {
    await expect(getFilterInventory({ payload: { pageSize: 100000 }, context: ctxWithAccount() })).rejects.toThrow(
      /pageSize/,
    );
  });

  test("searches name and jql server-side", async () => {
    const result = await getFilterInventory({ payload: { search: "Special" }, context: ctxWithAccount() });
    expect(result.filters).toHaveLength(1);
    expect(result.filters[0].name).toBe("Special one");
    expect(result.matchedTotal).toBe(1);
  });

  test("narrows to a finding server-side", async () => {
    const result = await getFilterInventory({ payload: { finding: "orphaned-owner" }, context: ctxWithAccount() });
    // Only row index 5 (owner: null) has the orphaned-owner finding.
    expect(result.matchedTotal).toBe(1);
    expect(result.filters).toHaveLength(1);
  });

  test("sorts server-side and returns pages in that order", async () => {
    const first = await getFilterInventory({ payload: { sort: "name", pageSize: 5 }, context: ctxWithAccount() });
    const names = first.filters.map((f) => f.name);
    expect(names).toEqual([...names].sort());
  });

  test("falls back to the default sort for an unrecognised value, rather than erroring", async () => {
    const result = await getFilterInventory({
      payload: { sort: "definitely-not-a-real-sort" },
      context: ctxWithAccount(),
    });
    expect(result.available).toBe(true);
  });

  // The rail describes the WHOLE matched set, not the current page -- a page can hold zero
  // of a kind that exists dozens of times in the estate.
  test("finding-rail counts describe the whole inventory, not the current page", async () => {
    const result = await getFilterInventory({
      payload: { finding: "orphaned-owner", pageSize: 1 },
      context: ctxWithAccount(),
    });
    // The page holds exactly the one orphaned filter, but "all" must still count all 30.
    expect(result.findingCounts.all).toBe(30);
    expect(result.findingCounts["orphaned-owner"]).toBe(1);
  });

  test("page beyond the last available clamps rather than returning nothing silently unexplained", async () => {
    const result = await getFilterInventory({ payload: { page: 999, pageSize: 10 }, context: ctxWithAccount() });
    expect(result.page).toBe(result.totalPages);
    expect(result.filters.length).toBeGreaterThan(0);
  });

  test("matchedTotal is independent of the whole-inventory total", async () => {
    const result = await getFilterInventory({ payload: { search: "Special" }, context: ctxWithAccount() });
    // 1 filter matches the search, but the inventory holds 30 -- the headline stat and the
    // search result count must not collapse into the same number.
    expect(result.matchedTotal).toBe(1);
    expect(result.total).toBe(30);
  });
});

describe("buildFilterInventory", () => {
  test("queues a build and marks the row building", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    mocks.kvsGet.mockResolvedValue(null);

    const result = await buildFilterInventory({ context: ctxWithAccount() });

    expect(result).toMatchObject({ queued: true });
    // The `body` envelope, asserted rather than assumed. The consumer reads
    // event?.body?.jobType, so a payload pushed without it arrives bodyless and Forge
    // rejects the invocation with "Event body must be an object" -- which is exactly what
    // shipped, because the original test only checked that SOMETHING was pushed.
    expect(mocks.queuePush).toHaveBeenCalledWith({
      body: {
        jobType: "build-filter-snapshot",
        installationKey: "test-install",
        // The token that lets a resumable build tell its own continuation apart from a second
        // person clicking Rebuild. Without it, any check strict enough to refuse the second
        // would also refuse the build resuming itself.
        buildToken: expect.any(String),
      },
    });
    // Started as a resumable build: an in-flight version distinct from the published one, a
    // zeroed cursor, and a heartbeat. A row marked "building" with no version to write into
    // cannot be resumed by anything.
    expect(mocks.writeFilterSnapshotMeta).toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({
        state: "building",
        buildingVersion: expect.any(String),
        buildToken: expect.any(String),
        buildCursor: null,
        processed: 0,
      }),
    );
  });

  test("refuses in read-only mode, and says so", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true });

    const result = await buildFilterInventory({ context: ctxWithAccount() });
    expect(result.queued).toBe(false);
    expect(result.error).toMatch(/Read-only/);
  });

  test("does not queue a second build over one still running", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ state: "building", startedAt: new Date().toISOString() });
    const result = await buildFilterInventory({ context: ctxWithAccount() });
    expect(result).toMatchObject({ queued: false, reason: "already-building" });
  });

  // A Forge invocation timeout is a hard kill, so a wedged row would otherwise suppress every
  // future rebuild with no way out of the UI.
  test("queues over a build that can no longer be running", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({
      state: "building",
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    mocks.kvsGet.mockResolvedValue(null);

    expect(await buildFilterInventory({ context: ctxWithAccount() })).toMatchObject({ queued: true });
  });
});

describe("getFilterUsage", () => {
  test("returns the filters that would break if a field went away", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "v1" });
    mocks.loadFilterReferencesFor.mockResolvedValue({
      total: 2,
      filters: [
        { id: "1", name: "Open bugs", ownerName: "Bob", ownerActive: true, subscriptionCount: 0, lastUsedAt: null },
      ],
    });

    const result = await getFilterUsage({
      payload: { kind: "field", label: "Story Points" },
      context: ctxWithAccount(),
    });
    expect(result).toMatchObject({ available: true, kind: "field", total: 2 });
  });

  // Saying "no filter uses this" with nothing behind it is the false reassurance this whole
  // pillar exists to stop.
  test("distinguishes no inventory from no references", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    const result = await getFilterUsage({ payload: { label: "Story Points" }, context: ctxWithAccount() });
    expect(result).toMatchObject({ available: false, reason: "no-inventory" });
  });

  test("defaults an unrecognised kind to field rather than passing it through", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "v1" });
    await getFilterUsage({ payload: { kind: "'; DROP TABLE", label: "X" }, context: ctxWithAccount() });
    expect(mocks.loadFilterReferencesFor).toHaveBeenCalledWith("test-install", "v1", "field", "X");
  });

  test("requires a label", async () => {
    await expect(getFilterUsage({ payload: {}, context: ctxWithAccount() })).rejects.toThrow(/label is required/);
  });
});

// The cross-pillar half. The Field Browser already says which automation rules write a field;
// this says which saved searches would silently start returning the wrong answer without it.
describe("getFieldFilterCounts", () => {
  test("looks a field up by name AND by id, because JQL uses both", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "v1", refreshedAt: "2026-08-21T00:00:00Z" });
    mocks.loadFilterReferenceCounts.mockResolvedValue({ "story points": 12 });

    const result = await getFieldFilterCounts({
      payload: { fields: [{ id: "customfield_10001", name: "Story Points" }] },
      context: ctxWithAccount(),
    });

    const labels = mocks.loadFilterReferenceCounts.mock.calls[0][3];
    expect(labels).toEqual(expect.arrayContaining(["Story Points", "customfield_10001"]));
    expect(result.counts).toEqual({ customfield_10001: 12 });
  });

  test("does not double-count a field named both ways", async () => {
    // Summing would count one filter twice when it references the field by name in a clause
    // and by cf[...] in an ORDER BY.
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "v1" });
    mocks.loadFilterReferenceCounts.mockResolvedValue({ "story points": 12, customfield_10001: 9 });

    const result = await getFieldFilterCounts({
      payload: { fields: [{ id: "customfield_10001", name: "Story Points" }] },
      context: ctxWithAccount(),
    });

    expect(result.counts.customfield_10001).toBe(12);
  });

  // Zero here reads as "safe to delete" and would be the opposite of what an unbuilt pillar
  // knows. The chip renders unknown instead.
  test("reports unavailable rather than zero when nothing has been built", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);

    const result = await getFieldFilterCounts({
      payload: { fields: [{ id: "f", name: "F" }] },
      context: ctxWithAccount(),
    });

    expect(result).toMatchObject({ available: false, counts: {} });
    expect(mocks.loadFilterReferenceCounts).not.toHaveBeenCalled();
  });

  test("bounds how many fields one call can ask about", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "v1" });
    const fields = Array.from({ length: 900 }, (_, i) => ({ id: `f${i}`, name: `F${i}` }));

    await getFieldFilterCounts({ payload: { fields }, context: ctxWithAccount() });

    // 500 fields, each contributing a name and an id.
    expect(mocks.loadFilterReferenceCounts.mock.calls[0][3]).toHaveLength(1000);
  });

  test("survives a payload with no fields", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "v1" });
    const result = await getFieldFilterCounts({ payload: {}, context: ctxWithAccount() });
    expect(result.counts).toEqual({});
  });
});

// The bulk sibling of getDashboardUsage: a plain count per field for a whole page at once,
// via the same field -> filter ids -> gadgets chain, without describing any one field's
// dashboards in full the way the expanded card section needs to.
describe("getFieldDashboardCounts", () => {
  beforeEach(() => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "fv1" });
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "dv1" });
  });

  test("looks a field up by name AND by id, because JQL uses both", async () => {
    mocks.loadFilterIdsForLabels.mockResolvedValue(new Map([["story points", ["500"]]]));
    mocks.loadGadgetCountsForFilterIds.mockResolvedValue(new Map([["500", 3]]));

    const result = await getFieldDashboardCounts({
      payload: { fields: [{ id: "customfield_10001", name: "Story Points" }] },
      context: ctxWithAccount(),
    });

    const labels = mocks.loadFilterIdsForLabels.mock.calls[0][3];
    expect(labels).toEqual(expect.arrayContaining(["Story Points", "customfield_10001"]));
    expect(result.counts).toEqual({ customfield_10001: 3 });
  });

  // A gadget belongs to exactly one filter, so a field reached by several filters gets the
  // SUM of their gadget counts -- but a filter found under both the field's name and its id
  // must contribute only once, or its gadgets are counted twice.
  test("unions filter ids across name and id, rather than summing the same filter twice", async () => {
    mocks.loadFilterIdsForLabels.mockResolvedValue(
      new Map([
        ["story points", ["500"]],
        ["customfield_10001", ["500"]],
      ]),
    );
    mocks.loadGadgetCountsForFilterIds.mockResolvedValue(new Map([["500", 4]]));

    const result = await getFieldDashboardCounts({
      payload: { fields: [{ id: "customfield_10001", name: "Story Points" }] },
      context: ctxWithAccount(),
    });

    expect(result.counts.customfield_10001).toBe(4);
    // The gadget-count lookup must only ever be asked about filter 500 once.
    expect(mocks.loadGadgetCountsForFilterIds.mock.calls[0][2]).toEqual(["500"]);
  });

  test("sums gadgets across several DIFFERENT filters that name the same field", async () => {
    mocks.loadFilterIdsForLabels.mockResolvedValue(new Map([["story points", ["500", "501"]]]));
    mocks.loadGadgetCountsForFilterIds.mockResolvedValue(
      new Map([
        ["500", 2],
        ["501", 5],
      ]),
    );

    const result = await getFieldDashboardCounts({
      payload: { fields: [{ id: "customfield_10001", name: "Story Points" }] },
      context: ctxWithAccount(),
    });

    expect(result.counts.customfield_10001).toBe(7);
  });

  // Which half is missing changes what an admin builds next, so the two are reported apart.
  test("says which inventory is missing, not just that one is", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    let result = await getFieldDashboardCounts({
      payload: { fields: [{ id: "f", name: "F" }] },
      context: ctxWithAccount(),
    });
    expect(result).toMatchObject({ available: false, reason: expect.stringContaining("filter") });

    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "fv1" });
    mocks.readDashboardSnapshotMeta.mockResolvedValue(null);
    result = await getFieldDashboardCounts({
      payload: { fields: [{ id: "f", name: "F" }] },
      context: ctxWithAccount(),
    });
    expect(result).toMatchObject({ available: false, reason: expect.stringContaining("dashboard") });
  });

  test("reports zero for a field no filter names, rather than omitting it", async () => {
    mocks.loadFilterIdsForLabels.mockResolvedValue(new Map());

    const result = await getFieldDashboardCounts({
      payload: { fields: [{ id: "customfield_99999", name: "Untouched" }] },
      context: ctxWithAccount(),
    });

    // No filter references it, so the gadget lookup never runs at all -- there is nothing
    // to look up.
    expect(mocks.loadGadgetCountsForFilterIds).not.toHaveBeenCalled();
    expect(result.available).toBe(true);
  });

  test("bounds how many fields one call can ask about", async () => {
    const fields = Array.from({ length: 900 }, (_, i) => ({ id: `f${i}`, name: `F${i}` }));
    await getFieldDashboardCounts({ payload: { fields }, context: ctxWithAccount() });
    expect(mocks.loadFilterIdsForLabels.mock.calls[0][3]).toHaveLength(1000);
  });
});

// A dashboard is the most visible thing in Jira and the least owned.
describe("getDashboardInventory", () => {
  const row = (over = {}) => ({
    id: "1",
    name: "Delivery overview",
    owner: { accountId: "a1", displayName: "Bob", active: true },
    ownerName: "Bob",
    ownerActive: true,
    shares: [],
    editShares: [],
    sharedWithEveryone: false,
    editableByEveryone: false,
    popularity: 4,
    gadgetCount: 6,
    gadgets: [],
    shareCount: 0,
    ...over,
  });

  test("derives the findings at read time", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready", gadgetsWalked: 2 });
    mocks.loadDashboards.mockResolvedValue([row(), row({ id: "2", name: "Orphan", owner: null, ownerActive: null })]);

    const result = await getDashboardInventory({ context: ctxWithAccount() });

    expect(result).toMatchObject({ available: true, total: 2, orphanedCount: 1 });
    // The whole list travels, because the tab filters over it client-side.
    expect(result.allDashboards).toHaveLength(2);
  });

  // Without this the tab would present a partial pass as a complete one and call unread
  // dashboards empty.
  test("carries how far the gadget walk actually got", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready", gadgetsWalked: 180 });
    mocks.loadDashboards.mockResolvedValue([row()]);

    const result = await getDashboardInventory({ context: ctxWithAccount() });
    expect(result.gadgetsWalked).toBe(180);
  });

  test("reports never-built rather than empty", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue(null);
    expect(await getDashboardInventory({ context: ctxWithAccount() })).toMatchObject({
      available: false,
      neverBuilt: true,
    });
  });

  test("carries the failure reason forward when the last build failed", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({
      version: null,
      state: "failed",
      lastError: "401 scope does not match",
    });
    const result = await getDashboardInventory({ context: ctxWithAccount() });
    expect(result.lastError).toMatch(/401/);
  });
});

// What a dashboard depends on, resolved through the gadget -> filter join done at build
// time and the filter -> field join done here. The field card runs the same chain in reverse
// ("which dashboards use this field"); this is the other direction, and both have to agree
// because they read from the same tables.
describe("getDashboardInventory field dependencies", () => {
  const row = (over = {}) => ({
    id: "1",
    name: "Delivery overview",
    owner: { accountId: "a1", displayName: "Bob", active: true },
    ownerName: "Bob",
    ownerActive: true,
    shares: [],
    editShares: [],
    sharedWithEveryone: false,
    editableByEveryone: false,
    popularity: 4,
    gadgetCount: 1,
    shareCount: 0,
    gadgets: [{ id: "g1", title: "Open bugs", filterId: "500" }],
    ...over,
  });

  test("attaches the fields a dashboard depends on via its gadgets' filters", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadDashboards.mockResolvedValue([row()]);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1", state: "ready" });
    mocks.loadFieldNamesForFilterIds.mockResolvedValue(new Map([["500", ["Story Points", "Status"]]]));

    const result = await getDashboardInventory({ context: ctxWithAccount() });

    expect(mocks.loadFieldNamesForFilterIds).toHaveBeenCalledWith("test-install", "f1", ["500"]);
    expect(result.allDashboards[0].fieldRefs).toEqual(["Status", "Story Points"]);
    expect(result.fieldRefsAvailable).toBe(true);
  });

  test("unions fields across a dashboard's several gadgets without duplicates", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadDashboards.mockResolvedValue([
      row({
        gadgets: [
          { id: "g1", filterId: "500" },
          { id: "g2", filterId: "501" },
        ],
      }),
    ]);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1", state: "ready" });
    mocks.loadFieldNamesForFilterIds.mockResolvedValue(
      new Map([
        ["500", ["Story Points"]],
        ["501", ["Story Points", "Assignee"]],
      ]),
    );

    const result = await getDashboardInventory({ context: ctxWithAccount() });
    expect(result.allDashboards[0].fieldRefs).toEqual(["Assignee", "Story Points"]);
  });

  // Tri-state: no filter inventory means the join could not run, which is a different fact
  // from a dashboard whose gadgets reference nothing.
  test("reports fields as unmeasured, not empty, when no filter inventory exists", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadDashboards.mockResolvedValue([row()]);
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);

    const result = await getDashboardInventory({ context: ctxWithAccount() });

    expect(result.allDashboards[0].fieldRefs).toBeNull();
    expect(result.fieldRefsAvailable).toBe(false);
    expect(mocks.loadFieldNamesForFilterIds).not.toHaveBeenCalled();
  });

  test("reports an empty list, not null, when the inventory exists but nothing is referenced", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadDashboards.mockResolvedValue([row({ gadgets: [{ id: "g1", filterId: null }] })]);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1", state: "ready" });

    const result = await getDashboardInventory({ context: ctxWithAccount() });

    expect(result.allDashboards[0].fieldRefs).toEqual([]);
    expect(result.fieldRefsAvailable).toBe(true);
    expect(mocks.loadFieldNamesForFilterIds).not.toHaveBeenCalled();
  });

  // Per-gadget, not just the dashboard-wide union -- "this dashboard depends on Story
  // Points somewhere" and "this gadget depends on Story Points" are different claims, and
  // only the second says which gadget breaks if the field goes.
  test("attaches which filter each gadget uses, by name, alongside its own field refs", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadDashboards.mockResolvedValue([
      row({
        gadgets: [
          { id: "g1", title: "Open bugs", filterId: "500" },
          { id: "g2", title: "No filter", filterId: null },
        ],
      }),
    ]);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1", state: "ready" });
    mocks.loadFieldNamesForFilterIds.mockResolvedValue(new Map([["500", ["Story Points", "Status"]]]));
    mocks.loadFilterNamesForIds.mockResolvedValue(
      new Map([["500", { name: "Open Bugs", viewUrl: "https://x/issues/?filter=500" }]]),
    );

    const result = await getDashboardInventory({ context: ctxWithAccount() });

    expect(mocks.loadFilterNamesForIds).toHaveBeenCalledWith("test-install", "f1", ["500"]);
    const [g1, g2] = result.allDashboards[0].gadgets;
    expect(g1.filterName).toBe("Open Bugs");
    expect(g1.filterViewUrl).toBe("https://x/issues/?filter=500");
    expect(g1.fieldRefs).toEqual(["Story Points", "Status"]);
    // A gadget with no filter id has nothing to resolve, and stays untouched rather than
    // gaining a filterName of null that would read as "resolved to nothing".
    expect(g2.filterName).toBeUndefined();
  });

  // Tri-state at the gadget level too: a gadget that DOES have a filter id, on a dashboard
  // read before any filter inventory exists, is unmeasured -- not "no filter", and not
  // silently missing the property either.
  test("reports a gadget's filter as unmeasured, not omitted, when no filter inventory exists", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadDashboards.mockResolvedValue([row()]);
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);

    const result = await getDashboardInventory({ context: ctxWithAccount() });

    const [gadget] = result.allDashboards[0].gadgets;
    expect(gadget.filterName).toBeNull();
    expect(gadget.fieldRefs).toBeNull();
  });
});

describe("buildDashboardInventory", () => {
  test("queues a build and marks the row building", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue(null);
    mocks.kvsGet.mockResolvedValue(null);

    const result = await buildDashboardInventory({ context: ctxWithAccount() });

    expect(result).toMatchObject({ queued: true });
    expect(mocks.writeDashboardSnapshotMeta).toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({ state: "building" }),
    );
  });

  test("refuses in read-only mode, and says so", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue(null);
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true });

    const result = await buildDashboardInventory({ context: ctxWithAccount() });
    expect(result.queued).toBe(false);
    expect(result.error).toMatch(/Read-only/);
  });

  test("does not queue a second build over one still running", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ state: "building", startedAt: new Date().toISOString() });
    expect(await buildDashboardInventory({ context: ctxWithAccount() })).toMatchObject({
      queued: false,
      reason: "already-building",
    });
  });

  // A wedged row would otherwise suppress every future rebuild with no way out of the UI.
  test("queues over a build that can no longer be running", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({
      state: "building",
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    mocks.kvsGet.mockResolvedValue(null);

    expect(await buildDashboardInventory({ context: ctxWithAccount() })).toMatchObject({ queued: true });
  });
});

// A dashboard build hard-killed at the invocation ceiling wedges the tab exactly as the
// filter one did. Both read paths carry the flag, because the wedge is as reachable on a
// rebuild as on a first build.
describe("getDashboardInventory staleness", () => {
  test("reports a wedged build on both the never-built and rebuild paths", async () => {
    const wedged = { state: "building", startedAt: new Date(Date.now() - 3600e3).toISOString() };

    mocks.readDashboardSnapshotMeta.mockResolvedValue({ ...wedged, version: null });
    expect((await getDashboardInventory({ context: ctxWithAccount() })).staleBuild).toBe(true);

    mocks.readDashboardSnapshotMeta.mockResolvedValue({ ...wedged, version: "v1" });
    const live = await getDashboardInventory({ context: ctxWithAccount() });
    expect(live.available).toBe(true);
    expect(live.staleBuild).toBe(true);
  });

  test("does not call a build that just started stale", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({
      version: "v1",
      state: "building",
      startedAt: new Date().toISOString(),
    });
    expect((await getDashboardInventory({ context: ctxWithAccount() })).staleBuild).toBe(false);
  });
});

// The bug this exists to stop recurring: two resolvers pushed a bare payload instead of
// wrapping it in `body`, and Forge rejected the invocation with "Event body must be an
// object" the first time a user clicked the button. Every test involved passed, because they
// asserted that a push happened and not what was pushed.
//
// Swept rather than spot-checked. A per-resolver assertion only protects the resolvers
// somebody remembered to write one for, and that is precisely the failure mode here.
describe("every queued job carries a body envelope", () => {
  const queuers = [
    ["buildFilterInventory", () => buildFilterInventory({ context: ctxWithAccount() })],
    ["buildScreenInventory", () => buildScreenInventory({ context: ctxWithAccount() })],
    ["buildDashboardInventory", () => buildDashboardInventory({ context: ctxWithAccount() })],
  ];

  test.each(queuers)("%s pushes { body: { jobType, installationKey } }", async (_name, run) => {
    mocks.kvsGet.mockResolvedValue(null);
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);
    mocks.readDashboardSnapshotMeta.mockResolvedValue(null);
    mocks.queuePush.mockClear();

    await run();

    for (const call of mocks.queuePush.mock.calls) {
      const payload = call[0];
      // The consumer reads event?.body?.jobType. Anything else is a job that cannot run.
      expect(payload).toHaveProperty("body");
      expect(typeof payload.body).toBe("object");
      expect(payload.body).toHaveProperty("jobType");
      expect(payload).not.toHaveProperty("jobType");
    }
  });
});
