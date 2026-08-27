import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke, view, router, rovo } from "@forge/bridge";
import { AdminApp } from "./admin";
import { ClearSnapshotControl } from "./tabs/ScansTab";
import { AuditLogPanel } from "./components/admin/AuditLogPanel";

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
    dashboard: {
      fieldUsage: {
        totalFields: 2,
        findingsBySeverity: { high: 0, medium: 0, low: 0 },
        findingsByType: [],
        fieldTypeBreakdown: [{ type: "text", count: 2 }],
        origin: { builtin: 0, appProvided: 0, custom: 2 },
        duplicateClusters: 0,
      },
      projects: { totalProjects: 0, topByIssueVolume: [], topByFieldCount: [] },
    },
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
    case "getRqtIndex":
      return Promise.resolve({ totalUniqueIssues: 0, fieldCount: 0, uniqueValues: [] });
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
      expect(screen.getByText("Governance")).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByText("Governance")).toBeInTheDocument());

    // Field Browser
    await user.click(within(adminNav).getByText("Field Browser"));
    await waitFor(() => expect(document.querySelector(".admin-field-browser")).toBeTruthy());

    // Project Usage
    //
    // Every tab is lazily imported now, so a click has to resolve a chunk before the tab
    // mounts and its first effect runs. Under a full-suite run that occasionally exceeds
    // waitFor's default second; the assertion is unchanged, it is just given room.
    await user.click(within(adminNav).getByText("Project Usage"));
    await waitFor(
      () => expect(invoke).toHaveBeenCalledWith("getProjectsView", expect.any(Object)),
      { timeout: 5000 }
    );

    // Reports
    await user.click(within(adminNav).getByText("Reports"));
    await waitFor(() => expect(document.querySelector(".admin-reports-tab")).toBeTruthy());

    // Scans
    await user.click(within(adminNav).getByText("Scans"));
    await waitFor(() => expect(document.querySelector(".admin-scans-tab")).toBeTruthy());

    // Configuration renders through the shared SubNavLayout, like Scans. It briefly had a
    // bespoke .cfg rail; that was the same widget rebuilt a second time and is now gone.
    await user.click(within(adminNav).getByText("Configuration"));
    await waitFor(() => expect(document.querySelector(".sub-nav-layout")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Governance rules")).toBeTruthy());
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
// 2b. Scans tab -> Full Scan -- stalled snapshot build recovery
//
// The Snapshot and Universe Scan tabs were retired once Full Scan started
// sequencing the exact same builds as its own stages -- see the full/quick
// scan consolidation. What survives from the old Snapshot panel is this one
// recovery affordance, now embedded directly in the Full Scan panel: a field
// snapshot build stuck in "building" past the server's own stale threshold
// (see requeueStaleSnapshotBuild in snapshot-engine.js) would otherwise have
// no way to unstick from the UI, even though the resolver behind it already
// knows how to force it via getFieldInventory({forceRefresh:true}).
// ---------------------------------------------------------------------------

async function openScansFullScanPanel(user) {
  const adminNav = document.querySelector(".admin-nav");
  await user.click(within(adminNav).getByText("Scans"));
  await waitFor(() => expect(document.querySelector(".admin-scans-tab")).toBeTruthy());
  const subNav = document.querySelector(".sub-nav");
  await user.click(within(subNav).getByText("Full Scan"));
}

describe("AdminApp Scans tab -> Full Scan -- stalled snapshot build recovery", () => {
  it("shows no recovery button for a build that only just started", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((fnName, payload) => {
      if (fnName === "getAdminOverview") {
        return Promise.resolve(makeOverview({
          snapshot: {
            state: "building",
            refreshedAt: null,
            startedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
            completedAt: null,
            totalFields: 1516,
            processedFields: 1328,
            percent: 88,
            lastError: null,
            progressLog: [],
          },
        }));
      }
      return defaultInvokeImpl(fnName, payload);
    });

    await renderAdminApp();
    await openScansFullScanPanel(user);

    await screen.findByText("Full site scan");
    expect(screen.queryByRole("button", { name: "Force resume (stalled)" })).not.toBeInTheDocument();
  });

  it("enables a 'Force resume (stalled)' button once a build has been running past the stale threshold, and it re-triggers the build via forceRefresh", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((fnName, payload) => {
      if (fnName === "getAdminOverview") {
        return Promise.resolve(makeOverview({
          snapshot: {
            state: "building",
            refreshedAt: null,
            startedAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(), // stale (> 20 min)
            completedAt: null,
            totalFields: 1516,
            processedFields: 1328,
            percent: 88,
            lastError: null,
            progressLog: [],
          },
        }));
      }
      return defaultInvokeImpl(fnName, payload);
    });

    await renderAdminApp();
    await openScansFullScanPanel(user);

    const button = await screen.findByRole("button", { name: "Force resume (stalled)" });
    expect(button).not.toBeDisabled();

    await user.click(button);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("getFieldInventory", expect.objectContaining({ forceRefresh: true }));
    });
  });
});

describe("AdminApp Overview tab -- Snapshot and Field Usage Jobs moved out", () => {
  it("no longer renders a Snapshot or Field usage jobs section, but still routes governance findings", async () => {
    await renderAdminApp();
    await waitFor(() => expect(screen.getByText("Governance")).toBeInTheDocument());

    expect(screen.queryByRole("heading", { name: "Snapshot" })).not.toBeInTheDocument();
    expect(screen.queryByText("Field usage jobs")).not.toBeInTheDocument();
  });
});

describe("AdminApp Overview tab -- Developer Console links", () => {
  it("opens Dev Console links via router.open instead of native navigation", async () => {
    const user = userEvent.setup();
    await renderAdminApp();
    await waitFor(() => expect(screen.getByText("Governance")).toBeInTheDocument());

    await user.click(screen.getByText("App overview"));

    expect(router.open).toHaveBeenCalledWith(
      "https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/"
    );
  });
});

// ---------------------------------------------------------------------------
// 2c. Overview tab -- Recharts dashboard (Phase 2)
// ---------------------------------------------------------------------------

describe("AdminApp Overview tab -- dashboard", () => {
  it("renders the Field usage, Projects, Workflows and RQT panels from getAdminOverview", async () => {
    invoke.mockImplementation((fnName, payload) => {
      if (fnName === "getAdminOverview") {
        return Promise.resolve(makeOverview({
          dashboard: {
            fieldUsage: {
              totalFields: 42,
              findingsBySeverity: { high: 3, medium: 5, low: 1 },
              findingsByType: [{ title: "High-impact field with broad live usage", count: 3 }],
              fieldTypeBreakdown: [{ type: "text", count: 20 }, { type: "number", count: 22 }],
              origin: { builtin: 10, appProvided: 2, custom: 30 },
              duplicateClusters: 4,
            },
            projects: {
              totalProjects: 2,
              topByIssueVolume: [{ projectKey: "AAA", projectName: "Alpha", totalIssueCount: 100 }],
              topByFieldCount: [{ projectKey: "BBB", projectName: "Beta", fieldCount: 10 }],
            },
          },
        }));
      }
      if (fnName === "getRqtIndex") {
        return Promise.resolve({ totalUniqueIssues: 250, fieldCount: 6, uniqueValues: Array.from({ length: 12 }) });
      }
      return defaultInvokeImpl(fnName, payload);
    });

    await renderAdminApp();

    expect(await screen.findByRole("heading", { name: /Field usage/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Projects/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /RQT values/ })).toBeInTheDocument();

    // Severity KPI tiles
    expect(screen.getByText("High severity")).toBeInTheDocument();
    expect(screen.getByText("Duplicate-name clusters")).toBeInTheDocument();

    // RQT summary card fetched and rendered its own data
    await waitFor(() => expect(screen.getByText("250")).toBeInTheDocument());
    expect(screen.getByText("6")).toBeInTheDocument();
  });

  // The index moved out of Scans and into Reports. Scans runs and monitors jobs; every
  // other tab reads what those jobs produced, and a cross-reference over field values is
  // something you read. This dashboard link was always treating it as a report -- it just
  // used to land in the operator's tab to do it.
  it("jumps to the Reports tab's RQT subnav when 'Open RQT Index' is clicked", async () => {
    const user = userEvent.setup();
    await renderAdminApp();

    const openButton = await screen.findByRole("button", { name: /Open RQT Index/ });
    await user.click(openButton);

    await waitFor(() => expect(document.querySelector(".admin-reports-tab")).toBeTruthy());
    const subNav = document.querySelector(".sub-nav");
    expect(within(subNav).getByText("RQT traceability").closest("button")).toHaveClass("sub-nav__item--active");
  });

  it("no longer offers RQT from the Scans tab", async () => {
    const user = userEvent.setup();
    await renderAdminApp();

    const adminNav = document.querySelector(".admin-nav");
    await user.click(within(adminNav).getByText("Scans"));
    await waitFor(() => expect(document.querySelector(".admin-scans-tab")).toBeTruthy());

    const subNav = document.querySelector(".sub-nav");
    expect(within(subNav).queryByText("RQT Index")).toBeNull();
  });

  it("shows empty-state messaging for charts when there is no data yet", async () => {
    invoke.mockImplementation((fnName, payload) => {
      if (fnName === "getAdminOverview") {
        return Promise.resolve(makeOverview({
          dashboard: {
            fieldUsage: {
              totalFields: 0,
              findingsBySeverity: { high: 0, medium: 0, low: 0 },
              findingsByType: [],
              fieldTypeBreakdown: [],
              origin: { builtin: 0, appProvided: 0, custom: 0 },
              duplicateClusters: 0,
            },
            projects: { totalProjects: 0, topByIssueVolume: [], topByFieldCount: [] },
          },
        }));
      }
      return defaultInvokeImpl(fnName, payload);
    });

    await renderAdminApp();

    expect(await screen.findByText("No governance findings yet")).toBeInTheDocument();
    expect(screen.getAllByText(/No project usage data yet|No issue data yet/).length).toBeGreaterThan(0);
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

// ---------------------------------------------------------------------------
// ClearSnapshotControl
//
// The only irreversible action in the app. These tests are about the guard rails
// rather than the happy path: the button stays disabled until the confirmation
// is exact, a server-side refusal surfaces instead of being reported as success,
// and the panel says plainly what survives the delete.
// ---------------------------------------------------------------------------
describe("ClearSnapshotControl", () => {
  async function open(user) {
    await user.click(screen.getByRole("button", { name: /clear snapshot data/i }));
  }

  it("does not expose the destructive action until the admin opts in", () => {
    render(<ClearSnapshotControl />);

    expect(screen.getByRole("button", { name: /clear snapshot data/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear everything/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("keeps the clear button disabled until the confirmation matches exactly", async () => {
    const user = userEvent.setup();
    render(<ClearSnapshotControl />);
    await open(user);

    const confirmButton = screen.getByRole("button", { name: /clear everything/i });
    const input = screen.getByRole("textbox");

    expect(confirmButton).toBeDisabled();

    await user.type(input, "delete");
    expect(confirmButton).toBeDisabled();

    await user.clear(input);
    await user.type(input, "DELETE ME");
    expect(confirmButton).toBeDisabled();

    await user.clear(input);
    await user.type(input, "DELETE");
    expect(confirmButton).toBeEnabled();
  });

  it("sends the confirmation to the server and reports what was deleted", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue({ cleared: true, totalRowsDeleted: 4420, deleted: {} });
    const onCleared = vi.fn();

    render(<ClearSnapshotControl onCleared={onCleared} />);
    await open(user);
    await user.type(screen.getByRole("textbox"), "DELETE");
    await user.click(screen.getByRole("button", { name: /clear everything/i }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("clearSnapshot", { confirmation: "DELETE" });
    });
    expect(await screen.findByText(/4,420 rows removed/i)).toBeInTheDocument();
    expect(onCleared).toHaveBeenCalled();
  });

  it("surfaces a server-side refusal instead of claiming success", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue({ cleared: false, error: "Read-only mode is enabled." });

    render(<ClearSnapshotControl />);
    await open(user);
    await user.type(screen.getByRole("textbox"), "DELETE");
    await user.click(screen.getByRole("button", { name: /clear everything/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/read-only mode/i);
    expect(screen.queryByText(/rows removed/i)).not.toBeInTheDocument();
  });

  it("surfaces a thrown error rather than failing silently", async () => {
    const user = userEvent.setup();
    invoke.mockRejectedValue(new Error("network down"));

    render(<ClearSnapshotControl />);
    await open(user);
    await user.type(screen.getByRole("textbox"), "DELETE");
    await user.click(screen.getByRole("button", { name: /clear everything/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/network down/i);
  });

  it("cancelling closes the panel without invoking anything", async () => {
    const user = userEvent.setup();
    render(<ClearSnapshotControl />);
    await open(user);

    await user.type(screen.getByRole("textbox"), "DELETE");
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(invoke).not.toHaveBeenCalledWith("clearSnapshot", expect.anything());
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("discards a previously typed confirmation when reopened", async () => {
    const user = userEvent.setup();
    render(<ClearSnapshotControl />);

    await open(user);
    await user.type(screen.getByRole("textbox"), "DELETE");
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    await open(user);

    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("button", { name: /clear everything/i })).toBeDisabled();
  });

  it("states what the clear does not destroy", async () => {
    const user = userEvent.setup();
    render(<ClearSnapshotControl />);
    await open(user);

    expect(screen.getByText(/saved reports, workflow data and the RQT index are not affected/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AuditLogPanel
// ---------------------------------------------------------------------------
describe("AuditLogPanel", () => {
  const EVENTS = [
    { at: "2026-07-31T10:00:00Z", actorId: "acct-1", action: "clearSnapshot", outcome: "allowed", detail: null },
    { at: "2026-07-31T09:00:00Z", actorId: "acct-9", action: "startIssueScan", outcome: "denied", detail: "Caller does not hold Jira ADMINISTER permission" },
    { at: "2026-07-31T08:00:00Z", actorId: "acct-1", action: "saveAdminConfig", outcome: "failed", detail: "sql exploded" },
  ];

  it("does not query until asked, since SQL requests are the binding quota", () => {
    render(<AuditLogPanel />);
    expect(invoke).not.toHaveBeenCalledWith("getAuditLog", expect.anything());
    expect(screen.getByRole("button", { name: /load audit log/i })).toBeInTheDocument();
  });

  it("loads and renders events", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue({ events: EVENTS, limit: 200 });

    render(<AuditLogPanel />);
    await user.click(screen.getByRole("button", { name: /load audit log/i }));

    expect(await screen.findByText("clearSnapshot")).toBeInTheDocument();
    expect(screen.getByText("startIssueScan")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("getAuditLog", { limit: 200 });
  });

  // A denial means someone reached an admin resolver without admin permission.
  // Leaving that buried in a 200-row table defeats the point of recording it.
  it("surfaces permission denials above the table", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue({ events: EVENTS });

    render(<AuditLogPanel />);
    await user.click(screen.getByRole("button", { name: /load audit log/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/1 permission denial/i);
  });

  it("does not warn when there are no denials", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue({ events: [EVENTS[0]] });

    render(<AuditLogPanel />);
    await user.click(screen.getByRole("button", { name: /load audit log/i }));

    await screen.findByText("clearSnapshot");
    // Queried by role, not by text: the panel's own hint copy mentions "permission
    // denials", so a text match here passes whether or not the alert rendered.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("filters by outcome", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue({ events: EVENTS });

    render(<AuditLogPanel />);
    await user.click(screen.getByRole("button", { name: /load audit log/i }));
    await screen.findByText("clearSnapshot");

    await user.click(screen.getByRole("button", { name: "Denied" }));

    expect(screen.getByText("startIssueScan")).toBeInTheDocument();
    expect(screen.queryByText("clearSnapshot")).not.toBeInTheDocument();
  });

  it("shows an empty state rather than a blank panel", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue({ events: [] });

    render(<AuditLogPanel />);
    await user.click(screen.getByRole("button", { name: /load audit log/i }));

    expect(await screen.findByText(/no audit events recorded yet/i)).toBeInTheDocument();
  });

  it("surfaces a load failure instead of failing silently", async () => {
    const user = userEvent.setup();
    invoke.mockRejectedValue(new Error("permission denied"));

    render(<AuditLogPanel />);
    await user.click(screen.getByRole("button", { name: /load audit log/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/permission denied/i);
  });
});

// ---------------------------------------------------------------------------
// Ask Rovo — prompt construction at the call site
//
// buildFieldRovoPrompt(field, details) and buildProjectRovoPrompt(field, details,
// project) take POSITIONAL arguments, while buildReportRovoPrompt in the same
// module takes a destructured object. admin.jsx passed wrapper objects to the
// first two, so every prompt read "Field id: undefined. Field name: undefined"
// with all counts zeroed, and Rovo answered confidently about a field that did
// not exist.
//
// The unit tests for those builders all passed, because they call them
// correctly. Only a test at the call site catches this, which is what these are.
// ---------------------------------------------------------------------------
describe("Ask Rovo prompts", () => {
  const FIELD = makeField({
    id: "customfield_11322",
    name: "CAE Program",
    type: "select",
    activeProjectCount: 125,
    totalIssueCount: 312054,
  });

  function withFieldOpen() {
    invoke.mockImplementation((fnName, payload) => {
      if (fnName === "getFieldInventory") {
        return Promise.resolve(makeFieldInventory({ fields: [FIELD], total: 1 }));
      }
      if (fnName === "getFieldDetails") {
        // Mirrors the real getFieldDetails response shape -- `projects`, not
        // `activeProjects`, and `projectUsage*` rather than `usage*`. FieldCard reads
        // details.projects.length unguarded, so a wrong-shaped fixture crashes the
        // component rather than failing an assertion.
        return Promise.resolve({
          refreshedAt: "2026-07-31T10:00:00Z",
          field: FIELD,
          fieldJql: "cf[11322] is not EMPTY",
          findings: null,
          totalIssueCount: 312054,
          activeProjectCount: 125,
          contexts: [],
          projects: [
            { projectKey: "CAV", projectName: "CAVPSE", issueCount: 57709, jql: 'project = "CAV"' },
          ],
          projectUsagePage: 1,
          projectUsageTotalPages: 1,
          progressLog: [],
        });
      }
      return defaultInvokeImpl(fnName, payload);
    });
  }

  async function openTheField(user) {
    const adminNav = document.querySelector(".admin-nav");
    await user.click(within(adminNav).getByText("Field Browser"));
    await screen.findByText("CAE Program");
    await user.click(screen.getByText("CAE Program"));
  }

  it("sends the field's real identity, not undefined", async () => {
    const user = userEvent.setup();
    withFieldOpen();
    await renderAdminApp();
    await openTheField(user);

    const askButtons = await screen.findAllByRole("button", { name: /ask rovo/i });
    await user.click(askButtons[0]);

    await waitFor(() => expect(rovo.open).toHaveBeenCalled());
    const { prompt } = rovo.open.mock.calls[0][0];

    expect(prompt).toContain("customfield_11322");
    expect(prompt).toContain("CAE Program");
    expect(prompt).not.toContain("undefined");
  });

  it("sends real usage numbers rather than zeroes", async () => {
    const user = userEvent.setup();
    withFieldOpen();
    await renderAdminApp();
    await openTheField(user);

    const askButtons = await screen.findAllByRole("button", { name: /ask rovo/i });
    await user.click(askButtons[0]);

    await waitFor(() => expect(rovo.open).toHaveBeenCalled());
    const { prompt } = rovo.open.mock.calls[0][0];

    expect(prompt).toContain("312054");
    expect(prompt).toContain("125");
    expect(prompt).not.toMatch(/Total issues with populated values: 0\./);
  });
});
