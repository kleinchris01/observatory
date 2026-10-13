// Configuration change history (drift): the timeline read and the drift build.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES, getInstallationKey } from "../lib/jira-api.js";
import {
  ensureProjectStoreReady,
  readDriftSnapshotMeta,
  loadConfigChanges,
  changeCursorOf,
  loadConfigChangeSummary,
} from "../lib/project-store.js";
import { queueDriftSnapshotBuild, isDriftBuildStale, DRIFT_PILLARS } from "../lib/drift-engine.js";
import { readAdminConfig } from "./admin-config.js";

// The configuration change-history timeline: one page of detected adds / removes / modifies
// across every pillar drift tracks, plus a trailing-window summary for the headline. Keyset
// pagination on detected_at -- `before` is the last row's detectedAt from the previous page.
export const CHANGE_WINDOW_DAYS = 30;

export async function getChangeHistory({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readDriftSnapshotMeta(installationKey);
  const staleBuild = isDriftBuildStale(meta);

  if (!meta?.version) {
    return {
      state: meta?.state || "idle",
      staleBuild,
      startedAt: meta?.startedAt || null,
      neverBuilt: true,
      trackedPillars: DRIFT_PILLARS.map((p) => ({ key: p.pillar, label: p.label })),
      changes: [],
      summary: { total: 0, byPillar: {}, byKind: { added: 0, removed: 0, modified: 0 } },
      lastError: meta?.lastError || null,
    };
  }

  const pillar = payload?.pillar && payload.pillar !== "all" ? String(payload.pillar) : null;
  const kind = payload?.kind && payload.kind !== "all" ? String(payload.kind) : null;
  const before = payload?.before ? String(payload.before) : null;
  const limit = Math.max(1, Math.min(200, Number(payload?.limit) || 100));
  const windowStart = new Date(Date.now() - CHANGE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [changes, summary] = await Promise.all([
    loadConfigChanges(installationKey, { pillar, kind, before, limit: limit + 1 }),
    loadConfigChangeSummary(installationKey, windowStart),
  ]);

  const hasMore = changes.length > limit;
  return {
    state: meta.state || "ready",
    staleBuild,
    refreshedAt: meta.refreshedAt || null,
    neverBuilt: false,
    lastRunChanges: meta.lastRunChanges || 0,
    totalChanges: meta.totalChanges || 0,
    seededPillars: meta.seededPillars || [],
    trackedPillars: DRIFT_PILLARS.map((p) => ({ key: p.pillar, label: p.label })),
    windowDays: CHANGE_WINDOW_DAYS,
    changes: hasMore ? changes.slice(0, limit) : changes,
    nextCursor: hasMore ? changeCursorOf(changes[limit - 1]) : null,
    summary,
    lastError: meta.lastError || null,
  };
}

export async function buildChangeHistory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readDriftSnapshotMeta(installationKey);
  if (meta?.state === "building" && !isDriftBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before running a drift pass." };
  }

  await queueDriftSnapshotBuild(installationKey);
  return { queued: true };
}
