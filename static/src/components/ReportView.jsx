import React from "react";
import { createPortal } from "react-dom";
import { invoke } from "@forge/bridge";
import {
  buildJiraSearchUrl,
  handleJiraLinkClick,
  downloadCsv,
  slugifyFilenamePart,
  normalizeReportData,
  groupReportFieldsByType,
  summarizeReportData,
  buildReportRovoPrompt,
  openFieldExpertRovo,
  isSelectType,
  formatTimestamp,
  formatNumber,
  formatShortTime,
  toDisplayName,
} from "../utils";
import { Icon, CHART_PALETTE } from "./Icons";
import { AskRovo } from "./ui";
import { FieldOptionsModal } from "./FieldOptionsModal";

export class ReportErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      message: error?.message || "The report view failed to render.",
    };
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false, message: "" });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <section className="snapshot-log-view">
          <div className="empty-state">{this.state.message || "The report view failed to render."}</div>
        </section>
      );
    }

    return this.props.children;
  }
}

export function SavedReportsPanel({
  reports,
  selectedFieldIds,
  reportName,
  onReportNameChange,
  onSaveReport,
  onLoadReport,
  onDeleteReport,
  savingReport,
  deletingReportId,
}) {
  const [collapsed, setCollapsed] = React.useState(
    () => localStorage.getItem("atlasiq-saved-reports-collapsed") === "true",
  );

  React.useEffect(() => {
    localStorage.setItem("atlasiq-saved-reports-collapsed", collapsed ? "true" : "false");
  }, [collapsed]);

  return (
    <section className="saved-reports-panel">
      <div className="saved-reports-panel__header">
        <div>
          <div className="snapshot-log-entries__heading">Saved Reports</div>
          <div className="saved-reports-panel__subtitle">Save reusable field sets and reopen them later.</div>
        </div>
        <button
          className="secondary-button secondary-button--small"
          type="button"
          onClick={() => setCollapsed((current) => !current)}
        >
          {collapsed ? "Expand" : "Collapse"}
        </button>
      </div>
      {!collapsed ? (
        <>
          <div className="saved-reports-panel__composer">
            <label className="toolbar__field">
              <span>Report name</span>
              <input
                type="text"
                value={reportName}
                placeholder="Part number report"
                onChange={(event) => onReportNameChange(event.target.value)}
              />
            </label>
            <div className="saved-reports-panel__actions">
              <span>{selectedFieldIds.length} fields selected</span>
              <button
                className="secondary-button secondary-button--small"
                type="button"
                onClick={onSaveReport}
                disabled={savingReport || !selectedFieldIds.length}
              >
                {savingReport ? "Saving..." : "Save report"}
              </button>
            </div>
          </div>
          {reports.length ? (
            <div className="saved-reports-list">
              {reports.map((report) => (
                <div key={report.reportId} className="saved-report-card">
                  <div className="saved-report-card__main">
                    <strong>{report.name}</strong>
                    <div className="saved-report-card__meta">
                      <span>{report.fieldIds.length} fields</span>
                      <span>Updated {formatTimestamp(report.updatedAt)}</span>
                    </div>
                  </div>
                  <div className="saved-report-card__actions">
                    <button
                      className="secondary-button secondary-button--small"
                      type="button"
                      onClick={() => onLoadReport(report)}
                    >
                      Load
                    </button>
                    <button
                      className="secondary-button secondary-button--small"
                      type="button"
                      onClick={() => onDeleteReport(report.reportId)}
                      disabled={deletingReportId === report.reportId}
                    >
                      {deletingReportId === report.reportId ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state empty-state--inline">No saved reports yet.</div>
          )}
        </>
      ) : null}
    </section>
  );
}

// Inline chart helpers used by ProjectUsageReportView
function ScrollableTableWrap({ children, colCount }) {
  const scrollRef = React.useRef(null);
  const [canLeft, setCanLeft] = React.useState(false);
  const [canRight, setCanRight] = React.useState(false);

  const checkScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    checkScroll();
    el.addEventListener("scroll", checkScroll, { passive: true });
    const ro = new ResizeObserver(checkScroll);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", checkScroll);
      ro.disconnect();
    };
  }, [checkScroll]);

  React.useEffect(() => {
    checkScroll();
  }, [colCount, checkScroll]);

  function nudge(dir) {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * 320, behavior: "smooth" });
  }

  return (
    <div className="report-table-scroll-outer">
      <button
        type="button"
        className={`report-table-scroll-btn report-table-scroll-btn--left ${canLeft ? "report-table-scroll-btn--visible" : ""}`}
        onClick={() => nudge(-1)}
        aria-label="Scroll left"
      >
        ‹
      </button>
      <div className="report-table-wrap" ref={scrollRef}>
        {children}
      </div>
      <button
        type="button"
        className={`report-table-scroll-btn report-table-scroll-btn--right ${canRight ? "report-table-scroll-btn--visible" : ""}`}
        onClick={() => nudge(1)}
        aria-label="Scroll right"
      >
        ›
      </button>
    </div>
  );
}

function TopFieldsChart({ fields }) {
  const top = [...fields]
    .filter((f) => String(f.fieldId || "").startsWith("customfield_"))
    .sort((a, b) => b.issueCount - a.issueCount)
    .slice(0, 8);
  const max = top[0]?.issueCount || 1;
  if (!top.length) return null;
  return (
    <div className="project-chart">
      <div className="chart-title">Top fields by issue count</div>
      <div className="chart-bar-list">
        {top.map((field, i) => {
          const pct = Math.max(3, Math.round((field.issueCount / max) * 100));
          return (
            <div className="chart-bar-row" key={field.fieldId}>
              <span className="chart-bar-label" title={field.fieldName}>
                {field.fieldName}
              </span>
              <div className="chart-bar-track">
                <div
                  className="chart-bar-fill"
                  style={{ width: `${pct}%`, background: CHART_PALETTE[i % CHART_PALETTE.length] }}
                />
              </div>
              <span className="chart-bar-count">{formatNumber(field.issueCount)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FieldTypeDonut({ fields }) {
  if (!fields.length) return null;
  const counts = {};
  for (const f of fields) {
    counts[f.fieldType] = (counts[f.fieldType] || 0) + 1;
  }
  const entries = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7);
  const total = entries.reduce((s, [, c]) => s + c, 0);
  const r = 40;
  const circumference = 2 * Math.PI * r;
  let acc = 0;
  const segments = entries.map(([type, count], i) => {
    const dash = (count / total) * circumference;
    const seg = { type, count, color: CHART_PALETTE[i % CHART_PALETTE.length], dash, acc };
    acc += dash;
    return seg;
  });
  return (
    <div className="project-chart">
      <div className="chart-title">Field types on this project</div>
      <div className="project-chart__donut-layout">
        <svg className="donut-svg" viewBox="0 0 108 108" width="100" height="100" aria-hidden="true">
          <g transform="rotate(-90, 54, 54)">
            {segments.map((seg) => (
              <circle
                key={seg.type}
                cx={54}
                cy={54}
                r={r}
                fill="none"
                stroke={seg.color}
                strokeWidth="15"
                strokeDasharray={`${seg.dash} ${circumference - seg.dash}`}
                strokeDashoffset={-seg.acc}
              />
            ))}
          </g>
        </svg>
        <div className="chart-legend">
          {segments.map((seg) => (
            <div className="chart-legend-item" key={seg.type}>
              <span className="chart-legend-dot" style={{ background: seg.color }} />
              <span className="chart-legend-label" title={seg.type}>
                {seg.type}
              </span>
              <span className="chart-legend-count">{seg.count}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Matrix heat map ─────────────────────────────────────────────────────────
//
// Sequential encoding: one hue, light to dark, because the value is magnitude rather
// than identity. Five steps rather than a continuous gradient -- a reader compares cells
// against the legend, and they cannot resolve more gradations than that.
//
// The ramps were run through the dataviz validator against these exact surfaces: both
// are monotone in lightness with visible step gaps, and the step nearest the surface
// still clears 2:1 so a low-but-nonzero cell never disappears into the table.
//
// An empty cell is NOT step 0. A field that is not configured on a project has no
// intersection at all, which is a different statement from "configured and holding zero
// issues" -- and this table is used to decide what to delete.
const HEAT_STEPS = 5;

function heatStep(count, max) {
  if (!Number.isFinite(count) || count <= 0 || !max) return 0;
  // Log scale: issue counts across a real site span several orders of magnitude, and a
  // linear ramp would put everything except the largest project in the lightest step.
  const ratio = Math.log10(count + 1) / Math.log10(max + 1);
  return Math.max(1, Math.min(HEAT_STEPS, Math.ceil(ratio * HEAT_STEPS)));
}

function HeatLegend({ max }) {
  return (
    <div className="heat-legend" role="img" aria-label={`Cell shading runs from 1 issue to ${formatNumber(max)}`}>
      <span className="heat-legend__label">Fewer</span>
      {Array.from({ length: HEAT_STEPS }, (_, i) => (
        <span key={i} className="heat-legend__swatch" data-heat={i + 1} />
      ))}
      <span className="heat-legend__label">More · up to {formatNumber(max)}</span>
    </div>
  );
}

export function ProjectUsageReportView({
  reportData,
  reportName,
  reportJob,
  siteOrigin,
  onExportCsv,
  onAskReport,
  savedReports,
  selectedFieldIds,
  reportNameInput,
  onReportNameChange,
  onSaveReport,
  onLoadReport,
  onDeleteReport,
  savingReport,
  deletingReportId,
  rovoEnabled,
}) {
  const [reportFieldTypeFilter, setReportFieldTypeFilter] = React.useState("all");
  const [reportProjectFilter, setReportProjectFilter] = React.useState("");
  const [tableSortMode, setTableSortMode] = React.useState("type");
  const [tableOrientation, setTableOrientation] = React.useState("fields");
  const [optionsModal, setOptionsModal] = React.useState(null);
  const [heatMap, setHeatMap] = React.useState(true);

  React.useEffect(() => {
    setReportFieldTypeFilter("all");
    setReportProjectFilter("");
    setTableSortMode("type");
    setTableOrientation("fields");
    setOptionsModal(null);
  }, [reportData]);

  const { fields = [], projects = [], pendingFields = [], uniqueIssueCount = null } = normalizeReportData(reportData);
  const availableReportTypes = React.useMemo(
    () =>
      Array.from(new Set((fields || []).map((field) => field.fieldType).filter(Boolean))).sort((left, right) =>
        left.localeCompare(right),
      ),
    [fields],
  );
  const normalizedProjectFilter = reportProjectFilter.trim().toLowerCase();
  const filteredProjects = React.useMemo(() => {
    if (!normalizedProjectFilter) {
      return Array.isArray(projects) ? projects : [];
    }
    return (Array.isArray(projects) ? projects : []).filter((project) =>
      [project?.projectKey, project?.projectName]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalizedProjectFilter)),
    );
  }, [projects, normalizedProjectFilter]);
  const filteredProjectIds = React.useMemo(
    () => new Set(filteredProjects.map((project) => String(project?.projectId || project?.projectKey || ""))),
    [filteredProjects],
  );
  const filteredFields = React.useMemo(() => {
    return (fields || [])
      .filter((field) => reportFieldTypeFilter === "all" || field.fieldType === reportFieldTypeFilter)
      .map((field) => ({
        ...field,
        projects: (Array.isArray(field?.projects) ? field.projects : []).filter((project) =>
          filteredProjectIds.has(String(project?.projectId || project?.projectKey || "")),
        ),
      }))
      .filter((field) => !normalizedProjectFilter || field.projects.length > 0);
  }, [fields, filteredProjectIds, reportFieldTypeFilter, normalizedProjectFilter]);

  // The busiest single intersection anchors the scale. Computed across every cell in the
  // filtered set, so the shading stays comparable as filters change the visible rows.
  const heatMax = React.useMemo(() => {
    let max = 0;
    for (const field of filteredFields) {
      for (const project of field.projects || []) {
        const count = Number(project.issueCount) || 0;
        if (count > max) max = count;
      }
    }
    return max;
  }, [filteredFields]);

  const flatFieldsSorted = React.useMemo(() => {
    if (tableSortMode === "type") return [];
    return [...filteredFields]
      .map((f) => ({ ...f, _totalIssues: (f.projects || []).reduce((s, p) => s + Number(p.issueCount || 0), 0) }))
      .sort(
        tableSortMode === "issues"
          ? (a, b) => b._totalIssues - a._totalIssues || a.fieldName.localeCompare(b.fieldName)
          : (a, b) => a.fieldName.localeCompare(b.fieldName) || a.fieldId.localeCompare(b.fieldId),
      );
  }, [filteredFields, tableSortMode]);

  if (!reportData && !reportJob) {
    return (
      <section className="snapshot-log-view">
        <SavedReportsPanel
          reports={savedReports}
          selectedFieldIds={selectedFieldIds}
          reportName={reportNameInput}
          onReportNameChange={onReportNameChange}
          onSaveReport={onSaveReport}
          onLoadReport={onLoadReport}
          onDeleteReport={onDeleteReport}
          savingReport={savingReport}
          deletingReportId={deletingReportId}
        />
        <div className="empty-state">Select fields, then generate a report.</div>
      </section>
    );
  }
  const groupedFields = groupReportFieldsByType(filteredFields);
  const reportSummary = summarizeReportData(
    filteredFields,
    filteredProjects,
    reportFieldTypeFilter === "all" && !normalizedProjectFilter ? uniqueIssueCount : null,
  );
  const hasReportFilters = reportFieldTypeFilter !== "all" || normalizedProjectFilter !== "";
  if (!fields.length && !(reportJob && (reportJob.status === "queued" || reportJob.status === "building"))) {
    const jobFailed = reportJob?.status === "failed";
    return (
      <section className="snapshot-log-view">
        <SavedReportsPanel
          reports={savedReports}
          selectedFieldIds={selectedFieldIds}
          reportName={reportNameInput}
          onReportNameChange={onReportNameChange}
          onSaveReport={onSaveReport}
          onLoadReport={onLoadReport}
          onDeleteReport={onDeleteReport}
          savingReport={savingReport}
          deletingReportId={deletingReportId}
        />
        {jobFailed ? (
          <div className="empty-state">
            <div className="build-card__error">Report generation failed: {reportJob.lastError || "Unknown error."}</div>
          </div>
        ) : (
          <div className="empty-state">No report rows were returned for the selected fields.</div>
        )}
      </section>
    );
  }

  return (
    <>
      <section className="snapshot-log-view">
        <SavedReportsPanel
          reports={savedReports}
          selectedFieldIds={selectedFieldIds}
          reportName={reportNameInput}
          onReportNameChange={onReportNameChange}
          onSaveReport={onSaveReport}
          onLoadReport={onLoadReport}
          onDeleteReport={onDeleteReport}
          savingReport={savingReport}
          deletingReportId={deletingReportId}
        />
        <div className="snapshot-log-layout">
          <div className="snapshot-log-entries">
            {reportJob ? (
              <div className={`build-card build-card--${reportJob.status || "queued"}`} style={{ marginBottom: 14 }}>
                <div className="build-card__top">
                  <span className={`build-dot build-dot--${reportJob.status || "queued"}`} />
                  <span className="build-card__state">
                    {reportJob.reportName || reportName || "Project Usage Report"}
                  </span>
                  <span className="scan-log__time">{reportJob.status}</span>
                </div>
                <div className="build-card__meta">
                  <span>
                    {formatNumber(reportJob.processedFields)} of {formatNumber(reportJob.totalFields)} fields processed
                  </span>
                  {reportJob.startedAt ? <span>Started {formatShortTime(reportJob.startedAt)}</span> : null}
                  {reportJob.completedAt ? <span>Completed {formatShortTime(reportJob.completedAt)}</span> : null}
                </div>
                <div className="status-progress" style={{ marginTop: 10 }}>
                  <div className="status-progress__meta">
                    <strong>{reportJob.percentComplete || 0}%</strong>
                    <span>
                      {formatNumber(reportJob.processedFields)} of {formatNumber(reportJob.totalFields)} fields
                      processed
                    </span>
                  </div>
                  <div className="status-progress__bar" aria-hidden="true">
                    <span style={{ width: `${reportJob.percentComplete || 0}%` }} />
                  </div>
                </div>
                {reportJob.lastError ? (
                  <div className="build-card__error" style={{ marginTop: 10 }}>
                    {reportJob.lastError}
                  </div>
                ) : null}
                {reportJob.progressLog?.length ? (
                  <div className="scan-log" style={{ marginTop: 10, maxHeight: 240 }}>
                    {[...reportJob.progressLog].reverse().map((entry, index) => (
                      <div key={`report-job-${index}`} className="scan-log__entry">
                        <span className="scan-log__time">{formatShortTime(entry.t)}</span>
                        <span className="scan-log__msg">{entry.msg}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="section-heading">
              <div>
                <div className="snapshot-log-entries__heading">{reportName || "Project Usage Report"}</div>
                <div className="saved-reports-panel__subtitle">
                  Rows are fields, columns are projects, and each populated cell links to the JQL.
                </div>
              </div>
              <div className="section-heading__actions">
                <span>
                  {filteredFields.length} fields · {filteredProjects.length} projects shown
                </span>
                <AskRovo
                  agent="observatory-field-expert"
                  scope="this report"
                  context="the fields and projects in the current report view"
                  disabled={!rovoEnabled}
                  onAsk={() =>
                    onAskReport({ fields: filteredFields, projects: filteredProjects, pendingFields, reportSummary })
                  }
                />
                <button
                  className="secondary-button secondary-button--small"
                  type="button"
                  onClick={() =>
                    onExportCsv({
                      ...reportData,
                      fields: filteredFields,
                      projects: filteredProjects,
                      uniqueIssueCount: reportSummary.uniqueIssueCount,
                    })
                  }
                >
                  Export CSV
                </button>
              </div>
            </div>
            {pendingFields.length ? (
              <div className="status-banner status-banner--info" style={{ marginBottom: 10 }}>
                {pendingFields.some((field) => field.reason === "last-used-metadata-missing")
                  ? `${pendingFields.length} selected ${pendingFields.length === 1 ? "field needs" : "fields need"} a project-usage refresh to populate last-used timestamps. Refresh jobs, then regenerate the report.`
                  : `${pendingFields.length} selected ${pendingFields.length === 1 ? "field is" : "fields are"} still building project usage. Refresh jobs, then regenerate the report for complete coverage.`}
              </div>
            ) : null}
            <section className="report-filters">
              <label className="toolbar__field">
                <span>Field type</span>
                <select
                  value={reportFieldTypeFilter}
                  onChange={(event) => setReportFieldTypeFilter(event.target.value)}
                >
                  <option value="all">All types</option>
                  {availableReportTypes.map((fieldType) => (
                    <option key={fieldType} value={fieldType}>
                      {fieldType}
                    </option>
                  ))}
                </select>
              </label>
              <label className="toolbar__field">
                <span>Table sort</span>
                <select value={tableSortMode} onChange={(event) => setTableSortMode(event.target.value)}>
                  <option value="type">By field type</option>
                  <option value="issues">By total issues</option>
                  <option value="alpha">Alphabetical</option>
                </select>
              </label>
              <div className="toolbar__field">
                <span>Table orientation</span>
                <div className="toolbar__selection-actions">
                  <button
                    className={`secondary-button secondary-button--small ${tableOrientation === "fields" ? "secondary-button--active" : ""}`}
                    type="button"
                    onClick={() => setTableOrientation("fields")}
                  >
                    Fields as rows
                  </button>
                  <button
                    className={`secondary-button secondary-button--small ${tableOrientation === "projects" ? "secondary-button--active" : ""}`}
                    type="button"
                    onClick={() => setTableOrientation("projects")}
                  >
                    Projects as rows
                  </button>
                </div>
              </div>
              <div className="toolbar__field">
                <span>Shading</span>
                <div className="toolbar__segmented">
                  <button
                    className={`secondary-button secondary-button--small ${heatMap ? "secondary-button--active" : ""}`}
                    type="button"
                    aria-pressed={heatMap}
                    onClick={() => setHeatMap((on) => !on)}
                  >
                    Heat map
                  </button>
                </div>
              </div>
              <label className="toolbar__field">
                <span>Projects</span>
                <input
                  type="search"
                  placeholder="Filter by project key or name"
                  value={reportProjectFilter}
                  onChange={(event) => setReportProjectFilter(event.target.value)}
                  data-search-input="primary"
                />
              </label>
              <div className="toolbar__field">
                <span>Report filters</span>
                <div className="toolbar__selection-actions">
                  <strong>{hasReportFilters ? "Active" : "None"}</strong>
                  <button
                    className="secondary-button secondary-button--small"
                    type="button"
                    onClick={() => {
                      setReportFieldTypeFilter("all");
                      setReportProjectFilter("");
                    }}
                    disabled={!hasReportFilters}
                  >
                    Clear report filters
                  </button>
                </div>
              </div>
            </section>
            {fields.length ? (
              <div className="report-dashboard">
                <div className="report-dashboard__metric-grid">
                  <article className="report-insight-card">
                    <div className="report-insight-card__label">Selected fields</div>
                    <div className="report-insight-card__value">{filteredFields.length}</div>
                    <div className="report-insight-card__meta">
                      {reportSummary.typeTotals.length} field types represented
                    </div>
                  </article>
                  <article className="report-insight-card">
                    <div className="report-insight-card__label">Project intersections</div>
                    <div className="report-insight-card__value">{reportSummary.populatedCells}</div>
                    <div className="report-insight-card__meta">
                      {Math.round(reportSummary.coverageRatio * 100)}% of the matrix is populated
                    </div>
                  </article>
                  <article className="report-insight-card">
                    <div className="report-insight-card__label">
                      {reportSummary.uniqueIssueCount >= 0 ? "Unique populated issues" : "Filtered populated issues"}
                    </div>
                    <div className="report-insight-card__value">
                      {formatNumber(
                        reportSummary.uniqueIssueCount >= 0
                          ? reportSummary.uniqueIssueCount
                          : reportSummary.totalIssues,
                      )}
                    </div>
                    <div className="report-insight-card__meta">
                      {reportSummary.uniqueIssueCount >= 0
                        ? "Distinct issues matching at least one selected field"
                        : "Fallback total from populated project-field intersections"}
                    </div>
                  </article>
                  <article className="report-insight-card">
                    <div className="report-insight-card__label">Most active project</div>
                    <div className="report-insight-card__value">
                      {reportSummary.topProjects[0]?.projectKey || "None"}
                    </div>
                    <div className="report-insight-card__meta">
                      {formatNumber(reportSummary.topProjects[0]?.issueCount)} issues across{" "}
                      {formatNumber(reportSummary.topProjects[0]?.fieldCount)} fields
                    </div>
                  </article>
                </div>
                <div className="report-dashboard__chart-grid">
                  <article className="report-insight-card report-insight-card--chart">
                    <div className="report-insight-card__label">Top fields by populated issues</div>
                    <div className="report-bar-list">
                      {reportSummary.topFields.map((fieldSummary) => {
                        const maxValue = reportSummary.topFields[0]?.issueCount || 1;
                        return (
                          <div key={fieldSummary.fieldId} className="report-bar-list__row">
                            <div className="report-bar-list__header">
                              <span>{fieldSummary.fieldName}</span>
                              <span>{formatNumber(fieldSummary.issueCount)}</span>
                            </div>
                            <div className="report-bar-list__track">
                              <div
                                className="report-bar-list__fill report-bar-list__fill--warm"
                                style={{
                                  width: `${Math.max(8, Math.round((fieldSummary.issueCount / maxValue) * 100))}%`,
                                }}
                              />
                            </div>
                            <div className="report-bar-list__caption">
                              {fieldSummary.activeProjectCount} active projects · {fieldSummary.fieldType}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </article>
                  <article className="report-insight-card report-insight-card--chart">
                    <div className="report-insight-card__label">Top projects by populated issues</div>
                    <div className="report-bar-list">
                      {reportSummary.topProjects.map((project) => {
                        const maxValue = reportSummary.topProjects[0]?.issueCount || 1;
                        return (
                          <div key={project.projectId} className="report-bar-list__row">
                            <div className="report-bar-list__header">
                              <span>{project.projectKey}</span>
                              <span>{formatNumber(project.issueCount)}</span>
                            </div>
                            <div className="report-bar-list__track">
                              <div
                                className="report-bar-list__fill"
                                style={{ width: `${Math.max(8, Math.round((project.issueCount / maxValue) * 100))}%` }}
                              />
                            </div>
                            <div className="report-bar-list__caption">{project.fieldCount} linked fields</div>
                          </div>
                        );
                      })}
                    </div>
                  </article>
                  <article className="report-insight-card report-insight-card--chart">
                    <div className="report-insight-card__label">Field types by populated issues</div>
                    <div className="report-bar-list">
                      {reportSummary.typeTotals.slice(0, 8).map((typeSummary) => {
                        const maxValue = reportSummary.typeTotals[0]?.issueCount || 1;
                        return (
                          <div key={typeSummary.fieldType} className="report-bar-list__row">
                            <div className="report-bar-list__header">
                              <span>{typeSummary.fieldType}</span>
                              <span>{formatNumber(typeSummary.issueCount)}</span>
                            </div>
                            <div className="report-bar-list__track">
                              <div
                                className="report-bar-list__fill report-bar-list__fill--cool"
                                style={{
                                  width: `${Math.max(8, Math.round((typeSummary.issueCount / maxValue) * 100))}%`,
                                }}
                              />
                            </div>
                            <div className="report-bar-list__caption">
                              {typeSummary.fieldCount} fields · {typeSummary.activeProjectCount} project intersections
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </article>
                </div>
              </div>
            ) : null}
            {fields.length ? (
              <>
                {heatMap && heatMax > 0 && <HeatLegend max={heatMax} />}
                <ScrollableTableWrap colCount={filteredProjects.length}>
                  <table className="report-table">
                    {tableOrientation === "projects" ? (
                      <>
                        <thead>
                          <tr>
                            <th>Project</th>
                            {filteredFields.map((field) => (
                              <th key={field.fieldId}>
                                <div className="report-table__field-name">
                                  {isSelectType(field.fieldType) ? (
                                    <button
                                      className="report-table__field-btn"
                                      type="button"
                                      onClick={() =>
                                        setOptionsModal({
                                          fieldId: field.fieldId,
                                          fieldName: field.fieldName,
                                          fieldType: field.fieldType,
                                        })
                                      }
                                    >
                                      {toDisplayName(field.fieldName)}
                                    </button>
                                  ) : (
                                    toDisplayName(field.fieldName)
                                  )}
                                </div>
                                <span className="field-type-tag">{field.fieldType}</span>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {filteredProjects.map((project) => (
                            <tr key={project.projectId}>
                              <th>
                                <div className="report-table__field-name">{project.projectKey}</div>
                                <div className="field-card__eyebrow">{project.projectName}</div>
                              </th>
                              {filteredFields.map((field) => {
                                const cell = (field.projects || []).find((p) => p.projectId === project.projectId);
                                const href = buildJiraSearchUrl(siteOrigin, cell?.jql);
                                return (
                                  <td
                                    key={`${project.projectId}-${field.fieldId}`}
                                    data-heat={heatMap && cell ? heatStep(cell.issueCount, heatMax) : undefined}
                                  >
                                    {cell && href ? (
                                      <a
                                        className="smart-link-card smart-link-card--compact"
                                        href={href}
                                        target="_blank"
                                        rel="noreferrer"
                                        onClick={(e) => handleJiraLinkClick(e, href)}
                                      >
                                        <span className="smart-link-card__title">{cell.issueCount} issues</span>
                                      </a>
                                    ) : (
                                      ""
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </>
                    ) : (
                      <>
                        <thead>
                          <tr>
                            <th>Field</th>
                            {filteredProjects.map((project) => (
                              <th key={project.projectId}>{project.projectKey}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {tableSortMode === "type"
                            ? groupedFields.map((group) => (
                                <React.Fragment key={group.fieldType}>
                                  <tr className="report-table__group-row">
                                    <th colSpan={filteredProjects.length + 1}>{toDisplayName(group.fieldType)}</th>
                                  </tr>
                                  {group.fields.map((field) => {
                                    const cellByProjectId = new Map(field.projects.map((p) => [p.projectId, p]));
                                    const canShowOptions = isSelectType(field.fieldType);
                                    const displayName = toDisplayName(field.fieldName);
                                    return (
                                      <tr key={field.fieldId}>
                                        <th>
                                          <div className="report-table__field-name">
                                            {canShowOptions ? (
                                              <button
                                                className="report-table__field-btn"
                                                type="button"
                                                onClick={() =>
                                                  setOptionsModal({
                                                    fieldId: field.fieldId,
                                                    fieldName: field.fieldName,
                                                    fieldType: field.fieldType,
                                                  })
                                                }
                                              >
                                                {displayName}
                                              </button>
                                            ) : (
                                              displayName
                                            )}
                                          </div>
                                          <div className="field-card__eyebrow">{field.fieldId}</div>
                                        </th>
                                        {filteredProjects.map((project) => {
                                          const cell = cellByProjectId.get(project.projectId);
                                          const href = buildJiraSearchUrl(siteOrigin, cell?.jql);
                                          return (
                                            <td
                                              key={`${field.fieldId}-${project.projectId}`}
                                              data-heat={
                                                heatMap && cell ? heatStep(cell.issueCount, heatMax) : undefined
                                              }
                                            >
                                              {cell && href ? (
                                                <a
                                                  className="smart-link-card smart-link-card--compact"
                                                  href={href}
                                                  target="_blank"
                                                  rel="noreferrer"
                                                  onClick={(e) => handleJiraLinkClick(e, href)}
                                                >
                                                  <span className="smart-link-card__title">
                                                    {cell.issueCount} issues
                                                  </span>
                                                </a>
                                              ) : (
                                                ""
                                              )}
                                            </td>
                                          );
                                        })}
                                      </tr>
                                    );
                                  })}
                                </React.Fragment>
                              ))
                            : flatFieldsSorted.map((field) => {
                                const cellByProjectId = new Map(field.projects.map((p) => [p.projectId, p]));
                                const canShowOptions = isSelectType(field.fieldType);
                                const displayName = toDisplayName(field.fieldName);
                                return (
                                  <tr key={field.fieldId}>
                                    <th>
                                      <div className="report-table__field-name">
                                        {canShowOptions ? (
                                          <button
                                            className="report-table__field-btn"
                                            type="button"
                                            onClick={() =>
                                              setOptionsModal({
                                                fieldId: field.fieldId,
                                                fieldName: field.fieldName,
                                                fieldType: field.fieldType,
                                              })
                                            }
                                          >
                                            {displayName}
                                          </button>
                                        ) : (
                                          displayName
                                        )}
                                      </div>
                                      <span className="field-type-tag">{field.fieldType}</span>
                                      <div className="field-card__eyebrow">{field.fieldId}</div>
                                    </th>
                                    {filteredProjects.map((project) => {
                                      const cell = cellByProjectId.get(project.projectId);
                                      const href = buildJiraSearchUrl(siteOrigin, cell?.jql);
                                      return (
                                        <td
                                          key={`${field.fieldId}-${project.projectId}`}
                                          data-heat={heatMap && cell ? heatStep(cell.issueCount, heatMax) : undefined}
                                        >
                                          {cell && href ? (
                                            <a
                                              className="smart-link-card smart-link-card--compact"
                                              href={href}
                                              target="_blank"
                                              rel="noreferrer"
                                              onClick={(e) => handleJiraLinkClick(e, href)}
                                            >
                                              <span className="smart-link-card__title">{cell.issueCount} issues</span>
                                            </a>
                                          ) : (
                                            ""
                                          )}
                                        </td>
                                      );
                                    })}
                                  </tr>
                                );
                              })}
                        </tbody>
                      </>
                    )}
                  </table>
                </ScrollableTableWrap>
              </>
            ) : reportJob && (reportJob.status === "queued" || reportJob.status === "building") ? (
              <div className="empty-state empty-state--inline">
                Report data will appear here as soon as the background build completes.
              </div>
            ) : null}
          </div>
        </div>
      </section>
      {optionsModal ? (
        <FieldOptionsModal
          fieldId={optionsModal.fieldId}
          fieldName={optionsModal.fieldName}
          fieldType={optionsModal.fieldType}
          projectKeys={filteredProjects.map((p) => p.projectKey)}
          onClose={() => setOptionsModal(null)}
        />
      ) : null}
    </>
  );
}
