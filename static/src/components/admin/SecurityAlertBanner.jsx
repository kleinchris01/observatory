import React from "react";
import { invoke } from "@forge/bridge";
import { Icon } from "../Icons";
import { useVisiblePolling } from "../../hooks";
import { formatRelativeTime } from "../../utils";

// The Overview's security alert: shown only while the admin guard is refusing more calls than
// an honest mistake explains (getSecuritySignals, same rule as the `security.denial_burst`
// log event). Every refused call was already blocked; this exists so a person finds out
// someone is probing the admin resolvers without having to open the audit log.
//
// One indexed count per poll, so five minutes is cheap; the poll pauses while the tab is hidden.
export const SECURITY_SIGNALS_POLL_MS = 5 * 60 * 1000;

export function SecurityAlertBanner({ onNavigate }) {
  const [signals, setSignals] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      setSignals(await invoke("getSecuritySignals"));
    } catch {
      setSignals({ ok: false, unavailable: "Recent permission denials could not be checked just now." });
    }
  }, []);

  useVisiblePolling(true, load, SECURITY_SIGNALS_POLL_MS);

  if (!signals) return null;

  // Silence is not all-clear: say the check failed rather than show nothing.
  if (!signals.ok) {
    return (
      <div className="admin-security-banner admin-security-banner--unavailable" role="status">
        <Icon name="alertTriangle" size={15} />
        <span>{signals.unavailable || "Recent permission denials could not be checked just now."}</span>
      </div>
    );
  }

  const d = signals.denials || {};
  if (!d.burst) return null;

  const accounts = `${d.actors} ${d.actors === 1 ? "account" : "accounts"}`;
  return (
    <div className="admin-security-banner" role="alert">
      <div className="admin-security-banner__body">
        <Icon name="alertTriangle" size={15} />
        <div>
          <strong>
            {d.denials} permission denials in the last {d.windowMinutes} minutes, from {accounts}.
          </strong>{" "}
          Someone without Jira admin permission is calling admin functions directly. Every call was refused; review who
          it was in the audit log.
          {d.latestAt && <span className="admin-security-banner__when"> Latest {formatRelativeTime(d.latestAt)}.</span>}
        </div>
      </div>
      <button
        type="button"
        className="primary-button"
        onClick={() => onNavigate?.("config", { area: "diagnostics", auditOutcome: "denied" })}
      >
        Review denials
      </button>
    </div>
  );
}
