import { logger } from "./logger.js";
import {
  incrMetric,
  METRIC_NAMES,
  getAllJiraProjects,
  getAllStatuses,
  getWorkflowSchemesForProjects,
} from "./jira-api.js";
import {
  ensureProjectStoreReady,
  writeWorkflowSnapshotMeta,
  replaceWorkflowSnapshot,
} from "./project-store.js";

// Workflow schemes and statuses are small, site-wide catalogs (typically tens of
// items, not the hundreds-plus a custom-field snapshot can hit) — unlike
// consumeSnapshot/snapshot-engine.js, this runs as a single synchronous pass with
// no resume tokens. If a site turns out to have enough projects that this exceeds
// a resolver invocation's timeout, that's a real follow-up (queue + resumability),
// not something to build speculatively here.
export async function buildWorkflowSnapshot(installationKey) {
  incrMetric(METRIC_NAMES.workflowSnapshotStarted);
  await ensureProjectStoreReady();
  await writeWorkflowSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });

  try {
    const version = String(Date.now());

    const [statuses, projects] = await Promise.all([
      getAllStatuses(),
      getAllJiraProjects(),
    ]);

    const projectIds = projects.map((p) => String(p.id));
    const schemeAssociations = await getWorkflowSchemesForProjects(projectIds);

    const schemesById = new Map();
    const schemeProjectRows = [];

    for (const assoc of schemeAssociations) {
      if (!assoc.scheme || assoc.error) {
        logger.warn("workflow-snapshot.scheme-lookup-failed", { projectId: assoc.projectId, error: assoc.error || "no scheme returned" });
        continue;
      }
      const project = projects.find((p) => String(p.id) === String(assoc.projectId));
      if (!project) continue;

      const schemeId = String(assoc.scheme.id ?? assoc.scheme.name ?? `unknown-${assoc.projectId}`);
      if (!schemesById.has(schemeId)) {
        schemesById.set(schemeId, {
          id: schemeId,
          name: assoc.scheme.name || "(unnamed workflow scheme)",
          description: assoc.scheme.description || "",
          defaultWorkflow: assoc.scheme.defaultWorkflow || null,
          issueTypeMapping: assoc.scheme.issueTypeMappings || assoc.scheme.issueTypeMapping || null,
          projectCount: 0,
        });
      }
      const scheme = schemesById.get(schemeId);
      scheme.projectCount += 1;
      schemeProjectRows.push({
        schemeId,
        projectId: String(project.id),
        projectKey: project.key,
        projectName: project.name,
      });
    }

    const schemeRows = Array.from(schemesById.values());

    const statusRows = statuses.map((status) => ({
      id: String(status.id),
      name: status.name,
      statusCategory: status.statusCategory?.name || status.statusCategory?.key || null,
    }));

    await replaceWorkflowSnapshot(installationKey, version, {
      schemes: schemeRows,
      schemeProjects: schemeProjectRows,
      statuses: statusRows,
    });

    const completedAt = new Date().toISOString();
    await writeWorkflowSnapshotMeta(installationKey, {
      state: "ready",
      version,
      completedAt,
      refreshedAt: completedAt,
      totalSchemes: schemeRows.length,
      lastError: null,
    });

    incrMetric(METRIC_NAMES.workflowSnapshotCompleted);
    return { version, schemeCount: schemeRows.length, statusCount: statusRows.length, projectCount: projects.length };
  } catch (error) {
    logger.error("workflow-snapshot.failed", { installationKey, error: String(error?.message || error) });
    await writeWorkflowSnapshotMeta(installationKey, {
      state: "failed",
      lastError: String(error?.message || error),
    }).catch(() => {});
    incrMetric(METRIC_NAMES.workflowSnapshotFailed);
    throw error;
  }
}
