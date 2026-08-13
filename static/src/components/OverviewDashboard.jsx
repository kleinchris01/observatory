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

// Severity bands, in the order they are shown. The list used to be a flat severity sort,
// which reads fine at six rows and stops reading at sixteen -- everything below the fold
// looked equally optional. The bands say what the tone already meant, in words.
const FINDING_BANDS = [
  { tone: "critical", label: "Act now", description: "Broken or exposed configuration. Someone is relying on these being right." },
  { tone: "warning", label: "Worth reviewing", description: "Working today, but the cost or the risk is growing." },
  { tone: "info", label: "Cleanup when convenient", description: "Safe to leave. Safe to remove, once confirmed." },
];

function buildFindings({ findingsSummary, dashboard, workflow, screens, automation, onNavigate }) {
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
      title: "Statuses with no evidence of use",
      detail: "No workflow reaches them and no issue has ever been in one. Automation rules are not visible to this app, so check those before deleting.",
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

  // Was computed by summarizeFindings and then dropped on the floor here, so the one
  // category that describes site-wide inconsistency never appeared on the site-wide page.
  if (findingsSummary?.standardize > 0) {
    findings.push({
      key: "standardize",
      tone: "info",
      count: findingsSummary.standardize,
      title: "Fields that could be standardised",
      detail: "Close enough to another field that one definition would serve both.",
      onOpen: () => onNavigate("fields"),
      openLabel: "Field Browser",
    });
  }

  // ── Automation ──────────────────────────────────────────────────────────
  //
  // Every one of these was already computed by the automation analysis and scored in site
  // health, and none of them reached this list -- the page whose entire job is to say what
  // needs attention was silent about the pillar carrying the credential findings.

  if (automation?.available && automation.credentialRuleCount > 0) {
    findings.push({
      key: "automation-credentials",
      tone: "critical",
      count: automation.credentialRuleCount,
      title: "Automation rules storing a credential in plaintext",
      detail: "Anyone who can view the rule can read the secret. Rotate them, then move to a smart-value reference or an Automation connection.",
      onOpen: () => onNavigate("automation"),
      openLabel: "Automation",
    });
  }

  if (automation?.available && automation.selfTriggeringCount > 0) {
    findings.push({
      key: "automation-self-triggering",
      tone: "warning",
      count: automation.selfTriggeringCount,
      title: "Rules that write a field they trigger on",
      detail: "These loop without a second rule involved. Check the conditions guarding them before the next execution-limit surprise.",
      onOpen: () => onNavigate("automation"),
      openLabel: "Automation",
    });
  }

  if (automation?.available && automation.externalHttpCount > 0) {
    findings.push({
      key: "automation-external",
      tone: "warning",
      count: automation.externalHttpCount,
      title: "Rules sending data outside Atlassian",
      detail: "Each moves Jira data out of the tenancy. Confirm every destination is still one you own.",
      onOpen: () => onNavigate("automation"),
      openLabel: "Automation",
    });
  }

  if (automation?.available && automation.noActionCount > 0) {
    findings.push({
      key: "automation-inert",
      tone: "info",
      count: automation.noActionCount,
      title: "Rules with a trigger but no actions",
      detail: "They consume execution budget on every trigger and do nothing with it.",
      onOpen: () => onNavigate("automation"),
      openLabel: "Automation",
    });
  }

  if (automation?.available && automation.disabledCount > 0) {
    findings.push({
      key: "automation-disabled",
      tone: "info",
      count: automation.disabledCount,
      title: "Disabled automation rules",
      detail: "A large disabled estate hides which rules were retired on purpose and which were forgotten. Decide per rule: revive or delete.",
      onOpen: () => onNavigate("automation"),
      openLabel: "Automation",
    });
  }

  // ── Screens ─────────────────────────────────────────────────────────────

  if (screens?.available && screens.danglingOperations > 0) {
    findings.push({
      key: "screen-dangling",
      tone: "critical",
      count: screens.danglingOperations,
      title: "Scheme operations pointing at a missing screen",
      detail: "Jira falls back silently when one of these resolves, so the form a user sees is not the one the scheme names.",
      onOpen: () => onNavigate("screens"),
      openLabel: "Screens",
    });
  }

  // A measurement gap, not a site defect -- and it caps every screen finding below it, so
  // it is stated before them rather than after.
  if (screens?.available && screens.unresolvedScreens > 0) {
    findings.push({
      key: "screen-unresolved",
      tone: "warning",
      count: screens.unresolvedScreens,
      title: "Screens whose contents could not be read",
      detail: "Not counted as empty — the build could not see them at all, so the screen findings below exclude these.",
      onOpen: () => onNavigate("screens"),
      openLabel: "Screens",
    });
  }

  // Only offered once transitions are known. A screen attached to a workflow transition is
  // opened every time someone moves an issue, while belonging to no screen scheme -- so
  // without the workflow inventory this finding would invite deleting screens in daily use.
  if (screens?.available && screens.unreachedScreens > 0) {
    findings.push({
      key: "screen-unreached",
      tone: "info",
      count: screens.unreachedScreens,
      title: "Screens nothing reaches",
      detail: "No scheme maps to them and no workflow transition opens them, so no user encounters them.",
      onOpen: () => onNavigate("screens"),
      openLabel: "Screens",
    });
  }

  // The correction, stated as its own row. These are screens the scheme chain alone calls
  // unreachable and a transition is actually using.
  if (screens?.available && screens.transitionOnlyScreens > 0) {
    findings.push({
      key: "screen-transition-only",
      tone: "info",
      count: screens.transitionOnlyScreens,
      title: "Screens used only by a workflow transition",
      detail: "No screen scheme references them, so they look orphaned in the scheme view — but a transition opens them. Do not delete these.",
      onOpen: () => onNavigate("screens"),
      openLabel: "Screens",
    });
  }

  if (screens?.available && screens.emptyScreens > 0) {
    findings.push({
      key: "screen-empty",
      tone: "info",
      count: screens.emptyScreens,
      title: "Screens carrying no fields",
      detail: "Read successfully and found to have nothing on them.",
      onOpen: () => onNavigate("screens"),
      openLabel: "Screens",
    });
  }

  if (screens?.available && screens.unusedSchemes > 0) {
    findings.push({
      key: "screen-unused-schemes",
      tone: "info",
      count: screens.unusedSchemes,
      title: "Screen schemes no issue type maps to",
      detail: "They cannot route anything to a project until an issue type screen scheme references them.",
      onOpen: () => onNavigate("screens"),
      openLabel: "Screens",
    });
  }

  // ── Projects ────────────────────────────────────────────────────────────

  if (dashboard?.projects?.staleProjects?.length > 0) {
    findings.push({
      key: "stale-projects",
      tone: "info",
      count: dashboard.projects.staleProjects.length,
      title: "Projects with no activity in over six months",
      detail: "Still carrying field configuration. The cheapest place to retire fields, if the project is genuinely done.",
      onOpen: () => onNavigate("projects"),
      openLabel: "Project Usage",
    });
  }

  return findings;
}

function FindingsPanel({ findings, workflow, screens, automation, onNavigate }) {
  // Which pillars have never been built. Named individually, because "nothing flagged" while
  // three of five pillars have never been looked at is not a clean bill of health -- it is a
  // clean bill of the two things we checked.
  const unbuilt = [
    !workflow?.available && { label: "workflow inventory", tab: "workflows" },
    !screens?.available && { label: "screen inventory", tab: "screens" },
    !automation?.available && { label: "automation analysis", tab: "automation" },
  ].filter(Boolean);

  if (!findings.length) {
    return (
      <Panel title="What needs attention" icon="checkCircle">
        <EmptyState
          action={unbuilt.length ? <LinkButton onClick={() => onNavigate(unbuilt[0].tab)}>Build {unbuilt[0].label}</LinkButton> : null}
        >
          {unbuilt.length === 0
            ? "Nothing flagged. Fields, workflows, screens, automation and project shape all look clean."
            : `Nothing flagged in what has been measured. No ${unbuilt.map((u) => u.label).join(", no ")} has been built, so those are unchecked rather than clean.`}
        </EmptyState>
      </Panel>
    );
  }

  const bands = FINDING_BANDS
    .map((band) => ({ ...band, items: findings.filter((f) => f.tone === band.tone) }))
    .filter((band) => band.items.length > 0);

  return (
    <Panel
      title="What needs attention"
      icon="alertTriangle"
      description="Grouped by how soon it matters. Each opens the tab that resolves it."
    >
      <div className="ui-bands">
        {bands.map((band) => (
          <section key={band.tone} className="ui-band">
            <header className={`ui-band__head ui-band__head--${band.tone}`}>
              <h4 className="ui-band__title">{band.label}</h4>
              <span className="ui-band__count">{band.items.length}</span>
              <p className="ui-band__desc">{band.description}</p>
            </header>
            <div className="ui-finding-list">
              {band.items.map((finding) => (
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
          </section>
        ))}
      </div>

      {unbuilt.length > 0 && (
        <p className="ui-note">
          <Icon name="info" size={13} />
          <span>
            No {unbuilt.map((u) => u.label).join(", no ")} has been built, so nothing above
            reflects {unbuilt.length === 1 ? "it" : "them"}.
          </span>
        </p>
      )}
    </Panel>
  );
}


// ── Site health ─────────────────────────────────────────────────────────────
//
// The headline number is a way into the findings, not a finding. So it ships with the
// dimension that scored worst and what would move it, and it states how many dimensions
// it could actually score -- a 90 from two inputs is a weaker claim than a 72 from seven,
// and the reader has to be able to tell.

function HealthPanel({ health, onNavigate }) {
  if (!health || health.score === null) {
    return (
      <Panel title="Site health" icon="activity">
        <EmptyState>
          Nothing measured yet. Build a snapshot and the workflow inventory to score the site.
        </EmptyState>
      </Panel>
    );
  }

  // Both counts come from the dimensions array rather than one from the array and one
  // from separate metadata -- otherwise the heading and the note can disagree about how
  // much of the site was actually measured.
  const scored = health.dimensions.filter((d) => d.available);
  const missing = health.dimensions.filter((d) => !d.available);
  const partial = missing.length > 0;

  return (
    <Panel
      title="Site health"
      icon="activity"
      description={`Scored across ${scored.length} of ${health.dimensions.length} dimensions.`}
    >
      <div className="ui-health">
        <div className="ui-health__hero">
          <span className={`ui-health__score ui-health__score--${health.grade.toLowerCase()}`}>{health.score}</span>
          <span className="ui-health__of">/ 100</span>
          <span className={`ui-health__grade ui-health__grade--${health.grade.toLowerCase()}`}>{health.grade}</span>
        </div>
        {health.weakest && (
          <p className="ui-health__weakest">
            Weakest: <strong>{health.weakest.label}</strong> at {health.weakest.score}.
            {health.weakest.action ? ` ${health.weakest.action}` : ""}
          </p>
        )}
      </div>

      {/* Grouped by pillar rather than listed flat. Thirteen equal-weight bars in one column
          is a table of contents with no headings -- the reader cannot tell which area of the
          site a row belongs to without reading every label. Falls back to a single unnamed
          group if the score predates pillars, so an older cached payload still renders. */}
      <div className="ui-health__pillars">
        {(health.pillars?.length ? health.pillars : [{ key: "all", label: null, dimensions: scored, available: true, score: null }])
          .map((pillar) => (
            <section key={pillar.key} className="ui-health__pillar">
              {pillar.label && (
                <header className="ui-health__pillarhead">
                  <h4 className="ui-health__pillartitle">{pillar.label}</h4>
                  {pillar.available ? (
                    <span className={`ui-health__pillarscore ui-health__score--${(pillar.grade || "e").toLowerCase()}`}>
                      {pillar.score}
                    </span>
                  ) : (
                    <span className="ui-health__pillarscore ui-health__pillarscore--none">not measured</span>
                  )}
                </header>
              )}

              {pillar.available ? (
                <div className="ui-health__dims">
                  {pillar.dimensions.filter((d) => d.available).map((dim) => (
                    <div key={dim.key} className="ui-health__dim">
                      <span className="ui-health__dimlabel">{dim.label}</span>
                      <span className="ui-health__dimtrack">
                        <span className="ui-health__dimbar" style={{ width: `${dim.score}%` }} />
                      </span>
                      <span className="ui-health__dimval">{dim.score}</span>
                      <span className="ui-health__dimdetail">{dim.detail}</span>
                    </div>
                  ))}
                </div>
              ) : (
                // One line for the whole pillar instead of one dark bar per dimension. The
                // reason is identical across them, and repeating it three times reads as
                // three problems rather than one unbuilt snapshot.
                <p className="ui-health__pillarempty">{pillar.reason || "Not measured yet."}</p>
              )}
            </section>
          ))}
      </div>

      {partial && (
        <p className="ui-note">
          <Icon name="info" size={13} />
          <span>
            {missing.length} dimension{missing.length === 1 ? "" : "s"} could not be scored:{" "}
            {missing.map((d) => d.label).join(", ")}. The score reflects only what has been
            measured, so it will move as more data is collected.
          </span>
        </p>
      )}
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
          <Icon name="info" size={13} />
          <span>
            No scheme governs more than one project, so there is no shared process to compare
            field usage against.
          </span>
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
        {/*
          Two different measures, never one label. totalFieldFills counts field VALUES --
          an issue with 90 populated fields contributes 90 -- so presenting it as "issues"
          overstates by roughly the median field count. Only the Universal Scan measures
          distinct issues, so when it has not run the tile says what it is actually showing.
        */}
        {projects.hasUniqueCounts ? (
          <StatTile
            label="Issues covered"
            value={formatNumber(projects.totalUniqueIssues)}
            hint="distinct issues, from the universe scan"
            icon="barChart"
          />
        ) : (
          <StatTile
            label="Field fills"
            value={formatNumber(projects.totalFieldFills)}
            hint="field values, not issues — run a universe scan for issue counts"
            icon="barChart"
          />
        )}
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
          <h4 className="ui-subhead">
            {projects.hasUniqueCounts ? "Highest issue volume" : "Most field fills"}
          </h4>
          <BarList
            items={projects.topByIssueVolume}
            labelKey="projectKey"
            valueKey="volume"
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

export function OverviewDashboard({ dashboard, findingsSummary, workflow, screens, automation, health, onOpenRqtIndex, onNavigate }) {
  // onNavigate is optional so this stays renderable in isolation; without it the deep
  // links become inert rather than throwing.
  const navigate = onNavigate || (() => {});
  const findings = buildFindings({ findingsSummary, dashboard, workflow, screens, automation, onNavigate: navigate });

  return (
    <div className="ui-dashboard">
      <HealthPanel health={health} onNavigate={navigate} />
      <FindingsPanel findings={findings} workflow={workflow} screens={screens} automation={automation} onNavigate={navigate} />
      <WorkflowPanel workflow={workflow} onNavigate={navigate} />
      <ProjectsPanel projects={dashboard?.projects} onNavigate={navigate} />
      <FieldsPanel fieldUsage={dashboard?.fieldUsage} onNavigate={navigate} />
      <RqtPanel onOpenRqtIndex={onOpenRqtIndex} />
    </div>
  );
}
