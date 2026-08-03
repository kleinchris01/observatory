import React from "react";
import { invoke } from "@forge/bridge";
import { formatTimestamp, formatRelativeTime, formatNumber } from "../utils";
import { Icon } from "../components/Icons";

// Workflow scheme + status inventory.
//
// The backend for this shipped weeks before any UI existed, which meant three permission
// scopes (read:workflow:jira, read:workflow-scheme:jira, read:status:jira) sat on the
// install consent screen for a feature nobody could see. This is that feature.
//
// Deliberately read-only, like the rest of Observatory: it reports what schemes exist and
// where they are used. Changing a workflow stays a considered action in Jira's own admin
// UI, with this as the evidence.

const PAGE_SIZE = 10;

// Poll interval while a queued build is in flight. The build is seconds-to-minutes on a
// large site, so this is frequent enough to feel live without hammering the resolver.
const BUILD_POLL_MS = 3000;

// Jira's three status categories. Mapped to the app's existing semantic tones rather than
// Jira's own palette so the page stays coherent with the field views next to it.
const CATEGORY_TONE = {
  "To Do": "todo",
  "In Progress": "progress",
  Done: "done",
};

function SchemeRow({ scheme, expanded, onToggle, projects, truncated }) {
  return (
    <div className={`wf-scheme ${expanded ? "wf-scheme--open" : ""}`}>
      <button
        type="button"
        className="wf-scheme__head"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <div className="wf-scheme__identity">
          <span className="wf-scheme__name">{scheme.name}</span>
          {scheme.description && <span className="wf-scheme__desc">{scheme.description}</span>}
        </div>
        <div className="wf-scheme__meta">
          {scheme.defaultWorkflow && (
            <span className="wf-chip wf-chip--muted" title="Default workflow for issue types with no explicit mapping">
              {scheme.defaultWorkflow}
            </span>
          )}
          <span className="wf-chip">
            {formatNumber(scheme.projectCount)} {scheme.projectCount === 1 ? "project" : "projects"}
          </span>
        </div>
        <span className="wf-scheme__caret" aria-hidden="true" />
      </button>

      {expanded && (
        <div className="wf-scheme__body">
          {!projects?.length ? (
            // Distinct from "no projects exist": the count above is already filtered to
            // what this viewer can browse, so an empty list here can also mean the
            // scheme's projects are ones they cannot see.
            <div className="empty-state empty-state--inline">
              No projects you can browse are using this scheme.
            </div>
          ) : (
            <>
              <div className="wf-scheme__section-label">Projects using this scheme</div>
              <div className="wf-project-grid">
                {projects.map((project) => (
                  <div key={project.projectId} className="wf-project">
                    <span className="wf-project__key">{project.projectKey}</span>
                    <span className="wf-project__name">{project.projectName}</span>
                  </div>
                ))}
              </div>
              {truncated && (
                <p className="wf-scheme__truncated">
                  Showing the first {projects.length}. Use the Projects tab to see a specific project&apos;s scheme.
                </p>
              )}
            </>
          )}

          {scheme.issueTypeMapping && Object.keys(scheme.issueTypeMapping).length > 0 && (
            <>
              <div className="wf-scheme__section-label">Issue type mapping</div>
              <div className="wf-mapping">
                {Object.entries(scheme.issueTypeMapping).map(([issueType, workflow]) => (
                  <div key={issueType} className="wf-mapping__row">
                    <span className="wf-mapping__type">{issueType}</span>
                    <span className="wf-mapping__arrow" aria-hidden="true">→</span>
                    <span className="wf-mapping__workflow">{workflow}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function WorkflowTab() {
  const [view, setView] = React.useState("schemes");
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [building, setBuilding] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [search, setSearch] = React.useState("");
  const [deferredSearch, setDeferredSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [openSchemeId, setOpenSchemeId] = React.useState(null);
  const [statusCategory, setStatusCategory] = React.useState("all");

  const load = React.useCallback(async ({ forceRefresh = false } = {}) => {
    if (forceRefresh) setBuilding(true); else setLoading(true);
    setError(null);
    try {
      const res = await invoke("getWorkflowInventory", {
        page, pageSize: PAGE_SIZE, search: deferredSearch, forceRefresh,
      });
      setData(res);
    } catch (err) {
      setError(err?.message || "Failed to load the workflow inventory.");
    } finally {
      setLoading(false);
      setBuilding(false);
    }
  }, [page, deferredSearch]);

  React.useEffect(() => { load(); }, [load]);

  // The build runs in the queue consumer, not in the resolver, so getWorkflowInventory
  // returns immediately with state "building" and no version yet. Poll until it settles --
  // without this the tab renders an empty inventory and stops, which looks identical to
  // the build having silently failed. Also covers arriving on the tab while a build
  // kicked off elsewhere is still running.
  React.useEffect(() => {
    if (data?.snapshotStatus?.state !== "building") return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await invoke("getWorkflowInventory", {
          page, pageSize: PAGE_SIZE, search: deferredSearch, forceRefresh: false,
        });
        if (!cancelled) setData(res);
      } catch {
        // Keep the last good state on a transient poll failure; the next tick retries.
      }
    }, BUILD_POLL_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [data, page, deferredSearch]);

  // Same debounce the field browser uses, so typing does not fire a resolver per keypress.
  React.useEffect(() => {
    const t = setTimeout(() => { setDeferredSearch(search); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [search]);

  const snapshot = data?.snapshotStatus;
  const schemes = data?.schemes || [];
  const statuses = data?.statuses || [];
  // Server state is the authority once the build is queued: the local `building` flag only
  // covers the request itself, which now returns in milliseconds. Treating a queued build
  // as "never built" would show the empty-state prompt while a build is actually running.
  const isBuilding = building || snapshot?.state === "building";
  const neverBuilt = !snapshot?.version && !loading && !isBuilding;

  const statusesByCategory = React.useMemo(() => {
    const groups = new Map();
    for (const status of statuses) {
      const key = status.statusCategory || "Uncategorised";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(status);
    }
    return groups;
  }, [statuses]);

  const visibleStatuses = React.useMemo(() => {
    if (statusCategory === "all") return statuses;
    return statuses.filter((s) => (s.statusCategory || "Uncategorised") === statusCategory);
  }, [statuses, statusCategory]);

  return (
    <div className="admin-workflow-tab">
      <div className="wf-header">
        <div className="wf-header__intro">
          <h2 className="wf-header__title">Workflow &amp; status inventory</h2>
          <p className="wf-header__desc">
            Which workflow schemes exist, which projects each governs, and the full status
            catalog. Read-only — Observatory reports what is configured; changes stay in
            Jira&apos;s own admin UI.
          </p>
        </div>
        <div className="wf-header__actions">
          {snapshot?.refreshedAt && (
            <span className="wf-header__age">
              Built {formatRelativeTime(snapshot.refreshedAt)} · {formatTimestamp(snapshot.refreshedAt)}
            </span>
          )}
          <button
            className="primary-button"
            type="button"
            onClick={() => load({ forceRefresh: true })}
            disabled={isBuilding || loading}
          >
            <Icon name="refreshCw" size={14} />
            {isBuilding ? "Building…" : snapshot?.version ? "Rebuild" : "Build inventory"}
          </button>
        </div>
      </div>

      {error && <div className="danger-zone__error" role="alert">{error}</div>}
      {snapshot?.lastError && (
        <div className="danger-zone__error">
          <Icon name="alertTriangle" size={13} /> {snapshot.lastError}
        </div>
      )}

      {neverBuilt ? (
        <div className="empty-state">
          No workflow inventory yet. Build one to see every workflow scheme on the site and
          the projects each governs.
        </div>
      ) : (
        <>
          <div className="wf-viewbar">
            <div className="wf-viewbar__tabs">
              <button
                type="button"
                className={`wf-viewtab ${view === "schemes" ? "wf-viewtab--active" : ""}`}
                onClick={() => setView("schemes")}
              >
                Schemes <span className="wf-viewtab__count">{formatNumber(data?.totalCount ?? schemes.length)}</span>
              </button>
              <button
                type="button"
                className={`wf-viewtab ${view === "statuses" ? "wf-viewtab--active" : ""}`}
                onClick={() => setView("statuses")}
              >
                Statuses <span className="wf-viewtab__count">{formatNumber(statuses.length)}</span>
              </button>
            </div>

            {view === "schemes" && (
              <input
                type="search"
                className="wf-search"
                placeholder="Search schemes…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search workflow schemes"
              />
            )}

            {view === "statuses" && statusesByCategory.size > 1 && (
              <div className="wf-catfilter">
                <button
                  type="button"
                  className={`wf-catchip ${statusCategory === "all" ? "wf-catchip--active" : ""}`}
                  onClick={() => setStatusCategory("all")}
                >
                  All
                </button>
                {[...statusesByCategory.entries()].map(([category, items]) => (
                  <button
                    key={category}
                    type="button"
                    className={`wf-catchip wf-catchip--${CATEGORY_TONE[category] || "other"} ${statusCategory === category ? "wf-catchip--active" : ""}`}
                    onClick={() => setStatusCategory(category)}
                  >
                    {category} <span className="wf-catchip__n">{items.length}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {loading ? (
            <div className="empty-state">Loading…</div>
          ) : view === "schemes" ? (
            <>
              {schemes.length === 0 ? (
                <div className="empty-state">
                  {deferredSearch ? `No schemes match “${deferredSearch}”.` : "No workflow schemes found."}
                </div>
              ) : (
                <div className="wf-scheme-list">
                  {schemes.map((scheme) => (
                    <SchemeRow
                      key={scheme.id}
                      scheme={scheme}
                      expanded={openSchemeId === scheme.id}
                      onToggle={() => setOpenSchemeId(openSchemeId === scheme.id ? null : scheme.id)}
                      projects={scheme.projects}
                      truncated={scheme.projectsTruncated}
                    />
                  ))}
                </div>
              )}

              {(data?.totalPages || 1) > 1 && (
                <div className="wf-pagination">
                  <button
                    className="secondary-button secondary-button--small"
                    type="button"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                  >
                    Previous
                  </button>
                  <span className="wf-pagination__label">
                    Page {data.page} of {data.totalPages}
                  </span>
                  <button
                    className="secondary-button secondary-button--small"
                    type="button"
                    onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
                    disabled={page >= (data?.totalPages || 1)}
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="wf-status-grid">
              {visibleStatuses.length === 0 ? (
                <div className="empty-state">No statuses in this category.</div>
              ) : (
                visibleStatuses.map((status) => (
                  <div key={status.id} className="wf-status">
                    <span className={`wf-status__dot wf-status__dot--${CATEGORY_TONE[status.statusCategory] || "other"}`} aria-hidden="true" />
                    <span className="wf-status__name">{status.name}</span>
                    {status.statusCategory && (
                      <span className="wf-status__cat">{status.statusCategory}</span>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
