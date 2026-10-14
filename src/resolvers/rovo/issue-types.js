// Rovo actions. Issue type expert (observatory-issuetype-expert): search, inspect and impact.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES } from "../../lib/jira-api.js";
import {
  pillarUnavailable,
  agentOk,
  agentNotFound,
  rankMatches,
  clampResults,
} from "../../lib/rovo-agents.js";
import { getIssueTypeInventory } from "../issue-types.js";

// ── Rovo: issue type expert ─────────────────────────────────────────────────
//
// Thin wrappers over getIssueTypeInventory so the agent and the tab read the same rows.

export async function rovoIssueTypeSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const query = String(payload?.query || "").trim();
    const kind = String(payload?.kind || "any").trim().toLowerCase();
    const limit = clampResults(payload?.maxResults, 8, 20);
    if (!query) return { status: "error", message: "A search query is required." };

    const inv = await getIssueTypeInventory({ context });
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("issue types", { state: inv.state, refreshedAt: null });

    const types = kind === "scheme" ? [] :
      rankMatches(inv.issueTypes, query, (t) => [t.name, t.id, t.description], limit);
    const schemes = kind === "type" ? [] :
      rankMatches(inv.schemes, query, (s) => [s.name, s.schemeId, s.description], limit);

    return agentOk(inv.refreshedAt || null, {
      query,
      issueTypes: types.map((t) => ({
        id: t.id, name: t.name, hierarchyLevel: t.hierarchyLevel ?? null,
        subtask: Boolean(t.subtask), description: t.description || null,
      })),
      schemes: schemes.map((s) => ({
        schemeId: s.schemeId, name: s.name, isDefault: Boolean(s.isDefault),
        projectCount: (s.projects || []).length, typeCount: (s.issueTypes || []).length,
      })),
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoIssueTypeSearch failed:", error);
    throw error;
  }
}

export async function rovoIssueTypeInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const identifier = String(payload?.identifier || "").trim();
    if (!identifier) return { status: "error", message: "An issue type or scheme name is required." };
    const inv = await getIssueTypeInventory({ context });
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("issue types", { state: inv.state, refreshedAt: null });
    const idLower = identifier.toLowerCase();

    const scheme = (inv.schemes || []).find(
      (s) => String(s.schemeId) === identifier || String(s.name || "").toLowerCase() === idLower
    );
    if (scheme) {
      return agentOk(inv.refreshedAt || null, {
        kind: "scheme",
        scheme: {
          schemeId: scheme.schemeId, name: scheme.name, isDefault: Boolean(scheme.isDefault),
          defaultIssueType: scheme.defaultIssueTypeName || null,
        },
        issueTypes: (scheme.issueTypes || []).map((t) => ({ id: t.id, name: t.name, missing: Boolean(t.missing), hierarchyLevel: t.hierarchyLevel ?? null })),
        projects: (scheme.projects || []).slice(0, 50).map((p) => ({ projectKey: p.projectKey, projectName: p.projectName })),
        projectCount: (scheme.projects || []).length,
      });
    }

    const type = (inv.issueTypes || []).find(
      (t) => String(t.id) === identifier || String(t.name || "").toLowerCase() === idLower
    );
    if (!type) return agentNotFound(inv.refreshedAt || null, `No issue type or scheme matched "${identifier}".`);

    const reachingSchemes = (inv.schemes || []).filter((s) => (s.issueTypes || []).some((m) => String(m.id) === String(type.id)));
    return agentOk(inv.refreshedAt || null, {
      kind: "type",
      issueType: { id: type.id, name: type.name, hierarchyLevel: type.hierarchyLevel ?? null, subtask: Boolean(type.subtask), description: type.description || null },
      reachedBySchemes: reachingSchemes.map((s) => ({ schemeId: s.schemeId, name: s.name })),
      reachedBySchemeCount: reachingSchemes.length,
      governedProjectCount: reachingSchemes.reduce((n, s) => n + (s.projects || []).length, 0),
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoIssueTypeInspect failed:", error);
    throw error;
  }
}

export async function rovoIssueTypeImpact(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const name = String(payload?.name || "").trim();
    if (!name) return { status: "error", message: "An issue type name is required." };
    const inv = await getIssueTypeInventory({ context });
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("issue types", { state: inv.state, refreshedAt: null });

    const type = (inv.issueTypes || []).find((t) => String(t.name || "").toLowerCase() === name.toLowerCase());
    if (!type) return agentNotFound(inv.refreshedAt || null, `No issue type named "${name}" is in the catalogue.`);

    const reachingSchemes = (inv.schemes || []).filter((s) => (s.issueTypes || []).some((m) => String(m.id) === String(type.id)));
    const projectSample = [];
    for (const s of reachingSchemes) for (const p of (s.projects || []).slice(0, 10)) projectSample.push(p.projectKey);

    return agentOk(inv.refreshedAt || null, {
      issueType: { id: type.id, name: type.name, hierarchyLevel: type.hierarchyLevel ?? null },
      reachedBySchemes: reachingSchemes.map((s) => ({ schemeId: s.schemeId, name: s.name })),
      reachedBySchemeCount: reachingSchemes.length,
      governedProjectCount: reachingSchemes.reduce((n, s) => n + (s.projects || []).length, 0),
      projectSample: [...new Set(projectSample)].slice(0, 20),
      verdict: reachingSchemes.length === 0 ? "no-scheme-reaches-it" : "in-use",
      verdictCaveat:
        "This covers issue type schemes and their project assignments. It does not measure how many issues of the type exist unless the universe scan has run, and does not cover automation, boards or apps.",
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoIssueTypeImpact failed:", error);
    throw error;
  }
}
