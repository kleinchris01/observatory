import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { PrioritiesTab } from "./PrioritiesTab";

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

const inventory = (over = {}) => ({
  neverBuilt: false,
  state: "ready",
  staleBuild: false,
  refreshedAt: new Date().toISOString(),
  resolutions: [
    { id: "1", name: "Done", description: "", isDefault: true },
    { id: "2", name: "done", description: "" },
    { id: "3", name: "Won't Fix", description: "" },
  ],
  priorities: [
    { id: "10", name: "High", isDefault: true },
    { id: "11", name: "Low" },
  ],
  governance: {
    available: true,
    totalResolutions: 3,
    totalPriorities: 2,
    resolutionsWithoutDefault: false,
    prioritiesWithoutDefault: false,
    resolutionDuplicateGroupCount: 1,
    reducibleResolutionCount: 1,
    resolutionDuplicateGroups: [{ key: "done", kind: "spacing", names: ["Done", "done"], count: 2 }],
    priorityDuplicateGroupCount: 0,
    reduciblePriorityCount: 0,
    priorityDuplicateGroups: [],
  },
  lastError: null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("PrioritiesTab", () => {
  // The resolver now attaches the crawl's counts. A counted zero and an uncounted value must
  // read differently: zero is what makes a value look safe to retire.
  test("shows each value's issue count, a counted zero, and unmeasured apart", async () => {
    invoke.mockImplementation((fn) => fn === "getEstateInventory"
      ? Promise.resolve(inventory({
        resolutions: [{ id: "1", name: "Done", issueCount: 1204 }, { id: "3", name: "Won't Fix", issueCount: 0 }],
        priorities: [{ id: "10", name: "High", issueCount: null }],
      }))
      : Promise.resolve({}));
    render(<PrioritiesTab />);

    await userEvent.click(await screen.findByRole("button", { name: /^Resolutions/ }));
    expect(await screen.findByText("1,204 issues")).toBeInTheDocument();
    expect(screen.getByText("No issues")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^Priorities/ }));
    expect(await screen.findByText("Not measured")).toBeInTheDocument();
  });

  test("reports never-built rather than an empty list", async () => {
    invoke.mockImplementation((fn) => fn === "getEstateInventory"
      ? Promise.resolve({ neverBuilt: true, state: "idle", resolutions: [], priorities: [], governance: { available: false } })
      : Promise.resolve({}));
    render(<PrioritiesTab />);
    expect(await screen.findByText(/No priorities & resolutions inventory has been built yet/i)).toBeInTheDocument();
  });

  test("shows the totals and the duplicate-name finding", async () => {
    invoke.mockImplementation((fn) => fn === "getEstateInventory" ? Promise.resolve(inventory()) : Promise.resolve({}));
    render(<PrioritiesTab />);

    expect(await screen.findByText("Priorities & Resolutions")).toBeInTheDocument();
    expect(screen.getByText("Duplicate resolution names")).toBeInTheDocument();
    expect(screen.getByText("Near-duplicate resolution names")).toBeInTheDocument();
  });

  test("lists resolutions and flags the near-duplicate", async () => {
    invoke.mockImplementation((fn) => fn === "getEstateInventory" ? Promise.resolve(inventory()) : Promise.resolve({}));
    render(<PrioritiesTab />);
    await screen.findByText("Priorities & Resolutions");
    await userEvent.click(screen.getByRole("button", { name: /^Resolutions/ }));

    expect(await screen.findByText("Won't Fix")).toBeInTheDocument();
    expect(screen.getAllByText("duplicate name").length).toBeGreaterThan(0);
    expect(screen.getByRole("searchbox", { name: /search resolutions/i })).toBeInTheDocument();
  });

  test("shows the estate pillar of the site health score on the overview", async () => {
    invoke.mockImplementation((fn, args) => {
      if (fn === "getEstateInventory") return Promise.resolve(inventory());
      if (fn === "getPillarHealth" && args?.pillar === "estate") return Promise.resolve({
        pillar: {
          key: "estate", available: true, score: 74, grade: "C", total: 2,
          dimensions: [{ key: "resolution-naming", label: "Resolution naming", available: true, score: 60, detail: "1 of 3 duplicate." }],
        },
      });
      return Promise.resolve({});
    });
    render(<PrioritiesTab />);

    await screen.findByText("Priorities & Resolutions");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("getPillarHealth", { pillar: "estate" }));
    expect(await screen.findByText("Resolution naming")).toBeInTheDocument();
  });

  test("queues a build and reports it", async () => {
    invoke.mockImplementation((fn) => {
      if (fn === "getEstateInventory") return Promise.resolve(inventory());
      if (fn === "buildEstateInventory") return Promise.resolve({ queued: true });
      return Promise.resolve({});
    });
    render(<PrioritiesTab />);
    await screen.findByText("Priorities & Resolutions");
    await userEvent.click(screen.getByRole("button", { name: /Rebuild/ }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("buildEstateInventory", {}));
    expect(await screen.findByText(/Build queued/i)).toBeInTheDocument();
  });
});
