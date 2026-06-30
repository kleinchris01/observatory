import React from "react";
import {
  buildJiraSearchUrl,
  handleJiraLinkClick,
  openFieldExpertRovo,
  buildProjectRovoPrompt,
  toDisplayName,
  formatTimestamp,
  formatNumber,
} from "../utils";
import { Icon, CHART_PALETTE } from "./Icons";
import { SkeletonProjectItem, FindingsStrip, MetricChip } from "./FieldCard";

export function TopFieldsChart({ fields }) {
  const top = [...fields]
    .filter((f) => String(f.fieldId || "").startsWith("customfield_"))
    .sort((a, b) => b.issueCount - a.issueCount)
    .slice(0, 8);
  const max = top[0]?.issueCount || 1;
  if (!top.length) return null;
  return (
    <div className="project-chart">
      <div className="chart-title">Top fields by issue count</div>
      <div className="chart-bar-list">
        {top.map((field, i) => {
          const pct = Math.max(3, Math.round((field.issueCount / max) * 100));
          return (
            <div className="chart-bar-row" key={field.fieldId}>
              <span className="chart-bar-label" title={field.fieldName}>{field.fieldName}</span>
              <div className="chart-bar-track">
                <div
                  className="chart-bar-fill"
                  style={{ width: `${pct}%`, background: CHART_PALETTE[i % CHART_PALETTE.length] }}
                />
              </div>
              <span className="chart-bar-count">{formatNumber(field.issueCount)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function FieldTypeDonut({ fields }) {
  if (!fields.length) return null;
  const counts = {};
  for (const f of fields) {
    counts[f.fieldType] = (counts[f.fieldType] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 7);
  const total = entries.reduce((s, [, c]) => s + c, 0);
  const r = 40;
  const circumference = 2 * Math.PI * r;
  let acc = 0;
  const segments = entries.map(([type, count], i) => {
    const dash = (count / total) * circumference;
    const seg = { type, count, color: CHART_PALETTE[i % CHART_PALETTE.length], dash, acc };
    acc += dash;
    return seg;
  });
  return (
    <div className="project-chart">
      <div className="chart-title">Field types on this project</div>
      <div className="project-chart__donut-layout">
        <svg className="donut-svg" viewBox="0 0 108 108" width="100" height="100" aria-hidden="true">
          <g transform="rotate(-90, 54, 54)">
            {segments.map((seg) => (
              <circle
                key={seg.type}
                cx={54}
                cy={54}
                r={r}
                fill="none"
                stroke={seg.color}
                strokeWidth="15"
                strokeDasharray={`${seg.dash} ${circumference - seg.dash}`}
                strokeDashoffset={-seg.acc}
              />
            ))}
          </g>
        </svg>
        <div className="chart-legend">
          {segments.map((seg) => (
            <div className="chart-legend-item" key={seg.type}>
              <span className="chart-legend-dot" style={{ background: seg.color }} />
              <span className="chart-legend-label" title={seg.type}>{seg.type}</span>
              <span className="chart-legend-count">{seg.count}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
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
