import React from "react";
import { invoke, view } from "@forge/bridge";
import {
  buildJiraSearchUrl,
  downloadCsv,
  slugifyFilenamePart,
  groupReportFieldsByType,
  openFieldExpertRovo,
  buildReportRovoPrompt,
  PILLAR_REPORT_NAV,
  formatReportCell,
  reportToCsvRows,
  buildScorecardReport,
  buildPillarReportRovoPrompt,
  formatNumber,
  formatRelativeTime,
} from "../utils";
import { Icon } from "../components/Icons";
import {
  PageHeader,
  Chip,
  StatRow,
  StatTile,
  Panel,
  EmptyState,
  PanelGrid,
  GridSpan,
  PillarHealthPanel,
  AskRovo,
} from "../components/ui";
import { SubNavLayout } from "../components/admin/primitives";
import { ReportErrorBoundary, ProjectUsageReportView } from "../components/ReportView";
import { usePersistentState } from "../hooks";

// Reports: the analytical surface.
//
// Three groups, one per question:
//
//   Site        -- the governance scorecard: every pillar's dimensions in one exportable table.
//   Pillars     -- one inventory report per pillar, all in the same shape (getPillarReport):
//                  the same tiles, the same findings column, the same CSV, flagged rows first.
//                  A pillar that has not been scanned says so instead of showing an empty table.
//   Field tools -- the two field-specific reports that predate the rest, described below.
//
// Every pillar report renders through PillarReportBody, and so does the scorecard, which is
// the site health reshaped into the same report contract. That is the whole point of the
// tab: the Screens report and the People report differ only in their columns.
//
// The field tools are deliberately different from each other. The field x project report is
// *generated* -- you choose fields and build a matrix. The RQT index is a *standing*
// cross-reference the universe scan maintains for you.
//
// RQT moved here from Scans. It sat there because the universe scan builds it, which is a
// build dependency rather than an information-architecture one: Scans runs and monitors
// jobs, every other tab reads what those jobs produced. A cross-reference over field values
// is a report, and the Overview dashboard already linked to it as though it were one.

const RqtIndexView = React.lazy(() => import("./RqtTab").then((m) => ({ default: m.RqtIndexView })));

export function ReportsTab({
  siteOrigin,
  selectedFieldIds,
  onSetSelectedFieldIds,
  autoGenerate,
  onAutoGenerateConsumed,
  initialSection,
  projectScope = [],
  onSetProjectScope,
  health = null,
  healthScoredAt = null,
  onRescore,
}) {
  // A field-report hand-off (autoGenerate) always lands on the usage matrix it is building.
  const [activeSection, setActiveSection] = usePersistentState(
    "observatory.section.reports",
    "scorecard",
    initialSection || (autoGenerate ? "usage" : null),
  );
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
    invoke("getSavedReports")
      .then((r) => setSavedReports(r.reports || []))
      .catch(() => {});
    view
      .getContext()
      .then(() => setRovoEnabled(true))
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    if (autoGenerate && selectedFieldIds.length) {
      setActiveSection("usage");
      onAutoGenerateConsumed?.();
      generateReport();
    }
  }, [autoGenerate]);

  async function generateReport(fieldIdsOverride = null, nameOverride = "", scopeOverride = undefined) {
    const fieldIds = fieldIdsOverride?.length ? fieldIdsOverride : selectedFieldIds;
    if (!fieldIds.length) {
      setError("Select at least one field in the Field Browser to generate a report.");
      return;
    }
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
    if (!reportNameInput.trim()) {
      setError("Enter a report name before saving.");
      return;
    }
    setSavingReport(true);
    try {
      const existing = savedReports.find((r) => r.name.toLowerCase() === reportNameInput.trim().toLowerCase());
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
    if (!exportData?.fields?.length) {
      setError("No report data available to export.");
      return;
    }
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
      await openFieldExpertRovo(
        buildReportRovoPrompt({ reportName: activeReportName, fields, projects, pendingFields, reportSummary }),
      );
    } catch (err) {
      setError(err.message || "Failed to open Rovo.");
    }
  }

  return (
    <div className="admin-reports-tab">
      {error && (
        <div className="error-banner" style={{ margin: "0 0 12px 0" }}>
          {error}
          <button className="inline-text-button" type="button" onClick={() => setError("")} style={{ marginLeft: 10 }}>
            Dismiss
          </button>
        </div>
      )}
      <SubNavLayout
        items={[
          { key: "scorecard", label: "Governance scorecard", icon: "barChart", group: "Site" },
          ...PILLAR_REPORT_NAV.map(({ key, label, icon }) => ({ key, label, icon, group: "Pillars" })),
          { key: "usage", label: "Field usage matrix", icon: "clipboardText", group: "Field tools" },
          { key: "rqt", label: "RQT traceability", icon: "layers", group: "Field tools" },
        ]}
        activeKey={activeSection}
        onSelect={setActiveSection}
      >
        {activeSection === "scorecard" ? (
          <ScorecardSection health={health} scoredAt={healthScoredAt} onRescore={onRescore} />
        ) : PILLAR_REPORT_NAV.some((p) => p.key === activeSection) ? (
          <PillarReportSection key={activeSection} pillarKey={activeSection} health={health} />
        ) : activeSection === "rqt" ? (
          <React.Suspense fallback={<div className="empty-state">Loading…</div>}>
            <RqtIndexView siteOrigin={siteOrigin} />
          </React.Suspense>
        ) : (
          <>
            {/* Was a bespoke toolbar with the hint as a bare span. PageHeader gives Reports the
          same title/description/action shape every other tab opens with, which is most of
          why this tab used to read as a different product. */}
            <PageHeader
              title="Field usage matrix"
              description={
                projectScope.length
                  ? `Scoped to ${projectScope.length} ${projectScope.length === 1 ? "project" : "projects"} — the field data below is limited to where the chosen screens are applied.`
                  : "Select fields in the Field Browser tab to build a cross-project usage report."
              }
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
                  onRemove={() => {
                    onSetProjectScope?.([]);
                    generateReport(null, "", []);
                  }}
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
                reportJob={
                  loadingReport
                    ? {
                        status: "building",
                        processedFields: 0,
                        totalFields: selectedFieldIds.length,
                        percentComplete: 0,
                      }
                    : null
                }
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

// ── Pillar reports ────────────────────────────────────────────────────────

// Rows the preview renders. The CSV carries every row the server returned; the page only
// needs enough to show what the export will look like and where the findings are.
const PREVIEW_ROWS = 200;

function PillarReportSection({ pillarKey, health }) {
  const nav = PILLAR_REPORT_NAV.find((p) => p.key === pillarKey);
  const [report, setReport] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setReport(await invoke("getPillarReport", { pillar: pillarKey }));
    } catch (err) {
      setError(err?.message || "Could not build this report.");
    } finally {
      setLoading(false);
    }
  }, [pillarKey]);

  React.useEffect(() => {
    load();
  }, [load]);

  const healthPillars = (report?.healthPillars || [])
    .map((key) => (health?.pillars || []).find((p) => p.key === key))
    .filter(Boolean);

  return (
    <PillarReportBody
      title={`${nav?.label || "Pillar"} report`}
      report={report}
      loading={loading}
      error={error}
      onReload={load}
      agent={nav?.agent || null}
      governance={
        healthPillars.length ? (
          <PanelGrid>
            {healthPillars.map((p) => (
              <GridSpan key={p.key}>
                <PillarHealthPanel pillar={p} />
              </GridSpan>
            ))}
          </PanelGrid>
        ) : null
      }
    />
  );
}

function ScorecardSection({ health, scoredAt, onRescore }) {
  const report = React.useMemo(() => buildScorecardReport(health, { scoredAt }), [health, scoredAt]);
  const [rescoring, setRescoring] = React.useState(false);
  async function rescore() {
    setRescoring(true);
    try {
      await onRescore();
    } finally {
      setRescoring(false);
    }
  }
  return (
    <PillarReportBody
      title="Governance scorecard"
      description="Every pillar's governance dimensions in one table: the score the Overview shows, broken down to what it was scored from."
      report={report}
      loading={rescoring}
      onReload={onRescore ? rescore : null}
      reloadLabel="Rescore"
      agent={null}
    />
  );
}

// The one report layout. Header with the snapshot age and the export, the summary tiles,
// the caveats, the governance score beside it, then the rows.
export function PillarReportBody({
  title,
  description,
  report,
  loading = false,
  error = "",
  onReload = null,
  reloadLabel = "Refresh",
  agent = null,
  governance = null,
}) {
  const [flaggedOnly, setFlaggedOnly] = React.useState(false);
  const ok = report?.status === "ok";
  const columns = report?.columns || [];
  const hasFindings = columns.some((c) => c.key === "findings");
  const visible = ok ? (flaggedOnly ? report.rows.filter((r) => (r.findings || []).length > 0) : report.rows) : [];
  const preview = visible.slice(0, PREVIEW_ROWS);

  function exportCsv() {
    downloadCsv(`${slugifyFilenamePart(title, "pillar-report")}.csv`, reportToCsvRows(report));
  }

  const actions = (
    <>
      {agent && (
        <AskRovo
          agent={agent}
          scope="this report"
          context="the report's totals, its most common findings and the snapshot age"
          disabled={!ok}
          buildPrompt={() => buildPillarReportRovoPrompt(report)}
        />
      )}
      {onReload && (
        <button type="button" className="secondary-button" onClick={onReload} disabled={loading}>
          <Icon name="refreshCw" size={13} />
          {loading ? "Loading…" : reloadLabel}
        </button>
      )}
      <button
        type="button"
        className="primary-button"
        onClick={exportCsv}
        disabled={!ok || loading || report.total === 0}
      >
        Export CSV
      </button>
    </>
  );

  return (
    <div className="pillar-report">
      <PageHeader
        title={title}
        description={
          description ||
          (report?.entity
            ? `Every one of the ${report.entity} in the latest snapshot${hasFindings ? ", with the findings raised against each. Flagged rows first." : "."}`
            : undefined)
        }
        meta={ok && report.refreshedAt ? `Snapshot ${formatRelativeTime(report.refreshedAt)}` : null}
        actions={actions}
      />
      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : loading && !report ? (
        <EmptyState>Building the report…</EmptyState>
      ) : !ok ? (
        <EmptyState>{report?.reason || "This report is not available yet."}</EmptyState>
      ) : (
        <>
          <StatRow>
            {report.summary.map((tile) => (
              <StatTile
                key={tile.label}
                label={tile.label}
                value={typeof tile.value === "number" ? formatNumber(tile.value) : tile.value}
                hint={tile.hint}
                tone={tile.tone || "neutral"}
              />
            ))}
          </StatRow>
          {report.notes.length > 0 && (
            <ul className="pillar-report__notes">
              {report.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          {governance}
          <Panel title="Rows" icon="clipboardText">
            {report.rows.length === 0 ? (
              <EmptyState inline>Nothing in this snapshot.</EmptyState>
            ) : (
              <>
                <div className="pillar-report__toolbar">
                  <span>
                    Showing {formatNumber(preview.length)} of {formatNumber(visible.length)}
                    {preview.length < visible.length ? " — the CSV has them all" : ""}
                  </span>
                  {hasFindings && report.flaggedCount > 0 && (
                    <label>
                      <input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} />{" "}
                      Only rows with findings
                    </label>
                  )}
                </div>
                <div className="pillar-report__table-wrap">
                  <table className="audit-table pillar-report__table">
                    <thead>
                      <tr>
                        {columns.map((c) => (
                          <th key={c.key} className={c.kind === "number" ? "pillar-report__num" : undefined}>
                            {c.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((row, i) => (
                        <tr key={i}>
                          {columns.map((c) => (
                            <td key={c.key} className={c.kind === "number" ? "pillar-report__num" : undefined}>
                              {c.key === "findings" ? (
                                <span className="pillar-report__findings">
                                  {(row.findings || []).map((code) => (
                                    <Chip key={code} tone="warning">
                                      {code}
                                    </Chip>
                                  ))}
                                </span>
                              ) : (
                                <span title={formatReportCell(row[c.key], c.kind)}>
                                  {formatReportCell(row[c.key], c.kind) || "—"}
                                </span>
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
