// What a JQL string depends on.
//
// This is the join that makes filters worth a pillar rather than a list. The rest of this
// app already refuses to call a field unused when an automation rule writes it, or a status
// dead when a rule transitions into it. A saved filter is the same kind of evidence and was
// the one source nobody was reading: delete a field that forty filters search on and forty
// saved searches start returning the wrong answer, silently, with no error anywhere.
//
// A small tokenizer rather than a set of regexes, and that was not the first attempt.
// Matching "a name to the left of an operator" finds fields well enough, but it cannot tell
// `"Story Points" >= 5` (a quoted FIELD) from `summary ~ "status = Done"` (a quoted VALUE
// that happens to contain JQL), and the two need opposite treatment: for field extraction
// the value is noise, and for status extraction the value is the entire answer. Blanking
// values fixed the first and broke the second. Position is the only thing that distinguishes
// them, so the scanner tracks position.
//
// Still a recognizer, not a parser -- it does not validate, and it does not implement
// operator precedence or subqueries. What it does is pair operands with the field they
// belong to, which is what a dependency question needs. Callers read the output as
// "references we can prove", the same contract automation-analysis.js publishes: a reference
// found here is evidence the field is in use; finding none is not evidence that it is not.
//
// Pure and importless, so it runs in a resolver, in a test, and in the browser bundle alike.

// Words that appear in operand position but are not operands.
const KEYWORDS = new Set([
  "and", "or", "not", "order", "by", "asc", "desc",
  "is", "in", "was", "changed", "from", "to", "on", "during", "before", "after",
]);

// Values that are the absence of a value.
const EMPTY_VALUES = new Set(["empty", "null"]);

const OPERATORS = new Set(["=", "!=", "~", "!~", "<", ">", "<=", ">=", "in", "not in", "is", "is not", "was", "was not", "was in", "was not in", "changed"]);

// One token: a quoted string, a bracketed custom field, punctuation, or a bare word.
function* tokenize(jql) {
  const text = String(jql || "");
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (/\s/.test(ch)) { i += 1; continue; }

    if (ch === '"' || ch === "'") {
      let value = "";
      i += 1;
      while (i < text.length && text[i] !== ch) {
        // A backslash escape keeps the next character rather than ending the string.
        if (text[i] === "\\" && i + 1 < text.length) { value += text[i + 1]; i += 2; continue; }
        value += text[i];
        i += 1;
      }
      i += 1;
      yield { type: "term", value, quoted: true };
      continue;
    }

    if (ch === "(" || ch === ")" || ch === ",") { yield { type: ch }; i += 1; continue; }

    // cf[10001] -- the custom field escape hatch, read whole so the brackets do not split it.
    if (text.startsWith("cf[", i)) {
      const close = text.indexOf("]", i);
      if (close > -1) { yield { type: "term", value: text.slice(i, close + 1), quoted: false }; i = close + 1; continue; }
    }

    const symbol = text.slice(i, i + 2);
    if (["!=", "!~", "<=", ">="].includes(symbol)) { yield { type: "op", value: symbol }; i += 2; continue; }
    if (["=", "~", "<", ">"].includes(ch)) { yield { type: "op", value: ch }; i += 1; continue; }

    const word = /^[A-Za-z0-9_.+-]+/.exec(text.slice(i));
    if (word) { yield { type: "term", value: word[0], quoted: false }; i += word[0].length; continue; }

    i += 1;
  }
}

// Fold the multi-word operators back together, so `IS NOT` and `NOT IN` are one token.
function* withPhrasedOperators(tokens) {
  const buffer = [...tokens];
  for (let i = 0; i < buffer.length; i++) {
    const token = buffer[i];
    if (token.type === "term" && !token.quoted) {
      const word = token.value.toLowerCase();
      const next = buffer[i + 1];
      const after = buffer[i + 2];
      const nextWord = next?.type === "term" && !next.quoted ? next.value.toLowerCase() : null;
      const afterWord = after?.type === "term" && !after.quoted ? after.value.toLowerCase() : null;

      if (word === "was" && nextWord === "not" && afterWord === "in") { yield { type: "op", value: "was not in" }; i += 2; continue; }
      if (word === "was" && (nextWord === "not" || nextWord === "in")) { yield { type: "op", value: `was ${nextWord}` }; i += 1; continue; }
      if (word === "is" && nextWord === "not") { yield { type: "op", value: "is not" }; i += 1; continue; }
      if (word === "not" && nextWord === "in") { yield { type: "op", value: "not in" }; i += 1; continue; }
      if (OPERATORS.has(word)) { yield { type: "op", value: word }; continue; }
    }
    yield token;
  }
}

// Field/value pairs, in the order they appear.
//
// The state machine is the whole point: a term is a FIELD when nothing is pending and a
// VALUE when an operator is. That is what tells `"Story Points" >= 5` from
// `summary ~ "status = Done"` -- in the second, everything inside the quotes is one value
// and never re-enters the scanner.
export function scanJql(jql) {
  const fields = new Map();
  const pairs = [];

  let pendingField = null;
  let inList = false;
  let orderBy = false;

  const noteField = (term) => {
    const name = term.value.trim().replace(/\s+/g, " ");
    if (!name) return null;
    const key = name.toLowerCase();
    if (!term.quoted && (KEYWORDS.has(key) || EMPTY_VALUES.has(key))) return null;
    if (!fields.has(key)) fields.set(key, name);
    return name;
  };

  for (const token of withPhrasedOperators(tokenize(jql))) {
    if (token.type === "op") { inList = false; continue; }
    if (token.type === "(") { if (pendingField) inList = true; continue; }
    if (token.type === ")") { if (inList) { inList = false; pendingField = null; } continue; }
    if (token.type === ",") { if (!inList) pendingField = null; continue; }

    const word = token.value.trim().toLowerCase();

    // ORDER BY names fields with no operator after them. A filter sorted by a field depends
    // on it exactly as much as one that filters on it -- deleting it reorders the result
    // with no error, which is the harder failure to notice.
    if (!token.quoted && word === "order") { orderBy = true; pendingField = null; continue; }
    if (orderBy) {
      if (!token.quoted && (word === "by" || word === "asc" || word === "desc")) continue;
      noteField(token);
      continue;
    }

    if (!token.quoted && (word === "and" || word === "or" || word === "not")) { pendingField = null; inList = false; continue; }

    // Sitting after an operator: this is a value, and it belongs to the field on the left.
    if (pendingField) {
      const value = token.value.trim().replace(/\s+/g, " ");
      if (value && !(!token.quoted && EMPTY_VALUES.has(word))) {
        pairs.push({ field: pendingField.toLowerCase(), value });
      }
      if (!inList) pendingField = null;
      continue;
    }

    pendingField = noteField(token);
  }

  return { fields: [...fields.values()], pairs };
}

// Every field a JQL string references.
export function extractJqlFields(jql) {
  return scanJql(jql).fields;
}

// Values assigned to one of `names`, deduplicated case-insensitively.
function valuesFor(jql, names) {
  const wanted = new Set(names);
  const found = new Map();
  for (const pair of scanJql(jql).pairs) {
    if (!wanted.has(pair.field)) continue;
    const key = pair.value.toLowerCase();
    if (KEYWORDS.has(key)) continue;
    if (!found.has(key)) found.set(key, pair.value);
  }
  return [...found.values()];
}

// Project keys and ids a filter is scoped to.
//
// Worth extracting separately from fields: a filter pinned to a project that no longer
// exists is broken rather than untidy, and it is the one filter defect that produces a
// visible error rather than a silently wrong result.
export function extractJqlProjects(jql) {
  return valuesFor(jql, ["project"]);
}

// Status names a filter names. Feeds the same "do not delete this" answer the workflow
// pillar already gives for automation rules.
export function extractJqlStatuses(jql) {
  return valuesFor(jql, ["status"]);
}

// Everything one filter depends on, in the shape the reference table stores.
export function extractJqlReferences(jql) {
  const { fields, pairs } = scanJql(jql);
  const pick = (name) => {
    const found = new Map();
    for (const pair of pairs) {
      if (pair.field !== name) continue;
      const key = pair.value.toLowerCase();
      if (KEYWORDS.has(key)) continue;
      if (!found.has(key)) found.set(key, pair.value);
    }
    return [...found.values()];
  };
  return { fields, projects: pick("project"), statuses: pick("status") };
}

// Two filters that would return the same issues.
//
// Normalized rather than compared literally, because the same search written by two people
// differs in whitespace, casing and quoting far more often than in meaning. Clause ORDER is
// deliberately NOT normalized: reordering an AND chain is safe, but proving that in general
// means implementing the grammar, and a duplicate report that is occasionally wrong is worth
// less than one that is narrow and always right.
export function normalizeJql(jql) {
  return String(jql || "")
    .toLowerCase()
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),=<>!~])\s*/g, "$1")
    .trim();
}
