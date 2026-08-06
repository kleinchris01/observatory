import React from "react";
import { invoke } from "@forge/bridge";
import { formatRelativeTime, formatNumber, buildAutomationRuleUrl, handleJiraLinkClick } from "../utils";
import { BarList, Chip, EmptyState, FindingRow, Panel, StatRow, StatTile } from "../components/ui";
import { SubNavLayout } from "../components/admin/primitives";
import { Icon } from "../components/Icons";
import { analyzeRules, expandFinding, hydrateRuleDirectory } from "../../../src/lib/automation-analysis";

// Governance view over the site's Jira Automation rules.
//
// The rest of the app tells you a field is unused or a status is unreachable. Neither
// claim looks at automation, and both are wrong if a rule writes that field or transitions
// into that status. This tab is where that blind spot gets reported.
//
// Sectioned rather than one long scroll because the field index alone is 735 rows: the
// counts belong on the first screen, and the row-level detail belongs behind a click that
// also decides whether the 116 KB index is worth fetching at all.

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

// Direction is the whole point of the reference tables, so it gets consistent language and
// colour everywhere it appears. "Writes" is the one that blocks a deletion; the other two
// break if the field disappears but do not keep it alive.
export const DIRECTIONS = [
  { key: "write", label: "Writes", tone: "danger", hint: "Rules that set this. Deleting it breaks them and loses data they maintain." },
  { key: "read", label: "Reads", tone: "info", hint: "Rules that check this in a condition. They break if it is deleted." },
  { key: "trigger", label: "Triggers", tone: "warning", hint: "Rules that run when this changes." },
];

export function triggerLabel(type) {
  if (!type) return "No trigger";
  return TRIGGER_LABELS[type] ?? type.replace(/^jira\./, "").replace(/[.:]/g, " ");
}

export function findingDetailLine(rule) {
  const parts = [triggerLabel(rule.triggerType)];
  parts.push(rule.projectCount > 0 ? `${rule.projectCount} project${rule.projectCount === 1 ? "" : "s"}` : "site-wide");
  if (!rule.enabled) parts.push("disabled");
  return parts.join(" · ");
}

// Reads a rule export and derives every document in the browser.
//
// The export is ~10 MB and the backend cannot fetch rules itself yet, so parsing and
// analysis happen here and only the finished documents -- around 300 KB in total -- are
// sent to be stored.
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

// Order matters: the analysis is the document getAutomationInsights checks to decide
// whether anything has been built, so it goes last. A failure partway through leaves the
// tab on its empty state rather than showing an estate whose Fields section is missing.
export async function persistAnalysis(documents, { save = invoke } = {}) {
  await save("saveAutomationIndex", { part: "fields", document: documents.fields });
  await save("saveAutomationIndex", { part: "statuses", document: documents.statuses });
  await save("saveAutomationIndex", { part: "directory", document: documents.directory });
  await save("saveAutomationIndex", { part: "findings", document: documents.findings });
  await save("saveAutomationAnalysis", { analysis: documents.analysis });
}

// Detail sentences are rebuilt here rather than stored. The same "Rule is disabled and was
// last edited N days ago." was being kept 603 times, which is most of what pushed the
// findings past what a single KVS value holds.
export function riskDetail(risk) {
  switch (risk.code) {
    case "embedded-credential":
      return "Contains a credential stored in plaintext in Jira. Anyone who can view the rule can read it.";
    case "no-actions":
      return "Has a trigger but no actions, so it consumes execution budget without doing anything.";
    case "external-http":
      return risk.hosts?.length
        ? `Sends data outside Atlassian to: ${risk.hosts.join(", ")}.`
        : "Sends data outside Atlassian.";
    case "disabled":
      return risk.ageDays === null || risk.ageDays === undefined
        ? "Rule is disabled."
        : `Rule is disabled and was last edited ${risk.ageDays} days ago.`;
    default:
      return risk.code;
  }
}

// A rule name that opens the rule in Jira.
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

// ── Reference explorer ──────────────────────────────────────────────────────

// Proportional strip showing how a field or status is used. Three numbers in three columns
// are readable but not comparable at a glance; a bar makes "this one is almost all writes"
// visible without arithmetic.
function DirectionBar({ entry }) {
  const total = entry.writeCount + entry.readCount + entry.triggerCount;
  if (total === 0) return null;
  return (
    <div className="ref-bar" role="presentation">
      {DIRECTIONS.map(({ key, tone }) => {
        const count = entry[`${key}Count`];
        if (!count) return null;
        return (
          <span
            key={key}
            className={`ref-bar__seg ref-bar__seg--${tone}`}
            style={{ width: `${(count / total) * 100}%` }}
          />
        );
      })}
    </div>
  );
}

function ReferenceRow({ entry, expanded, onToggle, directory, siteOrigin }) {
  const total = entry.writeCount + entry.readCount + entry.triggerCount;

  return (
    <>
      <button
        type="button"
        className={`ref-row${expanded ? " ref-row--open" : ""}`}
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="ref-row__chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        <span className="ref-row__label" title={entry.label}>{entry.label}</span>
        <DirectionBar entry={entry} />
        {DIRECTIONS.map(({ key, label, tone }) => (
          <span key={key} className={`ref-row__count ref-row__count--${tone}`} title={`${label}: ${entry[`${key}Count`]}`}>
            {entry[`${key}Count`] || "–"}
          </span>
        ))}
        <span className="ref-row__total">{formatNumber(total)}</span>
      </button>

      {expanded ? (
        <div className="ref-detail">
          {DIRECTIONS.map(({ key, label, tone, hint }) => {
            const ids = entry[key] ?? [];
            const count = entry[`${key}Count`];
            if (!count) return null;
            return (
              <div key={key} className="ref-detail__group">
                <div className="ref-detail__heading">
                  <Chip tone={tone}>{label}</Chip>
                  <span className="ref-detail__count">{formatNumber(count)} rule{count === 1 ? "" : "s"}</span>
                  <span className="ref-detail__hint">{hint}</span>
                </div>
                <ul className="ref-detail__rules">
                  {ids.map((id) => {
                    const rule = directory?.get(id);
                    return (
                      <li key={id} className={rule && !rule.enabled ? "ref-detail__rule ref-detail__rule--disabled" : "ref-detail__rule"}>
                        <RuleLink id={id} name={rule?.name} siteOrigin={siteOrigin} className="ref-detail__name" />
                        {rule ? <span className="ref-detail__meta">{triggerLabel(rule.triggerType)}{rule.enabled ? "" : " · disabled"}</span> : null}
                      </li>
                    );
                  })}
                </ul>
                {/* The stored list is capped. Saying so beats implying these are all of them. */}
                {count > ids.length ? (
                  <div className="ref-detail__truncation">Showing {ids.length} of {formatNumber(count)}.</div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  );
}

const SORTS = [
  { key: "total", label: "Most referenced" },
  { key: "write", label: "Most written" },
  { key: "read", label: "Most read" },
  { key: "trigger", label: "Most triggered on" },
  { key: "label", label: "Name (A–Z)" },
];

export function sortEntries(entries, sortKey) {
  const rows = [...entries];
  if (sortKey === "label") return rows.sort((a, b) => String(a.label).localeCompare(String(b.label)));
  if (sortKey === "total") {
    return rows.sort((a, b) =>
      (b.writeCount + b.readCount + b.triggerCount) - (a.writeCount + a.readCount + a.triggerCount)
    );
  }
  return rows.sort((a, b) => b[`${sortKey}Count`] - a[`${sortKey}Count`]);
}

function ReferenceExplorer({ noun, index, directory, loading, error, onRetry, siteOrigin }) {
  const [search, setSearch] = React.useState("");
  const [sortKey, setSortKey] = React.useState("total");
  const [expanded, setExpanded] = React.useState(null);
  const [limit, setLimit] = React.useState(50);

  const rows = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = (index?.entries ?? []).filter((e) => !term || String(e.label).toLowerCase().includes(term));
    return sortEntries(filtered, sortKey);
  }, [index, search, sortKey]);

  if (loading) return <div className="tab-loading">Loading {noun} references…</div>;
  if (error) {
    return (
      <EmptyState action={<button type="button" className="ui-button" onClick={onRetry}>Retry</button>}>
        <strong>Could not load {noun} references.</strong>
        <div>{error}</div>
      </EmptyState>
    );
  }
  if (!index?.entries?.length) {
    return <EmptyState inline>No {noun} references recorded. Re-import the export to build this index.</EmptyState>;
  }

  const visible = rows.slice(0, limit);

  return (
    <div className="ref-explorer">
      <div className="ref-toolbar">
        <input
          type="search"
          className="ui-input"
          placeholder={`Search ${noun}…`}
          value={search}
          onChange={(e) => { setSearch(e.target.value); setLimit(50); }}
          aria-label={`Search ${noun}`}
        />
        <select
          className="ui-input"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value)}
          aria-label={`Sort ${noun}`}
        >
          {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <span className="ref-toolbar__count">
          {search ? `${formatNumber(rows.length)} of ${formatNumber(index.total)}` : `${formatNumber(index.total)} ${noun}`}
        </span>
      </div>

      <div className="ref-head" aria-hidden="true">
        <span />
        <span>{noun === "fields" ? "Field" : "Status"}</span>
        <span>Mix</span>
        {DIRECTIONS.map((d) => <span key={d.key} className="ref-head__num">{d.label}</span>)}
        <span className="ref-head__num">Total</span>
      </div>

      <div className="ref-list">
        {visible.length === 0 ? (
          <EmptyState inline>Nothing matches “{search}”.</EmptyState>
        ) : (
          visible.map((entry) => (
            <ReferenceRow
              key={entry.label}
              entry={entry}
              directory={directory}
              siteOrigin={siteOrigin}
              expanded={expanded === entry.label}
              onToggle={() => setExpanded(expanded === entry.label ? null : entry.label)}
            />
          ))
        )}
      </div>

      {rows.length > visible.length ? (
        <button type="button" className="ui-button ui-button--quiet ref-more" onClick={() => setLimit(limit + 100)}>
          Show more — {formatNumber(rows.length - visible.length)} remaining
        </button>
      ) : null}
    </div>
  );
}

// ── Cascades ────────────────────────────────────────────────────────────────

// Grouped by source rule rather than listed per edge.
//
// One row per edge produced 25 consecutive lines reading "Auto-Populate Child Fields from
// Parent Story writes and triggers on this field", which is the same fact restated for each
// of ten fields. Grouping turns that into one row naming the rule and the fields it loops on.
export function groupCascades(cascades = []) {
  const bySource = new Map();
  for (const c of cascades) {
    const key = `${c.sourceId}|${c.selfTriggering ? "self" : c.targetId}`;
    if (!bySource.has(key)) {
      bySource.set(key, {
        key,
        sourceId: c.sourceId,
        sourceName: c.sourceName,
        targetId: c.targetId,
        targetName: c.targetName,
        selfTriggering: c.selfTriggering,
        fields: [],
      });
    }
    const group = bySource.get(key);
    if (!group.fields.includes(c.field)) group.fields.push(c.field);
  }
  return [...bySource.values()].sort((a, b) => {
    if (a.selfTriggering !== b.selfTriggering) return a.selfTriggering ? -1 : 1;
    return b.fields.length - a.fields.length;
  });
}

function CascadeSection({ data, siteOrigin }) {
  const groups = React.useMemo(() => groupCascades(data.cascades), [data.cascades]);

  if (!data.cascadesTotal) {
    return <EmptyState inline>No rule writes a field that another rule triggers on.</EmptyState>;
  }

  return (
    <>
      <StatRow>
        <StatTile label="Cascade paths" value={formatNumber(data.cascadesTotal)} icon="activity" />
        <StatTile
          label="Self-triggering rules"
          value={formatNumber(data.selfTriggeringTotal ?? 0)}
          hint="Write a field they also trigger on"
          icon="alertTriangle"
          tone={data.selfTriggeringTotal > 0 ? "warning" : "neutral"}
        />
        <StatTile label="Distinct rule pairs" value={formatNumber(groups.length)} icon="layers" />
      </StatRow>

      <div className="cascade-list">
        {groups.map((g) => (
          <div key={g.key} className={`cascade${g.selfTriggering ? " cascade--self" : ""}`}>
            <div className="cascade__head">
              <Chip tone={g.selfTriggering ? "warning" : "neutral"}>
                {g.selfTriggering ? "Self-triggering" : "Cascade"}
              </Chip>
              <RuleLink id={g.sourceId} name={g.sourceName} siteOrigin={siteOrigin} className="cascade__rule" />
              {!g.selfTriggering ? (
                <>
                  <span className="cascade__arrow" aria-label="triggers">→</span>
                  <RuleLink id={g.targetId} name={g.targetName} siteOrigin={siteOrigin} className="cascade__rule" />
                </>
              ) : null}
            </div>
            <div className="cascade__fields">
              <span className="cascade__via">via</span>
              {g.fields.map((f) => <Chip key={f}>{f}</Chip>)}
            </div>
          </div>
        ))}
      </div>

      {data.cascadesTotal > data.cascades.length ? (
        <div className="ui-truncation">
          Showing {formatNumber(data.cascades.length)} of {formatNumber(data.cascadesTotal)} cascade paths.
        </div>
      ) : null}
    </>
  );
}

// ── Findings ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

// Filters the UI can offer without another round trip, because the whole findings list is
// already in memory. Each is a facet over the same rows rather than a separate query.
export function filterFindings(findings, { search = "", severity = "all", risk = "all", state = "all", trigger = "all" } = {}) {
  const term = search.trim().toLowerCase();
  return findings.filter((row) => {
    if (severity !== "all" && row.topSeverity !== severity) return false;
    if (risk !== "all" && !row.risks.some((r) => r.code === risk)) return false;
    if (state === "enabled" && !row.enabled) return false;
    if (state === "disabled" && row.enabled) return false;
    if (trigger !== "all" && row.triggerType !== trigger) return false;
    if (term) {
      // Field names are searched too: "which rules write Story Points and have a finding"
      // is a question people arrive with, and rule names rarely contain the field.
      const haystack = `${row.name} ${(row.writesFields ?? []).join(" ")}`.toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });
}

function FindingsSection({ data, findings, loading, error, onRetry, siteOrigin }) {
  const [filters, setFilters] = React.useState({ search: "", severity: "all", risk: "all", state: "all", trigger: "all" });
  const [page, setPage] = React.useState(0);

  const setFilter = (key, value) => {
    setFilters((f) => ({ ...f, [key]: value }));
    // Staying on page 8 of a list that just became two pages long shows an empty screen.
    setPage(0);
  };

  const rows = React.useMemo(() => filterFindings(findings ?? [], filters), [findings, filters]);

  // Offered only where they exist, so the dropdowns never list a filter that matches nothing.
  const triggerOptions = React.useMemo(() => {
    const seen = new Map();
    for (const row of findings ?? []) if (row.triggerType) seen.set(row.triggerType, triggerLabel(row.triggerType));
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [findings]);

  const riskOptions = React.useMemo(() => {
    const seen = new Set();
    for (const row of findings ?? []) for (const r of row.risks) seen.add(r.code);
    return [...seen];
  }, [findings]);

  if (loading) return <div className="tab-loading">Loading findings…</div>;
  if (error) {
    return (
      <EmptyState action={<button type="button" className="ui-button" onClick={onRetry}>Retry</button>}>
        <strong>Could not load findings.</strong>
        <div>{error}</div>
      </EmptyState>
    );
  }
  if (!findings?.length) {
    return (
      <EmptyState inline>
        {data.findingsTotal === 0 ? "No findings." : "Findings have not been indexed. Re-import the export to build this list."}
      </EmptyState>
    );
  }

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const visible = rows.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);

  return (
    <>
      <div className="ref-toolbar">
        <input
          type="search"
          className="ui-input"
          placeholder="Search rule or field names…"
          value={filters.search}
          onChange={(e) => setFilter("search", e.target.value)}
          aria-label="Search rule names"
        />
        <select className="ui-input" value={filters.severity} onChange={(e) => setFilter("severity", e.target.value)} aria-label="Filter by severity">
          <option value="all">All severities</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="info">Info</option>
        </select>
        <select className="ui-input" value={filters.risk} onChange={(e) => setFilter("risk", e.target.value)} aria-label="Filter by finding">
          <option value="all">All findings</option>
          {riskOptions.map((code) => <option key={code} value={code}>{RISK_LABELS[code] ?? code}</option>)}
        </select>
        <select className="ui-input" value={filters.state} onChange={(e) => setFilter("state", e.target.value)} aria-label="Filter by rule state">
          <option value="all">Enabled and disabled</option>
          <option value="enabled">Enabled only</option>
          <option value="disabled">Disabled only</option>
        </select>
        <select className="ui-input" value={filters.trigger} onChange={(e) => setFilter("trigger", e.target.value)} aria-label="Filter by trigger">
          <option value="all">All triggers</option>
          {triggerOptions.map(([type, label]) => <option key={type} value={type}>{label}</option>)}
        </select>
        <span className="ref-toolbar__count">
          {rows.length === findings.length
            ? `${formatNumber(findings.length)} rules`
            : `${formatNumber(rows.length)} of ${formatNumber(findings.length)}`}
        </span>
      </div>

      {rows.length === 0 ? (
        <EmptyState inline>No rules match these filters.</EmptyState>
      ) : (
        <>
          {visible.map((rule) => (
            <FindingRow
              key={rule.id}
              tone={SEVERITY_TONE[rule.topSeverity] ?? "info"}
              title={<RuleLink id={rule.id} name={rule.name} siteOrigin={siteOrigin} />}
              detail={
                <>
                  <span>{findingDetailLine(rule)}</span>
                  <div className="automation-finding__risks">
                    {rule.risks.map((risk) => (
                      <Chip key={risk.code} tone={SEVERITY_TONE[risk.severity] ?? "neutral"} title={riskDetail(risk)}>
                        {RISK_LABELS[risk.code] ?? risk.code}
                      </Chip>
                    ))}
                  </div>
                </>
              }
            />
          ))}

          <Pager page={current} pageCount={pageCount} total={rows.length} onChange={setPage} />
        </>
      )}
    </>
  );
}

export function Pager({ page, pageCount, total, onChange }) {
  if (pageCount <= 1) {
    return <div className="ui-truncation">All {formatNumber(total)} shown.</div>;
  }
  const from = page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);

  return (
    <nav className="pager" aria-label="Findings pages">
      <button type="button" className="ui-button ui-button--quiet" onClick={() => onChange(page - 1)} disabled={page === 0}>
        ← Previous
      </button>
      <span className="pager__status">
        {formatNumber(from)}–{formatNumber(to)} of {formatNumber(total)}
      </span>
      <button
        type="button"
        className="ui-button ui-button--quiet"
        onClick={() => onChange(page + 1)}
        disabled={page >= pageCount - 1}
      >
        Next →
      </button>
    </nav>
  );
}

// ── Tab ─────────────────────────────────────────────────────────────────────

export function AutomationTab({ siteOrigin }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [section, setSection] = React.useState("overview");
  const [importing, setImporting] = React.useState(false);
  const [importError, setImportError] = React.useState("");
  const fileInputRef = React.useRef(null);

  // Fetched only when a section that needs them is opened. The field index is ~116 KB and
  // most visits never leave the overview.
  const [indexes, setIndexes] = React.useState({});
  const [directory, setDirectory] = React.useState(null);
  const [indexState, setIndexState] = React.useState({});

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
    return () => { cancelled = true; };
  }, [load]);

  const loadIndex = React.useCallback(async (part) => {
    setIndexState((s) => ({ ...s, [part]: { loading: true, error: "" } }));
    try {
      // The directory rides along with the first index fetched: without it the drill-down
      // shows numeric rule ids, which is not an answer to "where does this occur".
      const [doc, dir] = await Promise.all([
        invoke("getAutomationIndex", { part }),
        directory ? Promise.resolve(null) : invoke("getAutomationIndex", { part: "directory" }),
      ]);
      setIndexes((m) => ({ ...m, [part]: doc }));
      if (dir?.available) setDirectory(hydrateRuleDirectory({ rules: dir.rules }));
      setIndexState((s) => ({ ...s, [part]: { loading: false, error: "" } }));
    } catch (err) {
      setIndexState((s) => ({ ...s, [part]: { loading: false, error: err?.message || "Failed to load." } }));
    }
  }, [directory]);

  React.useEffect(() => {
    const part = ["fields", "statuses", "findings"].includes(section) ? section : null;
    if (!part || !data?.available) return;
    // A previous error counts as settled. Without this the effect re-runs the moment the
    // failure is recorded -- nothing is cached and nothing is loading -- and retries in a
    // tight loop for as long as the section is open. Retrying is the Retry button's job.
    if (indexes[part] || indexState[part]?.loading || indexState[part]?.error) return;
    loadIndex(part);
  }, [section, data, indexes, indexState, loadIndex]);

  // Findings are stored compact -- single-letter keys, no detail sentences -- so 675 rows
  // fit in one value. Expanded once when the document arrives, not on every keystroke in
  // the filter box.
  const findingRows = React.useMemo(
    () => (indexes.findings ? indexes.findings.findings.map(expandFinding) : null),
    [indexes.findings]
  );

  async function handleImport(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setImporting(true);
    setImportError("");
    try {
      const documents = await analyzeExportFile(file);
      await persistAnalysis(documents);
      // Everything downstream is rebuilt, so cached indexes from the previous import must go.
      setIndexes({});
      setDirectory(null);
      setIndexState({});
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
        className="ui-button"
        onClick={() => fileInputRef.current?.click()}
        disabled={importing}
      >
        {importing ? "Analyzing…" : data?.available ? "Re-import export" : "Import rule export"}
      </button>
      {importError ? <span className="automation-import__error">{importError}</span> : null}
    </div>
  );

  if (loading) return <div className="tab-loading">Loading automation insights…</div>;

  if (error) {
    return (
      <EmptyState>
        <strong>Could not load automation insights.</strong>
        <div>{error}</div>
      </EmptyState>
    );
  }

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

  const items = [
    { key: "overview", label: "Overview", icon: "barChart" },
    { key: "fields", label: "Fields", icon: "layers", badge: formatNumber(estate.fieldsReferenced ?? 0) },
    { key: "statuses", label: "Statuses", icon: "activity", badge: formatNumber(estate.statusesReferenced ?? 0) },
    { key: "cascades", label: "Cascades", icon: "refreshCw", badge: formatNumber(data.cascadesTotal ?? 0) },
    { key: "findings", label: "Findings", icon: "alertTriangle", badge: formatNumber(data.findingsTotal ?? 0) },
  ];

  return (
    <div className="automation-tab">
      <div className="automation-tab__meta">
        <span>
          Analyzed {data.refreshedAt ? formatRelativeTime(data.refreshedAt) : "at an unknown time"}
          {data.source ? ` from ${data.source}` : ""}.
        </span>
        {importControl}
      </div>

      <SubNavLayout items={items} activeKey={section} onSelect={setSection}>
        {section === "overview" ? (
          <>
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

            <Panel
              title="What automation depends on"
              icon="layers"
              description="Every field and status these rules read, write or trigger on. A field automation writes is not safe to delete, whatever the Field Browser says about its usage."
            >
              <div className="dep-summary">
                {[
                  { label: "Fields", count: estate.fieldsReferenced ?? 0, key: "fields" },
                  { label: "Statuses", count: estate.statusesReferenced ?? 0, key: "statuses" },
                ].map((row) => (
                  <button key={row.key} type="button" className="dep-summary__card" onClick={() => setSection(row.key)}>
                    <span className="dep-summary__count">{formatNumber(row.count)}</span>
                    <span className="dep-summary__label">{row.label} referenced</span>
                    <span className="dep-summary__cta">Browse {row.label.toLowerCase()} →</span>
                  </button>
                ))}
              </div>
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
          </>
        ) : section === "fields" ? (
          <Panel
            title="Fields automation depends on"
            icon="layers"
            description="Expand a field to see exactly which rules touch it, and in which direction."
          >
            <ReferenceExplorer
              noun="fields"
              index={indexes.fields}
              directory={directory}
              loading={indexState.fields?.loading}
              error={indexState.fields?.error}
              onRetry={() => loadIndex("fields")}
              siteOrigin={siteOrigin}
            />
          </Panel>
        ) : section === "statuses" ? (
          <Panel
            title="Statuses automation depends on"
            icon="activity"
            description="Expand a status to see which rules transition into it, condition on it, or fire when an issue reaches it."
          >
            <ReferenceExplorer
              noun="statuses"
              index={indexes.statuses}
              directory={directory}
              loading={indexState.statuses?.loading}
              error={indexState.statuses?.error}
              onRetry={() => loadIndex("statuses")}
              siteOrigin={siteOrigin}
            />
          </Panel>
        ) : section === "cascades" ? (
          <Panel
            title="Rules that can trigger other rules"
            icon="refreshCw"
            description="A rule that writes a field another rule watches can start a cascade. Self-triggering rules write a field they themselves trigger on, and loop without a second rule involved."
          >
            <CascadeSection data={data} siteOrigin={siteOrigin} />
          </Panel>
        ) : (
          <Panel
            title="Findings"
            icon="alertTriangle"
            description="Every rule carrying something worth acting on. Filter by severity, finding type, state or trigger; search matches rule names and the fields a rule writes."
          >
            <FindingsSection
              data={data}
              findings={findingRows}
              loading={indexState.findings?.loading}
              error={indexState.findings?.error}
              onRetry={() => loadIndex("findings")}
              siteOrigin={siteOrigin}
            />
          </Panel>
        )}
      </SubNavLayout>
    </div>
  );
}
