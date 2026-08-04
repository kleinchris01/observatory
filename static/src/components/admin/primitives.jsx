import React from "react";
import { Icon } from "../../components/Icons";

// Small presentational pieces shared across admin tabs.
// Extracted from admin.jsx so each can be rendered and asserted on its own.

export function StatCard({ label, value, icon, variant = "neutral" }) {
  return (
    <div className={`admin-stat-card admin-stat-card--${variant}`}>
      <div className="admin-stat-card__icon"><Icon name={icon} size={18} /></div>
      <div className="admin-stat-card__body">
        <span className="admin-stat-card__value">{value ?? "—"}</span>
        <span className="admin-stat-card__label">{label}</span>
      </div>
    </div>
  );
}

export function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
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

export function ConfigRow({ label, hint, children }) {
  return (
    <div className="admin-config-row">
      <div className="admin-config-row__label">
        <span className="admin-config-row__name">{label}</span>
        {hint && <span className="admin-config-row__hint">{hint}</span>}
      </div>
      <div className="admin-config-row__control">{children}</div>
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

export function SubNavLayout({ items, activeKey, onSelect, children }) {
  return (
    <div className="sub-nav-layout">
      <nav className="sub-nav" aria-label="Section navigation">
        {items.map(({ key, label, icon, badge }) => (
          <button
            key={key}
            type="button"
            className={`sub-nav__item ${activeKey === key ? "sub-nav__item--active" : ""}`}
            onClick={() => onSelect(key)}
          >
            {icon && <Icon name={icon} size={14} />}
            <span>{label}</span>
            {badge != null && <span className="sub-nav__badge">{badge}</span>}
          </button>
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
