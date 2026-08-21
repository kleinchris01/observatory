import React from "react";
import { invoke } from "@forge/bridge";
import { Icon } from "./Icons";
import { formatNumber, formatRelativeTime } from "../utils";
import { StatTile, StatRow, Panel, EmptyState, BarList, LinkButton, GovernanceRow, TrendDelta, bandFromScore } from "./ui";
import { HEALTH_PILLARS } from "../../../src/lib/health-score";

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

function buildFindings({ findingsSummary, dashboard, workflow, screens, automation, filters, onNavigate }) {
  const findings = [];

  if (findingsSummary?.adminAttention > 0) {
    findings.push({
      key: "admin-attention",
      dimension: "field-governance",
      pillar: "fields",
      tone: "critical",
      count: findingsSummary.adminAttention,
      title: "Fields need admin attention",
      detail: "Configuration problems that affect how these fields behave in Jira.",
      onOpen: () => onNavigate("fields", { findings: "admin-attention" }),
      openLabel: "Field Browser",
    });
  }

  if (findingsSummary?.risky > 0) {
    findings.push({
      key: "risky",
      dimension: "field-governance",
      pillar: "fields",
      tone: "warning",
      count: findingsSummary.risky,
      title: "Fields flagged as risky",
      detail: "Global contexts or broad scope that make changes hard to reason about.",
      onOpen: () => onNavigate("fields", { findings: "risky" }),
      openLabel: "Field Browser",
    });
  }

  if (workflow?.available && workflow.duplicateGroupCount > 0) {
    findings.push({
      key: "duplicate-statuses",
      dimension: "status-naming",
      pillar: "workflows",
      tone: "warning",
      count: workflow.duplicateGroupCount,
      title: "Groups of duplicate statuses",
      detail: workflow.reducibleStatusCount > 0
        ? `Consolidating them removes ${formatNumber(workflow.reducibleStatusCount)} statuses from the site.`
        : "Statuses that almost certainly mean the same thing.",
      onOpen: () => onNavigate("workflows", { view: "insights", panel: "duplicates" }),
      openLabel: "Workflows",
    });
  }

  // Only offered as a cleanup when the scan has confirmed the statuses are unused.
  // Without counts this is a list to review, not an action, so it is not a finding.
  if (workflow?.available && workflow.safeToRemoveCount > 0) {
    findings.push({
      key: "unused-statuses",
      dimension: "status-reachability",
      pillar: "workflows",
      tone: "info",
      count: workflow.safeToRemoveCount,
      title: "Statuses with no evidence of use",
      // The old wording -- "automation rules are not visible to this app" -- has been false
      // since rule imports started populating automation_references, and safeToRemoveCount
      // now excludes any status a rule references.
      detail: workflow.automationChecked
        ? "No workflow reaches them, no automation rule references them, and no issue has ever been in one."
        : "No workflow reaches them and no issue has ever been in one. No rule export has been imported, so check the Automation tab before deleting.",
      onOpen: () => onNavigate("workflows", { view: "insights", panel: "orphans", statuses: "safe-to-remove" }),
      openLabel: "Workflows",
    });
  }

  // Statuses reachable only through an automation rule. The opposite finding to the one
  // above and it used to hide inside it: an issue reaches these states, users see them, and
  // no workflow scheme says they exist.
  if (workflow?.available && workflow.automationChecked && workflow.ruleOnlyStatusCount > 0) {
    findings.push({
      key: "rule-only-statuses",
      dimension: "status-coverage",
      pillar: "workflows",
      tone: "warning",
      count: workflow.ruleOnlyStatusCount,
      title: "Statuses only an automation rule can reach",
      detail: "No scheme contains them, so they are invisible in Jira's workflow admin — but a rule transitions issues into them.",
      onOpen: () => onNavigate("workflows", { view: "insights", panel: "orphans", statuses: "rule-only" }),
      openLabel: "Workflows",
    });
  }

  if (workflow?.available && workflow.flaggedSchemeCount > 0) {
    findings.push({
      key: "scheme-balance",
      dimension: "workflow-structure",
      pillar: "workflows",
      tone: "warning",
      count: workflow.flaggedSchemeCount,
      title: "Workflow schemes with a structural flag",
      detail: "Missing a Done status, heavily weighted to In Progress, or oversized.",
      onOpen: () => onNavigate("workflows", { view: "insights", panel: "balance" }),
      openLabel: "Workflows",
    });
  }

  if (dashboard?.projects?.overConfigured?.length > 0) {
    findings.push({
      key: "over-configured",
      dimension: "project-consistency",
      pillar: "projects",
      tone: "info",
      count: dashboard.projects.overConfiguredCount ?? dashboard.projects.overConfigured.length,
      title: "Projects configured well past the site norm",
      // No longer claims light issue volume: that is the idle SUBSET, and asserting it of
      // the whole list is what made this finding impossible to trip on an active site.
      detail: dashboard.projects.idleOverConfiguredCount > 0
        ? `Median project carries ${formatNumber(dashboard.projects.medianFieldCount)} fields. ${formatNumber(dashboard.projects.idleOverConfiguredCount)} of these carry little issue volume too.`
        : `Median project carries ${formatNumber(dashboard.projects.medianFieldCount)} fields; these carry far more.`,
      onOpen: () => onNavigate("projects", { filter: "over-configured" }),
      openLabel: "Project Usage",
    });
  }

  if (findingsSummary?.cleanup > 0) {
    findings.push({
      key: "cleanup",
      dimension: null,
      pillar: "fields",
      tone: "info",
      count: findingsSummary.cleanup,
      title: "Fields suggested for cleanup",
      detail: "Unused, unpopulated, or superseded by another field.",
      onOpen: () => onNavigate("fields", { findings: "cleanup" }),
      openLabel: "Field Browser",
    });
  }

  // Was computed by summarizeFindings and then dropped on the floor here, so the one
  // category that describes site-wide inconsistency never appeared on the site-wide page.
  if (findingsSummary?.standardize > 0) {
    findings.push({
      key: "standardize",
      dimension: "field-naming",
      pillar: "fields",
      tone: "info",
      count: findingsSummary.standardize,
      title: "Fields that could be standardised",
      detail: "Close enough to another field that one definition would serve both.",
      onOpen: () => onNavigate("fields", { findings: "standardize" }),
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
      dimension: "automation-security",
      pillar: "automation",
      tone: "critical",
      count: automation.credentialRuleCount,
      title: "Automation rules storing a credential in plaintext",
      detail: "Anyone who can view the rule can read the secret. Rotate them, then move to a smart-value reference or an Automation connection.",
      onOpen: () => onNavigate("automation", { section: "findings", risk: "embedded-credential" }),
      openLabel: "Automation",
    });
  }

  if (automation?.available && automation.selfTriggeringCount > 0) {
    findings.push({
      key: "automation-self-triggering",
      dimension: "automation-stability",
      pillar: "automation",
      tone: "warning",
      count: automation.selfTriggeringCount,
      title: "Rules that write a field they trigger on",
      detail: "These loop without a second rule involved. Check the conditions guarding them before the next execution-limit surprise.",
      onOpen: () => onNavigate("automation", { section: "cascades", cascadeKind: "self" }),
      openLabel: "Automation",
    });
  }

  if (automation?.available && automation.externalHttpCount > 0) {
    findings.push({
      key: "automation-external",
      dimension: "automation-exposure",
      pillar: "automation",
      tone: "warning",
      count: automation.externalHttpCount,
      title: "Rules sending data outside Atlassian",
      detail: "Each moves Jira data out of the tenancy. Confirm every destination is still one you own.",
      onOpen: () => onNavigate("automation", { section: "findings", risk: "external-http" }),
      openLabel: "Automation",
    });
  }

  if (automation?.available && automation.noActionCount > 0) {
    findings.push({
      key: "automation-inert",
      dimension: "automation-hygiene",
      pillar: "automation",
      tone: "info",
      count: automation.noActionCount,
      title: "Rules with a trigger but no actions",
      detail: "They consume execution budget on every trigger and do nothing with it.",
      onOpen: () => onNavigate("automation", { section: "findings", risk: "no-actions" }),
      openLabel: "Automation",
    });
  }

  if (automation?.available && automation.disabledCount > 0) {
    findings.push({
      key: "automation-disabled",
      dimension: "automation-hygiene",
      pillar: "automation",
      tone: "info",
      count: automation.disabledCount,
      title: "Disabled automation rules",
      detail: "A large disabled estate hides which rules were retired on purpose and which were forgotten. Decide per rule: revive or delete.",
      onOpen: () => onNavigate("automation", { section: "findings", risk: "disabled" }),
      openLabel: "Automation",
    });
  }

  // ── Filters ─────────────────────────────────────────────────────────────
  //
  // A filter owned by a deleted account is the highest-consequence finding in this pillar and
  // the one nobody discovers until it breaks: Jira deletes the filter with the account, and
  // every board and dashboard built on it breaks at the same moment.
  if (filters?.available && filters.orphanedCount > 0) {
    findings.push({
      key: "filters-orphaned",
      dimension: "filter-hygiene",
      pillar: "filters",
      tone: "critical",
      count: filters.orphanedCount,
      title: "Saved filters with no live owner",
      detail: "Jira deletes a filter with its owner. Reassign these before the accounts are removed, not after.",
      onOpen: () => onNavigate("filters", { view: "filters", finding: "orphaned-owner" }),
      openLabel: "Filters",
    });
  }

  if (filters?.available && filters.brokenProjectCount > 0) {
    findings.push({
      key: "filters-broken-scope",
      dimension: "filter-hygiene",
      pillar: "filters",
      tone: "warning",
      count: filters.brokenProjectCount,
      title: "Filters naming a project that does not exist",
      detail: "These error rather than returning the wrong answer quietly, which makes them the cheapest of the filter findings to justify fixing.",
      onOpen: () => onNavigate("filters", { view: "broken" }),
      openLabel: "Filters",
    });
  }

  if (filters?.available && filters.subscribedButUnusedCount > 0) {
    findings.push({
      key: "filters-zombie-subscriptions",
      dimension: "filter-hygiene",
      pillar: "filters",
      tone: "warning",
      count: filters.subscribedButUnusedCount,
      title: "Email subscriptions on filters nobody opens",
      detail: "Recurring email from a search no one reads is what teaches people to filter Jira to trash, taking the useful mail with it.",
      onOpen: () => onNavigate("filters", { view: "filters", finding: "subscribed-but-unused" }),
      openLabel: "Filters",
    });
  }

  if (filters?.available && filters.sharedWithEveryoneCount > 0) {
    findings.push({
      key: "filters-shared-everyone",
      dimension: "filter-hygiene",
      pillar: "filters",
      tone: "info",
      count: filters.sharedWithEveryoneCount,
      title: "Filters shared with every logged-in user",
      detail: "Anyone on the site can run these, against every project they can browse. Usually deliberate — worth confirming it still is.",
      onOpen: () => onNavigate("filters", { view: "filters", finding: "shared-with-everyone" }),
      openLabel: "Filters",
    });
  }

  if (filters?.available && filters.reducibleCount > 0) {
    findings.push({
      key: "filters-duplicates",
      dimension: "filter-hygiene",
      pillar: "filters",
      tone: "info",
      count: filters.reducibleCount,
      title: "Duplicate saved filters",
      detail: `${filters.duplicateGroupCount} groups of filters run the same query. Consolidating each to one removes ${filters.reducibleCount}.`,
      onOpen: () => onNavigate("filters", { view: "duplicates" }),
      openLabel: "Filters",
    });
  }

  // ── Screens ─────────────────────────────────────────────────────────────

  if (screens?.available && screens.danglingOperations > 0) {
    findings.push({
      key: "screen-dangling",
      dimension: "screen-integrity",
      pillar: "screens",
      tone: "critical",
      count: screens.danglingOperations,
      title: "Scheme operations pointing at a missing screen",
      detail: "Jira falls back silently when one of these resolves, so the form a user sees is not the one the scheme names.",
      onOpen: () => onNavigate("screens", { view: "schemes", schemes: "dangling" }),
      openLabel: "Screens",
    });
  }

  // A measurement gap, not a site defect -- and it caps every screen finding below it, so
  // it is stated before them rather than after.
  if (screens?.available && screens.unresolvedScreens > 0) {
    findings.push({
      key: "screen-unresolved",
      dimension: "screen-hygiene",
      pillar: "screens",
      tone: "warning",
      count: screens.unresolvedScreens,
      title: "Screens whose contents could not be read",
      detail: "Not counted as empty — the build could not see them at all, so the screen findings below exclude these.",
      onOpen: () => onNavigate("screens", { view: "screens", filter: "unresolved" }),
      openLabel: "Screens",
    });
  }

  // Only offered once transitions are known. A screen attached to a workflow transition is
  // opened every time someone moves an issue, while belonging to no screen scheme -- so
  // without the workflow inventory this finding would invite deleting screens in daily use.
  if (screens?.available && screens.unreachedScreens > 0) {
    findings.push({
      key: "screen-unreached",
      dimension: "screen-hygiene",
      pillar: "screens",
      tone: "info",
      count: screens.unreachedScreens,
      title: "Screens nothing reaches",
      detail: "No scheme maps to them and no workflow transition opens them, so no user encounters them.",
      onOpen: () => onNavigate("screens", { view: "screens", filter: "unreached" }),
      openLabel: "Screens",
    });
  }

  // The correction, stated as its own row. These are screens the scheme chain alone calls
  // unreachable and a transition is actually using.
  if (screens?.available && screens.transitionOnlyScreens > 0) {
    findings.push({
      key: "screen-transition-only",
      dimension: "screen-hygiene",
      pillar: "screens",
      tone: "info",
      count: screens.transitionOnlyScreens,
      title: "Screens used only by a workflow transition",
      detail: "No screen scheme references them, so they look orphaned in the scheme view — but a transition opens them. Do not delete these.",
      onOpen: () => onNavigate("screens", { view: "screens", filter: "transition-only" }),
      openLabel: "Screens",
    });
  }

  if (screens?.available && screens.emptyScreens > 0) {
    findings.push({
      key: "screen-empty",
      dimension: "screen-hygiene",
      pillar: "screens",
      tone: "info",
      count: screens.emptyScreens,
      title: "Screens carrying no fields",
      detail: "Read successfully and found to have nothing on them.",
      onOpen: () => onNavigate("screens", { view: "screens", filter: "empty" }),
      openLabel: "Screens",
    });
  }

  if (screens?.available && screens.unusedSchemes > 0) {
    findings.push({
      key: "screen-unused-schemes",
      dimension: "screen-integrity",
      pillar: "screens",
      tone: "info",
      count: screens.unusedSchemes,
      title: "Screen schemes no issue type maps to",
      detail: "They cannot route anything to a project until an issue type screen scheme references them.",
      onOpen: () => onNavigate("screens", { view: "schemes", schemes: "unused" }),
      openLabel: "Screens",
    });
  }

  // ── Projects ────────────────────────────────────────────────────────────

  // A project people LEFT, which no lifetime total can show: it looks busy right up until
  // you divide by time. Ordered most-recent-decline-first by the resolver, because those are
  // the ones somebody might still remember the reason for.
  if (dashboard?.adoption?.available && dashboard.adoption.fellOffCount > 0) {
    const worst = dashboard.adoption.fellOff?.[0];
    findings.push({
      key: "projects-fell-off",
      dimension: "project-adoption",
      pillar: "projects",
      tone: "warning",
      count: dashboard.adoption.fellOffCount,
      title: "Projects people have stopped using",
      detail: worst?.declineFrom
        ? `Running far below their own historical rate. The most recent, ${worst.projectKey}, dropped off around ${worst.declineFrom}.`
        : "Running far below their own historical rate — they had a real life and lost it.",
      onOpen: () => onNavigate("projects", { filter: "fell-off" }),
      openLabel: "Project Usage",
    });
  }

  if (dashboard?.adoption?.available && dashboard.adoption.neverAdoptedCount > 0) {
    findings.push({
      key: "projects-never-adopted",
      dimension: "project-adoption",
      pillar: "projects",
      tone: "info",
      count: dashboard.adoption.neverAdoptedCount,
      title: "Projects that never took off",
      detail: "Old enough to judge and carrying under an issue a month across their whole life. Worth asking what people used instead.",
      onOpen: () => onNavigate("projects", { filter: "no-work" }),
      openLabel: "Project Usage",
    });
  }

  if (dashboard?.projects?.unusedProjectCount > 0) {
    findings.push({
      key: "unused-projects",
      dimension: "project-activity",
      pillar: "projects",
      tone: "info",
      count: dashboard.projects.unusedProjectCount,
      title: "Projects carrying fields but no work",
      detail: "Configured and then either abandoned or never started. Retiring fields here costs nothing.",
      onOpen: () => onNavigate("projects", { filter: "no-work" }),
      openLabel: "Project Usage",
    });
  }

  if (dashboard?.projects?.staleProjects?.length > 0) {
    findings.push({
      key: "stale-projects",
      dimension: "project-activity",
      pillar: "projects",
      tone: "info",
      count: dashboard.projects.staleProjectCount ?? dashboard.projects.staleProjects.length,
      title: "Projects with no activity in over six months",
      detail: "Still carrying field configuration. The cheapest place to retire fields, if the project is genuinely done.",
      onOpen: () => onNavigate("projects", { filter: "stale" }),
      openLabel: "Project Usage",
    });
  }

  return findings;
}

// -- The governance ledger ---------------------------------------------------
//
// One table over what were two panels saying the same things in two vocabularies.
//
// "Site health" scored thirteen dimensions with a bar each. "What needs attention" counted
// and deep-linked the findings derived from those same dimensions. So "Automation security
// 0" and "86 automation rules storing a credential in plaintext" appeared in different
// panels, in different orders, with nothing connecting them -- and a reader had to work out
// that they were one fact stated twice. Worse, the two could disagree: a dimension could
// score badly with no finding beneath it, and a finding could fire for something no
// dimension measured, and neither panel could say so.
//
// The ledger is the join. Every row is a governance metric; the score says how bad, the
// finding says what to do, and the trend says which way it is going.

// Bands ordered by urgency, so the worst of a row's findings decides its band.
const BAND_RANK = { critical: 0, warning: 1, info: 2, clear: 3 };

// Labels and order come from the score's own pillar definition rather than a second copy
// here. HEALTH_PILLARS is a pure constant in a module that imports nothing, which is what
// makes it usable from the browser bundle -- the same reason the automation analysis is.
const PILLAR_LABELS = Object.fromEntries(HEALTH_PILLARS.map((p) => [p.key, p.label]));

function worstBand(bands) {
  return bands.reduce((worst, band) => (BAND_RANK[band] < BAND_RANK[worst] ? band : worst), "clear");
}

// Assemble the rows, grouped by pillar and ordered by urgency within each.
//
// `history` is optional and comes from getHealthHistory. Without it the rows render without
// a trend column rather than with an empty one -- a site with one measurement has no trend,
// and drawing a flat line would assert a stability nobody observed.
export function buildGovernanceLedger({ health, findings = [], history = null }) {
  const trendByKey = new Map(
    (history?.available && history.hasTrend ? history.dimensions ?? [] : [])
      .map((entry) => [entry.key, { delta: entry.delta, points: entry.points, title: `${entry.key} over ${history.days} days` }])
  );

  // A cached measurement from before pillars existed carries only a flat dimensions array.
  // Synthesised into groups rather than dropped, so an older payload renders its rows
  // instead of an empty state claiming nothing has been measured.
  const scoredPillars = health?.pillars?.length
    ? health.pillars
    : health?.dimensions?.length
      ? [{ key: "all", label: null, available: true, score: null, grade: null, total: health.dimensions.length, dimensions: health.dimensions }]
      : [];

  // Findings grouped by the dimension they are evidence for. A dimension can have several:
  // automation hygiene covers both disabled rules and inert ones.
  const findingsByDimension = new Map();
  const unmeasured = [];
  for (const finding of findings) {
    if (!finding.dimension) { unmeasured.push(finding); continue; }
    if (!findingsByDimension.has(finding.dimension)) findingsByDimension.set(finding.dimension, []);
    findingsByDimension.get(finding.dimension).push(finding);
  }

  const claimed = new Set();
  const byKey = new Map();
  for (const pillar of scoredPillars) {
    const rows = (pillar.dimensions ?? []).map((dim) => {
      const own = findingsByDimension.get(dim.key) ?? [];
      own.forEach((f) => claimed.add(f.key));

      // The more urgent of what the finding says and what the score implies.
      //
      // A finding's tone is written by hand with a consequence attached, so it can escalate
      // past anything a score justifies -- only a finding can claim "act now". But it must
      // not SOFTEN the score: "Project consistency 0" sitting under "cleanup when
      // convenient" is incoherent, and it happened because the over-configured finding is
      // authored as low urgency while the dimension it belongs to had bottomed out.
      //
      // bandFromScore caps itself at "warning", so the score alone can never turn the page
      // red; it can only stop a bad number being described as optional.
      const band = own.length
        ? worstBand([...own.map((f) => f.tone), bandFromScore(dim.score)])
        : bandFromScore(dim.score);

      return {
        key: dim.key,
        label: dim.label,
        // An unscored dimension with a finding beneath it still has something to say. Only
        // a dimension with neither a score nor a finding is nothing to show, and those
        // collapse into the pillar's one-line reason.
        available: dim.available || own.length > 0,
        score: dim.available ? dim.score : null,
        band: dim.available ? band : (own.length ? worstBand(own.map((f) => f.tone)) : "clear"),
        // The dimension's evidence sentence, which already names the rate it was derived
        // from. The findings beneath it carry the counts and the links.
        detail: dim.available ? dim.detail : null,
        reason: dim.available ? null : dim.reason,
        action: dim.available ? dim.action : null,
        findings: own,
        trend: trendByKey.get(dim.key) ?? null,
      };
    });
    byKey.set(pillar.key, { ...pillar, rows, fromScore: true });
  }

  // Findings no dimension covers, in two kinds and both kept.
  //
  // Some are genuinely unmeasured -- "1,204 fields suggested for cleanup" is a real finding
  // that nothing in the score scores. Others are findings whose dimension exists in
  // principle but not in this payload, which is the normal state before the site has ever
  // been scored: the Overview must still route attention on a site with no health score at
  // all, because that is exactly the site with the most to fix.
  const orphans = [
    ...unmeasured,
    ...findings.filter((f) => f.dimension && !claimed.has(f.key)),
  ];
  for (const finding of orphans) {
    const row = {
      key: finding.key,
      // The row IS the finding, so its count and its way in sit on the row itself rather
      // than in a chip beneath. A chip here would render the same sentence twice: once as
      // the row's label and once as the chip's.
      label: finding.title,
      available: true,
      // Rendered without a score rather than with a zero. Nothing measured this as a rate.
      score: null,
      band: finding.tone,
      detail: finding.detail,
      reason: null,
      action: null,
      findings: [],
      count: finding.count,
      openLabel: finding.openLabel,
      onOpen: finding.onOpen,
      trend: null,
      unscored: true,
    };
    const pillarKey = finding.pillar || "fields";
    if (!byKey.has(pillarKey)) {
      byKey.set(pillarKey, {
        key: pillarKey,
        label: PILLAR_LABELS[pillarKey] ?? pillarKey,
        // fromScore false: this pillar exists because findings landed in it, not because
        // the score measured it. The difference matters at render time -- "not measured"
        // is a statement about scoring, and printing it beside three findings would say
        // the opposite of what the rows show.
        fromScore: false,
        available: false, score: null, grade: null, total: 0, rows: [],
      });
    }
    byKey.get(pillarKey).rows.push(row);
  }

  // Ordered by the score's own pillar order, so the page does not reshuffle when a pillar
  // gains its first dimension. Anything unrecognised sorts to the end rather than vanishing.
  const order = new Map(HEALTH_PILLARS.map((p, i) => [p.key, i]));
  const pillars = [...byKey.values()]
    .filter((pillar) => pillar.rows.length > 0)
    .sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));

  if (!pillars.length) return null;

  // Urgency first inside each pillar, then worst score. A pillar's rows are a worklist.
  for (const pillar of pillars) {
    pillar.rows.sort((a, b) =>
      BAND_RANK[a.band] - BAND_RANK[b.band] || (a.score ?? 101) - (b.score ?? 101) || a.label.localeCompare(b.label));
  }

  const allRows = pillars.flatMap((p) => p.rows);
  return {
    pillars,
    counts: {
      critical: allRows.filter((r) => r.band === "critical").length,
      warning: allRows.filter((r) => r.band === "warning").length,
      info: allRows.filter((r) => r.band === "info").length,
    },
    // Whether any row can show movement. Drives whether the trend column is offered at all.
    hasTrends: trendByKey.size > 0,
  };
}

// The history series, fetched separately from the overview payload.
//
// Deliberately not folded into getAdminOverview. The ledger renders completely without it
// -- the trend column simply is not offered -- so making the landing page's first paint
// wait on a second query would trade something a reader needs immediately for something
// that is only interesting once they have read the rows.
//
// A failure is silence, not an error. "We could not draw the sparklines" is not worth
// interrupting the page that tells you a rule is leaking a credential.
export function useHealthHistory({ days = 90, load = invoke } = {}) {
  const [history, setHistory] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    load("getHealthHistory", { days })
      .then((result) => { if (!cancelled) setHistory(result); })
      .catch(() => { if (!cancelled) setHistory(null); });
    return () => { cancelled = true; };
  }, [days, load]);

  return history;
}

function GovernanceLedgerPanel({ health, findings, history, workflow, screens, automation, filters, onNavigate }) {
  const ledger = React.useMemo(() => buildGovernanceLedger({ health, findings, history }), [health, findings, history]);

  // Which pillars have never been built. Named individually, because "nothing flagged" while
  // three of five pillars have never been looked at is not a clean bill of health -- it is a
  // clean bill of the two things we checked.
  const unbuilt = [
    !workflow?.available && { label: "workflow inventory", tab: "workflows" },
    !screens?.available && { label: "screen inventory", tab: "screens" },
    !automation?.available && { label: "automation analysis", tab: "automation" },
    !filters?.available && { label: "saved filter inventory", tab: "filters" },
  ].filter(Boolean);

  // No rows at all. Two different reasons, and they must not be worded the same: a site
  // where everything came back clean and a site where nothing has been looked at produce
  // the same empty table, and only one of them is good news.
  if (!ledger) {
    return (
      <Panel title="Governance" icon="activity">
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

  const dimensions = health?.dimensions ?? [];
  const scored = dimensions.filter((d) => d.available);
  const missing = dimensions.filter((d) => !d.available);
  const { critical, warning, info } = ledger.counts;
  // A site can have findings and no score -- nothing has been scored yet, but plenty has
  // been found. The hero is what is conditional; the table is not.
  const scoreKnown = typeof health?.score === "number";
  const grade = (health?.grade || "e").toLowerCase();

  return (
    <Panel
      title="Governance"
      icon="activity"
      description={dimensions.length
        ? `Every measure of the site, worst first. Scored across ${scored.length} of ${dimensions.length} dimensions.`
        : "Every finding on the site, worst first. Nothing has been scored yet."}
      action={<LinkButton onClick={() => onNavigate("reports")}>Trends</LinkButton>}
    >
      <div className="ui-health">
        <div className="ui-health__hero">
          {scoreKnown && (
            <>
              <span className={`ui-health__score ui-health__score--${grade}`}>{health.score}</span>
              <span className="ui-health__of">/ 100</span>
              <span className={`ui-health__grade ui-health__grade--${grade}`}>{health.grade}</span>
              {history?.hasTrend && <TrendDelta delta={history.delta} />}
            </>
          )}
          {/* The counts the old findings panel led with, kept as the one-line summary of
              what the table below holds. */}
          <span className="ui-health__tally">
            {critical > 0 && <span className="ui-health__tallyitem ui-health__tallyitem--critical">{critical} to act on</span>}
            {warning > 0 && <span className="ui-health__tallyitem ui-health__tallyitem--warning">{warning} to review</span>}
            {info > 0 && <span className="ui-health__tallyitem ui-health__tallyitem--info">{info} to clean up</span>}
            {critical + warning + info === 0 && <span className="ui-health__tallyitem">nothing flagged</span>}
          </span>
        </div>
        {scoreKnown && health.weakest && (
          <p className="ui-health__weakest">
            Weakest: <strong>{health.weakest.label}</strong> at {health.weakest.score}.
            {health.weakest.action ? ` ${health.weakest.action}` : ""}
          </p>
        )}
      </div>

      <div className="ui-gov-pillars">
        {ledger.pillars.map((pillar) => (
          <section key={pillar.key} className="ui-gov-pillar">
            <header className="ui-health__pillarhead">
              <h4 className="ui-health__pillartitle">{pillar.label}</h4>
              {pillar.available ? (
                <span className={`ui-health__pillarscore ui-health__score--${(pillar.grade || "e").toLowerCase()}`}>
                  {pillar.score}
                </span>
              ) : pillar.fromScore ? (
                <span className="ui-health__pillarscore ui-health__pillarscore--none">not measured</span>
              ) : null}
            </header>

            {pillar.rows.every((row) => !row.available) ? (
              // One line for the whole pillar instead of one dark row per dimension. The
              // reason is identical across them, and repeating it reads as three problems
              // rather than one unbuilt snapshot.
              <p className="ui-health__pillarempty">{pillar.reason || "Not measured yet."}</p>
            ) : (
              <div className="ui-gov-list">
                {pillar.rows.filter((row) => row.available).map((row) => (
                  <GovernanceRow
                    key={row.key}
                    label={row.label}
                    score={row.score}
                    band={row.band}
                    detail={row.detail}
                    trend={ledger.hasTrends ? row.trend : null}
                    count={row.count === undefined ? undefined : formatNumber(row.count)}
                    action={row.onOpen ? <LinkButton onClick={row.onOpen}>{row.openLabel}</LinkButton> : null}
                  >
                    {/* The findings beneath the metric: what to do, how many, and the way
                        in. A dimension with no finding shows its own advice instead. */}
                    {row.findings.length > 0 ? (
                      <div className="ui-gov__findings">
                        {row.findings.map((finding) => (
                          <button
                            type="button"
                            key={finding.key}
                            className={`ui-gov__finding ui-gov__finding--${finding.tone}`}
                            onClick={finding.onOpen}
                            title={finding.detail}
                          >
                            <span className="ui-gov__findingcount">{formatNumber(finding.count)}</span>
                            <span className="ui-gov__findingtitle">{finding.title}</span>
                            {/* The destination, not a bare arrow. A reader has to be able to
                                tell where a chip goes before clicking it, and the old
                                findings list said so explicitly. */}
                            <span className="ui-gov__findingarrow">&#8594; {finding.openLabel}</span>
                          </button>
                        ))}
                      </div>
                    ) : row.action ? (
                      <span className="ui-gov__advice">{row.action}</span>
                    ) : null}
                  </GovernanceRow>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>

      {missing.length > 0 && (
        <p className="ui-note">
          <Icon name="info" size={13} />
          <span>
            {missing.length} dimension{missing.length === 1 ? "" : "s"} could not be scored:{" "}
            {missing.map((d) => d.label).join(", ")}. The score reflects only what has been
            measured, so it will move as more data is collected.
          </span>
        </p>
      )}

      {unbuilt.length > 0 && (
        <p className="ui-note">
          <Icon name="info" size={13} />
          <span>
            No {unbuilt.map((u) => u.label).join(", no ")} has been built, so those are
            unchecked rather than clean and nothing above reflects{" "}
            {unbuilt.length === 1 ? "it" : "them"}.
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

export function OverviewDashboard({ dashboard, findingsSummary, workflow, screens, automation, filters, health, history, onOpenRqtIndex, onNavigate }) {
  // onNavigate is optional so this stays renderable in isolation; without it the deep
  // links become inert rather than throwing.
  const navigate = onNavigate || (() => {});
  const findings = buildFindings({ findingsSummary, dashboard, workflow, screens, automation, filters, onNavigate: navigate });
  // A caller may pass history in -- tests do -- but nobody has to.
  const fetched = useHealthHistory();
  const series = history ?? fetched;

  return (
    <div className="ui-dashboard">
      <GovernanceLedgerPanel
        health={health}
        findings={findings}
        history={series}
        workflow={workflow}
        screens={screens}
        automation={automation}
        filters={filters}
        onNavigate={navigate}
      />
      <WorkflowPanel workflow={workflow} onNavigate={navigate} />
      <ProjectsPanel projects={dashboard?.projects} onNavigate={navigate} />
      <FieldsPanel fieldUsage={dashboard?.fieldUsage} onNavigate={navigate} />
      <RqtPanel onOpenRqtIndex={onOpenRqtIndex} />
    </div>
  );
}
