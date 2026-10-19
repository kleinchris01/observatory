import { describe, test, expect, beforeEach } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks } from "./test-harness.js";
import { SHARED_RESOLVER_FUNCTIONS, __RAW_ADMIN_ONLY_FUNCTIONS } from "../resolvers.js";

const { getMacroFilters, getMacroScreens, getMacroIssueTypes, getMacroBoards, getMacroDashboards, getMacroWorkflows } =
  { ...SHARED_RESOLVER_FUNCTIONS, ...__RAW_ADMIN_ONLY_FUNCTIONS };

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

describe("macro viewer pillars", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x", accountId: "viewer-1" } };

  beforeEach(() => {
    // The viewer can browse SOLVE (id 10) only.
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "10", projectKey: "SOLVE", projectName: "Solve" },
      { projectId: "20", projectKey: "OTHER", projectName: "Other" },
    ]);
    mocks.getBrowsableProjectIds.mockImplementation(async () => new Set(["10"]));
  });

  describe("getMacroFilters", () => {
    test("keeps only filters that name a browsable project in JQL or are shared to one", async () => {
      mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "flt1" });
      mocks.loadFilters.mockResolvedValue([
        {
          id: "1",
          name: "Solve open",
          jql: "project = SOLVE",
          ownerName: "A",
          projectRefs: ["SOLVE"],
          fieldRefs: ["Priority"],
          shares: [],
        },
        {
          id: "2",
          name: "Other backlog",
          jql: "project = OTHER",
          ownerName: "B",
          projectRefs: ["OTHER"],
          fieldRefs: [],
          shares: [],
        },
        {
          id: "3",
          name: "Shared to Solve",
          jql: "status = Done",
          ownerName: "C",
          projectRefs: [],
          fieldRefs: [],
          shares: [{ type: "project", targetId: "10" }],
        },
        {
          id: "4",
          name: "Global",
          jql: "assignee = currentUser()",
          ownerName: "D",
          projectRefs: [],
          fieldRefs: [],
          shares: [{ type: "authenticated" }],
        },
      ]);

      const result = await getMacroFilters({ payload: {}, ...ctx });

      expect(result.available).toBe(true);
      expect(result.filters.map((f) => f.id).sort()).toEqual(["1", "3"]);
      expect(result.projectCount).toBe(1);
    });

    test("degrades, not throws, when no filter inventory exists", async () => {
      mocks.readFilterSnapshotMeta.mockResolvedValue(null);
      const result = await getMacroFilters({ payload: {}, ...ctx });
      expect(result).toMatchObject({ available: false, reason: "no-inventory" });
    });

    test("searches name and jql, and paginates", async () => {
      mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "flt1" });
      mocks.loadFilters.mockResolvedValue(
        Array.from({ length: 25 }, (_, i) => ({
          id: String(i),
          name: `Solve ${i}`,
          jql: "project = SOLVE",
          ownerName: "A",
          projectRefs: ["SOLVE"],
          fieldRefs: [],
          shares: [],
        })),
      );

      const page1 = await getMacroFilters({ payload: { page: 1 }, ...ctx });
      expect(page1.filters).toHaveLength(20);
      expect(page1.totalPages).toBe(2);

      const searched = await getMacroFilters({ payload: { query: "solve 7" }, ...ctx });
      expect(searched.matchedTotal).toBe(1);
    });
  });

  describe("getMacroDashboards", () => {
    test("keeps dashboards shared to a browsable project or backed by one of its filters", async () => {
      mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "d1" });
      mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "flt1" });
      mocks.loadFilters.mockResolvedValue([
        { id: "F_SOLVE", projectRefs: ["SOLVE"], fieldRefs: ["Priority"] },
        { id: "F_OTHER", projectRefs: ["OTHER"], fieldRefs: [] },
      ]);
      mocks.loadDashboards.mockResolvedValue([
        {
          id: "D1",
          name: "Solve board",
          ownerName: "A",
          gadgetCount: 2,
          shares: [{ type: "project", targetId: "10" }],
          gadgets: [],
        },
        {
          id: "D2",
          name: "Via filter",
          ownerName: "B",
          gadgetCount: 1,
          shares: [],
          gadgets: [{ filterId: "F_SOLVE" }],
        },
        {
          id: "D3",
          name: "Unrelated",
          ownerName: "C",
          gadgetCount: 1,
          shares: [{ type: "project", targetId: "20" }],
          gadgets: [{ filterId: "F_OTHER" }],
        },
      ]);

      const result = await getMacroDashboards({ payload: {}, ...ctx });

      expect(result.dashboards.map((d) => d.id).sort()).toEqual(["D1", "D2"]);
      expect(result.dashboards.find((d) => d.id === "D2").fields).toEqual(["Priority"]);
    });
  });

  describe("getMacroWorkflows", () => {
    test("groups the viewer's projects by workflow scheme and lists each scheme's statuses", async () => {
      mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1" });
      mocks.loadProjectWorkflowSchemeMap.mockResolvedValue(
        new Map([
          ["10", { schemeId: "WS1", name: "Solve workflow" }],
          ["20", { schemeId: "WS2", name: "Other workflow" }],
        ]),
      );
      mocks.loadWorkflowSchemeStatuses.mockResolvedValue([
        { schemeId: "WS1", statusId: "s1" },
        { schemeId: "WS1", statusId: "s2" },
        { schemeId: "WS2", statusId: "s3" },
      ]);
      mocks.loadStatusesCatalog.mockResolvedValue([
        { id: "s1", name: "Open", statusCategory: "To Do" },
        { id: "s2", name: "Done", statusCategory: "Done" },
        { id: "s3", name: "Elsewhere", statusCategory: "To Do" },
      ]);

      const result = await getMacroWorkflows({ ...ctx });

      expect(result.schemes).toHaveLength(1);
      expect(result.schemes[0]).toMatchObject({ schemeId: "WS1", projects: ["SOLVE"] });
      expect(result.statuses.map((s) => s.name)).toEqual(["Done", "Open"]);
      // A status from a scheme the viewer's projects do not run never appears.
      expect(result.statuses.some((s) => s.name === "Elsewhere")).toBe(false);
    });
  });
});

// The three pillars the Confluence macro gained, and the rule every one of them answers to:
// a viewer sees their own estate, never the site's. This panel can be opened by anyone in
// Confluence, so the scoping is the security boundary, not a nicety.
describe("the macro's viewer-scoped pillars", () => {
  const ctx = (accountId = "viewer-1") => ({ context: { installContext: "ari:cloud:jira::site/x", accountId } });

  // Two projects exist. The viewer can browse exactly one of them.
  const twoProjectsOneBrowsable = () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.listSnapshotProjects.mockResolvedValue([
      { projectId: "10", projectKey: "MINE", projectName: "Mine" },
      { projectId: "20", projectKey: "THEIRS", projectName: "Theirs" },
    ]);
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["10"]));
  };

  describe("getMacroScreens", () => {
    beforeEach(() => {
      twoProjectsOneBrowsable();
      mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1", refreshedAt: "2026-09-12T00:00:00.000Z" });
      mocks.loadScreensForProjects.mockResolvedValue([
        {
          projectId: "10",
          screenId: "100",
          name: "Create",
          fieldCount: 34,
          tabCount: 2,
          tabsResolved: "resolved",
          onCreate: true,
          onEdit: false,
          onView: true,
        },
        {
          projectId: "10",
          screenId: "200",
          name: "Edit",
          fieldCount: 12,
          tabCount: 1,
          tabsResolved: "resolved",
          onCreate: false,
          onEdit: true,
          onView: false,
        },
        // A row for a project the viewer cannot browse. The query is asked only for browsable
        // ids, but the fold must not trust that -- one day somebody widens the query.
        {
          projectId: "20",
          screenId: "300",
          name: "Secret",
          fieldCount: 9,
          tabCount: 1,
          tabsResolved: "resolved",
          onCreate: true,
          onEdit: false,
          onView: false,
        },
      ]);
    });

    test("shows only the projects the viewer can browse", async () => {
      const result = await getMacroScreens(ctx());

      expect(result.available).toBe(true);
      expect(result.projects.map((p) => p.projectKey)).toEqual(["MINE"]);
      expect(JSON.stringify(result)).not.toMatch(/THEIRS|Secret/);
    });

    test("leads with the number people actually argue about -- the create form's length", async () => {
      const result = await getMacroScreens(ctx());
      // Not the total across every screen: the longest CREATE screen, which is the form
      // nobody filing an issue can skip.
      expect(result.projects[0].createFieldCount).toBe(34);
    });

    test("never reports a screen it could not read as having no fields", async () => {
      mocks.loadScreensForProjects.mockResolvedValue([
        {
          projectId: "10",
          screenId: "100",
          name: "Create",
          fieldCount: 0,
          tabCount: 0,
          tabsResolved: "failed",
          onCreate: true,
          onEdit: false,
          onView: false,
        },
      ]);

      const result = await getMacroScreens(ctx());

      // The viewer is the person about to ask why their form looks different from this page.
      expect(result.projects[0].screens[0].unreadable).toBe(true);
    });

    test("says the inventory is missing rather than returning an empty estate", async () => {
      mocks.readScreenSnapshotMeta.mockResolvedValue(null);
      const result = await getMacroScreens(ctx());
      expect(result).toMatchObject({ available: false, reason: "no-inventory" });
    });
  });

  describe("getMacroIssueTypes", () => {
    beforeEach(() => {
      twoProjectsOneBrowsable();
      mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ version: "t1", refreshedAt: "2026-09-12T00:00:00.000Z" });
      mocks.loadIssueTypes.mockResolvedValue([
        { id: "1", name: "Bug", subtask: false },
        { id: "2", name: "Sub-task", subtask: true },
      ]);
      mocks.loadIssueTypeSchemeItems.mockResolvedValue([
        { schemeId: "S1", issueTypeId: "1" },
        { schemeId: "S1", issueTypeId: "2" },
        // A member the catalogue no longer holds -- a finding, not noise.
        { schemeId: "S1", issueTypeId: "999" },
      ]);
      mocks.loadIssueTypeSchemes.mockResolvedValue([{ schemeId: "S1", name: "Default scheme" }]);
      mocks.loadIssueTypeSchemeProjects.mockResolvedValue([
        { schemeId: "S1", projectId: "10", projectKey: "MINE" },
        { schemeId: "S1", projectId: "20", projectKey: "THEIRS" },
      ]);
    });

    test("groups by scheme and names it, rather than showing an id", async () => {
      const result = await getMacroIssueTypes(ctx());
      expect(result.schemes[0]).toMatchObject({ name: "Default scheme" });
    });

    test("lists only the browsable projects inside a shared scheme", async () => {
      // The scheme is shared with a project this viewer cannot see. The scheme still shows --
      // it governs one of theirs -- but the other project's key must not leak with it.
      const result = await getMacroIssueTypes(ctx());
      expect(result.schemes[0].projects).toEqual(["MINE"]);
    });

    test("keeps a member type the catalogue has lost, marked missing", async () => {
      const result = await getMacroIssueTypes(ctx());
      const missing = result.schemes[0].issueTypes.find((t) => t.id === "999");
      expect(missing).toMatchObject({ missing: true, name: null });
    });
  });

  describe("getMacroBoards", () => {
    beforeEach(() => {
      twoProjectsOneBrowsable();
      mocks.readBoardSnapshotMeta.mockResolvedValue({ version: "b1", refreshedAt: "2026-09-12T00:00:00.000Z" });
      mocks.loadBoards.mockResolvedValue([
        {
          boardId: "1",
          name: "My board",
          type: "scrum",
          locationType: "project",
          locationId: "10",
          locationKey: "MINE",
          columnCount: 4,
          configReadable: true,
        },
        {
          boardId: "2",
          name: "Their board",
          type: "kanban",
          locationType: "project",
          locationId: "20",
          locationKey: "THEIRS",
          columnCount: 3,
          configReadable: true,
        },
        {
          boardId: "3",
          name: "Team-managed",
          type: "kanban",
          locationType: "project",
          locationId: "10",
          locationKey: "MINE",
          columnCount: 0,
          configReadable: false,
        },
      ]);
    });

    test("shows only boards living in a project the viewer can browse", async () => {
      const result = await getMacroBoards(ctx());
      expect(result.boards.map((b) => b.name).sort()).toEqual(["My board", "Team-managed"]);
    });

    test("lists a board whose configuration could not be read rather than dropping it", async () => {
      // Team-managed boards routinely refuse that endpoint. Dropping them would read as
      // "you have no board here" to somebody looking straight at one.
      const result = await getMacroBoards(ctx());
      expect(result.boards.find((b) => b.name === "Team-managed").configReadable).toBe(false);
    });
  });

  test("every macro pillar is reachable WITHOUT Jira admin", async () => {
    // The whole point of the macro: a business user gets answers without being made an admin.
    // If one of these ever moves into the admin registry, this fails rather than the feature
    // silently disappearing for every non-admin who opens the page.
    for (const name of [
      "getMacroScreens",
      "getMacroIssueTypes",
      "getMacroBoards",
      "getMacroFilters",
      "getMacroDashboards",
      "getMacroWorkflows",
    ]) {
      expect(SHARED_RESOLVER_FUNCTIONS, name).toHaveProperty(name);
      expect(__RAW_ADMIN_ONLY_FUNCTIONS).not.toHaveProperty(name);
    }
  });

  test("the pillars that would leak stay out of the macro", async () => {
    // Access schemes and the people roster are a disclosure risk on a page anyone in
    // Confluence can open; automation findings include plaintext-credential hits. None of
    // them belongs on a wiki page, and this is the assertion that keeps it that way.
    for (const name of [
      "getAccessInventory",
      "getPeopleInventory",
      "getAutomationInsights",
      "getDeletionSafety",
      "getScreenFieldCrossSignal",
    ]) {
      expect(SHARED_RESOLVER_FUNCTIONS).not.toHaveProperty(name);
    }
  });
});
