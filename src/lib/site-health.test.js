import { describe, test, expect, vi } from "vitest";

// site-health.js reaches the store for the workflow and screen pillars, so the store is
// mocked wholesale. Nothing below exercises those paths -- these tests are about
// buildProjectInsights, which is pure -- but the imports have to resolve.
const userStore = {
  readUserSnapshotMeta: vi.fn(async () => null),
  loadUsers: vi.fn(async () => []),
  loadUserGovernanceSummary: vi.fn(async () => ({})),
};
const assetStore = {
  readAssetSnapshotMeta: vi.fn(async () => null),
  loadAssetSchemas: vi.fn(async () => []),
  loadAssetObjectTypes: vi.fn(async () => []),
  loadAssetAttributes: vi.fn(async () => []),
};
const accessStore = {
  readAccessSnapshotMeta: vi.fn(async () => null),
  loadSchemes: vi.fn(async () => []),
  loadSchemeHolders: vi.fn(async () => []),
  loadSchemeLevels: vi.fn(async () => []),
  loadSchemeProjects: vi.fn(async () => []),
};
vi.mock("./project-store.js", () => ({
  loadIssueScanProjectTotals: vi.fn(async () => []),
  loadScreenGovernanceSummary: vi.fn(async () => ({})),
  loadStatusIssueCounts: vi.fn(async () => new Map()),
  loadStatusesCatalog: vi.fn(async () => []),
  loadWorkflowSchemeStatuses: vi.fn(async () => []),
  loadWorkflowSchemes: vi.fn(async () => []),
  readScreenSnapshotMeta: vi.fn(async () => null),
  readWorkflowSnapshotMeta: vi.fn(async () => null),
  readFilterSnapshotMeta: vi.fn(async () => null),
  readDashboardSnapshotMeta: vi.fn(async () => null),
  loadFilters: vi.fn(async () => []),
  loadDashboards: vi.fn(async () => []),
  ...userStore,
  ...assetStore,
  ...accessStore,
}));
const automationStore = {
  loadStatusAutomationReferences: vi.fn(async () => ({})),
  readAutomationPart: vi.fn(async () => null),
};
vi.mock("./store/automation.js", () => automationStore);

const { buildProjectInsights, buildFieldUsageInsights, captureSiteHealth, buildUserOverview, buildAssetOverview, buildAccessOverview } = await import("./site-health.js");

// The fields pillar scores duplicate naming once, through the dedicated field-naming
// dimension (built from duplicateClusters). The per-field "duplicate-naming" finding must
// stay out of findingsBySeverity, which the separate field-governance dimension scores --
// otherwise one duplicated name is charged twice inside the same pillar.
describe("buildFieldUsageInsights — duplicate naming is not double-counted", () => {
  const field = (name, reasons) => ({ name, type: "text", findings: { reasons } });

  test("a duplicate-naming reason is excluded from findingsBySeverity", () => {
    const insights = buildFieldUsageInsights([
      field("Story Points", [{ code: "duplicate-naming", severity: "medium", title: "Similar field naming detected" }]),
      field("Story Points ", [{ code: "duplicate-naming", severity: "medium", title: "Similar field naming detected" }]),
    ]);
    expect(insights.findingsBySeverity.medium).toBe(0);
    // The cluster is still counted where it IS scored, and still shown on the tab breakdown.
    expect(insights.duplicateClusters).toBe(1);
    expect(insights.findingsByType).toContainEqual({ title: "Similar field naming detected", count: 2 });
  });

  test("other findings of the same severity are still counted", () => {
    const insights = buildFieldUsageInsights([
      field("A", [{ code: "duplicate-naming", severity: "medium", title: "Similar field naming detected" }]),
      field("B", [{ code: "orphaned", severity: "medium", title: "Orphaned field" }]),
    ]);
    expect(insights.findingsBySeverity.medium).toBe(1);
  });
});

// captureSiteHealth is dependency-injected. It was once called with no deps at all -- from
// the scan orchestrator's health stage -- and crashed every scan with "Cannot destructure
// property 'readSnapshotMeta' of 'deps'". It must degrade, not throw: a scan that reported
// failure because a bookkeeping row could not be written would be lying about the scan.
describe("captureSiteHealth — missing deps", () => {
  test("no-ops instead of throwing when called without its dependencies", async () => {
    await expect(captureSiteHealth("inst")).resolves.toEqual({ recorded: false, reason: "missing-deps" });
    await expect(captureSiteHealth("inst", {})).resolves.toEqual({ recorded: false, reason: "missing-deps" });
  });
});

// buildUserOverview is the People pillar's health input: it joins the licensed roster
// against the seat summary and the filter/dashboard/rule ownership index, then hands
// computeSiteHealth a small `health` object. It must report unavailable, never zero, when
// no roster has been built.
describe("buildUserOverview", () => {
  test("reports unavailable when no user snapshot exists", async () => {
    userStore.readUserSnapshotMeta.mockResolvedValueOnce(null);
    const overview = await buildUserOverview("inst");
    expect(overview.available).toBe(false);
    expect(overview.health).toBeUndefined();
  });

  test("derives deactivated count from the seat summary, not the roster length", async () => {
    userStore.readUserSnapshotMeta.mockResolvedValueOnce({ version: "v1", state: "ready", refreshedAt: "2026-09-01T00:00:00Z" });
    userStore.loadUsers.mockResolvedValueOnce([{ accountId: "a1" }, { accountId: "a2" }]);
    userStore.loadUserGovernanceSummary.mockResolvedValueOnce({ totalUsers: 500, activeUsers: 470 });

    const overview = await buildUserOverview("inst");
    expect(overview.available).toBe(true);
    expect(overview.totalUsers).toBe(500);
    expect(overview.deactivatedUsers).toBe(30);
    expect(overview.health).toMatchObject({ available: true, totalUsers: 500, deactivatedUsers: 30 });
  });

  test("counts owned artifacts whose owner is off the roster as orphaned", async () => {
    userStore.readUserSnapshotMeta.mockResolvedValueOnce({ version: "v1", state: "ready" });
    userStore.loadUsers.mockResolvedValueOnce([{ accountId: "a1" }]);
    userStore.loadUserGovernanceSummary.mockResolvedValueOnce({ totalUsers: 1, activeUsers: 1 });
    const store = await import("./project-store.js");
    store.readFilterSnapshotMeta.mockResolvedValueOnce({ version: "f1" });
    store.loadFilters.mockResolvedValueOnce([
      { id: "10", name: "Mine", ownerAccountId: "a1" },
      { id: "11", name: "Ghost", ownerAccountId: "gone" },
    ]);

    const overview = await buildUserOverview("inst");
    expect(overview.ownedArtifactTotal).toBe(2);
    expect(overview.orphanedArtifacts).toBe(1);
    expect(overview.orphanedOwners).toBe(1);
    expect(overview.health).toMatchObject({ orphanedArtifacts: 1, ownedArtifactTotal: 2 });
  });

  test("counts the automation user references, and the off-roster ones", async () => {
    userStore.readUserSnapshotMeta.mockResolvedValueOnce({ version: "v1", state: "ready" });
    userStore.loadUsers.mockResolvedValueOnce([{ accountId: "a1" }]);
    userStore.loadUserGovernanceSummary.mockResolvedValueOnce({ totalUsers: 1, activeUsers: 1 });
    automationStore.readAutomationPart.mockImplementation((_k, part) =>
      Promise.resolve(part === "users"
        ? { entries: [{ label: "a1" }, { label: "gone-1" }, { label: "gone-2" }] }
        : null));

    const overview = await buildUserOverview("inst");
    expect(overview.automationRefUsers).toBe(3);
    expect(overview.orphanedAutomationRefUsers).toBe(2);
    automationStore.readAutomationPart.mockResolvedValue(null);
  });
});

describe("buildAssetOverview", () => {
  test("reports unmeasured when no snapshot exists", async () => {
    assetStore.readAssetSnapshotMeta.mockResolvedValueOnce(null);
    const overview = await buildAssetOverview("inst");
    expect(overview.available).toBe(false);
    expect(overview.health).toBeUndefined();
  });

  test("reports not-applicable, with a health input, when the meta says Assets is off", async () => {
    assetStore.readAssetSnapshotMeta.mockResolvedValueOnce({ state: "unavailable", assetsEnabled: false, lastError: "no workspace" });
    const overview = await buildAssetOverview("inst");
    expect(overview).toMatchObject({ available: false, assetsEnabled: false, state: "unavailable" });
    expect(overview.health).toEqual({ available: false, assetsEnabled: false });
  });

  test("summarises the structure and hands computeSiteHealth its inputs", async () => {
    assetStore.readAssetSnapshotMeta.mockResolvedValueOnce({ state: "ready", version: "v1", assetsEnabled: true, refreshedAt: "2026-09-02T00:00:00Z" });
    assetStore.loadAssetSchemas.mockResolvedValueOnce([
      { id: "1", name: "Infra", objectTypeCount: 2, objectCount: 40 },
      { id: "2", name: "Empty", objectTypeCount: 0, objectCount: 0 },
    ]);
    assetStore.loadAssetObjectTypes.mockResolvedValueOnce([
      { id: "9", schemaId: "1", name: "Server", parentId: null, abstract: false },
      { id: "10", schemaId: "1", name: "VM", parentId: "9", abstract: false },
    ]);
    assetStore.loadAssetAttributes.mockResolvedValueOnce([
      { id: "a", objectTypeId: "9", name: "OS", referenceObjectTypeId: null, system: false },
      { id: "b", objectTypeId: "10", name: "Host", referenceObjectTypeId: "404", system: false },
    ]);

    const overview = await buildAssetOverview("inst");
    expect(overview).toMatchObject({ available: true, assetsEnabled: true, totalSchemas: 2, deadSchemaCount: 1, brokenReferenceCount: 1 });
    expect(overview.health).toMatchObject({ available: true, totalSchemas: 2, deadSchemaCount: 1, brokenReferenceCount: 1 });
  });
});

describe("buildAccessOverview", () => {
  test("reports unmeasured when no snapshot exists", async () => {
    accessStore.readAccessSnapshotMeta.mockResolvedValueOnce(null);
    const overview = await buildAccessOverview("inst");
    expect(overview.available).toBe(false);
  });

  test("summarises each scheme type and hands each its own health block", async () => {
    accessStore.readAccessSnapshotMeta.mockResolvedValueOnce({ state: "ready", version: "v1", refreshedAt: "2026-09-02T00:00:00Z" });
    accessStore.loadSchemes.mockImplementation(async (_k, _v, type) => type === "permission"
      ? [{ id: "1", name: "Prod", isDefault: false }, { id: "2", name: "Default Permission Scheme", isDefault: true }]
      : type === "security" ? [{ id: "s1", name: "Sec" }]
      : [{ id: "n1", name: "Notif" }]);
    accessStore.loadSchemeHolders.mockImplementation(async (_k, _v, type) => type === "permission"
      ? [{ schemeId: "1", context: "BROWSE_PROJECTS", holderType: "anyone", holderValue: "" }]
      : []);
    accessStore.loadSchemeLevels.mockResolvedValue([{ schemeId: "s1", id: "L1", name: "Internal" }]);
    accessStore.loadSchemeProjects.mockImplementation(async (_k, _v, type) => type === "permission" ? [{ schemeId: "1", projectId: "10" }] : []);

    const overview = await buildAccessOverview("inst");
    expect(overview.available).toBe(true);
    expect(overview.permissions.health).toMatchObject({ available: true, riskySchemeCount: 1 });
    expect(overview.security.health).toMatchObject({ available: true, brokenLevelCount: 1 });
    expect(overview.notifications.health).toMatchObject({ available: true });
  });
});

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
