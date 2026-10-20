// The resolver registry. Every resolver lives in its domain module under src/resolvers/; this
// file only registers them. SHARED_RESOLVER_FUNCTIONS is the Confluence macro's surface;
// RAW_ADMIN_ONLY_FUNCTIONS is the admin page's, wrapped once by withAdminGuard and
// withAuditTrail so nothing can be registered unguarded. It also re-exports what index.js,
// full-scan-runner.js and the tests import, so they never reach into the modules directly.
// See docs/resolvers-refactor.md.

import {
  getWorkflowRuleUsage,
  getWorkflowRules,
  getWorkflowRestrictions,
  getWorkflowRuleInsights,
} from "./lib/workflow-rule-reads.js";
import { getFieldConfigInventory, getFieldConfigItems, getFieldBehaviour } from "./lib/fieldconfig-reads.js";
import { getAdminConfigResolver, saveAdminConfigResolver } from "./resolvers/admin-config.js";
import { withAdminGuard, withAuditTrail } from "./resolvers/admin-guard.js";
import { probeServiceManagementApi, getJsmInventory, buildJsmInventory } from "./resolvers/jsm.js";
import { probeMarketplaceApps } from "./resolvers/apps.js";
import { checkMacroAccess } from "./resolvers/macro-access.js";
import { getIssueTypeInventory, buildIssueTypeInventory } from "./resolvers/issue-types.js";
import { getUserInventory, getUserDetails, getHandoverReport, buildUserInventory } from "./resolvers/people.js";
import { getAccessInventory, buildAccessInventory, probeGlobalPermissions } from "./resolvers/access.js";
import {
  getAssetInventory,
  buildAssetInventory,
  buildAssetTypeCountCrawl,
  probeAssetsApi,
} from "./resolvers/assets.js";
import { getBoardInventory, buildBoardInventory } from "./resolvers/boards.js";
import { getChangeHistory, buildChangeHistory } from "./resolvers/changes.js";
import { getEstateInventory, buildEstateInventory } from "./resolvers/estate.js";
import { getRqtIndex, searchRqtValue } from "./resolvers/rqt.js";
import {
  getMacroFilters,
  getMacroDashboards,
  getMacroScreens,
  getMacroIssueTypes,
  getMacroBoards,
  getMacroWorkflows,
} from "./resolvers/macro.js";
import {
  getFilterInventory,
  buildFilterInventory,
  getFieldFilterCounts,
  getFieldDashboardCounts,
  getDashboardUsage,
  getFilterUsage,
  getDashboardInventory,
  buildDashboardInventory,
} from "./resolvers/filters-dashboards.js";
import {
  getScreenInventory,
  getFieldScreenCounts,
  getFieldScreenReachability,
  buildScreenInventory,
  probeScreenFetchCost,
  getScreenFieldCrossSignal,
  getScreenFieldReportInputs,
  getProjectScreenReportInputs,
} from "./resolvers/screens.js";
import {
  getAutomationInsights,
  saveAutomationAnalysis,
  saveAutomationIndex,
  getAutomationCascades,
  getCascadeGraph,
  getAutomationBlast,
  getStatusAutomationUsage,
  getAutomationIndex,
  getAutomationFieldUsage,
  getAutomationFieldCounts,
  probeAutomationApi,
} from "./resolvers/automation.js";
import {
  getFieldInventory,
  buildFieldConfigInventory,
  getFieldDetails,
  getFilteredFieldIds,
  searchFieldOptions,
  getFieldOptions,
} from "./resolvers/fields.js";
import { getWorkflowInventory, getWorkflowInsights, getStatusDetail } from "./resolvers/workflows.js";
import { getDeletionSafety } from "./resolvers/deletion-safety.js";
import {
  getProjectUsageJobs,
  refreshRecentProjectUsage,
  cancelProjectUsageJob,
  restartProjectUsageJob,
  resumeProjectUsageJob,
  getSavedReports,
  saveReportDefinition,
  deleteReportDefinition,
  getProjectUsageReport,
  startProjectUsageReportJob,
  getProjectUsageReportJob,
  getProjectsView,
  restoreProjectUsageCache,
} from "./resolvers/project-usage.js";
import {
  cancelSnapshot,
  clearSnapshot,
  startFullSiteScan,
  resumeSiteScan,
  cancelSiteScan,
  getFullScanStatus,
  startQuickSiteScan,
  getQuickScanStatus,
  startIssueScan,
  resumeIssueScan,
  getIssueScanStatus,
  cancelIssueScan,
  startDeltaIssueScan,
  getDeltaIssueScanStatus,
} from "./resolvers/scans.js";
import {
  getRemediationTickets,
  getRemediationVerification,
  applyRemediationVerification,
  getRemediationMetrics,
  syncRemediationNow,
  organiseRemediationHierarchy,
  createRemediationEpic,
  getRemediationCandidates,
} from "./resolvers/remediation.js";
import {
  getFirstRunState,
  setFirstRunState,
  getAdminOverview,
  getSnapshotStatus,
  getHealthHistory,
} from "./resolvers/overview.js";
import { getPillarUsage, getPillarHealth, getPillarReport, runOqlQuery, searchEntities } from "./resolvers/reports.js";
import { getProjectOverview } from "./resolvers/project-overview.js";
import { getAuditLog, getSecuritySignals, migrateNamespaceKeys } from "./resolvers/admin-tools.js";
export {
  rovoSearchAutomationRules,
  rovoInspectAutomationRule,
  rovoAutomationUsage,
} from "./resolvers/rovo/automation.js";
export { rovoProjectSearch, rovoProjectInspect } from "./resolvers/rovo/projects.js";
export { rovoChangeSearch, rovoChangeInspect } from "./resolvers/rovo/changes.js";
export { rovoBoardSearch, rovoBoardInspect, rovoBoardImpact } from "./resolvers/rovo/boards.js";
export { rovoScreenSearch, rovoScreenInspect, rovoScreenImpact } from "./resolvers/rovo/screens.js";
export { rovoEstateSearch, rovoEstateInspect } from "./resolvers/rovo/estate.js";
export { rovoJsmSearch, rovoJsmInspect, rovoJsmImpact } from "./resolvers/rovo/jsm.js";
export { rovoAssetSearch, rovoAssetInspect, rovoAssetImpact } from "./resolvers/rovo/assets.js";
export { rovoPeopleSearch, rovoPeopleInspect, rovoPeopleImpact } from "./resolvers/rovo/people.js";
export { rovoAccessSearch, rovoAccessInspect, rovoAccessImpact } from "./resolvers/rovo/access.js";
export { rovoIssueTypeSearch, rovoIssueTypeInspect, rovoIssueTypeImpact } from "./resolvers/rovo/issue-types.js";
export { rovoWorkflowSearch, rovoWorkflowInspect, rovoWorkflowImpact } from "./resolvers/rovo/workflows.js";
export { rovoSearchFields, rovoInspectField } from "./resolvers/rovo/fields.js";
export { migrateNamespaceKeys } from "./resolvers/admin-tools.js";
export { OQL_RESULT_LIMIT } from "./resolvers/reports.js";
export { getFirstRunState, setFirstRunState, getAdminOverview, getSnapshotStatus } from "./resolvers/overview.js";
export {
  CLEAR_SNAPSHOT_CONFIRMATION,
  captureSiteHealthForScan,
  recordQuickScanScheduledRun,
  STUCK_SCAN_MS,
  isScanStuck,
  DELTA_SCOPE_SUFFIX,
  DELTA_ISSUE_SCAN_DEFAULT_WINDOW_HOURS,
  runDeltaIssueScanJob,
} from "./resolvers/scans.js";
export { getDeletionSafety } from "./resolvers/deletion-safety.js";
export { getScreenFieldCrossSignal, computeAndStoreScreenCross } from "./resolvers/screens.js";
export { __clearMacroAccessCache, MacroAccessError, withMacroAccessGuard } from "./resolvers/macro-access.js";
export { __resetAdminCheckCache, AdminPermissionError } from "./resolvers/admin-guard.js";
export { readAdminConfig, getAdminConfigResolver, saveAdminConfigResolver } from "./resolvers/admin-config.js";

// ---------------------------------------------------------------------------
// PII / data-retention audit note
// ---------------------------------------------------------------------------
// What user-derived data is persisted by this app:
//
//   progressLog entries  — Human-readable status messages written during
//     snapshot, issue-scan, and project-usage-job runs. These contain only
//     counts, timestamps, and field/project names — no issue content and no
//     Jira user IDs or account IDs.
//
//   scan statistics  — issue_scan_meta rows store counts (processedIssues,
//     totalIssues, pagesScanned) and timing only. No issue content is
//     persisted; the scanner reads issues at runtime and discards them after
//     aggregation.
//
//   fieldOptionsCache  — The replaceFieldOptionsCache / loadFieldOptionsCache
//     functions store field option *labels* as returned by the Jira Fields
//     API. These labels may contain user-entered values (e.g. option names
//     typed by a Jira admin). They are stored as-is to support the
//     searchFieldOptions resolver.
//
//   field_summaries / snapshot_fields  — Store field metadata (name, type,
//     project/issue counts) from the Jira custom fields catalogue. No issue
//     body content or user-identifiable data beyond field configuration is
//     stored.
//
// Recommended retention review:
//   Review annually and whenever a GDPR/data-subject access or erasure
//   request arrives. The KVS key ADMIN_CONFIG_KEY and all installation-scoped
//   keys can be enumerated via the project-store helpers for targeted erasure.
// ---------------------------------------------------------------------------

// All entries here must be safe for any authenticated Confluence user to call:
// pure reads, no sensitive admin data, no mutation of stored state.
export const SHARED_RESOLVER_FUNCTIONS = {
  checkMacroAccess, // Read-only: checks group membership for macro access gating
  getFieldInventory, // Read-only: returns paginated snapshot of custom field inventory
  getWorkflowInventory, // Read-only: returns paginated snapshot of workflow scheme / status inventory
  getWorkflowInsights, // Read-only: derived governance findings over the workflow snapshot
  getFieldDetails, // Read-only: returns detailed field data for a single field
  getProjectsView, // Read-only: returns per-project field usage view
  getFilteredFieldIds, // Read-only: returns filtered and sorted field ID list
  getFieldOptions, // Read-only: returns field option values from cache or Jira
  searchFieldOptions, // Read-only: searches cached field option labels
  getSavedReports, // Read-only: lists saved report definitions
  getProjectUsageReportJob, // Read-only: polls async report job status
  getProjectUsageReport, // Read-only: returns project usage data for given fields
  getMacroFilters, // Read-only: saved filters attached to the viewer's browsable projects
  getMacroDashboards, // Read-only: dashboards attached to the viewer's browsable projects
  getMacroWorkflows, // Read-only: workflow schemes + statuses for the viewer's browsable projects
  getMacroScreens, // Read-only: the forms the viewer's projects route to
  getMacroIssueTypes, // Read-only: issue type schemes governing the viewer's projects
  getMacroBoards, // Read-only: agile boards living in the viewer's projects
};

// Functions registered on adminHandler ONLY.
// Any function that mutates data, triggers background jobs, modifies config,
// or exposes governance internals must live here and nowhere else.
//
// Exported through withAdminGuard + withAuditTrail -- see above. Add new entries to the
// raw object; the wrapping is applied to the whole registry at export.
const RAW_ADMIN_ONLY_FUNCTIONS = {
  // Issue scan lifecycle â€” trigger and cancel full fieldÃ—issue scans
  startFullSiteScan, // Mutating: queues the one scan that runs every pillar
  startQuickSiteScan, // Mutating: queues the quick scan (full structural + delta issues)
  resumeSiteScan, // Mutating: re-kicks a stalled full/quick scan orchestrator
  cancelSiteScan, // Mutating: hard-stops a running full/quick scan, freeing the meta row
  getQuickScanStatus, // Admin read: per-stage progress of the quick scan
  getFirstRunState, // Admin read: the first-run checklist and the arrivals list
  setFirstRunState, // Admin write: acknowledge a first-run step, or dismiss the panel
  getFullScanStatus, // Admin read: per-stage progress of the full scan
  startIssueScan, // Mutating: queues a full issue scan job
  resumeIssueScan, // Mutating: re-queues incomplete issue scan workers
  cancelIssueScan, // Mutating: hard-stops the running issue scan
  getIssueScanStatus, // Admin read: exposes raw scan meta including progressLog

  // Delta issue scan â€” lightweight incremental scan
  startDeltaIssueScan, // Mutating: queues a delta (incremental) issue scan job
  getDeltaIssueScanStatus, // Admin read: exposes delta scan meta

  // Snapshot lifecycle
  cancelSnapshot, // Mutating: cancels in-progress snapshot build
  clearSnapshot, // Mutating: irreversibly deletes all derived snapshot data

  // Automation rule analysis
  getAutomationInsights, // Admin read: enumerates rule names, project scope and outbound hosts
  getAutomationIndex, // Admin read: field / status reference index and the rule directory
  getAutomationFieldUsage, // Admin read: the automation rules that touch one field
  getAutomationFieldCounts, // Admin read: enabled/disabled rule counts for a page of fields
  saveAutomationAnalysis, // Mutating: replaces the stored automation analysis document
  saveAutomationIndex, // Mutating: replaces one supporting index document

  // Project usage job management
  getProjectUsageJobs, // Admin read: lists all field-level project-usage jobs with logs
  cancelProjectUsageJob, // Mutating: cancels a running project-usage job
  restartProjectUsageJob, // Mutating: wipes and re-queues a project-usage job from scratch
  resumeProjectUsageJob, // Mutating: resumes a paused/failed project-usage job
  refreshRecentProjectUsage, // Mutating: triggers incremental refresh based on recent issue changes
  restoreProjectUsageCache, // Mutating: queues full restoration of project-usage from summaries

  // Report management â€” write operations on stored report definitions and async jobs
  saveReportDefinition, // Mutating: creates or updates a saved report definition
  deleteReportDefinition, // Mutating: deletes a saved report definition
  startProjectUsageReportJob, // Mutating: triggers an async project-usage report build job

  // RQT (required-query-token) index â€” internal governance analytics
  getRqtIndex, // Admin read: returns RQT field index and issue sample data
  searchRqtValue, // Admin read: looks up issues by RQT value token

  // Audit trail
  // Screen and scheme inventory
  getScreenInventory, // Admin read: screens, tabs, schemes and their mappings
  getFieldScreenCounts, // Admin read: screen counts for a page of fields
  getFieldScreenReachability, // Admin read: which screens carry one field
  buildScreenInventory, // Mutating: queues a full screen and scheme snapshot build

  // Issue type inventory
  getIssueTypeInventory, // Admin read: issue types by hierarchy, schemes and their routing
  buildIssueTypeInventory, // Mutating: queues a full issue type and scheme snapshot build

  // People pillar
  getUserInventory, // Admin read: the licensed-user roster with products, access groups and ownership counts
  getUserDetails, // Admin read: one user's owned filters / dashboards / automation rules
  getHandoverReport, // Admin read: what depends on one person's account, for offboarding
  buildUserInventory, // Mutating: queues a licensed-user roster build

  // JSM Assets (CMDB) pillar
  getAssetInventory, // Admin read: object schemas, their object types and attributes, with the governance summary
  buildAssetInventory, // Mutating: queues a JSM Assets structure snapshot build
  buildAssetTypeCountCrawl, // Mutating: queues the opt-in per-object-type AQL count crawl

  // Access pillar (permission / issue-security / notification schemes)
  getAccessInventory, // Admin read: the scheme types + project roles, their holders and project assignments, with governance
  buildAccessInventory, // Mutating: queues an access scheme snapshot build
  probeGlobalPermissions, // Admin read: whether the REST API exposes global-permission grants on this site

  // Configuration drift (the change-history timeline)
  getChangeHistory, // Admin read: one page of detected config changes + a trailing-window summary
  buildChangeHistory, // Mutating: queues a standalone drift pass

  // Estate config (the global value lists — resolutions, priorities)
  getEstateInventory, // Admin read: the resolution and priority lists with the duplicate-name governance summary
  buildEstateInventory, // Mutating: queues an estate-config snapshot build

  // Boards pillar (agile boards, their backing filters and column mapping)
  getBoardInventory, // Admin read: every board with its filter, location and columns (structure only for now)
  buildBoardInventory, // Mutating: queues a board snapshot build

  getAutomationCascades, // Admin read: one filtered page of cascade relationships
  getCascadeGraph, // Admin read: loops and multi-rule chains across every edge
  getAutomationBlast, // Admin read: one page of rules ordered by blast radius
  getRemediationTickets, // Admin read: remediation epics and tasks, grouped by finding
  getRemediationMetrics, // Admin read: remediation burn-down, throughput and ageing
  getPillarUsage, // Admin read: issues, last 90 days and last used, per item of one pillar
  createRemediationEpic, // Mutating: creates a Jira epic + tasks for a governance finding
  organiseRemediationHierarchy, // Mutating: puts this quarter's epics under their pillar initiatives
  syncRemediationNow, // Mutating: queues a remediation status sync from Jira
  getRemediationVerification, // Admin read: did each remediation task's fix hold, per the latest scan
  applyRemediationVerification, // Mutating: reopens regressed tasks / closes fixed ones, with a comment, as the admin
  getRemediationCandidates, // Admin read: current items behind one finding, ready to ticket
  getStatusAutomationUsage, // Admin read: which rules reference one status, by direction
  getWorkflowRuleUsage, // Admin read: workflow rules and properties pointing at one field, group, role...
  getWorkflowRules, // Admin read: one page of transition conditions, validators and post-functions
  getWorkflowRestrictions, // Admin read: what each status locks down (edit, comment...) and to whom
  getWorkflowRuleInsights, // Admin read: workflow inventory, broken rule references, inactive workflows
  getFieldConfigInventory, // Admin read: field schemes / configurations, their projects and findings
  getFieldConfigItems, // Admin read: one scheme's or configuration's fields, paged
  getFieldBehaviour, // Admin read: what every scheme or configuration does to one field
  buildFieldConfigInventory, // Mutating: queues a field scheme / configuration build
  getStatusDetail, // Admin read: one status -- schemes, workflows, transitions, restrictions, deletion verdict
  getDashboardInventory, // Admin read: dashboards, their gadgets and their findings
  buildDashboardInventory, // Mutating: queues a rebuild of the dashboard snapshot
  getFilterInventory, // Admin read: saved filters, their findings and their references
  buildFilterInventory, // Mutating: queues a rebuild of the saved filter snapshot
  getFilterUsage,
  getDashboardUsage, // Admin read: which dashboards reach a field, via which gadget
  getFieldFilterCounts, // Admin read: saved-filter counts for a page of fields
  getFieldDashboardCounts, // Admin read: dashboard-gadget counts for a page of fields
  getHealthHistory, // Admin read: the site health series and per-dimension deltas
  getPillarHealth, // Admin read: one pillar of the score, for the tab it is about
  getPillarReport, // Admin read: one pillar's inventory as a normalized, exportable report
  runOqlQuery, // Admin read: an OQL query across every pillar's inventory
  searchEntities, // Admin read: Ctrl+K -- find an item by name or ID across every pillar
  getProjectOverview, // Admin read: every pillar that touches one project
  getDeletionSafety, // Admin read: every pillar's evidence about deleting a field
  getScreenFieldCrossSignal, // Admin read: screen reachability crossed with field usage
  getScreenFieldReportInputs, // Admin read: field union + project scope for a set of screens
  getProjectScreenReportInputs, // Admin read: a project's screens grouped by screen scheme
  getAuditLog, // Admin read: returns recent privileged-action records
  getSecuritySignals, // Admin read: guard denials in the last hour, for the Overview banner

  // Admin page surface. These were previously registered directly onto adminHandler in
  // index.js, which meant they sat outside this registry and therefore outside its
  // guard -- saveAdminConfig, which rewrites governance thresholds AND the macro access
  // group list, was reachable by any caller who could invoke it. Registered here so the
  // guard covers them like everything else.
  getAdminConfig: getAdminConfigResolver, // Admin read: returns full admin config
  saveAdminConfig: saveAdminConfigResolver, // Mutating: rewrites thresholds and access control
  getAdminOverview, // Admin read: dashboard aggregate
  getSnapshotStatus, // Admin read: the field snapshot's build status, for the Scans tab poll
  probeAutomationApi, // Admin read: reports which Jira endpoints answer, for diagnosis
  probeAssetsApi, // Admin read: confirms the JSM Assets API and workspace on this site
  probeServiceManagementApi, // Admin read: what the JSM API answers, per JSM pillar and build stage
  probeMarketplaceApps, // Admin read: which Marketplace-app signals this site answers, and the apps they reveal
  getJsmInventory, // Admin read: desks, request types, queues, SLA outcomes, organizations, with findings
  buildJsmInventory, // Mutating: queues a Service Management snapshot build
  probeScreenFetchCost, // Admin read: samples the cost of a full screen inventory pass
  migrateNamespaceKeys, // Mutating: rewrites scope keys across every table
};

// Order matters: the guard runs first, so an unauthorized caller is recorded as `denied`
// and never reaches the action, rather than producing both a denial and a failed action.
export const ADMIN_ONLY_FUNCTIONS = withAdminGuard(withAuditTrail(RAW_ADMIN_ONLY_FUNCTIONS));

// Unwrapped originals, for tests that need to exercise a resolver's own logic without
// standing up a permission mock. Never register these on a handler.
export const __RAW_ADMIN_ONLY_FUNCTIONS = RAW_ADMIN_ONLY_FUNCTIONS;
