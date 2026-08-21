import React from "react";
import { invoke } from "@forge/bridge";
import { formatRelativeTime, formatNumber } from "../utils";
import { BarList, Chip, EmptyState, FindingRow, Panel, RuleLink, SortFilterBar, StatRow, StatTile } from "../components/ui";
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
  // Cascades go after the directory, because the cascade views join to it for rule names --
  // and before the analysis, which is the commit point.
  await save("saveAutomationIndex", { part: "cascades", document: documents.cascades });
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
//
// Two questions, and the tab used to answer neither properly.
//
// "Which rules wake which" was answered with the first 150 of this site's 1,457 edges,
// because that is what fits in the analysis document beside everything else it carries. The
// remaining 1,307 were unreachable by any amount of scrolling, under a footnote saying so.
//
// "What happens after that" was not answered at all. cascade-graph.js has found loops and
// multi-hop chains since it was written and nothing imported it, because a walk over an edge
// set truncated at 150 does not find shorter chains -- it finds wrong ones, stopping wherever
// the truncation landed.
//
// Both now read from automation_cascades, where every edge is a row.

const CASCADE_PAGE_SIZE = 50;

const CASCADE_KINDS = [
  { value: "all", label: "All cascades" },
  { value: "self", label: "Self-triggering only" },
  { value: "cross", label: "Between rules only" },
];

// One relationship: the rules at each end, and every field that carries a hop between them.
//
// Two rules linked by three fields are one relationship an admin can break, not three rows.
// The grouping happens in SQL now rather than in the browser -- grouping a PAGE of a larger
// set would split one relationship across a page boundary and render it twice.
export function CascadeRow({ cascade, siteOrigin, onFocusRule }) {
  const { selfTriggering, sourceId, sourceName, targetId, targetName, fields } = cascade;

  return (
    <div className={`cascade${selfTriggering ? " cascade--self" : ""}`}>
      <div className="cascade__head">
        <Chip tone={selfTriggering ? "warning" : "neutral"}>
          {selfTriggering ? "Self-triggering" : "Cascade"}
        </Chip>
        <RuleLink id={sourceId} name={sourceName} siteOrigin={siteOrigin} className="cascade__rule" />
        {!selfTriggering && (
          <>
            <span className="cascade__arrow" aria-label="triggers">→</span>
            <RuleLink id={targetId} name={targetName} siteOrigin={siteOrigin} className="cascade__rule" />
          </>
        )}
        {/* The way from one relationship into everything the target is caught up in. This is
            how a reader walks a chain by hand when the graph view is too dense to read. */}
        {onFocusRule && !selfTriggering && (
          <button
            type="button"
            className="cascade__focus"
            onClick={() => onFocusRule(targetId, targetName)}
            title={`Show what "${targetName}" goes on to trigger`}
          >
            then what?
          </button>
        )}
      </div>
      <div className="cascade__fields">
        <span className="cascade__via">via</span>
        {fields.map((f) => <Chip key={f}>{f}</Chip>)}
      </div>
    </div>
  );
}

// A walk through several rules, as a path a person can trace in the automation admin.
//
// The form matters more than the fact. "These five rules can all reach each other" is true
// and useless; "A writes Owner, which wakes B, which writes Status, which wakes C" is the
// same fact in the shape somebody can act on, and every hop names the field to break.
export function CascadePath({ steps, siteOrigin, loop = false }) {
  return (
    <ol className={`cascade-path${loop ? " cascade-path--loop" : ""}`}>
      {steps.map((step, index) => (
        <li key={`${step.id}-${index}`} className="cascade-path__step">
          <span className="cascade-path__ordinal">{index + 1}</span>
          <RuleLink id={step.id} name={step.name} siteOrigin={siteOrigin} className="cascade-path__rule" />
          {step.enabled === false && <Chip tone="neutral">disabled</Chip>}
          {step.viaFields?.length > 0 && (
            <span className="cascade-path__via">
              writes {step.viaFields.map((f) => <Chip key={f}>{f}</Chip>)}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

// The relationship list: every edge, filtered and paged server-side.
function CascadeRelationships({ siteOrigin, summary, load = invoke }) {
  const [search, setSearch] = React.useState("");
  const [kind, setKind] = React.useState("all");
  const [focus, setFocus] = React.useState(null);
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  // Debounced, because every keystroke is a query now that filtering is server-side.
  const [term, setTerm] = React.useState("");
  React.useEffect(() => {
    const id = setTimeout(() => setTerm(search), 250);
    return () => clearTimeout(id);
  }, [search]);

  // Any change to what is being asked resets to the first page. Without this, narrowing a
  // filter while on page 12 shows an empty list that looks like "no results".
  React.useEffect(() => { setPage(1); }, [term, kind, focus]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load("getAutomationCascades", {
      search: term, kind, page, pageSize: CASCADE_PAGE_SIZE,
      ruleId: focus?.id ?? null, direction: "source",
    })
      .then((result) => { if (!cancelled) { setData(result); setLoading(false); } })
      .catch(() => { if (!cancelled) { setData(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, [term, kind, page, focus, load]);

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / CASCADE_PAGE_SIZE));
  const cascades = data?.cascades ?? [];

  return (
    <>
      <StatRow>
        <StatTile label="Cascade paths" value={formatNumber(summary.edges)} hint={`${formatNumber(summary.pairs)} distinct rule pairs`} icon="activity" />
        <StatTile
          label="Self-triggering rules"
          value={formatNumber(summary.selfTriggeringRules)}
          hint="Write a field they also trigger on"
          icon="alertTriangle"
          tone={summary.selfTriggeringRules > 0 ? "warning" : "neutral"}
        />
        <StatTile label="Fields carrying a hop" value={formatNumber(summary.fields)} icon="layers" />
      </StatRow>

      <SortFilterBar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Filter by field or rule name…"
        searchLabel="Filter cascades"
        filters={[{ key: "kind", label: "Kind", value: kind, onChange: setKind, options: CASCADE_KINDS }]}
        resultCount={total}
        totalCount={summary.pairs}
        onClear={() => { setSearch(""); setKind("all"); setFocus(null); }}
      />

      {focus && (
        <div className="cascade-focus">
          <span>Showing only what</span>
          <Chip tone="active" onRemove={() => setFocus(null)} removeLabel="Clear rule filter">{focus.name}</Chip>
          <span>goes on to trigger.</span>
        </div>
      )}

      {loading ? (
        <EmptyState inline>Loading cascades…</EmptyState>
      ) : cascades.length === 0 ? (
        <EmptyState inline>No cascade matches these filters.</EmptyState>
      ) : (
        <>
          <div className="cascade-list">
            {cascades.map((cascade) => (
              <CascadeRow
                key={`${cascade.sourceId}-${cascade.targetId}`}
                cascade={cascade}
                siteOrigin={siteOrigin}
                onFocusRule={(id, name) => setFocus({ id, name })}
              />
            ))}
          </div>

          {pages > 1 && (
            <section className="pagination-bar">
              <span className="pagination-bar__status">
                Page {formatNumber(page)} of {formatNumber(pages)} · {formatNumber(total)} relationships
              </span>
              <div className="pagination-bar__actions">
                <button type="button" className="ghost-button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
                  Previous
                </button>
                <button type="button" className="ghost-button" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages}>
                  Next
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}

// Loops and chains: the multi-rule picture.
function CascadeChains({ siteOrigin, load = invoke }) {
  const [graph, setGraph] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [view, setView] = React.useState("loops");

  React.useEffect(() => {
    let cancelled = false;
    load("getCascadeGraph", {})
      .then((result) => { if (!cancelled) { setGraph(result); setLoading(false); } })
      .catch(() => { if (!cancelled) { setGraph(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, [load]);

  if (loading) return <EmptyState inline>Walking the cascade graph…</EmptyState>;
  if (!graph?.available) return <EmptyState inline>No cascades to walk. Import a rule export first.</EmptyState>;

  const loops = graph.loops ?? [];
  const chains = graph.chains ?? [];
  const showing = view === "loops" ? loops : chains;

  return (
    <>
      <StatRow>
        <StatTile
          label="Loops"
          value={formatNumber(loops.length)}
          hint={`${formatNumber(graph.rulesInLoops)} rules caught in one`}
          icon="refreshCw"
          tone={loops.length > 0 ? "warning" : "neutral"}
        />
        <StatTile label="Multi-rule chains" value={formatNumber(chains.length)} hint={`deepest is ${formatNumber(graph.deepestChain)} rules`} icon="activity" />
        <StatTile label="Rules in the graph" value={formatNumber(graph.ruleCount)} hint={`${formatNumber(graph.edgeCount)} connections`} icon="layers" />
      </StatRow>

      <div className="cascade-views">
        <button type="button" className={`cascade-view${view === "loops" ? " cascade-view--active" : ""}`} onClick={() => setView("loops")}>
          Loops <span className="cascade-view__count">{formatNumber(loops.length)}</span>
        </button>
        <button type="button" className={`cascade-view${view === "chains" ? " cascade-view--active" : ""}`} onClick={() => setView("chains")}>
          Chains <span className="cascade-view__count">{formatNumber(chains.length)}</span>
        </button>
      </div>

      {view === "loops" ? (
        <p className="ui-note">
          <Icon name="info" size={13} />
          <span>
            Every rule in a loop can reach every other one. Nothing in Jira&apos;s automation
            admin shows you this — the path below is one concrete way round, and breaking any
            single hop breaks the loop.
          </span>
        </p>
      ) : (
        <p className="ui-note">
          <Icon name="info" size={13} />
          <span>
            Chains start at a rule nothing else triggers, which is the end an admin controls.
            A chain beginning in the middle is a suffix of one that started earlier.
          </span>
        </p>
      )}

      {showing.length === 0 ? (
        <EmptyState inline>
          {view === "loops" ? "No rule can reach itself through other rules." : "No cascade runs more than one hop."}
        </EmptyState>
      ) : (
        <div className="cascade-chain-list">
          {showing.map((entry, index) => (
            <div key={entry.ruleIds.join("-")} className="cascade-chain">
              <div className="cascade-chain__head">
                <Chip tone={view === "loops" ? (entry.selfTriggering ? "warning" : "critical") : "neutral"}>
                  {view === "loops"
                    ? entry.selfTriggering ? "Self-triggering" : `Loop of ${entry.size}`
                    : `${entry.length} rules deep`}
                </Chip>
                <span className="cascade-chain__index">#{index + 1}</span>
              </div>
              <CascadePath steps={view === "loops" ? entry.path : entry.steps} siteOrigin={siteOrigin} loop={view === "loops"} />
            </div>
          ))}
        </div>
      )}

      {/* Reported, never silent. A truncated answer presented as a complete one is worse
          than a smaller answer that says what it left out. */}
      {graph.truncated && (
        <div className="ui-truncation">
          The walk hit its bound before every chain was enumerated, so this is a sample rather
          than the full set. Loops are unaffected — they are found by decomposition, not by
          walking paths, so every one of them is here.
        </div>
      )}
    </>
  );
}

function CascadeSection({ data, siteOrigin, load = invoke }) {
  const [section, setSection] = React.useState("relationships");
  const [summary, setSummary] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    load("getAutomationCascades", { page: 1, pageSize: 1 })
      .then((result) => { if (!cancelled) { setSummary(result); setLoading(false); } })
      .catch(() => { if (!cancelled) { setSummary(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, [load]);

  if (loading) return <EmptyState inline>Loading cascades…</EmptyState>;

  // The estate summary still carries a cascade count from the analysis document, so a site
  // whose rows were never written -- imported before the table existed -- says to re-import
  // rather than claiming nothing cascades.
  if (!summary?.available) {
    return (
      <EmptyState inline>
        {data.cascadesTotal > 0
          ? "This analysis was imported before cascades were stored in full. Re-import the rule export to see every cascade."
          : "No rule writes a field that another rule triggers on."}
      </EmptyState>
    );
  }

  return (
    <>
      <div className="cascade-views cascade-views--top">
        <button type="button" className={`cascade-view${section === "relationships" ? " cascade-view--active" : ""}`} onClick={() => setSection("relationships")}>
          Relationships <span className="cascade-view__count">{formatNumber(summary.summary.pairs)}</span>
        </button>
        <button type="button" className={`cascade-view${section === "chains" ? " cascade-view--active" : ""}`} onClick={() => setSection("chains")}>
          Loops and chains
        </button>
      </div>

      {section === "relationships"
        ? <CascadeRelationships siteOrigin={siteOrigin} summary={summary.summary} load={load} />
        : <CascadeChains siteOrigin={siteOrigin} load={load} />}
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
            description="A rule that writes a field another rule watches can start a cascade. Relationships are every single hop; loops and chains are what happens when those hops join up."
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
