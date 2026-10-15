import { vi, describe, test, expect, beforeEach } from "vitest";

// The orchestrator existed and tested well from the day it was written. What it never had was
// anything calling it, so what needs pinning here is the wiring: that a stage actually starts,
// that a handoff stage is waited on rather than assumed finished, and that the scan cannot
// stall silently -- every path either queues the next step or writes a terminal state.

vi.mock("./jira-api.js", () => ({ makeJobToken: vi.fn(() => "job-token") }));
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
  writeIssueScanMeta: vi.fn(async () => ({})),
  readWorkflowSnapshotMeta: vi.fn(async () => null),
  readScreenSnapshotMeta: vi.fn(async () => null),
  readIssueTypeSnapshotMeta: vi.fn(async () => null),
  readAccessSnapshotMeta: vi.fn(async () => null),
  readEstateSnapshotMeta: vi.fn(async () => null),
  readFieldConfigSnapshotMeta: vi.fn(async () => null),
  readBoardSnapshotMeta: vi.fn(async () => null),
  readUserSnapshotMeta: vi.fn(async () => null),
  readAssetSnapshotMeta: vi.fn(async () => null),
  readDriftSnapshotMeta: vi.fn(async () => null),
  readSnapshotMeta: vi.fn(async () => null),
  recordFullScanRun: vi.fn(async () => ({ recorded: true })),
}));

vi.mock("./access-engine.js", () => ({ buildAccessSnapshot: vi.fn() }));
vi.mock("./estate-engine.js", () => ({ buildEstateSnapshot: vi.fn() }));
vi.mock("./fieldconfig-engine.js", () => ({ buildFieldConfigSnapshot: vi.fn() }));
vi.mock("./board-engine.js", () => ({ buildBoardSnapshot: vi.fn() }));
vi.mock("./user-engine.js", () => ({ buildUserSnapshot: vi.fn() }));
vi.mock("./asset-engine.js", () => ({ buildAssetSnapshot: vi.fn() }));
vi.mock("./drift-engine.js", () => ({ buildDriftSnapshot: vi.fn() }));

vi.mock("./filter-engine.js", () => ({ isFilterBuildStale: vi.fn(() => false), queueFilterSnapshotBuild: vi.fn() }));
vi.mock("./dashboard-engine.js", () => ({
  isDashboardBuildStale: vi.fn(() => false),
  queueDashboardSnapshotBuild: vi.fn(),
}));
vi.mock("./workflow-engine.js", () => ({ buildWorkflowSnapshot: vi.fn(), buildStatusHistorySnapshot: vi.fn() }));
vi.mock("./screen-engine.js", () => ({ buildScreenSnapshot: vi.fn() }));
vi.mock("./issuetype-engine.js", () => ({ buildIssueTypeSnapshot: vi.fn() }));
vi.mock("./snapshot-engine.js", () => ({
  queueSnapshotBuild: vi.fn(),
  isSnapshotBuildStale: vi.fn(() => false),
  requeueStaleSnapshotBuild: vi.fn(async (_key, meta) => meta),
}));
vi.mock("./scan-engine.js", () => ({ runIssueScanCoordinator: vi.fn() }));
vi.mock("./site-health.js", () => ({ captureSiteHealth: vi.fn() }));

// The quick-scan issues-delta stage reaches this with a DYNAMIC import, specifically to avoid
// a module cycle -- resolvers.js already imports startQuickScan/runQuickScanStep from this
// file. vi.mock intercepts the module regardless of which import form asks for it.
vi.mock("../resolvers.js", () => ({
  runDeltaIssueScanJob: vi.fn(),
  DELTA_SCOPE_SUFFIX: "::delta",
  captureSiteHealthForScan: vi.fn().mockResolvedValue({ recorded: true }),
}));

import {
  startFullScan,
  runFullScanStep,
  fullScanStageCatalog,
  startQuickScan,
  runQuickScanStep,
  quickScanStageCatalog,
  recoverStalledScan,
  resumeScanRun,
  cancelScan,
  STAGE_RUNNERS,
  QUICK_SCAN_RUNNERS,
} from "./full-scan-runner.js";
import {
  initialStages,
  markStage,
  FULL_SCAN_POLL_DELAY_SECONDS,
  FULL_SCAN_STALL_MS,
  MAX_SCAN_RECOVERIES,
  MAX_SCAN_TOTAL_MS,
  MAX_STAGE_ATTEMPTS,
  MAX_SCAN_SWEEPS,
  QUICK_SCAN_STAGES,
} from "./full-scan.js";
import { captureSiteHealthForScan } from "../resolvers.js";
import { inventorySnapshotQueue } from "./queues.js";
import { makeJobToken } from "./jira-api.js";
import {
  readFullScanMeta,
  writeFullScanMeta,
  readFilterSnapshotMeta,
  readIssueScanMeta,
  writeIssueScanMeta,
  recordFullScanRun,
} from "./project-store.js";
import { runIssueScanCoordinator } from "./scan-engine.js";
import { buildWorkflowSnapshot } from "./workflow-engine.js";
import { buildIssueTypeSnapshot } from "./issuetype-engine.js";
import { buildFieldConfigSnapshot } from "./fieldconfig-engine.js";
import { buildUserSnapshot } from "./user-engine.js";
import { buildAssetSnapshot } from "./asset-engine.js";
import { queueFilterSnapshotBuild } from "./filter-engine.js";
import { queueSnapshotBuild, isSnapshotBuildStale, requeueStaleSnapshotBuild } from "./snapshot-engine.js";
import { readSnapshotMeta } from "./project-store.js";
import { runDeltaIssueScanJob } from "../resolvers.js";

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

const withDone = (keys) => keys.reduce((stages, key) => markStage(stages, key, { state: "done" }), initialStages());

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
      expect.objectContaining({ body: expect.objectContaining({ jobType: "run-full-scan", installationKey: "inst" }) }),
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

  test("an inline stage records a real elapsed, not a 0s duration", async () => {
    readFullScanMeta.mockResolvedValue(running());
    // The step captures ONE `now` for the whole invocation; the stage's completedAt has to
    // carry the actual elapsed of runner.run(), or every inline stage reports 0s.
    buildWorkflowSnapshot.mockImplementationOnce(() => new Promise((r) => setTimeout(r, 25)));

    await runFullScanStep("inst", { jobToken: "job-token" }, { now: 1_000_000 });

    const wf = lastWrite().stages.find((s) => s.key === "workflows");
    expect(new Date(wf.startedAt).getTime()).toBe(1_000_000);
    expect(new Date(wf.completedAt).getTime()).toBeGreaterThan(1_000_000);
  });

  test("runs the issue-types stage inline through its engine", async () => {
    readFullScanMeta.mockResolvedValue(
      running({
        stages: withDone(["workflows", "screens", "filters", "dashboards", "fields", "status-history"]),
      }),
    );

    await runFullScanStep("inst", { jobToken: "job-token" });

    expect(buildIssueTypeSnapshot).toHaveBeenCalledWith("inst");
    expect(lastWrite().stages.find((s) => s.key === "issue-types").state).toBe("done");
  });

  test("runs the field-configs stage inline through its engine", async () => {
    readFullScanMeta.mockResolvedValue(
      running({
        stages: withDone(["workflows", "screens", "filters", "dashboards", "fields", "status-history", "issue-types"]),
      }),
    );

    await runFullScanStep("inst", { jobToken: "job-token" });

    expect(buildFieldConfigSnapshot).toHaveBeenCalledWith("inst");
    expect(lastWrite().stages.find((s) => s.key === "field-configs").state).toBe("done");
  });

  // Two pillars that were scored but never scanned. The stage list alone does not prove the
  // wiring: a key in FULL_SCAN_STAGES with no entry in STAGE_RUNNERS is a stage that cannot
  // run, which is a worse failure than not having the stage at all.
  const upToBoards = [
    "workflows",
    "screens",
    "filters",
    "dashboards",
    "fields",
    "status-history",
    "issue-types",
    "field-configs",
    "access",
    "estate",
    "boards",
  ];

  test("runs the people stage inline through the user engine", async () => {
    readFullScanMeta.mockResolvedValue(running({ stages: withDone(upToBoards) }));

    await runFullScanStep("inst", { jobToken: "job-token" });

    expect(buildUserSnapshot).toHaveBeenCalledWith("inst");
    expect(lastWrite().stages.find((s) => s.key === "people").state).toBe("done");
  });

  test("runs the assets stage inline through the asset engine", async () => {
    readFullScanMeta.mockResolvedValue(running({ stages: withDone([...upToBoards, "people"]) }));

    await runFullScanStep("inst", { jobToken: "job-token" });

    expect(buildAssetSnapshot).toHaveBeenCalledWith("inst");
    expect(lastWrite().stages.find((s) => s.key === "assets").state).toBe("done");
  });

  test("an Assets-less site completes the stage rather than failing it", async () => {
    // buildAssetSnapshot resolves with { unavailable: true } off JSM Premium instead of
    // throwing, so the pillar reports not-applicable and the scan carries on. If this ever
    // starts throwing, every scan on every non-Premium site grows a failed stage.
    readFullScanMeta.mockResolvedValue(running({ stages: withDone([...upToBoards, "people"]) }));
    buildAssetSnapshot.mockResolvedValueOnce({ unavailable: true, reason: "not enabled here" });

    await runFullScanStep("inst", { jobToken: "job-token" });

    expect(lastWrite().stages.find((s) => s.key === "assets").state).toBe("done");
  });

  test("every declared stage has a runner, in both scan types", () => {
    // The check that makes "a stage exists but nothing runs it" impossible to ship.
    for (const { key } of fullScanStageCatalog()) {
      expect(STAGE_RUNNERS[key], `full scan declares "${key}" with no runner`).toBeDefined();
    }
    for (const { key } of quickScanStageCatalog()) {
      expect(QUICK_SCAN_RUNNERS[key], `quick scan declares "${key}" with no runner`).toBeDefined();
    }
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
      expect.objectContaining({ delayInSeconds: FULL_SCAN_POLL_DELAY_SECONDS }),
    );
  });

  // The bug: runIssueScanCoordinator refuses to run unless the crawl's meta says "queued".
  // The orchestrator handed off by calling it directly, so it read the PREVIOUS run's "ready"
  // row, skipped, and the next poll read that same stale "ready" and marked the stage done
  // one poll interval later -- a whole-site crawl "finishing" in ~31 seconds.
  test("the issue-crawl handoff flips the crawl meta to queued before starting the coordinator", async () => {
    readFullScanMeta.mockResolvedValue(
      running({
        stages: withDone([
          "workflows",
          "screens",
          "filters",
          "dashboards",
          "fields",
          "status-history",
          "issue-types",
          "field-configs",
          "access",
          "estate",
          "boards",
          "people",
          "assets",
        ]),
      }),
    );

    const result = await runFullScanStep("inst", { jobToken: "job-token" });

    expect(result).toMatchObject({ handedOff: true, stage: "issues" });
    expect(writeIssueScanMeta).toHaveBeenCalledWith("inst", expect.objectContaining({ state: "queued" }));
    expect(runIssueScanCoordinator).toHaveBeenCalledWith("inst");
    // Order matters: the coordinator reads the meta on entry, so the "queued" write has to
    // land first.
    expect(writeIssueScanMeta.mock.invocationCallOrder[0]).toBeLessThan(
      runIssueScanCoordinator.mock.invocationCallOrder[0],
    );
  });

  test("a stage that throws is retried, not failed on the first bad run", async () => {
    readFullScanMeta.mockResolvedValue(running());
    buildWorkflowSnapshot.mockRejectedValueOnce(new Error("401 scope does not match"));

    await runFullScanStep("inst", { jobToken: "job-token" });

    // Back to pending with the attempt recorded -- the scan should exhaust its retries
    // before it tells anyone a pillar did not build.
    expect(lastWrite().stages.find((s) => s.key === "workflows")).toMatchObject({
      state: "pending",
      attempts: 1,
      error: expect.stringContaining("401"),
    });
    expect(inventorySnapshotQueue.push).toHaveBeenCalled();
  });

  test("a stage retry re-queues with exponential backoff, not instantly", async () => {
    readFullScanMeta.mockResolvedValue(running());
    buildWorkflowSnapshot.mockRejectedValueOnce(new Error("400 Bad Request"));

    await runFullScanStep("inst", { jobToken: "job-token" });

    // First retry: ~20s (20 * 2^0 + jitter), never 0 -- a transient 400 must not be hammered.
    const push = inventorySnapshotQueue.push.mock.calls.at(-1)[0];
    expect(push.delayInSeconds).toBeGreaterThanOrEqual(20);
    expect(push.delayInSeconds).toBeLessThan(30);
  });

  test("a normal advance still re-queues with no delay", async () => {
    readFullScanMeta.mockResolvedValue(running({ stages: withDone(["workflows"]) }));

    await runFullScanStep("inst", { jobToken: "job-token" });

    const push = inventorySnapshotQueue.push.mock.calls.at(-1)[0];
    expect(push.delayInSeconds ?? 0).toBe(0);
  });

  test("a stage that keeps throwing eventually fails, after its attempts are spent", async () => {
    const stages = markStage(initialStages(), "workflows", { attempts: MAX_STAGE_ATTEMPTS - 1 });
    readFullScanMeta.mockResolvedValue(running({ stages }));
    buildWorkflowSnapshot.mockRejectedValueOnce(new Error("still 401"));

    await runFullScanStep("inst", { jobToken: "job-token" });

    expect(lastWrite().stages.find((s) => s.key === "workflows")).toMatchObject({
      state: "failed",
      attempts: MAX_STAGE_ATTEMPTS,
      error: expect.stringContaining("after"),
    });
    // Independent of the failed stage, the scan carries on with the rest.
    expect(inventorySnapshotQueue.push).toHaveBeenCalled();
  });

  test("skips a stage whose dependency failed rather than running it on stale input", async () => {
    const stages = markStage(withDone(["screens", "filters", "dashboards", "fields"]), "workflows", {
      state: "failed",
    });
    readFullScanMeta.mockResolvedValue(running({ stages }));

    await runFullScanStep("inst", { jobToken: "job-token" });

    // status-history joins against the workflow snapshot. Built on one that did not refresh it
    // is not a partial result, it is a wrong one.
    expect(lastWrite().stages.find((s) => s.key === "status-history")).toMatchObject({
      state: "skipped",
      error: expect.stringContaining("workflows"),
    });
  });

  // A second loop landing while an inline stage is genuinely mid-run must not run a LATER
  // stage -- and it must not hot-loop re-queueing itself either. It yields; the running
  // stage's own step advances the scan, and the stall watchdog covers a stage that died.
  test("yields without re-queueing when the next unfinished stage is already running", async () => {
    const stages = markStage(withDone(["workflows", "screens", "filters", "dashboards"]), "fields", {
      state: "running",
    });
    readFullScanMeta.mockResolvedValue(running({ currentStage: null, stages }));

    const result = await runFullScanStep("inst", { jobToken: "job-token" });

    expect(result).toMatchObject({ yielded: true, stage: "fields" });
    expect(writeFullScanMeta).not.toHaveBeenCalled();
    expect(inventorySnapshotQueue.push).not.toHaveBeenCalled();
    // Crucially, no later stage was started.
    expect(lastWrite()).toBeNull();
  });
});

// The field snapshot was the last stage to run inline, and on a large estate runSnapshot
// cannot finish in one 900s invocation -- run inline it was killed mid-walk every time, the
// orchestrator never re-queued, and the watchdog burned three recoveries before failing it
// out. It is a handoff stage now: runSnapshot chunks and re-queues itself, the orchestrator
// starts it and polls its meta. Unlike filters/dashboards a stale field build is RESUMED from
// its checkpoint, never failed-and-restarted from zero.
describe("field snapshot handoff", () => {
  const upTo = () => running({ stages: withDone(["workflows", "screens", "filters", "dashboards"]) });

  test("is catalogued as a handoff stage, not inline", () => {
    expect(fullScanStageCatalog().find((s) => s.key === "fields")?.mode).toBe("handoff");
  });

  test("starts the resumable build instead of running it inline", async () => {
    readFullScanMeta.mockResolvedValue(upTo());

    const result = await runFullScanStep("inst", { jobToken: "job-token" });

    expect(queueSnapshotBuild).toHaveBeenCalledWith("inst");
    expect(result).toMatchObject({ handedOff: true, stage: "fields" });
    expect(lastWrite().currentStage).toBe("fields");
    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith(
      expect.objectContaining({ delayInSeconds: FULL_SCAN_POLL_DELAY_SECONDS }),
    );
  });

  test("keeps waiting while the build reports progress", async () => {
    readFullScanMeta.mockResolvedValue(
      running({ currentStage: "fields", polls: 2, stageProgressSig: "building|40|v1" }),
    );
    readSnapshotMeta.mockResolvedValue({ state: "building", processedFields: 900, buildingVersion: "v1" });

    const result = await runFullScanStep("inst", { jobToken: "job-token" });

    // processedFields moved 40 -> 900, so the signature changed and patience resets.
    expect(result).toMatchObject({ waiting: true, stage: "fields", polls: 1 });
    expect(lastWrite()).toMatchObject({ stageProgressSig: "building|900|v1" });
  });

  test("marks the stage done once the snapshot reports ready", async () => {
    readFullScanMeta.mockResolvedValue(running({ currentStage: "fields", stages: withDone(["workflows", "screens"]) }));
    readSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1", processedFields: 1200 });

    await runFullScanStep("inst", { jobToken: "job-token" });

    expect(lastWrite().stages.find((s) => s.key === "fields").state).toBe("done");
    expect(lastWrite().currentStage).toBeNull();
  });

  test("resumes a stale field build from its checkpoint rather than failing the stage", async () => {
    readFullScanMeta.mockResolvedValue(running({ currentStage: "fields", polls: 1 }));
    const staleMeta = { state: "building", processedFields: 300, buildingVersion: "v1", startedAt: "old" };
    readSnapshotMeta.mockResolvedValue(staleMeta);
    isSnapshotBuildStale.mockReturnValueOnce(true);
    requeueStaleSnapshotBuild.mockResolvedValueOnce({ ...staleMeta, state: "queued" });

    const result = await runFullScanStep("inst", { jobToken: "job-token" });

    expect(requeueStaleSnapshotBuild).toHaveBeenCalledWith("inst", staleMeta);
    // "queued" is still in flight -- the stage keeps waiting, it is not retried or failed.
    expect(result).toMatchObject({ waiting: true, stage: "fields" });
  });
});

describe("waiting on a handoff stage", () => {
  // "building" with the same processed/updatedAt gives a stable signature -- no progress.
  const frozenFilterMeta = { state: "building", processed: 10, updatedAt: "t1" };
  const frozenSig = "building|10|t1";

  test("keeps waiting while the pillar is still building", async () => {
    readFullScanMeta.mockResolvedValue(running({ currentStage: "filters", polls: 3, stageProgressSig: frozenSig }));
    readFilterSnapshotMeta.mockResolvedValue(frozenFilterMeta);

    const result = await runFullScanStep("inst", { jobToken: "job-token" });

    // Signature unchanged since last poll -> patience counter climbs.
    expect(result).toMatchObject({ waiting: true, stage: "filters", polls: 4 });
    expect(lastWrite()).toMatchObject({ polls: 4 });
  });

  test("resets patience when the sub-build advances, however slowly", async () => {
    readFullScanMeta.mockResolvedValue(
      running({ currentStage: "filters", polls: 50, stageProgressSig: "building|10|t1" }),
    );
    readFilterSnapshotMeta.mockResolvedValue({ state: "building", processed: 900, updatedAt: "t2" });

    const result = await runFullScanStep("inst", { jobToken: "job-token" });

    // It moved -> it is alive, not wedged. polls goes back to 1 rather than counting toward
    // an abandon. This is what stops a slow-but-working filter build being killed.
    expect(result).toMatchObject({ waiting: true, polls: 1 });
    expect(lastWrite()).toMatchObject({ polls: 1, stageProgressSig: "building|900|t2" });
  });

  test("marks the stage done once the pillar reports ready, and advances", async () => {
    readFullScanMeta.mockResolvedValue(
      running({ currentStage: "filters", stages: withDone(["workflows", "screens"]) }),
    );
    readFilterSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });

    await runFullScanStep("inst", { jobToken: "job-token" });

    expect(lastWrite().stages.find((s) => s.key === "filters").state).toBe("done");
    expect(lastWrite().currentStage).toBeNull();
  });

  // A pillar that finishes "ready" but reports a caveat -- the issue crawl finalises even
  // when a worker fell over -- is still done, but the caveat rides along so the Scans tab
  // shows it instead of a clean tick over a partial result.
  test("carries a finished handoff stage's caveat onto the done stage", async () => {
    readFullScanMeta.mockResolvedValue(
      running({ currentStage: "filters", stages: withDone(["workflows", "screens"]) }),
    );
    readFilterSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "v1",
      lastError: "Worker 3 stopped on a Forge queue limit — re-run the scan to finish its projects.",
    });

    await runFullScanStep("inst", { jobToken: "job-token" });

    const filters = lastWrite().stages.find((s) => s.key === "filters");
    expect(filters.state).toBe("done");
    expect(filters.error).toMatch(/Forge queue limit/);
  });

  test("retries a frozen handoff stage rather than failing it on the first freeze", async () => {
    readFullScanMeta.mockResolvedValue(
      running({ currentStage: "filters", polls: 10_000, stageProgressSig: frozenSig }),
    );
    readFilterSnapshotMeta.mockResolvedValue(frozenFilterMeta);

    await runFullScanStep("inst", { jobToken: "job-token" });

    expect(lastWrite().stages.find((s) => s.key === "filters")).toMatchObject({ state: "pending", attempts: 1 });
  });

  test("a handoff stage that stays frozen through its retries is finally abandoned, not left running", async () => {
    const stages = markStage(initialStages(), "filters", { state: "running", attempts: MAX_STAGE_ATTEMPTS - 1 });
    readFullScanMeta.mockResolvedValue(
      running({ currentStage: "filters", polls: 10_000, stageProgressSig: frozenSig, stages }),
    );
    readFilterSnapshotMeta.mockResolvedValue(frozenFilterMeta);

    await runFullScanStep("inst", { jobToken: "job-token" });

    expect(lastWrite().stages.find((s) => s.key === "filters")).toMatchObject({
      state: "failed",
      error: expect.stringContaining("stopped reporting"),
    });
  });

  test("a handoff whose pillar reports failure is retried, not failed", async () => {
    readFullScanMeta.mockResolvedValue(
      running({ currentStage: "filters", stages: withDone(["workflows", "screens"]) }),
    );
    readFilterSnapshotMeta.mockResolvedValue({ state: "failed", lastError: "429 too many requests" });

    await runFullScanStep("inst", { jobToken: "job-token" });

    expect(lastWrite().stages.find((s) => s.key === "filters")).toMatchObject({
      state: "pending",
      attempts: 1,
      error: expect.stringContaining("429"),
    });
  });
});

describe("the health stage", () => {
  test("records site health through the dependency-injected wrapper, and completes", async () => {
    // Every stage done except health, so the next step runs it.
    const stages = withDone(
      fullScanStageCatalog()
        .map((s) => s.key)
        .filter((k) => k !== "health"),
    );
    readFullScanMeta.mockResolvedValue(running({ stages }));

    await runFullScanStep("inst", { jobToken: "job-token" });

    // The bug this replaces: captureSiteHealth was called with no deps and threw on every
    // scan. It is now reached through captureSiteHealthForScan, which supplies them.
    expect(captureSiteHealthForScan).toHaveBeenCalledWith("inst");
    expect(lastWrite().stages.find((s) => s.key === "health").state).toBe("done");
  });
});

describe("finishing", () => {
  const allButHealthDone = () =>
    markStage(
      withDone(
        fullScanStageCatalog()
          .map((s) => s.key)
          .filter((k) => k !== "health"),
      ),
      "health",
      { state: "failed" },
    );

  test("sweeps the failed stages back to pending for another whole pass before giving up", async () => {
    readFullScanMeta.mockResolvedValue(running({ stages: allButHealthDone(), sweep: 0 }));

    const result = await runFullScanStep("inst", { jobToken: "job-token" });

    // Every stage resolved but one failed -> reset it and run the scan again. A scan should
    // exhaust its retries before it reports that a pillar did not build.
    expect(result).toMatchObject({ sweeping: true, sweep: 1 });
    expect(lastWrite().stages.find((s) => s.key === "health")).toMatchObject({ state: "pending", attempts: 0 });
    expect(lastWrite().sweep).toBe(1);
  });

  test("reports completed-with-failures once the retry sweeps are spent", async () => {
    readFullScanMeta.mockResolvedValue(running({ stages: allButHealthDone(), sweep: MAX_SCAN_SWEEPS }));

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

  test("records the finished run for run-over-run comparison", async () => {
    readFullScanMeta.mockResolvedValue(
      running({
        stages: withDone(fullScanStageCatalog().map((s) => s.key)),
        startedAt: "2026-08-27T10:00:00.000Z",
        sweep: 1,
      }),
    );

    await runFullScanStep("inst", { jobToken: "job-token" });

    expect(recordFullScanRun).toHaveBeenCalledTimes(1);
    const [scope, run] = recordFullScanRun.mock.calls[0];
    expect(scope).toBe("inst");
    expect(run).toMatchObject({
      runId: "job-token",
      scanType: "full",
      state: "ready",
      sweep: 1,
      startedAt: "2026-08-27T10:00:00.000Z",
    });
    expect(run.stages.map((s) => s.key)).toEqual(fullScanStageCatalog().map((s) => s.key));
  });

  test("a failed run-history write never fails the scan", async () => {
    readFullScanMeta.mockResolvedValue(running({ stages: withDone(fullScanStageCatalog().map((s) => s.key)) }));
    recordFullScanRun.mockRejectedValueOnce(new Error("history table gone"));

    const result = await runFullScanStep("inst", { jobToken: "job-token" });

    expect(result).toMatchObject({ completed: true });
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

    expect(keys).toEqual(
      expect.arrayContaining([
        "workflows",
        "screens",
        "filters",
        "dashboards",
        "fields",
        "status-history",
        "issue-types",
        "issues",
        "health",
      ]),
    );
    // Automation is excluded deliberately: Jira publishes no API to enumerate rules, so a scan
    // that included it would be claiming coverage it does not have.
    expect(keys).not.toContain("automation");
  });
});

// Quick scan reuses the exact same engine above, parameterized by a different spec -- these
// pin the two things unique to it: that it reaches the delta issue job through the dynamic
// import rather than the full crawl, and that it can never run at the same time as a full
// scan, because both would race the same handoff-stage builds otherwise.
describe("quick scan", () => {
  const withQuickDone = (keys) =>
    keys.reduce((stages, key) => markStage(stages, key, { state: "done" }), initialStages(QUICK_SCAN_STAGES));

  const runningQuick = (over = {}) => ({
    state: "running",
    scanType: "quick",
    jobToken: "job-token",
    currentStage: null,
    stages: initialStages(QUICK_SCAN_STAGES),
    polls: 0,
    ...over,
  });

  test("seeds every quick-scan stage as pending and queues the run-quick-scan job", async () => {
    readFullScanMeta.mockResolvedValue(null);

    const result = await startQuickScan("inst", { quickScanWindowHours: 48 });

    expect(result).toMatchObject({ started: true });
    const patch = lastWrite();
    expect(patch.scanType).toBe("quick");
    expect(patch.stages.map((s) => s.key)).toEqual(QUICK_SCAN_STAGES.map((s) => s.key));
    // Persisted on the row, not held in a closure -- the stage that needs it runs several
    // invocations later, in a different process.
    expect(patch.quickScanWindowHours).toBe(48);
    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ jobType: "run-quick-scan", installationKey: "inst" }),
      }),
    );
  });

  test("refuses to start over a FULL scan that is running", async () => {
    readFullScanMeta.mockResolvedValue({ state: "running", scanType: "full" });

    const result = await startQuickScan("inst");

    // Both scan types share one meta row and one mutual-exclusion check on purpose: a quick
    // scan starting mid-full-scan would race the same filter/dashboard builds the full scan
    // is already running.
    expect(result).toMatchObject({ started: false, reason: "already-running" });
    expect(inventorySnapshotQueue.push).not.toHaveBeenCalled();
  });

  test("clears any window left over from a previous quick scan when a full scan starts", async () => {
    readFullScanMeta.mockResolvedValue(null);

    await startFullScan("inst");

    // A full scan run after a quick scan must not silently inherit the quick scan's window
    // from the shared row.
    expect(lastWrite().quickScanWindowHours).toBeNull();
    expect(lastWrite().scanType).toBe("full");
  });

  test("hands the issues-delta stage off to the delta job, with the stored window", async () => {
    readFullScanMeta.mockResolvedValue(
      runningQuick({
        stages: withQuickDone(["workflows", "screens", "filters", "dashboards"]),
        quickScanWindowHours: 72,
      }),
    );

    const result = await runQuickScanStep("inst", { jobToken: "job-token" });

    expect(result).toMatchObject({ handedOff: true, stage: "issues-delta" });
    expect(runDeltaIssueScanJob).toHaveBeenCalledWith("inst", 72);
  });

  test("polls the delta job's OWN meta row, under the delta scope suffix", async () => {
    readFullScanMeta.mockResolvedValue(runningQuick({ currentStage: "issues-delta" }));
    readIssueScanMeta.mockResolvedValue({ state: "building" });

    await runQuickScanStep("inst", { jobToken: "job-token" });

    // Not "inst" -- the delta job's state lives under "inst::delta", genuinely separate from
    // the full crawl's own meta, which is why they can coexist without colliding.
    expect(readIssueScanMeta).toHaveBeenCalledWith("inst::delta");
  });

  test("does not run the fields stage at all -- the delta job already covers it", async () => {
    readFullScanMeta.mockResolvedValue(runningQuick());

    await runQuickScanStep("inst", { jobToken: "job-token" });

    // First stage is workflows, same as full scan; fields never appears in the quick list.
    const stages = lastWrite().stages.map((s) => s.key);
    expect(stages).not.toContain("fields");
  });

  test("ignores a step meant for the other scan type", async () => {
    // A full scan is running under the shared row; a stray quick-scan message must not step
    // its stage list as if it were a quick scan's own.
    readFullScanMeta.mockResolvedValue({ state: "running", scanType: "full", jobToken: "job-token" });

    const result = await runQuickScanStep("inst", { jobToken: "job-token" });

    expect(result).toMatchObject({ ignored: true, reason: "wrong-scan-type" });
  });

  test("covers the four structural pillars, collapses fields+issues, and excludes automation", () => {
    const keys = quickScanStageCatalog().map((s) => s.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "workflows",
        "screens",
        "filters",
        "dashboards",
        "issue-types",
        "issues-delta",
        "health",
      ]),
    );
    expect(keys).not.toContain("fields");
    expect(keys).not.toContain("issues");
    expect(keys).not.toContain("automation");
  });
});

// The step machine cannot rescue itself from a lost queue message -- the thing that would
// notice is the thing that stopped being called. recoverStalledScan runs from outside that
// loop, on the hourly trigger, and re-enters it from the last checkpoint.
describe("stall recovery", () => {
  const NOW = 10_000_000;
  const stalledBeat = new Date(NOW - (FULL_SCAN_STALL_MS + 60_000)).toISOString();
  const freshBeat = new Date(NOW - 60_000).toISOString();

  test("does nothing when no scan is running", async () => {
    readFullScanMeta.mockResolvedValue({ state: "ready" });
    expect(await recoverStalledScan("inst", { now: NOW })).toMatchObject({ recovered: false, reason: "not-running" });
    expect(inventorySnapshotQueue.push).not.toHaveBeenCalled();
  });

  test("leaves a run alone while its loop is still touching the meta row", async () => {
    readFullScanMeta.mockResolvedValue(running({ currentStage: "filters", updatedAt: freshBeat }));

    expect(await recoverStalledScan("inst", { now: NOW })).toMatchObject({ recovered: false, reason: "healthy" });
    expect(writeFullScanMeta).not.toHaveBeenCalled();
    expect(inventorySnapshotQueue.push).not.toHaveBeenCalled();
  });

  test("re-queues a step for the handoff stage in flight, and counts the attempt", async () => {
    const stages = markStage(withDone(["workflows", "screens"]), "filters", { state: "running" });
    readFullScanMeta.mockResolvedValue(running({ currentStage: "filters", stages, updatedAt: stalledBeat }));

    const result = await recoverStalledScan("inst", { now: NOW });

    expect(result).toMatchObject({ recovered: true, stage: "filters", recoveryCount: 1 });
    expect(lastWrite()).toMatchObject({ recoveryCount: 1 });
    // The handoff stage is resumed through its own poll, not re-run -- its stage row is
    // carried through unchanged.
    expect(lastWrite().stages.find((s) => s.key === "filters").state).toBe("running");
    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ jobType: "run-full-scan", stage: "filters", jobToken: "job-token" }),
      }),
    );
  });

  test("resets an inline stage that died mid-run back to pending before re-kicking", async () => {
    const stages = markStage(withDone(["workflows", "screens", "filters", "dashboards"]), "fields", {
      state: "running",
    });
    readFullScanMeta.mockResolvedValue(running({ currentStage: null, stages, updatedAt: stalledBeat }));

    await recoverStalledScan("inst", { now: NOW });

    // nextStage skips a stage stuck at "running", so without this the scan would finish
    // reporting a stage it never actually completed.
    expect(lastWrite().stages.find((s) => s.key === "fields")).toMatchObject({ state: "pending", startedAt: null });
    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ stage: null }) }),
    );
  });

  test("gives up after the recovery budget is spent, failing the run out instead of leaving it running", async () => {
    const stages = markStage(withDone(["workflows", "screens"]), "filters", { state: "running" });
    readFullScanMeta.mockResolvedValue(
      running({ currentStage: "filters", stages, updatedAt: stalledBeat, recoveryCount: MAX_SCAN_RECOVERIES }),
    );

    const result = await recoverStalledScan("inst", { now: NOW });

    expect(result).toMatchObject({ completed: true });
    // "running" is the state that blocks every future scan from starting -- so a dead run
    // has to reach a terminal state, not sit there.
    expect(lastWrite().state).toBe("completed-with-failures");
    expect(lastWrite().jobToken).toBeNull();
    expect(lastWrite().stages.find((s) => s.key === "filters")).toMatchObject({ state: "failed" });
    expect(inventorySnapshotQueue.push).not.toHaveBeenCalled();
  });

  test("force bypasses the freshness check for an operator-driven resume", async () => {
    readFullScanMeta.mockResolvedValue(running({ currentStage: "filters", updatedAt: freshBeat }));

    const result = await recoverStalledScan("inst", { now: NOW, force: true });

    expect(result).toMatchObject({ recovered: true, stage: "filters" });
    expect(inventorySnapshotQueue.push).toHaveBeenCalled();
  });

  // A zombie: the loop keeps writing updatedAt, so the heartbeat is fresh and every
  // progress-based guard resets -- but it started days ago and will never finish.
  test("fails a run out once it passes the total-duration ceiling, fresh heartbeat and all", async () => {
    const stages = markStage(withDone(["workflows", "screens", "filters", "dashboards"]), "fields", {
      state: "running",
    });
    readFullScanMeta.mockResolvedValue(
      running({
        currentStage: null,
        stages,
        updatedAt: freshBeat, // loop is alive right now
        startedAt: new Date(NOW - (MAX_SCAN_TOTAL_MS + 60_000)).toISOString(),
        recoveryCount: 0, // budget untouched -- progress kept resetting it
      }),
    );

    const result = await recoverStalledScan("inst", { now: NOW });

    expect(result).toMatchObject({ completed: true });
    expect(lastWrite().state).toBe("completed-with-failures");
    expect(lastWrite().jobToken).toBeNull();
    expect(lastWrite().stages.find((s) => s.key === "fields")).toMatchObject({ state: "failed" });
    expect(lastWrite().stages.find((s) => s.key === "issues")).toMatchObject({ state: "skipped" });
    expect(inventorySnapshotQueue.push).not.toHaveBeenCalled();
  });

  test("leaves a long-but-under-the-ceiling run alone", async () => {
    readFullScanMeta.mockResolvedValue(
      running({
        currentStage: "issues",
        updatedAt: freshBeat,
        startedAt: new Date(NOW - (MAX_SCAN_TOTAL_MS - 60 * 60 * 1000)).toISOString(), // an hour short
      }),
    );

    const result = await recoverStalledScan("inst", { now: NOW });

    expect(result).toMatchObject({ recovered: false, reason: "healthy" });
  });

  test("re-kicks a stalled quick scan onto the quick-scan job, not the full one", async () => {
    readFullScanMeta.mockResolvedValue({
      state: "running",
      scanType: "quick",
      jobToken: "job-token",
      currentStage: "filters",
      stages: initialStages(QUICK_SCAN_STAGES),
      polls: 0,
      updatedAt: stalledBeat,
    });

    await recoverStalledScan("inst", { now: NOW });

    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ jobType: "run-quick-scan" }) }),
    );
  });

  test("a real stage transition clears the recovery budget", async () => {
    readFullScanMeta.mockResolvedValue(
      running({ currentStage: "filters", stages: withDone(["workflows", "screens"]), recoveryCount: 2 }),
    );
    readFilterSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1" });

    await runFullScanStep("inst", { jobToken: "job-token" });

    // The advance write, after filters resolved.
    expect(lastWrite().recoveryCount).toBe(0);
  });

  // Forge queue delivery is at-least-once. The step this recovery thinks is lost may only be
  // slow -- so recovery rotates the job token, and runScanStep then rejects the older message
  // as stale rather than letting two loops run stages concurrently and out of order.
  test("rotates the job token so a delayed original step is rejected", async () => {
    makeJobToken.mockReturnValueOnce("recovered-token");
    const stages = markStage(withDone(["workflows", "screens", "filters", "dashboards"]), "fields", {
      state: "running",
    });
    readFullScanMeta.mockResolvedValue(running({ currentStage: null, stages, updatedAt: stalledBeat }));

    await recoverStalledScan("inst", { now: NOW });

    expect(lastWrite().jobToken).toBe("recovered-token");
    expect(inventorySnapshotQueue.push).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ jobToken: "recovered-token" }) }),
    );

    // The delayed original, carrying the old token, is now a stale message.
    readFullScanMeta.mockResolvedValue(running({ jobToken: "recovered-token", stages }));
    const stale = await runFullScanStep("inst", { jobToken: "job-token" });
    expect(stale).toMatchObject({ ignored: true, reason: "stale-token" });
  });
});

describe("resumeScanRun", () => {
  const NOW = 20_000_000;

  test("only acts on a run that finished with failures", async () => {
    readFullScanMeta.mockResolvedValue({ state: "ready", stages: [] });
    expect(await resumeScanRun("inst", { now: NOW })).toMatchObject({ resumed: false, reason: "nothing-to-resume" });
    readFullScanMeta.mockResolvedValue(running());
    expect(await resumeScanRun("inst", { now: NOW })).toMatchObject({ resumed: false });
  });

  test("re-opens only the failed and skipped stages, leaving the built ones alone", async () => {
    let stages = withDone(["workflows", "screens", "filters"]);
    stages = markStage(stages, "dashboards", { state: "failed", attempts: 3, error: "400 Bad Request" });
    stages = markStage(stages, "fields", { state: "skipped" });
    readFullScanMeta.mockResolvedValue({
      state: "completed-with-failures",
      scanType: "full",
      stages,
      startedAt: new Date(NOW - 5 * 60 * 60 * 1000).toISOString(),
    });

    const result = await resumeScanRun("inst", { now: NOW });

    expect(result).toMatchObject({ resumed: true, retrying: ["dashboards", "fields"] });
    const w = lastWrite();
    expect(w.state).toBe("running");
    expect(w.jobToken).toBeTruthy();
    // Fresh startedAt so the 8-hour ceiling measures the resumed leg.
    expect(new Date(w.startedAt).getTime()).toBe(NOW);
    expect(w.stages.find((s) => s.key === "workflows").state).toBe("done");
    expect(w.stages.find((s) => s.key === "dashboards")).toMatchObject({ state: "pending", attempts: 0, error: null });
    expect(w.stages.find((s) => s.key === "fields").state).toBe("pending");
    expect(inventorySnapshotQueue.push).toHaveBeenCalled();
  });

  test("nothing-to-resume when the finished run has no failed or skipped stages", async () => {
    readFullScanMeta.mockResolvedValue({
      state: "completed-with-failures",
      stages: withDone(fullScanStageCatalog().map((s) => s.key)),
    });
    expect(await resumeScanRun("inst", { now: NOW })).toMatchObject({ resumed: false, reason: "nothing-to-resume" });
  });
});

describe("cancelling a scan", () => {
  test("does nothing when no scan is running", async () => {
    readFullScanMeta.mockResolvedValue({ state: "ready" });
    expect(await cancelScan("inst")).toMatchObject({ cancelled: false, reason: "not-running" });
  });

  test("writes a terminal cancelled state, drops the job token, and settles every stage", async () => {
    const stages = markStage(withDone(["workflows", "screens"]), "filters", { state: "running" });
    readFullScanMeta.mockResolvedValue(running({ currentStage: "filters", stages }));

    const result = await cancelScan("inst", { now: 5000 });

    expect(result).toMatchObject({ cancelled: true, scanType: "full" });
    const patch = lastWrite();
    expect(patch.state).toBe("cancelled");
    // A step still in the queue is ignored as a stale message once the token is gone.
    expect(patch.jobToken).toBeNull();
    expect(patch.stages.find((s) => s.key === "workflows").state).toBe("done");
    expect(patch.stages.find((s) => s.key === "filters").state).toBe("failed");
    expect(patch.stages.find((s) => s.key === "fields").state).toBe("skipped");
  });

  test("a cancelled run no longer blocks a fresh scan from starting", async () => {
    readFullScanMeta.mockResolvedValue({ state: "cancelled", scanType: "full" });

    expect(await startFullScan("inst")).toMatchObject({ started: true });
  });
});
