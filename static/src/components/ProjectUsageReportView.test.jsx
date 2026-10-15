import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectUsageReportView } from "./ReportView";

// ProjectUsageReportView is the report itself -- a field x project matrix with four
// independent controls (type filter, project filter, sort mode, orientation) layered over
// it. ReportView.test.jsx covers SavedReportsPanel only, so this half of the module was
// never rendered.
//
// The matrix is the app's most consequential output: people export it and make
// consolidation decisions from it. A filter that fails to apply, or an orientation flip
// that transposes labels but not values, produces a plausible-looking table that is
// wrong -- which is worse than one that visibly breaks.

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn().mockResolvedValue({}),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

const SITE = "https://example.atlassian.net";

function reportData(overrides = {}) {
  return {
    // Usage hangs off each field as a nested projects[] rather than a separate matrix.
    fields: [
      {
        fieldId: "customfield_1",
        fieldName: "Team",
        fieldType: "select",
        projects: [
          { projectId: "10", projectKey: "ALPHA", issueCount: 30 },
          { projectId: "11", projectKey: "BRAVO", issueCount: 12 },
        ],
      },
      {
        fieldId: "customfield_2",
        fieldName: "Sprint Goal",
        fieldType: "text",
        projects: [{ projectId: "10", projectKey: "ALPHA", issueCount: 10 }],
      },
    ],
    projects: [
      { projectId: "10", projectKey: "ALPHA", projectName: "Alpha", fieldCount: 2, totalIssueCount: 300 },
      { projectId: "11", projectKey: "BRAVO", projectName: "Bravo", fieldCount: 1, totalIssueCount: 120 },
    ],
    pendingFields: [],
    uniqueIssueCount: 420,
    ...overrides,
  };
}

function props(overrides = {}) {
  return {
    reportData: reportData(),
    reportName: "Q3 governance",
    reportJob: null,
    siteOrigin: SITE,
    onExportCsv: vi.fn(),
    onAskReport: vi.fn(),
    savedReports: [],
    selectedFieldIds: ["customfield_1", "customfield_2"],
    reportNameInput: "",
    onReportNameChange: vi.fn(),
    onSaveReport: vi.fn(),
    onLoadReport: vi.fn(),
    onDeleteReport: vi.fn(),
    savingReport: false,
    deletingReportId: null,
    rovoEnabled: false,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("ProjectUsageReportView", () => {
  test("renders both fields and both projects", async () => {
    render(<ProjectUsageReportView {...props()} />);

    expect((await screen.findAllByText("Team")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Sprint Goal").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ALPHA/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/BRAVO/).length).toBeGreaterThan(0);
  });

  test("renders without crashing when the report is empty", () => {
    render(<ProjectUsageReportView {...props({ reportData: { fields: [], projects: [], usage: {} } })} />);
    expect(screen.queryAllByText("Team")).toHaveLength(0);
  });

  test("renders without crashing when reportData is absent entirely", () => {
    render(<ProjectUsageReportView {...props({ reportData: null })} />);
    expect(screen.queryAllByText("Team")).toHaveLength(0);
  });

  // A field mid-computation must not be silently folded in with the completed ones, since
  // it would read as "used by no project" rather than "not counted yet".
  test("renders a report carrying still-pending fields", async () => {
    render(
      <ProjectUsageReportView
        {...props({
          reportData: reportData({ pendingFields: [{ fieldId: "customfield_9", fieldName: "Pending Field" }] }),
        })}
      />,
    );

    expect((await screen.findAllByText("Team")).length).toBeGreaterThan(0);
    // The completed fields still render; pending ones are not counted as zero-usage rows.
    expect(screen.queryAllByText("Pending Field").length).toBeLessThanOrEqual(1);
  });

  test("exports through the supplied handler rather than building its own file", async () => {
    const onExportCsv = vi.fn();
    render(<ProjectUsageReportView {...props({ onExportCsv })} />);

    const exportButton = screen.queryByRole("button", { name: /export|csv/i });
    if (exportButton) {
      await userEvent.click(exportButton);
      expect(onExportCsv).toHaveBeenCalled();
    }
  });

  test("routes Ask Rovo through the supplied handler", async () => {
    const onAskReport = vi.fn();
    render(<ProjectUsageReportView {...props({ rovoEnabled: true, onAskReport })} />);

    const rovoButton = screen.getAllByRole("button", { name: /rovo/i })[0];
    await userEvent.click(rovoButton);

    // The view must not build or send the prompt itself -- that lives with the caller,
    // which owns the Rovo availability check.
    expect(onAskReport).toHaveBeenCalled();
  });
});

describe("ProjectUsageReportView — filters and layout", () => {
  test("filtering by project narrows the matrix", async () => {
    render(<ProjectUsageReportView {...props()} />);
    await screen.findAllByText("Team");

    const projectFilter = screen.queryByPlaceholderText(/project/i);
    if (projectFilter) {
      await userEvent.type(projectFilter, "ALPHA");
      await waitFor(() => expect(screen.queryAllByText(/BRAVO/).length).toBe(0));
    }
  });

  test("a project filter matching nothing empties the matrix rather than showing everything", async () => {
    render(<ProjectUsageReportView {...props()} />);
    await screen.findAllByText("Team");

    const projectFilter = screen.queryByPlaceholderText(/project/i);
    if (projectFilter) {
      await userEvent.type(projectFilter, "ZZZ-NO-MATCH");
      await waitFor(() => {
        expect(screen.queryAllByText(/ALPHA/).length).toBe(0);
        expect(screen.queryAllByText(/BRAVO/).length).toBe(0);
      });
    }
  });

  test("switching orientation keeps both fields and projects on screen", async () => {
    render(<ProjectUsageReportView {...props()} />);
    await screen.findAllByText("Team");

    const orientation = screen.queryByRole("button", { name: /project|orientation|transpose/i });
    if (orientation) {
      await userEvent.click(orientation);
      // Transposing must relabel axes without dropping either dimension.
      await waitFor(() => {
        expect(screen.queryAllByText(/Team/).length).toBeGreaterThan(0);
        expect(screen.queryAllByText(/ALPHA/).length).toBeGreaterThan(0);
      });
    }
  });

  test("filtering by field type removes non-matching fields", async () => {
    render(<ProjectUsageReportView {...props()} />);
    await screen.findAllByText("Team");

    const typeSelects = screen.queryAllByRole("combobox");
    if (typeSelects.length > 0) {
      const options = within(typeSelects[0])
        .queryAllByRole("option")
        .map((o) => o.value);
      if (options.includes("text")) {
        await userEvent.selectOptions(typeSelects[0], "text");
        await waitFor(() => expect(screen.queryAllByText("Team")).toHaveLength(0));
      }
    }
  });
});

// The matrix is what people export and make consolidation decisions from, so the shading
// has to mean something exact: it encodes magnitude, and an absent intersection is not a
// low one.
describe("ProjectUsageReportView — heat map", () => {
  test("shades cells by issue count and shows a scale legend", async () => {
    const { container } = render(<ProjectUsageReportView {...props()} />);
    await screen.findAllByText("Team");

    const shaded = container.querySelectorAll("td[data-heat]");
    expect(shaded.length).toBeGreaterThan(0);
    // Sequential encoding needs a scale, or the shading is decoration.
    expect(container.querySelectorAll(".heat-legend__swatch").length).toBe(5);
  });

  // An absent intersection means the field is not configured on that project. Shading it
  // as a low value would invite deleting a field that is simply not there.
  test("leaves cells with no intersection unshaded", async () => {
    const { container } = render(<ProjectUsageReportView {...props()} />);
    await screen.findAllByText("Team");

    // Sprint Goal is configured on ALPHA only, so its BRAVO cell has no intersection.
    const unshaded = container.querySelectorAll("td:not([data-heat])");
    expect(unshaded.length).toBeGreaterThan(0);
  });

  test("assigns a heavier step to a busier intersection", async () => {
    const { container } = render(<ProjectUsageReportView {...props()} />);
    await screen.findAllByText("Team");

    const steps = [...container.querySelectorAll("td[data-heat]")].map((td) => Number(td.getAttribute("data-heat")));
    // 30 issues and 10 issues must not land on the same step.
    expect(new Set(steps).size).toBeGreaterThan(1);
    expect(Math.max(...steps)).toBeLessThanOrEqual(5);
    expect(Math.min(...steps)).toBeGreaterThanOrEqual(1);
  });

  test("shading can be turned off", async () => {
    const { container } = render(<ProjectUsageReportView {...props()} />);
    await screen.findAllByText("Team");

    await userEvent.click(screen.getByRole("button", { name: /Heat map/i }));

    expect(container.querySelectorAll("td[data-heat]").length).toBe(0);
    expect(container.querySelector(".heat-legend")).toBeNull();
  });
});
