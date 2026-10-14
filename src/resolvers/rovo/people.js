// Rovo actions. People expert (observatory-people-expert): search, inspect and a person's footprint.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES } from "../../lib/jira-api.js";
import {
  pillarUnavailable,
  agentOk,
  rankMatches,
  clampResults,
} from "../../lib/rovo-agents.js";
import { getUserInventory, getUserDetails } from "../people.js";

// ── Rovo: people expert ─────────────────────────────────────────────────────
//
// The roster and the ownership / reference graph, over getUserInventory and getUserDetails.

export async function rovoPeopleSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const query = String(payload?.query || "").trim();
    const limit = clampResults(payload?.maxResults, 8, 20);
    if (!query) return { status: "error", message: "A search query is required." };

    const inv = await getUserInventory({ context });
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("people", { state: inv.state, refreshedAt: null });

    const users = rankMatches(inv.users, query, (u) => [u.displayName, u.accountId], limit);
    const groups = new Map();
    for (const u of inv.users) for (const g of u.groups || []) {
      if (!groups.has(g.id)) groups.set(g.id, { id: g.id, name: g.name, memberCount: 0 });
      groups.get(g.id).memberCount += 1;
    }
    const groupMatches = rankMatches([...groups.values()], query, (g) => [g.name, g.id], limit);

    return agentOk(inv.refreshedAt || null, {
      query,
      users: users.map((u) => ({
        accountId: u.accountId, displayName: u.displayName, active: u.active !== false,
        ownedFilters: u.ownedFilters ?? 0, ownedDashboards: u.ownedDashboards ?? 0,
        authoredRules: u.authoredRules ?? 0, automationRefs: u.automationRefs ?? 0,
      })),
      groups: groupMatches,
      rosterSize: inv.users.length,
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoPeopleSearch failed:", error);
    throw error;
  }
}

export async function rovoPeopleInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const accountId = String(payload?.accountId || "").trim();
    if (!accountId) return { status: "error", message: "An accountId is required. Use search first to resolve a name." };
    const details = await getUserDetails({ payload: { accountId }, context });
    if (!details.available) return pillarUnavailable("people", { state: "idle", refreshedAt: null });

    return agentOk(null, {
      accountId,
      inRoster: Boolean(details.inRoster),
      user: {
        displayName: details.user?.displayName || accountId,
        active: details.user?.active ?? null,
        products: details.user?.applications || details.user?.products || [],
        groups: (details.user?.groups || []).map((g) => g.name || g.id),
      },
      ownedFilters: (details.ownedFilters || []).length,
      ownedDashboards: (details.ownedDashboards || []).length,
      authoredRules: (details.authoredRules || []).length,
      referencedInRules: (details.referencedInRules || []).map((r) => ({ id: r.id, name: r.name, direction: r.direction })),
      grantedBySchemes: (details.grantedBySchemes || []).map((s) => ({ scheme: s.schemeName || s.name, family: s.schemeType || s.family, grants: s.permission || s.level || s.eventName || null })),
      fieldAppearances: (details.fieldAppearances || []).map((f) => ({ field: f.fieldName, issueCount: f.issueCount })),
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoPeopleInspect failed:", error);
    throw error;
  }
}

export async function rovoPeopleImpact(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const accountId = String(payload?.accountId || "").trim();
    if (!accountId) return { status: "error", message: "An accountId is required." };
    const details = await getUserDetails({ payload: { accountId }, context });
    if (!details.available) return pillarUnavailable("people", { state: "idle", refreshedAt: null });

    const ownedFilters = (details.ownedFilters || []).length;
    const ownedDashboards = (details.ownedDashboards || []).length;
    const authoredRules = (details.authoredRules || []).length;
    const writeRefs = (details.referencedInRules || []).filter((r) => r.direction === "write");
    const directGrants = (details.grantedBySchemes || []).length;
    // Grants via a group are deduplicated by scheme+context: two groups both granting the
    // same permission on the same scheme is one fact about the account, not two, and
    // counting it twice would make a well-organized site (grants via role-shaped groups)
    // look more exposed than a badly-organized one (the same grant added directly twice).
    const groupGrantKeys = new Set(
      (details.grantedByGroups || []).map((g) => `${g.schemeType}:${g.schemeId}:${g.context}`)
    );
    const groupGrants = groupGrantKeys.size;
    const anything = ownedFilters + ownedDashboards + authoredRules + (details.referencedInRules || []).length + directGrants + groupGrants;

    return agentOk(null, {
      accountId,
      displayName: details.user?.displayName || accountId,
      active: details.user?.active ?? null,
      ownedFilters, ownedDashboards, authoredRules,
      rulesRoutingWorkHere: writeRefs.map((r) => ({ id: r.id, name: r.name })),
      referencedInRuleCount: (details.referencedInRules || []).length,
      directSchemeGrants: directGrants,
      // Most real access runs through a group, not a direct grant -- this was invisible here
      // until now even for an account holding admin purely via group membership.
      groupSchemeGrants: groupGrants,
      grantedViaGroups: [...new Set((details.grantedByGroups || []).map((g) => g.viaGroup))].slice(0, 20),
      verdict: anything === 0 ? "no-cross-pillar-footprint" : "has-footprint",
      verdictCaveat:
        "Deactivating an account leaves its filters, dashboards and rules ownerless (boards and any dashboard on a wall break), any rule that routes work to it stops assigning, " +
        "and any access held through a group membership is what actually changes -- direct grants on the account are rare by design. " +
        "This does not cover board leads, project leads, or app-specific ownership.",
      dataCaveats: {
        automation: details.automationRefsAvailable ? "checked" : "no automation analysis imported",
        access: details.accessGrantsAvailable ? "checked" : "no access snapshot built",
        fields: details.fieldAppearancesAvailable ? "checked" : "no field crawl since this landed",
      },
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoPeopleImpact failed:", error);
    throw error;
  }
}
