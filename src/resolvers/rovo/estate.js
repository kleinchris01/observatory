// Rovo actions. Priorities and resolutions expert (observatory-estate-expert).
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES } from "../../lib/jira-api.js";
import {
  pillarUnavailable,
  agentOk,
  rankMatches,
  clampResults,
} from "../../lib/rovo-agents.js";
import { getEstateInventory } from "../estate.js";

// ── Rovo: priorities & resolutions expert ───────────────────────────────────
//
// The two global value lists, over getEstateInventory. Search + inspect only: priority
// schemes (which projects use which list) are not captured, so there is no "impact".

export async function rovoEstateSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const query = String(payload?.query || "").trim();
    const kind = String(payload?.kind || "any").trim().toLowerCase();
    const limit = clampResults(payload?.maxResults, 10, 20);
    if (!query) return { status: "error", message: "A search query is required." };

    const inv = await getEstateInventory({ context });
    if (inv.neverBuilt) return pillarUnavailable("priorities & resolutions", { state: inv.state, refreshedAt: null });

    const resolutions = kind === "priority" ? [] : rankMatches(inv.resolutions, query, (r) => [r.name, r.description], limit);
    const priorities = kind === "resolution" ? [] : rankMatches(inv.priorities, query, (p) => [p.name, p.description], limit);

    return agentOk(inv.refreshedAt || null, {
      query,
      resolutions: resolutions.map((r) => ({ id: r.id, name: r.name, isDefault: Boolean(r.isDefault), description: r.description || null })),
      priorities: priorities.map((p) => ({ id: p.id, name: p.name, isDefault: Boolean(p.isDefault), description: p.description || null })),
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoEstateSearch failed:", error);
    throw error;
  }
}

export async function rovoEstateInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const kind = String(payload?.list || "both").trim().toLowerCase();
    const inv = await getEstateInventory({ context });
    if (inv.neverBuilt) return pillarUnavailable("priorities & resolutions", { state: inv.state, refreshedAt: null });

    const shape = (rows) => ({
      count: rows.length,
      hasDefault: rows.some((r) => r.isDefault),
      values: rows.map((r) => ({ name: r.name, isDefault: Boolean(r.isDefault) })),
    });
    const out = { status: "ok", refreshedAt: inv.refreshedAt || null, findings: inv.governance?.findings || inv.governance || null };
    if (kind !== "priorities") out.resolutions = shape(inv.resolutions || []);
    if (kind !== "resolutions") out.priorities = shape(inv.priorities || []);
    return out;
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoEstateInspect failed:", error);
    throw error;
  }
}
