import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  hydrateFieldForGovernance,
  requeueStaleSnapshotBuild,
  runSnapshot,
  queueSnapshotBuild,
  tryQueueFieldSummaryBuild,
  queueFieldSummaryContinuationWithRetry,
  fetchFieldCatalog,
  syncFieldCatalog,
  refreshGovernanceFindingsForFields,
  latestChangeAcrossProjects,
} from "./snapshot-engine.js";
import { buildGovernanceFindings } from "./analysis.js";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("./queues.js", () => ({
  inventorySnapshotQueue: { push: vi.fn().mockResolvedValue({ queued: true }) },
}));

vi.mock("./jira-api.js", () => ({
  incrMetric: vi.fn(),
  METRIC_NAMES: {
    inventorySnapshot: "inventorySnapshot",
    projectUsageJobStarted: "projectUsageJobStarted",
    projectUsageJobCompleted: "projectUsageJobCompleted",
    projectUsageJobFailed: "projectUsageJobFailed",
    projectUsageDeltaStarted: "projectUsageDeltaStarted",
    projectUsageDeltaCompleted: "projectUsageDeltaCompleted",
  },
  makeJobToken: vi.fn().mockReturnValue("test-token"),
  getInstallationKey: vi.fn().mockReturnValue(null),
  isSnapshotStale: vi.fn().mockReturnValue(false),
  setSnapshotLogger: vi.fn(),
  sleep: vi.fn().mockResolvedValue(undefined),
  jiraRequest: vi.fn().mockResolvedValue({}),
  paginate: vi.fn().mockResolvedValue([]),
  mapWithConcurrency: vi.fn().mockImplementation(async (items, _concurrency, fn) => {
    const results = [];
    for (let i = 0; i < items.length; i++) results.push(await fn(items[i], i));
    return results;
  }),
  getJitterMs: vi.fn().mockReturnValue(0),
  withRetry: vi.fn().mockImplementation((fn) => fn()),
  scheduleRateLimitedRequest: vi.fn().mockImplementation((fn) => fn()),
  getFieldContexts: vi.fn().mockResolvedValue([]),
  getFieldTotalIssueCount: vi.fn().mockResolvedValue(0),
  getFieldConfiguredProjectCount: vi.fn().mockResolvedValue(0),
  getAllCustomFields: vi.fn().mockResolvedValue([]),
  getAllSystemFields: vi.fn().mockResolvedValue([]),
  getProjectBreakdownByIssueScan: vi.fn().mockResolvedValue({ projects: [], isComplete: true, scannedIssueCount: 0, totalIssues: 0, nextPageToken: null }),
  searchProjectFieldUsage: vi.fn().mockResolvedValue({ issueCount: 0, project: null, latestIssue: null }),
  withTimeout: vi.fn().mockImplementation((promise) => promise),
  sanitizeCacheKeyPart: vi.fn().mockImplementation((v) => v),
  SNAPSHOT_CONCURRENCY: 3,
  SNAPSHOT_PROGRESS_FLUSH_INTERVAL_MS: 60000,
  SNAPSHOT_DB_BATCH_SIZE: 50,
  FIELD_SUMMARY_QUEUE_STALE_AFTER_MS: 10 * 60 * 1000,
  FIELD_SUMMARY_BUILD_STALE_AFTER_MS: 15 * 60 * 1000,
  PROJECT_USAGE_ISSUE_SCAN_PAGE_SIZE: 100,
  PROJECT_USAGE_SCAN_PAGES_PER_JOB: 5,
  BASE_JIRA_REQUEST_INTERVAL_MS: 100,
  BASE_JIRA_CONCURRENCY: 5,
  resetJiraRateLimiterState: vi.fn(),
  resetScanTelemetry: vi.fn(),
  getScanTelemetry: vi.fn().mockReturnValue({ rl429Count: 0, rlRetryCount: 0 }),
}));

vi.mock("./project-store.js", () => ({
  ensureProjectStoreReady: vi.fn().mockResolvedValue(undefined),
  readSnapshotMeta: vi.fn().mockResolvedValue(null),
  writeSnapshotMeta: vi.fn().mockResolvedValue(undefined),
  clearSnapshotVersion: vi.fn().mockResolvedValue(undefined),
  clearOtherSnapshotVersions: vi.fn().mockResolvedValue(undefined),
  appendSnapshotFields: vi.fn().mockResolvedValue(undefined),
  replaceSnapshotProjectUsageForField: vi.fn().mockResolvedValue(undefined),
  loadSnapshotField: vi.fn().mockResolvedValue(null),
  loadSnapshotFields: vi.fn().mockResolvedValue([]),
  updateSnapshotFieldMetadata: vi.fn().mockResolvedValue({ updatedCount: 0 }),
  updateSnapshotFieldFindings: vi.fn().mockResolvedValue({ updatedCount: 0 }),
  loadFieldSummary: vi.fn().mockResolvedValue(null),
  replaceFieldSummary: vi.fn().mockResolvedValue(undefined),
  getSnapshotProcessedFieldIds: vi.fn().mockResolvedValue(new Set()),
  carryForwardSnapshotProjectUsage: vi.fn().mockResolvedValue(undefined),
  restoreSnapshotProjectUsageFromSummaries: vi.fn().mockResolvedValue({ fieldsRestored: 0, rowsInserted: 0 }),
  fillSnapshotProjectUsageFromSummaries: vi.fn().mockResolvedValue({ fieldsRestored: 0, rowsInserted: 0 }),
  replaceFieldOptionsCache: vi.fn().mockResolvedValue({ optionCount: 0 }),
  pruneOldSnapshotVersions: vi.fn().mockResolvedValue({ fieldsDeleted: 0, usageRowsDeleted: 0 }),
  syncActiveProjectCountsFromUsage: vi.fn().mockResolvedValue({ fieldsSynced: 0 }),
  loadFieldLastChangeMap: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("./analysis.js", () => ({
  USAGE_STATUS_READY: "ready",
  USAGE_STATUS_UNAVAILABLE: "unavailable",
  mergeProjectUsageCounts: vi.fn().mockReturnValue([]),
  summarizeProjectUsageCapacity: vi.fn().mockReturnValue({ runningJobCount: 0, runningIssueBudget: 0, runningJobs: [] }),
  normalizeFieldName: vi.fn().mockImplementation((name) => (name || "").toLowerCase().trim()),
  buildGovernanceFindings: vi.fn().mockReturnValue({ reasons: [], tags: {}, priorityScore: 0, adminAttention: false, categories: [] }),
  buildInventoryRecord: vi.fn().mockImplementation((field, metrics) => ({
    id: field.id,
    name: field.name,
    ...metrics,
  })),
  isJiraBuiltinField: vi.fn().mockReturnValue(false),
  isPlatformProvidedField: vi.fn().mockReturnValue(false),
  buildDuplicateNameCountMap: vi.fn().mockReturnValue(new Map()),
  isSelectFieldType: vi.fn().mockReturnValue(false),
}));

vi.mock("./transform.js", () => ({
  buildOverallFieldJql: vi.fn().mockImplementation((id) => `"${id}" is not EMPTY`),
  getFieldNumericId: vi.fn().mockImplementation((id) => {
    const match = String(id || "").match(/customfield_(\d+)/);
    return match ? Number(match[1]) : null;
  }),
  getFieldTypeLabel: vi.fn().mockImplementation((field) => field?.schema?.type || "unknown"),
  buildProjectUsageRecord: vi.fn().mockImplementation(({ project, fieldId, issueCount }) => ({
    projectId: project?.id || "unknown",
    projectKey: project?.key || "unknown",
    projectName: project?.name || "unknown",
    issueCount,
    fieldId,
  })),
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

// ── hydrateFieldForGovernance ─────────────────────────────────────────────────

describe("hydrateFieldForGovernance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a field with governance findings", async () => {
    const { buildGovernanceFindings } = await import("./analysis.js");
    buildGovernanceFindings.mockReturnValue({
      reasons: [{ title: "Orphaned field", category: "cleanup", severity: "medium" }],
      tags: { cleanup: true },
      priorityScore: 25,
      adminAttention: false,
      categories: ["cleanup"],
    });

    const field = { id: "customfield_123", name: "Test Field", configuredProjectCount: 0 };
    const summary = { activeProjectCount: 0, totalIssueCount: 0 };

    const result = hydrateFieldForGovernance(field, summary, 1, {});

    expect(result.findings).toBeDefined();
    expect(result.findings.reasons).toHaveLength(1);
    expect(result.findings.reasons[0].title).toBe("Orphaned field");
  });

  it("derives lastFieldChangeAt from the newest active-project change date", async () => {
    const { buildGovernanceFindings } = await import("./analysis.js");
    const field = { id: "customfield_123", name: "Field" };
    const summary = {
      activeProjectCount: 2,
      totalIssueCount: 100,
      activeProjects: [
        { projectKey: "AAA", latestFieldChangeAt: "2024-01-01T00:00:00.000Z" },
        { projectKey: "BBB", latestFieldChangeAt: "2026-06-01T00:00:00.000Z" },
      ],
    };

    hydrateFieldForGovernance(field, summary);

    expect(buildGovernanceFindings).toHaveBeenCalledWith(
      field,
      expect.objectContaining({ lastFieldChangeAt: "2026-06-01T00:00:00.000Z" }),
      {}
    );
  });

  it("passes lastFieldChangeAt as null when the summary has no project dates", async () => {
    const { buildGovernanceFindings } = await import("./analysis.js");
    const field = { id: "customfield_123", name: "Field" };

    hydrateFieldForGovernance(field, { activeProjectCount: 1, totalIssueCount: 5 });

    expect(buildGovernanceFindings).toHaveBeenCalledWith(
      field,
      expect.objectContaining({ lastFieldChangeAt: null }),
      {}
    );
  });

  it("populates configuredProjectCount from field.configuredProjectCount", () => {
    const field = { id: "customfield_123", name: "Field", configuredProjectCount: 5 };
    const summary = { activeProjectCount: 2, totalIssueCount: 100 };

    const result = hydrateFieldForGovernance(field, summary);

    expect(result.configuredProjectCount).toBe(5);
    expect(result.usageCount).toBe(5);
  });

  it("falls back to field.usageCount when configuredProjectCount is missing", () => {
    const field = { id: "customfield_1", name: "F", usageCount: 3 };
    const result = hydrateFieldForGovernance(field, null);
    expect(result.configuredProjectCount).toBe(3);
  });

  it("handles null summary gracefully without throwing", () => {
    const field = { id: "customfield_999", name: "Empty Field" };
    expect(() => hydrateFieldForGovernance(field, null)).not.toThrow();
    const result = hydrateFieldForGovernance(field, null);
    expect(result.activeProjectCount).toBe(0);
    expect(result.totalIssueCount).toBe(0);
  });

  it("marks system fields (non-customfield_ IDs) correctly", () => {
    const field = { id: "summary", name: "Summary" };
    const result = hydrateFieldForGovernance(field, null);
    expect(result.isSystemField).toBe(true);
  });

  it("marks custom fields correctly", () => {
    const field = { id: "customfield_123", name: "Custom" };
    const result = hydrateFieldForGovernance(field, null);
    expect(result.isSystemField).toBe(false);
  });

  it("passes hasGlobalContext true when summary.hasGlobalContext is set", () => {
    const field = { id: "customfield_1", name: "F" };
    const summary = { hasGlobalContext: true, activeProjectCount: 0, totalIssueCount: 10 };

    hydrateFieldForGovernance(field, summary, 1, {});

    expect(buildGovernanceFindings).toHaveBeenCalledWith(
      field,
      expect.objectContaining({ hasGlobalContext: true }),
      {}
    );
  });

  it("counts contexts from summary.contexts array", () => {
    const field = { id: "customfield_1", name: "F" };
    const summary = {
      contexts: [{ id: "1", isGlobal: false }, { id: "2", isGlobal: false }],
    };

    hydrateFieldForGovernance(field, summary);

    expect(buildGovernanceFindings).toHaveBeenCalledWith(
      field,
      expect.objectContaining({ contextCount: 2 }),
      {}
    );
  });

  it("forwards thresholds to buildGovernanceFindings", () => {
    const field = { id: "customfield_1", name: "F" };
    const thresholds = { highImpactMinProjects: 3 };

    hydrateFieldForGovernance(field, null, 1, thresholds);

    expect(buildGovernanceFindings).toHaveBeenCalledWith(field, expect.any(Object), thresholds);
  });
});

// ── fetchFieldCatalog ─────────────────────────────────────────────────────────

describe("fetchFieldCatalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges custom and system fields, tagging system fields", async () => {
    const jiraApi = await getJiraApiMock();
    jiraApi.getAllCustomFields.mockResolvedValue([{ id: "customfield_1", name: "Custom" }]);
    jiraApi.getAllSystemFields.mockResolvedValue([{ id: "summary", name: "Summary" }]);

    const result = await fetchFieldCatalog();

    expect(result).toEqual([
      { id: "customfield_1", name: "Custom" },
      { id: "summary", name: "Summary", isSystemField: true },
    ]);
  });

  it("tolerates getAllSystemFields rejecting by treating it as no system fields", async () => {
    const jiraApi = await getJiraApiMock();
    jiraApi.getAllCustomFields.mockResolvedValue([{ id: "customfield_1", name: "Custom" }]);
    jiraApi.getAllSystemFields.mockRejectedValue(new Error("boom"));

    const result = await fetchFieldCatalog();

    expect(result).toEqual([{ id: "customfield_1", name: "Custom" }]);
  });
});

// ── syncFieldCatalog ──────────────────────────────────────────────────────────

describe("syncFieldCatalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts newly discovered custom fields as unavailable, pending records with configuredProjectCount looked up", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();
    jiraApi.getAllCustomFields.mockResolvedValue([{ id: "customfield_1", name: "New Field" }]);
    jiraApi.getAllSystemFields.mockResolvedValue([]);
    store.loadSnapshotFields.mockResolvedValue([]);
    jiraApi.getFieldConfiguredProjectCount.mockResolvedValue(3);

    const result = await syncFieldCatalog(INSTALLATION_KEY, "v1");

    expect(result).toEqual({ newFieldCount: 1, changedFieldCount: 0, totalCatalogCount: 1 });
    expect(jiraApi.getFieldConfiguredProjectCount).toHaveBeenCalledWith("customfield_1");
    expect(store.appendSnapshotFields).toHaveBeenCalledWith(
      INSTALLATION_KEY,
      "v1",
      expect.arrayContaining([expect.objectContaining({ usageStatus: "unavailable" })])
    );
    expect(store.updateSnapshotFieldMetadata).not.toHaveBeenCalled();
  });

  it("does not call getFieldConfiguredProjectCount for newly discovered system fields", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();
    jiraApi.getAllCustomFields.mockResolvedValue([]);
    jiraApi.getAllSystemFields.mockResolvedValue([{ id: "summary", name: "Summary" }]);
    store.loadSnapshotFields.mockResolvedValue([]);

    await syncFieldCatalog(INSTALLATION_KEY, "v1");

    expect(jiraApi.getFieldConfiguredProjectCount).not.toHaveBeenCalled();
  });

  it("coerces a -1 (timeout) configuredProjectCount to 0 instead of leaving it negative", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();
    jiraApi.getAllCustomFields.mockResolvedValue([{ id: "customfield_1", name: "New Field" }]);
    jiraApi.getAllSystemFields.mockResolvedValue([]);
    store.loadSnapshotFields.mockResolvedValue([]);
    jiraApi.getFieldConfiguredProjectCount.mockResolvedValue(-1);

    await syncFieldCatalog(INSTALLATION_KEY, "v1");

    const [, , records] = store.appendSnapshotFields.mock.calls[0];
    expect(records[0].configuredProjectCount).toBe(0);
  });

  it("detects a renamed field and updates its metadata without re-fetching configuredProjectCount", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();
    jiraApi.getAllCustomFields.mockResolvedValue([{ id: "customfield_1", name: "Renamed Field" }]);
    jiraApi.getAllSystemFields.mockResolvedValue([]);
    store.loadSnapshotFields.mockResolvedValue([
      { id: "customfield_1", name: "Old Name", description: "", type: "unknown", primitiveType: null, customType: null, searcherKey: null },
    ]);

    const result = await syncFieldCatalog(INSTALLATION_KEY, "v1");

    expect(result.changedFieldCount).toBe(1);
    expect(result.newFieldCount).toBe(0);
    expect(jiraApi.getFieldConfiguredProjectCount).not.toHaveBeenCalled();
    expect(store.updateSnapshotFieldMetadata).toHaveBeenCalledWith(
      INSTALLATION_KEY,
      "v1",
      expect.arrayContaining([expect.objectContaining({ id: "customfield_1", name: "Renamed Field" })])
    );
    expect(store.appendSnapshotFields).not.toHaveBeenCalled();
  });

  it("does nothing when the catalog exactly matches what's already stored", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();
    const existing = { id: "customfield_1", name: "Same", description: "", type: "unknown", primitiveType: "unknown", customType: null, searcherKey: null };
    jiraApi.getAllCustomFields.mockResolvedValue([{ id: "customfield_1", name: "Same" }]);
    jiraApi.getAllSystemFields.mockResolvedValue([]);
    store.loadSnapshotFields.mockResolvedValue([existing]);

    const result = await syncFieldCatalog(INSTALLATION_KEY, "v1");

    expect(result).toEqual({ newFieldCount: 0, changedFieldCount: 0, totalCatalogCount: 1 });
    expect(store.appendSnapshotFields).not.toHaveBeenCalled();
    expect(store.updateSnapshotFieldMetadata).not.toHaveBeenCalled();
  });
});

// ── refreshGovernanceFindingsForFields ────────────────────────────────────────

describe("refreshGovernanceFindingsForFields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns immediately without touching the store when fieldIds is empty", async () => {
    const store = await getProjectStoreMock();

    const result = await refreshGovernanceFindingsForFields(INSTALLATION_KEY, "v1", []);

    expect(result).toEqual({ updatedCount: 0 });
    expect(store.loadSnapshotFields).not.toHaveBeenCalled();
    expect(store.updateSnapshotFieldFindings).not.toHaveBeenCalled();
  });

  it("recomputes findings only for the requested field ids, marked ready", async () => {
    const store = await getProjectStoreMock();
    store.loadSnapshotFields.mockResolvedValue([
      { id: "customfield_1", name: "Touched", configuredProjectCount: 2, totalIssueCount: 10, activeProjectCount: 2 },
      { id: "customfield_2", name: "Untouched", configuredProjectCount: 5, totalIssueCount: 20, activeProjectCount: 5 },
    ]);

    const result = await refreshGovernanceFindingsForFields(INSTALLATION_KEY, "v1", ["customfield_1"]);

    expect(result).toEqual({ updatedCount: 1 });
    expect(store.updateSnapshotFieldFindings).toHaveBeenCalledWith(
      INSTALLATION_KEY,
      "v1",
      [expect.objectContaining({ id: "customfield_1" })]
    );
  });

  it("feeds each field's rolled-up last-change date into its governance findings", async () => {
    const store = await getProjectStoreMock();
    const { buildGovernanceFindings: mockFindings } = await import("./analysis.js");
    store.loadSnapshotFields.mockResolvedValue([
      { id: "customfield_1", name: "Stale", configuredProjectCount: 2, totalIssueCount: 10, activeProjectCount: 2 },
      { id: "customfield_2", name: "NoDate", configuredProjectCount: 1, totalIssueCount: 5, activeProjectCount: 1 },
    ]);
    store.loadFieldLastChangeMap.mockResolvedValue(new Map([["customfield_1", "2023-01-01T00:00:00.000Z"]]));

    await refreshGovernanceFindingsForFields(INSTALLATION_KEY, "v1", ["customfield_1", "customfield_2"]);

    expect(store.loadFieldLastChangeMap).toHaveBeenCalledWith(INSTALLATION_KEY, "v1", ["customfield_1", "customfield_2"]);
    expect(mockFindings).toHaveBeenCalledWith(
      expect.objectContaining({ id: "customfield_1" }),
      expect.objectContaining({ lastFieldChangeAt: "2023-01-01T00:00:00.000Z" })
    );
    // A field with no recorded change date must be passed null, never left undefined —
    // the staleness rule treats null as "unknown" and undefined would read the same,
    // but pinning it keeps the contract explicit.
    expect(mockFindings).toHaveBeenCalledWith(
      expect.objectContaining({ id: "customfield_2" }),
      expect.objectContaining({ lastFieldChangeAt: null })
    );
  });

  it("still recomputes findings when the last-change rollup query fails", async () => {
    const store = await getProjectStoreMock();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    store.loadSnapshotFields.mockResolvedValue([
      { id: "customfield_1", name: "F", configuredProjectCount: 2, totalIssueCount: 10, activeProjectCount: 2 },
    ]);
    store.loadFieldLastChangeMap.mockRejectedValue(new Error("SQL rate limit"));

    const result = await refreshGovernanceFindingsForFields(INSTALLATION_KEY, "v1", ["customfield_1"]);

    expect(result).toEqual({ updatedCount: 1 });
    expect(store.updateSnapshotFieldFindings).toHaveBeenCalled();
  });
});

// ── latestChangeAcrossProjects ────────────────────────────────────────────────

describe("latestChangeAcrossProjects", () => {
  it("returns the newest timestamp across projects", () => {
    expect(latestChangeAcrossProjects([
      { latestFieldChangeAt: "2024-01-01T00:00:00.000Z" },
      { latestFieldChangeAt: "2026-05-05T00:00:00.000Z" },
      { latestFieldChangeAt: "2025-02-02T00:00:00.000Z" },
    ])).toBe("2026-05-05T00:00:00.000Z");
  });

  it("ignores projects with missing or unparseable dates", () => {
    expect(latestChangeAcrossProjects([
      { latestFieldChangeAt: null },
      { latestFieldChangeAt: "nonsense" },
      { latestFieldChangeAt: "2024-03-03T00:00:00.000Z" },
      {},
    ])).toBe("2024-03-03T00:00:00.000Z");
  });

  it("returns null for empty, missing, or all-dateless input", () => {
    expect(latestChangeAcrossProjects([])).toBeNull();
    expect(latestChangeAcrossProjects(undefined)).toBeNull();
    expect(latestChangeAcrossProjects(null)).toBeNull();
    expect(latestChangeAcrossProjects([{ latestFieldChangeAt: null }])).toBeNull();
  });
});

// ── requeueStaleSnapshotBuild ─────────────────────────────────────────────────

describe("requeueStaleSnapshotBuild", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when meta is null (passed directly)", async () => {
    const store = await getProjectStoreMock();
    store.readSnapshotMeta.mockResolvedValue(null);

    const result = await requeueStaleSnapshotBuild(INSTALLATION_KEY, null);

    // null is passed so readSnapshotMeta is called; result should be null
    expect(result).toBeNull();
    const queues = await getQueuesMock();
    expect(queues.inventorySnapshotQueue.push).not.toHaveBeenCalled();
  });

  it("does nothing when state is ready (not stuck)", async () => {
    const queues = await getQueuesMock();
    const meta = { state: "ready", startedAt: new Date().toISOString() };

    await requeueStaleSnapshotBuild(INSTALLATION_KEY, meta);

    expect(queues.inventorySnapshotQueue.push).not.toHaveBeenCalled();
  });

  it("does nothing when state is building but started recently (not stale)", async () => {
    const queues = await getQueuesMock();
    const meta = { state: "building", startedAt: new Date().toISOString() };

    await requeueStaleSnapshotBuild(INSTALLATION_KEY, meta);

    expect(queues.inventorySnapshotQueue.push).not.toHaveBeenCalled();
  });

  it("queues a rebuild when build is stale (started > 20 min ago)", async () => {
    const store = await getProjectStoreMock();
    const queues = await getQueuesMock();

    const staleTime = new Date(Date.now() - 25 * 60 * 1000).toISOString(); // 25 min ago
    const meta = { state: "building", startedAt: staleTime };

    // writeSnapshotMeta saves the new queued state; then readSnapshotMeta returns
    // the new meta with the matching jobToken so it claims the queue
    store.writeSnapshotMeta.mockResolvedValue(undefined);
    store.readSnapshotMeta.mockResolvedValue({
      state: "queued",
      jobToken: "test-token", // matches makeJobToken() mock
    });

    await requeueStaleSnapshotBuild(INSTALLATION_KEY, meta);

    expect(store.writeSnapshotMeta).toHaveBeenCalledWith(
      INSTALLATION_KEY,
      expect.objectContaining({ state: "queued" })
    );
    expect(queues.inventorySnapshotQueue.push).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ jobType: "run-snapshot" }) })
    );
  });

  it("does nothing when building started very recently", async () => {
    const queues = await getQueuesMock();
    const recentTime = new Date(Date.now() - 1 * 60 * 1000).toISOString(); // 1 min ago
    const meta = { state: "building", startedAt: recentTime };

    await requeueStaleSnapshotBuild(INSTALLATION_KEY, meta);

    expect(queues.inventorySnapshotQueue.push).not.toHaveBeenCalled();
  });
});

// ── runSnapshot ───────────────────────────────────────────────────────────────

describe("runSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Use fake timers to prevent setInterval from running during tests
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes building state at the start of a fresh build", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();

    store.readSnapshotMeta.mockResolvedValue(null); // no existing meta
    jiraApi.getAllCustomFields.mockResolvedValue([
      { id: "customfield_1", name: "Field One" },
      { id: "customfield_2", name: "Field Two" },
    ]);
    jiraApi.getAllSystemFields.mockResolvedValue([]);
    jiraApi.getFieldConfiguredProjectCount.mockResolvedValue(0);
    // After writeSnapshotMeta, readSnapshotMeta for race-check should return our version
    store.readSnapshotMeta
      .mockResolvedValueOnce(null) // existingMeta read
      .mockResolvedValue({ buildingVersion: expect.any(String) }); // race-check read

    // Make the race-check pass by using a dynamic implementation
    let capturedVersion = null;
    store.writeSnapshotMeta.mockImplementation(async (_key, data) => {
      if (data.buildingVersion) capturedVersion = data.buildingVersion;
    });
    store.readSnapshotMeta
      .mockResolvedValueOnce(null) // existingMeta
      .mockImplementation(async () => ({ buildingVersion: capturedVersion })); // race check + further reads

    const runPromise = runSnapshot(INSTALLATION_KEY);
    // advance timers to resolve any setInterval
    vi.runAllTimers();
    await runPromise;

    const writeCalls = store.writeSnapshotMeta.mock.calls;
    const buildingCall = writeCalls.find((c) => c[1].state === "building");
    expect(buildingCall).toBeDefined();
    expect(buildingCall[1].startedAt).toBeDefined();
  });

  it("writes ready state with processedFields count after successful build", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();

    const fields = [
      { id: "customfield_1", name: "Field One" },
      { id: "customfield_2", name: "Field Two" },
    ];
    jiraApi.getAllCustomFields.mockResolvedValue(fields);
    jiraApi.getAllSystemFields.mockResolvedValue([]);
    jiraApi.getFieldConfiguredProjectCount.mockResolvedValue(0);
    jiraApi.getFieldTotalIssueCount.mockResolvedValue(0);

    let capturedVersion = null;
    store.writeSnapshotMeta.mockImplementation(async (_key, data) => {
      if (data.buildingVersion) capturedVersion = data.buildingVersion;
    });
    store.readSnapshotMeta
      .mockResolvedValueOnce(null)
      .mockImplementation(async () => ({ buildingVersion: capturedVersion }));

    const runPromise = runSnapshot(INSTALLATION_KEY);
    vi.runAllTimers();
    await runPromise;

    const writeCalls = store.writeSnapshotMeta.mock.calls;
    const readyCall = writeCalls.find((c) => c[1].state === "ready");
    expect(readyCall).toBeDefined();
    expect(readyCall[1].processedFields).toBe(2);
    expect(readyCall[1].totalFields).toBe(2);
  });

  it("writes ready state with processedFields 0 when no fields exist", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();

    jiraApi.getAllCustomFields.mockResolvedValue([]);
    jiraApi.getAllSystemFields.mockResolvedValue([]);

    let capturedVersion = null;
    store.writeSnapshotMeta.mockImplementation(async (_key, data) => {
      if (data.buildingVersion) capturedVersion = data.buildingVersion;
    });
    store.readSnapshotMeta
      .mockResolvedValueOnce(null)
      .mockImplementation(async () => ({ buildingVersion: capturedVersion }));

    const runPromise = runSnapshot(INSTALLATION_KEY);
    vi.runAllTimers();
    await runPromise;

    const writeCalls = store.writeSnapshotMeta.mock.calls;
    const readyCall = writeCalls.find((c) => c[1].state === "ready");
    expect(readyCall).toBeDefined();
    expect(readyCall[1].processedFields).toBe(0);
  });

  it("skips when a fresh build is already in progress (not stale)", async () => {
    const store = await getProjectStoreMock();

    // Existing building meta with a recent startedAt
    const recentStart = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    store.readSnapshotMeta.mockResolvedValue({
      state: "building",
      startedAt: recentStart,
      buildingVersion: "v-existing",
    });

    const runPromise = runSnapshot(INSTALLATION_KEY);
    vi.runAllTimers();
    await runPromise;

    // writeSnapshotMeta should NOT have been called (we exit early)
    expect(store.writeSnapshotMeta).not.toHaveBeenCalled();
  });

  // Regression test: requeueStaleSnapshotBuild (invoked via getFieldInventory's
  // force-refresh path) flips a stuck build's state from "building" to "queued" as a
  // hand-off signal to the next consumer invocation, while preserving buildingVersion via
  // a patch-merge write. A prior bug only checked for state === "building" when deciding
  // whether to resume, so a re-queued build silently started a brand-new version from
  // scratch and discarded every field already completed ("Force resume" restarting from 0
  // instead of continuing from checkpoint).
  it("resumes from checkpoint when re-queued (state 'queued' with a preserved buildingVersion)", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();

    const startedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    store.readSnapshotMeta.mockResolvedValue({
      state: "queued",
      startedAt,
      buildingVersion: "v-existing",
      processedFields: 818,
      progressLog: [{ t: startedAt, msg: "Resuming — 818 of 1516 fields already done" }],
    });
    store.getSnapshotProcessedFieldIds.mockResolvedValue(new Set(["customfield_1"]));
    jiraApi.getAllCustomFields.mockResolvedValue([
      { id: "customfield_1", name: "Already Done" },
      { id: "customfield_2", name: "Still To Do" },
    ]);
    jiraApi.getAllSystemFields.mockResolvedValue([]);
    jiraApi.getFieldConfiguredProjectCount.mockResolvedValue(0);

    const runPromise = runSnapshot(INSTALLATION_KEY);
    vi.runAllTimers();
    await runPromise;

    // Must NOT start a fresh version — that would wipe the in-progress build's data
    expect(store.clearSnapshotVersion).not.toHaveBeenCalled();

    const writeCalls = store.writeSnapshotMeta.mock.calls;
    const buildingCall = writeCalls.find((c) => c[1].state === "building");
    expect(buildingCall).toBeDefined();
    expect(buildingCall[1].buildingVersion).toBe("v-existing");
    // Resumed from the checkpoint count, not reset to 0
    expect(buildingCall[1].processedFields).toBe(818);
  });

  it("exits cleanly when it loses the startup race", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();

    jiraApi.getAllCustomFields.mockResolvedValue([]);
    jiraApi.getAllSystemFields.mockResolvedValue([]);

    store.readSnapshotMeta
      .mockResolvedValueOnce(null) // existingMeta
      .mockResolvedValue({ buildingVersion: "v-other" }); // race-check: different version wins

    const runPromise = runSnapshot(INSTALLATION_KEY);
    vi.runAllTimers();
    await runPromise;

    // Should have written building state but then exited without writing ready/failed
    const writeCalls = store.writeSnapshotMeta.mock.calls;
    const readyOrFailed = writeCalls.filter(
      (c) => c[1].state === "ready" || c[1].state === "failed"
    );
    expect(readyOrFailed).toHaveLength(0);
  });

  it("keeps building state (not failed) when processing throws mid-run", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();

    jiraApi.getAllCustomFields.mockRejectedValue(new Error("Jira API failure"));

    let capturedVersion = null;
    store.writeSnapshotMeta.mockImplementation(async (_key, data) => {
      if (data.buildingVersion) capturedVersion = data.buildingVersion;
    });
    store.readSnapshotMeta
      .mockResolvedValueOnce(null)
      .mockImplementation(async () => ({ buildingVersion: capturedVersion }));

    const runPromise = runSnapshot(INSTALLATION_KEY);
    vi.runAllTimers();
    await runPromise;

    const writeCalls = store.writeSnapshotMeta.mock.calls;
    // On non-cancel errors it keeps state as "building" (not "failed") to allow stale-build recovery
    const finalStateCall = writeCalls[writeCalls.length - 1];
    expect(finalStateCall[1].state).toBe("building");
    expect(finalStateCall[1].lastError).toContain("Jira API failure");
  });

  it("calls clearOtherSnapshotVersions after successful processing", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();

    jiraApi.getAllCustomFields.mockResolvedValue([]);
    jiraApi.getAllSystemFields.mockResolvedValue([]);

    let capturedVersion = null;
    store.writeSnapshotMeta.mockImplementation(async (_key, data) => {
      if (data.buildingVersion) capturedVersion = data.buildingVersion;
    });
    store.readSnapshotMeta
      .mockResolvedValueOnce(null)
      .mockImplementation(async () => ({ buildingVersion: capturedVersion }));

    const runPromise = runSnapshot(INSTALLATION_KEY);
    vi.runAllTimers();
    await runPromise;

    expect(store.clearOtherSnapshotVersions).toHaveBeenCalled();
  });

  it("marks a field usageStatus unavailable (not a false zero) when the project-count query times out", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();

    jiraApi.getAllCustomFields.mockResolvedValue([
      { id: "customfield_1", name: "Field One" },
    ]);
    jiraApi.getAllSystemFields.mockResolvedValue([]);
    // -1 is the "timed out / unavailable" sentinel, distinct from a genuine 0
    jiraApi.getFieldConfiguredProjectCount.mockResolvedValue(-1);

    let capturedVersion = null;
    store.writeSnapshotMeta.mockImplementation(async (_key, data) => {
      if (data.buildingVersion) capturedVersion = data.buildingVersion;
    });
    store.readSnapshotMeta
      .mockResolvedValueOnce(null)
      .mockImplementation(async () => ({ buildingVersion: capturedVersion }));

    const runPromise = runSnapshot(INSTALLATION_KEY);
    vi.runAllTimers();
    await runPromise;

    const appendCalls = store.appendSnapshotFields.mock.calls;
    const record = appendCalls.flatMap((c) => c[2]).find((r) => r.id === "customfield_1");
    expect(record.usageStatus).toBe("unavailable");
    expect(record.totalIssueCount).toBe(0);
    expect(record.configuredProjectCount).toBe(0);
    // getFieldTotalIssueCount must not be called once the project-count lookup is unknown —
    // we can't trust an issue count scoped to an unknown set of projects.
    expect(jiraApi.getFieldTotalIssueCount).not.toHaveBeenCalled();
  });

  it("marks a field usageStatus unavailable when the issue-count query times out", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();

    jiraApi.getAllCustomFields.mockResolvedValue([
      { id: "customfield_1", name: "Field One" },
    ]);
    jiraApi.getAllSystemFields.mockResolvedValue([]);
    jiraApi.getFieldConfiguredProjectCount.mockResolvedValue(3);
    jiraApi.getFieldTotalIssueCount.mockResolvedValue(-1);

    let capturedVersion = null;
    store.writeSnapshotMeta.mockImplementation(async (_key, data) => {
      if (data.buildingVersion) capturedVersion = data.buildingVersion;
    });
    store.readSnapshotMeta
      .mockResolvedValueOnce(null)
      .mockImplementation(async () => ({ buildingVersion: capturedVersion }));

    const runPromise = runSnapshot(INSTALLATION_KEY);
    vi.runAllTimers();
    await runPromise;

    const appendCalls = store.appendSnapshotFields.mock.calls;
    const record = appendCalls.flatMap((c) => c[2]).find((r) => r.id === "customfield_1");
    expect(record.usageStatus).toBe("unavailable");
    expect(record.totalIssueCount).toBe(0);
  });

  it("marks a genuine zero-usage field as ready, not unavailable", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();

    jiraApi.getAllCustomFields.mockResolvedValue([
      { id: "customfield_1", name: "Field One" },
    ]);
    jiraApi.getAllSystemFields.mockResolvedValue([]);
    jiraApi.getFieldConfiguredProjectCount.mockResolvedValue(0);

    let capturedVersion = null;
    store.writeSnapshotMeta.mockImplementation(async (_key, data) => {
      if (data.buildingVersion) capturedVersion = data.buildingVersion;
    });
    store.readSnapshotMeta
      .mockResolvedValueOnce(null)
      .mockImplementation(async () => ({ buildingVersion: capturedVersion }));

    const runPromise = runSnapshot(INSTALLATION_KEY);
    vi.runAllTimers();
    await runPromise;

    const appendCalls = store.appendSnapshotFields.mock.calls;
    const record = appendCalls.flatMap((c) => c[2]).find((r) => r.id === "customfield_1");
    expect(record.usageStatus).toBe("ready");
    expect(record.totalIssueCount).toBe(0);
    expect(record.configuredProjectCount).toBe(0);
  });

  it("calls carryForwardSnapshotProjectUsage before clearing old versions", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();

    jiraApi.getAllCustomFields.mockResolvedValue([]);
    jiraApi.getAllSystemFields.mockResolvedValue([]);

    let capturedVersion = null;
    store.writeSnapshotMeta.mockImplementation(async (_key, data) => {
      if (data.buildingVersion) capturedVersion = data.buildingVersion;
    });
    store.readSnapshotMeta
      .mockResolvedValueOnce(null)
      .mockImplementation(async () => ({ buildingVersion: capturedVersion }));

    const runPromise = runSnapshot(INSTALLATION_KEY);
    vi.runAllTimers();
    await runPromise;

    expect(store.carryForwardSnapshotProjectUsage).toHaveBeenCalled();
    // carryForward should be called before clearOtherSnapshotVersions
    const carryCallIndex = store.carryForwardSnapshotProjectUsage.mock.invocationCallOrder[0];
    const clearCallIndex = store.clearOtherSnapshotVersions.mock.invocationCallOrder[0];
    expect(carryCallIndex).toBeLessThan(clearCallIndex);
  });

  // Regression test: every field record is written with active_project_count hardcoded to
  // 0 (see the field-processing loop above); carryForwardSnapshotProjectUsage and
  // fillSnapshotProjectUsageFromSummaries restore the real per-project rows for the new
  // version but never touch that summary column themselves, so without this sync call the
  // list view (getFieldInventory) permanently disagrees with the live per-field detail view
  // (getFieldDetails, which computes activeProjectCount fresh from snapshot_project_usage)
  // until the next Universal Scan happens to touch that exact field.
  it("syncs active project counts from usage after both carry-forward/fill steps complete", async () => {
    const store = await getProjectStoreMock();
    const jiraApi = await getJiraApiMock();

    jiraApi.getAllCustomFields.mockResolvedValue([]);
    jiraApi.getAllSystemFields.mockResolvedValue([]);
    store.syncActiveProjectCountsFromUsage.mockResolvedValue({ fieldsSynced: 3 });

    let capturedVersion = null;
    store.writeSnapshotMeta.mockImplementation(async (_key, data) => {
      if (data.buildingVersion) capturedVersion = data.buildingVersion;
    });
    store.readSnapshotMeta
      .mockResolvedValueOnce(null)
      .mockImplementation(async () => ({ buildingVersion: capturedVersion }));

    const runPromise = runSnapshot(INSTALLATION_KEY);
    vi.runAllTimers();
    await runPromise;

    expect(store.syncActiveProjectCountsFromUsage).toHaveBeenCalledWith(INSTALLATION_KEY, expect.any(String));
    const carryCallIndex = store.carryForwardSnapshotProjectUsage.mock.invocationCallOrder[0];
    const fillCallIndex = store.fillSnapshotProjectUsageFromSummaries.mock.invocationCallOrder[0];
    const syncCallIndex = store.syncActiveProjectCountsFromUsage.mock.invocationCallOrder[0];
    expect(syncCallIndex).toBeGreaterThan(carryCallIndex);
    expect(syncCallIndex).toBeGreaterThan(fillCallIndex);
  });
});

// ── queueSnapshotBuild ────────────────────────────────────────────────────────

describe("queueSnapshotBuild", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pushes a run-snapshot job to the queue", async () => {
    const queues = await getQueuesMock();

    await queueSnapshotBuild(INSTALLATION_KEY);

    expect(queues.inventorySnapshotQueue.push).toHaveBeenCalledWith({
      body: { jobType: "run-snapshot", installationKey: INSTALLATION_KEY },
    });
  });
});

// ── tryQueueFieldSummaryBuild ─────────────────────────────────────────────────

describe("tryQueueFieldSummaryBuild", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns invalid-payload when required params missing", async () => {
    const result = await tryQueueFieldSummaryBuild(null, null, null, null);
    expect(result).toEqual({ queued: false, reason: "invalid-payload" });
  });

  it("returns queued: true when push succeeds", async () => {
    const queues = await getQueuesMock();
    queues.inventorySnapshotQueue.push.mockResolvedValue({});

    const result = await tryQueueFieldSummaryBuild(
      INSTALLATION_KEY,
      "v1",
      "customfield_1",
      "tok-1"
    );
    expect(result).toEqual({ queued: true });
  });

  it("returns queue-backpressure reason when push throws too-many-requests error", async () => {
    const queues = await getQueuesMock();
    queues.inventorySnapshotQueue.push.mockRejectedValue(
      new Error("Too Many Requests: queue limit exceeded")
    );

    const result = await tryQueueFieldSummaryBuild(
      INSTALLATION_KEY,
      "v1",
      "customfield_1",
      "tok-1"
    );
    expect(result.queued).toBe(false);
    expect(result.reason).toBe("queue-backpressure");
  });

  it("re-throws unexpected errors that are not backpressure", async () => {
    const queues = await getQueuesMock();
    queues.inventorySnapshotQueue.push.mockRejectedValue(new Error("Network failure"));

    await expect(
      tryQueueFieldSummaryBuild(INSTALLATION_KEY, "v1", "customfield_1", "tok-1")
    ).rejects.toThrow("Network failure");
  });
});

// ── queueFieldSummaryContinuationWithRetry ────────────────────────────────────

describe("queueFieldSummaryContinuationWithRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns queued: true on first successful attempt", async () => {
    const queues = await getQueuesMock();
    queues.inventorySnapshotQueue.push.mockResolvedValue({});

    const result = await queueFieldSummaryContinuationWithRetry(
      INSTALLATION_KEY,
      "v1",
      "customfield_1",
      "tok-1"
    );
    expect(result.queued).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it("retries on backpressure and returns queued: true when retry succeeds", async () => {
    const queues = await getQueuesMock();
    const jiraApi = await getJiraApiMock();

    queues.inventorySnapshotQueue.push
      .mockRejectedValueOnce(new Error("Too Many Requests"))
      .mockResolvedValue({});

    const result = await queueFieldSummaryContinuationWithRetry(
      INSTALLATION_KEY,
      "v1",
      "customfield_1",
      "tok-1"
    );
    expect(result.queued).toBe(true);
    expect(result.attempts).toBe(2);
    expect(jiraApi.sleep).toHaveBeenCalled();
  });

  it("exhausts retries and returns queued: false", async () => {
    const queues = await getQueuesMock();
    queues.inventorySnapshotQueue.push.mockRejectedValue(
      new Error("Too Many Requests: backpressure")
    );

    const result = await queueFieldSummaryContinuationWithRetry(
      INSTALLATION_KEY,
      "v1",
      "customfield_1",
      "tok-1"
    );
    expect(result.queued).toBe(false);
    expect(result.reason).toBe("queue-backpressure");
  });
});
