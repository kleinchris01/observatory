import React from "react";
import { invoke, router } from "@forge/bridge";
import { toDisplayName } from "../utils";
import { formatTimestamp, formatNumber } from "../utils";
import { StatTile, StatRow, BarList, Donut } from "../components/ui";

// ── RQT Dashboard helper components ─────────────────────────────────────

function RqtValuesTable({ uniqueValues, rqtValueFrequency, siteOrigin }) {
  const [search, setSearch] = React.useState("");
  const [sortMode, setSortMode] = React.useState("count");
  const [page, setPage] = React.useState(0);
  const [copiedVal, setCopiedVal] = React.useState(null);
  const [loadingVal, setLoadingVal] = React.useState(null);
  const PAGE_SIZE = 50;

  const freqMap = React.useMemo(() => {
    const m = new Map();
    for (const f of rqtValueFrequency || []) m.set(f.value, f.count);
    return m;
  }, [rqtValueFrequency]);

  const rows = React.useMemo(() => {
    let list = uniqueValues || [];
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((v) => v.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) =>
      sortMode === "count" ? (freqMap.get(b) || 0) - (freqMap.get(a) || 0) : a.localeCompare(b),
    );
  }, [uniqueValues, search, sortMode, freqMap]);

  React.useEffect(() => setPage(0), [search, sortMode]);

  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(rows.length / PAGE_SIZE);

  async function getKeysJql(value) {
    const res = await invoke("searchRqtValue", { rqtValue: value });
    const keys = res?.issueKeys || [];
    if (!keys.length) return null;
    return `issueKey in (${keys.join(", ")})`;
  }

  async function openJql(value) {
    if (!siteOrigin) return;
    setLoadingVal(value);
    try {
      const jql = await getKeysJql(value);
      if (jql) router.open(`${siteOrigin}/issues/?jql=${encodeURIComponent(jql)}`);
    } finally {
      setLoadingVal(null);
    }
  }

  async function copyJql(value) {
    setLoadingVal(value);
    try {
      const jql = await getKeysJql(value);
      if (jql) {
        await navigator.clipboard.writeText(jql);
        setCopiedVal(value);
        setTimeout(() => setCopiedVal(null), 1800);
      }
    } finally {
      setLoadingVal(null);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input
          className="rqt-search-input"
          style={{ maxWidth: 240 }}
          placeholder="Filter values…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="rqt-view-toggle">
          <button
            type="button"
            className={`rqt-view-toggle__btn ${sortMode === "count" ? "rqt-view-toggle__btn--active" : ""}`}
            onClick={() => setSortMode("count")}
          >
            By count
          </button>
          <button
            type="button"
            className={`rqt-view-toggle__btn ${sortMode === "alpha" ? "rqt-view-toggle__btn--active" : ""}`}
            onClick={() => setSortMode("alpha")}
          >
            A–Z
          </button>
        </div>
        <span style={{ fontSize: "0.78rem", color: "var(--muted)" }}>
          {rows.length.toLocaleString()} value{rows.length !== 1 ? "s" : ""}
        </span>
      </div>
      <table className="rqt-table" style={{ tableLayout: "fixed" }}>
        <thead>
          <tr>
            <th style={{ width: "45%" }}>RQT Value</th>
            <th style={{ width: "12%", textAlign: "right" }}>Issues</th>
            <th style={{ width: "43%" }}></th>
          </tr>
        </thead>
        <tbody>
          {pageRows.map((val) => {
            const count = freqMap.get(val);
            return (
              <tr key={val}>
                <td style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: "0.82rem" }}>{val}</td>
                <td style={{ textAlign: "right", color: count != null ? "var(--text)" : "var(--stroke)" }}>
                  {count != null ? count.toLocaleString() : "—"}
                </td>
                <td>
                  <div style={{ display: "flex", gap: 6 }}>
                    {siteOrigin && (
                      <button
                        className="btn btn--sm btn--primary"
                        type="button"
                        disabled={loadingVal === val}
                        onClick={() => openJql(val)}
                      >
                        {loadingVal === val ? "…" : "Open in Jira"}
                      </button>
                    )}
                    <button
                      className="btn btn--sm"
                      type="button"
                      disabled={loadingVal === val}
                      onClick={() => copyJql(val)}
                    >
                      {copiedVal === val ? "Copied!" : loadingVal === val ? "…" : "Copy JQL"}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {totalPages > 1 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, fontSize: "0.82rem" }}>
          <button className="btn btn--sm" type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            ‹ Prev
          </button>
          <span style={{ color: "var(--muted)" }}>
            Page {page + 1} of {totalPages} ({rows.length.toLocaleString()} total)
          </span>
          <button
            className="btn btn--sm"
            type="button"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            Next ›
          </button>
        </div>
      )}
    </div>
  );
}

function RqtHBarChart({ items, labelKey, valueKey, maxItems = 15, emptyMsg = "No data" }) {
  return (
    <BarList
      items={(items || []).slice(0, maxItems)}
      labelKey={labelKey}
      valueKey={valueKey}
      formatValue={(v) => v.toLocaleString()}
      emptyMessage={emptyMsg}
    />
  );
}

function RqtDonutChart({ items }) {
  return <Donut segments={items || []} size={140} centerLabel="issues" label="Issues by type" />;
}

function RqtMatrix({ issuesByProject, allTypes }) {
  if (!issuesByProject?.length || !allTypes?.length)
    return <div style={{ color: "var(--muted)", fontSize: "0.82rem" }}>No data</div>;
  const types = allTypes.slice(0, 8);
  const projects = issuesByProject.slice(0, 12);
  const maxVal = Math.max(...projects.flatMap((p) => p.types.map((t) => t.count)), 1);
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", fontSize: "0.73rem", width: "100%" }}>
        <thead>
          <tr>
            <th
              style={{
                padding: "4px 8px",
                textAlign: "left",
                color: "var(--muted)",
                fontWeight: 600,
                borderBottom: "1px solid var(--stroke)",
                minWidth: 80,
              }}
            >
              Project
            </th>
            {types.map((t) => (
              <th
                key={t}
                style={{
                  padding: "4px 6px",
                  textAlign: "center",
                  color: "var(--muted)",
                  fontWeight: 600,
                  borderBottom: "1px solid var(--stroke)",
                  maxWidth: 80,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    writingMode: "horizontal-tb",
                    fontSize: "0.7rem",
                    maxWidth: 70,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t}
                </div>
              </th>
            ))}
            <th
              style={{
                padding: "4px 6px",
                textAlign: "right",
                color: "var(--muted)",
                borderBottom: "1px solid var(--stroke)",
              }}
            >
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {projects.map((proj) => {
            const typeMap = Object.fromEntries(proj.types.map((t) => [t.issueType, t.count]));
            return (
              <tr key={proj.projectKey}>
                <td
                  style={{
                    padding: "4px 8px",
                    fontFamily: "var(--font-mono)",
                    fontWeight: 700,
                    fontSize: "0.75rem",
                    borderBottom: "1px solid var(--stroke)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {proj.projectKey}
                </td>
                {types.map((t) => {
                  const val = typeMap[t] || 0;
                  const intensity = val ? Math.max(0.08, (val / maxVal) * 0.7) : 0;
                  return (
                    <td
                      key={t}
                      style={{
                        padding: "4px 6px",
                        textAlign: "center",
                        borderBottom: "1px solid var(--stroke)",
                        background: val ? `rgba(242,179,103,${intensity})` : "transparent",
                      }}
                    >
                      {val > 0 ? val : <span style={{ color: "var(--stroke)" }}>—</span>}
                    </td>
                  );
                })}
                <td
                  style={{
                    padding: "4px 6px",
                    textAlign: "right",
                    fontWeight: 700,
                    borderBottom: "1px solid var(--stroke)",
                  }}
                >
                  {proj.total.toLocaleString()}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RqtFilterBar({ issuesByProject, allTypes, allFields, filters, setFilters, onRqtSearch, rqtSearching }) {
  const [expanded, setExpanded] = React.useState(false);
  const allProjects = (issuesByProject || []).map((p) => p.projectKey);

  function toggleSet(key, value) {
    setFilters((prev) => {
      const next = new Set(prev[key]);
      next.has(value) ? next.delete(value) : next.add(value);
      return { ...prev, [key]: next };
    });
  }

  function clearAll() {
    setFilters({ projects: new Set(), types: new Set(), fields: new Set(), rqtSearch: "" });
    onRqtSearch("");
  }

  const activeCount = filters.projects.size + filters.types.size + filters.fields.size;
  const hasFilters = activeCount > 0 || filters.rqtSearch;

  const activeChips = [
    ...[...filters.projects].map((v) => ({ key: "projects", value: v, label: v })),
    ...[...filters.types].map((v) => ({ key: "types", value: v, label: v })),
    ...[...filters.fields].map((v) => ({
      key: "fields",
      value: v,
      label: toDisplayName(allFields.find((f) => f.fieldId === v)?.fieldName || v),
    })),
  ];

  return (
    <div className="rqt-filter-bar">
      <div className="rqt-filter-bar__header">
        <button type="button" className="rqt-filter-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "▾" : "▸"} Filters
          {activeCount > 0 && <span className="rqt-filter-badge">{activeCount}</span>}
        </button>
        <div className="rqt-filter-bar__active">
          {activeChips.map((c) => (
            <button
              key={`${c.key}:${c.value}`}
              type="button"
              className="rqt-filter-chip rqt-filter-chip--active rqt-filter-chip--removable"
              onClick={() => toggleSet(c.key, c.value)}
            >
              {c.label} ×
            </button>
          ))}
        </div>
        <div className="rqt-filter-bar__search">
          <input
            className="rqt-search-input"
            type="text"
            placeholder="Find RQT value…"
            value={filters.rqtSearch}
            onChange={(e) => setFilters((prev) => ({ ...prev, rqtSearch: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && onRqtSearch(filters.rqtSearch)}
          />
          <button
            className="btn btn--sm"
            type="button"
            onClick={() => onRqtSearch(filters.rqtSearch)}
            disabled={rqtSearching}
          >
            {rqtSearching ? "…" : "Search"}
          </button>
          {hasFilters && (
            <button className="btn btn--sm" type="button" onClick={clearAll}>
              Clear
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="rqt-filter-bar__panels">
          <div className="rqt-filter-group">
            <div className="rqt-filter-label">Projects</div>
            <div className="rqt-filter-chips">
              {allProjects.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`rqt-filter-chip ${filters.projects.has(p) ? "rqt-filter-chip--active" : ""}`}
                  onClick={() => toggleSet("projects", p)}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div className="rqt-filter-group">
            <div className="rqt-filter-label">Issue Types</div>
            <div className="rqt-filter-chips">
              {allTypes.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`rqt-filter-chip ${filters.types.has(t) ? "rqt-filter-chip--active" : ""}`}
                  onClick={() => toggleSet("types", t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="rqt-filter-group">
            <div className="rqt-filter-label">Fields</div>
            <div className="rqt-filter-chips">
              {allFields.map((f) => (
                <button
                  key={f.fieldId}
                  type="button"
                  className={`rqt-filter-chip ${filters.fields.has(f.fieldId) ? "rqt-filter-chip--active" : ""}`}
                  onClick={() => toggleSet("fields", f.fieldId)}
                >
                  {toDisplayName(f.fieldName)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RqtIssueTable({ issues, siteOrigin, issueRqtValues = {} }) {
  const [sortKey, setSortKey] = React.useState("issueKey");
  const [sortDir, setSortDir] = React.useState("asc");
  const [search, setSearch] = React.useState("");

  const filtered = React.useMemo(() => {
    let rows = issues;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(
        (r) =>
          r.issueKey.toLowerCase().includes(q) ||
          r.projectKey.toLowerCase().includes(q) ||
          r.issueType.toLowerCase().includes(q),
      );
    }
    return [...rows].sort((a, b) => {
      const av = a[sortKey],
        bv = b[sortKey];
      return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }, [issues, search, sortKey, sortDir]);

  function toggleSort(key) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function SortIcon({ col }) {
    if (sortKey !== col) return <span style={{ color: "var(--stroke)" }}> ↕</span>;
    return <span style={{ color: "var(--warm)" }}> {sortDir === "asc" ? "↑" : "↓"}</span>;
  }

  return (
    <div>
      <div style={{ marginBottom: 10, display: "flex", gap: 8, alignItems: "center" }}>
        <input
          className="rqt-search-input"
          type="text"
          placeholder="Search issues…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 260 }}
        />
        <span style={{ fontSize: "0.78rem", color: "var(--muted)" }}>{filtered.length.toLocaleString()} issues</span>
      </div>
      <div style={{ maxHeight: 480, overflowY: "auto" }}>
        <table className="rqt-table" style={{ tableLayout: "fixed" }}>
          <thead style={{ position: "sticky", top: 0, background: "var(--bg)", zIndex: 1 }}>
            <tr>
              <th style={{ cursor: "pointer", width: "22%" }} onClick={() => toggleSort("issueKey")}>
                Issue Key
                <SortIcon col="issueKey" />
              </th>
              <th style={{ cursor: "pointer", width: "18%" }} onClick={() => toggleSort("projectKey")}>
                Project
                <SortIcon col="projectKey" />
              </th>
              <th style={{ cursor: "pointer", width: "22%" }} onClick={() => toggleSort("issueType")}>
                Issue Type
                <SortIcon col="issueType" />
              </th>
              <th style={{ width: "38%" }}>RQT Values</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={row.issueKey}>
                <td>
                  {siteOrigin ? (
                    <button
                      className="rqt-issue-chip"
                      style={{ margin: 0 }}
                      onClick={() => router.open(`${siteOrigin}/browse/${row.issueKey}`)}
                      type="button"
                    >
                      {row.issueKey}
                    </button>
                  ) : (
                    row.issueKey
                  )}
                </td>
                <td style={{ fontFamily: "var(--font-mono)", fontSize: "0.8em" }}>{row.projectKey}</td>
                <td style={{ color: "var(--muted)", fontSize: "0.85em" }}>{row.issueType}</td>
                <td>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                    {(issueRqtValues[row.issueKey] || []).map((v) => (
                      <span key={v} className="rqt-value-chip" style={{ fontSize: "0.68rem", padding: "1px 7px" }}>
                        {v}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RqtIssueChip({ issueKey, siteOrigin, rqtValues }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="rqt-issue-chip-wrap">
      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
        <button
          className="rqt-issue-chip"
          type="button"
          onClick={() => siteOrigin && router.open(`${siteOrigin}/browse/${issueKey}`)}
        >
          {issueKey}
        </button>
        {rqtValues?.length > 0 && (
          <button
            className="rqt-issue-chip-count"
            type="button"
            title="Toggle RQT values"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "▴" : rqtValues.length}
          </button>
        )}
      </div>
      {open && rqtValues?.length > 0 && (
        <div className="rqt-issue-values-list">
          {rqtValues.map((v) => (
            <span key={v} className="rqt-value-chip" style={{ fontSize: "0.68rem", padding: "1px 7px" }}>
              {v}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function RqtIssuesByProject({ issuesByProject, siteOrigin, issueRqtValues = {} }) {
  const [expandedProjects, setExpandedProjects] = React.useState(new Set());
  const [expandedTypes, setExpandedTypes] = React.useState(new Set());

  function toggleProject(key) {
    setExpandedProjects((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  }
  function toggleType(key) {
    setExpandedTypes((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  }

  const total = issuesByProject.reduce((s, p) => s + p.total, 0);

  return (
    <div>
      <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginBottom: 8 }}>
        {formatNumber(total)} issues across {issuesByProject.length} projects
      </div>
      <div className="rqt-project-list">
        {issuesByProject.map((proj) => {
          const projExp = expandedProjects.has(proj.projectKey);
          return (
            <div key={proj.projectKey} className="rqt-project-block">
              <button className="rqt-project-toggle" onClick={() => toggleProject(proj.projectKey)} type="button">
                <span className="rqt-project-toggle__arrow">{projExp ? "▾" : "▸"}</span>
                <span className="rqt-project-toggle__key">{proj.projectKey}</span>
                <span className="rqt-project-toggle__count">
                  {formatNumber(proj.total)} issue{proj.total !== 1 ? "s" : ""}
                </span>
              </button>
              {projExp && (
                <div className="rqt-type-list">
                  {proj.types.map((t) => {
                    const tk = `${proj.projectKey}::${t.issueType}`;
                    const typeExp = expandedTypes.has(tk);
                    return (
                      <div key={tk} className="rqt-type-block">
                        <button className="rqt-type-toggle" onClick={() => toggleType(tk)} type="button">
                          <span className="rqt-project-toggle__arrow">{typeExp ? "▾" : "▸"}</span>
                          <span className="rqt-type-toggle__name">{t.issueType}</span>
                          <span className="rqt-project-toggle__count">{formatNumber(t.count)}</span>
                        </button>
                        {typeExp && (
                          <div className="rqt-issue-grid">
                            {t.issues.map((key) => (
                              <RqtIssueChip
                                key={key}
                                issueKey={key}
                                siteOrigin={siteOrigin}
                                rqtValues={issueRqtValues[key]}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function JqlChunkPanel({ index, total, jql, siteOrigin }) {
  const [copied, setCopied] = React.useState(false);
  function copy() {
    navigator.clipboard.writeText(jql).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <div className="rqt-jql-panel">
      {total > 1 && (
        <div
          style={{
            fontSize: "0.72rem",
            fontWeight: 700,
            color: "var(--muted)",
            marginBottom: 6,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Query {index + 1} of {total}
        </div>
      )}
      <div className="rqt-jql-panel__query">{jql}</div>
      <div className="rqt-jql-panel__actions">
        <button className="btn btn--sm" type="button" onClick={copy}>
          {copied ? "Copied!" : "Copy JQL"}
        </button>
        {siteOrigin && (
          <button
            className="btn btn--sm btn--primary"
            type="button"
            onClick={() => router.open(`${siteOrigin}/issues/?jql=${encodeURIComponent(jql)}`)}
          >
            Open in Jira
          </button>
        )}
      </div>
    </div>
  );
}

export function RqtIndexView({ siteOrigin }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [viewMode, setViewMode] = React.useState("tree");
  const [filters, setFilters] = React.useState({
    projects: new Set(),
    types: new Set(),
    fields: new Set(),
    rqtSearch: "",
  });
  const [rqtSearchResults, setRqtSearchResults] = React.useState(null);
  const [rqtSearching, setRqtSearching] = React.useState(false);
  const [valuesExpanded, setValuesExpanded] = React.useState(false);
  const [jqlExpanded, setJqlExpanded] = React.useState(false);

  React.useEffect(() => {
    invoke("getRqtIndex")
      .then((r) => {
        setData(r);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  async function handleRqtSearch(value) {
    const v = value.trim().toUpperCase();
    if (!v) {
      setRqtSearchResults(null);
      return;
    }
    setRqtSearching(true);
    try {
      const res = await invoke("searchRqtValue", { rqtValue: v });
      setRqtSearchResults(new Set(res?.issueKeys || []));
    } catch {
      setRqtSearchResults(new Set());
    }
    setRqtSearching(false);
  }

  const allTypes = React.useMemo(() => {
    if (!data?.issuesByProject) return [];
    const s = new Map();
    for (const p of data.issuesByProject)
      for (const t of p.types) s.set(t.issueType, (s.get(t.issueType) || 0) + t.count);
    return [...s.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [data]);

  const filteredProjects = React.useMemo(() => {
    if (!data?.issuesByProject) return [];
    let projects = data.issuesByProject;
    if (filters.projects.size > 0) projects = projects.filter((p) => filters.projects.has(p.projectKey));
    if (filters.types.size > 0) {
      projects = projects
        .map((p) => {
          const types = p.types.filter((t) => filters.types.has(t.issueType));
          return { ...p, types, total: types.reduce((s, t) => s + t.count, 0) };
        })
        .filter((p) => p.total > 0);
    }
    if (rqtSearchResults) {
      projects = projects
        .map((p) => {
          const types = p.types
            .map((t) => {
              const issues = t.issues.filter((k) => rqtSearchResults.has(k));
              return { ...t, issues, count: issues.length };
            })
            .filter((t) => t.count > 0);
          const total = types.reduce((s, t) => s + t.count, 0);
          return { ...p, types, total };
        })
        .filter((p) => p.total > 0);
    }
    if (filters.fields.size > 0 && data?.fieldIssueIndex) {
      const allowedKeys = new Set();
      for (const fieldId of filters.fields) {
        const keys = data.fieldIssueIndex[fieldId] || [];
        for (const k of keys) allowedKeys.add(k);
      }
      projects = projects
        .map((p) => {
          const types = p.types
            .map((t) => {
              const issues = t.issues.filter((k) => allowedKeys.has(k));
              return { ...t, issues, count: issues.length };
            })
            .filter((t) => t.count > 0);
          const total = types.reduce((s, t) => s + t.count, 0);
          return { ...p, types, total };
        })
        .filter((p) => p.total > 0);
    }
    return projects;
  }, [data, filters, rqtSearchResults]);

  const allIssuesFlat = React.useMemo(() => {
    const result = [];
    for (const proj of filteredProjects)
      for (const t of proj.types)
        for (const key of t.issues) result.push({ issueKey: key, projectKey: proj.projectKey, issueType: t.issueType });
    return result;
  }, [filteredProjects]);

  const typeChartData = React.useMemo(() => {
    const m = new Map();
    for (const p of filteredProjects) for (const t of p.types) m.set(t.issueType, (m.get(t.issueType) || 0) + t.count);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
  }, [filteredProjects]);

  const projectChartData = React.useMemo(
    () => filteredProjects.map((p) => ({ label: p.projectKey, value: p.total })),
    [filteredProjects],
  );

  const topValuesData = React.useMemo(
    () => (data?.rqtValueFrequency || []).slice(0, 20).map((r) => ({ label: r.value, value: r.count })),
    [data],
  );

  // Split all scanned issue keys into chunks of 500 → one valid JQL per chunk
  const jqlChunks = React.useMemo(() => {
    if (!data?.issuesByProject?.length) return [];
    const keys = [];
    for (const proj of data.issuesByProject) for (const t of proj.types) for (const k of t.issues) keys.push(k);
    if (!keys.length) return [];
    const chunks = [];
    for (let i = 0; i < keys.length; i += 500) {
      chunks.push(`issueKey in (${keys.slice(i, i + 500).join(", ")})`);
    }
    return chunks;
  }, [data]);

  // Per-project JQL: (project = X AND issuetype in (A, B)) OR (project = Y AND issuetype in (C)) OR ...
  const summaryJql = React.useMemo(() => {
    if (!data?.issuesByProject?.length) return null;
    const clauses = data.issuesByProject.map((proj) => {
      const types = proj.types.map((t) => `"${t.issueType}"`).join(", ");
      return `(project = "${proj.projectKey}" AND issuetype in (${types}))`;
    });
    return clauses.join(" OR ");
  }, [data]);

  if (loading)
    return (
      <div style={{ padding: 40, display: "flex", justifyContent: "center" }}>
        <div className="access-gate__spinner" />
      </div>
    );

  const hasData = data?.fields?.length > 0;
  const totalFiltered = filteredProjects.reduce((s, p) => s + p.total, 0);

  return (
    <div className="rqt-index-view">
      <div className="rqt-index-view__header">
        <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 700 }}>RQT Index</h2>
        <p style={{ margin: "6px 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
          Custom fields found to contain{" "}
          <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.8em" }}>RQT-NNNNNN-NNNNNN</code> values during the
          last universe scan.
          {data?.refreshedAt
            ? ` Last updated ${formatTimestamp(data.refreshedAt)}.`
            : " Run a universe scan to populate this index."}
        </p>
      </div>

      {!hasData ? (
        <div className="empty-state" style={{ marginTop: 32 }}>
          <div className="empty-state__icon">🔍</div>
          <div className="empty-state__title">No RQT values found</div>
          <div className="empty-state__body">
            {data?.refreshedAt
              ? "The last universe scan found no RQT-pattern values in any custom field."
              : "Run a universe scan from the Activity tab to detect RQT values across all issues."}
          </div>
        </div>
      ) : (
        <>
          <StatRow>
            <StatTile
              label="Issues"
              value={formatNumber(data.totalUniqueIssues ?? data.totalIssues)}
              hint="carry an RQT value"
              icon="layers"
            />
            <StatTile label="Fields" value={formatNumber(data.fieldCount)} hint="contain RQT values" icon="barChart" />
            <StatTile
              label="Distinct values"
              value={formatNumber(data.uniqueValues?.length ?? 0)}
              hint="unique RQT tokens found"
              icon="activity"
            />
          </StatRow>

          <RqtFilterBar
            issuesByProject={data.issuesByProject}
            allTypes={allTypes}
            allFields={data.fields || []}
            filters={filters}
            setFilters={setFilters}
            onRqtSearch={handleRqtSearch}
            rqtSearching={rqtSearching}
          />

          {(filters.projects.size > 0 || filters.types.size > 0 || rqtSearchResults) && (
            <div style={{ margin: "8px 0 16px", fontSize: "0.82rem", color: "var(--cool)" }}>
              Showing {formatNumber(totalFiltered)} filtered issues
              {rqtSearchResults && ` matching "${filters.rqtSearch}"`}
            </div>
          )}

          <div className="rqt-charts-grid">
            <div className="rqt-chart-card">
              <div className="rqt-chart-card__title">Issues by Project</div>
              <RqtHBarChart
                items={projectChartData}
                labelKey="label"
                valueKey="value"
                maxItems={15}
                emptyMsg="No projects match filters"
              />
            </div>
            <div className="rqt-chart-card">
              <div className="rqt-chart-card__title">Issues by Type</div>
              <RqtDonutChart items={typeChartData} />
            </div>
            <div className="rqt-chart-card">
              <div className="rqt-chart-card__title">Project × Type Matrix</div>
              <RqtMatrix issuesByProject={filteredProjects} allTypes={allTypes} />
            </div>
            <div className="rqt-chart-card">
              <div className="rqt-chart-card__title">Top RQT Values (by issue count)</div>
              <RqtHBarChart
                items={topValuesData}
                labelKey="label"
                valueKey="value"
                maxItems={20}
                emptyMsg="No value frequency data yet"
              />
            </div>
          </div>

          <div className="rqt-section-title" style={{ marginTop: 24 }}>
            Issues
            <div className="rqt-view-toggle">
              <button
                type="button"
                className={`rqt-view-toggle__btn ${viewMode === "tree" ? "rqt-view-toggle__btn--active" : ""}`}
                onClick={() => setViewMode("tree")}
              >
                Tree
              </button>
              <button
                type="button"
                className={`rqt-view-toggle__btn ${viewMode === "table" ? "rqt-view-toggle__btn--active" : ""}`}
                onClick={() => setViewMode("table")}
              >
                Table
              </button>
            </div>
          </div>

          {viewMode === "tree" ? (
            <RqtIssuesByProject
              issuesByProject={filteredProjects}
              siteOrigin={siteOrigin}
              issueRqtValues={data.issueRqtValues || {}}
            />
          ) : (
            <RqtIssueTable issues={allIssuesFlat} siteOrigin={siteOrigin} issueRqtValues={data.issueRqtValues || {}} />
          )}

          {jqlChunks.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <button className="rqt-values-toggle" type="button" onClick={() => setJqlExpanded((v) => !v)}>
                {jqlExpanded ? "▾" : "▸"} Generated JQL
                {jqlChunks.length > 1 && (
                  <span style={{ marginLeft: 8, fontSize: "0.72rem", color: "var(--muted)", fontWeight: 400 }}>
                    {jqlChunks.length} queries · 500 issues each
                  </span>
                )}
              </button>
              {jqlExpanded && (
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 10 }}>
                  {jqlChunks.map((jql, i) => (
                    <JqlChunkPanel key={i} index={i} total={jqlChunks.length} jql={jql} siteOrigin={siteOrigin} />
                  ))}
                  {summaryJql && (
                    <div>
                      <div
                        style={{
                          fontSize: "0.72rem",
                          fontWeight: 700,
                          color: "var(--muted)",
                          margin: "6px 0 4px",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                        }}
                      >
                        Per-project filter — exact project + issue type combinations found in scan
                      </div>
                      <JqlChunkPanel index={0} total={1} jql={summaryJql} siteOrigin={siteOrigin} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {data.uniqueValues?.length > 0 && (
            <div className="rqt-values-section" style={{ marginTop: 12 }}>
              <button className="rqt-values-toggle" onClick={() => setValuesExpanded((v) => !v)} type="button">
                {valuesExpanded ? "▾" : "▸"} All RQT Values ({formatNumber(data.uniqueValues.length)})
              </button>
              {valuesExpanded && (
                <div style={{ marginTop: 12 }}>
                  <RqtValuesTable
                    uniqueValues={data.uniqueValues}
                    rqtValueFrequency={data.rqtValueFrequency}
                    siteOrigin={siteOrigin}
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
