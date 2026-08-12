import React from "react";
import { invoke } from "@forge/bridge";
import { formatNumber, formatRelativeTime, formatTimestamp } from "../utils";
import { Icon } from "../components/Icons";
import { StatTile, StatRow, Panel, EmptyState, Chip, PageHeader } from "../components/ui";
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

export function ScreenRow({ screen }) {
  const unresolved = screen.tabsResolved !== "resolved";

  return (
    <div className="screen-row">
      <div className="screen-row__identity">
        <span className="screen-row__name">{screen.name}</span>
        {screen.description && <span className="screen-row__desc">{screen.description}</span>}
      </div>
      <div className="screen-row__meta">
        {/* A screen we could not read reports no counts at all rather than zeroes. Zero
            fields and unknown fields are opposite claims, and the second is the one that
            must never look like the first. */}
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
  const [building, setBuilding] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState("");
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
      const result = await invoke("getScreenInventory", { page, pageSize: PAGE_SIZE, search: debouncedSearch });
      setData(result);
      setError("");
    } catch (err) {
      // A transient poll failure keeps the last good state rather than blanking the page:
      // the next tick retries, and a flicker to "no data" reads as data loss.
      setError(err?.message || "Could not load the screen inventory.");
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch]);

  React.useEffect(() => { load(); }, [load]);

  const isBuilding = data?.state === "building" && !data?.staleBuild;
  useVisiblePolling(isBuilding, load, BUILD_POLL_MS);

  async function startBuild() {
    setBuilding(true);
    setError("");
    try {
      const result = await invoke("buildScreenInventory", {});
      // Reload first, then report a refusal. load() clears the error banner on success, so
      // setting it before the reload would wipe the very message that explains why nothing
      // happened -- leaving a button that silently does nothing.
      await load();
      if (result?.error) setError(result.error);
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

  if (data?.neverBuilt) {
    return (
      <div className="admin-screens">
        <PageHeader
          title="Screens"
          description="Which fields each form actually contains, and which schemes route projects to it."
          actions={buildAction}
        />
        {error && <div className="danger-zone__error" role="alert">{error}</div>}
        <EmptyState action={buildAction}>
          No screen inventory has been built yet. Building one walks every screen, its tabs
          and its fields, plus both scheme layers above them — on a site of ~760 screens that
          is a few minutes of background work.
        </EmptyState>
      </div>
    );
  }

  const items = [
    { key: "screens", label: "Screens", icon: "copy", badge: formatNumber(data?.totalScreens ?? 0) },
    { key: "schemes", label: "Screen schemes", icon: "layers", badge: formatNumber(data?.screenSchemes?.length ?? 0) },
    { key: "assignments", label: "Assignments", icon: "folder", badge: formatNumber(data?.issueTypeScreenSchemes?.length ?? 0) },
  ];

  const totalPages = Math.max(1, Math.ceil((data?.screens?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="admin-screens">
      <PageHeader
        title="Screens"
        description="Which fields each form actually contains, and which schemes route projects to it. Read-only — changes stay in Jira's admin UI."
        actions={buildAction}
      />

      {error && <div className="danger-zone__error" role="alert">{error}</div>}

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
        <StatTile
          label="Built"
          value={data?.refreshedAt ? formatRelativeTime(data.refreshedAt) : "—"}
          hint={data?.refreshedAt ? formatTimestamp(data.refreshedAt) : "Never"}
          tone={isStale ? "warning" : "neutral"}
          icon="clock"
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
        {view === "screens" && (
          <Panel
            title="Screens"
            icon="copy"
            description="Sorted by field count — the longest forms first, because those are the ones people fill in."
          >
            <input
              type="search"
              className="rqt-search-input"
              placeholder="Search screens by name or id…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search screens"
            />

            {!data?.screens?.rows?.length ? (
              <EmptyState inline>
                {debouncedSearch ? "No screens match that search." : "No screens in this snapshot."}
              </EmptyState>
            ) : (
              <div className="screen-list">
                {data.screens.rows.map((screen) => (
                  <ScreenRow key={screen.screenId} screen={screen} />
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
