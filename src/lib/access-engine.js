// Builds the access snapshot: permission schemes, issue-security schemes and notification
// schemes, their holders, and their project assignments -- versioned.
//
// One structural build like issue types and screens. Schemes are dozens per site; the only
// per-project cost is one call each for the permission scheme (Jira has no bulk
// project -> permissionscheme), run best-effort at concurrency so a project the app cannot
// read is simply unattributed rather than failing the build.

import { logger } from "./logger.js";
import { inventorySnapshotQueue } from "./queues.js";
import {
  incrMetric,
  METRIC_NAMES,
  mapWithConcurrency,
  getAllJiraProjects,
  getAllPermissionSchemes,
  getProjectPermissionScheme,
  getAllIssueSecuritySchemes,
  getIssueSecurityLevels,
  getIssueSecurityLevelMembers,
  getIssueSecuritySchemeProjects,
  getAllNotificationSchemes,
  getNotificationSchemeProjects,
  getAllProjectRoles,
  getProjectRolesForProject,
} from "./jira-api.js";
import {
  ensureProjectStoreReady,
  writeAccessSnapshotMeta,
  readAccessSnapshotMeta,
  replaceAccessSnapshot,
} from "./project-store.js";

export const ACCESS_BUILD_STALE_MS = 16 * 60 * 1000;

export function isAccessBuildStale(meta, now = Date.now()) {
  if (meta?.state !== "building") return false;
  const startedAt = Date.parse(meta?.startedAt || "");
  if (!Number.isFinite(startedAt)) return true;
  return now - startedAt > ACCESS_BUILD_STALE_MS;
}

// Jira spells the notification recipient kinds differently from permission/security holder
// kinds; collapse both onto one vocabulary so the cross-pillar joins are one query.
const NOTIFICATION_TYPE_MAP = {
  CurrentAssignee: "assignee",
  Reporter: "reporter",
  CurrentUser: "currentUser",
  ProjectLead: "projectLead",
  ComponentLead: "componentLead",
  User: "user",
  Group: "group",
  ProjectRole: "projectRole",
  EmailAddress: "emailAddress",
  AllWatchers: "allWatchers",
  UserCustomField: "userCustomField",
  GroupCustomField: "groupCustomField",
};

// The holder types whose reference is a specific, resolvable principal -- an accountId, a
// group id, a project-role id. Everything else ("anyone", "assignee", "projectLead", ...) is
// a positional token, not a grant to a named party.
export const NAMED_HOLDER_TYPES = new Set(["user", "group", "projectRole", "applicationRole"]);

function holderFromGrant(holder = {}) {
  const type = String(holder.type || "unknown");
  // Jira returns the id under different keys per type; `value` is the durable one.
  const value =
    holder.value ?? holder.parameter ?? holder.group?.groupId ?? holder.user?.accountId ?? holder.projectRole?.id ?? "";
  const label =
    holder.group?.name ??
    holder.user?.displayName ??
    holder.projectRole?.name ??
    holder.field?.name ??
    (typeof holder.parameter === "string" ? holder.parameter : null);
  return { holderType: type, holderValue: value == null ? "" : String(value), holderLabel: label || null };
}

export function normalizePermissionScheme(raw) {
  return {
    schemeType: "permission",
    id: String(raw?.id),
    name: raw?.name || null,
    description: raw?.description || null,
    isDefault: /^default permission scheme$/i.test(String(raw?.name || "")),
    defaultLevelId: null,
  };
}

// [{ schemeType, schemeId, context, contextLabel, holderType, holderValue, holderLabel }]
export function permissionGrantsToHolders(scheme) {
  const out = [];
  for (const grant of scheme?.permissions || []) {
    const h = holderFromGrant(grant.holder || {});
    out.push({
      schemeType: "permission",
      schemeId: String(scheme.id),
      context: String(grant.permission || "UNKNOWN"),
      contextLabel: String(grant.permission || "UNKNOWN"),
      ...h,
    });
  }
  return out;
}

export function notificationEventsToHolders(scheme) {
  const out = [];
  for (const evt of scheme?.notificationSchemeEvents || []) {
    const eventId = String(evt?.event?.id ?? "");
    const eventName = evt?.event?.name || eventId;
    for (const n of evt?.notifications || []) {
      const type = NOTIFICATION_TYPE_MAP[n?.notificationType] || String(n?.notificationType || "unknown");
      const value = n?.parameter ?? n?.value ?? "";
      out.push({
        schemeType: "notification",
        schemeId: String(scheme.id),
        context: eventId,
        contextLabel: eventName,
        holderType: type,
        holderValue: value == null ? "" : String(value),
        holderLabel: n?.user?.displayName || n?.group?.name || (typeof n?.parameter === "string" ? n.parameter : null),
      });
    }
  }
  return out;
}

export async function queueAccessSnapshotBuild(installationKey) {
  await ensureProjectStoreReady();
  await writeAccessSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });
  await inventorySnapshotQueue.push({
    body: { jobType: "build-access-snapshot", installationKey },
  });
}

export async function buildAccessSnapshot(installationKey) {
  incrMetric(METRIC_NAMES.accessSnapshotStarted);
  await ensureProjectStoreReady();
  await writeAccessSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });

  try {
    const version = String(Date.now());

    const [projects, rawPermSchemes, rawSecSchemes, rawNotifSchemes] = await Promise.all([
      getAllJiraProjects().catch(() => []),
      getAllPermissionSchemes().catch(() => []),
      getAllIssueSecuritySchemes().catch(() => []),
      getAllNotificationSchemes().catch(() => []),
    ]);
    const projectsById = new Map(projects.map((p) => [String(p.id), p]));

    // ── Permission schemes ──────────────────────────────────────────────────
    const permSchemes = rawPermSchemes.filter((s) => s?.id != null).map(normalizePermissionScheme);
    const holders = rawPermSchemes.flatMap(permissionGrantsToHolders);
    const schemeProjects = [];

    // Best-effort per-project lookup: which permission scheme each project uses.
    const permByProject = await mapWithConcurrency(projects, 8, async (p) => {
      const s = await getProjectPermissionScheme(p.id).catch(() => null);
      return s?.id != null ? { projectId: String(p.id), schemeId: String(s.id) } : null;
    });
    for (const row of permByProject) {
      if (!row) continue;
      const project = projectsById.get(row.projectId);
      schemeProjects.push({
        schemeType: "permission",
        schemeId: row.schemeId,
        projectId: row.projectId,
        projectKey: project?.key || "",
        projectName: project?.name || "",
      });
    }

    // ── Issue-security schemes ──────────────────────────────────────────────
    const secSchemes = rawSecSchemes
      .filter((s) => s?.id != null)
      .map((s) => ({
        schemeType: "security",
        id: String(s.id),
        name: s.name || null,
        description: s.description || null,
        isDefault: false,
        defaultLevelId: s.defaultSecurityLevelId == null ? null : String(s.defaultSecurityLevelId),
      }));
    const levels = [];
    const perScheme = await mapWithConcurrency(secSchemes, 4, async (scheme) => {
      const [rawLevels, rawMembers] = await Promise.all([
        getIssueSecurityLevels(scheme.id).catch(() => []),
        getIssueSecurityLevelMembers(scheme.id).catch(() => []),
      ]);
      const levelNameById = new Map();
      const lvlRows = (rawLevels || [])
        .filter((l) => l?.id != null)
        .map((l) => {
          levelNameById.set(String(l.id), l.name || String(l.id));
          return {
            schemeId: scheme.id,
            id: String(l.id),
            name: l.name || null,
            description: l.description || null,
            isDefault: String(l.id) === String(scheme.defaultLevelId),
          };
        });
      const memberRows = (rawMembers || []).map((m) => {
        const h = holderFromGrant(m.holder || {});
        const ctx = String(m.issueSecurityLevelId ?? m.levelId ?? "");
        return {
          schemeType: "security",
          schemeId: scheme.id,
          context: ctx,
          contextLabel: levelNameById.get(ctx) || ctx,
          ...h,
        };
      });
      return { lvlRows, memberRows };
    });
    for (const r of perScheme) {
      levels.push(...r.lvlRows);
      holders.push(...r.memberRows);
    }

    // ── Security scheme -> projects (bulk) ──────────────────────────────────
    const secProjectRows = await getIssueSecuritySchemeProjects(projects.map((p) => p.id)).catch(() => []);
    for (const row of secProjectRows || []) {
      const schemeId = String(row?.issueSecuritySchemeId ?? row?.id ?? "");
      if (!schemeId) continue;
      const ids = Array.isArray(row.projectIds) ? row.projectIds : row.projectId != null ? [row.projectId] : [];
      for (const pid of ids) {
        const project = projectsById.get(String(pid));
        schemeProjects.push({
          schemeType: "security",
          schemeId,
          projectId: String(pid),
          projectKey: project?.key || "",
          projectName: project?.name || "",
        });
      }
    }

    // ── Notification schemes ────────────────────────────────────────────────
    const notifSchemes = rawNotifSchemes
      .filter((s) => s?.id != null)
      .map((s) => ({
        schemeType: "notification",
        id: String(s.id),
        name: s.name || null,
        description: s.description || null,
        isDefault: /^default notification scheme$/i.test(String(s.name || "")),
        defaultLevelId: null,
      }));
    for (const scheme of rawNotifSchemes) {
      if (scheme?.id == null) continue;
      holders.push(...notificationEventsToHolders(scheme));
    }
    // Bulk reverse lookup, not scheme.projects: that field does not exist on the API
    // response (see getNotificationSchemeProjects), and reading it silently reported 0
    // projects for every notification scheme on the site.
    const notifProjectRows = await getNotificationSchemeProjects(projects.map((p) => p.id)).catch(() => []);
    for (const row of notifProjectRows || []) {
      const schemeId = String(row?.notificationSchemeId ?? row?.notificationScheme?.id ?? row?.id ?? "");
      if (!schemeId) continue;
      const ids = Array.isArray(row.projectIds) ? row.projectIds : row.projectId != null ? [row.projectId] : [];
      for (const pid of ids) {
        const project = projectsById.get(String(pid));
        schemeProjects.push({
          schemeType: "notification",
          schemeId,
          projectId: String(pid),
          projectKey: project?.key || "",
          projectName: project?.name || "",
        });
      }
    }

    // ── Project roles & actors ─────────────────────────────────────────────
    // The role DEFINITIONS are one site-wide call; the ACTORS are two hops per project
    // (name->url map, then one call per role). Best-effort at concurrency -- a project the
    // app cannot read is simply unattributed. Modelled on the same schemes/holders tables
    // as the other three types: scheme_type "project-role", scheme_id = roleId,
    // context = projectId. This is what makes "which roles is Ann in" one existing query.
    const rawRoles = await getAllProjectRoles().catch(() => []);
    const roleSchemes = rawRoles
      .filter((r) => r?.id != null)
      .map((r) => ({
        schemeType: "project-role",
        id: String(r.id),
        name: r.name || null,
        description: r.description || null,
        isDefault: false,
        defaultLevelId: null,
      }));
    const roleNameById = new Map(roleSchemes.map((r) => [r.id, r.name]));

    if (roleSchemes.length) {
      const perProjectRoleRows = await mapWithConcurrency(projects, 8, async (p) => {
        const roles = await getProjectRolesForProject(p.id).catch(() => []);
        const rows = [];
        for (const role of roles) {
          const schemeId = String(role.roleId);
          const named = (role.actors || []).filter((a) => a.type === "user" || a.type === "group");
          for (const actor of named) {
            rows.push({
              schemeType: "project-role",
              schemeId,
              context: String(p.id),
              contextLabel: p.key || String(p.id),
              holderType: actor.type,
              holderValue: actor.type === "user" ? actor.accountId || "" : actor.groupId || actor.id || "",
              holderLabel: actor.type === "user" ? actor.displayName : actor.groupName || actor.displayName,
            });
          }
          // A role present on the project with nobody in it: record the (role, project) pair
          // with a sentinel holder so "Administrators is empty here" is a queryable fact.
          if (named.length === 0) {
            rows.push({
              schemeType: "project-role",
              schemeId,
              context: String(p.id),
              contextLabel: p.key || String(p.id),
              holderType: "empty",
              holderValue: "",
              holderLabel: roleNameById.get(schemeId) || null,
            });
          }
        }
        return rows;
      });
      for (const rows of perProjectRoleRows) holders.push(...rows);
    }

    const schemes = [...permSchemes, ...secSchemes, ...notifSchemes, ...roleSchemes];

    await replaceAccessSnapshot(installationKey, version, { schemes, holders, levels, schemeProjects });

    const completedAt = new Date().toISOString();
    await writeAccessSnapshotMeta(installationKey, {
      state: "ready",
      version,
      completedAt,
      refreshedAt: completedAt,
      totalPermissionSchemes: permSchemes.length,
      totalSecuritySchemes: secSchemes.length,
      totalNotificationSchemes: notifSchemes.length,
      totalProjectRoles: roleSchemes.length,
      lastError: null,
    });

    incrMetric(METRIC_NAMES.accessSnapshotCompleted);
    logger.info("access-snapshot.completed", {
      version,
      permission: permSchemes.length,
      security: secSchemes.length,
      notification: notifSchemes.length,
      projectRoles: roleSchemes.length,
      holders: holders.length,
      levels: levels.length,
      schemeProjects: schemeProjects.length,
    });
    return {
      version,
      permission: permSchemes.length,
      security: secSchemes.length,
      notification: notifSchemes.length,
      projectRole: roleSchemes.length,
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.accessSnapshotFailed);
    const message = String(error?.message || error);
    logger.error("access-snapshot.failed", { error: message });
    await writeAccessSnapshotMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: message,
    });
    throw error;
  }
}
