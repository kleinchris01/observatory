import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  ignoreWith: () => () => undefined,
}));

const getIssuesStatus = vi.fn();
vi.mock("./jira-api.js", () => ({ getIssuesStatus: (...args) => getIssuesStatus(...args) }));

const loadRemediationTicketsToSync = vi.fn();
const updateRemediationSync = vi.fn().mockResolvedValue(undefined);
vi.mock("./store/remediation.js", () => ({
  loadRemediationTicketsToSync: (...args) => loadRemediationTicketsToSync(...args),
  updateRemediationSync: (...args) => updateRemediationSync(...args),
}));

const { syncRemediationTickets, resolveDoneAt, REOPEN_WINDOW_DAYS } = await import("./remediation-sync.js");

beforeEach(() => {
  getIssuesStatus.mockReset();
  loadRemediationTicketsToSync.mockReset();
  updateRemediationSync.mockReset().mockResolvedValue(undefined);
});

describe("syncRemediationTickets", () => {
  it("does nothing, with no Jira call, when there are no open tickets", async () => {
    loadRemediationTicketsToSync.mockResolvedValue([]);
    const result = await syncRemediationTickets("scope");
    expect(getIssuesStatus).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 0, updated: 0 });
  });

  it("writes the live status back for every ticket Jira still returns", async () => {
    loadRemediationTicketsToSync.mockResolvedValue([
      { issueKey: "OPS-1" }, { issueKey: "OPS-2" },
    ]);
    getIssuesStatus.mockResolvedValue([
      { key: "OPS-1", status: "In Progress", statusCategory: "indeterminate", assigneeAccountId: "acc-1", assigneeName: "Sam" },
      { key: "OPS-2", status: "Done", statusCategory: "done", assigneeAccountId: "acc-2", assigneeName: "Ann" },
    ]);

    const result = await syncRemediationTickets("scope");

    expect(updateRemediationSync).toHaveBeenCalledTimes(2);
    expect(updateRemediationSync).toHaveBeenCalledWith("scope", "OPS-1", expect.objectContaining({
      lastStatus: "In Progress", lastStatusCategory: "indeterminate", assigneeAccountId: "acc-1", assigneeName: "Sam",
    }));
    expect(result).toEqual({ checked: 2, updated: 2 });
  });

  it("leaves a ticket's stored status alone when Jira no longer returns it, rather than blanking it", async () => {
    loadRemediationTicketsToSync.mockResolvedValue([{ issueKey: "OPS-1" }, { issueKey: "OPS-DELETED" }]);
    getIssuesStatus.mockResolvedValue([
      { key: "OPS-1", status: "Done", statusCategory: "done", assigneeAccountId: null, assigneeName: null },
    ]);

    const result = await syncRemediationTickets("scope");

    expect(updateRemediationSync).toHaveBeenCalledTimes(1);
    expect(updateRemediationSync).toHaveBeenCalledWith("scope", "OPS-1", expect.anything());
    expect(result).toEqual({ checked: 2, updated: 1 });
  });

  it("does not let one failed write stop the rest of the batch", async () => {
    loadRemediationTicketsToSync.mockResolvedValue([{ issueKey: "OPS-1" }, { issueKey: "OPS-2" }]);
    getIssuesStatus.mockResolvedValue([
      { key: "OPS-1", status: "Done", statusCategory: "done" },
      { key: "OPS-2", status: "Done", statusCategory: "done" },
    ]);
    updateRemediationSync.mockRejectedValueOnce(new Error("sql down")).mockResolvedValueOnce(undefined);

    const result = await syncRemediationTickets("scope");

    expect(updateRemediationSync).toHaveBeenCalledTimes(2);
    // Both counted as "checked against Jira and written" -- the write failure is swallowed
    // and logged, same posture as every other per-item loop in this store family.
    expect(result).toEqual({ checked: 2, updated: 2 });
  });

  it("asks the store for everything not done, plus anything done in the reopen window", async () => {
    loadRemediationTicketsToSync.mockResolvedValue([]);
    const now = new Date("2026-09-28T16:00:00.000Z");
    await syncRemediationTickets("scope", now);
    const since = new Date(now.getTime() - REOPEN_WINDOW_DAYS * 86400000).toISOString();
    expect(loadRemediationTicketsToSync).toHaveBeenCalledWith("scope", since);
  });

  it("records when a ticket was done, from Jira's resolution date", async () => {
    loadRemediationTicketsToSync.mockResolvedValue([{ issueKey: "OPS-1" }]);
    getIssuesStatus.mockResolvedValue([{
      key: "OPS-1", status: "Done", statusCategory: "done",
      resolvedAt: "2026-09-27T10:00:00.000Z", statusCategoryChangedAt: "2026-09-27T10:05:00.000Z",
    }]);
    await syncRemediationTickets("scope", new Date("2026-09-28T16:00:00.000Z"));
    expect(updateRemediationSync).toHaveBeenCalledWith("scope", "OPS-1", expect.objectContaining({
      doneAt: "2026-09-27T10:00:00.000Z", statusChangedAt: "2026-09-27T10:05:00.000Z",
    }));
  });

  // The gap this closes: the sync used to stop reading a ticket the moment it was Done, so a
  // reopen in Jira was never seen and the tab showed it Done for good.
  it("clears the done date when a ticket has been reopened", async () => {
    loadRemediationTicketsToSync.mockResolvedValue([{ issueKey: "OPS-1", lastStatusCategory: "done", doneAt: "2026-09-20T00:00:00.000Z" }]);
    getIssuesStatus.mockResolvedValue([{ key: "OPS-1", status: "Reopened", statusCategory: "indeterminate" }]);
    await syncRemediationTickets("scope");
    expect(updateRemediationSync).toHaveBeenCalledWith("scope", "OPS-1", expect.objectContaining({
      lastStatusCategory: "indeterminate", doneAt: null,
    }));
  });
});

describe("resolveDoneAt", () => {
  const syncedAt = "2026-09-28T16:00:00.000Z";
  it("is null for anything not done", () => {
    expect(resolveDoneAt({ statusCategory: "indeterminate", resolvedAt: "x" }, null, syncedAt)).toBeNull();
  });
  it("prefers the resolution date, then the status-category change, then the stored date, then now", () => {
    expect(resolveDoneAt({ statusCategory: "done", resolvedAt: "a", statusCategoryChangedAt: "b" }, { doneAt: "c" }, syncedAt)).toBe("a");
    expect(resolveDoneAt({ statusCategory: "done", statusCategoryChangedAt: "b" }, { doneAt: "c" }, syncedAt)).toBe("b");
    expect(resolveDoneAt({ statusCategory: "done" }, { doneAt: "c" }, syncedAt)).toBe("c");
    expect(resolveDoneAt({ statusCategory: "done" }, null, syncedAt)).toBe(syncedAt);
  });
});
