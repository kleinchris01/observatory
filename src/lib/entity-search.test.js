import { describe, test, expect } from "vitest";
import {
  entityMatchRank, rankEntityMatches, toEntitySearchRow,
  ENTITY_SEARCH_MIN_TERM, ENTITY_SEARCH_MAX_LIMIT,
} from "./entity-search.js";

const e = (name, id, over = {}) => ({ uid: `x:${id}`, pillar: "fields", pillarLabel: "Fields", name, id, ...over });

describe("entityMatchRank", () => {
  test("ranks exact name, exact id, prefix, word start, id prefix, contains, id contains", () => {
    expect(entityMatchRank(e("Plant", "customfield_11412"), "plant")).toBe(0);
    expect(entityMatchRank(e("Approver groups", "customfield_10501"), "customfield_10501")).toBe(0.5);
    expect(entityMatchRank(e("Plant code", "1"), "plant")).toBe(1);
    expect(entityMatchRank(e("Build Deviation", "1"), "deviation")).toBe(2);
    expect(entityMatchRank(e("Labor (Plant) Impact", "1"), "plant")).toBe(2);
    expect(entityMatchRank(e("Other", "customfield_11664"), "customfield_116")).toBe(2.5);
    expect(entityMatchRank(e("Implant", "1"), "plant")).toBe(3);
    expect(entityMatchRank(e("Other", "customfield_11664"), "11664")).toBe(4);
  });

  test("finds a word start past an earlier mid-word occurrence", () => {
    expect(entityMatchRank(e("Implant Plant", "1"), "plant")).toBe(2);
  });

  test("is case-insensitive and ignores surrounding space", () => {
    expect(entityMatchRank(e("SOLVE Hub", "SOLVE"), "  solve ")).toBe(0.5);
  });

  test("returns null for no match, a blank term, or a missing name and id", () => {
    expect(entityMatchRank(e("Plant", "1"), "zzz")).toBeNull();
    expect(entityMatchRank(e("Plant", "1"), "   ")).toBeNull();
    expect(entityMatchRank({}, "plant")).toBeNull();
  });
});

describe("rankEntityMatches", () => {
  const entities = [
    e("Implant", "1"),
    e("Plant code", "2"),
    e("Plant", "3"),
    e("Labor (Plant) Impact", "4"),
    e("Zebra", "5"),
  ];

  test("orders best match first and counts every match", () => {
    const { total, results } = rankEntityMatches(entities, "plant");
    expect(total).toBe(4);
    expect(results.map((r) => r.name)).toEqual(["Plant", "Plant code", "Labor (Plant) Impact", "Implant"]);
  });

  test("breaks ties on shorter name, then alphabetically, then pillar", () => {
    const tied = [
      e("Plant bb", "1", { pillar: "screens" }),
      e("Plant aa", "2", { pillar: "fields" }),
      e("Plant", "3", { pillar: "screens" }),
      e("Plant", "4", { pillar: "fields" }),
    ];
    expect(rankEntityMatches(tied, "plant").results.map((r) => `${r.pillar}:${r.name}`))
      .toEqual(["fields:Plant", "screens:Plant", "fields:Plant aa", "screens:Plant bb"]);
  });

  test("a term shorter than the minimum matches nothing", () => {
    expect(ENTITY_SEARCH_MIN_TERM).toBe(2);
    expect(rankEntityMatches(entities, "p")).toEqual({ total: 0, results: [] });
  });

  test("caps the result count at the limit and the hard maximum", () => {
    const many = Array.from({ length: 80 }, (_, i) => e(`Plant ${i}`, String(i)));
    expect(rankEntityMatches(many, "plant", { limit: 5 }).results).toHaveLength(5);
    expect(rankEntityMatches(many, "plant", { limit: 999 }).results).toHaveLength(ENTITY_SEARCH_MAX_LIMIT);
    expect(rankEntityMatches(many, "plant", { limit: "nonsense" }).results).toHaveLength(20);
    expect(rankEntityMatches(many, "plant").total).toBe(80);
  });

  test("handles no input", () => {
    expect(rankEntityMatches()).toEqual({ total: 0, results: [] });
  });
});

describe("toEntitySearchRow", () => {
  test("keeps only what the palette needs, including the sub-list kind and type", () => {
    const row = toEntitySearchRow({ ...e("High", "2", { pillar: "priorities", pillarLabel: "Priorities", kind: "Priority" }), usage: "low", score: 40 }, 1);
    expect(row).toEqual({ uid: "x:2", pillar: "priorities", pillarLabel: "Priorities", name: "High", id: "2", kind: "Priority", type: null, rank: 1 });
  });
});
