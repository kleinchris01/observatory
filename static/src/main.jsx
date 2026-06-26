import React from "react";
import ReactDOM from "react-dom/client";
import { createPortal } from "react-dom";
import { invoke, rovo, view, router } from "@forge/bridge";
import "./styles.css";
import { formatTimestamp, formatNumber, toDisplayName, buildValueJql } from "./utils";
import { RqtIndexView } from "./tabs/RqtTab";

const bootStatusNode = document.getElementById("boot-status");
const PROJECT_USAGE_PAGE_SIZE = 12;

if (bootStatusNode) {
  bootStatusNode.textContent = "Starting React application...";
}

function formatShortTime(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(new Date(value));
  } catch {
    return "";
  }
}


function normalizeSiteOrigin(siteUrl) {
  if (!siteUrl) return "";

  try {
    return new URL(siteUrl).origin;
  } catch {
    return "";
  }
}

function buildJiraSearchUrl(siteOrigin, jql) {
  if (!siteOrigin || !jql) return null;
  return `${siteOrigin}/issues/?jql=${encodeURIComponent(jql)}`;
}

function handleJiraLinkClick(e, href) {
  if (!href || href === "#") return;
  e.preventDefault();
  router.open(href);
}



function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function slugifyFilenamePart(value, fallback = "report") {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function normalizeReportData(reportData) {
  const normalizedFields = Array.isArray(reportData?.fields)
    ? reportData.fields.map((field) => ({
        ...field,
        projects: Array.isArray(field?.projects) ? field.projects : [],
      }))
    : [];

  return {
    fields: normalizedFields,
    projects: Array.isArray(reportData?.projects) ? reportData.projects : [],
    pendingFields: Array.isArray(reportData?.pendingFields) ? reportData.pendingFields : [],
    uniqueIssueCount: Number.isFinite(reportData?.uniqueIssueCount) ? reportData.uniqueIssueCount : null,
  };
}

class ReportErrorBoundary extends React.Component {
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
          <div className="empty-state">
            {this.state.message || "The report view failed to render."}
          </div>
        </section>
      );
    }

    return this.props.children;
  }
}

function groupReportFieldsByType(fields) {
  const grouped = new Map();

  for (const field of fields || []) {
    const typeKey = String(field?.fieldType || "unknown").trim() || "unknown";
    const bucket = grouped.get(typeKey) || [];
    bucket.push({
      ...field,
      fieldId: String(field?.fieldId || ""),
      fieldName: String(field?.fieldName || field?.fieldId || "Unnamed field"),
      fieldType: typeKey,
      projects: Array.isArray(field?.projects) ? field.projects : [],
    });
    grouped.set(typeKey, bucket);
  }

  return Array.from(grouped.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([fieldType, groupedFields]) => ({
      fieldType,
      fields: [...groupedFields].sort(
        (left, right) =>
          String(left?.fieldName || "").localeCompare(String(right?.fieldName || ""))
          || String(left?.fieldId || "").localeCompare(String(right?.fieldId || ""))
      ),
    }));
}

function summarizeReportData(fields, projects, uniqueIssueCount = null) {
  const projectTotals = new Map();
  const fieldTotals = [];
  const typeTotals = new Map();
  let populatedCells = 0;
  let totalIssues = 0;

  for (const field of fields || []) {
    let fieldIssueCount = 0;
    const fieldProjects = Array.isArray(field?.projects) ? field.projects : [];
    populatedCells += fieldProjects.length;

    for (const project of fieldProjects) {
      const issueCount = Number(project.issueCount || 0);
      fieldIssueCount += issueCount;
      totalIssues += issueCount;
      const projectId = String(project?.projectId || project?.projectKey || "");
      const projectKey = String(project?.projectKey || projectId || "Unknown");
      const projectName = String(project?.projectName || projectKey || "Unknown project");

      const existingProject = projectTotals.get(projectId) || {
        projectId,
        projectKey,
        projectName,
        issueCount: 0,
        fieldCount: 0,
      };
      existingProject.issueCount += issueCount;
      existingProject.fieldCount += 1;
      projectTotals.set(projectId, existingProject);
    }

    fieldTotals.push({
      fieldId: String(field?.fieldId || ""),
      fieldName: String(field?.fieldName || field?.fieldId || "Unnamed field"),
      fieldType: String(field?.fieldType || "unknown"),
      issueCount: fieldIssueCount,
      activeProjectCount: fieldProjects.length,
    });

    const typeKey = String(field?.fieldType || "unknown").trim() || "unknown";
    const existingType = typeTotals.get(typeKey) || {
      fieldType: typeKey,
      fieldCount: 0,
      issueCount: 0,
      activeProjectCount: 0,
    };
    existingType.fieldCount += 1;
    existingType.issueCount += fieldIssueCount;
    existingType.activeProjectCount += fieldProjects.length;
    typeTotals.set(typeKey, existingType);
  }

  const totalPossibleCells = (fields?.length || 0) * (projects?.length || 0);

  return {
    populatedCells,
    totalIssues,
    uniqueIssueCount,
    totalPossibleCells,
    coverageRatio: totalPossibleCells ? populatedCells / totalPossibleCells : 0,
    topProjects: Array.from(projectTotals.values())
      .sort((left, right) => right.issueCount - left.issueCount || left.projectKey.localeCompare(right.projectKey))
      .slice(0, 8),
    topFields: fieldTotals
      .sort((left, right) => right.issueCount - left.issueCount || left.fieldName.localeCompare(right.fieldName))
      .slice(0, 8),
    typeTotals: Array.from(typeTotals.values()).sort(
      (left, right) => right.issueCount - left.issueCount || left.fieldType.localeCompare(right.fieldType)
    ),
  };
}

function formatRelativeTime(value) {
  if (!value) return null;
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatRelativeOrAbsoluteTime(value) {
  if (!value) return "No recent update";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function formatContextList(values, fallback) {
  return values?.length ? values.join(", ") : fallback;
}

function isUsageAvailable(source) {
  return (source?.usageStatus || "ready") === "ready";
}

function buildInventoryRovoPrompt({ totalFields, availableTypes, refreshedAt, currentPage, totalPages, query, typeFilter, sortBy }) {
  return [
    "You are reviewing the Observatory Jira custom field inventory.",
    `Snapshot refreshed at: ${refreshedAt || "unknown"}.`,
    `Visible fields in the current filtered inventory: ${totalFields}.`,
    `Current page: ${currentPage} of ${totalPages}.`,
    `Current search query: ${query || "none"}.`,
    `Current field type filter: ${typeFilter === "all" ? "all types" : typeFilter}.`,
    `Current sort: ${sortBy}.`,
    `Available field types in snapshot: ${formatContextList(availableTypes, "unknown")}.`,
    "Explain the overall field inventory, call out notable governance signals, prioritize admin attention, and recommend the next actions an admin should take.",
  ].join(" ");
}

function buildFieldRovoPrompt(field, details) {
  const contexts = details?.contexts || [];
  const contextNames = contexts.map((context) => context.name).slice(0, 8);
  const projectSamples = contexts.flatMap((context) => context.projects?.map((project) => project.key) || []).slice(0, 12);
  const fieldJql = details?.fieldJql || field.fieldJql;
  const findings = details?.findings || details?.field?.findings || field.findings;

  return [
    "Explain this Jira custom field in detail.",
    `Field id: ${field.id}.`,
    `Field name: ${field.name}.`,
    `Field type: ${field.type}.`,
    `Description: ${field.description || "none"}.`,
    `Configured project count: ${details?.configuredProjectCount ?? field.configuredProjectCount ?? field.usageCount ?? 0}.`,
    `Per-project usage status: ${details?.field?.usageStatus || details?.usageStatus || field.usageStatus || "ready"}.`,
    `Active project count: ${isUsageAvailable(details?.field || details || field) ? (details?.activeProjectCount ?? field.activeProjectCount ?? 0) : "unavailable"}.`,
    `Total issues with populated values: ${isUsageAvailable(details?.field || details || field) ? (details?.totalIssueCount ?? field.totalIssueCount ?? 0) : "unavailable"}.`,
    `Context scope: ${details?.hasGlobalContext ? "global" : "scoped"}.`,
    `Field-wide JQL: ${fieldJql}.`,
    `Sample contexts: ${formatContextList(contextNames, "none")}.`,
    `Sample project keys in scope: ${formatContextList(projectSamples, "none")}.`,
    `Current governance findings: ${formatContextList(findings?.reasons?.map((reason) => reason.title) || [], "none")}.`,
    "Describe what this field does, where it is used, which governance risks or cleanup opportunities exist, and what an admin should review next.",
  ].join(" ");
}

function buildProjectRovoPrompt(field, details, project) {
  return [
    "Explain how a single project is using this Jira custom field.",
    `Field id: ${field.id}.`,
    `Field name: ${field.name}.`,
    `Field type: ${field.type}.`,
    `Project key: ${project.projectKey}.`,
    `Project name: ${project.projectName}.`,
    `Issues with populated values in this project: ${project.issueCount}.`,
    `Latest field activity: ${project.latestFieldChangeAt || "unknown"}.`,
    `Latest matching issue key: ${project.latestIssueKey || "none"}.`,
    `Project-scoped JQL: ${project.jql}.`,
    `Field-wide total issues with values: ${details?.totalIssueCount ?? field.totalIssueCount ?? 0}.`,
    "Explain what this usage pattern suggests, how the project appears to rely on the field, and what governance or standardization checks should be performed.",
  ].join(" ");
}

function buildReportRovoPrompt({ reportName, fields, projects, pendingFields, reportSummary }) {
  const fieldTypes = Array.from(new Set((fields || []).map((field) => field?.fieldType).filter(Boolean))).sort();
  const topFieldNames = (reportSummary?.topFields || []).slice(0, 8).map((field) => field.fieldName);
  const topProjectKeys = (reportSummary?.topProjects || []).slice(0, 8).map((project) => project.projectKey);
  const pendingNames = (pendingFields || []).slice(0, 8).map((field) => field.fieldName);

  return [
    "Review this Observatory report as a collection of Jira custom fields across all included projects.",
    `Report name: ${reportName || "Project Usage Report"}.`,
    `Selected field count: ${fields?.length || 0}.`,
    `Visible project count: ${projects?.length || 0}.`,
    `Field types represented: ${formatContextList(fieldTypes, "unknown")}.`,
    `Populated project-field intersections: ${reportSummary?.populatedCells ?? 0}.`,
    `Total populated issue intersections: ${reportSummary?.totalIssues ?? 0}.`,
    `Distinct populated issues across the selected fields: ${reportSummary?.uniqueIssueCount ?? "unknown"}.`,
    `Top fields by populated issues: ${formatContextList(topFieldNames, "none")}.`,
    `Top projects in this report: ${formatContextList(topProjectKeys, "none")}.`,
    `Fields still pending usage hydration: ${formatContextList(pendingNames, "none")}.`,
    "Explain the dominant usage patterns across this collection of fields, call out cleanup or standardization opportunities, identify risk concentrations, and recommend the next administrative actions for this report as a whole.",
  ].join(" ");
}

function mergeFieldMetrics(field, source) {
  if (!source) {
    return field;
  }

  const sourceField = source.field || source;
  const configuredProjectCount = Math.max(
    field?.configuredProjectCount ?? field?.usageCount ?? 0,
    sourceField?.configuredProjectCount ?? source?.configuredProjectCount ?? sourceField?.usageCount ?? 0
  );
  const activeProjectCount = Math.max(
    field?.activeProjectCount ?? 0,
    sourceField?.activeProjectCount ?? source?.activeProjectCount ?? 0
  );
  const totalIssueCount = Math.max(
    field?.totalIssueCount ?? 0,
    sourceField?.totalIssueCount ?? source?.totalIssueCount ?? 0
  );
  const derivedProjectUsageBuilt =
    sourceField?.projectUsageBuilt ??
    source?.projectUsageBuilt ??
    (source?.summaryStatus === "ready" ? true : undefined);
  const derivedProjectUsageState =
    sourceField?.projectUsageState ||
    source?.projectUsageState ||
    source?.summaryStatus ||
    null;

  return {
    ...field,
    configuredProjectCount,
    usageCount: configuredProjectCount,
    activeProjectCount,
    totalIssueCount,
    usageStatus: sourceField?.usageStatus || source?.usageStatus || field?.usageStatus || "ready",
    usageStatusDetail: sourceField?.usageStatusDetail || source?.usageStatusDetail || field?.usageStatusDetail || null,
    projectUsageBuilt: derivedProjectUsageBuilt ?? field?.projectUsageBuilt ?? false,
    projectUsageState: derivedProjectUsageState || field?.projectUsageState || "unbuilt",
    findings: source?.findings || sourceField?.findings || field?.findings,
  };
}

async function openFieldExpertRovo(prompt) {
  await rovo.open({
    type: "forge",
    agentName: "Observatory Field Expert",
    agentKey: "observatory-field-expert",
    prompt,
  });
}

const ICON_PATHS = {
  layers:        "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  activity:      "M22 12h-4l-3 9L9 3l-3 9H2",
  zap:           "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  folder:        "M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z",
  barChart:      "M18 20V10M12 20V4M6 20v-6",
  alertTriangle: "M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01",
  alertCircle:   "M12 22c5.52 0 10-4.48 10-10S17.52 2 12 2 2 6.48 2 12s4.48 10 10 10zM12 8v4M12 16h.01",
  info:          "M12 22c5.52 0 10-4.48 10-10S17.52 2 12 2 2 6.48 2 12s4.48 10 10 10zM12 16v-4M12 8h.01",
  scissors:      "M6 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12",
  sun:           "M12 7a5 5 0 100 10A5 5 0 0012 7zM12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42",
  moon:          "M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z",
  chevronDown:   "M6 9l6 6 6-6",
  externalLink:  "M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3",
  checkCircle:   "M22 11.08V12a10 10 0 11-5.93-9.14M22 4L12 14.01l-3-3",
  check:         "M20 6L9 17l-5-5",
  x:             "M18 6L6 18M6 6l12 12",
};

function Icon({ name, size = 16 }) {
  const d = ICON_PATHS[name];
  if (!d) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function SkeletonFieldCard() {
  return (
    <div className="skel-field-card">
      <div className="skel-field-card__title">
        <div className="skel" style={{ height: 10, width: "35%" }} />
        <div className="skel" style={{ height: 18, width: "70%" }} />
        <div className="skel" style={{ height: 12, width: "90%" }} />
        <div className="skel" style={{ height: 12, width: "60%" }} />
      </div>
      <div className="skel-field-card__meta">
        <div className="skel" style={{ height: 52 }} />
        <div className="skel" style={{ height: 52 }} />
        <div className="skel" style={{ height: 52 }} />
      </div>
      <div className="skel" style={{ width: 28, height: 28, borderRadius: "50%" }} />
    </div>
  );
}

function SkeletonProjectItem() {
  return (
    <div className="skel-project-item">
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div className="skel" style={{ height: 14, width: "30%" }} />
        <div className="skel" style={{ height: 14, width: "25%" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div className="skel" style={{ height: 12, width: "55%" }} />
        <div className="skel" style={{ height: 12, width: "20%" }} />
      </div>
    </div>
  );
}

function MetricChip({ label, value, tone = "neutral" }) {
  return (
    <div className={`metric-chip metric-chip--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

const FINDING_BADGE_ICON = { danger: "alertTriangle", warn: "scissors", info: "info", neutral: "alertCircle" };

function FindingBadge({ label, tone }) {
  return (
    <span className={`finding-badge finding-badge--${tone}`}>
      <Icon name={FINDING_BADGE_ICON[tone] || "alertCircle"} size={12} />
      {label}
    </span>
  );
}

function FindingsStrip({ findings }) {
  if (!findings?.tags) return null;

  return (
    <div className="findings-strip">
      {findings.tags.adminAttention ? <FindingBadge label="Admin Attention" tone="danger" /> : null}
      {findings.tags.risky ? <FindingBadge label="Risk" tone="danger" /> : null}
      {findings.tags.cleanup ? <FindingBadge label="Cleanup" tone="warn" /> : null}
      {findings.tags.standardize ? <FindingBadge label="Standardize" tone="info" /> : null}
    </div>
  );
}

function ProjectUsageBuildBadge({ field }) {
  const totalIssueCount = Number(field?.totalIssueCount || 0);
  const state = field?.projectUsageState || "unbuilt";

  if (totalIssueCount <= 0) {
    return null;
  }
  if (field?.projectUsageBuilt || state === "ready") {
    return null;
  }
  if (state === "queued" || state === "building") {
    return <FindingBadge label="Usage Building" tone="info" />;
  }
  if (state === "failed" || state === "cancelled") {
    return <FindingBadge label="Usage Incomplete" tone="warn" />;
  }
  return <FindingBadge label="Usage Not Built" tone="neutral" />;
}

function FindingsFilterBar({ value, onChange, summary, hasActiveFilters, onClear }) {
  const filters = [
    { key: "all", label: "All fields" },
    { key: "admin-attention", label: "Admin attention", count: summary.adminAttention },
    { key: "risky", label: "Risk", count: summary.risky },
    { key: "cleanup", label: "Cleanup", count: summary.cleanup },
    { key: "standardize", label: "Standardize", count: summary.standardize },
  ];

  return (
    <div className="findings-filter-bar">
      {filters.map((filter) => (
        <button
          key={filter.key}
          className={`findings-filter-button ${value === filter.key ? "findings-filter-button--active" : ""}`}
          type="button"
          onClick={() => onChange(filter.key)}
        >
          <span>{filter.label}</span>
          {typeof filter.count === "number" ? <strong>{filter.count}</strong> : null}
        </button>
      ))}
      {hasActiveFilters ? (
        <button className="findings-filter-button findings-filter-button--clear" type="button" onClick={onClear}>
          Clear filters
        </button>
      ) : null}
    </div>
  );
}

function SavedReportsPanel({
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
  const [collapsed, setCollapsed] = React.useState(() => localStorage.getItem("atlasiq-saved-reports-collapsed") === "true");

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
                    <button className="secondary-button secondary-button--small" type="button" onClick={() => onLoadReport(report)}>
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

function useLiveDuration(startedAt) {
  const [elapsed, setElapsed] = React.useState(0);
  React.useEffect(() => {
    if (!startedAt) { setElapsed(0); return; }
    const update = () => setElapsed(Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
    update();
    const handle = setInterval(update, 1000);
    return () => clearInterval(handle);
  }, [startedAt]);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function BuildsPanel({ buildProgress, snapshotStatus, onCancel, cancellingBuild }) {
  const isActive = buildProgress !== null;
  const state = buildProgress?.status || snapshotStatus?.state || "idle";
  const totalFields = buildProgress?.totalFields || snapshotStatus?.itemCount || 0;
  const processedFields = buildProgress?.processedFields || snapshotStatus?.processedFields || 0;
  const percent = buildProgress?.percent || (totalFields > 0 ? Math.round((processedFields / totalFields) * 100) : 0);
  const startedAt = buildProgress?.startedAt || snapshotStatus?.startedAt || null;
  const duration = useLiveDuration(state === "building" ? startedAt : null);

  let statusLabel = "No active build";
  let dotTone = "idle";
  if (state === "building") { statusLabel = "Building"; dotTone = "building"; }
  else if (state === "queued") { statusLabel = "Queued"; dotTone = "queued"; }
  else if (state === "ready") { statusLabel = "Completed"; dotTone = "ready"; }
  else if (state === "cancelled") { statusLabel = "Cancelled"; dotTone = "cancelled"; }
  else if (state === "failed") { statusLabel = "Failed"; dotTone = "failed"; }

  return (
    <div className="builds-panel">
      <div className="builds-panel__heading">Builds</div>

      <div className={`build-card build-card--${dotTone}`}>
        <div className="build-card__top">
          <span className={`build-dot build-dot--${dotTone}`} />
          <span className="build-card__state">{statusLabel}</span>
        </div>

        {startedAt && (
          <div className="build-card__meta">
            <span>Started {formatShortTime(startedAt)}</span>
            {state === "building" && <span className="build-card__duration">{duration}</span>}
            {state === "ready" && snapshotStatus?.completedAt && (
              <span>{formatShortTime(snapshotStatus.completedAt)}</span>
            )}
          </div>
        )}

        {totalFields > 0 && (
          <div className="build-card__progress">
            <div className="build-card__bar">
              <div className="build-card__bar-fill" style={{ width: `${percent}%` }} />
            </div>
            <div className="build-card__progress-meta">
              <span>{formatNumber(processedFields)} / {formatNumber(totalFields)}</span>
              <strong>{percent}%</strong>
            </div>
          </div>
        )}

        {snapshotStatus?.state === "ready" && snapshotStatus?.itemCount > 0 && !isActive && (
          <div className="build-card__complete-info">
            {formatNumber(snapshotStatus.itemCount)} fields indexed
          </div>
        )}

        {snapshotStatus?.lastError && state === "failed" && (
          <div className="build-card__error">{snapshotStatus.lastError}</div>
        )}

        {state === "building" && (
          <button
            className="secondary-button secondary-button--small builds-panel__cancel-btn"
            type="button"
            onClick={onCancel}
            disabled={cancellingBuild}
          >
            {cancellingBuild ? "Cancelling..." : "Cancel build"}
          </button>
        )}
      </div>

    </div>
  );
}

function SnapshotBanner({ status, refreshedAt, buildProgress }) {
  if (!status || (status.state !== "queued" && status.state !== "building" && status.state !== "failed" && status.state !== "cancelled")) {
    return null;
  }

  let tone = "info";
  let message;

  if (status.state === "queued") {
    message = refreshedAt
      ? `Background refresh queued. Showing the last completed snapshot from ${formatTimestamp(refreshedAt)}.`
      : "Background refresh queued. Inventory will appear when the first snapshot completes.";
  } else if (status.state === "building") {
    message = refreshedAt
      ? `Background refresh is rebuilding the snapshot. Showing the last completed snapshot from ${formatTimestamp(refreshedAt)}.`
      : "Background refresh is building the first snapshot. This can take a few minutes on large Jira sites.";
  } else if (status.state === "cancelled") {
    message = refreshedAt
      ? `Build was cancelled. Showing the last completed snapshot from ${formatTimestamp(refreshedAt)}. Click Refresh data to start a new build.`
      : "Build was cancelled. Click Refresh data to start a new build.";
  } else {
    tone = "warning";
    message = status.lastError
      ? `Snapshot refresh failed: ${status.lastError}`
      : "Snapshot refresh failed. The previous snapshot will continue to be used until the next successful rebuild.";
  }

  return (
    <div className={`status-banner status-banner--${tone}`}>
      <div className="status-banner__message">{message}</div>
    </div>
  );
}

function ActivitySection({ title, subtitle, open, onToggle, actions, children }) {
  return (
    <section className="activity-section">
      <button className="activity-section__header" type="button" onClick={onToggle} aria-expanded={open}>
        <div className="activity-section__copy">
          <div className="snapshot-log-entries__heading">{title}</div>
          {subtitle ? <div className="saved-reports-panel__subtitle">{subtitle}</div> : null}
        </div>
        <div className="activity-section__controls">
          {actions ? <div className="section-heading__actions">{actions}</div> : null}
          <span className={`activity-section__chevron ${open ? "activity-section__chevron--open" : ""}`}>
            <Icon name="chevronDown" size={16} />
          </span>
        </div>
      </button>
      {open ? <div className="activity-section__body">{children}</div> : null}
    </section>
  );
}

function UniverseScanPanel({
  issueScan,
  onStart,
  onResume,
  onCancel,
  issueScanLoading,
  issueScanResuming,
  issueScanCancelling,
  deltaIssueScan,
  onStartDelta,
  issueScanDeltaStarting,
}) {
  const scanActive = issueScan?.state === "building" || issueScan?.state === "queued";
  const scanDone = issueScan?.state === "ready";
  const lastScanLogAt = issueScan?.progressLog?.length
    ? issueScan.progressLog[issueScan.progressLog.length - 1]?.t
    : issueScan?.startedAt;
  const scanStale = lastScanLogAt
    ? (Date.now() - new Date(lastScanLogAt).getTime()) > 10 * 60 * 1000
    : scanActive;
  const canResume = issueScan
    && !scanDone
    && ((scanActive && scanStale) || issueScan?.state === "failed" || issueScan?.state === "cancelled");
  const canForceResume = scanActive && scanStale;
  const processedIssues = Number(issueScan?.processedIssues || 0);
  const totalIssues = Number(issueScan?.totalIssues || 0);
  const processedProjects = Number(issueScan?.processedPages || 0);
  const totalProjects = Number(issueScan?.totalPages || 0);
  // Percentage is always worker-based (processedPages / totalPages) — exact and never exceeds 100%.
  // totalIssues is an estimate from Jira's approximate-count API and can be lower than the real count.
  const scanPercent = totalProjects > 0
    ? Math.min(100, Math.round(processedProjects / totalProjects * 100))
    : 0;
  const entries = issueScan?.progressLog?.length ? [...issueScan.progressLog].reverse() : [];

  const elapsed = useLiveDuration(scanActive ? issueScan?.startedAt : null);
  const etaLabel = React.useMemo(() => {
    if (!scanActive) return null;
    const doneWorkers = Number(issueScan?.processedPages || 0);
    const totalWorkers = Number(issueScan?.totalPages || 0);
    if (doneWorkers < 1 || totalWorkers <= doneWorkers) return null;
    const startMs = issueScan?.startedAt ? new Date(issueScan.startedAt).getTime() : 0;
    if (!startMs) return null;
    const elapsedSec = (Date.now() - startMs) / 1000;
    const rate = doneWorkers / elapsedSec;
    if (rate <= 0) return null;
    const remainingSec = Math.round((totalWorkers - doneWorkers) / rate);
    const m = Math.floor(remainingSec / 60);
    const s = remainingSec % 60;
    return m > 0 ? `~${m}m ${s}s remaining` : `~${s}s remaining`;
  }, [scanActive, issueScan?.processedPages, issueScan?.totalPages, issueScan?.startedAt, elapsed]);

  return (
    <div className="issue-scan-panel">
      <div className="issue-scan-panel__header">
        <span className="issue-scan-panel__title">Universe Scan</span>
        {scanDone && issueScan?.completedAt ? (
          <span className="issue-scan-panel__done">{formatNumber(issueScan.processedIssues || issueScan.totalIssues)} issues scanned</span>
        ) : null}
      </div>
      {scanActive ? (
        <div className="issue-scan-panel__progress">
          <div className="issue-scan-panel__bar-track">
            <div className="issue-scan-panel__bar-fill" style={{ width: `${scanPercent}%` }} />
          </div>
          <div className="issue-scan-panel__status">
            <span className="issue-scan-panel__status-main">
              {totalProjects > 0
                ? `${scanPercent}% — ${processedIssues > 0 ? `${formatNumber(processedIssues)} issues scanned — ` : ""}${formatNumber(processedProjects)}/${formatNumber(totalProjects)} workers`
                : "Starting…"}
            </span>
            <span className="issue-scan-panel__status-meta">
              {elapsed ? <span className="issue-scan-panel__elapsed">{elapsed}</span> : null}
              {etaLabel ? <span className="issue-scan-panel__eta">{etaLabel}</span> : null}
            </span>
          </div>
          <div className="issue-scan-panel__buttons">
            {canForceResume ? (
              <button
                className="secondary-button secondary-button--small"
                type="button"
                onClick={onResume}
                disabled={issueScanResuming}
              >
                {issueScanResuming ? "Resuming..." : "Resume"}
              </button>
            ) : null}
            <button
              className="secondary-button secondary-button--small"
              type="button"
              onClick={onCancel}
              disabled={issueScanCancelling}
            >
              {issueScanCancelling ? "Cancelling..." : "Cancel scan"}
            </button>
          </div>
        </div>
      ) : (
        <div className="issue-scan-panel__actions">
          <p className="issue-scan-panel__desc">
            {scanDone
              ? "Unique issue counts are shown per project. Re-scan to refresh."
              : "Scan all issues once to get accurate unique issue counts per project."}
          </p>
          <button
            className="secondary-button secondary-button--small"
            type="button"
            onClick={canResume ? onResume : onStart}
            disabled={canResume ? issueScanResuming : issueScanLoading}
          >
            {canResume
              ? (issueScanResuming ? "Resuming..." : "Resume scan")
              : (issueScanLoading ? "Starting..." : scanDone ? "Re-scan all issues" : "Scan all issues")}
          </button>
          {issueScan?.state === "failed" && issueScan?.lastError ? (
            <div className="issue-scan-panel__error">{issueScan.lastError}</div>
          ) : null}
        </div>
      )}
      {entries.length ? (
        <div className="scan-log issue-scan-panel__log">
          {entries.map((entry, index) => (
            <div key={`issue-scan-${index}`} className="scan-log__entry">
              <span className="scan-log__time">{formatShortTime(entry.t)}</span>
              <span className="scan-log__msg">{entry.msg}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state empty-state--inline">
          {scanActive ? "Waiting for the scan log to populate..." : "No universe scan log entries yet."}
        </div>
      )}
      <DeltaIssueScanPanel
        deltaIssueScan={deltaIssueScan}
        onStartDelta={onStartDelta}
        issueScanDeltaStarting={issueScanDeltaStarting}
      />
    </div>
  );
}

function DeltaIssueScanPanel({ deltaIssueScan, onStartDelta, issueScanDeltaStarting }) {
  const deltaActive = deltaIssueScan?.state === "building" || deltaIssueScan?.state === "queued";
  const deltaReady = deltaIssueScan?.state === "ready";
  const deltaFailed = deltaIssueScan?.state === "failed";
  const deltaPercent = deltaIssueScan?.totalIssues > 0
    ? Math.min(100, Math.round((Number(deltaIssueScan.processedIssues || 0) / Number(deltaIssueScan.totalIssues)) * 100))
    : 0;

  return (
    <div className="delta-scan-panel">
      <div className="delta-scan-panel__header">
        <span className="delta-scan-panel__title">Quick Scan (24h)</span>
        {deltaReady && deltaIssueScan?.completedAt ? (
          <span className="delta-scan-panel__done">
            Last ran {formatShortTime(deltaIssueScan.completedAt)}
            {` · ${formatNumber(deltaIssueScan.processedIssues || 0)} issues`}
            {deltaIssueScan.fieldProjectPairsUpdated > 0
              ? ` · ${formatNumber(deltaIssueScan.fieldProjectPairsUpdated)} field×project pairs updated`
              : ""}
          </span>
        ) : null}
      </div>
      <p className="delta-scan-panel__desc">
        Scans issues created or updated in the last 24h (~5% of total), refreshes field usage counts for all touched field×project pairs. Runs automatically after each full scan and inventory snapshot.
      </p>
      {deltaActive ? (
        <div className="delta-scan-panel__progress">
          <div className="issue-scan-panel__bar-track">
            <div className="issue-scan-panel__bar-fill" style={{ width: `${deltaPercent}%` }} />
          </div>
          <div className="issue-scan-panel__status">
            {deltaIssueScan?.state === "queued"
              ? "Queued..."
              : `${deltaPercent}% — ${formatNumber(deltaIssueScan?.processedIssues || 0)} of ${formatNumber(deltaIssueScan?.totalIssues || 0)} issues`}
          </div>
        </div>
      ) : null}
      {deltaFailed && deltaIssueScan?.lastError ? (
        <div className="issue-scan-panel__error">{deltaIssueScan.lastError}</div>
      ) : null}
      <div className="delta-scan-panel__actions">
        <button
          className="secondary-button secondary-button--small"
          type="button"
          onClick={onStartDelta}
          disabled={issueScanDeltaStarting || deltaActive}
        >
          {issueScanDeltaStarting || deltaActive ? "Running..." : "Run quick scan"}
        </button>
      </div>
    </div>
  );
}

function ProjectUsageJobsView({
  jobs,
  expandedJobFieldId,
  onToggleJob,
  onCancelJob,
  cancellingJobFieldId,
  onResumeJob,
  resumingJobFieldId,
  onRefreshJob,
  refreshingUsageJobFieldId,
  onRefreshRecentUsage,
  refreshingRecentUsage,
  onRefresh,
  refreshingJobs,
  jobsRefreshedAt,
}) {
  const activeJobs = jobs.filter((job) => job.summaryStatus === "queued" || job.summaryStatus === "building");
  const aggregateEstimatedIssues = activeJobs.reduce((sum, job) => sum + Number(job.estimatedIssueTotal || job.totalIssueCount || 0), 0);
  const aggregateProcessedIssues = activeJobs.reduce((sum, job) => sum + Number(job.processedIssueCount || 0), 0);
  const aggregatePercent = aggregateEstimatedIssues > 0
    ? Math.min(100, Math.round((aggregateProcessedIssues / aggregateEstimatedIssues) * 100))
    : 0;

  return (
    <section className="snapshot-log-view">
      <div className="snapshot-log-layout">
        <div className="snapshot-log-entries">
          <div className="section-heading">
            <div className="snapshot-log-entries__heading">Project Usage Jobs</div>
            <div className="section-heading__actions">
              {jobsRefreshedAt ? <span>Updated {formatShortTime(jobsRefreshedAt)}</span> : null}
              <button className="secondary-button secondary-button--small" type="button" onClick={onRefreshRecentUsage} disabled={refreshingRecentUsage}>
                {refreshingRecentUsage ? "Queueing 24h refresh..." : "Refresh last 24h"}
              </button>
              <button className="secondary-button secondary-button--small" type="button" onClick={onRefresh} disabled={refreshingJobs}>
                {refreshingJobs ? "Refreshing..." : "Refresh jobs"}
              </button>
            </div>
          </div>
          {activeJobs.length ? (
            <div className="scan-log__entry" style={{ display: "block", marginBottom: 12 }}>
              <div className="build-card__top">
                <span className="build-dot build-dot--building" />
                <span className="build-card__state">Overall progress</span>
                <span className="scan-log__time">{activeJobs.length} active job{activeJobs.length === 1 ? "" : "s"}</span>
              </div>
              <div className="build-card__meta">
                <span>{formatNumber(aggregateEstimatedIssues)} total matching issues</span>
                <span>{formatNumber(aggregateProcessedIssues)} scanned</span>
                <span>{formatNumber(aggregateEstimatedIssues - aggregateProcessedIssues)} remaining</span>
              </div>
              <div className="status-progress" style={{ marginTop: 10 }}>
                <div className="status-progress__meta">
                  <strong>{aggregatePercent}%</strong>
                  <span>
                    {formatNumber(aggregateProcessedIssues)} of {formatNumber(aggregateEstimatedIssues)} matching issues scanned
                  </span>
                </div>
                <div className="status-progress__bar" aria-hidden="true">
                  <span style={{ width: `${aggregatePercent}%` }} />
                </div>
              </div>
            </div>
          ) : null}
          {jobs.length ? (
            <div className="scan-log">
              {jobs.map((job) => {
                const expanded = expandedJobFieldId === job.fieldId;
                return (
                <div key={job.fieldId} className="scan-log__entry" style={{ display: "block" }}>
                  <button
                    className="build-card__button"
                    type="button"
                    onClick={() => onToggleJob(job.fieldId)}
                    aria-expanded={expanded}
                    style={{ width: "100%", textAlign: "left", background: "transparent", border: 0, padding: 0, cursor: "pointer" }}
                  >
                  <div className="build-card__top">
                    <span className={`build-dot build-dot--${job.summaryStatus || "idle"}`} />
                    <span className="build-card__state">{job.fieldName}</span>
                    <span className="scan-log__time">{job.summaryStatus}</span>
                  </div>
                  <div className="build-card__meta">
                    <span>{job.fieldId}</span>
                    <span>{job.activeProjectCount} active projects</span>
                    <span>{job.totalIssueCount} issues</span>
                    {job.estimatedIssueTotal > 0 ? <span>{job.processedIssueCount} / {job.estimatedIssueTotal} matching issues scanned</span> : null}
                    {job.startedAt ? <span>Started {formatShortTime(job.startedAt)}</span> : null}
                    {job.completedAt ? <span>Completed {formatShortTime(job.completedAt)}</span> : null}
                  </div>
                  <div className="status-progress" style={{ marginTop: 10 }}>
                    <div className="status-progress__meta">
                      <strong>{job.percentComplete}%</strong>
                      <span>{job.processedIssueCount} of {job.estimatedIssueTotal || 0} matching issues scanned</span>
                    </div>
                    <div className="status-progress__bar" aria-hidden="true">
                      <span style={{ width: `${job.percentComplete}%` }} />
                    </div>
                  </div>
                  </button>
                  {expanded ? (
                    <>
                  {(job.summaryStatus === "queued" || job.summaryStatus === "building") ? (
                    <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        className="secondary-button secondary-button--small"
                        type="button"
                        onClick={() => onRefreshJob(job.fieldId)}
                        disabled={refreshingUsageJobFieldId === job.fieldId}
                      >
                        {refreshingUsageJobFieldId === job.fieldId ? "Refreshing..." : "Refresh usage"}
                      </button>
                      <button
                        className="secondary-button secondary-button--small"
                        type="button"
                        onClick={() => onCancelJob(job.fieldId)}
                        disabled={cancellingJobFieldId === job.fieldId}
                      >
                        {cancellingJobFieldId === job.fieldId ? "Cancelling..." : "Cancel job"}
                      </button>
                    </div>
                  ) : null}
                  {(job.summaryStatus === "failed" || job.summaryStatus === "cancelled" || job.summaryStatus === "deferred") ? (
                    <div style={{ marginTop: 10 }}>
                      <button
                        className="secondary-button secondary-button--small"
                        type="button"
                        onClick={() => onResumeJob(job.fieldId)}
                        disabled={resumingJobFieldId === job.fieldId}
                      >
                        {resumingJobFieldId === job.fieldId
                          ? (job.summaryStatus === "deferred" ? "Starting..." : "Resuming...")
                          : (job.summaryStatus === "deferred" ? "Start job" : "Resume job")}
                      </button>
                    </div>
                  ) : null}
                  {job.lastError ? <div className="build-card__error">{job.lastError}</div> : null}
                  {job.progressLog?.length ? (
                    <div className="scan-log" style={{ marginTop: 10 }}>
                      {[...job.progressLog].reverse().map((entry, index) => (
                        <div key={`${job.fieldId}-${index}`} className="scan-log__entry">
                          <span className="scan-log__time">{formatShortTime(entry.t)}</span>
                          <span className="scan-log__msg">{entry.msg}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                    </>
                  ) : null}
                </div>
              )})}
            </div>
          ) : (
            <div className="empty-state empty-state--inline">No project-usage jobs yet.</div>
          )}
        </div>
      </div>
    </section>
  );
}

const SELECT_FIELD_TYPE_KEYWORDS = ["select", "multiselect", "radiobutton", "checkbox", "cascadingselect"];
function isSelectType(fieldType) {
  const normalized = String(fieldType || "").toLowerCase().replace(/[\s\-_]/g, "");
  return SELECT_FIELD_TYPE_KEYWORDS.some((kw) => normalized.includes(kw));
}

function FieldOptionsModal({ fieldId, fieldName, fieldType, projectKeys, onClose }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    invoke("getFieldOptions", { fieldId, projectKeys: projectKeys || [] })
      .then((result) => { if (!cancelled) { setData(result); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err?.message || String(err)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [fieldId]);

  const allOptions = React.useMemo(
    () => (data?.optionsByContext || []).flatMap((ctx) => ctx.options),
    [data]
  );
  const hasUsage = allOptions.some((opt) => opt.issueCount != null);
  const maxCount = hasUsage ? Math.max(1, ...allOptions.map((o) => o.issueCount || 0)) : 1;

  return createPortal(
    <div className="field-options-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="field-options-modal" onClick={(e) => e.stopPropagation()}>
        <div className="field-options-modal__header">
          <div>
            <div className="field-card__eyebrow">{fieldId}</div>
            <h3 style={{ margin: "4px 0 6px" }}>{fieldName}</h3>
            <span className="field-type-tag">{fieldType}</span>
          </div>
          <button className="field-options-modal__close" onClick={onClose} type="button" aria-label="Close">✕</button>
        </div>
        <div className="field-options-modal__body">
          {loading ? (
            <div className="empty-state empty-state--inline">Loading options{projectKeys?.length ? " and computing usage counts" : ""}…</div>
          ) : error ? (
            <div className="empty-state empty-state--inline">Failed to load options: {error}</div>
          ) : !data?.optionsByContext?.length ? (
            <div className="empty-state empty-state--inline">No contexts or options found for this field.</div>
          ) : data.optionsByContext.map((ctx) => (
            <div key={ctx.contextId} className="field-options-modal__context">
              <div className="field-options-modal__context-name">
                {ctx.contextName}{ctx.isGlobalContext ? " (global)" : ""}
                <span className="field-options-modal__option-chip">{ctx.options.length} option{ctx.options.length !== 1 ? "s" : ""}</span>
              </div>
              {ctx.fetchError ? (
                <div className="empty-state empty-state--inline" style={{ padding: "8px 0", color: "var(--danger, #c0392b)" }}>Failed to load options: {ctx.fetchError}</div>
              ) : ctx.options.length ? (
                <div className="field-options-modal__list">
                  {[...ctx.options]
                    .sort((a, b) => (b.issueCount ?? -1) - (a.issueCount ?? -1) || a.value.localeCompare(b.value))
                    .map((opt) => {
                      const pct = hasUsage ? Math.max(3, Math.round(((opt.issueCount || 0) / maxCount) * 100)) : 0;
                      return (
                        <div key={opt.id} className={`field-options-modal__option${opt.disabled ? " field-options-modal__option--disabled" : ""}`}>
                          <span className="field-options-modal__option-name">{opt.value}{opt.disabled ? " (disabled)" : ""}</span>
                          {hasUsage ? (
                            <div className="field-options-modal__bar-row">
                              <div className="field-options-modal__bar-track">
                                <div className="field-options-modal__bar-fill" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="field-options-modal__count">{opt.issueCount != null ? formatNumber(opt.issueCount) : "—"}</span>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                </div>
              ) : (
                <div className="empty-state empty-state--inline" style={{ padding: "8px 0" }}>No options defined in this context.</div>
              )}
            </div>
          ))}
        </div>
        {!loading && hasUsage && (
          <div className="field-options-modal__footer">
            {projectKeys?.length
              ? `Issue counts filtered to ${projectKeys.length} project${projectKeys.length !== 1 ? "s" : ""} in this report`
              : "Issue counts across all projects"}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function ProjectUsageReportView({
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

  React.useEffect(() => {
    setReportFieldTypeFilter("all");
    setReportProjectFilter("");
    setTableSortMode("type");
    setTableOrientation("fields");
    setOptionsModal(null);
  }, [reportData]);

  const {
    fields = [],
    projects = [],
    pendingFields = [],
    uniqueIssueCount = null,
  } = normalizeReportData(reportData);
  const availableReportTypes = React.useMemo(
    () => Array.from(new Set((fields || []).map((field) => field.fieldType).filter(Boolean))).sort((left, right) => left.localeCompare(right)),
    [fields]
  );
  const normalizedProjectFilter = reportProjectFilter.trim().toLowerCase();
  const filteredProjects = React.useMemo(() => {
    if (!normalizedProjectFilter) {
      return Array.isArray(projects) ? projects : [];
    }
    return (Array.isArray(projects) ? projects : []).filter((project) =>
      [project?.projectKey, project?.projectName]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalizedProjectFilter))
    );
  }, [projects, normalizedProjectFilter]);
  const filteredProjectIds = React.useMemo(
    () => new Set(filteredProjects.map((project) => String(project?.projectId || project?.projectKey || ""))),
    [filteredProjects]
  );
  const filteredFields = React.useMemo(() => {
    return (fields || [])
      .filter((field) => reportFieldTypeFilter === "all" || field.fieldType === reportFieldTypeFilter)
      .map((field) => ({
        ...field,
        projects: (Array.isArray(field?.projects) ? field.projects : []).filter((project) =>
          filteredProjectIds.has(String(project?.projectId || project?.projectKey || ""))
        ),
      }))
      .filter((field) => !normalizedProjectFilter || field.projects.length > 0);
  }, [fields, filteredProjectIds, reportFieldTypeFilter, normalizedProjectFilter]);

  const flatFieldsSorted = React.useMemo(() => {
    if (tableSortMode === "type") return [];
    return [...filteredFields]
      .map((f) => ({ ...f, _totalIssues: (f.projects || []).reduce((s, p) => s + Number(p.issueCount || 0), 0) }))
      .sort(tableSortMode === "issues"
        ? (a, b) => b._totalIssues - a._totalIssues || a.fieldName.localeCompare(b.fieldName)
        : (a, b) => a.fieldName.localeCompare(b.fieldName) || a.fieldId.localeCompare(b.fieldId));
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
    reportFieldTypeFilter === "all" && !normalizedProjectFilter ? uniqueIssueCount : null
  );
  const hasReportFilters = reportFieldTypeFilter !== "all" || normalizedProjectFilter !== "";
  if (!fields.length && !(reportJob && (reportJob.status === "queued" || reportJob.status === "building"))) {
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
        <div className="empty-state">No report rows were returned for the selected fields.</div>
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
                <span className="build-card__state">{reportJob.reportName || reportName || "Project Usage Report"}</span>
                <span className="scan-log__time">{reportJob.status}</span>
              </div>
              <div className="build-card__meta">
                <span>{formatNumber(reportJob.processedFields)} of {formatNumber(reportJob.totalFields)} fields processed</span>
                {reportJob.startedAt ? <span>Started {formatShortTime(reportJob.startedAt)}</span> : null}
                {reportJob.completedAt ? <span>Completed {formatShortTime(reportJob.completedAt)}</span> : null}
              </div>
              <div className="status-progress" style={{ marginTop: 10 }}>
                <div className="status-progress__meta">
                  <strong>{reportJob.percentComplete || 0}%</strong>
                  <span>{formatNumber(reportJob.processedFields)} of {formatNumber(reportJob.totalFields)} fields processed</span>
                </div>
                <div className="status-progress__bar" aria-hidden="true">
                  <span style={{ width: `${reportJob.percentComplete || 0}%` }} />
                </div>
              </div>
              {reportJob.lastError ? <div className="build-card__error" style={{ marginTop: 10 }}>{reportJob.lastError}</div> : null}
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
              <div className="saved-reports-panel__subtitle">Rows are fields, columns are projects, and each populated cell links to the JQL.</div>
            </div>
            <div className="section-heading__actions">
              <span>{filteredFields.length} fields · {filteredProjects.length} projects shown</span>
              <button
                className="secondary-button secondary-button--small"
                type="button"
                onClick={() => onAskReport({ fields: filteredFields, projects: filteredProjects, pendingFields, reportSummary })}
                disabled={!rovoEnabled}
              >
                Ask Rovo
              </button>
              <button
                className="secondary-button secondary-button--small"
                type="button"
                onClick={() => onExportCsv({ ...reportData, fields: filteredFields, projects: filteredProjects, uniqueIssueCount: reportSummary.uniqueIssueCount })}
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
              <select value={reportFieldTypeFilter} onChange={(event) => setReportFieldTypeFilter(event.target.value)}>
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
                <div className="report-insight-card__meta">{reportSummary.typeTotals.length} field types represented</div>
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
                  {formatNumber(reportSummary.uniqueIssueCount >= 0 ? reportSummary.uniqueIssueCount : reportSummary.totalIssues)}
                </div>
                <div className="report-insight-card__meta">
                  {reportSummary.uniqueIssueCount >= 0
                    ? "Distinct issues matching at least one selected field"
                    : "Fallback total from populated project-field intersections"}
                </div>
              </article>
              <article className="report-insight-card">
                <div className="report-insight-card__label">Most active project</div>
                <div className="report-insight-card__value">{reportSummary.topProjects[0]?.projectKey || "None"}</div>
                <div className="report-insight-card__meta">
                  {formatNumber(reportSummary.topProjects[0]?.issueCount)} issues across {formatNumber(reportSummary.topProjects[0]?.fieldCount)} fields
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
                            style={{ width: `${Math.max(8, Math.round((fieldSummary.issueCount / maxValue) * 100))}%` }}
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
                            style={{ width: `${Math.max(8, Math.round((typeSummary.issueCount / maxValue) * 100))}%` }}
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
          <div className="report-table-wrap">
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
                              <button className="report-table__field-btn" type="button" onClick={() => setOptionsModal({ fieldId: field.fieldId, fieldName: field.fieldName, fieldType: field.fieldType })}>
                                {toDisplayName(field.fieldName)}
                              </button>
                            ) : toDisplayName(field.fieldName)}
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
                            <td key={`${project.projectId}-${field.fieldId}`}>
                              {cell && href ? (
                                <a className="smart-link-card smart-link-card--compact" href={href} target="_blank" rel="noreferrer" onClick={(e) => handleJiraLinkClick(e, href)}>
                                  <span className="smart-link-card__title">{cell.issueCount} issues</span>
                                </a>
                              ) : ""}
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
                    {tableSortMode === "type" ? groupedFields.map((group) => (
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
                                    <button className="report-table__field-btn" type="button" onClick={() => setOptionsModal({ fieldId: field.fieldId, fieldName: field.fieldName, fieldType: field.fieldType })}>
                                      {displayName}
                                    </button>
                                  ) : displayName}
                                </div>
                                <div className="field-card__eyebrow">{field.fieldId}</div>
                              </th>
                              {filteredProjects.map((project) => {
                                const cell = cellByProjectId.get(project.projectId);
                                const href = buildJiraSearchUrl(siteOrigin, cell?.jql);
                                return (
                                  <td key={`${field.fieldId}-${project.projectId}`}>
                                    {cell && href ? (
                                      <a className="smart-link-card smart-link-card--compact" href={href} target="_blank" rel="noreferrer" onClick={(e) => handleJiraLinkClick(e, href)}>
                                        <span className="smart-link-card__title">{cell.issueCount} issues</span>
                                      </a>
                                    ) : ""}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    )) : flatFieldsSorted.map((field) => {
                      const cellByProjectId = new Map(field.projects.map((p) => [p.projectId, p]));
                      const canShowOptions = isSelectType(field.fieldType);
                      const displayName = toDisplayName(field.fieldName);
                      return (
                        <tr key={field.fieldId}>
                          <th>
                            <div className="report-table__field-name">
                              {canShowOptions ? (
                                <button className="report-table__field-btn" type="button" onClick={() => setOptionsModal({ fieldId: field.fieldId, fieldName: field.fieldName, fieldType: field.fieldType })}>
                                  {displayName}
                                </button>
                              ) : displayName}
                            </div>
                            <span className="field-type-tag">{field.fieldType}</span>
                            <div className="field-card__eyebrow">{field.fieldId}</div>
                          </th>
                          {filteredProjects.map((project) => {
                            const cell = cellByProjectId.get(project.projectId);
                            const href = buildJiraSearchUrl(siteOrigin, cell?.jql);
                            return (
                              <td key={`${field.fieldId}-${project.projectId}`}>
                                {cell && href ? (
                                  <a className="smart-link-card smart-link-card--compact" href={href} target="_blank" rel="noreferrer" onClick={(e) => handleJiraLinkClick(e, href)}>
                                    <span className="smart-link-card__title">{cell.issueCount} issues</span>
                                  </a>
                                ) : ""}
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
          </div>
          ) : reportJob && (reportJob.status === "queued" || reportJob.status === "building") ? (
            <div className="empty-state empty-state--inline">Report data will appear here as soon as the background build completes.</div>
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

const CHART_PALETTE = [
  "#79b8ff", "#f2b367", "#7ee8a2", "#e36bae", "#b39ddb", "#ff8a80", "#80deea",
];

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
              <span className="chart-bar-label" title={field.fieldName}>{field.fieldName}</span>
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
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 7);
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
              <span className="chart-legend-label" title={seg.type}>{seg.type}</span>
              <span className="chart-legend-count">{seg.count}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProjectsTabView({
  data,
  loading,
  siteOrigin,
  selectedProjectId,
  onSelectProject,
  projectQuery,
  onProjectQueryChange,
  fieldQuery,
  onFieldQueryChange,
  fieldType,
  onFieldTypeChange,
  fieldSort,
  onFieldSortChange,
  onChangePage,
  onRestoreProjectUsageCache,
  projectUsageRestoring,
}) {
  const projects = data?.projects || [];
  const selectedProject = data?.selectedProject || null;
  const fields = data?.fields || [];
  const availableTypes = data?.availableTypes || [];
  const totalFields = Number(data?.totalFields || 0);
  const page = Number(data?.page || 1);
  const totalPages = Number(data?.totalPages || 1);
  const refreshedAt = data?.refreshedAt || null;
  const currentProjectIndex = Math.max(0, projects.findIndex((project) => project.projectId === selectedProjectId));
  const previousProject = currentProjectIndex > 0 ? projects[currentProjectIndex - 1] : null;
  const nextProject = currentProjectIndex >= 0 && currentProjectIndex < projects.length - 1 ? projects[currentProjectIndex + 1] : null;

  return (
    <section className="snapshot-log-view">
      <div className="snapshot-log-layout projects-view">
        <aside className="builds-panel projects-rail">
          <div className="section-heading">
            <div>
              <div className="snapshot-log-entries__heading">Projects</div>
              <div className="saved-reports-panel__subtitle">
                Switch between projects and review every field with detected usage on that project.
              </div>
            </div>
          </div>
          <label className="toolbar__field">
            <span>Project search</span>
            <input
              type="search"
              placeholder="Project key or name"
              value={projectQuery}
              onChange={(event) => onProjectQueryChange(event.target.value)}
              data-search-input="primary"
            />
          </label>
          <div className="projects-rail__list">
            {loading && !projects.length ? (
              Array.from({ length: 5 }, (_, i) => <SkeletonProjectItem key={i} />)
            ) : projects.length ? projects.map((project) => {
              const active = project.projectId === selectedProjectId;
              return (
                <button
                  key={project.projectId}
                  className={`projects-rail__item ${active ? "projects-rail__item--active" : ""}`}
                  type="button"
                  onClick={() => onSelectProject(project.projectId)}
                >
                  <div className="projects-rail__item-top">
                    <strong>{project.projectKey}</strong>
                    <span>
                      {project.uniqueIssueCount != null
                        ? `${formatNumber(project.uniqueIssueCount)} issues`
                        : `${formatNumber(project.totalIssueCount)} fills`}
                    </span>
                  </div>
                  <div className="projects-rail__item-bottom">
                    <span>{project.projectName}</span>
                    <span>{formatNumber(project.fieldCount)} fields</span>
                  </div>
                </button>
              );
            }) : (
              <div className="empty-state empty-state--inline">
                {loading ? "Loading projects..." : (
                  <>
                    <p style={{ margin: "0 0 8px" }}>No projects with cached field usage were found.</p>
                    {onRestoreProjectUsageCache ? (
                      <button
                        className="secondary-button secondary-button--small"
                        type="button"
                        onClick={onRestoreProjectUsageCache}
                        disabled={projectUsageRestoring}
                      >
                        {projectUsageRestoring ? "Restoring..." : "Restore from field summaries"}
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            )}
          </div>
        </aside>

        <div className="snapshot-log-entries">
          <div className="section-heading">
            <div>
              <div className="snapshot-log-entries__heading">
                {selectedProject ? `${selectedProject.projectKey} project usage` : "Project usage"}
              </div>
              <div className="saved-reports-panel__subtitle">
                {selectedProject
                  ? `${selectedProject.projectName} · refreshed ${formatTimestamp(refreshedAt)}`
                  : "Select a project to inspect cached field usage."}
              </div>
            </div>
            {selectedProject ? (
              <div className="section-heading__actions">
                <button
                  className="secondary-button secondary-button--small"
                  type="button"
                  onClick={() => previousProject && onSelectProject(previousProject.projectId)}
                  disabled={!previousProject}
                >
                  Previous project
                </button>
                <button
                  className="secondary-button secondary-button--small"
                  type="button"
                  onClick={() => nextProject && onSelectProject(nextProject.projectId)}
                  disabled={!nextProject}
                >
                  Next project
                </button>
              </div>
            ) : null}
          </div>

          {selectedProject ? (
            <>
              <div className="report-dashboard__metric-grid report-dashboard__metric-grid--3">
                <article className="report-insight-card">
                  <div className="report-insight-card__label">Projects in snapshot</div>
                  <div className="report-insight-card__value">{formatNumber(projects.length)}</div>
                  <div className="report-insight-card__meta">Quick switch between every cached project</div>
                </article>
                <article className="report-insight-card">
                  <div className="report-insight-card__label">Fields with usage</div>
                  <div className="report-insight-card__value">{formatNumber(selectedProject.fieldCount)}</div>
                  <div className="report-insight-card__meta">Fields where at least one issue has a populated value on this project</div>
                </article>
                {selectedProject.uniqueIssueCount != null ? (
                  <article className="report-insight-card">
                    <div className="report-insight-card__label">Unique issues</div>
                    <div className="report-insight-card__value">{formatNumber(selectedProject.uniqueIssueCount)}</div>
                    <div className="report-insight-card__meta">Distinct issues in this project from the universe scan</div>
                  </article>
                ) : (
                  <article className="report-insight-card">
                    <div className="report-insight-card__label">Field fills</div>
                    <div className="report-insight-card__value">{formatNumber(selectedProject.totalIssueCount)}</div>
                    <div className="report-insight-card__meta">Sum of issue counts across all fields — run a universe scan for unique issue counts</div>
                  </article>
                )}
              </div>

              {fields.length > 0 && (
                <div className="project-charts-row">
                  <TopFieldsChart fields={fields} />
                  <FieldTypeDonut fields={fields} />
                </div>
              )}

              <section className="report-filters">
                <label className="toolbar__field">
                  <span>Field search</span>
                  <input
                    type="search"
                    placeholder="Field name, id, or description"
                    value={fieldQuery}
                    onChange={(event) => onFieldQueryChange(event.target.value)}
                  />
                </label>
                <label className="toolbar__field">
                  <span>Field type</span>
                  <select value={fieldType} onChange={(event) => onFieldTypeChange(event.target.value)}>
                    <option value="all">All types</option>
                    {availableTypes.map((typeOption) => (
                      <option key={typeOption} value={typeOption}>{typeOption}</option>
                    ))}
                  </select>
                </label>
                <label className="toolbar__field">
                  <span>Sort</span>
                  <select value={fieldSort} onChange={(event) => onFieldSortChange(event.target.value)}>
                    <option value="issues-desc">Most issues on project</option>
                    <option value="issues-asc">Fewest issues on project</option>
                    <option value="updated-desc">Most recently updated</option>
                    <option value="updated-asc">Least recently updated</option>
                    <option value="name-asc">Name A-Z</option>
                    <option value="name-desc">Name Z-A</option>
                  </select>
                </label>
              </section>

              <div className="project-usage-list projects-view__fields">
                {loading && !fields.length ? (
                  Array.from({ length: 4 }, (_, i) => (
                    <div key={i} className="skel-field-card" style={{ marginBottom: 8 }}>
                      <div className="skel-field-card__title">
                        <div className="skel" style={{ height: 10, width: "28%" }} />
                        <div className="skel" style={{ height: 16, width: "65%" }} />
                        <div className="skel" style={{ height: 11, width: "85%" }} />
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <div className="skel" style={{ flex: 1, height: 48 }} />
                        <div className="skel" style={{ flex: 1, height: 48 }} />
                        <div className="skel" style={{ flex: 1, height: 48 }} />
                      </div>
                      <div />
                    </div>
                  ))
                ) : fields.length ? fields.map((field) => {
                  const href = buildJiraSearchUrl(siteOrigin, field.jql);
                  return (
                    <article className="project-usage-card" key={`${selectedProject.projectId}-${field.fieldId}`}>
                      <div className="project-usage-card__head">
                        <div>
                          <div className="field-card__eyebrow">{field.fieldId}</div>
                          <h4>{field.fieldName}</h4>
                          <p>{field.description || "No admin description is set for this field."}</p>
                        </div>
                        <div className="project-usage-card__head-actions">
                          <MetricChip label="Type" value={field.fieldType} tone="cool" />
                          <MetricChip label="Issues on project" value={formatNumber(field.issueCount)} tone="success" />
                          <MetricChip label="Active projects" value={formatNumber(field.activeProjectCount)} tone="cool" />
                        </div>
                      </div>
                      <div className="project-usage-card__body">
                        <div className="section-heading">
                          <div className="section-heading__actions">
                            <FindingsStrip findings={field.findings} />
                          </div>
                        </div>
                        {href ? (
                          <a className="smart-link-card" href={href} target="_blank" rel="noreferrer" onClick={(e) => handleJiraLinkClick(e, href)}>
                            <span className="smart-link-card__title">Open Jira search for {formatNumber(field.issueCount)} issues</span>
                            <code>{field.jql}</code>
                          </a>
                        ) : (
                          <div className="empty-state empty-state--inline">No JQL link is available for this field/project pair.</div>
                        )}
                      </div>
                    </article>
                  );
                }) : (
                  <div className="empty-state empty-state--inline">
                    No fields matched the current project filters.
                  </div>
                )}
              </div>

              <section className="pagination-bar">
                <span className="pagination-bar__status">
                  {totalFields
                    ? `Showing ${(page - 1) * (data?.pageSize || 24) + 1}-${Math.min(page * (data?.pageSize || 24), totalFields)} of ${totalFields} fields on ${selectedProject.projectKey}`
                    : `No field usage rows are cached for ${selectedProject.projectKey}`}
                </span>
                <div className="pagination-bar__actions">
                  <button className="secondary-button" type="button" onClick={() => onChangePage(1)} disabled={page === 1 || !totalFields}>
                    First
                  </button>
                  <button className="secondary-button" type="button" onClick={() => onChangePage(Math.max(1, page - 1))} disabled={page === 1 || !totalFields}>
                    Previous
                  </button>
                  <button className="secondary-button" type="button" onClick={() => onChangePage(Math.min(totalPages, page + 1))} disabled={page === totalPages || !totalFields}>
                    Next
                  </button>
                  <button className="secondary-button" type="button" onClick={() => onChangePage(totalPages)} disabled={page === totalPages || !totalFields}>
                    Last
                  </button>
                </div>
              </section>
            </>
          ) : (
            <div className="empty-state">No cached projects are available yet. Build project usage for at least one field first.</div>
          )}
        </div>
      </div>
    </section>
  );
}

const INLINE_OPTIONS_COLLAPSE_THRESHOLD = 10;

function InlineOptionsContext({ ctx }) {
  const activeOptions = ctx.options.filter((o) => !o.disabled);
  const disabledOptions = ctx.options.filter((o) => o.disabled);
  const total = ctx.options.length;
  const [expanded, setExpanded] = React.useState(total <= INLINE_OPTIONS_COLLAPSE_THRESHOLD);

  const visibleActive = expanded ? activeOptions : activeOptions.slice(0, INLINE_OPTIONS_COLLAPSE_THRESHOLD);
  const hiddenCount = total - INLINE_OPTIONS_COLLAPSE_THRESHOLD;

  if (ctx.fetchError) {
    return (
      <div className="inline-options">
        <div className="inline-options__header">
          <span className="inline-options__ctx-name">{ctx.contextName}{ctx.isGlobalContext ? " (global)" : ""}</span>
          <span className="field-options-modal__option-chip">{total} option{total !== 1 ? "s" : ""}</span>
        </div>
        <div className="empty-state empty-state--inline" style={{ color: "var(--danger, #c0392b)", padding: "6px 0" }}>
          Failed to load: {ctx.fetchError}
        </div>
      </div>
    );
  }

  return (
    <div className="inline-options">
      <div className="inline-options__header">
        <span className="inline-options__ctx-name">{ctx.contextName}{ctx.isGlobalContext ? " (global)" : ""}</span>
        <span className="field-options-modal__option-chip">{total} option{total !== 1 ? "s" : ""}</span>
      </div>
      <div className="inline-options__chips">
        {visibleActive.map((opt) => (
          <span key={opt.id} className="inline-options__chip">{opt.value}</span>
        ))}
        {expanded && disabledOptions.map((opt) => (
          <span key={opt.id} className="inline-options__chip inline-options__chip--disabled">{opt.value}</span>
        ))}
        {!expanded && hiddenCount > 0 && (
          <button
            type="button"
            className="inline-options__more"
            onClick={() => setExpanded(true)}
          >
            +{hiddenCount} more
          </button>
        )}
        {expanded && total > INLINE_OPTIONS_COLLAPSE_THRESHOLD && (
          <button
            type="button"
            className="inline-options__more"
            onClick={() => setExpanded(false)}
          >
            Show less
          </button>
        )}
      </div>
    </div>
  );
}

function FieldCard({
  field,
  details,
  expanded,
  loading,
  selected,
  onSelectChange,
  onToggle,
  onProjectUsagePageChange,
  onRestartProjectUsage,
  restartingProjectUsageFieldId,
  onRefreshProjectUsage,
  onAskField,
  onAskProject,
  siteOrigin,
  rovoEnabled,
}) {
  const displayField = React.useMemo(() => mergeFieldMetrics(field, details), [field, details]);
  const configuredProjectsValue = details ? details.configuredProjectCount : (field.configuredProjectCount ?? field.usageCount ?? 0);
  const fieldIsSelectType = isSelectType(field.type);
  const [fieldOptions, setFieldOptions] = React.useState(null);
  const [fieldOptionsLoading, setFieldOptionsLoading] = React.useState(false);
  const [contextOptionsOpen, setContextOptionsOpen] = React.useState(false);
  React.useEffect(() => {
    if (!expanded || !fieldIsSelectType || fieldOptions) return;
    let cancelled = false;
    setFieldOptionsLoading(true);
    invoke("getFieldOptions", { fieldId: field.id, projectKeys: [] })
      .then((result) => { if (!cancelled) { setFieldOptions(result); setFieldOptionsLoading(false); } })
      .catch(() => { if (!cancelled) { setFieldOptionsLoading(false); } });
    return () => { cancelled = true; };
  }, [expanded, field.id, fieldIsSelectType]);
  const usageSource = details?.field || details || displayField;
  const usageAvailable = isUsageAvailable(usageSource);
  const totalIssuesValue = usageAvailable ? (details ? details.totalIssueCount : (field.totalIssueCount ?? 0)) : "Unavailable";
  const activeProjectsValue = usageAvailable ? (details ? details.activeProjectCount : (field.activeProjectCount ?? 0)) : "Unavailable";
  const fieldFindings = details?.findings || details?.field?.findings || field.findings;

  const hasDanger = fieldFindings?.tags?.adminAttention || fieldFindings?.tags?.risky;
  const hasWarn = !hasDanger && (fieldFindings?.tags?.cleanup || fieldFindings?.tags?.standardize);
  const severityClass = hasDanger ? "field-card--has-danger" : hasWarn ? "field-card--has-warn" : "";

  return (
    <article className={`field-card ${expanded ? "field-card--open" : ""} ${severityClass}`}>
      <button className={`field-card__header${loading ? " field-card__header--loading" : ""}`} onClick={onToggle} type="button">
        <div className="field-card__title-wrap">
          <label className="field-card__checkbox-label" title="Select for report" onClick={(event) => event.stopPropagation()}>
            <input
              type="checkbox"
              checked={selected}
              onChange={(event) => onSelectChange(field.id, event.target.checked)}
            />
            Select for report
          </label>
          <div className="field-card__field-id">
            {field.id}
            {field.isSystemField && <span className="field-badge field-badge--system">System</span>}
            {!field.isSystemField && field.isJiraBuiltin && <span className="field-badge field-badge--builtin">Jira built-in</span>}
          </div>
          <h3>{field.name}</h3>
          <p>{field.description || "No admin description is set for this field."}</p>
          <ProjectUsageBuildBadge field={displayField} />
          <FindingsStrip findings={fieldFindings} />
        </div>
        <div className="field-card__meta">
          <MetricChip label="Type" value={field.type} tone="cool" />
          <MetricChip label="Configured projects" value={configuredProjectsValue} tone="warm" />
          <MetricChip label="Active projects" value={activeProjectsValue} tone="success" />
          <MetricChip label="Issues with value" value={totalIssuesValue} />
        </div>
        <span className="field-card__toggle-icon" aria-hidden="true" />
      </button>

      {expanded ? (
        <div className="field-card__body">
          {loading ? (
            <div className="empty-state empty-state--inline">Loading field contexts and project usage...</div>
          ) : details ? (
            <>
              <section className="detail-section">
                <div className="section-heading">
                  <h4>Governance Findings</h4>
                  <div className="section-heading__actions">
                    <FindingsStrip findings={fieldFindings} />
                    <button
                      className="secondary-button secondary-button--small"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRefreshProjectUsage(field.id, details.projectUsagePage || 1);
                      }}
                    >
                      Refresh usage
                    </button>
                    <button
                      className="secondary-button secondary-button--small"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRestartProjectUsage(field.id);
                      }}
                      disabled={restartingProjectUsageFieldId === field.id}
                    >
                      {restartingProjectUsageFieldId === field.id ? "Restarting..." : "Rebuild project usage"}
                    </button>
                    <button
                      className="secondary-button secondary-button--small"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onAskField();
                      }}
                      disabled={!rovoEnabled}
                    >
                      Ask Rovo
                    </button>
                  </div>
                </div>
                {fieldFindings?.reasons?.length ? (
                  <div className="findings-list">
                    {fieldFindings.reasons.map((reason, index) => (
                      <div className="finding-card" key={`${field.id}-finding-${index}`}>
                        <div className="finding-card__top">
                          <strong>{reason.title}</strong>
                          <FindingBadge
                            label={reason.severity === "high" ? "High" : "Medium"}
                            tone={reason.severity === "high" ? "danger" : reason.category === "cleanup" ? "warn" : "info"}
                          />
                        </div>
                        <p>{reason.detail}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state empty-state--inline">
                    No immediate governance issues were flagged for this field by the current heuristics.
                  </div>
                )}
              </section>

              <section className="detail-section">
                <div className="section-heading">
                  <h4>Field-Wide Query</h4>
                  <div className="section-heading__actions">
                    <span>Total populated issues: {usageAvailable ? details.totalIssueCount : "Unavailable"}</span>
                    <button
                      className="secondary-button secondary-button--small"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onAskField();
                      }}
                      disabled={!rovoEnabled}
                    >
                      Ask Rovo
                    </button>
                  </div>
                </div>
                <div className="field-query-grid">
                  <a
                    className="smart-link-card"
                    href={buildJiraSearchUrl(siteOrigin, details.fieldJql || details.field?.fieldJql) || "#"}
                    target="_blank"
                    rel="noreferrer"
                    title="Open this field-wide JQL in Jira issue search"
                    onClick={(e) => handleJiraLinkClick(e, buildJiraSearchUrl(siteOrigin, details.fieldJql || details.field?.fieldJql))}
                  >
                    <span className="smart-link-card__title">Open field-wide JQL in Jira</span>
                    <code>{details.fieldJql || details.field?.fieldJql}</code>
                  </a>
                </div>
                {!usageAvailable ? (
                  <div className="empty-state empty-state--inline">
                    {usageSource?.usageStatusDetail || "Jira did not return per-project usage for this field in the app context."}
                  </div>
                ) : null}
              </section>

              <section className="detail-section">
                <div className="section-heading">
                  <h4>Contexts</h4>
                  <span>Refreshed {formatTimestamp(details.refreshedAt)}</span>
                </div>
                <div className="context-grid">
                  {details.contexts.length ? (
                    details.contexts.map((context) => (
                      <div
                        className={`context-card${fieldIsSelectType ? " context-card--clickable" : ""}`}
                        key={context.id}
                        onClick={fieldIsSelectType ? (e) => { e.stopPropagation(); setContextOptionsOpen(true); } : undefined}
                        role={fieldIsSelectType ? "button" : undefined}
                        tabIndex={fieldIsSelectType ? 0 : undefined}
                        onKeyDown={fieldIsSelectType ? (e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setContextOptionsOpen(true); } } : undefined}
                      >
                        <div className="context-card__top">
                          <strong>{context.name}</strong>
                          <span>
                            {context.isGlobalContext
                              ? "Global"
                              : `${context.projects.length} project${context.projects.length === 1 ? "" : "s"}`}
                          </span>
                        </div>
                        <p>{context.description || "No context description."}</p>
                        <div className="tag-row">
                          <span className="tag">{context.isAnyIssueType ? "All issue types" : `${context.issueTypeCount} issue types`}</span>
                          <span className="tag">{context.isGlobalContext ? "Global context" : "Scoped context"}</span>
                          {fieldIsSelectType ? <span className="tag tag--action">View options</span> : null}
                        </div>
                        {!context.isGlobalContext && context.projects.length ? (
                          <div className="project-pill-row">
                            {context.projects.map((project) => (
                              <span className="project-pill" key={`${context.id}-${project.id}`}>
                                {project.key}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <div className="empty-state empty-state--inline">No contexts were returned for this field.</div>
                  )}
                  {contextOptionsOpen ? (
                    <FieldOptionsModal
                      fieldId={field.id}
                      fieldName={field.name || field.fieldName}
                      fieldType={field.type || field.fieldType}
                      projectKeys={[]}
                      onClose={() => setContextOptionsOpen(false)}
                    />
                  ) : null}
                </div>
              </section>

              {fieldIsSelectType ? (
                <section className="detail-section">
                  <div className="section-heading">
                    <h4>Options</h4>
                  </div>
                  {fieldOptionsLoading ? (
                    <div className="empty-state empty-state--inline">Loading options…</div>
                  ) : fieldOptions?.optionsByContext?.length ? (
                    fieldOptions.optionsByContext.map((ctx) => (
                      <InlineOptionsContext key={ctx.contextId} ctx={ctx} />
                    ))
                  ) : fieldOptions ? (
                    <div className="empty-state empty-state--inline">No options found for this field.</div>
                  ) : null}
                </section>
              ) : null}

              <section className="detail-section">
                <div className="section-heading">
                  <h4>Project Usage</h4>
                  <div className="section-heading__actions">
                    <span>
                      {`${details.activeProjectCount} active project${details.activeProjectCount === 1 ? "" : "s"} · Page ${details.projectUsagePage}/${details.projectUsageTotalPages}`}
                    </span>
                    <button
                      className="secondary-button secondary-button--small"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onAskField();
                      }}
                      disabled={!rovoEnabled}
                    >
                      Ask Rovo
                    </button>
                  </div>
                </div>

                {details.projects.length ? (
                  <>
                    <div className="project-usage-list">
                      {details.projects.map((project) => (
                        <div className="project-usage-card" key={project.projectId}>
                          <div className="project-usage-card__head">
                            <div>
                              <strong>
                                {project.projectKey} <span>{project.projectName}</span>
                              </strong>
                            </div>
                            <div className="project-usage-card__head-actions">
                              <MetricChip label="Issues with value" value={project.issueCount} tone="success" />
                              <button
                                className="secondary-button secondary-button--small"
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onAskProject(project);
                                }}
                                disabled={!rovoEnabled}
                              >
                                Ask Rovo
                              </button>
                            </div>
                          </div>
                          <div className="project-usage-card__body">
                            <label>JQL</label>
                            <a
                              className="smart-link-card"
                              href={buildJiraSearchUrl(siteOrigin, project.jql) || "#"}
                              target="_blank"
                              rel="noreferrer"
                              title="Open this JQL in Jira issue search"
                              onClick={(e) => handleJiraLinkClick(e, buildJiraSearchUrl(siteOrigin, project.jql))}
                            >
                              <span className="smart-link-card__title">Open JQL in Jira</span>
                              <code>{project.jql}</code>
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="project-usage-pagination">
                      <span className="pagination-bar__status">
                        Showing {((details.projectUsagePage - 1) * details.projectUsagePageSize) + 1}
                        -
                        {Math.min(details.projectUsagePage * details.projectUsagePageSize, details.projectUsageTotalProjects)}
                        {" "}of {details.projectUsageTotalProjects} active projects
                      </span>
                      <div className="pagination-bar__actions">
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => onProjectUsagePageChange(field.id, 1)}
                          disabled={details.projectUsagePage === 1}
                        >
                          First
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => onProjectUsagePageChange(field.id, Math.max(1, details.projectUsagePage - 1))}
                          disabled={details.projectUsagePage === 1}
                        >
                          Previous
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => onProjectUsagePageChange(field.id, Math.min(details.projectUsageTotalPages, details.projectUsagePage + 1))}
                          disabled={details.projectUsagePage === details.projectUsageTotalPages}
                        >
                          Next
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => onProjectUsagePageChange(field.id, details.projectUsageTotalPages)}
                          disabled={details.projectUsagePage === details.projectUsageTotalPages}
                        >
                          Last
                        </button>
                      </div>
                    </div>
                  </>
                ) : details.summaryStatus === "queued" || details.summaryStatus === "building" ? (
                  <div className="empty-state empty-state--inline">
                    <div>
                      <div>Project usage enrichment is running in the background for this field.</div>
                      <div style={{ marginTop: 8 }}>
                        {details.estimatedIssueTotal > 0
                          ? `Scanned ${details.processedIssueCount} of ${details.estimatedIssueTotal} matching issues.`
                          : "Waiting for the issue scan to start."}
                      </div>
                      {details.estimatedIssueTotal > 0 ? (
                        <div className="status-progress" style={{ marginTop: 10 }}>
                          <div className="status-progress__meta">
                            <strong>{Math.min(100, Math.round((details.processedIssueCount / details.estimatedIssueTotal) * 100))}%</strong>
                            <span>{details.processedIssueCount} of {details.estimatedIssueTotal} issues scanned</span>
                          </div>
                          <div className="status-progress__bar" aria-hidden="true">
                            <span style={{ width: `${Math.min(100, Math.round((details.processedIssueCount / details.estimatedIssueTotal) * 100))}%` }} />
                          </div>
                        </div>
                      ) : null}
                      {details.lastError ? <div className="build-card__error" style={{ marginTop: 10 }}>{details.lastError}</div> : null}
                    </div>
                  </div>
                ) : (
                  <div className="empty-state empty-state--inline">
                    No projects with populated values were found on this page of active projects.
                  </div>
                )}
              </section>
            </>
          ) : (
            <div className="empty-state empty-state--inline">No field details are available.</div>
          )}
        </div>
      ) : null}
    </article>
  );
}

const DEMO_FIELDS = [
  {
    id: "customfield_10016",
    name: "Story Points",
    type: "com.atlassian.jira.plugin.system.customfieldtypes:float",
    description: "Effort estimate in Fibonacci points, used for sprint planning and velocity tracking.",
    configuredProjectCount: 24,
    activeProjectCount: 21,
    issuesWithValue: 14820,
    governanceFindings: [],
    adminAttention: false,
    priorityScore: 12,
    summaryStatus: "ready",
  },
  {
    id: "customfield_10020",
    name: "Sprint",
    type: "com.pyxis.greenhopper.jira:gh-sprint",
    description: "",
    configuredProjectCount: 18,
    activeProjectCount: 17,
    issuesWithValue: 9340,
    governanceFindings: [
      { category: "standardize", severity: "medium", title: "Missing description", detail: "Field is actively used across 17 projects but has no description to guide editors." },
      { category: "risk", severity: "high", title: "High-impact field with broad live usage", detail: "17 active projects and 9,340 populated issues. Changes carry significant migration risk." },
    ],
    adminAttention: true,
    priorityScore: 78,
    summaryStatus: "ready",
  },
  {
    id: "customfield_10110",
    name: "Customer Tier",
    type: "com.atlassian.jira.plugin.system.customfieldtypes:select",
    description: "Customer account tier: Enterprise, Business, or Starter. Drives SLA routing and escalation rules.",
    configuredProjectCount: 6,
    activeProjectCount: 5,
    issuesWithValue: 2104,
    governanceFindings: [],
    adminAttention: false,
    priorityScore: 8,
    summaryStatus: "ready",
  },
  {
    id: "customfield_10280",
    name: "Legacy Migration Status",
    type: "com.atlassian.jira.plugin.system.customfieldtypes:select",
    description: "Tracks migration progress for issues originating from the legacy project tracker.",
    configuredProjectCount: 11,
    activeProjectCount: 2,
    issuesWithValue: 87,
    governanceFindings: [
      { category: "cleanup", severity: "medium", title: "Broadly scoped field with very light usage", detail: "11 configured projects but only 87 populated issues across 2 active projects." },
    ],
    adminAttention: false,
    priorityScore: 32,
    summaryStatus: "ready",
  },
];

function DemoFieldCard({ field }) {
  const hasDanger = field.governanceFindings.some((f) => f.severity === "high");
  const hasWarn = !hasDanger && field.governanceFindings.some((f) => f.severity === "medium");
  const severityClass = hasDanger ? "field-card--has-danger" : hasWarn ? "field-card--has-warn" : "";

  return (
    <article className={`field-card ${severityClass}`} aria-label={field.name}>
      <div className="field-card__header">
        <div className="field-card__meta">
          <span className="field-card__field-id">{field.id}</span>
          <h3>{field.name}</h3>
          {field.description && <p className="field-card__description">{field.description}</p>}
        </div>
        <div className="field-card__metrics">
          <MetricChip label="Configured" value={field.configuredProjectCount} />
          <MetricChip label="Active" value={field.activeProjectCount} />
          <MetricChip label="Issues with value" value={field.issuesWithValue.toLocaleString()} />
        </div>
        <div className="field-card__findings">
          {field.governanceFindings.length > 0 ? (
            field.governanceFindings.map((finding, i) => (
              <FindingBadge key={i} finding={finding} />
            ))
          ) : (
            <span className="field-card__no-findings">No findings</span>
          )}
        </div>
      </div>
    </article>
  );
}

function GSTStep({ index, label, done, active, icon }) {
  const cls = done ? "gst-step gst-step--done" : active ? "gst-step gst-step--active" : "gst-step";
  return (
    <div className={cls}>
      <div className="gst-step__badge">
        {done ? <Icon name="check" size={13} /> : <Icon name={icon} size={13} />}
      </div>
      <span className="gst-step__label">{label}</span>
    </div>
  );
}

function GettingStartedTracker({ refreshedAt, findingsSummary, projectUsageJobs, onDismiss }) {
  const step1Done = Boolean(refreshedAt);
  const step2Done = step1Done && (
    (findingsSummary.adminAttention || 0) +
    (findingsSummary.risky || 0) +
    (findingsSummary.cleanup || 0) +
    (findingsSummary.standardize || 0)
  ) > 0;
  const step3Done = projectUsageJobs.some((j) => j.state === "ready" || j.summaryStatus === "ready");

  const allDone = step1Done && step2Done && step3Done;

  return (
    <div className={`getting-started-tracker ${allDone ? "getting-started-tracker--complete" : ""}`}>
      <div className="gst-header">
        <span className="gst-title">
          <Icon name="zap" size={14} />
          Getting started
        </span>
        {allDone && <span className="gst-complete-badge">All set!</span>}
        <button className="gst-dismiss" type="button" onClick={onDismiss} title="Dismiss">
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="gst-steps">
        <GSTStep index={1} label="Build snapshot" done={step1Done} active={!step1Done} icon="layers" />
        <div className="gst-connector" />
        <GSTStep index={2} label="Review findings" done={step2Done} active={step1Done && !step2Done} icon="alertTriangle" />
        <div className="gst-connector" />
        <GSTStep index={3} label="Map project usage" done={step3Done} active={step2Done && !step3Done} icon="activity" />
      </div>
    </div>
  );
}

function OnboardingPanel({ onStart, loading }) {
  const steps = [
    {
      icon: "layers",
      title: "Index every field",
      desc: "Observatory snapshots the complete Jira custom field catalog — IDs, types, contexts, configured scopes — in a single job.",
      active: true,
    },
    {
      icon: "activity",
      title: "Measure real usage",
      desc: "Deep-scan each field to count exactly how many issues carry a value, per project — no JQL guesswork.",
      active: false,
    },
    {
      icon: "folder",
      title: "Map project exposure",
      desc: "Join field data to every project for a live risk surface: which fields touch which teams, and how much.",
      active: false,
    },
  ];

  return (
    <div className="onboarding-panel">
      <div className="onboarding-hero">
        <p className="onboarding-hero__eyebrow">Jira Custom Field Governance</p>
        <h2 className="onboarding-hero__title">Know every field.<br />Own every decision.</h2>
        <p className="onboarding-hero__sub">
          Observatory gives your team a live, searchable inventory of every custom field on your Jira site
          — with automated governance findings, per-project usage maps, multi-field reports, and an AI assistant
          — all inside this Confluence page.
        </p>
      </div>

      <div className="onboarding-steps">
        {steps.map((step, i) => (
          <React.Fragment key={i}>
            {i > 0 && <div className="onboarding-steps__connector" />}
            <div className={`onboarding-step ${step.active ? "onboarding-step--active" : ""}`}>
              <div className="onboarding-step__icon">
                <Icon name={step.icon} size={20} />
              </div>
              <div className="onboarding-step__title">{step.title}</div>
              <div className="onboarding-step__desc">{step.desc}</div>
            </div>
          </React.Fragment>
        ))}
      </div>

      <div className="onboarding-preview">
        <p className="onboarding-preview__label">What your field inventory looks like</p>
        <div className="onboarding-preview__list demo-field-card" style={{ pointerEvents: "none", userSelect: "none" }}>
          {DEMO_FIELDS.map((field) => (
            <DemoFieldCard key={field.id} field={field} />
          ))}
        </div>
        <div className="onboarding-preview__fade" />
      </div>

      <div className="onboarding-cta">
        <button
          className="onboarding-cta__btn"
          type="button"
          onClick={onStart}
          disabled={loading}
        >
          <Icon name="zap" size={18} />
          {loading ? "Starting snapshot…" : "Build your first snapshot"}
        </button>
        <p className="onboarding-cta__note">
          The first snapshot typically takes 1–3 minutes depending on your field count.
          You can watch live progress in the Snapshot Log tab.
        </p>
      </div>
    </div>
  );
}

function App() {
  const [inventoryFields, setInventoryFields] = React.useState([]);
  const [availableTypes, setAvailableTypes] = React.useState([]);
  const [query, setQuery] = React.useState("");
  const [debouncedQuery, setDebouncedQuery] = React.useState("");
  const [optionQuery, setOptionQuery] = React.useState("");
  const [debouncedOptionQuery, setDebouncedOptionQuery] = React.useState("");
  const [optionSearchFieldIds, setOptionSearchFieldIds] = React.useState(null);
  const [optionSearchStatus, setOptionSearchStatus] = React.useState(null);
  const [typeFilter, setTypeFilter] = React.useState("all");
  const [fieldOrigin, setFieldOrigin] = React.useState("all");
  const [findingsFilter, setFindingsFilter] = React.useState("all");
  const [projectUsageFilter, setProjectUsageFilter] = React.useState("all");
  const [minIssuesWithValue, setMinIssuesWithValue] = React.useState("");
  const [maxIssuesWithValue, setMaxIssuesWithValue] = React.useState("");
  const [pageSize, setPageSize] = React.useState(() => {
    const saved = Number(localStorage.getItem("atlasiq-field-pagesize"));
    return [10, 25, 50].includes(saved) ? saved : 10;
  });
  const [sortBy, setSortBy] = React.useState("name-asc");
  const [theme, setTheme] = React.useState(() => localStorage.getItem("atlasiq-field-theme") || "dark");
  const [zoomLevel, setZoomLevel] = React.useState(() => {
    const raw = Number(localStorage.getItem("atlasiq-field-zoom") || 100);
    return Number.isFinite(raw) ? Math.max(80, Math.min(130, raw)) : 100;
  });
  const [currentPage, setCurrentPage] = React.useState(1);
  const [totalPages, setTotalPages] = React.useState(1);
  const [totalFields, setTotalFields] = React.useState(0);
  const [expandedFieldId, setExpandedFieldId] = React.useState(null);
  const [detailsByFieldId, setDetailsByFieldId] = React.useState({});
  const [loadingInventory, setLoadingInventory] = React.useState(true);
  const [loadingDetailFieldId, setLoadingDetailFieldId] = React.useState(null);
  const [error, setError] = React.useState("");
  const [refreshedAt, setRefreshedAt] = React.useState(null);
  const [snapshotStatus, setSnapshotStatus] = React.useState(null);
  const [readOnlyMode, setReadOnlyMode] = React.useState(false);
  const [buildProgress, setBuildProgress] = React.useState(null);
  const [projectUsageJobs, setProjectUsageJobs] = React.useState([]);
  const [refreshingJobs, setRefreshingJobs] = React.useState(false);
  const [jobsRefreshedAt, setJobsRefreshedAt] = React.useState(null);
  const [refreshingRecentUsage, setRefreshingRecentUsage] = React.useState(false);
  const [expandedJobFieldId, setExpandedJobFieldId] = React.useState("");
  const [siteOrigin, setSiteOrigin] = React.useState("");
  const [rovoEnabled, setRovoEnabled] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState("inventory");
  const [cancellingBuild, setCancellingBuild] = React.useState(false);
  const [cancellingJobFieldId, setCancellingJobFieldId] = React.useState("");
  const [resumingJobFieldId, setResumingJobFieldId] = React.useState("");
  const [refreshingUsageJobFieldId, setRefreshingUsageJobFieldId] = React.useState("");
  const [restartingProjectUsageFieldId, setRestartingProjectUsageFieldId] = React.useState("");
  const [selectedFieldIds, setSelectedFieldIds] = React.useState([]);
  const [reportData, setReportData] = React.useState(null);
  const [loadingReport, setLoadingReport] = React.useState(false);
  const [reportJobId, setReportJobId] = React.useState("");
  const [reportJob, setReportJob] = React.useState(null);
  const [savedReports, setSavedReports] = React.useState([]);
  const [reportNameInput, setReportNameInput] = React.useState("");
  const [activeReportName, setActiveReportName] = React.useState("");
  const [trackerDismissed, setTrackerDismissed] = React.useState(
    () => localStorage.getItem("atlasiq-onboarding-tracker-dismissed") === "1"
  );
  const [savingReport, setSavingReport] = React.useState(false);
  const [deletingReportId, setDeletingReportId] = React.useState("");
  const [projectsViewData, setProjectsViewData] = React.useState(null);
  const [loadingProjectsView, setLoadingProjectsView] = React.useState(false);
  const [selectedProjectId, setSelectedProjectId] = React.useState("");
  const [projectTabProjectQuery, setProjectTabProjectQuery] = React.useState("");
  const [projectTabFieldQuery, setProjectTabFieldQuery] = React.useState("");
  const [projectTabFieldType, setProjectTabFieldType] = React.useState("all");
  const [projectTabFieldSort, setProjectTabFieldSort] = React.useState("issues-desc");
  const [projectTabPage, setProjectTabPage] = React.useState(1);
  const [issueScanLoading, setIssueScanLoading] = React.useState(false);
  const [issueScanResuming, setIssueScanResuming] = React.useState(false);
  const [issueScanCancelling, setIssueScanCancelling] = React.useState(false);
  const [issueScanStatus, setIssueScanStatus] = React.useState(null);
  const [deltaIssueScanStatus, setDeltaIssueScanStatus] = React.useState(null);
  const [accessCheck, setAccessCheck] = React.useState(null);
  const [issueScanDeltaStarting, setIssueScanDeltaStarting] = React.useState(false);
  const [projectUsageRestoring, setProjectUsageRestoring] = React.useState(false);
  const [collapsedActivitySections, setCollapsedActivitySections] = React.useState(() => {
    try {
      const raw = localStorage.getItem("atlasiq-activity-sections");
      return raw ? JSON.parse(raw) : { snapshot: false, universeScan: false, projectUsage: false };
    } catch {
      return { snapshot: false, universeScan: false, projectUsage: false };
    }
  });
  const [findingsSummary, setFindingsSummary] = React.useState({
    adminAttention: 0,
    risky: 0,
    cleanup: 0,
    standardize: 0,
  });
  const detailsRef = React.useRef(detailsByFieldId);
  const hasActiveProjectUsageJobs = projectUsageJobs.some((job) => job.summaryStatus === "queued" || job.summaryStatus === "building");
  const latestInventoryRequestRef = React.useRef(0);

  React.useEffect(() => {
    detailsRef.current = detailsByFieldId;
  }, [detailsByFieldId]);

  React.useEffect(() => {
    try { view.setAutoResizing(true); } catch {}
  }, []);

  React.useEffect(() => {
    invoke("checkMacroAccess")
      .then((result) => setAccessCheck(result || { allowed: true }))
      .catch(() => setAccessCheck({ allowed: true }));
  }, []);

  React.useEffect(() => {
    fetchSavedReports();
  }, []);

  React.useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(query), 250);
    return () => window.clearTimeout(handle);
  }, [query]);

  React.useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedOptionQuery(optionQuery), 350);
    return () => window.clearTimeout(handle);
  }, [optionQuery]);

  React.useEffect(() => {
    let cancelled = false;

    async function loadSiteOrigin() {
      try {
        const context = await view.getContext();
        const resolvedOrigin = normalizeSiteOrigin(
          context?.siteUrl ||
          context?.extension?.siteUrl ||
          context?.extensionContext?.siteUrl
        );

        if (!cancelled && resolvedOrigin) {
          setSiteOrigin(resolvedOrigin);
        }
      } catch {
        // Leave link targets disabled if the site URL cannot be resolved.
      }
    }

    loadSiteOrigin();

    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    const q = debouncedOptionQuery.trim();
    setOptionSearchFieldIds(null);
    setOptionSearchStatus(q ? { state: "done", query: q } : null);
  }, [debouncedOptionQuery]);

  React.useEffect(() => {
    let cancelled = false;

    async function checkRovo() {
      try {
        const enabled = await rovo.isEnabled();
        if (!cancelled) {
          setRovoEnabled(Boolean(enabled));
        }
      } catch {
        if (!cancelled) {
          setRovoEnabled(false);
        }
      }
    }

    checkRovo();

    return () => {
      cancelled = true;
    };
  }, []);

  const hasActiveFilters =
    debouncedQuery !== "" ||
    debouncedOptionQuery !== "" ||
    typeFilter !== "all" ||
    fieldOrigin !== "all" ||
    findingsFilter !== "all" ||
    projectUsageFilter !== "all" ||
    String(minIssuesWithValue).trim() !== "" ||
    String(maxIssuesWithValue).trim() !== "";

  function clearFilters() {
    setQuery("");
    setDebouncedQuery("");
    setOptionQuery("");
    setDebouncedOptionQuery("");
    setTypeFilter("all");
    setFieldOrigin("all");
    setFindingsFilter("all");
    setProjectUsageFilter("all");
    setMinIssuesWithValue("");
    setMaxIssuesWithValue("");
    setCurrentPage(1);
  }

  const fetchInventory = React.useCallback(async ({ forceRefresh = false, page = 1, silent = false } = {}) => {
    const requestId = latestInventoryRequestRef.current + 1;
    latestInventoryRequestRef.current = requestId;

    if (!silent) setLoadingInventory(true);
    setError("");

    try {
      const result = await invoke("getFieldInventory", {
        forceRefresh,
        page,
        pageSize,
        query: debouncedQuery,
        optionQuery: debouncedOptionQuery,
        type: typeFilter,
        fieldOrigin,
        findingsFilter,
        projectUsageFilter,
        minIssuesWithValue,
        maxIssuesWithValue,
        sortBy,
      });

      if (latestInventoryRequestRef.current !== requestId) {
        return;
      }

      setInventoryFields((current) => {
        const currentMap = new Map(current.map((field) => [field.id, field]));
        return (result.fields || []).map((field) => {
          const mergedWithCurrent = mergeFieldMetrics(field, currentMap.get(field.id));
          return mergeFieldMetrics(mergedWithCurrent, detailsRef.current[field.id]);
        });
      });
      setAvailableTypes(result.availableTypes || []);
      setRefreshedAt(result.refreshedAt || null);
      setSnapshotStatus(result.snapshotStatus || null);
      setReadOnlyMode(Boolean(result.readOnlyMode));
      setBuildProgress(result.buildProgress || null);
      setFindingsSummary(result.findingsSummary || {
        adminAttention: 0,
        risky: 0,
        cleanup: 0,
        standardize: 0,
      });
      setTotalFields(result.total || 0);
      setTotalPages(result.totalPages || 1);
      setCurrentPage(result.page || page);
      if (forceRefresh) {
        setExpandedFieldId(null);
        setDetailsByFieldId({});
      }
    } catch (err) {
      if (latestInventoryRequestRef.current !== requestId) {
        return;
      }
      setError(err.message || "Failed to load custom fields.");
    } finally {
      if (!silent && latestInventoryRequestRef.current === requestId) {
        setLoadingInventory(false);
      }
    }
  }, [debouncedQuery, debouncedOptionQuery, fieldOrigin, findingsFilter, projectUsageFilter, minIssuesWithValue, maxIssuesWithValue, sortBy, typeFilter, pageSize]);

  const fetchProjectUsageJobs = React.useCallback(async () => {
    setRefreshingJobs(true);
    try {
      const result = await invoke("getProjectUsageJobs");
      setProjectUsageJobs(result.jobs || []);
      setJobsRefreshedAt(new Date().toISOString());
    } catch (err) {
      setError(err.message || "Failed to load project usage jobs.");
    } finally {
      setRefreshingJobs(false);
    }
  }, []);

  const fetchIssueScanStatus = React.useCallback(async () => {
    try {
      const result = await invoke("getIssueScanStatus");
      setIssueScanStatus(result?.meta || null);
    } catch (err) {
      setError(err.message || "Failed to load universe scan status.");
    }
  }, []);

  const fetchDeltaIssueScanStatus = React.useCallback(async () => {
    try {
      const result = await invoke("getDeltaIssueScanStatus");
      setDeltaIssueScanStatus(result?.meta || null);
    } catch { /* non-critical */ }
  }, []);

  const startDeltaIssueScanAction = React.useCallback(async () => {
    setIssueScanDeltaStarting(true);
    try {
      await invoke("startDeltaIssueScan");
      await fetchDeltaIssueScanStatus();
    } catch (err) {
      setError(err.message || "Failed to start quick scan.");
    } finally {
      setIssueScanDeltaStarting(false);
    }
  }, [fetchDeltaIssueScanStatus]);

  async function refreshRecentUsageWindow() {
    setRefreshingRecentUsage(true);
    try {
      const result = await invoke("refreshRecentProjectUsage", { hours: 24, maxIssues: 500 });
      await fetchProjectUsageJobs();
      setError(
        result?.queuedCount
          ? `Queued ${formatNumber(result.queuedCount)} field refresh${Number(result.queuedCount) === 1 ? "" : "es"} from the last 24h of issue activity.`
          : `No field refreshes were queued from the last 24h of issue activity.`
      );
    } catch (err) {
      setError(err.message || "Failed to queue the 24h usage refresh.");
    } finally {
      setRefreshingRecentUsage(false);
    }
  }

  async function fetchSavedReports() {
    try {
      const result = await invoke("getSavedReports");
      setSavedReports(result.reports || []);
    } catch (err) {
      setError(err.message || "Failed to load saved reports.");
    }
  }

  const fetchReportJob = React.useCallback(async (jobIdOverride = "") => {
    const targetJobId = String(jobIdOverride || reportJobId || "").trim();
    if (!targetJobId) {
      return;
    }
    try {
      const result = await invoke("getProjectUsageReportJob", { jobId: targetJobId });
      const nextJob = result?.job || null;
      setReportJob(nextJob);
      if (nextJob?.result) {
        setReportData(normalizeReportData(nextJob.result));
      }
    } catch (err) {
      setError(err.message || "Failed to load report job status.");
    }
  }, [reportJobId]);

  const fetchProjectsView = React.useCallback(async () => {
    if (activeTab !== "projects") {
      return;
    }

    setLoadingProjectsView(true);
    try {
      const result = await invoke("getProjectsView", {
        projectId: selectedProjectId,
        projectQuery: projectTabProjectQuery,
        fieldQuery: projectTabFieldQuery,
        fieldType: projectTabFieldType,
        sortBy: projectTabFieldSort,
        page: projectTabPage,
      });
      setProjectsViewData(result);
      if (result?.selectedProject?.projectId && result.selectedProject.projectId !== selectedProjectId) {
        setSelectedProjectId(result.selectedProject.projectId);
      }
    } catch (err) {
      setError(err.message || "Failed to load the projects view.");
    } finally {
      setLoadingProjectsView(false);
    }
  }, [
    activeTab,
    selectedProjectId,
    projectTabProjectQuery,
    projectTabFieldQuery,
    projectTabFieldType,
    projectTabFieldSort,
    projectTabPage,
  ]);

  const startIssueScanAction = React.useCallback(async () => {
    setIssueScanLoading(true);
    try {
      await invoke("startIssueScan");
      await fetchIssueScanStatus();
      await fetchProjectsView();
    } catch (err) {
      setError(err.message || "Failed to start universe scan.");
    } finally {
      setIssueScanLoading(false);
    }
  }, [fetchIssueScanStatus, fetchProjectsView]);

  const resumeIssueScanAction = React.useCallback(async () => {
    setIssueScanResuming(true);
    try {
      const result = await invoke("resumeIssueScan");
      if (result?.resumed === false) {
        const messages = {
          "already-complete": "Universe scan is already complete.",
          "no-scan": "No universe scan exists to resume.",
        };
        setError(messages[result.reason] || "Universe scan could not be resumed.");
      }
      await fetchIssueScanStatus();
      await fetchProjectsView();
    } catch (err) {
      setError(err.message || "Failed to resume universe scan.");
    } finally {
      setIssueScanResuming(false);
    }
  }, [fetchIssueScanStatus, fetchProjectsView]);

  const restoreProjectUsageCacheAction = React.useCallback(async () => {
    setProjectUsageRestoring(true);
    try {
      await invoke("restoreProjectUsageCache");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await fetchProjectsView();
    } catch (err) {
      setError(err.message || "Failed to start project usage restore.");
    } finally {
      setProjectUsageRestoring(false);
    }
  }, [fetchProjectsView]);

  const cancelIssueScanAction = React.useCallback(async () => {
    setIssueScanCancelling(true);
    try {
      await invoke("cancelIssueScan");
      await fetchIssueScanStatus();
      await fetchProjectsView();
    } catch (err) {
      setError(err.message || "Failed to cancel scan.");
    } finally {
      setIssueScanCancelling(false);
    }
  }, [fetchIssueScanStatus, fetchProjectsView]);

  React.useEffect(() => {
    fetchInventory({ page: currentPage });
  }, [fetchInventory, currentPage]);

  React.useEffect(() => {
    fetchProjectUsageJobs();
  }, [fetchProjectUsageJobs]);

  React.useEffect(() => {
    fetchIssueScanStatus();
  }, [fetchIssueScanStatus]);

  React.useEffect(() => {
    fetchDeltaIssueScanStatus();
  }, [fetchDeltaIssueScanStatus]);

  React.useEffect(() => {
    fetchReportJob();
  }, [fetchReportJob]);

  React.useEffect(() => {
    fetchProjectsView();
  }, [fetchProjectsView]);

  React.useEffect(() => {
    if (activeTab !== "activity" || !hasActiveProjectUsageJobs) {
      return undefined;
    }

    const handle = window.setInterval(() => {
      fetchProjectUsageJobs();
    }, 2500);

    return () => window.clearInterval(handle);
  }, [activeTab, hasActiveProjectUsageJobs, fetchProjectUsageJobs]);

  const issueScanState = issueScanStatus?.state;
  React.useEffect(() => {
    if (activeTab !== "activity" || (issueScanState !== "building" && issueScanState !== "queued")) {
      return undefined;
    }

    const handle = window.setInterval(() => {
      fetchIssueScanStatus();
    }, 2500);

    return () => window.clearInterval(handle);
  }, [activeTab, issueScanState, fetchIssueScanStatus]);

  // When a universe scan completes, re-fetch inventory so field usage counts update without a page reload.
  const prevIssueScanStateRef = React.useRef(issueScanState);
  React.useEffect(() => {
    const prev = prevIssueScanStateRef.current;
    prevIssueScanStateRef.current = issueScanState;
    if ((prev === "building" || prev === "queued") && issueScanState === "ready") {
      fetchInventory({ page: currentPage, silent: true });
    }
  }, [issueScanState, fetchInventory, currentPage]);

  const deltaIssueScanState = deltaIssueScanStatus?.state;
  React.useEffect(() => {
    if (activeTab !== "activity" || (deltaIssueScanState !== "building" && deltaIssueScanState !== "queued")) {
      return undefined;
    }

    const handle = window.setInterval(() => {
      fetchDeltaIssueScanStatus();
    }, 2500);

    return () => window.clearInterval(handle);
  }, [activeTab, deltaIssueScanState, fetchDeltaIssueScanStatus]);

  React.useEffect(() => {
    if (activeTab !== "report" || !reportJobId || !reportJob || (reportJob.status !== "queued" && reportJob.status !== "building")) {
      return undefined;
    }

    const handle = window.setInterval(() => {
      fetchReportJob(reportJobId);
    }, 2500);

    return () => window.clearInterval(handle);
  }, [activeTab, reportJobId, reportJob, fetchReportJob]);

  React.useEffect(() => {
    try {
      localStorage.setItem("atlasiq-activity-sections", JSON.stringify(collapsedActivitySections));
    } catch {}
  }, [collapsedActivitySections]);

  const toggleActivitySection = React.useCallback((key) => {
    setCollapsedActivitySections((current) => ({
      ...current,
      [key]: !current[key],
    }));
  }, []);

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("atlasiq-field-theme", theme);
  }, [theme]);

  React.useEffect(() => {
    localStorage.setItem("atlasiq-field-zoom", String(zoomLevel));
  }, [zoomLevel]);

  React.useEffect(() => {
    function handleFindShortcut(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        const input = document.querySelector("[data-search-input='primary']");
        if (!input) return;
        e.preventDefault();
        input.focus();
        input.select();
      }
    }
    window.addEventListener("keydown", handleFindShortcut);
    return () => window.removeEventListener("keydown", handleFindShortcut);
  }, []);

  React.useEffect(() => {
    setCurrentPage(1);
  }, [debouncedQuery, debouncedOptionQuery, fieldOrigin, findingsFilter, projectUsageFilter, minIssuesWithValue, maxIssuesWithValue, typeFilter, sortBy, pageSize]);

  React.useEffect(() => {
    setProjectTabPage(1);
  }, [selectedProjectId, projectTabFieldQuery, projectTabFieldType, projectTabFieldSort]);

  async function loadFieldDetails(fieldId, usagePage = 1, { silent = false } = {}) {
    if (!silent) {
      setLoadingDetailFieldId(fieldId);
    }
    try {
      const details = await invoke("getFieldDetails", {
        fieldId,
        usagePage,
        usagePageSize: PROJECT_USAGE_PAGE_SIZE,
      });
      setDetailsByFieldId((current) => ({ ...current, [fieldId]: details }));
      setInventoryFields((current) =>
        current.map((field) => (field.id === fieldId ? mergeFieldMetrics(field, details) : field))
      );
    } catch (err) {
      setError(err.message || `Failed to load details for ${fieldId}.`);
    } finally {
      if (!silent) {
        setLoadingDetailFieldId(null);
      }
    }
  }

  async function toggleField(fieldId) {
    const nextExpanded = expandedFieldId === fieldId ? null : fieldId;
    setExpandedFieldId(nextExpanded);

    if (!nextExpanded || detailsByFieldId[fieldId]) return;

    await loadFieldDetails(fieldId, 1);
  }

  async function changeProjectUsagePage(fieldId, usagePage) {
    await loadFieldDetails(fieldId, usagePage);
  }

  async function refreshProjectUsage(fieldId, usagePage) {
    await loadFieldDetails(fieldId, usagePage, { silent: true });
    await fetchProjectUsageJobs();
  }

  const summary = React.useMemo(() => {
    return {
      totalFields,
    };
  }, [totalFields]);
  const compactLayout = totalFields > 0 && totalFields < pageSize;
  const visibleInventoryFields = optionSearchFieldIds instanceof Set
    ? inventoryFields.filter((field) => optionSearchFieldIds.has(field.id))
    : inventoryFields;
  const visibleTotalFields = optionSearchFieldIds instanceof Set ? visibleInventoryFields.length : totalFields;
  const visibleTotalPages = optionSearchFieldIds instanceof Set ? 1 : totalPages;

  async function cancelBuild() {
    setCancellingBuild(true);
    try {
      await invoke("cancelSnapshot");
      await fetchInventory({ page: currentPage, silent: true });
    } catch (err) {
      setError(err.message || "Failed to cancel build.");
    } finally {
      setCancellingBuild(false);
    }
  }

  async function cancelProjectUsageJob(fieldId) {
    setCancellingJobFieldId(fieldId);
    try {
      await invoke("cancelProjectUsageJob", { fieldId });
      await fetchProjectUsageJobs();
      if (expandedFieldId === fieldId) {
        await loadFieldDetails(fieldId, detailsByFieldId[fieldId]?.projectUsagePage || 1, { silent: true });
      }
    } catch (err) {
      setError(err.message || "Failed to cancel project usage job.");
    } finally {
      setCancellingJobFieldId("");
    }
  }

  async function restartProjectUsage(fieldId) {
    setRestartingProjectUsageFieldId(fieldId);
    try {
      await invoke("restartProjectUsageJob", { fieldId });
      await fetchProjectUsageJobs();
      await loadFieldDetails(fieldId, detailsByFieldId[fieldId]?.projectUsagePage || 1, { silent: true });
    } catch (err) {
      setError(err.message || "Failed to restart project usage job.");
    } finally {
      setRestartingProjectUsageFieldId("");
    }
  }

  async function resumeProjectUsageJob(fieldId) {
    setResumingJobFieldId(fieldId);
    try {
      await invoke("resumeProjectUsageJob", { fieldId });
      await fetchProjectUsageJobs();
      if (expandedFieldId === fieldId) {
        await loadFieldDetails(fieldId, detailsByFieldId[fieldId]?.projectUsagePage || 1, { silent: true });
      }
    } catch (err) {
      setError(err.message || "Failed to resume project usage job.");
    } finally {
      setResumingJobFieldId("");
    }
  }

  async function refreshUsageJob(fieldId) {
    setRefreshingUsageJobFieldId(fieldId);
    try {
      await loadFieldDetails(fieldId, detailsByFieldId[fieldId]?.projectUsagePage || 1, { silent: true });
      await fetchProjectUsageJobs();
    } catch (err) {
      setError(err.message || "Failed to refresh project usage.");
    } finally {
      setRefreshingUsageJobFieldId("");
    }
  }

  function toggleProjectUsageJob(fieldId) {
    setExpandedJobFieldId((current) => current === fieldId ? "" : fieldId);
  }

  function toggleFieldSelection(fieldId, checked) {
    setSelectedFieldIds((current) => {
      const next = new Set(current);
      if (checked) next.add(fieldId);
      else next.delete(fieldId);
      return Array.from(next);
    });
  }

  function clearSelectedFields() {
    setSelectedFieldIds([]);
    setReportNameInput("");
    setActiveReportName("");
    setReportData(null);
  }

  async function selectAllFilteredFields() {
    if (optionSearchFieldIds instanceof Set) {
      setSelectedFieldIds(visibleInventoryFields.map((field) => field.id));
      return;
    }
    try {
      const result = await invoke("getFilteredFieldIds", {
        query: debouncedQuery,
        optionQuery: debouncedOptionQuery,
        type: typeFilter,
        fieldOrigin,
        findingsFilter,
        projectUsageFilter,
        minIssuesWithValue,
        maxIssuesWithValue,
        sortBy,
      });
      setSelectedFieldIds(result.fieldIds || []);
    } catch (err) {
      setError(err.message || "Failed to select filtered fields.");
    }
  }

  async function generateProjectUsageReport(fieldIdsOverride = null, reportNameOverride = "") {
    const fieldIds = fieldIdsOverride?.length ? fieldIdsOverride : selectedFieldIds;
    if (!fieldIds.length) {
      setError("Select at least one field for the report.");
      return;
    }
    setLoadingReport(true);
    try {
      const nextReportName = reportNameOverride || reportNameInput.trim() || "Project Usage Report";
      const result = await invoke("startProjectUsageReportJob", { fieldIds, reportName: nextReportName });
      setReportData(null);
      setReportJob(null);
      setReportJobId(result?.jobId || "");
      setActiveReportName(nextReportName);
      setActiveTab("report");
      if (result?.jobId) {
        await fetchReportJob(result.jobId);
      }
    } catch (err) {
      setError(err.message || "Failed to generate project usage report.");
    } finally {
      setLoadingReport(false);
    }
  }

  function exportProjectUsageReportCsv(overrideReportData = null) {
    const exportData = overrideReportData || reportData;
    if (!exportData?.fields?.length) {
      setError("No report data available to export.");
      return;
    }

    const header = ["Field ID", "Field Name", ...exportData.projects.map((project) => project.projectKey)];
    const rows = [];
    for (const group of groupReportFieldsByType(exportData.fields)) {
      rows.push([`${group.fieldType.toUpperCase()} FIELDS`, "", ...exportData.projects.map(() => "")]);
      for (const field of group.fields) {
        const cellByProjectId = new Map(field.projects.map((project) => [project.projectId, project]));
        const cells = exportData.projects.map((project) => {
          const cell = cellByProjectId.get(project.projectId);
          if (!cell) return "";
          const href = buildJiraSearchUrl(siteOrigin, cell.jql);
          return href ? `=HYPERLINK("${href.replace(/"/g, '""')}", "${cell.issueCount} issues")` : `${cell.issueCount}`;
        });
        rows.push([field.fieldId, field.fieldName, ...cells]);
      }
    }

    downloadCsv(`${slugifyFilenamePart(activeReportName, "project-usage-report")}.csv`, [header, ...rows]);
  }

  async function saveCurrentReport() {
    if (!reportNameInput.trim()) {
      setError("Enter a report name before saving.");
      return;
    }

    setSavingReport(true);
    try {
      const existing = savedReports.find((report) => report.name.toLowerCase() === reportNameInput.trim().toLowerCase());
      const result = await invoke("saveReportDefinition", {
        reportId: existing?.reportId || "",
        name: reportNameInput.trim(),
        fieldIds: selectedFieldIds,
      });
      setSavedReports(result.reports || []);
      setActiveReportName(reportNameInput.trim());
    } catch (err) {
      setError(err.message || "Failed to save report.");
    } finally {
      setSavingReport(false);
    }
  }

  async function loadSavedReport(report) {
    setSelectedFieldIds(report.fieldIds || []);
    setReportNameInput(report.name || "");
    await generateProjectUsageReport(report.fieldIds || [], report.name || "");
  }

  async function removeSavedReport(reportId) {
    setDeletingReportId(reportId);
    try {
      const result = await invoke("deleteReportDefinition", { reportId });
      setSavedReports(result.reports || []);
    } catch (err) {
      setError(err.message || "Failed to delete report.");
    } finally {
      setDeletingReportId("");
    }
  }

  async function askRovoAboutInventory() {
    try {
      await openFieldExpertRovo(
        buildInventoryRovoPrompt({
          totalFields,
          availableTypes,
          refreshedAt,
          currentPage,
          totalPages,
          query: debouncedQuery,
          typeFilter,
          sortBy,
        })
      );
    } catch (err) {
      setError(err.message || "Failed to open Rovo.");
    }
  }

  async function askRovoAboutField(field) {
    try {
      await openFieldExpertRovo(buildFieldRovoPrompt(field, detailsByFieldId[field.id]));
    } catch (err) {
      setError(err.message || "Failed to open Rovo.");
    }
  }

  async function askRovoAboutProject(field, project) {
    try {
      await openFieldExpertRovo(buildProjectRovoPrompt(field, detailsByFieldId[field.id], project));
    } catch (err) {
      setError(err.message || "Failed to open Rovo.");
    }
  }

  async function askRovoAboutReport({ fields, projects, pendingFields, reportSummary }) {
    try {
      await openFieldExpertRovo(
        buildReportRovoPrompt({
          reportName: activeReportName || reportNameInput || "Project Usage Report",
          fields,
          projects,
          pendingFields,
          reportSummary,
        })
      );
    } catch (err) {
      setError(err.message || "Failed to open Rovo.");
    }
  }

  const isBuilding = snapshotStatus?.state === "building" || snapshotStatus?.state === "queued";
  const showOnboarding = !loadingInventory && !refreshedAt && !isBuilding;
  const showTracker = !trackerDismissed && Boolean(refreshedAt) && !loadingInventory;

  function dismissTracker() {
    localStorage.setItem("atlasiq-onboarding-tracker-dismissed", "1");
    setTrackerDismissed(true);
  }

  const snapshotChipState = (() => {
    const state = buildProgress?.status || snapshotStatus?.state || "idle";
    if (state === "building") return "building";
    if (state === "queued") return "queued";
    if (refreshedAt) return "ready";
    return "idle";
  })();

  const snapshotChipLabel = (() => {
    if (snapshotChipState === "building") {
      const pct = buildProgress?.totalFields > 0
        ? Math.round((buildProgress.processedFields / buildProgress.totalFields) * 100)
        : 0;
      return `Building ${pct}%`;
    }
    if (snapshotChipState === "queued") return "Queued";
    if (snapshotChipState === "ready") return `Synced ${formatRelativeTime(refreshedAt)}`;
    return "No snapshot";
  })();

  if (accessCheck === null) {
    return (
      <div className="access-gate access-gate--checking">
        <div className="access-gate__spinner" />
        <span>Verifying access…</span>
      </div>
    );
  }

  if (!accessCheck.allowed) {
    return (
      <div className="access-gate access-gate--denied">
        <svg className="access-gate__icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 11H5a2 2 0 00-2 2v7a2 2 0 002 2h14a2 2 0 002-2v-7a2 2 0 00-2-2zM17 11V7a5 5 0 00-10 0v4" />
        </svg>
        <h2 className="access-gate__title">Access Restricted</h2>
        <p className="access-gate__reason">{accessCheck.reason || "You don't have permission to view this Observatory."}</p>
      </div>
    );
  }

  return (
    <main
      className={`app-shell ${compactLayout ? "app-shell--compact" : ""} ${activeTab === "report" ? "app-shell--report" : ""} ${activeTab === "projects" ? "app-shell--projects" : ""}`}
      style={{ zoom: zoomLevel / 100 }}
    >
      <section className="hero">
        <div className="hero__identity">
          <h1>Observatory</h1>
          <span className={`snapshot-chip snapshot-chip--${snapshotChipState}`}>
            <span className="snapshot-chip__dot" />
            {snapshotChipLabel}
          </span>
        </div>
        <div className="hero__actions">
          <div className="zoom-controls" aria-label="App zoom controls">
            <button
              className="secondary-button secondary-button--small"
              onClick={() => setZoomLevel((current) => Math.max(80, current - 10))}
              type="button"
              disabled={zoomLevel <= 80}
            >
              A-
            </button>
            <span className="zoom-controls__value">{zoomLevel}%</span>
            <button
              className="secondary-button secondary-button--small"
              onClick={() => setZoomLevel((current) => Math.min(130, current + 10))}
              type="button"
              disabled={zoomLevel >= 130}
            >
              A+
            </button>
            <button
              className="secondary-button secondary-button--small"
              onClick={() => setZoomLevel(100)}
              type="button"
              disabled={zoomLevel === 100}
            >
              Reset
            </button>
          </div>
          <button
            className="secondary-button"
            onClick={askRovoAboutInventory}
            type="button"
            disabled={!rovoEnabled}
          >
            Ask Rovo
          </button>
          <button
            className="icon-button"
            onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")}
            type="button"
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? "☀" : "☽"}
          </button>
          <button
            className="primary-button"
            onClick={() => fetchInventory({ forceRefresh: true, page: 1 })}
            type="button"
            disabled={loadingInventory || readOnlyMode}
            title={readOnlyMode ? "Snapshot refresh is disabled by an admin" : undefined}
          >
            {loadingInventory ? "Refreshing..."
              : snapshotStatus?.state === "queued" ? "Queued..."
              : snapshotStatus?.state === "building" ? "Building..."
              : readOnlyMode ? "Read-only mode"
              : "Refresh data"}
          </button>
        </div>
      </section>

      <div className="tab-bar">
        <button
          className={`tab-bar__tab ${activeTab === "inventory" ? "tab-bar__tab--active" : ""}`}
          type="button"
          onClick={() => setActiveTab("inventory")}
        >
          <Icon name="layers" size={15} />
          Inventory
        </button>
        <button
          className={`tab-bar__tab ${activeTab === "projects" ? "tab-bar__tab--active" : ""}`}
          type="button"
          onClick={() => setActiveTab("projects")}
        >
          <Icon name="folder" size={15} />
          Projects
        </button>
        <button
          className={`tab-bar__tab ${activeTab === "report" ? "tab-bar__tab--active" : ""}`}
          type="button"
          onClick={() => setActiveTab("report")}
        >
          <Icon name="barChart" size={15} />
          Report
          {selectedFieldIds.length ? <span className="tab-bar__dot" /> : null}
        </button>
        <button
          className={`tab-bar__tab ${activeTab === "activity" ? "tab-bar__tab--active" : ""}`}
          type="button"
          onClick={() => setActiveTab("activity")}
        >
          <Icon name="activity" size={15} />
          Activity
          {snapshotStatus?.state === "building" || snapshotStatus?.state === "queued" || hasActiveProjectUsageJobs
            || issueScanState === "building" || issueScanState === "queued"
            ? <span className="tab-bar__dot" />
            : null}
        </button>
        <button
          className={`tab-bar__tab ${activeTab === "rqt" ? "tab-bar__tab--active" : ""}`}
          type="button"
          onClick={() => setActiveTab("rqt")}
        >
          <Icon name="search" size={15} />
          RQT Index
        </button>
      </div>

      {activeTab === "activity" ? (
        <section className="snapshot-log-view">
          <ActivitySection
            title="Snapshot Activity"
            subtitle="Build status and log entries for the field inventory snapshot."
            open={!collapsedActivitySections.snapshot}
            onToggle={() => toggleActivitySection("snapshot")}
          >
            <div className="snapshot-log-layout">
              <BuildsPanel
                buildProgress={buildProgress}
                snapshotStatus={snapshotStatus}
                onCancel={cancelBuild}
                cancellingBuild={cancellingBuild}
              />
              <div className="snapshot-log-entries">
                <div className="snapshot-log-entries__heading">Snapshot Log</div>
                {(() => {
                  const entries = buildProgress?.progressLog?.length
                    ? buildProgress.progressLog
                    : snapshotStatus?.progressLog?.length
                    ? snapshotStatus.progressLog
                    : [];
                  return entries.length > 0 ? (
                    <div className="scan-log">
                      {[...entries].reverse().map((entry, i) => (
                        <div key={i} className="scan-log__entry">
                          <span className="scan-log__time">{formatShortTime(entry.t)}</span>
                          <span className="scan-log__msg">{entry.msg}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-state empty-state--inline">
                      {buildProgress ? "Waiting for the build to start..." : "No log entries yet."}
                    </div>
                  );
                })()}
              </div>
            </div>
          </ActivitySection>
          <ActivitySection
            title="Universe Scan"
            subtitle="Full-site issue crawl used to derive unique issue counts per project."
            open={!collapsedActivitySections.universeScan}
            onToggle={() => toggleActivitySection("universeScan")}
          >
            <UniverseScanPanel
              issueScan={issueScanStatus}
              onStart={startIssueScanAction}
              onResume={resumeIssueScanAction}
              onCancel={cancelIssueScanAction}
              issueScanLoading={issueScanLoading}
              issueScanResuming={issueScanResuming}
              issueScanCancelling={issueScanCancelling}
              deltaIssueScan={deltaIssueScanStatus}
              onStartDelta={startDeltaIssueScanAction}
              issueScanDeltaStarting={issueScanDeltaStarting}
            />
          </ActivitySection>
          {!readOnlyMode ? (
            <ActivitySection
              title="Project Usage Jobs"
              subtitle="Background field usage builds with per-job progress and logs."
              open={!collapsedActivitySections.projectUsage}
              onToggle={() => toggleActivitySection("projectUsage")}
            >
              <ProjectUsageJobsView
                jobs={projectUsageJobs}
                expandedJobFieldId={expandedJobFieldId}
                onToggleJob={toggleProjectUsageJob}
                onCancelJob={cancelProjectUsageJob}
                cancellingJobFieldId={cancellingJobFieldId}
                onResumeJob={resumeProjectUsageJob}
                resumingJobFieldId={resumingJobFieldId}
                onRefreshJob={refreshUsageJob}
                refreshingUsageJobFieldId={refreshingUsageJobFieldId}
                onRefreshRecentUsage={refreshRecentUsageWindow}
                refreshingRecentUsage={refreshingRecentUsage}
                onRefresh={fetchProjectUsageJobs}
                refreshingJobs={refreshingJobs}
                jobsRefreshedAt={jobsRefreshedAt}
              />
            </ActivitySection>
          ) : null}
        </section>
      ) : activeTab === "projects" ? (
        <ProjectsTabView
          data={projectsViewData}
          loading={loadingProjectsView}
          siteOrigin={siteOrigin}
          selectedProjectId={selectedProjectId}
          onSelectProject={setSelectedProjectId}
          projectQuery={projectTabProjectQuery}
          onProjectQueryChange={setProjectTabProjectQuery}
          fieldQuery={projectTabFieldQuery}
          onFieldQueryChange={setProjectTabFieldQuery}
          fieldType={projectTabFieldType}
          onFieldTypeChange={setProjectTabFieldType}
          fieldSort={projectTabFieldSort}
          onFieldSortChange={setProjectTabFieldSort}
          onChangePage={setProjectTabPage}
          onRestoreProjectUsageCache={restoreProjectUsageCacheAction}
          projectUsageRestoring={projectUsageRestoring}
        />
      ) : activeTab === "report" ? (
        <ReportErrorBoundary resetKey={`${activeReportName}-${selectedFieldIds.join(",")}`}>
          <ProjectUsageReportView
            reportData={reportData}
            reportName={activeReportName}
            reportJob={reportJob}
            siteOrigin={siteOrigin}
            onExportCsv={exportProjectUsageReportCsv}
            onAskReport={askRovoAboutReport}
            savedReports={savedReports}
            selectedFieldIds={selectedFieldIds}
            reportNameInput={reportNameInput}
            onReportNameChange={setReportNameInput}
            onSaveReport={saveCurrentReport}
            onLoadReport={loadSavedReport}
            onDeleteReport={removeSavedReport}
            savingReport={savingReport}
            deletingReportId={deletingReportId}
            rovoEnabled={rovoEnabled}
          />
        </ReportErrorBoundary>
      ) : activeTab === "rqt" ? (
        <RqtIndexView siteOrigin={siteOrigin} />
      ) : (
        <>
          {showOnboarding ? (
            <OnboardingPanel onStart={() => fetchInventory({ forceRefresh: true, page: 1 })} loading={loadingInventory} />
          ) : (
          <>
          {showTracker && (
            <GettingStartedTracker
              refreshedAt={refreshedAt}
              findingsSummary={findingsSummary}
              projectUsageJobs={projectUsageJobs}
              onDismiss={dismissTracker}
            />
          )}
          <div className="status-banner status-banner--info" style={{ marginBottom: 12 }}>
            Field registry data reflects the Jira fields, projects, and issues visible to this app on {siteOrigin || "this Atlassian site"}. Some restricted Jira data may be excluded from counts and search results.
          </div>
          <section className="toolbar">
            <label className="toolbar__field">
              <span>Search</span>
              <input
                type="search"
                placeholder="Field name, id, type, or description"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                data-search-input="primary"
              />
            </label>
            <label className="toolbar__field">
              <span>Option search</span>
              <input
                type="search"
                placeholder="Select option value, e.g. DCV or P833"
                value={optionQuery}
                onChange={(event) => setOptionQuery(event.target.value)}
              />
            </label>
            <label className="toolbar__field">
              <span>Field type</span>
              <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
                <option value="all">All types</option>
                {availableTypes.map((type) => (
                  <option value={type} key={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <label className="toolbar__field">
              <span>Field origin</span>
              <select value={fieldOrigin} onChange={(event) => setFieldOrigin(event.target.value)}>
                <option value="all">All fields</option>
                <option value="user-created">User-created</option>
                <option value="jira-builtin">Jira built-in</option>
              </select>
            </label>
            <label className="toolbar__field">
              <span>Sort</span>
              <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
                <option value="name-asc">Name A-Z</option>
                <option value="name-desc">Name Z-A</option>
                <option value="usage-desc">Most issues with value</option>
                <option value="usage-asc">Fewest issues with value</option>
                <option value="active-projects-desc">Most active projects</option>
                <option value="active-projects-asc">Fewest active projects</option>
              </select>
            </label>
            <label className="toolbar__field">
              <span>Project usage</span>
              <select value={projectUsageFilter} onChange={(event) => setProjectUsageFilter(event.target.value)}>
                <option value="all">All states</option>
                <option value="not-built">Usage not built</option>
                <option value="built">Usage built</option>
                <option value="building">Usage building</option>
                <option value="incomplete">Usage incomplete</option>
              </select>
            </label>
            <label className="toolbar__field">
              <span>Issues with value</span>
              <div className="toolbar__range-inputs">
                <input
                  type="number"
                  min="0"
                  step="1"
                  placeholder="Min"
                  value={minIssuesWithValue}
                  onChange={(event) => setMinIssuesWithValue(event.target.value)}
                />
                <span className="toolbar__range-sep">–</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  placeholder="Max"
                  value={maxIssuesWithValue}
                  onChange={(event) => setMaxIssuesWithValue(event.target.value)}
                />
              </div>
            </label>
          </section>

          <div className="findings-actions-bar">
            <FindingsFilterBar
              value={findingsFilter}
              onChange={setFindingsFilter}
              summary={findingsSummary}
              hasActiveFilters={hasActiveFilters}
              onClear={clearFilters}
            />
            <div className="toolbar__report-actions">
              {selectedFieldIds.length > 0 && (
                <span className="toolbar__selected-count">{selectedFieldIds.length} selected</span>
              )}
              <button
                className="secondary-button secondary-button--small"
                type="button"
                onClick={selectAllFilteredFields}
                disabled={loadingInventory || !visibleTotalFields}
              >
                Select filtered
              </button>
              {selectedFieldIds.length > 0 && (
                <button
                  className="secondary-button secondary-button--small"
                  type="button"
                  onClick={clearSelectedFields}
                >
                  Clear
                </button>
              )}
              <button
                className="primary-button"
                type="button"
                onClick={generateProjectUsageReport}
                disabled={loadingReport || !selectedFieldIds.length}
              >
                <Icon name="barChart" size={14} />
                {loadingReport ? "Generating..." : "Generate report"}
              </button>
            </div>
          </div>

          <SnapshotBanner status={snapshotStatus} refreshedAt={refreshedAt} buildProgress={buildProgress} />
          {error ? <div className="error-banner">{error}</div> : null}
          {optionSearchStatus ? (
            <div className={`status-banner ${optionSearchStatus.state === "failed" ? "status-banner--warning" : "status-banner--info"}`} style={{ marginBottom: 10 }}>
              {optionSearchStatus.state === "failed"
                ? `Option search failed: ${optionSearchStatus.error}`
                : optionSearchStatus.state === "searching"
                ? `Option search found ${visibleTotalFields} fields so far; scanned ${formatNumber(optionSearchStatus.scanned)} of ${formatNumber(optionSearchStatus.totalCandidates)} selectable fields.`
                : `Option search found ${visibleTotalFields} matching fields.`}
            </div>
          ) : null}

          <section className="pagination-bar">
            <span className="pagination-bar__status">
              {totalFields
                ? `Showing ${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, totalFields)} of ${totalFields} fields`
                : "No fields in the current snapshot"}
            </span>
            <div className="pagination-bar__page-size">
              <span className="pagination-bar__page-size-label">Per page:</span>
              {[10, 25, 50].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`pagination-bar__page-size-btn ${pageSize === n ? "pagination-bar__page-size-btn--active" : ""}`}
                  onClick={() => { localStorage.setItem("atlasiq-field-pagesize", n); setPageSize(n); setCurrentPage(1); }}
                >{n}</button>
              ))}
            </div>
            <div className="pagination-bar__actions">
              <button className="secondary-button" type="button" onClick={() => setCurrentPage(1)} disabled={optionSearchFieldIds instanceof Set || currentPage === 1 || !totalFields}>First</button>
              <button className="secondary-button" type="button" onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={optionSearchFieldIds instanceof Set || currentPage === 1 || !totalFields}>Previous</button>
              <button className="secondary-button" type="button" onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={optionSearchFieldIds instanceof Set || currentPage === totalPages || !totalFields}>Next</button>
              <button className="secondary-button" type="button" onClick={() => setCurrentPage(totalPages)} disabled={optionSearchFieldIds instanceof Set || currentPage === totalPages || !totalFields}>Last</button>
            </div>
          </section>

          <section className="field-list">
            {loadingInventory ? (
              Array.from({ length: 6 }, (_, i) => <SkeletonFieldCard key={i} />)
            ) : visibleInventoryFields.length ? (
              visibleInventoryFields.map((field) => (
                <FieldCard
                  key={field.id}
                  field={field}
                  details={detailsByFieldId[field.id]}
                  expanded={expandedFieldId === field.id}
                  loading={loadingDetailFieldId === field.id}
                  selected={selectedFieldIds.includes(field.id)}
                  onSelectChange={toggleFieldSelection}
                  onToggle={() => toggleField(field.id)}
                  onProjectUsagePageChange={changeProjectUsagePage}
                  onRestartProjectUsage={restartProjectUsage}
                  restartingProjectUsageFieldId={restartingProjectUsageFieldId}
                  onRefreshProjectUsage={refreshProjectUsage}
                  onAskField={() => askRovoAboutField(field)}
                  onAskProject={(project) => askRovoAboutProject(field, project)}
                  siteOrigin={siteOrigin}
                  rovoEnabled={rovoEnabled}
                />
              ))
            ) : (
              <div className="empty-state">
                {snapshotStatus?.state === "queued" || snapshotStatus?.state === "building"
                  ? "Snapshot is building. Switch to the Snapshot Log tab to see progress."
                  : hasActiveFilters
                  ? <span>No fields matched the current filters. <button className="inline-text-button" type="button" onClick={clearFilters}>Clear filters</button></span>
                  : "No custom fields found in the snapshot."}
              </div>
            )}
          </section>

          <section className="pagination-bar">
            <span className="pagination-bar__status">
              {totalFields
                ? `Showing ${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, totalFields)} of ${totalFields} fields`
                : "No fields in the current snapshot"}
            </span>
            <div className="pagination-bar__page-size">
              <span className="pagination-bar__page-size-label">Per page:</span>
              {[10, 25, 50].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`pagination-bar__page-size-btn ${pageSize === n ? "pagination-bar__page-size-btn--active" : ""}`}
                  onClick={() => { localStorage.setItem("atlasiq-field-pagesize", n); setPageSize(n); setCurrentPage(1); }}
                >{n}</button>
              ))}
            </div>
            <div className="pagination-bar__actions">
              <button className="secondary-button" type="button" onClick={() => setCurrentPage(1)} disabled={optionSearchFieldIds instanceof Set || currentPage === 1 || !totalFields}>First</button>
              <button className="secondary-button" type="button" onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={optionSearchFieldIds instanceof Set || currentPage === 1 || !totalFields}>Previous</button>
              <button className="secondary-button" type="button" onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={optionSearchFieldIds instanceof Set || currentPage === totalPages || !totalFields}>Next</button>
              <button className="secondary-button" type="button" onClick={() => setCurrentPage(totalPages)} disabled={optionSearchFieldIds instanceof Set || currentPage === totalPages || !totalFields}>Last</button>
            </div>
          </section>
          </>
          )}
        </>
      )}
    </main>
  );
}

try {
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );

  if (bootStatusNode) {
    bootStatusNode.remove();
  }
} catch (error) {
  if (bootStatusNode) {
    bootStatusNode.dataset.state = "error";
    bootStatusNode.textContent = `React mount failed: ${error.message || "Unknown error"}`;
  }
  throw error;
}