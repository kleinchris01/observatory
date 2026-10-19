// Name and ID search over the cross-pillar entity index, for the admin Ctrl+K palette.
//
// OQL ranks by attention score, which is right for "what needs looking at" and wrong for
// "take me to the thing I typed": a jump-to box should put the item whose name IS the term
// first. So this ranks purely on how the term matches, best first:
//
//   0    name equals the term
//   0.5  ID or key equals the term (customfield_11664, SOLVE, an account ID)
//   1    name starts with the term
//   2    a word in the name starts with the term ("deviation" finds "Build Deviation")
//   2.5  ID starts with the term
//   3    the term appears anywhere in the name
//   4    the term appears anywhere in the ID
//
// Ties go to the shorter name (the closer match), then alphabetical, so the order is stable.

export const ENTITY_SEARCH_MIN_TERM = 2;
export const ENTITY_SEARCH_DEFAULT_LIMIT = 20;
export const ENTITY_SEARCH_MAX_LIMIT = 50;

const WORD_START = /[\s\-_/.:([]/;

function lower(value) {
  return String(value ?? "").toLowerCase();
}

/** How well `entity` matches the lower-cased `term`; null when it does not match at all. */
export function entityMatchRank(entity, term) {
  const t = lower(term).trim();
  if (!t) return null;
  const name = lower(entity?.name);
  const id = lower(entity?.id);

  if (name === t) return 0;
  if (id && id === t) return 0.5;
  if (name.startsWith(t)) return 1;
  const at = name.indexOf(t);
  if (at > 0) {
    // Any occurrence that begins a word, not just the first occurrence.
    for (let i = at; i !== -1; i = name.indexOf(t, i + 1)) {
      if (WORD_START.test(name[i - 1])) return 2;
    }
  }
  if (id && id.startsWith(t)) return 2.5;
  if (at > 0) return 3;
  if (id && id.includes(t)) return 4;
  return null;
}

/** The fields a palette row needs, and nothing else -- the index rows are wide. */
export function toEntitySearchRow(entity, rank) {
  return {
    uid: entity.uid,
    pillar: entity.pillar,
    pillarLabel: entity.pillarLabel,
    name: entity.name,
    id: entity.id,
    // Which list inside the pillar the item lives in: Priority vs Resolution, Permission
    // scheme vs Project role. The palette uses it to open the right view.
    kind: entity.kind ?? null,
    type: entity.type ?? null,
    rank,
  };
}

/**
 * @param entities buildEntityIndex(...).entities
 * @param term     what the reader typed
 * @returns { total, results } -- total counts every match, results is the best `limit`
 */
export function rankEntityMatches(entities = [], term = "", { limit = ENTITY_SEARCH_DEFAULT_LIMIT } = {}) {
  const t = lower(term).trim();
  if (t.length < ENTITY_SEARCH_MIN_TERM) return { total: 0, results: [] };
  const cap = Math.min(Math.max(Number(limit) || ENTITY_SEARCH_DEFAULT_LIMIT, 1), ENTITY_SEARCH_MAX_LIMIT);

  const matches = [];
  for (const entity of entities) {
    const rank = entityMatchRank(entity, t);
    if (rank !== null) matches.push({ entity, rank });
  }
  matches.sort(
    (a, b) =>
      a.rank - b.rank ||
      String(a.entity.name ?? "").length - String(b.entity.name ?? "").length ||
      String(a.entity.name ?? "").localeCompare(String(b.entity.name ?? "")) ||
      String(a.entity.pillar).localeCompare(String(b.entity.pillar)),
  );

  return {
    total: matches.length,
    results: matches.slice(0, cap).map(({ entity, rank }) => toEntitySearchRow(entity, rank)),
  };
}
