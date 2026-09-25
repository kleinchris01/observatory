import React from "react";
import { invoke } from "@forge/bridge";
import { formatNumber, formatRelativeTime, handleJiraLinkClick } from "../utils";
import { Icon } from "../components/Icons";
import {
  StatTile, StatRow, Panel, EmptyState, Chip, PageHeader, SortFilterBar, PillarHealthPanel, FindingRow,
  RebuildButton, BuildBanners, AttentionPanel, PillarOverview,
} from "../components/ui";
import { SubNavLayout } from "../components/admin/primitives";
import { useNavIntent, usePersistentState, useSnapshotBuild, usePillarHealth } from "../hooks";
// The pure filter/search/sort logic now lives in filter-query.js and runs on the SERVER --
// see getFilterInventory. Re-exported here so this module is still the one place tests and
// other tabs import FILTER_FINDINGS/filterRows/sortFilters from; there is exactly one
// implementation, just no longer one that runs a second time in the browser over the whole
// inventory.
export { FILTER_FINDINGS, filterRows, sortFilters } from "../../../src/lib/filter-query.js";
import { FILTER_FINDINGS } from "../../../src/lib/filter-query.js";

// Display labels for the sort dropdown. The KEYS have to match FILTER_SORTS in
// filter-query.js -- the server validates against that list and falls back to "findings" for
// anything else, so a key added here without a matching server case would silently sort by
// relevance instead of doing what the label promised.
const SORTS = [
  { value: "findings", label: "Most findings first" },
  { value: "name", label: "Name A–Z" },
  { value: "subscriptions", label: "Most subscriptions" },
  { value: "stale", label: "Least recently opened" },
];

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

function OwnerChip({ filter }) {
  if (!filter.owner) return <Chip tone="danger" title="The owning account no longer exists">owner deleted</Chip>;
  if (filter.ownerActive === false) return <Chip tone="warning" title="Owned by a deactivated account">{filter.ownerName} · inactive</Chip>;
  return <span className="filter-row__owner">{filter.ownerName ?? "—"}</span>;
}

function FilterRow({ filter, siteOrigin, lastUsedTracked = true }) {
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
          {filter.lastUsedAt
            ? `opened ${formatRelativeTime(filter.lastUsedAt)}`
            : lastUsedTracked
              ? "never opened"
              : "last-opened not tracked"}
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

const FINDING_TONE = { danger: "critical", warning: "warning" };

// The Overview's findings, from the same definitions the Filters view filters by, so a count
// here and the list it opens can never disagree about what the finding is.
function FilterFindings({ data, findingOptions }) {
  const counts = data?.findingCounts ?? {};
  const rows = findingOptions
    .filter((f) => f.key !== "all" && (counts[f.key] ?? 0) > 0)
    .map((f) => ({ key: f.key, tone: FINDING_TONE[f.tone] || "info", count: counts[f.key], title: f.label, detail: f.hint }));
  if ((data?.duplicateGroupCount ?? 0) > 0) {
    rows.push({ key: "duplicates", tone: "info", count: data.duplicateGroupCount, title: "Duplicate filters", detail: "Groups of filters with the same JQL. Keep one, repoint the rest." });
  }
  if ((data?.brokenProjectCount ?? 0) > 0) {
    rows.push({ key: "broken", tone: "warning", count: data.brokenProjectCount, title: "Filters naming a deleted project", detail: "The JQL errors or silently returns less than it did." });
  }
  return (
    <AttentionPanel
      description="What the filters pillar of the site health score is built from."
      empty="Nothing flagged. Every filter has a live owner and none is shared with everyone."
    >
      {rows.map((r) => <FindingRow key={r.key} tone={r.tone} count={r.count} title={r.title} detail={r.detail} />)}
    </AttentionPanel>
  );
}

export function FiltersTab({ siteOrigin = "", intent = null }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [view, setView] = usePersistentState("observatory.section.filters", "overview");
  const [search, setSearch] = React.useState("");
  // Debounced, the same way FieldBrowserTab debounces its own search box: typing fires a
  // request per keystroke otherwise, and each one is now a server-side scan of every
  // filter's name and JQL rather than a filter over an array already in the browser.
  const [deferredSearch, setDeferredSearch] = React.useState("");
  const [finding, setFinding] = React.useState("all");
  const [sort, setSort] = React.useState("findings");
  const [page, setPage] = React.useState(1);

  React.useEffect(() => {
    const t = setTimeout(() => { setDeferredSearch(search); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [search]);

  // What used to run in the browser over the whole inventory now runs on the server over
  // the same in-memory list, and only the current page crosses the wire. At 4,115 filters,
  // shipping every one of them in a single response overflowed Forge's per-invocation
  // payload limit -- the resolver was killing itself trying to answer this tab.
  const load = React.useCallback(async () => {
    try {
      const result = await invoke("getFilterInventory", {
        search: deferredSearch, finding, sort, page, pageSize: PAGE_SIZE,
      });
      setData(result);
      setError("");
    } catch (err) {
      // A transient poll failure keeps the last good state rather than blanking the page.
      setError(err?.message || "Could not load the filter inventory.");
    } finally {
      setLoading(false);
    }
  }, [deferredSearch, finding, sort, page]);

  React.useEffect(() => { load(); }, [load]);

  // "building" alone is not enough to believe: a Forge invocation timeout is a hard kill,
  // so a stale build must never disable the only control that could recover it. The shared
  // hook applies that rule (staleBuild) for every pillar.
  const build = useSnapshotBuild({ resolver: "buildFilterInventory", data, load });
  const isBuilding = build.isBuilding;
  const pillar = usePillarHealth("filters", data?.refreshedAt);

  useNavIntent(intent, (nav) => {
    if (nav.view) setView(nav.view);
    setFinding(nav.finding ?? "all");
    setSearch("");
    setDeferredSearch("");
    setPage(1);
  });

  React.useEffect(() => { setPage(1); }, [finding, sort]);

  // The current page, already filtered and sorted server-side. `data.matchedTotal` is how
  // many filters match the current search/finding -- distinct from `data.total`, the size of
  // the whole inventory regardless of what is currently being searched for.
  const pageRows = data?.filters ?? [];
  const matchedTotal = data?.matchedTotal ?? 0;
  const totalPages = data?.totalPages ?? 1;
  const findingCounts = data?.findingCounts ?? {};

  if (loading && !data) return <EmptyState>Loading the saved filter inventory…</EmptyState>;

  const rebuild = (
    <RebuildButton
      onClick={build.startBuild} isBuilding={isBuilding} starting={build.starting}
      neverBuilt={!data?.available && !data?.staleBuild} buildLabel="Build filter inventory"
    />
  );
  const header = (
    <PageHeader
      title="Saved filters"
      description="Which searches exist, who owns them, and what they depend on. A filter is the one piece of Jira configuration that fails silently in both directions."
      meta={data?.refreshedAt ? `Built ${formatRelativeTime(data.refreshedAt)}` : "Never built"}
      actions={rebuild}
    />
  );
  const banners = (
    <BuildBanners
      loadError={error} buildError={build.error} notice={build.notice}
      isBuilding={isBuilding} buildingMessage="Building the filter inventory… this page refreshes itself."
      staleBuild={data?.staleBuild} lastError={data?.lastError} builtAt={data?.available ? data?.refreshedAt : null}
    />
  );

  if (!data?.available) {
    return (
      <>
        {header}
        {banners}
        <EmptyState action={rebuild}>
          No filter inventory yet. Build one to see which filters are orphaned, over-shared, or holding a field open.
        </EmptyState>
      </>
    );
  }

  const sections = [
    { key: "overview", label: "Overview", icon: "barChart" },
    { key: "filters", label: "Filters", icon: "search", badge: formatNumber(data.total) },
    { key: "duplicates", label: "Duplicates", icon: "copy", badge: formatNumber(data.duplicateGroupCount) },
    { key: "broken", label: "Deleted project", icon: "alertTriangle", badge: formatNumber(data.brokenProjectCount) },
  ];

  // Jira does not populate last-used on every instance. When it populates it for nothing,
  // the "not opened in a year" finding and its sort are noise -- drop them rather than show
  // a 0 for a thing we could not measure.
  const lastUsedTracked = data.lastUsedTracked !== false;
  const findingOptions = lastUsedTracked ? FILTER_FINDINGS : FILTER_FINDINGS.filter((o) => o.key !== "stale");
  const sortOptions = lastUsedTracked ? SORTS : SORTS.filter((o) => o.value !== "stale");

  return (
    <>
      {header}
      {banners}

      <StatRow>
        <StatTile label="Saved filters" value={formatNumber(data.total)} hint="On this site" icon="search" />
        <StatTile
          label="No live owner"
          value={formatNumber(data.orphanedCount)}
          hint="Jira deletes a filter with its owner"
          tone={data.orphanedCount > 0 ? "critical" : "success"}
          icon="user"
        />
        <StatTile
          label="Shared with everyone"
          value={formatNumber(data.sharedWithEveryoneCount)}
          hint="Any logged-in user can run these"
          tone={data.sharedWithEveryoneCount > 0 ? "warning" : "success"}
          icon="alertTriangle"
        />
        <StatTile
          label="Email subscriptions"
          value={formatNumber(data.subscriptionTotal)}
          hint={data.subscribedButUnusedCount > 0 ? `${formatNumber(data.subscribedButUnusedCount)} on filters nobody opens` : "Across every filter"}
          tone={data.subscribedButUnusedCount > 0 ? "warning" : "neutral"}
          icon="bell"
        />
      </StatRow>

      <SubNavLayout items={sections} activeKey={view} onSelect={setView}>
        {view === "overview" && (
          <PillarOverview
            governance={<PillarHealthPanel pillar={pillar} />}
            attention={<FilterFindings data={data} findingOptions={findingOptions} />}
          />
        )}

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
              sortOptions={sortOptions}
              resultCount={matchedTotal}
              totalCount={data.total}
              onClear={() => { setSearch(""); setDeferredSearch(""); setFinding("all"); setSort("findings"); }}
            />

            {/* Counts here describe the WHOLE inventory, computed by the server over the full
                analyzed list -- not the current page, which may hold none of a given kind.
                Re-deriving them from pageRows would report "0 orphaned" on a page that
                happens not to contain one, on a site that has hundreds. */}
            <div className="findings-filter-bar">
              {findingOptions.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  title={option.hint}
                  className={`findings-filter-button${finding === option.key ? " findings-filter-button--active" : ""}`}
                  onClick={() => setFinding(option.key)}
                >
                  <span>{option.label}</span>
                  <strong>{formatNumber(findingCounts[option.key] ?? 0)}</strong>
                </button>
              ))}
            </div>

            {pageRows.length === 0 ? (
              <EmptyState inline>No filter matches these filters.</EmptyState>
            ) : (
              <div className="filter-list">
                {pageRows.map((row) => <FilterRow key={row.id} filter={row} siteOrigin={siteOrigin} lastUsedTracked={data.lastUsedTracked !== false} />)}
              </div>
            )}

            {totalPages > 1 && (
              <section className="pagination-bar">
                <span className="pagination-bar__status">
                  Page {formatNumber(page)} of {formatNumber(totalPages)} · {formatNumber(matchedTotal)} filters
                </span>
                <div className="pagination-bar__actions">
                  <button type="button" className="ghost-button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading}>Previous</button>
                  <button type="button" className="ghost-button" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages || loading}>Next</button>
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
