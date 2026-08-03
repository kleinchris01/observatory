import React from "react";
import ReactDOM from "react-dom/client";
import { createPortal } from "react-dom";
import { invoke, view } from "@forge/bridge";
import "./styles.css";
import { formatTimestamp, formatNumber, toDisplayName, buildValueJql, formatShortTime, formatRelativeTime, formatLogTime, formatContextList, normalizeSiteOrigin, buildJiraSearchUrl, handleJiraLinkClick, escapeCsvCell, downloadCsv, slugifyFilenamePart, normalizeReportData, groupReportFieldsByType, summarizeReportData, isUsageAvailable, isSelectType, mergeFieldMetrics, openFieldExpertRovo, buildInventoryRovoPrompt, buildFieldRovoPrompt, buildProjectRovoPrompt, buildReportRovoPrompt } from "./utils";
import { Icon, useLiveDuration } from "./components/Icons";
import { ReportErrorBoundary, SavedReportsPanel, ProjectUsageReportView } from "./components/ReportView";
import { MetricChip, FindingBadge, FindingsStrip, SkeletonFieldCard, SkeletonProjectItem, InlineOptionsContext, FieldCard } from "./components/FieldCard";

// Lazy: both pull in recharts (+122KB gzip measured on the macro bundle) and
// sit behind tabs not shown by default -- split into their own chunk, fetched
// only when a user actually opens Projects or Scans/RQT.
const ProjectsTabView = React.lazy(() =>
  import("./components/ProjectsTab").then((m) => ({ default: m.ProjectsTabView }))
);
const RqtIndexView = React.lazy(() =>
  import("./tabs/RqtTab").then((m) => ({ default: m.RqtIndexView }))
);
const WorkflowTab = React.lazy(() =>
  import("./tabs/WorkflowTab").then((m) => ({ default: m.WorkflowTab }))
);
const OverviewDashboard = React.lazy(() =>
  import("./components/OverviewDashboard").then((m) => ({ default: m.OverviewDashboard }))
);

const bootStatusNode = document.getElementById("boot-status");

// ── Default config ─────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS = {
  highImpactMinProjects: 10,
  highImpactMinIssues: 1000,
  appFieldHeavyUsageMin: 500,
  broadScopeMinProjects: 3,
  lightUsageMinProjects: 5,
  lightUsageMaxIssues: 100,
  missingDescriptionMinProjects: 5,
  missingDescriptionMinIssues: 500,
  configuredActiveGapMinProjects: 5,
  configuredActiveGapMaxRatio: 0.70,
  globalContextMaxIssues: 50,
  contextSprawlMinContexts: 8,
  staleFieldMaxAgeDays: 365,
};

const DEFAULT_MACRO_ACCESS = {
  restrictAccess: false,
  allowedGroups: [],
};

const DEFAULT_CONFIG = {
  readOnlyMode: false,
  apiConcurrency: 4,
  autoSnapshotEnabled: false,
  autoSnapshotFrequency: "weekly",
  governanceThresholds: DEFAULT_THRESHOLDS,
  macroAccess: DEFAULT_MACRO_ACCESS,
};

// ── Sub-components ─────────────────────────────────────────────────────────

function StatCard({ label, value, icon, variant = "neutral" }) {
  return (
    <div className={`admin-stat-card admin-stat-card--${variant}`}>
      <div className="admin-stat-card__icon"><Icon name={icon} size={18} /></div>
      <div className="admin-stat-card__body">
        <span className="admin-stat-card__value">{value ?? "—"}</span>
        <span className="admin-stat-card__label">{label}</span>
      </div>
    </div>
  );
}

function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`admin-toggle ${checked ? "admin-toggle--on" : ""}`}
      onClick={() => onChange(!checked)}
      disabled={disabled}
    >
      <span className="admin-toggle__thumb" />
    </button>
  );
}

function ConfigSection({ title, icon, children }) {
  return (
    <div className="admin-config-section">
      <div className="admin-config-section__header">
        <Icon name={icon} size={15} />
        <span>{title}</span>
      </div>
      <div className="admin-config-section__body">{children}</div>
    </div>
  );
}

function ConfigRow({ label, hint, children }) {
  return (
    <div className="admin-config-row">
      <div className="admin-config-row__label">
        <span className="admin-config-row__name">{label}</span>
        {hint && <span className="admin-config-row__hint">{hint}</span>}
      </div>
      <div className="admin-config-row__control">{children}</div>
    </div>
  );
}

function ThresholdInput({ label, value, onChange, min = 1, max = 100000, step = "1" }) {
  return (
    <label className="admin-threshold-input">
      <span className="admin-threshold-input__label">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(step === "1" ? (Number(e.target.value) || min) : (parseFloat(e.target.value) || min))}
        className="admin-threshold-input__field"
      />
    </label>
  );
}

function InlineThresholdInput({ value, onChange, min = 1, max = 100000, step = 1 }) {
  return (
    <input
      type="number"
      className="admin-threshold-rule__input"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(step === 1 ? (Number(e.target.value) || min) : (parseFloat(e.target.value) || min))}
    />
  );
}

// ── Job list (re-implemented for admin context) ───────────────────────────

function JobStatusBadge({ status }) {
  const map = {
    ready: "success",
    building: "building",
    queued: "queued",
    failed: "danger",
    cancelled: "muted",
    unbuilt: "neutral",
  };
  const variant = map[status] || "neutral";
  return <span className={`admin-job-badge admin-job-badge--${variant}`}>{status || "unbuilt"}</span>;
}

function AdminJobRow({ job, expanded, onToggle, onCancel, onRestart, onResume, cancellingId, restartingId, resumingId }) {
  const isCancelling = cancellingId === job.fieldId;
  const isRestarting = restartingId === job.fieldId;
  const isResuming = resumingId === job.fieldId;
  const canCancel = job.summaryStatus === "queued" || job.summaryStatus === "building";
  const canRestart = job.summaryStatus === "failed" || job.summaryStatus === "cancelled" || job.summaryStatus === "ready";
  const canResume = job.summaryStatus === "building";

  const progressPct = job.estimatedIssueTotal > 0
    ? Math.min(100, Math.round((job.processedIssueCount / job.estimatedIssueTotal) * 100))
    : 0;

  return (
    <div className={`admin-job-row ${expanded ? "admin-job-row--expanded" : ""}`}>
      <div className="admin-job-row__header" onClick={onToggle} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onToggle()}>
        <span className="admin-job-row__name">{job.fieldName || job.fieldId}</span>
        <span className="admin-job-row__id">{job.fieldId}</span>
        <JobStatusBadge status={job.summaryStatus} />
        {(job.summaryStatus === "building" || job.summaryStatus === "queued") && job.estimatedIssueTotal > 0 && (
          <span className="admin-job-row__progress">{progressPct}%</span>
        )}
        <div className="admin-job-row__actions" onClick={(e) => e.stopPropagation()}>
          {canCancel && (
            <button className="secondary-button secondary-button--small" type="button" disabled={isCancelling} onClick={() => onCancel(job.fieldId)}>
              {isCancelling ? "…" : "Cancel"}
            </button>
          )}
          {canResume && (
            <button className="secondary-button secondary-button--small" type="button" disabled={isResuming} onClick={() => onResume(job.fieldId)}>
              {isResuming ? "…" : "Resume"}
            </button>
          )}
          {canRestart && (
            <button className="secondary-button secondary-button--small" type="button" disabled={isRestarting} onClick={() => onRestart(job.fieldId)}>
              {isRestarting ? "…" : "Restart"}
            </button>
          )}
        </div>
        <Icon name={expanded ? "x" : "activity"} size={14} />
      </div>
      {expanded && (
        <div className="admin-job-row__detail">
          {job.summaryStatus === "building" && job.estimatedIssueTotal > 0 && (
            <div className="status-progress" style={{ marginBottom: 10 }}>
              <div className="status-progress__meta">
                <strong>{progressPct}%</strong>
                <span>{job.processedIssueCount} / {job.estimatedIssueTotal} issues</span>
              </div>
              <div className="status-progress__bar"><span style={{ width: `${progressPct}%` }} /></div>
            </div>
          )}
          <div className="admin-job-detail-grid">
            <span>Started</span><span>{formatTimestamp(job.startedAt)}</span>
            <span>Completed</span><span>{formatTimestamp(job.completedAt)}</span>
            <span>Total issues</span><span>{job.totalIssueCount?.toLocaleString() ?? "—"}</span>
            <span>Active projects</span><span>{job.activeProjectCount ?? "—"}</span>
          </div>
          {job.lastError && (
            <div className="build-card__error" style={{ marginTop: 10 }}>{job.lastError}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Tab views ──────────────────────────────────────────────────────────────

function SnapshotLog({ entries }) {
  const logRef = React.useRef(null);
  const [expanded, setExpanded] = React.useState(true);

  React.useEffect(() => {
    if (expanded && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [entries, expanded]);

  if (!entries?.length) return null;

  return (
    <div className="admin-snapshot-log-wrap">
      <button
        type="button"
        className="admin-snapshot-log-toggle"
        onClick={() => setExpanded((v) => !v)}
      >
        <Icon name={expanded ? "x" : "activity"} size={12} />
        {expanded ? "Hide" : "Show"} build log ({entries.length} entries)
      </button>
      {expanded && (
        <div className="admin-snapshot-log" ref={logRef}>
          {entries.map((entry, i) => (
            <div key={i} className="admin-snapshot-log-entry">
              <span className="admin-snapshot-log-entry__time">{formatLogTime(entry.t)}</span>
              <span className="admin-snapshot-log-entry__msg">{entry.msg}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OverviewTab({ overview, onMigrateNamespace, migratingNamespace, onOpenRqtIndex, onNavigate }) {
  if (!overview) {
    return <div className="empty-state">Loading overview…</div>;
  }

  const { findingsSummary } = overview;

  return (
    <div className="admin-overview">
      {overview.legacySummaryCount > 0 && (
        <div className="admin-migration-banner">
          <div className="admin-migration-banner__body">
            <Icon name="alertTriangle" size={15} />
            <div>
              <strong>{overview.legacySummaryCount} field scan records</strong> are stranded under the old Confluence-only storage key and won&apos;t appear in the admin view. Click &ldquo;Recover data&rdquo; to migrate them to the shared namespace.
            </div>
          </div>
          <button
            type="button"
            className="primary-button"
            onClick={onMigrateNamespace}
            disabled={migratingNamespace}
          >
            {migratingNamespace ? "Migrating…" : "Recover data"}
          </button>
        </div>
      )}

      <React.Suspense fallback={<div className="empty-state">Loading dashboard…</div>}>
        <OverviewDashboard
          dashboard={overview.dashboard}
          findingsSummary={findingsSummary}
          workflow={overview.workflow}
          onOpenRqtIndex={onOpenRqtIndex}
          onNavigate={onNavigate}
        />
      </React.Suspense>

      <div className="admin-section">
        <h2 className="admin-section__title"><Icon name="zap" size={16} /> Atlassian Developer Console</h2>
        <div className="admin-dev-links">
          <a
            className="admin-dev-link"
            href="https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => handleJiraLinkClick(e, "https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/")}
          >
            <Icon name="zap" size={13} /> App overview
          </a>
          <a
            className="admin-dev-link"
            href="https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/invocations"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => handleJiraLinkClick(e, "https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/invocations")}
          >
            <Icon name="activity" size={13} /> Invocation metrics
          </a>
          <a
            className="admin-dev-link"
            href="https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/storage"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => handleJiraLinkClick(e, "https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/storage")}
          >
            <Icon name="layers" size={13} /> Storage / SQL
          </a>
          <a
            className="admin-dev-link"
            href="https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/logs"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => handleJiraLinkClick(e, "https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/logs")}
          >
            <Icon name="info" size={13} /> App logs
          </a>
        </div>
      </div>
    </div>
  );
}

function JobsPanel({ jobs, loading, expandedId, onToggle, onCancel, onRestart, onResume, onRefresh, cancellingId, restartingId, resumingId, refreshing }) {
  const [jobQuery, setJobQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");

  const filtered = React.useMemo(() => {
    let list = jobs;
    if (statusFilter !== "all") list = list.filter((j) => j.summaryStatus === statusFilter);
    if (jobQuery.trim()) {
      const q = jobQuery.toLowerCase();
      list = list.filter((j) => (j.fieldName || "").toLowerCase().includes(q) || (j.fieldId || "").toLowerCase().includes(q));
    }
    return list;
  }, [jobs, statusFilter, jobQuery]);

  return (
    <div className="admin-jobs-tab">
      <div className="admin-jobs-toolbar">
        <input
          type="search"
          placeholder="Search by field name or ID"
          value={jobQuery}
          onChange={(e) => setJobQuery(e.target.value)}
          className="admin-jobs-search"
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="ready">Ready</option>
          <option value="building">Building</option>
          <option value="queued">Queued</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
          <option value="unbuilt">Not built</option>
        </select>
        <button className="secondary-button" type="button" onClick={onRefresh} disabled={refreshing}>
          <Icon name="refreshCw" size={13} />
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {loading && !jobs.length ? (
        <div className="empty-state">Loading jobs…</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">No jobs match the current filter.</div>
      ) : (
        <div className="admin-job-list">
          {filtered.map((job) => (
            <AdminJobRow
              key={job.fieldId}
              job={job}
              expanded={expandedId === job.fieldId}
              onToggle={() => onToggle(job.fieldId)}
              onCancel={onCancel}
              onRestart={onRestart}
              onResume={onResume}
              cancellingId={cancellingId}
              restartingId={restartingId}
              resumingId={resumingId}
            />
          ))}
        </div>
      )}
      <p className="admin-jobs-count">
        {filtered.length !== jobs.length ? `${filtered.length} of ${jobs.length}` : jobs.length} field usage jobs
      </p>
    </div>
  );
}

// Read-only view of the audit trail. Loads on demand rather than with the tab: the
// query is cheap but pointless for the common case of someone opening Configuration to
// change a threshold, and this app pays for SQL requests by the request.
export function AuditLogPanel() {
  const [events, setEvents] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [outcomeFilter, setOutcomeFilter] = React.useState("all");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await invoke("getAuditLog", { limit: 200 });
      setEvents(Array.isArray(res?.events) ? res.events : []);
    } catch (err) {
      setError(err?.message || "Failed to load the audit log.");
    } finally {
      setLoading(false);
    }
  }, []);

  const visible = React.useMemo(() => {
    if (!events) return [];
    if (outcomeFilter === "all") return events;
    return events.filter((e) => e.outcome === outcomeFilter);
  }, [events, outcomeFilter]);

  const deniedCount = React.useMemo(
    () => (events || []).filter((e) => e.outcome === "denied").length,
    [events]
  );

  return (
    <section className="admin-config-section audit-panel">
      <div className="audit-panel__header">
        <div>
          <h3 className="admin-config-section__title">Audit log</h3>
          <p className="admin-config-section__hint">
            Privileged actions and permission denials, newest first. Retained for 180 days.
            Routine admin reads are not recorded.
          </p>
        </div>
        <button className="secondary-button" type="button" onClick={load} disabled={loading}>
          <Icon name="refreshCw" size={13} />
          {loading ? "Loading…" : events ? "Refresh" : "Load audit log"}
        </button>
      </div>

      {error && <div className="danger-zone__error" role="alert">{error}</div>}

      {/* A denial means someone reached an admin resolver without admin permission --
          worth surfacing rather than leaving buried in a 200-row table. */}
      {deniedCount > 0 && (
        <div className="audit-panel__alert" role="status">
          <Icon name="alertTriangle" size={13} />
          {deniedCount} permission {deniedCount === 1 ? "denial" : "denials"} in this window.
          A denial means an admin resolver was reached by a caller without Jira admin permission.
        </div>
      )}

      {events && events.length > 0 && (
        <div className="audit-panel__filters">
          {["all", "allowed", "denied", "failed"].map((value) => (
            <button
              key={value}
              type="button"
              className={`audit-filter ${outcomeFilter === value ? "audit-filter--active" : ""}`}
              onClick={() => setOutcomeFilter(value)}
            >
              {value === "all" ? "All" : value.charAt(0).toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
      )}

      {events && events.length === 0 && (
        <div className="empty-state">
          No audit events recorded yet. Privileged actions appear here once performed.
        </div>
      )}

      {events && events.length > 0 && (
        <div className="audit-panel__scroll">
          <table className="audit-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Outcome</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((event, i) => (
                <tr key={`${event.at}-${i}`}>
                  <td className="audit-table__when">{formatTimestamp(event.at)}</td>
                  <td className="audit-table__actor" title={event.actorId || "unknown"}>
                    {event.actorId || "—"}
                  </td>
                  <td className="audit-table__action">{event.action}</td>
                  <td>
                    <span className={`audit-outcome audit-outcome--${event.outcome}`}>{event.outcome}</span>
                  </td>
                  <td className="audit-table__detail">{event.detail || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 && (
            <div className="empty-state">No {outcomeFilter} events in this window.</div>
          )}
        </div>
      )}
    </section>
  );
}

function ConfigTab({ config, onSave, saving }) {
  const [local, setLocal] = React.useState(() => {
    const c = config || DEFAULT_CONFIG;
    return {
      ...DEFAULT_CONFIG,
      ...c,
      governanceThresholds: { ...DEFAULT_THRESHOLDS, ...(c.governanceThresholds || {}) },
      macroAccess: { ...DEFAULT_MACRO_ACCESS, ...(c.macroAccess || {}) },
    };
  });
  const [dirty, setDirty] = React.useState(false);

  React.useEffect(() => {
    if (config) {
      setLocal({
        ...DEFAULT_CONFIG,
        ...config,
        governanceThresholds: { ...DEFAULT_THRESHOLDS, ...(config.governanceThresholds || {}) },
        macroAccess: { ...DEFAULT_MACRO_ACCESS, ...(config.macroAccess || {}) },
      });
      setDirty(false);
    }
  }, [config]);

  function set(key, value) {
    setLocal((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  function setThreshold(key, value) {
    setLocal((prev) => ({
      ...prev,
      governanceThresholds: { ...prev.governanceThresholds, [key]: value },
    }));
    setDirty(true);
  }

  function setMacroAccess(key, value) {
    setLocal((prev) => ({
      ...prev,
      macroAccess: { ...(prev.macroAccess || DEFAULT_MACRO_ACCESS), [key]: value },
    }));
    setDirty(true);
  }

  function handleSave() {
    onSave(local);
    setDirty(false);
  }

  const t = local.governanceThresholds || DEFAULT_THRESHOLDS;

  return (
    <div className="admin-config-tab">
      <ConfigSection title="Macro access" icon="lock">
        <ConfigRow
          label="Read-only mode"
          hint="Prevents Confluence macro users from triggering field usage scans. Admins can still run jobs here."
        >
          <Toggle checked={local.readOnlyMode} onChange={(v) => set("readOnlyMode", v)} />
        </ConfigRow>
        <ConfigRow
          label="Restrict macro to allowed groups"
          hint="When enabled, only users in the listed Jira groups can view the Observatory on any Confluence page."
        >
          <Toggle
            checked={local.macroAccess?.restrictAccess || false}
            onChange={(v) => setMacroAccess("restrictAccess", v)}
          />
        </ConfigRow>
        {local.macroAccess?.restrictAccess && (
          <ConfigRow
            label="Allowed Jira groups"
            hint="One group name per line. Users must be a member of at least one group to view the macro."
          >
            <div className="admin-group-input-wrap">
              <textarea
                className="admin-group-input"
                value={(local.macroAccess?.allowedGroups || []).join("\n")}
                onChange={(e) =>
                  setMacroAccess(
                    "allowedGroups",
                    e.target.value.split("\n").map((s) => s.trim()).filter(Boolean)
                  )
                }
                placeholder={"jira-administrators\nfield-governance-team"}
                rows={4}
                spellCheck={false}
              />
              <p className="admin-group-input__note">
                Group names are case-sensitive. Users not in any listed group will see an "Access Restricted" message instead of the Observatory.
              </p>
            </div>
          </ConfigRow>
        )}
      </ConfigSection>

      <ConfigSection title="API settings" icon="sliders">
        <ConfigRow
          label="Scan concurrency"
          hint="Max parallel Jira API calls during field usage scans (1–10). Lower values reduce API load; higher values speed up scans."
        >
          <div className="admin-concurrency-control">
            <input
              type="range"
              min="1"
              max="10"
              step="1"
              value={local.apiConcurrency}
              onChange={(e) => set("apiConcurrency", Number(e.target.value))}
            />
            <span className="admin-concurrency-control__value">{local.apiConcurrency}</span>
          </div>
        </ConfigRow>
      </ConfigSection>

      <ConfigSection title="Auto-snapshot" icon="clock">
        <ConfigRow
          label="Enable auto-snapshot"
          hint="Automatically rebuilds the field snapshot on a schedule. A daily Forge trigger checks whether a rebuild is due."
        >
          <Toggle checked={local.autoSnapshotEnabled} onChange={(v) => set("autoSnapshotEnabled", v)} />
        </ConfigRow>
        {local.autoSnapshotEnabled && (
          <ConfigRow label="Frequency" hint="How often the snapshot should be automatically rebuilt.">
            <select
              value={local.autoSnapshotFrequency}
              onChange={(e) => set("autoSnapshotFrequency", e.target.value)}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </ConfigRow>
        )}
      </ConfigSection>

      <ConfigSection title="Governance thresholds" icon="alertTriangle">
        <p className="admin-config-section__desc">
          Each rule below controls one specific finding. Edit the numbers inline — changes apply on the next inventory load with no snapshot rebuild required.
        </p>
        <div className="admin-threshold-rules">

          <div className="admin-threshold-rule">
            <span className="admin-threshold-rule__badge admin-threshold-rule__badge--risk">Risk</span>
            <span className="admin-threshold-rule__sentence">
              <strong>High-impact field:</strong> Flag when active in at least{" "}
              <InlineThresholdInput value={t.highImpactMinProjects} onChange={(v) => setThreshold("highImpactMinProjects", v)} min={1} max={500} />{" "}
              projects with{" "}
              <InlineThresholdInput value={t.highImpactMinIssues} onChange={(v) => setThreshold("highImpactMinIssues", v)} min={1} max={1000000} />{" "}
              or more issues — high stakes if changed or removed.
            </span>
          </div>

          <div className="admin-threshold-rule">
            <span className="admin-threshold-rule__badge admin-threshold-rule__badge--risk">Risk</span>
            <span className="admin-threshold-rule__sentence">
              <strong>App-provided field:</strong> Flag third-party app or plugin fields when they have{" "}
              <InlineThresholdInput value={t.appFieldHeavyUsageMin} onChange={(v) => setThreshold("appFieldHeavyUsageMin", v)} min={1} max={100000} />{" "}
              or more issues — data at risk if the app is removed.
            </span>
          </div>

          <div className="admin-threshold-rule">
            <span className="admin-threshold-rule__badge admin-threshold-rule__badge--cleanup">Cleanup</span>
            <span className="admin-threshold-rule__sentence">
              <strong>Broadly scoped, light usage:</strong> Flag when active in{" "}
              <InlineThresholdInput value={t.lightUsageMinProjects} onChange={(v) => setThreshold("lightUsageMinProjects", v)} min={1} max={500} />{" "}
              or more projects but fewer than{" "}
              <InlineThresholdInput value={t.lightUsageMaxIssues} onChange={(v) => setThreshold("lightUsageMaxIssues", v)} min={1} max={10000} />{" "}
              total issues — wide scope, very little actual data.
            </span>
          </div>

          <div className="admin-threshold-rule">
            <span className="admin-threshold-rule__badge admin-threshold-rule__badge--cleanup">Cleanup</span>
            <span className="admin-threshold-rule__sentence">
              <strong>Configured but unused:</strong> Flag when added to{" "}
              <InlineThresholdInput value={t.broadScopeMinProjects} onChange={(v) => setThreshold("broadScopeMinProjects", v)} min={1} max={500} />{" "}
              or more project screens but has zero issues with a value — likely never adopted.
            </span>
          </div>

          <div className="admin-threshold-rule">
            <span className="admin-threshold-rule__badge admin-threshold-rule__badge--cleanup">Cleanup</span>
            <span className="admin-threshold-rule__sentence">
              <strong>Dead configuration:</strong> Flag when configured in{" "}
              <InlineThresholdInput value={t.configuredActiveGapMinProjects} onChange={(v) => setThreshold("configuredActiveGapMinProjects", v)} min={1} max={500} />{" "}
              or more projects but more than{" "}
              <InlineThresholdInput value={Math.round(t.configuredActiveGapMaxRatio * 100)} onChange={(v) => setThreshold("configuredActiveGapMaxRatio", Math.max(5, Math.min(99, v)) / 100)} min={5} max={99} />{" "}
              % of those have no issue data — the field was added but not used.
            </span>
          </div>

          <div className="admin-threshold-rule">
            <span className="admin-threshold-rule__badge admin-threshold-rule__badge--cleanup">Cleanup</span>
            <span className="admin-threshold-rule__sentence">
              <strong>Over-scoped global context:</strong> Flag fields available to all projects (global context) when they have fewer than{" "}
              <InlineThresholdInput value={t.globalContextMaxIssues} onChange={(v) => setThreshold("globalContextMaxIssues", v)} min={1} max={100000} />{" "}
              issues — probably not worth applying site-wide.
            </span>
          </div>

          <div className="admin-threshold-rule">
            <span className="admin-threshold-rule__badge admin-threshold-rule__badge--cleanup">Cleanup</span>
            <span className="admin-threshold-rule__sentence">
              <strong>No recent activity:</strong> Flag fields that have issue data but whose most recent recorded change is older than{" "}
              <InlineThresholdInput value={t.staleFieldMaxAgeDays} onChange={(v) => setThreshold("staleFieldMaxAgeDays", v)} min={30} max={3650} />{" "}
              days — the data is historical. Only applies to fields whose per-project usage was built with changelog dates.
            </span>
          </div>

          <div className="admin-threshold-rule">
            <span className="admin-threshold-rule__badge admin-threshold-rule__badge--standardize">Standardize</span>
            <span className="admin-threshold-rule__sentence">
              <strong>Missing description:</strong> Flag when a field has no admin description and is active in{" "}
              <InlineThresholdInput value={t.missingDescriptionMinProjects} onChange={(v) => setThreshold("missingDescriptionMinProjects", v)} min={1} max={500} />{" "}
              or more projects, or has{" "}
              <InlineThresholdInput value={t.missingDescriptionMinIssues} onChange={(v) => setThreshold("missingDescriptionMinIssues", v)} min={1} max={1000000} />{" "}
              or more issues — prominent enough to need documentation.
            </span>
          </div>

          <div className="admin-threshold-rule">
            <span className="admin-threshold-rule__badge admin-threshold-rule__badge--standardize">Standardize</span>
            <span className="admin-threshold-rule__sentence">
              <strong>Context sprawl:</strong> Flag when a field has{" "}
              <InlineThresholdInput value={t.contextSprawlMinContexts} onChange={(v) => setThreshold("contextSprawlMinContexts", v)} min={2} max={100} />{" "}
              or more separate project contexts — suggests it was added project-by-project and should be consolidated.
            </span>
          </div>

        </div>
        <p className="admin-threshold-rules__note">
          <strong>Admin Attention</strong> is applied automatically to any field with a high-severity finding, or when the combined priority score of its findings reaches 35 or higher.
        </p>
      </ConfigSection>

      <div className="admin-config-footer">
        {dirty && <span className="admin-config-footer__unsaved">Unsaved changes</span>}
        <button
          className="primary-button"
          type="button"
          onClick={handleSave}
          disabled={saving || !dirty}
        >
          <Icon name="check" size={14} />
          {saving ? "Saving…" : "Save configuration"}
        </button>
      </div>

      {/* Below the save footer deliberately: this is a record, not a setting, and it
          should not sit between an admin and the button they came here to press. */}
      <AuditLogPanel />
    </div>
  );
}

// ── Project usage tab ─────────────────────────────────────────────────────

function ProjectUsageTab({ siteOrigin }) {
  const [projectQuery, setProjectQuery] = React.useState("");
  const [deferredProjectQuery, setDeferredProjectQuery] = React.useState("");
  const [fieldQuery, setFieldQuery] = React.useState("");
  const [deferredFieldQuery, setDeferredFieldQuery] = React.useState("");
  const [fieldType, setFieldType] = React.useState("all");
  const [fieldSort, setFieldSort] = React.useState("issues-desc");
  const [selectedProjectId, setSelectedProjectId] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState("");

  React.useEffect(() => {
    const t = setTimeout(() => { setDeferredProjectQuery(projectQuery); }, 350);
    return () => clearTimeout(t);
  }, [projectQuery]);

  React.useEffect(() => {
    const t = setTimeout(() => { setDeferredFieldQuery(fieldQuery); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [fieldQuery]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    invoke("getProjectsView", {
      projectId: selectedProjectId,
      projectQuery: deferredProjectQuery,
      fieldQuery: deferredFieldQuery,
      fieldType,
      sortBy: fieldSort,
      page,
    }).then((result) => {
      if (!cancelled) {
        setData(result);
        if (result?.selectedProject?.projectId && result.selectedProject.projectId !== selectedProjectId) {
          setSelectedProjectId(result.selectedProject.projectId);
        }
      }
    }).catch((err) => {
      if (!cancelled) setLoadError(err.message || "Failed to load project usage.");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedProjectId, deferredProjectQuery, deferredFieldQuery, fieldType, fieldSort, page]);

  function handleSelectProject(projectId) {
    setSelectedProjectId(projectId);
    setPage(1);
  }

  return (
    <>
      {loadError && <div className="error-banner">{loadError}</div>}
      <React.Suspense fallback={<div className="empty-state">Loading…</div>}>
        <ProjectsTabView
          data={data}
          loading={loading}
          siteOrigin={siteOrigin}
          selectedProjectId={selectedProjectId}
          onSelectProject={handleSelectProject}
          projectQuery={projectQuery}
          onProjectQueryChange={setProjectQuery}
          fieldQuery={fieldQuery}
          onFieldQueryChange={(v) => { setFieldQuery(v); }}
          fieldType={fieldType}
          onFieldTypeChange={(v) => { setFieldType(v); setPage(1); }}
          fieldSort={fieldSort}
          onFieldSortChange={(v) => { setFieldSort(v); setPage(1); }}
          onChangePage={setPage}
        />
      </React.Suspense>
    </>
  );
}

// ── Field browser tab ─────────────────────────────────────────────────────

function FieldBrowserTab({ selectedFieldIds = [], onToggleField, onSetSelectedFieldIds, onGoToReport, siteOrigin }) {
  const selectedSet = React.useMemo(() => new Set(selectedFieldIds), [selectedFieldIds]);
  const [pageSize, setPageSize] = React.useState(() => {
    const saved = Number(localStorage.getItem("admin-field-pagesize"));
    return [10, 25, 50].includes(saved) ? saved : 25;
  });
  const [query, setQuery] = React.useState("");
  const [deferredQuery, setDeferredQuery] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState("all");
  const [fieldOrigin, setFieldOrigin] = React.useState("all");
  const [findingsFilter, setFindingsFilter] = React.useState("all");
  const [sortBy, setSortBy] = React.useState("usage-desc");
  const [page, setPage] = React.useState(1);

  // Advanced filters
  const [projectUsageFilter, setProjectUsageFilter] = React.useState("all");
  const [hasDescription, setHasDescription] = React.useState("all");
  const [duplicateNamesOnly, setDuplicateNamesOnly] = React.useState(false);
  const [minIssues, setMinIssues] = React.useState("");
  const [maxIssues, setMaxIssues] = React.useState("");
  const [minActiveProjects, setMinActiveProjects] = React.useState("");
  const [maxActiveProjects, setMaxActiveProjects] = React.useState("");
  const [minContexts, setMinContexts] = React.useState("");
  const [maxContexts, setMaxContexts] = React.useState("");
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const filterPanelRef = React.useRef(null);

  React.useEffect(() => {
    if (!filtersOpen) return;
    function handleClickOutside(e) {
      if (filterPanelRef.current && !filterPanelRef.current.contains(e.target)) {
        setFiltersOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [filtersOpen]);

  const [deferredMinIssues, setDeferredMinIssues] = React.useState("");
  const [deferredMaxIssues, setDeferredMaxIssues] = React.useState("");
  const [deferredMinActiveProjects, setDeferredMinActiveProjects] = React.useState("");
  const [deferredMaxActiveProjects, setDeferredMaxActiveProjects] = React.useState("");
  const [deferredMinContexts, setDeferredMinContexts] = React.useState("");
  const [deferredMaxContexts, setDeferredMaxContexts] = React.useState("");
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState("");
  const [openFieldId, setOpenFieldId] = React.useState(null);
  const [fieldDetails, setFieldDetails] = React.useState({});
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState("");
  const [rovoEnabled, setRovoEnabled] = React.useState(false);

  React.useEffect(() => {
    view.getContext().then(() => setRovoEnabled(true)).catch(() => {});
  }, []);

  React.useEffect(() => {
    const t = setTimeout(() => { setDeferredQuery(query); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [query]);

  // Debounce the numeric range filters the same way the search query is debounced,
  // so typing in a min/max box doesn't fire a request per keystroke.
  React.useEffect(() => {
    const t = setTimeout(() => {
      setDeferredMinIssues(minIssues);
      setDeferredMaxIssues(maxIssues);
      setDeferredMinActiveProjects(minActiveProjects);
      setDeferredMaxActiveProjects(maxActiveProjects);
      setDeferredMinContexts(minContexts);
      setDeferredMaxContexts(maxContexts);
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [minIssues, maxIssues, minActiveProjects, maxActiveProjects, minContexts, maxContexts]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    invoke("getFieldInventory", {
      query: deferredQuery,
      type: typeFilter,
      fieldOrigin,
      findingsFilter,
      sortBy,
      page,
      pageSize,
      projectUsageFilter,
      hasDescription,
      duplicateNamesOnly,
      minIssuesWithValue: deferredMinIssues,
      maxIssuesWithValue: deferredMaxIssues,
      minActiveProjects: deferredMinActiveProjects,
      maxActiveProjects: deferredMaxActiveProjects,
      minContexts: deferredMinContexts,
      maxContexts: deferredMaxContexts,
    }).then((result) => {
      if (!cancelled) setData(result);
    }).catch((err) => {
      if (!cancelled) setLoadError(err.message || "Failed to load field inventory.");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [
    deferredQuery,
    typeFilter,
    fieldOrigin,
    findingsFilter,
    sortBy,
    page,
    pageSize,
    projectUsageFilter,
    hasDescription,
    duplicateNamesOnly,
    deferredMinIssues,
    deferredMaxIssues,
    deferredMinActiveProjects,
    deferredMaxActiveProjects,
    deferredMinContexts,
    deferredMaxContexts,
  ]);

  function openField(fieldId) {
    if (openFieldId === fieldId) { setOpenFieldId(null); return; }
    setOpenFieldId(fieldId);
    setDetailError("");
    if (!fieldDetails[fieldId]) {
      setDetailLoading(true);
      invoke("getFieldDetails", { fieldId, usagePage: 1 }).then((result) => {
        setFieldDetails((prev) => ({ ...prev, [fieldId]: result }));
      }).catch((err) => {
        setDetailError(err.message || "Failed to load field details.");
      }).finally(() => setDetailLoading(false));
    }
  }

  function loadDetailPage(fieldId, pg) {
    setDetailLoading(true);
    invoke("getFieldDetails", { fieldId, usagePage: pg }).then((result) => {
      setFieldDetails((prev) => ({ ...prev, [fieldId]: result }));
    }).catch((err) => {
      setDetailError(err.message || "Failed to load.");
    }).finally(() => setDetailLoading(false));
  }

  function refreshProjectUsage(fieldId, pg) {
    loadDetailPage(fieldId, pg);
  }

  const [selectingAll, setSelectingAll] = React.useState(false);

  async function selectAllFiltered() {
    setSelectingAll(true);
    try {
      const result = await invoke("getFilteredFieldIds", {
        query: deferredQuery,
        type: typeFilter,
        fieldOrigin,
        findingsFilter,
        sortBy,
        projectUsageFilter,
        hasDescription,
        duplicateNamesOnly,
        minIssuesWithValue: deferredMinIssues,
        maxIssuesWithValue: deferredMaxIssues,
        minActiveProjects: deferredMinActiveProjects,
        maxActiveProjects: deferredMaxActiveProjects,
        minContexts: deferredMinContexts,
        maxContexts: deferredMaxContexts,
      });
      onSetSelectedFieldIds?.(result.fieldIds || []);
    } catch {
      // silently fail — user can select manually
    } finally {
      setSelectingAll(false);
    }
  }

  const activeFilterCount = React.useMemo(() => {
    let count = 0;
    if (typeFilter !== "all") count++;
    if (fieldOrigin !== "all") count++;
    if (projectUsageFilter !== "all") count++;
    if (hasDescription !== "all") count++;
    if (duplicateNamesOnly === true) count++;
    if (minIssues !== "") count++;
    if (maxIssues !== "") count++;
    if (minActiveProjects !== "") count++;
    if (maxActiveProjects !== "") count++;
    if (minContexts !== "") count++;
    if (maxContexts !== "") count++;
    return count;
  }, [
    typeFilter,
    fieldOrigin,
    projectUsageFilter,
    hasDescription,
    duplicateNamesOnly,
    minIssues,
    maxIssues,
    minActiveProjects,
    maxActiveProjects,
    minContexts,
    maxContexts,
  ]);

  function clearAllFilters() {
    setTypeFilter("all");
    setFieldOrigin("all");
    setProjectUsageFilter("all");
    setHasDescription("all");
    setDuplicateNamesOnly(false);
    setMinIssues("");
    setMaxIssues("");
    setMinActiveProjects("");
    setMaxActiveProjects("");
    setMinContexts("");
    setMaxContexts("");
    setDeferredMinIssues("");
    setDeferredMaxIssues("");
    setDeferredMinActiveProjects("");
    setDeferredMaxActiveProjects("");
    setDeferredMinContexts("");
    setDeferredMaxContexts("");
    setQuery("");
    setDeferredQuery("");
    setFindingsFilter("all");
    setPage(1);
  }

  const fields = data?.fields || [];
  const totalPages = data?.totalPages || 1;
  const total = data?.total || 0;
  const availableTypes = data?.availableTypes || [];
  const summary = data?.findingsSummary || { adminAttention: 0, risky: 0, cleanup: 0, standardize: 0 };

  const startItem = total > 0 ? (page - 1) * pageSize + 1 : 0;
  const endItem = Math.min(page * pageSize, total);

  const findingsChips = [
    { key: "all", label: "All fields" },
    { key: "admin-attention", label: "Admin attention", count: summary.adminAttention },
    { key: "risky", label: "Risk", count: summary.risky },
    { key: "cleanup", label: "Cleanup", count: summary.cleanup },
    { key: "standardize", label: "Standardize", count: summary.standardize },
  ];

  function PaginationBar({ top }) {
    return (
      <div className={`admin-field-browser__pagebar${top ? " admin-field-browser__pagebar--top" : ""}`}>
        <span className="admin-pagination__info">
          {total > 0
            ? `Showing ${startItem}–${endItem} of ${total.toLocaleString()} fields`
            : loading ? "Loading…" : "No fields match the current filter"}
        </span>
        {top && (
          <div className="admin-field-browser__pagesize">
            <span>Per page:</span>
            {[10, 25, 50].map((n) => (
              <button
                key={n}
                type="button"
                className={`admin-field-browser__pagesize-btn${pageSize === n ? " admin-field-browser__pagesize-btn--active" : ""}`}
                onClick={() => { localStorage.setItem("admin-field-pagesize", n); setPageSize(n); setPage(1); }}
              >{n}</button>
            ))}
          </div>
        )}
        <div className="admin-field-browser__page-nav">
          <button disabled={page <= 1} className="secondary-button secondary-button--small" type="button" onClick={() => setPage(1)}>First</button>
          <button disabled={page <= 1} className="secondary-button secondary-button--small" type="button" onClick={() => setPage((p) => p - 1)}>Previous</button>
          <button disabled={page >= totalPages} className="secondary-button secondary-button--small" type="button" onClick={() => setPage((p) => p + 1)}>Next</button>
          <button disabled={page >= totalPages} className="secondary-button secondary-button--small" type="button" onClick={() => setPage(totalPages)}>Last</button>
        </div>
      </div>
    );
  }

  // Build active filter chips list
  const activeFilterChips = React.useMemo(() => {
    const chips = [];
    if (fieldOrigin !== "all") {
      const label = fieldOrigin === "user-created" ? "User-created" : "Jira built-in";
      chips.push({ id: "fieldOrigin", label: `Origin: ${label}`, clear: () => { setFieldOrigin("all"); setPage(1); } });
    }
    if (projectUsageFilter !== "all") {
      const labels = { "not-built": "not-built", "built": "built", "building": "building", "incomplete": "incomplete" };
      chips.push({ id: "projectUsageFilter", label: `Build: ${labels[projectUsageFilter] || projectUsageFilter}`, clear: () => { setProjectUsageFilter("all"); setPage(1); } });
    }
    if (hasDescription !== "all") {
      chips.push({ id: "hasDescription", label: `Has description: ${hasDescription === "yes" ? "Yes" : "No"}`, clear: () => { setHasDescription("all"); setPage(1); } });
    }
    if (duplicateNamesOnly) {
      chips.push({ id: "duplicateNamesOnly", label: "Duplicate names only", clear: () => { setDuplicateNamesOnly(false); setPage(1); } });
    }
    if (minIssues !== "" || maxIssues !== "") {
      const range = [minIssues || "0", maxIssues || "∞"].join("–");
      chips.push({ id: "issues", label: `Issues: ${range}`, clear: () => { setMinIssues(""); setMaxIssues(""); setPage(1); } });
    }
    if (minActiveProjects !== "" || maxActiveProjects !== "") {
      const range = [minActiveProjects || "0", maxActiveProjects || "∞"].join("–");
      chips.push({ id: "activeProjects", label: `Active projects: ${range}`, clear: () => { setMinActiveProjects(""); setMaxActiveProjects(""); setPage(1); } });
    }
    if (minContexts !== "" || maxContexts !== "") {
      const range = [minContexts || "0", maxContexts || "∞"].join("–");
      chips.push({ id: "contexts", label: `Contexts: ${range}`, clear: () => { setMinContexts(""); setMaxContexts(""); setPage(1); } });
    }
    if (findingsFilter !== "all") {
      chips.push({ id: "findingsFilter", label: `Findings: Admin attention`, clear: () => { setFindingsFilter("all"); setPage(1); } });
    }
    return chips;
  }, [fieldOrigin, projectUsageFilter, hasDescription, duplicateNamesOnly, minIssues, maxIssues, minActiveProjects, maxActiveProjects, minContexts, maxContexts, findingsFilter]);

  return (
    <div className="admin-field-browser">
      {/* Primary toolbar */}
      <div className="admin-field-browser__toolbar">
        <input
          type="search"
          placeholder="Field name, ID, or description…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="admin-jobs-search"
          aria-label="Search fields"
        />
        <select
          aria-label="Field type"
          value={typeFilter}
          onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
        >
          <option value="all">All types</option>
          {availableTypes.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select
          aria-label="Sort by"
          value={sortBy}
          onChange={(e) => { setSortBy(e.target.value); setPage(1); }}
        >
          <option value="name-asc">Name A–Z</option>
          <option value="name-desc">Name Z–A</option>
          <option value="usage-desc">Most issues with value</option>
          <option value="usage-asc">Fewest issues with value</option>
          <option value="active-projects-desc">Most active projects</option>
          <option value="active-projects-asc">Fewest active projects</option>
          <option value="contexts-desc">Most contexts</option>
          <option value="contexts-asc">Fewest contexts</option>
          <option value="priority-desc">Highest priority</option>
        </select>
        <div className="admin-field-browser__filter-anchor" ref={filterPanelRef}>
          <button
            type="button"
            className={`admin-field-browser__filter-toggle${filtersOpen ? " admin-field-browser__filter-toggle--active" : ""}`}
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
          >
            Filters
            {activeFilterCount > 0 && (
              <span className="admin-field-browser__filter-badge">{activeFilterCount}</span>
            )}
          </button>

          {/* Floating filter popover */}
          {filtersOpen && (
            <div className="admin-field-browser__filter-panel">
              <div className="admin-field-browser__filter-group">
                <span className="admin-field-browser__filter-group-label">Origin &amp; status</span>
                <div className="admin-field-browser__filter-group-controls">
                  <select
                    aria-label="Field origin"
                    value={fieldOrigin}
                    onChange={(e) => { setFieldOrigin(e.target.value); setPage(1); }}
                  >
                    <option value="all">All fields</option>
                    <option value="user-created">User-created</option>
                    <option value="jira-builtin">Jira built-in</option>
                  </select>
                  <select
                    aria-label="Project usage build status"
                    value={projectUsageFilter}
                    onChange={(e) => { setProjectUsageFilter(e.target.value); setPage(1); }}
                  >
                    <option value="all">Any build status</option>
                    <option value="not-built">Not built</option>
                    <option value="built">Built</option>
                    <option value="building">Building</option>
                    <option value="incomplete">Incomplete</option>
                  </select>
                  <select
                    aria-label="Has description"
                    value={hasDescription}
                    onChange={(e) => { setHasDescription(e.target.value); setPage(1); }}
                  >
                    <option value="all">Description: any</option>
                    <option value="yes">Has description</option>
                    <option value="no">No description</option>
                  </select>
                  <label className="admin-field-browser__checkbox-label">
                    <input
                      type="checkbox"
                      checked={duplicateNamesOnly}
                      onChange={(e) => { setDuplicateNamesOnly(e.target.checked); setPage(1); }}
                    />
                    Duplicate names only
                  </label>
                </div>
              </div>

              <div className="admin-field-browser__filter-group">
                <span className="admin-field-browser__filter-group-label">Issues with value</span>
                <div className="admin-field-browser__range-inputs">
                  <input
                    type="number"
                    min="0"
                    placeholder="Min"
                    aria-label="Minimum issues with value"
                    value={minIssues}
                    onChange={(e) => setMinIssues(e.target.value)}
                  />
                  <span className="admin-field-browser__range-sep">–</span>
                  <input
                    type="number"
                    min="0"
                    placeholder="Max"
                    aria-label="Maximum issues with value"
                    value={maxIssues}
                    onChange={(e) => setMaxIssues(e.target.value)}
                  />
                </div>
              </div>

              <div className="admin-field-browser__filter-group">
                <span className="admin-field-browser__filter-group-label">Active projects</span>
                <div className="admin-field-browser__range-inputs">
                  <input
                    type="number"
                    min="0"
                    placeholder="Min"
                    aria-label="Minimum active projects"
                    value={minActiveProjects}
                    onChange={(e) => setMinActiveProjects(e.target.value)}
                  />
                  <span className="admin-field-browser__range-sep">–</span>
                  <input
                    type="number"
                    min="0"
                    placeholder="Max"
                    aria-label="Maximum active projects"
                    value={maxActiveProjects}
                    onChange={(e) => setMaxActiveProjects(e.target.value)}
                  />
                </div>
              </div>

              <div className="admin-field-browser__filter-group">
                <span className="admin-field-browser__filter-group-label">Contexts</span>
                <div className="admin-field-browser__range-inputs">
                  <input
                    type="number"
                    min="0"
                    placeholder="Min"
                    aria-label="Minimum contexts"
                    value={minContexts}
                    onChange={(e) => setMinContexts(e.target.value)}
                  />
                  <span className="admin-field-browser__range-sep">–</span>
                  <input
                    type="number"
                    min="0"
                    placeholder="Max"
                    aria-label="Maximum contexts"
                    value={maxContexts}
                    onChange={(e) => setMaxContexts(e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
        {activeFilterCount > 0 && (
          <button
            type="button"
            className="admin-field-browser__clear-filters"
            onClick={clearAllFilters}
          >
            Clear all
          </button>
        )}
      </div>

      {/* Active filter chips */}
      {activeFilterChips.length > 0 && (
        <div className="admin-field-browser__active-filters">
          {activeFilterChips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className="admin-field-browser__filter-chip"
              onClick={chip.clear}
            >
              <span>{chip.label}</span>
              <span className="admin-field-browser__filter-chip__remove">×</span>
            </button>
          ))}
        </div>
      )}

      {/* Findings filter chips */}
      <div className="findings-filter-bar" style={{ marginTop: 4 }}>
        {findingsChips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            className={`findings-filter-button${findingsFilter === chip.key ? " findings-filter-button--active" : ""}`}
            onClick={() => { setFindingsFilter(chip.key); setPage(1); }}
          >
            <span>{chip.label}</span>
            {typeof chip.count === "number" ? <strong>{chip.count}</strong> : null}
          </button>
        ))}
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      <div className="admin-field-browser__report-bar">
        <span className="admin-field-browser__report-selection">
          {selectedFieldIds.length > 0
            ? `${selectedFieldIds.length} ${selectedFieldIds.length === 1 ? "field" : "fields"} selected for report`
            : "No fields selected"}
        </span>
        <div className="admin-field-browser__report-actions">
          <button
            className="secondary-button secondary-button--small"
            type="button"
            onClick={selectAllFiltered}
            disabled={selectingAll || loading || !total}
          >
            {selectingAll ? "Selecting…" : "Select filtered"}
          </button>
          {selectedFieldIds.length > 0 && (
            <button
              className="secondary-button secondary-button--small"
              type="button"
              onClick={() => onSetSelectedFieldIds?.([])}
            >
              Clear
            </button>
          )}
          <button
            className="primary-button"
            type="button"
            onClick={onGoToReport}
            disabled={!selectedFieldIds.length}
          >
            <Icon name="barChart" size={13} />
            {`Generate report (${selectedFieldIds.length})`}
          </button>
        </div>
      </div>

      <PaginationBar top />

      {loading && !fields.length ? (
        <div className="empty-state">Loading fields…</div>
      ) : fields.length === 0 && !loading ? (
        <div className="empty-state">No fields match the current filter.</div>
      ) : (
        <div className="admin-field-list">
          {fields.map((field) => {
            const isOpen = openFieldId === field.id;
            const detail = fieldDetails[field.id] || null;
            return (
              <FieldCard
                key={field.id}
                field={field}
                details={isOpen ? detail : null}
                expanded={isOpen}
                loading={isOpen && detailLoading && !detail}
                selected={selectedSet.has(field.id)}
                onSelectChange={(id, checked) => onToggleField?.(id, checked)}
                onToggle={() => openField(field.id)}
                onProjectUsagePageChange={loadDetailPage}
                onRefreshProjectUsage={refreshProjectUsage}
                // Positional arguments, NOT a wrapper object. buildReportRovoPrompt in the
                // same module does take a destructured object, and passing one here
                // instead produced a prompt reading "Field id: undefined. Field name:
                // undefined" with every count zeroed -- the field object ended up bound to
                // the `field` parameter's own `field` property, and `details` to nothing.
                // Rovo then answered confidently about a nonexistent "ghost field".
                onAskField={() => {
                  openFieldExpertRovo(buildFieldRovoPrompt(field, fieldDetails[field.id])).catch(() => {});
                }}
                onAskProject={(project) => {
                  openFieldExpertRovo(buildProjectRovoPrompt(field, fieldDetails[field.id], project)).catch(() => {});
                }}
                siteOrigin={siteOrigin}
                rovoEnabled={rovoEnabled}
              />
            );
          })}
        </div>
      )}

      {total > 0 && <PaginationBar />}
    </div>
  );
}

// ── Reports tab (self-contained) ──────────────────────────────────────────

function ReportsTab({ siteOrigin, selectedFieldIds, onSetSelectedFieldIds, autoGenerate, onAutoGenerateConsumed }) {
  const [reportData, setReportData] = React.useState(null);
  const [loadingReport, setLoadingReport] = React.useState(false);
  const [savedReports, setSavedReports] = React.useState([]);
  const [reportNameInput, setReportNameInput] = React.useState("");
  const [activeReportName, setActiveReportName] = React.useState("");
  const [savingReport, setSavingReport] = React.useState(false);
  const [deletingReportId, setDeletingReportId] = React.useState("");
  const [error, setError] = React.useState("");
  const [rovoEnabled, setRovoEnabled] = React.useState(false);

  React.useEffect(() => {
    invoke("getSavedReports").then((r) => setSavedReports(r.reports || [])).catch(() => {});
    view.getContext().then(() => setRovoEnabled(true)).catch(() => {});
  }, []);

  React.useEffect(() => {
    if (autoGenerate && selectedFieldIds.length) {
      onAutoGenerateConsumed?.();
      generateReport();
    }
  }, [autoGenerate]);

  async function generateReport(fieldIdsOverride = null, nameOverride = "") {
    const fieldIds = fieldIdsOverride?.length ? fieldIdsOverride : selectedFieldIds;
    if (!fieldIds.length) { setError("Select at least one field in the Field Browser to generate a report."); return; }
    setLoadingReport(true);
    setReportData(null);
    try {
      const nextName = nameOverride || reportNameInput.trim() || "Project Usage Report";
      setActiveReportName(nextName);
      const result = await invoke("getProjectUsageReport", { fieldIds });
      setReportData(result);
    } catch (err) {
      setError(err.message || "Failed to generate report.");
    } finally {
      setLoadingReport(false);
    }
  }

  async function saveCurrentReport() {
    if (!reportNameInput.trim()) { setError("Enter a report name before saving."); return; }
    setSavingReport(true);
    try {
      const existing = savedReports.find((r) => r.name.toLowerCase() === reportNameInput.trim().toLowerCase());
      const result = await invoke("saveReportDefinition", { reportId: existing?.reportId || "", name: reportNameInput.trim(), fieldIds: selectedFieldIds });
      setSavedReports(result.reports || []);
      setActiveReportName(reportNameInput.trim());
    } catch (err) {
      setError(err.message || "Failed to save report.");
    } finally {
      setSavingReport(false);
    }
  }

  async function loadSavedReport(report) {
    onSetSelectedFieldIds(report.fieldIds || []);
    setReportNameInput(report.name || "");
    await generateReport(report.fieldIds || [], report.name || "");
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

  function exportCsv(overrideData = null) {
    const exportData = overrideData || reportData;
    if (!exportData?.fields?.length) { setError("No report data available to export."); return; }
    const header = ["Field ID", "Field Name", ...exportData.projects.map((p) => p.projectKey)];
    const rows = [];
    // Second header row, only when workflow data exists. The export is a field x project
    // matrix, so putting each project's scheme directly under its column is what makes
    // the correlation readable: columns sharing a scheme are meant to run the same
    // process, and a field populated in one but not the others is the signal.
    if (exportData.projects.some((p) => p.workflowSchemeName)) {
      rows.push(["", "Workflow scheme", ...exportData.projects.map((p) => p.workflowSchemeName || "")]);
    }
    for (const group of groupReportFieldsByType(exportData.fields)) {
      rows.push([`${group.fieldType.toUpperCase()} FIELDS`, "", ...exportData.projects.map(() => "")]);
      for (const field of group.fields) {
        const cellByProjectId = new Map(field.projects.map((p) => [p.projectId, p]));
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

  async function askRovo({ fields, projects, pendingFields, reportSummary }) {
    try {
      await openFieldExpertRovo(buildReportRovoPrompt({ reportName: activeReportName, fields, projects, pendingFields, reportSummary }));
    } catch (err) {
      setError(err.message || "Failed to open Rovo.");
    }
  }

  return (
    <div className="admin-reports-tab">
      {error && <div className="error-banner" style={{ margin: "0 0 12px 0" }}>{error}<button className="inline-text-button" type="button" onClick={() => setError("")} style={{ marginLeft: 10 }}>Dismiss</button></div>}
      <div className="admin-reports-toolbar">
        <span className="admin-reports-toolbar__hint">Select fields in the Field Browser tab to build a report.</span>
        <button
          className="primary-button"
          type="button"
          onClick={() => generateReport()}
          disabled={loadingReport || !selectedFieldIds.length}
        >
          <Icon name="barChart" size={14} />
          {loadingReport ? "Generating…" : `Generate report (${selectedFieldIds.length} fields)`}
        </button>
      </div>
      <ReportErrorBoundary resetKey={`${activeReportName}-${selectedFieldIds.join(",")}`}>
        <ProjectUsageReportView
          reportData={reportData}
          reportName={activeReportName}
          reportJob={loadingReport ? { status: "building", processedFields: 0, totalFields: selectedFieldIds.length, percentComplete: 0 } : null}
          siteOrigin={siteOrigin}
          onExportCsv={exportCsv}
          onAskReport={askRovo}
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
    </div>
  );
}

// ── Scan components ───────────────────────────────────────────────────────

function SubNavLayout({ items, activeKey, onSelect, children }) {
  return (
    <div className="sub-nav-layout">
      <nav className="sub-nav" aria-label="Section navigation">
        {items.map(({ key, label, icon, badge }) => (
          <button
            key={key}
            type="button"
            className={`sub-nav__item ${activeKey === key ? "sub-nav__item--active" : ""}`}
            onClick={() => onSelect(key)}
          >
            {icon && <Icon name={icon} size={14} />}
            <span>{label}</span>
            {badge != null && <span className="sub-nav__badge">{badge}</span>}
          </button>
        ))}
      </nav>
      <div className="sub-nav__panel">
        {children}
      </div>
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
            <Icon name={open ? "x" : "activity"} size={16} />
          </span>
        </div>
      </button>
      {open ? <div className="activity-section__body">{children}</div> : null}
    </section>
  );
}

// Must match CLEAR_SNAPSHOT_CONFIRMATION in src/resolvers.js. The admin bundle is built
// separately from the backend so this cannot be imported; the server re-checks it anyway,
// which means a drift here shows up as "confirmation did not match" rather than as an
// accidental deletion.
const CLEAR_CONFIRMATION_WORD = "DELETE";

// Type-to-confirm rather than a plain OK dialog. This is the one irreversible action in
// the app, and a single mis-click should not be able to destroy a snapshot that took
// hours to build on a large site.
export function ClearSnapshotControl({ onCleared }) {
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  const [clearing, setClearing] = React.useState(false);
  const [result, setResult] = React.useState(null);
  const [error, setError] = React.useState(null);

  const confirmed = typed.trim() === CLEAR_CONFIRMATION_WORD;

  function reset() {
    setOpen(false);
    setTyped("");
    setError(null);
  }

  async function handleClear() {
    if (!confirmed || clearing) return;
    setClearing(true);
    setError(null);
    try {
      const response = await invoke("clearSnapshot", { confirmation: typed.trim() });
      if (!response?.cleared) {
        setError(response?.error || "Clear failed.");
        return;
      }
      setResult(response);
      reset();
      if (onCleared) await onCleared();
    } catch (err) {
      setError(err?.message || "Clear failed.");
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="danger-zone">
      <div className="danger-zone__header">
        <Icon name="alertTriangle" size={13} />
        <span className="danger-zone__title">Danger zone</span>
      </div>

      {result && !open && (
        <div className="danger-zone__result" role="status">
          Snapshot data cleared — {result.totalRowsDeleted.toLocaleString()} rows removed. Build a new snapshot to repopulate.
        </div>
      )}

      {!open ? (
        <div className="danger-zone__row">
          <p className="danger-zone__desc">
            Delete all indexed field data and start over. Use this to recover from a corrupted
            snapshot, or to purge site data on request.
          </p>
          <button className="danger-button" type="button" onClick={() => { setOpen(true); setResult(null); }}>
            Clear snapshot data
          </button>
        </div>
      ) : (
        <div className="danger-zone__confirm">
          <p className="danger-zone__desc">
            This permanently deletes the field catalog, per-project usage, field summaries,
            cached options, issue scan state and report job history. A full rebuild will be
            required, which can take hours on a large site.
          </p>
          <p className="danger-zone__desc danger-zone__desc--muted">
            Saved reports, workflow data and the RQT index are not affected.
          </p>

          <label className="danger-zone__label" htmlFor="clear-confirm-input">
            Type <strong>{CLEAR_CONFIRMATION_WORD}</strong> to confirm
          </label>
          <div className="danger-zone__row">
            <input
              id="clear-confirm-input"
              className="danger-zone__input"
              type="text"
              value={typed}
              autoComplete="off"
              disabled={clearing}
              placeholder={CLEAR_CONFIRMATION_WORD}
              onChange={(e) => setTyped(e.target.value)}
            />
            <button className="secondary-button" type="button" onClick={reset} disabled={clearing}>
              Cancel
            </button>
            <button
              className="danger-button"
              type="button"
              onClick={handleClear}
              disabled={!confirmed || clearing}
            >
              {clearing ? "Clearing…" : "Clear everything"}
            </button>
          </div>
        </div>
      )}

      {error && <div className="danger-zone__error" role="alert">{error}</div>}
    </div>
  );
}

function SnapshotPanel({ snapshot, onBuildSnapshot, buildingSnapshot, onRefresh, refreshingOverview, onCleared }) {
  if (!snapshot) {
    return <div className="empty-state">Loading snapshot status…</div>;
  }

  const snapshotStateLabel = {
    idle: "No snapshot",
    queued: "Queued",
    building: "Building…",
    ready: "Ready",
    failed: "Failed",
  }[snapshot.state] || snapshot.state;

  const isActive = snapshot.state === "building" || snapshot.state === "queued";
  // A build stuck in "building" past the server's own stale threshold (see
  // requeueStaleSnapshotBuild) would otherwise leave this button permanently disabled
  // with no way to unstick it short of waiting for the next daily auto-check — mirror
  // Universe Scan's "Force resume" affordance so an admin can force it immediately.
  const STALE_BUILD_MS = 20 * 60 * 1000;
  const isStaleBuild = isActive && snapshot.state === "building" && snapshot.startedAt
    && (Date.now() - new Date(snapshot.startedAt).getTime() > STALE_BUILD_MS);
  const chipVariant = { ready: "ready", building: "building", queued: "queued" }[snapshot.state] || "idle";

  return (
    <div className="admin-snapshot-card">
      <div className="admin-snapshot-card__header">
        <div className="admin-snapshot-card__meta">
          <span className={`snapshot-chip snapshot-chip--${chipVariant}`}>
            <span className="snapshot-chip__dot" />
            {snapshotStateLabel}
          </span>
          {snapshot.refreshedAt && (
            <span className="admin-snapshot-card__age">Last built {formatRelativeTime(snapshot.refreshedAt)} · {formatTimestamp(snapshot.refreshedAt)}</span>
          )}
          {snapshot.totalFields > 0 && (
            <span className="admin-snapshot-card__count">{snapshot.totalFields.toLocaleString()} fields indexed</span>
          )}
          {snapshot.startedAt && isActive && (
            <span className="admin-snapshot-card__age">Started {formatRelativeTime(snapshot.startedAt)}</span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="secondary-button"
            type="button"
            onClick={onRefresh}
            disabled={refreshingOverview}
            title="Refresh snapshot status"
          >
            <Icon name="refreshCw" size={13} />
            {refreshingOverview ? "…" : "Refresh"}
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={onBuildSnapshot}
            disabled={buildingSnapshot || (isActive && !isStaleBuild)}
            title={isStaleBuild ? "This build has been stalled for over 20 minutes — click to force it to resume from checkpoint" : undefined}
          >
            <Icon name="refreshCw" size={14} />
            {isStaleBuild ? "Force resume (stalled)" : isActive ? "Building…" : "Build new snapshot"}
          </button>
        </div>
      </div>

      {isActive && (
        <div className="status-progress admin-snapshot-progress">
          <div className="status-progress__meta">
            <strong>{snapshot.percent}%</strong>
            <span>{(snapshot.processedFields || 0).toLocaleString()} / {(snapshot.totalFields || 0).toLocaleString()} fields</span>
          </div>
          <div className="status-progress__bar">
            <span style={{ width: `${snapshot.percent}%`, background: snapshot.state === "queued" ? "var(--warm)" : "var(--cool)" }} />
          </div>
        </div>
      )}

      {snapshot.lastError && (
        <div className="admin-snapshot-error">
          <Icon name="alertTriangle" size={13} /> {snapshot.lastError}
        </div>
      )}

      <SnapshotLog entries={snapshot.progressLog} />

      <ClearSnapshotControl onCleared={onCleared} />
    </div>
  );
}

function DeltaIssueScanPanel({ deltaIssueScan, onStartDelta, issueScanDeltaStarting }) {
  const deltaActive = deltaIssueScan?.state === "building" || deltaIssueScan?.state === "queued";
  const deltaReady = deltaIssueScan?.state === "ready";
  const deltaFailed = deltaIssueScan?.state === "failed";
  const deltaPercent = deltaIssueScan?.totalIssues > 0 ? Math.min(100, Math.round((Number(deltaIssueScan.processedIssues || 0) / Number(deltaIssueScan.totalIssues)) * 100)) : 0;
  return (
    <div className="delta-scan-panel">
      <div className="delta-scan-panel__header">
        <span className="delta-scan-panel__title">Quick Scan (24h)</span>
        {deltaReady && deltaIssueScan?.completedAt && (
          <span className="delta-scan-panel__done">Last ran {formatShortTime(deltaIssueScan.completedAt)} · {(deltaIssueScan.processedIssues || 0).toLocaleString()} issues{deltaIssueScan.fieldProjectPairsUpdated > 0 ? ` · ${deltaIssueScan.fieldProjectPairsUpdated.toLocaleString()} pairs updated` : ""}</span>
        )}
      </div>
      <p className="delta-scan-panel__desc">Scans issues created or updated in the last 24h, refreshes field usage counts for all touched field×project pairs. Runs automatically after each full scan and inventory snapshot.</p>
      {deltaActive && (
        <div className="delta-scan-panel__progress">
          <div className="issue-scan-panel__bar-track"><div className="issue-scan-panel__bar-fill" style={{ width: `${deltaPercent}%` }} /></div>
          <div className="issue-scan-panel__status">{deltaIssueScan?.state === "queued" ? "Queued..." : `${deltaPercent}% — ${(deltaIssueScan?.processedIssues || 0).toLocaleString()} of ${(deltaIssueScan?.totalIssues || 0).toLocaleString()} issues`}</div>
        </div>
      )}
      {deltaFailed && deltaIssueScan?.lastError && <div className="issue-scan-panel__error">{deltaIssueScan.lastError}</div>}
      <div className="delta-scan-panel__actions">
        <button className="secondary-button secondary-button--small" type="button" onClick={onStartDelta} disabled={issueScanDeltaStarting || deltaActive}>
          {issueScanDeltaStarting || deltaActive ? "Running..." : "Run quick scan"}
        </button>
      </div>
    </div>
  );
}

function ScanProgressChart({ data }) {
  if (data.length < 2) {
    return <div className="scan-chart-card__empty">{data.length === 0 ? "No progress data yet" : "Running…"}</div>;
  }
  const W = 480, H = 130, P = { t: 12, r: 16, b: 22, l: 52 };
  const cW = W - P.l - P.r, cH = H - P.t - P.b;
  const minT = data[0].t, maxT = data[data.length - 1].t, maxV = Math.max(...data.map(d => d.count));
  const xS = t => (maxT > minT ? (t - minT) / (maxT - minT) : 0.5) * cW;
  const yS = v => cH - (v / (maxV || 1)) * cH;
  const pathD = data.map((d, i) => `${i === 0 ? "M" : "L"} ${xS(d.t).toFixed(1)} ${yS(d.count).toFixed(1)}`).join(" ");
  const areaD = `${pathD} L ${xS(data[data.length - 1].t).toFixed(1)} ${cH} L 0 ${cH} Z`;
  const yTicks = [0, 0.5, 1].map(r => ({
    y: yS(maxV * r),
    label: maxV * r >= 1000 ? `${Math.round(maxV * r / 1000)}k` : String(Math.round(maxV * r)),
  }));
  const xTicks = [data[0], data[Math.floor((data.length - 1) / 2)], data[data.length - 1]];
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block", overflow: "visible" }}>
      <defs>
        <linearGradient id="sp-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#79b8ff" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#79b8ff" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <g transform={`translate(${P.l},${P.t})`}>
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={0} y1={t.y} x2={cW} y2={t.y} stroke="var(--stroke)" strokeDasharray="3 5" />
            <text x={-6} y={t.y + 4} textAnchor="end" fontSize="9" fill="var(--muted)">{t.label}</text>
          </g>
        ))}
        <path d={areaD} fill="url(#sp-grad)" />
        <path d={pathD} fill="none" stroke="#79b8ff" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={xS(data[data.length - 1].t)} cy={yS(data[data.length - 1].count)} r={3.5} fill="#79b8ff" />
        {xTicks.map((d, i) => (
          <text key={i} x={xS(d.t)} y={cH + 14} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} fontSize="9" fill="var(--muted)">{d.label}</text>
        ))}
      </g>
    </svg>
  );
}

function ScanHistoryChart({ data }) {
  if (data.length === 0) {
    return <div className="scan-chart-card__empty">No completed scan runs recorded yet</div>;
  }
  const W = 480, H = 130, P = { t: 12, r: 16, b: 22, l: 52 };
  const cW = W - P.l - P.r, cH = H - P.t - P.b;
  const maxV = Math.max(...data.map(d => d.issues), 1);
  const step = cW / Math.max(data.length, 1);
  const barW = Math.max(4, step * 0.7);
  const yTicks = [0, 0.5, 1].map(r => ({
    y: cH - r * cH,
    label: maxV * r >= 1000 ? `${Math.round(maxV * r / 1000)}k` : String(Math.round(maxV * r)),
  }));
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block", overflow: "visible" }}>
      <g transform={`translate(${P.l},${P.t})`}>
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={0} y1={t.y} x2={cW} y2={t.y} stroke="var(--stroke)" strokeDasharray="3 5" />
            <text x={-6} y={t.y + 4} textAnchor="end" fontSize="9" fill="var(--muted)">{t.label}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const h = Math.max(2, (d.issues / maxV) * cH);
          const x = step * i + (step - barW) / 2;
          const opacity = 0.35 + (d.issues / maxV) * 0.55;
          return (
            <g key={i}>
              <rect x={x} y={cH - h} width={barW} height={h} rx="2" fill={`rgba(126,200,164,${opacity.toFixed(2)})`} />
              <text x={x + barW / 2} y={cH + 14} textAnchor="middle" fontSize="9" fill="var(--muted)">{d.label}</text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function UniverseScanPanel({ issueScan, onStart, onResume, onCancel, issueScanLoading, issueScanResuming, issueScanCancelling }) {
  const [logSearch, setLogSearch] = React.useState("");

  const scanActive = issueScan?.state === "building" || issueScan?.state === "queued";
  const scanDone = issueScan?.state === "ready";
  const scanFailed = issueScan?.state === "failed";
  const scanCancelled = issueScan?.state === "cancelled";
  const lastScanLogAt = issueScan?.progressLog?.length ? issueScan.progressLog[issueScan.progressLog.length - 1]?.t : issueScan?.startedAt;
  const scanStale = lastScanLogAt ? (Date.now() - new Date(lastScanLogAt).getTime()) > 10 * 60 * 1000 : scanActive;
  const canResume = issueScan && !scanDone && ((scanActive && scanStale) || scanFailed || scanCancelled);
  const canForceResume = scanActive && scanStale;
  const processedIssues = Number(issueScan?.processedIssues || 0);
  const processedProjects = Number(issueScan?.processedPages || 0);
  const totalProjects = Number(issueScan?.totalPages || 0);
  const scanPercent = totalProjects > 0 ? Math.min(100, Math.round(processedProjects / totalProjects * 100)) : 0;
  const elapsed = useLiveDuration(scanActive ? issueScan?.startedAt : null);

  const durationMs = React.useMemo(() => {
    if (!issueScan?.startedAt || !issueScan?.completedAt) return null;
    return new Date(issueScan.completedAt).getTime() - new Date(issueScan.startedAt).getTime();
  }, [issueScan?.startedAt, issueScan?.completedAt]);

  const durationLabel = React.useMemo(() => {
    if (!durationMs) return null;
    const totalSec = Math.round(durationMs / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }, [durationMs]);

  const scanRate = React.useMemo(() => {
    if (!durationMs || !processedIssues) return null;
    return Math.round(processedIssues / (durationMs / 1000));
  }, [durationMs, processedIssues]);

  const etaLabel = React.useMemo(() => {
    if (!scanActive) return null;
    const done = Number(issueScan?.processedPages || 0);
    const total = Number(issueScan?.totalPages || 0);
    if (done < 1 || total <= done) return null;
    const startMs = issueScan?.startedAt ? new Date(issueScan.startedAt).getTime() : 0;
    if (!startMs) return null;
    const elapsedSec = (Date.now() - startMs) / 1000;
    const rate = done / elapsedSec;
    if (rate <= 0) return null;
    const remainingSec = Math.round((total - done) / rate);
    const m = Math.floor(remainingSec / 60), s = remainingSec % 60;
    return m > 0 ? `~${m}m ${s}s remaining` : `~${s}s remaining`;
  }, [scanActive, issueScan?.processedPages, issueScan?.totalPages, issueScan?.startedAt, elapsed]);

  // Current run's entries newest-first (for count / search)
  const currentEntries = React.useMemo(
    () => (issueScan?.progressLog?.length ? [...issueScan.progressLog].reverse() : []),
    [issueScan?.progressLog]
  );

  // All historical runs (newest-first order)
  const scanHistoryRuns = issueScan?.scanHistory || [];

  // Total log entry count across all runs
  const totalLogCount = React.useMemo(() => {
    let n = issueScan?.progressLog?.length || 0;
    for (const run of scanHistoryRuns) n += run.progressLog?.length || 0;
    return n;
  }, [issueScan?.progressLog, scanHistoryRuns]);

  // Full multi-run view (run-headers interleaved with log entries), newest first
  const allRunEntries = React.useMemo(() => {
    const result = [];
    if (issueScan?.startedAt || currentEntries.length) {
      result.push({ type: "run-header", key: "current", startedAt: issueScan?.startedAt, completedAt: issueScan?.completedAt, processedIssues: issueScan?.processedIssues || 0, isCurrent: true });
      currentEntries.forEach(e => result.push({ type: "log", ...e }));
    }
    [...scanHistoryRuns].reverse().forEach((run, i) => {
      result.push({ type: "run-header", key: `hist-${i}`, startedAt: run.startedAt, completedAt: run.completedAt, processedIssues: run.processedIssues || 0, isCurrent: false });
      [...(run.progressLog || [])].reverse().forEach(e => result.push({ type: "log", ...e }));
    });
    return result;
  }, [currentEntries, scanHistoryRuns, issueScan?.startedAt, issueScan?.completedAt, issueScan?.processedIssues]);

  // Flat list of all log entries for search
  const flatAllEntries = React.useMemo(() => {
    const entries = [...currentEntries];
    [...scanHistoryRuns].reverse().forEach(run => {
      entries.push(...[...(run.progressLog || [])].reverse());
    });
    return entries;
  }, [currentEntries, scanHistoryRuns]);

  // Filtered view (searching shows flat entries without run separators)
  const filteredEntries = React.useMemo(() => {
    if (!logSearch.trim()) return null;
    const q = logSearch.toLowerCase();
    return flatAllEntries.filter(e => e.msg?.toLowerCase().includes(q) || formatShortTime(e.t).toLowerCase().includes(q));
  }, [flatAllEntries, logSearch]);

  // Chart data: parse current-run log for issue counts over time
  const progressSeries = React.useMemo(() => {
    const entries = issueScan?.progressLog || [];
    const parsed = [];
    for (const entry of entries) {
      const match = entry.msg.match(/^([0-9,]+)(?:\s*\/\s*[0-9,]+)?\s+issues?\s+(?:scanned|on\s+site)/i);
      if (match) {
        parsed.push({ t: new Date(entry.t).getTime(), count: parseInt(match[1].replace(/,/g, ""), 10), label: formatShortTime(entry.t) });
      }
    }
    return parsed;
  }, [issueScan?.progressLog]);

  // Chart data: historical runs bar chart
  const historySeries = React.useMemo(() =>
    scanHistoryRuns.map(run => ({
      issues: run.processedIssues || 0,
      label: run.completedAt ? new Date(run.completedAt).toLocaleDateString([], { month: "short", day: "numeric" }) : "?",
    })),
    [scanHistoryRuns]
  );

  const showCharts = progressSeries.length >= 2 || historySeries.length >= 1;

  const stateClass = scanActive ? "scan-status--active" : scanDone ? "scan-status--done" : scanFailed ? "scan-status--failed" : "scan-status--idle";
  const stateLabel = scanActive ? "Running" : scanDone ? "Complete" : scanFailed ? "Failed" : scanCancelled ? "Cancelled" : "Not started";
  const displayIssues = scanDone ? (issueScan.processedIssues || issueScan.totalIssues || 0) : processedIssues;
  const hasStats = scanDone || scanActive || processedIssues > 0;

  return (
    <div className="universe-scan-panel">
      <div className="universe-scan-panel__head">
        <div className="universe-scan-panel__title-row">
          <h3 className="universe-scan-panel__title">Universe Scan</h3>
          <span className={`scan-status-pill ${stateClass}`}>{stateLabel}</span>
        </div>
        <p className="universe-scan-panel__desc">
          Crawls every issue across all Jira projects in parallel workers to compute per-project field usage counts, detect RQT-pattern values, and build the complete field inventory.
          {issueScan?.completedAt ? ` Last completed ${formatTimestamp(issueScan.completedAt)}.` : ""}
        </p>
      </div>

      {hasStats && (
        <div className="universe-scan-panel__stats">
          <div className="scan-stat-card">
            <div className="scan-stat-card__value">{Number(displayIssues).toLocaleString()}</div>
            <div className="scan-stat-card__label">Issues scanned</div>
          </div>
          {totalProjects > 0 && (
            <div className="scan-stat-card">
              <div className="scan-stat-card__value">
                {processedProjects.toLocaleString()}
                <span style={{ fontSize: "0.7em", opacity: 0.55 }}>/{totalProjects.toLocaleString()}</span>
              </div>
              <div className="scan-stat-card__label">Workers complete</div>
            </div>
          )}
          {durationLabel && (
            <div className="scan-stat-card">
              <div className="scan-stat-card__value">{durationLabel}</div>
              <div className="scan-stat-card__label">Duration</div>
            </div>
          )}
          {scanRate && (
            <div className="scan-stat-card">
              <div className="scan-stat-card__value">
                {scanRate.toLocaleString()}
                <span style={{ fontSize: "0.7em", opacity: 0.55 }}>/s</span>
              </div>
              <div className="scan-stat-card__label">Avg scan rate</div>
            </div>
          )}
          {totalLogCount > 0 && (
            <div className="scan-stat-card">
              <div className="scan-stat-card__value">{totalLogCount}</div>
              <div className="scan-stat-card__label">Log entries</div>
            </div>
          )}
          {scanHistoryRuns.length > 0 && (
            <div className="scan-stat-card">
              <div className="scan-stat-card__value">{scanHistoryRuns.length}</div>
              <div className="scan-stat-card__label">Past runs</div>
            </div>
          )}
        </div>
      )}

      {showCharts && (
        <div className="universe-scan-panel__charts">
          {progressSeries.length >= 2 && (
            <div className="scan-chart-card">
              <div className="scan-chart-card__title">Issues scanned — current run</div>
              <ScanProgressChart data={progressSeries} />
            </div>
          )}
          {historySeries.length >= 1 && (
            <div className="scan-chart-card">
              <div className="scan-chart-card__title">Issues scanned — run history</div>
              <ScanHistoryChart data={historySeries} />
            </div>
          )}
        </div>
      )}

      <div className="universe-scan-panel__body">
        <div className="universe-scan-panel__controls">
          {scanActive && (
            <div className="universe-scan-panel__progress">
              <div className="universe-scan-panel__progress-bar">
                <div className="universe-scan-panel__progress-fill" style={{ width: `${scanPercent}%` }} />
              </div>
              <div className="universe-scan-panel__progress-text">
                <span>{totalProjects > 0 ? `${scanPercent}% — ${processedProjects}/${totalProjects} workers` : "Starting…"}</span>
                {elapsed && <span className="universe-scan-panel__elapsed">{elapsed}</span>}
              </div>
              {processedIssues > 0 && (
                <div className="universe-scan-panel__issues-live">{processedIssues.toLocaleString()} issues scanned</div>
              )}
              {etaLabel && <div className="universe-scan-panel__eta">{etaLabel}</div>}
            </div>
          )}

          <div className="universe-scan-panel__action-row">
            <button className="secondary-button secondary-button--small" type="button"
              onClick={canResume ? onResume : onStart}
              disabled={canResume ? issueScanResuming : issueScanLoading}>
              {canResume
                ? (issueScanResuming ? "Resuming…" : "Resume scan")
                : (issueScanLoading ? "Starting…" : scanDone ? "Re-scan all issues" : "Scan all issues")}
            </button>
            {scanActive && canForceResume && (
              <button className="secondary-button secondary-button--small" type="button" onClick={onResume} disabled={issueScanResuming}>
                {issueScanResuming ? "Resuming…" : "Force resume"}
              </button>
            )}
            {scanActive && (
              <button className="secondary-button secondary-button--small" type="button" onClick={onCancel} disabled={issueScanCancelling}>
                {issueScanCancelling ? "Cancelling…" : "Cancel scan"}
              </button>
            )}
          </div>

          {(scanFailed || scanCancelled) && issueScan?.lastError && (
            <div className="universe-scan-panel__error">{issueScan.lastError}</div>
          )}

          {issueScan?.startedAt && (
            <div className="universe-scan-panel__timestamps">
              <div><span className="scan-ts-label">Started</span>{formatTimestamp(issueScan.startedAt)}</div>
              {issueScan.completedAt && <div><span className="scan-ts-label">Completed</span>{formatTimestamp(issueScan.completedAt)}</div>}
            </div>
          )}

          <div className="universe-scan-panel__about">
            <div className="universe-scan-panel__about-title">What this scan does</div>
            <ul className="universe-scan-panel__about-list">
              <li>Reads every issue across all Jira projects using parallel workers</li>
              <li>Records which custom fields are populated on each issue</li>
              <li>Computes unique issue counts per field × project pair</li>
              <li>Detects <code>RQT-XXXXXX-XXXXXX</code> pattern values in custom fields</li>
              <li>Updates field usage summaries and governance scores</li>
              <li>Promotes completed usage counts into the active field snapshot</li>
            </ul>
          </div>
        </div>

        <div className="universe-scan-panel__log-col">
          <div className="universe-scan-panel__log-head">
            <span className="universe-scan-panel__log-title">Audit Log</span>
            <span className="universe-scan-panel__log-count">{totalLogCount} entr{totalLogCount !== 1 ? "ies" : "y"}</span>
            {scanHistoryRuns.length > 0 && (
              <span className="universe-scan-panel__log-runs">{scanHistoryRuns.length + 1} runs</span>
            )}
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
              <input
                className="rqt-search-input"
                style={{ maxWidth: 200 }}
                placeholder="Search all runs…"
                value={logSearch}
                onChange={e => setLogSearch(e.target.value)}
              />
              {logSearch && (
                <button className="inline-text-button" type="button" onClick={() => setLogSearch("")} style={{ fontSize: "0.75rem" }}>Clear</button>
              )}
            </div>
          </div>
          <div className="universe-scan-panel__log scan-log">
            {filteredEntries ? (
              filteredEntries.length > 0 ? filteredEntries.map((entry, i) => {
                const isComplete = /complete|done|finished/i.test(entry.msg);
                const isError = /error|fail/i.test(entry.msg);
                const isWarn = /warn|stale|slow|timeout/i.test(entry.msg);
                return (
                  <div key={i} className={`scan-log__entry${isComplete ? " scan-log__entry--complete" : ""}${isError ? " scan-log__entry--error" : ""}${isWarn ? " scan-log__entry--warn" : ""}`}>
                    <span className="scan-log__time">{formatShortTime(entry.t)}</span>
                    <span className="scan-log__msg">{entry.msg}</span>
                  </div>
                );
              }) : (
                <div className="empty-state empty-state--inline" style={{ padding: "24px 16px" }}>{`No entries match "${logSearch}".`}</div>
              )
            ) : allRunEntries.length > 0 ? allRunEntries.map((item, i) => {
              if (item.type === "run-header") {
                return (
                  <div key={item.key} className="scan-log__run-header">
                    <span className="scan-log__run-label">{item.isCurrent ? (scanDone ? "Latest run" : scanActive ? "Current run" : "Last run") : "Previous run"}</span>
                    {item.startedAt && <span className="scan-log__run-date">{formatTimestamp(item.startedAt)}</span>}
                    {item.processedIssues > 0 && <span className="scan-log__run-issues">{item.processedIssues.toLocaleString()} issues</span>}
                  </div>
                );
              }
              const isComplete = /complete|done|finished/i.test(item.msg);
              const isError = /error|fail/i.test(item.msg);
              const isWarn = /warn|stale|slow|timeout/i.test(item.msg);
              return (
                <div key={i} className={`scan-log__entry${isComplete ? " scan-log__entry--complete" : ""}${isError ? " scan-log__entry--error" : ""}${isWarn ? " scan-log__entry--warn" : ""}`}>
                  <span className="scan-log__time">{formatShortTime(item.t)}</span>
                  <span className="scan-log__msg">{item.msg}</span>
                </div>
              );
            }) : (
              <div className="empty-state empty-state--inline" style={{ padding: "24px 16px" }}>
                {scanActive ? "Waiting for log entries…" : "No log entries yet. Start a scan to populate the audit log."}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Scans tab (self-contained) ────────────────────────────────────────────

function ScansTab({ siteOrigin, initialSection }) {
  const [activeSection, setActiveSection] = React.useState(initialSection || "universe");

  // Snapshot state (self-contained, same shape as the universe-scan state below;
  // getAdminOverview also returns jobCounts, so this one fetch feeds both the
  // Snapshot panel and the Field Usage Jobs stat row)
  const [snapshotStatus, setSnapshotStatus] = React.useState(null);
  const [jobCounts, setJobCounts] = React.useState(null);
  const [buildingSnapshot, setBuildingSnapshot] = React.useState(false);
  const [refreshingSnapshot, setRefreshingSnapshot] = React.useState(false);

  // Universe scan state
  const [issueScanStatus, setIssueScanStatus] = React.useState(null);
  const [deltaIssueScanStatus, setDeltaIssueScanStatus] = React.useState(null);
  const [issueScanLoading, setIssueScanLoading] = React.useState(false);
  const [issueScanResuming, setIssueScanResuming] = React.useState(false);
  const [issueScanCancelling, setIssueScanCancelling] = React.useState(false);
  const [issueScanDeltaStarting, setIssueScanDeltaStarting] = React.useState(false);
  const [error, setError] = React.useState("");

  // Jobs state (moved from AdminApp)
  const [jobs, setJobs] = React.useState([]);
  const [loadingJobs, setLoadingJobs] = React.useState(false);
  const [refreshingJobs, setRefreshingJobs] = React.useState(false);
  const [expandedJobId, setExpandedJobId] = React.useState("");
  const [cancellingId, setCancellingId] = React.useState("");
  const [restartingId, setRestartingId] = React.useState("");
  const [resumingId, setResumingId] = React.useState("");

  const fetchSnapshotStatus = React.useCallback(async ({ quiet = false } = {}) => {
    if (quiet) setRefreshingSnapshot(true);
    try {
      const data = await invoke("getAdminOverview");
      setSnapshotStatus(data?.snapshot || null);
      setJobCounts(data?.jobCounts || null);
    } catch (err) {
      setError(err.message || "Failed to load snapshot status.");
    } finally {
      if (quiet) setRefreshingSnapshot(false);
    }
  }, []);

  React.useEffect(() => { fetchSnapshotStatus(); }, []);

  React.useEffect(() => {
    const active = snapshotStatus?.state === "building" || snapshotStatus?.state === "queued";
    if (!active) return;
    const timer = setInterval(() => { fetchSnapshotStatus({ quiet: true }); }, 8000);
    return () => clearInterval(timer);
  }, [snapshotStatus?.state]);

  async function handleBuildSnapshot() {
    setBuildingSnapshot(true);
    setError("");
    try {
      await invoke("getFieldInventory", { forceRefresh: true, page: 1, pageSize: 1 });
      await fetchSnapshotStatus();
    } catch (err) {
      setError(err.message || "Failed to trigger snapshot.");
    } finally {
      setBuildingSnapshot(false);
    }
  }

  const fetchIssueScanStatus = React.useCallback(async () => {
    try { const r = await invoke("getIssueScanStatus"); setIssueScanStatus(r?.meta || null); } catch (err) { setError(err.message || "Failed to load universe scan status."); }
  }, []);

  const fetchDeltaStatus = React.useCallback(async () => {
    try { const r = await invoke("getDeltaIssueScanStatus"); setDeltaIssueScanStatus(r?.meta || null); } catch {}
  }, []);

  React.useEffect(() => { fetchIssueScanStatus(); fetchDeltaStatus(); }, []);

  React.useEffect(() => {
    const active = issueScanStatus?.state === "building" || issueScanStatus?.state === "queued";
    if (!active) return;
    // 15s, not 8s: a full scan runs for over an hour, so 8-second granularity was finer
    // than anyone reads while costing two resolver invocations -- and their SQL reads --
    // every 8 seconds for the whole run.
    const timer = setInterval(() => { fetchIssueScanStatus(); fetchDeltaStatus(); }, 15000);
    return () => clearInterval(timer);
  }, [issueScanStatus?.state]);

  async function startScan() {
    setIssueScanLoading(true);
    try { await invoke("startIssueScan"); await fetchIssueScanStatus(); } catch (err) { setError(err.message || "Failed to start universe scan."); } finally { setIssueScanLoading(false); }
  }

  async function resumeScan() {
    setIssueScanResuming(true);
    try {
      const result = await invoke("resumeIssueScan");
      if (result?.resumed === false) setError({ "already-complete": "Universe scan is already complete.", "no-scan": "No universe scan exists to resume." }[result.reason] || "Universe scan could not be resumed.");
      await fetchIssueScanStatus();
    } catch (err) { setError(err.message || "Failed to resume universe scan."); } finally { setIssueScanResuming(false); }
  }

  async function cancelScan() {
    setIssueScanCancelling(true);
    try { await invoke("cancelIssueScan"); await fetchIssueScanStatus(); } catch (err) { setError(err.message || "Failed to cancel scan."); } finally { setIssueScanCancelling(false); }
  }

  async function startDeltaScan() {
    setIssueScanDeltaStarting(true);
    try { await invoke("startDeltaIssueScan"); await fetchDeltaStatus(); } catch (err) { setError(err.message || "Failed to start quick scan."); } finally { setIssueScanDeltaStarting(false); }
  }

  async function loadJobs() {
    setRefreshingJobs(true);
    try {
      const data = await invoke("getProjectUsageJobs");
      setJobs(data.jobs || []);
    } catch (err) {
      setError(err.message || "Failed to load jobs.");
    } finally {
      setRefreshingJobs(false);
    }
  }

  React.useEffect(() => {
    if (activeSection === "jobs" && !jobs.length) {
      setLoadingJobs(true);
      loadJobs().finally(() => setLoadingJobs(false));
    }
  }, [activeSection]);

  async function handleCancelJob(fieldId) {
    setCancellingId(fieldId);
    try { await invoke("cancelProjectUsageJob", { fieldId }); await loadJobs(); } catch (err) { setError(err.message || "Failed to cancel job."); } finally { setCancellingId(""); }
  }

  async function handleRestartJob(fieldId) {
    setRestartingId(fieldId);
    try { await invoke("restartProjectUsageJob", { fieldId }); await loadJobs(); } catch (err) { setError(err.message || "Failed to restart job."); } finally { setRestartingId(""); }
  }

  async function handleResumeJob(fieldId) {
    setResumingId(fieldId);
    try { await invoke("resumeProjectUsageJob", { fieldId }); await loadJobs(); } catch (err) { setError(err.message || "Failed to resume job."); } finally { setResumingId(""); }
  }

  const subNavItems = [
    { key: "snapshot", label: "Snapshot", icon: "layers" },
    { key: "universe", label: "Universe Scan", icon: "zap" },
    { key: "quick", label: "Quick Scan", icon: "activity" },
    { key: "rqt", label: "RQT Index", icon: "layers" },
    { key: "jobs", label: "Field Usage Jobs", icon: "barChart" },
  ];

  return (
    <div className="admin-scans-tab">
      {error && <div className="error-banner" style={{ margin: "0 0 12px 0" }}>{error}<button className="inline-text-button" type="button" onClick={() => setError("")} style={{ marginLeft: 10 }}>Dismiss</button></div>}
      <SubNavLayout items={subNavItems} activeKey={activeSection} onSelect={setActiveSection}>
        {activeSection === "snapshot" && (
          <SnapshotPanel
            snapshot={snapshotStatus}
            onBuildSnapshot={handleBuildSnapshot}
            buildingSnapshot={buildingSnapshot}
            onRefresh={() => fetchSnapshotStatus({ quiet: true })}
            refreshingOverview={refreshingSnapshot}
            onCleared={() => fetchSnapshotStatus({ quiet: true })}
          />
        )}
        {activeSection === "universe" && (
          <UniverseScanPanel
            issueScan={issueScanStatus}
            onStart={startScan}
            onResume={resumeScan}
            onCancel={cancelScan}
            issueScanLoading={issueScanLoading}
            issueScanResuming={issueScanResuming}
            issueScanCancelling={issueScanCancelling}
          />
        )}
        {activeSection === "quick" && (
          <DeltaIssueScanPanel
            deltaIssueScan={deltaIssueScanStatus}
            onStartDelta={startDeltaScan}
            issueScanDeltaStarting={issueScanDeltaStarting}
          />
        )}
        {activeSection === "rqt" && (
          <React.Suspense fallback={<div className="empty-state">Loading…</div>}>
            <RqtIndexView siteOrigin={siteOrigin} />
          </React.Suspense>
        )}
        {activeSection === "jobs" && (
          <>
            <div className="admin-stat-row" style={{ marginBottom: 16 }}>
              <StatCard label="Ready" value={jobCounts?.ready ?? 0} icon="checkCircle" variant="success" />
              <StatCard label="Building" value={jobCounts?.building ?? 0} icon="activity" variant={(jobCounts?.building ?? 0) > 0 ? "building" : "neutral"} />
              <StatCard label="Queued" value={jobCounts?.queued ?? 0} icon="clock" variant="neutral" />
              <StatCard label="Failed" value={jobCounts?.failed ?? 0} icon="x" variant={(jobCounts?.failed ?? 0) > 0 ? "danger" : "neutral"} />
              <StatCard label="Not built" value={jobCounts?.unbuilt ?? 0} icon="layers" variant="neutral" />
            </div>
            <JobsPanel
              jobs={jobs}
              loading={loadingJobs}
              expandedId={expandedJobId}
              onToggle={(id) => setExpandedJobId((cur) => cur === id ? "" : id)}
              onCancel={handleCancelJob}
              onRestart={handleRestartJob}
              onResume={handleResumeJob}
              onRefresh={loadJobs}
              cancellingId={cancellingId}
              restartingId={restartingId}
              resumingId={resumingId}
              refreshing={refreshingJobs}
            />
          </>
        )}
      </SubNavLayout>
    </div>
  );
}

// ── Root app ───────────────────────────────────────────────────────────────

export function AdminApp() {
  const [activeTab, setActiveTab] = React.useState("overview");
  const [theme, setTheme] = React.useState(() => localStorage.getItem("atlasiq-field-theme") || "dark");
  const [overview, setOverview] = React.useState(null);
  const [loadingOverview, setLoadingOverview] = React.useState(true);
  const [config, setConfig] = React.useState(null);
  const [savingConfig, setSavingConfig] = React.useState(false);
  const [migratingNamespace, setMigratingNamespace] = React.useState(false);
  const [error, setError] = React.useState("");
  const [saveSuccess, setSaveSuccess] = React.useState(false);
  const [siteOrigin, setSiteOrigin] = React.useState("");
  const [scansInitialSection, setScansInitialSection] = React.useState("universe");
  const [selectedFieldIds, setSelectedFieldIds] = React.useState([]);
  const [pendingReportGenerate, setPendingReportGenerate] = React.useState(false);

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("atlasiq-field-theme", theme);
  }, [theme]);

  React.useEffect(() => {
    try { view.setAutoResizing(true); } catch {}
  }, []);

  async function loadOverview({ quiet = false } = {}) {
    if (!quiet) setLoadingOverview(true);
    try {
      const data = await invoke("getAdminOverview");
      setOverview(data);
      setConfig(data.config);
    } catch (err) {
      if (!quiet) setError(err.message || "Failed to load overview.");
    } finally {
      setLoadingOverview(false);
    }
  }

  React.useEffect(() => {
    loadOverview();
    view.getContext().then((ctx) => {
      const origin = normalizeSiteOrigin(ctx?.siteUrl || ctx?.extension?.siteUrl || ctx?.extensionContext?.siteUrl);
      if (origin) setSiteOrigin(origin);
    }).catch(() => {});
  }, []);

  function toggleFieldSelection(fieldId, checked) {
    setSelectedFieldIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(fieldId); else next.delete(fieldId);
      return [...next];
    });
  }

  // Slow poll to catch external changes (findings/migration banner) -- live snapshot
  // build progress is now polled independently by ScansTab's own Snapshot panel.
  React.useEffect(() => {
    const timer = setInterval(() => {
      loadOverview({ quiet: true });
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  async function handleMigrateNamespace() {
    setMigratingNamespace(true);
    setError("");
    try {
      await invoke("migrateNamespaceKeys");
      await loadOverview({ quiet: true });
    } catch (err) {
      setError(err.message || "Migration failed.");
    } finally {
      setMigratingNamespace(false);
    }
  }

  async function handleSaveConfig(newConfig) {
    setSavingConfig(true);
    setError("");
    try {
      const result = await invoke("saveAdminConfig", newConfig);
      setConfig(result.config);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setError(err.message || "Failed to save configuration.");
    } finally {
      setSavingConfig(false);
    }
  }

  const tabs = [
    { key: "overview", label: "Overview", icon: "barChart" },
    { key: "fields", label: "Field Browser", icon: "layers" },
    { key: "projects", label: "Project Usage", icon: "folder" },
    { key: "workflows", label: "Workflows", icon: "activity" },
    { key: "reports", label: "Reports", icon: "barChart" },
    { key: "scans", label: "Scans", icon: "zap" },
    { key: "config", label: "Configuration", icon: "settings" },
  ];

  return (
    <div className="admin-shell">
      <div className="admin-layout">
        <aside className="admin-sidebar">
          <div className="admin-sidebar__brand">
            <span className="admin-sidebar__logo">Observatory</span>
            <span className="admin-badge">Admin</span>
          </div>

          <nav className="admin-nav" aria-label="Admin navigation">
            {tabs.map(({ key, label, icon }) => (
              <button
                key={key}
                className={`admin-nav__item${activeTab === key ? " admin-nav__item--active" : ""}`}
                type="button"
                onClick={() => setActiveTab(key)}
              >
                <Icon name={icon} size={15} />
                <span>{label}</span>
              </button>
            ))}
          </nav>

          <div className="admin-sidebar__footer">
            <button
              className="admin-nav__item admin-nav__item--footer"
              onClick={() => setTheme((v) => v === "dark" ? "light" : "dark")}
              type="button"
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              <span>{theme === "dark" ? "☀" : "☽"}</span>
              <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
            </button>
          </div>
        </aside>

        <div className="admin-content">
          {config?.readOnlyMode && (
            <div className="admin-readonly-banner">
              <Icon name="lock" size={14} />
              Read-only mode is active — Confluence macro users cannot trigger field usage scans.
            </div>
          )}

          {error && (
            <div className="error-banner" style={{ margin: "0 0 12px 0" }}>
              {error}
              <button className="inline-text-button" type="button" onClick={() => setError("")} style={{ marginLeft: 10 }}>Dismiss</button>
            </div>
          )}

          {saveSuccess && (
            <div className="admin-success-banner">
              <Icon name="checkCircle" size={14} />
              Configuration saved.
            </div>
          )}

          {activeTab === "overview" ? (
            loadingOverview && !overview ? (
              <div className="empty-state">Loading…</div>
            ) : (
              <OverviewTab
                overview={overview}
                onMigrateNamespace={handleMigrateNamespace}
                migratingNamespace={migratingNamespace}
                onOpenRqtIndex={() => { setScansInitialSection("rqt"); setActiveTab("scans"); }}
                onNavigate={(tab) => setActiveTab(tab)}
              />
            )
          ) : activeTab === "fields" ? (
            <FieldBrowserTab
              selectedFieldIds={selectedFieldIds}
              onToggleField={toggleFieldSelection}
              onSetSelectedFieldIds={setSelectedFieldIds}
              onGoToReport={() => { setActiveTab("reports"); setPendingReportGenerate(true); }}
              siteOrigin={siteOrigin}
            />
          ) : activeTab === "projects" ? (
            <ProjectUsageTab siteOrigin={siteOrigin} />
          ) : activeTab === "workflows" ? (
            <React.Suspense fallback={<div className="empty-state">Loading…</div>}>
              <WorkflowTab />
            </React.Suspense>
          ) : activeTab === "reports" ? (
            <ReportsTab siteOrigin={siteOrigin} selectedFieldIds={selectedFieldIds} onSetSelectedFieldIds={setSelectedFieldIds} autoGenerate={pendingReportGenerate} onAutoGenerateConsumed={() => setPendingReportGenerate(false)} />
          ) : activeTab === "scans" ? (
            <ScansTab siteOrigin={siteOrigin} initialSection={scansInitialSection} />
          ) : (
            <ConfigTab config={config} onSave={handleSaveConfig} saving={savingConfig} />
          )}
        </div>
      </div>
    </div>
  );
}

const rootNode = document.getElementById("root");
if (rootNode) {
  try {
    ReactDOM.createRoot(rootNode).render(
      <React.StrictMode>
        <AdminApp />
      </React.StrictMode>
    );
    if (bootStatusNode) bootStatusNode.remove();
  } catch (error) {
    if (bootStatusNode) {
      bootStatusNode.dataset.state = "error";
      bootStatusNode.textContent = `React mount failed: ${error.message || "Unknown error"}`;
    }
    throw error;
  }
}
