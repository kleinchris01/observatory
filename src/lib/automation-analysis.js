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

  return risks;
}

// A compact per-rule row for the tab. The full rule JSON is 6 KB on average; sending 1,477
// of them to a browser iframe is 9 MB of payload for a table that shows eight columns.
export function summarizeRule(rule, options = {}) {
  const fields = extractFieldReferences(rule);
  const statuses = extractStatusReferences(rule);
  const issueTypes = extractIssueTypeReferences(rule);
  const counts = countComponents(rule);
  const risks = analyzeRuleRisks(rule, options);

  return {
    id: rule?.id ?? null,
    name: rule?.name ?? "",
    state: rule?.state ?? "UNKNOWN",
    enabled: rule?.state === "ENABLED",
    triggerType: rule?.trigger?.type ?? null,
    created: rule?.created ?? null,
    updated: rule?.updated ?? null,
    canOtherRuleTrigger: Boolean(rule?.canOtherRuleTrigger),
    actionCount: counts.actions,
    conditionCount: counts.conditions,
    componentCount: counts.total,
    projectIds: extractProjectReferences(rule),
    fieldRefs: fields,
    statusRefs: statuses,
    issueTypeRefs: issueTypes,
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
  }

  return { fields, statuses, issueTypes, summaries };
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
export function buildAnalysisDocument({ estate, summaries = [], cascades = [], refreshedAt = Date.now(), source = "unknown" }) {
  // Rules with no findings are the majority and carry no information here; the estate
  // counts already say how many there are.
  const withFindings = sortByseverity(summaries.filter((summary) => summary.risks.length > 0));

  const selfTriggering = cascades.filter((c) => c.selfTriggering);
  const others = cascades.filter((c) => !c.selfTriggering);

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
    // than the data. Rehydrated by the UI on load.
    rules: summaries.map((s) => [s.id, s.name, s.enabled ? 1 : 0, s.triggerType ?? "", s.projectIds.length]),
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
  for (const [id, name, enabled, triggerType, projectCount] of document?.rules ?? []) {
    byId.set(id, { id, name, enabled: enabled === 1, triggerType: triggerType || null, projectCount });
  }
  return byId;
}

// One call that turns raw rules into every document the tab reads. Wrapping the steps keeps
// the browser and the backend from drifting into two slightly different pipelines.
export function analyzeRules(rules = [], { source = "unknown", now = Date.now() } = {}) {
  // Walked once, reused everywhere below.
  const summaries = rules.map((rule) => summarizeRule(rule, { now }));
  const options = { now, summaries };

  const { fields, statuses, issueTypes } = buildReferenceIndex(rules, options);
  const cascades = findTriggerCascades(rules, options);
  const enabledById = new Map(summaries.map((s) => [s.id, s.enabled]));

  return {
    analysis: buildAnalysisDocument({
      estate: summarizeEstate(rules, { ...options, cascades }),
      summaries,
      cascades,
      refreshedAt: now,
      source,
    }),
    fields: buildIndexDocument(fields, "field", enabledById),
    statuses: buildIndexDocument(statuses, "status", enabledById),
    issueTypes: buildIndexDocument(issueTypes, "issueType", enabledById),
    directory: buildRuleDirectory(summaries),
    findings: buildFindingsDocument(summaries),
    cascades: buildCascadeDocument(cascades),
  };
}

// The inputs the site health score needs from automation, as rates over the estate rather
// than raw counts. A site with 5,000 rules and 80 carrying credentials is in better shape
// than one with 200 rules and 80, and scoring counts would rank them the other way.
export function summarizeAutomationHealth(summaries = [], cascades = []) {
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
  };
}

export function summarizeEstate(rules = [], options = {}) {
  const { fields, statuses, issueTypes, summaries } = buildReferenceIndex(rules, options);
  // Reused for both the cascade count and the health rates; deriving them twice walks every
  // rule again.
  const cascades = options.cascades ?? findTriggerCascades(rules, { ...options, summaries });
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
    triggerBreakdown: [...byTrigger.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    risks: [...risksByCode.values()].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
    cascadeCount: cascades.length,
    // Rates for the site health score. Computed here rather than in the score itself so the
    // score never needs the rules, only this summary.
    health: summarizeAutomationHealth(summaries, cascades),
  };
}
