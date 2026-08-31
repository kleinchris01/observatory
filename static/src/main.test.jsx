import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke, view, rovo } from "@forge/bridge";
import { App } from "./main";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeField(overrides = {}) {
  return {
    id: "customfield_10001",
    name: "Test Field",
    type: "text",
    origin: "custom",
    contextCount: 2,
    issueCount: 100,
    activeProjectCount: 3,
    findings: [],
    ...overrides,
  };
}

function makeFieldInventory(overrides = {}) {
  return {
    refreshedAt: "2024-01-15T10:00:00Z",
    total: 1,
    page: 1,
    pageSize: 10,
    totalPages: 1,
    availableTypes: ["text"],
    fields: [makeField()],
    findingsSummary: { adminAttention: 0, risky: 0, cleanup: 0, standardize: 0 },
    snapshotStatus: { state: "ready" },
    buildProgress: null,
    readOnlyMode: false,
    ...overrides,
  };
}

function emptyFieldInventory() {
  return {
    refreshedAt: null,
    total: 0,
    page: 1,
    pageSize: 10,
    totalPages: 1,
    availableTypes: [],
    fields: [],
    findingsSummary: { adminAttention: 0, risky: 0, cleanup: 0, standardize: 0 },
    snapshotStatus: { state: "idle" },
    buildProgress: null,
    readOnlyMode: false,
  };
}

function defaultInvokeImpl(fnName, payload) {
  switch (fnName) {
    case "checkMacroAccess":
      return Promise.resolve({ allowed: true });
    case "getFieldInventory":
      return Promise.resolve(makeFieldInventory());
    case "getSavedReports":
      return Promise.resolve({ reports: [] });
    case "getFilteredFieldIds":
      return Promise.resolve({ fieldIds: [] });
    case "getFieldDetails":
      return Promise.resolve({ field: null, findings: null, totalIssueCount: 0, activeProjectCount: 0, activeProjects: [], usagePage: 1, usageTotalPages: 1 });
    case "getProjectsView":
      return Promise.resolve({ projects: [], fields: [], selectedProject: null, totalPages: 1 });
    case "startProjectUsageReportJob":
      return Promise.resolve({ jobId: "job-1" });
    case "getProjectUsageReportJob":
      return Promise.resolve({ job: null });
    default:
      return Promise.resolve({});
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  invoke.mockImplementation(defaultInvokeImpl);
  view.getContext.mockResolvedValue({ siteUrl: "https://example.atlassian.net", extension: { type: "confluence:globalPage" } });
  rovo.invoke.mockResolvedValue({});
  rovo.isEnabled = vi.fn().mockResolvedValue(false);
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderApp() {
  const utils = render(<App />);
  await screen.findByText("Observatory");
  return utils;
}

// ---------------------------------------------------------------------------
// 1. Smoke test
// ---------------------------------------------------------------------------

describe("App smoke test", () => {
  it("renders without crashing with mocked invoke", async () => {
    await renderApp();
    expect(screen.getByText("Observatory")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 2. Empty state
// ---------------------------------------------------------------------------

describe("App empty state", () => {
  it("points a viewer at the admin page to run a scan when there is no data", async () => {
    invoke.mockImplementation((fnName, payload) => {
      if (fnName === "getFieldInventory") return Promise.resolve(emptyFieldInventory());
      return defaultInvokeImpl(fnName, payload);
    });

    await renderApp();

    await waitFor(() => {
      expect(screen.getByText("No field data available yet.")).toBeInTheDocument();
    });
    expect(screen.getByText(/run a scan from the/i)).toBeInTheDocument();
    expect(screen.getByText("Observatory admin page")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 3. Tab navigation + read-only confirmation
// ---------------------------------------------------------------------------

describe("App tab navigation", () => {
  it("switches between Inventory, Projects, and Report tabs", async () => {
    const user = userEvent.setup();
    await renderApp();

    await waitFor(() => expect(screen.getByText("Test Field")).toBeInTheDocument());

    const tabBar = document.querySelector(".tab-bar");

    await user.click(within(tabBar).getByText("Projects"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("getProjectsView", expect.any(Object)));

    await user.click(within(tabBar).getByText("Report"));
    await waitFor(() => {
      expect(screen.getByText("Select fields, then generate a report.")).toBeInTheDocument();
    });

    await user.click(within(tabBar).getByText("Inventory"));
    await waitFor(() => expect(screen.getByText("Test Field")).toBeInTheDocument());
  });

  it("never renders scan/build controls anywhere — macro is read-only (Phase 3 stripping)", async () => {
    await renderApp();
    await waitFor(() => expect(screen.getByText("Test Field")).toBeInTheDocument());

    const tabBar = document.querySelector(".tab-bar");
    const user = userEvent.setup();

    // Check across all three tabs
    for (const tabLabel of ["Inventory", "Projects", "Report"]) {
      await user.click(within(tabBar).getByText(tabLabel));
      await waitFor(() => {}, { timeout: 50 }).catch(() => {});
      expect(screen.queryByText("Build Snapshot")).not.toBeInTheDocument();
      expect(screen.queryByText("Build new snapshot")).not.toBeInTheDocument();
      expect(screen.queryByText("Start Scan")).not.toBeInTheDocument();
      expect(screen.queryByText("Scan all issues")).not.toBeInTheDocument();
      expect(screen.queryByText("Run quick scan")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /scan/i })).not.toBeInTheDocument();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Report generation job-polling lifecycle
// ---------------------------------------------------------------------------

describe("App report generation job-polling lifecycle", () => {
  it("transitions from queued -> processing -> completed and renders the report table", async () => {
    // App fires an immediate job fetch right after startProjectUsageReportJob resolves,
    // and a second fetch via the polling useEffect once reportJobId/reportJob update —
    // so the first two polls both report "queued" to give the test a stable window to
    // observe that state before advancing to "building" and then "completed".
    let pollCount = 0;
    const queuedJob = { jobId: "job-1", reportName: "Project Usage Report", status: "queued", fieldIds: ["customfield_10001"], processedFields: 0, totalFields: 1, startedAt: null, completedAt: null, lastError: null, progressLog: [], result: { fields: [], projects: [], pendingFields: [], uniqueIssueCount: null } };
    const processingJob = { ...queuedJob, status: "building", startedAt: "2024-01-15T10:00:00Z", processedFields: 0 };
    const completedResult = {
      fields: [
        { fieldId: "customfield_10001", fieldName: "Test Field", fieldType: "text", projects: [{ projectId: "P1", projectKey: "AA", projectName: "Alpha", issueCount: 7, jql: "cf[10001] is not EMPTY" }] },
      ],
      projects: [{ projectId: "P1", projectKey: "AA", projectName: "Alpha" }],
      pendingFields: [],
      uniqueIssueCount: 7,
    };
    const completedJob = { ...queuedJob, status: "completed", completedAt: "2024-01-15T10:01:00Z", processedFields: 1, result: completedResult };

    invoke.mockImplementation((fnName, payload) => {
      if (fnName === "getFieldInventory") return Promise.resolve(makeFieldInventory());
      if (fnName === "startProjectUsageReportJob") return Promise.resolve({ jobId: "job-1" });
      if (fnName === "getProjectUsageReportJob") {
        pollCount += 1;
        if (pollCount <= 2) return Promise.resolve({ job: queuedJob });
        if (pollCount === 3) return Promise.resolve({ job: processingJob });
        return Promise.resolve({ job: completedJob });
      }
      return defaultInvokeImpl(fnName, payload);
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const localUser = userEvent.setup({ delay: null });
    render(<App />);
    await vi.waitFor(() => expect(screen.getByText("Observatory")).toBeInTheDocument());
    await vi.waitFor(() => expect(screen.getByText("Test Field")).toBeInTheDocument());

    const selectCheckbox = screen.getByRole("checkbox", { name: /select for report/i });
    await localUser.click(selectCheckbox);

    const generateBtn = screen.getByRole("button", { name: "Generate report" });
    await localUser.click(generateBtn);

    // Both initial fetches (manual + effect-triggered) resolve to "queued" — assert that state is reachable.
    await vi.waitFor(() => {
      expect(screen.getByText("queued")).toBeInTheDocument();
    });
    expect(pollCount).toBeGreaterThanOrEqual(1);

    // Advance the 2500ms poll interval to fetch "building"
    await vi.advanceTimersByTimeAsync(2600);
    await vi.waitFor(() => {
      expect(screen.getByText("building")).toBeInTheDocument();
    });

    // Advance again to fetch "completed"
    await vi.advanceTimersByTimeAsync(2600);
    await vi.waitFor(() => {
      expect(screen.getAllByText("Test Field").length).toBeGreaterThan(0);
    });

    expect(screen.queryByText("queued")).not.toBeInTheDocument();
    expect(screen.queryByText("building")).not.toBeInTheDocument();

    vi.useRealTimers();
  });

  it("renders a failed message instead of an infinite spinner when the job fails", async () => {
    const failedJob = { jobId: "job-2", reportName: "Project Usage Report", status: "failed", fieldIds: ["customfield_10001"], processedFields: 0, totalFields: 1, startedAt: "2024-01-15T10:00:00Z", completedAt: "2024-01-15T10:00:05Z", lastError: "Snapshot version mismatch", progressLog: [], result: { fields: [], projects: [], pendingFields: [], uniqueIssueCount: null } };

    invoke.mockImplementation((fnName, payload) => {
      if (fnName === "getFieldInventory") return Promise.resolve(makeFieldInventory());
      if (fnName === "startProjectUsageReportJob") return Promise.resolve({ jobId: "job-2" });
      if (fnName === "getProjectUsageReportJob") return Promise.resolve({ job: failedJob });
      return defaultInvokeImpl(fnName, payload);
    });

    const user = userEvent.setup();
    await renderApp();
    await waitFor(() => expect(screen.getByText("Test Field")).toBeInTheDocument());

    const selectCheckbox = screen.getByRole("checkbox", { name: /select for report/i });
    await user.click(selectCheckbox);

    const generateBtn = screen.getByRole("button", { name: "Generate report" });
    await user.click(generateBtn);

    // The job lands in a terminal "failed" state with no result rows. The UI must
    // resolve to a terminal message surfacing the actual failure reason rather than
    // spinning forever or showing a generic "no rows" message that hides the cause.
    await waitFor(() => {
      expect(screen.getByText(/Report generation failed: Snapshot version mismatch/)).toBeInTheDocument();
    });
    expect(screen.queryByText("No report rows were returned for the selected fields.")).not.toBeInTheDocument();
    expect(screen.queryByText("queued")).not.toBeInTheDocument();
    expect(screen.queryByText("building")).not.toBeInTheDocument();
    expect(screen.queryByText("Generating...")).not.toBeInTheDocument();
  });
});
