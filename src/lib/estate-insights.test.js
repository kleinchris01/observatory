import { describe, test, expect } from "vitest";
import { summarizeEstateInsights, summarizeEstateHealth } from "./estate-insights.js";

describe("summarizeEstateInsights", () => {
  test("clusters near-duplicate resolutions and reports what consolidation would remove", () => {
    const s = summarizeEstateInsights({
      resolutions: [
        { id: "1", name: "Done", isDefault: true },
        { id: "2", name: "done" },        // spacing/case dup of "Done"
        { id: "3", name: "Complete" },
        { id: "4", name: "Won't Fix" },
      ],
      priorities: [
        { id: "10", name: "High", isDefault: false },
        { id: "11", name: "Medium", isDefault: true },
        { id: "12", name: "Low" },
      ],
    });

    expect(s.available).toBe(true);
    expect(s.totalResolutions).toBe(4);
    expect(s.resolutionDuplicateGroupCount).toBe(1);
    expect(s.reducibleResolutionCount).toBe(1); // one group of 2 -> collapse removes 1
    expect(s.priorityDuplicateGroupCount).toBe(0);
    expect(s.reduciblePriorityCount).toBe(0);
  });

  test("flags a list with no default", () => {
    const s = summarizeEstateInsights({
      resolutions: [{ id: "1", name: "Done" }],
      priorities: [{ id: "10", name: "High", isDefault: true }],
    });
    expect(s.resolutionsWithoutDefault).toBe(true);
    expect(s.prioritiesWithoutDefault).toBe(false);
  });

  test("reports unavailable on empty input, and health follows", () => {
    const s = summarizeEstateInsights({});
    expect(s.available).toBe(false);
    expect(summarizeEstateHealth(s)).toEqual({ available: false });
  });

  test("health carries the rate inputs when available", () => {
    const s = summarizeEstateInsights({
      resolutions: [{ id: "1", name: "Done" }, { id: "2", name: "Done " }],
      priorities: [{ id: "10", name: "High" }],
    });
    expect(summarizeEstateHealth(s)).toMatchObject({
      available: true, totalResolutions: 2, totalPriorities: 1, reducibleResolutionCount: 1,
    });
  });
});

describe("summarizeEstateInsights listLimit", () => {
  it("lists every duplicate group for remediation", () => {
    const priorities = Array.from({ length: 30 }, (_, i) => [{ id: `${i}a`, name: `P${i}` }, { id: `${i}b`, name: `p${i}` }]).flat();
    expect(summarizeEstateInsights({ priorities }).priorityDuplicateGroups).toHaveLength(25);
    expect(summarizeEstateInsights({ priorities, listLimit: Infinity }).priorityDuplicateGroups).toHaveLength(30);
  });
});
