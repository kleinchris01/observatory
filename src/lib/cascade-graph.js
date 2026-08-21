// Cascades as a graph, not a list of pairs.
//
// findTriggerCascades already finds the edges correctly -- rule A writes a field rule B
// triggers on, and their project scopes overlap. What it returns is a flat list of one-hop
// pairs, which is why a chain of four rules ending back where it started shows up as four
// unrelated rows scattered through 1,461 and the loop is invisible.
//
// That loop is the thing worth finding. It is also the thing that is nearly impossible to
// discover by hand in an estate you did not build: no screen in Jira's automation admin
// shows you that Rule 1 wakes Rule 2, which wakes Rule 3, which writes the field Rule 1
// triggers on.
//
// Pure, like the module it complements: no imports, so it stays usable from the browser
// bundle that builds the analysis at import time.

// Walking every simple path in a dense graph is exponential, and an estate with 1,461 edges
// is dense enough to matter. Every traversal here is bounded, and the bound is reported
// rather than hidden -- a truncated answer presented as a complete one is worse than a
// smaller answer that says so.
export const MAX_CHAIN_DEPTH = 8;
export const MAX_CHAINS = 500;
export const TRAVERSAL_BUDGET = 200000;

export function buildCascadeGraph(cascades = []) {
  const nodes = new Map();
  const edges = new Map();

  const note = (id, name) => {
    if (id == null) return null;
    const key = String(id);
    if (!nodes.has(key)) nodes.set(key, { id: key, name: name || key, out: 0, in: 0 });
    else if (name && nodes.get(key).name === key) nodes.get(key).name = name;
    return key;
  };

  for (const cascade of cascades) {
    const from = note(cascade.sourceId, cascade.sourceName);
    const to = note(cascade.targetId, cascade.targetName);
    if (!from || !to) continue;
    if (!edges.has(from)) edges.set(from, []);
    // One edge per pair, carrying every field that connects them. Two rules linked by three
    // fields are one relationship, not three, and listing it three times is what made the
    // flat view unreadable.
    const existing = edges.get(from).find((e) => e.to === to);
    if (existing) {
      if (cascade.field && !existing.fields.includes(cascade.field)) existing.fields.push(cascade.field);
      continue;
    }
    edges.get(from).push({ to, fields: cascade.field ? [cascade.field] : [] });
    nodes.get(from).out += 1;
    nodes.get(to).in += 1;
  }

  return { nodes, edges };
}

// Tarjan's strongly connected components.
//
// Chosen over "walk until you see a repeat" because it is complete and linear: every cycle
// in the graph lives inside exactly one strongly connected component, so finding the
// components finds every loop without enumerating paths. On a graph this size the naive
// approach either misses loops or never finishes.
//
// Iterative rather than recursive: a chain of 700 rules would blow the stack, and the one
// estate that hits that is exactly the one that needs this most.
export function findStronglyConnectedComponents({ nodes, edges }) {
  let index = 0;
  const indices = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];

  for (const start of nodes.keys()) {
    if (indices.has(start)) continue;

    const work = [{ node: start, edge: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      const { node } = frame;

      if (frame.edge === 0) {
        indices.set(node, index);
        low.set(node, index);
        index += 1;
        stack.push(node);
        onStack.add(node);
      }

      const outgoing = edges.get(node) ?? [];
      if (frame.edge < outgoing.length) {
        const next = outgoing[frame.edge].to;
        frame.edge += 1;
        if (!indices.has(next)) work.push({ node: next, edge: 0 });
        else if (onStack.has(next)) low.set(node, Math.min(low.get(node), indices.get(next)));
        continue;
      }

      if (low.get(node) === indices.get(node)) {
        const component = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          component.push(member);
        } while (member !== node);
        components.push(component);
      }

      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
    }
  }

  return components;
}

// One concrete cycle through a component, for showing a person.
//
// A component says "these five rules can all reach each other", which is true and hard to
// act on. A path -- A -> B -> C -> A -- is the same fact in the form somebody can trace in
// the automation admin and break.
function cycleWithin(component, edges) {
  const members = new Set(component);
  const start = component[0];
  const parent = new Map();
  const stack = [start];
  const seen = new Set([start]);

  // A component of more than one rule wants the cycle THROUGH those rules. A self-edge on
  // any member is a real loop, but it is a loop of one and it is already reported as its own
  // finding -- and taking it here returns "b -> b" for a component of six, which hides the
  // six-rule cycle that is the whole reason this component was reported.
  //
  // Found by wiring this up: on the reference estate the largest loop spans six rules and
  // one of them also triggers itself, so the headline finding rendered as a two-step path
  // while still claiming a size of six.
  const skipSelfEdges = members.size > 1;

  while (stack.length) {
    const node = stack.pop();
    for (const edge of edges.get(node) ?? []) {
      if (!members.has(edge.to)) continue;
      if (skipSelfEdges && edge.to === node) continue;
      if (edge.to === start) {
        const path = [node];
        let cursor = node;
        while (parent.has(cursor)) { cursor = parent.get(cursor); path.push(cursor); }
        return path.reverse().concat(start);
      }
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      parent.set(edge.to, node);
      stack.push(edge.to);
    }
  }
  return [start, start];
}

// Every loop in the estate, largest first.
//
// A self-triggering rule is reported as a loop of one rather than filtered out: it is the
// same defect at the smallest possible size, and separating it into its own category is
// what let it hide as a footnote before.
export function findCascadeLoops(graph) {
  const { nodes, edges } = graph;
  const loops = [];

  for (const component of findStronglyConnectedComponents(graph)) {
    const selfLoop = component.length === 1
      && (edges.get(component[0]) ?? []).some((e) => e.to === component[0]);
    if (component.length === 1 && !selfLoop) continue;

    const path = selfLoop ? [component[0], component[0]] : cycleWithin(component, edges);
    loops.push({
      size: component.length,
      selfTriggering: selfLoop,
      ruleIds: component,
      ruleNames: component.map((id) => nodes.get(id)?.name ?? id),
      // The cycle as a walkable path, with the fields that carry each hop.
      path: path.map((id, i) => {
        const next = path[i + 1];
        const edge = next ? (edges.get(id) ?? []).find((e) => e.to === next) : null;
        return { id, name: nodes.get(id)?.name ?? id, viaFields: edge?.fields ?? [] };
      }),
    });
  }

  return loops.sort((a, b) => b.size - a.size);
}

// Multi-hop chains that are not loops.
//
// Started only from rules nothing else triggers, because those are the entry points an
// admin actually controls -- a chain beginning in the middle is a suffix of one that
// started earlier, and reporting both buries the useful one.
export function findCascadeChains(graph, { maxDepth = MAX_CHAIN_DEPTH, maxChains = MAX_CHAINS } = {}) {
  const { nodes, edges } = graph;
  const roots = [...nodes.values()].filter((n) => n.in === 0 && n.out > 0).map((n) => n.id);
  const chains = [];
  let budget = TRAVERSAL_BUDGET;
  let truncated = false;

  for (const root of roots) {
    const stack = [{ path: [root], visited: new Set([root]) }];
    while (stack.length) {
      if (budget-- <= 0 || chains.length >= maxChains) { truncated = true; stack.length = 0; break; }
      const { path, visited } = stack.pop();
      const outgoing = (edges.get(path[path.length - 1]) ?? []).filter((e) => !visited.has(e.to));

      // A path that cannot continue -- or has hit the depth bound -- is a chain if it took
      // more than one hop. One hop is a pair, which the flat list already showed.
      if (!outgoing.length || path.length > maxDepth) {
        if (path.length > 2) chains.push(path);
        continue;
      }
      for (const edge of outgoing) {
        stack.push({ path: [...path, edge.to], visited: new Set(visited).add(edge.to) });
      }
    }
    if (chains.length >= maxChains) { truncated = true; break; }
  }

  const shaped = chains
    .sort((a, b) => b.length - a.length)
    .slice(0, maxChains)
    .map((path) => ({
      length: path.length,
      ruleIds: path,
      steps: path.map((id, i) => {
        const next = path[i + 1];
        const edge = next ? (edges.get(id) ?? []).find((e) => e.to === next) : null;
        return { id, name: nodes.get(id)?.name ?? id, viaFields: edge?.fields ?? [] };
      }),
    }));

  // Reported, never silent. A truncated answer presented as complete is worse than a
  // smaller one that says what it left out.
  return { chains: shaped, truncated };
}

export function analyzeCascadeGraph(cascades = [], options = {}) {
  const graph = buildCascadeGraph(cascades);
  const loops = findCascadeLoops(graph);
  const { chains, truncated } = findCascadeChains(graph, options);

  return {
    ruleCount: graph.nodes.size,
    edgeCount: [...graph.edges.values()].reduce((n, list) => n + list.length, 0),
    loops,
    chains,
    truncated,
    // The headline an admin needs before any list: how many rules are caught in a loop at
    // all. Counted across components rather than summed per loop, so a rule in one loop is
    // counted once.
    rulesInLoops: new Set(loops.flatMap((l) => l.ruleIds)).size,
    deepestChain: chains.length ? chains[0].length : 0,
  };
}
