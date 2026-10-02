import React from "react";
import { invoke } from "@forge/bridge";
import { PageHeader, Panel, StatRow, StatTile, EmptyState, Chip, LinkButton } from "../components/ui";
import { formatNumber, formatRelativeTime, formatReportCell, neutralizeFormula, downloadCsv, readStored, writeStored } from "../utils";
import { useNavIntent } from "../hooks";
import { parseOql, suggestOql } from "../../../src/lib/oql.js";
import {
  buildOqlCatalog, OQL_EXAMPLES, OQL_PILLARS, PILLAR_MEASURES, SCORE_WEIGHTS, CHURN_WINDOW_DAYS, MIN_DIMENSIONS_FOR_SCORE,
  CHURN_TRACKED_PILLARS, scoreBreakdown,
} from "../../../src/lib/oql-index.js";

// Search: OQL across every pillar.
//
// The parser and autocomplete are the same module the resolver runs (src/lib/oql.js), so a
// query that shows no error here is one the server will accept, and the error wording is the
// same on both sides. The server does the loading and the evaluating: only it has every
// pillar's rows.

const STORAGE_QUERY = "observatory.search.query";
const STORAGE_SAVED = "observatory.search.saved";
const PREVIEW_ROWS = 200;

const LEVEL_TONE = { low: "neutral", medium: "neutral", high: "warning", unmeasured: "neutral" };
const DIMENSION_COUNT = Object.keys(SCORE_WEIGHTS).length;
const pct = (w) => `${Math.round(w * 100)}%`;
const PILLAR_LABEL = Object.fromEntries(OQL_PILLARS.map((p) => [p.key, p.label]));

function readSaved() {
  try {
    const parsed = JSON.parse(readStored(STORAGE_SAVED, "[]"));
    return Array.isArray(parsed) ? parsed.filter((q) => q && typeof q.query === "string") : [];
  } catch {
    return [];
  }
}

function LevelCell({ level, value }) {
  if (!level) return "—";
  return (
    <span className="oql-level">
      <Chip tone={LEVEL_TONE[level] || "neutral"}>{level}</Chip>
      {value != null && <span className="oql-level__value">{formatNumber(value)}</span>}
    </span>
  );
}

// The query box: a combobox whose listbox is the autocomplete. Enter runs the query unless a
// suggestion is highlighted; Tab or Enter accepts the highlighted one; Escape closes it.
function QueryInput({ value, onChange, onRun, catalog, error }) {
  const inputRef = React.useRef(null);
  const [suggest, setSuggest] = React.useState({ items: [], from: 0, to: 0 });
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);

  const refresh = React.useCallback((text, cursor) => {
    const next = suggestOql(text, cursor, catalog);
    setSuggest(next);
    setActive(-1);
    setOpen(next.items.length > 0);
  }, [catalog]);

  function accept(item) {
    const before = value.slice(0, suggest.from);
    const after = value.slice(suggest.to);
    const spacer = after.startsWith(" ") ? "" : " ";
    const text = `${before}${item.insert}${spacer}${after}`;
    const cursor = before.length + item.insert.length + 1;
    onChange(text);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(cursor, cursor);
      refresh(text, cursor);
    });
  }

  function onKeyDown(event) {
    if (open && suggest.items.length) {
      if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => (i + 1) % suggest.items.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => (i <= 0 ? suggest.items.length - 1 : i - 1)); return; }
      if ((event.key === "Enter" || event.key === "Tab") && active >= 0) { event.preventDefault(); accept(suggest.items[active]); return; }
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); return; }
    }
    if (event.key === "Enter") { event.preventDefault(); setOpen(false); onRun(); }
  }

  return (
    <div className="oql-input">
      <label className="ui-controls__srlabel" htmlFor="oql-query">OQL query</label>
      <input
        id="oql-query"
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls="oql-suggestions"
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `oql-suggestion-${active}` : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "oql-error" : undefined}
        spellCheck={false}
        autoComplete="off"
        value={value}
        placeholder="pillar = screens AND usage = low AND impact = high"
        onChange={(event) => { onChange(event.target.value); refresh(event.target.value, event.target.selectionStart); }}
        onFocus={(event) => refresh(event.target.value, event.target.selectionStart)}
        onClick={(event) => refresh(event.target.value, event.target.selectionStart)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul className="oql-suggestions" id="oql-suggestions" role="listbox" aria-label="Suggestions">
          {suggest.items.map((item, i) => (
            <li
              key={`${item.label}-${i}`}
              id={`oql-suggestion-${i}`}
              role="option"
              aria-selected={i === active}
              className={`oql-suggestion${i === active ? " is-active" : ""}`}
              // mousedown, not click: click fires after the input's blur has closed the list.
              onMouseDown={(event) => { event.preventDefault(); accept(item); }}
            >
              <span className="oql-suggestion__label">{item.label}</span>
              {item.detail && <span className="oql-suggestion__detail">{item.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ScoreCell({ row }) {
  if (row.score == null) {
    return <span title={`Scored only when at least ${MIN_DIMENSIONS_FOR_SCORE} of the ${DIMENSION_COUNT} dimensions are measured`}>—</span>;
  }
  return (
    <span className="oql-score" title={`Scored on ${row.scoreDimensions} of ${DIMENSION_COUNT} dimensions`}>
      <span className="oql-score__value">{row.score}</span>
      <span className="oql-score__track" aria-hidden="true"><span className="oql-score__fill" style={{ width: `${row.score}%` }} /></span>
    </span>
  );
}

// ── How scoring works ──────────────────────────────────────────────────────
//
// Three pictures, in the order a reader needs them: what each dimension is and how it is cut
// into low / medium / high; which pillars can measure which dimension; and one real result's
// score taken apart. The breakdown is scoreBreakdown -- the same function that produced the
// score -- so the explanation cannot drift from the number.

const DIMENSIONS = [
  {
    key: "risk",
    label: "Risk",
    what: "How many discoveries the item carries.",
    kind: "Fixed cut-offs",
    scale: [["low", "0"], ["medium", "1"], ["high", "2+"]],
    unit: "discoveries",
  },
  {
    key: "impact",
    label: "Impact",
    what: "How much a change to it would touch. Means something different in each pillar; see the grid below.",
    kind: "Ranked within its pillar",
    scale: [["low", "Bottom 25%"], ["medium", "Middle 50%"], ["high", "Top 25%"]],
    quartile: true,
  },
  {
    key: "usage",
    label: "Usage",
    what: "How much people actually use it. Heavy use raises the score: a problem there reaches more people.",
    kind: "Ranked within its pillar",
    scale: [["low", "Bottom 25%"], ["medium", "Middle 50%"], ["high", "Top 25%"]],
    quartile: true,
  },
  {
    key: "churn",
    label: "Churn",
    what: `How often its configuration changed in the last ${CHURN_WINDOW_DAYS} days, from the change log.`,
    kind: "Fixed cut-offs",
    scale: [["low", "0"], ["medium", "1–2"], ["high", "3+"]],
    unit: "changes",
  },
];
const DIM_LABEL = Object.fromEntries(DIMENSIONS.map((d) => [d.key, d.label]));

function LevelScale({ scale, quartile, unit }) {
  return (
    <div className="oql-scale" role="img" aria-label={scale.map(([level, range]) => `${level}: ${range}${unit ? ` ${unit}` : ""}`).join(", ")}>
      {scale.map(([level, range]) => (
        <div key={level} className={`oql-scale__seg oql-scale__seg--${level}`} style={{ flexGrow: quartile ? (level === "medium" ? 2 : 1) : 1 }}>
          <span className="oql-scale__bar" />
          <span className="oql-scale__level">{level}</span>
          <span className="oql-scale__range">{range}</span>
        </div>
      ))}
    </div>
  );
}

function DimensionCards() {
  return (
    <div className="oql-dims">
      {DIMENSIONS.map((d) => (
        <div key={d.key} className="oql-dim">
          <div className="oql-dim__head">
            <strong>{d.label}</strong>
            <span className="oql-dim__weight" title="Share of the attention score">{pct(SCORE_WEIGHTS[d.key])} of score</span>
          </div>
          <p className="oql-dim__what">{d.what}</p>
          <span className="oql-dim__kind">{d.kind}</span>
          <LevelScale scale={d.scale} quartile={d.quartile} unit={d.unit} />
        </div>
      ))}
    </div>
  );
}

// Weights as one bar: how the 100 points are split before anything is measured.
function WeightBar() {
  const order = ["risk", "impact", "usage", "churn"];
  return (
    <div className="oql-formula">
      <div className="oql-weights" role="img" aria-label={order.map((k) => `${DIM_LABEL[k]} ${pct(SCORE_WEIGHTS[k])}`).join(", ")}>
        {order.map((k, i) => (
          <span key={k} className={`oql-weights__seg oql-weights__seg--${i}`} style={{ flexGrow: SCORE_WEIGHTS[k] }}>
            {DIM_LABEL[k]} {pct(SCORE_WEIGHTS[k])}
          </span>
        ))}
      </div>
      <p className="oql-formula__rule">
        Each dimension earns its share in full when <strong>high</strong>, half when <strong>medium</strong>, nothing when{" "}
        <strong>low</strong>. An <strong>unmeasured</strong> dimension is left out and the others scale up to fill 100, so a missing
        signal never drags a score down. Fewer than {MIN_DIMENSIONS_FOR_SCORE} measured dimensions: no score.
      </p>
    </div>
  );
}

// Which pillar can measure which dimension, and with what.
function CoverageGrid({ thresholds }) {
  const range = (t) => (t?.p25 == null ? null : `low ≤ ${formatNumber(t.p25)} · high ≥ ${formatNumber(t.p75)}`);
  const cell = (measured, text, cutoffs) => (
    <td className={measured ? "oql-cover--yes" : "oql-cover--no"}>
      <span className="oql-cover__mark" aria-hidden="true">{measured ? "●" : "○"}</span>{" "}
      {measured ? text : "Not measured"}
      {measured && cutoffs && <div className="oql-measure__range">{cutoffs}</div>}
    </td>
  );
  return (
    <div className="pillar-report__table-wrap">
      <table className="audit-table pillar-report__table oql-cover">
        <caption className="ui-controls__srlabel">What each pillar measures for each dimension</caption>
        <thead>
          <tr>
            <th scope="col">Pillar</th>
            <th scope="col">Usage</th>
            <th scope="col">Impact</th>
            <th scope="col">Risk</th>
            <th scope="col">Churn</th>
          </tr>
        </thead>
        <tbody>
          {OQL_PILLARS.map((p) => {
            const m = PILLAR_MEASURES[p.key];
            const t = thresholds?.[p.key];
            return (
              <tr key={p.key}>
                <th scope="row">{p.label}</th>
                {cell(Boolean(m.usage.value), m.usage.label, range(t?.usage))}
                {cell(Boolean(m.impact.value), m.impact.label, range(t?.impact))}
                {cell(true, "Its discoveries")}
                {cell(CHURN_TRACKED_PILLARS.includes(p.key), "Change log")}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// One real item's score, taken apart. Uses the first scored result of the current search, or
// a made-up screen when nothing has run yet -- and says which.
const SAMPLE_ITEM = { name: "an example screen", pillar: "screens", usage: "low", impact: "high", risk: "medium", churn: "unmeasured" };

function WorkedExample({ item }) {
  const example = item || SAMPLE_ITEM;
  const { parts, score, measured } = scoreBreakdown(example);
  const order = ["risk", "impact", "usage", "churn"];
  const sorted = order.map((k) => parts.find((p) => p.dim === k));
  return (
    <div className="oql-example">
      <p className="oql-example__title">
        {item ? <>Taking apart <strong>{example.name}</strong> ({PILLAR_LABEL[example.pillar] || example.pillar}), from your results:</>
          : <>For {example.name} (run a search to see one of your own):</>}
      </p>
      <div className="oql-contrib" role="img" aria-label={`Score ${score ?? "none"}: ${sorted.filter((p) => p.contribution).map((p) => `${DIM_LABEL[p.dim]} ${Math.round(p.contribution)}`).join(", ")}`}>
        {sorted.filter((p) => p.contribution > 0).map((p) => (
          <span key={p.dim} className={`oql-contrib__seg oql-weights__seg--${order.indexOf(p.dim)}`} style={{ width: `${p.contribution}%` }}>
            {DIM_LABEL[p.dim]} {Math.round(p.contribution)}
          </span>
        ))}
        <span className="oql-contrib__rest" />
      </div>
      <table className="audit-table pillar-report__table oql-example__table">
        <thead>
          <tr>
            <th scope="col">Dimension</th>
            <th scope="col">Level</th>
            <th scope="col">Earns</th>
            <th scope="col">Share of 100</th>
            <th scope="col" className="pillar-report__num">Points</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => (
            <tr key={p.dim} className={p.points == null ? "oql-example__row--out" : undefined}>
              <th scope="row">{DIM_LABEL[p.dim]}</th>
              <td>{p.level}</td>
              <td>{p.points == null ? "Left out" : p.points === 1 ? "All" : p.points === 0.5 ? "Half" : "Nothing"}</td>
              <td>
                {p.share == null ? "—" : pct(p.share)}
                {p.share != null && pct(p.share) !== pct(p.weight) && <span className="oql-measure__range"> scaled up from {pct(p.weight)}</span>}
              </td>
              <td className="pillar-report__num">{p.contribution == null ? "—" : Math.round(p.contribution)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={4}>Attention score{measured < DIMENSION_COUNT && score != null ? ` (on ${measured} of ${DIMENSION_COUNT} dimensions)` : ""}</th>
            <td className="pillar-report__num"><strong>{score ?? "No score"}</strong></td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ScoringExplainer({ thresholds, sample }) {
  return (
    <div className="oql-explainer">
      <h4 className="oql-explainer__step"><span>1</span> Every item gets four dimensions</h4>
      <DimensionCards />
      <h4 className="oql-explainer__step"><span>2</span> They combine into one attention score</h4>
      <WeightBar />
      <h4 className="oql-explainer__step"><span>3</span> One score, taken apart</h4>
      <WorkedExample item={sample} />
      <h4 className="oql-explainer__step"><span>4</span> What each pillar can measure</h4>
      <p className="oql-formula__rule">
        Usage and impact mean something different in every pillar. ● measured, ○ not measured.
        {thresholds ? " Cut-offs are from your last search." : " Run a search to see the cut-offs on your data."}
      </p>
      <CoverageGrid thresholds={thresholds} />
    </div>
  );
}

// Columns for the result table: the shared ones always; a single pillar's own columns too
// when every result is from that pillar, so `pillar = screens` reads like the Screens report.
function resultColumns(results, catalog) {
  const base = [
    { key: "pillar", label: "Pillar", kind: "text" },
    { key: "name", label: "Name", kind: "text" },
    { key: "id", label: "ID", kind: "text" },
    { key: "score", label: "Attention", kind: "score" },
    { key: "usage", label: "Usage", kind: "level" },
    { key: "impact", label: "Impact", kind: "level" },
    { key: "risk", label: "Risk", kind: "level" },
    { key: "churn", label: "Churn", kind: "level" },
  ];
  const pillars = new Set(results.map((r) => r.pillar));
  const only = pillars.size === 1 ? [...pillars][0] : null;
  const own = only ? catalog.fields.filter((f) => f.pillars?.includes(only)) : [];
  return [
    ...base,
    ...own.map((f) => ({ key: f.key, label: f.labels?.[only] || f.label, kind: f.kind })),
    { key: "discoveries", label: "Discoveries", kind: "list" },
  ];
}

function csvRows(result, columns) {
  const lines = [
    ["OQL query", result.query, "Ran at", result.ranAt],
    columns.map((c) => c.label),
  ];
  for (const row of result.results) {
    lines.push(columns.map((c) => {
      if (c.key === "pillar") return PILLAR_LABEL[row.pillar] || row.pillar;
      const text = formatReportCell(row[c.key], c.kind === "level" ? "text" : c.kind === "score" ? "number" : c.kind);
      return c.kind === "number" ? text : neutralizeFormula(text);
    }));
  }
  return lines;
}

export function SearchTab({ onNavigate, intent = null }) {
  const [text, setText] = React.useState(() => readStored(STORAGE_QUERY, ""));
  const [result, setResult] = React.useState(null);
  const [running, setRunning] = React.useState(false);
  const [failure, setFailure] = React.useState("");
  const [showAll, setShowAll] = React.useState(false);
  const [saved, setSaved] = React.useState(readSaved);
  const [naming, setNaming] = React.useState(false);
  const [saveName, setSaveName] = React.useState("");

  const catalog = React.useMemo(() => buildOqlCatalog({ findingCodes: result?.discoveryCodes || [] }), [result]);
  const parsed = React.useMemo(() => (text.trim() ? parseOql(text, catalog) : null), [text, catalog]);
  const clientError = parsed && !parsed.ok ? parsed.error : null;
  const serverError = result && result.ok === false ? result.error : null;
  const error = clientError || serverError;

  React.useEffect(() => { writeStored(STORAGE_QUERY, text || null); }, [text]);
  React.useEffect(() => { writeStored(STORAGE_SAVED, JSON.stringify(saved)); }, [saved]);

  async function run(queryText = text) {
    if (!queryText.trim() || running) return;
    if (queryText !== text) setText(queryText);
    const local = parseOql(queryText, catalog);
    if (!local.ok) { setResult({ ok: false, error: local.error }); return; }
    setRunning(true);
    setFailure("");
    setShowAll(false);
    try {
      setResult(await invoke("runOqlQuery", { query: queryText }));
    } catch (err) {
      setFailure(err?.message || "The search could not run.");
    } finally {
      setRunning(false);
    }
  }

  // Ctrl+K's last row ("Search all pillars for ...") lands here with a query to run.
  useNavIntent(intent, (nav) => {
    if (nav.query) run(nav.query);
  });

  function saveQuery() {
    const name = saveName.trim() || text.trim();
    setSaved((list) => [{ name, query: text.trim() }, ...list.filter((q) => q.query !== text.trim())].slice(0, 30));
    setNaming(false);
    setSaveName("");
  }

  const ok = result?.ok ? result : null;
  const columns = ok ? resultColumns(ok.results, catalog) : [];
  const rows = ok ? (showAll ? ok.results : ok.results.slice(0, PREVIEW_ROWS)) : [];
  const searched = ok ? ok.pillars.filter((p) => p.status === "ok") : [];
  const skipped = ok ? ok.pillars.filter((p) => p.status !== "ok") : [];
  const flagged = ok ? ok.results.filter((r) => r.discoveries.length > 0).length : 0;
  const scored = ok ? ok.results.filter((r) => r.score != null) : [];
  const averageScore = scored.length ? Math.round(scored.reduce((t, r) => t + r.score, 0) / scored.length) : null;

  return (
    <div className="admin-search-tab">
      <PageHeader
        title="Search"
        description="Query every pillar at once with OQL. Every item carries four dimensions (usage, impact, risk and churn) and an attention score that combines them. A dimension with no data is unmeasured, never low."
      />

      <Panel title="Query" icon="search">
        <div className="oql-bar">
          <QueryInput value={text} onChange={setText} onRun={() => run()} catalog={catalog} error={error} />
          <button type="button" className="primary-button" onClick={() => run()} disabled={running || !text.trim() || Boolean(clientError)}>
            {running ? "Searching…" : "Search"}
          </button>
        </div>
        {error && (
          <p className="oql-error" id="oql-error" role="alert">
            {error.message}
            {text && error.start < text.length && (
              <span className="oql-error__at"> At “{text.slice(error.start, Math.max(error.end, error.start + 1))}”, character {error.start + 1}.</span>
            )}
          </p>
        )}
        {failure && <div className="ui-banner ui-banner--critical" role="alert">{failure}</div>}
        <p className="oql-help">
          Combine clauses with AND, OR, NOT and parentheses. Operators: = != &gt; &gt;= &lt; &lt;= ~ (contains) IN (…) IS EMPTY.
          Dates take 2026-01-31 or -90d. End with ORDER BY field DESC.
        </p>
        <div className="oql-examples" aria-label="Example queries">
          {OQL_EXAMPLES.map((ex) => (
            <button key={ex.query} type="button" className="secondary-button secondary-button--small" title={ex.query} onClick={() => run(ex.query)}>
              {ex.why}
            </button>
          ))}
        </div>
      </Panel>

      {(saved.length > 0 || (ok && text.trim())) && (
        <Panel
          title="Saved queries"
          icon="flag"
          description="Kept in this browser only."
          action={ok && text.trim() && !naming ? <LinkButton onClick={() => setNaming(true)}>Save this query</LinkButton> : null}
        >
          {naming && (
            <form className="oql-save" onSubmit={(event) => { event.preventDefault(); saveQuery(); }}>
              <label>
                <span className="ui-controls__srlabel">Name</span>
                <input type="text" value={saveName} placeholder="Name (optional)" onChange={(event) => setSaveName(event.target.value)} autoFocus />
              </label>
              <button type="submit" className="primary-button">Save</button>
              <button type="button" className="secondary-button" onClick={() => setNaming(false)}>Cancel</button>
            </form>
          )}
          {saved.length === 0 ? (
            <EmptyState inline>No saved queries yet.</EmptyState>
          ) : (
            <ul className="oql-saved">
              {saved.map((q) => (
                <li key={q.query}>
                  <LinkButton onClick={() => run(q.query)}>{q.name}</LinkButton>
                  {q.name !== q.query && <code className="oql-saved__query">{q.query}</code>}
                  <button
                    type="button"
                    className="secondary-button secondary-button--small"
                    aria-label={`Remove saved query ${q.name}`}
                    onClick={() => setSaved((list) => list.filter((x) => x.query !== q.query))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {ok && (
        <>
          <StatRow>
            <StatTile label="Matches" value={formatNumber(ok.total)} icon="search" hint={ok.truncated ? `First ${formatNumber(ok.results.length)} returned` : null} />
            <StatTile label="With discoveries" value={formatNumber(flagged)} icon="alertTriangle" tone={flagged > 0 ? "warning" : "neutral"} />
            <StatTile
              label="Average attention"
              value={averageScore == null ? "—" : averageScore}
              icon="activity"
              hint={averageScore == null ? "Nothing here has enough measured dimensions" : `Across ${formatNumber(scored.length)} scored item${scored.length === 1 ? "" : "s"}`}
            />
            <StatTile label="Pillars searched" value={`${searched.length} of ${ok.pillars.length}`} icon="layers" />
            <StatTile label="Not searched" value={formatNumber(skipped.length)} icon="alertCircle" tone={skipped.length > 0 ? "warning" : "success"} hint={skipped.length ? "Not built or unreadable; see below" : null} />
          </StatRow>

          {skipped.length > 0 && (
            <ul className="pillar-report__notes" aria-label="Pillars not searched">
              {skipped.map((p) => <li key={p.key}><strong>{p.label}</strong> was not searched: {p.reason}</li>)}
            </ul>
          )}

          <Panel
            title="Results"
            icon="clipboardText"
            description={`Ran ${formatRelativeTime(ok.ranAt)}. Each pillar is as fresh as its last scan.`}
            action={ok.results.length > 0 ? (
              <LinkButton onClick={() => downloadCsv(`oql-results-${ok.ranAt.slice(0, 10)}.csv`, csvRows(ok, columns))}>Download CSV</LinkButton>
            ) : null}
          >
            {ok.results.length === 0 ? (
              <EmptyState inline>
                {searched.length === 0 ? "Nothing was searched: none of the pillars this query covers has been built." : "Nothing matches."}
              </EmptyState>
            ) : (
              <>
                <div className="pillar-report__toolbar">
                  <span>Showing {formatNumber(rows.length)} of {formatNumber(ok.total)}{ok.truncated ? " (the search returns the first 1,000)" : ""}</span>
                  {!showAll && ok.results.length > PREVIEW_ROWS && (
                    <LinkButton onClick={() => setShowAll(true)}>Show all {formatNumber(ok.results.length)}</LinkButton>
                  )}
                </div>
                <div className="pillar-report__table-wrap">
                  <table className="audit-table pillar-report__table">
                    <thead>
                      <tr>
                        {columns.map((c) => <th key={c.key} scope="col" className={c.kind === "number" ? "pillar-report__num" : undefined}>{c.label}</th>)}
                        <th scope="col"><span className="ui-controls__srlabel">Open</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.uid}>
                          {columns.map((c) => (
                            <td key={c.key} className={c.kind === "number" ? "pillar-report__num" : undefined}>
                              {c.key === "pillar" ? (PILLAR_LABEL[row.pillar] || row.pillar)
                                : c.key === "score" ? <ScoreCell row={row} />
                                  : c.kind === "level" ? <LevelCell level={row[c.key]} value={row[`${c.key}Value`]} />
                                    : c.key === "discoveries" ? (
                                      <span className="pillar-report__findings">
                                        {row.discoveries.map((code) => <Chip key={code} tone="warning">{code}</Chip>)}
                                      </span>
                                    ) : (
                                      <span title={formatReportCell(row[c.key], c.kind)}>{formatReportCell(row[c.key], c.kind) || "—"}</span>
                                    )}
                            </td>
                          ))}
                          <td>
                            {onNavigate && (
                              <LinkButton onClick={() => onNavigate(row.pillar)}>Open {PILLAR_LABEL[row.pillar] || row.pillar}</LinkButton>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Panel>
        </>
      )}

      <Panel title="How scoring works" icon="info" collapsible>
        <ScoringExplainer thresholds={ok?.thresholds || null} sample={scored[0] || null} />
      </Panel>
    </div>
  );
}
