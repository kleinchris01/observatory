import { describe, test, expect, beforeEach } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, manyFieldIds, snapshotField, ctxWithAccount } from "./test-harness.js";
import { __RAW_ADMIN_ONLY_FUNCTIONS, SHARED_RESOLVER_FUNCTIONS } from "../resolvers.js";

const { saveReportDefinition, startProjectUsageReportJob } = __RAW_ADMIN_ONLY_FUNCTIONS;
const {
  getProjectsView,
  getProjectUsageJobs,
  refreshRecentProjectUsage,
  cancelProjectUsageJob,
  restartProjectUsageJob,
  resumeProjectUsageJob,
  restoreProjectUsageCache,
  getSavedReports,
  deleteReportDefinition,
  getProjectUsageReport,
  getProjectUsageReportJob,
} = { ...SHARED_RESOLVER_FUNCTIONS, ...__RAW_ADMIN_ONLY_FUNCTIONS };

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

describe("saveReportDefinition field count validation", () => {
  test("still rejects an empty fieldIds array", async () => {
    await expect(saveReportDefinition({ payload: { name: "Test", fieldIds: [] }, context: {} })).rejects.toThrow(
      /fieldIds must contain at least 1 element/,
    );
  });

  test("no longer rejects more than 100 fieldIds", async () => {
    try {
      await saveReportDefinition({ payload: { name: "Test", fieldIds: manyFieldIds(150) }, context: {} });
    } catch (err) {
      expect(err.message).not.toMatch(/between 1 and 100/);
    }
  });
});

describe("startProjectUsageReportJob field count validation", () => {
  test("still rejects an empty fieldIds array", async () => {
    await expect(startProjectUsageReportJob({ payload: { fieldIds: [] }, context: {} })).rejects.toThrow(
      /fieldIds must contain at least 1 element/,
    );
  });

  test("no longer rejects more than 200 fieldIds", async () => {
    try {
      await startProjectUsageReportJob({ payload: { fieldIds: manyFieldIds(250) }, context: {} });
    } catch (err) {
      expect(err.message).not.toMatch(/between 1 and 200/);
    }
  });
});

// ---------------------------------------------------------------------------
// getProjectsView
// ---------------------------------------------------------------------------
describe("getProjectsView", () => {
  test("returns an empty shape when no snapshot has completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    const result = await getProjectsView({ payload: {}, context: {} });
    expect(result.projects).toEqual([]);
    expect(result.selectedProject).toBeNull();
  });

  test("returns an empty shape (with issue-scan status) when there are no projects at all", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.listSnapshotProjects.mockResolvedValue([]);
    mocks.readIssueScanMeta.mockResolvedValue({ state: "ready", totalIssues: 100, processedIssues: 100 });
    const result = await getProjectsView({ payload: {}, context: {} });
    expect(result.projects).toEqual([]);
    expect(result.issueScan.state).toBe("ready");
  });

  test("defaults to the first project when none is explicitly selected", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha" },
      { projectId: "20", projectKey: "XYZ", projectName: "Zulu" },
    ]);
    mocks.readIssueScanMeta.mockResolvedValue(null);
    mocks.loadSnapshotProjectFields.mockResolvedValue({ rows: [], total: 0 });

    const result = await getProjectsView({ payload: {}, context: {} });

    expect(result.selectedProject.projectId).toBe("10");
  });

  test("selects the requested project and returns its paginated fields", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha" },
      { projectId: "20", projectKey: "XYZ", projectName: "Zulu" },
    ]);
    mocks.readIssueScanMeta.mockResolvedValue(null);
    mocks.loadSnapshotProjectFields.mockResolvedValue({
      rows: [{ fieldId: "customfield_1", fieldName: "Story Points", fieldType: "number", customType: "number" }],
      total: 1,
    });

    const result = await getProjectsView({ payload: { projectId: "20" }, context: {} });

    expect(result.selectedProject.projectId).toBe("20");
    expect(result.fields).toHaveLength(1);
    expect(result.totalFields).toBe(1);
    expect(mocks.loadSnapshotProjectFields).toHaveBeenCalledWith(
      "test-install",
      1,
      "20",
      expect.objectContaining({ query: "", type: "all" }),
    );
  });

  test("validates page is a positive integer when provided", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    await expect(getProjectsView({ payload: { page: -1 }, context: {} })).rejects.toThrow(/page/);
  });

  test("never returns a project the caller lacks Browse Projects permission on", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha" },
      { projectId: "20", projectKey: "SECRET", projectName: "Confidential Project" },
    ]);
    mocks.readIssueScanMeta.mockResolvedValue(null);
    mocks.loadSnapshotProjectFields.mockResolvedValue({ rows: [], total: 0 });
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["10"])); // only Alpha is browsable

    const result = await getProjectsView({ payload: {}, context: ctxWithAccount() });

    // objectContaining, because the shape now also carries uniqueIssueCount. This test is
    // about which projects survive the permission filter, not about their field set.
    expect(result.projects).toEqual([
      expect.objectContaining({ projectId: "10", projectKey: "ABC", projectName: "Alpha" }),
    ]);
    expect(result.projects.some((p) => p.projectKey === "SECRET")).toBe(false);
  });

  test("cannot bypass the filter by requesting a hidden project's id directly", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha" },
      { projectId: "20", projectKey: "SECRET", projectName: "Confidential Project" },
    ]);
    mocks.readIssueScanMeta.mockResolvedValue(null);
    mocks.loadSnapshotProjectFields.mockResolvedValue({ rows: [], total: 0 });
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["10"]));

    // Explicitly ask for the hidden project by id -- should fall back to the
    // first BROWSABLE project instead of honoring the direct request.
    const result = await getProjectsView({ payload: { projectId: "20" }, context: ctxWithAccount() });

    expect(result.selectedProject?.projectId).not.toBe("20");
    expect(result.selectedProject?.projectId).toBe("10");
  });
});

describe("getProjectUsageJobs", () => {
  test("shapes each job with a computed percentComplete from processed/estimated issue counts", async () => {
    mocks.listFieldSummaries.mockResolvedValue([
      { fieldId: "customfield_1", summaryStatus: "building", processedIssueCount: 50, estimatedIssueTotal: 200 },
      { fieldId: "customfield_2", summaryStatus: "ready", processedIssueCount: 0, estimatedIssueTotal: 0 },
    ]);
    const result = await getProjectUsageJobs({ context: {} });
    expect(result.jobs[0].percentComplete).toBe(25);
    // ready with no estimate still reports 100%, not 0%
    expect(result.jobs[1].percentComplete).toBe(100);
  });
});

describe("refreshRecentProjectUsage", () => {
  test("throws when no snapshot has completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    await expect(refreshRecentProjectUsage({ payload: {}, context: {} })).rejects.toThrow(/No completed snapshot/);
  });

  test("clamps hours and maxIssues into their allowed ranges", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.collectRecentFieldProjectCandidates.mockResolvedValue({ fields: [], scannedIssues: 0 });
    const result = await refreshRecentProjectUsage({ payload: { hours: 9999, maxIssues: 1 }, context: {} });
    expect(mocks.collectRecentFieldProjectCandidates).toHaveBeenCalledWith(168, 50); // clamped to max 168h, min 50 issues
    expect(result.windowHours).toBe(168);
  });

  test("queues a full rebuild for a field with no existing ready summary", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.collectRecentFieldProjectCandidates.mockResolvedValue({
      fields: [{ fieldId: "customfield_1", projectKeys: ["ABC"] }],
      scannedIssues: 5,
    });
    mocks.listFieldSummaries.mockResolvedValue([]); // no existing summary
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1", totalIssueCount: 10 }));
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.queueFieldSummaryContinuationWithRetry.mockResolvedValue({ queued: true });

    const result = await refreshRecentProjectUsage({ payload: {}, context: {} });

    expect(result.queuedCount).toBe(1);
    expect(result.fullRebuildCount).toBe(1);
  });

  test("queues an incremental delta refresh for a field with an existing ready summary", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.collectRecentFieldProjectCandidates.mockResolvedValue({
      fields: [{ fieldId: "customfield_1", projectKeys: ["ABC"] }],
      scannedIssues: 5,
    });
    mocks.listFieldSummaries.mockResolvedValue([{ fieldId: "customfield_1", summaryStatus: "ready" }]);
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1" }));
    mocks.queueFieldUsageDeltaRefreshWithRetry.mockResolvedValue({ queued: true });

    const result = await refreshRecentProjectUsage({ payload: {}, context: {} });

    expect(result.queuedCount).toBe(1);
    expect(result.fullRebuildCount).toBe(0);
    expect(mocks.replaceFieldSummary).toHaveBeenCalledWith(
      "test-install",
      "customfield_1",
      expect.objectContaining({ summaryStatus: "queued" }),
    );
  });

  test("marks a field deferred when the incremental refresh queue push fails", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.collectRecentFieldProjectCandidates.mockResolvedValue({
      fields: [{ fieldId: "customfield_1", projectKeys: ["ABC"] }],
      scannedIssues: 5,
    });
    mocks.listFieldSummaries.mockResolvedValue([{ fieldId: "customfield_1", summaryStatus: "ready" }]);
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1" }));
    mocks.queueFieldUsageDeltaRefreshWithRetry.mockResolvedValue({ queued: false, attempts: 3 });

    const result = await refreshRecentProjectUsage({ payload: {}, context: {} });

    expect(result.queuedCount).toBe(0);
    expect(mocks.replaceFieldSummary).toHaveBeenLastCalledWith(
      "test-install",
      "customfield_1",
      expect.objectContaining({ summaryStatus: "deferred" }),
    );
  });
});

describe("cancelProjectUsageJob", () => {
  test("requires a fieldId", async () => {
    await expect(cancelProjectUsageJob({ payload: {}, context: {} })).rejects.toThrow(/fieldId/);
  });

  test("reports not-found when there's no summary for the field", async () => {
    mocks.loadFieldSummary.mockResolvedValue(null);
    const result = await cancelProjectUsageJob({ payload: { fieldId: "customfield_1" }, context: {} });
    expect(result).toEqual({ cancelled: false, reason: "not-found" });
  });

  test("marks the job cancelled", async () => {
    mocks.loadFieldSummary.mockResolvedValue({ summaryStatus: "building", progressLog: [] });
    const result = await cancelProjectUsageJob({ payload: { fieldId: "customfield_1" }, context: {} });
    expect(result).toEqual({ cancelled: true });
    expect(mocks.replaceFieldSummary).toHaveBeenCalledWith(
      "test-install",
      "customfield_1",
      expect.objectContaining({ summaryStatus: "cancelled" }),
    );
  });
});

describe("restartProjectUsageJob", () => {
  test("requires a fieldId", async () => {
    await expect(restartProjectUsageJob({ payload: {}, context: {} })).rejects.toThrow(/fieldId/);
  });

  test("throws when no snapshot has completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    await expect(restartProjectUsageJob({ payload: { fieldId: "customfield_1" }, context: {} })).rejects.toThrow(
      /No completed snapshot/,
    );
  });

  test("throws when the field isn't in the snapshot", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotField.mockResolvedValue(null);
    await expect(restartProjectUsageJob({ payload: { fieldId: "customfield_missing" }, context: {} })).rejects.toThrow(
      /Field not found/,
    );
  });

  test("wipes existing usage rows and starts a fresh job from zero", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1" }));

    const result = await restartProjectUsageJob({ payload: { fieldId: "customfield_1" }, context: {} });

    expect(result).toEqual({ queued: true, fieldId: "customfield_1" });
    expect(mocks.replaceSnapshotProjectUsageForField).toHaveBeenCalledWith("test-install", 1, "customfield_1", []);
    expect(mocks.replaceFieldSummary).toHaveBeenCalledWith(
      "test-install",
      "customfield_1",
      expect.objectContaining({ summaryStatus: "queued", processedIssueCount: 0 }),
    );
    expect(mocks.processFieldSummaryChunk).toHaveBeenCalledWith(
      "test-install",
      1,
      expect.objectContaining({ id: "customfield_1" }),
      expect.any(String),
      0,
      null,
      1,
    );
  });
});

describe("resumeProjectUsageJob", () => {
  test("requires a fieldId", async () => {
    await expect(resumeProjectUsageJob({ payload: {}, context: {} })).rejects.toThrow(/fieldId/);
  });

  test("throws when no snapshot has completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    await expect(resumeProjectUsageJob({ payload: { fieldId: "customfield_1" }, context: {} })).rejects.toThrow(
      /No completed snapshot/,
    );
  });

  test("throws when there's no existing job state to resume", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotField.mockResolvedValue(snapshotField());
    mocks.loadFieldSummary.mockResolvedValue(null);
    await expect(resumeProjectUsageJob({ payload: { fieldId: "customfield_1" }, context: {} })).rejects.toThrow(
      /No existing project-usage job state/,
    );
  });

  test("refuses to resume a job that's already running", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotField.mockResolvedValue(snapshotField());
    mocks.loadFieldSummary.mockResolvedValue({ summaryStatus: "building" });
    const result = await resumeProjectUsageJob({ payload: { fieldId: "customfield_1" }, context: {} });
    expect(result).toEqual({ queued: false, fieldId: "customfield_1", reason: "already-running" });
  });

  test("resumes from the last checkpoint (processedIssueCount), not from zero", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1" }));
    mocks.loadFieldSummary.mockResolvedValue({
      summaryStatus: "failed",
      processedIssueCount: 340,
      nextPageToken: "page-token-abc",
      progressLog: [],
    });

    const result = await resumeProjectUsageJob({ payload: { fieldId: "customfield_1" }, context: {} });

    expect(result).toEqual({ queued: true, fieldId: "customfield_1", resumedFrom: 340 });
    expect(mocks.processFieldSummaryChunk).toHaveBeenCalledWith(
      "test-install",
      1,
      expect.objectContaining({ id: "customfield_1" }),
      expect.any(String),
      340,
      "page-token-abc",
      1,
    );
  });
});

describe("restoreProjectUsageCache", () => {
  test("reports no-snapshot when nothing has completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    const result = await restoreProjectUsageCache({ context: {} });
    expect(result).toEqual({ started: false, reason: "no-snapshot" });
    expect(mocks.queueProjectUsageRestore).not.toHaveBeenCalled();
  });

  test("queues a full restore from the latest snapshot version", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 7 });
    const result = await restoreProjectUsageCache({ context: {} });
    expect(result).toEqual({ started: true, version: 7 });
    expect(mocks.queueProjectUsageRestore).toHaveBeenCalledWith("test-install", 7);
  });
});

// ---------------------------------------------------------------------------
// Reports -- getSavedReports/deleteReportDefinition extend the existing
// saveReportDefinition/startProjectUsageReportJob coverage from the field-cap
// fix. getProjectUsageReport is the most complex read path in the app: a
// 3-tier data fallback chain plus 3 independent auto-queue caps.
// ---------------------------------------------------------------------------
describe("getSavedReports", () => {
  test("returns the installation's saved report list", async () => {
    mocks.listSavedReports.mockResolvedValue([{ reportId: "r1", name: "My Report", fieldIds: ["customfield_1"] }]);
    const result = await getSavedReports({ context: {} });
    expect(result.reports).toHaveLength(1);
    expect(mocks.listSavedReports).toHaveBeenCalledWith("test-install");
  });
});

describe("deleteReportDefinition", () => {
  test("requires a reportId", async () => {
    await expect(deleteReportDefinition({ payload: {}, context: {} })).rejects.toThrow(/reportId/);
  });

  test("deletes and returns the refreshed list", async () => {
    mocks.listSavedReports.mockResolvedValue([]);
    const result = await deleteReportDefinition({ payload: { reportId: "r1" }, context: {} });
    expect(mocks.deleteSavedReport).toHaveBeenCalledWith("test-install", "r1");
    expect(result.reports).toEqual([]);
  });
});

describe("getProjectUsageReport", () => {
  test("returns an empty shape without touching storage when fieldIds is empty", async () => {
    const result = await getProjectUsageReport({ payload: { fieldIds: [] }, context: {} });
    expect(result).toEqual({ fields: [], projects: [] });
    expect(mocks.ensureProjectStoreReady).toHaveBeenCalled(); // still runs before the shortcut
    expect(mocks.readSnapshotMeta).not.toHaveBeenCalled();
  });

  test("throws when no snapshot has completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    await expect(getProjectUsageReport({ payload: { fieldIds: ["customfield_1"] }, context: {} })).rejects.toThrow(
      /No completed snapshot/,
    );
  });

  test("skips a field that's missing from the snapshot entirely rather than erroring the whole report", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.loadSnapshotField.mockResolvedValue(null);
    mocks.loadAllSnapshotProjectUsage.mockResolvedValue([]);
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.getDistinctIssueCountForFields.mockResolvedValue(0);

    const result = await getProjectUsageReport({ payload: { fieldIds: ["customfield_missing"] }, context: {} });

    expect(result.fields).toEqual([]);
  });

  test("uses current-version project usage when present", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1" }));
    mocks.loadAllSnapshotProjectUsage.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 5 },
    ]);
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.getDistinctIssueCountForFields.mockResolvedValue(5);

    const result = await getProjectUsageReport({ payload: { fieldIds: ["customfield_1"] }, context: {} });

    expect(result.fields[0].projects).toHaveLength(1);
    expect(mocks.loadAnySnapshotProjectUsage).not.toHaveBeenCalled(); // didn't need the fallback
  });

  test("narrows the matrix to a project scope, keeping scoped projects with no usage as zero columns", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1" }));
    mocks.loadAllSnapshotProjectUsage.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 5 },
      { projectId: "99", projectKey: "ZZZ", projectName: "Zeta", issueCount: 40 }, // out of scope
    ]);
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.getDistinctIssueCountForFields.mockResolvedValue(5);
    // Scope is {10, 11}; project 11 has no usage row but must still be a column.
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha" },
      { projectId: "11", projectKey: "BBB", projectName: "Bravo" },
      { projectId: "99", projectKey: "ZZZ", projectName: "Zeta" },
    ]);

    const result = await getProjectUsageReport({
      payload: { fieldIds: ["customfield_1"], projectIds: ["10", "11"] },
      context: {},
    });

    expect(result.projects.map((p) => p.projectId).sort()).toEqual(["10", "11"]);
    expect(result.fields[0].projects.map((p) => p.projectId)).toEqual(["10"]);
    // The per-field total is recomputed from what is left, not the site-wide sum.
    expect(result.fields[0].totalIssueCount).toBe(5);
    expect(result.fields[0].activeProjectCount).toBe(1);
  });

  test("falls back to any-version usage when the current version has none", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 2 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1" }));
    mocks.loadAllSnapshotProjectUsage.mockResolvedValue([]);
    mocks.loadAnySnapshotProjectUsage.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 3 },
    ]);
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.getDistinctIssueCountForFields.mockResolvedValue(3);

    const result = await getProjectUsageReport({ payload: { fieldIds: ["customfield_1"] }, context: {} });

    expect(mocks.loadAnySnapshotProjectUsage).toHaveBeenCalledWith("test-install", "customfield_1");
    expect(result.fields[0].projects).toHaveLength(1);
  });

  test("falls back to the field summary's cached activeProjects as a last resort", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 2 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1" }));
    mocks.loadAllSnapshotProjectUsage.mockResolvedValue([]);
    mocks.loadAnySnapshotProjectUsage.mockResolvedValue([]);
    mocks.loadFieldSummary.mockResolvedValue({
      activeProjects: [{ projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 2 }],
    });
    mocks.getDistinctIssueCountForFields.mockResolvedValue(2);

    const result = await getProjectUsageReport({ payload: { fieldIds: ["customfield_1"] }, context: {} });

    expect(result.fields[0].projects).toHaveLength(1);
    expect(result.fields[0].projects[0].projectKey).toBe("ABC");
  });

  test("marks a field pending (already-running) instead of re-queueing when its job is already queued/building", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1", totalIssueCount: 50 }));
    mocks.loadAllSnapshotProjectUsage.mockResolvedValue([]);
    mocks.loadAnySnapshotProjectUsage.mockResolvedValue([]);
    mocks.loadFieldSummary.mockResolvedValue({ summaryStatus: "building" });
    mocks.getDistinctIssueCountForFields.mockResolvedValue(0);

    const result = await getProjectUsageReport({ payload: { fieldIds: ["customfield_1"] }, context: {} });

    expect(result.pendingFields).toEqual([
      { fieldId: "customfield_1", fieldName: "Story Points", summaryStatus: "building", reason: "already-running" },
    ]);
    expect(mocks.replaceFieldSummary).not.toHaveBeenCalled(); // never touched ensureProjectUsageJobQueued's write path
  });

  test("auto-queues a missing field's project-usage job when under all caps", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.listFieldSummaries.mockResolvedValue([]); // no running jobs -> under every cap
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1", totalIssueCount: 50 }));
    mocks.loadAllSnapshotProjectUsage.mockResolvedValue([]);
    mocks.loadAnySnapshotProjectUsage.mockResolvedValue([]);
    mocks.loadFieldSummary.mockResolvedValue(null); // no summary at all -> not already-running
    mocks.queueFieldSummaryContinuationWithRetry.mockResolvedValue({ queued: true });
    mocks.getDistinctIssueCountForFields.mockResolvedValue(0);

    const result = await getProjectUsageReport({ payload: { fieldIds: ["customfield_1"] }, context: {} });

    expect(result.pendingFields).toEqual([
      { fieldId: "customfield_1", fieldName: "Story Points", summaryStatus: "queued", reason: "project-usage-missing" },
    ]);
  });

  test("defers a candidate once the active-job cap (3) is already reached", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    // 3 already-running summaries -> at MAX_ACTIVE_PROJECT_USAGE_JOBS
    mocks.listFieldSummaries.mockResolvedValue([
      { fieldId: "x1", summaryStatus: "building", totalIssueCount: 10 },
      { fieldId: "x2", summaryStatus: "building", totalIssueCount: 10 },
      { fieldId: "x3", summaryStatus: "building", totalIssueCount: 10 },
    ]);
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1", totalIssueCount: 50 }));
    mocks.loadAllSnapshotProjectUsage.mockResolvedValue([]);
    mocks.loadAnySnapshotProjectUsage.mockResolvedValue([]);
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.getDistinctIssueCountForFields.mockResolvedValue(0);

    const result = await getProjectUsageReport({ payload: { fieldIds: ["customfield_1"] }, context: {} });

    expect(result.pendingFields).toEqual([
      {
        fieldId: "customfield_1",
        fieldName: "Story Points",
        summaryStatus: "deferred",
        reason: "deferred-active-job-cap",
      },
    ]);
    // deferred candidates get recorded via ensureDeferredProjectUsageJobRecorded, not queued
    expect(mocks.queueFieldSummaryContinuationWithRetry).not.toHaveBeenCalled();
  });

  test("returns the deduped, sorted set of projects across all requested fields", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.loadSnapshotField.mockImplementation((_i, _v, fieldId) =>
      Promise.resolve(snapshotField({ id: fieldId, name: fieldId })),
    );
    mocks.loadAllSnapshotProjectUsage.mockImplementation((_i, _v, fieldId) =>
      Promise.resolve(
        fieldId === "customfield_1"
          ? [{ projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 1 }]
          : [
              { projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 1 },
              { projectId: "20", projectKey: "XYZ", projectName: "Zulu", issueCount: 1 },
            ],
      ),
    );
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.getDistinctIssueCountForFields.mockResolvedValue(2);

    const result = await getProjectUsageReport({
      payload: { fieldIds: ["customfield_1", "customfield_2"] },
      context: {},
    });

    expect(result.projects.map((p) => p.projectKey)).toEqual(["ABC", "XYZ"]); // deduped, sorted by key
  });

  test("never returns a project (top-level or per-field) the caller lacks Browse Projects permission on", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_1" }));
    mocks.loadAllSnapshotProjectUsage.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 1 },
      { projectId: "20", projectKey: "SECRET", projectName: "Confidential", issueCount: 1 },
    ]);
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.getDistinctIssueCountForFields.mockResolvedValue(2);
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["10"]));

    const result = await getProjectUsageReport({ payload: { fieldIds: ["customfield_1"] }, context: ctxWithAccount() });

    expect(result.projects.map((p) => p.projectKey)).toEqual(["ABC"]);
    expect(result.fields[0].projects.map((p) => p.projectKey)).toEqual(["ABC"]);
    expect(result.fields[0].activeProjectCount).toBe(1); // recomputed from the filtered set, not the original 2
  });
});

describe("getProjectUsageReportJob", () => {
  test("returns a null job when no jobId is given", async () => {
    const result = await getProjectUsageReportJob({ payload: {}, context: {} });
    expect(result).toEqual({ job: null });
    expect(mocks.loadReportJob).not.toHaveBeenCalled();
  });

  test("returns a null job when the jobId doesn't match anything stored", async () => {
    mocks.loadReportJob.mockResolvedValue(null);
    const result = await getProjectUsageReportJob({ payload: { jobId: "job-1" }, context: {} });
    expect(result).toEqual({ job: null });
  });

  test("computes percentComplete from processed/total fields", async () => {
    mocks.loadReportJob.mockResolvedValue({ jobId: "job-1", totalFields: 4, processedFields: 1 });
    const result = await getProjectUsageReportJob({ payload: { jobId: "job-1" }, context: {} });
    expect(result.job.percentComplete).toBe(25);
  });

  test("reports 0% for a job with no totalFields yet, rather than dividing by zero", async () => {
    mocks.loadReportJob.mockResolvedValue({ jobId: "job-1", totalFields: 0, processedFields: 0 });
    const result = await getProjectUsageReportJob({ payload: { jobId: "job-1" }, context: {} });
    expect(result.job.percentComplete).toBe(0);
  });

  test("filters a stored report's result using the CURRENT reader's permissions, not the original admin's", async () => {
    // An admin could have built this job (they're always allowed to start one),
    // but a different, less-privileged person reading it later must not see
    // projects that admin could see but they themselves cannot.
    mocks.loadReportJob.mockResolvedValue({
      jobId: "job-1",
      totalFields: 1,
      processedFields: 1,
      result: {
        fields: [
          {
            fieldId: "customfield_1",
            fieldName: "Story Points",
            activeProjectCount: 2,
            projects: [
              { projectId: "10", projectKey: "ABC", projectName: "Alpha" },
              { projectId: "20", projectKey: "SECRET", projectName: "Confidential" },
            ],
          },
        ],
        projects: [
          { projectId: "10", projectKey: "ABC", projectName: "Alpha" },
          { projectId: "20", projectKey: "SECRET", projectName: "Confidential" },
        ],
        pendingFields: [],
        uniqueIssueCount: 2,
      },
    });
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["10"])); // this reader can only see Alpha

    const result = await getProjectUsageReportJob({
      payload: { jobId: "job-1" },
      context: ctxWithAccount("less-privileged-user"),
    });

    expect(result.job.result.projects.map((p) => p.projectKey)).toEqual(["ABC"]);
    expect(result.job.result.fields[0].projects.map((p) => p.projectKey)).toEqual(["ABC"]);
    expect(result.job.result.fields[0].activeProjectCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getProjectsView — workflow correlation
//
// Two projects on the same workflow scheme are meant to run the same process, so
// divergent field usage between them is a standardization signal. Surfacing it means
// the Projects tab has to carry both, without ever letting the workflow snapshot --
// which is versioned separately and may not exist -- break the field view.
// ---------------------------------------------------------------------------
describe("getProjectsView workflow correlation", () => {
  function baseProjects() {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha" },
      { projectId: "20", projectKey: "XYZ", projectName: "Zulu" },
    ]);
    mocks.readIssueScanMeta.mockResolvedValue(null);
    mocks.loadSnapshotProjectFields.mockResolvedValue({ rows: [], total: 0 });
  }

  beforeEach(() => {
    baseProjects();
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "wf-1", refreshedAt: "2026-07-31T10:00:00Z" });
    mocks.loadWorkflowSchemeForProject.mockResolvedValue({
      schemeId: "s1",
      name: "ADVEV Standard",
      description: "Engineering default",
    });
    mocks.loadWorkflowSchemeProjects.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha" },
      { projectId: "20", projectKey: "XYZ", projectName: "Zulu" },
      { projectId: "30", projectKey: "QRS", projectName: "Quebec" },
    ]);
  });

  test("returns the scheme governing the selected project", async () => {
    const result = await getProjectsView({ payload: {}, context: {} });

    expect(result.workflowScheme.name).toBe("ADVEV Standard");
    expect(result.workflowScheme.schemeId).toBe("s1");
  });

  // "Shared with N" must count only projects the viewer can browse, or it discloses
  // that projects they cannot see exist.
  test("counts siblings from the viewer's browsable projects only", async () => {
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["10", "20"]));

    const result = await getProjectsView({ payload: {}, context: { accountId: "acct-1" } });

    expect(result.workflowScheme.sharedWithCount).toBe(1);
    expect(result.workflowScheme.siblingProjects.map((p) => p.projectKey)).toEqual(["XYZ"]);
  });

  test("excludes the selected project from its own sibling list", async () => {
    const result = await getProjectsView({ payload: { projectId: "10" }, context: {} });

    expect(result.workflowScheme.siblingProjects.some((p) => p.projectId === "10")).toBe(false);
  });

  test("reports zero when the scheme governs only this project", async () => {
    mocks.loadWorkflowSchemeProjects.mockResolvedValue([{ projectId: "10", projectKey: "ABC", projectName: "Alpha" }]);

    const result = await getProjectsView({ payload: {}, context: {} });

    expect(result.workflowScheme.sharedWithCount).toBe(0);
    expect(result.workflowScheme.siblingProjects).toEqual([]);
  });

  test("returns null when no workflow snapshot has been built", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue(null);

    const result = await getProjectsView({ payload: {}, context: {} });

    expect(result.workflowScheme).toBeNull();
    expect(mocks.loadWorkflowSchemeForProject).not.toHaveBeenCalled();
  });

  test("returns null when the project belongs to no scheme", async () => {
    mocks.loadWorkflowSchemeForProject.mockResolvedValue(null);

    const result = await getProjectsView({ payload: {}, context: {} });
    expect(result.workflowScheme).toBeNull();
  });

  // The field view is the reason anyone opened this tab.
  test("a workflow lookup failure never breaks the field view", async () => {
    mocks.loadWorkflowSchemeForProject.mockRejectedValue(new Error("workflow tables missing"));

    const result = await getProjectsView({ payload: {}, context: {} });

    expect(result.workflowScheme).toBeNull();
    expect(result.selectedProject.projectId).toBe("10");
    expect(result.projects).toHaveLength(2);
  });
});
