import React from "react";
import { invoke, view } from "@forge/bridge";
import { buildJiraSearchUrl, downloadCsv, slugifyFilenamePart, groupReportFieldsByType, openFieldExpertRovo, buildReportRovoPrompt } from "../utils";
import { Icon } from "../components/Icons";
import { PageHeader, Chip } from "../components/ui";
import { SubNavLayout } from "../components/admin/primitives";
import { ReportErrorBoundary, ProjectUsageReportView } from "../components/ReportView";

// Reports: the analytical surface.
//
// Two kinds live here and they are deliberately different. The field x project report is
// *generated* -- you choose fields and build a matrix. The RQT index is a *standing*
// cross-reference the universe scan maintains for you.
//
// RQT moved here from Scans. It sat there because the universe scan builds it, which is a
// build dependency rather than an information-architecture one: Scans runs and monitors
// jobs, every other tab reads what those jobs produced. A cross-reference over field values
// is a report, and the Overview dashboard already linked to it as though it were one.

const RqtIndexView = React.lazy(() => import("./RqtTab").then((m) => ({ default: m.RqtIndexView })));

export function ReportsTab({ siteOrigin, selectedFieldIds, onSetSelectedFieldIds, autoGenerate, onAutoGenerateConsumed, initialSection, projectScope = [], onSetProjectScope }) {
  const [activeSection, setActiveSection] = React.useState(initialSection || "usage");
  const [reportData, setReportData] = React.useState(null);
  const [loadingReport, setLoadingReport] = React.useState(false);
  const [savedReports, setSavedReports] = React.useState([]);
  const [reportNameInput, setReportNameInput] = React.useState("");
  const [activeReportName, setActiveReportName] = React.useState("");
  const [savingReport, setSavingReport] = React.useState(false);
  const [deletingReportId, setDeletingReportId] = React.useState("");
  const [error, setError] = React.useState("");
  const [rovoEnabled, setRovoEnabled] = React.useState(false);

  React.useEffect(() => {
    invoke("getSavedReports").then((r) => setSavedReports(r.reports || [])).catch(() => {});
    view.getContext().then(() => setRovoEnabled(true)).catch(() => {});
  }, []);

  React.useEffect(() => {
    if (autoGenerate && selectedFieldIds.length) {
      onAutoGenerateConsumed?.();
      generateReport();
    }
  }, [autoGenerate]);

  async function generateReport(fieldIdsOverride = null, nameOverride = "", scopeOverride = undefined) {
    const fieldIds = fieldIdsOverride?.length ? fieldIdsOverride : selectedFieldIds;
    if (!fieldIds.length) { setError("Select at least one field in the Field Browser to generate a report."); return; }
    const projectIds = scopeOverride === undefined ? projectScope : scopeOverride;
    setLoadingReport(true);
    setReportData(null);
    try {
      const nextName = nameOverride || reportNameInput.trim() || "Project Usage Report";
      setActiveReportName(nextName);
      const result = await invoke("getProjectUsageReport", { fieldIds, projectIds });
      setReportData(result);
    } catch (err) {
      setError(err.message || "Failed to generate report.");
    } finally {
      setLoadingReport(false);
    }
  }

  async function saveCurrentReport() {
    if (!reportNameInput.trim()) { setError("Enter a report name before saving."); return; }
    setSavingReport(true);
    try {
      const existing = savedReports.find((r) => r.name.toLowerCase() === reportNameInput.trim().toLowerCase());
      const result = await invoke("saveReportDefinition", { reportId: existing?.reportId || "", name: reportNameInput.trim(), fieldIds: selectedFieldIds });
      setSavedReports(result.reports || []);
      setActiveReportName(reportNameInput.trim());
    } catch (err) {
      setError(err.message || "Failed to save report.");
    } finally {
      setSavingReport(false);
    }
  }

  async function loadSavedReport(report) {
    onSetSelectedFieldIds(report.fieldIds || []);
    setReportNameInput(report.name || "");
    // Saved reports are site-wide; loading one drops any screen-driven project scope.
    onSetProjectScope?.([]);
    await generateReport(report.fieldIds || [], report.name || "", []);
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

  function exportCsv(overrideData = null) {
    const exportData = overrideData || reportData;
    if (!exportData?.fields?.length) { setError("No report data available to export."); return; }
    const header = ["Field ID", "Field Name", ...exportData.projects.map((p) => p.projectKey)];
    const rows = [];
    // Second header row, only when workflow data exists. The export is a field x project
    // matrix, so putting each project's scheme directly under its column is what makes
    // the correlation readable: columns sharing a scheme are meant to run the same
    // process, and a field populated in one but not the others is the signal.
    if (exportData.projects.some((p) => p.workflowSchemeName)) {
      rows.push(["", "Workflow scheme", ...exportData.projects.map((p) => p.workflowSchemeName || "")]);
    }
    for (const group of groupReportFieldsByType(exportData.fields)) {
      rows.push([`${group.fieldType.toUpperCase()} FIELDS`, "", ...exportData.projects.map(() => "")]);
      for (const field of group.fields) {
        const cellByProjectId = new Map(field.projects.map((p) => [p.projectId, p]));
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

  async function askRovo({ fields, projects, pendingFields, reportSummary }) {
    try {
      await openFieldExpertRovo(buildReportRovoPrompt({ reportName: activeReportName, fields, projects, pendingFields, reportSummary }));
    } catch (err) {
      setError(err.message || "Failed to open Rovo.");
    }
  }

  return (
    <div className="admin-reports-tab">
      {error && <div className="error-banner" style={{ margin: "0 0 12px 0" }}>{error}<button className="inline-text-button" type="button" onClick={() => setError("")} style={{ marginLeft: 10 }}>Dismiss</button></div>}
      <SubNavLayout
        items={[
          { key: "usage", label: "Field usage", icon: "barChart" },
          { key: "rqt", label: "RQT traceability", icon: "layers" },
        ]}
        activeKey={activeSection}
        onSelect={setActiveSection}
      >
      {activeSection === "rqt" ? (
        <React.Suspense fallback={<div className="empty-state">Loading…</div>}>
          <RqtIndexView siteOrigin={siteOrigin} />
        </React.Suspense>
      ) : (
        <>
      {/* Was a bespoke toolbar with the hint as a bare span. PageHeader gives Reports the
          same title/description/action shape every other tab opens with, which is most of
          why this tab used to read as a different product. */}
      <PageHeader
        title="Reports"
        description={projectScope.length
          ? `Scoped to ${projectScope.length} ${projectScope.length === 1 ? "project" : "projects"} — the field data below is limited to where the chosen screens are applied.`
          : "Select fields in the Field Browser tab to build a cross-project usage report."}
        actions={
          <button
            className="primary-button"
            type="button"
            onClick={() => generateReport()}
            disabled={loadingReport || !selectedFieldIds.length}
          >
            <Icon name="barChart" size={14} />
            {loadingReport ? "Generating…" : `Generate report (${selectedFieldIds.length} fields)`}
          </button>
        }
      />
      {projectScope.length > 0 && (
        <div className="admin-field-browser__active-filters" style={{ marginBottom: 12 }}>
          <Chip
            tone="active"
            onRemove={() => { onSetProjectScope?.([]); generateReport(null, "", []); }}
            removeLabel="Clear the project scope and report across every project"
          >
            Project scope: {projectScope.length} {projectScope.length === 1 ? "project" : "projects"}
          </Chip>
        </div>
      )}
      <ReportErrorBoundary resetKey={`${activeReportName}-${selectedFieldIds.join(",")}`}>
        <ProjectUsageReportView
          reportData={reportData}
          reportName={activeReportName}
          reportJob={loadingReport ? { status: "building", processedFields: 0, totalFields: selectedFieldIds.length, percentComplete: 0 } : null}
          siteOrigin={siteOrigin}
          onExportCsv={exportCsv}
          onAskReport={askRovo}
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
        </>
      )}
      </SubNavLayout>
    </div>
  );
}
