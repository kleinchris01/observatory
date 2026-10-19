import { describe, test, expect } from "vitest";

import {
  BLAST_TIERS,
  tierForScore,
  scoreRuleBlastRadius,
  summarizeBlastRadius,
  buildBlastDocument,
} from "./automation-blast.js";

// A minimal rule summary in the shape summarizeRule() produces. Only the fields the blast
// score reads are set; everything else defaults to "does nothing".
function summary(over = {}) {
  return {
    id: over.id ?? "r1",
    name: over.name ?? "Rule 1",
    enabled: over.enabled ?? true,
    triggerType: over.triggerType ?? "jira.issue.event.trigger:created",
    canOtherRuleTrigger: over.canOtherRuleTrigger ?? false,
    projectIds: over.projectIds ?? ["10001"],
    statusRefs: over.statusRefs ?? [],
    writesFields: over.writesFields ?? [],
    actionKinds: over.actionKinds ?? [],
    risks: over.risks ?? [],
  };
}

describe("tierForScore", () => {
  test("maps scores to the four tiers by their thresholds", () => {
    expect(tierForScore(0).key).toBe("contained");
    expect(tierForScore(21).key).toBe("contained");
    expect(tierForScore(22).key).toBe("project");
    expect(tierForScore(44).key).toBe("project");
    expect(tierForScore(45).key).toBe("cross-project");
    expect(tierForScore(69).key).toBe("cross-project");
    expect(tierForScore(70).key).toBe("estate");
    expect(tierForScore(100).key).toBe("estate");
  });

  test("a garbage score falls back to contained rather than throwing", () => {
    expect(tierForScore(undefined).key).toBe("contained");
    expect(tierForScore(NaN).key).toBe("contained");
  });

  test("BLAST_TIERS is ordered high threshold first, so find() picks the top matching tier", () => {
    expect(BLAST_TIERS.map((t) => t.min)).toEqual([70, 45, 22, 0]);
  });
});

describe("scoreRuleBlastRadius — reach", () => {
  test("a site-wide rule (no project scope) gets full reach", () => {
    const result = scoreRuleBlastRadius(summary({ projectIds: [] }));
    const reach = result.factors.find((f) => f.key === "reach");
    expect(reach.value).toBe(1);
    expect(result.estimated).toBe(false);
  });

  test("without issue counts, reach is estimated from the number of projects", () => {
    const narrow = scoreRuleBlastRadius(summary({ projectIds: ["1"] }));
    const wide = scoreRuleBlastRadius(summary({ projectIds: ["1", "2", "3", "4", "5", "6"] }));
    expect(narrow.estimated).toBe(true);
    expect(wide.factors.find((f) => f.key === "reach").value).toBeGreaterThan(
      narrow.factors.find((f) => f.key === "reach").value,
    );
  });

  test("with issue counts, reach is measured against the site total and not flagged estimated", () => {
    const context = {
      projectIssueCounts: new Map([
        ["1", 900000],
        ["2", 5],
      ]),
      siteIssueTotal: 1000000,
    };
    const big = scoreRuleBlastRadius(summary({ projectIds: ["1"] }), context);
    const small = scoreRuleBlastRadius(summary({ projectIds: ["2"] }), context);
    expect(big.estimated).toBe(false);
    expect(big.factors.find((f) => f.key === "reach").value).toBeGreaterThan(
      small.factors.find((f) => f.key === "reach").value,
    );
  });
});

describe("scoreRuleBlastRadius — cadence", () => {
  test("a scheduled rule scores higher than a manual one, all else equal", () => {
    const scheduled = scoreRuleBlastRadius(summary({ triggerType: "jira.jql.scheduled" }));
    const manual = scoreRuleBlastRadius(summary({ triggerType: "jira.manual.trigger.issue" }));
    expect(scheduled.score).toBeGreaterThan(manual.score);
    expect(scheduled.factors.find((f) => f.key === "cadence").value).toBe(1);
  });

  test("an unrecorded trigger type still produces a finite mid cadence", () => {
    const result = scoreRuleBlastRadius(summary({ triggerType: null }));
    expect(result.factors.find((f) => f.key === "cadence").value).toBeGreaterThan(0);
  });
});

describe("scoreRuleBlastRadius — action weight", () => {
  test("transitions and external calls weigh more than a single field write", () => {
    const light = scoreRuleBlastRadius(summary({ writesFields: ["Labels"] }));
    const heavy = scoreRuleBlastRadius(
      summary({
        statusRefs: [{ kind: "write" }, { kind: "write" }],
        actionKinds: ["outbound-http", "transition"],
      }),
    );
    expect(heavy.factors.find((f) => f.key === "writes").value).toBeGreaterThan(
      light.factors.find((f) => f.key === "writes").value,
    );
  });

  test("a rule with no mutating actions scores zero on action weight", () => {
    const result = scoreRuleBlastRadius(summary());
    expect(result.factors.find((f) => f.key === "writes").value).toBe(0);
  });
});

describe("scoreRuleBlastRadius — fan-out", () => {
  test("a rule that cannot trigger others contributes almost nothing on fan-out", () => {
    const result = scoreRuleBlastRadius(summary({ canOtherRuleTrigger: false }), { outDegree: 3 });
    expect(result.factors.find((f) => f.key === "fanout").value).toBeLessThan(0.15);
  });

  test("fan-out rises with the number of rules woken", () => {
    const one = scoreRuleBlastRadius(summary({ canOtherRuleTrigger: true }), { outDegree: 1 });
    const many = scoreRuleBlastRadius(summary({ canOtherRuleTrigger: true }), { outDegree: 5 });
    expect(many.factors.find((f) => f.key === "fanout").value).toBeGreaterThan(
      one.factors.find((f) => f.key === "fanout").value,
    );
  });

  test("a rule in a cascade loop maxes fan-out", () => {
    const result = scoreRuleBlastRadius(summary({ canOtherRuleTrigger: true }), { inLoop: true });
    expect(result.factors.find((f) => f.key === "fanout").value).toBe(1);
  });
});

describe("scoreRuleBlastRadius — modifiers", () => {
  test("a disabled rule is scored down but not to zero — it is a latent hazard", () => {
    const enabled = scoreRuleBlastRadius(
      summary({ projectIds: [], triggerType: "jira.jql.scheduled", actionKinds: ["transition"] }),
    );
    const disabled = scoreRuleBlastRadius(
      summary({ enabled: false, projectIds: [], triggerType: "jira.jql.scheduled", actionKinds: ["transition"] }),
    );
    expect(disabled.score).toBeGreaterThan(0);
    expect(disabled.score).toBeLessThan(enabled.score);
    expect(disabled.modifiers.map((m) => m.key)).toContain("disabled");
  });

  test("a credential-bearing rule floors at cross-project even when otherwise contained", () => {
    const result = scoreRuleBlastRadius(
      summary({
        projectIds: ["1"],
        triggerType: "jira.manual.trigger.issue",
        risks: [{ code: "embedded-credential" }],
      }),
    );
    expect(result.score).toBeGreaterThanOrEqual(55);
    expect(result.tier).toBe("cross-project");
    expect(result.credential).toBe(true);
    expect(result.modifiers.map((m) => m.key)).toContain("credential-floor");
  });

  test("a big rule already above the floor keeps its real score and records no floor modifier", () => {
    const result = scoreRuleBlastRadius(
      summary({
        projectIds: [],
        triggerType: "jira.jql.scheduled",
        statusRefs: [{ kind: "write" }, { kind: "write" }],
        actionKinds: ["outbound-http", "create-issue"],
        canOtherRuleTrigger: true,
        risks: [{ code: "embedded-credential" }],
      }),
      { outDegree: 4 },
    );
    expect(result.score).toBeGreaterThan(55);
    expect(result.modifiers.map((m) => m.key)).not.toContain("credential-floor");
  });

  test("the worst possible rule lands in the estate tier", () => {
    const result = scoreRuleBlastRadius(
      summary({
        projectIds: [],
        triggerType: "jira.jql.scheduled",
        statusRefs: [{ kind: "write" }, { kind: "write" }],
        writesFields: ["A", "B", "C", "D", "E", "F"],
        actionKinds: ["outbound-http", "delete-issue", "create-issue", "send-email"],
        canOtherRuleTrigger: true,
      }),
      { inLoop: true },
    );
    expect(result.tier).toBe("estate");
    expect(result.score).toBeGreaterThanOrEqual(70);
  });
});

describe("summarizeBlastRadius", () => {
  const entries = [
    { ruleId: "a", score: 90, tier: "estate", estimated: false, credential: true },
    { ruleId: "b", score: 72, tier: "estate", estimated: true, credential: false },
    { ruleId: "c", score: 50, tier: "cross-project", estimated: false, credential: false },
    { ruleId: "d", score: 10, tier: "contained", estimated: false, credential: false },
  ];

  test("builds the tier histogram and the two health inputs", () => {
    const s = summarizeBlastRadius(entries);
    expect(s.total).toBe(4);
    expect(s.byTier.estate).toBe(2);
    expect(s.byTier["cross-project"]).toBe(1);
    expect(s.byTier.contained).toBe(1);
    expect(s.estateWideCount).toBe(2);
    expect(s.estateWideShare).toBe(0.5);
    expect(s.estateWideCredentialCount).toBe(1);
    expect(s.estimatedCount).toBe(1);
  });

  test("top is sorted by score descending and capped at 20", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ruleId: `r${i}`, score: i, tier: "contained" }));
    const s = summarizeBlastRadius(many);
    expect(s.top).toHaveLength(20);
    expect(s.top[0].score).toBe(29);
  });

  test("an empty estate reports unavailable rather than dividing by zero", () => {
    const s = summarizeBlastRadius([]);
    expect(s.available).toBe(false);
    expect(s.estateWideShare).toBe(0);
  });
});

describe("buildBlastDocument", () => {
  test("carries a versioned per-rule table with the factor breakdown", () => {
    const entries = [scoreRuleBlastRadius(summary({ id: "r1", projectIds: [] }))];
    const doc = buildBlastDocument(entries);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.total).toBe(1);
    expect(doc.rules[0].id).toBe("r1");
    expect(doc.rules[0].factors.map((f) => f.key)).toEqual(["reach", "cadence", "writes", "fanout"]);
    expect(doc.summary.available).toBe(true);
  });

  test("drops entries with no rule id — they cannot be joined back to a rule", () => {
    const doc = buildBlastDocument([{ ruleId: null, score: 5, tier: "contained", factors: [], modifiers: [] }]);
    expect(doc.rules).toHaveLength(0);
  });
});
