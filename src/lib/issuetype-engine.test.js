import { vi, describe, test, expect, beforeEach } from "vitest";

// The two things worth pinning: normalizeIssueType's handling of the signed hierarchy level
// and the tri-state scope, and that buildIssueTypeSnapshot sequences the /project call after
// the project list rather than issuing it bare (which 400s and takes the build with it).

vi.mock("./jira-api.js", () => ({
  incrMetric: vi.fn(),
  METRIC_NAMES: {
    issueTypeSnapshotStarted: "issue-type-snapshot-started",
    issueTypeSnapshotCompleted: "issue-type-snapshot-completed",
    issueTypeSnapshotFailed: "issue-type-snapshot-failed",
  },
  getAllIssueTypes: vi.fn(),
  getAllIssueTypeSchemes: vi.fn(),
  getIssueTypeSchemeItems: vi.fn(),
  getIssueTypeSchemeProjects: vi.fn(),
  getAllJiraProjects: vi.fn(),
}));

vi.mock("./queues.js", () => ({ inventorySnapshotQueue: { push: vi.fn() } }));

vi.mock("./project-store.js", () => ({
  ensureProjectStoreReady: vi.fn(),
  writeIssueTypeSnapshotMeta: vi.fn(),
  readIssueTypeSnapshotMeta: vi.fn(),
  replaceIssueTypeSnapshot: vi.fn(),
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  fallbackOn: () => () => undefined,
  ignoreWith: () => () => undefined,
}));

import {
  normalizeIssueType,
  isIssueTypeBuildStale,
  buildIssueTypeSnapshot,
  queueIssueTypeSnapshotBuild,
  ISSUE_TYPE_BUILD_STALE_MS,
} from "./issuetype-engine.js";
import {
  getAllIssueTypes,
  getAllIssueTypeSchemes,
  getIssueTypeSchemeItems,
  getIssueTypeSchemeProjects,
  getAllJiraProjects,
} from "./jira-api.js";
import { inventorySnapshotQueue } from "./queues.js";
import { replaceIssueTypeSnapshot, writeIssueTypeSnapshotMeta } from "./project-store.js";

beforeEach(() => vi.clearAllMocks());

describe("normalizeIssueType", () => {
  test("keeps a sub-task's -1 hierarchy level rather than zeroing it", () => {
    expect(normalizeIssueType({ id: 5, name: "Sub-task", subtask: true, hierarchyLevel: -1 }))
      .toMatchObject({ id: "5", subtask: true, hierarchyLevel: -1 });
  });

  test("defaults an absent or unparseable level to 0", () => {
    expect(normalizeIssueType({ id: 1, name: "Task" }).hierarchyLevel).toBe(0);
    expect(normalizeIssueType({ id: 1, hierarchyLevel: "nonsense" }).hierarchyLevel).toBe(0);
  });

  test("reads the owning project off a team-managed type's scope, and null for a global one", () => {
    expect(normalizeIssueType({ id: 1, name: "Global" }).scopeProjectId).toBeNull();
    expect(normalizeIssueType({ id: 2, name: "Team", scope: { type: "PROJECT", project: { id: "10000" } } }).scopeProjectId)
      .toBe("10000");
  });
});

describe("isIssueTypeBuildStale", () => {
  test("only a building row can be stale", () => {
    expect(isIssueTypeBuildStale({ state: "ready", startedAt: new Date(0).toISOString() })).toBe(false);
  });

  test("a building row with no parseable start is treated as stale so the wedge is recoverable", () => {
    expect(isIssueTypeBuildStale({ state: "building", startedAt: null })).toBe(true);
  });

  test("a building row is stale only once it is older than the ceiling", () => {
    const now = 1_000_000_000;
    expect(isIssueTypeBuildStale({ state: "building", startedAt: new Date(now - 1000).toISOString() }, now)).toBe(false);
    expect(isIssueTypeBuildStale({ state: "building", startedAt: new Date(now - ISSUE_TYPE_BUILD_STALE_MS - 1).toISOString() }, now)).toBe(true);
  });
});

describe("queueIssueTypeSnapshotBuild", () => {
  test("marks the row building before it queues, so a double click collapses to one job", async () => {
    await queueIssueTypeSnapshotBuild("inst");

    expect(writeIssueTypeSnapshotMeta).toHaveBeenCalledWith("inst", expect.objectContaining({ state: "building" }));
    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ jobType: "build-issue-type-snapshot", installationKey: "inst" }) })
    );
  });
});

describe("buildIssueTypeSnapshot", () => {
  const projects = [{ id: "10000", key: "OBS", name: "Observatory" }, { id: "10001", key: "PT", name: "Platform" }];

  function wireHappyPath() {
    getAllJiraProjects.mockResolvedValue(projects);
    getAllIssueTypes.mockResolvedValue([
      { id: "1", name: "Epic", subtask: false, hierarchyLevel: 1 },
      { id: "2", name: "Story", subtask: false, hierarchyLevel: 0 },
      { id: "3", name: "Sub-task", subtask: true, hierarchyLevel: -1 },
    ]);
    getAllIssueTypeSchemes.mockResolvedValue([
      { id: "5", name: "Default", description: "", defaultIssueTypeId: "2", isDefault: true },
      { id: "6", name: "Software", description: "", defaultIssueTypeId: "1", isDefault: false },
    ]);
    getIssueTypeSchemeItems.mockResolvedValue([
      { issueTypeSchemeId: "5", issueTypeId: "2" },
      { issueTypeSchemeId: "5", issueTypeId: "3" },
      { issueTypeSchemeId: "6", issueTypeId: "1" },
      { issueTypeSchemeId: "6", issueTypeId: "2" },
    ]);
    getIssueTypeSchemeProjects.mockResolvedValue([
      { issueTypeScheme: { id: "5" }, projectIds: ["10000"] },
      { issueTypeScheme: { id: "6" }, projectIds: ["10001"] },
    ]);
  }

  test("issues the /project call after the project list is in hand, never bare", async () => {
    wireHappyPath();
    await buildIssueTypeSnapshot("inst");

    expect(getIssueTypeSchemeProjects).toHaveBeenCalledTimes(1);
    // Called with the resolved project ids -- issuing it with nothing is the 400 this ordering exists to avoid.
    expect(getIssueTypeSchemeProjects).toHaveBeenCalledWith(["10000", "10001"]);
  });

  test("assigns a per-scheme order index to the membership rows", async () => {
    wireHappyPath();
    await buildIssueTypeSnapshot("inst");

    const [, , payload] = replaceIssueTypeSnapshot.mock.calls[0];
    expect(payload.schemeItems).toEqual([
      { schemeId: "5", issueTypeId: "2", itemIndex: 0 },
      { schemeId: "5", issueTypeId: "3", itemIndex: 1 },
      { schemeId: "6", issueTypeId: "1", itemIndex: 0 },
      { schemeId: "6", issueTypeId: "2", itemIndex: 1 },
    ]);
  });

  test("denormalises each scheme's project count and resolves ids to keys", async () => {
    wireHappyPath();
    await buildIssueTypeSnapshot("inst");

    const [, , payload] = replaceIssueTypeSnapshot.mock.calls[0];
    expect(payload.schemes.find((s) => s.id === "5")).toMatchObject({ projectCount: 1 });
    expect(payload.schemeProjects).toContainEqual(
      expect.objectContaining({ schemeId: "5", projectId: "10000", projectKey: "OBS", projectName: "Observatory" })
    );
  });

  test("keeps a scheme project row even when the project is not in the catalog", async () => {
    wireHappyPath();
    getIssueTypeSchemeProjects.mockResolvedValue([{ issueTypeScheme: { id: "5" }, projectIds: ["99999"] }]);

    await buildIssueTypeSnapshot("inst");
    const [, , payload] = replaceIssueTypeSnapshot.mock.calls[0];
    expect(payload.schemeProjects).toContainEqual(
      expect.objectContaining({ projectId: "99999", projectKey: "UNKNOWN" })
    );
  });

  test("writes a ready meta row with the totals on success", async () => {
    wireHappyPath();
    await buildIssueTypeSnapshot("inst");

    expect(writeIssueTypeSnapshotMeta).toHaveBeenLastCalledWith("inst", expect.objectContaining({
      state: "ready", totalTypes: 3, totalSchemes: 2,
    }));
  });

  test("marks the row failed and rethrows when a dependency call throws", async () => {
    wireHappyPath();
    getAllIssueTypes.mockRejectedValueOnce(new Error("403 Forbidden"));

    await expect(buildIssueTypeSnapshot("inst")).rejects.toThrow("403 Forbidden");
    expect(writeIssueTypeSnapshotMeta).toHaveBeenLastCalledWith("inst", expect.objectContaining({
      state: "failed", lastError: expect.stringContaining("403"),
    }));
    expect(replaceIssueTypeSnapshot).not.toHaveBeenCalled();
  });
});
