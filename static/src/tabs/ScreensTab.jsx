import React from "react";
import { invoke } from "@forge/bridge";
import { formatNumber, formatRelativeTime } from "../utils";
import { Icon } from "../components/Icons";
import { StatTile, StatRow, Panel, EmptyState, Chip, PageHeader, SortFilterBar, PanelGrid, GridSpan, PillarHealthPanel, BarList } from "../components/ui";
import { SubNavLayout } from "../components/admin/primitives";
import { useVisiblePolling } from "../hooks";

// Screen and scheme inventory.
//
// The backend for this shipped before any UI existed, which is the same trap the workflow
// pillar fell into: scopes sitting on the install consent screen for a feature nobody could
// see. Eight of them this time. This is that feature.
//
// Read-only like the rest of Observatory. It reports what a form contains and which schemes
// route to it; changing a screen stays a considered action in Jira's own admin UI, with
// this as the evidence.

const PAGE_SIZE = 25;
const BUILD_POLL_MS = 3000;

// Matches the macro's snapshot warning and the Quick Scan panel's full-scan age. Third
// application of the same threshold rather than a new number, because a reader who has
// learned what "stale" means on one surface should not have to relearn it here.
const STALE_AFTER_DAYS = 7;

function daysSince(iso) {
  const at = Date.parse(iso || "");
  if (!Number.isFinite(at)) return null;
  return (Date.now() - at) / (24 * 60 * 60 * 1000);
}

// Operations in the order Jira documents them, which is also the order they matter in:
// default is the fallback everything else inherits from.
const OPERATIONS = ["default", "create", "edit", "view"];

// Sort tokens, matching the whitelist in store/screen.js exactly. Labels say what the
// ordering is FOR where the raw column name would not: "Most fields first" is the reason
// this is the default, and "field_count DESC" is not something to make a reader translate.
const DEFAULT_SCREEN_SORT = "fields-desc";
const SCREEN_SORT_OPTIONS = [
  { value: "fields-desc", label: "Most fields first" },
  { value: "fields-asc", label: "Fewest fields first" },
  { value: "name-asc", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" },
  { value: "tabs-desc", label: "Most tabs first" },
  { value: "id-asc", label: "Screen id" },
  { value: "unresolved-first", label: "Unreadable first" },
];

export function ScreenRow({ screen, transitions = [] }) {
  const unresolved = screen.tabsResolved !== "resolved";

  return (
    <div className="screen-row">
      <div className="screen-row__identity">
        <span className="screen-row__name">{screen.name}</span>
        {screen.description && <span className="screen-row__desc">{screen.description}</span>}
        {/* Named individually rather than counted. "Used by 3 transitions" does not tell
            you whether deleting the screen breaks a workflow you care about; the workflow
            and transition names do. */}
        {transitions.length > 0 && (
          <span className="screen-row__transitions">
            Opened by {transitions.map((t) => `${t.workflowName} · ${t.transitionName}`).join(", ")}
          </span>
        )}
      </div>
      <div className="screen-row__meta">
        {/* A screen we could not read reports no counts at all rather than zeroes. Zero
            fields and unknown fields are opposite claims, and the second is the one that
            must never look like the first. */}
        {transitions.length > 0 && (
          <Chip tone="neutral" title="A workflow transition opens this screen, whether or not a scheme references it">
            {formatNumber(transitions.length)} {transitions.length === 1 ? "transition" : "transitions"}
          </Chip>
        )}
        {unresolved ? (
          <Chip tone="warning" title={screen.unresolvedReason || "Contents could not be read"}>
            Contents unknown
          </Chip>
        ) : (
          <>
            <Chip tone="neutral">
              {formatNumber(screen.fieldCount)} {screen.fieldCount === 1 ? "field" : "fields"}
            </Chip>
            {screen.tabCount > 1 && (
              <Chip tone="neutral" title="Fields past the first tab are easy to miss on a form">
                {formatNumber(screen.tabCount)} tabs
              </Chip>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function SchemeOperations({ scheme, operations }) {
  const byOperation = new Map(operations.map((op) => [op.operation, op]));
  const fallback = byOperation.get("default");

  // A scheme where every operation resolves to the same screen is the common case and is
  // said once rather than four times -- repeating it would bury the schemes that differ,
  // which are the ones worth looking at.
  const distinct = new Set(
    OPERATIONS.map((name) => byOperation.get(name)?.screenId).filter((id) => id != null)
  );
  const uniform = distinct.size === 1 && fallback?.screenId != null;

  return (
    <div className="screen-scheme">
      <div className="screen-scheme__identity">
        <span className="screen-scheme__name">{scheme.name}</span>
        {scheme.description && <span className="screen-scheme__desc">{scheme.description}</span>}
      </div>

      {uniform ? (
        <p className="screen-scheme__uniform">
          One screen for every operation.
          {fallback?.dangling && (
            <Chip tone="danger" title="This scheme points at a screen that is not in the catalog">
              Missing screen
            </Chip>
          )}
        </p>
      ) : (
        <div className="screen-scheme__ops">
          {OPERATIONS.map((name) => {
            const op = byOperation.get(name);
            if (!op) return null;
            return (
              <div key={name} className="screen-scheme__op">
                <span className="screen-scheme__op-name">{name}</span>
                {op.screenId == null ? (
                  <Chip tone="warning">Not mapped</Chip>
                ) : (
                  <>
                    <span className="screen-scheme__op-screen">{op.screenId}</span>
                    {/* Inherited is not the same as chosen. Only an explicitly mapped
                        operation was a decision somebody made. */}
                    {op.inherited && (
                      <Chip tone="neutral" title="Falls through to the default screen; not set explicitly">
                        inherited
                      </Chip>
                    )}
                    {op.dangling && (
                      <Chip tone="danger" title="Points at a screen that is not in the catalog">
                        missing
                      </Chip>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ScreensTab() {
  const [view, setView] = React.useState("screens");
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [building, setBuilding] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState(DEFAULT_SCREEN_SORT);
  const [debouncedSearch, setDebouncedSearch] = React.useState("");

  React.useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [search]);

  const load = React.useCallback(async () => {
    try {
      const result = await invoke("getScreenInventory", { page, pageSize: PAGE_SIZE, search: debouncedSearch, sort });
      setData(result);
      setError("");
    } catch (err) {
      // A transient poll failure keeps the last good state rather than blanking the page:
      // the next tick retries, and a flicker to "no data" reads as data loss.
      setError(err?.message || "Could not load the screen inventory.");
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, sort]);

  React.useEffect(() => { load(); }, [load]);

  // The screens pillar of the site health score. Already computed the moment anything scores
  // the site, and previously only ever rendered on the Overview tab -- the governance number
  // and the inventory it grades belong on the same page.
  const [pillar, setPillar] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    invoke("getPillarHealth", { pillar: "screens" })
      .then((result) => { if (!cancelled) setPillar(result?.pillar || null); })
      .catch(() => { if (!cancelled) setPillar(null); });
    return () => { cancelled = true; };
  }, [data?.refreshedAt]);

  // Transitions grouped by the screen they open. Done here rather than server-side so an
  // expanded screen row costs nothing extra -- the whole list is already on the page.
  const transitionsByScreen = React.useMemo(() => {
    const map = new Map();
    for (const row of data?.transitionScreens || []) {
      if (!map.has(row.screenId)) map.set(row.screenId, []);
      map.get(row.screenId).push(row);
    }
    return map;
  }, [data?.transitionScreens]);

  // "queued" counts as in flight, not just "building". The row is marked building at queue
  // time, but a consumer that has not picked the job up yet can leave either value on the
  // meta -- and treating only one of them as running is how a live build reads as idle.
  const isBuilding = ["building", "queued"].includes(data?.state) && !data?.staleBuild;
  useVisiblePolling(isBuilding, load, BUILD_POLL_MS);

  async function startBuild() {
    setBuilding(true);
    setError("");
    setNotice("");
    try {
      const result = await invoke("buildScreenInventory", {});
      // Reload first, then report a refusal. load() clears the error banner on success, so
      // setting it before the reload would wipe the very message that explains why nothing
      // happened -- leaving a button that silently does nothing.
      await load();
      if (result?.error) {
        setError(result.error);
      } else if (result?.queued === false && result?.reason === "already-building") {
        // Not an error, but it must not be silence either: pressing a button and getting no
        // response at all is indistinguishable from a broken button.
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

  const buildAgeDays = daysSince(data?.refreshedAt);
  const isStale = buildAgeDays != null && buildAgeDays > STALE_AFTER_DAYS;

  const buildAction = (
    <button type="button" className="secondary-button" onClick={startBuild} disabled={building || isBuilding}>
      <Icon name="refreshCw" size={13} />
      {isBuilding ? "Building…" : data?.neverBuilt ? "Build inventory" : "Rebuild"}
    </button>
  );

  if (loading && !data) {
    return <div className="empty-state">Loading screen inventory…</div>;
  }

  // Nothing has COMPLETED yet -- which is not the same as nothing happening. The first
  // build can run for minutes before it produces a version, and rendering the same "no
  // inventory yet" state throughout makes a working button look broken: you press it,
  // nothing on the page changes, and there is no way to tell the job was accepted.
  if (data?.neverBuilt) {
    return (
      <div className="admin-screens">
        <PageHeader
          title="Screens"
          description="Which fields each form actually contains, and which schemes route projects to it."
          actions={buildAction}
        />
        {error && <div className="danger-zone__error" role="alert">{error}</div>}
        {notice && !error && <p className="admin-config-row__hint" role="status">{notice}</p>}

        {data?.lastError && !isBuilding && (
          <div className="danger-zone__error" role="alert">Last build failed: {data.lastError}</div>
        )}

        {data?.staleBuild && (
          <p className="admin-config-row__hint">
            A build was started but is no longer running. Rebuild to recover it.
          </p>
        )}

        {isBuilding ? (
          <Panel title="Building the first inventory" icon="refreshCw">
            <p>
              Walking every screen, its tabs and its fields, plus both scheme layers above
              them. On a site of ~760 screens that is roughly five minutes. This page
              refreshes itself — you can leave it.
            </p>
            {data?.startedAt && (
              <p className="admin-config-row__hint">Started {formatRelativeTime(data.startedAt)}.</p>
            )}
          </Panel>
        ) : (
          <EmptyState action={buildAction}>
            No screen inventory has been built yet. Building one walks every screen, its tabs
            and its fields, plus both scheme layers above them — on a site of ~760 screens that
            is a few minutes of background work.
          </EmptyState>
        )}
      </div>
    );
  }

  const items = [
    { key: "overview", label: "Overview", icon: "barChart" },
    { key: "screens", label: "Screens", icon: "copy", badge: formatNumber(data?.totalScreens ?? 0) },
    { key: "schemes", label: "Screen schemes", icon: "layers", badge: formatNumber(data?.screenSchemes?.length ?? 0) },
    { key: "transitions", label: "Transitions", icon: "activity", badge: formatNumber(data?.transitionScreens?.length ?? 0) },
    { key: "assignments", label: "Assignments", icon: "folder", badge: formatNumber(data?.issueTypeScreenSchemes?.length ?? 0) },
  ];

  const g = data?.governance || null;
  const totalPages = Math.max(1, Math.ceil((data?.screens?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="admin-screens">
      <PageHeader
        title="Screens"
        description="Which fields each form actually contains, and which schemes route projects to it. Read-only — changes stay in Jira's admin UI."
        // Freshness moved off the stat row and into the header, where every other tab now
        // carries it. It was spending a full tile competing with the counts it qualifies.
        meta={data?.refreshedAt ? `Built ${formatRelativeTime(data.refreshedAt)}` : "Never built"}
        actions={buildAction}
      />

      {error && <div className="danger-zone__error" role="alert">{error}</div>}
      {notice && !error && <p className="admin-config-row__hint" role="status">{notice}</p>}

      {isBuilding && (
        <p className="admin-config-row__hint">Building the inventory… this page refreshes itself.</p>
      )}

      {data?.staleBuild && (
        <p className="admin-config-row__hint">
          A build was started but is no longer running. Rebuild to recover it.
        </p>
      )}

      {data?.lastError && !isBuilding && (
        <div className="danger-zone__error" role="alert">Last build failed: {data.lastError}</div>
      )}

      <StatRow>
        <StatTile
          label="Screens"
          value={formatNumber(data?.totalScreens ?? 0)}
          hint="Forms defined on this site"
          icon="copy"
        />
        <StatTile
          label="Screen schemes"
          value={formatNumber(data?.screenSchemes?.length ?? 0)}
          hint="Map operations to screens"
          icon="layers"
        />
        <StatTile
          label="Assignments"
          value={formatNumber(data?.issueTypeScreenSchemes?.length ?? 0)}
          hint="Issue type screen schemes, which projects use"
          icon="folder"
        />
        {/* Given its own tile rather than a footnote. It caps every finding built on this
            snapshot, so a reader needs it before they trust any other number here. */}
        <StatTile
          label="Contents unknown"
          value={formatNumber(data?.unresolvedScreens ?? 0)}
          hint={
            (data?.unresolvedScreens ?? 0) > 0
              ? "Screens whose fields could not be read. Not counted as empty."
              : "Every screen's contents were read"
          }
          tone={(data?.unresolvedScreens ?? 0) > 0 ? "warning" : "success"}
          icon="alertTriangle"
        />
      </StatRow>

      {isStale && (
        <Panel title="This inventory is stale" icon="alertTriangle">
          <p>
            It was built {Math.floor(buildAgeDays)} days ago, and nothing refreshes it
            automatically. <strong>The Universe Scan does not update screens</strong> — that scan
            walks issues, while screens are configuration read from a different set of
            endpoints. A screen added or re-arranged since the last build is not reflected
            above.
          </p>
        </Panel>
      )}

      <SubNavLayout items={items} activeKey={view} onSelect={setView}>
        {view === "overview" && (
          <PanelGrid>
            <GridSpan>
              <PillarHealthPanel pillar={pillar} />
            </GridSpan>

            <GridSpan>
              <Panel title="Form size" icon="barChart" description="How big the site's forms actually are. A 60-field form is one nobody fills in completely.">
                <BarList items={data?.distributions?.sizeBuckets} labelKey="bucket" valueKey="screens" formatValue={formatNumber} emptyMessage="No screens measured yet" />
              </Panel>
            </GridSpan>

            <GridSpan>
              <Panel title="Largest screens" icon="copy" description="The longest forms first — the ones people meet most of.">
                <BarList items={data?.distributions?.largestScreens} labelKey="name" valueKey="fieldCount" formatValue={formatNumber} tone="warn" emptyMessage="No screens measured yet" />
              </Panel>
            </GridSpan>

            <GridSpan>
              <Panel title="Most reused fields" icon="layers" description="Where a field change is felt. A field on 200 forms is not a local edit.">
                <BarList items={data?.distributions?.mostSharedFields} labelKey="name" valueKey="screens" formatValue={formatNumber} emptyMessage="No field data yet" />
              </Panel>
            </GridSpan>

            <GridSpan>
              <Panel title="Scheme operations" icon="activity" description="Which operations schemes actually map. Most estates set default and inherit the rest.">
                <BarList items={data?.distributions?.operationMix} labelKey="operation" valueKey="mappings" formatValue={formatNumber} emptyMessage="No schemes yet" />
              </Panel>
            </GridSpan>

            <GridSpan>
              <Panel title="Coverage" icon="info" description="What this snapshot could and could not measure.">
                <StatRow>
                  <StatTile
                    label="Contents unknown"
                    value={formatNumber(data?.unresolvedScreens ?? 0)}
                    hint={(data?.unresolvedScreens ?? 0) > 0 ? "Excluded from every figure above" : "Every screen was read"}
                    tone={(data?.unresolvedScreens ?? 0) > 0 ? "warning" : "success"}
                  />
                  <StatTile
                    label="Transition-only"
                    value={g?.transitionOnlyScreens == null ? "—" : formatNumber(g.transitionOnlyScreens)}
                    hint="No scheme, but a transition opens them"
                  />
                  <StatTile
                    label="Orphan schemes"
                    value={formatNumber(g?.unusedSchemes ?? 0)}
                    hint="No issue type maps to them"
                    tone={(g?.unusedSchemes ?? 0) > 0 ? "warning" : "neutral"}
                  />
                </StatRow>
              </Panel>
            </GridSpan>
          </PanelGrid>
        )}

        {view === "screens" && (
          <Panel
            title="Screens"
            icon="copy"
            description="Every form defined on this site. Sorting and search run across the whole catalog, not just the page you are looking at."
          >
            {/* Sort is sent to the resolver, not applied here. The page holds 25 of ~760
                screens, so sorting in the browser would reorder an arbitrary slice and
                present it as the top of the catalog. */}
            <SortFilterBar
              search={search}
              onSearchChange={setSearch}
              searchLabel="Search screens"
              searchPlaceholder="Search screens by name or id…"
              sort={sort}
              onSortChange={(value) => { setSort(value); setPage(1); }}
              sortOptions={SCREEN_SORT_OPTIONS}
              resultCount={data?.screens?.total ?? 0}
              totalCount={data?.totalScreens ?? 0}
              onClear={() => { setSearch(""); setSort(DEFAULT_SCREEN_SORT); setPage(1); }}
            />

            {!data?.screens?.rows?.length ? (
              <EmptyState inline>
                {debouncedSearch ? "No screens match that search." : "No screens in this snapshot."}
              </EmptyState>
            ) : (
              <div className="screen-list">
                {data.screens.rows.map((screen) => (
                  <ScreenRow
                    key={screen.screenId}
                    screen={screen}
                    transitions={transitionsByScreen.get(screen.screenId) || []}
                  />
                ))}
              </div>
            )}

            {totalPages > 1 && (
              <div className="pagination-bar">
                <button type="button" className="secondary-button secondary-button--small"
                  onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
                  Previous
                </button>
                <span>Page {page} of {totalPages}</span>
                <button type="button" className="secondary-button secondary-button--small"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
                  Next
                </button>
              </div>
            )}
          </Panel>
        )}

        {view === "schemes" && (
          <Panel
            title="Screen schemes"
            icon="layers"
            description="Which screen serves create, edit and view. An operation with no explicit mapping inherits the default — shown, because only an explicit mapping was a decision."
          >
            {!data?.screenSchemes?.length ? (
              <EmptyState inline>No screen schemes in this snapshot.</EmptyState>
            ) : (
              <div className="screen-scheme-list">
                {data.screenSchemes.map((scheme) => (
                  <SchemeOperations
                    key={scheme.schemeId}
                    scheme={scheme}
                    operations={(data.schemeOperations || []).filter((op) => op.schemeId === scheme.schemeId)}
                  />
                ))}
              </div>
            )}
          </Panel>
        )}

        {view === "transitions" && (
          <Panel
            title="Screens opened by a workflow transition"
            icon="activity"
            description="The second way a screen reaches a user. A screen here is in use even if no screen scheme references it — which is why the scheme view alone cannot tell you what is safe to delete."
          >
            {!data?.transitionsAvailable ? (
              // Three states, not two. The reason distinguishes "no workflow inventory at
              // all" from "an inventory that predates transition capture" -- both are
              // unknown, but only the second is fixed by rebuilding.
              <EmptyState inline>
                {data?.transitionsReason
                  || "No workflow inventory has been built, so transition screens are unknown. Build it from the Workflows tab to see which screens transitions open."}
              </EmptyState>
            ) : !data?.transitionScreens?.length ? (
              <EmptyState inline>
                No workflow transition on this site opens a screen. Every screen reaches users
                through the scheme chain alone.
              </EmptyState>
            ) : (
              <div className="screen-transition-list">
                {[...transitionsByScreen.entries()].map(([screenId, rows]) => (
                  <div className="screen-transition" key={screenId}>
                    <div className="screen-transition__screen">
                      <span className="screen-transition__id">{screenId}</span>
                      <Chip tone="neutral">
                        {formatNumber(rows.length)} {rows.length === 1 ? "transition" : "transitions"}
                      </Chip>
                    </div>
                    <ul className="screen-transition__rows">
                      {rows.map((row) => (
                        <li key={`${row.workflowName}:${row.transitionId}`}>
                          <span className="screen-transition__workflow">{row.workflowName}</span>
                          <span className="screen-transition__name">{row.transitionName}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        )}

        {view === "assignments" && (
          <Panel
            title="Issue type screen schemes"
            icon="folder"
            description="The layer projects actually attach to. One of these governs which screen scheme applies per issue type."
          >
            {!data?.issueTypeScreenSchemes?.length ? (
              <EmptyState inline>No issue type screen schemes in this snapshot.</EmptyState>
            ) : (
              <div className="screen-list">
                {data.issueTypeScreenSchemes.map((itss) => (
                  <div className="screen-row" key={itss.itssId}>
                    <div className="screen-row__identity">
                      <span className="screen-row__name">{itss.name}</span>
                      {itss.description && <span className="screen-row__desc">{itss.description}</span>}
                    </div>
                    <div className="screen-row__meta">
                      {/* Zero projects is a finding in its own right: a scheme nothing uses
                          is configuration that can be retired. */}
                      <Chip tone={itss.projectCount === 0 ? "warning" : "neutral"}>
                        {formatNumber(itss.projectCount)} {itss.projectCount === 1 ? "project" : "projects"}
                      </Chip>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        )}
      </SubNavLayout>
    </div>
  );
}
