// Governance findings over the site's saved filters.
//
// A saved filter is the one piece of Jira configuration that fails silently in both
// directions. Delete a field forty filters search on and those searches quietly return the
// wrong answer, with no error anywhere. Leave a filter owned by somebody who left and it
// keeps emailing a subscription list from an account nobody administers.
//
// Pure functions over already-loaded rows, like workflow-insights.js: no I/O, so the resolver
// decides what to load and this decides what it means.

import { normalizeJql } from "./jql-refs.js";

// Share permission types Jira uses. `global` is every logged-in user on the site; `authenticated`
// is the same thing under its older name; `loggedin` appears on some payloads. All three mean
// "everyone", which is the claim worth flagging.
const EVERYONE_TYPES = new Set(["global", "authenticated", "loggedin"]);
// A filter shared to `project` with no role is every user who can browse that project.
const OPEN_PROJECT_SHARE = new Set(["project"]);

// Unused after this long. Deliberately generous: filters are seasonal -- a release-readiness
// filter is untouched for ten months and indispensable in the eleventh -- so a bound tight
// enough to catch quarterly use would flag half the site every quarter.
export const STALE_FILTER_DAYS = 365;

export function isSharedWithEveryone(shares = []) {
  return shares.some((share) => EVERYONE_TYPES.has(String(share?.type || "").toLowerCase()));
}

// Shared to a whole project with no role restriction.
//
// Reported separately from "everyone" rather than folded in, because it is usually correct:
// a project filter shared with that project is the normal case. It matters only in
// combination -- a filter over one project shared with a different one is a leak, and that
// is a claim this module cannot make without the project catalog, so it publishes the count
// and lets the caller join.
export function isSharedWithOpenProject(shares = []) {
  return shares.some((share) =>
    OPEN_PROJECT_SHARE.has(String(share?.type || "").toLowerCase()) && !share?.roleId);
}

export function daysSince(iso, now = Date.now()) {
  const at = Date.parse(iso || "");
  if (!Number.isFinite(at)) return null;
  return Math.max(0, (now - at) / (24 * 60 * 60 * 1000));
}

// Filters whose owner is gone, or on their way out.
//
// The single most consequential filter defect, and the one nobody discovers until it breaks.
// Jira does not reassign filters when an account is deactivated: the filter keeps working,
// keeps feeding whatever board or dashboard uses it, and keeps sending its subscriptions --
// until the account is deleted, at which point the filter goes with it and everything built
// on it breaks at once.
//
// `active: false` is what the API returns for a deactivated account. A missing owner means
// the account is already gone, which is worse and is reported as its own kind.
export function classifyOwner(filter) {
  if (!filter?.owner) return "missing";
  if (filter.owner.active === false) return "inactive";
  return "active";
}

// One filter's findings, ordered most consequential first.
//
// Each carries the evidence rather than a verdict, the same shape analyzeRuleRisks uses:
// "this filter is risky" is not actionable and "owned by a deactivated account and feeding
// 3 subscriptions" is.
// `lastUsedTracked` is the tenant-level answer to "does Jira populate approximateLastUsed
// here at all". On instances where it does not, EVERY filter comes back with lastUsedAt
// null -- and "we could not tell" must not be rendered as "never opened", the same rule the
// status pillar follows for its counts (CONNECT-4091). When it is false, the three
// last-used findings are suppressed entirely rather than fired on every filter.
export function analyzeFilter(filter, { now = Date.now(), staleDays = STALE_FILTER_DAYS, lastUsedTracked = true } = {}) {
  const findings = [];
  const ownerState = classifyOwner(filter);
  const subscriptions = Number(filter?.subscriptionCount) || 0;

  if (ownerState === "missing" || ownerState === "inactive") {
    findings.push({
      code: "orphaned-owner",
      severity: subscriptions > 0 ? "high" : "medium",
      detail: ownerState === "missing"
        ? "The owning account no longer exists. Jira deletes a filter with its owner, and anything built on it breaks at the same moment."
        : "Owned by a deactivated account. The filter still works, and disappears if that account is ever deleted.",
    });
  }

  if (isSharedWithEveryone(filter?.shares)) {
    findings.push({
      code: "shared-with-everyone",
      severity: "medium",
      detail: "Shared with every logged-in user. Anyone on the site can run it, including against projects they can browse but were never meant to survey.",
    });
  }

  // A subscription is a recurring email. One on a filter nobody opens is the definition of
  // noise somebody eventually filters to trash, taking the useful ones with it. Only a claim
  // this app can make when Jira actually tracks last-used on this tenant.
  const lastUsedDays = daysSince(filter?.lastUsedAt, now);
  const neverUsed = lastUsedTracked && filter?.lastUsedAt == null;
  if (lastUsedTracked && subscriptions > 0 && (neverUsed || (lastUsedDays !== null && lastUsedDays > staleDays))) {
    findings.push({
      code: "subscribed-but-unused",
      severity: "medium",
      detail: `Sends ${subscriptions} email subscription${subscriptions === 1 ? "" : "s"} on a filter nobody has opened in over a year.`,
    });
  }

  if (lastUsedTracked && !neverUsed && lastUsedDays !== null && lastUsedDays > staleDays && subscriptions === 0) {
    findings.push({
      code: "stale",
      severity: "low",
      detail: `Not opened in ${Math.round(lastUsedDays / 30)} months.`,
    });
  }

  // Distinct from stale: Jira has never recorded a view at all. On a filter that has existed
  // for years that is stronger evidence than an old timestamp -- but only if Jira records
  // views on this instance in the first place.
  if (neverUsed && subscriptions === 0) {
    findings.push({
      code: "never-used",
      severity: "low",
      detail: "Jira has never recorded this filter being opened.",
    });
  }

  return findings;
}

// Filters that would return the same issues.
//
// Grouped rather than paired, because the interesting case is six people maintaining six
// copies of one search, not two. Ordered by size so the worst offender leads.
export function findDuplicateFilters(filters = []) {
  const byJql = new Map();
  for (const filter of filters) {
    const key = normalizeJql(filter?.jql);
    if (!key) continue;
    if (!byJql.has(key)) byJql.set(key, []);
    byJql.get(key).push(filter);
  }

  return [...byJql.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({
      key,
      jql: group[0].jql,
      count: group.length,
      filters: group.map((f) => ({
        id: f.id, name: f.name, ownerName: f.ownerName ?? null, lastUsedAt: f.lastUsedAt ?? null,
      })),
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

// Filters naming a project the site does not have.
//
// The one filter defect that produces a visible error rather than a silently wrong result --
// which makes it the cheapest to justify fixing and the easiest to prove.
//
// `projectKeys` is a Set of the keys and ids that exist. Numeric operands are skipped rather
// than resolved: `project = 10001` is an id, this module has no id-to-key map, and guessing
// would invent broken filters.
export function findBrokenProjectRefs(filters = [], projectKeys = null) {
  if (!projectKeys || projectKeys.size === 0) return [];
  const known = new Set([...projectKeys].map((key) => String(key).toLowerCase()));

  return filters
    .map((filter) => {
      const missing = (filter.projectRefs ?? [])
        .filter((ref) => !/^\d+$/.test(String(ref)))
        .filter((ref) => !known.has(String(ref).toLowerCase()));
      return missing.length ? { id: filter.id, name: filter.name, ownerName: filter.ownerName ?? null, missing } : null;
    })
    .filter(Boolean);
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

// Everything the pillar reports, as rates rather than counts.
//
// Same rule the health score follows: a site with 4,000 filters and 50 orphans is tidier
// than one with 80 filters and 50 orphans, and scoring counts would rank them the other way.
export function summarizeFilters(filters = [], { now = Date.now(), projectKeys = null, staleDays = STALE_FILTER_DAYS } = {}) {
  // If not one filter on the whole site carries a last-used date, Jira does not track it
  // here -- so the "stale" / "never opened" findings are all noise, and the tab should say
  // "not tracked" rather than assert every filter is dead.
  const lastUsedTracked = filters.some((f) => f?.lastUsedAt != null);
  const analyzed = filters.map((filter) => ({
    ...filter,
    findings: analyzeFilter(filter, { now, staleDays, lastUsedTracked }),
  }));

  const has = (filter, code) => filter.findings.some((f) => f.code === code);
  const duplicateGroups = findDuplicateFilters(filters);
  const brokenProjects = findBrokenProjectRefs(filters, projectKeys);

  const withFindings = analyzed
    .filter((filter) => filter.findings.length > 0)
    .sort((a, b) =>
      SEVERITY_ORDER[a.findings[0].severity] - SEVERITY_ORDER[b.findings[0].severity]
      || String(a.name).localeCompare(String(b.name)));

  return {
    // Tri-state, like every other pillar: no snapshot is "not measured", never "no filters".
    available: filters.length > 0,
    // Whether Jira populates last-used on this instance at all. When false the UI drops the
    // "not opened in a year" filter and shows "last-opened not tracked" instead of "never
    // opened" -- unknown is not the same as never.
    lastUsedTracked,
    total: filters.length,
    orphanedCount: analyzed.filter((f) => has(f, "orphaned-owner")).length,
    sharedWithEveryoneCount: analyzed.filter((f) => has(f, "shared-with-everyone")).length,
    subscribedButUnusedCount: analyzed.filter((f) => has(f, "subscribed-but-unused")).length,
    staleCount: analyzed.filter((f) => has(f, "stale")).length,
    neverUsedCount: analyzed.filter((f) => has(f, "never-used")).length,
    subscriptionTotal: filters.reduce((sum, f) => sum + (Number(f.subscriptionCount) || 0), 0),
    duplicateGroupCount: duplicateGroups.length,
    // What consolidation would actually save: collapsing each group to one filter.
    reducibleCount: duplicateGroups.reduce((sum, group) => sum + (group.count - 1), 0),
    brokenProjectCount: brokenProjects.length,
    // Whether the project join was possible at all. Without the catalog, "no broken
    // references" means nobody looked.
    projectsChecked: Boolean(projectKeys && projectKeys.size > 0),
    duplicateGroups: duplicateGroups.slice(0, 50),
    brokenProjects: brokenProjects.slice(0, 50),
    filters: withFindings,
  };
}

// The counts the site health score takes from this pillar.
//
// computeSiteHealth scores four separate filter dimensions -- ownership, exposure,
// subscriptions, scope -- straight from these raw counts against their own tolerances. It
// does NOT read a combined rate. There used to be a `defectRate` computed here from a
// hand-weighted sum; it was a leftover from when filters were one combined dimension, no
// caller ever read it once the split landed, and its weighting comment described a trade-off
// that no longer exists. Removed rather than left as a number nothing consumes.
//
// Duplicates are deliberately absent from every filter score: six people keeping six copies
// of one search is untidy, not broken, and it is the most numerous filter finding by a wide
// margin. The duplicate count is real and lives on the Filters tab, where a reader is
// already asking about filters.
export function summarizeFilterHealth(summary) {
  if (!summary?.available) return { available: false };

  return {
    available: true,
    total: summary.total,
    orphanedCount: summary.orphanedCount,
    sharedWithEveryoneCount: summary.sharedWithEveryoneCount,
    subscribedButUnusedCount: summary.subscribedButUnusedCount,
    brokenProjectCount: summary.brokenProjectCount,
    projectsChecked: summary.projectsChecked,
    reducibleCount: summary.reducibleCount,
  };
}
