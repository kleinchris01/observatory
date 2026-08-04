import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { WorkflowTab } from "./WorkflowTab";

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

    await user.click(screen.getByRole("button", { name: /^Done/ }));

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
  const inGrid = () => document.querySelector(".wf-status-grid");
  const gridHas = (name) => within(inGrid()).queryAllByText(name).length > 0;

  test("shows both measures for each status", async () => {
    await openStatuses();
    await waitFor(() => expect(inGrid()).not.toBeNull());
    expect(gridHas("Backlog")).toBe(true);
    expect(within(inGrid()).getByText("9,423")).toBeInTheDocument();
    expect(within(inGrid()).getByText("12,000")).toBeInTheDocument();
  });

  test("filters to statuses that are empty now but were used before", async () => {
    await openStatuses();
    await waitFor(() => expect(gridHas("Backlog")).toBe(true));

    await userEvent.selectOptions(screen.getByLabelText(/Filter statuses by usage/i), "empty");

    // The signal: nothing sits here now, but 4,000 issues passed through.
    expect(gridHas("Parking Lot")).toBe(true);
    expect(gridHas("Backlog")).toBe(false);
    expect(gridHas("Ghost Status")).toBe(false);
  });

  test("filters to statuses no issue has ever entered", async () => {
    await openStatuses();
    await waitFor(() => expect(gridHas("Backlog")).toBe(true));

    await userEvent.selectOptions(screen.getByLabelText(/Filter statuses by usage/i), "never");

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

    expect(screen.getAllByText("—").length).toBeGreaterThan(0);

    await userEvent.selectOptions(screen.getByLabelText(/Filter statuses by usage/i), "never");
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
