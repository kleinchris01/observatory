import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, snapshotField, ctxWithAccount } from "./test-harness.js";
import { __RAW_ADMIN_ONLY_FUNCTIONS, SHARED_RESOLVER_FUNCTIONS } from "../resolvers.js";

const { buildFieldConfigInventory } = __RAW_ADMIN_ONLY_FUNCTIONS;
const { getFieldInventory, getFieldDetails, getFilteredFieldIds, getFieldOptions, searchFieldOptions } = {
  ...SHARED_RESOLVER_FUNCTIONS,
  ...__RAW_ADMIN_ONLY_FUNCTIONS,
};

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// getFieldInventory -- the main inventory list: pagination, filtering
// (delegated to the real analysis.js), and force-refresh snapshot-queueing
// with race-token protection.
// ---------------------------------------------------------------------------
describe("getFieldInventory", () => {
  test("returns an empty, non-error shape when no snapshot has ever completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.kvsGet.mockResolvedValue(null);
    const result = await getFieldInventory({ payload: {}, context: {} });
    expect(result.fields).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.snapshotStatus.state).toBe("idle");
  });

  test("returns paginated, hydrated fields from the latest snapshot version", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 3, state: "ready", refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.kvsGet.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([
      snapshotField({ id: "customfield_1", name: "Alpha" }),
      snapshotField({ id: "customfield_2", name: "Beta" }),
    ]);
    const result = await getFieldInventory({ payload: { pageSize: 1, page: 1 }, context: {} });
    expect(result.total).toBe(2);
    expect(result.fields).toHaveLength(1);
    expect(result.totalPages).toBe(2);
    expect(result.fields[0].name).toBe("Alpha"); // default sort name-asc
  });

  test("clamps the requested page to the last valid page instead of returning empty", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, state: "ready" });
    mocks.kvsGet.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    const result = await getFieldInventory({ payload: { page: 99, pageSize: 10 }, context: {} });
    expect(result.page).toBe(1);
    expect(result.fields).toHaveLength(1);
  });

  test("validates page and pageSize bounds", async () => {
    await expect(getFieldInventory({ payload: { page: 0 }, context: {} })).rejects.toThrow(/page/);
    await expect(getFieldInventory({ payload: { pageSize: 500 }, context: {} })).rejects.toThrow(/pageSize/);
  });

  test("force-refresh claims the queue slot with a token and only queues once", async () => {
    mocks.readSnapshotMeta
      .mockResolvedValueOnce({ version: 1, state: "idle" }) // initial read
      .mockResolvedValueOnce({ version: 1, state: "queued", jobToken: "job-token-1" }); // post-claim verify
    mocks.kvsGet.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);

    await getFieldInventory({ payload: { forceRefresh: true }, context: {} });

    expect(mocks.writeSnapshotMeta).toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({ state: "queued", jobToken: "job-token-1" }),
    );
    expect(mocks.queueSnapshotBuild).toHaveBeenCalledTimes(1);
  });

  test("force-refresh does not queue a second build if another caller already claimed the slot", async () => {
    mocks.readSnapshotMeta
      .mockResolvedValueOnce({ version: 1, state: "idle" })
      .mockResolvedValueOnce({ version: 1, state: "queued", jobToken: "someone-elses-token" }); // lost the race
    mocks.kvsGet.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([]);

    await getFieldInventory({ payload: { forceRefresh: true }, context: {} });

    expect(mocks.queueSnapshotBuild).not.toHaveBeenCalled();
  });

  test("force-refresh does not queue when the app is in read-only mode", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, state: "idle" });
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true });
    mocks.loadSnapshotFields.mockResolvedValue([]);

    await getFieldInventory({ payload: { forceRefresh: true }, context: {} });

    expect(mocks.queueSnapshotBuild).not.toHaveBeenCalled();
    expect(mocks.writeSnapshotMeta).not.toHaveBeenCalled();
  });

  test("force-refresh on a stuck 'building' state re-queues via requeueStaleSnapshotBuild", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, state: "building" });
    mocks.requeueStaleSnapshotBuild.mockResolvedValue({ version: 1, state: "queued" });
    mocks.kvsGet.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([]);

    await getFieldInventory({ payload: { forceRefresh: true }, context: {} });

    expect(mocks.requeueStaleSnapshotBuild).toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({ state: "building" }),
    );
  });

  // Regression test: requeueStaleSnapshotBuild transitions state "building" -> "queued"
  // in this same request. A prior bug re-read that fresh "queued" state as if it were a
  // stuck leftover from an earlier request and immediately reset it back to "idle",
  // silently undoing the requeue every time (this is what broke the admin "Force resume
  // (stalled)" button — see the plan file for the full trace).
  test("force-refresh on a stuck 'building' state does NOT undo the requeue it just performed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, state: "building" });
    mocks.requeueStaleSnapshotBuild.mockResolvedValue({ version: 1, state: "queued", jobToken: "requeue-token" });
    mocks.kvsGet.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([]);

    const result = await getFieldInventory({ payload: { forceRefresh: true }, context: {} });

    // Must NOT reset the fresh "queued" state back to "idle"
    expect(mocks.writeSnapshotMeta).not.toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({ state: "idle" }),
    );
    // Already active (queued) after the requeue, so no separate/duplicate queue push
    expect(mocks.queueSnapshotBuild).not.toHaveBeenCalled();
    expect(result.snapshotStatus.state).toBe("queued");
  });

  // The reset-to-idle path is still correct for a job that was ALREADY stuck in
  // "queued" before this request started (not one this request just produced) --
  // and, since shouldQueue is now computed after the reset, it should also push a
  // fresh build in the same call rather than requiring a second click.
  test("force-refresh resets an already-stuck 'queued' state to idle and re-queues a fresh build in the same call", async () => {
    mocks.readSnapshotMeta
      .mockResolvedValueOnce({ version: 1, state: "queued", jobToken: "stale-token" }) // initial read
      .mockResolvedValueOnce({ version: 1, state: "idle" }) // after reset-to-idle write
      .mockResolvedValueOnce({ version: 1, state: "queued", jobToken: "job-token-1" }); // post-claim verify
    mocks.kvsGet.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([]);

    const result = await getFieldInventory({ payload: { forceRefresh: true }, context: {} });

    expect(mocks.writeSnapshotMeta).toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({ state: "idle", lastError: "Queue job did not start; reset by manual refresh." }),
    );
    expect(mocks.queueSnapshotBuild).toHaveBeenCalledTimes(1);
    expect(result.snapshotStatus.state).toBe("queued");
  });

  test("propagates errors and increments the failure metric", async () => {
    mocks.readSnapshotMeta.mockRejectedValue(new Error("SQL connection lost"));
    await expect(getFieldInventory({ payload: {}, context: {} })).rejects.toThrow("SQL connection lost");
    expect(mocks.incrMetric).toHaveBeenCalledWith("resolver-failed");
  });
});

// ---------------------------------------------------------------------------
// getFieldDetails
// ---------------------------------------------------------------------------
describe("getFieldDetails", () => {
  test("requires a non-empty fieldId", async () => {
    await expect(getFieldDetails({ payload: {}, context: {} })).rejects.toThrow(/fieldId/);
  });

  test("throws when no snapshot has completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    await expect(getFieldDetails({ payload: { fieldId: "customfield_1" }, context: {} })).rejects.toThrow(
      /No completed snapshot/,
    );
  });

  test("throws when the field isn't found in the snapshot", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotField.mockResolvedValue(null);
    mocks.loadSnapshotProjectUsage.mockResolvedValue([]);
    mocks.countSnapshotProjectUsage.mockResolvedValue(0);
    mocks.loadFieldSummary.mockResolvedValue(null);
    await expect(getFieldDetails({ payload: { fieldId: "customfield_missing" }, context: {} })).rejects.toThrow(
      /Field not found in snapshot/,
    );
  });

  test("returns hydrated field detail with paginated project usage", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.loadSnapshotField.mockResolvedValue(snapshotField());
    mocks.loadSnapshotProjectUsage.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 5, jql: null },
    ]);
    mocks.countSnapshotProjectUsage.mockResolvedValue(1);
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);

    const result = await getFieldDetails({ payload: { fieldId: "customfield_10001" }, context: {} });

    expect(result.field.id).toBe("customfield_10001");
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].projectKey).toBe("ABC");
    expect(result.projectUsageTotalProjects).toBe(1);
  });

  test("attaches the field x user usage, with roster names and a not-licensed flag", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotField.mockResolvedValue(snapshotField());
    mocks.loadSnapshotProjectUsage.mockResolvedValue([]);
    mocks.countSnapshotProjectUsage.mockResolvedValue(0);
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    mocks.loadFieldUserUsage.mockResolvedValue({
      distinctUsers: 2,
      issueTotal: 12,
      top: [
        { accountId: "acc-1", displayName: "stale name", issueCount: 10 },
        { accountId: "acc-gone", displayName: "Ghost", issueCount: 2 },
      ],
    });
    mocks.readUserSnapshotMeta.mockResolvedValue({ version: "u1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "acc-1", displayName: "Ann Admin" }]);

    const result = await getFieldDetails({ payload: { fieldId: "customfield_10001" }, context: {} });

    expect(result.userValueUsage.distinctUsers).toBe(2);
    expect(result.userValueUsage.top[0]).toMatchObject({ displayName: "Ann Admin", onRoster: true });
    expect(result.userValueUsage.top[1]).toMatchObject({ displayName: "Ghost", onRoster: false });
  });

  test("marks summaryStatus as failed when a 'ready' summary claims active projects but has none listed (self-healing detection)", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotField.mockResolvedValue(snapshotField({ activeProjectCount: 3 }));
    mocks.loadSnapshotProjectUsage.mockResolvedValue([]);
    mocks.countSnapshotProjectUsage.mockResolvedValue(0);
    mocks.loadFieldSummary.mockResolvedValue({
      summaryStatus: "ready",
      activeProjectCount: 3,
      activeProjects: [], // broken: claims ready+active but lists nothing
    });
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);

    const result = await getFieldDetails({ payload: { fieldId: "customfield_10001" }, context: {} });

    expect(result.summaryStatus).toBe("failed");
  });

  test("falls back to live field-context lookup when the summary has no cached contexts", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotField.mockResolvedValue(snapshotField());
    mocks.loadSnapshotProjectUsage.mockResolvedValue([]);
    mocks.countSnapshotProjectUsage.mockResolvedValue(0);
    mocks.loadFieldSummary.mockResolvedValue({ summaryStatus: "ready", contexts: [] });
    mocks.loadFieldContexts.mockResolvedValue([{ id: "ctx-1", isGlobal: true }]);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);

    const result = await getFieldDetails({ payload: { fieldId: "customfield_10001" }, context: {} });

    expect(mocks.loadFieldContexts).toHaveBeenCalledWith("customfield_10001");
    expect(result.contexts).toEqual([{ id: "ctx-1", isGlobal: true }]);
  });

  test("never returns a project row the caller lacks Browse Projects permission on", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.loadSnapshotField.mockResolvedValue(snapshotField());
    mocks.loadSnapshotProjectUsage.mockResolvedValue([
      { projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 5, jql: null },
      { projectId: "20", projectKey: "SECRET", projectName: "Confidential", issueCount: 2, jql: null },
    ]);
    mocks.countSnapshotProjectUsage.mockResolvedValue(2);
    mocks.loadFieldSummary.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["10"]));

    const result = await getFieldDetails({ payload: { fieldId: "customfield_10001" }, context: ctxWithAccount() });

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].projectKey).toBe("ABC");
    expect(result.projects.some((p) => p.projectKey === "SECRET")).toBe(false);
  });

  test("filters the fallback activeProjects list (fieldSummary path) the same way", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotField.mockResolvedValue(snapshotField());
    mocks.loadSnapshotProjectUsage.mockResolvedValue([]);
    mocks.countSnapshotProjectUsage.mockResolvedValue(0);
    mocks.loadFieldSummary.mockResolvedValue({
      summaryStatus: "ready",
      activeProjectCount: 2,
      activeProjects: [
        { projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 5 },
        { projectId: "20", projectKey: "SECRET", projectName: "Confidential", issueCount: 2 },
      ],
    });
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField()]);
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["10"]));

    const result = await getFieldDetails({ payload: { fieldId: "customfield_10001" }, context: ctxWithAccount() });

    expect(result.projects.map((p) => p.projectKey)).toEqual(["ABC"]);
  });
});

// ---------------------------------------------------------------------------
// getFilteredFieldIds -- same filter pipeline as getFieldInventory, just
// returns bare IDs (used for "select all matching current filters").
// ---------------------------------------------------------------------------
describe("getFilteredFieldIds", () => {
  test("returns an empty list when no snapshot has completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    const result = await getFilteredFieldIds({ payload: {}, context: {} });
    expect(result).toEqual({ fieldIds: [] });
  });

  test("returns field IDs matching a text query", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadSnapshotFields.mockResolvedValue([
      snapshotField({ id: "customfield_1", name: "Story Points" }),
      snapshotField({ id: "customfield_2", name: "Sprint" }),
    ]);
    const result = await getFilteredFieldIds({ payload: { query: "story" }, context: {} });
    expect(result.fieldIds).toEqual(["customfield_1"]);
  });
});

// ---------------------------------------------------------------------------
// searchFieldOptions
// ---------------------------------------------------------------------------
describe("searchFieldOptions", () => {
  test("requires a non-empty fieldId", async () => {
    await expect(searchFieldOptions({ payload: {}, context: {} })).rejects.toThrow(/fieldId/);
  });

  test("returns an empty/done shape when optionQuery is blank", async () => {
    const result = await searchFieldOptions({ payload: { fieldId: "customfield_1", optionQuery: "" }, context: {} });
    expect(result).toEqual({ status: "empty", matches: [], nextIndex: 0, done: true, scanned: 0, totalCandidates: 0 });
    expect(mocks.searchFieldOptionsCache).not.toHaveBeenCalled();
  });

  test("returns matched field IDs for a non-blank query", async () => {
    mocks.searchFieldOptionsCache.mockResolvedValue([{ fieldId: "customfield_1" }, { fieldId: "customfield_2" }]);
    const result = await searchFieldOptions({
      payload: { fieldId: "customfield_1", optionQuery: "urgent" },
      context: {},
    });
    expect(result.status).toBe("ok");
    expect(result.matches).toEqual(["customfield_1", "customfield_2"]);
    expect(result.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getFieldOptions
// ---------------------------------------------------------------------------
describe("getFieldOptions", () => {
  test("returns an empty shape when fieldId is blank, without touching storage", async () => {
    const result = await getFieldOptions({ payload: {}, context: {} });
    expect(result).toEqual({ fieldId: "", optionsByContext: [] });
    expect(mocks.loadFieldOptionsCache).not.toHaveBeenCalled();
  });

  test("returns cached options without hitting Jira when the cache is populated", async () => {
    mocks.loadFieldOptionsCache.mockResolvedValue({
      optionsByContext: [{ contextId: "ctx-1", options: [{ id: "1", value: "Yes" }] }],
      refreshedAt: "2026-01-01T00:00:00Z",
    });
    const result = await getFieldOptions({ payload: { fieldId: "customfield_1" }, context: {} });
    expect(result.optionsByContext).toHaveLength(1);
    expect(mocks.loadFieldOptionsFromJira).not.toHaveBeenCalled();
  });

  test("falls back to a live Jira fetch and repopulates the cache when empty", async () => {
    mocks.loadFieldOptionsCache.mockResolvedValue({ optionsByContext: [], refreshedAt: null });
    mocks.loadFieldOptionsFromJira.mockResolvedValue([{ contextId: "ctx-1", options: [{ id: "1", value: "Yes" }] }]);
    mocks.replaceFieldOptionsCache.mockResolvedValue({ refreshedAt: "2026-02-01T00:00:00Z" });

    const result = await getFieldOptions({ payload: { fieldId: "customfield_1" }, context: {} });

    expect(mocks.loadFieldOptionsFromJira).toHaveBeenCalledWith("customfield_1");
    expect(mocks.replaceFieldOptionsCache).toHaveBeenCalled();
    expect(result.refreshedAt).toBe("2026-02-01T00:00:00Z");
  });

  test("enriches options with per-project issue counts when projectKeys are given", async () => {
    mocks.loadFieldOptionsCache.mockResolvedValue({
      optionsByContext: [{ contextId: "ctx-1", options: [{ id: "1", value: "Yes" }] }],
      refreshedAt: "2026-01-01T00:00:00Z",
    });
    mocks.jiraRequest.mockResolvedValue({ total: 7 });

    const result = await getFieldOptions({ payload: { fieldId: "customfield_1", projectKeys: ["ABC"] }, context: {} });

    expect(mocks.jiraRequest).toHaveBeenCalled();
    expect(result.optionsByContext[0].options[0].issueCount).toBe(7);
  });
});

describe("buildFieldConfigInventory", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

  test("queues a build when nothing is running", async () => {
    mocks.readFieldConfigSnapshotMeta.mockResolvedValueOnce({ state: "ready" });
    expect(await buildFieldConfigInventory(ctx)).toEqual({ queued: true });
    expect(mocks.queueFieldConfigSnapshotBuild).toHaveBeenCalledWith("test-install");
  });

  test("refuses while a live build is running, but not a wedged one", async () => {
    mocks.readFieldConfigSnapshotMeta.mockResolvedValueOnce({ state: "building" });
    expect(await buildFieldConfigInventory(ctx)).toMatchObject({ queued: false, reason: "already-building" });

    mocks.readFieldConfigSnapshotMeta.mockResolvedValueOnce({ state: "building" });
    mocks.isFieldConfigBuildStale.mockReturnValueOnce(true);
    expect(await buildFieldConfigInventory(ctx)).toEqual({ queued: true });
  });

  test("refuses in read-only mode", async () => {
    mocks.readFieldConfigSnapshotMeta.mockResolvedValueOnce(null);
    mocks.kvsGet.mockResolvedValueOnce({ readOnlyMode: true });
    expect(await buildFieldConfigInventory(ctx)).toMatchObject({
      queued: false,
      error: expect.stringMatching(/Read-only/),
    });
    expect(mocks.queueFieldConfigSnapshotBuild).not.toHaveBeenCalled();
  });
});
