import React from "react";
import { invoke } from "@forge/bridge";
import { Icon } from "./Icons";
import { Panel, EmptyState, Chip } from "./ui";
import { formatNumber, formatRelativeTime, handleJiraLinkClick } from "../utils";

// The Confluence macro's viewer-scoped pillars: the saved filters, dashboards and workflow
// schemes attached to the projects the person reading the page can Browse. Nothing about a
// project they cannot already see in Jira. Each view fetches its own SHARED resolver -- the
// macro shell only decides which tab is open.

function ViewerScopeNote({ projectCount }) {
  return (
    <p className="macro-pillar__scope">
      <Icon name="lock" size={12} />
      <span>
        Scoped to the {formatNumber(projectCount)} {projectCount === 1 ? "project" : "projects"} you can browse.
        Filters, dashboards and schemes for projects you cannot see are not shown.
      </span>
    </p>
  );
}

function Pagination({ page, totalPages, onPage }) {
  if (totalPages <= 1) return null;
  return (
    <div className="pagination-bar">
      <button type="button" className="secondary-button secondary-button--small" onClick={() => onPage(page - 1)} disabled={page <= 1}>
        Previous
      </button>
      <span>Page {page} of {totalPages}</span>
      <button type="button" className="secondary-button secondary-button--small" onClick={() => onPage(page + 1)} disabled={page >= totalPages}>
        Next
      </button>
    </div>
  );
}

// Shared shell for the two paginated list pillars (filters, dashboards).
function MacroListPillar({ resolver, title, icon, searchPlaceholder, siteOrigin, emptyText, renderRow, pluck }) {
  const [query, setQuery] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    const t = setTimeout(() => { setDebounced(query); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [query]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true); setError("");
    invoke(resolver, { query: debounced, page })
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err) => { if (!cancelled) setError(err?.message || "Could not load this view."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [resolver, debounced, page]);

  const rows = data ? (pluck(data) || []) : [];

  return (
    <Panel title={title} icon={icon}>
      {data?.available && <ViewerScopeNote projectCount={data.projectCount ?? 0} />}

      <label className="toolbar__field macro-pillar__search">
        <span>Search</span>
        <input type="search" placeholder={searchPlaceholder} value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>

      {error ? (
        <EmptyState inline>{error}</EmptyState>
      ) : loading && !data ? (
        <EmptyState inline>Loading…</EmptyState>
      ) : !data?.available ? (
        <EmptyState inline>
          Nothing to show yet — the {title.toLowerCase()} inventory has not been built. Ask a Jira admin to run a scan.
        </EmptyState>
      ) : !rows.length ? (
        <EmptyState inline>
          {debounced ? `Nothing matches "${debounced}".` : emptyText}
        </EmptyState>
      ) : (
        <>
          <p className="macro-pillar__count">
            {data.matchedTotal === data.total
              ? `${formatNumber(data.total)} ${data.total === 1 ? "item" : "items"}`
              : `${formatNumber(data.matchedTotal)} of ${formatNumber(data.total)}`}
            {data.snapshotRefreshedAt && ` · data from ${formatRelativeTime(data.snapshotRefreshedAt)}`}
          </p>
          <ul className="macro-pillar__list">
            {rows.map((row) => renderRow(row, siteOrigin))}
          </ul>
          <Pagination page={data.page} totalPages={data.totalPages} onPage={setPage} />
        </>
      )}
    </Panel>
  );
}

function jiraLink(href, label) {
  if (!href) return <span className="macro-pillar__name">{label}</span>;
  return (
    <a className="macro-pillar__name" href={href} target="_blank" rel="noreferrer" onClick={(e) => handleJiraLinkClick(e, href)}>
      {label}
    </a>
  );
}

export function MacroFiltersView({ siteOrigin }) {
  return (
    <MacroListPillar
      resolver="getMacroFilters"
      title="Filters"
      icon="search"
      searchPlaceholder="Search filter name or JQL…"
      siteOrigin={siteOrigin}
      emptyText="No saved filter targets a project you can browse."
      pluck={(d) => d.filters}
      renderRow={(f, origin) => (
        <li key={f.id} className="macro-pillar__row">
          <div className="macro-pillar__row-head">
            {jiraLink(f.viewUrl || (origin ? `${origin}/issues/?filter=${f.id}` : null), f.name)}
            {f.owner && <span className="macro-pillar__owner">{f.owner}</span>}
            {(f.projects || []).map((p) => <Chip key={p} tone="neutral">{p}</Chip>)}
          </div>
          {f.jql && <code className="macro-pillar__jql">{f.jql}</code>}
          {(f.fields || []).length > 0 && (
            <p className="macro-pillar__fields">Uses: {f.fields.join(", ")}</p>
          )}
        </li>
      )}
    />
  );
}

export function MacroDashboardsView({ siteOrigin }) {
  return (
    <MacroListPillar
      resolver="getMacroDashboards"
      title="Dashboards"
      icon="barChart"
      searchPlaceholder="Search dashboard name or field…"
      siteOrigin={siteOrigin}
      emptyText="No dashboard is shared with a project you can browse, or built on one of its filters."
      pluck={(d) => d.dashboards}
      renderRow={(d, origin) => (
        <li key={d.id} className="macro-pillar__row">
          <div className="macro-pillar__row-head">
            {jiraLink(d.viewUrl || (origin ? `${origin}/jira/dashboards/${d.id}` : null), d.name)}
            {d.owner && <span className="macro-pillar__owner">{d.owner}</span>}
            {d.sharedToProject && <Chip tone="neutral">shared to your project</Chip>}
            <Chip tone="neutral">{formatNumber(d.gadgetCount || 0)} {d.gadgetCount === 1 ? "gadget" : "gadgets"}</Chip>
          </div>
          {(d.fields || []).length > 0 && (
            <p className="macro-pillar__fields">Depends on: {d.fields.join(", ")}</p>
          )}
        </li>
      )}
    />
  );
}

export function MacroWorkflowsView() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    invoke("getMacroWorkflows", {})
      .then((r) => { if (!cancelled) setData(r); })
      .catch((err) => { if (!cancelled) setError(err?.message || "Could not load workflows."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <Panel title="Workflows &amp; statuses" icon="activity">
      {data?.available && <ViewerScopeNote projectCount={data.projectCount ?? 0} />}

      {error ? (
        <EmptyState inline>{error}</EmptyState>
      ) : loading ? (
        <EmptyState inline>Loading…</EmptyState>
      ) : !data?.available ? (
        <EmptyState inline>No workflow inventory has been built. Ask a Jira admin to run a scan.</EmptyState>
      ) : !data.schemes.length ? (
        <EmptyState inline>None of the projects you can browse resolve to a workflow scheme in this snapshot.</EmptyState>
      ) : (
        <>
          <div className="macro-workflows__schemes">
            {data.schemes.map((scheme) => (
              <div key={scheme.schemeId} className="macro-workflows__scheme">
                <div className="macro-workflows__scheme-head">
                  <span className="macro-pillar__name">{scheme.name}</span>
                  {(scheme.projects || []).map((p) => <Chip key={p} tone="neutral">{p}</Chip>)}
                </div>
                <div className="macro-workflows__statuses">
                  {scheme.statuses.map((s) => (
                    <span key={s.id} className={`macro-status macro-status--${(s.category || "").toLowerCase().replace(/\s+/g, "-")}`}>
                      {s.name}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <p className="macro-pillar__count" style={{ marginTop: 16 }}>
            {formatNumber(data.statuses.length)} distinct {data.statuses.length === 1 ? "status" : "statuses"} across your projects
            {data.snapshotRefreshedAt && ` · data from ${formatRelativeTime(data.snapshotRefreshedAt)}`}
          </p>
        </>
      )}
    </Panel>
  );
}

// A pillar that loads once and renders whatever it got. The three below share it because
// none of them paginates -- a viewer browses a handful of projects, not the site.
function useMacroPillar(resolver) {
  const [state, setState] = React.useState({ loading: true });
  React.useEffect(() => {
    let cancelled = false;
    invoke(resolver, {})
      .then((data) => { if (!cancelled) setState({ loading: false, data }); })
      .catch((err) => { if (!cancelled) setState({ loading: false, error: err?.message || "Could not load this section." }); });
    return () => { cancelled = true; };
  }, [resolver]);
  return state;
}

// One body for every "loaded, might be empty, might not be built" pillar, so the four states
// read identically wherever they appear. The distinction that matters is the middle pair:
// "nobody has built this yet" and "it is built and none of it is yours" are different facts,
// and a viewer who sees the wrong one goes and asks the wrong person about it.
function PillarBody({ state, notBuilt, noneYours, isEmpty, children }) {
  if (state.error) return <EmptyState inline>{state.error}</EmptyState>;
  if (state.loading) return <EmptyState inline>Loading…</EmptyState>;
  if (!state.data?.available) return <EmptyState inline>{notBuilt}</EmptyState>;
  if (isEmpty(state.data)) return <EmptyState inline>{noneYours}</EmptyState>;
  return children;
}

function Freshness({ refreshedAt }) {
  if (!refreshedAt) return null;
  return (
    <p className="macro-pillar__count" style={{ marginTop: 16 }}>
      Data from {formatRelativeTime(refreshedAt)}.
    </p>
  );
}

// The forms your projects actually put in front of people.
//
// Ordered by the longest CREATE screen first, because that is the number anyone opens this
// to argue about: the form every person filing an issue here has to get through, and the one
// nobody can skip.
export function MacroScreensView() {
  const state = useMacroPillar("getMacroScreens");

  return (
    <Panel
      title="Screens"
      icon="copy"
      description="The forms your projects route to, and how many fields each one carries."
    >
      <ViewerScopeNote projectCount={state.data?.projectCount ?? 0} />
      <PillarBody
        state={state}
        notBuilt="No screen inventory has been built. Ask a Jira admin to run a scan."
        noneYours="None of the projects you can browse resolve to a screen in this snapshot."
        isEmpty={(d) => !d.projects?.length}
      >
        <div className="macro-screens">
          {(state.data?.projects || []).map((project) => (
            <div key={project.projectId} className="macro-screens__project">
              <div className="macro-screens__head">
                <span className="macro-pillar__name">{project.projectKey}</span>
                <span className="macro-pillar__owner">{project.projectName}</span>
                {project.createFieldCount > 0 && (
                  // Tone on the number, not a separate warning: a long create form is a cost,
                  // not a defect, and the reader decides whether theirs is too long.
                  <Chip tone={project.createFieldCount >= 20 ? "warning" : "neutral"}>
                    {formatNumber(project.createFieldCount)} fields to create an issue
                  </Chip>
                )}
              </div>
              {!project.screens.length ? (
                <p className="macro-pillar__count">No screen in this snapshot serves this project.</p>
              ) : (
                <ul className="macro-screens__list">
                  {project.screens.map((screen) => (
                    <li key={screen.screenId} className="macro-screens__row">
                      <span className="macro-pillar__name">{screen.name}</span>
                      <span className="macro-screens__ops">
                        {screen.operations.map((op) => <Chip key={op} tone="neutral">{op}</Chip>)}
                      </span>
                      {screen.unreadable ? (
                        // Never "0 fields" for a screen nobody could read. The viewer is the
                        // person about to ask why their form looks different from this page.
                        <Chip tone="warning" title="This screen could not be read in the last scan, so its field count is unknown.">
                          not readable
                        </Chip>
                      ) : (
                        <span className="macro-pillar__count">{formatNumber(screen.fieldCount)} fields</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
        <Freshness refreshedAt={state.data?.refreshedAt} />
      </PillarBody>
    </Panel>
  );
}

// Which issue types your projects may use, grouped by the scheme that decides it.
//
// Grouped rather than listed per project on purpose: projects sharing a scheme are MEANT to
// run the same set, so the grouping is the information. A project sitting alone in a group is
// the question worth asking, and it is visible at a glance rather than by comparison.
export function MacroIssueTypesView() {
  const state = useMacroPillar("getMacroIssueTypes");

  return (
    <Panel
      title="Issue types"
      icon="layers"
      description="The types your projects can create, and the schemes that decide it."
    >
      <ViewerScopeNote projectCount={state.data?.projectCount ?? 0} />
      <PillarBody
        state={state}
        notBuilt="No issue type inventory has been built. Ask a Jira admin to run a scan."
        noneYours="None of the projects you can browse are attached to an issue type scheme in this snapshot."
        isEmpty={(d) => !d.schemes?.length}
      >
        <div className="macro-workflows__schemes">
          {(state.data?.schemes || []).map((scheme) => (
            <div key={scheme.schemeId} className="macro-workflows__scheme">
              <div className="macro-workflows__scheme-head">
                <span className="macro-pillar__name">{scheme.name}</span>
                {scheme.projects.map((key) => <Chip key={key} tone="neutral">{key}</Chip>)}
              </div>
              <div className="macro-workflows__statuses">
                {scheme.issueTypes.map((type) => (
                  <span
                    key={type.id}
                    className="macro-status macro-status--to-do"
                    title={type.missing ? "This scheme names a type that no longer exists in the catalogue." : undefined}
                  >
                    {type.name || `#${type.id}`}{type.subtask ? " (sub-task)" : ""}{type.missing ? " — missing" : ""}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <Freshness refreshedAt={state.data?.refreshedAt} />
      </PillarBody>
    </Panel>
  );
}

// The agile boards living in your projects.
export function MacroBoardsView() {
  const state = useMacroPillar("getMacroBoards");

  return (
    <Panel
      title="Boards"
      icon="activity"
      description="The boards your projects own, and what each one is built on."
    >
      <ViewerScopeNote projectCount={state.data?.projectCount ?? 0} />
      <PillarBody
        state={state}
        notBuilt="No board inventory has been built. Ask a Jira admin to run a scan."
        noneYours="None of the projects you can browse own a board in this snapshot."
        isEmpty={(d) => !d.boards?.length}
      >
        <ul className="macro-pillar__list">
          {(state.data?.boards || []).map((board) => (
            <li key={board.boardId} className="macro-pillar__row">
              <div className="macro-pillar__row-head">
                <span className="macro-pillar__name">{board.name}</span>
                {board.projectKey && <Chip tone="neutral">{board.projectKey}</Chip>}
                {board.type && <Chip tone="neutral">{board.type}</Chip>}
              </div>
              {board.configReadable ? (
                <p className="macro-pillar__count">
                  {formatNumber(board.columnCount)} {board.columnCount === 1 ? "column" : "columns"}
                </p>
              ) : (
                // Team-managed boards routinely refuse their configuration endpoint. Listing
                // the board and saying its detail is unknown beats dropping it, which would
                // read as "you have no board here" to the person looking at one.
                <p className="macro-pillar__count">
                  Its configuration could not be read, so its columns are unknown.
                </p>
              )}
            </li>
          ))}
        </ul>
        <Freshness refreshedAt={state.data?.refreshedAt} />
      </PillarBody>
    </Panel>
  );
}
