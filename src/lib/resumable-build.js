// The scan discipline the issue crawl already had, extracted so every other build can have it.
//
// Four inventories -- filters, dashboards, screens, workflows -- were each written as "fetch
// the whole estate into memory, then write it once". That works right up until the estate is
// large enough not to fit in a single 900s consumer invocation, at which point Forge kills the
// invocation mid-sentence: no error is written, the meta row stays "building" forever, and the
// tab shows a spinner with nothing behind it. On this site both the filter and the dashboard
// build died that way.
//
// The issue crawl never had that problem, because it was built differently: it does a FIXED
// chunk of work, writes a cursor to SQL, re-queues itself, and picks up where it left off. It
// never tries to finish inside one invocation, so it never depends on being able to. That is
// the whole difference, and it is not specific to issues.
//
// This module is that machine with the issue-specific parts lifted out. A caller supplies a
// spec saying how to fetch one chunk and how to store it; everything about versioning,
// checkpointing, re-queueing, staleness and failure reporting lives here, once.
//
// What deliberately does NOT live here: any decision about what a chunk should contain. A page
// of filters and a dashboard's gadget list are different units of work with different costs,
// and the right chunk size is a property of the endpoint, not of this harness.

import { logger } from "./logger.js";
import { makeJobToken } from "./jira-api.js";

// A build older than this is treated as abandoned rather than in flight.
//
// The consumer ceiling is 900s, plus a minute so a chunk finishing right at the limit is never
// declared stale out from under itself. Matches SCREEN_BUILD_STALE_MS and its siblings, which
// all chose this number for the same reason.
export const BUILD_STALE_MS = 16 * 60 * 1000;

// True when a build was started but can no longer be running.
//
// Resumable builds make this *less* likely, not impossible: a chunk can still be killed by a
// deploy, an unhandled error outside the try, or a queue message that never arrives. When that
// happens the row would otherwise stay "building" forever and suppress every future rebuild --
// a permanent wedge with no way out of the UI. Ask the clock, not the state alone.
//
// The clock is `updatedAt` rather than `startedAt`, and that is the point: a build that has
// been checkpointing every few minutes for an hour is healthy, and judging it by when it first
// started would declare a long, working build dead. Progress is what proves life.
export function isBuildStale(meta, now = Date.now(), staleMs = BUILD_STALE_MS) {
  if (meta?.state !== "building") return false;
  const heartbeat = Date.parse(meta?.updatedAt || meta?.startedAt || "");
  if (!Number.isFinite(heartbeat)) return true;
  return now - heartbeat > staleMs;
}

// How far along a build is, for the UI.
//
// `total` is whatever the endpoint claimed when it was last asked, which for a paginated search
// is a real total and for a two-phase walk is only known after phase one. It returns null
// rather than guessing: a progress bar that invents a denominator is worse than none, because
// it reads as knowledge.
export function buildProgress(meta) {
  const processed = Number(meta?.processed) || 0;
  const total = Number(meta?.totalExpected) || 0;
  return {
    processed,
    total: total > 0 ? total : null,
    ratio: total > 0 ? Math.min(1, processed / total) : null,
  };
}

/**
 * Start a resumable build, or decline to.
 *
 * Returns { queued: true, version, buildToken } when it started one, or
 * { queued: false, reason } when a healthy build is already running.
 *
 * The token is the thing that makes "already running" safe to enforce. Without it, the build's
 * own re-queued continuation message is indistinguishable from a second user clicking Rebuild,
 * and any check strict enough to stop the second would also stop the build resuming itself.
 */
export async function startResumableBuild(spec, installationKey, { now = Date.now() } = {}) {
  const existing = await spec.readMeta(installationKey);

  if (existing?.state === "building" && !isBuildStale(existing, now, spec.staleMs)) {
    return { queued: false, reason: "already-building", meta: existing };
  }

  const version = String(now);
  const buildToken = makeJobToken();

  // Clear anything a previous abandoned attempt left at this version. Versions are timestamps,
  // so a collision needs two builds in the same millisecond -- but a build that died and is
  // being restarted has rows under its OWN version, which prune handles at the end. This clear
  // is about the version we are about to write, not the one we are replacing.
  await spec.clearVersion(installationKey, version);

  await spec.writeMeta(installationKey, {
    state: "building",
    buildingVersion: version,
    buildToken,
    buildCursor: null,
    processed: 0,
    totalExpected: 0,
    startedAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    lastError: null,
  });

  await spec.enqueue(installationKey, { buildToken });

  logger.info(`${spec.name}.build_started`, { installationKey, version, buildToken });
  return { queued: true, version, buildToken };
}

/**
 * Run one chunk of a resumable build.
 *
 * This is what the queue consumer calls. It does a bounded amount of work, checkpoints, and
 * either re-queues itself or finalizes. It is deliberately the only place that writes the
 * terminal states, so "ready" cannot be reached without the cursor being exhausted.
 */
export async function runBuildChunk(spec, installationKey, message = {}, _options = {}) {
  const meta = await spec.readMeta(installationKey);

  if (meta?.state !== "building") {
    // The build finished, failed, or was superseded between this message being queued and
    // being delivered. Dropping is correct: re-running a chunk of a completed build would
    // write rows under a version nothing will ever publish.
    logger.info(`${spec.name}.chunk_ignored_not_building`, { installationKey, state: meta?.state ?? null });
    return { ignored: true, reason: "not-building" };
  }

  // A message from a superseded build. This happens whenever someone rebuilds over a stale
  // build: the old run's in-flight message can still arrive afterwards, and without this check
  // it would interleave its rows with the new run's under a different version.
  if (message.buildToken && meta.buildToken && message.buildToken !== meta.buildToken) {
    logger.warn(`${spec.name}.chunk_ignored_stale_token`, { installationKey });
    return { ignored: true, reason: "stale-token" };
  }

  const version = meta.buildingVersion;
  if (!version) {
    // Building with no version to write into. Recoverable only by starting over, and saying so
    // beats looping on a chunk that can never land anywhere.
    await failBuild(spec, installationKey, "Build state is missing its version; start a new build.");
    return { failed: true };
  }

  try {
    const cursor = parseCursor(meta.buildCursor);
    const result = await spec.runChunk({ installationKey, version, cursor, meta });

    const processed = Number(meta.processed || 0) + Number(result.processed || 0);
    const totalExpected = Number(result.totalExpected ?? meta.totalExpected ?? 0) || 0;

    if (!result.done) {
      await spec.writeMeta(installationKey, {
        state: "building",
        buildingVersion: version,
        buildToken: meta.buildToken,
        buildCursor: JSON.stringify(result.cursor ?? null),
        processed,
        totalExpected,
        // The heartbeat. Written every chunk precisely so isBuildStale can tell a long healthy
        // build from a dead one -- without it, any build outlasting the stale window would be
        // declared abandoned while it was still working.
        updatedAt: new Date().toISOString(),
        lastError: null,
      });

      await spec.enqueue(installationKey, { buildToken: meta.buildToken });
      logger.info(`${spec.name}.chunk_checkpointed`, { installationKey, version, processed, totalExpected });
      return { checkpointed: true, processed, totalExpected };
    }

    // Done. Finalize first, publish second: the version becomes readable only once the rows
    // behind it are complete, so a reader can never see a half-built snapshot as current.
    const finalPatch = (await spec.finalize?.({ installationKey, version, processed, result })) || {};
    const refreshedAt = new Date().toISOString();

    await spec.writeMeta(installationKey, {
      version,
      state: "ready",
      buildCursor: null,
      buildToken: null,
      processed,
      totalExpected: totalExpected || processed,
      completedAt: refreshedAt,
      refreshedAt,
      updatedAt: refreshedAt,
      lastError: null,
      ...finalPatch,
    });

    // Pruned after publish, like every other snapshot here: the previous version is dead the
    // moment this one is readable, and leaving it costs storage for nothing.
    await spec.prune?.(installationKey, version).catch((error) => {
      logger.warn(`${spec.name}.prune_failed`, { installationKey, error: String(error?.message || error) });
    });

    logger.info(`${spec.name}.build_completed`, { installationKey, version, processed });
    return { completed: true, version, processed };
  } catch (error) {
    await failBuild(spec, installationKey, String(error?.message || error));
    throw error;
  }
}

// Record a failure and stop. Never rethrown from here -- the caller decides, because the
// consumer must not let Forge retry a message forever.
async function failBuild(spec, installationKey, message) {
  logger.error(`${spec.name}.build_failed`, { installationKey, error: message });
  await spec
    .writeMeta(installationKey, {
      state: "failed",
      buildCursor: null,
      buildToken: null,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastError: message.slice(0, 500),
    })
    .catch(() => {});
}

// Cursors round-trip through a TEXT column as JSON so a build can carry whatever shape it
// needs -- a page offset, a phase marker, a list of remaining ids -- without a migration per
// pillar. A corrupt cursor restarts the build rather than throwing: the rows are keyed by
// version and will be overwritten, so starting over is safe, where guessing is not.
function parseCursor(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    logger.warn("resumable-build.cursor_unparseable", { raw: String(raw).slice(0, 120) });
    return null;
  }
}
