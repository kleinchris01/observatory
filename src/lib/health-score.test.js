import { describe, test, expect } from "vitest";
import {
  computeSiteHealth,
  gradeFor,
  resolveHealthTolerances,
  DEFAULT_HEALTH_TOLERANCES,
  HEALTH_PILLARS,
  scoreAgainstTarget,
  blastMultiplier,
  directionAdjust,
  targetDimension,
  resolveHealthTargets,
  DEFAULT_HEALTH_TARGETS,
} from "./health-score.js";

describe("scoring model v2 primitives", () => {
  describe("scoreAgainstTarget", () => {
    test("down: 100 at/under target, 0 at/over floor, linear between", () => {
      const band = { target: 0, floor: 0.1, direction: "down" };
      expect(scoreAgainstTarget(0, band)).toBe(100);
      expect(scoreAgainstTarget(0.05, band)).toBe(50);
      expect(scoreAgainstTarget(0.1, band)).toBe(0);
      expect(scoreAgainstTarget(0.4, band)).toBe(0);
    });
    test("up: 100 at/over target, 0 at/under floor", () => {
      const band = { target: 0.9, floor: 0.5, direction: "up" };
      expect(scoreAgainstTarget(0.95, band)).toBe(100);
      expect(scoreAgainstTarget(0.7, band)).toBe(50);
      expect(scoreAgainstTarget(0.5, band)).toBe(0);
      expect(scoreAgainstTarget(0.2, band)).toBe(0);
    });
    test("returns null for an un-scoreable band or value", () => {
      expect(scoreAgainstTarget(NaN, { target: 0, floor: 1, direction: "down" })).toBeNull();
      expect(scoreAgainstTarget(0.5, { target: 0.5, floor: 0.5, direction: "down" })).toBeNull();
      expect(scoreAgainstTarget(0.5, { target: 0.9, floor: 0.95, direction: "up" })).toBeNull(); // floor above target
      expect(scoreAgainstTarget(0.5, { target: 0.1, floor: 0.05, direction: "down" })).toBeNull(); // floor below target
    });
  });

  describe("blastMultiplier", () => {
    test("0.5x when nothing is affected, ~2x at full estate reach, monotonic between", () => {
      expect(blastMultiplier(0, 1000)).toBe(0.5);
      expect(blastMultiplier(1000, 1000)).toBe(2);
      const small = blastMultiplier(10, 1000);
      const big = blastMultiplier(400, 1000);
      expect(small).toBeGreaterThan(0.5);
      expect(big).toBeGreaterThan(small);
      expect(big).toBeLessThan(2);
    });
    test("guards a zero or missing estate", () => {
      expect(blastMultiplier(5, 0)).toBeGreaterThanOrEqual(0.5);
      expect(blastMultiplier(undefined, undefined)).toBe(0.5);
    });
  });

  describe("directionAdjust", () => {
    test("rewards improvement up to the bonus cap, penalises regression harder", () => {
      expect(directionAdjust(0, 0.4)).toBe(0);
      expect(directionAdjust(1, 0.4)).toBe(6); // clamped to DIRECTION_MAX_BONUS
      expect(directionAdjust(-1, 0.4)).toBe(-12); // clamped to DIRECTION_MAX_PENALTY
      expect(directionAdjust(0.2, 0.4)).toBe(3);
      expect(directionAdjust(-0.2, 0.4)).toBe(-6);
    });
    test("no adjustment without a usable scale", () => {
      expect(directionAdjust(0.5, 0)).toBe(0);
      expect(directionAdjust(0.5, NaN)).toBe(0);
    });
  });

  describe("targetDimension", () => {
    const base = {
      key: "k",
      label: "K",
      pillar: "boards",
      weight: 1.5,
      value: 0.9,
      target: 0.98,
      floor: 0.75,
      direction: "up",
    };
    test("scores the level, exposes value/target/floor/direction, and scales weight by blast", () => {
      const d = targetDimension({ ...base, affected: 3, estate: 30 });
      expect(d.available).toBe(true);
      expect(d.level).toBe(65);
      expect(d.score).toBe(65);
      expect(d.value).toBe(0.9);
      expect(d.baseWeight).toBe(1.5);
      expect(d.blastMultiplier).toBeGreaterThan(1);
      expect(d.weight).toBe(Math.round(1.5 * d.blastMultiplier * 100) / 100);
      expect(d.delta).toBeNull();
      expect(d.trend).toBe("flat");
    });
    test("folds a capped directional term in once there is a prior value, oriented so up is good", () => {
      const improved = targetDimension({ ...base, prior: 0.8 });
      const slipped = targetDimension({ ...base, prior: 0.97 });
      expect(improved.score).toBeGreaterThan(improved.level);
      expect(improved.trend).toBe("improving");
      expect(slipped.score).toBeLessThan(slipped.level);
      expect(slipped.trend).toBe("worsening");
    });
    test("marks the dimension unavailable rather than inventing a number when the band is bad", () => {
      const d = targetDimension({ ...base, target: 0.5, floor: 0.5 });
      expect(d.available).toBe(false);
    });
  });

  describe("resolveHealthTargets", () => {
    test("returns the shipped defaults untouched", () => {
      expect(resolveHealthTargets()).toEqual(DEFAULT_HEALTH_TARGETS);
    });
    test("applies a valid override and keeps the direction/blast metadata", () => {
      const out = resolveHealthTargets({ leastPrivilegeConformance: { target: 0.95, floor: 0.6 } });
      expect(out.leastPrivilegeConformance).toMatchObject({
        target: 0.95,
        floor: 0.6,
        direction: "up",
        blast: "users",
      });
    });
    test("keeps the whole default when the override pair is degenerate for the direction", () => {
      // "up" band with floor above target -> reject, keep default.
      const out = resolveHealthTargets({ leastPrivilegeConformance: { target: 0.5, floor: 0.8 } });
      expect(out.leastPrivilegeConformance).toEqual(DEFAULT_HEALTH_TARGETS.leastPrivilegeConformance);
    });
  });
});

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
  // Transition rules read by the build: 600 rules across 120 workflows, none broken.
  ruleIntegrity: {
    available: true,
    workflows: 120,
    teamManaged: 20,
    rules: 600,
    brokenRules: 0,
    brokenProperties: 0,
    inactive: 0,
  },
  ...over,
});

// A legacy site, so all three field-scheme dimensions score: on field schemes the
// required-but-hidden dimension cannot apply.
const fieldConfigs = (over = {}) => ({
  available: true,
  source: "field-configurations",
  usageJudged: 40,
  unusedSchemes: 0,
  unusedConfigs: 0,
  duplicateJudged: 40,
  duplicateGroups: 0,
  reducible: 0,
  conflictJudged: 30,
  requiredHiddenConfigs: 0,
  requiredHiddenPairs: 0,
  ...over,
});

// A clean JSM site: every one of the four pillars scores, nothing flagged.
const jsm = {
  requestTypes: (over = {}) => ({
    available: true,
    jsmEnabled: true,
    total: 40,
    hidden: 0,
    undescribed: 0,
    duplicateNames: 0,
    usageMeasured: 40,
    unused: 0,
    ...over,
  }),
  queues: (over = {}) => ({
    available: true,
    jsmEnabled: true,
    total: 20,
    brokenChecked: 20,
    broken: 0,
    countsMeasured: 20,
    empty: 0,
    duplicates: 0,
    ...over,
  }),
  slas: (over = {}) => ({
    available: true,
    jsmEnabled: true,
    total: 4,
    measured: 4,
    unused: 0,
    activeRequests: 500,
    breachedRequests: 0,
    ...over,
  }),
  customers: (over = {}) => ({
    available: true,
    jsmEnabled: true,
    totalOrganizations: 10,
    membersMeasured: 10,
    emptyOrganizations: 0,
    unattachedOrganizations: 0,
    ...over,
  }),
};

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
  estateWideCount: 0,
  estateWideCredentialCount: 0,
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
  filterGadgetDashboards: 120,
  brokenGadgetCount: 0,
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

// The People pillar's health input: the licensed-user count with how many are deactivated,
// and the owned-artifact total with how many belong to an account off the roster.
const users = (over = {}) => ({
  available: true,
  totalUsers: 500,
  deactivatedUsers: 0,
  ownedArtifactTotal: 600,
  orphanedArtifacts: 0,
  // Dormant licences score only when a crawl actually measured somebody. The default here
  // is "measured and clean"; the unmeasured case is asserted on its own below.
  activityMeasured: true,
  measuredAccounts: 500,
  dormantAccounts: 0,
  ...over,
});

// The Assets (CMDB) pillar's health input. `assetsEnabled: false` is the common case and
// takes the pillar out of the score entirely; this fixture is the JSM-Premium site.
const assets = (over = {}) => ({
  available: true,
  assetsEnabled: true,
  totalSchemas: 12,
  deadSchemaCount: 0,
  concreteObjectTypes: 140,
  bareTypeCount: 0,
  brokenHierarchyCount: 0,
  referenceAttributeCount: 90,
  brokenReferenceCount: 0,
  countsMeasured: true,
  measuredConcreteTypes: 140,
  emptyObjectTypeCount: 0,
  ...over,
});

// The three access pillars' health inputs.
const permissions = (over = {}) => ({
  available: true,
  totalSchemes: 8,
  riskySchemeCount: 0,
  unusedSchemeCount: 0,
  ...over,
});
const security = (over = {}) => ({
  available: true,
  totalSchemes: 4,
  totalLevels: 12,
  brokenLevelCount: 0,
  unusedSchemeCount: 0,
  ...over,
});
const notifications = (over = {}) => ({
  available: true,
  totalSchemes: 5,
  fragileSchemeCount: 0,
  unusedSchemeCount: 0,
  ...over,
});
const estate = (over = {}) => ({
  available: true,
  totalResolutions: 6,
  totalPriorities: 5,
  reducibleResolutionCount: 0,
  reduciblePriorityCount: 0,
  usageMeasured: true,
  unusedPriorityCount: 0,
  unusedResolutionCount: 0,
  ...over,
});
const roles = (over = {}) => ({
  available: true,
  projectsWithRoles: 40,
  projectsMissingAdminActorCount: 0,
  offRosterActorCount: 0,
  directUserActorCount: 20,
  groupActorCount: 2000,
  totalRoles: 8,
  emptyRoleCount: 0,
  ...over,
});
const boards = (over = {}) => ({
  available: true,
  total: 30,
  brokenBackingCount: 0,
  inactiveFilterOwner: 0,
  staleColumnBoards: 0,
  unmappedColumnBoards: 0,
  ...over,
});
const drift = (over = {}) => ({ available: true, windowDays: 30, trackedEntities: 500, changesInWindow: 0, ...over });
// The screen x field cross. Its two dimensions are the only ones in the model that come from
// a STORED summary rather than a live overview, so the fixture mirrors what the scan wrote.
const screenCross = (over = {}) => ({
  available: true,
  projectsTotal: 40,
  projectsResolved: 40,
  populatedFieldCount: 120,
  createPlacements: 900,
  counts: { invisibleFields: 0, invisibleIssues: 0, clutterFields: 0, clutterPlacements: 0, unreachableFields: 0 },
  ...over,
});

describe("computeSiteHealth — scoring", () => {
  test("a clean site scores at the top", () => {
    const health = computeSiteHealth({
      fieldUsage: fieldUsage(),
      workflow: workflow(),
      projects: projects(),
      automation: automation(),
      screens: screens(),
      adoption: adoption(),
      filters: filters(),
      dashboards: dashboards(),
      issueTypes: issueTypes(),
      users: users(),
      assets: assets(),
      permissions: permissions(),
      security: security(),
      notifications: notifications(),
      roles: roles(),
      estate: estate(),
      boards: boards(),
      drift: drift(),
      screenCross: screenCross(),
      fieldConfigs: fieldConfigs(),
      requestTypes: jsm.requestTypes(),
      queues: jsm.queues(),
      slas: jsm.slas(),
      customers: jsm.customers(),
    });

    expect(health.score).toBeGreaterThanOrEqual(90);
    expect(health.grade).toBe("A");
    expect(health.dimensionsScored).toBe(health.dimensionsTotal);
  });

  describe("field scheme dimensions", () => {
    const dim = (health, key) => health.dimensions.find((d) => d.key === key);

    test("score unused, conflicting and duplicate schemes as rates, each on what was measured", () => {
      const health = computeSiteHealth({
        fieldConfigs: fieldConfigs({
          unusedSchemes: 6,
          unusedConfigs: 6,
          requiredHiddenConfigs: 1,
          requiredHiddenPairs: 3,
          reducible: 8,
          duplicateGroups: 3,
        }),
      });
      expect(dim(health, "fieldconfig-usage")).toMatchObject({ pillar: "fieldConfigs", available: true, score: 0 });
      expect(dim(health, "fieldconfig-usage").detail).toMatch(/12 of 40 non-default field configurations and schemes/);
      const conflict = dim(health, "fieldconfig-required-hidden");
      expect(conflict.score).toBe(0);
      expect(conflict.detail).toMatch(/1 of 30 field configurations require a field they also hide \(3 fields/);
      expect(dim(health, "fieldconfig-duplicates").detail).toMatch(
        /8 field configurations duplicate another exactly, across 3 groups/,
      );
    });

    test("on field schemes the required-but-hidden dimension says why it cannot apply", () => {
      const d = dim(
        computeSiteHealth({ fieldConfigs: fieldConfigs({ source: "field-schemes", conflictJudged: null }) }),
        "fieldconfig-required-hidden",
      );
      expect(d).toMatchObject({ available: false, score: null });
      expect(d.reason).toMatch(/cannot hide a required field/);
    });

    test("nothing built is unavailable everywhere, never clean", () => {
      const health = computeSiteHealth({ fieldConfigs: { available: false } });
      for (const key of ["fieldconfig-usage", "fieldconfig-required-hidden", "fieldconfig-duplicates"]) {
        expect(dim(health, key)).toMatchObject({ available: false, score: null });
      }
    });

    test("duplicates are not judged when no owner's fields were read", () => {
      const d = dim(
        computeSiteHealth({ fieldConfigs: fieldConfigs({ duplicateJudged: 0 }) }),
        "fieldconfig-duplicates",
      );
      expect(d.available).toBe(false);
    });
  });

  describe("workflow rule dimensions", () => {
    const dim = (health, key) => health.dimensions.find((d) => d.key === key);
    const rules = (over) => workflow({ ruleIntegrity: { ...workflow().ruleIntegrity, ...over } });

    test("score broken references against the rules read, and say what to do", () => {
      const clean = dim(computeSiteHealth({ workflow: workflow() }), "workflow-rule-references");
      expect(clean).toMatchObject({ available: true, score: 100, pillar: "workflows" });

      const broken = dim(
        computeSiteHealth({ workflow: rules({ brokenRules: 9, brokenProperties: 3 }) }),
        "workflow-rule-references",
      );
      expect(broken.score).toBe(0);
      expect(broken.detail).toMatch(/12 workflow rules or properties name/);
      expect(broken.action).toMatch(/Rules view/);
    });

    test("are unavailable, not clean, when the snapshot predates rule capture", () => {
      const health = computeSiteHealth({ workflow: workflow({ ruleIntegrity: { available: false } }) });
      for (const key of ["workflow-rule-references", "inactive-workflows"]) {
        expect(dim(health, key)).toMatchObject({ available: false, score: null });
        expect(dim(health, key).reason).toMatch(/rebuild the workflow inventory/i);
      }
    });

    test("judge inactivity among company-managed workflows only", () => {
      // 100 company-managed (120 - 20 team-managed); 25 inactive = the tolerance, so it bottoms out.
      const d = dim(computeSiteHealth({ workflow: rules({ inactive: 25 }) }), "inactive-workflows");
      expect(d.detail).toMatch(/25 of 100 company-managed/);
      expect(d.score).toBe(0);
      expect(d.weight).toBe(0.5);
    });
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
        fieldUsage: fieldUsage(),
        workflow: workflow(),
        projects: projects(),
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
      const health = computeSiteHealth({
        automation: automation({ ruleCount: 100, disabledCount: 10, noActionCount: 5 }),
      });
      expect(dim(health, "automation-hygiene").detail).toContain("no actions");
    });

    test("advises action only once the disabled share is worth a decision", () => {
      const few = computeSiteHealth({ automation: automation({ ruleCount: 1000, disabledCount: 50 }) });
      const many = computeSiteHealth({ automation: automation({ ruleCount: 1000, disabledCount: 410 }) });
      expect(dim(few, "automation-hygiene").action).toBeNull();
      expect(dim(many, "automation-hygiene").action).toMatch(/revive or delete/i);
    });

    test("estate-wide rules drive the blast-radius dimension", () => {
      const clean = computeSiteHealth({ automation: automation({ ruleCount: 1000, estateWideCount: 0 }) });
      const concentrated = computeSiteHealth({ automation: automation({ ruleCount: 1000, estateWideCount: 180 }) });
      expect(dim(clean, "automation-blast").score).toBe(100);
      expect(dim(concentrated, "automation-blast").score).toBeLessThan(40);
      expect(dim(concentrated, "automation-blast").detail).toContain("180");
    });

    test("the blast dimension calls out estate-wide rules that also carry a credential", () => {
      const health = computeSiteHealth({
        automation: automation({ ruleCount: 1000, estateWideCount: 40, estateWideCredentialCount: 6 }),
      });
      expect(dim(health, "automation-blast").detail).toMatch(/6 of those also store a credential/);
    });

    test("blast radius reports unavailable on an analysis imported before it was scored", () => {
      // estateWideCount omitted entirely -> the field is undefined, not zero.
      const stale = automation();
      delete stale.estateWideCount;
      const health = computeSiteHealth({ automation: stale });
      expect(dim(health, "automation-blast").available).toBe(false);
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
      statusCount: 400,
      orphanCount: 94,
      unreachableNoRuleCount: 31,
      ruleOnlyStatusCount: 63,
      safeToRemoveCount: 27,
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
      const allHeld = workflow({
        orphanCount: 20,
        unreachableNoRuleCount: 0,
        ruleOnlyStatusCount: 20,
        safeToRemoveCount: 0,
      });
      expect(dim(computeSiteHealth({ workflow: allHeld }), "status-reachability").action).toMatch(
        /held open by an automation rule/,
      );
    });

    // Coverage is a claim about rules. Without an analysis it is unknowable, and scoring it
    // as perfect would be the same false all-clear the credential dimension used to give.
    test("coverage is unavailable, not perfect, when no rules have been read", () => {
      const unchecked = workflow({
        orphanCount: 12,
        automationChecked: false,
        ruleOnlyStatusCount: 0,
        unreachableNoRuleCount: 12,
      });
      const coverage = dim(computeSiteHealth({ workflow: unchecked }), "status-coverage");
      expect(coverage).toMatchObject({ available: false, score: null });
      expect(coverage.reason).toMatch(/no automation analysis/i);
    });

    test("still warns about the blind spot when no analysis has been built", () => {
      const unchecked = workflow({
        orphanCount: 12,
        safeToRemoveCount: 5,
        automationChecked: false,
        unreachableNoRuleCount: 12,
      });
      const reachability = dim(computeSiteHealth({ workflow: unchecked }), "status-reachability");
      expect(reachability.detail).toMatch(/No automation analysis/);
      expect(reachability.action).toMatch(/a rule could still transition into one of these/);
    });

    // An older cached measurement predates the split and carries only orphanCount. It must
    // still score rather than reporting unavailable.
    test("falls back to the whole orphan count on a payload built before the split", () => {
      const legacy = {
        available: true,
        schemeStatusesAvailable: true,
        statusCount: 400,
        orphanCount: 40,
        safeToRemoveCount: 0,
        hasIssueCounts: true,
      };
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
        projects: projects({
          totalProjects: 200,
          overConfiguredCount: 64,
          overConfiguredFloor: 76,
          medianFieldCount: 38,
        }),
      });
      // 64/200 = 32%, past the 25% tolerance. Capped at 8 this was 4% and scored 84.
      expect(dim(health, "project-consistency").score).toBe(0);
      expect(dim(health, "project-consistency").detail).toContain("64 of 200");
    });

    test("names the threshold and the median it was derived from", () => {
      const health = computeSiteHealth({
        projects: projects({ overConfiguredCount: 5, overConfiguredFloor: 76, medianFieldCount: 38 }),
      });
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
      workflow: workflow(),
      projects: projects(),
    });
    const small = computeSiteHealth({
      fieldUsage: fieldUsage({ totalFields: 80, duplicateClusters: 50 }),
      workflow: workflow(),
      projects: projects(),
    });

    const dim = (h) => h.dimensions.find((d) => d.key === "field-naming").score;
    expect(dim(big)).toBeGreaterThan(dim(small));
    expect(dim(small)).toBe(0);
  });

  test("weights high-severity field findings above medium", () => {
    const high = computeSiteHealth({
      fieldUsage: fieldUsage({ findingsBySeverity: { high: 40, medium: 0, low: 0 } }),
      workflow: workflow(),
      projects: projects(),
    });
    const medium = computeSiteHealth({
      fieldUsage: fieldUsage({ findingsBySeverity: { high: 0, medium: 40, low: 0 } }),
      workflow: workflow(),
      projects: projects(),
    });

    const dim = (h) => h.dimensions.find((d) => d.key === "field-governance").score;
    expect(dim(high)).toBeLessThan(dim(medium));
  });

  test("rewards shared schemes, because a bespoke-per-project site cannot standardise", () => {
    const shared = computeSiteHealth({
      fieldUsage: fieldUsage(),
      workflow: workflow({ sharedSchemes: 60 }),
      projects: projects(),
    });
    const bespoke = computeSiteHealth({
      fieldUsage: fieldUsage(),
      workflow: workflow({ sharedSchemes: 2 }),
      projects: projects(),
    });

    const dim = (h) => h.dimensions.find((d) => d.key === "standardisation");
    expect(dim(shared).score).toBeGreaterThan(dim(bespoke).score);
    expect(dim(bespoke).action).toMatch(/single project/i);
  });

  test("standardisation is a v2 'up' target on the shared-scheme ratio, with a directional term", () => {
    // 40 of 80 schemes shared -> ratio 0.50 == target -> level 100.
    const at = computeSiteHealth({ workflow: workflow({ schemeCount: 80, sharedSchemes: 40 }) });
    const d = at.dimensions.find((x) => x.key === "standardisation");
    expect(d.level).toBe(100);
    expect(d.direction).toBe("up");
    expect(d.value).toBeCloseTo(0.5, 5);

    // Slipped from 0.4 to 0.25 since the last scan -> worsening, score below the level.
    const slipped = computeSiteHealth({
      workflow: workflow({ schemeCount: 80, sharedSchemes: 20 }),
      priorValues: { standardisation: 0.4 },
    }).dimensions.find((x) => x.key === "standardisation");
    expect(slipped.trend).toBe("worsening");
    expect(slipped.score).toBeLessThan(slipped.level);
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

  test("reachability is a v2 target, scored only when the workflow inventory can answer it", () => {
    // 8 of 100 unreached -> reachable 0.92. Band 0.95 / 0.60, "up".
    // 100 * (0.92 - 0.60) / (0.95 - 0.60) ≈ 91.
    const d = dim(
      computeSiteHealth({
        screens: screens({ totalScreens: 100, totalOperations: 100, unreachedScreens: 8 }),
      }),
      "screen-reachability",
    );
    expect(d.available).toBe(true);
    expect(d.level).toBe(91);
    expect(d.direction).toBe("up");

    // No unreachedScreens count (null) -> the workflow snapshot did not run -> not scored.
    const noWf = computeSiteHealth({
      screens: screens({ totalScreens: 100, totalOperations: 100, unreachedScreens: null }),
    });
    expect(noWf.dimensions.find((x) => x.key === "screen-reachability")).toBeUndefined();
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

    const dupes = computeSiteHealth({
      issueTypes: issueTypes({ totalTypes: 63, reducibleTypeCount: 6, duplicateTypeGroupCount: 3 }),
    });
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

describe("people dimensions", () => {
  const dim = (health, key) => health.dimensions.find((d) => d.key === key);

  test("scores deactivated licence holders as a rate, weighted above ownership", () => {
    const health = computeSiteHealth({ users: users({ totalUsers: 500, deactivatedUsers: 25 }) });
    // 25/500 = the 0.05 tolerance exactly -> 0.
    expect(dim(health, "user-licence-hygiene").score).toBe(0);
    expect(dim(health, "user-licence-hygiene").weight).toBe(1.5);
    expect(dim(health, "user-licence-hygiene").detail).toMatch(/25 of 500/);
    expect(dim(health, "user-licence-hygiene").action).toMatch(/access group/i);
  });

  test("scores orphaned ownership forgivingly against the owned-artifact total", () => {
    const health = computeSiteHealth({ users: users({ ownedArtifactTotal: 600, orphanedArtifacts: 30 }) });
    // 30/600 = 0.05 against the 0.10 tolerance -> ~50, not bottomed out.
    expect(dim(health, "user-ownership").score).toBeGreaterThan(40);
    expect(dim(health, "user-ownership").score).toBeLessThan(60);
    expect(dim(health, "user-ownership").weight).toBe(1);
    expect(dim(health, "user-ownership").detail).toMatch(/30 of 600/);
  });

  test("a clean roster scores both dimensions at the top", () => {
    const health = computeSiteHealth({ users: users() });
    expect(dim(health, "user-licence-hygiene").score).toBe(100);
    expect(dim(health, "user-ownership").score).toBe(100);
  });

  test("licence hygiene is available even before any ownership data joins", () => {
    const health = computeSiteHealth({ users: users({ ownedArtifactTotal: 0 }) });
    expect(dim(health, "user-licence-hygiene").available).toBe(true);
    expect(dim(health, "user-ownership").available).toBe(false);
    expect(dim(health, "user-ownership").reason).toMatch(/ownership data/i);
  });

  test("marks both people dimensions unavailable when no roster has been built", () => {
    const health = computeSiteHealth({ fieldUsage: fieldUsage() });
    for (const key of ["user-licence-hygiene", "user-ownership"]) {
      expect(dim(health, key).available).toBe(false);
      expect(dim(health, key).reason).toMatch(/no licensed-user roster/i);
    }
  });

  test("the people pillar is weighted 1 and rolls its three dimensions up", () => {
    const health = computeSiteHealth({ users: users({ deactivatedUsers: 40 }) });
    const pillar = health.pillars.find((p) => p.key === "users");
    expect(pillar.total).toBe(3);
    expect(pillar.available).toBe(true);
  });

  // The one dimension in the model with a renewal cost behind it, and the one most able to
  // recommend something irreversible on thin evidence.
  describe("dormant licences", () => {
    test("scores against the accounts actually measured, not the roster", () => {
      // 500 on the roster, 100 the crawl reached, 10 of those idle. The rate is 10/100 --
      // dividing by 500 would report a fifth of the real problem.
      const health = computeSiteHealth({ users: users({ measuredAccounts: 100, dormantAccounts: 10 }) });
      const d = dim(health, "dormant-licences");
      expect(d.available).toBe(true);
      expect(d.detail).toMatch(/10 of 100 measured accounts/);
    });

    test("is unavailable, never zero, when no crawl has measured activity", () => {
      // Scoring this as perfect because nobody has counted is exactly how a seat gets
      // revoked on the strength of a scan that did not look.
      const health = computeSiteHealth({ users: users({ activityMeasured: false, measuredAccounts: 0 }) });
      const d = dim(health, "dormant-licences");
      expect(d.available).toBe(false);
      expect(d.score).toBeNull();
      expect(d.reason).toMatch(/no completed issue crawl/i);
    });

    test("says out loud that a quiet account is not necessarily an unused one", () => {
      const health = computeSiteHealth({ users: users({ measuredAccounts: 100, dormantAccounts: 30 }) });
      expect(dim(health, "dormant-licences").action).toMatch(/confirm before revoking/i);
    });
  });
});

describe("asset dimensions", () => {
  const dim = (health, key) => health.dimensions.find((d) => d.key === key);
  const KEYS = ["asset-schema-hygiene", "asset-type-completeness", "asset-reference-integrity", "asset-type-usage"];

  test("a clean CMDB scores every asset dimension at the top", () => {
    const health = computeSiteHealth({ assets: assets() });
    for (const key of KEYS) expect(dim(health, key).score).toBe(100);
  });

  test("scores dead schemas as a rate against the schema total", () => {
    const health = computeSiteHealth({ assets: assets({ totalSchemas: 20, deadSchemaCount: 4 }) });
    // 4/20 = 0.20 -- the tolerance exactly -> 0.
    expect(dim(health, "asset-schema-hygiene").score).toBe(0);
    expect(dim(health, "asset-schema-hygiene").detail).toMatch(/4 of 20/);
  });

  test("scores bare object types against the concrete-type total, forgivingly", () => {
    const health = computeSiteHealth({ assets: assets({ concreteObjectTypes: 100, bareTypeCount: 15 }) });
    // 15/100 = 0.15 against the 0.30 tolerance -> 50, not bottomed out.
    expect(dim(health, "asset-type-completeness").score).toBe(50);
  });

  test("weights reference integrity above the other two", () => {
    const health = computeSiteHealth({ assets: assets({ referenceAttributeCount: 100, brokenReferenceCount: 10 }) });
    expect(dim(health, "asset-reference-integrity").weight).toBe(1.5);
    // 10/100 = the 0.10 tolerance exactly -> 0.
    expect(dim(health, "asset-reference-integrity").score).toBe(0);
  });

  test("reports every asset dimension not-applicable when Assets is not licensed", () => {
    const health = computeSiteHealth({ assets: { available: false, assetsEnabled: false } });
    for (const key of KEYS) {
      expect(dim(health, key).available).toBe(false);
      expect(dim(health, key).reason).toMatch(/not enabled on this site/i);
    }
    // A pillar with no measurable dimension does not appear as a scored pillar.
    const pillar = health.pillars.find((p) => p.key === "assets");
    expect(pillar.available).toBe(false);
  });

  test("reports every asset dimension unmeasured when no inventory has been built", () => {
    const health = computeSiteHealth({ fieldUsage: fieldUsage() });
    for (const key of KEYS) {
      expect(dim(health, key).available).toBe(false);
      expect(dim(health, key).reason).toMatch(/no assets inventory/i);
    }
  });

  test("reference integrity is unmeasured, not perfect, when there are no reference attributes", () => {
    const health = computeSiteHealth({ assets: assets({ referenceAttributeCount: 0, brokenReferenceCount: 0 }) });
    expect(dim(health, "asset-reference-integrity").available).toBe(false);
    expect(dim(health, "asset-reference-integrity").reason).toMatch(/no object-reference attributes/i);
    // The other two still score.
    expect(dim(health, "asset-schema-hygiene").available).toBe(true);
  });

  test("scores empty object types against the MEASURED total, not every concrete type", () => {
    const health = computeSiteHealth({ assets: assets({ measuredConcreteTypes: 40, emptyObjectTypeCount: 8 }) });
    // 8/40 = 0.20 against the 0.30 tolerance -> not bottomed out.
    expect(dim(health, "asset-type-usage").score).toBeGreaterThan(0);
    expect(dim(health, "asset-type-usage").detail).toMatch(/8 of 40/);
  });

  test("object type usage is unmeasured, not perfect, until the AQL crawl has ever run", () => {
    const health = computeSiteHealth({ assets: assets({ countsMeasured: false, measuredConcreteTypes: 0 }) });
    expect(dim(health, "asset-type-usage").available).toBe(false);
    expect(dim(health, "asset-type-usage").reason).toMatch(/counts have never been crawled/i);
    // The structural dimensions do not depend on it.
    expect(dim(health, "asset-schema-hygiene").available).toBe(true);
  });

  test("the assets pillar is weighted 1 and rolls its dimensions up", () => {
    const health = computeSiteHealth({ assets: assets({ deadSchemaCount: 3 }) });
    const pillar = health.pillars.find((p) => p.key === "assets");
    expect(pillar.total).toBe(4);
    expect(pillar.available).toBe(true);
  });
});

describe("access dimensions", () => {
  const dim = (health, key) => health.dimensions.find((d) => d.key === key);

  test("a clean access config scores every dimension at the top", () => {
    const health = computeSiteHealth({
      permissions: permissions(),
      security: security(),
      notifications: notifications(),
    });
    for (const key of [
      "permission-least-privilege",
      "permission-scheme-sprawl",
      "security-level-integrity",
      "security-scheme-sprawl",
      "notification-routing",
      "notification-scheme-sprawl",
    ]) {
      expect(dim(health, key).score).toBe(100);
    }
  });

  test("least privilege is a v2 target: scored against a conformance band, weighted by blast", () => {
    // 7 of 10 schemes clean -> conformance 0.70. Band is target 0.90, floor 0.50, "up".
    // 100 * (0.70 - 0.50) / (0.90 - 0.50) = 50.
    const d = dim(
      computeSiteHealth({ permissions: permissions({ totalSchemes: 10, riskySchemeCount: 3 }) }),
      "permission-least-privilege",
    );
    expect(d.level).toBe(50);
    expect(d.score).toBe(50); // no prior -> no directional term
    expect(d.value).toBeCloseTo(0.7, 5);
    expect(d.direction).toBe("up");
    expect(d.baseWeight).toBe(1.5);
    // Weight is base × blast multiplier (0.5..2.0), so it exceeds the base once the
    // dimension touches a meaningful share of the estate.
    expect(d.weight).toBeGreaterThan(1.5);
    expect(d.blastMultiplier).toBeGreaterThan(1);
  });

  test("least privilege at conformance floor scores 0, at target scores 100", () => {
    expect(
      dim(
        computeSiteHealth({ permissions: permissions({ totalSchemes: 10, riskySchemeCount: 5 }) }),
        "permission-least-privilege",
      ).level,
    ).toBe(0);
    expect(
      dim(
        computeSiteHealth({ permissions: permissions({ totalSchemes: 10, riskySchemeCount: 1 }) }),
        "permission-least-privilege",
      ).level,
    ).toBe(100);
  });

  test("least privilege folds in a small penalty when conformance slipped since the last scan", () => {
    const base = { permissions: permissions({ totalSchemes: 10, riskySchemeCount: 3 }) }; // value 0.70, level 50
    const steady = dim(
      computeSiteHealth({ ...base, priorValues: { "permission-least-privilege": 0.7 } }),
      "permission-least-privilege",
    );
    const slipped = dim(
      computeSiteHealth({ ...base, priorValues: { "permission-least-privilege": 0.85 } }),
      "permission-least-privilege",
    );
    expect(steady.score).toBe(50);
    expect(slipped.score).toBeLessThan(50);
    expect(slipped.trend).toBe("worsening");
  });

  test("security level integrity is a v2 target: integrity rate against the 0.95 / 0.70 band", () => {
    // 17 of 20 levels intact -> integrity 0.85. 100 * (0.85 - 0.70) / (0.95 - 0.70) = 60.
    const d = dim(
      computeSiteHealth({ security: security({ totalLevels: 20, brokenLevelCount: 3 }) }),
      "security-level-integrity",
    );
    expect(d.level).toBe(60);
    expect(d.value).toBeCloseTo(0.85, 5);
    expect(d.direction).toBe("up");
    // 6 of 20 broken -> integrity 0.70 == floor -> 0.
    expect(
      dim(
        computeSiteHealth({ security: security({ totalLevels: 20, brokenLevelCount: 6 }) }),
        "security-level-integrity",
      ).level,
    ).toBe(0);
  });

  test("the three access pillars roll up six, four and four dimensions", () => {
    const health = computeSiteHealth({
      permissions: permissions({ riskySchemeCount: 1 }),
      security: security(),
      notifications: notifications(),
    });
    expect(health.pillars.find((p) => p.key === "permissions").total).toBe(6);
    expect(health.pillars.find((p) => p.key === "security").total).toBe(4);
    expect(health.pillars.find((p) => p.key === "notifications").total).toBe(4);
  });

  test("all six dimensions are unmeasured until an access inventory exists", () => {
    const health = computeSiteHealth({ fieldUsage: fieldUsage() });
    for (const key of ["permission-least-privilege", "security-level-integrity", "notification-routing"]) {
      expect(dim(health, key).available).toBe(false);
      expect(dim(health, key).reason).toMatch(/no access inventory/i);
    }
  });
});

describe("project-role dimensions", () => {
  const dim = (health, key) => health.dimensions.find((d) => d.key === key);

  test("clean role coverage scores both dimensions at the top", () => {
    const health = computeSiteHealth({ roles: roles() });
    expect(dim(health, "role-admin-coverage").score).toBe(100);
    expect(dim(health, "role-actor-hygiene").score).toBe(100);
  });

  test("admin coverage is a v2 target: the covered-project rate against the 0.95 / 0.60 band", () => {
    // 45 of 50 covered -> 0.90. 100 * (0.90 - 0.60) / (0.95 - 0.60) ≈ 86.
    const d = dim(
      computeSiteHealth({ roles: roles({ projectsWithRoles: 50, projectsMissingAdminActorCount: 5 }) }),
      "role-admin-coverage",
    );
    expect(d.level).toBe(86);
    expect(d.value).toBeCloseTo(0.9, 5);
    expect(d.direction).toBe("up");
    expect(d.baseWeight).toBe(1.5);
    // 25 of 50 missing -> coverage 0.50, below the 0.60 floor -> 0.
    expect(
      dim(
        computeSiteHealth({ roles: roles({ projectsWithRoles: 50, projectsMissingAdminActorCount: 25 }) }),
        "role-admin-coverage",
      ).level,
    ).toBe(0);
    expect(
      computeSiteHealth({ roles: roles({ projectsWithRoles: 50 }) }).pillars.find((p) => p.key === "roles").total,
    ).toBe(4);
  });

  test("both dimensions are unmeasured until the access inventory exists", () => {
    const health = computeSiteHealth({ fieldUsage: fieldUsage() });
    for (const key of ["role-admin-coverage", "role-actor-hygiene"]) {
      expect(dim(health, key).available).toBe(false);
    }
  });
});

describe("estate dimensions", () => {
  const dim = (health, key) => health.dimensions.find((d) => d.key === key);

  test("a clean value-list config scores both naming dimensions at the top", () => {
    const health = computeSiteHealth({ estate: estate() });
    expect(dim(health, "resolution-naming").score).toBe(100);
    expect(dim(health, "priority-naming").score).toBe(100);
  });

  test("resolution naming scores reducible resolutions over the list size", () => {
    const health = computeSiteHealth({ estate: estate({ totalResolutions: 20, reducibleResolutionCount: 3 }) });
    // 3/20 = 0.15 = the tolerance -> 0.
    expect(dim(health, "resolution-naming").score).toBe(0);
    expect(health.pillars.find((p) => p.key === "estate").total).toBe(5);
  });

  test("both dimensions are unmeasured until the inventory exists", () => {
    const health = computeSiteHealth({ fieldUsage: fieldUsage() });
    for (const key of ["resolution-naming", "priority-naming"]) {
      expect(dim(health, key).available).toBe(false);
      expect(dim(health, key).reason).toMatch(/no priorities\/resolutions inventory/i);
    }
  });
});

describe("drift dimensions", () => {
  const dim = (health, key) => health.dimensions.find((d) => d.key === key);

  test("no changes in the window scores at the top", () => {
    const health = computeSiteHealth({ drift: drift() });
    expect(dim(health, "config-churn").score).toBe(100);
    expect(health.pillars.find((p) => p.key === "drift").total).toBe(1);
  });

  test("scores the churn rate over the tracked entity count, not a raw count", () => {
    // 100/500 = 0.20 = the tolerance -> 0.
    const health = computeSiteHealth({ drift: drift({ trackedEntities: 500, changesInWindow: 100 }) });
    expect(dim(health, "config-churn").score).toBe(0);
  });

  test("unmeasured until a drift pass has run and the tracked estate is non-empty", () => {
    const health = computeSiteHealth({ fieldUsage: fieldUsage() });
    expect(dim(health, "config-churn").available).toBe(false);
    expect(dim(health, "config-churn").reason).toMatch(/no drift snapshot/i);
  });
});

describe("board dimensions", () => {
  const dim = (health, key) => health.dimensions.find((d) => d.key === key);

  test("a clean board estate scores both dimensions at the top", () => {
    const health = computeSiteHealth({ boards: boards() });
    expect(dim(health, "board-backing").score).toBe(100);
    expect(dim(health, "board-columns").score).toBe(100);
    expect(health.pillars.find((p) => p.key === "boards").total).toBe(2);
  });

  test("backing is a v2 target: integrity of broken + inactive-owner boards against the band", () => {
    // (2 broken + 1 inactive owner) / 30 -> integrity 0.90. Band target 0.98, floor 0.75, "up".
    // 100 * (0.90 - 0.75) / (0.98 - 0.75) = 65.
    const d = dim(
      computeSiteHealth({ boards: boards({ total: 30, brokenBackingCount: 2, inactiveFilterOwner: 1 }) }),
      "board-backing",
    );
    expect(d.level).toBe(65);
    expect(d.value).toBeCloseTo(0.9, 5);
    expect(d.pillar).toBe("boards");
    expect(d.direction).toBe("up");
  });

  test("backing at the integrity floor scores 0", () => {
    // 8 of 30 broken -> integrity 0.733, below the 0.75 floor.
    expect(
      dim(computeSiteHealth({ boards: boards({ total: 30, brokenBackingCount: 8 }) }), "board-backing").level,
    ).toBe(0);
  });

  test("columns scores stale and unmapped boards against the softer bound", () => {
    const health = computeSiteHealth({ boards: boards({ total: 40, staleColumnBoards: 2, unmappedColumnBoards: 3 }) });
    // 5/40 = 0.125, half the 0.25 tolerance -> ~50.
    expect(dim(health, "board-columns").score).toBeGreaterThan(40);
    expect(dim(health, "board-columns").score).toBeLessThan(60);
  });

  test("rates are over readable boards; unreadable ones are left out, not counted clean", () => {
    // 3 broken of 30 boards, but only 10 could be read -> integrity 0.70, below the floor.
    // Counting the 20 unread boards as clean would have scored 0.90.
    const d = dim(
      computeSiteHealth({ boards: boards({ total: 30, readable: 10, unreadable: 20, brokenBackingCount: 3 }) }),
      "board-backing",
    );
    expect(d.value).toBeCloseTo(0.7, 5);
    expect(d.detail).toMatch(/20 more could not be read/);
  });

  test("a board estate nobody could read is unmeasured, not perfect", () => {
    const health = computeSiteHealth({ boards: boards({ total: 12, readable: 0, unreadable: 12 }) });
    for (const key of ["board-backing", "board-columns"]) {
      expect(dim(health, key).available).toBe(false);
      expect(dim(health, key).reason).toMatch(/could be read/i);
    }
  });

  test("both are unmeasured until the inventory exists", () => {
    const health = computeSiteHealth({ fieldUsage: fieldUsage() });
    for (const key of ["board-backing", "board-columns"]) {
      expect(dim(health, key).available).toBe(false);
      expect(dim(health, key).reason).toMatch(/no board inventory/i);
    }
  });

  test("boards carry the structural pillar weight, 1", () => {
    const health = computeSiteHealth({ boards: boards({ total: 30, brokenBackingCount: 30 }) });
    // A wholly broken board estate drags the score but not as hard as automation would.
    // board-backing is a v2 target now: its base weight is 1.5, scaled by blast radius.
    expect(dim(health, "board-backing").baseWeight).toBe(1.5);
    expect(dim(health, "board-backing").weight).toBeGreaterThanOrEqual(1.5);
    expect(dim(health, "board-columns").weight).toBe(1);
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
      fieldUsage: fieldUsage(),
      workflow: workflow(),
      projects: projects(),
      automation: automation(),
      screens: screens(),
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
      automation: automation({
        ruleCount: 100,
        credentialRuleCount: 2,
        selfTriggeringCount: 0,
        externalHttpCount: 0,
        disabledCount: 0,
      }),
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

    const workflowDims = health.dimensions.filter(
      (d) => d.key.startsWith("status") || d.key === "workflow-structure" || d.key === "standardisation",
    );
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
  test.each([
    [95, "A"],
    [85, "B"],
    [75, "C"],
    [65, "D"],
    [20, "E"],
  ])("%i maps to %s", (score, grade) => {
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

  test.each([[0], [-1], [NaN], ["0.2"], [null]])("falls back to the default rather than accepting %p", (bad) => {
    expect(resolveHealthTolerances({ credentialRules: bad }).credentialRules).toBe(
      DEFAULT_HEALTH_TOLERANCES.credentialRules,
    );
  });
});

describe("computeSiteHealth tolerance tuning", () => {
  // A site knowingly running self-triggering rules under guard conditions was permanently
  // marked down for a decision it had already made. Raising the tolerance must move the score.
  test("a looser tolerance scores the same estate higher", () => {
    const automation = {
      available: true,
      ruleCount: 100,
      selfTriggeringTotal: 10,
      disabledCount: 0,
      credentialRuleCount: 0,
    };
    const strict = computeSiteHealth({ automation, tolerances: { selfTriggeringRules: 0.1 } });
    const loose = computeSiteHealth({ automation, tolerances: { selfTriggeringRules: 0.5 } });

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
    const health = computeSiteHealth({
      adoption: adoption({ judgeableProjects: 180, fellOffCount: 22, neverAdoptedCount: 9 }),
    });
    // 31/180 = 17%, against a 25% tolerance.
    expect(dim(health).score).toBe(31);
    expect(dim(health).detail).toMatch(
      /22 projects have fallen well below their own historical rate and 9 never took off/,
    );
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
    expect(pillar.dimensions.map((d) => d.key).sort()).toEqual([
      "project-activity",
      "project-adoption",
      "project-consistency",
    ]);
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
      dashboards: dashboards({
        total: 200,
        orphanedCount: 20,
        editableByEveryoneCount: 50,
        publishedUnusedCount: 70,
        emptyCount: 30,
      }),
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
    expect(dim(health, "dashboard-ownership").weight).toBeGreaterThan(dim(health, "dashboard-exposure").weight);

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
      "dashboard-adoption",
      "dashboard-content",
      "dashboard-exposure",
      "dashboard-gadget-filters",
      "dashboard-ownership",
      "dashboard-public",
    ]);
  });
});

describe("gadget filters", () => {
  const dim = (health, key) => health.dimensions.find((d) => d.key === key);

  test("scores dashboards with a broken gadget against those whose gadget filters were probed", () => {
    const d = dim(
      computeSiteHealth({ dashboards: dashboards({ filterGadgetDashboards: 40, brokenGadgetCount: 2 }) }),
      "dashboard-gadget-filters",
    );
    expect(d).toMatchObject({ available: true, score: 0 });
    expect(d.detail).toMatch(/2 of 40 dashboards with filter gadgets/);
  });

  test("a snapshot from before the probe is unavailable, not clean", () => {
    const d = dim(
      computeSiteHealth({ dashboards: dashboards({ filterGadgetDashboards: 0 }) }),
      "dashboard-gadget-filters",
    );
    expect(d).toMatchObject({ available: false, score: null });
    expect(d.reason).toMatch(/Rebuild the dashboard inventory/);
  });
});

describe("public exposure", () => {
  const dim = (health, key) => health.dimensions.find((d) => d.key === key);

  test("a public filter or dashboard scores apart from, and harder than, a logged-in share", () => {
    const health = computeSiteHealth({
      filters: filters({ total: 100, sharedWithEveryoneCount: 2, sharedPubliclyCount: 2 }),
      dashboards: dashboards({ total: 100, sharedPubliclyCount: 2 }),
    });
    expect(dim(health, "filter-public")).toMatchObject({ score: 0, weight: 1.5 });
    expect(dim(health, "filter-exposure").score).toBeGreaterThan(50);
    expect(dim(health, "filter-public").detail).toBe("2 of 100 filters are shared publicly.");
    expect(dim(health, "dashboard-public").score).toBe(0);
  });

  test("none public is a clean score, not an unmeasured one", () => {
    const health = computeSiteHealth({ filters: filters({ total: 10, sharedPubliclyCount: 0 }) });
    expect(dim(health, "filter-public")).toMatchObject({ available: true, score: 100 });
  });
});

// The same split, on the pillar where a failure is least visible. A dashboard breaking is
// obvious the moment somebody opens it; a filter returns the wrong answer in silence.
describe("filter rules", () => {
  const dim = (health, key) => health.dimensions.find((d) => d.key === key);

  test("scores each failure against its own bound", () => {
    const health = computeSiteHealth({
      filters: filters({
        total: 400,
        orphanedCount: 20,
        sharedWithEveryoneCount: 80,
        subscribedButUnusedCount: 40,
        brokenProjectCount: 20,
      }),
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
      "filter-exposure",
      "filter-ownership",
      "filter-public",
      "filter-scope",
      "filter-subscriptions",
    ]);
  });
});

// What a pillar is worth no longer depends on how many rules somebody wrote for it.
describe("pillar weighting", () => {
  test("adding rules to a pillar does not change what that pillar is worth", () => {
    // A site perfect everywhere except dashboards, which are at their worst.
    const bad = computeSiteHealth({
      fieldUsage: fieldUsage(),
      workflow: workflow(),
      projects: projects(),
      automation: automation(),
      screens: screens(),
      adoption: adoption(),
      filters: filters(),
      dashboards: dashboards({
        total: 100,
        orphanedCount: 100,
        editableByEveryoneCount: 100,
        sharedPubliclyCount: 100,
        brokenGadgetCount: 100,
        filterGadgetDashboards: 100,
        publishedUnusedCount: 100,
        emptyCount: 100,
      }),
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
      fieldUsage: fieldUsage(),
      workflow: workflow(),
      projects: projects(),
      automation: automation(),
      screens: screens(),
      adoption: adoption(),
      filters: filters(),
    });

    // A site with no dashboard inventory is not a site with bad dashboards.
    expect(withoutDashboards.score).toBeGreaterThanOrEqual(90);
  });
});

// Two findings no single pillar can produce: the screen inventory crossed with where field
// values actually exist. They are scored separately rather than averaged because they are
// opposite in kind -- one makes a field HARDER to remove, the other is a cost paid by
// everyone who files an issue.
describe("the screen cross-signal dimensions", () => {
  const dim = (health, key) => health.dimensions.find((d) => d.key === key);
  const run = (over) => computeSiteHealth({ screens: screens(), screenCross: screenCross(over) });

  test("a clean cross scores both at the top", () => {
    const health = run();
    expect(dim(health, "invisible-data").score).toBe(100);
    expect(dim(health, "form-clutter").score).toBe(100);
  });

  test("invisible data is scored against populated fields, not the whole catalogue", () => {
    // A site with 700 fields and 120 populated ones has 120 chances to be wrong here.
    // Dividing by the catalogue would report every estate as spotless.
    const health = run({
      populatedFieldCount: 120,
      counts: {
        invisibleFields: 6,
        invisibleIssues: 4000,
        clutterFields: 0,
        clutterPlacements: 0,
        unreachableFields: 0,
      },
    });
    const d = dim(health, "invisible-data");

    expect(d.score).toBeLessThan(100);
    expect(d.detail).toMatch(/4000 issues/);
    // The wording has to fight the reader's instinct that "not on a screen" means unused.
    expect(d.action).toMatch(/harder to remove safely than an unused field/i);
  });

  test("form clutter is scored per placement, not per field", () => {
    // The same field on ten create screens is ten filing experiences carrying it. A
    // field-count rate would make a widely-placed offender look like a single-form one.
    const wide = run({
      createPlacements: 900,
      counts: {
        clutterPlacements: 300,
        clutterFields: 3,
        invisibleFields: 0,
        invisibleIssues: 0,
        unreachableFields: 0,
      },
    });
    const narrow = run({
      createPlacements: 900,
      counts: { clutterPlacements: 3, clutterFields: 3, invisibleFields: 0, invisibleIssues: 0, unreachableFields: 0 },
    });

    expect(dim(wide, "form-clutter").score).toBeLessThan(dim(narrow, "form-clutter").score);
  });

  test("invisible data is graded far more harshly than form clutter", () => {
    // Same rate, different consequence: one is an integration nobody can see, the other is
    // an optional field somebody skips.
    const invisible = run({
      populatedFieldCount: 100,
      counts: {
        invisibleFields: 10,
        invisibleIssues: 10,
        clutterFields: 0,
        clutterPlacements: 0,
        unreachableFields: 0,
      },
    });
    const clutter = run({
      createPlacements: 100,
      counts: { clutterPlacements: 10, clutterFields: 1, invisibleFields: 0, invisibleIssues: 0, unreachableFields: 0 },
    });

    expect(dim(invisible, "invisible-data").score).toBeLessThan(dim(clutter, "form-clutter").score);
  });

  // Withheld clutter is unmeasured, not clean. Scoring it 100 would reward the very read
  // failure that once flagged Summary as never filled on 135 screens.
  test("form clutter is unavailable when no placement could be judged", () => {
    const withheld = run({ clutterAvailable: false, createPlacements: 0 });
    expect(dim(withheld, "form-clutter").available).toBe(false);
    expect(dim(withheld, "form-clutter").score).toBeNull();
    // Invisible data stands on its own read.
    expect(dim(withheld, "invisible-data").available).toBe(true);

    // A stored summary carries no flag; zero judged placements is the signal there.
    expect(dim(run({ createPlacements: 0 }), "form-clutter").available).toBe(false);
  });

  test("both are unavailable, not zero, when the cross has not been computed", () => {
    // Unavailable is excluded from the mean. Zero would mark a site down for a join nobody
    // has run yet, which is the exact failure the whole model is built to avoid.
    const health = computeSiteHealth({ screens: screens() });
    for (const key of ["invisible-data", "form-clutter"]) {
      expect(dim(health, key).available).toBe(false);
      expect(dim(health, key).score).toBeNull();
    }
  });

  test("carries the reason forward when the cross was suppressed", () => {
    const health = computeSiteHealth({
      screens: screens(),
      screenCross: { available: false, reason: "No project's screen chain resolved completely in the last build." },
    });
    expect(dim(health, "invisible-data").reason).toMatch(/no project's screen chain resolved/i);
  });
});

// The checks added to the thin pillars on 14 Oct 2026: permissions, issue security,
// notifications, project roles, priorities and resolutions. Each is a rate against a tolerance
// over counts the access and estate builds already computed.
describe("thin-pillar checks", () => {
  const dim = (health, key) => health.dimensions.find((d) => d.key === key);

  test("public access scores schemes open to anonymous users, tightly", () => {
    // 1 of 50 = 0.02 = the tolerance -> 0. 0 of 50 -> 100.
    expect(
      dim(
        computeSiteHealth({ permissions: permissions({ totalSchemes: 50, publicSchemeCount: 1 }) }),
        "permission-public-access",
      ).score,
    ).toBe(0);
    const clean = dim(
      computeSiteHealth({ permissions: permissions({ totalSchemes: 50 }) }),
      "permission-public-access",
    );
    expect(clean.score).toBe(100);
    expect(clean.weight).toBe(1.5);
  });

  test("sensitive grants to everyone, and grants to individuals, score their own rates", () => {
    // 2 of 40 = 0.05, half the 0.10 tolerance -> 50.
    expect(
      dim(
        computeSiteHealth({ permissions: permissions({ totalSchemes: 40, loggedInSensitiveSchemeCount: 2 }) }),
        "permission-everyone-sensitive",
      ).score,
    ).toBe(50);
    // 5 of 100 grants name a person: 0.05 of a 0.10 tolerance -> 50.
    const direct = dim(
      computeSiteHealth({ permissions: permissions({ totalGrantCount: 100, directUserGrantCount: 5 }) }),
      "permission-direct-grants",
    );
    expect(direct.score).toBe(50);
    expect(direct.detail).toMatch(/5 of 100 permission grants name an individual/);
  });

  test("a scheme with no grants at all reads as clean, never as 0/0", () => {
    const d = dim(
      computeSiteHealth({ permissions: permissions({ totalGrantCount: 0, directUserGrantCount: 0 }) }),
      "permission-direct-grants",
    );
    expect(d.score).toBe(100);
  });

  test("departed-account checks are unmeasured without the People roster", () => {
    const health = computeSiteHealth({
      permissions: permissions({ rosterMeasured: false, directUserGrantCount: 3, offRosterUserGrantCount: 3 }),
      security: security({ rosterMeasured: false }),
      notifications: notifications({ rosterMeasured: false }),
      roles: roles({ rosterMeasured: false, offRosterActorCount: 20 }),
    });
    for (const key of [
      "permission-departed-grants",
      "security-departed-members",
      "notification-departed-recipients",
      "role-actor-hygiene",
    ]) {
      expect(dim(health, key).available).toBe(false);
      expect(dim(health, key).reason).toMatch(/People roster/);
    }
  });

  // The Actor hygiene fix: an empty roster used to make every user actor "departed".
  test("actor hygiene still scores when the roster is measured", () => {
    expect(
      dim(computeSiteHealth({ roles: roles({ rosterMeasured: true, offRosterActorCount: 0 }) }), "role-actor-hygiene")
        .score,
    ).toBe(100);
  });

  test("departed accounts score against the individuals they are drawn from", () => {
    // 1 of 100 named grants is a departed account: 0.01 of the 0.02 tolerance -> 50.
    expect(
      dim(
        computeSiteHealth({ permissions: permissions({ directUserGrantCount: 100, offRosterUserGrantCount: 1 }) }),
        "permission-departed-grants",
      ).score,
    ).toBe(50);
    expect(
      dim(
        computeSiteHealth({ security: security({ userMemberCount: 50, offRosterMemberCount: 1 }) }),
        "security-departed-members",
      ).score,
    ).toBe(0);
    const notif = dim(
      computeSiteHealth({ notifications: notifications({ namedUserRecipientCount: 200, offRosterRecipientCount: 2 }) }),
      "notification-departed-recipients",
    );
    expect(notif.score).toBe(50);
    expect(notif.detail).toMatch(/2 notification recipients are accounts no longer on the licensed roster/);
  });

  test("security levels held by individuals score member share", () => {
    // 5 of 40 members are people: 0.125 of a 0.25 tolerance -> 50.
    expect(
      dim(
        computeSiteHealth({ security: security({ totalMemberCount: 40, userMemberCount: 5 }) }),
        "security-direct-members",
      ).score,
    ).toBe(50);
  });

  test("raw email recipients are weighted as exposure", () => {
    const d = dim(
      computeSiteHealth({ notifications: notifications({ totalRecipientCount: 100, emailRecipientCount: 1 }) }),
      "notification-external-email",
    );
    expect(d.score).toBe(50);
    expect(d.weight).toBe(1.5);
    expect(d.action).toMatch(/group or project role/);
  });

  test("roles held by individuals and roles nobody holds", () => {
    // 30 of 100 actors are people: 0.30 of a 0.60 tolerance -> 50.
    expect(
      dim(computeSiteHealth({ roles: roles({ directUserActorCount: 30, groupActorCount: 70 }) }), "role-group-actors")
        .score,
    ).toBe(50);
    // 3 of 20 roles empty: 0.15 of a 0.30 tolerance -> 50.
    const unused = dim(computeSiteHealth({ roles: roles({ totalRoles: 20, emptyRoleCount: 3 }) }), "role-unused");
    expect(unused.score).toBe(50);
    expect(unused.detail).toMatch(/3 of 20 project roles have no user or group/);
  });

  test("priority and resolution usage need the issue crawl, and score unused values", () => {
    const unmeasured = computeSiteHealth({ estate: estate({ usageMeasured: false }) });
    expect(dim(unmeasured, "priority-usage").available).toBe(false);
    expect(dim(unmeasured, "resolution-usage").reason).toMatch(/issue crawl/);
    // 3 of 20 priorities unused: 0.15 of a 0.30 tolerance -> 50.
    expect(
      dim(computeSiteHealth({ estate: estate({ totalPriorities: 20, unusedPriorityCount: 3 }) }), "priority-usage")
        .score,
    ).toBe(50);
    expect(
      dim(computeSiteHealth({ estate: estate({ totalResolutions: 10, unusedResolutionCount: 0 }) }), "resolution-usage")
        .score,
    ).toBe(100);
  });

  test("defaults set loses half for each list with no default", () => {
    expect(dim(computeSiteHealth({ estate: estate() }), "estate-defaults").score).toBe(100);
    const one = dim(computeSiteHealth({ estate: estate({ prioritiesWithoutDefault: true }) }), "estate-defaults");
    expect(one.score).toBe(50);
    expect(one.action).toBe("Set a default priority.");
    expect(
      dim(
        computeSiteHealth({ estate: estate({ prioritiesWithoutDefault: true, resolutionsWithoutDefault: true }) }),
        "estate-defaults",
      ).score,
    ).toBe(0);
  });

  test("every new check is unmeasured until its inventory exists", () => {
    const health = computeSiteHealth({});
    for (const key of [
      "permission-public-access",
      "permission-everyone-sensitive",
      "permission-direct-grants",
      "permission-departed-grants",
      "security-direct-members",
      "security-departed-members",
      "notification-external-email",
      "notification-departed-recipients",
      "role-group-actors",
      "role-unused",
      "priority-usage",
      "resolution-usage",
      "estate-defaults",
    ]) {
      expect(dim(health, key)?.available).toBe(false);
    }
  });
});

describe("Jira Service Management dimensions", () => {
  const dim = (health, key) => health.dimensions.find((d) => d.key === key);
  const JSM_KEYS = [
    "rt-visibility",
    "rt-usage",
    "rt-descriptions",
    "rt-naming",
    "queue-integrity",
    "queue-usage",
    "queue-duplicates",
    "sla-breach-rate",
    "sla-usage",
    "org-membership",
    "org-attachment",
  ];

  test("a site with no service desk is not-applicable everywhere, and the pillars drop out", () => {
    const na = { available: false, jsmEnabled: false };
    const health = computeSiteHealth({ requestTypes: na, queues: na, slas: na, customers: na });
    for (const key of JSM_KEYS) {
      expect(dim(health, key)).toMatchObject({ available: false, reason: expect.stringMatching(/no service desks/) });
    }
    for (const p of ["requestTypes", "queues", "slas", "customers"]) {
      expect(health.pillars.find((x) => x.key === p).available).toBe(false);
    }
  });

  test("no snapshot is unmeasured, not clean", () => {
    const health = computeSiteHealth({});
    for (const key of JSM_KEYS) expect(dim(health, key)?.available).toBe(false);
    expect(dim(health, "rt-usage").reason).toMatch(/No Service Management inventory/);
  });

  // A request type whose volume could not be counted is left out, never counted as unused.
  test("rates are over what was measured", () => {
    const health = computeSiteHealth({ requestTypes: jsm.requestTypes({ usageMeasured: 10, unused: 5 }) });
    expect(dim(health, "rt-usage").detail).toBe("5 of 10 measured request types had no request in the last 90 days.");
    const none = computeSiteHealth({ requestTypes: jsm.requestTypes({ usageMeasured: 0 }) });
    expect(dim(none, "rt-usage").available).toBe(false);
  });

  test("a broken queue costs more than an empty one, and both carry an action", () => {
    const broken = dim(computeSiteHealth({ queues: jsm.queues({ broken: 1 }) }), "queue-integrity");
    const empty = dim(computeSiteHealth({ queues: jsm.queues({ empty: 1 }) }), "queue-usage");
    expect(broken.score).toBeLessThan(empty.score);
    expect(broken.action).toMatch(/JQL/);
    expect(dim(computeSiteHealth({ queues: jsm.queues() }), "queue-integrity").action).toBeNull();
  });

  test("the breach rate scores against its tolerance, and the tolerance is tunable", () => {
    const at = (tol) =>
      dim(
        computeSiteHealth({ slas: jsm.slas({ breachedRequests: 125 }), tolerances: { slaBreachRate: tol } }),
        "sla-breach-rate",
      ).score;
    expect(at(0.25)).toBe(0);
    expect(at(0.5)).toBeGreaterThan(0);
  });
});
