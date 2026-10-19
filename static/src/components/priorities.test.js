import { describe, test, expect, vi } from "vitest";
import { rankPriorities, effortOf, formatLift, UNSCORED_LIFT, EFFORT_UNKNOWN } from "./priorities";

// Health in the shape computeSiteHealth returns: pillars with their checks.
const health = {
  pillars: [
    {
      key: "automation",
      available: true,
      score: 60,
      dimensions: [
        { key: "automation-security", available: true, score: 40, weight: 2 },
        { key: "automation-hygiene", available: true, score: 80, weight: 1 },
      ],
    },
    {
      key: "filters",
      available: true,
      score: 80,
      dimensions: [{ key: "filter-hygiene", available: true, score: 80, weight: 1 }],
    },
    {
      key: "fields",
      available: true,
      score: 100,
      dimensions: [{ key: "field-hygiene", available: true, score: 100, weight: 1 }],
    },
  ],
};

// Ledger rows in buildGovernanceLedger's shape.
const finding = (key, count, onOpen = vi.fn()) => ({ key, count, onOpen });
const row = (over) => ({ available: true, findings: [], unscored: false, action: null, detail: null, ...over });
const ledger = {
  pillars: [
    {
      key: "automation",
      label: "Automation",
      rows: [
        row({
          key: "automation-security",
          label: "Automation security",
          band: "critical",
          score: 40,
          action: "Move the credentials into a secret store.",
          findings: [finding("automation-credentials", 4)],
        }),
        row({
          key: "automation-hygiene",
          label: "Automation hygiene",
          band: "info",
          score: 80,
          findings: [finding("automation-disabled", 120)],
        }),
      ],
    },
    {
      key: "filters",
      label: "Filters",
      rows: [
        row({
          key: "filter-hygiene",
          label: "Filter hygiene",
          band: "warning",
          score: 80,
          findings: [finding("filters-orphaned", 2)],
        }),
      ],
    },
    {
      key: "fields",
      label: "Fields",
      rows: [
        row({ key: "field-hygiene", label: "Field hygiene", band: "clear", score: 100 }),
        row({
          key: "field-no-populated-issues",
          label: "Fields suggested for cleanup",
          band: "info",
          unscored: true,
          count: 1204,
          onOpen: vi.fn(),
        }),
      ],
    },
  ],
};

describe("rankPriorities", () => {
  test("ranks across pillars by lift x urgency / effort, skipping clear rows", () => {
    const { items } = rankPriorities({ ledger, health });
    expect(items.map((i) => i.key)).toEqual([
      "automation-security",
      "filter-hygiene",
      "automation-hygiene",
      "field-no-populated-issues",
    ]);
  });

  test("carries the exact score lift, the item count and the way in", () => {
    const [first] = rankPriorities({ ledger, health }).items;
    // Automation is weight 2 of a headline weight of 4.5 (automation 2 + filters 1 + fields
    // 1.5), and this check is 2/3 of its pillar.
    expect(first.lift).toBeCloseTo(60 * (2 / 3) * (2 / 4.5), 10);
    expect(first).toMatchObject({
      count: 4,
      band: "critical",
      pillarLabel: "Automation",
      action: "Move the credentials into a secret store.",
    });
    expect(first.onOpen).toBe(ledger.pillars[0].rows[0].findings[0].onOpen);
  });

  test("gives an unscored finding the nominal lift, never a fabricated one", () => {
    const unscored = rankPriorities({ ledger, health }).items.find((i) => i.key === "field-no-populated-issues");
    expect(unscored.lift).toBeNull();
    expect(unscored.value).toBeCloseTo((UNSCORED_LIFT * 1) / effortOf(1204), 10);
  });

  test("more items to touch ranks the same lift lower", () => {
    const one = row({ key: "a", label: "A", band: "warning", findings: [finding("fa", 1)] });
    const many = row({ key: "b", label: "B", band: "warning", findings: [finding("fb", 500)] });
    const h = {
      pillars: [
        {
          key: "filters",
          available: true,
          score: 50,
          dimensions: [
            { key: "a", available: true, score: 50, weight: 1 },
            { key: "b", available: true, score: 50, weight: 1 },
          ],
        },
      ],
    };
    const { items } = rankPriorities({ ledger: { pillars: [{ key: "filters", rows: [many, one] }] }, health: h });
    expect(items.map((i) => i.key)).toEqual(["a", "b"]);
  });

  test("moves work already in progress this quarter out of the list, and counts it", () => {
    const remediation = {
      findingIndex: { "automation-credentials": "automation-credentials", "filters-orphaned": "filter-ownership" },
      groups: [
        { findingKey: "automation-credentials", isCurrent: true, openCount: 3 },
        { findingKey: "filter-ownership", isCurrent: true, openCount: 0 },
      ],
    };
    const result = rankPriorities({ ledger, health, remediation });
    expect(result.items.map((i) => i.key)).not.toContain("automation-security");
    expect(result.inProgress.map((i) => i.key)).toEqual(["automation-security"]);
    // Closed work is not "in progress": the finding is back on the list, with its playbook.
    expect(result.items.find((i) => i.key === "filter-hygiene")).toMatchObject({
      inProgress: false,
      playbook: "filter-ownership",
    });
  });

  test("an earlier quarter's open epic does not count as this quarter's work", () => {
    const remediation = {
      findingIndex: { "automation-credentials": "automation-credentials" },
      groups: [{ findingKey: "automation-credentials", isCurrent: false, openCount: 5 }],
    };
    expect(rankPriorities({ ledger, health, remediation }).items[0].key).toBe("automation-security");
  });

  test("limits the list and reports what is left", () => {
    const result = rankPriorities({ ledger, health, limit: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.remaining).toBe(2);
    expect(result.totalLift).toBeCloseTo(
      result.items.reduce((s, i) => s + (i.lift ?? 0), 0),
      10,
    );
  });

  test("a scored check at 100 with an urgent finding still competes, at the nominal lift", () => {
    const l = {
      pillars: [
        {
          key: "fields",
          rows: [
            row({ key: "field-hygiene", label: "Field hygiene", band: "critical", findings: [finding("risky", 3)] }),
          ],
        },
      ],
    };
    const [only] = rankPriorities({ ledger: l, health }).items;
    expect(only).toMatchObject({ key: "field-hygiene", lift: 0 });
    expect(only.value).toBeCloseTo((UNSCORED_LIFT * 3) / effortOf(3), 10);
  });

  test("is empty without a ledger", () => {
    expect(rankPriorities({ ledger: null, health })).toMatchObject({ items: [], remaining: 0, inProgress: [] });
  });
});

describe("helpers", () => {
  test("effortOf dampens with a log and has a middle value for unknown counts", () => {
    expect(effortOf(0)).toBe(EFFORT_UNKNOWN);
    expect(effortOf(null)).toBe(EFFORT_UNKNOWN);
    expect(effortOf(9)).toBeCloseTo(2, 10);
    expect(effortOf(99)).toBeCloseTo(3, 10);
  });

  test("formatLift reads as points", () => {
    expect(formatLift(2.44)).toBe("+2.4 points");
    expect(formatLift(1)).toBe("+1.0 point");
    expect(formatLift(0.01)).toBe("under 0.1 points");
    expect(formatLift(null)).toBeNull();
  });
});
