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
const TOLERANCE = {
  duplicateFieldNames: 0.10,
  fieldFindings: 0.25,
  unusedFields: 0.35,
  duplicateStatuses: 0.15,
  unreachableStatuses: 0.20,
  flaggedSchemes: 0.40,
  irregularProjects: 0.25,
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
};

// rate 0 -> 100, rate >= tolerance -> 0, linear between. Deliberately linear: a curve
// would imply a precision this data does not have.
function scoreFromRate(rate, tolerance) {
  if (!Number.isFinite(rate) || rate <= 0) return 100;
  return Math.max(0, Math.round(100 * (1 - Math.min(1, rate / tolerance))));
}

function unavailable(key, label, reason) {
  return { key, label, available: false, score: null, reason };
}

export function computeSiteHealth({ fieldUsage, workflow, projects, automation } = {}) {
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
      available: true,
      weight: 1,
      score: scoreFromRate(rate, TOLERANCE.duplicateFieldNames),
      detail: clusters === 0
        ? "No duplicate field names."
        : `${clusters} groups of fields share a name across ${totalFields} fields.`,
      action: clusters > 0 ? "Consolidate duplicate field names in the Field Browser." : null,
    });
  } else {
    dimensions.push(unavailable("field-naming", "Field naming", "No field snapshot yet."));
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
      available: true,
      weight: 1.5,
      score: scoreFromRate(rate, TOLERANCE.fieldFindings),
      detail: `${severity.high || 0} high and ${severity.medium || 0} medium severity findings across ${totalFields} fields.`,
      action: (severity.high || 0) > 0 ? "Start with the high-severity findings — they affect how fields behave in Jira." : null,
    });
  } else {
    dimensions.push(unavailable("field-governance", "Field governance", "No field snapshot yet."));
  }

  // ── Status naming ─────────────────────────────────────────────────────────
  if (workflow?.available && workflow.statusCount > 0) {
    const removable = Number(workflow.reducibleStatusCount) || 0;
    const rate = removable / workflow.statusCount;
    dimensions.push({
      key: "status-naming",
      label: "Status naming",
      available: true,
      weight: 1,
      score: scoreFromRate(rate, TOLERANCE.duplicateStatuses),
      detail: removable === 0
        ? "No duplicate statuses."
        : `${removable} of ${workflow.statusCount} statuses are redundant across ${workflow.duplicateGroupCount} groups.`,
      action: removable > 0 ? "Consolidate duplicate statuses in the Workflows tab." : null,
    });
  } else {
    dimensions.push(unavailable("status-naming", "Status naming", "No workflow inventory yet."));
  }

  // ── Status reachability ───────────────────────────────────────────────────
  // Only scored when the scheme->status mapping exists. Without it every status looks
  // unreachable, which would report a catastrophic score for a healthy site.
  if (workflow?.available && workflow.schemeStatusesAvailable && workflow.statusCount > 0) {
    const rate = (Number(workflow.orphanCount) || 0) / workflow.statusCount;
    dimensions.push({
      key: "status-reachability",
      label: "Status reachability",
      available: true,
      weight: 1,
      score: scoreFromRate(rate, TOLERANCE.unreachableStatuses),
      detail: workflow.hasIssueCounts
        ? `${workflow.orphanCount} statuses no scheme reaches, ${workflow.safeToRemoveCount} of them never used.`
        : `${workflow.orphanCount} statuses no scheme reaches. Run a scan to confirm which are unused.`,
      // The caveat used to read "automation rules are not visible to this app". They are
      // now, so the advice names the check instead of warning about a blind spot -- but
      // only when an analysis exists. Without one the blind spot is still real.
      action: workflow.safeToRemoveCount > 0
        ? automation?.available
          ? `${workflow.safeToRemoveCount} statuses are unreachable and have never held an issue. Check the Automation tab's status list before deleting — a rule that transitions into one of these keeps it in use.`
          : `${workflow.safeToRemoveCount} statuses are unreachable and have never held an issue. No automation analysis has been built, so a rule could still transition into one of these — confirm before deleting.`
        : null,
    });
  } else {
    dimensions.push(unavailable("status-reachability", "Status reachability",
      workflow?.available ? "Jira did not return workflow status data." : "No workflow inventory yet."));
  }

  // ── Workflow structure ────────────────────────────────────────────────────
  if (workflow?.available && workflow.schemeCount > 0) {
    const rate = (Number(workflow.flaggedSchemeCount) || 0) / workflow.schemeCount;
    dimensions.push({
      key: "workflow-structure",
      label: "Workflow structure",
      available: true,
      weight: 1,
      score: scoreFromRate(rate, TOLERANCE.flaggedSchemes),
      detail: `${workflow.flaggedSchemeCount} of ${workflow.schemeCount} schemes carry a structural flag.`,
      action: workflow.flaggedSchemeCount > 0
        ? "Missing Done statuses and In Progress-heavy schemes are the ones worth looking at first." : null,
    });
  } else {
    dimensions.push(unavailable("workflow-structure", "Workflow structure", "No workflow inventory yet."));
  }

  // ── Process standardisation ───────────────────────────────────────────────
  // Higher is better and it is measured directly rather than as a defect rate: a site
  // where every project has a bespoke scheme cannot standardise anything.
  if (workflow?.available && workflow.schemeCount > 0) {
    const sharedRatio = (Number(workflow.sharedSchemes) || 0) / workflow.schemeCount;
    dimensions.push({
      key: "standardisation",
      label: "Process standardisation",
      available: true,
      weight: 1,
      score: Math.round(Math.min(100, sharedRatio * 200)),
      detail: `${workflow.sharedSchemes} of ${workflow.schemeCount} schemes govern more than one project.`,
      action: sharedRatio < 0.25
        ? "Most schemes are used by a single project, so there is little shared process to standardise against."
        : null,
    });
  } else {
    dimensions.push(unavailable("standardisation", "Process standardisation", "No workflow inventory yet."));
  }

  // ── Project consistency ───────────────────────────────────────────────────
  const totalProjects = Number(projects?.totalProjects) || 0;
  if (totalProjects > 0) {
    const irregular = (projects.overConfigured?.length || 0) + (projects.unusedProjects?.length || 0);
    const rate = irregular / totalProjects;
    dimensions.push({
      key: "project-consistency",
      label: "Project consistency",
      available: true,
      weight: 1,
      score: scoreFromRate(rate, TOLERANCE.irregularProjects),
      detail: `${projects.overConfigured?.length || 0} projects configured well past the norm, ${projects.unusedProjects?.length || 0} with fields but no issues.`,
      action: irregular > 0 ? "These are the projects where field cleanup has the least risk." : null,
    });
  } else {
    dimensions.push(unavailable("project-consistency", "Project consistency", "No project usage data yet."));
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
    dimensions.push(unavailable("automation-security", "Automation security", "No automation analysis yet."));
  }

  // ── Automation stability ──────────────────────────────────────────────────
  if (automation?.available && automationRules > 0) {
    const selfTriggering = Number(automation.selfTriggeringCount) || 0;
    const rate = selfTriggering / automationRules;
    dimensions.push({
      key: "automation-stability",
      label: "Automation stability",
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
    dimensions.push(unavailable("automation-stability", "Automation stability", "No automation analysis yet."));
  }

  // ── Automation hygiene ────────────────────────────────────────────────────
  if (automation?.available && automationRules > 0) {
    const disabled = Number(automation.disabledCount) || 0;
    const inert = Number(automation.noActionCount) || 0;
    const rate = (disabled + inert) / automationRules;
    dimensions.push({
      key: "automation-hygiene",
      label: "Automation hygiene",
      available: true,
      weight: 1,
      score: scoreFromRate(rate, TOLERANCE.disabledRules),
      detail: `${disabled} of ${automationRules} rules are disabled${inert > 0 ? `, and ${inert} have a trigger but no actions` : ""}.`,
      action: rate > 0.25
        ? "A large disabled estate hides which rules were retired on purpose and which were forgotten. Decide per rule: revive or delete."
        : null,
    });
  } else {
    dimensions.push(unavailable("automation-hygiene", "Automation hygiene", "No automation analysis yet."));
  }

  // ── Roll-up ───────────────────────────────────────────────────────────────
  const scored = dimensions.filter((d) => d.available);
  const totalWeight = scored.reduce((sum, d) => sum + d.weight, 0);
  const score = totalWeight > 0
    ? Math.round(scored.reduce((sum, d) => sum + d.score * d.weight, 0) / totalWeight)
    : null;

  return {
    score,
    grade: gradeFor(score),
    // Coverage is reported alongside the score because a 90 from two dimensions is a
    // weaker claim than a 72 from seven, and the reader has to be able to tell.
    dimensionsScored: scored.length,
    dimensionsTotal: dimensions.length,
    dimensions,
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
