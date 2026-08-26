import { vi, describe, test, expect, beforeEach } from "vitest";

// The orchestrator existed and tested well from the day it was written. What it never had was
// anything calling it, so what needs pinning here is the wiring: that a stage actually starts,
// that a handoff stage is waited on rather than assumed finished, and that the scan cannot
// stall silently -- every path either queues the next step or writes a terminal state.

vi.mock("./jira-api.js", () => ({ makeJobToken: () => "job-token" }));
vi.mock("./queues.js", () => ({ inventorySnapshotQueue: { push: vi.fn() } }));
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  fallbackOn: () => () => undefined,
  ignoreWith: () => () => undefined,
}));

vi.mock("./project-store.js", () => ({
  ensureProjectStoreReady: vi.fn(),
  readFullScanMeta: vi.fn(),
  writeFullScanMeta: vi.fn(),
  readFilterSnapshotMeta: vi.fn(),
  readDashboardSnapshotMeta: vi.fn(),
  readIssueScanMeta: vi.fn(),
}));

vi.mock("./filter-engine.js", () => ({ isFilterBuildStale: vi.fn(() => false), queueFilterSnapshotBuild: vi.fn() }));
vi.mock("./dashboard-engine.js", () => ({ isDashboardBuildStale: vi.fn(() => false), queueDashboardSnapshotBuild: vi.fn() }));
vi.mock("./workflow-engine.js", () => ({ buildWorkflowSnapshot: vi.fn(), buildStatusHistorySnapshot: vi.fn() }));
vi.mock("./screen-engine.js", () => ({ buildScreenSnapshot: vi.fn() }));
vi.mock("./snapshot-engine.js", () => ({ runSnapshot: vi.fn() }));
vi.mock("./scan-engine.js", () => ({ runIssueScanCoordinator: vi.fn() }));
vi.mock("./site-health.js", () => ({ captureSiteHealth: vi.fn() }));

import { startFullScan, runFullScanStep, fullScanStageCatalog } from "./full-scan-runner.js";
import { initialStages, markStage, FULL_SCAN_POLL_DELAY_SECONDS } from "./full-scan.js";
import { inventorySnapshotQueue } from "./queues.js";
import { readFullScanMeta, writeFullScanMeta, readFilterSnapshotMeta } from "./project-store.js";
import { buildWorkflowSnapshot } from "./workflow-engine.js";
import { queueFilterSnapshotBuild } from "./filter-engine.js";

const lastWrite = () => {
  const calls = writeFullScanMeta.mock.calls;
  return calls.length ? calls[calls.length - 1][1] : null;
};

// A running scan whose stages are all pending except those named done.
const running = (over = {}) => ({
  state: "running",
  jobToken: "job-token",
  currentStage: null,
  stages: initialStages(),
  polls: 0,
  ...over,
});

const withDone = (keys) =>
  keys.reduce((stages, key) => markStage(stages, key, { state: "done" }), initialStages());

beforeEach(() => {
  vi.clearAllMocks();
  writeFullScanMeta.mockResolvedValue({});
});

describe("starting", () => {
  test("writes every stage as pending and queues the first step", async () => {
    readFullScanMeta.mockResolvedValue(null);

    const result = await startFullScan("inst", { now: 1000 });

    expect(result).toMatchObject({ started: true, jobToken: "job-token" });
    const patch = lastWrite();
    expect(patch.state).toBe("running");
    // Every stage is listed up front, so the UI can show what a scan covers rather than
    // revealing the list one stage at a time as it goes.
    expect(patch.stages).toHaveLength(fullScanStageCatalog().length);
    expect(patch.stages.every((s) => s.state === "pending")).toBe(true);
    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ jobType: "run-full-scan", installationKey: "inst" }) })
    );
  });

  test("refuses to start a second scan over a running one", async () => {
    readFullScanMeta.mockResolvedValue(running());

    expect(await startFullScan("inst")).toMatchObject({ started: false, reason: "already-running" });
    expect(inventorySnapshotQueue.push).not.toHaveBeenCalled();
  });
});

describe("running a stage", () => {
  test("runs an inline stage and moves on", async () => {
    readFullScanMeta.mockResolvedValue(running());

    await runFullScanStep("inst", { jobToken: "job-token" });

    // workflows is first in dependency order.
    expect(buildWorkflowSnapshot).toHaveBeenCalledWith("inst");
    expect(lastWrite().stages.find((s) => s.key === "workflows").state).toBe("done");
    expect(inventorySnapshotQueue.push).toHaveBeenCalled();
  });

  test("hands off a resumable stage instead of running it inline", async () => {
    readFullScanMeta.mockResolvedValue(running({ stages: withDone(["workflows", "screens"]) }));

    const result = await runFullScanStep("inst", { jobToken: "job-token" });

    // Filters no longer finish in one invocation by design -- they chunk and re-queue -- so
    // the orchestrator must start and wait, not call and assume.
    expect(queueFilterSnapshotBuild).toHaveBeenCalledWith("inst");
    expect(result).toMatchObject({ handedOff: true, stage: "filters" });
    expect(lastWrite().currentStage).toBe("filters");
    // Waiting is a DELAYED re-queue. Without the delay the orchestrator would burn an
    // invocation every few hundred milliseconds asking a long build whether it had finished.
    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith(
      expect.objectContaining({ delayInSeconds: FULL_SCAN_POLL_DELAY_SECONDS })
    );
  });

  test("a stage that throws fails that stage, not the scan", async () => {
    readFullScanMeta.mockResolvedValue(running());
    buildWorkflowSnapshot.mockRejectedValueOnce(new Error("401 scope does not match"));

    await runFullScanStep("inst", { jobToken: "job-token" });

    const stages = lastWrite().stages;
    expect(stages.find((s) => s.key === "workflows")).toMatchObject({ state: "failed", error: expect.stringContaining("401") });
    // The scan carries on: four of the eight stages are independent, and an admin whose
    // workflow build 401s still wants the field and screen data from the same run.
    expect(inventorySnapshotQueue.push).toHaveBeenCalled();
  });

  test("skips a stage whose dependency failed rather than running it on stale input", async () => {
    const stages = markStage(withDone(["screens", "filters", "dashboards", "fields"]), "workflows", { state: "failed" });
    readFullScanMeta.mockResolvedValue(running({ stages }));

    await runFullScanStep("inst", { jobToken: "job-token" });

    // status-history joins against the workflow snapshot. Built on one that did not refresh it
    // is not a partial result, it is a wrong one.
    expect(lastWrite().stages.find((s) => s.key === "status-history")).toMatchObject({
      state: "skipped",
      error: expect.stringContaining("workflows"),
    });
  });
});

describe("waiting on a handoff stage", () => {
  test("keeps waiting while the pillar is still building", async () => {
    readFullScanMeta.mockResolvedValue(running({ currentStage: "filters", polls: 3 }));
    readFilterSnapshotMeta.mockResolvedValue({ state: "building" });

    const result = await runFullScanStep("inst", { jobToken: "job-token" });

    expect(result).toMatchObject({ waiting: true, stage: "filters", polls: 4 });
    expect(lastWrite()).toMatchObject({ polls: 4 });
  });

  test("marks the stage done once the pillar reports ready, and advances", async () => {
    readFullScanMeta.mockResolvedValue(running({ currentStage: "filters", stages: withDone(["workflows", "screens"]) }));
    readFilterSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });

    await runFullScanStep("inst", { jobToken: "job-token" });

    expect(lastWrite().stages.find((s) => s.key === "filters").state).toBe("done");
    expect(lastWrite().currentStage).toBeNull();
  });

  test("abandons a stage that stops reporting instead of waiting forever", async () => {
    readFullScanMeta.mockResolvedValue(running({ currentStage: "filters", polls: 10_000 }));
    readFilterSnapshotMeta.mockResolvedValue({ state: "building" });

    await runFullScanStep("inst", { jobToken: "job-token" });

    // A pillar can die without writing a terminal state -- a deploy mid-build, a lost queue
    // message. Bounding the wait is what stops that holding the whole scan open forever.
    expect(lastWrite().stages.find((s) => s.key === "filters")).toMatchObject({
      state: "failed",
      error: expect.stringContaining("stopped reporting"),
    });
  });
});

describe("finishing", () => {
  test("reports completed-with-failures rather than plain success when a stage failed", async () => {
    const stages = markStage(
      withDone(fullScanStageCatalog().map((s) => s.key).filter((k) => k !== "health")),
      "health",
      { state: "failed" }
    );
    readFullScanMeta.mockResolvedValue(running({ stages }));

    const result = await runFullScanStep("inst", { jobToken: "job-token" });

    expect(result).toMatchObject({ completed: true });
    // A green tick over a stage that did not run is exactly the thing people act on.
    expect(lastWrite().state).toBe("completed-with-failures");
    expect(lastWrite().jobToken).toBeNull();
  });

  test("reports ready when every stage completed", async () => {
    readFullScanMeta.mockResolvedValue(running({ stages: withDone(fullScanStageCatalog().map((s) => s.key)) }));

    await runFullScanStep("inst", { jobToken: "job-token" });

    expect(lastWrite().state).toBe("ready");
  });
});

describe("messages that should not be acted on", () => {
  test("ignores a step for a scan that is not running", async () => {
    readFullScanMeta.mockResolvedValue({ state: "ready" });
    expect(await runFullScanStep("inst", {})).toMatchObject({ ignored: true, reason: "not-running" });
  });

  test("ignores a step from a superseded run", async () => {
    readFullScanMeta.mockResolvedValue(running({ jobToken: "current" }));

    const result = await runFullScanStep("inst", { jobToken: "an-older-run" });

    // A cancelled or restarted scan leaves messages in flight. Acting on one would advance a
    // stage list that no longer exists.
    expect(result).toMatchObject({ ignored: true, reason: "stale-token" });
    expect(buildWorkflowSnapshot).not.toHaveBeenCalled();
  });
});

describe("coverage", () => {
  test("covers every pillar that has a tab, except automation", () => {
    const keys = fullScanStageCatalog().map((s) => s.key);

    expect(keys).toEqual(expect.arrayContaining([
      "workflows", "screens", "filters", "dashboards", "fields", "status-history", "issues", "health",
    ]));
    // Automation is excluded deliberately: Jira publishes no API to enumerate rules, so a scan
    // that included it would be claiming coverage it does not have.
    expect(keys).not.toContain("automation");
  });
});
