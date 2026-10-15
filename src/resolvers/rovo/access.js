// Rovo actions. Access expert (observatory-access-expert): permission, security and notification schemes and roles.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES, getInstallationKey } from "../../lib/jira-api.js";
import { pillarUnavailable, agentOk, agentNotFound, rankMatches, clampResults } from "../../lib/rovo-agents.js";
import { getAccessInventory, loadActiveRoster } from "../access.js";
import { logger, errorContext } from "../../lib/logger.js";

// ── Rovo: access expert ─────────────────────────────────────────────────────
//
// Permission / issue-security / notification schemes and project roles, over
// getAccessInventory. `family` selects which scheme set.

export const ACCESS_FAMILIES = ["permissions", "security", "notifications", "roles"];

export function accessSchemeList(inv, family) {
  if (family && ACCESS_FAMILIES.includes(family)) return { [family]: inv[family]?.schemes || [] };
  return Object.fromEntries(ACCESS_FAMILIES.map((f) => [f, inv[f]?.schemes || []]));
}

export async function rovoAccessSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const query = String(payload?.query || "").trim();
    const family = String(payload?.family || "")
      .trim()
      .toLowerCase();
    const limit = clampResults(payload?.maxResults, 8, 20);
    if (!query) return { status: "error", message: "A search query is required." };

    const inv = await getAccessInventory({ context });
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("access", { state: inv.state, refreshedAt: null });

    const sets = accessSchemeList(inv, family);
    const matches = {};
    for (const [f, schemes] of Object.entries(sets)) {
      matches[f] = rankMatches(schemes, query, (s) => [s.name, s.id, s.description], limit).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description || null,
        projectCount: s.projectCount ?? null,
      }));
    }
    return agentOk(inv.refreshedAt || null, { query, schemes: matches });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    logger.error("rovoAccessSearch.failed", errorContext(error));
    throw error;
  }
}

// One stored holder row, as the access agent reports it. The row carries the grant in
// context/contextLabel (permission key, notification event, security level or project) and
// the holder in holderValue/holderLabel. The agent used to read holderName, permission and
// offRoster, none of which exist on the row, so every grant came back null, nobody was ever
// off-roster, and a search by group name compared against the group id.
export function describeAccessHolder(h, rosterIds) {
  return {
    type: h.holderType,
    value: h.holderLabel || h.holderValue || null,
    id: h.holderValue || null,
    grants: h.contextLabel || h.context || null,
    offRoster: h.holderType === "user" && h.holderValue ? (rosterIds ? !rosterIds.has(h.holderValue) : null) : false,
  };
}

export async function rovoAccessInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const identifier = String(payload?.identifier || "").trim();
    if (!identifier) return { status: "error", message: "A scheme name is required." };
    const inv = await getAccessInventory({ context });
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("access", { state: inv.state, refreshedAt: null });
    const idLower = identifier.toLowerCase();

    for (const family of ACCESS_FAMILIES) {
      const schemes = inv[family]?.schemes || [];
      const scheme = schemes.find((s) => String(s.id) === identifier || String(s.name || "").toLowerCase() === idLower);
      if (!scheme) continue;
      const holders = (inv[family]?.holders || []).filter((h) => String(h.schemeId) === String(scheme.id));
      const rosterIds = await loadActiveRoster(getInstallationKey(context));
      return agentOk(inv.refreshedAt || null, {
        family,
        scheme: {
          id: scheme.id,
          name: scheme.name,
          description: scheme.description || null,
          projectCount: scheme.projectCount ?? null,
        },
        holders: holders.slice(0, 100).map((h) => {
          const d = describeAccessHolder(h, rosterIds);
          return { type: d.type, value: d.value, id: d.id, permission: d.grants, offRoster: d.offRoster };
        }),
        holderCount: holders.length,
        findings: inv[family]?.governance?.findings || inv[family]?.governance || null,
      });
    }
    return agentNotFound(
      inv.refreshedAt || null,
      `No permission, issue-security, notification scheme or project role matched "${identifier}".`,
    );
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    logger.error("rovoAccessInspect.failed", errorContext(error));
    throw error;
  }
}

export async function rovoAccessImpact(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const name = String(payload?.name || "").trim();
    if (!name) return { status: "error", message: "An account id, group name or display name is required." };
    const inv = await getAccessInventory({ context });
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("access", { state: inv.state, refreshedAt: null });
    const needle = name.toLowerCase();
    const rosterIds = await loadActiveRoster(getInstallationKey(context));

    const naming = [];
    for (const family of ACCESS_FAMILIES) {
      const schemes = new Map((inv[family]?.schemes || []).map((s) => [String(s.id), s.name]));
      for (const h of inv[family]?.holders || []) {
        // Matched on the label (group or display name) and the stored id (group id or
        // accountId), so a group name, a group id or an accountId all find the holder.
        const label = String(h.holderLabel || "").toLowerCase();
        const id = String(h.holderValue || "").toLowerCase();
        if (id === needle || label === needle || (label && label.includes(needle))) {
          const d = describeAccessHolder(h, rosterIds);
          naming.push({
            family,
            scheme: schemes.get(String(h.schemeId)) || String(h.schemeId),
            as: d.type,
            holder: d.value,
            grants: d.grants,
            offRoster: d.offRoster,
          });
        }
      }
    }

    return agentOk(inv.refreshedAt || null, {
      subject: name,
      namedIn: naming.slice(0, 200),
      namedInCount: naming.length,
      verdict: naming.length === 0 ? "not-named-in-any-scheme" : "named-in-schemes",
      verdictCaveat:
        "This covers permission, issue-security and notification schemes and project roles. It does not cover global permissions (Jira exposes no grant list for those), board or filter shares, or app-level access.",
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    logger.error("rovoAccessImpact.failed", errorContext(error));
    throw error;
  }
}
