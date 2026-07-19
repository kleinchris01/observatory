import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildWorkflowSnapshot } from "./workflow-engine.js";

// logger.js is left real (console formatting only, no I/O) -- same convention
// as snapshot-engine.test.js.

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
}));

vi.mock("./project-store.js", () => ({
  ensureProjectStoreReady: vi.fn().mockResolvedValue(undefined),
  writeWorkflowSnapshotMeta: vi.fn().mockResolvedValue(undefined),
  replaceWorkflowSnapshot: vi.fn().mockResolvedValue(undefined),
}));

import {
  getAllJiraProjects,
  getAllStatuses,
  getWorkflowSchemesForProjects,
} from "./jira-api.js";
import { writeWorkflowSnapshotMeta, replaceWorkflowSnapshot } from "./project-store.js";

beforeEach(() => {
  vi.clearAllMocks();
  getAllJiraProjects.mockResolvedValue([]);
  getAllStatuses.mockResolvedValue([]);
  getWorkflowSchemesForProjects.mockResolvedValue([]);
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
