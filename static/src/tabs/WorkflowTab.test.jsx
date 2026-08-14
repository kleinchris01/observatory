import React from "react";
import { describe, it, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { WorkflowTab, WorkflowInsights } from "./WorkflowTab";

// This UI is the reason three permission scopes are on the install consent screen.
// Until it existed, read:workflow:jira, read:workflow-scheme:jira and read:status:jira
// were being requested for a backend nobody could reach.

function inventory(overrides = {}) {
  return {
    schemes: [
      {
        id: "s1",
        name: "ADVEV Standard",
        description: "Default scheme for engineering projects",
        defaultWorkflow: "ADVEV Default Workflow",
        projectCount: 2,
        projects: [
          { projectId: "100", projectKey: "AAA", projectName: "Project A" },
          { projectId: "200", projectKey: "BBB", projectName: "Project B" },
        ],
        projectsTruncated: false,
        issueTypeMapping: { Bug: "Bug Workflow" },
      },
      {
        id: "s2", name: "Legacy Scheme", description: "", defaultWorkflow: null,
        projectCount: 0, projects: [], projectsTruncated: false, issueTypeMapping: null,
      },
    ],
    statuses: [
      { id: "1", name: "Open", statusCategory: "To Do", findings: null },
      { id: "2", name: "In Review", statusCategory: "In Progress", findings: null },
      { id: "3", name: "Closed", statusCategory: "Done", findings: null },
    ],
    page: 1, pageSize: 10, totalCount: 2, totalPages: 1,
    snapshotStatus: { state: "ready", version: "wf-1", refreshedAt: "2026-07-31T10:00:00Z", lastError: null },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockResolvedValue(inventory());
});

describe("WorkflowTab", () => {
  it("lists workflow schemes with their project counts", async () => {
    render(<WorkflowTab />);

    expect(await screen.findByText("ADVEV Standard")).toBeInTheDocument();
    expect(screen.getByText("Legacy Scheme")).toBeInTheDocument();
    expect(screen.getByText("2 projects")).toBeInTheDocument();
  });

  it("expands a scheme to show the projects it governs", async () => {
    const user = userEvent.setup();
    render(<WorkflowTab />);
    await screen.findByText("ADVEV Standard");

    expect(screen.queryByText("Project A")).not.toBeInTheDocument();
    await user.click(screen.getByText("ADVEV Standard"));

    expect(await screen.findByText("Project A")).toBeInTheDocument();
    expect(screen.getByText("Bug")).toBeInTheDocument();
  });

  // The count above the list is already filtered to browsable projects, so an empty
  // expansion can mean "you cannot see them" rather than "there are none".
  it("distinguishes an empty scheme from one whose projects are not visible", async () => {
    const user = userEvent.setup();
    render(<WorkflowTab />);
    await screen.findByText("Legacy Scheme");

    await user.click(screen.getByText("Legacy Scheme"));

    expect(await screen.findByText(/no projects you can browse/i)).toBeInTheDocument();
  });

  it("switches to the status catalog and groups by category", async () => {
    const user = userEvent.setup();
    render(<WorkflowTab />);
    await screen.findByText("ADVEV Standard");

    await user.click(screen.getByRole("button", { name: /statuses/i }));

    expect(await screen.findByText("Open")).toBeInTheDocument();
    expect(screen.getByText("In Review")).toBeInTheDocument();
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });

  it("filters statuses by category", async () => {
    const user = userEvent.setup();
    render(<WorkflowTab />);
    await screen.findByText("ADVEV Standard");
    await user.click(screen.getByRole("button", { name: /statuses/i }));
    await screen.findByText("Open");

    // Category moved from a chip row to a select. A chip row grows with the site and is
    // the one control that cannot fit on a narrow screen.
    await user.selectOptions(screen.getByRole("combobox", { name: /Category/i }), "Done");

    expect(screen.getByText("Closed")).toBeInTheDocument();
    expect(screen.queryByText("Open")).not.toBeInTheDocument();
  });

  it("offers to build when no inventory exists yet", async () => {
    invoke.mockResolvedValue(inventory({
      schemes: [], statuses: [], totalCount: 0,
      snapshotStatus: { state: "idle", version: null, refreshedAt: null, lastError: null },
    }));

    render(<WorkflowTab />);

    expect(await screen.findByText(/no workflow inventory yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /build inventory/i })).toBeInTheDocument();
  });

  it("requests a rebuild with forceRefresh", async () => {
    const user = userEvent.setup();
    render(<WorkflowTab />);
    await screen.findByText("ADVEV Standard");

    await user.click(screen.getByRole("button", { name: /rebuild/i }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("getWorkflowInventory", expect.objectContaining({ forceRefresh: true }));
    });
  });

  it("surfaces a load failure instead of an empty page", async () => {
    invoke.mockRejectedValue(new Error("workflow scopes not granted"));

    render(<WorkflowTab />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/workflow scopes not granted/i);
  });

  it("surfaces a build error recorded on the snapshot", async () => {
    invoke.mockResolvedValue(inventory({
      snapshotStatus: { state: "failed", version: "wf-1", refreshedAt: null, lastError: "Jira returned 403" },
    }));

    render(<WorkflowTab />);

    expect(await screen.findByText(/jira returned 403/i)).toBeInTheDocument();
  });
});

// The insights view makes claims an admin may act on destructively ("safe to remove"),
// so these tests are mostly about what it must NOT say when the data is incomplete.
describe("WorkflowTab — insights", () => {
  const readySnapshot = {
    schemes: [], statuses: [], page: 1, pageSize: 10, totalCount: 0, totalPages: 1,
    snapshotStatus: { state: "ready", version: "v1", refreshedAt: "2026-08-03T12:00:00.000Z" },
  };

  const insights = (overrides = {}) => ({
    available: true,
    schemeStatusesAvailable: true,
    hasIssueCounts: true,
    summary: {
      duplicateGroupCount: 1, duplicateStatusCount: 2, reducibleStatusCount: 1,
      orphanCount: 1, safeToRemoveCount: 1, flaggedSchemeCount: 0,
    },
    duplicateGroups: [{
      key: "backlog", kind: "spacing", count: 2,
      statuses: [
        { statusId: "1", name: "Backlog", issueCount: 40 },
        { statusId: "2", name: "Back Log", issueCount: 0 },
      ],
    }],
    orphans: [{ statusId: "9", name: "Abandoned", issueCount: 0, safeToRemove: true }],
    balance: [],
    statusTotals: { catalogCount: 3, withIssues: 1 },
    snapshotStatus: { state: "ready", refreshedAt: "2026-08-03T12:00:00.000Z" },
    ...overrides,
  });

  function routeInvoke(insightPayload) {
    invoke.mockImplementation((fn) => {
      if (fn === "getWorkflowInsights") return Promise.resolve(insightPayload);
      return Promise.resolve(readySnapshot);
    });
  }

  test("shows duplicate groups with the number of statuses consolidation would remove", async () => {
    routeInvoke(insights());
    render(<WorkflowTab />);

    await userEvent.click(await screen.findByRole("button", { name: /Insights/i }));

    expect(await screen.findByText(/Differ only by spacing or punctuation/i)).toBeInTheDocument();
    expect(screen.getByText("Backlog")).toBeInTheDocument();
    expect(screen.getByText("Back Log")).toBeInTheDocument();
  });

  test("labels a never-used orphan as safe when scan counts exist", async () => {
    routeInvoke(insights());
    render(<WorkflowTab />);

    await userEvent.click(await screen.findByRole("button", { name: /Insights/i }));

    const orphan = (await screen.findByText("Abandoned")).closest(".wf-orphan");
    expect(within(orphan).getByText(/never used/i)).toBeInTheDocument();
  });

  test("never says 'never used' without scan data, and prompts for a scan instead", async () => {
    routeInvoke(insights({
      hasIssueCounts: false,
      orphans: [{ statusId: "9", name: "Abandoned", issueCount: null, safeToRemove: false }],
      summary: { ...insights().summary, safeToRemoveCount: 0 },
    }));
    render(<WorkflowTab />);

    await userEvent.click(await screen.findByRole("button", { name: /Insights/i }));

    expect(await screen.findByText(/Run a Universe Scan/i)).toBeInTheDocument();
    const unknownOrphan = (await screen.findByText("Abandoned")).closest(".wf-orphan");
    expect(within(unknownOrphan).getByText(/usage unknown/i)).toBeInTheDocument();
    expect(within(unknownOrphan).queryByText(/never used/i)).not.toBeInTheDocument();
  });

  test("explains itself when Jira returned no workflow status data", async () => {
    routeInvoke(insights({ schemeStatusesAvailable: false, orphans: [], balance: [] }));
    render(<WorkflowTab />);

    await userEvent.click(await screen.findByRole("button", { name: /Insights/i }));

    expect(await screen.findByText(/did not return workflow status data/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Unreachable statuses/i })).not.toBeInTheDocument();
  });

  test("asks for a build rather than showing empty findings when no snapshot exists", async () => {
    routeInvoke({ available: false, reason: "no-snapshot", snapshotStatus: { state: "idle" } });
    render(<WorkflowTab />);

    await userEvent.click(await screen.findByRole("button", { name: /Insights/i }));

    expect(await screen.findByText(/Build the workflow inventory first/i)).toBeInTheDocument();
  });
});

// The status catalog now carries two independently-measured numbers: how many issues are
// in a status now, and how many have ever been. Filters compose by intersection, and an
// unmeasured status must never be classified as unused.
describe("WorkflowTab — status catalog", () => {
  const statusesPayload = (overrides = {}) => ({
    schemes: [], page: 1, pageSize: 10, totalCount: 0, totalPages: 1,
    snapshotStatus: { state: "ready", version: "v1", refreshedAt: "2026-08-03T12:00:00.000Z" },
    statuses: [
      { id: "1", name: "Backlog", statusCategory: "To Do", issueCount: 9423, everCount: 12000, departedCount: 2577 },
      { id: "2", name: "Parking Lot", statusCategory: "To Do", issueCount: 0, everCount: 4000, departedCount: 4000 },
      { id: "3", name: "Ghost Status", statusCategory: "Done", issueCount: 0, everCount: 0, departedCount: 0 },
    ],
    statusCounts: { hasCurrentCounts: true, hasHistoryCounts: true, historyMeasuredAt: "2026-08-03T12:00:00.000Z" },
    ...overrides,
  });

  async function openStatuses(payload = statusesPayload()) {
    invoke.mockImplementation((fn) => {
      if (fn === "getWorkflowInventory") return Promise.resolve(payload);
      return Promise.resolve({ available: false });
    });
    render(<WorkflowTab />);
    await userEvent.click(await screen.findByRole("button", { name: /Statuses/i }));
  }

  // Status names also appear in the charts above the catalog, so grid assertions are
  // scoped -- otherwise "is Parking Lot visible" silently answers a different question.
  // The catalog is now grouped by category, so there is one grid per group -- a helper
  // that looked at only the first would quietly answer a different question.
  const grids = () => [...document.querySelectorAll(".wf-status-grid")];
  const inGrid = () => grids()[0];
  const gridHas = (name) => grids().some((g) => within(g).queryAllByText(name).length > 0);
  const gridText = (text) => grids().flatMap((g) => within(g).queryAllByText(text));

  test("shows both measures for each status", async () => {
    await openStatuses();
    await waitFor(() => expect(gridHas("Backlog")).toBe(true));
    expect(gridText("9,423")).toHaveLength(1);
    expect(gridText("12,000")).toHaveLength(1);
  });

  test("filters to statuses that are empty now but were used before", async () => {
    await openStatuses();
    await waitFor(() => expect(gridHas("Backlog")).toBe(true));

    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Usage/i }), "empty");

    // The signal: nothing sits here now, but 4,000 issues passed through.
    expect(gridHas("Parking Lot")).toBe(true);
    expect(gridHas("Backlog")).toBe(false);
    expect(gridHas("Ghost Status")).toBe(false);
  });

  test("filters to statuses no issue has ever entered", async () => {
    await openStatuses();
    await waitFor(() => expect(gridHas("Backlog")).toBe(true));

    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Usage/i }), "never");

    expect(gridHas("Ghost Status")).toBe(true);
    expect(gridHas("Parking Lot")).toBe(false);
  });

  test("text filter narrows by name", async () => {
    await openStatuses();
    await waitFor(() => expect(gridHas("Backlog")).toBe(true));

    await userEvent.type(screen.getByLabelText(/Filter statuses by name/i), "parking");

    expect(gridHas("Parking Lot")).toBe(true);
    expect(gridHas("Backlog")).toBe(false);
  });

  // Unmeasured is not unused: an em dash, never a zero.
  test("renders unmeasured usage as a dash and never classifies it as never-used", async () => {
    await openStatuses(statusesPayload({
      statuses: [{ id: "1", name: "Unmeasured", statusCategory: "To Do", issueCount: null, everCount: null, departedCount: null }],
      statusCounts: { hasCurrentCounts: false, hasHistoryCounts: false },
    }));
    await waitFor(() => expect(gridHas("Unmeasured")).toBe(true));

    // Scoped to the grid: the key above it also shows an em dash by way of explanation.
    expect(gridText("—").length).toBeGreaterThan(0);

    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Usage/i }), "never");
    expect(gridHas("Unmeasured")).toBe(false);
  });

  test("prompts to measure history when it has never been run", async () => {
    await openStatuses(statusesPayload({
      statusCounts: { hasCurrentCounts: true, hasHistoryCounts: false },
    }));

    expect(await screen.findByText(/Historical usage not measured yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Measure history/i })).toBeInTheDocument();
  });

  test("requests the history measurement without re-scanning issues", async () => {
    await openStatuses(statusesPayload({
      statusCounts: { hasCurrentCounts: true, hasHistoryCounts: false },
    }));

    await userEvent.click(await screen.findByRole("button", { name: /Measure history/i }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "getWorkflowInventory",
      expect.objectContaining({ measureHistory: true })
    ));
  });
});

// 433 statuses with the category repeated on every card was unreadable. Grouping makes
// the category a heading instead, which is the same information at 1/433 the repetition.
describe("WorkflowTab — status catalog grouping", () => {
  const payload = {
    schemes: [], page: 1, pageSize: 10, totalCount: 0, totalPages: 1,
    snapshotStatus: { state: "ready", version: "v1", refreshedAt: "2026-08-03T12:00:00.000Z" },
    statuses: [
      { id: "1", name: "Backlog", statusCategory: "To Do", issueCount: 10, everCount: 20, departedCount: 10 },
      { id: "2", name: "In Review", statusCategory: "In Progress", issueCount: 5, everCount: 5, departedCount: 0 },
      { id: "3", name: "Shipped", statusCategory: "Done", issueCount: 1, everCount: 1, departedCount: 0 },
      { id: "4", name: "Limbo", statusCategory: null, issueCount: 0, everCount: 0, departedCount: 0 },
    ],
    statusCounts: { hasCurrentCounts: true, hasHistoryCounts: true },
  };

  async function open() {
    invoke.mockImplementation((fn) =>
      fn === "getWorkflowInventory" ? Promise.resolve(payload) : Promise.resolve({ available: false }));
    render(<WorkflowTab />);
    await userEvent.click(await screen.findByRole("button", { name: /Statuses/i }));
  }

  test("groups statuses under category headings in workflow order", async () => {
    await open();

    const headings = await screen.findAllByRole("heading", { level: 4 });
    // To Do -> In Progress -> Done is the direction work travels; uncategorised last.
    expect(headings.map((h) => h.textContent.replace(/\d+$/, "").trim()))
      .toEqual(["To Do", "In Progress", "Done", "Uncategorised"]);
  });

  test("omits a category heading entirely when nothing matches the filter", async () => {
    await open();
    await screen.findAllByRole("heading", { level: 4 });

    await userEvent.type(screen.getByLabelText(/Filter statuses by name/i), "backlog");

    const headings = await screen.findAllByRole("heading", { level: 4 });
    expect(headings.map((h) => h.textContent.replace(/\d+$/, "").trim())).toEqual(["To Do"]);
  });

  test("falls back to Uncategorised rather than dropping a status with no category", async () => {
    await open();
    const headings = await screen.findAllByRole("heading", { level: 4 });
    const uncategorised = headings.find((h) => h.textContent.includes("Uncategorised"));

    expect(uncategorised).toBeDefined();
    // The status still renders -- an uncategorised status is a finding, not a thing to hide.
    expect(screen.getByText("Limbo")).toBeInTheDocument();
  });

  test("shows a key explaining the three metrics and the unmeasured dash", async () => {
    await open();

    expect(await screen.findByText(/in it now/i)).toBeInTheDocument();
    expect(screen.getByText(/ever entered/i)).toBeInTheDocument();
    expect(screen.getByText(/passed through and left/i)).toBeInTheDocument();
    expect(screen.getByText(/not measured/i)).toBeInTheDocument();
  });
});

// Jira Automation rules cannot be read from a Forge app: site-relative endpoints 401 with
// no declarable scope, the api.atlassian.com gateway rejects the route, and Forge exposes
// no automation permission (verified against forge lint). So a rule could still reference
// a status this app reports as unused, and the UI must not tell anyone it is safe to
// delete on evidence it does not have.
describe("WorkflowTab — automation caveat", () => {
  const insightsPayload = {
    available: true,
    schemeStatusesAvailable: true,
    hasIssueCounts: true,
    summary: {
      duplicateGroupCount: 0, duplicateStatusCount: 0, reducibleStatusCount: 0,
      orphanCount: 1, safeToRemoveCount: 1, flaggedSchemeCount: 0,
    },
    duplicateGroups: [],
    orphans: [{ statusId: "9", name: "Abandoned", issueCount: 0, safeToRemove: true }],
    balance: [],
    statusTotals: { catalogCount: 1, withIssues: 0 },
    snapshotStatus: { state: "ready", refreshedAt: "2026-08-03T12:00:00.000Z" },
  };

  async function openInsights() {
    invoke.mockImplementation((fn) => {
      if (fn === "getWorkflowInsights") return Promise.resolve(insightsPayload);
      return Promise.resolve({
        schemes: [], statuses: [], page: 1, pageSize: 10, totalCount: 0, totalPages: 1,
        snapshotStatus: { state: "ready", version: "v1", refreshedAt: "2026-08-03T12:00:00.000Z" },
      });
    });
    render(<WorkflowTab />);
    await userEvent.click(await screen.findByRole("button", { name: /Insights/i }));
  }

  test("warns that automation rules were not consulted", async () => {
    await openInsights();
    expect(await screen.findByText(/Automation rules are not included/i)).toBeInTheDocument();
  });

  test("never tells the reader a status is safe to remove", async () => {
    await openInsights();
    await screen.findByText(/Automation rules are not included/i);

    // "Never used" is a statement about evidence. "Safe to remove" is a recommendation the
    // app cannot support without seeing automation rules.
    expect(document.body.textContent).not.toMatch(/safe to remove/i);
    expect(document.body.textContent).not.toMatch(/safe to delete/i);
  });
});

// This tab was the outlier: a hand-rolled header at its own size, freshness inline beside
// the title, and horizontal pill sub-navigation where five other tabs use a sidebar. Moving
// between it and any other tab read as changing product.
describe("WorkflowTab — shared shell", () => {
  test("uses the shared page header, with freshness in the header's meta slot", async () => {
    const { container } = render(<WorkflowTab />);
    await screen.findByText("ADVEV Standard");

    expect(container.querySelector(".ui-pagehead__title")).toHaveTextContent(/Workflow & status inventory/);
    expect(container.querySelector(".ui-pagehead__meta")).toHaveTextContent(/Built/);
    // The old header markup is gone, not merely hidden behind it.
    expect(container.querySelector(".wf-header")).toBeNull();
  });

  test("navigates its views from the shared sidebar rather than horizontal pills", async () => {
    const { container } = render(<WorkflowTab />);
    await screen.findByText("ADVEV Standard");

    expect(container.querySelector(".sub-nav")).not.toBeNull();
    expect(container.querySelector(".wf-viewtab")).toBeNull();
  });

  test("drives both views from the shared toolbar", async () => {
    const user = userEvent.setup();
    const { container } = render(<WorkflowTab />);
    await screen.findByText("ADVEV Standard");

    expect(container.querySelector(".ui-controls")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: /statuses/i }));
    await screen.findByText("Open");
    expect(container.querySelector(".ui-controls")).not.toBeNull();
    expect(container.querySelector(".wf-statusbar")).toBeNull();
  });
});

// The Workflows tab carried a blanket caveat from before the automation pillar existed:
// "Automation rules are not included. Jira does not expose them to Forge apps." That stopped
// being true when rule exports started being shredded into automation_references. A warning
// that applies to every status tells a reader nothing about any status.
describe("WorkflowTab — unreachable statuses vs automation", () => {
  const withOrphans = (orphans, automationChecked) => ({
    available: true,
    schemeStatusesAvailable: true,
    hasIssueCounts: true,
    automationChecked,
    orphans,
    duplicateGroups: [],
    balance: [],
    summary: { duplicateGroupCount: 0, orphanCount: orphans.length, flaggedSchemeCount: 0 },
    statusTotals: { catalogCount: 10, withIssues: 5 },
    snapshotStatus: { state: "ready", refreshedAt: "2026-08-13T00:00:00Z" },
  });

  test("names the rules holding a status that otherwise looks safe to delete", () => {
    render(<WorkflowInsights insights={withOrphans([
      { statusId: "1", name: "Parking Lot", issueCount: 0, safeToRemove: true, automationRuleCount: 3 },
    ], true)} loading={false} />);

    // "never used" and "3 rules" sit on the same row deliberately: the second is the reason
    // the first is not permission to delete it.
    expect(screen.getByText("never used")).toBeInTheDocument();
    expect(screen.getByText("3 rules")).toBeInTheDocument();
  });

  test("stops calling a status safe once a rule references it", () => {
    const { container } = render(<WorkflowInsights insights={withOrphans([
      { statusId: "1", name: "Parking Lot", issueCount: 0, safeToRemove: true, automationRuleCount: 2 },
    ], true)} loading={false} />);

    expect(container.querySelector(".wf-orphan--safe")).toBeNull();
  });

  test("keeps the safe marker for a status nothing references", () => {
    const { container } = render(<WorkflowInsights insights={withOrphans([
      { statusId: "1", name: "Ghost", issueCount: 0, safeToRemove: true, automationRuleCount: 0 },
    ], true)} loading={false} />);

    expect(container.querySelector(".wf-orphan--safe")).not.toBeNull();
  });

  // The caveat is still the honest answer when nothing has been imported to check against.
  test("keeps the blanket warning only while it cannot check", () => {
    render(<WorkflowInsights insights={withOrphans([
      { statusId: "1", name: "Ghost", issueCount: 0, safeToRemove: true, automationRuleCount: null },
    ], false)} loading={false} />);

    expect(screen.getByText(/no rule export has been imported/i)).toBeInTheDocument();
  });

  test("drops the blanket warning once every status carries its own answer", () => {
    render(<WorkflowInsights insights={withOrphans([
      { statusId: "1", name: "Ghost", issueCount: 0, safeToRemove: true, automationRuleCount: 0 },
    ], true)} loading={false} />);

    expect(screen.queryByText(/Automation rules are not included/i)).not.toBeInTheDocument();
  });
});
