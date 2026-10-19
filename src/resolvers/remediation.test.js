import { vi, describe, test, expect, beforeEach, afterEach } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, ctxWithAccount } from "./test-harness.js";
import {
  SHARED_RESOLVER_FUNCTIONS,
  ADMIN_ONLY_FUNCTIONS,
  saveAdminConfigResolver,
  __RAW_ADMIN_ONLY_FUNCTIONS,
} from "../resolvers.js";
import { AUDITED_ADMIN_ACTIONS } from "./admin-guard.js";

const {
  createRemediationEpic,
  syncRemediationNow,
  getRemediationTickets,
  getRemediationMetrics,
  organiseRemediationHierarchy,
  getRemediationCandidates,
  getRemediationVerification,
  applyRemediationVerification,
} = __RAW_ADMIN_ONLY_FUNCTIONS;

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

describe("createRemediationEpic", () => {
  const ITEMS = [
    { id: "4001", name: "Open Bugs", ownerName: "Gone Person", ownerActive: false },
    { id: "4002", name: "Sprint Board Filter" },
  ];

  beforeEach(() => {
    mocks.kvsGet.mockResolvedValue({
      readOnlyMode: false,
      remediation: { projectKey: "ADMIN", epicIssueType: "Epic", taskIssueType: "Task", defaultAssigneeAccountId: "" },
    });
    mocks.getRemediationEpic.mockResolvedValue(null);
    mocks.loadTicketedItemIds.mockResolvedValue(new Set());
    mocks.createJiraIssue.mockImplementation(async (fields) => ({
      id: "1" + Math.random().toString().slice(2, 7),
      key: fields.parent ? `ADMIN-T${Math.floor(Math.random() * 999)}` : "ADMIN-1",
      self: "https://x",
    }));
  });

  test("refuses an unknown finding key", async () => {
    const r = await createRemediationEpic({
      payload: { findingKey: "not-real", items: ITEMS },
      context: ctxWithAccount(),
    });
    expect(r.error).toMatch(/No remediation playbook/);
    expect(mocks.createJiraIssue).not.toHaveBeenCalled();
  });

  test("refuses when read-only mode is on", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true, remediation: { projectKey: "ADMIN" } });
    const r = await createRemediationEpic({
      payload: { findingKey: "filter-ownership", items: ITEMS },
      context: ctxWithAccount(),
    });
    expect(r.error).toMatch(/Read-only mode/);
  });

  test("refuses when no remediation project is configured", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: false, remediation: { projectKey: "" } });
    const r = await createRemediationEpic({
      payload: { findingKey: "filter-ownership", items: ITEMS },
      context: ctxWithAccount(),
    });
    expect(r.error).toMatch(/No remediation project/);
  });

  test("creates the epic then a task per item, records every ticket, and returns a summary", async () => {
    const r = await createRemediationEpic({
      payload: { findingKey: "filter-ownership", items: ITEMS },
      context: ctxWithAccount("admin-1"),
    });

    expect(r).toMatchObject({
      ok: true,
      epicKey: "ADMIN-1",
      epicCreated: true,
      tasksCreated: 2,
      itemsTotal: 2,
      itemsRemaining: 0,
    });
    // 1 epic + 2 tasks
    expect(mocks.createJiraIssue).toHaveBeenCalledTimes(3);
    // Epic first, no parent; tasks carry parent + the reporter is the caller.
    const [epicFields, epicOpts] = mocks.createJiraIssue.mock.calls[0];
    expect(epicOpts).toEqual({ asUser: true });
    expect(epicFields.parent).toBeUndefined();
    expect(epicFields.reporter).toEqual({ id: "admin-1" });
    expect(epicFields.labels).toEqual(["observatory-remediation", "filters"]);
    expect(epicFields.description).toMatchObject({ type: "doc", version: 1 });
    const [taskFields] = mocks.createJiraIssue.mock.calls[1];
    expect(taskFields.parent).toEqual({ key: "ADMIN-1" });
    expect(mocks.recordRemediationTicket).toHaveBeenCalledTimes(3);
  });

  test("is idempotent: an existing epic is reused and only un-ticketed items get a task", async () => {
    mocks.getRemediationEpic.mockResolvedValue({ issueKey: "ADMIN-1", issueId: "10001" });
    mocks.loadTicketedItemIds.mockResolvedValue(new Set(["4001"]));

    const r = await createRemediationEpic({
      payload: { findingKey: "filter-ownership", items: ITEMS },
      context: ctxWithAccount(),
    });

    expect(r.epicCreated).toBe(false);
    expect(r.tasksCreated).toBe(1);
    // Only the task create, no epic create.
    expect(mocks.createJiraIssue).toHaveBeenCalledTimes(1);
    expect(mocks.createJiraIssue.mock.calls[0][0].parent).toEqual({ key: "ADMIN-1" });
  });

  test("a task-create failure is collected, not thrown, and the others still land", async () => {
    mocks.createJiraIssue
      .mockResolvedValueOnce({ id: "1", key: "ADMIN-1" }) // epic
      .mockRejectedValueOnce(Object.assign(new Error("field 'parent' cannot be set"), { status: 400 }))
      .mockResolvedValueOnce({ id: "3", key: "ADMIN-T2" }); // second task

    const r = await createRemediationEpic({
      payload: { findingKey: "filter-ownership", items: ITEMS },
      context: ctxWithAccount(),
    });

    expect(r.ok).toBe(true);
    expect(r.tasksCreated).toBe(1);
    expect(r.failures).toEqual([{ itemId: "4001", error: expect.stringContaining("parent") }]);
  });

  test("caps the synchronous batch and reports the remainder", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, name: `Filter ${i}` }));
    const r = await createRemediationEpic({
      payload: { findingKey: "filter-ownership", items: many },
      context: ctxWithAccount(),
    });
    expect(r.tasksCreated).toBe(20);
    expect(r.itemsRemaining).toBe(10);
  });

  test("stops starting tasks past the time budget and hands the rest back as itemsRemaining", async () => {
    // Each Jira create takes 4s of wall clock: a 20-task batch would blow the ~25s resolver
    // ceiling. Past 15s no new task starts, so the invocation returns instead of being killed.
    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    mocks.createJiraIssue.mockImplementation(async (fields) => {
      clock += 4000;
      return { id: String(clock), key: fields.parent ? `ADMIN-T${clock}` : "ADMIN-1" };
    });
    try {
      const many = Array.from({ length: 24 }, (_, i) => ({ id: `f${i}`, name: `Filter ${i}` }));
      const r = await createRemediationEpic({
        payload: { findingKey: "filter-ownership", items: many },
        context: ctxWithAccount(),
      });
      // Epic at 4s, tasks finish at 8, 12, 16 -- the fourth would start past 15s.
      expect(r.tasksCreated).toBe(3);
      expect(r.itemsRemaining).toBe(21);
      expect(r.failures).toEqual([]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("always attempts at least one task, however long the epic took", async () => {
    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    mocks.createJiraIssue.mockImplementation(async (fields) => {
      clock += fields.parent ? 1000 : 20000;
      return { id: String(clock), key: fields.parent ? `ADMIN-T${clock}` : "ADMIN-1" };
    });
    try {
      const r = await createRemediationEpic({
        payload: { findingKey: "filter-ownership", items: ITEMS },
        context: ctxWithAccount(),
      });
      expect(r.tasksCreated).toBe(1);
      expect(r.itemsRemaining).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("a failure creating the epic itself aborts with an error and no tasks", async () => {
    mocks.createJiraIssue.mockRejectedValueOnce(Object.assign(new Error("project ADMIN not found"), { status: 404 }));
    const r = await createRemediationEpic({
      payload: { findingKey: "filter-ownership", items: ITEMS },
      context: ctxWithAccount(),
    });
    expect(r.error).toMatch(/Creating the epic failed.*ADMIN not found/);
    expect(mocks.recordRemediationTicket).not.toHaveBeenCalled();
  });

  test("one epic per quarter: the summary names it, and lookup and dedupe are by it", async () => {
    await createRemediationEpic({
      payload: { findingKey: "filter-ownership", items: ITEMS },
      context: ctxWithAccount(),
    });
    expect(mocks.getRemediationEpic).toHaveBeenCalledWith("test-install", "filter-ownership", "2026-Q3");
    expect(mocks.loadTicketedItemIds).toHaveBeenCalledWith("test-install", "filter-ownership", "2026-Q3");
    expect(mocks.createJiraIssue.mock.calls[0][0].summary).toMatch(/^2026-Q3: Reassign 2 saved filters/);
    expect(mocks.recordRemediationTicket.mock.calls.every(([, row]) => row.period === "2026-Q3")).toBe(true);
  });

  // The ADF link nodes a ticket description carries.
  const linksIn = (doc) => JSON.stringify(doc).match(/"href":"[^"]+"/g) || [];

  test("every ticket links straight to the thing it is about", async () => {
    await createRemediationEpic({
      payload: { findingKey: "filter-ownership", items: ITEMS },
      context: ctxWithAccount(),
    });
    const [taskFields] = mocks.createJiraIssue.mock.calls[1];
    expect(linksIn(taskFields.description)).toContain('"href":"https://test.atlassian.net/issues/?filter=4001"');
  });

  test("the invocation's own site URL wins over serverInfo", async () => {
    const context = { ...ctxWithAccount(), siteUrl: "https://acme.atlassian.net" };
    await createRemediationEpic({ payload: { findingKey: "filter-ownership", items: ITEMS }, context });
    expect(linksIn(mocks.createJiraIssue.mock.calls[1][0].description)[0]).toMatch(/acme\.atlassian\.net/);
  });

  test("with no site URL at all, tickets are still created -- just without links", async () => {
    mocks.getSiteBaseUrl.mockResolvedValueOnce(null);
    const r = await createRemediationEpic({
      payload: { findingKey: "filter-ownership", items: ITEMS },
      context: ctxWithAccount(),
    });
    expect(r.ok).toBe(true);
    expect(linksIn(mocks.createJiraIssue.mock.calls[1][0].description)).toEqual([]);
  });

  test("is admin-only and audited", () => {
    expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toContain("createRemediationEpic");
    expect(Object.keys(SHARED_RESOLVER_FUNCTIONS)).not.toContain("createRemediationEpic");
  });
});

describe("getRemediationMetrics", () => {
  test("computes progress over this quarter's tasks, labelled from the playbook catalog", async () => {
    // The store mock pins the period; the test must use the same one, not today's date,
    // or it fails every time a real quarter turns over.
    const period = mocks.currentPeriod();
    mocks.loadRemediationTickets.mockResolvedValueOnce([
      { findingKey: "filter-ownership", period, isEpic: true, issueKey: "ADMIN-1" },
      {
        findingKey: "filter-ownership",
        period,
        isEpic: false,
        issueKey: "ADMIN-2",
        lastStatusCategory: "done",
        createdAt: new Date().toISOString(),
        doneAt: new Date().toISOString(),
      },
      {
        findingKey: "filter-ownership",
        period,
        isEpic: false,
        issueKey: "ADMIN-3",
        lastStatusCategory: "new",
        createdAt: new Date().toISOString(),
      },
      {
        findingKey: "filter-ownership",
        period: "2020-Q1",
        isEpic: false,
        issueKey: "ADMIN-0",
        lastStatusCategory: "done",
      },
    ]);

    const m = await getRemediationMetrics({ payload: {}, context: ctxWithAccount() });

    expect(m.scope).toBe("quarter");
    expect(m.totals).toMatchObject({ tasks: 2, open: 1, closed: 1, pctClosed: 50 });
    expect(m.byFinding[0].label).not.toBe("filter-ownership"); // the catalog's label, not the key
  });

  test("covers every quarter when asked, and treats anything else as this quarter", async () => {
    mocks.loadRemediationTickets.mockResolvedValue([
      {
        findingKey: "filter-ownership",
        period: "2020-Q1",
        isEpic: false,
        issueKey: "ADMIN-0",
        lastStatusCategory: "done",
      },
    ]);
    expect((await getRemediationMetrics({ payload: { scope: "all" }, context: ctxWithAccount() })).totals.tasks).toBe(
      1,
    );
    expect((await getRemediationMetrics({ payload: { scope: "bogus" }, context: ctxWithAccount() })).scope).toBe(
      "quarter",
    );
  });
});

describe("syncRemediationNow", () => {
  // Queued, not run inline: a resolver has seconds and a few thousand tickets need minutes --
  // the same ceiling that silently killed the scheduled sync.
  test("queues a sync-remediation job for the calling installation", async () => {
    const r = await syncRemediationNow({ payload: {}, context: ctxWithAccount() });
    expect(r).toEqual({ queued: true });
    expect(mocks.queuePush).toHaveBeenCalledWith({
      body: { jobType: "sync-remediation", installationKey: "test-install" },
    });
  });

  test("is admin-only", () => {
    expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toContain("syncRemediationNow");
    expect(Object.keys(SHARED_RESOLVER_FUNCTIONS)).not.toContain("syncRemediationNow");
  });
});

// Did the fixes hold? Each task's item checked against the same candidate loader that created
// it. Filter ownership is the loader used here: filter 7 has no owner (still flagged), 8 does.
describe("remediation verification", () => {
  const filters = [
    { id: "7", name: "Orphaned", owner: null },
    { id: "8", name: "Owned", owner: { accountId: "a1", displayName: "Ann", active: true } },
  ];
  const tickets = [
    {
      findingKey: "filter-ownership",
      pillar: "filters",
      period: "2026-Q4",
      isEpic: true,
      itemId: "",
      issueKey: "ADMIN-1",
      lastStatusCategory: "indeterminate",
    },
    {
      findingKey: "filter-ownership",
      pillar: "filters",
      period: "2026-Q4",
      isEpic: false,
      itemId: "7",
      issueKey: "ADMIN-2",
      lastStatusCategory: "done",
    },
    {
      findingKey: "filter-ownership",
      pillar: "filters",
      period: "2026-Q4",
      isEpic: false,
      itemId: "8",
      issueKey: "ADMIN-3",
      lastStatusCategory: "done",
    },
    {
      findingKey: "filter-ownership",
      pillar: "filters",
      period: "2026-Q4",
      isEpic: false,
      itemId: "9",
      issueKey: "ADMIN-4",
      lastStatusCategory: "new",
    },
  ];
  beforeEach(() => {
    mocks.loadRemediationTickets.mockResolvedValue(tickets);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.loadFilters.mockResolvedValue(filters);
  });

  test("classifies each task against the latest scan", async () => {
    const r = await getRemediationVerification({ payload: {}, context: ctxWithAccount() });
    const verdict = (key) => r.rows.find((row) => row.issueKey === key).verdict;
    expect(verdict("ADMIN-2")).toBe("regressed");
    expect(verdict("ADMIN-3")).toBe("held");
    expect(verdict("ADMIN-4")).toBe("fixed-open");
    expect(r.counts).toMatchObject({ regressed: 1, held: 1, "fixed-open": 1 });
    expect(r.labels["filter-ownership"]).toBeTruthy();
    expect(mocks.transitionIssueWithComment).not.toHaveBeenCalled();
  });

  test("a finding whose snapshot is missing leaves its tasks unverified", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValueOnce(null);
    const r = await getRemediationVerification({ payload: {}, context: ctxWithAccount() });
    expect(new Set(r.rows.map((row) => row.verdict))).toEqual(new Set(["unverified"]));
  });

  test("reopens a regressed task and closes a fixed one, each with a comment, as the admin", async () => {
    const r = await applyRemediationVerification({
      payload: { issueKeys: ["ADMIN-2", "ADMIN-4"] },
      context: ctxWithAccount(),
    });

    expect(r.applied).toBe(2);
    const calls = mocks.transitionIssueWithComment.mock.calls;
    expect(calls.map(([key, opts]) => [key, opts.target, opts.asUser])).toEqual([
      ["ADMIN-2", "reopen", true],
      ["ADMIN-4", "done", true],
    ]);
    expect(JSON.stringify(calls[0][1].commentBody)).toContain("the fix did not hold");
    expect(mocks.queuePush).toHaveBeenCalledWith({
      body: { jobType: "sync-remediation", installationKey: "test-install" },
    });
  });

  // The page's verdict is not trusted: a held or still-open task is left alone, with the reason.
  test("leaves a task alone when its verdict does not call for a change", async () => {
    const r = await applyRemediationVerification({
      payload: { issueKeys: ["ADMIN-3", "NOPE-1"] },
      context: ctxWithAccount(),
    });
    expect(r.applied).toBe(0);
    expect(r.results.map((x) => x.reason)).toEqual([
      'Its verdict is now "held", so it was left as it is.',
      "Not an Observatory remediation task.",
    ]);
    expect(mocks.transitionIssueWithComment).not.toHaveBeenCalled();
  });

  test("reports a Jira failure per task without stopping the rest", async () => {
    mocks.transitionIssueWithComment.mockRejectedValueOnce(new Error("403 forbidden"));
    const r = await applyRemediationVerification({
      payload: { issueKeys: ["ADMIN-2", "ADMIN-4"] },
      context: ctxWithAccount(),
    });
    expect(r.results[0]).toMatchObject({ issueKey: "ADMIN-2", transitioned: false, reason: "403 forbidden" });
    expect(r.applied).toBe(1);
  });

  // The archived-projects case (14 Oct 2026): "delete this field, no issue uses it" for a field
  // whose data is in an archived project. Re-hydration must count that data (so the field is no
  // longer a candidate), and the open task is withdrawn with the evidence -- not closed as fixed.
  describe("withdrawn field-cleanup advice", () => {
    const fieldTickets = [
      {
        findingKey: "field-cleanup",
        pillar: "fields",
        period: "2026-Q3",
        isEpic: false,
        itemId: "customfield_500",
        issueKey: "ADMIN-50",
        lastStatusCategory: "new",
      },
      {
        findingKey: "field-cleanup",
        pillar: "fields",
        period: "2026-Q3",
        isEpic: false,
        itemId: "customfield_501",
        issueKey: "ADMIN-51",
        lastStatusCategory: "new",
      },
      {
        findingKey: "field-cleanup",
        pillar: "fields",
        period: "2026-Q3",
        isEpic: false,
        itemId: "customfield_502",
        issueKey: "ADMIN-52",
        lastStatusCategory: "new",
      },
    ];
    beforeEach(() => {
      mocks.loadRemediationTickets.mockResolvedValue([...tickets, ...fieldTickets]);
      mocks.readSnapshotMeta.mockResolvedValue({ version: "s1" });
      mocks.loadSnapshotFields.mockResolvedValue([
        // Data only in archived Talent Tracker: no longer a candidate, still there -> withdrawn.
        {
          id: "customfield_500",
          name: "Hiring Manager",
          type: "user",
          configuredProjectCount: 3,
          activeProjectCount: 0,
          totalIssueCount: 0,
          archivedIssueCount: 2340,
          findings: null,
        },
        // Still unused anywhere: still flagged -> open.
        {
          id: "customfield_501",
          name: "Old Field",
          type: "text",
          configuredProjectCount: 0,
          activeProjectCount: 0,
          totalIssueCount: 0,
          findings: null,
        },
        // customfield_502 is gone: deleted, so really fixed.
      ]);
      mocks.loadArchivedFieldUsage.mockResolvedValue(
        new Map([
          ["customfield_500", [{ projectId: "20001", projectKey: "TT", issueCount: 2340, lastSeenAt: "2026-05-30" }]],
        ]),
      );
    });
    afterEach(() => {
      mocks.loadArchivedFieldUsage.mockImplementation(async () => new Map());
    });

    test("is withdrawn with the archived evidence; a deleted field is fixed; an unused one stays open", async () => {
      const r = await getRemediationVerification({
        payload: { findingKey: "field-cleanup" },
        context: ctxWithAccount(),
      });
      const row = (key) => r.rows.find((x) => x.issueKey === key);
      expect(row("ADMIN-50")).toMatchObject({ verdict: "withdrawn" });
      expect(row("ADMIN-50").evidence).toContain("2,340 issues in archived projects (TT)");
      expect(row("ADMIN-50").evidence).toContain("Deleting it would destroy that data");
      expect(row("ADMIN-51").verdict).toBe("open");
      expect(row("ADMIN-52").verdict).toBe("fixed-open");
      // Narrowed to the one finding: the filter tasks are not checked at all.
      expect(r.rows.every((x) => x.findingKey === "field-cleanup")).toBe(true);
      expect(mocks.loadFilters).not.toHaveBeenCalled();
    });

    test("names active-project usage too", async () => {
      mocks.loadSnapshotFields.mockResolvedValue([
        {
          id: "customfield_500",
          name: "Hiring Manager",
          type: "user",
          configuredProjectCount: 1,
          activeProjectCount: 1,
          totalIssueCount: 1,
          findings: null,
        },
      ]);
      const r = await getRemediationVerification({
        payload: { findingKey: "field-cleanup" },
        context: ctxWithAccount(),
      });
      expect(r.rows.find((x) => x.issueKey === "ADMIN-50").evidence).toContain("1 issue in active projects");
    });

    test("withdrawing closes as Won't Do with a do-not-act comment", async () => {
      const r = await applyRemediationVerification({
        payload: { issueKeys: ["ADMIN-50", "ADMIN-52"], findingKey: "field-cleanup" },
        context: ctxWithAccount(),
      });
      expect(r.applied).toBe(2);
      const calls = mocks.transitionIssueWithComment.mock.calls;
      expect(calls.map(([key, opts]) => [key, opts.target])).toEqual([
        ["ADMIN-50", "withdraw"],
        ["ADMIN-52", "done"],
      ]);
      expect(JSON.stringify(calls[0][1].commentBody)).toContain("do not act on this task");
      expect(JSON.stringify(calls[1][1].commentBody)).toContain("the item is fixed");
    });

    // If the evidence cannot be read, nothing is withdrawn on a guess: the task is only
    // "no longer flagged", as before.
    test("an unreadable evidence source leaves the task fixed-open", async () => {
      mocks.loadArchivedFieldUsage.mockRejectedValueOnce(new Error("sql down"));
      const r = await getRemediationVerification({
        payload: { findingKey: "field-cleanup" },
        context: ctxWithAccount(),
      });
      expect(r.rows.find((x) => x.issueKey === "ADMIN-50").verdict).toBe("fixed-open");
    });
  });

  test("requires a list of issue keys", async () => {
    await expect(applyRemediationVerification({ payload: {}, context: ctxWithAccount() })).rejects.toThrow(/issueKeys/);
  });

  test("the write is admin-only and audited; the read is admin-only", () => {
    expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toEqual(
      expect.arrayContaining(["getRemediationVerification", "applyRemediationVerification"]),
    );
    expect(Object.keys(SHARED_RESOLVER_FUNCTIONS)).not.toContain("applyRemediationVerification");
    expect(AUDITED_ADMIN_ACTIONS.has("applyRemediationVerification")).toBe(true);
  });
});

describe("getRemediationTickets", () => {
  test("reports when the sync last reached any ticket, and null when it never has", async () => {
    mocks.loadRemediationTickets.mockResolvedValueOnce([
      { findingKey: "filter-ownership", isEpic: false, issueKey: "ADMIN-2", syncedAt: "2026-09-28T16:00:00.000Z" },
      { findingKey: "filter-ownership", isEpic: false, issueKey: "ADMIN-3", syncedAt: "2026-09-29T00:00:00.000Z" },
      { findingKey: "filter-ownership", isEpic: false, issueKey: "ADMIN-4", syncedAt: null },
    ]);
    expect((await getRemediationTickets({ payload: {}, context: ctxWithAccount() })).lastSyncedAt).toBe(
      "2026-09-29T00:00:00.000Z",
    );

    mocks.loadRemediationTickets.mockResolvedValueOnce([
      { findingKey: "filter-ownership", isEpic: false, issueKey: "ADMIN-2", syncedAt: null },
    ]);
    expect((await getRemediationTickets({ payload: {}, context: ctxWithAccount() })).lastSyncedAt).toBeNull();
  });

  test("groups tickets by finding, epic separated from tasks, with open counts", async () => {
    mocks.loadRemediationTickets.mockResolvedValue([
      { findingKey: "filter-ownership", pillar: "filters", isEpic: true, issueKey: "ADMIN-1" },
      {
        findingKey: "filter-ownership",
        pillar: "filters",
        isEpic: false,
        issueKey: "ADMIN-2",
        lastStatusCategory: "done",
      },
      {
        findingKey: "filter-ownership",
        pillar: "filters",
        isEpic: false,
        issueKey: "ADMIN-3",
        lastStatusCategory: "indeterminate",
      },
    ]);

    const r = await getRemediationTickets({ payload: {}, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({
      findingKey: "filter-ownership",
      pillar: "filters",
      taskCount: 2,
      openCount: 1,
    });
    expect(r.groups[0].epic.issueKey).toBe("ADMIN-1");
  });

  test("shows the latest quarter's epic and tasks, and summarises earlier quarters", async () => {
    mocks.loadRemediationTickets.mockResolvedValueOnce([
      { findingKey: "filter-ownership", period: "2026-Q3", isEpic: true, issueKey: "ADMIN-9" },
      {
        findingKey: "filter-ownership",
        period: "2026-Q3",
        isEpic: false,
        issueKey: "ADMIN-10",
        lastStatusCategory: "new",
      },
      {
        findingKey: "filter-ownership",
        period: "2026-Q2",
        isEpic: true,
        issueKey: "ADMIN-1",
        lastStatusCategory: "done",
      },
      {
        findingKey: "filter-ownership",
        period: "2026-Q2",
        isEpic: false,
        issueKey: "ADMIN-2",
        lastStatusCategory: "done",
      },
      {
        findingKey: "filter-ownership",
        period: "2026-Q2",
        isEpic: false,
        issueKey: "ADMIN-3",
        lastStatusCategory: "indeterminate",
      },
      { findingKey: "board-backing", period: "2026-Q2", isEpic: true, issueKey: "ADMIN-20" },
    ]);

    const r = await getRemediationTickets({ payload: {}, context: ctxWithAccount() });

    expect(r.period).toBe("2026-Q3");
    const filters = r.groups.find((g) => g.findingKey === "filter-ownership");
    expect(filters).toMatchObject({ period: "2026-Q3", isCurrent: true, taskCount: 1, openCount: 1 });
    expect(filters.epic.issueKey).toBe("ADMIN-9");
    expect(filters.previousPeriods).toEqual([
      expect.objectContaining({
        period: "2026-Q2",
        epicKey: "ADMIN-1",
        epicStatusCategory: "done",
        taskCount: 2,
        openCount: 1,
      }),
    ]);
    // Earlier quarters' tasks travel with the summary, and the all-quarter counts include them.
    expect(filters.previousPeriods[0].tasks.map((t) => t.issueKey)).toEqual(["ADMIN-2", "ADMIN-3"]);
    expect(filters).toMatchObject({ allTaskCount: 3, allOpenCount: 2 });
    // Only an earlier quarter's epic: not current, so the next create opens this quarter's.
    expect(r.groups.find((g) => g.findingKey === "board-backing")).toMatchObject({
      period: "2026-Q2",
      isCurrent: false,
    });
  });

  test("serves the playbook catalog and the finding index with the tickets", async () => {
    mocks.loadRemediationTickets.mockResolvedValueOnce([]);
    const r = await getRemediationTickets({ payload: {}, context: ctxWithAccount() });
    expect(r.catalog.find((c) => c.key === "role-offroster-actors")).toMatchObject({
      pillar: "roles",
      granularity: "bounded",
    });
    expect(r.findingIndex["role-empty-admin"]).toBe("role-empty-admin");
    expect(r.findingIndex["filters-orphaned"]).toBe("filter-ownership");
  });

  test("passes a finding filter through and reports unavailable when empty", async () => {
    mocks.loadRemediationTickets.mockResolvedValue([]);
    const r = await getRemediationTickets({ payload: { findingKey: "board-backing" }, context: ctxWithAccount() });
    expect(mocks.loadRemediationTickets).toHaveBeenCalledWith(expect.any(String), "board-backing");
    expect(r.available).toBe(false);
  });
});

describe("getRemediationCandidates", () => {
  // The quarter rolled over with tasks still open under last quarter's epic. The server skips
  // those items (loadTicketedItems); the candidates must say so, or the tab offers to ticket
  // them and the create call quietly does nothing.
  test("marks each item already held by an open ticket, using the same rule the create skips by", async () => {
    mocks.getFieldConfigInventory.mockResolvedValue({
      neverBuilt: false,
      schemes: [
        { id: "fcs:1", sourceId: "1", name: "Old", codes: ["unused"] },
        { id: "fcs:2", sourceId: "2", name: "Older", codes: ["unused"] },
      ],
      configs: [],
    });
    mocks.loadTicketedItems.mockResolvedValueOnce(
      new Map([["fcs:1", { issueKey: "ADMIN-7", epicKey: "ADMIN-5", period: "2026-Q2" }]]),
    );

    const r = await getRemediationCandidates({
      payload: { findingKey: "fieldconfig-unused" },
      context: ctxWithAccount(),
    });

    expect(mocks.loadTicketedItems).toHaveBeenCalledWith("test-install", "fieldconfig-unused", "2026-Q3");
    expect(r.items).toEqual([
      {
        id: "fcs:1",
        sourceId: "1",
        name: "Old",
        kind: "scheme",
        ticketed: { issueKey: "ADMIN-7", epicKey: "ADMIN-5", period: "2026-Q2" },
      },
      { id: "fcs:2", sourceId: "2", name: "Older", kind: "scheme" },
    ]);
  });

  test("a failed ticket lookup leaves the items unmarked rather than failing the read", async () => {
    mocks.getFieldConfigInventory.mockResolvedValue({
      neverBuilt: false,
      schemes: [{ id: "fcs:1", sourceId: "1", name: "Old", codes: ["unused"] }],
      configs: [],
    });
    mocks.loadTicketedItems.mockRejectedValueOnce(new Error("sql down"));
    const r = await getRemediationCandidates({
      payload: { findingKey: "fieldconfig-unused" },
      context: ctxWithAccount(),
    });
    expect(r.items).toEqual([{ id: "fcs:1", sourceId: "1", name: "Old", kind: "scheme" }]);
  });

  test("people-dormant-licences: the accounts the dormant dimension counted, with what they own", async () => {
    mocks.readAutomationPart.mockResolvedValue(null);
    mocks.readUserSnapshotMeta.mockResolvedValue({ version: "u1", state: "ready" });
    mocks.loadUsers.mockResolvedValue([
      {
        accountId: "idle",
        displayName: "Idle Ida",
        active: true,
        applications: [{ name: "Jira Software" }],
        groups: [{ id: "g", name: "jira-users" }],
      },
      { accountId: "busy", displayName: "Busy Bo", active: true, applications: [], groups: [] },
    ]);
    mocks.loadUserActivity.mockResolvedValueOnce([
      { accountId: "idle", lastActivityAt: "2020-01-01T00:00:00Z" },
      { accountId: "busy", lastActivityAt: new Date().toISOString() },
    ]);
    const r = await getRemediationCandidates({
      payload: { findingKey: "people-dormant-licences" },
      context: ctxWithAccount(),
    });
    expect(r.available).toBe(true);
    expect(r.items).toEqual([
      expect.objectContaining({
        accountId: "idle",
        displayName: "Idle Ida",
        products: ["Jira Software"],
        groups: ["jira-users"],
        lastActivityAt: "2020-01-01T00:00:00Z",
      }),
    ]);
  });

  test("people-dormant-licences: unmeasured activity is a reason, not an empty list", async () => {
    mocks.readAutomationPart.mockResolvedValue(null);
    mocks.readUserSnapshotMeta.mockResolvedValue({ version: "u1", state: "ready" });
    mocks.loadUsers.mockResolvedValue([
      { accountId: "x", displayName: "X", active: true, applications: [], groups: [] },
    ]);
    mocks.loadUserActivity.mockResolvedValueOnce([]);
    const r = await getRemediationCandidates({
      payload: { findingKey: "people-dormant-licences" },
      context: ctxWithAccount(),
    });
    expect(r).toEqual({ available: false, reason: "no-activity", items: [] });
  });

  test("fieldconfig candidates come from the stored findings, and say why there are none without a build", async () => {
    mocks.getFieldConfigInventory.mockResolvedValue({
      neverBuilt: false,
      schemes: [
        { id: "fcs:1", sourceId: "1", name: "Old", codes: ["unused"] },
        { id: "fcs:2", sourceId: "2", name: "Keep", codes: [] },
        { id: "fcs:3", sourceId: "3", name: "Copy", codes: ["duplicate"], duplicateOf: "fcs:2" },
      ],
      configs: [
        {
          id: "fc:9",
          sourceId: "9",
          name: "Build",
          codes: ["required-hidden"],
          requiredHidden: [{ fieldId: "customfield_1", fieldName: "Total Cost" }],
          routes: [{ schemeName: "Keep", workTypeName: "Bug" }],
        },
      ],
    });
    const get = (findingKey) => getRemediationCandidates({ payload: { findingKey }, context: ctxWithAccount() });

    expect((await get("fieldconfig-required-hidden")).items).toEqual([
      { id: "fc:9", sourceId: "9", name: "Build", fieldNames: ["Total Cost"], usedBy: ["Keep (Bug)"] },
    ]);
    expect((await get("fieldconfig-unused")).items).toEqual([
      { id: "fcs:1", sourceId: "1", name: "Old", kind: "scheme" },
    ]);
    expect((await get("fieldconfig-duplicates")).items).toEqual([
      expect.objectContaining({
        kind: "scheme",
        keep: "fcs:2",
        keepName: "Keep",
        members: ["fcs:2", "fcs:3"],
        memberNames: ["Keep", "Copy"],
      }),
    ]);

    mocks.getFieldConfigInventory.mockResolvedValueOnce({ neverBuilt: true });
    expect(await get("fieldconfig-unused")).toEqual({ available: false, reason: "no-snapshot", items: [] });
  });

  test("workflow-broken-references: one item per workflow, listing where each reference sits", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1", workflowRules: 5 });
    mocks.loadStatusesCatalog.mockResolvedValue([{ statusId: "3", name: "In Review" }]);
    mocks.loadWorkflowsCatalog.mockResolvedValue([
      { name: "Build WF", scopeType: "GLOBAL", schemeCount: 1, ruleCount: 5 },
    ]);
    mocks.loadWorkflowRefsByType.mockResolvedValue([
      {
        refType: "field",
        refId: "customfield_9",
        refMissing: true,
        workflowName: "Build WF",
        source: "rule",
        ownerKind: "transition",
        ownerId: "21",
        ruleSeq: 0,
      },
      {
        refType: "group",
        refId: "g-gone",
        refMissing: true,
        workflowName: "Build WF",
        source: "property",
        ownerKind: "status",
        ownerId: "3",
        propKey: "jira.permission.edit.group",
      },
    ]);

    const r = await getRemediationCandidates({
      payload: { findingKey: "workflow-broken-references" },
      context: ctxWithAccount(),
    });

    expect(r.available).toBe(true);
    expect(r.items).toEqual([
      {
        id: "Build WF",
        name: "Build WF",
        count: 2,
        refs: [
          { type: "field", id: "customfield_9", where: "transition 21" },
          { type: "group", id: "g-gone", where: "status In Review" },
        ],
      },
    ]);
  });

  test("workflows-inactive: company-managed workflows no scheme uses", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1", workflowRules: 5 });
    mocks.loadStatusesCatalog.mockResolvedValue([]);
    mocks.loadWorkflowRefsByType.mockResolvedValue([]);
    mocks.loadWorkflowsCatalog.mockResolvedValue([
      { name: "Zombie", scopeType: "GLOBAL", schemeCount: 0, statusCount: 3, ruleCount: 2 },
      { name: "Team", scopeType: "PROJECT", schemeCount: 0, statusCount: 3, ruleCount: 0 },
    ]);

    const r = await getRemediationCandidates({
      payload: { findingKey: "workflows-inactive" },
      context: ctxWithAccount(),
    });
    expect(r.items).toEqual([{ id: "Zombie", name: "Zombie", statusCount: 3, ruleCount: 2 }]);
  });

  test("workflow rule candidates say why there are none when the rules were never read", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1", workflowRules: null });
    const r = await getRemediationCandidates({
      payload: { findingKey: "workflows-inactive" },
      context: ctxWithAccount(),
    });
    expect(r).toEqual({ available: false, reason: "rules-not-read", items: [] });
  });

  test("filter-ownership: returns only filters with an orphaned owner, mapped to what the playbook needs", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "flt1" });
    mocks.loadFilters.mockResolvedValue([
      {
        id: "4001",
        name: "Open Bugs",
        owner: { accountId: "a1", displayName: "Gone Person", active: false },
        subscriptionCount: 3,
        shares: [],
      },
      {
        id: "4002",
        name: "Fine Filter",
        owner: { accountId: "a2", displayName: "Still Here", active: true },
        subscriptionCount: 0,
        shares: [],
      },
      { id: "4003", name: "No Owner", owner: null, subscriptionCount: 0, shares: [] },
    ]);

    const r = await getRemediationCandidates({
      payload: { findingKey: "filter-ownership" },
      context: ctxWithAccount(),
    });

    expect(r.available).toBe(true);
    expect(r.items.map((i) => i.id).sort()).toEqual(["4001", "4003"]);
    const item = r.items.find((i) => i.id === "4001");
    expect(item).toMatchObject({
      name: "Open Bugs",
      ownerName: "Gone Person",
      ownerActive: false,
      subscriptionCount: 3,
    });
  });

  test("filter-ownership: reports unavailable when there is no filter snapshot yet", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    const r = await getRemediationCandidates({
      payload: { findingKey: "filter-ownership" },
      context: ctxWithAccount(),
    });
    expect(r).toMatchObject({ available: false, reason: "no-snapshot", items: [] });
  });

  test("dashboard-ownership: returns only dashboards with an orphaned owner", async () => {
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "d1" });
    mocks.loadDashboards.mockResolvedValue([
      {
        id: "D1",
        name: "Wall screen",
        owner: { accountId: "a1", displayName: "Gone Person", active: false },
        popularity: 12,
        shares: [],
        editShares: [],
        gadgetCount: 2,
      },
      {
        id: "D2",
        name: "Fine dash",
        owner: { accountId: "a2", displayName: "Still Here", active: true },
        popularity: 1,
        shares: [],
        editShares: [],
        gadgetCount: 1,
      },
    ]);

    const r = await getRemediationCandidates({
      payload: { findingKey: "dashboard-ownership" },
      context: ctxWithAccount(),
    });

    expect(r.available).toBe(true);
    expect(r.items).toEqual([{ id: "D1", name: "Wall screen", ownerName: "Gone Person", popularity: 12 }]);
  });

  test("a finding with no wired item source says so rather than fabricating a list", async () => {
    const r = await getRemediationCandidates({
      payload: { findingKey: "not-a-real-finding" },
      context: ctxWithAccount(),
    });
    expect(r).toEqual({ available: false, reason: "not-connected", items: [] });
  });

  test("user-licence-hygiene: only deactivated accounts still holding a licence group", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ version: "u1" });
    mocks.loadUsers.mockResolvedValue([
      {
        accountId: "a1",
        displayName: "Gone Person",
        active: false,
        groups: [{ id: "g1", name: "jira-software-users" }],
      },
      { accountId: "a2", displayName: "Still Here", active: true, groups: [{ id: "g1", name: "jira-software-users" }] },
      { accountId: "a3", displayName: "Deactivated, ungrouped", active: false, groups: [] },
    ]);

    const r = await getRemediationCandidates({
      payload: { findingKey: "user-licence-hygiene" },
      context: ctxWithAccount(),
    });

    expect(r.available).toBe(true);
    expect(r.items).toEqual([
      { id: "a1", accountId: "a1", displayName: "Gone Person", groups: ["jira-software-users"] },
    ]);
  });

  test("user-licence-hygiene: reports unavailable when there is no roster yet", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue(null);
    const r = await getRemediationCandidates({
      payload: { findingKey: "user-licence-hygiene" },
      context: ctxWithAccount(),
    });
    expect(r).toMatchObject({ available: false, reason: "no-snapshot", items: [] });
  });

  test("user-ownership: flattens filters, dashboards and rules owned by an off-roster account", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValue({ version: "u1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "a1", displayName: "Ann", active: true, groups: [] }]);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "d1" });
    mocks.loadFilters.mockResolvedValue([
      { id: "10", name: "Ann filter", ownerAccountId: "a1" },
      { id: "11", name: "Ghost filter", ownerAccountId: "gone" },
    ]);
    mocks.loadDashboards.mockResolvedValue([{ dashboardId: "20", name: "Ghost dash", ownerAccountId: "gone" }]);
    mocks.readAutomationPart.mockResolvedValue({/* hydrateRuleDirectory reads its own shape */});

    const r = await getRemediationCandidates({ payload: { findingKey: "user-ownership" }, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.items).toEqual(
      expect.arrayContaining([
        { id: "filter:11", kind: "filter", name: "Ghost filter" },
        { id: "dashboard:20", kind: "dashboard", name: "Ghost dash" },
      ]),
    );
    // Ann's own filter is not orphaned -- she is on the roster.
    expect(r.items.find((i) => i.id === "filter:10")).toBeUndefined();
  });

  test("status-reachability: excludes statuses a rule still transitions into", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1" });
    mocks.loadStatusesCatalog.mockResolvedValue([
      { statusId: "1", id: "1", name: "Dead End" },
      { statusId: "2", id: "2", name: "Rule Only" },
      { statusId: "3", id: "3", name: "In Use" },
    ]);
    // Only status 3 is in a scheme -- 1 and 2 are unreachable. A non-empty scheme->status
    // mapping is what tells the resolver the mapping was actually built, as opposed to an
    // empty result meaning the walk never ran (see the no-scheme-mapping test below).
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([{ schemeId: "s1", statusId: "3" }]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map());
    mocks.loadStatusAutomationReferences.mockResolvedValue({ "rule only": { ruleCount: 1, enabledRuleCount: 1 } });

    const r = await getRemediationCandidates({
      payload: { findingKey: "status-reachability" },
      context: ctxWithAccount(),
    });

    expect(r.available).toBe(true);
    // No issue-count data was measured, so everCount is unknown, not zero -- a missing
    // count must never render as "safe to delete" on its own.
    expect(r.items).toEqual([{ id: "1", name: "Dead End", category: null, everCount: null }]);
  });

  test("status-reachability: excludes a status a board column still maps", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1" });
    mocks.loadStatusesCatalog.mockResolvedValue([
      { statusId: "1", id: "1", name: "Dead End" },
      { statusId: "2", id: "2", name: "On A Board" },
      { statusId: "3", id: "3", name: "In Use" },
    ]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([{ schemeId: "s1", statusId: "3" }]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map());
    mocks.loadStatusAutomationReferences.mockResolvedValue({});
    mocks.readBoardSnapshotMeta.mockResolvedValue({ version: "b1" });
    mocks.loadBoardColumns.mockResolvedValue([{ boardId: "100", statusIds: ["2"] }]);

    const r = await getRemediationCandidates({
      payload: { findingKey: "status-reachability" },
      context: ctxWithAccount(),
    });

    expect(r.available).toBe(true);
    expect(r.items.map((i) => i.id)).toEqual(["1"]);
  });

  // The same finding rovoWorkflowImpact's assessStatusDeletion checks -- a filter reference
  // is one of the three sources that keep a status off this list, alongside rules and boards.
  test("status-reachability: excludes a status a saved filter's JQL still names", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1" });
    mocks.loadStatusesCatalog.mockResolvedValue([
      { statusId: "1", id: "1", name: "Dead End" },
      { statusId: "2", id: "2", name: "Named In A Filter" },
      { statusId: "3", id: "3", name: "In Use" },
    ]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([{ schemeId: "s1", statusId: "3" }]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map());
    mocks.loadStatusAutomationReferences.mockResolvedValue({});
    mocks.readBoardSnapshotMeta.mockResolvedValue({ version: "b1" });
    mocks.loadBoardColumns.mockResolvedValue([]);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.loadFilterReferenceCounts.mockResolvedValue({ "named in a filter": 2 });

    const r = await getRemediationCandidates({
      payload: { findingKey: "status-reachability" },
      context: ctxWithAccount(),
    });

    expect(r.available).toBe(true);
    expect(r.items.map((i) => i.id)).toEqual(["1"]);
  });

  test("status-reachability: reports unavailable with no scheme->status mapping", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1" });
    mocks.loadStatusesCatalog.mockResolvedValue([{ statusId: "1", id: "1", name: "Any" }]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([]);
    const r = await getRemediationCandidates({
      payload: { findingKey: "status-reachability" },
      context: ctxWithAccount(),
    });
    expect(r).toMatchObject({ available: false, reason: "no-scheme-mapping", items: [] });
  });

  test("board-backing: flags a board with no backing filter, not one with only a column issue", async () => {
    mocks.readBoardSnapshotMeta.mockResolvedValue({ version: "b1" });
    mocks.loadBoards.mockResolvedValue([
      { boardId: "100", name: "Orphan Board", type: "scrum", configReadable: true, filterId: null },
      {
        boardId: "101",
        name: "Column Only",
        type: "kanban",
        configReadable: true,
        filterId: "9",
        columns: [{ statusIds: [] }],
      },
    ]);
    mocks.loadBoardColumns.mockResolvedValue([{ boardId: "101", statusIds: [] }]);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.loadFilters.mockResolvedValue([{ id: "9", ownerActive: true }]);

    const r = await getRemediationCandidates({ payload: { findingKey: "board-backing" }, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.items).toEqual([{ id: "100", name: "Orphan Board", type: "scrum", issues: ["no-backing-filter"] }]);
  });

  test("field-cleanup: fields with no populated issues -- orphaned or configured-but-unused", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "s1" });
    // Findings are recomputed from each field's own numbers against the current thresholds --
    // the same hydration the Overview counts with -- so the stored findings (even a stale
    // or missing one) do not decide membership.
    mocks.loadSnapshotFields.mockResolvedValue([
      {
        id: "customfield_1",
        name: "Old Field",
        type: "text",
        description: null,
        configuredProjectCount: 0,
        activeProjectCount: 0,
        totalIssueCount: 0,
        findings: null,
      },
      {
        id: "customfield_2",
        name: "Used Field",
        type: "text",
        description: "In use",
        configuredProjectCount: 1,
        activeProjectCount: 1,
        totalIssueCount: 40,
        findings: { reasons: [{ code: "orphaned" }] },
      },
      {
        id: "customfield_3",
        name: "Light Use",
        type: "text",
        description: null,
        configuredProjectCount: 1,
        activeProjectCount: 1,
        totalIssueCount: 5,
        findings: null,
      },
      {
        id: "customfield_4",
        name: "Configured Only",
        type: "text",
        description: null,
        configuredProjectCount: 3,
        activeProjectCount: 0,
        totalIssueCount: 0,
        findings: null,
      },
    ]);

    const r = await getRemediationCandidates({ payload: { findingKey: "field-cleanup" }, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.items).toEqual([
      { id: "customfield_1", name: "Old Field", type: "text", description: null, reason: "orphaned" },
      { id: "customfield_4", name: "Configured Only", type: "text", description: null, reason: "configured-no-issues" },
    ]);
  });

  test("filter-duplicates: groups filters sharing identical JQL", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.loadFilters.mockResolvedValue([
      { id: "1", name: "Open Bugs", jql: "project = ABC AND status = Open", ownerName: "Ann", shares: [] },
      { id: "2", name: "Open Bugs Copy", jql: "project = ABC AND status = Open", ownerName: "Sam", shares: [] },
      { id: "3", name: "Something Else", jql: "project = XYZ", ownerName: "Ann", shares: [] },
    ]);

    const r = await getRemediationCandidates({
      payload: { findingKey: "filter-duplicates" },
      context: ctxWithAccount(),
    });

    expect(r.available).toBe(true);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ count: 2, jql: "project = ABC AND status = Open" });
    expect(r.items[0].filters.map((f) => f.id).sort()).toEqual(["1", "2"]);
  });

  test("filter-duplicates: reports unavailable when there is no filter snapshot yet", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue(null);
    const r = await getRemediationCandidates({
      payload: { findingKey: "filter-duplicates" },
      context: ctxWithAccount(),
    });
    expect(r).toMatchObject({ available: false, reason: "no-snapshot", items: [] });
  });

  test("filter-scope: a filter naming a project the site does not have", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.loadFilters.mockResolvedValue([
      {
        id: "1",
        name: "Ghost Project Search",
        jql: "project = GONE",
        ownerName: "Ann",
        projectRefs: ["GONE"],
        typeRefs: [],
        shares: [],
      },
      {
        id: "2",
        name: "Fine Filter",
        jql: "project = ABC",
        ownerName: "Ann",
        projectRefs: ["ABC"],
        typeRefs: [],
        shares: [],
      },
    ]);
    mocks.readSnapshotMeta.mockResolvedValue({ version: "s1" });
    mocks.listSnapshotProjects.mockResolvedValue([{ projectId: "10", projectKey: "ABC", projectName: "Alpha" }]);
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue(null);

    const r = await getRemediationCandidates({ payload: { findingKey: "filter-scope" }, context: ctxWithAccount() });

    expect(r.available).toBe(true);
    expect(r.items).toEqual([
      expect.objectContaining({ id: "1:project", name: "Ghost Project Search", refKind: "project", missing: ["GONE"] }),
    ]);
  });

  test("filter-scope: reports unavailable when neither catalog exists to join against", async () => {
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.loadFilters.mockResolvedValue([]);
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue(null);
    const r = await getRemediationCandidates({ payload: { findingKey: "filter-scope" }, context: ctxWithAccount() });
    expect(r).toMatchObject({ available: false, reason: "no-catalog", items: [] });
  });

  test("screen-unreachable-fields: a populated field with no reachability entry anywhere", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1", refreshedAt: "t" });
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1", refreshedAt: "t" });
    mocks.loadProjectScreenCoverage.mockResolvedValue([{ projectId: "10", screenCount: 3, unresolvedScreens: 0 }]);
    mocks.loadFieldReachabilityByProject.mockResolvedValue([
      { projectId: "10", fieldId: "cf_1", onCreate: true, onEdit: true, onView: true },
    ]);
    mocks.loadPopulatedProjectUsage.mockResolvedValue({ truncated: false, limit: 20000, rows: [] });
    mocks.loadSnapshotFields.mockResolvedValue([
      { id: "cf_1", name: "Story Points" },
      { id: "cf_2", name: "Vendor Ref" },
    ]);

    const r = await getRemediationCandidates({
      payload: { findingKey: "screen-unreachable-fields" },
      context: ctxWithAccount(),
    });

    expect(r.available).toBe(true);
    expect(r.items).toEqual([{ id: "cf_2", fieldId: "cf_2", fieldName: "Vendor Ref" }]);
  });

  test("screen-unreachable-fields: reports unavailable when the cross could not resolve", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    const r = await getRemediationCandidates({
      payload: { findingKey: "screen-unreachable-fields" },
      context: ctxWithAccount(),
    });
    expect(r).toMatchObject({ available: false });
  });

  test("issue-type-reach: reads the live governanceFindings computation, not the SQL-aggregate governance summary", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadIssueTypes.mockResolvedValue([
      { id: "1", name: "Epic", hierarchyLevel: 1, subtask: false },
      { id: "2", name: "Orphan Type", hierarchyLevel: 0, subtask: false },
    ]);
    mocks.loadIssueTypeSchemes.mockResolvedValue([{ schemeId: "s1", name: "Default", projectCount: 1 }]);
    mocks.loadIssueTypeSchemeItems.mockResolvedValue([{ schemeId: "s1", issueTypeId: "1", itemIndex: 0 }]);
    mocks.loadIssueTypeSchemeProjects.mockResolvedValue([]);
    mocks.loadIssueTypeGovernanceSummary.mockResolvedValue({}); // deliberately no orphanTypes here

    const r = await getRemediationCandidates({
      payload: { findingKey: "issue-type-reach" },
      context: ctxWithAccount(),
    });

    expect(r.available).toBe(true);
    expect(r.items).toEqual([{ id: "2", name: "Orphan Type", subtask: false }]);
  });

  test("issue-type-naming: groups issue types sharing a normalized name", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    mocks.loadIssueTypes.mockResolvedValue([
      { id: "1", name: "Bug", hierarchyLevel: 0, subtask: false },
      { id: "2", name: "Bug ", hierarchyLevel: 0, subtask: false },
    ]);
    mocks.loadIssueTypeSchemes.mockResolvedValue([]);
    mocks.loadIssueTypeSchemeItems.mockResolvedValue([]);
    mocks.loadIssueTypeSchemeProjects.mockResolvedValue([]);

    const r = await getRemediationCandidates({
      payload: { findingKey: "issue-type-naming" },
      context: ctxWithAccount(),
    });

    expect(r.available).toBe(true);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].types.map((t) => t.id).sort()).toEqual(["1", "2"]);
  });

  test("issue-type-reach: reports unavailable when never built", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue(null);
    const r = await getRemediationCandidates({
      payload: { findingKey: "issue-type-reach" },
      context: ctxWithAccount(),
    });
    expect(r).toMatchObject({ available: false, reason: "no-snapshot", items: [] });
  });

  test("asset-schema-hygiene: a schema with no object types", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "ready", version: "a1", assetsEnabled: true });
    mocks.loadAssetSchemas.mockResolvedValue([
      { id: "1", name: "Ghost Schema", objectTypeCount: 0, objectCount: 0 },
      { id: "2", name: "Live Schema", objectTypeCount: 3, objectCount: 40 },
    ]);
    mocks.loadAssetObjectTypes.mockResolvedValue([]);
    mocks.loadAssetAttributes.mockResolvedValue([]);
    mocks.loadAssetTypeCounts.mockResolvedValue([]);

    const r = await getRemediationCandidates({
      payload: { findingKey: "asset-schema-hygiene" },
      context: ctxWithAccount(),
    });

    expect(r.available).toBe(true);
    expect(r.items).toEqual([expect.objectContaining({ id: "1", name: "Ghost Schema", reason: "no object types" })]);
  });

  test("asset-schema-hygiene: reports assets-not-enabled distinctly from no-snapshot", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "unavailable", assetsEnabled: false });
    const r = await getRemediationCandidates({
      payload: { findingKey: "asset-schema-hygiene" },
      context: ctxWithAccount(),
    });
    expect(r).toMatchObject({ available: false, reason: "assets-not-enabled", items: [] });
  });

  test("asset-type-usage: an object type with zero measured objects", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "ready", version: "a1", assetsEnabled: true });
    mocks.loadAssetSchemas.mockResolvedValue([{ id: "1", name: "Infra", objectTypeCount: 2, objectCount: 5 }]);
    mocks.loadAssetObjectTypes.mockResolvedValue([
      { id: "9", schemaId: "1", name: "Server", abstract: false },
      { id: "10", schemaId: "1", name: "Rack", abstract: false },
    ]);
    mocks.loadAssetAttributes.mockResolvedValue([]);
    mocks.loadAssetTypeCounts.mockResolvedValue([
      { objectTypeId: "9", objectCount: 5 },
      { objectTypeId: "10", objectCount: 0 },
    ]);

    const r = await getRemediationCandidates({
      payload: { findingKey: "asset-type-usage" },
      context: ctxWithAccount(),
    });

    expect(r.available).toBe(true);
    expect(r.items).toEqual([{ id: "10", name: "Rack", schemaId: "1" }]);
  });

  test("asset-type-usage: unmeasured (no object-count crawl) is unavailable, never a false empty", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "ready", version: "a1", assetsEnabled: true });
    mocks.loadAssetSchemas.mockResolvedValue([{ id: "1", name: "Infra", objectTypeCount: 1, objectCount: 0 }]);
    mocks.loadAssetObjectTypes.mockResolvedValue([{ id: "9", schemaId: "1", name: "Server", abstract: false }]);
    mocks.loadAssetAttributes.mockResolvedValue([]);
    mocks.loadAssetTypeCounts.mockResolvedValue([]); // the crawl has never run

    const r = await getRemediationCandidates({
      payload: { findingKey: "asset-type-usage" },
      context: ctxWithAccount(),
    });

    expect(r).toMatchObject({ available: false, reason: "no-object-count-crawl", items: [] });
  });

  test("is admin-only", () => {
    expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toContain("getRemediationCandidates");
    expect(Object.keys(SHARED_RESOLVER_FUNCTIONS)).not.toContain("getRemediationCandidates");
  });
});

describe("getRemediationCandidates -- access playbooks", () => {
  const ctx = { payload: {}, context: { installContext: "ari:cloud:jira::site/x", accountId: "admin-1" } };
  const run = (findingKey) => getRemediationCandidates({ ...ctx, payload: { findingKey } });

  // 30 risky permission schemes, so the "every item, not the tab's first 25" rule is tested.
  function accessFixture() {
    mocks.readAccessSnapshotMeta.mockResolvedValueOnce({
      state: "ready",
      version: "v1",
      refreshedAt: "2026-09-01T00:00:00Z",
    });
    mocks.readUserSnapshotMeta.mockResolvedValueOnce({ version: "u1" });
    mocks.loadUsers.mockResolvedValueOnce([{ accountId: "live" }]);
    const perm = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, name: `Perm ${i}`, isDefault: false }));
    const schemes = {
      permission: perm,
      security: [
        { id: "s1", name: "Secret" },
        { id: "s2", name: "No levels" },
      ],
      notification: [{ id: "n1", name: "Named" }],
      "project-role": [
        { id: "10002", name: "Administrators" },
        { id: "10003", name: "Developers" },
      ],
    };
    const holders = {
      permission: [
        ...perm.map((sc) => ({ schemeId: sc.id, context: "BROWSE_PROJECTS", holderType: "anyone", holderValue: "" })),
        // p0 (OPS's scheme) lets the Administrators role administer the project.
        { schemeId: "p0", context: "ADMINISTER_PROJECTS", holderType: "projectRole", holderValue: "10002" },
      ],
      security: [],
      notification: [{ schemeId: "n1", context: "1", holderType: "user", holderValue: "someone" }],
      "project-role": [
        { schemeId: "10002", context: "1", contextLabel: "OPS", holderType: "empty", holderValue: "" },
        { schemeId: "10003", context: "1", contextLabel: "OPS", holderType: "user", holderValue: "gone-1" },
        { schemeId: "10003", context: "2", contextLabel: "DEV", holderType: "user", holderValue: "gone-2" },
        { schemeId: "10003", context: "2", contextLabel: "DEV", holderType: "user", holderValue: "live" },
      ],
    };
    for (let i = 0; i < 4; i += 1) {
      mocks.loadSchemes.mockImplementationOnce(async (_k, _v, type) => schemes[type] || []);
      mocks.loadSchemeHolders.mockImplementationOnce(async (_k, _v, type) => holders[type] || []);
    }
    // Only p0 is assigned to a project; s1 has one level with no members.
    mocks.loadSchemeProjects
      .mockResolvedValueOnce([{ schemeId: "p0", projectId: "1" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mocks.loadSchemeLevels.mockResolvedValueOnce([{ schemeId: "s1", id: "L1", name: "Staff" }]);
  }

  test("permission-risky: every flagged scheme, past the tab's 25", async () => {
    accessFixture();
    const r = await run("permission-risky");
    expect(r.items).toHaveLength(30);
    expect(r.items[0]).toMatchObject({ id: "p0", reasons: [expect.stringMatching(/anyone/)], projectCount: 1 });
  });

  test("access-unused-schemes: permission, security and notification together, tagged by type", async () => {
    accessFixture();
    const r = await run("access-unused-schemes");
    const types = new Set(r.items.map((it) => it.type));
    expect(types).toEqual(new Set(["permission", "security", "notification"]));
    expect(r.items.find((it) => it.id === "security:s2")).toMatchObject({ schemeId: "s2", name: "No levels" });
    expect(r.items.some((it) => it.schemeId === "p0")).toBe(false); // assigned
  });

  test("security-broken-levels: level-less schemes and member-less levels", async () => {
    accessFixture();
    const r = await run("security-broken-levels");
    expect(r.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "scheme:s2", kind: "no-levels" }),
        expect.objectContaining({ id: "level:s1:L1", kind: "empty-level", levelName: "Staff" }),
      ]),
    );
  });

  test("notification-fragile: schemes naming an individual", async () => {
    accessFixture();
    expect((await run("notification-fragile")).items).toEqual([
      expect.objectContaining({ id: "n1", namedUserCount: 1 }),
    ]);
  });

  test("role-empty-admin: one item per project", async () => {
    accessFixture();
    expect((await run("role-empty-admin")).items).toEqual([{ id: "1", projectKey: "OPS", role: "Administrators" }]);
    // DEV is on no permission scheme in the fixture, has no admin-named role, so is not judged.
  });

  test("role-offroster-actors: grouped per project, not one per actor and not one for everything", async () => {
    accessFixture();
    const r = await run("role-offroster-actors");
    expect(r.items.map((g) => [g.id, g.count])).toEqual([
      ["DEV", 1],
      ["OPS", 1],
    ]);
    expect(r.items[0].members[0]).toMatchObject({ accountId: "gone-2", role: "Developers", projectKey: "DEV" });
  });

  test("an unbuilt access inventory is unavailable, not empty", async () => {
    mocks.readAccessSnapshotMeta.mockResolvedValueOnce(null);
    expect(await run("role-empty-admin")).toMatchObject({ available: false, reason: "no-snapshot" });
  });
});

describe("getRemediationCandidates -- filters, dashboards, people, issue types, priorities, Assets", () => {
  const run = (findingKey) =>
    getRemediationCandidates({
      payload: { findingKey },
      context: { installContext: "ari:cloud:jira::site/x", accountId: "admin-1" },
    });
  const owner = (active = true) => ({ accountId: "a", displayName: "Ann", active });

  test("filters: each finding reads every filter carrying its code", async () => {
    const old = "2024-01-01T00:00:00Z";
    const filters = [
      { id: "1", name: "Zombie", owner: owner(), subscriptionCount: 3, lastUsedAt: old, shares: [] },
      {
        id: "2",
        name: "Open",
        owner: owner(),
        subscriptionCount: 0,
        lastUsedAt: "2026-09-01T00:00:00Z",
        shares: [{ type: "authenticated" }],
      },
    ];
    for (const _key of ["filters-zombie-subscriptions", "filters-shared-everyone"]) {
      mocks.readFilterSnapshotMeta.mockResolvedValueOnce({ version: "f1" });
      mocks.loadFilters.mockResolvedValueOnce(filters);
      mocks.readSnapshotMeta.mockResolvedValueOnce(null);
      mocks.readIssueTypeSnapshotMeta.mockResolvedValueOnce(null);
    }
    expect((await run("filters-zombie-subscriptions")).items).toEqual([
      expect.objectContaining({ id: "1", ownerName: "Ann", subscriptionCount: 3 }),
    ]);
    expect((await run("filters-shared-everyone")).items).toEqual([expect.objectContaining({ id: "2" })]);
  });

  test("dashboards: open-edit, empty and published-unused each read their own code", async () => {
    const dashboards = [
      { id: "1", name: "Wall", owner: owner(), gadgetCount: 0, popularity: 4, shares: [], editShares: [] },
      {
        id: "2",
        name: "Anyone edits",
        owner: owner(),
        gadgetCount: 3,
        popularity: 2,
        shares: [],
        editShares: [{ type: "authenticated" }],
      },
      {
        id: "3",
        name: "Nobody wants",
        owner: owner(),
        gadgetCount: 2,
        popularity: 0,
        shares: [{ type: "authenticated" }],
        editShares: [],
      },
    ];
    for (let i = 0; i < 3; i += 1) {
      mocks.readDashboardSnapshotMeta.mockResolvedValueOnce({ version: "d1" });
      mocks.loadDashboards.mockResolvedValueOnce(dashboards);
    }
    expect((await run("dashboards-empty")).items.map((d) => d.id)).toEqual(["1"]);
    expect((await run("dashboards-open-edit")).items.map((d) => d.id)).toEqual(["2"]);
    expect((await run("dashboards-published-unused")).items.map((d) => d.id)).toEqual(["3"]);
  });

  // Live on ford-advev: the last dashboard build predated the filter probe, so every gadget
  // had a filter id and no state, and the finding read "Nothing currently flagged. Clean."
  test("broken gadgets: a snapshot whose gadget filters were never probed is not checked, not clean", async () => {
    const shared = [{ type: "authenticated" }];
    mocks.readDashboardSnapshotMeta.mockResolvedValueOnce({ version: "d1" });
    mocks.loadDashboards.mockResolvedValueOnce([
      {
        id: "1",
        name: "Ops",
        owner: owner(),
        gadgetCount: 1,
        shares: shared,
        editShares: [],
        gadgets: [{ id: "g1", filterId: "100", filterState: null }],
      },
    ]);
    expect(await run("dashboards-broken-gadgets")).toEqual({ available: false, reason: "not-probed", items: [] });

    mocks.readDashboardSnapshotMeta.mockResolvedValueOnce({ version: "d2" });
    mocks.loadDashboards.mockResolvedValueOnce([
      {
        id: "1",
        name: "Ops",
        owner: owner(),
        gadgetCount: 2,
        shares: shared,
        editShares: [],
        gadgets: [
          { id: "g1", title: "Bugs", filterId: "100", filterState: "missing" },
          { id: "g2", filterId: "101", filterState: "readable" },
        ],
      },
      {
        id: "2",
        name: "Fine",
        owner: owner(),
        gadgetCount: 1,
        shares: shared,
        editShares: [],
        gadgets: [{ id: "g3", filterId: "101", filterState: "readable" }],
      },
    ]);
    const probed = await run("dashboards-broken-gadgets");
    expect(probed.items.map((d) => d.id)).toEqual(["1"]);
    expect(probed.items[0].brokenGadgets).toEqual([
      expect.objectContaining({ filterId: "100", filterState: "missing" }),
    ]);

    // No filter gadgets anywhere: nothing to probe, and genuinely clean.
    mocks.readDashboardSnapshotMeta.mockResolvedValueOnce({ version: "d3" });
    mocks.loadDashboards.mockResolvedValueOnce([
      {
        id: "3",
        name: "Text only",
        owner: owner(),
        gadgetCount: 1,
        shares: [],
        editShares: [],
        gadgets: [{ id: "g4", filterId: null }],
      },
    ]);
    expect(await run("dashboards-broken-gadgets")).toEqual({ available: true, items: [] });
  });

  test("people: one item per off-roster account, with the rules that name it", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValueOnce({ version: "u1" });
    mocks.loadUsers.mockResolvedValueOnce([{ accountId: "live" }]);
    mocks.readAutomationPart
      .mockResolvedValueOnce({
        entries: [
          { label: "gone", write: [11], read: [12] },
          { label: "live", write: [13] },
        ],
      })
      .mockResolvedValueOnce({
        rules: [
          [11, "Assign triage", 1, null, 1, null],
          [12, "Notify", 1, null, 1, null],
        ],
      });

    const r = await run("people-offroster-automation-refs");

    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ id: "gone", ruleCount: 2 });
    expect(r.items[0].rules).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 11, name: "Assign triage", direction: "write" })]),
    );
  });

  test("people: unavailable, not empty, before the automation index is imported", async () => {
    mocks.readUserSnapshotMeta.mockResolvedValueOnce({ version: "u1" });
    mocks.loadUsers.mockResolvedValueOnce([]);
    mocks.readAutomationPart.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    expect(await run("people-offroster-automation-refs")).toMatchObject({
      available: false,
      reason: "no-automation-index",
    });
  });

  test("issue types: every hierarchy-flagged and every unused scheme, past the tab's 25", async () => {
    const schemes = Array.from({ length: 30 }, (_, i) => ({
      schemeId: `s${i}`,
      name: `Scheme ${i}`,
      projectCount: 0,
      defaultIssueTypeId: "99",
    }));
    for (let i = 0; i < 2; i += 1) {
      mocks.readIssueTypeSnapshotMeta.mockResolvedValueOnce({ state: "ready", version: "v1" });
      mocks.loadIssueTypes.mockResolvedValueOnce([{ id: "1", name: "Story", hierarchyLevel: 0 }]);
      mocks.loadIssueTypeSchemes.mockResolvedValueOnce(schemes);
      mocks.loadIssueTypeSchemeItems.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      mocks.loadIssueTypeSchemeProjects.mockResolvedValueOnce([]);
      mocks.loadIssueTypeGovernanceSummary.mockResolvedValueOnce({});
      mocks.readScreenSnapshotMeta.mockResolvedValueOnce(null);
      mocks.readIssueScanMeta.mockResolvedValueOnce(null);
    }
    const hierarchy = await run("issue-type-hierarchy");
    expect(hierarchy.items).toHaveLength(30); // default type 99 is not in any scheme
    expect(hierarchy.items[0].flags[0]).toMatch(/default issue type/i);
    expect((await run("issue-type-unused-schemes")).items).toHaveLength(30);
  });

  test("priorities: one item per near-duplicate group", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValueOnce({ state: "ready", version: "v1" });
    mocks.loadEstateValues.mockResolvedValueOnce([{ id: "1", name: "Done" }]).mockResolvedValueOnce([
      { id: "10", name: "High" },
      { id: "11", name: "high" },
    ]);
    const r = await run("estate-duplicate-priorities");
    expect(r.items).toEqual([expect.objectContaining({ names: ["High", "high"], count: 2 })]);
    expect(r.items[0].id).toBeTruthy();
  });

  test("Assets: broken references carry the schema and type name their link needs", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValueOnce({ state: "ready", version: "v1" });
    mocks.loadAssetSchemas.mockResolvedValueOnce([{ id: "s1", name: "IT", objectTypeCount: 1, objectCount: 1 }]);
    mocks.loadAssetObjectTypes.mockResolvedValueOnce([{ id: "t1", schemaId: "s1", name: "Laptop" }]);
    mocks.loadAssetAttributes.mockResolvedValueOnce([
      { id: "a1", objectTypeId: "t1", schemaId: "s1", name: "Owner", referenceObjectTypeId: "gone" },
    ]);
    mocks.loadAssetTypeCounts.mockResolvedValueOnce([]);
    mocks.readAssetTypeCountMeta.mockResolvedValueOnce(null);

    const r = await run("asset-broken-references");

    expect(r.items).toEqual([
      expect.objectContaining({ id: "a1", schemaId: "s1", objectTypeName: "Laptop", referenceObjectTypeId: "gone" }),
    ]);
  });

  test("Assets: an unlicensed site says so", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValueOnce({ state: "unavailable" });
    expect(await run("asset-bare-types")).toMatchObject({ available: false, reason: "assets-not-enabled" });
  });
});

describe("getRemediationCandidates -- fields, workflows, projects, screens, automation", () => {
  const run = (findingKey) =>
    getRemediationCandidates({
      payload: { findingKey },
      context: { installContext: "ari:cloud:jira::site/x", accountId: "admin-1" },
    });

  test("fields: each code reads the threshold-aware findings, with the reason text on the item", async () => {
    mocks.readSnapshotMeta.mockResolvedValueOnce({ version: "s1" });
    mocks.loadSnapshotFields.mockResolvedValueOnce([
      // Widely used, no description.
      {
        id: "customfield_1",
        name: "Team",
        type: "select",
        description: "",
        configuredProjectCount: 40,
        activeProjectCount: 40,
        totalIssueCount: 90000,
        findings: null,
      },
      {
        id: "customfield_2",
        name: "Budget",
        type: "number",
        description: "Money",
        configuredProjectCount: 1,
        activeProjectCount: 1,
        totalIssueCount: 10,
        findings: null,
      },
    ]);
    const r = await run("field-missing-description");
    expect(r.available).toBe(true);
    expect(r.items.map((f) => f.id)).toEqual(["customfield_1"]);
    expect(r.items[0].reasons[0]).toEqual(expect.any(String));
  });

  test("fields: unavailable before any field snapshot exists", async () => {
    mocks.readSnapshotMeta.mockResolvedValueOnce(null);
    expect(await run("field-stale")).toMatchObject({ available: false, reason: "no-snapshot" });
  });

  function workflowFixture() {
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce({ version: "w1" });
    mocks.loadWorkflowSchemes.mockResolvedValueOnce([{ id: "10", name: "No Done", projectCount: 2 }]);
    mocks.loadStatusesCatalog.mockResolvedValueOnce([
      { id: "1", name: "Open", statusCategory: "new" },
      { id: "2", name: "open", statusCategory: "new" },
      { id: "3", name: "Legacy", statusCategory: "indeterminate" },
      { id: "4", name: "Robot only", statusCategory: "indeterminate" },
    ]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValueOnce([
      { schemeId: "10", statusId: "1" },
      { schemeId: "10", statusId: "2" },
    ]);
    mocks.loadStatusIssueCounts.mockResolvedValueOnce(
      new Map([
        ["1", 5],
        ["2", 1],
        ["3", 7],
        ["4", 0],
      ]),
    );
    mocks.loadStatusHistoryCounts.mockResolvedValueOnce({ counts: new Map(), measuredAt: null });
    mocks.loadStatusAutomationReferences.mockResolvedValueOnce({ "robot only": { ruleCount: 2, enabledRuleCount: 2 } });
  }

  test("workflows: duplicate groups, rule-only, unreachable-with-issues and scheme structure", async () => {
    workflowFixture();
    const dupes = await run("workflow-duplicate-statuses");
    expect(dupes.items[0].statuses.map((st) => [st.name, st.issueCount])).toEqual([
      ["Open", 5],
      ["open", 1],
    ]);

    workflowFixture();
    expect((await run("unreachable-with-issues")).items).toEqual([{ id: "3", name: "Legacy", issueCount: 7 }]);

    workflowFixture();
    const structure = await run("workflow-scheme-structure");
    expect(structure.items[0]).toMatchObject({
      id: "10",
      name: "No Done",
      flags: expect.arrayContaining([expect.stringMatching(/No Done/)]),
    });
  });

  test("workflows: unavailable, not empty, when the scheme->status mapping is missing", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce({ version: "w1" });
    mocks.loadWorkflowSchemes.mockResolvedValueOnce([]);
    mocks.loadStatusesCatalog.mockResolvedValueOnce([{ id: "1", name: "Open" }]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValueOnce([]);
    mocks.loadStatusIssueCounts.mockResolvedValueOnce(new Map());
    mocks.loadStatusHistoryCounts.mockResolvedValueOnce({ counts: new Map(), measuredAt: null });
    expect(await run("rule-only-statuses")).toMatchObject({ available: false, reason: "no-scheme-mapping" });
  });

  test("projects: over-configured (idle marked) and unused, every one rather than the Overview's top 8", async () => {
    const projects = [
      ...Array.from({ length: 12 }, (_, i) => ({
        projectId: `${i}`,
        projectKey: `P${i}`,
        projectName: `P${i}`,
        fieldCount: 50,
        totalIssueCount: 10,
      })),
      ...Array.from({ length: 12 }, (_, i) => ({
        projectId: `n${i}`,
        projectKey: `N${i}`,
        projectName: `N${i}`,
        fieldCount: 2,
        totalIssueCount: 5000,
      })),
      { projectId: "u", projectKey: "UNUSED", projectName: "Unused", fieldCount: 3, totalIssueCount: 0 },
    ];
    for (let i = 0; i < 2; i += 1) {
      mocks.readSnapshotMeta.mockResolvedValueOnce({ version: "s1" });
      mocks.listSnapshotProjects.mockResolvedValueOnce(projects);
      mocks.loadProjectActivity.mockResolvedValueOnce(new Map());
    }
    const over = await run("project-over-configured");
    expect(over.items).toHaveLength(12);
    expect(over.items.every((p) => p.idle)).toBe(true);
    expect((await run("unused-projects")).items.map((p) => p.projectKey)).toEqual(["UNUSED"]);
  });

  test("projects: no adoption tasks while the activity data is stale or unmeasured", async () => {
    mocks.readSnapshotMeta.mockResolvedValueOnce({ version: "s1" });
    mocks.listSnapshotProjects.mockResolvedValueOnce([
      { projectId: "1", projectKey: "A", projectName: "A", fieldCount: 3, totalIssueCount: 9 },
    ]);
    mocks.loadProjectActivity.mockResolvedValueOnce(new Map());
    expect(await run("projects-fell-off")).toEqual({ available: true, items: [] });
  });

  test("screens: a filtered screen list, and unreachable needs the workflow snapshot", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValueOnce({ version: "sv1" });
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce(null);
    mocks.loadScreensPage.mockResolvedValueOnce({
      rows: [{ screenId: "7", name: "Blank", tabCount: 1, fieldCount: 0 }],
    });
    expect((await run("screen-empty")).items).toEqual([{ id: "7", name: "Blank", tabCount: 1, fieldCount: 0 }]);
    expect(mocks.loadScreensPage.mock.calls[0][2]).toMatchObject({ filter: "empty" });

    mocks.readScreenSnapshotMeta.mockResolvedValueOnce({ version: "sv1" });
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce(null);
    expect(await run("screen-unreached")).toMatchObject({ available: false, reason: "no-workflow-snapshot" });

    // A snapshot that never read transitions would ticket screens a transition opens.
    mocks.readScreenSnapshotMeta.mockResolvedValueOnce({ version: "sv1" });
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce({ version: "wv1", transitionScreens: null });
    expect(await run("screen-unreached")).toMatchObject({ available: false, reason: "transitions-unknown" });
  });

  test("screens: dangling operations grouped per scheme; unused schemes", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValueOnce({ version: "sv1" });
    mocks.loadScreenSchemeOperations.mockResolvedValueOnce([
      { schemeId: "s1", operation: "create", screenId: "99", dangling: true },
      { schemeId: "s1", operation: "edit", screenId: "98", dangling: true },
      { schemeId: "s2", operation: "view", screenId: "1", dangling: false },
    ]);
    mocks.loadScreenSchemes.mockResolvedValueOnce([
      { schemeId: "s1", name: "Broken", issueTypeSchemeCount: 1 },
      { schemeId: "s2", name: "Fine", issueTypeSchemeCount: 1 },
    ]);
    const dangling = await run("screen-dangling");
    expect(dangling.items).toEqual([
      {
        id: "s1",
        name: "Broken",
        operations: [
          { operation: "create", screenId: "99" },
          { operation: "edit", screenId: "98" },
        ],
      },
    ]);

    mocks.readScreenSnapshotMeta.mockResolvedValueOnce({ version: "sv1" });
    mocks.loadScreenSchemes.mockResolvedValueOnce([
      { schemeId: "s3", name: "Orphan", issueTypeSchemeCount: 0 },
      { schemeId: "s2", name: "Fine", issueTypeSchemeCount: 2 },
    ]);
    expect((await run("screen-unused-schemes")).items).toEqual([{ id: "s3", name: "Orphan" }]);
  });

  test("automation: disabled rules in full from the directory", async () => {
    mocks.readAutomationPart.mockResolvedValueOnce({
      rules: [
        [1, "On", 1, null, 2, null],
        [2, "Off", 0, "jira:issue_created", 1, null],
      ],
    });
    expect((await run("automation-disabled")).items).toEqual([
      expect.objectContaining({ id: 2, name: "Off", enabled: false }),
    ]);
  });

  test("automation: risk findings are marked partial when the preview holds fewer than the count", async () => {
    mocks.readAutomationAnalysis.mockResolvedValueOnce({
      estate: { health: { credentialRuleCount: 9 } },
      findingsPreview: [
        { id: 1, n: "Webhook", e: 1, r: [{ c: "embedded-credential", s: "high" }] },
        { id: 2, n: "Other", e: 1, r: [{ c: "external-http", h: ["x.io"] }] },
      ],
    });
    const r = await run("automation-credentials");
    expect(r).toMatchObject({ available: true, partial: true, expected: 9 });
    expect(r.items).toEqual([expect.objectContaining({ id: 1, name: "Webhook", enabled: true })]);
  });

  test("automation: not partial when the preview holds every flagged rule", async () => {
    mocks.readAutomationAnalysis.mockResolvedValueOnce({
      estate: { health: { externalHttpCount: 1 } },
      findingsPreview: [{ id: 2, n: "Other", e: 1, r: [{ c: "external-http", h: ["x.io"] }] }],
    });
    const r = await run("automation-external");
    expect(r.partial).toBeUndefined();
    expect(r.items[0].hosts).toEqual(["x.io"]);
  });

  test("automation: self-triggering rules from the stored cascades, once each", async () => {
    mocks.readAutomationAnalysis.mockResolvedValueOnce({
      estate: { health: { selfTriggeringCount: 1 } },
      cascades: [
        { sourceId: 5, sourceName: "Loop", targetId: 5, selfTriggering: true },
        { sourceId: 5, sourceName: "Loop", targetId: 5, selfTriggering: true },
        { sourceId: 6, targetId: 7, selfTriggering: false },
      ],
    });
    mocks.readAutomationPart.mockResolvedValueOnce(null);
    expect((await run("automation-self-triggering")).items).toEqual([expect.objectContaining({ id: 5, name: "Loop" })]);
  });
});

describe("getRemediationCandidates -- every new loader is explicitly unavailable before its data exists", () => {
  const run = (findingKey) =>
    getRemediationCandidates({
      payload: { findingKey },
      context: { installContext: "ari:cloud:jira::site/x", accountId: "admin-1" },
    });

  test.each([
    ["field-admin-attention", "readSnapshotMeta", "no-snapshot"],
    ["field-risky", "readSnapshotMeta", "no-snapshot"],
    ["workflow-duplicate-statuses", "readWorkflowSnapshotMeta", "no-snapshot"],
    ["unused-projects", "readSnapshotMeta", "no-snapshot"],
    ["screen-empty", "readScreenSnapshotMeta", "no-snapshot"],
    ["screen-dangling", "readScreenSnapshotMeta", "no-snapshot"],
    ["screen-unused-schemes", "readScreenSnapshotMeta", "no-snapshot"],
    ["filters-shared-everyone", "readFilterSnapshotMeta", "no-snapshot"],
    ["dashboards-empty", "readDashboardSnapshotMeta", "no-snapshot"],
    ["people-offroster-automation-refs", "readUserSnapshotMeta", "no-snapshot"],
    ["issue-type-hierarchy", "readIssueTypeSnapshotMeta", "no-snapshot"],
    ["estate-duplicate-priorities", "readEstateSnapshotMeta", "no-snapshot"],
    ["asset-bare-types", "readAssetSnapshotMeta", "no-snapshot"],
  ])("%s", async (key, metaMock, reason) => {
    mocks[metaMock].mockResolvedValueOnce(null);
    expect(await run(key)).toMatchObject({ available: false, reason, items: [] });
  });

  test.each([
    ["automation-disabled", "no-automation-index"],
    ["automation-inert", "no-analysis"],
    ["automation-self-triggering", "no-analysis"],
  ])("%s", async (key, reason) => {
    mocks.readAutomationAnalysis.mockResolvedValueOnce(null);
    mocks.readAutomationPart.mockResolvedValueOnce(null);
    expect(await run(key)).toMatchObject({ available: false, reason });
  });

  test("rule-only statuses: the orphans an automation rule still names", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce({ version: "w1" });
    mocks.loadWorkflowSchemes.mockResolvedValueOnce([{ id: "10", name: "S", projectCount: 1 }]);
    mocks.loadStatusesCatalog.mockResolvedValueOnce([
      { id: "1", name: "Open" },
      { id: "4", name: "Robot only" },
    ]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValueOnce([{ schemeId: "10", statusId: "1" }]);
    mocks.loadStatusIssueCounts.mockResolvedValueOnce(new Map([["4", 0]]));
    mocks.loadStatusHistoryCounts.mockResolvedValueOnce({ counts: new Map(), measuredAt: null });
    mocks.loadStatusAutomationReferences.mockResolvedValueOnce({ "robot only": { ruleCount: 2, enabledRuleCount: 1 } });
    const r = await run("rule-only-statuses");
    expect(r.items).toEqual([expect.objectContaining({ id: "4", name: "Robot only" })]);
  });

  test("stale projects: every project untouched for over 180 days", async () => {
    mocks.readSnapshotMeta.mockResolvedValueOnce({ version: "s1" });
    mocks.listSnapshotProjects.mockResolvedValueOnce([
      {
        projectId: "1",
        projectKey: "OLD",
        projectName: "Old",
        fieldCount: 3,
        totalIssueCount: 9,
        latestIssueUpdatedAt: "2024-01-01T00:00:00Z",
      },
      {
        projectId: "2",
        projectKey: "NEW",
        projectName: "New",
        fieldCount: 3,
        totalIssueCount: 9,
        latestIssueUpdatedAt: new Date().toISOString(),
      },
    ]);
    mocks.loadProjectActivity.mockResolvedValueOnce(new Map());
    expect((await run("stale-projects")).items.map((p) => p.projectKey)).toEqual(["OLD"]);
  });
});

// The quarter's hierarchy above the epics (lib/remediation-hierarchy.js has the naming and
// adopt-or-create rules; these cover the resolvers that use it).
describe("remediation hierarchy", () => {
  const ITEMS = [{ id: "4001", name: "Open Bugs" }];
  const config = (over = {}) => ({
    readOnlyMode: false,
    remediation: {
      projectKey: "ATLASDEV",
      epicIssueType: "Epic",
      taskIssueType: "Task",
      hierarchyEnabled: true,
      rootIssueType: "Product",
      initiativeIssueType: "Initiative",
      ...over,
    },
  });

  beforeEach(() => {
    mocks.getRemediationEpic.mockResolvedValue(null);
    mocks.loadTicketedItemIds.mockResolvedValue(new Set());
    mocks.loadHierarchyNodes.mockResolvedValue(new Map());
    mocks.searchIssuesPage.mockResolvedValue([]);
    let n = 0;
    mocks.createJiraIssue.mockImplementation(async () => {
      n += 1;
      return { id: String(n), key: `ATLASDEV-${n}` };
    });
  });

  test("the quarter's first epic brings its Product and Initiative, and is filed under the initiative", async () => {
    mocks.kvsGet.mockResolvedValue(config());
    const r = await createRemediationEpic({
      payload: { findingKey: "filter-ownership", items: ITEMS },
      context: ctxWithAccount("admin-1"),
    });
    expect(r.ok).toBe(true);
    const [root, initiative, epic] = mocks.createJiraIssue.mock.calls.map(([f]) => f);
    expect(root).toMatchObject({
      issuetype: { name: "Product" },
      summary: expect.stringMatching(/Observatory Findings and Remediations$/),
    });
    expect(initiative).toMatchObject({
      issuetype: { name: "Initiative" },
      summary: expect.stringMatching(/ - Filters Remediation$/),
      parent: { key: "ATLASDEV-1" },
    });
    expect(epic).toMatchObject({ issuetype: { name: "Epic" }, parent: { key: "ATLASDEV-2" } });
  });

  test("an initiative already in Jira is adopted, not duplicated", async () => {
    mocks.kvsGet.mockResolvedValue(config());
    mocks.loadHierarchyNodes.mockResolvedValue(new Map([["root", { issueKey: "ATLASDEV-5627" }]]));
    mocks.searchIssuesPage.mockResolvedValue([
      { key: "ATLASDEV-5616", id: "5616", fields: { summary: "2026-Q3 - Filters Remediation" } },
    ]);
    await createRemediationEpic({
      payload: { findingKey: "filter-ownership", items: ITEMS },
      context: ctxWithAccount(),
    });
    const epic = mocks.createJiraIssue.mock.calls.map(([f]) => f).find((f) => f.issuetype.name === "Epic");
    expect(epic.parent).toEqual({ key: "ATLASDEV-5616" });
    expect(mocks.createJiraIssue.mock.calls.some(([f]) => f.issuetype.name === "Initiative")).toBe(false);
  });

  test("with the hierarchy off, epics are created exactly as before", async () => {
    mocks.kvsGet.mockResolvedValue(config({ hierarchyEnabled: false }));
    await createRemediationEpic({
      payload: { findingKey: "filter-ownership", items: ITEMS },
      context: ctxWithAccount(),
    });
    expect(mocks.createJiraIssue.mock.calls[0][0].issuetype.name).toBe("Epic");
    expect(mocks.createJiraIssue.mock.calls[0][0].parent).toBeUndefined();
    expect(mocks.searchIssuesPage).not.toHaveBeenCalled();
  });

  test("if the hierarchy cannot be built, nothing is created and the error says what to check", async () => {
    mocks.kvsGet.mockResolvedValue(config());
    mocks.createJiraIssue.mockRejectedValueOnce(
      Object.assign(new Error("issue type Product not found"), { status: 400 }),
    );
    const r = await createRemediationEpic({
      payload: { findingKey: "filter-ownership", items: ITEMS },
      context: ctxWithAccount(),
    });
    expect(r.error).toMatch(
      /Placing the epic under its initiative failed: issue type Product not found.*Configuration/,
    );
    expect(mocks.recordRemediationTicket).not.toHaveBeenCalled();
  });

  test("organise moves only epics not already under their initiative", async () => {
    mocks.kvsGet.mockResolvedValue(config());
    mocks.loadHierarchyNodes.mockResolvedValue(
      new Map([
        ["root", { issueKey: "ATLASDEV-5627" }],
        ["initiative:Filters", { issueKey: "ATLASDEV-5616" }],
        ["initiative:Roles", { issueKey: "ATLASDEV-5624" }],
      ]),
    );
    mocks.loadRemediationTickets.mockResolvedValueOnce([
      { isEpic: true, period: "2026-Q3", pillar: "filters", issueKey: "ATLASDEV-100" },
      { isEpic: true, period: "2026-Q3", pillar: "roles", issueKey: "ATLASDEV-200" },
      { isEpic: false, period: "2026-Q3", pillar: "roles", issueKey: "ATLASDEV-201" },
      { isEpic: true, period: "2026-Q2", pillar: "roles", issueKey: "ATLASDEV-50" },
    ]);
    mocks.searchIssuesPage.mockResolvedValueOnce([
      { key: "ATLASDEV-100", fields: { parent: { key: "ATLASDEV-5616" } } },
      { key: "ATLASDEV-200", fields: { parent: null } },
    ]);
    const r = await organiseRemediationHierarchy({ context: ctxWithAccount() });
    expect(r).toMatchObject({
      ok: true,
      organised: 1,
      alreadyPlaced: 1,
      remaining: 0,
      failures: [],
      rootKey: "ATLASDEV-5627",
    });
    expect(mocks.updateJiraIssue).toHaveBeenCalledTimes(1);
    expect(mocks.updateJiraIssue).toHaveBeenCalledWith(
      "ATLASDEV-200",
      { parent: { key: "ATLASDEV-5624" } },
      { asUser: true },
    );
  });

  test("organise refuses in read-only mode and when the hierarchy is off", async () => {
    mocks.kvsGet.mockResolvedValueOnce({ ...config(), readOnlyMode: true });
    expect((await organiseRemediationHierarchy({ context: ctxWithAccount() })).error).toMatch(/Read-only/);
    mocks.kvsGet.mockResolvedValueOnce(config({ hierarchyEnabled: false }));
    expect((await organiseRemediationHierarchy({ context: ctxWithAccount() })).error).toMatch(/hierarchy is off/);
    expect(mocks.updateJiraIssue).not.toHaveBeenCalled();
  });

  test("a failed move is reported per epic, and the rest still move", async () => {
    mocks.kvsGet.mockResolvedValue(config());
    mocks.loadHierarchyNodes.mockResolvedValue(
      new Map([
        ["root", { issueKey: "R" }],
        ["initiative:Filters", { issueKey: "F" }],
      ]),
    );
    mocks.loadRemediationTickets.mockResolvedValueOnce([
      { isEpic: true, period: "2026-Q3", pillar: "filters", issueKey: "E1" },
      { isEpic: true, period: "2026-Q3", pillar: "filters", issueKey: "E2" },
    ]);
    mocks.updateJiraIssue.mockRejectedValueOnce(new Error("parent not allowed"));
    const r = await organiseRemediationHierarchy({ context: ctxWithAccount() });
    expect(r.organised).toBe(1);
    expect(r.failures).toEqual([{ epicKey: "E1", error: "parent not allowed" }]);
  });

  test("is admin-only", () => {
    expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toContain("organiseRemediationHierarchy");
    expect(Object.keys(SHARED_RESOLVER_FUNCTIONS)).not.toContain("organiseRemediationHierarchy");
  });

  test("config validation rejects a non-boolean hierarchy switch", async () => {
    await expect(saveAdminConfigResolver({ payload: { remediation: { hierarchyEnabled: "yes" } } })).rejects.toThrow(
      /hierarchyEnabled/,
    );
  });
});
