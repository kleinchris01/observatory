import { describe, test, expect } from "vitest";
import { computeSiteHealth, gradeFor } from "./health-score.js";

// The score is a way into the findings, not a finding itself. These tests mostly pin the
// two properties that stop it from lying: it scores rates rather than counts, and it
// never scores a dimension whose input was never collected.

const fieldUsage = (over = {}) => ({
  totalFields: 200,
  duplicateClusters: 0,
  findingsBySeverity: { high: 0, medium: 0, low: 0 },
  ...over,
});

const workflow = (over = {}) => ({
  available: true,
  schemeCount: 80,
  statusCount: 400,
  sharedSchemes: 40,
  schemeStatusesAvailable: true,
  hasIssueCounts: true,
  duplicateGroupCount: 0,
  reducibleStatusCount: 0,
  orphanCount: 0,
  safeToRemoveCount: 0,
  flaggedSchemeCount: 0,
  ...over,
});

const projects = (over = {}) => ({
  totalProjects: 100,
  overConfigured: [],
  unusedProjects: [],
  ...over,
});

describe("computeSiteHealth — scoring", () => {
  test("a clean site scores at the top", () => {
    const health = computeSiteHealth({ fieldUsage: fieldUsage(), workflow: workflow(), projects: projects() });

    expect(health.score).toBeGreaterThanOrEqual(90);
    expect(health.grade).toBe("A");
    expect(health.dimensionsScored).toBe(health.dimensionsTotal);
  });

  // The property that matters most: identical defect COUNTS on sites of different size
  // must not score the same.
  test("scores rates, not counts", () => {
    const big = computeSiteHealth({
      fieldUsage: fieldUsage({ totalFields: 5000, duplicateClusters: 50 }),
      workflow: workflow(), projects: projects(),
    });
    const small = computeSiteHealth({
      fieldUsage: fieldUsage({ totalFields: 80, duplicateClusters: 50 }),
      workflow: workflow(), projects: projects(),
    });

    const dim = (h) => h.dimensions.find((d) => d.key === "field-naming").score;
    expect(dim(big)).toBeGreaterThan(dim(small));
    expect(dim(small)).toBe(0);
  });

  test("weights high-severity field findings above medium", () => {
    const high = computeSiteHealth({
      fieldUsage: fieldUsage({ findingsBySeverity: { high: 40, medium: 0, low: 0 } }),
      workflow: workflow(), projects: projects(),
    });
    const medium = computeSiteHealth({
      fieldUsage: fieldUsage({ findingsBySeverity: { high: 0, medium: 40, low: 0 } }),
      workflow: workflow(), projects: projects(),
    });

    const dim = (h) => h.dimensions.find((d) => d.key === "field-governance").score;
    expect(dim(high)).toBeLessThan(dim(medium));
  });

  test("rewards shared schemes, because a bespoke-per-project site cannot standardise", () => {
    const shared = computeSiteHealth({ fieldUsage: fieldUsage(), workflow: workflow({ sharedSchemes: 60 }), projects: projects() });
    const bespoke = computeSiteHealth({ fieldUsage: fieldUsage(), workflow: workflow({ sharedSchemes: 2 }), projects: projects() });

    const dim = (h) => h.dimensions.find((d) => d.key === "standardisation");
    expect(dim(shared).score).toBeGreaterThan(dim(bespoke).score);
    expect(dim(bespoke).action).toMatch(/single project/i);
  });

  test("names the weakest dimension so the score has somewhere to go", () => {
    const health = computeSiteHealth({
      fieldUsage: fieldUsage(),
      workflow: workflow({ reducibleStatusCount: 60 }),
      projects: projects(),
    });

    expect(health.weakest.key).toBe("status-naming");
    expect(health.weakest.action).toMatch(/consolidate/i);
  });
});

describe("computeSiteHealth — missing input", () => {
  // "We have not looked" and "we looked and it is bad" are different claims, and only one
  // of them justifies action. Imputing zero would turn the first into the second.
  test("excludes dimensions with no data rather than scoring them zero", () => {
    const health = computeSiteHealth({ fieldUsage: fieldUsage(), workflow: null, projects: null });

    const workflowDims = health.dimensions.filter((d) => d.key.startsWith("status") || d.key === "workflow-structure" || d.key === "standardisation");
    expect(workflowDims.every((d) => d.available === false)).toBe(true);
    expect(workflowDims.every((d) => d.score === null)).toBe(true);
    // A clean field score is not dragged down by workflow data that was never collected.
    expect(health.score).toBeGreaterThanOrEqual(90);
  });

  test("reports coverage so a high score from few dimensions is visible as such", () => {
    const partial = computeSiteHealth({ fieldUsage: fieldUsage(), workflow: null, projects: null });

    expect(partial.dimensionsScored).toBeLessThan(partial.dimensionsTotal);
    expect(partial.dimensions.find((d) => d.key === "status-naming").reason).toMatch(/no workflow inventory/i);
  });

  test("suppresses reachability when Jira returned no workflow status data", () => {
    const health = computeSiteHealth({
      fieldUsage: fieldUsage(),
      workflow: workflow({ schemeStatusesAvailable: false, orphanCount: 400 }),
      projects: projects(),
    });

    // Without the mapping every status looks unreachable; scoring that would report a
    // catastrophic result for a healthy site.
    const dim = health.dimensions.find((d) => d.key === "status-reachability");
    expect(dim.available).toBe(false);
    expect(dim.reason).toMatch(/did not return/i);
  });

  test("returns a null score when nothing at all has been collected", () => {
    const health = computeSiteHealth({});
    expect(health.score).toBeNull();
    expect(health.grade).toBeNull();
    expect(health.weakest).toBeNull();
  });

  test("survives being called with no argument", () => {
    expect(() => computeSiteHealth()).not.toThrow();
  });
});

describe("gradeFor", () => {
  test.each([[95, "A"], [85, "B"], [75, "C"], [65, "D"], [20, "E"]])("%i maps to %s", (score, grade) => {
    expect(gradeFor(score)).toBe(grade);
  });

  test("has no grade for an absent score", () => {
    expect(gradeFor(null)).toBeNull();
    expect(gradeFor(undefined)).toBeNull();
  });
});
