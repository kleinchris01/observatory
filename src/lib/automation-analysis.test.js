import { describe, it, expect } from "vitest";
import {
  MAX_INDEXED_ENTRIES,
  MAX_RULE_IDS_PER_REFERENCE,
  REF_KIND,
  analyzeRuleRisks,
  analyzeRules,
  buildReferenceIndex,
  buildRuleDirectory,
  hydrateRuleDirectory,
  countComponents,
  extractFieldReferences,
  extractOutboundHosts,
  extractProjectReferences,
  extractStatusReferences,
  findTriggerCascades,
  scopesOverlap,
  summarizeEstate,
  summarizeRule,
  walkComponents,
} from "./automation-analysis.js";

const ARI = (projectId) => `ari:cloud:jira:95d04bf4-e1b7-4b22-806f-8bc95698a196:project/${projectId}`;

function action(type, value, extra = {}) {
  return { id: `a-${Math.random().toString(36).slice(2)}`, component: "ACTION", type, value, children: [], conditions: [], ...extra };
}
function condition(type, value, extra = {}) {
  return { id: `c-${Math.random().toString(36).slice(2)}`, component: "CONDITION", type, value, children: [], conditions: [], ...extra };
}
function editAction(fieldName, { fieldType = "NAME", sourceField = null } = {}) {
  return action("jira.issue.edit", {
    operations: [
      {
        field: { type: fieldType, value: fieldName },
        type: sourceField ? "COPY" : "SET",
        value: sourceField ? { sourceField: { type: "NAME", value: sourceField }, sourceIssue: "trigger" } : "{{now}}",
      },
    ],
  });
}
function rule(overrides = {}) {
  return {
    id: 1,
    name: "Rule",
    state: "ENABLED",
    canOtherRuleTrigger: false,
    updated: Date.now(),
    trigger: { id: "t", component: "TRIGGER", type: "jira.issue.event.trigger:created", value: {}, children: [], conditions: [] },
    components: [],
    projects: [],
    ruleScope: { resources: [] },
    ...overrides,
  };
}

describe("walkComponents", () => {
  it("visits the trigger and every top-level component", () => {
    const seen = [];
    walkComponents(rule({ components: [action("a", {}), action("b", {})] }), (c) => seen.push(c.type));
    expect(seen).toEqual(["jira.issue.event.trigger:created", "a", "b"]);
  });

  it("descends into children and conditions, which is where most components live", () => {
    const nested = action("outer", {}, {
      children: [action("child", {}, { children: [action("grandchild", {})] })],
      conditions: [condition("cond", {})],
    });
    const seen = [];
    walkComponents(rule({ components: [nested] }), (c) => seen.push(c.type));
    expect(seen).toContain("grandchild");
    expect(seen).toContain("cond");
  });

  it("reports nesting depth", () => {
    const nested = action("outer", {}, { children: [action("inner", {})] });
    const depths = {};
    walkComponents(rule({ components: [nested] }), (c, depth) => { depths[c.type] = depth; });
    expect(depths.outer).toBe(0);
    expect(depths.inner).toBe(1);
  });

  it("does not loop forever on a self-referential component tree", () => {
    const loop = action("loop", {});
    loop.id = "same";
    loop.children = [loop];
    expect(() => walkComponents(rule({ components: [loop] }), () => {})).not.toThrow();
  });

  it("tolerates a rule with no trigger or components", () => {
    const seen = [];
    walkComponents({}, (c) => seen.push(c));
    expect(seen).toEqual([]);
  });
});

describe("extractFieldReferences", () => {
  it("records an edited field as a write", () => {
    const refs = extractFieldReferences(rule({ components: [editAction("Story Points")] }));
    expect(refs).toContainEqual(expect.objectContaining({ name: "Story Points", kind: REF_KIND.WRITE }));
  });

  it("records the source of a COPY as a read, so it is not reported unused", () => {
    const refs = extractFieldReferences(rule({ components: [editAction("Target", { sourceField: "Employee Start Date" })] }));
    expect(refs).toContainEqual(expect.objectContaining({ name: "Employee Start Date", kind: REF_KIND.READ }));
    expect(refs).toContainEqual(expect.objectContaining({ name: "Target", kind: REF_KIND.WRITE }));
  });

  it("records a field-changed trigger as a trigger reference", () => {
    const r = rule({
      trigger: { id: "t", component: "TRIGGER", type: "jira.issue.field.changed", value: { fields: [{ type: "fieldName", value: "Actual SEOBD" }] }, children: [], conditions: [] },
    });
    expect(extractFieldReferences(r)).toContainEqual(expect.objectContaining({ name: "Actual SEOBD", kind: REF_KIND.TRIGGER }));
  });

  it("distinguishes an id reference from a name reference rather than guessing", () => {
    const byId = extractFieldReferences(rule({ components: [editAction("customfield_23054", { fieldType: "ID" })] }));
    expect(byId[0]).toMatchObject({ id: "customfield_23054", name: null });
  });

  it("records a condition's field as a read", () => {
    const r = rule({ components: [condition("jira.issue.condition", { selectedField: { type: "NAME", value: "Request Type" }, compareValue: { value: "x" } })] });
    expect(extractFieldReferences(r)).toContainEqual(expect.objectContaining({ name: "Request Type", kind: REF_KIND.READ }));
  });

  it("picks up a field named only inside a smart value", () => {
    const r = rule({ components: [action("jira.issue.comment", { comment: "Program is {{issue.ADVEV Vehicle Program}} today" })] });
    expect(extractFieldReferences(r)).toContainEqual(expect.objectContaining({ name: "ADVEV Vehicle Program", kind: REF_KIND.READ }));
  });

  it("ignores built-in smart-value properties, which are not custom fields", () => {
    const r = rule({ components: [action("jira.issue.comment", { comment: "{{issue.key}} {{issue.summary}} {{now}} {{lookupIssues.size}}" })] });
    const names = extractFieldReferences(r).map((f) => f.name);
    expect(names).not.toContain("key");
    expect(names).not.toContain("summary");
  });

  it("collapses the same field written by several components into one reference", () => {
    const r = rule({ components: [editAction("Due Date"), editAction("Due Date")] });
    const writes = extractFieldReferences(r).filter((f) => f.name === "Due Date" && f.kind === REF_KIND.WRITE);
    expect(writes).toHaveLength(1);
    expect(writes[0].via).toEqual(["jira.issue.edit"]);
  });

  it("keeps read and write of the same field as separate references", () => {
    const r = rule({ components: [editAction("Status Note", { sourceField: "Status Note" })] });
    const kinds = extractFieldReferences(r).filter((f) => f.name === "Status Note").map((f) => f.kind).sort();
    expect(kinds).toEqual([REF_KIND.READ, REF_KIND.WRITE]);
  });

  it("finds fields written deep inside a branch", () => {
    const deep = action("branch", {}, { children: [action("inner", {}, { children: [editAction("Deep Field")] })] });
    expect(extractFieldReferences(rule({ components: [deep] }))).toContainEqual(
      expect.objectContaining({ name: "Deep Field", kind: REF_KIND.WRITE })
    );
  });

  it("returns nothing for a rule that touches no fields", () => {
    expect(extractFieldReferences(rule())).toEqual([]);
  });
});

describe("extractStatusReferences", () => {
  it("records a transition destination as a write", () => {
    const r = rule({ components: [action("jira.issue.transition", { destinationStatus: { type: "NAME", value: "Done" } })] });
    expect(extractStatusReferences(r)).toContainEqual(expect.objectContaining({ name: "Done", kind: REF_KIND.WRITE }));
  });

  it("records both ends of a transitioned trigger", () => {
    const r = rule({
      trigger: {
        id: "t", component: "TRIGGER", type: "jira.issue.event.trigger:transitioned", children: [], conditions: [],
        value: { fromStatus: [{ type: "NAME", value: "Offer Sent" }], toStatus: [{ type: "NAME", value: "Comp Negotiation" }] },
      },
    });
    const names = extractStatusReferences(r).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["Offer Sent", "Comp Negotiation"]));
  });

  it("parses a multi-value status condition encoded as a JSON array string", () => {
    const r = rule({
      components: [condition("jira.issue.condition", {
        selectedField: { type: "ID", value: "status" },
        compareValue: { multiValue: true, value: '["In Progress","Waiting for support"]' },
      })],
    });
    const names = extractStatusReferences(r).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["In Progress", "Waiting for support"]));
  });

  it("treats an unparseable multi-value as a single literal rather than dropping it", () => {
    const r = rule({
      components: [condition("jira.issue.condition", {
        selectedField: { type: "ID", value: "status" },
        compareValue: { multiValue: true, value: "[not json" },
      })],
    });
    expect(extractStatusReferences(r)).toContainEqual(expect.objectContaining({ name: "[not json" }));
  });

  it("ignores conditions on fields other than status", () => {
    const r = rule({ components: [condition("jira.issue.condition", { selectedField: { type: "ID", value: "issuetype" }, compareValue: { value: "Bug" } })] });
    expect(extractStatusReferences(r)).toEqual([]);
  });
});

describe("extractProjectReferences", () => {
  it("reads ids from the projects list", () => {
    expect(extractProjectReferences(rule({ projects: [{ projectId: "10518" }] }))).toEqual(["10518"]);
  });

  it("parses project ids out of rule scope ARIs", () => {
    expect(extractProjectReferences(rule({ ruleScope: { resources: [ARI("10015")] } }))).toEqual(["10015"]);
  });

  it("parses project ids out of trigger event filters", () => {
    const r = rule({
      trigger: { id: "t", component: "TRIGGER", type: "x", value: { eventFilters: [ARI("10061"), ARI("10027")] }, children: [], conditions: [] },
    });
    expect(extractProjectReferences(r)).toEqual(["10027", "10061"]);
  });

  it("deduplicates ids found in more than one place", () => {
    const r = rule({ projects: [{ projectId: "10015" }], ruleScope: { resources: [ARI("10015")] } });
    expect(extractProjectReferences(r)).toEqual(["10015"]);
  });

  it("returns an empty list for a site-wide rule", () => {
    expect(extractProjectReferences(rule())).toEqual([]);
  });
});

describe("countComponents", () => {
  it("counts actions and conditions separately at every depth", () => {
    const r = rule({
      components: [action("a", {}, { children: [action("b", {})], conditions: [condition("c", {})] })],
    });
    expect(countComponents(r)).toEqual({ actions: 2, conditions: 1, total: 4 });
  });
});

describe("extractOutboundHosts", () => {
  it("collects hosts from web request actions", () => {
    const r = rule({ components: [action("jira.issue.outgoing.webhook", { url: "https://graph.microsoft.com/v1.0/users" })] });
    expect(extractOutboundHosts(r)).toEqual(["graph.microsoft.com"]);
  });

  it("skips URLs built entirely from smart values, which have no knowable host", () => {
    const r = rule({ components: [action("jira.issue.outgoing.webhook", { url: "{{baseUrl}}/rest/api/3/issue" })] });
    expect(extractOutboundHosts(r)).toEqual([]);
  });
});

describe("analyzeRuleRisks", () => {
  it("flags a rule carrying a redacted credential as high severity", () => {
    const r = rule({ components: [action("jira.issue.outgoing.webhook", { customBody: "client_secret=[[REDACTED:a1b2c3d4]]" })] });
    const risks = analyzeRuleRisks(r);
    expect(risks).toContainEqual(expect.objectContaining({ code: "embedded-credential", severity: "high" }));
  });

  it("flags a rule with a trigger but no actions", () => {
    expect(analyzeRuleRisks(rule())).toContainEqual(expect.objectContaining({ code: "no-actions" }));
  });

  it("does not flag no-actions when an action is nested inside a condition block", () => {
    const r = rule({ components: [condition("jira.condition.container.block", {}, { children: [editAction("X")] })] });
    expect(analyzeRuleRisks(r).map((x) => x.code)).not.toContain("no-actions");
  });

  it("flags external HTTP but not calls back to Atlassian", () => {
    const external = rule({ components: [action("jira.issue.outgoing.webhook", { url: "https://graph.microsoft.com/x" })] });
    expect(analyzeRuleRisks(external)).toContainEqual(expect.objectContaining({ code: "external-http", hosts: ["graph.microsoft.com"] }));

    const internal = rule({ components: [action("jira.issue.outgoing.webhook", { url: "https://acme.atlassian.net/rest/api/3/issue" })] });
    expect(analyzeRuleRisks(internal).map((x) => x.code)).not.toContain("external-http");
  });

  it("reports how long a disabled rule has been sitting", () => {
    const now = Date.parse("2026-08-05T00:00:00Z");
    const r = rule({ state: "DISABLED", components: [editAction("X")], updated: now - 90 * 86400000 });
    const disabled = analyzeRuleRisks(r, { now }).find((x) => x.code === "disabled");
    expect(disabled).toMatchObject({ severity: "info", ageDays: 90 });
  });

  it("returns no risks for a healthy enabled rule", () => {
    expect(analyzeRuleRisks(rule({ components: [editAction("X")] }))).toEqual([]);
  });
});

describe("summarizeRule", () => {
  it("produces a compact row carrying the fields a table needs", () => {
    const r = rule({ id: 42, name: "Set due date", components: [editAction("Due Date")], projects: [{ projectId: "10518" }] });
    expect(summarizeRule(r)).toMatchObject({
      id: 42,
      name: "Set due date",
      enabled: true,
      actionCount: 1,
      projectIds: ["10518"],
      writesFields: ["Due Date"],
      topSeverity: null,
    });
  });

  it("reports the most severe risk present", () => {
    const r = rule({ components: [action("jira.issue.outgoing.webhook", { url: "https://x.example.com", customBody: "client_secret=[[REDACTED:aaaaaaaa]]" })] });
    expect(summarizeRule(r).topSeverity).toBe("high");
  });

  it("marks an unknown state as not enabled rather than defaulting to on", () => {
    expect(summarizeRule({ id: 1 })).toMatchObject({ state: "UNKNOWN", enabled: false });
  });
});

describe("scopesOverlap", () => {
  it("treats a site-wide rule as overlapping everything", () => {
    expect(scopesOverlap([], ["10015"])).toBe(true);
    expect(scopesOverlap(["10015"], [])).toBe(true);
  });

  it("is true when the rules share a project", () => {
    expect(scopesOverlap(["10015", "10020"], ["10020"])).toBe(true);
  });

  it("is false for rules in unrelated projects", () => {
    expect(scopesOverlap(["10015"], ["10020"])).toBe(false);
  });
});

describe("findTriggerCascades", () => {
  const writer = (id, field, projectId) => rule({
    id, name: `writer ${id}`, canOtherRuleTrigger: true,
    components: [editAction(field)],
    projects: projectId ? [{ projectId }] : [],
  });
  const listener = (id, field, projectId) => rule({
    id, name: `listener ${id}`,
    trigger: { id: `t${id}`, component: "TRIGGER", type: "jira.issue.field.changed", value: { fields: [{ type: "fieldName", value: field }] }, children: [], conditions: [] },
    components: [editAction("Something Else")],
    projects: projectId ? [{ projectId }] : [],
  });

  it("links a rule that writes a field to a rule that triggers on it", () => {
    const cascades = findTriggerCascades([writer(1, "Actual SEOBD", "10518"), listener(2, "Actual SEOBD", "10518")]);
    expect(cascades).toContainEqual(expect.objectContaining({ sourceId: 1, targetId: 2, field: "Actual SEOBD", selfTriggering: false }));
  });

  it("ignores rules in projects that cannot see each other's issues", () => {
    expect(findTriggerCascades([writer(1, "F", "10518"), listener(2, "F", "99999")])).toEqual([]);
  });

  it("ignores a writer that cannot wake other rules", () => {
    const quiet = { ...writer(1, "F", "10518"), canOtherRuleTrigger: false };
    expect(findTriggerCascades([quiet, listener(2, "F", "10518")])).toEqual([]);
  });

  it("marks a rule that triggers on a field it also writes as self-triggering", () => {
    const loop = rule({
      id: 7, name: "loop", canOtherRuleTrigger: true,
      trigger: { id: "t7", component: "TRIGGER", type: "jira.issue.field.changed", value: { fields: [{ type: "fieldName", value: "Loopy" }] }, children: [], conditions: [] },
      components: [editAction("Loopy")],
    });
    expect(findTriggerCascades([loop])).toContainEqual(expect.objectContaining({ sourceId: 7, targetId: 7, selfTriggering: true }));
  });

  it("reports one edge per rule pair and field, not one per component", () => {
    const noisy = rule({ id: 1, canOtherRuleTrigger: true, components: [editAction("F"), editAction("F")], projects: [] });
    expect(findTriggerCascades([noisy, listener(2, "F")])).toHaveLength(1);
  });

  it("returns nothing when no rule triggers on a field", () => {
    expect(findTriggerCascades([writer(1, "F"), writer(2, "G")])).toEqual([]);
  });
});

describe("buildReferenceIndex", () => {
  it("maps a field to the rules that write, read and trigger on it", () => {
    const rules = [
      rule({ id: 1, components: [editAction("Shared")] }),
      rule({ id: 2, components: [condition("jira.issue.condition", { selectedField: { type: "NAME", value: "Shared" }, compareValue: { value: "x" } })] }),
    ];
    const { fields } = buildReferenceIndex(rules);
    expect(fields.get("shared")).toMatchObject({ label: "Shared", write: [1], read: [2], trigger: [] });
  });

  it("indexes statuses alongside fields", () => {
    const rules = [rule({ id: 5, components: [action("jira.issue.transition", { destinationStatus: { type: "NAME", value: "Done" } })] })];
    expect(buildReferenceIndex(rules).statuses.get("done")).toMatchObject({ label: "Done", write: [5] });
  });

  it("matches field names case-insensitively so casing drift does not split an entry", () => {
    const rules = [rule({ id: 1, components: [editAction("Story Points")] }), rule({ id: 2, components: [editAction("story points")] })];
    const { fields } = buildReferenceIndex(rules);
    expect(fields.size).toBe(1);
    expect(fields.get("story points").write).toEqual([1, 2]);
  });

  it("handles an empty rule set", () => {
    const index = buildReferenceIndex([]);
    expect(index.fields.size).toBe(0);
    expect(index.summaries).toEqual([]);
  });
});

describe("buildRuleDirectory", () => {
  const summaries = [
    { id: 1, name: "Alpha", enabled: true, triggerType: "jira.issue.created", projectIds: ["10015", "10016"] },
    { id: 2, name: "Beta", enabled: false, triggerType: null, projectIds: [] },
  ];

  it("stores rules as tuples, which is smaller than objects over 1,477 rows", () => {
    const doc = buildRuleDirectory(summaries);
    expect(doc.rules[0]).toEqual([1, "Alpha", 1, "jira.issue.created", 2]);
    expect(doc.total).toBe(2);
  });

  it("round-trips through hydration without losing state", () => {
    const byId = hydrateRuleDirectory(buildRuleDirectory(summaries));
    expect(byId.get(1)).toEqual({ id: 1, name: "Alpha", enabled: true, triggerType: "jira.issue.created", projectCount: 2 });
    expect(byId.get(2)).toMatchObject({ enabled: false, triggerType: null });
  });

  it("hydrates an absent document to an empty map rather than throwing", () => {
    expect(hydrateRuleDirectory(undefined).size).toBe(0);
    expect(hydrateRuleDirectory({}).size).toBe(0);
  });
});

describe("analyzeRules", () => {
  const rules = [
    rule({ id: 1, components: [editAction("Shared Field")] }),
    rule({
      id: 2,
      trigger: { id: "t2", component: "TRIGGER", type: "jira.issue.field.changed", value: { fields: [{ type: "fieldName", value: "Shared Field" }] }, children: [], conditions: [] },
      components: [action("jira.issue.transition", { destinationStatus: { type: "NAME", value: "Done" } })],
    }),
  ];

  it("returns every document the tab needs from one pass", () => {
    const out = analyzeRules(rules, { source: "export.json" });
    expect(Object.keys(out).sort()).toEqual(["analysis", "directory", "fields", "statuses"]);
    expect(out.analysis).toMatchObject({ schemaVersion: 1, source: "export.json" });
  });

  it("indexes fields with their direction counts", () => {
    const { fields } = analyzeRules(rules);
    const shared = fields.entries.find((e) => e.label === "Shared Field");
    expect(shared).toMatchObject({ writeCount: 1, triggerCount: 1, readCount: 0 });
    expect(shared.write).toEqual([1]);
    expect(shared.trigger).toEqual([2]);
  });

  it("indexes statuses separately from fields", () => {
    const { statuses } = analyzeRules(rules);
    expect(statuses.kind).toBe("status");
    expect(statuses.entries.find((e) => e.label === "Done")).toMatchObject({ writeCount: 1 });
  });

  it("sorts index entries by reference count, so a cap keeps what matters", () => {
    const many = [
      rule({ id: 1, components: [editAction("Rare")] }),
      rule({ id: 2, components: [editAction("Common")] }),
      rule({ id: 3, components: [editAction("Common")] }),
    ];
    expect(analyzeRules(many).fields.entries[0].label).toBe("Common");
  });

  it("caps rule ids per direction but reports the true count", () => {
    const writers = Array.from({ length: MAX_RULE_IDS_PER_REFERENCE + 15 }, (_, i) =>
      rule({ id: i + 1, components: [editAction("Popular")] })
    );
    const entry = analyzeRules(writers).fields.entries.find((e) => e.label === "Popular");
    expect(entry.write).toHaveLength(MAX_RULE_IDS_PER_REFERENCE);
    expect(entry.writeCount).toBe(MAX_RULE_IDS_PER_REFERENCE + 15);
  });

  it("reports the total entry count alongside a capped entry list", () => {
    const { fields } = analyzeRules(rules);
    expect(fields.total).toBe(fields.entries.length);
    expect(fields.entries.length).toBeLessThanOrEqual(MAX_INDEXED_ENTRIES);
  });

  it("builds a directory covering every rule, not just those with findings", () => {
    const { directory, analysis } = analyzeRules(rules);
    expect(directory.total).toBe(2);
    // Neither of these rules has a finding, so the findings list is empty while the
    // directory still names both -- which is what makes the drill-down readable.
    expect(analysis.findings).toHaveLength(0);
  });

  it("handles an empty rule set without throwing", () => {
    const out = analyzeRules([]);
    expect(out.analysis.estate.ruleCount).toBe(0);
    expect(out.fields.entries).toEqual([]);
    expect(out.directory.rules).toEqual([]);
  });

  // summarizeRule walks the whole component tree, and the pipeline needs the summaries
  // three times over. Recomputing them made the browser do four passes over 1,477 rules,
  // so consumers accept precomputed summaries. These assert the mechanism works by feeding
  // in summaries that could not have been derived from the rules, and checking they are
  // used rather than silently recomputed.
  it("buildReferenceIndex uses precomputed summaries instead of re-deriving them", () => {
    const planted = [{
      id: 99, name: "planted", state: "ENABLED", enabled: true, triggerType: null,
      created: null, updated: null, canOtherRuleTrigger: false,
      actionCount: 0, conditionCount: 0, componentCount: 0, projectIds: [],
      fieldRefs: [{ id: null, name: "Only In Summary", kind: REF_KIND.WRITE, via: ["x"] }],
      statusRefs: [], writesFields: ["Only In Summary"], risks: [], topSeverity: null,
    }];

    const { fields } = buildReferenceIndex(rules, { summaries: planted });

    expect([...fields.keys()]).toEqual(["only in summary"]);
    expect(fields.get("only in summary").write).toEqual([99]);
  });

  it("findTriggerCascades uses precomputed summaries instead of re-deriving them", () => {
    const base = {
      state: "ENABLED", enabled: true, created: null, updated: null,
      actionCount: 0, conditionCount: 0, componentCount: 0, projectIds: [],
      statusRefs: [], risks: [], topSeverity: null,
    };
    const planted = [
      { ...base, id: 501, name: "writer", canOtherRuleTrigger: true, triggerType: null,
        fieldRefs: [{ id: null, name: "Planted", kind: REF_KIND.WRITE, via: ["x"] }], writesFields: ["Planted"] },
      { ...base, id: 502, name: "listener", canOtherRuleTrigger: false, triggerType: "jira.issue.field.changed",
        fieldRefs: [{ id: null, name: "Planted", kind: REF_KIND.TRIGGER, via: ["x"] }], writesFields: [] },
    ];

    const cascades = findTriggerCascades(rules, { summaries: planted });

    expect(cascades).toEqual([
      expect.objectContaining({ sourceId: 501, targetId: 502, field: "Planted" }),
    ]);
  });
});

describe("summarizeEstate", () => {
  const rules = [
    rule({ id: 1, components: [editAction("A")] }),
    rule({ id: 2, state: "DISABLED", components: [editAction("B")] }),
    rule({ id: 3, components: [action("jira.issue.transition", { destinationStatus: { type: "NAME", value: "Done" } })] }),
  ];

  it("counts rules by state", () => {
    expect(summarizeEstate(rules)).toMatchObject({ ruleCount: 3, enabledCount: 2, disabledCount: 1 });
  });

  it("counts distinct fields and statuses referenced", () => {
    const estate = summarizeEstate(rules);
    expect(estate.fieldsReferenced).toBe(2);
    expect(estate.statusesReferenced).toBe(1);
  });

  it("breaks rules down by trigger type, most common first", () => {
    expect(summarizeEstate(rules).triggerBreakdown[0]).toMatchObject({ type: "jira.issue.event.trigger:created", count: 3 });
  });

  it("orders risks by severity so the worst appears first", () => {
    const risky = [
      rule({ id: 9, state: "DISABLED", components: [editAction("X")] }),
      rule({ id: 10, components: [action("jira.issue.outgoing.webhook", { customBody: "client_secret=[[REDACTED:deadbeef]]", url: "https://x.example.com" })] }),
    ];
    expect(summarizeEstate(risky).risks[0].severity).toBe("high");
  });

  it("handles an empty estate without dividing by zero", () => {
    expect(summarizeEstate([])).toMatchObject({ ruleCount: 0, enabledCount: 0, fieldsReferenced: 0, cascadeCount: 0 });
  });
});
