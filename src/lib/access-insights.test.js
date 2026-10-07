import { describe, test, expect } from "vitest";
import { computeSiteHealth } from "./health-score.js";
import {
  summarizePermissionInsights, summarizePermissionHealth,
  summarizeSecurityInsights, summarizeSecurityHealth,
  summarizeNotificationInsights, summarizeNotificationHealth,
  summarizeRoleInsights, summarizeRoleHealth,
  adminCapabilityByProject,
} from "./access-insights.js";

const roster = new Set(["acc-1", "acc-2"]);

describe("summarizePermissionInsights", () => {
  const schemes = [
    { id: "1", name: "Prod", isDefault: false },
    { id: "2", name: "Default Permission Scheme", isDefault: true },
    { id: "3", name: "Legacy", isDefault: false },
  ];
  const schemeProjects = [{ schemeId: "1", projectId: "10" }];
  const holders = [
    { schemeId: "1", context: "BROWSE_PROJECTS", holderType: "anyone", holderValue: "" },
    { schemeId: "1", context: "ADMINISTER_PROJECTS", holderType: "group", holderValue: "g-admins" },
    { schemeId: "3", context: "CREATE_ISSUES", holderType: "user", holderValue: "acc-gone" },
    { schemeId: "3", context: "EDIT_ISSUES", holderType: "user", holderValue: "acc-1" },
  ];

  test("flags anyone-browse, group-admin and direct-user grants; counts off-roster ones", () => {
    const s = summarizePermissionInsights({ schemes, holders, schemeProjects, rosterAccountIds: roster });
    expect(s.riskySchemeCount).toBe(2); // scheme 1 (anyone/group) and scheme 3 (user grants)
    expect(s.directUserGrantCount).toBe(2);
    expect(s.offRosterUserGrantCount).toBe(1); // only acc-gone
  });

  test("unused = no project assignment, and never the default scheme", () => {
    const s = summarizePermissionInsights({ schemes, holders, schemeProjects, rosterAccountIds: roster });
    // scheme 2 is default (excluded), scheme 3 has no project -> 1 unused.
    expect(s.unusedSchemeCount).toBe(1);
    expect(s.unusedSchemes.map((x) => x.id)).toEqual(["3"]);
  });

  test("health carries the rate inputs", () => {
    const s = summarizePermissionInsights({ schemes, holders, schemeProjects, rosterAccountIds: roster });
    expect(summarizePermissionHealth(s)).toMatchObject({ available: true, totalSchemes: 3, riskySchemeCount: 2, unusedSchemeCount: 1 });
  });
});

describe("summarizeSecurityInsights", () => {
  const schemes = [
    { id: "s1", name: "Restricted", defaultLevelId: "L1" },
    { id: "s2", name: "Empty scheme" },
  ];
  const levels = [
    { schemeId: "s1", id: "L1", name: "Internal" },
    { schemeId: "s1", id: "L2", name: "Nobody" },
  ];
  const holders = [
    { schemeId: "s1", context: "L1", holderType: "group", holderValue: "g-staff" },
    { schemeId: "s1", context: "L1", holderType: "user", holderValue: "acc-gone" },
  ];
  const schemeProjects = [{ schemeId: "s1", projectId: "10" }];

  test("flags empty levels, schemes with no levels, and unused schemes", () => {
    const s = summarizeSecurityInsights({ schemes, levels, holders, schemeProjects, rosterAccountIds: roster });
    expect(s.emptyLevelCount).toBe(1); // L2 has no members
    expect(s.noLevelSchemeCount).toBe(1); // s2
    expect(s.unusedSchemeCount).toBe(1); // s2 has no project
    expect(s.offRosterMemberCount).toBe(1);
  });

  test("health folds empty levels and no-level schemes into one broken count", () => {
    const s = summarizeSecurityInsights({ schemes, levels, holders, schemeProjects, rosterAccountIds: roster });
    expect(summarizeSecurityHealth(s)).toMatchObject({ available: true, totalLevels: 2, brokenLevelCount: 2, unusedSchemeCount: 1 });
  });
});

describe("summarizeNotificationInsights", () => {
  const schemes = [
    { id: "n1", name: "Prod notifications", isDefault: false },
    { id: "n2", name: "Default Notification Scheme", isDefault: true },
  ];
  const holders = [
    { schemeId: "n1", context: "1", holderType: "user", holderValue: "acc-1" },
    { schemeId: "n1", context: "2", holderType: "projectRole", holderValue: "role-10" },
  ];
  const schemeProjects = [{ schemeId: "n1", projectId: "10" }];

  test("flags a scheme routing an event to a named individual", () => {
    const s = summarizeNotificationInsights({ schemes, holders, schemeProjects, rosterAccountIds: roster });
    expect(s.fragileSchemeCount).toBe(1);
    expect(s.offRosterRecipientCount).toBe(0);
  });

  test("unused excludes the default notification scheme", () => {
    const s = summarizeNotificationInsights({ schemes, holders, schemeProjects, rosterAccountIds: roster });
    // n2 is default and has no project -> not counted; n1 has a project -> not counted.
    expect(s.unusedSchemeCount).toBe(0);
  });
});

describe("summarizeRoleInsights", () => {
  const roles = [
    { id: "10002", name: "Administrators" },
    { id: "10003", name: "Members" },
  ];
  // holders: user|group actors, plus an "empty" sentinel for a (role, project) with nobody.
  const holders = [
    { schemeId: "10002", context: "1", contextLabel: "OPS", holderType: "group", holderValue: "g-admins", holderLabel: "admins" },
    { schemeId: "10002", context: "2", contextLabel: "DEV", holderType: "empty", holderValue: "", holderLabel: "Administrators" },
    { schemeId: "10003", context: "1", contextLabel: "OPS", holderType: "user", holderValue: "acc-1" },
    { schemeId: "10003", context: "2", contextLabel: "DEV", holderType: "user", holderValue: "acc-gone" },
  ];

  test("counts projects whose admin role has no actor, and off-roster actors", () => {
    const s = summarizeRoleInsights({ roles, holders, rosterAccountIds: roster });
    expect(s.available).toBe(true);
    expect(s.totalRoles).toBe(2);
    expect(s.projectsWithRoles).toBe(2);            // OPS, DEV
    expect(s.projectsMissingAdminActorCount).toBe(1); // DEV's Administrators is the empty sentinel
    expect(s.projectsMissingAdminActor[0]).toMatchObject({ projectKey: "DEV", role: "Administrators" });
    expect(s.directUserActorCount).toBe(2);
    expect(s.offRosterActorCount).toBe(1);          // acc-gone
  });

  test("health carries the coverage inputs, and unavailable follows an empty input", () => {
    const s = summarizeRoleInsights({ roles, holders, rosterAccountIds: roster });
    expect(summarizeRoleHealth(s)).toMatchObject({ available: true, projectsWithRoles: 2, projectsMissingAdminActorCount: 1 });
    expect(summarizeRoleInsights({}).available).toBe(false);
    expect(summarizeRoleHealth(summarizeRoleInsights({}))).toEqual({ available: false });
  });

  // Regression: the health summary dropped the two actor counts, so the score always read
  // zero off-roster actors and reported Actor hygiene 100 beside a finding counting 1,071.
  test("health carries the actor counts the role-actor-hygiene dimension scores from", () => {
    const health = summarizeRoleHealth(summarizeRoleInsights({ roles, holders, rosterAccountIds: roster }));
    expect(health).toMatchObject({ offRosterActorCount: 1, directUserActorCount: 2 });

    const dim = computeSiteHealth({ roles: health }).dimensions.find((d) => d.key === "role-actor-hygiene");
    expect(dim.available).toBe(true);
    expect(dim.score).toBeLessThan(100);
    expect(dim.detail).toMatch(/1 project-role actors are accounts no longer on the licensed roster/);
  });
});

describe("unmeasured", () => {
  test("every summariser reports unavailable on an empty input, and health follows", () => {
    for (const [ins, hp] of [
      [summarizePermissionInsights({}), summarizePermissionHealth],
      [summarizeSecurityInsights({}), summarizeSecurityHealth],
      [summarizeNotificationInsights({}), summarizeNotificationHealth],
      [summarizeRoleInsights({}), summarizeRoleHealth],
    ]) {
      expect(ins.available).toBe(false);
      expect(hp(ins)).toEqual({ available: false });
    }
  });
});

describe("listLimit", () => {
  const schemes = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));

  it("trims the per-item lists to 25 for the tab by default, and not at all for remediation", () => {
    expect(summarizePermissionInsights({ schemes }).unusedSchemes).toHaveLength(25);
    const full = summarizePermissionInsights({ schemes, listLimit: Infinity });
    expect(full.unusedSchemes).toHaveLength(40);
    // The counts never depended on the limit.
    expect(full.unusedSchemeCount).toBe(40);
  });
});

// Public and logged-in grants, as the spec defines them: `anyone` is anonymous users, and an
// applicationRole grant with no application is "any logged-in user".
describe("public and logged-in grants", () => {
  const scheme = { id: "1", name: "Open scheme" };
  const grant = (context, holderType, holderValue = "") => ({ schemeId: "1", context, holderType, holderValue });

  test("any permission open to anonymous users is a risky reason, browse or not", () => {
    const s = summarizePermissionInsights({
      schemes: [scheme],
      holders: [grant("CREATE_ISSUES", "anyone"), grant("ADD_COMMENTS", "anyone")],
      schemeProjects: [{ schemeId: "1" }],
    });
    expect(s.riskySchemes[0].reasons).toEqual(["2 other permissions open to anonymous users (public): CREATE_ISSUES, ADD_COMMENTS"]);
    expect(s.publicSchemeCount).toBe(1);
  });

  test("a sensitive permission for every logged-in user is risky; browse for everyone is only counted", () => {
    const s = summarizePermissionInsights({
      schemes: [scheme],
      holders: [grant("BROWSE_PROJECTS", "applicationRole"), grant("DELETE_ISSUES", "applicationRole"), grant("EDIT_ISSUES", "applicationRole", "jira-software")],
    });
    expect(s.riskySchemes[0].reasons).toEqual(["1 sensitive permission granted to every logged-in user: DELETE_ISSUES"]);
    expect(s.loggedInSensitiveSchemeCount).toBe(1);
    // The grant naming an application is not "every logged-in user".
    expect(s.loggedInGrantCount).toBe(2);
  });

  test("notifications to a raw email address make a scheme fragile; groups are counted", () => {
    const s = summarizeNotificationInsights({
      schemes: [{ id: "n1", name: "Mailer" }],
      holders: [
        { schemeId: "n1", holderType: "emailAddress", holderValue: "ops@vendor.example" },
        { schemeId: "n1", holderType: "group", holderValue: "g1" },
      ],
    });
    expect(s.fragileSchemes).toEqual([{ id: "n1", name: "Mailer", namedUserCount: 0, emailAddressCount: 1, groupRecipientCount: 1 }]);
    expect(s).toMatchObject({ fragileSchemeCount: 1, emailRecipientCount: 1, groupRecipientCount: 1 });
  });
});

// Reported 7 Oct 2026: projects with several people in "Administrators" were flagged because
// "Administrators-EXTERNAL" was empty. Both roles hold Administer Projects; one filled is enough.
describe("projects nobody can administer", () => {
  const roles = [
    { id: "10002", name: "Administrators" },
    { id: "10010", name: "Administrators-EXTERNAL" },
    { id: "10003", name: "Members" },
  ];
  const holder = (roleId, projectId, key, type, value = "") => ({ schemeId: roleId, context: projectId, contextLabel: key, holderType: type, holderValue: value });
  const holders = [
    // OPS: Administrators full, EXTERNAL empty -> administered
    holder("10002", "1", "OPS", "user", "acc-1"), holder("10002", "1", "OPS", "user", "acc-2"),
    holder("10010", "1", "OPS", "empty"), holder("10003", "1", "OPS", "user", "acc-3"),
    // EXT: only EXTERNAL filled -> administered
    holder("10002", "2", "EXT", "empty"), holder("10010", "2", "EXT", "group", "g-vendor"),
    // DEV: both empty -> nobody can administer
    holder("10002", "3", "DEV", "empty"), holder("10010", "3", "DEV", "empty"), holder("10003", "3", "DEV", "user", "acc-4"),
  ];
  const grant = (schemeId, type, value = "") => ({ schemeId, context: "ADMINISTER_PROJECTS", holderType: type, holderValue: value });

  test("by role name, any one filled admin role is enough", () => {
    const s = summarizeRoleInsights({ roles, holders, rosterAccountIds: new Set(["acc-1", "acc-2", "acc-3", "acc-4"]) });
    expect(s.projectsMissingAdminActorCount).toBe(1);
    expect(s.projectsMissingAdminActor).toEqual([
      { projectId: "3", projectKey: "DEV", role: "Administrators, Administrators-EXTERNAL", roles: ["Administrators", "Administrators-EXTERNAL"] },
    ]);
  });

  test("with permission data, the roles granted Administer Projects decide, whatever their name", () => {
    const permHolders = [grant("P1", "projectRole", "10010"), grant("P1", "projectRole", "10003")];
    const permProjects = [{ schemeId: "P1", projectId: "1" }, { schemeId: "P1", projectId: "2" }, { schemeId: "P1", projectId: "3" }];
    const s = summarizeRoleInsights({ roles, holders, permHolders, permProjects });
    // Scheme P1 grants admin to EXTERNAL and Members, not to "Administrators". OPS has a Member,
    // EXT has an EXTERNAL group, DEV has a Member -- all administered.
    expect(s.projectsMissingAdminActorCount).toBe(0);
  });

  test("a direct grant (group, lead) means the project is administered even with every role empty", () => {
    const permHolders = [grant("P1", "projectRole", "10002"), grant("P2", "projectRole", "10002"), grant("P2", "projectLead")];
    const permProjects = [{ schemeId: "P1", projectId: "3" }, { schemeId: "P2", projectId: "2" }];
    const s = summarizeRoleInsights({ roles, holders, permHolders, permProjects });
    // DEV (P1): only Administrators can administer and it is empty. EXT (P2): the lead can.
    expect(s.projectsMissingAdminActor.map((p) => p.projectKey)).toEqual(["DEV"]);
    expect(s.projectsMissingAdminActor[0].role).toBe("Administrators");
  });

  test("a scheme that grants Administer Projects to nobody leaves the project unadministered", () => {
    const permHolders = [{ schemeId: "P1", context: "BROWSE_PROJECTS", holderType: "anyone", holderValue: "" }];
    const s = summarizeRoleInsights({ roles, holders, permHolders, permProjects: [{ schemeId: "P1", projectId: "1" }] });
    // OPS (on P1) despite its full Administrators role; DEV still by name (no permission data).
    expect(s.projectsMissingAdminActor.map((p) => p.projectKey)).toEqual(["OPS", "DEV"]);
    expect(s.projectsMissingAdminActor[0]).toEqual({ projectId: "1", projectKey: "OPS", role: "no role is granted Administer Projects", roles: [] });
  });

  test("adminCapabilityByProject reads roles and direct grants per scheme", () => {
    const cap = adminCapabilityByProject(
      [grant("P1", "projectRole", "10002"), grant("P1", "group", "g1"), { schemeId: "P1", context: "BROWSE_PROJECTS", holderType: "projectRole", holderValue: "10003" }],
      [{ schemeId: "P1", projectId: "7" }, { schemeId: "P9", projectId: "8" }],
    );
    expect([...cap.get("7").roleIds]).toEqual(["10002"]);
    expect(cap.get("7").direct).toBe(true);
    expect(cap.get("8")).toEqual({ roleIds: new Set(), direct: false });
  });
});
