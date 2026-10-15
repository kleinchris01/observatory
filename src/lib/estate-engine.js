// Builds the estate-config snapshot: the global value lists (resolutions, priorities),
// versioned. One structural build like issue types -- two paginated endpoints, no per-item
// walk, well inside one consumer invocation.

import { logger } from "./logger.js";
import { inventorySnapshotQueue } from "./queues.js";
import { incrMetric, METRIC_NAMES, getAllResolutions, getAllPriorities } from "./jira-api.js";
import {
  ensureProjectStoreReady,
  writeEstateSnapshotMeta,
  readEstateSnapshotMeta,
  replaceEstateSnapshot,
} from "./project-store.js";

export const ESTATE_BUILD_STALE_MS = 16 * 60 * 1000;

export function isEstateBuildStale(meta, now = Date.now()) {
  if (meta?.state !== "building") return false;
  const startedAt = Date.parse(meta?.startedAt || "");
  if (!Number.isFinite(startedAt)) return true;
  return now - startedAt > ESTATE_BUILD_STALE_MS;
}

// Raw Jira value -> the row shape the store writes. Both endpoints share the same fields.
export function normalizeValue(raw, index) {
  return {
    id: String(raw?.id),
    name: raw?.name || null,
    description: raw?.description || null,
    isDefault: Boolean(raw?.isDefault),
    sortOrder: index,
  };
}

export async function queueEstateSnapshotBuild(installationKey) {
  await ensureProjectStoreReady();
  await writeEstateSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });
  await inventorySnapshotQueue.push({ body: { jobType: "build-estate-snapshot", installationKey } });
}

export async function buildEstateSnapshot(installationKey) {
  incrMetric(METRIC_NAMES.estateSnapshotStarted);
  await ensureProjectStoreReady();
  await writeEstateSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });

  try {
    const version = String(Date.now());
    const [rawResolutions, rawPriorities] = await Promise.all([
      getAllResolutions().catch(() => []),
      getAllPriorities().catch(() => []),
    ]);

    const resolutions = rawResolutions.filter((r) => r?.id != null).map(normalizeValue);
    const priorities = rawPriorities.filter((p) => p?.id != null).map(normalizeValue);

    await replaceEstateSnapshot(installationKey, version, { resolutions, priorities });

    const completedAt = new Date().toISOString();
    await writeEstateSnapshotMeta(installationKey, {
      state: "ready",
      version,
      completedAt,
      refreshedAt: completedAt,
      totalResolutions: resolutions.length,
      totalPriorities: priorities.length,
      lastError: null,
    });

    incrMetric(METRIC_NAMES.estateSnapshotCompleted);
    logger.info("estate-snapshot.completed", {
      version,
      resolutions: resolutions.length,
      priorities: priorities.length,
    });
    return { version, resolutions: resolutions.length, priorities: priorities.length };
  } catch (error) {
    incrMetric(METRIC_NAMES.estateSnapshotFailed);
    const message = String(error?.message || error);
    logger.error("estate-snapshot.failed", { error: message });
    await writeEstateSnapshotMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: message,
    });
    throw error;
  }
}
