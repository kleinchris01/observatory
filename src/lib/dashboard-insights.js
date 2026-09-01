// Governance findings over the site's dashboards.
//
// A dashboard is the most visible thing in Jira and the least owned. It is what somebody
// puts on a wall screen, links in a status report, and never opens again -- and it is the
// end of a dependency chain nobody can see from either end: a gadget reads a filter, the
// filter searches a field, and deleting the field breaks the dashboard three steps later
// with no error at any of them.
//
// This module covers the dashboard's own health. The middle link -- which filter each gadget
// reads -- is not available without a per-gadget property fetch, and dashboard-engine.js says
// why that is deferred rather than guessed at.
//
// Pure functions over already-loaded rows, like filter-insights.js: no I/O, so the resolver
// decides what to load and this decides what it means.

// Share permission types that mean "everyone". Same set filters use, and for the same reason:
// Jira has spelled this three ways over time and all three still appear in payloads.
const EVERYONE_TYPES = new Set(["global", "authenticated", "loggedin"]);

// A dashboard with no gadgets renders as an empty grid. Not a defect on its own -- somebody
// may be mid-build -- which is why it is reported as cleanup rather than as a problem.
export const EMPTY_DASHBOARD_GADGETS = 0;

export function isSharedWithEveryone(shares = []) {
  return shares.some((share) => EVERYONE_TYPES.has(String(share?.type || "").toLowerCase()));
}

// Editable by everyone, which is a different and sharper claim than readable by everyone.
//
// A dashboard anyone can VIEW is usually intended. A dashboard anyone can EDIT is a shared
// document with no owner in practice: the next person to rearrange it does so for everybody,
// and the person whose name is on it will not know.
export function isEditableByEveryone(editShares = []) {
  return editShares.some((share) => EVERYONE_TYPES.has(String(share?.type || "").toLowerCase()));
}

// Same tri-state the filter pillar uses, and it matters more here.
//
// Jira deletes a dashboard with its owner, exactly as it deletes a filter -- so a dashboard
// on a wall screen owned by somebody who left has a deletion date nobody has written down.
export function classifyOwner(dashboard) {
  if (!dashboard?.owner) return "missing";
  if (dashboard.owner.active === false) return "inactive";
  return "active";
}

// One dashboard's findings, ordered most consequential first.
//
// Each carries the evidence rather than a verdict, the same shape analyzeFilter and
// analyzeRuleRisks use.
export function analyzeDashboard(dashboard) {
  const findings = [];
  const ownerState = classifyOwner(dashboard);
  const gadgetCount = Number(dashboard?.gadgetCount) || 0;
  // null means the gadget walk did not reach this dashboard. Distinct from zero, and the
  // difference decides whether "empty" is a claim we are entitled to make.
  const gadgetsKnown = dashboard?.gadgetCount !== null && dashboard?.gadgetCount !== undefined;
  const popularity = Number(dashboard?.popularity) || 0;

  if (ownerState === "missing" || ownerState === "inactive") {
    findings.push({
      code: "orphaned-owner",
      // Weighted by blast radius rather than by owner state alone: a dashboard fifty people
      // have favourited disappearing is a different event from a private one doing so.
      severity: popularity >= 5 ? "high" : "medium",
      detail: ownerState === "missing"
        ? "The owning account no longer exists. Jira deletes a dashboard with its owner, and anything linking to it breaks at the same moment."
        : "Owned by a deactivated account. It still works, and disappears if that account is ever deleted.",
    });
  }

  if (isEditableByEveryone(dashboard?.editShares)) {
    findings.push({
      code: "editable-by-everyone",
      severity: "medium",
      detail: "Any logged-in user can rearrange this dashboard for everybody who uses it, and the owner will not be told.",
    });
  }

  if (isSharedWithEveryone(dashboard?.shares) && popularity === 0) {
    // Shared with the whole site and favourited by nobody. Either is unremarkable alone;
    // together they describe a dashboard published to everyone that nobody wanted.
    findings.push({
      code: "published-unused",
      severity: "low",
      detail: "Shared with every logged-in user and favourited by nobody.",
    });
  }

  if (gadgetsKnown && gadgetCount === EMPTY_DASHBOARD_GADGETS) {
    findings.push({
      code: "empty",
      severity: "low",
      detail: "No gadgets. Anyone opening this sees an empty grid.",
    });
  }

  return findings;
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

// Everything the pillar reports, as rates rather than counts.
//
// Same rule the rest of the score follows: a site with 400 dashboards and 20 orphans is
// tidier than one with 40 dashboards and 20 orphans, and counting would rank them backwards.
export function summarizeDashboards(dashboards = []) {
  const analyzed = dashboards.map((dashboard) => ({
    ...dashboard,
    findings: analyzeDashboard(dashboard),
  }));

  const has = (dashboard, code) => dashboard.findings.some((f) => f.code === code);
  // Whether the gadget walk reached everything. A partial walk can still say a dashboard HAS
  // gadgets; it cannot say one has none, so the empty count is suppressed rather than
  // under-reported.
  const gadgetsKnown = dashboards.length > 0 && dashboards.every((d) => d.gadgetCount !== null && d.gadgetCount !== undefined);

  const withFindings = analyzed
    .filter((dashboard) => dashboard.findings.length > 0)
    .sort((a, b) =>
      SEVERITY_ORDER[a.findings[0].severity] - SEVERITY_ORDER[b.findings[0].severity]
      || (Number(b.popularity) || 0) - (Number(a.popularity) || 0)
      || String(a.name).localeCompare(String(b.name)));

  return {
    // Tri-state, like every other pillar: no snapshot is "not measured", never "no dashboards".
    available: dashboards.length > 0,
    total: dashboards.length,
    orphanedCount: analyzed.filter((d) => has(d, "orphaned-owner")).length,
    editableByEveryoneCount: analyzed.filter((d) => has(d, "editable-by-everyone")).length,
    publishedUnusedCount: analyzed.filter((d) => has(d, "published-unused")).length,
    emptyCount: gadgetsKnown ? analyzed.filter((d) => has(d, "empty")).length : null,
    gadgetsKnown,
    totalGadgets: dashboards.reduce((sum, d) => sum + (Number(d.gadgetCount) || 0), 0),
    // What people actually use, so the findings above have something to be read against.
    favouritedCount: dashboards.filter((d) => (Number(d.popularity) || 0) > 0).length,
    dashboards: withFindings,
  };
}

// The counts the site health score takes from this pillar.
//
// computeSiteHealth scores four separate dashboard dimensions -- ownership, exposure,
// adoption, content -- straight from these raw counts against their own tolerances, and
// reads the content dimension's tri-state off `emptyCount` being null. The combined
// `defectRate` this used to compute was a leftover from when dashboards were one dimension;
// nothing read it after the split, so it is gone rather than left as a number with no
// consumer and a weighting comment for a trade-off that no longer applies.
export function summarizeDashboardHealth(summary) {
  if (!summary?.available) return { available: false };

  return {
    available: true,
    total: summary.total,
    orphanedCount: summary.orphanedCount,
    editableByEveryoneCount: summary.editableByEveryoneCount,
    emptyCount: summary.emptyCount,
    publishedUnusedCount: summary.publishedUnusedCount,
  };
}
