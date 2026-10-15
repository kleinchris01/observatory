import { vi, describe, test, expect, beforeEach } from "vitest";

const api = vi.hoisted(() => ({
  getAllJiraProjects: vi.fn(),
  getAllFieldSchemes: vi.fn(),
  getFieldSchemeProjectAssignments: vi.fn(),
  getFieldSchemeFields: vi.fn(),
  getAllFieldConfigurations: vi.fn(),
  getFieldConfigurationItems: vi.fn(),
  getAllFieldConfigurationSchemes: vi.fn(),
  getFieldConfigurationSchemeMappings: vi.fn(),
  getFieldConfigurationSchemeProjects: vi.fn(),
}));
const store = vi.hoisted(() => ({
  ensureProjectStoreReady: vi.fn(async () => {}),
  writeFieldConfigSnapshotMeta: vi.fn(async () => {}),
  replaceFieldConfigSnapshot: vi.fn(async () => {}),
}));

vi.mock("./jira-api.js", () => ({
  incrMetric: vi.fn(),
  METRIC_NAMES: {},
  // Real bounded concurrency, sequential here: enough to exercise the walk.
  mapWithConcurrency: async (items, _c, fn) => {
    const out = [];
    for (const [i, x] of items.entries()) out.push(await fn(x, i));
    return out;
  },
  ...api,
}));
vi.mock("./project-store.js", () => store);
vi.mock("./queues.js", () => ({ inventorySnapshotQueue: { push: vi.fn() } }));
vi.mock("./logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  readFieldBehaviour,
  buildFieldConfigSnapshot,
  normalizeSchemeField,
  isNotableItem,
  normalizeConfigItem,
  walkWithBudget,
  isFieldConfigBuildStale,
  queueFieldConfigSnapshotBuild,
  LEGACY_DEFAULT_SCHEME_ID,
} from "./fieldconfig-engine.js";

const projects = [
  { id: "10", key: "BLD", name: "Build" },
  { id: "20", key: "OPS", name: "Ops" },
];

function legacySite() {
  api.getAllFieldConfigurations.mockResolvedValue([
    { id: 1, name: "Default Field Configuration", isDefault: true },
    { id: 2, name: "Build fields" },
  ]);
  api.getAllFieldConfigurationSchemes.mockResolvedValue([{ id: 5, name: "Build scheme" }]);
  api.getFieldConfigurationSchemeMappings.mockResolvedValue([
    { fieldConfigurationSchemeId: "5", issueTypeId: "default", fieldConfigurationId: "2" },
  ]);
  api.getFieldConfigurationSchemeProjects.mockResolvedValue([
    { projectIds: ["20"] },
    { fieldConfigurationScheme: { id: "5" }, projectIds: ["10"] },
  ]);
  api.getFieldConfigurationItems.mockImplementation(async (id) =>
    id === "2"
      ? [
          { id: "customfield_1", isRequired: true, isHidden: true },
          { id: "summary", isRequired: true },
          { id: "customfield_2" },
        ]
      : [{ id: "summary", isRequired: true }],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getAllJiraProjects.mockResolvedValue(projects);
});

describe("normalisers", () => {
  test("a field scheme field becomes a base row plus one row per work-type override", () => {
    const rows = normalizeSchemeField("fs:1", {
      fieldId: "customfield_1",
      parameters: { isRequired: false, description: "Cost in USD", rendererType: "text" },
      restrictedToWorkTypes: [10001],
      workTypeParameters: [{ workTypeId: 10002, isRequired: true }, { isRequired: true }],
    });
    expect(rows).toEqual([
      expect.objectContaining({
        ownerId: "fs:1",
        workTypeId: "*",
        required: false,
        description: "Cost in USD",
        restrictedTo: ["10001"],
        associated: true,
      }),
      expect.objectContaining({ workTypeId: "10002", required: true }),
    ]);
    expect(normalizeSchemeField("fs:1", {})).toEqual([]);
  });

  test("a legacy item is kept only when it says something", () => {
    expect(isNotableItem({ isHidden: true })).toBe(true);
    expect(isNotableItem({ isRequired: true })).toBe(true);
    expect(isNotableItem({ description: "Why" })).toBe(true);
    expect(isNotableItem({ id: "x", isHidden: false, isRequired: false, renderer: "wiki-renderer" })).toBe(false);
    expect(normalizeConfigItem("fc:2", { id: "customfield_1", isHidden: true, isRequired: true })).toMatchObject({
      hidden: true,
      required: true,
      workTypeId: "*",
    });
  });
});

describe("walkWithBudget", () => {
  test("stops at the budget and records the rest as unread, never as empty", async () => {
    let clock = 0;
    const now = () => clock;
    const { rows, read } = await walkWithBudget(
      [
        { id: "a", sourceId: "1" },
        { id: "b", sourceId: "2" },
      ],
      async () => {
        clock += 100;
        return [{ id: "x" }];
      },
      (id, items) => items.map((i) => ({ ownerId: id, fieldId: i.id })),
      { budgetMs: 50, now },
    );
    expect(rows).toEqual([{ ownerId: "a", fieldId: "x" }]);
    expect(read.get("a")).toEqual({ read: true, fieldCount: 1 });
    expect(read.get("b")).toMatchObject({ read: false, reason: "time budget" });
  });

  test("a failed owner is unread with its reason, and the walk carries on", async () => {
    const { read } = await walkWithBudget(
      [
        { id: "a", sourceId: "1" },
        { id: "b", sourceId: "2" },
      ],
      async (id) => {
        if (id === "1") throw new Error("403");
        return [];
      },
      () => [],
    );
    expect(read.get("a")).toMatchObject({ read: false, reason: "403" });
    expect(read.get("b")).toEqual({ read: true, fieldCount: 0 });
  });
});

describe("readFieldBehaviour", () => {
  test("uses field schemes when the site has them", async () => {
    api.getAllFieldSchemes.mockResolvedValue([
      { id: 1, name: "Default", isDefault: true },
      { id: 2, name: "Build" },
    ]);
    api.getFieldSchemeProjectAssignments.mockResolvedValue([
      { projectId: 10, schemeId: 2 },
      { projectId: 20, schemeId: 1 },
    ]);
    api.getFieldSchemeFields.mockResolvedValue([{ fieldId: "customfield_1", parameters: { isRequired: true } }]);

    const model = await readFieldBehaviour({ projects });
    expect(model.source).toBe("field-schemes");
    expect(model.fallbackReason).toBeNull();
    expect(model.schemeProjects).toEqual([
      { schemeId: "fs:2", projectId: "10", projectKey: "BLD", projectName: "Build" },
      { schemeId: "fs:1", projectId: "20", projectKey: "OPS", projectName: "Ops" },
    ]);
    expect(model.items).toHaveLength(2);
    expect(api.getAllFieldConfigurations).not.toHaveBeenCalled();
  });

  test("falls back to field configurations, and says why, when field schemes are not there", async () => {
    api.getAllFieldSchemes.mockRejectedValue(new Error("Jira request failed (404): not found"));
    legacySite();

    const model = await readFieldBehaviour({ projects });
    expect(model.source).toBe("field-configurations");
    expect(model.fallbackReason).toMatch(/404/);
    // The implicit default scheme carries the unassigned project and routes to the default configuration.
    expect(model.schemeProjects).toContainEqual(
      expect.objectContaining({ schemeId: LEGACY_DEFAULT_SCHEME_ID, projectKey: "OPS" }),
    );
    expect(model.mappings).toContainEqual({
      schemeId: LEGACY_DEFAULT_SCHEME_ID,
      workTypeId: "default",
      configId: "fc:1",
    });
    // Only notable items survive: customfield_2 was visible and optional.
    expect(model.items.filter((i) => i.ownerId === "fc:2").map((i) => i.fieldId)).toEqual(["customfield_1", "summary"]);
  });

  test("an empty field scheme list also falls back", async () => {
    api.getAllFieldSchemes.mockResolvedValue([]);
    legacySite();
    const model = await readFieldBehaviour({ projects });
    expect(model).toMatchObject({ source: "field-configurations", fallbackReason: "no field schemes on this site" });
  });

  test("fails loudly when neither model can be read", async () => {
    api.getAllFieldSchemes.mockRejectedValue(new Error("401 scope does not match"));
    api.getAllFieldConfigurations.mockResolvedValue([]);
    api.getAllFieldConfigurationSchemes.mockResolvedValue([]);
    api.getFieldConfigurationSchemeMappings.mockResolvedValue([]);
    await expect(readFieldBehaviour({ projects })).rejects.toThrow(
      /Neither field schemes nor field configurations.*401/,
    );
  });
});

describe("buildFieldConfigSnapshot", () => {
  test("stores analysed rows and records the model, counts and summary", async () => {
    api.getAllFieldSchemes.mockResolvedValue([]);
    legacySite();

    const result = await buildFieldConfigSnapshot("site");
    expect(result).toMatchObject({ source: "field-configurations", schemes: 2, configs: 2, unread: 0 });

    const [, , written] = store.replaceFieldConfigSnapshot.mock.calls[0];
    const build = written.configs.find((c) => c.id === "fc:2");
    expect(build).toMatchObject({ used: true, itemsRead: true, requiredHidden: ["customfield_1"], notableCount: 2 });
    expect(build.codes).toContain("required-hidden");

    const ready = store.writeFieldConfigSnapshotMeta.mock.calls.at(-1)[1];
    expect(ready).toMatchObject({
      state: "ready",
      source: "field-configurations",
      totalSchemes: 2,
      totalConfigs: 2,
      unreadOwners: 0,
    });
    expect(ready.summary).toMatchObject({ requiredHiddenConfigs: 1 });
  });

  test("records a failure with its message and rethrows", async () => {
    api.getAllJiraProjects.mockRejectedValueOnce(new Error("boom"));
    await expect(buildFieldConfigSnapshot("site")).rejects.toThrow("boom");
    expect(store.writeFieldConfigSnapshotMeta.mock.calls.at(-1)[1]).toMatchObject({
      state: "failed",
      lastError: "boom",
    });
  });
});

describe("build bookkeeping", () => {
  test("a build is stale only once it outlives the consumer ceiling", () => {
    const now = Date.parse("2026-10-05T12:00:00Z");
    expect(isFieldConfigBuildStale({ state: "building", startedAt: "2026-10-05T11:55:00Z" }, now)).toBe(false);
    expect(isFieldConfigBuildStale({ state: "building", startedAt: "2026-10-05T11:00:00Z" }, now)).toBe(true);
    expect(isFieldConfigBuildStale({ state: "building" }, now)).toBe(true);
    expect(isFieldConfigBuildStale({ state: "ready" }, now)).toBe(false);
  });

  test("queueing marks the build started before the job is pushed", async () => {
    await queueFieldConfigSnapshotBuild("site");
    expect(store.writeFieldConfigSnapshotMeta).toHaveBeenCalledWith(
      "site",
      expect.objectContaining({ state: "building" }),
    );
  });
});
