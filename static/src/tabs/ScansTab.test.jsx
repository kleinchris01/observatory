import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import {
  ScanDeltaChart,
  ScanThroughputChart,
  IssueCrawlLiveView,
  FullScanPanel,
  QuickScanPanel,
  useVisiblePolling,
} from "./ScansTab";
import userEvent from "@testing-library/user-event";
import { renderHook, act } from "@testing-library/react";

// ScansTab had no tests. These cover the two charts added to make the issue crawl's live view
// readable, and they test the arithmetic rather than the markup -- the SVG is presentational,
// but a delta computed off the wrong neighbour or a rate divided by the wrong interval is a
// chart that confidently states something false.

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn().mockResolvedValue({}),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

const run = (completedAt, processedIssues, startedAt = null) => ({
  startedAt,
  completedAt,
  processedIssues,
  progressLog: [],
});

describe("ScanDeltaChart", () => {
  test("asks for a second run rather than charting a single total", () => {
    render(<ScanDeltaChart data={[]} />);
    expect(screen.getByText(/needs two completed runs/i)).toBeInTheDocument();
  });

  test("draws one bar per delta, not one per run", () => {
    const { container } = render(
      <ScanDeltaChart
        data={[
          { delta: 1657, label: "Aug 5" },
          { delta: 900, label: "Aug 3" },
        ]}
      />,
    );
    expect(container.querySelectorAll("rect")).toHaveLength(2);
  });

  // Growth and shrinkage have to be visually distinguishable, because a scan that finds
  // fewer issues than the last one is a signal, not a smaller success.
  test("colours a negative delta differently from a positive one", () => {
    const { container } = render(
      <ScanDeltaChart
        data={[
          { delta: 500, label: "a" },
          { delta: -200, label: "b" },
        ]}
      />,
    );
    const fills = [...container.querySelectorAll("rect")].map((r) => r.getAttribute("fill"));
    expect(new Set(fills).size).toBe(2);
  });

  // With no negatives the zero line sits on the floor, so the whole height encodes growth.
  // Reserving half the chart for negatives that never occur halves the resolution.
  test("keeps the full height for growth when nothing shrank", () => {
    const { container } = render(
      <ScanDeltaChart
        data={[
          { delta: 100, label: "a" },
          { delta: 50, label: "b" },
        ]}
      />,
    );
    const tallest = Math.max(...[...container.querySelectorAll("rect")].map((r) => Number(r.getAttribute("height"))));
    expect(tallest).toBeGreaterThan(90);
  });
});

describe("ScanThroughputChart", () => {
  test("reports having no timed runs rather than drawing an empty axis", () => {
    render(<ScanThroughputChart data={[]} />);
    expect(screen.getByText(/no completed runs with timing/i)).toBeInTheDocument();
  });

  test("draws a duration bar and a rate point per run", () => {
    const { container } = render(
      <ScanThroughputChart
        data={[
          { minutes: 108, rate: 50, label: "Aug 5" },
          { minutes: 96, rate: 57, label: "Aug 3" },
        ]}
      />,
    );
    expect(container.querySelectorAll("rect")).toHaveLength(2);
    expect(container.querySelectorAll("circle")).toHaveLength(2);
  });
});

describe("IssueCrawlLiveView run-derived series", () => {
  const noop = () => {};
  const panel = (issueScan) =>
    render(
      <IssueCrawlLiveView issueScan={issueScan} onResume={noop} onCancel={noop} resuming={false} cancelling={false} />,
    );

  // The whole point of the delta chart: totals that barely move still produce a readable
  // growth series. Two runs one issue apart must still yield a chart.
  test("derives a delta series from consecutive run totals", () => {
    panel({
      state: "ready",
      scanHistory: [run("2026-08-03T00:00:00Z", 326871), run("2026-08-05T00:00:00Z", 328528)],
    });
    expect(screen.getByText(/net new issues/i)).toBeInTheDocument();
  });

  test("shows no delta chart until a second run exists", () => {
    panel({ state: "ready", scanHistory: [run("2026-08-05T00:00:00Z", 328528)] });
    expect(screen.queryByText(/net new issues/i)).not.toBeInTheDocument();
  });

  // A run missing a start or completion timestamp is unmeasured, and an unmeasured run is
  // not a zero-minute run. Charting it as zero would invent a suspiciously fast scan.
  test("excludes runs with no timing from the throughput chart", () => {
    panel({ state: "ready", scanHistory: [run("2026-08-05T00:00:00Z", 100), run(null, 200)] });
    expect(screen.queryByText(/duration & throughput/i)).not.toBeInTheDocument();
  });

  test("includes a run once both timestamps are present", () => {
    panel({
      state: "ready",
      scanHistory: [run("2026-08-05T01:00:00Z", 328528, "2026-08-05T00:00:00Z")],
    });
    expect(screen.getByText(/duration & throughput/i)).toBeInTheDocument();
  });
});

// Every running stage shows a percentage. A handoff sub-build reporting a real count gets a
// measured one; every other stage gets a timing estimate against how it ran in previous
// runs, shown with a hatched bar and a "~" so it never reads as a measurement. Only the
// first-ever run, with no history to project from, falls back to an indeterminate sweep.
describe("FullScanPanel — the live pipeline", () => {
  const noop = () => {};
  const runningStatus = {
    state: "running",
    currentStage: "screens",
    updatedAt: new Date().toISOString(),
    startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    sweep: 0,
    catalog: [
      { key: "workflows", label: "Workflow & status inventory", mode: "inline" },
      { key: "screens", label: "Screen & scheme inventory", mode: "inline" },
      { key: "filters", label: "Saved filter inventory", mode: "handoff" },
    ],
    stages: [
      {
        key: "workflows",
        state: "done",
        startedAt: "2026-08-27T10:00:00Z",
        completedAt: "2026-08-27T10:00:12Z",
        attempts: 1,
      },
      { key: "screens", state: "running", startedAt: "2026-08-27T10:00:12Z", attempts: 1 },
      { key: "filters", state: "pending", attempts: 0 },
    ],
    recentRuns: [],
  };

  function panel(status, extra = {}) {
    return render(
      <FullScanPanel
        status={status}
        onStart={noop}
        starting={false}
        onResumeStalledScan={noop}
        onAbandonScan={noop}
        recoveringScan={false}
        abandoningScan={false}
        issueScan={null}
        onResumeIssueScan={noop}
        onCancelIssueScan={noop}
        resumingIssueScan={false}
        cancellingIssueScan={false}
        snapshot={null}
        onForceResumeSnapshot={noop}
        forceResumingSnapshot={false}
        onSnapshotCleared={noop}
        {...extra}
      />,
    );
  }

  test("shows the running band with the current stage, its position and a ticking beat", () => {
    const { container } = panel(runningStatus);
    const band = container.querySelector(".scan-now");
    expect(within(band).getByText("Screen & scheme inventory")).toBeInTheDocument();
    expect(within(band).getByText(/stage 2 of 3/)).toBeInTheDocument();
    expect(within(band).getByText(/last update .* ago/)).toBeInTheDocument();
  });

  test("renders one rail node per catalog stage, marking the running one", () => {
    const { container } = panel(runningStatus);
    const nodes = container.querySelectorAll(".stage-rail__node");
    expect(nodes).toHaveLength(3);
    expect(container.querySelector(".stage-rail__node--current")).toHaveTextContent("Screen & scheme inventory");
  });

  test("no running band once the scan is idle", () => {
    panel({ ...runningStatus, state: "idle", currentStage: null });
    expect(document.querySelector(".scan-now")).toBeNull();
  });

  test("the Cancel button in the band is wired the whole time a scan runs", async () => {
    const onAbandonScan = vi.fn();
    panel(runningStatus, { onAbandonScan });
    // Stall notice is NOT shown (updatedAt is fresh), but Cancel still is.
    expect(screen.queryByText(/has not reported progress/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Cancel scan/i }));
    expect(onAbandonScan).toHaveBeenCalledTimes(1);
  });

  test("shows a real percentage on a counted handoff stage", () => {
    panel({
      ...runningStatus,
      currentStage: "filters",
      currentStageProgress: { processed: 1200, total: 4115, lastError: null },
    });
    expect(screen.getByText(/1,200 of 4,115 \(29%\)/)).toBeInTheDocument();
  });

  // The bug from the screenshot: processed past total clamps to a meaningless 100%.
  test("refuses to show 'X of Y' when processed has run past total", () => {
    panel({
      ...runningStatus,
      currentStage: "filters",
      currentStageProgress: { processed: 1886, total: 613, lastError: null },
    });
    expect(screen.queryByText(/1,886 of 613/)).not.toBeInTheDocument();
    expect(screen.getByText(/1,886 processed/)).toBeInTheDocument();
  });

  test("surfaces the sub-build's last error in the band", () => {
    panel({ ...runningStatus, currentStageProgress: { processed: 0, total: 0, lastError: "Jira returned 429" } });
    expect(screen.getByText(/Last error: Jira returned 429/)).toBeInTheDocument();
  });

  // The complaint this addresses: an inline stage that reports no count used to show a bare
  // "no percentage to show". Now it projects one from how the stage timed in past runs.
  test("estimates a percentage from previous runs for a stage with no count of its own", () => {
    const startedAt = new Date(Date.now() - 60 * 1000).toISOString();
    const { container } = panel({
      ...runningStatus,
      currentStage: "screens",
      stages: runningStatus.stages.map((s) => (s.key === "screens" ? { ...s, startedAt } : s)),
      recentRuns: [{ runId: "r1", stages: [{ key: "screens", state: "done", durationMs: 600000, count: 700 }] }],
    });
    const band = container.querySelector(".scan-now");
    expect(within(band).getByText(/~\d+% · estimated from previous runs/)).toBeInTheDocument();
    expect(band.querySelector(".stage-progress__fill--estimated")).toBeInTheDocument();
    expect(within(band).queryByText(/no percentage to show/)).not.toBeInTheDocument();
  });

  test("holds the estimate at 99% and says so when a stage runs longer than before", () => {
    const startedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const { container } = panel({
      ...runningStatus,
      currentStage: "screens",
      stages: runningStatus.stages.map((s) => (s.key === "screens" ? { ...s, startedAt } : s)),
      recentRuns: [{ runId: "r1", stages: [{ key: "screens", state: "done", durationMs: 60000 }] }],
    });
    expect(
      within(container.querySelector(".scan-now")).getByText(/~99% · running longer than last time/),
    ).toBeInTheDocument();
  });

  // The one case where an honest answer is "we cannot say yet".
  test("falls back to an indeterminate sweep on the first ever run", () => {
    const { container } = panel({ ...runningStatus, currentStage: "screens", recentRuns: [] });
    const band = container.querySelector(".scan-now");
    expect(band.querySelector(".stage-progress__sweep")).toBeInTheDocument();
    expect(within(band).getByText(/no previous run to estimate from yet/)).toBeInTheDocument();
  });

  // The band already shows the running stage's bar, % and heartbeat. The detail card below
  // must not repeat them under a second "Field snapshot" heading -- it reads as two things.
  test("the running-stage detail card does not duplicate the band's progress bar", () => {
    const startedAt = new Date(Date.now() - 60 * 1000).toISOString();
    const { container } = panel({
      ...runningStatus,
      currentStage: "screens",
      stages: runningStatus.stages.map((s) => (s.key === "screens" ? { ...s, startedAt } : s)),
      recentRuns: [{ runId: "r1", stages: [{ key: "screens", state: "done", durationMs: 600000 }] }],
    });
    // The bar and its "~% estimated" caption appear exactly once, in the band.
    const band = container.querySelector(".scan-now");
    expect(within(band).getByText(/~\d+% · estimated from previous runs/)).toBeInTheDocument();
    expect(screen.getAllByText(/~\d+% · estimated from previous runs/)).toHaveLength(1);
    expect(container.querySelectorAll(".stage-progress__fill--estimated")).toHaveLength(1);
    // The detail card still renders -- with its tiles, not a bar.
    expect(screen.getByText("Produced")).toBeInTheDocument();
  });

  test("still offers Resume and Abandon once a running scan has been silent past the stall window", async () => {
    const onResumeStalledScan = vi.fn();
    const onAbandonScan = vi.fn();
    const stale = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    panel({ ...runningStatus, updatedAt: stale }, { onResumeStalledScan, onAbandonScan });

    expect(screen.getByText(/has not reported progress for over 20 minutes/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Resume \(stalled\)/i }));
    expect(onResumeStalledScan).toHaveBeenCalledTimes(1);
  });
});

describe("FullScanPanel — stage detail and run history", () => {
  const noop = () => {};
  const idleStatus = {
    state: "ready",
    currentStage: null,
    completedAt: "2026-08-27T10:47:00Z",
    catalog: [
      { key: "filters", label: "Saved filter inventory", mode: "handoff" },
      { key: "issues", label: "Issues & field usage", mode: "handoff" },
    ],
    stages: [
      {
        key: "filters",
        state: "done",
        startedAt: "2026-08-27T10:00:00Z",
        completedAt: "2026-08-27T10:01:04Z",
        attempts: 2,
      },
      {
        key: "issues",
        state: "done",
        startedAt: "2026-08-27T10:01:04Z",
        completedAt: "2026-08-27T10:47:00Z",
        attempts: 1,
      },
    ],
    recentRuns: [
      {
        runId: "r2",
        scanType: "full",
        state: "ready",
        completedAt: "2026-08-27T10:47:00Z",
        durationMs: 2_820_000,
        failedCount: 0,
        skippedCount: 0,
        totalStages: 2,
        summary: { filters: 4115, issues: 326528 },
        stages: [
          { key: "filters", state: "done", durationMs: 64000, attempts: 2, count: 4115 },
          { key: "issues", state: "done", durationMs: 2_756_000, attempts: 1, count: 326528 },
        ],
      },
      {
        runId: "r1",
        scanType: "full",
        state: "ready",
        completedAt: "2026-08-24T09:30:00Z",
        durationMs: 2_460_000,
        failedCount: 0,
        skippedCount: 0,
        totalStages: 2,
        summary: { filters: 4077, issues: 324425 },
        stages: [
          { key: "filters", state: "done", durationMs: 53000, attempts: 1, count: 4077 },
          { key: "issues", state: "done", durationMs: 2_407_000, attempts: 1, count: 324425 },
        ],
      },
    ],
  };

  function panel(status) {
    return render(
      <FullScanPanel
        status={status}
        onStart={noop}
        starting={false}
        onResumeStalledScan={noop}
        onAbandonScan={noop}
        recoveringScan={false}
        abandoningScan={false}
        issueScan={null}
        onResumeIssueScan={noop}
        onCancelIssueScan={noop}
        resumingIssueScan={false}
        cancellingIssueScan={false}
        snapshot={null}
        onForceResumeSnapshot={noop}
        forceResumingSnapshot={false}
        onSnapshotCleared={noop}
      />,
    );
  }

  test("the last stage is selected by default and shows what it produced with a run-over-run delta", () => {
    panel(idleStatus);
    // 'issues' is last, non-pending -> auto-selected.
    expect(screen.getByText("326,528")).toBeInTheDocument();
    expect(screen.getByText(/\+2,103 vs last run/)).toBeInTheDocument();
  });

  test("clicking a rail node selects it and shows its retry count", async () => {
    const { container } = panel(idleStatus);
    const filtersNode = [...container.querySelectorAll(".stage-rail__node")].find((n) =>
      n.textContent.includes("Saved filter inventory"),
    );
    await userEvent.click(filtersNode);
    expect(screen.getByText("4,115")).toBeInTheDocument();
    expect(screen.getByText(/\+38 vs last run/)).toBeInTheDocument();
    // attempts: 2 -> the retry badge and the Attempts tile
    expect(container.querySelector(".stage-rail__retry")).toHaveTextContent("⟳2");
  });

  test("lists recent runs with a clean/incomplete marker and a duration", () => {
    panel(idleStatus);
    const rows = document.querySelectorAll(".recent-runs__row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("clean");
    expect(rows[0]).toHaveTextContent("326,528 issues");
  });

  test("the empty pipeline invites a first run rather than rendering a bare table", () => {
    panel({ state: "idle", catalog: idleStatus.catalog, stages: null, recentRuns: [] });
    expect(screen.getByText(/No scan has run yet/i)).toBeInTheDocument();
  });

  // A scan that finished with a failed pillar: offer to retry just that one, not a full re-run.
  test("offers a Resume that retries only the stages that did not build", async () => {
    const onResumeStalledScan = vi.fn();
    render(
      <FullScanPanel
        status={{
          state: "completed-with-failures",
          catalog: idleStatus.catalog,
          lastError: "1 failed, 0 skipped of 8 stages.",
          stages: [
            { key: "filters", state: "done", label: "Saved filter inventory" },
            { key: "dashboards", state: "failed", label: "Dashboard inventory", error: "400 Bad Request" },
          ],
          recentRuns: [],
        }}
        onStart={noop}
        starting={false}
        onResumeStalledScan={onResumeStalledScan}
        onAbandonScan={noop}
        recoveringScan={false}
        abandoningScan={false}
        issueScan={null}
        onResumeIssueScan={noop}
        onCancelIssueScan={noop}
        resumingIssueScan={false}
        cancellingIssueScan={false}
        snapshot={null}
        onForceResumeSnapshot={noop}
        forceResumingSnapshot={false}
        onSnapshotCleared={noop}
      />,
    );

    expect(screen.getByText(/1 stage did not build \(Dashboard inventory\)/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Resume — retry 1 stage/i }));
    expect(onResumeStalledScan).toHaveBeenCalledTimes(1);
  });

  // A cancelled scan has no recorded run, so the produced count has to fall back to what the
  // pillar currently holds -- otherwise every stage reads "Produced —".
  test("shows a stage's produced count from liveStageCounts when there is no recorded run", async () => {
    const { container } = panel({
      state: "cancelled",
      catalog: idleStatus.catalog,
      stages: [
        {
          key: "filters",
          state: "done",
          startedAt: "2026-08-27T10:00:00Z",
          completedAt: "2026-08-27T10:02:00Z",
          attempts: 1,
        },
        { key: "issues", state: "skipped", attempts: 0 },
      ],
      recentRuns: [],
      liveStageCounts: { filters: 4115, issues: 326528 },
    });
    const filtersNode = [...container.querySelectorAll(".stage-rail__node")].find((n) =>
      n.textContent.includes("Saved filter inventory"),
    );
    await userEvent.click(filtersNode);
    expect(screen.getByText("4,115")).toBeInTheDocument();
  });
});

// A wedged scan plus a forgotten browser tab was an overnight of SQL for no work. The
// job-active guard existed; the visibility guard did not.
describe("useVisiblePolling", () => {
  const setVisibility = (state) => {
    Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });
  afterEach(() => vi.useRealTimers());

  test("does not poll at all when there is no active job", () => {
    const fn = vi.fn();
    renderHook(() => useVisiblePolling(false, fn, 1000));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(fn).not.toHaveBeenCalled();
  });

  test("polls on the interval while active and visible", () => {
    const fn = vi.fn();
    renderHook(() => useVisiblePolling(true, fn, 1000));
    fn.mockClear(); // the immediate call on mount
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  // The whole point: a job still running, but nobody looking at it.
  test("stops polling when the tab is hidden, even with a job running", () => {
    const fn = vi.fn();
    renderHook(() => useVisiblePolling(true, fn, 1000));
    act(() => {
      setVisibility("hidden");
    });
    fn.mockClear();
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(fn).not.toHaveBeenCalled();
  });

  // Returning to a tab after an hour should show current state, not stale state plus a wait.
  test("fetches once immediately on becoming visible again", () => {
    const fn = vi.fn();
    renderHook(() => useVisiblePolling(true, fn, 1000));
    act(() => {
      setVisibility("hidden");
    });
    fn.mockClear();
    act(() => {
      setVisibility("visible");
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("clears its timer on unmount", () => {
    const fn = vi.fn();
    const { unmount } = renderHook(() => useVisiblePolling(true, fn, 1000));
    unmount();
    fn.mockClear();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(fn).not.toHaveBeenCalled();
  });
});

// "Run automatically" used to only mutate local state, so a toggle-off silently reverted on
// the next page load. It now persists the instant it is flipped, and a dirty indicator
// covers the detail fields that still batch under Save schedule.
describe("QuickScanPanel — schedule persistence", () => {
  const noop = () => {};
  const base = {
    status: { state: "idle", catalog: [], stages: null },
    onStart: noop,
    starting: false,
    onResumeStalledScan: noop,
    onAbandonScan: noop,
    recoveringScan: false,
    abandoningScan: false,
    deltaIssueScan: null,
    onChangeSchedule: noop,
    onSaveSchedule: noop,
    savingSchedule: false,
    scheduleSaved: false,
  };

  test("flipping Run automatically calls the immediate-save handler, not just onChange", async () => {
    const onToggleScheduleEnabled = vi.fn();
    const onChangeSchedule = vi.fn();
    render(
      <QuickScanPanel
        {...base}
        schedule={{ enabled: false, frequency: "weekly", dayOfWeek: 0, hourUtc: 0, windowHours: 168 }}
        onChangeSchedule={onChangeSchedule}
        onToggleScheduleEnabled={onToggleScheduleEnabled}
        scheduleDirty={false}
      />,
    );

    await userEvent.click(screen.getByRole("switch"));
    expect(onToggleScheduleEnabled).toHaveBeenCalledWith(true);
    expect(onChangeSchedule).not.toHaveBeenCalled();
  });

  test("shows Unsaved changes and enables Save only while the detail fields differ from the server", () => {
    const { rerender } = render(
      <QuickScanPanel
        {...base}
        schedule={{ enabled: true, frequency: "weekly", dayOfWeek: 0, hourUtc: 0, windowHours: 168 }}
        onToggleScheduleEnabled={noop}
        scheduleDirty={false}
      />,
    );
    expect(screen.queryByText(/Unsaved changes/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save schedule/i })).toBeDisabled();

    rerender(
      <QuickScanPanel
        {...base}
        schedule={{ enabled: true, frequency: "daily", dayOfWeek: 0, hourUtc: 0, windowHours: 168 }}
        onToggleScheduleEnabled={noop}
        scheduleDirty={true}
      />,
    );
    expect(screen.getByText(/Unsaved changes/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save schedule/i })).toBeEnabled();
  });
});
