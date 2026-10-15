// Issue types pillar: inventory read and snapshot build.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES, getInstallationKey } from "../lib/jira-api.js";
import {
  ensureProjectStoreReady,
  readIssueScanMeta,
  readScreenSnapshotMeta,
  loadIssueTypeScreenSchemes,
  loadItssMappings,
  readIssueTypeSnapshotMeta,
  loadIssueTypes,
  loadIssueTypeSchemes,
  loadIssueTypeSchemeItems,
  loadIssueTypeSchemeProjects,
  loadIssueTypeGovernanceSummary,
  loadIssueTypeTotals,
} from "../lib/project-store.js";
import { queueIssueTypeSnapshotBuild, isIssueTypeBuildStale } from "../lib/issuetype-engine.js";
import { summarizeIssueTypeInsights } from "../lib/issuetype-insights.js";
import { readAdminConfig } from "./admin-config.js";

// Labels for Jira's issue-type hierarchy levels. Only -1, 0 and 1 are standard; a site with
// custom hierarchy above Epic has levels 2+, which the caller labels "Level N" rather than
// inventing a name. Keyed by the raw integer Jira returns, not by an ordinal.
export const HIERARCHY_LEVEL_LABELS = {
  "-1": "Sub-task",
  0: "Base (Story, Task, Bug)",
  1: "Epic",
};

// Read path for the Issue Types surface. Mirrors getScreenInventory: one call returns the
// meta, the type catalog grouped by hierarchy level, the schemes with their ordered
// membership resolved, and -- best-effort from the screen snapshot -- the issue-type ->
// screen-scheme routing layer, so the tab renders from a single round trip.
export async function getIssueTypeInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readIssueTypeSnapshotMeta(installationKey);
  const staleBuild = isIssueTypeBuildStale(meta);

  // No snapshot has ever completed. Report that plainly rather than empty lists that read
  // as "this site has no issue types" -- the opposite claim.
  if (!meta?.version) {
    return {
      state: meta?.state || "idle",
      staleBuild,
      startedAt: meta?.startedAt || null,
      version: null,
      issueTypes: [],
      hierarchy: [],
      schemes: [],
      governance: null,
      issueTypeScreenSchemes: [],
      lastError: meta?.lastError || null,
      neverBuilt: true,
    };
  }

  const [issueTypes, schemes, schemeItems, schemeProjects, governance] = await Promise.all([
    loadIssueTypes(installationKey, meta.version),
    loadIssueTypeSchemes(installationKey, meta.version),
    loadIssueTypeSchemeItems(installationKey, meta.version),
    loadIssueTypeSchemeProjects(installationKey, meta.version),
    loadIssueTypeGovernanceSummary(installationKey, meta.version),
  ]);

  const typeById = new Map(issueTypes.map((t) => [String(t.id), t]));

  // Group the catalog by Jira's hierarchy level, highest first (Epic and any custom levels
  // above it, then base, then sub-task at -1). The level number is carried alongside the
  // label so the tab does not have to hard-code a mapping that a custom hierarchy breaks.
  const byLevel = new Map();
  for (const type of issueTypes) {
    const level = Number(type.hierarchyLevel) || 0;
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(type);
  }
  const hierarchyRaw = [...byLevel.keys()]
    .sort((a, b) => b - a)
    .map((level) => ({
      level,
      label: HIERARCHY_LEVEL_LABELS[level] || (level < 0 ? "Sub-task" : `Level ${level}`),
      types: byLevel.get(level),
    }));

  // Resolve each scheme's ordered membership against the catalog. A member id the catalog
  // does not contain is kept with a null name rather than dropped: a scheme allowing a type
  // that no longer exists is a finding, not noise.
  const membersByScheme = new Map();
  for (const item of schemeItems) {
    if (!membersByScheme.has(item.schemeId)) membersByScheme.set(item.schemeId, []);
    const type = typeById.get(String(item.issueTypeId));
    membersByScheme.get(item.schemeId).push({
      id: item.issueTypeId,
      name: type?.name || null,
      hierarchyLevel: type?.hierarchyLevel ?? null,
      subtask: type?.subtask ?? null,
      missing: !type,
    });
  }
  const projectsByScheme = new Map();
  for (const row of schemeProjects) {
    if (!projectsByScheme.has(row.schemeId)) projectsByScheme.set(row.schemeId, []);
    projectsByScheme.get(row.schemeId).push({
      projectId: row.projectId,
      projectKey: row.projectKey,
      projectName: row.projectName,
    });
  }
  const schemesResolved = schemes.map((s) => ({
    ...s,
    defaultIssueTypeName: s.defaultIssueTypeId ? typeById.get(String(s.defaultIssueTypeId))?.name || null : null,
    issueTypes: membersByScheme.get(s.schemeId) || [],
    projects: (projectsByScheme.get(s.schemeId) || []).sort((a, b) => a.projectKey.localeCompare(b.projectKey)),
  }));

  // The tier below: issue-type -> screen-scheme routing, from the screen snapshot. Sent so
  // the tab can show, per issue type screen scheme, which screen scheme each type resolves
  // to. Best-effort -- the screen pillar refreshes on its own cadence and may not have run.
  let issueTypeScreenSchemes = [];
  try {
    const screenMeta = await readScreenSnapshotMeta(installationKey);
    if (screenMeta?.version) {
      const [itss, itssMappings] = await Promise.all([
        loadIssueTypeScreenSchemes(installationKey, screenMeta.version),
        loadItssMappings(installationKey, screenMeta.version),
      ]);
      const mappingsByItss = new Map();
      for (const m of itssMappings) {
        if (!mappingsByItss.has(m.itssId)) mappingsByItss.set(m.itssId, []);
        mappingsByItss.get(m.itssId).push({
          issueTypeId: m.issueTypeId,
          issueTypeName:
            m.issueTypeId === "default" ? "All unmapped types" : typeById.get(String(m.issueTypeId))?.name || null,
          screenSchemeId: m.screenSchemeId,
          isDefault: m.isDefault,
        });
      }
      issueTypeScreenSchemes = itss.map((s) => ({
        ...s,
        mappings: mappingsByItss.get(s.itssId) || [],
      }));
    }
  } catch (error) {
    // A screen-snapshot read failing must not take the issue-type tab down with it.
    console.error("getIssueTypeInventory: screen-scheme layer unavailable:", error?.message || error);
  }

  // Per-type issue counts from the crawl, and the tri-state that makes them safe to read.
  //
  // Zero is what makes a type look safe to delete, so it is only ever asserted when a crawl
  // actually completed. Three outcomes, never collapsed into two:
  //   measured     a full scan finished and this type has a count (possibly a real zero)
  //   not-measured no crawl has completed, so no type has a count
  //   partial      a crawl ran but did not finish, so a missing row means "not reached",
  //                not "nobody uses it"
  const usage = await (async () => {
    try {
      const scanMeta = await readIssueScanMeta(installationKey);
      const state = scanMeta?.state || null;
      if (state !== "ready" && state !== "building" && state !== "failed") {
        return { measurement: "not-measured", byType: new Map(), measuredAt: null };
      }
      const rows = await loadIssueTypeTotals(installationKey);
      if (!rows.length && state !== "ready") {
        return { measurement: "not-measured", byType: new Map(), measuredAt: null };
      }
      return {
        // A crawl that is still running, or that failed part-way, has counted SOME projects.
        // Calling that "measured" would report a half-walked estate's silence as evidence.
        measurement: state === "ready" ? "measured" : "partial",
        byType: new Map(rows.map((r) => [String(r.issueTypeId), r])),
        measuredAt: scanMeta?.completedAt || null,
      };
    } catch (error) {
      // A counting failure is not a count of zero -- the distinction CONNECT-4091 exists for.
      console.error("getIssueTypeInventory: usage unavailable:", error?.message || error);
      return { measurement: "measurement-failed", byType: new Map(), measuredAt: null };
    }
  })();

  const withUsage = (type) => {
    const row = usage.byType.get(String(type.id));
    return {
      ...type,
      // null, not 0, wherever the count is not evidence. The tab renders the three states
      // differently and must never show a dash as a zero.
      issueCount: usage.measurement === "measured" ? (row?.issueCount ?? 0) : (row?.issueCount ?? null),
      usedInProjects: row?.projectCount ?? null,
    };
  };

  return {
    state: meta.state,
    staleBuild,
    startedAt: meta.startedAt || null,
    version: meta.version,
    refreshedAt: meta.refreshedAt,
    completedAt: meta.completedAt,
    usage: { measurement: usage.measurement, measuredAt: usage.measuredAt },
    totalTypes: meta.totalTypes,
    totalSchemes: meta.totalSchemes,
    lastError: meta.lastError || null,
    issueTypes: issueTypes.map(withUsage),
    hierarchy: hierarchyRaw.map((h) => ({ ...h, types: h.types.map(withUsage) })),
    schemes: schemesResolved,
    governance,
    // The finding-shaped detail behind the governance counts: near-duplicate name groups,
    // the orphan list, and the schemes whose type set does not hang together. Computed from
    // the rows already loaded above so the tab renders findings without a second round trip.
    governanceFindings: summarizeIssueTypeInsights({ types: issueTypes, schemes, schemeItems }),
    issueTypeScreenSchemes,
    neverBuilt: false,
  };
}

export async function buildIssueTypeInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readIssueTypeSnapshotMeta(installationKey);
  // Suppress only a build that is both building AND not stale, matching buildScreenInventory:
  // a wedged row must never block every future rebuild with no way out of the UI.
  if (meta?.state === "building" && !isIssueTypeBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before building the issue type inventory." };
  }

  await queueIssueTypeSnapshotBuild(installationKey);
  return { queued: true };
}
