import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { RemediationTab } from "./RemediationTab";

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

beforeEach(() => vi.clearAllMocks());

// The catalog the server serves with the tickets (listPlaybookCatalog). A representative slice
// is enough: the tab renders whatever it is given.
const CATALOG = [
  ["filter-ownership", "Filter ownership", "filters"],
  ["dashboard-ownership", "Dashboard ownership", "dashboards"],
  ["field-cleanup", "Fields with no populated issues", "fields"],
  ["user-licence-hygiene", "Licence hygiene", "users"],
  ["user-ownership", "Ownership continuity", "users"],
  ["status-reachability", "Status reachability", "workflows"],
  ["board-backing", "Board backing filters", "boards"],
  ["filter-duplicates", "Duplicate filters", "filters"],
  ["filter-scope", "Filter scope references", "filters"],
  ["screen-unreachable-fields", "Unreachable fields", "screens"],
  ["screen-unreached", "Screens nothing reaches", "screens"],
  ["issue-type-reach", "Orphaned issue types", "issueTypes"],
  ["issue-type-naming", "Duplicate issue type names", "issueTypes"],
  ["asset-schema-hygiene", "Dead Assets schemas", "assets"],
  ["asset-type-usage", "Empty Assets object types", "assets"],
  ["role-offroster-actors", "Project-role actors off the licensed roster", "roles"],
].map(([key, label, pillar]) => ({ key, label, pillar, findings: [], granularity: key === "role-offroster-actors" ? "bounded" : "item" }));

// Fills in what every real getRemediationTickets response carries -- the catalog, the current
// quarter, and each group's isCurrent -- so a test only states what it is about.
function withDefaults(result) {
  return {
    period: "2026-Q3",
    catalog: CATALOG,
    ...result,
    groups: (result.groups || []).map((g) => ({ period: "2026-Q3", isCurrent: true, previousPeriods: [], ...g })),
  };
}

// Open one finding's current items by its card title, not by position: cards are grouped by
// pillar, so "the first card" is not a stable way to name one.
async function checkItems(user, title = "Filter ownership") {
  const toggle = await screen.findByRole("button", { name: new RegExp(`^${title}`, "i") });
  const panel = toggle.closest(".ui-panel");
  await user.click(within(panel).getByRole("button", { name: /Check current items/i }));
}

function mockInvoke(handlers) {
  invoke.mockImplementation((fn, payload) => {
    const handler = handlers[fn];
    if (!handler) return Promise.resolve({});
    const result = typeof handler === "function" ? handler(payload) : handler;
    return Promise.resolve(fn === "getRemediationTickets" ? withDefaults(result) : result);
  });
}

describe("RemediationTab", () => {
  test("lists every finding in the catalog", async () => {
    mockInvoke({ getRemediationTickets: { available: false, total: 0, groups: [] } });
    render(<RemediationTab siteOrigin="https://acme.atlassian.net" />);

    expect(await screen.findByText("Filter ownership")).toBeInTheDocument();
    expect(screen.getByText("Dashboard ownership")).toBeInTheDocument();
    expect(screen.getByText("Fields with no populated issues")).toBeInTheDocument();
    expect(screen.getByText("Licence hygiene")).toBeInTheDocument();
    expect(screen.getByText("Ownership continuity")).toBeInTheDocument();
    expect(screen.getByText("Status reachability")).toBeInTheDocument();
    expect(screen.getByText("Board backing filters")).toBeInTheDocument();
    expect(screen.getByText("Duplicate filters")).toBeInTheDocument();
    expect(screen.getByText("Filter scope references")).toBeInTheDocument();
    expect(screen.getByText("Unreachable fields")).toBeInTheDocument();
    expect(screen.getByText("Orphaned issue types")).toBeInTheDocument();
    expect(screen.getByText("Duplicate issue type names")).toBeInTheDocument();
    expect(screen.getByText("Dead Assets schemas")).toBeInTheDocument();
    expect(screen.getByText("Empty Assets object types")).toBeInTheDocument();
  });

  test("each finding's section collapses and re-expands independently", async () => {
    mockInvoke({ getRemediationTickets: { available: false, total: 0, groups: [] } });
    const user = userEvent.setup();
    render(<RemediationTab siteOrigin="https://acme.atlassian.net" />);
    await screen.findByText("Filter ownership");

    const toggles = screen.getAllByRole("button", { name: /Filter ownership|Dashboard ownership/i });
    const filterToggle = toggles.find((b) => b.textContent.includes("Filter ownership"));
    const dashboardToggle = toggles.find((b) => b.textContent.includes("Dashboard ownership"));

    // Both start expanded -- each panel's own "Check current items" button is visible.
    expect(screen.getAllByRole("button", { name: /Check current items/i }).length).toBeGreaterThanOrEqual(2);

    await user.click(filterToggle);
    expect(filterToggle).toHaveAttribute("aria-expanded", "false");
    // Collapsing one finding does not touch the other's expanded state.
    expect(dashboardToggle).toHaveAttribute("aria-expanded", "true");

    await user.click(filterToggle);
    expect(filterToggle).toHaveAttribute("aria-expanded", "true");
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

    await checkItems(user);

    expect(await screen.findByText(/2 items flagged/)).toBeInTheDocument();
    const createButton = screen.getByRole("button", { name: /Create (\d{4}-Q\d )?remediation epic \(2 tasks\)/i });
    await user.click(createButton);

    await waitFor(() => expect(createRemediationEpic).toHaveBeenCalledWith(expect.objectContaining({
      findingKey: "filter-ownership",
      items: [{ id: "4001", name: "Open Bugs" }, { id: "4002", name: "Sprint Filter" }],
    })));
  });

  // The resolver only ever creates a bounded batch per call (a synchronous Forge resolver
  // has a hard execution ceiling) and reports itemsRemaining when there is more to do. The
  // tab is what turns a truncated single call into a completed bulk action, by calling the
  // idempotent resolver again with the same item list until itemsRemaining is zero.
  test("a large finding is finished by chaining batches, not silently truncated at one", async () => {
    let call = 0;
    const createRemediationEpic = vi.fn().mockImplementation(() => {
      call += 1;
      return Promise.resolve(
        call === 1
          ? { ok: true, epicKey: "ADMIN-899", tasksCreated: 20, itemsRemaining: 5 }
          : { ok: true, epicKey: "ADMIN-899", tasksCreated: 5, itemsRemaining: 0 }
      );
    });
    const items = Array.from({ length: 25 }, (_, i) => ({ id: `item-${i}`, name: `Item ${i}` }));
    mockInvoke({
      getRemediationTickets: { available: false, total: 0, groups: [] },
      getRemediationCandidates: { available: true, items },
      createRemediationEpic,
    });

    const user = userEvent.setup();
    render(<RemediationTab siteOrigin="https://acme.atlassian.net" />);
    await checkItems(user);
    await user.click(await screen.findByRole("button", { name: /Create (\d{4}-Q\d )?remediation epic \(25 tasks\)/i }));

    await waitFor(() => expect(createRemediationEpic).toHaveBeenCalledTimes(2));
    // Both calls carry the full, unchanged item list -- the resolver is what skips what is
    // already ticketed, keyed on item id, not the caller trimming the list itself.
    expect(createRemediationEpic).toHaveBeenNthCalledWith(1, expect.objectContaining({ items }));
    expect(createRemediationEpic).toHaveBeenNthCalledWith(2, expect.objectContaining({ items }));
  });

  test("shows live progress while a large finding is still batching", async () => {
    let resolveSecondBatch;
    const createRemediationEpic = vi.fn()
      .mockResolvedValueOnce({ ok: true, epicKey: "ADMIN-899", tasksCreated: 20, itemsRemaining: 5 })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecondBatch = resolve; }));
    const items = Array.from({ length: 25 }, (_, i) => ({ id: `item-${i}`, name: `Item ${i}` }));
    mockInvoke({
      getRemediationTickets: { available: false, total: 0, groups: [] },
      getRemediationCandidates: { available: true, items },
      createRemediationEpic,
    });

    const user = userEvent.setup();
    render(<RemediationTab siteOrigin="https://acme.atlassian.net" />);
    await checkItems(user);
    await user.click(await screen.findByRole("button", { name: /Create (\d{4}-Q\d )?remediation epic \(25 tasks\)/i }));

    // Mid-loop: the first batch landed, the second is still in flight -- the button and the
    // helper text both say where the loop actually is, not just "Creating...".
    expect(await screen.findByRole("button", { name: /Creating… 20 of 25/i })).toBeInTheDocument();
    expect(screen.getByText(/20 of 25 so far/)).toBeInTheDocument();

    resolveSecondBatch({ ok: true, epicKey: "ADMIN-899", tasksCreated: 5, itemsRemaining: 0 });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Creating/i })).not.toBeInTheDocument());
  });

  test("reports partial failures after the loop finishes rather than dropping them", async () => {
    const createRemediationEpic = vi.fn().mockResolvedValue({
      ok: true, epicKey: "ADMIN-1", tasksCreated: 1, itemsRemaining: 0,
      failures: [{ itemId: "4002", error: "Field 'customfield_10099' is required." }],
    });
    mockInvoke({
      getRemediationTickets: { available: false, total: 0, groups: [] },
      getRemediationCandidates: { available: true, items: [{ id: "4001", name: "Open Bugs" }, { id: "4002", name: "Sprint Filter" }] },
      createRemediationEpic,
    });

    const user = userEvent.setup();
    render(<RemediationTab siteOrigin="https://acme.atlassian.net" />);
    await checkItems(user);
    await user.click(await screen.findByRole("button", { name: /Create (\d{4}-Q\d )?remediation epic \(2 tasks\)/i }));

    expect(await screen.findByText(/1 item failed/)).toBeInTheDocument();
    expect(screen.getByText(/customfield_10099/)).toBeInTheDocument();
  });

  test("shows the resolver's error rather than pretending the create worked", async () => {
    mockInvoke({
      getRemediationTickets: { available: false, total: 0, groups: [] },
      getRemediationCandidates: { available: true, items: [{ id: "1", name: "X" }] },
      createRemediationEpic: { error: "No remediation project is configured." },
    });

    const user = userEvent.setup();
    render(<RemediationTab siteOrigin="https://acme.atlassian.net" />);
    await checkItems(user);
    await user.click(await screen.findByRole("button", { name: /Create (\d{4}-Q\d )?remediation epic/i }));

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
    await checkItems(user);

    expect(await screen.findByRole("button", { name: /Everything is already ticketed/i })).toBeDisabled();
  });
});

describe("RemediationTab — quarters, confirmation, deep links", () => {
  test("a finding last worked in an earlier quarter lists that quarter and offers this quarter's epic", async () => {
    mockInvoke({
      getRemediationTickets: {
        available: true,
        total: 2,
        groups: [{
          findingKey: "filter-ownership", pillar: "filters", period: "2026-Q2", isCurrent: false,
          epic: { issueKey: "ADMIN-1", lastStatusCategory: "done" },
          tasks: [{ issueKey: "ADMIN-2", itemId: "4001", summary: "x", lastStatusCategory: "done" }],
          taskCount: 1, openCount: 0,
          previousPeriods: [{ period: "2026-Q1", epicKey: "ADMIN-0", taskCount: 3, openCount: 0 }],
        }],
      },
      // The same filter is flagged again: its Q2 task is done, so it belongs in Q3's epic.
      getRemediationCandidates: { available: true, items: [{ id: "4001", name: "Open Bugs" }] },
    });
    const user = userEvent.setup();
    render(<RemediationTab siteOrigin="https://acme.atlassian.net" />);

    expect(await screen.findByText(/Earlier quarters:/)).toBeInTheDocument();
    expect(screen.getByText(/2026-Q2 epic/)).toBeInTheDocument();
    await checkItems(user);
    expect(await screen.findByRole("button", { name: "Create 2026-Q3 remediation epic (1 task)" })).toBeEnabled();
  });

  test("more than CONFIRM_ABOVE new tasks asks before creating anything", async () => {
    const createRemediationEpic = vi.fn(() => ({ ok: true, epicKey: "ADMIN-1", tasksCreated: 20, itemsRemaining: 0 }));
    const items = Array.from({ length: 250 }, (_, i) => ({ id: `f${i}`, name: `F${i}` }));
    mockInvoke({
      getRemediationTickets: { available: false, total: 0, groups: [] },
      getRemediationCandidates: (payload) => (payload.findingKey === "filter-ownership" ? { available: true, items } : { available: false, items: [] }),
      createRemediationEpic,
    });
    const user = userEvent.setup();
    render(<RemediationTab siteOrigin="https://acme.atlassian.net" />);
    await checkItems(user);

    await user.click(await screen.findByRole("button", { name: /remediation epic \(250 tasks\)/ }));
    expect(createRemediationEpic).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("This creates 250 tasks in Jira, one per item. Continue?");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(createRemediationEpic).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /remediation epic \(250 tasks\)/ }));
    await user.click(screen.getByRole("button", { name: "Create 250 tasks" }));
    await waitFor(() => expect(createRemediationEpic).toHaveBeenCalled());
  });

  test("arriving from an Overview finding opens that finding's card", async () => {
    mockInvoke({
      getRemediationTickets: { available: false, total: 0, groups: [] },
      getRemediationCandidates: (payload) => (payload.findingKey === "role-offroster-actors"
        ? { available: true, items: [{ id: "DEV", name: "DEV", owners: ["DEV"], count: 3, members: [] }] }
        : { available: false, items: [] }),
    });
    render(<RemediationTab siteOrigin="https://acme.atlassian.net" intent={{ finding: "role-offroster-actors" }} />);
    // The card loads its current items without a click.
    expect(await screen.findByText(/1 item flagged/)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("getRemediationCandidates", { findingKey: "role-offroster-actors" });
  });

  test("groups the catalog under pillar headings", async () => {
    mockInvoke({ getRemediationTickets: { available: false, total: 0, groups: [] } });
    render(<RemediationTab siteOrigin="https://acme.atlassian.net" />);
    await screen.findByText("Filter ownership");
    const headings = [...document.querySelectorAll(".remediation-group__title")].map((n) => n.textContent);
    expect(headings).toEqual(expect.arrayContaining(["Fields", "Workflows", "People", "Access", "Saved Filters"]));
    expect(headings.indexOf("Fields")).toBeLessThan(headings.indexOf("Saved Filters"));
  });
});

describe("RemediationTab — partial lists", () => {
  test("says plainly when a finding's list is only a preview", async () => {
    mockInvoke({
      getRemediationTickets: { available: false, total: 0, groups: [] },
      getRemediationCandidates: (payload) => (payload.findingKey === "filter-ownership"
        ? { available: true, partial: true, expected: 9, items: [{ id: "1", name: "Webhook" }] }
        : { available: false, items: [] }),
    });
    const user = userEvent.setup();
    render(<RemediationTab siteOrigin="https://acme.atlassian.net" />);
    await checkItems(user);
    expect(await screen.findByRole("note")).toHaveTextContent("Only the 1 highest-severity of 9 flagged rules are listed");
    expect(screen.getByRole("note")).toHaveTextContent("the other 8 cannot be ticketed from here yet");
  });

  // Without transitions, "unreached" would include every screen a transition opens -- the
  // playbook would ticket in-use screens for retirement. It says why it is withholding.
  test("says transitions must be read before unreached screens can be remediated", async () => {
    const user = userEvent.setup();
    mockInvoke({
      getRemediationTickets: { available: true, total: 0, groups: [] },
      getRemediationCandidates: { available: false, reason: "transitions-unknown", items: [] },
    });
    render(<RemediationTab />);
    await checkItems(user, "Screens nothing reaches");
    expect(await screen.findByText(/could not read transitions/i)).toBeInTheDocument();
  });
});
