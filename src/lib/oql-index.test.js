import { describe, it, expect } from "vitest";
import { quartileLevels, buildEntityIndex, buildOqlCatalog, OQL_PILLARS, PILLAR_MEASURES, OQL_EXAMPLES, MIN_ROWS_FOR_LEVELS } from "./oql-index.js";
import { buildPillarReport, unavailableReport } from "./pillar-reports.js";
import { parseOql } from "./oql.js";

describe("quartileLevels", () => {
  it("puts the bottom quarter low, the top quarter high, the middle medium", () => {
    const { levelOf, p25, p75 } = quartileLevels([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([p25, p75]).toEqual([2, 6]);
    expect([1, 2, 3, 5, 6, 8].map(levelOf)).toEqual(["low", "low", "medium", "medium", "high", "high"]);
  });

  it("calls a blank unmeasured, never low", () => {
    const { levelOf, measured, total } = quartileLevels([1, 2, null, 3, 4, 5]);
    expect(levelOf(null)).toBe("unmeasured");
    expect({ measured, total }).toEqual({ measured: 5, total: 6 });
  });

  it("handles a pillar where most rows share the bottom value", () => {
    const { levelOf } = quartileLevels([0, 0, 0, 0, 0, 0, 5, 9]);
    expect(levelOf(0)).toBe("low");
    expect(levelOf(5)).toBe("high");
  });

  it("does not invent a spread with too few measured rows", () => {
    const { levelOf, p25 } = quartileLevels([1, 100, null]);
    expect(MIN_ROWS_FOR_LEVELS).toBe(4);
    expect(p25).toBeNull();
    expect([levelOf(1), levelOf(100), levelOf(null)]).toEqual(["medium", "medium", "unmeasured"]);
  });

  it("calls a shared bottom value low, and a shared middle value medium", () => {
    const { levelOf } = quartileLevels([3, 3, 3, 3, 3]);
    expect(levelOf(3)).toBe("low");
    const mixed = quartileLevels([1, 5, 5, 5, 5, 5, 5, 9]);
    expect([mixed.levelOf(1), mixed.levelOf(5), mixed.levelOf(9)]).toEqual(["low", "medium", "high"]);
  });
});

describe("buildEntityIndex", () => {
  const screens = buildPillarReport("screens", {
    refreshedAt: "2026-09-28T00:00:00.000Z",
    screens: Array.from({ length: 8 }, (_, i) => ({ screenId: String(i + 1), name: `S${i + 1}`, tabCount: 1, fieldCount: (i + 1) * 5, tabsResolved: "resolved" })),
    unreachedIds: new Set(["1"]),
    projectsByScreen: new Map([["1", 0], ["2", 1], ["3", 2], ["4", 3], ["5", 10], ["6", 20], ["7", 30], ["8", 40]]),
  });

  it("adds per-pillar usage and impact levels and their thresholds", () => {
    const { entities, thresholds } = buildEntityIndex([screens]);
    const s1 = entities.find((e) => e.id === "1");
    expect(s1).toMatchObject({ pillar: "screens", pillarLabel: "Screens", name: "S1", usage: "low", impact: "low", usageValue: 0, impactValue: 5, findings: ["unreached"], uid: "screens:1" });
    expect(entities.find((e) => e.id === "8")).toMatchObject({ usage: "high", impact: "high" });
    expect(thresholds.screens.usage).toMatchObject({ p25: 1, p75: 20, measured: 8, total: 8, label: expect.stringMatching(/screen schemes/) });
  });

  it("lists unavailable pillars with their reason, and indexes nothing for them", () => {
    const { entities, pillars } = buildEntityIndex([screens, unavailableReport("filters", "Not built")]);
    expect(pillars.map((p) => [p.key, p.status, p.reason])).toEqual([["screens", "ok", null], ["filters", "unavailable", "Not built"]]);
    expect(entities.every((e) => e.pillar === "screens")).toBe(true);
  });

  it("marks a pillar with no signal unmeasured on every row", () => {
    const priorities = buildPillarReport("priorities", {
      priorities: [{ id: "1", name: "High" }, { id: "2", name: "Low" }],
      resolutions: [{ id: "1", name: "Done" }],
    });
    const { entities } = buildEntityIndex([priorities]);
    expect(entities.every((e) => e.usage === "unmeasured" && e.impact === "unmeasured")).toBe(true);
    // Priority 1 and resolution 1 share an id; the uid keeps them apart.
    expect(new Set(entities.map((e) => e.uid)).size).toBe(3);
  });

  it("uses account IDs for people and keys for projects", () => {
    const people = buildPillarReport("people", { users: [{ accountId: "abc", displayName: "Sam", active: true }] });
    const projects = buildPillarReport("projects", { projects: [{ projectId: "10", projectKey: "OPS", projectName: "Ops" }] });
    const { entities } = buildEntityIndex([people, projects]);
    expect(entities.map((e) => e.id)).toEqual(["abc", "OPS"]);
    expect(entities[0].name).toBe("Sam");
  });
});

describe("buildOqlCatalog", () => {
  const catalog = buildOqlCatalog({ findingCodes: ["b", "a", "a"] });

  it("covers every pillar except the change log, each with measures", () => {
    expect(OQL_PILLARS.map((p) => p.key)).not.toContain("changes");
    for (const p of OQL_PILLARS) expect(PILLAR_MEASURES[p.key]).toBeTruthy();
  });

  it("lists the core fields first, then every report column once, with the pillars it appears in", () => {
    expect(catalog.fields.slice(0, 6).map((f) => f.key)).toEqual(["pillar", "name", "id", "usage", "impact", "findings"]);
    const projects = catalog.fields.find((f) => f.key === "projects");
    expect(projects.kind).toBe("number");
    expect(projects.pillars).toEqual(expect.arrayContaining(["screens", "workflows", "access", "issueTypes", "automation"]));
    expect(catalog.fields.filter((f) => f.key === "name")).toHaveLength(1);
    const fieldsCol = catalog.fields.find((f) => f.key === "fields");
    expect(fieldsCol.labels).toMatchObject({ projects: "Fields in use", screens: "Fields" });
  });

  it("offers the finding codes it is given, de-duplicated", () => {
    expect(catalog.fields.find((f) => f.key === "findings").values).toEqual(["a", "b"]);
  });

  it("parses every example query", () => {
    for (const ex of OQL_EXAMPLES) expect(parseOql(ex.query, catalog).ok).toBe(true);
  });
});
