// Direct links into Jira, for remediation tickets.
//
// A ticket that names "permission scheme 10200" and leaves its reader to find it has done half
// its job. Every playbook links the thing it is about, so these builders cover every kind of
// item a playbook can ticket. The frontend has its own copies of the ones the UI needs
// (static/src/utils.js); these are the backend's, used only when writing a ticket.
//
// `origin` is the site's base URL (serverInfo.baseUrl). Every builder returns null without one,
// and md() renders a null link as the plain label -- a ticket is still written, just unlinked.

const enc = encodeURIComponent;
const present = (v) => v !== null && v !== undefined && v !== "";

// The numeric part of "customfield_12345" -- the id Jira's classic field admin pages take.
function customFieldNumber(fieldId) {
  const m = String(fieldId || "").match(/^customfield_(\d+)$/);
  return m ? m[1] : null;
}

export const jiraLinks = {
  search: (o, jql) => (o && jql ? `${o}/issues/?jql=${enc(jql)}` : null),
  issue: (o, key) => (o && key ? `${o}/browse/${enc(key)}` : null),
  project: (o, key) => (o && key ? `${o}/browse/${enc(key)}` : null),
  projectRoles: (o, key) => (o && key ? `${o}/plugins/servlet/project-config/${enc(key)}/roles` : null),
  projectSettings: (o, key) => (o && key ? `${o}/plugins/servlet/project-config/${enc(key)}/summary` : null),
  filter: (o, id) => (o && present(id) ? `${o}/issues/?filter=${enc(id)}` : null),
  dashboard: (o, id) => (o && present(id) ? `${o}/jira/dashboards/${enc(id)}` : null),
  // RapidBoard resolves any board by id, whichever project (or person) it lives under.
  board: (o, id) => (o && present(id) ? `${o}/secure/RapidBoard.jspa?rapidView=${enc(id)}` : null),
  field: (o, fieldId) => {
    const n = customFieldNumber(fieldId);
    return o && n ? `${o}/secure/admin/EditCustomField!default.jspa?id=${n}` : null;
  },
  fieldContexts: (o, fieldId) => {
    const n = customFieldNumber(fieldId);
    return o && n ? `${o}/secure/admin/ConfigureCustomField!default.jspa?customFieldId=${n}` : null;
  },
  fieldAdmin: (o) => (o ? `${o}/secure/admin/ViewCustomFields.jspa` : null),
  statusAdmin: (o) => (o ? `${o}/secure/admin/ViewStatuses.jspa` : null),
  // Legacy field configurations and their schemes, by numeric id. Field schemes have no
  // stable admin URL published yet, so they link nowhere rather than somewhere wrong.
  fieldConfiguration: (o, id) => (o && present(id) ? `${o}/secure/admin/ConfigureFieldLayout!default.jspa?id=${enc(id)}` : null),
  fieldConfigurationScheme: (o, id) => (o && present(id) ? `${o}/secure/admin/ConfigureFieldLayoutScheme!default.jspa?id=${enc(id)}` : null),
  fieldConfigurationsAdmin: (o) => (o ? `${o}/secure/admin/ViewFieldLayouts.jspa` : null),
  workflow: (o, name) => (o && present(name) ? `${o}/secure/admin/workflows/ViewWorkflowSteps.jspa?workflowMode=live&workflowName=${enc(name)}` : null),
  workflowsAdmin: (o) => (o ? `${o}/secure/admin/workflows/ListWorkflows.jspa` : null),
  workflowScheme: (o, id) => (o && present(id) ? `${o}/secure/admin/EditWorkflowScheme.jspa?schemeId=${enc(id)}` : null),
  issueTypeAdmin: (o) => (o ? `${o}/secure/admin/ViewIssueTypes.jspa` : null),
  issueTypeScheme: (o, id) => (o && present(id) ? `${o}/secure/admin/ConfigureOptionSchemes!default.jspa?schemeId=${enc(id)}` : null),
  screen: (o, id) => (o && present(id) ? `${o}/secure/admin/ConfigureFieldScreen.jspa?id=${enc(id)}` : null),
  screenScheme: (o, id) => (o && present(id) ? `${o}/secure/admin/ConfigureFieldScreenScheme.jspa?id=${enc(id)}` : null),
  permissionScheme: (o, id) => (o && present(id) ? `${o}/secure/admin/EditPermissions!default.jspa?schemeId=${enc(id)}` : null),
  notificationScheme: (o, id) => (o && present(id) ? `${o}/secure/admin/EditNotifications!default.jspa?schemeId=${enc(id)}` : null),
  securityScheme: (o, id) => (o && present(id) ? `${o}/secure/admin/EditIssueSecurities!default.jspa?schemeId=${enc(id)}` : null),
  priorityAdmin: (o) => (o ? `${o}/secure/admin/ViewPriorities.jspa` : null),
  resolutionAdmin: (o) => (o ? `${o}/secure/admin/ViewResolutions.jspa` : null),
  projectRolesAdmin: (o) => (o ? `${o}/secure/project/ViewProjectRoles.jspa` : null),
  person: (o, accountId) => (o && accountId ? `${o}/jira/people/${enc(accountId)}` : null),
  automationRule: (o, id) => (o && present(id) ? `${o}/jira/settings/automation#/rule/${enc(id)}` : null),
  assetSchema: (o, id) => (o && present(id) ? `${o}/secure/ObjectSchema.jspa?id=${enc(id)}` : null),
  assetType: (o, schemaId, typeId) => (o && present(schemaId) && present(typeId)
    ? `${o}/secure/ObjectSchema.jspa?id=${enc(schemaId)}&typeId=${enc(typeId)}`
    : null),
};

// A markdown-style link for renderADF, or the bare label when there is no URL. Brackets in
// the label are softened so a name like "[Legacy] Bugs" cannot break the link syntax.
export function md(label, url) {
  const text = String(label ?? "").replace(/[[\]]/g, (c) => (c === "[" ? "(" : ")")) || "link";
  return url ? `[${text}](${url})` : text;
}
