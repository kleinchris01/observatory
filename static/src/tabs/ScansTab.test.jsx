import React from "react";
import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScanDeltaChart, ScanThroughputChart, UniverseScanPanel } from "./ScansTab";

// ScansTab had no tests. These cover the two charts added to make the Universe Scan panel
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

describe("UniverseScanPanel run-derived series", () => {
  const noop = () => {};
  const panel = (issueScan) =>
    render(
      <UniverseScanPanel
        issueScan={issueScan}
        onStart={noop}
        onResume={noop}
        onCancel={noop}
        issueScanLoading={false}
        issueScanResuming={false}
        issueScanCancelling={false}
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
