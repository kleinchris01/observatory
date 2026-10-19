import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { fireEvent } from "@testing-library/react";
import { RemediationProgress, integerTicks, tickIndices } from "./RemediationProgress";

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

beforeEach(() => vi.clearAllMocks());

// A computeRemediationMetrics result, trimmed to what the view reads.
function metrics(over = {}) {
  return {
    scope: "quarter",
    period: "2026-Q3",
    totals: {
      tasks: 10,
      open: 4,
      closed: 6,
      pctClosed: 60,
      closedLast7: 3,
      closedLast30: 6,
      unassignedOpen: 2,
      cameBack: 0,
    },
    timing: {
      medianDaysToClose: 4.5,
      oldestOpenDays: 21,
      ratePerWeek: 2.5,
      projectedClearDate: "2026-09-30",
      quarterEnd: "2026-09-30",
      onTrack: true,
    },
    burndown: [
      { date: "2026-09-26", open: 6, pace: 6 },
      { date: "2026-09-27", open: 5, pace: 4 },
      { date: "2026-09-28", open: 4, pace: 2 },
      { date: "2026-09-29", open: null, pace: 1 },
      { date: "2026-09-30", open: null, pace: 0 },
    ],
    throughput: [
      { weekStart: "2026-09-21", closed: 3, created: 5 },
      { weekStart: "2026-09-28", closed: 3, created: 0 },
    ],
    ageing: [
      { key: "under-7", label: "Under 7 days", count: 1 },
      { key: "7-30", label: "7–30 days", count: 3 },
      { key: "30-90", label: "30–90 days", count: 0 },
      { key: "over-90", label: "Over 90 days", count: 0 },
    ],
    byFinding: [
      {
        findingKey: "filter-ownership",
        label: "Filter ownership",
        total: 10,
        open: 4,
        closed: 6,
        pctClosed: 60,
        oldestOpenDays: 21,
      },
    ],
    byAssignee: [
      { name: "Sam", count: 2 },
      { name: "Unassigned", count: 2 },
    ],
    sync: { lastSyncedAt: new Date().toISOString(), neverSynced: 0 },
    ...over,
  };
}

describe("RemediationProgress", () => {
  test("shows the headline numbers for this quarter", async () => {
    invoke.mockResolvedValueOnce(metrics());
    render(<RemediationProgress />);
    expect((await screen.findAllByText("Open tasks")).length).toBeGreaterThan(0);
    expect(invoke).toHaveBeenCalledWith("getRemediationMetrics", { scope: "quarter" });
    expect(screen.getByText("2 unassigned")).toBeInTheDocument();
    expect(screen.getByText("60% of 10")).toBeInTheDocument();
    expect(screen.getByText("4.5 d")).toBeInTheDocument();
    expect(screen.getByText(/On track for quarter end/)).toBeInTheDocument();
    expect(screen.getByText(/Syncs at 8am, 12pm and 4pm Pacific/)).toBeInTheDocument();
  });

  test("lays out the burn-down, throughput, ageing, assignee and finding panels", async () => {
    invoke.mockResolvedValueOnce(metrics());
    render(<RemediationProgress />);
    expect(await screen.findByText("Burn-down")).toBeInTheDocument();
    expect(screen.getByText("Closed per week")).toBeInTheDocument();
    expect(screen.getByText("Age of open tasks")).toBeInTheDocument();
    expect(screen.getByText("7–30 days")).toBeInTheDocument();
    expect(screen.getByText("Sam")).toBeInTheDocument();
    expect(screen.getAllByText("Filter ownership").length).toBeGreaterThan(0);
    // Every chart has a table view.
    expect(screen.getAllByText("View as table").length).toBeGreaterThanOrEqual(2);
  });

  test("switches to every quarter", async () => {
    invoke.mockResolvedValueOnce(metrics()).mockResolvedValueOnce(metrics({ scope: "all" }));
    const user = userEvent.setup();
    render(<RemediationProgress />);
    await screen.findByText("Burn-down");
    await user.click(screen.getByRole("button", { name: "All quarters" }));
    expect(invoke).toHaveBeenLastCalledWith("getRemediationMetrics", { scope: "all" });
    expect(screen.getByRole("button", { name: "All quarters" })).toHaveAttribute("aria-pressed", "true");
  });

  test("warns when the projection runs past quarter end", async () => {
    invoke.mockResolvedValueOnce(
      metrics({ timing: { ...metrics().timing, projectedClearDate: "2026-11-15", onTrack: false } }),
    );
    render(<RemediationProgress />);
    expect(await screen.findByText(/After quarter end/)).toBeInTheDocument();
  });

  test("has no projection rather than inventing one when nothing closed recently", async () => {
    invoke.mockResolvedValueOnce(metrics({ timing: { ...metrics().timing, projectedClearDate: null, onTrack: null } }));
    render(<RemediationProgress />);
    expect(await screen.findByText("Nothing closed in the last 14 days")).toBeInTheDocument();
  });

  test("notes items that came back after an earlier quarter", async () => {
    invoke.mockResolvedValueOnce(metrics({ totals: { ...metrics().totals, cameBack: 2 } }));
    render(<RemediationProgress />);
    expect(await screen.findByText(/2 items came back/)).toBeInTheDocument();
  });

  test("points to Findings when there are no tasks yet", async () => {
    invoke.mockResolvedValueOnce(metrics({ totals: { ...metrics().totals, tasks: 0 } }));
    render(<RemediationProgress />);
    expect(await screen.findByText(/No remediation tasks in 2026-Q3/)).toBeInTheDocument();
  });

  test("shows an error rather than a blank page when the metrics fail", async () => {
    invoke.mockRejectedValueOnce(new Error("boom"));
    render(<RemediationProgress />);
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});

describe("chart helpers", () => {
  test("integerTicks starts at zero, steps in whole numbers and covers the maximum", () => {
    expect(integerTicks(6)).toEqual([0, 2, 4, 6]);
    expect(integerTicks(11)).toEqual([0, 5, 10, 15]);
    expect(integerTicks(3)).toEqual([0, 1, 2, 3]);
    expect(integerTicks(0)).toEqual([0, 1]);
    expect(integerTicks(140)).toEqual([0, 50, 100, 150]);
  });

  test("tickIndices thins labels so they stay at least the minimum gap apart", () => {
    expect(tickIndices(0, 20)).toEqual([]);
    expect(tickIndices(5, 100)).toEqual([0, 1, 2, 3, 4]);
    expect(tickIndices(10, 20)).toEqual([0, 4, 8]);
  });
});

describe("RemediationProgress charts", () => {
  test("draw the open and pace lines with end labels and a Today marker", async () => {
    invoke.mockResolvedValueOnce(metrics());
    const { container } = render(<RemediationProgress />);
    await screen.findByText("Burn-down");
    expect(container.querySelector(".rp-chart__line:not(.rp-chart__line--reference)")).not.toBeNull();
    expect(container.querySelector(".rp-chart__line--reference")).not.toBeNull();
    const ends = [...container.querySelectorAll(".remediation-progress__endlabel")].map((t) => t.textContent);
    expect(ends).toEqual(["Open", "Pace"]);
    expect(screen.getByText("Today")).toBeInTheDocument();
    // Two weeks closed, so two bars.
    expect(container.querySelectorAll(".rp-chart__bar")).toHaveLength(2);
  });

  test("hovering the burn-down shows that day's values", async () => {
    invoke.mockResolvedValueOnce(metrics());
    const { container } = render(<RemediationProgress />);
    await screen.findByText("Burn-down");
    const hit = container.querySelector(".rp-chart svg rect[fill='transparent']");
    hit.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 260 });
    fireEvent.mouseMove(hit, { clientX: 40, clientY: 100 });
    const tip = container.querySelector(".rp-chart__tooltip");
    expect(tip).toHaveTextContent("Open tasks: 6");
    expect(tip).toHaveTextContent("Pace: 6");
    fireEvent.mouseLeave(hit);
    expect(container.querySelector(".rp-chart__tooltip")).toBeNull();
  });

  test("hovering a week shows how many closed", async () => {
    invoke.mockResolvedValueOnce(metrics());
    const { container } = render(<RemediationProgress />);
    await screen.findByText("Closed per week");
    const bars = container.querySelectorAll(".rp-chart__bar");
    fireEvent.mouseEnter(bars[1].parentNode);
    expect(container.querySelector(".rp-chart__tooltip")).toHaveTextContent("Closed: 3");
    fireEvent.mouseLeave(bars[1].parentNode);
    expect(container.querySelector(".rp-chart__tooltip")).toBeNull();
  });
});
