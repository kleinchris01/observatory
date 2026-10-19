// Governance findings over the issue type snapshot: types nothing can create, schemes
// nobody uses, near-duplicate names, and schemes whose type set does not hold together.
//
// Pure functions over already-loaded rows, like workflow-insights.js: no I/O, so the caller
// decides what to load and this decides what it means. The name-dedup borrows
// workflow-insights' status logic wholesale -- an issue type name is the same kind of short
// human label, and "Bug"/"Defect" splits a report exactly the way "Back Log"/"Backlog" does.

import { normalizeStatusName, editDistanceWithin } from "./workflow-insights.js";

// Issue type names collapse like status names: every separator is noise ("Sub Task" ==
// "Sub-task" == "subtask"), so normalization strips them rather than mapping to a space.
export const normalizeTypeName = normalizeStatusName;

// A pair one edit apart is a spelling variant only when it is not a deliberate series --
// "Bug L1" / "Bug L2" are one edit apart and distinct. Below eight characters a single char
// is usually meaning, not a typo. Same rule the status pillar uses.
const MIN_SPELLING_LENGTH = 8;
function isSpellingVariant(a, b) {
  if (Math.min(a.length, b.length) < MIN_SPELLING_LENGTH) return false;
  if (a.replace(/\d/g, "") === b.replace(/\d/g, "")) return false;
  return editDistanceWithin(a, b, 1) <= 1;
}

// Issue types that are almost certainly the same thing, grouped so an admin can consolidate.
//
// "identical" -- the same literal name more than once, which happens across project-scoped
// types and is duplication by definition. "spacing" -- one normalized key, different raw
// names. "spelling" -- distinct normalized keys within one edit. Ordered by size so the
// worst offender leads.
export function findDuplicateTypeNames(types = []) {
  const byNormalized = new Map();
  for (const type of types) {
    if (!type?.name) continue;
    const key = normalizeTypeName(type.name);
    if (!key) continue;
    if (!byNormalized.has(key)) byNormalized.set(key, []);
    byNormalized.get(key).push(type);
  }

  const groups = [];
  const consumed = new Set();

  for (const [key, members] of byNormalized) {
    if (members.length < 2) continue;
    consumed.add(key);
    const rawNames = new Set(members.map((t) => t.name));
    groups.push({
      key,
      kind: rawNames.size === 1 ? "identical" : "spacing",
      types: members,
      count: members.length,
    });
  }

  const remaining = [...byNormalized.keys()].filter((k) => !consumed.has(k)).sort();
  for (let i = 0; i < remaining.length; i++) {
    const a = remaining[i];
    if (consumed.has(a)) continue;
    const cluster = [a];
    for (let j = i + 1; j < remaining.length; j++) {
      const b = remaining[j];
      if (consumed.has(b)) continue;
      if (Math.abs(a.length - b.length) > 1) continue;
      if (isSpellingVariant(a, b)) {
        cluster.push(b);
        consumed.add(b);
      }
    }
    if (cluster.length < 2) continue;
    consumed.add(a);
    groups.push({
      key: a,
      kind: "spelling",
      types: cluster.flatMap((k) => byNormalized.get(k)),
      count: cluster.reduce((sum, k) => sum + byNormalized.get(k).length, 0),
    });
  }

  return groups.sort((l, r) => r.count - l.count || l.key.localeCompare(r.key));
}

// Issue types on no scheme at all. Present in the catalog, allowed by nothing, so no project
// can ever create one. `schemeItems` is the flat (schemeId, issueTypeId) membership list.
export function findOrphanTypes(types = [], schemeItems = []) {
  const allowed = new Set(schemeItems.map((it) => String(it.issueTypeId)));
  return types
    .filter((t) => !allowed.has(String(t.id)))
    .map((t) => ({
      id: String(t.id),
      name: t.name,
      subtask: Boolean(t.subtask),
      scopeProjectId: t.scopeProjectId ?? null,
    }))
    .sort((l, r) => String(l.name).localeCompare(String(r.name)));
}

// Per-scheme structural flags on the type set.
//
// `membersByScheme` maps schemeId -> [{ id, subtask, hierarchyLevel }]. Two things break a
// scheme: sub-tasks with no standalone type to attach them to (an issue cannot be started at
// all), and a default type that is a sub-task or is not in the scheme's own member list (the
// create dialog opens on an option that cannot be picked). Conservative on purpose -- a
// scheme with a handful of edge cases is not flagged, only ones that genuinely cannot be
// used as configured.
export function analyzeSchemeHierarchy(schemes = [], membersByScheme = new Map()) {
  return schemes
    .map((scheme) => {
      const members = membersByScheme.get(String(scheme.schemeId)) || [];
      const memberIds = new Set(members.map((m) => String(m.id)));
      const standalone = members.filter((m) => !m.subtask);
      const subtasks = members.filter((m) => m.subtask);

      const flags = [];
      if (members.length > 0 && subtasks.length > 0 && standalone.length === 0) {
        flags.push({
          code: "subtasks-only",
          message: "Only sub-task types — no issue can be created in this scheme without a parent that does not exist.",
        });
      }
      const def = scheme.defaultIssueTypeId != null ? String(scheme.defaultIssueTypeId) : null;
      if (def) {
        const defMember = members.find((m) => String(m.id) === def);
        if (!memberIds.has(def)) {
          flags.push({
            code: "default-not-in-scheme",
            message: "The default issue type is not one this scheme allows.",
          });
        } else if (defMember?.subtask) {
          flags.push({
            code: "default-is-subtask",
            message: "The default issue type is a sub-task, which cannot be created on its own.",
          });
        }
      }

      return { schemeId: String(scheme.schemeId), name: scheme.name, projectCount: scheme.projectCount ?? 0, flags };
    })
    .sort((l, r) => r.flags.length - l.flags.length || String(l.name).localeCompare(String(r.name)));
}

// Everything the pillar reports, as counts a rate can be built from.
//
// `schemes` carry { schemeId, name, defaultIssueTypeId, projectCount }. `schemeItems` is the
// flat membership list. `types` is the catalog.
// `listLimit` trims the per-item lists for the tab; remediation passes Infinity.
export function summarizeIssueTypeInsights({ types = [], schemes = [], schemeItems = [], listLimit = null } = {}) {
  const cap = (n) => (listLimit == null ? n : listLimit);
  const typesById = new Map(types.map((t) => [String(t.id), t]));
  const membersByScheme = new Map();
  for (const item of schemeItems) {
    const sid = String(item.schemeId);
    if (!membersByScheme.has(sid)) membersByScheme.set(sid, []);
    const t = typesById.get(String(item.issueTypeId));
    membersByScheme.get(sid).push({
      id: String(item.issueTypeId),
      subtask: Boolean(t?.subtask),
      hierarchyLevel: t?.hierarchyLevel ?? null,
      missing: !t,
    });
  }

  const duplicateGroups = findDuplicateTypeNames(types);
  const orphanTypes = findOrphanTypes(types, schemeItems);
  const hierarchy = analyzeSchemeHierarchy(schemes, membersByScheme);

  return {
    // Tri-state, like every other pillar: no snapshot is "not measured", never "no types".
    available: types.length > 0,
    totalTypes: types.length,
    totalSchemes: schemes.length,
    orphanTypeCount: orphanTypes.length,
    // Sub-tasks among the orphans, so a caller can caveat: a sub-task type nothing uses is
    // less surprising than a standard one nobody can create.
    orphanSubtaskCount: orphanTypes.filter((t) => t.subtask).length,
    unusedSchemeCount: schemes.filter((s) => (s.projectCount ?? 0) === 0).length,
    duplicateTypeGroupCount: duplicateGroups.length,
    // What consolidation would save: collapsing each group to one type.
    reducibleTypeCount: duplicateGroups.reduce((sum, g) => sum + (g.count - 1), 0),
    hierarchyFlaggedSchemeCount: hierarchy.filter((s) => s.flags.length > 0).length,
    subtasksOnlySchemeCount: hierarchy.filter((s) => s.flags.some((f) => f.code === "subtasks-only")).length,
    // The worst few of each, for the tab. Full lists stay where they are built.
    duplicateGroups: duplicateGroups.slice(0, cap(25)),
    orphanTypes: orphanTypes.slice(0, cap(50)),
    flaggedSchemes: hierarchy.filter((s) => s.flags.length > 0).slice(0, cap(25)),
    unusedSchemes: schemes
      .filter((s) => (s.projectCount ?? 0) === 0)
      .map((s) => ({ schemeId: String(s.schemeId), name: s.name }))
      .slice(0, cap(25)),
  };
}

// The counts the site health score takes from this pillar. computeSiteHealth scores four
// issue-type dimensions -- reach, scheme usage, naming, hierarchy -- straight from these,
// each against its own tolerance. No combined rate: the score does its own weighting.
export function summarizeIssueTypeHealth(summary) {
  if (!summary?.available) return { available: false };
  return {
    available: true,
    totalTypes: summary.totalTypes,
    totalSchemes: summary.totalSchemes,
    orphanTypeCount: summary.orphanTypeCount,
    unusedSchemeCount: summary.unusedSchemeCount,
    reducibleTypeCount: summary.reducibleTypeCount,
    duplicateTypeGroupCount: summary.duplicateTypeGroupCount,
    hierarchyFlaggedSchemeCount: summary.hierarchyFlaggedSchemeCount,
  };
}
