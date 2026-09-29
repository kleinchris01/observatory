import { describe, it, expect } from "vitest";
import { parseOql, runOql, suggestOql, tokenize, evaluate, pinnedPillars, sortEntities } from "./oql.js";
import { buildOqlCatalog } from "./oql-index.js";

const catalog = buildOqlCatalog({ findingCodes: ["empty", "unreached", "no-owner"] });
const NOW = new Date("2026-09-28T12:00:00.000Z");

const E = (over) => ({ pillar: "screens", id: "1", name: "Screen", usage: "medium", impact: "medium", discoveries: [], ...over });
const ENTITIES = [
  E({ id: "1", name: "Bug Create", usage: "low", impact: "high", fields: 40, projects: 1 }),
  E({ id: "2", name: "Default Screen", usage: "high", impact: "high", fields: 30, projects: 80, discoveries: ["unreached"] }),
  E({ id: "3", name: "Resolve Issue", usage: "low", impact: "low", fields: 2, projects: 0, discoveries: ["empty"] }),
  { pillar: "filters", id: "10", name: "My open bugs", usage: "low", impact: "high", discoveries: [], owner: "Sam", ownerActive: false, subscriptions: 3, lastUsed: "2026-01-01T00:00:00.000Z" },
  { pillar: "filters", id: "11", name: "Team board", usage: "high", impact: "low", discoveries: [], owner: null, ownerActive: null, subscriptions: 0, lastUsed: "2026-09-20T00:00:00.000Z" },
  { pillar: "priorities", id: "20", name: "Blocker", usage: "unmeasured", impact: "unmeasured", discoveries: [], kind: "Priority" },
];

const ids = (text) => {
  const r = runOql(ENTITIES, text, catalog, { now: NOW });
  if (!r.ok) throw new Error(r.error.message);
  return r.results.map((e) => e.id);
};
const error = (text) => parseOql(text, catalog, { now: NOW }).error;

describe("tokenize", () => {
  it("splits words, strings, operators and punctuation with positions", () => {
    const t = tokenize('name ~ "Bug Create" AND x>=3');
    expect(t.map((x) => x.value)).toEqual(["name", "~", "Bug Create", "AND", "x", ">=", "3"]);
    expect(t[2]).toMatchObject({ type: "string", start: 7, end: 19 });
  });
  it("keeps hyphenated finding codes and issue keys as one word", () => {
    expect(tokenize("findings = no-owner").map((x) => x.value)).toEqual(["findings", "=", "no-owner"]);
  });
  it("rejects an unterminated string unless lenient", () => {
    expect(() => tokenize('name = "abc')).toThrow(/never closed/);
    expect(tokenize('name = "abc', { lenient: true }).at(-1)).toMatchObject({ type: "string", open: true, value: "abc" });
  });
});

describe("parseOql / runOql", () => {
  it("answers the headline query", () => {
    expect(ids("pillar = screens AND usage = low AND impact = high")).toEqual(["1"]);
  });

  it("is case-insensitive in keywords, fields and enumerated values", () => {
    expect(ids("PILLAR = Screens and USAGE = LOW and Impact = High")).toEqual(["1"]);
  });

  it("accepts pillar aliases and labels", () => {
    expect(ids('pillar = "saved filters"')).toEqual(["10", "11"]);
    expect(ids("pillar = screen")).toEqual(["1", "2", "3"]);
  });

  it("binds AND tighter than OR, and honours parentheses and NOT", () => {
    expect(ids("usage = high OR usage = low AND impact = low")).toEqual(["2", "3", "11"]);
    expect(ids("(usage = high OR usage = low) AND impact = low")).toEqual(["3", "11"]);
    expect(ids("pillar = screens AND NOT discoveries IS NOT EMPTY")).toEqual(["1"]);
  });

  it("supports IN and NOT IN", () => {
    expect(ids("pillar IN (filters, priorities)")).toEqual(["10", "11", "20"]);
    expect(ids("pillar = screens AND id NOT IN (1, 2)")).toEqual(["3"]);
  });

  it("compares numbers, and levels by their order", () => {
    expect(ids("fields > 25")).toEqual(["1", "2"]);
    expect(ids("projects <= 1")).toEqual(["1", "3"]);
    expect(ids("pillar = screens AND usage > low")).toEqual(["2"]);
    expect(ids("impact >= medium AND pillar = filters")).toEqual(["10"]);
  });

  it("matches list fields by element, and ~ by substring", () => {
    expect(ids("discoveries = unreached")).toEqual(["2"]);
    expect(ids("discoveries IS NOT EMPTY")).toEqual(["2", "3"]);
    // "findings" still works: it is what the field was called first.
    expect(ids("findings = unreached")).toEqual(["2"]);
    expect(ids("name ~ screen")).toEqual(["2"]);
    expect(ids("name !~ e AND pillar = filters")).toEqual([]);
  });

  it("treats unmeasured as its own value, never as low", () => {
    expect(ids("usage = unmeasured")).toEqual(["20"]);
    expect(ids("usage = low")).not.toContain("20");
    expect(ids("usage < high")).not.toContain("20");
  });

  it("never matches a comparison on a field an item does not have -- including !=", () => {
    expect(ids("owner != Sam")).toEqual([]);
    expect(ids("owner = Sam")).toEqual(["10"]);
    expect(ids("owner IS EMPTY AND pillar = filters")).toEqual(["11"]);
    expect(ids("subscriptions != 3")).toEqual(["11"]);
  });

  it("compares dates, including relative ones", () => {
    expect(ids("lastUsed < -90d")).toEqual(["10"]);
    expect(ids("lastUsed > 2026-06-01")).toEqual(["11"]);
    expect(ids("lastUsed = 2026-01-01")).toEqual(["10"]);
  });

  it("parses booleans as true/false/yes/no", () => {
    expect(ids("ownerActive = false")).toEqual(["10"]);
    expect(ids("ownerActive = no")).toEqual(["10"]);
  });

  it("orders by a field, blanks last either way", () => {
    expect(ids("pillar = screens ORDER BY fields DESC")).toEqual(["1", "2", "3"]);
    expect(ids("pillar = screens ORDER BY fields")).toEqual(["3", "2", "1"]);
    expect(ids("ORDER BY subscriptions DESC").slice(0, 2)).toEqual(["10", "11"]);
    expect(ids("ORDER BY usage DESC").at(-1)).toBe("20");
  });

  it("treats an empty query as everything", () => {
    expect(ids("")).toHaveLength(ENTITIES.length);
  });
});

describe("errors", () => {
  it("names an unknown field and suggests the nearest", () => {
    expect(error("pilar = screens")).toEqual({ message: 'Unknown field "pilar". Did you mean "pillar"?', start: 0, end: 5 });
  });
  it("names an unknown enumerated value and suggests the nearest", () => {
    expect(error("usage = lo").message).toBe('"lo" is not a usage. Did you mean "low"?');
    expect(error("pillar = screns").message).toMatch(/Did you mean "screens"/);
  });
  it("rejects operators a field's kind does not support", () => {
    expect(error("ownerActive > true").message).toMatch(/does not support >/);
    expect(error("usage > unmeasured").message).toMatch(/unmeasured has no order/);
  });
  it("rejects values of the wrong type", () => {
    expect(error("fields > many").message).toMatch(/is a number/);
    expect(error("lastUsed < yesterday").message).toMatch(/is a date/);
    expect(error("ownerActive = maybe").message).toMatch(/true or false/);
  });
  it("points at structural mistakes", () => {
    expect(error("usage = low impact = high").message).toBe('Expected AND or OR before "impact".');
    expect(error("(usage = low").message).toMatch(/never closed/);
    expect(error("usage = low)").message).toMatch(/no matching \(/);
    expect(error("usage =").message).toMatch(/Expected a value/);
    expect(error("usage").message).toMatch(/Expected an operator/);
    expect(error("pillar IN screens").message).toMatch(/Expected \( after IN/);
    expect(error("ORDER usage").message).toMatch(/Expected BY/);
    expect(error("name = $").message).toMatch(/not part of the language/);
    expect(error("name = AND").message).toMatch(/keyword AND/);
  });
});

describe("pinnedPillars", () => {
  const pins = (text) => {
    const p = pinnedPillars(parseOql(text, catalog).query.where);
    return p ? [...p].sort() : null;
  };
  it("finds the pillars a top-level AND pins", () => {
    expect(pins("pillar = screens AND usage = low")).toEqual(["screens"]);
    expect(pins("usage = low AND pillar IN (fields, screens)")).toEqual(["fields", "screens"]);
    expect(pins("pillar = screens OR pillar = fields")).toEqual(["fields", "screens"]);
  });
  it("is null whenever any pillar could match", () => {
    expect(pins("usage = low")).toBeNull();
    expect(pins("pillar = screens OR usage = low")).toBeNull();
    expect(pins("pillar != screens")).toBeNull();
    expect(pins("NOT pillar = screens")).toBeNull();
    expect(pinnedPillars(null)).toBeNull();
  });
});

describe("evaluate / sortEntities", () => {
  it("matches everything with no expression, and leaves order alone with no ORDER BY", () => {
    expect(evaluate(null, {})).toBe(true);
    expect(sortEntities(ENTITIES, null)).toBe(ENTITIES);
  });
});

describe("suggestOql", () => {
  const labels = (text, cursor) => suggestOql(text, cursor ?? text.length, catalog).items.map((i) => i.label);

  it("offers fields at the start, and filters by what is typed", () => {
    expect(labels("")).toContain("pillar");
    expect(labels("us")).toEqual(expect.arrayContaining(["usage", "usageValue"]));
    expect(labels("us")[0]).toBe("usage");
  });
  it("offers operators for the field's kind", () => {
    expect(labels("usage ")).toEqual(["=", "!=", ">", ">=", "<", "<=", "IN", "NOT IN"]);
    expect(labels("ownerActive ")).toEqual(["=", "!="]);
  });
  it("offers enumerated values after an operator, and inside IN lists", () => {
    expect(labels("usage = ")).toEqual(["low", "medium", "high", "unmeasured"]);
    expect(labels("usage =")).toEqual(["low", "medium", "high", "unmeasured"]);
    expect(labels("pillar = scr")).toEqual(["screens"]);
    expect(labels("pillar IN (fields, ")).toContain("screens");
    expect(labels("discoveries = ")).toEqual(["empty", "no-owner", "unreached"]);
  });
  it("offers connectors after a complete clause, and ) inside parentheses", () => {
    expect(labels("usage = low ")).toEqual(["AND", "OR", "ORDER BY"]);
    expect(labels("(usage = low ")).toEqual(["AND", "OR", ")"]);
    expect(labels("usage = low ORDER BY impact ")).toEqual(["ASC", "DESC"]);
  });
  it("replaces the partial word under the cursor", () => {
    expect(suggestOql("pillar = scr", 12, catalog)).toMatchObject({ from: 9, to: 12 });
    expect(suggestOql("usage = ", 8, catalog)).toMatchObject({ from: 8, to: 8 });
  });
  it("never throws on a half-typed query", () => {
    for (const text of ['name = "Bug', "pillar IN (", "((", "usage IS ", "usage IS NOT ", "x y z", ")", "usage NOT "]) {
      expect(() => suggestOql(text, text.length, catalog)).not.toThrow();
    }
    expect(labels("usage IS ")).toEqual(["EMPTY", "NOT EMPTY"]);
    expect(labels("usage NOT ")).toEqual(["IN"]);
  });
  it("quotes a value that needs it", () => {
    const cat = { fields: [{ key: "kind", kind: "enum", values: ["Saved filter"] }] };
    expect(suggestOql("kind = ", 7, cat).items[0].insert).toBe('"Saved filter"');
  });
});
