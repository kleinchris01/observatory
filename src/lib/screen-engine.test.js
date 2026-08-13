import { vi, describe, test, expect, beforeEach } from "vitest";

// The two things worth pinning here are the ones a reader is most likely to get wrong:
// screen scheme operation inheritance, and the tri-state on a screen whose contents could
// not be read. Both are load-bearing for findings that have not been built yet, so an
// error in either produces a wrong finding rather than a visible failure.

vi.mock("./jira-api.js", () => ({
  incrMetric: vi.fn(),
  METRIC_NAMES: {
    screenSnapshotStarted: "screen-snapshot-started",
    screenSnapshotCompleted: "screen-snapshot-completed",
    screenSnapshotFailed: "screen-snapshot-failed",
  },
  getAllScreens: vi.fn(),
  getScreenTabs: vi.fn(),
  getScreenTabFields: vi.fn(),
  getAllScreenSchemes: vi.fn(),
  getAllIssueTypeScreenSchemes: vi.fn(),
  getIssueTypeScreenSchemeMappings: vi.fn(),
  getIssueTypeScreenSchemeProjects: vi.fn(),
  getAllJiraProjects: vi.fn(),
  mapWithConcurrency: async (items, _c, fn) => {
    const out = [];
    for (const item of items) out.push(await fn(item));
    return out;
  },
}));

vi.mock("./queues.js", () => ({
  inventorySnapshotQueue: { push: vi.fn() },
}));

vi.mock("./project-store.js", () => ({
  ensureProjectStoreReady: vi.fn(),
  writeScreenSnapshotMeta: vi.fn(),
  readScreenSnapshotMeta: vi.fn(),
  replaceScreenSnapshot: vi.fn(),
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  fallbackOn: () => () => undefined,
  ignoreWith: () => () => undefined,
}));

import {
  resolveSchemeOperations,
  isScreenBuildStale,
  collectScreenContents,
  buildScreenSnapshot,
  queueScreenSnapshotBuild,
  SCREEN_BUILD_STALE_MS,
} from "./screen-engine.js";
import {
  getAllScreens,
  getScreenTabs,
  getScreenTabFields,
  getAllScreenSchemes,
  getAllIssueTypeScreenSchemes,
  getIssueTypeScreenSchemeMappings,
  getIssueTypeScreenSchemeProjects,
  getAllJiraProjects,
} from "./jira-api.js";
import { inventorySnapshotQueue } from "./queues.js";
import { replaceScreenSnapshot, writeScreenSnapshotMeta } from "./project-store.js";

beforeEach(() => vi.clearAllMocks());

describe("resolveSchemeOperations", () => {
  test("resolves every operation and marks which were explicit", () => {
    const ops = resolveSchemeOperations({ id: 7, screens: { default: 10, edit: 11 } });
    const byOp = Object.fromEntries(ops.map((o) => [o.operation, o]));

    expect(byOp.edit).toMatchObject({ screenId: "11", inherited: false });
    expect(byOp.default).toMatchObject({ screenId: "10", inherited: false });
  });

  // The distinction the inventory exists to preserve: a screen chosen for an operation is
  // a decision, a screen reached by falling through to default is not, and an admin
  // auditing a scheme needs to tell them apart.
  test("an unmapped operation inherits default and says so", () => {
    const ops = resolveSchemeOperations({ id: 7, screens: { default: 10 } });
    const create = ops.find((o) => o.operation === "create");

    expect(create.screenId).toBe("10");
    expect(create.inherited).toBe(true);
  });

  test("reports all four operations even when the scheme maps none", () => {
    const ops = resolveSchemeOperations({ id: 7, screens: {} });
    expect(ops.map((o) => o.operation)).toEqual(["default", "create", "edit", "view"]);
    expect(ops.every((o) => o.screenId === null)).toBe(true);
    // Nothing was inherited, because there was nothing to inherit from.
    expect(ops.every((o) => o.inherited === false)).toBe(true);
  });

  // A scheme pointing at a screen the catalog does not contain is a finding. Dropping the
  // row would make the scheme look correctly configured.
  test("keeps a dangling screen reference and flags it", () => {
    const ops = resolveSchemeOperations({ id: 7, screens: { default: 999 } }, new Set(["10"]));
    expect(ops.every((o) => o.screenId === "999")).toBe(true);
    expect(ops.every((o) => o.dangling === true)).toBe(true);
  });

  test("does not flag danglers when no catalog was supplied to check against", () => {
    const ops = resolveSchemeOperations({ id: 7, screens: { default: 999 } });
    expect(ops.every((o) => o.dangling === false)).toBe(true);
  });
});

describe("isScreenBuildStale", () => {
  test("a fresh build is not stale", () => {
    const meta = { state: "building", startedAt: new Date().toISOString() };
    expect(isScreenBuildStale(meta)).toBe(false);
  });

  test("a build past the consumer ceiling is stale", () => {
    const startedAt = new Date(Date.now() - SCREEN_BUILD_STALE_MS - 1000).toISOString();
    expect(isScreenBuildStale({ state: "building", startedAt })).toBe(true);
  });

  // A Forge invocation timeout is a hard kill, so the row can be left "building" with an
  // unusable timestamp. Treat that as stale: the wedge must always be recoverable, not
  // sometimes recoverable.
  test("an unparseable start time is stale rather than assumed live", () => {
    expect(isScreenBuildStale({ state: "building", startedAt: "not a date" })).toBe(true);
    expect(isScreenBuildStale({ state: "building" })).toBe(true);
  });

  test("a build that is not building is never stale", () => {
    expect(isScreenBuildStale({ state: "ready", startedAt: "not a date" })).toBe(false);
  });
});

describe("collectScreenContents", () => {
  test("records tabs and fields with their positions preserved", async () => {
    getScreenTabs.mockResolvedValue([{ id: 1, name: "Field Tab" }]);
    getScreenTabFields.mockResolvedValue([{ id: "summary" }, { id: "customfield_1" }]);

    const { screenRows, tabs, fields } = await collectScreenContents([{ id: 100, name: "Default" }]);

    expect(screenRows[0]).toMatchObject({ id: "100", tabCount: 1, fieldCount: 2, tabsResolved: "resolved" });
    expect(tabs[0]).toMatchObject({ screenId: "100", tabId: "1", tabIndex: 0, fieldCount: 2 });
    // Order within the tab is the signal behind "buried field" -- discard it and the
    // finding cannot be recovered from the snapshot.
    expect(fields.map((f) => [f.fieldId, f.fieldIndex])).toEqual([["summary", 0], ["customfield_1", 1]]);
  });

  // The rule the whole pillar rests on. A screen we could not read is not a screen with no
  // fields; the second is the premise of a delete recommendation.
  test("an unreadable screen is unresolved, never zero fields", async () => {
    getScreenTabs.mockRejectedValueOnce(new Error("401 nope"));

    const { screenRows, fields } = await collectScreenContents([{ id: 100 }]);

    expect(screenRows[0].tabsResolved).toBe("unresolved");
    expect(screenRows[0].unresolvedReason).toMatch(/401 nope/);
    expect(fields).toHaveLength(0);
  });

  test("one unreadable tab marks the whole screen unresolved", async () => {
    getScreenTabs.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    getScreenTabFields
      .mockResolvedValueOnce([{ id: "summary" }])
      .mockRejectedValueOnce(new Error("500"));

    const { screenRows, fields } = await collectScreenContents([{ id: 100 }]);

    // The field list is incomplete, so reporting a confident count would understate the
    // screen. The fields that WERE read are still kept.
    expect(screenRows[0].tabsResolved).toBe("unresolved");
    expect(screenRows[0].unresolvedReason).toMatch(/Tab 2/);
    expect(fields).toHaveLength(1);
  });

  test("a genuinely empty screen is resolved with zero fields", async () => {
    getScreenTabs.mockResolvedValue([]);

    const { screenRows } = await collectScreenContents([{ id: 100 }]);

    // Measured zero, not unknown -- the opposite of the case above, and the table has to
    // be able to say which it is.
    expect(screenRows[0]).toMatchObject({ tabCount: 0, fieldCount: 0, tabsResolved: "resolved" });
  });

  test("skips a field with no id rather than writing a null key", async () => {
    getScreenTabs.mockResolvedValue([{ id: 1 }]);
    getScreenTabFields.mockResolvedValue([{ id: "summary" }, { name: "broken" }]);

    const { fields } = await collectScreenContents([{ id: 100 }]);
    expect(fields).toHaveLength(1);
  });
});

describe("buildScreenSnapshot", () => {
  function happyPath() {
    getAllScreens.mockResolvedValue([{ id: 100, name: "Default Screen" }]);
    getScreenTabs.mockResolvedValue([{ id: 1, name: "Tab" }]);
    getScreenTabFields.mockResolvedValue([{ id: "summary" }]);
    getAllScreenSchemes.mockResolvedValue([{ id: 5, name: "Default SS", screens: { default: 100 } }]);
    getAllIssueTypeScreenSchemes.mockResolvedValue([{ id: 9, name: "Default ITSS" }]);
    getIssueTypeScreenSchemeMappings.mockResolvedValue([
      { issueTypeScreenSchemeId: 9, issueTypeId: "default", screenSchemeId: 5 },
      { issueTypeScreenSchemeId: 9, issueTypeId: "10001", screenSchemeId: 5 },
    ]);
    getIssueTypeScreenSchemeProjects.mockResolvedValue([
      { issueTypeScreenScheme: { id: 9 }, projectIds: ["10000"] },
    ]);
    getAllJiraProjects.mockResolvedValue([{ id: "10000", key: "OBS", name: "Observatory" }]);
  }

  test("writes every layer of the chain under one version", async () => {
    happyPath();
    const result = await buildScreenSnapshot("scope-1");

    const [, version, payload] = replaceScreenSnapshot.mock.calls[0];
    expect(version).toBe(result.version);
    expect(payload.screens).toHaveLength(1);
    expect(payload.fields).toHaveLength(1);
    expect(payload.screenSchemes).toHaveLength(1);
    expect(payload.schemeOperations).toHaveLength(4);
    expect(payload.issueTypeScreenSchemes[0]).toMatchObject({ id: "9", projectCount: 1 });
  });

  // On most sites the catch-all is the only mapping a project has, so treating it as noise
  // would resolve the majority of projects to an empty screen set.
  test("keeps the default issue type mapping as its own row", async () => {
    happyPath();
    await buildScreenSnapshot("scope-1");

    const payload = replaceScreenSnapshot.mock.calls[0][2];
    const def = payload.itssMappings.find((m) => m.issueTypeId === "default");
    expect(def).toMatchObject({ isDefault: true, screenSchemeId: "5" });
    expect(payload.itssMappings.find((m) => m.issueTypeId === "10001").isDefault).toBe(false);
  });

  // The first live build died here: the ITSS-to-project endpoint requires at least one
  // projectId, so it cannot join the parallel batch -- it has to wait for the project list.
  test("passes the project ids into the ITSS association lookup", async () => {
    happyPath();
    await buildScreenSnapshot("scope-1");

    expect(getIssueTypeScreenSchemeProjects).toHaveBeenCalledWith(["10000"]);
  });

  test("still asks for associations when the site reports no projects", async () => {
    happyPath();
    getAllJiraProjects.mockResolvedValue([]);
    await buildScreenSnapshot("scope-1");

    // With no ids the fetcher short-circuits rather than issuing a guaranteed 400.
    expect(getIssueTypeScreenSchemeProjects).toHaveBeenCalledWith([]);
  });

  test("resolves project ids to keys and names", async () => {
    happyPath();
    await buildScreenSnapshot("scope-1");

    const payload = replaceScreenSnapshot.mock.calls[0][2];
    expect(payload.itssProjects[0]).toMatchObject({ projectKey: "OBS", projectName: "Observatory" });
  });

  // Retained, not dropped. A project the list did not resolve is still associated with the
  // scheme, and omitting it would understate the scheme's reach.
  test("keeps a project the project list did not resolve", async () => {
    happyPath();
    getAllJiraProjects.mockResolvedValue([]);
    await buildScreenSnapshot("scope-1");

    const payload = replaceScreenSnapshot.mock.calls[0][2];
    expect(payload.itssProjects[0]).toMatchObject({ projectId: "10000", projectKey: "UNKNOWN" });
  });

  test("counts unresolved screens into the meta rather than hiding them", async () => {
    happyPath();
    getScreenTabs.mockRejectedValue(new Error("401"));

    const result = await buildScreenSnapshot("scope-1");

    expect(result.unresolvedScreens).toBe(1);
    const ready = writeScreenSnapshotMeta.mock.calls.find((c) => c[1].state === "ready");
    expect(ready[1].unresolvedScreens).toBe(1);
  });

  test("marks the build failed and rethrows when a fetch dies", async () => {
    happyPath();
    getAllScreens.mockRejectedValue(new Error("catalog exploded"));

    await expect(buildScreenSnapshot("scope-1")).rejects.toThrow("catalog exploded");

    const failed = writeScreenSnapshotMeta.mock.calls.find((c) => c[1].state === "failed");
    expect(failed[1].lastError).toMatch(/catalog exploded/);
    // Nothing is written on a failed pass: a half-populated version readers can see is the
    // state the versioned-snapshot pattern exists to prevent.
    expect(replaceScreenSnapshot).not.toHaveBeenCalled();
  });
});

describe("queueScreenSnapshotBuild", () => {
  test("marks building before pushing, so double-clicks collapse into one job", async () => {
    await queueScreenSnapshotBuild("scope-1");

    expect(writeScreenSnapshotMeta).toHaveBeenCalledWith("scope-1", expect.objectContaining({ state: "building" }));
    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith({
      body: { jobType: "build-screen-snapshot", installationKey: "scope-1" },
    });
  });
});
