import { describe, test, expect, beforeEach } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, snapshotField, ctxWithAccount } from "./test-harness.js";
import { SHARED_RESOLVER_FUNCTIONS, ADMIN_ONLY_FUNCTIONS, __RAW_ADMIN_ONLY_FUNCTIONS } from "../resolvers.js";

const { getPillarUsage, getPillarHealth, getPillarReport, runOqlQuery, searchEntities } = __RAW_ADMIN_ONLY_FUNCTIONS;

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// getProjectOverview
// ---------------------------------------------------------------------------
//
// The view the Projects tab existed to give and could not. Both cross-pillar joins existed
// as data -- rule scope was computed on every import and discarded, screens were reachable
// through the ITSS chain -- and neither had a query.

// ---------------------------------------------------------------------------
// getPillarHealth
// ---------------------------------------------------------------------------
//
// One pillar of the score, for the tab that pillar is about. Serving one rather than the
// whole score keeps the Workflows tab from having to know how Screens is graded.
describe("getPillarHealth", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("returns only the requested pillar, with the site score alongside it", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1" });
    mocks.loadWorkflowSchemes.mockResolvedValue([{ schemeId: "s1", name: "S", projectCount: 2 }]);
    mocks.loadStatusesCatalog.mockResolvedValue([{ statusId: "1", name: "Open" }]);

    const result = await getPillarHealth({ payload: { pillar: "workflows" }, ...ctx });

    expect(result.pillar.key).toBe("workflows");
    expect(result.pillar.dimensions.every((d) => d.pillar === "workflows")).toBe(true);
  });

  test("returns a null pillar for a name the score does not have", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);

    const result = await getPillarHealth({ payload: { pillar: "not-a-pillar" }, ...ctx });

    expect(result.pillar).toBeNull();
  });

  // The field inputs are the expensive half and the most likely to fail. A failure there must
  // not take the whole response down -- the pillar comes back reporting itself unmeasured.
  //
  // Asked for the FIELDS pillar deliberately: the screens pillar no longer loads the field
  // catalog at all, so pointing this at screens would leave the queued rejection unconsumed
  // and bleed it into the next test.
  test("still answers when the field inputs cannot be built", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.loadSnapshotFields.mockRejectedValueOnce(new Error("Unknown SQL execution error"));

    const result = await getPillarHealth({ payload: { pillar: "fields" }, ...ctx });

    expect(result.pillar).not.toBeNull();
    expect(result.pillar.key).toBe("fields");
    expect(result.pillar.available).toBe(false);
  });

  test("builds the field pillar from the snapshot when one exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "1", projectKey: "A", projectName: "Alpha", fieldCount: 4, totalIssueCount: 10 },
    ]);

    const result = await getPillarHealth({ payload: { pillar: "fields" }, ...ctx });

    expect(result.pillar.key).toBe("fields");
    expect(result.pillar.available).toBe(true);
  });

  test("rejects a missing pillar name", async () => {
    await expect(getPillarHealth({ payload: {}, ...ctx })).rejects.toThrow(/pillar/);
  });

  test("builds the people pillar from the user snapshot when one exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readUserSnapshotMeta.mockResolvedValue({ version: "u1", state: "ready" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", applications: [], groups: [] }]);
    mocks.loadUserGovernanceSummary.mockResolvedValue({ totalUsers: 200, activeUsers: 180 });

    const result = await getPillarHealth({ payload: { pillar: "users" }, ...ctx });

    expect(result.pillar.key).toBe("users");
    expect(result.pillar.available).toBe(true);
    expect(result.pillar.dimensions.some((d) => d.key === "user-licence-hygiene")).toBe(true);
  });

  test("reports the people pillar unavailable rather than empty when no roster exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readUserSnapshotMeta.mockResolvedValue(null);

    const result = await getPillarHealth({ payload: { pillar: "users" }, ...ctx });

    expect(result.pillar.available).toBe(false);
  });

  test("builds the assets pillar from the asset snapshot when one exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readAssetSnapshotMeta.mockResolvedValue({ version: "as1", state: "ready", assetsEnabled: true });
    mocks.loadAssetSchemas.mockResolvedValue([{ id: "1", name: "Infra", objectTypeCount: 3, objectCount: 40 }]);
    mocks.loadAssetObjectTypes.mockResolvedValue([
      { id: "9", schemaId: "1", name: "Server", parentId: null, abstract: false },
    ]);
    mocks.loadAssetAttributes.mockResolvedValue([
      { id: "a", objectTypeId: "9", name: "OS", referenceObjectTypeId: null, system: false },
    ]);

    const result = await getPillarHealth({ payload: { pillar: "assets" }, ...ctx });

    expect(result.pillar.key).toBe("assets");
    expect(result.pillar.available).toBe(true);
    expect(result.pillar.dimensions.some((d) => d.key === "asset-schema-hygiene")).toBe(true);
  });

  test("reports the assets pillar not-applicable when Assets is not licensed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "unavailable", assetsEnabled: false });

    const result = await getPillarHealth({ payload: { pillar: "assets" }, ...ctx });

    expect(result.pillar.available).toBe(false);
    expect(result.pillar.dimensions.every((d) => /not enabled on this site/i.test(d.reason))).toBe(true);
  });
});

describe("runOqlQuery", () => {
  const ctx = (query) => ({ payload: { query }, context: { installContext: "ari:cloud:jira::site/x" } });
  const screen = (i, fieldCount, over = {}) => ({
    screenId: String(i),
    name: `S${i}`,
    tabCount: 1,
    fieldCount,
    tabsResolved: "resolved",
    ...over,
  });

  function mockScreens() {
    mocks.readScreenSnapshotMeta.mockResolvedValueOnce({ version: "sv1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce(null);
    mocks.loadScreensPage.mockResolvedValueOnce({
      rows: [
        screen(1, 40),
        screen(2, 30),
        screen(3, 2),
        screen(4, 5),
        screen(5, 12),
        screen(6, 25),
        screen(7, 8),
        screen(8, 1),
      ],
    });
    // Screen 1 reaches one project -- the bottom quarter -- and carries the most fields.
    mocks.loadScreenSchemeOperations.mockResolvedValueOnce([
      { schemeId: "ss1", screenId: "1" },
      { schemeId: "ss2", screenId: "2" },
      { schemeId: "ss2", screenId: "6" },
      { schemeId: "ss3", screenId: "5" },
      { schemeId: "ss4", screenId: "7" },
      { schemeId: "ss2", screenId: "3" },
      { schemeId: "ss2", screenId: "4" },
      { schemeId: "ss2", screenId: "8" },
    ]);
    mocks.loadItssMappings.mockResolvedValueOnce([
      { itssId: "i1", screenSchemeId: "ss1" },
      { itssId: "i2", screenSchemeId: "ss2" },
      { itssId: "i3", screenSchemeId: "ss3" },
      { itssId: "i4", screenSchemeId: "ss4" },
    ]);
    mocks.loadItssProjects.mockResolvedValueOnce([
      { itssId: "i1", projectId: "P1" },
      ...["P1", "P2", "P3", "P4", "P5"].map((projectId) => ({ itssId: "i2", projectId })),
      { itssId: "i3", projectId: "P1" },
      { itssId: "i3", projectId: "P2" },
      { itssId: "i4", projectId: "P3" },
      { itssId: "i4", projectId: "P4" },
      { itssId: "i4", projectId: "P5" },
    ]);
  }

  test("returns a parse error without loading anything", async () => {
    const result = await runOqlQuery(ctx("pilar = screens"));
    expect(result).toEqual({
      ok: false,
      error: { message: 'Unknown field "pilar". Did you mean "pillar"?', start: 0, end: 5 },
    });
    expect(mocks.readScreenSnapshotMeta).not.toHaveBeenCalled();
  });

  test("answers the headline query, loading only the pinned pillar", async () => {
    mockScreens();
    const result = await runOqlQuery(ctx("pillar = screens AND usage = low AND impact = high"));
    expect(result.ok).toBe(true);
    expect(result.results.map((r) => r.id)).toEqual(["1"]);
    expect(result.results[0]).toMatchObject({
      pillar: "screens",
      usage: "low",
      impact: "high",
      usageValue: 1,
      impactValue: 40,
    });
    expect(result.pillars.map((p) => p.key)).toEqual(["screens"]);
    expect(result.thresholds.screens.usage.label).toMatch(/screen schemes/);
    expect(mocks.readFilterSnapshotMeta).not.toHaveBeenCalled();
  });

  test("an unpinned query searches every pillar and names the ones it could not", async () => {
    const result = await runOqlQuery(ctx("usage = low"));
    expect(result.ok).toBe(true);
    expect(result.pillars.map((p) => p.key)).toEqual([
      "fields",
      "projects",
      "workflows",
      "issueTypes",
      "fieldConfigs",
      "priorities",
      "people",
      "assets",
      "access",
      "screens",
      "filters",
      "dashboards",
      "boards",
      "automation",
    ]);
    expect(result.pillars.filter((p) => p.status === "unavailable" && !p.reason)).toEqual([]);
    expect(result.pillars.some((p) => p.status === "unavailable")).toBe(true);
  });

  test("a pillar that throws is reported unavailable, not dropped", async () => {
    mocks.readScreenSnapshotMeta.mockRejectedValueOnce(new Error("sql down"));
    const result = await runOqlQuery(ctx("pillar = screens"));
    expect(result.pillars).toEqual([
      expect.objectContaining({
        key: "screens",
        status: "unavailable",
        reason: expect.stringMatching(/could not be read/),
      }),
    ]);
  });

  test("orders results and lists the finding codes present", async () => {
    mockScreens();
    const result = await runOqlQuery(ctx("pillar = screens ORDER BY fields DESC"));
    expect(result.results.map((r) => r.id).slice(0, 3)).toEqual(["1", "2", "6"]);
    expect(result).toMatchObject({ total: 8, truncated: false });
    expect(Array.isArray(result.discoveryCodes)).toBe(true);
  });

  test("churn is unmeasured when no drift pass has run, and counted from the change log when one has", async () => {
    mockScreens();
    mocks.readDriftSnapshotMeta.mockResolvedValueOnce(null);
    const without = await runOqlQuery(ctx("pillar = screens"));
    expect(without.churnMeasured).toBe(false);

    mocks.readSnapshotMeta.mockResolvedValueOnce(null);
    mocks.readDriftSnapshotMeta.mockResolvedValueOnce({ version: "d1" });
    mocks.loadConfigChanges.mockResolvedValueOnce([
      { entityType: "field", entityId: "x", detectedAt: new Date().toISOString() },
    ]);
    const withDrift = await runOqlQuery(ctx("pillar = fields"));
    expect(withDrift.churnMeasured).toBe(true);
    expect(mocks.loadConfigChanges).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ limit: 500, since: expect.any(String) }),
    );
  });
});

describe("searchEntities", () => {
  const ctx = (payload) => ({ payload, context: { installContext: "ari:cloud:jira::site/x" } });

  function mockScreens(names) {
    mocks.readScreenSnapshotMeta.mockResolvedValueOnce({ version: "sv1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce(null);
    mocks.loadScreensPage.mockResolvedValueOnce({
      rows: names.map((name, i) => ({
        screenId: String(i + 1),
        name,
        tabCount: 1,
        fieldCount: 3,
        tabsResolved: "resolved",
      })),
    });
    mocks.loadScreenSchemeOperations.mockResolvedValueOnce([]);
    mocks.loadItssMappings.mockResolvedValueOnce([]);
    mocks.loadItssProjects.mockResolvedValueOnce([]);
  }

  test("a term under two characters answers empty without loading any pillar", async () => {
    const result = await searchEntities(ctx({ term: " d " }));
    expect(result).toEqual({ ok: true, term: "d", total: 0, results: [], unavailable: [] });
    expect(mocks.readScreenSnapshotMeta).not.toHaveBeenCalled();
  });

  test("finds items by name across pillars, best match first, and names the pillars it could not read", async () => {
    mockScreens(["Implant screen", "Deviation screen", "Deviation", "Build Deviation edit"]);
    const result = await searchEntities(ctx({ term: "deviation" }));
    expect(result.ok).toBe(true);
    const screens = result.results.filter((r) => r.pillar === "screens");
    expect(screens.map((r) => r.name)).toEqual(["Deviation", "Deviation screen", "Build Deviation edit"]);
    expect(screens[0]).toEqual(
      expect.objectContaining({ pillar: "screens", pillarLabel: "Screens", id: "3", rank: 0, uid: expect.any(String) }),
    );
    // Unbuilt pillars are reported, never silently treated as "no matches".
    expect(result.unavailable.length).toBeGreaterThan(0);
    expect(result.unavailable.every((p) => p.key && p.label)).toBe(true);
    expect(result.unavailable.map((p) => p.key)).not.toContain("screens");
  });

  test("a pillar that throws is reported unavailable, not dropped", async () => {
    mocks.readScreenSnapshotMeta.mockRejectedValueOnce(new Error("sql down"));
    const result = await searchEntities(ctx({ term: "screen" }));
    expect(result.unavailable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "screens", reason: expect.stringMatching(/could not be read/) }),
      ]),
    );
  });

  test("honours the limit and caps the term length", async () => {
    mockScreens(Array.from({ length: 12 }, (_, i) => `Deviation ${i}`));
    const result = await searchEntities(ctx({ term: `deviation${" ".repeat(300)}`, limit: 5 }));
    expect(result.term).toBe("deviation");
    expect(result.results).toHaveLength(5);
    expect(result.total).toBe(12);
  });
});

describe("getPillarReport", () => {
  const ctx = (pillar) => ({ payload: { pillar }, context: { installContext: "ari:cloud:jira::site/x" } });

  test("rejects a missing or unknown pillar", async () => {
    await expect(getPillarReport(ctx(""))).rejects.toThrow();
    await expect(getPillarReport(ctx("nope"))).rejects.toThrow(/Unknown pillar report/);
  });

  test("an unbuilt pillar is explicitly unavailable, never an empty report", async () => {
    mocks.readBoardSnapshotMeta.mockResolvedValueOnce(null);
    const report = await getPillarReport(ctx("boards"));
    expect(report).toMatchObject({ pillar: "boards", status: "unavailable", rows: [] });
    expect(report.reason).toMatch(/board inventory/);
  });

  test("boards: reuses the inventory read and carries its per-board findings", async () => {
    mocks.readBoardSnapshotMeta.mockResolvedValueOnce({
      state: "ready",
      version: "v1",
      refreshedAt: "2026-09-09T00:00:00Z",
    });
    mocks.loadBoards.mockResolvedValueOnce([
      { boardId: "1", name: "Clean", type: "scrum", filterId: "4001", configReadable: true, columnCount: 1 },
      { boardId: "2", name: "Orphan", type: "kanban", filterId: null, configReadable: true, columnCount: 0 },
    ]);
    mocks.loadBoardColumns.mockResolvedValueOnce([{ boardId: "1", index: 0, name: "To Do", statusIds: ["1"] }]);

    const report = await getPillarReport(ctx("boards"));

    expect(report).toMatchObject({ status: "ok", refreshedAt: "2026-09-09T00:00:00Z", total: 2, flaggedCount: 1 });
    expect(report.rows[0]).toMatchObject({ id: "2", findings: ["no-backing-filter"] });
  });

  test("filters: every filter with its analysis findings, not one page", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValueOnce({ version: "fv1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.readSnapshotMeta.mockResolvedValueOnce(null);
    mocks.readIssueTypeSnapshotMeta.mockResolvedValueOnce(null);
    mocks.loadFilters.mockResolvedValueOnce(
      Array.from({ length: 30 }, (_, i) => ({
        id: String(i),
        name: `F${i}`,
        ownerAccountId: "a",
        ownerName: "Ann",
        ownerActive: i !== 7,
        owner: { accountId: "a", displayName: "Ann", active: i !== 7 },
        shares: [],
        subscriptionCount: 0,
        lastUsedAt: "2026-08-01T00:00:00Z",
      })),
    );

    const report = await getPillarReport(ctx("filters"));

    expect(report.total).toBe(30);
    expect(report.rows[0]).toMatchObject({ id: "7", findings: ["orphaned-owner"] });
  });

  test("screens: pages through every screen and marks the unreached ones", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValueOnce({ version: "sv1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce({ version: "wv1", transitionScreens: 4 });
    const full = Array.from({ length: 200 }, (_, i) => ({
      screenId: String(i),
      name: `S${i}`,
      tabCount: 1,
      fieldCount: 3,
      tabsResolved: "resolved",
    }));
    mocks.loadScreensPage
      .mockResolvedValueOnce({ rows: full })
      .mockResolvedValueOnce({
        rows: [{ screenId: "200", name: "Last", tabCount: 1, fieldCount: 0, tabsResolved: "resolved" }],
      })
      .mockResolvedValueOnce({ rows: [{ screenId: "5" }] });

    const report = await getPillarReport(ctx("screens"));

    expect(report.total).toBe(201);
    expect(mocks.loadScreensPage).toHaveBeenCalledTimes(3);
    expect(mocks.loadScreensPage.mock.calls[2][2]).toMatchObject({ filter: "unreached", workflowVersion: "wv1" });
    const flagged = Object.fromEntries(report.rows.filter((r) => r.findings.length).map((r) => [r.id, r.findings]));
    expect(flagged).toEqual({ 200: ["empty"], 5: ["unreached"] });
  });

  // A workflow snapshot that never read transitions cannot say a screen is unreached: every
  // screen a transition opens would be listed for deletion.
  test("screens: reachability is skipped when the workflow build never read transitions", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValueOnce({ version: "sv1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce({ version: "wv1", transitionScreens: null });
    mocks.loadScreensPage.mockResolvedValueOnce({
      rows: [{ screenId: "5", name: "Resolve screen", tabCount: 1, fieldCount: 4, tabsResolved: "resolved" }],
    });

    const report = await getPillarReport(ctx("screens"));

    expect(mocks.loadScreensPage).toHaveBeenCalledTimes(1);
    expect(mocks.loadScreensPage.mock.calls[0][2]).toMatchObject({ workflowVersion: null });
    expect(report.rows.every((r) => !r.findings.includes("unreached"))).toBe(true);
  });

  test("automation: unavailable until the rule directory has been imported", async () => {
    mocks.readAutomationPart.mockResolvedValueOnce(null);
    const report = await getPillarReport(ctx("automation"));
    expect(report.status).toBe("unavailable");
    expect(report.reason).toMatch(/Automation tab/);
  });

  test("automation: rules from the directory, risks from the analysis preview", async () => {
    mocks.readAutomationAnalysis.mockResolvedValueOnce({
      refreshedAt: Date.UTC(2026, 8, 1),
      findingsPreview: [{ id: 11, r: [{ c: "secret" }] }],
      findingsTotal: 1,
    });
    mocks.readAutomationPart.mockResolvedValueOnce({
      rules: [
        [11, "Notify", 1, "jira:issue_created", 3, "acc"],
        [12, "Idle", 0, null, 0, null],
      ],
    });

    const report = await getPillarReport(ctx("automation"));

    expect(report).toMatchObject({ status: "ok", total: 2, refreshedAt: "2026-09-01T00:00:00.000Z" });
    expect(report.rows[0]).toMatchObject({ id: 11, enabled: true, findings: ["secret"] });
  });

  test("changes: keyset-pages the trailing window", async () => {
    mocks.readDriftSnapshotMeta.mockResolvedValueOnce({ version: "d1", refreshedAt: "2026-09-02T00:00:00Z" });
    const page = Array.from({ length: 500 }, (_, i) => ({
      changeId: String(i),
      detectedAt: `2026-09-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
      pillar: "fields",
      changeKind: "added",
    }));
    mocks.loadConfigChanges
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([
        { changeId: "x", detectedAt: "2026-08-30T00:00:00Z", pillar: "fields", changeKind: "removed" },
      ]);

    const report = await getPillarReport(ctx("changes"));

    expect(report.total).toBe(501);
    expect(mocks.loadConfigChanges.mock.calls[1][1]).toMatchObject({
      before: `${page[499].detectedAt}|${page[499].changeId}`,
      limit: 500,
    });
    expect(mocks.loadConfigChanges.mock.calls[0][1].since).toEqual(expect.any(String));
    expect(report.columns.some((c) => c.key === "findings")).toBe(false);
  });

  test("assets: an unlicensed site says so rather than reporting unbuilt", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValueOnce({ state: "unavailable" });
    const report = await getPillarReport(ctx("assets"));
    expect(report.reason).toMatch(/not available on this site/);
  });

  test.each([
    ["fields", "readSnapshotMeta", /field inventory/],
    ["projects", "readSnapshotMeta", /project inventory/],
    ["workflows", "readWorkflowSnapshotMeta", /workflow inventory/],
    ["issueTypes", "readIssueTypeSnapshotMeta", /issue type inventory/],
    ["priorities", "readEstateSnapshotMeta", /priority and resolution/],
    ["people", "readUserSnapshotMeta", /people inventory/],
    ["assets", "readAssetSnapshotMeta", /Assets inventory/],
    ["access", "readAccessSnapshotMeta", /access inventory/],
    ["screens", "readScreenSnapshotMeta", /screen inventory/],
    ["filters", "readFilterSnapshotMeta", /saved filter inventory/],
    ["dashboards", "readDashboardSnapshotMeta", /dashboard inventory/],
    ["changes", "readDriftSnapshotMeta", /drift pass/],
  ])("%s is unavailable until its snapshot exists", async (pillar, metaMock, reason) => {
    mocks[metaMock].mockResolvedValueOnce(null);
    const report = await getPillarReport(ctx(pillar));
    expect(report).toMatchObject({ pillar, status: "unavailable", rows: [] });
    expect(report.reason).toMatch(reason);
  });

  test("fields: every snapshot field, hydrated for governance", async () => {
    mocks.readSnapshotMeta.mockResolvedValueOnce({ version: "v1", completedAt: "2026-09-01T00:00:00Z" });
    mocks.loadSnapshotFields.mockResolvedValueOnce([
      {
        id: "customfield_1",
        name: "Team",
        type: "select",
        configuredProjectCount: 0,
        totalIssueCount: 0,
        activeProjectCount: 0,
      },
      {
        id: "customfield_2",
        name: "Budget",
        type: "number",
        configuredProjectCount: 1,
        totalIssueCount: 40,
        activeProjectCount: 1,
      },
    ]);

    const report = await getPillarReport(ctx("fields"));

    expect(report).toMatchObject({ status: "ok", total: 2, refreshedAt: "2026-09-01T00:00:00Z" });
    expect(report.rows.find((r) => r.id === "customfield_1").findings).toContain("orphaned");
  });

  test("projects: snapshot projects with adoption, unmeasured when no activity was captured", async () => {
    mocks.readSnapshotMeta.mockResolvedValueOnce({ version: "v1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.listSnapshotProjects.mockResolvedValueOnce([
      { projectId: "1", projectKey: "AAA", projectName: "Alpha", fieldCount: 3 },
    ]);
    mocks.loadProjectActivity.mockResolvedValueOnce(new Map());

    const report = await getPillarReport(ctx("projects"));

    expect(report.rows[0]).toMatchObject({ key: "AAA", fields: 3, adoption: null, findings: [] });
    expect(report.notes[0]).toMatch(/unmeasured/);
  });

  // A snapshot that never recorded refreshedAt still dates the report, from completedAt.
  test("projects: dates the report from completedAt when refreshedAt is missing", async () => {
    mocks.readSnapshotMeta.mockResolvedValueOnce({ version: "v1", completedAt: "2026-08-30T00:00:00Z" });
    mocks.listSnapshotProjects.mockResolvedValueOnce([
      { projectId: "1", projectKey: "AAA", projectName: "Alpha", fieldCount: 3 },
    ]);
    mocks.loadProjectActivity.mockResolvedValueOnce(new Map());

    const report = await getPillarReport(ctx("projects"));

    expect(report.refreshedAt).toBe("2026-08-30T00:00:00Z");
  });

  test("issueTypes: the catalogue with scheme membership for the orphan check", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValueOnce({
      state: "ready",
      version: "v1",
      refreshedAt: "2026-09-01T00:00:00Z",
    });
    mocks.loadIssueTypes.mockResolvedValueOnce([
      { id: "1", name: "Story", hierarchyLevel: 0 },
      { id: "2", name: "Lonely", hierarchyLevel: 0 },
    ]);
    mocks.loadIssueTypeSchemes.mockResolvedValueOnce([]);
    mocks.loadIssueTypeSchemeItems
      .mockResolvedValueOnce([{ schemeId: "s", issueTypeId: "1" }])
      .mockResolvedValueOnce([{ schemeId: "s", issueTypeId: "1" }]);
    mocks.loadIssueTypeSchemeProjects.mockResolvedValueOnce([]);
    mocks.loadIssueTypeGovernanceSummary.mockResolvedValueOnce({});
    mocks.readScreenSnapshotMeta.mockResolvedValueOnce(null);
    mocks.readIssueScanMeta.mockResolvedValueOnce(null);

    const report = await getPillarReport(ctx("issueTypes"));

    expect(report.rows[0]).toMatchObject({ id: "2", findings: ["no-scheme"] });
    expect(mocks.loadIssueTypeSchemeItems).toHaveBeenLastCalledWith("test-install", "v1");
  });

  test("priorities: both value lists from the estate inventory", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValueOnce({
      state: "ready",
      version: "v1",
      refreshedAt: "2026-09-01T00:00:00Z",
    });
    mocks.loadEstateValues
      .mockResolvedValueOnce([
        { id: "1", name: "Done" },
        { id: "2", name: "done" },
      ])
      .mockResolvedValueOnce([{ id: "10", name: "High", isDefault: true }]);

    const report = await getPillarReport(ctx("priorities"));

    expect(report).toMatchObject({ total: 3, flaggedCount: 2 });
  });

  test("people: the roster with ownership counts", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValueOnce({
      state: "ready",
      version: "v1",
      refreshedAt: "2026-09-01T00:00:00Z",
    });
    mocks.loadUsers.mockResolvedValueOnce([
      { accountId: "a1", displayName: "Ann", active: true, applications: [], groups: [] },
    ]);
    mocks.loadUserGovernanceSummary.mockResolvedValueOnce({ totalUsers: 1 });

    const report = await getPillarReport(ctx("people"));

    expect(report.rows[0]).toMatchObject({ accountId: "a1", active: true, findings: [] });
  });

  test("assets: object types from a built structure snapshot", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValueOnce({
      state: "ready",
      version: "v1",
      refreshedAt: "2026-09-01T00:00:00Z",
    });
    mocks.loadAssetSchemas.mockResolvedValueOnce([{ id: "s1", name: "IT", objectTypeCount: 1, objectCount: 4 }]);
    mocks.loadAssetObjectTypes.mockResolvedValueOnce([{ id: "t1", schemaId: "s1", name: "Laptop" }]);
    mocks.loadAssetAttributes.mockResolvedValueOnce([]);
    mocks.loadAssetTypeCounts.mockResolvedValueOnce([]);
    mocks.readAssetTypeCountMeta.mockResolvedValueOnce(null);

    const report = await getPillarReport(ctx("assets"));

    expect(report.rows[0]).toMatchObject({ schema: "IT", name: "Laptop", findings: ["no-custom-attributes"] });
  });

  test("access: every scheme family flattened into one table", async () => {
    mocks.readAccessSnapshotMeta.mockResolvedValueOnce({
      state: "ready",
      version: "v1",
      refreshedAt: "2026-09-01T00:00:00Z",
    });
    mocks.readUserSnapshotMeta.mockResolvedValueOnce(null);
    const byType = {
      permission: [{ id: "p1", name: "Spare" }],
      security: [],
      notification: [],
      "project-role": [{ id: "r1", name: "Admins" }],
    };
    for (let i = 0; i < 4; i += 1) {
      mocks.loadSchemes.mockImplementationOnce(async (_k, _v, type) => byType[type] || []);
      mocks.loadSchemeHolders.mockResolvedValueOnce([]);
    }
    for (let i = 0; i < 3; i += 1) mocks.loadSchemeProjects.mockResolvedValueOnce([]);
    mocks.loadSchemeLevels.mockResolvedValueOnce([]);

    const report = await getPillarReport(ctx("access"));

    const byId = Object.fromEntries(report.rows.map((r) => [r.id, r]));
    expect(byId.p1).toMatchObject({ type: "Permission scheme", findings: ["unassigned-scheme"] });
    expect(byId.r1).toMatchObject({ type: "Project role", findings: ["no-actors"] });
  });

  test("dashboards: every dashboard with its analysis findings", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValueOnce({ version: "d1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.loadDashboards.mockResolvedValueOnce([
      { id: "1", name: "Blank", gadgetCount: 0, owner: { accountId: "a", active: true }, shares: [], editShares: [] },
    ]);

    const report = await getPillarReport(ctx("dashboards"));

    expect(report.rows[0].findings).toContain("empty");
  });

  test("screens: reachability is skipped, and caveated, without a workflow snapshot", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValueOnce({ version: "sv1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce(null);
    mocks.loadScreensPage.mockResolvedValueOnce({
      rows: [{ screenId: "1", name: "S", tabCount: 1, fieldCount: 2, tabsResolved: "resolved" }],
    });

    const report = await getPillarReport(ctx("screens"));

    expect(mocks.loadScreensPage).toHaveBeenCalledTimes(1);
    expect(report.notes[0]).toMatch(/not checked/);
  });

  test("workflows: schemes with the status catalogue size", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce({ version: "wv1", refreshedAt: "2026-09-01T00:00:00Z" });
    mocks.loadWorkflowSchemes.mockResolvedValueOnce([{ id: "1", name: "Idle", projectCount: 0 }]);
    mocks.loadStatusesCatalog.mockResolvedValueOnce([{ id: "1" }, { id: "2" }]);

    const report = await getPillarReport(ctx("workflows"));

    expect(report.rows[0].findings).toEqual(["unused-scheme"]);
    expect(report.summary.find((t) => t.label === "Statuses").value).toBe(2);
  });
});

// getPillarHealth used to compute the ENTIRE site health -- every builder, every load, all
// ~1,600 fields hydrated -- and then discard five of the six pillars it produced. Opening the
// Screens tab cost the same twenty-odd SQL round trips as the Overview to render one panel.
describe("getPillarHealth — only loads what the pillar is scored from", () => {
  beforeEach(() => {
    mocks.kvsGet.mockResolvedValue(null);
    mocks.readSnapshotMeta.mockResolvedValue({ version: "v1", state: "ready" });
    mocks.loadHealthHistory.mockResolvedValue([{ day: "2026-08-21", score: 61, grade: "D" }]);
  });

  test("the screens pillar does not touch the field catalog", async () => {
    const result = await getPillarHealth({ payload: { pillar: "screens" }, context: ctxWithAccount() });

    expect(result.pillar?.key).toBe("screens");
    // The expensive branch: loading every field in the snapshot and hydrating it.
    expect(mocks.loadSnapshotFields).not.toHaveBeenCalled();
    expect(mocks.listSnapshotProjects).not.toHaveBeenCalled();
    expect(mocks.loadProjectActivity).not.toHaveBeenCalled();
  });

  test("the filters pillar does not build the workflow or screen inventories", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "fv1", state: "ready" });
    mocks.loadFilters.mockResolvedValue([]);

    const result = await getPillarHealth({ payload: { pillar: "filters" }, context: ctxWithAccount() });

    expect(result.pillar?.key).toBe("filters");
    expect(mocks.loadWorkflowSchemes).not.toHaveBeenCalled();
    expect(mocks.loadSnapshotFields).not.toHaveBeenCalled();
  });

  test("the projects pillar still loads the projects and their activity", async () => {
    mocks.listSnapshotProjects.mockResolvedValue([]);
    await getPillarHealth({ payload: { pillar: "projects" }, context: ctxWithAccount() });

    expect(mocks.listSnapshotProjects).toHaveBeenCalled();
    expect(mocks.loadProjectActivity).toHaveBeenCalled();
    // ...and not the field catalog, which only the fields pillar needs.
    expect(mocks.loadSnapshotFields).not.toHaveBeenCalled();
  });

  test("the fields pillar loads the catalog and nothing else", async () => {
    mocks.loadSnapshotFields.mockResolvedValue([]);
    await getPillarHealth({ payload: { pillar: "fields" }, context: ctxWithAccount() });

    expect(mocks.loadSnapshotFields).toHaveBeenCalled();
    expect(mocks.loadProjectActivity).not.toHaveBeenCalled();
  });

  // The score returned alongside is the SITE score, and it can no longer come from this
  // computation -- which is now scored from one pillar's inputs and would be a smaller number
  // wearing a bigger label.
  test("reads the site score from the recorded history, not from this computation", async () => {
    const result = await getPillarHealth({ payload: { pillar: "screens" }, context: ctxWithAccount() });
    expect(result).toMatchObject({ score: 61, grade: "D" });
  });

  test("reports no site score rather than an approximate one when nothing was recorded", async () => {
    mocks.loadHealthHistory.mockResolvedValue([]);
    const result = await getPillarHealth({ payload: { pillar: "screens" }, context: ctxWithAccount() });
    expect(result).toMatchObject({ score: null, grade: null });
  });

  test("an unknown pillar loads nothing and returns nothing", async () => {
    const result = await getPillarHealth({ payload: { pillar: "nonsense" }, context: ctxWithAccount() });
    expect(result.pillar).toBeNull();
    expect(mocks.loadSnapshotFields).not.toHaveBeenCalled();
  });

  test("still requires a pillar", async () => {
    await expect(getPillarHealth({ payload: {}, context: ctxWithAccount() })).rejects.toThrow(/pillar/);
  });
});

describe("getPillarUsage", () => {
  test("an unknown pillar is refused by name, not answered with zeros", async () => {
    const r = await getPillarUsage({ payload: { pillar: "nope" }, context: ctxWithAccount() });
    expect(r).toMatchObject({ available: false, reason: "unknown-pillar", items: {} });
    expect(mocks.loadUsageTally).not.toHaveBeenCalled();
  });

  test("before any complete crawl it says so, with the basis the tab labels from", async () => {
    mocks.readUsageMeta.mockResolvedValueOnce(null);
    const r = await getPillarUsage({ payload: { pillar: "resolution" }, context: ctxWithAccount() });
    expect(r).toEqual({
      pillar: "resolution",
      basis: "resolved",
      windowDays: 90,
      available: false,
      reason: "no-crawl",
      items: {},
    });
  });

  test("returns every item's three numbers with when they were counted", async () => {
    mocks.readUsageMeta.mockResolvedValueOnce({ measuredAt: "2026-10-07T00:00:00.000Z", windowDays: 90 });
    mocks.loadUsageTally.mockResolvedValueOnce(
      new Map([["10001", { total: 5, recent: 2, lastAt: "2026-10-01T00:00:00.000Z", projectCount: 1 }]]),
    );
    const r = await getPillarUsage({ payload: { pillar: "issuetype" }, context: ctxWithAccount() });
    expect(mocks.loadUsageTally).toHaveBeenCalledWith("test-install", "issuetype");
    expect(r).toEqual({
      pillar: "issuetype",
      basis: "created",
      windowDays: 90,
      available: true,
      measuredAt: "2026-10-07T00:00:00.000Z",
      items: { 10001: { total: 5, recent: 2, lastAt: "2026-10-01T00:00:00.000Z", projectCount: 1 } },
    });
  });

  test("is admin-only: the tally is site-wide, so the macro never reads it", () => {
    expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toContain("getPillarUsage");
    expect(Object.keys(SHARED_RESOLVER_FUNCTIONS)).not.toContain("getPillarUsage");
  });
});
