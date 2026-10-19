import { describe, test, expect } from "vitest";
import { scoreLift, scoreLifts } from "./score-lift.js";
import { PILLAR_WEIGHTS } from "./health-score.js";

// A computed score's shape: pillars, each with its checks. Only the fields the lift reads.
const check = (key, score, weight = 1, available = true) => ({
  key,
  score: available ? score : null,
  weight,
  available,
});
const pillar = (key, dimensions) => {
  const scored = dimensions.filter((d) => d.available);
  const w = scored.reduce((s, d) => s + d.weight, 0);
  return {
    key,
    available: scored.length > 0,
    score: w ? scored.reduce((s, d) => s + d.score * d.weight, 0) / w : null,
    dimensions,
  };
};

// The headline, recomputed the way computeSiteHealth does it but unrounded: the reference the
// closed-form lift must agree with.
function headline(pillars) {
  const scored = pillars.filter((p) => p.available && typeof p.score === "number");
  const w = scored.reduce((s, p) => s + (PILLAR_WEIGHTS[p.key] ?? 1), 0);
  return scored.reduce((s, p) => s + p.score * (PILLAR_WEIGHTS[p.key] ?? 1), 0) / w;
}
function fixed(pillars, key) {
  return pillars.map((p) =>
    pillar(
      p.key,
      p.dimensions.map((d) => (d.key === key ? { ...d, score: 100 } : d)),
    ),
  );
}

const health = {
  pillars: [
    pillar("automation", [check("automation-credentials", 40, 2), check("automation-inert", 80, 1)]),
    pillar("filters", [check("filter-ownership", 70, 1.5), check("filter-exposure", 90, 1)]),
    pillar("dashboards", [check("dashboard-hygiene", 100, 1)]),
    pillar("assets", [check("asset-schema-hygiene", null, 1, false)]),
  ],
};

describe("scoreLift", () => {
  test("equals the headline gain from fixing the check, for every check", () => {
    const before = headline(health.pillars);
    for (const [key, lift] of scoreLifts(health)) {
      expect(lift).toBeCloseTo(headline(fixed(health.pillars, key)) - before, 10);
    }
  });

  // Automation carries pillar weight 2, so the same gap is worth more there than in filters.
  test("weighs the pillar the way the headline does", () => {
    expect(PILLAR_WEIGHTS.automation).toBe(2);
    expect(scoreLift(health, "automation-credentials")).toBeCloseTo(60 * (2 / 3) * (2 / 4), 10);
    expect(scoreLift(health, "filter-ownership")).toBeCloseTo(30 * (1.5 / 2.5) * (1 / 4), 10);
  });

  test("is zero for a check already at 100", () => {
    expect(scoreLift(health, "dashboard-hygiene")).toBe(0);
  });

  // Unmeasured is never scored as zero, so it cannot be "fixed" into the headline either.
  test("is null for an unavailable check, an unknown key, or a pillar the headline skips", () => {
    expect(scoreLift(health, "asset-schema-hygiene")).toBeNull();
    expect(scoreLift(health, "no-such-check")).toBeNull();
    expect(scoreLift({ pillars: [pillar("filters", [check("x", null, 1, false)])] }, "x")).toBeNull();
  });

  test("returns nothing for a site with no score", () => {
    expect(scoreLifts(null).size).toBe(0);
    expect(scoreLifts({ pillars: [] }).size).toBe(0);
  });

  test("treats an unknown pillar as weight 1, as computeSiteHealth does", () => {
    const h = { pillars: [pillar("mystery", [check("m", 50, 1)]), pillar("filters", [check("f", 100, 1)])] };
    expect(scoreLift(h, "m")).toBeCloseTo(25, 10);
  });

  test("ignores a check with no weight", () => {
    const h = { pillars: [pillar("filters", [check("a", 50, 0), check("b", 50, 1)])] };
    expect(scoreLift(h, "a")).toBe(0);
    expect(scoreLift(h, "b")).toBeCloseTo(50, 10);
  });
});
