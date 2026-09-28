import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@forge/sql", () => ({ sql: { prepare: vi.fn() } }));
const { sql } = await import("@forge/sql");

vi.mock("./core.js", () => ({
  ensureProjectStoreReady: vi.fn().mockResolvedValue(undefined),
  withSqlRetry: (op) => op(),
  toNumber: (v, f = 0) => (Number.isFinite(Number(v)) ? Number(v) : f),
  chunkArray: (items, size) => {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  },
}));

const {
  recordRemediationTicket,
  loadRemediationTickets,
  loadRemediationTicketsToSync,
  getRemediationEpic,
  loadTicketedItemIds,
  updateRemediationSync,
  recordRemediationTickets,
  currentPeriod,
} = await import("./remediation.js");

// Capture the bound params of every prepared statement.
function stubSql(rowsByCall = []) {
  const calls = [];
  let n = 0;
  sql.prepare.mockImplementation((text) => ({
    bindParams: (...params) => {
      calls.push({ text, params });
      return { execute: async () => ({ rows: rowsByCall[n++] ?? [] }) };
    },
  }));
  return calls;
}

beforeEach(() => {
  sql.prepare.mockReset();
});

describe("recordRemediationTicket", () => {
  it("upserts an epic with item_id '' and is_epic 1", async () => {
    const calls = stubSql();
    await recordRemediationTicket("scope", {
      findingKey: "filter-ownership", pillar: "filters", isEpic: true,
      issueKey: "OPS-1", issueId: "10001", epicKey: "OPS-1",
      summary: "Reassign 5 filters", createdBy: "acc-1", createdAt: "2026-09-10T00:00:00Z",
      period: "2026-Q3",
    });
    expect(calls[0].text).toMatch(/INSERT INTO remediation_tickets_v2/);
    const p = calls[0].params;
    expect(p[0]).toBe("scope");
    expect(p[1]).toBe("filter-ownership");
    expect(p[2]).toBe("2026-Q3"); // period
    expect(p[4]).toBe("");        // item_id
    expect(p[5]).toBe("OPS-1");   // issue_key
    expect(p[7]).toBe(1);         // is_epic
  });

  it("upserts a task with its item id and is_epic 0", async () => {
    const calls = stubSql();
    await recordRemediationTicket("scope", {
      findingKey: "filter-ownership", itemId: "4001", issueKey: "OPS-2", issueId: "10002", epicKey: "OPS-1",
    });
    const p = calls[0].params;
    expect(p[4]).toBe("4001");
    expect(p[7]).toBe(0);
    // No period given: the row is filed under the quarter it is written in.
    expect(p[2]).toBe(currentPeriod());
  });

  it("truncates a long summary to the column width", async () => {
    const calls = stubSql();
    await recordRemediationTicket("scope", { findingKey: "x", itemId: "1", issueKey: "OPS-9", summary: "z".repeat(900) });
    expect(calls[0].params[9].length).toBe(500);
  });
});

describe("getRemediationEpic", () => {
  it("queries by finding, quarter and item_id '' and maps the row", async () => {
    const calls = stubSql([[{
      finding_key: "filter-ownership", period: "2026-Q3", pillar: "filters", item_id: "", issue_key: "OPS-1", issue_id: "10001",
      is_epic: 1, epic_key: "OPS-1", summary: "Reassign filters", last_status: null, last_status_category: null,
      assignee_account_id: null, assignee_name: null, created_by: "acc-1", created_at: "t", synced_at: null,
    }]]);
    const epic = await getRemediationEpic("scope", "filter-ownership", "2026-Q3");
    expect(calls[0].params).toEqual(["scope", "filter-ownership", "2026-Q3", ""]);
    expect(epic).toMatchObject({ issueKey: "OPS-1", isEpic: true, findingKey: "filter-ownership", period: "2026-Q3" });
  });

  it("returns null when no epic row exists", async () => {
    stubSql([[]]);
    expect(await getRemediationEpic("scope", "nope")).toBeNull();
  });
});

describe("loadTicketedItemIds", () => {
  it("returns the set of non-epic item ids for a finding", async () => {
    stubSql([[{ item_id: "4001" }, { item_id: "4002" }]]);
    const set = await loadTicketedItemIds("scope", "filter-ownership", "2026-Q3");
    expect(set).toBeInstanceOf(Set);
    expect([...set].sort()).toEqual(["4001", "4002"]);
  });

  // The quarter rule lives in this WHERE clause: skip anything ticketed this quarter, and
  // anything still open from an earlier one. A done task from an earlier quarter is NOT
  // skipped -- the item came back and belongs in this quarter's epic.
  it("skips this quarter's items and earlier quarters' still-open ones, not earlier done ones", async () => {
    const calls = stubSql([[]]);
    await loadTicketedItemIds("scope", "filter-ownership", "2026-Q4");
    expect(calls[0].params).toEqual(["scope", "filter-ownership", "2026-Q4"]);
    expect(calls[0].text).toMatch(/period = \? OR last_status_category IS NULL OR last_status_category != 'done'/);
  });
});

describe("currentPeriod", () => {
  it("names the calendar quarter in UTC", () => {
    expect(currentPeriod(new Date("2026-01-01T00:00:00Z"))).toBe("2026-Q1");
    expect(currentPeriod(new Date("2026-03-31T23:59:59Z"))).toBe("2026-Q1");
    expect(currentPeriod(new Date("2026-04-01T00:00:00Z"))).toBe("2026-Q2");
    expect(currentPeriod(new Date("2026-09-24T12:00:00Z"))).toBe("2026-Q3");
    expect(currentPeriod(new Date("2026-12-31T23:59:59Z"))).toBe("2026-Q4");
  });

  it("accepts an ISO string or epoch", () => {
    expect(currentPeriod("2027-05-02T00:00:00Z")).toBe("2027-Q2");
    expect(currentPeriod(Date.UTC(2027, 10, 1))).toBe("2027-Q4");
  });
});

describe("loadRemediationTickets", () => {
  it("scopes to one finding when given a key, epic first", async () => {
    const calls = stubSql([[
      { finding_key: "f", item_id: "", issue_key: "OPS-1", is_epic: 1 },
      { finding_key: "f", item_id: "1", issue_key: "OPS-2", is_epic: 0 },
    ]]);
    const rows = await loadRemediationTickets("scope", "f");
    expect(calls[0].text).toMatch(/finding_key = \?/);
    expect(calls[0].params).toEqual(["scope", "f"]);
    expect(rows[0].isEpic).toBe(true);
  });

  it("returns everything for the scope when no key is given", async () => {
    const calls = stubSql([[]]);
    await loadRemediationTickets("scope");
    expect(calls[0].params).toEqual(["scope"]);
    expect(calls[0].text).not.toMatch(/finding_key = \?/);
  });
});

describe("loadRemediationTicketsToSync", () => {
  it("queries tickets not done, done without a date, or done inside the reopen window", async () => {
    const calls = stubSql([[{ finding_key: "f", item_id: "1", issue_key: "OPS-2", is_epic: 0, done_at: "2026-09-20T00:00:00.000Z" }]]);
    const rows = await loadRemediationTicketsToSync("scope", "2026-08-29T16:00:00.000Z");
    expect(calls[0].params).toEqual(["scope", "2026-08-29T16:00:00.000Z"]);
    expect(calls[0].text).toMatch(/last_status_category IS NULL OR last_status_category != 'done'/);
    expect(calls[0].text).toMatch(/OR done_at IS NULL OR done_at >= \?/);
    expect(rows[0].doneAt).toBe("2026-09-20T00:00:00.000Z");
  });
});

describe("updateRemediationSync", () => {
  it("writes only the live fields, keyed by scope + issue key", async () => {
    const calls = stubSql();
    await updateRemediationSync("scope", "OPS-2", {
      lastStatus: "In Progress", lastStatusCategory: "indeterminate",
      assigneeAccountId: "acc-9", assigneeName: "Sam", syncedAt: "2026-09-10T01:00:00Z",
    });
    expect(calls[0].text).toMatch(/UPDATE remediation_tickets/);
    expect(calls[0].text).not.toMatch(/issue_key =\s*VALUES|finding_key/);
    const p = calls[0].params;
    expect(p).toEqual(["In Progress", "indeterminate", "acc-9", "Sam", "2026-09-10T01:00:00Z", null, null, "scope", "OPS-2"]);
  });

  it("defaults synced_at to now when omitted", async () => {
    const calls = stubSql();
    await updateRemediationSync("scope", "OPS-2", { lastStatus: "Done" });
    expect(calls[0].params[4]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("recordRemediationTickets", () => {
  it("records each row in the batch", async () => {
    const calls = stubSql();
    await recordRemediationTickets("scope", [
      { findingKey: "f", itemId: "1", issueKey: "OPS-2" },
      { findingKey: "f", itemId: "2", issueKey: "OPS-3" },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0].params[4]).toBe("1");
    expect(calls[1].params[4]).toBe("2");
  });
});
