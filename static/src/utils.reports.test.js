import { describe, test, expect, vi } from "vitest";
import {
  PILLAR_REPORT_NAV,
  pillarNavStatus,
  readStored,
  writeStored,
  ROVO_AGENTS,
  SCORECARD_ATTENTION_BELOW,
  buildPillarReportRovoPrompt,
  buildScorecardReport,
  formatReportCell,
  reportToCsvRows,
} from "./utils";

describe("PILLAR_REPORT_NAV", () => {
  test("covers the fourteen pillars once each", () => {
    const keys = PILLAR_REPORT_NAV.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(14);
  });

  test("every named agent is a registered Rovo agent", () => {
    for (const { agent } of PILLAR_REPORT_NAV) {
      if (agent) expect(ROVO_AGENTS[agent]).toBeDefined();
    }
  });
});

describe("formatReportCell", () => {
  test("blank for unknown, never a fake zero or No", () => {
    expect(formatReportCell(null, "number")).toBe("");
    expect(formatReportCell(undefined, "boolean")).toBe("");
  });

  test("formats by kind", () => {
    expect(formatReportCell(0, "number")).toBe("0");
    expect(formatReportCell(true, "boolean")).toBe("Yes");
    expect(formatReportCell(false, "boolean")).toBe("No");
    expect(formatReportCell(["a", "b"], "list")).toBe("a; b");
    expect(formatReportCell("x", "text")).toBe("x");
  });
});

describe("reportToCsvRows", () => {
  const report = {
    label: "Saved filters",
    refreshedAt: "2026-09-01T00:00:00Z",
    columns: [
      { key: "name", label: "Name", kind: "text" },
      { key: "subs", label: "Subscriptions", kind: "number" },
      { key: "findings", label: "Findings", kind: "list" },
    ],
    rows: [
      { name: "=HYPERLINK(\"http://evil\")", subs: -1, findings: ["stale", "orphaned-owner"] },
      { name: "Plain", subs: null, findings: [] },
    ],
  };

  test("leads with what the export is and how old it is, then the header", () => {
    const rows = reportToCsvRows(report);
    expect(rows[0]).toEqual(["Saved filters report", "Snapshot 2026-09-01T00:00:00Z"]);
    expect(rows[1]).toEqual(["Name", "Subscriptions", "Findings"]);
  });

  test("neutralizes formula-like text but leaves numbers alone", () => {
    const [, , first, second] = reportToCsvRows(report);
    expect(first[0]).toBe("'=HYPERLINK(\"http://evil\")");
    expect(first[1]).toBe("-1");
    expect(first[2]).toBe("stale; orphaned-owner");
    expect(second).toEqual(["Plain", "", ""]);
  });

  test("says when the snapshot time is unknown", () => {
    expect(reportToCsvRows({ ...report, refreshedAt: null })[0][1]).toBe("Snapshot time unknown");
  });
});

describe("buildScorecardReport", () => {
  const health = {
    score: 74,
    grade: "C",
    dimensionsScored: 2,
    dimensionsTotal: 3,
    pillars: [
      {
        key: "fields", label: "Fields", available: true, score: 80,
        dimensions: [
          { key: "a", label: "Reach", available: true, score: 95, detail: "fine" },
          { key: "b", label: "Hygiene", available: true, score: SCORECARD_ATTENTION_BELOW - 1, detail: "poor" },
        ],
      },
      {
        key: "boards", label: "Boards", available: false, score: null,
        dimensions: [{ key: "c", label: "Backing", available: false, reason: "No board inventory." }],
      },
    ],
  };

  test("unavailable, with a reason, until health has been scored", () => {
    expect(buildScorecardReport(null)).toMatchObject({ status: "unavailable", rows: [] });
  });

  test("one row per dimension, sub-threshold rows flagged and first", () => {
    const report = buildScorecardReport(health, { scoredAt: "2026-09-24T10:00:00Z" });
    expect(report.status).toBe("ok");
    expect(report.refreshedAt).toBe("2026-09-24T10:00:00Z");
    expect(report.total).toBe(3);
    expect(report.flaggedCount).toBe(1);
    expect(report.rows[0]).toMatchObject({ dimension: "Hygiene", findings: ["needs-attention"] });
  });

  test("an unmeasured dimension carries its reason, not a score", () => {
    const row = buildScorecardReport(health).rows.find((r) => r.dimension === "Backing");
    expect(row).toMatchObject({ score: null, pillarScore: null, detail: "No board inventory.", findings: [] });
  });

  test("summarizes the site score and coverage", () => {
    const tiles = Object.fromEntries(buildScorecardReport(health).summary.map((t) => [t.label, t]));
    expect(tiles["Site score"]).toMatchObject({ value: 74, hint: "Grade C" });
    expect(tiles["Pillars measured"].value).toBe("1 / 2");
    expect(tiles["Dimensions scored"].value).toBe("2 / 3");
    expect(tiles["Needing attention"]).toMatchObject({ value: 1, tone: "warning" });
  });

  test("its columns and rows export through the same CSV path", () => {
    const rows = reportToCsvRows(buildScorecardReport(health));
    expect(rows[1]).toEqual(["Pillar", "Pillar score", "Dimension", "Score", "Detail", "Findings"]);
  });
});

describe("buildPillarReportRovoPrompt", () => {
  test("sends totals and the most common finding codes, not the rows", () => {
    const prompt = buildPillarReportRovoPrompt({
      label: "Boards",
      entity: "boards",
      refreshedAt: "2026-09-01",
      total: 3,
      flaggedCount: 2,
      rows: [
        { name: "secret-board-name", findings: ["no-backing-filter"] },
        { name: "b", findings: ["no-backing-filter", "unmapped-column"] },
        { name: "c", findings: [] },
      ],
    });
    expect(prompt).toMatch(/Summarise the Boards report/);
    expect(prompt).toMatch(/Total boards: 3\./);
    expect(prompt).toMatch(/Most common findings: no-backing-filter \(2\), unmapped-column \(1\)\./);
    expect(prompt).not.toMatch(/secret-board-name/);
  });

  test("omits the findings fact when there are none", () => {
    expect(buildPillarReportRovoPrompt({ label: "Changes", rows: [] })).not.toMatch(/Most common/);
  });
});

describe("pillarNavStatus", () => {
  const pillar = (key, over = {}) => ({ key, label: key, available: true, score: 90, ...over });

  test("null before health loads, and for tabs that are not pillars", () => {
    expect(pillarNavStatus("boards", null)).toBeNull();
    expect(pillarNavStatus("reports", { pillars: [] })).toBeNull();
  });

  test("unmeasured, with the pillar's own reason, when nothing is scored", () => {
    const health = { pillars: [pillar("boards", { available: false, score: null, reason: "No board inventory." })] };
    expect(pillarNavStatus("boards", health)).toEqual({ state: "unmeasured", label: "No board inventory." });
  });

  test("attention when a scored pillar is under the scorecard's line; ok otherwise", () => {
    expect(pillarNavStatus("boards", { pillars: [pillar("boards", { score: 69 })] })).toMatchObject({ state: "attention", label: "boards scores 69" });
    expect(pillarNavStatus("boards", { pillars: [pillar("boards", { score: 70 })] })).toEqual({ state: "ok", label: null });
  });

  test("a multi-pillar tab (Access) is judged across all of its health pillars", () => {
    const health = {
      pillars: [
        pillar("permissions", { score: 95 }),
        pillar("security", { available: false, score: null }),
        pillar("notifications", { score: 40, label: "Notification schemes" }),
        pillar("roles", { score: 88 }),
      ],
    };
    expect(pillarNavStatus("access", health)).toEqual({ state: "attention", label: "Notification schemes scores 40" });
  });

  test("every pillar's health keys are real HEALTH_PILLARS keys", () => {
    const known = new Set(["fields", "filters", "dashboards", "workflows", "screens", "issueTypes", "users", "assets", "permissions", "security", "notifications", "roles", "estate", "boards", "automation", "projects", "drift"]);
    for (const p of PILLAR_REPORT_NAV) for (const k of p.health) expect(known.has(k), `${p.key} -> ${k}`).toBe(true);
  });
});

describe("readStored / writeStored", () => {
  test("round-trips, and removes on null", () => {
    writeStored("k", "v");
    expect(readStored("k")).toBe("v");
    writeStored("k", null);
    expect(readStored("k", "fallback")).toBe("fallback");
  });

  test("never throws when storage is blocked", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementationOnce(() => { throw new Error("SecurityError"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("QuotaExceeded"); });
    expect(readStored("k", "fallback")).toBe("fallback");
    expect(() => writeStored("k", "v")).not.toThrow();
    get.mockRestore();
    set.mockRestore();
  });
});
