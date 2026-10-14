import { describe, test, expect } from "vitest";
import { buildHandoverReport, summarize } from "./handover.js";

const details = (over = {}) => ({
  available: true,
  inRoster: true,
  user: {
    accountId: "acc-1", displayName: "Pat Leaver", active: true,
    groups: [{ id: "g1", name: "jira-software-users" }],
    applications: [{ key: "jira-software", name: "Jira Software" }],
  },
  ownedFilters: [{ id: 10, name: "Sprint scope", viewUrl: "https://x/filters/10" }, { id: 11, name: "My bugs" }],
  ownedDashboards: [{ id: 20, name: "Team wallboard" }],
  authoredRules: [{ id: "r1", name: "Auto-triage", enabled: true }],
  referencedInRules: [
    { id: "r2", name: "Assign escalations", enabled: true, direction: "write" },
    { id: "r3", name: "Notify if assignee", enabled: true, direction: "read" },
  ],
  fieldAppearances: [{ fieldId: "customfield_1", fieldName: "Approver", issueCount: 42 }],
  grantedBySchemes: [{ schemeName: "Default permissions", schemeType: "permission", context: "BROWSE", contextLabel: "Browse projects" }],
  grantedByGroups: [],
  automationRefsAvailable: true,
  fieldAppearancesAvailable: true,
  accessGrantsAvailable: true,
  ownershipAvailable: { filters: true, dashboards: true, rules: true },
  ...over,
});
const boards = [
  { boardId: 5, name: "Team board", filterId: "10", locationKey: "TEAM" },
  { boardId: 6, name: "Other board", filterId: "99", locationKey: "OTHER" },
];
const gadgets = [
  { filterId: "11", dashboardId: "30", dashboardName: "Exec view", gadgetTitle: "Open bugs", ownerName: "Sam" },
  // On their own dashboard: the dashboard is deleted anyway, so not counted twice.
  { filterId: "10", dashboardId: "20", dashboardName: "Team wallboard", gadgetTitle: "Sprint" },
];
const projectsLed = [{ id: "100", key: "TEAM", name: "Team project" }];

const sectionOf = (report, key) => report.sections.find((s) => s.key === key);

describe("buildHandoverReport", () => {
  const report = buildHandoverReport({ details: details(), boards, gadgets, projectsLed, openAssigned: 23 });

  test("orders sections from consequence to housekeeping", () => {
    expect(report.sections.map((s) => s.key)).toEqual(["deleted", "breaks", "work", "rules", "named", "access"]);
  });

  test("lists what is deleted with the account", () => {
    expect(sectionOf(report, "deleted").items.map((i) => [i.kind, i.name])).toEqual([
      ["filter", "Sprint scope"], ["filter", "My bugs"], ["dashboard", "Team wallboard"],
    ]);
  });

  // The cascade nobody else computes: their filter goes, and the board built on it breaks.
  test("follows their filters to the boards and gadgets built on them", () => {
    const breaks = sectionOf(report, "breaks");
    expect(breaks.items.map((i) => i.kind)).toEqual(["board", "gadget"]);
    expect(breaks.items[0]).toMatchObject({ name: "Team board", detail: 'Board in TEAM, built on "Sprint scope"' });
    expect(breaks.items[1]).toMatchObject({ name: "Exec view › Open bugs", detail: 'Gadget reading "My bugs", on Sam\'s dashboard' });
  });

  test("routes work: open issues, projects led, and only the rules that assign to them", () => {
    const work = sectionOf(report, "work");
    expect(work.items.map((i) => i.kind)).toEqual(["issues", "project", "rule"]);
    expect(work.items[0]).toMatchObject({ name: "23 open issues", jql: 'assignee = "acc-1" AND statusCategory != Done' });
    expect(work.items[2].name).toBe("Assign escalations");
    expect(work.reason).toBeNull();
  });

  test("counts what must be handled before removal and summarises it in one sentence", () => {
    expect(report.beforeRemoval).toBe(3 + 2 + 3);
    expect(report.summary).toBe(
      "Removing this account deletes 2 filters and 1 dashboard, breaking 1 board and 1 dashboard gadget. "
      + "Hand over 23 open issues assigned to them, 1 project they lead, 1 automation rule routing work to them."
    );
  });

  test("lists access to remove: direct grants, groups and licences", () => {
    expect(sectionOf(report, "access").items.map((i) => i.kind)).toEqual(["grant", "group", "licence"]);
  });
});

describe("buildHandoverReport — what could not be read", () => {
  test("an unbuilt board or dashboard snapshot makes the cascade unmeasured, not empty", () => {
    const report = buildHandoverReport({ details: details(), boards: null, gadgets: [], projectsLed: [], openAssigned: 0 });
    expect(sectionOf(report, "breaks")).toMatchObject({ status: "unmeasured", count: null });
    expect(sectionOf(report, "breaks").reason).toMatch(/Build the board and dashboard inventories/);
  });

  test("with no filters there is no cascade to measure, so it is clear even without snapshots", () => {
    const report = buildHandoverReport({ details: details({ ownedFilters: [] }), boards: null, gadgets: null });
    expect(sectionOf(report, "breaks").status).toBe("clear");
  });

  test("names each live read that failed instead of reporting no work", () => {
    const report = buildHandoverReport({ details: details({ automationRefsAvailable: false }), boards, gadgets, projectsLed: null, openAssigned: null });
    expect(sectionOf(report, "work").reason).toBe(
      "Could not read open issues assigned to them, projects they lead, automation rules that route work to them; check those by hand."
    );
  });

  test("marks unbuilt ownership, rule, field and access inputs unmeasured with their reasons", () => {
    const report = buildHandoverReport({
      details: details({
        ownershipAvailable: { filters: false, dashboards: true, rules: false },
        fieldAppearancesAvailable: false,
        accessGrantsAvailable: false,
      }),
      boards, gadgets, projectsLed, openAssigned: 0,
    });
    for (const key of ["deleted", "rules", "named", "access"]) {
      expect(sectionOf(report, key).status).toBe("unmeasured");
      expect(sectionOf(report, key).reason).toBeTruthy();
    }
  });

  test("an account with nothing to hand over says so", () => {
    const report = buildHandoverReport({
      details: details({ ownedFilters: [], ownedDashboards: [], authoredRules: [], referencedInRules: [], fieldAppearances: [], grantedBySchemes: [], user: { accountId: "a", displayName: "A", groups: [], applications: [] } }),
      boards, gadgets, projectsLed: [], openAssigned: 0,
    });
    expect(report.beforeRemoval).toBe(0);
    expect(report.summary).toBe("Nothing is deleted with this account and no work is routed to it.");
    expect(report.sections.every((s) => s.status === "clear")).toBe(true);
  });

  test("passes through an unavailable roster", () => {
    expect(buildHandoverReport({ details: { available: false, reason: "no-roster" } })).toEqual({ available: false, reason: "no-roster", sections: [] });
    expect(buildHandoverReport({})).toMatchObject({ available: false, reason: "no-roster" });
  });
});

describe("summarize", () => {
  test("names only what is there", () => {
    const deleted = { items: [{ kind: "dashboard" }] };
    expect(summarize({ deleted })).toBe("Removing this account deletes 1 dashboard.");
    expect(summarize({ deleted: { items: [] }, openAssigned: 1 })).toBe("Hand over 1 open issue assigned to them.");
  });
});
