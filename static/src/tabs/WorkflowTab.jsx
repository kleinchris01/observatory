import React from "react";
import { invoke } from "@forge/bridge";
import { formatTimestamp, formatRelativeTime, formatNumber, buildWorkflowSchemeUrl, buildStatusAdminUrl, buildWorkflowUrl } from "../utils";
import { Icon } from "../components/Icons";
import { StatTile, StatRow, Panel, EmptyState, PageHeader, SortFilterBar, Chip, RuleLink, AskRovo, JiraLink, FindingRow, PillarHealthPanel, WorkflowUsageList, UsageTriple } from "../components/ui";
import { buildRovoPrompt } from "../utils";
import { SubNavLayout } from "../components/admin/primitives";
import { useNavIntent, usePersistentState, usePillarUsage } from "../hooks";
import { WorkflowRulesView, WorkflowRestrictionsView, WorkflowCatalogView } from "./WorkflowRulesView";

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
// Sort tokens for the status list. Labels say what is being ordered, not which column --
// "Sort by ever" meant nothing to anyone who had not read the query.
const STATUS_SORT_OPTIONS = [
  { value: "name", label: "Name A–Z" },
  { value: "current", label: "Most issues now" },
  { value: "ever", label: "Most issues ever" },
  { value: "departed", label: "Most issues departed" },
];

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
            <EmptyState inline>No projects you can browse are using this scheme.</EmptyState>
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
// Which rules hold a status open, and how.
//
// The tab has been able to say "17 rules" against an unreachable status since the references
// moved to SQL. A count is where the question starts, not where it ends: an admin looking at
// a status they want to delete needs the rule NAMES, and needs to know whether a rule
// transitions issues INTO it -- which is what keeps it alive -- or merely reads it in a
// condition, which breaks if the status goes but does not keep it in use.
//
// Fetched when a status is opened rather than with the page. There are 94 unreachable
// statuses on this site and a reader opens one or two.
const VERDICT_TONE = { "in-use": "warning", "no-evidence-of-use": "success", unknown: "neutral" };
const BLOCKER_TONE = { high: "critical", medium: "warning", low: "info" };

// What the status drawer adds above the rule and filter lists: the deletion verdict, the
// schemes and workflows that hold the status, every transition into and out of it, and what
// each workflow restricts while an issue sits in it. One read, getStatusDetail, which is the
// same computation the workflow agent's impact answer uses -- so the tab and Rovo agree.
function StatusDetail({ detail, siteOrigin }) {
  if (!detail) return <EmptyState inline>Reading the status…</EmptyState>;
  if (!detail.available) return <EmptyState inline>No workflow inventory has been built.</EmptyState>;
  if (!detail.found) return <EmptyState inline>This status is not in the current snapshot.</EmptyState>;

  const into = (detail.transitions || []).filter((t) => t.direction === "into");
  const out = (detail.transitions || []).filter((t) => t.direction === "out");
  const restrictions = detail.restrictions?.available ? detail.restrictions.restrictions : null;

  return (
    <div className="wf-statusdetail">
      <section className={`wf-statusdetail__verdict wf-statusdetail__verdict--${detail.verdict}`}>
        <Chip tone={VERDICT_TONE[detail.verdict] || "neutral"}>{detail.verdict.replace(/-/g, " ")}</Chip>
        <p className="wf-statusdetail__headline">{detail.headline}</p>
        {detail.blockers.map((b) => (
          <FindingRow key={`${b.source}-${b.summary}`} tone={BLOCKER_TONE[b.severity] || "info"} title={b.summary} detail={b.detail} />
        ))}
        {detail.gaps.length > 0 && (
          <p className="ui-note">
            <Icon name="info" size={13} />
            <span>Not checked: {detail.gaps.map((g) => g.source).join(", ")}.</span>
          </p>
        )}
      </section>

      <section className="wf-statusrules__group">
        <header className="wf-statusrules__grouphead">
          <Chip tone={detail.schemeCount > 0 ? "warning" : "neutral"}>Reached by workflow schemes</Chip>
          <span className="wf-statusrules__count">{formatNumber(detail.schemeCount)}</span>
          <p className="wf-statusrules__hint">
            {detail.schemeCount === 0
              ? "No project's workflow scheme reaches it."
              : `Governing ${formatNumber(detail.projectCount)} project${detail.projectCount === 1 ? "" : "s"}${detail.projectSample.length ? `: ${detail.projectSample.join(", ")}` : ""}.`}
          </p>
        </header>
        {detail.schemes.length > 0 && (
          <ul className="wf-statusrules__list">
            {detail.schemes.map((s) => (
              <li key={s.schemeId} className="wf-statusrules__rule">
                <JiraLink href={buildWorkflowSchemeUrl(siteOrigin, s.schemeId)} title={`Open ${s.name} in Jira`}>{s.name}</JiraLink>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="wf-statusrules__group">
        <header className="wf-statusrules__grouphead">
          <Chip tone={detail.workflows?.length ? "warning" : "neutral"}>In workflows</Chip>
          {detail.workflows && <span className="wf-statusrules__count">{formatNumber(detail.workflows.length)}</span>}
          <p className="wf-statusrules__hint">
            {!detail.rulesRead
              ? "The workflow inventory predates transition capture. Rebuild it to see which workflows contain this status."
              : detail.workflows.length === 0
                ? "No workflow contains it, active or not."
                : "Jira will not delete a status any workflow uses, active or not."}
          </p>
        </header>
        {detail.workflows?.length > 0 && (
          <ul className="wf-statusrules__list">
            {detail.workflows.map((name) => (
              <li key={name} className="wf-statusrules__rule">
                <JiraLink href={buildWorkflowUrl(siteOrigin, name)} title={`Open ${name} in Jira`}>{name}</JiraLink>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail.transitions && detail.transitions.length > 0 && (
        <section className="wf-statusrules__group">
          <header className="wf-statusrules__grouphead">
            <Chip>Transitions</Chip>
            <span className="wf-statusrules__count">{formatNumber(into.length)} in · {formatNumber(out.length)} out</span>
            <p className="wf-statusrules__hint">How an issue gets here and leaves. A transition with rules has a condition or validator that has to pass first.</p>
          </header>
          <ul className="ui-wfusage">
            {[...into, ...out].map((t, i) => (
              <li key={`${t.workflowName}-${t.name}-${i}`} className="ui-wfusage__row">
                <span className="ui-wfusage__workflow">{t.workflowName}</span>
                <span className="ui-wfusage__where">
                  <span className="ui-transition">
                    <span className="ui-transition__name">{t.name}</span>
                    <span className="ui-transition__path">{t.from.join(", ")} → {t.to || "?"}</span>
                  </span>
                </span>
                <span className="ui-wfusage__what">
                  <Chip tone={t.direction === "into" ? "active" : "neutral"}>{t.direction}</Chip>
                  {t.ruleCount > 0 && <Chip tone="warning">{`${formatNumber(t.ruleCount)} rule${t.ruleCount === 1 ? "" : "s"}`}</Chip>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {restrictions && restrictions.length > 0 && (
        <section className="wf-statusrules__group">
          <header className="wf-statusrules__grouphead">
            <Chip tone="warning">Restricted while here</Chip>
            <span className="wf-statusrules__count">{formatNumber(restrictions.length)}</span>
            <p className="wf-statusrules__hint">Status properties that narrow who can edit, comment or act while an issue sits in this status.</p>
          </header>
          <ul className="wf-statusrules__list">
            {restrictions.map((r, i) => (
              <li key={`${r.workflowName}-${r.key}-${i}`} className="wf-statusrules__rule">
                <span>{r.workflowName}: {r.effect === "not-editable" ? "not editable by anyone" : `${r.permission} only ${r.holder?.label || r.holder?.id || r.holderType}`}</span>
                {r.holder?.missing && <Chip tone="critical">missing</Chip>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.ruleUsage?.available && detail.ruleUsage.total > 0 && (
        <section className="wf-statusrules__group">
          <header className="wf-statusrules__grouphead">
            <Chip tone="warning">Named by workflow rules</Chip>
            <span className="wf-statusrules__count">{formatNumber(detail.ruleUsage.total)}</span>
            <p className="wf-statusrules__hint">A previous-status validator or similar. These stop matching if the status goes.</p>
          </header>
          <WorkflowUsageList result={detail.ruleUsage} siteOrigin={siteOrigin} />
        </section>
      )}
    </div>
  );
}

function StatusRulesPanel({ status, siteOrigin, onClose, load = invoke, issueUsage = null }) {
  const [usage, setUsage] = React.useState(null);
  const [filters, setFilters] = React.useState(null);
  const [detail, setDetail] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Two sources, one question. A rule transitioning into a status keeps it alive; a saved
    // filter searching on it breaks silently when it goes. Fetched together because the
    // answer is only complete with both, and asked for independently because either pillar
    // can be unbuilt without the other.
    setDetail(null);
    Promise.all([
      load("getStatusAutomationUsage", { statusName: status.name }).catch(() => null),
      load("getFilterUsage", { kind: "status", label: status.name }).catch(() => null),
      load("getStatusDetail", { statusId: String(status.statusId ?? status.id) }).catch(() => ({ available: false })),
    ])
      .then(([rules, filterUsage, statusDetail]) => {
        if (cancelled) return;
        setUsage(rules);
        setFilters(filterUsage);
        setDetail(statusDetail);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [status.name, status.statusId, status.id, load]);

  // Ordered by consequence, not alphabetically. A rule that transitions into this status is
  // the reason it cannot be deleted; the other two break if it is.
  const groups = [
    { key: "write", label: "Transitions issues into it", tone: "danger", hint: "These keep the status in use. Deleting it breaks them." },
    { key: "trigger", label: "Runs when an issue enters or leaves it", tone: "warning", hint: "These stop firing if the status is deleted." },
    { key: "read", label: "Checks it in a condition", tone: "info", hint: "These break if the status is deleted, but do not keep it alive." },
  ];

  return (
    <div className="wf-statusrules">
      <div className="wf-statusrules__head">
        <span>
          <h4 className="wf-statusrules__title">{status.name}</h4>
          <UsageTriple usage={issueUsage} entityId={status.statusId ?? status.id} totalLabel="issues in it now" compact />
        </span>
        <span className="wf-statusrules__actions">
          <JiraLink className="ui-linkbutton" href={buildStatusAdminUrl(siteOrigin)} title="Open the status list in Jira">Statuses in Jira</JiraLink>
          <AskRovo
            agent="observatory-workflow-expert"
            scope="this status"
            context="the status name and its deletion verdict"
            disabled={!detail?.found}
            buildPrompt={() =>
              buildRovoPrompt({
                task: `Can the status "${status.name}" be retired? Explain what holds it in place and what to do first.`,
                facts: [["Status", status.name], ["Verdict", detail?.verdict || "unknown"], ["Workflows containing it", detail?.workflows?.length ?? "unknown"], ["Schemes reaching it", detail?.schemeCount ?? null]],
              })
            }
          />
          <button type="button" className="ghost-button" onClick={onClose}>Close</button>
        </span>
      </div>

      {!loading && <StatusDetail detail={detail} siteOrigin={siteOrigin} />}

      {loading ? (
        <EmptyState inline>Looking up the rules…</EmptyState>
      ) : !usage?.available ? (
        // "No rule touches this status" is permission to delete it. "We have not looked" is
        // not, and this pillar exists because the two used to be indistinguishable.
        <EmptyState inline>
          No rule export has been imported, so nothing is known about which rules use this status.
        </EmptyState>
      ) : !usage.referenced ? (
        <EmptyState inline>No automation rule references this status.</EmptyState>
      ) : (
        <div className="wf-statusrules__groups">
          {groups.filter((group) => usage[group.key]?.count > 0).map((group) => (
            <section key={group.key} className="wf-statusrules__group">
              <header className="wf-statusrules__grouphead">
                <Chip tone={group.tone}>{group.label}</Chip>
                <span className="wf-statusrules__count">{formatNumber(usage[group.key].count)}</span>
                <p className="wf-statusrules__hint">{group.hint}</p>
              </header>
              <ul className="wf-statusrules__list">
                {usage[group.key].rules.map((rule) => (
                  <li key={`${group.key}-${rule.id}`} className="wf-statusrules__rule">
                    <RuleLink id={rule.id} name={rule.name} siteOrigin={siteOrigin} />
                    {rule.enabled === false && <Chip tone="neutral">disabled</Chip>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* The other source. Kept visually separate from the rules rather than merged into
          them: a rule breaking is loud and a filter breaking is not, and a reader deciding
          whether to delete a status needs to know which kind of breakage they are looking
          at. */}
      {!loading && (
        <section className="wf-statusrules__group wf-statusrules__group--filters">
          <header className="wf-statusrules__grouphead">
            <Chip tone={filters?.total > 0 ? "warning" : "neutral"}>Searched by saved filters</Chip>
            {filters?.available && <span className="wf-statusrules__count">{formatNumber(filters.total)}</span>}
            <p className="wf-statusrules__hint">
              {!filters?.available
                ? "No saved filter inventory has been built, so this is unknown."
                : filters.total === 0
                  ? "No saved filter names this status."
                  : "These keep working if the status is deleted, and quietly return a different set of issues."}
            </p>
          </header>
          {filters?.available && filters.total > 0 && (
            <ul className="wf-statusrules__list">
              {filters.filters.map((filter) => (
                <li key={`filter-${filter.id}`} className="wf-statusrules__rule">
                  <span>{filter.name}</span>
                  {filter.ownerName && <Chip tone="neutral">{filter.ownerName}</Chip>}
                  {filter.subscriptionCount > 0 && (
                    <Chip tone="warning">
                      {formatNumber(filter.subscriptionCount)} subscription{filter.subscriptionCount === 1 ? "" : "s"}
                    </Chip>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

export function WorkflowInsights({ insights, loading, siteOrigin, load = invoke, intent = null }) {
  // Which status the reader has opened, if any. One at a time: this is a drill-down, not a
  // column, and 94 expanded panels is not a page.
  const [openStatus, setOpenStatus] = React.useState(null);

  // Which unreachable statuses to show.
  //
  // One grid used to hold both findings at once: the ones nothing reaches at all and the
  // ones an automation rule holds open. Those are opposite conclusions -- delete versus do
  // not delete -- and the Overview counts them separately, so arriving from either count
  // has to narrow to the statuses that count was about.
  const [statusFilter, setStatusFilter] = React.useState("all");

  useNavIntent(intent, (nav) => {
    setStatusFilter(nav.statuses ?? "all");
    setOpenStatus(null);
  });
  if (loading && !insights) return <EmptyState>Analysing the workflow inventory…</EmptyState>;
  if (!insights) return null;

  if (!insights.available) {
    return (
      <EmptyState>{insights.reason === "error"
          ? "Could not analyse the workflow inventory."
          : "Build the workflow inventory first — these findings are derived from it."}</EmptyState>
    );
  }

  const { summary, duplicateGroups = [], orphans: allOrphans = [], balance = [], hasIssueCounts, schemeStatusesAvailable } = insights;

  const ORPHAN_FILTERS = [
    { key: "all", label: "All unreachable", match: () => true },
    // Nothing reaches them and nothing has ever been in one. The only ones that are
    // actually safe to delete.
    { key: "safe-to-remove", label: "No evidence of use", match: (o) => o.safeToRemove },
    // Unreachable by a scheme, reachable by a rule. Live states no workflow documents.
    { key: "rule-only", label: "Held open by a rule", match: (o) => o.ruleOnly },
  ];
  const activeOrphanFilter = ORPHAN_FILTERS.find((f) => f.key === statusFilter) ?? ORPHAN_FILTERS[0];
  const orphans = allOrphans.filter(activeOrphanFilter.match);

  return (
    <div className="wf-insights">
      {/* The label/hint split is the point of moving to StatTile: these used to concatenate
          "Duplicate groups · 20 statuses removable" into one label, so the count of the thing
          and the consequence of it were typographically identical. */}
      <StatRow>
        <StatTile
          label="Duplicate groups"
          value={formatNumber(summary.duplicateGroupCount)}
          tone={summary.duplicateGroupCount > 0 ? "warning" : "neutral"}
          hint={summary.reducibleStatusCount > 0 ? `${formatNumber(summary.reducibleStatusCount)} statuses removable` : undefined}
        />
        <StatTile
          label="Unreachable statuses"
          value={formatNumber(summary.orphanCount)}
          tone={summary.orphanCount > 0 ? "warning" : "neutral"}
          hint={hasIssueCounts ? `${formatNumber(summary.safeToRemoveCount)} never used` : undefined}
        />
        <StatTile
          label="Schemes with a flag"
          value={formatNumber(summary.flaggedSchemeCount)}
          tone={summary.flaggedSchemeCount > 0 ? "warning" : "neutral"}
        />
      </StatRow>

      {!hasIssueCounts && (
        <p className="wf-insights__note">
          <Icon name="alertTriangle" size={13} />
          <span>
            No issue counts yet. Run a Universe Scan to learn which of these statuses are
            actually in use — until then an unreachable status cannot be confirmed safe to delete.
          </span>
        </p>
      )}

      {!schemeStatusesAvailable && (
        <p className="wf-insights__note">
          <Icon name="alertTriangle" size={13} />
          <span>
            Jira did not return workflow status data on the last build, so unreachable statuses
            and scheme balance cannot be assessed. Rebuilding the inventory usually resolves this.
          </span>
        </p>
      )}

      <Panel title="Duplicate statuses" description="Statuses that almost certainly mean the same thing. Consolidating a group removes every status in it but one.">
        {duplicateGroups.length === 0 ? (
          <EmptyState inline>No duplicate status names found.</EmptyState>
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
      </Panel>

      {schemeStatusesAvailable && (
        <Panel title="Unreachable statuses" description={<>Defined on the site but not reachable from any workflow scheme. {hasIssueCounts && " Those marked never used have no workflow reaching them and no issue history."}</>}>
          {/* The blanket caveat only survives while we genuinely cannot check. Once an
              automation analysis exists, every status here carries its own answer, and a
              warning that applies to all of them would tell a reader nothing about any of
              them -- while sitting next to evidence that contradicts it. */}
          {hasIssueCounts && !insights?.automationChecked && (
            <p className="wf-insights__note">
              <Icon name="info" size={13} />
              <span>
                Automation rules are not included: no rule export has been imported, so a rule
                could still reference a status shown here. Import one on the Automation tab to
                have these checked individually.
              </span>
            </p>
          )}
          {/* Offered only when there is something to narrow to. On a site with no automation
              analysis every orphan is in the same bucket and a filter row would be three
              buttons that all do the same thing. */}
          {allOrphans.length > 0 && insights?.automationChecked && (
            <div className="findings-filter-bar wf-orphan-filters">
              {ORPHAN_FILTERS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  className={`findings-filter-button${statusFilter === option.key ? " findings-filter-button--active" : ""}`}
                  onClick={() => { setStatusFilter(option.key); setOpenStatus(null); }}
                >
                  <span>{option.label}</span>
                  <strong>{formatNumber(allOrphans.filter(option.match).length)}</strong>
                </button>
              ))}
            </div>
          )}

          {orphans.length === 0 ? (
            <EmptyState inline>
              {allOrphans.length === 0
                ? "Every status is reachable from a scheme."
                : `No unreachable status matches "${activeOrphanFilter.label}".`}
            </EmptyState>
          ) : (
            <div className="wf-orphan-grid">
              {orphans.map((orphan) => (
                // safeToRemove now accounts for rule references itself. This used to read
                // `safeToRemove && !automationRuleCount`, which was the model's own rule
                // reimplemented in JSX -- and the health score, reading the unqualified
                // model, disagreed with what this grid showed.
                <div key={orphan.statusId} className={`wf-orphan ${orphan.safeToRemove ? "wf-orphan--safe" : ""}`}>
                  <span className="wf-orphan__name">{orphan.name}</span>
                  {orphan.issueCount === null ? (
                    <span className="wf-orphan__count wf-orphan__count--unknown">usage unknown</span>
                  ) : orphan.issueCount === 0 ? (
                    <span className="wf-orphan__count wf-orphan__count--safe">never used</span>
                  ) : (
                    <span className="wf-orphan__count">{formatNumber(orphan.issueCount)} issues</span>
                  )}
                  {/* The per-status answer. A status no workflow reaches and no issue ever
                      entered still is not safe to delete if a rule transitions into it --
                      which is precisely what the old blanket warning could not tell you. */}
                  {/* The count is the way in, not the answer. "17 rules" tells a reader they
                      cannot delete this status; it does not tell them which rules to look at,
                      or whether any of them transitions issues INTO it. */}
                  {orphan.automationRuleCount > 0 && (
                    <button
                      type="button"
                      className="wf-orphan__count wf-orphan__count--rules"
                      title={`Show the ${orphan.automationRuleCount} rules that reference "${orphan.name}"`}
                      onClick={() => setOpenStatus(openStatus?.statusId === orphan.statusId ? null : orphan)}
                      aria-expanded={openStatus?.statusId === orphan.statusId}
                    >
                      {formatNumber(orphan.automationRuleCount)} {orphan.automationRuleCount === 1 ? "rule" : "rules"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {openStatus && (
            <StatusRulesPanel
              status={openStatus}
              siteOrigin={siteOrigin}
              onClose={() => setOpenStatus(null)}
              load={load}
            />
          )}
        </Panel>
      )}

      {schemeStatusesAvailable && balance.some((entry) => entry.flags.length > 0) && (
        <Panel title="Scheme balance" description="How each scheme&apos;s statuses distribute across Jira&apos;s three categories.">
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
        </Panel>
      )}
    </div>
  );
}


// ── Status distribution charts ──────────────────────────────────────────────
//
// Two questions the catalog list cannot answer at a glance: how the site's statuses split
// across Jira's three categories, and which statuses carry the most abandoned history.
//
// Both are magnitude, so both use one hue with the value labelled on every mark -- identity
// never rests on colour alone. Category is the exception: it is a fixed three-way split
// where the categories are the point, so it gets a stacked bar with a legend.

function CategoryBar({ statuses }) {
  const counts = { "To Do": 0, "In Progress": 0, Done: 0, Uncategorised: 0 };
  for (const status of statuses) {
    const key = counts[status.statusCategory] !== undefined ? status.statusCategory : "Uncategorised";
    counts[key] += 1;
  }
  const total = statuses.length;
  if (!total) return null;

  const segments = [
    { key: "To Do", tone: "todo" },
    { key: "In Progress", tone: "progress" },
    { key: "Done", tone: "done" },
    { key: "Uncategorised", tone: "other" },
  ].filter((seg) => counts[seg.key] > 0);

  return (
    <div className="wf-chart">
      <div className="wf-chart__title">Status categories</div>
      <div className="wf-catbar" role="img"
        aria-label={segments.map((s) => `${counts[s.key]} ${s.key}`).join(", ")}>
        {segments.map((seg) => (
          <span
            key={seg.key}
            className={`wf-catbar__seg wf-catbar__seg--${seg.tone}`}
            style={{ flexGrow: counts[seg.key] }}
            data-tip={`${seg.key}: ${formatNumber(counts[seg.key])}`}
          >
            {counts[seg.key] / total > 0.08 ? formatNumber(counts[seg.key]) : ""}
          </span>
        ))}
      </div>
      <div className="wf-chart__legend">
        {segments.map((seg) => (
          <span key={seg.key} className="wf-chart__legenditem">
            <span className={`wf-chart__swatch wf-chart__swatch--${seg.tone}`} />
            {seg.key} — {formatNumber(counts[seg.key])}
          </span>
        ))}
      </div>
    </div>
  );
}

// Statuses issues passed through and left. This is the finding the "ever been in" measure
// exists to produce, and a ranked bar is the fastest way to see where the volume sits.
function DepartedChart({ statuses }) {
  const ranked = statuses
    .filter((s) => (s.departedCount ?? 0) > 0)
    .sort((a, b) => b.departedCount - a.departedCount)
    .slice(0, 8);
  if (ranked.length === 0) return null;

  const max = Math.max(...ranked.map((s) => s.departedCount), 1);

  return (
    <div className="wf-chart">
      <div className="wf-chart__title">Most passed through, then left</div>
      <p className="wf-chart__desc">
        Issues that entered a status and moved on. Empty now, heavily used before.
      </p>
      <div className="wf-barlist">
        {ranked.map((status) => (
          <div key={status.id} className="wf-barlist__row">
            <span className="wf-barlist__label" title={status.name}>{status.name}</span>
            <span className="wf-barlist__track">
              <span className="wf-barlist__bar" style={{ width: `${(status.departedCount / max) * 100}%` }} />
            </span>
            <span className="wf-barlist__value">{formatNumber(status.departedCount)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function WorkflowTab({ intent = null, siteOrigin = "" }) {
  const [view, setView] = usePersistentState("observatory.section.workflows", "schemes");
  // Arrived from an Overview finding: switch to the view that holds it. The filter within
  // that view belongs to the view, so the intent travels on rather than being unpacked here.
  useNavIntent(intent, (nav) => {
    if (nav.view) setView(nav.view);
  });
  const [insights, setInsights] = React.useState(null);
  const [insightsLoading, setInsightsLoading] = React.useState(false);
  const statusIssueUsage = usePillarUsage("status");
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [building, setBuilding] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [search, setSearch] = React.useState("");
  const [deferredSearch, setDeferredSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [openSchemeId, setOpenSchemeId] = React.useState(null);
  const [statusCategory, setStatusCategory] = React.useState("all");
  const [statusSearch, setStatusSearch] = React.useState("");
  const [statusUsage, setStatusUsage] = React.useState("all");
  const [statusSort, setStatusSort] = React.useState("name");
  const [measuring, setMeasuring] = React.useState(false);
  // The status opened from the Statuses view. Every status gets the drawer, not only the
  // unreachable ones the Insights view lists.
  const [openStatus, setOpenStatus] = React.useState(null);
  const [pillar, setPillar] = React.useState(null);
  React.useEffect(() => {
    if (view !== "insights") return undefined;
    let cancelled = false;
    invoke("getPillarHealth", { pillar: "workflows" })
      .then((result) => { if (!cancelled) setPillar(result?.pillar || null); })
      .catch(() => { if (!cancelled) setPillar(null); });
    return () => { cancelled = true; };
  }, [view]);

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

  // Filters compose by intersection, matching the field browser: each control narrows,
  // none widens. Usage bands are expressed against whichever measures exist -- a status
  // with unknown usage is never classified as "unused", because unknown is not zero.
  const visibleStatuses = React.useMemo(() => {
    const term = statusSearch.trim().toLowerCase();
    let next = statuses;

    if (statusCategory !== "all") {
      next = next.filter((s) => (s.statusCategory || "Uncategorised") === statusCategory);
    }
    if (term) {
      next = next.filter((s) => String(s.name || "").toLowerCase().includes(term));
    }
    if (statusUsage === "active") {
      next = next.filter((s) => (s.issueCount ?? 0) > 0);
    } else if (statusUsage === "empty") {
      // Currently empty but provably used before -- the "people escaped this" signal.
      next = next.filter((s) => s.issueCount === 0 && (s.everCount ?? 0) > 0);
    } else if (statusUsage === "never") {
      // Only assertable when BOTH measures exist and both are zero.
      next = next.filter((s) => s.issueCount === 0 && s.everCount === 0);
    } else if (statusUsage === "unknown") {
      next = next.filter((s) => s.issueCount === null || s.everCount === null);
    }

    const sorted = [...next];
    if (statusSort === "current") sorted.sort((a, b) => (b.issueCount ?? -1) - (a.issueCount ?? -1));
    else if (statusSort === "ever") sorted.sort((a, b) => (b.everCount ?? -1) - (a.everCount ?? -1));
    else if (statusSort === "departed") sorted.sort((a, b) => (b.departedCount ?? -1) - (a.departedCount ?? -1));
    else sorted.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return sorted;
  }, [statuses, statusCategory, statusSearch, statusUsage, statusSort]);

  // Grouped by category so the label is a heading rather than a word repeated on every
  // card. Ordered To Do -> In Progress -> Done, which is the direction work travels.
  const grouped = React.useMemo(() => {
    const order = ["To Do", "In Progress", "Done", "Uncategorised"];
    const buckets = new Map(order.map((k) => [k, []]));
    for (const status of visibleStatuses) {
      const key = buckets.has(status.statusCategory) ? status.statusCategory : "Uncategorised";
      buckets.get(key).push(status);
    }
    return [...buckets.entries()].filter(([, items]) => items.length > 0);
  }, [visibleStatuses]);

  const statusCounts = data?.statusCounts || {};

  const measureHistory = React.useCallback(async () => {
    setMeasuring(true);
    try {
      const res = await invoke("getWorkflowInventory", {
        page, pageSize: PAGE_SIZE, search: deferredSearch, measureHistory: true,
      });
      setData(res);
    } catch (err) {
      setError(err?.message || "Could not start the status history measurement.");
    } finally {
      setMeasuring(false);
    }
  }, [page, deferredSearch]);

  // Sub-nav entries, badged the way every other tab badges them. Insights carries the count
  // of things needing attention rather than a row count -- it is the only view here whose
  // number is a finding rather than an inventory size.
  const navItems = [
    { key: "schemes", label: "Schemes", icon: "activity", badge: formatNumber(data?.totalCount ?? schemes.length) },
    { key: "statuses", label: "Statuses", icon: "layers", badge: formatNumber(statuses.length) },
    // What each workflow enforces. Each view fetches its own data when opened, so none of
    // them costs anything on the schemes view most visits land on.
    { key: "workflow-list", label: "Workflows", icon: "activity" },
    { key: "rules", label: "Transition rules", icon: "shield" },
    { key: "restrictions", label: "Restrictions", icon: "lock" },
    {
      key: "insights",
      label: "Insights",
      icon: "alertTriangle",
      badge: insights?.summary
        ? formatNumber(
          insights.summary.duplicateGroupCount
          + insights.summary.orphanCount
          + insights.summary.flaggedSchemeCount
        )
        : null,
    },
  ];

  // Category chips became a select. They were a fourth control idiom on a page that already
  // had a search box, two selects and a count -- and a chip row that grows with the site is
  // the one control that cannot fit on a narrow screen.
  const statusFilters = [
    {
      key: "usage",
      label: "Usage",
      value: statusUsage,
      onChange: setStatusUsage,
      options: [
        { value: "all", label: "Any usage" },
        { value: "active", label: "Has issues now" },
        { value: "empty", label: "Empty now, used before" },
        { value: "never", label: "Never used" },
        { value: "unknown", label: "Usage unknown" },
      ],
    },
  ];
  if (statusesByCategory.size > 1) {
    statusFilters.push({
      key: "category",
      label: "Category",
      value: statusCategory,
      onChange: setStatusCategory,
      options: [
        { value: "all", label: "All categories" },
        ...[...statusesByCategory.entries()].map(([category, items]) => ({
          value: category, label: category, count: items.length,
        })),
      ],
    });
  }

  return (
    <div className="admin-workflow-tab">
      {/* Was a hand-rolled wf-header at its own size and colour, with freshness inline
          beside the title. Same three parts every other tab has -- title, description,
          freshness, primary action -- so it uses the same component now. */}
      <PageHeader
        title="Workflow & status inventory"
        description="Which workflow schemes exist, which projects each governs, and the full status catalog. Read-only — Observatory reports what is configured; changes stay in Jira's own admin UI."
        meta={snapshot?.refreshedAt ? `Built ${formatRelativeTime(snapshot.refreshedAt)}` : null}
        actions={
          <>
            <AskRovo
              agent="observatory-workflow-expert"
              scope="the workflow estate"
              context="the snapshot age and the current duplicate / unreachable / scheme-balance counts"
              disabled={!snapshot?.version}
              buildPrompt={() =>
                buildRovoPrompt({
                  task: "Give me an overview of this site's workflow and status estate and what to look at first.",
                  facts: [
                    ["Snapshot built", snapshot?.refreshedAt || "unknown"],
                    ["Workflow schemes", snapshot?.totalSchemes ?? null],
                    ["Status catalogue size", insights?.statusTotals?.catalogCount ?? null],
                    ["Near-duplicate status groups", insights?.summary?.duplicateGroupCount ?? null],
                    ["Unreachable statuses", insights?.summary?.reducibleStatusCount ?? insights?.summary?.orphanCount ?? null],
                    ["Schemes flagged for category balance", insights?.summary?.flaggedSchemeCount ?? null],
                  ],
                })
              }
            />
            <button
              className="primary-button"
              type="button"
              onClick={() => load({ forceRefresh: true })}
              disabled={isBuilding || loading}
            >
              <Icon name="refreshCw" size={14} />
              {isBuilding ? "Building…" : snapshot?.version ? "Rebuild" : "Build inventory"}
            </button>
          </>
        }
      />

      {error && <div className="danger-zone__error" role="alert">{error}</div>}
      {snapshot?.lastError && (
        <div className="danger-zone__error">
          <Icon name="alertTriangle" size={13} /> {snapshot.lastError}
        </div>
      )}

      {neverBuilt ? (
        <EmptyState>No workflow inventory yet. Build one to see every workflow scheme on the site and
          the projects each governs.</EmptyState>
      ) : (
        <>
          {/* Sidebar sub-nav, matching Screens, Automation, Scans, Reports and Config.
              This tab was the only one running its sub-navigation as horizontal pills, which
              is why moving between it and any other tab felt like changing product. */}
          <SubNavLayout items={navItems} activeKey={view} onSelect={setView}>
          {view === "insights" ? (
            <>
              <PillarHealthPanel pillar={pillar} />
              <WorkflowInsights insights={insights} loading={insightsLoading} siteOrigin={siteOrigin} intent={intent} />
            </>
          ) : view === "rules" ? (
            <WorkflowRulesView siteOrigin={siteOrigin} intent={intent} />
          ) : view === "restrictions" ? (
            <WorkflowRestrictionsView siteOrigin={siteOrigin} />
          ) : view === "workflow-list" ? (
            <WorkflowCatalogView siteOrigin={siteOrigin} intent={intent} />
          ) : loading ? (
            <EmptyState>Loading…</EmptyState>
          ) : view === "schemes" ? (
            <>
              <SortFilterBar
                search={search}
                onSearchChange={setSearch}
                searchLabel="Search workflow schemes"
                searchPlaceholder="Search schemes…"
                resultCount={data?.totalCount ?? schemes.length}
                totalCount={data?.totalCount ?? schemes.length}
                onClear={() => setSearch("")}
              />

              {schemes.length === 0 ? (
                <EmptyState>{deferredSearch ? `No schemes match “${deferredSearch}”.` : "No workflow schemes found."}</EmptyState>
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
            <>
              <SortFilterBar
                search={statusSearch}
                onSearchChange={setStatusSearch}
                searchLabel="Filter statuses by name"
                searchPlaceholder="Filter statuses…"
                sort={statusSort}
                onSortChange={setStatusSort}
                sortOptions={STATUS_SORT_OPTIONS}
                filters={statusFilters}
                resultCount={visibleStatuses.length}
                totalCount={statuses.length}
                onClear={() => { setStatusSearch(""); setStatusUsage("all"); setStatusCategory("all"); }}
              >
                {/* An action, not a filter, so it sits in the toolbar's slot rather than
                    being mistaken for one of the selects beside it. */}
                <button
                  type="button"
                  className="secondary-button"
                  onClick={measureHistory}
                  disabled={measuring || !snapshot?.version}
                  title="Runs one JQL history query per status. Takes a few minutes; no issue re-scan needed."
                >
                  <Icon name="clock" size={13} />
                  {measuring ? "Queued…" : statusCounts.hasHistoryCounts ? "Re-measure history" : "Measure history"}
                </button>
              </SortFilterBar>

              {!statusCounts.hasCurrentCounts && (
                <p className="wf-insights__note">
                  <Icon name="alertTriangle" size={13} />
                  <span>
                    No current issue counts yet — run a Universe Scan to see how many issues
                    sit in each status today.
                  </span>
                </p>
              )}
              {!statusCounts.hasHistoryCounts && (
                <p className="wf-insights__note">
                  <Icon name="info" size={13} />
                  <span>
                    Historical usage not measured yet. &ldquo;Measure history&rdquo; asks Jira how
                    many issues have <em>ever</em> been in each status — a few minutes, and far
                    cheaper than re-scanning every issue.
                  </span>
                </p>
              )}

              {statuses.length > 0 && (
                <div className="wf-charts">
                  <CategoryBar statuses={statuses} />
                  <DepartedChart statuses={statuses} />
                </div>
              )}

              {/* A key, not decoration. Three bare numbers on 433 cards is unreadable
                  without one, and the em dash for "not measured" is meaningless unless
                  it is spelled out somewhere. */}
              <div className="wf-key">
                <span className="wf-key__group">
                  <span className="wf-key__item"><b>1,234</b> in it now</span>
                  <span className="wf-key__item wf-key__item--muted"><b>1,234</b> ever entered</span>
                  <span className="wf-key__item wf-key__item--departed"><b>−1,234</b> passed through and left</span>
                  <span className="wf-key__item wf-key__item--unknown"><b>—</b> not measured</span>
                </span>
              </div>

              {grouped.map(([category, items]) => (
                <section key={category} className="wf-catgroup">
                  {/* The category becomes a heading instead of a label repeated on every
                      card. Same information, 433 fewer repetitions. */}
                  <h4 className="wf-catgroup__head">
                    <span className={`wf-status__dot wf-status__dot--${CATEGORY_TONE[category] || "other"}`} aria-hidden="true" />
                    {category}
                    <span className="wf-catgroup__count">{formatNumber(items.length)}</span>
                  </h4>
                  <div className="wf-status-grid">
                    {items.map((status) => (
                      <button
                        type="button"
                        key={status.id}
                        className={`wf-status wf-status--button${openStatus?.id === status.id ? " wf-status--open" : ""}`}
                        aria-expanded={openStatus?.id === status.id}
                        onClick={() => setOpenStatus(openStatus?.id === status.id ? null : status)}
                      >
                        <span className="wf-status__name" title={status.name}>{status.name}</span>
                        <span className="wf-status__metrics">
                          {/* Null renders as an em dash, never as 0: an unmeasured status
                              must not look like an unused one. */}
                          <span className="wf-status__metric" title="Issues currently in this status">
                            {status.issueCount === null ? "—" : formatNumber(status.issueCount)}
                          </span>
                          <span className="wf-status__metric wf-status__metric--muted" title="Issues that have ever been in this status">
                            {status.everCount === null ? "—" : formatNumber(status.everCount)}
                          </span>
                          <span className="wf-status__metric wf-status__metric--departed" title="Issues that passed through and left">
                            {status.departedCount > 0 ? `−${formatNumber(status.departedCount)}` : ""}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                  {openStatus && items.some((s) => s.id === openStatus.id) && (
                    <StatusRulesPanel status={openStatus} siteOrigin={siteOrigin} onClose={() => setOpenStatus(null)} issueUsage={statusIssueUsage} />
                  )}
                </section>
              ))}

              {visibleStatuses.length === 0 && (
                <EmptyState>No statuses match these filters.</EmptyState>
              )}
            </>
          )}
          </SubNavLayout>
        </>
      )}
    </div>
  );
}
