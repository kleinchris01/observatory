import React from "react";
import ReactDOM from "react-dom/client";
import { createPortal } from "react-dom";
import { invoke, view } from "@forge/bridge";
import "./styles.css";
import { formatTimestamp, formatNumber, toDisplayName, buildValueJql, formatShortTime, formatRelativeTime, formatLogTime, formatContextList, normalizeSiteOrigin, buildJiraSearchUrl, handleJiraLinkClick, escapeCsvCell, downloadCsv, slugifyFilenamePart, normalizeReportData, groupReportFieldsByType, summarizeReportData, isUsageAvailable, isSelectType, mergeFieldMetrics, openFieldExpertRovo, buildInventoryRovoPrompt, buildFieldRovoPrompt, buildProjectRovoPrompt, buildReportRovoPrompt } from "./utils";
import { Icon, useLiveDuration } from "./components/Icons";
import { ReportErrorBoundary, SavedReportsPanel, ProjectUsageReportView } from "./components/ReportView";
import { MetricChip, FindingBadge, FindingsStrip, SkeletonFieldCard, SkeletonProjectItem, InlineOptionsContext, FieldCard } from "./components/FieldCard";
import { useRefreshOnVisible } from "./hooks";

// Lazy: both pull in recharts (+122KB gzip measured on the macro bundle) and
// sit behind tabs not shown by default -- split into their own chunk, fetched
// only when a user actually opens Projects or Scans/RQT.
const ProjectsTabView = React.lazy(() =>
  import("./components/ProjectsTab").then((m) => ({ default: m.ProjectsTabView }))
);
const RqtIndexView = React.lazy(() =>
  import("./tabs/RqtTab").then((m) => ({ default: m.RqtIndexView }))
);
const WorkflowTab = React.lazy(() =>
  import("./tabs/WorkflowTab").then((m) => ({ default: m.WorkflowTab }))
);
// Every tab is loaded on demand.
//
// Six of these were static imports, which meant the entry bundle carried the Field Browser,
// Reports, Scans, Project Usage, Config and the Overview whether or not anybody opened them --
// 420 KB before a single tab was clicked. The other four were already lazy; this is the same
// pattern applied to the rest rather than a new one.
const ConfigTab = React.lazy(() => import("./tabs/ConfigTab").then((m) => ({ default: m.ConfigTab })));
const FieldBrowserTab = React.lazy(() => import("./tabs/FieldBrowserTab").then((m) => ({ default: m.FieldBrowserTab })));
const OverviewTab = React.lazy(() => import("./tabs/OverviewTab").then((m) => ({ default: m.OverviewTab })));
const ProjectUsageTab = React.lazy(() => import("./tabs/ProjectUsageTab").then((m) => ({ default: m.ProjectUsageTab })));
const ReportsTab = React.lazy(() => import("./tabs/ReportsTab").then((m) => ({ default: m.ReportsTab })));
const ScansTab = React.lazy(() => import("./tabs/ScansTab").then((m) => ({ default: m.ScansTab })));
const DashboardsTab = React.lazy(() => import("./tabs/DashboardsTab").then((m) => ({ default: m.DashboardsTab })));
const FiltersTab = React.lazy(() => import("./tabs/FiltersTab").then((m) => ({ default: m.FiltersTab })));
const AutomationTab = React.lazy(() =>
  import("./tabs/AutomationTab").then((m) => ({ default: m.AutomationTab }))
);
const ScreensTab = React.lazy(() =>
  import("./tabs/ScreensTab").then((m) => ({ default: m.ScreensTab }))
);
const OverviewDashboard = React.lazy(() =>
  import("./components/OverviewDashboard").then((m) => ({ default: m.OverviewDashboard }))
);

const bootStatusNode = document.getElementById("boot-status");

// ── Default config ─────────────────────────────────────────────────────────


// ── Sub-components ─────────────────────────────────────────────────────────


// ── Job list (re-implemented for admin context) ───────────────────────────


// ── Tab views ──────────────────────────────────────────────────────────────


// Read-only view of the audit trail. Loads on demand rather than with the tab: the
// query is cheap but pointless for the common case of someone opening Configuration to
// change a threshold, and this app pays for SQL requests by the request.


// ── Project usage tab ─────────────────────────────────────────────────────


// ── Field browser tab ─────────────────────────────────────────────────────


// ── Reports tab (self-contained) ──────────────────────────────────────────


// ── Scan components ───────────────────────────────────────────────────────


// Type-to-confirm rather than a plain OK dialog. This is the one irreversible action in
// the app, and a single mis-click should not be able to destroy a snapshot that took
// hours to build on a large site.


// ── Scans tab (self-contained) ────────────────────────────────────────────


// ── Root app ───────────────────────────────────────────────────────────────

export function AdminApp() {
  const [activeTab, setActiveTab] = React.useState("overview");
  // The filter a finding wants applied when it opens a tab.
  //
  // A fresh object per navigation, so clicking the same finding twice re-applies its filter
  // after the reader has changed it -- see useNavIntent. Held here rather than in each tab
  // because the Overview names the destination and the destination applies it, and neither
  // of them owns the hop between.
  const [navIntent, setNavIntent] = React.useState(null);
  const navigate = React.useCallback((tab, intent = null) => {
    setActiveTab(tab);
    setNavIntent(intent ? { ...intent } : null);
  }, []);
  const [reportsInitialSection, setReportsInitialSection] = React.useState("");
  const [theme, setTheme] = React.useState(() => localStorage.getItem("atlasiq-field-theme") || "dark");
  const [overview, setOverview] = React.useState(null);
  const [loadingOverview, setLoadingOverview] = React.useState(true);
  const [config, setConfig] = React.useState(null);
  const [savingConfig, setSavingConfig] = React.useState(false);
  const [migratingNamespace, setMigratingNamespace] = React.useState(false);
  const [error, setError] = React.useState("");
  const [saveSuccess, setSaveSuccess] = React.useState(false);
  const [siteOrigin, setSiteOrigin] = React.useState("");
  const [scansInitialSection, setScansInitialSection] = React.useState("universe");
  const [selectedFieldIds, setSelectedFieldIds] = React.useState([]);
  const [pendingReportGenerate, setPendingReportGenerate] = React.useState(false);

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("atlasiq-field-theme", theme);
  }, [theme]);

  React.useEffect(() => {
    try { view.setAutoResizing(true); } catch {}
  }, []);

  async function loadOverview({ quiet = false } = {}) {
    if (!quiet) setLoadingOverview(true);
    try {
      const data = await invoke("getAdminOverview");
      setOverview(data);
      setConfig(data.config);
    } catch (err) {
      if (!quiet) setError(err.message || "Failed to load overview.");
    } finally {
      setLoadingOverview(false);
    }
  }

  React.useEffect(() => {
    loadOverview();
    view.getContext().then((ctx) => {
      const origin = normalizeSiteOrigin(ctx?.siteUrl || ctx?.extension?.siteUrl || ctx?.extensionContext?.siteUrl);
      if (origin) setSiteOrigin(origin);
    }).catch(() => {});
  }, []);

  function toggleFieldSelection(fieldId, checked) {
    setSelectedFieldIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(fieldId); else next.delete(fieldId);
      return [...next];
    });
  }

  // No interval. Refreshed on mount, and again whenever someone returns to the page.
  //
  // This was a 60-second poll, then a visibility-gated 60-second poll, and both were
  // solving the wrong problem: getAdminOverview is the heaviest read in the product and it
  // was on a timer to catch an event -- a snapshot finishing -- that happens about once a
  // day. Returning to the tab is when staleness starts to matter, and gating on that
  // alone takes idle cost to zero rather than merely reducing it.
  //
  // Live build progress is unaffected: ScansTab polls its own state while a job runs.
  useRefreshOnVisible(() => loadOverview({ quiet: true }));

  async function handleMigrateNamespace() {
    setMigratingNamespace(true);
    setError("");
    try {
      await invoke("migrateNamespaceKeys");
      await loadOverview({ quiet: true });
    } catch (err) {
      setError(err.message || "Migration failed.");
    } finally {
      setMigratingNamespace(false);
    }
  }

  async function handleSaveConfig(newConfig) {
    setSavingConfig(true);
    setError("");
    try {
      const result = await invoke("saveAdminConfig", newConfig);
      setConfig(result.config);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setError(err.message || "Failed to save configuration.");
    } finally {
      setSavingConfig(false);
    }
  }

  const tabs = [
    { key: "overview", label: "Overview", icon: "barChart" },
    { key: "fields", label: "Field Browser", icon: "layers" },
    { key: "projects", label: "Project Usage", icon: "folder" },
    { key: "workflows", label: "Workflows", icon: "activity" },
    { key: "screens", label: "Screens", icon: "copy" },
    { key: "filters", label: "Saved Filters", icon: "search" },
    { key: "dashboards", label: "Dashboards", icon: "barChart" },
    { key: "automation", label: "Automation", icon: "refreshCw" },
    { key: "reports", label: "Reports", icon: "barChart" },
    { key: "scans", label: "Scans", icon: "zap" },
    { key: "config", label: "Configuration", icon: "settings" },
  ];

  return (
    <div className="admin-shell">
      <div className="admin-layout">
        <aside className="admin-sidebar">
          <div className="admin-sidebar__brand">
            <span className="admin-sidebar__logo">Observatory</span>
            <span className="admin-badge">Admin</span>
          </div>

          <nav className="admin-nav" aria-label="Admin navigation">
            {tabs.map(({ key, label, icon }) => (
              <button
                key={key}
                className={`admin-nav__item${activeTab === key ? " admin-nav__item--active" : ""}`}
                type="button"
                onClick={() => navigate(key)}
              >
                <Icon name={icon} size={15} />
                <span>{label}</span>
              </button>
            ))}
          </nav>

          <div className="admin-sidebar__footer">
            <button
              className="admin-nav__item admin-nav__item--footer"
              onClick={() => setTheme((v) => v === "dark" ? "light" : "dark")}
              type="button"
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              <span>{theme === "dark" ? "☀" : "☽"}</span>
              <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
            </button>
          </div>
        </aside>

        <div className="admin-content">
          {config?.readOnlyMode && (
            <div className="admin-readonly-banner">
              <Icon name="lock" size={14} />
              Read-only mode is active — Confluence macro users cannot trigger field usage scans.
            </div>
          )}

          {error && (
            <div className="error-banner" style={{ margin: "0 0 12px 0" }}>
              {error}
              <button className="inline-text-button" type="button" onClick={() => setError("")} style={{ marginLeft: 10 }}>Dismiss</button>
            </div>
          )}

          {saveSuccess && (
            <div className="admin-success-banner">
              <Icon name="checkCircle" size={14} />
              Configuration saved.
            </div>
          )}

          {/* One boundary for every tab, rather than one per lazy tab. The chain below is
              mutually exclusive -- exactly one arm renders -- so a single fallback covers
              all of them and keeps the loading state identical whichever is opened. */}
          <React.Suspense fallback={<div className="empty-state">Loading…</div>}>
          {activeTab === "overview" ? (
            loadingOverview && !overview ? (
              <div className="empty-state">Loading…</div>
            ) : (
              <OverviewTab
                overview={overview}
                onMigrateNamespace={handleMigrateNamespace}
                migratingNamespace={migratingNamespace}
                onOpenRqtIndex={() => { setReportsInitialSection("rqt"); setActiveTab("reports"); }}
                onNavigate={navigate}
              />
            )
          ) : activeTab === "fields" ? (
            <FieldBrowserTab
              intent={navIntent}
              selectedFieldIds={selectedFieldIds}
              onToggleField={toggleFieldSelection}
              onSetSelectedFieldIds={setSelectedFieldIds}
              onGoToReport={() => { setActiveTab("reports"); setPendingReportGenerate(true); }}
              siteOrigin={siteOrigin}
            />
          ) : activeTab === "projects" ? (
            <ProjectUsageTab siteOrigin={siteOrigin} intent={navIntent} />
          ) : activeTab === "workflows" ? (
            <WorkflowTab intent={navIntent} siteOrigin={siteOrigin} />
          ) : activeTab === "screens" ? (
            <ScreensTab intent={navIntent} />
          ) : activeTab === "filters" ? (
            <FiltersTab siteOrigin={siteOrigin} intent={navIntent} />
          ) : activeTab === "dashboards" ? (
            <DashboardsTab siteOrigin={siteOrigin} intent={navIntent} />
          ) : activeTab === "automation" ? (
            <AutomationTab siteOrigin={siteOrigin} intent={navIntent} />
          ) : activeTab === "reports" ? (
            <ReportsTab siteOrigin={siteOrigin} selectedFieldIds={selectedFieldIds} onSetSelectedFieldIds={setSelectedFieldIds} autoGenerate={pendingReportGenerate} onAutoGenerateConsumed={() => setPendingReportGenerate(false)} initialSection={reportsInitialSection} />
          ) : activeTab === "scans" ? (
            <ScansTab siteOrigin={siteOrigin} initialSection={scansInitialSection} />
          ) : (
            <ConfigTab config={config} onSave={handleSaveConfig} saving={savingConfig} />
          )}
          </React.Suspense>
        </div>
      </div>
    </div>
  );
}

const rootNode = document.getElementById("root");
if (rootNode) {
  try {
    ReactDOM.createRoot(rootNode).render(
      <React.StrictMode>
        <AdminApp />
      </React.StrictMode>
    );
    if (bootStatusNode) bootStatusNode.remove();
  } catch (error) {
    if (bootStatusNode) {
      bootStatusNode.dataset.state = "error";
      bootStatusNode.textContent = `React mount failed: ${error.message || "Unknown error"}`;
    }
    throw error;
  }
}
