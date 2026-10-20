import { describe, test, expect, beforeEach } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, snapshotField } from "./test-harness.js";
import {
  SHARED_RESOLVER_FUNCTIONS,
  getAdminOverview,
  getSnapshotStatus,
  __RAW_ADMIN_ONLY_FUNCTIONS,
  getFirstRunState,
  setFirstRunState,
} from "../resolvers.js";

const { getHealthHistory } = __RAW_ADMIN_ONLY_FUNCTIONS;

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// getSnapshotStatus
// ---------------------------------------------------------------------------
describe("getSnapshotStatus", () => {
  // Polled every 8 seconds by the Scans tab during a build. It must stay one meta read: the
  // Overview it replaced loaded every pillar and wrote a health-history row on each call.
  test("returns the build status from the meta row alone", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({
      state: "building",
      startedAt: "2026-10-15T10:00:00Z",
      totalFields: 200,
      processedFields: 50,
      progressLog: Array.from({ length: 60 }, (_, i) => ({ msg: `step ${i}` })),
    });

    const result = await getSnapshotStatus({ context: {} });

    expect(result.snapshot).toMatchObject({ state: "building", totalFields: 200, processedFields: 50, percent: 25 });
    expect(result.snapshot.progressLog).toHaveLength(50);
    expect(mocks.loadSnapshotFields).not.toHaveBeenCalled();
    expect(mocks.countFieldSummariesByStatus).not.toHaveBeenCalled();
  });

  test("reports idle with no snapshot yet", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    const result = await getSnapshotStatus({ context: {} });
    expect(result.snapshot).toMatchObject({ state: "idle", percent: 0, lastError: null, progressLog: [] });
  });
});

// ---------------------------------------------------------------------------
// getAdminOverview
// ---------------------------------------------------------------------------
describe("getAdminOverview", () => {
  test("surfaces the job-status counts without loading the summaries", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", totalFields: 10, processedFields: 10 });
    mocks.countFieldSummariesByStatus.mockResolvedValue({
      counts: { queued: 0, building: 1, ready: 2, failed: 1, cancelled: 0, unbuilt: 0 },
      total: 4,
    });
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);

    const result = await getAdminOverview({ context: {} });

    expect(result.jobCounts).toEqual({ queued: 0, building: 1, ready: 2, failed: 1, cancelled: 0, unbuilt: 0 });
    expect(result.totalSummaries).toBe(4);
    // The point of the change: the landing page used to pull up to 5,000 rows, including two
    // LONGTEXT columns, to produce those six integers.
    expect(mocks.listFieldSummaries).not.toHaveBeenCalled();
  });

  test("still renders when the count query fails", async () => {
    // A failed aggregate must not blank the overview -- it degrades to zeroes, the same way
    // a failed summaries load used to degrade to an empty array.
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.countFieldSummariesByStatus.mockRejectedValueOnce(new Error("sql down"));
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);

    const result = await getAdminOverview({ context: {} });

    expect(result.jobCounts).toEqual({ queued: 0, building: 0, ready: 0, failed: 0, cancelled: 0, unbuilt: 0 });
    expect(result.totalSummaries).toBe(0);
  });

  test("computes findings summary from the latest snapshot when one exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);

    const result = await getAdminOverview({ context: {} });

    expect(result.findingsSummary).toEqual(
      expect.objectContaining({
        adminAttention: expect.any(Number),
        risky: expect.any(Number),
        cleanup: expect.any(Number),
        standardize: expect.any(Number),
      }),
    );
  });

  // The Overview promotes several specific reasons to their own cards now (mirroring how
  // filters and dashboards already split "no live owner" from "shared with everyone"
  // instead of lumping every reason into one number) -- each of those needs its own count,
  // not just the four coarse categories findingsSummary already carries.
  test("also returns a count per specific finding code, not just the four coarse categories", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    // No description, and used broadly enough to cross missing-description's threshold.
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField({ activeProjectCount: 6, totalIssueCount: 600 })]);

    const result = await getAdminOverview({ context: {} });

    expect(result.findingsByCode).toEqual(expect.objectContaining({ "missing-description": 1 }));
  });

  // ── Screens and automation reach the Overview ─────────────────────────────
  //
  // Both pillars were analysed and then withheld from the page that exists to surface
  // them: screens were never loaded at all, and automation was trimmed to three fields
  // before it left the resolver, so the findings list could not see a single one of the
  // counts the health score was being computed from.

  test("carries the screen governance summary into the payload and the score", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readScreenSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "v1",
      refreshedAt: "2026-08-13T00:00:00Z",
    });
    mocks.loadScreenGovernanceSummary.mockResolvedValue({
      totalScreens: 760,
      emptyScreens: 12,
      unresolvedScreens: 3,
      unreachedScreens: 40,
      totalOperations: 240,
      danglingOperations: 24,
      totalSchemes: 60,
      unusedSchemes: 7,
    });

    const result = await getAdminOverview({ context: {} });

    expect(result.screens.available).toBe(true);
    expect(result.screens.danglingOperations).toBe(24);
    const integrity = result.health.dimensions.find((d) => d.key === "screen-integrity");
    expect(integrity.available).toBe(true);
    expect(integrity.score).toBe(0); // 24/240 is the tolerance exactly
  });

  test("reports screens unavailable rather than failing the overview when no build exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);

    const result = await getAdminOverview({ context: {} });

    expect(result.screens.available).toBe(false);
    expect(mocks.loadScreenGovernanceSummary).not.toHaveBeenCalled();
    expect(result.health.dimensions.find((d) => d.key === "screen-hygiene").available).toBe(false);
  });

  // Same posture as buildWorkflowOverview: one optional pillar failing must not 500 an
  // overview that has four others to show.
  test("survives a screen summary that throws", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readScreenSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadScreenGovernanceSummary.mockRejectedValueOnce(new Error("Unknown SQL execution error"));

    const result = await getAdminOverview({ context: {} });

    expect(result.screens).toEqual({ available: false, state: "error" });
    expect(result.health).toBeDefined();
  });

  test("carries the people overview into the payload and the score", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readUserSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "u1",
      refreshedAt: "2026-09-01T00:00:00Z",
    });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.loadUserGovernanceSummary.mockResolvedValue({ totalUsers: 200, activeUsers: 180 });

    const result = await getAdminOverview({ context: {} });

    expect(result.users.available).toBe(true);
    expect(result.users.deactivatedUsers).toBe(20);
    const hygiene = result.health.dimensions.find((d) => d.key === "user-licence-hygiene");
    expect(hygiene.available).toBe(true);
  });

  test("reports people unavailable rather than failing the overview when no roster exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readUserSnapshotMeta.mockResolvedValue(null);

    const result = await getAdminOverview({ context: {} });

    expect(result.users.available).toBe(false);
    expect(result.health.dimensions.find((d) => d.key === "user-licence-hygiene").available).toBe(false);
  });

  test("carries the assets overview into the payload and the score", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readAssetSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "as1",
      assetsEnabled: true,
      refreshedAt: "2026-09-02T00:00:00Z",
    });
    mocks.loadAssetSchemas.mockResolvedValue([
      { id: "1", name: "Infra", objectTypeCount: 2, objectCount: 40 },
      { id: "2", name: "Empty", objectTypeCount: 0, objectCount: 0 },
    ]);
    mocks.loadAssetObjectTypes.mockResolvedValue([
      { id: "9", schemaId: "1", name: "Server", parentId: null, abstract: false },
    ]);
    mocks.loadAssetAttributes.mockResolvedValue([
      { id: "a", objectTypeId: "9", name: "OS", referenceObjectTypeId: null, system: false },
    ]);

    const result = await getAdminOverview({ context: {} });

    expect(result.assets.available).toBe(true);
    expect(result.assets.deadSchemaCount).toBe(1);
    expect(result.health.dimensions.find((d) => d.key === "asset-schema-hygiene").available).toBe(true);
  });

  test("reports assets not-applicable rather than failing the overview when Assets is off", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "unavailable", assetsEnabled: false });

    const result = await getAdminOverview({ context: {} });

    expect(result.assets.assetsEnabled).toBe(false);
    expect(result.health.dimensions.find((d) => d.key === "asset-reference-integrity").available).toBe(false);
  });

  test("passes the whole automation health summary through, not just the rule count", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readAutomationAnalysis.mockResolvedValue({
      refreshedAt: 123,
      estate: {
        health: {
          available: true,
          ruleCount: 1479,
          disabledCount: 604,
          credentialRuleCount: 3,
          externalHttpCount: 22,
          noActionCount: 8,
          selfTriggeringCount: 88,
        },
      },
    });

    const result = await getAdminOverview({ context: {} });

    // Every count the findings list needs, not the {available, refreshedAt, ruleCount}
    // triple this used to be flattened to.
    expect(result.automation).toEqual(
      expect.objectContaining({
        available: true,
        ruleCount: 1479,
        credentialRuleCount: 3,
        selfTriggeringCount: 88,
        externalHttpCount: 22,
        noActionCount: 8,
        disabledCount: 604,
        refreshedAt: 123,
      }),
    );
  });

  // The dashboard-building branch had never executed: every existing case either omitted
  // the snapshot version or asserted only on findingsSummary. These cover the project
  // shape analysis and the workflow roll-up that the Overview actually renders.
  test("builds project insights with distribution, not just leaders", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    mocks.listSnapshotProjects.mockResolvedValue([
      {
        projectId: "1",
        projectKey: "A",
        projectName: "Alpha",
        fieldCount: 4,
        totalIssueCount: 900,
        latestIssueUpdatedAt: new Date().toISOString(),
      },
      {
        projectId: "2",
        projectKey: "B",
        projectName: "Bravo",
        fieldCount: 6,
        totalIssueCount: 400,
        latestIssueUpdatedAt: new Date().toISOString(),
      },
      {
        projectId: "3",
        projectKey: "C",
        projectName: "Charlie",
        fieldCount: 40,
        totalIssueCount: 2,
        latestIssueUpdatedAt: new Date().toISOString(),
      },
      {
        projectId: "4",
        projectKey: "D",
        projectName: "Delta",
        fieldCount: 3,
        totalIssueCount: 0,
        latestIssueUpdatedAt: null,
      },
    ]);

    const result = await getAdminOverview({ context: {} });
    const projects = result.dashboard.projects;

    expect(projects.totalProjects).toBe(4);
    expect(projects.totalFieldFills).toBe(1302);
    expect(projects.medianFieldCount).toBeGreaterThan(0);
    // Fields configured but nothing ever filed -- abandoned or never started.
    expect(projects.unusedProjects.map((p) => p.projectKey)).toContain("D");
    // Far above the norm while carrying almost no work.
    expect(projects.overConfigured.map((p) => p.projectKey)).toContain("C");
  });

  // ── Field fills are not issues ────────────────────────────────────────────
  //
  // snapshot_project_usage holds one row per field x project, so SUM(issue_count) counts
  // an issue once for every populated field on it. The Overview presented that sum as
  // "Issues covered", overstating a 317k-issue site as 19.7 million.

  test("reports field fills and distinct issues as separate figures", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    mocks.listSnapshotProjects.mockResolvedValue([
      {
        projectId: "1",
        projectKey: "A",
        projectName: "Alpha",
        fieldCount: 90,
        totalIssueCount: 90000,
        latestIssueUpdatedAt: null,
      },
      {
        projectId: "2",
        projectKey: "B",
        projectName: "Bravo",
        fieldCount: 40,
        totalIssueCount: 20000,
        latestIssueUpdatedAt: null,
      },
    ]);
    mocks.loadIssueScanProjectTotals.mockResolvedValue([
      { projectId: "1", projectKey: "A", projectName: "Alpha", uniqueIssueCount: 1000 },
      { projectId: "2", projectKey: "B", projectName: "Bravo", uniqueIssueCount: 500 },
    ]);

    const projects = (await getAdminOverview({ context: {} })).dashboard.projects;

    expect(projects.hasUniqueCounts).toBe(true);
    expect(projects.totalUniqueIssues).toBe(1500);
    expect(projects.totalFieldFills).toBe(110000);
    // The old key is gone deliberately: "totalIssues" is the name that let a fills figure
    // be rendered as an issue count without anyone noticing.
    expect(projects.totalIssues).toBeUndefined();
  });

  test("marks issue counts unmeasured rather than substituting fills", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    mocks.listSnapshotProjects.mockResolvedValue([
      {
        projectId: "1",
        projectKey: "A",
        projectName: "Alpha",
        fieldCount: 90,
        totalIssueCount: 90000,
        latestIssueUpdatedAt: null,
      },
    ]);
    mocks.loadIssueScanProjectTotals.mockResolvedValue([]);

    const projects = (await getAdminOverview({ context: {} })).dashboard.projects;

    expect(projects.hasUniqueCounts).toBe(false);
    expect(projects.totalUniqueIssues).toBeNull();
    expect(projects.totalFieldFills).toBe(90000);
  });

  test("ranks the volume list by distinct issues once they are measured", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    // BIG has more fills but fewer issues -- it simply has more fields configured. Ranking
    // on fills puts the wrong project at the top of a list titled "highest issue volume".
    mocks.listSnapshotProjects.mockResolvedValue([
      {
        projectId: "1",
        projectKey: "BIG",
        projectName: "Big",
        fieldCount: 200,
        totalIssueCount: 200000,
        latestIssueUpdatedAt: null,
      },
      {
        projectId: "2",
        projectKey: "BUSY",
        projectName: "Busy",
        fieldCount: 10,
        totalIssueCount: 50000,
        latestIssueUpdatedAt: null,
      },
    ]);
    mocks.loadIssueScanProjectTotals.mockResolvedValue([
      { projectId: "1", projectKey: "BIG", projectName: "Big", uniqueIssueCount: 1000 },
      { projectId: "2", projectKey: "BUSY", projectName: "Busy", uniqueIssueCount: 5000 },
    ]);

    const projects = (await getAdminOverview({ context: {} })).dashboard.projects;

    expect(projects.topByIssueVolume.map((p) => p.projectKey)).toEqual(["BUSY", "BIG"]);
    expect(projects.topByIssueVolume[0].volume).toBe(5000);
  });

  test("treats a project the scan never reached as unmeasured, not as zero", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    mocks.listSnapshotProjects.mockResolvedValue([
      {
        projectId: "1",
        projectKey: "SEEN",
        projectName: "Seen",
        fieldCount: 10,
        totalIssueCount: 5000,
        latestIssueUpdatedAt: null,
      },
      {
        projectId: "2",
        projectKey: "MISSED",
        projectName: "Missed",
        fieldCount: 10,
        totalIssueCount: 4000,
        latestIssueUpdatedAt: null,
      },
    ]);
    mocks.loadIssueScanProjectTotals.mockResolvedValue([
      { projectId: "1", projectKey: "SEEN", projectName: "Seen", uniqueIssueCount: 300 },
    ]);

    const projects = (await getAdminOverview({ context: {} })).dashboard.projects;

    const missed = projects.topByIssueVolume.find((p) => p.projectKey === "MISSED");
    expect(missed.uniqueIssueCount).toBeNull();
    // Excluded from the site total rather than contributing a fabricated zero.
    expect(projects.totalUniqueIssues).toBe(300);
  });

  test("survives the project-totals lookup failing", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    mocks.listSnapshotProjects.mockResolvedValue([
      {
        projectId: "1",
        projectKey: "A",
        projectName: "Alpha",
        fieldCount: 5,
        totalIssueCount: 100,
        latestIssueUpdatedAt: null,
      },
    ]);
    mocks.loadIssueScanProjectTotals.mockRejectedValue(new Error("SQL unavailable"));

    const projects = (await getAdminOverview({ context: {} })).dashboard.projects;

    // Degrades to unmeasured. A failed lookup must not silently promote fills to issues.
    expect(projects.hasUniqueCounts).toBe(false);
    expect(projects.totalFieldFills).toBe(100);
  });

  test("flags projects with no activity in over six months", async () => {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    mocks.listSnapshotProjects.mockResolvedValue([
      {
        projectId: "1",
        projectKey: "STALE",
        projectName: "Stale",
        fieldCount: 5,
        totalIssueCount: 100,
        latestIssueUpdatedAt: old,
      },
      {
        projectId: "2",
        projectKey: "FRESH",
        projectName: "Fresh",
        fieldCount: 5,
        totalIssueCount: 100,
        latestIssueUpdatedAt: new Date().toISOString(),
      },
    ]);

    const result = await getAdminOverview({ context: {} });

    expect(result.dashboard.projects.staleProjects.map((p) => p.projectKey)).toEqual(["STALE"]);
  });

  test("includes a workflow roll-up when a workflow snapshot exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({
      version: "v1",
      state: "ready",
      refreshedAt: "2026-08-03T00:00:00Z",
    });
    mocks.loadWorkflowSchemes.mockResolvedValue([
      { id: "s1", name: "Shared", projectCount: 4 },
      { id: "s2", name: "Bespoke", projectCount: 1 },
    ]);
    mocks.loadStatusesCatalog.mockResolvedValue([
      { statusId: "1", name: "Backlog", statusCategory: "To Do" },
      { statusId: "2", name: "Back Log", statusCategory: "To Do" },
    ]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([{ schemeId: "s1", statusId: "1" }]);

    const result = await getAdminOverview({ context: {} });

    expect(result.workflow.available).toBe(true);
    expect(result.workflow.schemeCount).toBe(2);
    // Only schemes governing more than one project give standardization any leverage.
    expect(result.workflow.sharedSchemes).toBe(1);
    expect(result.workflow.duplicateGroupCount).toBe(1);
  });

  test("reports the workflow roll-up as unavailable when no snapshot has been built", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readWorkflowSnapshotMeta.mockResolvedValue(null);

    const result = await getAdminOverview({ context: {} });

    expect(result.workflow).toEqual({ available: false, state: "idle" });
  });

  // Overview is the landing page: a workflow failure must degrade to a prompt, never an error.
  test("survives the workflow roll-up throwing", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.readWorkflowSnapshotMeta.mockRejectedValue(new Error("sql down"));

    const result = await getAdminOverview({ context: {} });

    expect(result.workflow).toEqual({ available: false, state: "error" });
  });

  // The worst silent handler in the codebase was a bare `catch {}` around this build:
  // an empty dashboard and a site with no data render identically, so the difference
  // has to exist in the logs.
  test("logs and still returns an overview when the dashboard build throws", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockRejectedValue(new Error("sql down"));

    const result = await getAdminOverview({ context: {} });

    // Job counts and config still render; only the dashboard degrades.
    expect(result.jobCounts).toBeDefined();
    expect(result.dashboard).toBeDefined();
  });

  test("degrades the legacy row count without failing the overview", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockRejectedValue(new Error("sql down"));

    const result = await getAdminOverview({ context: {} });

    expect(result.legacySummaryCount).toBe(0);
  });

  test("does not fail the whole overview if the findings computation throws", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockRejectedValue(new Error("SQL error"));

    const result = await getAdminOverview({ context: {} });

    expect(result.findingsSummary).toEqual({ adminAttention: 0, risky: 0, cleanup: 0, standardize: 0 });
    expect(result.dashboard.fieldUsage.totalFields).toBe(0);
    expect(result.dashboard.projects.totalProjects).toBe(0);
  });

  test("computes dashboard field-usage and project insights from the latest snapshot", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "ready", version: 5 });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);
    mocks.loadSnapshotFields.mockResolvedValue([
      snapshotField({ id: "customfield_1", name: "Story Points", type: "number" }),
      snapshotField({ id: "customfield_2", name: "Story Points", type: "number" }), // duplicate name -> one cluster
      snapshotField({
        id: "customfield_3",
        name: "Epic Link",
        type: "text",
        customType: "com.atlassian.jira.plugin.system.customfieldtypes:epic-link",
      }),
    ]);
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "1", projectKey: "AAA", projectName: "Alpha", fieldCount: 5, totalIssueCount: 100 },
      { projectId: "2", projectKey: "BBB", projectName: "Beta", fieldCount: 10, totalIssueCount: 50 },
    ]);

    const result = await getAdminOverview({ context: {} });

    expect(result.dashboard.fieldUsage.totalFields).toBe(3);
    expect(result.dashboard.fieldUsage.duplicateClusters).toBe(1);
    expect(result.dashboard.fieldUsage.origin.builtin).toBe(1);
    expect(result.dashboard.fieldUsage.origin.custom).toBe(2);
    expect(result.dashboard.projects.totalProjects).toBe(2);
    expect(result.dashboard.projects.topByIssueVolume[0]).toEqual(
      expect.objectContaining({ projectKey: "AAA", totalIssueCount: 100 }),
    );
    expect(result.dashboard.projects.topByFieldCount[0]).toEqual(
      expect.objectContaining({ projectKey: "BBB", fieldCount: 10 }),
    );
  });

  test("returns the empty dashboard shape when no snapshot version exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.listFieldSummaries.mockResolvedValue([]);
    mocks.kvsGet.mockResolvedValue(null);
    mocks.countOldScopeKeyRows.mockResolvedValue(0);

    const result = await getAdminOverview({ context: {} });

    expect(result.dashboard.fieldUsage.totalFields).toBe(0);
    expect(result.dashboard.projects.totalProjects).toBe(0);
    expect(mocks.listSnapshotProjects).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getHealthHistory
// ---------------------------------------------------------------------------
//
// The score always raised a question it could not answer: did cleaning that up help? These
// pin the two rules that keep the answer honest -- a single point is not a trend, and a
// dimension that only started being measured partway through has not "improved".
describe("getHealthHistory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  const day = (d, score, dimensions) => ({
    day: d,
    measuredAt: `${d}T00:00:00.000Z`,
    score,
    grade: "C",
    dimensionsScored: Object.keys(dimensions).length,
    dimensionsTotal: 13,
    dimensions,
  });

  test("says it has nothing rather than drawing a flat line at zero", async () => {
    mocks.loadHealthHistory.mockResolvedValue([]);

    const result = await getHealthHistory({ payload: {}, ...ctx });

    expect(result.available).toBe(false);
    expect(result.series).toEqual([]);
  });

  test("reports the movement across the window", async () => {
    mocks.loadHealthHistory.mockResolvedValue([
      day("2026-08-01", 51, { "field-governance": 17 }),
      day("2026-08-13", 63, { "field-governance": 40 }),
    ]);

    const result = await getHealthHistory({ payload: {}, ...ctx });

    expect(result.delta).toBe(12);
    expect(result.hasTrend).toBe(true);
    expect(result.dimensions.find((d) => d.key === "field-governance").delta).toBe(23);
  });

  // One measurement is a point, not a trend. Reporting a delta against itself would show
  // every fresh install as having improved by nothing, which reads as a measured result.
  test("refuses to call a single measurement a trend", async () => {
    mocks.loadHealthHistory.mockResolvedValue([day("2026-08-13", 58, { "field-naming": 79 })]);

    const result = await getHealthHistory({ payload: {}, ...ctx });

    expect(result.available).toBe(true);
    expect(result.hasTrend).toBe(false);
    expect(result.delta).toBeNull();
  });

  // A dimension that appeared partway through the window did not improve from zero -- that
  // would credit nobody's work as a 40-point gain.
  test("reports a newly measured dimension as new, not as an improvement", async () => {
    mocks.loadHealthHistory.mockResolvedValue([
      day("2026-08-01", 51, { "field-naming": 79 }),
      day("2026-08-13", 63, { "field-naming": 79, "screen-hygiene": 40 }),
    ]);

    const result = await getHealthHistory({ payload: {}, ...ctx });
    const added = result.dimensions.find((d) => d.key === "screen-hygiene");

    expect(added.first).toBeNull();
    expect(added.delta).toBeNull();
    expect(added.score).toBe(40);
  });

  // Ordered worst-movement first: the dimensions that went backwards are the ones an admin
  // needs to see, and they are exactly the ones a score-ordered list would bury.
  test("orders dimensions by movement, regressions first", async () => {
    mocks.loadHealthHistory.mockResolvedValue([
      day("2026-08-01", 51, { a: 50, b: 50 }),
      day("2026-08-13", 51, { a: 80, b: 20 }),
    ]);

    const result = await getHealthHistory({ payload: {}, ...ctx });

    expect(result.dimensions.map((d) => d.key)).toEqual(["b", "a"]);
  });

  test("clamps a hostile window rather than trusting it", async () => {
    mocks.loadHealthHistory.mockResolvedValue([]);
    await getHealthHistory({ payload: { days: 99999 }, ...ctx });

    expect(mocks.loadHealthHistory).toHaveBeenCalledWith("test-install", { days: 365 });
  });
});

// ---------------------------------------------------------------------------
// First run
//
// The rule under test is the one the panel is built on: every step the estate can answer
// for itself IS answered from the estate, on every read. Only the two that describe a
// person having read something are stored. A test that let a stored flag tick "the first
// scan has run" would let the panel congratulate an admin on a scan that never happened,
// which is the exact failure the derivation exists to prevent.
// ---------------------------------------------------------------------------
describe("first run", () => {
  const stepFor = (state, key) => state.steps.find((step) => step.key === key);

  // The field snapshot has no default in the global beforeEach -- the groups that need it
  // set it themselves. A first run reads it on every call, so the "nothing has been scanned
  // yet" answer is stated here rather than left to an undefined mock.
  beforeEach(() => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readFullScanMeta.mockResolvedValue(null);
  });

  test("a brand-new site has every step outstanding and no arrivals list", async () => {
    const state = await getFirstRunState({ context: { accountId: "a" } });

    expect(state.show).toBe(true);
    expect(state.remaining).toBe(5);
    expect(state.steps.every((step) => step.done === false)).toBe(true);
    // Nothing has been read, so there is nothing to arrive. An arrivals panel listing
    // fifteen pending stages on a site that has never scanned is a wall of "not started".
    expect(state.arrivals.available).toBe(false);
  });

  test("the scan step is derived from a snapshot existing, not from a scan run finishing", async () => {
    // Deliberately a CANCELLED run that still left a workflow snapshot behind. The estate
    // has been read; the bookkeeping row says the run did not finish. The pillar on disk wins.
    mocks.readFullScanMeta.mockResolvedValue({ state: "cancelled", stages: [] });
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v3", totalSchemes: 9 });

    const state = await getFirstRunState({ context: { accountId: "a" } });

    expect(stepFor(state, "first-scan").done).toBe(true);
    expect(stepFor(state, "first-scan").cta).toBeNull();
  });

  test("automation and schedule steps read the estate, and lose their prompt once satisfied", async () => {
    mocks.readAutomationAnalysis.mockResolvedValue({ refreshedAt: Date.now(), rules: [] });
    mocks.kvsGet.mockResolvedValue({ quickScanSchedule: { enabled: true } });

    const state = await getFirstRunState({ context: { accountId: "a" } });

    expect(stepFor(state, "import-automation").done).toBe(true);
    expect(stepFor(state, "import-automation").cta).toBeNull();
    expect(stepFor(state, "scan-schedule").done).toBe(true);
    expect(state.remaining).toBe(3);
  });

  test("acknowledged steps come back ticked, and are marked acknowledged rather than measured", async () => {
    mocks.kvsGet.mockResolvedValue({ firstRun: { acknowledged: ["evidence-rule"] } });

    const state = await getFirstRunState({ context: { accountId: "a" } });

    expect(stepFor(state, "evidence-rule")).toMatchObject({ done: true, kind: "acknowledged" });
    expect(stepFor(state, "share-macro")).toMatchObject({ done: false, kind: "acknowledged" });
    // The distinction has to survive the round trip: it is what decides whether the panel
    // offers a "Got it" button at all.
    expect(stepFor(state, "first-scan").kind).toBe("derived");
  });

  test("arrivals report what landed and what is still coming, newest first", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", totalSchemes: 9 });
    mocks.readScreenSnapshotMeta.mockResolvedValue({ totalScreens: 40 });
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running",
      stages: [
        { key: "workflows", state: "done", completedAt: "2026-01-01T10:00:00.000Z" },
        { key: "screens", state: "done", completedAt: "2026-01-01T11:00:00.000Z" },
        { key: "filters", state: "failed", completedAt: "2026-01-01T11:05:00.000Z", error: "Jira said 503" },
        { key: "issues", state: "running" },
      ],
    });

    const state = await getFirstRunState({ context: { accountId: "a" } });

    expect(state.scanRunning).toBe(true);
    expect(state.arrivals.available).toBe(true);
    expect(state.arrivals.landed.map((stage) => stage.key)).toEqual(["screens", "workflows"]);
    expect(state.arrivals.landed[0]).toMatchObject({ produced: 40, countable: true });
    // A failed stage is reported in the same list rather than hidden -- the pillar did not
    // build, which is a fact an admin needs on the way past, with the reason attached.
    expect(state.arrivals.pending.find((stage) => stage.key === "filters")).toMatchObject({
      state: "failed",
      error: "Jira said 503",
    });
  });

  test("a stage with nothing to count is not reported as having produced nothing", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", totalSchemes: 3 });
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running",
      stages: [{ key: "health", state: "done", completedAt: "2026-01-01T12:00:00.000Z" }],
    });

    const state = await getFirstRunState({ context: { accountId: "a" } });

    // health records a score, not a count. `countable: false` is what stops the panel
    // rendering "Health - 0", which reads as a failure rather than as a stage that simply
    // does not count anything.
    expect(state.arrivals.landed.find((stage) => stage.key === "health")).toMatchObject({
      countable: false,
      produced: null,
    });
  });

  test("a scanned site with no stage bookkeeping shows no arrivals rather than fifteen blanks", async () => {
    // A snapshot exists, but the meta row does not -- an install that scanned before stage
    // bookkeeping shipped, or one whose row was lost. Rendering the catalog anyway would put
    // fifteen "not started" rows in front of an admin whose estate HAS been read.
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1" });
    mocks.readFullScanMeta.mockResolvedValue({ state: "idle", stages: [] });

    const state = await getFirstRunState({ context: { accountId: "a" } });

    expect(state.steps).toHaveLength(5);
    expect(stepFor(state, "first-scan").done).toBe(true);
    expect(state.arrivals.available).toBe(false);
  });

  test("a failed produced-count read costs the counts, not the arrivals list", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1", totalSchemes: 4 });
    mocks.readScreenSnapshotMeta.mockRejectedValue(new Error("screens meta unreadable"));
    mocks.readFullScanMeta.mockResolvedValue({
      state: "idle",
      stages: [
        { key: "workflows", state: "done", completedAt: "2026-01-01T10:00:00.000Z" },
        { key: "screens", state: "done", completedAt: "2026-01-01T11:00:00.000Z" },
      ],
    });

    const state = await getFirstRunState({ context: { accountId: "a" } });

    expect(state.arrivals.landed).toHaveLength(2);
    // Screens landed and is still reported as landed. What is unknown is how many, and that
    // is said by omitting the number rather than by printing a zero.
    expect(state.arrivals.landed.find((stage) => stage.key === "screens")).toMatchObject({
      countable: false,
      produced: null,
    });
    expect(state.arrivals.landed.find((stage) => stage.key === "workflows")).toMatchObject({
      countable: true,
      produced: 4,
    });
  });

  test("every estate read failing shows the steps as outstanding, never as done", async () => {
    // The honest failure for a checklist. A read that could not answer must not be taken as
    // a yes -- a first-run panel that reports an unscanned site as scanned sends an admin
    // off to read numbers that do not exist yet.
    mocks.kvsGet.mockRejectedValueOnce(new Error("kvs down"));
    mocks.readSnapshotMeta.mockRejectedValueOnce(new Error("field meta down"));
    mocks.readFullScanMeta.mockRejectedValueOnce(new Error("scan meta down"));
    mocks.readAutomationAnalysis.mockRejectedValueOnce(new Error("automation down"));
    mocks.readWorkflowSnapshotMeta.mockRejectedValueOnce(new Error("workflow meta down"));

    const state = await getFirstRunState({ context: { accountId: "a" } });

    expect(state.remaining).toBe(5);
    expect(state.steps.every((step) => step.done === false)).toBe(true);
    expect(state.arrivals.available).toBe(false);
  });

  test("a dismissed panel stays dismissed even with steps outstanding", async () => {
    mocks.kvsGet.mockResolvedValue({ firstRun: { dismissed: true } });

    const state = await getFirstRunState({ context: { accountId: "a" } });

    expect(state.show).toBe(false);
    expect(state.remaining).toBeGreaterThan(0);
  });

  test("the panel retires itself once nothing is left", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v1" });
    mocks.readAutomationAnalysis.mockResolvedValue({ rules: [] });
    mocks.kvsGet.mockResolvedValue({
      quickScanSchedule: { enabled: true },
      firstRun: { acknowledged: ["evidence-rule", "share-macro"] },
    });

    const state = await getFirstRunState({ context: { accountId: "a" } });

    expect(state.remaining).toBe(0);
    expect(state.show).toBe(false);
  });

  test("acknowledging a step writes it without disturbing the rest of the config", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true, firstRun: { acknowledged: ["evidence-rule"] } });

    const result = await setFirstRunState({ payload: { acknowledge: "share-macro" }, context: {} });

    expect(result.ok).toBe(true);
    expect(result.firstRun.acknowledged).toEqual(["evidence-rule", "share-macro"]);
    const [, written] = mocks.kvsSet.mock.calls.at(-1);
    expect(written.readOnlyMode).toBe(true);
  });

  test("acknowledging twice does not duplicate", async () => {
    mocks.kvsGet.mockResolvedValue({ firstRun: { acknowledged: ["share-macro"] } });

    const result = await setFirstRunState({ payload: { acknowledge: "share-macro" }, context: {} });

    expect(result.firstRun.acknowledged).toEqual(["share-macro"]);
  });

  test("a derived step cannot be acknowledged", async () => {
    // The load-bearing assertion. "first-scan" is answered by the estate; letting a caller
    // tick it by hand would put a tick on the page meaning "somebody clicked" while wearing
    // the appearance of "this is true".
    const result = await setFirstRunState({ payload: { acknowledge: "first-scan" }, context: {} });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/derived/);
    expect(mocks.kvsSet).not.toHaveBeenCalled();
  });

  test("dismissing is stored, and undismissing is possible", async () => {
    await setFirstRunState({ payload: { dismissed: true }, context: {} });
    expect(mocks.kvsSet.mock.calls.at(-1)[1].firstRun.dismissed).toBe(true);

    mocks.kvsGet.mockResolvedValue({ firstRun: { dismissed: true, acknowledged: [] } });
    const result = await setFirstRunState({ payload: { dismissed: false }, context: {} });

    expect(result.firstRun.dismissed).toBe(false);
  });

  test("both first-run resolvers are admin-only", async () => {
    // getFirstRunState reports scan state and config; setFirstRunState writes config.
    // Neither belongs on a page anyone in Confluence can open.
    expect(__RAW_ADMIN_ONLY_FUNCTIONS).toHaveProperty("getFirstRunState");
    expect(__RAW_ADMIN_ONLY_FUNCTIONS).toHaveProperty("setFirstRunState");
    expect(SHARED_RESOLVER_FUNCTIONS).not.toHaveProperty("getFirstRunState");
    expect(SHARED_RESOLVER_FUNCTIONS).not.toHaveProperty("setFirstRunState");
  });
});
