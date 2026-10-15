// Builds the People snapshot: every licensed Jira user, and which products they hold.
//
// "Licensed" is answered without any admin configuration. GET /rest/api/3/applicationrole
// returns, per Jira product, the groups whose members get an application licence for it plus
// the seat numbers. Union those access groups, enumerate their members, dedupe -> the
// roster. The site's own seat totals are kept alongside so the tab can show "377 of 500
// Jira Software seats used" and cross-check it against the roster this built.
//
// Follows issuetype-engine.js: single-pass, marked "building" before the queue hand-off so
// the UI reflects the request immediately and rapid double-clicks collapse into one job.
// Project roles, activity and ownership joins are follow-up work.

import { logger } from "./logger.js";
import { inventorySnapshotQueue } from "./queues.js";
import { incrMetric, METRIC_NAMES, getApplicationRoles, getGroupMembers, mapWithConcurrency } from "./jira-api.js";
import {
  ensureProjectStoreReady,
  writeUserSnapshotMeta,
  readUserSnapshotMeta,
  replaceUserSnapshot,
} from "./project-store.js";

// Matches ISSUE_TYPE_BUILD_STALE_MS and for the same reason: the consumer ceiling is 900s,
// plus a minute so a build finishing right at the limit is never declared stale out from
// under itself. A Forge invocation timeout is a hard kill that skips the catch, so the
// clock is the only recovery signal.
export const USER_BUILD_STALE_MS = 16 * 60 * 1000;

export function isUserBuildStale(meta, now = Date.now()) {
  if (meta?.state !== "building") return false;
  const startedAt = Date.parse(meta?.startedAt || "");
  if (!Number.isFinite(startedAt)) return true;
  return now - startedAt > USER_BUILD_STALE_MS;
}

// One raw group member into the roster row shape. accountId is the only field guaranteed
// present; displayName is stored so the tab reads without a per-row lookup, matching how
// filter owner names are already kept. No email -- Jira Cloud is in GDPR strict mode.
export function normalizeUser(raw) {
  return {
    accountId: String(raw?.accountId || ""),
    displayName: raw?.displayName || null,
    active: raw?.active !== false,
    accountType: raw?.accountType || null,
    avatarUrl: raw?.avatarUrls?.["48x48"] || raw?.avatarUrls?.["32x32"] || null,
  };
}

// The access-group set, read live. Each product contributes its `groups` (the full set that
// grants it, not just `defaultGroups`), keyed by groupId so a rename does not orphan it.
export function accessGroupsFromApplicationRoles(roles = []) {
  const groups = new Map(); // groupId -> { id, name, applications: [{key,name}] }
  const summary = [];

  for (const role of roles) {
    if (!role || role.defined === false) continue;
    const application = { key: String(role.key || ""), name: role.name || String(role.key || "") };
    if (!application.key) continue;

    summary.push({
      key: application.key,
      name: application.name,
      numberOfSeats: Number.isFinite(Number(role.numberOfSeats)) ? Number(role.numberOfSeats) : null,
      remainingSeats: Number.isFinite(Number(role.remainingSeats)) ? Number(role.remainingSeats) : null,
      userCount: Number.isFinite(Number(role.userCount)) ? Number(role.userCount) : null,
      hasUnlimitedSeats: Boolean(role.hasUnlimitedSeats),
    });

    const details =
      Array.isArray(role.groupDetails) && role.groupDetails.length
        ? role.groupDetails.map((g) => ({ id: String(g.groupId || ""), name: g.name || null }))
        : Array.isArray(role.groups)
          ? role.groups.map((name) => ({ id: "", name }))
          : [];

    for (const g of details) {
      const key = g.id || `name:${g.name}`;
      if (!g.id && !g.name) continue;
      if (!groups.has(key)) groups.set(key, { id: g.id, name: g.name, applications: [] });
      const entry = groups.get(key);
      if (!entry.applications.some((a) => a.key === application.key)) entry.applications.push(application);
    }
  }

  return { groups: [...groups.values()], summary };
}

// Hand the build to the queue consumer (900s) rather than the caller's resolver invocation.
export async function queueUserSnapshotBuild(installationKey) {
  await ensureProjectStoreReady();
  await writeUserSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });
  await inventorySnapshotQueue.push({
    body: { jobType: "build-user-snapshot", installationKey },
  });
}

export async function buildUserSnapshot(installationKey) {
  incrMetric(METRIC_NAMES.userSnapshotStarted);
  await ensureProjectStoreReady();
  await writeUserSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });

  try {
    const version = String(Date.now());

    const roles = await getApplicationRoles();
    const { groups, summary } = accessGroupsFromApplicationRoles(roles);

    if (!groups.length) {
      // No application roles with access groups -- either the API returned nothing or the
      // caller lacks Jira admin. Fail loudly rather than publish an empty roster that reads
      // as "this site has no licensed users".
      throw new Error("No application-access groups were returned. This endpoint needs Jira admin.");
    }

    // One paginated walk per group, a few at a time so a site with many access groups does
    // not fan out into a rate-limit storm. Groups shared across products are fetched once.
    const membersByGroup = await mapWithConcurrency(groups, 3, async (group) => {
      if (!group.id) return { group, members: [] };
      const raw = await getGroupMembers(group.id).catch((error) => {
        logger.warn("user-snapshot.group_member_load_failed", {
          installationKey,
          groupId: group.id,
          error: String(error?.message || error),
        });
        return [];
      });
      return { group, members: raw.map(normalizeUser).filter((u) => u.accountId) };
    });

    // Fold into the roster. A user in several access groups is one row; the products and
    // groups they hold accumulate.
    const usersByAccount = new Map();
    const access = []; // { accountId, applicationKey, applicationName, viaGroupId, viaGroupName }
    const accessSeen = new Set();

    for (const { group, members } of membersByGroup) {
      for (const member of members) {
        if (!usersByAccount.has(member.accountId)) usersByAccount.set(member.accountId, member);

        for (const application of group.applications) {
          const key = `${member.accountId}|${application.key}|${group.id}`;
          if (accessSeen.has(key)) continue;
          accessSeen.add(key);
          access.push({
            accountId: member.accountId,
            applicationKey: application.key,
            applicationName: application.name,
            viaGroupId: group.id,
            viaGroupName: group.name,
          });
        }
      }
    }

    const users = [...usersByAccount.values()];
    const activeUsers = users.filter((u) => u.active).length;

    await replaceUserSnapshot(installationKey, version, { users, access });

    const completedAt = new Date().toISOString();
    await writeUserSnapshotMeta(installationKey, {
      state: "ready",
      version,
      completedAt,
      refreshedAt: completedAt,
      totalUsers: users.length,
      activeUsers,
      applicationSummary: summary,
      lastError: null,
    });

    incrMetric(METRIC_NAMES.userSnapshotCompleted);
    logger.info("user-snapshot.completed", {
      version,
      users: users.length,
      activeUsers,
      accessRows: access.length,
      groups: groups.length,
    });

    return { version, users: users.length, groups: groups.length };
  } catch (error) {
    incrMetric(METRIC_NAMES.userSnapshotFailed);
    const message = String(error?.message || error);
    logger.error("user-snapshot.failed", { error: message });
    await writeUserSnapshotMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: message,
    });
    return { error: message };
  }
}
