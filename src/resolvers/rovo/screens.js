// Rovo actions. Screen expert (observatory-screen-expert): search, inspect and impact.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES } from "../../lib/jira-api.js";
import { pillarUnavailable, agentOk, agentNotFound, rankMatches, clampResults } from "../../lib/rovo-agents.js";
import { getScreenInventory } from "../screens.js";

// ── Rovo: screen expert ────────────────────────────────────────────────────
//
// Screens, their tabs and fields, and the scheme chain that routes to them, over
// getScreenInventory (which pages screens -- the agent asks for a large page).

export async function rovoScreenSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const query = String(payload?.query || "").trim();
    const kind = String(payload?.kind || "any")
      .trim()
      .toLowerCase();
    const limit = clampResults(payload?.maxResults, 8, 20);
    if (!query) return { status: "error", message: "A search query is required." };

    const inv = await getScreenInventory({
      payload: { pageSize: 100, search: kind === "scheme" ? "" : query },
      context,
    });
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("screens", { state: inv.state, refreshedAt: null });

    const screenRows = kind === "scheme" ? [] : inv.screens?.rows || inv.screens || [];
    const screens = rankMatches(screenRows, query, (s) => [s.name, s.id, s.screenId], limit);
    const schemes = kind === "screen" ? [] : rankMatches(inv.screenSchemes || [], query, (s) => [s.name, s.id], limit);

    return agentOk(inv.refreshedAt || null, {
      query,
      screens: screens.map((s) => ({
        screenId: s.screenId ?? s.id,
        name: s.name,
        fieldCount: s.fieldCount ?? s.totalFields ?? null,
        tabCount: s.tabCount ?? null,
        reachedByProjectCount: s.projectCount ?? s.reachableProjectCount ?? null,
      })),
      screenSchemes: schemes.map((s) => ({ id: s.id, name: s.name })),
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoScreenSearch failed:", error);
    throw error;
  }
}

export async function rovoScreenInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const identifier = String(payload?.identifier || "").trim();
    if (!identifier) return { status: "error", message: "A screen or screen scheme name is required." };
    const inv = await getScreenInventory({ payload: { pageSize: 100, search: identifier }, context });
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("screens", { state: inv.state, refreshedAt: null });
    const idLower = identifier.toLowerCase();

    const scheme = (inv.screenSchemes || []).find(
      (s) => String(s.id) === identifier || String(s.name || "").toLowerCase() === idLower,
    );
    if (scheme) {
      const ops = (inv.schemeOperations || []).filter((o) => String(o.schemeId) === String(scheme.id));
      return agentOk(inv.refreshedAt || null, {
        kind: "scheme",
        scheme: { id: scheme.id, name: scheme.name },
        operations: ops.map((o) => ({
          operation: o.operation,
          screenId: o.screenId,
          screenName: o.screenName || null,
          inherited: Boolean(o.inherited),
        })),
      });
    }

    const rows = inv.screens?.rows || inv.screens || [];
    const screen = rows.find(
      (s) => String(s.screenId ?? s.id) === identifier || String(s.name || "").toLowerCase() === idLower,
    );
    if (!screen)
      return agentNotFound(
        inv.refreshedAt || null,
        `No screen or screen scheme matched "${identifier}" on the current page. Try a more exact name.`,
      );

    return agentOk(inv.refreshedAt || null, {
      kind: "screen",
      screen: {
        screenId: screen.screenId ?? screen.id,
        name: screen.name,
        fieldCount: screen.fieldCount ?? screen.totalFields ?? null,
        tabCount: screen.tabCount ?? null,
        tabs: (screen.tabs || []).map((t) => ({ name: t.name, fieldCount: (t.fields || []).length })),
        findings: screen.findings || null,
        unresolved: Boolean(screen.unresolved),
      },
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoScreenInspect failed:", error);
    throw error;
  }
}

export async function rovoScreenImpact(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const name = String(payload?.name || "").trim();
    if (!name) return { status: "error", message: "A screen name is required." };
    const inv = await getScreenInventory({ payload: { pageSize: 100, search: name }, context });
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("screens", { state: inv.state, refreshedAt: null });

    const rows = inv.screens?.rows || inv.screens || [];
    const screen = rows.find((s) => String(s.name || "").toLowerCase() === name.toLowerCase());
    if (!screen)
      return agentNotFound(inv.refreshedAt || null, `No screen named "${name}" was found on the current page.`);

    const sid = String(screen.screenId ?? screen.id);
    const ops = (inv.schemeOperations || []).filter((o) => String(o.screenId) === sid);
    const schemeIds = new Set(ops.map((o) => String(o.schemeId)));
    const transitions = (inv.transitionScreens || []).filter((t) => String(t.screenId) === sid);

    return agentOk(inv.refreshedAt || null, {
      screen: { screenId: sid, name: screen.name, fieldCount: screen.fieldCount ?? screen.totalFields ?? null },
      routedBySchemeOperations: ops.map((o) => ({ scheme: o.schemeName || o.schemeId, operation: o.operation })),
      routedBySchemeCount: schemeIds.size,
      openedByTransitionCount: transitions.length,
      reachedByProjectCount: screen.projectCount ?? screen.reachableProjectCount ?? null,
      verdict: schemeIds.size === 0 && transitions.length === 0 ? "nothing-routes-to-it" : "routed",
      verdictCaveat:
        "This covers screen scheme operation mappings and workflow transition screens (where the workflow inventory recorded them). Reachability by project depends on the issue-type-screen-scheme chain, which may be partial.",
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoScreenImpact failed:", error);
    throw error;
  }
}
