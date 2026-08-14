// Builds the screen and scheme snapshot: the full presentation chain, versioned.
//
//   project -> issue type screen scheme -> screen scheme -> screen -> tab -> field
//
// Follows workflow-engine.js, with one deliberate difference. The workflow build runs
// single-pass because its catalogs are small and nobody had measured them; this one runs
// single-pass because somebody did. CONNECT-4137 put a full pass at ~1,528 calls and
// ~4.9 minutes against a 900s consumer -- comfortably inside one invocation, with the tab
// distribution flat at 1 per screen, so the tail that would have forced batching does not
// exist. Resumability (CONNECT-4136) was deferred on that evidence rather than skipped for
// convenience; if a site turns up whose projection does not fit, the probe says so before
// the build is ever run and that story comes back.

import { logger } from "./logger.js";
import { inventorySnapshotQueue } from "./queues.js";
import {
  incrMetric,
  METRIC_NAMES,
  getAllScreens,
  getScreenTabs,
  getScreenTabFields,
  getAllScreenSchemes,
  getAllIssueTypeScreenSchemes,
  getIssueTypeScreenSchemeMappings,
  getIssueTypeScreenSchemeProjects,
  getAllJiraProjects,
  mapWithConcurrency,
} from "./jira-api.js";
import {
  ensureProjectStoreReady,
  writeScreenSnapshotMeta,
  readScreenSnapshotMeta,
  replaceScreenSnapshot,
} from "./project-store.js";

// Matches WORKFLOW_BUILD_STALE_MS and for the same reason: the consumer ceiling is 900s,
// plus a minute so a build finishing right at the limit is never declared stale out from
// under itself.
export const SCREEN_BUILD_STALE_MS = 16 * 60 * 1000;

// Concurrency for the per-screen tab and field walk.
//
// 4, matching the app's own limiter rather than racing it. The probe measured 190ms per
// call and zero 429s at this concurrency, so the projection the build is sized against was
// taken under exactly these conditions -- running the real pass faster would invalidate the
// number that said it fits.
export const SCREEN_FETCH_CONCURRENCY = 4;

// The four operations a screen scheme can map, in the order Jira documents them.
export const SCREEN_SCHEME_OPERATIONS = ["default", "create", "edit", "view"];

// True when a build was started but can no longer be running.
//
// A Forge invocation timeout is a hard kill: state is marked "building" before the first
// API call and the catch that would mark it "failed" never runs. Without this the row stays
// "building" forever and every future rebuild is suppressed as already-running -- a
// permanent wedge with no way out of the UI. Ask the clock, not the state alone.
export function isScreenBuildStale(meta, now = Date.now()) {
  if (meta?.state !== "building") return false;
  const startedAt = Date.parse(meta?.startedAt || "");
  // Unparseable or absent means we cannot prove it is live. Treat as stale so the wedge is
  // always recoverable rather than sometimes recoverable.
  if (!Number.isFinite(startedAt)) return true;
  return now - startedAt > SCREEN_BUILD_STALE_MS;
}

// Resolve one scheme's four operations to screen ids, marking what was inherited.
//
// Pure and exported: the inheritance rule is the part a reader is most likely to get wrong,
// and it is worth pinning without standing up Jira. An operation absent from the payload
// falls through to `default`, and the fact that it fell through is preserved rather than
// flattened -- an admin auditing a scheme needs to know which screens were chosen and which
// were merely inherited, because only the first was a decision.
export function resolveSchemeOperations(scheme, knownScreenIds = null) {
  const screens = scheme?.screens || {};
  const fallback = screens.default == null ? null : String(screens.default);

  return SCREEN_SCHEME_OPERATIONS.map((operation) => {
    const explicit = screens[operation];
    const hasExplicit = explicit != null && String(explicit).trim() !== "";
    const screenId = hasExplicit ? String(explicit) : fallback;

    return {
      schemeId: String(scheme.id),
      operation,
      screenId,
      inherited: !hasExplicit && screenId != null,
      // A scheme pointing at a screen the catalog does not contain keeps the dangling
      // reference rather than dropping the row. A broken mapping is a finding; omitting it
      // would make the scheme look correctly configured.
      dangling: screenId != null && knownScreenIds != null && !knownScreenIds.has(screenId),
    };
  });
}

// Hand the build to the queue consumer (900s) rather than running it in the caller's
// resolver invocation (25s). State is marked "building" here, not in the consumer, so the
// UI reflects the request immediately and rapid double-clicks collapse into one job.
export async function queueScreenSnapshotBuild(installationKey) {
  await ensureProjectStoreReady();
  await writeScreenSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });
  await inventorySnapshotQueue.push({
    body: { jobType: "build-screen-snapshot", installationKey },
  });
}

// Walk every screen's tabs and fields.
//
// Exported for its own tests because this is where the tri-state rule lives. A screen whose
// tabs cannot be read is recorded as UNRESOLVED with the reason, never as a screen with
// zero fields -- those look identical in a table and mean opposite things, and every
// finding downstream ("this field is on no screen") is only safe if they stay apart.
export async function collectScreenContents(screens) {
  const tabs = [];
  const fields = [];
  const screenRows = [];

  await mapWithConcurrency(screens, SCREEN_FETCH_CONCURRENCY, async (screen) => {
    const screenId = String(screen.id);
    const base = { id: screenId, name: screen.name || null, description: screen.description || null };

    let screenTabs;
    try {
      screenTabs = await getScreenTabs(screenId);
    } catch (error) {
      screenRows.push({
        ...base,
        tabCount: 0,
        fieldCount: 0,
        tabsResolved: "unresolved",
        unresolvedReason: `Tabs could not be read: ${String(error?.message || error)}`,
      });
      return;
    }

    let fieldCount = 0;
    let anyTabFailed = null;

    for (const [tabIndex, tab] of screenTabs.entries()) {
      const tabId = String(tab.id);
      let tabFields = [];
      try {
        tabFields = await getScreenTabFields(screenId, tabId);
      } catch (error) {
        // One unreadable tab does not invalidate the screen, but it does mean the field
        // list is incomplete -- so the screen is marked unresolved rather than reporting a
        // field count that silently omits a tab.
        anyTabFailed = `Tab ${tabId} fields could not be read: ${String(error?.message || error)}`;
        tabs.push({ screenId, tabId, name: tab.name || null, tabIndex, fieldCount: 0 });
        continue;
      }

      tabs.push({ screenId, tabId, name: tab.name || null, tabIndex, fieldCount: tabFields.length });
      fieldCount += tabFields.length;

      for (const [fieldIndex, field] of tabFields.entries()) {
        if (field?.id == null) continue;
        fields.push({
          screenId,
          tabId,
          fieldId: String(field.id),
          fieldName: field.name || null,
          tabIndex,
          fieldIndex,
        });
      }
    }

    screenRows.push({
      ...base,
      tabCount: screenTabs.length,
      fieldCount,
      tabsResolved: anyTabFailed ? "unresolved" : "resolved",
      unresolvedReason: anyTabFailed,
    });
  });

  return { screenRows, tabs, fields };
}

export async function buildScreenSnapshot(installationKey) {
  incrMetric(METRIC_NAMES.screenSnapshotStarted);
  await ensureProjectStoreReady();
  await writeScreenSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });

  try {
    const version = String(Date.now());

    // The scheme layers are tens of rows and independent of each other, so they go in
    // parallel. The screen walk is the expensive part and runs after, against a catalog
    // whose size is already known.
    const [screens, screenSchemes, itssList, itssMappings, projects] = await Promise.all([
      getAllScreens(),
      getAllScreenSchemes(),
      getAllIssueTypeScreenSchemes(),
      getIssueTypeScreenSchemeMappings(),
      getAllJiraProjects(),
    ]);

    // Sequenced after the others rather than joining the parallel batch: this endpoint
    // requires at least one projectId, so it cannot be issued until the project list is in
    // hand. Left in the batch it returns 400 and takes the whole build with it.
    //
    // Deliberately fatal rather than best-effort. Without these rows every issue type
    // screen scheme reports zero projects, which does not read as "unknown" -- it reads as
    // "nothing uses this", which is a finding. Failing loudly beats publishing a snapshot
    // that quietly recommends retiring every scheme on the site.
    const itssProjectRows = await getIssueTypeScreenSchemeProjects(projects.map((p) => p.id));

    const { screenRows, tabs, fields } = await collectScreenContents(screens);

    const knownScreenIds = new Set(screenRows.map((s) => String(s.id)));
    const schemeOperations = screenSchemes.flatMap((scheme) =>
      resolveSchemeOperations(scheme, knownScreenIds)
    );

    const mappingRows = itssMappings.map((m) => ({
      itssId: String(m.issueTypeScreenSchemeId),
      issueTypeId: String(m.issueTypeId),
      screenSchemeId: m.screenSchemeId == null ? null : String(m.screenSchemeId),
      isDefault: String(m.issueTypeId) === "default",
    }));

    // Project ids arrive as a bare list per ITSS; resolve them to keys and names so the
    // inventory is readable without a second lookup, and keep the row when a project is
    // not in the list rather than dropping it.
    const projectsById = new Map(projects.map((p) => [String(p.id), p]));
    const itssProjects = [];
    const projectCountByItss = new Map();

    for (const row of itssProjectRows) {
      const itssId = String(row?.issueTypeScreenScheme?.id ?? row?.issueTypeScreenSchemeId ?? "");
      if (!itssId) continue;
      for (const projectId of row.projectIds || []) {
        const project = projectsById.get(String(projectId));
        itssProjects.push({
          itssId,
          projectId: String(projectId),
          projectKey: project?.key || "UNKNOWN",
          projectName: project?.name || "Unknown project",
        });
        projectCountByItss.set(itssId, (projectCountByItss.get(itssId) || 0) + 1);
      }
    }

    const issueTypeScreenSchemes = itssList.map((s) => ({
      id: String(s.id),
      name: s.name || null,
      description: s.description || null,
      projectCount: projectCountByItss.get(String(s.id)) || 0,
    }));

    await replaceScreenSnapshot(installationKey, version, {
      screens: screenRows,
      tabs,
      fields,
      screenSchemes,
      schemeOperations,
      issueTypeScreenSchemes,
      itssMappings: mappingRows,
      itssProjects,
    });

    const unresolvedScreens = screenRows.filter((s) => s.tabsResolved !== "resolved").length;
    const completedAt = new Date().toISOString();

    await writeScreenSnapshotMeta(installationKey, {
      state: "ready",
      version,
      completedAt,
      refreshedAt: completedAt,
      totalScreens: screenRows.length,
      totalSchemes: screenSchemes.length,
      unresolvedScreens,
      lastError: null,
    });

    incrMetric(METRIC_NAMES.screenSnapshotCompleted);
    logger.info("screen-snapshot.completed", {
      version,
      screens: screenRows.length,
      tabs: tabs.length,
      fields: fields.length,
      screenSchemes: screenSchemes.length,
      issueTypeScreenSchemes: issueTypeScreenSchemes.length,
      // Reported rather than buried. A pass that could not read 30 of 760 screens is a
      // different artifact from one that read them all, and the number is the only way a
      // reader can tell.
      unresolvedScreens,
    });

    return { version, screens: screenRows.length, fields: fields.length, unresolvedScreens };
  } catch (error) {
    incrMetric(METRIC_NAMES.screenSnapshotFailed);
    const message = String(error?.message || error);
    logger.error("screen-snapshot.failed", { error: message });
    await writeScreenSnapshotMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: message,
    });
    throw error;
  }
}

// Read path for the UI. Queues a build when none has ever run, and recovers a wedged one.
