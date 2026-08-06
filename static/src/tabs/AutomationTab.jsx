import React from "react";
import { invoke } from "@forge/bridge";
import { formatRelativeTime, formatNumber } from "../utils";
import { BarList, Chip, EmptyState, FindingRow, Panel, StatRow, StatTile } from "../components/ui";
import { analyzeRules } from "../../../src/lib/automation-analysis";

// Governance view over the site's Jira Automation rules.
//
// The rest of the app tells you a field is unused or a status is unreachable. Neither
// claim looks at automation, and both are wrong if a rule writes that field or transitions
// into that status. This tab is where that blind spot gets reported.

const SEVERITY_TONE = {
  high: "danger",
  medium: "warning",
  low: "info",
  info: "neutral",
};

const RISK_LABELS = {
  "embedded-credential": "Credential stored in plaintext",
  "no-actions": "Trigger with no actions",
  "external-http": "Sends data outside Atlassian",
  disabled: "Disabled",
};

// Trigger type ids are namespaced and unreadable in a chart axis.
const TRIGGER_LABELS = {
  "jira.issue.field.changed": "Field changed",
  "jira.issue.event.trigger:created": "Issue created",
  "jira.issue.event.trigger:transitioned": "Issue transitioned",
  "jira.jql.scheduled": "Scheduled (JQL)",
  "jira.manual.trigger.issue": "Manual",
  "jira.issue.event.trigger:updated": "Issue updated",
  "jira.issue.event.trigger:commented": "Comment added",
  "jira.incoming.webhook": "Incoming webhook",
  "cmdb.object.trigger": "Assets object changed",
};

export function triggerLabel(type) {
  if (!type) return "No trigger";
  return TRIGGER_LABELS[type] ?? type.replace(/^jira\./, "").replace(/[.:]/g, " ");
}

// Built as one string rather than a run of spans. Split across elements a screen reader
// announces "Field changed", "2", "project", "s" as separate fragments, and the assembled
// sentence is the part that carries the meaning.
export function findingDetailLine(rule) {
  const parts = [triggerLabel(rule.triggerType)];
  parts.push(rule.projectCount > 0 ? `${rule.projectCount} project${rule.projectCount === 1 ? "" : "s"}` : "site-wide");
  if (!rule.enabled) parts.push("disabled");
  return parts.join(" · ");
}

// Reads a rule export and derives the analysis in the browser.
//
// The export is ~10 MB and the backend cannot fetch rules itself yet, so the parsing and
// analysis happen here and only the finished document -- around 130 KB -- is sent to be
// stored. Shipping the raw file through invoke() would be a hundredfold larger payload for
// the same result.
export async function analyzeExportFile(file, { now = Date.now() } = {}) {
  const text = await file.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON. Export the rules again from Jira and retry.");
  }

  const rules = payload?.rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error("That file has no rules in it. Pick the automation-rules export from Jira, not another JSON file.");
  }

  return analyzeRules(rules, { source: file.name || "export-file", now });
}

export function AutomationTab() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [severityFilter, setSeverityFilter] = React.useState("all");
  const [search, setSearch] = React.useState("");
  const [importing, setImporting] = React.useState(false);
  const [importError, setImportError] = React.useState("");
  const fileInputRef = React.useRef(null);

  const load = React.useCallback(async () => {
    const result = await invoke("getAutomationInsights", {});
    setData(result);
    return result;
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    load()
      .catch((err) => {
        if (!cancelled) setError(err?.message || "Failed to load automation insights.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function handleImport(event) {
    const file = event.target.files?.[0];
    // Cleared immediately so picking the same file twice still fires a change event.
    event.target.value = "";
    if (!file) return;

    setImporting(true);
    setImportError("");
    try {
      const analysis = await analyzeExportFile(file);
      await invoke("saveAutomationAnalysis", { analysis });
      await load();
    } catch (err) {
      setImportError(err?.message || "Could not import that export.");
    } finally {
      setImporting(false);
    }
  }

  const importControl = (
    <div className="automation-import">
      <input
        type="file"
        accept="application/json,.json"
        ref={fileInputRef}
        onChange={handleImport}
        className="automation-import__input"
        aria-label="Automation rule export file"
      />
      <button
        type="button"
        className="automation-import__button"
        onClick={() => fileInputRef.current?.click()}
        disabled={importing}
      >
        {importing ? "Analyzing…" : data?.available ? "Re-import export" : "Import rule export"}
      </button>
      {importError ? <span className="automation-import__error">{importError}</span> : null}
    </div>
  );

  const findings = React.useMemo(() => {
    const rows = data?.findings ?? [];
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (severityFilter !== "all" && row.topSeverity !== severityFilter) return false;
      if (term && !String(row.name).toLowerCase().includes(term)) return false;
      return true;
    });
  }, [data, severityFilter, search]);

  if (loading) {
    return <div className="tab-loading">Loading automation insights…</div>;
  }

  if (error) {
    return (
      <EmptyState>
        <strong>Could not load automation insights.</strong>
        <div>{error}</div>
      </EmptyState>
    );
  }

  // Distinct from "the site has no problems". Nothing has been measured yet, and saying
  // "0 findings" here would be a claim the data does not support.
  if (!data?.available) {
    return (
      <EmptyState action={importControl}>
        <strong>No automation analysis yet.</strong>
        <div>
          Export your automation rules from Jira (Settings → System → Automation rules → Export)
          and import the file here. It is read in your browser, so the rules themselves never
          leave this page — only the summary is stored.
        </div>
      </EmptyState>
    );
  }

  const estate = data.estate ?? {};
  const disabledShare = estate.ruleCount ? Math.round((estate.disabledCount / estate.ruleCount) * 100) : 0;

  return (
    <div className="automation-tab">
      <StatRow>
        <StatTile label="Rules" value={formatNumber(estate.ruleCount ?? 0)} icon="zap" />
        <StatTile label="Enabled" value={formatNumber(estate.enabledCount ?? 0)} icon="checkCircle" tone="success" />
        <StatTile
          label="Disabled"
          value={formatNumber(estate.disabledCount ?? 0)}
          hint={`${disabledShare}% of the estate`}
          icon="x"
          tone={disabledShare >= 30 ? "warning" : "neutral"}
        />
        <StatTile label="Fields referenced" value={formatNumber(estate.fieldsReferenced ?? 0)} icon="layers" />
        <StatTile label="Statuses referenced" value={formatNumber(estate.statusesReferenced ?? 0)} icon="activity" />
      </StatRow>

      <div className="automation-tab__meta">
        <span>
          Analyzed {data.refreshedAt ? formatRelativeTime(data.refreshedAt) : "at an unknown time"}
          {data.source ? ` from ${data.source}` : ""}.
        </span>
        {importControl}
      </div>

      <Panel
        title="Rules that can trigger other rules"
        icon="refreshCw"
        description="A rule that writes a field another rule watches can start a cascade. Self-triggering rules write a field they themselves trigger on, and loop without a second rule involved."
      >
        {data.cascadesTotal > 0 ? (
          <>
            <StatRow>
              <StatTile label="Cascade paths" value={formatNumber(data.cascadesTotal)} icon="activity" />
              <StatTile
                label="Self-triggering"
                value={formatNumber(data.selfTriggeringTotal ?? 0)}
                icon="alertTriangle"
                tone={data.selfTriggeringTotal > 0 ? "warning" : "neutral"}
              />
            </StatRow>
            <ul className="automation-cascades">
              {data.cascades.slice(0, 25).map((cascade, i) => (
                <li key={`${cascade.sourceId}-${cascade.targetId}-${cascade.field}-${i}`} className="automation-cascades__row">
                  <Chip tone={cascade.selfTriggering ? "warning" : "neutral"}>
                    {cascade.selfTriggering ? "Self-triggering" : "Cascade"}
                  </Chip>
                  <span className="automation-cascades__field">{cascade.field}</span>
                  <span className="automation-cascades__rules">
                    {cascade.selfTriggering
                      ? `${cascade.sourceName ?? cascade.sourceId} writes and triggers on this field`
                      : `${cascade.sourceName ?? cascade.sourceId} → ${cascade.targetName ?? cascade.targetId}`}
                  </span>
                </li>
              ))}
            </ul>
            {data.cascadesTotal > data.cascades.length ? (
              <div className="automation-tab__truncation">
                Showing {formatNumber(data.cascades.length)} of {formatNumber(data.cascadesTotal)} cascade paths.
              </div>
            ) : null}
          </>
        ) : (
          <EmptyState inline>No rule writes a field that another rule triggers on.</EmptyState>
        )}
      </Panel>

      <Panel
        title="Trigger mix"
        icon="barChart"
        description="What wakes the site's rules up. A large scheduled share is worth checking against execution limits."
      >
        <BarList
          items={(estate.triggerBreakdown ?? []).slice(0, 8).map((row) => ({
            label: triggerLabel(row.type),
            count: row.count,
          }))}
          labelKey="label"
          valueKey="count"
          formatValue={(v) => formatNumber(v)}
          emptyMessage="No trigger data."
        />
      </Panel>

      <Panel
        title="Findings"
        icon="alertTriangle"
        description="Rules carrying something worth acting on."
        action={
          <div className="automation-tab__controls">
            <input
              type="search"
              className="automation-tab__search"
              placeholder="Search rule names…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search rule names"
            />
            <select
              className="automation-tab__filter"
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              aria-label="Filter by severity"
            >
              <option value="all">All severities</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
              <option value="info">Info</option>
            </select>
          </div>
        }
      >
        {findings.length === 0 ? (
          <EmptyState inline>
            {data.findingsTotal === 0 ? "No findings." : "No rules match this filter."}
          </EmptyState>
        ) : (
          <>
            {findings.map((rule) => (
              <FindingRow
                key={rule.id}
                tone={SEVERITY_TONE[rule.topSeverity] ?? "info"}
                title={rule.name || `Rule ${rule.id}`}
                detail={
                  <>
                    <span>{findingDetailLine(rule)}</span>
                    <div className="automation-finding__risks">
                      {rule.risks.map((risk) => (
                        <Chip key={risk.code} tone={SEVERITY_TONE[risk.severity] ?? "neutral"} title={risk.detail}>
                          {RISK_LABELS[risk.code] ?? risk.code}
                        </Chip>
                      ))}
                    </div>
                  </>
                }
              />
            ))}
            {data.findingsTotal > data.findings.length ? (
              <div className="automation-tab__truncation">
                Showing {formatNumber(data.findings.length)} of {formatNumber(data.findingsTotal)} rules with findings.
              </div>
            ) : null}
          </>
        )}
      </Panel>
    </div>
  );
}
