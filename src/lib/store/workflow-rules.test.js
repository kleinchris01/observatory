import { vi, describe, test, expect, beforeEach } from "vitest";

// Storage for workflow rules, properties and references, tested against a mocked Forge SQL:
// a wrong column alias, a mis-bound parameter or an unscoped DELETE hides here, and no test
// that mocks project-store wholesale can see one.

vi.mock("@forge/sql", () => {
  const runner = { enqueue: () => runner, run: vi.fn().mockResolvedValue(undefined) };
  return {
    sql: {
      prepare: vi.fn(),
      executeInTransaction: vi.fn().mockResolvedValue(undefined),
    },
    migrationRunner: runner,
  };
});

import { sql } from "@forge/sql";
import {
  replaceWorkflowSnapshot,
  loadWorkflowRefsFor,
  loadWorkflowRefsByType,
  loadStatusWorkflowProperties,
  loadWorkflowRulesPage,
  loadRefsForRules,
  loadRestrictingProperties,
  loadWorkflowsCatalog,
  readWorkflowSnapshotMeta,
  writeWorkflowSnapshotMeta,
} from "./workflow.js";

let issued = [];
let rowsFor = () => [];

beforeEach(() => {
  issued = [];
  rowsFor = () => [];
  sql.prepare.mockImplementation((statement) => {
    const entry = { statement: String(statement), params: null };
    issued.push(entry);
    const stub = {
      bindParams: (...params) => { entry.params = params; return stub; },
      execute: () => Promise.resolve({ rows: rowsFor(entry.statement), rowsAffected: 0 }),
    };
    return stub;
  });
});

const placeholders = (statement) => (statement.match(/\?/g) || []).length;

describe("replaceWorkflowSnapshot with rules", () => {
  const workflowRules = {
    workflows: [{ workflowName: "WF", workflowId: "u1", scopeType: "GLOBAL", statusCount: 3, transitionCount: 2, ruleCount: 1, schemeCount: 1 }],
    transitions: [{ workflowName: "WF", transitionId: "21", transitionName: "Approve", transitionType: "DIRECTED", fromStatusIds: ["3"], toStatusId: "4", ruleCount: 1 }],
    rules: [{ workflowName: "WF", transitionId: "21", ruleSeq: 0, kind: "validator", ruleKey: "system:validate-field-value", summary: "fieldRequired" }],
    properties: [{ workflowName: "WF", ownerKind: "status", ownerId: "3", key: "jira.permission.edit.group", value: "g1" }],
    refs: [{ seq: 0, refType: "field", refId: "customfield_1", refLabel: "Cost", refMissing: false, workflowName: "WF", source: "rule", ownerKind: "transition", ownerId: "21", ruleSeq: 0, propKey: null }],
  };

  test("binds exactly one parameter per placeholder on every insert", async () => {
    await replaceWorkflowSnapshot("site", "v1", { workflowRules });
    const inserts = issued.filter((e) => /INSERT/.test(e.statement));
    expect(inserts.map((e) => e.statement.match(/INTO (\w+)/)[1])).toEqual([
      "snapshot_workflows",
      "snapshot_workflow_transitions",
      "snapshot_workflow_rules",
      "snapshot_workflow_properties",
      "snapshot_workflow_refs",
    ]);
    for (const insert of inserts) expect(insert.params).toHaveLength(placeholders(insert.statement));
  });

  test("stores from-statuses as JSON and the missing flag as 0/1", async () => {
    await replaceWorkflowSnapshot("site", "v1", { workflowRules });
    const transition = issued.find((e) => /INTO snapshot_workflow_transitions/.test(e.statement));
    expect(transition.params).toContain('["3"]');
    const ref = issued.find((e) => /INTO snapshot_workflow_refs/.test(e.statement));
    expect(ref.params).toEqual(["site", "v1", 0, "field", "customfield_1", "Cost", 0, "WF", "rule", "transition", "21", 0, null]);
  });

  test("clears every rule table for this site only, in bounded deletes", async () => {
    await replaceWorkflowSnapshot("site", "v1", { workflowRules });
    for (const table of ["snapshot_workflows", "snapshot_workflow_refs", "snapshot_workflow_rules", "snapshot_workflow_properties", "snapshot_workflow_transitions"]) {
      const del = issued.find((e) => new RegExp(`DELETE FROM ${table}\\b`).test(e.statement));
      expect(del, table).toBeTruthy();
      expect(del.statement).toMatch(/WHERE scope_key = \?/);
      expect(del.statement).toMatch(/LIMIT \d+/);
      expect(del.params[0]).toBe("site");
    }
  });

  test("still clears the rule tables when no rules were read, and inserts none", async () => {
    await replaceWorkflowSnapshot("site", "v1", {});
    expect(issued.some((e) => /DELETE FROM snapshot_workflow_refs/.test(e.statement))).toBe(true);
    expect(issued.some((e) => /INSERT INTO snapshot_workflow/.test(e.statement))).toBe(false);
  });
});

describe("reference lookups", () => {
  test("loadWorkflowRefsFor reads by target with the transition, rule and property joined", async () => {
    rowsFor = () => [{
      ref_type: "field", ref_id: "customfield_1", ref_label: "Cost", ref_missing: 0, workflow_name: "WF",
      source: "rule", owner_kind: "transition", owner_id: "21", rule_seq: 0, prop_key: null,
      transition_name: "Approve", transition_type: "DIRECTED", from_status_ids: '["3"]', to_status_id: "4",
      rule_kind: "validator", rule_key: "system:validate-field-value", summary: "fieldRequired", prop_value: null,
    }];
    const rows = await loadWorkflowRefsFor("site", "v1", "field", ["customfield_1", "customfield_2"]);
    const read = issued.at(-1);
    expect(read.statement).toMatch(/ref_id IN \(\?, \?\)/);
    expect(read.params).toEqual(["site", "v1", "field", "customfield_1", "customfield_2"]);
    expect(rows[0]).toMatchObject({
      refId: "customfield_1", refMissing: false, fromStatusIds: ["3"], toStatusId: "4",
      ruleKind: "validator", ruleSeq: 0, transitionName: "Approve",
    });
  });

  test("an empty id list asks nothing", async () => {
    expect(await loadWorkflowRefsFor("site", "v1", "field", [])).toEqual([]);
    expect(issued.filter((e) => /snapshot_workflow_refs/.test(e.statement))).toHaveLength(0);
  });

  test("a NULL missing flag stays null -- unknown is not 'present'", async () => {
    rowsFor = () => [{ ref_type: "group", ref_id: "g", ref_missing: null, workflow_name: "WF", source: "property", owner_kind: "status", owner_id: "3", rule_seq: null }];
    const [row] = await loadWorkflowRefsByType("site", "v1", ["group"]);
    expect(row.refMissing).toBeNull();
    expect(row.ruleSeq).toBeNull();
  });

  test("loadRefsForRules keys on workflow, transition and rule", async () => {
    await loadRefsForRules("site", "v1", [{ workflowName: "WF", transitionId: "21", ruleSeq: 0 }]);
    const read = issued.at(-1);
    expect(read.statement).toMatch(/workflow_name = \? AND owner_id = \? AND rule_seq = \?/);
    expect(read.params).toEqual(["site", "v1", "WF", "21", 0]);
  });
});

describe("rules page", () => {
  test("escapes LIKE wildcards and clamps the page size", async () => {
    await loadWorkflowRulesPage("site", "v1", { query: "edit_group%", kind: "validator", limit: 9999, offset: -5 });
    const select = issued.find((e) => /SELECT ru\.workflow_name/.test(e.statement));
    expect(select.statement).toMatch(/LIMIT 200 OFFSET 0/);
    expect(select.params).toContain("validator");
    expect(select.params).toContain("%edit\\_group\\%%");
    expect(select.params).toHaveLength(placeholders(select.statement));
  });

  test("a search also matches the ids and names of what a rule points at", async () => {
    await loadWorkflowRulesPage("site", "v1", { query: "Onsite Modification" });
    const select = issued.find((e) => /SELECT ru\.workflow_name/.test(e.statement));
    expect(select.statement).toMatch(/EXISTS \([\s\S]*snapshot_workflow_refs r[\s\S]*LOWER\(r\.ref_label\) LIKE \?/);
    expect(select.params.filter((p) => p === "%onsite modification%")).toHaveLength(5);
    expect(select.params).toHaveLength(placeholders(select.statement));
  });

  test("brokenOnly narrows to rules naming something that is gone", async () => {
    await loadWorkflowRulesPage("site", "v1", { brokenOnly: true });
    const count = issued.find((e) => /COUNT\(\*\)/.test(e.statement));
    expect(count.statement).toMatch(/r\.ref_missing = 1/);
  });

  test("maps rows and the total", async () => {
    rowsFor = (statement) => (/COUNT\(\*\)/.test(statement)
      ? [{ n: 7 }]
      : [{ workflow_name: "WF", transition_id: "21", rule_seq: 1, rule_kind: "post-function", rule_key: "system:update-field", summary: null, transition_name: null, transition_type: "GLOBAL", from_status_ids: "[]", to_status_id: "1" }]);
    const page = await loadWorkflowRulesPage("site", "v1");
    expect(page.total).toBe(7);
    expect(page.rules[0]).toMatchObject({ transitionName: "21", ruleSeq: 1, fromStatusIds: [], kind: "post-function" });
  });
});

describe("properties and catalogue", () => {
  test("restricting properties are filtered in SQL to the keys that restrict", async () => {
    await loadRestrictingProperties("site", "v1");
    expect(issued.at(-1).statement).toMatch(/prop_key LIKE 'jira\.permission\.%' OR prop_key = 'jira\.issue\.editable'/);
  });

  test("status properties read one status", async () => {
    rowsFor = () => [{ workflow_name: "WF", prop_key: "jira.issue.editable", prop_value: "false" }];
    const rows = await loadStatusWorkflowProperties("site", "v1", 3);
    expect(issued.at(-1).params).toEqual(["site", "v1", "3"]);
    expect(rows).toEqual([{ workflowName: "WF", key: "jira.issue.editable", value: "false" }]);
  });

  test("the workflow catalogue maps counts to numbers", async () => {
    rowsFor = () => [{ workflow_name: "WF", workflow_id: "u1", scope_type: "GLOBAL", scope_project_id: null, status_count: "3", transition_count: "2", rule_count: "1", scheme_count: "0" }];
    expect(await loadWorkflowsCatalog("site", "v1")).toEqual([{
      name: "WF", id: "u1", scopeType: "GLOBAL", scopeProjectId: null, statusCount: 3, transitionCount: 2, ruleCount: 1, schemeCount: 0,
    }]);
  });
});

describe("meta", () => {
  test("reads workflow_rules as null when never captured and as a number when it was", async () => {
    rowsFor = () => [{ state: "ready", version: "v1", workflow_rules: null, transition_screens: 3 }];
    expect((await readWorkflowSnapshotMeta("site")).workflowRules).toBeNull();
    rowsFor = () => [{ state: "ready", version: "v1", workflow_rules: 0, transition_screens: 3 }];
    expect((await readWorkflowSnapshotMeta("site")).workflowRules).toBe(0);
  });

  test("writes workflow_rules alongside the rest", async () => {
    rowsFor = () => [];
    await writeWorkflowSnapshotMeta("site", { state: "ready", workflowRules: 42 });
    const write = issued.find((e) => /INSERT INTO workflow_snapshot_meta/.test(e.statement));
    expect(write.params).toHaveLength(placeholders(write.statement));
    expect(write.params).toContain(42);
  });
});
