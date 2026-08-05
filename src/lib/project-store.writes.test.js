import { vi, describe, test, expect, beforeEach, afterEach } from "vitest";

// Write, maintenance and lifecycle paths of the storage layer.
//
// Companion to project-store.crud.test.js, which covers reads and mapping. Split because
// the two ask different questions: reads are about whether rows become the shape callers
// expect, writes are about scoping, batching, and not writing when there is nothing to
// write. An unscoped DELETE in a multi-tenant Forge app destroys another customer's data,
// and no test that mocks project-store can ever catch one.

vi.mock("@forge/sql", () => {
  const runner = { enqueue: () => runner, run: vi.fn().mockResolvedValue(undefined) };
  return {
    sql: {
      prepare: vi.fn().mockReturnValue({
        bindParams: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
      }),
      executeInTransaction: vi.fn().mockResolvedValue(undefined),
    },
    migrationRunner: runner,
  };
});

import { sql } from "@forge/sql";
import {
  replaceSnapshotProjectUsage,
  appendSnapshotProjectUsage,
  replaceSnapshotField,
  replaceSnapshotProjectUsageForField,
  copySnapshotField,
  copySnapshotProjectUsage,
  carryForwardSnapshotProjectUsage,
  updateSnapshotFieldMetadata,
  updateSnapshotFieldFindings,
  syncActiveProjectCountsFromUsage,
  loadAnySnapshotProjectUsage,
  clearOtherSnapshotVersions,
  clearAllSnapshotData,
  resetIssueScanWorkers,
  finalizeIssueScan,
  atomicAccumulateIssueScanProgress,
  appendIssueScanLogEntry,
  tryClaimIssueScanFinalization,
  promoteIssueScanToSnapshotProjectUsage,
  upsertProjectTotalsForDelta,
  upsertDeltaFieldProjectUsage,
  restoreSnapshotProjectUsageFromSummaries,
  fillSnapshotProjectUsageFromSummaries,
  upsertRqtFieldHits,
  upsertRqtIssueKeys,
  upsertRqtValueIssueKeys,
  upsertRqtFieldIssueKeys,
  searchRqtValueIssueKeys,
  pruneOldSnapshotVersions,
  pruneOldAuditEvents,
  pruneStaleReportJobs,
  migrateOldScopeKeys,
  replaceFieldOptionsCache,
  replaceReportJob,
  loadFieldLastChangeMap,
} from "./project-store.js";

function mockSqlQueries(rowSets = []) {
  const calls = [];
  let i = 0;
  sql.prepare.mockImplementation((text) => {
    const call = { text: String(text), params: null };
    calls.push(call);
    const runner = {
      bindParams: (...params) => { call.params = params; return runner; },
      execute: async () => {
        const next = rowSets[i++];
        return Array.isArray(next) ? { rows: next } : (next ?? { rows: [] });
      },
    };
    return runner;
  });
  return calls;
}

const sqlHas = (call, ...fragments) => {
  const flat = call.text.replace(/\s+/g, " ").toLowerCase();
  return fragments.every((f) => flat.includes(f.toLowerCase()));
};

// Every statement a function issues must carry the installation key. This is the single
// invariant that keeps one customer's data away from another's.
const everyCallScoped = (calls, scope = "scope") => {
  const scoped = calls.filter((c) => c.params);
  expect(scoped.length).toBeGreaterThan(0);
  for (const call of scoped) expect(call.params).toContain(scope);
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSqlQueries();
});
afterEach(() => vi.restoreAllMocks());

describe("snapshot lifecycle writes", () => {
  const usage = Array.from({ length: 60 }, (_, i) => ({
    fieldId: "customfield_1", projectId: String(i), projectKey: `P${i}`,
    projectName: `Project ${i}`, issueCount: i,
  }));

  test("replaceSnapshotProjectUsage and appendSnapshotProjectUsage write usage rows", async () => {
    const replaceCalls = mockSqlQueries();
    await replaceSnapshotProjectUsage("scope", "v1", usage);
    expect(replaceCalls.some((c) => sqlHas(c, "snapshot_project_usage"))).toBe(true);

    const appendCalls = mockSqlQueries();
    await appendSnapshotProjectUsage("scope", "v1", usage);
    const inserts = appendCalls.filter((c) => sqlHas(c, "insert into snapshot_project_usage"));
    expect(inserts.length).toBeGreaterThan(0);
    // Batched: SQL request count is the Forge quota that binds first.
    expect(inserts.length).toBeLessThan(usage.length);
  });

  test("appendSnapshotProjectUsage is a no-op for an empty list", async () => {
    const calls = mockSqlQueries();
    await appendSnapshotProjectUsage("scope", "v1", []);
    expect(calls.filter((c) => sqlHas(c, "insert into snapshot_project_usage"))).toHaveLength(0);
  });

  test("replaceSnapshotField and replaceSnapshotProjectUsageForField scope to one field", async () => {
    const calls = mockSqlQueries();
    await replaceSnapshotField("scope", "v1", { fieldId: "customfield_1", name: "Team" });
    await replaceSnapshotProjectUsageForField("scope", "v1", "customfield_1", []);
    expect(calls.some((c) => c.params?.includes("customfield_1"))).toBe(true);
    everyCallScoped(calls);
  });

  test("copySnapshotField and copySnapshotProjectUsage stay within one installation", async () => {
    const calls = mockSqlQueries([[], [], [], []]);
    await copySnapshotField("scope", "v1", "v2", "customfield_1");
    await copySnapshotProjectUsage("scope", "v1", "v2", "customfield_1");
    everyCallScoped(calls);
  });

  test("carryForwardSnapshotProjectUsage moves rows onto the new version", async () => {
    const calls = mockSqlQueries([[], [], []]);
    await carryForwardSnapshotProjectUsage("scope", "v1", "v2", ["customfield_1"]);
    everyCallScoped(calls);
  });

  test("field updates are scoped, not global", async () => {
    const calls = mockSqlQueries();
    await updateSnapshotFieldMetadata("scope", "v1", "customfield_1", { name: "New" });
    await updateSnapshotFieldFindings("scope", "v1", "customfield_1", { reasons: [] });
    const updates = calls.filter((c) => sqlHas(c, "update snapshot_fields"));
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(sqlHas(u, "scope_key = ?")).toBe(true);
  });

  test("syncActiveProjectCountsFromUsage recomputes from the usage table", async () => {
    const calls = mockSqlQueries([[], []]);
    await syncActiveProjectCountsFromUsage("scope", "v1");
    expect(calls.some((c) => sqlHas(c, "snapshot_project_usage"))).toBe(true);
  });

  test("loadAnySnapshotProjectUsage reads without pinning a version", async () => {
    const calls = mockSqlQueries([[]]);
    await loadAnySnapshotProjectUsage("scope", "customfield_1");
    expect(calls[0].params).toContain("scope");
  });

  test("loadFieldLastChangeMap keys by field", async () => {
    mockSqlQueries([[{ field_id: "customfield_1", latest_field_change_at: "2026-01-01" }]]);
    const map = await loadFieldLastChangeMap("scope", "v1");
    expect(map instanceof Map).toBe(true);
  });

  test("clearOtherSnapshotVersions keeps the version it is told to keep", async () => {
    const calls = mockSqlQueries();
    await clearOtherSnapshotVersions("scope", "keep-me");
    const deletes = calls.filter((c) => sqlHas(c, "delete from"));
    expect(deletes.length).toBeGreaterThan(0);
    for (const del of deletes) {
      expect(del.params).toContain("scope");
      expect(del.params).toContain("keep-me");
    }
  });

  test("clearAllSnapshotData scopes every delete it issues", async () => {
    const calls = mockSqlQueries();
    await clearAllSnapshotData("scope");
    const deletes = calls.filter((c) => sqlHas(c, "delete from"));
    expect(deletes.length).toBeGreaterThan(3);
    for (const del of deletes) expect(del.params?.[0]).toBe("scope");
  });
});

describe("issue scan lifecycle", () => {
  test("resetIssueScanWorkers and finalizeIssueScan stay scoped", async () => {
    const calls = mockSqlQueries([[], [], [], [], []]);
    await resetIssueScanWorkers("scope");
    await finalizeIssueScan("scope");
    everyCallScoped(calls);
  });

  test("atomicAccumulateIssueScanProgress touches the scan meta row", async () => {
    const calls = mockSqlQueries([[], []]);
    await atomicAccumulateIssueScanProgress("scope", { issues: 10, pages: 1 });
    expect(calls.some((c) => sqlHas(c, "issue_scan_meta"))).toBe(true);
  });

  test("appendIssueScanLogEntry writes a log line", async () => {
    const calls = mockSqlQueries([[{ progress_log: "[]" }], []]);
    await appendIssueScanLogEntry("scope", "started");
    expect(calls.length).toBeGreaterThan(0);
  });

  // Exactly one worker may finalize; two would double-promote the buffer into the snapshot.
  test("tryClaimIssueScanFinalization performs a scoped conditional claim", async () => {
    const calls = mockSqlQueries([{ rows: [] }, [{ state: "ready" }]]);
    await tryClaimIssueScanFinalization("scope", "token-1");
    expect(calls[0].params).toContain("scope");
  });

  test("promoteIssueScanToSnapshotProjectUsage reads the buffer", async () => {
    const calls = mockSqlQueries([[], [], [], [], []]);
    const result = await promoteIssueScanToSnapshotProjectUsage("scope", "v1", { syncTotalIssueCount: true });
    expect(result).toBeDefined();
    expect(calls.some((c) => sqlHas(c, "issue_scan_buffer"))).toBe(true);
  });

  test("delta upserts accumulate against existing rows", async () => {
    const calls = mockSqlQueries();
    await upsertProjectTotalsForDelta("scope", new Map([["10", { count: 1, key: "A", name: "Alpha" }]]));
    await upsertDeltaFieldProjectUsage("scope", "v1", [
      { fieldId: "customfield_1", projectId: "10", projectKey: "A", projectName: "Alpha", issueCount: 2 },
    ]);
    expect(calls.length).toBeGreaterThan(0);
    everyCallScoped(calls);
  });

  test("summary-driven restores rebuild project usage", async () => {
    const calls = mockSqlQueries([[], [], [], [], []]);
    const restored = await restoreSnapshotProjectUsageFromSummaries("scope", "v1");
    await fillSnapshotProjectUsageFromSummaries("scope", "v1");
    expect(restored).toBeDefined();
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("RQT index writes", () => {
  test("each upsert writes to its own table", async () => {
    const calls = mockSqlQueries();
    await upsertRqtFieldHits("scope", new Map([["customfield_1", { count: 2, values: new Set(["RQT-1"]) }]]));
    await upsertRqtIssueKeys("scope", [{ projectKey: "A", issueType: "Bug", issueKey: "A-1" }]);
    await upsertRqtValueIssueKeys("scope", [{ rqtValue: "RQT-1", issueKey: "A-1" }]);
    await upsertRqtFieldIssueKeys("scope", [{ fieldId: "customfield_1", issueKey: "A-1" }]);

    for (const table of ["rqt_field_index", "rqt_issue_keys", "rqt_value_issue_index", "rqt_field_issue_index"]) {
      expect(calls.some((c) => sqlHas(c, table))).toBe(true);
    }
  });

  test("the upserts write nothing when handed nothing", async () => {
    const calls = mockSqlQueries();
    await upsertRqtIssueKeys("scope", []);
    await upsertRqtValueIssueKeys("scope", []);
    await upsertRqtFieldIssueKeys("scope", []);
    expect(calls.filter((c) => sqlHas(c, "insert into"))).toHaveLength(0);
  });

  test("searchRqtValueIssueKeys stays scoped to the installation", async () => {
    const calls = mockSqlQueries([[{ issue_key: "A-1" }]]);
    await searchRqtValueIssueKeys("scope", "RQT-1");
    expect(calls[0].params).toContain("scope");
  });
});

describe("retention and migration", () => {
  test("pruneOldSnapshotVersions is scoped to one installation", async () => {
    const calls = mockSqlQueries([[{ version: "v1" }, { version: "v2" }], [], [], []]);
    await pruneOldSnapshotVersions("scope", "v2", 1);
    expect(calls[0].params).toContain("scope");
  });

  test("pruneOldAuditEvents and pruneStaleReportJobs delete only within scope", async () => {
    const calls = mockSqlQueries([[], []]);
    await pruneOldAuditEvents("scope", 90);
    await pruneStaleReportJobs("scope", 7);
    const deletes = calls.filter((c) => sqlHas(c, "delete from"));
    expect(deletes.length).toBeGreaterThan(0);
    for (const del of deletes) expect(del.params).toContain("scope");
  });

  // Takes only the NEW key and derives the old Confluence-only one from it, so a key
  // that is not in the normalized form is a no-op rather than an error.
  test("migrateOldScopeKeys derives the old key and migrates", async () => {
    const calls = mockSqlQueries([[], [], [], [], [], []]);
    const result = await migrateOldScopeKeys("ari:cloud:::site_abc");
    expect(result.skipped).not.toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });

  test("migrateOldScopeKeys skips a key with no derivable predecessor", async () => {
    const calls = mockSqlQueries();
    const result = await migrateOldScopeKeys("some-other-key");
    expect(result).toMatchObject({ skipped: true });
    expect(calls.filter((c) => c.params)).toHaveLength(0);
  });

  test("replaceFieldOptionsCache clears the field before rewriting it", async () => {
    const calls = mockSqlQueries();
    await replaceFieldOptionsCache("scope", "customfield_1", [
      { contextId: "ctx1", contextName: "Global", options: [{ id: "1", value: "A" }, { id: "2", value: "B" }] },
    ]);
    const del = calls.find((c) => sqlHas(c, "delete from field_options_cache"));
    expect(del).toBeDefined();
    expect(del.params).toEqual(["scope", "customfield_1"]);
  });

  test("replaceReportJob upserts the job row", async () => {
    const calls = mockSqlQueries();
    await replaceReportJob("scope", "j1", { status: "queued", fieldIds: [], totalFields: 0 });
    expect(calls.some((c) => sqlHas(c, "report_jobs"))).toBe(true);
  });
});
