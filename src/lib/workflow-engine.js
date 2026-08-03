import { logger } from "./logger.js";
import { inventorySnapshotQueue } from "./queues.js";
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

// A "building" row older than this is treated as abandoned rather than in-flight.
//
// The consumer's ceiling is timeoutSeconds: 900 in manifest.yml, so nothing legitimately
// running can still be building past that -- plus a minute so a job finishing right at
// the limit is never declared stale out from under itself.
export const WORKFLOW_BUILD_STALE_MS = 16 * 60 * 1000;

// True when a build was started but no longer can be running.
//
// This exists because a Forge invocation timeout is a hard kill: buildWorkflowSnapshot
// marks state "building" before its first API call, and the catch that would mark it
// "failed" never executes if the invocation is killed mid-flight. The row then stays
// "building" forever and every future refresh is suppressed as "already building" --
// a permanent wedge with no way out from the UI. Ask the clock, not the state alone.
export function isWorkflowBuildStale(meta, now = Date.now()) {
  if (meta?.state !== "building") return false;
  const startedAt = Date.parse(meta?.startedAt || "");
  // An unparseable or absent startedAt means we cannot prove it is live; treat it as
  // stale so the wedge is always recoverable.
  if (!Number.isFinite(startedAt)) return true;
  return now - startedAt > WORKFLOW_BUILD_STALE_MS;
}

// Hand the build to the queue consumer (timeoutSeconds: 900) instead of running it in the
// caller's resolver invocation (25s).
//
// The build is a single synchronous pass over every project's workflow scheme at
// concurrency 8; on a 142-project site that is ~18 sequential waves of Jira calls and does
// not fit in a resolver. State is marked "building" here rather than in the consumer so
// the UI reflects the request immediately and rapid double-clicks collapse into one job.
export async function queueWorkflowSnapshotBuild(installationKey) {
  await ensureProjectStoreReady();
  await writeWorkflowSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });
  await inventorySnapshotQueue.push({
    body: { jobType: "build-workflow-snapshot", installationKey },
  });
}

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
