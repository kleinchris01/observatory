// Priorities and resolutions pillar: inventory read and snapshot build.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES, getInstallationKey } from "../lib/jira-api.js";
import {
  ensureProjectStoreReady,
  readEstateSnapshotMeta,
  loadEstateValues,
  loadEstateValueTotals,
} from "../lib/project-store.js";
import { queueEstateSnapshotBuild, isEstateBuildStale } from "../lib/estate-engine.js";
import { attachEstateUsage, summarizeEstateInsights } from "../lib/estate-insights.js";
import { fallbackOn } from "../lib/logger.js";
import { readAdminConfig } from "./admin-config.js";

// The estate-config pillar's read: the global value lists (resolutions, priorities) with
// the near-duplicate-name governance summary over each.
export async function getEstateInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readEstateSnapshotMeta(installationKey);
  const staleBuild = isEstateBuildStale(meta);

  if (!meta?.version) {
    return {
      state: meta?.state || "idle",
      staleBuild,
      startedAt: meta?.startedAt || null,
      neverBuilt: true,
      resolutions: [],
      priorities: [],
      governance: summarizeEstateInsights({}),
      lastError: meta?.lastError || null,
    };
  }

  const [rawResolutions, rawPriorities, totals] = await Promise.all([
    loadEstateValues(installationKey, meta.version, "resolution"),
    loadEstateValues(installationKey, meta.version, "priority"),
    // Usage from the issue crawl. Without it every row read "Not measured", though the crawl
    // had counted issues per value all along; only the Overview attached the counts.
    loadEstateValueTotals(installationKey).catch(fallbackOn("estate.usage_load_failed", [], { installationKey })),
  ]);
  const { resolutions, priorities, usageMeasured, unresolvedIssueCount } = attachEstateUsage({
    resolutions: rawResolutions,
    priorities: rawPriorities,
    totals,
  });

  return {
    state: meta.state || "ready",
    staleBuild,
    refreshedAt: meta.refreshedAt || null,
    neverBuilt: false,
    lastError: meta.lastError || null,
    resolutions,
    priorities,
    usageMeasured,
    unresolvedIssueCount,
    governance: summarizeEstateInsights({ resolutions, priorities }),
  };
}

export async function buildEstateInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readEstateSnapshotMeta(installationKey);
  if (meta?.state === "building" && !isEstateBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before building the priorities/resolutions inventory." };
  }

  await queueEstateSnapshotBuild(installationKey);
  return { queued: true };
}
