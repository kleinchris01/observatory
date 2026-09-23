import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { RemediationTab } from "./RemediationTab";

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

beforeEach(() => vi.clearAllMocks());

function mockInvoke(handlers) {
  invoke.mockImplementation((fn, payload) => {
    const handler = handlers[fn];
    if (!handler) return Promise.resolve({});
    return Promise.resolve(typeof handler === "function" ? handler(payload) : handler);
  });
}

describe("RemediationTab", () => {
  test("lists every finding in the catalog, connected and not", async () => {
    mockInvoke({ getRemediationTickets: { available: false, total: 0, groups: [] } });
    render(<RemediationTab siteOrigin="https://acme.atlassian.net" />);

    expect(await screen.findByText("Filter ownership")).toBeInTheDocument();
    expect(screen.getByText("Dashboard ownership")).toBeInTheDocument();
    // Not yet wired to a real item source -- shown, but says so rather than pretending.
    expect(screen.getByText("Status reachability")).toBeInTheDocument();
    expect(screen.getAllByText(/Not connected yet/i).length).toBeGreaterThan(0);
  });

  test("shows an existing epic's status and its tasks", async () => {
    mockInvoke({
      getRemediationTickets: {
        available: true,
        total: 2,
        groups: [{
          findingKey: "filter-ownership",
          pillar: "filters",
          epic: { issueKey: "ADMIN-1", lastStatus: "In Progress", lastStatusCategory: "indeterminate" },
          tasks: [
            { issueKey: "ADMIN-2", itemId: "4001", summary: "Reassign filter \"Open Bugs\"", lastStatus: "Done", lastStatusCategory: "done", assigneeName: "Sam", syncedAt: "2026-09-20T00:00:00Z" },
          ],
          taskCount: 1,
          openCount: 0,
        }],
      },
    });

    render(<RemediationTab siteOrigin="https://acme.atlassian.net" />);

    expect(await screen.findByText("ADMIN-1")).toBeInTheDocument();
    expect(screen.getByText("ADMIN-2")).toBeInTheDocument();
    expect(screen.getByText("Sam")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  test("checking current items shows candidates and lets you create the epic", async () => {
    const createRemediationEpic = vi.fn().mockResolvedValue({ ok: true, epicKey: "ADMIN-1", tasksCreated: 2 });
    mockInvoke({
      getRemediationTickets: { available: false, total: 0, groups: [] },
      getRemediationCandidates: (payload) => payload.findingKey === "filter-ownership"
        ? { available: true, items: [{ id: "4001", name: "Open Bugs" }, { id: "4002", name: "Sprint Filter" }] }
        : { available: false, reason: "not-connected", items: [] },
      createRemediationEpic,
    });

    const user = userEvent.setup();
    render(<RemediationTab siteOrigin="https://acme.atlassian.net" />);
    await screen.findByText("Filter ownership");

    const checkButtons = screen.getAllByRole("button", { name: /Check current items/i });
    await user.click(checkButtons[0]);

    expect(await screen.findByText(/2 items flagged/)).toBeInTheDocument();
    const createButton = screen.getByRole("button", { name: /Create remediation epic \(2 tasks\)/i });
    await user.click(createButton);

    await waitFor(() => expect(createRemediationEpic).toHaveBeenCalledWith(expect.objectContaining({
      findingKey: "filter-ownership",
      items: [{ id: "4001", name: "Open Bugs" }, { id: "4002", name: "Sprint Filter" }],
    })));
  });

  test("shows the resolver's error rather than pretending the create worked", async () => {
    mockInvoke({
      getRemediationTickets: { available: false, total: 0, groups: [] },
      getRemediationCandidates: { available: true, items: [{ id: "1", name: "X" }] },
      createRemediationEpic: { error: "No remediation project is configured." },
    });

    const user = userEvent.setup();
    render(<RemediationTab siteOrigin="https://acme.atlassian.net" />);
    await user.click((await screen.findAllByRole("button", { name: /Check current items/i }))[0]);
    await user.click(await screen.findByRole("button", { name: /Create remediation epic/i }));

    expect(await screen.findByText("No remediation project is configured.")).toBeInTheDocument();
  });

  test("a finding already fully ticketed disables the create button", async () => {
    mockInvoke({
      getRemediationTickets: {
        available: true,
        total: 1,
        groups: [{
          findingKey: "filter-ownership", pillar: "filters",
          epic: { issueKey: "ADMIN-1" },
          tasks: [{ issueKey: "ADMIN-2", itemId: "4001", summary: "x", lastStatusCategory: "indeterminate" }],
          taskCount: 1, openCount: 1,
        }],
      },
      getRemediationCandidates: { available: true, items: [{ id: "4001", name: "Open Bugs" }] },
    });

    const user = userEvent.setup();
    render(<RemediationTab siteOrigin="https://acme.atlassian.net" />);
    await user.click((await screen.findAllByRole("button", { name: /Check current items/i }))[0]);

    expect(await screen.findByRole("button", { name: /Everything is already ticketed/i })).toBeDisabled();
  });
});
