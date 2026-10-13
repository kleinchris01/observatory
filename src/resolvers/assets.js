// Assets (CMDB) pillar: structure inventory, builds, the object-count crawl and the API probe.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES, getInstallationKey } from "../lib/jira-api.js";
import {
  ensureProjectStoreReady,
  readAssetSnapshotMeta,
  loadAssetSchemas,
  loadAssetObjectTypes,
  loadAssetAttributes,
  loadAssetTypeCounts,
  readAssetTypeCountMeta,
} from "../lib/project-store.js";
import { probeAssetsApi as probeAssetsApiProbe } from "../lib/asset-probe.js";
import {
  queueAssetSnapshotBuild,
  isAssetBuildStale,
  queueAssetTypeCountBuild,
  isAssetTypeCountBuildStale,
} from "../lib/asset-engine.js";
import { summarizeAssetInsights } from "../lib/asset-insights.js";
import { readAdminConfig } from "./admin-config.js";

// The JSM Assets (CMDB) pillar's read: object schemas, their object types and those types'
// attributes, plus the governance summary. `assetsEnabled: false` is a first-class state --
// the build ran and Assets is not licensed here -- and the tab renders the explanation
// rather than an empty catalogue.
export async function getAssetInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readAssetSnapshotMeta(installationKey);
  const staleBuild = isAssetBuildStale(meta);

  if (meta?.state === "unavailable") {
    return {
      state: "unavailable",
      assetsEnabled: false,
      staleBuild: false,
      refreshedAt: meta?.refreshedAt || null,
      workspaceId: meta?.workspaceId || null,
      schemas: [],
      objectTypes: [],
      attributes: [],
      governance: summarizeAssetInsights({ assetsEnabled: false }),
      lastError: meta?.lastError || null,
      neverBuilt: false,
    };
  }

  if (!meta?.version) {
    return {
      state: meta?.state || "idle",
      assetsEnabled: null,
      staleBuild,
      startedAt: meta?.startedAt || null,
      version: null,
      schemas: [],
      objectTypes: [],
      attributes: [],
      governance: null,
      lastError: meta?.lastError || null,
      neverBuilt: true,
    };
  }

  const [schemas, objectTypes, attributes, typeCounts, countMeta] = await Promise.all([
    loadAssetSchemas(installationKey, meta.version),
    loadAssetObjectTypes(installationKey, meta.version),
    loadAssetAttributes(installationKey, meta.version),
    loadAssetTypeCounts(installationKey),
    readAssetTypeCountMeta(installationKey),
  ]);

  const governance = summarizeAssetInsights({ schemas, objectTypes, attributes, typeCounts, assetsEnabled: true });

  return {
    state: meta.state || "ready",
    assetsEnabled: true,
    staleBuild,
    startedAt: meta.startedAt || null,
    refreshedAt: meta.refreshedAt || null,
    version: meta.version,
    workspaceId: meta.workspaceId || null,
    schemas,
    objectTypes,
    attributes,
    // Keyed by objectTypeId so the tab can join it onto the type list it already has,
    // rather than requiring a second round trip once someone has run the crawl.
    typeCounts,
    governance,
    lastError: meta.lastError || null,
    neverBuilt: false,
    typeCountCrawl: {
      state: countMeta?.state || "idle",
      staleBuild: isAssetTypeCountBuildStale(countMeta),
      refreshedAt: countMeta?.refreshedAt || null,
      measuredTypes: countMeta?.measuredTypes || 0,
      unmeasuredTypes: countMeta?.unmeasuredTypes || 0,
      lastError: countMeta?.lastError || null,
    },
  };
}

export async function buildAssetInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readAssetSnapshotMeta(installationKey);
  if (meta?.state === "building" && !isAssetBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before building the Assets inventory." };
  }

  await queueAssetSnapshotBuild(installationKey);
  return { queued: true };
}

// The object-count crawl: a separate job from the structure build, so it has its own
// "already building" guard against its own meta rather than the structure's.
export async function buildAssetTypeCountCrawl({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const structureMeta = await readAssetSnapshotMeta(installationKey);
  if (!structureMeta?.version) {
    return { queued: false, error: "No Assets structure inventory yet. Build that first." };
  }

  const countMeta = await readAssetTypeCountMeta(installationKey);
  if (countMeta?.state === "building" && !isAssetTypeCountBuildStale(countMeta)) {
    return { queued: false, reason: "already-building", meta: countMeta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before crawling object counts." };
  }

  await queueAssetTypeCountBuild(installationKey);
  return { queued: true };
}

// reports exactly what each one returned. Admin-only, read-only, and it never throws:
// a diagnostic that can fail the page it runs on is worse than no diagnostic.
// Confirms what the JSM Assets API answers on this site -- the first step of the Assets
// pillar, done as a probe because Assets is a gateway API whose exact endpoint spelling and
// availability (JSM Premium only) are worth verifying before an engine is built on them.
export async function probeAssetsApi() {
  incrMetric(METRIC_NAMES.resolver);
  return probeAssetsApiProbe();
}
