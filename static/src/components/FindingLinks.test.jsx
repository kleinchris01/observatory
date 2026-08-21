import React from "react";
import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
  available: true, schemeCount: 78, statusCount: 435, sharedSchemes: 14,
  schemeStatusesAvailable: true, hasIssueCounts: true, automationChecked: true,
  duplicateGroupCount: 13, reducibleStatusCount: 14, orphanCount: 94,
  safeToRemoveCount: 8, ruleOnlyStatusCount: 86, flaggedSchemeCount: 8,
});

const screens = () => ({
  available: true, totalScreens: 746, emptyScreens: 12, unresolvedScreens: 14,
  unreachedScreens: 252, transitionOnlyScreens: 6, transitionsKnown: true,
  totalOperations: 1396, danglingOperations: 5, totalSchemes: 60, unusedSchemes: 7,
});

const automation = () => ({
  available: true, ruleCount: 1489, disabledCount: 606, credentialRuleCount: 86,
  externalHttpCount: 79, noActionCount: 3, selfTriggeringCount: 88,
});

const dashboard = () => ({
  fieldUsage: {},
  projects: {
    totalProjects: 200, medianFieldCount: 38, overConfiguredCount: 64,
    idleOverConfiguredCount: 9, unusedProjectCount: 12, staleProjectCount: 31,
    overConfigured: [{}], staleProjects: [{}], topByIssueVolume: [], topByFieldCount: [],
  },
});

// Every intent a finding can carry, and the destination that has to understand it.
const EXPECTED = [
  ["Fields need admin attention", "fields", { findings: "admin-attention" }],
  ["Fields flagged as risky", "fields", { findings: "risky" }],
  ["Fields suggested for cleanup", "fields", { findings: "cleanup" }],
  ["Fields that could be standardised", "fields", { findings: "standardize" }],

  ["Groups of duplicate statuses", "workflows", { view: "insights", panel: "duplicates" }],
  ["Statuses with no evidence of use", "workflows", { view: "insights", panel: "orphans", statuses: "safe-to-remove" }],
  ["Statuses only an automation rule can reach", "workflows", { view: "insights", panel: "orphans", statuses: "rule-only" }],
  ["Workflow schemes with a structural flag", "workflows", { view: "insights", panel: "balance" }],

  ["Automation rules storing a credential in plaintext", "automation", { section: "findings", risk: "embedded-credential" }],
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

  ["Projects configured well past the site norm", "projects", { filter: "over-configured" }],
  ["Projects carrying fields but no work", "projects", { filter: "no-work" }],
  ["Projects with no activity in over six months", "projects", { filter: "stale" }],
];

function renderAll(onNavigate) {
  return render(<OverviewDashboard
    dashboard={dashboard()}
    findingsSummary={{ adminAttention: 123, risky: 88, cleanup: 364, standardize: 129 }}
    workflow={workflow()}
    screens={screens()}
    automation={automation()}
    onNavigate={onNavigate}
  />);
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

  test("no finding routes without one", async () => {
    const onNavigate = vi.fn();
    const { container } = renderAll(onNavigate);

    const controls = [
      ...container.querySelectorAll(".ui-gov__finding"),
      ...container.querySelectorAll(".ui-gov__act .ui-linkbutton"),
    ];
    expect(controls.length).toBeGreaterThan(0);

    for (const control of controls) await userEvent.click(control);

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
