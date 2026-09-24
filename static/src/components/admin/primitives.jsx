import React from "react";
import { Icon } from "../../components/Icons";

// Small presentational pieces shared across admin tabs.
// Extracted from admin.jsx so each can be rendered and asserted on its own.

// StatCard was retired here. It was the second stat tile in the codebase -- `StatTile` in
// components/ui.jsx being the first -- and having both meant a metric row rendered
// differently depending on which tab you were standing on, which is most of what made
// Scans, Fields and Workflows read as three products.
//
// StatTile won on capability rather than seniority: it carries a hint and arbitrary
// children, and components/ui.jsx is the declared home for anything used by more than one
// tab. Its `variant` prop maps onto StatTile's `tone`; the two tones only StatCard could
// express (success, building -> active) moved across with it rather than being dropped.
//
// Use StatTile. Do not reintroduce a tile here.

// `labelledBy` is supplied by ConfigRow, which owns the visible label. `label` is the
// escape hatch for a Toggle used outside a ConfigRow. A switch with neither announces
// itself as "switch, on" and nothing else, which is why the association is not optional
// in practice even though the prop is.
export function Toggle({ checked, onChange, disabled, labelledBy, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      className={`admin-toggle ${checked ? "admin-toggle--on" : ""}`}
      onClick={() => onChange(!checked)}
      disabled={disabled}
    >
      <span className="admin-toggle__thumb" />
    </button>
  );
}

export function ConfigSection({ title, icon, children }) {
  return (
    <div className="admin-config-section">
      <div className="admin-config-section__header">
        <Icon name={icon} size={15} />
        <span>{title}</span>
      </div>
      <div className="admin-config-section__body">{children}</div>
    </div>
  );
}

// The label is named here, so the control inside it can borrow that name rather than
// every call site restating it. Toggle renders a role="switch" button, which cannot be
// associated by <label for> the way an input can -- without aria-labelledby a screen
// reader announces "switch, on" and nothing about what it switches.
let configRowSeq = 0;

export function ConfigRow({ label, hint, children }) {
  const labelId = React.useMemo(() => `cfgrow-${++configRowSeq}`, []);

  return (
    <div className="admin-config-row">
      <div className="admin-config-row__label">
        <span className="admin-config-row__name" id={labelId}>{label}</span>
        {hint && <span className="admin-config-row__hint">{hint}</span>}
      </div>
      <div className="admin-config-row__control">
        {React.Children.map(children, (child) =>
          React.isValidElement(child) && child.type === Toggle
            ? React.cloneElement(child, { labelledBy: labelId })
            : child
        )}
      </div>
    </div>
  );
}

export function ThresholdInput({ label, value, onChange, min = 1, max = 100000, step = "1" }) {
  return (
    <label className="admin-threshold-input">
      <span className="admin-threshold-input__label">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(step === "1" ? (Number(e.target.value) || min) : (parseFloat(e.target.value) || min))}
        className="admin-threshold-input__field"
      />
    </label>
  );
}

export function InlineThresholdInput({ value, onChange, min = 1, max = 100000, step = 1 }) {
  return (
    <input
      type="number"
      className="admin-threshold-rule__input"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(step === 1 ? (Number(e.target.value) || min) : (parseFloat(e.target.value) || min))}
    />
  );
}

export function JobStatusBadge({ status }) {
  const map = {
    ready: "success",
    building: "building",
    queued: "queued",
    failed: "danger",
    cancelled: "muted",
    unbuilt: "neutral",
  };
  const variant = map[status] || "neutral";
  return <span className={`admin-job-badge admin-job-badge--${variant}`}>{status || "unbuilt"}</span>;
}

// `disabled` + `reason` exist for the Confluence macro, where what a viewer may see is
// decided by their own Jira permissions rather than by what has been built.
//
// Disabled rather than hidden, deliberately. A section that silently disappears reads as a
// missing feature and gets raised as a bug; one that is present, dimmed, and says why is the
// difference between "this app is broken" and "you cannot browse any project that has one".
// The reason lands on `title` and on aria-description, so it reaches a screen reader too.
export function SubNavLayout({ items, activeKey, onSelect, children }) {
  // A remembered section can outlive the section: a stored key from before a rename, or one a
  // since-rebuilt inventory no longer offers. Rather than render a panel with nothing
  // selected, fall back to the first section that can be opened.
  const known = items.some((item) => item.key === activeKey);
  const fallbackKey = items.find((item) => !item.disabled)?.key;
  React.useEffect(() => {
    if (!known && fallbackKey && fallbackKey !== activeKey) onSelect(fallbackKey);
  }, [known, fallbackKey, activeKey]);

  return (
    <div className="sub-nav-layout">
      <nav className="sub-nav" aria-label="Section navigation">
        {items.map(({ key, label, icon, badge, disabled = false, reason = null, group = null }, index) => (
          <React.Fragment key={key}>
          {/* A heading wherever `group` changes. Optional: a list with no groups renders
              exactly as it always has. */}
          {group && group !== items[index - 1]?.group && (
            <div className="sub-nav__group" role="presentation">{group}</div>
          )}
          <button
            type="button"
            className={`sub-nav__item ${activeKey === key ? "sub-nav__item--active" : ""}${disabled ? " sub-nav__item--disabled" : ""}`}
            onClick={() => { if (!disabled) onSelect(key); }}
            disabled={disabled}
            aria-current={activeKey === key ? "page" : undefined}
            title={disabled ? reason || undefined : undefined}
            aria-description={disabled ? reason || undefined : undefined}
          >
            {icon && <Icon name={icon} size={14} />}
            <span>{label}</span>
            {badge != null && <span className="sub-nav__badge">{badge}</span>}
          </button>
          </React.Fragment>
        ))}
      </nav>
      <div className="sub-nav__panel">
        {children}
      </div>
    </div>
  );
}

export function ActivitySection({ title, subtitle, open, onToggle, actions, children }) {
  return (
    <section className="activity-section">
      <button className="activity-section__header" type="button" onClick={onToggle} aria-expanded={open}>
        <div className="activity-section__copy">
          <div className="snapshot-log-entries__heading">{title}</div>
          {subtitle ? <div className="saved-reports-panel__subtitle">{subtitle}</div> : null}
        </div>
        <div className="activity-section__controls">
          {actions ? <div className="section-heading__actions">{actions}</div> : null}
          <span className={`activity-section__chevron ${open ? "activity-section__chevron--open" : ""}`}>
            <Icon name={open ? "x" : "activity"} size={16} />
          </span>
        </div>
      </button>
      {open ? <div className="activity-section__body">{children}</div> : null}
    </section>
  );
}

// Must match CLEAR_SNAPSHOT_CONFIRMATION in src/resolvers.js. The admin bundle is built
// separately from the backend so this cannot be imported; the server re-checks it anyway,
// which means a drift here shows up as "confirmation did not match" rather than as an
// accidental deletion.
