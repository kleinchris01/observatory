// Builds the issue type snapshot: the type catalog and the schemes that decide which types
// each project may use, versioned.
//
//   project -> issue type scheme -> (ordered) issue types
//
// Follows screen-engine.js's buildScreenSnapshot exactly, and single-pass for the same
// reason: the inputs are small. A large site has a few hundred issue types, low hundreds of
// schemes, and one /project call per 50 projects -- well inside one consumer invocation,
// with no per-item walk to force batching. The issue-type -> screen tier
// (snapshot_issue_type_screen_schemes) is built separately by the screen pillar; this is
// the tier above it.

import { logger } from "./logger.js";
import { inventorySnapshotQueue } from "./queues.js";
import {
  incrMetric,
  METRIC_NAMES,
  getAllIssueTypes,
  getAllIssueTypeSchemes,
  getIssueTypeSchemeItems,
  getIssueTypeSchemeProjects,
  getAllJiraProjects,
} from "./jira-api.js";
import {
  ensureProjectStoreReady,
  writeIssueTypeSnapshotMeta,
  readIssueTypeSnapshotMeta,
  replaceIssueTypeSnapshot,
} from "./project-store.js";

// Matches SCREEN_BUILD_STALE_MS and for the same reason: the consumer ceiling is 900s, plus
// a minute so a build finishing right at the limit is never declared stale out from under
// itself. This build is far cheaper than the screen walk, but a Forge invocation timeout is
// still a hard kill that skips the catch, so the clock is the only recovery signal.
export const ISSUE_TYPE_BUILD_STALE_MS = 16 * 60 * 1000;

// True when a build was started but can no longer be running. Same contract as
// isScreenBuildStale: an unparseable or absent startedAt is treated as stale so the wedge
// is always recoverable rather than sometimes.
export function isIssueTypeBuildStale(meta, now = Date.now()) {
  if (meta?.state !== "building") return false;
  const startedAt = Date.parse(meta?.startedAt || "");
  if (!Number.isFinite(startedAt)) return true;
  return now - startedAt > ISSUE_TYPE_BUILD_STALE_MS;
}

// Normalise one raw issue type into the row shape the store writes.
//
// Exported for its own test because the two facts most likely to be read wrong live here:
// hierarchyLevel is Jira's signed integer and must survive as-is (a `|| 0` would turn a
// sub-task's -1 into 0 and misfile it), and `scope` is present only on team-managed types
// -- its absence means global, which is the opposite claim, so it maps to null not "".
export function normalizeIssueType(raw) {
  const level = Number(raw?.hierarchyLevel);
  return {
    id: String(raw?.id),
    name: raw?.name || null,
    description: raw?.description || null,
    subtask: Boolean(raw?.subtask),
    hierarchyLevel: Number.isFinite(level) ? level : 0,
    scopeProjectId: raw?.scope?.project?.id != null ? String(raw.scope.project.id) : null,
  };
}

// Hand the build to the queue consumer (900s) rather than the caller's resolver invocation
// (25s). State is marked "building" here, not in the consumer, so the UI reflects the
// request immediately and rapid double-clicks collapse into one job.
export async function queueIssueTypeSnapshotBuild(installationKey) {
  await ensureProjectStoreReady();
  await writeIssueTypeSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });
  await inventorySnapshotQueue.push({
    body: { jobType: "build-issue-type-snapshot", installationKey },
  });
}

export async function buildIssueTypeSnapshot(installationKey) {
  incrMetric(METRIC_NAMES.issueTypeSnapshotStarted);
  await ensureProjectStoreReady();
  await writeIssueTypeSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });

  try {
    const version = String(Date.now());

    // The catalog and the two scheme layers are independent and small, so they go in
    // parallel. The project list joins the batch because it is needed only by the /project
    // call below, which is sequenced after.
    const [rawTypes, rawSchemes, rawItems, projects] = await Promise.all([
      getAllIssueTypes(),
      getAllIssueTypeSchemes(),
      getIssueTypeSchemeItems(),
      getAllJiraProjects(),
    ]);

    // Sequenced after the batch rather than joining it: /issuetypescheme/project requires at
    // least one projectId, so it cannot be issued until the project list is in hand. Left in
    // the parallel batch it returns 400 and takes the whole build with it -- the exact
    // mistake the screen pillar's /project call was written to avoid.
    //
    // Deliberately fatal, not best-effort. Without these rows every scheme reports zero
    // projects, which does not read as "unknown" -- it reads as "nothing uses this", and
    // that is a finding. Failing loudly beats publishing a snapshot that quietly recommends
    // retiring every scheme on the site.
    const schemeProjectRows = await getIssueTypeSchemeProjects(projects.map((p) => p.id));

    const issueTypes = (rawTypes || []).filter((t) => t?.id != null).map(normalizeIssueType);

    // Ordered membership. Jira returns the /mapping rows already in an admin's chosen order;
    // item_index is assigned per scheme as they stream past so the order survives the round
    // trip through SQL, where row order is not guaranteed.
    const indexByScheme = new Map();
    const schemeItems = [];
    for (const row of rawItems || []) {
      const schemeId = String(row?.issueTypeSchemeId ?? "");
      const issueTypeId = String(row?.issueTypeId ?? "");
      if (!schemeId || !issueTypeId) continue;
      const idx = indexByScheme.get(schemeId) || 0;
      schemeItems.push({ schemeId, issueTypeId, itemIndex: idx });
      indexByScheme.set(schemeId, idx + 1);
    }

    // Project ids arrive as a bare list per scheme; resolve them to keys and names so the
    // inventory reads without a second lookup, and keep the row when a project is not in the
    // catalog rather than dropping it.
    const projectsById = new Map(projects.map((p) => [String(p.id), p]));
    const schemeProjects = [];
    const projectCountByScheme = new Map();

    for (const row of schemeProjectRows || []) {
      const schemeId = String(row?.issueTypeScheme?.id ?? row?.issueTypeSchemeId ?? "");
      if (!schemeId) continue;
      for (const projectId of row.projectIds || []) {
        const project = projectsById.get(String(projectId));
        schemeProjects.push({
          schemeId,
          projectId: String(projectId),
          projectKey: project?.key || "UNKNOWN",
          projectName: project?.name || "Unknown project",
        });
        projectCountByScheme.set(schemeId, (projectCountByScheme.get(schemeId) || 0) + 1);
      }
    }

    const schemes = (rawSchemes || [])
      .filter((s) => s?.id != null)
      .map((s) => ({
        id: String(s.id),
        name: s.name || null,
        description: s.description || null,
        defaultIssueTypeId: s.defaultIssueTypeId == null ? null : String(s.defaultIssueTypeId),
        isDefault: Boolean(s.isDefault),
        projectCount: projectCountByScheme.get(String(s.id)) || 0,
      }));

    await replaceIssueTypeSnapshot(installationKey, version, {
      issueTypes,
      schemes,
      schemeItems,
      schemeProjects,
    });

    const completedAt = new Date().toISOString();
    await writeIssueTypeSnapshotMeta(installationKey, {
      state: "ready",
      version,
      completedAt,
      refreshedAt: completedAt,
      totalTypes: issueTypes.length,
      totalSchemes: schemes.length,
      lastError: null,
    });

    incrMetric(METRIC_NAMES.issueTypeSnapshotCompleted);
    logger.info("issue-type-snapshot.completed", {
      version,
      issueTypes: issueTypes.length,
      schemes: schemes.length,
      schemeItems: schemeItems.length,
      schemeProjects: schemeProjects.length,
    });

    return { version, issueTypes: issueTypes.length, schemes: schemes.length };
  } catch (error) {
    incrMetric(METRIC_NAMES.issueTypeSnapshotFailed);
    const message = String(error?.message || error);
    logger.error("issue-type-snapshot.failed", { error: message });
    await writeIssueTypeSnapshotMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: message,
    });
    throw error;
  }
}
