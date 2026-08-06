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
const REDACTED_MARKER = /\[\[REDACTED:[0-9a-f]{8}\]\]/;
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

  if (REDACTED_MARKER.test(JSON.stringify(rule ?? {}))) {
    risks.push({
      code: "embedded-credential",
      severity: "high",
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
  const summaries = rules.map((rule) => summarizeRule(rule, options));

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
  }

  return { fields, statuses, summaries };
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
  const summaries = rules.map((rule) => summarizeRule(rule, options));

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

export function summarizeEstate(rules = [], options = {}) {
  const { fields, statuses, summaries } = buildReferenceIndex(rules, options);
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
    triggerBreakdown: [...byTrigger.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    risks: [...risksByCode.values()].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
    cascadeCount: findTriggerCascades(rules, options).length,
  };
}
