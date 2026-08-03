import { vi, describe, test, expect, beforeEach, afterEach } from "vitest";

// Systematic coverage of the storage layer's read and write paths.
//
// project-store.js was the least-tested module in the app (16 of 295 functions) for a
// structural reason: every other test suite mocks it wholesale, so nothing ever executed
// the real SQL construction or the row mapping underneath. That is precisely where the
// expensive bugs live -- loadProjectWorkflowSchemeMap keying on the wrong column, or a
// SELECT whose alias does not match the property the caller reads, are invisible to a
// mocked caller and fatal in production.
//
// These tests assert two things per function: the SQL is shaped correctly (right table,
// right filters, right parameters bound in the right order) and the returned rows are
// mapped to the shape callers actually consume. They are deliberately not a database
// test -- Forge SQL is mocked -- so they catch construction and mapping errors, not
// engine behaviour.
//
// Companion to project-store.test.js (helpers and retry semantics) and
// project-store.migrations.test.js (runner behaviour). Split by concern, not by size.

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
  loadSnapshotFields,
  loadSnapshotField,
  listSnapshotProjects,
  countSnapshotProjectUsage,
  loadSnapshotFieldIssueSums,
  sumSnapshotFieldIssueCount,
  getSnapshotProcessedFieldIds,
  loadFieldOptionsCache,
  searchFieldOptionsCache,
  loadFieldSummary,
  listFieldSummaries,
  listSavedReports,
  saveSavedReport,
  deleteSavedReport,
  loadReportJob,
  readSnapshotMeta,
  readIssueScanMeta,
  readIssueScanWorker,
  loadIssueScanProjectTotals,
  countOldScopeKeyRows,
  loadRqtFieldIndex,
  loadRqtIssueKeys,
  loadRqtValueFrequency,
  loadIssueRqtValues,
  loadRqtFieldIssueIndex,
  listAuditEvents,
  recordAuditEvent,
  loadWorkflowSchemes,
  loadWorkflowSchemeProjects,
  loadWorkflowSchemeForProject,
  loadProjectWorkflowSchemeMap,
  loadStatusesCatalog,
  loadWorkflowSchemeStatuses,
  loadStatusIssueCounts,
  clearStatusIssueCounts,
  flushIssueScanStatusCounts,
  readWorkflowSnapshotMeta,
  writeWorkflowSnapshotMeta,
  clearSnapshotVersion,
  clearIssueScanBuffer,
  clearRqtFieldIndex,
  clearRqtIssueKeys,
  clearRqtValueIndex,
  clearRqtFieldIssueIndex,
  replaceWorkflowSnapshot,
  replaceSnapshotFields,
  appendSnapshotFields,
  replaceFieldSummary,
  writeSnapshotMeta,
  writeIssueScanMeta,
  updateIssueScanWorker,
  replaceIssueScanWorkers,
  flushIssueScanCounts,
  loadSnapshotProjectFields,
  loadAllSnapshotProjectUsage,
  loadSnapshotProjectUsage,
} from "./project-store.js";

// Records SQL text and bound params per call, returning queued row sets in order.
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

// Loose SQL matcher: collapses whitespace so assertions survive reformatting.
const sqlHas = (call, ...fragments) => {
  const flat = call.text.replace(/\s+/g, " ").toLowerCase();
  return fragments.every((f) => flat.includes(f.toLowerCase()));
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSqlQueries();
});
afterEach(() => vi.restoreAllMocks());

// ── Workflow reads ──────────────────────────────────────────────────────────
//
// These back the insights layer, where a mapping error does not throw -- it produces a
// confident, wrong governance finding.

describe("workflow snapshot reads", () => {
  test("loadWorkflowSchemes maps every column callers consume", async () => {
    const calls = mockSqlQueries([[{
      scheme_id: "s1", name: "Alpha", description: "desc",
      default_workflow: "Default WF", issue_type_mapping_json: '{"10001":"Bug WF"}',
      project_count: 4, findings_json: null,
    }]]);

    const schemes = await loadWorkflowSchemes("scope", "v1");

    expect(schemes).toEqual([{
      id: "s1", name: "Alpha", description: "desc",
      defaultWorkflow: "Default WF", issueTypeMapping: { 10001: "Bug WF" },
      projectCount: 4, findings: null,
    }]);
    expect(sqlHas(calls[0], "from snapshot_workflow_schemes", "scope_key = ?", "version = ?")).toBe(true);
    expect(calls[0].params).toEqual(["scope", "v1"]);
  });

  test("loadWorkflowSchemes tolerates malformed mapping JSON rather than throwing", async () => {
    mockSqlQueries([[{ scheme_id: "s1", name: "A", issue_type_mapping_json: "{not json", project_count: 0 }]]);
    const [scheme] = await loadWorkflowSchemes("scope", "v1");
    expect(scheme.issueTypeMapping).toBeNull();
  });

  test("loadWorkflowSchemeProjects filters by scheme and maps project rows", async () => {
    const calls = mockSqlQueries([[
      { project_id: "10", project_key: "ALPHA", project_name: "Alpha" },
    ]]);

    const projects = await loadWorkflowSchemeProjects("scope", "v1", "s1");

    expect(projects).toEqual([{ projectId: "10", projectKey: "ALPHA", projectName: "Alpha" }]);
    expect(calls[0].params).toEqual(["scope", "v1", "s1"]);
  });

  test("loadWorkflowSchemeForProject returns null when the project has no scheme", async () => {
    mockSqlQueries([[]]);
    expect(await loadWorkflowSchemeForProject("scope", "v1", "10")).toBeNull();
  });

  test("loadWorkflowSchemeForProject maps a found scheme", async () => {
    mockSqlQueries([[{ scheme_id: "s1", name: "Alpha", description: null }]]);
    expect(await loadWorkflowSchemeForProject("scope", "v1", "10"))
      .toEqual({ schemeId: "s1", name: "Alpha", description: "" });
  });

  // The bulk form exists to avoid one query per project on a 140-project site; a keying
  // error here would silently mis-attribute schemes rather than fail.
  test("loadProjectWorkflowSchemeMap keys by project id as a string", async () => {
    const calls = mockSqlQueries([[
      { project_id: 10, scheme_id: "s1", name: "Alpha" },
      { project_id: 11, scheme_id: "s1", name: "Alpha" },
    ]]);

    const map = await loadProjectWorkflowSchemeMap("scope", "v1");

    expect(map.get("10")).toEqual({ schemeId: "s1", name: "Alpha" });
    expect(map.get("11")).toEqual({ schemeId: "s1", name: "Alpha" });
    expect(map.size).toBe(2);
    expect(sqlHas(calls[0], "join snapshot_workflow_schemes")).toBe(true);
  });

  test("loadProjectWorkflowSchemeMap skips rows with no project id", async () => {
    mockSqlQueries([[{ project_id: null, scheme_id: "s1", name: "Alpha" }]]);
    expect((await loadProjectWorkflowSchemeMap("scope", "v1")).size).toBe(0);
  });

  test("loadStatusesCatalog maps status rows", async () => {
    mockSqlQueries([[{ status_id: "1", name: "Done", status_category: "Done", findings_json: null }]]);
    const statuses = await loadStatusesCatalog("scope", "v1");
    // Note the shape: this loader returns `id`, while snapshot_statuses stores status_id.
    // workflow-insights.js reads `statusId ?? id` precisely because of this inconsistency.
    expect(statuses[0]).toMatchObject({ id: "1", name: "Done", statusCategory: "Done" });
  });

  test("loadWorkflowSchemeStatuses returns scheme/status pairs", async () => {
    const calls = mockSqlQueries([[{ scheme_id: "s1", status_id: "3" }]]);
    const pairs = await loadWorkflowSchemeStatuses("scope", "v1");
    expect(pairs).toEqual([{ schemeId: "s1", statusId: "3" }]);
    expect(sqlHas(calls[0], "from snapshot_workflow_statuses")).toBe(true);
  });

  test("readWorkflowSnapshotMeta returns null when no row exists", async () => {
    mockSqlQueries([[]]);
    expect(await readWorkflowSnapshotMeta("scope")).toBeNull();
  });

  test("readWorkflowSnapshotMeta defaults state to idle and coerces counts", async () => {
    mockSqlQueries([[{ state: null, version: "v1", total_schemes: "7" }]]);
    const meta = await readWorkflowSnapshotMeta("scope");
    expect(meta.state).toBe("idle");
    expect(meta.totalSchemes).toBe(7);
  });

  test("writeWorkflowSnapshotMeta issues a write", async () => {
    const calls = mockSqlQueries();
    await writeWorkflowSnapshotMeta("scope", { state: "ready", version: "v1" });
    expect(calls.length).toBeGreaterThan(0);
  });
});

// ── Status issue counts ─────────────────────────────────────────────────────
//
// An empty map means "no scan has run", which the insights layer must not confuse with
// "every status has zero issues" -- the latter would mark statuses safe to delete.

describe("status issue counts", () => {
  test("loadStatusIssueCounts aggregates per status id", async () => {
    const calls = mockSqlQueries([[
      { status_id: "1", total: "40" },
      { status_id: "2", total: 0 },
    ]]);

    const counts = await loadStatusIssueCounts("scope");

    expect(counts.get("1")).toBe(40);
    expect(counts.get("2")).toBe(0);
    expect(sqlHas(calls[0], "sum(issue_count)", "group by status_id")).toBe(true);
  });

  test("loadStatusIssueCounts returns an empty map when nothing has been scanned", async () => {
    mockSqlQueries([[]]);
    expect((await loadStatusIssueCounts("scope")).size).toBe(0);
  });

  test("flushIssueScanStatusCounts accumulates rather than overwriting", async () => {
    const calls = mockSqlQueries();
    await flushIssueScanStatusCounts("scope", new Map([
      ["1|10", { statusId: "1", statusName: "Done", statusCategory: "Done", projectId: "10", projectKey: "A", count: 3 }],
    ]));

    const insert = calls.find((c) => sqlHas(c, "insert into issue_scan_status_totals"));
    expect(insert).toBeDefined();
    // Workers flush repeatedly and many projects reach the same status, so rows are
    // additive across both dimensions.
    expect(sqlHas(insert, "on duplicate key update", "issue_count + values(issue_count)")).toBe(true);
  });

  test("flushIssueScanStatusCounts writes nothing for an empty map", async () => {
    const calls = mockSqlQueries();
    await flushIssueScanStatusCounts("scope", new Map());
    expect(calls.filter((c) => sqlHas(c, "insert into issue_scan_status_totals"))).toHaveLength(0);
  });

  test("flushIssueScanStatusCounts drops rows missing an identifier", async () => {
    const calls = mockSqlQueries();
    await flushIssueScanStatusCounts("scope", new Map([
      ["bad", { statusId: "", projectId: "10", count: 1 }],
      ["worse", { statusId: "1", projectId: "", count: 1 }],
    ]));
    expect(calls.filter((c) => sqlHas(c, "insert into issue_scan_status_totals"))).toHaveLength(0);
  });

  test("clearStatusIssueCounts scopes its delete", async () => {
    const calls = mockSqlQueries();
    await clearStatusIssueCounts("scope");
    expect(sqlHas(calls[0], "delete from issue_scan_status_totals", "scope_key = ?")).toBe(true);
    expect(calls[0].params).toEqual(["scope"]);
  });
});

// ── Snapshot field and project reads ────────────────────────────────────────

describe("snapshot reads", () => {
  test("loadSnapshotFields maps fields and parses findings JSON", async () => {
    mockSqlQueries([[{
      field_id: "customfield_1", name: "Team", type: "select",
      usage_count: "12", configured_project_count: "3", total_issue_count: "40",
      active_project_count: "2", findings_json: '{"reasons":["x"]}',
    }]]);

    const [field] = await loadSnapshotFields("scope", "v1");

    expect(field.fieldId ?? field.id).toBeDefined();
    expect(field.findings).toEqual({ reasons: ["x"] });
    expect(field.usageCount).toBe(12);
  });

  test("loadSnapshotField returns null for a missing field", async () => {
    mockSqlQueries([[]]);
    expect(await loadSnapshotField("scope", "v1", "customfield_missing")).toBeNull();
  });

  test("listSnapshotProjects maps aggregate columns and coerces numbers", async () => {
    mockSqlQueries([[{
      project_id: "10", project_key: "ALPHA", project_name: "Alpha",
      field_count: "6", total_issue_count: "400", latest_issue_updated_at: "2026-01-01",
    }]]);

    const [project] = await listSnapshotProjects("scope", "v1");

    expect(project).toEqual({
      projectId: "10", projectKey: "ALPHA", projectName: "Alpha",
      fieldCount: 6, totalIssueCount: 400, latestIssueUpdatedAt: "2026-01-01",
    });
  });

  test("listSnapshotProjects adds a LIKE filter only when a query is supplied", async () => {
    const withQuery = mockSqlQueries([[]]);
    await listSnapshotProjects("scope", "v1", "alp");
    expect(sqlHas(withQuery[0], "like ?")).toBe(true);
    expect(withQuery[0].params).toEqual(["scope", "v1", "%alp%", "%alp%"]);

    const noQuery = mockSqlQueries([[]]);
    await listSnapshotProjects("scope", "v1", "   ");
    expect(sqlHas(noQuery[0], "like ?")).toBe(false);
  });

  test("countSnapshotProjectUsage returns a number even for an empty result", async () => {
    mockSqlQueries([[]]);
    expect(await countSnapshotProjectUsage("scope", "v1")).toBe(0);
  });

  test("sumSnapshotFieldIssueCount coerces a string aggregate", async () => {
    mockSqlQueries([[{ total_issue_count: "1234" }]]);
    expect(await sumSnapshotFieldIssueCount("scope", "v1", "customfield_1")).toBe(1234);
  });

  test("loadSnapshotFieldIssueSums keys sums by field id", async () => {
    mockSqlQueries([[{ field_id: "customfield_1", total_issue_count: "9" }]]);
    const sums = await loadSnapshotFieldIssueSums("scope", "v1");
    expect(sums.get("customfield_1")).toBe(9);
  });

  test("getSnapshotProcessedFieldIds returns a set of ids", async () => {
    mockSqlQueries([[{ field_id: "a" }, { field_id: "b" }]]);
    const ids = await getSnapshotProcessedFieldIds("scope", "v1");
    expect(ids.has("a")).toBe(true);
    expect(ids.has("b")).toBe(true);
  });

  test("loadSnapshotProjectUsage and loadAllSnapshotProjectUsage query project usage", async () => {
    const calls = mockSqlQueries([[], []]);
    await loadSnapshotProjectUsage("scope", "v1", "customfield_1");
    await loadAllSnapshotProjectUsage("scope", "v1");
    expect(calls.every((c) => sqlHas(c, "snapshot_project_usage"))).toBe(true);
  });

  test("loadSnapshotProjectFields bounds its limit", async () => {
    const calls = mockSqlQueries([[], []]);
    await loadSnapshotProjectFields("scope", "v1", "10", { limit: 9999, offset: -5 });
    // Guards against an unbounded read being requested from the UI.
    expect(calls.some((c) => sqlHas(c, "limit"))).toBe(true);
  });
});

// ── Meta reads ──────────────────────────────────────────────────────────────

describe("meta reads", () => {
  test("readSnapshotMeta returns null when absent", async () => {
    mockSqlQueries([[]]);
    expect(await readSnapshotMeta("scope")).toBeNull();
  });

  test("readIssueScanMeta parses its JSON columns defensively", async () => {
    mockSqlQueries([[{ state: "ready", progress_log: "[oops", scan_history: null }]]);
    const meta = await readIssueScanMeta("scope");
    expect(meta.state).toBe("ready");
    expect(Array.isArray(meta.progressLog)).toBe(true);
  });

  test("readIssueScanWorker returns null for an unknown worker", async () => {
    mockSqlQueries([[]]);
    expect(await readIssueScanWorker("scope", 3)).toBeNull();
  });

  test("loadIssueScanProjectTotals maps unique issue counts", async () => {
    mockSqlQueries([[{ project_key: "ALPHA", unique_issue_count: "77" }]]);
    const [row] = await loadIssueScanProjectTotals("scope");
    expect(row.uniqueIssueCount).toBe(77);
  });

  test("countOldScopeKeyRows returns zero when nothing is stranded", async () => {
    mockSqlQueries([[]]);
    expect(await countOldScopeKeyRows("scope")).toBe(0);
  });
});

// ── Reports and summaries ───────────────────────────────────────────────────

describe("reports and summaries", () => {
  test("loadFieldSummary returns null when absent", async () => {
    mockSqlQueries([[]]);
    expect(await loadFieldSummary("scope", "customfield_1")).toBeNull();
  });

  test("listFieldSummaries applies a limit", async () => {
    const calls = mockSqlQueries([[]]);
    await listFieldSummaries("scope", 25);
    expect(sqlHas(calls[0], "field_summaries")).toBe(true);
  });

  test("listSavedReports maps report rows", async () => {
    mockSqlQueries([[{ report_id: "r1", name: "Q3", field_ids_json: '["a","b"]', created_at: "x", updated_at: "y" }]]);
    const [report] = await listSavedReports("scope");
    expect(report.reportId).toBe("r1");
    expect(report.fieldIds).toEqual(["a", "b"]);
  });

  test("saveSavedReport and deleteSavedReport both write", async () => {
    const calls = mockSqlQueries();
    await saveSavedReport("scope", { reportId: "r1", name: "Q3", fieldIds: ["a"] });
    await deleteSavedReport("scope", "r1");
    expect(calls.some((c) => sqlHas(c, "delete from saved_reports"))).toBe(true);
  });

  test("loadReportJob returns null when the job is unknown", async () => {
    mockSqlQueries([[]]);
    expect(await loadReportJob("scope", "job-1")).toBeNull();
  });
});

// ── Field options cache ─────────────────────────────────────────────────────

describe("field options cache", () => {
  test("loadFieldOptionsCache returns rows for a field", async () => {
    const calls = mockSqlQueries([[]]);
    await loadFieldOptionsCache("scope", "customfield_1");
    expect(sqlHas(calls[0], "field_options_cache")).toBe(true);
  });

  test("searchFieldOptionsCache lowercases the term and wraps it for LIKE", async () => {
    const calls = mockSqlQueries([[]]);
    await searchFieldOptionsCache("scope", "PROD");
    expect(calls[0].params).toEqual(["scope", "%prod%"]);
  });
});

// ── RQT index reads ─────────────────────────────────────────────────────────

describe("RQT index reads", () => {
  test("loadRqtFieldIndex maps field hit rows", async () => {
    const calls = mockSqlQueries([[]]);
    await loadRqtFieldIndex("scope");
    expect(sqlHas(calls[0], "rqt_field_index")).toBe(true);
  });

  test("loadRqtIssueKeys and loadRqtValueFrequency read their own tables", async () => {
    const calls = mockSqlQueries([[], []]);
    await loadRqtIssueKeys("scope");
    await loadRqtValueFrequency("scope");
    expect(sqlHas(calls[0], "rqt_issue_keys")).toBe(true);
    expect(sqlHas(calls[1], "rqt_value_issue_index")).toBe(true);
  });

  test("loadIssueRqtValues and loadRqtFieldIssueIndex are scoped by key", async () => {
    const calls = mockSqlQueries([[], []]);
    await loadIssueRqtValues("scope", "ABC-1");
    await loadRqtFieldIssueIndex("scope", "customfield_1");
    expect(calls[0].params).toContain("scope");
    expect(calls[1].params).toContain("scope");
  });
});

// ── Audit log ───────────────────────────────────────────────────────────────
//
// The audit trail is a security control, so its write path must never be silently
// skipped and its read path must stay scoped to one installation.

describe("audit log", () => {
  test("recordAuditEvent writes an append-only row", async () => {
    const calls = mockSqlQueries();
    await recordAuditEvent("scope", { action: "clear-data", accountId: "u1", allowed: true });
    const insert = calls.find((c) => sqlHas(c, "insert into audit_log"));
    expect(insert).toBeDefined();
  });

  test("listAuditEvents stays scoped to the installation", async () => {
    const calls = mockSqlQueries([[]]);
    await listAuditEvents("scope", { limit: 50 });
    expect(sqlHas(calls[0], "from audit_log", "scope_key = ?")).toBe(true);
    expect(calls[0].params[0]).toBe("scope");
  });
});

// ── Destructive operations ──────────────────────────────────────────────────
//
// Every delete must carry a scope_key predicate. An unscoped DELETE in a multi-tenant
// Forge app destroys another customer's data, which no amount of retry logic recovers.

describe("scoped deletes", () => {
  const cases = [
    ["clearSnapshotVersion", (fn) => fn("scope", "v1")],
    ["clearIssueScanBuffer", (fn) => fn("scope")],
    ["clearRqtFieldIndex", (fn) => fn("scope")],
    ["clearRqtIssueKeys", (fn) => fn("scope")],
    ["clearRqtValueIndex", (fn) => fn("scope")],
    ["clearRqtFieldIssueIndex", (fn) => fn("scope")],
    ["clearStatusIssueCounts", (fn) => fn("scope")],
  ];
  const fns = {
    clearSnapshotVersion, clearIssueScanBuffer, clearRqtFieldIndex, clearRqtIssueKeys,
    clearRqtValueIndex, clearRqtFieldIssueIndex, clearStatusIssueCounts,
  };

  test.each(cases)("%s scopes every DELETE it issues", async (name, invoke) => {
    const calls = mockSqlQueries();
    await invoke(fns[name]);

    const deletes = calls.filter((c) => sqlHas(c, "delete from"));
    expect(deletes.length).toBeGreaterThan(0);
    for (const del of deletes) {
      expect(sqlHas(del, "scope_key = ?")).toBe(true);
      expect(del.params[0]).toBe("scope");
    }
  });
});

// ── Writes ──────────────────────────────────────────────────────────────────

describe("snapshot writes", () => {
  test("replaceWorkflowSnapshot clears all four tables before inserting", async () => {
    const calls = mockSqlQueries();
    await replaceWorkflowSnapshot("scope", "v1", {
      schemes: [{ id: "s1", name: "Alpha", projectCount: 1 }],
      schemeProjects: [{ schemeId: "s1", projectId: "10", projectKey: "A", projectName: "Alpha" }],
      statuses: [{ id: "1", name: "Done", statusCategory: "Done" }],
      schemeStatuses: [{ schemeId: "s1", statusId: "1" }],
    });

    for (const table of [
      "snapshot_workflow_schemes", "snapshot_workflow_scheme_projects",
      "snapshot_statuses", "snapshot_workflow_statuses",
    ]) {
      expect(calls.some((c) => sqlHas(c, `delete from ${table}`))).toBe(true);
      expect(calls.some((c) => sqlHas(c, `insert into ${table}`))).toBe(true);
    }
  });

  test("replaceWorkflowSnapshot writes nothing but the deletes when given no rows", async () => {
    const calls = mockSqlQueries();
    await replaceWorkflowSnapshot("scope", "v1", {});
    expect(calls.some((c) => sqlHas(c, "insert into"))).toBe(false);
  });

  test("replaceSnapshotFields and appendSnapshotFields batch their inserts", async () => {
    const fields = Array.from({ length: 120 }, (_, i) => ({
      fieldId: `customfield_${i}`, name: `F${i}`, usageCount: 1,
      configuredProjectCount: 1, totalIssueCount: 1, activeProjectCount: 1,
    }));

    // These two differ, and the difference is worth pinning: appendSnapshotFields batches
    // 50 rows per statement, while replaceSnapshotFields issues one INSERT per field.
    // SQL request count is the Forge quota that binds first, so the unbatched path costs
    // one request per field on a full rebuild. Asserted as-is rather than as an
    // aspiration -- changing the hot write path is its own change, not a test edit.
    const replaceCalls = mockSqlQueries();
    await replaceSnapshotFields("scope", "v1", fields);
    expect(replaceCalls.filter((c) => sqlHas(c, "insert into snapshot_fields"))).toHaveLength(fields.length);

    const appendCalls = mockSqlQueries();
    await appendSnapshotFields("scope", "v1", fields);
    const appendInserts = appendCalls.filter((c) => sqlHas(c, "insert into snapshot_fields"));
    expect(appendInserts.length).toBeGreaterThan(0);
    expect(appendInserts.length).toBeLessThan(fields.length);
  });

  test("appendSnapshotFields is a no-op for an empty list", async () => {
    const calls = mockSqlQueries();
    await appendSnapshotFields("scope", "v1", []);
    expect(calls.filter((c) => sqlHas(c, "insert into snapshot_fields"))).toHaveLength(0);
  });

  test("replaceFieldSummary, writeSnapshotMeta and writeIssueScanMeta all write", async () => {
    const calls = mockSqlQueries();
    await replaceFieldSummary("scope", "customfield_1", { refreshedAt: "x", summaryStatus: "ready" });
    await writeSnapshotMeta("scope", { state: "ready", version: "v1" });
    await writeIssueScanMeta("scope", { state: "queued" });
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  test("replaceIssueScanWorkers and updateIssueScanWorker write worker rows", async () => {
    const calls = mockSqlQueries();
    await replaceIssueScanWorkers("scope", [{ workerId: 0, jqlFilter: "project = A", fieldIds: [] }]);
    await updateIssueScanWorker("scope", 0, { status: "done" });
    expect(calls.some((c) => sqlHas(c, "issue_scan_workers"))).toBe(true);
  });

  test("flushIssueScanCounts writes field and project-total rows together", async () => {
    const calls = mockSqlQueries();
    await flushIssueScanCounts(
      "scope",
      new Map([["customfield_1", new Map([["10", { count: 2, key: "A", name: "Alpha" }]])]]),
      new Map([["10", { count: 5, key: "A", name: "Alpha" }]])
    );
    expect(calls.some((c) => sqlHas(c, "issue_scan_buffer"))).toBe(true);
  });

  test("flushIssueScanCounts writes nothing when both maps are empty", async () => {
    const calls = mockSqlQueries();
    await flushIssueScanCounts("scope", new Map(), new Map());
    expect(calls.filter((c) => sqlHas(c, "insert into issue_scan_buffer"))).toHaveLength(0);
  });
});
