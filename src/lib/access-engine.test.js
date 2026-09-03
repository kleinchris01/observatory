import { vi, describe, test, expect, beforeEach } from "vitest";

vi.mock("./jira-api.js", () => ({
  incrMetric: vi.fn(),
  METRIC_NAMES: { accessSnapshotStarted: "a", accessSnapshotCompleted: "b", accessSnapshotFailed: "c" },
  mapWithConcurrency: vi.fn(async (items, _c, fn) => {
    const out = [];
    for (let i = 0; i < items.length; i++) out.push(await fn(items[i], i));
    return out;
  }),
  getAllJiraProjects: vi.fn(async () => []),
  getAllPermissionSchemes: vi.fn(async () => []),
  getProjectPermissionScheme: vi.fn(async () => null),
  getAllIssueSecuritySchemes: vi.fn(async () => []),
  getIssueSecurityLevels: vi.fn(async () => []),
  getIssueSecurityLevelMembers: vi.fn(async () => []),
  getIssueSecuritySchemeProjects: vi.fn(async () => []),
  getAllNotificationSchemes: vi.fn(async () => []),
  getAllProjectRoles: vi.fn(async () => []),
  getProjectRolesForProject: vi.fn(async () => []),
}));
vi.mock("./queues.js", () => ({ inventorySnapshotQueue: { push: vi.fn() } }));
vi.mock("./project-store.js", () => ({
  ensureProjectStoreReady: vi.fn(),
  writeAccessSnapshotMeta: vi.fn(),
  readAccessSnapshotMeta: vi.fn(),
  replaceAccessSnapshot: vi.fn(),
}));
vi.mock("./logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  normalizePermissionScheme,
  permissionGrantsToHolders,
  notificationEventsToHolders,
  isAccessBuildStale,
  queueAccessSnapshotBuild,
  buildAccessSnapshot,
} from "./access-engine.js";
import * as jiraApi from "./jira-api.js";
import { inventorySnapshotQueue } from "./queues.js";
import { replaceAccessSnapshot, writeAccessSnapshotMeta } from "./project-store.js";

beforeEach(() => vi.clearAllMocks());

describe("normalizers", () => {
  test("normalizePermissionScheme flags the default by name", () => {
    expect(normalizePermissionScheme({ id: 1, name: "Default Permission Scheme" }).isDefault).toBe(true);
    expect(normalizePermissionScheme({ id: 2, name: "Prod" }).isDefault).toBe(false);
  });

  test("permissionGrantsToHolders keeps the durable id per holder type", () => {
    const holders = permissionGrantsToHolders({
      id: 5,
      permissions: [
        { permission: "BROWSE_PROJECTS", holder: { type: "anyone" } },
        { permission: "ADMINISTER_PROJECTS", holder: { type: "group", value: "g-1", group: { name: "site-admins" } } },
        { permission: "CREATE_ISSUES", holder: { type: "user", value: "acc-1", user: { displayName: "Ann" } } },
      ],
    });
    expect(holders).toEqual(expect.arrayContaining([
      expect.objectContaining({ context: "BROWSE_PROJECTS", holderType: "anyone", holderValue: "" }),
      expect.objectContaining({ holderType: "group", holderValue: "g-1", holderLabel: "site-admins" }),
      expect.objectContaining({ holderType: "user", holderValue: "acc-1", holderLabel: "Ann" }),
    ]));
  });

  test("notificationEventsToHolders maps Jira's recipient vocabulary onto the shared one", () => {
    const holders = notificationEventsToHolders({
      id: 9,
      notificationSchemeEvents: [
        { event: { id: 1, name: "Issue Created" }, notifications: [
          { notificationType: "CurrentAssignee" },
          { notificationType: "User", parameter: "acc-2" },
          { notificationType: "ProjectRole", parameter: "role-10" },
        ] },
      ],
    });
    expect(holders.map((h) => `${h.holderType}:${h.holderValue}`)).toEqual([
      "assignee:", "user:acc-2", "projectRole:role-10",
    ]);
    expect(holders[0].contextLabel).toBe("Issue Created");
  });
});

describe("isAccessBuildStale", () => {
  test("false unless building, true past the window", () => {
    expect(isAccessBuildStale({ state: "ready" })).toBe(false);
    expect(isAccessBuildStale({ state: "building", startedAt: new Date().toISOString() })).toBe(false);
    expect(isAccessBuildStale({ state: "building", startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() })).toBe(true);
  });
});

describe("queueAccessSnapshotBuild", () => {
  test("marks building then pushes the job", async () => {
    await queueAccessSnapshotBuild("inst");
    expect(writeAccessSnapshotMeta).toHaveBeenCalledWith("inst", expect.objectContaining({ state: "building" }));
    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith({ body: { jobType: "build-access-snapshot", installationKey: "inst" } });
  });
});

describe("buildAccessSnapshot", () => {
  test("writes all three scheme types with holders, levels and project assignments", async () => {
    jiraApi.getAllJiraProjects.mockResolvedValue([{ id: "10", key: "OPS", name: "Ops" }]);
    jiraApi.getAllPermissionSchemes.mockResolvedValue([
      { id: 1, name: "Prod", permissions: [{ permission: "BROWSE_PROJECTS", holder: { type: "projectRole", value: "role-1" } }] },
    ]);
    jiraApi.getProjectPermissionScheme.mockResolvedValue({ id: 1, name: "Prod" });
    jiraApi.getAllIssueSecuritySchemes.mockResolvedValue([{ id: "s1", name: "Sec", defaultSecurityLevelId: "L1" }]);
    jiraApi.getIssueSecurityLevels.mockResolvedValue([{ id: "L1", name: "Internal" }]);
    jiraApi.getIssueSecurityLevelMembers.mockResolvedValue([{ issueSecurityLevelId: "L1", holder: { type: "group", value: "g-staff" } }]);
    jiraApi.getIssueSecuritySchemeProjects.mockResolvedValue([{ issueSecuritySchemeId: "s1", projectIds: ["10"] }]);
    jiraApi.getAllNotificationSchemes.mockResolvedValue([
      { id: "n1", name: "Notif", projects: ["10"], notificationSchemeEvents: [
        { event: { id: 1, name: "Created" }, notifications: [{ notificationType: "User", parameter: "acc-1" }] },
      ] },
    ]);

    const result = await buildAccessSnapshot("inst");

    expect(result).toMatchObject({ permission: 1, security: 1, notification: 1 });
    const [, version, payload] = replaceAccessSnapshot.mock.calls[0];
    expect(version).toEqual(expect.any(String));
    expect(payload.schemes.map((s) => s.schemeType).sort()).toEqual(["notification", "permission", "security"]);
    expect(payload.levels).toHaveLength(1);
    expect(payload.holders.some((h) => h.schemeType === "notification" && h.holderValue === "acc-1")).toBe(true);
    expect(payload.schemeProjects.some((p) => p.schemeType === "security" && p.projectId === "10")).toBe(true);
    expect(writeAccessSnapshotMeta).toHaveBeenLastCalledWith("inst", expect.objectContaining({ state: "ready" }));
  });

  test("folds project roles into the schemes/holders tables, with an empty-role sentinel", async () => {
    jiraApi.getAllJiraProjects.mockResolvedValue([{ id: "10", key: "OPS", name: "Ops" }]);
    jiraApi.getAllPermissionSchemes.mockResolvedValue([]);
    jiraApi.getAllIssueSecuritySchemes.mockResolvedValue([]);
    jiraApi.getAllNotificationSchemes.mockResolvedValue([]);
    jiraApi.getAllProjectRoles.mockResolvedValue([
      { id: 10002, name: "Administrators", description: "" },
      { id: 10003, name: "Members", description: "" },
    ]);
    jiraApi.getProjectRolesForProject.mockResolvedValue([
      { roleId: "10002", roleName: "Administrators", actors: [{ type: "group", groupId: "g-admins", displayName: "admins" }] },
      { roleId: "10003", roleName: "Members", actors: [] },
    ]);

    const result = await buildAccessSnapshot("inst");

    expect(result.projectRole).toBe(2);
    const [, , payload] = replaceAccessSnapshot.mock.calls[0];
    expect(payload.schemes.some((s) => s.schemeType === "project-role" && s.id === "10002")).toBe(true);
    expect(payload.holders.some((h) => h.schemeType === "project-role" && h.holderType === "group" && h.holderValue === "g-admins")).toBe(true);
    // Members has no actors on OPS -> a sentinel row so "empty here" is queryable.
    expect(payload.holders.some((h) => h.schemeType === "project-role" && h.schemeId === "10003" && h.holderType === "empty")).toBe(true);
    expect(writeAccessSnapshotMeta).toHaveBeenLastCalledWith("inst", expect.objectContaining({ totalProjectRoles: 2 }));
  });

  test("marks the build failed and rethrows on a hard error", async () => {
    jiraApi.getAllJiraProjects.mockResolvedValue([]);
    jiraApi.getAllPermissionSchemes.mockResolvedValue([]);
    jiraApi.getAllIssueSecuritySchemes.mockResolvedValue([]);
    jiraApi.getAllNotificationSchemes.mockResolvedValue([]);
    jiraApi.getAllProjectRoles.mockResolvedValue([]);
    replaceAccessSnapshot.mockRejectedValueOnce(new Error("sql down"));

    await expect(buildAccessSnapshot("inst")).rejects.toThrow("sql down");
    expect(writeAccessSnapshotMeta).toHaveBeenLastCalledWith("inst", expect.objectContaining({ state: "failed" }));
  });
});
