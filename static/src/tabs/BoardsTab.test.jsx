import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { BoardsTab } from "./BoardsTab";

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
  lastError: null,
  boards: [
    {
      boardId: "1",
      name: "PT2 Scrum",
      type: "scrum",
      locationType: "project",
      locationKey: "PT2",
      locationName: "Prototype & Test",
      filterId: "4001",
      configReadable: true,
      columnCount: 3,
      columns: [],
      unmappedColumns: 0,
    },
    {
      boardId: "2",
      name: "My work",
      type: "kanban",
      locationType: "user",
      locationName: "Alex",
      filterId: null,
      configReadable: true,
      columnCount: 2,
      columns: [],
      unmappedColumns: 1,
    },
    {
      boardId: "3",
      name: "Team-managed",
      type: "simple",
      locationType: "project",
      locationKey: "TM",
      filterId: null,
      configReadable: false,
      columnCount: 0,
      columns: [],
      unmappedColumns: 0,
    },
  ],
  summary: {
    total: 3,
    byType: { scrum: 1, kanban: 1, simple: 1 },
    personal: 1,
    unreadable: 1,
    missingFilter: 1,
    totalColumns: 5,
  },
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("BoardsTab", () => {
  test("reports never-built rather than an empty list", async () => {
    invoke.mockImplementation((fn) =>
      fn === "getBoardInventory"
        ? Promise.resolve({
            neverBuilt: true,
            state: "idle",
            boards: [],
            summary: { total: 0, byType: {}, personal: 0, unreadable: 0, missingFilter: 0, totalColumns: 0 },
          })
        : Promise.resolve({}),
    );
    render(<BoardsTab intent={null} />);
    expect(await screen.findByText(/No board inventory has been built yet/i)).toBeInTheDocument();
  });

  test("shows the estate stats and the type breakdown", async () => {
    invoke.mockImplementation((fn) =>
      fn === "getBoardInventory" ? Promise.resolve(inventory()) : Promise.resolve({}),
    );
    render(<BoardsTab intent={null} />);

    await screen.findByRole("button", { name: /Rebuild/i });
    // Personal / unreadable / missing-filter stats come straight off the summary.
    expect(screen.getByText("Personal boards")).toBeInTheDocument();
    expect(screen.getByText("Config unreadable")).toBeInTheDocument();
    expect(screen.getByText("No backing filter")).toBeInTheDocument();
  });

  test("lists boards with their location, backing filter and column state on the Boards sub-view", async () => {
    invoke.mockImplementation((fn) =>
      fn === "getBoardInventory" ? Promise.resolve(inventory()) : Promise.resolve({}),
    );
    const user = userEvent.setup();
    render(<BoardsTab intent={null} />);

    await screen.findByRole("button", { name: /Rebuild/i });
    await user.click(screen.getByRole("button", { name: /Boards\s*3/i }));

    expect(await screen.findByText("PT2 Scrum")).toBeInTheDocument();
    expect(screen.getByText(/PT2 · Prototype & Test/)).toBeInTheDocument();
    expect(screen.getByText("filter 4001")).toBeInTheDocument();
    // A team-managed board whose config 404'd is flagged, not hidden.
    expect(screen.getByText("config unreadable")).toBeInTheDocument();
    // The personal board has an unmapped column.
    expect(screen.getByText(/2 columns · 1 unmapped/)).toBeInTheDocument();
  });

  test("queues a build and surfaces the notice", async () => {
    invoke.mockImplementation((fn) => {
      if (fn === "getBoardInventory") return Promise.resolve(inventory());
      if (fn === "buildBoardInventory") return Promise.resolve({ queued: true });
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<BoardsTab intent={null} />);

    await screen.findByRole("button", { name: /Rebuild/i });
    await user.click(screen.getByRole("button", { name: /Rebuild/i }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("buildBoardInventory", {}));
    expect(await screen.findByText(/Build queued/i)).toBeInTheDocument();
  });
});
