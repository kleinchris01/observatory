import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  ignoreWith: () => () => undefined,
}));

const getIssuesStatus = vi.fn();
vi.mock("./jira-api.js", () => ({ getIssuesStatus: (...args) => getIssuesStatus(...args) }));

const loadOpenRemediationTickets = vi.fn();
const updateRemediationSync = vi.fn().mockResolvedValue(undefined);
vi.mock("./store/remediation.js", () => ({
  loadOpenRemediationTickets: (...args) => loadOpenRemediationTickets(...args),
  updateRemediationSync: (...args) => updateRemediationSync(...args),
}));

const { syncRemediationTickets } = await import("./remediation-sync.js");

beforeEach(() => {
  getIssuesStatus.mockReset();
  loadOpenRemediationTickets.mockReset();
  updateRemediationSync.mockReset().mockResolvedValue(undefined);
});

describe("syncRemediationTickets", () => {
  it("does nothing, with no Jira call, when there are no open tickets", async () => {
    loadOpenRemediationTickets.mockResolvedValue([]);
    const result = await syncRemediationTickets("scope");
    expect(getIssuesStatus).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 0, updated: 0 });
  });

  it("writes the live status back for every ticket Jira still returns", async () => {
    loadOpenRemediationTickets.mockResolvedValue([
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
    loadOpenRemediationTickets.mockResolvedValue([{ issueKey: "OPS-1" }, { issueKey: "OPS-DELETED" }]);
    getIssuesStatus.mockResolvedValue([
      { key: "OPS-1", status: "Done", statusCategory: "done", assigneeAccountId: null, assigneeName: null },
    ]);

    const result = await syncRemediationTickets("scope");

    expect(updateRemediationSync).toHaveBeenCalledTimes(1);
    expect(updateRemediationSync).toHaveBeenCalledWith("scope", "OPS-1", expect.anything());
    expect(result).toEqual({ checked: 2, updated: 1 });
  });

  it("does not let one failed write stop the rest of the batch", async () => {
    loadOpenRemediationTickets.mockResolvedValue([{ issueKey: "OPS-1" }, { issueKey: "OPS-2" }]);
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
});
