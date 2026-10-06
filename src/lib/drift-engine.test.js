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
}));

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
import { inventorySnapshotQueue } from "./queues.js";

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations, so reset every dependency to its neutral state --
  // otherwise a mockImplementation set in one test leaks into the next.
  for (const fn of [
    "readSnapshotMeta", "readWorkflowSnapshotMeta", "readIssueTypeSnapshotMeta",
    "readAccessSnapshotMeta", "readFilterSnapshotMeta", "readDashboardSnapshotMeta",
    "readEstateSnapshotMeta", "readDriftSnapshotMeta",
  ]) store[fn].mockResolvedValue(null);
  for (const fn of [
    "loadEntityDigests", "loadSnapshotFields", "loadStatusesCatalog", "loadWorkflowSchemes",
    "loadIssueTypes", "loadIssueTypeSchemes", "loadSchemes", "loadSchemeHolders",
    "loadSchemeLevels", "loadFilters", "loadDashboards", "loadEstateValues",
  ]) store[fn].mockResolvedValue([]);
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
      { entityType: "status", entityId: "1", label: "Open", digest: digestOf({ name: "Open", statusCategory: "new" }), fields: { name: "Open", statusCategory: "new" } },
      { entityType: "status", entityId: "2", label: "Done", digest: digestOf({ name: "Done", statusCategory: "done" }), fields: { name: "Done", statusCategory: "done" } },
    ];
    const next = [
      // 1 unchanged
      { entityType: "status", entityId: "1", label: "Open", fields: { name: "Open", statusCategory: "new" } },
      // 2 modified: category flipped
      { entityType: "status", entityId: "2", label: "Done", fields: { name: "Done", statusCategory: "indeterminate" } },
      // 3 added
      { entityType: "status", entityId: "3", label: "In Review", fields: { name: "In Review", statusCategory: "indeterminate" } },
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
    const prev = [{ entityType: "filter", entityId: "9", label: "Ghost", digest: digestOf({ name: "Ghost" }), fields: { name: "Ghost" } }];
    const changes = diffEntitySets(prev, []);
    expect(changes).toEqual([expect.objectContaining({ changeKind: "removed", entityId: "9", summary: 'Saved filter "Ghost" removed' })]);
  });

  test("an existence-only entity (empty fields) is never reported as modified", () => {
    const prev = [{ entityType: "permission-grant", entityId: "1:BROWSE:anyone:", label: "x", digest: digestOf({}), fields: {} }];
    const next = [{ entityType: "permission-grant", entityId: "1:BROWSE:anyone:", label: "x", fields: {} }];
    expect(diffEntitySets(prev, next)).toEqual([]);
  });
});

describe("isDriftBuildStale", () => {
  test("false unless building, true once past the window", () => {
    expect(isDriftBuildStale({ state: "ready" })).toBe(false);
    expect(isDriftBuildStale({ state: "building", startedAt: new Date().toISOString() })).toBe(false);
    expect(isDriftBuildStale({ state: "building", startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() })).toBe(true);
  });
});

describe("queueDriftSnapshotBuild", () => {
  test("marks building then pushes the job", async () => {
    await queueDriftSnapshotBuild("inst");
    expect(store.writeDriftSnapshotMeta).toHaveBeenCalledWith("inst", expect.objectContaining({ state: "building" }));
    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith({ body: { jobType: "build-drift-snapshot", installationKey: "inst" } });
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
    expect(store.replaceEntityDigests).toHaveBeenCalledWith("inst", "workflow", expect.arrayContaining([
      expect.objectContaining({ entityType: "status", entityId: "1" }),
    ]));
    expect(store.writeDriftSnapshotMeta).toHaveBeenLastCalledWith("inst", expect.objectContaining({ state: "ready", seededPillars: ["workflow"] }));
  });

  test("records adds/removes/mods against the stored digests on a later pass", async () => {
    store.readAccessSnapshotMeta.mockResolvedValue({ version: "a1" });
    store.loadSchemes.mockImplementation(async (_k, _v, type) =>
      type === "permission" ? [{ id: "1", name: "Prod renamed", description: "", isDefault: false, defaultLevelId: null }] : []);
    store.loadSchemeHolders.mockResolvedValue([]);
    store.loadSchemeLevels.mockResolvedValue([]);
    store.loadEntityDigests.mockResolvedValue([
      // same id, different name -> modified
      { entityType: "permission-scheme", entityId: "1", label: "Prod", digest: "stale", fields: { name: "Prod", description: "", isDefault: false, defaultLevelId: null } },
      // gone this pass -> removed
      { entityType: "permission-scheme", entityId: "2", label: "Legacy", digest: "x", fields: { name: "Legacy" } },
    ]);
    store.readDriftSnapshotMeta.mockResolvedValue({ totalChanges: 5, seededPillars: ["access"] });

    const result = await buildDriftSnapshot("inst");

    expect(result.changes).toBe(2);
    const [, rows] = store.appendConfigChanges.mock.calls[0];
    expect(rows.map((r) => r.changeKind).sort()).toEqual(["modified", "removed"]);
    expect(rows.every((r) => r.pillar === "access" && r.scanVersion === result.version)).toBe(true);
    expect(store.writeDriftSnapshotMeta).toHaveBeenLastCalledWith("inst", expect.objectContaining({ state: "ready", lastRunChanges: 2, totalChanges: 7 }));
  });

  test("skips a pillar whose inventory has never been built", async () => {
    store.readWorkflowSnapshotMeta.mockResolvedValue(null);
    const result = await buildDriftSnapshot("inst");
    expect(result.changes).toBe(0);
    expect(store.loadStatusesCatalog).not.toHaveBeenCalled();
  });

  test("leaves a pillar's digests untouched when its collect throws", async () => {
    store.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1" });
    store.loadEntityDigests.mockResolvedValue([{ entityType: "status", entityId: "1", label: "Open", digest: "d", fields: { name: "Open" } }]);
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
      { id: "fs:1", name: "Build", isDefault: false, measured: true, fieldCount: 40, requiredCount: 3, restrictedCount: 1 },
      { id: "fs:2", name: "Unread", isDefault: false, measured: false, fieldCount: null },
    ]);
    store.loadFieldConfigConfigs.mockResolvedValueOnce([{ id: "fc:2", name: "Cfg", itemsRead: true, requiredCount: 1, hiddenCount: 2, requiredHidden: ["customfield_1"] }]);
    store.loadFieldConfigSchemeProjects.mockResolvedValueOnce([{ schemeId: "fs:1", projectId: "10", projectKey: "BLD" }]);

    const entities = await spec.collect("site", "v1");
    expect(entities.map((e) => e.entityType)).toEqual(["field-scheme", "field-scheme", "field-configuration", "field-scheme-assignment"]);
    expect(entities[0].fields).toMatchObject({ fieldCount: 40, requiredCount: 3 });
    // An owner the build could not read digests no counts, so a time-budget miss is never a "change".
    expect(entities[1].fields).not.toHaveProperty("fieldCount");
    expect(entities[3]).toMatchObject({ entityId: "10", label: "BLD", fields: { scheme: "Build" } });
  });
});
