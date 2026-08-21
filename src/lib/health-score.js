// A single site health score, and the dimensions it is made of.
//
// The number is the least important thing here. A bare "72/100" tells an admin nothing
// they can act on, so every dimension carries its own score, the rate it was derived
// from, and a sentence naming what would move it. The headline is a way in, not the
// finding.
//
// Two design rules the rest of this app already follows, applied again:
//
//   1. Rates, never counts. A site with 5,000 fields and 50 duplicates is tidier than one
//      with 80 fields and 50 duplicates. Scoring raw counts would rank them the other way.
//   2. Missing input is reported, never imputed. If the workflow snapshot has not been
//      built, its dimensions are marked unavailable and excluded from the mean rather than
//      scored as zero -- "we have not looked" and "we looked and it is bad" are different
//      claims, and only one of them justifies action.

// Rate at which a dimension bottoms out. Chosen to be forgiving at the low end and steep
// past the point where a reviewer would call the site untidy -- a 2% duplicate rate is
// noise on any real Jira, a 10% duplicate rate is a governance problem.
export const DEFAULT_HEALTH_TOLERANCES = {
  duplicateFieldNames: 0.10,
  fieldFindings: 0.25,
  unusedFields: 0.35,
  duplicateStatuses: 0.15,
  unreachableStatuses: 0.20,
  // Statuses only an automation rule reaches. Tighter than the unreachable bound: an
  // unreachable status is clutter, whereas one of these is a live process step that the
  // workflow does not document, and a handful of them is already a real divergence.
  ruleOnlyStatuses: 0.10,
  flaggedSchemes: 0.40,
  irregularProjects: 0.25,
  // Projects with no work, or none in six months. Forgiving: a healthy estate always
  // carries some finished projects, and retiring them is optional. It bottoms out because
  // past a third of the site nobody can tell a finished project from an abandoned one.
  inactiveProjects: 0.30,
  // Projects that had a life and lost it, or never got one. Sits between the two: less
  // forgiving than inactivity, because a project people abandoned is configuration nobody
  // owns, and more forgiving than a defect bound, because some projects are meant to end.
  unadoptedProjects: 0.25,
  // Far tighter than the rest, and deliberately so. The others measure untidiness, where a
  // few percent is normal on any real site. A rule storing a credential in plaintext is not
  // untidiness -- one is a problem and 2% of the estate is a bad day.
  credentialRules: 0.02,
  // A rule that writes a field it also triggers on loops on its own. Some sites run a few
  // knowingly, guarded by conditions; past a tenth of the estate it is not deliberate.
  selfTriggeringRules: 0.10,
  // Disabled rules are clutter rather than danger, so this is the most forgiving bound
  // here. It still bottoms out, because an estate that is half switched off has lost the
  // ability to tell "deliberately retired" from "forgotten".
  disabledRules: 0.50,
  // Rules posting to a non-Atlassian host. Not a defect on its own -- plenty of estates
  // integrate deliberately -- so this is looser than the credential bound. It is scored at
  // all because every one of these is data leaving the tenancy, and an admin who cannot say
  // how many there are cannot say what left.
  externalHttpRules: 0.15,
  // A scheme operation pointing at a screen the catalog does not contain. Tight, like the
  // credential bound: this is a broken mapping rather than an untidy one, and Jira falls
  // back silently when it resolves.
  danglingScreenRefs: 0.10,
  // Screens carrying no fields, or that no scheme routes to. Clutter, so it is forgiving --
  // but past a third of the catalog nobody can tell which screens are live.
  unusedScreens: 0.30,
};

// rate 0 -> 100, rate >= tolerance -> 0, linear between. Deliberately linear: a curve
// would imply a precision this data does not have.
function scoreFromRate(rate, tolerance) {
  if (!Number.isFinite(rate) || rate <= 0) return 100;
  return Math.max(0, Math.round(100 * (1 - Math.min(1, rate / tolerance))));
}

// Every dimension carries the pillar it belongs to, so the overview can group thirteen bars
// into five readable blocks instead of one flat list. Grouping lives here rather than in the
// UI because the pillar is a property of what is being measured, and a second copy of the
// mapping in JSX would drift the first time a dimension is added.
function unavailable(key, label, pillar, reason) {
  return { key, label, pillar, available: false, score: null, reason };
}

export const HEALTH_PILLARS = [
  { key: "fields", label: "Fields" },
  { key: "workflows", label: "Workflows and statuses" },
  { key: "screens", label: "Screens" },
  { key: "automation", label: "Automation" },
  { key: "projects", label: "Projects" },
];

// Tolerances are admin-tunable, like every field threshold already is.
//
// Before this they were constants, which meant the score judged a site on ten dimensions
// and let the admin influence only the field ones. That is the wrong asymmetry: an estate
// that knowingly runs twenty self-triggering rules under guard conditions was permanently
// marked down for a decision it had already made deliberately.
//
// Unknown keys are ignored and non-finite or non-positive values fall back to the default
// rather than throwing -- a bad config value should cost you a tuned dimension, not the
// whole health score.
export function resolveHealthTolerances(overrides = {}) {
  const out = { ...DEFAULT_HEALTH_TOLERANCES };
  for (const key of Object.keys(DEFAULT_HEALTH_TOLERANCES)) {
    const value = overrides?.[key];
    // Strict on type, not just on value. A numeric string would coerce cleanly here and
    // then disagree with the resolver, which rejects it on save -- so a tolerance that
    // "worked" in scoring could be impossible to persist.
    if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
  }
  return out;
}

export function computeSiteHealth({ fieldUsage, workflow, projects, automation, screens, adoption, tolerances } = {}) {
  const TOLERANCE = resolveHealthTolerances(tolerances);
  const dimensions = [];

  // ── Field naming ──────────────────────────────────────────────────────────
  const totalFields = Number(fieldUsage?.totalFields) || 0;
  if (totalFields > 0) {
    const clusters = Number(fieldUsage?.duplicateClusters) || 0;
    // A cluster implies at least two fields sharing a name; count the removable ones.
    const rate = clusters / totalFields;
    dimensions.push({
      key: "field-naming",
      label: "Field naming",
      pillar: "fields",
      available: true,
      weight: 1,
      score: scoreFromRate(rate, TOLERANCE.duplicateFieldNames),
      detail: clusters === 0
        ? "No duplicate field names."
        : `${clusters} groups of fields share a name across ${totalFields} fields.`,
      action: clusters > 0 ? "Consolidate duplicate field names in the Field Browser." : null,
    });
  } else {
    dimensions.push(unavailable("field-naming", "Field naming", "fields", "No field snapshot yet."));
  }

  // ── Field governance ──────────────────────────────────────────────────────
  const severity = fieldUsage?.findingsBySeverity;
  if (totalFields > 0 && severity) {
    // High severity counts double: these are configuration problems, not style notes.
    const weighted = (Number(severity.high) || 0) * 2 + (Number(severity.medium) || 0);
    const rate = weighted / (totalFields * 2);
    dimensions.push({
      key: "field-governance",
      label: "Field governance",
      pillar: "fields",
      available: true,
      weight: 1.5,
      score: scoreFromRate(rate, TOLERANCE.fieldFindings),
      detail: `${severity.high || 0} high and ${severity.medium || 0} medium severity findings across ${totalFields} fields.`,
      action: (severity.high || 0) > 0 ? "Start with the high-severity findings — they affect how fields behave in Jira." : null,
    });
  } else {
    dimensions.push(unavailable("field-governance", "Field governance", "fields", "No field snapshot yet."));
  }

  // ── Status naming ─────────────────────────────────────────────────────────
  if (workflow?.available && workflow.statusCount > 0) {
    const removable = Number(workflow.reducibleStatusCount) || 0;
    const rate = removable / workflow.statusCount;
    dimensions.push({
      key: "status-naming",
      label: "Status naming",
      pillar: "workflows",
      available: true,
      weight: 1,
      score: scoreFromRate(rate, TOLERANCE.duplicateStatuses),
      detail: removable === 0
        ? "No duplicate statuses."
        : `${removable} of ${workflow.statusCount} statuses are redundant across ${workflow.duplicateGroupCount} groups.`,
      action: removable > 0 ? "Consolidate duplicate statuses in the Workflows tab." : null,
    });
  } else {
    dimensions.push(unavailable("status-naming", "Status naming", "workflows", "No workflow inventory yet."));
  }

  // ── Status reachability ───────────────────────────────────────────────────
  // Only scored when the scheme->status mapping exists. Without it every status looks
  // unreachable, which would report a catastrophic score for a healthy site.
  //
  // Scored on orphans NO RULE TOUCHES, not on every orphan. A status a rule transitions
  // into is reachable -- an issue gets there, users see it, deleting it breaks the rule.
  // Counting those as unreachable is what made this dimension read 0 on a site whose real
  // dead-status problem is a third the size, and it made the site's weakest dimension a
  // number nobody could act on. The statuses only a rule reaches are their own dimension
  // below, because they are a different finding with a different fix.
  if (workflow?.available && workflow.schemeStatusesAvailable && workflow.statusCount > 0) {
    // Falls back to the whole orphan count on a payload built before the split, so an
    // older cached measurement still scores rather than reporting unavailable.
    const dead = Number(workflow.unreachableNoRuleCount ?? workflow.orphanCount) || 0;
    const ruleOnly = Number(workflow.ruleOnlyStatusCount) || 0;
    const rate = dead / workflow.statusCount;
    dimensions.push({
      key: "status-reachability",
      label: "Status reachability",
      pillar: "workflows",
      available: true,
      weight: 1,
      score: scoreFromRate(rate, TOLERANCE.unreachableStatuses),
      detail: !workflow.automationChecked
        ? `${dead} of ${workflow.statusCount} statuses no scheme reaches. No automation analysis, so a rule could still be using them.`
        : workflow.hasIssueCounts
          ? `${dead} of ${workflow.statusCount} statuses no scheme and no rule reaches, ${workflow.safeToRemoveCount} of them never used.`
          : `${dead} of ${workflow.statusCount} statuses no scheme and no rule reaches. Run a scan to confirm which are unused.`,
      action: workflow.safeToRemoveCount > 0
        ? workflow.automationChecked
          ? `${workflow.safeToRemoveCount} statuses are reached by no scheme, no rule and no issue in history. These are the ones that are actually safe to delete.`
          : `${workflow.safeToRemoveCount} statuses are unreachable and have never held an issue. No automation analysis has been built, so a rule could still transition into one of these — confirm before deleting.`
        : ruleOnly > 0
          ? "Every unreachable status is held open by an automation rule. Nothing here is safe to delete yet."
          : null,
    });
  } else {
    dimensions.push(unavailable("status-reachability", "Status reachability", "workflows", workflow?.available ? "Jira did not return workflow status data." : "No workflow inventory yet."));
  }

  // ── Status coverage ───────────────────────────────────────────────────────
  // Statuses an automation rule can put an issue into, that no workflow scheme contains.
  //
  // Not a cleanup target and not untidiness -- it is process that exists and is invisible
  // in Jira's own workflow admin. Someone reading the scheme cannot see these states at
  // all, so the documented process and the real one differ by however many this is.
  //
  // Only scored once the rules have actually been read. Without an analysis every status
  // would score as fully covered, which is the same false all-clear this whole change is
  // about.
  if (workflow?.available && workflow.schemeStatusesAvailable && workflow.statusCount > 0 && workflow.automationChecked) {
    const ruleOnly = Number(workflow.ruleOnlyStatusCount) || 0;
    const rate = ruleOnly / workflow.statusCount;
    dimensions.push({
      key: "status-coverage",
      label: "Status coverage",
      pillar: "workflows",
      available: true,
      weight: 1,
      score: scoreFromRate(rate, TOLERANCE.ruleOnlyStatuses),
      detail: ruleOnly === 0
        ? `Every status a rule touches is also in a workflow scheme.`
        : `${ruleOnly} of ${workflow.statusCount} statuses are reachable only through an automation rule, not through any scheme.`,
      action: ruleOnly > 0
        ? "Issues reach these states without any workflow saying so. Add them to the scheme that should own them, or move the rule's transition."
        : null,
    });
  } else {
    dimensions.push(unavailable("status-coverage", "Status coverage", "workflows",
      workflow?.available && workflow.schemeStatusesAvailable
        ? "No automation analysis yet, so rule-only statuses cannot be identified."
        : "No workflow inventory yet."));
  }

  // ── Workflow structure ────────────────────────────────────────────────────
  if (workflow?.available && workflow.schemeCount > 0) {
    const rate = (Number(workflow.flaggedSchemeCount) || 0) / workflow.schemeCount;
    dimensions.push({
      key: "workflow-structure",
      label: "Workflow structure",
      pillar: "workflows",
      available: true,
      weight: 1,
      score: scoreFromRate(rate, TOLERANCE.flaggedSchemes),
      detail: `${workflow.flaggedSchemeCount} of ${workflow.schemeCount} schemes carry a structural flag.`,
      action: workflow.flaggedSchemeCount > 0
        ? "Missing Done statuses and In Progress-heavy schemes are the ones worth looking at first." : null,
    });
  } else {
    dimensions.push(unavailable("workflow-structure", "Workflow structure", "workflows", "No workflow inventory yet."));
  }

  // ── Process standardisation ───────────────────────────────────────────────
  // Higher is better and it is measured directly rather than as a defect rate: a site
  // where every project has a bespoke scheme cannot standardise anything.
  if (workflow?.available && workflow.schemeCount > 0) {
    const sharedRatio = (Number(workflow.sharedSchemes) || 0) / workflow.schemeCount;
    dimensions.push({
      key: "standardisation",
      label: "Process standardisation",
      pillar: "workflows",
      available: true,
      weight: 1,
      score: Math.round(Math.min(100, sharedRatio * 200)),
      detail: `${workflow.sharedSchemes} of ${workflow.schemeCount} schemes govern more than one project.`,
      action: sharedRatio < 0.25
        ? "Most schemes are used by a single project, so there is little shared process to standardise against."
        : null,
    });
  } else {
    dimensions.push(unavailable("standardisation", "Process standardisation", "workflows", "No workflow inventory yet."));
  }

  // ── Project consistency ───────────────────────────────────────────────────
  // Field-count deviation from the site norm, over every project rather than over a
  // display list.
  //
  // Two separate defects were folded together here. The rate was built from
  // `overConfigured.length` and `unusedProjects.length`, which are the Overview's top-8
  // display lists -- so the numerator was capped at sixteen and the dimension could not
  // fall below ~94 on a site of any size. And "over-configured" itself meant
  // over-configured AND barely used, which on an active site is nobody, while the label
  // claimed the field-count finding on its own. The result was a permanent 100.
  const totalProjects = Number(projects?.totalProjects) || 0;
  if (totalProjects > 0) {
    const overConfigured = Number(projects.overConfiguredCount) || 0;
    const rate = overConfigured / totalProjects;
    const floor = Number(projects.overConfiguredFloor) || 0;
    const idle = Number(projects.idleOverConfiguredCount) || 0;
    dimensions.push({
      key: "project-consistency",
      label: "Project consistency",
      pillar: "projects",
      available: true,
      weight: 1,
      score: scoreFromRate(rate, TOLERANCE.irregularProjects),
      detail: overConfigured === 0
        ? `No project carries more than ${floor} fields, against a median of ${projects.medianFieldCount}.`
        : `${overConfigured} of ${totalProjects} projects carry ${floor} or more fields, against a median of ${projects.medianFieldCount}.`,
      action: idle > 0
        ? `${idle} of them carry little issue volume too — those are where field cleanup has the least risk.`
        : overConfigured > 0
          ? "All of them carry real issue volume, so this is scope to review rather than cleanup to schedule."
          : null,
    });
  } else {
    dimensions.push(unavailable("project-consistency", "Project consistency", "projects", "No project usage data yet."));
  }

  // ── Project activity ──────────────────────────────────────────────────────
  // Configuration outliving the work it was built for. Distinct from consistency: a
  // project can be perfectly ordinary in shape and have had nothing touched in a year,
  // and that is the cheapest field cleanup on the site.
  if (totalProjects > 0) {
    const unused = Number(projects.unusedProjectCount) || 0;
    const stale = Number(projects.staleProjectCount) || 0;
    const rate = (unused + stale) / totalProjects;
    dimensions.push({
      key: "project-activity",
      label: "Project activity",
      pillar: "projects",
      available: true,
      weight: 1,
      score: scoreFromRate(rate, TOLERANCE.inactiveProjects),
      detail: unused + stale === 0
        ? `All ${totalProjects} projects carry work and have been touched in the last six months.`
        : `${stale} projects have had no activity in six months and ${unused} carry fields but no work at all.`,
      action: unused + stale > 0
        ? "Retiring fields from a project nobody is using costs nothing and is not reversible by accident."
        : null,
    });
  } else {
    dimensions.push(unavailable("project-activity", "Project activity", "projects", "No project usage data yet."));
  }

  // ── Project adoption ──────────────────────────────────────────────────────
  // Whether the work people do matches the projects that exist for them to do it in.
  //
  // Distinct from project activity above, which asks whether anything happened recently.
  // This asks whether the RATE is healthy for the project's age -- which catches the case
  // activity cannot: a project somebody touched last week that has collapsed from 500 issues
  // a month to three. Every other project figure in this app was a lifetime total with
  // nothing to divide it by, which flatters old projects and buries new ones.
  //
  // Judged only over projects old enough to judge. A site of projects spun up last month has
  // no adoption problem, and reporting one would be an artefact of when it was measured.
  if (adoption?.available && adoption.judgeableProjects > 0) {
    const fellOff = Number(adoption.fellOffCount) || 0;
    const never = Number(adoption.neverAdoptedCount) || 0;
    const rate = (fellOff + never) / adoption.judgeableProjects;
    dimensions.push({
      key: "project-adoption",
      label: "Project adoption",
      pillar: "projects",
      available: true,
      weight: 1,
      score: scoreFromRate(rate, TOLERANCE.unadoptedProjects),
      detail: fellOff + never === 0
        ? `All ${adoption.judgeableProjects} projects old enough to judge are being used at a rate that matches their age.`
        : `${fellOff} projects have fallen well below their own historical rate and ${never} never took off, of ${adoption.judgeableProjects} old enough to judge.`,
      action: fellOff > 0
        ? "A project people left is configuration nobody owns. The Projects tab dates each decline — start with the ones that fell off most recently, while somebody still remembers why."
        : never > 0
          ? "These were created and never adopted. Worth asking what people used instead before retiring the fields."
          : null,
    });
  } else {
    dimensions.push(unavailable("project-adoption", "Project adoption", "projects",
      adoption?.available
        ? "No project is old enough to judge adoption yet."
        : "No issue dates captured. Run a Universal Scan to measure adoption."));
  }

  // ── Automation security ───────────────────────────────────────────────────
  // Weighted above every other dimension. The rest of this score measures configuration
  // that is untidy; this one measures a credential readable by anyone who can open the
  // rule, which is a different kind of problem and should not be averaged away by six
  // dimensions of naming hygiene.
  const automationRules = Number(automation?.ruleCount) || 0;
  if (automation?.available && automationRules > 0) {
    const withCredentials = Number(automation.credentialRuleCount) || 0;
    const rate = withCredentials / automationRules;
    dimensions.push({
      key: "automation-security",
      label: "Automation security",
      pillar: "automation",
      available: true,
      weight: 2,
      score: scoreFromRate(rate, TOLERANCE.credentialRules),
      detail: withCredentials === 0
        ? `No credentials stored in the ${automationRules} automation rules.`
        : `${withCredentials} of ${automationRules} rules store a credential in plaintext.`,
      action: withCredentials > 0
        ? "Anyone who can view these rules can read the secret. Rotate them and move to a smart-value reference or an Automation connection."
        : null,
    });
  } else {
    dimensions.push(unavailable("automation-security", "Automation security", "automation", "No automation analysis yet."));
  }

  // ── Automation stability ──────────────────────────────────────────────────
  if (automation?.available && automationRules > 0) {
    const selfTriggering = Number(automation.selfTriggeringCount) || 0;
    const rate = selfTriggering / automationRules;
    dimensions.push({
      key: "automation-stability",
      label: "Automation stability",
      pillar: "automation",
      available: true,
      weight: 1.5,
      score: scoreFromRate(rate, TOLERANCE.selfTriggeringRules),
      detail: selfTriggering === 0
        ? "No rule writes a field it also triggers on."
        : `${selfTriggering} rules write a field they themselves trigger on.`,
      action: selfTriggering > 0
        ? "These loop without a second rule involved. Check the conditions guarding them before the next execution-limit surprise."
        : null,
    });
  } else {
    dimensions.push(unavailable("automation-stability", "Automation stability", "automation", "No automation analysis yet."));
  }

  // ── Automation hygiene ────────────────────────────────────────────────────
  if (automation?.available && automationRules > 0) {
    const disabled = Number(automation.disabledCount) || 0;
    const inert = Number(automation.noActionCount) || 0;
    const rate = (disabled + inert) / automationRules;
    dimensions.push({
      key: "automation-hygiene",
      label: "Automation hygiene",
      pillar: "automation",
      available: true,
      weight: 1,
      score: scoreFromRate(rate, TOLERANCE.disabledRules),
      detail: `${disabled} of ${automationRules} rules are disabled${inert > 0 ? `, and ${inert} have a trigger but no actions` : ""}.`,
      action: rate > 0.25
        ? "A large disabled estate hides which rules were retired on purpose and which were forgotten. Decide per rule: revive or delete."
        : null,
    });
  } else {
    dimensions.push(unavailable("automation-hygiene", "Automation hygiene", "automation", "No automation analysis yet."));
  }

  // ── Automation exposure ───────────────────────────────────────────────────
  // Separate from automation security rather than folded into it. A plaintext credential is
  // a defect in every estate; an outbound webhook is a deliberate integration in most. They
  // are averaged together only in the pillar, so a site with twenty legitimate integrations
  // does not read as twenty security problems.
  if (automation?.available && automationRules > 0) {
    const external = Number(automation.externalHttpCount) || 0;
    const rate = external / automationRules;
    dimensions.push({
      key: "automation-exposure",
      label: "Automation exposure",
      pillar: "automation",
      available: true,
      weight: 1,
      score: scoreFromRate(rate, TOLERANCE.externalHttpRules),
      detail: external === 0
        ? "No rule sends data outside Atlassian."
        : `${external} of ${automationRules} rules send data to a non-Atlassian host.`,
      action: external > 0
        ? "Each of these moves Jira data out of the tenancy. Confirm every destination is still one you own."
        : null,
    });
  } else {
    dimensions.push(unavailable("automation-exposure", "Automation exposure", "automation", "No automation analysis yet."));
  }

  // ── Screen scheme integrity ───────────────────────────────────────────────
  // Weighted like automation stability: a scheme pointing at a screen that no longer exists
  // does not error, it silently falls back, so nobody finds it by using Jira.
  const screenOperations = Number(screens?.totalOperations) || 0;
  if (screens?.available && screenOperations > 0) {
    const dangling = Number(screens.danglingOperations) || 0;
    const rate = dangling / screenOperations;
    dimensions.push({
      key: "screen-integrity",
      label: "Screen scheme integrity",
      pillar: "screens",
      available: true,
      weight: 1.5,
      score: scoreFromRate(rate, TOLERANCE.danglingScreenRefs),
      detail: dangling === 0
        ? `All ${screenOperations} scheme operations resolve to a screen that exists.`
        : `${dangling} of ${screenOperations} scheme operations point at a screen that no longer exists.`,
      action: dangling > 0
        ? "Jira falls back silently when one of these resolves, so the form a user sees is not the one the scheme names. Repoint them in the Screens tab."
        : null,
    });
  } else {
    dimensions.push(unavailable("screen-integrity", "Screen scheme integrity", "screens",
      screens?.available ? "No screen schemes found." : "No screen inventory yet."));
  }

  // ── Screen hygiene ────────────────────────────────────────────────────────
  // Unresolved screens are excluded from the rate rather than counted as clean or dirty.
  // A screen whose contents could not be read is unmeasured, and scoring it either way
  // would state something the pass did not establish.
  const totalScreens = Number(screens?.totalScreens) || 0;
  const unresolvedScreens = Number(screens?.unresolvedScreens) || 0;
  const measuredScreens = totalScreens - unresolvedScreens;
  if (screens?.available && measuredScreens > 0) {
    const empty = Number(screens.emptyScreens) || 0;
    // null means no workflow snapshot exists, so whether a transition opens these screens
    // is unknown. Scored on emptiness alone in that case rather than counting a screen a
    // transition may well be using -- the dimension says so in its detail line.
    const unreached = screens.unreachedScreens == null ? 0 : Number(screens.unreachedScreens);
    const reachKnown = screens.unreachedScreens != null;
    // A screen can be both empty and unreached; counting the union avoids double-charging
    // one screen for two symptoms of the same neglect. Without per-screen flags here the
    // safe union is the larger of the two, never the sum.
    const idle = Math.max(empty, unreached);
    const rate = idle / measuredScreens;
    dimensions.push({
      key: "screen-hygiene",
      label: "Screen hygiene",
      pillar: "screens",
      available: true,
      weight: 1,
      score: scoreFromRate(rate, TOLERANCE.unusedScreens),
      detail: !reachKnown
        ? `${empty} of ${measuredScreens} readable screens carry no fields. No workflow inventory, so whether a transition opens the rest is unknown.`
        : idle === 0
          ? `All ${measuredScreens} readable screens carry fields and are reachable by a scheme or a transition.`
          : `${empty} screens carry no fields and ${unreached} are reached by neither a scheme nor a transition, of ${measuredScreens} readable.`,
      action: !reachKnown
        ? "Build the workflow inventory to tell an unused screen from one a transition opens."
        : idle > 0
          ? "These are the screens where cleanup carries the least risk — nothing routes to them, or there is nothing on them."
          : null,
    });
  } else {
    dimensions.push(unavailable("screen-hygiene", "Screen hygiene", "screens",
      screens?.available ? "No screen contents could be read." : "No screen inventory yet."));
  }

  // ── Roll-up ───────────────────────────────────────────────────────────────
  const scored = dimensions.filter((d) => d.available);
  const totalWeight = scored.reduce((sum, d) => sum + d.weight, 0);
  const score = totalWeight > 0
    ? Math.round(scored.reduce((sum, d) => sum + d.score * d.weight, 0) / totalWeight)
    : null;

  // Per-pillar roll-ups, weighted the same way as the headline. Computed here so the
  // overview renders groups without re-deriving the weighting -- a second implementation in
  // JSX would eventually disagree with this one about what the site scored.
  //
  // A pillar with nothing scored keeps score: null rather than 0, for the same reason a
  // dimension does: it has not been measured, which is not the same as measuring badly.
  const pillars = HEALTH_PILLARS.map(({ key, label }) => {
    const own = dimensions.filter((d) => d.pillar === key);
    const ownScored = own.filter((d) => d.available);
    const ownWeight = ownScored.reduce((sum, d) => sum + d.weight, 0);
    const pillarScore = ownWeight > 0
      ? Math.round(ownScored.reduce((sum, d) => sum + d.score * d.weight, 0) / ownWeight)
      : null;
    return {
      key,
      label,
      score: pillarScore,
      grade: gradeFor(pillarScore),
      available: ownScored.length > 0,
      dimensions: own,
      scored: ownScored.length,
      total: own.length,
      // The reason the whole pillar is dark, when it is. Every dimension in an unbuilt
      // pillar reports the same one, so showing it once beats repeating it per bar.
      reason: ownScored.length === 0 ? own[0]?.reason ?? null : null,
    };
  }).filter((p) => p.total > 0);

  return {
    score,
    grade: gradeFor(score),
    // Coverage is reported alongside the score because a 90 from two dimensions is a
    // weaker claim than a 72 from seven, and the reader has to be able to tell.
    dimensionsScored: scored.length,
    dimensionsTotal: dimensions.length,
    dimensions,
    pillars,
    weakest: scored.length ? scored.slice().sort((a, b) => a.score - b.score)[0] : null,
  };
}

export function gradeFor(score) {
  if (score === null || score === undefined) return null;
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "E";
}
