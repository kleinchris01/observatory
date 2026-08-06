import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@forge/kvs", () => ({ kvs: mocks }));
vi.mock("../logger.js", () => ({
  fallbackOn: (_event, fallback) => () => fallback(),
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const {
  MAX_STORED_CASCADES,
  MAX_STORED_FINDINGS,
  buildAnalysisDocument,
  clearAutomationAnalysis,
  readAutomationAnalysis,
  writeAutomationAnalysis,
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
    expect(doc.findings.map((f) => f.id)).toEqual([1]);
    expect(doc.findingsTotal).toBe(1);
  });

  it("orders findings most severe first", () => {
    const doc = buildAnalysisDocument({
      estate,
      summaries: [summary(1, "info"), summary(2, "high"), summary(3, "medium")],
    });
    expect(doc.findings.map((f) => f.id)).toEqual([2, 3, 1]);
  });

  it("reports the true total alongside the truncated list", () => {
    const many = Array.from({ length: MAX_STORED_FINDINGS + 40 }, (_, i) => summary(i, "high"));
    const doc = buildAnalysisDocument({ estate, summaries: many });
    expect(doc.findings).toHaveLength(MAX_STORED_FINDINGS);
    expect(doc.findingsTotal).toBe(MAX_STORED_FINDINGS + 40);
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

  it("caps the per-rule project and field lists but records the real project count", () => {
    const wide = { ...summary(1, "high"), projectIds: Array.from({ length: 25 }, (_, i) => String(i)) };
    const doc = buildAnalysisDocument({ estate, summaries: [wide] });
    expect(doc.findings[0].projectIds).toHaveLength(10);
    expect(doc.findings[0].projectCount).toBe(25);
  });

  it("stamps the schema version and source so a stale document can be detected", () => {
    const doc = buildAnalysisDocument({ estate, refreshedAt: 1234, source: "export-file" });
    expect(doc).toMatchObject({ schemaVersion: 1, refreshedAt: 1234, source: "export-file" });
  });

  it("handles an estate with no rules at all", () => {
    const doc = buildAnalysisDocument({ estate: { ruleCount: 0 } });
    expect(doc).toMatchObject({ findings: [], cascades: [], findingsTotal: 0, cascadesTotal: 0 });
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
  it("deletes the scope's document", async () => {
    mocks.delete.mockResolvedValue(undefined);
    await clearAutomationAnalysis("scope-a");
    expect(mocks.delete).toHaveBeenCalledWith("automation:analysis:scope-a");
  });

  it("swallows a delete failure rather than failing the caller", async () => {
    mocks.delete.mockRejectedValue(new Error("kvs down"));
    await expect(clearAutomationAnalysis("s")).resolves.toBeUndefined();
  });
});
