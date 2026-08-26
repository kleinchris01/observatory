// The pure filter/sort/search logic for the Saved Filters tab, shared between server and
// client so there is exactly one implementation of "which filters match".
//
// This used to live only in FiltersTab.jsx and run entirely in the browser over every filter
// the resolver had sent. That was fine on the reference site's few hundred filters; on a site
// with 4,115, sending the whole analyzed set in one response overflowed Forge's per-invocation
// payload limit. The fix is to filter, search and sort here -- on the server, where the full
// list already exists in memory for the summary -- and ship only one page across the wire. The
// logic itself does not change, which is why it moved rather than being rewritten: the tab and
// its tests should see the identical answer they always did, just arriving already paginated.

// The findings, in the order a reader should work through them. Ordered by consequence
// rather than by count: an orphaned owner is a filter that will vanish, and a duplicate is
// six people maintaining one search six times.
export const FILTER_FINDINGS = [
  { key: "all", label: "All filters", match: () => true },
  {
    key: "orphaned-owner",
    label: "No live owner",
    tone: "danger",
    hint: "Jira deletes a filter with its owner. Everything built on these breaks at the same moment.",
    match: (f) => f.findings.some((x) => x.code === "orphaned-owner"),
  },
  {
    key: "shared-with-everyone",
    label: "Shared with everyone",
    tone: "warning",
    hint: "Any logged-in user can run these, against every project they can browse.",
    match: (f) => f.findings.some((x) => x.code === "shared-with-everyone"),
  },
  {
    key: "subscribed-but-unused",
    label: "Emailing nobody",
    tone: "warning",
    hint: "Recurring email from a search nobody opens is what teaches people to filter Jira to trash.",
    match: (f) => f.findings.some((x) => x.code === "subscribed-but-unused"),
  },
  {
    key: "stale",
    label: "Not opened in a year",
    tone: "info",
    hint: "Filters are seasonal, so this is a list to review rather than a list to delete.",
    match: (f) => f.findings.some((x) => x.code === "stale" || x.code === "never-used"),
  },
];

export const FILTER_SORTS = ["findings", "name", "subscriptions", "stale"];

export function sortFilters(filters, sort) {
  const rows = [...filters];
  if (sort === "name") return rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (sort === "subscriptions") return rows.sort((a, b) => b.subscriptionCount - a.subscriptionCount);
  if (sort === "stale") {
    // Never-opened first, then oldest. A filter Jira has never recorded a view of is stronger
    // evidence than an old timestamp, so it sorts ahead rather than being treated as unknown.
    return rows.sort((a, b) => {
      if (!a.lastUsedAt && !b.lastUsedAt) return 0;
      if (!a.lastUsedAt) return -1;
      if (!b.lastUsedAt) return 1;
      return Date.parse(a.lastUsedAt) - Date.parse(b.lastUsedAt);
    });
  }
  return rows.sort((a, b) => b.findings.length - a.findings.length || String(a.name).localeCompare(String(b.name)));
}

export function filterRows(filters, { search = "", finding = "all" } = {}) {
  const option = FILTER_FINDINGS.find((f) => f.key === finding) ?? FILTER_FINDINGS[0];
  const term = search.trim().toLowerCase();
  return filters.filter((row) => {
    if (!option.match(row)) return false;
    if (!term) return true;
    // The JQL is searched too, which is how somebody finds "every filter that mentions this
    // field" without leaving the tab.
    return `${row.name} ${row.ownerName ?? ""} ${row.jql}`.toLowerCase().includes(term);
  });
}

// Counts for the finding rail, computed once over the full analyzed list rather than by the
// client re-filtering per option. At 4,115 filters, re-running filterRows() once per rail
// button in the browser was the same expensive pass five times over.
export function filterFindingCounts(filters) {
  const counts = {};
  for (const option of FILTER_FINDINGS) counts[option.key] = filters.filter(option.match).length;
  return counts;
}
