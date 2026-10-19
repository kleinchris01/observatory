import React from "react";
import { invoke } from "@forge/bridge";
import { Icon } from "../Icons";
import { formatTimestamp } from "../../utils";

// Append-only record of privileged actions. Its own module because ConfigTab renders it
// and admin.jsx imports ConfigTab -- keeping it here avoids the cycle.

export function AuditLogPanel({ initialOutcome = "all" } = {}) {
  const [events, setEvents] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [outcomeFilter, setOutcomeFilter] = React.useState(initialOutcome);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await invoke("getAuditLog", { limit: 200 });
      setEvents(Array.isArray(res?.events) ? res.events : []);
    } catch (err) {
      setError(err?.message || "Failed to load the audit log.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Opened from a link that names a filter (the Overview's security banner): the reader came
  // for these rows, so load them rather than making them press the button first.
  React.useEffect(() => {
    if (initialOutcome !== "all") load();
  }, [initialOutcome, load]);

  const visible = React.useMemo(() => {
    if (!events) return [];
    if (outcomeFilter === "all") return events;
    return events.filter((e) => e.outcome === outcomeFilter);
  }, [events, outcomeFilter]);

  const deniedCount = React.useMemo(() => (events || []).filter((e) => e.outcome === "denied").length, [events]);

  return (
    <section className="admin-config-section audit-panel">
      <div className="audit-panel__header">
        <div>
          <h3 className="admin-config-section__title">Audit log</h3>
          <p className="admin-config-section__hint">
            Privileged actions and permission denials, newest first. Retained for 180 days. Routine admin reads are not
            recorded.
          </p>
        </div>
        <button className="secondary-button" type="button" onClick={load} disabled={loading}>
          <Icon name="refreshCw" size={13} />
          {loading ? "Loading…" : events ? "Refresh" : "Load audit log"}
        </button>
      </div>

      {error && (
        <div className="danger-zone__error" role="alert">
          {error}
        </div>
      )}

      {/* A denial means someone reached an admin resolver without admin permission --
          worth surfacing rather than leaving buried in a 200-row table. */}
      {deniedCount > 0 && (
        <div className="audit-panel__alert" role="status">
          <Icon name="alertTriangle" size={13} />
          {deniedCount} permission {deniedCount === 1 ? "denial" : "denials"} in this window. A denial means an admin
          resolver was reached by a caller without Jira admin permission.
        </div>
      )}

      {events && events.length > 0 && (
        <div className="audit-panel__filters">
          {["all", "allowed", "denied", "failed"].map((value) => (
            <button
              key={value}
              type="button"
              className={`audit-filter ${outcomeFilter === value ? "audit-filter--active" : ""}`}
              onClick={() => setOutcomeFilter(value)}
            >
              {value === "all" ? "All" : value.charAt(0).toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
      )}

      {events && events.length === 0 && (
        <div className="empty-state">No audit events recorded yet. Privileged actions appear here once performed.</div>
      )}

      {events && events.length > 0 && (
        <div className="audit-panel__scroll">
          <table className="audit-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Outcome</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((event, i) => (
                <tr key={`${event.at}-${i}`}>
                  <td className="audit-table__when">{formatTimestamp(event.at)}</td>
                  <td className="audit-table__actor" title={event.actorId || "unknown"}>
                    {event.actorId || "—"}
                  </td>
                  <td className="audit-table__action">{event.action}</td>
                  <td>
                    <span className={`audit-outcome audit-outcome--${event.outcome}`}>{event.outcome}</span>
                  </td>
                  <td className="audit-table__detail">{event.detail || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 && <div className="empty-state">No {outcomeFilter} events in this window.</div>}
        </div>
      )}
    </section>
  );
}
