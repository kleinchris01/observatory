import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { SearchTab } from "./SearchTab";

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.stubGlobal("requestAnimationFrame", (fn) => { fn(); return 1; });
});

const SCREENS_RESULT = {
  ok: true,
  query: "pillar = screens AND usage = low AND impact = high",
  ranAt: new Date().toISOString(),
  total: 1,
  truncated: false,
  results: [{
    uid: "screens:1", pillar: "screens", pillarLabel: "Screens", id: "1", name: "Bug Create",
    usage: "low", impact: "high", risk: "medium", churn: "unmeasured", usageValue: 1, impactValue: 40, riskValue: 1, churnValue: null,
    score: 60, scoreDimensions: 3, tabs: 2, fields: 40, projects: 1, discoveries: ["unreached"],
  }],
  pillars: [{ key: "screens", label: "Screens", status: "ok", reason: null, refreshedAt: "2026-09-28T00:00:00Z", total: 8 }],
  thresholds: { screens: { usage: { p25: 2, p75: 5, measured: 8, total: 8, label: "x" }, impact: { p25: 5, p75: 25, measured: 8, total: 8, label: "y" } } },
  discoveryCodes: ["unreached"],
};

function queryBox() {
  return screen.getByRole("combobox", { name: "OQL query" });
}

describe("SearchTab", () => {
  test("runs the query a Ctrl+K hand-off carries", async () => {
    invoke.mockResolvedValueOnce(SCREENS_RESULT);
    render(<SearchTab onNavigate={vi.fn()} intent={{ query: 'name ~ "bug" OR id ~ "bug"' }} />);

    expect(invoke).toHaveBeenCalledWith("runOqlQuery", { query: 'name ~ "bug" OR id ~ "bug"' });
    expect(queryBox()).toHaveValue('name ~ "bug" OR id ~ "bug"');
    expect((await screen.findAllByText("Bug Create")).length).toBeGreaterThan(0);
  });

  test("runs a query on Enter and lays out the results with the pillar's own columns", async () => {
    invoke.mockResolvedValueOnce(SCREENS_RESULT);
    const user = userEvent.setup();
    render(<SearchTab onNavigate={vi.fn()} />);

    await user.click(queryBox());
    await user.paste("pillar = screens AND usage = low AND impact = high");
    await user.keyboard("{Escape}{Enter}");

    expect(invoke).toHaveBeenCalledWith("runOqlQuery", { query: "pillar = screens AND usage = low AND impact = high" });
    expect((await screen.findAllByText("Bug Create")).length).toBeGreaterThan(0);
    const table = screen.getAllByRole("table")[0];
    // Screens' own columns join the shared ones when every result is a screen.
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining(["Pillar", "Name", "Usage", "Impact", "Risk", "Churn", "Attention", "Tabs", "Fields", "Projects (through screen schemes)", "Discoveries"]));
    expect(within(table).getByTitle("Scored on 3 of 4 dimensions")).toHaveTextContent("60");
    expect(screen.getByText("Average attention").closest(".ui-stat")).toHaveTextContent("60");
    expect(within(table).getByText("unreached")).toBeInTheDocument();
    expect(within(table).getByText("low")).toBeInTheDocument();
    expect(within(table).getByText("high")).toBeInTheDocument();
  });

  test("flags a mistake before sending anything, with the nearest suggestion", async () => {
    const user = userEvent.setup();
    render(<SearchTab />);
    await user.type(queryBox(), "pillar = screns");
    expect(screen.getByRole("alert")).toHaveTextContent('"screns" is not a pillar. Did you mean "screens"?');
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    await user.keyboard("{Escape}{Enter}");
    expect(invoke).not.toHaveBeenCalled();
  });

  test("autocompletes values and inserts the chosen one", async () => {
    const user = userEvent.setup();
    render(<SearchTab />);
    await user.type(queryBox(), "usage = ");
    const listbox = screen.getByRole("listbox", { name: "Suggestions" });
    expect(within(listbox).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "lowBottom quarter of its pillar", "mediumMiddle half of its pillar", "highTop quarter of its pillar", "unmeasuredNo data for this measure",
    ]);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(queryBox()).toHaveValue("usage = low ");
  });

  test("a click on a suggestion inserts it", async () => {
    const user = userEvent.setup();
    render(<SearchTab />);
    await user.type(queryBox(), "pillar = scr");
    fireEvent.mouseDown(screen.getByRole("option", { name: /screens/ }));
    expect(queryBox()).toHaveValue("pillar = screens ");
  });

  test("an example runs straight away", async () => {
    invoke.mockResolvedValueOnce(SCREENS_RESULT);
    const user = userEvent.setup();
    render(<SearchTab />);
    await user.click(screen.getByRole("button", { name: "Heavy screens few projects reach" }));
    expect(invoke).toHaveBeenCalledWith("runOqlQuery", { query: "pillar = screens AND usage = low AND impact = high" });
    expect(queryBox()).toHaveValue("pillar = screens AND usage = low AND impact = high");
  });

  test("says which pillars were not searched, and why", async () => {
    invoke.mockResolvedValueOnce({
      ...SCREENS_RESULT,
      total: 0,
      results: [],
      pillars: [
        { key: "fields", label: "Fields", status: "ok", reason: null },
        { key: "boards", label: "Boards", status: "unavailable", reason: "No board inventory has been built yet." },
      ],
    });
    const user = userEvent.setup();
    render(<SearchTab />);
    await user.type(queryBox(), "usage = low");
    await user.keyboard("{Escape}{Enter}");
    expect(await screen.findByText(/was not searched: No board inventory/)).toBeInTheDocument();
    expect(screen.getByText("Nothing matches.")).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  test("opens the pillar tab for a result", async () => {
    invoke.mockResolvedValueOnce(SCREENS_RESULT);
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<SearchTab onNavigate={onNavigate} />);
    await user.click(screen.getByRole("button", { name: "Heavy screens few projects reach" }));
    await user.click(await screen.findByRole("button", { name: "Open Screens" }));
    expect(onNavigate).toHaveBeenCalledWith("screens");
  });

  test("saves a query in this browser and runs it from the list", async () => {
    invoke.mockResolvedValue(SCREENS_RESULT);
    const user = userEvent.setup();
    render(<SearchTab />);
    await user.click(screen.getByRole("button", { name: "Heavy screens few projects reach" }));
    await user.click(await screen.findByRole("button", { name: "Save this query" }));
    await user.type(screen.getByPlaceholderText("Name (optional)"), "Heavy screens");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(JSON.parse(window.localStorage.getItem("observatory.search.saved"))).toEqual([
      { name: "Heavy screens", query: "pillar = screens AND usage = low AND impact = high" },
    ]);
    await user.click(screen.getByRole("button", { name: "Heavy screens" }));
    expect(invoke).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole("button", { name: "Remove saved query Heavy screens" }));
    expect(JSON.parse(window.localStorage.getItem("observatory.search.saved"))).toEqual([]);
    invoke.mockReset();
  });

  test("remembers the last query", () => {
    window.localStorage.setItem("observatory.search.query", "usage = high");
    render(<SearchTab />);
    expect(queryBox()).toHaveValue("usage = high");
  });

  test("shows an error rather than nothing when the search fails", async () => {
    invoke.mockRejectedValueOnce(new Error("timed out"));
    const user = userEvent.setup();
    render(<SearchTab />);
    await user.type(queryBox(), "usage = low");
    await user.keyboard("{Escape}{Enter}");
    expect(await screen.findByText("timed out")).toBeInTheDocument();
  });

  test("explains the four dimensions, their weights and their cut-offs", () => {
    render(<SearchTab />);
    expect(screen.getByText("How scoring works")).toBeInTheDocument();
    expect(screen.getByText("40% of score")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "low: 0 discoveries, medium: 1 discoveries, high: 2+ discoveries" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Risk 40%, Impact 25%, Usage 20%, Churn 15%" })).toBeInTheDocument();
  });

  test("before a search, takes apart a sample score, scaled up for the unmeasured dimension", () => {
    render(<SearchTab />);
    expect(screen.getByText(/run a search to see one of your own/)).toBeInTheDocument();
    // Sample: risk medium, impact high, usage low, churn unmeasured -> (0.2 + 0.25) / 0.85 = 53.
    const tfoot = screen.getByText(/^Attention score/).closest("tr");
    expect(tfoot).toHaveTextContent("on 3 of 4 dimensions");
    expect(tfoot).toHaveTextContent("53");
    expect(screen.getByText("Left out")).toBeInTheDocument();
    expect(screen.getAllByText(/scaled up from/).length).toBeGreaterThan(0);
  });

  test("after a search, takes apart the first scored result", async () => {
    invoke.mockResolvedValueOnce(SCREENS_RESULT);
    const user = userEvent.setup();
    render(<SearchTab />);
    await user.click(screen.getByRole("button", { name: "Heavy screens few projects reach" }));
    expect(await screen.findByText(/from your results/)).toHaveTextContent("Taking apart Bug Create (Screens)");
  });

  test("shows which pillars measure which dimension", () => {
    render(<SearchTab />);
    const grid = screen.getByRole("table", { name: "What each pillar measures for each dimension" });
    const screensRow = within(grid).getByRole("rowheader", { name: "Screens" }).closest("tr");
    expect(screensRow).toHaveTextContent(/through screen schemes/);
    // Screens have no change history.
    expect(within(screensRow).getAllByText("Not measured")).toHaveLength(1);
    const prioritiesRow = within(grid).getByRole("rowheader", { name: "Priorities & resolutions" }).closest("tr");
    // Usage is the crawl's issue count now; only impact is still unmeasured.
    expect(within(prioritiesRow).getAllByText("Not measured")).toHaveLength(1);
  });

  test("an item without enough measured dimensions shows no score rather than zero", async () => {
    invoke.mockResolvedValueOnce({
      ...SCREENS_RESULT,
      results: [{ ...SCREENS_RESULT.results[0], score: null, scoreDimensions: 1 }],
    });
    const user = userEvent.setup();
    render(<SearchTab />);
    await user.click(screen.getByRole("button", { name: "Heavy screens few projects reach" }));
    expect(await screen.findByTitle(/at least 2 of the 4 dimensions/)).toHaveTextContent("—");
    expect(screen.getByText("Nothing here has enough measured dimensions")).toBeInTheDocument();
  });
});
