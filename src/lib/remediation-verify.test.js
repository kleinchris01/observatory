import { describe, test, expect } from "vitest";
import { verifyTickets, verificationComment, targetCategory } from "./remediation-verify.js";

const task = (over) => ({ findingKey: "filter-ownership", pillar: "filters", period: "2026-Q4", isEpic: false, lastStatusCategory: "indeterminate", lastStatus: "In Progress", summary: "s", ...over });
const current = (ids, available = true) => new Map([["filter-ownership", { available, ids: new Set(ids) }]]);
const verdictOf = (result, issueKey) => result.rows.find((r) => r.issueKey === issueKey).verdict;

describe("verifyTickets", () => {
  test("classifies every combination of closed/open and still/no longer flagged", () => {
    const result = verifyTickets({
      tickets: [
        task({ issueKey: "R-1", itemId: "10", lastStatusCategory: "done" }),
        task({ issueKey: "R-2", itemId: "11", lastStatusCategory: "done" }),
        task({ issueKey: "R-3", itemId: "12" }),
        task({ issueKey: "R-4", itemId: "13" }),
        task({ issueKey: "R-E", itemId: "", isEpic: true, lastStatusCategory: "done" }),
      ],
      current: current(["11", "12"]),
    });
    expect(verdictOf(result, "R-1")).toBe("held");
    expect(verdictOf(result, "R-2")).toBe("regressed");
    expect(verdictOf(result, "R-3")).toBe("open");
    expect(verdictOf(result, "R-4")).toBe("fixed-open");
    expect(result.rows.map((r) => r.issueKey)).not.toContain("R-E");
    expect(result.counts).toMatchObject({ held: 1, regressed: 1, open: 1, "fixed-open": 1 });
    expect(result.heldRate).toBe(0.5);
  });

  test("an item re-ticketed in a later quarter supersedes the older task", () => {
    const result = verifyTickets({
      tickets: [
        task({ issueKey: "OLD", itemId: "10", period: "2026-Q3", lastStatusCategory: "done" }),
        task({ issueKey: "NEW", itemId: "10", period: "2026-Q4" }),
      ],
      current: current(["10"]),
    });
    expect(verdictOf(result, "OLD")).toBe("superseded");
    expect(verdictOf(result, "NEW")).toBe("open");
  });

  // Nothing can be claimed about a finding whose current items were not read.
  test("an unreadable finding leaves its tasks unverified, with the reason", () => {
    const result = verifyTickets({
      tickets: [task({ issueKey: "R-1", itemId: "10", lastStatusCategory: "done" })],
      current: new Map([["filter-ownership", { available: false, ids: new Set(), reason: "no-snapshot" }]]),
    });
    expect(result.rows[0]).toMatchObject({ verdict: "unverified", reason: "no-snapshot" });
    expect(verifyTickets({ tickets: [task({ issueKey: "X", itemId: "1" })] }).rows[0].verdict).toBe("unverified");
  });

  test("has no held rate until something has closed", () => {
    expect(verifyTickets({ tickets: [task({ issueKey: "R-1", itemId: "1" })], current: current(["1"]) }).heldRate).toBeNull();
    expect(verifyTickets().rows).toEqual([]);
  });

  test("matches item ids as strings", () => {
    const result = verifyTickets({ tickets: [task({ issueKey: "R-1", itemId: 10, lastStatusCategory: "done" })], current: current(["10"]) });
    expect(result.rows[0].verdict).toBe("regressed");
  });
});

describe("verificationComment and targetCategory", () => {
  const row = { findingKey: "filter-ownership", itemId: "10", verdict: "regressed" };

  test("explains a reopen with the date and the item", () => {
    const text = verificationComment(row, { checkedAt: "2026-10-14T09:00:00Z", findingLabel: "Filter ownership" });
    expect(text).toContain("Reopened by Observatory: the fix did not hold.");
    expect(text).toContain("the scan checked on 2026-10-14 still flags this item under Filter ownership (filter-ownership) (item 10)");
  });

  test("explains a close", () => {
    expect(verificationComment({ ...row, verdict: "fixed-open" }, {})).toContain("Closed by Observatory: the item is fixed.");
  });

  test("offers an action only where one applies", () => {
    expect(targetCategory("regressed")).toBe("reopen");
    expect(targetCategory("fixed-open")).toBe("done");
    expect(targetCategory("held")).toBeNull();
    expect(verificationComment({ ...row, verdict: "held" }, {})).toBeNull();
  });
});
