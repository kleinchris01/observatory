import React from "react";
import { createPortal } from "react-dom";
import { invoke } from "@forge/bridge";
import { isSelectType, formatNumber } from "../utils";
import { Icon } from "./Icons";

export function FieldOptionsModal({ fieldId, fieldName, fieldType, projectKeys, onClose }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    invoke("getFieldOptions", { fieldId, projectKeys: projectKeys || [] })
      .then((result) => { if (!cancelled) { setData(result); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err?.message || String(err)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [fieldId]);

  const allOptions = React.useMemo(
    () => (data?.optionsByContext || []).flatMap((ctx) => ctx.options),
    [data]
  );
  const hasUsage = allOptions.some((opt) => opt.issueCount != null);
  const maxCount = hasUsage ? Math.max(1, ...allOptions.map((o) => o.issueCount || 0)) : 1;

  return createPortal(
    <div className="field-options-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="field-options-modal" onClick={(e) => e.stopPropagation()}>
        <div className="field-options-modal__header">
          <div>
            <div className="field-card__eyebrow">{fieldId}</div>
            <h3 style={{ margin: "4px 0 6px" }}>{fieldName}</h3>
            <span className="field-type-tag">{fieldType}</span>
          </div>
          <button className="field-options-modal__close" onClick={onClose} type="button" aria-label="Close">✕</button>
        </div>
        <div className="field-options-modal__body">
          {loading ? (
            <div className="empty-state empty-state--inline">Loading options{projectKeys?.length ? " and computing usage counts" : ""}…</div>
          ) : error ? (
            <div className="empty-state empty-state--inline">Failed to load options: {error}</div>
          ) : !data?.optionsByContext?.length ? (
            <div className="empty-state empty-state--inline">No contexts or options found for this field.</div>
          ) : data.optionsByContext.map((ctx) => (
            <div key={ctx.contextId} className="field-options-modal__context">
              <div className="field-options-modal__context-name">
                {ctx.contextName}{ctx.isGlobalContext ? " (global)" : ""}
                <span className="field-options-modal__option-chip">{ctx.options.length} option{ctx.options.length !== 1 ? "s" : ""}</span>
              </div>
              {ctx.fetchError ? (
                <div className="empty-state empty-state--inline" style={{ padding: "8px 0", color: "var(--danger, #c0392b)" }}>Failed to load options: {ctx.fetchError}</div>
              ) : ctx.options.length ? (
                <div className="field-options-modal__list">
                  {[...ctx.options]
                    .sort((a, b) => (b.issueCount ?? -1) - (a.issueCount ?? -1) || a.value.localeCompare(b.value))
                    .map((opt) => {
                      const pct = hasUsage ? Math.max(3, Math.round(((opt.issueCount || 0) / maxCount) * 100)) : 0;
                      return (
                        <div key={opt.id} className={`field-options-modal__option${opt.disabled ? " field-options-modal__option--disabled" : ""}`}>
                          <span className="field-options-modal__option-name">{opt.value}{opt.disabled ? " (disabled)" : ""}</span>
                          {hasUsage ? (
                            <div className="field-options-modal__bar-row">
                              <div className="field-options-modal__bar-track">
                                <div className="field-options-modal__bar-fill" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="field-options-modal__count">{opt.issueCount != null ? formatNumber(opt.issueCount) : "—"}</span>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                </div>
              ) : (
                <div className="empty-state empty-state--inline" style={{ padding: "8px 0" }}>No options defined in this context.</div>
              )}
            </div>
          ))}
        </div>
        {!loading && hasUsage && (
          <div className="field-options-modal__footer">
            {projectKeys?.length
              ? `Issue counts filtered to ${projectKeys.length} project${projectKeys.length !== 1 ? "s" : ""} in this report`
              : "Issue counts across all projects"}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
