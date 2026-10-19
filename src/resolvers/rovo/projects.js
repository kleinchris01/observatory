// Rovo actions. Project expert (observatory-project-expert): search and inspect projects.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES, getInstallationKey } from "../../lib/jira-api.js";
import { pillarUnavailable, agentOk, agentNotFound, rankMatches, clampResults } from "../../lib/rovo-agents.js";
import { viewerProjects } from "../viewer.js";
import { getProjectOverview } from "../project-overview.js";

// ── Rovo: project expert ───────────────────────────────────────────────────
//
// Per-project scheme identity, adoption and field usage, over getProjectOverview. Read
// only what the viewer can Browse, exactly as getProjectOverview does.

export async function rovoProjectSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const query = String(payload?.query || "").trim();
    const limit = clampResults(payload?.maxResults, 8, 20);
    if (!query) return { status: "error", message: "A search query is required." };

    const vp = await viewerProjects(installationKey, context);
    if (!vp.available) return pillarUnavailable("projects", { state: "idle", refreshedAt: null });

    const matches = rankMatches(vp.projects, query, (p) => [p.projectKey, p.projectName], limit);
    return agentOk(null, {
      query,
      projects: matches.map((p) => ({ projectId: p.projectId, projectKey: p.projectKey, projectName: p.projectName })),
      browsableProjectCount: vp.projects.length,
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoProjectSearch failed:", error);
    throw error;
  }
}

export async function rovoProjectInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    let projectId = String(payload?.projectId || "").trim();
    const projectKey = String(payload?.projectKey || "").trim();

    if (!projectId) {
      if (!projectKey) return { status: "error", message: "A projectId or projectKey is required. Use search first." };
      const vp = await viewerProjects(installationKey, context);
      const hit = vp.projects.find((p) => String(p.projectKey || "").toLowerCase() === projectKey.toLowerCase());
      if (!hit) return agentNotFound(null, `No browsable project has the key "${projectKey}".`);
      projectId = hit.projectId;
    }

    const ov = await getProjectOverview({ payload: { projectId, projectKey }, context });
    if (!ov.available)
      return { status: "not-authorised", message: ov.reason || "You do not have Browse Projects on this project." };

    // Read off the keys getProjectOverview actually returns. This used to read projectType,
    // lead, workflowScheme, roleActors and fieldsInUse, none of which the overview has, so the
    // agent answered every project with no workflow scheme, no roles and no lead.
    return agentOk(ov.refreshedAt || null, {
      project: { projectId, projectKey: ov.projectKey || projectKey, projectName: ov.projectName || null },
      workflowScheme: ov.workflow?.available
        ? ov.workflow.scheme
          ? { id: ov.workflow.scheme.schemeId ?? null, name: ov.workflow.scheme.name }
          : null
        : { available: false, reason: ov.workflow?.reason || null },
      schemes: ov.schemes || null,
      roles: ov.roles || null,
      boards: ov.boards || null,
      adoption: ov.adoption || null,
      dataCaveats:
        "Project type, lead and category are not collected yet, so they are unknown rather than empty. Project activity and archetype-divergence measurement are not built yet.",
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoProjectInspect failed:", error);
    throw error;
  }
}
