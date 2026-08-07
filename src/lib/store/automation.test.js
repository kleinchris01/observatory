import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@forge/kvs", () => ({ kvs: mocks }));
vi.mock("@forge/sql", () => ({ sql: { prepare: vi.fn() } }));
vi.mock("./core.js", () => ({
  ensureProjectStoreReady: vi.fn().mockResolvedValue(undefined),
  withSqlRetry: (op) => op(),
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
      "automation:statuses:scope-a",
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
    expect(Object.keys(AUTOMATION_PARTS).sort()).toEqual(["analysis", "directory", "fields", "findings", "statuses"]);
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
