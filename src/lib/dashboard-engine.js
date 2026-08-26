// Builds the dashboard snapshot: every dashboard, who owns it, who can see and change it,
// and what is on it.
//
// Follows filter-engine.js for the enumeration and screen-engine.js for the per-item walk,
// because it needs both: one paginated endpoint lists the dashboards, and the gadgets on each
// one are a separate call. That second half is what makes this more expensive than the filter
// build and cheaper than the screen build -- one call per dashboard, and a site's dashboard
// count is in the hundreds where its screen count was in the hundreds too but with a tab and
// field walk underneath each.
//
// What this deliberately does NOT do is read gadget CONFIGURATION.
//
// The chain worth having is field -> filter -> dashboard: a Filter Results gadget points at a
// saved filter, that filter searches a field, and deleting the field breaks the dashboard
// three steps later with no error at any of them. Jira exposes the middle link only through
// dashboard item properties -- GET .../items/{itemId}/properties, then a second call per
// property key -- which is two further requests per gadget on top of one per dashboard, and
// needs read:dashboard.property:jira as well.
//
// So it is not attempted rather than approximated. Gadget titles often contain the filter
// name ("Filter Results: Open Bugs") and matching on that would produce a dependency graph
// that is right most of the time, which is the worst kind: every claim this app makes about
// what depends on what is load-bearing for a deletion decision. The module key and title are
// stored so the join can be added later without a re-enumeration.

import { logger } from "./logger.js";
import {
  incrMetric,
  METRIC_NAMES,
  getDashboardPage,
  getDashboardGadgets,
  mapWithConcurrency,
} from "./jira-api.js";
import { inventorySnapshotQueue } from "./queues.js";
import { isBuildStale, startResumableBuild, runBuildChunk } from "./resumable-build.js";
import { isSharedWithEveryone, isEditableByEveryone } from "./dashboard-insights.js";
import {
  ensureProjectStoreReady,
  readDashboardSnapshotMeta,
  writeDashboardSnapshotMeta,
  clearDashboardSnapshotVersion,
  appendDashboardSnapshot,
  loadDashboardIdsNeedingGadgets,
  pruneDashboardSnapshots,
} from "./project-store.js";

// Matches SCREEN_BUILD_STALE_MS and FILTER_BUILD_STALE_MS: the consumer ceiling is 900s, plus
// a minute so a build finishing right at the limit is never declared stale out from under
// itself.
export const DASHBOARD_BUILD_STALE_MS = 16 * 60 * 1000;

// 4, matching the app's own limiter rather than racing it -- the same concurrency the screen
// build's per-item walk uses.
export const DASHBOARD_FETCH_CONCURRENCY = 4;

// One invocation's worth of work, per phase.
//
// The dashboard build is the expensive one: enumerating is a paginated search, but the gadget
// walk is one request PER dashboard. On a large site that is thousands of sequential-ish calls,
// and it is why this build died at the 900s ceiling. Chunking is sized so neither phase can
// approach the limit -- 10 pages to enumerate, 60 dashboards to walk at concurrency 4.
export const DASHBOARD_CHUNK_PAGES = 10;
export const DASHBOARD_PAGE_SIZE = 50;
export const DASHBOARD_GADGET_CHUNK = 60;

// True when a build was started but can no longer be running.
//
// A Forge invocation timeout is a hard kill: state is marked "building" before the first API
// call and the catch that would mark it "failed" never runs. Without this the row stays
// "building" forever and every future rebuild is suppressed as already-running.
export function isDashboardBuildStale(meta, now = Date.now()) {
  return isBuildStale(meta, now, DASHBOARD_BUILD_STALE_MS);
}

// Jira's dashboard payload, flattened into the row shape plus its shares.
//
// Exported and pure so the shredding is testable without a Jira. gadgetCount starts as null
// and is filled in by the walk -- a dashboard the walk never reached keeps it, and the
// analysis reads that as "not measured" rather than as "empty".
export function shapeDashboard(raw) {
  const id = String(raw?.id ?? "").trim();
  if (!id) return null;

  const shares = Array.isArray(raw?.sharePermissions) ? raw.sharePermissions : [];
  const editShares = Array.isArray(raw?.editPermissions) ? raw.editPermissions : [];
  const owner = raw?.owner ?? null;

  const shareRows = [
    ...shares.map((share, index) => ({ kind: "view", index, share })),
    ...editShares.map((share, index) => ({ kind: "edit", index, share })),
  ].map(({ kind, index, share }) => ({
    dashboardId: id,
    kind,
    index,
    type: String(share?.type || "unknown"),
    // Jira nests the target under a key named after the type, which is why this reads a union.
    targetId: share?.project?.id ?? share?.group?.groupId ?? share?.role?.id ?? share?.user?.accountId ?? null,
    targetName: share?.project?.name ?? share?.group?.name ?? share?.role?.name ?? share?.user?.displayName ?? null,
  }));

  return {
    dashboard: {
      id,
      name: raw?.name ?? null,
      description: raw?.description ?? null,
      ownerAccountId: owner?.accountId ?? null,
      ownerName: owner?.displayName ?? null,
      // Tri-state. Jira omits `owner` entirely once the account is deleted, and that is a
      // different fact from an account that exists and is switched off.
      ownerActive: owner ? owner.active !== false : null,
      // The count of people who have favourited it -- the closest thing Jira gives to "is
      // anyone using this". Not a view count, so it bounds a claim about neglect rather than
      // proving one.
      popularity: Number(raw?.popularity ?? raw?.favouritedCount) || 0,
      gadgetCount: null,
      sharedWithEveryone: isSharedWithEveryone(shares),
      editableByEveryone: isEditableByEveryone(editShares),
      shareCount: shares.length,
      viewUrl: raw?.view ?? raw?.viewUrl ?? null,
    },
    shares: shareRows,
  };
}

export function shapeGadget(dashboardId, raw) {
  const id = String(raw?.id ?? "").trim();
  if (!id) return null;
  return {
    dashboardId: String(dashboardId),
    id,
    title: raw?.title ?? null,
    // The handle a later pass joins on, once gadget properties are readable.
    moduleKey: raw?.moduleKey ?? raw?.uri ?? null,
    row: raw?.position?.row ?? null,
    column: raw?.position?.column ?? null,
  };
}

// What a chunk of the dashboard inventory is.
//
// Two phases, because the work has two shapes. Phase "list" pages through dashboard/search and
// stores each page. Phase "gadgets" walks the stored dashboards a batch at a time, filling in
// gadget counts. The cursor carries which phase it is in, so a build resumes into the right one
// rather than restarting the cheap phase every invocation.
export const dashboardBuildSpec = {
  name: "dashboard-snapshot",
  staleMs: DASHBOARD_BUILD_STALE_MS,
  readMeta: readDashboardSnapshotMeta,
  writeMeta: writeDashboardSnapshotMeta,
  clearVersion: clearDashboardSnapshotVersion,
  prune: pruneDashboardSnapshots,

  enqueue: (installationKey, { buildToken }) =>
    inventorySnapshotQueue.push({
      body: { jobType: "build-dashboard-snapshot", installationKey, buildToken },
    }),

  async runChunk({ installationKey, version, cursor }) {
    await ensureProjectStoreReady();
    const phase = cursor?.phase || "list";

    if (phase === "list") {
      let startAt = Number(cursor?.startAt) || 0;
      let total = Number(cursor?.total) || 0;
      let fetched = 0;
      let listDone = false;

      const dashboards = [];
      const shares = [];

      for (let page = 0; page < DASHBOARD_CHUNK_PAGES; page++) {
        incrMetric(METRIC_NAMES.jiraRequest);
        const data = await getDashboardPage(startAt, DASHBOARD_PAGE_SIZE);
        const values = Array.isArray(data?.values) ? data.values : [];
        total = Number(data?.total ?? total) || total;

        for (const entry of values) {
          const shaped = shapeDashboard(entry);
          // A dashboard with no id is not a dashboard. Skipped rather than thrown on: one
          // malformed entry must not cost the rest.
          if (!shaped) continue;
          dashboards.push(shaped.dashboard);
          shares.push(...shaped.shares);
        }

        fetched += values.length;
        startAt += values.length;

        if (!values.length || data?.isLast === true || (total > 0 && startAt >= total)) {
          listDone = true;
          break;
        }
      }

      if (dashboards.length) {
        await appendDashboardSnapshot(installationKey, version, { dashboards, shares });
      }

      // Enumeration finished only moves to the next phase -- it is not the build finishing.
      return {
        done: false,
        processed: fetched,
        totalExpected: total,
        cursor: listDone ? { phase: "gadgets" } : { phase: "list", startAt, total },
      };
    }

    // Phase two: fill in gadget counts, a batch at a time.
    //
    // Driven off the stored rows rather than a remembered list, so the batch survives being
    // carried across invocations in a TEXT cursor -- and so a redelivered message re-reads
    // what is actually still missing rather than trusting a stale list.
    const pending = await loadDashboardIdsNeedingGadgets(installationKey, version, DASHBOARD_GADGET_CHUNK);

    if (!pending.length) {
      return { done: true, processed: 0, extra: { walked: Number(cursor?.walked) || 0 } };
    }

    const gadgets = [];
    let walked = Number(cursor?.walked) || 0;

    const results = await mapWithConcurrency(pending, DASHBOARD_FETCH_CONCURRENCY, async (dashboardId) => {
      try {
        const list = await getDashboardGadgets(dashboardId);
        return { id: dashboardId, gadgets: list.map((g) => shapeGadget(dashboardId, g)).filter(Boolean) };
      } catch (error) {
        // Per dashboard rather than fatal: the one that failed keeps gadgetCount null and
        // reads as unmeasured, and the rest still land.
        logger.warn("dashboard-snapshot.gadget_walk_failed", {
          installationKey, dashboardId, error: String(error?.message || error),
        });
        return { id: dashboardId, gadgets: null };
      }
    });

    const counts = [];
    for (const result of results) {
      // A null gadget list still records a count of null, which is what marks the dashboard
      // walked-and-unreadable rather than leaving it to be retried forever.
      counts.push({ id: result.id, gadgetCount: result.gadgets ? result.gadgets.length : null });
      if (!result.gadgets) continue;
      walked += 1;
      gadgets.push(...result.gadgets);
    }

    await appendDashboardSnapshot(installationKey, version, { gadgets, gadgetCounts: counts });

    return {
      done: false,
      processed: pending.length,
      cursor: { phase: "gadgets", walked },
      extra: { walked },
    };
  },

  finalize: ({ result }) => ({ gadgetsWalked: Number(result?.extra?.walked) || 0 }),
};

// Queue a resumable build of the dashboard inventory.
export async function queueDashboardSnapshotBuild(installationKey, { now = Date.now() } = {}) {
  await ensureProjectStoreReady();
  return startResumableBuild(dashboardBuildSpec, installationKey, { now });
}

// Run one chunk. This is what the queue consumer calls.
export async function buildDashboardSnapshot(installationKey, message = {}, { now = Date.now() } = {}) {
  await ensureProjectStoreReady();
  return runBuildChunk(dashboardBuildSpec, installationKey, message, { now });
}
