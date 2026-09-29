import { describe, it, expect } from "vitest";
import {
  quartileLevels, buildEntityIndex, buildOqlCatalog, OQL_PILLARS, PILLAR_MEASURES, OQL_EXAMPLES, MIN_ROWS_FOR_LEVELS,
  riskLevel, churnLevel, attentionScore, changeEntityKey, SCORE_WEIGHTS, CHURN_TRACKED_PILLARS,
} from "./oql-index.js";
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
    expect(s1).toMatchObject({ pillar: "screens", pillarLabel: "Screens", name: "S1", usage: "low", impact: "low", usageValue: 0, impactValue: 5, discoveries: ["unreached"], uid: "screens:1" });
    // Screens have no change history: churn is unmeasured, and the score stands on three dimensions.
    expect(s1).toMatchObject({ risk: "medium", riskValue: 1, churn: "unmeasured", churnValue: null, scoreDimensions: 3 });
    expect(s1.findings).toBeUndefined();
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
    expect(catalog.fields.slice(0, 9).map((f) => f.key)).toEqual(["pillar", "name", "id", "usage", "impact", "risk", "churn", "score", "discoveries"]);
    const projects = catalog.fields.find((f) => f.key === "projects");
    expect(projects.kind).toBe("number");
    expect(projects.pillars).toEqual(expect.arrayContaining(["screens", "workflows", "access", "issueTypes", "automation"]));
    expect(catalog.fields.filter((f) => f.key === "name")).toHaveLength(1);
    expect(catalog.fields.find((f) => f.key === "discoveries").aliases).toContain("findings");
    expect(catalog.fields.filter((f) => f.key === "findings")).toHaveLength(0);
    const fieldsCol = catalog.fields.find((f) => f.key === "fields");
    expect(fieldsCol.labels).toMatchObject({ projects: "Fields in use", screens: "Fields" });
  });

  it("offers the finding codes it is given, de-duplicated", () => {
    expect(catalog.fields.find((f) => f.key === "discoveries").values).toEqual(["a", "b"]);
  });

  it("parses every example query", () => {
    for (const ex of OQL_EXAMPLES) expect(parseOql(ex.query, catalog).ok).toBe(true);
  });
});

describe("risk, churn and the attention score", () => {
  it("levels risk by discovery count and churn by change count", () => {
    expect([0, 1, 2, 5].map(riskLevel)).toEqual(["low", "medium", "high", "high"]);
    expect([0, 1, 2, 3].map(churnLevel)).toEqual(["low", "medium", "medium", "high"]);
    expect(churnLevel(null)).toBe("unmeasured");
  });

  it("weights the four dimensions, and they sum to one", () => {
    expect(Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(attentionScore({ usage: "high", impact: "high", risk: "high", churn: "high" })).toEqual({ score: 100, measured: 4 });
    expect(attentionScore({ usage: "low", impact: "low", risk: "low", churn: "low" })).toEqual({ score: 0, measured: 4 });
    // risk 0.4 + impact 0.25 * 0.5 = 0.525
    expect(attentionScore({ usage: "low", impact: "medium", risk: "high", churn: "low" }).score).toBe(53);
  });

  it("leaves unmeasured dimensions out rather than counting them as zero", () => {
    // Only risk (high) and impact (low) measured: 0.4 / 0.65.
    expect(attentionScore({ usage: "unmeasured", impact: "low", risk: "high", churn: "unmeasured" })).toEqual({ score: 62, measured: 2 });
  });

  it("gives no score on a single dimension", () => {
    expect(attentionScore({ usage: "unmeasured", impact: "unmeasured", risk: "high", churn: "unmeasured" })).toEqual({ score: null, measured: 1 });
  });

  it("maps change log rows onto the entities they changed", () => {
    expect(changeEntityKey({ entityType: "field", entityId: "customfield_1" })).toBe("fields|customfield_1");
    expect(changeEntityKey({ entityType: "workflow-scheme", entityId: "10" })).toBe("workflows|10");
    expect(changeEntityKey({ entityType: "priority", entityId: "3" })).toBe("priorities|priority|3");
    expect(changeEntityKey({ entityType: "permission-scheme", entityId: "7" })).toBe("access|permission|7");
    expect(changeEntityKey({ entityType: "permission-grant", entityId: "7:BROWSE:group:jira-users" })).toBe("access|permission|7");
    expect(changeEntityKey({ entityType: "project-role-grant", entityId: "10002:x:user:abc" })).toBe("access|project-role|10002");
    expect(changeEntityKey({ entityType: "security-level", entityId: "5:100" })).toBe("access|security|5");
    expect(changeEntityKey({ entityType: "status", entityId: "1" })).toBeNull();
  });

  it("counts churn over the window for tracked pillars, and none for the rest", () => {
    const now = new Date("2026-09-28T00:00:00.000Z");
    const fields = buildPillarReport("fields", {
      fields: ["a", "b", "c", "d"].map((id) => ({ id, name: id, totalIssueCount: 1, configuredProjectCount: 1 })),
    });
    const access = buildPillarReport("access", {
      inventory: { permissions: { schemes: [{ id: "7", name: "Default", projectCount: 3 }], holders: [] }, roles: { schemes: [{ id: "7", name: "Devs", projectCount: 1 }], holders: [] } },
    });
    const screens = buildPillarReport("screens", { screens: [{ screenId: "1", name: "S", tabsResolved: "resolved", fieldCount: 1 }] });
    const changes = [
      { entityType: "field", entityId: "a", detectedAt: "2026-09-20T00:00:00Z" },
      { entityType: "field", entityId: "a", detectedAt: "2026-09-21T00:00:00Z" },
      { entityType: "field", entityId: "a", detectedAt: "2026-09-22T00:00:00Z" },
      { entityType: "field", entityId: "b", detectedAt: "2026-07-01T00:00:00Z" }, // outside 30 days
      { entityType: "permission-grant", entityId: "7:BROWSE:group:g", detectedAt: "2026-09-25T00:00:00Z" },
    ];
    const { entities } = buildEntityIndex([fields, access, screens], { changes, now });
    const by = (uid) => entities.find((e) => e.uid === uid);
    expect(by("fields:a")).toMatchObject({ churn: "high", churnValue: 3 });
    expect(by("fields:b")).toMatchObject({ churn: "low", churnValue: 0 });
    // Same id, different kind of scheme: only the permission scheme changed.
    expect(by("access:Permission scheme:7")).toMatchObject({ churn: "medium", churnValue: 1 });
    expect(by("access:Project role:7")).toMatchObject({ churn: "low", churnValue: 0 });
    expect(by("screens:1")).toMatchObject({ churn: "unmeasured", churnValue: null });
    expect(CHURN_TRACKED_PILLARS).not.toContain("screens");
  });

  it("calls churn unmeasured everywhere when no drift pass has run", () => {
    const fields = buildPillarReport("fields", { fields: [{ id: "a", name: "a" }] });
    expect(buildEntityIndex([fields]).entities[0]).toMatchObject({ churn: "unmeasured", churnValue: null });
  });
});
