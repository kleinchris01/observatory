import { describe, test, expect, vi, beforeEach } from "vitest";

// getHandoverReport runs the real getUserDetails underneath, so the store reads it makes are
// mocked here rather than the function itself: the test covers the join, not a stub of it.
const m = vi.hoisted(() => ({
  ensureProjectStoreReady: vi.fn().mockResolvedValue(undefined),
  readUserSnapshotMeta: vi.fn(),
  readSnapshotMeta: vi.fn(),
  readAccessSnapshotMeta: vi.fn(),
  loadUsers: vi.fn(),
  loadUserFieldAppearances: vi.fn(),
  loadSnapshotFieldNames: vi.fn(),
  loadSchemesGrantingHolder: vi.fn(),
  readBoardSnapshotMeta: vi.fn(),
  loadBoards: vi.fn(),
  readDashboardSnapshotMeta: vi.fn(),
  loadDashboardsForFilters: vi.fn(),
  buildOwnershipIndex: vi.fn(),
  readAutomationPart: vi.fn(),
  getProjectLeads: vi.fn(),
  countIssues: vi.fn(),
  incrMetric: vi.fn(),
}));

vi.mock("../lib/project-store.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ensureProjectStoreReady: m.ensureProjectStoreReady,
  readUserSnapshotMeta: m.readUserSnapshotMeta,
  readSnapshotMeta: m.readSnapshotMeta,
  readAccessSnapshotMeta: m.readAccessSnapshotMeta,
  loadUsers: m.loadUsers,
  loadUserFieldAppearances: m.loadUserFieldAppearances,
  loadSnapshotFieldNames: m.loadSnapshotFieldNames,
  loadSchemesGrantingHolder: m.loadSchemesGrantingHolder,
  readBoardSnapshotMeta: m.readBoardSnapshotMeta,
  loadBoards: m.loadBoards,
  readDashboardSnapshotMeta: m.readDashboardSnapshotMeta,
  loadDashboardsForFilters: m.loadDashboardsForFilters,
  loadUserGovernanceSummary: vi.fn(),
  loadUserActivity: vi.fn(),
}));
vi.mock("../lib/user-ownership.js", async (importOriginal) => ({
  ...(await importOriginal()),
  buildOwnershipIndex: m.buildOwnershipIndex,
}));
vi.mock("../lib/store/automation.js", async (importOriginal) => ({
  ...(await importOriginal()),
  readAutomationPart: m.readAutomationPart,
}));
vi.mock("../lib/user-engine.js", async (importOriginal) => ({
  ...(await importOriginal()),
  queueUserSnapshotBuild: vi.fn(),
  isUserBuildStale: vi.fn(),
}));
vi.mock("../lib/jira-api.js", async (importOriginal) => ({
  ...(await importOriginal()),
  incrMetric: m.incrMetric,
  getProjectLeads: m.getProjectLeads,
  countIssues: m.countIssues,
}));
vi.mock("./admin-config.js", async (importOriginal) => ({
  ...(await importOriginal()),
  readAdminConfig: vi.fn().mockResolvedValue({}),
}));

import { getHandoverReport } from "./people.js";
import { logger } from "../lib/logger.js";
import * as resolvers from "../resolvers.js";

const context = { installContext: "ari:cloud:jira::site/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b" };

function siteWithOnePerson() {
  m.readUserSnapshotMeta.mockResolvedValue({ version: "u1" });
  m.readSnapshotMeta.mockResolvedValue({ version: "f1" });
  m.readAccessSnapshotMeta.mockResolvedValue(null);
  m.loadUsers.mockResolvedValue([
    { accountId: "acc-1", displayName: "Pat Leaver", active: true, groups: [], applications: [] },
  ]);
  m.loadUserFieldAppearances.mockResolvedValue([]);
  m.loadSnapshotFieldNames.mockResolvedValue(new Map());
  m.loadSchemesGrantingHolder.mockResolvedValue([]);
  m.buildOwnershipIndex.mockResolvedValue({
    byAccount: new Map([["acc-1", { filters: [{ id: "10", name: "Sprint scope" }], dashboards: [], rules: [] }]]),
    available: { filters: true, dashboards: true, rules: true },
  });
  m.readAutomationPart.mockResolvedValue(null);
  m.readBoardSnapshotMeta.mockResolvedValue({ version: "b1" });
  m.loadBoards.mockResolvedValue([{ boardId: 5, name: "Team board", filterId: "10", locationKey: "TEAM" }]);
  m.readDashboardSnapshotMeta.mockResolvedValue({ version: "d1" });
  m.loadDashboardsForFilters.mockResolvedValue([]);
  m.getProjectLeads.mockResolvedValue([
    { id: "100", key: "TEAM", name: "Team", leadAccountId: "acc-1" },
    { id: "101", key: "OPS", name: "Ops", leadAccountId: "someone-else" },
  ]);
  m.countIssues.mockResolvedValue(7);
}

beforeEach(() => {
  vi.clearAllMocks();
  siteWithOnePerson();
});

describe("getHandoverReport", () => {
  test("joins the person's footprint with the boards on their filters, projects they lead and open issues", async () => {
    const report = await getHandoverReport({ payload: { accountId: "acc-1" }, context });

    expect(report.available).toBe(true);
    expect(report.person).toMatchObject({ accountId: "acc-1", displayName: "Pat Leaver" });
    expect(report.sections.find((s) => s.key === "breaks").items.map((i) => i.name)).toEqual(["Team board"]);
    expect(report.sections.find((s) => s.key === "work").items.map((i) => i.name)).toEqual(["7 open issues", "Team"]);
    expect(m.loadDashboardsForFilters).toHaveBeenCalledWith(expect.any(String), "d1", ["10"]);
    expect(m.countIssues).toHaveBeenCalledWith('assignee = "acc-1" AND statusCategory != Done');
  });

  test("a failed live read becomes unmeasured, not an empty list", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    m.getProjectLeads.mockRejectedValueOnce(new Error("403"));
    m.countIssues.mockResolvedValueOnce(null);

    const report = await getHandoverReport({ payload: { accountId: "acc-1" }, context });

    expect(report.sections.find((s) => s.key === "work").reason).toMatch(
      /open issues assigned to them, projects they lead/,
    );
    expect(warn).toHaveBeenCalledWith("handover.leads_failed", expect.any(Object));
    warn.mockRestore();
  });

  test("an unbuilt board snapshot leaves the cascade unmeasured", async () => {
    m.readBoardSnapshotMeta.mockResolvedValueOnce(null);
    const report = await getHandoverReport({ payload: { accountId: "acc-1" }, context });
    expect(report.sections.find((s) => s.key === "breaks").status).toBe("unmeasured");
  });

  test("passes through a site with no roster yet", async () => {
    m.readUserSnapshotMeta.mockResolvedValueOnce(null);
    expect(await getHandoverReport({ payload: { accountId: "acc-1" }, context })).toMatchObject({
      available: false,
      reason: "no-roster",
    });
    expect(m.getProjectLeads).not.toHaveBeenCalled();
  });

  test("requires an account id", async () => {
    await expect(getHandoverReport({ payload: {}, context })).rejects.toThrow("accountId is required");
  });

  // A person's whole footprint is admin information: never on the Confluence macro.
  test("is registered admin-only", () => {
    expect(resolvers.__RAW_ADMIN_ONLY_FUNCTIONS.getHandoverReport).toBe(getHandoverReport);
    expect(resolvers.SHARED_RESOLVER_FUNCTIONS).not.toHaveProperty("getHandoverReport");
  });
});
