import React from "react";
import { invoke, view } from "@forge/bridge";
import { formatTimestamp, formatShortTime, formatRelativeTime, formatNumber } from "../utils";
import { Icon, useLiveDuration, useLiveElapsedMs } from "../components/Icons";
import { SubNavLayout, Toggle, ConfigSection, ConfigRow } from "../components/admin/primitives";
import {
  StatTile,
  StatRow,
  PageHeader,
  Panel,
  EmptyState,
  StageRail,
  LinkButton,
  formatDurationMs,
} from "../components/ui";
import { useVisiblePolling, usePersistentState } from "../hooks";

// Re-exported: this started here before three surfaces needed it, and the ScansTab tests
// still import it from this module.
export { useVisiblePolling };

// The operator surface for the scan pipeline: a full scan (every pillar, in dependency
// order) and a quick scan (the same estate, minus the four pillars Jira gives no
// changed-since signal for -- those still run in full every time; only the issue crawl is
// windowed). Snapshot builds and the issue crawl used to be their own standalone tabs here;
// both are stages a scan runs now, so what is left of their old panels is folded into
// whichever scan is driving them -- see IssueCrawlLiveView and SnapshotRecoveryNotice.
//
// The RQT index used to render here too, purely because the issue crawl is what builds it.
// That is a build dependency, not a reason to browse it from the operator's tab: this tab
// runs and monitors scans, every other tab reads what they produced. It now lives under
// Reports, which is where a cross-reference over field values belongs.

// The word a user must type to confirm destroying every snapshot. Deliberately not
// "yes": the point is that it cannot be typed by reflex.
const CLEAR_CONFIRMATION_WORD = "DELETE";

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
          Snapshot data cleared — {result.totalRowsDeleted.toLocaleString()} rows removed. Build a new snapshot to
          repopulate.
        </div>
      )}

      {!open ? (
        <div className="danger-zone__row">
          <p className="danger-zone__desc">
            Delete all indexed field data and start over. Use this to recover from a corrupted snapshot, or to purge
            site data on request.
          </p>
          <button
            className="danger-button"
            type="button"
            onClick={() => {
              setOpen(true);
              setResult(null);
            }}
          >
            Clear snapshot data
          </button>
        </div>
      ) : (
        <div className="danger-zone__confirm">
          <p className="danger-zone__desc">
            This permanently deletes the field catalog, per-project usage, field summaries, cached options, issue scan
            state and report job history. A full rebuild will be required, which can take hours on a large site.
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
            <button className="danger-button" type="button" onClick={handleClear} disabled={!confirmed || clearing}>
              {clearing ? "Clearing…" : "Clear everything"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="danger-zone__error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function ScanProgressChart({ data }) {
  if (data.length < 2) {
    return <div className="scan-chart-card__empty">{data.length === 0 ? "No progress data yet" : "Running…"}</div>;
  }
  const W = 480,
    H = 130,
    P = { t: 12, r: 16, b: 22, l: 52 };
  const cW = W - P.l - P.r,
    cH = H - P.t - P.b;
  const minT = data[0].t,
    maxT = data[data.length - 1].t,
    maxV = Math.max(...data.map((d) => d.count));
  const xS = (t) => (maxT > minT ? (t - minT) / (maxT - minT) : 0.5) * cW;
  const yS = (v) => cH - (v / (maxV || 1)) * cH;
  const pathD = data.map((d, i) => `${i === 0 ? "M" : "L"} ${xS(d.t).toFixed(1)} ${yS(d.count).toFixed(1)}`).join(" ");
  const areaD = `${pathD} L ${xS(data[data.length - 1].t).toFixed(1)} ${cH} L 0 ${cH} Z`;
  const yTicks = [0, 0.5, 1].map((r) => ({
    y: yS(maxV * r),
    label: maxV * r >= 1000 ? `${Math.round((maxV * r) / 1000)}k` : String(Math.round(maxV * r)),
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
            <text x={-6} y={t.y + 4} textAnchor="end" fontSize="9" fill="var(--muted)">
              {t.label}
            </text>
          </g>
        ))}
        <path d={areaD} fill="url(#sp-grad)" />
        <path d={pathD} fill="none" stroke="#79b8ff" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={xS(data[data.length - 1].t)} cy={yS(data[data.length - 1].count)} r={3.5} fill="#79b8ff" />
        {xTicks.map((d, i) => (
          <text
            key={i}
            x={xS(d.t)}
            y={cH + 14}
            textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
            fontSize="9"
            fill="var(--muted)"
          >
            {d.label}
          </text>
        ))}
      </g>
    </svg>
  );
}

export function ScanHistoryChart({ data }) {
  if (data.length === 0) {
    return <div className="scan-chart-card__empty">No completed scan runs recorded yet</div>;
  }
  const W = 480,
    H = 130,
    P = { t: 12, r: 16, b: 22, l: 52 };
  const cW = W - P.l - P.r,
    cH = H - P.t - P.b;
  const maxV = Math.max(...data.map((d) => d.issues), 1);
  const step = cW / Math.max(data.length, 1);
  const barW = Math.max(4, step * 0.7);
  const yTicks = [0, 0.5, 1].map((r) => ({
    y: cH - r * cH,
    label: maxV * r >= 1000 ? `${Math.round((maxV * r) / 1000)}k` : String(Math.round(maxV * r)),
  }));
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block", overflow: "visible" }}>
      <g transform={`translate(${P.l},${P.t})`}>
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={0} y1={t.y} x2={cW} y2={t.y} stroke="var(--stroke)" strokeDasharray="3 5" />
            <text x={-6} y={t.y + 4} textAnchor="end" fontSize="9" fill="var(--muted)">
              {t.label}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const h = Math.max(2, (d.issues / maxV) * cH);
          const x = step * i + (step - barW) / 2;
          const opacity = 0.35 + (d.issues / maxV) * 0.55;
          return (
            <g key={i}>
              <rect x={x} y={cH - h} width={barW} height={h} rx="2" fill={`rgba(126,200,164,${opacity.toFixed(2)})`} />
              <text x={x + barW / 2} y={cH + 14} textAnchor="middle" fontSize="9" fill="var(--muted)">
                {d.label}
              </text>
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
  const W = 480,
    H = 130,
    P = { t: 12, r: 16, b: 22, l: 52 };
  const cW = W - P.l - P.r,
    cH = H - P.t - P.b;
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
    <svg
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      style={{ display: "block", overflow: "visible" }}
      role="img"
      aria-label="Net new issues per scan run"
    >
      <g transform={`translate(${P.l},${P.t})`}>
        <line x1={0} y1={zeroY} x2={cW} y2={zeroY} stroke="var(--stroke)" />
        <text x={-6} y={zeroY + 4} textAnchor="end" fontSize="9" fill="var(--muted)">
          0
        </text>
        <text x={-6} y={zeroY - scale(maxAbs) + 4} textAnchor="end" fontSize="9" fill="var(--muted)">
          {fmt(maxAbs)}
        </text>
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
              <text x={x + barW / 2} y={cH + 14} textAnchor="middle" fontSize="9" fill="var(--muted)">
                {d.label}
              </text>
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
  const W = 480,
    H = 130,
    P = { t: 12, r: 40, b: 22, l: 52 };
  const cW = W - P.l - P.r,
    cH = H - P.t - P.b;
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
    <svg
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      style={{ display: "block", overflow: "visible" }}
      role="img"
      aria-label="Scan duration and throughput per run"
    >
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
              <text x={centre(i)} y={cH + 14} textAnchor="middle" fontSize="9" fill="var(--muted)">
                {d.label}
              </text>
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

// Every derived figure the crawl views need, computed once from the same issue_scan_meta
// shape Full Scan and Quick Scan both hand off to runIssueScanCoordinator (Quick Scan's
// issues-delta stage is the one exception -- it writes a "::delta"-scoped row instead, read
// by getDeltaIssueScanStatus, but the shape is identical so every consumer below renders
// either one unchanged).
//
// Split out so the summary card, the charts and the audit log -- three different sub-tabs
// now -- can each call this on the same `issueScan` prop rather than one component computing
// all of it and the other two reaching into its internals. Recomputing is cheap: this is pure
// derivation over an array already in memory, not a fetch.
function useIssueCrawlData(issueScan) {
  const [logSearch, setLogSearch] = React.useState("");

  const scanActive = issueScan?.state === "building" || issueScan?.state === "queued";
  const scanDone = issueScan?.state === "ready";
  const scanFailed = issueScan?.state === "failed";
  const scanCancelled = issueScan?.state === "cancelled";
  const lastScanLogAt = issueScan?.progressLog?.length
    ? issueScan.progressLog[issueScan.progressLog.length - 1]?.t
    : issueScan?.startedAt;
  const scanStale = lastScanLogAt ? Date.now() - new Date(lastScanLogAt).getTime() > 10 * 60 * 1000 : scanActive;
  const canResume = issueScan && !scanDone && ((scanActive && scanStale) || scanFailed || scanCancelled);
  const canForceResume = scanActive && scanStale;
  const processedIssues = Number(issueScan?.processedIssues || 0);
  const processedProjects = Number(issueScan?.processedPages || 0);
  const totalProjects = Number(issueScan?.totalPages || 0);
  const scanPercent = totalProjects > 0 ? Math.min(100, Math.round((processedProjects / totalProjects) * 100)) : 0;
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
    const m = Math.floor(remainingSec / 60),
      s = remainingSec % 60;
    return m > 0 ? `~${m}m ${s}s remaining` : `~${s}s remaining`;
  }, [scanActive, issueScan?.processedPages, issueScan?.totalPages, issueScan?.startedAt, elapsed]);

  // Current run's entries newest-first (for count / search)
  const currentEntries = React.useMemo(
    () => (issueScan?.progressLog?.length ? [...issueScan.progressLog].reverse() : []),
    [issueScan?.progressLog],
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
      result.push({
        type: "run-header",
        key: "current",
        startedAt: issueScan?.startedAt,
        completedAt: issueScan?.completedAt,
        processedIssues: issueScan?.processedIssues || 0,
        isCurrent: true,
      });
      currentEntries.forEach((e) => result.push({ type: "log", ...e }));
    }
    [...scanHistoryRuns].reverse().forEach((run, i) => {
      result.push({
        type: "run-header",
        key: `hist-${i}`,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        processedIssues: run.processedIssues || 0,
        isCurrent: false,
      });
      [...(run.progressLog || [])].reverse().forEach((e) => result.push({ type: "log", ...e }));
    });
    return result;
  }, [currentEntries, scanHistoryRuns, issueScan?.startedAt, issueScan?.completedAt, issueScan?.processedIssues]);

  // Flat list of all log entries for search
  const flatAllEntries = React.useMemo(() => {
    const entries = [...currentEntries];
    [...scanHistoryRuns].reverse().forEach((run) => {
      entries.push(...[...(run.progressLog || [])].reverse());
    });
    return entries;
  }, [currentEntries, scanHistoryRuns]);

  // Filtered view (searching shows flat entries without run separators)
  const filteredEntries = React.useMemo(() => {
    if (!logSearch.trim()) return null;
    const q = logSearch.toLowerCase();
    return flatAllEntries.filter(
      (e) => e.msg?.toLowerCase().includes(q) || formatShortTime(e.t).toLowerCase().includes(q),
    );
  }, [flatAllEntries, logSearch]);

  // Chart data: parse current-run log for issue counts over time
  const progressSeries = React.useMemo(() => {
    const entries = issueScan?.progressLog || [];
    const parsed = [];
    for (const entry of entries) {
      const match = entry.msg.match(/^([0-9,]+)(?:\s*\/\s*[0-9,]+)?\s+issues?\s+(?:scanned|on\s+site)/i);
      if (match) {
        parsed.push({
          t: new Date(entry.t).getTime(),
          count: parseInt(match[1].replace(/,/g, ""), 10),
          label: formatShortTime(entry.t),
        });
      }
    }
    return parsed;
  }, [issueScan?.progressLog]);

  // Chart data: historical runs bar chart
  const historySeries = React.useMemo(
    () =>
      scanHistoryRuns.map((run) => ({
        issues: run.processedIssues || 0,
        label: run.completedAt
          ? new Date(run.completedAt).toLocaleDateString([], { month: "short", day: "numeric" })
          : "?",
      })),
    [scanHistoryRuns],
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
  const throughputSeries = React.useMemo(
    () =>
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
    [scanHistoryRuns],
  );

  const showCharts =
    progressSeries.length >= 2 || historySeries.length >= 1 || deltaSeries.length >= 1 || throughputSeries.length >= 1;

  const stateClass = scanActive
    ? "scan-status--active"
    : scanDone
      ? "scan-status--done"
      : scanFailed
        ? "scan-status--failed"
        : "scan-status--idle";
  const stateLabel = scanActive
    ? "Running"
    : scanDone
      ? "Complete"
      : scanFailed
        ? "Failed"
        : scanCancelled
          ? "Cancelled"
          : "Not started";
  const displayIssues = scanDone ? issueScan?.processedIssues || issueScan?.totalIssues || 0 : processedIssues;
  const hasStats = scanDone || scanActive || processedIssues > 0;

  // Nothing has ever crawled this row -- the parent scan's own stage table already says
  // "Waiting", so a second, emptier statement of the same fact here would just be noise.
  const everCrawled = Boolean(issueScan?.startedAt || issueScan?.scanHistory?.length);

  return {
    logSearch,
    setLogSearch,
    scanActive,
    scanDone,
    scanFailed,
    scanCancelled,
    everCrawled,
    stateClass,
    stateLabel,
    canResume,
    canForceResume,
    processedIssues,
    displayIssues,
    processedProjects,
    totalProjects,
    scanPercent,
    elapsed,
    durationLabel,
    scanRate,
    etaLabel,
    totalLogCount,
    scanHistoryRuns,
    allRunEntries,
    filteredEntries,
    progressSeries,
    historySeries,
    deltaSeries,
    throughputSeries,
    showCharts,
    hasStats,
  };
}

// The header, live stats, progress bar, resume/cancel controls and timestamps -- what an
// operator needs while a scan is running or just finished, without the charts or the full
// log competing with it for the same screen. Lives inline in the Full/Quick Scan panels;
// the charts and the log each moved to their own sub-tab (IssueCrawlCharts,
// IssueCrawlAuditLog below) once both grew past what a "meanwhile" panel should carry.
export function IssueCrawlSummary({
  issueScan,
  onResume,
  onCancel,
  resuming,
  cancelling,
  title = "Issue crawl",
  readOnly = false,
}) {
  const d = useIssueCrawlData(issueScan);
  if (!d.everCrawled) return null;

  return (
    <div className="universe-scan-panel">
      <div className="universe-scan-panel__head">
        <div className="universe-scan-panel__title-row">
          <h3 className="universe-scan-panel__title">{title}</h3>
          <span className={`scan-status-pill ${d.stateClass}`}>{d.stateLabel}</span>
        </div>
        <p className="universe-scan-panel__desc">
          Crawls every issue across all Jira projects in parallel workers to compute per-project field usage counts,
          detect RQT-pattern values, and build the complete field inventory.
          {issueScan?.completedAt ? ` Last completed ${formatTimestamp(issueScan.completedAt)}.` : ""}
        </p>
      </div>

      {/* The fifth and last stat dialect, retired. Worker progress and scan rate keep their
          denominators as hints rather than shrunken inline spans -- "5" reads as the metric
          and "of 5 workers" as the context, which is the split the tile already encodes. */}
      {d.hasStats && (
        <StatRow>
          <StatTile label="Issues scanned" value={Number(d.displayIssues).toLocaleString()} icon="layers" />
          {d.totalProjects > 0 && (
            <StatTile
              label="Workers complete"
              value={d.processedProjects.toLocaleString()}
              hint={`of ${d.totalProjects.toLocaleString()}`}
              tone={d.processedProjects >= d.totalProjects ? "success" : "active"}
              icon="activity"
            />
          )}
          {d.durationLabel && <StatTile label="Duration" value={d.durationLabel} icon="clock" />}
          {d.scanRate && (
            <StatTile label="Avg scan rate" value={d.scanRate.toLocaleString()} hint="issues per second" icon="zap" />
          )}
          {d.totalLogCount > 0 && <StatTile label="Log entries" value={d.totalLogCount} icon="barChart" />}
          {d.scanHistoryRuns.length > 0 && (
            <StatTile label="Past runs" value={d.scanHistoryRuns.length} icon="checkCircle" />
          )}
        </StatRow>
      )}

      <div className="universe-scan-panel__controls">
        {d.scanActive && (
          <div className="universe-scan-panel__progress">
            <div className="universe-scan-panel__progress-bar">
              <div className="universe-scan-panel__progress-fill" style={{ width: `${d.scanPercent}%` }} />
            </div>
            <div className="universe-scan-panel__progress-text">
              <span>
                {d.totalProjects > 0
                  ? `${d.scanPercent}% — ${d.processedProjects}/${d.totalProjects} workers`
                  : "Starting…"}
              </span>
              {d.elapsed && <span className="universe-scan-panel__elapsed">{d.elapsed}</span>}
            </div>
            {d.processedIssues > 0 && (
              <div className="universe-scan-panel__issues-live">
                {d.processedIssues.toLocaleString()} issues scanned
              </div>
            )}
            {d.etaLabel && <div className="universe-scan-panel__eta">{d.etaLabel}</div>}
          </div>
        )}

        {!readOnly && (d.canResume || d.scanActive) && (
          <div className="universe-scan-panel__action-row">
            {d.canResume && (
              <button
                className="secondary-button secondary-button--small"
                type="button"
                onClick={onResume}
                disabled={resuming}
              >
                {resuming ? "Resuming…" : d.canForceResume ? "Force resume" : "Resume crawl"}
              </button>
            )}
            {d.scanActive && (
              <button
                className="secondary-button secondary-button--small"
                type="button"
                onClick={onCancel}
                disabled={cancelling}
              >
                {cancelling ? "Cancelling…" : "Cancel crawl"}
              </button>
            )}
          </div>
        )}

        {(d.scanFailed || d.scanCancelled) && issueScan?.lastError && (
          <div className="universe-scan-panel__error">{issueScan.lastError}</div>
        )}

        {issueScan?.startedAt && (
          <div className="universe-scan-panel__timestamps">
            <div>
              <span className="scan-ts-label">Started</span>
              {formatTimestamp(issueScan.startedAt)}
            </div>
            {issueScan.completedAt && (
              <div>
                <span className="scan-ts-label">Completed</span>
                {formatTimestamp(issueScan.completedAt)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// The four trend charts, alone: how a run progresses, how the corpus grows run over run, and
// whether the scan itself is getting slower. Pulled out of the "meanwhile" summary above
// into its own Reports sub-tab -- a chart that answers "is this normal" is a different
// question from "is this scan currently healthy", and stacking both under one heading made
// the second one scroll past before anyone reached it.
export function IssueCrawlCharts({ issueScan, title = "Issue crawl" }) {
  const d = useIssueCrawlData(issueScan);
  if (!d.everCrawled) {
    return <EmptyState inline>No scan has run yet. Charts appear once the first crawl completes.</EmptyState>;
  }
  if (!d.showCharts) {
    return <EmptyState inline>Not enough data yet for a trend. Charts need at least one completed run.</EmptyState>;
  }

  return (
    <div className="universe-scan-panel__charts">
      {d.progressSeries.length >= 2 && (
        <div className="scan-chart-card">
          <div className="scan-chart-card__title">{title} — current run</div>
          <ScanProgressChart data={d.progressSeries} />
        </div>
      )}
      {d.historySeries.length >= 1 && (
        <div className="scan-chart-card">
          <div className="scan-chart-card__title">{title} — run history</div>
          <ScanHistoryChart data={d.historySeries} />
        </div>
      )}
      {d.deltaSeries.length >= 1 && (
        <div className="scan-chart-card">
          <div className="scan-chart-card__title">Net new issues — run over run</div>
          <ScanDeltaChart data={d.deltaSeries} />
          <div className="scan-chart-card__caption">
            Growth between consecutive scans. The totals above barely move; this is where the change is.
          </div>
        </div>
      )}
      {d.throughputSeries.length >= 1 && (
        <div className="scan-chart-card">
          <div className="scan-chart-card__title">Duration &amp; throughput</div>
          <ScanThroughputChart data={d.throughputSeries} />
          <div className="scan-chart-card__caption">
            Bars are minutes per run, the line is issues per second. Duration up with the rate flat means the estate
            grew; both worsening means the scan is degrading.
          </div>
        </div>
      )}
    </div>
  );
}

// The searchable, multi-run audit log, alone. Pulled out for the same reason as the charts:
// an operator checking "did the scan actually run last Tuesday" does not also want four SVGs
// and a progress bar between them and the search box.
export function IssueCrawlAuditLog({ issueScan }) {
  const d = useIssueCrawlData(issueScan);
  if (!d.everCrawled) {
    return <EmptyState inline>No log entries yet. Start a scan to populate the audit log.</EmptyState>;
  }

  return (
    <div className="universe-scan-panel__log-col">
      <div className="universe-scan-panel__log-head">
        <span className="universe-scan-panel__log-count">
          {d.totalLogCount} entr{d.totalLogCount !== 1 ? "ies" : "y"}
        </span>
        {d.scanHistoryRuns.length > 0 && (
          <span className="universe-scan-panel__log-runs">{d.scanHistoryRuns.length + 1} runs</span>
        )}
        <label className="ui-controls__search universe-scan-panel__log-search">
          <span className="ui-controls__srlabel">Search the audit log</span>
          <Icon name="search" size={13} />
          <input
            type="search"
            placeholder="Search all runs…"
            value={d.logSearch}
            onChange={(e) => d.setLogSearch(e.target.value)}
          />
        </label>
      </div>
      <div className="universe-scan-panel__log scan-log">
        {d.filteredEntries ? (
          d.filteredEntries.length > 0 ? (
            d.filteredEntries.map((entry, i) => {
              const isComplete = /complete|done|finished/i.test(entry.msg);
              const isError = /error|fail/i.test(entry.msg);
              const isWarn = /warn|stale|slow|timeout/i.test(entry.msg);
              return (
                <div
                  key={i}
                  className={`scan-log__entry${isComplete ? " scan-log__entry--complete" : ""}${isError ? " scan-log__entry--error" : ""}${isWarn ? " scan-log__entry--warn" : ""}`}
                >
                  <span className="scan-log__time">{formatShortTime(entry.t)}</span>
                  <span className="scan-log__msg">{entry.msg}</span>
                </div>
              );
            })
          ) : (
            <div
              className="empty-state empty-state--inline"
              style={{ padding: "24px 16px" }}
            >{`No entries match "${d.logSearch}".`}</div>
          )
        ) : d.allRunEntries.length > 0 ? (
          d.allRunEntries.map((item, i) => {
            if (item.type === "run-header") {
              return (
                <div key={item.key} className="scan-log__run-header">
                  <span className="scan-log__run-label">
                    {item.isCurrent
                      ? d.scanDone
                        ? "Latest run"
                        : d.scanActive
                          ? "Current run"
                          : "Last run"
                      : "Previous run"}
                  </span>
                  {item.startedAt && <span className="scan-log__run-date">{formatTimestamp(item.startedAt)}</span>}
                  {item.processedIssues > 0 && (
                    <span className="scan-log__run-issues">{item.processedIssues.toLocaleString()} issues</span>
                  )}
                </div>
              );
            }
            const isComplete = /complete|done|finished/i.test(item.msg);
            const isError = /error|fail/i.test(item.msg);
            const isWarn = /warn|stale|slow|timeout/i.test(item.msg);
            return (
              <div
                key={i}
                className={`scan-log__entry${isComplete ? " scan-log__entry--complete" : ""}${isError ? " scan-log__entry--error" : ""}${isWarn ? " scan-log__entry--warn" : ""}`}
              >
                <span className="scan-log__time">{formatShortTime(item.t)}</span>
                <span className="scan-log__msg">{item.msg}</span>
              </div>
            );
          })
        ) : (
          <div className="empty-state empty-state--inline" style={{ padding: "24px 16px" }}>
            {d.scanActive ? "Waiting for log entries…" : "No log entries yet. Start a scan to populate the audit log."}
          </div>
        )}
      </div>
    </div>
  );
}

// The pre-split view, kept intact: stats, charts and the audit log stacked in one panel, the
// way this rendered before the Scans tab grew a Reports and an Audit Log sub-tab. Nothing in
// the app renders this anymore -- IssueCrawlSummary/IssueCrawlCharts/IssueCrawlAuditLog above
// are what the Full/Quick Scan panels and the new sub-tabs actually use -- but it stays
// exported as a single drop-in for anywhere that genuinely wants everything on one screen.
export function IssueCrawlLiveView(props) {
  const { issueScan, title = "Issue crawl" } = props;
  const everCrawled = Boolean(issueScan?.startedAt || issueScan?.scanHistory?.length);
  if (!everCrawled) return null;

  return (
    <div className="universe-scan-panel universe-scan-panel--combined">
      <IssueCrawlSummary {...props} />
      <IssueCrawlCharts issueScan={issueScan} title={title} />
      <IssueCrawlAuditLog issueScan={issueScan} />
    </div>
  );
}

// One scan that runs every pillar.
//
// Before this, "scan the site" meant knowing which six buttons lived on which six tabs and
// pressing them in the right order -- and getting the order wrong left the tabs disagreeing
// with each other, with nothing to say so. The stages below are the same builds those buttons
// always ran; the only thing that is new is that something sequences them.
// A field snapshot build stuck past the server's own stale threshold (see
// requeueStaleSnapshotBuild) needs a way to force it forward, even though a full scan's own
// "fields" stage runs the exact same build inline and has no button of its own for it.
const SNAPSHOT_STALE_MS = 20 * 60 * 1000;

function SnapshotRecoveryNotice({ snapshot, onForceResume, forceResuming }) {
  if (snapshot?.state !== "building" || !snapshot?.startedAt) return null;
  if (Date.now() - new Date(snapshot.startedAt).getTime() <= SNAPSHOT_STALE_MS) return null;

  return (
    <div
      className="danger-zone__error"
      role="alert"
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}
    >
      <span>The field snapshot build has been stalled for over 20 minutes.</span>
      <button
        className="secondary-button secondary-button--small"
        type="button"
        onClick={onForceResume}
        disabled={forceResuming}
      >
        {forceResuming ? "Resuming…" : "Force resume (stalled)"}
      </button>
    </div>
  );
}

// The orchestrator writes updatedAt on every step, so a run that has gone silent for this
// long is one whose loop stopped -- a lost queue message, a consumer killed mid-stage.
// Mirrors FULL_SCAN_STALL_MS in src/lib/full-scan.js; the hourly trigger recovers it on its
// own, this is the "don't make me wait for the top of the hour" path.
const SCAN_STALL_MS = 20 * 60 * 1000;

function ScanStallRecoveryNotice({ status, onResume, onAbandon, resuming, abandoning }) {
  if (status?.state !== "running" || !status?.updatedAt) return null;
  if (Date.now() - new Date(status.updatedAt).getTime() <= SCAN_STALL_MS) return null;

  return (
    <div
      className="danger-zone__error"
      role="alert"
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}
    >
      <span>This scan has not reported progress for over 20 minutes. Its background loop may have stopped.</span>
      <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          className="secondary-button secondary-button--small"
          type="button"
          onClick={onResume}
          disabled={resuming || abandoning}
        >
          {resuming ? "Resuming…" : "Resume (stalled)"}
        </button>
        <button
          className="secondary-button secondary-button--small"
          type="button"
          onClick={onAbandon}
          disabled={resuming || abandoning}
        >
          {abandoning ? "Abandoning…" : "Abandon scan"}
        </button>
      </span>
    </div>
  );
}

// The scan finished, but some pillars did not build (a persistent 4xx, a sub-build that kept
// failing). Rather than a full re-run that redoes every pillar that succeeded, "Resume"
// retries just the failed/skipped stages -- the same resumeSiteScan endpoint the stall
// notice uses, which routes a completed-with-failures run to the resume path.
function ScanIncompleteNotice({ status, onResume, resuming }) {
  if (status?.state !== "completed-with-failures") return null;
  const incomplete = (status.stages || []).filter((s) => s.state === "failed" || s.state === "skipped");
  if (!incomplete.length) return null;

  return (
    <div
      className="status-banner status-banner--warning"
      role="alert"
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}
    >
      <span>
        {incomplete.length} {incomplete.length === 1 ? "stage" : "stages"} did not build (
        {incomplete.map((s) => s.label || s.key).join(", ")}). The rest are current — resume to retry only those.
      </span>
      <button className="secondary-button secondary-button--small" type="button" onClick={onResume} disabled={resuming}>
        {resuming ? "Resuming…" : `Resume — retry ${incomplete.length} ${incomplete.length === 1 ? "stage" : "stages"}`}
      </button>
    </div>
  );
}

const STAGE_TONE = { done: "success", running: "active", failed: "critical", skipped: "warning", pending: "neutral" };
const STAGE_LABEL = { done: "Done", running: "Running", failed: "Failed", skipped: "Skipped", pending: "Waiting" };

function durationBetween(a, b) {
  const s = Date.parse(a || ""),
    e = Date.parse(b || "");
  return Number.isFinite(s) && Number.isFinite(e) && e >= s ? e - s : null;
}

// A handoff sub-build reports { processed, total } while it works. Trust the pair as a real
// percentage only when it actually is one -- the dashboard build has been seen reporting
// "1,886 of 613", processed past total, which clamps to a meaningless 100%. When the numbers
// disagree, show the count alone and keep the bar indeterminate.
function readStageProgress(p) {
  if (!p) return { counted: false, processed: 0, total: 0, pct: null };
  const processed = Number(p.processed) || 0;
  const total = Number(p.total) || 0;
  const counted = total > 0 && processed <= total;
  return { counted, processed, total, pct: counted ? Math.round((processed / total) * 100) : null };
}

// The typical wall-clock for one stage, taken from the runs already recorded. Median rather
// than mean so a single slow run does not drag the estimate up; only finite positive
// durations count. null when this stage has no history yet.
function medianStageMs(recentRuns, key) {
  const xs = (recentRuns || [])
    .flatMap((r) => r.stages || [])
    .filter((s) => s.key === key && Number(s.durationMs) > 0)
    .map((s) => Number(s.durationMs))
    .sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

// A time-based progress estimate for a stage that reports no count of its own: how far
// through its usual duration this run is. Held at 99% once it runs past that -- the stage is
// not done until the orchestrator says so, and a premature 100% is the one number that
// reads as a lie. Returns null when there is nothing to estimate against.
function estimateStagePct(elapsedMs, expectedMs) {
  if (!expectedMs || expectedMs <= 0) return null;
  return Math.min(99, Math.max(1, Math.round((elapsedMs / expectedMs) * 100)));
}

// The progress figure for whichever stage is currently running: a real count from a handoff
// sub-build when there is one, otherwise a timing estimate against previous runs. Every
// stage gets a bar and a percentage this way -- the inline ones that run start-to-finish in
// one invocation included.
function useRunningStageProgress({ startedAt, recentRuns, stageKey, realProgress }) {
  const elapsedMs = useLiveElapsedMs(startedAt);
  const real = readStageProgress(realProgress);
  const expectedMs = stageKey ? medianStageMs(recentRuns, stageKey) : null;
  const estPct = real.counted ? null : estimateStagePct(elapsedMs, expectedMs);
  const overRun = estPct != null && expectedMs != null && elapsedMs > expectedMs;
  const pct = real.counted ? real.pct : estPct;

  let text;
  if (real.counted) text = `${formatNumber(real.processed)} of ${formatNumber(real.total)} (${real.pct}%)`;
  else if (real.total > 0) text = `${formatNumber(real.processed)} processed`;
  else if (estPct != null)
    text = overRun ? "~99% · running longer than last time" : `~${estPct}% · estimated from previous runs`;
  else text = "no previous run to estimate from yet";

  return { pct, text, estimated: !real.counted && pct != null, indeterminate: pct == null };
}

// One shape the rail and the detail card both read: every stage in run order, each carrying
// its state, timing, attempt count and what it produced -- plus the same figures from the
// previous run, for the deltas.
//
// Counts: prefer the recorded run's number when there is one, fall back to what the pillar
// currently holds (liveStageCounts, read every status poll). A cancelled scan, or one that
// finished before run history existed, has no recorded run -- without the fallback every
// stage would read "Produced —".
function mergeStageData(status) {
  const catalog = status?.catalog || [];
  const running = status?.state === "running";
  const liveByKey = new Map((status?.stages || []).map((s) => [s.key, s]));
  const runs = status?.recentRuns || [];
  const thisRun = running ? null : runs[0];
  const prevRun = running ? runs[0] : runs[1];
  const thisByKey = new Map((thisRun?.stages || []).map((s) => [s.key, s]));
  const prevByKey = new Map((prevRun?.stages || []).map((s) => [s.key, s]));
  const liveCounts = status?.liveStageCounts || {};

  return catalog.map((def) => {
    const live = liveByKey.get(def.key) || {};
    const recorded = thisByKey.get(def.key) || {};
    const prev = prevByKey.get(def.key) || {};
    const source = !running && recorded.state ? recorded : live;
    return {
      key: def.key,
      label: def.label,
      mode: def.mode,
      state: source.state || "pending",
      startedAt: source.startedAt || null,
      completedAt: source.completedAt || null,
      durationMs: recorded.durationMs ?? durationBetween(source.startedAt, source.completedAt),
      attempts: Number(source.attempts) || 0,
      error: source.error || live.error || null,
      count: running
        ? (liveCounts[def.key] ?? recorded.count ?? null)
        : (recorded.count ?? liveCounts[def.key] ?? null),
      prevCount: prev.count ?? null,
      prevDurationMs: prev.durationMs ?? null,
    };
  });
}

// The running scan, up top: which stage, how long it has been going, a real bar when the
// sub-build reports a usable count and an honest sweep when it does not, plus the one action
// that matters mid-run. The ticking "last update" is the real proof of life -- it only moves
// when a poll lands fresh data, so a frozen number is the honest signal something is stuck.
function ScanNowBand({ status, stages, onCancel, cancelling }) {
  const current =
    stages.find((s) => s.key === status?.currentStage) || stages.find((s) => s.state === "running") || null;
  const idx = current ? stages.findIndex((s) => s.key === current.key) : -1;
  const startedAt = current?.startedAt || status?.startedAt || null;
  const elapsed = useLiveDuration(startedAt);
  const updatedAgo = useLiveDuration(status?.updatedAt || null);
  const sweep = Number(status?.sweep) || 0;
  const lastError = status?.currentStageProgress?.lastError || null;
  const note = status?.currentStageProgress?.note || null;

  const progress = useRunningStageProgress({
    startedAt,
    recentRuns: status?.recentRuns,
    stageKey: current?.key || null,
    realProgress: status?.currentStageProgress,
  });

  return (
    <div className="scan-now">
      <div className="scan-now__head">
        <span className="scan-now__dot" aria-hidden="true" />
        <div className="scan-now__headings">
          <strong>{current ? current.label : "Starting…"}</strong>
          <span className="scan-now__sub">
            {idx >= 0 ? `stage ${idx + 1} of ${stages.length}` : "queued"}
            {" · elapsed "}
            {elapsed || "0s"}
            {sweep > 0 && (
              <span className="scan-now__sweeptag">
                {" · retry pass "}
                {sweep}
              </span>
            )}
          </span>
        </div>
        <button type="button" className="secondary-button" onClick={onCancel} disabled={cancelling}>
          {cancelling ? "Cancelling…" : "Cancel scan"}
        </button>
      </div>
      <div className="scan-now__track" aria-hidden="true">
        {progress.indeterminate ? (
          <span className="stage-progress__sweep" />
        ) : (
          <span
            className={`stage-progress__fill${progress.estimated ? " stage-progress__fill--estimated" : ""}`}
            style={{ width: `${progress.pct}%` }}
          />
        )}
      </div>
      <div className="scan-now__foot">
        <span>
          {progress.text}
          {note && (
            <span className="scan-now__note">
              {" — "}
              {note}
            </span>
          )}
        </span>
        <span className="scan-now__beat">last update {updatedAgo || "just now"} ago</span>
      </div>
      {lastError && <div className="scan-now__err">Last error: {lastError}</div>}
    </div>
  );
}

// A signed change against the previous run. Neutral by default -- more filters or fewer is
// not good or bad, it is just what changed. `goodDown` flips it for duration, where up is
// the regression worth colouring.
function RunDelta({ from, to, unit = "", goodDown = false }) {
  if (from == null || to == null) return null;
  const d = to - from;
  if (d === 0) return <span className="run-delta run-delta--flat">no change vs last run</span>;
  const worse = goodDown && d > 0;
  return (
    <span className={`run-delta run-delta--${worse ? "warn" : "neutral"}`}>
      {d > 0 ? "+" : "−"}
      {formatNumber(Math.abs(d))}
      {unit} vs last run
    </span>
  );
}

// The selected stage, in the four terms an operator actually asks about it: what it produced,
// how long it took, whether it had to retry, and when it finished -- each against last run.
//
// No progress bar here on purpose. For the stage that is currently running, the band up top
// already shows the bar, the percentage and the heartbeat; repeating them a few hundred
// pixels lower under the same "Field snapshot" heading read as two separate things happening.
// The band owns live progress; this card owns the after-the-fact detail on whichever node
// you click.
function StageDetailCard({ stage, onOpenCrawl }) {
  if (!stage) return null;
  const durS = stage.durationMs != null ? Math.round(stage.durationMs / 1000) : null;
  const prevDurS = stage.prevDurationMs != null ? Math.round(stage.prevDurationMs / 1000) : null;

  return (
    <Panel
      title={stage.label}
      icon="layers"
      description={
        <span className={`chip chip--${STAGE_TONE[stage.state] || "neutral"}`}>
          {STAGE_LABEL[stage.state] || stage.state}
        </span>
      }
    >
      <StatRow>
        <StatTile
          label="Produced"
          value={stage.count == null ? "—" : formatNumber(stage.count)}
          hint={stage.count == null ? "no headline count for this stage" : undefined}
        >
          <RunDelta from={stage.prevCount} to={stage.count} />
        </StatTile>
        <StatTile label="Duration" value={formatDurationMs(stage.durationMs) || "—"}>
          <RunDelta from={prevDurS} to={durS} unit="s" goodDown />
        </StatTile>
        <StatTile
          label="Attempts"
          value={stage.attempts || (stage.state === "pending" ? "—" : 1)}
          tone={stage.attempts > 1 ? "warning" : "neutral"}
          hint={stage.attempts > 1 ? "retried before it resolved" : undefined}
        />
        <StatTile
          label={stage.state === "done" ? "Finished" : "Last update"}
          value={stage.completedAt ? formatRelativeTime(stage.completedAt) : "—"}
        />
      </StatRow>
      {stage.error && <div className="stage-detail__err">{stage.error}</div>}
      {(stage.key === "issues" || stage.key === "issues-delta") && onOpenCrawl && (
        <LinkButton onClick={onOpenCrawl}>See the full issue-crawl log</LinkButton>
      )}
    </Panel>
  );
}

// The last few runs, so "is this normal" has an answer. Each row: when, whether it finished
// clean, how long, what it produced most of, and a bar per stage so a slow run shows which
// stage ate the time.
function RecentRunsPanel({ runs }) {
  if (!runs?.length) return null;
  const maxDur = Math.max(...runs.map((r) => Number(r.durationMs) || 0), 1);

  return (
    <Panel title="Recent runs" icon="clock">
      <div className="recent-runs">
        {runs.map((run) => {
          const headline = run.summary?.issues ?? run.summary?.["issues-delta"] ?? null;
          const incomplete = (run.failedCount || 0) + (run.skippedCount || 0);
          return (
            <div key={run.runId} className="recent-runs__row">
              <span className="recent-runs__when">{run.completedAt ? formatRelativeTime(run.completedAt) : "—"}</span>
              <span className={`chip chip--${incomplete ? "warning" : "success"}`}>
                {incomplete ? `${incomplete} incomplete` : "clean"}
              </span>
              <span className="recent-runs__dur">{formatDurationMs(run.durationMs) || "—"}</span>
              <span className="recent-runs__count">
                {headline != null ? `${formatNumber(headline)} issues` : `${run.totalStages || 0} stages`}
              </span>
              <span className="recent-runs__bars" aria-hidden="true">
                {(run.stages || [])
                  .filter((s) => Number(s.durationMs) > 0)
                  .map((s) => (
                    <span
                      key={s.key}
                      className={`recent-runs__bar recent-runs__bar--${s.state === "failed" ? "failed" : s.state === "skipped" ? "skipped" : "ok"}`}
                      title={`${s.key}: ${formatDurationMs(s.durationMs)}`}
                      style={{ width: `${Math.max(2, (Number(s.durationMs) / maxDur) * 100)}%` }}
                    />
                  ))}
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// The pipeline: summary tiles, the running band, a clickable stage rail with a detail card
// for whichever node is selected, and the recent-runs history. Shared by Full Scan and Quick
// Scan -- both are the same stage-machine shape, driven by different stage lists.
function ScanPipeline({ status, onAbandonScan, abandoningScan, onOpenCrawl }) {
  const stages = React.useMemo(() => mergeStageData(status), [status]);
  const running = status?.state === "running";
  const done = stages.filter((s) => s.state === "done").length;
  const failed = stages.filter((s) => s.state === "failed").length;
  const skipped = stages.filter((s) => s.state === "skipped").length;

  const [selectedKey, setSelectedKey] = React.useState(null);
  const [userPicked, setUserPicked] = React.useState(false);

  // Follow the running stage automatically -- until the operator clicks a node themselves,
  // after which their selection sticks.
  React.useEffect(() => {
    if (userPicked) return;
    const follow =
      status?.currentStage ||
      stages.find((s) => s.state === "running")?.key ||
      [...stages].reverse().find((s) => s.state !== "pending")?.key ||
      null;
    setSelectedKey(follow);
  }, [status?.currentStage, status?.state, userPicked, stages]);

  // A fresh scan run clears the operator's manual pick so the view follows again.
  React.useEffect(() => {
    if (running) setUserPicked(false);
  }, [status?.startedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectStage = (key) => {
    setUserPicked(true);
    setSelectedKey(key);
  };
  const selected = stages.find((s) => s.key === selectedKey) || null;
  const everRun = stages.some((s) => s.state !== "pending") || status?.recentRuns?.length > 0;

  return (
    <>
      <StatRow>
        <StatTile
          label="Stages complete"
          value={`${done} / ${stages.length}`}
          tone={done === stages.length && !failed ? "success" : "neutral"}
        />
        <StatTile label="Failed" value={failed} tone={failed ? "critical" : "neutral"} />
        <StatTile
          label="Skipped"
          value={skipped}
          tone={skipped ? "warning" : "neutral"}
          hint="A stage is skipped when something it depends on did not complete. Running it against stale inputs would produce a wrong answer rather than a partial one."
        />
      </StatRow>

      {running && <ScanNowBand status={status} stages={stages} onCancel={onAbandonScan} cancelling={abandoningScan} />}

      <Panel title="Stages" icon="layers">
        {everRun ? (
          <>
            <StageRail
              stages={stages}
              currentStage={running ? status?.currentStage : null}
              selectedKey={selectedKey}
              onSelect={selectStage}
            />
            <StageDetailCard stage={selected} onOpenCrawl={onOpenCrawl} />
          </>
        ) : (
          <EmptyState inline>No scan has run yet. Start one above to populate the pipeline.</EmptyState>
        )}
      </Panel>

      <RecentRunsPanel runs={status?.recentRuns} />
    </>
  );
}

export function FullScanPanel({
  status,
  onStart,
  starting,
  onResumeStalledScan,
  onAbandonScan,
  recoveringScan,
  abandoningScan,
  issueScan,
  onResumeIssueScan,
  onCancelIssueScan,
  resumingIssueScan,
  cancellingIssueScan,
  snapshot,
  onForceResumeSnapshot,
  forceResumingSnapshot,
  onSnapshotCleared,
  onViewAuditLog,
}) {
  const running = status?.state === "running";

  return (
    <>
      <PageHeader
        title="Full site scan"
        description="Every pillar in one pass, in dependency order. Each stage is the same build its own tab runs — this sequences them so the tabs cannot end up disagreeing about which snapshot they are describing."
        meta={status?.completedAt ? `Last run ${formatRelativeTime(status.completedAt)}` : undefined}
        actions={
          <button
            type="button"
            className="primary-button"
            onClick={onStart}
            disabled={starting || running || status?.blockedByOtherScan}
          >
            {running ? "Scanning…" : starting ? "Starting…" : "Run full scan"}
          </button>
        }
      />

      {/* Collapsed by default: this is reference material an operator reads once, not on
          every visit, and it was the single biggest thing standing between opening this tab
          and seeing whether the last scan actually worked. */}
      <Panel title="What this scan does" icon="info" collapsible defaultCollapsed>
        <ul className="delta-scan-panel__facts">
          <li>Rebuilds the workflow &amp; status, screen, saved filter, and dashboard inventories in full.</li>
          <li>
            Rebuilds the field catalog, then crawls every issue across all Jira projects to compute per-project field
            usage counts and detect <code>RQT-XXXXXX-XXXXXX</code> pattern values.
          </li>
          <li>
            Updates field usage summaries and governance scores from what the crawl found, then records status history
            and site health once everything else has landed.
          </li>
        </ul>
      </Panel>

      {status?.blockedByOtherScan && (
        <EmptyState inline>A quick scan is running right now. Full scan will be available once it finishes.</EmptyState>
      )}

      <ScanPipeline
        status={status}
        onAbandonScan={onAbandonScan}
        abandoningScan={abandoningScan}
        onOpenCrawl={onViewAuditLog}
      />

      <ScanStallRecoveryNotice
        status={status}
        onResume={onResumeStalledScan}
        onAbandon={onAbandonScan}
        resuming={recoveringScan}
        abandoning={abandoningScan}
      />

      {status?.lastError && !running && (
        <div className="danger-zone__error" role="alert">
          {status.lastError}
        </div>
      )}

      <ScanIncompleteNotice status={status} onResume={onResumeStalledScan} resuming={recoveringScan} />

      <SnapshotRecoveryNotice
        snapshot={snapshot}
        onForceResume={onForceResumeSnapshot}
        forceResuming={forceResumingSnapshot}
      />

      <IssueCrawlSummary
        issueScan={issueScan}
        onResume={onResumeIssueScan}
        onCancel={onCancelIssueScan}
        resuming={resumingIssueScan}
        cancelling={cancellingIssueScan}
      />

      <Panel title="What this does not cover" icon="alertTriangle" collapsible defaultCollapsed>
        <p>
          <strong>Automation rules are not scanned.</strong> Jira publishes no API to enumerate them — that pillar is
          fed by importing a rule export by hand, from the Automation tab. A scan that quietly skipped it while calling
          itself complete would be claiming coverage it does not have.
        </p>
      </Panel>

      <ClearSnapshotControl onCleared={onSnapshotCleared} />
    </>
  );
}

const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => h);

// Every hour, not a cron -- Forge's scheduled trigger offers no finer interval than that, so
// "runs Sunday at midnight" is really "checks every hour, most of which do nothing." The
// admin picks a day/hour; quickScanScheduleCheck compares it against the clock each time it
// fires. See manifest.yml's quick-scan-scheduler-trigger for the other half of this.
function QuickScanSchedule({ schedule, onChange, onToggleEnabled, onSave, saving, saved, dirty }) {
  return (
    <ConfigSection title="Automatic schedule" icon="clock">
      <ConfigRow
        label="Run automatically"
        hint="An hourly check compares this schedule against the clock and starts a quick scan when it is due. This toggle saves the moment you flip it."
      >
        <Toggle checked={schedule.enabled} onChange={(v) => onToggleEnabled(v)} />
      </ConfigRow>

      {schedule.enabled && (
        <>
          <ConfigRow label="Frequency" hint="How often the scheduled run fires.">
            <select value={schedule.frequency} onChange={(e) => onChange({ ...schedule, frequency: e.target.value })}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </ConfigRow>

          {schedule.frequency === "weekly" && (
            <ConfigRow label="Day of week" hint="Which day the weekly run fires on.">
              <select
                value={schedule.dayOfWeek}
                onChange={(e) => onChange({ ...schedule, dayOfWeek: Number(e.target.value) })}
              >
                {WEEKDAY_LABELS.map((label, i) => (
                  <option key={i} value={i}>
                    {label}
                  </option>
                ))}
              </select>
            </ConfigRow>
          )}

          <ConfigRow label="Time (UTC)" hint="The hour the run fires in, in UTC.">
            <select
              value={schedule.hourUtc}
              onChange={(e) => onChange({ ...schedule, hourUtc: Number(e.target.value) })}
            >
              {HOUR_OPTIONS.map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00 UTC
                </option>
              ))}
            </select>
          </ConfigRow>

          <ConfigRow label="Window" hint="How far back to look for changes when the scheduled run fires.">
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="number"
                min={1}
                max={2160}
                value={schedule.windowHours}
                onChange={(e) => onChange({ ...schedule, windowHours: Number(e.target.value) })}
                style={{ width: 90 }}
              />
              hours
            </span>
          </ConfigRow>
        </>
      )}

      {schedule.enabled && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
          <button className="primary-button" type="button" onClick={onSave} disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save schedule"}
          </button>
          {dirty ? (
            <span className="status-banner status-banner--warning" style={{ padding: "2px 8px" }}>
              Unsaved changes
            </span>
          ) : (
            saved && <span className="admin-snapshot-card__age">Saved.</span>
          )}
        </div>
      )}
    </ConfigSection>
  );
}

export function QuickScanPanel({
  status,
  onStart,
  starting,
  onResumeStalledScan,
  onAbandonScan,
  recoveringScan,
  abandoningScan,
  deltaIssueScan,
  schedule,
  onChangeSchedule,
  onToggleScheduleEnabled,
  onSaveSchedule,
  savingSchedule,
  scheduleSaved,
  scheduleDirty,
  onViewAuditLog,
}) {
  const running = status?.state === "running";

  return (
    <>
      <PageHeader
        title="Quick scan"
        description="The same estate as a full scan, minus what Jira genuinely cannot tell us has changed. Filters, dashboards, screens and workflows still run in full every time — there is no changed-since signal for them. The issue crawl is windowed to whatever you configure below."
        meta={status?.completedAt ? `Last run ${formatRelativeTime(status.completedAt)}` : undefined}
        actions={
          <button
            type="button"
            className="primary-button"
            onClick={onStart}
            disabled={starting || running || status?.blockedByOtherScan}
          >
            {running ? "Scanning…" : starting ? "Starting…" : "Run quick scan"}
          </button>
        }
      />

      <Panel title="What this scan does" icon="info" collapsible defaultCollapsed>
        <ul className="delta-scan-panel__facts">
          <li>
            Refetches workflow &amp; status, screen, saved filter, and dashboard inventories in full — Jira gives no
            changed-since signal for any of them.
          </li>
          <li>
            Re-reads only the issues created or updated within the configured window, refreshing field × project usage
            counts for what changed and detecting <code>RQT-XXXXXX-XXXXXX</code> pattern values in them.
          </li>
          <li>
            Updates governance scores from what the crawl found, then records status history and site health once
            everything else has landed.
          </li>
        </ul>
      </Panel>

      {status?.blockedByOtherScan && (
        <EmptyState inline>A full scan is running right now. Quick scan will be available once it finishes.</EmptyState>
      )}

      {status?.windowHours != null && (
        <EmptyState inline>
          Last run looked back {status.windowHours} hour{status.windowHours === 1 ? "" : "s"} for changed issues.
        </EmptyState>
      )}

      <ScanPipeline
        status={status}
        onAbandonScan={onAbandonScan}
        abandoningScan={abandoningScan}
        onOpenCrawl={onViewAuditLog}
      />

      <ScanStallRecoveryNotice
        status={status}
        onResume={onResumeStalledScan}
        onAbandon={onAbandonScan}
        resuming={recoveringScan}
        abandoning={abandoningScan}
      />

      {status?.lastError && !running && (
        <div className="danger-zone__error" role="alert">
          {status.lastError}
        </div>
      )}

      <ScanIncompleteNotice status={status} onResume={onResumeStalledScan} resuming={recoveringScan} />

      <IssueCrawlSummary issueScan={deltaIssueScan} title="Issue crawl (changed since window)" readOnly />

      <Panel title="What this does not cover" icon="alertTriangle" collapsible defaultCollapsed>
        <ul className="delta-scan-panel__facts">
          <li>
            <strong>New custom fields</strong> are not picked up — the field catalog itself only refreshes on a full
            scan. Usage counts for existing fields are current; a field created since the last full scan will not appear
            until the next one.
          </li>
          <li>
            <strong>Automation rules</strong> are never scanned. Jira publishes no API to enumerate them.
          </li>
        </ul>
      </Panel>

      <QuickScanSchedule
        schedule={schedule}
        onChange={onChangeSchedule}
        onToggleEnabled={onToggleScheduleEnabled}
        onSave={onSaveSchedule}
        saving={savingSchedule}
        saved={scheduleSaved}
        dirty={scheduleDirty}
      />
    </>
  );
}

const DEFAULT_QUICK_SCAN_SCHEDULE = { enabled: false, frequency: "weekly", dayOfWeek: 0, hourUtc: 0, windowHours: 168 };

export function ScansTab({ siteOrigin, initialSection }) {
  const [activeSection, setActiveSection] = usePersistentState(
    "observatory.section.scans",
    "full",
    initialSection || null,
  );
  // Which crawl the Audit Log / Reports sub-tabs are showing. Both sub-tabs read whichever
  // scan's issue crawl was last opened from -- "See the full issue-crawl log" on a stage card
  // sets this before switching section, so the reader lands on the run they actually clicked
  // from rather than always defaulting to Full Scan's.
  const [auditCrawl, setAuditCrawl] = React.useState("full");

  // Snapshot state -- kept purely to detect and recover a stalled field-catalog build (see
  // SnapshotRecoveryNotice). Full Scan's own "fields" stage is the only thing that triggers
  // this build now; there is no manual "build snapshot" button left in the UI.
  const [snapshotStatus, setSnapshotStatus] = React.useState(null);
  const [forceResumingSnapshot, setForceResumingSnapshot] = React.useState(false);

  const [issueScanStatus, setIssueScanStatus] = React.useState(null);
  const [fullScanStatus, setFullScanStatus] = React.useState(null);
  const [fullScanStarting, setFullScanStarting] = React.useState(false);
  const [issueScanResuming, setIssueScanResuming] = React.useState(false);
  const [issueScanCancelling, setIssueScanCancelling] = React.useState(false);

  const [quickScanStatus, setQuickScanStatus] = React.useState(null);
  const [quickScanStarting, setQuickScanStarting] = React.useState(false);
  const [deltaIssueScanStatus, setDeltaIssueScanStatus] = React.useState(null);

  // Full and quick scan share one meta row, so a stall-recovery action against either can
  // change both panels' status -- one pair of flags, and both fetches run afterwards.
  const [scanRecovering, setScanRecovering] = React.useState(false);
  const [scanAbandoning, setScanAbandoning] = React.useState(false);

  const [schedule, setSchedule] = React.useState(DEFAULT_QUICK_SCAN_SCHEDULE);
  // The last value the server confirmed. `schedule` is the editable copy; the gap between
  // the two is what "Unsaved changes" reports, and what stopped a toggled-off "Run
  // automatically" from silently reverting on the next page load -- see toggleScheduleEnabled.
  const [savedSchedule, setSavedSchedule] = React.useState(DEFAULT_QUICK_SCAN_SCHEDULE);
  const [savingSchedule, setSavingSchedule] = React.useState(false);
  const [scheduleSaved, setScheduleSaved] = React.useState(false);

  const [error, setError] = React.useState("");

  const fetchSnapshotStatus = React.useCallback(async () => {
    try {
      const data = await invoke("getAdminOverview");
      setSnapshotStatus(data?.snapshot || null);
    } catch (err) {
      setError(err.message || "Failed to load snapshot status.");
    }
  }, []);

  React.useEffect(() => {
    fetchSnapshotStatus();
  }, []);

  useVisiblePolling(
    snapshotStatus?.state === "building" || snapshotStatus?.state === "queued",
    fetchSnapshotStatus,
    8000,
  );

  async function forceResumeSnapshot() {
    setForceResumingSnapshot(true);
    setError("");
    try {
      await invoke("getFieldInventory", { forceRefresh: true, page: 1, pageSize: 1 });
      await fetchSnapshotStatus();
    } catch (err) {
      setError(err.message || "Failed to resume the snapshot build.");
    } finally {
      setForceResumingSnapshot(false);
    }
  }

  const fetchIssueScanStatus = React.useCallback(async () => {
    try {
      const r = await invoke("getIssueScanStatus");
      setIssueScanStatus(r?.meta || null);
    } catch (err) {
      setError(err.message || "Failed to load issue crawl status.");
    }
  }, []);

  const fetchFullScanStatus = React.useCallback(async () => {
    try {
      setFullScanStatus(await invoke("getFullScanStatus"));
    } catch (err) {
      setError(err.message || "Failed to load full scan status.");
    }
  }, []);

  const fetchQuickScanStatus = React.useCallback(async () => {
    try {
      setQuickScanStatus(await invoke("getQuickScanStatus"));
    } catch (err) {
      setError(err.message || "Failed to load quick scan status.");
    }
  }, []);

  const fetchDeltaStatus = React.useCallback(async () => {
    try {
      const r = await invoke("getDeltaIssueScanStatus");
      setDeltaIssueScanStatus(r?.meta || null);
    } catch {}
  }, []);

  const fetchSchedule = React.useCallback(async () => {
    try {
      const config = await invoke("getAdminConfig");
      if (config?.quickScanSchedule) {
        setSchedule(config.quickScanSchedule);
        setSavedSchedule(config.quickScanSchedule);
      }
    } catch (err) {
      setError(err.message || "Failed to load quick scan schedule.");
    }
  }, []);

  React.useEffect(() => {
    fetchIssueScanStatus();
    fetchDeltaStatus();
    fetchFullScanStatus();
    fetchQuickScanStatus();
    fetchSchedule();
  }, []);

  // Each poll fires only while its own scan is actually running -- a tab left open overnight
  // should not be a standing request generator.
  useVisiblePolling(fullScanStatus?.state === "running", fetchFullScanStatus, 5000);
  useVisiblePolling(quickScanStatus?.state === "running", fetchQuickScanStatus, 5000);

  // 15s, not 8s: the issue crawl runs for over an hour on a large site, so 8-second
  // granularity was finer than anyone reads while costing a resolver invocation -- and its
  // SQL reads -- every 8 seconds for the whole run. Polls while a full scan is running too,
  // so this picks up the crawl the moment its stage starts rather than waiting for its own
  // meta row to already say "building".
  useVisiblePolling(
    issueScanStatus?.state === "building" || issueScanStatus?.state === "queued" || fullScanStatus?.state === "running",
    fetchIssueScanStatus,
    15000,
  );

  useVisiblePolling(
    deltaIssueScanStatus?.state === "building" ||
      deltaIssueScanStatus?.state === "queued" ||
      quickScanStatus?.state === "running",
    fetchDeltaStatus,
    15000,
  );

  async function resumeScan() {
    setIssueScanResuming(true);
    try {
      const result = await invoke("resumeIssueScan");
      if (result?.resumed === false)
        setError(
          { "already-complete": "Issue crawl is already complete.", "no-scan": "No issue crawl exists to resume." }[
            result.reason
          ] || "Issue crawl could not be resumed.",
        );
      await fetchIssueScanStatus();
    } catch (err) {
      setError(err.message || "Failed to resume the issue crawl.");
    } finally {
      setIssueScanResuming(false);
    }
  }

  async function cancelScan() {
    setIssueScanCancelling(true);
    try {
      await invoke("cancelIssueScan");
      await fetchIssueScanStatus();
    } catch (err) {
      setError(err.message || "Failed to cancel the issue crawl.");
    } finally {
      setIssueScanCancelling(false);
    }
  }

  async function startFullScan() {
    setFullScanStarting(true);
    try {
      const result = await invoke("startFullSiteScan");
      if (result?.error) setError(result.error);
      await fetchFullScanStatus();
    } catch (err) {
      setError(err.message || "Failed to start the full scan.");
    } finally {
      setFullScanStarting(false);
    }
  }

  async function startQuickScan() {
    setQuickScanStarting(true);
    try {
      const result = await invoke("startQuickSiteScan");
      if (result?.error) setError(result.error);
      await fetchQuickScanStatus();
    } catch (err) {
      setError(err.message || "Failed to start the quick scan.");
    } finally {
      setQuickScanStarting(false);
    }
  }

  async function resumeStalledSiteScan() {
    setScanRecovering(true);
    setError("");
    try {
      const result = await invoke("resumeSiteScan");
      if (result?.recovered === false && result.reason === "not-running") {
        setError("That scan is no longer running — nothing to resume.");
      }
      await Promise.all([fetchFullScanStatus(), fetchQuickScanStatus()]);
    } catch (err) {
      setError(err.message || "Failed to resume the scan.");
    } finally {
      setScanRecovering(false);
    }
  }

  async function abandonSiteScan() {
    setScanAbandoning(true);
    setError("");
    try {
      await invoke("cancelSiteScan");
      await Promise.all([fetchFullScanStatus(), fetchQuickScanStatus()]);
    } catch (err) {
      setError(err.message || "Failed to abandon the scan.");
    } finally {
      setScanAbandoning(false);
    }
  }

  async function saveSchedule() {
    setSavingSchedule(true);
    setError("");
    try {
      const result = await invoke("saveAdminConfig", { quickScanSchedule: schedule });
      const next = result?.config?.quickScanSchedule || schedule;
      setSchedule(next);
      setSavedSchedule(next);
      setScheduleSaved(true);
      setTimeout(() => setScheduleSaved(false), 3000);
    } catch (err) {
      setError(err.message || "Failed to save the quick scan schedule.");
    } finally {
      setSavingSchedule(false);
    }
  }

  // "Run automatically" is a single meaningful setting, so it persists the instant it is
  // toggled -- it does not wait for the Save button, which is what made it look like it
  // "reverted" on refresh. It commits only the toggle against the last saved value; any
  // half-finished edits to frequency/day/hour/window stay pending and unsaved.
  async function toggleScheduleEnabled(enabled) {
    const next = { ...savedSchedule, enabled };
    setSchedule((s) => ({ ...s, enabled }));
    setSavedSchedule(next);
    setError("");
    try {
      await invoke("saveAdminConfig", { quickScanSchedule: next });
      setScheduleSaved(true);
      setTimeout(() => setScheduleSaved(false), 3000);
    } catch (err) {
      setError(err.message || "Failed to update the schedule.");
      setSchedule((s) => ({ ...s, enabled: !enabled }));
      setSavedSchedule((s) => ({ ...s, enabled: !enabled }));
    }
  }

  // Whichever crawl has ever produced anything -- used both to pick a sane default tab and
  // to tell "nothing has run yet" apart from "this crawl specifically has nothing."
  const fullCrawlHasData = Boolean(issueScanStatus?.startedAt || issueScanStatus?.scanHistory?.length);
  const quickCrawlHasData = Boolean(deltaIssueScanStatus?.startedAt || deltaIssueScanStatus?.scanHistory?.length);

  const viewAuditLogFor = React.useCallback((crawl) => {
    setAuditCrawl(crawl);
    setActiveSection("audit");
  }, []);

  const subNavItems = [
    { key: "full", label: "Full Scan", icon: "zap" },
    { key: "quick", label: "Quick Scan", icon: "activity" },
    { key: "audit", label: "Audit Log", icon: "clock" },
    { key: "reports", label: "Reports", icon: "barChart" },
  ];

  const selectedCrawl = auditCrawl === "quick" ? deltaIssueScanStatus : issueScanStatus;
  const selectedCrawlTitle = auditCrawl === "quick" ? "Issues scanned (changed since window)" : "Issues scanned";

  return (
    <div className="admin-scans-tab">
      {error && (
        <div className="error-banner" style={{ margin: "0 0 12px 0" }}>
          {error}
          <button className="inline-text-button" type="button" onClick={() => setError("")} style={{ marginLeft: 10 }}>
            Dismiss
          </button>
        </div>
      )}
      <SubNavLayout items={subNavItems} activeKey={activeSection} onSelect={setActiveSection}>
        {activeSection === "full" && (
          <FullScanPanel
            status={fullScanStatus}
            onStart={startFullScan}
            starting={fullScanStarting}
            onResumeStalledScan={resumeStalledSiteScan}
            onAbandonScan={abandonSiteScan}
            recoveringScan={scanRecovering}
            abandoningScan={scanAbandoning}
            issueScan={issueScanStatus}
            onResumeIssueScan={resumeScan}
            onCancelIssueScan={cancelScan}
            resumingIssueScan={issueScanResuming}
            cancellingIssueScan={issueScanCancelling}
            snapshot={snapshotStatus}
            onForceResumeSnapshot={forceResumeSnapshot}
            forceResumingSnapshot={forceResumingSnapshot}
            onSnapshotCleared={fetchSnapshotStatus}
            onViewAuditLog={() => viewAuditLogFor("full")}
          />
        )}
        {activeSection === "quick" && (
          <QuickScanPanel
            status={quickScanStatus}
            onStart={startQuickScan}
            starting={quickScanStarting}
            onResumeStalledScan={resumeStalledSiteScan}
            onAbandonScan={abandonSiteScan}
            recoveringScan={scanRecovering}
            abandoningScan={scanAbandoning}
            deltaIssueScan={deltaIssueScanStatus}
            schedule={schedule}
            onChangeSchedule={setSchedule}
            onToggleScheduleEnabled={toggleScheduleEnabled}
            onSaveSchedule={saveSchedule}
            savingSchedule={savingSchedule}
            scheduleSaved={scheduleSaved}
            scheduleDirty={JSON.stringify(schedule) !== JSON.stringify(savedSchedule)}
            onViewAuditLog={() => viewAuditLogFor("quick")}
          />
        )}
        {(activeSection === "audit" || activeSection === "reports") && (
          <>
            <PageHeader
              title={activeSection === "audit" ? "Audit log" : "Reports"}
              description={
                activeSection === "audit"
                  ? "Every entry the issue crawl has logged, across every run, searchable in one place."
                  : "How the crawl trends over time: progress within a run, growth and duration run over run."
              }
            />
            <div className="sub-nav sub-nav--pills" role="tablist" aria-label="Which crawl">
              <button
                type="button"
                role="tab"
                aria-selected={auditCrawl === "full"}
                className={`sub-nav__item${auditCrawl === "full" ? " sub-nav__item--active" : ""}`}
                onClick={() => setAuditCrawl("full")}
              >
                Full scan crawl
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={auditCrawl === "quick"}
                className={`sub-nav__item${auditCrawl === "quick" ? " sub-nav__item--active" : ""}`}
                onClick={() => setAuditCrawl("quick")}
              >
                Quick scan crawl
              </button>
            </div>

            {!fullCrawlHasData && !quickCrawlHasData ? (
              <EmptyState inline>No scan has run yet. Run a Full Scan or Quick Scan to populate this.</EmptyState>
            ) : activeSection === "audit" ? (
              <IssueCrawlAuditLog issueScan={selectedCrawl} />
            ) : (
              <IssueCrawlCharts issueScan={selectedCrawl} title={selectedCrawlTitle} />
            )}
          </>
        )}
      </SubNavLayout>
    </div>
  );
}
