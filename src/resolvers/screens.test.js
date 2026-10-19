import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks } from "./test-harness.js";
import { computeAndStoreScreenCross, __RAW_ADMIN_ONLY_FUNCTIONS, SHARED_RESOLVER_FUNCTIONS } from "../resolvers.js";

const { getScreenInventory, getFieldScreenReachability, getFieldScreenCounts, buildScreenInventory } =
  __RAW_ADMIN_ONLY_FUNCTIONS;
const { getScreenFieldReportInputs, getScreenFieldCrossSignal, getProjectScreenReportInputs } = {
  ...SHARED_RESOLVER_FUNCTIONS,
  ...__RAW_ADMIN_ONLY_FUNCTIONS,
};

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ── Screen and scheme inventory ──────────────────────────────────────────────

describe("getScreenInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  // "No inventory has been built" and "this site has no screens" are opposite claims and
  // look identical as an empty array. The flag is what keeps them apart.
  test("reports never-built rather than returning empty rows", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);

    const result = await getScreenInventory({ payload: {}, ...ctx });

    expect(result.neverBuilt).toBe(true);
    expect(result.screens).toEqual({ total: 0, rows: [] });
    expect(mocks.loadScreensPage).not.toHaveBeenCalled();
  });

  test("returns every layer of the chain from one call", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "v1",
      totalScreens: 760,
      totalSchemes: 12,
      unresolvedScreens: 30,
    });
    mocks.loadScreensPage.mockResolvedValue({ total: 760, rows: [{ screenId: "100" }] });
    mocks.loadScreenSchemes.mockResolvedValue([{ schemeId: "5" }]);
    mocks.loadIssueTypeScreenSchemes.mockResolvedValue([{ itssId: "9" }]);

    const result = await getScreenInventory({ payload: {}, ...ctx });

    expect(result.neverBuilt).toBe(false);
    expect(result.screens.total).toBe(760);
    expect(result.screenSchemes).toHaveLength(1);
    expect(result.issueTypeScreenSchemes).toHaveLength(1);
  });

  // Surfaced at the top level, not buried per row: a pass that could not read part of the
  // catalog caps every finding built on it, and the reader needs that before the numbers.
  test("surfaces the unresolved screen count alongside the totals", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1", unresolvedScreens: 30 });

    const result = await getScreenInventory({ payload: {}, ...ctx });
    expect(result.unresolvedScreens).toBe(30);
  });

  test("clamps a hostile page size and passes the offset through", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });

    await getScreenInventory({ payload: { page: 3, pageSize: 5000 }, ...ctx });

    expect(mocks.loadScreensPage).toHaveBeenCalledWith(
      "test-install",
      "v1",
      expect.objectContaining({ limit: 100, offset: 200 }),
    );
  });

  test("reports a stale build so the UI can offer a rebuild", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ state: "building", version: "v1" });
    mocks.isScreenBuildStale.mockReturnValue(true);

    const result = await getScreenInventory({ payload: {}, ...ctx });
    expect(result.staleBuild).toBe(true);
  });
});

describe("getFieldScreenReachability", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  // The distinction a delete recommendation rests on: no snapshot is not "this field is
  // on no screen".
  test("says it does not know rather than returning an empty screen list", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);

    const result = await getFieldScreenReachability({ payload: { fieldId: "customfield_1" }, ...ctx });

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/no screen inventory/i);
  });

  test("returns the screens carrying the field once a snapshot exists", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "v1", unresolvedScreens: 2 });
    mocks.loadScreensForField.mockResolvedValue([{ screenId: "100", screenName: "Default" }]);

    const result = await getFieldScreenReachability({ payload: { fieldId: "customfield_1" }, ...ctx });

    expect(result.available).toBe(true);
    expect(result.screens).toHaveLength(1);
    // Carried through so a caller can weigh the answer, not just read it.
    expect(result.unresolvedScreens).toBe(2);
  });

  test("rejects a missing field id", async () => {
    await expect(getFieldScreenReachability({ payload: {}, ...ctx })).rejects.toThrow(/fieldId/);
  });
});

describe("getScreenFieldReportInputs", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x", accountId: "acc-1" } };

  test("returns the field union and the projects the screens reach", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1" });
    mocks.loadScreensWithFieldsByIds.mockResolvedValue([
      {
        screenId: "100",
        name: "Create",
        tabsResolved: "resolved",
        fields: [
          { fieldId: "cf_1", fieldName: "A" },
          { fieldId: "cf_2", fieldName: "B" },
        ],
      },
      {
        screenId: "200",
        name: "Edit",
        tabsResolved: "resolved",
        fields: [
          { fieldId: "cf_2", fieldName: "B" },
          { fieldId: "cf_3", fieldName: "C" },
        ],
      },
    ]);
    // screen 100 -> scheme SS1 -> itss I1 -> project 10 and 11
    mocks.loadScreenSchemeOperations.mockResolvedValue([
      { schemeId: "SS1", screenId: "100" },
      { schemeId: "SS9", screenId: "999" },
    ]);
    mocks.loadItssMappings.mockResolvedValue([{ itssId: "I1", screenSchemeId: "SS1" }]);
    mocks.loadItssProjects.mockResolvedValue([
      { itssId: "I1", projectId: "10", projectKey: "AAA", projectName: "Alpha" },
      { itssId: "I1", projectId: "11", projectKey: "BBB", projectName: "Bravo" },
      { itssId: "I2", projectId: "12", projectKey: "CCC", projectName: "Charlie" },
    ]);

    const result = await getScreenFieldReportInputs({ payload: { screenIds: ["100", "200"] }, ...ctx });

    expect(result.available).toBe(true);
    expect(result.fieldIds.sort()).toEqual(["cf_1", "cf_2", "cf_3"]);
    expect(result.projectIds.sort()).toEqual(["10", "11"]);
  });

  test("flags screens whose contents could not be read", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1" });
    mocks.loadScreensWithFieldsByIds.mockResolvedValue([
      { screenId: "100", name: "Create", tabsResolved: "resolved", fields: [{ fieldId: "cf_1", fieldName: "A" }] },
      { screenId: "300", name: "Legacy", tabsResolved: "unreadable", fields: [] },
    ]);

    const result = await getScreenFieldReportInputs({ payload: { screenIds: ["100", "300", "404"] }, ...ctx });

    expect(result.unresolvedScreens).toEqual(["Legacy"]);
    expect(result.missingScreenIds).toEqual(["404"]);
  });

  test("rejects an empty screen list", async () => {
    await expect(getScreenFieldReportInputs({ payload: { screenIds: [] }, ...ctx })).rejects.toThrow();
  });
});

describe("getProjectScreenReportInputs", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x", accountId: "acc-1" } };

  test("groups the project's screens by screen scheme, default first, and scopes to the project", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1" });
    mocks.loadItssProjects.mockResolvedValue([{ itssId: "I1", projectId: "10000" }]);
    mocks.loadItssMappings.mockResolvedValue([
      { itssId: "I1", issueTypeId: "1", screenSchemeId: "SS_STORY", isDefault: true },
      { itssId: "I1", issueTypeId: "2", screenSchemeId: "SS_BUG", isDefault: false },
      { itssId: "I1", issueTypeId: "3", screenSchemeId: "SS_BUG", isDefault: false },
    ]);
    mocks.loadScreenSchemeOperations.mockResolvedValue([
      { schemeId: "SS_STORY", screenId: "S1" },
      { schemeId: "SS_BUG", screenId: "S2" },
      { schemeId: "SS_BUG", screenId: "S3" },
    ]);
    mocks.loadScreenSchemes.mockResolvedValue([
      { schemeId: "SS_STORY", name: "Story screens" },
      { schemeId: "SS_BUG", name: "Bug screens" },
    ]);
    mocks.loadScreensWithFieldsByIds.mockResolvedValue([
      { screenId: "S1", name: "Story", fields: [{ fieldId: "cf_1" }] },
      { screenId: "S2", name: "Bug create", fields: [{ fieldId: "cf_2" }, { fieldId: "cf_3" }] },
      { screenId: "S3", name: "Bug edit", fields: [{ fieldId: "cf_3" }] },
    ]);

    const result = await getProjectScreenReportInputs({ payload: { projectId: "10000" }, ...ctx });

    expect(result.available).toBe(true);
    expect(result.scopeProjectIds).toEqual(["10000"]);
    // Default scheme sorts first.
    expect(result.schemes[0].schemeId).toBe("SS_STORY");
    expect(result.schemes[0].isDefault).toBe(true);
    const bug = result.schemes.find((s) => s.schemeId === "SS_BUG");
    expect(bug.issueTypeCount).toBe(2);
    expect(bug.fieldIds.sort()).toEqual(["cf_2", "cf_3"]);
    expect(result.allFieldIds.sort()).toEqual(["cf_1", "cf_2", "cf_3"]);
  });

  test("refuses a project the caller cannot browse", async () => {
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set());
    const result = await getProjectScreenReportInputs({ payload: { projectId: "10000" }, ...ctx });
    expect(result.available).toBe(false);
  });
});

describe("getFieldScreenCounts", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  // Same tri-state as the reachability read, for the same reason: the Field Browser chip
  // renders an em dash for "unknown" and a warm 0 for "on no screen", and a map of zeroes
  // from an unbuilt snapshot would light up every card as safe to delete.
  test("reports unavailable rather than a map of zeroes when nothing is built", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);

    const result = await getFieldScreenCounts({ payload: { fieldIds: ["customfield_1"] }, ...ctx });

    expect(result.available).toBe(false);
    expect(result.counts).toEqual({});
    expect(mocks.loadScreenCountsForFields).not.toHaveBeenCalled();
  });

  test("returns counts for the requested page with the unresolved caveat attached", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "v1", refreshedAt: "t", unresolvedScreens: 3 });
    mocks.loadScreenCountsForFields.mockResolvedValue({ customfield_1: 6 });

    const result = await getFieldScreenCounts({ payload: { fieldIds: ["customfield_1", "customfield_2"] }, ...ctx });

    expect(result).toEqual(
      expect.objectContaining({ available: true, counts: { customfield_1: 6 }, unresolvedScreens: 3 }),
    );
  });

  test("caps the id list rather than passing an unbounded page to SQL", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "v1" });
    mocks.loadScreenCountsForFields.mockResolvedValue({});

    await getFieldScreenCounts({ payload: { fieldIds: Array.from({ length: 900 }, (_, i) => `f${i}`) }, ...ctx });

    expect(mocks.loadScreenCountsForFields.mock.calls[0][2]).toHaveLength(500);
  });

  test("treats a missing or malformed id list as an empty one", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "v1" });
    mocks.loadScreenCountsForFields.mockResolvedValue({});

    await getFieldScreenCounts({ payload: { fieldIds: "not-an-array" }, ...ctx });

    expect(mocks.loadScreenCountsForFields).toHaveBeenCalledWith("test-install", "v1", []);
  });
});

describe("buildScreenInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("queues a build when nothing is running", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ state: "idle" });
    mocks.readAdminConfig?.mockResolvedValue?.({ readOnlyMode: false });

    const result = await buildScreenInventory(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueScreenSnapshotBuild).toHaveBeenCalledWith("test-install");
  });

  test("refuses while a live build is running", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isScreenBuildStale.mockReturnValue(false);

    const result = await buildScreenInventory(ctx);

    expect(result).toMatchObject({ queued: false, reason: "already-building" });
    expect(mocks.queueScreenSnapshotBuild).not.toHaveBeenCalled();
  });

  // A wedged row would otherwise block every future rebuild with no way out of the UI --
  // the same trap the workflow build had to be rescued from.
  test("rebuilds over a wedged build rather than being blocked by it", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isScreenBuildStale.mockReturnValue(true);

    const result = await buildScreenInventory(ctx);

    expect(result.queued).toBe(true);
    expect(mocks.queueScreenSnapshotBuild).toHaveBeenCalled();
  });
});

// The screen x field cross. Costs no new Jira call -- both halves are already on disk --
// and produces the two findings no single pillar can. What matters here is that it never
// claims more than the two snapshots can support, and that it cannot take the health stage
// down with it.
describe("the screen cross-signal", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x", accountId: "acc-1" } };

  const ready = () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1", refreshedAt: "2026-09-11T09:00:00.000Z" });
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1", refreshedAt: "2026-09-10T09:00:00.000Z" });
    mocks.loadProjectScreenCoverage.mockResolvedValue([{ projectId: "10", screenCount: 3, unresolvedScreens: 0 }]);
    mocks.loadFieldReachabilityByProject.mockResolvedValue([
      { projectId: "10", fieldId: "cf_1", onCreate: true, onEdit: true, onView: true },
    ]);
    mocks.loadPopulatedProjectUsage.mockResolvedValue({
      truncated: false,
      limit: 20000,
      rows: [{ fieldId: "cf_2", projectId: "10", projectKey: "OPS", projectName: "Ops", issueCount: 480 }],
    });
    mocks.loadSnapshotFields.mockResolvedValue([
      { id: "cf_1", name: "Story Points" },
      { id: "cf_2", name: "Vendor Ref" },
    ]);
    // Reset per test: clearAllMocks keeps implementations, and one test sets its own.
    mocks.loadPopulatedFieldProjectPairs.mockResolvedValue({ pairs: new Set(["10|cf_2"]), complete: true });
  };

  describe("getScreenFieldCrossSignal", () => {
    test("crosses the two snapshots and dates each half separately", async () => {
      ready();
      const result = await getScreenFieldCrossSignal({ payload: {}, ...ctx });

      expect(result.available).toBe(true);
      expect(result.counts.invisibleFields).toBe(1);
      expect(result.invisibleData[0]).toMatchObject({ fieldId: "cf_2", fieldName: "Vendor Ref", totalIssues: 480 });
      // Both halves refresh independently; a verdict blending them is only as current as
      // the older one, so the reader gets both dates rather than one.
      expect(result.screenRefreshedAt).toBe("2026-09-11T09:00:00.000Z");
      expect(result.fieldRefreshedAt).toBe("2026-09-10T09:00:00.000Z");
    });

    test("names which half is missing rather than returning an empty cross", async () => {
      mocks.readScreenSnapshotMeta.mockResolvedValue(null);
      mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
      const noScreens = await getScreenFieldCrossSignal({ payload: {}, ...ctx });
      expect(noScreens.available).toBe(false);
      expect(noScreens.reason).toMatch(/no screen inventory/i);

      mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1" });
      mocks.readSnapshotMeta.mockResolvedValue(null);
      const noFields = await getScreenFieldCrossSignal({ payload: {}, ...ctx });
      expect(noFields.available).toBe(false);
      expect(noFields.reason).toMatch(/no field snapshot/i);
    });

    test("honours a near-zero clutter threshold from the caller", async () => {
      ready();
      // cf_1 holds 3 issues in project 10: populated above a floor of 0, not above 10.
      mocks.loadPopulatedFieldProjectPairs.mockImplementation(async (_key, _version, { minIssues = 0 } = {}) => ({
        pairs: new Set(minIssues < 3 ? ["10|cf_1", "10|cf_2"] : ["10|cf_2"]),
        complete: true,
      }));

      const strict = await getScreenFieldCrossSignal({ payload: {}, ...ctx });
      const lenient = await getScreenFieldCrossSignal({ payload: { clutterMaxIssues: 10 }, ...ctx });

      expect(strict.counts.clutterPlacements).toBe(0);
      expect(lenient.counts.clutterPlacements).toBe(1);
    });
  });

  describe("getScreenFieldCrossSignal — never filled means measured", () => {
    // Summary is never tallied by the issue crawl, so it has no usage row anywhere. It was
    // listed as "on 135 create screens, never filled".
    test("does not flag a field the crawl never measures", async () => {
      ready();
      mocks.loadFieldReachabilityByProject.mockResolvedValue([
        { projectId: "10", fieldId: "summary", onCreate: true, onEdit: true, onView: true },
      ]);
      mocks.loadSnapshotFields.mockResolvedValue([
        { id: "summary", name: "Summary" },
        { id: "cf_2", name: "Vendor Ref" },
      ]);

      const result = await getScreenFieldCrossSignal({ payload: {}, ...ctx });
      expect(result.formClutter).toEqual([]);
    });

    test("reads filled pairs from the complete read, not the capped usage rows", async () => {
      ready();
      mocks.loadPopulatedFieldProjectPairs.mockResolvedValueOnce({
        pairs: new Set(["10|cf_1", "10|cf_2"]),
        complete: true,
      });

      const result = await getScreenFieldCrossSignal({ payload: {}, ...ctx });
      expect(result.counts.clutterPlacements).toBe(0);
    });

    test("withholds clutter when the complete read fails", async () => {
      ready();
      mocks.loadPopulatedFieldProjectPairs.mockRejectedValueOnce(new Error("SQL timeout"));

      const result = await getScreenFieldCrossSignal({ payload: {}, ...ctx });
      expect(result.clutterAvailable).toBe(false);
      expect(result.formClutter).toEqual([]);
      // Invisible data does not depend on it.
      expect(result.counts.invisibleFields).toBe(1);
    });
  });

  describe("computeAndStoreScreenCross", () => {
    test("persists the counts with both source versions", async () => {
      ready();
      const result = await computeAndStoreScreenCross("inst");

      expect(result.available).toBe(true);
      expect(mocks.writeScreenCrossSummary).toHaveBeenCalledWith(
        "inst",
        expect.objectContaining({
          // Both versions, because the summary is only current while both still hold.
          screenVersion: "s1",
          fieldVersion: "f1",
        }),
      );
    });

    test("stores nothing when the cross could not be computed", async () => {
      ready();
      // Nothing resolved -> the summary is suppressed, and storing a suppressed result would
      // make the Overview show zeros that mean "we did not look".
      mocks.loadProjectScreenCoverage.mockResolvedValue([{ projectId: "10", screenCount: 3, unresolvedScreens: 3 }]);

      const result = await computeAndStoreScreenCross("inst");

      expect(result.available).toBe(false);
      expect(mocks.writeScreenCrossSummary).not.toHaveBeenCalled();
    });

    test("returns null rather than throwing when a half is missing", async () => {
      mocks.readScreenSnapshotMeta.mockResolvedValue(null);
      mocks.readSnapshotMeta.mockResolvedValue(null);
      expect(await computeAndStoreScreenCross("inst")).toBeNull();
    });

    // This runs inside the health stage of every scan. A throw here would fail the stage and
    // cost the whole score, to save two dimensions that are excluded from the mean anyway.
    test("swallows a query failure instead of taking the health stage down", async () => {
      ready();
      mocks.loadFieldReachabilityByProject.mockRejectedValueOnce(new Error("SQL exploded"));
      expect(await computeAndStoreScreenCross("inst")).toBeNull();
    });

    test("a failed summary write still returns the computed cross", async () => {
      ready();
      mocks.writeScreenCrossSummary.mockRejectedValueOnce(new Error("write failed"));
      const result = await computeAndStoreScreenCross("inst");
      expect(result.available).toBe(true);
    });
  });
});
