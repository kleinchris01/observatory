// Governance findings over the access snapshot: least-privilege violations in permission
// schemes, data black holes in issue-security schemes, and fragile routing in notification
// schemes. Pure functions over already-loaded rows, like issuetype-insights.js.

const BROWSE = "BROWSE_PROJECTS";
const ADMIN = "ADMINISTER_PROJECTS";

// Holder kinds, from Jira's published spec: `anyone` is a grant for ANONYMOUS users -- the
// public, on a site that allows anonymous access -- and an `applicationRole` grant with no
// application named is "any logged-in user" in Jira's own UI.
const isPublicHolder = (h) => h.holderType === "anyone";
const isAnyLoggedInHolder = (h) => h.holderType === "applicationRole" && !h.holderValue;

// Permissions where "every logged-in user" is a decision someone should be able to defend:
// administration, deleting or rewriting other people's work, moving issues, and setting
// security. Browse, create, comment and the like granted to everyone is normal on an open site
// and is counted, not flagged.
const SENSITIVE_FOR_EVERYONE = new Set([
  "ADMINISTER_PROJECTS", "DELETE_ISSUES", "DELETE_ALL_COMMENTS", "DELETE_ALL_ATTACHMENTS",
  "DELETE_ALL_WORKLOGS", "EDIT_ALL_COMMENTS", "EDIT_ALL_WORKLOGS", "MODIFY_REPORTER",
  "SET_ISSUE_SECURITY", "MOVE_ISSUES", "MANAGE_SPRINTS_PERMISSION",
]);

function bySchemeId(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.schemeId)) map.set(r.schemeId, []);
    map.get(r.schemeId).push(r);
  }
  return map;
}

function projectCounts(schemeProjects) {
  const map = new Map();
  for (const p of schemeProjects) map.set(p.schemeId, (map.get(p.schemeId) || 0) + 1);
  return map;
}

// ── Permission schemes ──────────────────────────────────────────────────────
// `listLimit` trims the per-item lists for the Access tab; remediation passes Infinity, since
// an epic has to ticket every item the count describes, not the first 25 of them.
export function summarizePermissionInsights({ schemes = [], holders = [], schemeProjects = [], rosterAccountIds = new Set(), listLimit = 25 } = {}) {
  const holdersBy = bySchemeId(holders);
  const projCount = projectCounts(schemeProjects);

  const unused = [];
  const risky = [];
  let directUserGrants = 0;
  let offRosterUserGrants = 0;
  let publicSchemes = 0;
  let loggedInSensitiveSchemes = 0;
  let loggedInGrants = 0;

  for (const scheme of schemes) {
    const g = holdersBy.get(scheme.id) || [];
    const count = projCount.get(scheme.id) || 0;
    if (count === 0 && !scheme.isDefault) {
      unused.push({ id: scheme.id, name: scheme.name });
    }

    const reasons = [];
    if (g.some((h) => h.context === BROWSE && h.holderType === "anyone")) reasons.push("browse open to anyone (public)");
    // Any OTHER permission open to anonymous users -- create, comment, attach. Each is the
    // public acting on the projects this scheme governs, not just reading them.
    const otherPublic = [...new Set(g.filter((h) => isPublicHolder(h) && h.context !== BROWSE).map((h) => h.context))];
    if (otherPublic.length) reasons.push(`${otherPublic.length} other permission${otherPublic.length === 1 ? "" : "s"} open to anonymous users (public): ${otherPublic.slice(0, 4).join(", ")}`);
    if (g.some(isPublicHolder)) publicSchemes += 1;

    const loggedIn = g.filter(isAnyLoggedInHolder);
    loggedInGrants += loggedIn.length;
    const sensitive = [...new Set(loggedIn.map((h) => h.context).filter((c) => SENSITIVE_FOR_EVERYONE.has(c)))];
    if (sensitive.length) {
      reasons.push(`${sensitive.length} sensitive permission${sensitive.length === 1 ? "" : "s"} granted to every logged-in user: ${sensitive.slice(0, 4).join(", ")}`);
      loggedInSensitiveSchemes += 1;
    }
    if (g.some((h) => h.context === ADMIN && (h.holderType === "anyone" || h.holderType === "group"))) reasons.push("project admin granted to a group or to anyone");
    const userGrants = g.filter((h) => h.holderType === "user" && h.holderValue);
    if (userGrants.length) reasons.push(`${userGrants.length} grant${userGrants.length === 1 ? "" : "s"} to a named individual`);
    directUserGrants += userGrants.length;
    offRosterUserGrants += userGrants.filter((h) => !rosterAccountIds.has(h.holderValue)).length;

    if (reasons.length) risky.push({ id: scheme.id, name: scheme.name, reasons, projectCount: count });
  }

  return {
    available: schemes.length > 0,
    totalSchemes: schemes.length,
    unusedSchemeCount: unused.length,
    riskySchemeCount: risky.length,
    directUserGrantCount: directUserGrants,
    offRosterUserGrantCount: offRosterUserGrants,
    // Schemes granting anything to anonymous users, and schemes granting a sensitive
    // permission to every logged-in user. Both also land in riskySchemes, with the reason.
    publicSchemeCount: publicSchemes,
    loggedInSensitiveSchemeCount: loggedInSensitiveSchemes,
    loggedInGrantCount: loggedInGrants,
    unusedSchemes: unused.slice(0, listLimit),
    riskySchemes: risky.slice(0, listLimit),
  };
}

export function summarizePermissionHealth(s) {
  if (!s?.available) return { available: false };
  return {
    available: true,
    totalSchemes: s.totalSchemes,
    riskySchemeCount: s.riskySchemeCount,
    unusedSchemeCount: s.unusedSchemeCount,
  };
}

// ── Issue-security schemes ──────────────────────────────────────────────────
export function summarizeSecurityInsights({ schemes = [], levels = [], holders = [], schemeProjects = [], rosterAccountIds = new Set(), listLimit = 25 } = {}) {
  const levelsBy = bySchemeId(levels);
  const projCount = projectCounts(schemeProjects);
  // members keyed by "schemeId|levelId" (holder.context is the level id)
  const memberCountByLevel = new Map();
  let offRosterMembers = 0;
  for (const h of holders) {
    const key = `${h.schemeId}|${h.context}`;
    memberCountByLevel.set(key, (memberCountByLevel.get(key) || 0) + 1);
    if (h.holderType === "user" && h.holderValue && !rosterAccountIds.has(h.holderValue)) offRosterMembers += 1;
  }

  const unused = [];
  const noLevels = [];
  const emptyLevels = [];

  for (const scheme of schemes) {
    const lvls = levelsBy.get(scheme.id) || [];
    if ((projCount.get(scheme.id) || 0) === 0) unused.push({ id: scheme.id, name: scheme.name });
    if (lvls.length === 0) noLevels.push({ id: scheme.id, name: scheme.name });
    for (const lvl of lvls) {
      if ((memberCountByLevel.get(`${scheme.id}|${lvl.id}`) || 0) === 0) {
        emptyLevels.push({ schemeId: scheme.id, schemeName: scheme.name, levelId: lvl.id, levelName: lvl.name });
      }
    }
  }

  return {
    available: schemes.length > 0,
    totalSchemes: schemes.length,
    totalLevels: levels.length,
    unusedSchemeCount: unused.length,
    noLevelSchemeCount: noLevels.length,
    emptyLevelCount: emptyLevels.length,
    offRosterMemberCount: offRosterMembers,
    unusedSchemes: unused.slice(0, listLimit),
    emptyLevels: emptyLevels.slice(0, listLimit === 25 ? 40 : listLimit),
    noLevelSchemes: noLevels.slice(0, listLimit),
  };
}

export function summarizeSecurityHealth(s) {
  if (!s?.available) return { available: false };
  return {
    available: true,
    totalSchemes: s.totalSchemes,
    totalLevels: s.totalLevels,
    brokenLevelCount: s.emptyLevelCount + s.noLevelSchemeCount,
    unusedSchemeCount: s.unusedSchemeCount,
  };
}

// ── Notification schemes ────────────────────────────────────────────────────
export function summarizeNotificationInsights({ schemes = [], holders = [], schemeProjects = [], rosterAccountIds = new Set(), listLimit = 25 } = {}) {
  const holdersBy = bySchemeId(holders);
  const projCount = projectCounts(schemeProjects);

  const unused = [];
  const fragile = [];
  let offRosterRecipients = 0;
  let emailRecipients = 0;
  let groupRecipients = 0;

  for (const scheme of schemes) {
    const h = holdersBy.get(scheme.id) || [];
    if ((projCount.get(scheme.id) || 0) === 0 && !scheme.isDefault) unused.push({ id: scheme.id, name: scheme.name });

    const namedUsers = h.filter((r) => r.holderType === "user" && r.holderValue);
    // A raw email address is a hard-coded recipient too, and a worse one: it is outside the
    // user directory entirely, so nothing about it changes when someone leaves -- and issue
    // content goes to wherever that mailbox now forwards.
    const emailAddresses = h.filter((r) => r.holderType === "emailAddress");
    const groups = h.filter((r) => r.holderType === "group");
    groupRecipients += groups.length;
    emailRecipients += emailAddresses.length;
    if (namedUsers.length || emailAddresses.length) {
      fragile.push({
        id: scheme.id,
        name: scheme.name,
        namedUserCount: namedUsers.length,
        emailAddressCount: emailAddresses.length,
        groupRecipientCount: groups.length,
      });
    }
    offRosterRecipients += namedUsers.filter((r) => !rosterAccountIds.has(r.holderValue)).length;
  }

  return {
    available: schemes.length > 0,
    totalSchemes: schemes.length,
    unusedSchemeCount: unused.length,
    fragileSchemeCount: fragile.length,
    offRosterRecipientCount: offRosterRecipients,
    // Raw email addresses (outside the directory) and whole groups, across every scheme.
    emailRecipientCount: emailRecipients,
    groupRecipientCount: groupRecipients,
    unusedSchemes: unused.slice(0, listLimit),
    fragileSchemes: fragile.slice(0, listLimit),
  };
}

export function summarizeNotificationHealth(s) {
  if (!s?.available) return { available: false };
  return {
    available: true,
    totalSchemes: s.totalSchemes,
    fragileSchemeCount: s.fragileSchemeCount,
    unusedSchemeCount: s.unusedSchemeCount,
  };
}

// ── Project roles & actors ──────────────────────────────────────────────────
// `holders` are the project-role holder rows: { schemeId (roleId), context (projectId),
// contextLabel (projectKey), holderType (user|group|empty), holderValue, holderLabel }.
const ADMIN_ROLE = /admin/i;

export function summarizeRoleInsights({ roles = [], holders = [], rosterAccountIds = new Set(), listLimit = 25 } = {}) {
  const roleName = new Map(roles.map((r) => [String(r.id), r.name || String(r.id)]));
  const adminRoleIds = new Set(roles.filter((r) => ADMIN_ROLE.test(r.name || "")).map((r) => String(r.id)));

  // Per (role, project): does it have a real actor, or only the "empty" sentinel?
  const filledByRoleProject = new Set();
  const seenRoleProject = new Set();
  const projectsWithRoles = new Set();
  let offRosterActors = 0;
  let userActorCount = 0;
  const offRosterMemberships = [];

  for (const h of holders) {
    const rp = `${h.schemeId}|${h.context}`;
    seenRoleProject.add(rp);
    projectsWithRoles.add(h.context);
    if (h.holderType === "user" || h.holderType === "group") {
      filledByRoleProject.add(rp);
      if (h.holderType === "user" && h.holderValue) {
        userActorCount += 1;
        if (!rosterAccountIds.has(h.holderValue)) {
          offRosterActors += 1;
          if (offRosterMemberships.length < listLimit) {
            offRosterMemberships.push({ projectId: h.context, projectKey: h.contextLabel || h.context, roleId: h.schemeId, role: roleName.get(h.schemeId), accountId: h.holderValue });
          }
        }
      }
    }
  }

  // Projects whose admin-named role has no group or user actor -- only a site admin can
  // administer them.
  const projectsMissingAdminActor = new Set();
  for (const rp of seenRoleProject) {
    const [roleId, projectId] = rp.split("|");
    if (adminRoleIds.has(roleId) && !filledByRoleProject.has(rp)) projectsMissingAdminActor.add(projectId);
  }
  // Label the worst offenders for the finding detail.
  const missingAdminSamples = [];
  const sampled = new Set();
  for (const h of holders) {
    if (missingAdminSamples.length >= listLimit) break;
    if (adminRoleIds.has(h.schemeId) && h.holderType === "empty"
      && !filledByRoleProject.has(`${h.schemeId}|${h.context}`) && !sampled.has(h.context)) {
      // One entry per project: a project with two admin-named roles both empty is one fix.
      sampled.add(h.context);
      missingAdminSamples.push({ projectId: h.context, projectKey: h.contextLabel, role: roleName.get(h.schemeId) });
    }
  }

  return {
    available: roles.length > 0,
    totalRoles: roles.length,
    projectsWithRoles: projectsWithRoles.size,
    projectsMissingAdminActorCount: projectsMissingAdminActor.size,
    offRosterActorCount: offRosterActors,
    directUserActorCount: userActorCount,
    projectsMissingAdminActor: missingAdminSamples,
    offRosterMemberships,
  };
}

export function summarizeRoleHealth(s) {
  if (!s?.available) return { available: false };
  return {
    available: true,
    totalRoles: s.totalRoles,
    projectsWithRoles: s.projectsWithRoles,
    projectsMissingAdminActorCount: s.projectsMissingAdminActorCount,
    // Both read by the role-actor-hygiene dimension. They were dropped here, so the score
    // saw zero off-roster actors on every site and reported "Actor hygiene 100" directly
    // above a finding counting 1,071 of them.
    offRosterActorCount: s.offRosterActorCount,
    directUserActorCount: s.directUserActorCount,
  };
}
