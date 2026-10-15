import { describe, test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HEALTH_TOLERANCES, DEFAULT_HEALTH_TARGETS } from "../../../src/lib/health-score.js";

// The governance rules page and the scoring algorithm, checked against each other.
//
// They had drifted in both directions at once. Fourteen tolerances drove the site health score
// with no control on the page -- including every filter and dashboard rule, which is why the
// page appeared to have nothing for those pillars at all. And one control, `unusedFields`, was
// tunable and read by nothing: an admin could move that slider all day and change no number
// anywhere.
//
// Neither is visible from either side alone. The page renders fine with a rule missing, and
// the score computes fine with a tolerance nobody can reach. Only comparing them finds it.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const configSource = fs.readFileSync(path.join(ROOT, "static/src/tabs/ConfigTab.jsx"), "utf8");
const scoreSource = fs.readFileSync(path.join(ROOT, "src/lib/health-score.js"), "utf8");

// Rules the algorithm actually reads -- v1 tolerances (TOLERANCE.x) and v2 target bands
// (TARGET.x). Both are keyed the same way on the page.
const consumed = new Set([
  ...[...scoreSource.matchAll(/TOLERANCE\.([a-zA-Z]+)/g)].map((m) => m[1]),
  ...[...scoreSource.matchAll(/TARGET\.([a-zA-Z]+)/g)].map((m) => m[1]),
]);

// Rules the page lets an admin change, in any markup form.
const exposed = new Set([
  ...[...configSource.matchAll(/setTolerancePercent\("([a-zA-Z]+)"/g)].map((m) => m[1]),
  ...[...configSource.matchAll(/\bk="([a-zA-Z]+)"/g)].map((m) => m[1]),
]);

const defined = new Set([...Object.keys(DEFAULT_HEALTH_TOLERANCES), ...Object.keys(DEFAULT_HEALTH_TARGETS)]);

describe("governance rules page", () => {
  test("every rule that affects the score is tunable", () => {
    expect([...consumed].filter((k) => !exposed.has(k)).sort()).toEqual([]);
  });

  test("every control on the page affects the score", () => {
    // A slider that changes nothing is worse than a missing one: it looks like governance.
    expect([...exposed].filter((k) => !consumed.has(k)).sort()).toEqual([]);
  });

  test("every tunable rule has a default", () => {
    expect([...consumed].filter((k) => !defined.has(k)).sort()).toEqual([]);
  });

  // Guards the guards. Regexes that stop matching would make all three pass by comparing two
  // empty sets, which is the failure mode of every test that reads source.
  test("actually found the rules it claims to compare", () => {
    expect(consumed.size).toBeGreaterThan(15);
    expect(exposed.size).toBeGreaterThan(15);
  });
});

describe("health pillars", () => {
  test("filters and dashboards each have at least four scored rules", () => {
    const forPillar = (name) => [...scoreSource.matchAll(new RegExp(`pillar: "${name}"`, "g"))].length;

    // The complaint that started this: the page showed nothing for either, because each pillar
    // was a single combined "hygiene" dimension behind a single hidden tolerance.
    expect(forPillar("filters")).toBeGreaterThanOrEqual(4);
    expect(forPillar("dashboards")).toBeGreaterThanOrEqual(4);
  });
});
