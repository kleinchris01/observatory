import React from "react";
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  buildJiraSearchUrl,
  handleJiraLinkClick,
  openFieldExpertRovo,
  buildProjectRovoPrompt,
  toDisplayName,
  formatTimestamp,
  formatNumber,
  isCustomField,
} from "../utils";
import { Icon, useChartPalette } from "./Icons";
import { SkeletonProjectItem, FindingsStrip, MetricChip } from "./FieldCard";

function ChartTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const { name, value } = payload[0];
  return (
    <div className="chart-tooltip">
      <span className="chart-tooltip__label">{name}</span>
      <span className="chart-tooltip__value">{formatNumber(value)}</span>
    </div>
  );
}

export function TopFieldsChart({ fields }) {
  const palette = useChartPalette();
  const top = [...fields]
    .filter((f) => String(f.fieldId || "").startsWith("customfield_") && !f.isJiraBuiltin)
    .sort((a, b) => b.issueCount - a.issueCount)
    .slice(0, 8)
    .map((field) => ({ name: field.fieldName, value: field.issueCount, fieldId: field.fieldId }));
  if (!top.length) return null;
  const chartHeight = Math.max(160, top.length * 34);
  return (
    <div className="project-chart">
      <div className="chart-title">Top fields by issue count</div>
      <div style={{ width: "100%", height: chartHeight }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={top} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }}>
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="name"
              width={140}
              tick={{ fontSize: 12, fill: "var(--muted)" }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--stroke)" }} />
            <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={18}>
              {top.map((entry, i) => (
                <Cell key={entry.fieldId} fill={palette[i % palette.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function FieldTypeDonut({ fields }) {
  const palette = useChartPalette();
  // System fields are excluded: they appear on every issue in every project, so counting
  // them describes Jira rather than this project. They also distort the chart badly --
  // each contributes its own name as a one-count "type", so a project with 12 custom
  // fields and 5 system fields renders as five slivers around one dominant wedge.
  const customFields = fields.filter((f) => isCustomField(f.fieldId));
  const systemFieldCount = fields.length - customFields.length;
  if (!customFields.length) return null;

  const counts = {};
  for (const f of customFields) {
    counts[f.fieldType] = (counts[f.fieldType] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 7);
  const segments = entries.map(([type, count]) => ({ name: type, value: count }));
  return (
    <div className="project-chart">
      <div className="chart-title">
        Custom field types on this project
        {systemFieldCount > 0 && (
          <span className="chart-title__note"> · {systemFieldCount} system field{systemFieldCount === 1 ? "" : "s"} excluded</span>
        )}
      </div>
      <div className="project-chart__donut-layout">
        <div style={{ width: 120, height: 120, flexShrink: 0 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={segments}
                dataKey="value"
                nameKey="name"
                innerRadius={32}
                outerRadius={54}
                paddingAngle={2}
                stroke="none"
              >
                {segments.map((seg, i) => (
                  <Cell key={seg.name} fill={palette[i % palette.length]} />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-legend">
          {segments.map((seg, i) => (
            <div className="chart-legend-item" key={seg.name}>
              <span className="chart-legend-dot" style={{ background: palette[i % palette.length] }} />
              <span className="chart-legend-label" title={seg.name}>{seg.name}</span>
              <span className="chart-legend-count">{seg.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Which workflow scheme governs this project, and which other projects share it.
//
// The correlation this enables is the point: two projects on the same workflow scheme are
// meant to run the same process, so a large divergence in their custom field usage is a
// standardization signal that neither the field view nor the workflow view shows alone.
// Rendered only when a workflow snapshot exists -- the field view must never depend on it.
function ProjectWorkflowPanel({ scheme, fieldCount }) {
  if (!scheme) return null;

  const shared = scheme.sharedWithCount || 0;

  return (
    <section className="project-workflow">
      <div className="project-workflow__head">
        <span className="project-workflow__label">Workflow scheme</span>
        <span className="project-workflow__name">{scheme.name}</span>
        {shared > 0 && (
          <span className="project-workflow__shared">
            shared with {shared} other {shared === 1 ? "project" : "projects"}
          </span>
        )}
        {shared === 0 && <span className="project-workflow__shared">used only by this project</span>}
      </div>

      {scheme.description && <p className="project-workflow__desc">{scheme.description}</p>}

      {shared > 0 && (
        <>
          <p className="project-workflow__hint">
            These projects run the same process. Comparing their field usage against this
            project&apos;s {formatNumber(fieldCount)} fields is where standardization
            opportunities show up.
          </p>
          <div className="project-workflow__siblings">
            {scheme.siblingProjects?.map((sibling) => (
              <span key={sibling.projectId} className="project-workflow__sibling" title={sibling.projectName}>
                {sibling.projectKey}
              </span>
            ))}
            {shared > (scheme.siblingProjects?.length || 0) && (
              <span className="project-workflow__sibling project-workflow__sibling--more">
                +{shared - (scheme.siblingProjects?.length || 0)} more
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function ProjectsTabView({
  data,
  loading,
  siteOrigin,
  selectedProjectId,
  onSelectProject,
  projectQuery,
  onProjectQueryChange,
  fieldQuery,
  onFieldQueryChange,
  fieldType,
  onFieldTypeChange,
  fieldSort,
  onFieldSortChange,
  onChangePage,
  onRestoreProjectUsageCache,
  projectUsageRestoring,
}) {
  const projects = data?.projects || [];
  const selectedProject = data?.selectedProject || null;
  const fields = data?.fields || [];
  const availableTypes = data?.availableTypes || [];
  const totalFields = Number(data?.totalFields || 0);
  const page = Number(data?.page || 1);
  const totalPages = Number(data?.totalPages || 1);
  const refreshedAt = data?.refreshedAt || null;
  const currentProjectIndex = Math.max(0, projects.findIndex((project) => project.projectId === selectedProjectId));
  const previousProject = currentProjectIndex > 0 ? projects[currentProjectIndex - 1] : null;
  const nextProject = currentProjectIndex >= 0 && currentProjectIndex < projects.length - 1 ? projects[currentProjectIndex + 1] : null;

  return (
    <section className="snapshot-log-view">
      <div className="snapshot-log-layout projects-view">
        <aside className="builds-panel projects-rail">
          <div className="section-heading">
            <div>
              <div className="snapshot-log-entries__heading">Projects</div>
              <div className="saved-reports-panel__subtitle">
                Switch between projects and review every field with detected usage on that project.
              </div>
            </div>
          </div>
          <label className="toolbar__field">
            <span>Project search</span>
            <input
              type="search"
              placeholder="Project key or name"
              value={projectQuery}
              onChange={(event) => onProjectQueryChange(event.target.value)}
              data-search-input="primary"
            />
          </label>
          <div className="projects-rail__list">
            {loading && !projects.length ? (
              Array.from({ length: 5 }, (_, i) => <SkeletonProjectItem key={i} />)
            ) : projects.length ? projects.map((project) => {
              const active = project.projectId === selectedProjectId;
              return (
                <button
                  key={project.projectId}
                  className={`projects-rail__item ${active ? "projects-rail__item--active" : ""}`}
                  type="button"
                  onClick={() => onSelectProject(project.projectId)}
                >
                  <div className="projects-rail__item-top">
                    <strong>{project.projectKey}</strong>
                    <span>
                      {project.uniqueIssueCount != null
                        ? `${formatNumber(project.uniqueIssueCount)} issues`
                        : `${formatNumber(project.totalIssueCount)} fills`}
                    </span>
                  </div>
                  <div className="projects-rail__item-bottom">
                    <span>{project.projectName}</span>
                    <span>{formatNumber(project.fieldCount)} fields</span>
                  </div>
                </button>
              );
            }) : (
              <div className="empty-state empty-state--inline">
                {loading ? "Loading projects..." : (
                  <>
                    <p style={{ margin: "0 0 8px" }}>No projects with cached field usage were found.</p>
                    {onRestoreProjectUsageCache ? (
                      <button
                        className="secondary-button secondary-button--small"
                        type="button"
                        onClick={onRestoreProjectUsageCache}
                        disabled={projectUsageRestoring}
                      >
                        {projectUsageRestoring ? "Restoring..." : "Restore from field summaries"}
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            )}
          </div>
        </aside>

        <div className="snapshot-log-entries">
          <div className="section-heading">
            <div>
              <div className="snapshot-log-entries__heading">
                {selectedProject ? `${selectedProject.projectKey} project usage` : "Project usage"}
              </div>
              <div className="saved-reports-panel__subtitle">
                {selectedProject
                  ? `${selectedProject.projectName} · refreshed ${formatTimestamp(refreshedAt)}`
                  : "Select a project to inspect cached field usage."}
              </div>
            </div>
            {selectedProject ? (
              <div className="section-heading__actions">
                <button
                  className="secondary-button secondary-button--small"
                  type="button"
                  onClick={() => previousProject && onSelectProject(previousProject.projectId)}
                  disabled={!previousProject}
                >
                  Previous project
                </button>
                <button
                  className="secondary-button secondary-button--small"
                  type="button"
                  onClick={() => nextProject && onSelectProject(nextProject.projectId)}
                  disabled={!nextProject}
                >
                  Next project
                </button>
              </div>
            ) : null}
          </div>

          {selectedProject ? (
            <>
              <div className="report-dashboard__metric-grid report-dashboard__metric-grid--3">
                <article className="report-insight-card">
                  <div className="report-insight-card__label">Projects in snapshot</div>
                  <div className="report-insight-card__value">{formatNumber(projects.length)}</div>
                  <div className="report-insight-card__meta">Quick switch between every cached project</div>
                </article>
                <article className="report-insight-card">
                  <div className="report-insight-card__label">Fields with usage</div>
                  <div className="report-insight-card__value">{formatNumber(selectedProject.fieldCount)}</div>
                  <div className="report-insight-card__meta">Fields where at least one issue has a populated value on this project</div>
                </article>
                {selectedProject.uniqueIssueCount != null ? (
                  <article className="report-insight-card">
                    <div className="report-insight-card__label">Unique issues</div>
                    <div className="report-insight-card__value">{formatNumber(selectedProject.uniqueIssueCount)}</div>
                    <div className="report-insight-card__meta">Distinct issues in this project from the universe scan</div>
                  </article>
                ) : (
                  <article className="report-insight-card">
                    <div className="report-insight-card__label">Field fills</div>
                    <div className="report-insight-card__value">{formatNumber(selectedProject.totalIssueCount)}</div>
                    <div className="report-insight-card__meta">Sum of issue counts across all fields — run a universe scan for unique issue counts</div>
                  </article>
                )}
              </div>

              <ProjectWorkflowPanel scheme={data?.workflowScheme} fieldCount={selectedProject.fieldCount} />

              {fields.length > 0 && (
                <div className="project-charts-row">
                  <TopFieldsChart fields={fields} />
                  <FieldTypeDonut fields={fields} />
                </div>
              )}

              <section className="report-filters">
                <label className="toolbar__field">
                  <span>Field search</span>
                  <input
                    type="search"
                    placeholder="Field name, id, or description"
                    value={fieldQuery}
                    onChange={(event) => onFieldQueryChange(event.target.value)}
                  />
                </label>
                <label className="toolbar__field">
                  <span>Field type</span>
                  <select value={fieldType} onChange={(event) => onFieldTypeChange(event.target.value)}>
                    <option value="all">All types</option>
                    {availableTypes.map((typeOption) => (
                      <option key={typeOption} value={typeOption}>{typeOption}</option>
                    ))}
                  </select>
                </label>
                <label className="toolbar__field">
                  <span>Sort</span>
                  <select value={fieldSort} onChange={(event) => onFieldSortChange(event.target.value)}>
                    <option value="issues-desc">Most issues on project</option>
                    <option value="issues-asc">Fewest issues on project</option>
                    <option value="updated-desc">Most recently updated</option>
                    <option value="updated-asc">Least recently updated</option>
                    <option value="name-asc">Name A-Z</option>
                    <option value="name-desc">Name Z-A</option>
                  </select>
                </label>
              </section>

              <div className="project-usage-list projects-view__fields">
                {loading && !fields.length ? (
                  Array.from({ length: 4 }, (_, i) => (
                    <div key={i} className="skel-field-card" style={{ marginBottom: 8 }}>
                      <div className="skel-field-card__title">
                        <div className="skel" style={{ height: 10, width: "28%" }} />
                        <div className="skel" style={{ height: 16, width: "65%" }} />
                        <div className="skel" style={{ height: 11, width: "85%" }} />
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <div className="skel" style={{ flex: 1, height: 48 }} />
                        <div className="skel" style={{ flex: 1, height: 48 }} />
                        <div className="skel" style={{ flex: 1, height: 48 }} />
                      </div>
                      <div />
                    </div>
                  ))
                ) : fields.length ? fields.map((field) => {
                  const href = buildJiraSearchUrl(siteOrigin, field.jql);
                  return (
                    <article className="project-usage-card" key={`${selectedProject.projectId}-${field.fieldId}`}>
                      <div className="project-usage-card__head">
                        <div>
                          <div className="field-card__eyebrow">{field.fieldId}</div>
                          <h4>{field.fieldName}</h4>
                          <p>{field.description || "No admin description is set for this field."}</p>
                        </div>
                        <div className="project-usage-card__head-actions">
                          <MetricChip label="Type" value={field.fieldType} tone="cool" />
                          <MetricChip label="Issues on project" value={formatNumber(field.issueCount)} tone="success" />
                          <MetricChip label="Active projects" value={formatNumber(field.activeProjectCount)} tone="cool" />
                        </div>
                      </div>
                      <div className="project-usage-card__body">
                        <div className="section-heading">
                          <div className="section-heading__actions">
                            <FindingsStrip findings={field.findings} />
                          </div>
                        </div>
                        {href ? (
                          <a className="smart-link-card" href={href} target="_blank" rel="noreferrer" onClick={(e) => handleJiraLinkClick(e, href)}>
                            <span className="smart-link-card__title">Open Jira search for {formatNumber(field.issueCount)} issues</span>
                            <code>{field.jql}</code>
                          </a>
                        ) : (
                          <div className="empty-state empty-state--inline">No JQL link is available for this field/project pair.</div>
                        )}
                      </div>
                    </article>
                  );
                }) : (
                  <div className="empty-state empty-state--inline">
                    No fields matched the current project filters.
                  </div>
                )}
              </div>

              <section className="pagination-bar">
                <span className="pagination-bar__status">
                  {totalFields
                    ? `Showing ${(page - 1) * (data?.pageSize || 24) + 1}-${Math.min(page * (data?.pageSize || 24), totalFields)} of ${totalFields} fields on ${selectedProject.projectKey}`
                    : `No field usage rows are cached for ${selectedProject.projectKey}`}
                </span>
                <div className="pagination-bar__actions">
                  <button className="secondary-button" type="button" onClick={() => onChangePage(1)} disabled={page === 1 || !totalFields}>
                    First
                  </button>
                  <button className="secondary-button" type="button" onClick={() => onChangePage(Math.max(1, page - 1))} disabled={page === 1 || !totalFields}>
                    Previous
                  </button>
                  <button className="secondary-button" type="button" onClick={() => onChangePage(Math.min(totalPages, page + 1))} disabled={page === totalPages || !totalFields}>
                    Next
                  </button>
                  <button className="secondary-button" type="button" onClick={() => onChangePage(totalPages)} disabled={page === totalPages || !totalFields}>
                    Last
                  </button>
                </div>
              </section>
            </>
          ) : (
            <div className="empty-state">No cached projects are available yet. Build project usage for at least one field first.</div>
          )}
        </div>
      </div>
    </section>
  );
}
