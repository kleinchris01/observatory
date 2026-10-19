import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks } from "./test-harness.js";
import { SHARED_RESOLVER_FUNCTIONS, __RAW_ADMIN_ONLY_FUNCTIONS } from "../resolvers.js";

const { getRqtIndex, searchRqtValue } = { ...SHARED_RESOLVER_FUNCTIONS, ...__RAW_ADMIN_ONLY_FUNCTIONS };

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// RQT (required-query-token) index -- governance analytics surface.
// ---------------------------------------------------------------------------
describe("getRqtIndex", () => {
  test("aggregates totals and enriches field names from the live snapshot", async () => {
    mocks.loadRqtFieldIndex.mockResolvedValue([
      { fieldId: "customfield_1", issueCount: 10, sampleValues: ["A", "B"], refreshedAt: "2026-01-01T00:00:00Z" },
    ]);
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1 });
    mocks.loadRqtIssueKeys.mockResolvedValue([{ projectId: "10", total: 5 }]);
    mocks.loadRqtValueFrequency.mockResolvedValue([]);
    mocks.loadIssueRqtValues.mockResolvedValue([]);
    mocks.loadRqtFieldIssueIndex.mockResolvedValue([]);
    mocks.loadSnapshotFields.mockResolvedValue([{ id: "customfield_1", name: "Real Field Name" }]);

    const result = await getRqtIndex({ context: {} });

    expect(result.fields[0].fieldName).toBe("Real Field Name"); // enriched from snapshot
    expect(result.totalIssues).toBe(10);
    expect(result.totalUniqueIssues).toBe(5);
    expect(result.uniqueValues).toEqual(["A", "B"]);
  });

  test("still returns a full shape (without name enrichment) when there's no snapshot yet", async () => {
    mocks.loadRqtFieldIndex.mockResolvedValue([
      { fieldId: "customfield_1", issueCount: 3, sampleValues: [], refreshedAt: null },
    ]);
    mocks.readSnapshotMeta.mockResolvedValue(null);
    mocks.loadRqtIssueKeys.mockResolvedValue([]);
    mocks.loadRqtValueFrequency.mockResolvedValue([]);
    mocks.loadIssueRqtValues.mockResolvedValue([]);
    mocks.loadRqtFieldIssueIndex.mockResolvedValue([]);

    const result = await getRqtIndex({ context: {} });

    expect(result.fieldCount).toBe(1);
    expect(mocks.loadSnapshotFields).not.toHaveBeenCalled();
  });
});

describe("searchRqtValue", () => {
  test("returns an empty list without querying storage when rqtValue is blank", async () => {
    const result = await searchRqtValue({ payload: {}, context: {} });
    expect(result).toEqual({ issueKeys: [] });
    expect(mocks.searchRqtValueIssueKeys).not.toHaveBeenCalled();
  });

  test("normalizes the search value to uppercase before searching", async () => {
    mocks.searchRqtValueIssueKeys.mockResolvedValue(["ABC-1", "ABC-2"]);
    const result = await searchRqtValue({ payload: { rqtValue: "req-42" }, context: {} });
    expect(mocks.searchRqtValueIssueKeys).toHaveBeenCalledWith("test-install", "REQ-42");
    expect(result.issueKeys).toEqual(["ABC-1", "ABC-2"]);
  });
});
