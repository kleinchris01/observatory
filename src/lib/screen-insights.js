// The cross-signal: what a form contains, crossed with where values actually exist.
//
// The screen inventory answers "where can a person see or type this field". The field
// snapshot answers "where does this field hold values". Each is useful alone and neither
// can settle the question an admin is actually asking, because the same evidence supports
// opposite conclusions depending on the other half:
//
//   A field configured in forty projects with no data reads as abandoned -- unless it is on
//   no screen anywhere, in which case nobody was ever able to fill it. Not abandoned. Never
//   reachable.
//
//   A field with data and no obvious owner reads as safe to retire -- unless it is populated
//   in projects whose screens do not show it, which means something outside the UI is
//   writing it and removing the field breaks that thing silently.
//
// Crossing reachability with usage gives four states. Two of them are invisible to every
// other part of this app, and they are the two that matter:
//
//   ON A SCREEN + HAS DATA      working as intended
//   NOT ON A SCREEN + HAS DATA  INVISIBLE DATA -- a risk, and harder to remove safely, not
//                               easier. The finding most likely to cause an outage if the
//                               field is deleted on the other pillars' evidence.
//   ON A SCREEN + NO DATA       FORM CLUTTER -- asked of everyone filing an issue, answered
//                               by nobody. The finding that pays back fastest.
//   NOT ON A SCREEN + NO DATA   PROVABLY DORMANT -- the orphaned-field rule currently
//                               guesses this from contexts alone; screens turn the guess
//                               into evidence.
//
// Pure functions over rows already loaded, like workflow-insights.js and board-insights.js.
// No I/O, so the rules are testable without SQL or a Jira mock.

// A project whose screen chain was only partly read cannot support either claim.
//
// This is the load-bearing rule of the module, and it fails in the dangerous direction if
// it is dropped: a screen whose tab walk failed contributes no field rows, so every field
// in that project looks unreachable, and "unreachable but populated" is exactly the shape
// of the risk finding. Without this, a build that missed thirty screens would manufacture a
// page of invisible-data findings out of its own incompleteness.
export function resolvedProjectIds(coverage = []) {
  return new Set(
    coverage
      .filter((c) => Number(c.unresolvedScreens || 0) === 0 && Number(c.screenCount || 0) > 0)
      .map((c) => String(c.projectId))
  );
}

// (projectId, fieldId) -> { onCreate, onEdit, onView }, for O(1) lookup during the cross.
export function indexReachability(rows = []) {
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.projectId}|${row.fieldId}`, {
      onCreate: Boolean(row.onCreate),
      onEdit: Boolean(row.onEdit),
      onView: Boolean(row.onView),
    });
  }
  return map;
}

const FIELD_LABEL = (fields, fieldId) => fields?.get?.(String(fieldId))?.name || String(fieldId);

// Fields holding values in a project whose screens do not show them, under any operation.
//
// Reported as a RISK rather than a cleanup candidate, and the wording has to carry that:
// the reader's instinct on seeing "not on any screen" is that the field is unused, and here
// it means the opposite -- something is writing it that this app cannot see.
export function findInvisibleData({ usage = [], reachability, resolved, fields = null } = {}) {
  const out = new Map();

  for (const row of usage) {
    const projectId = String(row.projectId);
    // Unresolved chain, or a project with no screen chain at all. Neither can say "not on a
    // screen here", so neither contributes a finding.
    if (!resolved.has(projectId)) continue;
    if (reachability.has(`${projectId}|${row.fieldId}`)) continue;

    const fieldId = String(row.fieldId);
    if (!out.has(fieldId)) {
      out.set(fieldId, { fieldId, fieldName: FIELD_LABEL(fields, fieldId), projects: [], totalIssues: 0 });
    }
    const entry = out.get(fieldId);
    entry.projects.push({
      projectId,
      projectKey: row.projectKey || projectId,
      projectName: row.projectName || null,
      issueCount: Number(row.issueCount) || 0,
    });
    entry.totalIssues += Number(row.issueCount) || 0;
  }

  return [...out.values()]
    .map((e) => ({ ...e, projects: e.projects.sort((a, b) => b.issueCount - a.issueCount) }))
    .sort((a, b) => b.totalIssues - a.totalIssues || a.fieldName.localeCompare(b.fieldName));
}

// Fields on a project's CREATE screen that nobody there fills in.
//
// Create is not just another operation. It is the only one a person cannot skip, and the
// one where an extra twelve fields turns into an abandoned issue or a junk value -- so the
// cost of this finding is paid by everyone who files, every time, which is what makes it
// the fastest payback in the product.
//
// Scoped per project rather than site-wide on purpose: a field that works well in one
// project and is dead weight in five others should be removed from five screens, not
// deleted. Reporting it once, site-wide, would recommend the wrong remedy.
export function findFormClutter({
  reachability, usage = [], resolved, fields = null, maxIssues = 0,
} = {}) {
  const populated = new Set(
    usage.filter((u) => (Number(u.issueCount) || 0) > Number(maxIssues))
      .map((u) => `${u.projectId}|${u.fieldId}`)
  );

  const out = new Map();
  for (const [key, ops] of reachability) {
    if (!ops.onCreate) continue;
    const [projectId, fieldId] = key.split("|");
    if (!resolved.has(projectId)) continue;
    if (populated.has(key)) continue;

    if (!out.has(fieldId)) {
      out.set(fieldId, { fieldId, fieldName: FIELD_LABEL(fields, fieldId), projects: [], projectCount: 0 });
    }
    const entry = out.get(fieldId);
    entry.projects.push({ projectId });
    entry.projectCount += 1;
  }

  // Ranked by how many filing experiences carry the cost, which is the number of projects
  // asking for it -- not by the field's own properties.
  return [...out.values()].sort((a, b) => b.projectCount - a.projectCount || a.fieldName.localeCompare(b.fieldName));
}

// Fields that no project's screens reach at all, anywhere on the site.
//
// The third signal under the existing orphaned-field rule. That rule reads contexts and
// usage; this says whether a person could ever have filled the field through a form. A
// field with no context, no values AND no screen is not a guess any more.
export function findUnreachableFields({ reachability, fieldIds = [], fields = null } = {}) {
  const reachable = new Set();
  for (const key of reachability.keys()) reachable.add(key.split("|")[1]);

  return fieldIds
    .map(String)
    .filter((id) => !reachable.has(id))
    .map((id) => ({ fieldId: id, fieldName: FIELD_LABEL(fields, id) }))
    .sort((a, b) => a.fieldName.localeCompare(b.fieldName));
}

// One call for the tab and the health score, so both read the same numbers.
//
// `coverage` decides what may be claimed at all. When too little of the estate resolved,
// the findings are suppressed rather than computed against a partial left side -- the same
// rule the workflow insights follow when the scheme->status map is empty, and for the same
// reason: a confident wrong answer costs more than an absent one.
export function summarizeScreenFieldCross({
  reachabilityRows = [],
  coverage = [],
  usage = [],
  fieldIds = [],
  fields = null,
  usageTruncated = false,
  clutterMaxIssues = 0,
} = {}) {
  const reachability = indexReachability(reachabilityRows);
  const resolved = resolvedProjectIds(coverage);

  const projectsTotal = coverage.length;
  const projectsResolved = resolved.size;
  // Nothing resolved means nothing can be said. An empty reachability map with projects
  // present is a build that failed, not an estate with no screens.
  const available = projectsResolved > 0 && reachability.size > 0;

  if (!available) {
    return {
      available: false,
      reason: projectsTotal === 0
        ? "No screen inventory has been built yet, so no field can be crossed against it."
        : "No project's screen chain resolved completely in the last build, so reachability cannot be claimed for any of them.",
      projectsTotal,
      projectsResolved,
      usageTruncated,
      invisibleData: [],
      formClutter: [],
      unreachableFields: [],
    };
  }

  const invisibleData = findInvisibleData({ usage, reachability, resolved, fields });
  const formClutter = findFormClutter({ reachability, usage, resolved, fields, maxIssues: clutterMaxIssues });
  const unreachableFields = findUnreachableFields({ reachability, fieldIds, fields });

  // Denominators for the health score, counted here so the score and the tab divide by the
  // same thing. Both are deliberately narrow: a site with 700 fields and 40 populated ones
  // has 40 chances to hold invisible data, and dividing by the catalogue would report every
  // estate as spotless.
  const populatedFieldCount = new Set(usage.map((u) => String(u.fieldId))).size;
  let createPlacements = 0;
  for (const [key, ops] of reachability) {
    if (ops.onCreate && resolved.has(key.split("|")[0])) createPlacements += 1;
  }

  return {
    available: true,
    projectsTotal,
    projectsResolved,
    // Stated, not implied. Findings cover the resolved projects only, and a reader deciding
    // whether to act on "no invisible data" needs to know how much of the estate that "no"
    // was drawn from.
    coverageRate: projectsTotal > 0 ? projectsResolved / projectsTotal : 0,
    // The left side of the cross was capped. Both findings can only understate in that case,
    // which is the direction that gets acted on, so it travels with the result.
    usageTruncated,
    populatedFieldCount,
    createPlacements,
    invisibleData,
    formClutter,
    unreachableFields,
    counts: {
      invisibleFields: invisibleData.length,
      invisibleIssues: invisibleData.reduce((n, f) => n + f.totalIssues, 0),
      clutterFields: formClutter.length,
      // What the clutter actually costs: one field on ten create screens is ten filing
      // experiences carrying it, not one problem.
      clutterPlacements: formClutter.reduce((n, f) => n + f.projectCount, 0),
      unreachableFields: unreachableFields.length,
    },
  };
}
