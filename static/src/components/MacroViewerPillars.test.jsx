import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  router: { open: vi.fn() },
}));

import { invoke } from "@forge/bridge";
import {
  MacroFiltersView,
  MacroDashboardsView,
  MacroWorkflowsView,
  MacroScreensView,
  MacroIssueTypesView,
  MacroBoardsView,
} from "./MacroViewerPillars";

beforeEach(() => {
  invoke.mockReset();
});

describe("MacroFiltersView", () => {
  it("lists the viewer's project filters with the scope note and JQL", async () => {
    invoke.mockResolvedValue({
      available: true,
      projectCount: 1,
      total: 1,
      matchedTotal: 1,
      page: 1,
      totalPages: 1,
      snapshotRefreshedAt: new Date().toISOString(),
      filters: [
        {
          id: "5",
          name: "Solve open bugs",
          jql: "project = SOLVE AND status != Done",
          owner: "Bo",
          projects: ["SOLVE"],
          fields: ["Priority"],
          viewUrl: null,
        },
      ],
    });
    render(<MacroFiltersView siteOrigin="https://x.atlassian.net" />);

    expect(await screen.findByText("Solve open bugs")).toBeInTheDocument();
    expect(screen.getByText(/Scoped to the 1 project you can browse/i)).toBeInTheDocument();
    expect(screen.getByText(/project = SOLVE AND status != Done/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Solve open bugs" })).toHaveAttribute(
      "href",
      "https://x.atlassian.net/issues/?filter=5",
    );
  });

  it("says the inventory has not been built rather than erroring", async () => {
    invoke.mockResolvedValue({ available: false, reason: "no-inventory", filters: [] });
    render(<MacroFiltersView siteOrigin="" />);
    expect(await screen.findByText(/inventory has not been built/i)).toBeInTheDocument();
  });

  it("debounces a search into the resolver call", async () => {
    invoke.mockResolvedValue({
      available: true,
      projectCount: 1,
      total: 0,
      matchedTotal: 0,
      page: 1,
      totalPages: 1,
      filters: [],
    });
    render(<MacroFiltersView siteOrigin="" />);
    await screen.findByText(/No saved filter targets a project you can browse/i);

    await userEvent.type(screen.getByRole("searchbox"), "bug");
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("getMacroFilters", { query: "bug", page: 1 });
    });
  });
});

describe("MacroDashboardsView", () => {
  it("shows dashboards with their field dependencies and a shared-to-project marker", async () => {
    invoke.mockResolvedValue({
      available: true,
      projectCount: 2,
      total: 1,
      matchedTotal: 1,
      page: 1,
      totalPages: 1,
      dashboards: [
        {
          id: "D1",
          name: "Solve delivery",
          owner: "Al",
          gadgetCount: 4,
          fields: ["Story Points", "Sprint"],
          sharedToProject: true,
          viewUrl: null,
        },
      ],
    });
    render(<MacroDashboardsView siteOrigin="https://x.atlassian.net" />);

    expect(await screen.findByText("Solve delivery")).toBeInTheDocument();
    expect(screen.getByText("shared to your project")).toBeInTheDocument();
    expect(screen.getByText(/Depends on: Story Points, Sprint/)).toBeInTheDocument();
  });
});

describe("MacroWorkflowsView", () => {
  it("groups the viewer's projects by scheme and renders each scheme's statuses", async () => {
    invoke.mockResolvedValue({
      available: true,
      projectCount: 1,
      schemes: [
        {
          schemeId: "WS1",
          name: "Solve workflow",
          projects: ["SOLVE"],
          statuses: [
            { id: "s1", name: "Open", category: "To Do" },
            { id: "s2", name: "Done", category: "Done" },
          ],
        },
      ],
      statuses: [
        { id: "s1", name: "Open", category: "To Do" },
        { id: "s2", name: "Done", category: "Done" },
      ],
      snapshotRefreshedAt: new Date().toISOString(),
    });
    render(<MacroWorkflowsView />);

    expect(await screen.findByText("Solve workflow")).toBeInTheDocument();
    expect(screen.getAllByText("Open").length).toBeGreaterThan(0);
    expect(screen.getByText(/2 distinct statuses across your projects/i)).toBeInTheDocument();
  });

  it("explains when none of the viewer's projects resolve to a scheme", async () => {
    invoke.mockResolvedValue({ available: true, projectCount: 3, schemes: [], statuses: [] });
    render(<MacroWorkflowsView />);
    expect(
      await screen.findByText(/none of the projects you can browse resolve to a workflow scheme/i),
    ).toBeInTheDocument();
  });
});

// The three pillars the macro gained. Each answers the same four questions -- loading, not
// built, built-but-none-of-it-yours, and here-it-is -- and the middle pair are the ones that
// matter: "nobody has built this" and "it is built and none of it is yours" send a reader to
// two different people.
describe("MacroScreensView", () => {
  const payload = (over = {}) => ({
    available: true,
    projectCount: 1,
    refreshedAt: new Date().toISOString(),
    projects: [
      {
        projectId: "10",
        projectKey: "OPS",
        projectName: "Operations",
        createFieldCount: 34,
        screens: [
          {
            screenId: "1",
            name: "Create issue",
            fieldCount: 34,
            tabCount: 2,
            unreadable: false,
            operations: ["create", "view"],
          },
          { screenId: "2", name: "Edit issue", fieldCount: 12, tabCount: 1, unreadable: false, operations: ["edit"] },
        ],
      },
    ],
    ...over,
  });

  it("leads with the length of the form nobody filing an issue can skip", async () => {
    invoke.mockResolvedValue(payload());
    render(<MacroScreensView />);

    expect(await screen.findByText(/34 fields to create an issue/i)).toBeInTheDocument();
    expect(screen.getByText("Create issue")).toBeInTheDocument();
    expect(screen.getByText("OPS")).toBeInTheDocument();
  });

  it("states the scope rather than leaving the reader to wonder", async () => {
    invoke.mockResolvedValue(payload());
    render(<MacroScreensView />);
    expect(await screen.findByText(/scoped to the 1 project you can browse/i)).toBeInTheDocument();
  });

  it("never shows a screen it could not read as having no fields", async () => {
    invoke.mockResolvedValue(
      payload({
        projects: [
          {
            projectId: "10",
            projectKey: "OPS",
            projectName: "Operations",
            createFieldCount: 0,
            screens: [
              {
                screenId: "1",
                name: "Create issue",
                fieldCount: 0,
                tabCount: 0,
                unreadable: true,
                operations: ["create"],
              },
            ],
          },
        ],
      }),
    );
    render(<MacroScreensView />);

    expect(await screen.findByText("not readable")).toBeInTheDocument();
    expect(screen.queryByText("0 fields")).not.toBeInTheDocument();
  });

  it("separates an unbuilt inventory from one holding nothing of yours", async () => {
    invoke.mockResolvedValue({ available: false, reason: "no-inventory", projects: [], projectCount: 0 });
    const { unmount } = render(<MacroScreensView />);
    expect(await screen.findByText(/ask a jira admin to run a scan/i)).toBeInTheDocument();
    unmount();

    invoke.mockResolvedValue(payload({ projects: [] }));
    render(<MacroScreensView />);
    expect(await screen.findByText(/none of the projects you can browse/i)).toBeInTheDocument();
  });

  it("surfaces a resolver failure instead of an empty panel", async () => {
    invoke.mockRejectedValueOnce(new Error("resolver exploded"));
    render(<MacroScreensView />);
    expect(await screen.findByText(/resolver exploded/i)).toBeInTheDocument();
  });
});

describe("MacroIssueTypesView", () => {
  const payload = (over = {}) => ({
    available: true,
    projectCount: 2,
    refreshedAt: new Date().toISOString(),
    schemes: [
      {
        schemeId: "S1",
        name: "Default scheme",
        projects: ["OPS", "FIN"],
        issueTypes: [
          { id: "1", name: "Bug", subtask: false, missing: false },
          { id: "2", name: "Sub-task", subtask: true, missing: false },
        ],
      },
    ],
    ...over,
  });

  it("groups by scheme, because the grouping is the information", async () => {
    // Projects sharing a scheme are MEANT to run the same set. A project sitting alone in a
    // group is the question worth asking, and grouping makes it visible without comparison.
    invoke.mockResolvedValue(payload());
    render(<MacroIssueTypesView />);

    expect(await screen.findByText("Default scheme")).toBeInTheDocument();
    expect(screen.getByText("OPS")).toBeInTheDocument();
    expect(screen.getByText("FIN")).toBeInTheDocument();
    expect(screen.getByText(/Sub-task \(sub-task\)/)).toBeInTheDocument();
  });

  it("shows a member type the catalogue has lost rather than hiding it", async () => {
    invoke.mockResolvedValue(
      payload({
        schemes: [
          {
            schemeId: "S1",
            name: "Default",
            projects: ["OPS"],
            issueTypes: [{ id: "999", name: null, subtask: false, missing: true }],
          },
        ],
      }),
    );
    render(<MacroIssueTypesView />);
    expect(await screen.findByText(/#999 — missing/)).toBeInTheDocument();
  });
});

describe("MacroBoardsView", () => {
  const payload = (over = {}) => ({
    available: true,
    projectCount: 1,
    refreshedAt: new Date().toISOString(),
    boards: [
      { boardId: "1", name: "Ops board", type: "scrum", projectKey: "OPS", columnCount: 4, configReadable: true },
    ],
    ...over,
  });

  it("lists the boards living in the viewer's projects", async () => {
    invoke.mockResolvedValue(payload());
    render(<MacroBoardsView />);

    expect(await screen.findByText("Ops board")).toBeInTheDocument();
    expect(screen.getByText("4 columns")).toBeInTheDocument();
  });

  it("keeps an unreadable board and says its detail is unknown", async () => {
    // Team-managed boards routinely refuse the configuration endpoint. Dropping them reads as
    // "you have no board here" to somebody looking straight at one.
    invoke.mockResolvedValue(
      payload({
        boards: [
          {
            boardId: "9",
            name: "Team board",
            type: "kanban",
            projectKey: "OPS",
            columnCount: 0,
            configReadable: false,
          },
        ],
      }),
    );
    render(<MacroBoardsView />);

    expect(await screen.findByText("Team board")).toBeInTheDocument();
    expect(screen.getByText(/columns are unknown/i)).toBeInTheDocument();
    expect(screen.queryByText("0 columns")).not.toBeInTheDocument();
  });
});
