import { describe, test, expect } from "vitest";
import { assessFieldDeletion, assessStatusDeletion, computeVerdict, summarizeDeletionSafety, VERDICT } from "./deletion-safety.js";

// The verdict the whole product is judged by. Its own stated success metric is "whether a
// recommended deletion was ever wrong", so almost everything pinned here is about what the
// verdict REFUSES to say: never "safe to delete", never a clean result from an unchecked
// source, and never a strong claim from a pillar that was never built.

const field = { id: "customfield_1", name: "Vendor Ref" };

// Every source consulted and every source clean. The only shape that can produce a
// no-evidence verdict.
const allClean = {
  field,
  usage: { totalIssueCount: 0, activeProjectCount: 0 },
  screens: { available: true, screens: [], unresolvedScreens: 0 },
  automation: { available: true, writeCount: 0, readCount: 0, triggerCount: 0, evidence: { blockers: [] } },
  filters: { available: true, count: 0, names: [] },
  dashboards: { available: true, count: 0, names: [] },
  rqt: { available: true, issueCount: 0 },
};

describe("assessFieldDeletion — what it refuses to say", () => {
  test("never says safe to delete, even with every source clean", () => {
    const result = assessFieldDeletion(allClean);

    expect(result.verdict).toBe(VERDICT.NO_EVIDENCE);
    expect(result.headline).toMatch(/no evidence of use/i);
    expect(JSON.stringify(result)).not.toMatch(/safe to delete/i);
  });

  test("carries the Marketplace caveat on every verdict, including the clean ones", () => {
    // A site running ScriptRunner can have a post-function writing this field on every
    // transition with nothing here to show for it. The clean verdict is exactly where that
    // warning matters, because it is the one somebody acts on.
    expect(assessFieldDeletion(allClean).caveat).toMatch(/ScriptRunner|Marketplace/i);
  });

  test("downgrades a clean result to unknown when a source could not be checked", () => {
    const result = assessFieldDeletion({ ...allClean, automation: null });

    expect(result.verdict).toBe(VERDICT.UNKNOWN);
    expect(result.headline).toMatch(/could not be checked/i);
    expect(result.gaps.map((g) => g.source)).toContain("automation rules");
  });

  test("distinguishes a source that found nothing from one that was never built", () => {
    const consulted = assessFieldDeletion(allClean);
    const absent = assessFieldDeletion({ ...allClean, screens: null });

    expect(consulted.checked).toContain("screens");
    expect(consulted.gaps).toEqual([]);
    expect(absent.checked).not.toContain("screens");
    expect(absent.verdict).toBe(VERDICT.UNKNOWN);
  });
});

describe("assessFieldDeletion — blockers", () => {
  const withOne = (over) => assessFieldDeletion({ ...allClean, ...over });

  test("values in issues block deletion, and say what is lost", () => {
    const result = withOne({ usage: { totalIssueCount: 4820, activeProjectCount: 9 } });

    expect(result.verdict).toBe(VERDICT.IN_USE);
    expect(result.blockers[0]).toMatchObject({ source: "usage", severity: "high" });
    expect(result.blockers[0].detail).toMatch(/does not put it back/i);
  });

  test("a rule that WRITES the field is a harder blocker than one that reads it", () => {
    // The distinction the whole automation pillar exists for: a writer keeps the field
    // alive, a reader merely breaks.
    const writes = withOne({ automation: { available: true, writeCount: 2, readCount: 0, triggerCount: 0, evidence: { blockers: [] } } });
    const reads = withOne({ automation: { available: true, writeCount: 0, readCount: 2, triggerCount: 0, evidence: { blockers: [] } } });

    expect(writes.blockers[0].severity).toBe("high");
    expect(reads.blockers[0].severity).toBe("medium");
    expect(reads.blockers[0].detail).toMatch(/misbehave silently/i);
  });

  test("invisible data is called out as the integration it implies", () => {
    // The blocker most likely to be the reason a deletion breaks something, because by
    // construction nobody can find the writer by looking at Jira.
    const result = withOne({
      invisibleData: { totalIssues: 480, projects: [{ projectKey: "OPS" }, { projectKey: "FIN" }] },
    });

    expect(result.verdict).toBe(VERDICT.IN_USE);
    const b = result.blockers.find((x) => x.source === "invisible-data");
    expect(b.severity).toBe("high");
    expect(b.summary).toMatch(/OPS, FIN/);
    expect(b.detail).toMatch(/importer, integration or rule/i);
  });

  test("a filter reference names what breaks downstream of it", () => {
    const result = withOne({ filters: { available: true, count: 2, names: ["Open bugs", "My work"] } });
    const b = result.blockers.find((x) => x.source === "filters");
    expect(b.summary).toMatch(/Open bugs, My work/);
    // Not just the filter -- the boards and subscriptions sitting on it.
    expect(b.detail).toMatch(/board.*subscription/i);
  });

  test("requirement tokens block on traceability, not just on data", () => {
    const result = withOne({ rqt: { available: true, issueCount: 91 } });
    expect(result.blockers[0]).toMatchObject({ source: "rqt", severity: "high" });
    expect(result.blockers[0].detail).toMatch(/breaks the trace/i);
  });

  test("orders blockers by severity so the reason not to proceed leads", () => {
    const result = withOne({
      usage: { totalIssueCount: 100 },
      screens: { available: true, screens: [{ screenId: "1" }], unresolvedScreens: 0 },
      filters: { available: true, count: 1, names: ["X"] },
    });
    expect(result.blockers[0].severity).toBe("high");
  });
});

describe("assessFieldDeletion — evidence quality", () => {
  test("a truncated or stale automation index becomes a gap, not a clean pass", () => {
    // Item 1's assessment carried through. Without this, an automation answer drawn from a
    // capped index would read as "no rule touches it" -- which is the exact defect that
    // assessment exists to prevent, arriving here by a different door.
    const result = assessFieldDeletion({
      ...allClean,
      automation: {
        available: true, writeCount: 0, readCount: 0, triggerCount: 0,
        evidence: { blockers: [{ code: "index-truncated", message: "The reference index was truncated to 1000 of 1400 entries." }] },
      },
    });

    expect(result.verdict).toBe(VERDICT.UNKNOWN);
    expect(result.gaps.some((g) => /truncated/i.test(g.reason))).toBe(true);
  });

  test("unreadable screens narrow the claim without blocking it", () => {
    const result = assessFieldDeletion({
      ...allClean,
      screens: { available: true, screens: [], unresolvedScreens: 12 },
    });

    expect(result.verdict).toBe(VERDICT.UNKNOWN);
    expect(result.blockers).toEqual([]);
    expect(result.gaps.some((g) => /12 screen/.test(g.reason))).toBe(true);
  });

  test("a blocker outranks a gap: unknown never masks in-use", () => {
    const result = assessFieldDeletion({
      ...allClean,
      usage: { totalIssueCount: 900 },
      screens: null,
      filters: null,
    });
    expect(result.verdict).toBe(VERDICT.IN_USE);
  });
});

describe("summarizeDeletionSafety", () => {
  const at = (name, over) => assessFieldDeletion({ ...allClean, field: { id: name, name }, ...over });

  test("counts each verdict and leads with what can be acted on", () => {
    const result = summarizeDeletionSafety([
      at("Busy", { usage: { totalIssueCount: 500 } }),
      at("Clean"),
      at("Murky", { automation: null }),
    ]);

    expect(result.total).toBe(3);
    expect(result.byVerdict[VERDICT.IN_USE]).toBe(1);
    // No-evidence first: those are the decisions this report exists to enable. "Do not
    // touch this" needs no follow-up, so it sorts last.
    expect(result.fields.map((f) => f.fieldName)).toEqual(["Clean", "Murky", "Busy"]);
  });

  test("handles an empty set without inventing a verdict", () => {
    expect(summarizeDeletionSafety([])).toMatchObject({ total: 0 });
  });

  test("sorts a mixed set of fields and statuses by whichever name key each carries", () => {
    const result = summarizeDeletionSafety([
      at("Zeta Field"),
      assessStatusDeletion({ ...statusAllClean, status: { id: "9", name: "Alpha Status" } }),
    ]);
    expect(result.fields.map((r) => r.fieldName ?? r.statusName)).toEqual(["Alpha Status", "Zeta Field"]);
  });
});

// computeVerdict is the shared core every assess*Deletion function calls at the end. Pinned
// directly, not just through assessFieldDeletion, so a future third caller (a screen, an
// issue type) is provably using the same three-state logic rather than a lookalike.
describe("computeVerdict — the shared core", () => {
  test("any blocker at all is in-use, regardless of how many gaps also exist", () => {
    const { verdict } = computeVerdict([{ source: "x", severity: "low", summary: "s", detail: "d" }], [{ source: "y", reason: "r" }]);
    expect(verdict).toBe(VERDICT.IN_USE);
  });

  test("no blockers and no gaps is no-evidence", () => {
    expect(computeVerdict([], []).verdict).toBe(VERDICT.NO_EVIDENCE);
  });

  test("no blockers but at least one gap is unknown, never no-evidence", () => {
    expect(computeVerdict([], [{ source: "y", reason: "r" }]).verdict).toBe(VERDICT.UNKNOWN);
  });

  test("the headline never contains the words \"safe to delete\"", () => {
    for (const [blockers, gaps] of [[[], []], [[], [{ source: "y", reason: "r" }]], [[{ source: "x", severity: "low", summary: "s", detail: "d" }], []]]) {
      expect(computeVerdict(blockers, gaps).headline.toLowerCase()).not.toMatch(/safe to delete/);
    }
  });
});

// Every source consulted and every source clean, mirroring allClean above for the field case.
const statusAllClean = {
  status: { id: "9", name: "On Hold" },
  schemes: { reachedByCount: 0 },
  issueUsage: { count: 0 },
  automation: { available: true, writeCount: 0, readCount: 0, triggerCount: 0 },
  boards: { available: true, onBoard: false },
  filters: { available: true, count: 0, names: [] },
};

describe("assessStatusDeletion — what it refuses to say", () => {
  test("never says safe to delete, even with every source clean", () => {
    const result = assessStatusDeletion(statusAllClean);
    expect(result.verdict).toBe(VERDICT.NO_EVIDENCE);
    expect(result.headline.toLowerCase()).not.toMatch(/safe to delete/);
  });

  test("carries the Marketplace caveat on every verdict, including the clean ones", () => {
    expect(assessStatusDeletion(statusAllClean).caveat).toMatch(/Marketplace/);
  });

  test("downgrades a clean result to unknown when a source could not be checked", () => {
    const result = assessStatusDeletion({ ...statusAllClean, boards: null });
    expect(result.verdict).toBe(VERDICT.UNKNOWN);
    expect(result.gaps).toEqual([expect.objectContaining({ source: "board columns" })]);
  });
});

describe("assessStatusDeletion — blockers", () => {
  test("reachability from a scheme is the highest-severity blocker", () => {
    const result = assessStatusDeletion({ ...statusAllClean, schemes: { reachedByCount: 2 } });
    expect(result.verdict).toBe(VERDICT.IN_USE);
    expect(result.blockers[0]).toMatchObject({ source: "schemes", severity: "high" });
  });

  test("issues currently sitting in the status block deletion", () => {
    const result = assessStatusDeletion({ ...statusAllClean, issueUsage: { count: 40 } });
    expect(result.blockers).toEqual([expect.objectContaining({ source: "usage", summary: expect.stringContaining("40 issues sit") })]);
  });

  test("a rule that transitions INTO the status is a harder blocker than one that only reads it", () => {
    const writer = assessStatusDeletion({ ...statusAllClean, automation: { available: true, writeCount: 1, readCount: 0, triggerCount: 0 } });
    const reader = assessStatusDeletion({ ...statusAllClean, automation: { available: true, writeCount: 0, readCount: 1, triggerCount: 0 } });
    expect(writer.blockers[0].severity).toBe("high");
    expect(reader.blockers[0].severity).toBe("medium");
  });

  test("a board column mapping the status blocks deletion even at zero schemes, issues and rules", () => {
    const result = assessStatusDeletion({ ...statusAllClean, boards: { available: true, onBoard: true } });
    expect(result.verdict).toBe(VERDICT.IN_USE);
    expect(result.blockers).toEqual([expect.objectContaining({ source: "boards" })]);
  });

  test("a filter reference names what breaks downstream of it", () => {
    const result = assessStatusDeletion({ ...statusAllClean, filters: { available: true, count: 2, names: ["Open Bugs", "Sprint Board"] } });
    expect(result.blockers[0].summary).toContain("Open Bugs, Sprint Board");
  });

  test("orders blockers by severity so the reason not to proceed leads", () => {
    const result = assessStatusDeletion({
      ...statusAllClean,
      filters: { available: true, count: 1, names: ["X"] }, // medium
      schemes: { reachedByCount: 1 }, // high
    });
    expect(result.blockers[0].source).toBe("schemes");
  });
});

describe("assessStatusDeletion — evidence quality", () => {
  test("a blocker outranks a gap: unknown never masks in-use", () => {
    const result = assessStatusDeletion({ ...statusAllClean, schemes: { reachedByCount: 1 }, automation: null });
    expect(result.verdict).toBe(VERDICT.IN_USE);
    expect(result.gaps.length).toBeGreaterThan(0);
  });

  test("an unnamed status is a gap on the catalogue, not a silent skip", () => {
    const result = assessStatusDeletion({ ...statusAllClean, status: { id: "9" } });
    expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ source: "status catalogue" })]));
  });
});
