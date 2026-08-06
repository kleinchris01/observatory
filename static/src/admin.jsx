import React from "react";
import ReactDOM from "react-dom/client";
import { createPortal } from "react-dom";
import { invoke, view } from "@forge/bridge";
import "./styles.css";
import { formatTimestamp, formatNumber, toDisplayName, buildValueJql, formatShortTime, formatRelativeTime, formatLogTime, formatContextList, normalizeSiteOrigin, buildJiraSearchUrl, handleJiraLinkClick, escapeCsvCell, downloadCsv, slugifyFilenamePart, normalizeReportData, groupReportFieldsByType, summarizeReportData, isUsageAvailable, isSelectType, mergeFieldMetrics, openFieldExpertRovo, buildInventoryRovoPrompt, buildFieldRovoPrompt, buildProjectRovoPrompt, buildReportRovoPrompt } from "./utils";
import { Icon, useLiveDuration } from "./components/Icons";
import { ReportErrorBoundary, SavedReportsPanel, ProjectUsageReportView } from "./components/ReportView";
import { MetricChip, FindingBadge, FindingsStrip, SkeletonFieldCard, SkeletonProjectItem, InlineOptionsContext, FieldCard } from "./components/FieldCard";
import { ConfigTab } from "./tabs/ConfigTab";
import { FieldBrowserTab } from "./tabs/FieldBrowserTab";
import { OverviewTab } from "./tabs/OverviewTab";
import { ProjectUsageTab } from "./tabs/ProjectUsageTab";
import { ReportsTab } from "./tabs/ReportsTab";
import { ScansTab } from "./tabs/ScansTab";

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
const AutomationTab = React.lazy(() =>
  import("./tabs/AutomationTab").then((m) => ({ default: m.AutomationTab }))
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

  // Slow poll to catch external changes (findings/migration banner) -- live snapshot
  // build progress is now polled independently by ScansTab's own Snapshot panel.
  React.useEffect(() => {
    const timer = setInterval(() => {
      loadOverview({ quiet: true });
    }, 60000);
    return () => clearInterval(timer);
  }, []);

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
                onClick={() => setActiveTab(key)}
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

          {activeTab === "overview" ? (
            loadingOverview && !overview ? (
              <div className="empty-state">Loading…</div>
            ) : (
              <OverviewTab
                overview={overview}
                onMigrateNamespace={handleMigrateNamespace}
                migratingNamespace={migratingNamespace}
                onOpenRqtIndex={() => { setScansInitialSection("rqt"); setActiveTab("scans"); }}
                onNavigate={(tab) => setActiveTab(tab)}
              />
            )
          ) : activeTab === "fields" ? (
            <FieldBrowserTab
              selectedFieldIds={selectedFieldIds}
              onToggleField={toggleFieldSelection}
              onSetSelectedFieldIds={setSelectedFieldIds}
              onGoToReport={() => { setActiveTab("reports"); setPendingReportGenerate(true); }}
              siteOrigin={siteOrigin}
            />
          ) : activeTab === "projects" ? (
            <ProjectUsageTab siteOrigin={siteOrigin} />
          ) : activeTab === "workflows" ? (
            <React.Suspense fallback={<div className="empty-state">Loading…</div>}>
              <WorkflowTab />
            </React.Suspense>
          ) : activeTab === "automation" ? (
            <React.Suspense fallback={<div className="empty-state">Loading…</div>}>
              <AutomationTab />
            </React.Suspense>
          ) : activeTab === "reports" ? (
            <ReportsTab siteOrigin={siteOrigin} selectedFieldIds={selectedFieldIds} onSetSelectedFieldIds={setSelectedFieldIds} autoGenerate={pendingReportGenerate} onAutoGenerateConsumed={() => setPendingReportGenerate(false)} />
          ) : activeTab === "scans" ? (
            <ScansTab siteOrigin={siteOrigin} initialSection={scansInitialSection} />
          ) : (
            <ConfigTab config={config} onSave={handleSaveConfig} saving={savingConfig} />
          )}
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
