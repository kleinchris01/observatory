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
  duplicateStatuses: 0.15,
  unreachableStatuses: 0.20,
  // Statuses only an automation rule reaches. Tighter than the unreachable bound: an
  // unreachable status is clutter, whereas one of these is a live process step that the
  // workflow does not document, and a handful of them is already a real divergence.
  ruleOnlyStatuses: 0.10,
  // A workflow rule or status property naming a field, group or role that no longer exists.
  // Tight, like the credential bound: each one is a transition that blocks or a check that
  // silently stopped checking, and a healthy site has none.
  brokenWorkflowRefs: 0.02,
  // Company-managed workflows no project-attached scheme uses. Clutter, so forgiving -- but
  // every one is a place a field or group reference rots unseen.
  inactiveWorkflows: 0.25,
  // Field schemes (or legacy field configurations and their schemes) no project uses.
  // Clutter, forgiving: a few kept as templates is normal.
  unusedFieldConfigs: 0.30,
  // Legacy only: configurations where a field is both required and hidden. A defect, not
  // untidiness -- every create or edit through that configuration fails -- so it is tight.
  requiredHiddenConfigs: 0.02,
  // Schemes or configurations identical to another: every change made twice.
  duplicateFieldConfigs: 0.20,
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
  // Rules whose blast radius is estate-wide -- site-scoped, broad trigger, mutating actions,
  // able to wake other rules. One or two is normal; a large share means a single misfire or
  // a single compromised author can move every project at once, and nobody has kept the
  // count. Scored between the credential and self-triggering bounds.
  estateWideRules: 0.06,
  // A scheme operation pointing at a screen the catalog does not contain. Tight, like the
  // credential bound: this is a broken mapping rather than an untidy one, and Jira falls
  // back silently when it resolves.
  danglingScreenRefs: 0.10,
  // Screens carrying no fields, or that no scheme routes to. Clutter, so it is forgiving --
  // but past a third of the catalog nobody can tell which screens are live.
  unusedScreens: 0.30,
  // Filters that are broken, exposed, or emailing from a search nobody opens. Between the
  // screen bounds and the automation ones: a filter owned by a deleted account takes its
  // boards and dashboards with it, which is worse than clutter and less immediate than a
  // credential sitting in plaintext.
  // Filters, one bound per rule. Ownership is the tightest: a filter without a live owner is
  // on a deletion timer, where an over-shared one is merely untidy.
  orphanedFilters: 0.05,
  overSharedFilters: 0.20,
  // Filters and dashboards shared globally -- readable by anonymous visitors on a site that
  // allows public access. A data-exposure fact, not untidiness, so the bound is tight: one in
  // fifty is already a bad day.
  publicShares: 0.02,
  // Dashboards with a gadget reading a deleted or unreachable filter. A visible break, not
  // untidiness -- everyone who opens it sees an error -- so the bound is tight.
  brokenGadgets: 0.05,
  zombieSubscriptions: 0.10,
  brokenFilterScope: 0.05,
  // Dashboards that are orphaned, editable by anyone, or empty. Looser than the filter bound:
  // a dashboard breaking is visible the moment somebody opens it, where a filter returns the
  // wrong answer silently and can be wrong for months.
  // Dashboards. Looser than their filter equivalents throughout: a dashboard breaking is
  // visible the moment somebody opens it, where a filter returns the wrong answer silently
  // and can be wrong for months.
  orphanedDashboards: 0.10,
  editableDashboards: 0.25,
  unusedDashboards: 0.35,
  emptyDashboards: 0.15,
  // The screen cross-signal. Two findings no single pillar can produce.
  //
  // invisibleData is the tightest tolerance on this list, and deliberately: a field holding
  // values in a project whose screens do not show it means something outside the UI writes
  // it, so deleting that field breaks an integration silently. It is a RISK rate, not a
  // tidiness one, and it is the finding most likely to cause an outage if acted on wrongly.
  //
  // formClutter is far more forgiving. Some create-screen fields are legitimately optional
  // and rarely used, and a site that flagged a third of its create fields would be told to
  // ignore the flag -- which costs the invisible-data finding its credibility too, since
  // they arrive together.
  invisibleData: 0.05,
  formClutter: 0.30,
  // Issue types. A type on no scheme cannot be created anywhere -- a broken state rather than
  // an untidy one, so it is tighter; a scheme assigned to no project is clutter, so it is the
  // most forgiving of the four. Near-duplicate type names sit where duplicate statuses do.
  orphanIssueTypes: 0.12,
  unusedTypeSchemes: 0.40,
  duplicateIssueTypeNames: 0.15,
  // Schemes whose type set does not hang together: sub-tasks enabled with no standalone
  // type to hang them off, or a default type that cannot be created on its own.
  brokenTypeHierarchy: 0.25,
  // People. A deactivated account still in an access group is a licence being paid for and
  // a login that should not exist -- tight. An orphaned filter/dashboard/rule is config
  // whose owner is gone; it still works until Jira garbage-collects it, so a touch looser.
  deactivatedLicenceHolders: 0.05,
  orphanedOwnership: 0.10,
  // Seats held by somebody who has not touched an issue in a year. Looser than the
  // deactivated-holder rule on purpose: a deactivated account still in an access group is
  // unambiguously wrong, where a quiet year can be a stakeholder who reads and approves
  // without ever being assignee or reporter. Real money either way, but the second needs a
  // conversation before it needs a revocation.
  dormantLicences: 0.15,
  // Assets (CMDB). A schema with nothing in it is clutter, forgiving like an unused issue
  // type scheme. A concrete object type nobody added an attribute to is unfinished, looser
  // still. A reference attribute pointing at a type that is gone is a broken pointer, tight
  // -- it is the Assets analogue of a filter scoped to a deleted project.
  deadAssetSchemas: 0.20,
  bareAssetTypes: 0.30,
  brokenAssetReferences: 0.10,
  // A type with attributes but zero objects ever created against it. As forgiving as a bare
  // type -- a newly modelled type legitimately sits empty until someone starts using it --
  // and only ever scored against the types the AQL crawl actually measured.
  emptyAssetTypes: 0.30,
  // Access schemes. An unused scheme of any kind is clutter -- forgiving. A security level
  // nobody is in is a data black hole, tight. A notification scheme routing to a named
  // individual is fragile but not dangerous.
  //
  // (Least-privilege moved to DEFAULT_HEALTH_TARGETS: it has a definable good state -- a
  // conformance rate to converge on -- rather than only a bad rate to stay under.)
  unusedAccessSchemes: 0.35,
  brokenSecurityLevels: 0.15,
  fragileNotificationSchemes: 0.30,
  // Project roles. A project whose admin role has no group or user in it can only be
  // administered by a site admin -- a real gap, bounded tight. An off-roster account still
  // sitting in a role is licence-adjacent cleanup.
  projectsWithoutRoleAdmin: 0.10,
  offRosterRoleActors: 0.05,
  // Global value lists. A duplicated resolution silently splits every resolution-based
  // report, so it is bounded fairly tight; priorities duplicate far less often and matter
  // less when they do.
  duplicateResolutions: 0.15,
  duplicatePriorities: 0.20,
  // Anything granted to anonymous users. Exposure, so as tight as the credential bound.
  publicPermissionSchemes: 0.02,
  // Delete, move, administer or edit-others granted to every logged-in user.
  everyoneSensitiveSchemes: 0.10,
  // Permission grants naming an individual instead of a role or group.
  directUserGrants: 0.10,
  // Grants, security-level members and notification recipients naming an account that has
  // left. Tight: each is access or mail pointing at nobody, and a clean site has none.
  departedAccounts: 0.02,
  // Security-level members who are named individuals.
  directSecurityMembers: 0.25,
  // Notification recipients that are raw email addresses, outside the directory.
  externalEmailRecipients: 0.02,
  // Project-role actors who are individuals rather than groups. Forgiving: small sites fill
  // roles person by person on purpose.
  directRoleActors: 0.60,
  // Project roles with nobody in them in any project.
  unusedRoles: 0.30,
  // Priorities or resolutions no issue carries.
  unusedEstateValues: 0.30,
  // Agile boards. Column hygiene (a column mapping no status, or one that has been removed)
  // drops issues off the board silently: worse than clutter, less immediate than a
  // wrong-scope board.
  //
  // (Broken backing filters moved to DEFAULT_HEALTH_TARGETS -- a board on a live filter is
  // the good state to hold at, weighted by the boards and dashboards that depend on it.)
  boardsColumnHygiene: 0.25,
  // Drift's churn rate. Loose, deliberately: this scores motion, not a defect, and a real
  // site reconfigures a meaningful slice of itself in any given month without anything
  // being wrong. It exists to flag the outlier pass where a fifth of the tracked estate
  // moved and nobody meant it to.
  configChurn: 0.20,
};

// Scoring model v2: dimensions with a definable good state.
//
// A tolerance answers "how bad is unacceptable". A target answers "what does good look
// like" -- and every metric here has one. `direction` says which way is good; `target` is
// where the dimension scores 100; `floor` is where it scores 0. `blast` names the currency
// the dimension's weight is scaled by (issues / users / dependents), or null for a plain
// weight.
//
// Admin-tunable, like the tolerances. Both target and floor are rates in [0,1] except where
// noted; the resolver enforces target ≠ floor and the right ordering for the direction.
export const DEFAULT_HEALTH_TARGETS = {
  // Permission schemes with no anyone-browse, no group-level project-admin, no named
  // individual. A conformance rate: >90% is the good state, <50% is a failing estate.
  leastPrivilegeConformance: { target: 0.9, floor: 0.5, direction: "up", blast: "users" },
  // Boards running on a live, owned backing filter. A board with a broken one shows every
  // issue in the site; weighted by the boards + dashboards that hang off those filters.
  boardBackingIntegrity: { target: 0.98, floor: 0.75, direction: "up", blast: "dependents" },
  // Share of workflow schemes that govern more than one project -- there is nothing to
  // standardise against on a site where every project has a bespoke scheme. >50% is the
  // good state; 0% means no shared process at all.
  schemeReuse: { target: 0.5, floor: 0, direction: "up", blast: "issues" },
  // Share of issue-security levels that have at least one member and belong to a scheme
  // with levels. An issue set to a level nobody is in is invisible -- near-total integrity
  // is the only acceptable state.
  securityLevelIntegrity: { target: 0.95, floor: 0.7, direction: "up", blast: "issues" },
  // Share of projects with roles that have a populated, group-based administrator role. A
  // project only a site admin can administer is a project nobody administers. This is the
  // People-domain flagship: >95% is the good state, <60% is a failing estate.
  adminRoleCoverage: { target: 0.95, floor: 0.6, direction: "up", blast: "dependents" },
  // Share of screens a user can actually reach through a scheme. Unreachable screens carry
  // no field load and route nothing; a high reachable ratio is the good state.
  screenReachability: { target: 0.95, floor: 0.6, direction: "up", blast: null },
};

// Same contract as resolveHealthTolerances: strict on type, ignore unknown keys, and fall
// back to the default for a value that would not survive the resolver's own validation --
// a bad config value should cost a tuned dimension, not the whole score.
export function resolveHealthTargets(overrides = {}) {
  const out = {};
  for (const [key, def] of Object.entries(DEFAULT_HEALTH_TARGETS)) {
    const o = overrides?.[key] || {};
    const target = typeof o.target === "number" && Number.isFinite(o.target) && o.target > 0 && o.target <= 1 ? o.target : def.target;
    const floor = typeof o.floor === "number" && Number.isFinite(o.floor) && o.floor >= 0 && o.floor <= 1 ? o.floor : def.floor;
    // If the pair the admin supplied is degenerate for this direction, keep the whole
    // default rather than a half-applied override.
    const ok = def.direction === "up" ? floor < target : floor > target;
    out[key] = ok ? { ...def, target, floor } : { ...def };
  }
  return out;
}

// ── Scoring model v2 ──────────────────────────────────────────────────────
//
// The original model scored one thing: a bad RATE against a FLOOR it bottomed out at
// (scoreFromRate). Three limits, each addressed here:
//
//   1. It only knew "bad" and "how bad is unacceptable". A metric like scheme reuse has a
//      GOOD state (>60%) to converge on, not just a bad one to stay under. scoreAgainstTarget
//      takes a target and a floor and a direction.
//   2. A dimension counted for its base weight regardless of how much of the estate it
//      actually touched. blastMultiplier scales a dimension's weight by consequence -- the
//      share of issues / users / dependents affected -- so the same finding rate on a bigger
//      blast radius moves the score more.
//   3. It was a snapshot. A site at 70% and climbing is not the same as 70% and sliding.
//      directionAdjust applies a small, capped, asymmetric nudge from the change since the
//      last scan, with regression penalised harder than improvement is rewarded.
//
// Both paths coexist: a dimension still on scoreFromRate is scored exactly as before.

// value -> score, against a definable good state.
//
//   direction "down": value <= target -> 100, value >= floor -> 0   (exposure, sprawl, defects)
//   direction "up"  : value >= target -> 100, value <= floor -> 0   (reuse, coverage, conformance)
//
// Linear between, like the rate model and for the same reason: the data does not support a
// curve. Returns null for an un-scoreable band so the caller can mark the dimension
// unavailable rather than invent a number.
export function scoreAgainstTarget(value, { target, floor, direction = "down" } = {}) {
  const v = Number(value);
  const t = Number(target);
  const f = Number(floor);
  if (!Number.isFinite(v) || !Number.isFinite(t) || !Number.isFinite(f) || t === f) return null;
  if (direction === "up") {
    if (f >= t) return null; // floor must sit below target for an "up" band
    if (v >= t) return 100;
    if (v <= f) return 0;
    return Math.round((100 * (v - f)) / (t - f));
  }
  if (f <= t) return null; // floor must sit above target for a "down" band
  if (v <= t) return 100;
  if (v >= f) return 0;
  return Math.round((100 * (f - v)) / (f - t));
}

// rate 0 -> 100, rate >= tolerance -> 0. Kept as a named helper because most dimensions
// still use it; it is now just the "down from zero" case of scoreAgainstTarget.
function scoreFromRate(rate, tolerance) {
  if (!Number.isFinite(rate) || rate <= 0) return 100;
  return scoreAgainstTarget(rate, { target: 0, floor: tolerance, direction: "down" }) ?? 0;
}

// How much a dimension counts, scaled by consequence rather than object count. `affected`
// is a count in one currency (issues, users, or dependents) and `estate` is the total in
// that same currency. A dimension touching nothing still counts (0.5x); one touching the
// whole estate counts double. Log-shaped like the automation blast-radius reach factor:
// one very large project already reads as high reach, not 3%.
export function blastMultiplier(affected, estate) {
  const a = Math.max(0, Number(affected) || 0);
  const e = Math.max(1, Number(estate) || 0);
  const reach = Math.min(1, Math.log1p(a) / Math.log1p(e));
  return Math.round((0.5 + 1.5 * reach) * 100) / 100; // 0.50 .. 2.00
}

// A capped nudge from movement since the last scan. `orientedDelta` is already signed so
// positive means "better". `scale` is how large a move counts as decisive -- the band
// width. Regression is penalised harder than improvement is rewarded, and neither can
// outweigh the level.
export const DIRECTION_MAX_BONUS = 6;
export const DIRECTION_MAX_PENALTY = 12;
export function directionAdjust(orientedDelta, scale) {
  const d = Number(orientedDelta);
  const s = Number(scale);
  if (!Number.isFinite(d) || d === 0 || !Number.isFinite(s) || s <= 0) return 0;
  const frac = Math.max(-1, Math.min(1, d / s));
  return Math.round(frac * (frac >= 0 ? DIRECTION_MAX_BONUS : DIRECTION_MAX_PENALTY));
}

// Build a v2 dimension: level scored against a target, weight scaled by blast radius, and
// (once there is a prior value) a directional adjustment folded into the score.
//
// `prior` is this dimension's `value` from the previous snapshot, or null on the first
// scan -- the directional term stays out until there is history to compare against.
export function targetDimension({
  key, label, pillar, weight = 1,
  value, target, floor, direction = "down",
  affected = null, estate = null, prior = null,
  detail, action = null,
}) {
  const level = scoreAgainstTarget(value, { target, floor, direction });
  if (level === null) {
    return unavailable(key, label, pillar, "This dimension's input was not collected.");
  }

  let score = level;
  let delta = null;
  let trend = "flat";
  if (prior !== null && prior !== undefined && Number.isFinite(Number(prior))) {
    const raw = Number(value) - Number(prior);
    delta = direction === "up" ? raw : -raw; // orient: positive is always better
    score = Math.max(0, Math.min(100, level + directionAdjust(delta, Math.abs(target - floor))));
    trend = delta > 0 ? "improving" : delta < 0 ? "worsening" : "flat";
  }

  const bw = affected !== null && estate !== null ? blastMultiplier(affected, estate) : 1;
  return {
    key, label, pillar,
    available: true,
    weight: Math.round(weight * bw * 100) / 100,
    baseWeight: weight,
    blastMultiplier: bw,
    score,
    level,
    value: Number(value),
    target: Number(target),
    floor: Number(floor),
    direction,
    affected: affected === null ? null : Number(affected),
    delta,
    trend,
    detail,
    action,
  };
}

// Every dimension carries the pillar it belongs to, so the overview can group thirteen bars
// into five readable blocks instead of one flat list. Grouping lives here rather than in the
// UI because the pillar is a property of what is being measured, and a second copy of the
// mapping in JSX would drift the first time a dimension is added.
function unavailable(key, label, pillar, reason) {
  return { key, label, pillar, available: false, score: null, reason };
}

// How much each pillar is worth to the headline.
//
// Declared, because until now it was emergent: the headline was a flat weighted mean over
// every dimension, so a pillar's influence was decided by how many rules somebody had got
// round to writing for it. Automation carried 27% of the score and dashboards 5% -- not
// because that was anyone's judgement about their relative importance, but because automation
// had four dimensions and dashboards had one.
//
// That also made the score hostile to its own governance page. Adding a fourth filter rule
// would have quietly quadrupled what filters were worth and taken that weight from everything
// else, which meant "add a rule" was never a local decision.
//
// With this, a pillar is worth what it says here regardless of how many rules it contains.
// Dimension weights still matter WITHIN a pillar -- automation security outranks automation
// hygiene -- they just no longer leak across pillar boundaries.
export const PILLAR_WEIGHTS = {
  // Plaintext credentials in an automation rule is the highest-consequence thing this app
  // finds anywhere, and it lives here.
  automation: 2,
  // Both shape what every user sees on every issue, every day.
  workflows: 1.5,
  fields: 1.5,
  screens: 1,
  projects: 1,
  // A filter fails silently and can be wrong for months; a dashboard fails visibly the moment
  // somebody opens it. Equal here because the pillar's own dimensions grade that difference.
  filters: 1,
  dashboards: 1,
  // Structural like screens: it decides what an issue can be, not how it behaves after.
  issueTypes: 1,
  // The who. Licence waste and orphaned ownership are real costs, but neither changes what
  // an issue does day to day, so it sits with the structural pillars, not above them.
  users: 1,
  // The CMDB's shape. Only relevant on a JSM Premium site, and it reports itself
  // not-applicable everywhere else rather than dragging the score down with unmeasured bars.
  assets: 1,
  // Who can do what, where. Permissions carries the most consequence of the three -- a
  // scheme that opens browse to anyone is a data-exposure fact, not a tidiness one -- so it
  // outweighs security and notifications.
  permissions: 1.5,
  security: 1,
  notifications: 0.5,
  // Who is in which project role. A project with an empty admin role is a real
  // administrability gap, so this weighs the same as issue security.
  roles: 1,
  // The global value lists. Small surface, low blast radius -- a naming-hygiene pillar, not
  // a correctness one.
  estate: 0.5,
  // Agile boards. Structural, like screens and issue types: a broken board changes what a
  // person sees on the wall every day, not what an issue is.
  boards: 1,
  // Rate of motion, not a defect count -- and the newest, least-understood signal in the
  // score. Same low weight as estate for the same reason: small surface, and a single
  // dimension pillar should not move the headline as much as one with a dozen.
  drift: 0.5,
  // What Jira enforces on each field per project: required, hidden, which fields a project
  // has at all. As structural as screens, and the half of a field's story screens do not tell.
  fieldConfigs: 1,
};

export const HEALTH_PILLARS = [
  { key: "fields", label: "Fields" },
  { key: "filters", label: "Filters" },
  { key: "dashboards", label: "Dashboards" },
  { key: "workflows", label: "Workflows and statuses" },
  { key: "screens", label: "Screens" },
  { key: "issueTypes", label: "Issue types" },
  { key: "fieldConfigs", label: "Field schemes" },
  { key: "users", label: "People" },
  { key: "assets", label: "Assets (CMDB)" },
  { key: "permissions", label: "Permission schemes" },
  { key: "security", label: "Issue security" },
  { key: "notifications", label: "Notification schemes" },
  { key: "roles", label: "Project roles" },
  { key: "estate", label: "Priorities and resolutions" },
  { key: "boards", label: "Boards" },
  { key: "automation", label: "Automation" },
  { key: "projects", label: "Projects" },
  { key: "drift", label: "Configuration drift" },
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

export function computeSiteHealth({ fieldUsage, workflow, projects, automation, screens, screenCross, adoption, filters, dashboards, issueTypes, users, assets, permissions, security, notifications, roles, estate, boards, drift, fieldConfigs, tolerances, targets, priorValues } = {}) {
  const TOLERANCE = resolveHealthTolerances(tolerances);
  const TARGET = resolveHealthTargets(targets);
  const dimensions = [];

  // The same dimension's `value` from the previous snapshot, for the directional term. A
  // plain object keyed by dimension key; missing / non-finite entries leave the directional
  // term out, which is the correct behaviour on the first scan and after a model change.
  const prior = (key) => {
    const v = priorValues && priorValues[key];
    return Number.isFinite(Number(v)) ? Number(v) : null;
  };

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

  // ── Filter hygiene ────────────────────────────────────────────────────────
  // Saved filters, as four rules rather than one.
  //
  // This was a single combined "filter hygiene" dimension, on the argument that every extra
  // dimension makes every existing one quieter. That argument was right about the arithmetic
  // and wrong about the fix: the dilution came from averaging dimensions across pillars, which
  // PILLAR_WEIGHTS now prevents. Splitting costs the rest of the score nothing, and buys four
  // separately tunable rules and four separately readable findings.
  //
  // Duplicates are still deliberately absent. They are the most numerous filter finding and
  // the least consequential, and at parity they were 70% of the combined rate -- a duplicate
  // counter wearing a governance label.
  const filterTotal = Number(filters?.total) || 0;
  if (filters?.available && filterTotal > 0) {
    const orphaned = Number(filters.orphanedCount) || 0;
    const exposed = Number(filters.sharedWithEveryoneCount) || 0;
    const zombie = Number(filters.subscribedButUnusedCount) || 0;
    const broken = Number(filters.brokenProjectCount) || 0;

    dimensions.push({
      key: "filter-ownership",
      label: "Filter ownership",
      pillar: "filters",
      available: true,
      // The heaviest of the four: Jira deletes a filter along with its owner, and every board
      // and dashboard built on it breaks at the same moment, with no warning to anyone.
      weight: 1.5,
      score: scoreFromRate(orphaned / filterTotal, TOLERANCE.orphanedFilters),
      detail: orphaned === 0
        ? `All ${filterTotal} saved filters have a live owner.`
        : `${orphaned} of ${filterTotal} filters have no live owner.`,
      action: orphaned > 0
        ? "Reassign these before the accounts are removed — the filter goes when the account does, and takes every board built on it."
        : null,
    });

    dimensions.push({
      key: "filter-exposure",
      label: "Filter exposure",
      pillar: "filters",
      available: true,
      weight: 1,
      score: scoreFromRate(exposed / filterTotal, TOLERANCE.overSharedFilters),
      detail: exposed === 0
        ? `No filter is shared with every logged-in user.`
        : `${exposed} of ${filterTotal} filters are shared with everyone.`,
      action: exposed > 0 ? "Confirm each is meant to be a site-wide search rather than a personal one shared once and forgotten." : null,
    });

    // Public is scored apart from logged-in sharing, and harder: one is staff seeing a search,
    // the other is the internet seeing the issues it returns.
    const publicFilters = Number(filters.sharedPubliclyCount) || 0;
    dimensions.push({
      key: "filter-public",
      label: "Public filters",
      pillar: "filters",
      available: true,
      weight: 1.5,
      score: scoreFromRate(publicFilters / filterTotal, TOLERANCE.publicShares),
      detail: publicFilters === 0
        ? "No filter is shared publicly."
        : `${publicFilters} of ${filterTotal} filters are shared publicly.`,
      action: publicFilters > 0
        ? "On a site that allows anonymous access, anyone with the link can run these and read every issue they return. Narrow each to a group, project or role."
        : null,
    });

    dimensions.push({
      key: "filter-subscriptions",
      label: "Filter subscriptions",
      pillar: "filters",
      available: true,
      weight: 1,
      score: scoreFromRate(zombie / filterTotal, TOLERANCE.zombieSubscriptions),
      detail: zombie === 0
        ? "Every subscribed filter is opened by someone."
        : `${zombie} of ${filterTotal} filters email a search nobody opens.`,
      action: zombie > 0 ? "Recurring mail from a filter nobody reads is what teaches people to filter Jira to trash." : null,
    });

    // Tri-state: the broken-scope rule needs the project catalog to join against. Without it
    // the answer is unknown, not zero -- "no filter names a missing project" is a claim, and
    // one nobody has established.
    if (filters.projectsChecked) {
      dimensions.push({
        key: "filter-scope",
        label: "Filter scope",
        pillar: "filters",
        available: true,
        weight: 1,
        score: scoreFromRate(broken / filterTotal, TOLERANCE.brokenFilterScope),
        detail: broken === 0
          ? `Every filter's project scope resolves.`
          : `${broken} of ${filterTotal} filters name a project that does not exist.`,
        action: broken > 0
          ? "These error rather than returning the wrong answer — the cheapest filter problem to fix and the easiest to prove."
          : null,
      });
    } else {
      dimensions.push(unavailable("filter-scope", "Filter scope", "filters",
        "Checking a filter's scope needs the project catalog. Run a scan so the two can be joined."));
    }
  } else {
    for (const [key, label] of [
      ["filter-ownership", "Filter ownership"],
      ["filter-exposure", "Filter exposure"],
      ["filter-public", "Public filters"],
      ["filter-subscriptions", "Filter subscriptions"],
      ["filter-scope", "Filter scope"],
    ]) {
      dimensions.push(unavailable(key, label, "filters",
        "No saved filter inventory yet. Build one from the Filters tab or run a full scan."));
    }
  }

  // ── Dashboards, as four rules rather than one ─────────────────────────────
  //
  // Split for the same reason as filters: the dilution that justified keeping this as one
  // combined dimension came from averaging across pillars, which PILLAR_WEIGHTS now prevents.
  const dashTotal = Number(dashboards?.total) || 0;
  if (dashboards?.available && dashTotal > 0) {
    const orphaned = Number(dashboards.orphanedCount) || 0;
    const editable = Number(dashboards.editableByEveryoneCount) || 0;
    const unused = Number(dashboards.publishedUnusedCount) || 0;
    const empty = dashboards.emptyCount;

    dimensions.push({
      key: "dashboard-ownership",
      label: "Dashboard ownership",
      pillar: "dashboards",
      available: true,
      // Heaviest of the four, and for the same reason as filter ownership: Jira deletes a
      // dashboard along with its owner.
      weight: 1.5,
      score: scoreFromRate(orphaned / dashTotal, TOLERANCE.orphanedDashboards),
      detail: orphaned === 0
        ? `All ${dashTotal} dashboards have a live owner.`
        : `${orphaned} of ${dashTotal} dashboards have no live owner.`,
      action: orphaned > 0
        ? "A wall-screen dashboard owned by somebody who left has a deletion date nobody has written down."
        : null,
    });

    dimensions.push({
      key: "dashboard-exposure",
      label: "Dashboard exposure",
      pillar: "dashboards",
      available: true,
      weight: 1,
      score: scoreFromRate(editable / dashTotal, TOLERANCE.editableDashboards),
      detail: editable === 0
        ? "No dashboard can be rearranged by any logged-in user."
        : `${editable} of ${dashTotal} dashboards can be rearranged by anyone.`,
      action: editable > 0
        ? "Anyone can rearrange these for everybody who uses them, and the owner is not told. Narrow the edit permission to a role or a group."
        : null,
    });

    const publicDashboards = Number(dashboards.sharedPubliclyCount) || 0;
    dimensions.push({
      key: "dashboard-public",
      label: "Public dashboards",
      pillar: "dashboards",
      available: true,
      weight: 1.5,
      score: scoreFromRate(publicDashboards / dashTotal, TOLERANCE.publicShares),
      detail: publicDashboards === 0
        ? "No dashboard is shared publicly."
        : `${publicDashboards} of ${dashTotal} dashboards are shared publicly.`,
      action: publicDashboards > 0
        ? "On a site that allows anonymous access, anyone with the link can open these. Share each with the group or project that uses it."
        : null,
    });

    // Only over dashboards whose gadget filters were actually probed: a snapshot from before
    // the probe has none, and "no broken gadgets" there would be a claim nobody checked.
    const probed = Number(dashboards.filterGadgetDashboards) || 0;
    if (probed > 0) {
      const broken = Number(dashboards.brokenGadgetCount) || 0;
      dimensions.push({
        key: "dashboard-gadget-filters",
        label: "Gadget filters",
        pillar: "dashboards",
        available: true,
        weight: 1,
        score: scoreFromRate(broken / probed, TOLERANCE.brokenGadgets),
        detail: broken === 0
          ? `Every filter behind a gadget, on ${probed} dashboards, can be read.`
          : `${broken} of ${probed} dashboards with filter gadgets show an error to most viewers: the filter is deleted, or private to its owner.`,
        action: broken > 0 ? "Point each broken gadget at a filter its viewers can read, or remove it." : null,
      });
    } else {
      dimensions.push(unavailable("dashboard-gadget-filters", "Gadget filters", "dashboards",
        "Rebuild the dashboard inventory to check whether each gadget's filter can still be read."));
    }

    dimensions.push({
      key: "dashboard-adoption",
      label: "Dashboard adoption",
      pillar: "dashboards",
      available: true,
      weight: 1,
      score: scoreFromRate(unused / dashTotal, TOLERANCE.unusedDashboards),
      detail: unused === 0
        ? "Every shared dashboard has been favourited by somebody."
        : `${unused} of ${dashTotal} dashboards are shared but favourited by nobody.`,
      // Popularity is a favourite count, not a view count, so this bounds a claim about
      // neglect rather than proving one -- and the action says so rather than implying the
      // dashboard is definitely unread.
      action: unused > 0
        ? "Favourites are the closest signal Jira gives to use. Not proof nobody opens these, but the place to start asking."
        : null,
    });

    // Tri-state. A pass that reached 180 of 200 dashboards can say which of those 180 are
    // empty and can say nothing about the other 20, so scoring the rate against the full total
    // would report a shortfall in the BUILD as a defect in the estate.
    if (empty !== null && empty !== undefined) {
      dimensions.push({
        key: "dashboard-content",
        label: "Dashboard content",
        pillar: "dashboards",
        available: true,
        weight: 1,
        score: scoreFromRate(Number(empty) / dashTotal, TOLERANCE.emptyDashboards),
        detail: Number(empty) === 0
          ? "Every dashboard carries at least one gadget."
          : `${empty} of ${dashTotal} dashboards carry no gadgets at all.`,
        action: Number(empty) > 0 ? "These render as an empty grid to anyone who opens them." : null,
      });
    } else {
      dimensions.push(unavailable("dashboard-content", "Dashboard content", "dashboards",
        "The gadget walk did not complete, so how many dashboards are empty is unknown."));
    }
  } else {
    for (const [key, label] of [
      ["dashboard-ownership", "Dashboard ownership"],
      ["dashboard-exposure", "Dashboard exposure"],
      ["dashboard-public", "Public dashboards"],
      ["dashboard-gadget-filters", "Gadget filters"],
      ["dashboard-adoption", "Dashboard adoption"],
      ["dashboard-content", "Dashboard content"],
    ]) {
      dimensions.push(unavailable(key, label, "dashboards",
        "No dashboard inventory yet. Build one from the Dashboards tab or run a full scan."));
    }
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

  // ── Field schemes / field configurations ──────────────────────────────────
  // Three dimensions over one stored summary. Each is scored only on what was measured: usage
  // needs no contents, duplicates and conflicts need the owner's fields to have been read.
  const fc = fieldConfigs?.available ? fieldConfigs : null;
  const fcModel = fc?.source === "field-configurations" ? "field configurations" : "field schemes";
  if (fc && Number(fc.usageJudged) > 0) {
    const unused = (Number(fc.unusedSchemes) || 0) + (Number(fc.unusedConfigs) || 0);
    dimensions.push({
      key: "fieldconfig-usage",
      label: "Field scheme usage",
      pillar: "fieldConfigs",
      available: true,
      weight: 1,
      score: scoreFromRate(unused / Number(fc.usageJudged), TOLERANCE.unusedFieldConfigs),
      detail: unused === 0
        ? `Every non-default ${fcModel === "field schemes" ? "field scheme" : "field configuration and scheme"} is used by a project.`
        : `${unused} of ${fc.usageJudged} non-default ${fcModel === "field schemes" ? "field schemes" : "field configurations and schemes"} are used by no project.`,
      action: unused > 0 ? "Delete the ones nobody uses from the Field schemes tab, keeping any held deliberately as templates." : null,
    });
  } else {
    dimensions.push(unavailable("fieldconfig-usage", "Field scheme usage", "fieldConfigs",
      fc ? "Only the default scheme exists, so there is nothing to judge." : "No field scheme inventory yet."));
  }

  if (fc && fc.source === "field-configurations" && Number(fc.conflictJudged) > 0) {
    const conflicts = Number(fc.requiredHiddenConfigs) || 0;
    dimensions.push({
      key: "fieldconfig-required-hidden",
      label: "Required but hidden fields",
      pillar: "fieldConfigs",
      available: true,
      weight: 1,
      score: scoreFromRate(conflicts / Number(fc.conflictJudged), TOLERANCE.requiredHiddenConfigs),
      detail: conflicts === 0
        ? "No field configuration requires a field it also hides."
        : `${conflicts} of ${fc.conflictJudged} field configurations require a field they also hide (${fc.requiredHiddenPairs} fields in all).`,
      action: conflicts > 0 ? "Nobody can fill in a hidden required field, so every create or edit through these configurations fails. Unhide it or make it optional." : null,
    });
  } else {
    dimensions.push(unavailable("fieldconfig-required-hidden", "Required but hidden fields", "fieldConfigs",
      !fc ? "No field scheme inventory yet."
        : fc.source === "field-schemes" ? "Field schemes cannot hide a required field, so this cannot happen on this site."
          : "No field configuration's contents could be read."));
  }

  if (fc && Number(fc.duplicateJudged) > 0) {
    const reducible = Number(fc.reducible) || 0;
    dimensions.push({
      key: "fieldconfig-duplicates",
      label: "Duplicate field schemes",
      pillar: "fieldConfigs",
      available: true,
      weight: 0.5,
      score: scoreFromRate(reducible / Number(fc.duplicateJudged), TOLERANCE.duplicateFieldConfigs),
      detail: reducible === 0
        ? `No two ${fcModel} are identical.`
        : `${reducible} ${fcModel} duplicate another exactly, across ${fc.duplicateGroups} groups.`,
      action: reducible > 0 ? "Point the projects on each duplicate at the one to keep, then delete the rest." : null,
    });
  } else {
    dimensions.push(unavailable("fieldconfig-duplicates", "Duplicate field schemes", "fieldConfigs",
      fc ? "No scheme's fields could be read, so duplicates cannot be judged." : "No field scheme inventory yet."));
  }

  // ── Workflow rule references ──────────────────────────────────────────────
  // Conditions, validators, post-functions and status properties that name a field, group or
  // role the site no longer has. Only scored once a build has read the rules: a snapshot that
  // predates rule capture would otherwise score as a site with no broken rules.
  const ruleIntegrity = workflow?.ruleIntegrity;
  if (workflow?.available && ruleIntegrity?.available && Number(ruleIntegrity.rules) > 0) {
    const broken = (Number(ruleIntegrity.brokenRules) || 0) + (Number(ruleIntegrity.brokenProperties) || 0);
    const rate = broken / Number(ruleIntegrity.rules);
    dimensions.push({
      key: "workflow-rule-references",
      label: "Workflow rule references",
      pillar: "workflows",
      available: true,
      weight: 1,
      score: scoreFromRate(rate, TOLERANCE.brokenWorkflowRefs),
      detail: broken === 0
        ? `Every field, group and role named by ${ruleIntegrity.rules} workflow rules still exists.`
        : `${broken} workflow rule${broken === 1 ? "" : "s"} or propert${broken === 1 ? "y names" : "ies name"} a field, group or role that no longer exists.`,
      action: broken > 0
        ? "A validator requiring a deleted field blocks the transition or stops checking. Repair or remove each one from the Workflows tab's Rules view."
        : null,
    });
  } else {
    dimensions.push(unavailable("workflow-rule-references", "Workflow rule references", "workflows",
      workflow?.available ? "Rebuild the workflow inventory to read transition rules." : "No workflow inventory yet."));
  }

  // ── Inactive workflows ────────────────────────────────────────────────────
  const companyManaged = (Number(ruleIntegrity?.workflows) || 0) - (Number(ruleIntegrity?.teamManaged) || 0);
  if (workflow?.available && ruleIntegrity?.available && companyManaged > 0) {
    const inactive = Number(ruleIntegrity.inactive) || 0;
    dimensions.push({
      key: "inactive-workflows",
      label: "Inactive workflows",
      pillar: "workflows",
      available: true,
      weight: 0.5,
      score: scoreFromRate(inactive / companyManaged, TOLERANCE.inactiveWorkflows),
      detail: inactive === 0
        ? "Every company-managed workflow is used by a project's scheme."
        : `${inactive} of ${companyManaged} company-managed workflows are used by no project's scheme.`,
      action: inactive > 0 ? "Delete inactive workflows you no longer need; each is configuration nobody sees." : null,
    });
  } else {
    dimensions.push(unavailable("inactive-workflows", "Inactive workflows", "workflows",
      workflow?.available ? "Rebuild the workflow inventory to list individual workflows." : "No workflow inventory yet."));
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
    const schemeCount = Number(workflow.schemeCount) || 0;
    const shared = Number(workflow.sharedSchemes) || 0;
    const sharedRatio = schemeCount > 0 ? shared / schemeCount : 0;
    dimensions.push(targetDimension({
      key: "standardisation",
      label: "Process standardisation",
      pillar: "workflows",
      weight: 1,
      value: sharedRatio,
      ...TARGET.schemeReuse,
      // Blast by issues under a bespoke (single-project) scheme, against every issue with a
      // status. No per-scheme issue count here yet, so approximate with the single-project
      // scheme share of the catalogue; a later pass swaps in the real issue tally.
      affected: schemeCount - shared,
      estate: schemeCount,
      prior: prior("standardisation"),
      detail: `${shared} of ${schemeCount} schemes govern more than one project.`,
      action: sharedRatio < 0.25
        ? "Most schemes are used by a single project, so there is little shared process to standardise against."
        : null,
    }));
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
  // Configuration standing over a project that carries NO work at all -- fields
  // configured, not one issue recorded. Either abandoned before it started or never
  // started, and the cheapest field cleanup on the site because there is nothing to lose.
  //
  // Staleness ("nothing touched in six months") used to be scored here too. It is not any
  // more: the project-adoption dimension below already grades a project that went quiet,
  // age-relative and with the decline month named, and a stale project is always old enough
  // for adoption to judge. Scoring both charged one abandoned project twice into the same
  // pillar. The stale-projects LIST still lives on the Projects tab; it is just not a
  // second score.
  if (totalProjects > 0) {
    const unused = Number(projects.unusedProjectCount) || 0;
    const rate = unused / totalProjects;
    dimensions.push({
      key: "project-activity",
      label: "Project activity",
      pillar: "projects",
      available: true,
      weight: 1,
      score: scoreFromRate(rate, TOLERANCE.inactiveProjects),
      detail: unused === 0
        ? `Every one of the ${totalProjects} projects carries at least some work.`
        : `${unused} of ${totalProjects} projects carry fields but no recorded work at all.`,
      action: unused > 0
        ? "Retiring fields from a project nobody has ever used costs nothing and is not reversible by accident."
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

  // ── Automation blast radius ───────────────────────────────────────────────
  // How concentrated the estate is in rules that can move every project at once. A separate
  // dimension from stability (which is about loops) and security (which is about secrets):
  // this is about how much sits behind a single point of failure. estateWideCount is null
  // on an analysis imported before blast scoring existed, so the dimension reports
  // unavailable rather than scoring a zero it cannot stand behind.
  const estateWideRules = Number(automation?.estateWideCount);
  if (automation?.available && automationRules > 0 && Number.isFinite(estateWideRules)) {
    const rate = estateWideRules / automationRules;
    const estateWideWithCredential = Number(automation.estateWideCredentialCount) || 0;
    dimensions.push({
      key: "automation-blast",
      label: "Automation blast radius",
      pillar: "automation",
      available: true,
      weight: 1.5,
      score: scoreFromRate(rate, TOLERANCE.estateWideRules),
      detail: estateWideRules === 0
        ? `No rule has an estate-wide blast radius across the ${automationRules} rules.`
        : `${estateWideRules} of ${automationRules} rules can move every project at once${estateWideWithCredential > 0 ? `, and ${estateWideWithCredential} of those also store a credential` : ""}.`,
      action: estateWideRules > 0
        ? "Scope what you can to specific projects, and review who can edit the ones that must stay site-wide."
        : null,
    });
  } else {
    dimensions.push(unavailable("automation-blast", "Automation blast radius", "automation", "No blast-radius analysis yet. Re-import the rule export."));
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

    // Reachability as its own dimension (v2 target): what share of readable screens a user
    // can actually arrive at through a scheme or a transition. Only scored when the workflow
    // inventory exists to answer it -- otherwise it is the same "unknown" screen-hygiene
    // already reports.
    if (reachKnown) {
      const reachable = (measuredScreens - unreached) / measuredScreens;
      dimensions.push(targetDimension({
        key: "screen-reachability",
        label: "Screen reachability",
        pillar: "screens",
        weight: 1,
        value: reachable,
        ...TARGET.screenReachability,
        prior: prior("screen-reachability"),
        detail: unreached === 0
          ? `Every one of the ${measuredScreens} readable screens is reachable through a scheme or a transition.`
          : `${unreached} of ${measuredScreens} readable screens are reached by neither a scheme nor a transition.`,
        action: unreached > 0
          ? "An unreachable screen routes nothing and carries no field load — the safest cleanup queue there is."
          : null,
      }));
    }
  } else {
    dimensions.push(unavailable("screen-hygiene", "Screen hygiene", "screens",
      screens?.available ? "No screen contents could be read." : "No screen inventory yet."));
  }

  // ── The screen cross-signal ───────────────────────────────────────────────
  //
  // Neither half of this is a new measurement: it is the screen inventory crossed with the
  // field usage the app already holds. It earns two dimensions because the two states it
  // finds are opposite in kind -- one is a risk that makes a field HARDER to remove, the
  // other is a cost everyone filing an issue pays -- and averaging them into one rate would
  // let a tidy create screen cancel out an integration nobody can see.
  //
  // Scored against the fields that actually have usage, not the whole catalogue. A site with
  // 700 fields and 40 populated ones has 40 chances to be wrong here, and dividing by 700
  // would report every estate as healthy.
  if (screenCross?.available) {
    const populatedFields = Math.max(1, Number(screenCross.populatedFieldCount) || 0);
    const invisible = Number(screenCross.counts?.invisibleFields) || 0;

    dimensions.push({
      key: "invisible-data",
      label: "Invisible data",
      pillar: "screens",
      available: true,
      weight: 1,
      score: scoreFromRate(invisible / populatedFields, TOLERANCE.invisibleData),
      detail: invisible === 0
        ? `Every populated field is reachable on a screen in the projects that hold its values.`
        : `${invisible} field(s) hold values in projects whose screens do not show them, across ${screenCross.counts.invisibleIssues} issues.`,
      action: invisible > 0
        ? "Something outside the UI is writing these — an importer, an integration or a rule. They are harder to remove safely than an unused field, not easier."
        : null,
    });

    // Denominator is placements, not fields: the same field on ten create screens is ten
    // filing experiences carrying it. A field-count rate would make a widely-placed
    // offender look identical to one on a single form.
    const judged = Number(screenCross.createPlacements) || 0;
    const placements = Math.max(1, judged);
    const clutter = Number(screenCross.counts?.clutterPlacements) || 0;

    // No placement the rule could judge -- field usage unreadable in full, or no project
    // measured -- is unmeasured, not a clean 100. A stored summary carries no flag, so zero
    // judged placements is the signal on both paths.
    if (screenCross.clutterAvailable === false || judged === 0) {
      dimensions.push(unavailable("form-clutter", "Form clutter", "screens",
        "Field usage could not be read in full, so no create-screen field can be called never filled."));
    } else dimensions.push({
      key: "form-clutter",
      label: "Form clutter",
      pillar: "screens",
      available: true,
      weight: 1,
      score: scoreFromRate(clutter / placements, TOLERANCE.formClutter),
      detail: clutter === 0
        ? "Every field on a create screen is filled in by somebody in that project."
        : `${clutter} of ${placements} create-screen placements are never filled in.`,
      action: clutter > 0
        ? "Create is the one form nobody can skip. Removing a field from the screens where it is never answered costs no data."
        : null,
    });
  } else {
    for (const [key, label] of [["invisible-data", "Invisible data"], ["form-clutter", "Form clutter"]]) {
      dimensions.push(unavailable(key, label, "screens",
        screenCross?.reason || "The screen inventory and the field snapshot have not both been built, so neither can be crossed against the other."));
    }
  }

  // ── Issue type reach ──────────────────────────────────────────────────────
  // Types the site defines that no scheme allows. A type on no scheme cannot be created in
  // any project -- it is inventory that does nothing, and every one is a line an admin
  // scrolls past looking for the ones that matter. Sub-tasks are still counted: a sub-task
  // type on no scheme is exactly as unreachable as a standard one.
  const totalIssueTypes = Number(issueTypes?.totalTypes) || 0;
  if (issueTypes?.available && totalIssueTypes > 0) {
    const orphans = Number(issueTypes.orphanTypeCount) || 0;
    dimensions.push({
      key: "issue-type-reach",
      label: "Issue type reach",
      pillar: "issueTypes",
      available: true,
      weight: 1.5,
      score: scoreFromRate(orphans / totalIssueTypes, TOLERANCE.orphanIssueTypes),
      detail: orphans === 0
        ? `All ${totalIssueTypes} issue types are allowed by at least one scheme.`
        : `${orphans} of ${totalIssueTypes} issue types are on no scheme — no project can create one.`,
      action: orphans > 0
        ? "Add each to the scheme that should own it, or delete it. An issue type nothing can use is pure clutter in every type picker."
        : null,
    });
  } else {
    dimensions.push(unavailable("issue-type-reach", "Issue type reach", "issueTypes", "No issue type inventory yet."));
  }

  // ── Issue type scheme usage ───────────────────────────────────────────────
  const totalTypeSchemes = Number(issueTypes?.totalSchemes) || 0;
  if (issueTypes?.available && totalTypeSchemes > 0) {
    const unused = Number(issueTypes.unusedSchemeCount) || 0;
    dimensions.push({
      key: "issue-type-scheme-usage",
      label: "Issue type scheme usage",
      pillar: "issueTypes",
      available: true,
      weight: 1,
      score: scoreFromRate(unused / totalTypeSchemes, TOLERANCE.unusedTypeSchemes),
      detail: unused === 0
        ? `Every one of the ${totalTypeSchemes} issue type schemes is assigned to a project.`
        : `${unused} of ${totalTypeSchemes} issue type schemes are assigned to no project.`,
      action: unused > 0
        ? "A scheme no project uses is a decision nobody made. Delete it, or find the project it was built for."
        : null,
    });
  } else {
    dimensions.push(unavailable("issue-type-scheme-usage", "Issue type scheme usage", "issueTypes", "No issue type inventory yet."));
  }

  // ── Issue type naming ─────────────────────────────────────────────────────
  // "Bug" and "Defect", "Task" and "Task " -- the same thing named twice, so a report that
  // groups by type splits its own data and nobody can tell which one to use. Scored where
  // duplicate statuses are.
  if (issueTypes?.available && totalIssueTypes > 0) {
    const removable = Number(issueTypes.reducibleTypeCount) || 0;
    dimensions.push({
      key: "issue-type-naming",
      label: "Issue type naming",
      pillar: "issueTypes",
      available: true,
      weight: 1,
      score: scoreFromRate(removable / totalIssueTypes, TOLERANCE.duplicateIssueTypeNames),
      detail: removable === 0
        ? "No near-duplicate issue type names."
        : `${removable} of ${totalIssueTypes} issue types duplicate another's name across ${issueTypes.duplicateTypeGroupCount} groups.`,
      action: removable > 0
        ? "Consolidate them in Jira's issue type admin — a split like Bug / Defect makes every by-type report wrong by however many issues sit on the wrong one."
        : null,
    });
  } else {
    dimensions.push(unavailable("issue-type-naming", "Issue type naming", "issueTypes", "No issue type inventory yet."));
  }

  // ── Issue type hierarchy ──────────────────────────────────────────────────
  // Schemes whose type set does not hold together: sub-tasks enabled with no standalone type
  // to attach them to, or a default type that is a sub-task (which cannot be created on its
  // own, so the create dialog opens on an option nobody can pick). A correctness problem,
  // like a workflow with no Done status.
  if (issueTypes?.available && totalTypeSchemes > 0) {
    const flagged = Number(issueTypes.hierarchyFlaggedSchemeCount) || 0;
    dimensions.push({
      key: "issue-type-hierarchy",
      label: "Issue type hierarchy",
      pillar: "issueTypes",
      available: true,
      weight: 1,
      score: scoreFromRate(flagged / totalTypeSchemes, TOLERANCE.brokenTypeHierarchy),
      detail: flagged === 0
        ? "Every scheme's type set hangs together."
        : `${flagged} of ${totalTypeSchemes} schemes have a broken type set — sub-tasks with no parent-level type, or an uncreatable default.`,
      action: flagged > 0
        ? "Add a standalone type, or change the default. A scheme with only sub-tasks cannot start an issue at all."
        : null,
    });
  } else {
    dimensions.push(unavailable("issue-type-hierarchy", "Issue type hierarchy", "issueTypes", "No issue type inventory yet."));
  }

  // ── Licence hygiene ───────────────────────────────────────────────────────
  // Accounts still in a Jira access group that Jira has deactivated. Every one is a seat
  // being paid for and a login that, if reactivated, comes back with its old access intact.
  const totalLicensed = Number(users?.totalUsers) || 0;
  if (users?.available && totalLicensed > 0) {
    const deactivated = Number(users.deactivatedUsers) || 0;
    dimensions.push({
      key: "user-licence-hygiene",
      label: "Licence hygiene",
      pillar: "users",
      available: true,
      weight: 1.5,
      score: scoreFromRate(deactivated / totalLicensed, TOLERANCE.deactivatedLicenceHolders),
      detail: deactivated === 0
        ? `All ${totalLicensed} licensed users have an active account.`
        : `${deactivated} of ${totalLicensed} accounts in a Jira access group are deactivated.`,
      action: deactivated > 0
        ? "Remove each from the access group. The seat frees up, and a reactivated account no longer returns with a licence nobody re-granted."
        : null,
    });
  } else {
    dimensions.push(unavailable("user-licence-hygiene", "Licence hygiene", "users",
      "No licensed-user roster yet. Build one from the People tab or run a full scan."));
  }

  // ── Ownership continuity ──────────────────────────────────────────────────
  // Filters, dashboards and automation rules whose owner is not in the licensed roster --
  // deleted or unlicensed accounts still holding site config. It works until Jira garbage-
  // collects the account, and then every board and dashboard built on it breaks at once.
  const ownedTotal = Number(users?.ownedArtifactTotal) || 0;
  if (users?.available && ownedTotal > 0) {
    const orphaned = Number(users.orphanedArtifacts) || 0;
    dimensions.push({
      key: "user-ownership",
      label: "Ownership continuity",
      pillar: "users",
      available: true,
      weight: 1,
      score: scoreFromRate(orphaned / ownedTotal, TOLERANCE.orphanedOwnership),
      detail: orphaned === 0
        ? `Every one of the ${ownedTotal} owned filters, dashboards and rules belongs to a licensed user.`
        : `${orphaned} of ${ownedTotal} owned filters, dashboards and rules belong to an account not in the roster.`,
      action: orphaned > 0
        ? "Reassign these before the accounts are purged — the filter or dashboard goes with the account, and every board built on it goes at the same moment."
        : null,
    });
  } else {
    dimensions.push(unavailable("user-ownership", "Ownership continuity", "users",
      users?.available
        ? "No filter, dashboard or automation ownership data to join against yet."
        : "No licensed-user roster yet. Build one from the People tab or run a full scan."));
  }

  // ── Dormant licences ─────────────────────────────────────────────────────
  //
  // The one dimension in the model with a currency figure behind it. Scored against the
  // accounts actually MEASURED, not the whole roster: an account the crawl never reached has
  // no activity date, and treating that silence as idleness would recommend revoking a seat
  // on the strength of a scan that did not look.
  if (users?.available && users.activityMeasured && Number(users.measuredAccounts) > 0) {
    const measured = Number(users.measuredAccounts);
    const dormant = Number(users.dormantAccounts) || 0;
    dimensions.push({
      key: "dormant-licences",
      label: "Dormant licences",
      pillar: "users",
      available: true,
      weight: 1,
      score: scoreFromRate(dormant / measured, TOLERANCE.dormantLicences),
      detail: dormant === 0
        ? `Every one of the ${measured} measured accounts has touched an issue in the last year.`
        : `${dormant} of ${measured} measured accounts hold a licence and have not touched an issue in a year.`,
      action: dormant > 0
        ? "The only finding here with a renewal cost attached. Confirm before revoking — an approver who never files still reads."
        : null,
    });
  } else {
    dimensions.push(unavailable("dormant-licences", "Dormant licences", "users",
      users?.available
        ? "No completed issue crawl has measured per-account activity yet, so no seat can be called idle."
        : "No user roster yet."));
  }

  // ── Assets (CMDB) ─────────────────────────────────────────────────────────
  // Only meaningful on a JSM Premium/Enterprise site. `assetsEnabled: false` is not a gap
  // in the data -- it is the correct answer for most sites -- so all three dimensions report
  // "not applicable" there rather than "not measured", and the roll-up drops the pillar
  // entirely rather than scoring it.
  const assetsNotApplicable = assets && assets.assetsEnabled === false;
  const assetSchemaTotal = Number(assets?.totalSchemas) || 0;
  if (assets?.available && assetSchemaTotal > 0) {
    const dead = Number(assets.deadSchemaCount) || 0;
    dimensions.push({
      key: "asset-schema-hygiene",
      label: "Schema hygiene",
      pillar: "assets",
      available: true,
      weight: 1,
      score: scoreFromRate(dead / assetSchemaTotal, TOLERANCE.deadAssetSchemas),
      detail: dead === 0
        ? `All ${assetSchemaTotal} object schemas contain object types and objects.`
        : `${dead} of ${assetSchemaTotal} object schemas have no object types or no objects.`,
      action: dead > 0
        ? "Delete or repopulate the empty schemas — each one is a namespace in every AQL autocomplete that resolves to nothing."
        : null,
    });
  } else {
    dimensions.push(unavailable("asset-schema-hygiene", "Schema hygiene", "assets",
      assetsNotApplicable
        ? "Assets (JSM Premium/Enterprise) is not enabled on this site."
        : "No Assets inventory yet. Build one from the Assets tab or run a full scan."));
  }

  const assetConcreteTypes = Number(assets?.concreteObjectTypes) || 0;
  if (assets?.available && assetConcreteTypes > 0) {
    const bare = Number(assets.bareTypeCount) || 0;
    dimensions.push({
      key: "asset-type-completeness",
      label: "Object type completeness",
      pillar: "assets",
      available: true,
      weight: 1,
      score: scoreFromRate(bare / assetConcreteTypes, TOLERANCE.bareAssetTypes),
      detail: bare === 0
        ? `Every one of the ${assetConcreteTypes} concrete object types carries at least one attribute someone added.`
        : `${bare} of ${assetConcreteTypes} concrete object types have no attribute beyond the built-in Name.`,
      action: bare > 0
        ? "Give each a defining attribute or retire it — a type with only a name records nothing about the thing it represents."
        : null,
    });
  } else {
    dimensions.push(unavailable("asset-type-completeness", "Object type completeness", "assets",
      assetsNotApplicable
        ? "Assets (JSM Premium/Enterprise) is not enabled on this site."
        : "No Assets inventory yet. Build one from the Assets tab or run a full scan."));
  }

  const assetRefTotal = Number(assets?.referenceAttributeCount) || 0;
  if (assets?.available && assetRefTotal > 0) {
    const broken = Number(assets.brokenReferenceCount) || 0;
    dimensions.push({
      key: "asset-reference-integrity",
      label: "Reference integrity",
      pillar: "assets",
      available: true,
      weight: 1.5,
      score: scoreFromRate(broken / assetRefTotal, TOLERANCE.brokenAssetReferences),
      detail: broken === 0
        ? `All ${assetRefTotal} object-reference attributes point at an object type that exists.`
        : `${broken} of ${assetRefTotal} object-reference attributes point at an object type that is gone.`,
      action: broken > 0
        ? "Repoint or remove them — the attribute still shows on every object of its type and resolves to nothing."
        : null,
    });
  } else {
    dimensions.push(unavailable("asset-reference-integrity", "Reference integrity", "assets",
      assetsNotApplicable
        ? "Assets (JSM Premium/Enterprise) is not enabled on this site."
        : assets?.available
          ? "No object-reference attributes to check."
          : "No Assets inventory yet. Build one from the Assets tab or run a full scan."));
  }

  // Real usage, not structure -- from the separate opt-in AQL crawl. Distinct from object
  // type completeness: that dimension asks whether a type has attributes, this one asks
  // whether it has ever been populated. Available only once the crawl has measured at least
  // one concrete type; an unmeasured type is excluded from the rate, never assumed empty.
  const assetMeasuredTypes = Number(assets?.measuredConcreteTypes) || 0;
  if (assets?.available && assets.countsMeasured && assetMeasuredTypes > 0) {
    const empty = Number(assets.emptyObjectTypeCount) || 0;
    dimensions.push({
      key: "asset-type-usage",
      label: "Object type usage",
      pillar: "assets",
      available: true,
      weight: 1,
      score: scoreFromRate(empty / assetMeasuredTypes, TOLERANCE.emptyAssetTypes),
      detail: empty === 0
        ? `Every one of the ${assetMeasuredTypes} measured object types holds at least one object.`
        : `${empty} of ${assetMeasuredTypes} measured object types have never had an object created against them.`,
      action: empty > 0
        ? "Populate them or retire them — a type nobody has ever put data into is either unfinished or abandoned."
        : null,
    });
  } else {
    dimensions.push(unavailable("asset-type-usage", "Object type usage", "assets",
      assetsNotApplicable
        ? "Assets (JSM Premium/Enterprise) is not enabled on this site."
        : !assets?.available
          ? "No Assets inventory yet. Build one from the Assets tab or run a full scan."
          : "Object counts have never been crawled. Run the object-count build from the Assets tab."));
  }

  // ── Access schemes: permission / issue-security / notification ─────────────
  // Three pillars, one scan stage. "No access inventory yet" is the unmeasured state for all
  // of them; each dimension scores a rate over its own scheme count.
  const noAccess = "No access inventory yet. Run a full scan to populate it.";
  // Off-roster checks need the People roster: without it every named account would read as
  // departed. Unmeasured, never scored, until the roster has been built.
  const noRoster = "Build the People roster (or run a full scan) to check for accounts that have left.";
  // A rate over a count that may be zero: nothing to judge reads as clean, not as 0/0.
  const rateOf = (n, d) => (d > 0 ? n / d : 0);

  // Permission schemes: least-privilege conformance (v2 target), then unused clutter.
  if (permissions?.available && permissions.totalSchemes > 0) {
    const risky = Number(permissions.riskySchemeCount) || 0;
    const total = Number(permissions.totalSchemes) || 0;
    const conformance = total > 0 ? (total - risky) / total : 1;
    dimensions.push(targetDimension({
      key: "permission-least-privilege",
      label: "Least privilege",
      pillar: "permissions",
      weight: 1.5,
      value: conformance,
      ...TARGET.leastPrivilegeConformance,
      // No "users under a risky scheme" count yet, so blast is scaled by scheme share --
      // still tells a 3-of-40 estate from a 30-of-40 one. A later pass swaps in the
      // affected-user count once the access overview carries it.
      affected: risky,
      estate: total,
      prior: prior("permission-least-privilege"),
      detail: risky === 0
        ? `All ${total} permission schemes keep least privilege — no anyone-browse, no group-level project admin, no named individuals.`
        : `${risky} of ${total} permission schemes grant browse to anyone, project admin to a whole group, or a permission to a named individual.`,
      action: risky > 0 ? "Replace direct and blanket grants with project roles; a permission held by an individual is a permission nobody reviews." : null,
    }));
    const unused = Number(permissions.unusedSchemeCount) || 0;
    dimensions.push({
      key: "permission-scheme-sprawl",
      label: "Scheme sprawl",
      pillar: "permissions",
      available: true,
      weight: 1,
      score: scoreFromRate(unused / permissions.totalSchemes, TOLERANCE.unusedAccessSchemes),
      detail: unused === 0
        ? `Every permission scheme is assigned to at least one project.`
        : `${unused} of ${permissions.totalSchemes} permission schemes are assigned to no project.`,
      action: unused > 0 ? "Delete the unused schemes — each is a decision nobody made that still shows in every scheme picker." : null,
    });

    // Public access. Also one of least privilege's reasons, scored on its own because exposure
    // to anonymous users is the consequence an admin is actually asked about.
    const publicSchemes = Number(permissions.publicSchemeCount) || 0;
    dimensions.push({
      key: "permission-public-access",
      label: "Public access",
      pillar: "permissions",
      available: true,
      weight: 1.5,
      score: scoreFromRate(rateOf(publicSchemes, total), TOLERANCE.publicPermissionSchemes),
      detail: publicSchemes === 0
        ? `No permission scheme grants anything to anonymous users.`
        : `${publicSchemes} of ${total} permission schemes grant a permission to anonymous users — anyone at all, on a site that allows public access.`,
      action: publicSchemes > 0 ? "Remove the grants to Anyone and give that access to a group or project role." : null,
    });

    const everyone = Number(permissions.loggedInSensitiveSchemeCount) || 0;
    dimensions.push({
      key: "permission-everyone-sensitive",
      label: "Sensitive grants to everyone",
      pillar: "permissions",
      available: true,
      weight: 1,
      score: scoreFromRate(rateOf(everyone, total), TOLERANCE.everyoneSensitiveSchemes),
      detail: everyone === 0
        ? `No permission scheme gives a sensitive permission (delete, move, administer, edit others' work) to every logged-in user.`
        : `${everyone} of ${total} permission schemes give a sensitive permission — delete, move, administer, edit others' work — to every logged-in user.`,
      action: everyone > 0 ? "Narrow those grants to the project roles that need them." : null,
    });

    const grants = Number(permissions.totalGrantCount) || 0;
    const direct = Number(permissions.directUserGrantCount) || 0;
    dimensions.push({
      key: "permission-direct-grants",
      label: "Grants to individuals",
      pillar: "permissions",
      available: true,
      weight: 1,
      score: scoreFromRate(rateOf(direct, grants), TOLERANCE.directUserGrants),
      detail: direct === 0
        ? `None of the ${grants} permission grants names an individual.`
        : `${direct} of ${grants} permission grants name an individual instead of a project role or group.`,
      action: direct > 0 ? "Move each to a project role; a permission held by one named person is one nobody reviews." : null,
    });

    if (permissions.rosterMeasured === false) {
      dimensions.push(unavailable("permission-departed-grants", "Grants to departed accounts", "permissions", noRoster));
    } else {
      const off = Number(permissions.offRosterUserGrantCount) || 0;
      dimensions.push({
        key: "permission-departed-grants",
        label: "Grants to departed accounts",
        pillar: "permissions",
        available: true,
        weight: 1,
        score: scoreFromRate(rateOf(off, direct), TOLERANCE.departedAccounts),
        detail: off === 0
          ? (direct === 0 ? `No permission is granted to an individual, so none to an account that has left.` : `None of the ${direct} grants to individuals names an account that has left.`)
          : `${off} permission grants name an account no longer on the licensed roster.`,
        action: off > 0 ? "Remove them. They grant nothing today and hide what the scheme really allows." : null,
      });
    }
  } else {
    dimensions.push(unavailable("permission-least-privilege", "Least privilege", "permissions", noAccess));
    dimensions.push(unavailable("permission-scheme-sprawl", "Scheme sprawl", "permissions", noAccess));
    dimensions.push(unavailable("permission-public-access", "Public access", "permissions", noAccess));
    dimensions.push(unavailable("permission-everyone-sensitive", "Sensitive grants to everyone", "permissions", noAccess));
    dimensions.push(unavailable("permission-direct-grants", "Grants to individuals", "permissions", noAccess));
    dimensions.push(unavailable("permission-departed-grants", "Grants to departed accounts", "permissions", noAccess));
  }

  // Issue security: data black holes, then unused clutter.
  if (security?.available && security.totalSchemes > 0) {
    const broken = Number(security.brokenLevelCount) || 0;
    const denom = Math.max(1, Number(security.totalLevels) || 0);
    const integrity = (denom - broken) / denom;
    dimensions.push(targetDimension({
      key: "security-level-integrity",
      label: "Level integrity",
      pillar: "security",
      weight: 1.5,
      value: integrity,
      ...TARGET.securityLevelIntegrity,
      affected: broken,
      estate: denom,
      prior: prior("security-level-integrity"),
      detail: broken === 0
        ? `Every one of the ${denom} security levels has members and every scheme has a level.`
        : `${broken} security levels have no members, or belong to a scheme with no levels — an issue set to one is invisible to everyone but a site admin.`,
      action: broken > 0 ? "Add members or delete the level. An empty security level is a way to lose an issue in plain sight." : null,
    }));
    const unused = Number(security.unusedSchemeCount) || 0;
    dimensions.push({
      key: "security-scheme-sprawl",
      label: "Scheme sprawl",
      pillar: "security",
      available: true,
      weight: 1,
      score: scoreFromRate(unused / security.totalSchemes, TOLERANCE.unusedAccessSchemes),
      detail: unused === 0
        ? `Every issue security scheme is assigned to a project.`
        : `${unused} of ${security.totalSchemes} issue security schemes are assigned to no project.`,
      action: unused > 0 ? "Delete the unused schemes." : null,
    });

    const members = Number(security.totalMemberCount) || 0;
    const userMembers = Number(security.userMemberCount) || 0;
    dimensions.push({
      key: "security-direct-members",
      label: "Levels held by individuals",
      pillar: "security",
      available: true,
      weight: 1,
      score: scoreFromRate(rateOf(userMembers, members), TOLERANCE.directSecurityMembers),
      detail: userMembers === 0
        ? `No security level names an individual; every member is a role, group or field.`
        : `${userMembers} of ${members} security level members are named individuals rather than a role or group.`,
      action: userMembers > 0 ? "Grant levels to project roles or groups; a level held by named people goes stale as people move." : null,
    });

    if (security.rosterMeasured === false) {
      dimensions.push(unavailable("security-departed-members", "Departed members", "security", noRoster));
    } else {
      const off = Number(security.offRosterMemberCount) || 0;
      dimensions.push({
        key: "security-departed-members",
        label: "Departed members",
        pillar: "security",
        available: true,
        weight: 1,
        score: scoreFromRate(rateOf(off, userMembers), TOLERANCE.departedAccounts),
        detail: off === 0
          ? `No security level names an account that has left.`
          : `${off} security level members are accounts no longer on the licensed roster.`,
        action: off > 0 ? "Remove them, and check the level still has someone who can see its issues." : null,
      });
    }
  } else {
    dimensions.push(unavailable("security-level-integrity", "Level integrity", "security", noAccess));
    dimensions.push(unavailable("security-scheme-sprawl", "Scheme sprawl", "security", noAccess));
    dimensions.push(unavailable("security-direct-members", "Levels held by individuals", "security", noAccess));
    dimensions.push(unavailable("security-departed-members", "Departed members", "security", noAccess));
  }

  // Notification schemes: fragile routing, then unused clutter.
  if (notifications?.available && notifications.totalSchemes > 0) {
    const fragile = Number(notifications.fragileSchemeCount) || 0;
    dimensions.push({
      key: "notification-routing",
      label: "Routing resilience",
      pillar: "notifications",
      available: true,
      weight: 1,
      score: scoreFromRate(fragile / notifications.totalSchemes, TOLERANCE.fragileNotificationSchemes),
      detail: fragile === 0
        ? `No notification scheme routes an event to a named individual.`
        : `${fragile} of ${notifications.totalSchemes} notification schemes send an event to a specific person — the notification stops silently the day they leave.`,
      action: fragile > 0 ? "Route to a project role or group instead of a named account." : null,
    });
    const unused = Number(notifications.unusedSchemeCount) || 0;
    dimensions.push({
      key: "notification-scheme-sprawl",
      label: "Scheme sprawl",
      pillar: "notifications",
      available: true,
      weight: 1,
      score: scoreFromRate(unused / notifications.totalSchemes, TOLERANCE.unusedAccessSchemes),
      detail: unused === 0
        ? `Every notification scheme is assigned to a project.`
        : `${unused} of ${notifications.totalSchemes} notification schemes are assigned to no project.`,
      action: unused > 0 ? "Delete the unused schemes." : null,
    });

    const recipients = Number(notifications.totalRecipientCount) || 0;
    const emails = Number(notifications.emailRecipientCount) || 0;
    dimensions.push({
      key: "notification-external-email",
      label: "Raw email recipients",
      pillar: "notifications",
      available: true,
      weight: 1.5,
      score: scoreFromRate(rateOf(emails, recipients), TOLERANCE.externalEmailRecipients),
      detail: emails === 0
        ? `No notification scheme sends to a raw email address.`
        : `${emails} of ${recipients} notification recipients are raw email addresses — outside the user directory, so issue content goes wherever that mailbox forwards, even after people leave.`,
      action: emails > 0 ? "Replace each address with a group or project role." : null,
    });

    if (notifications.rosterMeasured === false) {
      dimensions.push(unavailable("notification-departed-recipients", "Departed recipients", "notifications", noRoster));
    } else {
      const named = Number(notifications.namedUserRecipientCount) || 0;
      const off = Number(notifications.offRosterRecipientCount) || 0;
      dimensions.push({
        key: "notification-departed-recipients",
        label: "Departed recipients",
        pillar: "notifications",
        available: true,
        weight: 1,
        score: scoreFromRate(rateOf(off, named), TOLERANCE.departedAccounts),
        detail: off === 0
          ? `No notification goes to an account that has left.`
          : `${off} notification recipients are accounts no longer on the licensed roster — those events now reach nobody.`,
        action: off > 0 ? "Send those events to a project role or group instead." : null,
      });
    }
  } else {
    dimensions.push(unavailable("notification-routing", "Routing resilience", "notifications", noAccess));
    dimensions.push(unavailable("notification-scheme-sprawl", "Scheme sprawl", "notifications", noAccess));
    dimensions.push(unavailable("notification-external-email", "Raw email recipients", "notifications", noAccess));
    dimensions.push(unavailable("notification-departed-recipients", "Departed recipients", "notifications", noAccess));
  }

  // ── Project roles & actors ───────────────────────────────────────────────
  if (roles?.available && roles.projectsWithRoles > 0) {
    const withRoles = Number(roles.projectsWithRoles) || 0;
    const missing = Number(roles.projectsMissingAdminActorCount) || 0;
    const coverage = withRoles > 0 ? (withRoles - missing) / withRoles : 1;
    dimensions.push(targetDimension({
      key: "role-admin-coverage",
      label: "Admin coverage",
      pillar: "roles",
      weight: 1.5,
      value: coverage,
      ...TARGET.adminRoleCoverage,
      // Dependents: the projects left without a manageable admin role, against every project
      // that has roles at all.
      affected: missing,
      estate: withRoles,
      prior: prior("role-admin-coverage"),
      detail: missing === 0
        ? `Every project with roles has a group or user in its administrator role.`
        : `${missing} of ${withRoles} projects have nobody in any role that can administer them — only a site admin can.`,
      action: missing > 0 ? "Add a group to the project's administrator role; a project only a site admin can manage is a project nobody manages." : null,
    }));
    const off = Number(roles.offRosterActorCount) || 0;
    const denom = Math.max(1, Number(roles.directUserActorCount) || 0);
    if (roles.rosterMeasured === false) {
      // Without the roster every user actor read as departed: "Actor hygiene 0" on any site
      // that had not built People yet.
      dimensions.push(unavailable("role-actor-hygiene", "Actor hygiene", "roles", noRoster));
    } else dimensions.push({
      key: "role-actor-hygiene",
      label: "Actor hygiene",
      pillar: "roles",
      available: true,
      weight: 1,
      score: scoreFromRate(off / denom, TOLERANCE.offRosterRoleActors),
      detail: off === 0
        ? `No project-role actor is an account off the licensed roster.`
        : `${off} project-role actors are accounts no longer on the licensed roster.`,
      action: off > 0 ? "Remove the off-roster accounts from their project roles." : null,
    });

    const users = Number(roles.directUserActorCount) || 0;
    const groups = Number(roles.groupActorCount) || 0;
    dimensions.push({
      key: "role-group-actors",
      label: "Roles held by individuals",
      pillar: "roles",
      available: true,
      weight: 1,
      score: scoreFromRate(rateOf(users, users + groups), TOLERANCE.directRoleActors),
      detail: users === 0
        ? `Every project-role actor is a group.`
        : `${users} of ${users + groups} project-role actors are named individuals rather than groups.`,
      action: users > 0 ? "Fill roles with groups where you can; a group is one place to change membership, a person per project is many." : null,
    });

    const totalRoles = Number(roles.totalRoles) || 0;
    const emptyRoles = Number(roles.emptyRoleCount) || 0;
    dimensions.push({
      key: "role-unused",
      label: "Roles nobody holds",
      pillar: "roles",
      available: true,
      weight: 1,
      score: scoreFromRate(rateOf(emptyRoles, totalRoles), TOLERANCE.unusedRoles),
      detail: emptyRoles === 0
        ? `Every one of the ${totalRoles} project roles has someone in it somewhere.`
        : `${emptyRoles} of ${totalRoles} project roles have no user or group in any project.`,
      action: emptyRoles > 0 ? "Delete them, or take them out of permission schemes; a role nobody holds still appears in every picker." : null,
    });
  } else {
    dimensions.push(unavailable("role-admin-coverage", "Admin coverage", "roles", noAccess));
    dimensions.push(unavailable("role-actor-hygiene", "Actor hygiene", "roles", noAccess));
    dimensions.push(unavailable("role-group-actors", "Roles held by individuals", "roles", noAccess));
    dimensions.push(unavailable("role-unused", "Roles nobody holds", "roles", noAccess));
  }

  // ── Estate config: the global value lists ─────────────────────────────────
  // Near-duplicate names in a list Jira offers no scheme layer to contain. One dimension
  // per list; each scores what fraction of the list would disappear if every duplicate
  // group were collapsed to a single value.
  const noEstate = "No priorities/resolutions inventory yet. Run a full scan to populate it.";

  if (estate?.available && estate.totalResolutions > 0) {
    const removable = Number(estate.reducibleResolutionCount) || 0;
    dimensions.push({
      key: "resolution-naming",
      label: "Resolution naming",
      pillar: "estate",
      available: true,
      weight: 1,
      score: scoreFromRate(removable / estate.totalResolutions, TOLERANCE.duplicateResolutions),
      detail: removable === 0
        ? `None of the ${estate.totalResolutions} resolutions duplicate another.`
        : `${removable} of ${estate.totalResolutions} resolutions duplicate another — every resolution-based report is split across the synonyms.`,
      action: removable > 0 ? "Consolidate the duplicate resolutions; a report grouped by resolution is only as good as the list." : null,
    });
  } else {
    dimensions.push(unavailable("resolution-naming", "Resolution naming", "estate", noEstate));
  }

  if (estate?.available && estate.totalPriorities > 0) {
    const removable = Number(estate.reduciblePriorityCount) || 0;
    dimensions.push({
      key: "priority-naming",
      label: "Priority naming",
      pillar: "estate",
      available: true,
      weight: 1,
      score: scoreFromRate(removable / estate.totalPriorities, TOLERANCE.duplicatePriorities),
      detail: removable === 0
        ? `None of the ${estate.totalPriorities} priorities duplicate another.`
        : `${removable} of ${estate.totalPriorities} priorities duplicate another.`,
      action: removable > 0 ? "Consolidate the duplicate priorities." : null,
    });
  } else {
    dimensions.push(unavailable("priority-naming", "Priority naming", "estate", noEstate));
  }

  // Usage: values no issue carries. Only measured once the issue crawl has run.
  const noEstateUsage = "Usage comes from the issue crawl. Run a full scan to measure it.";
  for (const [key, label, totalKey, unusedKey, noun] of [
    ["priority-usage", "Priority usage", "totalPriorities", "unusedPriorityCount", "priorities"],
    ["resolution-usage", "Resolution usage", "totalResolutions", "unusedResolutionCount", "resolutions"],
  ]) {
    const count = Number(estate?.[totalKey]) || 0;
    if (!estate?.available || count === 0) {
      dimensions.push(unavailable(key, label, "estate", noEstate));
    } else if (!estate.usageMeasured) {
      dimensions.push(unavailable(key, label, "estate", noEstateUsage));
    } else {
      const unusedValues = Number(estate[unusedKey]) || 0;
      dimensions.push({
        key,
        label,
        pillar: "estate",
        available: true,
        weight: 1,
        score: scoreFromRate(rateOf(unusedValues, count), TOLERANCE.unusedEstateValues),
        detail: unusedValues === 0
          ? `Every one of the ${count} ${noun} is on at least one issue.`
          : `${unusedValues} of ${count} ${noun} are on no issue at all.`,
        action: unusedValues > 0 ? `Retire the unused ${noun}; each is an option people have to read past.` : null,
      });
    }
  }

  // Defaults: a list with no default makes every create choose, or leaves the value empty.
  if (estate?.available && (estate.totalPriorities > 0 || estate.totalResolutions > 0)) {
    const missing = [
      estate.prioritiesWithoutDefault && "priority",
      estate.resolutionsWithoutDefault && "resolution",
    ].filter(Boolean);
    dimensions.push({
      key: "estate-defaults",
      label: "Defaults set",
      pillar: "estate",
      available: true,
      weight: 0.5,
      score: 100 - 50 * missing.length,
      detail: missing.length === 0
        ? `Priorities and resolutions both have a default.`
        : `No default ${missing.join(" or ")} is set.`,
      action: missing.length ? `Set a default ${missing.join(" and ")}.` : null,
    });
  } else {
    dimensions.push(unavailable("estate-defaults", "Defaults set", "estate", noEstate));
  }

  // ── Agile boards ─────────────────────────────────────────────────────────
  // Boards break silently. A board on a deleted or absent backing filter falls back to
  // every issue in the site; one whose backing filter is owned by an inactive user is a
  // departure from the same failure. Column hygiene is the softer of the two -- a column
  // that maps no status, or one that has been removed, drops issues off the wall with no
  // error anywhere.
  const noBoards = "No board inventory yet. Run a full scan to populate it.";
  // Rates are over the boards whose configuration was read. A board Jira refused to show
  // (team-managed boards answer 404) was never checked, and counting it as clean let a site
  // full of unreadable boards score perfect board health.
  const boardsSeen = Number(boards?.total) || 0;
  const boardsUnread = Math.min(boardsSeen, Number(boards?.unreadable) || 0);
  const boardTotal = boards?.readable != null ? Math.max(0, Number(boards.readable) || 0) : boardsSeen;
  const unreadNote = boardsUnread > 0
    ? ` ${boardsUnread} more could not be read and are left out, not counted as healthy.`
    : "";
  const noReadableBoards = `None of the ${boardsSeen} boards' configuration could be read, so nothing was checked. Team-managed boards often refuse it.`;
  if (boards?.available && boardsSeen > 0 && boardTotal === 0) {
    dimensions.push(unavailable("board-backing", "Board backing filters", "boards", noReadableBoards));
    dimensions.push(unavailable("board-columns", "Board columns", "boards", noReadableBoards));
  } else if (boards?.available && boardTotal > 0) {
    const broken = (Number(boards.brokenBackingCount) || 0) + (Number(boards.inactiveFilterOwner) || 0);
    const integrity = (boardTotal - broken) / boardTotal;
    dimensions.push(targetDimension({
      key: "board-backing",
      label: "Board backing filters",
      pillar: "boards",
      weight: 1.5,
      value: integrity,
      ...TARGET.boardBackingIntegrity,
      // Dependents: the broken boards themselves plus the dashboards that sit on the same
      // filters, against every board on the site as the estate.
      affected: broken + (Number(boards.dependentDashboards) || 0),
      estate: boardTotal,
      prior: prior("board-backing"),
      detail: (broken === 0
        ? `All ${boardTotal} readable boards run on a live, owned backing filter.`
        : `${broken} of ${boardTotal} readable boards have no backing filter, name one that was deleted, or run on a filter whose owner is deactivated.`) + unreadNote,
      action: broken > 0
        ? "A board with no live backing filter shows every issue in the site. Repoint it, or reassign the filter before the account is removed."
        : null,
    }));

    const columnIssues = (Number(boards.staleColumnBoards) || 0) + (Number(boards.unmappedColumnBoards) || 0);
    dimensions.push({
      key: "board-columns",
      label: "Board columns",
      pillar: "boards",
      available: true,
      weight: 1,
      score: scoreFromRate(columnIssues / boardTotal, TOLERANCE.boardsColumnHygiene),
      detail: (columnIssues === 0
        ? `Every column on the ${boardTotal} readable boards maps at least one live status.`
        : `${columnIssues} of ${boardTotal} readable boards have a column that maps no status, or one that has been deleted.`) + unreadNote,
      action: columnIssues > 0
        ? "Issues in an unmapped or deleted status vanish from the board with no error. Fix the column mapping in the board's configuration."
        : null,
    });
  } else {
    dimensions.push(unavailable("board-backing", "Board backing filters", "boards", noBoards));
    dimensions.push(unavailable("board-columns", "Board columns", "boards", noBoards));
  }

  // ── Configuration drift ────────────────────────────────────────────────────
  // The exception among these dimensions: it does not score a defect. Structural change is
  // neither good nor bad on its own, so this scores a rate of MOTION -- what fraction of the
  // tracked estate moved in the trailing window. A high rate does not say something broke; it
  // says an admin looking at the estate right now is looking at a moving target, which is
  // itself worth surfacing before it is investigated further on the Changes tab.
  const noDrift = "No drift snapshot yet. Run a drift pass to start tracking configuration change.";
  if (drift?.available && drift.trackedEntities > 0) {
    const rate = drift.changesInWindow / drift.trackedEntities;
    dimensions.push({
      key: "config-churn",
      label: "Configuration churn",
      pillar: "drift",
      available: true,
      weight: 1,
      score: scoreFromRate(rate, TOLERANCE.configChurn),
      detail: drift.changesInWindow === 0
        ? `No tracked configuration changed in the last ${drift.windowDays} days.`
        : `${drift.changesInWindow} of ${drift.trackedEntities} tracked configuration entities changed in the last ${drift.windowDays} days.`,
      action: rate > TOLERANCE.configChurn
        ? "Review the Changes tab for what moved recently and confirm it was deliberate."
        : null,
    });
  } else {
    dimensions.push(unavailable("config-churn", "Configuration churn", "drift", noDrift));
  }

  // ── Roll-up ───────────────────────────────────────────────────────────────
  const scored = dimensions.filter((d) => d.available);
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

  // The headline: a weighted mean over PILLARS, not over dimensions.
  //
  // Averaging dimensions directly meant a pillar's influence tracked its rule count. This
  // averages each pillar's own score, weighted by what that pillar is declared to be worth,
  // so the number of rules inside a pillar changes how precisely it is measured and not how
  // much it counts.
  //
  // Pillars with nothing measured are excluded rather than scored zero -- the same rule every
  // dimension already follows, applied one level up. A site with no dashboard inventory is not
  // a site with bad dashboards.
  const scoredPillars = pillars.filter((p) => p.available && p.score !== null);
  const pillarWeight = scoredPillars.reduce((sum, p) => sum + (PILLAR_WEIGHTS[p.key] ?? 1), 0);
  const score = pillarWeight > 0
    ? Math.round(
        scoredPillars.reduce((sum, p) => sum + p.score * (PILLAR_WEIGHTS[p.key] ?? 1), 0) / pillarWeight
      )
    : null;

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
