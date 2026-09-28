import React from "react";
import { invoke } from "@forge/bridge";
import { PageHeader, Panel, StatRow, StatTile, EmptyState, Chip, LinkButton } from "../components/ui";
import { formatNumber, formatRelativeTime, formatReportCell, neutralizeFormula, downloadCsv, readStored, writeStored } from "../utils";
import { parseOql, suggestOql } from "../../../src/lib/oql.js";
import { buildOqlCatalog, OQL_EXAMPLES, OQL_PILLARS, PILLAR_MEASURES } from "../../../src/lib/oql-index.js";

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

function MeasuresTable({ thresholds }) {
  const range = (t) => (t?.p25 == null ? "Too few rows to rank" : `low ≤ ${formatNumber(t.p25)}, high ≥ ${formatNumber(t.p75)}`);
  return (
    <div className="pillar-report__table-wrap">
      <table className="audit-table pillar-report__table">
        <thead>
          <tr>
            <th scope="col">Pillar</th>
            <th scope="col">Usage means</th>
            <th scope="col">Impact means</th>
          </tr>
        </thead>
        <tbody>
          {OQL_PILLARS.map((p) => {
            const t = thresholds?.[p.key];
            return (
              <tr key={p.key}>
                <td>{p.label}</td>
                <td>
                  {PILLAR_MEASURES[p.key].usage.label}
                  {t && PILLAR_MEASURES[p.key].usage.value && <div className="oql-measure__range">{range(t.usage)}</div>}
                </td>
                <td>
                  {PILLAR_MEASURES[p.key].impact.label}
                  {t && PILLAR_MEASURES[p.key].impact.value && <div className="oql-measure__range">{range(t.impact)}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
    { key: "usage", label: "Usage", kind: "level" },
    { key: "impact", label: "Impact", kind: "level" },
  ];
  const pillars = new Set(results.map((r) => r.pillar));
  const only = pillars.size === 1 ? [...pillars][0] : null;
  const own = only ? catalog.fields.filter((f) => f.pillars?.includes(only)) : [];
  return [
    ...base,
    ...own.map((f) => ({ key: f.key, label: f.labels?.[only] || f.label, kind: f.kind })),
    { key: "findings", label: "Findings", kind: "list" },
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
      const text = formatReportCell(row[c.key], c.kind === "level" ? "text" : c.kind);
      return c.kind === "number" ? text : neutralizeFormula(text);
    }));
  }
  return lines;
}

export function SearchTab({ onNavigate }) {
  const [text, setText] = React.useState(() => readStored(STORAGE_QUERY, ""));
  const [result, setResult] = React.useState(null);
  const [running, setRunning] = React.useState(false);
  const [failure, setFailure] = React.useState("");
  const [showAll, setShowAll] = React.useState(false);
  const [saved, setSaved] = React.useState(readSaved);
  const [naming, setNaming] = React.useState(false);
  const [saveName, setSaveName] = React.useState("");

  const catalog = React.useMemo(() => buildOqlCatalog({ findingCodes: result?.findingCodes || [] }), [result]);
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
  const flagged = ok ? ok.results.filter((r) => r.findings.length > 0).length : 0;

  return (
    <div className="admin-search-tab">
      <PageHeader
        title="Search"
        description="Query every pillar at once with OQL. Usage and impact are ranked within each pillar: the bottom quarter is low, the top quarter is high, and a pillar with no data for a measure is unmeasured, never low."
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
            <StatTile label="With findings" value={formatNumber(flagged)} icon="alertTriangle" tone={flagged > 0 ? "warning" : "neutral"} />
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
                                : c.key === "usage" ? <LevelCell level={row.usage} value={row.usageValue} />
                                  : c.key === "impact" ? <LevelCell level={row.impact} value={row.impactValue} />
                                    : c.key === "findings" ? (
                                      <span className="pillar-report__findings">
                                        {row.findings.map((code) => <Chip key={code} tone="warning">{code}</Chip>)}
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

      <Panel title="How usage and impact are measured" icon="info" collapsible defaultCollapsed>
        <MeasuresTable thresholds={ok?.thresholds || null} />
      </Panel>
    </div>
  );
}
