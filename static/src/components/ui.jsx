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
export function PageHeader({ title, description, actions }) {
  return (
    <header className="ui-pagehead">
      <div className="ui-pagehead__titles">
        <h2 className="ui-pagehead__title">{title}</h2>
        {description && <p className="ui-pagehead__desc">{description}</p>}
      </div>
      {actions && <div className="ui-pagehead__actions">{actions}</div>}
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

export function Chip({ children, tone = "neutral", title }) {
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
