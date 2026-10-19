import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OverviewDashboard } from "./OverviewDashboard";

// A finding names an exact set -- "252 screens nothing reaches" -- and used to hand the
// reader the destination tab and nothing else, at page one of the whole catalogue. The
// intent is the filter that turns the tab into the set the finding named.
//
// These pin the mapping itself. That every destination APPLIES its intent is pinned in each
// tab's own suite; what would break silently is a finding losing its intent, or pointing at
// a filter the destination does not have.

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn().mockResolvedValue({ available: false }),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

const workflow = () => ({
  available: true,
  schemeCount: 78,
  statusCount: 435,
  sharedSchemes: 14,
  schemeStatusesAvailable: true,
  hasIssueCounts: true,
  automationChecked: true,
  duplicateGroupCount: 13,
  reducibleStatusCount: 14,
  orphanCount: 94,
  safeToRemoveCount: 8,
  ruleOnlyStatusCount: 86,
  flaggedSchemeCount: 8,
  ruleIntegrity: {
    available: true,
    workflows: 327,
    teamManaged: 40,
    rules: 1200,
    brokenRules: 6,
    brokenProperties: 2,
    inactive: 31,
  },
});

const fieldConfigs = () => ({
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
});

const screens = () => ({
  available: true,
  totalScreens: 746,
  emptyScreens: 12,
  unresolvedScreens: 14,
  unreachedScreens: 252,
  transitionOnlyScreens: 6,
  transitionsKnown: true,
  totalOperations: 1396,
  danglingOperations: 5,
  totalSchemes: 60,
  unusedSchemes: 7,
});

const automation = () => ({
  available: true,
  ruleCount: 1489,
  disabledCount: 606,
  credentialRuleCount: 86,
  externalHttpCount: 79,
  noActionCount: 3,
  selfTriggeringCount: 88,
});

const dashboard = () => ({
  fieldUsage: {},
  adoption: {
    available: true,
    measuredProjects: 190,
    judgeableProjects: 180,
    fellOffCount: 22,
    neverAdoptedCount: 9,
    medianIssuesPerDay: 4.4,
    fellOff: [{ projectKey: "ADVEV", declineFrom: "2023-04" }],
  },
  projects: {
    totalProjects: 200,
    medianFieldCount: 38,
    overConfiguredCount: 64,
    idleOverConfiguredCount: 9,
    unusedProjectCount: 12,
    staleProjectCount: 31,
    overConfigured: [{}],
    staleProjects: [{}],
    topByIssueVolume: [],
    topByFieldCount: [],
  },
});

// Every intent a finding can carry, and the destination that has to understand it.
const EXPECTED = [
  ["Fields need admin attention", "fields", { findings: "admin-attention" }],
  ["Fields flagged as risky", "fields", { findings: "risky" }],
  ["Global-context fields with very low usage", "fields", { findings: "global-context-low-usage" }],
  ["Fields configured far past where they're used", "fields", { findings: "dead-configuration" }],
  ["Fields with no populated issues anywhere", "fields", { findings: "orphaned,configured-no-issues" }],
  ["Fields with no activity in over a year", "fields", { findings: "stale" }],
  ["Fields patched project-by-project into context sprawl", "fields", { findings: "context-sprawl" }],
  ["Actively used fields with no description", "fields", { findings: "missing-description" }],

  ["Groups of duplicate statuses", "workflows", { view: "insights", panel: "duplicates" }],
  ["Statuses with no evidence of use", "workflows", { view: "insights", panel: "orphans", statuses: "safe-to-remove" }],
  [
    "Statuses only an automation rule can reach",
    "workflows",
    { view: "insights", panel: "orphans", statuses: "rule-only" },
  ],
  ["Workflow schemes with a structural flag", "workflows", { view: "insights", panel: "balance" }],
  ["Workflow rules naming a deleted field, group or role", "workflows", { view: "rules", filter: "broken" }],
  ["Inactive workflows", "workflows", { view: "workflow-list", filter: "inactive" }],

  ["Fields required but hidden", "fieldConfigs", { view: "configs", filter: "required-hidden" }],
  ["Field configurations and schemes no project uses", "fieldConfigs", { view: "configs", filter: "unused" }],
  ["Identical field configurations or schemes", "fieldConfigs", { view: "configs", filter: "duplicate" }],

  [
    "Automation rules storing a credential in plaintext",
    "automation",
    { section: "findings", risk: "embedded-credential" },
  ],
  ["Rules that write a field they trigger on", "automation", { section: "cascades", cascadeKind: "self" }],
  ["Rules sending data outside Atlassian", "automation", { section: "findings", risk: "external-http" }],
  ["Rules with a trigger but no actions", "automation", { section: "findings", risk: "no-actions" }],
  ["Disabled automation rules", "automation", { section: "findings", risk: "disabled" }],

  ["Scheme operations pointing at a missing screen", "screens", { view: "schemes", schemes: "dangling" }],
  ["Screens whose contents could not be read", "screens", { view: "screens", filter: "unresolved" }],
  ["Screens nothing reaches", "screens", { view: "screens", filter: "unreached" }],
  ["Screens used only by a workflow transition", "screens", { view: "screens", filter: "transition-only" }],
  ["Screens carrying no fields", "screens", { view: "screens", filter: "empty" }],
  ["Screen schemes no issue type maps to", "screens", { view: "schemes", schemes: "unused" }],

  ["Saved filters with no live owner", "filters", { view: "filters", finding: "orphaned-owner" }],
  ["Filters naming a project that does not exist", "filters", { view: "broken" }],
  ["Email subscriptions on filters nobody opens", "filters", { view: "filters", finding: "subscribed-but-unused" }],
  ["Filters shared publicly", "filters", { view: "filters", finding: "shared-publicly" }],
  ["Licensed accounts idle for a year", "people", { view: "roster", filter: "dormant" }],
  ["Deactivated accounts still holding a licence", "people", { view: "roster", filter: "inactive" }],
  ["Filters shared with every logged-in user", "filters", { view: "filters", finding: "shared-with-everyone" }],
  ["Dashboards shared publicly", "dashboards", { finding: "shared-publicly" }],
  ["Dashboards with a gadget reading a missing filter", "dashboards", { finding: "broken-gadget" }],
  ["Duplicate saved filters", "filters", { view: "duplicates" }],

  ["Projects people have stopped using", "projects", { filter: "fell-off" }],
  ["Projects that never took off", "projects", { filter: "no-work" }],
  ["Projects configured well past the site norm", "projects", { filter: "over-configured" }],
  ["Projects carrying fields but no work", "projects", { filter: "no-work" }],
  ["Projects with no activity in over six months", "projects", { filter: "stale" }],
];

const filters = () => ({
  available: true,
  total: 412,
  orphanedCount: 18,
  sharedWithEveryoneCount: 34,
  sharedPubliclyCount: 2,
  subscribedButUnusedCount: 7,
  brokenProjectCount: 3,
  duplicateGroupCount: 22,
  reducibleCount: 41,
});

function renderAll(onNavigate) {
  // Every chip is a pillar-view element; the priority view is tested in OverviewDashboard.test.jsx.
  return render(
    <OverviewDashboard
      initialOrder="pillar"
      dashboard={dashboard()}
      filters={filters()}
      users={{
        available: true,
        totalUsers: 80,
        deactivatedUsers: 3,
        activityMeasured: true,
        dormantAccounts: 6,
        dormantAfterDays: 365,
      }}
      dashboards={{
        available: true,
        total: 90,
        orphanedCount: 0,
        editableByEveryoneCount: 0,
        sharedPubliclyCount: 3,
        brokenGadgetCount: 2,
        emptyCount: 0,
        publishedUnusedCount: 0,
      }}
      findingsSummary={{ adminAttention: 123, risky: 88, cleanup: 364, standardize: 129 }}
      findingsByCode={{
        "global-context-low-usage": 4,
        "dead-configuration": 9,
        orphaned: 3,
        "configured-no-issues": 2,
        stale: 11,
        "context-sprawl": 6,
        "missing-description": 14,
      }}
      workflow={workflow()}
      fieldConfigs={fieldConfigs()}
      screens={screens()}
      automation={automation()}
      onNavigate={onNavigate}
    />,
  );
}

describe("every finding carries the filter that isolates what it counted", () => {
  test.each(EXPECTED)("%s opens %s pre-filtered", async (title, tab, intent) => {
    const onNavigate = vi.fn();
    const { container } = renderAll(onNavigate);

    const row = screen.getByText(title).closest(".ui-gov");
    expect(row, `no row rendered for "${title}"`).toBeTruthy();
    // A finding either sits on a scored row as a chip, or IS the row and carries a link.
    const control = row.querySelector(".ui-gov__finding") || row.querySelector(".ui-linkbutton");
    await userEvent.click(control);

    expect(onNavigate).toHaveBeenCalledWith(tab, intent);
    container.remove();
  });

  test("no finding routes without one", () => {
    const onNavigate = vi.fn();
    const { container } = renderAll(onNavigate);

    const controls = [
      ...container.querySelectorAll(".ui-gov__finding"),
      ...container.querySelectorAll(".ui-gov__act .ui-linkbutton"),
    ];
    expect(controls.length).toBeGreaterThan(0);

    // fireEvent, not userEvent: this clicks every control on the dashboard, and simulated pointer
    // sequences for dozens of them outran the 5-second timeout under the parallel coverage run.
    // The assertion is about the intent each click produces, not pointer behaviour.
    for (const control of controls) fireEvent.click(control);

    // Landing on a tab with no filter is the behaviour this replaced.
    for (const call of onNavigate.mock.calls) {
      expect(call[1], `"${call[0]}" was opened with no intent`).toBeTruthy();
      expect(Object.keys(call[1]).length).toBeGreaterThan(0);
    }
  });

  // The shell mints a fresh object per navigation so useNavIntent re-fires; a shared frozen
  // literal would make the second click on the same finding do nothing.
  test("each click produces its own intent object", async () => {
    const onNavigate = vi.fn();
    renderAll(onNavigate);

    const row = screen.getByText("Screens nothing reaches").closest(".ui-gov");
    const control = row.querySelector(".ui-gov__finding") || row.querySelector(".ui-linkbutton");
    await userEvent.click(control);
    await userEvent.click(control);

    expect(onNavigate).toHaveBeenCalledTimes(2);
    expect(onNavigate.mock.calls[0][1]).not.toBe(onNavigate.mock.calls[1][1]);
    expect(onNavigate.mock.calls[0][1]).toEqual(onNavigate.mock.calls[1][1]);
  });
});
