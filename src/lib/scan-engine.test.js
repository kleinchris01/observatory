import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isJiraRateLimitError,
  isExpiredPageTokenError,
  queueIssueScanChunk,
  runIssueScanCoordinator,
  completeIssueScanFinalization,
  runIssueScanWorkerV2,
  sliceProjectKeys,
  normalizeWorkerSlices,
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
  ISSUE_SCAN_SLICES_PER_WORKER: 3,
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
  clearIssueScanBufferForProjects: vi.fn().mockResolvedValue({ cleared: 0 }),
  replaceIssueScanWorkers: vi.fn().mockResolvedValue(undefined),
  readIssueScanWorker: vi.fn().mockResolvedValue(null),
  updateIssueScanWorker: vi.fn().mockResolvedValue(undefined),
  replaceFieldOptionsCache: vi.fn().mockResolvedValue({ optionCount: 0 }),
  flushIssueScanCounts: vi.fn().mockResolvedValue(undefined),
  flushIssueScanActivity: vi.fn().mockResolvedValue(undefined),
  flushIssueScanStatusCounts: vi.fn().mockResolvedValue(undefined),
  clearStatusIssueCounts: vi.fn().mockResolvedValue(undefined),
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


  // The per-issue loop was never exercised: every existing case returns before the first
  // page is fetched. This feeds real issues through it, which is also the only coverage of
  // the status accumulation added for the workflow insights -- status arrives on every
  // issue because a universe scan requests "*all", and is counted rather than discarded.
  describe("per-issue accumulation", () => {
    function issuePage(issues, nextPageToken = null) {
      return { issues, nextPageToken };
    }

    const issue = (key, projectId, projectKey, statusId, statusName, extra = {}) => ({
      key,
      fields: {
        project: { id: projectId, key: projectKey, name: projectKey },
        status: { id: statusId, name: statusName, statusCategory: { name: "In Progress" } },
        ...extra,
      },
    });

    // The worker clears the accumulator immediately after flushing -- correct, since it
    // would otherwise double-count on the next flush -- so the mock must snapshot the Map
    // rather than hold the reference, which would be empty by assertion time.
    async function runWorkerOverPage(issues) {
      const store = await getProjectStoreMock();
      const jiraApi = await getJiraApiMock();
      let capturedStatusCounts = new Map();
      store.readIssueScanMeta.mockResolvedValue({ state: "building" });
      store.readIssueScanWorker.mockResolvedValue({ status: "queued", jqlFilter: "project = ALPHA", fieldIds: null });
      store.atomicAccumulateIssueScanProgress.mockResolvedValue({ processedPages: 1, totalPages: 1 });
      store.flushIssueScanStatusCounts.mockImplementation(async (_key, counts) => {
        capturedStatusCounts = new Map(counts);
      });
      jiraApi.jiraRequest.mockResolvedValue(issuePage(issues));

      await runIssueScanWorkerV2(INSTALLATION_KEY, 0);
      return { store, statusCounts: capturedStatusCounts };
    }

    it("counts issues per status and per project, and flushes them", async () => {
      const { store, statusCounts } = await runWorkerOverPage([
        issue("ALPHA-1", "10", "ALPHA", "3", "In Review"),
        issue("ALPHA-2", "10", "ALPHA", "3", "In Review"),
        issue("ALPHA-3", "10", "ALPHA", "5", "Done"),
      ]);

      expect(store.flushIssueScanStatusCounts).toHaveBeenCalled();
      expect(statusCounts.get("3|10")).toMatchObject({ statusId: "3", projectId: "10", count: 2 });
      expect(statusCounts.get("5|10")).toMatchObject({ statusId: "5", count: 1 });
    });

    it("keys status counts by project so one status across two projects stays separate", async () => {
      const { statusCounts } = await runWorkerOverPage([
        issue("ALPHA-1", "10", "ALPHA", "3", "In Review"),
        issue("BRAVO-1", "11", "BRAVO", "3", "In Review"),
      ]);

      expect(statusCounts.get("3|10").count).toBe(1);
      expect(statusCounts.get("3|11").count).toBe(1);
    });

    // The adoption bug, pinned.
    //
    // flushIssueScanActivity used to be called from exactly two places: the mid-chunk flush,
    // which the code's own comment admits "never fires" (ISSUE_SCAN_FLUSH_EVERY_PAGES equals
    // ISSUE_SCAN_CHUNK_PAGES, so `page % N === 0` is never true for pages 0..N-1), and the 400
    // token-expiry recovery. The end-of-chunk flush -- the one that runs every invocation --
    // wrote counts but not activity.
    //
    // So project activity months were accumulated in memory on every chunk and then discarded.
    // That is the entire basis of the adoption rate, which is why the Projects rail could never
    // answer "fell off" or "quiet 6 months" even after a scan that reported success.
    it("writes project activity, not just counts, on the path that actually runs", async () => {
      const { store } = await runWorkerOverPage([
        issue("ALPHA-1", "10", "ALPHA", "3", "In Review", { created: "2026-03-14T00:00:00.000Z" }),
      ]);

      expect(store.flushIssueScanCounts).toHaveBeenCalled();
      expect(store.flushIssueScanActivity).toHaveBeenCalled();

      const months = store.flushIssueScanActivity.mock.calls.at(-1)[1];
      expect(months.get("10|2026-03")).toMatchObject({ projectId: "10", month: "2026-03", count: 1 });
    });

    it("skips issues with no status rather than bucketing them under a blank id", async () => {
      const { statusCounts } = await runWorkerOverPage([
        { key: "ALPHA-1", fields: { project: { id: "10", key: "ALPHA", name: "Alpha" } } },
      ]);

      for (const key of statusCounts.keys()) expect(key.startsWith("|")).toBe(false);
    });

    it("skips issues with no project, which cannot be attributed", async () => {
      const { statusCounts } = await runWorkerOverPage([
        { key: "ORPHAN-1", fields: { status: { id: "3", name: "In Review" } } },
      ]);

      expect(statusCounts.size).toBe(0);
    });

    // Field usage is the scan's primary output; losing status counts must never fail it.
    it("does not fail the scan when the status flush throws", async () => {
      const store = await getProjectStoreMock();
      const jiraApi = await getJiraApiMock();
      store.readIssueScanMeta.mockResolvedValue({ state: "building" });
      store.readIssueScanWorker.mockResolvedValue({ status: "queued", jqlFilter: "project = ALPHA", fieldIds: null });
      store.atomicAccumulateIssueScanProgress.mockResolvedValue({ processedPages: 1, totalPages: 1 });
      store.flushIssueScanStatusCounts.mockRejectedValue(new Error("sql down"));
      jiraApi.jiraRequest.mockResolvedValue(issuePage([issue("ALPHA-1", "10", "ALPHA", "3", "In Review")]));

      await expect(runIssueScanWorkerV2(INSTALLATION_KEY, 0)).resolves.toBeUndefined();
      expect(store.flushIssueScanCounts).toHaveBeenCalled();
    });

    it("counts populated custom fields per project alongside statuses", async () => {
      const { store } = await runWorkerOverPage([
        issue("ALPHA-1", "10", "ALPHA", "3", "In Review", { customfield_1: "value" }),
      ]);

      expect(store.flushIssueScanCounts).toHaveBeenCalled();
      const [, fieldProjectCounts] = store.flushIssueScanCounts.mock.calls.at(-1);
      expect(fieldProjectCounts.has("customfield_1")).toBe(true);
    });
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

  // This used to assert the SCAN was marked failed when one worker threw. That was the
  // behaviour, and it was the reason no universe scan on a large site ever completed: a single
  // refused request in one of five workers discarded a crawl in which the other four were
  // healthy and most of the estate had already been counted and stored.
  //
  // The worker still fails, and still says so. The scan no longer dies with it.
  it("records a worker failure without failing the whole scan", async () => {
    const store = await getProjectStoreMock();
    store.readIssueScanMeta.mockResolvedValue({ state: "building" });
    store.readIssueScanWorker.mockResolvedValue(null); // missing checkpoint → throws

    await runIssueScanWorkerV2(INSTALLATION_KEY, 0);

    const metaWrites = store.writeIssueScanMeta.mock.calls.map((c) => c[1]);
    expect(metaWrites.some((m) => m.state === "failed")).toBe(false);
    expect(metaWrites.some((m) => /Worker 0 failed/.test(m.lastError || ""))).toBe(true);

    const workerWrites = store.updateIssueScanWorker.mock.calls.map((c) => c[2]);
    expect(workerWrites.some((w) => w.status === "failed")).toBe(true);
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

    // Every retry attempt, then restored -- mockRejectedValue without a reset leaks into every
    // test that runs after this one, which is exactly what it did to the resilience tests below.
    queues.inventorySnapshotQueue.push
      .mockRejectedValueOnce(new Error("Queue full"))
      .mockRejectedValueOnce(new Error("Queue full"))
      .mockRejectedValueOnce(new Error("Queue full"))
      .mockRejectedValueOnce(new Error("Queue full"))
      .mockRejectedValueOnce(new Error("Queue full"));

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

// ── Slices: the concurrency the worker was always allowed and never used ──────────────
//
// Pagination is sequential, so a worker crawling one JQL keeps exactly one request in flight
// while BASE_JIRA_CONCURRENCY permits four. That is what held a measured run at ~64 issues/sec.
// These pin the two halves that make slicing correct rather than merely parallel: disjoint
// queries, and a worker that is only "done" when every slice is.
// Rate-limit pressure has to reach a human, not just a counter.
//
// getScanTelemetry() was imported by scan-engine and never called, so the 429 count was
// measured on every request and displayed nowhere -- for the one scan most likely to provoke
// it. With slices raising concurrency, that number is the input that decides
// ISSUE_SCAN_SLICES_PER_WORKER, so it belongs in the progress log the Scans tab renders.
describe("scan rate-limit reporting", () => {
  test("writes this chunk's 429 count to the scan progress log", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();
    store.readIssueScanMeta.mockResolvedValue({ state: "building" });
    store.readIssueScanWorker.mockResolvedValue({ status: "queued", jqlFilter: "project = ALPHA", fieldIds: null });
    store.atomicAccumulateIssueScanProgress.mockResolvedValue({ processedPages: 1, totalPages: 1 });
    jiraApi.getScanTelemetry.mockReturnValue({ rl429Count: 4, rlRetryCount: 2 });
    jiraApi.jiraRequest.mockResolvedValue({ issues: [], nextPageToken: null });

    await runIssueScanWorkerV2(INSTALLATION_KEY, 0);

    // Reset first, or the number describes whatever else ran in this container rather than
    // this chunk -- module state in Forge is per invocation, not per scan.
    expect(jiraApi.resetScanTelemetry).toHaveBeenCalled();

    const logged = store.appendIssueScanLogEntry.mock.calls.map((c) => c[1]).join(" | ");
    expect(logged).toMatch(/4 rate-limited/);
    expect(logged).toMatch(/2 retried/);
    // Labelled per chunk. There is no counter shared across workers, and presenting one
    // chunk's number as a scan-wide total would be worse than showing nothing.
    expect(logged).toMatch(/this chunk/);
  });
});

describe("sliceProjectKeys", () => {
  const counts = new Map([["A", 1000], ["B", 900], ["C", 100], ["D", 50]]);

  test("splits projects into balanced, disjoint slices", () => {
    const slices = sliceProjectKeys(["A", "B", "C", "D"], counts, 2);

    expect(slices).toHaveLength(2);
    // Every project appears exactly once. An overlap would double-count issues into the field
    // usage totals, which is the number the whole app is built on.
    const mentioned = slices.flatMap((s) => ["A", "B", "C", "D"].filter((k) => s.jql.includes(`"${k}"`)));
    expect([...mentioned].sort()).toEqual(["A", "B", "C", "D"]);
    // Largest-first packing: the two big projects land in different slices, or the invocation
    // is only as fast as the slice holding both.
    const withA = slices.find((s) => s.jql.includes('"A"'));
    expect(withA.jql).not.toContain('"B"');
  });

  test("never makes more slices than there are projects", () => {
    // A single project cannot be split -- there is no cursor-safe way to partition one
    // project's issues across queries without risking gaps or double counting.
    expect(sliceProjectKeys(["A"], counts, 4)).toHaveLength(1);
  });

  test("starts every slice with no cursor and not done", () => {
    for (const slice of sliceProjectKeys(["A", "B"], counts, 2)) {
      expect(slice).toMatchObject({ token: null, done: false, pages: 0, issues: 0 });
    }
  });
});

describe("normalizeWorkerSlices", () => {
  // A scan already running when this deploys has a single jqlFilter and a single
  // nextPageToken and no slices at all. Presenting it as one slice means the crawl has exactly
  // one code path, and an in-flight scan finishes on its original cursor instead of restarting.
  test("presents a pre-slice worker as a single slice on its existing cursor", () => {
    const slices = normalizeWorkerSlices({
      jqlFilter: 'project IN ("ALPHA")',
      nextPageToken: "cursor-abc",
      processedPages: 7,
      processedIssues: 700,
    });

    expect(slices).toEqual([
      {
        id: 0,
        jql: 'project IN ("ALPHA")',
        // No key list: a pre-slice row cannot say which projects it contributed counts for,
        // which is why a restart on one declines to re-crawl rather than double-counting.
        keys: null,
        token: "cursor-abc",
        done: false,
        pages: 7,
        issues: 700,
        restarts: 0,
        abandoned: false,
      },
    ]);
  });

  test("round-trips stored slices, preserving each cursor and done flag", () => {
    const slices = normalizeWorkerSlices({
      slices: [
        { id: 0, jql: "a", token: "t0", done: true, pages: 3, issues: 300 },
        { id: 1, jql: "b", token: null, done: false },
      ],
    });

    expect(slices[0]).toMatchObject({ jql: "a", token: "t0", done: true, pages: 3 });
    // A slice that has never run must not inherit the other's progress.
    expect(slices[1]).toMatchObject({ jql: "b", token: null, done: false, pages: 0, issues: 0 });
  });

  test("returns nothing for a worker with no projects at all", () => {
    expect(normalizeWorkerSlices({ jqlFilter: null })).toEqual([]);
  });
});

// ── Resilience: a scan must survive a request Jira refuses ────────────────────────────
//
// On a real site, one worker hitting a 400 marked the ENTIRE scan failed -- throwing away a
// crawl of 150,000 issues in which four of five workers were healthy and 120,000 issues had
// already been counted and stored. The 400 was real. Making it fatal to the whole run was the
// defect, and it is the reason no universe scan on that site has ever completed.
describe("scan resilience", () => {
  async function runWorkerWith({ workerRow, jiraImpl }) {
    // Cleared per case, not per file. Without this the previous test's calls are still on the
    // mocks and any "was not called" assertion reads the one before it -- the same bleed that
    // "Queue full" caused, arriving from the other direction.
    vi.clearAllMocks();
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();
    store.readIssueScanMeta.mockResolvedValue({ state: "building" });
    store.readIssueScanWorker.mockResolvedValue(workerRow);
    store.atomicAccumulateIssueScanProgress.mockResolvedValue({ processedPages: 1, totalPages: 5 });
    const queues = await getQueuesMock();
    queues.inventorySnapshotQueue.push.mockReset().mockResolvedValue({ queued: true });
    jiraApi.jiraRequest.mockImplementation(jiraImpl);
    await runIssueScanWorkerV2(INSTALLATION_KEY, 0);
    return { store, jiraApi };
  }

  const worker = (over = {}) => ({ status: "queued", jqlFilter: "project = ALPHA", fieldIds: null, ...over });

  test("a 400 on the first page restarts the slice instead of killing the scan", async () => {
    const { store } = await runWorkerWith({
      workerRow: worker(),
      jiraImpl: async () => { const e = new Error("400 Bad Request"); e.status = 400; throw e; },
    });

    // The scan is NOT marked failed. Previously this exact case did mark it failed, because
    // only a 400 WITH a cursor was treated as recoverable.
    const metaWrites = store.writeIssueScanMeta.mock.calls.map((c) => c[1]);
    expect(metaWrites.some((m) => m.state === "failed")).toBe(false);

    // And the worker is re-queued rather than abandoned.
    const workerWrites = store.updateIssueScanWorker.mock.calls.map((c) => c[2]);
    expect(workerWrites.some((w) => w.status === "failed")).toBe(false);
  });

  test("says which slice was refused, and clears its counts before recrawling", async () => {
    const { store } = await runWorkerWith({
      workerRow: worker({
        slices: [{ id: 0, jql: 'project IN ("ALPHA")', keys: ["ALPHA"], token: "cursor-1", done: false }],
      }),
      jiraImpl: async () => { const e = new Error("400 Bad Request"); e.status = 400; throw e; },
    });

    const logged = store.appendIssueScanLogEntry.mock.calls.map((c) => c[1]).join(" | ");
    // "400 Bad Request" alone is what this used to record, which is why it was never
    // diagnosable. The entry now names the slice and the attempt.
    expect(logged).toMatch(/search rejected \(400\)/);
    expect(logged).toMatch(/attempt 1/);

    // And the counts this slice already contributed are removed first. The flush is additive,
    // so recrawling without this reports more field values per issue than a project has fields.
    expect(store.clearIssueScanBufferForProjects).toHaveBeenCalledWith(INSTALLATION_KEY, ["ALPHA"]);
  });

  test("refuses to recrawl a worker that cannot say what it contributed", async () => {
    const { store } = await runWorkerWith({
      // A pre-slice worker row: one JQL, one cursor, no key list.
      workerRow: worker({ nextPageToken: "cursor-1" }),
      jiraImpl: async () => { const e = new Error("400 Bad Request"); e.status = 400; throw e; },
    });

    const logged = store.appendIssueScanLogEntry.mock.calls.map((c) => c[1]).join(" | ");
    expect(logged).toMatch(/cannot restart without double-counting/);
    expect(store.clearIssueScanBufferForProjects).not.toHaveBeenCalled();
  });

  test("gives up on one slice rather than looping on it forever", async () => {
    const { store } = await runWorkerWith({
      workerRow: worker({ slices: [{ id: 0, jql: "project = ALPHA", token: null, done: false, restarts: 99 }] }),
      jiraImpl: async () => { const e = new Error("400 Bad Request"); e.status = 400; throw e; },
    });

    const logged = store.appendIssueScanLogEntry.mock.calls.map((c) => c[1]).join(" | ");
    expect(logged).toMatch(/abandoned after/);
    // Abandoning the slice completes the worker, so the remaining workers can finalize rather
    // than waiting on a slot that is never coming back.
    const workerWrites = store.updateIssueScanWorker.mock.calls.map((c) => c[2]);
    expect(workerWrites.some((w) => w.status === "done")) .toBe(true);
  });

  test("a worker that dies outright still releases its slot so the others can finish", async () => {
    const { store } = await runWorkerWith({
      workerRow: worker(),
      jiraImpl: async () => { throw new Error("connection reset"); },
    });

    // The worker is marked failed...
    const workerWrites = store.updateIssueScanWorker.mock.calls.map((c) => c[2]);
    expect(workerWrites.some((w) => w.status === "failed")).toBe(true);

    // ...but the SCAN is not, and the slot is counted so finalization can still fire. Four
    // healthy workers must not sit at "building" forever waiting on a fifth that is gone.
    const metaWrites = store.writeIssueScanMeta.mock.calls.map((c) => c[1]);
    expect(metaWrites.some((m) => m.state === "failed")).toBe(false);
    expect(metaWrites.some((m) => /Worker 0 failed/.test(m.lastError || ""))).toBe(true);
    expect(store.atomicAccumulateIssueScanProgress).toHaveBeenCalledWith(INSTALLATION_KEY, 1, 0);
  });
});
