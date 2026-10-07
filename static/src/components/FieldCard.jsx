import React from "react";
import { invoke } from "@forge/bridge";
import {
  buildAutomationRovoPrompt,
  buildAutomationRuleUrl,
  buildJiraSearchUrl,
  handleJiraLinkClick,
  isSelectType,
  isUserPickerField,
  isUsageAvailable,
  mergeFieldMetrics,
  toDisplayName,
  formatTimestamp,
  formatNumber,
  copyToClipboard,
} from "../utils";
import { Icon } from "./Icons";
import { AskRovo, Chip, WorkflowUsageList, UsageTriple } from "./ui";
import { FieldOptionsModal } from "./FieldOptionsModal";

// The Rovo affordance is now the shared <AskRovo> from ./ui -- one label shape, one
// tooltip that names the agent and the read-only guarantee, wired at every panel here and
// on every pillar tab. The FieldCard-local button that used to live here is gone.

// A one-line, client-side search box for a panel's own already-fetched list.
//
// Not a resolver call: Automation/Filter/Dashboard usage are scoped to ONE field, so even a
// field referenced by every rule on the site is a few hundred rows already sitting in this
// component's state, not the few-thousand-row estate the Filters and Field Browser tabs had
// to move server-side. Filtering an array already in memory needs no debounce and no round
// trip.
function PanelSearch({ value, onChange, placeholder, matchCount, totalCount }) {
  if (totalCount <= 1) return null;
  return (
    <div className="panel-search">
      <Icon name="search" size={13} />
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        onClick={(event) => event.stopPropagation()}
      />
      {value ? (
        <span className="panel-search__count">{matchCount} of {totalCount}</span>
      ) : null}
    </div>
  );
}

// A detail section that can be folded away.
//
// The expanded card runs to five sections and several screens; on a field with 132 active
// projects the Project Usage list buries everything under it. Only the title toggles --
// the actions beside it are their own buttons, and nesting a button inside a button is
// invalid markup that browsers resolve by dropping one of them.
//
// State is per section and remembered while the card stays open, so collapsing Project
// Usage to read Contexts does not undo itself on the next render.
export function CollapsibleSection({ title, badge, actions, defaultOpen = true, children }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const bodyId = React.useMemo(() => `sect-${Math.random().toString(36).slice(2, 9)}`, []);

  return (
    <section className={`detail-section${open ? "" : " detail-section--collapsed"}`}>
      <div className="section-heading">
        <button
          type="button"
          className="section-heading__toggle"
          onClick={(event) => { event.stopPropagation(); setOpen((v) => !v); }}
          aria-expanded={open}
          aria-controls={bodyId}
        >
          <span className="section-heading__chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
          <h4>{title}</h4>
          {badge != null ? <span className="section-heading__badge">{badge}</span> : null}
        </button>
        {actions ? <div className="section-heading__actions">{actions}</div> : null}
      </div>
      {open ? <div className="detail-section__body" id={bodyId}>{children}</div> : null}
    </section>
  );
}

const AUTOMATION_DIRECTIONS = [
  { key: "write", label: "Writes this field", tone: "danger", consequence: "Deleting the field breaks these rules and loses the values they maintain." },
  { key: "read", label: "Reads this field", tone: "info", consequence: "These rules check the field in a condition and will misbehave without it." },
  { key: "trigger", label: "Triggers on this field", tone: "warn", consequence: "These rules run when the field changes." },
];

// What automation does with one field.
//
// Loaded when the card is expanded rather than with the page: the Field Browser shows ten
// fields at a time and this answer is only wanted for the one being read.
// One rule in an automation usage list.
//
// A link when the site origin is known, plain text when it is not. The origin comes from
// the Forge view context and is occasionally absent; rendering a dead anchor that silently
// does nothing on click is worse than rendering the name.
export function AutomationRuleLink({ rule, siteOrigin }) {
  const href = buildAutomationRuleUrl(siteOrigin, rule.id);
  const label = rule.name || `Rule ${rule.id}`;

  if (!href) return <span className="automation-usage__name">{label}</span>;

  return (
    <a
      className="automation-usage__name automation-usage__name--link"
      href={href}
      target="_blank"
      rel="noreferrer"
      title={`Open "${label}" in Jira automation`}
      onClick={(event) => {
        // Stops the click reaching the card header, which would collapse the whole field.
        event.stopPropagation();
        handleJiraLinkClick(event, href);
      }}
    >
      {label}
    </a>
  );
}

// Which saved filters would silently start returning the wrong answer if this field went
// away.
//
// The second half of the "do not delete this" answer, and the half that was missing. An
// automation rule breaking is loud -- it errors, it shows up in the rule's audit log. A saved
// filter is not: delete a field forty filters search on and every one of them keeps running
// and quietly returns a different set of issues, with no error anywhere and nobody told.
//
// Sits beside Automation Usage rather than inside it, because the two answer the same
// question from different sources and a reader needs to see which one is talking.
export function FilterUsageSection({ field, enabled = true, siteOrigin }) {
  const [state, setState] = React.useState({ loading: true, error: "", data: null });

  React.useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setState({ loading: true, error: "", data: null });
    // Looked up by NAME, because that is how JQL names a field. The id is the fallback for
    // the cf[10001] escape hatch, which getFilterUsage resolves the same way.
    invoke("getFilterUsage", { kind: "field", label: field.name || field.id })
      .then((data) => { if (!cancelled) setState({ loading: false, error: "", data }); })
      .catch((err) => { if (!cancelled) setState({ loading: false, error: err?.message || "Failed to load.", data: null }); });
    return () => { cancelled = true; };
  }, [enabled, field.id, field.name]);

  const { loading, error, data } = state;
  const total = data?.total ?? 0;

  return (
    <CollapsibleSection
      title="Saved Filter Usage"
      badge={data?.available && total > 0 ? `${formatNumber(total)} filter${total === 1 ? "" : "s"}` : null}
    >
      {loading ? (
        <div className="empty-state empty-state--inline">Checking saved filters…</div>
      ) : error ? (
        <div className="empty-state empty-state--inline">Could not check saved filters. {error}</div>
      ) : !data?.available ? (
        // Never phrased as "no filter uses this field". Nothing has been built, so the honest
        // answer is that nobody has looked -- which is not permission to delete anything.
        <div className="empty-state empty-state--inline">
          No saved filter inventory has been built, so filter usage is unknown for this field.
          Build one on the Saved Filters tab to find out.
        </div>
      ) : total === 0 ? (
        <div className="empty-state empty-state--inline">
          No saved filter searches on, or sorts by, this field.
        </div>
      ) : (
        <>
          <p className="ui-note">
            <Icon name="alertTriangle" size={13} />
            <span>
              These searches would keep running if this field were deleted, and quietly return
              a different set of issues. Nothing errors and nobody is told.
            </span>
          </p>
          <ul className="filter-usage__list">
            {data.filters.map((filter) => {
              const href = siteOrigin ? `${siteOrigin}/issues/?filter=${filter.id}` : null;
              return (
                <li key={filter.id} className="filter-usage__item">
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => handleJiraLinkClick(event, href)}
                      title="Open this filter in Jira"
                    >
                      {filter.name}
                    </a>
                  ) : (
                    <span>{filter.name}</span>
                  )}
                  {filter.ownerName && (
                    <span className="filter-usage__owner">
                      {filter.ownerName}{filter.ownerActive === false ? " · inactive" : ""}
                    </span>
                  )}
                  {/* A subscription makes the silent failure louder in the worst way: the
                      wrong answer gets emailed on a schedule. */}
                  {filter.subscriptionCount > 0 && (
                    <span className="filter-usage__subs">
                      {formatNumber(filter.subscriptionCount)} subscription{filter.subscriptionCount === 1 ? "" : "s"}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {data.filters.length < total && (
            <div className="ui-truncation">
              Showing {formatNumber(data.filters.length)} of {formatNumber(total)} references.
            </div>
          )}
        </>
      )}
    </CollapsibleSection>
  );
}

// Which dashboards break if this field goes.
//
// The chain is field -> the filters whose JQL names it -> the gadgets configured to show those
// filters -> the dashboards those gadgets sit on. Every leg is an exact join. The cheap version
// of this feature would match gadget titles against filter names, which is right most of the
// time -- and "most of the time" is not a basis for deleting a field, because the case it gets
// wrong is the one where somebody's wall-screen goes blank on Monday.
export function DashboardUsageSection({ field, enabled = true, siteOrigin }) {
  const [state, setState] = React.useState({ loading: true, error: "", data: null });

  React.useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setState({ loading: true, error: "", data: null });
    // By NAME, like the filter lookup: the join runs through JQL, and JQL names fields.
    invoke("getDashboardUsage", { label: field.name || field.id })
      .then((data) => { if (!cancelled) setState({ loading: false, error: "", data }); })
      .catch((err) => { if (!cancelled) setState({ loading: false, error: err?.message || "Failed to load.", data: null }); });
    return () => { cancelled = true; };
  }, [enabled, field.id, field.name]);

  const { loading, error, data } = state;
  const total = data?.total ?? 0;

  // Which half is missing changes what an admin has to do about it, so they are not collapsed
  // into one "unavailable".
  const missing = data?.reason === "no-dashboard-inventory"
    ? "No dashboard inventory has been built, so dashboard usage is unknown for this field. Build one on the Dashboards tab."
    : data?.reason === "no-filter-inventory"
      ? "Dashboards reach fields through saved filters, and no filter inventory has been built. Build one on the Saved Filters tab."
      : null;

  return (
    <CollapsibleSection
      title="Dashboard Usage"
      badge={data?.available && total > 0 ? `${formatNumber(total)} dashboard${total === 1 ? "" : "s"}` : null}
    >
      {loading ? (
        <div className="empty-state empty-state--inline">Checking dashboards…</div>
      ) : error ? (
        <div className="empty-state empty-state--inline">Could not check dashboards. {error}</div>
      ) : missing ? (
        // Never "no dashboard uses this field". Nobody has looked, and that is not permission
        // to delete anything.
        <div className="empty-state empty-state--inline">{missing}</div>
      ) : !data?.available ? (
        <div className="empty-state empty-state--inline">Dashboard usage is unknown for this field.</div>
      ) : total === 0 ? (
        <div className="empty-state empty-state--inline">
          {data.complete
            ? "No dashboard gadget shows a filter that uses this field."
            : "No dashboard found so far — but the gadget configuration walk has not finished, so this is not yet a complete answer."}
        </div>
      ) : (
        <>
          <p className="ui-note">
            <Icon name="alertTriangle" size={13} />
            <span>
              These dashboards render through a filter that names this field. Delete the field
              and the gadget keeps rendering — against a different set of issues.
            </span>
          </p>
          <ul className="filter-usage__list">
            {data.dashboards.map((dash) => {
              const href = dash.viewUrl || (siteOrigin ? `${siteOrigin}/jira/dashboards/${dash.id}` : null);
              return (
                <li key={dash.id} className="filter-usage__item">
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => handleJiraLinkClick(event, href)}
                      title="Open this dashboard in Jira"
                    >
                      {dash.name || `Dashboard ${dash.id}`}
                    </a>
                  ) : (
                    <span>{dash.name || `Dashboard ${dash.id}`}</span>
                  )}
                  {dash.ownerName && <span className="filter-usage__owner">{dash.ownerName}</span>}
                  {/* WHERE on the dashboard, not just which dashboard. "Sprint Health" tells a
                      reader what to look at in a way the dashboard name alone does not. */}
                  <span className="filter-usage__subs">
                    via {dash.via.map((v) => v.gadgetTitle || v.filterName || "a gadget").slice(0, 3).join(", ")}
                    {dash.via.length > 3 ? ` +${dash.via.length - 3} more` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
          {!data.complete && (
            <div className="ui-truncation">
              The gadget configuration walk reached {formatNumber(data.coverage?.walked ?? 0)} of{" "}
              {formatNumber(data.coverage?.total ?? 0)} gadgets, so there may be more.
            </div>
          )}
        </>
      )}
    </CollapsibleSection>
  );
}

export function AutomationUsageSection({ field, enabled = true, siteOrigin, rovoEnabled = false }) {
  const [state, setState] = React.useState({ loading: true, error: "", data: null });

  React.useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setState({ loading: true, error: "", data: null });
    invoke("getAutomationFieldUsage", { fieldId: field.id, fieldName: field.name })
      .then((data) => { if (!cancelled) setState({ loading: false, error: "", data }); })
      .catch((err) => { if (!cancelled) setState({ loading: false, error: err?.message || "Failed to load.", data: null }); });
    return () => { cancelled = true; };
  }, [enabled, field.id, field.name]);

  const { loading, error, data } = state;
  const total = data?.referenced
    ? (data.write?.count ?? 0) + (data.read?.count ?? 0) + (data.trigger?.count ?? 0)
    : 0;

  return (
    // Deliberately not collapsed-when-unreferenced: `defaultOpen` seeds useState on the
    // first render, when the fetch has not returned and `referenced` is still unknown, so
    // keying it to the data would leave the section permanently shut. Always open, and one
    // line of text when nothing uses the field.
    <CollapsibleSection
      title="Automation Usage"
      badge={data?.referenced ? `${formatNumber(total)} rule${total === 1 ? "" : "s"}` : null}
      actions={
        <AskRovo
          agent="observatory-field-expert"
          scope="automation on this field"
          context="which rules write, read or trigger on this field"
          disabled={!rovoEnabled || loading}
          buildPrompt={() => buildAutomationRovoPrompt(field, data)}
        />
      }
    >
      {loading ? (
        <div className="empty-state empty-state--inline">Checking automation rules…</div>
      ) : error ? (
        <div className="empty-state empty-state--inline">Could not check automation rules. {error}</div>
      ) : !data?.available ? (
        // Never phrased as "no rules use this field". No analysis has been built, so the
        // honest answer is that nobody has looked.
        <div className="empty-state empty-state--inline">
          No automation analysis has been built, so automation usage is unknown for this field.
          Import a rule export on the Automation tab to find out.
        </div>
      ) : !data.referenced ? (
        <div className="empty-state empty-state--inline">
          No automation rule reads, writes or triggers on this field.
        </div>
      ) : (
        <div className="automation-usage">
          {AUTOMATION_DIRECTIONS.map(({ key, label, tone, consequence }) => {
            const group = data[key];
            if (!group?.count) return null;
            return (
              <div className={`automation-usage__group automation-usage__group--${tone}`} key={key}>
                <div className="automation-usage__head">
                  <strong>{label}</strong>
                  <FindingBadge label={`${formatNumber(group.count)} rule${group.count === 1 ? "" : "s"}`} tone={tone} />
                </div>
                <p className="automation-usage__consequence">{consequence}</p>
                <ul className="automation-usage__rules">
                  {group.rules.map((rule) => (
                    <li key={`${key}-${rule.id}`} className={rule.enabled === false ? "automation-usage__rule automation-usage__rule--disabled" : "automation-usage__rule"}>
                      <AutomationRuleLink rule={rule} siteOrigin={siteOrigin} />
                      {rule.enabled === false ? <span className="automation-usage__state">disabled</span> : null}
                    </li>
                  ))}
                </ul>
                {group.count > group.rules.length ? (
                  <div className="automation-usage__truncation">
                    Showing {group.rules.length} of {formatNumber(group.count)}.
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </CollapsibleSection>
  );
}

// Where a workflow validates, checks or writes this field: which transition, between which
// statuses, and which rule. The question an admin asks before deleting, renaming or retyping
// a field, and until the workflow snapshot kept transition rules it had no answer anywhere.
export function WorkflowRulesSection({ field, enabled = true, siteOrigin }) {
  const [result, setResult] = React.useState(null);

  React.useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setResult(null);
    invoke("getWorkflowRuleUsage", { refType: "field", refId: field.id })
      .then((data) => { if (!cancelled) setResult(data); })
      // A failed lookup is "unknown", never "no rule uses this".
      .catch(() => { if (!cancelled) setResult({ available: false, reason: "error" }); });
    return () => { cancelled = true; };
  }, [enabled, field.id]);

  const count = result?.available ? result.total : null;
  return (
    <CollapsibleSection
      title="Workflow Rules"
      badge={count ? `${formatNumber(count)} in ${formatNumber(result.workflowCount)} workflow${result.workflowCount === 1 ? "" : "s"}` : null}
    >
      <WorkflowUsageList
        result={result}
        siteOrigin={siteOrigin}
        emptyMessage="No workflow validator, condition, post-function or status property names this field."
      />
    </CollapsibleSection>
  );
}

// What every field scheme (or legacy field configuration) does to this field: where it is
// required, hidden or described, and -- on field schemes -- which projects do not have it at
// all. The other half of "what does Jira enforce on this field", beside the workflow rules.
export function FieldBehaviourSection({ field, enabled = true }) {
  const [result, setResult] = React.useState(null);

  React.useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setResult(null);
    invoke("getFieldBehaviour", { fieldId: field.id })
      .then((data) => { if (!cancelled) setResult(data); })
      .catch(() => { if (!cancelled) setResult({ available: false, reason: "error" }); });
    return () => { cancelled = true; };
  }, [enabled, field.id]);

  const legacy = result?.source === "field-configurations";
  const badge = result?.available
    ? [result.requiredIn ? `required in ${formatNumber(result.requiredIn)}` : null,
      legacy && result.hiddenIn ? `hidden in ${formatNumber(result.hiddenIn)}` : null,
      !legacy && result.missingFrom?.length ? `absent from ${formatNumber(result.missingFrom.length)}` : null].filter(Boolean).join(" · ") || null
    : null;

  return (
    <CollapsibleSection title={legacy ? "Field Configurations" : "Field Schemes"} badge={badge}>
      {!result ? (
        <div className="empty-state empty-state--inline">Checking field schemes…</div>
      ) : !result.available ? (
        <div className="empty-state empty-state--inline">
          No field scheme inventory has been built, so where this field is required or hidden is unknown.
        </div>
      ) : !result.owners?.length ? (
        <div className="empty-state empty-state--inline">No field scheme or configuration in use mentions this field.</div>
      ) : (
        <>
          {legacy && result.conflicts?.length > 0 && (
            <div className="danger-zone__error" role="alert">
              Required but hidden in {result.conflicts.map((c) => c.name).join(", ")}. Nobody can fill it in there, so creating or editing those issues fails.
            </div>
          )}
          <ul className="ui-wfusage">
            {result.owners.map((owner) => (
              <li key={owner.id} className="ui-wfusage__row">
                <span className="ui-wfusage__workflow">{owner.name}</span>
                <span className="ui-wfusage__where">
                  <span className="ui-transition__path">
                    {owner.ownerKind === "scheme"
                      ? `${formatNumber(owner.projectCount)} project${owner.projectCount === 1 ? "" : "s"}${owner.projectKeys?.length ? `: ${owner.projectKeys.join(", ")}` : ""}`
                      : owner.routes?.length ? owner.routes.map((r) => `${r.schemeName} (${r.workTypeName})`).join("; ") : "No scheme routes to it"}
                  </span>
                </span>
                <span className="ui-wfusage__what">
                  {owner.measured === false ? (
                    <Chip>not read</Chip>
                  ) : owner.associated === false ? (
                    <Chip tone="warning" title="Projects on this scheme do not have the field at all">not in this scheme</Chip>
                  ) : (
                    <>
                      <Chip tone={owner.required ? "warning" : "neutral"}>{owner.required ? "required" : "optional"}</Chip>
                      {owner.hidden && <Chip tone={owner.required ? "critical" : "neutral"}>hidden</Chip>}
                      {owner.restrictedTo?.length > 0 && <Chip title="Only these work types have the field">{`only ${owner.restrictedTo.join(", ")}`}</Chip>}
                      {(owner.overrides || []).map((o) => (
                        <Chip key={o.workTypeName}>{`${o.workTypeName}: ${o.required ? "required" : "optional"}`}</Chip>
                      ))}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </CollapsibleSection>
  );
}

// Which screens carry this field, and where on them.
//
// Position is kept, not just membership. A field sitting on the fourth tab of a screen is
// present but effectively invisible to the people filling the form, and "on 6 screens" hides
// that entirely -- so each row states the tab it lives on and its place in the order.
export function ScreenUsageSection({ result, loading }) {
  const rows = result?.screens || [];

  return (
    <CollapsibleSection
      title="Screen Usage"
      badge={result?.available ? `${formatNumber(rows.length)} screen${rows.length === 1 ? "" : "s"}` : null}
    >
      {loading ? (
        <div className="empty-state empty-state--inline">Loading screen usage…</div>
      ) : !result?.available ? (
        // The tri-state again. Never "this field is on no screen" when the truth is that
        // nobody has looked -- that sentence is the premise for deleting the field.
        <div className="empty-state empty-state--inline">
          {result?.reason || "No screen inventory has been built yet."} Build it from the Screens tab to see which forms carry this field.
        </div>
      ) : rows.length === 0 ? (
        <div className="empty-state empty-state--inline">
          No screen carries this field, so no user can fill it through a form.
          {result.unresolvedScreens > 0
            ? ` ${formatNumber(result.unresolvedScreens)} screen${result.unresolvedScreens === 1 ? "" : "s"} could not be read in the last build, so this is not conclusive.`
            : " Automation and integrations can still write to it."}
        </div>
      ) : (
        <>
          <div className="screen-usage-list">
            {rows.map((row) => (
              <div className="screen-usage-row" key={`${row.screenId}:${row.tabId}`}>
                <div className="screen-usage-row__name">
                  <strong>{row.screenName}</strong>
                  <span className="screen-usage-row__id">{row.screenId}</span>
                </div>
                <div className="screen-usage-row__meta">
                  <MetricChip label="Tab" value={row.tabIndex + 1} tone={row.tabIndex > 0 ? "warm" : "neutral"} />
                  <MetricChip label="Position" value={row.fieldIndex + 1} />
                </div>
              </div>
            ))}
          </div>
          {result.unresolvedScreens > 0 && (
            <p className="screen-usage-note">
              {formatNumber(result.unresolvedScreens)} screen{result.unresolvedScreens === 1 ? "" : "s"} could not be read
              in the last build, so this list may be incomplete.
            </p>
          )}
        </>
      )}
    </CollapsibleSection>
  );
}

// "Is this field safe to delete" -- every pillar's evidence, in one answer.
//
// The sections above each hold a piece of this and none settles it. Before this existed the
// only way to reach a verdict was to read five of them and hold the result in your head,
// which is exactly the manual cross-referencing the product exists to replace.
//
// Deliberately behind a button rather than loaded on expand: it reads five pillars, and most
// card opens are not a deletion decision.
export function DeletionSafetySection({ field }) {
  const [state, setState] = React.useState({ idle: true });

  const run = async () => {
    setState({ loading: true });
    try {
      const result = await invoke("getDeletionSafety", { fieldIds: [field.id] });
      setState({ result: result?.fields?.[0] || null, available: result?.available, reason: result?.reason });
    } catch (err) {
      setState({ error: err?.message || "The check could not be run." });
    }
  };

  const verdictTone = { "in-use": "danger", "no-evidence-of-use": "success", unknown: "warm" };

  return (
    <CollapsibleSection title="Deletion safety" defaultOpen={false}>
      {state.idle && (
        <div className="empty-state empty-state--inline">
          <button type="button" className="secondary-button" onClick={run}>Check what depends on this field</button>
        </div>
      )}
      {state.loading && <div className="empty-state empty-state--inline">Reading every pillar…</div>}
      {state.error && <div className="empty-state empty-state--inline">{state.error}</div>}
      {state.available === false && <div className="empty-state empty-state--inline">{state.reason}</div>}

      {state.result && (
        <>
          <div className="deletion-safety__verdict">
            <MetricChip
              label="Verdict"
              value={state.result.verdict === "in-use" ? "In use" : state.result.verdict === "unknown" ? "Unknown" : "No evidence of use"}
              tone={verdictTone[state.result.verdict] || "neutral"}
            />
            <span className="deletion-safety__headline">{state.result.headline}</span>
          </div>

          {state.result.blockers.length > 0 && (
            <ul className="deletion-safety__list">
              {state.result.blockers.map((b, i) => (
                <li key={`${b.source}-${i}`} className={`deletion-safety__item deletion-safety__item--${b.severity}`}>
                  <strong>{b.summary}</strong> {b.detail}
                </li>
              ))}
            </ul>
          )}

          {/* Gaps, never folded into the blockers. "We looked and found nothing" and "we
              could not look" are the two claims this whole report exists to keep apart. */}
          {state.result.gaps.length > 0 && (
            <>
              <p className="deletion-safety__subhead">Could not be checked</p>
              <ul className="deletion-safety__list">
                {state.result.gaps.map((g, i) => (
                  <li key={`${g.source}-${i}`} className="deletion-safety__item deletion-safety__item--gap">{g.reason}</li>
                ))}
              </ul>
            </>
          )}

          <p className="deletion-safety__caveat">{state.result.caveat}</p>
        </>
      )}
    </CollapsibleSection>
  );
}

// Which issue types actually carry a value for this field, from the last full issue crawl.
// The third axis next to Screen Usage (where it *can* be filled) and Project Usage (where it
// *is* filled): a field on a screen for types no issue of that type populates is configured
// wider than it is used.
export function IssueTypeUsageSection({ usage }) {
  const rows = Array.isArray(usage) ? usage : null;
  const max = rows && rows.length ? Math.max(...rows.map((r) => r.issueCount || 0), 1) : 1;

  return (
    <CollapsibleSection
      title="Issue Type Usage"
      badge={rows && rows.length ? `${formatNumber(rows.length)} type${rows.length === 1 ? "" : "s"}` : null}
    >
      {!rows || rows.length === 0 ? (
        // Tri-state, same as Screen Usage: an empty list is "the crawl has not measured this
        // yet", never "this field is used on no issue type".
        <div className="empty-state empty-state--inline">
          The issue crawl has not recorded which issue types carry this field yet. Run a full
          scan to populate it.
        </div>
      ) : (
        <div className="screen-usage-list">
          {rows.map((row) => (
            <div className="screen-usage-row" key={row.issueTypeId}>
              <div className="screen-usage-row__name">
                <strong>{row.issueTypeName}</strong>
              </div>
              <div className="screen-usage-row__meta" style={{ alignItems: "center", gap: 10 }}>
                <div className="status-progress__bar" aria-hidden="true" style={{ width: 120 }}>
                  <span style={{ width: `${Math.max(3, Math.round(((row.issueCount || 0) / max) * 100))}%` }} />
                </div>
                <MetricChip label="issues" value={formatNumber(row.issueCount || 0)} />
              </div>
            </div>
          ))}
        </div>
      )}
    </CollapsibleSection>
  );
}

// The cross-pillar join with People: which real people hold a value in this field, from
// the last full crawl. Only shows for user-picker fields (and assignee/reporter) -- for
// anything else the crawl records nothing and this renders the "not a user field" note.
export function PeopleUsageSection({ usage }) {
  const data = usage && typeof usage === "object" ? usage : null;
  const top = data?.top || [];
  const max = top.length ? Math.max(...top.map((r) => r.issueCount || 0), 1) : 1;

  return (
    <CollapsibleSection
      title="People in this field"
      badge={data && data.distinctUsers ? `${formatNumber(data.distinctUsers)} distinct` : null}
    >
      {!data || data.distinctUsers === 0 ? (
        <div className="empty-state empty-state--inline">
          The crawl has recorded no user values for this field. Either it is not a user
          picker, or a full scan has not run since this measurement was added.
        </div>
      ) : (
        <>
          <div className="screen-usage-list">
            {top.map((row) => (
              <div className="screen-usage-row" key={row.accountId}>
                <div className="screen-usage-row__name">
                  <strong>{row.displayName || row.accountId}</strong>
                  {row.onRoster === false && <MetricChip label="" value="not licensed" tone="danger" />}
                </div>
                <div className="screen-usage-row__meta" style={{ alignItems: "center", gap: 10 }}>
                  <div className="status-progress__bar" aria-hidden="true" style={{ width: 120 }}>
                    <span style={{ width: `${Math.max(3, Math.round(((row.issueCount || 0) / max) * 100))}%` }} />
                  </div>
                  <MetricChip label="issues" value={formatNumber(row.issueCount || 0)} />
                </div>
              </div>
            ))}
          </div>
          {data.distinctUsers > top.length && (
            <p className="ui-truncation">Showing the top {top.length} of {formatNumber(data.distinctUsers)} people.</p>
          )}
        </>
      )}
    </CollapsibleSection>
  );
}

export function MetricChip({ label, value, tone = "neutral" }) {
  return (
    <div className={`metric-chip metric-chip--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

// The field id itself, clickable to copy. The id text always stays visible — the copy
// affordance is the icon beside it, not a control that stands in for the value.
//
// Rendered as a role="button" span rather than a real <button> because it sits inside the
// card-header <button> that toggles the panel, and nesting buttons is invalid HTML. Click
// and keyboard activation both stopPropagation so copying never also expands the card.
export function CopyableFieldId({ fieldId }) {
  const [state, setState] = React.useState("idle"); // idle | copied | failed
  const timerRef = React.useRef(null);

  React.useEffect(() => () => clearTimeout(timerRef.current), []);

  async function copy(event) {
    event.stopPropagation();
    event.preventDefault();
    const ok = await copyToClipboard(fieldId);
    setState(ok ? "copied" : "failed");
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setState("idle"), 1500);
  }

  return (
    <span
      role="button"
      tabIndex={0}
      className={`copy-field-id copy-field-id--${state}`}
      title={`Copy field ID ${fieldId}`}
      aria-label={`Copy field ID ${fieldId}`}
      onClick={copy}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") copy(event);
      }}
    >
      <span className="copy-field-id__value">{fieldId}</span>
      <Icon name={state === "copied" ? "check" : "copy"} size={11} />
      {/* Success is carried by the icon swap and color alone so the id never shifts on the
          happy path; a failure is rare enough that the layout cost of saying so is worth it. */}
      {state === "failed" ? <span className="copy-field-id__note">Copy failed</span> : null}
      <span className="sr-only" role="status" aria-live="polite">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : ""}
      </span>
    </span>
  );
}

const FINDING_BADGE_ICON = { danger: "alertTriangle", warn: "scissors", info: "info", neutral: "alertCircle" };

export function FindingBadge({ label, tone }) {
  return (
    <span className={`finding-badge finding-badge--${tone}`}>
      <Icon name={FINDING_BADGE_ICON[tone] || "alertCircle"} size={12} />
      {label}
    </span>
  );
}

// Always renders the strip, even with nothing to show in it -- a card with a finding and a
// card with none must reserve the same row, or the two read as different heights in a list
// purely because one of them had something to flag. .findings-strip's own min-height is what
// does the reserving; this only has to make sure the element exists to receive it.
export function FindingsStrip({ findings }) {
  const tags = findings?.tags || {};

  return (
    <div className="findings-strip">
      {tags.adminAttention ? <FindingBadge label="Admin Attention" tone="danger" /> : null}
      {tags.risky ? <FindingBadge label="Risk" tone="danger" /> : null}
      {tags.cleanup ? <FindingBadge label="Cleanup" tone="warn" /> : null}
      {tags.standardize ? <FindingBadge label="Standardize" tone="info" /> : null}
    </div>
  );
}

export function ProjectUsageBuildBadge({ field }) {
  const totalIssueCount = Number(field?.totalIssueCount || 0);
  // Absent is unknown, not unbuilt. The old `|| "unbuilt"` turned a missing value into a
  // definite claim, which is the one thing the rest of this app is careful never to do.
  const state = field?.projectUsageState || null;

  if (totalIssueCount <= 0) {
    return null;
  }
  if (field?.projectUsageBuilt || state === "ready") {
    return null;
  }
  // The contradiction this fixes: a card reading "Usage Not Built" beside "128 active
  // projects" and "303,233 issues with value". Those counts come from the snapshot, which
  // has measured the usage; the badge was reporting on the separate per-field summary job.
  // Two different questions, and only one of them was in the label -- so the badge said the
  // opposite of the numbers sitting next to it, then vanished on expand when the details
  // payload supplied a state the collapsed row never had.
  if (Number(field?.activeProjectCount || 0) > 0) {
    return null;
  }
  if (!state) {
    return null;
  }
  if (state === "queued" || state === "building") {
    return <FindingBadge label="Usage Building" tone="info" />;
  }
  if (state === "failed" || state === "cancelled") {
    return <FindingBadge label="Usage Incomplete" tone="warn" />;
  }
  return <FindingBadge label="Usage Not Built" tone="neutral" />;
}

export function SkeletonFieldCard() {
  return (
    <div className="skel-field-card">
      <div className="skel-field-card__title">
        <div className="skel" style={{ height: 10, width: "35%" }} />
        <div className="skel" style={{ height: 18, width: "70%" }} />
        <div className="skel" style={{ height: 12, width: "90%" }} />
        <div className="skel" style={{ height: 12, width: "60%" }} />
      </div>
      <div className="skel-field-card__meta">
        <div className="skel" style={{ height: 52 }} />
        <div className="skel" style={{ height: 52 }} />
        <div className="skel" style={{ height: 52 }} />
      </div>
      <div className="skel" style={{ width: 28, height: 28, borderRadius: "50%" }} />
    </div>
  );
}

export function SkeletonProjectItem() {
  return (
    <div className="skel-project-item">
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div className="skel" style={{ height: 14, width: "30%" }} />
        <div className="skel" style={{ height: 14, width: "25%" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div className="skel" style={{ height: 12, width: "55%" }} />
        <div className="skel" style={{ height: 12, width: "20%" }} />
      </div>
    </div>
  );
}

const INLINE_OPTIONS_COLLAPSE_THRESHOLD = 10;

export function InlineOptionsContext({ ctx }) {
  const activeOptions = ctx.options.filter((o) => !o.disabled);
  const disabledOptions = ctx.options.filter((o) => o.disabled);
  const total = ctx.options.length;
  const [expanded, setExpanded] = React.useState(total <= INLINE_OPTIONS_COLLAPSE_THRESHOLD);

  const visibleActive = expanded ? activeOptions : activeOptions.slice(0, INLINE_OPTIONS_COLLAPSE_THRESHOLD);
  const hiddenCount = total - INLINE_OPTIONS_COLLAPSE_THRESHOLD;

  if (ctx.fetchError) {
    return (
      <div className="inline-options">
        <div className="inline-options__header">
          <span className="inline-options__ctx-name">{ctx.contextName}{ctx.isGlobalContext ? " (global)" : ""}</span>
          <span className="field-options-modal__option-chip">{total} option{total !== 1 ? "s" : ""}</span>
        </div>
        <div className="empty-state empty-state--inline" style={{ color: "var(--danger, #c0392b)", padding: "6px 0" }}>
          Failed to load: {ctx.fetchError}
        </div>
      </div>
    );
  }

  return (
    <div className="inline-options">
      <div className="inline-options__header">
        <span className="inline-options__ctx-name">{ctx.contextName}{ctx.isGlobalContext ? " (global)" : ""}</span>
        <span className="field-options-modal__option-chip">{total} option{total !== 1 ? "s" : ""}</span>
      </div>
      <div className="inline-options__chips">
        {visibleActive.map((opt) => (
          <span key={opt.id} className="inline-options__chip">{opt.value}</span>
        ))}
        {expanded && disabledOptions.map((opt) => (
          <span key={opt.id} className="inline-options__chip inline-options__chip--disabled">{opt.value}</span>
        ))}
        {!expanded && hiddenCount > 0 && (
          <button
            type="button"
            className="inline-options__more"
            onClick={() => setExpanded(true)}
          >
            +{hiddenCount} more
          </button>
        )}
        {expanded && total > INLINE_OPTIONS_COLLAPSE_THRESHOLD && (
          <button
            type="button"
            className="inline-options__more"
            onClick={() => setExpanded(false)}
          >
            Show less
          </button>
        )}
      </div>
    </div>
  );
}

export function FieldCard({
  field,
  details,
  expanded,
  loading,
  selected,
  onSelectChange,
  onToggle,
  onProjectUsagePageChange,
  onRefreshProjectUsage,
  onAskField,
  onAskProject,
  siteOrigin,
  rovoEnabled,
  showGovernance = true,
  automationCounts,
  screenCount,
  filterCount,
  dashboardGadgetCount,
  screenSnapshot,
  // Admin only (getPillarUsage("field")); the macro never passes it.
  usage = null,
}) {
  const displayField = React.useMemo(() => mergeFieldMetrics(field, details), [field, details]);
  // Falls back through the details payload rather than trusting it to carry the key.
  //
  // The bug this fixes: expanding a card blanked the count. Collapsed, the value came from
  // the field row; expanded, the ternary switched to details.configuredProjectCount and
  // rendered nothing at all when that key was absent -- so opening a card to learn more
  // about it removed a number that had been on screen a moment earlier.
  const configuredProjectsValue = details?.configuredProjectCount
    ?? details?.field?.configuredProjectCount
    ?? field.configuredProjectCount
    ?? field.usageCount
    ?? 0;
  const fieldIsSelectType = isSelectType(field.type);
  const [fieldOptions, setFieldOptions] = React.useState(null);
  const [fieldOptionsLoading, setFieldOptionsLoading] = React.useState(false);
  const [contextOptionsOpen, setContextOptionsOpen] = React.useState(false);

  // Which screens carry this field, loaded on expand rather than with the page.
  //
  // The header chip needs only a count and gets it from the page-wide batch; this is the
  // list behind it, and it is one query per open card. Fetching it for fifty collapsed
  // cards would read the field table fifty times to render nothing.
  const [screens, setScreens] = React.useState(null);
  const [screensLoading, setScreensLoading] = React.useState(false);
  React.useEffect(() => {
    if (!expanded || screens) return undefined;
    let cancelled = false;
    setScreensLoading(true);
    invoke("getFieldScreenReachability", { fieldId: field.id })
      .then((result) => { if (!cancelled) { setScreens(result); setScreensLoading(false); } })
      .catch(() => { if (!cancelled) { setScreens({ available: false, reason: "Screen usage could not be loaded.", screens: [] }); setScreensLoading(false); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, field.id]);
  React.useEffect(() => {
    if (!expanded || !fieldIsSelectType || fieldOptions) return;
    let cancelled = false;
    setFieldOptionsLoading(true);
    invoke("getFieldOptions", { fieldId: field.id, projectKeys: [] })
      .then((result) => { if (!cancelled) { setFieldOptions(result); setFieldOptionsLoading(false); } })
      .catch(() => { if (!cancelled) { setFieldOptionsLoading(false); } });
    return () => { cancelled = true; };
  }, [expanded, field.id, fieldIsSelectType]);
  const usageSource = details?.field || details || displayField;
  const usageAvailable = isUsageAvailable(usageSource);
  const totalIssuesValue = usageAvailable ? (details ? details.totalIssueCount : (field.totalIssueCount ?? 0)) : "Unavailable";
  const activeProjectsValue = usageAvailable ? (details ? details.activeProjectCount : (field.activeProjectCount ?? 0)) : "Unavailable";
  const fieldFindings = details?.findings || details?.field?.findings || field.findings;

  const hasDanger = showGovernance && (fieldFindings?.tags?.adminAttention || fieldFindings?.tags?.risky);
  const hasWarn = showGovernance && !hasDanger && (fieldFindings?.tags?.cleanup || fieldFindings?.tags?.standardize);
  const severityClass = hasDanger ? "field-card--has-danger" : hasWarn ? "field-card--has-warn" : "";

  return (
    <article className={`field-card ${expanded ? "field-card--open" : ""} ${severityClass}`}>
      <button className={`field-card__header${loading ? " field-card__header--loading" : ""}`} onClick={onToggle} type="button">
        <div className="field-card__title-wrap">
          <label className="field-card__checkbox-label" title="Select for report" onClick={(event) => event.stopPropagation()}>
            <input
              type="checkbox"
              checked={selected}
              onChange={(event) => onSelectChange(field.id, event.target.checked)}
            />
            Select for report
          </label>
          <div className="field-card__field-id">
            <CopyableFieldId fieldId={field.id} />
            {field.isSystemField && <span className="field-badge field-badge--system">System</span>}
            {!field.isSystemField && field.isJiraBuiltin && <span className="field-badge field-badge--builtin">Jira built-in</span>}
          </div>
          <h3>{field.name}</h3>
          <p>{field.description || "No admin description is set for this field."}</p>
          <ProjectUsageBuildBadge field={displayField} />
          <UsageTriple usage={usage} entityId={field.id} totalLabel="issues with a value" compact />
          {showGovernance && <FindingsStrip findings={fieldFindings} />}
        </div>
        <div className="field-card__meta">
          <MetricChip label="Type" value={field.type} tone="cool" />
          <MetricChip label="Configured projects" value={configuredProjectsValue} tone="warm" />
          <MetricChip label="Active projects" value={activeProjectsValue} tone="success" />
          <MetricChip label="Issues with value" value={totalIssuesValue} />
          {/* Absent counts render as an em dash rather than 0. "No analysis has been built"
              and "no rule touches this field" are different claims, and only one of them
              makes a field safe to delete. */}
          <MetricChip
            label="Active rules"
            value={automationCounts ? automationCounts.enabled : "—"}
            tone={automationCounts?.enabled > 0 ? "danger" : "neutral"}
          />
          <MetricChip
            label="Disabled rules"
            value={automationCounts ? automationCounts.disabled : "—"}
          />
          {/* Same em-dash rule as the rule chips. A field on zero screens cannot be filled
              by a user through any form, which is the strongest delete signal this app has --
              so it must never be confused with a screen inventory that was never built. */}
          <MetricChip
            label="Screens"
            value={screenCount === null || screenCount === undefined ? "—" : screenCount}
            tone={screenCount === 0 ? "warm" : "neutral"}
          />
          {/* A dash, never a zero, when no filter inventory has been built. Zero here reads
              as "safe to delete" and would be the opposite of what an unbuilt pillar knows.
              A non-zero count is a warning rather than a neutral fact: these searches break
              silently. */}
          <MetricChip
            label="Filters"
            value={filterCount === null || filterCount === undefined ? "—" : filterCount}
            tone={filterCount > 0 ? "alert" : "neutral"}
          />
          {/* Same tri-state as Filters, and for the same reason: a dashboard gadget pointing
              at a filter that names this field breaks silently if the field goes -- nobody
              sees an error, the gadget just renders against a different set of issues. This
              also completes the grid to a clean 3x3 rather than leaving the last row one
              tile short. */}
          <MetricChip
            label="Dashboard gadgets"
            value={dashboardGadgetCount === null || dashboardGadgetCount === undefined ? "—" : dashboardGadgetCount}
            tone={dashboardGadgetCount > 0 ? "alert" : "neutral"}
          />
        </div>
        <span className="field-card__toggle-icon" aria-hidden="true" />
      </button>

      {expanded ? (
        <div className="field-card__body">
          {loading ? (
            <div className="empty-state empty-state--inline">Loading field contexts and project usage...</div>
          ) : details ? (
            <>
              {/* The field-wide query, at the top rather than inside a section of its own.
                  It was a whole CollapsibleSection wrapping a single link -- a header, a
                  chevron and a collapsed state guarding one line. */}
              <div className="field-query-bar">
                <a
                  className="smart-link-card field-query-bar__link"
                  href={buildJiraSearchUrl(siteOrigin, details.fieldJql || details.field?.fieldJql) || "#"}
                  target="_blank"
                  rel="noreferrer"
                  title="Open this field-wide JQL in Jira issue search"
                  onClick={(e) => handleJiraLinkClick(e, buildJiraSearchUrl(siteOrigin, details.fieldJql || details.field?.fieldJql))}
                >
                  <span className="smart-link-card__title">Open field-wide JQL in Jira</span>
                  <code>{details.fieldJql || details.field?.fieldJql}</code>
                </a>
                <div className="field-query-bar__meta">
                  <span>Total populated issues: {usageAvailable ? formatNumber(details.totalIssueCount) : "Unavailable"}</span>
                  <AskRovo agent="observatory-field-expert" scope="this field" context="this field's scope, usage and findings" disabled={!rovoEnabled} onAsk={onAskField} />
                </div>
              </div>

              {!usageAvailable ? (
                <div className="empty-state empty-state--inline">
                  {usageSource?.usageStatusDetail || "Jira did not return per-project usage for this field in the app context."}
                </div>
              ) : null}

              {showGovernance && <CollapsibleSection
                title="Governance Findings"
                actions={
                  <>
                    <FindingsStrip findings={fieldFindings} />
                    <button
                      className="secondary-button secondary-button--small"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRefreshProjectUsage(field.id, details.projectUsagePage || 1);
                      }}
                    >
                      Refresh usage
                    </button>
                    <AskRovo agent="observatory-field-expert" scope="this field" context="this field's scope, usage and findings" disabled={!rovoEnabled} onAsk={onAskField} />
                  </>
                }
              >
                {fieldFindings?.reasons?.length ? (
                  <div className="findings-list">
                    {fieldFindings.reasons.map((reason, index) => (
                      <div className="finding-card" key={`${field.id}-finding-${index}`}>
                        <div className="finding-card__top">
                          <strong>{reason.title}</strong>
                          <FindingBadge
                            label={reason.severity === "high" ? "High" : "Medium"}
                            tone={reason.severity === "high" ? "danger" : reason.category === "cleanup" ? "warn" : "info"}
                          />
                        </div>
                        <p>{reason.detail}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state empty-state--inline">
                    No immediate governance issues were flagged for this field by the current heuristics.
                  </div>
                )}
              </CollapsibleSection>}

              {showGovernance ? <AutomationUsageSection field={field} enabled={expanded} siteOrigin={siteOrigin} rovoEnabled={rovoEnabled} /> : null}
              {showGovernance ? <WorkflowRulesSection field={field} enabled={expanded} siteOrigin={siteOrigin} /> : null}
              {showGovernance ? <FieldBehaviourSection field={field} enabled={expanded} /> : null}
              {showGovernance ? <FilterUsageSection field={field} enabled={expanded} siteOrigin={siteOrigin} /> : null}
              {showGovernance ? <DashboardUsageSection field={field} enabled={expanded} siteOrigin={siteOrigin} /> : null}

              <CollapsibleSection
                title="Contexts"
                badge={details.contexts.length || null}
                actions={<span>Refreshed {formatTimestamp(details.refreshedAt)}</span>}
              >
                <div className="context-grid">
                  {details.contexts.length ? (
                    details.contexts.map((context) => (
                      <div
                        className={`context-card${fieldIsSelectType ? " context-card--clickable" : ""}`}
                        key={context.id}
                        onClick={fieldIsSelectType ? (e) => { e.stopPropagation(); setContextOptionsOpen(true); } : undefined}
                        role={fieldIsSelectType ? "button" : undefined}
                        tabIndex={fieldIsSelectType ? 0 : undefined}
                        onKeyDown={fieldIsSelectType ? (e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setContextOptionsOpen(true); } } : undefined}
                      >
                        <div className="context-card__top">
                          <strong>{context.name}</strong>
                          <span>
                            {context.isGlobalContext
                              ? "Global"
                              : `${context.projects.length} project${context.projects.length === 1 ? "" : "s"}`}
                          </span>
                        </div>
                        <p>{context.description || "No context description."}</p>
                        <div className="tag-row">
                          <span className="tag">{context.isAnyIssueType ? "All issue types" : `${context.issueTypeCount} issue types`}</span>
                          <span className="tag">{context.isGlobalContext ? "Global context" : "Scoped context"}</span>
                          {fieldIsSelectType ? <span className="tag tag--action">View options</span> : null}
                        </div>
                        {!context.isGlobalContext && context.projects.length ? (
                          <div className="project-pill-row">
                            {context.projects.map((project) => (
                              <span className="project-pill" key={`${context.id}-${project.id}`}>
                                {project.key}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <div className="empty-state empty-state--inline">No contexts were returned for this field.</div>
                  )}
                  {contextOptionsOpen ? (
                    <FieldOptionsModal
                      fieldId={field.id}
                      fieldName={field.name || field.fieldName}
                      fieldType={field.type || field.fieldType}
                      projectKeys={[]}
                      onClose={() => setContextOptionsOpen(false)}
                    />
                  ) : null}
                </div>
              </CollapsibleSection>

              {fieldIsSelectType ? (
                <CollapsibleSection title="Options" badge={fieldOptions?.optionsByContext?.length || null}>
                  {fieldOptionsLoading ? (
                    <div className="empty-state empty-state--inline">Loading options…</div>
                  ) : fieldOptions?.optionsByContext?.length ? (
                    fieldOptions.optionsByContext.map((ctx) => (
                      <InlineOptionsContext key={ctx.contextId} ctx={ctx} />
                    ))
                  ) : fieldOptions ? (
                    <div className="empty-state empty-state--inline">No options found for this field.</div>
                  ) : null}
                </CollapsibleSection>
              ) : null}

              <ScreenUsageSection result={screens} loading={screensLoading} />

              <DeletionSafetySection field={field} />

              <IssueTypeUsageSection usage={details.issueTypeUsage} />

              {isUserPickerField(field) && <PeopleUsageSection usage={details.userValueUsage} />}

              <CollapsibleSection
                title="Project Usage"
                actions={
                  <>
                    <span>
                      {`${details.activeProjectCount} active project${details.activeProjectCount === 1 ? "" : "s"} · Page ${details.projectUsagePage}/${details.projectUsageTotalPages}`}
                    </span>
                    <AskRovo agent="observatory-field-expert" scope="this field" context="this field's scope, usage and findings" disabled={!rovoEnabled} onAsk={onAskField} />
                  </>
                }
              >
                {details.projects.length ? (
                  <>
                    <div className="project-usage-list">
                      {details.projects.map((project) => (
                        <div className="project-usage-card" key={project.projectId}>
                          <div className="project-usage-card__head">
                            <div>
                              <strong>
                                {project.projectKey} <span>{project.projectName}</span>
                              </strong>
                            </div>
                            <div className="project-usage-card__head-actions">
                              <MetricChip label="Issues with value" value={project.issueCount} tone="success" />
                              <AskRovo agent="observatory-field-expert" scope={`${project.projectKey}`} context="how this one project uses the field" disabled={!rovoEnabled} onAsk={() => onAskProject(project)} />
                            </div>
                          </div>
                          <div className="project-usage-card__body">
                            <label>JQL</label>
                            <a
                              className="smart-link-card"
                              href={buildJiraSearchUrl(siteOrigin, project.jql) || "#"}
                              target="_blank"
                              rel="noreferrer"
                              title="Open this JQL in Jira issue search"
                              onClick={(e) => handleJiraLinkClick(e, buildJiraSearchUrl(siteOrigin, project.jql))}
                            >
                              <span className="smart-link-card__title">Open JQL in Jira</span>
                              <code>{project.jql}</code>
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="project-usage-pagination">
                      <span className="pagination-bar__status">
                        Showing {((details.projectUsagePage - 1) * details.projectUsagePageSize) + 1}
                        -
                        {Math.min(details.projectUsagePage * details.projectUsagePageSize, details.projectUsageTotalProjects)}
                        {" "}of {details.projectUsageTotalProjects} active projects
                      </span>
                      <div className="pagination-bar__actions">
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => onProjectUsagePageChange(field.id, 1)}
                          disabled={details.projectUsagePage === 1}
                        >
                          First
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => onProjectUsagePageChange(field.id, Math.max(1, details.projectUsagePage - 1))}
                          disabled={details.projectUsagePage === 1}
                        >
                          Previous
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => onProjectUsagePageChange(field.id, Math.min(details.projectUsageTotalPages, details.projectUsagePage + 1))}
                          disabled={details.projectUsagePage === details.projectUsageTotalPages}
                        >
                          Next
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => onProjectUsagePageChange(field.id, details.projectUsageTotalPages)}
                          disabled={details.projectUsagePage === details.projectUsageTotalPages}
                        >
                          Last
                        </button>
                      </div>
                    </div>
                  </>
                ) : details.summaryStatus === "queued" || details.summaryStatus === "building" ? (
                  <div className="empty-state empty-state--inline">
                    <div>
                      <div>Project usage enrichment is running in the background for this field.</div>
                      <div style={{ marginTop: 8 }}>
                        {details.estimatedIssueTotal > 0
                          ? `Scanned ${details.processedIssueCount} of ${details.estimatedIssueTotal} matching issues.`
                          : "Waiting for the issue scan to start."}
                      </div>
                      {details.estimatedIssueTotal > 0 ? (
                        <div className="status-progress" style={{ marginTop: 10 }}>
                          <div className="status-progress__meta">
                            <strong>{Math.min(100, Math.round((details.processedIssueCount / details.estimatedIssueTotal) * 100))}%</strong>
                            <span>{details.processedIssueCount} of {details.estimatedIssueTotal} issues scanned</span>
                          </div>
                          <div className="status-progress__bar" aria-hidden="true">
                            <span style={{ width: `${Math.min(100, Math.round((details.processedIssueCount / details.estimatedIssueTotal) * 100))}%` }} />
                          </div>
                        </div>
                      ) : null}
                      {details.lastError ? <div className="build-card__error" style={{ marginTop: 10 }}>{details.lastError}</div> : null}
                    </div>
                  </div>
                ) : (
                  <div className="empty-state empty-state--inline">
                    No projects with populated values were found on this page of active projects.
                  </div>
                )}
              </CollapsibleSection>
            </>
          ) : (
            <div className="empty-state empty-state--inline">No field details are available.</div>
          )}
        </div>
      ) : null}
    </article>
  );
}
