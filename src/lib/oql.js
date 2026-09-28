// OQL: the Observatory Query Language.
//
//   pillar = screens AND usage = low AND impact = high
//   pillar IN (filters, dashboards) AND owner IS EMPTY
//   findings IS NOT EMPTY ORDER BY impact DESC
//   lastUsed < -90d AND subscriptions > 0
//
// JQL-shaped on purpose: the people writing it already write JQL, so AND / OR / NOT,
// parentheses, IN (...), IS [NOT] EMPTY, ~ for "contains" and ORDER BY all mean what they
// mean there.
//
// Pure and dependency-free, and imported by both sides: the resolver runs queries over the
// entity index, the Search tab uses the same parser for autocomplete and for flagging an
// error before a round trip. One grammar, one set of error messages.
//
// The language knows nothing about pillars. Everything it can query is described by a
// catalog (see oql-index.js): field keys, their kinds, and the values an enumerated field
// accepts. A field the catalog does not list is an error, not a silent "matches nothing" --
// a typo that returns zero rows reads as a clean estate.

export const LEVELS = ["low", "medium", "high"];
const LEVEL_RANK = { low: 0, medium: 1, high: 2 };

const KEYWORDS = new Set(["AND", "OR", "NOT", "IN", "IS", "EMPTY", "NULL", "ORDER", "BY", "ASC", "DESC"]);
const COMPARATORS = ["=", "!=", ">", ">=", "<", "<=", "~", "!~"];

export const OPERATORS_BY_KIND = {
  text: ["=", "!=", "~", "!~", "IN", "NOT IN", "IS EMPTY", "IS NOT EMPTY"],
  enum: ["=", "!=", "IN", "NOT IN", "IS EMPTY", "IS NOT EMPTY"],
  level: ["=", "!=", ">", ">=", "<", "<=", "IN", "NOT IN"],
  number: ["=", "!=", ">", ">=", "<", "<=", "IN", "NOT IN", "IS EMPTY", "IS NOT EMPTY"],
  date: ["=", "!=", ">", ">=", "<", "<=", "IS EMPTY", "IS NOT EMPTY"],
  boolean: ["=", "!="],
  list: ["=", "!=", "~", "!~", "IN", "NOT IN", "IS EMPTY", "IS NOT EMPTY"],
};

export class OqlError extends Error {
  constructor(message, start = 0, end = start) {
    super(message);
    this.name = "OqlError";
    this.start = start;
    this.end = end;
  }
}

// ── Tokenizer ───────────────────────────────────────────────────────────────

const WORD_CHAR = /[A-Za-z0-9_.\-:/@#]/;

// `lenient` is for autocomplete: an unterminated string is a token rather than an error,
// because half a query is exactly what autocomplete is handed.
export function tokenize(text, { lenient = false } = {}) {
  const src = String(text ?? "");
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    const start = i;
    if (ch === "(" || ch === ")" || ch === ",") {
      tokens.push({ type: ch === "(" ? "lparen" : ch === ")" ? "rparen" : "comma", value: ch, start, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\" && j + 1 < src.length) { value += src[j + 1]; j += 2; continue; }
        value += src[j];
        j += 1;
      }
      if (j >= src.length) {
        if (!lenient) throw new OqlError("This quoted value is never closed.", start, src.length);
        tokens.push({ type: "string", value, start, end: src.length, open: true });
        i = src.length;
        continue;
      }
      tokens.push({ type: "string", value, start, end: j + 1 });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["!=", ">=", "<=", "!~"].includes(two)) {
      tokens.push({ type: "op", value: two, start, end: i + 2 });
      i += 2;
      continue;
    }
    if ("=<>~".includes(ch)) {
      tokens.push({ type: "op", value: ch, start, end: i + 1 });
      i += 1;
      continue;
    }
    if (WORD_CHAR.test(ch)) {
      let j = i;
      while (j < src.length && WORD_CHAR.test(src[j])) j += 1;
      tokens.push({ type: "word", value: src.slice(i, j), start, end: j });
      i = j;
      continue;
    }
    if (lenient) { i += 1; continue; }
    throw new OqlError(`"${ch}" is not part of the language. Put values with punctuation in quotes.`, start, start + 1);
  }
  return tokens;
}

const isKeyword = (tok, kw) => tok?.type === "word" && tok.value.toUpperCase() === kw;

// ── Catalog helpers ─────────────────────────────────────────────────────────

// Index a catalog's fields by lower-cased key and alias, once per catalog object.
const FIELD_INDEX = new WeakMap();
function fieldIndex(catalog) {
  let index = FIELD_INDEX.get(catalog);
  if (!index) {
    index = new Map();
    for (const field of catalog?.fields || []) {
      index.set(field.key.toLowerCase(), field);
      for (const alias of field.aliases || []) index.set(String(alias).toLowerCase(), field);
    }
    FIELD_INDEX.set(catalog, index);
  }
  return index;
}

export function resolveField(catalog, name) {
  return fieldIndex(catalog).get(String(name || "").toLowerCase()) || null;
}

// Edit distance, for "did you mean". Small inputs only.
function distance(a, b) {
  const m = a.length;
  const n = b.length;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[n];
}

function closest(input, candidates) {
  const needle = String(input).toLowerCase();
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = distance(needle, String(c).toLowerCase());
    if (d < bestScore) { best = c; bestScore = d; }
  }
  return best != null && bestScore <= Math.max(2, Math.floor(needle.length / 3)) ? best : null;
}

// The canonical form of a value for an enumerated field, or null if the field does not take it.
function canonicalValue(field, raw) {
  const lower = String(raw).toLowerCase();
  if (field.kind === "level") return [...LEVELS, "unmeasured"].find((v) => v === lower) || null;
  const values = field.values || [];
  const hit = values.find((v) => String(v).toLowerCase() === lower);
  if (hit != null) return hit;
  const alias = field.valueAliases?.[lower];
  return alias ?? null;
}

// ── Parser ──────────────────────────────────────────────────────────────────
//
//   query   := expr? (ORDER BY field (ASC|DESC)?)?
//   expr    := and (OR and)*
//   and     := not (AND not)*
//   not     := NOT not | '(' expr ')' | clause
//   clause  := field op value | field [NOT] IN '(' value (',' value)* ')' | field IS [NOT] EMPTY

export function parseOql(text, catalog, { now = new Date() } = {}) {
  try {
    return { ok: true, query: parseOrThrow(text, catalog, now) };
  } catch (err) {
    if (err instanceof OqlError) return { ok: false, error: { message: err.message, start: err.start, end: err.end } };
    throw err;
  }
}

function parseOrThrow(text, catalog, now) {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const endPos = String(text ?? "").length;
  const fail = (message, tok) => { throw new OqlError(message, tok?.start ?? endPos, tok?.end ?? endPos); };

  function parseField() {
    const tok = next();
    if (!tok || tok.type !== "word" || KEYWORDS.has(tok.value.toUpperCase())) {
      fail(tok ? `Expected a field name here, found "${tok.value}".` : "Expected a field name.", tok);
    }
    const field = resolveField(catalog, tok.value);
    if (!field) {
      const suggestion = closest(tok.value, (catalog?.fields || []).map((f) => f.key));
      fail(`Unknown field "${tok.value}".${suggestion ? ` Did you mean "${suggestion}"?` : ""}`, tok);
    }
    return { field, tok };
  }

  function parseValue(field) {
    const tok = next();
    if (!tok || (tok.type !== "word" && tok.type !== "string")) {
      fail(tok ? `Expected a value here, found "${tok.value}".` : `Expected a value for ${field.key}.`, tok);
    }
    if (tok.type === "word" && KEYWORDS.has(tok.value.toUpperCase())) {
      fail(`Expected a value, found the keyword ${tok.value.toUpperCase()}. Quote it if you mean the word.`, tok);
    }
    return coerceValue(field, tok, now, fail);
  }

  function parseClause() {
    const { field, tok: fieldTok } = parseField();
    const opTok = peek();
    if (!opTok) fail(`Expected an operator after ${field.key}: ${OPERATORS_BY_KIND[field.kind].join(", ")}.`);

    const allowed = OPERATORS_BY_KIND[field.kind] || OPERATORS_BY_KIND.text;
    const check = (op, tok) => {
      if (!allowed.includes(op)) fail(`${field.key} does not support ${op}. Use ${allowed.join(", ")}.`, tok);
    };

    if (isKeyword(opTok, "IS")) {
      next();
      let negate = false;
      if (isKeyword(peek(), "NOT")) { next(); negate = true; }
      const emptyTok = next();
      if (!isKeyword(emptyTok, "EMPTY") && !isKeyword(emptyTok, "NULL")) fail("Expected EMPTY after IS.", emptyTok);
      const op = negate ? "IS NOT EMPTY" : "IS EMPTY";
      check(op, opTok);
      return { type: "clause", field: field.key, kind: field.kind, op, start: fieldTok.start, end: emptyTok.end };
    }

    let negateIn = false;
    if (isKeyword(opTok, "NOT")) {
      next();
      if (!isKeyword(peek(), "IN")) fail("Expected IN after NOT. To negate a clause, put NOT before the field.", peek());
      negateIn = true;
    }
    if (isKeyword(peek(), "IN")) {
      const inTok = next();
      const op = negateIn ? "NOT IN" : "IN";
      check(op, inTok);
      const open = next();
      if (open?.type !== "lparen") fail("Expected ( after IN, as in IN (a, b).", open);
      const values = [parseValue(field)];
      while (peek()?.type === "comma") { next(); values.push(parseValue(field)); }
      const close = next();
      if (close?.type !== "rparen") fail("Expected , or ) in the IN list.", close);
      return { type: "clause", field: field.key, kind: field.kind, op, values, start: fieldTok.start, end: close.end };
    }

    if (opTok.type !== "op" || !COMPARATORS.includes(opTok.value)) {
      fail(`Expected an operator after ${field.key}, found "${opTok.value}". Try ${allowed.slice(0, 4).join(", ")}.`, opTok);
    }
    next();
    check(opTok.value, opTok);
    const valueTok = peek();
    const value = parseValue(field);
    if ((field.kind === "level") && value.value === "unmeasured" && [">", ">=", "<", "<="].includes(opTok.value)) {
      fail("unmeasured has no order. Use = or != with it.", valueTok);
    }
    return { type: "clause", field: field.key, kind: field.kind, op: opTok.value, values: [value], start: fieldTok.start, end: valueTok.end };
  }

  function parseNot() {
    const tok = peek();
    if (isKeyword(tok, "NOT")) { next(); return { type: "not", expr: parseNot() }; }
    if (tok?.type === "lparen") {
      next();
      const expr = parseOr();
      const close = next();
      if (close?.type !== "rparen") fail("This ( is never closed.", tok);
      return expr;
    }
    return parseClause();
  }

  function parseAnd() {
    let left = parseNot();
    while (isKeyword(peek(), "AND")) { next(); left = { type: "and", left, right: parseNot() }; }
    return left;
  }

  function parseOr() {
    let left = parseAnd();
    while (isKeyword(peek(), "OR")) { next(); left = { type: "or", left, right: parseAnd() }; }
    return left;
  }

  let where = null;
  if (peek() && !isKeyword(peek(), "ORDER")) where = parseOr();

  let orderBy = null;
  if (isKeyword(peek(), "ORDER")) {
    next();
    if (!isKeyword(peek(), "BY")) fail("Expected BY after ORDER.", peek());
    next();
    const { field } = parseField();
    let dir = "asc";
    if (isKeyword(peek(), "ASC")) next();
    else if (isKeyword(peek(), "DESC")) { next(); dir = "desc"; }
    orderBy = { field: field.key, kind: field.kind, dir };
  }

  const rest = peek();
  if (rest) {
    if (rest.type === "word" && !KEYWORDS.has(rest.value.toUpperCase()) && where) {
      fail(`Expected AND or OR before "${rest.value}".`, rest);
    }
    fail(rest.type === "rparen" ? "This ) has no matching (." : `Unexpected "${rest.value}".`, rest);
  }
  return { where, orderBy };
}

// "-90d", "-2w", "-6m", "-1y": that long before now. Dates otherwise compare as ISO strings.
const RELATIVE_DATE = /^-(\d+)([dwmy])$/i;
const UNIT_DAYS = { d: 1, w: 7, m: 30, y: 365 };

function coerceValue(field, tok, now, fail) {
  const raw = tok.value;
  switch (field.kind) {
    case "number": {
      const n = Number(raw);
      if (raw === "" || !Number.isFinite(n)) fail(`${field.key} is a number; "${raw}" is not.`, tok);
      return { value: n, raw };
    }
    case "boolean": {
      const lower = raw.toLowerCase();
      if (["true", "yes"].includes(lower)) return { value: true, raw };
      if (["false", "no"].includes(lower)) return { value: false, raw };
      return fail(`${field.key} is true or false; "${raw}" is neither.`, tok);
    }
    case "date": {
      const rel = RELATIVE_DATE.exec(raw);
      if (rel) {
        const days = Number(rel[1]) * UNIT_DAYS[rel[2].toLowerCase()];
        return { value: new Date(now.getTime() - days * 86400000).toISOString(), raw };
      }
      const ms = Date.parse(raw);
      if (!Number.isFinite(ms)) fail(`${field.key} is a date: use 2026-01-31, or -30d for thirty days ago.`, tok);
      return { value: new Date(ms).toISOString(), raw };
    }
    case "level":
    case "enum": {
      const canon = canonicalValue(field, raw);
      if (canon == null) {
        const options = field.kind === "level" ? [...LEVELS, "unmeasured"] : field.values || [];
        const suggestion = closest(raw, options);
        fail(`"${raw}" is not a ${field.key}.${suggestion ? ` Did you mean "${suggestion}"?` : ` Use one of: ${options.join(", ")}.`}`, tok);
      }
      return { value: canon, raw };
    }
    default:
      return { value: raw, raw };
  }
}

// ── Evaluation ──────────────────────────────────────────────────────────────

const isEmpty = (v) => v == null || v === "" || (Array.isArray(v) && v.length === 0);
const lower = (v) => String(v).toLowerCase();

function equals(kind, actual, expected) {
  if (Array.isArray(actual)) return actual.some((a) => lower(a) === lower(expected));
  if (kind === "number") return Number(actual) === expected;
  if (kind === "boolean") return Boolean(actual) === expected;
  if (kind === "date") return String(actual).slice(0, 10) === String(expected).slice(0, 10);
  return lower(actual) === lower(expected);
}

function compare(kind, actual, expected) {
  if (kind === "level") {
    const a = LEVEL_RANK[actual];
    const b = LEVEL_RANK[expected];
    return a == null || b == null ? null : a - b;
  }
  if (kind === "number") {
    const a = Number(actual);
    return Number.isFinite(a) ? a - expected : null;
  }
  if (kind === "date") {
    const a = Date.parse(actual);
    const b = Date.parse(expected);
    return Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
  }
  return lower(actual).localeCompare(lower(expected));
}

function evalClause(clause, entity) {
  const actual = entity[clause.field];
  const { op, kind } = clause;
  if (op === "IS EMPTY") return isEmpty(actual);
  if (op === "IS NOT EMPTY") return !isEmpty(actual);
  // Every other comparison is false for an entity without the field, including !=. The
  // alternative -- "has no owner, so owner != sam is true" -- makes a negated clause sweep in
  // every pillar that has no owners at all.
  if (actual === undefined) return false;
  if (isEmpty(actual) && kind !== "list") return false;
  const values = clause.values.map((v) => v.value);
  switch (op) {
    case "=": return equals(kind, actual, values[0]);
    case "!=": return !equals(kind, actual, values[0]);
    case "IN": return values.some((v) => equals(kind, actual, v));
    case "NOT IN": return !values.some((v) => equals(kind, actual, v));
    case "~": return (Array.isArray(actual) ? actual : [actual]).some((a) => lower(a).includes(lower(values[0])));
    case "!~": return !(Array.isArray(actual) ? actual : [actual]).some((a) => lower(a).includes(lower(values[0])));
    default: {
      const c = compare(kind, actual, values[0]);
      if (c == null) return false;
      if (op === ">") return c > 0;
      if (op === ">=") return c >= 0;
      if (op === "<") return c < 0;
      return c <= 0;
    }
  }
}

export function evaluate(node, entity) {
  if (!node) return true;
  switch (node.type) {
    case "and": return evaluate(node.left, entity) && evaluate(node.right, entity);
    case "or": return evaluate(node.left, entity) || evaluate(node.right, entity);
    case "not": return !evaluate(node.expr, entity);
    default: return evalClause(node, entity);
  }
}

function sortValue(kind, v) {
  if (isEmpty(v)) return null;
  if (kind === "level") return LEVEL_RANK[v] ?? null;
  if (kind === "number") return Number.isFinite(Number(v)) ? Number(v) : null;
  if (kind === "date") { const ms = Date.parse(v); return Number.isFinite(ms) ? ms : null; }
  if (kind === "boolean") return v ? 1 : 0;
  if (Array.isArray(v)) return v.length;
  return lower(v);
}

// Blanks sort last in both directions: an unmeasured row is never the "top" of anything.
export function sortEntities(entities, orderBy) {
  if (!orderBy) return entities;
  const { field, kind, dir } = orderBy;
  const sign = dir === "desc" ? -1 : 1;
  return [...entities].sort((a, b) => {
    const va = sortValue(kind, a[field]);
    const vb = sortValue(kind, b[field]);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (va < vb) return -1 * sign;
    if (va > vb) return 1 * sign;
    return 0;
  });
}

// The pillars a query can only ever match, when it pins them at the top level
// (`pillar = x AND ...` or `pillar IN (...) AND ...`). Null means any pillar could match, so
// the caller has to load them all. Lets the resolver skip loading pillars a query cannot touch.
export function pinnedPillars(where) {
  if (!where) return null;
  if (where.type === "clause" && where.field === "pillar") {
    if (where.op === "=" || where.op === "IN") return new Set(where.values.map((v) => v.value));
    return null;
  }
  if (where.type === "and") {
    const l = pinnedPillars(where.left);
    const r = pinnedPillars(where.right);
    if (l && r) return new Set([...l].filter((p) => r.has(p)));
    return l || r;
  }
  if (where.type === "or") {
    const l = pinnedPillars(where.left);
    const r = pinnedPillars(where.right);
    return l && r ? new Set([...l, ...r]) : null;
  }
  return null;
}

export function runOql(entities, text, catalog, { now = new Date() } = {}) {
  const parsed = parseOql(text, catalog, { now });
  if (!parsed.ok) return parsed;
  const matched = entities.filter((e) => evaluate(parsed.query.where, e));
  return { ok: true, query: parsed.query, results: sortEntities(matched, parsed.query.orderBy) };
}

// ── Autocomplete ────────────────────────────────────────────────────────────
//
// Returns what could come next at the cursor: `{ from, to, items: [{ label, insert, detail }] }`,
// where from..to is the partial word being replaced. Works off the lenient token stream, so a
// half-typed query never throws.

function quoteIfNeeded(value) {
  const s = String(value);
  return /^[A-Za-z0-9_.\-:/@#]+$/.test(s) && !KEYWORDS.has(s.toUpperCase()) ? s : `"${s.replace(/"/g, '\\"')}"`;
}

function valueItems(field) {
  if (!field) return [];
  if (field.kind === "level") {
    return [...LEVELS, "unmeasured"].map((v) => ({ label: v, insert: v, detail: field.valueDetails?.[v] || "" }));
  }
  if (field.kind === "boolean") return ["true", "false"].map((v) => ({ label: v, insert: v, detail: "" }));
  if (field.kind === "date") return [{ label: "-30d", insert: "-30d", detail: "30 days ago" }, { label: "-90d", insert: "-90d", detail: "90 days ago" }];
  return (field.values || []).map((v) => ({ label: String(v), insert: quoteIfNeeded(v), detail: field.valueDetails?.[v] || "" }));
}

function fieldItems(catalog) {
  return (catalog?.fields || []).map((f) => ({ label: f.key, insert: f.key, detail: f.detail || f.label || "" }));
}

const kw = (...words) => words.map((w) => ({ label: w, insert: w, detail: "" }));

export function suggestOql(text, cursor, catalog) {
  const src = String(text ?? "");
  const at = cursor == null ? src.length : Math.max(0, Math.min(cursor, src.length));
  const tokens = tokenize(src.slice(0, at), { lenient: true });

  // The word under the cursor, if the cursor sits at its end, is the prefix being typed.
  let prefixTok = null;
  const last = tokens[tokens.length - 1];
  if (last && last.end === at && (last.type === "word" || (last.type === "string" && last.open))) {
    prefixTok = last;
  }
  const before = prefixTok ? tokens.slice(0, -1) : tokens;

  // Walk the tokens before the prefix to find what the grammar expects next.
  let state = "field";
  let field = null;
  let depth = 0;
  for (let i = 0; i < before.length; i++) {
    const tok = before[i];
    const up = tok.type === "word" ? tok.value.toUpperCase() : null;
    switch (state) {
      case "field":
        if (up === "NOT") state = "field";
        else if (tok.type === "lparen") { depth += 1; state = "field"; }
        else if (tok.type === "word") { field = resolveField(catalog, tok.value); state = "op"; }
        break;
      case "op":
        if (tok.type === "op") state = "value";
        else if (up === "IS") state = "is";
        else if (up === "NOT") state = "notin";
        else if (up === "IN") state = "inopen";
        break;
      case "is":
        state = up === "NOT" ? "isnot" : "connector";
        break;
      case "isnot":
        state = "connector";
        break;
      case "notin":
        state = up === "IN" ? "inopen" : "connector";
        break;
      case "inopen":
        state = tok.type === "lparen" ? "listvalue" : "connector";
        break;
      case "listvalue":
        state = "listsep";
        break;
      case "listsep":
        state = tok.type === "comma" ? "listvalue" : "connector";
        break;
      case "value":
        state = "connector";
        break;
      case "connector":
        if (up === "AND" || up === "OR") state = "field";
        else if (up === "ORDER") state = "by";
        else if (tok.type === "rparen") { depth = Math.max(0, depth - 1); state = "connector"; }
        break;
      case "by":
        state = up === "BY" ? "orderfield" : "connector";
        break;
      case "orderfield":
        state = "orderdir";
        break;
      case "orderdir":
        state = "done";
        break;
      default:
        break;
    }
  }

  let items;
  switch (state) {
    case "field": items = [...fieldItems(catalog), ...kw("NOT")]; break;
    case "orderfield": items = fieldItems(catalog); break;
    case "op": items = (OPERATORS_BY_KIND[field?.kind] || OPERATORS_BY_KIND.text).map((op) => ({ label: op, insert: op, detail: "" })); break;
    case "is": items = kw("EMPTY", "NOT EMPTY"); break;
    case "isnot": items = kw("EMPTY"); break;
    case "notin": items = kw("IN"); break;
    case "inopen": items = [{ label: "(", insert: "(", detail: "" }]; break;
    case "value":
    case "listvalue": items = valueItems(field); break;
    case "listsep": items = [{ label: ",", insert: ",", detail: "" }, { label: ")", insert: ")", detail: "" }]; break;
    case "connector": items = [...kw("AND", "OR"), ...(depth > 0 ? [{ label: ")", insert: ")", detail: "" }] : kw("ORDER BY"))]; break;
    case "by": items = kw("BY"); break;
    case "orderdir": items = kw("ASC", "DESC"); break;
    default: items = [];
  }

  const prefix = prefixTok ? String(prefixTok.value).toLowerCase() : "";
  const filtered = prefix
    ? [
      ...items.filter((it) => it.label.toLowerCase().startsWith(prefix)),
      ...items.filter((it) => !it.label.toLowerCase().startsWith(prefix) && it.label.toLowerCase().includes(prefix)),
    ]
    : items;
  // Don't offer exactly what is already typed as the only option.
  const useful = filtered.filter((it) => !(prefixTok && it.label.toLowerCase() === prefix && filtered.length === 1 && state !== "value"));
  return { from: prefixTok ? prefixTok.start : at, to: at, items: useful.slice(0, 50) };
}
