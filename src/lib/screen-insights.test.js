import { describe, test, expect } from "vitest";
import {
  findFormClutter,
  findInvisibleData,
  findUnreachableFields,
  indexReachability,
  resolvedProjectIds,
  summarizeScreenFieldCross,
} from "./screen-insights.js";

// The cross-signal rules. Two of the four states it produces are invisible to every other
// part of the app, and one of them -- invisible data -- is a RISK finding derived from an
// absence, which is the most dangerous shape a finding can have: it is manufactured for
// free by any gap in the screen build. Most of what is pinned here is the suppression.

const reach = (projectId, fieldId, ops = {}) => ({
  projectId,
  fieldId,
  onCreate: false,
  onEdit: false,
  onView: false,
  ...ops,
});
const cover = (projectId, screenCount = 3, unresolvedScreens = 0) => ({ projectId, screenCount, unresolvedScreens });
const use = (fieldId, projectId, issueCount, projectKey = `P${projectId}`) => ({
  fieldId,
  projectId,
  projectKey,
  projectName: `Project ${projectId}`,
  issueCount,
});
const fields = new Map([
  ["customfield_9", { name: "Priority Note" }],
  ["customfield_1", { name: "Story Points" }],
  ["customfield_2", { name: "Vendor Ref" }],
  ["customfield_3", { name: "Legacy Code" }],
]);

describe("resolvedProjectIds", () => {
  test("keeps only projects whose whole screen chain was read", () => {
    const resolved = resolvedProjectIds([cover("1"), cover("2", 4, 1), cover("3")]);
    expect([...resolved].sort()).toEqual(["1", "3"]);
  });

  test("excludes a project with no screen chain at all", () => {
    // Zero screens is not "we read them all and there were none" in any useful sense -- the
    // project resolves to no screen scheme, so nothing can be said about what it shows.
    expect(resolvedProjectIds([cover("9", 0, 0)]).has("9")).toBe(false);
  });
});

describe("findInvisibleData", () => {
  const resolved = resolvedProjectIds([cover("1"), cover("2")]);

  test("flags a field holding values in a project whose screens do not show it", () => {
    const reachability = indexReachability([reach("1", "customfield_1", { onView: true })]);
    const result = findInvisibleData({
      usage: [use("customfield_2", "1", 480)],
      reachability,
      resolved,
      fields,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ fieldId: "customfield_2", fieldName: "Vendor Ref", totalIssues: 480 });
    // The projects are named, because "go and look" is the only sane next step.
    expect(result[0].projects[0]).toMatchObject({ projectKey: "P1", issueCount: 480 });
  });

  test("says nothing about a field that IS on a screen there", () => {
    const reachability = indexReachability([reach("1", "customfield_1", { onView: true })]);
    expect(findInvisibleData({ usage: [use("customfield_1", "1", 900)], reachability, resolved, fields })).toEqual([]);
  });

  // The rule that stops this finding being manufactured out of the build's own gaps.
  test("will not report a project whose screen chain was only partly read", () => {
    const partial = resolvedProjectIds([cover("1", 5, 2)]);
    const reachability = indexReachability([reach("1", "customfield_1", { onView: true })]);

    const result = findInvisibleData({
      usage: [use("customfield_2", "1", 480)],
      reachability,
      resolved: partial,
      fields,
    });

    // Without this, a build that missed two screens would invent a risk finding for every
    // field those screens carried.
    expect(result).toEqual([]);
  });

  test("gathers one field across every project it is invisible in, worst first", () => {
    const reachability = indexReachability([reach("1", "customfield_1", { onView: true })]);
    const result = findInvisibleData({
      usage: [use("customfield_2", "1", 40), use("customfield_2", "2", 900)],
      reachability,
      resolved,
      fields,
    });

    expect(result).toHaveLength(1);
    expect(result[0].totalIssues).toBe(940);
    expect(result[0].projects.map((p) => p.issueCount)).toEqual([900, 40]);
  });

  test("ranks by issues at stake, not by project count", () => {
    const reachability = indexReachability([reach("1", "x", { onView: true })]);
    const result = findInvisibleData({
      usage: [use("customfield_1", "1", 5), use("customfield_1", "2", 5), use("customfield_2", "1", 2000)],
      reachability,
      resolved,
      fields,
    });
    expect(result.map((f) => f.fieldId)).toEqual(["customfield_2", "customfield_1"]);
  });
});

describe("findFormClutter", () => {
  const resolved = resolvedProjectIds([cover("1"), cover("2")]);
  // Some other field populated in each project: the crawl has measured both, so a missing
  // pair there means "never filled" rather than "never looked".
  const measured = [use("customfield_9", "1", 10), use("customfield_9", "2", 10)];

  test("flags a field on the create screen that nobody there fills in", () => {
    const reachability = indexReachability([reach("1", "customfield_3", { onCreate: true, onView: true })]);
    const result = findFormClutter({ reachability, usage: measured, resolved, fields });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ fieldId: "customfield_3", fieldName: "Legacy Code", projectCount: 1 });
  });

  test("ignores a field that is only on edit or view", () => {
    // Create is the operation nobody can skip. A field on the view screen costs a glance;
    // one on the create screen costs every person filing, every time.
    const reachability = indexReachability([reach("1", "customfield_3", { onEdit: true, onView: true })]);
    expect(findFormClutter({ reachability, usage: [], resolved, fields })).toEqual([]);
  });

  test("ignores a field people actually fill in there", () => {
    const reachability = indexReachability([reach("1", "customfield_1", { onCreate: true })]);
    expect(findFormClutter({ reachability, usage: [use("customfield_1", "1", 300)], resolved, fields })).toEqual([]);
  });

  // Per project, not site-wide: the remedy differs.
  test("flags only the projects where it is dead weight, not the field everywhere", () => {
    const reachability = indexReachability([
      reach("1", "customfield_1", { onCreate: true }),
      reach("2", "customfield_1", { onCreate: true }),
    ]);
    const result = findFormClutter({
      reachability,
      usage: [...measured, use("customfield_1", "1", 5000)],
      resolved,
      fields,
    });

    expect(result[0].projectCount).toBe(1);
    expect(result[0].projects[0].projectId).toBe("2");
  });

  test("honours a near-zero threshold rather than requiring an exact zero", () => {
    const reachability = indexReachability([reach("1", "customfield_1", { onCreate: true })]);
    const usage = [use("customfield_1", "1", 3)];

    expect(findFormClutter({ reachability, usage, resolved, fields, maxIssues: 0 })).toEqual([]);
    expect(findFormClutter({ reachability, usage, resolved, fields, maxIssues: 10 })).toHaveLength(1);
  });

  test("ranks by how many filing experiences carry the cost", () => {
    const reachability = indexReachability([
      reach("1", "customfield_1", { onCreate: true }),
      reach("1", "customfield_2", { onCreate: true }),
      reach("2", "customfield_2", { onCreate: true }),
    ]);
    const result = findFormClutter({ reachability, usage: measured, resolved, fields });
    expect(result.map((f) => f.fieldId)).toEqual(["customfield_2", "customfield_1"]);
  });

  // The regression: Summary "on 135 create screens, never filled". The crawl never tallies
  // it, so it has no usage row anywhere, and a missing row is not a zero.
  test("never flags a field the crawl does not measure", () => {
    const reachability = indexReachability([reach("1", "summary", { onCreate: true })]);
    const unmeasuredFieldIds = new Set(["summary"]);
    expect(findFormClutter({ reachability, usage: measured, resolved, unmeasuredFieldIds })).toEqual([]);
  });

  test("never flags a field outside the catalog the crawl asked for", () => {
    const reachability = indexReachability([reach("1", "components", { onCreate: true })]);
    expect(findFormClutter({ reachability, usage: measured, resolved, fields })).toEqual([]);
  });

  test("never flags anything in a project the crawl has not measured", () => {
    const reachability = indexReachability([reach("1", "customfield_3", { onCreate: true })]);
    expect(findFormClutter({ reachability, usage: [], resolved, fields })).toEqual([]);
  });

  // The other regression: Requirement Source, Sprint and friends fell off the end of a
  // capped, volume-sorted usage read and every one of their pairs looked unfilled.
  test("reads filled pairs from the complete pair set, not the capped usage rows", () => {
    const reachability = indexReachability([reach("1", "customfield_1", { onCreate: true })]);
    const populatedPairs = new Set(["1|customfield_9", "1|customfield_1"]);
    expect(findFormClutter({ reachability, usage: [], populatedPairs, resolved, fields })).toEqual([]);
  });

  test("will not report a project whose screen chain was only partly read", () => {
    const reachability = indexReachability([reach("1", "customfield_3", { onCreate: true })]);
    expect(
      findFormClutter({ reachability, usage: [], resolved: resolvedProjectIds([cover("1", 5, 1)]), fields }),
    ).toEqual([]);
  });
});

describe("findUnreachableFields", () => {
  test("names fields no project's screens reach anywhere on the site", () => {
    const reachability = indexReachability([reach("1", "customfield_1", { onView: true })]);
    const result = findUnreachableFields({
      reachability,
      fieldIds: ["customfield_1", "customfield_2"],
      fields,
    });
    expect(result.map((f) => f.fieldId)).toEqual(["customfield_2"]);
  });

  test("a field reachable in any one project is not unreachable", () => {
    const reachability = indexReachability([reach("7", "customfield_2", { onEdit: true })]);
    expect(findUnreachableFields({ reachability, fieldIds: ["customfield_2"], fields })).toEqual([]);
  });
});

describe("summarizeScreenFieldCross", () => {
  const base = {
    reachabilityRows: [
      reach("1", "customfield_1", { onCreate: true, onView: true }),
      reach("1", "customfield_3", { onCreate: true }),
      reach("2", "customfield_1", { onView: true }),
    ],
    coverage: [cover("1"), cover("2")],
    usage: [use("customfield_1", "1", 900), use("customfield_2", "2", 480)],
    fieldIds: ["customfield_1", "customfield_2", "customfield_3"],
    fields,
  };

  test("produces all three findings from one pass", () => {
    const result = summarizeScreenFieldCross(base);

    expect(result.available).toBe(true);
    expect(result.counts).toMatchObject({
      invisibleFields: 1, // customfield_2: 480 issues in P2, on no screen there
      invisibleIssues: 480,
      clutterFields: 1, // customfield_3: on P1's create screen, never filled
      clutterPlacements: 1,
      unreachableFields: 1, // customfield_2: on no screen anywhere
    });
  });

  test("withholds form clutter when the usage read was capped and no complete pairs exist", () => {
    const result = summarizeScreenFieldCross({ ...base, usageTruncated: true });
    expect(result.clutterAvailable).toBe(false);
    expect(result.formClutter).toEqual([]);
    expect(result.createPlacements).toBe(0);
    // Invisible data can only understate on a capped read, so it still stands.
    expect(result.counts.invisibleFields).toBe(1);
  });

  test("withholds form clutter when the complete pair read did not complete", () => {
    const result = summarizeScreenFieldCross({ ...base, populatedPairs: new Set(), pairsComplete: false });
    expect(result.clutterAvailable).toBe(false);
    expect(result.formClutter).toEqual([]);
  });

  test("uses complete pairs over a capped usage read", () => {
    const populatedPairs = new Set(["1|customfield_1", "2|customfield_2"]);
    const result = summarizeScreenFieldCross({ ...base, usageTruncated: true, populatedPairs, pairsComplete: true });
    expect(result.clutterAvailable).toBe(true);
    expect(result.counts).toMatchObject({ clutterFields: 1, clutterPlacements: 1 });
    expect(result.createPlacements).toBe(2);
  });

  test("counts only judgeable create placements in the denominator", () => {
    const result = summarizeScreenFieldCross({
      ...base,
      reachabilityRows: [...base.reachabilityRows, reach("1", "summary", { onCreate: true })],
      unmeasuredFieldIds: new Set(["summary"]),
    });
    expect(result.createPlacements).toBe(2);
  });

  test("states how much of the estate the findings were drawn from", () => {
    const result = summarizeScreenFieldCross({ ...base, coverage: [cover("1"), cover("2", 4, 2), cover("3", 2, 1)] });
    expect(result).toMatchObject({ projectsTotal: 3, projectsResolved: 1 });
    expect(result.coverageRate).toBeCloseTo(1 / 3);
  });

  test("suppresses every finding when no project resolved", () => {
    // Computing against a left side this incomplete would report the build's failure as the
    // estate's defect -- the same rule the workflow insights follow on an empty scheme map.
    const result = summarizeScreenFieldCross({ ...base, coverage: [cover("1", 4, 4), cover("2", 3, 1)] });

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/no project's screen chain resolved/i);
    expect(result.invisibleData).toEqual([]);
    expect(result.formClutter).toEqual([]);
  });

  test("distinguishes an unbuilt inventory from a failed one", () => {
    const result = summarizeScreenFieldCross({ reachabilityRows: [], coverage: [], usage: [] });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/no screen inventory has been built/i);
  });

  test("carries a truncated left side through rather than hiding it", () => {
    // Both findings can only UNDERSTATE on a capped usage read, and understating is the
    // direction someone acts on.
    expect(summarizeScreenFieldCross({ ...base, usageTruncated: true }).usageTruncated).toBe(true);
  });
});
