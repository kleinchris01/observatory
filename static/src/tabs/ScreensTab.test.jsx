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

    expect(await screen.findByText(/this inventory is stale/i)).toBeInTheDocument();
    expect(screen.getByText(/universe scan does not update screens/i)).toBeInTheDocument();
  });

  test("does not warn about staleness on a fresh build", async () => {
    invoke.mockResolvedValue(inventory());
    render(<ScreensTab />);

    await screen.findByText("Default Screen");
    expect(screen.queryByText(/this inventory is stale/i)).not.toBeInTheDocument();
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
