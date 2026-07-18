import React from "react";
import { invoke } from "@forge/bridge";
import {
  buildJiraSearchUrl,
  handleJiraLinkClick,
  isSelectType,
  isUsageAvailable,
  mergeFieldMetrics,
  buildFieldRovoPrompt,
  buildProjectRovoPrompt,
  openFieldExpertRovo,
  toDisplayName,
  formatTimestamp,
  formatNumber,
} from "../utils";
import { Icon } from "./Icons";
import { FieldOptionsModal } from "./FieldOptionsModal";

export function MetricChip({ label, value, tone = "neutral" }) {
  return (
    <div className={`metric-chip metric-chip--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

const FINDING_BADGE_ICON = { danger: "alertTriangle", warn: "scissors", info: "info", neutral: "alertCircle" };

export function FindingBadge({ label, tone }) {
  return (
    <span className={`finding-badge finding-badge--${tone}`}>
      <Icon name={FINDING_BADGE_ICON[tone] || "alertCircle"} size={12} />
      {label}
    </span>
  );
}

export function FindingsStrip({ findings }) {
  if (!findings?.tags) return null;

  return (
    <div className="findings-strip">
      {findings.tags.adminAttention ? <FindingBadge label="Admin Attention" tone="danger" /> : null}
      {findings.tags.risky ? <FindingBadge label="Risk" tone="danger" /> : null}
      {findings.tags.cleanup ? <FindingBadge label="Cleanup" tone="warn" /> : null}
      {findings.tags.standardize ? <FindingBadge label="Standardize" tone="info" /> : null}
    </div>
  );
}

export function ProjectUsageBuildBadge({ field }) {
  const totalIssueCount = Number(field?.totalIssueCount || 0);
  const state = field?.projectUsageState || "unbuilt";

  if (totalIssueCount <= 0) {
    return null;
  }
  if (field?.projectUsageBuilt || state === "ready") {
    return null;
  }
  if (state === "queued" || state === "building") {
    return <FindingBadge label="Usage Building" tone="info" />;
  }
  if (state === "failed" || state === "cancelled") {
    return <FindingBadge label="Usage Incomplete" tone="warn" />;
  }
  return <FindingBadge label="Usage Not Built" tone="neutral" />;
}

export function SkeletonFieldCard() {
  return (
    <div className="skel-field-card">
      <div className="skel-field-card__title">
        <div className="skel" style={{ height: 10, width: "35%" }} />
        <div className="skel" style={{ height: 18, width: "70%" }} />
        <div className="skel" style={{ height: 12, width: "90%" }} />
        <div className="skel" style={{ height: 12, width: "60%" }} />
      </div>
      <div className="skel-field-card__meta">
        <div className="skel" style={{ height: 52 }} />
        <div className="skel" style={{ height: 52 }} />
        <div className="skel" style={{ height: 52 }} />
      </div>
      <div className="skel" style={{ width: 28, height: 28, borderRadius: "50%" }} />
    </div>
  );
}

export function SkeletonProjectItem() {
  return (
    <div className="skel-project-item">
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div className="skel" style={{ height: 14, width: "30%" }} />
        <div className="skel" style={{ height: 14, width: "25%" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div className="skel" style={{ height: 12, width: "55%" }} />
        <div className="skel" style={{ height: 12, width: "20%" }} />
      </div>
    </div>
  );
}

const INLINE_OPTIONS_COLLAPSE_THRESHOLD = 10;

export function InlineOptionsContext({ ctx }) {
  const activeOptions = ctx.options.filter((o) => !o.disabled);
  const disabledOptions = ctx.options.filter((o) => o.disabled);
  const total = ctx.options.length;
  const [expanded, setExpanded] = React.useState(total <= INLINE_OPTIONS_COLLAPSE_THRESHOLD);

  const visibleActive = expanded ? activeOptions : activeOptions.slice(0, INLINE_OPTIONS_COLLAPSE_THRESHOLD);
  const hiddenCount = total - INLINE_OPTIONS_COLLAPSE_THRESHOLD;

  if (ctx.fetchError) {
    return (
      <div className="inline-options">
        <div className="inline-options__header">
          <span className="inline-options__ctx-name">{ctx.contextName}{ctx.isGlobalContext ? " (global)" : ""}</span>
          <span className="field-options-modal__option-chip">{total} option{total !== 1 ? "s" : ""}</span>
        </div>
        <div className="empty-state empty-state--inline" style={{ color: "var(--danger, #c0392b)", padding: "6px 0" }}>
          Failed to load: {ctx.fetchError}
        </div>
      </div>
    );
  }

  return (
    <div className="inline-options">
      <div className="inline-options__header">
        <span className="inline-options__ctx-name">{ctx.contextName}{ctx.isGlobalContext ? " (global)" : ""}</span>
        <span className="field-options-modal__option-chip">{total} option{total !== 1 ? "s" : ""}</span>
      </div>
      <div className="inline-options__chips">
        {visibleActive.map((opt) => (
          <span key={opt.id} className="inline-options__chip">{opt.value}</span>
        ))}
        {expanded && disabledOptions.map((opt) => (
          <span key={opt.id} className="inline-options__chip inline-options__chip--disabled">{opt.value}</span>
        ))}
        {!expanded && hiddenCount > 0 && (
          <button
            type="button"
            className="inline-options__more"
            onClick={() => setExpanded(true)}
          >
            +{hiddenCount} more
          </button>
        )}
        {expanded && total > INLINE_OPTIONS_COLLAPSE_THRESHOLD && (
          <button
            type="button"
            className="inline-options__more"
            onClick={() => setExpanded(false)}
          >
            Show less
          </button>
        )}
      </div>
    </div>
  );
}

export function FieldCard({
  field,
  details,
  expanded,
  loading,
  selected,
  onSelectChange,
  onToggle,
  onProjectUsagePageChange,
  onRefreshProjectUsage,
  onAskField,
  onAskProject,
  siteOrigin,
  rovoEnabled,
  showGovernance = true,
}) {
  const displayField = React.useMemo(() => mergeFieldMetrics(field, details), [field, details]);
  const configuredProjectsValue = details ? details.configuredProjectCount : (field.configuredProjectCount ?? field.usageCount ?? 0);
  const fieldIsSelectType = isSelectType(field.type);
  const [fieldOptions, setFieldOptions] = React.useState(null);
  const [fieldOptionsLoading, setFieldOptionsLoading] = React.useState(false);
  const [contextOptionsOpen, setContextOptionsOpen] = React.useState(false);
  React.useEffect(() => {
    if (!expanded || !fieldIsSelectType || fieldOptions) return;
    let cancelled = false;
    setFieldOptionsLoading(true);
    invoke("getFieldOptions", { fieldId: field.id, projectKeys: [] })
      .then((result) => { if (!cancelled) { setFieldOptions(result); setFieldOptionsLoading(false); } })
      .catch(() => { if (!cancelled) { setFieldOptionsLoading(false); } });
    return () => { cancelled = true; };
  }, [expanded, field.id, fieldIsSelectType]);
  const usageSource = details?.field || details || displayField;
  const usageAvailable = isUsageAvailable(usageSource);
  const totalIssuesValue = usageAvailable ? (details ? details.totalIssueCount : (field.totalIssueCount ?? 0)) : "Unavailable";
  const activeProjectsValue = usageAvailable ? (details ? details.activeProjectCount : (field.activeProjectCount ?? 0)) : "Unavailable";
  const fieldFindings = details?.findings || details?.field?.findings || field.findings;

  const hasDanger = showGovernance && (fieldFindings?.tags?.adminAttention || fieldFindings?.tags?.risky);
  const hasWarn = showGovernance && !hasDanger && (fieldFindings?.tags?.cleanup || fieldFindings?.tags?.standardize);
  const severityClass = hasDanger ? "field-card--has-danger" : hasWarn ? "field-card--has-warn" : "";

  return (
    <article className={`field-card ${expanded ? "field-card--open" : ""} ${severityClass}`}>
      <button className={`field-card__header${loading ? " field-card__header--loading" : ""}`} onClick={onToggle} type="button">
        <div className="field-card__title-wrap">
          <label className="field-card__checkbox-label" title="Select for report" onClick={(event) => event.stopPropagation()}>
            <input
              type="checkbox"
              checked={selected}
              onChange={(event) => onSelectChange(field.id, event.target.checked)}
            />
            Select for report
          </label>
          <div className="field-card__field-id">
            {field.id}
            {field.isSystemField && <span className="field-badge field-badge--system">System</span>}
            {!field.isSystemField && field.isJiraBuiltin && <span className="field-badge field-badge--builtin">Jira built-in</span>}
          </div>
          <h3>{field.name}</h3>
          <p>{field.description || "No admin description is set for this field."}</p>
          <ProjectUsageBuildBadge field={displayField} />
          {showGovernance && <FindingsStrip findings={fieldFindings} />}
        </div>
        <div className="field-card__meta">
          <MetricChip label="Type" value={field.type} tone="cool" />
          <MetricChip label="Configured projects" value={configuredProjectsValue} tone="warm" />
          <MetricChip label="Active projects" value={activeProjectsValue} tone="success" />
          <MetricChip label="Issues with value" value={totalIssuesValue} />
        </div>
        <span className="field-card__toggle-icon" aria-hidden="true" />
      </button>

      {expanded ? (
        <div className="field-card__body">
          {loading ? (
            <div className="empty-state empty-state--inline">Loading field contexts and project usage...</div>
          ) : details ? (
            <>
              {showGovernance && <section className="detail-section">
                <div className="section-heading">
                  <h4>Governance Findings</h4>
                  <div className="section-heading__actions">
                    <FindingsStrip findings={fieldFindings} />
                    <button
                      className="secondary-button secondary-button--small"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRefreshProjectUsage(field.id, details.projectUsagePage || 1);
                      }}
                    >
                      Refresh usage
                    </button>
                    <button
                      className="secondary-button secondary-button--small"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onAskField();
                      }}
                      disabled={!rovoEnabled}
                    >
                      Ask Rovo
                    </button>
                  </div>
                </div>
                {fieldFindings?.reasons?.length ? (
                  <div className="findings-list">
                    {fieldFindings.reasons.map((reason, index) => (
                      <div className="finding-card" key={`${field.id}-finding-${index}`}>
                        <div className="finding-card__top">
                          <strong>{reason.title}</strong>
                          <FindingBadge
                            label={reason.severity === "high" ? "High" : "Medium"}
                            tone={reason.severity === "high" ? "danger" : reason.category === "cleanup" ? "warn" : "info"}
                          />
                        </div>
                        <p>{reason.detail}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state empty-state--inline">
                    No immediate governance issues were flagged for this field by the current heuristics.
                  </div>
                )}
              </section>}

              <section className="detail-section">
                <div className="section-heading">
                  <h4>Field-Wide Query</h4>
                  <div className="section-heading__actions">
                    <span>Total populated issues: {usageAvailable ? details.totalIssueCount : "Unavailable"}</span>
                    <button
                      className="secondary-button secondary-button--small"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onAskField();
                      }}
                      disabled={!rovoEnabled}
                    >
                      Ask Rovo
                    </button>
                  </div>
                </div>
                <div className="field-query-grid">
                  <a
                    className="smart-link-card"
                    href={buildJiraSearchUrl(siteOrigin, details.fieldJql || details.field?.fieldJql) || "#"}
                    target="_blank"
                    rel="noreferrer"
                    title="Open this field-wide JQL in Jira issue search"
                    onClick={(e) => handleJiraLinkClick(e, buildJiraSearchUrl(siteOrigin, details.fieldJql || details.field?.fieldJql))}
                  >
                    <span className="smart-link-card__title">Open field-wide JQL in Jira</span>
                    <code>{details.fieldJql || details.field?.fieldJql}</code>
                  </a>
                </div>
                {!usageAvailable ? (
                  <div className="empty-state empty-state--inline">
                    {usageSource?.usageStatusDetail || "Jira did not return per-project usage for this field in the app context."}
                  </div>
                ) : null}
              </section>

              <section className="detail-section">
                <div className="section-heading">
                  <h4>Contexts</h4>
                  <span>Refreshed {formatTimestamp(details.refreshedAt)}</span>
                </div>
                <div className="context-grid">
                  {details.contexts.length ? (
                    details.contexts.map((context) => (
                      <div
                        className={`context-card${fieldIsSelectType ? " context-card--clickable" : ""}`}
                        key={context.id}
                        onClick={fieldIsSelectType ? (e) => { e.stopPropagation(); setContextOptionsOpen(true); } : undefined}
                        role={fieldIsSelectType ? "button" : undefined}
                        tabIndex={fieldIsSelectType ? 0 : undefined}
                        onKeyDown={fieldIsSelectType ? (e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setContextOptionsOpen(true); } } : undefined}
                      >
                        <div className="context-card__top">
                          <strong>{context.name}</strong>
                          <span>
                            {context.isGlobalContext
                              ? "Global"
                              : `${context.projects.length} project${context.projects.length === 1 ? "" : "s"}`}
                          </span>
                        </div>
                        <p>{context.description || "No context description."}</p>
                        <div className="tag-row">
                          <span className="tag">{context.isAnyIssueType ? "All issue types" : `${context.issueTypeCount} issue types`}</span>
                          <span className="tag">{context.isGlobalContext ? "Global context" : "Scoped context"}</span>
                          {fieldIsSelectType ? <span className="tag tag--action">View options</span> : null}
                        </div>
                        {!context.isGlobalContext && context.projects.length ? (
                          <div className="project-pill-row">
                            {context.projects.map((project) => (
                              <span className="project-pill" key={`${context.id}-${project.id}`}>
                                {project.key}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <div className="empty-state empty-state--inline">No contexts were returned for this field.</div>
                  )}
                  {contextOptionsOpen ? (
                    <FieldOptionsModal
                      fieldId={field.id}
                      fieldName={field.name || field.fieldName}
                      fieldType={field.type || field.fieldType}
                      projectKeys={[]}
                      onClose={() => setContextOptionsOpen(false)}
                    />
                  ) : null}
                </div>
              </section>

              {fieldIsSelectType ? (
                <section className="detail-section">
                  <div className="section-heading">
                    <h4>Options</h4>
                  </div>
                  {fieldOptionsLoading ? (
                    <div className="empty-state empty-state--inline">Loading options…</div>
                  ) : fieldOptions?.optionsByContext?.length ? (
                    fieldOptions.optionsByContext.map((ctx) => (
                      <InlineOptionsContext key={ctx.contextId} ctx={ctx} />
                    ))
                  ) : fieldOptions ? (
                    <div className="empty-state empty-state--inline">No options found for this field.</div>
                  ) : null}
                </section>
              ) : null}

              <section className="detail-section">
                <div className="section-heading">
                  <h4>Project Usage</h4>
                  <div className="section-heading__actions">
                    <span>
                      {`${details.activeProjectCount} active project${details.activeProjectCount === 1 ? "" : "s"} · Page ${details.projectUsagePage}/${details.projectUsageTotalPages}`}
                    </span>
                    <button
                      className="secondary-button secondary-button--small"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onAskField();
                      }}
                      disabled={!rovoEnabled}
                    >
                      Ask Rovo
                    </button>
                  </div>
                </div>

                {details.projects.length ? (
                  <>
                    <div className="project-usage-list">
                      {details.projects.map((project) => (
                        <div className="project-usage-card" key={project.projectId}>
                          <div className="project-usage-card__head">
                            <div>
                              <strong>
                                {project.projectKey} <span>{project.projectName}</span>
                              </strong>
                            </div>
                            <div className="project-usage-card__head-actions">
                              <MetricChip label="Issues with value" value={project.issueCount} tone="success" />
                              <button
                                className="secondary-button secondary-button--small"
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onAskProject(project);
                                }}
                                disabled={!rovoEnabled}
                              >
                                Ask Rovo
                              </button>
                            </div>
                          </div>
                          <div className="project-usage-card__body">
                            <label>JQL</label>
                            <a
                              className="smart-link-card"
                              href={buildJiraSearchUrl(siteOrigin, project.jql) || "#"}
                              target="_blank"
                              rel="noreferrer"
                              title="Open this JQL in Jira issue search"
                              onClick={(e) => handleJiraLinkClick(e, buildJiraSearchUrl(siteOrigin, project.jql))}
                            >
                              <span className="smart-link-card__title">Open JQL in Jira</span>
                              <code>{project.jql}</code>
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="project-usage-pagination">
                      <span className="pagination-bar__status">
                        Showing {((details.projectUsagePage - 1) * details.projectUsagePageSize) + 1}
                        -
                        {Math.min(details.projectUsagePage * details.projectUsagePageSize, details.projectUsageTotalProjects)}
                        {" "}of {details.projectUsageTotalProjects} active projects
                      </span>
                      <div className="pagination-bar__actions">
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => onProjectUsagePageChange(field.id, 1)}
                          disabled={details.projectUsagePage === 1}
                        >
                          First
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => onProjectUsagePageChange(field.id, Math.max(1, details.projectUsagePage - 1))}
                          disabled={details.projectUsagePage === 1}
                        >
                          Previous
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => onProjectUsagePageChange(field.id, Math.min(details.projectUsageTotalPages, details.projectUsagePage + 1))}
                          disabled={details.projectUsagePage === details.projectUsageTotalPages}
                        >
                          Next
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => onProjectUsagePageChange(field.id, details.projectUsageTotalPages)}
                          disabled={details.projectUsagePage === details.projectUsageTotalPages}
                        >
                          Last
                        </button>
                      </div>
                    </div>
                  </>
                ) : details.summaryStatus === "queued" || details.summaryStatus === "building" ? (
                  <div className="empty-state empty-state--inline">
                    <div>
                      <div>Project usage enrichment is running in the background for this field.</div>
                      <div style={{ marginTop: 8 }}>
                        {details.estimatedIssueTotal > 0
                          ? `Scanned ${details.processedIssueCount} of ${details.estimatedIssueTotal} matching issues.`
                          : "Waiting for the issue scan to start."}
                      </div>
                      {details.estimatedIssueTotal > 0 ? (
                        <div className="status-progress" style={{ marginTop: 10 }}>
                          <div className="status-progress__meta">
                            <strong>{Math.min(100, Math.round((details.processedIssueCount / details.estimatedIssueTotal) * 100))}%</strong>
                            <span>{details.processedIssueCount} of {details.estimatedIssueTotal} issues scanned</span>
                          </div>
                          <div className="status-progress__bar" aria-hidden="true">
                            <span style={{ width: `${Math.min(100, Math.round((details.processedIssueCount / details.estimatedIssueTotal) * 100))}%` }} />
                          </div>
                        </div>
                      ) : null}
                      {details.lastError ? <div className="build-card__error" style={{ marginTop: 10 }}>{details.lastError}</div> : null}
                    </div>
                  </div>
                ) : (
                  <div className="empty-state empty-state--inline">
                    No projects with populated values were found on this page of active projects.
                  </div>
                )}
              </section>
            </>
          ) : (
            <div className="empty-state empty-state--inline">No field details are available.</div>
          )}
        </div>
      ) : null}
    </article>
  );
}
