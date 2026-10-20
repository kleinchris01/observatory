import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks } from "./test-harness.js";
import { __RAW_ADMIN_ONLY_FUNCTIONS } from "../resolvers.js";

const { getProjectOverview } = __RAW_ADMIN_ONLY_FUNCTIONS;

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

describe("getProjectOverview", () => {
  // The project's agile boards: matched by location id, or by key when the caller passes one.
  // Tri-state: no board snapshot is "unavailable", never "no boards".
  test("lists the boards located in this project, matched by id or by key", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readBoardSnapshotMeta.mockResolvedValueOnce({ version: "b1" });
    mocks.loadBoards.mockResolvedValueOnce([
      {
        boardId: 1,
        name: "Team board",
        type: "scrum",
        filterId: 9,
        columnCount: 4,
        configReadable: true,
        locationType: "project",
        locationId: "10000",
      },
      {
        boardId: 2,
        name: "By key",
        type: "kanban",
        filterId: 8,
        columnCount: 3,
        configReadable: true,
        locationType: "project",
        locationId: "99999",
        locationKey: "ops",
      },
      { boardId: 3, name: "Elsewhere", locationType: "project", locationId: "20000", locationKey: "OTHER" },
      { boardId: 4, name: "Someone's board", locationType: "user", locationId: "10000" },
    ]);

    const result = await getProjectOverview({
      payload: { projectId: "10000", projectKey: "OPS" },
      context: { installContext: "ari:cloud:jira::site/x", accountId: "acc-1" },
    });

    expect(result.boards.available).toBe(true);
    expect(result.boards.boards.map((b) => b.boardId)).toEqual([1, 2]);
    expect(result.boards.boards[0]).toEqual({
      boardId: 1,
      name: "Team board",
      type: "scrum",
      filterId: 9,
      columnCount: 4,
      configReadable: true,
    });
  });

  test("a failed board snapshot read reports boards unavailable, not empty", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readBoardSnapshotMeta.mockRejectedValueOnce(new Error("sql down"));

    const result = await getProjectOverview({
      payload: { projectId: "10000" },
      context: { installContext: "ari:cloud:jira::site/x", accountId: "acc-1" },
    });

    expect(result.boards).toEqual({ available: false, reason: "No board inventory has been built yet." });
    expect(mocks.loadBoards).not.toHaveBeenCalled();
  });

  const ctx = { context: { installContext: "ari:cloud:jira::site/x", accountId: "acc-1" } };

  // Before any pillar is read. Every other project read here filters by browsable project,
  // and a cross-pillar view must not become the one place a caller learns about a project
  // they cannot see.
  test("refuses a project the caller cannot browse, without reading any pillar", async () => {
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set());

    const result = await getProjectOverview({ payload: { projectId: "10000" }, ...ctx });

    expect(result.available).toBe(false);
    expect(mocks.loadScreensForProject).not.toHaveBeenCalled();
    expect(mocks.loadRulesForProject).not.toHaveBeenCalled();
  });

  test("joins workflow, screens and automation for one project", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1" });
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1", unresolvedScreens: 2 });
    mocks.loadWorkflowSchemeForProject.mockResolvedValue({ id: "sch1", name: "SW Workflow Scheme v1" });
    mocks.loadScreensForProject.mockResolvedValue([{ screenId: "100", name: "Default", fieldCount: 28 }]);
    mocks.loadRulesForProject.mockResolvedValue([
      { ruleId: "1", name: "Send to Approval", enabled: true },
      { ruleId: "2", name: "Retired", enabled: false },
    ]);

    const result = await getProjectOverview({ payload: { projectId: "10000" }, ...ctx });

    expect(result.workflow.scheme.name).toBe("SW Workflow Scheme v1");
    expect(result.screens.screens).toHaveLength(1);
    expect(result.automation).toMatchObject({ enabledCount: 1, disabledCount: 1 });
    // Carried so the tab never presents a partial catalog as the whole one.
    expect(result.screens.unresolvedScreens).toBe(2);
  });

  // One unbuilt pillar must not blank the page, and must not be reported as empty either.
  test("reports each pillar unavailable independently rather than as empty", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readWorkflowSnapshotMeta.mockResolvedValue(null);
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);
    mocks.loadRulesForProject.mockResolvedValue([{ ruleId: "1", name: "R", enabled: true }]);

    const result = await getProjectOverview({ payload: { projectId: "10000" }, ...ctx });

    expect(result.workflow).toMatchObject({ available: false });
    expect(result.screens).toMatchObject({ available: false });
    expect(result.workflow.reason).toMatch(/workflow inventory/i);
    // The pillar that IS built still renders.
    expect(result.automation.available).toBe(true);
  });

  // Cross-pillar (Access): the three schemes this project resolves to, each flagged if it
  // is the site default. Tri-state like the rest.
  test("joins the project's permission / security / notification schemes when the access inventory exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    mocks.loadProjectSchemes.mockResolvedValue([
      { schemeType: "permission", schemeId: "1", schemeName: "Prod permissions", isDefault: false },
      { schemeType: "notification", schemeId: "n1", schemeName: "Default Notification Scheme", isDefault: true },
    ]);

    const result = await getProjectOverview({ payload: { projectId: "10000" }, ...ctx });

    expect(result.schemes).toMatchObject({
      available: true,
      permission: { schemeName: "Prod permissions" },
      security: null,
      notification: { isDefault: true },
    });
  });

  test("groups this project's role actors by role", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    mocks.loadProjectRoleActors.mockResolvedValue([
      {
        roleId: "10002",
        roleName: "Administrators",
        holderType: "group",
        holderValue: "g-admins",
        holderLabel: "admins",
      },
      { roleId: "10003", roleName: "Members", holderType: "empty", holderValue: "", holderLabel: null },
    ]);

    const result = await getProjectOverview({ payload: { projectId: "10000" }, ...ctx });

    expect(result.roles.available).toBe(true);
    const admin = result.roles.byRole.find((r) => r.roleName === "Administrators");
    const members = result.roles.byRole.find((r) => r.roleName === "Members");
    expect(admin.actors).toEqual([{ type: "group", value: "g-admins", label: "admins" }]);
    expect(members.actors).toEqual([]); // the empty sentinel is not an actor
  });

  test("reports the access schemes unavailable when that inventory has not been built", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readAccessSnapshotMeta.mockResolvedValue(null);

    const result = await getProjectOverview({ payload: { projectId: "10000" }, ...ctx });

    expect(result.schemes).toMatchObject({ available: false });
    expect(mocks.loadProjectSchemes).not.toHaveBeenCalled();
  });

  // Site-wide rules are only worth listing per project if there is evidence they act there
  // -- otherwise the list is "all of them" and says nothing.
  test("keeps inferred site-wide rules separate from the ones actually scoped here", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.loadRulesForProject.mockResolvedValue([{ ruleId: "1", name: "Scoped", enabled: true }]);
    mocks.loadGlobalRulesAffectingProject.mockResolvedValue([
      {
        ruleId: "9",
        name: "Site-wide writer",
        fieldsTouched: 2,
        issuesTouched: 5000,
        lastChangeAt: "2026-08-01T00:00:00Z",
      },
    ]);

    const result = await getProjectOverview({ payload: { projectId: "10000" }, ...ctx });

    // Merging them would erase the difference between "configured for this project" and
    // "we infer it reaches this project", and only the first is a fact.
    expect(result.automation.rules.map((r) => r.ruleId)).toEqual(["1"]);
    expect(result.automation.globalRules.map((r) => r.ruleId)).toEqual(["9"]);
    expect(result.automation.globalRulesAvailable).toBe(true);
  });

  // The evidence is field usage in this project, so with no field snapshot there is nothing
  // to infer from. Withheld rather than guessed at.
  test("withholds the inferred list when there is no field snapshot to infer from", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.loadRulesForProject.mockResolvedValue([]);

    const result = await getProjectOverview({ payload: { projectId: "10000" }, ...ctx });

    expect(mocks.loadGlobalRulesAffectingProject).not.toHaveBeenCalled();
    expect(result.automation.globalRulesAvailable).toBe(false);
    expect(result.automation.globalRulesReason).toMatch(/field snapshot/i);
  });

  test("lists the saved filters whose JQL scopes to this project", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "flt1" });
    mocks.listSnapshotProjects.mockResolvedValue([
      {
        projectId: "10000",
        projectKey: "PT2",
        projectName: "Prototype & Test",
        fieldCount: 216,
        totalIssueCount: 1_066_714,
      },
    ]);
    mocks.loadFilterReferencesFor.mockResolvedValue({
      total: 3,
      filters: [
        {
          id: "5",
          name: "PT2 open bugs",
          ownerName: "Bo",
          ownerActive: true,
          subscriptionCount: 2,
          lastUsedAt: "2026-08-01",
        },
      ],
    });

    const result = await getProjectOverview({ payload: { projectId: "10000", projectKey: "PT2" }, ...ctx });

    expect(mocks.loadFilterReferencesFor).toHaveBeenCalledWith("test-install", "flt1", "project", "PT2");
    expect(result.filters).toMatchObject({ available: true, total: 3 });
    expect(result.filters.filters[0].name).toBe("PT2 open bugs");
  });

  test("reports filters unavailable rather than empty when no filter snapshot exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    mocks.loadRulesForProject.mockResolvedValue([]);

    const result = await getProjectOverview({ payload: { projectId: "10000", projectKey: "PT2" }, ...ctx });

    expect(result.filters).toMatchObject({ available: false });
    expect(mocks.loadFilterReferencesFor).not.toHaveBeenCalled();
  });

  test("rolls up a health band from the pillar signals, flagging a form-heavy project", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1", unresolvedScreens: 14 });
    mocks.loadScreensForProject.mockResolvedValue([{ screenId: "1", name: "S", tabsResolved: "resolved" }]);
    mocks.loadRulesForProject.mockResolvedValue([{ ruleId: "1", name: "R", enabled: true }]);
    mocks.listSnapshotProjects.mockResolvedValue([
      // This project asks ~90 fields per issue; the rest sit at 12, so the site median is 12
      // and this one reads as ~7.5x heavier -- past the 6x "critical" line.
      { projectId: "10000", projectKey: "PT2", projectName: "PT2", fieldCount: 216, totalIssueCount: 900_000 },
      { projectId: "2", projectKey: "B", projectName: "B", fieldCount: 20, totalIssueCount: 120_000 },
      { projectId: "3", projectKey: "C", projectName: "C", fieldCount: 20, totalIssueCount: 130_000 },
    ]);
    // Universe-scan issue totals, so fills-per-issue is computable: PT2 ~90, the others ~12.
    mocks.loadIssueScanProjectTotals.mockResolvedValue([
      { projectId: "10000", uniqueIssueCount: 10_000 },
      { projectId: "2", uniqueIssueCount: 10_000 },
      { projectId: "3", uniqueIssueCount: 10_833 },
    ]);

    const result = await getProjectOverview({ payload: { projectId: "10000", projectKey: "PT2" }, ...ctx });

    expect(result.health.band).toBe("critical");
    const config = result.health.signals.find((s) => s.key === "configuration");
    expect(config.tone).toBe("critical");
    const forms = result.health.signals.find((s) => s.key === "forms");
    expect(forms.tone).toBe("warning"); // 14 unreadable screens
  });

  test("rejects a missing project id", async () => {
    await expect(getProjectOverview({ payload: {}, ...ctx })).rejects.toThrow(/projectId/);
  });
});
