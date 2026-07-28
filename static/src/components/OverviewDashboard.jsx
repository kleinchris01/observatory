import React from "react";
import { invoke } from "@forge/bridge";
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, LabelList,
} from "recharts";
import { Icon, useChartPalette } from "./Icons";

// ── Shared chart primitives ─────────────────────────────────────────────────
//
// Deliberately small, fresh components rather than importing RqtTab's/ProjectsTab's
// near-identical copies -- those live in separately lazy-loaded chunks (Scans/RQT,
// Project Usage) and cross-importing between lazy chunks isn't worth the coupling for
// two ~20-line components. All three files independently follow the same dataviz-skill
// palette/tooltip conventions.

function DashboardChartTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const { name, value } = payload[0];
  return (
    <div className="chart-tooltip">
      <span className="chart-tooltip__label">{name}</span>
      <span className="chart-tooltip__value">{Number(value).toLocaleString()}</span>
    </div>
  );
}

function DashboardHBarChart({ items, labelKey, valueKey, color = "#3987e5", maxItems = 8, emptyMsg = "No data yet", labelWidth = 140 }) {
  if (!items?.length) return <div className="dashboard-chart-empty">{emptyMsg}</div>;
  const rows = items.slice(0, maxItems).map((row) => ({ name: String(row[labelKey]), value: row[valueKey] }));
  const height = Math.max(120, rows.length * 26);
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 2, right: 40, bottom: 2, left: 2 }}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="name" width={labelWidth} tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={false} />
          <Tooltip content={<DashboardChartTooltip />} cursor={{ fill: "var(--stroke)" }} />
          <Bar dataKey="value" fill={color} radius={[0, 2, 2, 0]} maxBarSize={16} opacity={0.85}>
            <LabelList dataKey="value" position="right" fontSize={11} fill="var(--muted)" formatter={(v) => v.toLocaleString()} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function DashboardDonutChart({ items }) {
  const palette = useChartPalette();
  if (!items?.length) return <div className="dashboard-chart-empty">No data yet</div>;
  const total = items.reduce((s, d) => s + d.value, 0);
  if (!total) return <div className="dashboard-chart-empty">No data yet</div>;
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ width: 120, height: 120, flexShrink: 0, position: "relative" }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={items} dataKey="value" nameKey="label" innerRadius={32} outerRadius={48} paddingAngle={2} stroke="none">
              {items.map((entry, i) => <Cell key={entry.label} fill={palette[i % palette.length]} />)}
            </Pie>
            <Tooltip content={<DashboardChartTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{total.toLocaleString()}</span>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: "0.77rem" }}>
        {items.map((d, i) => (
          <div key={d.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: palette[i % palette.length], flexShrink: 0 }} />
            <span style={{ color: "var(--muted)" }}>{d.label}</span>
            <span style={{ marginLeft: "auto", color: "var(--text)", fontWeight: 600, paddingLeft: 8 }}>{d.value.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DashStat({ label, value, icon, variant = "neutral" }) {
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

function DashboardSection({ title, icon, children }) {
  return (
    <div className="admin-section">
      <h2 className="admin-section__title"><Icon name={icon} size={16} /> {title}</h2>
      {children}
    </div>
  );
}

// ── Field Usage pillar ───────────────────────────────────────────────────────

function FieldUsageSection({ fieldUsage }) {
  const severity = fieldUsage?.findingsBySeverity || { high: 0, medium: 0, low: 0 };
  const origin = fieldUsage?.origin || { builtin: 0, appProvided: 0, custom: 0 };

  return (
    <DashboardSection title="Field Usage" icon="layers">
      <div className="admin-stat-row" style={{ marginBottom: 16 }}>
        <DashStat label="High severity" value={severity.high} icon="alertTriangle" variant={severity.high > 0 ? "danger" : "neutral"} />
        <DashStat label="Medium severity" value={severity.medium} icon="alertTriangle" variant={severity.medium > 0 ? "warn" : "neutral"} />
        <DashStat label="Low severity" value={severity.low} icon="info" variant="neutral" />
        <DashStat label="Duplicate-name clusters" value={fieldUsage?.duplicateClusters ?? 0} icon="scissors" variant="neutral" />
      </div>
      <div className="rqt-charts-grid">
        <div className="rqt-chart-card">
          <div className="rqt-chart-card__title">Top finding types</div>
          <DashboardHBarChart items={fieldUsage?.findingsByType} labelKey="title" valueKey="count" color="#d55181" emptyMsg="No governance findings yet" />
        </div>
        <div className="rqt-chart-card">
          <div className="rqt-chart-card__title">Field types</div>
          <DashboardHBarChart items={fieldUsage?.fieldTypeBreakdown} labelKey="type" valueKey="count" color="#3987e5" />
        </div>
        <div className="rqt-chart-card">
          <div className="rqt-chart-card__title">Field origin</div>
          <DashboardDonutChart
            items={[
              { label: "Custom", value: origin.custom },
              { label: "Jira built-in", value: origin.builtin },
              { label: "App-provided", value: origin.appProvided },
            ].filter((d) => d.value > 0)}
          />
        </div>
      </div>
    </DashboardSection>
  );
}

// ── Projects pillar ──────────────────────────────────────────────────────────

function ProjectsSection({ projects }) {
  return (
    <DashboardSection title="Projects" icon="folder">
      <div className="admin-stat-row" style={{ marginBottom: 16 }}>
        <DashStat label="Projects with field usage" value={projects?.totalProjects ?? 0} icon="folder" variant="neutral" />
      </div>
      <div className="rqt-charts-grid">
        <div className="rqt-chart-card">
          <div className="rqt-chart-card__title">Top projects by issue volume</div>
          <DashboardHBarChart items={projects?.topByIssueVolume} labelKey="projectKey" valueKey="totalIssueCount" color="#199e70" emptyMsg="No project usage data yet" />
        </div>
        <div className="rqt-chart-card">
          <div className="rqt-chart-card__title">Top projects by field count</div>
          <DashboardHBarChart items={projects?.topByFieldCount} labelKey="projectKey" valueKey="fieldCount" color="#c98500" emptyMsg="No project usage data yet" />
        </div>
      </div>
    </DashboardSection>
  );
}

// ── RQT pillar (compact summary, deep-links into the full RQT Index tab) ────

function RqtSummaryCard({ onOpenRqtIndex }) {
  const [rqt, setRqt] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    invoke("getRqtIndex")
      .then((data) => { if (!cancelled) setRqt(data); })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <DashboardSection title="RQT Values" icon="barChart">
      <div className="admin-stat-row">
        <DashStat label="Unique issues" value={loading ? "…" : error ? "—" : (rqt?.totalUniqueIssues ?? 0).toLocaleString()} icon="barChart" variant="neutral" />
        <DashStat label="Fields with RQT values" value={loading ? "…" : error ? "—" : rqt?.fieldCount ?? 0} icon="layers" variant="neutral" />
        <DashStat label="Unique values" value={loading ? "…" : error ? "—" : (rqt?.uniqueValues?.length ?? 0).toLocaleString()} icon="scissors" variant="neutral" />
      </div>
      <button type="button" className="secondary-button" style={{ marginTop: 12 }} onClick={onOpenRqtIndex}>
        Open full RQT Index <Icon name="zap" size={13} />
      </button>
    </DashboardSection>
  );
}

// ── Top-level export, lazy-loaded from OverviewTab ──────────────────────────

export function OverviewDashboard({ dashboard, onOpenRqtIndex }) {
  return (
    <>
      <FieldUsageSection fieldUsage={dashboard?.fieldUsage} />
      <ProjectsSection projects={dashboard?.projects} />
      <RqtSummaryCard onOpenRqtIndex={onOpenRqtIndex} />
    </>
  );
}
