import React from "react";
import { invoke } from "@forge/bridge";
import { StatRow, StatTile, Panel, EmptyState, BarList, PanelGrid, GridSpan } from "../components/ui";
import { formatNumber, formatRelativeTime } from "../utils";

// The Remediation tab's Progress view: how fast the quarter's cleanup is burning down, and where
// the open work sits. Numbers come from getRemediationMetrics (computeRemediationMetrics on the
// server); this only lays them out.
//
// Colours follow the dataviz method: one accent for the measure (--chart-accent), one recessive
// grey for the reference pace line (--chart-reference), validated in every theme. The grey sits
// under 3:1 against the panel, so both lines carry direct labels and every chart has a table view.

const SHORT_DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const shortDate = (iso) => (iso ? SHORT_DATE.format(new Date(`${iso}T00:00:00Z`)) : "");

// The same numbers as the chart above it, for screen readers, print, and anyone who wants values.
function TableView({ caption, columns, rows }) {
  return (
    <details className="remediation-progress__table">
      <summary>View as table</summary>
      <div className="table-scroll">
        <table>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key}>{c.format ? c.format(r[c.key]) : (r[c.key] ?? "—")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ── Charts ─────────────────────────────────────────────────────────────────
//
// Drawn as SVG here rather than through a charting library: two charts on one tab don't
// justify a dependency that was the biggest chunk in both bundles. One y-axis each, thin marks,
// recessive grid, hover tooltips, and a table view beneath every chart.

const PLOT = { top: 16, right: 64, bottom: 26, left: 40 };

// Container width, so the SVG draws at real pixel size rather than stretching its text.
function useWidth(fallback = 640) {
  const ref = React.useRef(null);
  const [width, setWidth] = React.useState(fallback);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

// Integer ticks from zero, about five of them, topping out at or above the largest value.
export function integerTicks(max, target = 5) {
  if (!(max > 0)) return [0, 1];
  const raw = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(
    1,
    [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw),
  );
  const ticks = [];
  for (let v = 0; v <= max + step - 1e-9; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

// Indices to label on a categorical x-axis, at least `minGap` pixels apart.
export function tickIndices(count, spacing, minGap = 64) {
  if (!count) return [];
  const every = Math.max(1, Math.ceil(minGap / Math.max(spacing, 1)));
  const out = [];
  for (let i = 0; i < count; i += every) out.push(i);
  return out;
}

function YGrid({ ticks, y, x0, x1 }) {
  return ticks.map((t) => (
    <g key={t}>
      <line x1={x0} x2={x1} y1={y(t)} y2={y(t)} className="rp-chart__grid" />
      <text x={x0 - 8} y={y(t)} dy={4} textAnchor="end" className="rp-chart__tick">
        {formatNumber(t)}
      </text>
    </g>
  ));
}

// Path through consecutive non-null points; a gap in the data is a gap in the line.
function linePath(points, key, x, y) {
  let d = "";
  let pen = false;
  points.forEach((p, i) => {
    if (p[key] == null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`;
    pen = true;
  });
  return d;
}

function ChartLegend({ items }) {
  return (
    <div className="rp-chart__legend">
      {items.map((it) => (
        <span key={it.label} className="rp-chart__legend-item">
          <svg width="18" height="8" aria-hidden="true">
            <line x1="0" x2="18" y1="4" y2="4" stroke={it.color} strokeWidth="2" strokeDasharray={it.dash} />
          </svg>
          {it.label}
        </span>
      ))}
    </div>
  );
}

function BurndownChart({ points, hasPace, today }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = React.useState(null);
  const height = 260;
  const x0 = PLOT.left;
  const x1 = Math.max(width - PLOT.right, x0 + 1);
  const y0 = height - PLOT.bottom;
  const max = Math.max(1, ...points.flatMap((p) => [p.open ?? 0, p.pace ?? 0]));
  const ticks = integerTicks(max);
  const top = ticks[ticks.length - 1];
  const spacing = points.length > 1 ? (x1 - x0) / (points.length - 1) : 0;
  const x = (i) => (points.length > 1 ? x0 + i * spacing : (x0 + x1) / 2);
  const y = (v) => y0 - (v / top) * (y0 - PLOT.top);
  const lastIndex = (key) => points.reduce((last, p, i) => (p[key] != null ? i : last), -1);
  const todayIndex = today ? points.findIndex((p) => p.date === today) : -1;

  function onMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const i = spacing ? Math.round((px - x0) / spacing) : 0;
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  }

  const ends = [{ key: "open", text: "Open" }, ...(hasPace ? [{ key: "pace", text: "Pace" }] : [])].filter(
    (e) => lastIndex(e.key) >= 0,
  );
  const hp = hover != null ? points[hover] : null;

  return (
    <div className="rp-chart" ref={ref}>
      <ChartLegend
        items={[
          { label: "Open tasks", color: "var(--chart-accent)" },
          ...(hasPace ? [{ label: "Pace to clear by quarter end", color: "var(--chart-reference)", dash: "6 4" }] : []),
        ]}
      />
      <svg width={width} height={height} className="rp-chart__svg" aria-hidden="true">
        <YGrid ticks={ticks} y={y} x0={x0} x1={x1} />
        {tickIndices(points.length, spacing).map((i) => (
          <text key={i} x={x(i)} y={y0 + 18} textAnchor="middle" className="rp-chart__tick">
            {shortDate(points[i].date)}
          </text>
        ))}
        {todayIndex >= 0 && (
          <g>
            <line x1={x(todayIndex)} x2={x(todayIndex)} y1={PLOT.top} y2={y0} className="rp-chart__today" />
            <text x={x(todayIndex) + 4} y={PLOT.top + 10} className="rp-chart__tick">
              Today
            </text>
          </g>
        )}
        {hasPace && <path d={linePath(points, "pace", x, y)} className="rp-chart__line rp-chart__line--reference" />}
        <path d={linePath(points, "open", x, y)} className="rp-chart__line" />
        {ends.map((e) => {
          const i = lastIndex(e.key);
          return (
            <text key={e.key} x={x(i) + 6} y={y(points[i][e.key])} dy={4} className="remediation-progress__endlabel">
              {e.text}
            </text>
          );
        })}
        {hp && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PLOT.top} y2={y0} className="rp-chart__crosshair" />
            {hp.open != null && <circle cx={x(hover)} cy={y(hp.open)} r={4} className="rp-chart__dot" />}
          </g>
        )}
        <rect
          x={x0}
          y={PLOT.top}
          width={x1 - x0}
          height={y0 - PLOT.top}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>
      {hp && (
        <div
          className="chart-tooltip rp-chart__tooltip"
          style={{ left: Math.min(x(hover) + 12, width - 180), top: PLOT.top }}
        >
          <span className="chart-tooltip__label">{shortDate(hp.date)}</span>
          {hp.open != null && <span className="chart-tooltip__value">Open tasks: {formatNumber(hp.open)}</span>}
          {hasPace && hp.pace != null && <span className="chart-tooltip__value">Pace: {formatNumber(hp.pace)}</span>}
        </div>
      )}
    </div>
  );
}

function ThroughputChart({ weeks }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = React.useState(null);
  const height = 220;
  const right = 12;
  const x0 = PLOT.left;
  const x1 = Math.max(width - right, x0 + 1);
  const y0 = height - PLOT.bottom;
  const ticks = integerTicks(Math.max(1, ...weeks.map((w) => w.closed || 0)));
  const top = ticks[ticks.length - 1];
  const band = (x1 - x0) / Math.max(weeks.length, 1);
  const barWidth = Math.min(28, Math.max(band - 2, 1)); // 2px surface gap between bars
  const y = (v) => y0 - (v / top) * (y0 - PLOT.top);
  const hw = hover != null ? weeks[hover] : null;

  return (
    <div className="rp-chart" ref={ref}>
      <svg width={width} height={height} className="rp-chart__svg" aria-hidden="true">
        <YGrid ticks={ticks} y={y} x0={x0} x1={x1} />
        {tickIndices(weeks.length, band).map((i) => (
          <text key={i} x={x0 + band * (i + 0.5)} y={y0 + 18} textAnchor="middle" className="rp-chart__tick">
            {shortDate(weeks[i].weekStart)}
          </text>
        ))}
        {weeks.map((w, i) => {
          const value = w.closed || 0;
          const bx = x0 + band * i + (band - barWidth) / 2;
          const by = y(value);
          const h = y0 - by;
          const r = Math.min(4, barWidth / 2, h);
          // Rounded at the data end only; square on the baseline.
          const d =
            h > 0
              ? `M${bx},${y0}V${by + r}Q${bx},${by} ${bx + r},${by}H${bx + barWidth - r}Q${bx + barWidth},${by} ${bx + barWidth},${by + r}V${y0}Z`
              : "";
          return (
            <g key={w.weekStart} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={x0 + band * i} y={PLOT.top} width={band} height={y0 - PLOT.top} fill="transparent" />
              {d && <path d={d} className={`rp-chart__bar ${hover === i ? "rp-chart__bar--active" : ""}`} />}
            </g>
          );
        })}
      </svg>
      {hw && (
        <div
          className="chart-tooltip rp-chart__tooltip"
          style={{ left: Math.min(x0 + band * (hover + 0.5) + 12, width - 160), top: PLOT.top }}
        >
          <span className="chart-tooltip__label">Week of {shortDate(hw.weekStart)}</span>
          <span className="chart-tooltip__value">Closed: {formatNumber(hw.closed || 0)}</span>
        </div>
      )}
    </div>
  );
}

function Burndown({ metrics }) {
  const points = metrics.burndown || [];
  if (!points.length) return <EmptyState inline>No tasks in this period yet.</EmptyState>;
  const hasPace = points.some((p) => p.pace != null);
  const today = points.filter((p) => p.open != null).slice(-1)[0]?.date;
  return (
    <>
      <div className="remediation-progress__chart" role="img" aria-label="Open remediation tasks over time">
        <BurndownChart points={points} hasPace={hasPace} today={today} />
      </div>
      <TableView
        caption="Open tasks by day"
        columns={[
          { key: "date", label: "Date", format: shortDate },
          { key: "open", label: "Open tasks", format: (v) => (v == null ? "—" : formatNumber(v)) },
          ...(hasPace
            ? [{ key: "pace", label: "Pace to clear", format: (v) => (v == null ? "—" : formatNumber(v)) }]
            : []),
        ]}
        rows={points}
      />
    </>
  );
}

function Throughput({ metrics }) {
  const weeks = metrics.throughput || [];
  return (
    <>
      <div className="remediation-progress__chart" role="img" aria-label="Tasks closed per week">
        <ThroughputChart weeks={weeks} />
      </div>
      <TableView
        caption="Tasks closed and created per week"
        columns={[
          { key: "weekStart", label: "Week of", format: shortDate },
          { key: "closed", label: "Closed", format: formatNumber },
          { key: "created", label: "Created", format: formatNumber },
        ]}
        rows={weeks}
      />
    </>
  );
}

function FindingTable({ rows }) {
  if (!rows.length) return <EmptyState inline>No tasks in this period yet.</EmptyState>;
  return (
    <div className="table-scroll">
      <table className="remediation-progress__findings">
        <thead>
          <tr>
            <th scope="col">Finding</th>
            <th scope="col" className="num">
              Open
            </th>
            <th scope="col" className="num">
              Closed
            </th>
            <th scope="col" className="num">
              Done
            </th>
            <th scope="col" className="num">
              Oldest open
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.findingKey}>
              <td>{f.label}</td>
              <td className="num">{formatNumber(f.open)}</td>
              <td className="num">{formatNumber(f.closed)}</td>
              <td className="num">{f.pctClosed == null ? "—" : `${f.pctClosed}%`}</td>
              <td className="num">{f.oldestOpenDays == null ? "—" : `${f.oldestOpenDays} d`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RemediationProgress() {
  const [scope, setScope] = React.useState("quarter");
  const [metrics, setMetrics] = React.useState(null);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    setError("");
    invoke("getRemediationMetrics", { scope })
      .then((m) => {
        if (!cancelled) setMetrics(m);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || "Could not load remediation progress.");
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const scopeControl = (
    <div className="remediation-progress__scope" role="group" aria-label="Period">
      {[
        ["quarter", "This quarter"],
        ["all", "All quarters"],
      ].map(([key, label]) => (
        <button
          key={key}
          type="button"
          aria-pressed={scope === key}
          className={`secondary-button secondary-button--small${scope === key ? " is-active" : ""}`}
          onClick={() => setScope(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (error)
    return (
      <>
        {scopeControl}
        <div className="ui-banner ui-banner--critical" role="alert">
          {error}
        </div>
      </>
    );
  if (!metrics)
    return (
      <>
        {scopeControl}
        <EmptyState inline>Loading progress…</EmptyState>
      </>
    );

  const { totals, timing, sync } = metrics;
  if (!totals.tasks) {
    return (
      <>
        {scopeControl}
        <EmptyState>
          No remediation tasks {scope === "quarter" ? `in ${metrics.period}` : "yet"}. Raise remediation from the
          Findings view to start tracking progress.
        </EmptyState>
      </>
    );
  }

  const projection = !timing.projectedClearDate
    ? { value: "—", hint: "Nothing closed in the last 14 days", tone: totals.open ? "warning" : "neutral" }
    : {
        value: shortDate(timing.projectedClearDate),
        hint:
          timing.onTrack == null
            ? `At ${formatNumber(timing.ratePerWeek)} closed a week`
            : timing.onTrack
              ? `On track for quarter end (${shortDate(timing.quarterEnd)})`
              : `After quarter end (${shortDate(timing.quarterEnd)})`,
        tone: timing.onTrack === false ? "warning" : "neutral",
      };

  return (
    <div className="remediation-progress">
      {scopeControl}

      <p className="remediation-progress__sync">
        {sync.lastSyncedAt
          ? `Statuses last synced from Jira ${formatRelativeTime(sync.lastSyncedAt)}.`
          : "Statuses have not synced from Jira yet."}
        {sync.neverSynced > 0 &&
          ` ${formatNumber(sync.neverSynced)} task${sync.neverSynced === 1 ? " has" : "s have"} not synced yet.`}{" "}
        Syncs at 8am, 12pm and 4pm Pacific (an hour earlier during daylight saving).
      </p>

      <StatRow>
        <StatTile
          label="Open tasks"
          value={formatNumber(totals.open)}
          hint={`${formatNumber(totals.unassignedOpen)} unassigned`}
          icon="clock"
          tone={totals.open ? "active" : "success"}
        />
        <StatTile
          label="Closed"
          value={formatNumber(totals.closed)}
          hint={totals.pctClosed == null ? null : `${totals.pctClosed}% of ${formatNumber(totals.tasks)}`}
          icon="checkCircle"
        />
        <StatTile
          label="Closed last 7 days"
          value={formatNumber(totals.closedLast7)}
          hint={`${formatNumber(timing.ratePerWeek)} a week over 14 days`}
          icon="activity"
        />
        <StatTile
          label="Median time to close"
          value={timing.medianDaysToClose == null ? "—" : `${timing.medianDaysToClose} d`}
          hint={timing.oldestOpenDays == null ? null : `Oldest open: ${timing.oldestOpenDays} d`}
          icon="clock"
        />
        <StatTile
          label="Projected clear date"
          value={projection.value}
          hint={projection.hint}
          icon="flag"
          tone={projection.tone}
        />
      </StatRow>

      {totals.cameBack > 0 && (
        <p className="remediation-progress__note">
          {formatNumber(totals.cameBack)} item{totals.cameBack === 1 ? "" : "s"} came back: closed in an earlier quarter
          and flagged again this quarter.
        </p>
      )}

      <PanelGrid>
        <GridSpan wide>
          <Panel
            title="Burn-down"
            icon="activity"
            description={
              scope === "quarter"
                ? "Open tasks at the end of each day. Above the dashed pace line means behind for clearing by quarter end."
                : "Open tasks at the end of each day, across every quarter."
            }
          >
            <Burndown metrics={metrics} />
          </Panel>
        </GridSpan>
        <GridSpan>
          <Panel title="Closed per week" icon="checkCircle" description="Tasks reaching Done each week, last 12 weeks.">
            <Throughput metrics={metrics} />
          </Panel>
        </GridSpan>
        <GridSpan>
          <Panel
            title="Age of open tasks"
            icon="clock"
            description="How long open tasks have been waiting since they were raised."
          >
            <BarList
              items={metrics.ageing}
              labelKey="label"
              valueKey="count"
              formatValue={formatNumber}
              emptyMessage="No open tasks."
            />
          </Panel>
        </GridSpan>
        <GridSpan>
          <Panel title="Open tasks by assignee" icon="user" description="Who holds the open work.">
            <BarList
              items={metrics.byAssignee}
              labelKey="name"
              valueKey="count"
              formatValue={formatNumber}
              emptyMessage="No open tasks."
            />
          </Panel>
        </GridSpan>
        <GridSpan wide>
          <Panel title="Progress by finding" icon="layers" description="Most open work first.">
            <FindingTable rows={metrics.byFinding} />
          </Panel>
        </GridSpan>
      </PanelGrid>
    </div>
  );
}
