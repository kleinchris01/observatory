import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
    topByIssueVolume: [
      { projectKey: "ALPHA", projectName: "Alpha", totalIssueCount: 81000, uniqueIssueCount: 900, volume: 900 },
    ],
    topByFieldCount: [{ projectKey: "CHARLIE", projectName: "Charlie", fieldCount: 40 }],
    overConfigured: [{ projectKey: "CHARLIE", projectName: "Charlie", fieldCount: 40, totalIssueCount: 2 }],
    unusedProjects: [{ projectKey: "DELTA", projectName: "Delta", fieldCount: 3 }],
    staleProjects: [
      { projectKey: "ECHO", projectName: "Echo", fieldCount: 5, latestIssueUpdatedAt: "2024-01-01T00:00:00Z" },
    ],
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

const issueTypes = (overrides = {}) => ({
  available: true,
  totalTypes: 63,
  totalSchemes: 24,
  orphanTypeCount: 7,
  hierarchyFlaggedSchemeCount: 2,
  reducibleTypeCount: 4,
  duplicateTypeGroupCount: 2,
  unusedSchemeCount: 3,
  ...overrides,
});

const users = (overrides = {}) => ({
  available: true,
  totalUsers: 500,
  deactivatedUsers: 12,
  orphanedArtifacts: 5,
  orphanedOwners: 2,
  orphanedAutomationRefUsers: 3,
  ...overrides,
});

const assets = (overrides = {}) => ({
  available: true,
  assetsEnabled: true,
  totalSchemas: 12,
  deadSchemaCount: 3,
  brokenReferenceCount: 4,
  brokenHierarchyCount: 2,
  bareTypeCount: 6,
  ...overrides,
});

const access = (overrides = {}) => ({
  available: true,
  permissions: { available: true, riskySchemeCount: 2, unusedSchemeCount: 1 },
  security: { available: true, emptyLevelCount: 1, noLevelSchemeCount: 1, unusedSchemeCount: 2 },
  notifications: { available: true, fragileSchemeCount: 3, unusedSchemeCount: 0 },
  roles: { available: true, projectsMissingAdminActorCount: 4, offRosterActorCount: 2 },
  ...overrides,
});

const estate = (overrides = {}) => ({
  available: true,
  reducibleResolutionCount: 4,
  resolutionDuplicateGroupCount: 2,
  reduciblePriorityCount: 1,
  ...overrides,
});

beforeEach(() => vi.clearAllMocks());

describe("OverviewDashboard — findings", () => {
  test("leads with what needs attention and routes each finding to a tab", async () => {
    const onNavigate = vi.fn();
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        onNavigate={onNavigate}
      />,
    );

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
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        onNavigate={onNavigate}
      />,
    );

    expect(screen.getByText("Groups of duplicate statuses")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: /^Workflows$/ })[0]);
    expect(onNavigate).toHaveBeenCalledWith("workflows", expect.objectContaining({ view: "insights" }));
  });

  test("quantifies what consolidation would actually save", () => {
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        onNavigate={vi.fn()}
      />,
    );
    // 20 removable, not the 32 statuses involved -- collapsing a group keeps one.
    expect(screen.getByText(/removes 20 statuses/i)).toBeInTheDocument();
  });

  test("says everything is clean rather than showing an empty list", () => {
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={{ projects: { totalProjects: 1, topByIssueVolume: [], topByFieldCount: [] }, fieldUsage: {} }}
        findingsSummary={{ adminAttention: 0, risky: 0, cleanup: 0, standardize: 0 }}
        workflow={workflow({
          duplicateGroupCount: 0,
          reducibleStatusCount: 0,
          safeToRemoveCount: 0,
          flaggedSchemeCount: 0,
        })}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByText(/Nothing flagged/i)).toBeInTheDocument();
  });

  // The rule: no source, no finding.
  test("omits status cleanup as a finding when the scan has not confirmed usage", () => {
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow({ hasIssueCounts: false, safeToRemoveCount: 0 })}
        onNavigate={vi.fn()}
      />,
    );

    // Without counts, an unreachable status is a list to review, not an action to take.
    expect(screen.queryByText("Statuses never used and unreachable")).not.toBeInTheDocument();
  });

  test("omits workflow findings entirely when no workflow snapshot exists", () => {
    // Field and project sources are clean here so the empty state is reachable; the point
    // is that an unbuilt workflow snapshot contributes no findings and says why.
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={{ fieldUsage: {}, projects: { totalProjects: 1, topByIssueVolume: [], topByFieldCount: [] } }}
        findingsSummary={{ adminAttention: 0, risky: 0, cleanup: 0, standardize: 0 }}
        workflow={{ available: false, state: "idle" }}
        onNavigate={vi.fn()}
      />,
    );

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
  const renderAll = (over = {}) =>
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        screens={screens()}
        issueTypes={issueTypes()}
        automation={automation()}
        onNavigate={vi.fn()}
        {...over}
      />,
    );

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

  test("surfaces the issue type findings and routes them to the Issue Types tab", async () => {
    const onNavigate = vi.fn();
    renderAll({ onNavigate });

    expect(screen.getByText("Issue types on no scheme")).toBeInTheDocument();
    expect(screen.getByText("Schemes that cannot start an issue")).toBeInTheDocument();
    expect(screen.getByText("Near-duplicate issue type names")).toBeInTheDocument();
    expect(screen.getByText("Issue type schemes assigned to no project")).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: /^Issue Types$/ })[0]);
    expect(onNavigate).toHaveBeenCalledWith("issueTypes", expect.objectContaining({ view: expect.any(String) }));
  });

  test("omits the issue type findings entirely when the pillar has not been built", () => {
    renderAll({ issueTypes: { available: false } });
    expect(screen.queryByText("Issue types on no scheme")).not.toBeInTheDocument();
  });

  test("surfaces the people findings and routes them to the People tab", async () => {
    const onNavigate = vi.fn();
    renderAll({ users: users(), onNavigate });

    expect(screen.getByText("Deactivated accounts still holding a licence")).toBeInTheDocument();
    expect(screen.getByText("Filters, dashboards and rules with no owner on the roster")).toBeInTheDocument();
    expect(screen.getByText("Automation rules routing work to someone off the roster")).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: /^People$/ })[0]);
    expect(onNavigate).toHaveBeenCalledWith("people", expect.objectContaining({ view: expect.any(String) }));
  });

  test("omits the people findings entirely when the pillar has not been built", () => {
    renderAll({ users: { available: false } });
    expect(screen.queryByText("Deactivated accounts still holding a licence")).not.toBeInTheDocument();
  });

  test("surfaces the assets findings and routes them to the Assets tab", async () => {
    const onNavigate = vi.fn();
    renderAll({ assets: assets(), onNavigate });

    expect(screen.getByText("Assets reference attributes pointing at a type that is gone")).toBeInTheDocument();
    expect(screen.getByText("Object schemas with nothing in them")).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: /^Assets$/ })[0]);
    expect(onNavigate).toHaveBeenCalledWith("assets", expect.objectContaining({ view: expect.any(String) }));
  });

  test("omits the assets findings when Assets is not enabled on the site", () => {
    renderAll({ assets: { available: false, assetsEnabled: false } });
    expect(screen.queryByText("Object schemas with nothing in them")).not.toBeInTheDocument();
  });

  test("surfaces the access findings and routes them to the Access tab", async () => {
    const onNavigate = vi.fn();
    renderAll({ access: access(), onNavigate });

    expect(screen.getByText("Permission schemes that break least privilege")).toBeInTheDocument();
    expect(screen.getByText("Issue security levels nobody can see through")).toBeInTheDocument();
    expect(screen.getByText("Notification schemes routing to a named individual")).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: /^Access$/ })[0]);
    expect(onNavigate).toHaveBeenCalledWith("access", expect.objectContaining({ view: expect.any(String) }));
  });

  test("omits the access findings entirely when the pillar has not been built", () => {
    renderAll({ access: { available: false } });
    expect(screen.queryByText("Permission schemes that break least privilege")).not.toBeInTheDocument();
  });

  test("surfaces the project-role findings and routes them to the Access tab", async () => {
    const onNavigate = vi.fn();
    renderAll({ access: access(), onNavigate });

    expect(screen.getByText("Projects nobody can administer")).toBeInTheDocument();
    expect(screen.getByText("Project-role actors off the licensed roster")).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: /^Access$/ })[0]);
    expect(onNavigate).toHaveBeenCalledWith("access", expect.objectContaining({ view: expect.any(String) }));
  });

  test("omits the role findings when access.roles is unavailable", () => {
    renderAll({ access: { ...access(), roles: { available: false } } });
    expect(screen.queryByText("Projects nobody can administer")).not.toBeInTheDocument();
  });

  test("surfaces the priorities & resolutions findings and routes them to the Priorities tab", async () => {
    const onNavigate = vi.fn();
    renderAll({ estate: estate(), onNavigate });

    expect(screen.getByText("Near-duplicate resolution names")).toBeInTheDocument();
    expect(screen.getByText("Near-duplicate priority names")).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: /^Priorities$/ })[0]);
    expect(onNavigate).toHaveBeenCalledWith("priorities", expect.objectContaining({ view: expect.any(String) }));
  });

  test("omits the estate findings entirely when the pillar has not been built", () => {
    renderAll({ estate: { available: false } });
    expect(screen.queryByText("Near-duplicate resolution names")).not.toBeInTheDocument();
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

  // The old lump "Fields that could be standardised" (and its sibling "Fields suggested for
  // cleanup") each folded several unrelated reason codes into one number, so clicking either
  // sent a reader to a mixed bucket that did not match whatever detail sentence was on the
  // card. Six specific cards replaced them -- one reason code, one accurate count each.
  test("reports each specific field finding on its own card, not folded into one lump count", () => {
    const findingsByCode = {
      "global-context-low-usage": 4,
      "dead-configuration": 9,
      orphaned: 3,
      "configured-no-issues": 2,
      stale: 11,
      "context-sprawl": 6,
      "missing-description": 14,
    };
    renderAll({ findingsByCode });

    expect(screen.getByText("Global-context fields with very low usage")).toBeInTheDocument();
    expect(screen.getByText("Fields configured far past where they're used")).toBeInTheDocument();
    expect(screen.getByText("Fields with no activity in over a year")).toBeInTheDocument();
    expect(screen.getByText("Fields patched project-by-project into context sprawl")).toBeInTheDocument();
    expect(screen.getByText("Actively used fields with no description")).toBeInTheDocument();

    // orphaned and configured-no-issues are close enough (both mean "no populated issues
    // anywhere") that they share one card -- its count is the sum, not either one alone.
    const noIssuesCard = screen.getByText("Fields with no populated issues anywhere").closest(".ui-gov");
    expect(within(noIssuesCard).getByText("5")).toBeInTheDocument();

    expect(screen.queryByText("Fields suggested for cleanup")).not.toBeInTheDocument();
    expect(screen.queryByText("Fields that could be standardised")).not.toBeInTheDocument();
  });

  test("omits a specific field-finding card entirely when its code has no fields", () => {
    renderAll({ findingsByCode: { stale: 0 } });
    expect(screen.queryByText("Fields with no activity in over a year")).not.toBeInTheDocument();
  });
});

// Workflows, automation and projects all had the same shape as screens used to: real,
// already-computed findings nested as chips under two or three scored dimensions instead of
// standing on their own the way filter-hygiene and dashboard-hygiene findings do. This pins
// the promotion for each, plus the three workflow findings that were computed and never
// surfaced at all (reducible statuses, unreachable-with-issues, no-Done schemes).
describe("OverviewDashboard — workflow, automation and project findings stand on their own", () => {
  test("promotes reducible statuses, unreachable-with-issues and no-Done schemes as their own cards", () => {
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow({ automationChecked: true, unreachableWithIssuesCount: 6, noDoneSchemeCount: 2 })}
        onNavigate={vi.fn()}
      />,
    );

    const reducible = screen.getByText("Statuses that would disappear if duplicates were merged").closest(".ui-gov");
    expect(within(reducible).getByText("20")).toBeInTheDocument();

    const stuck = screen.getByText("Unreachable statuses still holding live issues").closest(".ui-gov");
    expect(within(stuck).getByText("6")).toBeInTheDocument();
    expect(stuck.className).toMatch(/ui-gov--critical/);

    const noDone = screen.getByText("Workflow schemes with no Done status").closest(".ui-gov");
    expect(within(noDone).getByText("2")).toBeInTheDocument();

    // Not nested inside "Workflow schemes with a structural flag" -- a different card entirely.
    const structuralFlag = screen.getByText("Workflow schemes with a structural flag").closest(".ui-gov");
    expect(noDone).not.toBe(structuralFlag);
  });

  test("promotes broken workflow rule references and inactive workflows, linked to where they are fixed", async () => {
    const onNavigate = vi.fn();
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow({
          ruleIntegrity: {
            available: true,
            workflows: 50,
            teamManaged: 5,
            rules: 300,
            brokenRules: 4,
            brokenProperties: 1,
            inactive: 7,
          },
        })}
        onNavigate={onNavigate}
      />,
    );

    const broken = screen.getByText("Workflow rules naming a deleted field, group or role").closest(".ui-gov");
    expect(within(broken).getByText("5")).toBeInTheDocument();
    const inactive = screen.getByText("Inactive workflows").closest(".ui-gov");
    expect(within(inactive).getByText("7")).toBeInTheDocument();
  });

  test("promotes field scheme findings, the required-but-hidden one as critical", () => {
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        fieldConfigs={{
          available: true,
          source: "field-configurations",
          summary: {
            requiredHiddenConfigs: 2,
            requiredHiddenPairs: 5,
            unusedSchemes: 1,
            unusedConfigs: 3,
            reducible: 2,
            duplicateGroups: 1,
          },
        }}
        onNavigate={vi.fn()}
      />,
    );
    const conflict = screen.getByText("Fields required but hidden").closest(".ui-gov");
    expect(within(conflict).getByText("5")).toBeInTheDocument();
    expect(conflict.className).toMatch(/ui-gov--critical/);
    expect(
      within(screen.getByText("Field configurations and schemes no project uses").closest(".ui-gov")).getByText("4"),
    ).toBeInTheDocument();
    expect(screen.getByText("Identical field configurations or schemes")).toBeInTheDocument();
  });

  test("on field schemes, raises no required-but-hidden finding", () => {
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        fieldConfigs={{
          available: true,
          source: "field-schemes",
          summary: { requiredHiddenPairs: null, unusedSchemes: 2, unusedConfigs: 0, reducible: 0 },
        }}
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.queryByText("Fields required but hidden")).not.toBeInTheDocument();
    expect(screen.getByText("Field schemes no project uses")).toBeInTheDocument();
  });

  test("promotes dormant licences only when the crawl measured activity", () => {
    const users = (over) => ({
      available: true,
      totalUsers: 50,
      deactivatedUsers: 0,
      activityMeasured: true,
      dormantAccounts: 4,
      dormantAfterDays: 365,
      ...over,
    });
    const { unmount } = render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        users={users()}
        onNavigate={vi.fn()}
      />,
    );
    expect(
      within(screen.getByText("Licensed accounts idle for a year").closest(".ui-gov")).getByText("4"),
    ).toBeInTheDocument();
    unmount();
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        users={users({ activityMeasured: false })}
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.queryByText("Licensed accounts idle for a year")).not.toBeInTheDocument();
  });

  test("raises no rule finding from a snapshot that never read the rules", () => {
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow({ ruleIntegrity: { available: false } })}
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.queryByText("Workflow rules naming a deleted field, group or role")).not.toBeInTheDocument();
    expect(screen.queryByText("Inactive workflows")).not.toBeInTheDocument();
  });

  test("promotes every automation finding instead of nesting it under the four scored dimensions", () => {
    const health = {
      score: 70,
      grade: "C",
      dimensions: [],
      weakest: null,
      pillars: [
        {
          key: "automation",
          label: "Automation",
          score: 70,
          grade: "C",
          available: true,
          scored: 1,
          total: 1,
          dimensions: [
            {
              key: "automation-security",
              label: "Automation security",
              available: true,
              score: 70,
              detail: "3 rules with a credential.",
            },
          ],
        },
      ],
    };
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        automation={automation()}
        health={health}
        onNavigate={vi.fn()}
      />,
    );

    const security = screen.getByText("Automation security").closest(".ui-gov");
    const credentials = screen.getByText("Automation rules storing a credential in plaintext").closest(".ui-gov");
    expect(credentials).not.toBe(security);
    expect(within(credentials).getByText("3")).toBeInTheDocument();
  });

  test("promotes every project finding, including the idle-over-configured subset that used to be a detail sentence", () => {
    const health = {
      score: 60,
      grade: "D",
      dimensions: [],
      weakest: null,
      pillars: [
        {
          key: "projects",
          label: "Projects",
          score: 60,
          grade: "D",
          available: true,
          scored: 1,
          total: 1,
          dimensions: [
            {
              key: "project-consistency",
              label: "Project consistency",
              available: true,
              score: 60,
              detail: "5 over-configured.",
            },
          ],
        },
      ],
    };
    render(
      <OverviewDashboard
        initialOrder="pillar"
        health={health}
        dashboard={dashboard({
          projects: {
            totalProjects: 40,
            medianFieldCount: 12,
            overConfiguredCount: 5,
            idleOverConfiguredCount: 3,
            unusedProjectCount: 4,
            staleProjectCount: 6,
            overConfigured: [{}],
            staleProjects: [{}],
            topByIssueVolume: [],
            topByFieldCount: [],
          },
          adoption: {
            available: true,
            measuredProjects: 40,
            judgeableProjects: 38,
            fellOffCount: 2,
            neverAdoptedCount: 1,
            medianIssuesPerDay: 3,
            fellOff: [{ projectKey: "X" }],
          },
        })}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        onNavigate={vi.fn()}
      />,
    );

    const consistency = screen.getByText("Project consistency").closest(".ui-gov");
    const overConfigured = screen.getByText("Projects configured well past the site norm").closest(".ui-gov");
    expect(overConfigured).not.toBe(consistency);

    const idle = screen.getByText("Over-configured projects with little work to show for it").closest(".ui-gov");
    expect(within(idle).getByText("3")).toBeInTheDocument();
  });

  test("surfaces stale project-activity data as its own finding, since it silences the decline findings", () => {
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard({
          adoption: {
            available: true,
            measuredProjects: 40,
            judgeableProjects: 38,
            fellOffCount: 0,
            neverAdoptedCount: 0,
            medianIssuesPerDay: 3,
            dataStale: true,
            dataThroughMonth: "2026-01",
            fellOff: [],
          },
        })}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        onNavigate={vi.fn()}
      />,
    );

    const stale = screen.getByText("Project activity data is out of date").closest(".ui-gov");
    expect(within(stale).getByText(/histogram ends at 2026-01/)).toBeInTheDocument();
  });

  test("promotes 'Dashboards published, unwanted', a finding that was computed and never shown at all", () => {
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        dashboards={{
          available: true,
          total: 50,
          orphanedCount: 0,
          editableByEveryoneCount: 0,
          emptyCount: 0,
          publishedUnusedCount: 9,
          gadgetsKnown: true,
        }}
        onNavigate={vi.fn()}
      />,
    );

    const card = screen.getByText("Dashboards published, unwanted").closest(".ui-gov");
    expect(within(card).getByText("9")).toBeInTheDocument();
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
        key: "fields",
        label: "Fields",
        score: 48,
        grade: "E",
        available: true,
        scored: 2,
        total: 2,
        dimensions: [
          { key: "field-naming", label: "Field naming", available: true, score: 79, detail: "34 groups share a name." },
          {
            key: "field-governance",
            label: "Field governance",
            available: true,
            score: 17,
            detail: "69 high severity.",
          },
        ],
      },
      {
        key: "screens",
        label: "Screens",
        score: null,
        grade: null,
        available: false,
        scored: 0,
        total: 2,
        reason: "No screen inventory yet.",
        dimensions: [
          {
            key: "screen-integrity",
            label: "Screen scheme integrity",
            available: false,
            score: null,
            reason: "No screen inventory yet.",
          },
          {
            key: "screen-hygiene",
            label: "Screen hygiene",
            available: false,
            score: null,
            reason: "No screen inventory yet.",
          },
        ],
      },
    ],
  };

  test("groups the dimension bars under their pillar with a roll-up score", () => {
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        health={health}
        onNavigate={vi.fn()}
      />,
    );

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
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        health={health}
        onNavigate={vi.fn()}
      />,
    );

    // "not measured" is a statement about SCORING, so it appears against the screens
    // pillar the score covered and could not score -- not against a pillar that exists
    // only because findings landed in it.
    expect(screen.getAllByText("not measured")).toHaveLength(1);
    expect(screen.getByText("No screen inventory yet.")).toBeInTheDocument();
    expect(screen.queryByText("Screen hygiene")).not.toBeInTheDocument();
  });

  // A cached payload from before pillars existed still has to render its bars.
  test("falls back to a flat list when the score carries no pillars", () => {
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        health={{
          ...health,
          pillars: undefined,
          dimensions: [{ key: "field-naming", label: "Field naming", available: true, score: 79, detail: "d" }],
        }}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByText("Field naming")).toBeInTheDocument();
  });

  // Screens used to have only its two scored dimensions to show, while filters and
  // dashboards each had several extra cards -- not because screens has less to say, but
  // because its findings were nested as chips inside "Screen scheme integrity" and "Screen
  // hygiene" instead of standing on their own the way filter-hygiene and dashboard-hygiene
  // findings do. Promoting them (dimension: "screen-findings", a key that deliberately
  // matches no scored dimension) is what brings the pillar in line with the others.
  test("promotes every screen finding to its own card instead of nesting it under the scored dimensions", () => {
    const scoredScreens = {
      key: "screens",
      label: "Screens",
      score: 61,
      grade: "D",
      available: true,
      scored: 2,
      total: 2,
      dimensions: [
        {
          key: "screen-integrity",
          label: "Screen scheme integrity",
          available: true,
          score: 70,
          detail: "5 dangling operations.",
        },
        { key: "screen-hygiene", label: "Screen hygiene", available: true, score: 52, detail: "58 screens flagged." },
      ],
    };
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        screens={screens()}
        health={{ ...health, pillars: [...health.pillars.filter((p) => p.key !== "screens"), scoredScreens] }}
        onNavigate={vi.fn()}
      />,
    );

    const pillarSection = screen.getByText("Screen scheme integrity").closest(".ui-gov-pillar");
    const cardTitles = [
      "Screen scheme integrity",
      "Screen hygiene",
      "Scheme operations pointing at a missing screen",
      "Screens whose contents could not be read",
      "Screens nothing reaches",
      "Screens used only by a workflow transition",
      "Screens carrying no fields",
      "Screen schemes no issue type maps to",
    ];
    for (const title of cardTitles) {
      expect(within(pillarSection).getByText(title)).toBeInTheDocument();
    }
    expect(pillarSection.querySelectorAll(".ui-gov")).toHaveLength(8);

    // The promoted findings are not nested inside the scored dimension's own card -- each
    // one closes to a DIFFERENT .ui-gov element than "Screen scheme integrity" does.
    const integrityCard = screen.getByText("Screen scheme integrity").closest(".ui-gov");
    const danglingCard = screen.getByText("Scheme operations pointing at a missing screen").closest(".ui-gov");
    expect(danglingCard).not.toBe(integrityCard);
  });
});

describe("OverviewDashboard — resilience", () => {
  test("renders with no data at all rather than crashing", () => {
    render(<OverviewDashboard initialOrder="pillar" />);
    expect(screen.getByText("Governance")).toBeInTheDocument();
  });

  test("deep links are inert rather than throwing when no navigator is supplied", async () => {
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
      />,
    );
    await userEvent.click(screen.getAllByRole("button", { name: /Field Browser/ })[0]);
    expect(screen.getByText("Governance")).toBeInTheDocument();
  });

  test("the RQT panel degrades to dashes when its resolver fails", async () => {
    invoke.mockRejectedValue(new Error("resolver down"));
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        onNavigate={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getAllByText("—").length).toBeGreaterThan(0));
  });
});

// A bare score is useless and a dishonest one is worse. These pin that it always ships
// with somewhere to go, and that it says when it could not see the whole site.
describe("OverviewDashboard — site health", () => {
  const health = (over = {}) => ({
    score: 72,
    grade: "C",
    dimensionsScored: 7,
    dimensionsTotal: 7,
    weakest: {
      key: "status-naming",
      label: "Status naming",
      score: 41,
      action: "Consolidate duplicate statuses in the Workflows tab.",
    },
    dimensions: [
      { key: "field-naming", label: "Field naming", available: true, score: 88, detail: "3 groups share a name." },
      {
        key: "status-naming",
        label: "Status naming",
        available: true,
        score: 41,
        detail: "20 of 433 statuses are redundant.",
      },
    ],
    ...over,
  });

  test("leads with the score and names the weakest dimension with its remedy", () => {
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        health={health()}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByText("72")).toBeInTheDocument();
    expect(screen.getByText("C")).toBeInTheDocument();
    // A number with nowhere to go is not actionable.
    expect(screen.getByText(/Consolidate duplicate statuses/i)).toBeInTheDocument();
  });

  test("says which dimensions it could not score", () => {
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        health={health({
          dimensionsScored: 4,
          dimensionsTotal: 7,
          dimensions: [
            { key: "field-naming", label: "Field naming", available: true, score: 88, detail: "ok" },
            {
              key: "status-naming",
              label: "Status naming",
              available: false,
              score: null,
              reason: "No workflow inventory yet.",
            },
          ],
        })}
        onNavigate={vi.fn()}
      />,
    );

    // A high score from few inputs is a weaker claim, and the reader must be able to tell.
    // Asserted on the note's full text: it is assembled from several JSX nodes, so a
    // regex against a single text node would miss the dimension names entirely.
    const note = screen.getByText(/could not be scored/i).closest("p");
    expect(note.textContent).toMatch(/Status naming/);
    expect(note.textContent).toMatch(/1 dimension could not be scored/i);
  });

  test("prompts for a build rather than showing a zero when nothing is measured", () => {
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        health={{ score: null }}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByText(/unchecked rather than clean|Nothing flagged/i)).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  test("renders without a health object at all", () => {
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.getByText(/unchecked rather than clean|Nothing flagged/i)).toBeInTheDocument();
  });
});

describe("OverviewDashboard — remediation beside each finding", () => {
  const tickets = {
    period: "2026-Q3",
    findingIndex: { "role-empty-admin": "role-empty-admin", "role-offroster-actors": "role-offroster-actors" },
    groups: [
      {
        findingKey: "role-empty-admin",
        isCurrent: true,
        period: "2026-Q3",
        epic: { issueKey: "ADMIN-7" },
        taskCount: 4,
        openCount: 3,
      },
    ],
  };

  test("shows the finding's epic and progress, and routes to it on the Remediation tab", async () => {
    invoke.mockImplementation(async (name) => (name === "getRemediationTickets" ? tickets : {}));
    const onNavigate = vi.fn();
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        access={access()}
        onNavigate={onNavigate}
        siteOrigin="https://acme.atlassian.net"
      />,
    );

    expect(await screen.findByRole("link", { name: "ADMIN-7" })).toHaveAttribute(
      "href",
      "https://acme.atlassian.net/browse/ADMIN-7",
    );
    expect(screen.getByText(/3 of 4 tasks open/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Manage/ }));
    expect(onNavigate).toHaveBeenCalledWith("remediation", { finding: "role-empty-admin" });
  });

  test("a finding with a playbook but no epic offers to start one", async () => {
    invoke.mockImplementation(async (name) => (name === "getRemediationTickets" ? tickets : {}));
    const onNavigate = vi.fn();
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        access={access()}
        onNavigate={onNavigate}
      />,
    );

    expect(await screen.findByText("No remediation epic for 2026-Q3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Start remediation/ }));
    expect(onNavigate).toHaveBeenCalledWith("remediation", { finding: "role-offroster-actors" });
  });

  test("if the remediation read fails, the findings render exactly as before", async () => {
    invoke.mockImplementation(async (name) => {
      if (name === "getRemediationTickets") throw new Error("down");
      return {};
    });
    render(
      <OverviewDashboard
        initialOrder="pillar"
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        workflow={workflow()}
        access={access()}
        onNavigate={vi.fn()}
      />,
    );
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("getRemediationTickets", {}));
    expect(screen.queryByText(/remediation epic/)).toBeNull();
    expect(screen.getByText("Fields need admin attention")).toBeInTheDocument();
  });
});

// "Do this first": the Governance panel's default view ranks every row across pillars. The
// tests above pin initialOrder="pillar" because they test the pillar grouping; these test the
// ranked view an admin lands on.
describe("OverviewDashboard — Do this first", () => {
  beforeEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      /* storage unavailable: the default applies */
    }
  });

  const health = {
    score: 55,
    grade: "E",
    dimensions: [],
    weakest: null,
    pillars: [
      {
        key: "automation",
        label: "Automation",
        score: 40,
        grade: "E",
        available: true,
        scored: 1,
        total: 1,
        dimensions: [
          {
            key: "automation-findings",
            label: "Automation security",
            available: true,
            score: 40,
            weight: 2,
            detail: "3 rules store a credential.",
          },
        ],
      },
      {
        key: "fields",
        label: "Fields",
        score: 79,
        grade: "C",
        available: true,
        scored: 1,
        total: 1,
        dimensions: [
          {
            key: "field-naming",
            label: "Field naming",
            available: true,
            score: 79,
            weight: 1,
            detail: "34 groups share a name.",
            action: "Merge the duplicate names.",
          },
        ],
      },
    ],
  };
  const renderRanked = (over = {}) =>
    render(
      <OverviewDashboard
        dashboard={dashboard()}
        findingsSummary={findingsSummary}
        automation={automation()}
        health={health}
        onNavigate={vi.fn()}
        {...over}
      />,
    );

  test("opens on the ranked view, highest value first, with the exact score lift", () => {
    renderRanked();

    expect(screen.getByRole("button", { name: "By priority" })).toHaveAttribute("aria-pressed", "true");
    const items = screen.getAllByRole("listitem").filter((li) => li.closest(".priority-list"));
    expect(within(items[0]).getByText("Automation security")).toBeInTheDocument();
    // Automation is weight 2 of 3.5 scored pillar weight; this check is all of its pillar.
    expect(within(items[0]).getByText(/Automation · \+34\.3 points · Act now/)).toBeInTheDocument();
    expect(
      screen.getByText(/Fields · \+9\.0 points · Cleanup when convenient · Merge the duplicate names\./),
    ).toBeInTheDocument();
  });

  test("says each finding once: the pillar view's chips are not rendered alongside", () => {
    renderRanked();
    expect(screen.queryByText("Automation rules storing a credential in plaintext")).toBeNull();
  });

  test("Open goes where the finding's own link goes", async () => {
    const onNavigate = vi.fn();
    renderRanked({ onNavigate });

    const first = screen.getAllByRole("listitem").find((li) => within(li).queryByText("Automation security"));
    await userEvent.click(within(first).getByRole("button", { name: "Open" }));
    expect(onNavigate).toHaveBeenCalledWith("automation", expect.any(Object));
  });

  test("switches to the pillar view and remembers the choice", async () => {
    const { unmount } = renderRanked();
    await userEvent.click(screen.getByRole("button", { name: "By pillar" }));

    expect(screen.getByText("Automation rules storing a credential in plaintext")).toBeInTheDocument();
    unmount();
    renderRanked();
    expect(screen.getByRole("button", { name: "By pillar" })).toHaveAttribute("aria-pressed", "true");
  });

  test("offers Plan the fix where a playbook exists, routed to the Remediation tab", async () => {
    const tickets = {
      period: "2026-Q4",
      findingIndex: { "automation-credentials": "automation-credentials" },
      groups: [
        { findingKey: "automation-credentials", isCurrent: false, period: "2026-Q3", openCount: 0, taskCount: 2 },
      ],
    };
    invoke.mockImplementation(async (name) => (name === "getRemediationTickets" ? tickets : {}));
    const onNavigate = vi.fn();
    renderRanked({ onNavigate });

    await userEvent.click(await screen.findByRole("button", { name: "Plan the fix" }));
    expect(onNavigate).toHaveBeenCalledWith("remediation", { finding: "automation-credentials" });
  });

  test("leaves work in progress this quarter out of the list, and counts it", async () => {
    const tickets = {
      period: "2026-Q4",
      findingIndex: { "automation-credentials": "automation-credentials" },
      groups: [
        { findingKey: "automation-credentials", isCurrent: true, period: "2026-Q4", openCount: 2, taskCount: 3 },
      ],
    };
    invoke.mockImplementation(async (name) => (name === "getRemediationTickets" ? tickets : {}));
    renderRanked();

    expect(await screen.findByText(/1 more already in progress this quarter\./)).toBeInTheDocument();
    expect(screen.queryByText("Automation security")).toBeNull();
  });

  test("explains the ranking on request", async () => {
    renderRanked();
    await userEvent.click(screen.getByRole("button", { name: "How this is ranked" }));
    expect(screen.getByText(/score lift × urgency ÷ effort/)).toBeInTheDocument();
  });

  test("says so when everything flagged is already under way", async () => {
    const tickets = {
      period: "2026-Q4",
      findingIndex: {
        "automation-credentials": "automation-credentials",
        "automation-disabled": "automation-disabled",
      },
      groups: [
        { findingKey: "automation-credentials", isCurrent: true, openCount: 1, taskCount: 1 },
        { findingKey: "automation-disabled", isCurrent: true, openCount: 1, taskCount: 1 },
      ],
    };
    invoke.mockImplementation(async (name) => (name === "getRemediationTickets" ? tickets : {}));
    const onlyAutomation = { ...health, pillars: [health.pillars[0]] };
    render(
      <OverviewDashboard
        dashboard={dashboard()}
        automation={automation()}
        health={onlyAutomation}
        onNavigate={vi.fn()}
      />,
    );

    expect(await screen.findByText(/already in progress this quarter/)).toBeInTheDocument();
  });
});
