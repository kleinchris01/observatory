// The quarter's Jira hierarchy above the remediation epics:
//
//   Product      "2026-Q4 Observatory Findings and Remediations"        (one per quarter)
//   └ Initiative "2026-Q4 - Fields Remediation"                         (one per pillar label)
//     └ Epic     "2026-Q4: Remove 40 fields configured where unused"    (one per finding)
//       └ Task                                                          (one per item)
//
// Built on demand, as the admin who pressed a remediation button, never on a timer: the
// first epic of a quarter brings its Product and Initiative with it. Before creating a node it
// looks in the remediation project for one whose summary matches -- ignoring dashes, spaces
// and case -- and adopts it, so a hierarchy an admin already built by hand is used rather than
// duplicated. Every node found or created is recorded, so later epics never search again.
//
// Dependencies are passed in (`deps`) so the rules are tested without Jira or SQL.

// The initiative each playbook pillar files under. Several pillars may share a label (they
// then share an initiative); the labels match the hierarchy the site already uses.
export const INITIATIVE_LABELS = {
  fields: "Fields",
  fieldConfigs: "Field Configuration",
  workflows: "Workflow",
  screens: "Screen",
  issueTypes: "Work Types",
  estate: "Priorities",
  projects: "Projects",
  users: "Users",
  roles: "Roles",
  permissions: "Permissions",
  security: "Issue Security",
  notifications: "Notifications",
  filters: "Filters",
  dashboards: "Dashboards",
  boards: "Boards",
  assets: "Assets",
  automation: "Automation",
};

export const ROOT_NODE = "root";

export function initiativeLabelFor(pillar) {
  return INITIATIVE_LABELS[pillar] || String(pillar || "Other");
}

export function initiativeNode(label) {
  return `initiative:${label}`;
}

export function rootSummary(period) {
  return `${period} Observatory Findings and Remediations`;
}

export function initiativeSummary(period, label) {
  return `${period} - ${label} Remediation`;
}

// "2026-Q4 Roles Remediation" and "2026-Q4 - Roles Remediation" are the same item.
export function normalizeSummary(summary) {
  return String(summary || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const jqlQuote = (value) => `"${String(value).replace(/["\\]/g, "\\$&")}"`;

// One node: recorded -> found in Jira -> created. Returns { issueKey, created, adopted }.
//
// deps: {
//   nodes: Map<node, { issueKey }>        -- this quarter's recorded nodes (mutated as nodes are added)
//   searchIssuesPage(jql, fields, max)    -- jira-api.searchIssuesPage
//   createJiraIssue(fields, opts)         -- jira-api.createJiraIssue
//   recordHierarchyNode(scope, period, node, { issueKey, issueId, adopted })
//   existing: Map<issueType, issue[]>     -- per-invocation cache of the project's items of a type
// }
export async function ensureNode({ scopeKey, period, node, summary, issueType, parentKey = null, projectKey, accountId }, deps) {
  const recorded = deps.nodes.get(node);
  if (recorded?.issueKey) return { issueKey: recorded.issueKey, created: false, adopted: false };

  if (!deps.existing.has(issueType)) {
    const issues = await deps.searchIssuesPage(
      `project = ${jqlQuote(projectKey)} AND issuetype = ${jqlQuote(issueType)} ORDER BY created DESC`,
      ["summary"],
      100,
    );
    deps.existing.set(issueType, issues);
  }
  const want = normalizeSummary(summary);
  const match = deps.existing.get(issueType).find((issue) => normalizeSummary(issue.fields?.summary) === want);
  if (match) {
    await deps.recordHierarchyNode(scopeKey, period, node, { issueKey: match.key, issueId: match.id, adopted: true });
    deps.nodes.set(node, { issueKey: match.key });
    return { issueKey: match.key, created: false, adopted: true };
  }

  const fields = {
    project: { key: projectKey },
    issuetype: { name: issueType },
    summary: summary.slice(0, 250),
    reporter: { id: accountId },
    ...(parentKey ? { parent: { key: parentKey } } : {}),
  };
  const created = await deps.createJiraIssue(fields, { asUser: true });
  await deps.recordHierarchyNode(scopeKey, period, node, { issueKey: created.key, issueId: created.id, adopted: false });
  deps.nodes.set(node, { issueKey: created.key });
  deps.existing.get(issueType).push({ key: created.key, id: created.id, fields: { summary } });
  return { issueKey: created.key, created: true, adopted: false };
}

// The initiative a pillar's epic belongs under, creating (or adopting) the quarter's root first.
export async function ensureInitiativeFor({ scopeKey, period, pillar, config, projectKey, accountId }, deps) {
  const root = await ensureNode({
    scopeKey, period, node: ROOT_NODE, summary: rootSummary(period),
    issueType: config.rootIssueType || "Product", projectKey, accountId,
  }, deps);
  const label = initiativeLabelFor(pillar);
  const initiative = await ensureNode({
    scopeKey, period, node: initiativeNode(label), summary: initiativeSummary(period, label),
    issueType: config.initiativeIssueType || "Initiative", parentKey: root.issueKey, projectKey, accountId,
  }, deps);
  return { rootKey: root.issueKey, initiativeKey: initiative.issueKey, label };
}
