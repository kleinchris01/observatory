import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, ctxWithAccount } from "../test-harness.js";
import { rovoJsmSearch, rovoJsmInspect, rovoJsmImpact } from "../../resolvers.js";

installResolverTestDefaults();

const ctx = () => ctxWithAccount();

function seed() {
  mocks.readJsmSnapshotMeta.mockResolvedValue({
    state: "ready",
    version: "j1",
    refreshedAt: "2026-10-19T00:00:00.000Z",
    summary: { available: true },
  });
  mocks.loadJsmDesks.mockResolvedValue([
    {
      deskId: "1",
      projectKey: "SD",
      projectName: "IT Service Desk",
      portalGroupCount: 2,
      customerCount: 2000,
      customersComplete: false,
      orgCount: 1,
    },
    {
      deskId: "2",
      projectKey: "HR",
      projectName: "People Help",
      portalGroupCount: 1,
      customerCount: 40,
      customersComplete: true,
      orgCount: 0,
    },
  ]);
  mocks.loadJsmRequestTypes.mockResolvedValue([
    {
      deskId: "1",
      id: "10",
      name: "Laptop request",
      hasDescription: true,
      groupIds: ["1"],
      fieldCount: 5,
      requiredFieldCount: 2,
      recentCount: 30,
    },
    {
      deskId: "1",
      id: "11",
      name: "Legacy laptop",
      hasDescription: false,
      groupIds: [],
      recentCount: 0,
      issueCount: 0,
    },
    { deskId: "2", id: "20", name: "Onboarding", hasDescription: true, groupIds: ["1"], recentCount: 5 },
  ]);
  mocks.loadJsmQueues.mockResolvedValue([
    { deskId: "1", id: "7", name: "Laptops", jql: "project = SD AND cf[10030] = Yes", issueCount: 4, brokenRefs: [] },
    { deskId: "2", id: "8", name: "Team queue", jql: 'project = HR AND "Team" = Ops', issueCount: 0, brokenRefs: [] },
  ]);
  mocks.loadJsmSlas.mockResolvedValue([
    { deskId: "1", fieldId: "customfield_1", fieldName: "Time to resolution", activeCount: 20, breachedCount: 15 },
    { deskId: "2", fieldId: "customfield_1", fieldName: "Time to resolution", activeCount: 10, breachedCount: 1 },
  ]);
  mocks.loadJsmOrganizations.mockResolvedValue([{ id: "4", name: "Laptop Lovers Ltd", memberCount: 0, deskCount: 1 }]);
  mocks.loadJsmRequestTypeFields.mockResolvedValue([
    { deskId: "1", requestTypeId: "10", fieldId: "customfield_10030", label: "Needs approval", required: true },
    { deskId: "2", requestTypeId: "20", fieldId: "summary", label: "Summary", required: true },
  ]);
}

describe("rovo Service Management agent", () => {
  test("every action says the snapshot is missing rather than answering empty", async () => {
    for (const run of [
      () => rovoJsmSearch({ query: "laptop" }, ctx()),
      () => rovoJsmInspect({ identifier: "SD" }, ctx()),
      () => rovoJsmImpact({ field: "customfield_1" }, ctx()),
    ]) {
      expect(await run()).toMatchObject({ status: "service management-unavailable" });
    }
  });

  test("a site with no service desk is an ok answer, not missing data", async () => {
    mocks.readJsmSnapshotMeta.mockResolvedValue({
      state: "unavailable",
      refreshedAt: "2026-10-19T00:00:00Z",
      lastError: "No desks.",
    });
    expect(await rovoJsmSearch({ query: "x" }, ctx())).toMatchObject({
      status: "ok",
      jsmEnabled: false,
      message: "No desks.",
    });
  });

  test("required inputs are required", async () => {
    expect(await rovoJsmSearch({}, ctx())).toMatchObject({ status: "error" });
    expect(await rovoJsmInspect({}, ctx())).toMatchObject({ status: "error" });
    expect(await rovoJsmImpact({}, ctx())).toMatchObject({ status: "error" });
  });

  test("search ranks across every kind and carries findings and the notice", async () => {
    seed();
    const result = await rovoJsmSearch({ query: "laptop" }, ctx());
    expect(result).toMatchObject({
      status: "ok",
      refreshedAt: "2026-10-19T00:00:00.000Z",
      userTextNotice: expect.any(String),
    });
    expect(result.requestTypes.map((r) => r.name)).toEqual(["Laptop request", "Legacy laptop"]);
    expect(result.requestTypes[1].findings.map((f) => f.code)).toEqual(["hidden", "unused", "undescribed"]);
    expect(result.queues.map((q) => q.name)).toEqual(["Laptops"]);
    expect(result.organizations.map((o) => o.name)).toEqual(["Laptop Lovers Ltd"]);
    const onlyQueues = await rovoJsmSearch({ query: "laptop", kind: "queue" }, ctx());
    expect(onlyQueues.requestTypes).toEqual([]);
    expect(onlyQueues.queues).toHaveLength(1);
    const desks = await rovoJsmSearch({ query: "SD", kind: "desk" }, ctx());
    expect(desks.desks[0]).toMatchObject({ projectKey: "SD", customers: 2000, customersIsLowerBound: true });
    const slas = await rovoJsmSearch({ query: "resolution", kind: "sla" }, ctx());
    expect(slas.slas[0]).toMatchObject({ requestsMeasured: 30, breached: 16 });
  });

  test("inspect reads one desk by key or name, with its SLA outcomes", async () => {
    seed();
    const result = await rovoJsmInspect({ identifier: "sd" }, ctx());
    expect(result.desk).toMatchObject({ projectKey: "SD", customersIsLowerBound: true });
    expect(result.requestTypes.map((r) => [r.name, r.onPortal])).toEqual([
      ["Laptop request", true],
      ["Legacy laptop", false],
    ]);
    expect(result.slas).toEqual([
      { name: "Time to resolution", fieldId: "customfield_1", requestsMeasured: 20, breached: 15 },
    ]);
    expect(result.notes.join(" ")).toMatch(/SLA goals/);
    expect((await rovoJsmInspect({ identifier: "People Help" }, ctx())).desk.projectKey).toBe("HR");
    expect(await rovoJsmInspect({ identifier: "zzz-nothing" }, ctx())).toMatchObject({ status: "not-found" });
  });

  test("impact finds the request types showing a field and the queues naming it", async () => {
    seed();
    const byId = await rovoJsmImpact({ field: "customfield_10030" }, ctx());
    expect(byId.requestTypes).toEqual([
      { desk: "SD", requestType: "Laptop request", label: "Needs approval", required: true },
    ]);
    expect(byId.queues.map((q) => q.name)).toEqual(["Laptops"]);
    expect(byId.coverage).toMatch(/does not cover/);

    const byLabel = await rovoJsmImpact({ field: "Needs approval" }, ctx());
    expect(byLabel.queues.map((q) => q.name)).toEqual(["Laptops"]);

    const byName = await rovoJsmImpact({ field: "team" }, ctx());
    expect(byName.requestTypes).toEqual([]);
    expect(byName.queues.map((q) => q.name)).toEqual(["Team queue"]);
  });

  test("errors are counted and rethrown", async () => {
    mocks.readJsmSnapshotMeta.mockRejectedValueOnce(new Error("sql down"));
    await expect(rovoJsmSearch({ query: "x" }, ctx())).rejects.toThrow("sql down");
    mocks.readJsmSnapshotMeta.mockRejectedValueOnce(new Error("sql down"));
    await expect(rovoJsmInspect({ identifier: "x" }, ctx())).rejects.toThrow("sql down");
    mocks.readJsmSnapshotMeta.mockRejectedValueOnce(new Error("sql down"));
    await expect(rovoJsmImpact({ field: "x" }, ctx())).rejects.toThrow("sql down");
  });
});
