import React from "react";
import ReactDOM from "react-dom/client";
import { invoke, view } from "@forge/bridge";
import "./styles.css";

const bootStatusNode = document.getElementById("boot-status");

// ── Utilities ──────────────────────────────────────────────────────────────

function formatRelativeTime(value) {
  if (!value) return null;
  const diffMs = Date.now() - new Date(value).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}

function toDisplayName(name) {
  if (!name) return name;
  const s = String(name);
  const letters = s.replace(/[^a-zA-Z]/g, "");
  if (!letters.length) return s;
  const upperRatio = (s.match(/[A-Z]/g) || []).length / letters.length;
  if (upperRatio < 0.75) return s;
  return s.toLowerCase().replace(/(?:^|[\s()\-/])\S/g, (c) => c.toUpperCase());
}

function formatTimestamp(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatLogTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ── Icons ──────────────────────────────────────────────────────────────────

const ICON_PATHS = {
  layers:        "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  activity:      "M22 12h-4l-3 9L9 3l-3 9H2",
  zap:           "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  folder:        "M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z",
  settings:      "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z",
  alertTriangle: "M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01",
  check:         "M20 6L9 17l-5-5",
  checkCircle:   "M22 11.08V12a10 10 0 11-5.93-9.14M22 4L12 14.01l-3-3",
  x:             "M18 6L6 18M6 6l12 12",
  refreshCw:     "M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15",
  info:          "M12 22c5.52 0 10-4.48 10-10S17.52 2 12 2 2 6.48 2 12s4.48 10 10 10zM12 16v-4M12 8h.01",
  lock:          "M19 11H5a2 2 0 00-2 2v7a2 2 0 002 2h14a2 2 0 002-2v-7a2 2 0 00-2-2zM17 11V7a5 5 0 00-10 0v4",
  clock:         "M12 22c5.52 0 10-4.48 10-10S17.52 2 12 2 2 6.48 2 12s4.48 10 10 10zM12 6v6l4 2",
  barChart:      "M18 20V10M12 20V4M6 20v-6",
  sliders:       "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  scissors:      "M6 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12",
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

function OverviewTab({ overview, onBuildSnapshot, buildingSnapshot, onRefresh, refreshingOverview, onMigrateNamespace, migratingNamespace }) {
  if (!overview) {
    return <div className="empty-state">Loading overview…</div>;
  }

  const { snapshot, findingsSummary, jobCounts } = overview;
  const snapshotStateLabel = {
    idle: "No snapshot",
    queued: "Queued",
    building: "Building…",
    ready: "Ready",
    failed: "Failed",
  }[snapshot.state] || snapshot.state;

  const isActive = snapshot.state === "building" || snapshot.state === "queued";
  const chipVariant = { ready: "ready", building: "building", queued: "queued" }[snapshot.state] || "idle";

  return (
    <div className="admin-overview">
      <div className="admin-section">
        <h2 className="admin-section__title"><Icon name="layers" size={16} /> Snapshot</h2>
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
                title="Refresh overview data"
              >
                <Icon name="refreshCw" size={13} />
                {refreshingOverview ? "…" : "Refresh"}
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={onBuildSnapshot}
                disabled={buildingSnapshot || isActive}
              >
                <Icon name="refreshCw" size={14} />
                {isActive ? "Building…" : "Build new snapshot"}
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
        </div>
      </div>

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

      <div className="admin-section">
        <h2 className="admin-section__title"><Icon name="alertTriangle" size={16} /> Governance findings</h2>
        <div className="admin-stat-row">
          <StatCard label="Admin attention" value={findingsSummary?.adminAttention ?? 0} icon="alertTriangle" variant={findingsSummary?.adminAttention > 0 ? "danger" : "neutral"} />
          <StatCard label="Risky" value={findingsSummary?.risky ?? 0} icon="alertTriangle" variant={findingsSummary?.risky > 0 ? "warn" : "neutral"} />
          <StatCard label="Cleanup" value={findingsSummary?.cleanup ?? 0} icon="scissors" variant="neutral" />
          <StatCard label="Standardize" value={findingsSummary?.standardize ?? 0} icon="sliders" variant="neutral" />
        </div>
      </div>

      <div className="admin-section">
        <h2 className="admin-section__title"><Icon name="activity" size={16} /> Field usage jobs</h2>
        <div className="admin-stat-row">
          <StatCard label="Ready" value={jobCounts?.ready ?? 0} icon="checkCircle" variant="success" />
          <StatCard label="Building" value={jobCounts?.building ?? 0} icon="activity" variant={(jobCounts?.building ?? 0) > 0 ? "building" : "neutral"} />
          <StatCard label="Queued" value={jobCounts?.queued ?? 0} icon="clock" variant="neutral" />
          <StatCard label="Failed" value={jobCounts?.failed ?? 0} icon="x" variant={(jobCounts?.failed ?? 0) > 0 ? "danger" : "neutral"} />
          <StatCard label="Not built" value={jobCounts?.unbuilt ?? 0} icon="layers" variant="neutral" />
        </div>
      </div>

      <div className="admin-section">
        <h2 className="admin-section__title"><Icon name="zap" size={16} /> Atlassian Developer Console</h2>
        <div className="admin-dev-links">
          <a
            className="admin-dev-link"
            href="https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="zap" size={13} /> App overview
          </a>
          <a
            className="admin-dev-link"
            href="https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/invocations"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="activity" size={13} /> Invocation metrics
          </a>
          <a
            className="admin-dev-link"
            href="https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/storage"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="layers" size={13} /> Storage / SQL
          </a>
          <a
            className="admin-dev-link"
            href="https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/logs"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="info" size={13} /> App logs
          </a>
        </div>
      </div>
    </div>
  );
}

function JobsTab({ jobs, loading, expandedId, onToggle, onCancel, onRestart, onResume, onRefresh, cancellingId, restartingId, resumingId, refreshing }) {
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

function ConfigTab({ config, onSave, saving }) {
  const [local, setLocal] = React.useState(config || DEFAULT_CONFIG);
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
          These values control when governance findings are triggered. Changes apply immediately to the next inventory load — no snapshot rebuild required.
        </p>
        <div className="admin-threshold-grid">
          <ThresholdInput label="High-impact: min projects" value={t.highImpactMinProjects} onChange={(v) => setThreshold("highImpactMinProjects", v)} min={1} max={500} />
          <ThresholdInput label="High-impact: min issues" value={t.highImpactMinIssues} onChange={(v) => setThreshold("highImpactMinIssues", v)} min={1} max={1000000} />
          <ThresholdInput label="App-field heavy usage: min issues" value={t.appFieldHeavyUsageMin} onChange={(v) => setThreshold("appFieldHeavyUsageMin", v)} min={1} max={100000} />
          <ThresholdInput label="Broad scope: min configured projects" value={t.broadScopeMinProjects} onChange={(v) => setThreshold("broadScopeMinProjects", v)} min={1} max={500} />
          <ThresholdInput label="Light usage: min active projects" value={t.lightUsageMinProjects} onChange={(v) => setThreshold("lightUsageMinProjects", v)} min={1} max={500} />
          <ThresholdInput label="Light usage: max issues" value={t.lightUsageMaxIssues} onChange={(v) => setThreshold("lightUsageMaxIssues", v)} min={1} max={10000} />
          <ThresholdInput label="Missing description: min projects" value={t.missingDescriptionMinProjects} onChange={(v) => setThreshold("missingDescriptionMinProjects", v)} min={1} max={500} />
          <ThresholdInput label="Missing description: min issues" value={t.missingDescriptionMinIssues} onChange={(v) => setThreshold("missingDescriptionMinIssues", v)} min={1} max={100000} />
          <ThresholdInput label="Dead config: min configured projects" value={t.configuredActiveGapMinProjects} onChange={(v) => setThreshold("configuredActiveGapMinProjects", v)} min={1} max={500} />
          <ThresholdInput label="Dead config: max inactive ratio (0–1)" value={t.configuredActiveGapMaxRatio} onChange={(v) => setThreshold("configuredActiveGapMaxRatio", Math.max(0.05, Math.min(0.99, v)))} min={0.05} max={0.99} step="0.05" />
          <ThresholdInput label="Global context: max issues to flag" value={t.globalContextMaxIssues} onChange={(v) => setThreshold("globalContextMaxIssues", v)} min={1} max={10000} />
          <ThresholdInput label="Context sprawl: min contexts to flag" value={t.contextSprawlMinContexts} onChange={(v) => setThreshold("contextSprawlMinContexts", v)} min={2} max={100} />
        </div>
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
    </div>
  );
}

// ── Project usage tab ─────────────────────────────────────────────────────

function ProjectUsageTab() {
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

  const projects = data?.projects || [];
  const selectedProject = data?.selectedProject || null;
  const fields = data?.fields || [];
  const availableTypes = data?.availableTypes || [];
  const totalFields = Number(data?.totalFields || 0);
  const currentPage = Number(data?.page || 1);
  const totalPages = Number(data?.totalPages || 1);
  const pageSize = Number(data?.pageSize || 24);

  const currentIndex = projects.findIndex((p) => p.projectId === selectedProjectId);
  const prevProject = currentIndex > 0 ? projects[currentIndex - 1] : null;
  const nextProject = currentIndex >= 0 && currentIndex < projects.length - 1 ? projects[currentIndex + 1] : null;

  return (
    <div className="admin-projects-tab">
      {loadError && <div className="error-banner">{loadError}</div>}
      <div className="admin-projects-layout">
        {/* Project rail */}
        <aside className="admin-projects-rail">
          <div className="admin-projects-rail__header">
            <span className="admin-field-detail-section-label" style={{ margin: 0 }}>Projects</span>
            <span className="admin-pagination__info">{projects.length} total</span>
          </div>
          <input
            type="search"
            placeholder="Search projects…"
            value={projectQuery}
            onChange={(e) => setProjectQuery(e.target.value)}
            className="admin-jobs-search"
            style={{ marginBottom: 8 }}
          />
          {loading && !projects.length ? (
            <div className="admin-field-detail-loading">Loading projects…</div>
          ) : projects.length === 0 ? (
            <div className="admin-field-detail-loading">No projects found in snapshot.</div>
          ) : (
            <div className="admin-projects-rail__list">
              {projects.map((p) => (
                <button
                  key={p.projectId}
                  type="button"
                  className={`admin-project-item ${p.projectId === selectedProjectId ? "admin-project-item--active" : ""}`}
                  onClick={() => { setSelectedProjectId(p.projectId); setPage(1); }}
                >
                  <div className="admin-project-item__top">
                    <strong>{p.projectKey}</strong>
                    <span>{(p.uniqueIssueCount ?? p.totalIssueCount ?? 0).toLocaleString()} {p.uniqueIssueCount != null ? "issues" : "fills"}</span>
                  </div>
                  <div className="admin-project-item__bottom">
                    <span>{p.projectName}</span>
                    <span>{(p.fieldCount || 0)} fields</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>

        {/* Field usage pane */}
        <div className="admin-projects-content">
          {!selectedProject ? (
            <div className="empty-state">Select a project to see field usage.</div>
          ) : (
            <>
              <div className="admin-projects-content__header">
                <div>
                  <div className="admin-projects-content__title">{selectedProject.projectKey} — {selectedProject.projectName}</div>
                  <div className="admin-pagination__info">
                    {selectedProject.fieldCount || 0} fields with usage
                    {selectedProject.uniqueIssueCount != null
                      ? ` · ${selectedProject.uniqueIssueCount.toLocaleString()} unique issues`
                      : selectedProject.totalIssueCount != null
                        ? ` · ${selectedProject.totalIssueCount.toLocaleString()} fills`
                        : ""}
                  </div>
                </div>
                <div className="admin-projects-content__nav">
                  <button disabled={!prevProject} className="secondary-button secondary-button--small" type="button" onClick={() => { setSelectedProjectId(prevProject.projectId); setPage(1); }}>Prev</button>
                  <button disabled={!nextProject} className="secondary-button secondary-button--small" type="button" onClick={() => { setSelectedProjectId(nextProject.projectId); setPage(1); }}>Next</button>
                </div>
              </div>

              <div className="admin-projects-filters">
                <input
                  type="search"
                  placeholder="Search fields…"
                  value={fieldQuery}
                  onChange={(e) => setFieldQuery(e.target.value)}
                  className="admin-jobs-search"
                  style={{ flex: "1 1 180px" }}
                />
                <select value={fieldType} onChange={(e) => { setFieldType(e.target.value); setPage(1); }}>
                  <option value="all">All types</option>
                  {availableTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <select value={fieldSort} onChange={(e) => { setFieldSort(e.target.value); setPage(1); }}>
                  <option value="issues-desc">Most issues</option>
                  <option value="issues-asc">Fewest issues</option>
                  <option value="name-asc">Name A–Z</option>
                  <option value="name-desc">Name Z–A</option>
                </select>
              </div>

              {loading && !fields.length ? (
                <div className="empty-state">Loading fields…</div>
              ) : fields.length === 0 ? (
                <div className="empty-state">No fields matched the current filters.</div>
              ) : (
                <div className="admin-project-fields">
                  <table className="admin-usage-table">
                    <thead>
                      <tr>
                        <th>Field</th>
                        <th>Type</th>
                        <th style={{ textAlign: "right" }}>Issues on project</th>
                        <th style={{ textAlign: "right" }}>Active projects</th>
                        <th>Findings</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fields.map((f) => {
                        const tags = f.findings?.tags || {};
                        return (
                          <tr key={f.fieldId}>
                            <td>
                              <div style={{ fontWeight: 600, fontSize: 13 }}>{toDisplayName(f.fieldName || f.fieldId)}</div>
                              <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--muted)" }}>{f.fieldId}</div>
                            </td>
                            <td><span className="admin-field-row__type">{f.fieldType}</span></td>
                            <td className="admin-usage-table__count">{(f.issueCount || 0).toLocaleString()}</td>
                            <td className="admin-usage-table__count">{(f.activeProjectCount || 0).toLocaleString()}</td>
                            <td>
                              <div className="admin-field-row__tags">
                                {tags.adminAttention && <span className="admin-field-tag admin-field-tag--danger">admin</span>}
                                {tags.risky && <span className="admin-field-tag admin-field-tag--warn">risky</span>}
                                {tags.cleanup && <span className="admin-field-tag admin-field-tag--neutral">cleanup</span>}
                                {tags.standardize && <span className="admin-field-tag admin-field-tag--neutral">standardize</span>}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {totalFields > pageSize && (
                <div className="admin-pagination" style={{ marginTop: 12 }}>
                  <button disabled={currentPage <= 1} className="secondary-button secondary-button--small" type="button" onClick={() => setPage(1)}>First</button>
                  <button disabled={currentPage <= 1} className="secondary-button secondary-button--small" type="button" onClick={() => setPage((p) => p - 1)}>Prev</button>
                  <span className="admin-pagination__info">
                    {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, totalFields)} of {totalFields.toLocaleString()} fields
                  </span>
                  <button disabled={currentPage >= totalPages} className="secondary-button secondary-button--small" type="button" onClick={() => setPage((p) => p + 1)}>Next</button>
                  <button disabled={currentPage >= totalPages} className="secondary-button secondary-button--small" type="button" onClick={() => setPage(totalPages)}>Last</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Field browser tab ─────────────────────────────────────────────────────

const SEVERITY_VARIANT = { high: "danger", medium: "warn", low: "neutral" };

function FieldDetailPanel({ detail, detailPage, onPageChange, loading }) {
  const field = detail?.field || {};
  const contexts = detail?.contexts || [];
  const projects = detail?.projects || [];
  const findingReasons = field?.findings?.reasons || [];
  const totalPages = detail?.projectUsageTotalPages || 1;
  const totalProjects = detail?.projectUsageTotalProjects || 0;

  return (
    <div className="admin-field-detail-panel">
      <div className="admin-field-detail-meta">
        {field.description && <p className="admin-field-detail-desc">{field.description}</p>}
        <div className="admin-field-detail-stats">
          <span><strong>{(detail.totalIssueCount || 0).toLocaleString()}</strong> issues</span>
          <span><strong>{totalProjects.toLocaleString()}</strong> active projects</span>
          {contexts.length > 0 && <span><strong>{contexts.length}</strong> contexts</span>}
        </div>
      </div>

      {findingReasons.length > 0 && (
        <div className="admin-field-detail-findings">
          <span className="admin-field-detail-section-label">Governance findings</span>
          <div className="admin-findings-list">
            {findingReasons.map((r, i) => (
              <div key={i} className={`admin-finding-item admin-finding-item--${SEVERITY_VARIANT[r.severity] || "neutral"}`}>
                <strong>{r.title}</strong>
                {r.detail && <span>{r.detail}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {contexts.length > 0 && (
        <div className="admin-field-detail-section">
          <span className="admin-field-detail-section-label">Contexts ({contexts.length})</span>
          <div className="admin-context-list">
            {contexts.map((ctx, i) => (
              <span key={i} className="admin-context-chip">
                {ctx.name || ctx.contextName || `Context ${i + 1}`}
                {ctx.isGlobal && <em className="admin-context-chip__global"> global</em>}
              </span>
            ))}
          </div>
        </div>
      )}

      {projects.length > 0 && (
        <div className="admin-field-detail-section">
          <span className="admin-field-detail-section-label">
            Project usage{totalProjects > 0 ? ` (${totalProjects.toLocaleString()} total)` : ""}
          </span>
          <table className="admin-usage-table">
            <thead>
              <tr><th>Project</th><th>Key</th><th>Issues</th></tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.projectId || p.projectKey}>
                  <td>{p.projectName}</td>
                  <td className="admin-usage-table__key"><code>{p.projectKey}</code></td>
                  <td className="admin-usage-table__count">{(p.issueCount || 0).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {totalPages > 1 && (
            <div className="admin-pagination" style={{ marginTop: 8 }}>
              <button disabled={detailPage <= 1 || loading} className="secondary-button secondary-button--small" type="button" onClick={() => onPageChange(detailPage - 1)}>Prev</button>
              <span className="admin-pagination__info">Page {detailPage} of {totalPages}</span>
              <button disabled={detailPage >= totalPages || loading} className="secondary-button secondary-button--small" type="button" onClick={() => onPageChange(detailPage + 1)}>Next</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FieldBrowserTab() {
  const PAGE_SIZE = 20;
  const [query, setQuery] = React.useState("");
  const [deferredQuery, setDeferredQuery] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState("all");
  const [sortBy, setSortBy] = React.useState("usage-desc");
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState("");
  const [openFieldId, setOpenFieldId] = React.useState(null);
  const [fieldDetail, setFieldDetail] = React.useState(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState("");
  const [detailPage, setDetailPage] = React.useState(1);

  React.useEffect(() => {
    const t = setTimeout(() => {
      setDeferredQuery(query);
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    invoke("getFieldInventory", {
      query: deferredQuery,
      type: typeFilter,
      sortBy,
      page,
      pageSize: PAGE_SIZE,
    }).then((result) => {
      if (!cancelled) setData(result);
    }).catch((err) => {
      if (!cancelled) setLoadError(err.message || "Failed to load field inventory.");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [deferredQuery, typeFilter, sortBy, page]);

  function openField(fieldId) {
    if (openFieldId === fieldId) {
      setOpenFieldId(null);
      setFieldDetail(null);
      return;
    }
    setOpenFieldId(fieldId);
    setFieldDetail(null);
    setDetailError("");
    setDetailPage(1);
    setDetailLoading(true);
    invoke("getFieldDetails", { fieldId, usagePage: 1 }).then((result) => {
      setFieldDetail(result);
    }).catch((err) => {
      setDetailError(err.message || "Failed to load field details.");
    }).finally(() => setDetailLoading(false));
  }

  function loadDetailPage(fieldId, pg) {
    setDetailPage(pg);
    setDetailLoading(true);
    invoke("getFieldDetails", { fieldId, usagePage: pg }).then((result) => {
      setFieldDetail(result);
    }).catch((err) => {
      setDetailError(err.message || "Failed to load.");
    }).finally(() => setDetailLoading(false));
  }

  const fields = data?.fields || [];
  const totalPages = data?.totalPages || 1;
  const total = data?.total || 0;
  const availableTypes = data?.availableTypes || [];

  return (
    <div className="admin-field-browser">
      <div className="admin-field-browser__toolbar">
        <input
          type="search"
          placeholder="Search fields by name, ID, or type…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="admin-jobs-search"
        />
        <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}>
          <option value="all">All types</option>
          {availableTypes.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={sortBy} onChange={(e) => { setSortBy(e.target.value); setPage(1); }}>
          <option value="usage-desc">Most issues</option>
          <option value="usage-asc">Least issues</option>
          <option value="name-asc">Name A–Z</option>
          <option value="name-desc">Name Z–A</option>
          <option value="projects-desc">Most projects</option>
        </select>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      {loading && !fields.length ? (
        <div className="empty-state">Loading fields…</div>
      ) : fields.length === 0 ? (
        <div className="empty-state">No fields match the current filter.</div>
      ) : (
        <div className="admin-field-list">
          {fields.map((field) => {
            const isOpen = openFieldId === field.id;
            const displayName = toDisplayName(field.name || field.id);
            const tags = field.findings?.tags || {};
            return (
              <div key={field.id} className={`admin-field-row ${isOpen ? "admin-field-row--open" : ""}`}>
                <button
                  className="admin-field-row__header"
                  type="button"
                  onClick={() => openField(field.id)}
                  aria-expanded={isOpen}
                >
                  <span className="admin-field-row__name">{displayName}</span>
                  <span className="admin-field-row__id">{field.id}</span>
                  <span className="admin-field-row__type">{field.type}</span>
                  <div className="admin-field-row__meta">
                    <span>{(field.totalIssueCount || 0).toLocaleString()} issues</span>
                    <span>{field.activeProjectCount || 0} projects</span>
                  </div>
                  <div className="admin-field-row__tags">
                    {tags.adminAttention && <span className="admin-field-tag admin-field-tag--danger">admin</span>}
                    {tags.risky && <span className="admin-field-tag admin-field-tag--warn">risky</span>}
                    {tags.cleanup && <span className="admin-field-tag admin-field-tag--neutral">cleanup</span>}
                    {tags.standardize && <span className="admin-field-tag admin-field-tag--neutral">standardize</span>}
                  </div>
                  <span className="admin-field-row__chevron"><Icon name={isOpen ? "x" : "activity"} size={14} /></span>
                </button>
                {isOpen && (
                  <div className="admin-field-detail">
                    {detailLoading && !fieldDetail ? (
                      <div className="admin-field-detail-loading">Loading field details…</div>
                    ) : detailError ? (
                      <div className="error-banner" style={{ margin: 0 }}>{detailError}</div>
                    ) : fieldDetail ? (
                      <FieldDetailPanel
                        detail={fieldDetail}
                        detailPage={detailPage}
                        onPageChange={(pg) => loadDetailPage(field.id, pg)}
                        loading={detailLoading}
                      />
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="admin-field-browser__footer">
        {totalPages > 1 ? (
          <div className="admin-pagination">
            <button disabled={page <= 1} className="secondary-button secondary-button--small" type="button" onClick={() => setPage((p) => p - 1)}>Prev</button>
            <span className="admin-pagination__info">Page {page} of {totalPages} · {total.toLocaleString()} fields</span>
            <button disabled={page >= totalPages} className="secondary-button secondary-button--small" type="button" onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        ) : total > 0 ? (
          <span className="admin-field-browser__count">{total.toLocaleString()} fields</span>
        ) : null}
      </div>
    </div>
  );
}

// ── Root app ───────────────────────────────────────────────────────────────

function AdminApp() {
  const [activeTab, setActiveTab] = React.useState("overview");
  const [theme, setTheme] = React.useState(() => localStorage.getItem("atlasiq-field-theme") || "dark");
  const [overview, setOverview] = React.useState(null);
  const [loadingOverview, setLoadingOverview] = React.useState(true);
  const [refreshingOverview, setRefreshingOverview] = React.useState(false);
  const [config, setConfig] = React.useState(null);
  const [jobs, setJobs] = React.useState([]);
  const [loadingJobs, setLoadingJobs] = React.useState(false);
  const [refreshingJobs, setRefreshingJobs] = React.useState(false);
  const [savingConfig, setSavingConfig] = React.useState(false);
  const [buildingSnapshot, setBuildingSnapshot] = React.useState(false);
  const [migratingNamespace, setMigratingNamespace] = React.useState(false);
  const [error, setError] = React.useState("");
  const [saveSuccess, setSaveSuccess] = React.useState(false);
  const [expandedJobId, setExpandedJobId] = React.useState("");
  const [cancellingId, setCancellingId] = React.useState("");
  const [restartingId, setRestartingId] = React.useState("");
  const [resumingId, setResumingId] = React.useState("");

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("atlasiq-field-theme", theme);
  }, [theme]);

  React.useEffect(() => {
    try { view.setAutoResizing(true); } catch {}
  }, []);

  async function loadOverview({ quiet = false } = {}) {
    if (quiet) {
      setRefreshingOverview(true);
    } else {
      setLoadingOverview(true);
    }
    try {
      const data = await invoke("getAdminOverview");
      setOverview(data);
      setConfig(data.config);
    } catch (err) {
      if (!quiet) setError(err.message || "Failed to load overview.");
    } finally {
      setLoadingOverview(false);
      setRefreshingOverview(false);
    }
  }

  async function handleRefreshOverview() {
    await loadOverview({ quiet: true });
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
    loadOverview();
  }, []);

  React.useEffect(() => {
    if (activeTab === "jobs" && !jobs.length) {
      setLoadingJobs(true);
      loadJobs().finally(() => setLoadingJobs(false));
    }
  }, [activeTab]);

  // Fast poll (12s) while actively building; slow poll (60s) always to catch external changes
  React.useEffect(() => {
    const isBuilding = overview?.snapshot?.state === "building" || overview?.snapshot?.state === "queued";
    const hasActiveJobs = jobs.some((j) => j.summaryStatus === "building" || j.summaryStatus === "queued");
    const fastTimer = (isBuilding || hasActiveJobs) ? setInterval(() => {
      if (isBuilding) loadOverview({ quiet: true });
      if (hasActiveJobs && activeTab === "jobs") loadJobs();
    }, 12000) : null;
    const slowTimer = setInterval(() => {
      loadOverview({ quiet: true });
    }, 60000);
    return () => {
      if (fastTimer) clearInterval(fastTimer);
      clearInterval(slowTimer);
    };
  }, [overview, jobs, activeTab]);

  async function handleBuildSnapshot() {
    setBuildingSnapshot(true);
    setError("");
    try {
      await invoke("getFieldInventory", { forceRefresh: true, page: 1, pageSize: 1 });
      await loadOverview();
    } catch (err) {
      setError(err.message || "Failed to trigger snapshot.");
    } finally {
      setBuildingSnapshot(false);
    }
  }

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

  async function handleCancelJob(fieldId) {
    setCancellingId(fieldId);
    try {
      await invoke("cancelProjectUsageJob", { fieldId });
      await loadJobs();
    } catch (err) {
      setError(err.message || "Failed to cancel job.");
    } finally {
      setCancellingId("");
    }
  }

  async function handleRestartJob(fieldId) {
    setRestartingId(fieldId);
    try {
      await invoke("restartProjectUsageJob", { fieldId });
      await loadJobs();
    } catch (err) {
      setError(err.message || "Failed to restart job.");
    } finally {
      setRestartingId("");
    }
  }

  async function handleResumeJob(fieldId) {
    setResumingId(fieldId);
    try {
      await invoke("resumeProjectUsageJob", { fieldId });
      await loadJobs();
    } catch (err) {
      setError(err.message || "Failed to resume job.");
    } finally {
      setResumingId("");
    }
  }

  const tabs = [
    { key: "overview", label: "Overview", icon: "barChart" },
    { key: "fields", label: "Field Browser", icon: "layers" },
    { key: "projects", label: "Project Usage", icon: "folder" },
    { key: "jobs", label: "Field Usage Jobs", icon: "activity" },
    { key: "config", label: "Configuration", icon: "settings" },
  ];

  return (
    <main className="app-shell admin-shell" style={{ minHeight: "100vh" }}>
      <section className="hero">
        <div className="hero__identity">
          <h1>Observatory</h1>
          <span className="admin-badge">Admin</span>
        </div>
        <div className="hero__actions">
          <button
            className="icon-button"
            onClick={() => setTheme((v) => v === "dark" ? "light" : "dark")}
            type="button"
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? "☀" : "☽"}
          </button>
        </div>
      </section>

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

      <div className="tab-bar">
        {tabs.map(({ key, label, icon }) => (
          <button
            key={key}
            className={`tab-bar__tab ${activeTab === key ? "tab-bar__tab--active" : ""}`}
            type="button"
            onClick={() => setActiveTab(key)}
          >
            <Icon name={icon} size={15} />
            {label}
          </button>
        ))}
      </div>

      {activeTab === "overview" ? (
        loadingOverview && !overview ? (
          <div className="empty-state">Loading…</div>
        ) : (
          <OverviewTab overview={overview} onBuildSnapshot={handleBuildSnapshot} buildingSnapshot={buildingSnapshot} onRefresh={handleRefreshOverview} refreshingOverview={refreshingOverview} onMigrateNamespace={handleMigrateNamespace} migratingNamespace={migratingNamespace} />
        )
      ) : activeTab === "fields" ? (
        <FieldBrowserTab />
      ) : activeTab === "projects" ? (
        <ProjectUsageTab />
      ) : activeTab === "jobs" ? (
        <JobsTab
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
      ) : (
        <ConfigTab config={config} onSave={handleSaveConfig} saving={savingConfig} />
      )}
    </main>
  );
}

try {
  ReactDOM.createRoot(document.getElementById("root")).render(
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
