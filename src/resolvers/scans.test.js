import { describe, test, expect, beforeEach } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, ctxWithAccount } from "./test-harness.js";
import {
  SHARED_RESOLVER_FUNCTIONS,
  ADMIN_ONLY_FUNCTIONS,
  recordQuickScanScheduledRun,
  runDeltaIssueScanJob,
  CLEAR_SNAPSHOT_CONFIRMATION,
  isScanStuck,
  __RAW_ADMIN_ONLY_FUNCTIONS,
} from "../resolvers.js";

const { startFullSiteScan, getFullScanStatus, startQuickSiteScan, getQuickScanStatus, resumeSiteScan, cancelSiteScan } =
  __RAW_ADMIN_ONLY_FUNCTIONS;
const {
  startIssueScan,
  resumeIssueScan,
  cancelIssueScan,
  getIssueScanStatus,
  startDeltaIssueScan,
  getDeltaIssueScanStatus,
  cancelSnapshot,
  clearSnapshot,
} = { ...SHARED_RESOLVER_FUNCTIONS, ...__RAW_ADMIN_ONLY_FUNCTIONS };

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// Issue scan lifecycle -- the most complex stateful subsystem in the app.
// RUNBOOK.md's entire "Section 1: Universe Scan Recovery" is a spec for this
// code's failure modes (stuck scan, resume, force resume, cancel) -- tests
// below are written directly against that spec.
// ---------------------------------------------------------------------------
describe("startIssueScan", () => {
  test("refuses to start a second scan while one is already building", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "building" });
    const result = await startIssueScan({ context: {} });
    expect(result).toEqual({ started: false, reason: "already-running", meta: { state: "building" } });
    expect(mocks.queuePush).not.toHaveBeenCalled();
  });

  test("refuses to start a second scan while one is queued", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "queued" });
    const result = await startIssueScan({ context: {} });
    expect(result.started).toBe(false);
  });

  test("queues a new scan with a fresh job token when idle", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "idle" });
    const result = await startIssueScan({ context: {} });
    expect(result).toEqual({ started: true, jobToken: "job-token-1" });
    expect(mocks.writeIssueScanMeta).toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({ state: "queued", jobToken: "job-token-1" }),
    );
    expect(mocks.queuePush).toHaveBeenCalledWith({
      body: { jobType: "run-issue-scan", installationKey: "test-install" },
    });
  });

  test("marks the scan failed and re-throws if the queue push itself fails", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "idle" });
    mocks.queuePush.mockRejectedValue(new Error("queue backpressure"));

    await expect(startIssueScan({ context: {} })).rejects.toThrow("queue backpressure");

    expect(mocks.writeIssueScanMeta).toHaveBeenLastCalledWith(
      "test-install",
      expect.objectContaining({ state: "failed" }),
    );
  });
});

describe("resumeIssueScan", () => {
  test("reports no-scan when nothing has ever run", async () => {
    mocks.readIssueScanMeta.mockResolvedValue(null);
    const result = await resumeIssueScan({ context: {} });
    expect(result).toEqual({ resumed: false, reason: "no-scan" });
  });

  test("reports already-complete for a ready scan rather than re-running it", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "ready" });
    const result = await resumeIssueScan({ context: {} });
    expect(result.resumed).toBe(false);
    expect(result.reason).toBe("already-complete");
  });

  test("re-queues only workers that are not done, and resets failed ones to queued first", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "failed", jobToken: "old-token", progressLog: [] });
    mocks.writeIssueScanMeta.mockResolvedValue({ state: "building" });
    mocks.readIssueScanWorker.mockImplementation((_key, workerId) => {
      if (workerId === 0) return Promise.resolve({ status: "done" });
      if (workerId === 1) return Promise.resolve({ status: "failed" });
      return Promise.resolve({ status: "queued" });
    });

    const result = await resumeIssueScan({ context: {} });

    expect(result.resumed).toBe(true);
    // worker 0 (done) must NOT be re-queued
    expect(mocks.queueIssueScanWorker).not.toHaveBeenCalledWith("test-install", 0);
    // worker 1 (failed) must be reset to queued, then re-queued
    expect(mocks.updateIssueScanWorker).toHaveBeenCalledWith("test-install", 1, { status: "queued", lastError: null });
    expect(mocks.queueIssueScanWorker).toHaveBeenCalledWith("test-install", 1);
    // every other non-done worker gets re-queued too
    expect(mocks.queueIssueScanWorker).toHaveBeenCalledWith("test-install", 2);
  });

  test("marks the scan failed and throws when a worker re-queue fails", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "building", progressLog: [] });
    mocks.writeIssueScanMeta.mockResolvedValue({ state: "building" });
    mocks.readIssueScanWorker.mockResolvedValue({ status: "queued" });
    mocks.queueIssueScanWorker.mockRejectedValue(new Error("queue full"));

    await expect(resumeIssueScan({ context: {} })).rejects.toThrow(/Resume partially failed/);

    expect(mocks.writeIssueScanMeta).toHaveBeenLastCalledWith(
      "test-install",
      expect.objectContaining({ state: "failed" }),
    );
  });

  // Regression test: a worker can finish (marking itself "done") right after a cancel
  // sets state to "cancelled", so its own finalization claim is rejected (it requires
  // state === "building"). Resume would previously just re-set state to "building" and
  // then skip every worker in the requeue loop because they're all already "done" --
  // leaving the scan stuck at 100%/state=building forever with no further attempt to
  // finalize. It must finalize directly in that case instead of silently no-op'ing.
  test("finalizes directly when every worker already reports done but the scan was never finalized", async () => {
    mocks.readIssueScanMeta
      .mockResolvedValueOnce({ state: "cancelled", jobToken: "old-token", progressLog: [] })
      .mockResolvedValue({ state: "ready", processedIssues: 322835 });
    mocks.writeIssueScanMeta.mockResolvedValue({ state: "building", processedPages: 5, totalPages: 5 });
    mocks.readIssueScanWorker.mockResolvedValue({ status: "done" });
    mocks.tryClaimIssueScanFinalization.mockResolvedValue(true);

    const result = await resumeIssueScan({ context: {} });

    expect(mocks.queueIssueScanWorker).not.toHaveBeenCalled();
    expect(mocks.tryClaimIssueScanFinalization).toHaveBeenCalledWith("test-install", "old-token");
    expect(mocks.completeIssueScanFinalization).toHaveBeenCalledWith("test-install", "resumeIssueScan");
    expect(result.resumed).toBe(true);
    expect(result.finalizedDirectly).toBe(true);
    expect(result.meta.state).toBe("ready");
  });

  test("does not finalize when the finalization claim loses a race to a concurrent finalizer", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "cancelled", jobToken: "old-token", progressLog: [] });
    mocks.writeIssueScanMeta.mockResolvedValue({ state: "building", processedPages: 5, totalPages: 5 });
    mocks.readIssueScanWorker.mockResolvedValue({ status: "done" });
    mocks.tryClaimIssueScanFinalization.mockResolvedValue(false);

    const result = await resumeIssueScan({ context: {} });

    expect(mocks.completeIssueScanFinalization).not.toHaveBeenCalled();
    expect(result.resumed).toBe(true);
    expect(result.finalizedDirectly).toBeUndefined();
  });

  test("does not attempt finalization when workers are done but pages are incomplete", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "cancelled", jobToken: "old-token", progressLog: [] });
    mocks.writeIssueScanMeta.mockResolvedValue({ state: "building", processedPages: 3, totalPages: 5 });
    mocks.readIssueScanWorker.mockResolvedValue({ status: "done" });

    const result = await resumeIssueScan({ context: {} });

    expect(mocks.tryClaimIssueScanFinalization).not.toHaveBeenCalled();
    expect(result.resumed).toBe(true);
  });
});

describe("cancelIssueScan", () => {
  test("reports not-running when there's no active scan", async () => {
    mocks.readIssueScanMeta.mockResolvedValue(null);
    const result = await cancelIssueScan({ context: {} });
    expect(result).toEqual({ cancelled: false, reason: "not-running" });
  });

  test("reports not-running for an already-idle or already-ready scan", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "ready" });
    const result = await cancelIssueScan({ context: {} });
    expect(result.cancelled).toBe(false);
  });

  test("cancels an in-progress scan", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "building", progressLog: [] });
    const result = await cancelIssueScan({ context: {} });
    expect(result).toEqual({ cancelled: true });
    expect(mocks.writeIssueScanMeta).toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({ state: "cancelled" }),
    );
  });
});

describe("getIssueScanStatus", () => {
  test("returns null meta when no scan has ever run", async () => {
    mocks.readIssueScanMeta.mockResolvedValue(null);
    const result = await getIssueScanStatus({ context: {} });
    expect(result).toEqual({ meta: null });
  });

  test("surfaces the internal 'finalizing' transition state as 'building' to the UI", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "finalizing", processedPages: 10 });
    const result = await getIssueScanStatus({ context: {} });
    expect(result.meta.state).toBe("building");
  });

  test("passes through any other state as-is", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "ready" });
    const result = await getIssueScanStatus({ context: {} });
    expect(result.meta.state).toBe("ready");
  });
});

describe("startDeltaIssueScan", () => {
  test("refuses to start while a delta scan is already building or queued", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "building" });
    const result = await startDeltaIssueScan({ context: {} });
    expect(result).toEqual({ started: false, reason: "already-running" });
  });

  test("queues a new delta scan under a distinct ::delta scope key", async () => {
    mocks.readIssueScanMeta.mockResolvedValue(null);
    const result = await startDeltaIssueScan({ context: {} });
    expect(result).toEqual({ started: true });
    expect(mocks.writeIssueScanMeta).toHaveBeenCalledWith(
      "test-install::delta",
      expect.objectContaining({ state: "queued" }),
    );
    expect(mocks.queuePush).toHaveBeenCalledWith({
      body: { jobType: "run-delta-issue-scan", installationKey: "test-install" },
    });
  });
});

describe("getDeltaIssueScanStatus", () => {
  test("reads from the ::delta scope key, distinct from the full scan", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "ready" });
    const result = await getDeltaIssueScanStatus({ context: {} });
    expect(mocks.readIssueScanMeta).toHaveBeenCalledWith("test-install::delta");
    expect(result.meta.state).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// runDeltaIssueScanJob -- the queue-consumer entry point, not resolver-
// registered directly. Never throws (always catches and writes a failed
// state); covering the guard clause, a single-page happy path with RQT +
// project-usage aggregation, pagination continuation, and the top-level
// catch-all.
// ---------------------------------------------------------------------------
describe("runDeltaIssueScanJob", () => {
  function jiraSearchResponse(issues, nextPageToken = null) {
    return { issues, nextPageToken, total: issues.length };
  }

  test("skips silently when a delta scan is already building and recently started", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({ state: "building", startedAt: new Date().toISOString() });
    await runDeltaIssueScanJob("test-install");
    expect(mocks.jiraRequest).not.toHaveBeenCalled();
    expect(mocks.writeIssueScanMeta).not.toHaveBeenCalled();
  });

  test("proceeds if the existing 'building' state is stale (started over 10 minutes ago)", async () => {
    mocks.readIssueScanMeta.mockResolvedValue({
      state: "building",
      startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    });
    mocks.jiraRequest.mockResolvedValue(jiraSearchResponse([]));
    mocks.readSnapshotMeta.mockResolvedValue(null);

    await runDeltaIssueScanJob("test-install");

    expect(mocks.jiraRequest).toHaveBeenCalled();
  });

  test("scans a single page, aggregates field/project usage, and writes a ready state", async () => {
    mocks.readIssueScanMeta.mockResolvedValue(null);
    mocks.jiraRequest
      .mockResolvedValueOnce({ total: 1 }) // initial count call
      .mockResolvedValueOnce(
        jiraSearchResponse(
          [
            {
              key: "ABC-1",
              fields: {
                project: { id: "10", key: "ABC", name: "Alpha" },
                summary: "Test issue",
                customfield_10001: "Some value",
              },
            },
          ],
          null,
        ),
      );
    mocks.readSnapshotMeta.mockResolvedValue(null); // no snapshot -> skip field-usage update

    await runDeltaIssueScanJob("test-install");

    expect(mocks.upsertProjectTotalsForDelta).toHaveBeenCalled();
    const finalCall = mocks.writeIssueScanMeta.mock.calls.at(-1);
    expect(finalCall[0]).toBe("test-install::delta");
    expect(finalCall[1]).toEqual(expect.objectContaining({ state: "ready", processedIssues: 1 }));
  });

  test("continues across multiple pages until nextPageToken is exhausted", async () => {
    mocks.readIssueScanMeta.mockResolvedValue(null);
    mocks.jiraRequest
      .mockResolvedValueOnce({ total: 2 })
      .mockResolvedValueOnce(
        jiraSearchResponse(
          [{ key: "ABC-1", fields: { project: { id: "10", key: "ABC", name: "Alpha" } } }],
          "page-2-token",
        ),
      )
      .mockResolvedValueOnce(
        jiraSearchResponse([{ key: "ABC-2", fields: { project: { id: "10", key: "ABC", name: "Alpha" } } }], null),
      );
    mocks.readSnapshotMeta.mockResolvedValue(null);

    await runDeltaIssueScanJob("test-install");

    const finalCall = mocks.writeIssueScanMeta.mock.calls.at(-1);
    expect(finalCall[1]).toEqual(expect.objectContaining({ state: "ready", processedPages: 2, processedIssues: 2 }));
  });

  test("skips field-usage update (but still finishes) when no snapshot exists yet", async () => {
    mocks.readIssueScanMeta.mockResolvedValue(null);
    mocks.jiraRequest.mockResolvedValueOnce({ total: 0 }).mockResolvedValueOnce(jiraSearchResponse([], null));
    mocks.readSnapshotMeta.mockResolvedValue(null);

    await runDeltaIssueScanJob("test-install");

    expect(mocks.upsertDeltaFieldProjectUsage).not.toHaveBeenCalled();
    const finalCall = mocks.writeIssueScanMeta.mock.calls.at(-1);
    expect(finalCall[1].state).toBe("ready");
  });

  test("never throws -- writes a failed state and swallows the error instead", async () => {
    mocks.readIssueScanMeta.mockResolvedValue(null);
    mocks.jiraRequest.mockRejectedValue(new Error("Jira is down"));
    // ensureProjectStoreReady throwing is the simplest way to force the top-level catch
    mocks.ensureProjectStoreReady.mockRejectedValueOnce(new Error("SQL unavailable"));

    await expect(runDeltaIssueScanJob("test-install")).resolves.toBeUndefined();

    expect(mocks.writeIssueScanMeta).toHaveBeenCalledWith(
      "test-install::delta",
      expect.objectContaining({ state: "failed" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Snapshot & project-usage job lifecycle -- RUNBOOK.md's "Section 2: Snapshot
// Build Recovery" and "Section 3: Database Health" / field summary job
// recovery are the spec for this group.
// ---------------------------------------------------------------------------
describe("cancelSnapshot", () => {
  test("nulls buildingVersion so any in-flight build's own version-check fails", async () => {
    const result = await cancelSnapshot({ context: {} });
    expect(result).toEqual({ cancelled: true });
    expect(mocks.writeSnapshotMeta).toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({ state: "cancelled", buildingVersion: null }),
    );
  });
});

// ---------------------------------------------------------------------------
// clearSnapshot
//
// The only irreversible operation in the app. These tests exist mainly to pin
// the things that make it *safe*: the confirmation is enforced server-side and
// not just in the UI, read-only mode blocks it, and the running build is
// cancelled before any DELETE runs -- an in-flight build would otherwise keep
// writing rows into the tables behind the delete.
// ---------------------------------------------------------------------------
describe("clearSnapshot", () => {
  beforeEach(() => {
    mocks.clearAllSnapshotData.mockResolvedValue({
      deleted: { snapshot_fields: 120, snapshot_project_usage: 4300 },
      totalRowsDeleted: 4420,
    });
  });

  test("refuses when the confirmation text is missing", async () => {
    const result = await clearSnapshot({ payload: {}, context: {} });

    expect(result.cleared).toBe(false);
    expect(result.error).toContain(CLEAR_SNAPSHOT_CONFIRMATION);
    expect(mocks.clearAllSnapshotData).not.toHaveBeenCalled();
  });

  test("refuses when the confirmation text does not match", async () => {
    const result = await clearSnapshot({ payload: { confirmation: "delete" }, context: {} });

    expect(result.cleared).toBe(false);
    expect(mocks.clearAllSnapshotData).not.toHaveBeenCalled();
  });

  test("accepts the confirmation with surrounding whitespace", async () => {
    const result = await clearSnapshot({
      payload: { confirmation: `  ${CLEAR_SNAPSHOT_CONFIRMATION}  ` },
      context: {},
    });

    expect(result.cleared).toBe(true);
    expect(mocks.clearAllSnapshotData).toHaveBeenCalledWith("test-install");
  });

  test("refuses while read-only mode is enabled", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true });

    const result = await clearSnapshot({
      payload: { confirmation: CLEAR_SNAPSHOT_CONFIRMATION },
      context: {},
    });

    expect(result.cleared).toBe(false);
    expect(result.error).toMatch(/read-only/i);
    expect(mocks.clearAllSnapshotData).not.toHaveBeenCalled();
  });

  test("cancels the in-flight build before deleting anything", async () => {
    const order = [];
    mocks.writeSnapshotMeta.mockImplementation(async () => {
      order.push("cancel");
    });
    mocks.clearAllSnapshotData.mockImplementation(async () => {
      order.push("delete");
      return { deleted: {}, totalRowsDeleted: 0 };
    });

    await clearSnapshot({ payload: { confirmation: CLEAR_SNAPSHOT_CONFIRMATION }, context: {} });

    expect(order).toEqual(["cancel", "delete"]);
    expect(mocks.writeSnapshotMeta).toHaveBeenCalledWith("test-install", {
      state: "cancelled",
      buildingVersion: null,
      lastError: null,
    });
  });

  test("returns the per-table row counts so the UI can report what was destroyed", async () => {
    const result = await clearSnapshot({
      payload: { confirmation: CLEAR_SNAPSHOT_CONFIRMATION },
      context: {},
    });

    expect(result).toEqual({
      cleared: true,
      deleted: { snapshot_fields: 120, snapshot_project_usage: 4300 },
      totalRowsDeleted: 4420,
    });
  });

  test("is registered admin-only and never on the shared macro resolver", () => {
    expect(ADMIN_ONLY_FUNCTIONS.clearSnapshot).toBeDefined();
    expect(SHARED_RESOLVER_FUNCTIONS.clearSnapshot).toBeUndefined();
  });
});

// A scan wedged in "building" is worse than one that failed: the state is a lie, and the
// admin UI polls a "running" job every 15 seconds for as long as a tab is open.
describe("isScanStuck", () => {
  const MIN = 60 * 1000;
  const at = (msAgo) => new Date(Date.now() - msAgo).toISOString();

  test("leaves a scan alone while it is still logging progress", () => {
    expect(isScanStuck({ state: "building", progressLog: [{ t: at(2 * MIN) }] })).toBe(false);
  });

  test("flags a building scan that has gone quiet past the ceiling", () => {
    expect(isScanStuck({ state: "building", progressLog: [{ t: at(45 * MIN) }] })).toBe(true);
  });

  // A long scan legitimately runs for hours; silence is the signal, not elapsed time.
  test("measures silence from the newest entry, not the oldest", () => {
    const meta = { state: "building", progressLog: [{ t: at(300 * MIN) }, { t: at(1 * MIN) }] };
    expect(isScanStuck(meta)).toBe(false);
  });

  test("covers finalizing, which is also a state a scan can wedge in", () => {
    expect(isScanStuck({ state: "finalizing", progressLog: [{ t: at(45 * MIN) }] })).toBe(true);
  });

  test.each([["ready"], ["failed"], ["cancelled"], ["idle"]])("never touches a scan already in %s", (state) => {
    expect(isScanStuck({ state, progressLog: [{ t: at(600 * MIN) }] })).toBe(false);
  });

  test("falls back to startedAt when the log is empty", () => {
    expect(isScanStuck({ state: "building", progressLog: [], startedAt: at(45 * MIN) })).toBe(true);
    expect(isScanStuck({ state: "building", progressLog: [], startedAt: at(2 * MIN) })).toBe(false);
  });

  // Failing a scan on a guess would be worse than leaving it: resume discards no work,
  // but a wrongly-failed scan reads as a defect the admin has to investigate.
  test("leaves a scan alone when there is no usable timestamp at all", () => {
    expect(isScanStuck({ state: "building", progressLog: [] })).toBe(false);
    expect(isScanStuck({ state: "building", progressLog: [{ t: "not-a-date" }] })).toBe(false);
  });

  test("handles absent meta", () => {
    expect(isScanStuck(null)).toBe(false);
    expect(isScanStuck(undefined)).toBe(false);
  });
});

describe("startFullSiteScan / getFullScanStatus", () => {
  beforeEach(() => {
    mocks.kvsGet.mockResolvedValue(null);
    mocks.readFullScanMeta.mockResolvedValue(null);
  });

  test("refuses in read-only mode, and says so", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true });

    const result = await startFullSiteScan({ context: ctxWithAccount() });

    expect(result.started).toBe(false);
    expect(result.error).toMatch(/Read-only/);
  });

  test("returns the stage catalog even when no scan has ever run", async () => {
    const result = await getFullScanStatus({ context: ctxWithAccount() });

    // Renders as a list of what a scan covers rather than an empty panel -- the same reason
    // the other tabs describe what they would show before they have anything to show.
    expect(result.state).toBe("idle");
    expect(result.stages).toBeNull();
    expect(result.catalog.map((s) => s.key)).toEqual(
      expect.arrayContaining(["workflows", "filters", "dashboards", "issues"]),
    );
    expect(result.catalog.map((s) => s.key)).not.toContain("automation");
  });

  test("reports per-stage progress for a run in flight", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running",
      currentStage: "issues",
      stages: [
        { key: "workflows", state: "done" },
        { key: "issues", state: "running" },
      ],
      startedAt: "2026-08-26T00:00:00.000Z",
    });

    const result = await getFullScanStatus({ context: ctxWithAccount() });

    expect(result).toMatchObject({ state: "running", currentStage: "issues" });
    expect(result.stages).toHaveLength(2);
  });

  // A cancelled scan, or one that finished before run history existed, has no full_scan_runs
  // row -- so the produced counts have to come from the pillar metas on every read, or the
  // page shows "Produced —" for every stage.
  test("attaches what each pillar currently holds even for an idle scan", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "cancelled",
      scanType: "full",
      stages: [{ key: "workflows", state: "done" }],
    });
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1", totalSchemes: 14 });
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "flt1", totalFilters: 4115 });

    const result = await getFullScanStatus({ context: ctxWithAccount() });

    expect(result.liveStageCounts).toMatchObject({ workflows: 14, filters: 4115 });
  });

  test("reaches into the filter sub-build for a real count while the filters stage is in flight", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running",
      currentStage: "filters",
      stages: [{ key: "filters", state: "running" }],
    });
    mocks.readFilterSnapshotMeta.mockResolvedValue({ processed: 1200, totalExpected: 4115, lastError: null });

    const result = await getFullScanStatus({ context: ctxWithAccount() });

    // The orchestrator only knows "running"; the sub-build's own meta row is where the
    // count lives, so the stage row can show 1,200 / 4,115 instead of an endless sweep.
    expect(result.currentStageProgress).toMatchObject({ processed: 1200, total: 4115 });
  });

  test("leaves currentStageProgress null when the active stage keeps no sub-build count", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running",
      currentStage: "workflows",
      stages: [{ key: "workflows", state: "running" }],
    });
    const result = await getFullScanStatus({ context: ctxWithAccount() });
    expect(result.currentStageProgress).toBeNull();
  });

  test("names the dashboard build's current phase, so its count is not a mystery", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running",
      currentStage: "dashboards",
      stages: [{ key: "dashboards", state: "running" }],
    });
    mocks.readDashboardSnapshotMeta.mockResolvedValue({
      processed: 3836,
      totalExpected: 5226,
      lastError: null,
      buildCursor: JSON.stringify({ phase: "configs", walked: 10, listTotal: 613, gadgetTotal: 4000 }),
    });

    const result = await getFullScanStatus({ context: ctxWithAccount() });

    expect(result.currentStageProgress).toMatchObject({
      processed: 3836,
      total: 5226,
      note: "resolving what each gadget points at",
    });
  });

  test("survives a meta read failure rather than taking the tab down", async () => {
    mocks.readFullScanMeta.mockRejectedValueOnce(new Error("sql down"));

    const result = await getFullScanStatus({ context: ctxWithAccount() });

    // The Scans tab has several panels; one unreadable row must not blank the others.
    expect(result.state).toBe("idle");
    expect(result.catalog.length).toBeGreaterThan(0);
  });

  // Both scan types share one meta row. A quick scan running under it must not make the full
  // scan panel look like an idle scan with no explanation for why its button is disabled.
  test("says a quick scan is blocking it, rather than reporting plain idle", async () => {
    mocks.readFullScanMeta.mockResolvedValue({ state: "running", scanType: "quick" });

    const result = await getFullScanStatus({ context: ctxWithAccount() });

    expect(result.state).toBe("idle");
    expect(result.blockedByOtherScan).toBe(true);
  });

  test("a row with no scanType at all is treated as the full scan's own, for rows written before the split", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running",
      currentStage: "workflows",
      stages: [{ key: "workflows", state: "running" }],
    });

    const result = await getFullScanStatus({ context: ctxWithAccount() });

    expect(result.state).toBe("running");
    expect(result.blockedByOtherScan).toBe(false);
  });

  // The hourly scheduled trigger is the backstop for a wedged orchestrator; the status read,
  // polled every few seconds while an admin watches, is what heals it promptly.
  test("kicks stall recovery when a running scan's heartbeat has gone quiet past the window", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running",
      scanType: "full",
      currentStage: "dashboards",
      stages: [{ key: "dashboards", state: "running" }],
      updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });

    await getFullScanStatus({ context: ctxWithAccount() });

    expect(mocks.recoverStalledScan).toHaveBeenCalledWith("test-install");
  });

  test("does not touch recovery for a scan whose heartbeat is fresh", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running",
      scanType: "full",
      currentStage: "dashboards",
      stages: [{ key: "dashboards", state: "running" }],
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    });

    await getFullScanStatus({ context: ctxWithAccount() });

    expect(mocks.recoverStalledScan).not.toHaveBeenCalled();
  });

  test("kicks recovery for a scan past its total-duration ceiling even with a fresh heartbeat", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running",
      scanType: "full",
      currentStage: "issues",
      stages: [{ key: "issues", state: "running" }],
      updatedAt: new Date().toISOString(), // ticking right now
      startedAt: new Date(Date.now() - 90 * 60 * 60 * 1000).toISOString(), // 90 hours ago
    });

    await getFullScanStatus({ context: ctxWithAccount() });

    expect(mocks.recoverStalledScan).toHaveBeenCalledWith("test-install");
  });

  test("a recovery kick that rejects never breaks the status response", async () => {
    mocks.recoverStalledScan.mockRejectedValueOnce(new Error("queue push failed"));
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running",
      scanType: "full",
      currentStage: "dashboards",
      stages: [{ key: "dashboards", state: "running" }],
      updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });

    const result = await getFullScanStatus({ context: ctxWithAccount() });

    expect(result.state).toBe("running");
  });
});

// The quick scan's own manual trigger and status read, mirroring the full-scan pair above --
// same shared row, same mutual exclusion, opposite direction for blockedByOtherScan.
describe("startQuickSiteScan / getQuickScanStatus", () => {
  beforeEach(() => {
    mocks.kvsGet.mockResolvedValue(null);
    mocks.readFullScanMeta.mockResolvedValue(null);
  });

  test("refuses in read-only mode, and says so", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true });

    const result = await startQuickSiteScan({ payload: {}, context: ctxWithAccount() });

    expect(result.started).toBe(false);
    expect(result.error).toMatch(/Read-only/);
  });

  test("defaults the window to the stored schedule's, when none is given explicitly", async () => {
    mocks.kvsGet.mockResolvedValue({ quickScanSchedule: { windowHours: 336 } });

    await startQuickSiteScan({ payload: {}, context: ctxWithAccount() });

    // "Run now" between scheduled runs should ask the same question the schedule would have,
    // not an arbitrary different one.
    expect(mocks.writeFullScanMeta).toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({ quickScanWindowHours: 336 }),
    );
  });

  test("an explicit window in the payload overrides the stored schedule", async () => {
    mocks.kvsGet.mockResolvedValue({ quickScanSchedule: { windowHours: 336 } });

    await startQuickSiteScan({ payload: { windowHours: 12 }, context: ctxWithAccount() });

    expect(mocks.writeFullScanMeta).toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({ quickScanWindowHours: 12 }),
    );
  });

  test("returns the quick-scan catalog even when nothing has run", async () => {
    const result = await getQuickScanStatus({ context: ctxWithAccount() });

    expect(result.state).toBe("idle");
    expect(result.catalog.map((s) => s.key)).toEqual(expect.arrayContaining(["workflows", "filters", "issues-delta"]));
    expect(result.catalog.map((s) => s.key)).not.toContain("fields");
  });

  test("reports its own progress, and says which window it was run with", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running",
      scanType: "quick",
      currentStage: "issues-delta",
      quickScanWindowHours: 168,
      stages: [{ key: "workflows", state: "done" }],
    });

    const result = await getQuickScanStatus({ context: ctxWithAccount() });

    expect(result).toMatchObject({ state: "running", currentStage: "issues-delta", windowHours: 168 });
  });

  // The reverse of the full-scan panel's own check: a running FULL scan must not make the
  // quick-scan panel render as idle with an unexplained disabled button.
  test("says a full scan is blocking it, rather than reporting plain idle", async () => {
    mocks.readFullScanMeta.mockResolvedValue({ state: "running", scanType: "full" });

    const result = await getQuickScanStatus({ context: ctxWithAccount() });

    expect(result.state).toBe("idle");
    expect(result.blockedByOtherScan).toBe(true);
  });

  test("never shows the full scan's own stages on the quick-scan panel", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running",
      scanType: "full",
      currentStage: "issues",
      stages: [
        { key: "workflows", state: "done" },
        { key: "issues", state: "running" },
      ],
    });

    const result = await getQuickScanStatus({ context: ctxWithAccount() });

    expect(result.stages).toBeNull();
    expect(result.currentStage).toBeNull();
  });
});

// The wedge these exist for: a scan orchestrator whose loop stopped stepping sits at
// "running" forever, and startScan refuses every new run over it. The engine logic lives in
// full-scan-runner.test.js; here we only check the resolvers reach it and stay outside the
// read-only gate that a real scan sits behind.
describe("resumeSiteScan / cancelSiteScan", () => {
  beforeEach(() => {
    mocks.readFullScanMeta.mockResolvedValue(null);
  });

  test("cancelSiteScan writes the terminal state that frees the shared row", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running",
      scanType: "full",
      jobToken: "tok",
      stages: [
        { key: "workflows", state: "done" },
        { key: "filters", state: "running" },
      ],
    });

    const result = await cancelSiteScan({ context: ctxWithAccount() });

    expect(result).toMatchObject({ cancelled: true, scanType: "full" });
    expect(mocks.writeFullScanMeta).toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({ state: "cancelled", jobToken: null }),
    );
  });

  test("cancelSiteScan is a no-op when nothing is running", async () => {
    expect(await cancelSiteScan({ context: ctxWithAccount() })).toMatchObject({
      cancelled: false,
      reason: "not-running",
    });
  });

  test("cancelSiteScan still works while read-only mode is on -- clearing a wedge is not a new scan", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true });
    mocks.readFullScanMeta.mockResolvedValue({ state: "running", scanType: "full", jobToken: "tok", stages: [] });

    expect(await cancelSiteScan({ context: ctxWithAccount() })).toMatchObject({ cancelled: true });
  });

  test("resumeSiteScan force-recovers a stalled run without waiting on the staleness clock", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "running",
      scanType: "full",
      jobToken: "tok",
      currentStage: "filters",
      stages: [{ key: "filters", state: "running" }],
      updatedAt: new Date().toISOString(), // fresh -- force must override
      recoveryCount: 0,
    });
    mocks.recoverStalledScan.mockResolvedValueOnce({ recovered: true, stage: "filters", recoveryCount: 1 });

    const result = await resumeSiteScan({ context: ctxWithAccount() });

    expect(mocks.recoverStalledScan).toHaveBeenCalledWith("test-install", { force: true });
    expect(result).toMatchObject({ recovered: true, stage: "filters" });
  });

  test("resumeSiteScan routes a completed-with-failures run to the resume path, not recovery", async () => {
    mocks.readFullScanMeta.mockResolvedValue({
      state: "completed-with-failures",
      scanType: "full",
      stages: [
        { key: "dashboards", state: "failed" },
        { key: "workflows", state: "done" },
      ],
    });

    const result = await resumeSiteScan({ context: ctxWithAccount() });

    expect(mocks.resumeScanRun).toHaveBeenCalledWith("test-install");
    expect(mocks.recoverStalledScan).not.toHaveBeenCalled();
    expect(result).toMatchObject({ resumed: true });
  });

  test("both are registered as guarded admin-only functions", () => {
    for (const name of ["resumeSiteScan", "cancelSiteScan"]) {
      expect(Object.keys(ADMIN_ONLY_FUNCTIONS)).toContain(name);
    }
  });
});

describe("recordQuickScanScheduledRun", () => {
  test("writes only the schedule's lastScheduledRunAt, leaving the rest of the config untouched", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true, quickScanSchedule: { enabled: true, windowHours: 168 } });

    await recordQuickScanScheduledRun("2026-08-27T00:00:00.000Z");

    expect(mocks.kvsSet).toHaveBeenCalledWith(
      "atlasiq-admin-config",
      expect.objectContaining({
        readOnlyMode: true,
        quickScanSchedule: expect.objectContaining({
          enabled: true,
          windowHours: 168,
          lastScheduledRunAt: "2026-08-27T00:00:00.000Z",
        }),
      }),
    );
  });
});
