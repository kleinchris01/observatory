import { describe, test, expect } from "vitest";

// Cascades as a graph.
//
// The thing an admin cannot discover by hand in an estate they did not build: Rule 1 wakes
// Rule 2, which wakes Rule 3, which writes the field Rule 1 triggers on. No screen in Jira's
// automation admin shows that, and a flat list of one-hop pairs scatters it across four rows
// among fourteen hundred.

import {
  buildCascadeGraph,
  findStronglyConnectedComponents,
  findCascadeLoops,
  findCascadeChains,
  analyzeCascadeGraph,
} from "./cascade-graph.js";

// Shorthand: "a>b:Status" is rule a writing Status, which rule b triggers on.
const edges = (...specs) => specs.map((spec) => {
  const [pair, field] = spec.split(":");
  const [sourceId, targetId] = pair.split(">");
  return {
    sourceId, targetId, field: field || "Status",
    sourceName: `Rule ${sourceId}`, targetName: `Rule ${targetId}`,
  };
});

describe("buildCascadeGraph", () => {
  test("collapses two rules linked by several fields into one relationship", () => {
    const graph = buildCascadeGraph(edges("a>b:Status", "a>b:Priority", "a>b:Owner"));

    expect(graph.edges.get("a")).toHaveLength(1);
    expect(graph.edges.get("a")[0].fields).toEqual(["Status", "Priority", "Owner"]);
    // Three rows for one relationship is what made the flat list unreadable.
    expect(graph.nodes.get("a").out).toBe(1);
  });

  test("counts in and out degree, which is what identifies an entry point", () => {
    const graph = buildCascadeGraph(edges("a>b", "b>c"));

    expect(graph.nodes.get("a")).toMatchObject({ in: 0, out: 1 });
    expect(graph.nodes.get("b")).toMatchObject({ in: 1, out: 1 });
    expect(graph.nodes.get("c")).toMatchObject({ in: 1, out: 0 });
  });
});

describe("findStronglyConnectedComponents", () => {
  test("groups a cycle into one component and leaves acyclic nodes alone", () => {
    const graph = buildCascadeGraph(edges("a>b", "b>c", "c>a", "c>d"));
    const components = findStronglyConnectedComponents(graph);

    const cycle = components.find((c) => c.length > 1);
    expect(cycle.sort()).toEqual(["a", "b", "c"]);
    expect(components.find((c) => c.length === 1)).toEqual(["d"]);
  });

  // Iterative, not recursive: a long chain would blow the call stack, and the estate that
  // hits that is exactly the one that needs this analysis most.
  test("survives a chain long enough to overflow a recursive implementation", () => {
    const long = Array.from({ length: 5000 }, (_, i) => `${i}>${i + 1}`);
    const graph = buildCascadeGraph(edges(...long));

    expect(() => findStronglyConnectedComponents(graph)).not.toThrow();
    expect(findStronglyConnectedComponents(graph)).toHaveLength(5001);
  });
});

describe("findCascadeLoops", () => {
  // The headline case, and the reason this module exists.
  test("finds a four-rule loop and reports it as a walkable path", () => {
    const loops = findCascadeLoops(buildCascadeGraph(edges("1>2", "2>3", "3>4", "4>1")));

    expect(loops).toHaveLength(1);
    expect(loops[0].size).toBe(4);
    expect(loops[0].ruleIds.sort()).toEqual(["1", "2", "3", "4"]);
    // A path returns to where it started, so it can be traced in the automation admin.
    expect(loops[0].path[0].id).toBe(loops[0].path.at(-1).id);
  });

  test("carries the fields that make each hop, so the link is fixable", () => {
    const loops = findCascadeLoops(buildCascadeGraph(edges("1>2:Owner", "2>1:Status")));
    const fields = loops[0].path.flatMap((s) => s.viaFields);

    expect(fields).toContain("Owner");
    expect(fields).toContain("Status");
  });

  // The same defect at the smallest size. Filtering it into a separate category is what let
  // it hide as a footnote.
  test("reports a self-triggering rule as a loop of one", () => {
    const loops = findCascadeLoops(buildCascadeGraph(edges("a>a:Status")));

    expect(loops).toHaveLength(1);
    expect(loops[0].selfTriggering).toBe(true);
    expect(loops[0].size).toBe(1);
  });

  test("does not invent a loop from a rule that merely has one incoming and one outgoing edge", () => {
    expect(findCascadeLoops(buildCascadeGraph(edges("a>b", "b>c")))).toEqual([]);
  });

  test("finds every independent loop, largest first", () => {
    const loops = findCascadeLoops(buildCascadeGraph(
      edges("1>2", "2>1", "5>6", "6>7", "7>5", "9>10")
    ));

    expect(loops.map((l) => l.size)).toEqual([3, 2]);
  });
});

describe("findCascadeChains", () => {
  test("reports a multi-hop chain from the rule nothing else triggers", () => {
    const { chains } = findCascadeChains(buildCascadeGraph(edges("a>b", "b>c", "c>d")));

    expect(chains).toHaveLength(1);
    expect(chains[0].ruleIds).toEqual(["a", "b", "c", "d"]);
  });

  // One hop is a pair, which the flat list already showed. Repeating it here would bury the
  // chains that are actually new information.
  test("ignores single-hop pairs", () => {
    expect(findCascadeChains(buildCascadeGraph(edges("a>b"))).chains).toEqual([]);
  });

  test("stops at the depth bound rather than running away", () => {
    const long = Array.from({ length: 40 }, (_, i) => `${i}>${i + 1}`);
    const { chains } = findCascadeChains(buildCascadeGraph(edges(...long)), { maxDepth: 5 });

    expect(chains[0].length).toBeLessThanOrEqual(6);
  });

  // A truncated answer presented as complete is worse than a smaller one that says so.
  test("says when it stopped early instead of implying it found everything", () => {
    const wide = [];
    for (let i = 0; i < 60; i++) wide.push(`root>m${i}`, `m${i}>x${i}`, `x${i}>y${i}`);
    const { truncated } = findCascadeChains(buildCascadeGraph(edges(...wide)), { maxChains: 5 });

    expect(truncated).toBe(true);
  });

  test("does not walk into a cycle forever", () => {
    const { chains } = findCascadeChains(buildCascadeGraph(edges("a>b", "b>c", "c>b")));
    expect(chains.every((c) => new Set(c.ruleIds).size === c.ruleIds.length)).toBe(true);
  });
});

describe("analyzeCascadeGraph", () => {
  test("counts each rule caught in a loop once, however many loops touch it", () => {
    const result = analyzeCascadeGraph(edges("1>2", "2>3", "3>1", "1>3"));

    expect(result.rulesInLoops).toBe(3);
    expect(result.loops).toHaveLength(1);
  });

  test("reports an estate with no loops as such rather than as unanalysed", () => {
    const result = analyzeCascadeGraph(edges("a>b", "b>c"));

    expect(result.loops).toEqual([]);
    expect(result.rulesInLoops).toBe(0);
    expect(result.ruleCount).toBe(3);
  });

  test("survives being handed nothing", () => {
    expect(analyzeCascadeGraph()).toMatchObject({ ruleCount: 0, loops: [], rulesInLoops: 0 });
  });
});
