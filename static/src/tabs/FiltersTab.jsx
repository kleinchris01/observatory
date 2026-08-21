import React from "react";
import { invoke } from "@forge/bridge";
import { formatNumber, formatRelativeTime, handleJiraLinkClick } from "../utils";
import { Icon } from "../components/Icons";
import {
  StatTile, StatRow, Panel, EmptyState, Chip, PageHeader, SortFilterBar,
  PanelGrid, GridSpan, PillarHealthPanel,
} from "../components/ui";
import { SubNavLayout } from "../components/admin/primitives";
import { useNavIntent, useVisiblePolling } from "../hooks";

// Saved filter inventory.
//
// The pillar exists because a filter fails silently in both directions. Delete a field forty
// filters search on and those searches quietly return the wrong answer, with no error
// anywhere. Leave a filter owned by somebody who left and it keeps emailing a subscription
// list from an account nobody administers -- until that account is deleted, at which point
// Jira deletes the filter too and every board built on it breaks at once.
//
// Read-only like the rest of Observatory: it reports what exists and what depends on it.
// Reassigning an owner stays a considered action in Jira's own admin UI, with this as the
// evidence for which ones need it.

const PAGE_SIZE = 25;
const POLL_MS = 4000;

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

const SORTS = [
  { value: "findings", label: "Most findings first" },
  { value: "name", label: "Name A–Z" },
  { value: "subscriptions", label: "Most subscriptions" },
  { value: "stale", label: "Least recently opened" },
];

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

function OwnerChip({ filter }) {
  if (!filter.owner) return <Chip tone="danger" title="The owning account no longer exists">owner deleted</Chip>;
  if (filter.ownerActive === false) return <Chip tone="warning" title="Owned by a deactivated account">{filter.ownerName} · inactive</Chip>;
  return <span className="filter-row__owner">{filter.ownerName ?? "—"}</span>;
}

function FilterRow({ filter, siteOrigin }) {
  const href = siteOrigin ? `${siteOrigin}/issues/?filter=${filter.id}` : null;

  return (
    <div className={`filter-row${filter.findings.length ? " filter-row--flagged" : ""}`}>
      <div className="filter-row__head">
        {href ? (
          <a
            className="filter-row__name"
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => handleJiraLinkClick(event, href)}
            title="Open this filter in Jira"
          >
            {filter.name}
          </a>
        ) : (
          <span className="filter-row__name">{filter.name}</span>
        )}
        <OwnerChip filter={filter} />
        {filter.subscriptionCount > 0 && (
          <Chip tone={filter.findings.some((f) => f.code === "subscribed-but-unused") ? "warning" : "neutral"}>
            {formatNumber(filter.subscriptionCount)} subscription{filter.subscriptionCount === 1 ? "" : "s"}
          </Chip>
        )}
        {filter.sharedWithEveryone && <Chip tone="warning">everyone</Chip>}
        <span className="filter-row__used">
          {filter.lastUsedAt ? `opened ${formatRelativeTime(filter.lastUsedAt)}` : "never opened"}
        </span>
      </div>

      <code className="filter-row__jql">{filter.jql || "(no query)"}</code>

      {/* What this filter would take with it. The whole reason the pillar joins to the other
          ones: a field forty filters search on is not unused, whatever the field tab says. */}
      {(filter.fieldRefs.length > 0 || filter.statusRefs.length > 0) && (
        <div className="filter-row__refs">
          <span className="filter-row__refslabel">depends on</span>
          {filter.fieldRefs.slice(0, 8).map((ref) => <Chip key={`f-${ref}`}>{ref}</Chip>)}
          {filter.statusRefs.slice(0, 4).map((ref) => <Chip key={`s-${ref}`} tone="info">{ref}</Chip>)}
          {filter.fieldRefs.length > 8 && <span className="filter-row__more">+{filter.fieldRefs.length - 8} more</span>}
        </div>
      )}

      {filter.findings.length > 0 && (
        <ul className="filter-row__findings">
          {filter.findings.map((finding) => (
            <li key={finding.code} className={`filter-row__finding filter-row__finding--${finding.severity}`}>
              {finding.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function FiltersTab({ siteOrigin = "", intent = null }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [building, setBuilding] = React.useState(false);
  const [view, setView] = React.useState("filters");
  const [search, setSearch] = React.useState("");
  const [finding, setFinding] = React.useState("all");
  const [sort, setSort] = React.useState("findings");
  const [page, setPage] = React.useState(1);
  const [pillar, setPillar] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      const result = await invoke("getFilterInventory", {});
      setData(result);
      setError("");
    } catch (err) {
      // A transient poll failure keeps the last good state rather than blanking the page.
      setError(err?.message || "Could not load the filter inventory.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  // Poll only while a build is in flight and only while somebody is looking.
  useVisiblePolling(data?.state === "building", load, POLL_MS);

  React.useEffect(() => {
    let cancelled = false;
    invoke("getPillarHealth", { pillar: "filters" })
      .then((result) => { if (!cancelled) setPillar(result?.pillar || null); })
      .catch(() => { if (!cancelled) setPillar(null); });
    return () => { cancelled = true; };
  }, [data?.refreshedAt]);

  useNavIntent(intent, (nav) => {
    if (nav.view) setView(nav.view);
    setFinding(nav.finding ?? "all");
    setSearch("");
    setPage(1);
  });

  React.useEffect(() => { setPage(1); }, [search, finding, sort]);

  async function handleBuild() {
    setBuilding(true);
    try {
      const result = await invoke("buildFilterInventory", {});
      if (result?.error) setError(result.error);
      else await load();
    } catch (err) {
      setError(err?.message || "Could not start the build.");
    } finally {
      setBuilding(false);
    }
  }

  const all = data?.allFilters ?? [];
  // Findings are attached by the resolver to the flagged rows only, so the unflagged ones
  // need an empty list before anything can filter on it uniformly.
  const withFindings = React.useMemo(() => {
    const byId = new Map((data?.filters ?? []).map((f) => [f.id, f.findings]));
    return all.map((f) => ({ ...f, findings: byId.get(f.id) ?? [] }));
  }, [all, data?.filters]);

  const rows = React.useMemo(
    () => sortFilters(filterRows(withFindings, { search, finding }), sort),
    [withFindings, search, finding, sort]
  );
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  if (loading && !data) return <EmptyState>Loading the saved filter inventory…</EmptyState>;

  if (!data?.available) {
    return (
      <>
        <PageHeader
          title="Saved filters"
          description="Which searches exist, who owns them, and what they depend on. Read-only — Observatory reports what is configured; changes stay in Jira's own admin UI."
        />
        <EmptyState
          action={
            <button type="button" className="primary-button" onClick={handleBuild} disabled={building || data?.state === "building"}>
              {data?.state === "building" ? "Building…" : building ? "Starting…" : "Build filter inventory"}
            </button>
          }
        >
          {data?.state === "building"
            ? "Building the filter inventory…"
            : data?.lastError
              ? `The last build failed: ${data.lastError}`
              : "No filter inventory yet. Build one to see which filters are orphaned, over-shared, or holding a field open."}
        </EmptyState>
        {error && <div className="error-banner">{error}</div>}
      </>
    );
  }

  const sections = [
    { key: "filters", label: "Filters", icon: "search", badge: formatNumber(data.total) },
    { key: "duplicates", label: "Duplicates", icon: "copy", badge: formatNumber(data.duplicateGroupCount) },
    { key: "broken", label: "Broken scope", icon: "alertTriangle", badge: formatNumber(data.brokenProjectCount) },
  ];

  return (
    <>
      <PageHeader
        title="Saved filters"
        description="Which searches exist, who owns them, and what they depend on. A filter is the one piece of Jira configuration that fails silently in both directions."
        meta={data.refreshedAt ? `Built ${formatRelativeTime(data.refreshedAt)}` : undefined}
        actions={
          <button type="button" className="secondary-button" onClick={handleBuild} disabled={building || data.state === "building"}>
            {data.state === "building" ? "Building…" : "Rebuild"}
          </button>
        }
      />

      {error && <div className="error-banner">{error}</div>}

      <PanelGrid>
        <GridSpan>
          <PillarHealthPanel pillar={pillar} />
        </GridSpan>
        <GridSpan>
          <Panel title="Estate" icon="search">
            <StatRow>
              <StatTile label="Saved filters" value={formatNumber(data.total)} icon="search" />
              <StatTile
                label="No live owner"
                value={formatNumber(data.orphanedCount)}
                hint="Jira deletes a filter with its owner"
                tone={data.orphanedCount > 0 ? "critical" : "neutral"}
              />
              <StatTile
                label="Shared with everyone"
                value={formatNumber(data.sharedWithEveryoneCount)}
                tone={data.sharedWithEveryoneCount > 0 ? "warning" : "neutral"}
              />
              <StatTile
                label="Email subscriptions"
                value={formatNumber(data.subscriptionTotal)}
                hint={data.subscribedButUnusedCount > 0 ? `${formatNumber(data.subscribedButUnusedCount)} on filters nobody opens` : undefined}
                tone={data.subscribedButUnusedCount > 0 ? "warning" : "neutral"}
              />
            </StatRow>
          </Panel>
        </GridSpan>
      </PanelGrid>

      <SubNavLayout items={sections} activeKey={view} onSelect={setView}>
        {view === "filters" && (
          <Panel
            title="Filters"
            icon="search"
            description="Search matches the name, the owner and the JQL — which is how you find every filter that mentions a field without leaving this tab."
          >
            <SortFilterBar
              search={search}
              onSearchChange={setSearch}
              searchLabel="Search filters"
              searchPlaceholder="Name, owner, or anything in the query…"
              sort={sort}
              onSortChange={setSort}
              sortOptions={SORTS}
              resultCount={rows.length}
              totalCount={data.total}
              onClear={() => { setSearch(""); setFinding("all"); setSort("findings"); }}
            />

            <div className="findings-filter-bar">
              {FILTER_FINDINGS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  title={option.hint}
                  className={`findings-filter-button${finding === option.key ? " findings-filter-button--active" : ""}`}
                  onClick={() => setFinding(option.key)}
                >
                  <span>{option.label}</span>
                  <strong>{formatNumber(withFindings.filter(option.match).length)}</strong>
                </button>
              ))}
            </div>

            {pageRows.length === 0 ? (
              <EmptyState inline>No filter matches these filters.</EmptyState>
            ) : (
              <div className="filter-list">
                {pageRows.map((row) => <FilterRow key={row.id} filter={row} siteOrigin={siteOrigin} />)}
              </div>
            )}

            {pages > 1 && (
              <section className="pagination-bar">
                <span className="pagination-bar__status">
                  Page {formatNumber(page)} of {formatNumber(pages)} · {formatNumber(rows.length)} filters
                </span>
                <div className="pagination-bar__actions">
                  <button type="button" className="ghost-button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>Previous</button>
                  <button type="button" className="ghost-button" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages}>Next</button>
                </div>
              </section>
            )}
          </Panel>
        )}

        {view === "duplicates" && (
          <Panel
            title="Filters that would return the same issues"
            icon="copy"
            description="Matched on the normalised query, so casing and spacing do not hide a duplicate. Clause order is deliberately not normalised — proving two reorderings are equivalent means implementing the grammar, and a narrow answer that is always right beats a broad one that is sometimes wrong."
          >
            {data.duplicateGroups.length === 0 ? (
              <EmptyState inline>No two filters share a query.</EmptyState>
            ) : (
              <div className="filter-dupe-list">
                {data.duplicateGroups.map((group) => (
                  <div key={group.key} className="filter-dupe">
                    <div className="filter-dupe__head">
                      <Chip tone="warning">{formatNumber(group.count)} copies</Chip>
                      <code className="filter-row__jql">{group.jql}</code>
                    </div>
                    <div className="filter-dupe__members">
                      {group.filters.map((f) => (
                        <span key={f.id} className="filter-dupe__member">
                          {f.name}
                          {f.ownerName && <span className="filter-dupe__owner">{f.ownerName}</span>}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        )}

        {view === "broken" && (
          <Panel
            title="Filters naming a project that does not exist"
            icon="alertTriangle"
            description="The one filter defect that errors rather than returning the wrong answer quietly — which makes it the cheapest to justify fixing."
          >
            {!data.projectsChecked ? (
              // "No broken references" and "nobody looked" are different claims, and only one
              // of them is good news.
              <EmptyState inline>
                No field snapshot has been built, so the project list this checks against is unknown. Build one from the Scans tab.
              </EmptyState>
            ) : data.brokenProjects.length === 0 ? (
              <EmptyState inline>Every filter names a project that exists.</EmptyState>
            ) : (
              <div className="filter-list">
                {data.brokenProjects.map((row) => (
                  <div key={row.id} className="filter-row filter-row--flagged">
                    <div className="filter-row__head">
                      <span className="filter-row__name">{row.name}</span>
                      {row.ownerName && <span className="filter-row__owner">{row.ownerName}</span>}
                    </div>
                    <div className="filter-row__refs">
                      <span className="filter-row__refslabel">missing</span>
                      {row.missing.map((key) => <Chip key={key} tone="danger">{key}</Chip>)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        )}
      </SubNavLayout>

      <p className="ui-note">
        <Icon name="info" size={13} />
        <span>
          Dependencies are read from each filter&apos;s JQL. That is a recognizer rather than a
          full parser, so a reference found here is evidence a field is in use — finding none
          is not evidence that it is not.
        </span>
      </p>
    </>
  );
}
