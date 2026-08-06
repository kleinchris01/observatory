// Analysis over the workflow snapshot: status sprawl, orphaned statuses, and the status
// category balance of each scheme.
//
// Kept separate from analysis.js, which is entirely about custom fields. These are pure
// functions over already-loaded rows -- no I/O, no Forge SQL -- so the resolver decides
// what to load and this decides what it means.

// Status names collapse harder than field names do.
//
// analysis.js's normalizeFieldName maps non-alphanumerics to a SPACE, which is right for
// fields ("Story Points" and "Story-Points" should not be confused with "Storypoints").
// Status names are short human labels where spacing is noise: "Back Log" and "Backlog" are
// the same status typed twice, so every separator is removed rather than normalized.
export function normalizeStatusName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Levenshtein distance, bailing out as soon as it exceeds `max`.
//
// Only ever called with max = 1 here: one substitution ("cancelled"/"canceled" after
// normalization is an insertion), one transposition, one typo. Anything looser starts
// merging genuinely distinct statuses -- "Approved" and "Approve" are arguably the same,
// but "Blocked" and "Blocker" may not be, and a governance report that cries wolf gets
// ignored. The early exit keeps this cheap enough to run across a few hundred names.
export function editDistanceWithin(a, b, max = 1) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (current[j] < rowMin) rowMin = current[j];
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}

// Below this length a single character is a large proportion of the name, and the
// difference is usually meaningful rather than a typo: CHOLD and UHOLD are distinct hold
// types, not one status misspelled.
const MIN_SPELLING_LENGTH = 8;

// True when two names differing by one character are genuinely a spelling variant, rather
// than members of a deliberate series.
//
// "CP3 Sign Off Complete" / "CP4 Sign Off Complete" are one edit apart and completely
// distinct statuses -- the digit IS the meaning. Any pair that becomes identical once
// digits are removed is an enumeration, not a duplicate. Precision matters more than
// recall here: a governance report that flags real statuses as duplicates gets dismissed
// wholesale, taking the true findings with it.
export function isSpellingVariant(a, b) {
  if (Math.min(a.length, b.length) < MIN_SPELLING_LENGTH) return false;
  if (a.replace(/\d/g, "") === b.replace(/\d/g, "")) return false;
  return editDistanceWithin(a, b, 1) <= 1;
}

// Statuses that are almost certainly the same thing, grouped so an admin can consolidate.
//
// Three kinds, reported separately because they carry different confidence and different
// remediation. "identical" is unarguable -- the same literal name existing more than once
// is duplication by definition. "spacing" is near-certain. "spelling" is a suggestion.
//
// Ordered by size so the worst offenders lead; a report that opens with a two-status
// group buries the one with six.
export function findDuplicateStatusGroups(statuses = []) {
  const byNormalized = new Map();
  for (const status of statuses) {
    if (!status?.name) continue;
    const key = normalizeStatusName(status.name);
    if (!key) continue;
    if (!byNormalized.has(key)) byNormalized.set(key, []);
    byNormalized.get(key).push(status);
  }

  const groups = [];
  const consumed = new Set();

  for (const [key, members] of byNormalized) {
    if (members.length < 2) continue;
    consumed.add(key);
    // Every member sharing one normalized key: identical if the raw names also match,
    // otherwise the difference is purely spacing or punctuation.
    const rawNames = new Set(members.map((s) => s.name));
    groups.push({
      key,
      kind: rawNames.size === 1 ? "identical" : "spacing",
      statuses: members,
      count: members.length,
    });
  }

  // Spelling variants: distinct normalized keys within one edit of each other. Length
  // bucketing keeps the comparison from being fully quadratic across the catalog.
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
      statuses: cluster.flatMap((k) => byNormalized.get(k)),
      count: cluster.reduce((sum, k) => sum + byNormalized.get(k).length, 0),
    });
  }

  return groups.sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

// Statuses in the site catalog that no workflow scheme reaches.
//
// `issueCountByStatusId` is optional and comes from the universe scan. Without it an
// orphan is "defined but unreachable"; with it, a zero-count orphan is provably safe to
// delete -- nothing has ever been in it -- which is the difference between a suggestion
// and an action. A non-zero count on an unreachable status is its own finding: history
// exists in a status no current workflow can produce.
export function findOrphanedStatuses(statuses = [], schemeStatusPairs = [], issueCountByStatusId = null) {
  const referenced = new Set(schemeStatusPairs.map((pair) => String(pair.statusId)));
  return statuses
    .filter((status) => !referenced.has(String(status.statusId ?? status.id)))
    .map((status) => {
      const id = String(status.statusId ?? status.id);
      const issueCount = issueCountByStatusId ? Number(issueCountByStatusId.get(id) ?? 0) : null;
      return {
        statusId: id,
        name: status.name,
        statusCategory: status.statusCategory || null,
        issueCount,
        // Only assert safety when the scan actually observed the catalog. A null count
        // means "unknown", which must never render as "safe to delete".
        //
        // Note the deliberate limit of this claim: it means no workflow reaches the status
        // and no issue has ever entered it. It does NOT mean no automation rule references
        // it. Jira Automation rules cannot be read from a Forge app -- site-relative
        // endpoints 401 with no declarable scope, the api.atlassian.com gateway rejects the
        // route, and Forge exposes no automation permission -- so callers must present this
        // as "no evidence of use" rather than "safe to delete".
        safeToRemove: issueCount === 0,
      };
    })
    .sort((left, right) => (right.issueCount ?? 0) - (left.issueCount ?? 0) || left.name.localeCompare(right.name));
}

const CATEGORY_KEYS = { "to do": "todo", "in progress": "inProgress", done: "done" };

function categoryKey(category) {
  return CATEGORY_KEYS[String(category || "").toLowerCase()] || "uncategorised";
}

// Per-scheme status category balance, with the shapes worth flagging.
//
// The premise: a healthy workflow moves work through roughly comparable numbers of
// stages. A scheme with 22 In Progress statuses and one Done is not tracking progress,
// it is tracking meetings -- and a scheme with no Done status at all cannot represent
// completion, which is a correctness problem rather than a style one.
//
// Thresholds are deliberately conservative. Flagging half the site trains people to
// ignore the flags.
export function computeSchemeCategoryBalance(schemes = [], schemeStatusPairs = [], statuses = []) {
  const statusById = new Map(statuses.map((s) => [String(s.statusId ?? s.id), s]));
  const byScheme = new Map();

  for (const pair of schemeStatusPairs) {
    const schemeId = String(pair.schemeId);
    if (!byScheme.has(schemeId)) byScheme.set(schemeId, new Set());
    byScheme.get(schemeId).add(String(pair.statusId));
  }

  return schemes.map((scheme) => {
    const statusIds = byScheme.get(String(scheme.id ?? scheme.schemeId)) || new Set();
    const counts = { todo: 0, inProgress: 0, done: 0, uncategorised: 0 };
    for (const statusId of statusIds) {
      counts[categoryKey(statusById.get(statusId)?.statusCategory)] += 1;
    }
    const total = counts.todo + counts.inProgress + counts.done + counts.uncategorised;

    const flags = [];
    if (total > 0 && counts.done === 0) {
      flags.push({ code: "no-done", severity: "high", message: "No Done status — this scheme cannot represent completion." });
    }
    if (counts.inProgress >= 10 && counts.inProgress >= counts.done * 8) {
      flags.push({
        code: "in-progress-heavy",
        severity: "medium",
        message: `${counts.inProgress} In Progress statuses against ${counts.done} Done — likely tracking handoffs rather than progress.`,
      });
    }
    if (total >= 25) {
      flags.push({ code: "oversized", severity: "medium", message: `${total} statuses in one scheme is more than a reader can hold.` });
    }
    if (counts.uncategorised > 0) {
      flags.push({ code: "uncategorised", severity: "low", message: `${counts.uncategorised} status(es) have no category and will not roll up in Jira reporting.` });
    }

    return {
      schemeId: String(scheme.id ?? scheme.schemeId),
      name: scheme.name,
      projectCount: scheme.projectCount ?? 0,
      ...counts,
      total,
      flags,
    };
  })
    // Flagged schemes first, then the largest -- the list is a worklist, not a census.
    .sort((left, right) => right.flags.length - left.flags.length || right.total - left.total);
}

// Roll-up for the header of the insights view. Counts the finding, not the noise: a
// duplicate GROUP is one problem to solve regardless of how many statuses it contains,
// but the status count is what quantifies the cleanup.
export function summarizeWorkflowInsights({ duplicateGroups = [], orphans = [], balance = [] }) {
  // Callers pass empty arrays for anything they are suppressing, so the summary can never
  // assert more than the sections below it show.
  const duplicateStatusCount = duplicateGroups.reduce((sum, group) => sum + group.count, 0);
  return {
    duplicateGroupCount: duplicateGroups.length,
    duplicateStatusCount,
    // What consolidation would actually save: collapsing each group to one status.
    reducibleStatusCount: duplicateGroups.reduce((sum, group) => sum + (group.count - 1), 0),
    orphanCount: orphans.length,
    safeToRemoveCount: orphans.filter((o) => o.safeToRemove).length,
    flaggedSchemeCount: balance.filter((entry) => entry.flags.length > 0).length,
  };
}
