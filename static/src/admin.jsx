import React from "react";
import ReactDOM from "react-dom/client";
import { createPortal } from "react-dom";
import { invoke, view } from "@forge/bridge";
import "./styles.css";
import { RqtIndexView } from "./tabs/RqtTab";
import { formatTimestamp, formatNumber, toDisplayName, buildValueJql, formatShortTime, formatRelativeTime, formatLogTime, formatContextList, normalizeSiteOrigin, buildJiraSearchUrl, handleJiraLinkClick, escapeCsvCell, downloadCsv, slugifyFilenamePart, normalizeReportData, groupReportFieldsByType, summarizeReportData, isUsageAvailable, isSelectType, mergeFieldMetrics, openFieldExpertRovo, buildInventoryRovoPrompt, buildFieldRovoPrompt, buildProjectRovoPrompt, buildReportRovoPrompt } from "./utils";
import { Icon, ICON_PATHS, useLiveDuration, CHART_PALETTE } from "./components/Icons";
import { ReportErrorBoundary, SavedReportsPanel, ProjectUsageReportView } from "./components/ReportView";
import { MetricChip, FindingBadge, FindingsStrip, SkeletonFieldCard, SkeletonProjectItem, InlineOptionsContext, FieldCard } from "./components/FieldCard";
import { ProjectsTabView } from "./components/ProjectsTab";

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

      {/* Expandable advanced filter panel */}
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
                onAskField={() => {
                  const d = fieldDetails[field.id];
                  openFieldExpertRovo(buildFieldRovoPrompt({ field, details: d })).catch(() => {});
                }}
                onAskProject={(project) => {
                  openFieldExpertRovo(buildProjectRovoPrompt({ field, project })).catch(() => {});
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

function UniverseScanPanel({ issueScan, onStart, onResume, onCancel, issueScanLoading, issueScanResuming, issueScanCancelling, deltaIssueScan, onStartDelta, issueScanDeltaStarting }) {
  const scanActive = issueScan?.state === "building" || issueScan?.state === "queued";
  const scanDone = issueScan?.state === "ready";
  const lastScanLogAt = issueScan?.progressLog?.length ? issueScan.progressLog[issueScan.progressLog.length - 1]?.t : issueScan?.startedAt;
  const scanStale = lastScanLogAt ? (Date.now() - new Date(lastScanLogAt).getTime()) > 10 * 60 * 1000 : scanActive;
  const canResume = issueScan && !scanDone && ((scanActive && scanStale) || issueScan?.state === "failed" || issueScan?.state === "cancelled");
  const canForceResume = scanActive && scanStale;
  const processedIssues = Number(issueScan?.processedIssues || 0);
  const totalIssues = Number(issueScan?.totalIssues || 0);
  const processedProjects = Number(issueScan?.processedPages || 0);
  const totalProjects = Number(issueScan?.totalPages || 0);
  const scanPercent = totalProjects > 0 ? Math.min(100, Math.round(processedProjects / totalProjects * 100)) : 0;
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
    const m = Math.floor(remainingSec / 60), s = remainingSec % 60;
    return m > 0 ? `~${m}m ${s}s remaining` : `~${s}s remaining`;
  }, [scanActive, issueScan?.processedPages, issueScan?.totalPages, issueScan?.startedAt, elapsed]);

  return (
    <div className="issue-scan-panel">
      <div className="issue-scan-panel__header">
        <span className="issue-scan-panel__title">Universe Scan</span>
        {scanDone && issueScan?.completedAt && <span className="issue-scan-panel__done">{(issueScan.processedIssues || issueScan.totalIssues || 0).toLocaleString()} issues scanned</span>}
      </div>
      {scanActive ? (
        <div className="issue-scan-panel__progress">
          <div className="issue-scan-panel__bar-track"><div className="issue-scan-panel__bar-fill" style={{ width: `${scanPercent}%` }} /></div>
          <div className="issue-scan-panel__status">
            <span className="issue-scan-panel__status-main">{totalProjects > 0 ? `${scanPercent}% — ${processedIssues > 0 ? `${processedIssues.toLocaleString()} issues scanned — ` : ""}${processedProjects.toLocaleString()}/${totalProjects.toLocaleString()} workers` : "Starting…"}</span>
            <span className="issue-scan-panel__status-meta">
              {elapsed ? <span className="issue-scan-panel__elapsed">{elapsed}</span> : null}
              {etaLabel ? <span className="issue-scan-panel__eta">{etaLabel}</span> : null}
            </span>
          </div>
          <div className="issue-scan-panel__buttons">
            {canForceResume && <button className="secondary-button secondary-button--small" type="button" onClick={onResume} disabled={issueScanResuming}>{issueScanResuming ? "Resuming..." : "Resume"}</button>}
            <button className="secondary-button secondary-button--small" type="button" onClick={onCancel} disabled={issueScanCancelling}>{issueScanCancelling ? "Cancelling..." : "Cancel scan"}</button>
          </div>
        </div>
      ) : (
        <div className="issue-scan-panel__actions">
          <p className="issue-scan-panel__desc">{scanDone ? "Unique issue counts are shown per project. Re-scan to refresh." : "Scan all issues once to get accurate unique issue counts per project."}</p>
          <button className="secondary-button secondary-button--small" type="button" onClick={canResume ? onResume : onStart} disabled={canResume ? issueScanResuming : issueScanLoading}>
            {canResume ? (issueScanResuming ? "Resuming..." : "Resume scan") : (issueScanLoading ? "Starting..." : scanDone ? "Re-scan all issues" : "Scan all issues")}
          </button>
          {issueScan?.state === "failed" && issueScan?.lastError && <div className="issue-scan-panel__error">{issueScan.lastError}</div>}
        </div>
      )}
      {entries.length ? (
        <div className="scan-log issue-scan-panel__log">
          {entries.map((entry, i) => (
            <div key={i} className="scan-log__entry">
              <span className="scan-log__time">{formatShortTime(entry.t)}</span>
              <span className="scan-log__msg">{entry.msg}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state empty-state--inline">{scanActive ? "Waiting for the scan log to populate..." : "No universe scan log entries yet."}</div>
      )}
      <DeltaIssueScanPanel deltaIssueScan={deltaIssueScan} onStartDelta={onStartDelta} issueScanDeltaStarting={issueScanDeltaStarting} />
    </div>
  );
}

// ── Scans tab (self-contained) ────────────────────────────────────────────

function ScansTab({ siteOrigin }) {
  const [issueScanStatus, setIssueScanStatus] = React.useState(null);
  const [deltaIssueScanStatus, setDeltaIssueScanStatus] = React.useState(null);
  const [issueScanLoading, setIssueScanLoading] = React.useState(false);
  const [issueScanResuming, setIssueScanResuming] = React.useState(false);
  const [issueScanCancelling, setIssueScanCancelling] = React.useState(false);
  const [issueScanDeltaStarting, setIssueScanDeltaStarting] = React.useState(false);
  const [collapsedSections, setCollapsedSections] = React.useState({ universe: false, rqt: false });
  const [error, setError] = React.useState("");

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
    const timer = setInterval(() => { fetchIssueScanStatus(); fetchDeltaStatus(); }, 8000);
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

  function toggleSection(key) { setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] })); }

  return (
    <div className="admin-scans-tab">
      {error && <div className="error-banner" style={{ margin: "0 0 12px 0" }}>{error}<button className="inline-text-button" type="button" onClick={() => setError("")} style={{ marginLeft: 10 }}>Dismiss</button></div>}
      <ActivitySection title="Universe Scan" subtitle="Full-site issue crawl used to derive unique issue counts per project." open={!collapsedSections.universe} onToggle={() => toggleSection("universe")}>
        <UniverseScanPanel
          issueScan={issueScanStatus}
          onStart={startScan}
          onResume={resumeScan}
          onCancel={cancelScan}
          issueScanLoading={issueScanLoading}
          issueScanResuming={issueScanResuming}
          issueScanCancelling={issueScanCancelling}
          deltaIssueScan={deltaIssueScanStatus}
          onStartDelta={startDeltaScan}
          issueScanDeltaStarting={issueScanDeltaStarting}
        />
      </ActivitySection>
      <ActivitySection title="RQT Index" subtitle="Requirement ID tracking across all custom field values." open={!collapsedSections.rqt} onToggle={() => toggleSection("rqt")}>
        <RqtIndexView siteOrigin={siteOrigin} />
      </ActivitySection>
    </div>
  );
}

// ── Root app ───────────────────────────────────────────────────────────────

export function AdminApp() {
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
  const [siteOrigin, setSiteOrigin] = React.useState("");
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
    { key: "reports", label: "Reports", icon: "barChart" },
    { key: "scans", label: "Scans", icon: "zap" },
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
        <FieldBrowserTab
          selectedFieldIds={selectedFieldIds}
          onToggleField={toggleFieldSelection}
          onSetSelectedFieldIds={setSelectedFieldIds}
          onGoToReport={() => { setActiveTab("reports"); setPendingReportGenerate(true); }}
          siteOrigin={siteOrigin}
        />
      ) : activeTab === "projects" ? (
        <ProjectUsageTab siteOrigin={siteOrigin} />
      ) : activeTab === "reports" ? (
        <ReportsTab siteOrigin={siteOrigin} selectedFieldIds={selectedFieldIds} onSetSelectedFieldIds={setSelectedFieldIds} autoGenerate={pendingReportGenerate} onAutoGenerateConsumed={() => setPendingReportGenerate(false)} />
      ) : activeTab === "scans" ? (
        <ScansTab siteOrigin={siteOrigin} />
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
