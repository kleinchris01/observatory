// Derive governance findings from Jira Automation rules.
//
// This exists to close a hole in the rest of the app. "This field has no values and no
// screen uses it" and "this status is unreachable" are both claims made without looking at
// automation, and both are wrong if a rule writes that field or transitions into that
// status. Acting on either finding would delete something load-bearing.
//
// Everything here is a pure function over the rule JSON. Extraction is best-effort by
// construction: Automation has 36 action types and no published schema, so an unrecognized
// component contributes nothing rather than throwing. Callers must treat the output as
// "references we can prove", never as "all references" -- a reference found here is
// evidence the field is in use, but finding none is not evidence that it is not.

import { detectRuleSecretKinds } from "./secret-detect.js";
import { extractJqlIssueTypes } from "./jql-refs.js";
import { buildCascadeGraph, findCascadeLoops } from "./cascade-graph.js";
import { scoreRuleBlastRadius, summarizeBlastRadius, buildBlastDocument } from "./automation-blast.js";

// A reference's direction matters more than its existence. A rule that WRITES a field
// keeps it alive; a rule that merely READS it in a condition does not, but does break if
// the field disappears.
export const REF_KIND = {
  WRITE: "write",
  READ: "read",
  TRIGGER: "trigger",
};

// Smart values that name an issue field, e.g. {{issue.Story Points}}. Deliberately narrow:
// {{now}}, {{lookupIssues.size}} and {{webhookResponse}} are not field references, and
// treating every smart value as one would report almost every field as used and make the
// signal worthless.
const ISSUE_SMART_VALUE_RE = /\{\{\s*(?:issue|triggerIssue)\.([A-Za-z][A-Za-z0-9 _-]*?)\s*(?:\.[A-Za-z]|\}\})/g;

// Smart-value suffixes that address a property of a field rather than another field.
const SMART_VALUE_PROPERTIES = new Set([
  "key", "id", "summary", "description", "status", "assignee", "reporter", "creator",
  "created", "updated", "resolution", "resolutiondate", "duedate", "priority", "project",
  "issuetype", "parent", "labels", "components", "fixVersions", "versions", "watchers",
  "comments", "attachment", "url", "self", "epic", "sprint", "timetracking", "worklog",
  "subtasks", "issuelinks", "votes", "environment", "security", "properties",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Visit the trigger and every component, at any depth. Automation nests: a condition block
// holds children, branches hold their own component lists, and the same action type shows
// up at top level and six levels down. Anything that only reads rule.components[] sees a
// fraction of the rule.
export function walkComponents(rule, visit) {
  const seen = new Set();
  function walk(component, depth) {
    if (!isPlainObject(component)) return;
    // Components carry ids; guard against a self-referential tree rather than trusting the
    // export to be acyclic.
    if (component.id && seen.has(component.id)) return;
    if (component.id) seen.add(component.id);
    visit(component, depth);
    for (const key of ["children", "conditions"]) {
      const branch = component[key];
      if (Array.isArray(branch)) branch.forEach((child) => walk(child, depth + 1));
    }
  }
  if (rule?.trigger) walk(rule.trigger, 0);
  if (Array.isArray(rule?.components)) rule.components.forEach((c) => walk(c, 0));
}

// Field descriptors appear as { type: "NAME" | "ID" | "field" | "fieldName", value }.
// Normalized to a single shape so callers do not have to know which spelling a given
// component type happens to use.
function toFieldRef(descriptor, kind, via) {
  if (!isPlainObject(descriptor)) return null;
  const value = descriptor.value;
  if (typeof value !== "string" || value.length === 0) return null;
  const byId = descriptor.type === "ID" || descriptor.type === "field";
  return {
    // Exactly one of these is known. Resolving an id to a name needs the field catalogue,
    // which lives outside this module -- guessing here would invent field names.
    id: byId ? value : null,
    name: byId ? null : value,
    kind,
    via,
  };
}

function pushRef(list, ref) {
  if (ref) list.push(ref);
}

function collectFromOperations(component, list) {
  const operations = component?.value?.operations;
  if (!Array.isArray(operations)) return;
  for (const operation of operations) {
    pushRef(list, toFieldRef(operation?.field, REF_KIND.WRITE, component.type));
    // A COPY operation names a source field it reads from, which may differ from the
    // target. Missing this reports the source as unused.
    pushRef(list, toFieldRef(operation?.value?.sourceField, REF_KIND.READ, component.type));
  }
}

export function extractFieldReferences(rule) {
  const refs = [];

  walkComponents(rule, (component) => {
    // jira.issue.edit, jira.issue.create, jira.issue.clone and friends all use operations[].
    collectFromOperations(component, refs);

    // A field-changed trigger names the fields it watches.
    if (Array.isArray(component?.value?.fields)) {
      for (const field of component.value.fields) {
        pushRef(refs, toFieldRef(field, REF_KIND.TRIGGER, component.type));
      }
    }

    // jira.issue.condition compares one field against a value.
    pushRef(refs, toFieldRef(component?.value?.selectedField, REF_KIND.READ, component.type));

    // A variable built from a field still depends on that field.
    if (component?.value?.query?.value) {
      collectSmartValueFields(String(component.value.query.value), component.type, refs);
    }
  });

  // Smart values reach into fields from anywhere -- comment bodies, webhook payloads, email
  // templates -- so they are swept from the whole rule rather than per component type.
  collectSmartValueFields(JSON.stringify(rule ?? {}), "smart-value", refs);

  return dedupeRefs(refs);
}

function collectSmartValueFields(text, via, out) {
  ISSUE_SMART_VALUE_RE.lastIndex = 0;
  for (const match of text.matchAll(ISSUE_SMART_VALUE_RE)) {
    const name = match[1]?.trim();
    if (!name) continue;
    // {{issue.key}} addresses a built-in property, not a custom field.
    if (SMART_VALUE_PROPERTIES.has(name) || SMART_VALUE_PROPERTIES.has(name.toLowerCase())) continue;
    out.push({ id: null, name, kind: REF_KIND.READ, via });
  }
}

// Same field referenced by several components collapses to one entry per direction, so a
// rule that sets a field in four branches does not look like four dependencies.
function dedupeRefs(refs) {
  const byKey = new Map();
  for (const ref of refs) {
    const key = `${ref.id ?? ""}|${(ref.name ?? "").toLowerCase()}|${ref.kind}`;
    if (!byKey.has(key)) byKey.set(key, { ...ref, via: [ref.via] });
    else {
      const existing = byKey.get(key);
      if (!existing.via.includes(ref.via)) existing.via.push(ref.via);
    }
  }
  return [...byKey.values()];
}

export function extractStatusReferences(rule) {
  const refs = [];

  walkComponents(rule, (component) => {
    // A transition action names where it sends the issue.
    const destination = component?.value?.destinationStatus;
    if (isPlainObject(destination) && typeof destination.value === "string") {
      refs.push({ name: destination.value, kind: REF_KIND.WRITE, via: component.type });
    }

    // A transitioned trigger names both ends.
    for (const key of ["fromStatus", "toStatus"]) {
      const list = component?.value?.[key];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (isPlainObject(entry) && typeof entry.value === "string") {
          refs.push({ name: entry.value, kind: REF_KIND.TRIGGER, via: component.type });
        }
      }
    }

    // A condition on the status field. The compared value is sometimes a JSON-encoded
    // array of status names rather than a bare string.
    const selected = component?.value?.selectedField;
    if (isPlainObject(selected) && String(selected.value).toLowerCase() === "status") {
      for (const name of parseCompareValues(component?.value?.compareValue)) {
        refs.push({ name, kind: REF_KIND.READ, via: component.type });
      }
    }
  });

  const byKey = new Map();
  for (const ref of refs) {
    const key = `${ref.name.toLowerCase()}|${ref.kind}`;
    if (!byKey.has(key)) byKey.set(key, ref);
  }
  return [...byKey.values()];
}

// Jira spells the issue-type field "issuetype"; exports and older rules use the display name.
const ISSUE_TYPE_FIELD_NAMES = new Set(["issuetype", "issue type", "issue_type", "type"]);

// Issue types a rule names -- in a condition on the Issue Type field, in a create/clone
// action that sets one, in a field operation, in JQL, or in the trigger's own scope.
//
// Same shape and same reasoning as extractStatusReferences: a rule that creates issues of
// type "Incident" keeps that type load-bearing, and one that only checks `issuetype = Bug`
// in a condition breaks if the type is renamed or removed. Best-effort like the rest of this
// module -- a reference found here is proof the type is in use; finding none is not proof it
// is not.
export function extractIssueTypeReferences(rule) {
  const refs = [];

  walkComponents(rule, (component) => {
    const value = isPlainObject(component?.value) ? component.value : {};

    // A condition comparing the Issue Type field against one or more values.
    const selected = value.selectedField;
    if (isPlainObject(selected) && ISSUE_TYPE_FIELD_NAMES.has(String(selected.value).toLowerCase())) {
      for (const name of parseCompareValues(value.compareValue)) {
        refs.push({ id: null, name, kind: REF_KIND.READ, via: component.type });
      }
    }

    // jira.issue.create / jira.issue.clone name the type of issue they produce.
    const created = value.issueType ?? value.issueTypeId ?? value.targetIssueType;
    if (isPlainObject(created) && typeof created.value === "string" && created.value) {
      const byId = created.type === "ID" || created.type === "id";
      refs.push({ id: byId ? created.value : null, name: byId ? null : created.value, kind: REF_KIND.WRITE, via: component.type });
    }

    // A field operation that sets issuetype (edit actions use operations[]).
    if (Array.isArray(value.operations)) {
      for (const operation of value.operations) {
        const field = operation?.field;
        if (
          isPlainObject(field)
          && ISSUE_TYPE_FIELD_NAMES.has(String(field.value).toLowerCase())
          && isPlainObject(operation?.value)
          && typeof operation.value.value === "string"
          && operation.value.value
        ) {
          refs.push({ id: null, name: operation.value.value, kind: REF_KIND.WRITE, via: component.type });
        }
      }
    }

    // JQL in a condition or branch -- `issuetype in (...)`, `type = ...`.
    const jql = value.query?.value ?? value.jql?.value ?? (typeof value.rawJql === "string" ? value.rawJql : null);
    if (typeof jql === "string" && jql) {
      for (const name of extractJqlIssueTypes(jql)) {
        refs.push({ id: null, name, kind: REF_KIND.READ, via: component.type });
      }
    }
  });

  // The trigger's own scope: several trigger types filter to a set of issue types.
  const scope = rule?.trigger?.value?.issueTypes ?? rule?.trigger?.value?.issueType;
  const scopeList = Array.isArray(scope) ? scope : (scope ? [scope] : []);
  for (const entry of scopeList) {
    if (isPlainObject(entry) && typeof entry.value === "string" && entry.value) {
      const byId = entry.type === "ID" || entry.type === "id";
      refs.push({
        id: byId ? entry.value : null,
        name: byId ? null : entry.value,
        kind: REF_KIND.TRIGGER,
        via: rule?.trigger?.type ?? "trigger",
      });
    }
  }

  return dedupeRefs(refs);
}

function parseCompareValues(compareValue) {
  const raw = compareValue?.value;
  if (typeof raw !== "string" || raw.length === 0) return [];
  if (compareValue?.multiValue || raw.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === "string");
    } catch {
      // A malformed multi-value is treated as a single literal rather than dropped: a
      // status reference we cannot parse is still a status reference.
    }
  }
  return [raw];
}

// Fields whose value is a user. A rule that sets or conditions on one of these names a
// specific person, and that is a dependency the People pillar can report: rename or
// deactivate the account and the rule quietly stops matching or assigns to nobody.
const USER_FIELD_NAMES = new Set(["assignee", "reporter", "creator"]);
// An Atlassian accountId: 24-hex, or the newer "<realm>:<uuid>" form, or a bare uuid.
const ACCOUNT_ID_RE = /^(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9]+:[0-9a-f-]{36})$/i;

function looksLikeAccountId(value) {
  return typeof value === "string" && ACCOUNT_ID_RE.test(value.trim());
}

// The users a rule names by accountId -- in an assign action, a user-field edit, or a
// condition on assignee/reporter/creator. Deliberately narrow: {{initiator}}, "automatic"
// and copy-from-field are not references to a specific person, and a display name with no
// id is not resolvable, so both are skipped rather than guessed at.
//
// Same best-effort contract as the other extractors: a reference here is proof the person
// is load-bearing in automation; finding none is not proof they are not.
export function extractUserReferences(rule) {
  const refs = [];
  const add = (value, kind, via) => {
    if (isPlainObject(value)) value = value.accountId ?? value.value ?? value.id;
    if (looksLikeAccountId(value)) refs.push({ id: String(value).trim(), name: null, kind, via });
  };

  walkComponents(rule, (component) => {
    const value = isPlainObject(component?.value) ? component.value : {};

    // jira.issue.assign -- the assignee it sets.
    if (component.type === "jira.issue.assign" || value.assignee !== undefined) {
      add(value.assignee, REF_KIND.WRITE, component.type);
    }

    // An edit action's operations that set a user field.
    if (Array.isArray(value.operations)) {
      for (const operation of value.operations) {
        const fieldName = String(operation?.field?.value || "").toLowerCase();
        const isUserField = USER_FIELD_NAMES.has(fieldName)
          || /user|people|assignee|owner|approver/.test(fieldName);
        if (isUserField) add(operation?.value, REF_KIND.WRITE, component.type);
      }
    }

    // A condition comparing a user field against a specific account.
    const selected = value.selectedField;
    if (isPlainObject(selected) && USER_FIELD_NAMES.has(String(selected.value).toLowerCase())) {
      for (const v of parseCompareValues(value.compareValue)) add(v, REF_KIND.READ, component.type);
    }

    // jira.user.condition / "user is in role/group" blocks carry the user under a few keys.
    for (const key of ["user", "checkUser", "accountId"]) {
      if (value[key] !== undefined) add(value[key], REF_KIND.READ, component.type);
    }
  });

  return dedupeRefs(refs);
}

const PROJECT_ARI_RE = /ari:cloud:jira[^:]*:[^:]+:project\/(\d+)/g;

export function extractProjectReferences(rule) {
  const ids = new Set();

  for (const entry of rule?.projects ?? []) {
    if (entry?.projectId) ids.add(String(entry.projectId));
  }
  for (const resource of rule?.ruleScope?.resources ?? []) {
    PROJECT_ARI_RE.lastIndex = 0;
    for (const match of String(resource).matchAll(PROJECT_ARI_RE)) ids.add(match[1]);
  }
  // Event filters scope a trigger to specific projects and are the only project reference
  // on many rules whose ruleScope is the whole site.
  walkComponents(rule, (component) => {
    for (const filter of component?.value?.eventFilters ?? []) {
      PROJECT_ARI_RE.lastIndex = 0;
      for (const match of String(filter).matchAll(PROJECT_ARI_RE)) ids.add(match[1]);
    }
  });

  return [...ids].sort();
}

const ACTION_COMPONENT = "ACTION";
const ATLASSIAN_HOST_RE = /^https?:\/\/([a-z0-9-]+\.)*(atlassian\.(net|com)|atl-paas\.net)(\/|$)/i;

export function countComponents(rule) {
  let actions = 0;
  let conditions = 0;
  let total = 0;
  walkComponents(rule, (component) => {
    total += 1;
    if (component.component === ACTION_COMPONENT) actions += 1;
    if (component.component === "CONDITION") conditions += 1;
  });
  return { actions, conditions, total };
}

export function extractOutboundHosts(rule) {
  const hosts = new Set();
  walkComponents(rule, (component) => {
    const url = component?.value?.url;
    if (typeof url !== "string") return;
    // Smart values can build the whole URL, in which case there is no host to report.
    const match = url.match(/^https?:\/\/([^/\s{}"]+)/i);
    if (match) hosts.add(match[1].toLowerCase());
  });
  return [...hosts].sort();
}

// Coarse buckets for what a rule's actions actually do, matched on the component type
// string. Used by the blast-radius score and the optimisation checks -- both want "does
// this rule transition issues / call out / create issues", not the exact action list.
//
// Best-effort like every other extractor here: an unrecognised action contributes nothing.
// Matched on substrings because the type strings drift with rule age
// (jira.issue.outgoing.webhook vs codebarrel.action.webhook, and so on).
const ACTION_KIND_PATTERNS = [
  [/issue\.transition|workflow\.transition/, "transition"],
  [/issue\.(create|clone)/, "create-issue"],
  [/issue\.delete/, "delete-issue"],
  [/issue\.assign/, "assign"],
  [/issue\.comment|add.?comment/, "add-comment"],
  [/outgoing\.webhook|action\.webhook|send.?web.?request|rest\.request/, "outbound-http"],
  [/send.?email|issue\.email|\.email$/, "send-email"],
  [/issue\.edit|edit\.issue|field\.edit/, "edit-field"],
];

export function extractActionKinds(rule) {
  const kinds = new Set();
  walkComponents(rule, (component) => {
    if (component?.component !== ACTION_COMPONENT) return;
    const type = String(component?.type || "").toLowerCase();
    for (const [pattern, kind] of ACTION_KIND_PATTERNS) {
      if (pattern.test(type)) kinds.add(kind);
    }
    // A component that carries an outbound URL is an external call whatever its type spells.
    if (typeof component?.value?.url === "string" && /^https?:\/\//i.test(component.value.url)) {
      kinds.add("outbound-http");
    }
  });
  return [...kinds];
}

// Findings about a single rule, ordered most severe first by the caller. Each carries the
// evidence rather than just a verdict, because "this rule is risky" is not actionable and
// "this rule posts to hooks.slack.com with a credential in the URL" is.
export function analyzeRuleRisks(rule, { now = Date.now() } = {}) {
  const risks = [];
  const counts = countComponents(rule);

  // Detected from the rule itself, not from the redactor's output.
  //
  // This used to test the serialized rule for the `[[REDACTED:...]]` marker, which only
  // appears in a rule the snapshot script has already rewritten. The browser analyses the
  // RAW export, so the test could never fire -- and this site's 86 credential-bearing rules
  // were reported, for as long as the tab has existed, as "no credentials stored".
  const secretKinds = detectRuleSecretKinds(rule);
  if (secretKinds.length > 0) {
    risks.push({
      code: "embedded-credential",
      severity: "high",
      // The kinds, not the paths. A JSON path leads straight to the secret and this finding
      // travels into KVS, through a resolver log and into the browser; the rule id is
      // already enough to take someone to the right place in Jira.
      kinds: secretKinds,
      detail: "Rule contains a credential stored in plaintext in Jira. Anyone who can view the rule can read it.",
    });
  }

  if (counts.actions === 0) {
    risks.push({
      code: "no-actions",
      severity: "medium",
      detail: "Rule has a trigger but no actions, so it consumes execution budget without doing anything.",
    });
  }

  const externalHosts = extractOutboundHosts(rule).filter((host) => !ATLASSIAN_HOST_RE.test(`https://${host}`));
  if (externalHosts.length > 0) {
    risks.push({
      code: "external-http",
      severity: "low",
      detail: `Sends data outside Atlassian to: ${externalHosts.join(", ")}.`,
      hosts: externalHosts,
    });
  }

  if (rule?.state !== "ENABLED") {
    const updated = Number(rule?.updated) || 0;
    const ageDays = updated ? Math.floor((now - updated) / 86400000) : null;
    risks.push({
      code: "disabled",
      severity: "info",
      detail: ageDays === null
        ? "Rule is disabled."
        : `Rule is disabled and was last edited ${ageDays} days ago.`,
      ageDays,
    });
  }

  // Found from the "SOLVE: Issue - Delete Manually Attached Solution Matrix Form" incident:
  // the rule triggers on "Form attached" and unconditionally deletes the last-attached form,
  // with no condition telling apart a genuine duplicate from the form its own sibling rule
  // just attached. guardCount <= 1 means at most the coarse issue-type filter every rule in
  // this estate carries -- nothing that actually distinguishes this run from a normal one.
  const destructive = findUnconditionalDestructiveActions(rule).filter((a) => a.guardCount <= 1);
  if (destructive.length > 0) {
    risks.push({
      code: "unconditional-destructive",
      severity: "medium",
      detail: `${destructive.length === 1 ? "An action" : `${destructive.length} actions`} `
        + `(${[...new Set(destructive.map((a) => a.actionType))].join(", ")}) can delete or clear `
        + "data with no condition distinguishing why -- including a run caused by another rule's "
        + "own action.",
      actionTypes: [...new Set(destructive.map((a) => a.actionType))],
    });
  }

  // A rule that turns off its own error notification and also calls out over HTTP has no
  // way to surface a failed call to anyone. This is the shape of the "Merged to" rule before
  // it was reviewed: notifyOnError: NEVER plus an outbound webhook whose failure is then
  // invisible until someone notices the field never updated.
  if ((rule?.notifyOnError ?? "NEVER") === "NEVER" && extractActionKinds(rule).includes("outbound-http")) {
    risks.push({
      code: "silent-failure",
      severity: "low",
      detail: "Rule calls out over HTTP but notifyOnError is NEVER, so a failed call leaves no "
        + "trace anyone would see -- the rule's audit log entry is the only record.",
    });
  }

  return risks;
}

// ── Cross-rule risks beyond field-write cascades ─────────────────────────────
//
// findTriggerCascades only sees a cascade if it travels through a field value-change trigger.
// The SOLVE: Solution Matrix incident travels through a generic Jira event instead -- one
// rule's "Attach forms" action fires a "Form attached" event, and a second rule listens for
// exactly that event. Nothing about that cascade shows up as a field write, so it was
// invisible to the existing cascade graph even though canOtherRuleTrigger was true on both
// rules involved.
//
// Matched on type substrings, same policy as ACTION_KIND_PATTERNS and for the same reason:
// Automation's event/action type strings drift and are not published as a schema. Every pair
// below was taken from a real trigger/action type seen in this site's own rule exports, not
// guessed -- see automation-analysis.test.js for the source rules.
//
// Issue creation/cloning is deliberately left out. jira.issue.create fires its "created"
// event on the NEW issue, which can be a different project and issue type than the rule that
// created it -- pairing it against the creating rule's own scope would be scoping the wrong
// issue. Getting that right needs the create action's target project, which this module does
// not yet extract as a first-class reference.
const EVENT_TRIGGER_PATTERNS = [
  [/proforma\.form\.attached\.trigger/, "form-attached"],
  [/proforma\.form\.submitted\.trigger/, "form-submitted"],
  [/issue\.event\.trigger:commented|comment\.event\.trigger/, "comment-added"],
  [/issue\.event\.trigger:link_deleted/, "link-deleted"],
  [/issue\.event\.trigger:link(?!_deleted)/, "link-created"],
];

const EVENT_ACTION_PATTERNS = [
  [/proforma\.form\.add\.action/, "form-attached"],
  // Coarse: this action can move a form to several statuses, only one of which is
  // "Submitted". Treated as a signal that the event MAY fire, consistent with the rest of
  // this module's "found is proof, not-found is not disproof" contract.
  [/proforma\.form\.change\.status\.action/, "form-submitted"],
  [/issue\.delete\.link/, "link-deleted"],
  [/issue\.link$/, "link-created"],
  [/issue\.comment/, "comment-added"],
];

function matchEventKind(type, patterns) {
  const lowered = String(type || "").toLowerCase();
  for (const [pattern, kind] of patterns) {
    if (pattern.test(lowered)) return kind;
  }
  return null;
}

// Events a rule reacts to (its trigger) or can itself produce (an action). Same REF_KIND
// vocabulary as extractFieldReferences: TRIGGER is "this rule wakes on E", WRITE is "this
// rule's own action can cause E" -- the pairing findEventCascades looks for.
export function extractEventReferences(rule) {
  const refs = [];
  const triggerKind = matchEventKind(rule?.trigger?.type, EVENT_TRIGGER_PATTERNS);
  if (triggerKind) refs.push({ event: triggerKind, kind: REF_KIND.TRIGGER, via: rule.trigger.type });

  walkComponents(rule, (component) => {
    if (component?.component !== ACTION_COMPONENT) return;
    const kind = matchEventKind(component?.type, EVENT_ACTION_PATTERNS);
    if (kind) refs.push({ event: kind, kind: REF_KIND.WRITE, via: component.type });
  });

  const byKey = new Map();
  for (const ref of refs) {
    const key = `${ref.event}|${ref.kind}`;
    if (!byKey.has(key)) byKey.set(key, ref);
  }
  return [...byKey.values()];
}

// Same shape and same edge semantics as findTriggerCascades -- sourceId/targetId/selfTriggering
// -- but keyed on a generic event instead of a field name, so both can render through the
// same CascadeRow. `field` on the returned edge carries the event kind for that reason.
export function findEventCascades(rules = [], options = {}) {
  const summaries = options.summaries ?? rules.map((r) => summarizeRule(r, options));
  const byId = new Map(rules.map((r) => [r.id, r]));
  const eventRefsById = new Map(summaries.map((s) => [s.id, extractEventReferences(byId.get(s.id) ?? {})]));

  const triggersOnEvent = new Map();
  for (const summary of summaries) {
    for (const ref of eventRefsById.get(summary.id) ?? []) {
      if (ref.kind !== REF_KIND.TRIGGER) continue;
      if (!triggersOnEvent.has(ref.event)) triggersOnEvent.set(ref.event, []);
      triggersOnEvent.get(ref.event).push(summary);
    }
  }

  const cascades = [];
  const seen = new Set();
  for (const source of summaries) {
    if (!source.canOtherRuleTrigger) continue;
    for (const ref of eventRefsById.get(source.id) ?? []) {
      if (ref.kind !== REF_KIND.WRITE) continue;
      for (const target of triggersOnEvent.get(ref.event) ?? []) {
        if (!scopesOverlap(source.projectIds, target.projectIds)) continue;
        const edge = `${source.id}->${target.id}|${ref.event}`;
        if (seen.has(edge)) continue;
        seen.add(edge);
        cascades.push({
          field: ref.event,
          sourceId: source.id,
          sourceName: source.name,
          targetId: target.id,
          targetName: target.name,
          selfTriggering: target.id === source.id,
        });
      }
    }
  }
  return cascades;
}

// Action types that destroy or blank data outright, matched the same coarse way as
// ACTION_KIND_PATTERNS. A DELETE-method webhook is caught separately below since the verb,
// not the type string, is what makes it destructive -- jira.issue.outgoing.webhook is also
// how every harmless GET in this file's own examples is spelled.
const DESTRUCTIVE_ACTION_TYPE_RE = /issue\.delete$|delete\.link|delete\.attachment/;

function isDestructiveWebhook(component) {
  return String(component?.value?.method || "").toUpperCase() === "DELETE";
}

// An edit operation that blanks a field rather than setting a real value: SET to null/""/[]
// (Automation's "clear this field" shape), or an explicit REMOVE.
function isClearingOperation(operation) {
  if (operation?.type === "REMOVE") return true;
  if (operation?.type !== "SET") return false;
  const value = operation?.value;
  if (value === null || value === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function isDestructiveAction(component) {
  if (component?.component !== ACTION_COMPONENT) return false;
  if (DESTRUCTIVE_ACTION_TYPE_RE.test(String(component?.type || "").toLowerCase())) return true;
  if (isDestructiveWebhook(component)) return true;
  const operations = component?.value?.operations;
  if (Array.isArray(operations) && operations.some(isClearingOperation)) return true;
  return false;
}

// How many conditions actually stand between the trigger firing and this destructive action
// running -- not how many condition COMPONENTS the rule has, but how many narrow the specific
// branch this action sits in. Automation's legacy top-level shape (a bare CONDITION followed
// by sibling actions, all of which are skipped if it fails) and its if/else-if shape
// (CONDITION_BLOCK wrapping its own children) both gate differently, so both are walked:
//
//   - A condition with its OWN children narrows only those children (an if/else-if arm).
//   - A bare condition with no children of its own narrows every sibling AFTER it in the
//     same list instead -- that is what "stops the rest of the rule" means in this format.
//   - A BRANCH re-scopes to a different, related set of issues; whatever gated this issue
//     does not carry over to gating that one, so it resets to zero.
//
// This is the distinction the "unconditional-destructive" risk turns on: rule 3's own
// "Condition: Issue Type = Solve Ticket" is real, but it gates every rule in the estate
// equally and says nothing about why THIS run should delete a form. guardCount counts it as
// 1, not 0, and the risk threshold (guardCount <= 1) treats that as still effectively
// unguarded.
export function findUnconditionalDestructiveActions(rule) {
  const findings = [];

  function walkList(list, guardCount) {
    if (!Array.isArray(list)) return;
    let count = guardCount;
    for (const component of list) {
      if (!isPlainObject(component)) continue;

      if (component.component === "CONDITION" || component.component === "CONDITION_BLOCK") {
        walkList(component.conditions, count);
        const hasOwnChildren = Array.isArray(component.children) && component.children.length > 0;
        if (hasOwnChildren) {
          walkList(component.children, count + 1);
        } else {
          count += 1;
        }
        continue;
      }

      if (component.component === "BRANCH") {
        walkList(component.conditions, 0);
        walkList(component.children, 0);
        continue;
      }

      if (isDestructiveAction(component)) {
        findings.push({ id: component.id ?? null, actionType: component.type, guardCount: count });
      }
      walkList(component.children, count);
    }
  }

  walkList(rule?.components, 0);
  return findings;
}

// A literal value an action SETs a field to -- as opposed to COPY or a smart value, which
// derive the value at run time and cannot contradict another rule's literal the way two
// fixed values can. Reuses toFieldRef's id/name convention so a contradiction can be matched
// against extractFieldReferences without a second field-identity scheme.
function extractLiteralFieldSets(rule) {
  const sets = [];
  walkComponents(rule, (component) => {
    const operations = component?.value?.operations;
    if (!Array.isArray(operations)) return;
    for (const operation of operations) {
      if (operation?.type !== "SET") continue;
      const value = operation?.value;
      const literal = isPlainObject(value) ? value.value : value;
      if (typeof literal !== "string" || literal.length === 0) continue;
      // {{...}} is a smart value resolved at run time, not a fixed literal.
      if (literal.includes("{{")) continue;
      const ref = toFieldRef(operation?.field, REF_KIND.WRITE, component.type);
      if (ref) sets.push({ ...ref, value: literal });
    }
  });
  return sets;
}

// Pairs of ENABLED rules, in overlapping scope, that SET the same field to different literal
// values. Not a cascade -- there is no write/trigger link between them -- but the same "two
// rules can fight over the same issue" family: which one wins depends on execution order,
// same as the destructive/form-attach case, just without an event connecting them.
//
// Deliberately noisy-tolerant rather than noise-free: a field legitimately set to different
// values under different issue-type conditions in each rule would still surface here, because
// this module does not evaluate conditions, only read what a rule can set. Reported as
// low-severity evidence to check, not a verdict -- consistent with this file's contract that
// a finding here is something found, not something proven.
export function findFieldContradictions(rules = [], options = {}) {
  const summaries = options.summaries ?? rules.map((r) => summarizeRule(r, options));
  const byId = new Map(rules.map((r) => [r.id, r]));
  const setsById = new Map(summaries.map((s) => [s.id, extractLiteralFieldSets(byId.get(s.id) ?? {})]));

  const byField = new Map();
  for (const summary of summaries) {
    if (!summary.enabled) continue;
    for (const set of setsById.get(summary.id) ?? []) {
      const key = `${set.id ?? ""}|${(set.name ?? "").toLowerCase()}`;
      if (!key || key === "|") continue;
      if (!byField.has(key)) byField.set(key, []);
      byField.get(key).push({ summary, value: set.value, fieldLabel: set.id ?? set.name });
    }
  }

  const contradictions = [];
  const seen = new Set();
  for (const entries of byField.values()) {
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        if (a.summary.id === b.summary.id) continue;
        if (a.value.toLowerCase() === b.value.toLowerCase()) continue;
        if (!scopesOverlap(a.summary.projectIds, b.summary.projectIds)) continue;
        const pairKey = [a.summary.id, b.summary.id].sort().join("-") + `|${a.fieldLabel}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        contradictions.push({
          field: a.fieldLabel,
          aId: a.summary.id, aName: a.summary.name, aValue: a.value,
          bId: b.summary.id, bName: b.summary.name, bValue: b.value,
        });
      }
    }
  }
  return contradictions;
}

// Pairs of ENABLED rules that share a trigger type and an overlapping scope closely enough
// that either could run for the same event -- the "who wins" question this file cannot
// answer without Jira's own execution order, but can at least point at. Pairwise, like
// findFieldContradictions, rather than clustered: overlap is not transitive (A overlaps B and
// B overlaps C does not mean A overlaps C), so a partition would either merge unrelated rules
// or need a second pass to undo that -- an edge list has neither problem.
export function findCompetingRulePairs(rules = [], options = {}) {
  const summaries = (options.summaries ?? rules.map((r) => summarizeRule(r, options))).filter((s) => s.enabled);

  const byTrigger = new Map();
  for (const summary of summaries) {
    if (!summary.triggerType) continue;
    if (!byTrigger.has(summary.triggerType)) byTrigger.set(summary.triggerType, []);
    byTrigger.get(summary.triggerType).push(summary);
  }

  const pairs = [];
  for (const [triggerType, group] of byTrigger) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (!scopesOverlap(a.projectIds, b.projectIds)) continue;
        // Both must be able to see the same issue type, or neither restricts issue type at
        // all -- a Bug-only rule and a Story-only rule share a trigger type but can never
        // both fire on the same issue. Any kind of reference counts, not just a trigger-scope
        // filter: most rules restrict issue type with a top-level "Condition: Issue Type = X"
        // instead (a READ reference), which is the shape the SOLVE: Cherry Pick rule and most
        // rules in this estate actually use. A READ reference found deep in one branch of a
        // multi-branch rule can overstate how narrow the rule really is -- consistent with
        // findFieldContradictions, this is noisy-tolerant evidence to check, not a verdict.
        const aTypes = a.issueTypeRefs.map((r) => (r.name ?? r.id ?? "").toLowerCase()).filter(Boolean);
        const bTypes = b.issueTypeRefs.map((r) => (r.name ?? r.id ?? "").toLowerCase()).filter(Boolean);
        const typesCompatible = aTypes.length === 0 || bTypes.length === 0 || aTypes.some((t) => bTypes.includes(t));
        if (!typesCompatible) continue;
        pairs.push({ triggerType, aId: a.id, aName: a.name, bId: b.id, bName: b.name });
      }
    }
  }
  return pairs;
}

// A compact per-rule row for the tab. The full rule JSON is 6 KB on average; sending 1,477
// of them to a browser iframe is 9 MB of payload for a table that shows eight columns.
export function summarizeRule(rule, options = {}) {
  const fields = extractFieldReferences(rule);
  const statuses = extractStatusReferences(rule);
  const issueTypes = extractIssueTypeReferences(rule);
  const users = extractUserReferences(rule);
  const counts = countComponents(rule);
  const risks = analyzeRuleRisks(rule, options);

  return {
    id: rule?.id ?? null,
    name: rule?.name ?? "",
    state: rule?.state ?? "UNKNOWN",
    enabled: rule?.state === "ENABLED",
    // Who owns the rule. Automation exports spell this a few ways; the top-level
    // authorAccountId is the common one, with actor/actingUser as fallbacks. Null when the
    // export does not carry it -- the People pillar treats that as "unknown", not "nobody".
    authorAccountId: rule?.authorAccountId
      ?? rule?.actor?.value
      ?? rule?.actingUser?.accountId
      ?? rule?.state?.actor?.value
      ?? null,
    triggerType: rule?.trigger?.type ?? null,
    created: rule?.created ?? null,
    updated: rule?.updated ?? null,
    canOtherRuleTrigger: Boolean(rule?.canOtherRuleTrigger),
    actionCount: counts.actions,
    conditionCount: counts.conditions,
    componentCount: counts.total,
    // Coarse action buckets ("transition", "outbound-http", ...) for the blast-radius score.
    actionKinds: extractActionKinds(rule),
    projectIds: extractProjectReferences(rule),
    fieldRefs: fields,
    statusRefs: statuses,
    issueTypeRefs: issueTypes,
    userRefs: users,
    writesFields: fields.filter((f) => f.kind === REF_KIND.WRITE).map((f) => f.name ?? f.id),
    risks,
    // Highest severity present, so a table can sort without re-deriving it per row.
    topSeverity: ["high", "medium", "low", "info"].find((s) => risks.some((r) => r.severity === s)) ?? null,
  };
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 };

// Field name -> the rules that touch it, split by direction. This is the join that lets the
// field governance pillar stop claiming an automation-maintained field is unused.
export function buildReferenceIndex(rules = [], options = {}) {
  const fields = new Map();
  const statuses = new Map();
  const issueTypes = new Map();
  const users = new Map();
  const summaries = options.summaries ?? rules.map((rule) => summarizeRule(rule, options));

  for (const summary of summaries) {
    for (const ref of summary.fieldRefs) {
      const key = (ref.name ?? ref.id ?? "").toLowerCase();
      if (!key) continue;
      if (!fields.has(key)) fields.set(key, { label: ref.name ?? ref.id, write: [], read: [], trigger: [] });
      fields.get(key)[ref.kind].push(summary.id);
    }
    for (const ref of summary.statusRefs) {
      const key = ref.name.toLowerCase();
      if (!statuses.has(key)) statuses.set(key, { label: ref.name, write: [], read: [], trigger: [] });
      statuses.get(key)[ref.kind].push(summary.id);
    }
    for (const ref of summary.issueTypeRefs ?? []) {
      const key = (ref.name ?? ref.id ?? "").toLowerCase();
      if (!key) continue;
      if (!issueTypes.has(key)) issueTypes.set(key, { label: ref.name ?? ref.id, write: [], read: [], trigger: [] });
      issueTypes.get(key)[ref.kind].push(summary.id);
    }
    // Keyed by accountId -- a rule names a person by id, never a spelling. The label starts
    // as the id and getAutomationIndex resolves it to a display name from the roster.
    for (const ref of summary.userRefs ?? []) {
      const key = (ref.id ?? "").toLowerCase();
      if (!key) continue;
      if (!users.has(key)) users.set(key, { label: ref.id, write: [], read: [], trigger: [] });
      users.get(key)[ref.kind].push(summary.id);
    }
  }

  return { fields, statuses, issueTypes, users, summaries };
}

// Two rules can only cascade if they can act on the same issues. An empty project list
// means the rule is site-wide and therefore overlaps everything.
export function scopesOverlap(a = [], b = []) {
  if (a.length === 0 || b.length === 0) return true;
  const smaller = a.length <= b.length ? a : b;
  const larger = new Set(a.length <= b.length ? b : a);
  return smaller.some((id) => larger.has(id));
}

// Rules whose writes can wake other rules. A rule that edits a field with
// canOtherRuleTrigger set, where another rule triggers on that same field changing, is a
// cascade -- the usual cause of an automation loop burning a month's execution budget in
// an afternoon.
//
// Project scope is part of the test, not a refinement of it. Without it this reports 4,838
// edges on the reference site, the bulk of them between rules in unrelated projects that
// can never see each other's issues. A finding that cannot happen is worse than no
// finding, because someone has to rule it out by hand.
export function findTriggerCascades(rules = [], options = {}) {
  // Summarizing a rule walks its whole component tree. The full pipeline needs the same
  // summaries three times over, so callers that already have them pass them in rather than
  // paying for the walk again -- this runs in the admin's browser, not on a server.
  const summaries = options.summaries ?? rules.map((rule) => summarizeRule(rule, options));

  const triggersOnField = new Map();
  for (const summary of summaries) {
    for (const ref of summary.fieldRefs) {
      if (ref.kind !== REF_KIND.TRIGGER) continue;
      const key = (ref.name ?? ref.id ?? "").toLowerCase();
      if (!key) continue;
      if (!triggersOnField.has(key)) triggersOnField.set(key, []);
      triggersOnField.get(key).push(summary);
    }
  }

  const cascades = [];
  const seen = new Set();
  for (const source of summaries) {
    // A rule that cannot wake other rules cannot start a cascade, whatever it writes.
    if (!source.canOtherRuleTrigger) continue;
    for (const ref of source.fieldRefs) {
      if (ref.kind !== REF_KIND.WRITE) continue;
      const key = (ref.name ?? ref.id ?? "").toLowerCase();
      for (const target of triggersOnField.get(key) ?? []) {
        if (!scopesOverlap(source.projectIds, target.projectIds)) continue;
        const edge = `${source.id}->${target.id}|${key}`;
        if (seen.has(edge)) continue;
        seen.add(edge);
        cascades.push({
          field: ref.name ?? ref.id,
          sourceId: source.id,
          sourceName: source.name,
          targetId: target.id,
          targetName: target.name,
          // A rule that triggers on a field it also writes is a loop on its own, with no
          // second rule involved. Worth separating: it is both more likely and easier to fix.
          selfTriggering: target.id === source.id,
        });
      }
    }
  }
  return cascades;
}

// Cascades stay in the analysis document and stay capped; findings no longer do.
//
// Findings moved to their own key in compact form. All 675 on the reference site are
// 294 KB in the shape the UI renders and 144 KB with the presentation stripped out --
// severity labels and detail sentences are rebuilt by the client from the risk code, so
// storing them was paying for the same sentences 603 times.
export const MAX_STORED_CASCADES = 150;

// Retained because the analysis document still carries a short preview for the overview,
// and because a caller upgrading from the previous shape should not silently lose the cap.
export const MAX_PREVIEW_FINDINGS = 20;

// Lives here rather than in the store because both sides need it and neither owns it: the
// browser builds this document when importing an export file, and the backend builds it
// when fetching rules from the API. The store's job is persistence, not shape.
//
// This module imports nothing, which is what makes that possible -- pulling in @forge/kvs
// would make the whole analysis unimportable from the frontend bundle.
// Cap for the three cross-rule lists added alongside field-write cascades: event cascades,
// competing-trigger pairs, field contradictions. Smaller than MAX_STORED_CASCADES on purpose
// -- these are new and unproven at scale, and a site where any of them runs past a hundred
// has a bigger problem than this document's size, worth its own investigation rather than a
// bigger cap.
export const MAX_STORED_CROSS_RULE = 100;

export function buildAnalysisDocument({
  estate, summaries = [], cascades = [], eventCascades = [], competingPairs = [], fieldContradictions = [],
  blastSummary = null, refreshedAt = Date.now(), source = "unknown",
}) {
  // Rules with no findings are the majority and carry no information here; the estate
  // counts already say how many there are.
  const withFindings = sortByseverity(summaries.filter((summary) => summary.risks.length > 0));

  const selfTriggering = cascades.filter((c) => c.selfTriggering);
  const others = cascades.filter((c) => !c.selfTriggering);
  const eventSelfTriggering = eventCascades.filter((c) => c.selfTriggering);
  const eventOthers = eventCascades.filter((c) => !c.selfTriggering);

  return {
    schemaVersion: 1,
    refreshedAt,
    source,
    estate,
    findingsTotal: withFindings.length,
    // A short preview only. The full list lives under its own key and is fetched when the
    // Findings section is opened; carrying all 675 here would put the document past what a
    // KVS value holds and slow every first paint to pay for a section most visits skip.
    findingsPreview: withFindings.slice(0, MAX_PREVIEW_FINDINGS).map(compactFinding),
    cascadesTotal: cascades.length,
    selfTriggeringTotal: selfTriggering.length,
    // Self-triggering loops are both the most likely to be real and the cheapest to fix,
    // so they survive truncation ahead of cross-rule edges.
    cascades: [...selfTriggering, ...others].slice(0, MAX_STORED_CASCADES),
    // Same shape as `cascades`, but keyed on a generic Jira event (form attached, comment
    // added, link created/deleted...) instead of a field write. This is what the SOLVE:
    // Solution Matrix incident travels through -- see findEventCascades.
    eventCascadesTotal: eventCascades.length,
    eventCascades: [...eventSelfTriggering, ...eventOthers].slice(0, MAX_STORED_CROSS_RULE),
    competingPairsTotal: competingPairs.length,
    competingPairs: competingPairs.slice(0, MAX_STORED_CROSS_RULE),
    fieldContradictionsTotal: fieldContradictions.length,
    fieldContradictions: fieldContradictions.slice(0, MAX_STORED_CROSS_RULE),
    // The blast-radius tier histogram and its two health inputs. Small (a handful of
    // numbers plus 20 rule ids), so it rides in the first-paint document; the per-rule
    // scores live in SQL under their own part.
    blast: blastSummary,
  };
}

function sortByseverity(summaries) {
  return [...summaries].sort(
    (a, b) => (SEVERITY_ORDER[a.topSeverity] ?? 99) - (SEVERITY_ORDER[b.topSeverity] ?? 99)
  );
}

// Single-letter keys, and no detail sentences.
//
// Over 675 rows the repeated JSON key names cost more than the values, and the detail
// strings are presentation: the client already maps a risk code to a label, so it can build
// the sentence too. Only the parameters that vary between rules are kept -- the host list
// for an outbound call, the age of a disabled rule.
export function compactFinding(summary) {
  return {
    id: summary.id,
    n: summary.name,
    e: summary.enabled ? 1 : 0,
    t: summary.triggerType ?? null,
    u: summary.updated ?? null,
    p: (summary.projectIds ?? []).length,
    w: (summary.writesFields ?? []).slice(0, 6),
    s: summary.topSeverity,
    r: (summary.risks ?? []).map((risk) => {
      const out = { c: risk.code, s: risk.severity };
      if (risk.hosts) out.h = risk.hosts;
      if (risk.ageDays !== null && risk.ageDays !== undefined) out.d = risk.ageDays;
      return out;
    }),
  };
}

export function expandFinding(row) {
  return {
    id: row.id,
    name: row.n,
    enabled: row.e === 1,
    triggerType: row.t,
    updated: row.u,
    projectCount: row.p,
    writesFields: row.w ?? [],
    topSeverity: row.s,
    risks: (row.r ?? []).map((risk) => ({ code: risk.c, severity: risk.s, hosts: risk.h, ageDays: risk.d })),
  };
}

// Every rule carrying a finding, in storage form. Sorted most severe first so a reader
// paging through meets the worst of it before the 603 disabled rules.
export function buildFindingsDocument(summaries = []) {
  const withFindings = sortByseverity(summaries.filter((summary) => summary.risks.length > 0));
  return {
    schemaVersion: 1,
    total: withFindings.length,
    findings: withFindings.map(compactFinding),
  };
}

// Per-reference caps for the field and status indexes.
//
// The full index over the reference site is 116 KB of fields and 38 KB of statuses. Stored
// alongside the 130 KB analysis document that would exceed the 240 KB a KVS value holds, so
// these live under their own keys -- and are still capped, because a site twice this size
// would otherwise reach the ceiling on its own.
//
// 50 rule ids per direction is far past what anyone reads in a drill-down, and the true
// count travels next to the list so the UI can say "showing 50 of 542".
export const MAX_RULE_IDS_PER_REFERENCE = 50;
export const MAX_INDEXED_ENTRIES = 1000;

// Turn the reference index into a storable, sorted table.
//
// Sorted by total reference count so that if the entry cap ever bites, what survives is the
// part anyone would have looked at. A field referenced by 542 rules is the one that blocks a
// deletion; a field referenced once is noise until someone searches for it specifically.
function buildIndexDocument(indexMap, kind, enabledById = new Map()) {
  const rows = [...indexMap.values()]
    .map((entry) => {
      // Counted over DISTINCT rules: a rule that both reads and writes a field is one
      // dependency, not two, and the headline chips would otherwise double-count it.
      //
      // Computed here, from the full id arrays, because the stored arrays are capped at 50
      // per direction. A field read by 542 rules would otherwise report a split derived
      // from the 50 that survived truncation.
      const distinct = new Set([...entry.write, ...entry.read, ...entry.trigger]);
      let enabledRules = 0;
      let disabledRules = 0;
      for (const id of distinct) {
        const state = enabledById.get(id);
        if (state === true) enabledRules += 1;
        else if (state === false) disabledRules += 1;
      }

      return {
        label: entry.label,
        writeCount: entry.write.length,
        readCount: entry.read.length,
        triggerCount: entry.trigger.length,
        total: entry.write.length + entry.read.length + entry.trigger.length,
        ruleCount: distinct.size,
        enabledRules,
        disabledRules,
        write: entry.write.slice(0, MAX_RULE_IDS_PER_REFERENCE),
        read: entry.read.slice(0, MAX_RULE_IDS_PER_REFERENCE),
        trigger: entry.trigger.slice(0, MAX_RULE_IDS_PER_REFERENCE),
      };
    })
    .sort((a, b) => b.total - a.total || String(a.label).localeCompare(String(b.label)));

  return {
    schemaVersion: 1,
    kind,
    total: rows.length,
    entries: rows.slice(0, MAX_INDEXED_ENTRIES),
  };
}

// A compact id -> name lookup for every rule on the site.
//
// The findings list carries names, but only for the 200 rules that have findings. Drilling
// from a field into the rules that write it reaches any of the 1,477, and showing bare
// numeric ids there would make the drill-down useless.
export function buildRuleDirectory(summaries = []) {
  return {
    schemaVersion: 1,
    total: summaries.length,
    // Array of tuples rather than objects: over 1,477 rules the repeated key names cost more
    // than the data. Rehydrated by the UI on load. Position 6 is the author accountId, added
    // for the People pillar -- older documents are 5-tuples and rehydrate with author null.
    rules: summaries.map((s) => [s.id, s.name, s.enabled ? 1 : 0, s.triggerType ?? "", s.projectIds.length, s.authorAccountId ?? ""]),
    // The project ids themselves, which used to be computed on every import and then thrown
    // away -- only their count survived, as the fifth tuple position. That discard is the
    // whole reason the Projects tab could not say a word about automation.
    //
    // Rules scoped to the whole site are omitted rather than listed against every project:
    // site-wide is a different fact from "scoped to all 200 of them", and materialising it
    // per project would both lie about that and dwarf the document.
    projects: summaries
      .filter((s) => (s.projectIds ?? []).length > 0)
      .map((s) => [s.id, ...s.projectIds]),
  };
}

// Every cascade edge, for the relational store.
//
// Separate from the analysis document's `cascades`, which stays capped at
// MAX_STORED_CASCADES because it has to fit in a KVS value. This one has no cap: it is
// shredded straight into rows, and the cap is exactly what made the multi-hop question
// unanswerable -- a chain A -> B -> C -> D is found by walking the edge set, and a walk over
// a set truncated at 150 finds chains that stop where the truncation did.
//
// Tuples rather than objects, like the rule directory and for the same reason: over 1,457
// edges the repeated key names cost more than the values. Positions are
// [sourceId, targetId, field, selfTriggering].
export function buildCascadeDocument(cascades = []) {
  return {
    schemaVersion: 1,
    total: cascades.length,
    edges: cascades.map((c) => [String(c.sourceId), String(c.targetId), c.field ?? "", c.selfTriggering ? 1 : 0]),
  };
}

export function hydrateRuleDirectory(document) {
  const byId = new Map();
  for (const [id, name, enabled, triggerType, projectCount, authorAccountId] of document?.rules ?? []) {
    byId.set(id, {
      id, name, enabled: enabled === 1, triggerType: triggerType || null, projectCount,
      authorAccountId: authorAccountId || null,
    });
  }
  return byId;
}

// Blast-radius score for every rule, most-hazardous-first not applied here (the caller
// sorts). Builds the cascade graph once to get each rule's out-degree and whether it sits
// in a loop -- both feed the fan-out factor. `context` carries the optional site-scale
// inputs (project count, per-project issue volume) that turn the reach factor from an
// estimate into a measurement.
export function computeBlastEntries(summaries = [], cascades = [], context = {}) {
  const graph = buildCascadeGraph(cascades);
  const loopMembers = new Set(findCascadeLoops(graph).flatMap((l) => l.ruleIds.map(String)));

  const outDegree = new Map();
  for (const [from, list] of graph.edges) {
    outDegree.set(String(from), new Set(list.map((e) => String(e.to))).size);
  }

  return summaries.map((summary) =>
    scoreRuleBlastRadius(summary, {
      projectCountTotal: context.projectCountTotal ?? 0,
      projectIssueCounts: context.projectIssueCounts ?? null,
      siteIssueTotal: context.siteIssueTotal ?? 0,
      outDegree: outDegree.get(String(summary.id)) ?? 0,
      inLoop: loopMembers.has(String(summary.id)),
    })
  );
}

// One call that turns raw rules into every document the tab reads. Wrapping the steps keeps
// the browser and the backend from drifting into two slightly different pipelines.
export function analyzeRules(rules = [], {
  source = "unknown",
  now = Date.now(),
  projectCountTotal = 0,
  projectIssueCounts = null,
  siteIssueTotal = 0,
} = {}) {
  // Walked once, reused everywhere below.
  const summaries = rules.map((rule) => summarizeRule(rule, { now }));
  const options = { now, summaries };

  const { fields, statuses, issueTypes, users } = buildReferenceIndex(rules, options);
  const cascades = findTriggerCascades(rules, options);
  const eventCascades = findEventCascades(rules, options);
  const competingPairs = findCompetingRulePairs(rules, options);
  const fieldContradictions = findFieldContradictions(rules, options);
  const enabledById = new Map(summaries.map((s) => [s.id, s.enabled]));

  const blastEntries = computeBlastEntries(summaries, cascades, { projectCountTotal, projectIssueCounts, siteIssueTotal });
  const blastSummary = summarizeBlastRadius(blastEntries);

  return {
    analysis: buildAnalysisDocument({
      estate: summarizeEstate(rules, { ...options, cascades, eventCascades, competingPairs, fieldContradictions, blastSummary }),
      summaries,
      cascades,
      eventCascades,
      competingPairs,
      fieldContradictions,
      blastSummary,
      refreshedAt: now,
      source,
    }),
    fields: buildIndexDocument(fields, "field", enabledById),
    statuses: buildIndexDocument(statuses, "status", enabledById),
    issueTypes: buildIndexDocument(issueTypes, "issueType", enabledById),
    users: buildIndexDocument(users, "user", enabledById),
    directory: buildRuleDirectory(summaries),
    findings: buildFindingsDocument(summaries),
    cascades: buildCascadeDocument(cascades),
    blast: buildBlastDocument(blastEntries),
  };
}

// The inputs the site health score needs from automation, as rates over the estate rather
// than raw counts. A site with 5,000 rules and 80 carrying credentials is in better shape
// than one with 200 rules and 80, and scoring counts would rank them the other way.
export function summarizeAutomationHealth(summaries = [], cascades = [], blastSummary = null, {
  eventCascades = [], competingPairs = [], fieldContradictions = [],
} = {}) {
  const ruleCount = summaries.length;
  const hasRisk = (summary, code) => summary.risks.some((r) => r.code === code);

  return {
    available: ruleCount > 0,
    ruleCount,
    disabledCount: summaries.filter((s) => !s.enabled).length,
    credentialRuleCount: summaries.filter((s) => hasRisk(s, "embedded-credential")).length,
    externalHttpCount: summaries.filter((s) => hasRisk(s, "external-http")).length,
    noActionCount: summaries.filter((s) => hasRisk(s, "no-actions")).length,
    selfTriggeringCount: new Set(cascades.filter((c) => c.selfTriggering).map((c) => c.sourceId)).size,
    // How concentrated the estate is in rules that can move every project at once, and how
    // many of those also carry a plaintext credential -- the worst pairing in the pillar.
    estateWideCount: blastSummary?.estateWideCount ?? 0,
    estateWideShare: blastSummary?.estateWideShare ?? 0,
    estateWideCredentialCount: blastSummary?.estateWideCredentialCount ?? 0,
    // The cross-rule findings that do not travel through a field write: same event, same
    // trigger, or a contested field, found because the SOLVE: Solution Matrix incident could
    // not have been told apart from a healthy estate by the field-cascade rate alone.
    eventCascadeCount: eventCascades.length,
    unconditionalDestructiveCount: summaries.filter((s) => hasRisk(s, "unconditional-destructive")).length,
    silentFailureCount: summaries.filter((s) => hasRisk(s, "silent-failure")).length,
    competingPairCount: competingPairs.length,
    fieldContradictionCount: fieldContradictions.length,
  };
}

// Whether one person's rules dominate the enabled estate -- the "if they leave, who else
// understands this" question. Rule-count share rather than a named "bus factor" score: a
// single number invites false precision about a thing that is really "ask this person before
// changing it", which the account id and count already say without pretending at rigor.
function computeAuthorConcentration(summaries) {
  const attributed = summaries.filter((s) => s.enabled && s.authorAccountId);
  if (attributed.length === 0) return null;

  const counts = new Map();
  for (const s of attributed) counts.set(s.authorAccountId, (counts.get(s.authorAccountId) || 0) + 1);
  let topAuthorAccountId = null;
  let topAuthorRuleCount = 0;
  for (const [id, count] of counts) {
    if (count > topAuthorRuleCount) { topAuthorAccountId = id; topAuthorRuleCount = count; }
  }

  return {
    topAuthorAccountId,
    topAuthorRuleCount,
    topAuthorSharePct: Math.round((topAuthorRuleCount / attributed.length) * 100),
    knownAuthorRuleCount: attributed.length,
    distinctAuthorCount: counts.size,
  };
}

export function summarizeEstate(rules = [], options = {}) {
  const { fields, statuses, issueTypes, users, summaries } = buildReferenceIndex(rules, options);
  // Reused for both the cascade count and the health rates; deriving them twice walks every
  // rule again.
  const cascades = options.cascades ?? findTriggerCascades(rules, { ...options, summaries });
  const eventCascades = options.eventCascades ?? findEventCascades(rules, { ...options, summaries });
  const competingPairs = options.competingPairs ?? findCompetingRulePairs(rules, { ...options, summaries });
  const fieldContradictions = options.fieldContradictions ?? findFieldContradictions(rules, { ...options, summaries });
  const byTrigger = new Map();
  const risksByCode = new Map();

  for (const summary of summaries) {
    const trigger = summary.triggerType ?? "(none)";
    byTrigger.set(trigger, (byTrigger.get(trigger) || 0) + 1);
    for (const risk of summary.risks) {
      if (!risksByCode.has(risk.code)) risksByCode.set(risk.code, { code: risk.code, severity: risk.severity, count: 0 });
      risksByCode.get(risk.code).count += 1;
    }
  }

  return {
    ruleCount: summaries.length,
    enabledCount: summaries.filter((s) => s.enabled).length,
    disabledCount: summaries.filter((s) => !s.enabled).length,
    fieldsReferenced: fields.size,
    statusesReferenced: statuses.size,
    issueTypesReferenced: issueTypes.size,
    usersReferenced: users.size,
    triggerBreakdown: [...byTrigger.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    risks: [...risksByCode.values()].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
    cascadeCount: cascades.length,
    eventCascadeCount: eventCascades.length,
    competingPairCount: competingPairs.length,
    fieldContradictionCount: fieldContradictions.length,
    blast: options.blastSummary ?? null,
    // How concentrated the enabled estate is in one author's rules. Null, not zero, when no
    // rule in the estate carries an attributable author -- "we don't know" and "no one person
    // dominates" are different facts and a zero-share would report the first as the second.
    authorConcentration: computeAuthorConcentration(summaries),
    // Rates for the site health score. Computed here rather than in the score itself so the
    // score never needs the rules, only this summary.
    health: summarizeAutomationHealth(summaries, cascades, options.blastSummary ?? null, {
      eventCascades, competingPairs, fieldContradictions,
    }),
  };
}

// ── Is the answer trustworthy? ───────────────────────────────────────────────
//
// Everything above answers "what do the rules reference". This answers the question that
// has to be settled before any of it is quoted back to somebody: is this analysis good
// enough to make a claim from.
//
// Two things can make it not good enough, and they fail in opposite directions:
//
//   TRUNCATION. buildReferenceIndex keeps the top MAX_INDEXED_ENTRIES rows sorted by
//   reference count descending. The comment on that cap argues -- correctly, for the
//   drill-down it was written for -- that what survives is the part anyone would have
//   looked at. For the "is this safe to delete" question it is exactly backwards: the rows
//   dropped are the LEAST-referenced ones, and a field nobody references much is precisely
//   the field somebody asks about deleting. So on a truncated index, absence is not
//   evidence of anything; it is the most likely place for the index to be wrong.
//
//   STALENESS. The analysis is fed by a hand-uploaded rule export, so it does not refresh
//   itself the way every scanned pillar does. A rule written last Tuesday is invisible to
//   an import from the Tuesday before, and nothing about the shape of the data says so.
//
// Unknown age counts as stale, deliberately. "We cannot tell how old this is" is not a
// reason to treat it as current -- the same fail-closed rule callerHasJiraAdmin follows.

export const DEFAULT_ANALYSIS_STALE_AFTER_DAYS = 7;

// Whole days since the analysis was built, or null when that cannot be determined.
//
// Takes an epoch number OR an ISO string, because both are in the wild: the analysis
// document is stamped with Date.now() (a number) while every snapshot meta row in the app
// uses toISOString(). Accepting only one of them would have made this gate permanently
// wrong in exactly one direction -- every real analysis undateable, so every answer
// "unknown" -- which is the failure a staleness check is least likely to be noticed for.
export function analysisAgeDays(refreshedAt, now = Date.now()) {
  if (refreshedAt === null || refreshedAt === undefined) return null;
  const at = typeof refreshedAt === "number" ? refreshedAt : Date.parse(refreshedAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((now - at) / 86400000));
}

// True only when the stored index holds every row that was built. `total` is the row count
// before the cap was applied, so total > entries.length means rows were dropped.
export function isIndexComplete(index) {
  const total = Number(index?.total);
  if (!Number.isFinite(total)) return false; // no total recorded -> cannot claim complete
  return total <= (index?.entries ?? []).length;
}

// One assessment, shared by every surface that reports an automation verdict, so the agent,
// the tab and the field panel cannot disagree about whether an answer can be trusted.
//
// `indexRequired` distinguishes the two reasons an index can be absent. A per-entity
// lookup that could not load its index is un-answerable and must say so (the default). A
// rule-directory search consults no index at all, so only the age applies to it -- passing
// indexRequired: false says "no index was needed here", not "the index came back empty",
// which are opposite facts and would otherwise both arrive as null.
export function assessAutomationEvidence({
  index = null,
  indexRequired = true,
  refreshedAt = null,
  staleAfterDays = DEFAULT_ANALYSIS_STALE_AFTER_DAYS,
  now = Date.now(),
} = {}) {
  // A bad threshold falls back to the default rather than being clamped to 1. Clamping a
  // negative to one day would mark every analysis stale forever, which silences the pillar
  // instead of tuning it -- the same "a bad config value costs one tuned dimension, not the
  // whole score" rule resolveHealthTolerances follows.
  const parsed = Number(staleAfterDays);
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ANALYSIS_STALE_AFTER_DAYS;
  const ageDays = analysisAgeDays(refreshedAt, now);
  const stale = ageDays === null || ageDays >= days;
  const indexComplete = indexRequired ? isIndexComplete(index) : null;
  const entries = (index?.entries ?? []).length;
  const total = Number.isFinite(Number(index?.total)) ? Number(index.total) : null;

  const blockers = [];
  if (stale) {
    blockers.push({
      code: "analysis-stale",
      message: ageDays === null
        ? "The automation analysis carries no build date, so its age cannot be established. Re-import the rule export from the Automation tab."
        : `The automation analysis is ${ageDays} day${ageDays === 1 ? "" : "s"} old (the threshold is ${days}). Rules added or changed since then are not in it. Re-import the rule export from the Automation tab.`,
    });
  }
  if (indexRequired && !indexComplete) {
    blockers.push({
      code: "index-truncated",
      message: total === null
        ? "The reference index does not record how many entries it was built from, so it cannot be confirmed complete."
        : `The reference index was truncated to ${entries} of ${total} entries, and the entries dropped are the least-referenced ones — which is the population this question is asked about.`,
    });
  }

  return {
    refreshedAt: refreshedAt ?? null,
    ageDays,
    staleAfterDays: days,
    stale,
    indexComplete,
    indexedEntries: entries,
    indexTotal: total,
    // The whole point of this module. Absence from the index means "no rule references
    // this" only when the index is both complete and current; otherwise it means nothing.
    absenceIsEvidence: (indexRequired ? indexComplete === true : true) && !stale,
    blockers,
  };
}
