import React from "react";
import ReactDOM from "react-dom/client";
import { createPortal } from "react-dom";
import { invoke, view } from "@forge/bridge";
import "./styles.css";
import {
  formatTimestamp,
  formatNumber,
  toDisplayName,
  buildValueJql,
  formatShortTime,
  formatRelativeTime,
  formatLogTime,
  formatContextList,
  normalizeSiteOrigin,
  buildJiraSearchUrl,
  handleJiraLinkClick,
  escapeCsvCell,
  downloadCsv,
  slugifyFilenamePart,
  normalizeReportData,
  groupReportFieldsByType,
  summarizeReportData,
  isUsageAvailable,
  isSelectType,
  mergeFieldMetrics,
  openFieldExpertRovo,
  buildInventoryRovoPrompt,
  buildFieldRovoPrompt,
  buildProjectRovoPrompt,
  buildReportRovoPrompt,
  pillarNavStatus,
  readStored,
  writeStored,
} from "./utils";
import { Icon, useLiveDuration } from "./components/Icons";
import { Starfield } from "./components/Starfield";
import { DaySky } from "./components/DaySky";
import { ReportErrorBoundary, SavedReportsPanel, ProjectUsageReportView } from "./components/ReportView";
import {
  MetricChip,
  FindingBadge,
  FindingsStrip,
  SkeletonFieldCard,
  SkeletonProjectItem,
  InlineOptionsContext,
  FieldCard,
} from "./components/FieldCard";
import { useRefreshOnVisible } from "./hooks";

// Lazy: both pull in recharts (+122KB gzip measured on the macro bundle) and
// sit behind tabs not shown by default -- split into their own chunk, fetched
// only when a user actually opens Projects or Scans/RQT.
const ProjectsTabView = React.lazy(() =>
  import("./components/ProjectsTab").then((m) => ({ default: m.ProjectsTabView })),
);
const RqtIndexView = React.lazy(() => import("./tabs/RqtTab").then((m) => ({ default: m.RqtIndexView })));
const WorkflowTab = React.lazy(() => import("./tabs/WorkflowTab").then((m) => ({ default: m.WorkflowTab })));
// Every tab is loaded on demand.
//
// Six of these were static imports, which meant the entry bundle carried the Field Browser,
// Reports, Scans, Project Usage, Config and the Overview whether or not anybody opened them --
// 420 KB before a single tab was clicked. The other four were already lazy; this is the same
// pattern applied to the rest rather than a new one.
const ConfigTab = React.lazy(() => import("./tabs/ConfigTab").then((m) => ({ default: m.ConfigTab })));
const FieldBrowserTab = React.lazy(() =>
  import("./tabs/FieldBrowserTab").then((m) => ({ default: m.FieldBrowserTab })),
);
const OverviewTab = React.lazy(() => import("./tabs/OverviewTab").then((m) => ({ default: m.OverviewTab })));
const ProjectUsageTab = React.lazy(() =>
  import("./tabs/ProjectUsageTab").then((m) => ({ default: m.ProjectUsageTab })),
);
const ReportsTab = React.lazy(() => import("./tabs/ReportsTab").then((m) => ({ default: m.ReportsTab })));
const ScansTab = React.lazy(() => import("./tabs/ScansTab").then((m) => ({ default: m.ScansTab })));
const SearchTab = React.lazy(() => import("./tabs/SearchTab").then((m) => ({ default: m.SearchTab })));
const RemediationTab = React.lazy(() => import("./tabs/RemediationTab").then((m) => ({ default: m.RemediationTab })));
const DashboardsTab = React.lazy(() => import("./tabs/DashboardsTab").then((m) => ({ default: m.DashboardsTab })));
const FiltersTab = React.lazy(() => import("./tabs/FiltersTab").then((m) => ({ default: m.FiltersTab })));
const AutomationTab = React.lazy(() => import("./tabs/AutomationTab").then((m) => ({ default: m.AutomationTab })));
const IssueTypesTab = React.lazy(() => import("./tabs/IssueTypesTab").then((m) => ({ default: m.IssueTypesTab })));
const PeopleTab = React.lazy(() => import("./tabs/PeopleTab").then((m) => ({ default: m.PeopleTab })));
const AssetsTab = React.lazy(() => import("./tabs/AssetsTab").then((m) => ({ default: m.AssetsTab })));
const AccessTab = React.lazy(() => import("./tabs/AccessTab").then((m) => ({ default: m.AccessTab })));
const ChangesTab = React.lazy(() => import("./tabs/ChangesTab").then((m) => ({ default: m.ChangesTab })));
const FieldConfigsTab = React.lazy(() =>
  import("./tabs/FieldConfigsTab").then((m) => ({ default: m.FieldConfigsTab })),
);
const PrioritiesTab = React.lazy(() => import("./tabs/PrioritiesTab").then((m) => ({ default: m.PrioritiesTab })));
const BoardsTab = React.lazy(() => import("./tabs/BoardsTab").then((m) => ({ default: m.BoardsTab })));
const ScreensTab = React.lazy(() => import("./tabs/ScreensTab").then((m) => ({ default: m.ScreensTab })));
const OverviewDashboard = React.lazy(() =>
  import("./components/OverviewDashboard").then((m) => ({ default: m.OverviewDashboard })),
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

// Module-level, not computed inside AdminApp: static data, and exporting it lets a test
// assert every tab has its own icon without rendering the whole app and walking the DOM for
// it. Every tab gets its own icon -- no two share one. Three used to be "barChart"
// (Overview/Dashboards/Reports), two "layers" (Field Browser/Issue Types), two "activity"
// (Workflows/Boards): invisible while the label always sat next to it, but exactly the tabs a
// reader couldn't tell apart the moment the sidebar collapsed to icons alone.
//
// `group` splits nineteen entries into what a reader is looking for: the thing being governed
// (Pillars), what to do about it (Act), and running the app itself (Operate). Overview stands
// alone above them.
export const ADMIN_NAV_TABS = [
  { key: "overview", label: "Overview", icon: "barChart", group: null },
  { key: "fields", label: "Field Browser", icon: "layers", group: "Pillars" },
  { key: "projects", label: "Project Usage", icon: "folder", group: "Pillars" },
  { key: "workflows", label: "Workflows", icon: "activity", group: "Pillars" },
  { key: "issueTypes", label: "Issue Types", icon: "tag", group: "Pillars" },
  { key: "fieldConfigs", label: "Field Schemes", icon: "listChecks", group: "Pillars" },
  { key: "priorities", label: "Priorities", icon: "flag", group: "Pillars" },
  { key: "people", label: "People", icon: "user", group: "Pillars" },
  { key: "assets", label: "Assets", icon: "database", group: "Pillars" },
  { key: "access", label: "Access", icon: "shield", group: "Pillars" },
  { key: "screens", label: "Screens", icon: "browser", group: "Pillars" },
  { key: "filters", label: "Saved Filters", icon: "search", group: "Pillars" },
  { key: "dashboards", label: "Dashboards", icon: "grid", group: "Pillars" },
  { key: "boards", label: "Boards", icon: "kanban", group: "Pillars" },
  { key: "automation", label: "Automation", icon: "refreshCw", group: "Pillars" },
  { key: "search", label: "Search", icon: "sliders", group: "Act" },
  { key: "remediation", label: "Remediation", icon: "wrench", group: "Act" },
  { key: "reports", label: "Reports", icon: "clipboardText", group: "Act" },
  { key: "changes", label: "Changes", icon: "clock", group: "Operate" },
  { key: "scans", label: "Scans", icon: "zap", group: "Operate" },
  { key: "config", label: "Configuration", icon: "settings", group: "Operate" },
];

// localStorage keys. Per viewer, per browser; nothing here is shared state.
const STORAGE_TAB = "observatory.admin.tab";
const STORAGE_THEME = "atlasiq-field-theme";
const STORAGE_SIDEBAR = "atlasiq-sidebar-collapsed";

function initialTab() {
  const stored = readStored(STORAGE_TAB, null);
  return ADMIN_NAV_TABS.some((t) => t.key === stored) ? stored : "overview";
}

// Dark -> Light -> Day -> Dark. The button always shows the icon and label for where a click
// takes you next, not the state you are in -- the same convention the two-state toggle used
// before Day mode existed, just extended to a third stop instead of flipped.
const THEME_CYCLE = { dark: "light", light: "day", day: "dark" };
const THEME_META = {
  dark: { icon: "☽", label: "Dark mode" },
  light: { icon: "☀", label: "Light mode" },
  day: { icon: "⛅", label: "Day mode" },
};

export function AdminApp() {
  // Reopens where the reader left off. Deep links (navigate, buildFieldReport) still move it.
  const [activeTab, setActiveTab] = React.useState(initialTab);
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
    // An ordinary visit reopens the section the reader last used. Only the explicit deep
    // links (RQT, build-a-field-report) set this, and they call setActiveTab directly.
    setReportsInitialSection("");
  }, []);
  const [reportsInitialSection, setReportsInitialSection] = React.useState("");
  const [theme, setTheme] = React.useState(() => readStored(STORAGE_THEME, "dark"));
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(() => readStored(STORAGE_SIDEBAR, "0") === "1");
  const [overview, setOverview] = React.useState(null);
  // When the overview (and so the site health) was last scored -- the Reports scorecard's age.
  const [overviewLoadedAt, setOverviewLoadedAt] = React.useState(null);
  const [loadingOverview, setLoadingOverview] = React.useState(true);
  const [config, setConfig] = React.useState(null);
  const [savingConfig, setSavingConfig] = React.useState(false);
  const [migratingNamespace, setMigratingNamespace] = React.useState(false);
  const [error, setError] = React.useState("");
  const [saveSuccess, setSaveSuccess] = React.useState(false);
  const [siteOrigin, setSiteOrigin] = React.useState("");
  // A deep-link slot for Scans. Empty means "the section the reader last used".
  const [scansInitialSection] = React.useState("");
  const [selectedFieldIds, setSelectedFieldIds] = React.useState([]);
  const [pendingReportGenerate, setPendingReportGenerate] = React.useState(false);
  // Project scope for the next report build -- set when a report is launched from a screen
  // set or a project's screens, so the matrix only shows the projects those screens reach.
  const [reportProjectScope, setReportProjectScope] = React.useState([]);

  // The one entry point every "build a field report from X" affordance calls: seed the field
  // selection and (optionally) the project scope, then jump to Reports and generate.
  const buildFieldReport = React.useCallback((fieldIds, projectIds = []) => {
    setSelectedFieldIds(Array.from(new Set((fieldIds || []).map(String))));
    setReportProjectScope(Array.from(new Set((projectIds || []).map(String))));
    setReportsInitialSection("usage");
    setActiveTab("reports");
    setPendingReportGenerate(true);
  }, []);

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writeStored(STORAGE_THEME, theme);
  }, [theme]);

  React.useEffect(() => {
    writeStored(STORAGE_SIDEBAR, sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  React.useEffect(() => {
    writeStored(STORAGE_TAB, activeTab);
  }, [activeTab]);

  React.useEffect(() => {
    try {
      view.setAutoResizing(true);
    } catch {}
  }, []);

  async function loadOverview({ quiet = false } = {}) {
    if (!quiet) setLoadingOverview(true);
    try {
      const data = await invoke("getAdminOverview");
      setOverview(data);
      setOverviewLoadedAt(new Date().toISOString());
      setConfig(data.config);
    } catch (err) {
      if (!quiet) setError(err.message || "Failed to load overview.");
    } finally {
      setLoadingOverview(false);
    }
  }

  React.useEffect(() => {
    loadOverview();
    view
      .getContext()
      .then((ctx) => {
        const origin = normalizeSiteOrigin(ctx?.siteUrl || ctx?.extension?.siteUrl || ctx?.extensionContext?.siteUrl);
        if (origin) setSiteOrigin(origin);
      })
      .catch(() => {});
  }, []);

  function toggleFieldSelection(fieldId, checked) {
    setSelectedFieldIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(fieldId);
      else next.delete(fieldId);
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

  return (
    <>
      {/* The skies are siblings of .admin-shell, never children. The shell's z-index: 1 only
          lifts the app above them when they sit outside its stacking context; inside it, the
          fixed z-index: 0 canvas painted over every non-positioned element -- invisible at
          night (the starfield is mostly transparent), but the opaque day sky blanked the page. */}
      <Starfield active={theme === "dark"} bearing={activeTab} />
      <DaySky active={theme === "day"} />
      <div className="admin-shell">
        <div className={`admin-layout${sidebarCollapsed ? " admin-layout--collapsed" : ""}`}>
          <aside className="admin-sidebar">
            <div className="admin-sidebar__brand">
              <span className="admin-sidebar__logo">{sidebarCollapsed ? "O" : "Observatory"}</span>
              {!sidebarCollapsed && <span className="admin-badge">Admin</span>}
            </div>

            <nav className="admin-nav" aria-label="Admin navigation">
              {ADMIN_NAV_TABS.map(({ key, label, icon, group }, index) => {
                // A dot only when there is something to say: unmeasured, or scoring in the
                // warning band. A healthy pillar stays quiet, or the dots stop meaning anything.
                const status = pillarNavStatus(key, overview?.health);
                const dot = status && status.state !== "ok" ? status : null;
                const dotText = dot
                  ? dot.state === "unmeasured"
                    ? `Not measured yet: ${dot.label}`
                    : `Needs attention: ${dot.label}`
                  : null;
                const startsGroup = group && group !== ADMIN_NAV_TABS[index - 1]?.group;
                return (
                  <React.Fragment key={key}>
                    {startsGroup &&
                      (sidebarCollapsed ? (
                        <div className="admin-nav__divider" role="presentation" />
                      ) : (
                        <div className="admin-nav__group" role="presentation">
                          {group}
                        </div>
                      ))}
                    <button
                      className={`admin-nav__item${activeTab === key ? " admin-nav__item--active" : ""}`}
                      type="button"
                      onClick={() => navigate(key)}
                      aria-current={activeTab === key ? "page" : undefined}
                      aria-description={dotText || undefined}
                      title={sidebarCollapsed ? (dotText ? `${label} — ${dotText}` : label) : dotText || undefined}
                    >
                      <Icon name={icon} size={15} />
                      {!sidebarCollapsed && <span>{label}</span>}
                      {dot && <span className={`admin-nav__dot admin-nav__dot--${dot.state}`} aria-hidden="true" />}
                    </button>
                  </React.Fragment>
                );
              })}
            </nav>

            <div className="admin-sidebar__footer">
              <button
                className="admin-nav__item admin-nav__item--footer"
                onClick={() => setTheme((v) => THEME_CYCLE[v] || "dark")}
                type="button"
                title={
                  sidebarCollapsed
                    ? `Switch to ${THEME_META[THEME_CYCLE[theme] || "dark"].label.toLowerCase()}`
                    : undefined
                }
                aria-label={`Switch to ${THEME_META[THEME_CYCLE[theme] || "dark"].label.toLowerCase()}`}
              >
                <span>{THEME_META[THEME_CYCLE[theme] || "dark"].icon}</span>
                {!sidebarCollapsed && <span>{THEME_META[THEME_CYCLE[theme] || "dark"].label}</span>}
              </button>
              <button
                className="admin-nav__item admin-nav__item--footer admin-sidebar__collapse"
                onClick={() => setSidebarCollapsed((v) => !v)}
                type="button"
                title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                aria-pressed={sidebarCollapsed}
              >
                <Icon name={sidebarCollapsed ? "caretRight" : "caretLeft"} size={15} />
                {!sidebarCollapsed && <span>Collapse</span>}
              </button>
            </div>
          </aside>

          <div className="admin-content">
            {config?.readOnlyMode && (
              <div className="admin-readonly-banner">
                <Icon name="lock" size={14} />
                Read-only mode is on. Scans, inventory builds, remediation tickets and clearing data are paused for
                everyone, admins included. Turn it off under Configuration → Access.
              </div>
            )}

            {error && (
              <div className="error-banner" style={{ margin: "0 0 12px 0" }}>
                {error}
                <button
                  className="inline-text-button"
                  type="button"
                  onClick={() => setError("")}
                  style={{ marginLeft: 10 }}
                >
                  Dismiss
                </button>
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
                    onOpenRqtIndex={() => {
                      setReportsInitialSection("rqt");
                      setActiveTab("reports");
                    }}
                    onNavigate={navigate}
                    siteOrigin={siteOrigin}
                  />
                )
              ) : activeTab === "fields" ? (
                <FieldBrowserTab
                  intent={navIntent}
                  selectedFieldIds={selectedFieldIds}
                  onToggleField={toggleFieldSelection}
                  onSetSelectedFieldIds={setSelectedFieldIds}
                  onGoToReport={() => {
                    setActiveTab("reports");
                    setPendingReportGenerate(true);
                  }}
                  siteOrigin={siteOrigin}
                />
              ) : activeTab === "projects" ? (
                <ProjectUsageTab siteOrigin={siteOrigin} intent={navIntent} onBuildFieldReport={buildFieldReport} />
              ) : activeTab === "workflows" ? (
                <WorkflowTab intent={navIntent} siteOrigin={siteOrigin} />
              ) : activeTab === "issueTypes" ? (
                <IssueTypesTab intent={navIntent} siteOrigin={siteOrigin} />
              ) : activeTab === "fieldConfigs" ? (
                <FieldConfigsTab intent={navIntent} siteOrigin={siteOrigin} />
              ) : activeTab === "priorities" ? (
                <PrioritiesTab intent={navIntent} siteOrigin={siteOrigin} />
              ) : activeTab === "boards" ? (
                <BoardsTab intent={navIntent} siteOrigin={siteOrigin} />
              ) : activeTab === "people" ? (
                <PeopleTab intent={navIntent} siteOrigin={siteOrigin} />
              ) : activeTab === "assets" ? (
                <AssetsTab intent={navIntent} siteOrigin={siteOrigin} />
              ) : activeTab === "access" ? (
                <AccessTab intent={navIntent} siteOrigin={siteOrigin} />
              ) : activeTab === "screens" ? (
                <ScreensTab intent={navIntent} siteOrigin={siteOrigin} onBuildFieldReport={buildFieldReport} />
              ) : activeTab === "filters" ? (
                <FiltersTab siteOrigin={siteOrigin} intent={navIntent} />
              ) : activeTab === "dashboards" ? (
                <DashboardsTab siteOrigin={siteOrigin} intent={navIntent} />
              ) : activeTab === "automation" ? (
                <AutomationTab siteOrigin={siteOrigin} intent={navIntent} />
              ) : activeTab === "search" ? (
                <SearchTab onNavigate={navigate} />
              ) : activeTab === "remediation" ? (
                <RemediationTab siteOrigin={siteOrigin} intent={navIntent} />
              ) : activeTab === "reports" ? (
                <ReportsTab
                  siteOrigin={siteOrigin}
                  selectedFieldIds={selectedFieldIds}
                  onSetSelectedFieldIds={setSelectedFieldIds}
                  autoGenerate={pendingReportGenerate}
                  onAutoGenerateConsumed={() => setPendingReportGenerate(false)}
                  initialSection={reportsInitialSection}
                  projectScope={reportProjectScope}
                  onSetProjectScope={setReportProjectScope}
                  health={overview?.health ?? null}
                  healthScoredAt={overviewLoadedAt}
                  onRescore={() => loadOverview({ quiet: true })}
                />
              ) : activeTab === "changes" ? (
                <ChangesTab intent={navIntent} />
              ) : activeTab === "scans" ? (
                <ScansTab siteOrigin={siteOrigin} initialSection={scansInitialSection} />
              ) : (
                <ConfigTab config={config} onSave={handleSaveConfig} saving={savingConfig} />
              )}
            </React.Suspense>
          </div>
        </div>
      </div>
    </>
  );
}

const rootNode = document.getElementById("root");
if (rootNode) {
  try {
    ReactDOM.createRoot(rootNode).render(
      <React.StrictMode>
        <AdminApp />
      </React.StrictMode>,
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
