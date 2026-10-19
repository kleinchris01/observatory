import { describe, test, expect, beforeEach } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, ctxWithAccount } from "./test-harness.js";
import { SHARED_RESOLVER_FUNCTIONS, ADMIN_ONLY_FUNCTIONS, __RAW_ADMIN_ONLY_FUNCTIONS } from "../resolvers.js";

const {
  getAutomationInsights,
  saveAutomationAnalysis,
  getAutomationIndex,
  saveAutomationIndex,
  getAutomationCascades,
  getCascadeGraph,
  getAutomationBlast,
  getStatusAutomationUsage,
  getAutomationFieldUsage,
  getAutomationFieldCounts,
} = __RAW_ADMIN_ONLY_FUNCTIONS;

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

describe("getAutomationInsights", () => {
  const doc = {
    schemaVersion: 1,
    refreshedAt: 1754400000000,
    source: "export-file",
    estate: { ruleCount: 1477, enabledCount: 874, disabledCount: 603 },
    findingsPreview: [{ id: 1, n: "Send to approval", s: "high", r: [{ c: "embedded-credential", s: "high" }] }],
    findingsTotal: 675,
    cascades: [{ sourceId: 1, targetId: 2, field: "Actual SEOBD", selfTriggering: false }],
    cascadesTotal: 1457,
    selfTriggeringTotal: 123,
  };

  test("reports unavailable rather than empty when the analysis has never been built", async () => {
    mocks.readAutomationAnalysis.mockResolvedValue(null);

    const result = await getAutomationInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.available).toBe(false);
    expect(result.reason).toBe("no-analysis");
  });

  test("returns the stored estate and findings", async () => {
    mocks.readAutomationAnalysis.mockResolvedValue(doc);

    const result = await getAutomationInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.available).toBe(true);
    expect(result.estate).toMatchObject({ ruleCount: 1477, enabledCount: 874 });
    expect(result.findingsPreview).toHaveLength(1);
    expect(result.refreshedAt).toBe(1754400000000);
  });

  // The stored lists are capped. Reporting only what survived truncation would present a
  // partial list as the complete set of problems on the site.
  test("reports the true totals alongside the truncated lists", async () => {
    mocks.readAutomationAnalysis.mockResolvedValue(doc);

    const result = await getAutomationInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.findingsTotal).toBe(675);
    expect(result.cascadesTotal).toBe(1457);
    expect(result.selfTriggeringTotal).toBe(123);
  });

  test("falls back to list lengths when a document predates the total fields", async () => {
    mocks.readAutomationAnalysis.mockResolvedValue({ ...doc, findingsTotal: undefined, cascadesTotal: undefined });

    const result = await getAutomationInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.findingsTotal).toBe(1);
    expect(result.cascadesTotal).toBe(1);
  });

  test("returns the cross-rule totals and lists the analysis stored", async () => {
    mocks.readAutomationAnalysis.mockResolvedValueOnce({
      ...doc,
      eventCascades: [{ sourceId: 1, targetId: 2 }],
      eventCascadesTotal: 3,
      competingPairs: [],
      competingPairsTotal: 0,
      fieldContradictions: [{ field: "Priority" }],
      fieldContradictionsTotal: 1,
    });

    const result = await getAutomationInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.eventCascadesTotal).toBe(3);
    expect(result.eventCascades).toHaveLength(1);
    expect(result.competingPairsTotal).toBe(0);
    expect(result.fieldContradictionsTotal).toBe(1);
  });

  // An analysis saved before these checks were stored was never measured for them. Zero
  // would claim the rules were checked and found clean.
  test("reports the cross-rule totals as null on an analysis that predates them", async () => {
    mocks.readAutomationAnalysis.mockResolvedValueOnce(doc);

    const result = await getAutomationInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.eventCascadesTotal).toBeNull();
    expect(result.competingPairsTotal).toBeNull();
    expect(result.fieldContradictionsTotal).toBeNull();
    expect(result.eventCascades).toEqual([]);
  });

  // A document written by an older build can be missing any of these. Each field falls back
  // to an empty value rather than reaching the client as undefined, where the tab would
  // render "undefined rules" or throw on a map of nothing.
  test("fills every absent field rather than passing undefined to the tab", async () => {
    mocks.readAutomationAnalysis.mockResolvedValue({ schemaVersion: 1 });

    const result = await getAutomationInsights({ payload: {}, context: ctxWithAccount() });

    expect(result).toMatchObject({
      available: true,
      refreshedAt: null,
      source: "unknown",
      estate: null,
      findingsPreview: [],
      findingsTotal: 0,
      cascades: [],
      cascadesTotal: 0,
      selfTriggeringTotal: 0,
    });
  });

  // The preview exists for the overview only. Sending 675 rows with the first paint would
  // slow every visit to pay for a section most of them never open.
  test("sends only a preview, leaving the full list to its own fetch", async () => {
    mocks.readAutomationAnalysis.mockResolvedValue(doc);

    const result = await getAutomationInsights({ payload: {}, context: ctxWithAccount() });

    expect(result.findingsPreview.length).toBeLessThan(result.findingsTotal);
    expect(result).not.toHaveProperty("findings");
  });

  test("propagates a storage failure rather than reporting a clean estate", async () => {
    mocks.readAutomationAnalysis.mockRejectedValue(new Error("kvs exploded"));

    await expect(getAutomationInsights({ payload: {}, context: ctxWithAccount() })).rejects.toThrow("kvs exploded");
  });

  // Rule names, project scope and outbound hosts together describe the site's integration
  // surface. This must not be reachable from the macro handler.
  test("is registered admin-only, not shared with the macro handler", () => {
    expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toContain("getAutomationInsights");
    expect(Object.keys(SHARED_RESOLVER_FUNCTIONS)).not.toContain("getAutomationInsights");
  });
});

describe("saveAutomationAnalysis", () => {
  const valid = {
    schemaVersion: 1,
    source: "export-file",
    estate: { ruleCount: 1477, enabledCount: 874, disabledCount: 603 },
    findingsPreview: [{ id: 1, n: "r", s: "high", r: [] }],
    findingsTotal: 675,
    cascades: [{ sourceId: 1, targetId: 2, selfTriggering: false }],
    cascadesTotal: 1457,
    selfTriggeringTotal: 123,
  };

  beforeEach(() => {
    mocks.writeAutomationAnalysis.mockResolvedValue(undefined);
  });

  test("stores a valid document under the installation scope", async () => {
    const result = await saveAutomationAnalysis({ payload: { analysis: valid }, context: ctxWithAccount() });

    expect(result.saved).toBe(true);
    const [, stored] = mocks.writeAutomationAnalysis.mock.calls[0];
    expect(stored).toMatchObject({ schemaVersion: 1, estate: valid.estate, findingsTotal: 675, cascadesTotal: 1457 });
  });

  // The three cross-rule checks were computed by the analysis and then dropped on save, so
  // their tiles read 0 on every site. Totals describe the estate; lists are capped.
  test("keeps the cross-rule totals and capped lists", async () => {
    const pairs = Array.from({ length: 140 }, (_, i) => ({ a: i, b: i + 1 }));
    await saveAutomationAnalysis({
      payload: {
        analysis: {
          ...valid,
          eventCascades: [{ sourceId: 1, targetId: 2 }],
          eventCascadesTotal: 4,
          competingPairs: pairs,
          competingPairsTotal: 140,
          fieldContradictions: [],
          fieldContradictionsTotal: 0,
        },
      },
      context: ctxWithAccount(),
    });

    const [, stored] = mocks.writeAutomationAnalysis.mock.calls[0];
    expect(stored.eventCascadesTotal).toBe(4);
    expect(stored.eventCascades).toHaveLength(1);
    expect(stored.competingPairsTotal).toBe(140);
    expect(stored.competingPairs).toHaveLength(100);
    expect(stored.fieldContradictionsTotal).toBe(0);
    expect(stored.fieldContradictions).toEqual([]);
  });

  test("leaves a cross-rule check unmeasured when the payload carries no list", async () => {
    await saveAutomationAnalysis({ payload: { analysis: valid }, context: ctxWithAccount() });

    const [, stored] = mocks.writeAutomationAnalysis.mock.calls[0];
    expect(stored).not.toHaveProperty("eventCascadesTotal");
    expect(stored).not.toHaveProperty("competingPairsTotal");
  });

  // A skewed workstation clock would otherwise stamp the analysis hours out, and that
  // timestamp is what the staleness warning is built on.
  test("stamps the server clock, not the browser's", async () => {
    const before = Date.now();
    await saveAutomationAnalysis({
      payload: { analysis: { ...valid, refreshedAt: 111 } },
      context: ctxWithAccount(),
    });

    const [, stored] = mocks.writeAutomationAnalysis.mock.calls[0];
    expect(stored.refreshedAt).toBeGreaterThanOrEqual(before);
  });

  // The client applies these caps too. Re-applying them here means a client regression
  // cannot write a value too large for KVS to hold.
  test("re-applies the size caps rather than trusting the client", async () => {
    const oversized = {
      ...valid,
      findingsPreview: Array.from({ length: 500 }, (_, i) => ({ id: i, r: [] })),
      cascades: Array.from({ length: 400 }, (_, i) => ({ sourceId: i, targetId: i })),
    };

    await saveAutomationAnalysis({ payload: { analysis: oversized }, context: ctxWithAccount() });

    const [, stored] = mocks.writeAutomationAnalysis.mock.calls[0];
    expect(stored.findingsPreview).toHaveLength(20);
    expect(stored.cascades).toHaveLength(150);
  });

  test("keeps the estate totals even when the lists are truncated", async () => {
    await saveAutomationAnalysis({ payload: { analysis: valid }, context: ctxWithAccount() });

    const [, stored] = mocks.writeAutomationAnalysis.mock.calls[0];
    expect(stored.findingsTotal).toBe(675);
    expect(stored.cascadesTotal).toBe(1457);
  });

  test("rejects a document with no estate", async () => {
    await expect(
      saveAutomationAnalysis({ payload: { analysis: { schemaVersion: 1 } }, context: ctxWithAccount() }),
    ).rejects.toThrow(/estate is required/);
    expect(mocks.writeAutomationAnalysis).not.toHaveBeenCalled();
  });

  test("rejects an unsupported schema version", async () => {
    await expect(
      saveAutomationAnalysis({ payload: { analysis: { ...valid, schemaVersion: 2 } }, context: ctxWithAccount() }),
    ).rejects.toThrow(/schemaVersion/);
  });

  test("rejects a non-object payload", async () => {
    await expect(
      saveAutomationAnalysis({ payload: { analysis: [1, 2, 3] }, context: ctxWithAccount() }),
    ).rejects.toThrow(/must be an object/);
  });

  test("is registered admin-only", () => {
    expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toContain("saveAutomationAnalysis");
    expect(Object.keys(SHARED_RESOLVER_FUNCTIONS)).not.toContain("saveAutomationAnalysis");
  });

  test("coerces the blast rollup and caps its top list", async () => {
    const blast = {
      available: true,
      total: 1477,
      byTier: { estate: 12, "cross-project": 40, project: 300, contained: 1125, junk: 9 },
      estateWideCount: 12,
      estateWideShare: 12 / 1477,
      estateWideCredentialCount: "3",
      estimatedCount: 1477,
      top: Array.from({ length: 40 }, (_, i) => ({ ruleId: i, score: `${i}`, tier: "estate" })),
    };
    await saveAutomationAnalysis({ payload: { analysis: { ...valid, blast } }, context: ctxWithAccount() });

    const [, stored] = mocks.writeAutomationAnalysis.mock.calls[0];
    expect(stored.blast.byTier).toEqual({ estate: 12, "cross-project": 40, project: 300, contained: 1125 });
    expect(stored.blast.estateWideCredentialCount).toBe(3);
    expect(stored.blast.top).toHaveLength(20);
    expect(stored.blast.top[0]).toEqual({ ruleId: "0", score: 0, tier: "estate" });
  });

  test("a missing or malformed blast rollup stores null rather than throwing", async () => {
    for (const bad of [undefined, null, "nope", [1, 2], { total: 5, top: "not-an-array" }]) {
      mocks.writeAutomationAnalysis.mockClear();
      await saveAutomationAnalysis({ payload: { analysis: { ...valid, blast: bad } }, context: ctxWithAccount() });
      const [, stored] = mocks.writeAutomationAnalysis.mock.calls[0];
      if (bad && typeof bad === "object" && !Array.isArray(bad)) {
        expect(stored.blast.top).toEqual([]);
      } else {
        expect(stored.blast).toBeNull();
      }
    }
  });
});

describe("saveAutomationIndex", () => {
  beforeEach(() => {
    mocks.writeAutomationPart.mockResolvedValue(undefined);
    mocks.loadAutomationReferencesFor.mockResolvedValue({ references: [], total: 0, ruleCount: 0 });
  });

  test("stores a field index under its own part", async () => {
    const doc = { schemaVersion: 1, kind: "field", total: 735, entries: [] };
    const result = await saveAutomationIndex({ payload: { part: "fields", document: doc }, context: ctxWithAccount() });

    expect(result).toMatchObject({ saved: true, part: "fields" });
    expect(mocks.writeAutomationPart).toHaveBeenCalledWith(expect.any(String), "fields", doc);
  });

  // The analysis has its own resolver, with validation and the server-clock stamp. Routing
  // it through here would bypass both.
  test("refuses to write the analysis part", async () => {
    await expect(
      saveAutomationIndex({ payload: { part: "analysis", document: { schemaVersion: 1 } }, context: ctxWithAccount() }),
    ).rejects.toThrow(/unknown automation index part/);
    expect(mocks.writeAutomationPart).not.toHaveBeenCalled();
  });

  // The SQL shred. Each part routes to a different writer, and none of them may fail the
  // import: the KVS write has already succeeded and is what the tab still renders.
  describe("shredding into SQL", () => {
    beforeEach(() => {
      mocks.writeAutomationPart.mockResolvedValue(undefined);
      mocks.replaceAutomationReferences.mockResolvedValue(4);
      mocks.replaceAutomationRules.mockResolvedValue(2);
      mocks.replaceAutomationFindings.mockResolvedValue(3);
      mocks.readAutomationPart.mockResolvedValue(null);
    });

    // A reference row needs both indexes, because fields and statuses share one table and
    // the write replaces the whole scope. Saving one part must not erase the other.
    test.each([["fields"], ["statuses"]])("routes %s through the reference writer with both indexes", async (part) => {
      const other = { schemaVersion: 1, entries: [{ label: "Other", write: ["7"] }] };
      mocks.readAutomationPart.mockResolvedValue(other);
      const doc = { schemaVersion: 1, entries: [{ label: "A", write: ["1"] }] };

      const result = await saveAutomationIndex({ payload: { part, document: doc }, context: ctxWithAccount() });

      expect(mocks.replaceAutomationReferences).toHaveBeenCalledWith(expect.any(String), {
        fields: part === "fields" ? doc : other,
        statuses: part === "statuses" ? doc : other,
      });
      expect(result.rowsWritten).toBe(4);
    });

    test("routes the directory through the rule writer", async () => {
      const doc = { schemaVersion: 1, rules: [["1", "Rule", 1, "manual", 0]] };
      const result = await saveAutomationIndex({
        payload: { part: "directory", document: doc },
        context: ctxWithAccount(),
      });
      expect(mocks.replaceAutomationRules).toHaveBeenCalledWith(expect.any(String), doc);
      expect(mocks.replaceAutomationReferences).not.toHaveBeenCalled();
      expect(result.rowsWritten).toBe(2);
    });

    test("routes findings through the findings writer", async () => {
      const doc = { schemaVersion: 1, findings: [{ id: 1, r: [{ c: "x", s: "high" }] }] };
      const result = await saveAutomationIndex({
        payload: { part: "findings", document: doc },
        context: ctxWithAccount(),
      });
      expect(mocks.replaceAutomationFindings).toHaveBeenCalledWith(expect.any(String), doc);
      expect(result.rowsWritten).toBe(3);
    });

    test("routes the blast part through the blast writer and never touches KVS for it", async () => {
      mocks.replaceAutomationBlast.mockResolvedValue(7);
      const doc = { schemaVersion: 1, rules: [{ id: "1", score: 88, tier: "estate" }] };
      const result = await saveAutomationIndex({
        payload: { part: "blast", document: doc },
        context: ctxWithAccount(),
      });
      expect(mocks.replaceAutomationBlast).toHaveBeenCalledWith(expect.any(String), doc);
      expect(mocks.writeAutomationPart).not.toHaveBeenCalledWith(expect.any(String), "blast", expect.anything());
      expect(result.rowsWritten).toBe(7);
    });

    test("a SQL failure on the blast part fails the import — there is no KVS copy behind it", async () => {
      mocks.replaceAutomationBlast.mockRejectedValue(new Error("sql down"));
      await expect(
        saveAutomationIndex({
          payload: { part: "blast", document: { schemaVersion: 1, rules: [] } },
          context: ctxWithAccount(),
        }),
      ).rejects.toThrow("sql down");
    });

    // The whole point of best-effort: SQL is the secondary copy while the UI still reads
    // KVS, so losing it must degrade the index, never the import.
    test("still reports the import saved when the SQL shred throws", async () => {
      mocks.replaceAutomationRules.mockRejectedValue(new Error("sql down"));
      const result = await saveAutomationIndex({
        payload: { part: "directory", document: { schemaVersion: 1, rules: [] } },
        context: ctxWithAccount(),
      });
      expect(result).toMatchObject({ saved: true, part: "directory" });
      expect(mocks.writeAutomationPart).toHaveBeenCalled();
    });
  });

  test("refuses an unknown part rather than writing to a computed key", async () => {
    await expect(
      saveAutomationIndex({
        payload: { part: "__proto__", document: { schemaVersion: 1 } },
        context: ctxWithAccount(),
      }),
    ).rejects.toThrow(/unknown automation index part/);
  });

  test("rejects a document with the wrong schema version", async () => {
    await expect(
      saveAutomationIndex({ payload: { part: "fields", document: { schemaVersion: 9 } }, context: ctxWithAccount() }),
    ).rejects.toThrow(/schemaVersion/);
  });

  test("rejects a non-object document", async () => {
    await expect(
      saveAutomationIndex({ payload: { part: "fields", document: [] }, context: ctxWithAccount() }),
    ).rejects.toThrow(/must be an object/);
  });
});

describe("getAutomationIndex", () => {
  test("returns the stored entries and total", async () => {
    mocks.readAutomationPart.mockResolvedValue({ schemaVersion: 1, total: 735, entries: [{ label: "Story Points" }] });

    const result = await getAutomationIndex({ payload: { part: "fields" }, context: ctxWithAccount() });

    expect(result).toMatchObject({ available: true, part: "fields", total: 735 });
    expect(result.entries).toHaveLength(1);
  });

  test("returns the rule tuples for the directory part", async () => {
    mocks.readAutomationPart.mockResolvedValue({ schemaVersion: 1, total: 2, rules: [[1, "A", 1, "t", 0]] });

    const result = await getAutomationIndex({ payload: { part: "directory" }, context: ctxWithAccount() });

    expect(result.rules).toEqual([[1, "A", 1, "t", 0]]);
  });

  // Distinct from an empty index: the section says "re-import to build this" rather than
  // "this site references no fields", which would be a claim the data does not support.
  test("reports unavailable when the index has never been built", async () => {
    mocks.readAutomationPart.mockResolvedValue(null);

    const result = await getAutomationIndex({ payload: { part: "statuses" }, context: ctxWithAccount() });

    expect(result).toMatchObject({ available: false, reason: "no-index" });
  });

  test("refuses an unknown part", async () => {
    await expect(getAutomationIndex({ payload: { part: "secrets" }, context: ctxWithAccount() })).rejects.toThrow(
      /unknown automation index part/,
    );
  });

  // A rule that creates an issue of a type names it by numeric id, so the issue-type index
  // arrives half-labelled with "10022". Resolved against the inventory on read.
  test("resolves issue-type id labels to names from the inventory", async () => {
    mocks.readAutomationPart.mockResolvedValue({
      schemaVersion: 1,
      total: 2,
      entries: [
        {
          label: "10022",
          writeCount: 3,
          readCount: 0,
          triggerCount: 0,
          total: 3,
          ruleCount: 3,
          write: ["r1", "r2", "r3"],
          read: [],
          trigger: [],
        },
        {
          label: "current",
          writeCount: 1,
          readCount: 0,
          triggerCount: 0,
          total: 1,
          ruleCount: 1,
          write: ["r9"],
          read: [],
          trigger: [],
        },
      ],
    });
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadIssueTypes.mockResolvedValue([
      { id: "10022", name: "Incident" },
      { id: "10000", name: "Bug" },
    ]);

    const result = await getAutomationIndex({ payload: { part: "issueTypes" }, context: ctxWithAccount() });

    const labels = result.entries.map((e) => e.label);
    expect(labels).toContain("Incident");
    expect(labels).not.toContain("10022");
    // A label that is not a known id -- a smart-value literal -- is left alone.
    expect(labels).toContain("current");
  });

  test("merges an issue type referenced once by id and once by name", async () => {
    mocks.readAutomationPart.mockResolvedValue({
      schemaVersion: 1,
      total: 2,
      entries: [
        {
          label: "10022",
          writeCount: 2,
          readCount: 0,
          triggerCount: 0,
          total: 2,
          ruleCount: 2,
          write: ["r1", "r2"],
          read: [],
          trigger: [],
        },
        {
          label: "Incident",
          writeCount: 0,
          readCount: 1,
          triggerCount: 0,
          total: 1,
          ruleCount: 1,
          write: [],
          read: ["r3"],
          trigger: [],
        },
      ],
    });
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadIssueTypes.mockResolvedValue([{ id: "10022", name: "Incident" }]);

    const result = await getAutomationIndex({ payload: { part: "issueTypes" }, context: ctxWithAccount() });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ label: "Incident", writeCount: 2, readCount: 1, total: 3, ruleCount: 3 });
    expect(result.total).toBe(1);
  });

  test("leaves the issue-type index untouched when no inventory has been built", async () => {
    mocks.readAutomationPart.mockResolvedValue({
      schemaVersion: 1,
      total: 1,
      entries: [
        {
          label: "10022",
          writeCount: 1,
          readCount: 0,
          triggerCount: 0,
          total: 1,
          write: ["r1"],
          read: [],
          trigger: [],
        },
      ],
    });
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue(null);

    const result = await getAutomationIndex({ payload: { part: "issueTypes" }, context: ctxWithAccount() });

    expect(result.entries[0].label).toBe("10022");
    expect(mocks.loadIssueTypes).not.toHaveBeenCalled();
  });

  test("resolves user-index accountId labels to display names from the roster", async () => {
    mocks.readAutomationPart.mockResolvedValue({
      schemaVersion: 1,
      total: 2,
      entries: [
        {
          label: "acc-1",
          writeCount: 4,
          readCount: 0,
          triggerCount: 0,
          total: 4,
          ruleCount: 4,
          write: ["r1", "r2", "r3", "r4"],
          read: [],
          trigger: [],
        },
        {
          label: "acc-gone",
          writeCount: 1,
          readCount: 0,
          triggerCount: 0,
          total: 1,
          ruleCount: 1,
          write: ["r9"],
          read: [],
          trigger: [],
        },
      ],
    });
    mocks.readUserSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "acc-1", displayName: "Ann Admin" }]);

    const result = await getAutomationIndex({ payload: { part: "users" }, context: ctxWithAccount() });

    const labels = result.entries.map((e) => e.label);
    expect(labels).toContain("Ann Admin");
    // An account not on the roster is left as its id -- an orphaned reference.
    expect(labels).toContain("acc-gone");
  });

  test("both index resolvers are admin-only", () => {
    for (const name of ["getAutomationIndex", "saveAutomationIndex"]) {
      expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toContain(name);
      expect(Object.keys(SHARED_RESOLVER_FUNCTIONS)).not.toContain(name);
    }
  });
});

describe("getAutomationFieldUsage", () => {
  const fieldsIndex = {
    schemaVersion: 1,
    total: 2,
    entries: [
      { label: "Story Points", writeCount: 2, readCount: 1, triggerCount: 0, write: [10, 11], read: [12], trigger: [] },
      { label: "customfield_23054", writeCount: 1, readCount: 0, triggerCount: 0, write: [13], read: [], trigger: [] },
    ],
  };
  const directory = {
    schemaVersion: 1,
    total: 4,
    rules: [
      [10, "Populate points", 1, "jira.issue.field.changed", 1],
      [11, "Copy to subtasks", 0, "jira.manual.trigger.issue", 1],
      [12, "Check points set", 1, "jira.jql.scheduled", 0],
      [13, "Set prototype", 1, null, 0],
    ],
  };

  function stubParts({ fields = fieldsIndex, dir = directory } = {}) {
    mocks.readAutomationPart.mockImplementation((_key, part) =>
      Promise.resolve(part === "fields" ? fields : part === "directory" ? dir : null),
    );
  }

  test("names the rules that touch the field, grouped by direction", async () => {
    stubParts();

    const result = await getAutomationFieldUsage({
      payload: { fieldName: "Story Points", fieldId: "customfield_1" },
      context: ctxWithAccount(),
    });

    expect(result).toMatchObject({ available: true, referenced: true, label: "Story Points" });
    expect(result.write.rules.map((r) => r.name)).toEqual(["Populate points", "Copy to subtasks"]);
    expect(result.read.rules.map((r) => r.name)).toEqual(["Check points set"]);
    expect(result.trigger.count).toBe(0);
  });

  test("carries each rule's enabled state, since a disabled rule is not currently a dependency", async () => {
    stubParts();

    const result = await getAutomationFieldUsage({ payload: { fieldName: "Story Points" }, context: ctxWithAccount() });

    expect(result.write.rules.find((r) => r.name === "Copy to subtasks").enabled).toBe(false);
    expect(result.write.rules.find((r) => r.name === "Populate points").enabled).toBe(true);
  });

  test("matches on field id when the rule addressed the field that way", async () => {
    stubParts();

    const result = await getAutomationFieldUsage({
      payload: { fieldId: "customfield_23054", fieldName: "Requested Prototype" },
      context: ctxWithAccount(),
    });

    expect(result.referenced).toBe(true);
    expect(result.write.rules[0].name).toBe("Set prototype");
  });

  test("matches names case-insensitively, because rule authors' casing drifts", async () => {
    stubParts();

    const result = await getAutomationFieldUsage({ payload: { fieldName: "story points" }, context: ctxWithAccount() });

    expect(result.referenced).toBe(true);
  });

  test("reports a field no rule touches as referenced:false", async () => {
    stubParts();

    const result = await getAutomationFieldUsage({ payload: { fieldName: "Unused Field" }, context: ctxWithAccount() });

    expect(result).toMatchObject({ available: true, referenced: false });
  });

  // The distinction the whole pillar exists for. "No analysis" must never render as "no
  // rules use this field", which is the false reassurance that gets a field deleted.
  test("reports unavailable, not unreferenced, when no analysis has been built", async () => {
    mocks.readAutomationPart.mockResolvedValue(null);

    const result = await getAutomationFieldUsage({ payload: { fieldName: "Story Points" }, context: ctxWithAccount() });

    expect(result).toMatchObject({ available: false, reason: "no-analysis" });
    expect(result.referenced).toBeUndefined();
  });

  test("keeps a rule the directory does not name rather than dropping the dependency", async () => {
    stubParts({ dir: { schemaVersion: 1, total: 0, rules: [] } });

    const result = await getAutomationFieldUsage({ payload: { fieldName: "Story Points" }, context: ctxWithAccount() });

    expect(result.write.rules).toHaveLength(2);
    expect(result.write.rules[0].name).toBe("Rule 10");
  });

  test("requires a field to look up", async () => {
    await expect(getAutomationFieldUsage({ payload: {}, context: ctxWithAccount() })).rejects.toThrow(
      /fieldName or fieldId/,
    );
  });

  test("is admin-only", () => {
    expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toContain("getAutomationFieldUsage");
    expect(Object.keys(SHARED_RESOLVER_FUNCTIONS)).not.toContain("getAutomationFieldUsage");
  });
});

// SQL is now the primary read for a single field's automation usage. These cover the
// boundary between it and the documents, which is where the risk is: an install that
// imported before the tables existed has KVS copies and no rows, and must not be told
// "not referenced" -- that is precisely the false reassurance this pillar exists to stop.
describe("getAutomationFieldUsage storage path", () => {
  const sqlRows = {
    total: 3,
    ruleCount: 2,
    references: [
      { direction: "write", rule_id: "1", name: "Set points", enabled: 1 },
      { direction: "read", rule_id: "2", name: "Check points", enabled: 0 },
      { direction: "trigger", rule_id: "1", name: "Set points", enabled: 1 },
    ],
  };

  test("answers from SQL when rows exist, without reading the documents", async () => {
    mocks.loadAutomationReferencesFor.mockResolvedValue(sqlRows);
    const result = await getAutomationFieldUsage({ payload: { fieldName: "Story Points" }, context: ctxWithAccount() });

    expect(result).toMatchObject({ available: true, referenced: true, source: "sql" });
    expect(result.write.count).toBe(1);
    expect(result.read.rules[0].name).toBe("Check points");
    expect(mocks.readAutomationPart).not.toHaveBeenCalled();
  });

  // A disabled rule is not currently a dependency, and that distinction has to survive
  // the move from documents to rows.
  test("carries enabled state through from the join", async () => {
    mocks.loadAutomationReferencesFor.mockResolvedValue(sqlRows);
    const result = await getAutomationFieldUsage({ payload: { fieldName: "Story Points" }, context: ctxWithAccount() });
    expect(result.write.rules[0].enabled).toBe(true);
    expect(result.read.rules[0].enabled).toBe(false);
  });

  test("falls back to the documents when SQL has no rows for the label", async () => {
    mocks.loadAutomationReferencesFor.mockResolvedValue({ references: [], total: 0, ruleCount: 0 });
    mocks.readAutomationPart.mockImplementation((_k, part) =>
      part === "fields"
        ? { schemaVersion: 1, entries: [{ label: "Story Points", write: ["9"], writeCount: 1, read: [], trigger: [] }] }
        : { schemaVersion: 1, rules: [["9", "Legacy rule", 1, "manual", 0]] },
    );

    const result = await getAutomationFieldUsage({ payload: { fieldName: "Story Points" }, context: ctxWithAccount() });
    expect(result).toMatchObject({ referenced: true, source: "kvs" });
    expect(result.write.rules[0].name).toBe("Legacy rule");
  });

  // A SQL outage must degrade to the documents, not to a wrong answer.
  test("falls back to the documents when the SQL read throws", async () => {
    mocks.loadAutomationReferencesFor.mockRejectedValue(new Error("sql down"));
    mocks.readAutomationPart.mockImplementation((_k, part) =>
      part === "fields" ? { schemaVersion: 1, entries: [] } : null,
    );

    const result = await getAutomationFieldUsage({ payload: { fieldName: "Story Points" }, context: ctxWithAccount() });
    expect(result).toMatchObject({ available: true, referenced: false });
  });

  // With neither rows nor a document there is no analysis at all, which is a different
  // claim from "no rule touches this".
  test("still reports no-analysis rather than not-referenced when nothing exists", async () => {
    mocks.loadAutomationReferencesFor.mockResolvedValue({ references: [], total: 0, ruleCount: 0 });
    mocks.readAutomationPart.mockResolvedValue(null);

    const result = await getAutomationFieldUsage({ payload: { fieldName: "Story Points" }, context: ctxWithAccount() });
    expect(result).toMatchObject({ available: false, reason: "no-analysis" });
  });
});

describe("getAutomationFieldCounts", () => {
  const index = {
    schemaVersion: 1,
    total: 2,
    entries: [
      { label: "Story Points", ruleCount: 5, enabledRules: 3, disabledRules: 2, write: [], read: [], trigger: [] },
      { label: "customfield_23054", ruleCount: 1, enabledRules: 1, disabledRules: 0, write: [], read: [], trigger: [] },
    ],
  };

  test("answers for a whole page of fields in one read of the index", async () => {
    mocks.readAutomationPart.mockResolvedValue(index);

    const result = await getAutomationFieldCounts({
      payload: {
        fields: [
          { id: "cf_1", name: "Story Points" },
          { id: "customfield_23054", name: "Requested Prototype" },
        ],
      },
      context: ctxWithAccount(),
    });

    expect(mocks.readAutomationPart).toHaveBeenCalledTimes(1);
    expect(result.counts.cf_1).toEqual({ enabled: 3, disabled: 2, total: 5 });
    expect(result.counts.customfield_23054).toEqual({ enabled: 1, disabled: 0, total: 1 });
  });

  test("returns zeroes for a field no rule touches", async () => {
    mocks.readAutomationPart.mockResolvedValue(index);

    const result = await getAutomationFieldCounts({
      payload: { fields: [{ id: "cf_9", name: "Unused" }] },
      context: ctxWithAccount(),
    });

    expect(result.counts.cf_9).toEqual({ enabled: 0, disabled: 0, total: 0 });
  });

  // The chips render an em dash for this, not 0. "Never measured" is not "nothing uses it".
  test("reports unavailable when no analysis has been built", async () => {
    mocks.readAutomationPart.mockResolvedValue(null);

    const result = await getAutomationFieldCounts({
      payload: { fields: [{ id: "cf_1", name: "Story Points" }] },
      context: ctxWithAccount(),
    });

    expect(result).toMatchObject({ available: false, reason: "no-analysis" });
    expect(result.counts).toEqual({});
  });

  test("caps the batch so one call cannot ask about the whole estate", async () => {
    mocks.readAutomationPart.mockResolvedValue(index);
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `cf_${i}`, name: `F${i}` }));

    const result = await getAutomationFieldCounts({ payload: { fields: many }, context: ctxWithAccount() });

    expect(Object.keys(result.counts)).toHaveLength(100);
  });

  test("handles an empty request without reading storage", async () => {
    const result = await getAutomationFieldCounts({ payload: { fields: [] }, context: ctxWithAccount() });
    expect(result).toEqual({ available: true, counts: {} });
    expect(mocks.readAutomationPart).not.toHaveBeenCalled();
  });
});

// Automation is a blind spot in the workflow findings: a status can look unreachable while
// a rule still transitions issues into it. Jira's automation API is undocumented, so this
// resolver asks which endpoints answer instead of assuming — and must never fail the page
// it runs on.
describe("probeAutomationApi", () => {
  // Admin-only resolvers are exported wrapped in withAdminGuard + withAuditTrail. The raw
  // registry exists so a test can exercise the resolver's own logic without standing up a
  // permission mock.
  const probeAutomationApi = __RAW_ADMIN_ONLY_FUNCTIONS.probeAutomationApi;

  beforeEach(() => {
    mocks.getAllJiraProjects.mockResolvedValue([{ id: "10000", key: "ALPHA", name: "Alpha" }]);
    mocks.getCloudId.mockReturnValue("11111111-2222-3333-4444-555555555555");
    mocks.probeStargateEndpoint.mockResolvedValue({ path: "s", status: 404, ok: false, ms: 5, sample: "" });
  });

  test("probes both global and project scopes", async () => {
    mocks.probeEndpoint.mockResolvedValue({ path: "x", status: 404, ok: false, ms: 5, sample: "not found" });

    const result = await probeAutomationApi({ context: {} });

    const scopes = new Set(result.results.map((r) => r.scope));
    expect(scopes.has("global")).toBe(true);
    expect(scopes.has("project")).toBe(true);
    // Asserted on what was REQUESTED, not on the returned row: the stub returns a canned
    // path, so checking the result would test the mock rather than the resolver.
    const requested = mocks.probeEndpoint.mock.calls.map((c) => c[0]);
    expect(requested.some((path) => path.includes("10000"))).toBe(true);
    expect(requested.some((path) => path.includes("GLOBAL"))).toBe(true);

    // The documented automation API lives on api.atlassian.com, not the site, so it has to
    // go through Stargate -- asking the site for it is what produced the first round of
    // 401s.
    const viaGateway = mocks.probeStargateEndpoint.mock.calls.map((c) => c[0]);
    expect(viaGateway.some((path) => path.includes("/automation/public/jira/"))).toBe(true);
    expect(viaGateway.every((path) => path.includes("11111111-2222"))).toBe(true);
    expect(viaGateway.some((path) => path.startsWith("https://api.atlassian.com/"))).toBe(true);
  });

  // A 200 is not the same as usable JSON: Jira can answer with an HTML login page or an
  // error envelope, and treating that as success would report extraction as possible when
  // it is not.
  test("counts an endpoint as reachable only when the body looks like rules", async () => {
    mocks.probeEndpoint
      .mockResolvedValueOnce({ path: "a", status: 200, ok: true, ms: 5, sample: "<html>login</html>" })
      .mockResolvedValue({ path: "b", status: 200, ok: true, ms: 5, sample: '{"rules":[{"id":1}]}' });

    const result = await probeAutomationApi({ context: {} });

    expect(result.reachable).not.toContain("a");
    expect(result.reachable.length).toBeGreaterThan(0);
  });

  test("reports nothing reachable when every endpoint rejects", async () => {
    mocks.probeEndpoint.mockResolvedValue({ path: "x", status: 401, ok: false, ms: 5, sample: "scope does not match" });

    const result = await probeAutomationApi({ context: {} });

    expect(result.reachable).toEqual([]);
    expect(result.results.every((r) => r.looksLikeRules === false)).toBe(true);
  });

  // A diagnostic that can fail the page it runs on is worse than no diagnostic.
  test("still probes the global scope when the project lookup fails", async () => {
    mocks.getAllJiraProjects.mockRejectedValue(new Error("403"));
    mocks.probeEndpoint.mockResolvedValue({ path: "x", status: 404, ok: false, ms: 5, sample: "" });

    const result = await probeAutomationApi({ context: {} });

    expect(result.projectId).toBeNull();
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every((r) => r.scope === "global")).toBe(true);
  });
});

// The documented automation API is on api.atlassian.com and keyed by cloud id. Probing the
// site for it is what produced the first round of 401s.
describe("probeAutomationApi — gateway transport", () => {
  const probeAutomationApi = __RAW_ADMIN_ONLY_FUNCTIONS.probeAutomationApi;

  test("skips the gateway probes when no cloud id can be derived", async () => {
    mocks.getAllJiraProjects.mockResolvedValue([]);
    mocks.getCloudId.mockReturnValue(null);
    mocks.probeEndpoint.mockResolvedValue({ path: "x", status: 401, ok: false, ms: 5, sample: "" });

    const result = await probeAutomationApi({ context: {} });

    expect(mocks.probeStargateEndpoint).not.toHaveBeenCalled();
    expect(result.cloudId).toBeNull();
    // The site-relative probes still run, so the panel is never empty.
    expect(result.results.length).toBeGreaterThan(0);
  });

  test("labels each row with the transport that produced it", async () => {
    mocks.getAllJiraProjects.mockResolvedValue([{ id: "10000" }]);
    mocks.getCloudId.mockReturnValue("11111111-2222-3333-4444-555555555555");
    mocks.probeEndpoint.mockResolvedValue({ path: "x", status: 401, ok: false, ms: 5, sample: "" });
    mocks.probeStargateEndpoint.mockResolvedValue({ path: "s", status: 200, ok: true, ms: 5, sample: '{"values":[]}' });

    const result = await probeAutomationApi({ context: {} });

    // Without this the table cannot explain why two identical-looking paths behave
    // differently, which is exactly the confusion that cost a round of probing.
    expect(result.results.some((r) => r.via === "stargate")).toBe(true);
    expect(result.results.some((r) => r.via === "site")).toBe(true);
  });
});

// The cascade cap is the defect these exist to prevent recurring. 150 of this site's 1,457
// edges were stored, the tab said so in a footnote, and the remaining 1,307 were unreachable
// by any means at all.
describe("getAutomationCascades", () => {
  beforeEach(() => {
    mocks.loadCascadeSummary.mockResolvedValue({ edges: 1457, pairs: 1143, selfTriggeringRules: 123, fields: 214 });
    mocks.loadCascades.mockResolvedValue({ cascades: [{ sourceId: "1", targetId: "2", fields: ["A"] }], total: 1143 });
  });

  test("returns a page against the whole edge set, not a stored slice", async () => {
    const result = await getAutomationCascades({ payload: { page: 2, pageSize: 50 }, context: ctxWithAccount() });

    expect(result).toMatchObject({ available: true, total: 1143, page: 2 });
    expect(result.summary.edges).toBe(1457);
    expect(mocks.loadCascades).toHaveBeenCalledWith("test-install", expect.objectContaining({ limit: 50, offset: 50 }));
  });

  test("bounds the page size rather than trusting the payload", async () => {
    await getAutomationCascades({ payload: { page: 1, pageSize: 5000 }, context: ctxWithAccount() });
    expect(mocks.loadCascades).toHaveBeenCalledWith("test-install", expect.objectContaining({ limit: 200 }));
  });

  test("rejects an unknown filter value instead of passing it through", async () => {
    await getAutomationCascades({ payload: { kind: "'; DROP TABLE" }, context: ctxWithAccount() });
    expect(mocks.loadCascades).toHaveBeenCalledWith("test-install", expect.objectContaining({ kind: "all" }));
  });

  test("defaults an unrecognised direction to the source end", async () => {
    await getAutomationCascades({ payload: { ruleId: "7", direction: "sideways" }, context: ctxWithAccount() });
    expect(mocks.loadCascades).toHaveBeenCalledWith("test-install", expect.objectContaining({ direction: "source" }));
  });

  // Zero edges and no analysis are different states. A site whose rules genuinely cascade
  // nowhere should read as clean rather than as unbuilt.
  test("reports unavailable when nothing has been imported", async () => {
    mocks.loadCascadeSummary.mockResolvedValue({ edges: 0, pairs: 0, selfTriggeringRules: 0, fields: 0 });
    const result = await getAutomationCascades({ payload: {}, context: ctxWithAccount() });
    expect(result.available).toBe(false);
  });
});

describe("getAutomationBlast", () => {
  beforeEach(() => {
    mocks.loadBlastRules.mockResolvedValue({
      rules: [
        {
          ruleId: "1",
          name: "Sweep",
          score: 88,
          tier: "estate",
          estimated: true,
          credential: false,
          factors: [],
          modifiers: [],
        },
      ],
      total: 1,
    });
  });

  test("returns a page ordered by blast score", async () => {
    const result = await getAutomationBlast({ payload: { page: 2, pageSize: 50 }, context: ctxWithAccount() });
    expect(result).toMatchObject({ available: true, total: 1, page: 2 });
    expect(mocks.loadBlastRules).toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({ limit: 50, offset: 50 }),
    );
  });

  test("bounds the page size rather than trusting the payload", async () => {
    await getAutomationBlast({ payload: { page: 1, pageSize: 9000 }, context: ctxWithAccount() });
    expect(mocks.loadBlastRules).toHaveBeenCalledWith("test-install", expect.objectContaining({ limit: 200 }));
  });

  test("passes a tier filter through", async () => {
    await getAutomationBlast({ payload: { tier: "estate" }, context: ctxWithAccount() });
    expect(mocks.loadBlastRules).toHaveBeenCalledWith("test-install", expect.objectContaining({ tier: "estate" }));
  });

  test("is admin-only", () => {
    expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toContain("getAutomationBlast");
    expect(Object.keys(SHARED_RESOLVER_FUNCTIONS)).not.toContain("getAutomationBlast");
  });

  test("propagates a store failure rather than swallowing it", async () => {
    mocks.loadBlastRules.mockRejectedValueOnce(new Error("sql down"));
    await expect(getAutomationBlast({ payload: {}, context: ctxWithAccount() })).rejects.toThrow("sql down");
  });

  test("reports available on a later page even when this page is empty", async () => {
    mocks.loadBlastRules.mockResolvedValueOnce({ rules: [], total: 0 });
    const result = await getAutomationBlast({ payload: { page: 3 }, context: ctxWithAccount() });
    expect(result.available).toBe(true);
  });
});

describe("getCascadeGraph", () => {
  // A -> B -> C -> A, plus a tail that leaves the loop.
  const edges = [
    { sourceId: "1", targetId: "2", field: "Owner" },
    { sourceId: "2", targetId: "3", field: "Status" },
    { sourceId: "3", targetId: "1", field: "Owner" },
    { sourceId: "9", targetId: "8", field: "Milestone" },
    { sourceId: "8", targetId: "7", field: "Checkpoint" },
  ];

  beforeEach(() => {
    mocks.loadCascadeEdges.mockResolvedValue(edges);
    mocks.loadRuleDirectoryFor.mockResolvedValue(
      new Map([
        ["1", { id: "1", name: "Alpha", enabled: true }],
        ["2", { id: "2", name: "Beta", enabled: true }],
        ["3", { id: "3", name: "Gamma", enabled: false }],
        ["9", { id: "9", name: "Start", enabled: true }],
        ["8", { id: "8", name: "Middle", enabled: true }],
        ["7", { id: "7", name: "End", enabled: true }],
      ]),
    );
  });

  test("finds a loop no single hop reveals", async () => {
    const result = await getCascadeGraph({ payload: {}, context: ctxWithAccount() });

    expect(result.available).toBe(true);
    expect(result.loops).toHaveLength(1);
    expect(result.loops[0].ruleNames.sort()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(result.rulesInLoops).toBe(3);
  });

  test("finds the multi-rule chain that is not a loop", async () => {
    const result = await getCascadeGraph({ payload: {}, context: ctxWithAccount() });

    expect(result.chains).toHaveLength(1);
    expect(result.chains[0].steps.map((s) => s.name)).toEqual(["Start", "Middle", "End"]);
  });

  test("names the field carrying each hop, which is what an admin breaks", async () => {
    const result = await getCascadeGraph({ payload: {}, context: ctxWithAccount() });
    const hops = result.chains[0].steps.flatMap((s) => s.viaFields);
    expect(hops).toEqual(["Milestone", "Checkpoint"]);
  });

  test("attaches the enabled state, so a dead hop is visible", async () => {
    const result = await getCascadeGraph({ payload: {}, context: ctxWithAccount() });
    expect(result.loops[0].path.some((step) => step.enabled === false)).toBe(true);
  });

  // Names are looked up only for the rules that appear in an answer. Joining all 1,457 edges
  // to the directory would pay for names on every edge to render a few hundred.
  test("looks up only the rules that appear in a loop or a chain", async () => {
    await getCascadeGraph({ payload: {}, context: ctxWithAccount() });
    const asked = mocks.loadRuleDirectoryFor.mock.calls[0][1];
    expect(asked.sort()).toEqual(["1", "2", "3", "7", "8", "9"]);
  });

  test("bounds the requested depth", async () => {
    const result = await getCascadeGraph({ payload: { maxDepth: 9999 }, context: ctxWithAccount() });
    expect(result.maxDepth).toBeLessThanOrEqual(8);
  });

  test("reports unavailable rather than an empty graph when nothing is stored", async () => {
    mocks.loadCascadeEdges.mockResolvedValue([]);
    const result = await getCascadeGraph({ payload: {}, context: ctxWithAccount() });
    expect(result).toMatchObject({ available: false, reason: "no-cascades" });
  });
});

describe("getStatusAutomationUsage", () => {
  test("groups the rules by direction, because direction is the consequence", async () => {
    mocks.loadAutomationReferencesFor.mockResolvedValue({
      total: 3,
      ruleCount: 3,
      references: [
        { direction: "write", rule_id: "1", name: "Sends to Parking Lot", enabled: 1 },
        { direction: "trigger", rule_id: "2", name: "Fires on entry", enabled: 0 },
        { direction: "read", rule_id: "3", name: "Checks the status", enabled: 1 },
      ],
    });

    const result = await getStatusAutomationUsage({
      payload: { statusName: "Parking Lot" },
      context: ctxWithAccount(),
    });

    // A rule that transitions INTO a status keeps it alive; one that reads it in a condition
    // breaks if it goes but does not keep it in use.
    expect(result.write.rules[0].name).toBe("Sends to Parking Lot");
    expect(result.trigger.rules[0].enabled).toBe(false);
    expect(result.read.count).toBe(1);
    expect(result.referenced).toBe(true);
  });

  test("distinguishes no rules from no analysis", async () => {
    mocks.loadAutomationReferencesFor.mockResolvedValue({ total: 0, ruleCount: 0, references: [] });
    const found = await getStatusAutomationUsage({ payload: { statusName: "Ghost" }, context: ctxWithAccount() });
    expect(found).toMatchObject({ available: true, referenced: false });

    // "No rule touches this status" is permission to delete it. "We have not looked" is not.
    mocks.loadAutomationReferencesFor.mockRejectedValueOnce(new Error("sql down"));
    const unknown = await getStatusAutomationUsage({ payload: { statusName: "Ghost" }, context: ctxWithAccount() });
    expect(unknown).toMatchObject({ available: false, reason: "no-analysis" });
  });

  test("requires a status name", async () => {
    await expect(getStatusAutomationUsage({ payload: {}, context: ctxWithAccount() })).rejects.toThrow(
      /statusName is required/,
    );
  });
});
