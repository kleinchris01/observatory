import React from "react";
import { invoke } from "@forge/bridge";
import { StatRow, StatTile, Panel, EmptyState, Chip, JiraLink } from "../components/ui";
import { buildIssueUrl, formatNumber } from "../utils";

// "Did it hold?": every remediation task checked against the latest scan
// (getRemediationVerification, src/lib/remediation-verify.js). Closed tasks whose item is no
// longer flagged are proven; closed tasks still flagged regressed; open tasks already fixed can
// close. Moving a ticket is an explicit admin action with an in-page confirmation, never
// automatic, and leaves a comment on each ticket saying why.

const GROUPS = [
  {
    verdict: "regressed",
    title: "Closed, but still flagged",
    description: "The task was closed and the latest scan still flags its item. The fix did not hold, or was never made.",
    action: "Reopen with evidence",
    tone: "critical",
  },
  {
    verdict: "fixed-open",
    title: "Fixed, but still open",
    description: "The latest scan no longer flags the item. Anyone working this task is working stale advice.",
    action: "Close as fixed",
    tone: "warning",
  },
];

function VerificationGroup({ group, rows, labels, siteOrigin, selected, onToggle, onToggleAll, onAct, busy }) {
  if (!rows.length) return null;
  const chosen = rows.filter((r) => selected.has(r.issueKey));
  return (
    <Panel
      title={`${group.title} (${formatNumber(rows.length)})`}
      icon={group.verdict === "regressed" ? "alertTriangle" : "checkCircle"}
      description={group.description}
      action={
        <button type="button" className="secondary-button" disabled={busy || !chosen.length} onClick={() => onAct(group, chosen)}>
          {group.action}{chosen.length ? ` (${chosen.length})` : ""}
        </button>
      }
    >
      <label className="verify-selectall">
        <input
          type="checkbox"
          id={`verify-all-${group.verdict}`}
          checked={chosen.length === rows.length}
          onChange={() => onToggleAll(rows, chosen.length !== rows.length)}
        />{" "}
        Select all
      </label>
      <ul className="verify-list">
        {rows.map((r) => (
          <li key={r.issueKey}>
            <label>
              <input type="checkbox" id={`verify-${r.issueKey}`} checked={selected.has(r.issueKey)} onChange={() => onToggle(r.issueKey)} />{" "}
              {siteOrigin ? <JiraLink href={buildIssueUrl(siteOrigin, r.issueKey)} title={`Open ${r.issueKey} in Jira`}>{r.issueKey}</JiraLink> : r.issueKey}
            </label>
            <span className="verify-list__summary">{r.summary || r.itemId}</span>
            <Chip tone="neutral">{labels?.[r.findingKey] || r.findingKey}</Chip>
            <span className="verify-list__meta">{r.status || "—"}{r.period ? ` · ${r.period}` : ""}{r.assigneeName ? ` · ${r.assigneeName}` : ""}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function RemediationVerification({ siteOrigin = "", load = invoke }) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [selected, setSelected] = React.useState(() => new Set());
  const [pending, setPending] = React.useState(null); // { group, rows } awaiting confirmation
  const [busy, setBusy] = React.useState(false);
  const [outcome, setOutcome] = React.useState(null);

  const refresh = React.useCallback(async () => {
    setError(null);
    try {
      setData(await load("getRemediationVerification", {}));
    } catch (err) {
      setError(err?.message || "Could not check the remediation tasks.");
    }
  }, [load]);
  React.useEffect(() => { refresh(); }, [refresh]);

  const toggle = (key) => setSelected((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const toggleAll = (rows, on) => setSelected((s) => { const n = new Set(s); rows.forEach((r) => (on ? n.add(r.issueKey) : n.delete(r.issueKey))); return n; });

  async function confirm() {
    const { rows } = pending;
    setBusy(true);
    setPending(null);
    try {
      const result = await load("applyRemediationVerification", { issueKeys: rows.map((r) => r.issueKey) });
      setOutcome(result);
      setSelected(new Set());
      await refresh();
    } catch (err) {
      setOutcome({ error: err?.message || "Jira did not accept the change." });
    } finally {
      setBusy(false);
    }
  }

  if (error) return <EmptyState inline>{error}</EmptyState>;
  if (!data) return <EmptyState inline>Checking every remediation task against the latest scan…</EmptyState>;
  const rows = data.rows || [];
  const counts = data.counts || {};
  if (!rows.length) return <EmptyState inline>No remediation tasks yet. Create some from the Findings view, then come back after the next scan.</EmptyState>;

  const byVerdict = (v) => rows.filter((r) => r.verdict === v);
  return (
    <>
      <StatRow>
        <StatTile label="Fixes that held" value={formatNumber(counts.held || 0)} tone={counts.held ? "success" : "neutral"} icon="checkCircle"
          hint={typeof data.heldRate === "number" ? `${Math.round(data.heldRate * 100)}% of closed tasks` : "nothing closed yet"} />
        <StatTile label="Closed, still flagged" value={formatNumber(counts.regressed || 0)} tone={counts.regressed ? "critical" : "neutral"} icon="alertTriangle" />
        <StatTile label="Fixed, still open" value={formatNumber(counts["fixed-open"] || 0)} tone={counts["fixed-open"] ? "warning" : "neutral"} icon="clock" />
        <StatTile label="Open and still flagged" value={formatNumber(counts.open || 0)} tone="active" icon="wrench"
          hint={counts.unverified ? `${counts.unverified} could not be checked` : null} />
      </StatRow>
      <p className="remediation-history">Checked against the latest scan {String(data.checkedAt || "").slice(0, 16).replace("T", " ")} UTC.</p>

      {pending && (
        <div className="verify-confirm" role="alertdialog" aria-label="Confirm the change in Jira">
          <p>
            {pending.group.verdict === "regressed" ? "Reopen" : "Close"} {pending.rows.length} ticket{pending.rows.length === 1 ? "" : "s"} in Jira,
            as you, with a comment on each explaining why. Each verdict is checked again before anything moves.
          </p>
          <button type="button" className="primary-button" onClick={confirm}>{pending.group.action}</button>{" "}
          <button type="button" className="secondary-button" onClick={() => setPending(null)}>Cancel</button>
        </div>
      )}
      {outcome && (
        <p className="remediation-history" role="status">
          {outcome.error
            ? outcome.error
            : `${outcome.applied} ticket${outcome.applied === 1 ? "" : "s"} moved.${(outcome.results || []).filter((r) => !r.transitioned).map((r) => ` ${r.issueKey}: ${r.reason}`).join("")}`}
        </p>
      )}

      {GROUPS.map((group) => (
        <VerificationGroup
          key={group.verdict}
          group={group}
          rows={byVerdict(group.verdict)}
          labels={data.labels}
          siteOrigin={siteOrigin}
          selected={selected}
          onToggle={toggle}
          onToggleAll={toggleAll}
          onAct={(g, chosen) => setPending({ group: g, rows: chosen })}
          busy={busy}
        />
      ))}
      {!byVerdict("regressed").length && !byVerdict("fixed-open").length && (
        <EmptyState inline>Every closed task held, and no open task is already fixed.</EmptyState>
      )}
    </>
  );
}
