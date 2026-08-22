// Builds the saved filter snapshot: every filter, what it depends on, and who can see it.
//
// Follows screen-engine.js, and is markedly cheaper than either of its predecessors. One
// paginated endpoint returns filters fifty at a time with every governance-relevant field
// already expanded -- no per-item walk, no second round trip.
//
// This was originally written as "a site with 2,000 filters is 40 calls, well inside a single
// 900s invocation", and it runs single-pass on that assumption. A real tenant then failed to
// finish: expanded with sharePermissions and subscriptions, filter/search is slow enough per
// page that a large enough estate runs out of invocation before it runs out of filters. The
// budget below is the honest version of that assumption -- single-pass is still the design,
// but it now admits when single-pass was not enough instead of being killed mid-sentence.
// Making this resumable is the real fix if the budget is ever actually hit.
//
// The expensive part is not the fetching, it is the JQL: every filter's query is scanned for
// the fields, projects and statuses it depends on. That is pure CPU over strings already in
// memory, and it is what turns a list of filters into the cross-pillar answer the rest of the
// app has been missing -- a field no automation rule writes and forty filters search on is
// not unused.

import { logger } from "./logger.js";
import { incrMetric, METRIC_NAMES, getAllFilters } from "./jira-api.js";
import { extractJqlReferences, normalizeJql } from "./jql-refs.js";
import { isSharedWithEveryone } from "./filter-insights.js";
import {
  ensureProjectStoreReady,
  readFilterSnapshotMeta,
  writeFilterSnapshotMeta,
  replaceFilterSnapshot,
  pruneFilterSnapshots,
} from "./project-store.js";

// Matches SCREEN_BUILD_STALE_MS and for the same reason: the consumer ceiling is 900s, plus
// a minute so a build finishing right at the limit is never declared stale out from under
// itself.
export const FILTER_BUILD_STALE_MS = 16 * 60 * 1000;

// How long the fetch may run before it gives up on its own terms.
//
// The consumer ceiling is 900s and filter/search is expanded with sharePermissions and
// subscriptions, which makes it one of the slower endpoints Jira offers -- 50 rows a page,
// no parallelism. A site with enough filters will not finish, and being hard-killed is the
// worst way to not finish: no error is written, the row stays "building", and the next
// person sees a spinner with no explanation. Stopping at ten minutes leaves time to write a
// failure that says what happened, and to say how far it got.
export const FILTER_FETCH_BUDGET_MS = 10 * 60 * 1000;

// How often progress is written while the fetch runs.
//
// Not every page: that would be a SQL write per 50 filters for no extra insight. Every
// thirty seconds is enough that a build killed anyway still leaves a usable trail.
const PROGRESS_INTERVAL_MS = 30 * 1000;

// True when a build was started but can no longer be running.
//
// A Forge invocation timeout is a hard kill: state is marked "building" before the first API
// call and the catch that would mark it "failed" never runs. Without this the row stays
// "building" forever and every future rebuild is suppressed as already-running -- a permanent
// wedge with no way out of the UI. Ask the clock, not the state alone.
export function isFilterBuildStale(meta, now = Date.now()) {
  if (meta?.state !== "building") return false;
  const startedAt = Date.parse(meta?.startedAt || "");
  if (!Number.isFinite(startedAt)) return true;
  return now - startedAt > FILTER_BUILD_STALE_MS;
}

// Jira's filter payload, flattened into the row shape plus its references.
//
// Exported and pure so the shredding is testable without a Jira: the shapes this has to
// survive -- a missing owner, an absent subscriptions block, sharePermissions returning an
// object instead of an array -- are all things a real tenant produces and none of them are
// worth discovering in production.
export function shapeFilter(raw) {
  const id = String(raw?.id ?? "").trim();
  if (!id) return null;

  const jql = typeof raw?.jql === "string" ? raw.jql : "";
  const refs = extractJqlReferences(jql);

  // Jira returns subscriptions as { size, items } on some payloads and a bare array on
  // others. Both mean the same thing and neither is documented as canonical.
  const subscriptions = raw?.subscriptions;
  const subscriptionCount = Array.isArray(subscriptions)
    ? subscriptions.length
    : Number(subscriptions?.size) || 0;

  const shares = Array.isArray(raw?.sharePermissions) ? raw.sharePermissions : [];
  const owner = raw?.owner ?? null;

  return {
    filter: {
      id,
      name: raw?.name ?? null,
      description: raw?.description ?? null,
      jql,
      jqlNormalized: normalizeJql(jql),
      ownerAccountId: owner?.accountId ?? null,
      ownerName: owner?.displayName ?? null,
      // Tri-state. Jira omits `owner` entirely once the account is deleted, and that is a
      // different fact from an account that exists and is switched off -- the first takes
      // the filter with it.
      ownerActive: owner ? owner.active !== false : null,
      subscriptionCount,
      favouritedCount: Number(raw?.favouritedCount) || 0,
      sharedWithEveryone: isSharedWithEveryone(shares),
      shareCount: shares.length,
      // Requested but optional: approximateLastUsed is the newest field on this endpoint and
      // the likeliest to be absent. Null means "we could not tell", never "never opened".
      lastUsedAt: raw?.approximateLastUsed ?? null,
      viewUrl: raw?.viewUrl ?? null,
    },
    refs: [
      ...refs.fields.map((label) => ({ filterId: id, kind: "field", label })),
      ...refs.projects.map((label) => ({ filterId: id, kind: "project", label })),
      ...refs.statuses.map((label) => ({ filterId: id, kind: "status", label })),
    ],
    shares: shares.map((share, index) => ({
      filterId: id,
      index,
      type: String(share?.type || "unknown"),
      // Jira nests the target under a key named after the type, which is why this reads a
      // union rather than one field.
      targetId: share?.project?.id ?? share?.group?.groupId ?? share?.role?.id ?? share?.user?.accountId ?? null,
      targetName: share?.project?.name ?? share?.group?.name ?? share?.role?.name ?? share?.user?.displayName ?? null,
      roleId: share?.role?.id ?? null,
    })),
  };
}

export async function buildFilterSnapshot(installationKey, { now = Date.now() } = {}) {
  await ensureProjectStoreReady();

  const existing = await readFilterSnapshotMeta(installationKey);
  if (existing?.state === "building" && !isFilterBuildStale(existing, now)) {
    return { skipped: true, reason: "already-building" };
  }

  const version = String(now);
  const startedAt = new Date(now).toISOString();
  await writeFilterSnapshotMeta(installationKey, {
    state: "building", startedAt, completedAt: null, lastError: null,
  });

  try {
    incrMetric(METRIC_NAMES.jiraRequest);

    // Progress is recorded in total_filters, which is otherwise unwritten until the build
    // succeeds. It costs no migration and turns a wedged row from "something went wrong" into
    // "it read 3,400 filters and then stopped", which is the difference between guessing at
    // the cause and knowing it.
    let lastProgressAt = now;
    const raw = await getAllFilters({
      onPage: async ({ fetched }) => {
        const elapsed = Date.now() - now;
        if (elapsed > FILTER_FETCH_BUDGET_MS) {
          throw new Error(
            `Stopped after ${Math.round(elapsed / 1000)}s having read ${fetched} filters. ` +
            "This site has more saved filters than one pass can read within Forge's time limit."
          );
        }
        if (Date.now() - lastProgressAt < PROGRESS_INTERVAL_MS) return;
        lastProgressAt = Date.now();
        // Best-effort. A progress write that fails must not abort a build that is otherwise
        // healthy -- the number is a convenience, the snapshot is the job.
        await writeFilterSnapshotMeta(installationKey, { totalFilters: fetched })
          .catch(() => {});
      },
    });

    const filters = [];
    const refs = [];
    const shares = [];
    for (const entry of raw) {
      const shaped = shapeFilter(entry);
      // A filter with no id is not a filter. Skipped rather than thrown on: one malformed
      // entry must not cost the other 1,999.
      if (!shaped) continue;
      filters.push(shaped.filter);
      refs.push(...shaped.refs);
      shares.push(...shaped.shares);
    }

    await replaceFilterSnapshot(installationKey, version, { filters, refs, shares });

    const refreshedAt = new Date().toISOString();
    await writeFilterSnapshotMeta(installationKey, {
      version,
      state: "ready",
      completedAt: refreshedAt,
      refreshedAt,
      totalFilters: filters.length,
      lastError: null,
    });

    // Pruned inline after success, like the other snapshots: the previous version is dead the
    // moment this one is readable, and leaving it costs storage for nothing.
    await pruneFilterSnapshots(installationKey, version).catch((error) => {
      logger.warn("filter-snapshot.prune_failed", { installationKey, error: String(error?.message || error) });
    });

    logger.info("filter-snapshot.built", {
      installationKey, version, filters: filters.length, refs: refs.length, shares: shares.length,
    });
    return { built: true, version, filters: filters.length, refs: refs.length };
  } catch (error) {
    logger.error("filter-snapshot.failed", { installationKey, error: String(error?.message || error) });
    await writeFilterSnapshotMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: String(error?.message || error).slice(0, 500),
    }).catch(() => {});
    throw error;
  }
}
