import React from "react";
import { invoke, view } from "@forge/bridge";
import { buildJiraSearchUrl, downloadCsv, slugifyFilenamePart, groupReportFieldsByType, openFieldExpertRovo, buildReportRovoPrompt } from "../utils";
import { Icon } from "../components/Icons";
import { ReportErrorBoundary, ProjectUsageReportView } from "../components/ReportView";

// Field x project report builder and CSV export.

export function ReportsTab({ siteOrigin, selectedFieldIds, onSetSelectedFieldIds, autoGenerate, onAutoGenerateConsumed }) {
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

  async function generateReport(fieldIdsOverride = null, nameOverride = "") {
    const fieldIds = fieldIdsOverride?.length ? fieldIdsOverride : selectedFieldIds;
    if (!fieldIds.length) { setError("Select at least one field in the Field Browser to generate a report."); return; }
    setLoadingReport(true);
    setReportData(null);
    try {
      const nextName = nameOverride || reportNameInput.trim() || "Project Usage Report";
      setActiveReportName(nextName);
      const result = await invoke("getProjectUsageReport", { fieldIds });
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
    await generateReport(report.fieldIds || [], report.name || "");
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
      <div className="admin-reports-toolbar">
        <span className="admin-reports-toolbar__hint">Select fields in the Field Browser tab to build a report.</span>
        <button
          className="primary-button"
          type="button"
          onClick={() => generateReport()}
          disabled={loadingReport || !selectedFieldIds.length}
        >
          <Icon name="barChart" size={14} />
          {loadingReport ? "Generating…" : `Generate report (${selectedFieldIds.length} fields)`}
        </button>
      </div>
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
    </div>
  );
}
