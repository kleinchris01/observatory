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
    usage: "low", impact: "high", usageValue: 1, impactValue: 40, tabs: 2, fields: 40, projects: 1, findings: ["unreached"],
  }],
  pillars: [{ key: "screens", label: "Screens", status: "ok", reason: null, refreshedAt: "2026-09-28T00:00:00Z", total: 8 }],
  thresholds: { screens: { usage: { p25: 2, p75: 5, measured: 8, total: 8, label: "x" }, impact: { p25: 5, p75: 25, measured: 8, total: 8, label: "y" } } },
  findingCodes: ["unreached"],
};

function queryBox() {
  return screen.getByRole("combobox", { name: "OQL query" });
}

describe("SearchTab", () => {
  test("runs a query on Enter and lays out the results with the pillar's own columns", async () => {
    invoke.mockResolvedValueOnce(SCREENS_RESULT);
    const user = userEvent.setup();
    render(<SearchTab onNavigate={vi.fn()} />);

    await user.type(queryBox(), "pillar = screens AND usage = low AND impact = high");
    await user.keyboard("{Escape}{Enter}");

    expect(invoke).toHaveBeenCalledWith("runOqlQuery", { query: "pillar = screens AND usage = low AND impact = high" });
    expect(await screen.findByText("Bug Create")).toBeInTheDocument();
    const table = screen.getAllByRole("table")[0];
    // Screens' own columns join the shared ones when every result is a screen.
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining(["Pillar", "Name", "Usage", "Impact", "Tabs", "Fields", "Projects (through screen schemes)", "Findings"]));
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

  test("explains what usage and impact mean in every pillar", () => {
    render(<SearchTab />);
    expect(screen.getByText("How usage and impact are measured")).toBeInTheDocument();
  });
});
