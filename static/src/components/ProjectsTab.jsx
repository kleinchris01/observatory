import React from "react";
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  buildJiraSearchUrl,
  handleJiraLinkClick,
  openFieldExpertRovo,
  buildProjectRovoPrompt,
  toDisplayName,
  formatTimestamp,
  formatRelativeTime,
  formatNumber,
  isCustomField,
} from "../utils";
import { invoke } from "@forge/bridge";
import { Icon, useChartPalette } from "./Icons";
import { SkeletonFieldCard, FindingsStrip, MetricChip } from "./FieldCard";
import { SubNavLayout } from "./admin/primitives";
import { Panel, StatRow, StatTile, BarList, PanelGrid, GridSpan, EmptyState, Chip, PageHeader, AskRovo, SortFilterBar } from "./ui";
import { buildRovoPrompt } from "../utils";

function ChartTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const { name, value } = payload[0];
  return (
    <div className="chart-tooltip">
      <span className="chart-tooltip__label">{name}</span>
      <span className="chart-tooltip__value">{formatNumber(value)}</span>
    </div>
  );
}

export function TopFieldsChart({ fields }) {
  const palette = useChartPalette();
  const top = [...fields]
    .filter((f) => String(f.fieldId || "").startsWith("customfield_") && !f.isJiraBuiltin)
    .sort((a, b) => b.issueCount - a.issueCount)
    .slice(0, 8)
    .map((field) => ({ name: field.fieldName, value: field.issueCount, fieldId: field.fieldId }));
  if (!top.length) return null;
  const chartHeight = Math.max(160, top.length * 34);
  return (
    <div className="project-chart">
      <div className="chart-title">Top fields by issue count</div>
      <div style={{ width: "100%", height: chartHeight }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={top} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }}>
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="name"
              width={140}
              tick={{ fontSize: 12, fill: "var(--muted)" }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--stroke)" }} />
            <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={18}>
              {top.map((entry, i) => (
                <Cell key={entry.fieldId} fill={palette[i % palette.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function FieldTypeDonut({ fields }) {
  const palette = useChartPalette();
  // System fields are excluded: they appear on every issue in every project, so counting
  // them describes Jira rather than this project. They also distort the chart badly --
  // each contributes its own name as a one-count "type", so a project with 12 custom
  // fields and 5 system fields renders as five slivers around one dominant wedge.
  const customFields = fields.filter((f) => isCustomField(f.fieldId));
  const systemFieldCount = fields.length - customFields.length;
  if (!customFields.length) return null;

  const counts = {};
  for (const f of customFields) {
    counts[f.fieldType] = (counts[f.fieldType] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 7);
  const segments = entries.map(([type, count]) => ({ name: type, value: count }));
  return (
    <div className="project-chart">
      <div className="chart-title">
        Custom field types on this project
        {systemFieldCount > 0 && (
          <span className="chart-title__note"> · {systemFieldCount} system field{systemFieldCount === 1 ? "" : "s"} excluded</span>
        )}
      </div>
      <div className="project-chart__donut-layout">
        <div style={{ width: 120, height: 120, flexShrink: 0 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={segments}
                dataKey="value"
                nameKey="name"
                innerRadius={32}
                outerRadius={54}
                paddingAngle={2}
                stroke="none"
              >
                {segments.map((seg, i) => (
                  <Cell key={seg.name} fill={palette[i % palette.length]} />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-legend">
          {segments.map((seg, i) => (
            <div className="chart-legend-item" key={seg.name}>
              <span className="chart-legend-dot" style={{ background: palette[i % palette.length] }} />
              <span className="chart-legend-label" title={seg.name}>{seg.name}</span>
              <span className="chart-legend-count">{seg.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Connection map ──────────────────────────────────────────────────────────
//
// The page had no spine. Five stat cards, a workflow band, two charts and a field list
// were stacked with nothing saying how any of them related -- and one of the cards
// ("projects in snapshot") was a SITE figure sitting among project figures, which is a
// category error rather than a layout problem.
//
// A project is a hub with exactly three relationships, and this states them in that shape:
// the process it runs, the volume it carries, and the shape of the form people fill in.
// Everything else on the page is a drill-down into one of the three.

// Built from the shared primitives, not a parallel set. The hub and the type strip are
// genuinely specific to this view and stay local; the three relationship tiles are
// StatTile, because "labelled value with a qualifier" is the most-rebuilt widget in this
// app and already has a home.
function SchemePeerBars({ scheme, project, allProjects }) {
  if (!scheme || !scheme.siblingProjects?.length) return null;

  const byId = new Map(allProjects.map((p) => [String(p.projectId), p]));
  const peers = scheme.siblingProjects
    .map((sibling) => byId.get(String(sibling.projectId)))
    .filter(Boolean);

  if (!peers.length) return null;

  const rows = [project, ...peers]
    .map((p) => ({ projectKey: p.projectKey, projectName: p.projectName, fieldCount: p.fieldCount }))
    .sort((a, b) => b.fieldCount - a.fieldCount);

  const sorted = [...rows].sort((a, b) => a.fieldCount - b.fieldCount);
  const median = sorted[Math.floor(sorted.length / 2)].fieldCount;

  return (
    <Panel
      title={`Field count across ${scheme.name}`}
      icon="layers"
      description={`These projects run the same process, so a wide spread is a standardization opportunity rather than a fact of life. Median ${formatNumber(median)}.`}
    >
      <BarList
        items={rows}
        labelKey="projectKey"
        valueKey="fieldCount"
        formatValue={formatNumber}
        emptyMessage="No peer projects visible to you"
      />
    </Panel>
  );
}

// NOTE: TopFieldsChart and FieldTypeDonut are still exported and tested, but the Projects
// tab no longer renders either. TopFieldsChart plotted one visible bar on this site --
// fields present on every issue and on most issues differ by less than a pixel at 59k --
// and the donut's information now lives in the connection map's inline type strip.
//
// Left exported rather than deleted mid-redesign: the donut is general-purpose and may be
// wanted elsewhere. If neither is picked up, delete both with their tests rather than
// leaving them to read as live code.


// Everything that touches one project, across every pillar.
//
// The tab used to be a field list with a workflow scheme wedged in beside it: no mention of
// which forms a project routes to, and none at all of the automation firing inside it. Both
// joins existed as data and neither had a query. This is the answer to "what am I actually
// looking at" for a project on a site nobody has audited.
// Adoption, in the three parts it is actually made of.
//
// Deliberately not a single opaque number. "ADVEV scores 41" tells an admin nothing they can
// act on; "top 12% by volume, running at a third of its own historical rate, fell off in
// 2023-04" tells them what happened and roughly when. The score is the way in, the
// components are the finding -- the same shape the site health dimensions already use.

function formatRate(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 10) return formatNumber(Math.round(value));
  if (value >= 1) return value.toFixed(1);
  // Below one a day, a per-day figure rounds to nothing useful. Per week is the honest unit.
  return `${(value * 7).toFixed(1)}/wk`;
}

function formatAge(days) {
  if (!Number.isFinite(days)) return "—";
  if (days < 60) return `${Math.round(days)} days`;
  if (days < 730) return `${Math.round(days / 30)} months`;
  return `${(days / 365).toFixed(1)} years`;
}

// The monthly shape, so a decline has a picture as well as a date.
//
// Scaled to the project's own peak rather than to the site's, because the question this
// answers is "what did this project do relative to its own best month". Bars carry no axis
// on purpose: at this size the shape is the message and a scale would be unreadable.
export function ActivitySparkbars({ months = [], peakIssues = 0, declineFrom = null }) {
  if (months.length < 2) return null;
  // A long-lived project has more months than there are pixels. The most recent 48 is four
  // years, which is enough to see a decline and few enough that each bar is visible.
  const shown = months.slice(-48);
  const peak = Math.max(1, peakIssues || Math.max(...shown.map((m) => m.issueCount)));

  return (
    <div className="adoption-bars" role="img" aria-label={`Issues created per month over the last ${shown.length} months`}>
      {shown.map((m) => (
        <span
          key={m.month}
          className={`adoption-bars__bar${declineFrom && m.month >= declineFrom ? " adoption-bars__bar--after" : ""}`}
          style={{ height: `${Math.max(2, Math.round((m.issueCount / peak) * 100))}%` }}
          title={`${m.month}: ${formatNumber(m.issueCount)} issues`}
        />
      ))}
    </div>
  );
}

export function ProjectAdoptionPanel({ adoption, context }) {
  if (!adoption?.measured) {
    return (
      <Panel title="Adoption" icon="activity">
        {/* Unmeasured is not the same as unused, and this pillar exists because the two used
            to be indistinguishable: a project with no captured dates would otherwise read as
            created today and never adopted. */}
        <EmptyState inline>
          {adoption?.reason || "No issue dates have been captured for this project. Run a Universal Scan to measure adoption."}
        </EmptyState>
      </Panel>
    );
  }

  // Site-wide: the activity histogram has stopped near a fixed month because the last
  // Universal Scan never finished. Every recent-rate figure on this panel is then a
  // measurement of a gap in the data, not of the project, so the panel says so and stops
  // short of calling anything a decline.
  const staleData = Boolean(context?.dataStale);

  const trend = staleData || adoption.momentum === null ? null
    : adoption.momentum >= 1.15 ? "up"
      : adoption.momentum <= 0.85 ? "down" : "flat";
  const tone = staleData ? "neutral"
    : adoption.fellOff ? "critical" : adoption.neverAdopted ? "warning" : "neutral";

  return (
    <Panel
      title="Adoption"
      icon="activity"
      description={`First issue ${adoption.firstIssueCreatedAt?.slice(0, 10)} · ${formatAge(adoption.ageDays)} old`}
    >
      {staleData && (
        <div className="status-banner status-banner--warning">
          Activity data ends {context.dataThroughMonth || "an old month"}. The last Universal
          Scan didn't finish, so the recent rate and momentum below understate current work —
          run a scan from the Scans tab to refresh them.
        </div>
      )}
      <StatRow>
        <StatTile
          label="Adoption score"
          value={adoption.score ?? "—"}
          hint={adoption.volumePercentile != null ? `busier than ${adoption.volumePercentile}% of projects here` : undefined}
          tone={tone}
          icon="activity"
        />
        <StatTile
          label="Issues per day"
          value={formatRate(adoption.issuesPerDay)}
          hint={context?.medianIssuesPerDay != null
            ? `site median ${formatRate(context.medianIssuesPerDay)}`
            : "since its first issue"}
        />
        <StatTile
          label="Recent rate"
          value={staleData ? "—" : formatRate(adoption.recentIssuesPerDay)}
          hint={staleData
            ? `data ends ${context.dataThroughMonth || "—"}`
            : adoption.momentum === null ? "last 90 days" : `${adoption.momentum.toFixed(2)}× its lifetime rate`}
          tone={staleData ? "warning" : trend === "down" ? "warning" : trend === "up" ? "success" : "neutral"}
        />
        <StatTile
          label="Fills per issue"
          value={adoption.fillsPerIssue == null ? "—" : adoption.fillsPerIssue.toFixed(1)}
          hint="field values written per issue"
        />
      </StatRow>

      <ActivitySparkbars
        months={adoption.months}
        peakIssues={adoption.peakIssues}
        declineFrom={adoption.declineFrom}
      />

      <div className="adoption-story">
        {adoption.peakMonth && (
          <span>
            Busiest month was <strong>{adoption.peakMonth}</strong> with {formatNumber(adoption.peakIssues)} issues.
          </span>
        )}
        {/* The question this whole feature was built to answer: not just that a project fell
            off, but when -- while somebody still remembers why. Held back entirely while the
            activity data is stale: a decline the data cannot actually see is not a finding. */}
        {!staleData && adoption.declineFrom && (
          <span className="adoption-story__decline">
            Dropped below half that from <strong>{adoption.declineFrom}</strong>.
          </span>
        )}
        {!staleData && adoption.fellOff && !adoption.declineFrom && (
          <span className="adoption-story__decline">
            Running far below its own historical rate.
          </span>
        )}
        {!staleData && adoption.neverAdopted && (
          <span className="adoption-story__decline">
            Never picked up: under an issue a month across its whole life.
          </span>
        )}
        {!adoption.oldEnough && (
          <span>Too new to judge — adoption is measured from 90 days.</span>
        )}
      </div>
    </Panel>
  );
}

// The project's overall health, as the roll-up the resolver assembled: a coarse band, then
// one tile per pillar signal carrying the rate it was judged on. No single invented score --
// the same rule the adoption panel follows.
export function ProjectHealthPanel({ health }) {
  if (!health?.signals?.length) {
    return (
      <Panel title="Overall health" icon="activity">
        <EmptyState inline>Not enough has been scanned to roll up a health read for this project.</EmptyState>
      </Panel>
    );
  }

  const bandChip = health.band === "critical" ? <Chip tone="critical">{health.headline}</Chip>
    : health.band === "warning" ? <Chip tone="warning">{health.headline}</Chip>
    : <Chip tone="success">{health.headline}</Chip>;

  return (
    <Panel title="Overall health" icon="activity" description={bandChip}>
      <StatRow>
        {health.signals.map((signal) => (
          <StatTile
            key={signal.key}
            label={signal.label}
            value={signal.value}
            hint={signal.detail}
            tone={signal.tone === "success" ? "success" : signal.tone === "critical" ? "critical" : signal.tone === "warning" ? "warning" : "neutral"}
          />
        ))}
      </StatRow>
    </Panel>
  );
}

// Saved filters whose JQL names this project -- the ones that narrow, or break, if it is
// renamed or archived. Tri-state: an unbuilt filter inventory is not "no filters".
export function ProjectFiltersPanel({ filters, siteOrigin }) {
  if (!filters?.available) {
    return (
      <Panel title="Filters targeting this project" icon="search">
        <EmptyState inline>{filters?.reason || "No saved-filter inventory has been built yet."}</EmptyState>
      </Panel>
    );
  }

  if (!filters.filters.length) {
    return (
      <Panel title="Filters targeting this project" icon="search">
        <EmptyState inline>No saved filter scopes its JQL to this project.</EmptyState>
      </Panel>
    );
  }

  return (
    <Panel
      title="Filters targeting this project"
      icon="search"
      description={`${formatNumber(filters.total)} ${filters.total === 1 ? "filter names" : "filters name"} this project in their JQL.`}
    >
      <ul className="project-rules project-rules--scroll">
        {filters.filters.map((filter) => {
          const href = siteOrigin ? `${siteOrigin}/issues/?filter=${filter.id}` : null;
          return (
            <li key={filter.id} className="project-rules__item">
              {href ? (
                <a
                  className="project-rules__name"
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => handleJiraLinkClick(event, href)}
                  title="Open this filter in Jira"
                >
                  {filter.name}
                </a>
              ) : (
                <span className="project-rules__name">{filter.name}</span>
              )}
              <span className="project-rules__trigger">
                {filter.ownerName || "owner unknown"}
                {filter.ownerActive === false ? " · inactive" : ""}
                {filter.subscriptionCount > 0 ? ` · ${formatNumber(filter.subscriptionCount)} ${filter.subscriptionCount === 1 ? "subscription" : "subscriptions"}` : ""}
              </span>
              {filter.lastUsedAt
                ? <Chip tone="neutral" title={`Last opened ${formatTimestamp(filter.lastUsedAt)}`}>{formatRelativeTime(filter.lastUsedAt)}</Chip>
                : <Chip tone="neutral">last-opened not tracked</Chip>}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

// Build a field report from this project's screens, organised by the screen schemes its
// issue type screen scheme maps. Tick the schemes to include, build one scoped report.
export function ProjectScreenReportPanel({ projectId, onBuildFieldReport }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [checked, setChecked] = React.useState(() => new Set());
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!projectId) return undefined;
    let cancelled = false;
    setLoading(true); setError(""); setData(null); setChecked(new Set());
    invoke("getProjectScreenReportInputs", { projectId })
      .then((result) => {
        if (cancelled) return;
        setData(result);
        // Default: everything ticked -- the common case is "report on all of it".
        if (result?.schemes?.length) setChecked(new Set(result.schemes.map((s) => s.schemeId)));
      })
      .catch((err) => { if (!cancelled) setError(err?.message || "Could not load this project's screen schemes."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  const schemes = data?.schemes || [];
  const selectedFieldIds = React.useMemo(() => {
    const ids = new Set();
    for (const scheme of schemes) {
      if (checked.has(scheme.schemeId)) scheme.fieldIds.forEach((id) => ids.add(id));
    }
    return [...ids];
  }, [schemes, checked]);

  function toggle(schemeId) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(schemeId)) next.delete(schemeId); else next.add(schemeId);
      return next;
    });
  }

  async function build() {
    if (!selectedFieldIds.length || !onBuildFieldReport) return;
    setBusy(true);
    try {
      onBuildFieldReport(selectedFieldIds, data?.scopeProjectIds || [projectId]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Field report from screens"
      icon="barChart"
      description="Grouped by the screen schemes this project's issue type screen scheme maps. Tick the ones to include and build a report scoped to this project."
    >
      {loading ? (
        <EmptyState inline>Resolving this project's screen schemes…</EmptyState>
      ) : error ? (
        <EmptyState inline>{error}</EmptyState>
      ) : !data?.available ? (
        <EmptyState inline>{data?.reason || "No screen inventory has been built yet."}</EmptyState>
      ) : !schemes.length ? (
        <EmptyState inline>{data?.reason || "This project's screens could not be resolved through an issue type screen scheme."}</EmptyState>
      ) : (
        <>
          <ul className="screen-scheme-picker">
            {schemes.map((scheme) => (
              <li key={scheme.schemeId} className="screen-scheme-picker__row">
                <label className="screen-scheme-picker__head">
                  <input type="checkbox" checked={checked.has(scheme.schemeId)} onChange={() => toggle(scheme.schemeId)} />
                  <span className="screen-scheme-picker__name">{scheme.schemeName}</span>
                  {scheme.isDefault && <Chip tone="neutral">default</Chip>}
                  <Chip tone="neutral">{formatNumber(scheme.issueTypeCount)} {scheme.issueTypeCount === 1 ? "issue type" : "issue types"}</Chip>
                  <Chip tone="neutral">{formatNumber(scheme.fieldIds.length)} {scheme.fieldIds.length === 1 ? "field" : "fields"}</Chip>
                </label>
                <span className="screen-scheme-picker__screens">
                  {scheme.screens.map((s) => s.name).join(" · ") || "no screens resolved"}
                </span>
              </li>
            ))}
          </ul>
          <div className="screen-scheme-picker__actions">
            <button
              type="button"
              className="primary-button"
              onClick={build}
              disabled={busy || !selectedFieldIds.length}
            >
              <Icon name="barChart" size={14} />
              {busy ? "Building…" : `Build report (${selectedFieldIds.length} ${selectedFieldIds.length === 1 ? "field" : "fields"})`}
            </button>
          </div>
        </>
      )}
    </Panel>
  );
}

// The permission / issue-security / notification scheme this project resolves to, each
// flagged when it is the site default. Tri-state like the other pillars: a project on no
// custom scheme is on the default, which is a fact worth showing, not an empty panel.
export function ProjectSchemesPanel({ schemes }) {
  if (!schemes?.available) {
    return (
      <Panel title="Access schemes" icon="shield">
        <EmptyState inline>{schemes?.reason || "No access scheme inventory has been built yet."}</EmptyState>
      </Panel>
    );
  }

  const rows = [
    { label: "Permissions", scheme: schemes.permission },
    { label: "Issue security", scheme: schemes.security },
    { label: "Notifications", scheme: schemes.notification },
  ];

  return (
    <Panel title="Access schemes" icon="shield" description="Who can do what here, who it is secured from, and who gets told.">
      <ul className="project-schemes">
        {rows.map(({ label, scheme }) => (
          <li key={label} className="project-schemes__item">
            <span className="project-schemes__label">{label}</span>
            {scheme ? (
              <span className="project-schemes__name">
                {scheme.schemeName}
                {scheme.isDefault && <Chip tone="neutral" title="The site-wide default scheme">default</Chip>}
              </span>
            ) : (
              <span className="project-schemes__name project-schemes__name--none">
                {label === "Issue security" ? "none — no issue is restricted here" : "not resolved"}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// Who is in each project role here. A role with no actors is the finding: permission and
// notification schemes grant to roles, so an empty Administrators role means only a site
// admin can manage the project.
export function ProjectRolesPanel({ roles }) {
  if (!roles?.available) {
    return (
      <Panel title="Project roles" icon="user">
        <EmptyState inline>{roles?.reason || "No access scheme inventory has been built yet."}</EmptyState>
      </Panel>
    );
  }
  const byRole = roles.byRole || [];
  return (
    <Panel title="Project roles" icon="user" description="Who is in each role on this project. Schemes grant to roles, so an empty admin role is an administrability gap.">
      {byRole.length === 0 ? (
        <EmptyState inline>No project roles resolved for this project.</EmptyState>
      ) : (
        <ul className="project-schemes">
          {byRole.map((r) => (
            <li key={r.roleId} className="project-schemes__item">
              <span className="project-schemes__label">{r.roleName}</span>
              {r.actors.length ? (
                <span className="project-schemes__name">
                  {r.actors.map((a) => (
                    <Chip key={`${a.type}-${a.value}`} tone={a.type === "user" ? "warning" : "neutral"}>
                      {a.type}: {a.label || a.value}
                    </Chip>
                  ))}
                </span>
              ) : (
                <span className="project-schemes__name project-schemes__name--none">empty — nobody in this role</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function ProjectOverview({ project, overview, loading, fields = [], siteOrigin = "", adoption = null, adoptionContext = null, onBuildFieldReport }) {
  if (loading) return <EmptyState inline>Loading everything that touches this project…</EmptyState>;
  if (!overview?.available) {
    return <EmptyState inline>{overview?.reason || "This project could not be loaded."}</EmptyState>;
  }

  const { workflow, screens, automation } = overview;
  const readableScreens = (screens?.screens || []).filter((s) => s.tabsResolved === "resolved");

  // totalIssueCount is FIELD VALUES on this project; uniqueIssueCount is distinct issues.
  // The names do not say so, which is how the previous version divided by a key that does
  // not exist on this object and rendered NaN.
  const fills = Number(project?.totalIssueCount);
  const issues = Number(project?.uniqueIssueCount);
  const hasIssueCounts = Number.isFinite(issues) && issues > 0;
  const perIssue = hasIssueCounts && Number.isFinite(fills) ? (fills / issues).toFixed(1) : null;

  return (
    <PanelGrid>
      {/* The rolled-up read first: which pillars need a look, before the detail of any one.
          Then adoption, because "is anyone using this" comes before "how is it configured". */}
      {overview.health && (
        <GridSpan wide>
          <ProjectHealthPanel health={overview.health} />
        </GridSpan>
      )}
      <GridSpan wide>
        <ProjectAdoptionPanel adoption={adoption} context={adoptionContext} />
      </GridSpan>
      <GridSpan wide>
        <StatRow>
          <StatTile
            label={hasIssueCounts ? "Issues" : "Field values"}
            value={formatNumber(hasIssueCounts ? issues : fills)}
            icon="barChart"
            // Never labels field values as issues. On a site with no universe scan the only
            // figure available is fills, and calling it "issues" overstates it by roughly
            // the median field count.
            hint={hasIssueCounts ? "distinct issues in this project" : "field values — run a universe scan for issue counts"}
          />
          <StatTile label="Fields in use" value={formatNumber(project?.fieldCount ?? 0)} icon="layers" hint="with detected usage here" />
          <StatTile
            label="Workflow scheme"
            value={workflow?.available ? (workflow.scheme ? "1" : "0") : "—"}
            icon="activity"
            hint={workflow?.available ? (workflow.scheme?.name || "none resolved") : "workflow inventory not built"}
          />
          {/* Em dash, never 0, for a pillar nobody has built. "No forms route here" and "we
              have not looked" are opposite claims and only one is a finding. */}
          <StatTile
            label="Screens"
            value={screens?.available ? formatNumber(readableScreens.length) : "—"}
            icon="copy"
            hint={screens?.available ? "forms this project routes to" : "screen inventory not built"}
          />
          <StatTile
            label="Active rules"
            value={automation?.available ? formatNumber(automation.enabledCount) : "—"}
            icon="refreshCw"
            tone={automation?.enabledCount > 0 ? "warning" : "neutral"}
            hint={automation?.available ? `${formatNumber(automation.disabledCount)} disabled` : "automation analysis not built"}
          />
          <StatTile
            label="Fields per issue"
            value={perIssue ?? "—"}
            icon="scissors"
            hint={perIssue ? "how much of the form gets filled" : "needs a universe scan"}
          />
        </StatRow>
      </GridSpan>

      <GridSpan>
        <Panel title="Process" icon="activity" description="The workflow scheme this project runs, and who else runs it.">
          {!workflow?.available ? (
            <EmptyState inline>{workflow?.reason}</EmptyState>
          ) : !workflow.scheme ? (
            <EmptyState inline>No workflow scheme resolved for this project.</EmptyState>
          ) : (
            <>
              <p className="project-pillar__headline">{workflow.scheme.name}</p>
              <p className="project-pillar__sub">
                {workflow.scheme.sharedWithCount > 0
                  ? `Shared with ${formatNumber(workflow.scheme.sharedWithCount)} other ${workflow.scheme.sharedWithCount === 1 ? "project" : "projects"} — a change here lands on all of them.`
                  : "Used only by this project, so a change here is local."}
              </p>
            </>
          )}
        </Panel>
      </GridSpan>

      <GridSpan>
        <Panel title="Forms" icon="copy" description="Screens this project routes to, through its issue type screen scheme.">
          {!screens?.available ? (
            <EmptyState inline>{screens?.reason}</EmptyState>
          ) : !readableScreens.length ? (
            <EmptyState inline>No screen scheme routes this project to a form.</EmptyState>
          ) : (
            <>
              <BarList
                items={readableScreens.slice(0, 8)}
                labelKey="name"
                valueKey="fieldCount"
                formatValue={formatNumber}
                emptyMessage="No forms resolved"
              />
              {screens.unresolvedScreens > 0 && (
                <p className="project-pillar__sub">
                  {formatNumber(screens.unresolvedScreens)} screens on this site could not be read, so this list may be incomplete.
                </p>
              )}
            </>
          )}
        </Panel>
      </GridSpan>

      <GridSpan>
        <Panel title="Automation" icon="refreshCw" description="Rules scoped to this project. Site-wide rules are not listed — they apply here the way they apply everywhere.">
          {!automation?.available ? (
            <EmptyState inline>{automation?.reason}</EmptyState>
          ) : !automation.rules.length ? (
            <EmptyState inline>No rule is scoped specifically to this project.</EmptyState>
          ) : (
            <>
              <ul className="project-rules project-rules--scroll">
                {automation.rules.map((rule) => (
                  <li key={rule.ruleId} className={rule.enabled ? "project-rules__item" : "project-rules__item project-rules__item--off"}>
                    <span className="project-rules__name">{rule.name}</span>
                    <span className="project-rules__trigger">{rule.triggerType || "—"}</span>
                    {!rule.enabled && <Chip tone="neutral">disabled</Chip>}
                  </li>
                ))}
              </ul>
              {/* Every rule is listed, inside a bounded scroller. Truncating to twelve made
                  the panel disagree with the count in the tile above it; letting it run
                  unbounded made it several times taller than its neighbours and left the
                  grid full of holes. */}
              <p className="project-pillar__sub">
                {formatNumber(automation.rules.length)} {automation.rules.length === 1 ? "rule" : "rules"} scoped here.
              </p>
            </>
          )}
        </Panel>
      </GridSpan>

      <GridSpan>
        {/* Separate panel, not merged into the one above. "Configured for this project" is a
            fact; "we infer this reaches it" is a judgement, and running them together would
            present the second with the authority of the first. */}
        <Panel
          title="Site-wide rules reaching this project"
          icon="refreshCw"
          description="Enabled rules with no project scope that write a field this project uses, where those values changed in the last 90 days."
        >
          {!automation?.available ? (
            <EmptyState inline>{automation?.reason}</EmptyState>
          ) : !automation.globalRulesAvailable ? (
            <EmptyState inline>{automation.globalRulesReason}</EmptyState>
          ) : !automation.globalRules.length ? (
            <EmptyState inline>No site-wide rule shows evidence of writing to this project recently.</EmptyState>
          ) : (
            <>
              <ul className="project-rules">
                {automation.globalRules.slice(0, 10).map((rule) => (
                  <li key={rule.ruleId} className="project-rules__item">
                    <span className="project-rules__name">{rule.name}</span>
                    {/* The evidence, so the inference can be judged rather than trusted. */}
                    <span className="project-rules__trigger">
                      {formatNumber(rule.issuesTouched)} issues · {formatNumber(rule.fieldsTouched)} {rule.fieldsTouched === 1 ? "field" : "fields"}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="project-pillar__sub">
                Inferred, not confirmed. Jira exposes no execution log to an app, so this is
                evidence that something wrote these fields here — not proof it was these rules.
                Fields are matched by name, so a rule writing a name this site uses twice
                matches both.
              </p>
            </>
          )}
        </Panel>
      </GridSpan>

      <GridSpan>
        <ProjectFiltersPanel filters={overview.filters} siteOrigin={siteOrigin} />
      </GridSpan>

      <GridSpan>
        <ProjectSchemesPanel schemes={overview.schemes} />
      </GridSpan>

      <GridSpan>
        <ProjectRolesPanel roles={overview.roles} />
      </GridSpan>

      {onBuildFieldReport && (
        <GridSpan wide>
          <ProjectScreenReportPanel projectId={overview.projectId ?? project?.projectId} onBuildFieldReport={onBuildFieldReport} />
        </GridSpan>
      )}

      <GridSpan>
        {/* Was "Form shape": a stacked colour bar with no legend and no explanation of what
            it stacked. It was field TYPE mix, which the label never said. */}
        <Panel title="Field types in use" icon="layers" description="What the form is made of. A project that is mostly text fields reports differently from one that is mostly select lists.">
          <FieldTypeDonut fields={fields} />
        </Panel>
      </GridSpan>
    </PanelGrid>
  );
}

// The project findings the Overview counts, as predicates over the rail's own rows.
//
// Derived here rather than sent down, because the rail already holds every project the
// reader may browse and the thresholds are a function of that list. One honest consequence:
// the count on a chip here can be lower than the count on the Overview, because the rail is
// filtered to projects the reader has Browse permission on and the score is not. That is the
// right asymmetry -- the alternative is naming projects somebody cannot see.

// Fields configured, no work recorded. Uses the measured issue count where the scan has
// produced one; null means unmeasured, and a project nobody has scanned is not a project
// with no work.
function measuredVolume(project, hasUniqueCounts) {
  return hasUniqueCounts ? project.uniqueIssueCount ?? null : project.totalIssueCount ?? null;
}

const STALE_MS = 180 * 24 * 60 * 60 * 1000;

// The "configured well past the site norm" threshold, and the median it is derived from.
//
// max(10, median * 2) -- the same floor the score judges against, and guarded the same way:
// on a site whose median project carries one field, "twice the median" is noise. Shared so
// buildProjectFilters and the card's own finding badge agree on what "over-configured" means.
export function overConfiguredFloor(projects = []) {
  const counts = projects.map((p) => p.fieldCount ?? 0).sort((a, b) => a - b);
  const median = counts.length ? counts[Math.min(counts.length - 1, Math.floor(counts.length * 0.5))] : 0;
  return { median, floor: Math.max(10, median * 2) };
}

export function buildProjectFilters(projects = []) {
  const hasUniqueCounts = projects.some((p) => p.uniqueIssueCount != null);

  const { median, floor } = overConfiguredFloor(projects);
  const now = Date.now();

  // Whether the input a filter needs was ever collected.
  //
  // This is the whole point of the tri-state, and it shipped without it. "Fell off" needs
  // the adoption series, which only a Universal Scan populates; until one has run, every
  // project has adoption: null, every match returns false, and the chip read "0" -- which is
  // indistinguishable from "no project on this site has fallen off". It was reporting the
  // absence of a measurement as a clean bill of health, which is the one thing this app is
  // built not to do, and the field card two tabs over already renders a dash for exactly
  // this case.
  const anyAdoption = projects.some((p) => p.adoption);
  const anyActivityDate = projects.some((p) => Number.isFinite(Date.parse(p.latestIssueUpdatedAt || "")));
  const anyVolume = hasUniqueCounts || projects.some((p) => p.totalIssueCount != null);

  return [
    { key: "all", label: "All projects", measurable: true, match: () => true },
    {
      key: "over-configured",
      label: `${floor}+ fields`,
      hint: `Configured well past the site norm — the median project carries ${median}.`,
      // Field counts come from the snapshot every project row is built from, so this one is
      // answerable whenever the rail has anything in it at all.
      measurable: true,
      match: (p) => (p.fieldCount ?? 0) >= floor,
    },
    {
      key: "no-work",
      label: "Fields but no work",
      hint: "Configured and then either abandoned or never started.",
      measurable: anyVolume,
      unmeasuredHint: "No issue counts have been collected yet. Run a scan from the Scans tab.",
      match: (p) => (p.fieldCount ?? 0) > 0 && measuredVolume(p, hasUniqueCounts) === 0,
    },
    {
      key: "fell-off",
      label: "Fell off",
      hint: "Had a real life and lost it — running far below its own historical rate.",
      measurable: anyAdoption,
      unmeasuredHint: "Adoption needs issue creation dates, which only a Universal Scan collects. Run one from the Scans tab.",
      match: (p) => Boolean(p.adoption?.fellOff),
    },
    {
      key: "stale",
      label: "Quiet 6 months",
      hint: "Carrying work, but nothing has been touched in over six months.",
      measurable: anyActivityDate,
      unmeasuredHint: "No project has a recorded last-activity date yet. Run a scan from the Scans tab.",
      match: (p) => {
        const at = Date.parse(p.latestIssueUpdatedAt || "");
        return (p.totalIssueCount ?? 0) > 0 && Number.isFinite(at) && now - at > STALE_MS;
      },
    },
  ];
}

// What the chip shows: a number when the question is answerable, and a dash when it is not.
//
// Never zero for an unmeasured filter. Zero is a finding -- it says we looked and found
// none -- and using it for "we have not looked" is the same false all-clear the rest of this
// app refuses to give.
export function projectFilterCount(option, projects) {
  if (!option.measurable) return null;
  return projects.filter(option.match).length;
}

const PROJECT_LIST_PAGE_SIZE = 25;

const PROJECT_SORT_OPTIONS = [
  { value: "adoption-desc", label: "Adoption: highest" },
  { value: "adoption-asc", label: "Adoption: lowest" },
  { value: "issues-desc", label: "Most issues" },
  { value: "fields-desc", label: "Most fields in use" },
  { value: "activity-desc", label: "Recently active" },
  { value: "activity-asc", label: "Quietest" },
  { value: "name-asc", label: "Key A–Z" },
];

const numOr = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const tsOr = (v, fallback) => {
  const t = Date.parse(v || "");
  return Number.isFinite(t) ? t : fallback;
};

export function sortProjectList(list, sortBy) {
  const rows = [...list];
  switch (sortBy) {
    case "adoption-asc":
      return rows.sort((a, b) => numOr(a.adoption?.score, Infinity) - numOr(b.adoption?.score, Infinity));
    case "issues-desc":
      return rows.sort((a, b) => numOr(b.uniqueIssueCount ?? b.totalIssueCount, -1) - numOr(a.uniqueIssueCount ?? a.totalIssueCount, -1));
    case "fields-desc":
      return rows.sort((a, b) => numOr(b.fieldCount, -1) - numOr(a.fieldCount, -1));
    case "activity-desc":
      return rows.sort((a, b) => tsOr(b.latestIssueUpdatedAt, -Infinity) - tsOr(a.latestIssueUpdatedAt, -Infinity));
    case "activity-asc":
      return rows.sort((a, b) => tsOr(a.latestIssueUpdatedAt, Infinity) - tsOr(b.latestIssueUpdatedAt, Infinity));
    case "name-asc":
      return rows.sort((a, b) => String(a.projectKey).localeCompare(String(b.projectKey)));
    case "adoption-desc":
    default:
      return rows.sort((a, b) => numOr(b.adoption?.score, -1) - numOr(a.adoption?.score, -1));
  }
}

// Which of the rail's own finding filters a project trips. Computed once so the card can
// flag with the shared FindingsStrip exactly the way a FieldCard does, rather than growing
// a parallel badge vocabulary.
export function projectCardFindings(project, floor) {
  const at = Date.parse(project.latestIssueUpdatedAt || "");
  const volume = project.uniqueIssueCount != null ? project.uniqueIssueCount : project.totalIssueCount;
  return {
    stale: (project.totalIssueCount ?? 0) > 0 && Number.isFinite(at) && Date.now() - at > STALE_MS,
    overConfigured: (project.fieldCount ?? 0) >= floor,
    noWork: (project.fieldCount ?? 0) > 0 && volume === 0,
    fellOff: Boolean(project.adoption?.fellOff),
  };
}

// One project as an expand-in-place card: a collapsed metric grid plus the shared
// FindingsStrip, and on expand the full cross-pillar ProjectOverview and this project's
// field list. The same shape as FieldCard so Fields and Projects read as one product; the
// report checkbox FieldCard carries is absent, because a project is inspected, not reported on.
export function ProjectCard({
  project, floor, expanded, loading, onToggle,
  overview, overviewLoading, siteOrigin,
  selectedAdoption, adoptionContext, workflowScheme, peerProjects, onBuildFieldReport,
  fields, availableTypes, totalFields, fieldPage, fieldTotalPages, fieldPageSize,
  fieldQuery, onFieldQueryChange, fieldType, onFieldTypeChange, fieldSort, onFieldSortChange, onChangePage,
}) {
  const [view, setView] = React.useState("overview");

  const issues = Number(project.uniqueIssueCount);
  const fills = Number(project.totalIssueCount);
  const hasIssues = Number.isFinite(issues) && issues > 0;
  const perIssue = hasIssues && Number.isFinite(fills) ? (fills / issues).toFixed(1) : null;

  const { stale, overConfigured, noWork, fellOff } = projectCardFindings(project, floor);
  const findings = { tags: { risky: fellOff, cleanup: noWork || stale, standardize: overConfigured } };
  const severityClass = fellOff
    ? "field-card--has-danger"
    : (overConfigured || noWork || stale) ? "field-card--has-warn" : "";

  return (
    <article className={`field-card field-card--project ${expanded ? "field-card--open" : ""} ${severityClass}`}>
      <button
        className={`field-card__header${expanded && overviewLoading ? " field-card__header--loading" : ""}`}
        onClick={onToggle}
        type="button"
        aria-expanded={expanded}
      >
        <div className="field-card__title-wrap">
          <div className="field-card__field-id">
            <span className="copy-field-id__value">{project.projectKey}</span>
          </div>
          <h3>{project.projectName}</h3>
          <p>
            {hasIssues
              ? `${formatNumber(issues)} issues · ${formatNumber(fills)} field values`
              : `${formatNumber(Number.isFinite(fills) ? fills : 0)} field values — run a universe scan for issue counts`}
          </p>
          <FindingsStrip findings={findings} />
        </div>
        <div className="field-card__meta">
          <MetricChip label="Issues" value={hasIssues ? formatNumber(issues) : "—"} />
          <MetricChip label="Field values" value={formatNumber(Number.isFinite(fills) ? fills : 0)} tone="cool" />
          <MetricChip label="Fields in use" value={formatNumber(project.fieldCount ?? 0)} tone="warm" />
          <MetricChip label="Fields per issue" value={perIssue ?? "—"} />
          <MetricChip
            label="Adoption"
            value={project.adoption?.score ?? "—"}
            tone={fellOff ? "danger" : project.adoption ? "success" : "neutral"}
          />
          <MetricChip label="Issues per day" value={project.adoption ? formatRate(project.adoption.issuesPerDay) : "—"} />
          <MetricChip label="Age" value={project.adoption ? formatAge(project.adoption.ageDays) : "—"} tone="cool" />
          <MetricChip
            label="Last activity"
            value={project.latestIssueUpdatedAt ? formatRelativeTime(project.latestIssueUpdatedAt) : "—"}
            tone={stale ? "warm" : "neutral"}
          />
          <MetricChip
            label="Trend"
            value={fellOff ? "Fell off" : project.adoption ? "Active" : "—"}
            tone={fellOff ? "danger" : "neutral"}
          />
        </div>
        <span className="field-card__toggle-icon" aria-hidden="true" />
      </button>

      {expanded && (
        <div className="field-card__body">
          <div className="section-heading">
            <div>
              <div className="snapshot-log-entries__heading">{project.projectKey} · {project.projectName}</div>
            </div>
            <div className="section-heading__actions">
              <AskRovo
                agent="observatory-project-expert"
                scope={project.projectKey}
                context="this project's key, its workflow scheme and how many projects share it, and its cached field-usage count"
                buildPrompt={() =>
                  buildRovoPrompt({
                    task: `Explain project ${project.projectKey} (${project.projectName}): which schemes it resolves to, how it compares with its siblings, and anything worth reviewing.`,
                    facts: [
                      ["Project key", project.projectKey],
                      ["Project id", project.projectId],
                      ["Workflow scheme", workflowScheme?.name || "unknown"],
                      ["Projects sharing that workflow scheme", workflowScheme?.sharedWithCount ?? null],
                      ["Fields in use", project.fieldCount ?? null],
                    ],
                  })
                }
              />
            </div>
          </div>

          <SubNavLayout
            items={[
              { key: "overview", label: "Overview", icon: "barChart" },
              { key: "fields", label: "Fields", icon: "layers", badge: formatNumber(totalFields) },
            ]}
            activeKey={view}
            onSelect={setView}
          >
            {view === "overview" ? (
              <>
                <ProjectOverview
                  project={project}
                  overview={overview}
                  loading={overviewLoading}
                  fields={fields}
                  siteOrigin={siteOrigin}
                  adoption={selectedAdoption}
                  adoptionContext={adoptionContext}
                  onBuildFieldReport={onBuildFieldReport}
                />
                <SchemePeerBars scheme={workflowScheme} project={project} allProjects={peerProjects} />
              </>
            ) : (
              <>
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
                      <article className="project-usage-card" key={`${project.projectId}-${field.fieldId}`}>
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
                      ? `Showing ${(fieldPage - 1) * fieldPageSize + 1}-${Math.min(fieldPage * fieldPageSize, totalFields)} of ${totalFields} fields on ${project.projectKey}`
                      : `No field usage rows are cached for ${project.projectKey}`}
                  </span>
                  <div className="pagination-bar__actions">
                    <button className="secondary-button" type="button" onClick={() => onChangePage(1)} disabled={fieldPage === 1 || !totalFields}>First</button>
                    <button className="secondary-button" type="button" onClick={() => onChangePage(Math.max(1, fieldPage - 1))} disabled={fieldPage === 1 || !totalFields}>Previous</button>
                    <button className="secondary-button" type="button" onClick={() => onChangePage(Math.min(fieldTotalPages, fieldPage + 1))} disabled={fieldPage === fieldTotalPages || !totalFields}>Next</button>
                    <button className="secondary-button" type="button" onClick={() => onChangePage(fieldTotalPages)} disabled={fieldPage === fieldTotalPages || !totalFields}>Last</button>
                  </div>
                </section>
              </>
            )}
          </SubNavLayout>
        </div>
      )}
    </article>
  );
}

export function ProjectsTabView({
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
  overview,
  overviewLoading,
  projectFilter = "all",
  onProjectFilterChange,
  onBuildFieldReport,
}) {
  const allProjects = data?.projects || [];
  const projectFilters = React.useMemo(() => buildProjectFilters(allProjects), [allProjects]);
  const activeProjectFilter = projectFilters.find((f) => f.key === projectFilter) ?? projectFilters[0];
  const { floor } = React.useMemo(() => overConfiguredFloor(allProjects), [allProjects]);

  const [projectSort, setProjectSort] = React.useState("adoption-desc");
  const [listPage, setListPage] = React.useState(1);

  const term = (projectQuery || "").trim().toLowerCase();
  const visible = React.useMemo(() => {
    const matched = allProjects.filter(activeProjectFilter.match);
    const searched = term
      ? matched.filter((p) =>
          String(p.projectKey).toLowerCase().includes(term) ||
          String(p.projectName).toLowerCase().includes(term))
      : matched;
    return sortProjectList(searched, projectSort);
  }, [allProjects, activeProjectFilter, term, projectSort]);

  // The result set changed out from under the pager -- go back to page one rather than
  // stranding the reader on a page that no longer exists.
  React.useEffect(() => { setListPage(1); }, [term, projectFilter, projectSort, allProjects.length]);

  const totalProjects = visible.length;
  const totalListPages = Math.max(1, Math.ceil(totalProjects / PROJECT_LIST_PAGE_SIZE));
  const pageNum = Math.min(listPage, totalListPages);
  const pageStart = (pageNum - 1) * PROJECT_LIST_PAGE_SIZE;
  const pageProjects = visible.slice(pageStart, pageStart + PROJECT_LIST_PAGE_SIZE);

  const refreshedAt = data?.refreshedAt || null;
  const showFilterChips = Boolean(onProjectFilterChange) && allProjects.length > 0;

  return (
    <div className="admin-field-browser projects-browser">
      <PageHeader
        title="Projects"
        description="Every project with cached field usage, and the workflow, screen, automation, filter and access context that touches it. Click a project to expand it in place."
        meta={refreshedAt ? `Usage refreshed ${formatTimestamp(refreshedAt)}` : undefined}
      />

      <div className="admin-field-browser__toolbar">
        <SortFilterBar
          search={projectQuery}
          onSearchChange={onProjectQueryChange}
          searchLabel="Search projects"
          searchPlaceholder="Project key or name…"
          sort={projectSort}
          onSortChange={setProjectSort}
          sortOptions={PROJECT_SORT_OPTIONS}
          onClear={() => {
            onProjectQueryChange("");
            setProjectSort("adoption-desc");
            onProjectFilterChange?.("all");
          }}
        />
      </div>

      {showFilterChips && (
        <div className="findings-filter-bar" style={{ marginTop: 4 }}>
          {projectFilters.map((option) => {
            const count = projectFilterCount(option, allProjects);
            const unmeasured = count === null;
            return (
              <button
                key={option.key}
                type="button"
                // The reason it cannot be answered, not what it would have meant -- a reader
                // hovering a dash wants to know what to build.
                title={unmeasured ? option.unmeasuredHint : option.hint}
                disabled={unmeasured}
                className={`findings-filter-button${projectFilter === option.key ? " findings-filter-button--active" : ""}${unmeasured ? " findings-filter-button--unmeasured" : ""}`}
                onClick={() => onProjectFilterChange(option.key)}
              >
                <span>{option.label}</span>
                <strong>{unmeasured ? "—" : formatNumber(count)}</strong>
              </button>
            );
          })}
        </div>
      )}

      <div className="admin-field-browser__pagebar admin-field-browser__pagebar--top">
        <span className="admin-pagination__info">
          {totalProjects > 0
            ? `Showing ${pageStart + 1}–${Math.min(pageStart + PROJECT_LIST_PAGE_SIZE, totalProjects)} of ${formatNumber(totalProjects)} projects`
            : loading ? "Loading…" : "No projects match the current filter"}
        </span>
        <div className="admin-field-browser__page-nav">
          <button disabled={pageNum <= 1} className="secondary-button secondary-button--small" type="button" onClick={() => setListPage(1)}>First</button>
          <button disabled={pageNum <= 1} className="secondary-button secondary-button--small" type="button" onClick={() => setListPage((p) => Math.max(1, p - 1))}>Previous</button>
          <button disabled={pageNum >= totalListPages} className="secondary-button secondary-button--small" type="button" onClick={() => setListPage((p) => Math.min(totalListPages, p + 1))}>Next</button>
          <button disabled={pageNum >= totalListPages} className="secondary-button secondary-button--small" type="button" onClick={() => setListPage(totalListPages)}>Last</button>
        </div>
      </div>

      {loading && !allProjects.length ? (
        <div className="admin-field-list">
          {Array.from({ length: 5 }, (_, i) => <SkeletonFieldCard key={i} />)}
        </div>
      ) : totalProjects === 0 ? (
        <EmptyState>
          {loading
            ? "Loading projects…"
            : projectFilter !== "all" && allProjects.length > 0
              ? (activeProjectFilter.measurable
                  ? `No project matches “${activeProjectFilter.label}”.`
                  : activeProjectFilter.unmeasuredHint)
              : term
                ? `No project matches “${projectQuery}”.`
                : (
                  <>
                    No projects with cached field usage were found.{" "}
                    {onRestoreProjectUsageCache ? (
                      <button
                        className="secondary-button secondary-button--small"
                        type="button"
                        onClick={onRestoreProjectUsageCache}
                        disabled={projectUsageRestoring}
                      >
                        {projectUsageRestoring ? "Restoring…" : "Restore from field summaries"}
                      </button>
                    ) : null}
                  </>
                )}
        </EmptyState>
      ) : (
        <div className="admin-field-list">
          {pageProjects.map((project) => {
            const isOpen = project.projectId === selectedProjectId;
            return (
              <ProjectCard
                key={project.projectId}
                project={project}
                floor={floor}
                expanded={isOpen}
                loading={loading}
                overviewLoading={overviewLoading}
                onToggle={() => onSelectProject(isOpen ? "" : project.projectId)}
                overview={isOpen ? overview : null}
                siteOrigin={siteOrigin}
                selectedAdoption={isOpen ? (data?.selectedAdoption ?? null) : null}
                adoptionContext={data?.adoptionContext ?? null}
                workflowScheme={isOpen ? data?.workflowScheme : null}
                peerProjects={visible}
                onBuildFieldReport={onBuildFieldReport}
                fields={isOpen ? (data?.fields || []) : []}
                availableTypes={data?.availableTypes || []}
                totalFields={Number(data?.totalFields || 0)}
                fieldPage={Number(data?.page || 1)}
                fieldTotalPages={Number(data?.totalPages || 1)}
                fieldPageSize={Number(data?.pageSize || 24)}
                fieldQuery={fieldQuery}
                onFieldQueryChange={onFieldQueryChange}
                fieldType={fieldType}
                onFieldTypeChange={onFieldTypeChange}
                fieldSort={fieldSort}
                onFieldSortChange={onFieldSortChange}
                onChangePage={onChangePage}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
