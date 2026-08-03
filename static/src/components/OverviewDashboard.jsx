import React from "react";
import { invoke } from "@forge/bridge";
import { Icon } from "./Icons";
import { formatNumber, formatRelativeTime } from "../utils";
import { StatTile, StatRow, Panel, EmptyState, BarList, FindingRow, LinkButton } from "./ui";

// The admin landing page.
//
// Its job is to route attention, not to display everything. Every other tab answers a
// question you already have; this one tells you which question to ask. So findings that
// need action come first and deep-link to the tab that resolves them, and the descriptive
// charts sit below where they inform rather than compete.

// ── Findings ────────────────────────────────────────────────────────────────
//
// Assembled from three independent sources (field governance, project shape, workflow
// health), each of which may be unavailable. Anything whose source has not been built is
// omitted rather than rendered as zero, because "0 duplicate statuses" and "we have never
// looked for duplicate statuses" are completely different statements.

function buildFindings({ findingsSummary, dashboard, workflow, onNavigate }) {
  const findings = [];

  if (findingsSummary?.adminAttention > 0) {
    findings.push({
      key: "admin-attention",
      tone: "critical",
      count: findingsSummary.adminAttention,
      title: "Fields need admin attention",
      detail: "Configuration problems that affect how these fields behave in Jira.",
      onOpen: () => onNavigate("fields"),
      openLabel: "Field Browser",
    });
  }

  if (findingsSummary?.risky > 0) {
    findings.push({
      key: "risky",
      tone: "warning",
      count: findingsSummary.risky,
      title: "Fields flagged as risky",
      detail: "Global contexts or broad scope that make changes hard to reason about.",
      onOpen: () => onNavigate("fields"),
      openLabel: "Field Browser",
    });
  }

  if (workflow?.available && workflow.duplicateGroupCount > 0) {
    findings.push({
      key: "duplicate-statuses",
      tone: "warning",
      count: workflow.duplicateGroupCount,
      title: "Groups of duplicate statuses",
      detail: workflow.reducibleStatusCount > 0
        ? `Consolidating them removes ${formatNumber(workflow.reducibleStatusCount)} statuses from the site.`
        : "Statuses that almost certainly mean the same thing.",
      onOpen: () => onNavigate("workflows"),
      openLabel: "Workflows",
    });
  }

  // Only offered as a cleanup when the scan has confirmed the statuses are unused.
  // Without counts this is a list to review, not an action, so it is not a finding.
  if (workflow?.available && workflow.safeToRemoveCount > 0) {
    findings.push({
      key: "unused-statuses",
      tone: "info",
      count: workflow.safeToRemoveCount,
      title: "Statuses never used and unreachable",
      detail: "No workflow reaches them and no issue has ever been in one.",
      onOpen: () => onNavigate("workflows"),
      openLabel: "Workflows",
    });
  }

  if (workflow?.available && workflow.flaggedSchemeCount > 0) {
    findings.push({
      key: "scheme-balance",
      tone: "warning",
      count: workflow.flaggedSchemeCount,
      title: "Workflow schemes with a structural flag",
      detail: "Missing a Done status, heavily weighted to In Progress, or oversized.",
      onOpen: () => onNavigate("workflows"),
      openLabel: "Workflows",
    });
  }

  if (dashboard?.projects?.overConfigured?.length > 0) {
    findings.push({
      key: "over-configured",
      tone: "info",
      count: dashboard.projects.overConfigured.length,
      title: "Projects configured well past the site norm",
      detail: `Median project carries ${formatNumber(dashboard.projects.medianFieldCount)} fields; these carry far more with little issue volume.`,
      onOpen: () => onNavigate("projects"),
      openLabel: "Project Usage",
    });
  }

  if (findingsSummary?.cleanup > 0) {
    findings.push({
      key: "cleanup",
      tone: "info",
      count: findingsSummary.cleanup,
      title: "Fields suggested for cleanup",
      detail: "Unused, unpopulated, or superseded by another field.",
      onOpen: () => onNavigate("fields"),
      openLabel: "Field Browser",
    });
  }

  return findings;
}

function FindingsPanel({ findings, workflow, onNavigate }) {
  if (!findings.length) {
    return (
      <Panel title="What needs attention" icon="checkCircle">
        <EmptyState
          action={!workflow?.available ? <LinkButton onClick={() => onNavigate("workflows")}>Build workflow inventory</LinkButton> : null}
        >
          {workflow?.available
            ? "Nothing flagged. Field governance, project shape and workflow health all look clean."
            : "Nothing flagged in the field data. Build the workflow inventory to check status and scheme health too."}
        </EmptyState>
      </Panel>
    );
  }

  return (
    <Panel
      title="What needs attention"
      icon="alertTriangle"
      description="Ordered by severity. Each opens the tab that resolves it."
    >
      <div className="ui-finding-list">
        {findings.map((finding) => (
          <FindingRow
            key={finding.key}
            tone={finding.tone}
            count={formatNumber(finding.count)}
            title={finding.title}
            detail={finding.detail}
            action={<LinkButton onClick={finding.onOpen}>{finding.openLabel}</LinkButton>}
          />
        ))}
      </div>
    </Panel>
  );
}

// ── Workflow ────────────────────────────────────────────────────────────────

function WorkflowPanel({ workflow, onNavigate }) {
  if (!workflow?.available) {
    return (
      <Panel title="Workflows and statuses" icon="activity">
        <EmptyState action={<LinkButton onClick={() => onNavigate("workflows")}>Open Workflows</LinkButton>}>
          {workflow?.state === "building"
            ? "Building the workflow inventory…"
            : "No workflow inventory yet. Build one to see scheme sharing and status health."}
        </EmptyState>
      </Panel>
    );
  }

  return (
    <Panel
      title="Workflows and statuses"
      icon="activity"
      description={workflow.refreshedAt ? `Built ${formatRelativeTime(workflow.refreshedAt)}` : undefined}
      action={<LinkButton onClick={() => onNavigate("workflows")}>Open Workflows</LinkButton>}
    >
      <StatRow>
        <StatTile
          label="Workflow schemes"
          value={formatNumber(workflow.schemeCount)}
          hint={`${formatNumber(workflow.sharedSchemes)} shared by more than one project`}
          icon="activity"
        />
        <StatTile label="Statuses" value={formatNumber(workflow.statusCount)} icon="layers" />
        <StatTile
          label="Duplicate groups"
          value={formatNumber(workflow.duplicateGroupCount)}
          hint={workflow.reducibleStatusCount > 0 ? `${formatNumber(workflow.reducibleStatusCount)} removable` : undefined}
          tone={workflow.duplicateGroupCount > 0 ? "warning" : "neutral"}
        />
        <StatTile
          label="Unreachable"
          value={workflow.schemeStatusesAvailable ? formatNumber(workflow.orphanCount) : "—"}
          hint={
            !workflow.schemeStatusesAvailable
              ? "workflow status data unavailable"
              : workflow.hasIssueCounts
                ? `${formatNumber(workflow.safeToRemoveCount)} never used`
                : "run a scan to confirm usage"
          }
          tone={workflow.schemeStatusesAvailable && workflow.orphanCount > 0 ? "warning" : "neutral"}
        />
      </StatRow>

      {/* Scheme sharing is the premise the whole correlation rests on. If nothing is
          shared, per-scheme comparison has no leverage and it is better to say so. */}
      {workflow.sharedSchemes === 0 && workflow.schemeCount > 0 && (
        <p className="ui-note">
          <Icon name="info" size={13} /> No scheme governs more than one project, so there is
          no shared process to compare field usage against.
        </p>
      )}
    </Panel>
  );
}

// ── Projects ────────────────────────────────────────────────────────────────

function ProjectsPanel({ projects, onNavigate }) {
  if (!projects || !projects.totalProjects) {
    return (
      <Panel title="Projects" icon="folder">
        <EmptyState>No project usage data yet. Run a scan to populate it.</EmptyState>
      </Panel>
    );
  }

  return (
    <Panel
      title="Projects"
      icon="folder"
      action={<LinkButton onClick={() => onNavigate("projects")}>Open Project Usage</LinkButton>}
    >
      <StatRow>
        <StatTile label="Projects with field usage" value={formatNumber(projects.totalProjects)} icon="folder" />
        <StatTile label="Issues covered" value={formatNumber(projects.totalIssues)} icon="barChart" />
        <StatTile
          label="Median fields per project"
          value={formatNumber(projects.medianFieldCount)}
          hint={`90th percentile ${formatNumber(projects.p90FieldCount)}`}
          icon="layers"
        />
        <StatTile
          label="No issues recorded"
          value={formatNumber(projects.unusedProjects?.length ?? 0)}
          hint="fields configured, nothing filed"
          tone={projects.unusedProjects?.length ? "warning" : "neutral"}
        />
      </StatRow>

      <div className="ui-split">
        <div className="ui-split__col">
          <h4 className="ui-subhead">Highest issue volume</h4>
          <BarList
            items={projects.topByIssueVolume}
            labelKey="projectKey"
            valueKey="totalIssueCount"
            formatValue={formatNumber}
            emptyMessage="No issue data yet"
          />
        </div>
        <div className="ui-split__col">
          <h4 className="ui-subhead">Most fields configured</h4>
          <BarList
            items={projects.topByFieldCount}
            labelKey="projectKey"
            valueKey="fieldCount"
            formatValue={formatNumber}
            tone="warn"
            emptyMessage="No field data yet"
          />
        </div>
      </div>

      {projects.overConfigured?.length > 0 && (
        <div className="ui-split__col">
          <h4 className="ui-subhead">Configured past the norm, low volume</h4>
          <p className="ui-subhead__desc">
            Well above the median field count while carrying little work — the cost is real
            and the usage is not.
          </p>
          <BarList
            items={projects.overConfigured}
            labelKey="projectKey"
            valueKey="fieldCount"
            formatValue={formatNumber}
            tone="warn"
          />
        </div>
      )}

      {projects.staleProjects?.length > 0 && (
        <div className="ui-split__col">
          <h4 className="ui-subhead">No activity in over six months</h4>
          <div className="ui-stale-list">
            {projects.staleProjects.map((project) => (
              <div key={project.projectKey} className="ui-stale">
                <span className="ui-stale__key">{project.projectKey}</span>
                <span className="ui-stale__name">{project.projectName}</span>
                <span className="ui-stale__when">{formatRelativeTime(project.latestIssueUpdatedAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

// ── Fields ──────────────────────────────────────────────────────────────────

function FieldsPanel({ fieldUsage, onNavigate }) {
  const severity = fieldUsage?.findingsBySeverity || { high: 0, medium: 0, low: 0 };
  const origin = fieldUsage?.origin || { builtin: 0, appProvided: 0, custom: 0 };

  return (
    <Panel
      title="Field usage"
      icon="layers"
      action={<LinkButton onClick={() => onNavigate("fields")}>Open Field Browser</LinkButton>}
    >
      <StatRow>
        <StatTile
          label="High severity"
          value={formatNumber(severity.high)}
          tone={severity.high > 0 ? "critical" : "neutral"}
          icon="alertTriangle"
        />
        <StatTile
          label="Medium severity"
          value={formatNumber(severity.medium)}
          tone={severity.medium > 0 ? "warning" : "neutral"}
          icon="alertTriangle"
        />
        <StatTile label="Low severity" value={formatNumber(severity.low)} icon="info" />
        <StatTile
          label="Duplicate-name clusters"
          value={formatNumber(fieldUsage?.duplicateClusters ?? 0)}
          hint={`${formatNumber(origin.custom)} custom fields total`}
          icon="scissors"
        />
      </StatRow>

      <div className="ui-split">
        <div className="ui-split__col">
          <h4 className="ui-subhead">Most common findings</h4>
          <BarList
            items={fieldUsage?.findingsByType}
            labelKey="title"
            valueKey="count"
            formatValue={formatNumber}
            tone="warn"
            emptyMessage="No governance findings yet"
          />
        </div>
        <div className="ui-split__col">
          <h4 className="ui-subhead">Field types</h4>
          <BarList
            items={fieldUsage?.fieldTypeBreakdown}
            labelKey="type"
            valueKey="count"
            formatValue={formatNumber}
            emptyMessage="No field data yet"
          />
        </div>
      </div>
    </Panel>
  );
}

// ── RQT ─────────────────────────────────────────────────────────────────────

function RqtPanel({ onOpenRqtIndex }) {
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

  const show = (value) => (loading ? "…" : error ? "—" : formatNumber(value ?? 0));

  return (
    <Panel
      title="RQT values"
      icon="zap"
      action={<LinkButton onClick={onOpenRqtIndex}>Open RQT Index</LinkButton>}
    >
      <StatRow>
        <StatTile label="Unique issues" value={show(rqt?.totalUniqueIssues)} icon="barChart" />
        <StatTile label="Fields with RQT values" value={show(rqt?.fieldCount)} icon="layers" />
        <StatTile label="Unique values" value={show(rqt?.uniqueValues?.length)} icon="scissors" />
      </StatRow>
    </Panel>
  );
}

export function OverviewDashboard({ dashboard, findingsSummary, workflow, onOpenRqtIndex, onNavigate }) {
  // onNavigate is optional so this stays renderable in isolation; without it the deep
  // links become inert rather than throwing.
  const navigate = onNavigate || (() => {});
  const findings = buildFindings({ findingsSummary, dashboard, workflow, onNavigate: navigate });

  return (
    <div className="ui-dashboard">
      <FindingsPanel findings={findings} workflow={workflow} onNavigate={navigate} />
      <WorkflowPanel workflow={workflow} onNavigate={navigate} />
      <ProjectsPanel projects={dashboard?.projects} onNavigate={navigate} />
      <FieldsPanel fieldUsage={dashboard?.fieldUsage} onNavigate={navigate} />
      <RqtPanel onOpenRqtIndex={onOpenRqtIndex} />
    </div>
  );
}
