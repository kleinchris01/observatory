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

const DUPLICATE_KIND_LABEL = {
  identical: "Same name, defined more than once",
  spacing: "Differ only by spacing or punctuation",
  spelling: "Differ by a single character",
};

// Governance findings over the status catalog and scheme balance.
//
// Ordered by what an admin can act on soonest: duplicates are unambiguous cleanup,
// orphans need a check before deleting, and scheme balance is a judgement call.
function WorkflowInsights({ insights, loading }) {
  if (loading && !insights) return <div className="empty-state">Analysing the workflow inventory…</div>;
  if (!insights) return null;

  if (!insights.available) {
    return (
      <div className="empty-state">
        {insights.reason === "error"
          ? "Could not analyse the workflow inventory."
          : "Build the workflow inventory first — these findings are derived from it."}
      </div>
    );
  }

  const { summary, duplicateGroups = [], orphans = [], balance = [], hasIssueCounts, schemeStatusesAvailable } = insights;

  return (
    <div className="wf-insights">
      <div className="wf-insight-stats">
        <div className="wf-insight-stat">
          <span className="wf-insight-stat__value">{formatNumber(summary.duplicateGroupCount)}</span>
          <span className="wf-insight-stat__label">
            Duplicate groups
            {summary.reducibleStatusCount > 0 && ` · ${formatNumber(summary.reducibleStatusCount)} statuses removable`}
          </span>
        </div>
        <div className="wf-insight-stat">
          <span className="wf-insight-stat__value">{formatNumber(summary.orphanCount)}</span>
          <span className="wf-insight-stat__label">
            Unreachable statuses
            {hasIssueCounts && ` · ${formatNumber(summary.safeToRemoveCount)} never used`}
          </span>
        </div>
        <div className="wf-insight-stat">
          <span className="wf-insight-stat__value">{formatNumber(summary.flaggedSchemeCount)}</span>
          <span className="wf-insight-stat__label">Schemes with a flag</span>
        </div>
      </div>

      {!hasIssueCounts && (
        <p className="wf-insights__note">
          <Icon name="alertTriangle" size={13} /> No issue counts yet. Run a Universe Scan to
          learn which of these statuses are actually in use — until then an unreachable status
          cannot be confirmed safe to delete.
        </p>
      )}

      {!schemeStatusesAvailable && (
        <p className="wf-insights__note">
          <Icon name="alertTriangle" size={13} /> Jira did not return workflow status data on
          the last build, so unreachable statuses and scheme balance cannot be assessed.
          Rebuilding the inventory usually resolves this.
        </p>
      )}

      <section className="wf-insight-section">
        <h3 className="wf-insight-section__title">Duplicate statuses</h3>
        <p className="wf-insight-section__desc">
          Statuses that almost certainly mean the same thing. Consolidating a group removes
          every status in it but one.
        </p>
        {duplicateGroups.length === 0 ? (
          <div className="empty-state empty-state--inline">No duplicate status names found.</div>
        ) : (
          <div className="wf-dupe-list">
            {duplicateGroups.map((group) => (
              <div key={`${group.kind}-${group.key}`} className="wf-dupe">
                <div className="wf-dupe__head">
                  <span className={`wf-chip wf-chip--${group.kind === "identical" ? "alert" : "muted"}`}>
                    {group.count}×
                  </span>
                  <span className="wf-dupe__reason">{DUPLICATE_KIND_LABEL[group.kind]}</span>
                </div>
                <div className="wf-dupe__members">
                  {group.statuses.map((status) => (
                    <span key={status.statusId} className="wf-dupe__member">
                      {status.name}
                      {status.issueCount !== null && status.issueCount !== undefined && (
                        <span className="wf-dupe__count">{formatNumber(status.issueCount)}</span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {schemeStatusesAvailable && (
        <section className="wf-insight-section">
          <h3 className="wf-insight-section__title">Unreachable statuses</h3>
          <p className="wf-insight-section__desc">
            Defined on the site but not reachable from any workflow scheme.
            {hasIssueCounts && " Those with no issues have never been used and are safe to remove."}
          </p>
          {orphans.length === 0 ? (
            <div className="empty-state empty-state--inline">Every status is reachable from a scheme.</div>
          ) : (
            <div className="wf-orphan-grid">
              {orphans.map((orphan) => (
                <div key={orphan.statusId} className={`wf-orphan ${orphan.safeToRemove ? "wf-orphan--safe" : ""}`}>
                  <span className="wf-orphan__name">{orphan.name}</span>
                  {orphan.issueCount === null ? (
                    <span className="wf-orphan__count wf-orphan__count--unknown">usage unknown</span>
                  ) : orphan.issueCount === 0 ? (
                    <span className="wf-orphan__count wf-orphan__count--safe">never used</span>
                  ) : (
                    <span className="wf-orphan__count">{formatNumber(orphan.issueCount)} issues</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {schemeStatusesAvailable && balance.some((entry) => entry.flags.length > 0) && (
        <section className="wf-insight-section">
          <h3 className="wf-insight-section__title">Scheme balance</h3>
          <p className="wf-insight-section__desc">
            How each scheme&apos;s statuses distribute across Jira&apos;s three categories.
          </p>
          <div className="wf-balance-list">
            {balance.filter((entry) => entry.flags.length > 0).map((entry) => (
              <div key={entry.schemeId} className="wf-balance">
                <div className="wf-balance__head">
                  <span className="wf-balance__name">{entry.name}</span>
                  <span className="wf-balance__projects">
                    {formatNumber(entry.projectCount)} {entry.projectCount === 1 ? "project" : "projects"}
                  </span>
                </div>
                <div className="wf-balance__bar" role="img"
                  aria-label={`${entry.todo} To Do, ${entry.inProgress} In Progress, ${entry.done} Done`}>
                  {entry.todo > 0 && <span className="wf-balance__seg wf-balance__seg--todo" style={{ flexGrow: entry.todo }}>{entry.todo}</span>}
                  {entry.inProgress > 0 && <span className="wf-balance__seg wf-balance__seg--progress" style={{ flexGrow: entry.inProgress }}>{entry.inProgress}</span>}
                  {entry.done > 0 && <span className="wf-balance__seg wf-balance__seg--done" style={{ flexGrow: entry.done }}>{entry.done}</span>}
                  {entry.uncategorised > 0 && <span className="wf-balance__seg wf-balance__seg--none" style={{ flexGrow: entry.uncategorised }}>{entry.uncategorised}</span>}
                </div>
                <ul className="wf-balance__flags">
                  {entry.flags.map((flag) => (
                    <li key={flag.code} className={`wf-balance__flag wf-balance__flag--${flag.severity}`}>{flag.message}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function WorkflowTab() {
  const [view, setView] = React.useState("schemes");
  const [insights, setInsights] = React.useState(null);
  const [insightsLoading, setInsightsLoading] = React.useState(false);
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

  // Loaded lazily: the insights view is site-wide analysis that most visits never open,
  // and re-running it on every scheme page change would be pure waste. Re-fetched when the
  // snapshot's refreshedAt changes, since a rebuild invalidates every finding.
  const refreshedAt = data?.snapshotStatus?.refreshedAt || null;
  React.useEffect(() => {
    if (view !== "insights") return undefined;
    let cancelled = false;
    setInsightsLoading(true);
    invoke("getWorkflowInsights", {})
      .then((res) => { if (!cancelled) setInsights(res); })
      .catch(() => { if (!cancelled) setInsights({ available: false, reason: "error" }); })
      .finally(() => { if (!cancelled) setInsightsLoading(false); });
    return () => { cancelled = true; };
  }, [view, refreshedAt]);

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
              <button
                type="button"
                className={`wf-viewtab ${view === "insights" ? "wf-viewtab--active" : ""}`}
                onClick={() => setView("insights")}
              >
                Insights
                {insights?.summary && (
                  <span className="wf-viewtab__count wf-viewtab__count--alert">
                    {formatNumber(
                      insights.summary.duplicateGroupCount
                      + insights.summary.orphanCount
                      + insights.summary.flaggedSchemeCount
                    )}
                  </span>
                )}
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

          {view === "insights" ? (
            <WorkflowInsights insights={insights} loading={insightsLoading} />
          ) : loading ? (
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
