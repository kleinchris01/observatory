import React from "react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { FiltersTab, filterRows, sortFilters, FILTER_FINDINGS } from "./FiltersTab";

// The pillar exists because a saved filter fails silently in both directions. So the things
// worth pinning are the ones that would go quiet: a finding that stops being offered, an
// empty state that reads as good news, and the dependency list that is the whole reason the
// other tabs can trust their own "unused" claims.

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

const filter = (over = {}) => ({
  id: "1", name: "Open bugs", jql: "project = ADVEV AND status = Open",
  owner: { accountId: "a1", displayName: "Bob", active: true },
  ownerName: "Bob", ownerActive: true,
  shares: [], sharedWithEveryone: false, shareCount: 0,
  subscriptionCount: 0, favouritedCount: 0,
  lastUsedAt: "2026-08-01T00:00:00.000Z",
  fieldRefs: ["project", "status"], projectRefs: ["ADVEV"], statusRefs: ["Open"],
  findings: [],
  ...over,
});

// The three rows a real inventory yields once filtered/sorted server-side. Named apart from
// the fixture below because several tests need to reference the un-paginated set directly --
// the whole point of these tests is that the tab renders whatever page the server sent it,
// rather than filtering a full list it no longer holds.
const allThreeFilters = [
  filter({ id: "1", name: "Open bugs" }),
  { ...filter({ id: "2", name: "Orphan", owner: null, ownerActive: null }),
    findings: [{ code: "orphaned-owner", severity: "high", detail: "The owning account no longer exists." }] },
  filter({ id: "3", name: "Everyone", sharedWithEveryone: true }),
];

// Matches the real getFilterInventory contract: `filters` is the CURRENT PAGE, already
// filtered and sorted by the server, and `matchedTotal`/`findingCounts`/`totalPages` describe
// the whole matched set rather than being derivable from the page alone. There is no
// `allFilters` any more -- shipping the whole inventory in one response is the bug this
// contract exists to fix.
const inventory = (over = {}) => ({
  available: true, state: "ready", version: "v1",
  refreshedAt: "2026-08-20T00:00:00.000Z",
  total: 3,
  orphanedCount: 1, sharedWithEveryoneCount: 1, subscribedButUnusedCount: 0,
  staleCount: 0, neverUsedCount: 0, subscriptionTotal: 5,
  duplicateGroupCount: 1, reducibleCount: 1, brokenProjectCount: 1,
  projectsChecked: true,
  duplicateGroups: [{
    key: "project=advev", jql: "project = ADVEV", count: 2,
    filters: [{ id: "1", name: "Mine", ownerName: "Bob" }, { id: "2", name: "Yours", ownerName: "Ann" }],
  }],
  brokenProjects: [{ id: "9", name: "Ghost filter", ownerName: "Bob", missing: ["GHOST"] }],
  findingCounts: { all: 3, "orphaned-owner": 1, "shared-with-everyone": 1, "subscribed-but-unused": 0, stale: 0 },
  matchedTotal: 3,
  page: 1,
  pageSize: 25,
  totalPages: 1,
  filters: allThreeFilters,
  health: { available: true, defectRate: 0.1 },
  ...over,
});

function route(map) {
  invoke.mockImplementation((name) => {
    if (name in map) return Promise.resolve(map[name]);
    return Promise.resolve({ pillar: null });
  });
}

beforeEach(() => invoke.mockReset());

describe("filterRows", () => {
  const rows = [
    { ...filter({ id: "1", name: "Clean" }), findings: [] },
    { ...filter({ id: "2", name: "Orphan", ownerName: "Ann" }), findings: [{ code: "orphaned-owner" }] },
    { ...filter({ id: "3", name: "Public", jql: "project = SECRET" }), findings: [{ code: "shared-with-everyone" }] },
  ];

  test("narrows to one finding", () => {
    expect(filterRows(rows, { finding: "orphaned-owner" }).map((r) => r.name)).toEqual(["Orphan"]);
  });

  test("searches the JQL, not only the name", () => {
    // Which is how somebody finds every filter that mentions a field without leaving the tab.
    expect(filterRows(rows, { search: "SECRET" }).map((r) => r.name)).toEqual(["Public"]);
  });

  test("searches the owner", () => {
    expect(filterRows(rows, { search: "ann" }).map((r) => r.name)).toEqual(["Orphan"]);
  });

  test("groups stale and never-opened together, because both mean nobody opens it", () => {
    const option = FILTER_FINDINGS.find((f) => f.key === "stale");
    expect(option.match({ findings: [{ code: "never-used" }] })).toBe(true);
    expect(option.match({ findings: [{ code: "stale" }] })).toBe(true);
  });
});

describe("sortFilters", () => {
  const rows = [
    { ...filter({ id: "1", name: "Bravo", lastUsedAt: "2026-01-01T00:00:00Z", subscriptionCount: 1 }), findings: [] },
    { ...filter({ id: "2", name: "Alpha", lastUsedAt: null, subscriptionCount: 5 }), findings: [{ code: "x" }] },
    { ...filter({ id: "3", name: "Charlie", lastUsedAt: "2025-01-01T00:00:00Z", subscriptionCount: 0 }), findings: [{ code: "x" }, { code: "y" }] },
  ];

  test("leads with the most findings by default", () => {
    expect(sortFilters(rows, "findings").map((r) => r.name)).toEqual(["Charlie", "Alpha", "Bravo"]);
  });

  // A filter Jira has never recorded a view of is stronger evidence than an old timestamp,
  // so it sorts ahead rather than being treated as unknown.
  test("puts never-opened ahead of merely old", () => {
    expect(sortFilters(rows, "stale").map((r) => r.name)).toEqual(["Alpha", "Charlie", "Bravo"]);
  });

  test("sorts by subscription volume", () => {
    expect(sortFilters(rows, "subscriptions")[0].name).toBe("Alpha");
  });
});

describe("FiltersTab", () => {
  test("offers a build when nothing has been inventoried", async () => {
    route({ getFilterInventory: { available: false, state: "idle", neverBuilt: true } });
    render(<FiltersTab />);

    expect(await screen.findByRole("button", { name: /build filter inventory/i })).toBeInTheDocument();
  });

  test("reports a failed build rather than an empty one", async () => {
    route({ getFilterInventory: { available: false, state: "failed", lastError: "401 scope does not match" } });
    render(<FiltersTab />);

    expect(await screen.findByText(/401 scope does not match/)).toBeInTheDocument();
  });

  test("leads with the estate counts", async () => {
    route({ getFilterInventory: inventory() });
    render(<FiltersTab />);

    await screen.findByRole("heading", { name: "Saved filters" });
    // Scoped to the estate panel: these labels deliberately appear twice, once as a headline
    // number and once as the control that narrows to it.
    const estate = screen.getByRole("heading", { name: "Estate" }).closest(".ui-panel");
    expect(within(estate).getByText("No live owner")).toBeInTheDocument();
    expect(within(estate).getByText("Shared with everyone")).toBeInTheDocument();
  });

  test("shows what each filter depends on", async () => {
    // The whole reason the pillar joins to the others: a field forty filters search on is
    // not unused, whatever the field tab says on its own.
    route({ getFilterInventory: inventory() });
    const { container } = render(<FiltersTab />);

    await waitFor(() => expect(container.querySelector(".filter-row__refs")).toBeTruthy());
    expect(container.querySelector(".filter-row__refs").textContent).toContain("depends on");
  });

  // Narrowing is now the server's job -- the tab holds one page, not the whole inventory to
  // filter locally. So what an intent from the Overview does is pass `finding` through to the
  // resolver call, and the assertion has to be on that call rather than on rendered rows: a
  // static mock response can't demonstrate server-side narrowing by itself.
  test("passes the finding from an Overview intent through to the resolver", async () => {
    route({ getFilterInventory: inventory() });
    render(<FiltersTab intent={{ view: "filters", finding: "orphaned-owner" }} />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "getFilterInventory",
      expect.objectContaining({ finding: "orphaned-owner" })
    ));
  });

  test("opens the duplicates view from an intent", async () => {
    route({ getFilterInventory: inventory() });
    render(<FiltersTab intent={{ view: "duplicates" }} />);

    expect(await screen.findByText(/2 copies/)).toBeInTheDocument();
  });

  // "No broken references" and "nobody looked" are different claims, and only one is good
  // news. This is the same rule every other pillar here follows.
  test("says the project check could not run rather than reporting it clean", async () => {
    route({ getFilterInventory: inventory({ projectsChecked: false, brokenProjects: [], brokenProjectCount: 0 }) });
    render(<FiltersTab intent={{ view: "broken" }} />);

    expect(await screen.findByText(/project list this checks against is unknown/i)).toBeInTheDocument();
  });

  test("reports a genuinely clean project scope differently", async () => {
    route({ getFilterInventory: inventory({ projectsChecked: true, brokenProjects: [], brokenProjectCount: 0 }) });
    render(<FiltersTab intent={{ view: "broken" }} />);

    expect(await screen.findByText(/Every filter names a project that exists/i)).toBeInTheDocument();
  });

  test("publishes the limit of the JQL scan rather than implying certainty", async () => {
    // A reference found is evidence a field is in use; finding none is not evidence it is not.
    route({ getFilterInventory: inventory() });
    render(<FiltersTab />);

    expect(await screen.findByText(/recognizer rather than a full parser/i)).toBeInTheDocument();
  });

  test("queues a rebuild", async () => {
    const user = userEvent.setup();
    route({ getFilterInventory: inventory(), buildFilterInventory: { queued: true } });
    render(<FiltersTab />);

    await screen.findByRole("heading", { name: "Saved filters" });
    await user.click(screen.getByRole("button", { name: /rebuild/i }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("buildFilterInventory", {}));
  });

  test("surfaces a read-only refusal instead of silently doing nothing", async () => {
    const user = userEvent.setup();
    route({ getFilterInventory: inventory(), buildFilterInventory: { queued: false, error: "Read-only mode is enabled." } });
    render(<FiltersTab />);

    await screen.findByRole("heading", { name: "Saved filters" });
    await user.click(screen.getByRole("button", { name: /rebuild/i }));

    expect(await screen.findByText(/Read-only mode is enabled/)).toBeInTheDocument();
  });
});

// The reason this pillar's tab has any of this: 4,115 filters on a real site overflowed
// Forge's response payload limit when the whole inventory was shipped in one call. Search,
// sort, the finding filter and pagination all moved to the server as a result, so what has to
// be pinned here is that the TAB actually asks the server for them, rather than quietly
// re-filtering a full list it no longer has.
describe("server-side search, sort, and paging", () => {
  beforeEach(() => {
    // shouldAdvanceTime keeps real wall-clock time moving for Testing Library's own
    // findBy*/waitFor polling, while still letting the debounce timer be advanced exactly and
    // deterministically with vi.advanceTimersByTime -- without it the two fight over the same
    // clock and every findBy* call times out waiting on a clock nothing is moving.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("debounces the search box rather than sending a request per keystroke", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    route({ getFilterInventory: inventory() });
    render(<FiltersTab />);
    await screen.findByRole("heading", { name: "Saved filters" });
    invoke.mockClear();

    await user.type(screen.getByPlaceholderText(/Name, owner, or anything in the query/i), "open");

    // Nothing sent yet -- still inside the debounce window.
    expect(invoke).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(350); });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "getFilterInventory",
      expect.objectContaining({ search: "open" })
    ));
    // One request for the whole word, not one per character.
    const searchCalls = invoke.mock.calls.filter(
      ([name, args]) => name === "getFilterInventory" && args?.search
    );
    expect(searchCalls).toHaveLength(1);
  });

  test("returns to page 1 when the search settles, so a stale page number is not reused", async () => {
    route({ getFilterInventory: inventory({ page: 2 }) });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<FiltersTab />);
    await screen.findByRole("heading", { name: "Saved filters" });
    invoke.mockClear();

    await user.type(screen.getByPlaceholderText(/Name, owner, or anything in the query/i), "x");
    act(() => { vi.advanceTimersByTime(350); });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "getFilterInventory",
      expect.objectContaining({ page: 1 })
    ));
  });

  test("asks for the next page rather than slicing a list it does not hold", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    route({ getFilterInventory: inventory({ matchedTotal: 60, totalPages: 3 }) });
    render(<FiltersTab />);
    await screen.findByRole("heading", { name: "Saved filters" });
    invoke.mockClear();

    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "getFilterInventory",
      expect.objectContaining({ page: 2 })
    ));
  });

  // The rail has to describe the WHOLE matched set, not the page in hand -- a page can hold
  // zero of a kind that exists hundreds of times elsewhere in the inventory. Proven here with
  // findingCounts that deliberately disagree with what the delivered page contains: if the
  // rail were counting the page instead of trusting the server's numbers, this would render 0.
  test("renders finding-rail counts from the server, not by counting the current page", async () => {
    route({ getFilterInventory: inventory({
      filters: [filter({ id: "9", name: "CleanPageOnly", findings: [] })],
      findingCounts: { all: 400, "orphaned-owner": 37, "shared-with-everyone": 12, "subscribed-but-unused": 0, stale: 5 },
    }) });
    render(<FiltersTab />);

    const button = await screen.findByRole("button", { name: /No live owner/i });
    expect(within(button).getByText("37")).toBeInTheDocument();
  });

  test("clicking a finding rail button asks the server for that finding", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    route({ getFilterInventory: inventory() });
    render(<FiltersTab />);
    await screen.findByRole("heading", { name: "Saved filters" });
    invoke.mockClear();

    await user.click(screen.getByRole("button", { name: /Shared with everyone/i }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "getFilterInventory",
      expect.objectContaining({ finding: "shared-with-everyone" })
    ));
  });

  test("never asks for the whole inventory in one call", async () => {
    route({ getFilterInventory: inventory() });
    render(<FiltersTab />);
    await screen.findByRole("heading", { name: "Saved filters" });

    // The overflow this contract exists to prevent: a call with no bound on how many rows
    // come back. Every call must carry a pageSize.
    for (const [name, args] of invoke.mock.calls) {
      if (name === "getFilterInventory") expect(args).toHaveProperty("pageSize");
    }
  });
});

// The wedge.
//
// A build that hits Forge's invocation ceiling is hard-killed: the row is marked "building"
// and the catch that would mark it failed never runs. The tab used to gate its only recovery
// control on that state alone, so the spinner outlived the job forever and the button that
// could have fixed it was disabled -- on a real site this sat for hours. The backend already
// refused to suppress a stale rebuild; the tab just never asked.
describe("a build that is no longer running", () => {
  test("offers the rebuild button instead of a permanent spinner", async () => {
    invoke.mockResolvedValue({
      available: false, neverBuilt: true, state: "building", staleBuild: true,
    });

    render(<FiltersTab />);

    const button = await screen.findByRole("button", { name: /rebuild/i });
    expect(button).toBeEnabled();
    expect(screen.getByText(/no longer running/i)).toBeInTheDocument();
    expect(screen.queryByText(/Building the filter inventory/i)).not.toBeInTheDocument();
  });

  test("still shows a spinner for a build that genuinely is running", async () => {
    invoke.mockResolvedValue({
      available: false, neverBuilt: true, state: "building", staleBuild: false,
    });

    render(<FiltersTab />);

    expect(await screen.findByText(/Building the filter inventory/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /building/i })).toBeDisabled();
  });

  // The same trap on a site that already has a snapshot: the rebuild wedges, and every later
  // rebuild is refused by a button that will not enable itself.
  test("re-enables rebuild when a refresh over an existing snapshot wedges", async () => {
    invoke.mockResolvedValue(inventory({ state: "building", staleBuild: true }));

    render(<FiltersTab />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Rebuild" })).toBeEnabled()
    );
  });
});

describe("clearer labels and honest last-used", () => {
  test("the deleted-project section is not called 'Broken scope'", async () => {
    route({ getFilterInventory: inventory() });
    render(<FiltersTab />);
    await screen.findByText("Open bugs");
    expect(screen.getByRole("button", { name: /Deleted project/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Broken scope/i })).not.toBeInTheDocument();
  });

  test("when Jira does not track last-used, cards say so instead of 'never opened', and the finding is dropped", async () => {
    route({
      getFilterInventory: inventory({
        lastUsedTracked: false,
        filters: [
          { ...filter({ id: "1", name: "Untracked one", lastUsedAt: null }), findings: [] },
        ],
        findingCounts: { all: 1, "orphaned-owner": 0, "shared-with-everyone": 0, "subscribed-but-unused": 0, stale: 0 },
      }),
    });
    render(<FiltersTab />);
    await screen.findByText("Untracked one");

    expect(screen.getByText("last-opened not tracked")).toBeInTheDocument();
    expect(screen.queryByText("never opened")).not.toBeInTheDocument();
    // The "Not opened in a year" chip is gone rather than showing a 0 for an unmeasured thing.
    expect(screen.queryByRole("button", { name: /Not opened in a year/i })).not.toBeInTheDocument();
  });

  test("keeps 'never opened' and the finding when last-used IS tracked", async () => {
    route({
      getFilterInventory: inventory({
        lastUsedTracked: true,
        filters: [{ ...filter({ id: "1", name: "Real never", lastUsedAt: null }), findings: [] }],
      }),
    });
    render(<FiltersTab />);
    await screen.findByText("Real never");
    expect(screen.getByText("never opened")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Not opened in a year/i })).toBeInTheDocument();
  });
});
