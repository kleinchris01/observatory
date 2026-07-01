import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke, view } from "@forge/bridge";
import { AdminApp } from "./admin";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOverview(overrides = {}) {
  return {
    config: { readOnlyMode: false, apiConcurrency: 4, autoSnapshotEnabled: false, autoSnapshotFrequency: "weekly", governanceThresholds: {}, macroAccess: { restrictAccess: false, allowedGroups: [] } },
    snapshot: {
      state: "ready",
      refreshedAt: "2024-01-15T10:00:00Z",
      startedAt: null,
      completedAt: "2024-01-15T10:00:00Z",
      totalFields: 2,
      processedFields: 2,
      percent: 100,
      lastError: null,
      progressLog: [],
    },
    jobCounts: { queued: 0, building: 0, ready: 2, failed: 0, cancelled: 0, unbuilt: 0 },
    findingsSummary: { adminAttention: 0, risky: 0, cleanup: 0, standardize: 0 },
    totalSummaries: 2,
    legacySummaryCount: 0,
    ...overrides,
  };
}

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
    pageSize: 25,
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

// Default mock implementation covering every resolver call AdminApp's tabs make
// on mount / first visit, returning empty-but-valid shapes.
function defaultInvokeImpl(fnName, payload) {
  switch (fnName) {
    case "getAdminOverview":
      return Promise.resolve(makeOverview());
    case "getFieldInventory":
      return Promise.resolve(makeFieldInventory());
    case "getFilteredFieldIds":
      return Promise.resolve({ fieldIds: [] });
    case "getFieldDetails":
      return Promise.resolve({ field: null, findings: null, totalIssueCount: 0, activeProjectCount: 0, activeProjects: [], usagePage: 1, usageTotalPages: 1 });
    case "getProjectUsageJobs":
      return Promise.resolve({ jobs: [] });
    case "getSavedReports":
      return Promise.resolve({ reports: [] });
    case "getProjectUsageReport":
      return Promise.resolve({ fields: [], projects: [], pendingFields: [], uniqueIssueCount: null });
    case "startProjectUsageReportJob":
      return Promise.resolve({ jobId: "job-1" });
    case "getProjectUsageReportJob":
      return Promise.resolve({ job: null });
    case "getProjectsView":
      return Promise.resolve({ projects: [], fields: [], selectedProject: null, totalPages: 1 });
    case "getIssueScanStatus":
      return Promise.resolve({ meta: null });
    case "getDeltaIssueScanStatus":
      return Promise.resolve({ meta: null });
    default:
      return Promise.resolve({});
  }
}

async function renderAdminApp() {
  const utils = render(<AdminApp />);
  // Let initial effects (loadOverview, view.getContext) settle.
  await screen.findByText("Observatory");
  return utils;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  invoke.mockImplementation(defaultInvokeImpl);
  view.getContext.mockResolvedValue({ siteUrl: "https://example.atlassian.net", extension: { type: "jira:adminPage" } });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. Smoke test
// ---------------------------------------------------------------------------

describe("AdminApp smoke test", () => {
  it("renders without crashing with mocked invoke returning default data", async () => {
    await renderAdminApp();
    expect(screen.getByText("Observatory")).toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();
    // Overview tab is the default active tab
    await waitFor(() => {
      expect(screen.getByText("Snapshot")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Tab navigation
// ---------------------------------------------------------------------------

describe("AdminApp tab navigation", () => {
  it("switches the visible panel when each tab button is clicked", async () => {
    const user = userEvent.setup();
    await renderAdminApp();

    const adminNav = document.querySelector(".admin-nav");
    expect(adminNav).toBeTruthy();

    // Overview is default
    await waitFor(() => expect(screen.getByText("Governance findings")).toBeInTheDocument());

    // Field Browser
    await user.click(within(adminNav).getByText("Field Browser"));
    await waitFor(() => expect(document.querySelector(".admin-field-browser")).toBeTruthy());

    // Project Usage
    await user.click(within(adminNav).getByText("Project Usage"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("getProjectsView", expect.any(Object)));

    // Reports
    await user.click(within(adminNav).getByText("Reports"));
    await waitFor(() => expect(document.querySelector(".admin-reports-tab")).toBeTruthy());

    // Scans
    await user.click(within(adminNav).getByText("Scans"));
    await waitFor(() => expect(document.querySelector(".admin-scans-tab")).toBeTruthy());

    // Configuration
    await user.click(within(adminNav).getByText("Configuration"));
    await waitFor(() => expect(document.querySelector(".admin-config-tab")).toBeTruthy());
  });

  it("marks the active tab button with the active class", async () => {
    const user = userEvent.setup();
    await renderAdminApp();
    const adminNav = document.querySelector(".admin-nav");

    const overviewBtn = within(adminNav).getByText("Overview").closest("button");
    expect(overviewBtn).toHaveClass("admin-nav__item--active");

    const fieldsBtn = within(adminNav).getByText("Field Browser").closest("button");
    await user.click(fieldsBtn);
    expect(fieldsBtn).toHaveClass("admin-nav__item--active");
    expect(overviewBtn).not.toHaveClass("admin-nav__item--active");
  });
});

// ---------------------------------------------------------------------------
// 3. Field Browser -> Reports auto-generate flow
// ---------------------------------------------------------------------------

describe("AdminApp field browser -> reports auto-generate flow", () => {
  it("navigates to Reports and auto-generates the report exactly once via pendingReportGenerate", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((fnName, payload) => {
      if (fnName === "getFilteredFieldIds") {
        return Promise.resolve({ fieldIds: ["customfield_10001", "customfield_10002"] });
      }
      if (fnName === "getProjectUsageReport") {
        return Promise.resolve({
          fields: [
            { fieldId: "customfield_10001", fieldName: "Field A", fieldType: "text", projects: [] },
            { fieldId: "customfield_10002", fieldName: "Field B", fieldType: "text", projects: [] },
          ],
          projects: [],
          pendingFields: [],
          uniqueIssueCount: null,
        });
      }
      return defaultInvokeImpl(fnName, payload);
    });

    await renderAdminApp();
    const adminNav = document.querySelector(".admin-nav");

    await user.click(within(adminNav).getByText("Field Browser"));
    await waitFor(() => expect(document.querySelector(".admin-field-browser")).toBeTruthy());
    // Wait for field list to settle
    await waitFor(() => expect(screen.getByText("Test Field")).toBeInTheDocument());

    const selectFilteredBtn = screen.getByRole("button", { name: "Select filtered" });
    await user.click(selectFilteredBtn);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("getFilteredFieldIds", expect.any(Object));
    });

    const generateBtn = await screen.findByRole("button", { name: /Generate report \(2\)/ });
    await user.click(generateBtn);

    // Reports tab should become active
    await waitFor(() => {
      const reportsBtn = within(adminNav).getByText("Reports").closest("button");
      expect(reportsBtn).toHaveClass("admin-nav__item--active");
    });

    // Auto-generate should have fired getProjectUsageReport with the selected field ids
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("getProjectUsageReport", { fieldIds: ["customfield_10001", "customfield_10002"] });
    });

    const callCountAfterAuto = invoke.mock.calls.filter((c) => c[0] === "getProjectUsageReport").length;
    expect(callCountAfterAuto).toBe(1);

    // Switching away and back to Reports must NOT re-trigger auto-generate (onAutoGenerateConsumed reset)
    await user.click(within(adminNav).getByText("Field Browser"));
    await waitFor(() => expect(document.querySelector(".admin-field-browser")).toBeTruthy());
    await user.click(within(adminNav).getByText("Reports"));
    await waitFor(() => expect(document.querySelector(".admin-reports-tab")).toBeTruthy());

    const callCountAfterRevisit = invoke.mock.calls.filter((c) => c[0] === "getProjectUsageReport").length;
    expect(callCountAfterRevisit).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Report job polling lifecycle (via ReportsTab.generateReport, which calls
//    getProjectUsageReport directly rather than the job-polling endpoints —
//    admin.jsx's ReportsTab is synchronous/non-job-based; the job-polling
//    pattern lives in main.jsx's App. We still verify the loading -> success
//    and loading -> error transitions here.)
// ---------------------------------------------------------------------------

describe("AdminApp Reports tab generate lifecycle", () => {
  it("shows a building state while loading then renders the completed report table", async () => {
    const user = userEvent.setup();
    let resolveReport;
    const reportPromise = new Promise((resolve) => { resolveReport = resolve; });

    invoke.mockImplementation((fnName, payload) => {
      if (fnName === "getFilteredFieldIds") {
        return Promise.resolve({ fieldIds: ["customfield_10001"] });
      }
      if (fnName === "getProjectUsageReport") {
        return reportPromise;
      }
      return defaultInvokeImpl(fnName, payload);
    });

    await renderAdminApp();
    const adminNav = document.querySelector(".admin-nav");

    await user.click(within(adminNav).getByText("Field Browser"));
    await waitFor(() => expect(screen.getByText("Test Field")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Select filtered" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("getFilteredFieldIds", expect.any(Object)));

    const generateBtn = await screen.findByRole("button", { name: /Generate report \(1\)/ });
    await user.click(generateBtn);

    await waitFor(() => {
      const reportsBtn = within(adminNav).getByText("Reports").closest("button");
      expect(reportsBtn).toHaveClass("admin-nav__item--active");
    });

    // While the report promise is pending, the building state should show
    await waitFor(() => {
      expect(screen.getByText("building")).toBeInTheDocument();
    });

    resolveReport({
      fields: [
        { fieldId: "customfield_10001", fieldName: "Test Field", fieldType: "text", projects: [{ projectId: "P1", projectKey: "AA", projectName: "Alpha", issueCount: 5, jql: "cf[10001] is not EMPTY" }] },
      ],
      projects: [{ projectId: "P1", projectKey: "AA", projectName: "Alpha" }],
      pendingFields: [],
      uniqueIssueCount: 5,
    });

    await waitFor(() => {
      expect(screen.getAllByText("Test Field").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("building")).not.toBeInTheDocument();
  });

  it("shows an error message instead of an infinite spinner when report generation fails", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((fnName, payload) => {
      if (fnName === "getFilteredFieldIds") {
        return Promise.resolve({ fieldIds: ["customfield_10001"] });
      }
      if (fnName === "getProjectUsageReport") {
        return Promise.reject(new Error("Report generation failed"));
      }
      return defaultInvokeImpl(fnName, payload);
    });

    await renderAdminApp();
    const adminNav = document.querySelector(".admin-nav");

    await user.click(within(adminNav).getByText("Field Browser"));
    await waitFor(() => expect(screen.getByText("Test Field")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Select filtered" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("getFilteredFieldIds", expect.any(Object)));

    const generateBtn = await screen.findByRole("button", { name: /Generate report \(1\)/ });
    await user.click(generateBtn);

    await waitFor(() => {
      expect(screen.getByText("Report generation failed")).toBeInTheDocument();
    });
    // No stuck "Generating..." button state
    expect(screen.queryByRole("button", { name: "Generating…" })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 5. Select All Filtered
// ---------------------------------------------------------------------------

describe("AdminApp Field Browser select-all-filtered", () => {
  it("calls getFilteredFieldIds with the current filter state and populates selectedFieldIds", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((fnName, payload) => {
      if (fnName === "getFilteredFieldIds") {
        return Promise.resolve({ fieldIds: ["customfield_10001"] });
      }
      return defaultInvokeImpl(fnName, payload);
    });

    await renderAdminApp();
    const adminNav = document.querySelector(".admin-nav");
    await user.click(within(adminNav).getByText("Field Browser"));
    await waitFor(() => expect(screen.getByText("Test Field")).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText("Field name, ID, or description…");
    await user.type(searchInput, "alpha");

    // Wait for the debounce (350ms) to flush the query into the invoke call
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("getFieldInventory", expect.objectContaining({ query: "alpha" }));
    }, { timeout: 2000 });

    await user.click(screen.getByRole("button", { name: "Select filtered" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("getFilteredFieldIds", expect.objectContaining({
        query: "alpha",
        type: "all",
        fieldOrigin: "all",
        findingsFilter: "all",
        sortBy: "usage-desc",
      }));
    });

    // selectedFieldIds populated -> report bar shows "1 field selected for report"
    await waitFor(() => {
      expect(screen.getByText("1 field selected for report")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Field Browser advanced filter panel
// ---------------------------------------------------------------------------

async function goToFieldBrowser(user) {
  await renderAdminApp();
  const adminNav = document.querySelector(".admin-nav");
  await user.click(within(adminNav).getByText("Field Browser"));
  await waitFor(() => expect(screen.getByText("Test Field")).toBeInTheDocument());
}

describe("AdminApp Field Browser advanced filter panel", () => {
  it("toggles the filters panel open and closed when the Filters button is clicked", async () => {
    const user = userEvent.setup();
    await goToFieldBrowser(user);

    expect(document.querySelector(".admin-field-browser__filter-panel")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    expect(document.querySelector(".admin-field-browser__filter-panel")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    expect(document.querySelector(".admin-field-browser__filter-panel")).not.toBeInTheDocument();
  });

  it("sends minIssuesWithValue/maxIssuesWithValue to getFieldInventory after the debounce", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ delay: null });
    await goToFieldBrowser(user);

    await user.click(screen.getByRole("button", { name: /^Filters/ }));

    const minInput = screen.getByLabelText("Minimum issues with value");
    const maxInput = screen.getByLabelText("Maximum issues with value");
    await user.type(minInput, "5");
    await user.type(maxInput, "50");

    await vi.advanceTimersByTimeAsync(400);

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("getFieldInventory", expect.objectContaining({
        minIssuesWithValue: "5",
        maxIssuesWithValue: "50",
      }));
    });

    vi.useRealTimers();
  });

  it("shows the active filter count badge when multiple filters are set", async () => {
    const user = userEvent.setup();
    await goToFieldBrowser(user);

    await user.click(screen.getByRole("button", { name: /^Filters/ }));

    await user.selectOptions(screen.getByLabelText("Field origin"), "user-created");
    await user.selectOptions(screen.getByLabelText("Project usage build status"), "built");
    await user.click(screen.getByText("Duplicate names only"));

    await waitFor(() => {
      const toggle = screen.getByRole("button", { name: /^Filters/ });
      expect(within(toggle).getByText("3")).toBeInTheDocument();
    });
  });

  it("Clear all resets filters and hides the active filter count badge", async () => {
    const user = userEvent.setup();
    await goToFieldBrowser(user);

    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    await user.selectOptions(screen.getByLabelText("Field origin"), "user-created");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Clear all" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Clear all" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
    });

    // Reopen the panel to verify the select was reset (panel closes after Clear all due to click-outside)
    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    await waitFor(() => {
      expect(screen.getByLabelText("Field origin")).toHaveValue("all");
    });
  });
});
