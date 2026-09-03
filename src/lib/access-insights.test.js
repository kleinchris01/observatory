import { describe, test, expect } from "vitest";
import {
  summarizePermissionInsights, summarizePermissionHealth,
  summarizeSecurityInsights, summarizeSecurityHealth,
  summarizeNotificationInsights, summarizeNotificationHealth,
  summarizeRoleInsights, summarizeRoleHealth,
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
