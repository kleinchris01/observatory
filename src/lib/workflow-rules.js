// What a workflow enforces: the conditions, validators and post-functions on each
// transition, the properties on each status and transition, and everything those point at.
//
// The workflow read has returned all of this since it moved to GET /workflows/search with
// expand=values.transitions -- the snapshot just kept the screen and dropped the rest. That
// left two questions an admin asks before any field or group change with no answer:
//
//   "Where does a workflow validate, check or write this field -- on which transition,
//    between which statuses?"
//   "Which statuses lock editing (or commenting, or anything) down to one group?"
//
// Pure functions over the workflow JSON. No I/O, no Forge SQL: workflow-engine.js decides
// what to read and store, this decides what it means.
//
// RAW RULE PARAMETERS ARE NEVER STORED. A third-party validator's parameters can carry a
// whole script, and scripts carry credentials -- this site already has live secrets sitting
// in automation rules. What leaves this module is the structured references (field ids,
// group ids, role ids, permission keys, status ids) and a short summary built only from
// parameter keys known to be safe.

import { findSecrets } from "./secret-detect.js";

export const RULE_KINDS = ["condition", "validator", "post-function", "trigger"];

// Parameter keys whose values are field ids, possibly comma-separated. Anything else is only
// searched for a literal customfield_NNNNN, which is what catches a field named inside a
// Jira expression or a third-party script.
const FIELD_KEYS = new Set([
  "fieldkey",
  "fieldid",
  "field",
  "fields",
  "fieldsrequired",
  "fieldslist",
  "fieldids",
  "sourcefieldkey",
  "targetfieldkey",
  "sourcefield",
  "targetfield",
  "date1",
  "date2",
  "fieldname",
  "requiredfields",
  "approvalfield",
]);
const GROUP_KEYS = new Set([
  "groupids",
  "groupid",
  "group",
  "groups",
  "groupsexemptfromvalidation",
  "groupname",
  "groupnames",
]);
const ROLE_KEYS = new Set(["roleids", "roleid", "projectroleid", "projectroleids", "roles", "role"]);
const PERMISSION_KEYS = new Set(["permissionkeys", "permissionkey", "permission", "permissions"]);
const STATUS_KEYS = new Set(["previousstatusids", "previousstatusid", "statusids", "statusid", "statuses"]);

// Parameter keys safe to echo into a summary: they describe the rule's shape, never carry
// free text an admin typed. errorMessage, expression, script and value are deliberately absent.
const SUMMARY_KEYS = [
  "ruleType",
  "comparator",
  "operation",
  "mode",
  "mostRecentStatusOnly",
  "ignoreContext",
  "permissionKeys",
];

const CUSTOM_FIELD_RE = /customfield_\d+/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Human labels for the rule keys Jira itself ships. Anything else (a Connect or Forge app's
// rule, ScriptRunner's) shows its key, which names the app -- better than a guess.
const RULE_LABELS = {
  "system:validate-field-value": "Field value check",
  "system:check-field-value": "Field value condition",
  "system:field-required-validator": "Field required",
  "system:restrict-issue-transition": "Restrict who can transition",
  "system:previous-status-validator": "Previous status",
  "system:parent-or-child-blocking-validator": "Parent or child status",
  "system:parent-or-child-blocking-condition": "Parent or child status",
  "system:permission-validator": "Permission check",
  "system:proform-forms-attached-validator": "Forms attached",
  "system:proform-forms-submitted-validator": "Forms submitted",
  "system:block-transition-until-approval": "Wait for approval",
  "system:separation-of-duties": "Separation of duties",
  "system:update-field": "Update field",
  "system:copy-value-from-other-field": "Copy field value",
  "system:change-assignee": "Change assignee",
  "system:create-comment": "Add comment",
  "system:trigger-webhook": "Trigger webhook",
  "system:assign-to-current-user": "Assign to current user",
  "system:assign-to-reporter": "Assign to reporter",
  "system:assign-to-lead": "Assign to project lead",
  "system:clear-field": "Clear field",
  "system:jira-expression-validator": "Jira expression",
  "system:jira-expression-condition": "Jira expression",
  // Legacy (deprecated endpoint) type names.
  FieldRequiredValidator: "Field required",
  PermissionValidator: "Permission check",
  PreviousStatusValidator: "Previous status",
  DateFieldValidator: "Date comparison",
  RegexpFieldValidator: "Regular expression",
  UserInGroupCondition: "User in group",
  InGroupCondition: "User in group",
  InProjectRoleCondition: "User in project role",
  PermissionCondition: "Permission check",
  OnlyAssigneeCondition: "Only assignee",
  OnlyReporterCondition: "Only reporter",
  SubTaskBlockingCondition: "Sub-task blocking",
  UpdateIssueFieldFunction: "Update field",
  CopyValueFromOtherFieldPostFunction: "Copy field value",
  AssignToCurrentUserFunction: "Assign to current user",
  AssignToReporterFunction: "Assign to reporter",
  AssignToLeadFunction: "Assign to project lead",
  ClearFieldValuePostFunction: "Clear field",
};

export function ruleLabel(ruleKey) {
  if (!ruleKey) return "Unnamed rule";
  return RULE_LABELS[ruleKey] || ruleKey;
}

// Jira's own housekeeping post-functions run on every transition and say nothing about what
// a workflow enforces. Listing them would bury the twelve rules an admin cares about under
// three hundred copies of "reindex the issue".
const HOUSEKEEPING_RULES = new Set([
  "system:update-issue-status",
  "system:create-change-history",
  "system:reindex-issue",
  "system:fire-issue-event",
  "system:create-issue",
  "system:add-comment-from-transition",
  "UpdateIssueStatusFunction",
  "CreateCommentFunction",
  "GenerateChangeHistoryFunction",
  "IssueReindexFunction",
  "FireIssueEventFunction",
  "IssueCreateFunction",
]);

export function isHousekeepingRule(ruleKey) {
  return HOUSEKEEPING_RULES.has(String(ruleKey || ""));
}

function splitTokens(value) {
  return String(value)
    .split(/[,;\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function addRef(refs, type, id) {
  const value = String(id ?? "").trim();
  if (!value || value.length > 191) return;
  const key = `${type}\u0000${value}`;
  if (!refs.seen.has(key)) {
    refs.seen.add(key);
    refs.list.push({ refType: type, refId: value });
  }
}

// Everything a rule's parameters point at, as { refType, refId } pairs.
//
// Shape-agnostic on purpose. The current endpoint gives flat string maps ("fieldsRequired":
// "customfield_1,customfield_2"); the deprecated one nests ({ fields: [{ id }] }); apps put
// whatever they like. Keys are compared case-insensitively and the parent key carries into
// nested objects, so { fields: [{ id: "x" }] } still reads as a field reference.
export function extractReferences(parameters) {
  const refs = { seen: new Set(), list: [] };
  walk(parameters, "", refs, 0);
  return refs.list;
}

function walk(value, parentKey, refs, depth) {
  if (depth > 12 || value == null) return;
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, parentKey, refs, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      // { id } / { name } / { value } inside a typed parent belongs to that parent.
      const effective = ["id", "name", "value", "key"].includes(key.toLowerCase()) && parentKey ? parentKey : key;
      walk(child, effective, refs, depth + 1);
    }
    return;
  }
  if (typeof value !== "string" && typeof value !== "number") return;

  const text = String(value);
  const key = String(parentKey || "").toLowerCase();

  // A literal custom field id anywhere is a field reference, whatever key it sits under --
  // that is the only way a field named inside an expression or a script is ever seen.
  for (const match of text.match(CUSTOM_FIELD_RE) || []) addRef(refs, "field", match);

  // Only a plain id list is tokenised. Anything with operators or quotes is an expression,
  // where the custom-field scan above is the only trustworthy read.
  if (FIELD_KEYS.has(key) && /^[\w.,;\s-]+$/.test(text)) {
    for (const token of splitTokens(text)) {
      // A system field id is a bare word ("duedate", "resolution"). Expressions and
      // free text are not ids, so anything with punctuation beyond _ and . is dropped.
      if (/^[A-Za-z][\w.]*$/.test(token)) addRef(refs, "field", token);
    }
  } else if (GROUP_KEYS.has(key)) {
    // Commas only: a group NAME may contain spaces, and an id never does.
    for (const token of text
      .split(/[,;]+/)
      .map((t) => t.trim())
      .filter(Boolean)) {
      addRef(refs, UUID_RE.test(token) ? "group" : "group-name", token);
    }
  } else if (ROLE_KEYS.has(key)) {
    for (const token of splitTokens(text)) if (/^\d+$/.test(token)) addRef(refs, "role", token);
  } else if (PERMISSION_KEYS.has(key)) {
    for (const token of splitTokens(text)) if (/^[A-Z_]+$/.test(token)) addRef(refs, "permission", token);
  } else if (STATUS_KEYS.has(key)) {
    for (const token of splitTokens(text)) if (/^\d+$/.test(token)) addRef(refs, "status", token);
  }
}

// A one-line description of a rule from its safe keys only, e.g. "fieldRequired" or
// "permissionKeys: BROWSE_PROJECTS". Never echoes free text.
export function summarizeRule(parameters) {
  if (!parameters || typeof parameters !== "object") return null;
  const parts = [];
  for (const key of SUMMARY_KEYS) {
    const value = parameters[key];
    if (value == null || value === "") continue;
    const text = String(value);
    if (text.length > 120) continue;
    parts.push(key === "ruleType" ? text : `${key}: ${text}`);
  }
  return parts.length ? parts.join(" · ").slice(0, 500) : null;
}

// ── Workflow properties ─────────────────────────────────────────────────────────────────
//
// jira.permission.[subtasks.]<permission>.<holder>[.<suffix>] restricts a permission while
// an issue sits in a status: only the named holders keep it. "jira.permission.edit.group =
// <groupId>" is the one that matters most -- it is how a status gets locked to one team.

const PERMISSION_HOLDERS = [
  "groupCF",
  "group",
  "assignee",
  "assignable",
  "reportercreate",
  "reporter",
  "lead",
  "projectrole",
  "userCF",
  "user",
  "applicationRole",
  "inProjectRole",
  "denied",
];
const PERMISSION_PROPERTY_RE = new RegExp(
  `^jira\\.permission\\.(subtasks\\.)?(.+?)\\.(${PERMISSION_HOLDERS.join("|")})(?:\\.(.+))?$`,
);

const HOLDER_LABELS = {
  group: "group",
  groupCF: "group in field",
  assignee: "assignee",
  assignable: "assignable users",
  reporter: "reporter",
  reportercreate: "reporter (with create)",
  lead: "project lead",
  projectrole: "project role",
  user: "user",
  userCF: "user in field",
  applicationRole: "application role",
  inProjectRole: "project role member",
  denied: "nobody",
};

// Parse one property into what it means. Returns null for a property that restricts nothing
// (layout hints, i18n keys, opsbar ordering).
export function parseWorkflowProperty(key, value) {
  const k = String(key || "");
  const v = value == null ? "" : String(value).trim();

  if (k === "jira.issue.editable") {
    return v.toLowerCase() === "false"
      ? {
          effect: "not-editable",
          permission: "edit",
          holderType: null,
          holder: null,
          description: "Issues cannot be edited in this status",
        }
      : null;
  }

  const match = PERMISSION_PROPERTY_RE.exec(k);
  if (match) {
    const [, subtasks, permission, holderType] = match;
    const holderLabel = HOLDER_LABELS[holderType] || holderType;
    const scope = subtasks ? " (sub-tasks)" : "";
    const description =
      holderType === "denied"
        ? `${capitalize(permission)}${scope}: nobody`
        : `${capitalize(permission)}${scope}: only ${holderLabel}${v ? ` ${v}` : ""}`;
    return {
      effect: "restrict-permission",
      permission,
      subtasks: Boolean(subtasks),
      holderType,
      holder: v || null,
      description,
    };
  }

  // JSM approval configuration names the approver field directly.
  if (k === "approval.field.id" && v) {
    return {
      effect: "approval",
      permission: null,
      holderType: "field",
      holder: v,
      description: `Approval uses field ${v}`,
    };
  }

  return null;
}

function capitalize(text) {
  const s = String(text || "");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// What a parsed property points at, as refs.
export function propertyReferences(parsed) {
  if (!parsed?.holder) return [];
  const refs = { seen: new Set(), list: [] };
  const holder = parsed.holder;
  switch (parsed.holderType) {
    case "group":
      addRef(refs, UUID_RE.test(holder) ? "group" : "group-name", holder);
      break;
    case "groupCF":
    case "userCF":
    case "field":
      addRef(refs, "field", holder);
      break;
    case "projectrole":
    case "inProjectRole":
      if (/^\d+$/.test(holder)) addRef(refs, "role", holder);
      break;
    case "user":
      addRef(refs, "user", holder);
      break;
    default:
      break;
  }
  return refs.list;
}

function normalizeProperties(properties) {
  if (!properties) return [];
  if (Array.isArray(properties)) {
    return properties.map((entry) => [entry?.key, entry?.value]).filter(([key]) => key);
  }
  if (typeof properties === "object") return Object.entries(properties);
  return [];
}

// A property value that looks like a credential is stored as a marker, never as itself.
function safePropertyValue(key, value) {
  const text = value == null ? "" : String(value);
  if (findSecrets(text, key).length > 0) return "[redacted]";
  return text.slice(0, 1000);
}

// ── Transitions ─────────────────────────────────────────────────────────────────────────

function flattenConditions(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const entry of node) flattenConditions(entry, out);
    return out;
  }
  // Current shape: { operation, conditions: [rule], conditionGroups: [node] }.
  if (Array.isArray(node.conditions) || Array.isArray(node.conditionGroups)) {
    flattenConditions(node.conditions || [], out);
    flattenConditions(node.conditionGroups || [], out);
    return out;
  }
  // Legacy shape: { nodeType: "compound", conditions: [...] } handled above;
  // { nodeType: "simple", type, configuration } is a leaf.
  if (node.ruleKey || node.type) out.push(node);
  return out;
}

function ruleOf(kind, raw) {
  const ruleKey = raw?.ruleKey || raw?.type || null;
  const parameters = raw?.parameters ?? raw?.configuration ?? null;
  return {
    kind,
    ruleKey,
    label: ruleLabel(ruleKey),
    summary: summarizeRule(parameters),
    refs: extractReferences(parameters),
  };
}

function resolveStatus(reference, idByReference) {
  if (reference == null || reference === "") return null;
  const value = typeof reference === "object" ? (reference.statusReference ?? reference.id ?? null) : reference;
  if (value == null) return null;
  return idByReference.get(String(value)) ?? String(value);
}

// Every transition in one workflow with its rules and properties, plus the properties set
// on each status. Handles both endpoint generations, the same way extractTransitionScreens
// does.
export function extractWorkflowRules(workflow, idByReference = new Map()) {
  const transitions = [];
  for (const transition of workflow?.transitions || []) {
    const id = transition?.id != null ? String(transition.id) : transition?.name || null;
    if (!id) continue;

    const type = String(transition?.type || "").toUpperCase() || null;

    const fromIds = [];
    for (const link of transition?.links || []) {
      const resolved = resolveStatus(link?.fromStatusReference, idByReference);
      if (resolved) fromIds.push(resolved);
    }
    for (const from of Array.isArray(transition?.from) ? transition.from : []) {
      const resolved = resolveStatus(from, idByReference);
      if (resolved) fromIds.push(resolved);
    }

    const toStatusId = resolveStatus(
      transition?.toStatusReference ?? transition?.to?.statusReference ?? transition?.to?.id ?? transition?.to ?? null,
      idByReference,
    );

    const rules = [];
    const legacy = transition?.rules || {};
    for (const raw of flattenConditions(transition?.conditions ?? legacy.conditionsTree ?? legacy.conditions ?? null)) {
      rules.push(ruleOf("condition", raw));
    }
    for (const raw of transition?.validators || legacy.validators || []) rules.push(ruleOf("validator", raw));
    for (const raw of transition?.actions || legacy.postFunctions || []) {
      const rule = ruleOf("post-function", raw);
      if (!isHousekeepingRule(rule.ruleKey)) rules.push(rule);
    }
    for (const raw of transition?.triggers || []) rules.push(ruleOf("trigger", raw));

    transitions.push({
      id,
      name: transition?.name || id,
      type,
      fromStatusIds: [...new Set(fromIds)],
      toStatusId,
      rules,
      properties: normalizeProperties(transition?.properties).map(([key, value]) => ({
        key: String(key),
        value: safePropertyValue(key, value),
      })),
    });
  }

  const statusProperties = [];
  for (const status of workflow?.statuses || []) {
    const statusId = resolveStatus(status?.statusReference ?? status?.id ?? null, idByReference);
    if (!statusId) continue;
    for (const [key, value] of normalizeProperties(status?.properties)) {
      statusProperties.push({ statusId, key: String(key), value: safePropertyValue(key, value) });
    }
  }

  return { transitions, statusProperties };
}

// ── Rows for the store ───────────────────────────────────────────────────────────────────

// Flatten a list of normalized workflows ({ name, rules: extractWorkflowRules(...) }) into
// the four row sets the store writes. Every reference row carries enough context (workflow,
// transition or status, rule) to render without a join, because the field and group lookups
// that read them are single-key reads.
export function buildWorkflowRuleRows(workflows = [], schemeCountByWorkflow = new Map()) {
  const workflowRows = [];
  const transitions = [];
  const rules = [];
  const properties = [];
  const refs = [];
  let seq = 0;

  for (const workflow of workflows) {
    const workflowName = workflow?.name;
    if (!workflowName || !workflow.rules) continue;

    workflowRows.push({
      workflowName,
      workflowId: workflow.id ?? null,
      scopeType: workflow.scopeType ?? null,
      scopeProjectId: workflow.scopeProjectId ?? null,
      statusCount: (workflow.statusIds || []).length,
      transitionCount: (workflow.rules.transitions || []).length,
      ruleCount: (workflow.rules.transitions || []).reduce((n, t) => n + t.rules.length, 0),
      schemeCount: schemeCountByWorkflow.get(workflowName) ?? 0,
    });

    for (const transition of workflow.rules.transitions || []) {
      transitions.push({
        workflowName,
        transitionId: transition.id,
        transitionName: transition.name,
        transitionType: transition.type,
        fromStatusIds: transition.fromStatusIds,
        toStatusId: transition.toStatusId,
        ruleCount: transition.rules.length,
      });

      transition.rules.forEach((rule, ruleSeq) => {
        rules.push({
          workflowName,
          transitionId: transition.id,
          ruleSeq,
          kind: rule.kind,
          ruleKey: rule.ruleKey,
          summary: rule.summary,
        });
        for (const ref of rule.refs) {
          refs.push({
            ...ref,
            seq: seq++,
            workflowName,
            source: "rule",
            ownerKind: "transition",
            ownerId: transition.id,
            ruleSeq,
            propKey: null,
          });
        }
      });

      for (const prop of transition.properties) {
        properties.push({
          workflowName,
          ownerKind: "transition",
          ownerId: transition.id,
          key: prop.key,
          value: prop.value,
        });
        for (const ref of propertyReferences(parseWorkflowProperty(prop.key, prop.value))) {
          refs.push({
            ...ref,
            seq: seq++,
            workflowName,
            source: "property",
            ownerKind: "transition",
            ownerId: transition.id,
            ruleSeq: null,
            propKey: prop.key,
          });
        }
      }
    }

    for (const prop of workflow.rules.statusProperties || []) {
      properties.push({ workflowName, ownerKind: "status", ownerId: prop.statusId, key: prop.key, value: prop.value });
      for (const ref of propertyReferences(parseWorkflowProperty(prop.key, prop.value))) {
        refs.push({
          ...ref,
          seq: seq++,
          workflowName,
          source: "property",
          ownerKind: "status",
          ownerId: prop.statusId,
          ruleSeq: null,
          propKey: prop.key,
        });
      }
    }
  }

  return { workflows: workflowRows, transitions, rules, properties, refs };
}

// ── Insight ──────────────────────────────────────────────────────────────────────────────

// References that point at nothing: a field no longer in the catalogue, a group that no
// longer exists. A validator requiring a deleted field either blocks the transition or
// silently stops checking -- both are worth an admin's attention.
//
// `knownFieldIds` / `knownGroupIds` are Sets, or null when that catalogue could not be read.
// Null means "cannot judge", never "everything is missing".
export function findBrokenReferences(refs = [], { knownFieldIds = null, knownGroupIds = null } = {}) {
  const broken = [];
  for (const ref of refs) {
    if (
      ref.refType === "field" &&
      knownFieldIds &&
      ref.refId.startsWith("customfield_") &&
      !knownFieldIds.has(ref.refId)
    ) {
      broken.push(ref);
    } else if (ref.refType === "group" && knownGroupIds && !knownGroupIds.has(ref.refId)) {
      broken.push(ref);
    }
  }
  return broken;
}

// How many project-attached workflow schemes use each workflow, by name -- the default
// workflow plus every per-issue-type override. The scheme association only ever names
// workflows, so this is the join.
export function countSchemesByWorkflow(schemes = []) {
  const counts = new Map();
  for (const scheme of schemes) {
    const names = new Set();
    if (scheme?.defaultWorkflow) names.add(scheme.defaultWorkflow);
    const mapping = scheme?.issueTypeMapping;
    if (mapping && typeof mapping === "object") {
      for (const value of Object.values(mapping)) if (typeof value === "string" && value) names.add(value);
    }
    for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

// Company-managed workflows no project-attached scheme uses. They govern nothing, and every
// one is a place a field or group reference can rot unseen.
//
// Team-managed workflows (scope PROJECT) are excluded: they belong to their project
// directly and never appear in a scheme, so "no scheme" says nothing about them.
export function findInactiveWorkflows(catalog = []) {
  return catalog
    .filter((w) => w?.name && w.scopeType !== "PROJECT" && !(Number(w.schemeCount) > 0))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Give each reference a readable label and, where the catalogue was read, say whether the
// thing it points at still exists.
//
// `fieldsById` / `groups` / `rolesById` are null when that lookup failed. A failed lookup
// leaves refMissing null -- "could not check" -- rather than true: a broken-reference
// finding built on a failed read would tell an admin to repair rules that are fine.
export function labelReferences(refs = [], { fieldsById = null, groups = null, rolesById = null } = {}) {
  return refs.map((ref) => {
    let refLabel = null;
    let refMissing = null;
    if (ref.refType === "field") {
      if (fieldsById) {
        const field = fieldsById.get(ref.refId);
        refLabel = field?.name || null;
        // Only a custom field id can be judged missing; a token under a field key that is not
        // a known id may be an expression fragment rather than a deleted field.
        refMissing = ref.refId.startsWith("customfield_") ? !field : field ? false : null;
      }
    } else if (ref.refType === "group") {
      if (groups) {
        if (groups.byId?.has(ref.refId)) {
          refLabel = groups.byId.get(ref.refId);
          refMissing = false;
        } else if (groups.missing?.has(ref.refId)) {
          refMissing = true;
        }
      }
    } else if (ref.refType === "group-name") {
      refLabel = ref.refId;
    } else if (ref.refType === "role") {
      if (rolesById) {
        const name = rolesById.get(ref.refId);
        refLabel = name || null;
        refMissing = !name;
      }
    }
    return { ...ref, refLabel, refMissing };
  });
}

// The workflow-rule findings in one pure pass: broken references (with where they sit) and
// inactive workflows. Shared by the Workflows tab, the Overview health input and remediation.
export function summarizeRuleInsights({ meta, names = new Map(), catalog = [], refs = [] }) {
  const broken = refs.filter((r) => r.refMissing === true);
  const brokenRefs = broken.map((r) => ({
    type: r.refType,
    id: r.refId,
    workflowName: r.workflowName,
    source: r.source,
    transitionId: r.ownerKind === "transition" ? r.ownerId : null,
    status:
      r.ownerKind === "status"
        ? r.ownerId != null
          ? { id: String(r.ownerId), name: names.get(String(r.ownerId)) || `Status ${r.ownerId}` }
          : null
        : null,
    propKey: r.propKey,
  }));
  const inactive = findInactiveWorkflows(catalog);
  const totalRules = catalog.reduce((n, w) => n + (Number(w.ruleCount) || 0), 0);
  // A rule with two broken references is one broken rule.
  const brokenRuleKeys = new Set(
    broken.filter((r) => r.source === "rule").map((r) => `${r.workflowName}\u0000${r.ownerId}\u0000${r.ruleSeq}`),
  );

  return {
    available: true,
    refreshedAt: meta?.refreshedAt || null,
    totals: {
      workflows: catalog.length,
      teamManaged: catalog.filter((w) => w.scopeType === "PROJECT").length,
      rules: totalRules,
      brokenRules: brokenRuleKeys.size,
      brokenProperties: broken.filter((r) => r.source === "property").length,
      inactive: inactive.length,
    },
    workflows: catalog,
    brokenRefs,
    inactive,
  };
}
