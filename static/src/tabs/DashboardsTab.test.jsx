import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { DashboardsTab, filterDashboards, sortDashboards, DASHBOARD_FINDINGS, gadgetTooltip } from "./DashboardsTab";

// The things worth pinning are the ones that would go quiet: an empty state that reads as
// good news, a partial build presenting itself as complete, and the missing gadget-to-filter
// link being inferred from its absence rather than stated.

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

const dashboard = (over = {}) => ({
  id: "1",
  name: "Delivery overview",
  owner: { accountId: "a1", displayName: "Bob", active: true },
  ownerName: "Bob",
  ownerActive: true,
  shares: [],
  editShares: [],
  sharedWithEveryone: false,
  editableByEveryone: false,
  popularity: 4,
  gadgetCount: 3,
  shareCount: 0,
  gadgets: [{ id: "g1", title: "Filter Results", moduleKey: "k" }],
  findings: [],
  ...over,
});

const inventory = (over = {}) => ({
  available: true,
  state: "ready",
  version: "v1",
  refreshedAt: "2026-08-21T00:00:00.000Z",
  total: 3,
  gadgetsWalked: 3,
  orphanedCount: 1,
  editableByEveryoneCount: 1,
  publishedUnusedCount: 0,
  emptyCount: 0,
  totalGadgets: 9,
  favouritedCount: 2,
  gadgetsKnown: true,
  dashboards: [
    {
      ...dashboard({ id: "2", name: "Orphan" }),
      findings: [{ code: "orphaned-owner", severity: "high", detail: "The owning account no longer exists." }],
    },
  ],
  allDashboards: [
    dashboard({ id: "1", name: "Delivery overview" }),
    dashboard({ id: "2", name: "Orphan", owner: null, ownerActive: null }),
    dashboard({ id: "3", name: "Open edit", editableByEveryone: true }),
  ],
  health: { available: true },
  ...over,
});

function route(map) {
  invoke.mockImplementation((name) => {
    if (name in map) return Promise.resolve(map[name]);
    return Promise.resolve({ pillar: null });
  });
}

beforeEach(() => invoke.mockReset());

describe("gadgetTooltip", () => {
  test("says nothing for a gadget with no filter to report", () => {
    expect(gadgetTooltip({ id: "g1", filterId: null })).toBeUndefined();
  });

  test("names the filter and the fields it depends on", () => {
    const tooltip = gadgetTooltip({
      id: "g1",
      filterId: "500",
      filterName: "Open Bugs",
      fieldRefs: ["Story Points", "Status"],
    });
    expect(tooltip).toBe("Filter: Open Bugs — depends on Story Points, Status");
  });

  test("says so rather than nothing when the filter's JQL names no fields", () => {
    const tooltip = gadgetTooltip({ id: "g1", filterId: "500", filterName: "Everything", fieldRefs: [] });
    expect(tooltip).toContain("depends on nothing this filter's JQL names");
  });

  // Tri-state: a gadget with a filterId but an unbuilt filter inventory has not been
  // measured, which must read differently from a gadget confirmed to depend on nothing.
  test("reports unmeasured, not unresolved, when no filter inventory exists yet", () => {
    const tooltip = gadgetTooltip({ id: "g1", filterId: "500", filterName: null, fieldRefs: null });
    expect(tooltip).toContain("build a saved filter inventory");
  });
});

describe("filterDashboards", () => {
  const rows = [
    { ...dashboard({ id: "1", name: "Clean" }), findings: [] },
    { ...dashboard({ id: "2", name: "Orphan", ownerName: "Ann" }), findings: [{ code: "orphaned-owner" }] },
    {
      ...dashboard({ id: "3", name: "Open", gadgets: [{ id: "g", title: "Sprint Burndown" }] }),
      findings: [{ code: "editable-by-everyone" }],
    },
  ];

  test("narrows to one finding", () => {
    expect(filterDashboards(rows, { finding: "orphaned-owner" }).map((r) => r.name)).toEqual(["Orphan"]);
  });

  test("searches gadget titles, not only the name", () => {
    // Which is how somebody finds every dashboard carrying a gadget without leaving the tab.
    expect(filterDashboards(rows, { search: "burndown" }).map((r) => r.name)).toEqual(["Open"]);
  });

  test("searches the owner", () => {
    expect(filterDashboards(rows, { search: "ann" }).map((r) => r.name)).toEqual(["Orphan"]);
  });

  test("every offered finding has a matcher", () => {
    for (const option of DASHBOARD_FINDINGS) expect(typeof option.match).toBe("function");
  });
});

describe("sortDashboards", () => {
  const rows = [
    { ...dashboard({ id: "1", name: "Bravo", popularity: 1, gadgetCount: 9 }), findings: [] },
    { ...dashboard({ id: "2", name: "Alpha", popularity: 20, gadgetCount: null }), findings: [{ code: "x" }] },
    {
      ...dashboard({ id: "3", name: "Charlie", popularity: 5, gadgetCount: 2 }),
      findings: [{ code: "x" }, { code: "y" }],
    },
  ];

  test("leads with the most findings by default", () => {
    expect(sortDashboards(rows, "findings").map((r) => r.name)).toEqual(["Charlie", "Alpha", "Bravo"]);
  });

  test("sorts by how many people favourited it", () => {
    expect(sortDashboards(rows, "popularity")[0].name).toBe("Alpha");
  });

  // A null gadget count is unknown. Leading a "most gadgets" list with dashboards nobody
  // counted would be backwards.
  test("sorts unwalked dashboards last by gadget count", () => {
    expect(sortDashboards(rows, "gadgets").map((r) => r.name)).toEqual(["Bravo", "Charlie", "Alpha"]);
  });
});

describe("DashboardsTab", () => {
  test("offers a build when nothing has been inventoried", async () => {
    route({ getDashboardInventory: { available: false, state: "idle", neverBuilt: true } });
    render(<DashboardsTab />);

    expect(await screen.findByRole("button", { name: /build dashboard inventory/i })).toBeInTheDocument();
  });

  test("reports a failed build rather than an empty one", async () => {
    route({ getDashboardInventory: { available: false, state: "failed", lastError: "401 scope does not match" } });
    render(<DashboardsTab />);

    expect(await screen.findByText(/401 scope does not match/)).toBeInTheDocument();
  });

  test("leads with the estate counts", async () => {
    route({ getDashboardInventory: inventory() });
    render(<DashboardsTab />);

    await screen.findByRole("heading", { name: "Dashboards", level: 2 });
    // Scoped to the estate panel: these labels deliberately appear twice, once as a headline
    // number and once as the control that narrows to it.
    const estate = screen.getByRole("heading", { name: "Estate" }).closest(".ui-panel");
    expect(within(estate).getByText("No live owner")).toBeInTheDocument();
    expect(within(estate).getByText("Anyone can edit")).toBeInTheDocument();
  });

  // The footer used to say gadget -> filter was not part of the inventory, in the same tab
  // that draws each gadget's filter. It now says what the link proves and where it stops.
  test("describes the gadget filter link as read, with its limit", async () => {
    route({ getDashboardInventory: inventory() });
    render(<DashboardsTab />);

    expect(
      await screen.findByText(/Each gadget's filter is read from the gadget's own properties/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/not part of this inventory yet/i)).not.toBeInTheDocument();
  });

  // A pass that reached 180 of 200 can say which of those 180 are empty and nothing about
  // the rest. Presenting it as complete would report a shortfall in the BUILD as a defect in
  // the estate.
  test("says how far a partial gadget walk got", async () => {
    route({ getDashboardInventory: inventory({ total: 200, gadgetsWalked: 180, emptyCount: null }) });
    render(<DashboardsTab />);

    expect(await screen.findByText(/Gadgets were read for 180 of 200 dashboards/i)).toBeInTheDocument();
  });

  test("shows a dash rather than zero for a dashboard whose gadgets were not read", async () => {
    route({
      getDashboardInventory: inventory({
        allDashboards: [dashboard({ id: "1", name: "Unread", gadgetCount: null })],
      }),
    });
    const { container } = render(<DashboardsTab />);

    await waitFor(() => expect(container.querySelector(".dash-row")).toBeTruthy());
    expect(container.querySelector(".dash-row__meta").textContent).toMatch(/gadgets not read/);
  });

  test("narrows to a finding when opened from the Overview", async () => {
    route({
      getDashboardInventory: inventory({
        dashboards: [
          {
            ...dashboard({ id: "2", name: "Orphan" }),
            findings: [{ code: "orphaned-owner", severity: "high", detail: "gone" }],
          },
        ],
      }),
    });
    const { container } = render(<DashboardsTab intent={{ finding: "orphaned-owner" }} />);

    await waitFor(() => expect(container.querySelectorAll(".dash-row").length).toBe(1));
    expect(container.querySelector(".dash-row__name").textContent).toBe("Orphan");
  });

  test("queues a rebuild", async () => {
    const user = userEvent.setup();
    route({ getDashboardInventory: inventory(), buildDashboardInventory: { queued: true } });
    render(<DashboardsTab />);

    await screen.findByRole("heading", { name: "Dashboards", level: 2 });
    await user.click(screen.getByRole("button", { name: /rebuild/i }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("buildDashboardInventory", {}));
  });

  test("surfaces a read-only refusal instead of silently doing nothing", async () => {
    const user = userEvent.setup();
    route({
      getDashboardInventory: inventory(),
      buildDashboardInventory: { queued: false, error: "Read-only mode is enabled." },
    });
    render(<DashboardsTab />);

    await screen.findByRole("heading", { name: "Dashboards", level: 2 });
    await user.click(screen.getByRole("button", { name: /rebuild/i }));

    expect(await screen.findByText(/Read-only mode is enabled/)).toBeInTheDocument();
  });
});

// The same wedge the filter pillar hit on a live site: a build hard-killed at Forge's
// invocation ceiling leaves the row saying "building" forever, and gating the rebuild button
// on that state alone disables the only control that could recover it.
describe("a build that is no longer running", () => {
  test("offers the rebuild button instead of a permanent spinner", async () => {
    invoke.mockResolvedValue({
      available: false,
      neverBuilt: true,
      state: "building",
      staleBuild: true,
    });

    render(<DashboardsTab />);

    expect(await screen.findByRole("button", { name: /rebuild/i })).toBeEnabled();
    expect(screen.getByText(/no longer running/i)).toBeInTheDocument();
  });

  test("still shows a spinner for a build that genuinely is running", async () => {
    invoke.mockResolvedValue({
      available: false,
      neverBuilt: true,
      state: "building",
      staleBuild: false,
    });

    render(<DashboardsTab />);

    expect(await screen.findByText(/Building the dashboard inventory/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /building/i })).toBeDisabled();
  });
});

describe("gadgetTooltip -- unreadable filters", () => {
  test("says a missing or private filter first, whatever else is known", () => {
    expect(gadgetTooltip({ filterId: "500", filterState: "missing", filterName: null, fieldRefs: [] })).toMatch(
      /no longer exists, or this app cannot see it/,
    );
    expect(gadgetTooltip({ filterId: "500", filterState: "private" })).toMatch(/private to its owner/);
    expect(gadgetTooltip({ filterId: "500", filterState: "readable", filterName: "Open bugs", fieldRefs: [] })).toMatch(
      /^Filter: Open bugs/,
    );
  });
});
