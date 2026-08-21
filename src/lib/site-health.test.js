import { describe, test, expect, vi } from "vitest";

// site-health.js reaches the store for the workflow and screen pillars, so the store is
// mocked wholesale. Nothing below exercises those paths -- these tests are about
// buildProjectInsights, which is pure -- but the imports have to resolve.
vi.mock("./project-store.js", () => ({
  loadIssueScanProjectTotals: vi.fn(async () => []),
  loadScreenGovernanceSummary: vi.fn(async () => ({})),
  loadStatusIssueCounts: vi.fn(async () => new Map()),
  loadStatusesCatalog: vi.fn(async () => []),
  loadWorkflowSchemeStatuses: vi.fn(async () => []),
  loadWorkflowSchemes: vi.fn(async () => []),
  readScreenSnapshotMeta: vi.fn(async () => null),
  readWorkflowSnapshotMeta: vi.fn(async () => null),
}));
vi.mock("./store/automation.js", () => ({
  loadStatusAutomationReferences: vi.fn(async () => ({})),
}));

const { buildProjectInsights } = await import("./site-health.js");

// One project row as listSnapshotProjects returns it. `totalIssueCount` is field FILLS --
// one row per field per project, summed -- which is the trap two of these tests are about.
const project = (key, over = {}) => ({
  projectId: key,
  projectKey: key,
  projectName: `Project ${key}`,
  fieldCount: 10,
  totalIssueCount: 1000,
  uniqueIssueCount: null,
  latestIssueUpdatedAt: new Date().toISOString(),
  ...over,
});

// n projects at the median, so the derived floor is predictable.
const baseline = (n, fieldCount = 20) =>
  Array.from({ length: n }, (_, i) => project(`B${i}`, { fieldCount }));

describe("buildProjectInsights — counts vs display lists", () => {
  // The defect this exists to prevent. The health score derived its rate from the LENGTH
  // of overConfigured/unusedProjects, both sliced to eight, so on a 200-project site the
  // worst achievable rate was 8% against a 25% tolerance. The dimension was pinned near
  // 100 whatever the estate looked like.
  test("reports an uncapped count alongside the capped list", () => {
    const projects = [
      ...baseline(100, 20),
      ...Array.from({ length: 40 }, (_, i) => project(`O${i}`, { fieldCount: 90 })),
    ];

    const insights = buildProjectInsights(projects);

    expect(insights.overConfigured).toHaveLength(8);
    expect(insights.overConfiguredCount).toBe(40);
  });

  test("counts every stale and unused project, not the first eight", () => {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const projects = [
      ...baseline(50),
      ...Array.from({ length: 20 }, (_, i) => project(`S${i}`, { latestIssueUpdatedAt: old })),
      ...Array.from({ length: 15 }, (_, i) => project(`U${i}`, { totalIssueCount: 0, uniqueIssueCount: 0 })),
    ];

    const insights = buildProjectInsights(projects);

    expect(insights.staleProjects).toHaveLength(8);
    expect(insights.staleProjectCount).toBe(20);
    expect(insights.unusedProjects).toHaveLength(8);
    expect(insights.unusedProjectCount).toBe(15);
  });
});

describe("buildProjectInsights — over-configured means over-configured", () => {
  // "Configured well past the norm" used to require light issue volume too. On an active
  // site nobody satisfies the compound test, so the label claimed a finding the measure
  // could not produce and the Overview read "0 projects configured well past the norm"
  // beside a project carrying 90 fields.
  test("a busy project past the norm is still over-configured", () => {
    const projects = [
      ...baseline(20, 20),
      project("BUSY", { fieldCount: 90, uniqueIssueCount: 40000, totalIssueCount: 400000 }),
    ];

    const insights = buildProjectInsights(projects);

    expect(insights.overConfiguredCount).toBe(1);
    expect(insights.overConfigured[0].projectKey).toBe("BUSY");
    // ...and not in the cleanup list, because it is carrying real work.
    expect(insights.idleOverConfiguredCount).toBe(0);
  });

  test("the idle subset is where cleanup is safe", () => {
    const projects = [
      ...baseline(20, 20).map((p) => ({ ...p, uniqueIssueCount: 5000 })),
      project("IDLE", { fieldCount: 90, uniqueIssueCount: 3, totalIssueCount: 40 }),
      project("BUSY", { fieldCount: 90, uniqueIssueCount: 40000, totalIssueCount: 400000 }),
    ];

    const insights = buildProjectInsights(projects);

    expect(insights.overConfiguredCount).toBe(2);
    expect(insights.idleOverConfiguredCount).toBe(1);
    expect(insights.idleOverConfigured[0].projectKey).toBe("IDLE");
  });

  test("publishes the threshold it judged against", () => {
    const insights = buildProjectInsights(baseline(20, 30));
    // max(10, median * 2)
    expect(insights.overConfiguredFloor).toBe(60);
    expect(insights.medianFieldCount).toBe(30);
  });

  test("an absolute floor guards a site whose median project has one field", () => {
    const projects = [...baseline(20, 1), project("SMALL", { fieldCount: 6 })];
    // Twice the median is 2, which would make a six-field project an outlier. It is not.
    expect(buildProjectInsights(projects).overConfiguredFloor).toBe(10);
    expect(buildProjectInsights(projects).overConfiguredCount).toBe(0);
  });
});

describe("buildProjectInsights — unused means no work, not no field fills", () => {
  // totalIssueCount counts field VALUES. Testing it against zero meant "not one populated
  // field anywhere", which almost no project satisfies, so the finding never fired.
  test("uses measured issues where the scan has produced them", () => {
    const projects = [
      ...baseline(10).map((p) => ({ ...p, uniqueIssueCount: 500 })),
      // Fields configured, no issues. Field fills are non-zero only because the row exists.
      project("EMPTY", { fieldCount: 12, uniqueIssueCount: 0, totalIssueCount: 0 }),
    ];

    const insights = buildProjectInsights(projects);

    expect(insights.hasUniqueCounts).toBe(true);
    expect(insights.unusedProjectCount).toBe(1);
    expect(insights.unusedProjects[0].projectKey).toBe("EMPTY");
  });

  test("falls back to fills, and says so, when nothing has been measured", () => {
    const insights = buildProjectInsights([
      ...baseline(10),
      project("EMPTY", { fieldCount: 12, totalIssueCount: 0 }),
    ]);

    expect(insights.hasUniqueCounts).toBe(false);
    expect(insights.totalUniqueIssues).toBeNull();
    expect(insights.unusedProjectCount).toBe(1);
  });

  // A partial scan is the normal state on a large site: the Universal Scan measures
  // projects over many invocations. Coercing an unmeasured project to zero volume would
  // report most of the estate as abandoned halfway through every scan.
  test("a project the scan has not reached is unmeasured, not empty", () => {
    const insights = buildProjectInsights([
      project("SCANNED", { fieldCount: 12, uniqueIssueCount: 5000 }),
      project("PENDING", { fieldCount: 12, uniqueIssueCount: null, totalIssueCount: 0 }),
    ]);

    expect(insights.hasUniqueCounts).toBe(true);
    expect(insights.unusedProjectCount).toBe(0);
    expect(insights.idleOverConfiguredCount).toBe(0);
  });

  test("a project with fields but no work is not also counted as stale", () => {
    // Staleness needs recorded work to have gone quiet. A project that never started is
    // the other finding, and counting it as both would double-charge one project.
    const insights = buildProjectInsights([
      ...baseline(10),
      project("NEVER", { fieldCount: 12, totalIssueCount: 0, latestIssueUpdatedAt: "2019-01-01T00:00:00Z" }),
    ]);

    expect(insights.unusedProjectCount).toBe(1);
    expect(insights.staleProjectCount).toBe(0);
  });
});

describe("buildProjectInsights — empty input", () => {
  test("reports zeroes rather than throwing", () => {
    const insights = buildProjectInsights([]);
    expect(insights).toMatchObject({
      totalProjects: 0,
      overConfiguredCount: 0,
      idleOverConfiguredCount: 0,
      unusedProjectCount: 0,
      staleProjectCount: 0,
    });
  });
});
