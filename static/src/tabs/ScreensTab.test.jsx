import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { ScreensTab, ScreenRow, SchemeOperations } from "./ScreensTab";

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

const inventory = (over = {}) => ({
  neverBuilt: false,
  state: "ready",
  staleBuild: false,
  version: "v1",
  refreshedAt: new Date().toISOString(),
  totalScreens: 760,
  unresolvedScreens: 0,
  screens: { total: 1, rows: [{ screenId: "100", name: "Default Screen", tabCount: 1, fieldCount: 28, tabsResolved: "resolved" }] },
  screenSchemes: [{ schemeId: "5", name: "Default Screen Scheme" }],
  schemeOperations: [
    { schemeId: "5", operation: "default", screenId: "100", inherited: false, dangling: false },
    { schemeId: "5", operation: "create", screenId: "100", inherited: true, dangling: false },
    { schemeId: "5", operation: "edit", screenId: "100", inherited: true, dangling: false },
    { schemeId: "5", operation: "view", screenId: "100", inherited: true, dangling: false },
  ],
  issueTypeScreenSchemes: [{ itssId: "9", name: "Default ITSS", projectCount: 4 }],
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("ScreenRow", () => {
  test("shows the field count for a screen that was read", () => {
    render(<ScreenRow screen={{ screenId: "100", name: "Default", fieldCount: 28, tabCount: 1, tabsResolved: "resolved" }} />);
    expect(screen.getByText(/28 fields/)).toBeInTheDocument();
  });

  // The rule the whole pillar rests on, rendered. Zero fields and unknown fields are
  // opposite claims, and only one of them makes a field look safe to delete.
  test("an unreadable screen says contents unknown, never zero fields", () => {
    render(<ScreenRow screen={{
      screenId: "100", name: "Broken", fieldCount: 0, tabCount: 0,
      tabsResolved: "unresolved", unresolvedReason: "401 nope",
    }} />);

    expect(screen.getByText(/contents unknown/i)).toBeInTheDocument();
    expect(screen.queryByText(/0 fields/)).not.toBeInTheDocument();
  });

  test("flags a multi-tab screen, where fields are easy to miss", () => {
    render(<ScreenRow screen={{ screenId: "1", name: "Big", fieldCount: 40, tabCount: 3, tabsResolved: "resolved" }} />);
    expect(screen.getByText(/3 tabs/)).toBeInTheDocument();
  });

  test("does not label a single-tab screen with a tab count", () => {
    render(<ScreenRow screen={{ screenId: "1", name: "Small", fieldCount: 4, tabCount: 1, tabsResolved: "resolved" }} />);
    expect(screen.queryByText(/1 tabs?/)).not.toBeInTheDocument();
  });
});

describe("SchemeOperations", () => {
  const uniform = [
    { schemeId: "5", operation: "default", screenId: "100", inherited: false },
    { schemeId: "5", operation: "create", screenId: "100", inherited: true },
    { schemeId: "5", operation: "edit", screenId: "100", inherited: true },
    { schemeId: "5", operation: "view", screenId: "100", inherited: true },
  ];

  // The common case, said once. Repeating it four times would bury the schemes that
  // actually differ, which are the ones worth looking at.
  test("collapses a scheme where every operation resolves to one screen", () => {
    render(<SchemeOperations scheme={{ schemeId: "5", name: "Default" }} operations={uniform} />);
    expect(screen.getByText(/one screen for every operation/i)).toBeInTheDocument();
  });

  test("breaks out the operations when they differ", () => {
    const mixed = [
      { schemeId: "5", operation: "default", screenId: "100", inherited: false },
      { schemeId: "5", operation: "create", screenId: "200", inherited: false },
      { schemeId: "5", operation: "edit", screenId: "100", inherited: true },
      { schemeId: "5", operation: "view", screenId: "100", inherited: true },
    ];
    render(<SchemeOperations scheme={{ schemeId: "5", name: "Mixed" }} operations={mixed} />);

    expect(screen.getByText("create")).toBeInTheDocument();
    // Inherited is not the same as chosen: only an explicit mapping was a decision.
    expect(screen.getAllByText(/inherited/i).length).toBeGreaterThan(0);
  });

  test("marks a scheme pointing at a screen the catalog does not have", () => {
    const dangling = [
      { schemeId: "5", operation: "default", screenId: "999", inherited: false, dangling: true },
      { schemeId: "5", operation: "create", screenId: "100", inherited: false },
      { schemeId: "5", operation: "edit", screenId: "100", inherited: false },
      { schemeId: "5", operation: "view", screenId: "100", inherited: false },
    ];
    render(<SchemeOperations scheme={{ schemeId: "5", name: "Broken" }} operations={dangling} />);
    expect(screen.getByText(/missing/i)).toBeInTheDocument();
  });

  test("says an operation is unmapped rather than rendering a blank", () => {
    const unmapped = [
      { schemeId: "5", operation: "default", screenId: "100", inherited: false },
      { schemeId: "5", operation: "create", screenId: null },
      { schemeId: "5", operation: "edit", screenId: "200" },
      { schemeId: "5", operation: "view", screenId: "100" },
    ];
    render(<SchemeOperations scheme={{ schemeId: "5", name: "Partial" }} operations={unmapped} />);
    expect(screen.getByText(/not mapped/i)).toBeInTheDocument();
  });
});

describe("ScreensTab", () => {
  test("offers a build and explains what it does when nothing exists yet", async () => {
    invoke.mockResolvedValue({ neverBuilt: true, state: "idle", screens: { total: 0, rows: [] } });
    render(<ScreensTab />);

    expect(await screen.findByText(/no screen inventory has been built/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /build inventory/i }).length).toBeGreaterThan(0);
  });

  test("renders the inventory once a snapshot exists", async () => {
    invoke.mockResolvedValue(inventory());
    render(<ScreensTab />);

    expect(await screen.findByText("Default Screen")).toBeInTheDocument();
    expect(screen.getByText(/28 fields/)).toBeInTheDocument();
  });

  // Given a tile rather than a footnote: it caps every finding built on this snapshot, so
  // a reader needs it before they trust any other number on the page.
  test("surfaces the unknown-contents count as a first-class figure", async () => {
    invoke.mockResolvedValue(inventory({ unresolvedScreens: 30 }));
    render(<ScreensTab />);

    await screen.findByText("Default Screen");
    const tile = screen.getByText(/contents unknown/i).closest(".ui-stat");
    expect(tile.textContent).toContain("30");
    expect(tile.textContent).toMatch(/not counted as empty/i);
  });

  // The question this tab has to answer before somebody assumes otherwise: nothing
  // refreshes screens automatically, and the Universe Scan does not touch them.
  test("warns when the inventory is stale and says the scan will not fix it", async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    invoke.mockResolvedValue(inventory({ refreshedAt: old }));
    render(<ScreensTab />);

    // One banner: the shared age sentence, carrying this pillar's own "what refreshes it".
    const banner = await screen.findByText(/this snapshot is 30 days old/i);
    expect(banner.textContent).toMatch(/universe scan does not update screens/i);
  });

  test("does not warn about staleness on a fresh build", async () => {
    invoke.mockResolvedValue(inventory());
    render(<ScreensTab />);

    await screen.findByText("Default Screen");
    expect(screen.queryByText(/this snapshot is \d+ days old/i)).not.toBeInTheDocument();
  });

  test("switches to the schemes view", async () => {
    invoke.mockResolvedValue(inventory());
    render(<ScreensTab />);
    await screen.findByText("Default Screen");

    await userEvent.click(screen.getByRole("button", { name: /Screen schemes/i }));
    expect(screen.getByText("Default Screen Scheme")).toBeInTheDocument();
  });

  test("flags an issue type screen scheme no project uses", async () => {
    invoke.mockResolvedValue(inventory({
      issueTypeScreenSchemes: [{ itssId: "9", name: "Orphan ITSS", projectCount: 0 }],
    }));
    render(<ScreensTab />);
    await screen.findByText("Default Screen");

    await userEvent.click(screen.getByRole("button", { name: /Assignments/i }));
    // A scheme nothing uses is configuration that can be retired -- a finding, not a zero.
    expect(screen.getByText(/0 projects/)).toBeInTheDocument();
  });

  test("starts a build and reloads", async () => {
    invoke.mockResolvedValue(inventory());
    render(<ScreensTab />);
    await screen.findByText("Default Screen");

    await userEvent.click(screen.getByRole("button", { name: /Rebuild/i }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("buildScreenInventory", {}));
  });

  test("surfaces a refusal from the resolver rather than silently doing nothing", async () => {
    invoke.mockImplementation((name) =>
      name === "buildScreenInventory"
        ? Promise.resolve({ queued: false, error: "Read-only mode is enabled." })
        : Promise.resolve(inventory())
    );
    render(<ScreensTab />);
    await screen.findByText("Default Screen");

    await userEvent.click(screen.getByRole("button", { name: /Rebuild/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/read-only mode/i);
  });

  // A diagnostic that blanks the page it runs on is worse than one that keeps the last
  // good state and says something went wrong.
  test("keeps the page usable when a load fails", async () => {
    invoke.mockRejectedValueOnce(new Error("resolver exploded"));
    render(<ScreensTab />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/resolver exploded/i);
  });

  test("reports a wedged build and offers a rebuild", async () => {
    invoke.mockResolvedValue(inventory({ state: "building", staleBuild: true }));
    render(<ScreensTab />);

    expect(await screen.findByText(/no longer running/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Rebuild/i })).toBeEnabled();
  });
});

describe("ScreensTab — build a field report from screens", () => {
  const twoScreens = inventory({
    screens: { total: 2, rows: [
      { screenId: "100", name: "Create Screen", tabCount: 1, fieldCount: 12, tabsResolved: "resolved" },
      { screenId: "200", name: "Edit Screen", tabCount: 1, fieldCount: 8, tabsResolved: "resolved" },
    ] },
  });

  test("no checkboxes and no action bar without the onBuildFieldReport hook", async () => {
    invoke.mockResolvedValue(twoScreens);
    render(<ScreensTab />);
    await screen.findByText("Create Screen");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  test("ticking screens and clicking build resolves inputs and hands them up", async () => {
    const onBuildFieldReport = vi.fn();
    invoke.mockImplementation((name) => {
      if (name === "getScreenInventory") return Promise.resolve(twoScreens);
      if (name === "getScreenFieldReportInputs") return Promise.resolve({
        available: true, fieldIds: ["cf_1", "cf_2", "cf_3"], projectIds: ["10", "11"], unresolvedScreens: [],
      });
      return Promise.resolve({});
    });
    render(<ScreensTab onBuildFieldReport={onBuildFieldReport} />);

    await screen.findByText("Create Screen");
    const boxes = screen.getAllByRole("checkbox");
    await userEvent.click(boxes[0]);
    await userEvent.click(boxes[1]);
    await userEvent.click(screen.getByRole("button", { name: /Build field report/i }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("getScreenFieldReportInputs", { screenIds: ["100", "200"] });
      expect(onBuildFieldReport).toHaveBeenCalledWith(["cf_1", "cf_2", "cf_3"], ["10", "11"]);
    });
  });

  test("surfaces an 'incomplete field list' notice when some screens could not be read", async () => {
    invoke.mockImplementation((name) => {
      if (name === "getScreenInventory") return Promise.resolve(twoScreens);
      if (name === "getScreenFieldReportInputs") return Promise.resolve({
        available: true, fieldIds: ["cf_1"], projectIds: ["10"], unresolvedScreens: ["Edit Screen"],
      });
      return Promise.resolve({});
    });
    render(<ScreensTab onBuildFieldReport={vi.fn()} />);

    await screen.findByText("Create Screen");
    await userEvent.click(screen.getAllByRole("checkbox")[0]);
    await userEvent.click(screen.getByRole("button", { name: /Build field report/i }));

    expect(await screen.findByText(/field list may be incomplete/i)).toBeInTheDocument();
  });
});

// The bug this guards: getScreenInventory reports neverBuilt whenever no build has
// COMPLETED, which stays true for the several minutes the first build runs. Branching on
// it before checking state rendered the same "nothing here yet" screen throughout, so a
// working button looked broken -- press it, nothing changes, no way to tell it was accepted.
describe("ScreensTab — first build feedback", () => {
  test("shows progress while the first build runs, not the empty state", async () => {
    invoke.mockResolvedValue({
      neverBuilt: true,
      state: "building",
      staleBuild: false,
      startedAt: new Date().toISOString(),
      screens: { total: 0, rows: [] },
    });

    render(<ScreensTab />);

    expect(await screen.findByText(/building the first inventory/i)).toBeInTheDocument();
    expect(screen.queryByText(/no screen inventory has been built/i)).not.toBeInTheDocument();
  });

  test("treats a queued build as in flight too", async () => {
    invoke.mockResolvedValue({
      neverBuilt: true, state: "queued", staleBuild: false, screens: { total: 0, rows: [] },
    });

    render(<ScreensTab />);
    expect(await screen.findByText(/building the first inventory/i)).toBeInTheDocument();
  });

  test("confirms the build was queued rather than saying nothing", async () => {
    invoke.mockImplementation((name) =>
      name === "buildScreenInventory"
        ? Promise.resolve({ queued: true })
        : Promise.resolve({ neverBuilt: true, state: "idle", screens: { total: 0, rows: [] } })
    );

    render(<ScreensTab />);
    await screen.findByText(/no screen inventory has been built/i);
    await userEvent.click(screen.getAllByRole("button", { name: /build inventory/i })[0]);

    expect(await screen.findByRole("status")).toHaveTextContent(/build queued/i);
  });

  // Pressing a button and getting no response at all is indistinguishable from a broken
  // button, so a refusal has to say something even though it is not an error.
  test("says so when a build is already running instead of going quiet", async () => {
    invoke.mockImplementation((name) =>
      name === "buildScreenInventory"
        ? Promise.resolve({ queued: false, reason: "already-building" })
        : Promise.resolve({ neverBuilt: true, state: "idle", screens: { total: 0, rows: [] } })
    );

    render(<ScreensTab />);
    await screen.findByText(/no screen inventory has been built/i);
    await userEvent.click(screen.getAllByRole("button", { name: /build inventory/i })[0]);

    expect(await screen.findByRole("status")).toHaveTextContent(/already running/i);
  });

  test("still surfaces a failed first build", async () => {
    invoke.mockResolvedValue({
      neverBuilt: true, state: "failed", staleBuild: false,
      lastError: "401 nope", screens: { total: 0, rows: [] },
    });

    render(<ScreensTab />);
    expect(await screen.findByText(/last build failed/i)).toBeInTheDocument();
  });
});

// The Screens tab is the reference for the shared toolbar: it is server-paged, so its sort
// has to reach SQL. Sorting the 25 rows already in the browser would reorder an arbitrary
// slice of 760 and present it as the top of the catalog.
describe("ScreensTab — sorting and search", () => {
  test("sends the chosen sort to the resolver instead of sorting the page", async () => {
    invoke.mockResolvedValue(inventory());
    render(<ScreensTab />);
    await screen.findByText("Default Screen");

    invoke.mockClear();
    invoke.mockResolvedValue(inventory());
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Sort/i }), "name-asc");

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("getScreenInventory", expect.objectContaining({ sort: "name-asc" }));
    });
  });

  // Changing the ordering of a paged list while staying on page 4 shows the middle of the
  // new order with no way to tell that is what happened.
  test("returns to the first page when the ordering changes", async () => {
    invoke.mockResolvedValue(inventory({ screens: { total: 200, rows: inventory().screens.rows } }));
    render(<ScreensTab />);
    await screen.findByText("Default Screen");

    await userEvent.click(screen.getByRole("button", { name: /Next/i }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("getScreenInventory", expect.objectContaining({ page: 2 })));

    invoke.mockClear();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Sort/i }), "name-asc");

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("getScreenInventory", expect.objectContaining({ page: 1, sort: "name-asc" }));
    });
  });

  test("states the filtered count against the catalog total", async () => {
    invoke.mockResolvedValue(inventory({ totalScreens: 760, screens: { total: 12, rows: inventory().screens.rows } }));
    render(<ScreensTab />);

    expect(await screen.findByText(/12 of 760/)).toBeInTheDocument();
  });

  // Freshness moved off the stat row into the page header, so it stops competing with the
  // counts it qualifies and sits where every other tab now puts it.
  test("reports build freshness in the header rather than as a stat tile", async () => {
    invoke.mockResolvedValue(inventory());
    const { container } = render(<ScreensTab />);
    await screen.findByText("Default Screen");

    expect(container.querySelector(".ui-pagehead__meta")).toHaveTextContent(/Built/);
    expect(screen.queryByText("Built")).not.toBeInTheDocument();
  });
});

// Arriving from "252 screens nothing reaches" used to open page one of 746 and leave the
// reader to find the 252 by hand.
//
// The screen filter runs in SQL, not here: the tab shows 25 of ~760, so narrowing the page
// in the browser would filter an arbitrary slice and present it as the whole answer. The
// scheme filter IS client-side, because every scheme is already on the page.
describe("ScreensTab — arriving from a finding", () => {
  const inventory = (over = {}) => ({
    state: "ready", version: "v1", totalScreens: 746, page: 1, pageSize: 25, sort: "fields-desc",
    screens: { total: 1, rows: [{ screenId: "1", name: "A screen", tabCount: 1, fieldCount: 0, tabsResolved: "resolved" }] },
    screenSchemes: [], schemeOperations: [], issueTypeScreenSchemes: [],
    distributions: {}, governance: {}, transitionScreens: [],
    ...over,
  });

  function route(result) {
    invoke.mockImplementation((name) => {
      if (name === "getScreenInventory") return Promise.resolve(result);
      return Promise.resolve({ pillar: null });
    });
  }

  test("sends the finding's filter to the resolver", async () => {
    route(inventory({ screens: { total: 252, rows: [], filter: "unreached", filterLabel: "Nothing reaches them", filterRequested: "unreached" } }));
    render(<ScreensTab intent={{ view: "screens", filter: "unreached" }} />);

    await waitFor(() => {
      const sent = invoke.mock.calls.filter((c) => c[0] === "getScreenInventory").pop();
      expect(sent[1].filter).toBe("unreached");
    });
  });

  test("says which subset it is showing", async () => {
    route(inventory({ screens: { total: 252, rows: [{ screenId: "1", name: "A screen", tabCount: 1, fieldCount: 0, tabsResolved: "resolved" }], filter: "unreached", filterLabel: "Nothing reaches them", filterRequested: "unreached" } }));
    render(<ScreensTab intent={{ view: "screens", filter: "unreached" }} />);

    // 252 rows with nothing saying why would be indistinguishable from a catalogue that
    // had shrunk.
    expect(await screen.findByText("Nothing reaches them")).toBeInTheDocument();
  });

  // Reachability needs the workflow snapshot. Showing the whole catalogue under a heading
  // that promised a subset would be worse than saying the filter could not run.
  test("says so when the filter could not be applied", async () => {
    route(inventory({ screens: { total: 746, rows: [{ screenId: "1", name: "A screen", tabCount: 1, fieldCount: 0, tabsResolved: "resolved" }], filter: null, filterLabel: null, filterRequested: "unreached" } }));
    render(<ScreensTab intent={{ view: "screens", filter: "unreached" }} />);

    expect(await screen.findByText(/no workflow inventory has been built/i)).toBeInTheDocument();
  });

  test("opens the schemes view narrowed to the ones nothing maps to", async () => {
    route(inventory({
      screenSchemes: [
        { schemeId: "1", name: "Used scheme", issueTypeSchemeCount: 3 },
        { schemeId: "2", name: "Orphan scheme", issueTypeSchemeCount: 0 },
      ],
      schemeOperations: [],
    }));
    const { container } = render(<ScreensTab intent={{ view: "schemes", schemes: "unused" }} />);

    await waitFor(() => expect(container.textContent).toContain("Orphan scheme"));
    expect(container.textContent).not.toContain("Used scheme");
  });

  test("opens the schemes view narrowed to the ones pointing at a missing screen", async () => {
    route(inventory({
      screenSchemes: [
        { schemeId: "1", name: "Intact scheme", issueTypeSchemeCount: 1 },
        { schemeId: "2", name: "Broken scheme", issueTypeSchemeCount: 1 },
      ],
      schemeOperations: [
        { schemeId: "1", operation: "create", screenId: "9", dangling: false },
        { schemeId: "2", operation: "edit", screenId: "404", dangling: true },
      ],
    }));
    const { container } = render(<ScreensTab intent={{ view: "schemes", schemes: "dangling" }} />);

    await waitFor(() => expect(container.textContent).toContain("Broken scheme"));
    expect(container.textContent).not.toContain("Intact scheme");
  });

  test("opened normally, it filters nothing", async () => {
    route(inventory());
    render(<ScreensTab />);

    await waitFor(() => {
      const sent = invoke.mock.calls.filter((c) => c[0] === "getScreenInventory").pop();
      expect(sent[1].filter).toBeNull();
    });
  });
});

// The cross-signal view. Two findings neither pillar can produce alone, and the one place
// in the product where "not on a screen" means the field is HARDER to remove, not easier --
// so most of what is pinned here is that the wording says so.
describe("ScreensTab — field cross-signal", () => {
  const cross = (over = {}) => ({
    available: true,
    projectsTotal: 40, projectsResolved: 40, coverageRate: 1,
    usageTruncated: false,
    screenRefreshedAt: new Date(Date.now() - 3600_000).toISOString(),
    fieldRefreshedAt: new Date(Date.now() - 7200_000).toISOString(),
    counts: { invisibleFields: 1, invisibleIssues: 480, clutterFields: 1, clutterPlacements: 6, unreachableFields: 2 },
    invisibleData: [{
      fieldId: "cf_9", fieldName: "Vendor Ref", totalIssues: 480,
      projects: [{ projectId: "10", projectKey: "OPS", issueCount: 480 }],
    }],
    formClutter: [{ fieldId: "cf_4", fieldName: "Legacy Code", projectCount: 6, projects: [] }],
    unreachableFields: [],
    ...over,
  });

  const openCross = async (payload) => {
    invoke.mockImplementation((name) => {
      if (name === "getScreenInventory") return Promise.resolve(inventory({}));
      if (name === "getScreenFieldCrossSignal") return Promise.resolve(payload);
      return Promise.resolve({});
    });
    render(<ScreensTab />);
    // The view is loaded on demand, so nothing is fetched until this is clicked -- which is
    // the point: most visits to this tab are about a screen, not about the cross.
    const nav = await screen.findByRole("button", { name: /Field cross-signal/i });
    await userEvent.click(nav);
  };

  test("names the two findings and what each costs", async () => {
    await openCross(cross());

    // Twice on purpose: the stat tile carries the count, the panel carries the detail.
    expect((await screen.findAllByText("Invisible data")).length).toBeGreaterThan(0);
    expect(screen.getByText("Vendor Ref")).toBeInTheDocument();
    expect(screen.getByText(/OPS \(480\)/)).toBeInTheDocument();
    // The sentence that fights the reader's instinct.
    expect(screen.getByText(/HARDER to remove safely than an unused field/i)).toBeInTheDocument();

    expect(screen.getByText("Legacy Code")).toBeInTheDocument();
    expect(screen.getByText(/on 6 create screens, never filled/i)).toBeInTheDocument();
  });

  test("dates both halves separately, because they refresh independently", async () => {
    await openCross(cross());
    const line = await screen.findByText(/Screens read/);
    expect(line.textContent).toMatch(/field usage/i);
  });

  test("says which projects were left out and why", async () => {
    await openCross(cross({ projectsTotal: 40, projectsResolved: 31, coverageRate: 31 / 40 }));

    expect(await screen.findByText(/31 of 40 projects fully read/i)).toBeInTheDocument();
    // Not just the number -- why excluding them is the correct behaviour.
    expect(screen.getByText(/only partly read/i)).toBeInTheDocument();
  });

  test("warns when the usage read was capped, since both findings can only understate", async () => {
    await openCross(cross({ usageTruncated: true }));
    expect(await screen.findByText(/can only understate/i)).toBeInTheDocument();
  });

  test("reports a suppressed cross rather than an empty one", async () => {
    await openCross({ available: false, reason: "No screen inventory has been built yet." });
    expect(await screen.findByText(/no screen inventory has been built yet/i)).toBeInTheDocument();
    expect(screen.queryAllByText("Invisible data")).toHaveLength(0);
  });

  test("a clean cross says so in both panels rather than rendering nothing", async () => {
    await openCross(cross({
      counts: { invisibleFields: 0, invisibleIssues: 0, clutterFields: 0, clutterPlacements: 0, unreachableFields: 0 },
      invisibleData: [], formClutter: [],
    }));

    expect(await screen.findByText(/no field holds values in a project that cannot display it/i)).toBeInTheDocument();
    expect(screen.getByText(/every field on a create screen is filled in by somebody/i)).toBeInTheDocument();
  });
});
