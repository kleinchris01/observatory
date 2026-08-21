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
    totalFieldFills: 90000,
    totalUniqueIssues: 1000,
    hasUniqueCounts: true,
    medianFieldCount: 5,
    p90FieldCount: 30,
    topByIssueVolume: [{ projectKey: "ALPHA", projectName: "Alpha", totalIssueCount: 81000, uniqueIssueCount: 900, volume: 900 }],
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

const screens = (overrides = {}) => ({
  available: true,
  state: "ready",
  totalScreens: 760,
  emptyScreens: 12,
  unresolvedScreens: 3,
  unreachedScreens: 40,
  transitionOnlyScreens: 6,
  transitionsKnown: true,
  totalOperations: 240,
  danglingOperations: 5,
  totalSchemes: 60,
  unusedSchemes: 7,
  ...overrides,
});

const automation = (overrides = {}) => ({
  available: true,
  ruleCount: 1479,
  disabledCount: 604,
  credentialRuleCount: 3,
  externalHttpCount: 22,
  noActionCount: 8,
  selfTriggeringCount: 88,
  ...overrides,
});

beforeEach(() => vi.clearAllMocks());

describe("OverviewDashboard — findings", () => {
  test("leads with what needs attention and routes each finding to a tab", async () => {
    const onNavigate = vi.fn();
    render(<OverviewDashboard dashboard={dashboard()} findingsSummary={findingsSummary} workflow={workflow()} onNavigate={onNavigate} />);

    // One panel over the score and the findings, replacing "Site health" and "What needs
    // attention" -- which stated the same facts in two vocabularies.
    expect(screen.getByText("Governance")).toBeInTheDocument();
    expect(screen.getByText("Fields need admin attention")).toBeInTheDocument();

    // The finding carries the filter that turns the destination into the set it named.
    // Routing to the tab and stopping there left the reader at page one of 1,615 fields.
    await userEvent.click(screen.getAllByRole("button", { name: /Field Browser/ })[0]);
    expect(onNavigate).toHaveBeenCalledWith("fields", { findings: "admin-attention" });
  });

  test("routes workflow findings to the Workflows tab", async () => {
    const onNavigate = vi.fn();
    render(<OverviewDashboard dashboard={dashboard()} findingsSummary={findingsSummary} workflow={workflow()} onNavigate={onNavigate} />);

    expect(screen.getByText("Groups of duplicate statuses")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: /^Workflows$/ })[0]);
    expect(onNavigate).toHaveBeenCalledWith("workflows", expect.objectContaining({ view: "insights" }));
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
    // Names every unbuilt pillar, not just the workflow one. "Nothing flagged" while three
    // of five pillars have never been looked at is a claim about coverage, not cleanliness.
    expect(screen.getByText(/unchecked rather than clean/i)).toBeInTheDocument();
    // getAllByText: the workflow panel below carries its own "no workflow inventory" empty
    // state, so this phrase legitimately appears more than once on the page.
    expect(screen.getAllByText(/no workflow inventory/i).length).toBeGreaterThan(0);
  });
});

// The gap this closes: site health scored automation and screens while the findings list --
// the part of the page an admin actually acts on -- was assembled from fields, projects and
// workflows only. A credential sitting in plaintext moved the score and named nothing.
describe("OverviewDashboard — automation and screen findings", () => {
  const renderAll = (over = {}) => render(<OverviewDashboard
    dashboard={dashboard()}
    findingsSummary={findingsSummary}
    workflow={workflow()}
    screens={screens()}
    automation={automation()}
    onNavigate={vi.fn()}
    {...over}
  />);

  test("surfaces every automation risk the analysis found", () => {
    renderAll();

    expect(screen.getByText("Automation rules storing a credential in plaintext")).toBeInTheDocument();
    expect(screen.getByText("Rules that write a field they trigger on")).toBeInTheDocument();
    expect(screen.getByText("Rules sending data outside Atlassian")).toBeInTheDocument();
    expect(screen.getByText("Rules with a trigger but no actions")).toBeInTheDocument();
    expect(screen.getByText("Disabled automation rules")).toBeInTheDocument();
  });

  test("surfaces every screen finding the inventory found", () => {
    renderAll();

    expect(screen.getByText("Scheme operations pointing at a missing screen")).toBeInTheDocument();
    expect(screen.getByText("Screens whose contents could not be read")).toBeInTheDocument();
    expect(screen.getByText("Screens nothing reaches")).toBeInTheDocument();
    expect(screen.getByText("Screens carrying no fields")).toBeInTheDocument();
    expect(screen.getByText("Screen schemes no issue type maps to")).toBeInTheDocument();
  });

  test("routes an automation finding to the Automation tab", async () => {
    const onNavigate = vi.fn();
    renderAll({ onNavigate });

    await userEvent.click(screen.getAllByRole("button", { name: /^Automation$/ })[0]);
    expect(onNavigate).toHaveBeenCalledWith("automation", expect.objectContaining({ section: expect.any(String) }));
  });

  test("routes a screen finding to the Screens tab", async () => {
    const onNavigate = vi.fn();
    renderAll({ onNavigate });

    await userEvent.click(screen.getAllByRole("button", { name: /^Screens$/ })[0]);
    expect(onNavigate).toHaveBeenCalledWith("screens", expect.objectContaining({ view: expect.any(String) }));
  });

  // The same rule the workflow findings already follow, now enforced for the two pillars
  // that had no findings at all: no source, no finding.
  test("omits both pillars entirely when neither has been built", () => {
    renderAll({ screens: { available: false }, automation: { available: false } });

    expect(screen.queryByText("Automation rules storing a credential in plaintext")).not.toBeInTheDocument();
    expect(screen.queryByText("Screens carrying no fields")).not.toBeInTheDocument();
    // And it says so, rather than letting a short list read as a clean site.
    expect(screen.getByText(/no screen inventory/i)).toBeInTheDocument();
  });

  test("shows a credential finding as critical and a disabled-rule finding as cleanup", () => {
    renderAll();

    const credential = screen.getByText("Automation rules storing a credential in plaintext").closest(".ui-gov");
    const disabled = screen.getByText("Disabled automation rules").closest(".ui-gov");

    expect(credential.className).toMatch(/ui-gov--critical/);
    expect(disabled.className).toMatch(/ui-gov--info/);
  });


  // The correction to a finding that shipped wrong: a screen a workflow transition opens is
  // in daily use while belonging to no screen scheme, and the scheme-only view called those
  // unreachable -- inviting the deletion of screens people use every time they move an issue.
  test("names screens a transition keeps alive, so they are not cleaned up", () => {
    renderAll();

    const row = screen.getByText("Screens used only by a workflow transition").closest(".ui-gov");
    expect(row).toHaveTextContent(/Do not delete these/i);
  });

  test("withdraws the unreachable claim entirely when transitions are unknown", () => {
    renderAll({ screens: screens({ unreachedScreens: null, transitionOnlyScreens: null, transitionsKnown: false }) });

    expect(screen.queryByText("Screens nothing reaches")).not.toBeInTheDocument();
    expect(screen.queryByText("Screens used only by a workflow transition")).not.toBeInTheDocument();
  });

  // Urgency moved from a band heading with rows beneath it to a label on each row, because
  // in the ledger a row's neighbours are the other metrics in its pillar rather than the
  // other findings of its severity. The tally beside the score is what the band headings
  // used to be: a count of how much of each there is.
  test("labels each row with its urgency and tallies them beside the score", () => {
    renderAll();

    expect(screen.getAllByText("Act now").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Worth reviewing").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Cleanup when convenient").length).toBeGreaterThan(0);
    expect(screen.getByText(/\d+ to act on/)).toBeInTheDocument();
    expect(screen.getByText(/\d+ to clean up/)).toBeInTheDocument();
  });

  test("finally reports the standardise count, which was computed and then dropped", () => {
    renderAll();
    expect(screen.getByText("Fields that could be standardised")).toBeInTheDocument();
  });
});

describe("OverviewDashboard — health pillars", () => {
  const health = {
    score: 58,
    grade: "E",
    dimensions: [],
    weakest: { label: "Field governance", score: 17, action: "Start with the high-severity findings." },
    pillars: [
      {
        key: "fields", label: "Fields", score: 48, grade: "E", available: true, scored: 2, total: 2,
        dimensions: [
          { key: "field-naming", label: "Field naming", available: true, score: 79, detail: "34 groups share a name." },
          { key: "field-governance", label: "Field governance", available: true, score: 17, detail: "69 high severity." },
        ],
      },
      {
        key: "screens", label: "Screens", score: null, grade: null, available: false, scored: 0, total: 2,
        reason: "No screen inventory yet.",
        dimensions: [
          { key: "screen-integrity", label: "Screen scheme integrity", available: false, score: null, reason: "No screen inventory yet." },
          { key: "screen-hygiene", label: "Screen hygiene", available: false, score: null, reason: "No screen inventory yet." },
        ],
      },
    ],
  };

  test("groups the dimension bars under their pillar with a roll-up score", () => {
    render(<OverviewDashboard dashboard={dashboard()} findingsSummary={findingsSummary} workflow={workflow()} health={health} onNavigate={vi.fn()} />);

    expect(screen.getByText("Fields")).toBeInTheDocument();
    expect(screen.getByText("48")).toBeInTheDocument();
    expect(screen.getByText("Field naming")).toBeInTheDocument();
    // Twice, deliberately: once as the weakest-dimension callout above the bars, once as its
    // own bar inside the Fields pillar.
    expect(screen.getAllByText("Field governance")).toHaveLength(2);
  });

  // One line for the pillar, not one dark bar per dimension. Three bars all reading "no
  // screen inventory yet" looks like three problems instead of one unbuilt snapshot.
  test("collapses an unmeasured pillar to a single reason", () => {
    render(<OverviewDashboard dashboard={dashboard()} findingsSummary={findingsSummary} workflow={workflow()} health={health} onNavigate={vi.fn()} />);

    // "not measured" is a statement about SCORING, so it appears against the screens
    // pillar the score covered and could not score -- not against a pillar that exists
    // only because findings landed in it.
    expect(screen.getAllByText("not measured")).toHaveLength(1);
    expect(screen.getByText("No screen inventory yet.")).toBeInTheDocument();
    expect(screen.queryByText("Screen hygiene")).not.toBeInTheDocument();
  });

  // A cached payload from before pillars existed still has to render its bars.
  test("falls back to a flat list when the score carries no pillars", () => {
    render(<OverviewDashboard
      dashboard={dashboard()}
      findingsSummary={findingsSummary}
      workflow={workflow()}
      health={{ ...health, pillars: undefined, dimensions: [{ key: "field-naming", label: "Field naming", available: true, score: 79, detail: "d" }] }}
      onNavigate={vi.fn()}
    />);

    expect(screen.getByText("Field naming")).toBeInTheDocument();
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
    // Exact match, not a substring: stale projects are now also a finding row titled
    // "Projects with no activity in over six months", and a loose regex matches both.
    expect(screen.getByText("No activity in over six months")).toBeInTheDocument();
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

  // The defect this guards: field fills were rendered under an "Issues covered" label.
  // snapshot_project_usage carries one row per field x project, so the sum counts an issue
  // once per populated field -- on a site with 90 fields per project that is a ~90x
  // overstatement presented as a precise figure.
  test("shows distinct issues, not field fills, when the scan has measured them", () => {
    render(<OverviewDashboard dashboard={dashboard()} findingsSummary={findingsSummary} workflow={workflow()} onNavigate={vi.fn()} />);

    expect(screen.getByText("Issues covered")).toBeInTheDocument();
    expect(screen.getByText("1,000")).toBeInTheDocument();
    // The fills figure must not appear anywhere in the panel under any label.
    expect(screen.queryByText("90,000")).not.toBeInTheDocument();
  });

  test("labels the figure as field fills when no scan has measured issues", () => {
    const noScan = dashboard({
      projects: { ...dashboard().projects, hasUniqueCounts: false, totalUniqueIssues: null },
    });
    render(<OverviewDashboard dashboard={noScan} findingsSummary={findingsSummary} workflow={workflow()} onNavigate={vi.fn()} />);

    // Says what it is, and says how to get the real number -- rather than presenting
    // an unmeasurable quantity under an issue-shaped label.
    expect(screen.getByText("Field fills")).toBeInTheDocument();
    expect(screen.getByText("90,000")).toBeInTheDocument();
    expect(screen.queryByText("Issues covered")).not.toBeInTheDocument();
    expect(screen.getByText(/run a universe scan for issue counts/i)).toBeInTheDocument();
  });

  test("retitles the volume list to match whichever measure it is plotting", () => {
    const { unmount } = render(
      <OverviewDashboard dashboard={dashboard()} findingsSummary={findingsSummary} workflow={workflow()} onNavigate={vi.fn()} />
    );
    expect(screen.getByText("Highest issue volume")).toBeInTheDocument();
    unmount();

    const noScan = dashboard({
      projects: { ...dashboard().projects, hasUniqueCounts: false, totalUniqueIssues: null },
    });
    render(<OverviewDashboard dashboard={noScan} findingsSummary={findingsSummary} workflow={workflow()} onNavigate={vi.fn()} />);
    expect(screen.getByText("Most field fills")).toBeInTheDocument();
  });
});

describe("OverviewDashboard — resilience", () => {
  test("renders with no data at all rather than crashing", () => {
    render(<OverviewDashboard />);
    expect(screen.getByText("Governance")).toBeInTheDocument();
  });

  test("deep links are inert rather than throwing when no navigator is supplied", async () => {
    render(<OverviewDashboard dashboard={dashboard()} findingsSummary={findingsSummary} workflow={workflow()} />);
    await userEvent.click(screen.getAllByRole("button", { name: /Field Browser/ })[0]);
    expect(screen.getByText("Governance")).toBeInTheDocument();
  });

  test("the RQT panel degrades to dashes when its resolver fails", async () => {
    invoke.mockRejectedValue(new Error("resolver down"));
    render(<OverviewDashboard dashboard={dashboard()} findingsSummary={findingsSummary} workflow={workflow()} onNavigate={vi.fn()} />);

    await waitFor(() => expect(screen.getAllByText("—").length).toBeGreaterThan(0));
  });
});

// A bare score is useless and a dishonest one is worse. These pin that it always ships
// with somewhere to go, and that it says when it could not see the whole site.
describe("OverviewDashboard — site health", () => {
  const health = (over = {}) => ({
    score: 72, grade: "C", dimensionsScored: 7, dimensionsTotal: 7,
    weakest: { key: "status-naming", label: "Status naming", score: 41, action: "Consolidate duplicate statuses in the Workflows tab." },
    dimensions: [
      { key: "field-naming", label: "Field naming", available: true, score: 88, detail: "3 groups share a name." },
      { key: "status-naming", label: "Status naming", available: true, score: 41, detail: "20 of 433 statuses are redundant." },
    ],
    ...over,
  });

  test("leads with the score and names the weakest dimension with its remedy", () => {
    render(<OverviewDashboard dashboard={dashboard()} findingsSummary={findingsSummary} workflow={workflow()} health={health()} onNavigate={vi.fn()} />);

    expect(screen.getByText("72")).toBeInTheDocument();
    expect(screen.getByText("C")).toBeInTheDocument();
    // A number with nowhere to go is not actionable.
    expect(screen.getByText(/Consolidate duplicate statuses/i)).toBeInTheDocument();
  });

  test("says which dimensions it could not score", () => {
    render(<OverviewDashboard
      dashboard={dashboard()} findingsSummary={findingsSummary} workflow={workflow()}
      health={health({
        dimensionsScored: 4, dimensionsTotal: 7,
        dimensions: [
          { key: "field-naming", label: "Field naming", available: true, score: 88, detail: "ok" },
          { key: "status-naming", label: "Status naming", available: false, score: null, reason: "No workflow inventory yet." },
        ],
      })}
      onNavigate={vi.fn()} />);

    // A high score from few inputs is a weaker claim, and the reader must be able to tell.
    // Asserted on the note's full text: it is assembled from several JSX nodes, so a
    // regex against a single text node would miss the dimension names entirely.
    const note = screen.getByText(/could not be scored/i).closest("p");
    expect(note.textContent).toMatch(/Status naming/);
    expect(note.textContent).toMatch(/1 dimension could not be scored/i);
  });

  test("prompts for a build rather than showing a zero when nothing is measured", () => {
    render(<OverviewDashboard dashboard={dashboard()} findingsSummary={findingsSummary} workflow={workflow()} health={{ score: null }} onNavigate={vi.fn()} />);

    expect(screen.getByText(/unchecked rather than clean|Nothing flagged/i)).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  test("renders without a health object at all", () => {
    render(<OverviewDashboard dashboard={dashboard()} findingsSummary={findingsSummary} workflow={workflow()} onNavigate={vi.fn()} />);
    expect(screen.getByText(/unchecked rather than clean|Nothing flagged/i)).toBeInTheDocument();
  });
});
