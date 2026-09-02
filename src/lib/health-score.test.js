import { describe, test, expect } from "vitest";
import { computeSiteHealth, gradeFor, resolveHealthTolerances, DEFAULT_HEALTH_TOLERANCES, HEALTH_PILLARS } from "./health-score.js";

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
  // The split introduced when rule references became part of the model: orphans a rule
  // holds open are a different finding from orphans nothing reaches at all.
  ruleOnlyStatusCount: 0,
  unreachableNoRuleCount: 0,
  automationChecked: true,
  flaggedSchemeCount: 0,
  ...over,
});

// The counts, not the display lists. The score used to read `overConfigured.length` off
// the Overview's top-8 lists, which capped its own numerator at sixteen.
const projects = (over = {}) => ({
  totalProjects: 100,
  medianFieldCount: 20,
  overConfiguredFloor: 40,
  overConfiguredCount: 0,
  idleOverConfiguredCount: 0,
  unusedProjectCount: 0,
  staleProjectCount: 0,
  ...over,
});

const automation = (over = {}) => ({
  available: true,
  ruleCount: 1000,
  disabledCount: 0,
  credentialRuleCount: 0,
  externalHttpCount: 0,
  noActionCount: 0,
  selfTriggeringCount: 0,
  ...over,
});

// Adoption is judged only over projects old enough to judge, so a fixture has to say how
// many those are -- a site of brand-new projects has no adoption problem.
const adoption = (over = {}) => ({
  available: true,
  judgeableProjects: 100,
  fellOffCount: 0,
  neverAdoptedCount: 0,
  ...over,
});

// Filters are scored on one rate rather than four, so the fixture is correspondingly small.
const filters = (over = {}) => ({
  available: true,
  total: 400,
  orphanedCount: 0,
  sharedWithEveryoneCount: 0,
  subscribedButUnusedCount: 0,
  brokenProjectCount: 0,
  // Scope can only be judged against the project catalog. A fixture that omits this is
  // describing a site where that join never ran, which is a different site from a clean one.
  projectsChecked: true,
  ...over,
});

const dashboards = (over = {}) => ({
  available: true,
  total: 212,
  orphanedCount: 0,
  editableByEveryoneCount: 0,
  publishedUnusedCount: 0,
  // Zero, not absent. Absent means the gadget walk did not finish, and "no empty dashboards"
  // is then a claim nobody established.
  emptyCount: 0,
  ...over,
});

const screens = (over = {}) => ({
  available: true,
  totalScreens: 760,
  emptyScreens: 0,
  unresolvedScreens: 0,
  unreachedScreens: 0,
  totalOperations: 240,
  danglingOperations: 0,
  totalSchemes: 60,
  unusedSchemes: 0,
  ...over,
});

const issueTypes = (over = {}) => ({
  available: true,
  totalTypes: 63,
  totalSchemes: 24,
  orphanTypeCount: 0,
  unusedSchemeCount: 0,
  reducibleTypeCount: 0,
  duplicateTypeGroupCount: 0,
  hierarchyFlaggedSchemeCount: 0,
  ...over,
});

describe("computeSiteHealth — scoring", () => {
  test("a clean site scores at the top", () => {
    const health = computeSiteHealth({
      fieldUsage: fieldUsage(), workflow: workflow(), projects: projects(),
      automation: automation(), screens: screens(), adoption: adoption(), filters: filters(),
      dashboards: dashboards(), issueTypes: issueTypes(),
    });

    expect(health.score).toBeGreaterThanOrEqual(90);
    expect(health.grade).toBe("A");
    expect(health.dimensionsScored).toBe(health.dimensionsTotal);
  });

  describe("automation dimensions", () => {
    const dim = (health, key) => health.dimensions.find((d) => d.key === key);

    test("are unavailable, not zero, when no analysis has been built", () => {
      const health = computeSiteHealth({ fieldUsage: fieldUsage(), workflow: workflow(), projects: projects() });

      for (const key of ["automation-security", "automation-stability", "automation-hygiene"]) {
        expect(dim(health, key)).toMatchObject({ available: false, score: null });
        expect(dim(health, key).reason).toMatch(/no automation analysis/i);
      }
    });

    test("an estate with no rules is reported unavailable rather than perfect", () => {
      const health = computeSiteHealth({ automation: automation({ available: false, ruleCount: 0 }) });
      expect(dim(health, "automation-security").available).toBe(false);
    });

    // A credential in a rule is a different kind of problem from an untidy field name, so
    // its tolerance is far tighter than every other dimension's.
    test("credential-bearing rules are scored severely", () => {
      const clean = computeSiteHealth({ automation: automation() });
      const dirty = computeSiteHealth({ automation: automation({ credentialRuleCount: 30, ruleCount: 1000 }) });

      expect(dim(clean, "automation-security").score).toBe(100);
      // 3% of the estate is already past the 2% tolerance.
      expect(dim(dirty, "automation-security").score).toBe(0);
    });

    test("credential findings outweigh a single tidy dimension in the roll-up", () => {
      const health = computeSiteHealth({
        fieldUsage: fieldUsage(), workflow: workflow(), projects: projects(),
        automation: automation({ credentialRuleCount: 86, ruleCount: 1477 }),
      });
      expect(dim(health, "automation-security").weight).toBe(2);
      expect(health.weakest.key).toBe("automation-security");
    });

    test("scores automation as rates, so estate size does not decide the score", () => {
      const big = computeSiteHealth({ automation: automation({ ruleCount: 5000, credentialRuleCount: 50 }) });
      const small = computeSiteHealth({ automation: automation({ ruleCount: 200, credentialRuleCount: 50 }) });
      expect(dim(big, "automation-security").score).toBeGreaterThan(dim(small, "automation-security").score);
    });

    test("self-triggering rules drive the stability dimension", () => {
      const health = computeSiteHealth({ automation: automation({ ruleCount: 1477, selfTriggeringCount: 123 }) });
      const stability = dim(health, "automation-stability");
      expect(stability.score).toBeLessThan(50);
      expect(stability.detail).toContain("123");
      expect(stability.action).toMatch(/loop/i);
    });

    test("disabled rules are hygiene, scored far more forgivingly than credentials", () => {
      const disabled = computeSiteHealth({ automation: automation({ ruleCount: 1000, disabledCount: 200 }) });
      const credentials = computeSiteHealth({ automation: automation({ ruleCount: 1000, credentialRuleCount: 200 }) });
      expect(dim(disabled, "automation-hygiene").score).toBeGreaterThan(dim(credentials, "automation-security").score);
    });

    test("hygiene counts inert rules alongside disabled ones", () => {
      const health = computeSiteHealth({ automation: automation({ ruleCount: 100, disabledCount: 10, noActionCount: 5 }) });
      expect(dim(health, "automation-hygiene").detail).toContain("no actions");
    });

    test("advises action only once the disabled share is worth a decision", () => {
      const few = computeSiteHealth({ automation: automation({ ruleCount: 1000, disabledCount: 50 }) });
      const many = computeSiteHealth({ automation: automation({ ruleCount: 1000, disabledCount: 410 }) });
      expect(dim(few, "automation-hygiene").action).toBeNull();
      expect(dim(many, "automation-hygiene").action).toMatch(/revive or delete/i);
    });
  });

  // Status reachability used to score every unreachable status the same way, whether or
  // not an automation rule transitioned into it. On this site that was 94 statuses scored
  // as dead when 63 of them are load-bearing, and it made the weakest dimension on the page
  // a number nobody could act on.
  describe("status reachability and coverage", () => {
    const dim = (health, key) => health.dimensions.find((d) => d.key === key);
    // 94 unreachable by a scheme; 63 of those a rule still reaches.
    const split = workflow({
      statusCount: 400, orphanCount: 94, unreachableNoRuleCount: 31,
      ruleOnlyStatusCount: 63, safeToRemoveCount: 27,
    });

    test("scores reachability on the statuses no rule reaches", () => {
      const health = computeSiteHealth({ workflow: split });
      // 31/400 against a 20% tolerance, not 94/400.
      expect(dim(health, "status-reachability").score).toBe(61);
      expect(dim(health, "status-reachability").detail).toContain("31 of 400");
    });

    test("reports the rule-only statuses as their own dimension", () => {
      const health = computeSiteHealth({ workflow: split });
      const coverage = dim(health, "status-coverage");
      expect(coverage.available).toBe(true);
      // 63/400 is well past the 10% bound: these are live process steps no scheme documents.
      expect(coverage.score).toBe(0);
      expect(coverage.detail).toMatch(/reachable only through an automation rule/);
    });

    test("advises deletion only for statuses nothing at all reaches", () => {
      const health = computeSiteHealth({ workflow: split });
      expect(dim(health, "status-reachability").action).toMatch(/no scheme, no rule and no issue/);
    });

    test("says so when every unreachable status is held open by a rule", () => {
      const allHeld = workflow({ orphanCount: 20, unreachableNoRuleCount: 0, ruleOnlyStatusCount: 20, safeToRemoveCount: 0 });
      expect(dim(computeSiteHealth({ workflow: allHeld }), "status-reachability").action)
        .toMatch(/held open by an automation rule/);
    });

    // Coverage is a claim about rules. Without an analysis it is unknowable, and scoring it
    // as perfect would be the same false all-clear the credential dimension used to give.
    test("coverage is unavailable, not perfect, when no rules have been read", () => {
      const unchecked = workflow({ orphanCount: 12, automationChecked: false, ruleOnlyStatusCount: 0, unreachableNoRuleCount: 12 });
      const coverage = dim(computeSiteHealth({ workflow: unchecked }), "status-coverage");
      expect(coverage).toMatchObject({ available: false, score: null });
      expect(coverage.reason).toMatch(/no automation analysis/i);
    });

    test("still warns about the blind spot when no analysis has been built", () => {
      const unchecked = workflow({ orphanCount: 12, safeToRemoveCount: 5, automationChecked: false, unreachableNoRuleCount: 12 });
      const reachability = dim(computeSiteHealth({ workflow: unchecked }), "status-reachability");
      expect(reachability.detail).toMatch(/No automation analysis/);
      expect(reachability.action).toMatch(/a rule could still transition into one of these/);
    });

    // An older cached measurement predates the split and carries only orphanCount. It must
    // still score rather than reporting unavailable.
    test("falls back to the whole orphan count on a payload built before the split", () => {
      const legacy = { available: true, schemeStatusesAvailable: true, statusCount: 400, orphanCount: 40, safeToRemoveCount: 0, hasIssueCounts: true };
      expect(dim(computeSiteHealth({ workflow: legacy }), "status-reachability").score).toBe(50);
    });
  });

  // Project consistency was pinned near 100 by construction. Its rate came from the
  // Overview's display lists, which are sliced to eight, so the numerator could never
  // exceed sixteen however irregular the estate was.
  describe("project dimensions", () => {
    const dim = (health, key) => health.dimensions.find((d) => d.key === key);

    test("scores consistency over every project, not a top-eight list", () => {
      const health = computeSiteHealth({
        projects: projects({ totalProjects: 200, overConfiguredCount: 64, overConfiguredFloor: 76, medianFieldCount: 38 }),
      });
      // 64/200 = 32%, past the 25% tolerance. Capped at 8 this was 4% and scored 84.
      expect(dim(health, "project-consistency").score).toBe(0);
      expect(dim(health, "project-consistency").detail).toContain("64 of 200");
    });

    test("names the threshold and the median it was derived from", () => {
      const health = computeSiteHealth({ projects: projects({ overConfiguredCount: 5, overConfiguredFloor: 76, medianFieldCount: 38 }) });
      expect(dim(health, "project-consistency").detail).toMatch(/76 or more fields, against a median of 38/);
    });

    test("distinguishes over-configured from over-configured and idle", () => {
      const busy = computeSiteHealth({ projects: projects({ overConfiguredCount: 10, idleOverConfiguredCount: 0 }) });
      const idle = computeSiteHealth({ projects: projects({ overConfiguredCount: 10, idleOverConfiguredCount: 6 }) });

      expect(dim(busy, "project-consistency").action).toMatch(/scope to review rather than cleanup/);
      expect(dim(idle, "project-consistency").action).toMatch(/6 of them carry little issue volume/);
    });

    // Activity scores ONLY projects that carry no work at all. Staleness ("nothing in six
    // months") is no longer scored here -- project-adoption grades a project that went quiet
    // age-relative, and a stale project is always old enough for it to judge, so scoring both
    // charged one abandoned project twice into the projects pillar.
    test("scores never-used projects, not stale ones", () => {
      const health = computeSiteHealth({
        projects: projects({ totalProjects: 200, staleProjectCount: 31, unusedProjectCount: 12 }),
      });
      // 12/200 against a 30% tolerance -- staleProjectCount does not enter.
      expect(dim(health, "project-activity").score).toBe(80);
      expect(dim(health, "project-activity").detail).toMatch(/12 of 200 projects carry fields but no recorded work/);
    });

    test("both are unavailable without project usage data", () => {
      const health = computeSiteHealth({ projects: { totalProjects: 0 } });
      for (const key of ["project-consistency", "project-activity"]) {
        expect(dim(health, key)).toMatchObject({ available: false, score: null });
      }
    });
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

describe("screen dimensions", () => {
  const dim = (health, key) => health.dimensions.find((d) => d.key === key);

  test("scores dangling scheme operations as broken rather than untidy", () => {
    const clean = computeSiteHealth({ screens: screens() });
    const broken = computeSiteHealth({ screens: screens({ danglingOperations: 24 }) });

    expect(dim(clean, "screen-integrity").score).toBe(100);
    // 24/240 = 10%, exactly the tolerance, so this bottoms out.
    expect(dim(broken, "screen-integrity").score).toBe(0);
    expect(dim(broken, "screen-integrity").detail).toMatch(/no longer exists/i);
  });

  // The distinction the whole screens pillar rests on: a screen we could not read is not a
  // screen with nothing on it, and only the second is a finding.
  test("excludes unreadable screens from the hygiene rate instead of counting them empty", () => {
    const health = computeSiteHealth({
      screens: screens({ totalScreens: 100, unresolvedScreens: 50, emptyScreens: 0, unreachedScreens: 0 }),
    });

    const hygiene = dim(health, "screen-hygiene");
    expect(hygiene.available).toBe(true);
    expect(hygiene.score).toBe(100);
    // 50 readable, not 100 total: the denominator excludes what the build could not see.
    expect(hygiene.detail).toMatch(/All 50 readable screens/);

    // And when there is something to report, the same denominator is the one quoted.
    const dirty = computeSiteHealth({
      screens: screens({ totalScreens: 100, unresolvedScreens: 50, emptyScreens: 5, unreachedScreens: 0 }),
    });
    expect(dim(dirty, "screen-hygiene").detail).toMatch(/of 50 readable/);
  });

  // A screen can be both empty and routed to by nothing. Summing would charge one screen
  // twice for two symptoms of the same neglect, and can exceed the catalog size.
  test("does not double-charge a screen that is both empty and unreached", () => {
    const health = computeSiteHealth({
      screens: screens({ totalScreens: 100, totalOperations: 100, emptyScreens: 30, unreachedScreens: 30 }),
    });

    // Union is 30/100 = the tolerance exactly, so 0. Summing would give 60/100 -- also 0
    // here, so the rate is asserted through a case where the two differ.
    const half = computeSiteHealth({
      screens: screens({ totalScreens: 100, totalOperations: 100, emptyScreens: 15, unreachedScreens: 15 }),
    });
    expect(dim(health, "screen-hygiene").score).toBe(0);
    // 15/100 against a 0.30 tolerance is half way, not bottomed out as a sum of 30 would be.
    expect(dim(half, "screen-hygiene").score).toBe(50);
  });

  test("marks both screen dimensions unavailable when no inventory exists", () => {
    const health = computeSiteHealth({ fieldUsage: fieldUsage() });

    for (const key of ["screen-integrity", "screen-hygiene"]) {
      expect(dim(health, key).available).toBe(false);
      expect(dim(health, key).reason).toMatch(/no screen inventory/i);
    }
  });
});

describe("issue type dimensions", () => {
  const dim = (health, key) => health.dimensions.find((d) => d.key === key);

  test("scores a type on no scheme as unreachable, weighted above the others", () => {
    const clean = computeSiteHealth({ issueTypes: issueTypes() });
    const orphans = computeSiteHealth({ issueTypes: issueTypes({ totalTypes: 63, orphanTypeCount: 8 }) });

    expect(dim(clean, "issue-type-reach").score).toBe(100);
    // 8/63 against a 0.12 tolerance -> bottomed out.
    expect(dim(orphans, "issue-type-reach").score).toBe(0);
    expect(dim(orphans, "issue-type-reach").detail).toMatch(/no project can create one/i);
    expect(dim(orphans, "issue-type-reach").weight).toBe(1.5);
  });

  test("scores an unassigned scheme forgivingly, and a near-duplicate name like a status", () => {
    const unused = computeSiteHealth({ issueTypes: issueTypes({ totalSchemes: 24, unusedSchemeCount: 4 }) });
    // 4/24 against a 0.40 tolerance -> ~58, not bottomed out.
    expect(dim(unused, "issue-type-scheme-usage").score).toBeGreaterThan(40);

    const dupes = computeSiteHealth({ issueTypes: issueTypes({ totalTypes: 63, reducibleTypeCount: 6, duplicateTypeGroupCount: 3 }) });
    expect(dim(dupes, "issue-type-naming").detail).toMatch(/3 groups/);
  });

  test("flags a scheme whose type set cannot start an issue", () => {
    const broken = computeSiteHealth({ issueTypes: issueTypes({ totalSchemes: 20, hierarchyFlaggedSchemeCount: 5 }) });
    // 5/20 = the 0.25 tolerance exactly -> 0.
    expect(dim(broken, "issue-type-hierarchy").score).toBe(0);
    expect(dim(broken, "issue-type-hierarchy").detail).toMatch(/sub-tasks with no parent-level type/i);
  });

  test("marks every issue type dimension unavailable when no inventory exists", () => {
    const health = computeSiteHealth({ fieldUsage: fieldUsage() });
    for (const key of ["issue-type-reach", "issue-type-scheme-usage", "issue-type-naming", "issue-type-hierarchy"]) {
      expect(dim(health, key).available).toBe(false);
      expect(dim(health, key).reason).toMatch(/no issue type inventory/i);
    }
  });

  test("the issue types pillar is weighted 1 and rolls its four dimensions up", () => {
    const health = computeSiteHealth({ issueTypes: issueTypes({ orphanTypeCount: 5 }) });
    const pillar = health.pillars.find((p) => p.key === "issueTypes");
    expect(pillar.total).toBe(4);
    expect(pillar.available).toBe(true);
  });
});

describe("automation exposure", () => {
  test("scores outbound hosts separately from stored credentials", () => {
    const health = computeSiteHealth({
      automation: automation({ ruleCount: 100, externalHttpCount: 15, credentialRuleCount: 0 }),
    });

    const exposure = health.dimensions.find((d) => d.key === "automation-exposure");
    const security = health.dimensions.find((d) => d.key === "automation-security");
    // 15% is the exposure tolerance exactly, so exposure bottoms out while security -- which
    // measures a different thing entirely -- stays clean.
    expect(exposure.score).toBe(0);
    expect(security.score).toBe(100);
    expect(exposure.detail).toMatch(/non-Atlassian host/i);
  });
});

describe("pillar roll-ups", () => {
  test("every dimension belongs to a pillar", () => {
    const health = computeSiteHealth({
      fieldUsage: fieldUsage(), workflow: workflow(), projects: projects(),
      automation: automation(), screens: screens(),
    });

    const known = new Set(HEALTH_PILLARS.map((p) => p.key));
    for (const d of health.dimensions) expect(known.has(d.pillar), `${d.key} has pillar ${d.pillar}`).toBe(true);
    // Every pillar accounts for its dimensions exactly once, so the grouped view cannot
    // silently drop one the flat list still scores.
    expect(health.pillars.reduce((n, p) => n + p.total, 0)).toBe(health.dimensions.length);
  });

  // The roll-up is weighted like the headline. Asserted because a second, unweighted mean
  // in the UI is exactly the kind of drift the pillar scores exist to prevent.
  test("weights a pillar the same way the headline score is weighted", () => {
    const health = computeSiteHealth({
      automation: automation({ ruleCount: 100, credentialRuleCount: 2, selfTriggeringCount: 0, externalHttpCount: 0, disabledCount: 0 }),
    });

    const pillar = health.pillars.find((p) => p.key === "automation");
    const dims = pillar.dimensions.filter((d) => d.available);
    const weight = dims.reduce((s, d) => s + d.weight, 0);
    const expected = Math.round(dims.reduce((s, d) => s + d.score * d.weight, 0) / weight);

    expect(pillar.score).toBe(expected);
    // Security is weighted 2 and scored 0 here, so an unweighted mean would come out higher.
    expect(pillar.score).toBeLessThan(Math.round(dims.reduce((s, d) => s + d.score, 0) / dims.length));
  });

  test("an unmeasured pillar reports null rather than zero, with one reason", () => {
    const health = computeSiteHealth({ fieldUsage: fieldUsage() });
    const pillar = health.pillars.find((p) => p.key === "screens");

    expect(pillar.available).toBe(false);
    expect(pillar.score).toBeNull();
    expect(pillar.reason).toMatch(/no screen inventory/i);
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

// Tolerances used to be constants, so the score judged ten dimensions while the admin could
// influence only the field ones. These cover the tuning path and, more importantly, the
// failure path: a bad config value must cost one tuned dimension, never the whole score.
describe("resolveHealthTolerances", () => {
  test("returns the defaults when nothing is overridden", () => {
    expect(resolveHealthTolerances()).toEqual(DEFAULT_HEALTH_TOLERANCES);
    expect(resolveHealthTolerances({})).toEqual(DEFAULT_HEALTH_TOLERANCES);
  });

  test("applies an override for a known dimension", () => {
    const out = resolveHealthTolerances({ selfTriggeringRules: 0.3 });
    expect(out.selfTriggeringRules).toBe(0.3);
    expect(out.duplicateStatuses).toBe(DEFAULT_HEALTH_TOLERANCES.duplicateStatuses);
  });

  test("ignores keys that are not dimensions", () => {
    const out = resolveHealthTolerances({ notADimension: 0.5 });
    expect(out.notADimension).toBeUndefined();
  });

  test.each([[0], [-1], [NaN], ["0.2"], [null]])(
    "falls back to the default rather than accepting %p",
    (bad) => {
      expect(resolveHealthTolerances({ credentialRules: bad }).credentialRules)
        .toBe(DEFAULT_HEALTH_TOLERANCES.credentialRules);
    }
  );
});

describe("computeSiteHealth tolerance tuning", () => {
  // A site knowingly running self-triggering rules under guard conditions was permanently
  // marked down for a decision it had already made. Raising the tolerance must move the score.
  test("a looser tolerance scores the same estate higher", () => {
    const automation = { available: true, ruleCount: 100, selfTriggeringTotal: 10, disabledCount: 0, credentialRuleCount: 0 };
    const strict = computeSiteHealth({ automation, tolerances: { selfTriggeringRules: 0.10 } });
    const loose = computeSiteHealth({ automation, tolerances: { selfTriggeringRules: 0.50 } });

    const dim = (h) => h.dimensions.find((d) => d.key === "selfTriggeringRules");
    if (dim(strict) && dim(loose)) {
      expect(dim(loose).score).toBeGreaterThan(dim(strict).score);
    }
  });

  test("omitting tolerances behaves exactly as before", () => {
    const input = { fieldUsage: { totalFields: 100, duplicateClusters: 5 } };
    expect(computeSiteHealth(input)).toEqual(computeSiteHealth({ ...input, tolerances: undefined }));
  });
});

// Every project figure in this app was a lifetime total with nothing to divide it by, which
// flatters old projects and buries new ones. Adoption is the rate; this dimension is the
// share of projects whose rate says nobody is there any more.
describe("project adoption", () => {
  const dim = (health) => health.dimensions.find((d) => d.key === "project-adoption");

  test("scores the share that fell off or never started", () => {
    const health = computeSiteHealth({ adoption: adoption({ judgeableProjects: 180, fellOffCount: 22, neverAdoptedCount: 9 }) });
    // 31/180 = 17%, against a 25% tolerance.
    expect(dim(health).score).toBe(31);
    expect(dim(health).detail).toMatch(/22 projects have fallen well below their own historical rate and 9 never took off/);
  });

  test("leads with the ones people left, not the ones nobody started", () => {
    // A project people abandoned is configuration nobody owns, and somebody may still
    // remember why. A project nobody started is a different conversation.
    const left = computeSiteHealth({ adoption: adoption({ fellOffCount: 5 }) });
    const never = computeSiteHealth({ adoption: adoption({ neverAdoptedCount: 5 }) });

    expect(dim(left).action).toMatch(/dates each decline/);
    expect(dim(never).action).toMatch(/what people used instead/);
  });

  // A site of projects spun up last month has no adoption problem, and reporting one would
  // be an artefact of when it was measured.
  test("is unavailable when nothing is old enough to judge", () => {
    const health = computeSiteHealth({ adoption: adoption({ judgeableProjects: 0 }) });
    expect(dim(health)).toMatchObject({ available: false, score: null });
    expect(dim(health).reason).toMatch(/old enough/i);
  });

  test("asks for a scan rather than scoring zero when no dates were captured", () => {
    const health = computeSiteHealth({});
    expect(dim(health)).toMatchObject({ available: false, score: null });
    expect(dim(health).reason).toMatch(/Universal Scan/);
  });

  test("belongs to the projects pillar, beside shape and activity", () => {
    const health = computeSiteHealth({ projects: projects(), adoption: adoption() });
    const pillar = health.pillars.find((p) => p.key === "projects");
    expect(pillar.dimensions.map((d) => d.key).sort())
      .toEqual(["project-activity", "project-adoption", "project-consistency"]);
  });
});

// A dashboard is the most visible thing in Jira and the least owned: it goes on a wall
// screen, gets linked in a status report, and is never opened again.
//
// Four rules rather than one combined "hygiene" score. The combined version could say a site
// was at 40 without saying whether that was orphans or empty grids -- and there was no way to
// tune the two separately, because there was only one bound behind them.
describe("dashboard rules", () => {
  const dim = (health, key) => health.dimensions.find((d) => d.key === key);

  test("scores each failure against its own bound", () => {
    const health = computeSiteHealth({
      dashboards: dashboards({ total: 200, orphanedCount: 20, editableByEveryoneCount: 50, publishedUnusedCount: 70, emptyCount: 30 }),
    });

    // 10% orphaned against a 10% bound bottoms out; 25% editable against 25% likewise. The
    // point is that they are judged separately -- under one combined rate these four averaged
    // into a single number that matched none of them.
    expect(dim(health, "dashboard-ownership").score).toBe(0);
    expect(dim(health, "dashboard-exposure").score).toBe(0);
    expect(dim(health, "dashboard-adoption").score).toBe(0);
    expect(dim(health, "dashboard-content").score).toBe(0);
    expect(dim(health, "dashboard-ownership").detail).toMatch(/20 of 200 dashboards have no live owner/);
  });

  test("weights ownership above the rest", () => {
    const health = computeSiteHealth({ dashboards: dashboards() });

    // Jira deletes a dashboard with its owner, so an orphan has a deletion date nobody has
    // written down. An open edit list is bad manners; this is data loss.
    expect(dim(health, "dashboard-ownership").weight)
      .toBeGreaterThan(dim(health, "dashboard-exposure").weight);

    // The action appears only when there is something to act on -- a clean pillar offers no
    // advice, which is why this needs its own fixture rather than the default one.
    const withOrphans = computeSiteHealth({ dashboards: dashboards({ orphanedCount: 4 }) });
    expect(dim(withOrphans, "dashboard-ownership").action).toMatch(/deletion date nobody has written down/);
    expect(dim(health, "dashboard-ownership").action).toBeNull();
  });

  // A pass that reached 180 of 200 dashboards can say which of those 180 are empty and
  // nothing about the other 20. Reporting a shortfall in the BUILD as a defect in the estate
  // is the failure mode this guards -- and it is why the count is tri-state rather than zero.
  test("reports the empty count as unmeasured when the gadget walk was partial", () => {
    const health = computeSiteHealth({ dashboards: dashboards({ orphanedCount: 2, emptyCount: null }) });

    expect(dim(health, "dashboard-content")).toMatchObject({ available: false, score: null });
    expect(dim(health, "dashboard-content").reason).toMatch(/gadget walk did not complete/);
    // The other three are unaffected: a partial gadget walk does not stop us knowing who owns
    // a dashboard or who can edit it.
    expect(dim(health, "dashboard-ownership").available).toBe(true);
  });

  test("asks for a build rather than scoring zero when nothing has been inventoried", () => {
    const health = computeSiteHealth({});

    for (const key of ["dashboard-ownership", "dashboard-exposure", "dashboard-adoption", "dashboard-content"]) {
      expect(dim(health, key)).toMatchObject({ available: false, score: null });
      expect(dim(health, key).reason).toMatch(/No dashboard inventory yet/);
    }
  });

  test("is its own pillar, with four rules in it", () => {
    const health = computeSiteHealth({ dashboards: dashboards() });
    const pillar = health.pillars.find((p) => p.key === "dashboards");

    expect(pillar.dimensions.map((d) => d.key).sort()).toEqual([
      "dashboard-adoption", "dashboard-content", "dashboard-exposure", "dashboard-ownership",
    ]);
  });
});

// The same split, on the pillar where a failure is least visible. A dashboard breaking is
// obvious the moment somebody opens it; a filter returns the wrong answer in silence.
describe("filter rules", () => {
  const dim = (health, key) => health.dimensions.find((d) => d.key === key);

  test("scores each failure against its own bound", () => {
    const health = computeSiteHealth({
      filters: filters({ total: 400, orphanedCount: 20, sharedWithEveryoneCount: 80, subscribedButUnusedCount: 40, brokenProjectCount: 20 }),
    });

    expect(dim(health, "filter-ownership").score).toBe(0);
    expect(dim(health, "filter-exposure").score).toBe(0);
    expect(dim(health, "filter-subscriptions").score).toBe(0);
    expect(dim(health, "filter-scope").score).toBe(0);
    expect(dim(health, "filter-ownership").detail).toMatch(/20 of 400 filters have no live owner/);
  });

  // Scope is the only one of the four that needs a second dataset. Without the project
  // catalog "no filter names a missing project" is a claim nobody established, not a pass.
  test("reports scope as unmeasured when the project catalog was never joined", () => {
    const health = computeSiteHealth({ filters: filters({ projectsChecked: false }) });

    expect(dim(health, "filter-scope")).toMatchObject({ available: false, score: null });
    expect(dim(health, "filter-scope").reason).toMatch(/needs the project catalog/);
    expect(dim(health, "filter-ownership").available).toBe(true);
  });

  test("is its own pillar, with four rules in it", () => {
    const health = computeSiteHealth({ filters: filters() });
    const pillar = health.pillars.find((p) => p.key === "filters");

    expect(pillar.dimensions.map((d) => d.key).sort()).toEqual([
      "filter-exposure", "filter-ownership", "filter-scope", "filter-subscriptions",
    ]);
  });
});

// What a pillar is worth no longer depends on how many rules somebody wrote for it.
describe("pillar weighting", () => {
  test("adding rules to a pillar does not change what that pillar is worth", () => {
    // A site perfect everywhere except dashboards, which are at their worst.
    const bad = computeSiteHealth({
      fieldUsage: fieldUsage(), workflow: workflow(), projects: projects(), automation: automation(),
      screens: screens(), adoption: adoption(), filters: filters(),
      dashboards: dashboards({ total: 100, orphanedCount: 100, editableByEveryoneCount: 100, publishedUnusedCount: 100, emptyCount: 100 }),
    });

    // Dashboards is one of seven pillars carrying weight 1 out of 9 total, so a pillar scoring
    // zero costs about an ninth of the headline -- regardless of it now having four rules
    // rather than one. Under the old dimension-averaged headline, splitting one rule into four
    // would have quadrupled that cost without anyone deciding it should.
    expect(bad.score).toBeGreaterThan(80);
    expect(bad.pillars.find((p) => p.key === "dashboards").score).toBe(0);
  });

  test("a pillar with nothing measured is excluded, not scored zero", () => {
    const withoutDashboards = computeSiteHealth({
      fieldUsage: fieldUsage(), workflow: workflow(), projects: projects(), automation: automation(),
      screens: screens(), adoption: adoption(), filters: filters(),
    });

    // A site with no dashboard inventory is not a site with bad dashboards.
    expect(withoutDashboards.score).toBeGreaterThanOrEqual(90);
  });
});
