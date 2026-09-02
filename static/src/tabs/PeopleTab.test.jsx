import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { PeopleTab } from "./PeopleTab";

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

const roster = (over = {}) => ({
  neverBuilt: false,
  state: "ready",
  staleBuild: false,
  version: "v1",
  refreshedAt: new Date().toISOString(),
  governance: {
    totalUsers: 3, activeUsers: 3, appUsers: 1, multiProductUsers: 1,
    orphanedOwners: 1, orphanedFilters: 4, orphanedDashboards: 1, orphanedRules: 0,
  },
  applicationSummary: [
    { key: "jira-software", name: "Jira Software", numberOfSeats: 5, remainingSeats: 2, userCount: 3, hasUnlimitedSeats: false },
    { key: "jira-servicedesk", name: "Jira Service Management", numberOfSeats: 2, remainingSeats: 1, userCount: 1, hasUnlimitedSeats: false },
  ],
  users: [
    { accountId: "a1", displayName: "Ann Admin", active: true, accountType: "atlassian",
      applications: [{ key: "jira-software", name: "Jira Software" }, { key: "jira-servicedesk", name: "JSM" }],
      groups: [{ id: "g1", name: "jira-software-users" }, { id: "g2", name: "jsm-users" }],
      ownedFilters: 2, ownedDashboards: 1, authoredRules: 0 },
    { accountId: "a2", displayName: "Bot Account", active: true, accountType: "app",
      applications: [{ key: "jira-software", name: "Jira Software" }], groups: [{ id: "g1", name: "jira-software-users" }],
      ownedFilters: 0, ownedDashboards: 0, authoredRules: 0 },
  ],
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("PeopleTab", () => {
  test("reports never-built rather than an empty roster", async () => {
    invoke.mockResolvedValue({ neverBuilt: true, state: "idle" });
    render(<PeopleTab />);
    expect(await screen.findByText(/No licensed-user roster has been built yet/i)).toBeInTheDocument();
  });

  test("shows the seat summary and licensed-user count", async () => {
    invoke.mockImplementation((fn) => fn === "getUserInventory" ? Promise.resolve(roster()) : Promise.resolve({}));
    render(<PeopleTab />);

    expect(await screen.findByText("People")).toBeInTheDocument();
    expect(screen.getByText("Licensed users")).toBeInTheDocument();
    // 4 of 7 total product seats used across the two products.
    expect(screen.getByText("4 / 7")).toBeInTheDocument();
    // The app account is surfaced as something to review.
    expect(screen.getByText("App accounts")).toBeInTheDocument();
  });

  test("lists each user with their products and access groups on the Roster view", async () => {
    invoke.mockImplementation((fn) => fn === "getUserInventory" ? Promise.resolve(roster()) : Promise.resolve({}));
    render(<PeopleTab />);

    await screen.findByText("People");
    await userEvent.click(screen.getByRole("button", { name: /^Roster/ }));

    expect(await screen.findByText("Ann Admin")).toBeInTheDocument();
    expect(screen.getByText(/via jira-software-users, jsm-users/)).toBeInTheDocument();
    // The app account is chipped.
    expect(screen.getByText("Bot Account")).toBeInTheDocument();
    expect(screen.getByText("app")).toBeInTheDocument();
  });

  test("shows an owns-summary chip and expands to the owned artifacts on click", async () => {
    invoke.mockImplementation((fn, payload) => {
      if (fn === "getUserInventory") return Promise.resolve(roster());
      if (fn === "getUserDetails" && payload.accountId === "a1") {
        return Promise.resolve({
          available: true, inRoster: true,
          user: roster().users[0],
          ownedFilters: [{ id: "10", name: "My board filter", viewUrl: "https://x/f/10" }],
          ownedDashboards: [{ id: "20", name: "Ops dashboard", viewUrl: null }],
          authoredRules: [],
          ownershipAvailable: { filters: true, dashboards: true, rules: false },
        });
      }
      return Promise.resolve({});
    });
    render(<PeopleTab />);
    await screen.findByText("People");
    await userEvent.click(screen.getByRole("button", { name: /^Roster/ }));

    expect(await screen.findByText(/owns 2 filters · 1 dashboard/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Ann Admin/ }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("getUserDetails", { accountId: "a1" }));
    expect(await screen.findByText("My board filter")).toBeInTheDocument();
    expect(screen.getByText("Ops dashboard")).toBeInTheDocument();
    expect(screen.getByText(/Rule authorship needs a rule export/i)).toBeInTheDocument();
  });

  test("surfaces orphaned ownership on the overview", async () => {
    invoke.mockImplementation((fn) => fn === "getUserInventory" ? Promise.resolve(roster()) : Promise.resolve({}));
    render(<PeopleTab />);
    expect(await screen.findByText("Orphaned ownership")).toBeInTheDocument();
    // 4 filters + 1 dashboard owned by an account not in the roster.
    expect(screen.getByText("Filters")).toBeInTheDocument();
  });

  test("queues a build and reports it", async () => {
    invoke.mockImplementation((fn) => {
      if (fn === "getUserInventory") return Promise.resolve(roster());
      if (fn === "buildUserInventory") return Promise.resolve({ queued: true });
      return Promise.resolve({});
    });
    render(<PeopleTab />);

    await screen.findByText("People");
    await userEvent.click(screen.getByRole("button", { name: /Rebuild/ }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("buildUserInventory", {}));
    expect(await screen.findByText(/Build queued/i)).toBeInTheDocument();
  });
});
