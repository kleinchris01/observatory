import { vi, describe, test, expect, beforeEach } from "vitest";

vi.mock("./jira-api.js", () => ({
  incrMetric: vi.fn(),
  METRIC_NAMES: { jsmSnapshotStarted: "a", jsmSnapshotCompleted: "b", jsmSnapshotFailed: "c" },
  getFieldCatalog: vi.fn(),
  getServiceDesks: vi.fn(),
  getServiceDeskRequestTypes: vi.fn(),
  getServiceDeskRequestTypeGroups: vi.fn(),
  getRequestTypeFields: vi.fn(),
  getServiceDeskQueues: vi.fn(),
  countServiceDeskCustomers: vi.fn(),
  getServiceDeskOrganizations: vi.fn(),
  getOrganizations: vi.fn(),
  countOrganizationMembers: vi.fn(),
  countIssues: vi.fn(),
  mapWithConcurrency: async (items, _n, fn) => Promise.all(items.map((item, i) => fn(item, i))),
  probeEndpoint: vi.fn(),
  probeJqlCount: vi.fn(),
}));
vi.mock("./queues.js", () => ({ inventorySnapshotQueue: { push: vi.fn() } }));
vi.mock("./logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./project-store.js", () => ({
  ensureProjectStoreReady: vi.fn(),
  writeJsmSnapshotMeta: vi.fn(),
  replaceJsmSnapshot: vi.fn(),
}));

import {
  buildJsmSnapshot,
  queueJsmSnapshotBuild,
  isJsmBuildStale,
  normalizeRequestType,
  normalizeQueue,
  desksUnavailableReason,
  JSM_WALK_BUDGET_MS,
} from "./jsm-engine.js";
import * as api from "./jira-api.js";
import { inventorySnapshotQueue } from "./queues.js";
import { replaceJsmSnapshot, writeJsmSnapshotMeta } from "./project-store.js";

const lastMeta = () => writeJsmSnapshotMeta.mock.calls.at(-1)[1];
const httpError = (status) => Object.assign(new Error(`failed ${status}`), { status });

function siteWithOneDesk() {
  api.getServiceDesks.mockResolvedValue([{ id: 1, projectId: 100, projectKey: "SD", projectName: "Service" }]);
  api.getFieldCatalog.mockResolvedValue([
    { id: "customfield_1", name: "Time to resolution", schema: { custom: "com.atlassian.servicedesk:sd-sla-field" } },
    { id: "customfield_2", name: "Request Type", schema: { custom: "com.atlassian.servicedesk:vp-origin" } },
  ]);
  api.getOrganizations.mockResolvedValue([
    { id: 5, name: "Acme" },
    { id: 6, name: "Orphan Ltd" },
  ]);
  api.getServiceDeskRequestTypes.mockResolvedValue([
    { id: 10, name: "Get help", description: "For anything", groupIds: [1], issueTypeId: 3 },
    { id: 11, name: "Old form", description: "", groupIds: [] },
  ]);
  api.getServiceDeskRequestTypeGroups.mockResolvedValue([{ id: 1 }]);
  api.getRequestTypeFields.mockResolvedValue([
    { fieldId: "summary", name: "Summary", required: true },
    { fieldId: "customfield_9", name: "Asset", required: false },
  ]);
  api.getServiceDeskQueues.mockResolvedValue([
    { id: 7, name: "Broken", jql: "cf[404] = x", issueCount: 2 },
    { id: 8, name: "Open", jql: "project = SD", issueCount: 0 },
  ]);
  api.getServiceDeskOrganizations.mockResolvedValue([{ id: 5 }]);
  api.countServiceDeskCustomers.mockResolvedValue({ count: 2000, complete: false });
  api.countOrganizationMembers.mockImplementation(async (id) => ({ count: id === "5" ? 3 : 0, complete: true }));
  // Request type 10 had requests; 11 none recently and none ever. The SLA ran on 20, 5 breached.
  api.countIssues.mockImplementation(async (jql) => {
    if (jql.includes('"Get help"')) return 12;
    if (jql.includes('"Old form"')) return 0;
    if (jql.includes("everBreached")) return 5;
    if (jql.includes("running()")) return 20;
    return null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  writeJsmSnapshotMeta.mockResolvedValue(undefined);
});

describe("helpers", () => {
  test("stale only while building and past the window, or with no start time", () => {
    expect(isJsmBuildStale({ state: "ready" })).toBe(false);
    expect(isJsmBuildStale({ state: "building", startedAt: new Date().toISOString() })).toBe(false);
    expect(isJsmBuildStale({ state: "building", startedAt: "nonsense" })).toBe(true);
    expect(isJsmBuildStale({ state: "building", startedAt: "2020-01-01T00:00:00Z" })).toBe(true);
  });

  test("a request type has a description if either text is set", () => {
    expect(normalizeRequestType(1, { id: 2, name: "X", helpText: "Use this" })).toMatchObject({
      deskId: "1",
      id: "2",
      hasDescription: true,
      groupIds: [],
    });
  });

  test("a queue without a count is unmeasured, and its refs are checked against the catalog", () => {
    expect(normalizeQueue(1, { id: 2, jql: "cf[3] = 1" }, new Set())).toMatchObject({
      issueCount: null,
      brokenRefs: ["customfield_3"],
    });
    expect(normalizeQueue(1, { id: 2 }, null)).toMatchObject({ jql: "", brokenRefs: null });
  });

  test("names why the desk list did not answer", () => {
    expect(desksUnavailableReason(httpError(404))).toMatch(/not on this site/);
    expect(desksUnavailableReason(httpError(401))).toMatch(/scope is missing/);
    expect(desksUnavailableReason(httpError(403))).toMatch(/403/);
    expect(desksUnavailableReason(httpError(500))).toBeNull();
  });

  test("queueing marks the build and pushes the job", async () => {
    await queueJsmSnapshotBuild("inst");
    expect(writeJsmSnapshotMeta).toHaveBeenCalledWith("inst", expect.objectContaining({ state: "building" }));
    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith({
      body: { jobType: "build-jsm-snapshot", installationKey: "inst" },
    });
  });
});

describe("buildJsmSnapshot", () => {
  test("reads one desk end to end and stores counts, never people", async () => {
    siteWithOneDesk();
    const result = await buildJsmSnapshot("inst");

    expect(result).toMatchObject({ desks: 1, requestTypes: 2, queues: 2, unread: 0 });
    const [scope, , rows] = replaceJsmSnapshot.mock.calls[0];
    expect(scope).toBe("inst");
    expect(rows.desks[0]).toMatchObject({
      deskId: "1",
      projectKey: "SD",
      customerCount: 2000,
      customersComplete: false,
      orgCount: 1,
      portalGroupCount: 1,
    });
    expect(rows.requestTypes.map((r) => [r.name, r.recentCount, r.issueCount])).toEqual([
      ["Get help", 12, null],
      ["Old form", 0, 0],
    ]);
    expect(rows.requestTypeFields).toHaveLength(4);
    expect(rows.queues.map((q) => q.brokenRefs)).toEqual([["customfield_404"], []]);
    expect(rows.slas).toEqual([
      {
        deskId: "1",
        fieldId: "customfield_1",
        fieldName: "Time to resolution",
        activeCount: 20,
        breachedCount: 5,
      },
    ]);
    expect(rows.organizations).toEqual([
      { id: "5", name: "Acme", memberCount: 3, membersComplete: true, deskCount: 1 },
      { id: "6", name: "Orphan Ltd", memberCount: 0, membersComplete: true, deskCount: 0 },
    ]);
    // Nothing that names a person reaches the store.
    expect(JSON.stringify(rows)).not.toMatch(/email|displayName/i);

    const meta = lastMeta();
    expect(meta).toMatchObject({ state: "ready", jsmEnabled: true, totalDesks: 1, unreadCount: 0 });
    expect(meta.summary.queues).toMatchObject({ broken: 1, empty: 1 });
    expect(meta.summary.slas).toMatchObject({ breachRate: 0.25 });
  });

  test("request volume uses the request type field; without it, volume is unmeasured", async () => {
    siteWithOneDesk();
    api.getFieldCatalog.mockResolvedValue([]);
    await buildJsmSnapshot("inst");
    const rows = replaceJsmSnapshot.mock.calls[0][2];
    expect(rows.requestTypes.every((r) => r.recentCount === null)).toBe(true);
    expect(rows.slas).toEqual([]);
  });

  test("an unread catalog leaves queue refs unchecked rather than clean", async () => {
    siteWithOneDesk();
    api.getFieldCatalog.mockRejectedValueOnce(new Error("down"));
    await buildJsmSnapshot("inst");
    expect(replaceJsmSnapshot.mock.calls[0][2].queues.every((q) => q.brokenRefs === null)).toBe(true);
    expect(lastMeta().summary.slas.known).toBe(false);
  });

  test("failed sub-reads degrade to unread, not to zero", async () => {
    siteWithOneDesk();
    api.getServiceDeskRequestTypeGroups.mockRejectedValueOnce(new Error("x"));
    api.getRequestTypeFields.mockRejectedValue(new Error("x"));
    api.countServiceDeskCustomers.mockRejectedValueOnce(new Error("x"));
    api.getOrganizations.mockRejectedValueOnce(new Error("x"));
    const result = await buildJsmSnapshot("inst");
    const rows = replaceJsmSnapshot.mock.calls[0][2];
    expect(rows.desks[0]).toMatchObject({ portalGroupCount: null, customerCount: null });
    expect(rows.requestTypes[0]).toMatchObject({ fieldCount: null, requiredFieldCount: null });
    expect(rows.organizations).toEqual([]);
    expect(result.unread).toBe(3);
    // Unread groups mean no request type can be called hidden.
    expect(lastMeta().summary.requestTypes.hidden).toBe(0);
  });

  test("past the time budget, everything after is unmeasured", async () => {
    siteWithOneDesk();
    let t = 0;
    const now = () => (t += JSM_WALK_BUDGET_MS);
    const result = await buildJsmSnapshot("inst", { now });
    expect(result.unread).toBeGreaterThan(0);
    expect(api.countIssues).not.toHaveBeenCalled();
  });

  test("a site with no JSM or no desks is a terminal success, not a failure", async () => {
    api.getServiceDesks.mockRejectedValueOnce(httpError(404));
    expect(await buildJsmSnapshot("inst")).toEqual({
      unavailable: true,
      reason: expect.stringMatching(/not on this site/),
    });
    expect(lastMeta()).toMatchObject({ state: "unavailable", jsmEnabled: false });

    api.getServiceDesks.mockResolvedValueOnce([]);
    expect(await buildJsmSnapshot("inst")).toMatchObject({
      unavailable: true,
      reason: expect.stringMatching(/no service desks/),
    });
    expect(replaceJsmSnapshot).not.toHaveBeenCalled();
  });

  test("a missing scope fails loudly", async () => {
    api.getServiceDesks.mockRejectedValueOnce(httpError(401));
    await expect(buildJsmSnapshot("inst")).rejects.toThrow(/scope is missing/);
    expect(lastMeta()).toMatchObject({ state: "failed", lastError: expect.stringMatching(/scope is missing/) });
  });

  test("an unexpected desk-list error fails with its own message", async () => {
    api.getServiceDesks.mockRejectedValueOnce(httpError(500));
    await expect(buildJsmSnapshot("inst")).rejects.toThrow(/failed 500/);
  });
});
