import { logger } from "./logger.js";
import { inventorySnapshotQueue } from "./queues.js";
import {
  incrMetric,
  METRIC_NAMES,
  getAllJiraProjects,
  getAllStatuses,
  getWorkflowSchemesForProjects,
  getAllWorkflowsWithStatuses,
  getEverInStatusCounts,
} from "./jira-api.js";
import {
  ensureProjectStoreReady,
  writeWorkflowSnapshotMeta,
  replaceWorkflowSnapshot,
  loadStatusesCatalog,
  readWorkflowSnapshotMeta,
  upsertStatusHistoryCounts,
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

    const [statuses, projects, workflows] = await Promise.all([
      getAllStatuses(),
      getAllJiraProjects(),
      // Best-effort: the scheme/status inventory is still worth building without the
      // workflow expansion, it just cannot answer "which statuses does this scheme
      // reach". Failing the whole snapshot over the insight layer would be the wrong
      // trade -- the inventory is the thing people came for.
      getAllWorkflowsWithStatuses().catch((error) => {
        logger.warn("workflow-snapshot.workflow-statuses-failed", { error: String(error?.message || error) });
        return [];
      }),
    ]);

    // workflow name -> status ids. The scheme association gives workflow NAMES (a default
    // plus per-issue-type overrides), so the join is by name. getAllWorkflowsWithStatuses
    // has already reconciled the two endpoint generations and resolved status references
    // to real status ids.
    const statusIdsByWorkflowName = new Map();
    for (const workflow of workflows) {
      if (!workflow?.name) continue;
      if (!statusIdsByWorkflowName.has(workflow.name)) statusIdsByWorkflowName.set(workflow.name, new Set());
      const target = statusIdsByWorkflowName.get(workflow.name);
      for (const id of workflow.statusIds || []) target.add(id);
    }

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

    // Resolve each scheme to the union of statuses across every workflow it uses: the
    // default workflow plus any per-issue-type override. Deduplicated by construction --
    // one scheme reaching a status through three issue types is still one pair.
    const schemeStatusRows = [];
    for (const scheme of schemeRows) {
      const workflowNames = new Set();
      if (scheme.defaultWorkflow) workflowNames.add(scheme.defaultWorkflow);
      const mapping = scheme.issueTypeMapping;
      if (mapping && typeof mapping === "object") {
        for (const value of Object.values(mapping)) {
          if (typeof value === "string" && value) workflowNames.add(value);
        }
      }
      const statusIds = new Set();
      for (const name of workflowNames) {
        for (const id of statusIdsByWorkflowName.get(name) || []) statusIds.add(id);
      }
      for (const statusId of statusIds) {
        schemeStatusRows.push({ schemeId: scheme.id, statusId });
      }
    }

    const statusRows = statuses.map((status) => ({
      id: String(status.id),
      name: status.name,
      statusCategory: status.statusCategory?.name || status.statusCategory?.key || null,
    }));

    await replaceWorkflowSnapshot(installationKey, version, {
      schemes: schemeRows,
      schemeProjects: schemeProjectRows,
      statuses: statusRows,
      schemeStatuses: schemeStatusRows,
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
    return {
      version,
      schemeCount: schemeRows.length,
      statusCount: statusRows.length,
      projectCount: projects.length,
      schemeStatusCount: schemeStatusRows.length,
    };
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


// Measure how many issues have ever been in each status, using JQL's WAS operator.
//
// The cheap alternative to a changelog crawl: one approximate-count per status rather
// than re-reading every issue with expand=changelog, which on a 317k-issue site is the
// difference between minutes and hours.
//
// Runs on the queue consumer, not a resolver: a few hundred history queries will not fit
// in 25 seconds, and WAS queries are slower than plain status filters because they hit
// Jira's issue-history index.
export async function buildStatusHistorySnapshot(installationKey) {
  await ensureProjectStoreReady();

  const meta = await readWorkflowSnapshotMeta(installationKey);
  if (!meta?.version) {
    // Nothing to measure against: the status catalog comes from the workflow snapshot.
    logger.warn("status-history.skipped", { reason: "no-workflow-snapshot" });
    return { measured: 0, failed: 0, skipped: true };
  }

  const statuses = await loadStatusesCatalog(installationKey, meta.version);
  const statusIds = statuses.map((status) => String(status.statusId ?? status.id)).filter(Boolean);
  if (!statusIds.length) return { measured: 0, failed: 0, skipped: true };

  const { counts, failures } = await getEverInStatusCounts(statusIds);
  const measuredAt = new Date().toISOString();
  await upsertStatusHistoryCounts(installationKey, counts, measuredAt);

  // Partial results are kept and dated. A status whose query failed keeps whatever it had
  // rather than being written as zero -- zero is what makes a status look safe to delete.
  if (failures.length > 0) {
    logger.warn("status-history.partial", {
      measured: counts.size,
      failed: failures.length,
      firstError: failures[0]?.error || null,
    });
  }

  return { measured: counts.size, failed: failures.length, measuredAt };
}

export async function queueStatusHistoryBuild(installationKey) {
  await ensureProjectStoreReady();
  await inventorySnapshotQueue.push({
    body: { jobType: "build-status-history", installationKey },
  });
}
