import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, ctxWithAccount } from "./test-harness.js";
import { SHARED_RESOLVER_FUNCTIONS, __RAW_ADMIN_ONLY_FUNCTIONS } from "../resolvers.js";
import { computeBoardStatusIds } from "./workflows.js";

const { getWorkflowInventory, getWorkflowInsights } = { ...SHARED_RESOLVER_FUNCTIONS, ...__RAW_ADMIN_ONLY_FUNCTIONS };

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// getWorkflowInventory
// ---------------------------------------------------------------------------
describe("getWorkflowInventory", () => {
  function workflowScheme(overrides = {}) {
    return {
      id: "scheme-1",
      name: "Default Workflow Scheme",
      description: "",
      defaultWorkflow: "Software Simplified Workflow",
      issueTypeMapping: null,
      projectCount: 2,
      findings: null,
      ...overrides,
    };
  }

  test("returns an empty, non-error shape when no workflow snapshot has ever completed", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue(null);
    const result = await getWorkflowInventory({ payload: {}, context: ctxWithAccount() });
    expect(result.schemes).toEqual([]);
    expect(result.statuses).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.snapshotStatus.state).toBe("idle");
    expect(mocks.loadWorkflowSchemes).not.toHaveBeenCalled();
  });

  test("returns paginated schemes and the status catalog from the latest snapshot version", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready", totalSchemes: 2 });
    mocks.loadWorkflowSchemes.mockResolvedValue([
      workflowScheme({ id: "scheme-1", name: "Alpha Scheme" }),
      workflowScheme({ id: "scheme-2", name: "Beta Scheme" }),
    ]);
    mocks.loadWorkflowSchemeProjects.mockResolvedValue([
      { projectId: "10", projectKey: "ALPHA", projectName: "Alpha" },
      { projectId: "11", projectKey: "BRAVO", projectName: "Bravo" },
    ]);
    mocks.loadStatusesCatalog.mockResolvedValue([{ id: "1", name: "To Do", statusCategory: "To Do" }]);

    const result = await getWorkflowInventory({ payload: { pageSize: 1, page: 1 }, context: ctxWithAccount() });

    expect(result.totalCount).toBe(2);
    expect(result.schemes).toHaveLength(1);
    expect(result.totalPages).toBe(2);
    // Statuses now carry both usage measures. Null rather than 0 for each: they are
    // measured by separate jobs and neither had run here, so "unknown" is the truth.
    expect(result.statuses).toEqual([
      {
        id: "1",
        name: "To Do",
        statusCategory: "To Do",
        issueCount: null,
        everCount: null,
        departedCount: null,
      },
    ]);
  });

  test("filters search by scheme name and description", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([
      workflowScheme({ id: "scheme-1", name: "Bug Triage Scheme" }),
      workflowScheme({ id: "scheme-2", name: "Default Scheme", description: "used for bugs too" }),
      workflowScheme({ id: "scheme-3", name: "Something Else" }),
    ]);
    mocks.loadWorkflowSchemeProjects.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([]);

    const result = await getWorkflowInventory({ payload: { search: "bug" }, context: ctxWithAccount() });

    expect(result.schemes.map((s) => s.id).sort()).toEqual(["scheme-1", "scheme-2"]);
  });

  // The build is queued to the consumer (timeoutSeconds: 900) rather than run inline: it
  // walks every project's workflow scheme, which does not fit in a resolver's 25s budget.
  test("force-refresh queues the build instead of running it in the resolver", async () => {
    mocks.readWorkflowSnapshotMeta
      .mockResolvedValueOnce({ version: null, state: "idle" }) // initial read
      .mockResolvedValueOnce({ version: null, state: "building" }); // post-queue read
    mocks.loadWorkflowSchemes.mockResolvedValue([workflowScheme()]);
    mocks.loadWorkflowSchemeProjects.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([]);

    const result = await getWorkflowInventory({ payload: { forceRefresh: true }, context: ctxWithAccount() });

    expect(mocks.queueWorkflowSnapshotBuild).toHaveBeenCalledWith("test-install");
    expect(mocks.buildWorkflowSnapshot).not.toHaveBeenCalled();
    // Reports the queued build so the UI can poll rather than showing "never built".
    expect(result.snapshotStatus.state).toBe("building");
  });

  test("does not trigger a second build while one is already in progress", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: null, state: "building" });
    mocks.isWorkflowBuildStale.mockReturnValue(false);

    await getWorkflowInventory({ payload: { forceRefresh: true }, context: ctxWithAccount() });

    expect(mocks.queueWorkflowSnapshotBuild).not.toHaveBeenCalled();
  });

  // The wedge this fixes: an invocation killed mid-build leaves state "building" with no
  // catch ever running, and every later refresh was suppressed as "already building" --
  // the button silently did nothing, forever, with no error to explain it.
  test("re-queues a build when a stale 'building' row is blocking it", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: null, state: "building" });
    mocks.isWorkflowBuildStale.mockReturnValue(true);

    await getWorkflowInventory({ payload: { forceRefresh: true }, context: ctxWithAccount() });

    expect(mocks.queueWorkflowSnapshotBuild).toHaveBeenCalledWith("test-install");
  });

  // Enriching every scheme to return one page is work proportional to the site, not the
  // page: at 142 schemes it was 284 round trips per read and the resolver hit its 25s
  // limit, hanging the tab on "Loading...". Cost must track pageSize.
  test("enriches only the requested page, not every scheme on the site", async () => {
    const manySchemes = Array.from({ length: 142 }, (_, i) =>
      workflowScheme({ id: `scheme-${i}`, name: `Scheme ${i}` }),
    );
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue(manySchemes);
    mocks.loadWorkflowSchemeProjects.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([]);

    const result = await getWorkflowInventory({
      payload: { page: 1, pageSize: 10 },
      context: ctxWithAccount(),
    });

    expect(result.schemes).toHaveLength(10);
    expect(result.totalCount).toBe(142);
    expect(mocks.loadWorkflowSchemeProjects).toHaveBeenCalledTimes(10);
    expect(mocks.getBrowsableProjectIds).toHaveBeenCalledTimes(10);
  });

  test("still reports the full total when a search matches more than one page", async () => {
    const manySchemes = Array.from({ length: 30 }, (_, i) =>
      workflowScheme({ id: `scheme-${i}`, name: `Payments ${i}` }),
    );
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([...manySchemes, workflowScheme({ id: "other", name: "Unrelated" })]);
    mocks.loadWorkflowSchemeProjects.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([]);

    const result = await getWorkflowInventory({
      payload: { search: "payments", page: 1, pageSize: 10 },
      context: ctxWithAccount(),
    });

    // Search must be applied across the whole set even though only a page is enriched.
    expect(result.totalCount).toBe(30);
    expect(result.schemes).toHaveLength(10);
    expect(mocks.loadWorkflowSchemeProjects).toHaveBeenCalledTimes(10);
  });

  // "Currently in" and "ever been in" come from different jobs (the universe scan and JQL
  // WAS queries) and refresh independently, so each is reported with its own availability
  // flag. Reporting an unmeasured status as 0 is what would make it look safe to delete.
  test("reports both usage measures on each status when both have been measured", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([{ id: "1", name: "Parking Lot", statusCategory: "To Do" }]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map([["1", 792]]));
    mocks.loadStatusHistoryCounts.mockResolvedValue({
      counts: new Map([["1", 4000]]),
      measuredAt: "2026-08-03T12:00:00Z",
    });

    const result = await getWorkflowInventory({ payload: {}, context: ctxWithAccount() });

    expect(result.statuses[0]).toMatchObject({ issueCount: 792, everCount: 4000, departedCount: 3208 });
    expect(result.statusCounts).toMatchObject({ hasCurrentCounts: true, hasHistoryCounts: true });
  });

  test("leaves the historical measure unknown when only the scan has run", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([{ id: "1", name: "Backlog", statusCategory: "To Do" }]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map([["1", 9423]]));

    const result = await getWorkflowInventory({ payload: {}, context: ctxWithAccount() });

    expect(result.statuses[0]).toMatchObject({ issueCount: 9423, everCount: null, departedCount: null });
    expect(result.statusCounts.hasHistoryCounts).toBe(false);
  });

  // The two measures are sampled at different times, so a status can gain issues between
  // them. A negative "departed" would be nonsense on screen.
  test("floors departed at zero when the current count exceeds the historical one", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([{ id: "1", name: "Active", statusCategory: "In Progress" }]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map([["1", 50]]));
    mocks.loadStatusHistoryCounts.mockResolvedValue({ counts: new Map([["1", 40]]), measuredAt: "x" });

    const result = await getWorkflowInventory({ payload: {}, context: ctxWithAccount() });

    expect(result.statuses[0].departedCount).toBe(0);
  });

  test("queues the history measurement only when asked and a snapshot exists", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([]);

    await getWorkflowInventory({ payload: { measureHistory: true }, context: ctxWithAccount() });
    expect(mocks.queueStatusHistoryBuild).toHaveBeenCalledWith("test-install");

    mocks.queueStatusHistoryBuild.mockClear();
    await getWorkflowInventory({ payload: {}, context: ctxWithAccount() });
    expect(mocks.queueStatusHistoryBuild).not.toHaveBeenCalled();
  });

  test("does not queue a history measurement with no snapshot to measure against", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: null, state: "idle" });

    await getWorkflowInventory({ payload: { measureHistory: true }, context: ctxWithAccount() });

    expect(mocks.queueStatusHistoryBuild).not.toHaveBeenCalled();
  });

  test("degrades to unknown when the count lookups fail", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([{ id: "1", name: "Done", statusCategory: "Done" }]);
    mocks.loadStatusIssueCounts.mockRejectedValue(new Error("sql down"));
    mocks.loadStatusHistoryCounts.mockRejectedValue(new Error("sql down"));

    const result = await getWorkflowInventory({ payload: {}, context: ctxWithAccount() });

    expect(result.statuses[0]).toMatchObject({ issueCount: null, everCount: null });
  });

  test("never surfaces a scheme's project count from projects the viewer can't browse", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([workflowScheme({ id: "scheme-1", projectCount: 2 })]);
    mocks.loadWorkflowSchemeProjects.mockResolvedValue([
      { projectId: "10", projectKey: "VISIBLE", projectName: "Visible Project" },
      { projectId: "11", projectKey: "HIDDEN", projectName: "Hidden Project" },
    ]);
    mocks.loadStatusesCatalog.mockResolvedValue([]);
    mocks.getBrowsableProjectIds.mockImplementation(async () => new Set(["10"])); // only project 10 is browsable

    const result = await getWorkflowInventory({ payload: {}, context: ctxWithAccount("less-privileged-user") });

    expect(result.schemes[0].projectCount).toBe(1);
  });

  test("validates page and pageSize bounds", async () => {
    await expect(getWorkflowInventory({ payload: { page: 0 }, context: ctxWithAccount() })).rejects.toThrow(/page/);
    await expect(getWorkflowInventory({ payload: { pageSize: 500 }, context: ctxWithAccount() })).rejects.toThrow(
      /pageSize/,
    );
  });

  test("propagates errors and increments the failure metric", async () => {
    mocks.readWorkflowSnapshotMeta.mockRejectedValue(new Error("SQL connection lost"));
    await expect(getWorkflowInventory({ payload: {}, context: ctxWithAccount() })).rejects.toThrow(
      "SQL connection lost",
    );
    expect(mocks.incrMetric).toHaveBeenCalledWith("resolver-failed");
  });
});

// Insight findings are site-wide by necessity -- a duplicate cannot be spotted from a
// single page -- so these tests focus on what the resolver is allowed to CLAIM, which is
// bounded by which upstream data actually exists.
describe("getWorkflowInsights", () => {
  const status = (id, name, statusCategory = "In Progress") => ({ statusId: String(id), name, statusCategory });

  test("reports unavailable rather than empty when no snapshot exists", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: null, state: "idle" });

    const result = await getWorkflowInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.available).toBe(false);
    expect(result.reason).toBe("no-snapshot");
  });

  test("finds duplicate status names across the catalog", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([status(1, "Backlog"), status(2, "Back Log"), status(3, "Delivered")]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([{ schemeId: "s1", statusId: "1" }]);

    const result = await getWorkflowInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.available).toBe(true);
    expect(result.summary.duplicateGroupCount).toBe(1);
    expect(result.summary.reducibleStatusCount).toBe(1);
  });

  // The scan is versioned independently of the workflow snapshot and may never have run.
  // "No issue counts" must never be reported as "zero issues", because zero is what makes
  // an unreachable status safe to delete.
  test("never claims a status is unused when the scan has not run", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([status(1, "Orphaned")]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([{ schemeId: "s1", statusId: "99" }]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map());

    const result = await getWorkflowInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.hasIssueCounts).toBe(false);
    expect(result.orphans[0].issueCount).toBeNull();
    expect(result.orphans[0].safeToRemove).toBe(false);
    expect(result.summary.safeToRemoveCount).toBe(0);
  });

  test("marks a never-used orphan as safe once scan counts exist", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([status(1, "Orphaned"), status(2, "Used Once")]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([{ schemeId: "s1", statusId: "99" }]);
    mocks.loadStatusIssueCounts.mockResolvedValue(
      new Map([
        ["1", 0],
        ["2", 5],
      ]),
    );

    const result = await getWorkflowInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.hasIssueCounts).toBe(true);
    expect(result.summary.safeToRemoveCount).toBe(1);
  });

  // If Jira did not return workflow statuses, EVERY status looks orphaned and EVERY
  // scheme looks empty. Suppress both rather than publishing confident nonsense.
  test("suppresses orphan and balance findings when scheme-status data is missing", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([{ id: "s1", name: "Alpha", projectCount: 2 }]);
    mocks.loadStatusesCatalog.mockResolvedValue([status(1, "A"), status(2, "B")]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([]);

    const result = await getWorkflowInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.schemeStatusesAvailable).toBe(false);
    expect(result.orphans).toEqual([]);
    expect(result.balance).toEqual([]);
  });

  test("survives the scan count lookup failing", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadWorkflowSchemes.mockResolvedValue([]);
    mocks.loadStatusesCatalog.mockResolvedValue([status(1, "A")]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([{ schemeId: "s1", statusId: "1" }]);
    mocks.loadStatusIssueCounts.mockRejectedValue(new Error("sql down"));

    const result = await getWorkflowInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.available).toBe(true);
    expect(result.hasIssueCounts).toBe(false);
  });
});

// Tri-state, like every cross-pillar join: a board snapshot that cannot be read is "unknown"
// (null), never an empty set that would read as "no board uses this status".
describe("computeBoardStatusIds", () => {
  test("returns null, not an empty set, when the board snapshot cannot be read", async () => {
    mocks.readBoardSnapshotMeta.mockRejectedValueOnce(new Error("sql down"));
    expect(await computeBoardStatusIds("test-install")).toBeNull();
    expect(mocks.loadBoardColumns).not.toHaveBeenCalled();
  });
});
