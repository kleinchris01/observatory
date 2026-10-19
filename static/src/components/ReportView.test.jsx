import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReportErrorBoundary, SavedReportsPanel, ProjectUsageReportView } from "./ReportView";

// ---------------------------------------------------------------------------
// ReportErrorBoundary
// ---------------------------------------------------------------------------

// Component that unconditionally throws an error
function BrokenChild() {
  throw new Error("Render explosion");
}

// Suppress the console.error noise that React prints on caught errors
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("ReportErrorBoundary", () => {
  it("renders children normally when no error is thrown", () => {
    render(
      <ReportErrorBoundary>
        <span>All good</span>
      </ReportErrorBoundary>,
    );
    expect(screen.getByText("All good")).toBeInTheDocument();
  });

  it("catches a thrown error and shows fallback UI", () => {
    render(
      <ReportErrorBoundary>
        <BrokenChild />
      </ReportErrorBoundary>,
    );
    expect(screen.getByText("Render explosion")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// SavedReportsPanel
// ---------------------------------------------------------------------------
describe("SavedReportsPanel", () => {
  const defaultProps = {
    reports: [],
    selectedFieldIds: [],
    reportName: "",
    onReportNameChange: vi.fn(),
    onSaveReport: vi.fn(),
    onLoadReport: vi.fn(),
    onDeleteReport: vi.fn(),
    savingReport: false,
    deletingReportId: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear localStorage between tests
    localStorage.clear();
  });

  it("renders the Saved Reports heading", () => {
    render(<SavedReportsPanel {...defaultProps} />);
    expect(screen.getByText("Saved Reports")).toBeInTheDocument();
  });

  it("shows 'No saved reports yet' when reports array is empty", () => {
    render(<SavedReportsPanel {...defaultProps} />);
    expect(screen.getByText("No saved reports yet.")).toBeInTheDocument();
  });

  it("renders report items when reports are provided", () => {
    const reports = [
      {
        reportId: "r1",
        name: "Q1 Report",
        fieldIds: ["customfield_1", "customfield_2"],
        updatedAt: "2024-01-15T10:00:00Z",
      },
      {
        reportId: "r2",
        name: "Q2 Report",
        fieldIds: ["customfield_3"],
        updatedAt: "2024-04-01T10:00:00Z",
      },
    ];
    render(<SavedReportsPanel {...defaultProps} reports={reports} />);
    expect(screen.getByText("Q1 Report")).toBeInTheDocument();
    expect(screen.getByText("Q2 Report")).toBeInTheDocument();
  });

  it("renders Load and Delete buttons for each report", () => {
    const reports = [
      {
        reportId: "r1",
        name: "My Report",
        fieldIds: ["customfield_1"],
        updatedAt: "2024-01-15T10:00:00Z",
      },
    ];
    render(<SavedReportsPanel {...defaultProps} reports={reports} />);
    expect(screen.getByRole("button", { name: "Load" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("renders save button as disabled when no fields are selected", () => {
    render(<SavedReportsPanel {...defaultProps} selectedFieldIds={[]} />);
    const saveBtn = screen.getByRole("button", { name: /save report/i });
    expect(saveBtn).toBeDisabled();
  });

  it("renders save button enabled when fields are selected", () => {
    render(<SavedReportsPanel {...defaultProps} selectedFieldIds={["customfield_1"]} />);
    const saveBtn = screen.getByRole("button", { name: /save report/i });
    expect(saveBtn).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// ProjectUsageReportView — no data state
// ---------------------------------------------------------------------------
describe("ProjectUsageReportView", () => {
  const savedReportsProps = {
    savedReports: [],
    selectedFieldIds: [],
    reportNameInput: "",
    onReportNameChange: vi.fn(),
    onSaveReport: vi.fn(),
    onLoadReport: vi.fn(),
    onDeleteReport: vi.fn(),
    savingReport: false,
    deletingReportId: null,
    rovoEnabled: false,
    onExportCsv: vi.fn(),
    onAskReport: vi.fn(),
    siteOrigin: "https://example.atlassian.net",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("renders empty state with 'Select fields' prompt when no reportData or reportJob", () => {
    render(<ProjectUsageReportView {...savedReportsProps} reportData={null} reportJob={null} reportName="" />);
    expect(screen.getByText("Select fields, then generate a report.")).toBeInTheDocument();
  });

  it("renders 'No report rows' empty state when reportData has no fields", () => {
    render(
      <ProjectUsageReportView
        {...savedReportsProps}
        reportData={{ fields: [], projects: [], pendingFields: [], uniqueIssueCount: null }}
        reportJob={null}
        reportName="Empty Report"
      />,
    );
    expect(screen.getByText("No report rows were returned for the selected fields.")).toBeInTheDocument();
  });

  it("surfaces the job's lastError instead of the generic empty-rows message when the job failed", () => {
    const reportJob = {
      status: "failed",
      reportName: "Failed Report",
      processedFields: 0,
      totalFields: 5,
      percentComplete: 0,
      startedAt: "2024-01-15T10:00:00Z",
      completedAt: "2024-01-15T10:00:05Z",
      lastError: "Snapshot version mismatch",
      progressLog: [],
    };
    render(
      <ProjectUsageReportView
        {...savedReportsProps}
        reportData={{ fields: [], projects: [], pendingFields: [], uniqueIssueCount: null }}
        reportJob={reportJob}
        reportName="Failed Report"
      />,
    );
    expect(screen.getByText(/Report generation failed: Snapshot version mismatch/)).toBeInTheDocument();
    expect(screen.queryByText("No report rows were returned for the selected fields.")).not.toBeInTheDocument();
  });

  it("falls back to a generic failure message when the failed job has no lastError", () => {
    const reportJob = {
      status: "failed",
      reportName: "Failed Report",
      processedFields: 0,
      totalFields: 5,
      percentComplete: 0,
      startedAt: "2024-01-15T10:00:00Z",
      completedAt: "2024-01-15T10:00:05Z",
      lastError: null,
      progressLog: [],
    };
    render(
      <ProjectUsageReportView
        {...savedReportsProps}
        reportData={{ fields: [], projects: [], pendingFields: [], uniqueIssueCount: null }}
        reportJob={reportJob}
        reportName="Failed Report"
      />,
    );
    expect(screen.getByText(/Report generation failed: Unknown error\./)).toBeInTheDocument();
  });

  it("renders report content when reportData has fields", () => {
    const reportData = {
      fields: [
        {
          fieldId: "customfield_1",
          fieldName: "Alpha Field",
          fieldType: "text",
          projects: [
            {
              projectId: "P1",
              projectKey: "AA",
              projectName: "Alpha",
              issueCount: 10,
              jql: "cf[1] is not EMPTY AND project = AA",
            },
          ],
        },
      ],
      projects: [{ projectId: "P1", projectKey: "AA", projectName: "Alpha" }],
      pendingFields: [],
      uniqueIssueCount: null,
    };
    render(
      <ProjectUsageReportView
        {...savedReportsProps}
        reportData={reportData}
        reportJob={null}
        reportName="Test Report"
      />,
    );
    expect(screen.getByText("Test Report")).toBeInTheDocument();
    // The filter controls should be visible
    expect(screen.getByText("Field type")).toBeInTheDocument();
  });

  it("shows building status when reportJob has status=building", () => {
    const reportData = {
      fields: [
        {
          fieldId: "customfield_1",
          fieldName: "Field A",
          fieldType: "text",
          projects: [],
        },
      ],
      projects: [],
      pendingFields: [],
      uniqueIssueCount: null,
    };
    const reportJob = {
      status: "building",
      reportName: "Building Report",
      processedFields: 3,
      totalFields: 10,
      percentComplete: 30,
      startedAt: "2024-01-15T10:00:00Z",
      completedAt: null,
      lastError: null,
      progressLog: [],
    };
    render(
      <ProjectUsageReportView
        {...savedReportsProps}
        reportData={reportData}
        reportJob={reportJob}
        reportName="Building Report"
      />,
    );
    expect(screen.getByText("building")).toBeInTheDocument();
    expect(screen.getByText("30%")).toBeInTheDocument();
  });
});
