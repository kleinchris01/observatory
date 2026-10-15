import React from "react";
import { formatTimestamp, formatLogTime } from "../../utils";
import { Icon } from "../../components/Icons";
import { JobStatusBadge } from "../../components/admin/primitives";

// Field-usage job list and its row/log sub-components.

export function AdminJobRow({
  job,
  expanded,
  onToggle,
  onCancel,
  onRestart,
  onResume,
  cancellingId,
  restartingId,
  resumingId,
}) {
  const isCancelling = cancellingId === job.fieldId;
  const isRestarting = restartingId === job.fieldId;
  const isResuming = resumingId === job.fieldId;
  const canCancel = job.summaryStatus === "queued" || job.summaryStatus === "building";
  const canRestart =
    job.summaryStatus === "failed" || job.summaryStatus === "cancelled" || job.summaryStatus === "ready";
  const canResume = job.summaryStatus === "building";

  const progressPct =
    job.estimatedIssueTotal > 0
      ? Math.min(100, Math.round((job.processedIssueCount / job.estimatedIssueTotal) * 100))
      : 0;

  return (
    <div className={`admin-job-row ${expanded ? "admin-job-row--expanded" : ""}`}>
      <div
        className="admin-job-row__header"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && onToggle()}
      >
        <span className="admin-job-row__name">{job.fieldName || job.fieldId}</span>
        <span className="admin-job-row__id">{job.fieldId}</span>
        <JobStatusBadge status={job.summaryStatus} />
        {(job.summaryStatus === "building" || job.summaryStatus === "queued") && job.estimatedIssueTotal > 0 && (
          <span className="admin-job-row__progress">{progressPct}%</span>
        )}
        <div className="admin-job-row__actions" onClick={(e) => e.stopPropagation()}>
          {canCancel && (
            <button
              className="secondary-button secondary-button--small"
              type="button"
              disabled={isCancelling}
              onClick={() => onCancel(job.fieldId)}
            >
              {isCancelling ? "…" : "Cancel"}
            </button>
          )}
          {canResume && (
            <button
              className="secondary-button secondary-button--small"
              type="button"
              disabled={isResuming}
              onClick={() => onResume(job.fieldId)}
            >
              {isResuming ? "…" : "Resume"}
            </button>
          )}
          {canRestart && (
            <button
              className="secondary-button secondary-button--small"
              type="button"
              disabled={isRestarting}
              onClick={() => onRestart(job.fieldId)}
            >
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
                <span>
                  {job.processedIssueCount} / {job.estimatedIssueTotal} issues
                </span>
              </div>
              <div className="status-progress__bar">
                <span style={{ width: `${progressPct}%` }} />
              </div>
            </div>
          )}
          <div className="admin-job-detail-grid">
            <span>Started</span>
            <span>{formatTimestamp(job.startedAt)}</span>
            <span>Completed</span>
            <span>{formatTimestamp(job.completedAt)}</span>
            <span>Total issues</span>
            <span>{job.totalIssueCount?.toLocaleString() ?? "—"}</span>
            <span>Active projects</span>
            <span>{job.activeProjectCount ?? "—"}</span>
          </div>
          {job.lastError && (
            <div className="build-card__error" style={{ marginTop: 10 }}>
              {job.lastError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SnapshotLog({ entries }) {
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
      <button type="button" className="admin-snapshot-log-toggle" onClick={() => setExpanded((v) => !v)}>
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

export function JobsPanel({
  jobs,
  loading,
  expandedId,
  onToggle,
  onCancel,
  onRestart,
  onResume,
  onRefresh,
  cancellingId,
  restartingId,
  resumingId,
  refreshing,
}) {
  const [jobQuery, setJobQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");

  const filtered = React.useMemo(() => {
    let list = jobs;
    if (statusFilter !== "all") list = list.filter((j) => j.summaryStatus === statusFilter);
    if (jobQuery.trim()) {
      const q = jobQuery.toLowerCase();
      list = list.filter(
        (j) => (j.fieldName || "").toLowerCase().includes(q) || (j.fieldId || "").toLowerCase().includes(q),
      );
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
