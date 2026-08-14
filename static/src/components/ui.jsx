import React from "react";
import { Icon } from "./Icons";

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
export function Panel({ title, icon, description, action, children }) {
  return (
    <section className="ui-panel">
      <div className="ui-panel__head">
        <div className="ui-panel__titles">
          <h3 className="ui-panel__title">
            {icon && <Icon name={icon} size={15} />}
            {title}
          </h3>
          {description && <p className="ui-panel__desc">{description}</p>}
        </div>
        {action}
      </div>
      <div className="ui-panel__body">{children}</div>
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

// One pillar of the site health score, on the tab that pillar is about.
//
// The score already groups its dimensions into exactly the tabs this app has -- fields,
// workflows, screens, automation, projects -- so the governance stats each tab needs are
// already computed and were only ever shown on the Overview. Showing a pillar next to the
// inventory it scores is what makes it actionable: the number and the thing it measures on
// the same page.
export function PillarHealthPanel({ pillar, onOpenTrends }) {
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
          <div className="ui-health__dims">
            {scored.map((dim) => (
              <div key={dim.key} className="ui-health__dim">
                <span className="ui-health__dimlabel">{dim.label}</span>
                <span className="ui-health__dimtrack">
                  <span className="ui-health__dimbar" style={{ width: `${dim.score}%` }} />
                </span>
                <span className="ui-health__dimval">{dim.score}</span>
                <span className="ui-health__dimdetail">{dim.detail}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

// Text arrow rather than an Icon: the icon set has no chevron, and a missing name renders
// as nothing at all, which would silently strip the affordance.
export function LinkButton({ children, onClick }) {
  return (
    <button type="button" className="ui-linkbutton" onClick={onClick}>
      {children}
      <span aria-hidden="true" className="ui-linkbutton__arrow">→</span>
    </button>
  );
}
