import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { OverviewDashboard } from "./OverviewDashboard";

// The Overview's job is to route attention: every finding must carry a count, a
// consequence, and the control that resolves it.
//
// The rule these exist to protect is that a finding whose SOURCE has not been built is
// omitted, never shown as zero. "0 duplicate statuses" and "we have never looked for
// duplicate statuses" are different statements, and only one of them is honest -- the
// first is what an admin would act on.

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn().mockResolvedValue({ totalUniqueIssues: 0, fieldCount: 0, uniqueValues: [] }),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

const dashboard = (overrides = {}) => ({
  fieldUsage: {
    findingsBySeverity: { high: 3, medium: 2, low: 1 },
    origin: { custom: 40, builtin: 10, appProvided: 2 },
    duplicateClusters: 4,
    findingsByType: [{ title: "Global context", count: 6 }],
    fieldTypeBreakdown: [{ type: "select", count: 12 }],
  },
  projects: {
    totalProjects: 3,
    totalIssues: 1000,
    medianFieldCount: 5,
    p90FieldCount: 30,
    topByIssueVolume: [{ projectKey: "ALPHA", projectName: "Alpha", totalIssueCount: 900 }],
    topByFieldCount: [{ projectKey: "CHARLIE", projectName: "Charlie", fieldCount: 40 }],
    overConfigured: [{ projectKey: "CHARLIE", projectName: "Charlie", fieldCount: 40, totalIssueCount: 2 }],
    unusedProjects: [{ projectKey: "DELTA", projectName: "Delta", fieldCount: 3 }],
    staleProjects: [{ projectKey: "ECHO", projectName: "Echo", fieldCount: 5, latestIssueUpdatedAt: "2024-01-01T00:00:00Z" }],
  },
  ...overrides,
});

const workflow = (overrides = {}) => ({
  available: true,
  state: "ready",
  refreshedAt: "2026-08-03T12:00:00Z",
  schemeCount: 83,
  statusCount: 435,
  sharedSchemes: 40,
  schemeStatusesAvailable: true,
  hasIssueCounts: true,
  duplicateGroupCount: 12,
  duplicateStatusCount: 32,
  reducibleStatusCount: 20,
  orphanCount: 7,
  safeToRemoveCount: 5,
  flaggedSchemeCount: 2,
  ...overrides,
});

const findingsSummary = { adminAttention: 4, risky: 2, cleanup: 9, standardize: 1 };

beforeEach(() => vi.clearAllMocks());

describe("OverviewDashboard — findings", () => {
  test("leads with what needs attention and routes each finding to a tab", async () => {
    const onNavigate = vi.fn();
    render(<OverviewDashboard dashboard={dashboard()} findingsSummary={findingsSummary} workflow={workflow()} onNavigate={onNavigate} />);

    expect(screen.getByText("What needs attention")).toBeInTheDocument();
    expect(screen.getByText("Fields need admin attention")).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: /Field Browser/ })[0]);
    expect(onNavigate).toHaveBeenCalledWith("fields");
  });

  test("routes workflow findings to the Workflows tab", async () => {
    const onNavigate = vi.fn();
    render(<OverviewDashboard dashboard={dashboard()} findingsSummary={findingsSummary} workflow={workflow()} onNavigate={onNavigate} />);

    expect(screen.getByText("Groups of duplicate statuses")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: /^Workflows$/ })[0]);
    expect(onNavigate).toHaveBeenCalledWith("workflows");
  });

  test("quantifies what consolidation would actually save", () => {
    render(<OverviewDashboard dashboard={dashboard()} findingsSummary={findingsSummary} workflow={workflow()} onNavigate={vi.fn()} />);
    // 20 removable, not the 32 statuses involved -- collapsing a group keeps one.
    expect(screen.getByText(/removes 20 statuses/i)).toBeInTheDocument();
  });

  test("says everything is clean rather than showing an empty list", () => {
    render(<OverviewDashboard
      dashboard={{ projects: { totalProjects: 1, topByIssueVolume: [], topByFieldCount: [] }, fieldUsage: {} }}
      findingsSummary={{ adminAttention: 0, risky: 0, cleanup: 0, standardize: 0 }}
      workflow={workflow({ duplicateGroupCount: 0, safeToRemoveCount: 0, flaggedSchemeCount: 0 })}
      onNavigate={vi.fn()}
    />);

    expect(screen.getByText(/Nothing flagged/i)).toBeInTheDocument();
  });

  // The rule: no source, no finding.
  test("omits status cleanup as a finding when the scan has not confirmed usage", () => {
    render(<OverviewDashboard
      dashboard={dashboard()}
      findingsSummary={findingsSummary}
      workflow={workflow({ hasIssueCounts: false, safeToRemoveCount: 0 })}
      onNavigate={vi.fn()}
    />);

    // Without counts, an unreachable status is a list to review, not an action to take.
    expect(screen.queryByText("Statuses never used and unreachable")).not.toBeInTheDocument();
  });

  test("omits workflow findings entirely when no workflow snapshot exists", () => {
    // Field and project sources are clean here so the empty state is reachable; the point
    // is that an unbuilt workflow snapshot contributes no findings and says why.
    render(<OverviewDashboard
      dashboard={{ fieldUsage: {}, projects: { totalProjects: 1, topByIssueVolume: [], topByFieldCount: [] } }}
      findingsSummary={{ adminAttention: 0, risky: 0, cleanup: 0, standardize: 0 }}
      workflow={{ available: false, state: "idle" }}
      onNavigate={vi.fn()}
    />);

    expect(screen.queryByText("Groups of duplicate statuses")).not.toBeInTheDocument();
    expect(screen.getByText(/Build the workflow inventory to check status and scheme health/i)).toBeInTheDocument();
  });
});

describe("OverviewDashboard — workflow panel", () => {
  test("reports scheme sharing, which is what makes correlation possible", () => {
    render(<OverviewDashboard dashboard={dashboard()} findingsSummary={findingsSummary} workflow={workflow()} onNavigate={vi.fn()} />);
    expect(screen.getByText(/40 shared by more than one project/i)).toBeInTheDocument();
  });

  test("says so when nothing is shared, because then comparison has no leverage", () => {
    render(<OverviewDashboard
      dashboard={dashboard()}
      findingsSummary={findingsSummary}
      workflow={workflow({ sharedSchemes: 0 })}
      onNavigate={vi.fn()}
    />);
    expect(screen.getByText(/no shared process to compare field usage against/i)).toBeInTheDocument();
  });

  test("shows a dash, not a zero, when workflow status data is unavailable", () => {
    render(<OverviewDashboard
      dashboard={dashboard()}
      findingsSummary={findingsSummary}
      workflow={workflow({ schemeStatusesAvailable: false, orphanCount: 0 })}
      onNavigate={vi.fn()}
    />);
    expect(screen.getByText(/workflow status data unavailable/i)).toBeInTheDocument();
  });

  test("prompts for a scan when counts are missing rather than implying zero usage", () => {
    render(<OverviewDashboard
      dashboard={dashboard()}
      findingsSummary={findingsSummary}
      workflow={workflow({ hasIssueCounts: false })}
      onNavigate={vi.fn()}
    />);
    expect(screen.getByText(/run a scan to confirm usage/i)).toBeInTheDocument();
  });
});

describe("OverviewDashboard — projects panel", () => {
  test("reports distribution alongside the leaders", () => {
    render(<OverviewDashboard dashboard={dashboard()} findingsSummary={findingsSummary} workflow={workflow()} onNavigate={vi.fn()} />);
    // A leader list is unreadable without knowing what normal looks like.
    expect(screen.getByText(/90th percentile 30/i)).toBeInTheDocument();
    expect(screen.getByText("Median fields per project")).toBeInTheDocument();
  });

  test("surfaces stale projects with when they were last touched", () => {
    render(<OverviewDashboard dashboard={dashboard()} findingsSummary={findingsSummary} workflow={workflow()} onNavigate={vi.fn()} />);
    expect(screen.getByText(/No activity in over six months/i)).toBeInTheDocument();
    expect(screen.getByText("ECHO")).toBeInTheDocument();
  });

  test("prompts for a scan when there is no project data at all", () => {
    render(<OverviewDashboard
      dashboard={{ fieldUsage: {}, projects: { totalProjects: 0 } }}
      findingsSummary={findingsSummary}
      workflow={workflow()}
      onNavigate={vi.fn()}
    />);
    expect(screen.getByText(/No project usage data yet/i)).toBeInTheDocument();
  });
});

describe("OverviewDashboard — resilience", () => {
  test("renders with no data at all rather than crashing", () => {
    render(<OverviewDashboard />);
    expect(screen.getByText("What needs attention")).toBeInTheDocument();
  });

  test("deep links are inert rather than throwing when no navigator is supplied", async () => {
    render(<OverviewDashboard dashboard={dashboard()} findingsSummary={findingsSummary} workflow={workflow()} />);
    await userEvent.click(screen.getAllByRole("button", { name: /Field Browser/ })[0]);
    expect(screen.getByText("What needs attention")).toBeInTheDocument();
  });

  test("the RQT panel degrades to dashes when its resolver fails", async () => {
    invoke.mockRejectedValue(new Error("resolver down"));
    render(<OverviewDashboard dashboard={dashboard()} findingsSummary={findingsSummary} workflow={workflow()} onNavigate={vi.fn()} />);

    await waitFor(() => expect(screen.getAllByText("—").length).toBeGreaterThan(0));
  });
});
