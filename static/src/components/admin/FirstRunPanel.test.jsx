import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { FirstRunPanel, ArrivalsList } from "./FirstRunPanel";

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

const step = (over = {}) => ({
  key: "first-scan",
  title: "Run the first scan",
  detail: "Observatory reads every project, field, screen and workflow on this site.",
  done: false,
  kind: "derived",
  cta: null,
  ...over,
});

const state = (over = {}) => ({
  show: true,
  dismissed: false,
  remaining: 2,
  scanRunning: false,
  steps: [
    step(),
    step({
      key: "evidence-rule",
      title: 'Understand "not measured"',
      kind: "acknowledged",
      detail: "Zero only ever means a scan looked and found none.",
    }),
  ],
  arrivals: { available: false, landed: [], pending: [] },
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("FirstRunPanel", () => {
  test("renders the outstanding steps and how many are left", async () => {
    invoke.mockResolvedValue(state());
    render(<FirstRunPanel onNavigate={vi.fn()} />);

    expect(await screen.findByText("Getting started")).toBeInTheDocument();
    expect(screen.getByText(/2 steps left/i)).toBeInTheDocument();
    expect(screen.getByText("Run the first scan")).toBeInTheDocument();
  });

  test("renders nothing at all once the backend says the panel is done", async () => {
    // The panel has to disappear on its own. A getting-started card that outlives getting
    // started is clutter with a tick in it, permanently at the top of the page an admin
    // opens most.
    invoke.mockResolvedValue(state({ show: false, remaining: 0 }));
    const { container } = render(<FirstRunPanel onNavigate={vi.fn()} />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("getFirstRunState", {}));
    expect(container).toBeEmptyDOMElement();
  });

  test("a broken read leaves the page it welcomes you to intact", async () => {
    invoke.mockRejectedValueOnce(new Error("resolver exploded"));
    const { container } = render(<FirstRunPanel onNavigate={vi.fn()} />);

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  test("only an acknowledged step offers to be ticked by hand", async () => {
    // The load-bearing UI rule. A derived step reports the estate, and the estate is the
    // only thing entitled to answer it -- a "Got it" there would be a tick meaning
    // "somebody clicked" wearing the appearance of "this is true".
    invoke.mockResolvedValue(state());
    render(<FirstRunPanel onNavigate={vi.fn()} />);

    await screen.findByText("Run the first scan");
    expect(screen.getAllByRole("button", { name: "Got it" })).toHaveLength(1);
  });

  test("acknowledging sends the key and re-reads the state", async () => {
    invoke.mockImplementation((fn) =>
      fn === "getFirstRunState" ? Promise.resolve(state()) : Promise.resolve({ ok: true }),
    );
    render(<FirstRunPanel onNavigate={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Got it" }));

    expect(invoke).toHaveBeenCalledWith("setFirstRunState", { acknowledge: "evidence-rule" });
    await waitFor(() => expect(invoke.mock.calls.filter(([fn]) => fn === "getFirstRunState")).toHaveLength(2));
  });

  test("dismissing sends the dismissal", async () => {
    invoke.mockImplementation((fn) =>
      fn === "getFirstRunState" ? Promise.resolve(state()) : Promise.resolve({ ok: true }),
    );
    render(<FirstRunPanel onNavigate={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));

    expect(invoke).toHaveBeenCalledWith("setFirstRunState", { dismissed: true });
  });

  test("a failed write leaves the panel as it was", async () => {
    invoke.mockImplementation((fn) =>
      fn === "getFirstRunState" ? Promise.resolve(state()) : Promise.reject(new Error("kvs down")),
    );
    render(<FirstRunPanel onNavigate={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Got it" }));

    // Nothing was lost, so nothing is said. The step is still there to try again.
    await waitFor(() => expect(screen.getByRole("button", { name: "Got it" })).not.toBeDisabled());
  });

  test("a step's call to action navigates to the tab that does the work", async () => {
    const onNavigate = vi.fn();
    invoke.mockResolvedValue(state({ steps: [step({ cta: { label: "Go to Scans", tab: "scans" } })] }));
    render(<FirstRunPanel onNavigate={onNavigate} />);

    await userEvent.click(await screen.findByRole("button", { name: /Go to Scans/ }));

    expect(onNavigate).toHaveBeenCalledWith("scans");
  });

  test("a done step keeps its title but drops its explanation and its prompts", async () => {
    invoke.mockResolvedValue(
      state({
        remaining: 0,
        show: true,
        steps: [step({ done: true, cta: { label: "Go to Scans", tab: "scans" } })],
      }),
    );
    render(<FirstRunPanel onNavigate={vi.fn()} />);

    expect(await screen.findByText("Run the first scan")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Go to Scans/ })).not.toBeInTheDocument();
  });

  test("a running first scan says so instead of counting steps", async () => {
    invoke.mockResolvedValue(state({ scanRunning: true }));
    render(<FirstRunPanel onNavigate={vi.fn()} />);

    expect(await screen.findByText(/Your first scan is running/i)).toBeInTheDocument();
    expect(screen.queryByText(/steps left/i)).not.toBeInTheDocument();
  });
});

describe("ArrivalsList", () => {
  const arrivals = (over = {}) => ({
    available: true,
    landed: [
      {
        key: "screens",
        label: "Screens",
        state: "done",
        completedAt: "2026-01-01T11:00:00.000Z",
        produced: 40,
        countable: true,
        error: null,
      },
      {
        key: "health",
        label: "Health",
        state: "done",
        completedAt: "2026-01-01T10:00:00.000Z",
        produced: null,
        countable: false,
        error: null,
      },
    ],
    pending: [
      {
        key: "issues",
        label: "Issues",
        state: "running",
        completedAt: null,
        produced: null,
        countable: false,
        error: null,
      },
      {
        key: "filters",
        label: "Filters",
        state: "failed",
        completedAt: null,
        produced: null,
        countable: false,
        error: "Jira said 503",
      },
    ],
    ...over,
  });

  test("says how much of the estate has landed", () => {
    render(<ArrivalsList arrivals={arrivals()} onNavigate={vi.fn()} />);
    expect(screen.getByText("2 of 4 sections have landed")).toBeInTheDocument();
  });

  test("a stage that counts something shows the count, and one that does not shows no number", () => {
    render(<ArrivalsList arrivals={arrivals()} onNavigate={vi.fn()} />);

    const label = (name) => screen.getByText(name).closest(".first-run__arrival-label").textContent;

    expect(label("Screens")).toContain("40");
    // health records a score, not a count. "Health — 0" would read as a failure rather than
    // as a stage that simply has nothing to count.
    expect(label("Health")).not.toMatch(/\d/);
  });

  test("a landed stage links straight to the section it filled", async () => {
    const onNavigate = vi.fn();
    render(<ArrivalsList arrivals={arrivals()} onNavigate={onNavigate} />);

    await userEvent.click(screen.getAllByRole("button", { name: /Open/ })[0]);

    expect(onNavigate).toHaveBeenCalledWith("screens");
  });

  test("a stage with no tab of its own offers no dead link", () => {
    // The whole reason the map is written out rather than guessed at: health and issues have
    // no section to open, and a link that goes nowhere in a welcome panel is worse than none.
    render(<ArrivalsList arrivals={arrivals()} onNavigate={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: /Open/ })).toHaveLength(1);
  });

  test("a failed stage is reported in the same list, with the reason", () => {
    render(<ArrivalsList arrivals={arrivals()} onNavigate={vi.fn()} />);
    expect(screen.getByText(/did not build: Jira said 503/)).toBeInTheDocument();
    expect(screen.getByText(/running now/)).toBeInTheDocument();
  });

  test("nothing landed yet still says so rather than rendering an empty rail", () => {
    render(<ArrivalsList arrivals={arrivals({ landed: [] })} onNavigate={vi.fn()} />);
    expect(screen.getByText("Nothing has landed yet")).toBeInTheDocument();
  });

  test("an unavailable arrivals read renders nothing", () => {
    const { container } = render(
      <ArrivalsList arrivals={{ available: false, landed: [], pending: [] }} onNavigate={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
