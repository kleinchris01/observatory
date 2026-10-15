import React from "react";
import { invoke } from "@forge/bridge";
import { formatNumber, formatRelativeTime, handleJiraLinkClick } from "../utils";
import { Icon } from "../components/Icons";
import {
  StatTile,
  StatRow,
  Panel,
  EmptyState,
  Chip,
  PageHeader,
  SortFilterBar,
  PanelGrid,
  GridSpan,
  PillarHealthPanel,
} from "../components/ui";
import { useNavIntent, useVisiblePolling } from "../hooks";

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
const POLL_MS = 4000;

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
    key: "broken-gadget",
    label: "Broken gadgets",
    hint: "A gadget reads a filter that is deleted, or private to its owner -- everyone else sees an error.",
    match: (d) => d.findings.some((f) => f.code === "broken-gadget"),
  },
  {
    key: "shared-publicly",
    label: "Shared publicly",
    hint: "Shared globally. On a site that allows anonymous access, anyone with the link can open these.",
    match: (d) => d.findings.some((f) => f.code === "shared-publicly"),
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
  // Said first: a filter nobody can read is the fact that matters, whatever else is known.
  if (gadget.filterState === "missing")
    return `Filter ${gadget.filterId} no longer exists, or this app cannot see it -- viewers see an error here.`;
  if (gadget.filterState === "private")
    return `Filter ${gadget.filterId} is private to its owner -- everyone else sees an error here.`;
  if (gadget.filterName === null || gadget.fieldRefs === null) {
    return "Uses a saved filter — build a saved filter inventory to see which one and what it depends on.";
  }
  const filterPart = gadget.filterName ? `Filter: ${gadget.filterName}` : "Filter: (name unavailable)";
  const fields = gadget.fieldRefs || [];
  const fieldsPart = fields.length
    ? ` — depends on ${fields.join(", ")}`
    : " — depends on nothing this filter's JQL names";
  return `${filterPart}${fieldsPart}`;
}

function OwnerChip({ dashboard }) {
  if (!dashboard.owner)
    return (
      <Chip tone="danger" title="The owning account no longer exists">
        owner deleted
      </Chip>
    );
  if (dashboard.ownerActive === false)
    return (
      <Chip tone="warning" title="Owned by a deactivated account">
        {dashboard.ownerName} · inactive
      </Chip>
    );
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
        {dashboard.findings?.some((f) => f.code === "shared-publicly") ? (
          <Chip
            tone="critical"
            title="Shared globally: anonymous visitors can open it on a site that allows public access"
          >
            public
          </Chip>
        ) : (
          dashboard.sharedWithEveryone && <Chip tone="neutral">everyone can view</Chip>
        )}
        <span className="dash-row__meta">
          {/* A dash, never a zero, when the gadget walk did not reach this one. */}
          {dashboard.gadgetCount === null
            ? "gadgets not read"
            : `${formatNumber(dashboard.gadgetCount)} gadget${dashboard.gadgetCount === 1 ? "" : "s"}`}
          {" · "}
          {dashboard.popularity > 0 ? `${formatNumber(dashboard.popularity)} favourited` : "favourited by nobody"}
        </span>
      </div>

      {dashboard.gadgets?.length > 0 && (
        <div className="dash-row__gadgets">
          {dashboard.gadgets.slice(0, 8).map((gadget) => (
            <Chip
              key={gadget.id}
              tone={
                gadget.filterState === "missing" ? "critical" : gadget.filterState === "private" ? "warning" : "neutral"
              }
              title={gadgetTooltip(gadget)}
            >
              {gadget.title || gadget.moduleKey || "Untitled gadget"}
            </Chip>
          ))}
          {dashboard.gadgets.length > 8 && <span className="dash-row__more">+{dashboard.gadgets.length - 8} more</span>}
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
          {dashboard.fieldRefs.slice(0, 8).map((ref) => (
            <Chip key={`f-${ref}`}>{ref}</Chip>
          ))}
          {dashboard.fieldRefs.length > 8 && (
            <span className="filter-row__more">+{dashboard.fieldRefs.length - 8} more</span>
          )}
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

export function DashboardsTab({ siteOrigin = "", intent = null }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [building, setBuilding] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [finding, setFinding] = React.useState("all");
  const [sort, setSort] = React.useState("findings");
  const [page, setPage] = React.useState(1);
  const [pillar, setPillar] = React.useState(null);

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

  React.useEffect(() => {
    load();
  }, [load]);

  // Poll only while a build is in flight and only while somebody is looking.
  // "building" alone is not enough to believe: a Forge invocation timeout is a hard kill, so
  // the state outlives the job that set it and the tab would disable the only control that
  // could recover it. Same derivation as the filter and screen pillars.
  const isBuilding = ["building", "queued"].includes(data?.state) && !data?.staleBuild;

  useVisiblePolling(isBuilding, load, POLL_MS);

  React.useEffect(() => {
    let cancelled = false;
    invoke("getPillarHealth", { pillar: "dashboards" })
      .then((result) => {
        if (!cancelled) setPillar(result?.pillar || null);
      })
      .catch(() => {
        if (!cancelled) setPillar(null);
      });
    return () => {
      cancelled = true;
    };
  }, [data?.refreshedAt]);

  useNavIntent(intent, (nav) => {
    setFinding(nav.finding ?? "all");
    setSearch("");
    setPage(1);
  });

  React.useEffect(() => {
    setPage(1);
  }, [search, finding, sort]);

  async function handleBuild() {
    setBuilding(true);
    try {
      const result = await invoke("buildDashboardInventory", {});
      if (result?.error) setError(result.error);
      else await load();
    } catch (err) {
      setError(err?.message || "Could not start the build.");
    } finally {
      setBuilding(false);
    }
  }

  const all = data?.allDashboards ?? [];
  // Findings are attached by the resolver to the flagged rows only, so the unflagged ones
  // need an empty list before anything can filter on it uniformly.
  const withFindings = React.useMemo(() => {
    const byId = new Map((data?.dashboards ?? []).map((d) => [d.id, d.findings]));
    return all.map((d) => ({ ...d, findings: byId.get(d.id) ?? [] }));
  }, [all, data?.dashboards]);

  const rows = React.useMemo(
    () => sortDashboards(filterDashboards(withFindings, { search, finding }), sort),
    [withFindings, search, finding, sort],
  );
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  if (loading && !data) return <EmptyState>Loading the dashboard inventory…</EmptyState>;

  if (!data?.available) {
    return (
      <>
        <PageHeader
          title="Dashboards"
          description="Which dashboards exist, who owns them, and what is on them. Read-only — Observatory reports what is configured; changes stay in Jira's own admin UI."
        />
        <EmptyState
          action={
            <button type="button" className="primary-button" onClick={handleBuild} disabled={building || isBuilding}>
              {isBuilding
                ? "Building…"
                : building
                  ? "Starting…"
                  : data?.staleBuild
                    ? "Rebuild"
                    : "Build dashboard inventory"}
            </button>
          }
        >
          {data?.staleBuild
            ? "A build was started but is no longer running — it most likely hit the invocation time limit. Rebuild to recover it."
            : isBuilding
              ? "Building the dashboard inventory…"
              : data?.lastError
                ? `The last build failed: ${data.lastError}`
                : "No dashboard inventory yet. Build one to see which dashboards are orphaned, open to edit, or empty."}
        </EmptyState>
        {error && <div className="error-banner">{error}</div>}
      </>
    );
  }

  const partialWalk = data.gadgetsWalked > 0 && data.gadgetsWalked < data.total;
  const pagesUnreadable = Number(data.pagesUnreadable) || 0;

  return (
    <>
      <PageHeader
        title="Dashboards"
        description="The most visible thing in Jira and the least owned. A dashboard on a wall screen owned by somebody who left has a deletion date nobody has written down."
        meta={data.refreshedAt ? `Built ${formatRelativeTime(data.refreshedAt)}` : undefined}
        actions={
          <button type="button" className="secondary-button" onClick={handleBuild} disabled={building || isBuilding}>
            {isBuilding ? "Building…" : "Rebuild"}
          </button>
        }
      />

      {error && <div className="error-banner">{error}</div>}

      <PanelGrid>
        <GridSpan>
          <PillarHealthPanel pillar={pillar} />
        </GridSpan>
        <GridSpan>
          <Panel title="Estate" icon="barChart">
            <StatRow>
              <StatTile label="Dashboards" value={formatNumber(data.total)} icon="barChart" />
              <StatTile
                label="No live owner"
                value={formatNumber(data.orphanedCount)}
                hint="Jira deletes a dashboard with its owner"
                tone={data.orphanedCount > 0 ? "critical" : "neutral"}
              />
              <StatTile
                label="Anyone can edit"
                value={formatNumber(data.editableByEveryoneCount)}
                tone={data.editableByEveryoneCount > 0 ? "warning" : "neutral"}
              />
              <StatTile
                label="Gadgets"
                value={formatNumber(data.totalGadgets)}
                hint={
                  data.emptyCount === null
                    ? "some dashboards were not read"
                    : `${formatNumber(data.emptyCount)} dashboards carry none`
                }
              />
            </StatRow>
          </Panel>
        </GridSpan>
      </PanelGrid>

      {/* A partial pass cannot claim any unread dashboard is empty, so it says how far it
          got rather than presenting itself as complete. */}
      {partialWalk && (
        <p className="ui-note">
          <Icon name="info" size={13} />
          <span>
            Gadgets were read for {formatNumber(data.gadgetsWalked)} of {formatNumber(data.total)} dashboards. The rest
            show their gadget count as unread, and are not counted as empty.
          </span>
        </p>
      )}

      {/* Jira's dashboard/search returns a permanent 400 past certain offsets. The build steps
          over such a page rather than failing the whole scan, but the inventory is then short
          the dashboards that page held. */}
      {pagesUnreadable > 0 && (
        <p className="ui-note">
          <Icon name="info" size={13} />
          <span>
            Jira refused {formatNumber(pagesUnreadable)} page{pagesUnreadable === 1 ? "" : "s"} of the dashboard list,
            so up to {formatNumber(pagesUnreadable * 50)} dashboards are missing from this inventory. Rebuild to try
            them again.
          </span>
        </p>
      )}

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
          onClear={() => {
            setSearch("");
            setFinding("all");
            setSort("findings");
          }}
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
              <strong>{formatNumber(withFindings.filter(option.match).length)}</strong>
            </button>
          ))}
        </div>

        {pageRows.length === 0 ? (
          <EmptyState inline>No dashboard matches these filters.</EmptyState>
        ) : (
          <div className="dash-list">
            {pageRows.map((row) => (
              <DashboardRow key={row.id} dashboard={row} siteOrigin={siteOrigin} />
            ))}
          </div>
        )}

        {pages > 1 && (
          <section className="pagination-bar">
            <span className="pagination-bar__status">
              Page {formatNumber(page)} of {formatNumber(pages)} · {formatNumber(rows.length)} dashboards
            </span>
            <div className="pagination-bar__actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                Previous
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
                disabled={page >= pages}
              >
                Next
              </button>
            </div>
          </section>
        )}
      </Panel>

      {/* What the gadget -> filter link can and cannot prove, stated rather than inferred. */}
      <p className="ui-note">
        <Icon name="info" size={13} />
        <span>
          Each gadget's filter is read from the gadget's own properties, which is how a dashboard counts as evidence
          that a filter, and the fields it searches, are in use. A gadget whose properties Jira would not return is
          recorded with no filter, so a dashboard that names no filter is not proof that it depends on none.
        </span>
      </p>
    </>
  );
}
