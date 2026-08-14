import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildWorkflowSnapshot,
  queueWorkflowSnapshotBuild,
  isWorkflowBuildStale,
  WORKFLOW_BUILD_STALE_MS,
  buildStatusHistorySnapshot,
  queueStatusHistoryBuild,
} from "./workflow-engine.js";

// logger.js is left real (console formatting only, no I/O) -- same convention
// as snapshot-engine.test.js.

vi.mock("./queues.js", () => ({
  inventorySnapshotQueue: { push: vi.fn().mockResolvedValue({ queued: true }) },
}));

vi.mock("./jira-api.js", () => ({
  incrMetric: vi.fn(),
  METRIC_NAMES: {
    workflowSnapshotStarted: "workflow-snapshot-started",
    workflowSnapshotCompleted: "workflow-snapshot-completed",
    workflowSnapshotFailed: "workflow-snapshot-failed",
  },
  getAllJiraProjects: vi.fn().mockResolvedValue([]),
  getAllStatuses: vi.fn().mockResolvedValue([]),
  getWorkflowSchemesForProjects: vi.fn().mockResolvedValue([]),
  getAllWorkflowsWithStatuses: vi.fn().mockResolvedValue([]),
  getEverInStatusCounts: vi.fn().mockResolvedValue({ counts: new Map(), failures: [] }),
  getStatusesForProjects: vi.fn().mockResolvedValue({ byProject: new Map(), failures: [] }),
}));

vi.mock("./project-store.js", () => ({
  ensureProjectStoreReady: vi.fn().mockResolvedValue(undefined),
  writeWorkflowSnapshotMeta: vi.fn().mockResolvedValue(undefined),
  replaceWorkflowSnapshot: vi.fn().mockResolvedValue(undefined),
  loadStatusesCatalog: vi.fn().mockResolvedValue([]),
  readWorkflowSnapshotMeta: vi.fn().mockResolvedValue(null),
  upsertStatusHistoryCounts: vi.fn().mockResolvedValue(undefined),
}));

import {
  getAllJiraProjects,
  getAllStatuses,
  getWorkflowSchemesForProjects,
  getAllWorkflowsWithStatuses,
  getEverInStatusCounts,
  getStatusesForProjects,
} from "./jira-api.js";
import {
  writeWorkflowSnapshotMeta,
  replaceWorkflowSnapshot,
  loadStatusesCatalog,
  readWorkflowSnapshotMeta,
  upsertStatusHistoryCounts,
} from "./project-store.js";
import { inventorySnapshotQueue } from "./queues.js";

beforeEach(() => {
  vi.clearAllMocks();
  getAllJiraProjects.mockResolvedValue([]);
  getAllStatuses.mockResolvedValue([]);
  getWorkflowSchemesForProjects.mockResolvedValue([]);
  getAllWorkflowsWithStatuses.mockResolvedValue([]);
  getEverInStatusCounts.mockResolvedValue({ counts: new Map(), failures: [] });
  getStatusesForProjects.mockResolvedValue({ byProject: new Map(), failures: [] });
  loadStatusesCatalog.mockResolvedValue([]);
  readWorkflowSnapshotMeta.mockResolvedValue(null);
  upsertStatusHistoryCounts.mockResolvedValue(undefined);
  writeWorkflowSnapshotMeta.mockResolvedValue(undefined);
  replaceWorkflowSnapshot.mockResolvedValue(undefined);
});

describe("buildWorkflowSnapshot", () => {
  it("writes a 'building' state before fetching, then a 'ready' state on success", async () => {
    getAllStatuses.mockResolvedValue([{ id: "1", name: "To Do", statusCategory: { name: "To Do" } }]);
    getAllJiraProjects.mockResolvedValue([{ id: "10", key: "ALPHA", name: "Alpha" }]);
    getWorkflowSchemesForProjects.mockResolvedValue([
      { projectId: "10", scheme: { id: "scheme-1", name: "Default Scheme" }, error: null },
    ]);

    const result = await buildWorkflowSnapshot("install-1");

    expect(writeWorkflowSnapshotMeta).toHaveBeenNthCalledWith(
      1, "install-1", expect.objectContaining({ state: "building" })
    );
    expect(writeWorkflowSnapshotMeta).toHaveBeenLastCalledWith(
      "install-1", expect.objectContaining({ state: "ready", totalSchemes: 1 })
    );
    expect(result.schemeCount).toBe(1);
    expect(result.statusCount).toBe(1);
    expect(result.projectCount).toBe(1);
  });

  it("aggregates multiple projects sharing the same scheme into one row with the right project count", async () => {
    getAllJiraProjects.mockResolvedValue([
      { id: "10", key: "ALPHA", name: "Alpha" },
      { id: "11", key: "BRAVO", name: "Bravo" },
    ]);
    getWorkflowSchemesForProjects.mockResolvedValue([
      { projectId: "10", scheme: { id: "scheme-1", name: "Shared Scheme" }, error: null },
      { projectId: "11", scheme: { id: "scheme-1", name: "Shared Scheme" }, error: null },
    ]);

    const result = await buildWorkflowSnapshot("install-1");

    expect(result.schemeCount).toBe(1);
    const [, , writtenData] = replaceWorkflowSnapshot.mock.calls[0];
    expect(writtenData.schemes).toHaveLength(1);
    expect(writtenData.schemes[0].projectCount).toBe(2);
    expect(writtenData.schemeProjects).toHaveLength(2);
  });

  it("skips a project whose scheme lookup failed instead of throwing the whole build", async () => {
    getAllJiraProjects.mockResolvedValue([
      { id: "10", key: "ALPHA", name: "Alpha" },
      { id: "11", key: "BRAVO", name: "Bravo" },
    ]);
    getWorkflowSchemesForProjects.mockResolvedValue([
      { projectId: "10", scheme: { id: "scheme-1", name: "OK Scheme" }, error: null },
      { projectId: "11", scheme: null, error: "403 Forbidden" },
    ]);

    const result = await buildWorkflowSnapshot("install-1");

    expect(result.schemeCount).toBe(1);
    const [, , writtenData] = replaceWorkflowSnapshot.mock.calls[0];
    expect(writtenData.schemeProjects).toHaveLength(1);
    expect(writtenData.schemeProjects[0].projectId).toBe("10");
  });

  it("writes a 'failed' state and rethrows when a fetch fails", async () => {
    getAllStatuses.mockRejectedValue(new Error("Jira API down"));

    await expect(buildWorkflowSnapshot("install-1")).rejects.toThrow("Jira API down");

    expect(writeWorkflowSnapshotMeta).toHaveBeenLastCalledWith(
      "install-1", expect.objectContaining({ state: "failed", lastError: expect.stringContaining("Jira API down") })
    );
    expect(replaceWorkflowSnapshot).not.toHaveBeenCalled();
  });

  it("derives statusCategory from either statusCategory.name or .key", async () => {
    getAllStatuses.mockResolvedValue([
      { id: "1", name: "Done", statusCategory: { name: "Done" } },
      { id: "2", name: "Weird", statusCategory: { key: "new" } },
    ]);

    await buildWorkflowSnapshot("install-1");

    const [, , writtenData] = replaceWorkflowSnapshot.mock.calls[0];
    expect(writtenData.statuses).toEqual([
      { id: "1", name: "Done", statusCategory: "Done" },
      { id: "2", name: "Weird", statusCategory: "new" },
    ]);
  });
});

// Regression coverage for the wedge that made the Workflows tab's build button appear to
// do nothing: a Forge invocation timeout is a hard kill, so buildWorkflowSnapshot's own
// catch never runs and the row is left at "building" forever. Everything below exists to
// keep that state recoverable and off the resolver's 25s budget.

describe("isWorkflowBuildStale", () => {
  const now = Date.parse("2026-08-03T12:00:00.000Z");

  it("is false for states other than building", () => {
    expect(isWorkflowBuildStale({ state: "ready", startedAt: null }, now)).toBe(false);
    expect(isWorkflowBuildStale({ state: "failed", startedAt: null }, now)).toBe(false);
    expect(isWorkflowBuildStale(null, now)).toBe(false);
  });

  it("is false for a build still within the consumer's timeout", () => {
    const startedAt = new Date(now - 60_000).toISOString();
    expect(isWorkflowBuildStale({ state: "building", startedAt }, now)).toBe(false);
  });

  it("is true once the build outlives what the consumer could possibly run", () => {
    const startedAt = new Date(now - WORKFLOW_BUILD_STALE_MS - 1000).toISOString();
    expect(isWorkflowBuildStale({ state: "building", startedAt }, now)).toBe(true);
  });

  // Rows written before startedAt was recorded, or with a corrupt value, must not become
  // permanently unrecoverable -- an unprovable build is treated as abandoned.
  it("is true when startedAt is missing or unparseable", () => {
    expect(isWorkflowBuildStale({ state: "building", startedAt: null }, now)).toBe(true);
    expect(isWorkflowBuildStale({ state: "building", startedAt: "not-a-date" }, now)).toBe(true);
  });
});

describe("queueWorkflowSnapshotBuild", () => {
  it("marks the build as building and enqueues it rather than running it inline", async () => {
    await queueWorkflowSnapshotBuild("install-1");

    expect(writeWorkflowSnapshotMeta).toHaveBeenCalledWith(
      "install-1",
      expect.objectContaining({ state: "building", lastError: null })
    );
    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith({
      body: { jobType: "build-workflow-snapshot", installationKey: "install-1" },
    });
    // The whole point: no Jira traffic on the caller's invocation.
    expect(getWorkflowSchemesForProjects).not.toHaveBeenCalled();
  });

  it("records a startedAt so staleness can be judged later", async () => {
    await queueWorkflowSnapshotBuild("install-1");

    const [, meta] = writeWorkflowSnapshotMeta.mock.calls[0];
    expect(Number.isFinite(Date.parse(meta.startedAt))).toBe(true);
    expect(isWorkflowBuildStale({ state: "building", startedAt: meta.startedAt })).toBe(false);
  });
});

describe("buildStatusHistorySnapshot", () => {
  test("measures every status in the catalog and stores the counts", async () => {
    readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1" });
    loadStatusesCatalog.mockResolvedValue([{ id: "1", name: "Done" }, { id: "2", name: "Backlog" }]);
    getEverInStatusCounts.mockResolvedValue({ counts: new Map([["1", 4000], ["2", 900]]), failures: [] });

    const result = await buildStatusHistorySnapshot("install-1");

    expect(getEverInStatusCounts).toHaveBeenCalledWith(["1", "2"]);
    expect(upsertStatusHistoryCounts).toHaveBeenCalledWith("install-1", expect.any(Map), expect.any(String));
    expect(result).toMatchObject({ measured: 2, failed: 0 });
  });

  // Partial results are kept and dated. A status whose query failed keeps whatever it had
  // rather than being overwritten with zero.
  test("stores the successes and reports the failures", async () => {
    readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1" });
    loadStatusesCatalog.mockResolvedValue([{ id: "1" }, { id: "2" }]);
    getEverInStatusCounts.mockResolvedValue({
      counts: new Map([["1", 4000]]),
      failures: [{ statusId: "2", error: "timeout" }],
    });

    const result = await buildStatusHistorySnapshot("install-1");

    expect(result).toMatchObject({ measured: 1, failed: 1 });
    const [, storedCounts] = upsertStatusHistoryCounts.mock.calls[0];
    expect(storedCounts.has("2")).toBe(false);
  });

  test("skips when no workflow snapshot exists to take the catalog from", async () => {
    readWorkflowSnapshotMeta.mockResolvedValue(null);

    const result = await buildStatusHistorySnapshot("install-1");

    expect(result).toMatchObject({ skipped: true });
    expect(getEverInStatusCounts).not.toHaveBeenCalled();
  });

  test("skips when the catalog is empty", async () => {
    readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1" });
    loadStatusesCatalog.mockResolvedValue([]);

    expect(await buildStatusHistorySnapshot("install-1")).toMatchObject({ skipped: true });
    expect(getEverInStatusCounts).not.toHaveBeenCalled();
  });
});

describe("queueStatusHistoryBuild", () => {
  test("enqueues the job rather than running the queries inline", async () => {
    await queueStatusHistoryBuild("install-1");

    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith({
      body: { jobType: "build-status-history", installationKey: "install-1" },
    });
    // Hundreds of history queries cannot fit in a resolver invocation.
    expect(getEverInStatusCounts).not.toHaveBeenCalled();
  });
});


// Both workflow-search endpoints 401 on installs that fully declare read:workflow:jira,
// and `forge install --upgrade` reports the site already current -- so the workflow map is
// routinely empty through no fault of the caller. Without a second route, every status on
// the site looks unreachable and orphan detection reports nonsense.

// Transitions that open a screen.
//
// The screen catalog can only see the scheme chain, so a screen attached to a transition
// looked unreachable to it -- and "nothing reaches this screen" is the sentence an admin
// deletes on. Captured here, in the same pass that already fetches the workflow list.
describe("transition screens", () => {
  const projects = [{ id: "1", key: "A", name: "Alpha" }];
  const oneScheme = [{ projectId: "1", scheme: { id: "s1", name: "Scheme", defaultWorkflow: "WF" } }];

  it("flattens transition screens out of the workflow list", async () => {
    getAllJiraProjects.mockResolvedValue(projects);
    getWorkflowSchemesForProjects.mockResolvedValue(oneScheme);
    getAllWorkflowsWithStatuses.mockResolvedValue([{
      name: "WF",
      statusIds: ["7"],
      transitions: [
        { id: "11", name: "Start", toStatus: "3", screenId: "220" },
        { id: "12", name: "Resolve", toStatus: "5", screenId: "300" },
      ],
    }]);

    await buildWorkflowSnapshot("install-1");

    const [, , written] = replaceWorkflowSnapshot.mock.calls[0];
    expect(written.transitionScreens).toEqual([
      { workflowName: "WF", transitionId: "11", transitionName: "Start", toStatus: "3", screenId: "220" },
      { workflowName: "WF", transitionId: "12", transitionName: "Resolve", toStatus: "5", screenId: "300" },
    ]);
  });

  // Empty is a real answer -- it means no transition on this site opens a screen -- and it
  // is stored as such rather than skipped.
  it("writes an empty list when no transition opens a screen", async () => {
    getAllJiraProjects.mockResolvedValue(projects);
    getWorkflowSchemesForProjects.mockResolvedValue(oneScheme);
    getAllWorkflowsWithStatuses.mockResolvedValue([{ name: "WF", statusIds: ["7"], transitions: [] }]);

    await buildWorkflowSnapshot("install-1");

    const [, , written] = replaceWorkflowSnapshot.mock.calls[0];
    expect(written.transitionScreens).toEqual([]);
  });

  // The row is keyed on the transition id, so one without an id would be unwritable.
  it("falls back to the transition name when it carries no id", async () => {
    getAllJiraProjects.mockResolvedValue(projects);
    getWorkflowSchemesForProjects.mockResolvedValue(oneScheme);
    getAllWorkflowsWithStatuses.mockResolvedValue([{
      name: "WF", statusIds: [],
      transitions: [{ id: null, name: "Edit", screenId: "220" }],
    }]);

    await buildWorkflowSnapshot("install-1");

    const [, , written] = replaceWorkflowSnapshot.mock.calls[0];
    expect(written.transitionScreens[0].transitionId).toBe("Edit");
  });

  it("survives a workflow list that predates the transitions expansion", async () => {
    getAllJiraProjects.mockResolvedValue(projects);
    getWorkflowSchemesForProjects.mockResolvedValue(oneScheme);
    getAllWorkflowsWithStatuses.mockResolvedValue([{ name: "WF", statusIds: ["7"] }]);

    await expect(buildWorkflowSnapshot("install-1")).resolves.toBeDefined();
    const [, , written] = replaceWorkflowSnapshot.mock.calls[0];
    expect(written.transitionScreens).toEqual([]);
  });
});

describe("scheme statuses via projects", () => {
  const projects = [{ id: "10", key: "ALPHA", name: "Alpha" }, { id: "11", key: "BRAVO", name: "Bravo" }];
  const twoProjectScheme = [
    { projectId: "10", scheme: { id: "s1", name: "Shared", defaultWorkflow: "WF" }, error: null },
    { projectId: "11", scheme: { id: "s1", name: "Shared", defaultWorkflow: "WF" }, error: null },
  ];

  it("falls back to project statuses when the workflow map is empty", async () => {
    getAllJiraProjects.mockResolvedValue(projects);
    getWorkflowSchemesForProjects.mockResolvedValue(twoProjectScheme);
    getAllWorkflowsWithStatuses.mockResolvedValue([]);
    getStatusesForProjects.mockResolvedValue({
      byProject: new Map([["10", ["1", "2"]], ["11", ["2", "3"]]]),
      failures: [],
    });

    await buildWorkflowSnapshot("install-1");

    const [, , written] = replaceWorkflowSnapshot.mock.calls[0];
    // Union across the scheme's projects, deduplicated: 1, 2, 3 -- not 2 twice.
    expect(written.schemeStatuses.map((r) => r.statusId).sort()).toEqual(["1", "2", "3"]);
    expect(written.schemeStatuses.every((r) => r.schemeId === "s1")).toBe(true);
  });

  it("prefers workflow definitions and does not probe projects when they are available", async () => {
    getAllJiraProjects.mockResolvedValue(projects);
    getWorkflowSchemesForProjects.mockResolvedValue(twoProjectScheme);
    getAllWorkflowsWithStatuses.mockResolvedValue([{ name: "WF", statusIds: ["7"] }]);

    await buildWorkflowSnapshot("install-1");

    expect(getStatusesForProjects).not.toHaveBeenCalled();
    const [, , written] = replaceWorkflowSnapshot.mock.calls[0];
    expect(written.schemeStatuses.map((r) => r.statusId)).toEqual(["7"]);
  });

  it("keeps the snapshot when some projects cannot be read", async () => {
    getAllJiraProjects.mockResolvedValue(projects);
    getWorkflowSchemesForProjects.mockResolvedValue(twoProjectScheme);
    getAllWorkflowsWithStatuses.mockResolvedValue([]);
    getStatusesForProjects.mockResolvedValue({
      byProject: new Map([["10", ["1"]]]),
      failures: [{ projectId: "11", error: "403" }],
    });

    await buildWorkflowSnapshot("install-1");

    // One unreadable project must not empty the mapping for the whole site.
    const [, , written] = replaceWorkflowSnapshot.mock.calls[0];
    expect(written.schemeStatuses.map((r) => r.statusId)).toEqual(["1"]);
  });

  it("leaves the mapping empty when neither route yields anything", async () => {
    getAllJiraProjects.mockResolvedValue(projects);
    getWorkflowSchemesForProjects.mockResolvedValue(twoProjectScheme);
    getAllWorkflowsWithStatuses.mockResolvedValue([]);
    getStatusesForProjects.mockResolvedValue({ byProject: new Map(), failures: [] });

    await buildWorkflowSnapshot("install-1");

    // Empty is honest here; the resolver suppresses orphan findings rather than
    // reporting every status as unreachable.
    const [, , written] = replaceWorkflowSnapshot.mock.calls[0];
    expect(written.schemeStatuses).toEqual([]);
  });
});
