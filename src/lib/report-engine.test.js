import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("./jira-api.js", () => ({
  incrMetric: vi.fn(),
  METRIC_NAMES: {
    reportJobStarted: "report-job-started",
    reportJobCompleted: "report-job-completed",
    reportJobFailed: "report-job-failed",
  },
  getDistinctIssueCountForFields: vi.fn().mockResolvedValue(0),
  REPORT_JOB_FIELD_BATCH_SIZE: 40,
}));

vi.mock("./project-store.js", () => ({
  loadSnapshotField: vi.fn(),
  loadAllSnapshotProjectUsage: vi.fn().mockResolvedValue([]),
  loadReportJob: vi.fn(),
  replaceReportJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./snapshot-engine.js", () => ({
  queueReportBuild: vi.fn().mockResolvedValue(undefined),
}));

import { buildProjectUsageReportResult, processProjectUsageReportJob } from "./report-engine.js";
import {
  loadSnapshotField,
  loadAllSnapshotProjectUsage,
  loadReportJob,
  replaceReportJob,
} from "./project-store.js";
import { queueReportBuild } from "./snapshot-engine.js";
import { getDistinctIssueCountForFields, incrMetric, REPORT_JOB_FIELD_BATCH_SIZE } from "./jira-api.js";

const SCOPE = "scope-1";
const VERSION = "v1";

function snapshotField(overrides = {}) {
  return {
    id: "customfield_1",
    name: "Field One",
    type: "text",
    totalIssueCount: 10,
    activeProjectCount: 1,
    fieldJql: null,
    ...overrides,
  };
}

function usageRow(overrides = {}) {
  return {
    projectId: "1",
    projectKey: "AAA",
    projectName: "Alpha",
    issueCount: 5,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadAllSnapshotProjectUsage.mockResolvedValue([]);
  getDistinctIssueCountForFields.mockResolvedValue(0);
  replaceReportJob.mockResolvedValue(undefined);
  queueReportBuild.mockResolvedValue(undefined);
});

// ── buildProjectUsageReportResult ─────────────────────────────────────────────

describe("buildProjectUsageReportResult", () => {
  test("assembles a field row from the snapshot and its project usage", async () => {
    loadSnapshotField.mockResolvedValue(snapshotField());
    loadAllSnapshotProjectUsage.mockResolvedValue([usageRow()]);

    const { result } = await buildProjectUsageReportResult(SCOPE, VERSION, ["customfield_1"]);

    expect(result.fields).toHaveLength(1);
    expect(result.fields[0]).toMatchObject({
      fieldId: "customfield_1",
      fieldName: "Field One",
      totalIssueCount: 10,
      activeProjectCount: 1,
    });
    expect(result.fields[0].projects).toEqual([usageRow()]);
  });

  test("derives a field JQL when the snapshot row has none stored", async () => {
    loadSnapshotField.mockResolvedValue(snapshotField({ fieldJql: null }));

    const { result } = await buildProjectUsageReportResult(SCOPE, VERSION, ["customfield_1"]);
    expect(result.fields[0].fieldJql).toBeTruthy();
  });

  test("keeps the stored field JQL when present", async () => {
    loadSnapshotField.mockResolvedValue(snapshotField({ fieldJql: "stored jql" }));

    const { result } = await buildProjectUsageReportResult(SCOPE, VERSION, ["customfield_1"]);
    expect(result.fields[0].fieldJql).toBe("stored jql");
  });

  test("skips field ids that are not in the snapshot", async () => {
    loadSnapshotField.mockResolvedValue(null);

    const { result } = await buildProjectUsageReportResult(SCOPE, VERSION, ["customfield_gone"]);
    expect(result.fields).toEqual([]);
  });

  test("defaults missing counts to zero", async () => {
    loadSnapshotField.mockResolvedValue(snapshotField({ totalIssueCount: undefined, activeProjectCount: undefined }));

    const { result } = await buildProjectUsageReportResult(SCOPE, VERSION, ["customfield_1"]);
    expect(result.fields[0]).toMatchObject({ totalIssueCount: 0, activeProjectCount: 0 });
  });

  // A field with issues but no usage rows means the project-usage build never ran
  // for it. Reporting that explicitly stops the report from silently understating
  // where the field is used.
  test("flags a pending field when it has issues but no usage rows", async () => {
    loadSnapshotField.mockResolvedValue(snapshotField({ totalIssueCount: 500 }));
    loadAllSnapshotProjectUsage.mockResolvedValue([]);

    const { result } = await buildProjectUsageReportResult(SCOPE, VERSION, ["customfield_1"]);
    expect(result.pendingFields).toEqual([{
      fieldId: "customfield_1",
      fieldName: "Field One",
      summaryStatus: "missing",
      reason: "project-usage-missing",
    }]);
  });

  test("does not flag a field that genuinely has no issues", async () => {
    loadSnapshotField.mockResolvedValue(snapshotField({ totalIssueCount: 0 }));
    loadAllSnapshotProjectUsage.mockResolvedValue([]);

    const { result } = await buildProjectUsageReportResult(SCOPE, VERSION, ["customfield_1"]);
    expect(result.pendingFields).toEqual([]);
  });

  test("deduplicates projects across fields into one column list", async () => {
    loadSnapshotField
      .mockResolvedValueOnce(snapshotField({ id: "customfield_1" }))
      .mockResolvedValueOnce(snapshotField({ id: "customfield_2" }));
    loadAllSnapshotProjectUsage.mockResolvedValue([usageRow()]);

    const { result } = await buildProjectUsageReportResult(SCOPE, VERSION, ["customfield_1", "customfield_2"]);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]).toEqual({ projectId: "1", projectKey: "AAA", projectName: "Alpha" });
  });

  test("sorts the project column list by key", async () => {
    loadSnapshotField.mockResolvedValue(snapshotField());
    loadAllSnapshotProjectUsage.mockResolvedValue([
      usageRow({ projectId: "2", projectKey: "ZZZ", projectName: "Zeta" }),
      usageRow({ projectId: "1", projectKey: "AAA", projectName: "Alpha" }),
    ]);

    const { result } = await buildProjectUsageReportResult(SCOPE, VERSION, ["customfield_1"]);
    expect(result.projects.map((p) => p.projectKey)).toEqual(["AAA", "ZZZ"]);
  });

  // Batching is what keeps a large report inside the Forge invocation budget; the
  // offset/isComplete contract is how the job knows to re-queue itself.
  test("processes only one batch and reports the next offset", async () => {
    loadSnapshotField.mockResolvedValue(snapshotField());
    const fieldIds = Array.from({ length: REPORT_JOB_FIELD_BATCH_SIZE + 5 }, (_, i) => `customfield_${i}`);

    const out = await buildProjectUsageReportResult(SCOPE, VERSION, fieldIds, 0);
    expect(out.nextOffset).toBe(REPORT_JOB_FIELD_BATCH_SIZE);
    expect(out.isComplete).toBe(false);
    expect(loadSnapshotField).toHaveBeenCalledTimes(REPORT_JOB_FIELD_BATCH_SIZE);
  });

  test("reports completion once the final batch is consumed", async () => {
    loadSnapshotField.mockResolvedValue(snapshotField());

    const out = await buildProjectUsageReportResult(SCOPE, VERSION, ["customfield_1"], 0);
    expect(out.isComplete).toBe(true);
    expect(out.nextOffset).toBe(1);
  });

  test("carries forward fields and projects from a partial result", async () => {
    loadSnapshotField.mockResolvedValue(snapshotField({ id: "customfield_2" }));
    // Give this field real usage so it does not add a pending entry of its own --
    // the assertion below is about carry-forward, not pending detection.
    loadAllSnapshotProjectUsage.mockResolvedValue([usageRow()]);
    const partial = {
      fields: [{ fieldId: "customfield_1", projects: [] }],
      projects: [{ projectId: "9", projectKey: "PRE", projectName: "Prior" }],
      pendingFields: [{ fieldId: "customfield_0" }],
      uniqueIssueCount: 42,
    };

    const { result } = await buildProjectUsageReportResult(SCOPE, VERSION, ["customfield_2"], 0, partial);
    expect(result.fields).toHaveLength(2);
    expect(result.projects.some((p) => p.projectKey === "PRE")).toBe(true);
    expect(result.pendingFields).toHaveLength(1);
    expect(result.uniqueIssueCount).toBe(42);
  });

  test("starts from empty when no partial result is supplied", async () => {
    loadSnapshotField.mockResolvedValue(snapshotField());

    const { result } = await buildProjectUsageReportResult(SCOPE, VERSION, ["customfield_1"], 0, null);
    expect(result.uniqueIssueCount).toBeNull();
  });
});

// ── processProjectUsageReportJob ──────────────────────────────────────────────

describe("processProjectUsageReportJob", () => {
  function job(overrides = {}) {
    return {
      reportName: "Finance fields",
      status: "queued",
      fieldIds: ["customfield_1"],
      totalFields: 1,
      nextOffset: 0,
      progressLog: [],
      result: null,
      startedAt: null,
      ...overrides,
    };
  }

  test("does nothing when the job no longer exists", async () => {
    loadReportJob.mockResolvedValue(null);
    await processProjectUsageReportJob(SCOPE, VERSION, "job-1");
    expect(replaceReportJob).not.toHaveBeenCalled();
  });

  // Both are terminal: re-processing a cancelled job would resurrect it, and
  // re-processing a ready one would redo completed work.
  test.each(["cancelled", "ready"])("does nothing for a %s job", async (status) => {
    loadReportJob.mockResolvedValue(job({ status }));
    await processProjectUsageReportJob(SCOPE, VERSION, "job-1");
    expect(replaceReportJob).not.toHaveBeenCalled();
  });

  test("marks a single-batch job ready and records the unique issue count", async () => {
    loadReportJob.mockResolvedValue(job());
    loadSnapshotField.mockResolvedValue(snapshotField());
    getDistinctIssueCountForFields.mockResolvedValue(777);

    await processProjectUsageReportJob(SCOPE, VERSION, "job-1");

    const saved = replaceReportJob.mock.calls[0][2];
    expect(saved.status).toBe("ready");
    expect(saved.completedAt).toBeTruthy();
    expect(saved.result.uniqueIssueCount).toBe(777);
    expect(saved.lastError).toBeNull();
  });

  test("counts a started metric only on the first invocation", async () => {
    loadReportJob.mockResolvedValue(job({ status: "queued" }));
    loadSnapshotField.mockResolvedValue(snapshotField());

    await processProjectUsageReportJob(SCOPE, VERSION, "job-1");
    expect(incrMetric).toHaveBeenCalledWith("report-job-started");
  });

  test("does not re-count a started metric on a continuation", async () => {
    loadReportJob.mockResolvedValue(job({ status: "building" }));
    loadSnapshotField.mockResolvedValue(snapshotField());

    await processProjectUsageReportJob(SCOPE, VERSION, "job-1");
    expect(incrMetric).not.toHaveBeenCalledWith("report-job-started");
  });

  test("counts a completed metric when the job finishes", async () => {
    loadReportJob.mockResolvedValue(job());
    loadSnapshotField.mockResolvedValue(snapshotField());

    await processProjectUsageReportJob(SCOPE, VERSION, "job-1");
    expect(incrMetric).toHaveBeenCalledWith("report-job-completed");
  });

  // The self-requeue is what lets a report larger than one batch finish at all.
  test("saves progress and re-queues itself when work remains", async () => {
    const fieldIds = Array.from({ length: REPORT_JOB_FIELD_BATCH_SIZE + 5 }, (_, i) => `customfield_${i}`);
    loadReportJob.mockResolvedValue(job({ fieldIds, totalFields: fieldIds.length }));
    loadSnapshotField.mockResolvedValue(snapshotField());

    await processProjectUsageReportJob(SCOPE, VERSION, "job-1");

    const saved = replaceReportJob.mock.calls[0][2];
    expect(saved.status).toBe("building");
    expect(saved.nextOffset).toBe(REPORT_JOB_FIELD_BATCH_SIZE);
    expect(queueReportBuild).toHaveBeenCalledWith(SCOPE, VERSION, "job-1");
  });

  test("does not re-queue once the job is complete", async () => {
    loadReportJob.mockResolvedValue(job());
    loadSnapshotField.mockResolvedValue(snapshotField());

    await processProjectUsageReportJob(SCOPE, VERSION, "job-1");
    expect(queueReportBuild).not.toHaveBeenCalled();
  });

  test("preserves the original startedAt across continuations", async () => {
    const fieldIds = Array.from({ length: REPORT_JOB_FIELD_BATCH_SIZE + 5 }, (_, i) => `customfield_${i}`);
    loadReportJob.mockResolvedValue(job({
      fieldIds,
      totalFields: fieldIds.length,
      startedAt: "2026-01-01T00:00:00.000Z",
    }));
    loadSnapshotField.mockResolvedValue(snapshotField());

    await processProjectUsageReportJob(SCOPE, VERSION, "job-1");
    expect(replaceReportJob.mock.calls[0][2].startedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("stamps startedAt on the first continuation when absent", async () => {
    const fieldIds = Array.from({ length: REPORT_JOB_FIELD_BATCH_SIZE + 5 }, (_, i) => `customfield_${i}`);
    loadReportJob.mockResolvedValue(job({ fieldIds, totalFields: fieldIds.length, startedAt: null }));
    loadSnapshotField.mockResolvedValue(snapshotField());

    await processProjectUsageReportJob(SCOPE, VERSION, "job-1");
    expect(replaceReportJob.mock.calls[0][2].startedAt).toBeTruthy();
  });

  test("appends progress entries describing the batch range", async () => {
    loadReportJob.mockResolvedValue(job());
    loadSnapshotField.mockResolvedValue(snapshotField());

    await processProjectUsageReportJob(SCOPE, VERSION, "job-1");

    const log = replaceReportJob.mock.calls[0][2].progressLog;
    expect(log.some((e) => e.msg.includes("Started report build for Finance fields"))).toBe(true);
    expect(log.some((e) => e.msg.includes("Processing fields 1-1 of 1"))).toBe(true);
    expect(log.some((e) => e.msg.includes("Completed report build"))).toBe(true);
  });

  // Unbounded logs on a long multi-batch report would grow the stored job row
  // without limit.
  test("caps the progress log at 100 entries", async () => {
    const existingLog = Array.from({ length: 100 }, (_, i) => ({ t: "t", msg: `entry ${i}` }));
    loadReportJob.mockResolvedValue(job({ progressLog: existingLog }));
    loadSnapshotField.mockResolvedValue(snapshotField());

    await processProjectUsageReportJob(SCOPE, VERSION, "job-1");

    const log = replaceReportJob.mock.calls[0][2].progressLog;
    expect(log.length).toBeLessThanOrEqual(100);
    expect(log.some((e) => e.msg === "entry 0")).toBe(false);
  });
});
