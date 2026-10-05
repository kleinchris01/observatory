import React from "react";
import { invoke } from "@forge/bridge";
import { formatNumber, buildWorkflowUrl } from "../utils";
import { Icon } from "../components/Icons";
import { StatTile, StatRow, Panel, EmptyState, SortFilterBar, Chip, JiraLink, WorkflowUsageList } from "../components/ui";

// What each workflow enforces: the conditions, validators and post-functions on its
// transitions, the restrictions set on its statuses, and the workflows themselves.
//
// Three views on one snapshot, split out of WorkflowTab.jsx because that file already holds
// the scheme and status inventory. All read-only, like the rest of the tab.

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

const KIND_OPTIONS = [
  { value: "all", label: "Any kind" },
  { value: "validator", label: "Validators" },
  { value: "condition", label: "Conditions" },
  { value: "post-function", label: "Post-functions" },
  { value: "trigger", label: "Triggers" },
];

function useDebounced(value, ms = SEARCH_DEBOUNCE_MS) {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

// Said the same way in all three views: "no snapshot" and "snapshot without rules" are
// different instructions, and neither is an empty list.
function Unavailable({ result }) {
  return (
    <EmptyState>
      {result?.reason === "rules-not-read"
        ? "This workflow inventory was built before transition rules were captured. Rebuild it to see validators, conditions, post-functions and status restrictions."
        : "No workflow inventory yet. Build one from the header."}
    </EmptyState>
  );
}

// ── Rules ────────────────────────────────────────────────────────────────────

// Every transition rule on the site, searchable by what it points at. Typing a field's name
// or id finds every validator that requires it, every condition that checks it and every
// post-function that writes it -- with the transition and the statuses it runs between.
export function WorkflowRulesView({ siteOrigin, intent = null, load = invoke }) {
  const [search, setSearch] = React.useState("");
  const [kind, setKind] = React.useState("all");
  const [broken, setBroken] = React.useState(intent?.filter === "broken" ? "broken" : "all");
  const [page, setPage] = React.useState(0);
  const [state, setState] = React.useState({ loading: true, error: "", data: null });
  const query = useDebounced(search);

  React.useEffect(() => { setPage(0); }, [query, kind, broken]);

  React.useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: "" }));
    load("getWorkflowRules", {
      query,
      kind: kind === "all" ? null : kind,
      brokenOnly: broken === "broken",
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    })
      .then((data) => { if (!cancelled) setState({ loading: false, error: "", data }); })
      .catch((err) => { if (!cancelled) setState({ loading: false, error: err?.message || "Could not load workflow rules.", data: null }); });
    return () => { cancelled = true; };
  }, [query, kind, broken, page, load]);

  const { loading, error, data } = state;
  if (!loading && data && !data.available) return <Unavailable result={data} />;

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // The shared list renders "usages"; a rule row is one with its references attached.
  const listResult = data?.available
    ? {
        available: true,
        usages: data.rules.map((rule) => ({
          workflowName: rule.workflowName,
          transition: rule.transition,
          rule: { kind: rule.kind, key: rule.key, label: rule.label, summary: rule.summary },
          refs: rule.refs,
        })),
      }
    : null;

  return (
    <>
      <SortFilterBar
        search={search}
        onSearchChange={setSearch}
        searchLabel="Search transition rules"
        searchPlaceholder="Field name or id, group, workflow, transition…"
        filters={[
          { key: "kind", label: "Kind", value: kind, onChange: setKind, options: KIND_OPTIONS },
          {
            key: "broken",
            label: "References",
            value: broken,
            onChange: setBroken,
            options: [{ value: "all", label: "Any" }, { value: "broken", label: "Naming something missing" }],
          },
        ]}
        resultCount={data?.available ? total : undefined}
        onClear={() => { setSearch(""); setKind("all"); setBroken("all"); }}
      />

      <p className="ui-note">
        <Icon name="info" size={13} />
        <span>
          Jira&apos;s own housekeeping post-functions (reindex, fire event, set status) are left out.
          Rules from apps such as ScriptRunner show their app key, and are matched to a field only
          where they name it by id.
        </span>
      </p>

      {error ? (
        <div className="danger-zone__error" role="alert">{error}</div>
      ) : loading && !data ? (
        <EmptyState>Loading transition rules…</EmptyState>
      ) : (
        <WorkflowUsageList
          result={listResult}
          siteOrigin={siteOrigin}
          emptyMessage={query || kind !== "all" || broken !== "all" ? "No rule matches these filters." : "No workflow has a condition, validator or post-function."}
        />
      )}

      {pages > 1 && (
        <div className="wf-pagination">
          <button className="secondary-button secondary-button--small" type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0 || loading}>
            Previous
          </button>
          <span className="wf-pagination__label">Page {page + 1} of {pages}</span>
          <button className="secondary-button secondary-button--small" type="button" onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1 || loading}>
            Next
          </button>
        </div>
      )}
    </>
  );
}

// ── Restrictions ─────────────────────────────────────────────────────────────

const PERMISSION_LABEL = { edit: "Edit", comment: "Comment", attach: "Attach", delete: "Delete", work: "Log work", transition: "Transition", assign: "Assign", create: "Create" };

// What each status locks down, and to whom: "Edit: only Plant Engineers" in Build WF's
// In Review. Answers "why can nobody edit this issue" and "which statuses does this group
// hold the keys to" from one list.
export function WorkflowRestrictionsView({ siteOrigin, load = invoke }) {
  const [state, setState] = React.useState({ loading: true, error: "", data: null });
  const [search, setSearch] = React.useState("");
  const [permission, setPermission] = React.useState("all");

  React.useEffect(() => {
    let cancelled = false;
    load("getWorkflowRestrictions", {})
      .then((data) => { if (!cancelled) setState({ loading: false, error: "", data }); })
      .catch((err) => { if (!cancelled) setState({ loading: false, error: err?.message || "Could not load restrictions.", data: null }); });
    return () => { cancelled = true; };
  }, [load]);

  const { loading, error, data } = state;
  if (loading) return <EmptyState>Loading status restrictions…</EmptyState>;
  if (error) return <div className="danger-zone__error" role="alert">{error}</div>;
  if (!data?.available) return <Unavailable result={data} />;

  const permissions = [...new Set(data.restrictions.map((r) => r.permission).filter(Boolean))].sort();
  const q = search.trim().toLowerCase();
  const rows = data.restrictions.filter((r) => {
    if (permission !== "all" && r.permission !== permission) return false;
    if (!q) return true;
    return [r.workflowName, r.status?.name, r.holder?.label, r.holder?.id, r.key, r.description]
      .some((v) => String(v || "").toLowerCase().includes(q));
  });

  return (
    <>
      <StatRow>
        <StatTile label="Statuses with editing locked" value={formatNumber(data.summary.editLockedStatuses)} hint="per workflow" icon="lock" />
        <StatTile label="Workflows with restrictions" value={formatNumber(data.summary.workflows)} icon="activity" />
        <StatTile
          label="Holders that no longer exist"
          value={formatNumber(data.summary.missingHolders)}
          tone={data.summary.missingHolders > 0 ? "critical" : "neutral"}
          hint={data.summary.missingHolders > 0 ? "a deleted group can lock everyone out" : null}
          icon="alertTriangle"
        />
      </StatRow>

      <SortFilterBar
        search={search}
        onSearchChange={setSearch}
        searchLabel="Search restrictions"
        searchPlaceholder="Workflow, status, group…"
        filters={[{
          key: "permission",
          label: "Permission",
          value: permission,
          onChange: setPermission,
          options: [{ value: "all", label: "Any permission" }, ...permissions.map((p) => ({ value: p, label: PERMISSION_LABEL[p] || p }))],
        }]}
        resultCount={rows.length}
        totalCount={data.restrictions.length}
        onClear={() => { setSearch(""); setPermission("all"); }}
      />

      {rows.length === 0 ? (
        <EmptyState>
          {data.restrictions.length === 0
            ? "No workflow restricts editing, commenting or any other permission through a status property."
            : "No restriction matches these filters."}
        </EmptyState>
      ) : (
        <ul className="ui-wfusage">
          {rows.map((r, i) => (
            <li key={`${r.workflowName}-${r.status?.id ?? r.transitionId}-${r.key}-${i}`} className="ui-wfusage__row">
              <span className="ui-wfusage__workflow">
                <JiraLink href={buildWorkflowUrl(siteOrigin, r.workflowName)} title={`Open ${r.workflowName} in Jira`}>{r.workflowName}</JiraLink>
              </span>
              <span className="ui-wfusage__where">
                <span className="ui-transition__name">{r.status ? `Status: ${r.status.name}` : `Transition ${r.transitionId}`}</span>
              </span>
              <span className="ui-wfusage__what">
                <Chip tone={r.effect === "not-editable" || r.holderType === "denied" ? "warning" : "neutral"}>
                  {PERMISSION_LABEL[r.permission] || r.permission || "Restriction"}
                </Chip>
                <span className="ui-wfusage__label" title={`${r.key} = ${r.value}`}>
                  {r.effect === "not-editable"
                    ? "Not editable by anyone"
                    : r.holder
                      ? <>Only {r.holderType === "group" ? "group" : r.holderType} <strong>{r.holder.label || r.holder.id}</strong></>
                      : r.description}
                </span>
                {r.holder?.missing && <Chip tone="critical" title={`${r.holder.id} no longer exists`}>missing</Chip>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ── Workflows ────────────────────────────────────────────────────────────────

// The workflows themselves: how many rules each carries, whether any project uses it, and
// the references that point at nothing.
export function WorkflowCatalogView({ siteOrigin, intent = null, load = invoke }) {
  const [state, setState] = React.useState({ loading: true, error: "", data: null });
  const [search, setSearch] = React.useState("");
  const [usage, setUsage] = React.useState(intent?.filter === "inactive" ? "inactive" : "all");

  React.useEffect(() => {
    let cancelled = false;
    load("getWorkflowRuleInsights", {})
      .then((data) => { if (!cancelled) setState({ loading: false, error: "", data }); })
      .catch((err) => { if (!cancelled) setState({ loading: false, error: err?.message || "Could not load workflows.", data: null }); });
    return () => { cancelled = true; };
  }, [load]);

  const { loading, error, data } = state;
  if (loading) return <EmptyState>Loading workflows…</EmptyState>;
  if (error) return <div className="danger-zone__error" role="alert">{error}</div>;
  if (!data?.available) return <Unavailable result={data} />;

  const inactiveNames = new Set(data.inactive.map((w) => w.name));
  const brokenByWorkflow = new Map();
  for (const ref of data.brokenRefs) brokenByWorkflow.set(ref.workflowName, (brokenByWorkflow.get(ref.workflowName) || 0) + 1);

  const q = search.trim().toLowerCase();
  const rows = data.workflows.filter((w) => {
    if (usage === "inactive" && !inactiveNames.has(w.name)) return false;
    if (usage === "broken" && !brokenByWorkflow.has(w.name)) return false;
    if (usage === "team" && w.scopeType !== "PROJECT") return false;
    return !q || w.name.toLowerCase().includes(q);
  });
  const { totals } = data;

  return (
    <>
      <StatRow>
        <StatTile label="Workflows" value={formatNumber(totals.workflows)} hint={totals.teamManaged ? `${formatNumber(totals.teamManaged)} team-managed` : null} icon="activity" />
        <StatTile label="Transition rules" value={formatNumber(totals.rules)} hint="conditions, validators, post-functions" icon="layers" />
        <StatTile
          label="Broken references"
          value={formatNumber(totals.brokenRules + totals.brokenProperties)}
          tone={totals.brokenRules + totals.brokenProperties > 0 ? "critical" : "neutral"}
          hint="naming a deleted field, group or role"
          icon="alertTriangle"
        />
        <StatTile label="Inactive" value={formatNumber(totals.inactive)} tone={totals.inactive > 0 ? "warning" : "neutral"} hint="no project's scheme uses them" icon="clock" />
      </StatRow>

      {data.brokenRefs.length > 0 && (
        <Panel title="References to things that no longer exist" icon="alertTriangle" description="A validator requiring a deleted field blocks the transition or stops checking; a status locked to a deleted group can lock everyone out.">
          <ul className="ui-wfusage">
            {data.brokenRefs.map((ref, i) => (
              <li key={`${ref.workflowName}-${ref.type}-${ref.id}-${i}`} className="ui-wfusage__row">
                <span className="ui-wfusage__workflow">
                  <JiraLink href={buildWorkflowUrl(siteOrigin, ref.workflowName)}>{ref.workflowName}</JiraLink>
                </span>
                <span className="ui-wfusage__where">
                  <span className="ui-transition__name">{ref.status ? `Status: ${ref.status.name}` : `Transition ${ref.transitionId}`}</span>
                </span>
                <span className="ui-wfusage__what">
                  <Chip tone="critical">{ref.type}</Chip>
                  <span className="ui-wfusage__label">{ref.id}</span>
                  {ref.propKey && <span className="ui-wfusage__summary">{ref.propKey}</span>}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <SortFilterBar
        search={search}
        onSearchChange={setSearch}
        searchLabel="Search workflows"
        searchPlaceholder="Search workflows…"
        filters={[{
          key: "usage",
          label: "Show",
          value: usage,
          onChange: setUsage,
          options: [
            { value: "all", label: "All workflows" },
            { value: "inactive", label: "Inactive", count: data.inactive.length },
            { value: "broken", label: "With broken references", count: brokenByWorkflow.size },
            { value: "team", label: "Team-managed", count: totals.teamManaged },
          ],
        }]}
        resultCount={rows.length}
        totalCount={data.workflows.length}
        onClear={() => { setSearch(""); setUsage("all"); }}
      />

      {rows.length === 0 ? (
        <EmptyState>No workflow matches these filters.</EmptyState>
      ) : (
        <ul className="ui-wfusage">
          {rows.map((w) => (
            <li key={w.name} className="ui-wfusage__row">
              <span className="ui-wfusage__workflow">
                <JiraLink href={buildWorkflowUrl(siteOrigin, w.name)} title={`Open ${w.name} in Jira`}>{w.name}</JiraLink>
              </span>
              <span className="ui-wfusage__where">
                <span className="ui-transition__path">
                  {formatNumber(w.statusCount)} statuses · {formatNumber(w.transitionCount)} transitions · {formatNumber(w.ruleCount)} rules
                </span>
              </span>
              <span className="ui-wfusage__what">
                {w.scopeType === "PROJECT"
                  ? <Chip>team-managed</Chip>
                  : inactiveNames.has(w.name)
                    ? <Chip tone="warning">inactive</Chip>
                    : <Chip tone="success">{`${formatNumber(w.schemeCount)} scheme${w.schemeCount === 1 ? "" : "s"}`}</Chip>}
                {brokenByWorkflow.has(w.name) && <Chip tone="critical">{`${brokenByWorkflow.get(w.name)} broken`}</Chip>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
