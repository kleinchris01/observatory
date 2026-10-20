// Jira Service Management: the four JSM pillars (request types, queues, SLAs, customers and
// organizations). The probe, the inventory read and the snapshot build. See
// docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES, getCloudId, getInstallationKey } from "../lib/jira-api.js";
import { probeServiceManagementApi as runServiceManagementProbe } from "../lib/jsm-probe.js";
import {
  ensureProjectStoreReady,
  readJsmSnapshotMeta,
  loadJsmDesks,
  loadJsmRequestTypes,
  loadJsmQueues,
  loadJsmSlas,
  loadJsmOrganizations,
} from "../lib/project-store.js";
import { queueJsmSnapshotBuild, isJsmBuildStale } from "../lib/jsm-engine.js";
import {
  analyzeRequestTypes,
  analyzeQueues,
  analyzeSlas,
  analyzeOrganizations,
  summarizeJsm,
  JSM_WINDOW_DAYS,
} from "../lib/jsm-insights.js";
import { readAdminConfig } from "./admin-config.js";

// What the Service Management API answers on this site, per pillar and build stage. Admin-only,
// read-only, and it never throws: a diagnostic that can fail the page it runs on is worse than
// no diagnostic.
export async function probeServiceManagementApi({ context } = {}) {
  incrMetric(METRIC_NAMES.resolver);
  return runServiceManagementProbe({ cloudId: getCloudId(context) });
}

// The whole JSM snapshot with every finding attached, shared by the tab, the report, OQL,
// remediation and the Rovo agent so they cannot disagree. Tri-state like every pillar:
//   neverBuilt     no snapshot at all
//   jsmEnabled:false   the build ran and this site has no service desk
//   otherwise      looked, and this is the answer
export async function loadJsmView(installationKey) {
  await ensureProjectStoreReady();
  const meta = await readJsmSnapshotMeta(installationKey);
  const staleBuild = isJsmBuildStale(meta);
  const base = {
    state: meta?.state || "idle",
    staleBuild,
    startedAt: meta?.startedAt || null,
    refreshedAt: meta?.refreshedAt || null,
    lastError: meta?.lastError || null,
    windowDays: JSM_WINDOW_DAYS,
  };
  if (meta?.state === "unavailable") {
    return { ...base, neverBuilt: false, jsmEnabled: false, reason: meta.lastError || null, ...emptyView() };
  }
  if (!meta?.version) return { ...base, neverBuilt: true, jsmEnabled: true, ...emptyView() };

  const v = meta.version;
  const [desks, rawTypes, rawQueues, rawSlas, rawOrgs] = await Promise.all([
    loadJsmDesks(installationKey, v),
    loadJsmRequestTypes(installationKey, v),
    loadJsmQueues(installationKey, v),
    loadJsmSlas(installationKey, v),
    loadJsmOrganizations(installationKey, v),
  ]);
  // A desk whose portal groups were not read reports null groups; its request types cannot be
  // called hidden.
  const groupsReadByDesk = new Map(desks.map((d) => [d.deskId, d.portalGroupCount !== null]));
  const deskKey = new Map(desks.map((d) => [d.deskId, d.projectKey]));
  const withDesk = (row) => ({ ...row, projectKey: deskKey.get(row.deskId) ?? null });

  return {
    ...base,
    neverBuilt: false,
    jsmEnabled: true,
    unreadCount: meta.unreadCount || 0,
    desks,
    requestTypes: analyzeRequestTypes(rawTypes, { groupsReadByDesk }).map(withDesk),
    queues: analyzeQueues(rawQueues).map(withDesk),
    slas: analyzeSlas(rawSlas),
    organizations: analyzeOrganizations(rawOrgs),
    summary:
      meta.summary ||
      summarizeJsm({
        desks,
        requestTypes: rawTypes,
        queues: rawQueues,
        slas: rawSlas,
        organizations: rawOrgs,
        groupsReadByDesk,
      }),
  };
}

function emptyView() {
  return {
    desks: [],
    requestTypes: [],
    queues: [],
    slas: [],
    organizations: [],
    summary: summarizeJsm({ desks: [] }),
    unreadCount: 0,
  };
}

export async function getJsmInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  return loadJsmView(getInstallationKey(context));
}

export async function buildJsmInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readJsmSnapshotMeta(installationKey);
  if (meta?.state === "building" && !isJsmBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }
  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return {
      queued: false,
      error: "Read-only mode is enabled. Disable it before building the Service Management inventory.",
    };
  }
  await queueJsmSnapshotBuild(installationKey);
  return { queued: true };
}
