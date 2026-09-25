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

// Dashboard inventory.
//
// A dashboard is the most visible thing in Jira and the least owned: it goes on a wall
// screen, gets linked in a status report, and is never opened again. It is also the end of a
// dependency chain nobody can see from either end -- a gadget reads a filter, the filter
// searches a field -- so deleting the field breaks the dashboard three steps later.
//
// This tab covers the dashboard's own health. The middle link is not read yet, and the note
// at the bottom says so rather than letting an absent join read as no dependency.

const PAGE_SIZE = 25;

// Ordered by consequence, the way the filter tab's are. An orphaned owner is a deletion date
// nobody has written down; an empty grid is a dashboard somebody did not finish.
export const DASHBOARD_FINDINGS = [
  { key: "all", label: "All dashboards", match: () => true },
  {
    key: "orphaned-owner",
    label: "No live owner",
    hint: "Jira deletes a dashboard with its owner. Anything linking to these breaks at the same moment.",
    match: (d) => d.findings.some((f) => f.code === "orphaned-owner"),
  },
  {
    key: "editable-by-everyone",
    label: "Anyone can edit",
    hint: "Any logged-in user can rearrange these for everybody who uses them, and the owner is not told.",
    match: (d) => d.findings.some((f) => f.code === "editable-by-everyone"),
  },
  {
    key: "published-unused",
    label: "Published, unwanted",
    hint: "Shared with every logged-in user and favourited by nobody.",
    match: (d) => d.findings.some((f) => f.code === "published-unused"),
  },
  {
    key: "empty",
    label: "No gadgets",
    hint: "Anyone opening these sees an empty grid.",
    match: (d) => d.findings.some((f) => f.code === "empty"),
  },
];

const SORTS = [
  { value: "findings", label: "Most findings first" },
  { value: "popularity", label: "Most favourited" },
  { value: "gadgets", label: "Most gadgets" },
  { value: "name", label: "Name A–Z" },
];

export function sortDashboards(dashboards, sort) {
  const rows = [...dashboards];
  if (sort === "name") return rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (sort === "popularity") return rows.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
  // Unwalked dashboards sort last rather than first: a null gadget count is unknown, and
  // leading a "most gadgets" list with dashboards nobody counted would be backwards.
  if (sort === "gadgets") return rows.sort((a, b) => (b.gadgetCount ?? -1) - (a.gadgetCount ?? -1));
  return rows.sort((a, b) => b.findings.length - a.findings.length || String(a.name).localeCompare(String(b.name)));
}

export function filterDashboards(dashboards, { search = "", finding = "all" } = {}) {
  const option = DASHBOARD_FINDINGS.find((f) => f.key === finding) ?? DASHBOARD_FINDINGS[0];
  const term = search.trim().toLowerCase();
  return dashboards.filter((row) => {
    if (!option.match(row)) return false;
    if (!term) return true;
    // Gadget titles are searched too, which is how somebody finds "every dashboard with a
    // Filter Results gadget" without leaving the tab.
    const gadgetTitles = (row.gadgets || []).map((g) => g.title || "").join(" ");
    return `${row.name} ${row.ownerName ?? ""} ${gadgetTitles}`.toLowerCase().includes(term);
  });
}

// What a single gadget chip's hover reveals: the filter behind it (Jira never names it in
// the gadget's own config, only its id, hence the join) and the fields that filter's JQL
// touches. Tri-state like everywhere else this chain is read: a gadget with no filterId at
// all has nothing to report, distinct from one whose filter exists but has not been
// resolved yet because no saved-filter inventory has been built.
export function gadgetTooltip(gadget) {
  if (!gadget.filterId) return undefined;
  if (gadget.filterName === null || gadget.fieldRefs === null) {
    return "Uses a saved filter — build a saved filter inventory to see which one and what it depends on.";
  }
  const filterPart = gadget.filterName ? `Filter: ${gadget.filterName}` : "Filter: (name unavailable)";
  const fields = gadget.fieldRefs || [];
  const fieldsPart = fields.length ? ` — depends on ${fields.join(", ")}` : " — depends on nothing this filter's JQL names";
  return `${filterPart}${fieldsPart}`;
}

function OwnerChip({ dashboard }) {
  if (!dashboard.owner) return <Chip tone="danger" title="The owning account no longer exists">owner deleted</Chip>;
  if (dashboard.ownerActive === false) return <Chip tone="warning" title="Owned by a deactivated account">{dashboard.ownerName} · inactive</Chip>;
  return <span className="dash-row__owner">{dashboard.ownerName ?? "—"}</span>;
}

function DashboardRow({ dashboard, siteOrigin }) {
  const href = siteOrigin ? `${siteOrigin}/jira/dashboards/${dashboard.id}` : null;

  return (
    <div className={`dash-row${dashboard.findings.length ? " dash-row--flagged" : ""}`}>
      <div className="dash-row__head">
        {href ? (
          <a
            className="dash-row__name"
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => handleJiraLinkClick(event, href)}
            title="Open this dashboard in Jira"
          >
            {dashboard.name}
          </a>
        ) : (
          <span className="dash-row__name">{dashboard.name}</span>
        )}
        <OwnerChip dashboard={dashboard} />
        {dashboard.editableByEveryone && <Chip tone="warning">anyone can edit</Chip>}
        {dashboard.sharedWithEveryone && <Chip tone="neutral">everyone can view</Chip>}
        <span className="dash-row__meta">
          {/* A dash, never a zero, when the gadget walk did not reach this one. */}
          {dashboard.gadgetCount === null ? "gadgets not read" : `${formatNumber(dashboard.gadgetCount)} gadget${dashboard.gadgetCount === 1 ? "" : "s"}`}
          {" · "}
          {dashboard.popularity > 0 ? `${formatNumber(dashboard.popularity)} favourited` : "favourited by nobody"}
        </span>
      </div>

      {dashboard.gadgets?.length > 0 && (
        <div className="dash-row__gadgets">
          {dashboard.gadgets.slice(0, 8).map((gadget) => (
            <Chip key={gadget.id} title={gadgetTooltip(gadget)}>{gadget.title || gadget.moduleKey || "Untitled gadget"}</Chip>
          ))}
          {dashboard.gadgets.length > 8 && (
            <span className="dash-row__more">+{dashboard.gadgets.length - 8} more</span>
          )}
        </div>
      )}

      {/* What this dashboard would take with it. Resolved through gadget -> filter -> field,
          so this is the same chain the field card runs in reverse -- a field card asking
          "which dashboards" and a dashboard asking "which fields" read from one join, not two
          that could disagree. Tri-state: null means the filter inventory the join needs was
          never built, distinct from a dashboard whose gadgets genuinely reference nothing. */}
      {dashboard.fieldRefs === null ? (
        <div className="dash-row__depends dash-row__depends--unmeasured">
          depends on: unknown — build a saved filter inventory to find out
        </div>
      ) : dashboard.fieldRefs?.length > 0 ? (
        <div className="filter-row__refs">
          <span className="filter-row__refslabel">depends on</span>
          {dashboard.fieldRefs.slice(0, 8).map((ref) => <Chip key={`f-${ref}`}>{ref}</Chip>)}
          {dashboard.fieldRefs.length > 8 && <span className="filter-row__more">+{dashboard.fieldRefs.length - 8} more</span>}
        </div>
      ) : null}

      {dashboard.findings.length > 0 && (
        <ul className="dash-row__findings">
          {dashboard.findings.map((finding) => (
            <li key={finding.code} className={`dash-row__finding dash-row__finding--${finding.severity}`}>
              {finding.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const DASHBOARD_FINDING_TONE = { "orphaned-owner": "critical", "editable-by-everyone": "warning" };

// The Overview's findings, from the same definitions the list filters by.
function DashboardFindings({ counts }) {
  const rows = DASHBOARD_FINDINGS
    .filter((f) => f.key !== "all" && (counts[f.key] ?? 0) > 0)
    .map((f) => ({ key: f.key, tone: DASHBOARD_FINDING_TONE[f.key] || "info", count: counts[f.key], title: f.label, detail: f.hint }));
  return (
    <AttentionPanel
      description="What the dashboards pillar of the site health score is built from."
      empty="Nothing flagged. Every dashboard has a live owner, none is open to edit, and none is empty."
    >
      {rows.map((r) => <FindingRow key={r.key} tone={r.tone} count={r.count} title={r.title} detail={r.detail} />)}
    </AttentionPanel>
  );
}

export function DashboardsTab({ siteOrigin = "", intent = null }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [view, setView] = usePersistentState("observatory.section.dashboards", "overview");
  const [search, setSearch] = React.useState("");
  const [finding, setFinding] = React.useState("all");
  const [sort, setSort] = React.useState("findings");
  const [page, setPage] = React.useState(1);

  const load = React.useCallback(async () => {
    try {
      const result = await invoke("getDashboardInventory", {});
      setData(result);
      setError("");
    } catch (err) {
      // A transient poll failure keeps the last good state rather than blanking the page.
      setError(err?.message || "Could not load the dashboard inventory.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  // A stale build never disables the control that could recover it; the shared hook applies
  // that rule (staleBuild) the same way for every pillar.
  const build = useSnapshotBuild({ resolver: "buildDashboardInventory", data, load });
  const isBuilding = build.isBuilding;
  const pillar = usePillarHealth("dashboards", data?.refreshedAt);

  useNavIntent(intent, (nav) => {
    // Arriving from a finding means the list, filtered to it.
    if (nav.finding) setView("dashboards");
    else if (nav.view) setView(nav.view);
    setFinding(nav.finding ?? "all");
    setSearch("");
    setPage(1);
  });

  React.useEffect(() => { setPage(1); }, [search, finding, sort]);

  const all = data?.allDashboards ?? [];
  // Findings are attached by the resolver to the flagged rows only, so the unflagged ones
  // need an empty list before anything can filter on it uniformly.
  const withFindings = React.useMemo(() => {
    const byId = new Map((data?.dashboards ?? []).map((d) => [d.id, d.findings]));
    return all.map((d) => ({ ...d, findings: byId.get(d.id) ?? [] }));
  }, [all, data?.dashboards]);

  const rows = React.useMemo(
    () => sortDashboards(filterDashboards(withFindings, { search, finding }), sort),
    [withFindings, search, finding, sort]
  );
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  if (loading && !data) return <EmptyState>Loading the dashboard inventory…</EmptyState>;

  const partialWalk = data?.available && data.gadgetsWalked > 0 && data.gadgetsWalked < data.total;
  const pagesUnreadable = Number(data?.pagesUnreadable) || 0;

  const rebuild = (
    <RebuildButton
      onClick={build.startBuild} isBuilding={isBuilding} starting={build.starting}
      neverBuilt={!data?.available && !data?.staleBuild} buildLabel="Build dashboard inventory"
    />
  );
  const header = (
    <PageHeader
      title="Dashboards"
      description="The most visible thing in Jira and the least owned. A dashboard on a wall screen owned by somebody who left has a deletion date nobody has written down."
      meta={data?.refreshedAt ? `Built ${formatRelativeTime(data.refreshedAt)}` : "Never built"}
      actions={rebuild}
    />
  );
  const banners = (
    <BuildBanners
      loadError={error} buildError={build.error} notice={build.notice}
      isBuilding={isBuilding} buildingMessage="Building the dashboard inventory… this page refreshes itself."
      staleBuild={data?.staleBuild} lastError={data?.lastError} builtAt={data?.available ? data?.refreshedAt : null}
    >
      {/* A partial pass cannot claim any unread dashboard is empty, so it says how far it got. */}
      {partialWalk && (
        <div className="ui-banner ui-banner--warning">
          Gadgets were read for {formatNumber(data.gadgetsWalked)} of {formatNumber(data.total)} dashboards.
          The rest show their gadget count as unread, and are not counted as empty.
        </div>
      )}
      {/* Jira's dashboard/search returns a permanent 400 past certain offsets; the build steps
          over such a page, and the inventory is then short the dashboards it held. */}
      {pagesUnreadable > 0 && (
        <div className="ui-banner ui-banner--warning">
          Jira refused {formatNumber(pagesUnreadable)} page{pagesUnreadable === 1 ? "" : "s"} of the
          dashboard list, so up to {formatNumber(pagesUnreadable * 50)} dashboards are missing from this
          inventory. Rebuild to try them again.
        </div>
      )}
    </BuildBanners>
  );

  if (!data?.available) {
    return (
      <>
        {header}
        {banners}
        <EmptyState action={rebuild}>
          No dashboard inventory yet. Build one to see which dashboards are orphaned, open to edit, or empty.
        </EmptyState>
      </>
    );
  }

  const findingCounts = Object.fromEntries(DASHBOARD_FINDINGS.map((o) => [o.key, withFindings.filter(o.match).length]));
  const items = [
    { key: "overview", label: "Overview", icon: "barChart" },
    { key: "dashboards", label: "Dashboards", icon: "grid", badge: formatNumber(data.total) },
  ];

  return (
    <>
      {header}
      {banners}

      <StatRow>
        <StatTile label="Dashboards" value={formatNumber(data.total)} hint="On this site" icon="grid" />
        <StatTile
          label="No live owner"
          value={formatNumber(data.orphanedCount)}
          hint="Jira deletes a dashboard with its owner"
          tone={data.orphanedCount > 0 ? "critical" : "success"}
          icon="user"
        />
        <StatTile
          label="Anyone can edit"
          value={formatNumber(data.editableByEveryoneCount)}
          hint="Rearranged for everyone, owner not told"
          tone={data.editableByEveryoneCount > 0 ? "warning" : "success"}
          icon="alertTriangle"
        />
        <StatTile
          label="Gadgets"
          value={formatNumber(data.totalGadgets)}
          hint={data.emptyCount === null
            ? "some dashboards were not read"
            : `${formatNumber(data.emptyCount)} dashboards carry none`}
          icon="barChart"
        />
      </StatRow>

      <SubNavLayout items={items} activeKey={view} onSelect={setView}>
        {view === "overview" && (
          <PillarOverview
            governance={<PillarHealthPanel pillar={pillar} />}
            attention={<DashboardFindings counts={findingCounts} />}
          />
        )}

        {view === "dashboards" && (
          <Panel
            title="Dashboards"
            icon="barChart"
            description="Search matches the name, the owner and the gadget titles — which is how you find every dashboard carrying a particular gadget without leaving this tab."
          >
            <SortFilterBar
              search={search}
              onSearchChange={setSearch}
              searchLabel="Search dashboards"
              searchPlaceholder="Name, owner, or a gadget title…"
              sort={sort}
              onSortChange={setSort}
              sortOptions={SORTS}
              resultCount={rows.length}
              totalCount={data.total}
              onClear={() => { setSearch(""); setFinding("all"); setSort("findings"); }}
            />

            <div className="findings-filter-bar">
              {DASHBOARD_FINDINGS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  title={option.hint}
                  className={`findings-filter-button${finding === option.key ? " findings-filter-button--active" : ""}`}
                  onClick={() => setFinding(option.key)}
                >
                  <span>{option.label}</span>
                  <strong>{formatNumber(findingCounts[option.key])}</strong>
                </button>
              ))}
            </div>

            {pageRows.length === 0 ? (
              <EmptyState inline>No dashboard matches these filters.</EmptyState>
            ) : (
              <div className="dash-list">
                {pageRows.map((row) => <DashboardRow key={row.id} dashboard={row} siteOrigin={siteOrigin} />)}
              </div>
            )}

            {pages > 1 && (
              <section className="pagination-bar">
                <span className="pagination-bar__status">
                  Page {formatNumber(page)} of {formatNumber(pages)} · {formatNumber(rows.length)} dashboards
                </span>
                <div className="pagination-bar__actions">
                  <button type="button" className="ghost-button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>Previous</button>
                  <button type="button" className="ghost-button" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages}>Next</button>
                </div>
              </section>
            )}

            {/* The missing link, stated rather than left to be inferred from its absence. */}
            <p className="ui-note">
              <Icon name="info" size={13} />
              <span>
                Which filter each gadget reads is not part of this inventory yet — Jira exposes it
                only through per-gadget properties. So a dashboard is not currently evidence that a
                filter or a field is in use, and nothing here should be read as saying it is.
              </span>
            </p>
          </Panel>
        )}
      </SubNavLayout>
    </>
  );
}
