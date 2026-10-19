import { vi, describe, test, expect, beforeEach } from "vitest";

vi.mock("./jira-api.js", () => ({
  incrMetric: vi.fn(),
  METRIC_NAMES: { driftSnapshotStarted: "a", driftSnapshotCompleted: "b", driftSnapshotFailed: "c" },
}));
vi.mock("./queues.js", () => ({ inventorySnapshotQueue: { push: vi.fn() } }));
vi.mock("./logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock("./project-store.js", () => ({
  ensureProjectStoreReady: vi.fn(),
  readDriftSnapshotMeta: vi.fn(),
  writeDriftSnapshotMeta: vi.fn(),
  loadEntityDigests: vi.fn(async () => []),
  replaceEntityDigests: vi.fn(),
  appendConfigChanges: vi.fn(),
  readSnapshotMeta: vi.fn(async () => null),
  readWorkflowSnapshotMeta: vi.fn(async () => null),
  readIssueTypeSnapshotMeta: vi.fn(async () => null),
  readAccessSnapshotMeta: vi.fn(async () => null),
  readFilterSnapshotMeta: vi.fn(async () => null),
  readDashboardSnapshotMeta: vi.fn(async () => null),
  readEstateSnapshotMeta: vi.fn(async () => null),
  loadEstateValues: vi.fn(async () => []),
  loadSnapshotFields: vi.fn(async () => []),
  loadStatusesCatalog: vi.fn(async () => []),
  loadWorkflowSchemes: vi.fn(async () => []),
  loadIssueTypes: vi.fn(async () => []),
  loadIssueTypeSchemes: vi.fn(async () => []),
  loadSchemes: vi.fn(async () => []),
  loadSchemeHolders: vi.fn(async () => []),
  loadSchemeLevels: vi.fn(async () => []),
  loadFilters: vi.fn(async () => []),
  loadDashboards: vi.fn(async () => []),
  readFieldConfigSnapshotMeta: vi.fn(async () => null),
  loadFieldConfigSchemes: vi.fn(async () => []),
  loadFieldConfigConfigs: vi.fn(async () => []),
  loadFieldConfigSchemeProjects: vi.fn(async () => []),
  readScreenSnapshotMeta: vi.fn(async () => null),
  loadScreensPage: vi.fn(async () => ({ total: 0, rows: [] })),
  loadScreenSchemes: vi.fn(async () => []),
  loadIssueTypeScreenSchemes: vi.fn(async () => []),
  loadItssMappings: vi.fn(async () => []),
  loadItssProjects: vi.fn(async () => []),
  loadScreenFieldLayout: vi.fn(async () => new Map()),
  readBoardSnapshotMeta: vi.fn(async () => null),
  loadBoards: vi.fn(async () => []),
  loadBoardColumns: vi.fn(async () => []),
  readUserSnapshotMeta: vi.fn(async () => null),
  loadUsers: vi.fn(async () => []),
  readAssetSnapshotMeta: vi.fn(async () => null),
  loadAssetSchemas: vi.fn(async () => []),
  loadAssetObjectTypes: vi.fn(async () => []),
  loadAssetAttributes: vi.fn(async () => []),
  loadWorkflowsCatalog: vi.fn(async () => []),
  loadWorkflowStructure: vi.fn(async () => ({ transitions: [], rules: [] })),
  loadProjectWorkflowSchemeMap: vi.fn(async () => new Map()),
  loadIssueTypeSchemeProjects: vi.fn(async () => []),
  loadSchemeProjects: vi.fn(async () => []),
}));

// Mocked at its real module: drift-engine.js must import it from store/automation.js, and a
// mock on project-store.js once hid that it did not (the 7 Oct dev deploy failed to bundle).
vi.mock("./store/automation.js", () => ({ readAutomationPart: vi.fn(async () => null) }));

import { DRIFT_PILLARS } from "./drift-engine.js";
import {
  fnv1a,
  digestFields,
  diffEntitySets,
  isDriftBuildStale,
  queueDriftSnapshotBuild,
  buildDriftSnapshot,
} from "./drift-engine.js";
import * as store from "./project-store.js";
import * as automationStore from "./store/automation.js";
import { inventorySnapshotQueue } from "./queues.js";

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations, so reset every dependency to its neutral state --
  // otherwise a mockImplementation set in one test leaks into the next.
  for (const fn of [
    "readSnapshotMeta",
    "readWorkflowSnapshotMeta",
    "readIssueTypeSnapshotMeta",
    "readAccessSnapshotMeta",
    "readFilterSnapshotMeta",
    "readDashboardSnapshotMeta",
    "readEstateSnapshotMeta",
    "readDriftSnapshotMeta",
  ])
    store[fn].mockResolvedValue(null);
  for (const fn of [
    "loadEntityDigests",
    "loadSnapshotFields",
    "loadStatusesCatalog",
    "loadWorkflowSchemes",
    "loadIssueTypes",
    "loadIssueTypeSchemes",
    "loadSchemes",
    "loadSchemeHolders",
    "loadSchemeLevels",
    "loadFilters",
    "loadDashboards",
    "loadEstateValues",
    "loadScreenSchemes",
    "loadIssueTypeScreenSchemes",
    "loadItssMappings",
    "loadItssProjects",
    "loadBoards",
    "loadBoardColumns",
    "loadUsers",
    "loadAssetSchemas",
    "loadAssetObjectTypes",
    "loadAssetAttributes",
    "loadWorkflowsCatalog",
    "loadIssueTypeSchemeProjects",
    "loadSchemeProjects",
  ])
    store[fn].mockResolvedValue([]);
  for (const fn of [
    "readScreenSnapshotMeta",
    "readBoardSnapshotMeta",
    "readUserSnapshotMeta",
    "readAssetSnapshotMeta",
  ]) {
    store[fn].mockResolvedValue(null);
  }
  automationStore.readAutomationPart.mockResolvedValue(null);
  store.loadScreensPage.mockResolvedValue({ total: 0, rows: [] });
  store.loadScreenFieldLayout.mockResolvedValue(new Map());
  store.loadWorkflowStructure.mockResolvedValue({ transitions: [], rules: [] });
  store.loadProjectWorkflowSchemeMap.mockResolvedValue(new Map());
});

describe("hashing", () => {
  test("fnv1a is deterministic and 8 hex chars, and separates distinct input", () => {
    expect(fnv1a("hello")).toBe(fnv1a("hello"));
    expect(fnv1a("hello")).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a("hello")).not.toBe(fnv1a("world"));
  });

  test("digestFields does not depend on key order", () => {
    expect(digestFields({ a: 1, b: 2 })).toBe(digestFields({ b: 2, a: 1 }));
    expect(digestFields({ a: 1 })).not.toBe(digestFields({ a: 2 }));
    expect(digestFields({})).toBe(digestFields(null));
  });
});

describe("diffEntitySets", () => {
  const digestOf = (fields) => digestFields(fields);

  test("classifies added, removed and modified, and names the changed field", () => {
    const prev = [
      {
        entityType: "status",
        entityId: "1",
        label: "Open",
        digest: digestOf({ name: "Open", statusCategory: "new" }),
        fields: { name: "Open", statusCategory: "new" },
      },
      {
        entityType: "status",
        entityId: "2",
        label: "Done",
        digest: digestOf({ name: "Done", statusCategory: "done" }),
        fields: { name: "Done", statusCategory: "done" },
      },
    ];
    const next = [
      // 1 unchanged
      { entityType: "status", entityId: "1", label: "Open", fields: { name: "Open", statusCategory: "new" } },
      // 2 modified: category flipped
      { entityType: "status", entityId: "2", label: "Done", fields: { name: "Done", statusCategory: "indeterminate" } },
      // 3 added
      {
        entityType: "status",
        entityId: "3",
        label: "In Review",
        fields: { name: "In Review", statusCategory: "indeterminate" },
      },
    ];

    const changes = diffEntitySets(prev, next);
    const byKind = Object.fromEntries(changes.map((c) => [c.changeKind, c]));

    expect(changes).toHaveLength(2); // status 1 unchanged; 2 modified; 3 added
    expect(byKind.added.entityId).toBe("3");
    expect(byKind.added.summary).toBe('Status "In Review" added');
    expect(byKind.removed).toBeUndefined();
    expect(byKind.modified.entityId).toBe("2");
    expect(byKind.modified.summary).toBe('Status "Done" changed: statusCategory');
  });

  test("records a removal when an entity disappears", () => {
    const prev = [
      {
        entityType: "filter",
        entityId: "9",
        label: "Ghost",
        digest: digestOf({ name: "Ghost" }),
        fields: { name: "Ghost" },
      },
    ];
    const changes = diffEntitySets(prev, []);
    expect(changes).toEqual([
      expect.objectContaining({ changeKind: "removed", entityId: "9", summary: 'Saved filter "Ghost" removed' }),
    ]);
  });

  test("an existence-only entity (empty fields) is never reported as modified", () => {
    const prev = [
      { entityType: "permission-grant", entityId: "1:BROWSE:anyone:", label: "x", digest: digestOf({}), fields: {} },
    ];
    const next = [{ entityType: "permission-grant", entityId: "1:BROWSE:anyone:", label: "x", fields: {} }];
    expect(diffEntitySets(prev, next)).toEqual([]);
  });
});

describe("isDriftBuildStale", () => {
  test("false unless building, true once past the window", () => {
    expect(isDriftBuildStale({ state: "ready" })).toBe(false);
    expect(isDriftBuildStale({ state: "building", startedAt: new Date().toISOString() })).toBe(false);
    expect(
      isDriftBuildStale({ state: "building", startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() }),
    ).toBe(true);
  });
});

describe("queueDriftSnapshotBuild", () => {
  test("marks building then pushes the job", async () => {
    await queueDriftSnapshotBuild("inst");
    expect(store.writeDriftSnapshotMeta).toHaveBeenCalledWith("inst", expect.objectContaining({ state: "building" }));
    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith({
      body: { jobType: "build-drift-snapshot", installationKey: "inst" },
    });
  });
});

describe("buildDriftSnapshot", () => {
  test("seeds a pillar silently on the first pass -- no change rows", async () => {
    store.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1" });
    store.loadStatusesCatalog.mockResolvedValue([{ id: "1", name: "Open", statusCategory: "new" }]);
    store.loadEntityDigests.mockResolvedValue([]); // never digested before

    const result = await buildDriftSnapshot("inst");

    expect(result.seeded).toContain("workflow");
    expect(result.changes).toBe(0);
    expect(store.appendConfigChanges).not.toHaveBeenCalled();
    expect(store.replaceEntityDigests).toHaveBeenCalledWith(
      "inst",
      "workflow",
      expect.arrayContaining([expect.objectContaining({ entityType: "status", entityId: "1" })]),
    );
    // A workflow snapshot also feeds the workflow-detail and project sources, which seed too.
    expect(store.writeDriftSnapshotMeta).toHaveBeenLastCalledWith(
      "inst",
      expect.objectContaining({ state: "ready", seededPillars: expect.arrayContaining(["workflow"]) }),
    );
  });

  test("records adds/removes/mods against the stored digests on a later pass", async () => {
    store.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    store.loadSchemes.mockImplementation(async (_k, _v, type) =>
      type === "permission"
        ? [{ id: "1", name: "Prod renamed", description: "", isDefault: false, defaultLevelId: null }]
        : [],
    );
    store.loadSchemeHolders.mockResolvedValue([]);
    store.loadSchemeLevels.mockResolvedValue([]);
    // Digests per pillar: the project source (fed by the same access snapshot) has none yet
    // and seeds silently, so only access reports.
    store.loadEntityDigests.mockImplementation(async (_k, pillar) =>
      pillar === "access"
        ? [
            // same id, different name -> modified
            {
              entityType: "permission-scheme",
              entityId: "1",
              label: "Prod",
              digest: "stale",
              fields: { name: "Prod", description: "", isDefault: false, defaultLevelId: null },
            },
            // gone this pass -> removed
            {
              entityType: "permission-scheme",
              entityId: "2",
              label: "Legacy",
              digest: "x",
              fields: { name: "Legacy" },
            },
          ]
        : [],
    );
    store.readDriftSnapshotMeta.mockResolvedValue({ totalChanges: 5, seededPillars: ["access"] });

    const result = await buildDriftSnapshot("inst");

    expect(result.changes).toBe(2);
    const [, rows] = store.appendConfigChanges.mock.calls[0];
    expect(rows.map((r) => r.changeKind).sort()).toEqual(["modified", "removed"]);
    expect(rows.every((r) => r.pillar === "access" && r.scanVersion === result.version)).toBe(true);
    expect(store.writeDriftSnapshotMeta).toHaveBeenLastCalledWith(
      "inst",
      expect.objectContaining({ state: "ready", lastRunChanges: 2, totalChanges: 7 }),
    );
  });

  test("skips a pillar whose inventory has never been built", async () => {
    store.readWorkflowSnapshotMeta.mockResolvedValue(null);
    const result = await buildDriftSnapshot("inst");
    expect(result.changes).toBe(0);
    expect(store.loadStatusesCatalog).not.toHaveBeenCalled();
  });

  test("leaves a pillar's digests untouched when its collect throws", async () => {
    store.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1" });
    store.loadEntityDigests.mockImplementation(async (_k, pillar) =>
      pillar === "workflow"
        ? [{ entityType: "status", entityId: "1", label: "Open", digest: "d", fields: { name: "Open" } }]
        : [],
    );
    store.loadStatusesCatalog.mockRejectedValueOnce(new Error("sql down"));

    const result = await buildDriftSnapshot("inst");

    expect(result.changes).toBe(0);
    expect(store.replaceEntityDigests).not.toHaveBeenCalledWith("inst", "workflow", expect.anything());
  });

  test("marks the build failed and rethrows on a hard error", async () => {
    store.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    // A prior digest for a field the fresh inventory no longer has -> one removal, which
    // means appendConfigChanges is reached.
    store.loadEntityDigests.mockResolvedValue([
      { entityType: "field", entityId: "gone", label: "Gone", digest: "d", fields: { name: "Gone" } },
    ]);
    store.loadSnapshotFields.mockResolvedValue([]);
    store.readDriftSnapshotMeta.mockResolvedValue({ seededPillars: ["fields"], totalChanges: 0 });
    store.appendConfigChanges.mockRejectedValueOnce(new Error("write failed"));

    await expect(buildDriftSnapshot("inst")).rejects.toThrow("write failed");
    expect(store.writeDriftSnapshotMeta).toHaveBeenLastCalledWith("inst", expect.objectContaining({ state: "failed" }));
  });
});

describe("field scheme contributor", () => {
  const spec = DRIFT_PILLARS.find((p) => p.pillar === "fieldConfigs");

  test("tracks schemes, configurations and which scheme each project is on", async () => {
    store.loadFieldConfigSchemes.mockResolvedValueOnce([
      {
        id: "fs:1",
        name: "Build",
        isDefault: false,
        measured: true,
        fieldCount: 40,
        requiredCount: 3,
        restrictedCount: 1,
      },
      { id: "fs:2", name: "Unread", isDefault: false, measured: false, fieldCount: null },
    ]);
    store.loadFieldConfigConfigs.mockResolvedValueOnce([
      { id: "fc:2", name: "Cfg", itemsRead: true, requiredCount: 1, hiddenCount: 2, requiredHidden: ["customfield_1"] },
    ]);
    store.loadFieldConfigSchemeProjects.mockResolvedValueOnce([
      { schemeId: "fs:1", projectId: "10", projectKey: "BLD" },
    ]);

    const entities = await spec.collect("site", "v1");
    expect(entities.map((e) => e.entityType)).toEqual([
      "field-scheme",
      "field-scheme",
      "field-configuration",
      "field-scheme-assignment",
    ]);
    expect(entities[0].fields).toMatchObject({ fieldCount: 40, requiredCount: 3 });
    // An owner the build could not read digests no counts, so a time-budget miss is never a "change".
    expect(entities[1].fields).not.toHaveProperty("fieldCount");
    expect(entities[3]).toMatchObject({ entityId: "10", label: "BLD", fields: { scheme: "Build" } });
  });
});

describe("every pillar has a change source", () => {
  const spec = (pillar) => DRIFT_PILLARS.find((p) => p.pillar === pillar);

  test("the registry covers every health pillar except the change log itself", () => {
    expect(DRIFT_PILLARS.map((p) => p.pillar)).toEqual(
      expect.arrayContaining([
        "fields",
        "workflow",
        "workflowRules",
        "issueTypes",
        "access",
        "estate",
        "fieldConfigs",
        "filters",
        "dashboards",
        "screens",
        "projects",
        "boards",
        "people",
        "assets",
        "automation",
      ]),
    );
  });

  test("workflows carry their transitions, and rules only when the snapshot read them", async () => {
    store.loadWorkflowsCatalog.mockResolvedValueOnce([{ name: "WF", scopeType: "GLOBAL", scopeProjectId: null }]);
    store.loadWorkflowStructure.mockResolvedValueOnce({
      transitions: [{ workflowName: "WF", transitionId: "11", name: "Start", type: "DIRECTED", from: ["1"], to: "3" }],
      rules: [{ workflowName: "WF", transitionId: "11", kind: "validator", key: "FieldRequired" }],
    });
    store.readWorkflowSnapshotMeta.mockResolvedValueOnce({ version: "w1", workflowRules: 4 });
    const [wf] = await spec("workflowRules").collect("inst", "w1");
    expect(wf).toMatchObject({
      entityType: "workflow",
      entityId: "WF",
      fields: { transitions: ["11:Start:DIRECTED:1>3"], rules: ["11:validator:FieldRequired"] },
    });

    store.loadWorkflowsCatalog.mockResolvedValueOnce([{ name: "WF" }]);
    store.readWorkflowSnapshotMeta.mockResolvedValueOnce({ version: "w2", workflowRules: null });
    const [unread] = await spec("workflowRules").collect("inst", "w2");
    expect(unread.fields).not.toHaveProperty("rules");
  });

  test("screens carry their layout only when their tabs were read", async () => {
    store.loadScreensPage.mockResolvedValueOnce({
      total: 2,
      rows: [
        { screenId: "1", name: "Create", description: "", tabsResolved: "resolved" },
        { screenId: "2", name: "Broken", description: "", tabsResolved: "unresolved" },
      ],
    });
    store.loadScreenFieldLayout.mockResolvedValueOnce(
      new Map([
        ["1", ["t1:summary", "t1:customfield_1"]],
        ["2", ["t1:x"]],
      ]),
    );
    store.loadIssueTypeScreenSchemes.mockResolvedValueOnce([{ itssId: "9", name: "ITSS", description: "" }]);
    store.loadItssMappings.mockResolvedValueOnce([
      { itssId: "9", issueTypeId: "10", screenSchemeId: "5", isDefault: false },
      { itssId: "9", issueTypeId: null, screenSchemeId: "4", isDefault: true },
    ]);
    const out = await spec("screens").collect("inst", "s1");
    expect(out.find((e) => e.entityId === "1").fields.layout).toEqual(["t1:summary", "t1:customfield_1"]);
    expect(out.find((e) => e.entityId === "2").fields).not.toHaveProperty("layout");
    expect(out.find((e) => e.entityType === "issue-type-screen-scheme").fields.mapping).toEqual(["10=5", "default=4"]);
  });

  test("boards carry columns only when their configuration was readable", async () => {
    store.loadBoards.mockResolvedValueOnce([
      { boardId: "1", name: "Team", type: "scrum", locationKey: "ABC", filterId: "100", configReadable: true },
      { boardId: "2", name: "Locked", type: "kanban", configReadable: false },
    ]);
    store.loadBoardColumns.mockResolvedValueOnce([{ boardId: "1", name: "To Do", statusIds: ["1", "2"] }]);
    const out = await spec("boards").collect("inst", "b1");
    expect(out[0].fields).toMatchObject({ filterId: "100", location: "ABC", columns: ["To Do:1+2"] });
    expect(out[1].fields).not.toHaveProperty("columns");
  });

  test("people are tracked by licence and group only, never activity", async () => {
    store.loadUsers.mockResolvedValueOnce([
      {
        accountId: "a1",
        displayName: "Ann",
        active: true,
        accountType: "atlassian",
        applications: [{ key: "jira-software" }],
        groups: [{ id: "g2" }, { id: "g1" }],
        lastActivityAt: "2026-10-01",
      },
    ]);
    const [u] = await spec("people").collect("inst", "u1");
    expect(u).toEqual({
      entityType: "user",
      entityId: "a1",
      label: "Ann",
      fields: { active: true, accountType: "atlassian", products: ["jira-software"], groups: ["g1", "g2"] },
    });
  });

  test("Assets: structure only, attributes keyed under their object type", async () => {
    store.loadAssetSchemas.mockResolvedValueOnce([{ id: "1", name: "CMDB", schemaKey: "CMDB", description: "" }]);
    store.loadAssetObjectTypes.mockResolvedValueOnce([
      { id: "3", name: "Server", schemaId: "1", parentId: null, abstract: false, description: "" },
    ]);
    store.loadAssetAttributes.mockResolvedValueOnce([
      { id: "88", objectTypeId: "3", schemaId: "1", name: "IP", dataType: "text", referenceObjectTypeId: null },
    ]);
    const out = await spec("assets").collect("inst", "as1");
    expect(out.map((e) => `${e.entityType}:${e.entityId}`)).toEqual([
      "asset-schema:1",
      "asset-object-type:3",
      "asset-attribute:3:88",
    ]);
  });

  test("automation reads the imported rule directory, versioned by the import", async () => {
    automationStore.readAutomationPart.mockImplementation(async (_k, part) =>
      part === "analysis"
        ? { refreshedAt: "2026-10-01T00:00:00Z" }
        : { rules: [["55", "Close stale", 1, "jira:issue_updated", 3, "acc-9"]] },
    );
    expect(await spec("automation").readMeta("inst")).toEqual({ version: "2026-10-01T00:00:00Z" });
    const [rule] = await spec("automation").collect("inst");
    expect(rule).toEqual({
      entityType: "automation-rule",
      entityId: "55",
      label: "Close stale",
      fields: { name: "Close stale", enabled: true, trigger: "jira:issue_updated", projectCount: 3, author: "acc-9" },
    });
    automationStore.readAutomationPart.mockResolvedValue(null);
    expect(await spec("automation").readMeta("inst")).toBeNull();
  });

  test("projects: the schemes each one runs on, from whichever inventories exist", async () => {
    store.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1" });
    store.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    store.loadProjectWorkflowSchemeMap.mockResolvedValueOnce(
      new Map([["10000", { schemeId: "7", name: "Software WF" }]]),
    );
    store.loadSchemeProjects.mockImplementation(async (_k, _v, type) =>
      type === "permission" ? [{ schemeId: "1", projectId: "10000", projectKey: "ABC", projectName: "Alpha" }] : [],
    );
    store.loadSchemes.mockImplementation(async (_k, _v, type) =>
      type === "permission" ? [{ id: "1", name: "Default perms" }] : [],
    );

    expect(await spec("projects").readMeta("inst")).toEqual({ version: "composite" });
    const [p] = await spec("projects").collect("inst");
    // Issue type and screen inventories are not built, so those slots are absent, not null.
    expect(p).toEqual({
      entityType: "project",
      entityId: "10000",
      label: "ABC",
      fields: { name: "Alpha", workflowScheme: "Software WF", permissionScheme: "Default perms" },
    });
  });

  test("projects are skipped when no source inventory exists", async () => {
    expect(await spec("projects").readMeta("inst")).toBeNull();
  });
});
