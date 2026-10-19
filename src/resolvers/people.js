// People pillar: the licensed roster, one person's footprint across pillars, the roster build,
// and the handover report for someone leaving.
//
// Everything above getHandoverReport was moved verbatim from src/resolvers.js; see
// docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES, getInstallationKey, getProjectLeads, countIssues } from "../lib/jira-api.js";
import {
  ensureProjectStoreReady,
  readSnapshotMeta,
  loadSnapshotFieldNames,
  loadUserFieldAppearances,
  readUserSnapshotMeta,
  loadUsers,
  loadUserGovernanceSummary,
  readAccessSnapshotMeta,
  loadSchemesGrantingHolder,
  loadUserActivity,
  readBoardSnapshotMeta,
  loadBoards,
  readDashboardSnapshotMeta,
  loadDashboardsForFilters,
} from "../lib/project-store.js";
import { buildHandoverReport } from "../lib/handover.js";
import { queueUserSnapshotBuild, isUserBuildStale } from "../lib/user-engine.js";
import {
  activeRosterIds,
  buildOwnershipIndex,
  summarizeOrphanedOwnership,
  classifyUserActivity,
} from "../lib/user-ownership.js";
import { hydrateRuleDirectory } from "../lib/automation-analysis.js";
import { readAutomationPart } from "../lib/store/automation.js";
import { fallbackOn } from "../lib/logger.js";
import { readAdminConfig } from "./admin-config.js";

// The People pillar's read: the licensed-user roster with each user's products and access
// groups, plus the site's own seat numbers for the header.
export async function getUserInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readUserSnapshotMeta(installationKey);
  const staleBuild = isUserBuildStale(meta);

  if (!meta?.version) {
    return {
      state: meta?.state || "idle",
      staleBuild,
      startedAt: meta?.startedAt || null,
      version: null,
      users: [],
      applicationSummary: [],
      governance: null,
      lastError: meta?.lastError || null,
      neverBuilt: true,
    };
  }

  const [users, governance, ownership, ruleUserIndex] = await Promise.all([
    loadUsers(installationKey, meta.version),
    loadUserGovernanceSummary(installationKey, meta.version),
    buildOwnershipIndex(installationKey).catch(() => ({ byAccount: new Map(), available: {} })),
    readAutomationPart(installationKey, "users").catch(() => null),
  ]);

  // accountId -> how many DISTINCT rules name this person. Built once from the automation
  // user index so the roster can show it without a per-user lookup.
  const ruleRefCountByAccount = new Map();
  for (const entry of ruleUserIndex?.entries ?? []) {
    const ids = new Set([...(entry.write ?? []), ...(entry.read ?? []), ...(entry.trigger ?? [])]);
    ruleRefCountByAccount.set(String(entry.label), ids.size);
  }

  const rosterIds = activeRosterIds(users);
  // Last activity and the dormant flag per account -- the same classification the score uses,
  // so the roster lists exactly the accounts the dormant-licences dimension counted.
  const activity = classifyUserActivity(
    users,
    await loadUserActivity(installationKey, [...rosterIds]).catch(
      fallbackOn("people.activity_load_failed", () => [], { installationKey }),
    ),
  );
  const withOwnership = users.map((u) => {
    const owned = ownership.byAccount.get(u.accountId);
    const act = activity.byAccount.get(String(u.accountId));
    return {
      ...u,
      ownedFilters: owned?.filters.length ?? 0,
      ownedDashboards: owned?.dashboards.length ?? 0,
      authoredRules: owned?.rules.length ?? 0,
      automationRefs: ruleRefCountByAccount.get(u.accountId) ?? 0,
      lastActivityAt: act?.lastActivityAt ?? null,
      // true / false where the crawl measured the account, null where it did not.
      dormant: act?.dormant ?? null,
    };
  });

  const orphaned = summarizeOrphanedOwnership(ownership, rosterIds);

  // People an automation rule names who are not on the licensed roster -- a rule assigning
  // work to a deactivated or unlicensed account. Estate-level count; the People tab lists
  // them per rule from getUserDetails.
  let automationRefUsers = 0;
  let orphanedAutomationRefUsers = 0;
  for (const accountId of ruleRefCountByAccount.keys()) {
    automationRefUsers += 1;
    if (!rosterIds.has(accountId)) orphanedAutomationRefUsers += 1;
  }

  return {
    state: meta.state || "ready",
    staleBuild,
    startedAt: meta.startedAt || null,
    refreshedAt: meta.refreshedAt || null,
    version: meta.version,
    users: withOwnership,
    applicationSummary: meta.applicationSummary || [],
    governance: {
      ...governance,
      ...orphaned,
      automationRefUsers,
      orphanedAutomationRefUsers,
      activityMeasured: activity.measured,
      measuredAccounts: activity.measuredAccounts,
      dormantAccounts: activity.dormantAccounts,
      dormantAfterDays: activity.dormantAfterDays,
    },
    automationRefsAvailable: Boolean(ruleUserIndex),
    ownershipAvailable: ownership.available,
    lastError: meta.lastError || null,
    neverBuilt: false,
  };
}

// One user's full cross-pillar footprint: products, groups, and the filters, dashboards and
// automation rules they own. The roster gives counts; this gives the lists.
export async function getUserDetails({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const accountId = String(payload?.accountId || "");
  if (!accountId) throw new Error("accountId is required");

  const meta = await readUserSnapshotMeta(installationKey);
  if (!meta?.version) return { available: false, reason: "no-roster" };

  const [fieldMeta, accessMeta] = await Promise.all([
    readSnapshotMeta(installationKey).catch(() => null),
    readAccessSnapshotMeta(installationKey).catch(() => null),
  ]);

  const [users, ownership, ruleUserIndex, ruleDirectoryDoc, fieldAppearanceRows, grantedBySchemes] = await Promise.all([
    loadUsers(installationKey, meta.version),
    buildOwnershipIndex(installationKey).catch(() => ({ byAccount: new Map(), available: {} })),
    readAutomationPart(installationKey, "users").catch(() => null),
    readAutomationPart(installationKey, "directory").catch(() => null),
    fieldMeta?.version
      ? loadUserFieldAppearances(installationKey, fieldMeta.version, accountId).catch(() => [])
      : Promise.resolve([]),
    accessMeta?.version
      ? loadSchemesGrantingHolder(installationKey, accessMeta.version, "user", accountId).catch(() => [])
      : Promise.resolve([]),
  ]);

  const user = users.find((u) => u.accountId === accountId) || null;
  const owned = ownership.byAccount.get(accountId) || { filters: [], dashboards: [], rules: [] };

  // Grants via GROUP membership, not just a direct grant on the account. This is the common
  // case, not the edge case: a permission or notification scheme naming a person directly is
  // the anti-pattern the comment below calls out, but most real grants run through a group,
  // and grantedBySchemes above -- holder_type = "user" only -- could not see a single one of
  // them. A scheme granting to "jira-administrators" was invisible here even for an account
  // that IS one, which is exactly the footprint this resolver exists to show.
  let grantedByGroups = [];
  if (accessMeta?.version && user?.groups?.length) {
    const perGroup = await Promise.all(
      user.groups.map((g) =>
        loadSchemesGrantingHolder(installationKey, accessMeta.version, "group", g.id)
          .then((rows) => rows.map((r) => ({ ...r, viaGroup: g.name || g.id })))
          .catch(() => []),
      ),
    );
    grantedByGroups = perGroup.flat();
  }

  // The rules that NAME this person -- assign to them, condition on them being the assignee,
  // set a user field to their account. Distinct from authoredRules (rules they own): a
  // deactivated account can still be the assignee half a dozen rules route work to.
  const referencedInRules = collectRuleUserReferences(accountId, ruleUserIndex, ruleDirectoryDoc);

  // The user-picker fields this account holds a value in, from the last full crawl. Names
  // joined from the field snapshot. Empty until a scan has run since this feature landed.
  let fieldAppearances = [];
  if (fieldAppearanceRows.length && fieldMeta?.version) {
    const names = await loadSnapshotFieldNames(
      installationKey,
      fieldMeta.version,
      fieldAppearanceRows.map((r) => r.fieldId),
    ).catch(() => new Map());
    fieldAppearances = fieldAppearanceRows.map((r) => ({
      fieldId: r.fieldId,
      fieldName: names.get(r.fieldId) || r.fieldId,
      issueCount: r.issueCount,
    }));
  }

  return {
    available: true,
    inRoster: Boolean(user),
    user: user || { accountId, displayName: accountId, applications: [], groups: [], active: null },
    ownedFilters: owned.filters,
    ownedDashboards: owned.dashboards,
    authoredRules: owned.rules,
    referencedInRules,
    fieldAppearances,
    // Permission grants, security-level memberships and notification recipients that name
    // this account directly (a direct grant is an anti-pattern -- it should be a role).
    grantedBySchemes,
    // The same, via a group this account belongs to. Each entry carries which group earned
    // it (viaGroup), because "you have this via jira-administrators" and "you have this via
    // marketing-contractors" are different facts even when the scheme is the same one.
    grantedByGroups,
    automationRefsAvailable: Boolean(ruleUserIndex),
    fieldAppearancesAvailable: Boolean(fieldMeta?.version),
    accessGrantsAvailable: Boolean(accessMeta?.version),
    ownershipAvailable: ownership.available,
  };
}

// One account's entry in the automation user index, joined to rule names. `direction` is
// "write" when a rule assigns/sets the account and "read" when it only conditions on it --
// the write side is what breaks loudest if the account goes away.
export function collectRuleUserReferences(accountId, userIndex, directoryDoc) {
  const entry = (userIndex?.entries ?? []).find((e) => String(e.label) === String(accountId));
  if (!entry) return [];
  const names = directoryDoc ? hydrateRuleDirectory(directoryDoc) : new Map();
  const byId = new Map();
  for (const direction of ["write", "read", "trigger"]) {
    for (const ruleId of entry[direction] ?? []) {
      const existing = byId.get(ruleId);
      const rule = names.get(ruleId);
      if (existing) {
        if (direction === "write") existing.direction = "write";
      } else {
        byId.set(ruleId, {
          id: ruleId,
          name: rule?.name || `Rule ${ruleId}`,
          enabled: rule?.enabled ?? null,
          direction,
        });
      }
    }
  }
  return [...byId.values()];
}

export async function buildUserInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readUserSnapshotMeta(installationKey);
  if (meta?.state === "building" && !isUserBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before building the people inventory." };
  }

  await queueUserSnapshotBuild(installationKey);
  return { queued: true };
}

// Everything that depends on one person's account, ordered by what happens when it is removed:
// what is deleted with it, what breaks because of that, the work still routed to it, and the
// access to take away. Admin-only. Reuses getUserDetails' footprint and adds what offboarding
// needs on top: boards and gadgets built on their filters (from the snapshots), and the
// projects they lead and their open issues (read live, because neither is in a snapshot).
//
// Every input fails soft: one that cannot be read becomes "unmeasured" in its section with the
// reason, never an empty list that would read as nothing to hand over.
export async function getHandoverReport({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  const accountId = String(payload?.accountId || "");
  if (!accountId) throw new Error("accountId is required");
  const installationKey = getInstallationKey(context);

  const details = await getUserDetails({ payload: { accountId }, context });
  if (!details?.available) return buildHandoverReport({ details });

  const filterIds = (details.ownedFilters || []).map((f) => f.id);
  const [boards, gadgets, projectsLed, openAssigned] = await Promise.all([
    readBoardSnapshotMeta(installationKey)
      .then((meta) => (meta?.version ? loadBoards(installationKey, meta.version) : null))
      .catch(fallbackOn("handover.boards_failed", () => null, { installationKey })),
    readDashboardSnapshotMeta(installationKey)
      .then((meta) => (meta?.version ? loadDashboardsForFilters(installationKey, meta.version, filterIds) : null))
      .catch(fallbackOn("handover.gadgets_failed", () => null, { installationKey })),
    getProjectLeads()
      .then((projects) => projects.filter((p) => p.leadAccountId === accountId))
      .catch(fallbackOn("handover.leads_failed", () => null, { installationKey })),
    countIssues(`assignee = "${accountId.replace(/"/g, "")}" AND statusCategory != Done`),
  ]);

  return buildHandoverReport({ details, boards, gadgets, projectsLed, openAssigned });
}
