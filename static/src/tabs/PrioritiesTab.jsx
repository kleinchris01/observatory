import React from "react";
import { invoke } from "@forge/bridge";
import { formatNumber, formatRelativeTime } from "../utils";
import { Icon } from "../components/Icons";
import {
  StatTile, StatRow, Panel, EmptyState, Chip, PageHeader,
  PanelGrid, GridSpan, PillarHealthPanel, FindingRow, SortFilterBar,
} from "../components/ui";
import { SubNavLayout } from "../components/admin/primitives";
import { useNavIntent, useVisiblePolling } from "../hooks";

// The two global value lists in Jira's "Issues" admin section that don't have their own
// pillar yet: resolutions and priorities. Statuses and issue types are covered elsewhere.
//
// The one finding that matters is the same one the workflow and issue-type pillars run:
// near-duplicate names. A site with "Done", "Fixed", "Complete" and "Resolved" as separate
// resolutions cannot produce a correct resolution-based report. Read-only.

const BUILD_POLL_MS = 3000;
const STALE_AFTER_DAYS = 7;

function daysSince(iso) {
  const at = Date.parse(iso || "");
  if (!Number.isFinite(at)) return null;
  return (Date.now() - at) / (24 * 60 * 60 * 1000);
}

function ValueRow({ item, duplicate }) {
  return (
    <div className="issue-type-row">
      <div className="issue-type-row__identity">
        <span className="issue-type-row__name">{item.name}</span>
        {item.description && <span className="issue-type-row__desc">{item.description}</span>}
      </div>
      <div className="issue-type-row__meta">
        {item.isDefault && <Chip tone="neutral" title="The default for this list">default</Chip>}
        {duplicate && <Chip tone="warning" title={`Near-duplicate of: ${duplicate}`}>duplicate name</Chip>}
      </div>
    </div>
  );
}

function EstateFindings({ governance }) {
  const g = governance || {};
  const rows = [];
  if (g.reducibleResolutionCount > 0) {
    rows.push({
      tone: "warning", count: g.reducibleResolutionCount,
      title: "Near-duplicate resolution names",
      detail: `${g.resolutionDuplicateGroupCount} group${g.resolutionDuplicateGroupCount === 1 ? "" : "s"} — every resolution-based report is split across the synonyms. ${(g.resolutionDuplicateGroups || []).slice(0, 4).map((x) => x.names.join(" / ")).join("; ")}`,
    });
  }
  if (g.reduciblePriorityCount > 0) {
    rows.push({
      tone: "info", count: g.reduciblePriorityCount,
      title: "Near-duplicate priority names",
      detail: (g.priorityDuplicateGroups || []).slice(0, 4).map((x) => x.names.join(" / ")).join("; ") || "Priorities that almost certainly mean the same thing.",
    });
  }
  if (g.resolutionsWithoutDefault) {
    rows.push({ tone: "info", title: "The resolution list has no default", detail: "Jira falls back to the first entry, which shifts if the order changes." });
  }
  if (g.prioritiesWithoutDefault) {
    rows.push({ tone: "info", title: "The priority list has no default", detail: "New issues get the first priority in the list." });
  }

  return (
    <Panel title="What needs attention" icon="alertTriangle" description="What the priorities & resolutions pillar of the site health score is built from.">
      {rows.length === 0
        ? <EmptyState inline>Nothing flagged. No name collisions, and both lists have a default.</EmptyState>
        : rows.map((r) => <FindingRow key={r.title} tone={r.tone} title={r.title} detail={r.detail} count={r.count} />)}
    </Panel>
  );
}

// name -> the other names it collides with, for the per-row chip.
function duplicateMap(groups = []) {
  const m = new Map();
  for (const g of groups) {
    for (const name of g.names) {
      m.set(name, g.names.filter((n) => n !== name).join(", "));
    }
  }
  return m;
}

export function PrioritiesTab({ intent }) {
  const [view, setView] = React.useState("overview");
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [building, setBuilding] = React.useState(false);
  const [search, setSearch] = React.useState("");

  useNavIntent(intent, (nav) => {
    if (nav.view) setView(nav.view);
    setSearch("");
  });

  const load = React.useCallback(async () => {
    try {
      const result = await invoke("getEstateInventory", {});
      setData(result);
      setError("");
    } catch (err) {
      setError(err?.message || "Could not load the priorities & resolutions inventory.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const [pillar, setPillar] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    invoke("getPillarHealth", { pillar: "estate" })
      .then((result) => { if (!cancelled) setPillar(result?.pillar || null); })
      .catch(() => { if (!cancelled) setPillar(null); });
    return () => { cancelled = true; };
  }, [data?.refreshedAt]);

  const isBuilding = ["building", "queued"].includes(data?.state) && !data?.staleBuild;
  useVisiblePolling(isBuilding, load, BUILD_POLL_MS);

  async function startBuild() {
    setBuilding(true);
    setError("");
    setNotice("");
    try {
      const result = await invoke("buildEstateInventory", {});
      await load();
      if (result?.error) {
        setError(result.error);
      } else if (result?.queued === false && result?.reason === "already-building") {
        setNotice("A build is already running. This page refreshes itself while it does.");
      } else {
        setNotice("Build queued. This page refreshes itself while it runs.");
      }
    } catch (err) {
      setError(err?.message || "Could not start the build.");
    } finally {
      setBuilding(false);
    }
  }

  const buildAction = (
    <button type="button" className="secondary-button" onClick={startBuild} disabled={building || isBuilding}>
      <Icon name="refreshCw" size={13} />
      {isBuilding ? "Building…" : data?.neverBuilt ? "Build inventory" : "Rebuild"}
    </button>
  );

  if (loading && !data) {
    return <div className="empty-state">Loading the priorities & resolutions inventory…</div>;
  }

  const header = (
    <PageHeader
      title="Priorities & Resolutions"
      description="The two global value lists every issue draws on. Read-only — changes stay in Jira's admin UI."
      meta={data?.refreshedAt ? `Built ${formatRelativeTime(data.refreshedAt)}` : "Never built"}
      actions={buildAction}
    />
  );

  const banners = (
    <>
      {error && <div className="danger-zone__error" role="alert">{error}</div>}
      {notice && !error && <p className="admin-config-row__hint" role="status">{notice}</p>}
      {isBuilding && <p className="admin-config-row__hint">Reading the lists… this page refreshes itself.</p>}
      {data?.staleBuild && (
        <p className="admin-config-row__hint">A build was started but is no longer running. Rebuild to recover it.</p>
      )}
      {data?.lastError && !isBuilding && (
        <div className="danger-zone__error" role="alert">Last build failed: {data.lastError}</div>
      )}
    </>
  );

  if (data?.neverBuilt) {
    return (
      <div className="admin-issue-types">
        {header}
        {banners}
        <EmptyState action={buildAction}>
          No priorities & resolutions inventory has been built yet. It is also produced by
          every full and quick scan — or build it on its own here.
        </EmptyState>
      </div>
    );
  }

  const g = data?.governance || {};
  const resolutions = data?.resolutions || [];
  const priorities = data?.priorities || [];
  const resolutionDupes = duplicateMap(g.resolutionDuplicateGroups);
  const priorityDupes = duplicateMap(g.priorityDuplicateGroups);
  const buildAgeDays = daysSince(data?.refreshedAt);
  const isStale = buildAgeDays != null && buildAgeDays > STALE_AFTER_DAYS;
  const term = search.trim().toLowerCase();

  const items = [
    { key: "overview", label: "Overview", icon: "barChart" },
    { key: "resolutions", label: "Resolutions", icon: "checkCircle", badge: formatNumber(resolutions.length) },
    { key: "priorities", label: "Priorities", icon: "flag", badge: formatNumber(priorities.length) },
  ];

  const filterList = (list) => term ? list.filter((x) => x.name.toLowerCase().includes(term)) : list;

  return (
    <div className="admin-issue-types">
      {header}
      {banners}

      <StatRow>
        <StatTile label="Resolutions" value={formatNumber(g.totalResolutions ?? resolutions.length)} hint="Global list" icon="checkCircle" />
        <StatTile label="Priorities" value={formatNumber(g.totalPriorities ?? priorities.length)} hint="Global list" icon="flag" />
        <StatTile
          label="Duplicate resolution names"
          value={formatNumber(g.reducibleResolutionCount ?? 0)}
          hint={(g.reducibleResolutionCount ?? 0) > 0 ? "Split every resolution report" : "No collisions"}
          tone={(g.reducibleResolutionCount ?? 0) > 0 ? "warning" : "success"}
          icon="alertTriangle"
        />
        <StatTile
          label="Duplicate priority names"
          value={formatNumber(g.reduciblePriorityCount ?? 0)}
          hint={(g.reduciblePriorityCount ?? 0) > 0 ? "Likely mean the same thing" : "No collisions"}
          tone={(g.reduciblePriorityCount ?? 0) > 0 ? "warning" : "success"}
          icon="alertTriangle"
        />
      </StatRow>

      {isStale && (
        <Panel title="This inventory is stale" icon="alertTriangle">
          <p>It was built {Math.floor(buildAgeDays)} days ago. Every full and quick scan refreshes it — run one, or rebuild here.</p>
        </Panel>
      )}

      <SubNavLayout items={items} activeKey={view} onSelect={setView}>
        {view === "overview" && (
          <PanelGrid>
            <GridSpan><PillarHealthPanel pillar={pillar} /></GridSpan>
            <GridSpan><EstateFindings governance={g} /></GridSpan>
          </PanelGrid>
        )}

        {view === "resolutions" && (
          <Panel title="Resolutions" icon="checkCircle" description="The global resolution list. Jira offers no scheme layer to scope it — every project sees all of these.">
            <SortFilterBar
              search={search} onSearchChange={setSearch}
              searchLabel="Search resolutions" searchPlaceholder="Search by name…"
              resultCount={filterList(resolutions).length} totalCount={resolutions.length}
              onClear={() => setSearch("")}
            />
            {resolutions.length === 0 ? (
              <EmptyState inline>No resolutions in this snapshot.</EmptyState>
            ) : (
              <div className="issue-type-list">
                {filterList(resolutions).map((r) => (
                  <ValueRow key={r.id} item={r} duplicate={resolutionDupes.get(r.name)} />
                ))}
              </div>
            )}
          </Panel>
        )}

        {view === "priorities" && (
          <Panel title="Priorities" icon="flag" description="The global priority list, in the order it appears on the priority picker.">
            <SortFilterBar
              search={search} onSearchChange={setSearch}
              searchLabel="Search priorities" searchPlaceholder="Search by name…"
              resultCount={filterList(priorities).length} totalCount={priorities.length}
              onClear={() => setSearch("")}
            />
            {priorities.length === 0 ? (
              <EmptyState inline>No priorities in this snapshot.</EmptyState>
            ) : (
              <div className="issue-type-list">
                {filterList(priorities).map((p) => (
                  <ValueRow key={p.id} item={p} duplicate={priorityDupes.get(p.name)} />
                ))}
              </div>
            )}
          </Panel>
        )}
      </SubNavLayout>
    </div>
  );
}
