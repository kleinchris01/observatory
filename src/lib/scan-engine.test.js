import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isJiraRateLimitError,
  isExpiredPageTokenError,
  queueIssueScanChunk,
  runIssueScanCoordinator,
  completeIssueScanFinalization,
  runIssueScanWorkerV2,
} from "./scan-engine.js";

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("./queues.js", () => ({
  inventorySnapshotQueue: { push: vi.fn().mockResolvedValue({ queued: true }) },
}));

vi.mock("./jira-api.js", () => ({
  jiraRequest: vi.fn().mockResolvedValue({}),
  sleep: vi.fn().mockResolvedValue(undefined),
  incrMetric: vi.fn(),
  METRIC_NAMES: {},
  makeJobToken: vi.fn().mockReturnValue("test-token"),
  getAllJiraProjectKeys: vi.fn().mockResolvedValue([]),
  loadFieldOptionsFromJira: vi.fn().mockResolvedValue([]),
  getScanTelemetry: vi.fn().mockReturnValue({ rl429Count: 0, rlRetryCount: 0 }),
  resetScanTelemetry: vi.fn(),
  mapWithConcurrency: vi.fn().mockImplementation(async (items, _concurrency, fn) => {
    const results = [];
    for (let i = 0; i < items.length; i++) results.push(await fn(items[i], i));
    return results;
  }),
  withTimeout: vi.fn().mockImplementation((promise) => promise),
  ISSUE_SCAN_PAGE_SIZE: 100,
  ISSUE_SCAN_WORKERS: 4,
  ISSUE_SCAN_INTER_PAGE_DELAY_MS: 100,
  ISSUE_SCAN_FLUSH_EVERY_PAGES: 5,
  // Must be present: the worker loop does `page % ISSUE_SCAN_CANCEL_CHECK_EVERY_PAGES`,
  // and an undefined constant yields NaN, which is never === 0 -- the cancellation path
  // would silently never run under test while looking perfectly healthy.
  ISSUE_SCAN_CANCEL_CHECK_EVERY_PAGES: 5,
}));

vi.mock("./project-store.js", () => ({
  ensureProjectStoreReady: vi.fn().mockResolvedValue(undefined),
  readSnapshotMeta: vi.fn().mockResolvedValue(null),
  writeSnapshotMeta: vi.fn().mockResolvedValue(undefined),
  clearSnapshotVersion: vi.fn().mockResolvedValue(undefined),
  writeIssueScanMeta: vi.fn().mockResolvedValue(undefined),
  readIssueScanMeta: vi.fn().mockResolvedValue(null),
  clearIssueScanBuffer: vi.fn().mockResolvedValue(undefined),
  replaceIssueScanWorkers: vi.fn().mockResolvedValue(undefined),
  readIssueScanWorker: vi.fn().mockResolvedValue(null),
  updateIssueScanWorker: vi.fn().mockResolvedValue(undefined),
  replaceFieldOptionsCache: vi.fn().mockResolvedValue({ optionCount: 0 }),
  flushIssueScanCounts: vi.fn().mockResolvedValue(undefined),
  finalizeIssueScan: vi.fn().mockResolvedValue(undefined),
  clearRqtFieldIndex: vi.fn().mockResolvedValue(undefined),
  upsertRqtFieldHits: vi.fn().mockResolvedValue(undefined),
  clearRqtIssueKeys: vi.fn().mockResolvedValue(undefined),
  upsertRqtIssueKeys: vi.fn().mockResolvedValue(undefined),
  clearRqtValueIndex: vi.fn().mockResolvedValue(undefined),
  upsertRqtValueIssueKeys: vi.fn().mockResolvedValue(undefined),
  clearRqtFieldIssueIndex: vi.fn().mockResolvedValue(undefined),
  upsertRqtFieldIssueKeys: vi.fn().mockResolvedValue(undefined),
  atomicAccumulateIssueScanProgress: vi.fn().mockResolvedValue({ processedPages: 1, totalPages: 4 }),
  appendIssueScanLogEntry: vi.fn().mockResolvedValue(undefined),
  tryClaimIssueScanFinalization: vi.fn().mockResolvedValue(false),
  loadIssueScanProjectTotals: vi.fn().mockResolvedValue([]),
  promoteIssueScanToSnapshotProjectUsage: vi.fn().mockResolvedValue({ fieldsPromoted: 0, rowsInserted: 0 }),
  loadSnapshotFields: vi.fn().mockResolvedValue([]),
}));

vi.mock("./analysis.js", () => ({
  STRUCTURAL_SYSTEM_FIELDS: new Set(["project", "summary", "status"]),
  isFieldValueNonEmpty: vi.fn().mockReturnValue(true),
  collectIssueRqtValues: vi.fn().mockReturnValue(new Map()),
  isSelectFieldType: vi.fn().mockReturnValue(false),
  getRetryDelayMs: vi.fn().mockReturnValue(2000),
}));

vi.mock("./snapshot-engine.js", () => ({
  syncFieldCatalog: vi.fn().mockResolvedValue({ newFieldCount: 0, changedFieldCount: 0, totalCatalogCount: 0 }),
  refreshGovernanceFindingsForFields: vi.fn().mockResolvedValue({ updatedCount: 0 }),
}));

vi.mock("@forge/api", () => ({
  route: (strings, ...values) => {
    let result = "";
    strings.forEach((str, i) => { result += str + (values[i] ?? ""); });
    return result;
  },
  default: { asApp: () => ({ requestJira: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) }) },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getProjectStoreMock() {
  const mod = await import("./project-store.js");
  return mod;
}

async function getJiraApiMock() {
  const mod = await import("./jira-api.js");
  return mod;
}

async function getQueuesMock() {
  const mod = await import("./queues.js");
  return mod;
}

const INSTALLATION_KEY = "test-install";

// ── isJiraRateLimitError ──────────────────────────────────────────────────────

describe("isJiraRateLimitError", () => {
  it("returns true for status 429", () => {
    expect(isJiraRateLimitError({ status: 429 })).toBe(true);
    expect(isJiraRateLimitError({ status: "429" })).toBe(true);
  });

  it("returns false for other statuses", () => {
    expect(isJiraRateLimitError({ status: 400 })).toBe(false);
    expect(isJiraRateLimitError({ status: 500 })).toBe(false);
    expect(isJiraRateLimitError(null)).toBe(false);
    expect(isJiraRateLimitError(undefined)).toBe(false);
  });
});

// ── isExpiredPageTokenError ───────────────────────────────────────────────────

describe("isExpiredPageTokenError", () => {
  it("returns true for 400 with next page token message", () => {
    expect(isExpiredPageTokenError({ status: 400, message: "Invalid next page token" })).toBe(true);
    expect(isExpiredPageTokenError({ status: "400", message: "NEXT PAGE TOKEN expired" })).toBe(true);
  });

  it("returns false for 400 without next page token message", () => {
    expect(isExpiredPageTokenError({ status: 400, message: "Bad request" })).toBe(false);
  });

  it("returns false for non-400 status even with relevant message", () => {
    expect(isExpiredPageTokenError({ status: 401, message: "next page token" })).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isExpiredPageTokenError(null)).toBe(false);
    expect(isExpiredPageTokenError(undefined)).toBe(false);
  });
});

// ── runIssueScanCoordinator ───────────────────────────────────────────────────

describe("runIssueScanCoordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips if existing meta is not in queued state", async () => {
    const store = await getProjectStoreMock();
    store.readIssueScanMeta.mockResolvedValue({ state: "building" });

    await runIssueScanCoordinator(INSTALLATION_KEY);

    expect(store.writeIssueScanMeta).not.toHaveBeenCalled();
  });

  it("skips if existing meta is in ready state", async () => {
    const store = await getProjectStoreMock();
    store.readIssueScanMeta.mockResolvedValue({ state: "ready" });

    await runIssueScanCoordinator(INSTALLATION_KEY);

    expect(store.writeIssueScanMeta).not.toHaveBeenCalled();
  });

  it("writes ready state with no-projects message when project list is empty", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();
    store.readIssueScanMeta.mockResolvedValue({ state: "queued" });
    jiraApi.getAllJiraProjectKeys.mockResolvedValue([]);

    await runIssueScanCoordinator(INSTALLATION_KEY);

    expect(store.writeIssueScanMeta).toHaveBeenCalledWith(
      INSTALLATION_KEY,
      expect.objectContaining({
        state: "ready",
        totalIssues: 0,
      })
    );
    const call = store.writeIssueScanMeta.mock.calls[0][1];
    expect(call.progressLog).toBeDefined();
    expect(call.progressLog[0].msg).toContain("No projects found");
  });

  it("writes building state with startedAt and totalPages when projects found", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();

    store.readIssueScanMeta.mockResolvedValue({ state: "queued" });
    store.readSnapshotMeta.mockResolvedValue(null);
    jiraApi.getAllJiraProjectKeys.mockResolvedValue([
      "PROJ-A", "PROJ-B", "PROJ-C", "PROJ-D", "PROJ-E",
      "PROJ-F", "PROJ-G", "PROJ-H", "PROJ-I", "PROJ-J",
    ]);
    jiraApi.withTimeout.mockResolvedValue({ count: 5000 });
    store.loadIssueScanProjectTotals.mockResolvedValue([]);

    await runIssueScanCoordinator(INSTALLATION_KEY);

    const writeCalls = store.writeIssueScanMeta.mock.calls;
    const buildingCall = writeCalls.find((c) => c[1].state === "building");
    expect(buildingCall).toBeDefined();
    const writtenMeta = buildingCall[1];
    expect(writtenMeta.startedAt).toBeDefined();
    // totalPages = ISSUE_SCAN_WORKERS (4 in our mock)
    expect(writtenMeta.totalPages).toBe(4);
  });

  it("calls replaceIssueScanWorkers with the correct worker count", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();

    store.readIssueScanMeta.mockResolvedValue({ state: "queued" });
    store.readSnapshotMeta.mockResolvedValue(null);
    jiraApi.getAllJiraProjectKeys.mockResolvedValue(["PROJ-A", "PROJ-B"]);
    jiraApi.withTimeout.mockResolvedValue({ count: 100 });
    store.loadIssueScanProjectTotals.mockResolvedValue([]);

    await runIssueScanCoordinator(INSTALLATION_KEY);

    expect(store.replaceIssueScanWorkers).toHaveBeenCalledWith(
      INSTALLATION_KEY,
      expect.arrayContaining([
        expect.objectContaining({ workerId: 0, status: "queued" }),
      ])
    );
    // ISSUE_SCAN_WORKERS = 4, so array length should be 4
    const [, workers] = store.replaceIssueScanWorkers.mock.calls[0];
    expect(workers).toHaveLength(4);
  });

  it("queues one worker event per ISSUE_SCAN_WORKERS", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();
    const queues = await getQueuesMock();

    store.readIssueScanMeta.mockResolvedValue({ state: "queued" });
    store.readSnapshotMeta.mockResolvedValue(null);
    jiraApi.getAllJiraProjectKeys.mockResolvedValue(["PROJ-A"]);
    jiraApi.withTimeout.mockResolvedValue({ count: 10 });
    store.loadIssueScanProjectTotals.mockResolvedValue([]);

    await runIssueScanCoordinator(INSTALLATION_KEY);

    // One push for each worker (4), plus any per-worker-option-cache pushes
    const workerPushes = queues.inventorySnapshotQueue.push.mock.calls.filter(
      (c) => c[0].body?.jobType === "run-issue-scan-worker"
    );
    expect(workerPushes).toHaveLength(4);
  });

  it("syncs the field catalog before targeting fields when a snapshot version already exists", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();
    const snapshotEngine = await import("./snapshot-engine.js");

    store.readIssueScanMeta.mockResolvedValue({ state: "queued" });
    store.readSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    jiraApi.getAllJiraProjectKeys.mockResolvedValue(["PROJ-A"]);
    jiraApi.withTimeout.mockResolvedValue({ count: 10 });
    store.loadIssueScanProjectTotals.mockResolvedValue([]);

    await runIssueScanCoordinator(INSTALLATION_KEY);

    expect(snapshotEngine.syncFieldCatalog).toHaveBeenCalledWith(INSTALLATION_KEY, "v1");
    expect(store.clearSnapshotVersion).not.toHaveBeenCalled();
  });

  it("skips the field catalog sync when a runSnapshot build is concurrently in progress", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();
    const snapshotEngine = await import("./snapshot-engine.js");

    store.readIssueScanMeta.mockResolvedValue({ state: "queued" });
    store.readSnapshotMeta.mockResolvedValue({ state: "building", version: "v1" });
    jiraApi.getAllJiraProjectKeys.mockResolvedValue(["PROJ-A"]);
    jiraApi.withTimeout.mockResolvedValue({ count: 10 });
    store.loadIssueScanProjectTotals.mockResolvedValue([]);

    await runIssueScanCoordinator(INSTALLATION_KEY);

    expect(snapshotEngine.syncFieldCatalog).not.toHaveBeenCalled();
    // The crawl itself must still proceed even though discovery was skipped
    expect(store.replaceIssueScanWorkers).toHaveBeenCalled();
  });

  it("bootstraps a fresh snapshot version and syncs the catalog on a cold start (no snapshot has ever run)", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();
    const snapshotEngine = await import("./snapshot-engine.js");

    store.readIssueScanMeta.mockResolvedValue({ state: "queued" });
    store.readSnapshotMeta.mockResolvedValue(null);
    jiraApi.getAllJiraProjectKeys.mockResolvedValue(["PROJ-A"]);
    jiraApi.withTimeout.mockResolvedValue({ count: 10 });
    store.loadIssueScanProjectTotals.mockResolvedValue([]);
    snapshotEngine.syncFieldCatalog.mockResolvedValue({ newFieldCount: 3, changedFieldCount: 0, totalCatalogCount: 3 });

    await runIssueScanCoordinator(INSTALLATION_KEY);

    expect(store.clearSnapshotVersion).toHaveBeenCalledWith(INSTALLATION_KEY, expect.any(String));
    expect(snapshotEngine.syncFieldCatalog).toHaveBeenCalledWith(INSTALLATION_KEY, expect.any(String));
    const readyCall = store.writeSnapshotMeta.mock.calls.find((c) => c[1].state === "ready");
    expect(readyCall).toBeDefined();
    expect(readyCall[1].totalFields).toBe(3);
  });

  it("does not block the crawl when the field catalog sync throws", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();
    const snapshotEngine = await import("./snapshot-engine.js");

    store.readIssueScanMeta.mockResolvedValue({ state: "queued" });
    store.readSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });
    jiraApi.getAllJiraProjectKeys.mockResolvedValue(["PROJ-A"]);
    jiraApi.withTimeout.mockResolvedValue({ count: 10 });
    store.loadIssueScanProjectTotals.mockResolvedValue([]);
    snapshotEngine.syncFieldCatalog.mockRejectedValueOnce(new Error("Jira unavailable"));

    await runIssueScanCoordinator(INSTALLATION_KEY);

    // Sync failure is swallowed -- the crawl still proceeds and queues workers
    expect(store.replaceIssueScanWorkers).toHaveBeenCalled();
    const failCall = store.writeIssueScanMeta.mock.calls.find((c) => c[1].state === "failed");
    expect(failCall).toBeUndefined();
  });

  it("writes failed state when getAllJiraProjectKeys throws", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();

    store.readIssueScanMeta.mockResolvedValue({ state: "queued" });
    jiraApi.getAllJiraProjectKeys.mockRejectedValueOnce(new Error("Jira down"));

    await runIssueScanCoordinator(INSTALLATION_KEY);

    expect(store.writeIssueScanMeta).toHaveBeenCalledWith(
      INSTALLATION_KEY,
      expect.objectContaining({
        state: "failed",
        lastError: "Jira down",
      })
    );
  });

  it("writes failed state when ensureProjectStoreReady throws", async () => {
    const store = await getProjectStoreMock();
    store.ensureProjectStoreReady.mockRejectedValueOnce(new Error("Store not ready"));

    await runIssueScanCoordinator(INSTALLATION_KEY);

    expect(store.writeIssueScanMeta).toHaveBeenCalledWith(
      INSTALLATION_KEY,
      expect.objectContaining({ state: "failed" })
    );
  });
});

// ── completeIssueScanFinalization ─────────────────────────────────────────────

describe("completeIssueScanFinalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes ready state with processedIssues in scan history", async () => {
    const store = await getProjectStoreMock();
    store.readIssueScanMeta.mockResolvedValue({
      processedIssues: 5000,
      startedAt: "2026-01-01T00:00:00.000Z",
      progressLog: [],
      scanHistory: [],
    });
    store.readSnapshotMeta.mockResolvedValue(null);

    await completeIssueScanFinalization(INSTALLATION_KEY, "test-tag");

    expect(store.writeIssueScanMeta).toHaveBeenCalledWith(
      INSTALLATION_KEY,
      expect.objectContaining({ state: "ready" })
    );
    const call = store.writeIssueScanMeta.mock.calls[0][1];
    expect(call.scanHistory).toHaveLength(1);
    expect(call.scanHistory[0].processedIssues).toBe(5000);
  });

  it("preserves existing scan history and appends new entry", async () => {
    const store = await getProjectStoreMock();
    store.readIssueScanMeta.mockResolvedValue({
      processedIssues: 3000,
      startedAt: "2026-01-01T00:00:00.000Z",
      progressLog: [],
      scanHistory: [{ processedIssues: 1000, startedAt: "2025-01-01T00:00:00.000Z" }],
    });
    store.readSnapshotMeta.mockResolvedValue(null);

    await completeIssueScanFinalization(INSTALLATION_KEY, "test-tag");

    const call = store.writeIssueScanMeta.mock.calls[0][1];
    expect(call.scanHistory).toHaveLength(2);
    expect(call.scanHistory[1].processedIssues).toBe(3000);
  });

  it("caps scan history at 15 entries", async () => {
    const store = await getProjectStoreMock();
    const existingHistory = Array.from({ length: 14 }, (_, i) => ({
      processedIssues: i * 100,
      startedAt: new Date().toISOString(),
    }));
    store.readIssueScanMeta.mockResolvedValue({
      processedIssues: 9999,
      startedAt: "2026-01-01T00:00:00.000Z",
      progressLog: [],
      scanHistory: existingHistory,
    });
    store.readSnapshotMeta.mockResolvedValue(null);

    await completeIssueScanFinalization(INSTALLATION_KEY, "test-tag");

    const call = store.writeIssueScanMeta.mock.calls[0][1];
    // 14 existing (sliced to -14 = 14) + 1 new = 15
    expect(call.scanHistory).toHaveLength(15);
  });

  it("caps scan history when existing already has 15 entries", async () => {
    const store = await getProjectStoreMock();
    const existingHistory = Array.from({ length: 15 }, (_, i) => ({
      processedIssues: i * 100,
      startedAt: new Date().toISOString(),
    }));
    store.readIssueScanMeta.mockResolvedValue({
      processedIssues: 9999,
      startedAt: "2026-01-01T00:00:00.000Z",
      progressLog: [],
      scanHistory: existingHistory,
    });
    store.readSnapshotMeta.mockResolvedValue(null);

    await completeIssueScanFinalization(INSTALLATION_KEY, "test-tag");

    const call = store.writeIssueScanMeta.mock.calls[0][1];
    // slice(-14) keeps 14 of 15, then +1 new = 15
    expect(call.scanHistory).toHaveLength(15);
  });

  it("handles finalization error by writing failed state", async () => {
    const store = await getProjectStoreMock();
    store.finalizeIssueScan.mockRejectedValueOnce(new Error("DB error"));
    // Second readIssueScanMeta call (in catch block) returns something minimal
    store.readIssueScanMeta.mockResolvedValue({ progressLog: [] });

    await completeIssueScanFinalization(INSTALLATION_KEY, "test-tag");

    const failCalls = store.writeIssueScanMeta.mock.calls.filter(
      (c) => c[1].state === "failed"
    );
    expect(failCalls).toHaveLength(1);
    expect(failCalls[0][1].lastError).toContain("Finalization failed");
  });

  it("promotes snapshot project usage when snapshot version exists", async () => {
    const store = await getProjectStoreMock();
    store.readSnapshotMeta.mockResolvedValue({ version: "v1" });
    store.readIssueScanMeta.mockResolvedValue({
      processedIssues: 100,
      startedAt: "2026-01-01T00:00:00.000Z",
      progressLog: [],
      scanHistory: [],
    });

    await completeIssueScanFinalization(INSTALLATION_KEY, "test-tag");

    // Default readIssueScanWorker mock resolves null for every worker -- a missing
    // worker record counts as trivially complete, so full coverage is assumed here.
    expect(store.promoteIssueScanToSnapshotProjectUsage).toHaveBeenCalledWith(
      INSTALLATION_KEY,
      "v1",
      { syncTotalIssueCount: true }
    );
  });

  it("does not sync total issue counts when any worker did not finish", async () => {
    const store = await getProjectStoreMock();
    store.readSnapshotMeta.mockResolvedValue({ version: "v1" });
    store.readIssueScanMeta.mockResolvedValue({
      processedIssues: 100,
      startedAt: "2026-01-01T00:00:00.000Z",
      progressLog: [],
      scanHistory: [],
    });
    store.readIssueScanWorker.mockImplementation((_key, workerId) =>
      Promise.resolve(workerId === 0 ? { status: "failed" } : { status: "done" })
    );

    await completeIssueScanFinalization(INSTALLATION_KEY, "test-tag");

    expect(store.promoteIssueScanToSnapshotProjectUsage).toHaveBeenCalledWith(
      INSTALLATION_KEY,
      "v1",
      { syncTotalIssueCount: false }
    );
  });

  it("refreshes governance findings for touched fields after promotion", async () => {
    const store = await getProjectStoreMock();
    const { refreshGovernanceFindingsForFields } = await import("./snapshot-engine.js");
    store.readSnapshotMeta.mockResolvedValue({ version: "v1" });
    store.readIssueScanMeta.mockResolvedValue({
      processedIssues: 100,
      startedAt: "2026-01-01T00:00:00.000Z",
      progressLog: [],
      scanHistory: [],
    });
    store.promoteIssueScanToSnapshotProjectUsage.mockResolvedValue({
      fieldsPromoted: 2,
      rowsInserted: 5,
      touchedFieldIds: ["customfield_1", "customfield_2"],
    });

    await completeIssueScanFinalization(INSTALLATION_KEY, "test-tag");

    expect(refreshGovernanceFindingsForFields).toHaveBeenCalledWith(
      INSTALLATION_KEY,
      "v1",
      ["customfield_1", "customfield_2"]
    );
  });

  it("does not attempt to refresh findings when nothing was touched", async () => {
    const store = await getProjectStoreMock();
    const { refreshGovernanceFindingsForFields } = await import("./snapshot-engine.js");
    store.readSnapshotMeta.mockResolvedValue({ version: "v1" });
    store.readIssueScanMeta.mockResolvedValue({
      processedIssues: 100,
      startedAt: "2026-01-01T00:00:00.000Z",
      progressLog: [],
      scanHistory: [],
    });
    store.promoteIssueScanToSnapshotProjectUsage.mockResolvedValue({
      fieldsPromoted: 0,
      rowsInserted: 0,
      touchedFieldIds: [],
    });

    await completeIssueScanFinalization(INSTALLATION_KEY, "test-tag");

    expect(refreshGovernanceFindingsForFields).not.toHaveBeenCalled();
  });
});

// ── runIssueScanWorkerV2 ──────────────────────────────────────────────────────

describe("runIssueScanWorkerV2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns early when scan state is not building", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();
    store.readIssueScanMeta.mockResolvedValue({ state: "ready" });

    await runIssueScanWorkerV2(INSTALLATION_KEY, 0);

    expect(jiraApi.jiraRequest).not.toHaveBeenCalled();
  });

  it("returns early when scan meta is missing", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();
    store.readIssueScanMeta.mockResolvedValue(null);

    await runIssueScanWorkerV2(INSTALLATION_KEY, 0);

    expect(jiraApi.jiraRequest).not.toHaveBeenCalled();
  });

  it("returns early when worker status is done", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();
    store.readIssueScanMeta.mockResolvedValue({ state: "building" });
    store.readIssueScanWorker.mockResolvedValue({ status: "done", jqlFilter: "project = TEST" });

    await runIssueScanWorkerV2(INSTALLATION_KEY, 0);

    expect(jiraApi.jiraRequest).not.toHaveBeenCalled();
  });

  it("marks worker done and counts progress when no jqlFilter", async () => {
    const store = await getProjectStoreMock();
    store.readIssueScanMeta.mockResolvedValue({ state: "building" });
    store.readIssueScanWorker.mockResolvedValue({ status: "queued", jqlFilter: null });
    store.atomicAccumulateIssueScanProgress.mockResolvedValue({
      processedPages: 1,
      totalPages: 4,
    });

    await runIssueScanWorkerV2(INSTALLATION_KEY, 0);

    expect(store.updateIssueScanWorker).toHaveBeenCalledWith(
      INSTALLATION_KEY,
      0,
      expect.objectContaining({ status: "done" })
    );
    expect(store.atomicAccumulateIssueScanProgress).toHaveBeenCalledWith(
      INSTALLATION_KEY,
      1,
      0
    );
  });

  it("skips duplicate active worker that is still fresh", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();
    const recentTime = new Date(Date.now() - 30 * 1000).toISOString(); // 30s ago
    store.readIssueScanMeta.mockResolvedValue({ state: "building" });
    store.readIssueScanWorker.mockResolvedValue({
      status: "building",
      jqlFilter: "project = TEST",
      updatedAt: recentTime,
    });

    await runIssueScanWorkerV2(INSTALLATION_KEY, 0);

    expect(jiraApi.jiraRequest).not.toHaveBeenCalled();
  });

  it("writes failed state when worker checkpoint is missing (throws)", async () => {
    const store = await getProjectStoreMock();
    store.readIssueScanMeta.mockResolvedValue({ state: "building" });
    store.readIssueScanWorker.mockResolvedValue(null); // missing checkpoint → throws

    await runIssueScanWorkerV2(INSTALLATION_KEY, 0);

    const failCalls = store.writeIssueScanMeta.mock.calls.filter(
      (c) => c[1].state === "failed"
    );
    expect(failCalls.length).toBeGreaterThan(0);
  });

  it("processes a page of issues and calls jiraRequest", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();
    store.readIssueScanMeta.mockResolvedValue({ state: "building" });
    store.readIssueScanWorker.mockResolvedValue({
      status: "queued",
      jqlFilter: "project = TEST",
      fieldIds: null,
      nextPageToken: null,
      processedIssues: 0,
      processedPages: 0,
    });
    jiraApi.jiraRequest.mockResolvedValue({
      issues: [
        { key: "TEST-1", fields: { project: { id: "1", key: "TEST", name: "Test" } } },
      ],
      nextPageToken: null,
    });
    store.atomicAccumulateIssueScanProgress.mockResolvedValue({
      processedPages: 1,
      totalPages: 4,
    });
    store.updateIssueScanWorker.mockResolvedValue({ status: "done" });

    await runIssueScanWorkerV2(INSTALLATION_KEY, 0);

    expect(jiraApi.jiraRequest).toHaveBeenCalledTimes(1);
  });

  it("claims finalization when last worker finishes", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();
    store.readIssueScanMeta.mockResolvedValue({ state: "building" });
    store.readIssueScanWorker.mockResolvedValue({
      status: "queued",
      jqlFilter: "project = TEST",
      fieldIds: null,
      nextPageToken: null,
      processedIssues: 0,
      processedPages: 0,
    });
    jiraApi.jiraRequest.mockResolvedValue({ issues: [], nextPageToken: null });
    // Simulate this being the last worker (processedPages == totalPages)
    store.atomicAccumulateIssueScanProgress.mockResolvedValue({
      processedPages: 4,
      totalPages: 4,
    });
    store.tryClaimIssueScanFinalization.mockResolvedValue(true);
    store.readSnapshotMeta.mockResolvedValue(null);
    store.readIssueScanMeta
      .mockResolvedValueOnce({ state: "building" }) // first call
      .mockResolvedValue({                           // subsequent calls
        processedIssues: 0,
        startedAt: new Date().toISOString(),
        progressLog: [],
        scanHistory: [],
      });

    await runIssueScanWorkerV2(INSTALLATION_KEY, 0);

    expect(store.tryClaimIssueScanFinalization).toHaveBeenCalled();
    expect(store.finalizeIssueScan).toHaveBeenCalled();
  });
});

// ── queueIssueScanChunk ───────────────────────────────────────────────────────

describe("queueIssueScanChunk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when queue push succeeds", async () => {
    const queues = await getQueuesMock();
    queues.inventorySnapshotQueue.push.mockResolvedValue({ queued: true });

    const result = await queueIssueScanChunk(INSTALLATION_KEY);
    expect(result).toBe(true);
  });

  it("returns false and writes queued state after all retries fail", async () => {
    const queues = await getQueuesMock();
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();

    queues.inventorySnapshotQueue.push.mockRejectedValue(new Error("Queue full"));

    const result = await queueIssueScanChunk(INSTALLATION_KEY, [], 0);

    expect(result).toBe(false);
    // Sleep should be called for retry delays
    expect(jiraApi.sleep).toHaveBeenCalled();
    expect(store.writeIssueScanMeta).toHaveBeenCalledWith(
      INSTALLATION_KEY,
      expect.objectContaining({ state: "queued" })
    );
  });
});
