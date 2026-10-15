// Governance over the agile boards, joined against the two pillars a board depends on: the
// saved filter behind it, and the statuses its columns map. Pure functions over rows that
// have already been loaded and shredded, like estate-insights.js.
//
// A board is one of the more fragile objects in Jira -- it breaks silently. Delete its
// backing filter and it shows every issue in the site; deactivate the person who owns that
// filter and it is one departure from breaking; leave a column mapping a status that was
// removed and issues in that status vanish from the board with no error anywhere.

// filters: the loadFilters rows, or null when the filter inventory has not been built.
// knownStatusIds: a Set of status ids that exist in the status catalog, or null when the
//   workflow inventory has not been built.
export function indexFiltersById(filters) {
  return filters ? new Map(filters.map((f) => [String(f.id ?? f.filterId ?? ""), f]).filter(([k]) => k)) : null;
}

// One board's finding codes. Exported so a caller that needs every board's findings (the
// pillar report) reads them from the same rules as the summary, not from a capped list.
export function boardIssues(b, filterById = null, knownStatusIds = null) {
  const issues = [];
  if (b.configReadable && !b.filterId) issues.push("no-backing-filter");

  if (b.configReadable && b.filterId && filterById) {
    const f = filterById.get(String(b.filterId));
    if (!f) issues.push("backing-filter-deleted");
    else if (f.ownerActive === false) issues.push("backing-filter-owner-inactive");
  }

  const cols = b.columns || [];
  if (cols.some((c) => (c.statusIds || []).length === 0)) issues.push("unmapped-column");
  if (knownStatusIds && cols.some((c) => (c.statusIds || []).some((id) => !knownStatusIds.has(String(id))))) {
    issues.push("stale-column-status");
  }
  return issues;
}

export function summarizeBoardInsights({ boards = [], filters = null, knownStatusIds = null } = {}) {
  const filterById = indexFiltersById(filters);

  let noFilter = 0; // config readable, but no backing filter named
  let missingFilter = 0; // names a filter id that is not in the snapshot -> deleted
  let inactiveFilterOwner = 0; // backing filter's owner is deactivated
  let unmappedColumnBoards = 0; // >=1 column with no status mapped
  let staleColumnBoards = 0; // >=1 column maps a status id that no longer exists
  let unreadable = 0; // Jira refused the board's configuration (team-managed 404s)

  const flagged = [];

  for (const b of boards) {
    if (b.configReadable === false) unreadable += 1;
    const issues = boardIssues(b, filterById, knownStatusIds);
    if (issues.includes("no-backing-filter")) noFilter += 1;
    if (issues.includes("backing-filter-deleted")) missingFilter += 1;
    if (issues.includes("backing-filter-owner-inactive")) inactiveFilterOwner += 1;
    if (issues.includes("unmapped-column")) unmappedColumnBoards += 1;
    if (issues.includes("stale-column-status")) staleColumnBoards += 1;

    if (issues.length) {
      flagged.push({ boardId: b.boardId, name: b.name, type: b.type, locationKey: b.locationKey || null, issues });
    }
  }

  return {
    available: boards.length > 0,
    total: boards.length,
    // Boards whose configuration was read. Only these were checked, so they are the
    // denominator for every board rate; an unreadable board is unmeasured, not healthy.
    readable: boards.length - unreadable,
    unreadable,
    noFilter,
    missingFilter,
    inactiveFilterOwner,
    unmappedColumnBoards,
    staleColumnBoards,
    flagged: flagged.slice(0, 50),
    flaggedCount: flagged.length,
    // Which joins actually ran, so a reader can tell "no stale columns" from "not checked".
    joinedFilters: Boolean(filterById),
    joinedStatuses: Boolean(knownStatusIds),
  };
}

// The counts computeSiteHealth takes from this pillar (B3 wires them in). Each is a share of
// the board estate scored against its own tolerance -- a broken backing filter is the
// heaviest, an unmapped column the lightest.
export function summarizeBoardHealth(summary) {
  if (!summary?.available) return { available: false };
  return {
    available: true,
    total: summary.total,
    readable: summary.readable ?? summary.total,
    unreadable: summary.unreadable ?? 0,
    brokenBackingCount: summary.missingFilter + summary.noFilter,
    inactiveFilterOwner: summary.inactiveFilterOwner,
    staleColumnBoards: summary.staleColumnBoards,
    unmappedColumnBoards: summary.unmappedColumnBoards,
  };
}
