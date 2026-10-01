// The cross-pillar ownership join, in one place so the People resolver and the site-health
// build read it the same way.
//
// Filters and dashboards carry their owner accountId on the snapshot row. Automation rules
// carry an author only if the imported rule export did -- older exports do not, and this
// reports that as "unknown", never "nobody".

import {
  readFilterSnapshotMeta,
  readDashboardSnapshotMeta,
  loadFilters,
  loadDashboards,
} from "./project-store.js";
// project-store.js re-exports the other store modules but not the automation one, so the
// automation directory document is read straight from its own store.
import { readAutomationPart } from "./store/automation.js";
import { hydrateRuleDirectory } from "./automation-analysis.js";

// accountId -> { filters: [{id,name,viewUrl}], dashboards: [...], rules: [{id,name,enabled}] }
export async function buildOwnershipIndex(installationKey) {
  const [filterMeta, dashMeta, dirDoc] = await Promise.all([
    readFilterSnapshotMeta(installationKey).catch(() => null),
    readDashboardSnapshotMeta(installationKey).catch(() => null),
    readAutomationPart(installationKey, "directory").catch(() => null),
  ]);

  const [filters, dashboards] = await Promise.all([
    filterMeta?.version ? loadFilters(installationKey, filterMeta.version).catch(() => []) : [],
    dashMeta?.version ? loadDashboards(installationKey, dashMeta.version).catch(() => []) : [],
  ]);

  const byAccount = new Map();
  const bucket = (accountId) => {
    if (!accountId) return null;
    if (!byAccount.has(accountId)) byAccount.set(accountId, { filters: [], dashboards: [], rules: [] });
    return byAccount.get(accountId);
  };

  for (const f of filters) {
    const b = bucket(f.ownerAccountId);
    if (b) b.filters.push({ id: f.id, name: f.name, viewUrl: f.viewUrl || null });
  }
  for (const d of dashboards) {
    const b = bucket(d.ownerAccountId);
    if (b) b.dashboards.push({ id: d.dashboardId ?? d.id, name: d.name, viewUrl: d.viewUrl || null });
  }
  if (dirDoc) {
    for (const rule of hydrateRuleDirectory(dirDoc).values()) {
      const b = bucket(rule.authorAccountId);
      if (b) b.rules.push({ id: rule.id, name: rule.name, enabled: rule.enabled });
    }
  }

  return {
    byAccount,
    available: {
      filters: Boolean(filterMeta?.version),
      dashboards: Boolean(dashMeta?.version),
      rules: Boolean(dirDoc) && [...byAccount.values()].some((b) => b.rules.length > 0),
    },
  };
}

// The accountIds that count as "on the roster" for every off-roster and orphaned check.
// The roster now carries deactivated accounts (so the People tab and licence hygiene can see
// them), but a deactivated account still owning a filter or named in a rule is exactly what
// those checks exist to find, so only active accounts count as present.
export function activeRosterIds(users = []) {
  return new Set(users.filter((u) => u && u.active !== false).map((u) => u.accountId));
}

// Given the ownership index and the set of accountIds that ARE in the licensed roster,
// tally the artifacts whose owner is not -- a deleted or unlicensed account still holding
// site config. Also returns the total owned-artifact count, which is the rate denominator.
export function summarizeOrphanedOwnership(ownership, rosterAccountIds) {
  let orphanFilters = 0, orphanDashboards = 0, orphanRules = 0;
  let totalFilters = 0, totalDashboards = 0, totalRules = 0;
  const orphanOwners = [];

  for (const [accountId, owned] of ownership.byAccount) {
    totalFilters += owned.filters.length;
    totalDashboards += owned.dashboards.length;
    totalRules += owned.rules.length;
    if (rosterAccountIds.has(accountId)) continue;
    orphanFilters += owned.filters.length;
    orphanDashboards += owned.dashboards.length;
    orphanRules += owned.rules.length;
    if (owned.filters.length || owned.dashboards.length || owned.rules.length) orphanOwners.push(accountId);
  }

  return {
    orphanedFilters: orphanFilters,
    orphanedDashboards: orphanDashboards,
    orphanedRules: orphanRules,
    orphanedArtifacts: orphanFilters + orphanDashboards + orphanRules,
    orphanedOwners: orphanOwners.length,
    ownedArtifactTotal: totalFilters + totalDashboards + totalRules,
  };
}
