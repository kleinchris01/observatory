import { describe, it, expect } from "vitest";
import { computeRemediationMetrics, periodBounds, AGE_BUCKETS } from "./remediation-metrics.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const PERIOD = "2026-Q3";

// A task row as the store maps it. Open unless `doneAt` is given.
function task(over = {}) {
  const done = Boolean(over.doneAt);
  return {
    findingKey: "field-cleanup",
    period: PERIOD,
    pillar: "fields",
    itemId: over.itemId || String(Math.random()),
    issueKey: "OPS-1",
    isEpic: false,
    createdAt: "2026-09-01T09:00:00.000Z",
    lastStatusCategory: done ? "done" : "new",
    syncedAt: "2026-09-28T08:00:00.000Z",
    assigneeName: null,
    doneAt: null,
    ...over,
  };
}

describe("periodBounds", () => {
  it("gives a quarter's first and last day", () => {
    const b = periodBounds("2026-Q3");
    expect(b.start.toISOString().slice(0, 10)).toBe("2026-07-01");
    expect(b.end.toISOString().slice(0, 10)).toBe("2026-09-30");
    expect(periodBounds("2026-Q1").end.toISOString().slice(0, 10)).toBe("2026-03-31");
  });
  it("is null for anything that is not a quarter", () => {
    expect(periodBounds("nonsense")).toBeNull();
  });
});

describe("computeRemediationMetrics", () => {
  it("counts only tasks, never epics", () => {
    const m = computeRemediationMetrics({
      tickets: [task(), { ...task(), isEpic: true }], now: NOW, period: PERIOD,
    });
    expect(m.totals.tasks).toBe(1);
  });

  it("totals open, closed, percent and recent closures", () => {
    const m = computeRemediationMetrics({
      tickets: [
        task(),
        task({ assigneeName: "Sam" }),
        task({ doneAt: "2026-09-27T10:00:00.000Z" }), // 1 day ago
        task({ doneAt: "2026-09-10T10:00:00.000Z" }), // 18 days ago
      ],
      now: NOW, period: PERIOD,
    });
    expect(m.totals).toMatchObject({ tasks: 4, open: 2, closed: 2, pctClosed: 50, closedLast7: 1, closedLast30: 2, unassignedOpen: 1 });
  });

  it("scopes to this quarter unless asked for everything", () => {
    const tickets = [task(), task({ period: "2026-Q2", createdAt: "2026-05-01T00:00:00.000Z" })];
    expect(computeRemediationMetrics({ tickets, now: NOW, period: PERIOD }).totals.tasks).toBe(1);
    expect(computeRemediationMetrics({ tickets, now: NOW, period: PERIOD, scope: "all" }).totals.tasks).toBe(2);
  });

  it("takes the median time to close from created to done", () => {
    const m = computeRemediationMetrics({
      tickets: [
        task({ createdAt: "2026-09-01T00:00:00.000Z", doneAt: "2026-09-03T00:00:00.000Z" }), // 2 days
        task({ createdAt: "2026-09-01T00:00:00.000Z", doneAt: "2026-09-11T00:00:00.000Z" }), // 10 days
        task({ createdAt: "2026-09-01T00:00:00.000Z", doneAt: "2026-09-05T00:00:00.000Z" }), // 4 days
      ],
      now: NOW, period: PERIOD,
    });
    expect(m.timing.medianDaysToClose).toBe(4);
  });

  it("buckets open work by age and reports the oldest", () => {
    const m = computeRemediationMetrics({
      tickets: [
        task({ createdAt: "2026-09-26T12:00:00.000Z" }), // 2 days
        task({ createdAt: "2026-09-08T12:00:00.000Z" }), // 20 days
        task({ createdAt: "2026-07-01T12:00:00.000Z" }), // 89 days
      ],
      now: NOW, period: PERIOD,
    });
    expect(m.ageing.map((b) => b.count)).toEqual([1, 1, 1, 0]);
    expect(m.ageing.map((b) => b.key)).toEqual(AGE_BUCKETS.map((b) => b.key));
    expect(m.timing.oldestOpenDays).toBe(89);
  });

  it("projects a clear date from the last two weeks' pace, and says whether that beats quarter end", () => {
    const closedRecently = Array.from({ length: 14 }, (_, i) =>
      task({ doneAt: new Date(NOW.getTime() - (i + 1) * 86400000).toISOString() }));
    const m = computeRemediationMetrics({ tickets: [...closedRecently, task(), task()], now: NOW, period: PERIOD });
    expect(m.timing.ratePerWeek).toBe(7); // 1 a day
    expect(m.timing.projectedClearDate).toBe("2026-09-30"); // 2 open at 1/day
    expect(m.timing.onTrack).toBe(true);
  });

  it("has no projection when nothing closed recently, rather than inventing one", () => {
    const m = computeRemediationMetrics({ tickets: [task()], now: NOW, period: PERIOD });
    expect(m.timing.projectedClearDate).toBeNull();
    expect(m.timing.onTrack).toBeNull();
  });

  it("draws the burn-down from the first task to quarter end, with open counts only up to today", () => {
    const m = computeRemediationMetrics({
      tickets: [
        task({ createdAt: "2026-09-25T09:00:00.000Z" }),
        task({ createdAt: "2026-09-25T09:00:00.000Z", doneAt: "2026-09-27T09:00:00.000Z" }),
      ],
      now: NOW, period: PERIOD,
    });
    expect(m.burndown.map((p) => p.date)).toEqual(["2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"]);
    expect(m.burndown.map((p) => p.open)).toEqual([2, 2, 1, 1, null, null]);
    // Pace: from the first day's 2 open to zero at quarter end.
    expect(m.burndown[0].pace).toBe(2);
    expect(m.burndown[m.burndown.length - 1].pace).toBe(0);
  });

  it("puts a done task with no done date on the burn-down at its sync time", () => {
    const m = computeRemediationMetrics({
      tickets: [task({ createdAt: "2026-09-26T09:00:00.000Z", lastStatusCategory: "done", syncedAt: "2026-09-27T16:00:00.000Z" })],
      now: NOW, period: PERIOD,
    });
    expect(m.burndown.map((p) => p.open).slice(0, 3)).toEqual([1, 0, 0]);
  });

  it("counts closures and new tasks per week for the last 12 weeks", () => {
    const m = computeRemediationMetrics({
      tickets: [
        task({ createdAt: "2026-09-28T08:00:00.000Z", doneAt: "2026-09-28T09:00:00.000Z" }), // this week (Mon 28 Sep)
        task({ createdAt: "2026-09-21T08:00:00.000Z", doneAt: "2026-09-22T09:00:00.000Z" }), // last week
      ],
      now: NOW, period: PERIOD,
    });
    expect(m.throughput).toHaveLength(12);
    expect(m.throughput[11]).toEqual({ weekStart: "2026-09-28", closed: 1, created: 1 });
    expect(m.throughput[10]).toEqual({ weekStart: "2026-09-21", closed: 1, created: 1 });
  });

  it("breaks down by finding, most open first, with labels from the catalog", () => {
    const m = computeRemediationMetrics({
      tickets: [
        task({ findingKey: "a" }),
        task({ findingKey: "b" }), task({ findingKey: "b" }), task({ findingKey: "b", doneAt: "2026-09-20T00:00:00.000Z" }),
      ],
      now: NOW, period: PERIOD, labels: { a: "Finding A", b: "Finding B" },
    });
    expect(m.byFinding[0]).toMatchObject({ findingKey: "b", label: "Finding B", total: 3, open: 2, closed: 1, pctClosed: 33 });
    expect(m.byFinding[1].label).toBe("Finding A");
  });

  it("groups open work by assignee, folding the tail into 'Everyone else'", () => {
    const people = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
    const m = computeRemediationMetrics({ tickets: people.map((p) => task({ assigneeName: p })), now: NOW, period: PERIOD });
    expect(m.byAssignee).toHaveLength(9);
    expect(m.byAssignee[8]).toEqual({ name: "Everyone else", count: 2 });
  });

  it("counts items that came back after being closed in an earlier quarter", () => {
    const m = computeRemediationMetrics({
      tickets: [
        task({ itemId: "x", period: "2026-Q2", doneAt: "2026-06-01T00:00:00.000Z" }),
        task({ itemId: "x" }),
        task({ itemId: "y" }),
      ],
      now: NOW, period: PERIOD,
    });
    expect(m.totals.cameBack).toBe(1);
  });

  it("reports the last sync and how many tasks have never synced", () => {
    const m = computeRemediationMetrics({
      tickets: [task({ syncedAt: "2026-09-28T08:00:00.000Z" }), task({ syncedAt: null })],
      now: NOW, period: PERIOD,
    });
    expect(m.sync).toEqual({ lastSyncedAt: "2026-09-28T08:00:00.000Z", neverSynced: 1 });
  });

  it("is empty but well formed with no tickets", () => {
    const m = computeRemediationMetrics({ tickets: [], now: NOW, period: PERIOD });
    expect(m.totals.tasks).toBe(0);
    expect(m.totals.pctClosed).toBeNull();
    expect(m.burndown).toEqual([]);
  });
});
