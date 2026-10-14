import React from "react";
import { Icon, useLiveDuration } from "./Icons";
import { buildAutomationRuleUrl, buildIssueUrl, buildWorkflowUrl, handleJiraLinkClick, ROVO_AGENTS, openRovo } from "../utils";

// Shared presentation primitives.
//
// These exist because the same widget had been rebuilt once per tab: stat tiles appeared
// as `scan-stat-card`, `rqt-stat`, `wf-insight-stat` and DashStat's `admin-stat-row`,
// each with its own padding, radius and label casing. Nothing was wrong with any of them
// individually; together they made one product read as four.
//
// The rule going forward: a widget that appears on more than one tab lives here. Tab-local
// components stay in their tab -- this is a shared vocabulary, not a place to put
// everything.

// A labelled number. `tone` carries meaning, not decoration: use "alert" only when the
// value is something a person should act on, or it stops meaning anything.
//
// `children` renders below the hint, for the cases where a tile needs to carry something
// structured -- a set of related keys, a distribution strip. Added rather than letting the
// Projects tab invent a parallel tile; that is how this file came to be needed.
export function StatTile({ label, value, hint, tone = "neutral", icon, children }) {
  return (
    <div className={`ui-stat ui-stat--${tone}`}>
      <div className="ui-stat__head">
        {icon && <Icon name={icon} size={13} />}
        <span className="ui-stat__label">{label}</span>
      </div>
      <span className="ui-stat__value">{value}</span>
      {hint && <span className="ui-stat__hint">{hint}</span>}
      {children}
    </div>
  );
}

// The title block every tab opens with. Each tab had been writing its own -- `wf-header`,
// `cfg__head`, a bare h2 -- at four different sizes and three different colours for the
// same job.
// `meta` is for the freshness line -- "Built 18m ago", "Analyzed from export.json". It is a
// slot on the header rather than each tab's own invention because the three tabs that had
// one had put it in three different places: Screens spent a whole stat tile on it, Workflows
// ran it inline beside the title, and Automation gave it a banner strip above the page. Same
// sentence, three levels of prominence, so a reader could not learn where to look for it.
export function PageHeader({ title, description, meta, actions }) {
  return (
    <header className="ui-pagehead">
      <div className="ui-pagehead__titles">
        <h2 className="ui-pagehead__title">{title}</h2>
        {description && <p className="ui-pagehead__desc">{description}</p>}
      </div>
      <div className="ui-pagehead__side">
        {meta && <span className="ui-pagehead__meta">{meta}</span>}
        {actions && <div className="ui-pagehead__actions">{actions}</div>}
      </div>
    </header>
  );
}

// A footer that stays reachable while its form scrolls. `status` is the state of the thing
// being edited, stated in both directions -- "saved" is information a reader wants, and a
// bar that only appears when dirty leaves them checking whether it registered.
export function StickyActions({ status, tone = "neutral", children }) {
  return (
    <div className="ui-actions">
      {status && <span className={`ui-actions__status ui-actions__status--${tone}`}>{status}</span>}
      {children}
    </div>
  );
}

// Auto-fitting row of tiles. Grid rather than flex so tiles share a width and their
// values line up vertically -- a row of differently-sized boxes is the main thing that
// made the old dashboards look assembled rather than designed.
export function StatRow({ children }) {
  return <div className="ui-stat-row">{children}</div>;
}

// A titled region. `action` is for a single control that belongs to the section
// (a deep link, a refresh); anything more belongs in a toolbar.
// Panels are collapsible when the caller asks for it, or when an ancestor wraps a group of
// them in <CollapsiblePanels> -- the project drawer does the latter so every cross-pillar
// section folds without threading a prop through seven sub-components.
export const PanelCollapsibleContext = React.createContext(false);

export function CollapsiblePanels({ children }) {
  return <PanelCollapsibleContext.Provider value>{children}</PanelCollapsibleContext.Provider>;
}

export function Panel({ title, icon, description, action, children, collapsible = false, defaultCollapsed = false }) {
  const groupCollapsible = React.useContext(PanelCollapsibleContext);
  const isCollapsible = collapsible || groupCollapsible;
  const [collapsed, setCollapsed] = React.useState(isCollapsible && defaultCollapsed);
  const open = !isCollapsible || !collapsed;

  const titles = (
    <div className="ui-panel__titles">
      <h3 className="ui-panel__title">
        {isCollapsible && <Icon name={open ? "chevronUp" : "chevronDown"} size={13} aria-hidden="true" />}
        {icon && <Icon name={icon} size={15} />}
        {title}
      </h3>
      {description && <p className="ui-panel__desc">{description}</p>}
    </div>
  );

  return (
    <section className={`ui-panel${isCollapsible ? " ui-panel--collapsible" : ""}${isCollapsible && !open ? " ui-panel--collapsed" : ""}`}>
      <div className="ui-panel__head">
        {isCollapsible ? (
          <button
            type="button"
            className="ui-panel__toggle"
            aria-expanded={open}
            onClick={() => setCollapsed((v) => !v)}
          >
            {titles}
          </button>
        ) : titles}
        {action}
      </div>
      {open && <div className="ui-panel__body">{children}</div>}
    </section>
  );
}

// `onRemove` turns the chip into a control. The Field Browser had its own
// `admin-field-browser__filter-chip` purely because the shared chip could not be clicked --
// which is exactly the case CLAUDE.md says to solve by adding the prop rather than growing a
// second component. The accessible name says what clicking does, because "Type: date" read
// aloud on a button tells you nothing about the fact that activating it removes the filter.
export function Chip({ children, tone = "neutral", title, onRemove, removeLabel }) {
  if (onRemove) {
    return (
      <button
        type="button"
        className={`ui-chip ui-chip--${tone} ui-chip--removable`}
        title={title}
        aria-label={removeLabel || `Remove filter ${typeof children === "string" ? children : ""}`.trim()}
        onClick={onRemove}
      >
        <span>{children}</span>
        <span className="ui-chip__remove" aria-hidden="true">×</span>
      </button>
    );
  }
  return <span className={`ui-chip ui-chip--${tone}`} title={title}>{children}</span>;
}

// Empty states are content, not filler: say what is missing and what produces it.
// `action` should be the thing that fixes it, when one exists.
export function EmptyState({ children, action, inline = false }) {
  return (
    <div className={`ui-empty ${inline ? "ui-empty--inline" : ""}`}>
      <span>{children}</span>
      {action}
    </div>
  );
}

// Horizontal bar list. Replaces three near-identical chart cards; kept as bars rather
// than a charting library because these are always "top N of one measure", where a bar
// per row reads faster and costs nothing to render.
export function BarList({ items = [], labelKey, valueKey, formatValue = (v) => v, emptyMessage = "No data yet", tone = "accent" }) {
  if (!items.length) return <EmptyState inline>{emptyMessage}</EmptyState>;
  const max = Math.max(...items.map((item) => Number(item[valueKey]) || 0), 1);

  return (
    <div className="ui-barlist">
      {items.map((item) => {
        const value = Number(item[valueKey]) || 0;
        return (
          <div key={item[labelKey]} className="ui-barlist__row">
            <span className="ui-barlist__label" title={item.projectName || item[labelKey]}>{item[labelKey]}</span>
            <div className="ui-barlist__track">
              <div className={`ui-barlist__bar ui-barlist__bar--${tone}`} style={{ width: `${(value / max) * 100}%` }} />
            </div>
            <span className="ui-barlist__value">{formatValue(value)}</span>
          </div>
        );
      })}
    </div>
  );
}

// A single actionable finding. The Overview's job is to route attention, so every finding
// carries a count, a plain-language consequence, and the control that acts on it.
export function FindingRow({ tone = "info", title, detail, count, action }) {
  return (
    <div className={`ui-finding ui-finding--${tone}`}>
      {count !== undefined && count !== null && <span className="ui-finding__count">{count}</span>}
      <div className="ui-finding__body">
        <span className="ui-finding__title">{title}</span>
        {detail && <span className="ui-finding__detail">{detail}</span>}
      </div>
      {action}
    </div>
  );
}

// A rule name that opens the rule in Jira.
//
// Lived in AutomationTab.jsx while that was the only tab rendering one. The Workflows tab
// now lists the rules holding a status open, and importing this across tabs would pull the
// whole AutomationTab chunk into the Workflows bundle for one anchor.
//
// Falls back to plain text when the site origin is unknown -- an anchor that silently does
// nothing on click is worse than a label.
export function RuleLink({ id, name, siteOrigin, className = "" }) {
  const href = buildAutomationRuleUrl(siteOrigin, id);
  const label = name || `Rule ${id}`;
  if (!href) return <span className={className}>{label}</span>;

  return (
    <a
      className={`rule-link ${className}`.trim()}
      href={href}
      target="_blank"
      rel="noreferrer"
      title={`Open "${label}" in Jira automation`}
      onClick={(event) => { event.stopPropagation(); handleJiraLinkClick(event, href); }}
    >
      {label}
    </a>
  );
}


// "In Review, On Hold -> Approved": where a workflow transition goes from and to, in the
// words Jira's own editor uses ("Any status" for a global transition, "Create" for the
// initial one). The transition name alone is frequently just "Done" on a dozen transitions.
export function TransitionPath({ transition }) {
  if (!transition) return null;
  const from = (transition.from || []).map((s) => s?.name).filter(Boolean).join(", ") || "?";
  return (
    <span className="ui-transition">
      <span className="ui-transition__name">{transition.name || transition.id}</span>
      <span className="ui-transition__path">
        {from} <span aria-hidden="true">→</span><span className="ui-srlabel"> to </span> {transition.to?.name || "?"}
      </span>
    </span>
  );
}

const RULE_KIND_TONE = { validator: "warning", condition: "active", "post-function": "neutral", trigger: "neutral", property: "neutral" };
const RULE_KIND_LABEL = { validator: "Validator", condition: "Condition", "post-function": "Post-function", trigger: "Trigger", property: "Property" };

// Every workflow rule or property that points at one thing -- a field, a group -- as rows of
// workflow, where (transition path or status) and what (rule or property meaning).
//
// Shared because three surfaces ask the same question about different things: the field
// card ("where is this field validated"), the Workflows tab, and the group lookups in People
// and Access ("which statuses lock editing to this group"). `result` is the resolver's
// tri-state answer, rendered as such: unavailable never reads as "nothing found".
export function WorkflowUsageList({ result, siteOrigin, emptyMessage = "No workflow rule or property names this." }) {
  if (!result) return <EmptyState inline>Looking up workflow rules…</EmptyState>;
  if (!result.available) {
    return (
      <EmptyState inline>
        {result.reason === "rules-not-read"
          ? "The workflow inventory was built before transition rules were captured. Rebuild it in the Workflows tab."
          : "No workflow inventory has been built, so whether a workflow rule uses this is unknown."}
      </EmptyState>
    );
  }
  if (!result.usages?.length) return <EmptyState inline>{emptyMessage}</EmptyState>;

  return (
    <ul className="ui-wfusage">
      {result.usages.map((usage, i) => {
        const kind = usage.rule?.kind || "property";
        return (
          <li key={`${usage.workflowName}-${i}`} className="ui-wfusage__row">
            <span className="ui-wfusage__workflow">
              <JiraLink href={buildWorkflowUrl(siteOrigin, usage.workflowName)} title={`Open ${usage.workflowName} in Jira`}>
                {usage.workflowName}
              </JiraLink>
            </span>
            <span className="ui-wfusage__where">
              {usage.transition
                ? <TransitionPath transition={usage.transition} />
                : <span className="ui-transition__name">Status: {usage.status?.name || "?"}</span>}
            </span>
            <span className="ui-wfusage__what">
              <Chip tone={RULE_KIND_TONE[kind] || "neutral"}>{RULE_KIND_LABEL[kind] || kind}</Chip>
              <span className="ui-wfusage__label" title={usage.rule?.key || usage.property?.key || ""}>
                {usage.rule ? usage.rule.label : (usage.property?.meaning || usage.property?.key)}
              </span>
              {usage.rule?.summary && <span className="ui-wfusage__summary">{usage.rule.summary}</span>}
              {(usage.refs || []).map((ref) => (
                <Chip
                  key={`${ref.type}-${ref.id}`}
                  tone={ref.missing ? "critical" : "neutral"}
                  title={ref.missing ? `${ref.id} no longer exists on this site` : ref.id}
                >
                  {ref.label || ref.id}{ref.missing ? " (missing)" : ""}
                </Chip>
              ))}
            </span>
          </li>
        );
      })}
      {result.truncated && <li className="ui-wfusage__more">Showing the first {result.usages.length}. Narrow the search in the Workflows tab.</li>}
    </ul>
  );
}

// The generic form of RuleLink, for every other Jira object a pillar lists: a project, a
// board, a screen, a scheme, an Assets schema. The caller has already decided WHICH url to
// build (they know what kind of thing they are holding); this owns how it looks and behaves,
// so a link out of the Screens tab and a link out of the Boards tab cannot drift apart.
//
// Same two rules RuleLink follows, for the same reasons: falls back to plain text when there
// is no href (an anchor that does nothing on click is worse than a label), and stops
// propagation so a link inside a clickable row does not also trigger the row.
export function JiraLink({ href, children, title, className = "" }) {
  if (!href) return <span className={className}>{children}</span>;

  return (
    <a
      className={`jira-link ${className}`.trim()}
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title || "Open in Jira"}
      onClick={(event) => { event.stopPropagation(); handleJiraLinkClick(event, href); }}
    >
      {children}
    </a>
  );
}


// Where a finding's remediation stands, in one line. Shared by the Overview (beside each
// finding) and the Remediation tab (on each card), so "epic, open of total, which quarter"
// reads the same wherever a reader meets it.
//
//   group      -- the finding's getRemediationTickets group, or null if never ticketed
//   period     -- the current quarter ("2026-Q3"), from the same response
//   onOpen     -- takes the reader to this finding on the Remediation tab
//
// Three states, each stated rather than implied: this quarter's epic and its progress; an
// earlier quarter's epic, with this quarter's not started; or no epic at all.
export function RemediationStatus({ group, period, siteOrigin, onOpen, compact = false }) {
  const epicKey = group?.epic?.issueKey || null;
  const open = group?.openCount ?? 0;
  const total = group?.taskCount ?? 0;
  const epicLink = epicKey ? <JiraLink href={buildIssueUrl(siteOrigin, epicKey)} title={`Open ${epicKey} in Jira`}>{epicKey}</JiraLink> : null;
  const progress = total === 0 ? "no tasks yet" : open === 0 ? `all ${total} tasks closed` : `${open} of ${total} tasks open`;
  // Tasks still open under earlier quarters' epics are open work on this finding too.
  const earlierOpen = (group?.previousPeriods || []).reduce((n, p) => n + (p.openCount || 0), 0);
  const earlier = earlierOpen > 0 ? ` · ${earlierOpen} more open from earlier quarters` : "";

  let tone = "neutral";
  let body;
  if (group && group.isCurrent) {
    tone = open + earlierOpen === 0 && total > 0 ? "success" : "active";
    body = <>{epicLink} · {progress}{earlier}</>;
  } else if (group) {
    if (open + earlierOpen > 0) tone = "active";
    body = <>{group.period} epic {epicLink} · {progress}{earlier}{period ? ` · ${period} not started` : ""}</>;
  } else {
    body = <>No remediation epic{period ? ` for ${period}` : ""}</>;
  }

  return (
    <span className={`ui-remediation ui-remediation--${tone}${compact ? " ui-remediation--compact" : ""}`}>
      <Icon name="wrench" size={12} aria-hidden="true" />
      <span className="ui-remediation__body">{body}</span>
      {onOpen && (
        <button type="button" className="ui-remediation__open" onClick={(event) => { event.stopPropagation(); onOpen(); }}>
          {group?.isCurrent ? "Manage" : "Start remediation"} →
        </button>
      )}
    </span>
  );
}

// ── Governance rows ─────────────────────────────────────────────────────────
//
// One governance metric, in the form both the Overview and the per-pillar tabs render it.
//
// The Overview used to carry two panels over the same facts: "Site health" scored each
// dimension and "What needs attention" counted and linked the findings derived from those
// same dimensions. A reader comparing them had to work out that "Automation security 0"
// and "86 rules storing a credential in plaintext" were one thing said twice. This is that
// thing said once: the score, the evidence, the urgency, where it is going, and the way in.

// Urgency bands, in the order they are shown. `clear` is not shown as a band -- it is the
// absence of one -- but it is a value the derivation can return.
export const GOVERNANCE_BANDS = [
  { key: "critical", label: "Act now", description: "Broken or exposed configuration. Someone is relying on these being right." },
  { key: "warning", label: "Worth reviewing", description: "Working today, but the cost or the risk is growing." },
  { key: "info", label: "Cleanup when convenient", description: "Safe to leave. Safe to remove, once confirmed." },
];

const BAND_LABELS = Object.fromEntries(GOVERNANCE_BANDS.map((b) => [b.key, b.label]));

// A score's movement across the history window, as a shape rather than a number.
//
// Deliberately tiny and deliberately unlabelled: at this density the question a reader has
// is "is this getting better or worse", not "what was it on the 14th". The delta beside it
// carries the magnitude.
//
// Nulls in `points` are gaps -- days the dimension was not measured -- and are skipped
// rather than drawn as zero, which is the same distinction the score itself makes between
// "not looked at" and "looked at and bad".
export function Sparkline({ points = [], width = 56, height = 16, title }) {
  const measured = points
    .map((point, index) => ({ index, score: point?.score }))
    .filter((point) => typeof point.score === "number");

  // One point is not a trend. Rendering a flat line through a single dot would assert a
  // stability nobody measured.
  if (measured.length < 2) {
    return <span className="ui-spark ui-spark--none" title={title || "Not enough history to show a trend"}>—</span>;
  }

  const span = Math.max(1, points.length - 1);
  const coords = measured.map(({ index, score }) => {
    const x = (index / span) * (width - 2) + 1;
    // Scores are always 0-100, so the scale is fixed rather than fitted. A fitted scale
    // would make a two-point wobble look like a collapse.
    const y = height - 1 - (score / 100) * (height - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const last = measured[measured.length - 1];
  const first = measured[0];
  const direction = last.score > first.score ? "up" : last.score < first.score ? "down" : "flat";

  return (
    <svg
      className={`ui-spark ui-spark--${direction}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={title || `Trend: ${direction}`}
    >
      <polyline points={coords.join(" ")} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// The signed change, worded so a rise is always good.
//
// Every dimension here is scored so that higher is better, which makes "+12" unambiguous.
// null is "no comparison available" -- either one measurement, or a dimension that did not
// exist at the start of the window -- and renders as nothing rather than as "0", because a
// dimension nobody could compare has not held steady.
export function TrendDelta({ delta }) {
  if (typeof delta !== "number" || delta === 0) return null;
  const direction = delta > 0 ? "up" : "down";
  return (
    <span className={`ui-trend ui-trend--${direction}`}>
      {delta > 0 ? "+" : "−"}{Math.abs(delta)}
    </span>
  );
}

// One metric. Score, evidence, urgency, trend, and the control that acts on it.
//
// `band` is required and carries meaning, like `tone` everywhere else in this file: use
// "critical" only when a person should act on the value now, or it stops meaning anything.
export function GovernanceRow({
  label,
  score = null,
  band = "info",
  detail,
  action,
  count,
  trend = null,
  reason,
  children,
}) {
  const scored = typeof score === "number";

  return (
    <div className={`ui-gov ui-gov--${band}`}>
      <div className="ui-gov__head">
        <span className="ui-gov__label">{label}</span>
        {band !== "clear" && <span className={`ui-gov__band ui-gov__band--${band}`}>{BAND_LABELS[band] ?? band}</span>}
      </div>

      {/* No score and no trend: no meter row at all. An invisible placeholder track used to hold
          the space, which left an empty band under the title of every unscored card. */}
      {(scored || trend) && (
        <div className="ui-gov__meter">
          {scored ? (
            <>
              <span className="ui-gov__track">
                <span className={`ui-gov__bar ui-gov__bar--${band}`} style={{ width: `${score}%` }} />
              </span>
              <span className="ui-gov__score">{score}</span>
            </>
          ) : (
            <span className="ui-gov__track ui-gov__track--none" />
          )}

          {trend && (
            <span className="ui-gov__trend">
              <Sparkline points={trend.points} title={trend.title} />
              <TrendDelta delta={trend.delta} />
            </span>
          )}
        </div>
      )}

      <div className="ui-gov__body">
        {detail && <span className="ui-gov__detail">{detail}</span>}
        {!detail && reason && <span className="ui-gov__detail ui-gov__detail--muted">{reason}</span>}
        {children}
      </div>

      {(count !== undefined && count !== null) || action ? (
        <div className="ui-gov__act">
          {count !== undefined && count !== null && <span className="ui-gov__count">{count}</span>}
          {action}
        </div>
      ) : null}
    </div>
  );
}

// The search / sort / filter toolbar every list tab gets.
//
// Before this, six tabs had each grown their own: the Field Browser had a filter panel with
// removable chips, RQT had a search box and three selects, Workflows had a sort dropdown
// with different labels for the same orderings, and Screens had a bare input. Same three
// jobs, five layouts, and no two tabs agreeing on whether "Name" sorted A-Z or Z-A.
//
// Deliberately controlled rather than stateful: the two server-paged tabs have to push
// these values into a resolver call, and a component holding its own state would force them
// to mirror it. `filters` is a list rather than a map so the order on screen is the caller's
// to decide, which matters when one tab has five of them.
export function SortFilterBar({
  search,
  onSearchChange,
  searchPlaceholder = "Search",
  searchLabel = "Search",
  sort,
  onSortChange,
  sortOptions = [],
  filters = [],
  resultCount,
  totalCount,
  onClear,
  children,
}) {
  // A filter is "active" when it is set to anything other than its first option, which is
  // the all/any case by convention. Derived rather than passed so a caller cannot forget to
  // update the chip row after changing a select.
  const active = filters.filter((f) => f.value != null && f.value !== "" && f.value !== (f.allValue ?? "all"));
  const searching = Boolean(String(search ?? "").trim());
  const canClear = active.length > 0 || searching;

  return (
    <div className="ui-controls">
      <div className="ui-controls__row">
        <label className="ui-controls__search">
          <span className="ui-controls__srlabel">{searchLabel}</span>
          <Icon name="search" size={13} />
          <input
            type="search"
            value={search ?? ""}
            placeholder={searchPlaceholder}
            onChange={(event) => onSearchChange?.(event.target.value)}
          />
        </label>

        {sortOptions.length > 0 && (
          <label className="ui-controls__field">
            <span>Sort</span>
            <select value={sort ?? ""} onChange={(event) => onSortChange?.(event.target.value)}>
              {sortOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        )}

        {filters.map((filter) => (
          <label className="ui-controls__field" key={filter.key}>
            <span>{filter.label}</span>
            <select value={filter.value ?? (filter.allValue ?? "all")} onChange={(event) => filter.onChange?.(event.target.value)}>
              {filter.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}{option.count === undefined ? "" : ` (${option.count})`}
                </option>
              ))}
            </select>
          </label>
        ))}

        {children}
      </div>

      {(canClear || resultCount !== undefined) && (
        <div className="ui-controls__row ui-controls__row--status">
          {/* Stated as "x of y" whenever the two differ. A bare count next to a filtered
              table is the single easiest way to make someone believe rows are missing. */}
          {resultCount !== undefined && (
            <span className="ui-controls__count">
              {totalCount !== undefined && totalCount !== resultCount
                ? `${resultCount} of ${totalCount}`
                : `${resultCount}`}
              {canClear ? " matching" : ""}
            </span>
          )}

          {active.map((filter) => (
            <Chip
              key={filter.key}
              onRemove={() => filter.onChange?.(filter.allValue ?? "all")}
              removeLabel={`Clear ${filter.label} filter`}
            >
              {filter.label}: {filter.options.find((o) => String(o.value) === String(filter.value))?.label ?? filter.value}
            </Chip>
          ))}

          {searching && (
            <Chip onRemove={() => onSearchChange?.("")} removeLabel="Clear search">
              Search: {search}
            </Chip>
          )}

          {canClear && onClear && (
            <button type="button" className="ui-controls__clear" onClick={onClear}>Clear all</button>
          )}
        </div>
      )}
    </div>
  );
}

// Panels side by side instead of stacked in one column.
//
// Every overview in this app was a single column of full-width panels, which on a wide
// screen means a 1,900px "Trigger mix" bar chart above two thirds of empty page. Panels
// carry their own natural width now and the grid fits as many per row as that allows,
// falling back to one column on narrow viewports without a media query.
//
// `wide` is for the panel that genuinely wants the full row -- a distribution with twenty
// bars reads badly at half width.
export function PanelGrid({ children }) {
  return <div className="ui-panelgrid">{children}</div>;
}

export function GridSpan({ children, wide = false }) {
  return <div className={wide ? "ui-panelgrid__span" : "ui-panelgrid__cell"}>{children}</div>;
}

// The urgency band a bare score implies, when no hand-authored finding says otherwise.
//
// Capped at "warning" deliberately. A dimension scoring badly with no finding attached to
// it means nobody has decided it is urgent -- only a finding, which is written by hand with
// a consequence in it, can claim "act now". Without the cap a site would open with six red
// rows the moment a new dimension scored low, and the band would stop meaning anything.
export function bandFromScore(score) {
  if (typeof score !== "number") return "clear";
  if (score >= 90) return "clear";
  if (score >= 70) return "info";
  return "warning";
}

// One pillar of the site health score, on the tab that pillar is about.
//
// The score already groups its dimensions into exactly the tabs this app has -- fields,
// workflows, screens, automation, projects -- so the governance stats each tab needs are
// already computed and were only ever shown on the Overview. Showing a pillar next to the
// inventory it scores is what makes it actionable: the number and the thing it measures on
// the same page.
//
// Built on GovernanceRow rather than its own bar markup, so a metric reads the same here as
// it does in the Overview's ledger. It had grown a second dialect of the same row -- the
// exact thing this file exists to stop.
export function PillarHealthPanel({ pillar, onOpenTrends, trendsByDimension = null }) {
  if (!pillar) {
    return (
      <Panel title="Governance" icon="activity">
        <EmptyState inline>Health has not been scored yet.</EmptyState>
      </Panel>
    );
  }

  const scored = (pillar.dimensions || []).filter((d) => d.available);

  return (
    <Panel
      title="Governance"
      icon="activity"
      description={pillar.available ? `Scored across ${scored.length} of ${pillar.total} dimensions.` : undefined}
      action={onOpenTrends ? <LinkButton onClick={onOpenTrends}>Trends</LinkButton> : null}
    >
      {!pillar.available ? (
        // The pillar's own reason, not a generic empty state: "no screen inventory yet" and
        // "scored badly" are different facts and only one of them is a finding.
        <EmptyState inline>{pillar.reason || "Not measured yet."}</EmptyState>
      ) : (
        <>
          <div className="ui-pillar__hero">
            <span className={`ui-health__score ui-health__score--${(pillar.grade || "e").toLowerCase()}`}>{pillar.score}</span>
            <span className="ui-health__of">/ 100</span>
          </div>
          <div className="ui-gov-list">
            {scored.map((dim) => (
              <GovernanceRow
                key={dim.key}
                label={dim.label}
                score={dim.score}
                band={bandFromScore(dim.score)}
                detail={dim.detail}
                trend={trendsByDimension?.[dim.key] ?? null}
              />
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

// Text arrow rather than an Icon: the icon set has no chevron, and a missing name renders
// as nothing at all, which would silently strip the affordance.
// Two to four views of the same content, one chosen ("By priority / By pillar"). Pressed-state
// buttons rather than tabs: the content underneath is the same set, ordered or grouped
// differently, not a different page.
export function SegmentedToggle({ label, options = [], value, onChange }) {
  return (
    <div className="ui-segmented" role="group" aria-label={label}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={`ui-segmented__btn${active ? " ui-segmented__btn--active" : ""}`}
            aria-pressed={active}
            onClick={() => { if (!active) onChange?.(option.value); }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function LinkButton({ children, onClick }) {
  return (
    <button type="button" className="ui-linkbutton" onClick={onClick}>
      {children}
      <span aria-hidden="true" className="ui-linkbutton__arrow">→</span>
    </button>
  );
}

// The one "Ask Rovo" button. Every pillar tab and every detail drawer uses this so the
// affordance reads the same everywhere and, crucially, so a person can tell what it is
// about to do before they press it:
//
//  - `agent`   the ROVO_AGENTS key for this pillar's expert
//  - `scope`   what the question is about, in the label: "this scheme", "the workflow
//              estate". Omit for a bare "Ask Rovo".
//  - `context` a short phrase naming what gets sent, for the tooltip: "this scheme's
//              status list, category balance and findings"
//  - `buildPrompt`  () => string, called on click (lazy, so a heavy prompt is only built
//              when the button is actually used)
//  - `onAsk`   escape hatch: if given, called on click instead of opening Rovo here. For
//              the few call sites where the prompt is assembled in a parent that owns the
//              field-detail cache. Still gets the consistent label, tooltip and styling.
//  - `disabled` typically !rovoEnabled or a still-loading view
//
// The tooltip always ends with the read-only reassurance, because "Ask Rovo" next to a
// governance finding could otherwise read as "act on this".
export function AskRovo({ agent, scope, context, buildPrompt, onAsk, disabled = false, size = "small" }) {
  const [busy, setBusy] = React.useState(false);
  const meta = ROVO_AGENTS[agent];
  const shortName = meta ? meta.name.replace(/^Observatory /, "") : "the Observatory agent";
  const label = scope ? `Ask Rovo about ${scope}` : "Ask Rovo";
  const tip =
    `Opens ${shortName} in Rovo` +
    (context ? `, seeded with ${context}` : (meta ? `, seeded with ${meta.reads}` : "")) +
    ". Rovo answers from the latest snapshot and never changes Jira.";

  async function handleClick(event) {
    event.stopPropagation();
    if (busy || disabled) return;
    setBusy(true);
    try {
      if (typeof onAsk === "function") {
        await onAsk();
      } else {
        await openRovo(agent, typeof buildPrompt === "function" ? buildPrompt() : String(buildPrompt || ""));
      }
    } catch {
      // rovo.open rejects when Rovo is not enabled on the site, or the deep link is
      // dismissed. Nothing to recover -- the button is best-effort.
    } finally {
      setBusy(false);
    }
  }

  // Accessible name is the visible label ("Ask Rovo about this field") -- deliberately not
  // overridden with the long sentence, which would break label-in-name and make the button
  // impossible to find by its visible text. The sentence is the hover tooltip only.
  return (
    <button
      type="button"
      className={`ask-rovo${size === "small" ? " ask-rovo--small" : ""}`}
      onClick={handleClick}
      disabled={disabled || busy}
      title={tip}
    >
      <Icon name="zap" size={13} aria-hidden="true" />
      {busy ? "Opening Rovo…" : label}
    </button>
  );
}

const STAGE_RAIL_TONE = {
  done: "done",
  running: "active",
  failed: "failed",
  skipped: "skipped",
  pending: "pending",
};

// mm:ss / h m for a millisecond span. Shared by the rail and its callers so a duration reads
// the same everywhere on the scan page.
export function formatDurationMs(ms) {
  if (ms == null || !Number.isFinite(Number(ms)) || Number(ms) < 0) return null;
  const total = Math.round(Number(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// One node in the pipeline. Its own component so useLiveDuration -- a hook -- can run per
// node without breaking the rules of hooks inside a map.
function StageRailNode({ stage, index, total, isCurrent, isSelected, onSelect }) {
  const live = useLiveDuration(stage.state === "running" ? stage.startedAt : null);
  const tone = STAGE_RAIL_TONE[stage.state] || "pending";

  const meta = stage.state === "running"
    ? (live || "running")
    : stage.state === "pending"
      ? "queued"
      : formatDurationMs(stage.durationMs) || (stage.state === "skipped" ? "skipped" : "done");

  return (
    <button
      type="button"
      className={`stage-rail__node stage-rail__node--${tone}${isCurrent ? " stage-rail__node--current" : ""}${isSelected ? " stage-rail__node--selected" : ""}`}
      aria-pressed={isSelected}
      aria-label={`${stage.label} — ${stage.state}. Stage ${index + 1} of ${total}.`}
      onClick={() => onSelect(stage.key)}
    >
      <span className="stage-rail__marker" aria-hidden="true">
        {stage.state === "done" ? "✓" : stage.state === "failed" ? "!" : stage.state === "skipped" ? "–" : index + 1}
      </span>
      <span className="stage-rail__label">{stage.label}</span>
      <span className="stage-rail__meta">
        {meta}
        {Number(stage.attempts) > 1 && (
          <span className="stage-rail__retry" title={`${stage.attempts} attempts`}>⟳{stage.attempts}</span>
        )}
      </span>
    </button>
  );
}

// The scan as a sequence you can point at, replacing the three-column status table.
//
// `stages` is the merged catalog+live list: every stage in run order, each carrying its own
// state, timing and attempt count. Clicking a node selects it; the caller renders the detail.
export function StageRail({ stages = [], currentStage = null, selectedKey = null, onSelect = () => {} }) {
  if (!stages.length) return null;
  return (
    <div className="stage-rail" role="list">
      {stages.map((stage, i) => (
        <React.Fragment key={stage.key}>
          {i > 0 && <span className="stage-rail__link" aria-hidden="true" />}
          <div role="listitem" className="stage-rail__step">
            <StageRailNode
              stage={stage}
              index={i}
              total={stages.length}
              isCurrent={stage.key === currentStage}
              isSelected={stage.key === selectedKey}
              onSelect={onSelect}
            />
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

// ── Usage: three numbers per item ─────────────────────────────────────────────
//
// Every issue-level pillar shows the same three numbers for each item, counted by the issue
// crawl: how many issues, how many in the last 90 days, and when last. `usage` is the whole
// getPillarUsage response (usePillarUsage), so the date basis and window travel with the
// numbers and the labels can't drift from what was counted.
//
// Three states, each said: still loading (nothing), not measured (with the reason), or
// measured. An item missing from a measured response is a real zero -- the crawl covered every
// issue and found none -- so it reads "0 issues · never", not "not measured".
const USAGE_BASIS_WORDS = {
  created: { recent: "created", last: "last created" },
  updated: { recent: "active", last: "last activity" },
  resolved: { recent: "resolved", last: "last resolved" },
};

export function formatUsageWhen(iso, now = Date.now()) {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "unknown";
  const days = Math.floor((now - t) / 86400000);
  if (days < 1) return "today";
  if (days < 60) return `${days}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

// Several items' usage as one, for a thing that is made of them -- a security scheme of its
// levels, later a scheme of its projects. Totals add, the last date is the latest.
export function combineUsageItems(usage, entityIds = []) {
  const out = { total: 0, recent: 0, lastAt: null, projectCount: 0 };
  for (const id of entityIds) {
    const it = usage?.items?.[String(id)];
    if (!it) continue;
    out.total += it.total || 0;
    out.recent += it.recent || 0;
    if (it.lastAt && (!out.lastAt || it.lastAt > out.lastAt)) out.lastAt = it.lastAt;
  }
  return out;
}

// `item` overrides the lookup by entityId, for a combined figure (combineUsageItems).
export function UsageTriple({ usage, entityId, item: itemOverride = null, totalLabel = "issues", compact = false }) {
  if (!usage) return null;
  if (!usage.available) {
    const why = usage.reason === "no-crawl"
      ? "No complete issue crawl yet. Run a full scan to measure usage."
      : usage.reason === "error" ? `Usage could not be read${usage.error ? `: ${usage.error}` : ""}.` : "Usage is not measured for this item.";
    return <span className="ui-usage ui-usage--unmeasured" title={why}>usage not measured</span>;
  }
  const item = itemOverride || usage.items?.[String(entityId)] || { total: 0, recent: 0, lastAt: null, projectCount: 0 };
  const words = USAGE_BASIS_WORDS[usage.basis] || USAGE_BASIS_WORDS.updated;
  const days = usage.windowDays || 90;
  const idle = item.recent === 0;
  const when = formatUsageWhen(item.lastAt);
  const title = `${item.total.toLocaleString()} ${totalLabel}` +
    (item.projectCount ? ` across ${item.projectCount} project${item.projectCount === 1 ? "" : "s"}` : "") +
    `; ${item.recent.toLocaleString()} ${words.recent} in the last ${days} days; ${words.last} ${when}.` +
    (usage.measuredAt ? ` Counted by the issue crawl, ${formatUsageWhen(usage.measuredAt)}.` : "");
  return (
    <span className={`ui-usage${compact ? " ui-usage--compact" : ""}${idle ? " ui-usage--idle" : ""}`} title={title}>
      <span className="ui-usage__n"><b>{item.total.toLocaleString()}</b> {totalLabel}</span>
      <span className="ui-usage__n"><b>{item.recent.toLocaleString()}</b> {words.recent} {days}d</span>
      <span className="ui-usage__n">{words.last} <b>{when}</b></span>
    </span>
  );
}
