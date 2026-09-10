// Blast radius: how much of the estate one automation rule can move.
//
// The rest of the automation analysis answers "is this rule risky" (a credential in it, a
// loop it sits in). This answers a different question the same admin asks next: "if this
// rule misfires, how far does the damage reach". A rule that edits a field on every issue
// in the site is not the same hazard as one scoped to a five-person project, and the tab
// has never said so in a number.
//
// Four weighted factors, each 0..1:
//
//   reach     0.40  how much of the estate the rule's scope covers -- site-wide, or the
//                   share of projects / issues it is scoped to
//   cadence   0.15  how often and how broadly the trigger fires -- a scheduled JQL sweep
//                   re-evaluates a whole set every run; a manual trigger runs when asked
//   writes    0.25  the weight of what the actions do -- a transition or an external call
//                   costs more than setting a label
//   fanout    0.20  whether the rule wakes other rules, and how many -- a rule in a loop
//                   can re-enter itself
//
// Then two modifiers: a disabled rule is scored at a fraction (its LATENT blast if
// re-enabled, not zero -- a dormant site-wide rule is still a loaded gun), and a rule
// carrying a plaintext credential floors at cross-project because the exposure itself is
// the blast, independent of issue reach.
//
// Pure and import-free, like cascade-graph.js: analyzeRules() runs this in the admin's
// browser at import time, so nothing here may pull in @forge/*.

// The single write-direction marker, inlined rather than imported from automation-analysis
// to keep this module free of that import cycle (automation-analysis orchestrates this one).
const WRITE = "write";

export const BLAST_TIERS = [
  { key: "estate", label: "Estate-wide", min: 70 },
  { key: "cross-project", label: "Cross-project", min: 45 },
  { key: "project", label: "Project", min: 22 },
  { key: "contained", label: "Contained", min: 0 },
];

export function tierForScore(score) {
  const n = Number(score) || 0;
  return BLAST_TIERS.find((t) => n >= t.min) ?? BLAST_TIERS[BLAST_TIERS.length - 1];
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// How broadly and how often the trigger fires. Matched on substrings because Automation
// trigger type strings vary by rule age -- "jira.issue.event.trigger:created" and
// "jira.issue.created" are the same trigger written a year apart.
function cadenceScore(triggerType) {
  const t = String(triggerType || "").toLowerCase();
  if (!t) return { value: 0.35, detail: "Trigger type not recorded." };
  if (t.includes("scheduled") || t.includes("jql.scheduled")) {
    return { value: 1, detail: "Scheduled — re-evaluates a set of issues on every run." };
  }
  if (t.includes("manual")) {
    return { value: 0.15, detail: "Manual — only runs when a person starts it." };
  }
  if (t.includes("webhook")) {
    return { value: 0.6, detail: "Incoming webhook — runs whenever an external caller hits it." };
  }
  if (t.includes("field") && t.includes("chang")) {
    return { value: 0.55, detail: "Fires on every matching field edit." };
  }
  if (t.includes("updated")) {
    return { value: 0.55, detail: "Fires on every matching issue update." };
  }
  if (t.includes("created")) {
    return { value: 0.5, detail: "Fires on every issue created in scope." };
  }
  if (t.includes("transition")) {
    return { value: 0.45, detail: "Fires on matching workflow transitions." };
  }
  if (t.includes("comment")) {
    return { value: 0.4, detail: "Fires on every comment added in scope." };
  }
  return { value: 0.4, detail: "Fires on a matching issue event." };
}

// The weight of what the rule's actions do. Transitions and external calls move more than
// a field edit; deleting an issue or calling out to another service is close to the top
// because it is the least reversible.
function writeSeverity(summary) {
  const kinds = new Set(summary.actionKinds || []);
  const transitions = (summary.statusRefs || []).filter((r) => r.kind === WRITE).length;
  const fieldWrites = (summary.writesFields || []).length;

  let s = 0;
  const bits = [];
  if (transitions) { s += Math.min(0.5, transitions * 0.25); bits.push(`${transitions} transition${transitions === 1 ? "" : "s"}`); }
  if (fieldWrites) { s += Math.min(0.4, fieldWrites * 0.06); bits.push(`${fieldWrites} field write${fieldWrites === 1 ? "" : "s"}`); }
  if (kinds.has("create-issue")) { s += 0.4; bits.push("creates issues"); }
  if (kinds.has("delete-issue")) { s += 0.6; bits.push("deletes issues"); }
  if (kinds.has("outbound-http")) { s += 0.5; bits.push("calls an external service"); }
  if (kinds.has("send-email")) { s += 0.25; bits.push("sends email"); }
  if (kinds.has("assign")) { s += 0.1; bits.push("reassigns issues"); }

  return {
    value: clamp01(s / 1.3),
    detail: bits.length ? `Actions: ${bits.join(", ")}.` : "No issue-mutating actions detected.",
  };
}

// Whether the rule wakes other rules. A rule that cannot ("Allow other rules to trigger"
// off) contributes almost nothing here even if it writes a field others watch; one in a
// cascade loop contributes the maximum, because it can re-enter itself.
function fanoutScore(summary, outDegree, inLoop) {
  if (inLoop) {
    return { value: 1, detail: "Sits in a cascade loop — its own writes can come back round to it." };
  }
  if (!summary.canOtherRuleTrigger) {
    return outDegree > 0
      ? { value: 0.1, detail: "\"Allow other rules to trigger\" is off, but its writes match another rule's trigger." }
      : { value: 0.03, detail: "Cannot wake other rules." };
  }
  const value = clamp01(0.3 + outDegree * 0.12);
  return {
    value,
    detail: outDegree > 0
      ? `Wakes ${outDegree} other rule${outDegree === 1 ? "" : "s"} directly.`
      : "Can wake other rules, though none currently match its writes.",
  };
}

// context:
//   projectCountTotal   number   projects on the site, for the scope-breadth fraction
//   projectIssueCounts  Map      projectId -> issue count, for volume weighting (optional)
//   siteIssueTotal      number   sum of the above, when known
//   outDegree           number   cascade-graph out-degree for this rule
//   inLoop             boolean   this rule is in a cascade loop
export function scoreRuleBlastRadius(summary, context = {}) {
  const {
    projectCountTotal = 0,
    projectIssueCounts = null,
    siteIssueTotal = 0,
    outDegree = 0,
    inLoop = false,
  } = context;

  const projectIds = (summary.projectIds || []).map(String);
  const siteWide = projectIds.length === 0;
  const factors = [];
  let estimated = false;

  // 1. Reach ────────────────────────────────────────────────────────────────
  let reach;
  let reachDetail;
  if (siteWide) {
    reach = 1;
    reachDetail = "Scoped to the whole site — every project.";
  } else if (projectIssueCounts && siteIssueTotal > 0) {
    const scoped = projectIds.reduce((n, id) => n + (Number(projectIssueCounts.get(id)) || 0), 0);
    // Log-shaped: one very large project should already read as high reach, not 3%.
    reach = clamp01(Math.log1p(scoped) / Math.log1p(siteIssueTotal));
    reachDetail = `Scoped to ${projectIds.length} project${projectIds.length === 1 ? "" : "s"} holding about ${scoped.toLocaleString()} issues.`;
  } else {
    estimated = true;
    const frac = projectCountTotal > 0 ? projectIds.length / projectCountTotal : 0;
    reach = clamp01(Math.max(frac * 0.6, Math.min(projectIds.length / 12, 0.7)));
    reachDetail = `Scoped to ${projectIds.length} project${projectIds.length === 1 ? "" : "s"}; issue volume not yet scanned.`;
  }
  factors.push({ key: "reach", label: "Reach", weight: 0.4, value: round2(reach), detail: reachDetail });

  // 2. Cadence ──────────────────────────────────────────────────────────────
  const cadence = cadenceScore(summary.triggerType);
  factors.push({ key: "cadence", label: "Trigger cadence", weight: 0.15, value: round2(cadence.value), detail: cadence.detail });

  // 3. Writes ───────────────────────────────────────────────────────────────
  const writes = writeSeverity(summary);
  factors.push({ key: "writes", label: "Action weight", weight: 0.25, value: round2(writes.value), detail: writes.detail });

  // 4. Fan-out ──────────────────────────────────────────────────────────────
  const fanout = fanoutScore(summary, outDegree, inLoop);
  factors.push({ key: "fanout", label: "Fan-out", weight: 0.2, value: round2(fanout.value), detail: fanout.detail });

  let score = 100 * (0.4 * reach + 0.15 * cadence.value + 0.25 * writes.value + 0.2 * fanout.value);

  const modifiers = [];
  if (!summary.enabled) {
    score *= 0.35;
    modifiers.push({ key: "disabled", detail: "Rule is disabled; this is its latent blast radius if switched back on." });
  }
  const credential = (summary.risks || []).some((r) => r.code === "embedded-credential");
  if (credential && score < 55) {
    score = 55;
    modifiers.push({ key: "credential-floor", detail: "Stores a plaintext credential; the exposure alone makes this at least cross-project." });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const tier = tierForScore(score);

  return {
    ruleId: summary.id != null ? String(summary.id) : null,
    score,
    tier: tier.key,
    tierLabel: tier.label,
    estimated,
    credential,
    factors,
    modifiers,
  };
}

const TIER_KEYS = BLAST_TIERS.map((t) => t.key);

// Estate-level rollup: the tier histogram, plus the two numbers the site health score
// reads (how concentrated the estate is in estate-wide rules, and how many of those also
// carry a credential).
export function summarizeBlastRadius(entries = []) {
  const byTier = Object.fromEntries(TIER_KEYS.map((k) => [k, 0]));
  let estimatedCount = 0;
  let estateWideCredentialCount = 0;

  for (const entry of entries) {
    if (byTier[entry.tier] === undefined) byTier[entry.tier] = 0;
    byTier[entry.tier] += 1;
    if (entry.estimated) estimatedCount += 1;
    if (entry.tier === "estate" && entry.credential) estateWideCredentialCount += 1;
  }

  const total = entries.length;
  const estateWideCount = byTier.estate || 0;

  const top = [...entries]
    .sort((a, b) => b.score - a.score || String(a.ruleId).localeCompare(String(b.ruleId)))
    .slice(0, 20)
    .map((e) => ({ ruleId: e.ruleId, score: e.score, tier: e.tier }));

  return {
    available: total > 0,
    total,
    byTier,
    estateWideCount,
    estateWideShare: total > 0 ? estateWideCount / total : 0,
    estateWideCredentialCount,
    estimatedCount,
    top,
  };
}

export const BLAST_SCHEMA_VERSION = 1;

// The storable document. SQL-only, like cascades: one row per rule with its score, tier and
// the factor breakdown as JSON, so the drawer can explain a number without recomputing it.
export function buildBlastDocument(entries = []) {
  return {
    schemaVersion: BLAST_SCHEMA_VERSION,
    total: entries.length,
    summary: summarizeBlastRadius(entries),
    rules: entries
      .filter((e) => e.ruleId)
      .map((e) => ({
        id: e.ruleId,
        score: e.score,
        tier: e.tier,
        estimated: e.estimated ? 1 : 0,
        credential: e.credential ? 1 : 0,
        factors: e.factors,
        modifiers: e.modifiers,
      })),
  };
}
