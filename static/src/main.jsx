import React from "react";
import ReactDOM from "react-dom/client";
import { invoke, rovo, view } from "@forge/bridge";
import "./styles.css";
import { formatNumber, formatRelativeTime, normalizeSiteOrigin, buildJiraSearchUrl, downloadCsv, slugifyFilenamePart, normalizeReportData, groupReportFieldsByType, mergeFieldMetrics, openFieldExpertRovo, buildInventoryRovoPrompt, buildFieldRovoPrompt, buildProjectRovoPrompt, buildReportRovoPrompt } from "./utils";
import { Icon } from "./components/Icons";
import { ReportErrorBoundary, ProjectUsageReportView } from "./components/ReportView";
import { SkeletonFieldCard, FieldCard } from "./components/FieldCard";

// Lazy: ProjectsTab pulls in recharts, which nearly doubles this macro's JS
// payload (measured: +122KB gzip). The macro defaults to the "inventory" tab,
// so most page views never touch Projects/charts at all -- loading recharts
// eagerly on every Confluence page view for a tab most visits never open isn't
// worth it. Split into its own chunk, fetched only when the tab is opened.
const ProjectsTabView = React.lazy(() =>
  import("./components/ProjectsTab").then((m) => ({ default: m.ProjectsTabView }))
);

const bootStatusNode = document.getElementById("boot-status");
const PROJECT_USAGE_PAGE_SIZE = 12;

if (bootStatusNode) {
  bootStatusNode.textContent = "Starting React application...";
}



export function App() {
  const [inventoryFields, setInventoryFields] = React.useState([]);
  const [availableTypes, setAvailableTypes] = React.useState([]);
  const [query, setQuery] = React.useState("");
  const [debouncedQuery, setDebouncedQuery] = React.useState("");
  const [optionQuery, setOptionQuery] = React.useState("");
  const [debouncedOptionQuery, setDebouncedOptionQuery] = React.useState("");
  const [optionSearchFieldIds, setOptionSearchFieldIds] = React.useState(null);
  const [optionSearchStatus, setOptionSearchStatus] = React.useState(null);
  const [typeFilter, setTypeFilter] = React.useState("all");
  const [fieldOrigin, setFieldOrigin] = React.useState("all");
  const [projectUsageFilter, setProjectUsageFilter] = React.useState("all");
  const [minIssuesWithValue, setMinIssuesWithValue] = React.useState("");
  const [maxIssuesWithValue, setMaxIssuesWithValue] = React.useState("");
  const [pageSize, setPageSize] = React.useState(() => {
    const saved = Number(localStorage.getItem("atlasiq-field-pagesize"));
    return [10, 25, 50].includes(saved) ? saved : 10;
  });
  const [sortBy, setSortBy] = React.useState("name-asc");
  const [theme, setTheme] = React.useState(() => localStorage.getItem("atlasiq-field-theme") || "dark");
  const [zoomLevel, setZoomLevel] = React.useState(() => {
    const raw = Number(localStorage.getItem("atlasiq-field-zoom") || 100);
    return Number.isFinite(raw) ? Math.max(80, Math.min(130, raw)) : 100;
  });
  const [currentPage, setCurrentPage] = React.useState(1);
  const [totalPages, setTotalPages] = React.useState(1);
  const [totalFields, setTotalFields] = React.useState(0);
  const [expandedFieldId, setExpandedFieldId] = React.useState(null);
  const [detailsByFieldId, setDetailsByFieldId] = React.useState({});
  const [loadingInventory, setLoadingInventory] = React.useState(true);
  const [loadingDetailFieldId, setLoadingDetailFieldId] = React.useState(null);
  const [error, setError] = React.useState("");
  const [refreshedAt, setRefreshedAt] = React.useState(null);
  const [siteOrigin, setSiteOrigin] = React.useState("");
  const [rovoEnabled, setRovoEnabled] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState("inventory");
  const [selectedFieldIds, setSelectedFieldIds] = React.useState([]);
  const [reportData, setReportData] = React.useState(null);
  const [loadingReport, setLoadingReport] = React.useState(false);
  const [reportJobId, setReportJobId] = React.useState("");
  const [reportJob, setReportJob] = React.useState(null);
  const [savedReports, setSavedReports] = React.useState([]);
  const [reportNameInput, setReportNameInput] = React.useState("");
  const [activeReportName, setActiveReportName] = React.useState("");
  const [savingReport, setSavingReport] = React.useState(false);
  const [deletingReportId, setDeletingReportId] = React.useState("");
  const [projectsViewData, setProjectsViewData] = React.useState(null);
  const [loadingProjectsView, setLoadingProjectsView] = React.useState(false);
  const [selectedProjectId, setSelectedProjectId] = React.useState("");
  const [projectTabProjectQuery, setProjectTabProjectQuery] = React.useState("");
  const [projectTabFieldQuery, setProjectTabFieldQuery] = React.useState("");
  const [projectTabFieldType, setProjectTabFieldType] = React.useState("all");
  const [projectTabFieldSort, setProjectTabFieldSort] = React.useState("issues-desc");
  const [projectTabPage, setProjectTabPage] = React.useState(1);
  const [accessCheck, setAccessCheck] = React.useState(null);
  const detailsRef = React.useRef(detailsByFieldId);
  const latestInventoryRequestRef = React.useRef(0);

  React.useEffect(() => {
    detailsRef.current = detailsByFieldId;
  }, [detailsByFieldId]);

  React.useEffect(() => {
    try { view.setAutoResizing(true); } catch {}
  }, []);

  React.useEffect(() => {
    invoke("checkMacroAccess")
      .then((result) => setAccessCheck(result || { allowed: true }))
      .catch(() => setAccessCheck({ allowed: true }));
  }, []);

  React.useEffect(() => {
    fetchSavedReports();
  }, []);

  React.useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(query), 250);
    return () => window.clearTimeout(handle);
  }, [query]);

  React.useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedOptionQuery(optionQuery), 350);
    return () => window.clearTimeout(handle);
  }, [optionQuery]);

  React.useEffect(() => {
    let cancelled = false;

    async function loadSiteOrigin() {
      try {
        const context = await view.getContext();
        const resolvedOrigin = normalizeSiteOrigin(
          context?.siteUrl ||
          context?.extension?.siteUrl ||
          context?.extensionContext?.siteUrl
        );

        if (!cancelled && resolvedOrigin) {
          setSiteOrigin(resolvedOrigin);
        }
      } catch {
        // Leave link targets disabled if the site URL cannot be resolved.
      }
    }

    loadSiteOrigin();

    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    const q = debouncedOptionQuery.trim();
    setOptionSearchFieldIds(null);
    setOptionSearchStatus(q ? { state: "done", query: q } : null);
  }, [debouncedOptionQuery]);

  React.useEffect(() => {
    let cancelled = false;

    async function checkRovo() {
      try {
        const enabled = await rovo.isEnabled();
        if (!cancelled) {
          setRovoEnabled(Boolean(enabled));
        }
      } catch {
        if (!cancelled) {
          setRovoEnabled(false);
        }
      }
    }

    checkRovo();

    return () => {
      cancelled = true;
    };
  }, []);

  const hasActiveFilters =
    debouncedQuery !== "" ||
    debouncedOptionQuery !== "" ||
    typeFilter !== "all" ||
    fieldOrigin !== "all" ||
    projectUsageFilter !== "all" ||
    String(minIssuesWithValue).trim() !== "" ||
    String(maxIssuesWithValue).trim() !== "";

  function clearFilters() {
    setQuery("");
    setDebouncedQuery("");
    setOptionQuery("");
    setDebouncedOptionQuery("");
    setTypeFilter("all");
    setFieldOrigin("all");
    setProjectUsageFilter("all");
    setMinIssuesWithValue("");
    setMaxIssuesWithValue("");
    setCurrentPage(1);
  }

  const fetchInventory = React.useCallback(async ({ forceRefresh = false, page = 1, silent = false } = {}) => {
    const requestId = latestInventoryRequestRef.current + 1;
    latestInventoryRequestRef.current = requestId;

    if (!silent) setLoadingInventory(true);
    setError("");

    try {
      const result = await invoke("getFieldInventory", {
        forceRefresh,
        page,
        pageSize,
        query: debouncedQuery,
        optionQuery: debouncedOptionQuery,
        type: typeFilter,
        fieldOrigin,
        projectUsageFilter,
        minIssuesWithValue,
        maxIssuesWithValue,
        sortBy,
      });

      if (latestInventoryRequestRef.current !== requestId) {
        return;
      }

      setInventoryFields((current) => {
        const currentMap = new Map(current.map((field) => [field.id, field]));
        return (result.fields || []).map((field) => {
          const mergedWithCurrent = mergeFieldMetrics(field, currentMap.get(field.id));
          return mergeFieldMetrics(mergedWithCurrent, detailsRef.current[field.id]);
        });
      });
      setAvailableTypes(result.availableTypes || []);
      setRefreshedAt(result.refreshedAt || null);
      setTotalFields(result.total || 0);
      setTotalPages(result.totalPages || 1);
      setCurrentPage(result.page || page);
      if (forceRefresh) {
        setExpandedFieldId(null);
        setDetailsByFieldId({});
      }
    } catch (err) {
      if (latestInventoryRequestRef.current !== requestId) {
        return;
      }
      setError(err.message || "Failed to load custom fields.");
    } finally {
      if (!silent && latestInventoryRequestRef.current === requestId) {
        setLoadingInventory(false);
      }
    }
  }, [debouncedQuery, debouncedOptionQuery, fieldOrigin, projectUsageFilter, minIssuesWithValue, maxIssuesWithValue, sortBy, typeFilter, pageSize]);

  async function fetchSavedReports() {
    try {
      const result = await invoke("getSavedReports");
      setSavedReports(result.reports || []);
    } catch (err) {
      setError(err.message || "Failed to load saved reports.");
    }
  }

  const fetchReportJob = React.useCallback(async (jobIdOverride = "") => {
    const targetJobId = String(jobIdOverride || reportJobId || "").trim();
    if (!targetJobId) {
      return;
    }
    try {
      const result = await invoke("getProjectUsageReportJob", { jobId: targetJobId });
      const nextJob = result?.job || null;
      setReportJob(nextJob);
      if (nextJob?.result) {
        setReportData(normalizeReportData(nextJob.result));
      }
    } catch (err) {
      setError(err.message || "Failed to load report job status.");
    }
  }, [reportJobId]);

  const fetchProjectsView = React.useCallback(async () => {
    if (activeTab !== "projects") {
      return;
    }

    setLoadingProjectsView(true);
    try {
      const result = await invoke("getProjectsView", {
        projectId: selectedProjectId,
        projectQuery: projectTabProjectQuery,
        fieldQuery: projectTabFieldQuery,
        fieldType: projectTabFieldType,
        sortBy: projectTabFieldSort,
        page: projectTabPage,
      });
      setProjectsViewData(result);
      if (result?.selectedProject?.projectId && result.selectedProject.projectId !== selectedProjectId) {
        setSelectedProjectId(result.selectedProject.projectId);
      }
    } catch (err) {
      setError(err.message || "Failed to load the projects view.");
    } finally {
      setLoadingProjectsView(false);
    }
  }, [
    activeTab,
    selectedProjectId,
    projectTabProjectQuery,
    projectTabFieldQuery,
    projectTabFieldType,
    projectTabFieldSort,
    projectTabPage,
  ]);


  React.useEffect(() => {
    fetchInventory({ page: currentPage });
  }, [fetchInventory, currentPage]);

  React.useEffect(() => {
    fetchReportJob();
  }, [fetchReportJob]);

  React.useEffect(() => {
    fetchProjectsView();
  }, [fetchProjectsView]);

  React.useEffect(() => {
    if (activeTab !== "report" || !reportJobId || !reportJob || (reportJob.status !== "queued" && reportJob.status !== "building")) {
      return undefined;
    }

    const handle = window.setInterval(() => {
      fetchReportJob(reportJobId);
    }, 2500);

    return () => window.clearInterval(handle);
  }, [activeTab, reportJobId, reportJob, fetchReportJob]);


  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("atlasiq-field-theme", theme);
  }, [theme]);

  React.useEffect(() => {
    localStorage.setItem("atlasiq-field-zoom", String(zoomLevel));
  }, [zoomLevel]);

  React.useEffect(() => {
    function handleFindShortcut(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        const input = document.querySelector("[data-search-input='primary']");
        if (!input) return;
        e.preventDefault();
        input.focus();
        input.select();
      }
    }
    window.addEventListener("keydown", handleFindShortcut);
    return () => window.removeEventListener("keydown", handleFindShortcut);
  }, []);

  React.useEffect(() => {
    setCurrentPage(1);
  }, [debouncedQuery, debouncedOptionQuery, fieldOrigin, projectUsageFilter, minIssuesWithValue, maxIssuesWithValue, typeFilter, sortBy, pageSize]);

  React.useEffect(() => {
    setProjectTabPage(1);
  }, [selectedProjectId, projectTabFieldQuery, projectTabFieldType, projectTabFieldSort]);

  async function loadFieldDetails(fieldId, usagePage = 1, { silent = false } = {}) {
    if (!silent) {
      setLoadingDetailFieldId(fieldId);
    }
    try {
      const details = await invoke("getFieldDetails", {
        fieldId,
        usagePage,
        usagePageSize: PROJECT_USAGE_PAGE_SIZE,
      });
      setDetailsByFieldId((current) => ({ ...current, [fieldId]: details }));
      setInventoryFields((current) =>
        current.map((field) => (field.id === fieldId ? mergeFieldMetrics(field, details) : field))
      );
    } catch (err) {
      setError(err.message || `Failed to load details for ${fieldId}.`);
    } finally {
      if (!silent) {
        setLoadingDetailFieldId(null);
      }
    }
  }

  async function toggleField(fieldId) {
    const nextExpanded = expandedFieldId === fieldId ? null : fieldId;
    setExpandedFieldId(nextExpanded);

    if (!nextExpanded || detailsByFieldId[fieldId]) return;

    await loadFieldDetails(fieldId, 1);
  }

  async function changeProjectUsagePage(fieldId, usagePage) {
    await loadFieldDetails(fieldId, usagePage);
  }

  async function refreshProjectUsage(fieldId, usagePage) {
    await loadFieldDetails(fieldId, usagePage, { silent: true });
  }

  const summary = React.useMemo(() => {
    return {
      totalFields,
    };
  }, [totalFields]);
  const compactLayout = totalFields > 0 && totalFields < pageSize;
  const visibleInventoryFields = optionSearchFieldIds instanceof Set
    ? inventoryFields.filter((field) => optionSearchFieldIds.has(field.id))
    : inventoryFields;
  const visibleTotalFields = optionSearchFieldIds instanceof Set ? visibleInventoryFields.length : totalFields;
  const visibleTotalPages = optionSearchFieldIds instanceof Set ? 1 : totalPages;

  function toggleFieldSelection(fieldId, checked) {
    setSelectedFieldIds((current) => {
      const next = new Set(current);
      if (checked) next.add(fieldId);
      else next.delete(fieldId);
      return Array.from(next);
    });
  }

  function clearSelectedFields() {
    setSelectedFieldIds([]);
    setReportNameInput("");
    setActiveReportName("");
    setReportData(null);
  }

  async function selectAllFilteredFields() {
    if (optionSearchFieldIds instanceof Set) {
      setSelectedFieldIds(visibleInventoryFields.map((field) => field.id));
      return;
    }
    try {
      const result = await invoke("getFilteredFieldIds", {
        query: debouncedQuery,
        optionQuery: debouncedOptionQuery,
        type: typeFilter,
        fieldOrigin,
        projectUsageFilter,
        minIssuesWithValue,
        maxIssuesWithValue,
        sortBy,
      });
      setSelectedFieldIds(result.fieldIds || []);
    } catch (err) {
      setError(err.message || "Failed to select filtered fields.");
    }
  }

  async function generateProjectUsageReport(fieldIdsOverride = null, reportNameOverride = "") {
    const fieldIds = fieldIdsOverride?.length ? fieldIdsOverride : selectedFieldIds;
    if (!fieldIds.length) {
      setError("Select at least one field for the report.");
      return;
    }
    setLoadingReport(true);
    try {
      const nextReportName = reportNameOverride || reportNameInput.trim() || "Project Usage Report";
      const result = await invoke("startProjectUsageReportJob", { fieldIds, reportName: nextReportName });
      setReportData(null);
      setReportJob(null);
      setReportJobId(result?.jobId || "");
      setActiveReportName(nextReportName);
      setActiveTab("report");
      if (result?.jobId) {
        await fetchReportJob(result.jobId);
      }
    } catch (err) {
      setError(err.message || "Failed to generate project usage report.");
    } finally {
      setLoadingReport(false);
    }
  }

  function exportProjectUsageReportCsv(overrideReportData = null) {
    const exportData = overrideReportData || reportData;
    if (!exportData?.fields?.length) {
      setError("No report data available to export.");
      return;
    }

    const header = ["Field ID", "Field Name", ...exportData.projects.map((project) => project.projectKey)];
    const rows = [];
    for (const group of groupReportFieldsByType(exportData.fields)) {
      rows.push([`${group.fieldType.toUpperCase()} FIELDS`, "", ...exportData.projects.map(() => "")]);
      for (const field of group.fields) {
        const cellByProjectId = new Map(field.projects.map((project) => [project.projectId, project]));
        const cells = exportData.projects.map((project) => {
          const cell = cellByProjectId.get(project.projectId);
          if (!cell) return "";
          const href = buildJiraSearchUrl(siteOrigin, cell.jql);
          return href ? `=HYPERLINK("${href.replace(/"/g, '""')}", "${cell.issueCount} issues")` : `${cell.issueCount}`;
        });
        rows.push([field.fieldId, field.fieldName, ...cells]);
      }
    }

    downloadCsv(`${slugifyFilenamePart(activeReportName, "project-usage-report")}.csv`, [header, ...rows]);
  }

  async function saveCurrentReport() {
    if (!reportNameInput.trim()) {
      setError("Enter a report name before saving.");
      return;
    }

    setSavingReport(true);
    try {
      const existing = savedReports.find((report) => report.name.toLowerCase() === reportNameInput.trim().toLowerCase());
      const result = await invoke("saveReportDefinition", {
        reportId: existing?.reportId || "",
        name: reportNameInput.trim(),
        fieldIds: selectedFieldIds,
      });
      setSavedReports(result.reports || []);
      setActiveReportName(reportNameInput.trim());
    } catch (err) {
      setError(err.message || "Failed to save report.");
    } finally {
      setSavingReport(false);
    }
  }

  async function loadSavedReport(report) {
    setSelectedFieldIds(report.fieldIds || []);
    setReportNameInput(report.name || "");
    await generateProjectUsageReport(report.fieldIds || [], report.name || "");
  }

  async function removeSavedReport(reportId) {
    setDeletingReportId(reportId);
    try {
      const result = await invoke("deleteReportDefinition", { reportId });
      setSavedReports(result.reports || []);
    } catch (err) {
      setError(err.message || "Failed to delete report.");
    } finally {
      setDeletingReportId("");
    }
  }

  async function askRovoAboutInventory() {
    try {
      await openFieldExpertRovo(
        buildInventoryRovoPrompt({
          totalFields,
          availableTypes,
          refreshedAt,
          currentPage,
          totalPages,
          query: debouncedQuery,
          typeFilter,
          sortBy,
        })
      );
    } catch (err) {
      setError(err.message || "Failed to open Rovo.");
    }
  }

  async function askRovoAboutField(field) {
    try {
      await openFieldExpertRovo(buildFieldRovoPrompt(field, detailsByFieldId[field.id]));
    } catch (err) {
      setError(err.message || "Failed to open Rovo.");
    }
  }

  async function askRovoAboutProject(field, project) {
    try {
      await openFieldExpertRovo(buildProjectRovoPrompt(field, detailsByFieldId[field.id], project));
    } catch (err) {
      setError(err.message || "Failed to open Rovo.");
    }
  }

  async function askRovoAboutReport({ fields, projects, pendingFields, reportSummary }) {
    try {
      await openFieldExpertRovo(
        buildReportRovoPrompt({
          reportName: activeReportName || reportNameInput || "Project Usage Report",
          fields,
          projects,
          pendingFields,
          reportSummary,
        })
      );
    } catch (err) {
      setError(err.message || "Failed to open Rovo.");
    }
  }

  const showOnboarding = !loadingInventory && !refreshedAt;
  const snapshotChipState = refreshedAt ? "ready" : "idle";
  const snapshotChipLabel = refreshedAt ? `Synced ${formatRelativeTime(refreshedAt)}` : "No snapshot";
  const SNAPSHOT_STALE_DAYS = 7;
  const snapshotAgeMs = refreshedAt ? Date.now() - new Date(refreshedAt).getTime() : null;
  const isSnapshotStale = !loadingInventory && snapshotAgeMs != null && snapshotAgeMs > SNAPSHOT_STALE_DAYS * 24 * 60 * 60 * 1000;

  if (accessCheck === null) {
    return (
      <div className="access-gate access-gate--checking">
        <div className="access-gate__spinner" />
        <span>Verifying access…</span>
      </div>
    );
  }

  if (!accessCheck.allowed) {
    return (
      <div className="access-gate access-gate--denied">
        <svg className="access-gate__icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 11H5a2 2 0 00-2 2v7a2 2 0 002 2h14a2 2 0 002-2v-7a2 2 0 00-2-2zM17 11V7a5 5 0 00-10 0v4" />
        </svg>
        <h2 className="access-gate__title">Access Restricted</h2>
        <p className="access-gate__reason">{accessCheck.reason || "You don't have permission to view this Observatory."}</p>
      </div>
    );
  }

  return (
    <main
      className={`app-shell ${compactLayout ? "app-shell--compact" : ""} ${activeTab === "report" ? "app-shell--report" : ""} ${activeTab === "projects" ? "app-shell--projects" : ""}`}
      style={{ zoom: zoomLevel / 100 }}
    >
      <section className="hero">
        <div className="hero__identity">
          <h1>Observatory</h1>
          <span className={`snapshot-chip snapshot-chip--${snapshotChipState}`}>
            <span className="snapshot-chip__dot" />
            {snapshotChipLabel}
          </span>
        </div>
        <div className="hero__actions">
          <div className="zoom-controls" aria-label="App zoom controls">
            <button
              className="secondary-button secondary-button--small"
              onClick={() => setZoomLevel((current) => Math.max(80, current - 10))}
              type="button"
              disabled={zoomLevel <= 80}
            >
              A-
            </button>
            <span className="zoom-controls__value">{zoomLevel}%</span>
            <button
              className="secondary-button secondary-button--small"
              onClick={() => setZoomLevel((current) => Math.min(130, current + 10))}
              type="button"
              disabled={zoomLevel >= 130}
            >
              A+
            </button>
            <button
              className="secondary-button secondary-button--small"
              onClick={() => setZoomLevel(100)}
              type="button"
              disabled={zoomLevel === 100}
            >
              Reset
            </button>
          </div>
          <button
            className="secondary-button"
            onClick={askRovoAboutInventory}
            type="button"
            disabled={!rovoEnabled}
          >
            Ask Rovo
          </button>
          <button
            className="icon-button"
            onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")}
            type="button"
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? "☀" : "☽"}
          </button>
          <button
            className="primary-button"
            onClick={() => fetchInventory({ forceRefresh: true, page: 1 })}
            type="button"
            disabled={loadingInventory}
          >
            {loadingInventory ? "Refreshing..." : "Refresh data"}
          </button>
        </div>
      </section>

      <div className="tab-bar">
        <button
          className={`tab-bar__tab ${activeTab === "inventory" ? "tab-bar__tab--active" : ""}`}
          type="button"
          onClick={() => setActiveTab("inventory")}
        >
          <Icon name="layers" size={15} />
          Inventory
        </button>
        <button
          className={`tab-bar__tab ${activeTab === "projects" ? "tab-bar__tab--active" : ""}`}
          type="button"
          onClick={() => setActiveTab("projects")}
        >
          <Icon name="folder" size={15} />
          Projects
        </button>
        <button
          className={`tab-bar__tab ${activeTab === "report" ? "tab-bar__tab--active" : ""}`}
          type="button"
          onClick={() => setActiveTab("report")}
        >
          <Icon name="barChart" size={15} />
          Report
          {selectedFieldIds.length ? <span className="tab-bar__dot" /> : null}
        </button>
      </div>

      {isSnapshotStale && (
        <div className="status-banner status-banner--warning staleness-banner" role="alert">
          <svg className="staleness-banner__icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          Field data was last synced {formatRelativeTime(refreshedAt)} — data may be outdated. Ask your Jira admin to run a snapshot refresh.
        </div>
      )}

      {activeTab === "projects" ? (
        <React.Suspense fallback={<div className="empty-state">Loading…</div>}>
          <ProjectsTabView
            data={projectsViewData}
            loading={loadingProjectsView}
            siteOrigin={siteOrigin}
            selectedProjectId={selectedProjectId}
            onSelectProject={setSelectedProjectId}
            projectQuery={projectTabProjectQuery}
            onProjectQueryChange={setProjectTabProjectQuery}
            fieldQuery={projectTabFieldQuery}
            onFieldQueryChange={setProjectTabFieldQuery}
            fieldType={projectTabFieldType}
            onFieldTypeChange={setProjectTabFieldType}
            fieldSort={projectTabFieldSort}
            onFieldSortChange={setProjectTabFieldSort}
            onChangePage={setProjectTabPage}
          />
        </React.Suspense>
      ) : activeTab === "report" ? (
        <ReportErrorBoundary resetKey={`${activeReportName}-${selectedFieldIds.join(",")}`}>
          <ProjectUsageReportView
            reportData={reportData}
            reportName={activeReportName}
            reportJob={reportJob}
            siteOrigin={siteOrigin}
            onExportCsv={exportProjectUsageReportCsv}
            onAskReport={askRovoAboutReport}
            savedReports={savedReports}
            selectedFieldIds={selectedFieldIds}
            reportNameInput={reportNameInput}
            onReportNameChange={setReportNameInput}
            onSaveReport={saveCurrentReport}
            onLoadReport={loadSavedReport}
            onDeleteReport={removeSavedReport}
            savingReport={savingReport}
            deletingReportId={deletingReportId}
            rovoEnabled={rovoEnabled}
          />
        </ReportErrorBoundary>
      ) : (
        <>
          {showOnboarding ? (
            <div className="empty-state">
              <p>No field data available yet.</p>
              <p>Visit the <strong>Admin page</strong> to run a snapshot and populate field data.</p>
            </div>
          ) : (
          <>
          <div className="status-banner status-banner--info" style={{ marginBottom: 12 }}>
            Field registry data reflects the Jira fields, projects, and issues visible to this app on {siteOrigin || "this Atlassian site"}. Some restricted Jira data may be excluded from counts and search results.
          </div>
          <section className="toolbar">
            <label className="toolbar__field">
              <span>Search</span>
              <input
                type="search"
                placeholder="Field name, id, type, or description"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                data-search-input="primary"
              />
            </label>
            <label className="toolbar__field">
              <span>Option search</span>
              <input
                type="search"
                placeholder="Select option value, e.g. DCV or P833"
                value={optionQuery}
                onChange={(event) => setOptionQuery(event.target.value)}
              />
            </label>
            <label className="toolbar__field">
              <span>Field type</span>
              <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
                <option value="all">All types</option>
                {availableTypes.map((type) => (
                  <option value={type} key={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <label className="toolbar__field">
              <span>Field origin</span>
              <select value={fieldOrigin} onChange={(event) => setFieldOrigin(event.target.value)}>
                <option value="all">All fields</option>
                <option value="user-created">User-created</option>
                <option value="jira-builtin">Jira built-in</option>
              </select>
            </label>
            <label className="toolbar__field">
              <span>Sort</span>
              <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
                <option value="name-asc">Name A-Z</option>
                <option value="name-desc">Name Z-A</option>
                <option value="usage-desc">Most issues with value</option>
                <option value="usage-asc">Fewest issues with value</option>
                <option value="active-projects-desc">Most active projects</option>
                <option value="active-projects-asc">Fewest active projects</option>
              </select>
            </label>
            <label className="toolbar__field">
              <span>Project usage</span>
              <select value={projectUsageFilter} onChange={(event) => setProjectUsageFilter(event.target.value)}>
                <option value="all">All states</option>
                <option value="not-built">Usage not built</option>
                <option value="built">Usage built</option>
                <option value="building">Usage building</option>
                <option value="incomplete">Usage incomplete</option>
              </select>
            </label>
            <label className="toolbar__field">
              <span>Issues with value</span>
              <div className="toolbar__range-inputs">
                <input
                  type="number"
                  min="0"
                  step="1"
                  placeholder="Min"
                  value={minIssuesWithValue}
                  onChange={(event) => setMinIssuesWithValue(event.target.value)}
                />
                <span className="toolbar__range-sep">–</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  placeholder="Max"
                  value={maxIssuesWithValue}
                  onChange={(event) => setMaxIssuesWithValue(event.target.value)}
                />
              </div>
            </label>
          </section>

          <div className="findings-actions-bar">
            <div className="toolbar__report-actions">
              {selectedFieldIds.length > 0 && (
                <span className="toolbar__selected-count">{selectedFieldIds.length} selected</span>
              )}
              <button
                className="secondary-button secondary-button--small"
                type="button"
                onClick={selectAllFilteredFields}
                disabled={loadingInventory || !visibleTotalFields}
              >
                Select filtered
              </button>
              {selectedFieldIds.length > 0 && (
                <button
                  className="secondary-button secondary-button--small"
                  type="button"
                  onClick={clearSelectedFields}
                >
                  Clear
                </button>
              )}
              <button
                className="primary-button"
                type="button"
                onClick={generateProjectUsageReport}
                disabled={loadingReport || !selectedFieldIds.length}
              >
                <Icon name="barChart" size={14} />
                {loadingReport ? "Generating..." : "Generate report"}
              </button>
            </div>
          </div>

          {error ? <div className="error-banner">{error}</div> : null}
          {optionSearchStatus ? (
            <div className={`status-banner ${optionSearchStatus.state === "failed" ? "status-banner--warning" : "status-banner--info"}`} style={{ marginBottom: 10 }}>
              {optionSearchStatus.state === "failed"
                ? `Option search failed: ${optionSearchStatus.error}`
                : optionSearchStatus.state === "searching"
                ? `Option search found ${visibleTotalFields} fields so far; scanned ${formatNumber(optionSearchStatus.scanned)} of ${formatNumber(optionSearchStatus.totalCandidates)} selectable fields.`
                : `Option search found ${visibleTotalFields} matching fields.`}
            </div>
          ) : null}

          <section className="pagination-bar">
            <span className="pagination-bar__status">
              {totalFields
                ? `Showing ${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, totalFields)} of ${totalFields} fields`
                : "No fields in the current snapshot"}
            </span>
            <div className="pagination-bar__page-size">
              <span className="pagination-bar__page-size-label">Per page:</span>
              {[10, 25, 50].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`pagination-bar__page-size-btn ${pageSize === n ? "pagination-bar__page-size-btn--active" : ""}`}
                  onClick={() => { localStorage.setItem("atlasiq-field-pagesize", n); setPageSize(n); setCurrentPage(1); }}
                >{n}</button>
              ))}
            </div>
            <div className="pagination-bar__actions">
              <button className="secondary-button" type="button" onClick={() => setCurrentPage(1)} disabled={optionSearchFieldIds instanceof Set || currentPage === 1 || !totalFields}>First</button>
              <button className="secondary-button" type="button" onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={optionSearchFieldIds instanceof Set || currentPage === 1 || !totalFields}>Previous</button>
              <button className="secondary-button" type="button" onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={optionSearchFieldIds instanceof Set || currentPage === totalPages || !totalFields}>Next</button>
              <button className="secondary-button" type="button" onClick={() => setCurrentPage(totalPages)} disabled={optionSearchFieldIds instanceof Set || currentPage === totalPages || !totalFields}>Last</button>
            </div>
          </section>

          <section className="field-list">
            {loadingInventory ? (
              Array.from({ length: 6 }, (_, i) => <SkeletonFieldCard key={i} />)
            ) : visibleInventoryFields.length ? (
              visibleInventoryFields.map((field) => (
                <FieldCard
                  key={field.id}
                  field={field}
                  details={detailsByFieldId[field.id]}
                  expanded={expandedFieldId === field.id}
                  loading={loadingDetailFieldId === field.id}
                  selected={selectedFieldIds.includes(field.id)}
                  onSelectChange={toggleFieldSelection}
                  onToggle={() => toggleField(field.id)}
                  onProjectUsagePageChange={changeProjectUsagePage}
                  onRefreshProjectUsage={refreshProjectUsage}
                  onAskField={() => askRovoAboutField(field)}
                  onAskProject={(project) => askRovoAboutProject(field, project)}
                  siteOrigin={siteOrigin}
                  rovoEnabled={rovoEnabled}
                  showGovernance={false}
                />
              ))
            ) : (
              <div className="empty-state">
                {hasActiveFilters
                  ? <span>No fields matched the current filters. <button className="inline-text-button" type="button" onClick={clearFilters}>Clear filters</button></span>
                  : "No custom fields found in the snapshot."}
              </div>
            )}
          </section>

          <section className="pagination-bar">
            <span className="pagination-bar__status">
              {totalFields
                ? `Showing ${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, totalFields)} of ${totalFields} fields`
                : "No fields in the current snapshot"}
            </span>
            <div className="pagination-bar__page-size">
              <span className="pagination-bar__page-size-label">Per page:</span>
              {[10, 25, 50].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`pagination-bar__page-size-btn ${pageSize === n ? "pagination-bar__page-size-btn--active" : ""}`}
                  onClick={() => { localStorage.setItem("atlasiq-field-pagesize", n); setPageSize(n); setCurrentPage(1); }}
                >{n}</button>
              ))}
            </div>
            <div className="pagination-bar__actions">
              <button className="secondary-button" type="button" onClick={() => setCurrentPage(1)} disabled={optionSearchFieldIds instanceof Set || currentPage === 1 || !totalFields}>First</button>
              <button className="secondary-button" type="button" onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={optionSearchFieldIds instanceof Set || currentPage === 1 || !totalFields}>Previous</button>
              <button className="secondary-button" type="button" onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={optionSearchFieldIds instanceof Set || currentPage === totalPages || !totalFields}>Next</button>
              <button className="secondary-button" type="button" onClick={() => setCurrentPage(totalPages)} disabled={optionSearchFieldIds instanceof Set || currentPage === totalPages || !totalFields}>Last</button>
            </div>
          </section>
          </>
          )}
        </>
      )}
    </main>
  );
}

const rootNode = document.getElementById("root");
if (rootNode) {
  try {
    ReactDOM.createRoot(rootNode).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );

    if (bootStatusNode) {
      bootStatusNode.remove();
    }
  } catch (error) {
    if (bootStatusNode) {
      bootStatusNode.dataset.state = "error";
      bootStatusNode.textContent = `React mount failed: ${error.message || "Unknown error"}`;
    }
    throw error;
  }
}
