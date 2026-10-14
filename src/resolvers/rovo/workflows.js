// Rovo actions. Workflow expert (observatory-workflow-expert): search, inspect and status impact.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES, getInstallationKey } from "../../lib/jira-api.js";
import {
  pillarUnavailable,
  agentOk,
  agentNotFound,
  rankMatches,
  clampResults,
} from "../../lib/rovo-agents.js";
import { loadWorkflowSchemeProjects } from "../../lib/project-store.js";
import { findDuplicateStatusGroups, computeSchemeCategoryBalance } from "../../lib/workflow-insights.js";
import { loadStatusAutomationReferences } from "../../lib/store/automation.js";
import { loadWorkflowForAgent, statusRow, computeStatusDetail } from "../workflows.js";

export async function rovoWorkflowSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const query = String(payload?.query || "").trim();
    const kind = String(payload?.kind || "any").trim().toLowerCase();
    const limit = clampResults(payload?.maxResults, 8, 20);
    if (!query) return { status: "error", message: "A search query is required." };

    const wf = await loadWorkflowForAgent(installationKey);
    if (!wf.available) return pillarUnavailable("workflows", wf.snapshotStatus);

    const schemeMatches = kind === "status" ? [] :
      rankMatches(wf.schemes, query, (s) => [s.name, s.schemeId, s.description], limit);
    const statusMatches = kind === "scheme" ? [] :
      rankMatches(wf.statuses, query, (s) => [s.name, s.statusId ?? s.id], limit);

    return agentOk(wf.refreshedAt, {
      query,
      schemes: schemeMatches.map((s) => ({
        schemeId: s.schemeId, name: s.name, description: s.description || null,
        defaultWorkflow: s.defaultWorkflow || null, projectCount: s.projectCount ?? null,
      })),
      statuses: statusMatches.map((s) => statusRow(s, wf)),
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoWorkflowSearch failed:", error);
    throw error;
  }
}

export async function rovoWorkflowInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const identifier = String(payload?.identifier || "").trim();
    if (!identifier) return { status: "error", message: "A scheme or status name is required." };

    const wf = await loadWorkflowForAgent(installationKey);
    if (!wf.available) return pillarUnavailable("workflows", wf.snapshotStatus);
    const idLower = identifier.toLowerCase();

    const scheme = wf.schemes.find(
      (s) => String(s.schemeId) === identifier || String(s.name || "").toLowerCase() === idLower
    );
    if (scheme) {
      const balance = computeSchemeCategoryBalance([scheme], wf.schemeStatuses, wf.statuses)[0] || null;
      const statusIds = new Set(
        wf.schemeStatuses.filter((p) => String(p.schemeId) === String(scheme.schemeId)).map((p) => String(p.statusId))
      );
      const projects = await loadWorkflowSchemeProjects(installationKey, wf.meta.version, scheme.schemeId).catch(() => []);
      return agentOk(wf.refreshedAt, {
        kind: "scheme",
        scheme: {
          schemeId: scheme.schemeId, name: scheme.name, description: scheme.description || null,
          defaultWorkflow: scheme.defaultWorkflow || null,
        },
        statuses: wf.statuses.filter((s) => statusIds.has(String(s.statusId ?? s.id))).map((s) => statusRow(s, wf)),
        categoryBalance: balance,
        projects: projects.slice(0, 50).map((p) => ({ projectKey: p.projectKey, projectName: p.projectName })),
        projectCount: projects.length,
      });
    }

    const status = wf.statuses.find(
      (s) => String(s.statusId ?? s.id) === identifier || String(s.name || "").toLowerCase() === idLower
    );
    if (!status) return agentNotFound(wf.refreshedAt, `No workflow scheme or status matched "${identifier}".`);

    const sid = String(status.statusId ?? status.id);
    const reachingSchemeIds = new Set(
      wf.schemeStatuses.filter((p) => String(p.statusId) === sid).map((p) => String(p.schemeId))
    );
    const dupGroup = findDuplicateStatusGroups(wf.statuses).find((g) =>
      g.statuses.some((s) => String(s.statusId ?? s.id) === sid)
    );
    const automation = await loadStatusAutomationReferences(installationKey, [status.name]).catch(() => null);

    return agentOk(wf.refreshedAt, {
      kind: "status",
      subject: statusRow(status, wf),
      reachedBySchemes: wf.schemes
        .filter((s) => reachingSchemeIds.has(String(s.schemeId)))
        .map((s) => ({ schemeId: s.schemeId, name: s.name })),
      reachedBySchemeCount: reachingSchemeIds.size,
      duplicateSiblings: dupGroup
        ? dupGroup.statuses.filter((s) => String(s.statusId ?? s.id) !== sid).map((s) => ({ statusId: String(s.statusId ?? s.id), name: s.name, kind: dupGroup.kind }))
        : [],
      automationChecked: Boolean(automation),
      automationRules: automation?.[status.name.toLowerCase()] || automation?.[status.name] || null,
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoWorkflowInspect failed:", error);
    throw error;
  }
}

export async function rovoWorkflowImpact(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const name = String(payload?.name || "").trim();
    if (!name) return { status: "error", message: "A status name is required." };

    const d = await computeStatusDetail(installationKey, context, { name });
    if (!d.available) return pillarUnavailable("workflows", d.snapshotStatus);
    if (!d.found) return agentNotFound(d.refreshedAt, `No status named "${name}" is in the catalogue.`);

    return agentOk(d.refreshedAt, {
      subject: d.statusRow,
      reachedBySchemes: d.reachingSchemes.map((s) => ({ schemeId: s.schemeId, name: s.name })),
      reachedBySchemeCount: d.reachingSchemeCount,
      governedProjectCount: d.projectCount,
      projectSample: d.projectSample,
      automationChecked: d.automationChecked,
      automationRules: d.automationRules,
      boardChecked: d.boardChecked,
      onAnyBoard: d.onBoard,
      filtersChecked: Boolean(d.referencingFilters),
      referencingFilters: d.referencingFilters
        ? d.referencingFilters.slice(0, 10).map((f) => ({ id: f.id, name: f.name }))
        : null,
      referencingFilterCount: d.referencingFilters ? d.referencingFilters.length : null,
      issueCount: d.issueCount,
      everCount: d.everCount,
      workflowsChecked: d.workflowNames !== null,
      inWorkflows: d.workflowNames,
      restrictions: d.restrictions?.available
        ? d.restrictions.restrictions.map((r) => ({ workflow: r.workflowName, restriction: r.description, holder: r.holder?.label || r.holder?.id || null }))
        : null,
      verdict: d.assessment.verdict,
      blockers: d.assessment.blockers,
      gaps: d.assessment.gaps,
      verdictCaveat:
        "This covers workflow schemes, the workflows that contain the status, issue counts, " +
        "board columns, saved filter JQL and (where an analysis exists) automation. It does " +
        "not cover dashboards built directly on a status without a saved filter, or apps.",
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoWorkflowImpact failed:", error);
    throw error;
  }
}
