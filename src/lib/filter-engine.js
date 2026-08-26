// Builds the saved filter snapshot: every filter, what it depends on, and who can see it.
//
// Follows screen-engine.js, and is markedly cheaper than either of its predecessors. One
// paginated endpoint returns filters fifty at a time with every governance-relevant field
// already expanded -- no per-item walk, no second round trip.
//
// This was originally written as "a site with 2,000 filters is 40 calls, well inside a single
// 900s invocation", and it ran single-pass on that assumption. A real tenant disproved it:
// expanded with sharePermissions and subscriptions, filter/search is slow enough per page that
// a large estate runs out of invocation before it runs out of filters. A time budget was tried
// first, which turned a silent kill into a legible failure but still did not produce a
// snapshot.
//
// It is now resumable, which is what the issue crawl has always been. Each invocation fetches
// a fixed number of pages, appends them under the in-flight version, checkpoints its cursor and
// re-queues itself. Nothing here depends on finishing inside one invocation, so nothing here
// breaks when it cannot. See resumable-build.js -- the machinery is shared, and this file only
// says what a chunk of filters is.
//
// The expensive part is not the fetching, it is the JQL: every filter's query is scanned for
// the fields, projects and statuses it depends on. That is pure CPU over strings already in
// memory, and it is what turns a list of filters into the cross-pillar answer the rest of the
// app has been missing -- a field no automation rule writes and forty filters search on is
// not unused.

import { logger } from "./logger.js";
import { incrMetric, METRIC_NAMES, getFilterPage } from "./jira-api.js";
import { inventorySnapshotQueue } from "./queues.js";
import { isBuildStale, startResumableBuild, runBuildChunk } from "./resumable-build.js";
import { extractJqlReferences, normalizeJql } from "./jql-refs.js";
import { isSharedWithEveryone } from "./filter-insights.js";
import {
  ensureProjectStoreReady,
  readFilterSnapshotMeta,
  writeFilterSnapshotMeta,
  clearFilterSnapshotVersion,
  appendFilterSnapshot,
  pruneFilterSnapshots,
} from "./project-store.js";

// Matches SCREEN_BUILD_STALE_MS and for the same reason: the consumer ceiling is 900s, plus
// a minute so a build finishing right at the limit is never declared stale out from under
// itself.
export const FILTER_BUILD_STALE_MS = 16 * 60 * 1000;

// Pages of 50 filters per invocation.
//
// Sized like ISSUE_SCAN_CHUNK_PAGES (10) and for the same reason: small enough that a chunk
// finishes comfortably inside 900s even when every page is slow, which is the entire point --
// a chunk that might not fit is just the old bug with extra steps. Raising it trades resilience
// for fewer round trips, and the round trips were never the problem.
export const FILTER_CHUNK_PAGES = 10;
export const FILTER_PAGE_SIZE = 50;


// True when a build was started but can no longer be running.
//
// Delegates to the shared implementation so every pillar answers this question the same way.
// Kept as a named export because the resolver and both tabs import it by this name, and a
// rename would be churn with no reader benefit.
export function isFilterBuildStale(meta, now = Date.now()) {
  return isBuildStale(meta, now, FILTER_BUILD_STALE_MS);
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

// What a chunk of the filter inventory is.
//
// Everything else -- versioning, checkpointing, re-queueing, staleness, failure reporting --
// is in resumable-build.js. This object is the only part that knows about filters.
export const filterBuildSpec = {
  name: "filter-snapshot",
  staleMs: FILTER_BUILD_STALE_MS,
  readMeta: readFilterSnapshotMeta,
  writeMeta: writeFilterSnapshotMeta,
  clearVersion: clearFilterSnapshotVersion,
  prune: pruneFilterSnapshots,

  enqueue: (installationKey, { buildToken }) =>
    inventorySnapshotQueue.push({
      body: { jobType: "build-filter-snapshot", installationKey, buildToken },
    }),

  async runChunk({ installationKey, version, cursor }) {
    await ensureProjectStoreReady();

    let startAt = Number(cursor?.startAt) || 0;
    let total = Number(cursor?.total) || 0;
    let fetched = 0;
    let done = false;

    const filters = [];
    const refs = [];
    const shares = [];

    for (let page = 0; page < FILTER_CHUNK_PAGES; page++) {
      incrMetric(METRIC_NAMES.jiraRequest);
      const data = await getFilterPage(startAt, FILTER_PAGE_SIZE);
      const values = Array.isArray(data?.values) ? data.values : [];
      total = Number(data?.total ?? total) || total;

      for (const entry of values) {
        const shaped = shapeFilter(entry);
        // A filter with no id is not a filter. Skipped rather than thrown on: one malformed
        // entry must not cost the other 1,999.
        if (!shaped) continue;
        filters.push(shaped.filter);
        refs.push(...shaped.refs);
        shares.push(...shaped.shares);
      }

      fetched += values.length;
      startAt += values.length;

      // Same three exit conditions paginate() uses. Without the empty-page guard a page of zero
      // values with a non-zero total loops until the invocation dies.
      if (!values.length || data?.isLast === true || (total > 0 && startAt >= total)) {
        done = true;
        break;
      }
    }

    // Written before the checkpoint, so a chunk that lands its rows and then fails to update
    // the cursor is re-run and overwrites them rather than losing them. INSERT IGNORE makes
    // that repeat harmless.
    if (filters.length) {
      await appendFilterSnapshot(installationKey, version, { filters, refs, shares });
    }

    return {
      done,
      processed: fetched,
      totalExpected: total,
      cursor: done ? null : { startAt, total },
    };
  },

  finalize: ({ processed }) => ({ totalFilters: processed }),
};

// Queue a resumable build of the filter inventory.
export async function queueFilterSnapshotBuild(installationKey, { now = Date.now() } = {}) {
  await ensureProjectStoreReady();
  return startResumableBuild(filterBuildSpec, installationKey, { now });
}

// Run one chunk. This is what the queue consumer calls.
export async function buildFilterSnapshot(installationKey, message = {}, { now = Date.now() } = {}) {
  await ensureProjectStoreReady();
  return runBuildChunk(filterBuildSpec, installationKey, message, { now });
}
