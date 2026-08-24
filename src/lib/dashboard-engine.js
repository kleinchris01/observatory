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
  getAllDashboards,
  getDashboardGadgets,
  mapWithConcurrency,
} from "./jira-api.js";
import { isSharedWithEveryone, isEditableByEveryone } from "./dashboard-insights.js";
import {
  ensureProjectStoreReady,
  readDashboardSnapshotMeta,
  writeDashboardSnapshotMeta,
  replaceDashboardSnapshot,
  pruneDashboardSnapshots,
} from "./project-store.js";

// Matches SCREEN_BUILD_STALE_MS and FILTER_BUILD_STALE_MS: the consumer ceiling is 900s, plus
// a minute so a build finishing right at the limit is never declared stale out from under
// itself.
export const DASHBOARD_BUILD_STALE_MS = 16 * 60 * 1000;

// 4, matching the app's own limiter rather than racing it -- the same concurrency the screen
// build's per-item walk uses.
export const DASHBOARD_FETCH_CONCURRENCY = 4;

// True when a build was started but can no longer be running.
//
// A Forge invocation timeout is a hard kill: state is marked "building" before the first API
// call and the catch that would mark it "failed" never runs. Without this the row stays
// "building" forever and every future rebuild is suppressed as already-running.
export function isDashboardBuildStale(meta, now = Date.now()) {
  if (meta?.state !== "building") return false;
  const startedAt = Date.parse(meta?.startedAt || "");
  if (!Number.isFinite(startedAt)) return true;
  return now - startedAt > DASHBOARD_BUILD_STALE_MS;
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

export async function buildDashboardSnapshot(installationKey, { now = Date.now() } = {}) {
  await ensureProjectStoreReady();

  const existing = await readDashboardSnapshotMeta(installationKey);
  if (existing?.state === "building" && !isDashboardBuildStale(existing, now)) {
    return { skipped: true, reason: "already-building" };
  }

  const version = String(now);
  await writeDashboardSnapshotMeta(installationKey, {
    state: "building", startedAt: new Date(now).toISOString(), completedAt: null, lastError: null,
  });

  try {
    incrMetric(METRIC_NAMES.jiraRequest);
    const raw = await getAllDashboards();

    const dashboards = [];
    const shares = [];
    for (const entry of raw) {
      const shaped = shapeDashboard(entry);
      // A dashboard with no id is not a dashboard. Skipped rather than thrown on: one
      // malformed entry must not cost the rest.
      if (!shaped) continue;
      dashboards.push(shaped.dashboard);
      shares.push(...shaped.shares);
    }

    // The per-dashboard half. A failure here is per dashboard rather than fatal: the one that
    // failed keeps gadgetCount null and reads as unmeasured, and the other 200 still land.
    const gadgets = [];
    let walked = 0;
    const results = await mapWithConcurrency(dashboards, DASHBOARD_FETCH_CONCURRENCY, async (dashboard) => {
      try {
        const list = await getDashboardGadgets(dashboard.id);
        return { id: dashboard.id, gadgets: list.map((g) => shapeGadget(dashboard.id, g)).filter(Boolean) };
      } catch (error) {
        logger.warn("dashboard-snapshot.gadget_walk_failed", {
          installationKey, dashboardId: dashboard.id, error: String(error?.message || error),
        });
        return { id: dashboard.id, gadgets: null };
      }
    });

    const byId = new Map(dashboards.map((d) => [d.id, d]));
    for (const result of results) {
      if (!result?.gadgets) continue;
      walked += 1;
      const dashboard = byId.get(result.id);
      if (dashboard) dashboard.gadgetCount = result.gadgets.length;
      gadgets.push(...result.gadgets);
    }

    await replaceDashboardSnapshot(installationKey, version, { dashboards, gadgets, shares });

    const refreshedAt = new Date().toISOString();
    await writeDashboardSnapshotMeta(installationKey, {
      version,
      state: "ready",
      completedAt: refreshedAt,
      refreshedAt,
      totalDashboards: dashboards.length,
      // Recorded so the tab can caveat its own number: a pass that reached 180 of 200
      // dashboards cannot claim any of the other 20 is empty.
      gadgetsWalked: walked,
      lastError: null,
    });

    await pruneDashboardSnapshots(installationKey, version).catch((error) => {
      logger.warn("dashboard-snapshot.prune_failed", { installationKey, error: String(error?.message || error) });
    });

    logger.info("dashboard-snapshot.built", {
      installationKey, version, dashboards: dashboards.length, gadgets: gadgets.length, walked,
    });
    return { built: true, version, dashboards: dashboards.length, gadgets: gadgets.length, walked };
  } catch (error) {
    logger.error("dashboard-snapshot.failed", { installationKey, error: String(error?.message || error) });
    await writeDashboardSnapshotMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: String(error?.message || error).slice(0, 500),
    }).catch(() => {});
    throw error;
  }
}
