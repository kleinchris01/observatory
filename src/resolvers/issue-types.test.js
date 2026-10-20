import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks } from "./test-harness.js";
import { __RAW_ADMIN_ONLY_FUNCTIONS } from "../resolvers.js";

const { getIssueTypeInventory, buildIssueTypeInventory } = __RAW_ADMIN_ONLY_FUNCTIONS;

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

describe("getIssueTypeInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("reports never-built rather than returning empty lists", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue(null);

    const result = await getIssueTypeInventory(ctx);

    expect(result.neverBuilt).toBe(true);
    expect(result.issueTypes).toEqual([]);
    expect(result.hierarchy).toEqual([]);
    expect(mocks.loadIssueTypes).not.toHaveBeenCalled();
  });

  test("groups the catalog by hierarchy level, highest first, with a label per level", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "v1",
      totalTypes: 3,
      totalSchemes: 1,
    });
    mocks.loadIssueTypes.mockResolvedValue([
      { id: "1", name: "Epic", hierarchyLevel: 1, subtask: false, scopeProjectId: null },
      { id: "2", name: "Story", hierarchyLevel: 0, subtask: false, scopeProjectId: null },
      { id: "3", name: "Sub-task", hierarchyLevel: -1, subtask: true, scopeProjectId: null },
    ]);
    mocks.loadIssueTypeSchemes.mockResolvedValue([]);
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);

    const result = await getIssueTypeInventory(ctx);

    expect(result.hierarchy.map((h) => h.level)).toEqual([1, 0, -1]);
    expect(result.hierarchy[0]).toMatchObject({ label: "Epic" });
    expect(result.hierarchy[2]).toMatchObject({ label: "Sub-task" });
    expect(result.hierarchy[2].types[0].id).toBe("3");
  });

  test("resolves each scheme's ordered membership and default type against the catalog", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadIssueTypes.mockResolvedValue([
      { id: "1", name: "Epic", hierarchyLevel: 1 },
      { id: "2", name: "Story", hierarchyLevel: 0 },
    ]);
    mocks.loadIssueTypeSchemes.mockResolvedValue([
      { schemeId: "5", name: "Default", defaultIssueTypeId: "2", isDefault: true, projectCount: 1 },
    ]);
    mocks.loadIssueTypeSchemeItems.mockResolvedValue([
      { schemeId: "5", issueTypeId: "1", itemIndex: 0 },
      { schemeId: "5", issueTypeId: "2", itemIndex: 1 },
      { schemeId: "5", issueTypeId: "999", itemIndex: 2 },
    ]);
    mocks.loadIssueTypeSchemeProjects.mockResolvedValue([
      { schemeId: "5", projectId: "10000", projectKey: "OBS", projectName: "Observatory" },
    ]);
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);

    const result = await getIssueTypeInventory(ctx);

    const scheme = result.schemes[0];
    expect(scheme.defaultIssueTypeName).toBe("Story");
    expect(scheme.issueTypes.map((t) => t.name)).toEqual(["Epic", "Story", null]);
    // A member the catalog does not contain is kept and flagged, not dropped -- a scheme
    // allowing a type that no longer exists is a finding.
    expect(scheme.issueTypes[2]).toMatchObject({ id: "999", missing: true });
    expect(scheme.projects).toEqual([{ projectId: "10000", projectKey: "OBS", projectName: "Observatory" }]);
  });

  test("attaches the issue-type -> screen-scheme layer when the screen snapshot exists", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadIssueTypes.mockResolvedValue([{ id: "1", name: "Bug", hierarchyLevel: 0 }]);
    mocks.loadIssueTypeSchemes.mockResolvedValue([]);
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1" });
    mocks.loadIssueTypeScreenSchemes.mockResolvedValue([{ itssId: "9", name: "ITSS" }]);
    mocks.loadItssMappings.mockResolvedValue([
      { itssId: "9", issueTypeId: "1", screenSchemeId: "5", isDefault: false },
      { itssId: "9", issueTypeId: "default", screenSchemeId: "6", isDefault: true },
    ]);

    const result = await getIssueTypeInventory(ctx);

    expect(result.issueTypeScreenSchemes[0].mappings).toHaveLength(2);
    expect(result.issueTypeScreenSchemes[0].mappings[0].issueTypeName).toBe("Bug");
    expect(result.issueTypeScreenSchemes[0].mappings[1].issueTypeName).toBe("All unmapped types");
  });

  test("a screen-snapshot read failure does not take the tab down", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadIssueTypes.mockResolvedValue([]);
    mocks.loadIssueTypeSchemes.mockResolvedValue([]);
    mocks.readScreenSnapshotMeta.mockRejectedValueOnce(new Error("screen meta gone"));

    const result = await getIssueTypeInventory(ctx);

    expect(result.neverBuilt).toBe(false);
    expect(result.issueTypeScreenSchemes).toEqual([]);
  });
});

describe("buildIssueTypeInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("queues a build when nothing is running", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.readAdminConfig?.mockResolvedValue?.({ readOnlyMode: false });

    const result = await buildIssueTypeInventory(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueIssueTypeSnapshotBuild).toHaveBeenCalledWith("test-install");
  });

  test("refuses while a live build is running", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isIssueTypeBuildStale.mockReturnValue(false);

    const result = await buildIssueTypeInventory(ctx);

    expect(result).toMatchObject({ queued: false, reason: "already-building" });
    expect(mocks.queueIssueTypeSnapshotBuild).not.toHaveBeenCalled();
  });

  test("rebuilds over a wedged build rather than being blocked by it", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isIssueTypeBuildStale.mockReturnValue(true);

    const result = await buildIssueTypeInventory(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueIssueTypeSnapshotBuild).toHaveBeenCalled();
  });
});

// Per-type issue counts, and the tri-state that makes them safe to read. Zero is what makes
// a type look safe to delete, so it is only ever asserted when a crawl actually completed.
describe("getIssueTypeInventory — usage measurement", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x", accountId: "acc-1" } };

  const ready = () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "t1",
      totalTypes: 2,
      totalSchemes: 1,
      refreshedAt: "2026-09-11T00:00:00.000Z",
    });
    mocks.loadIssueTypes.mockResolvedValue([
      { id: "10001", name: "Bug", hierarchyLevel: 0 },
      { id: "10002", name: "Legacy", hierarchyLevel: 0 },
    ]);
    mocks.loadIssueTypeSchemes.mockResolvedValue([]);
    mocks.loadIssueTypeSchemeItems.mockResolvedValue([]);
    mocks.loadIssueTypeSchemeProjects.mockResolvedValue([]);
    mocks.loadIssueTypeGovernanceSummary.mockResolvedValue({});
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);
  };

  test("attaches real counts once a crawl has completed", async () => {
    ready();
    mocks.readIssueScanMeta.mockResolvedValue({ state: "ready", completedAt: "2026-09-10T00:00:00.000Z" });
    mocks.loadIssueTypeTotals.mockResolvedValue([
      { issueTypeId: "10001", issueTypeName: "Bug", issueCount: 4820, projectCount: 12 },
    ]);

    const result = await getIssueTypeInventory({ payload: {}, ...ctx });

    expect(result.usage.measurement).toBe("measured");
    expect(result.issueTypes.find((t) => t.id === "10001")).toMatchObject({ issueCount: 4820, usedInProjects: 12 });
    // The other half of the claim: a completed crawl that found none is a REAL zero.
    expect(result.issueTypes.find((t) => t.id === "10002").issueCount).toBe(0);
  });

  test("reports not-measured rather than zero when no crawl has run", async () => {
    ready();
    mocks.readIssueScanMeta.mockResolvedValue(null);
    mocks.loadIssueTypeTotals.mockResolvedValue([]);

    const result = await getIssueTypeInventory({ payload: {}, ...ctx });

    expect(result.usage.measurement).toBe("not-measured");
    // Null, not 0. A zero here is the premise of a deletion nobody has evidence for.
    for (const t of result.issueTypes) expect(t.issueCount).toBeNull();
  });

  test("calls a half-finished crawl partial, so a missing type reads as not-reached", async () => {
    ready();
    mocks.readIssueScanMeta.mockResolvedValue({ state: "building" });
    mocks.loadIssueTypeTotals.mockResolvedValue([
      { issueTypeId: "10001", issueTypeName: "Bug", issueCount: 40, projectCount: 1 },
    ]);

    const result = await getIssueTypeInventory({ payload: {}, ...ctx });

    expect(result.usage.measurement).toBe("partial");
    expect(result.issueTypes.find((t) => t.id === "10001").issueCount).toBe(40);
    // Not counted yet is not counted as none.
    expect(result.issueTypes.find((t) => t.id === "10002").issueCount).toBeNull();
  });

  test("a failed count is reported as failed, not as zero", async () => {
    ready();
    mocks.readIssueScanMeta.mockResolvedValue({ state: "ready" });
    mocks.loadIssueTypeTotals.mockRejectedValueOnce(new Error("SQL exploded"));

    const result = await getIssueTypeInventory({ payload: {}, ...ctx });

    expect(result.usage.measurement).toBe("measurement-failed");
    for (const t of result.issueTypes) expect(t.issueCount).toBeNull();
  });

  test("carries the counts onto the hierarchy view as well as the flat catalogue", async () => {
    ready();
    mocks.readIssueScanMeta.mockResolvedValue({ state: "ready" });
    mocks.loadIssueTypeTotals.mockResolvedValue([
      { issueTypeId: "10001", issueTypeName: "Bug", issueCount: 7, projectCount: 1 },
    ]);

    const result = await getIssueTypeInventory({ payload: {}, ...ctx });

    const level = result.hierarchy.find((h) => h.level === 0);
    expect(level.types.find((t) => t.id === "10001").issueCount).toBe(7);
  });
});
