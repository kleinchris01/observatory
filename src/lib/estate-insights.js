// Governance over the global value lists. The one finding that matters for both resolutions
// and priorities is the same one the workflow and issue-type pillars already run: near-
// duplicate names. A site that has accumulated "Done", "Fixed", "Complete", "Resolved" and
// "Delivered" as separate resolutions cannot produce a correct resolution-based report --
// every number is split across synonyms nobody reconciles.
//
// Pure functions over already-loaded rows, like issuetype-insights.js.

import { findDuplicateStatusGroups } from "./workflow-insights.js";

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
  };
}
