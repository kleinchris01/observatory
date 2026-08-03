import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
