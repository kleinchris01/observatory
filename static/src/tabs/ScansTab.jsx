import React from "react";
import { invoke, view } from "@forge/bridge";
import { formatTimestamp, formatShortTime, formatRelativeTime } from "../utils";
import { Icon, useLiveDuration } from "../components/Icons";
import { SubNavLayout } from "../components/admin/primitives";
import { StatTile, StatRow, PageHeader, Panel, EmptyState } from "../components/ui";
import { SnapshotLog, JobsPanel } from "../components/admin/JobsPanel";

// Snapshot builds, the universe scan and delta scans -- the operator surface for the
// pipeline.
//
// The RQT index used to render here too, purely because the universe scan is what builds
// it. That is a build dependency, not a reason to browse it from the operator's tab: this
// tab runs and monitors jobs, every other tab reads what they produced. It now lives under
// Reports, which is where a cross-reference over field values belongs.


// The word a user must type to confirm destroying every snapshot. Deliberately not
// "yes": the point is that it cannot be typed by reflex.
const CLEAR_CONFIRMATION_WORD = "DELETE";

// Poll only while a job is running AND the tab is actually being looked at.
//
// The job-active guard was already here; the visibility guard was not. A universe scan
// wedged in "building" plus one forgotten browser tab kept two resolvers -- and their SQL
// reads -- firing every 15 seconds all night. Nobody was reading the screen, so every one
// of those queries bought nothing.
//
// Fires once immediately on becoming visible, so a tab returned to after an hour shows
// current state rather than waiting out the interval first.
export function useVisiblePolling(active, fn, intervalMs) {
  const saved = React.useRef(fn);
  saved.current = fn;

  React.useEffect(() => {
    if (!active) return undefined;

    let timer = null;
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const start = () => { if (!timer) timer = setInterval(() => saved.current(), intervalMs); };

    const sync = () => {
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      if (hidden) { stop(); return; }
      saved.current();
      start();
    };

    sync();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", sync);
    return () => {
      stop();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", sync);
    };
  }, [active, intervalMs]);
}

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

export function SnapshotPanel({ snapshot, onBuildSnapshot, buildingSnapshot, onRefresh, refreshingOverview, onCleared }) {
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

// Quick Scan.
//
// This was a title, one sentence and a button on an otherwise empty page, which made a
// working part of the pipeline read as unfinished. The scan itself was never the problem --
// what was missing is that a top-up is only meaningful *relative to the full pass it is
// topping up*. On its own "5,740 issues" answers nothing; next to "your last full scan was
// 2 days ago" it is the whole story.
//
// So this panel states its own result, then states the gap it is covering.
export function DeltaIssueScanPanel({ deltaIssueScan, issueScan, onStartDelta, issueScanDeltaStarting }) {
  const deltaActive = deltaIssueScan?.state === "building" || deltaIssueScan?.state === "queued";
  const deltaReady = deltaIssueScan?.state === "ready";
  const deltaFailed = deltaIssueScan?.state === "failed";
  const deltaPercent = deltaIssueScan?.totalIssues > 0
    ? Math.min(100, Math.round((Number(deltaIssueScan.processedIssues || 0) / Number(deltaIssueScan.totalIssues)) * 100))
    : 0;

  // Whole days since the last completed full pass. This is the number the whole panel turns
  // on: a quick scan is a patch over exactly this window, so its value rises as the number
  // grows -- and past about a week it stops being a patch and starts being a wallpaper.
  const fullScanAt = issueScan?.completedAt ? new Date(issueScan.completedAt).getTime() : null;
  const daysSinceFull = fullScanAt ? Math.floor((Date.now() - fullScanAt) / 86400000) : null;
  const staleFull = daysSinceFull !== null && daysSinceFull >= 7;

  return (
    <div className="delta-scan-panel">
      <PageHeader
        title="Quick Scan"
        description="Re-reads only the issues created or updated in the last 24 hours and refreshes field usage for every field×project pair they touch. It runs automatically after each full scan and inventory snapshot; run it by hand when something changed and you do not want to pay for a full pass."
        actions={
          <button className="primary-button" type="button" onClick={onStartDelta} disabled={issueScanDeltaStarting || deltaActive}>
            <Icon name="activity" size={14} />
            {issueScanDeltaStarting || deltaActive ? "Running…" : "Run quick scan"}
          </button>
        }
      />

      <StatRow>
        <StatTile
          label="Last run"
          value={deltaIssueScan?.completedAt ? formatRelativeTime(deltaIssueScan.completedAt) : "Never"}
          hint={deltaIssueScan?.completedAt ? formatShortTime(deltaIssueScan.completedAt) : "no quick scan recorded"}
          tone={deltaActive ? "active" : deltaReady ? "success" : "neutral"}
          icon="clock"
        />
        <StatTile
          label="Issues re-read"
          value={(deltaIssueScan?.processedIssues || 0).toLocaleString()}
          hint="changed in the last 24h"
          icon="layers"
        />
        <StatTile
          label="Usage pairs refreshed"
          value={(deltaIssueScan?.fieldProjectPairsUpdated || 0).toLocaleString()}
          hint="field × project counts corrected"
          icon="barChart"
        />
        <StatTile
          label="Full scan age"
          value={daysSinceFull === null ? "—" : daysSinceFull === 0 ? "Today" : `${daysSinceFull}d`}
          hint={daysSinceFull === null ? "no full scan recorded" : staleFull ? "quick scans only patch 24h" : "within the top-up window"}
          tone={daysSinceFull === null ? "neutral" : staleFull ? "warning" : "success"}
          icon="zap"
        />
      </StatRow>

      {deltaActive && (
        <div className="delta-scan-panel__progress">
          <div className="issue-scan-panel__bar-track"><div className="issue-scan-panel__bar-fill" style={{ width: `${deltaPercent}%` }} /></div>
          <div className="issue-scan-panel__status">
            {deltaIssueScan?.state === "queued"
              ? "Queued…"
              : `${deltaPercent}% — ${(deltaIssueScan?.processedIssues || 0).toLocaleString()} of ${(deltaIssueScan?.totalIssues || 0).toLocaleString()} issues`}
          </div>
        </div>
      )}

      {deltaFailed && deltaIssueScan?.lastError && <div className="issue-scan-panel__error">{deltaIssueScan.lastError}</div>}

      <Panel title="What a quick scan can and cannot fix" icon="info">
        <ul className="delta-scan-panel__facts">
          <li><strong>Covers</strong> issues touched in the last 24 hours, and only the field×project pairs those issues appear in.</li>
          <li><strong>Does not cover</strong> a field that stopped being used — nothing changed on those issues, so nothing is re-read. Only a full pass notices absence.</li>
          <li><strong>Does not populate</strong> the change timestamps the staleness finding reads. Those come from field usage jobs alone.</li>
        </ul>
        {staleFull && (
          <EmptyState inline>
            The last full scan was {daysSinceFull} days ago. Quick scans have patched each 24-hour
            window since, but usage that decayed rather than changed will not have been noticed.
            Run a Universe Scan to re-establish the baseline.
          </EmptyState>
        )}
      </Panel>
    </div>
  );
}

export function ScanProgressChart({ data }) {
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

export function ScanHistoryChart({ data }) {
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

// Net new issues between consecutive runs.
//
// The absolute-total bar chart above it is close to useless on a real site: a corpus that
// moves from 326,871 to 328,528 renders eight bars of identical height, because the thing
// being charted barely varies. The growth *between* runs is what actually moves, and it is
// the number that tells an admin whether the estate is accelerating -- so it gets its own
// chart with a real zero line rather than being hidden inside a near-constant.
export function ScanDeltaChart({ data }) {
  if (data.length === 0) {
    return <div className="scan-chart-card__empty">Needs two completed runs to show growth</div>;
  }
  const W = 480, H = 130, P = { t: 12, r: 16, b: 22, l: 52 };
  const cW = W - P.l - P.r, cH = H - P.t - P.b;
  const maxAbs = Math.max(...data.map((d) => Math.abs(d.delta)), 1);
  // Only give up half the height to negatives when negatives actually occur. A re-scan that
  // finds fewer issues is real (issues get deleted), but it is rare, and reserving space for
  // it on every site would halve the resolution of the common case.
  const hasNegative = data.some((d) => d.delta < 0);
  const zeroY = hasNegative ? cH / 2 : cH;
  const scale = (v) => (Math.abs(v) / maxAbs) * (hasNegative ? cH / 2 : cH);
  const step = cW / Math.max(data.length, 1);
  const barW = Math.max(4, step * 0.7);
  const fmt = (v) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v));
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block", overflow: "visible" }} role="img" aria-label="Net new issues per scan run">
      <g transform={`translate(${P.l},${P.t})`}>
        <line x1={0} y1={zeroY} x2={cW} y2={zeroY} stroke="var(--stroke)" />
        <text x={-6} y={zeroY + 4} textAnchor="end" fontSize="9" fill="var(--muted)">0</text>
        <text x={-6} y={zeroY - scale(maxAbs) + 4} textAnchor="end" fontSize="9" fill="var(--muted)">{fmt(maxAbs)}</text>
        {data.map((d, i) => {
          const h = Math.max(2, scale(d.delta));
          const x = step * i + (step - barW) / 2;
          const up = d.delta >= 0;
          return (
            <g key={i}>
              <rect
                x={x}
                y={up ? zeroY - h : zeroY}
                width={barW}
                height={h}
                rx="2"
                fill={up ? "rgba(126,200,164,0.75)" : "rgba(224,124,109,0.75)"}
              />
              <text x={x + barW / 2} y={cH + 14} textAnchor="middle" fontSize="9" fill="var(--muted)">{d.label}</text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

// Duration per run, with throughput overlaid.
//
// Two encodings on one chart because the question is a comparison: a run getting slower is
// only interesting if the rate dropped too. Duration rising while throughput holds means the
// corpus grew; duration rising while throughput falls means the scan is degrading -- rate
// limiting, contention, a slow worker. Separate charts would make that read a memory test.
export function ScanThroughputChart({ data }) {
  if (data.length === 0) {
    return <div className="scan-chart-card__empty">No completed runs with timing recorded</div>;
  }
  const W = 480, H = 130, P = { t: 12, r: 40, b: 22, l: 52 };
  const cW = W - P.l - P.r, cH = H - P.t - P.b;
  const maxMin = Math.max(...data.map((d) => d.minutes), 1);
  const maxRate = Math.max(...data.map((d) => d.rate), 1);
  const step = cW / Math.max(data.length, 1);
  const barW = Math.max(4, step * 0.6);
  const rateY = (r) => cH - (r / maxRate) * cH;
  const centre = (i) => step * i + step / 2;
  const linePath = data
    .map((d, i) => `${i === 0 ? "M" : "L"} ${centre(i).toFixed(1)} ${rateY(d.rate).toFixed(1)}`)
    .join(" ");
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block", overflow: "visible" }} role="img" aria-label="Scan duration and throughput per run">
      <g transform={`translate(${P.l},${P.t})`}>
        {[0, 0.5, 1].map((r, i) => (
          <g key={i}>
            <line x1={0} y1={cH - r * cH} x2={cW} y2={cH - r * cH} stroke="var(--stroke)" strokeDasharray="3 5" />
            <text x={-6} y={cH - r * cH + 4} textAnchor="end" fontSize="9" fill="var(--muted)">
              {`${Math.round(maxMin * r)}m`}
            </text>
            <text x={cW + 6} y={cH - r * cH + 4} textAnchor="start" fontSize="9" fill="#79b8ff">
              {`${Math.round(maxRate * r)}/s`}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const h = Math.max(2, (d.minutes / maxMin) * cH);
          return (
            <g key={i}>
              <rect x={centre(i) - barW / 2} y={cH - h} width={barW} height={h} rx="2" fill="rgba(126,200,164,0.45)" />
              <text x={centre(i)} y={cH + 14} textAnchor="middle" fontSize="9" fill="var(--muted)">{d.label}</text>
            </g>
          );
        })}
        <path d={linePath} fill="none" stroke="#79b8ff" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) => (
          <circle key={i} cx={centre(i)} cy={rateY(d.rate)} r={2.5} fill="#79b8ff" />
        ))}
      </g>
    </svg>
  );
}

export function UniverseScanPanel({ issueScan, onStart, onResume, onCancel, issueScanLoading, issueScanResuming, issueScanCancelling }) {
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

  // Growth between consecutive runs. Runs arrive oldest-first, so each entry pairs with the
  // one before it; the first run has nothing to compare against and is dropped rather than
  // charted as its own total, which would read as a huge spike.
  const deltaSeries = React.useMemo(() => {
    const out = [];
    for (let i = 1; i < scanHistoryRuns.length; i += 1) {
      const prev = scanHistoryRuns[i - 1]?.processedIssues || 0;
      const curr = scanHistoryRuns[i]?.processedIssues || 0;
      out.push({
        delta: curr - prev,
        label: scanHistoryRuns[i].completedAt
          ? new Date(scanHistoryRuns[i].completedAt).toLocaleDateString([], { month: "short", day: "numeric" })
          : "?",
      });
    }
    return out;
  }, [scanHistoryRuns]);

  // Duration and rate per run. A run missing either timestamp is skipped rather than shown
  // as zero minutes -- an unmeasured run and an instant run are different claims.
  const throughputSeries = React.useMemo(() =>
    scanHistoryRuns
      .filter((run) => run.startedAt && run.completedAt)
      .map((run) => {
        const ms = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
        const seconds = Math.max(ms / 1000, 1);
        return {
          minutes: Math.round(ms / 60000),
          rate: Math.round((run.processedIssues || 0) / seconds),
          label: new Date(run.completedAt).toLocaleDateString([], { month: "short", day: "numeric" }),
        };
      })
      .filter((row) => Number.isFinite(row.minutes) && row.minutes >= 0),
    [scanHistoryRuns]
  );

  const showCharts =
    progressSeries.length >= 2 || historySeries.length >= 1 || deltaSeries.length >= 1 || throughputSeries.length >= 1;

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

      {/* The fifth and last stat dialect, retired. Worker progress and scan rate keep their
          denominators as hints rather than shrunken inline spans -- "5" reads as the metric
          and "of 5 workers" as the context, which is the split the tile already encodes. */}
      {hasStats && (
        <StatRow>
          <StatTile label="Issues scanned" value={Number(displayIssues).toLocaleString()} icon="layers" />
          {totalProjects > 0 && (
            <StatTile
              label="Workers complete"
              value={processedProjects.toLocaleString()}
              hint={`of ${totalProjects.toLocaleString()}`}
              tone={processedProjects >= totalProjects ? "success" : "active"}
              icon="activity"
            />
          )}
          {durationLabel && <StatTile label="Duration" value={durationLabel} icon="clock" />}
          {scanRate && (
            <StatTile label="Avg scan rate" value={scanRate.toLocaleString()} hint="issues per second" icon="zap" />
          )}
          {totalLogCount > 0 && <StatTile label="Log entries" value={totalLogCount} icon="barChart" />}
          {scanHistoryRuns.length > 0 && (
            <StatTile label="Past runs" value={scanHistoryRuns.length} icon="checkCircle" />
          )}
        </StatRow>
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
          {deltaSeries.length >= 1 && (
            <div className="scan-chart-card">
              <div className="scan-chart-card__title">Net new issues — run over run</div>
              <ScanDeltaChart data={deltaSeries} />
              <div className="scan-chart-card__caption">Growth between consecutive scans. The totals above barely move; this is where the change is.</div>
            </div>
          )}
          {throughputSeries.length >= 1 && (
            <div className="scan-chart-card">
              <div className="scan-chart-card__title">Duration &amp; throughput</div>
              <ScanThroughputChart data={throughputSeries} />
              <div className="scan-chart-card__caption">Bars are minutes per run, the line is issues per second. Duration up with the rate flat means the estate grew; both worsening means the scan is degrading.</div>
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

export function ScansTab({ siteOrigin, initialSection }) {
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

  useVisiblePolling(
    snapshotStatus?.state === "building" || snapshotStatus?.state === "queued",
    () => fetchSnapshotStatus({ quiet: true }),
    8000
  );

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

  // 15s, not 8s: a full scan runs for over an hour, so 8-second granularity was finer
  // than anyone reads while costing two resolver invocations -- and their SQL reads --
  // every 8 seconds for the whole run.
  useVisiblePolling(
    issueScanStatus?.state === "building" || issueScanStatus?.state === "queued",
    () => { fetchIssueScanStatus(); fetchDeltaStatus(); },
    15000
  );

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
            issueScan={issueScanStatus}
            onStartDelta={startDeltaScan}
            issueScanDeltaStarting={issueScanDeltaStarting}
          />
        )}
        {activeSection === "jobs" && (
          <>
            <div style={{ marginBottom: 16 }}>
              <StatRow>
                <StatTile label="Ready" value={jobCounts?.ready ?? 0} icon="checkCircle" tone="success" />
                <StatTile label="Building" value={jobCounts?.building ?? 0} icon="activity" tone={(jobCounts?.building ?? 0) > 0 ? "active" : "neutral"} />
                <StatTile label="Queued" value={jobCounts?.queued ?? 0} icon="clock" tone="neutral" />
                <StatTile label="Failed" value={jobCounts?.failed ?? 0} icon="x" tone={(jobCounts?.failed ?? 0) > 0 ? "critical" : "neutral"} />
                <StatTile
                  label="Not built"
                  value={jobCounts?.unbuilt ?? 0}
                  icon="layers"
                  tone="neutral"
                  hint={(jobCounts?.unbuilt ?? 0) > 0 ? "Staleness detection is blind on these" : undefined}
                />
              </StatRow>
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
