/**
 * Pure business-logic helpers extracted from index.js.
 * No Forge platform imports — fully testable in a Node.js unit environment.
 */

import { buildOverallFieldJql, getFieldTypeLabel } from "./transform.js";

// ── Constants ──────────────────────────────────────────────────────────────

export const USAGE_STATUS_READY = "ready";
export const USAGE_STATUS_UNAVAILABLE = "unavailable";
export const USAGE_STATUS_UNSUPPORTED = "unsupported";

export const DEFAULT_GOVERNANCE_THRESHOLDS = {
  highImpactMinProjects: 10,
  highImpactMinIssues: 1000,
  appFieldHeavyUsageMin: 500,
  broadScopeMinProjects: 3,
  lightUsageMinProjects: 5,
  lightUsageMaxIssues: 100,
  missingDescriptionMinProjects: 5,
  missingDescriptionMinIssues: 500,
  configuredActiveGapMinProjects: 5,
  configuredActiveGapMaxRatio: 0.70,
  globalContextMaxIssues: 50,
  contextSprawlMinContexts: 8,
  staleFieldMaxAgeDays: 365,
};

const SELECT_FIELD_TYPE_KEYWORDS = ["select", "multiselect", "radiobutton", "checkbox", "cascadingselect"];

// Fields that are always present on every issue — skip when counting field occupancy
export const STRUCTURAL_SYSTEM_FIELDS = new Set([
  "project", "summary", "created", "updated", "creator", "status", "issuetype",
  "votes", "watches", "subtasks", "aggregateprogress", "progress", "workratio",
  "lastViewed", "issuerestrictions",
  "aggregatetimeoriginalestimate", "aggregatetimespent", "aggregatetimeestimate",
]);

// Fields whose RQT values belong to related issues rather than this issue itself
export const RQT_SKIP_FIELDS = new Set(["issuelinks", "parent"]);

export const RQT_DEDUP_PRIORITY_FIELD = "customfield_11426";
export const RQT_DEDUP_SUBORDINATE_FIELDS = new Set([
  "customfield_11806",
  "customfield_18522",
  "customfield_15178",
]);

const RQT_PATTERN = /\bRQT-\d+-\d+\b/gi;

// ── RQT / field value analysis ──────────────────────────────────────────────

export function isFieldValueNonEmpty(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

export function extractRqtValues(value) {
  const found = new Set();

  function scan(v) {
    if (v === null || v === undefined) return;
    if (typeof v === "string") {
      const matches = v.match(RQT_PATTERN);
      if (matches) for (const m of matches) found.add(m.toUpperCase());
      return;
    }
    if (Array.isArray(v)) { for (const item of v) scan(item); return; }
    if (typeof v === "object") { for (const val of Object.values(v)) scan(val); }
  }

  scan(value);
  return found;
}

export function buildRqtJql(fieldIds) {
  if (!fieldIds.length) return null;
  const clauses = [];
  for (const fid of fieldIds) {
    const cfMatch = String(fid).match(/customfield_(\d+)/);
    if (cfMatch) {
      clauses.push(`cf[${cfMatch[1]}] ~ "RQT"`);
    } else if (fid === "summary") {
      clauses.push(`summary ~ "RQT"`);
    } else if (fid === "description") {
      clauses.push(`description ~ "RQT"`);
    } else if (fid === "comment") {
      clauses.push(`comment ~ "RQT"`);
    }
  }
  return clauses.length ? clauses.join(" OR ") : null;
}

export function collectIssueRqtValues(issueFields, summaryValue) {
  const byField = new Map();

  for (const [fieldId, value] of Object.entries(issueFields || {})) {
    if (STRUCTURAL_SYSTEM_FIELDS.has(fieldId)) continue;
    if (RQT_SKIP_FIELDS.has(fieldId)) continue;
    if (!isFieldValueNonEmpty(value)) continue;
    const matches = extractRqtValues(value);
    if (matches.size > 0) byField.set(fieldId, matches);
  }

  const summaryMatches = extractRqtValues(summaryValue);
  if (summaryMatches.size > 0) byField.set("summary", summaryMatches);

  const priorityValues = byField.get(RQT_DEDUP_PRIORITY_FIELD);
  if (priorityValues?.size > 0) {
    for (const subId of RQT_DEDUP_SUBORDINATE_FIELDS) {
      const subValues = byField.get(subId);
      if (!subValues) continue;
      for (const v of priorityValues) subValues.delete(v);
      if (subValues.size === 0) byField.delete(subId);
    }
  }

  return byField;
}

// ── Job / capacity status ───────────────────────────────────────────────────

export function estimateProjectUsageJobIssues(jobLike) {
  return Number(
    jobLike?.estimatedIssueTotal
    ?? jobLike?.totalIssueCount
    ?? jobLike?.field?.totalIssueCount
    ?? 0
  ) || 0;
}

export function isFieldSummaryQueuedForDispatch(summary) {
  return summary?.summaryStatus === "queued" && Number(summary?.processedIssueCount || 0) <= 0;
}

export function isFieldSummaryRunning(summary) {
  return summary?.summaryStatus === "building" || isFieldSummaryQueuedForDispatch(summary);
}

export function summarizeProjectUsageCapacity(summaries = []) {
  const runningJobs = summaries.filter(isFieldSummaryRunning);
  return {
    runningJobs,
    runningJobCount: runningJobs.length,
    runningIssueBudget: runningJobs.reduce((sum, job) => sum + estimateProjectUsageJobIssues(job), 0),
  };
}

// Filters a { fields: [{ ..., projects }], projects } project-usage-report shape
// (the return type of getProjectUsageReport / a stored report job's result) down
// to only the projects the CURRENT viewer has Browse Projects permission on.
// activeProjectCount is recomputed from the filtered array, not the original
// count, so a hidden project's contribution to that number never leaks either.
// browsableProjectIds is a Set of string project IDs; pass null/undefined to
// skip filtering entirely (e.g. when the caller has no accountId to check).
export function filterProjectUsageByBrowsable(result, browsableProjectIds) {
  if (!browsableProjectIds) return result;

  const fields = (result?.fields || []).map((field) => {
    const projects = (field.projects || []).filter((p) => browsableProjectIds.has(String(p.projectId)));
    return { ...field, projects, activeProjectCount: projects.length };
  });

  const projects = (result?.projects || []).filter((p) => browsableProjectIds.has(String(p.projectId)));

  return { ...result, fields, projects };
}

// ── HTTP retry logic ────────────────────────────────────────────────────────

export function shouldRetry(error) {
  const s = error?.status;
  return s === 429 || (s >= 500 && s < 600);
}

// Cap how long a single Jira Retry-After header can force us to wait. Jira has been
// observed sending Retry-After values well over 100s during sustained rate-limit storms;
// honoring that uncapped stalls the caller far past its own per-request timeout budget
// (e.g. the 8s field-usage count timeout), so cap it to the same ceiling as the
// exponential fallback below.
const MAX_RETRY_AFTER_MS = 30000;

export function getRetryDelayMs(error, attempt) {
  const header = error?.originalResponse?.headers?.get?.("Retry-After");
  if (header) {
    const s = Number(header);
    if (Number.isFinite(s) && s > 0) return Math.min(MAX_RETRY_AFTER_MS, s * 1000);
  }
  return Math.min(30000, 2000 * (2 ** attempt)) + Math.floor(Math.random() * 1000);
}

// ── Field classification ────────────────────────────────────────────────────

export function normalizeFieldName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function buildDuplicateNameCountMap(fields = []) {
  const counts = new Map();
  for (const field of fields) {
    const key = normalizeFieldName(field?.name);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

export function hasMeaningfulDescription(description) {
  const n = String(description || "").trim().toLowerCase();
  if (!n) return false;
  return !["no admin description is set for this field.", "no description", "n/a", "na"].includes(n);
}

export function isLikelyAppProvidedField(field) {
  const ct = String(field?.customType || field?.schema?.custom || "");
  return Boolean(ct && !ct.startsWith("com.atlassian.jira.plugin.system.customfieldtypes:"));
}

// Whole days between `at` and `now`. Returns null for a missing/unparseable value or a
// future date -- callers treat null as "we don't know", never as "not stale", because
// the only source of these timestamps (snapshot_project_usage.latest_field_change_at) is
// NULL for any field whose usage came from the Universal Scan rather than a per-field
// summary build. Guessing "stale" from absent data would flag half the catalog.
export function daysSince(at, now = Date.now()) {
  if (!at) return null;
  const then = new Date(at).getTime();
  if (!Number.isFinite(then)) return null;
  const diffMs = now - then;
  if (diffMs < 0) return null;
  return Math.floor(diffMs / 86400000);
}

export function isJiraBuiltinField(field) {
  const ct = String(field?.customType || field?.schema?.custom || "");
  if (!ct) return false;
  return (
    ct.startsWith("com.atlassian.jira.plugin.system.customfieldtypes:") ||
    ct.startsWith("com.pyxis.greenhopper.jira:") ||
    ct.startsWith("com.atlassian.servicedesk.") ||
    ct.startsWith("com.atlassian.jira.ext.")
  );
}

// A field nobody configured and nobody can reconfigure: a pseudo-field a first-party Jira
// plugin manages outright -- Rank, Sprint, Epic Link, Service Desk's own fields. Deliberately
// narrower than isJiraBuiltinField, which also matches every ordinary custom field built from
// a native Jira field TYPE (select list, text field, ...) via the customfieldtypes: prefix --
// those remain fully actionable (rename, rescope, document, delete), so folding them in here
// would silence real findings on most of an ordinary custom field catalog.
export function isPlatformProvidedField(field) {
  const ct = String(field?.customType || field?.schema?.custom || "");
  if (!ct) return false;
  return (
    ct.startsWith("com.pyxis.greenhopper.jira:") ||
    ct.startsWith("com.atlassian.servicedesk.") ||
    ct.startsWith("com.atlassian.jira.ext.")
  );
}

export function classifyFieldUsageStatus(field, error) {
  if (!error) {
    return {
      status: USAGE_STATUS_UNAVAILABLE,
      detail: "Per-project usage is not collected during the background snapshot.",
    };
  }

  if (isLikelyAppProvidedField(field) && error?.status === 401) {
    return {
      status: USAGE_STATUS_UNSUPPORTED,
      detail: "Jira does not expose per-project usage for this app-provided field to the Forge app context.",
    };
  }

  if (error?.status === 401 || error?.status === 403) {
    return {
      status: USAGE_STATUS_UNAVAILABLE,
      detail: `Jira rejected the per-project usage endpoint for this field (${error.status}).`,
    };
  }

  return {
    status: USAGE_STATUS_UNAVAILABLE,
    detail: error?.message || "Per-project usage could not be loaded for this field.",
  };
}

// ── Governance findings ─────────────────────────────────────────────────────

export function buildGovernanceFindings(field, metrics = {}, thresholds = {}) {
  const t = { ...DEFAULT_GOVERNANCE_THRESHOLDS, ...thresholds };
  const totalIssueCount = metrics.totalIssueCount ?? 0;
  const activeProjectCount = metrics.activeProjectCount ?? 0;
  const configuredProjectCount = metrics.configuredProjectCount ?? metrics.usageCount ?? 0;
  // Values counted in projects since archived (store/archived.js). Jira's search cannot see
  // them, so totalIssueCount is 0 for a field whose data lives only there -- which is data,
  // not an unused field, and must never be flagged as one.
  const holdsArchivedData = (Number(metrics.archivedIssueCount) || 0) > 0;
  const breadthProjectCount = activeProjectCount > 0 ? activeProjectCount : configuredProjectCount;
  const usesConfiguredScope = activeProjectCount <= 0 && configuredProjectCount > 0;
  const usageStatus = metrics.usageStatus ?? USAGE_STATUS_READY;
  const usageAvailable = usageStatus === USAGE_STATUS_READY;
  const duplicateNameCount = metrics.duplicateNameCount ?? 1;
  const descriptionPresent = hasMeaningfulDescription(field.description);
  const appProvided = isLikelyAppProvidedField(field);
  const isSystemField = Boolean(metrics.isSystemField);
  // Comment, Rank, Sprint and their kind are present on effectively every issue in every
  // project by definition -- that is not a governance signal, it is what they are. Nothing
  // below this point (usage rules, staleness, naming, documentation) has any admin action
  // behind it for a field nobody configured and nobody can reconfigure.
  const notActionable = isSystemField || Boolean(metrics.isPlatformProvidedField);
  const contextCount = metrics.contextCount ?? 0;
  const hasGlobalContext = Boolean(metrics.hasGlobalContext);
  const staleDays = daysSince(metrics.lastFieldChangeAt, metrics.now ?? Date.now());

  const reasons = [];
  let priorityScore = 0;

  if (!notActionable && usageAvailable && breadthProjectCount >= t.highImpactMinProjects && totalIssueCount >= t.highImpactMinIssues) {
    reasons.push({
      code: "high-impact",
      category: "risky", severity: "high",
      title: "High-impact field with broad live usage",
      detail: usesConfiguredScope
        ? `Configured in ${configuredProjectCount} projects with ${totalIssueCount.toLocaleString()} populated issues. Build project usage to confirm the exact active-project spread.`
        : `Active across ${activeProjectCount} projects with ${totalIssueCount.toLocaleString()} populated issues.`,
    });
    priorityScore += 40;
  }

  if (!notActionable && usageAvailable && appProvided && totalIssueCount >= t.appFieldHeavyUsageMin) {
    reasons.push({
      code: "app-heavy-usage",
      category: "risky", severity: "medium",
      title: "App-provided field with heavy usage",
      detail: "App or plugin field with significant data — manage changes carefully.",
    });
    priorityScore += 22;
  }

  if (!notActionable && usageAvailable && hasGlobalContext && totalIssueCount < t.globalContextMaxIssues) {
    reasons.push({
      code: "global-context-low-usage",
      category: "cleanup", severity: "medium",
      title: "Global context with very low usage",
      detail: `This field applies to all projects via a global context but only ${totalIssueCount.toLocaleString()} issues have a value. Consider scoping it to specific projects or removing it.`,
    });
    priorityScore += 20;
  }

  if (!notActionable && usageAvailable && configuredProjectCount >= t.configuredActiveGapMinProjects) {
    const inactiveRatio = configuredProjectCount > 0 ? (configuredProjectCount - activeProjectCount) / configuredProjectCount : 0;
    if (inactiveRatio >= t.configuredActiveGapMaxRatio) {
      reasons.push({
        code: "dead-configuration",
        category: "cleanup", severity: "medium",
        title: "High dead-configuration ratio",
        detail: `Configured in ${configuredProjectCount} projects but only ${activeProjectCount} have any issue data — ${Math.round(inactiveRatio * 100)}% of configured scope is inactive.`,
      });
      priorityScore += 20;
    }
  }

  if (!notActionable && !appProvided && usageAvailable && !holdsArchivedData && configuredProjectCount === 0 && totalIssueCount === 0 && activeProjectCount === 0) {
    reasons.push({
      code: "orphaned",
      category: "cleanup", severity: "medium",
      title: "Orphaned field — not configured or used anywhere",
      detail: "No project contexts and no recorded issue usage. This field is a candidate for deletion.",
    });
    priorityScore += 25;
  }

  if (!notActionable && !holdsArchivedData && configuredProjectCount >= t.broadScopeMinProjects && totalIssueCount === 0 && activeProjectCount === 0) {
    reasons.push({
      code: "configured-no-issues",
      category: "cleanup", severity: "medium",
      title: "Configured field with no populated issues",
      detail: `Configured in ${configuredProjectCount} projects but no populated issues were found in the snapshot.`,
    });
    priorityScore += 18;
  }

  if (isSystemField && usageAvailable && !holdsArchivedData && totalIssueCount === 0) {
    reasons.push({
      code: "system-no-usage",
      category: "cleanup", severity: "low",
      title: "System field with no recorded usage",
      detail: "No issues with a value found in the snapshot. This field may not be actively used.",
    });
    priorityScore += 8;
  }

  if (!notActionable && usageAvailable && breadthProjectCount >= t.lightUsageMinProjects && totalIssueCount > 0 && totalIssueCount <= t.lightUsageMaxIssues) {
    reasons.push({
      code: "light-usage",
      category: "cleanup", severity: "medium",
      title: "Broadly scoped field with very light usage",
      detail: usesConfiguredScope
        ? `Configured in ${configuredProjectCount} projects but only ${totalIssueCount.toLocaleString()} populated issues were found.`
        : `Active in ${activeProjectCount} projects but only ${totalIssueCount.toLocaleString()} populated issues were found.`,
    });
    priorityScore += 22;
  }

  // Deliberately requires totalIssueCount > 0: a field with no data at all is already
  // covered by the orphaned / "configured but no populated issues" rules above, and
  // firing both would double-count it into Admin Attention on priority score alone.
  // This rule is specifically "it WAS used, and then everyone stopped".
  if (!notActionable && usageAvailable && totalIssueCount > 0 && staleDays !== null && staleDays >= t.staleFieldMaxAgeDays) {
    const years = staleDays / 365;
    reasons.push({
      code: "stale",
      category: "cleanup", severity: "medium",
      title: "No field activity in over a year",
      // The clause "or removing it from active screens" was dropped on 4 Aug 2026.
      // Observatory holds no screen data, so it cannot know whether this field is on a
      // screen, let alone an active one -- the advice named evidence the app had never
      // gathered. Restore a screen-aware recommendation when the screen inventory ships.
      detail: `${totalIssueCount.toLocaleString()} issues carry a value, but the most recent recorded change was ${
        years >= 2 ? `${Math.floor(years)} years` : `${staleDays} days`
      } ago. The data is historical — consider retiring the field.`,
    });
    priorityScore += 20;
  }

  if (!notActionable && contextCount >= t.contextSprawlMinContexts) {
    reasons.push({
      code: "context-sprawl",
      category: "standardize", severity: "medium",
      title: "Context sprawl",
      detail: `${contextCount} separate contexts suggest the field was patched project-by-project over time. Consider consolidating into fewer, broader contexts.`,
    });
    priorityScore += 15;
  }

  if (!notActionable && duplicateNameCount > 1) {
    const dupeScore = Math.min(50, 20 + Math.max(0, duplicateNameCount - 2) * 5);
    reasons.push({
      code: "duplicate-naming",
      category: "standardize", severity: "medium",
      title: "Similar field naming detected",
      detail: `${duplicateNameCount} fields share the same normalized name — possible duplicates that could confuse users or produce reporting errors.`,
    });
    priorityScore += dupeScore;
  }

  if (!notActionable && !descriptionPresent && (breadthProjectCount >= t.missingDescriptionMinProjects || totalIssueCount >= t.missingDescriptionMinIssues)) {
    reasons.push({
      code: "missing-description",
      category: "standardize", severity: "medium",
      title: "Actively used field lacks a meaningful description",
      detail: totalIssueCount >= t.missingDescriptionMinIssues && breadthProjectCount < t.missingDescriptionMinProjects
        ? `${totalIssueCount.toLocaleString()} issues carry a value in this field — clear documentation is warranted regardless of project count.`
        : usesConfiguredScope
          ? "Configured broadly enough to warrant clearer documentation before usage expands further."
          : "Used across enough projects to warrant clearer documentation.",
    });
    priorityScore += 16;
  }

  if (!usageAvailable) {
    reasons.push({
      code: "usage-unavailable",
      category: "review",
      severity: "medium",
      title: "Per-project usage is unavailable",
      detail: metrics.usageStatusDetail || "Jira did not return per-project usage for this field.",
    });
    priorityScore += 8;
  }

  const categories = Array.from(new Set(reasons.map((r) => r.category)));
  const adminAttention = reasons.some((r) => r.severity === "high") || priorityScore >= 35;

  return {
    priorityScore,
    adminAttention,
    categories,
    reasons,
    tags: {
      risky: categories.includes("risky"),
      cleanup: categories.includes("cleanup"),
      standardize: categories.includes("standardize"),
      review: categories.includes("review"),
      adminAttention,
    },
  };
}

// ── Inventory pipeline ──────────────────────────────────────────────────────

export function mergeProjectUsageCounts(existingProjects = [], nextProjects = []) {
  const merged = new Map();

  for (const project of existingProjects) {
    merged.set(project.projectId, { ...project });
  }

  for (const project of nextProjects) {
    const current = merged.get(project.projectId) || { ...project, issueCount: 0 };
    current.projectKey = project.projectKey;
    current.projectName = project.projectName;
    current.jql = project.jql;
    current.issueCount += Number(project.issueCount || 0);
    const currentUpdatedAt = current.latestIssueUpdatedAt || current.latestFieldChangeAt || null;
    const nextUpdatedAt = project.latestIssueUpdatedAt || project.latestFieldChangeAt || null;
    if (nextUpdatedAt && (!currentUpdatedAt || nextUpdatedAt > currentUpdatedAt)) {
      current.latestFieldChangeAt = project.latestFieldChangeAt || nextUpdatedAt;
      current.latestIssueKey = project.latestIssueKey || null;
      current.latestIssueUpdatedAt = project.latestIssueUpdatedAt || nextUpdatedAt;
    }
    merged.set(project.projectId, current);
  }

  return Array.from(merged.values())
    .sort((left, right) => right.issueCount - left.issueCount || left.projectKey.localeCompare(right.projectKey));
}

export function compareFields(left, right, sortKey) {
  const leftUsage = left.totalIssueCount !== 0 ? left.totalIssueCount : (left.configuredProjectCount ?? 0);
  const rightUsage = right.totalIssueCount !== 0 ? right.totalIssueCount : (right.configuredProjectCount ?? 0);
  if (sortKey === "name-asc") return left.name.localeCompare(right.name);
  if (sortKey === "name-desc") return right.name.localeCompare(left.name);
  if (sortKey === "active-projects-desc") {
    if (left.activeProjectCount !== right.activeProjectCount) return right.activeProjectCount - left.activeProjectCount;
    if (leftUsage !== rightUsage) return rightUsage - leftUsage;
    return left.name.localeCompare(right.name);
  }
  if (sortKey === "active-projects-asc") {
    if (left.activeProjectCount !== right.activeProjectCount) return left.activeProjectCount - right.activeProjectCount;
    if (leftUsage !== rightUsage) return leftUsage - rightUsage;
    return left.name.localeCompare(right.name);
  }
  if (sortKey === "usage-asc") {
    if (leftUsage !== rightUsage) return leftUsage - rightUsage;
    return left.name.localeCompare(right.name);
  }
  if (sortKey === "contexts-desc") {
    const leftContexts = left.contextCount ?? 0;
    const rightContexts = right.contextCount ?? 0;
    if (leftContexts !== rightContexts) return rightContexts - leftContexts;
    return left.name.localeCompare(right.name);
  }
  if (sortKey === "contexts-asc") {
    const leftContexts = left.contextCount ?? 0;
    const rightContexts = right.contextCount ?? 0;
    if (leftContexts !== rightContexts) return leftContexts - rightContexts;
    return left.name.localeCompare(right.name);
  }
  if (sortKey === "priority-desc") {
    const leftPriority = left.findings?.priorityScore ?? 0;
    const rightPriority = right.findings?.priorityScore ?? 0;
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;
    return left.name.localeCompare(right.name);
  }
  // usage-desc (default)
  if (leftUsage !== rightUsage) return rightUsage - leftUsage;
  if ((left.findings?.priorityScore ?? 0) !== (right.findings?.priorityScore ?? 0)) {
    return (right.findings?.priorityScore ?? 0) - (left.findings?.priorityScore ?? 0);
  }
  return left.name.localeCompare(right.name);
}

export function filterInventoryFields(fields, query, type, projectUsageFilter = "all", maxIssuesWithValue = "", fieldOrigin = "all", minIssuesWithValue = "", extra = {}) {
  let out = fields;
  if (query) {
    const q = String(query).trim().toLowerCase();
    out = out.filter((f) =>
      [f.name, f.id, f.type, f.customType, f.description]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(q))
    );
  }
  if (type && type !== "all") out = out.filter((f) => f.type === type);
  if (fieldOrigin === "jira-builtin") out = out.filter((f) => f.isJiraBuiltin || f.isSystemField);
  else if (fieldOrigin === "user-created") out = out.filter((f) => !f.isJiraBuiltin && !f.isSystemField);
  if (projectUsageFilter && projectUsageFilter !== "all") {
    out = out.filter((f) => {
      const state = f.projectUsageState || "unbuilt";
      const built = Boolean(f.projectUsageBuilt) || state === "ready";
      if (projectUsageFilter === "not-built") return !built && Number(f.totalIssueCount || 0) > 0;
      if (projectUsageFilter === "built") return built;
      if (projectUsageFilter === "building") return state === "queued" || state === "building";
      if (projectUsageFilter === "incomplete") return state === "failed" || state === "cancelled";
      return true;
    });
  }
  const minIssues = Number(minIssuesWithValue);
  if (Number.isFinite(minIssues) && minIssues >= 0 && String(minIssuesWithValue).trim() !== "") {
    out = out.filter((f) => Number(f.totalIssueCount || 0) >= minIssues);
  }
  const maxIssues = Number(maxIssuesWithValue);
  if (Number.isFinite(maxIssues) && maxIssues >= 0 && String(maxIssuesWithValue).trim() !== "") {
    out = out.filter((f) => Number(f.totalIssueCount || 0) <= maxIssues);
  }

  const {
    minActiveProjects = "",
    maxActiveProjects = "",
    minContexts = "",
    maxContexts = "",
    duplicateNamesOnly = false,
    hasDescription = "all",
    hideSystemFields = false,
  } = extra || {};

  const minActive = Number(minActiveProjects);
  if (Number.isFinite(minActive) && minActive >= 0 && String(minActiveProjects).trim() !== "") {
    out = out.filter((f) => Number(f.activeProjectCount || 0) >= minActive);
  }
  const maxActive = Number(maxActiveProjects);
  if (Number.isFinite(maxActive) && maxActive >= 0 && String(maxActiveProjects).trim() !== "") {
    out = out.filter((f) => Number(f.activeProjectCount || 0) <= maxActive);
  }

  const minCtx = Number(minContexts);
  if (Number.isFinite(minCtx) && minCtx >= 0 && String(minContexts).trim() !== "") {
    out = out.filter((f) => Number(f.contextCount || 0) >= minCtx);
  }
  const maxCtx = Number(maxContexts);
  if (Number.isFinite(maxCtx) && maxCtx >= 0 && String(maxContexts).trim() !== "") {
    out = out.filter((f) => Number(f.contextCount || 0) <= maxCtx);
  }

  if (duplicateNamesOnly) {
    out = out.filter((f) => Number(f.duplicateNameCount || 0) > 1);
  }

  // Independent of the origin filter, deliberately. "User-created" already excludes system
  // fields, but it also excludes Jira-provided custom fields the reader may still want to
  // see -- there was no way to ask for "everything except the ones on every issue type" while
  // still seeing Jira-provided custom fields. isSystemField is Rank, Comment, Watches, and
  // the rest of what ships on every issue regardless of project or scheme; it is never a
  // customfield_ id, so it can never be part of a governance decision about a custom field.
  if (hideSystemFields) {
    out = out.filter((f) => !f.isSystemField);
  }

  if (hasDescription === "yes") {
    out = out.filter((f) => String(f.description || "").trim() !== "");
  } else if (hasDescription === "no") {
    out = out.filter((f) => String(f.description || "").trim() === "");
  }

  return out;
}

export function isSelectFieldType(fieldType) {
  const normalized = String(fieldType || "").toLowerCase().replace(/[\s\-_]/g, "");
  return SELECT_FIELD_TYPE_KEYWORDS.some((kw) => normalized.includes(kw));
}

// `findingsFilter` is either one of the four coarse categories, or a specific reason code
// (optionally several, comma-joined) -- how an Overview card that counted "23 fields with a
// dead-configuration ratio" sends a reader to exactly those 23, rather than the whole cleanup
// bucket they sit inside alongside six unrelated rules.
export function applyFindingsFilter(fields, findingsFilter) {
  if (!findingsFilter || findingsFilter === "all") return fields;
  if (["admin-attention", "risky", "cleanup", "standardize"].includes(findingsFilter)) {
    const tagKey = findingsFilter === "admin-attention" ? "adminAttention" : findingsFilter;
    return fields.filter((f) => Boolean(f.findings?.tags?.[tagKey]));
  }
  const codes = findingsFilter.split(",").map((c) => c.trim()).filter(Boolean);
  return fields.filter((f) => (f.findings?.reasons || []).some((r) => codes.includes(r.code)));
}

export function sortInventoryFields(fields, sortKey) {
  return [...fields].sort((a, b) => compareFields(a, b, sortKey));
}

export function summarizeFindings(fields) {
  return fields.reduce((s, f) => {
    const tags = f.findings?.tags || {};
    if (tags.adminAttention) s.adminAttention++;
    if (tags.risky) s.risky++;
    if (tags.cleanup) s.cleanup++;
    if (tags.standardize) s.standardize++;
    return s;
  }, { adminAttention: 0, risky: 0, cleanup: 0, standardize: 0 });
}

// Per-code counts, not just the four coarse categories summarizeFindings tracks. The
// Overview promotes several specific reasons to their own cards now (mirroring how filters
// and dashboards already split "no live owner" from "shared with everyone" instead of
// lumping them into one number), and each of those needs its own count or the card and what
// clicking it shows would disagree.
export function summarizeFindingsByCode(fields) {
  const counts = {};
  for (const f of fields) {
    for (const reason of f.findings?.reasons || []) {
      if (!reason.code) continue;
      counts[reason.code] = (counts[reason.code] || 0) + 1;
    }
  }
  return counts;
}

export function buildInventoryRecord(field, metrics = {}) {
  const configuredProjectCount = metrics.configuredProjectCount ?? 0;
  const activeProjectCount = metrics.activeProjectCount ?? 0;
  const totalIssueCount = metrics.totalIssueCount ?? 0;
  const usageStatus = metrics.usageStatus ?? USAGE_STATUS_READY;
  const usageStatusDetail = metrics.usageStatusDetail || null;
  const findings = metrics.findings || null;
  const projectUsageState = metrics.projectUsageState || "unbuilt";
  const projectUsageBuilt = Boolean(metrics.projectUsageBuilt);

  return {
    id: field.id,
    name: field.name,
    description: field.description || "",
    type: getFieldTypeLabel(field),
    primitiveType: field.schema?.type || "unknown",
    customType: field.schema?.custom || null,
    searcherKey: field.searcherKey || null,
    usageCount: configuredProjectCount,
    configuredProjectCount,
    totalIssueCount,
    activeProjectCount,
    usageStatus,
    usageStatusDetail,
    projectUsageState,
    projectUsageBuilt,
    fieldJql: buildOverallFieldJql(field.id),
    findings,
    isJiraBuiltin: isJiraBuiltinField(field),
    isSystemField: !String(field.id || "").startsWith("customfield_"),
  };
}
