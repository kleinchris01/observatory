import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { ReportsTab } from "./ReportsTab";
import * as utils from "../utils";

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
  rovo: { open: vi.fn() },
}));

vi.mock("./RqtTab", () => ({ RqtIndexView: () => <div>rqt view</div> }));

const boardsReport = (over = {}) => ({
  pillar: "boards",
  label: "Boards",
  entity: "boards",
  healthPillars: ["boards"],
  status: "ok",
  reason: null,
  refreshedAt: new Date().toISOString(),
  columns: [
    { key: "id", label: "Board ID", kind: "text" },
    { key: "name", label: "Name", kind: "text" },
    { key: "columns", label: "Columns", kind: "number" },
    { key: "findings", label: "Findings", kind: "list" },
  ],
  rows: [
    { id: "2", name: "Broken board", columns: 0, findings: ["no-backing-filter"] },
    { id: "1", name: "Fine board", columns: 3, findings: [] },
  ],
  total: 2,
  truncated: false,
  flaggedCount: 1,
  summary: [
    { label: "Boards", value: 2 },
    { label: "With findings", value: 1, tone: "warning" },
  ],
  notes: ["A caveat worth reading."],
  ...over,
});

const health = {
  score: 81,
  grade: "B",
  dimensionsScored: 1,
  dimensionsTotal: 1,
  pillars: [
    {
      key: "boards", label: "Boards", available: true, score: 60, grade: "D", scored: 1, total: 1,
      dimensions: [{ key: "boardBacking", label: "Backing filters", available: true, score: 60, detail: "1 of 2 broken" }],
    },
  ],
};

function renderTab(props = {}) {
  return render(
    <ReportsTab
      siteOrigin="https://x.atlassian.net"
      selectedFieldIds={[]}
      onSetSelectedFieldIds={() => {}}
      health={health}
      healthScoredAt="2026-09-24T10:00:00Z"
      {...props}
    />
  );
}

function subNav() {
  return document.querySelector(".sub-nav");
}

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockImplementation(async (name) => {
    if (name === "getSavedReports") return { reports: [] };
    if (name === "getPillarReport") return boardsReport();
    return {};
  });
});

describe("ReportsTab", () => {
  test("opens on the governance scorecard, grouped nav with every pillar", async () => {
    renderTab();
    expect(screen.getByRole("heading", { name: "Governance scorecard" })).toBeInTheDocument();
    const groups = [...subNav().querySelectorAll(".sub-nav__group")].map((n) => n.textContent);
    expect(groups).toEqual(["Site", "Pillars", "Field tools"]);
    for (const { label } of utils.PILLAR_REPORT_NAV) {
      expect(within(subNav()).getByText(label)).toBeInTheDocument();
    }
    // The scorecard is the health reshaped, so it renders its dimension rows.
    expect(screen.getByText("Backing filters")).toBeInTheDocument();
    expect(screen.getByText("needs-attention")).toBeInTheDocument();
  });

  test("scorecard without health says how to get it", () => {
    renderTab({ health: null });
    expect(screen.getByText(/Open the Overview to score it/)).toBeInTheDocument();
  });

  test("a pillar report loads through getPillarReport and renders tiles, notes, governance and rows", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(within(subNav()).getByText("Boards"));

    expect(await screen.findByRole("heading", { name: "Boards report" })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("getPillarReport", { pillar: "boards" });
    expect(screen.getByText("A caveat worth reading.")).toBeInTheDocument();
    expect(screen.getByText("Broken board")).toBeInTheDocument();
    expect(screen.getByText("no-backing-filter")).toBeInTheDocument();
    // The pillar's governance panel, fed from the overview health already in hand.
    expect(screen.getByText("Scored across 1 of 1 dimensions.")).toBeInTheDocument();
    // Boards has no Rovo agent, so no Ask Rovo button.
    expect(screen.queryByRole("button", { name: /Ask Rovo/ })).toBeNull();
  });

  test("the findings-only toggle hides clean rows", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(within(subNav()).getByText("Boards"));
    await screen.findByText("Fine board");

    await user.click(screen.getByRole("checkbox", { name: /Only rows with findings/ }));
    expect(screen.queryByText("Fine board")).toBeNull();
    expect(screen.getByText("Broken board")).toBeInTheDocument();
  });

  test("export sends the report through the shared CSV path", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(utils, "downloadCsv").mockImplementation(() => {});
    renderTab();
    await user.click(within(subNav()).getByText("Boards"));
    await screen.findByText("Broken board");

    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(spy).toHaveBeenCalledTimes(1);
    const [filename, rows] = spy.mock.calls[0];
    expect(filename).toBe("boards-report.csv");
    expect(rows[1]).toEqual(["Board ID", "Name", "Columns", "Findings"]);
    spy.mockRestore();
  });

  test("an unbuilt pillar shows its reason and cannot be exported", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(async (name) => (name === "getPillarReport"
      ? { ...boardsReport(), status: "unavailable", reason: "No board inventory has been built yet.", rows: [], columns: [], summary: [], notes: [], total: 0 }
      : { reports: [] }));
    renderTab();
    await user.click(within(subNav()).getByText("Boards"));

    expect(await screen.findByText("No board inventory has been built yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  });

  test("a failed load shows the error, not an empty report", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(async (name) => {
      if (name === "getPillarReport") throw new Error("Report blew up");
      return { reports: [] };
    });
    renderTab();
    await user.click(within(subNav()).getByText("Boards"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Report blew up");
  });

  test("a pillar with an agent offers Ask Rovo scoped to the report", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(async (name) => (name === "getPillarReport"
      ? { ...boardsReport(), pillar: "screens", label: "Screens", healthPillars: ["screens"] }
      : { reports: [] }));
    renderTab();
    await user.click(within(subNav()).getByText("Screens"));
    expect(await screen.findByRole("button", { name: "Ask Rovo about this report" })).toBeInTheDocument();
  });

  test("a field-report hand-off lands on the usage matrix, not the scorecard", () => {
    renderTab({ autoGenerate: true, selectedFieldIds: ["customfield_1"], onAutoGenerateConsumed: () => {} });
    expect(screen.getByRole("heading", { name: "Field usage matrix" })).toBeInTheDocument();
  });

  test("the RQT section still opens from its deep link", async () => {
    renderTab({ initialSection: "rqt" });
    expect(await screen.findByText("rqt view")).toBeInTheDocument();
  });
});
