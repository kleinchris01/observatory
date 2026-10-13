// Access pillar: permission, issue-security and notification schemes and project roles; the global-permissions probe.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import {
  incrMetric,
  METRIC_NAMES,
  getInstallationKey,
  probeEndpoint,
  getPermissionCatalog,
} from "../lib/jira-api.js";
import {
  ensureProjectStoreReady,
  readUserSnapshotMeta,
  loadUsers,
  readAccessSnapshotMeta,
  loadSchemes,
  loadSchemeHolders,
  loadSchemeLevels,
  loadSchemeProjects,
} from "../lib/project-store.js";
import { queueAccessSnapshotBuild, isAccessBuildStale } from "../lib/access-engine.js";
import {
  summarizePermissionInsights,
  summarizeSecurityInsights,
  summarizeNotificationInsights,
  summarizeRoleInsights,
} from "../lib/access-insights.js";
import { activeRosterIds } from "../lib/user-ownership.js";
import { readAdminConfig } from "./admin-config.js";

// The access pillar's read: permission / issue-security / notification schemes, their
// holders and project assignments, with the governance summary for each type. Roster
// accountIds are joined in so an off-roster grant reads as such.
// The second argument is internal: Forge only ever passes the request. Remediation calls this
// with listLimit: Infinity to read every flagged item rather than the tab's first 25.
export async function getAccessInventory({ context }, { listLimit = 25 } = {}) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readAccessSnapshotMeta(installationKey);
  const staleBuild = isAccessBuildStale(meta);

  if (!meta?.version) {
    return {
      state: meta?.state || "idle",
      staleBuild,
      startedAt: meta?.startedAt || null,
      version: null,
      permissions: null,
      security: null,
      notifications: null,
      lastError: meta?.lastError || null,
      neverBuilt: true,
    };
  }

  const rosterAccountIds = (await loadActiveRoster(installationKey)) || new Set();

  const [
    permSchemes, permHolders, permProjects,
    secSchemes, secHolders, secProjects, levels,
    notifSchemes, notifHolders, notifProjects,
    roleSchemes, roleHolders,
  ] = await Promise.all([
    loadSchemes(installationKey, meta.version, "permission"),
    loadSchemeHolders(installationKey, meta.version, "permission"),
    loadSchemeProjects(installationKey, meta.version, "permission"),
    loadSchemes(installationKey, meta.version, "security"),
    loadSchemeHolders(installationKey, meta.version, "security"),
    loadSchemeProjects(installationKey, meta.version, "security"),
    loadSchemeLevels(installationKey, meta.version),
    loadSchemes(installationKey, meta.version, "notification"),
    loadSchemeHolders(installationKey, meta.version, "notification"),
    loadSchemeProjects(installationKey, meta.version, "notification"),
    loadSchemes(installationKey, meta.version, "project-role"),
    loadSchemeHolders(installationKey, meta.version, "project-role"),
  ]);

  const projectCountFor = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(r.schemeId, (m.get(r.schemeId) || 0) + 1);
    return m;
  };

  const decorate = (schemes, projRows) => {
    const counts = projectCountFor(projRows);
    return schemes.map((s) => ({ ...s, projectCount: counts.get(s.id) || 0 }));
  };

  return {
    state: meta.state || "ready",
    staleBuild,
    startedAt: meta.startedAt || null,
    refreshedAt: meta.refreshedAt || null,
    version: meta.version,
    neverBuilt: false,
    lastError: meta.lastError || null,
    permissions: {
      schemes: decorate(permSchemes, permProjects),
      holders: permHolders,
      governance: summarizePermissionInsights({ schemes: permSchemes, holders: permHolders, schemeProjects: permProjects, rosterAccountIds, listLimit }),
    },
    security: {
      schemes: decorate(secSchemes, secProjects),
      levels,
      holders: secHolders,
      governance: summarizeSecurityInsights({ schemes: secSchemes, levels, holders: secHolders, schemeProjects: secProjects, rosterAccountIds, listLimit }),
    },
    notifications: {
      schemes: decorate(notifSchemes, notifProjects),
      holders: notifHolders,
      governance: summarizeNotificationInsights({ schemes: notifSchemes, holders: notifHolders, schemeProjects: notifProjects, rosterAccountIds, listLimit }),
    },
    roles: {
      // projectCount here means "on how many projects does this role have at least one
      // real actor", built from the role holder rows rather than a schemeProjects table.
      schemes: (() => {
        const withActor = new Map();
        for (const h of roleHolders) {
          if (h.holderType === "user" || h.holderType === "group") {
            if (!withActor.has(h.schemeId)) withActor.set(h.schemeId, new Set());
            withActor.get(h.schemeId).add(h.context);
          }
        }
        return roleSchemes.map((s) => ({ ...s, projectCount: withActor.get(s.id)?.size || 0 }));
      })(),
      holders: roleHolders,
      governance: summarizeRoleInsights({ roles: roleSchemes, holders: roleHolders, rosterAccountIds, listLimit, permHolders, permProjects }),
    },
  };
}

export async function buildAccessInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readAccessSnapshotMeta(installationKey);
  if (meta?.state === "building" && !isAccessBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before building the access inventory." };
  }

  await queueAccessSnapshotBuild(installationKey);
  return { queued: true };
}

// Global permissions: does the Jira Cloud REST API let this app enumerate WHO HOLDS each
// global permission (ADMINISTER, SYSTEM_ADMIN, CREATE_SHARED_OBJECTS, ...)? As of writing
// it exposes only the permission CATALOG, not the grants -- this probe confirms that
// against the live site before an access-pillar view is built on it. Admin-only,
// read-only, never throws.
export async function probeGlobalPermissions() {
  incrMetric(METRIC_NAMES.resolver);
  const rows = [];
  const tryEndpoint = async (path, note) => {
    try {
      const data = await probeEndpoint(path);
      rows.push({ path, ok: data.ok, status: data.status, note, sample: data.sample ?? null });
    } catch (err) {
      rows.push({ path, ok: false, status: null, note, error: String(err?.message || err) });
    }
  };

  await tryEndpoint("/rest/api/3/permissions", "The permission catalog — definitions only, no holders");
  await tryEndpoint("/rest/api/3/permissions/check", "Bulk permission check for the current user — not an enumeration");

  let catalog = {};
  try {
    catalog = await getPermissionCatalog();
  } catch { /* reflected in rows above */ }
  const globalKeys = Object.values(catalog)
    .filter((p) => String(p?.type || "").toUpperCase() === "GLOBAL")
    .map((p) => p.key);

  return {
    // The catalog read is expected to succeed; grant enumeration is what is missing.
    catalogAvailable: globalKeys.length > 0,
    globalPermissionKeys: globalKeys,
    grantEnumerationAvailable: false,
    rows,
    hint: "Jira Cloud's REST API returns the global-permission catalog but no endpoint that lists which groups hold each one. A global-permissions governance view is blocked on that gap; the access pillar covers PROJECT permission schemes, which the API does expose.",
  };
}

// The active roster's accountIds, or null when no people snapshot exists (so an off-roster
// flag is unknown, not false).
export async function loadActiveRoster(installationKey) {
  const userMeta = await readUserSnapshotMeta(installationKey).catch(() => null);
  if (!userMeta?.version) return null;
  const users = await loadUsers(installationKey, userMeta.version).catch(() => []);
  return activeRosterIds(users);
}
