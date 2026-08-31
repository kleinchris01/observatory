import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  router: { open: vi.fn() },
}));

import { invoke } from "@forge/bridge";
import { MacroFiltersView, MacroDashboardsView, MacroWorkflowsView } from "./MacroViewerPillars";

beforeEach(() => { invoke.mockReset(); });

describe("MacroFiltersView", () => {
  it("lists the viewer's project filters with the scope note and JQL", async () => {
    invoke.mockResolvedValue({
      available: true, projectCount: 1, total: 1, matchedTotal: 1, page: 1, totalPages: 1,
      snapshotRefreshedAt: new Date().toISOString(),
      filters: [{ id: "5", name: "Solve open bugs", jql: "project = SOLVE AND status != Done", owner: "Bo", projects: ["SOLVE"], fields: ["Priority"], viewUrl: null }],
    });
    render(<MacroFiltersView siteOrigin="https://x.atlassian.net" />);

    expect(await screen.findByText("Solve open bugs")).toBeInTheDocument();
    expect(screen.getByText(/Scoped to the 1 project you can browse/i)).toBeInTheDocument();
    expect(screen.getByText(/project = SOLVE AND status != Done/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Solve open bugs" })).toHaveAttribute("href", "https://x.atlassian.net/issues/?filter=5");
  });

  it("says the inventory has not been built rather than erroring", async () => {
    invoke.mockResolvedValue({ available: false, reason: "no-inventory", filters: [] });
    render(<MacroFiltersView siteOrigin="" />);
    expect(await screen.findByText(/inventory has not been built/i)).toBeInTheDocument();
  });

  it("debounces a search into the resolver call", async () => {
    invoke.mockResolvedValue({ available: true, projectCount: 1, total: 0, matchedTotal: 0, page: 1, totalPages: 1, filters: [] });
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
      available: true, projectCount: 2, total: 1, matchedTotal: 1, page: 1, totalPages: 1,
      dashboards: [{ id: "D1", name: "Solve delivery", owner: "Al", gadgetCount: 4, fields: ["Story Points", "Sprint"], sharedToProject: true, viewUrl: null }],
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
      available: true, projectCount: 1,
      schemes: [{ schemeId: "WS1", name: "Solve workflow", projects: ["SOLVE"], statuses: [
        { id: "s1", name: "Open", category: "To Do" }, { id: "s2", name: "Done", category: "Done" },
      ] }],
      statuses: [{ id: "s1", name: "Open", category: "To Do" }, { id: "s2", name: "Done", category: "Done" }],
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
    expect(await screen.findByText(/none of the projects you can browse resolve to a workflow scheme/i)).toBeInTheDocument();
  });
});
