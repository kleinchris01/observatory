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
// Phase three reads each gadget's CONFIGURATION, for the chain field -> filter -> dashboard:
// a Filter Results gadget points at a saved filter, that filter searches a field, and
// deleting the field breaks the dashboard three steps later with no error at any of them.
// Jira exposes the middle link only through dashboard item properties, so it costs further
// requests per gadget and needs read:dashboard.property:jira.
//
// It is read, never approximated. Gadget titles often contain the filter name ("Filter
// Results: Open Bugs"), and matching on that would produce a dependency graph that is right
// most of the time, which is the worst kind: every claim this app makes about what depends on
// what is load-bearing for a deletion decision. A gadget whose properties cannot be read is
// recorded with no filter rather than guessed at.

import { logger } from "./logger.js";
import {
  incrMetric,
  METRIC_NAMES,
  getDashboardPage,
  getDashboardGadgets,
  getGadgetFilterId,
  probeFilter,
  mapWithConcurrency,
} from "./jira-api.js";
import { shouldRetry } from "./analysis.js";
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
  loadGadgetsNeedingConfig,
  recordGadgetConfigs,
  countGadgetConfigCoverage,
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

// Gadget configs per invocation. Half the gadget chunk, because each one costs TWO requests
// rather than one -- Jira models gadget config as arbitrary item properties, so reading it is
// a list call and then a get.
export const DASHBOARD_CONFIG_CHUNK = 30;

// How many times one chunk may fail before it takes the whole build down with it.
//
// The gadget walk and config walk already catch per-item errors -- one 403 gadget does not
// stop the phase. But the dashboard/search page fetch in phase one is a single call with no
// per-item to fall back to, and a transient 4xx on one page (or an intermittent 400 the
// endpoint returns under load) would throw the whole build out and make the orchestrator
// re-run the stage from phase one. Instead the chunk re-queues itself a few times, keeping
// every phase already finished; only a chunk that fails this many times running fails the
// build.
export const MAX_DASHBOARD_CHUNK_ERRORS = 4;

// How many enumeration pages may be individually unreadable before the build gives up.
//
// A transient failure (429, 5xx) on one page is rethrown and handled by MAX_DASHBOARD_CHUNK_ERRORS
// above -- retrying the same offset is worth it. A NON-retryable one (a 400 Jira's
// dashboard/search returns permanently past a certain offset, or on a corrupt row) is not:
// retrying it nine times as the orchestrator restarts the stage from zero is exactly the
// "one 400 wedged the whole scan" failure this guards against. Such a page is skipped like a
// malformed dashboard entry already is -- 50 dashboards of coverage lost, not the pillar --
// and the count is surfaced on the scan page. Only when the endpoint is wholesale broken
// does the build actually fail.
export const MAX_DASHBOARD_SKIPPED_PAGES = 20;

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
    const chunkErrors = Number(cursor?.chunkErrors) || 0;

    try {
    if (phase === "list") {
      let startAt = Number(cursor?.startAt) || 0;
      let total = Number(cursor?.total) || 0;
      let skippedPages = Number(cursor?.skippedPages) || 0;
      let fetched = 0;
      let listDone = false;

      const dashboards = [];
      const shares = [];

      for (let page = 0; page < DASHBOARD_CHUNK_PAGES; page++) {
        incrMetric(METRIC_NAMES.jiraRequest);
        let data;
        try {
          data = await getDashboardPage(startAt, DASHBOARD_PAGE_SIZE);
        } catch (error) {
          // Transient (429, 5xx): rethrow so the chunk-level retry re-runs this same offset
          // -- worth retrying. Non-retryable (a 400 dashboard/search returns permanently past
          // an offset): skip this page and advance, the way a malformed entry is skipped
          // below. One bad page must not restart the whole pillar from zero.
          if (shouldRetry(error)) throw error;
          skippedPages += 1;
          logger.warn("dashboard-snapshot.page_skipped", {
            installationKey, startAt, skippedPages, error: String(error?.message || error),
          });
          if (skippedPages > MAX_DASHBOARD_SKIPPED_PAGES) {
            throw new Error(
              `dashboard/search unreadable after ${skippedPages} skipped pages: ${String(error?.message || error).slice(0, 180)}`
            );
          }
          startAt += DASHBOARD_PAGE_SIZE;
          if (total > 0 && startAt >= total) { listDone = true; break; }
          continue;
        }
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
      // listTotal is carried forward so the later phases can report a cumulative
      // totalExpected: without it, progress reads as "3,836 of 613" -- work summed across
      // three phases against a denominator that only counted the first.
      return {
        done: false,
        processed: fetched,
        totalExpected: total,
        cursor: listDone
          ? { phase: "gadgets", listTotal: total, skippedPages }
          : { phase: "list", startAt, total, skippedPages },
      };
    }

    // Phase two: fill in gadget counts, a batch at a time.
    //
    // Driven off the stored rows rather than a remembered list, so the batch survives being
    // carried across invocations in a TEXT cursor -- and so a redelivered message re-reads
    // what is actually still missing rather than trusting a stale list.
    if (phase === "gadgets") {
      const listTotal = Number(cursor?.listTotal) || Number(meta?.totalExpected) || 0;
      const skippedPages = Number(cursor?.skippedPages) || 0;
      const pending = await loadDashboardIdsNeedingGadgets(installationKey, version, DASHBOARD_GADGET_CHUNK);

      if (!pending.length) {
        // Gadgets are all walked; now read what each one points at. Take a one-off count of
        // the gadgets so phase three has a real denominator instead of borrowing phase one's.
        const { total: gadgetTotal } = await countGadgetConfigCoverage(installationKey, version);
        return {
          done: false,
          processed: 0,
          totalExpected: listTotal * 2 + gadgetTotal,
          cursor: { phase: "configs", walked: Number(cursor?.walked) || 0, listTotal, gadgetTotal, skippedPages },
          extra: { walked: Number(cursor?.walked) || 0, skippedPages },
        };
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
        totalExpected: listTotal ? listTotal * 2 : undefined,
        cursor: { phase: "gadgets", walked, listTotal, skippedPages },
        extra: { walked, skippedPages },
      };
    }

    // ── Phase three: what each gadget points at ─────────────────────────────
    //
    // This is the whole reason the dashboard pillar can answer "which dashboards break if this
    // field goes". A dashboard on its own is a list of gadget titles; "Filter Results: Open
    // Bugs" is a string, and matching it against filter names would produce a dependency graph
    // that is right most of the time -- which is the worst kind, because every claim this app
    // makes about what depends on what is load-bearing for a deletion decision.
    const listTotal = Number(cursor?.listTotal) || 0;
    const gadgetTotal = Number(cursor?.gadgetTotal) || 0;
    const skippedPages = Number(cursor?.skippedPages) || 0;
    // undefined, not 0, when a pre-change cursor is resumed with neither figure -- the build
    // runner then keeps whatever totalExpected the meta already has rather than zeroing it.
    const cumulativeTotal = listTotal || gadgetTotal ? listTotal * 2 + gadgetTotal : undefined;

    const pendingConfigs = await loadGadgetsNeedingConfig(installationKey, version, DASHBOARD_CONFIG_CHUNK);

    if (!pendingConfigs.length) {
      return {
        done: true,
        processed: 0,
        totalExpected: cumulativeTotal,
        extra: { walked: Number(cursor?.walked) || 0, listTotal, skippedPages },
      };
    }

    const configs = await mapWithConcurrency(pendingConfigs, DASHBOARD_FETCH_CONCURRENCY, async (g) => {
      try {
        const filterId = await getGadgetFilterId(g.dashboardId, g.gadgetId);
        return { ...g, filterId };
      } catch (error) {
        // Per gadget, not fatal. A gadget whose properties cannot be read is recorded as
        // walked-with-no-filter rather than retried forever -- the alternative is a build that
        // never terminates because one gadget 403s.
        logger.warn("dashboard-snapshot.gadget_config_failed", {
          installationKey, dashboardId: g.dashboardId, gadgetId: g.gadgetId,
          error: String(error?.message || error),
        });
        return { ...g, filterId: null };
      }
    });

    // Whether each gadget's filter can still be read. Once per distinct filter in this chunk:
    // a dozen gadgets on one filter are one question, not twelve.
    const filterIds = [...new Set(configs.map((c) => c.filterId).filter(Boolean).map(String))];
    const states = new Map();
    await mapWithConcurrency(filterIds, DASHBOARD_FETCH_CONCURRENCY, async (id) => {
      states.set(id, await probeFilter(id).catch(() => "unknown"));
    });
    for (const config of configs) {
      if (config.filterId) config.filterState = states.get(String(config.filterId)) || "unknown";
    }

    await recordGadgetConfigs(installationKey, version, configs);

    return {
      done: false,
      processed: configs.length,
      totalExpected: cumulativeTotal,
      cursor: { phase: "configs", walked: Number(cursor?.walked) || 0, listTotal, gadgetTotal, skippedPages },
      extra: { walked: Number(cursor?.walked) || 0, skippedPages },
    };
    } catch (error) {
      const message = String(error?.message || error);
      if (chunkErrors + 1 < MAX_DASHBOARD_CHUNK_ERRORS) {
        logger.warn("dashboard-snapshot.chunk_retry", {
          installationKey, phase, attempt: chunkErrors + 1, error: message,
        });
        // Re-queue the SAME chunk, carrying the phase's cursor forward untouched (plus the
        // bumped counter) so nothing already done is lost. A successful chunk returns a
        // cursor without chunkErrors, so the count resets on any recovery.
        return {
          done: false,
          processed: 0,
          cursor: { ...(cursor || { phase: "list" }), phase, chunkErrors: chunkErrors + 1 },
        };
      }
      // Budget spent -- let it fail the build. The orchestrator's stage retry takes over.
      throw error;
    }
  },

  finalize: ({ result }) => ({
    gadgetsWalked: Number(result?.extra?.walked) || 0,
    // The dashboard build never recorded how many dashboards it found, so the scan page's
    // "Produced" for this stage always read 0. listTotal is the count from the search API,
    // carried through the cursor to here.
    totalDashboards: Number(result?.extra?.listTotal) || 0,
    // Enumeration pages that 400'd permanently and were skipped rather than failing the
    // build. Non-zero means the inventory is complete-but-partial; the scan page shows it.
    pagesUnreadable: Number(result?.extra?.skippedPages) || 0,
  }),
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
