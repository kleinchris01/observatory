import React from "react";
import { invoke } from "@forge/bridge";
import { formatNumber, formatRelativeTime, buildPriorityAdminUrl, buildResolutionAdminUrl } from "../utils";
import {
  StatTile, StatRow, Panel, EmptyState, Chip, PageHeader, PillarHealthPanel, FindingRow, SortFilterBar,
  AskRovo, JiraLink, RebuildButton, BuildBanners, AttentionPanel, PillarOverview,
} from "../components/ui";
import { buildRovoPrompt } from "../utils";
import { SubNavLayout } from "../components/admin/primitives";
import { useNavIntent, usePersistentState, useSnapshotBuild, usePillarHealth } from "../hooks";

// The two global value lists in Jira's "Issues" admin section that don't have their own
// pillar yet: resolutions and priorities. Statuses and issue types are covered elsewhere.
//
// The one finding that matters is the same one the workflow and issue-type pillars run:
// near-duplicate names. A site with "Done", "Fixed", "Complete" and "Resolved" as separate
// resolutions cannot produce a correct resolution-based report. Read-only.

function ValueRow({ item, duplicate }) {
  return (
    <div className="issue-type-row">
      <div className="issue-type-row__identity">
        <span className="issue-type-row__name">{item.name}</span>
        {item.description && <span className="issue-type-row__desc">{item.description}</span>}
      </div>
      <div className="issue-type-row__meta">
        {/* Usage, which is what turns a near-duplicate pair from an observation into a merge
            decision -- you keep the one people use. Null is "no completed crawl has counted",
            never a zero: zero is what makes a value look safe to retire. */}
        {item.issueCount === null || item.issueCount === undefined ? (
          <Chip tone="neutral" title="No completed issue crawl has counted this yet. Run a full scan from the Scans tab.">
            Not measured
          </Chip>
        ) : item.issueCount === 0 ? (
          <Chip tone="warning" title="A completed crawl found no issue carrying this value.">
            No issues
          </Chip>
        ) : (
          <Chip tone="neutral">{formatNumber(item.issueCount)} {item.issueCount === 1 ? "issue" : "issues"}</Chip>
        )}
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
    <AttentionPanel
      description="What the priorities & resolutions pillar of the site health score is built from."
      empty="Nothing flagged. No name collisions, and both lists have a default."
    >
      {rows.map((r) => <FindingRow key={r.title} tone={r.tone} title={r.title} detail={r.detail} count={r.count} />)}
    </AttentionPanel>
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

export function PrioritiesTab({ intent, siteOrigin }) {
  const [view, setView] = usePersistentState("observatory.section.priorities", "overview");
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
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

  const pillar = usePillarHealth("estate", data?.refreshedAt);
  const build = useSnapshotBuild({ resolver: "buildEstateInventory", data, load });

  const buildAction = (
    <>
      <AskRovo
        agent="observatory-estate-expert"
        scope="the priority and resolution lists"
        context="the snapshot age and the list sizes and near-duplicate counts"
        disabled={Boolean(data?.neverBuilt)}
        buildPrompt={() =>
          buildRovoPrompt({
            task: "Give me an overview of the priority and resolution lists on this site and what to look at first.",
            facts: [["Snapshot built", data?.refreshedAt || "unknown"], ["Resolutions", data?.resolutions?.length ?? null], ["Priorities", data?.priorities?.length ?? null], ["Resolution list has a default", (data?.resolutions || []).some((r) => r.isDefault) ? "yes" : "no"], ["Priority list has a default", (data?.priorities || []).some((p) => p.isDefault) ? "yes" : "no"]],
          })
        }
      />
      <RebuildButton onClick={build.startBuild} isBuilding={build.isBuilding} starting={build.starting} neverBuilt={Boolean(data?.neverBuilt)} />
    </>
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
    <BuildBanners
      loadError={error} buildError={build.error} notice={build.notice}
      isBuilding={build.isBuilding} buildingMessage="Reading the lists… this page refreshes itself."
      staleBuild={data?.staleBuild} lastError={data?.lastError} builtAt={data?.neverBuilt ? null : data?.refreshedAt}
    />
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

      <SubNavLayout items={items} activeKey={view} onSelect={setView}>
        {view === "overview" && (
          <PillarOverview
            governance={<PillarHealthPanel pillar={pillar} />}
            attention={<EstateFindings governance={g} />}
          />
        )}

        {view === "resolutions" && (
          <Panel title="Resolutions" icon="checkCircle" description="The global resolution list. Jira offers no scheme layer to scope it — every project sees all of these." action={<JiraLink className="ui-linkbutton" href={buildResolutionAdminUrl(siteOrigin)} title="Manage resolutions in Jira">Manage in Jira</JiraLink>}>
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
          <Panel title="Priorities" icon="flag" description="The global priority list, in the order it appears on the priority picker." action={<JiraLink className="ui-linkbutton" href={buildPriorityAdminUrl(siteOrigin)} title="Manage priorities in Jira">Manage in Jira</JiraLink>}>
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
