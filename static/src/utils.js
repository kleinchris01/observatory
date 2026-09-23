import { router, rovo } from "@forge/bridge";

export function formatTimestamp(value) {
  if (!value) return "No field change detected";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatNumber(value, fallback = "0") {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toLocaleString() : fallback;
}

// Jira stores many field names in ALL CAPS. Detect predominantly-uppercase names
// and convert them to title case so the table isn't visually aggressive.
export function toDisplayName(name) {
  if (!name) return name;
  const s = String(name);
  const letters = s.replace(/[^a-zA-Z]/g, "");
  if (!letters.length) return s;
  const upperRatio = (s.match(/[A-Z]/g) || []).length / letters.length;
  if (upperRatio < 0.75) return s; // already mixed-case — leave it alone
  return s.toLowerCase().replace(/(?:^|[\s()\-/])\S/g, (c) => c.toUpperCase());
}

export function buildValueJql(fields, rqtValue) {
  const clauses = [];
  for (const f of fields || []) {
    const m = String(f.fieldId).match(/customfield_(\d+)/);
    if (m) clauses.push(`cf[${m[1]}] ~ "${rqtValue}"`);
    else if (f.fieldId === "summary") clauses.push(`summary ~ "${rqtValue}"`);
    else if (f.fieldId === "description") clauses.push(`description ~ "${rqtValue}"`);
    else if (f.fieldId === "comment") clauses.push(`comment ~ "${rqtValue}"`);
  }
  return clauses.length ? clauses.join(" OR ") : `text ~ "${rqtValue}"`;
}

export function formatLogTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatShortTime(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(new Date(value));
  } catch {
    return "";
  }
}

export function formatRelativeTime(value) {
  if (!value) return null;
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}


export function formatContextList(values, fallback) {
  return values?.length ? values.join(", ") : fallback;
}

export function normalizeSiteOrigin(siteUrl) {
  if (!siteUrl) return "";

  try {
    return new URL(siteUrl).origin;
  } catch {
    return "";
  }
}

export function buildJiraSearchUrl(siteOrigin, jql) {
  if (!siteOrigin || !jql) return null;
  return `${siteOrigin}/issues/?jql=${encodeURIComponent(jql)}`;
}

// Deep link to one issue by key, e.g. a remediation epic or task.
export function buildIssueUrl(siteOrigin, issueKey) {
  if (!siteOrigin || !issueKey) return null;
  return `${siteOrigin}/browse/${encodeURIComponent(issueKey)}`;
}

export function handleJiraLinkClick(e, href) {
  if (!href || href === "#") return;
  e.preventDefault();
  router.open(href);
}

// Deep link to one automation rule in Jira's global automation admin.
//
// The global path is used rather than the project-scoped one
// (/jira/software/projects/KEY/settings/automate) because a rule's project scope is not
// always known here -- site-wide rules have none, and multi-project rules have several, so
// there is no single project to route through. The global view resolves any rule by id,
// and every caller of this is already behind the Jira admin check.
// Prompt for the automation agent, seeded from what the card already knows.
//
// The counts are included so the agent can confirm or contradict them rather than starting
// from nothing -- and so a stale analysis shows up as a disagreement the reader can see,
// instead of two confident answers that quietly differ.
export function buildAutomationRovoPrompt(field, usage) {
  const name = field?.name || field?.id || "this field";
  const lines = [
    `Is the Jira field "${name}" (${field?.id ?? "unknown id"}) safe to delete or change?`,
    "",
    "Use the automation-usage action for this field, then answer:",
    "1. Which rules would break, and how.",
    "2. Whether any of them are disabled, and what that means for the decision.",
    "3. What you cannot see, so I know what is left to check myself.",
  ];

  if (usage?.available && usage?.referenced) {
    const counts = ["write", "read", "trigger"]
      .map((k) => (usage[k]?.count ? `${usage[k].count} ${k}` : null))
      .filter(Boolean)
      .join(", ");
    if (counts) lines.push("", `Observatory currently records: ${counts}.`);
  } else if (usage?.available) {
    lines.push("", "Observatory records no automation reference for this field. Confirm that.");
  }

  return lines.join("\n");
}

// Prompt for the saved-filter usage panel. Same shape as the automation prompt: seed the
// agent with what Observatory already knows, so a stale count shows up as a disagreement
// rather than two confident answers that quietly differ.
export function buildFilterUsageRovoPrompt(field, usage) {
  const name = field?.name || field?.id || "this field";
  const lines = [
    `Which saved Jira filters depend on the field "${name}" (${field?.id ?? "unknown id"}), and what breaks if it is deleted or renamed?`,
    "",
    "Use the saved-filter usage for this field, then answer:",
    "1. Which filters would silently start returning the wrong issues.",
    "2. Whether any of them are subscribed to, or shared with everyone -- that raises who notices and how loudly.",
    "3. What you cannot see, so I know what is left to check myself.",
  ];

  if (usage?.available && usage?.total > 0) {
    lines.push("", `Observatory currently records ${usage.total} filter${usage.total === 1 ? "" : "s"} referencing this field.`);
  } else if (usage?.available) {
    lines.push("", "Observatory records no saved filter referencing this field. Confirm that.");
  }

  return lines.join("\n");
}

// Prompt for the dashboard usage panel -- the second-order consequence of a filter breaking:
// a dashboard gadget that renders through one of the filters above.
export function buildDashboardUsageRovoPrompt(field, usage) {
  const name = field?.name || field?.id || "this field";
  const lines = [
    `Which dashboards render a gadget through a filter that depends on the field "${name}" (${field?.id ?? "unknown id"})?`,
    "",
    "Use the dashboard usage for this field, then answer:",
    "1. Which dashboards would start showing a gadget with the wrong issues, or a blank one, if this field is deleted or renamed.",
    "2. Which of those dashboards are widely favourited -- that is the closest signal to how many people would notice.",
    "3. What you cannot see, so I know what is left to check myself.",
  ];

  if (usage?.available && usage?.total > 0) {
    lines.push("", `Observatory currently records ${usage.total} dashboard${usage.total === 1 ? "" : "s"} reached through ${usage.viaFilters} filter${usage.viaFilters === 1 ? "" : "s"}.`);
    if (usage.complete === false) {
      lines.push("The gadget configuration walk has not finished, so this may be an undercount.");
    }
  } else if (usage?.available) {
    lines.push("", "Observatory records no dashboard reaching this field through a gadget. Confirm that.");
  }

  return lines.join("\n");
}

// Prompt for the screen usage panel: whether a person can even fill this field in through a
// form, which is the strongest signal this app has for whether a field is genuinely alive.
export function buildScreenUsageRovoPrompt(field, result) {
  const name = field?.name || field?.id || "this field";
  const rows = result?.screens || [];
  const lines = [
    `Which screens carry the field "${name}" (${field?.id ?? "unknown id"}), and does anyone actually see it?`,
    "",
    "Use the screen usage for this field, then answer:",
    "1. Whether the screens that carry it are ones people actually work from, or leftover forms nobody opens.",
    "2. If it is on no screen at all, whether automation or an integration could still be writing to it silently.",
    "3. What you cannot see, so I know what is left to check myself.",
  ];

  if (result?.available) {
    lines.push("", `Observatory currently records ${rows.length} screen${rows.length === 1 ? "" : "s"} carrying this field.`);
    if (result.unresolvedScreens > 0) {
      lines.push(`${result.unresolvedScreens} screen${result.unresolvedScreens === 1 ? "" : "s"} could not be read in the last build, so this may be incomplete.`);
    }
  }

  return lines.join("\n");
}

// Prompt for the Contexts panel: where a field is configured, as distinct from where it is
// used -- a field can be on every project's context and touched by none of them.
export function buildContextsRovoPrompt(field, details) {
  const name = field?.name || field?.id || "this field";
  const contexts = details?.contexts || [];
  const contextNames = contexts.map((c) => c.name).slice(0, 8);
  const globalCount = contexts.filter((c) => c.isGlobalContext).length;

  return [
    `Review the configuration contexts for the Jira field "${name}" (${field?.id ?? "unknown id"}).`,
    "",
    "Use the field details for this field, then answer:",
    "1. Whether the number of contexts suggests this was added project-by-project rather than deliberately scoped.",
    "2. Whether a global context here is carrying its weight, or exposing the field to projects that never asked for it.",
    "3. What you cannot see, so I know what is left to check myself.",
    "",
    `Observatory currently records ${contexts.length} context${contexts.length === 1 ? "" : "s"}${globalCount ? `, ${globalCount} of them global` : ""}.`,
    contextNames.length ? `Sample context names: ${contextNames.join(", ")}.` : "",
  ].filter(Boolean).join("\n");
}

export function buildAutomationRuleUrl(siteOrigin, ruleId) {
  if (!siteOrigin || ruleId === null || ruleId === undefined || ruleId === "") return null;
  return `${siteOrigin}/jira/settings/automation#/rule/${encodeURIComponent(ruleId)}`;
}

export function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// Copy text to the clipboard, resolving true on success and false on failure.
//
// navigator.clipboard is not dependable here: Forge Custom UI renders inside a sandboxed
// cross-origin iframe, and unless the host page grants the clipboard-write permission
// policy the API is either missing outright or present-but-rejecting. The execCommand
// path is deprecated but still the only thing that works in that case, so it stays as a
// fallback rather than an alternative.
export async function copyToClipboard(text) {
  const value = String(text ?? "");
  if (!value) return false;

  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Permission policy blocked it — fall through to the textarea path.
    }
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    // Keep it out of view and out of the tab order, and avoid scrolling the card away.
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return Boolean(ok);
  } catch {
    return false;
  }
}

export function slugifyFilenamePart(value, fallback = "report") {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export function normalizeReportData(reportData) {
  const normalizedFields = Array.isArray(reportData?.fields)
    ? reportData.fields.map((field) => ({
        ...field,
        projects: Array.isArray(field?.projects) ? field.projects : [],
      }))
    : [];

  return {
    fields: normalizedFields,
    projects: Array.isArray(reportData?.projects) ? reportData.projects : [],
    pendingFields: Array.isArray(reportData?.pendingFields) ? reportData.pendingFields : [],
    uniqueIssueCount: Number.isFinite(reportData?.uniqueIssueCount) ? reportData.uniqueIssueCount : null,
  };
}

export function groupReportFieldsByType(fields) {
  const grouped = new Map();

  for (const field of fields || []) {
    const typeKey = String(field?.fieldType || "unknown").trim() || "unknown";
    const bucket = grouped.get(typeKey) || [];
    bucket.push({
      ...field,
      fieldId: String(field?.fieldId || ""),
      fieldName: String(field?.fieldName || field?.fieldId || "Unnamed field"),
      fieldType: typeKey,
      projects: Array.isArray(field?.projects) ? field.projects : [],
    });
    grouped.set(typeKey, bucket);
  }

  return Array.from(grouped.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([fieldType, groupedFields]) => ({
      fieldType,
      fields: [...groupedFields].sort(
        (left, right) =>
          String(left?.fieldName || "").localeCompare(String(right?.fieldName || ""))
          || String(left?.fieldId || "").localeCompare(String(right?.fieldId || ""))
      ),
    }));
}

export function summarizeReportData(fields, projects, uniqueIssueCount = null) {
  const projectTotals = new Map();
  const fieldTotals = [];
  const typeTotals = new Map();
  let populatedCells = 0;
  let totalIssues = 0;

  for (const field of fields || []) {
    let fieldIssueCount = 0;
    const fieldProjects = Array.isArray(field?.projects) ? field.projects : [];
    populatedCells += fieldProjects.length;

    for (const project of fieldProjects) {
      const issueCount = Number(project.issueCount || 0);
      fieldIssueCount += issueCount;
      totalIssues += issueCount;
      const projectId = String(project?.projectId || project?.projectKey || "");
      const projectKey = String(project?.projectKey || projectId || "Unknown");
      const projectName = String(project?.projectName || projectKey || "Unknown project");

      const existingProject = projectTotals.get(projectId) || {
        projectId,
        projectKey,
        projectName,
        issueCount: 0,
        fieldCount: 0,
      };
      existingProject.issueCount += issueCount;
      existingProject.fieldCount += 1;
      projectTotals.set(projectId, existingProject);
    }

    fieldTotals.push({
      fieldId: String(field?.fieldId || ""),
      fieldName: String(field?.fieldName || field?.fieldId || "Unnamed field"),
      fieldType: String(field?.fieldType || "unknown"),
      issueCount: fieldIssueCount,
      activeProjectCount: fieldProjects.length,
    });

    const typeKey = String(field?.fieldType || "unknown").trim() || "unknown";
    const existingType = typeTotals.get(typeKey) || {
      fieldType: typeKey,
      fieldCount: 0,
      issueCount: 0,
      activeProjectCount: 0,
    };
    existingType.fieldCount += 1;
    existingType.issueCount += fieldIssueCount;
    existingType.activeProjectCount += fieldProjects.length;
    typeTotals.set(typeKey, existingType);
  }

  const totalPossibleCells = (fields?.length || 0) * (projects?.length || 0);

  return {
    populatedCells,
    totalIssues,
    uniqueIssueCount,
    totalPossibleCells,
    coverageRatio: totalPossibleCells ? populatedCells / totalPossibleCells : 0,
    topProjects: Array.from(projectTotals.values())
      .sort((left, right) => right.issueCount - left.issueCount || left.projectKey.localeCompare(right.projectKey))
      .slice(0, 8),
    topFields: fieldTotals
      .sort((left, right) => right.issueCount - left.issueCount || left.fieldName.localeCompare(right.fieldName))
      .slice(0, 8),
    typeTotals: Array.from(typeTotals.values()).sort(
      (left, right) => right.issueCount - left.issueCount || left.fieldType.localeCompare(right.fieldType)
    ),
  };
}

export function isUsageAvailable(source) {
  return (source?.usageStatus || "ready") === "ready";
}

const SELECT_FIELD_TYPE_KEYWORDS = ["select", "multiselect", "radiobutton", "checkbox", "cascadingselect"];
export function isSelectType(fieldType) {
  const normalized = String(fieldType || "").toLowerCase().replace(/[\s\-_]/g, "");
  return SELECT_FIELD_TYPE_KEYWORDS.some((kw) => normalized.includes(kw));
}

// True for a field whose value is one or more people: the userpicker / multiuserpicker
// custom types, and the assignee / reporter system fields. Used to decide whether the
// "People in this field" cross-pillar section is worth showing.
const USER_PICKER_SYSTEM_IDS = new Set(["assignee", "reporter"]);
export function isUserPickerField(field) {
  if (!field) return false;
  if (USER_PICKER_SYSTEM_IDS.has(String(field.id))) return true;
  const haystack = `${field.type || ""} ${field.customType || ""} ${field.fieldType || ""}`.toLowerCase();
  return /user\s*picker|userpicker|:userpicker|:multiuserpicker|people/.test(haystack);
}

export function mergeFieldMetrics(field, source) {
  if (!source) {
    return field;
  }

  const sourceField = source.field || source;
  const configuredProjectCount = Math.max(
    field?.configuredProjectCount ?? field?.usageCount ?? 0,
    sourceField?.configuredProjectCount ?? source?.configuredProjectCount ?? sourceField?.usageCount ?? 0
  );
  const activeProjectCount = Math.max(
    field?.activeProjectCount ?? 0,
    sourceField?.activeProjectCount ?? source?.activeProjectCount ?? 0
  );
  const totalIssueCount = Math.max(
    field?.totalIssueCount ?? 0,
    sourceField?.totalIssueCount ?? source?.totalIssueCount ?? 0
  );
  const derivedProjectUsageBuilt =
    sourceField?.projectUsageBuilt ??
    source?.projectUsageBuilt ??
    (source?.summaryStatus === "ready" ? true : undefined);
  const derivedProjectUsageState =
    sourceField?.projectUsageState ||
    source?.projectUsageState ||
    source?.summaryStatus ||
    null;

  return {
    ...field,
    configuredProjectCount,
    usageCount: configuredProjectCount,
    activeProjectCount,
    totalIssueCount,
    usageStatus: sourceField?.usageStatus || source?.usageStatus || field?.usageStatus || "ready",
    usageStatusDetail: sourceField?.usageStatusDetail || source?.usageStatusDetail || field?.usageStatusDetail || null,
    projectUsageBuilt: derivedProjectUsageBuilt ?? field?.projectUsageBuilt ?? false,
    projectUsageState: derivedProjectUsageState || field?.projectUsageState || "unbuilt",
    findings: source?.findings || sourceField?.findings || field?.findings,
  };
}

// One Rovo agent per pillar. The key is the manifest `rovo:agent` key and MUST match it
// exactly; `name` is the manifest `name` and is what rovo.open() needs to route the deep
// link. `reads` is the one-line "what context this agent works from", shown in the Ask Rovo
// tooltip so a person knows what the button is about to send before they click it.
//
// Adding a pillar agent: add the entry here, add the matching rovo:agent + actions +
// functions to manifest.yml, add resource/agent/prompts/<pillar>-expert.txt (starting with
// the shared preamble), and wire <AskRovo agent="..."> into that pillar's tab. The
// agent-prompts test asserts every key here has a prompt file and vice versa.
export const ROVO_AGENTS = {
  "observatory-field-expert": {
    name: "Observatory Field Expert",
    reads: "the custom field snapshot and per-project usage",
  },
  "observatory-automation-expert": {
    name: "Observatory Automation Expert",
    reads: "the imported automation rule analysis",
  },
  "observatory-workflow-expert": {
    name: "Observatory Workflow Expert",
    reads: "the workflow scheme and status inventory",
  },
  "observatory-issuetype-expert": {
    name: "Observatory Issue Type Expert",
    reads: "the issue type catalogue and its schemes",
  },
  "observatory-screen-expert": {
    name: "Observatory Screen Expert",
    reads: "the screen, tab and scheme inventory",
  },
  "observatory-access-expert": {
    name: "Observatory Access Expert",
    reads: "permission, issue-security and notification schemes and project roles",
  },
  "observatory-people-expert": {
    name: "Observatory People Expert",
    reads: "the licensed-user roster and ownership graph",
  },
  "observatory-assets-expert": {
    name: "Observatory Assets Expert",
    reads: "the JSM Assets object schema and type structure",
  },
  "observatory-estate-expert": {
    name: "Observatory Priorities Expert",
    reads: "the resolution and priority value lists",
  },
  "observatory-change-expert": {
    name: "Observatory Change Expert",
    reads: "the configuration change-history timeline",
  },
  "observatory-project-expert": {
    name: "Observatory Project Expert",
    reads: "per-project scheme identity, adoption and field usage",
  },
};

// Open a Rovo agent, pre-seeded with a prompt. Every "Ask Rovo" button in the product goes
// through here (via <AskRovo>) so the deep link is built one way. rovo.open() rejects if
// Rovo is not available on the site; callers swallow that -- the button is best-effort.
export async function openRovo(agentKey, prompt) {
  const agent = ROVO_AGENTS[agentKey];
  if (!agent) throw new Error(`openRovo: unknown agent "${agentKey}"`);
  await rovo.open({
    type: "forge",
    agentName: agent.name,
    agentKey,
    prompt,
  });
}

// Retained for the field-pillar call sites that predate the registry. New code uses
// <AskRovo> or openRovo() directly.
export async function openFieldExpertRovo(prompt) {
  await openRovo("observatory-field-expert", prompt);
}

// The one prompt shape. `task` is the question the agent should answer first; `facts` is an
// ordered list of [label, value] the agent should reason from. Empty / null / undefined
// values are dropped so a caller does not have to guard every field. Produces the same
// "one sentence of task, then labelled evidence" structure the agent prompts expect,
// regardless of which pillar built it.
export function buildRovoPrompt({ task, facts = [] }) {
  const lines = [String(task || "").trim()].filter(Boolean);
  for (const [label, value] of facts) {
    if (value === undefined || value === null || value === "") continue;
    lines.push(`${label}: ${value}.`);
  }
  return lines.join(" ");
}

export function buildInventoryRovoPrompt({ totalFields, availableTypes, refreshedAt, currentPage, totalPages, query, typeFilter, sortBy }) {
  return [
    "You are reviewing the Observatory Jira custom field inventory.",
    `Snapshot refreshed at: ${refreshedAt || "unknown"}.`,
    `Visible fields in the current filtered inventory: ${totalFields}.`,
    `Current page: ${currentPage} of ${totalPages}.`,
    `Current search query: ${query || "none"}.`,
    `Current field type filter: ${typeFilter === "all" ? "all types" : typeFilter}.`,
    `Current sort: ${sortBy}.`,
    `Available field types in snapshot: ${formatContextList(availableTypes, "unknown")}.`,
    "Explain the overall field inventory, call out notable governance signals, prioritize admin attention, and recommend the next actions an admin should take.",
  ].join(" ");
}

export function buildFieldRovoPrompt(field, details) {
  const contexts = details?.contexts || [];
  const contextNames = contexts.map((context) => context.name).slice(0, 8);
  const projectSamples = contexts.flatMap((context) => context.projects?.map((project) => project.key) || []).slice(0, 12);
  const fieldJql = details?.fieldJql || field.fieldJql;
  const findings = details?.findings || details?.field?.findings || field.findings;

  return [
    "Explain this Jira custom field in detail.",
    `Field id: ${field.id}.`,
    `Field name: ${field.name}.`,
    `Field type: ${field.type}.`,
    `Description: ${field.description || "none"}.`,
    `Configured project count: ${details?.configuredProjectCount ?? field.configuredProjectCount ?? field.usageCount ?? 0}.`,
    `Per-project usage status: ${details?.field?.usageStatus || details?.usageStatus || field.usageStatus || "ready"}.`,
    `Active project count: ${isUsageAvailable(details?.field || details || field) ? (details?.activeProjectCount ?? field.activeProjectCount ?? 0) : "unavailable"}.`,
    `Total issues with populated values: ${isUsageAvailable(details?.field || details || field) ? (details?.totalIssueCount ?? field.totalIssueCount ?? 0) : "unavailable"}.`,
    `Context scope: ${details?.hasGlobalContext ? "global" : "scoped"}.`,
    `Field-wide JQL: ${fieldJql}.`,
    `Sample contexts: ${formatContextList(contextNames, "none")}.`,
    `Sample project keys in scope: ${formatContextList(projectSamples, "none")}.`,
    `Current governance findings: ${formatContextList(findings?.reasons?.map((reason) => reason.title) || [], "none")}.`,
    "Describe what this field does, where it is used, which governance risks or cleanup opportunities exist, and what an admin should review next.",
  ].join(" ");
}

export function buildProjectRovoPrompt(field, details, project) {
  return [
    "Explain how a single project is using this Jira custom field.",
    `Field id: ${field.id}.`,
    `Field name: ${field.name}.`,
    `Field type: ${field.type}.`,
    `Project key: ${project.projectKey}.`,
    `Project name: ${project.projectName}.`,
    `Issues with populated values in this project: ${project.issueCount}.`,
    `Latest field activity: ${project.latestFieldChangeAt || "unknown"}.`,
    `Latest matching issue key: ${project.latestIssueKey || "none"}.`,
    `Project-scoped JQL: ${project.jql}.`,
    `Field-wide total issues with values: ${details?.totalIssueCount ?? field.totalIssueCount ?? 0}.`,
    "Explain what this usage pattern suggests, how the project appears to rely on the field, and what governance or standardization checks should be performed.",
  ].join(" ");
}

export function buildReportRovoPrompt({ reportName, fields, projects, pendingFields, reportSummary }) {
  const fieldTypes = Array.from(new Set((fields || []).map((field) => field?.fieldType).filter(Boolean))).sort();
  const topFieldNames = (reportSummary?.topFields || []).slice(0, 8).map((field) => field.fieldName);
  const topProjectKeys = (reportSummary?.topProjects || []).slice(0, 8).map((project) => project.projectKey);
  const pendingNames = (pendingFields || []).slice(0, 8).map((field) => field.fieldName);

  return [
    "Review this Observatory report as a collection of Jira custom fields across all included projects.",
    `Report name: ${reportName || "Project Usage Report"}.`,
    `Selected field count: ${fields?.length || 0}.`,
    `Visible project count: ${projects?.length || 0}.`,
    `Field types represented: ${formatContextList(fieldTypes, "unknown")}.`,
    `Populated project-field intersections: ${reportSummary?.populatedCells ?? 0}.`,
    `Total populated issue intersections: ${reportSummary?.totalIssues ?? 0}.`,
    `Distinct populated issues across the selected fields: ${reportSummary?.uniqueIssueCount ?? "unknown"}.`,
    `Top fields by populated issues: ${formatContextList(topFieldNames, "none")}.`,
    `Top projects in this report: ${formatContextList(topProjectKeys, "none")}.`,
    `Fields still pending usage hydration: ${formatContextList(pendingNames, "none")}.`,
    "Explain the dominant usage patterns across this collection of fields, call out cleanup or standardization opportunities, identify risk concentrations, and recommend the next administrative actions for this report as a whole.",
  ].join(" ");
}


// True for a Jira custom field, false for a system field.
//
// Jira custom fields are always `customfield_NNNNN`; everything else (comment, worklog,
// priority, reporter, status, summary, labels...) is a system field present on every
// issue in every project. Counting those in a per-project breakdown says nothing about
// how a project is configured -- they are there whether anyone configured anything or
// not -- and on a small project they can outnumber the real custom fields.
export function isCustomField(fieldId) {
  return String(fieldId || "").startsWith("customfield_");
}


// ── Client-side table controls ──────────────────────────────────────────────
//
// The in-memory half of the shared SortFilterBar. Tabs that load a whole document (RQT,
// Automation, Workflows, Project Usage) run their rows through this; the two server-paged
// tabs push the same values into a resolver instead, because sorting a page of 25 out of
// 1,612 rows sorts the wrong thing.
//
// Kept here rather than inside the component so the two halves cannot disagree about what
// "name-asc" means, and so the ordering is testable without rendering anything.

// Dotted paths so a caller can search or sort on a nested value ("meta.owner") without
// flattening its rows first.
function readPath(row, path) {
  if (row == null) return undefined;
  if (!String(path).includes(".")) return row[path];
  return String(path).split(".").reduce((value, key) => (value == null ? undefined : value[key]), row);
}

// Case-insensitive and undefined-safe: a row missing the key must not match every search,
// and must not throw.
//
// Deliberately not accent-folding. Doing it properly needs a combining-mark range in the
// source, which is invisible in review and does not survive every editor intact -- and Jira
// field and status names on the sites this runs against are overwhelmingly ASCII. If that
// stops being true, normalize("NFKD") plus a ̀-ͯ strip is the change.
function haystack(value) {
  if (value == null) return "";
  return String(value).toLowerCase();
}

export function matchesSearch(row, term, searchKeys = []) {
  const needle = haystack(term).trim();
  if (!needle) return true;
  return searchKeys.some((key) => haystack(readPath(row, key)).includes(needle));
}

// Numbers before strings, nulls last regardless of direction.
//
// Nulls-last in BOTH directions is the deliberate part: flipping a sort should reorder the
// rows that have a value, not promote the ones that are missing it to the top. A table
// sorted "most issues first" that shows unmeasured rows first is worse than unsorted.
export function compareValues(a, b, dir = "asc") {
  const missingA = a == null || a === "";
  const missingB = b == null || b === "";
  if (missingA && missingB) return 0;
  if (missingA) return 1;
  if (missingB) return -1;

  const numA = typeof a === "number" ? a : Number(a);
  const numB = typeof b === "number" ? b : Number(b);
  const bothNumeric = Number.isFinite(numA) && Number.isFinite(numB);

  const result = bothNumeric
    ? numA - numB
    : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });

  return dir === "desc" ? -result : result;
}

// `sort` is a "<key>-<dir>" token, matching the values the SortFilterBar's options use and
// the tokens the resolvers accept, so one string travels from the select to either engine.
export function parseSortToken(token, fallback = { key: null, dir: "asc" }) {
  const raw = String(token ?? "").trim();
  if (!raw) return fallback;
  const index = raw.lastIndexOf("-");
  if (index <= 0) return { key: raw, dir: "asc" };
  const dir = raw.slice(index + 1);
  if (dir !== "asc" && dir !== "desc") return { key: raw, dir: "asc" };
  return { key: raw.slice(0, index), dir };
}

// Returns a NEW array; never sorts in place. Sorting the caller's array mutates React state
// held elsewhere, which is the kind of bug that only shows up as a list that will not
// re-render.
export function applyTableControls(rows = [], {
  search = "",
  searchKeys = [],
  sort = "",
  sortKeys = {},
  filters = [],
  allValue = "all",
} = {}) {
  let out = Array.isArray(rows) ? rows : [];

  if (String(search ?? "").trim() && searchKeys.length) {
    out = out.filter((row) => matchesSearch(row, search, searchKeys));
  }

  for (const filter of filters) {
    const value = filter?.value;
    if (value == null || value === "" || value === (filter.allValue ?? allValue)) continue;
    out = filter.predicate
      ? out.filter((row) => filter.predicate(row, value))
      : out.filter((row) => String(readPath(row, filter.key)) === String(value));
  }

  const { key, dir } = parseSortToken(sort);
  if (key) {
    // A sortKeys entry may be an accessor function or a path string; anything else falls
    // back to the key itself, so a sort token with no mapping still orders by that field
    // rather than silently doing nothing.
    const accessor = sortKeys[key];
    const read = typeof accessor === "function" ? accessor : (row) => readPath(row, accessor || key);
    out = [...out].sort((a, b) => compareValues(read(a), read(b), dir));
  } else if (out === rows) {
    out = [...out];
  }

  return out;
}
