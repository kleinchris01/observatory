import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@forge/kvs", () => ({ kvs: mocks }));
vi.mock("@forge/sql", () => ({ sql: { prepare: vi.fn() } }));

const { sql } = await import("@forge/sql");
vi.mock("./core.js", () => ({
  ensureProjectStoreReady: vi.fn().mockResolvedValue(undefined),
  withSqlRetry: (op) => op(),
  // The real coercion, not a stub: the cascade readers turn TINYINT columns into booleans
  // through it, and a stub returning undefined would make every enabled flag read as false.
  toNumber: (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  },
}));
vi.mock("../logger.js", () => ({
  fallbackOn: (_event, fallback) => () => fallback(),
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const {
  AUTOMATION_PARTS,
  MAX_STORED_CASCADES,
  MAX_PREVIEW_FINDINGS,
  buildAnalysisDocument,
  clearAutomationAnalysis,
  readAutomationAnalysis,
  readAutomationPart,
  writeAutomationAnalysis,
  writeAutomationPart,
} = await import("./automation.js");

const estate = { ruleCount: 3, enabledCount: 2, disabledCount: 1 };

function summary(id, topSeverity, risks = [{ code: "x", severity: topSeverity }]) {
  return {
    id, name: `rule ${id}`, state: "ENABLED", enabled: true, triggerType: "t",
    updated: 1, actionCount: 1, projectIds: ["10015"], writesFields: ["A"],
    topSeverity, risks,
  };
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.set.mockReset();
  mocks.delete.mockReset();
});

describe("buildAnalysisDocument", () => {
  it("keeps only rules that carry findings", () => {
    const doc = buildAnalysisDocument({
      estate,
      summaries: [summary(1, "high"), { ...summary(2, null), risks: [] }],
    });
    expect(doc.findingsPreview.map((f) => f.id)).toEqual([1]);
    expect(doc.findingsTotal).toBe(1);
  });

  it("orders findings most severe first", () => {
    const doc = buildAnalysisDocument({
      estate,
      summaries: [summary(1, "info"), summary(2, "high"), summary(3, "medium")],
    });
    expect(doc.findingsPreview.map((f) => f.id)).toEqual([2, 3, 1]);
  });

  it("reports the true total alongside the truncated list", () => {
    const many = Array.from({ length: MAX_PREVIEW_FINDINGS + 40 }, (_, i) => summary(i, "high"));
    const doc = buildAnalysisDocument({ estate, summaries: many });
    expect(doc.findingsPreview).toHaveLength(MAX_PREVIEW_FINDINGS);
    expect(doc.findingsTotal).toBe(MAX_PREVIEW_FINDINGS + 40);
  });

  it("keeps self-triggering loops ahead of cross-rule edges when truncating", () => {
    const cascades = [
      ...Array.from({ length: MAX_STORED_CASCADES }, (_, i) => ({ sourceId: i, targetId: i + 1, selfTriggering: false })),
      { sourceId: 999, targetId: 999, selfTriggering: true },
    ];
    const doc = buildAnalysisDocument({ estate, cascades });
    expect(doc.cascades[0]).toMatchObject({ selfTriggering: true });
    expect(doc.cascades).toHaveLength(MAX_STORED_CASCADES);
    expect(doc.cascadesTotal).toBe(MAX_STORED_CASCADES + 1);
    expect(doc.selfTriggeringTotal).toBe(1);
  });

  // The preview is stored compact: a project count rather than the id list, since the row
  // only ever renders "25 projects".
  it("records the project count rather than carrying the id list", () => {
    const wide = { ...summary(1, "high"), projectIds: Array.from({ length: 25 }, (_, i) => String(i)) };
    const doc = buildAnalysisDocument({ estate, summaries: [wide] });
    expect(doc.findingsPreview[0].p).toBe(25);
    expect(doc.findingsPreview[0].projectIds).toBeUndefined();
  });

  it("stamps the schema version and source so a stale document can be detected", () => {
    const doc = buildAnalysisDocument({ estate, refreshedAt: 1234, source: "export-file" });
    expect(doc).toMatchObject({ schemaVersion: 1, refreshedAt: 1234, source: "export-file" });
  });

  it("handles an estate with no rules at all", () => {
    const doc = buildAnalysisDocument({ estate: { ruleCount: 0 } });
    expect(doc).toMatchObject({ findingsPreview: [], cascades: [], findingsTotal: 0, cascadesTotal: 0 });
  });
});

describe("writeAutomationAnalysis", () => {
  it("writes under a scope-namespaced key", async () => {
    await writeAutomationAnalysis("scope-a", { schemaVersion: 1 });
    expect(mocks.set).toHaveBeenCalledWith("automation:analysis:scope-a", { schemaVersion: 1 });
  });
});

describe("readAutomationAnalysis", () => {
  it("returns the stored document", async () => {
    mocks.get.mockResolvedValue({ schemaVersion: 1, estate });
    await expect(readAutomationAnalysis("s")).resolves.toMatchObject({ estate });
  });

  it("returns null when nothing has been built yet, which is the fresh-install state", async () => {
    mocks.get.mockResolvedValue(undefined);
    await expect(readAutomationAnalysis("s")).resolves.toBeNull();
  });

  it("returns null rather than throwing when the read fails", async () => {
    mocks.get.mockRejectedValue(new Error("kvs down"));
    await expect(readAutomationAnalysis("s")).resolves.toBeNull();
  });

  it("rejects a document written by a different schema version", async () => {
    mocks.get.mockResolvedValue({ schemaVersion: 99, estate });
    await expect(readAutomationAnalysis("s")).resolves.toBeNull();
  });

  it("rejects a non-object value", async () => {
    mocks.get.mockResolvedValue("corrupted");
    await expect(readAutomationAnalysis("s")).resolves.toBeNull();
  });
});

describe("clearAutomationAnalysis", () => {
  // Every part goes. A stale field index left behind would let the Fields section render
  // data from a build the estate no longer matches.
  it("deletes every part, not just the analysis", async () => {
    mocks.delete.mockResolvedValue(undefined);
    await clearAutomationAnalysis("scope-a");

    const deleted = mocks.delete.mock.calls.map((c) => c[0]).sort();
    expect(deleted).toEqual([
      "automation:analysis:scope-a",
      "automation:directory:scope-a",
      "automation:fields:scope-a",
      "automation:findings:scope-a",
      "automation:issueTypes:scope-a",
      "automation:statuses:scope-a",
      "automation:users:scope-a",
    ]);
  });

  it("swallows a delete failure rather than failing the caller", async () => {
    mocks.delete.mockRejectedValue(new Error("kvs down"));
    await expect(clearAutomationAnalysis("s")).resolves.toBeUndefined();
  });
});

describe("automation storage parts", () => {
  it("namespaces each part under its own key", async () => {
    await writeAutomationPart("s1", "fields", { schemaVersion: 1, entries: [] });
    expect(mocks.set).toHaveBeenCalledWith("automation:fields:s1", { schemaVersion: 1, entries: [] });
  });

  it("exposes every part the pipeline writes", () => {
    expect(Object.keys(AUTOMATION_PARTS).sort()).toEqual(["analysis", "directory", "fields", "findings", "issueTypes", "statuses", "users"]);
  });

  it("refuses an unknown part rather than writing to a computed key", async () => {
    await expect(writeAutomationPart("s1", "../escape", {})).rejects.toThrow(/unknown automation storage part/);
  });

  it("reads a part back", async () => {
    mocks.get.mockResolvedValue({ schemaVersion: 1, total: 735 });
    await expect(readAutomationPart("s1", "fields")).resolves.toMatchObject({ total: 735 });
    expect(mocks.get).toHaveBeenCalledWith("automation:fields:s1");
  });

  it("returns null for a part that has never been built", async () => {
    mocks.get.mockResolvedValue(undefined);
    await expect(readAutomationPart("s1", "statuses")).resolves.toBeNull();
  });

  it("returns null rather than throwing when the read fails", async () => {
    mocks.get.mockRejectedValue(new Error("kvs down"));
    await expect(readAutomationPart("s1", "fields")).resolves.toBeNull();
  });

  it("rejects a part written by a different schema version", async () => {
    mocks.get.mockResolvedValue({ schemaVersion: 2, entries: [] });
    await expect(readAutomationPart("s1", "fields")).resolves.toBeNull();
  });
});



// referenceRowsFrom is where the KVS caps stop applying. The document it reads carried at
// most 50 rule ids per direction and 1,000 labels; rows have no such ceiling, so these
// assert the flattening rather than the storage call.
describe("referenceRowsFrom", () => {
  const doc = {
    entries: [
      { label: "Story Points", write: ["1", "2"], read: ["3"], trigger: [] },
      { label: "Priority", write: [], read: [], trigger: ["4"] },
    ],
  };

  it("emits one row per label, rule and direction", async () => {
    const { referenceRowsFrom } = await import("./automation.js");
    expect(referenceRowsFrom(doc, "field")).toEqual([
      ["field", "Story Points", "1", "write"],
      ["field", "Story Points", "2", "write"],
      ["field", "Story Points", "3", "read"],
      ["field", "Priority", "4", "trigger"],
    ]);
  });

  // Direction is the consequence: a rule that WRITES keeps a field alive, one that only
  // READS it breaks when the field goes. Collapsing them would lose the whole distinction.
  it("keeps a rule that both reads and writes as two rows", async () => {
    const { referenceRowsFrom } = await import("./automation.js");
    const rows = referenceRowsFrom({ entries: [{ label: "F", write: ["9"], read: ["9"] }] }, "field");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r[3]).sort()).toEqual(["read", "write"]);
  });

  it("carries the kind so fields and statuses share one table", async () => {
    const { referenceRowsFrom } = await import("./automation.js");
    expect(referenceRowsFrom(doc, "status")[0][0]).toBe("status");
  });

  it("skips entries with no usable label rather than writing a blank key", async () => {
    const { referenceRowsFrom } = await import("./automation.js");
    const rows = referenceRowsFrom({ entries: [{ label: "  ", write: ["1"] }, { write: ["2"] }] }, "field");
    expect(rows).toEqual([]);
  });

  it("handles an absent or empty document", async () => {
    const { referenceRowsFrom } = await import("./automation.js");
    expect(referenceRowsFrom(null, "field")).toEqual([]);
    expect(referenceRowsFrom({ entries: [] }, "field")).toEqual([]);
  });

  // The cap this replaces: a field referenced by 542 rules used to store 50 ids and a
  // separate count. Now it is 542 rows and the count is derivable.
  it("emits every reference, past the old 50-per-direction cap", async () => {
    const { referenceRowsFrom } = await import("./automation.js");
    const many = Array.from({ length: 542 }, (_, i) => String(i));
    const rows = referenceRowsFrom({ entries: [{ label: "Hot", write: many }] }, "field");
    expect(rows).toHaveLength(542);
  });
});

// ── Cascades ────────────────────────────────────────────────────────────────
//
// These edges used to live in the analysis document under MAX_STORED_CASCADES = 150, which
// existed because the document has to fit in a KVS value. This site produces 1,457, so the
// tab showed roughly a tenth of them and the rest were unreachable by any amount of
// scrolling. In rows there is no cap to apply.

describe("cascadeRowsFrom", () => {
  it("flattens the wire tuples into rows", async () => {
    const { cascadeRowsFrom } = await import("./automation.js");
    expect(cascadeRowsFrom({ edges: [["1", "2", "Owner", 0], ["9", "9", "Status", 1]] })).toEqual([
      ["1", "2", "Owner", 0],
      ["9", "9", "Status", 1],
    ]);
  });

  it("keeps one row per field, because the field is the hop", async () => {
    // Two rules linked by three fields are one relationship and three ways to break it.
    const { cascadeRowsFrom } = await import("./automation.js");
    const rows = cascadeRowsFrom({ edges: [["1", "2", "A", 0], ["1", "2", "B", 0], ["1", "2", "C", 0]] });
    expect(rows).toHaveLength(3);
  });

  it("drops a duplicate tuple rather than letting it distort the batches", async () => {
    const { cascadeRowsFrom } = await import("./automation.js");
    expect(cascadeRowsFrom({ edges: [["1", "2", "A", 0], ["1", "2", "A", 0]] })).toHaveLength(1);
  });

  it("skips an edge with no usable field or endpoint", async () => {
    const { cascadeRowsFrom } = await import("./automation.js");
    expect(cascadeRowsFrom({ edges: [["1", "2", "", 0], [null, "2", "A", 0], ["1", null, "A", 0]] })).toEqual([]);
  });

  it("normalises the self-triggering flag to the column's type", async () => {
    const { cascadeRowsFrom } = await import("./automation.js");
    expect(cascadeRowsFrom({ edges: [["9", "9", "S", true]] })[0][3]).toBe(1);
    expect(cascadeRowsFrom({ edges: [["1", "2", "S", undefined]] })[0][3]).toBe(0);
  });

  it("truncates a field name to what the column holds", async () => {
    const { cascadeRowsFrom } = await import("./automation.js");
    const long = "x".repeat(400);
    expect(cascadeRowsFrom({ edges: [["1", "2", long, 0]] })[0][2]).toHaveLength(191);
  });

  it("handles a missing document rather than throwing", async () => {
    const { cascadeRowsFrom } = await import("./automation.js");
    expect(cascadeRowsFrom(null)).toEqual([]);
    expect(cascadeRowsFrom({})).toEqual([]);
  });
});

describe("blastRowsFrom", () => {
  it("flattens the per-rule document into rows, JSON-encoding the factor breakdown", async () => {
    const { blastRowsFrom } = await import("./automation.js");
    const rows = blastRowsFrom({
      rules: [
        { id: "1", score: 88, tier: "estate", estimated: 1, credential: 0, factors: [{ key: "reach", value: 1 }], modifiers: [] },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].slice(0, 5)).toEqual(["1", 88, "estate", 1, 0]);
    expect(JSON.parse(rows[0][5]).factors[0].key).toBe("reach");
  });

  it("clamps the score to 0..100 and defaults an unknown tier", async () => {
    const { blastRowsFrom } = await import("./automation.js");
    const rows = blastRowsFrom({ rules: [{ id: "1", score: 500 }, { id: "2", score: -3, tier: null }] });
    expect(rows[0][1]).toBe(100);
    expect(rows[1][1]).toBe(0);
    expect(rows[1][2]).toBe("contained");
  });

  it("drops a rule with no id and de-duplicates by id", async () => {
    const { blastRowsFrom } = await import("./automation.js");
    const rows = blastRowsFrom({ rules: [{ score: 5 }, { id: "1", score: 5 }, { id: "1", score: 9 }] });
    expect(rows.map((r) => r[0])).toEqual(["1"]);
  });

  it("handles a missing document rather than throwing", async () => {
    const { blastRowsFrom } = await import("./automation.js");
    expect(blastRowsFrom(null)).toEqual([]);
    expect(blastRowsFrom({})).toEqual([]);
  });
});

describe("loadBlastSummary", () => {
  it("rolls the tier rows into a histogram and the two health inputs", async () => {
    const { sql } = await import("@forge/sql");
    sql.prepare.mockImplementation(() => ({
      bindParams: () => ({
        execute: async () => ({
          rows: [
            { tier: "estate", n: 12, estimated_n: 4, estate_cred_n: 3 },
            { tier: "contained", n: 900, estimated_n: 900, estate_cred_n: 0 },
          ],
        }),
      }),
    }));
    const { loadBlastSummary } = await import("./automation.js");
    const s = await loadBlastSummary("scope");
    expect(s.total).toBe(912);
    expect(s.byTier.estate).toBe(12);
    expect(s.estateWideCount).toBe(12);
    expect(s.estateWideCredentialCount).toBe(3);
    expect(s.available).toBe(true);
  });
});

describe("loadBlastRules", () => {
  it("returns a page ordered by score with the rule name joined and factors parsed", async () => {
    const { sql } = await import("@forge/sql");
    let n = 0;
    sql.prepare.mockImplementation((text) => {
      expect(text).not.toMatch(/LIMIT \?/);
      return {
        bindParams: () => ({
          execute: async () =>
            n++ === 0
              ? { rows: [{ rule_id: "1", score: 88, tier: "estate", estimated: 1, credential: 0, factors_json: JSON.stringify({ factors: [{ key: "reach" }], modifiers: [] }), rule_name: "Sweep", rule_enabled: 1, trigger_type: "jira.jql.scheduled" }] }
              : { rows: [{ total: 1 }] },
        }),
      };
    });
    const { loadBlastRules } = await import("./automation.js");
    const out = await loadBlastRules("scope", { tier: "estate", limit: 50, offset: 0 });
    expect(out.total).toBe(1);
    expect(out.rules[0]).toMatchObject({ ruleId: "1", name: "Sweep", score: 88, tier: "estate", enabled: true });
    expect(out.rules[0].factors[0].key).toBe("reach");
  });

  it("survives an unparseable factors blob", async () => {
    const { sql } = await import("@forge/sql");
    let n = 0;
    sql.prepare.mockImplementation(() => ({
      bindParams: () => ({
        execute: async () =>
          n++ === 0
            ? { rows: [{ rule_id: "1", score: 10, tier: "contained", estimated: 0, credential: 0, factors_json: "{not json", rule_name: null, rule_enabled: null, trigger_type: null }] }
            : { rows: [{ total: 1 }] },
      }),
    }));
    const { loadBlastRules } = await import("./automation.js");
    const out = await loadBlastRules("scope", {});
    expect(out.rules[0].factors).toEqual([]);
    expect(out.rules[0].enabled).toBeNull();
  });
});

describe("loadCascades", () => {
  // Each call runs two statements -- the page and the group count -- so the harness answers
  // in order and records what was asked.
  function stubSql(pageRows = [], total = 0) {
    const calls = [];
    let n = 0;
    sql.prepare.mockImplementation((text) => ({
      bindParams: (...params) => {
        calls.push({ text, params });
        return { execute: async () => (n++ === 0 ? { rows: pageRows } : { rows: [{ total }] }) };
      },
    }));
    return calls;
  }

  it("groups in SQL rather than in the browser", async () => {
    const { loadCascades } = await import("./automation.js");
    const calls = stubSql([], 0);
    await loadCascades("scope");

    // The old view grouped a 150-row page client-side, which is only correct while the page
    // IS the whole set. Grouping a page of a larger set splits one relationship across a
    // page boundary and renders it twice.
    expect(calls[0].text).toMatch(/GROUP BY\s+c\.source_rule_id, c\.target_rule_id/);
    // ...and the total counts GROUPS, so a reader is never paged toward an unreachable number.
    expect(calls[1].text).toMatch(/COUNT\(\*\) AS total FROM \(/);
  });

  it("splits the concatenated fields back into a list", async () => {
    const { loadCascades } = await import("./automation.js");
    stubSql([{
      source_rule_id: "1", target_rule_id: "2", self_triggering: 0,
      source_name: "Writer", target_name: "Listener", source_enabled: 1, target_enabled: 0,
      field_count: 3, fields: ["A", "B", "C"].join(""),
    }], 1);

    const { cascades } = await loadCascades("scope");
    expect(cascades[0]).toMatchObject({
      sourceName: "Writer", targetName: "Listener",
      fields: ["A", "B", "C"], fieldCount: 3,
      selfTriggering: false, sourceEnabled: true, targetEnabled: false,
    });
  });

  it("filters to self-triggering or cross-rule cascades", async () => {
    const { loadCascades } = await import("./automation.js");
    let calls = stubSql([], 0);
    await loadCascades("scope", { kind: "self" });
    expect(calls[0].text).toContain("c.self_triggering = 1");

    calls = stubSql([], 0);
    await loadCascades("scope", { kind: "cross" });
    expect(calls[0].text).toContain("c.self_triggering = 0");
  });

  it("binds a rule to whichever end the direction names", async () => {
    const { loadCascades } = await import("./automation.js");
    // "What does this rule wake" and "what wakes this rule" are different questions, and
    // the second is the one an admin asks when a rule fires and they cannot see why.
    let calls = stubSql([], 0);
    await loadCascades("scope", { ruleId: "7", direction: "source" });
    expect(calls[0].text).toContain("c.source_rule_id = ?");

    calls = stubSql([], 0);
    await loadCascades("scope", { ruleId: "7", direction: "target" });
    expect(calls[0].text).toContain("c.target_rule_id = ?");
  });

  it("searches the field and both rule names", async () => {
    const { loadCascades } = await import("./automation.js");
    const calls = stubSql([], 0);
    await loadCascades("scope", { search: "  Owner  " });

    expect(calls[0].params).toEqual(expect.arrayContaining(["%Owner%"]));
    expect(calls[0].text).toContain("LOWER(c.field) LIKE");
    expect(calls[0].text).toContain("LOWER(COALESCE(s.name, '')) LIKE");
    expect(calls[0].text).toContain("LOWER(COALESCE(t.name, '')) LIKE");
  });

  it("never binds LIMIT or OFFSET, and bounds both", async () => {
    const { loadCascades } = await import("./automation.js");
    const calls = stubSql([], 0);
    // Forge SQL rejects a placeholder in LIMIT, so coercing to a bounded integer here is the
    // only thing between a caller and an injection.
    await loadCascades("scope", { limit: 99999, offset: -5 });

    expect(calls[0].text).toContain("LIMIT 500 OFFSET 0");
    expect(calls[0].params).not.toContain(500);
  });
});

describe("loadCascadeEdges", () => {
  it("returns every edge unpaged, because a loop is a property of the whole graph", async () => {
    const { loadCascadeEdges } = await import("./automation.js");
    let asked = "";
    sql.prepare.mockImplementation((text) => {
      asked = text;
      return { bindParams: () => ({ execute: async () => ({ rows: [{ source_rule_id: "1", target_rule_id: "2", field: "A" }] }) }) };
    });

    const edges = await loadCascadeEdges("scope");
    // Walking a page finds chains that stop at the page boundary, which is not a smaller
    // answer -- it is a wrong one.
    expect(asked).not.toContain("OFFSET");
    expect(edges).toEqual([{ sourceId: "1", targetId: "2", field: "A" }]);
  });

  it("selects only what the walk needs", async () => {
    const { loadCascadeEdges } = await import("./automation.js");
    let asked = "";
    sql.prepare.mockImplementation((text) => {
      asked = text;
      return { bindParams: () => ({ execute: async () => ({ rows: [] }) }) };
    });

    await loadCascadeEdges("scope");
    // Names are attached afterwards from the directory: joining 1,457 rows to compute
    // something that uses only ids would pay for names on every edge to render a few hundred.
    expect(asked).not.toMatch(/JOIN automation_rules/);
  });
});

describe("loadRuleDirectoryFor", () => {
  it("returns nothing without asking when given no ids", async () => {
    const { loadRuleDirectoryFor } = await import("./automation.js");
    sql.prepare.mockClear();
    expect(await loadRuleDirectoryFor("scope", [])).toEqual(new Map());
    expect(sql.prepare).not.toHaveBeenCalled();
  });

  it("chunks against the bind-parameter ceiling", async () => {
    const { loadRuleDirectoryFor } = await import("./automation.js");
    let statements = 0;
    sql.prepare.mockImplementation(() => {
      statements += 1;
      return { bindParams: () => ({ execute: async () => ({ rows: [] }) }) };
    });

    await loadRuleDirectoryFor("scope", Array.from({ length: 250 }, (_, i) => String(i)));
    expect(statements).toBe(3);
  });

  it("keys by rule id and carries the enabled state", async () => {
    const { loadRuleDirectoryFor } = await import("./automation.js");
    sql.prepare.mockImplementation(() => ({
      bindParams: () => ({ execute: async () => ({ rows: [{ rule_id: "5", name: "Alpha", enabled: 0, trigger_type: "t" }] }) }),
    }));

    const directory = await loadRuleDirectoryFor("scope", ["5"]);
    expect(directory.get("5")).toMatchObject({ name: "Alpha", enabled: false });
  });
});
