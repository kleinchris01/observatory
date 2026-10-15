import React from "react";
import { invoke } from "@forge/bridge";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  ReferenceLine,
  Legend,
} from "recharts";
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

function ChartTooltip({ active, payload, label, labelFormatter = shortDate }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <span className="chart-tooltip__label">{labelFormatter(label)}</span>
      {payload
        .filter((p) => p.value != null)
        .map((p) => (
          <span className="chart-tooltip__value" key={p.dataKey}>
            {p.name}: {formatNumber(p.value)}
          </span>
        ))}
    </div>
  );
}

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

// Direct label at the last drawn point of a series, so identity never rests on colour alone.
function EndLabel({ points, dataKey, text }) {
  return function renderLabel(props) {
    const { x, y, index } = props;
    let last = -1;
    points.forEach((p, i) => {
      if (p[dataKey] != null) last = i;
    });
    if (index !== last) return null;
    return (
      <text x={x + 6} y={y} dy={4} className="remediation-progress__endlabel">
        {text}
      </text>
    );
  };
}

function Burndown({ metrics }) {
  const points = metrics.burndown || [];
  if (!points.length) return <EmptyState inline>No tasks in this period yet.</EmptyState>;
  const hasPace = points.some((p) => p.pace != null);
  const today = points.filter((p) => p.open != null).slice(-1)[0]?.date;
  return (
    <>
      <div className="remediation-progress__chart" role="img" aria-label="Open remediation tasks over time">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={points} margin={{ top: 12, right: 72, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="var(--stroke)" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={shortDate}
              tick={{ fontSize: 12, fill: "var(--muted)" }}
              minTickGap={24}
              stroke="var(--stroke)"
            />
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 12, fill: "var(--muted)" }}
              width={44}
              stroke="var(--stroke)"
            />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--muted)", strokeDasharray: "3 3" }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {today && (
              <ReferenceLine
                x={today}
                stroke="var(--stroke)"
                label={{ value: "Today", fontSize: 11, fill: "var(--muted)", position: "insideTopLeft" }}
              />
            )}
            {hasPace && (
              <Line
                type="linear"
                dataKey="pace"
                name="Pace to clear by quarter end"
                stroke="var(--chart-reference)"
                strokeWidth={2}
                strokeDasharray="6 4"
                dot={false}
                isAnimationActive={false}
                label={EndLabel({ points, dataKey: "pace", text: "Pace" })}
              />
            )}
            <Line
              type="linear"
              dataKey="open"
              name="Open tasks"
              stroke="var(--chart-accent)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              connectNulls={false}
              isAnimationActive={false}
              label={EndLabel({ points, dataKey: "open", text: "Open" })}
            />
          </LineChart>
        </ResponsiveContainer>
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
  const weekLabel = (iso) => `Week of ${shortDate(iso)}`;
  return (
    <>
      <div className="remediation-progress__chart" role="img" aria-label="Tasks closed per week">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={weeks} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="var(--stroke)" vertical={false} />
            <XAxis
              dataKey="weekStart"
              tickFormatter={shortDate}
              tick={{ fontSize: 12, fill: "var(--muted)" }}
              minTickGap={16}
              stroke="var(--stroke)"
            />
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 12, fill: "var(--muted)" }}
              width={44}
              stroke="var(--stroke)"
            />
            <Tooltip content={<ChartTooltip labelFormatter={weekLabel} />} cursor={{ fill: "var(--wash-6)" }} />
            <Bar
              dataKey="closed"
              name="Closed"
              fill="var(--chart-accent)"
              radius={[4, 4, 0, 0]}
              maxBarSize={28}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
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
