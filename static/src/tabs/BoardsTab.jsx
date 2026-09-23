import React from "react";
import { invoke } from "@forge/bridge";
import { formatNumber, formatRelativeTime, buildBoardUrl, buildProjectUrl } from "../utils";
import { Icon } from "../components/Icons";
import {
  StatTile, StatRow, Panel, EmptyState, Chip, PageHeader, SortFilterBar, FindingRow, JiraLink,
} from "../components/ui";
import { SubNavLayout } from "../components/admin/primitives";
import { useNavIntent, useVisiblePolling } from "../hooks";

// Agile boards: every board on the site, where it lives, the saved filter behind it and its
// column-to-status mapping. Structure only for now -- the cross-pillar findings (a board on a
// deleted filter, statuses mapped to no column, a personal board owned by someone inactive)
// and the governance score arrive with later passes. Read-only.

const BUILD_POLL_MS = 3000;

const TYPE_TONE = { scrum: "active", kanban: "success", simple: "neutral" };

function BoardRow({ board, siteOrigin }) {
  const loc = board.locationType === "user"
    ? `personal · ${board.locationName || board.locationId || "unknown owner"}`
    : board.locationKey
      ? `${board.locationKey}${board.locationName ? ` · ${board.locationName}` : ""}`
      : "no project";

  // A board only has a deep link when it sits under a project: the board URL is a path
  // beneath the project key. Personal boards have no project, so they stay plain text --
  // JiraLink renders a span when the href is null.
  const boardHref = buildBoardUrl(siteOrigin, board.locationKey, board.boardId);
  const projectHref = board.locationType === "user" ? null : buildProjectUrl(siteOrigin, board.locationKey);

  return (
    <div className="issue-type-row">
      <div className="issue-type-row__identity">
        <JiraLink className="issue-type-row__name" href={boardHref} title={`Open ${board.name} in Jira`}>
          {board.name}
        </JiraLink>
        {projectHref ? (
          <span className="issue-type-row__desc">
            <JiraLink href={projectHref} title={`Open ${board.locationKey} in Jira`}>{board.locationKey}</JiraLink>
            {board.locationName ? ` · ${board.locationName}` : ""}
          </span>
        ) : (
          <span className="issue-type-row__desc">{loc}</span>
        )}
      </div>
      <div className="issue-type-row__meta">
        {board.type && <Chip tone={TYPE_TONE[board.type] || "neutral"}>{board.type}</Chip>}
        {!board.configReadable && (
          <Chip tone="warning" title="This board's configuration endpoint returned 404 — team-managed boards often do. Its columns and backing filter are unknown.">config unreadable</Chip>
        )}
        {board.configReadable && !board.filterId && (
          <Chip tone="warning" title="Config was readable but named no backing filter.">no backing filter</Chip>
        )}
        {board.filterId && <Chip tone="neutral" title={`Backing saved filter ${board.filterId}`}>filter {board.filterId}</Chip>}
        {board.configReadable && (
          <Chip tone={board.unmappedColumns > 0 ? "warning" : "neutral"}>
            {formatNumber(board.columnCount)} {board.columnCount === 1 ? "column" : "columns"}
            {board.unmappedColumns > 0 ? ` · ${board.unmappedColumns} unmapped` : ""}
          </Chip>
        )}
      </div>
    </div>
  );
}

export function BoardsTab({ intent, siteOrigin }) {
  const [view, setView] = React.useState("overview");
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [building, setBuilding] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState("all");

  useNavIntent(intent, (nav) => {
    if (nav.view) setView(nav.view);
    if (nav.type) setTypeFilter(nav.type);
    setSearch("");
  });

  const load = React.useCallback(async () => {
    try {
      const result = await invoke("getBoardInventory", {});
      setData(result);
      setError("");
    } catch (err) {
      setError(err?.message || "Could not load the board inventory.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const isBuilding = ["building", "queued"].includes(data?.state) && !data?.staleBuild;
  useVisiblePolling(isBuilding, load, BUILD_POLL_MS);

  async function startBuild() {
    setBuilding(true);
    setError("");
    setNotice("");
    try {
      const result = await invoke("buildBoardInventory", {});
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
    return <div className="empty-state">Loading the board inventory…</div>;
  }

  const header = (
    <PageHeader
      title="Boards"
      description="Every agile board, where it lives, the saved filter behind it and its column mapping. Read-only — changes stay in Jira."
      meta={data?.refreshedAt ? `Built ${formatRelativeTime(data.refreshedAt)}` : "Never built"}
      actions={buildAction}
    />
  );

  const banners = (
    <>
      {error && <div className="danger-zone__error" role="alert">{error}</div>}
      {notice && !error && <p className="admin-config-row__hint" role="status">{notice}</p>}
      {isBuilding && <p className="admin-config-row__hint">Walking every board's configuration… this page refreshes itself.</p>}
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
          No board inventory has been built yet. It is also produced by every full and quick
          scan — or build it on its own here.
        </EmptyState>
      </div>
    );
  }

  const summary = data?.summary || { total: 0, byType: {}, personal: 0, unreadable: 0, missingFilter: 0, totalColumns: 0 };
  const boards = data?.boards || [];
  const term = search.trim().toLowerCase();
  const filtered = boards.filter((b) => {
    if (typeFilter !== "all" && (b.type || "unknown") !== typeFilter) return false;
    if (!term) return true;
    return String(b.name).toLowerCase().includes(term)
      || String(b.locationKey || "").toLowerCase().includes(term)
      || String(b.locationName || "").toLowerCase().includes(term);
  });

  const typeOptions = [
    { value: "all", label: "All types" },
    ...Object.keys(summary.byType).sort().map((t) => ({ value: t, label: t })),
  ];

  const items = [
    { key: "overview", label: "Overview", icon: "barChart" },
    { key: "boards", label: "Boards", icon: "activity", badge: formatNumber(boards.length) },
  ];

  return (
    <div className="admin-issue-types">
      {header}
      {banners}

      <StatRow>
        <StatTile label="Boards" value={formatNumber(summary.total)} hint="On this site" icon="activity" />
        <StatTile
          label="Personal boards"
          value={formatNumber(summary.personal)}
          hint={summary.personal > 0 ? "Owned by a person, not a project" : "None"}
          tone={summary.personal > 0 ? "warning" : "neutral"}
          icon="user"
        />
        <StatTile
          label="No backing filter"
          value={formatNumber(summary.missingFilter)}
          hint={summary.missingFilter > 0 ? "Config named no saved filter" : "All have one"}
          tone={summary.missingFilter > 0 ? "warning" : "success"}
          icon="search"
        />
        <StatTile
          label="Config unreadable"
          value={formatNumber(summary.unreadable)}
          hint={summary.unreadable > 0 ? "Endpoint 404'd — columns unknown" : "All readable"}
          tone={summary.unreadable > 0 ? "warning" : "success"}
          icon="alertTriangle"
        />
      </StatRow>

      <SubNavLayout items={items} activeKey={view} onSelect={setView}>
        {view === "overview" && (
          <Panel title="What needs attention" icon="alertTriangle" description="Boards break silently — a deleted backing filter shows every issue in the site, an unmapped column drops issues off the wall.">
            {(() => {
              const g = data?.insights || {};
              const rows = [];
              if (g.missingFilter > 0) rows.push({ tone: "critical", count: g.missingFilter, title: "Backing filter deleted", detail: "The board's saved filter no longer exists, so it falls back to every issue in the site." });
              if (g.noFilter > 0) rows.push({ tone: "warning", count: g.noFilter, title: "No backing filter", detail: "Config was readable but named no saved filter." });
              if (g.inactiveFilterOwner > 0) rows.push({ tone: "warning", count: g.inactiveFilterOwner, title: "Backing filter owned by an inactive user", detail: "One departure from breaking — Jira deletes a filter with its owner." });
              if (g.staleColumnBoards > 0) rows.push({ tone: "warning", count: g.staleColumnBoards, title: "Column maps a status that no longer exists", detail: "Issues in that status vanish from the board with no error anywhere." });
              if (g.unmappedColumnBoards > 0) rows.push({ tone: "info", count: g.unmappedColumnBoards, title: "Column with no status mapped", detail: "A column issues can never land in." });
              if (g.joinedFilters === false) rows.push({ tone: "info", title: "Backing-filter checks did not run", detail: "Build the Saved Filters inventory to check for deleted filters and inactive owners." });
              if (g.joinedStatuses === false) rows.push({ tone: "info", title: "Column-status checks did not run", detail: "Build the Workflow inventory to check for columns mapping deleted statuses." });
              return rows.length === 0
                ? <EmptyState inline>Nothing flagged. Every board has a live backing filter and every column maps a status.</EmptyState>
                : rows.map((r) => <FindingRow key={r.title} tone={r.tone} title={r.title} detail={r.detail} count={r.count} />);
            })()}
          </Panel>
        )}

        {view === "overview" && (
          <Panel title="By type" icon="barChart" description="Scrum, kanban and team-managed (simple) boards on this site.">
            {summary.total === 0 ? (
              <EmptyState inline>No boards in this snapshot.</EmptyState>
            ) : (
              <StatRow>
                {Object.entries(summary.byType).sort().map(([type, count]) => (
                  <StatTile key={type} label={type} value={formatNumber(count)} tone={TYPE_TONE[type] || "neutral"} />
                ))}
                <StatTile label="Columns total" value={formatNumber(summary.totalColumns)} hint="Across every readable board" />
              </StatRow>
            )}
          </Panel>
        )}

        {view === "boards" && (
          <Panel title="Boards" icon="activity" description="Search matches the name, project key and project name.">
            <SortFilterBar
              search={search}
              onSearchChange={setSearch}
              searchLabel="Search boards"
              searchPlaceholder="Board name or project…"
              filters={[{ key: "type", label: "Type", value: typeFilter, onChange: setTypeFilter, options: typeOptions, allValue: "all" }]}
              resultCount={filtered.length}
              totalCount={boards.length}
              onClear={() => { setSearch(""); setTypeFilter("all"); }}
            />
            {filtered.length === 0 ? (
              <EmptyState inline>{term || typeFilter !== "all" ? "No board matches these filters." : "No boards in this snapshot."}</EmptyState>
            ) : (
              <div className="issue-type-list">
                {filtered.map((board) => <BoardRow key={board.boardId} board={board} siteOrigin={siteOrigin} />)}
              </div>
            )}
          </Panel>
        )}
      </SubNavLayout>
    </div>
  );
}
