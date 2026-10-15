import { describe, test, expect, vi, beforeEach } from "vitest";

// Remediation for the thin-pillar checks (14 Oct 2026): every new health check has a playbook,
// a candidate loader, and an Overview finding with the same key, so "Start remediation" and
// "Plan the fix" work for each. The loaders read the same access and estate inventories the
// tabs do, mocked here at that boundary.
const m = vi.hoisted(() => ({ getAccessInventory: vi.fn(), getEstateInventory: vi.fn() }));
vi.mock("./access.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getAccessInventory: m.getAccessInventory,
}));
vi.mock("./estate.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getEstateInventory: m.getEstateInventory,
}));

import { REMEDIATION_CANDIDATE_LOADERS } from "./remediation.js";
import { getPlaybook, REMEDIATION_FINDING_INDEX } from "../lib/remediation-playbooks.js";
import {
  summarizePermissionInsights,
  summarizeSecurityInsights,
  summarizeNotificationInsights,
  summarizeRoleInsights,
} from "../lib/access-insights.js";

const NEW_KEYS = [
  "permission-public-access",
  "permission-everyone-sensitive",
  "permission-direct-grants",
  "permission-departed-grants",
  "security-direct-members",
  "security-departed-members",
  "notification-external-email",
  "notification-departed-recipients",
  "role-group-actors",
  "role-unused",
  "priority-usage",
  "resolution-usage",
  "estate-defaults",
];
const context = {};
const load = (key) => REMEDIATION_CANDIDATE_LOADERS[key]({ context, installationKey: "k" });

// An access inventory built by the real summarisers, as getAccessInventory builds it.
function accessInventory({ roster = new Set(["acc-1"]) } = {}) {
  const schemeProjects = [{ schemeId: "1", projectId: "10" }];
  return {
    neverBuilt: false,
    permissions: {
      governance: summarizePermissionInsights({
        schemes: [{ id: "1", name: "Prod" }],
        holders: [
          { schemeId: "1", context: "BROWSE_PROJECTS", holderType: "anyone", holderValue: "" },
          { schemeId: "1", context: "DELETE_ISSUES", holderType: "applicationRole", holderValue: "" },
          { schemeId: "1", context: "EDIT_ISSUES", holderType: "user", holderValue: "acc-1" },
          { schemeId: "1", context: "ASSIGN_ISSUES", holderType: "user", holderValue: "acc-gone" },
        ],
        schemeProjects,
        rosterAccountIds: roster,
        listLimit: Infinity,
      }),
    },
    security: {
      governance: summarizeSecurityInsights({
        schemes: [{ id: "s1", name: "Secure" }],
        levels: [{ schemeId: "s1", id: "l1", name: "Internal" }],
        holders: [
          { schemeId: "s1", context: "l1", holderType: "user", holderValue: "acc-1" },
          { schemeId: "s1", context: "l1", holderType: "user", holderValue: "acc-gone" },
        ],
        schemeProjects: [{ schemeId: "s1", projectId: "10" }],
        rosterAccountIds: roster,
        listLimit: Infinity,
      }),
    },
    notifications: {
      governance: summarizeNotificationInsights({
        schemes: [{ id: "n1", name: "Prod notifications" }],
        holders: [
          {
            schemeId: "n1",
            context: "1",
            contextLabel: "Issue Created",
            holderType: "emailAddress",
            holderValue: "ext@example.com",
          },
          { schemeId: "n1", context: "2", contextLabel: "Issue Resolved", holderType: "user", holderValue: "acc-gone" },
        ],
        schemeProjects: [{ schemeId: "n1", projectId: "10" }],
        rosterAccountIds: roster,
        listLimit: Infinity,
      }),
    },
    roles: {
      governance: summarizeRoleInsights({
        roles: [
          { id: "a", name: "Developers" },
          { id: "b", name: "Viewers" },
        ],
        holders: [{ schemeId: "a", context: "10", contextLabel: "OPS", holderType: "user", holderValue: "acc-1" }],
        rosterAccountIds: roster,
        listLimit: Infinity,
      }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getAccessInventory.mockResolvedValue(accessInventory());
  m.getEstateInventory.mockResolvedValue({
    neverBuilt: false,
    usageMeasured: true,
    priorities: [
      { id: "1", name: "High", issueCount: 40, isDefault: true },
      { id: "2", name: "Trivial", issueCount: 0 },
    ],
    resolutions: [
      { id: "10", name: "Done", issueCount: 9 },
      { id: "11", name: "Won't Do", issueCount: 0 },
    ],
  });
});

describe("every new check can be remediated", () => {
  test.each(NEW_KEYS)("%s has a playbook, a loader and an Overview finding of the same key", (key) => {
    const playbook = getPlaybook(key);
    expect(playbook).toBeTruthy();
    expect(playbook.findings).toContain(key);
    expect(REMEDIATION_FINDING_INDEX[key]).toBe(key);
    expect(typeof REMEDIATION_CANDIDATE_LOADERS[key]).toBe("function");
  });

  test.each(NEW_KEYS)("%s writes an epic and a task for its first item", async (key) => {
    const { items } = await load(key);
    expect(items.length).toBeGreaterThan(0);
    const playbook = getPlaybook(key);
    expect(playbook.epicSummary(items.length)).toMatch(/\w/);
    expect(playbook.taskSummary(items[0])).not.toMatch(/undefined/);
    expect(playbook.taskDescription(items[0], { origin: "https://acme.atlassian.net" })).not.toMatch(/undefined/);
  });
});

describe("candidate items", () => {
  test("permission loaders: one item per scheme, with the grants that need changing", async () => {
    expect((await load("permission-public-access")).items).toEqual([
      expect.objectContaining({ id: "1", permissions: ["BROWSE_PROJECTS"] }),
    ]);
    expect((await load("permission-everyone-sensitive")).items[0].permissions).toEqual(["DELETE_ISSUES"]);
    expect((await load("permission-direct-grants")).items[0].grants.map((g) => g.accountId)).toEqual([
      "acc-1",
      "acc-gone",
    ]);
    // Only the departed grant, not every named one.
    expect((await load("permission-departed-grants")).items[0].grants).toEqual([
      { permission: "ASSIGN_ISSUES", accountId: "acc-gone", departed: true },
    ]);
  });

  test("security and notification loaders keep only what each task is about", async () => {
    expect((await load("security-direct-members")).items[0].members).toHaveLength(2);
    expect((await load("security-departed-members")).items[0].members).toEqual([
      { levelId: "l1", levelName: "Internal", accountId: "acc-gone", departed: true },
    ]);
    expect((await load("notification-external-email")).items[0]).toMatchObject({
      id: "n1",
      addresses: ["ext@example.com"],
      events: 1,
    });
    expect((await load("notification-departed-recipients")).items[0].recipients).toEqual([
      { event: "Issue Resolved", accountId: "acc-gone", departed: true },
    ]);
  });

  test("roles: individuals bounded by project, and the roles nobody holds", async () => {
    const actors = (await load("role-group-actors")).items;
    expect(actors).toEqual([expect.objectContaining({ id: "OPS", count: 1 })]);
    expect((await load("role-unused")).items).toEqual([{ id: "b", name: "Viewers" }]);
  });

  test("estate: unused values, and the list with no default", async () => {
    expect((await load("priority-usage")).items).toEqual([
      { id: "2", kind: "priority", name: "Trivial", isDefault: false },
    ]);
    expect((await load("resolution-usage")).items).toEqual([
      { id: "11", kind: "resolution", name: "Won't Do", isDefault: false },
    ]);
    expect((await load("estate-defaults")).items).toEqual([{ id: "resolution", kind: "resolution", valueCount: 2 }]);
  });
});

describe("what the loaders refuse to guess", () => {
  // Without a roster every account would look departed; a task list of everyone is worse than none.
  test("departed-account loaders need the People roster", async () => {
    m.getAccessInventory.mockResolvedValue(accessInventory({ roster: new Set() }));
    for (const key of ["permission-departed-grants", "security-departed-members", "notification-departed-recipients"]) {
      expect(await load(key)).toEqual({ available: false, reason: "no-roster", items: [] });
    }
  });

  test("usage loaders need the issue crawl", async () => {
    m.getEstateInventory.mockResolvedValueOnce({
      neverBuilt: false,
      usageMeasured: false,
      priorities: [{ id: "2", name: "Trivial", issueCount: null }],
    });
    expect(await load("priority-usage")).toEqual({ available: false, reason: "no-usage", items: [] });
  });

  test("a list the snapshot did not return is empty, not missing a default", async () => {
    m.getEstateInventory.mockResolvedValue({ neverBuilt: false, usageMeasured: true });
    expect(await load("estate-defaults")).toEqual({ available: true, items: [] });
    expect(await load("resolution-usage")).toEqual({ available: true, items: [] });
    m.getEstateInventory.mockResolvedValueOnce({ neverBuilt: true });
    expect(await load("priority-usage")).toEqual({ available: false, reason: "no-snapshot", items: [] });
  });

  test("nothing to load before the inventories exist", async () => {
    m.getAccessInventory.mockResolvedValueOnce({ neverBuilt: true });
    expect((await load("permission-public-access")).available).toBe(false);
    m.getEstateInventory.mockResolvedValueOnce({ neverBuilt: true });
    expect(await load("estate-defaults")).toEqual({ available: false, reason: "no-snapshot", items: [] });
  });
});
