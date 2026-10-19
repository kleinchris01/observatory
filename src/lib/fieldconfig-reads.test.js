import { vi, describe, test, expect, beforeEach, afterEach } from "vitest";

const store = vi.hoisted(() => ({
  ensureProjectStoreReady: vi.fn(async () => {}),
  readFieldConfigSnapshotMeta: vi.fn(),
  loadFieldConfigSchemes: vi.fn(async () => []),
  loadFieldConfigConfigs: vi.fn(async () => []),
  loadFieldConfigMappings: vi.fn(async () => []),
  loadFieldConfigSchemeProjects: vi.fn(async () => []),
  loadFieldConfigItemsForField: vi.fn(async () => []),
  loadFieldConfigItemsForOwner: vi.fn(async () => ({ total: 0, items: [] })),
  readIssueTypeSnapshotMeta: vi.fn(async () => ({ version: "it1" })),
  loadIssueTypes: vi.fn(async () => [{ id: "10001", name: "Build Deviation" }]),
  readSnapshotMeta: vi.fn(async () => ({ version: "f1" })),
  loadSnapshotFields: vi.fn(async () => [{ id: "customfield_1", name: "Total Cost" }]),
}));

vi.mock("./project-store.js", () => store);
vi.mock("./jira-api.js", () => ({ incrMetric: vi.fn(), METRIC_NAMES: {}, getInstallationKey: () => "site" }));
vi.mock("./fieldconfig-engine.js", () => ({ isFieldConfigBuildStale: () => false }));

import {
  getFieldConfigInventory,
  getFieldConfigItems,
  getFieldBehaviour,
  rovoFieldConfigSearch,
  rovoFieldConfigInspect,
  rovoFieldConfigImpact,
} from "./fieldconfig-reads.js";

const ctx = { context: {} };
beforeEach(() => vi.clearAllMocks());

describe("getFieldConfigInventory", () => {
  test("never built is a state, not an empty estate", async () => {
    store.readFieldConfigSnapshotMeta.mockResolvedValueOnce(null);
    expect(await getFieldConfigInventory(ctx)).toMatchObject({
      neverBuilt: true,
      schemes: [],
      summary: null,
      state: "idle",
    });
  });

  test("joins projects and routes, names fields and work types, and says which model it read", async () => {
    store.readFieldConfigSnapshotMeta.mockResolvedValueOnce({
      version: "v1",
      state: "ready",
      source: "field-configurations",
      fallbackReason: "404",
      summary: { usageJudged: 2 },
      inconsistentRequired: [{ fieldId: "customfield_1", requiredIn: 1, optionalIn: 2 }],
    });
    store.loadFieldConfigSchemes.mockResolvedValueOnce([{ id: "fcs:5", name: "Build scheme", projectCount: 1 }]);
    store.loadFieldConfigConfigs.mockResolvedValueOnce([
      { id: "fc:2", name: "Build fields", requiredHidden: ["customfield_1"] },
    ]);
    store.loadFieldConfigMappings.mockResolvedValueOnce([{ schemeId: "fcs:5", workTypeId: "10001", configId: "fc:2" }]);
    store.loadFieldConfigSchemeProjects.mockResolvedValueOnce([
      { schemeId: "fcs:5", projectId: "10", projectKey: "BLD", projectName: "Build" },
    ]);

    const result = await getFieldConfigInventory(ctx);
    expect(result).toMatchObject({
      neverBuilt: false,
      sourceLabel: "Field configurations (legacy)",
      fallbackReason: "404",
    });
    expect(result.schemes[0]).toMatchObject({
      projects: [{ projectKey: "BLD" }],
      routes: [{ workTypeName: "Build Deviation", configName: "Build fields" }],
    });
    expect(result.configs[0].requiredHidden).toEqual([{ fieldId: "customfield_1", fieldName: "Total Cost" }]);
    expect(result.inconsistentRequired[0].fieldName).toBe("Total Cost");
  });
});

describe("getFieldConfigItems", () => {
  test("requires an owner and labels what it returns", async () => {
    await expect(getFieldConfigItems({ payload: {}, ...ctx })).rejects.toThrow(/ownerId/);

    store.readFieldConfigSnapshotMeta.mockResolvedValueOnce({ version: "v1", source: "field-schemes" });
    store.loadFieldConfigItemsForOwner.mockResolvedValueOnce({
      total: 1,
      items: [{ fieldId: "summary", workTypeId: "*", restrictedTo: ["10001"] }],
    });
    const result = await getFieldConfigItems({
      payload: { ownerKind: "scheme", ownerId: "fs:1", requiredOnly: true },
      ...ctx,
    });
    expect(store.loadFieldConfigItemsForOwner).toHaveBeenCalledWith(
      "site",
      "v1",
      "scheme",
      "fs:1",
      expect.objectContaining({ requiredOnly: true }),
    );
    expect(result.items[0]).toMatchObject({
      fieldName: "Summary",
      workTypeName: "All work types",
      restrictedToNames: ["Build Deviation"],
    });
    expect(result.notableOnly).toBe(false);
  });
});

describe("getFieldBehaviour", () => {
  test("on field schemes, names where a field is required and where it does not exist at all", async () => {
    store.readFieldConfigSnapshotMeta.mockResolvedValueOnce({ version: "v1", source: "field-schemes" });
    store.loadFieldConfigSchemes.mockResolvedValueOnce([
      { id: "fs:1", name: "Default", isDefault: true, projectCount: 3, measured: true },
      { id: "fs:2", name: "Build", projectCount: 1, measured: true },
      { id: "fs:3", name: "Ops", projectCount: 2, measured: true },
      { id: "fs:4", name: "Unused", projectCount: 0, measured: true },
    ]);
    store.loadFieldConfigSchemeProjects.mockResolvedValueOnce([{ schemeId: "fs:2", projectKey: "BLD" }]);
    store.loadFieldConfigItemsForField.mockResolvedValueOnce([
      {
        ownerKind: "scheme",
        ownerId: "fs:1",
        workTypeId: "*",
        fieldId: "customfield_1",
        required: false,
        restrictedTo: [],
      },
      {
        ownerKind: "scheme",
        ownerId: "fs:2",
        workTypeId: "*",
        fieldId: "customfield_1",
        required: true,
        restrictedTo: ["10001"],
      },
      { ownerKind: "scheme", ownerId: "fs:2", workTypeId: "10001", fieldId: "customfield_1", required: false },
    ]);

    const result = await getFieldBehaviour({ payload: { fieldId: "customfield_1" }, ...ctx });
    expect(result).toMatchObject({ available: true, fieldName: "Total Cost", requiredIn: 1 });
    expect(result.owners.map((o) => o.id)).toEqual(["fs:1", "fs:2", "fs:3"]);
    expect(result.owners[1]).toMatchObject({
      required: true,
      restrictedTo: ["Build Deviation"],
      projectKeys: ["BLD"],
      overrides: [{ workTypeName: "Build Deviation", required: false }],
    });
    expect(result.missingFrom.map((o) => o.id)).toEqual(["fs:3"]);
  });

  test("on legacy configurations, a read configuration with no item means visible and optional; an unread one is unknown", async () => {
    store.readFieldConfigSnapshotMeta.mockResolvedValueOnce({ version: "v1", source: "field-configurations" });
    store.loadFieldConfigConfigs.mockResolvedValueOnce([
      { id: "fc:1", name: "Default", used: true, itemsRead: true },
      { id: "fc:2", name: "Build", used: true, itemsRead: true },
      { id: "fc:3", name: "Unread", used: true, itemsRead: false },
    ]);
    store.loadFieldConfigItemsForField.mockResolvedValueOnce([
      { ownerKind: "config", ownerId: "fc:2", workTypeId: "*", fieldId: "customfield_1", required: true, hidden: true },
    ]);

    const result = await getFieldBehaviour({ payload: { fieldId: "customfield_1" }, ...ctx });
    const by = Object.fromEntries(result.owners.map((o) => [o.id, o]));
    expect(by["fc:1"]).toMatchObject({ required: false, hidden: false });
    expect(by["fc:3"]).toMatchObject({ required: null, hidden: null });
    expect(result.conflicts.map((c) => c.id)).toEqual(["fc:2"]);
  });

  test("no snapshot is unavailable, and a field id is required", async () => {
    store.readFieldConfigSnapshotMeta.mockResolvedValueOnce(null);
    expect(await getFieldBehaviour({ payload: { fieldId: "x" }, ...ctx })).toMatchObject({
      available: false,
      reason: "no-snapshot",
    });
    await expect(getFieldBehaviour({ payload: {}, ...ctx })).rejects.toThrow(/fieldId/);
  });
});

// The agent contract: a result, or "<pillar>-unavailable" -- never an empty list that reads as
// "nothing is configured" -- and always the snapshot age.
describe("Rovo actions", () => {
  const built = () => {
    store.readFieldConfigSnapshotMeta.mockResolvedValue({
      version: "v1",
      refreshedAt: "2026-10-05T00:00:00Z",
      source: "field-configurations",
      summary: {},
    });
    store.loadFieldConfigSchemes.mockResolvedValue([
      { id: "fcs:5", name: "Build scheme", projectCount: 1, codes: ["duplicate"], duplicateOf: "fcs:6" },
    ]);
    store.loadFieldConfigConfigs.mockResolvedValue([
      {
        id: "fc:2",
        name: "Build fields",
        used: true,
        itemsRead: true,
        requiredHidden: ["customfield_1"],
        codes: ["required-hidden"],
      },
    ]);
    store.loadFieldConfigMappings.mockResolvedValue([{ schemeId: "fcs:5", workTypeId: "10001", configId: "fc:2" }]);
    store.loadFieldConfigSchemeProjects.mockResolvedValue([{ schemeId: "fcs:5", projectId: "10", projectKey: "BLD" }]);
  };
  afterEach(() => {
    for (const fn of [
      "readFieldConfigSnapshotMeta",
      "loadFieldConfigSchemes",
      "loadFieldConfigConfigs",
      "loadFieldConfigMappings",
      "loadFieldConfigSchemeProjects",
      "loadFieldConfigItemsForField",
    ])
      store[fn].mockReset();
    for (const fn of [
      "loadFieldConfigSchemes",
      "loadFieldConfigConfigs",
      "loadFieldConfigMappings",
      "loadFieldConfigSchemeProjects",
      "loadFieldConfigItemsForField",
    ])
      store[fn].mockResolvedValue([]);
  });

  test("unbuilt is field schemes-unavailable, from every action", async () => {
    store.readFieldConfigSnapshotMeta.mockResolvedValue(null);
    expect((await rovoFieldConfigSearch({ query: "x" }, {})).status).toBe("field schemes-unavailable");
    expect((await rovoFieldConfigInspect({ identifier: "x" }, {})).status).toBe("field schemes-unavailable");
    expect((await rovoFieldConfigImpact({ field: "customfield_1" }, {})).status).toBe("field schemes-unavailable");
  });

  test("search finds schemes by project key and names the model", async () => {
    built();
    const result = await rovoFieldConfigSearch({ query: "BLD" }, {});
    expect(result).toMatchObject({
      status: "ok",
      refreshedAt: "2026-10-05T00:00:00Z",
      model: "Field configurations (legacy)",
    });
    expect(result.schemes[0]).toMatchObject({ name: "Build scheme", findings: ["duplicate"] });
    expect((await rovoFieldConfigSearch({ query: " " }, {})).status).toBe("error");
  });

  test("inspect returns one configuration with its routing and the fields it requires and hides", async () => {
    built();
    store.loadFieldConfigItemsForOwner.mockResolvedValueOnce({
      total: 1,
      items: [{ fieldId: "customfield_1", workTypeId: "*" }],
    });
    const result = await rovoFieldConfigInspect({ identifier: "Build fields" }, {});
    expect(result).toMatchObject({
      status: "ok",
      kind: "field configuration",
      name: "Build fields",
      requiredHiddenFields: ["Total Cost"],
      requiredFields: ["Total Cost"],
      routes: ["Build scheme: Build Deviation -> Build fields"],
    });
    expect((await rovoFieldConfigInspect({ identifier: "nope zzz" }, {})).status).toBe("not-found");
  });

  test("impact resolves a field by name and reports where it is required but hidden", async () => {
    built();
    store.loadFieldConfigItemsForField.mockResolvedValueOnce([
      { ownerKind: "config", ownerId: "fc:2", workTypeId: "*", fieldId: "customfield_1", required: true, hidden: true },
    ]);
    const result = await rovoFieldConfigImpact({ field: "Total Cost" }, {});
    expect(result).toMatchObject({
      status: "ok",
      field: { id: "customfield_1", name: "Total Cost" },
      requiredIn: 1,
      requiredButHiddenIn: ["Build fields"],
    });
    expect(result.owners[0].usedBy[0]).toMatch(/Build scheme \(Build Deviation, 1 projects\)/);
    expect((await rovoFieldConfigImpact({ field: "" }, {})).status).toBe("error");
  });
});
