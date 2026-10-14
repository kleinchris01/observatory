// Governance over the global value lists. The one finding that matters for both resolutions
// and priorities is the same one the workflow and issue-type pillars already run: near-
// duplicate names. A site that has accumulated "Done", "Fixed", "Complete", "Resolved" and
// "Delivered" as separate resolutions cannot produce a correct resolution-based report --
// every number is split across synonyms nobody reconciles.
//
// Pure functions over already-loaded rows, like issuetype-insights.js.

import { findDuplicateStatusGroups } from "./workflow-insights.js";

// Usage per value, from the issue crawl's estate totals. One function so the Priorities tab,
// the report, OQL and the Overview all read the same numbers. Before this the Overview alone
// attached the counts, and every row on the tab read "Not measured" on a crawled site.
//
// A completed crawl is what turns a missing row into a real zero; with no totals at all,
// every count stays null (unmeasured) rather than nought.
export function attachEstateUsage({ resolutions = [], priorities = [], totals = [] } = {}) {
  const byKind = { resolution: new Map(), priority: new Map() };
  for (const row of totals || []) {
    if (byKind[row?.kind]) byKind[row.kind].set(String(row.valueId ?? ""), row.issueCount);
  }
  const usageMeasured = (totals || []).length > 0;
  const attach = (rows, kind) => rows.map((v) => ({
    ...v,
    issueCount: usageMeasured ? (byKind[kind].get(String(v.id)) ?? 0) : null,
  }));
  return {
    resolutions: attach(resolutions, "resolution"),
    priorities: attach(priorities, "priority"),
    usageMeasured,
    // Issues carrying no resolution at all; the crawl counts them under the empty id.
    unresolvedIssueCount: usageMeasured ? (byKind.resolution.get("") ?? 0) : null,
  };
}

function duplicateSummary(items, listLimit = 25) {
  const groups = findDuplicateStatusGroups(items).map((g) => ({
    key: g.key,
    kind: g.kind,
    names: g.statuses.map((s) => s.name),
    count: g.count,
  }));
  return {
    groups: groups.slice(0, listLimit),
    groupCount: groups.length,
    // What consolidation would remove: collapsing each group to a single value.
    reducibleCount: groups.reduce((sum, g) => sum + (g.count - 1), 0),
  };
}

// `listLimit` trims the duplicate-group lists for the tab; remediation passes Infinity.
export function summarizeEstateInsights({ resolutions = [], priorities = [], listLimit = 25 } = {}) {
  const available = resolutions.length > 0 || priorities.length > 0;
  const resolutionDupes = duplicateSummary(resolutions, listLimit);
  const priorityDupes = duplicateSummary(priorities, listLimit);

  return {
    available,
    totalResolutions: resolutions.length,
    totalPriorities: priorities.length,
    // A list with no default is a real, if minor, misconfiguration -- Jira falls back to the
    // first entry, which shifts if the order changes.
    resolutionsWithoutDefault: resolutions.length > 0 && !resolutions.some((r) => r.isDefault),
    prioritiesWithoutDefault: priorities.length > 0 && !priorities.some((p) => p.isDefault),
    resolutionDuplicateGroupCount: resolutionDupes.groupCount,
    reducibleResolutionCount: resolutionDupes.reducibleCount,
    resolutionDuplicateGroups: resolutionDupes.groups,
    priorityDuplicateGroupCount: priorityDupes.groupCount,
    reduciblePriorityCount: priorityDupes.reducibleCount,
    priorityDuplicateGroups: priorityDupes.groups,
  };
}

// The counts computeSiteHealth takes from this pillar. Two dimensions, one per list, each a
// share of that list scored against its own tolerance.
export function summarizeEstateHealth(summary) {
  if (!summary?.available) return { available: false };
  return {
    available: true,
    totalResolutions: summary.totalResolutions,
    totalPriorities: summary.totalPriorities,
    reducibleResolutionCount: summary.reducibleResolutionCount,
    reduciblePriorityCount: summary.reduciblePriorityCount,
    resolutionsWithoutDefault: Boolean(summary.resolutionsWithoutDefault),
    prioritiesWithoutDefault: Boolean(summary.prioritiesWithoutDefault),
  };
}

// The usage half of this pillar's score: values no issue carries. Only measured once the issue
// crawl has run -- before that every value reads as unused, which says nothing.
export function summarizeEstateUsage(usage) {
  if (!usage?.usageMeasured) return { usageMeasured: false };
  const unused = (rows) => (rows || []).filter((v) => v.issueCount === 0).length;
  return {
    usageMeasured: true,
    unusedPriorityCount: unused(usage.priorities),
    unusedResolutionCount: unused(usage.resolutions),
  };
}
