import { vi, describe, test, expect, beforeEach } from "vitest";

// What to pin: accessGroupsFromApplicationRoles turning the applicationrole payload into the
// access-group set + seat summary, normalizeUser's defensive shape, and buildUserSnapshot
// folding many groups into one roster row per account with accumulated products.

vi.mock("./jira-api.js", () => ({
  incrMetric: vi.fn(),
  METRIC_NAMES: {
    userSnapshotStarted: "user-snapshot-started",
    userSnapshotCompleted: "user-snapshot-completed",
    userSnapshotFailed: "user-snapshot-failed",
  },
  getApplicationRoles: vi.fn(),
  getGroupMembers: vi.fn(),
  mapWithConcurrency: vi.fn(async (items, _c, fn) => {
    const out = [];
    for (let i = 0; i < items.length; i++) out.push(await fn(items[i], i));
    return out;
  }),
}));

vi.mock("./queues.js", () => ({ inventorySnapshotQueue: { push: vi.fn() } }));

vi.mock("./project-store.js", () => ({
  ensureProjectStoreReady: vi.fn(),
  writeUserSnapshotMeta: vi.fn(),
  readUserSnapshotMeta: vi.fn(),
  replaceUserSnapshot: vi.fn(),
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  fallbackOn: () => () => undefined,
  ignoreWith: () => () => undefined,
}));

import {
  normalizeUser,
  accessGroupsFromApplicationRoles,
  isUserBuildStale,
  buildUserSnapshot,
  queueUserSnapshotBuild,
} from "./user-engine.js";
import { getApplicationRoles, getGroupMembers } from "./jira-api.js";
import { inventorySnapshotQueue } from "./queues.js";
import { replaceUserSnapshot, writeUserSnapshotMeta } from "./project-store.js";

beforeEach(() => vi.clearAllMocks());

describe("normalizeUser", () => {
  test("keeps accountId and reads active tri-state as a boolean, defaulting true", () => {
    expect(normalizeUser({ accountId: "a1", displayName: "Ann", active: false, accountType: "atlassian" }))
      .toEqual({ accountId: "a1", displayName: "Ann", active: false, accountType: "atlassian", avatarUrl: null });
    expect(normalizeUser({ accountId: "a2" }).active).toBe(true);
  });

  test("prefers the 48px avatar, falls back to 32px, then null", () => {
    expect(normalizeUser({ accountId: "a", avatarUrls: { "48x48": "big", "32x32": "small" } }).avatarUrl).toBe("big");
    expect(normalizeUser({ accountId: "a", avatarUrls: { "32x32": "small" } }).avatarUrl).toBe("small");
    expect(normalizeUser({ accountId: "a" }).avatarUrl).toBe(null);
  });
});

describe("accessGroupsFromApplicationRoles", () => {
  const roles = [
    {
      key: "jira-software", name: "Jira Software", defined: true,
      numberOfSeats: 500, remainingSeats: 123, userCount: 377, hasUnlimitedSeats: false,
      groupDetails: [{ groupId: "g-sw", name: "jira-software-users" }, { groupId: "g-shared", name: "everyone-access" }],
    },
    {
      key: "jira-servicedesk", name: "Jira Service Management", defined: true,
      numberOfSeats: 50, remainingSeats: 10, userCount: 40, hasUnlimitedSeats: false,
      groupDetails: [{ groupId: "g-sd", name: "jsm-users" }, { groupId: "g-shared", name: "everyone-access" }],
    },
    { key: "jira-core", name: "Jira Work Management", defined: false, groupDetails: [{ groupId: "g-core" }] },
  ];

  test("unions the access groups and records which products each grants", () => {
    const { groups } = accessGroupsFromApplicationRoles(roles);
    const shared = groups.find((g) => g.id === "g-shared");
    expect(shared.applications.map((a) => a.key).sort()).toEqual(["jira-servicedesk", "jira-software"]);
    // The undefined product contributes nothing.
    expect(groups.some((g) => g.id === "g-core")).toBe(false);
  });

  test("carries the seat numbers through as the summary", () => {
    const { summary } = accessGroupsFromApplicationRoles(roles);
    expect(summary).toContainEqual(expect.objectContaining({
      key: "jira-software", numberOfSeats: 500, remainingSeats: 123, userCount: 377,
    }));
    expect(summary.some((s) => s.key === "jira-core")).toBe(false);
  });
});

describe("isUserBuildStale", () => {
  test("false unless building, true once past the window or with no heartbeat", () => {
    expect(isUserBuildStale({ state: "ready" })).toBe(false);
    expect(isUserBuildStale({ state: "building", startedAt: new Date().toISOString() })).toBe(false);
    expect(isUserBuildStale({ state: "building", startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() })).toBe(true);
    expect(isUserBuildStale({ state: "building" })).toBe(true);
  });
});

describe("queueUserSnapshotBuild", () => {
  test("marks building then pushes the job", async () => {
    await queueUserSnapshotBuild("inst");
    expect(writeUserSnapshotMeta).toHaveBeenCalledWith("inst", expect.objectContaining({ state: "building" }));
    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith({ body: { jobType: "build-user-snapshot", installationKey: "inst" } });
  });
});

describe("buildUserSnapshot", () => {
  test("folds members from several groups into one roster row per account", async () => {
    getApplicationRoles.mockResolvedValue([
      { key: "jira-software", name: "Jira Software", defined: true, userCount: 2, numberOfSeats: 5,
        groupDetails: [{ groupId: "g-sw", name: "sw" }] },
      { key: "jira-servicedesk", name: "JSM", defined: true, userCount: 1, numberOfSeats: 3,
        groupDetails: [{ groupId: "g-sd", name: "sd" }] },
    ]);
    getGroupMembers.mockImplementation(async (groupId) =>
      groupId === "g-sw"
        ? [{ accountId: "a1", displayName: "Ann", active: true }, { accountId: "a2", displayName: "Bo", active: true }]
        : [{ accountId: "a1", displayName: "Ann", active: true }]
    );

    const result = await buildUserSnapshot("inst");

    expect(result).toMatchObject({ users: 2, groups: 2 });
    const [, , payload] = replaceUserSnapshot.mock.calls[0];
    expect(payload.users.map((u) => u.accountId).sort()).toEqual(["a1", "a2"]);
    // Ann holds both products; one access row per product she has via g-sw / g-sd.
    const annAccess = payload.access.filter((a) => a.accountId === "a1").map((a) => a.applicationKey).sort();
    expect(annAccess).toEqual(["jira-servicedesk", "jira-software"]);
    const ready = writeUserSnapshotMeta.mock.calls.map((c) => c[1]).find((p) => p.state === "ready");
    expect(ready).toMatchObject({ totalUsers: 2, activeUsers: 2 });
  });

  test("fails loudly rather than publishing an empty roster when no access groups come back", async () => {
    getApplicationRoles.mockResolvedValue([]);
    const result = await buildUserSnapshot("inst");
    expect(result.error).toMatch(/application-access groups/i);
    expect(replaceUserSnapshot).not.toHaveBeenCalled();
    const failed = writeUserSnapshotMeta.mock.calls.map((c) => c[1]).find((p) => p.state === "failed");
    expect(failed).toBeTruthy();
  });
});
