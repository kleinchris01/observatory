import React from "react";
import { invoke } from "@forge/bridge";
import { Icon } from "./Icons";
import { formatNumber } from "../utils";
import { StatTile, StatRow, Panel, EmptyState, LinkButton, GovernanceRow, TrendDelta, bandFromScore, RemediationStatus } from "./ui";
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

function buildFindings({ findingsSummary, findingsByCode, dashboard, workflow, screens, issueTypes, users, assets, access, estate, automation, filters, dashboards, onNavigate }) {
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

  const ruleIntegrity = workflow?.ruleIntegrity;
  const brokenWorkflowRefs = (ruleIntegrity?.brokenRules || 0) + (ruleIntegrity?.brokenProperties || 0);
  if (workflow?.available && ruleIntegrity?.available && brokenWorkflowRefs > 0) {
    findings.push({
      key: "workflow-broken-references",
      dimension: "workflow-rule-references",
      pillar: "workflows",
      tone: "warning",
      count: brokenWorkflowRefs,
      title: "Workflow rules naming a deleted field, group or role",
      detail: "A validator requiring a field that is gone blocks the transition or stops checking.",
      onOpen: () => onNavigate("workflows", { view: "rules", filter: "broken" }),
      openLabel: "Workflows",
    });
  }

  if (workflow?.available && ruleIntegrity?.available && ruleIntegrity.inactive > 0) {
    findings.push({
      key: "workflows-inactive",
      dimension: "inactive-workflows",
      pillar: "workflows",
      tone: "info",
      count: ruleIntegrity.inactive,
      title: "Inactive workflows",
      detail: "Company-managed workflows that no project's scheme uses.",
      onOpen: () => onNavigate("workflows", { view: "workflow-list", filter: "inactive" }),
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

  // Three more, computed alongside the four above and never promoted to their own card --
  // same shape as the field and screen pillars: a lump ("duplicate groups", "a structural
  // flag") sitting next to the specific number it was hiding.
  if (workflow?.available && workflow.reducibleStatusCount > 0) {
    findings.push({
      key: "reducible-statuses",
      dimension: null,
      pillar: "workflows",
      tone: "info",
      count: workflow.reducibleStatusCount,
      title: "Statuses that would disappear if duplicates were merged",
      detail: `Collapsing each of the ${formatNumber(workflow.duplicateGroupCount)} duplicate groups to one status removes this many from the site.`,
      onOpen: () => onNavigate("workflows", { view: "insights", panel: "duplicates" }),
      openLabel: "Workflows",
    });
  }

  // The subset of "unreachable" that is not simply cleanup: still holding live issues, with
  // no scheme and no rule able to move them anywhere. Distinct from "no evidence of use"
  // above, which is specifically the statuses where that is NOT true.
  if (workflow?.available && workflow.automationChecked && workflow.unreachableWithIssuesCount > 0) {
    findings.push({
      key: "unreachable-with-issues",
      dimension: null,
      pillar: "workflows",
      tone: "critical",
      count: workflow.unreachableWithIssuesCount,
      title: "Unreachable statuses still holding live issues",
      detail: "No scheme maps to them and no automation rule targets them, so nothing in Jira can move these issues out of this status.",
      onOpen: () => onNavigate("workflows", { view: "insights", panel: "orphans" }),
      openLabel: "Workflows",
    });
  }

  if (workflow?.available && workflow.noDoneSchemeCount > 0) {
    findings.push({
      key: "scheme-no-done",
      dimension: null,
      pillar: "workflows",
      tone: "critical",
      count: workflow.noDoneSchemeCount,
      title: "Workflow schemes with no Done status",
      detail: "A scheme with nothing in the Done category cannot represent completion — a correctness problem, not a tidiness one.",
      onOpen: () => onNavigate("workflows", { view: "insights", panel: "balance" }),
      openLabel: "Workflows",
    });
  }

  // dimension: "project-findings" on every one of these, deliberately not the three real
  // scored keys they used to nest under as chips -- same promotion the field, screen and
  // automation pillars already got. "Project consistency" states the rate; these are the
  // lists behind it.
  if (dashboard?.projects?.overConfigured?.length > 0) {
    findings.push({
      key: "over-configured",
      dimension: "project-findings",
      pillar: "projects",
      tone: "info",
      count: dashboard.projects.overConfiguredCount ?? dashboard.projects.overConfigured.length,
      title: "Projects configured well past the site norm",
      detail: `Median project carries ${formatNumber(dashboard.projects.medianFieldCount)} fields; these carry far more.`,
      onOpen: () => onNavigate("projects", { filter: "over-configured" }),
      openLabel: "Project Usage",
    });
  }

  // The subset of the line above that used to be folded into its detail sentence rather
  // than counted on its own: over-configured AND carrying little work, which is where a
  // field-governance conversation actually starts.
  if (dashboard?.projects?.idleOverConfiguredCount > 0) {
    findings.push({
      key: "idle-over-configured",
      dimension: "project-findings",
      pillar: "projects",
      tone: "warning",
      count: dashboard.projects.idleOverConfiguredCount,
      title: "Over-configured projects with little work to show for it",
      detail: `Median project carries ${formatNumber(dashboard.projects.medianFieldCount)} fields. These carry far more and have little issue volume to justify it.`,
      onOpen: () => onNavigate("projects", { filter: "over-configured" }),
      openLabel: "Project Usage",
    });
  }

  // Six specific reasons, replacing what used to be two lump counts ("cleanup" and
  // "standardize") that each folded several unrelated rules into one number -- clicking
  // either one sent a reader to a mixed bucket that didn't match whatever detail sentence
  // was on the card. Same split the filter and dashboard pillars already use for their own
  // findings: one card, one reason code, one accurate count to click through to.
  //
  // dimension: null on all of them, deliberately: "Field naming" and "Field governance" are
  // rates, these are the lists behind the rates, and nesting one inside the other would say
  // the same thing twice.
  const fieldCode = (code) => Number(findingsByCode?.[code]) || 0;

  if (fieldCode("global-context-low-usage") > 0) {
    findings.push({
      key: "field-global-context-low-usage",
      dimension: null,
      pillar: "fields",
      tone: "warning",
      count: fieldCode("global-context-low-usage"),
      title: "Global-context fields with very low usage",
      detail: "Applied to every project through a global context, but only a handful of issues carry a value.",
      onOpen: () => onNavigate("fields", { findings: "global-context-low-usage" }),
      openLabel: "Field Browser",
    });
  }

  if (fieldCode("dead-configuration") > 0) {
    findings.push({
      key: "field-dead-configuration",
      dimension: null,
      pillar: "fields",
      tone: "warning",
      count: fieldCode("dead-configuration"),
      title: "Fields configured far past where they're used",
      detail: "Configured across many projects; most of that scope has no issue data at all.",
      onOpen: () => onNavigate("fields", { findings: "dead-configuration" }),
      openLabel: "Field Browser",
    });
  }

  if (fieldCode("orphaned") + fieldCode("configured-no-issues") > 0) {
    findings.push({
      key: "field-no-populated-issues",
      dimension: null,
      pillar: "fields",
      tone: "info",
      count: fieldCode("orphaned") + fieldCode("configured-no-issues"),
      title: "Fields with no populated issues anywhere",
      detail: "Nothing recorded a value in any project this build could see — a candidate for deletion.",
      onOpen: () => onNavigate("fields", { findings: "orphaned,configured-no-issues" }),
      openLabel: "Field Browser",
    });
  }

  if (fieldCode("stale") > 0) {
    findings.push({
      key: "field-stale",
      dimension: null,
      pillar: "fields",
      tone: "info",
      count: fieldCode("stale"),
      title: "Fields with no activity in over a year",
      detail: "Carried values once; nothing has changed them recently. Different from never-used — this data is historical.",
      onOpen: () => onNavigate("fields", { findings: "stale" }),
      openLabel: "Field Browser",
    });
  }

  if (fieldCode("context-sprawl") > 0) {
    findings.push({
      key: "field-context-sprawl",
      dimension: null,
      pillar: "fields",
      tone: "info",
      count: fieldCode("context-sprawl"),
      title: "Fields patched project-by-project into context sprawl",
      detail: "Enough separate contexts to suggest the field grew by patching rather than by design.",
      onOpen: () => onNavigate("fields", { findings: "context-sprawl" }),
      openLabel: "Field Browser",
    });
  }

  if (fieldCode("missing-description") > 0) {
    findings.push({
      key: "field-missing-description",
      dimension: null,
      pillar: "fields",
      tone: "info",
      count: fieldCode("missing-description"),
      title: "Actively used fields with no description",
      detail: "Used broadly enough to warrant documentation an admin hasn't written yet.",
      onOpen: () => onNavigate("fields", { findings: "missing-description" }),
      openLabel: "Field Browser",
    });
  }

  // ── Automation ──────────────────────────────────────────────────────────
  //
  // Every one of these was already computed by the automation analysis and scored in site
  // health, and none of them reached this list -- the page whose entire job is to say what
  // needs attention was silent about the pillar carrying the credential findings.
  //
  // dimension: "automation-findings" on all five, deliberately not the four real scored
  // keys they used to nest under as chips -- promoted to their own cards, the same split
  // filter-hygiene and dashboard-hygiene findings already get. "Automation security" states
  // the rate; "Automation rules storing a credential in plaintext" is the list behind it.

  if (automation?.available && automation.credentialRuleCount > 0) {
    findings.push({
      key: "automation-credentials",
      dimension: "automation-findings",
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
      dimension: "automation-findings",
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
      dimension: "automation-findings",
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
      dimension: "automation-findings",
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
      dimension: "automation-findings",
      pillar: "automation",
      tone: "info",
      count: automation.disabledCount,
      title: "Disabled automation rules",
      detail: "A large disabled estate hides which rules were retired on purpose and which were forgotten. Decide per rule: revive or delete.",
      onOpen: () => onNavigate("automation", { section: "findings", risk: "disabled" }),
      openLabel: "Automation",
    });
  }

  // ── Dashboards ──────────────────────────────────────────────────────────
  //
  // Jira deletes a dashboard with its owner, exactly as it deletes a filter -- so a wall
  // screen owned by somebody who left has a deletion date nobody has written down.
  if (dashboards?.available && dashboards.orphanedCount > 0) {
    findings.push({
      key: "dashboards-orphaned",
      dimension: "dashboard-hygiene",
      pillar: "dashboards",
      tone: "critical",
      count: dashboards.orphanedCount,
      title: "Dashboards with no live owner",
      detail: "Jira deletes a dashboard with its owner. Reassign these before the accounts are removed, not after.",
      onOpen: () => onNavigate("dashboards", { finding: "orphaned-owner" }),
      openLabel: "Dashboards",
    });
  }

  if (dashboards?.available && dashboards.sharedPubliclyCount > 0) {
    findings.push({
      key: "dashboards-public",
      dimension: "dashboard-public",
      pillar: "dashboards",
      tone: "critical",
      count: dashboards.sharedPubliclyCount,
      title: "Dashboards shared publicly",
      detail: "Shared globally: on a site that allows anonymous access, anyone with the link can open them.",
      onOpen: () => onNavigate("dashboards", { finding: "shared-publicly" }),
      openLabel: "Dashboards",
    });
  }

  if (dashboards?.available && dashboards.editableByEveryoneCount > 0) {
    findings.push({
      key: "dashboards-open-edit",
      dimension: "dashboard-hygiene",
      pillar: "dashboards",
      tone: "warning",
      count: dashboards.editableByEveryoneCount,
      title: "Dashboards any logged-in user can rearrange",
      detail: "The next person to move a gadget moves it for everybody, and the owner is not told.",
      onOpen: () => onNavigate("dashboards", { finding: "editable-by-everyone" }),
      openLabel: "Dashboards",
    });
  }

  if (dashboards?.available && dashboards.emptyCount > 0) {
    findings.push({
      key: "dashboards-empty",
      dimension: "dashboard-hygiene",
      pillar: "dashboards",
      tone: "info",
      count: dashboards.emptyCount,
      title: "Dashboards with no gadgets",
      detail: "Anyone opening these sees an empty grid.",
      onOpen: () => onNavigate("dashboards", { finding: "empty" }),
      openLabel: "Dashboards",
    });
  }

  // Computed by summarizeDashboards alongside the three findings above and never reached
  // this list -- shared with everyone and favourited by nobody is exactly the "somebody
  // published this and nobody wanted it" shape the Filters pillar already flags.
  if (dashboards?.available && dashboards.publishedUnusedCount > 0) {
    findings.push({
      key: "dashboards-published-unused",
      dimension: "dashboard-hygiene",
      pillar: "dashboards",
      tone: "info",
      count: dashboards.publishedUnusedCount,
      title: "Dashboards published, unwanted",
      detail: "Shared with every logged-in user and favourited by nobody. Confirm it is still meant to be there.",
      onOpen: () => onNavigate("dashboards", { finding: "published-unused" }),
      openLabel: "Dashboards",
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

  // Cross-pillar: the filter's JQL names an issue type the site does not define, so the
  // clause can never match and the search silently returns fewer issues than its author
  // meant. Surfaced, not scored -- the same call the duplicate count makes.
  if (filters?.available && filters.unknownTypeRefCount > 0) {
    findings.push({
      key: "filters-unknown-type",
      dimension: "filter-hygiene",
      pillar: "filters",
      tone: "info",
      count: filters.unknownTypeRefCount,
      title: "Filters naming an issue type nothing defines",
      detail: "The JQL references a type no scheme allows, so that clause matches nothing and the filter returns less than expected — with no error to say why.",
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

  if (filters?.available && filters.sharedPubliclyCount > 0) {
    findings.push({
      key: "filters-public",
      dimension: "filter-public",
      pillar: "filters",
      tone: "critical",
      count: filters.sharedPubliclyCount,
      title: "Filters shared publicly",
      detail: "Shared globally: on a site that allows anonymous access, anyone with the link can run them and read every issue they return.",
      onOpen: () => onNavigate("filters", { view: "filters", finding: "shared-publicly" }),
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
      // "screen-findings" deliberately does not match a scored dimension key (screen-integrity
      // is the score; this is the count). Same split as filter-hygiene/dashboard-hygiene: the
      // scored card states the rate, this one states the actual list to act on.
      dimension: "screen-findings",
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
      dimension: "screen-findings",
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
      dimension: "screen-findings",
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
      dimension: "screen-findings",
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
      dimension: "screen-findings",
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
      dimension: "screen-findings",
      pillar: "screens",
      tone: "info",
      count: screens.unusedSchemes,
      title: "Screen schemes no issue type maps to",
      detail: "They cannot route anything to a project until an issue type screen scheme references them.",
      onOpen: () => onNavigate("screens", { view: "schemes", schemes: "unused" }),
      openLabel: "Screens",
    });
  }

  // ── Issue types ─────────────────────────────────────────────────────────
  // "issue-type-findings" deliberately does not match a scored dimension key -- the scored
  // cards state the rate, these state the list to act on, same split as screens.

  if (issueTypes?.available && issueTypes.orphanTypeCount > 0) {
    findings.push({
      key: "issue-type-orphans",
      dimension: "issue-type-findings",
      pillar: "issueTypes",
      tone: "critical",
      count: issueTypes.orphanTypeCount,
      title: "Issue types on no scheme",
      detail: "No project can create these, so every one is clutter in every type picker.",
      onOpen: () => onNavigate("issueTypes", { view: "hierarchy" }),
      openLabel: "Issue Types",
    });
  }

  if (issueTypes?.available && issueTypes.hierarchyFlaggedSchemeCount > 0) {
    findings.push({
      key: "issue-type-hierarchy",
      dimension: "issue-type-findings",
      pillar: "issueTypes",
      tone: "critical",
      count: issueTypes.hierarchyFlaggedSchemeCount,
      title: "Schemes that cannot start an issue",
      detail: "Sub-tasks with no standalone type, or a default type that cannot be created on its own.",
      onOpen: () => onNavigate("issueTypes", { view: "schemes" }),
      openLabel: "Issue Types",
    });
  }

  if (issueTypes?.available && issueTypes.reducibleTypeCount > 0) {
    findings.push({
      key: "issue-type-duplicates",
      dimension: "issue-type-findings",
      pillar: "issueTypes",
      tone: "warning",
      count: issueTypes.reducibleTypeCount,
      title: "Near-duplicate issue type names",
      detail: `${issueTypes.duplicateTypeGroupCount} group${issueTypes.duplicateTypeGroupCount === 1 ? "" : "s"} — a Bug / Defect split makes every by-type report wrong.`,
      onOpen: () => onNavigate("issueTypes", { view: "hierarchy" }),
      openLabel: "Issue Types",
    });
  }

  if (issueTypes?.available && issueTypes.unusedSchemeCount > 0) {
    findings.push({
      key: "issue-type-unused-schemes",
      dimension: "issue-type-findings",
      pillar: "issueTypes",
      tone: "info",
      count: issueTypes.unusedSchemeCount,
      title: "Issue type schemes assigned to no project",
      detail: "A scheme no project uses is a decision nobody made.",
      onOpen: () => onNavigate("issueTypes", { view: "schemes" }),
      openLabel: "Issue Types",
    });
  }

  // ── People ─────────────────────────────────────────────────────────────
  // "people-findings" is not a scored dimension key -- the scored cards state the rate,
  // these state the list to act on, same split as screens and issue types.

  if (users?.available && users.deactivatedUsers > 0) {
    findings.push({
      key: "people-deactivated-licence",
      dimension: "people-findings",
      pillar: "users",
      tone: "warning",
      count: users.deactivatedUsers,
      title: "Deactivated accounts still holding a licence",
      detail: "They count against the seat total and clutter every user picker until the licence is reclaimed.",
      onOpen: () => onNavigate("people", { view: "roster" }),
      openLabel: "People",
    });
  }

  if (users?.available && users.orphanedArtifacts > 0) {
    findings.push({
      key: "people-orphaned-ownership",
      dimension: "people-findings",
      pillar: "users",
      tone: "warning",
      count: users.orphanedArtifacts,
      title: "Filters, dashboards and rules with no owner on the roster",
      detail: `${users.orphanedOwners} account${users.orphanedOwners === 1 ? "" : "s"} no longer licensed still own site config — nobody can be asked to fix or retire it.`,
      onOpen: () => onNavigate("people", { view: "overview" }),
      openLabel: "People",
    });
  }

  if (users?.available && users.orphanedAutomationRefUsers > 0) {
    findings.push({
      key: "people-offroster-automation-refs",
      dimension: "people-findings",
      pillar: "users",
      tone: "critical",
      count: users.orphanedAutomationRefUsers,
      title: "Automation rules routing work to someone off the roster",
      detail: "A rule assigns to or conditions on an account that is no longer licensed — the work lands nowhere, or the condition silently never matches.",
      onOpen: () => onNavigate("people", { view: "overview" }),
      openLabel: "People",
    });
  }

  // ── Assets (CMDB) ──────────────────────────────────────────────────────
  // Only present on a JSM Premium site. `assets.available` is false everywhere else, so
  // none of these render rather than the pillar shipping empty findings.

  if (assets?.available && assets.brokenReferenceCount > 0) {
    findings.push({
      key: "asset-broken-references",
      dimension: "asset-findings",
      pillar: "assets",
      tone: "critical",
      count: assets.brokenReferenceCount,
      title: "Assets reference attributes pointing at a type that is gone",
      detail: "The attribute still shows on every object of its type and resolves to nothing — the CMDB analogue of a filter scoped to a deleted project.",
      onOpen: () => onNavigate("assets", { view: "attributes" }),
      openLabel: "Assets",
    });
  }

  if (assets?.available && assets.brokenHierarchyCount > 0) {
    findings.push({
      key: "asset-broken-hierarchy",
      dimension: "asset-findings",
      pillar: "assets",
      tone: "critical",
      count: assets.brokenHierarchyCount,
      title: "Assets object types whose parent is missing",
      detail: "Every child under the gap inherits attributes from a type that is not in the catalogue.",
      onOpen: () => onNavigate("assets", { view: "types" }),
      openLabel: "Assets",
    });
  }

  if (assets?.available && assets.deadSchemaCount > 0) {
    findings.push({
      key: "asset-dead-schemas",
      dimension: "asset-findings",
      pillar: "assets",
      tone: "warning",
      count: assets.deadSchemaCount,
      title: "Object schemas with nothing in them",
      detail: "No object types, or types but no objects — a namespace in every AQL autocomplete that resolves to nothing.",
      onOpen: () => onNavigate("assets", { view: "schemas" }),
      openLabel: "Assets",
    });
  }

  if (assets?.available && assets.bareTypeCount > 0) {
    findings.push({
      key: "asset-bare-types",
      dimension: "asset-findings",
      pillar: "assets",
      tone: "info",
      count: assets.bareTypeCount,
      title: "Concrete object types with no attribute of their own",
      detail: "Only the built-in Name — the type records nothing about the thing it represents.",
      onOpen: () => onNavigate("assets", { view: "types" }),
      openLabel: "Assets",
    });
  }

  // ── Access schemes: permissions / issue security / notifications ────────
  // Three pillars, one scan stage. The "*-findings" dimension keys deliberately do not match
  // a scored dimension -- the scored cards state the rate, these state the list to act on.

  const perm = access?.permissions;
  if (perm?.available && perm.riskySchemeCount > 0) {
    findings.push({
      key: "permission-risky",
      dimension: "permission-findings",
      pillar: "permissions",
      tone: "critical",
      count: perm.riskySchemeCount,
      title: "Permission schemes that break least privilege",
      detail: "Browse open to anyone, project admin handed to a whole group, or a permission held by a named individual — grants nobody reviews.",
      onOpen: () => onNavigate("access", { view: "permissions" }),
      openLabel: "Access",
    });
  }

  if (perm?.available && perm.unusedSchemeCount > 0) {
    findings.push({
      key: "permission-unused",
      dimension: "permission-findings",
      pillar: "permissions",
      tone: "info",
      count: perm.unusedSchemeCount,
      title: "Permission schemes assigned to no project",
      detail: "A scheme no project uses is a decision nobody made that still shows in every scheme picker.",
      onOpen: () => onNavigate("access", { view: "permissions" }),
      openLabel: "Access",
    });
  }

  const sec = access?.security;
  if (sec?.available && (sec.emptyLevelCount > 0 || sec.noLevelSchemeCount > 0)) {
    findings.push({
      key: "security-broken-levels",
      dimension: "security-findings",
      pillar: "security",
      tone: "critical",
      count: (sec.emptyLevelCount || 0) + (sec.noLevelSchemeCount || 0),
      title: "Issue security levels nobody can see through",
      detail: "Levels with no members, or schemes with no levels at all. An issue set to one is invisible to everyone but a site admin.",
      onOpen: () => onNavigate("access", { view: "security" }),
      openLabel: "Access",
    });
  }

  if (sec?.available && sec.unusedSchemeCount > 0) {
    findings.push({
      key: "security-unused",
      dimension: "security-findings",
      pillar: "security",
      tone: "info",
      count: sec.unusedSchemeCount,
      title: "Issue security schemes assigned to no project",
      detail: "Nothing enforces them. Clutter in the scheme picker.",
      onOpen: () => onNavigate("access", { view: "security" }),
      openLabel: "Access",
    });
  }

  const roleGov = access?.roles;
  if (roleGov?.available && roleGov.projectsMissingAdminActorCount > 0) {
    findings.push({
      key: "role-empty-admin",
      dimension: "role-findings",
      pillar: "roles",
      tone: "critical",
      count: roleGov.projectsMissingAdminActorCount,
      title: "Projects with an empty administrator role",
      detail: "No group or user is in the project's admin role — only a site admin can administer it.",
      onOpen: () => onNavigate("access", { view: "roles" }),
      openLabel: "Access",
    });
  }

  if (roleGov?.available && roleGov.offRosterActorCount > 0) {
    findings.push({
      key: "role-offroster-actors",
      dimension: "role-findings",
      pillar: "roles",
      tone: "warning",
      count: roleGov.offRosterActorCount,
      title: "Project-role actors off the licensed roster",
      detail: "An account no longer licensed still sits in a project role.",
      onOpen: () => onNavigate("access", { view: "roles" }),
      openLabel: "Access",
    });
  }

  const notif = access?.notifications;
  if (notif?.available && notif.fragileSchemeCount > 0) {
    findings.push({
      key: "notification-fragile",
      dimension: "notification-findings",
      pillar: "notifications",
      tone: "warning",
      count: notif.fragileSchemeCount,
      title: "Notification schemes routing to a named individual",
      detail: "The notification stops silently the day that person leaves. Route to a project role or group instead.",
      onOpen: () => onNavigate("access", { view: "notifications" }),
      openLabel: "Access",
    });
  }

  if (notif?.available && notif.unusedSchemeCount > 0) {
    findings.push({
      key: "notification-unused",
      dimension: "notification-findings",
      pillar: "notifications",
      tone: "info",
      count: notif.unusedSchemeCount,
      title: "Notification schemes assigned to no project",
      detail: "A scheme no project uses.",
      onOpen: () => onNavigate("access", { view: "notifications" }),
      openLabel: "Access",
    });
  }

  // ── Priorities & resolutions ──────────────────────────────────────────
  // "estate-findings" is not a scored dimension key — the scored cards state the rate,
  // these state the list to act on.

  if (estate?.available && estate.reducibleResolutionCount > 0) {
    findings.push({
      key: "estate-duplicate-resolutions",
      dimension: "estate-findings",
      pillar: "estate",
      tone: "warning",
      count: estate.reducibleResolutionCount,
      title: "Near-duplicate resolution names",
      detail: `${estate.resolutionDuplicateGroupCount} group${estate.resolutionDuplicateGroupCount === 1 ? "" : "s"} — every resolution-based report is split across the synonyms.`,
      onOpen: () => onNavigate("priorities", { view: "resolutions" }),
      openLabel: "Priorities",
    });
  }

  if (estate?.available && estate.reduciblePriorityCount > 0) {
    findings.push({
      key: "estate-duplicate-priorities",
      dimension: "estate-findings",
      pillar: "estate",
      tone: "info",
      count: estate.reduciblePriorityCount,
      title: "Near-duplicate priority names",
      detail: "Priorities that almost certainly mean the same thing.",
      onOpen: () => onNavigate("priorities", { view: "priorities" }),
      openLabel: "Priorities",
    });
  }

  // ── Projects ────────────────────────────────────────────────────────────

  // The month histogram behind every adoption figure has stopped near a fixed month -- a
  // Universal Scan that never reached the end. Surfaced ahead of the adoption findings
  // because it is why they are quiet: fell-off and never-adopted are both suppressed while
  // the data is this stale, so without this the section would just look clean.
  if (dashboard?.adoption?.available && dashboard.adoption.dataStale) {
    findings.push({
      key: "adoption-data-stale",
      dimension: "project-findings",
      pillar: "projects",
      tone: "warning",
      title: "Project activity data is out of date",
      detail: dashboard.adoption.dataThroughMonth
        ? `The issue histogram ends at ${dashboard.adoption.dataThroughMonth}. The last Universal Scan didn't finish, so adoption rates are stale and decline findings are held back until a scan completes.`
        : "The last Universal Scan didn't finish, so adoption rates are stale and decline findings are held back until a scan completes.",
      onOpen: () => onNavigate("scans"),
      openLabel: "Scans",
    });
  }

  // A project people LEFT, which no lifetime total can show: it looks busy right up until
  // you divide by time. Ordered most-recent-decline-first by the resolver, because those are
  // the ones somebody might still remember the reason for.
  if (dashboard?.adoption?.available && dashboard.adoption.fellOffCount > 0) {
    const worst = dashboard.adoption.fellOff?.[0];
    findings.push({
      key: "projects-fell-off",
      dimension: "project-findings",
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
      dimension: "project-findings",
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
      dimension: "project-findings",
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
      dimension: "project-findings",
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

function GovernanceLedgerPanel({ health, findings, history, workflow, screens, access, estate, automation, filters, dashboards, onNavigate, siteOrigin = "" }) {
  const ledger = React.useMemo(() => buildGovernanceLedger({ health, findings, history }), [health, findings, history]);

  // Where each finding's remediation stands. Fetched here rather than folded into
  // getAdminOverview, like the RQT card: the ledger renders completely without it, and a
  // failure leaves the findings exactly as they were rather than breaking the page.
  const [remediation, setRemediation] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    invoke("getRemediationTickets", {}).then((r) => { if (live) setRemediation(r); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const remediationFor = React.useCallback((findingKey) => {
    const playbookKey = remediation?.findingIndex?.[findingKey];
    if (!playbookKey) return null;
    const group = (remediation.groups || []).find((g) => g.findingKey === playbookKey) || null;
    return (
      <RemediationStatus
        group={group}
        period={remediation.period}
        siteOrigin={siteOrigin}
        compact
        onOpen={() => onNavigate?.("remediation", { finding: playbookKey })}
      />
    );
  }, [remediation, siteOrigin, onNavigate]);

  // Which pillars have never been built. Named individually, because "nothing flagged" while
  // three of five pillars have never been looked at is not a clean bill of health -- it is a
  // clean bill of the two things we checked.
  const unbuilt = [
    !workflow?.available && { label: "workflow inventory", tab: "workflows" },
    !screens?.available && { label: "screen inventory", tab: "screens" },
    !automation?.available && { label: "automation analysis", tab: "automation" },
    !filters?.available && { label: "saved filter inventory", tab: "filters" },
    !dashboards?.available && { label: "dashboard inventory", tab: "dashboards" },
    !access?.available && { label: "access scheme inventory", tab: "access" },
    !estate?.available && { label: "priorities & resolutions inventory", tab: "priorities" },
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
                          // The chip, then where its remediation stands. Siblings, not
                          // nested: the status line carries its own links and a button
                          // cannot contain another.
                          <div className="ui-gov__findingwrap" key={finding.key}>
                            <button
                              type="button"
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
                            {remediationFor(finding.key)}
                          </div>
                        ))}
                      </div>
                    ) : row.unscored ? (
                      // A finding rendered as its own row: its remediation sits beneath it.
                      remediationFor(row.key)
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

export function OverviewDashboard({ dashboard, findingsSummary, findingsByCode, workflow, screens, issueTypes, users, assets, access, estate, automation, filters, dashboards, health, history, onOpenRqtIndex, onNavigate, siteOrigin = "" }) {
  // onNavigate is optional so this stays renderable in isolation; without it the deep
  // links become inert rather than throwing.
  const navigate = onNavigate || (() => {});
  const findings = buildFindings({ findingsSummary, findingsByCode, dashboard, workflow, screens, issueTypes, users, assets, access, estate, automation, filters, dashboards, onNavigate: navigate });
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
        access={access}
        estate={estate}
        automation={automation}
        filters={filters}
        dashboards={dashboards}
        onNavigate={navigate}
        siteOrigin={siteOrigin}
      />
      {/* The per-pillar stat blocks that used to sit here -- Workflows, Projects, Field
          usage -- were removed: each is a duplicate of its own tab's Overview sub-view, and
          two copies of the same numbers on two pages is how the product starts reading as
          several. The cross-pillar findings ledger above is the landing page's job; the
          detail lives one click away on the pillar tab. */}
      <RqtPanel onOpenRqtIndex={onOpenRqtIndex} />
    </div>
  );
}
