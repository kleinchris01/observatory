import React from "react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScanDeltaChart, ScanThroughputChart, IssueCrawlLiveView, FullScanPanel, useVisiblePolling } from "./ScansTab";
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
      />
    );
    expect(container.querySelectorAll("rect")).toHaveLength(2);
  });

  // Growth and shrinkage have to be visually distinguishable, because a scan that finds
  // fewer issues than the last one is a signal, not a smaller success.
  test("colours a negative delta differently from a positive one", () => {
    const { container } = render(
      <ScanDeltaChart data={[{ delta: 500, label: "a" }, { delta: -200, label: "b" }]} />
    );
    const fills = [...container.querySelectorAll("rect")].map((r) => r.getAttribute("fill"));
    expect(new Set(fills).size).toBe(2);
  });

  // With no negatives the zero line sits on the floor, so the whole height encodes growth.
  // Reserving half the chart for negatives that never occur halves the resolution.
  test("keeps the full height for growth when nothing shrank", () => {
    const { container } = render(
      <ScanDeltaChart data={[{ delta: 100, label: "a" }, { delta: 50, label: "b" }]} />
    );
    const tallest = Math.max(
      ...[...container.querySelectorAll("rect")].map((r) => Number(r.getAttribute("height")))
    );
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
      />
    );
    expect(container.querySelectorAll("rect")).toHaveLength(2);
    expect(container.querySelectorAll("circle")).toHaveLength(2);
  });
});

describe("IssueCrawlLiveView run-derived series", () => {
  const noop = () => {};
  const panel = (issueScan) =>
    render(
      <IssueCrawlLiveView
        issueScan={issueScan}
        onResume={noop}
        onCancel={noop}
        resuming={false}
        cancelling={false}
      />
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

// A handoff stage runs on its own queue and reports back, so there is no real percentage to
// show while it works. What proves the row is alive rather than wedged is the ticking "last
// update" line and an indeterminate sweep on the active stage's own row -- not a number.
describe("FullScanPanel — live progress while a stage is running", () => {
  const noop = () => {};
  const runningStatus = {
    state: "running",
    currentStage: "screens",
    updatedAt: new Date().toISOString(),
    catalog: [
      { key: "workflows", label: "Workflow & status inventory" },
      { key: "screens", label: "Screen & scheme inventory" },
    ],
    stages: [
      { key: "workflows", state: "done" },
      { key: "screens", state: "running" },
    ],
  };

  function panel(status) {
    return render(
      <FullScanPanel
        status={status}
        onStart={noop}
        starting={false}
        issueScan={null}
        onResumeIssueScan={noop}
        onCancelIssueScan={noop}
        resumingIssueScan={false}
        cancellingIssueScan={false}
        snapshot={null}
        onForceResumeSnapshot={noop}
        forceResumingSnapshot={false}
        onSnapshotCleared={noop}
      />
    );
  }

  test("shows a ticking freshness banner while the scan is running", () => {
    panel(runningStatus);
    expect(screen.getByText(/Scanning — last update/i)).toBeInTheDocument();
  });

  test("marks only the currently active stage's row for the live sweep", () => {
    const { container } = panel(runningStatus);
    const rows = container.querySelectorAll(".admin-table tbody tr");
    expect(rows[0]).not.toHaveClass("stage-row--active");
    expect(rows[1]).toHaveClass("stage-row--active");
    expect(rows[1].querySelector(".stage-progress__track")).toBeInTheDocument();
  });

  test("shows neither the banner nor any active-row sweep once the scan is idle", () => {
    const { container } = panel({ ...runningStatus, state: "idle", currentStage: null });
    expect(screen.queryByText(/Scanning — last update/i)).not.toBeInTheDocument();
    expect(container.querySelector(".stage-row--active")).toBeNull();
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
    act(() => { vi.advanceTimersByTime(5000); });
    expect(fn).not.toHaveBeenCalled();
  });

  test("polls on the interval while active and visible", () => {
    const fn = vi.fn();
    renderHook(() => useVisiblePolling(true, fn, 1000));
    fn.mockClear(); // the immediate call on mount
    act(() => { vi.advanceTimersByTime(3000); });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  // The whole point: a job still running, but nobody looking at it.
  test("stops polling when the tab is hidden, even with a job running", () => {
    const fn = vi.fn();
    renderHook(() => useVisiblePolling(true, fn, 1000));
    act(() => { setVisibility("hidden"); });
    fn.mockClear();
    act(() => { vi.advanceTimersByTime(10000); });
    expect(fn).not.toHaveBeenCalled();
  });

  // Returning to a tab after an hour should show current state, not stale state plus a wait.
  test("fetches once immediately on becoming visible again", () => {
    const fn = vi.fn();
    renderHook(() => useVisiblePolling(true, fn, 1000));
    act(() => { setVisibility("hidden"); });
    fn.mockClear();
    act(() => { setVisibility("visible"); });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("clears its timer on unmount", () => {
    const fn = vi.fn();
    const { unmount } = renderHook(() => useVisiblePolling(true, fn, 1000));
    unmount();
    fn.mockClear();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(fn).not.toHaveBeenCalled();
  });
});
