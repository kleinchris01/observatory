import { describe, test, expect } from "vitest";
import {
  extractReferences,
  summarizeRule,
  parseWorkflowProperty,
  propertyReferences,
  extractWorkflowRules,
  buildWorkflowRuleRows,
  labelReferences,
  findBrokenReferences,
  countSchemesByWorkflow,
  findInactiveWorkflows,
  ruleLabel,
  isHousekeepingRule,
} from "./workflow-rules.js";

const GROUP_ID = "5a2c1b9e-0f3d-4c6a-9e1b-7d8f2a3c4b5e";

// The current endpoint's shape (GET /rest/api/3/workflows/search?expand=values.transitions),
// trimmed to what matters: statuses by reference, transitions with links and rule arrays.
const currentWorkflow = {
  id: "b9ff2384-d3b6-4d4e-9509-3ee19f607168",
  name: "Build Deviation WF",
  scope: { type: "GLOBAL" },
  statuses: [
    { statusReference: "ref-review", properties: { "jira.permission.edit.group": GROUP_ID } },
    { statusReference: "ref-approved", properties: { "jira.issue.editable": "false" } },
    { statusReference: "ref-open", properties: {} },
  ],
  transitions: [
    {
      id: "1",
      name: "Create",
      type: "INITIAL",
      toStatusReference: "ref-open",
      links: [],
      actions: [{ ruleKey: "system:create-issue", parameters: {} }],
    },
    {
      id: "21",
      name: "Approve",
      type: "DIRECTED",
      toStatusReference: "ref-approved",
      links: [{ fromStatusReference: "ref-review", fromPort: 0, toPort: 1 }],
      validators: [
        {
          ruleKey: "system:validate-field-value",
          parameters: {
            ruleType: "fieldRequired",
            fieldsRequired: "customfield_15731,customfield_12574",
            errorMessage: "Fill in the cost",
          },
        },
      ],
      conditions: {
        operation: "ALL",
        conditions: [
          {
            ruleKey: "system:restrict-issue-transition",
            parameters: { groupIds: GROUP_ID, roleIds: "10002", permissionKeys: "" },
          },
        ],
        conditionGroups: [],
      },
      actions: [
        { ruleKey: "system:update-issue-status", parameters: {} },
        { ruleKey: "system:update-field", parameters: { field: "resolution", value: "10000", mode: "REPLACE" } },
      ],
      properties: { "opsbar-sequence": "20" },
    },
    {
      id: "31",
      name: "Reopen",
      type: "GLOBAL",
      toStatusReference: "ref-open",
      links: [],
      validators: [
        {
          ruleKey: "ari:cloud:ecosystem::extension/scriptrunner-validator",
          parameters: { config: "issue.customfield_18445 != null && token == 'abc'" },
        },
      ],
    },
  ],
};
const idByReference = new Map([
  ["ref-review", "3"],
  ["ref-approved", "4"],
  ["ref-open", "1"],
]);

// The deprecated endpoint's shape with transitions.rules and statuses.properties expanded.
const legacyWorkflow = {
  id: { name: "Legacy WF", entityId: "x" },
  statuses: [{ id: "3", properties: { "jira.permission.comment.group": "jira-administrators" } }],
  transitions: [
    {
      id: "11",
      name: "Submit",
      from: ["1"],
      to: "3",
      type: "directed",
      rules: {
        conditionsTree: {
          nodeType: "compound",
          operator: "AND",
          conditions: [
            { nodeType: "simple", type: "UserInGroupCondition", configuration: { groups: ["jira-software-users"] } },
          ],
        },
        validators: [{ type: "FieldRequiredValidator", configuration: { fields: [{ id: "customfield_100" }] } }],
        postFunctions: [
          { type: "UpdateIssueStatusFunction" },
          { type: "UpdateIssueFieldFunction", configuration: { fieldId: "assignee" } },
        ],
      },
    },
  ],
};

describe("extractReferences", () => {
  test("reads comma-separated field ids under a field key", () => {
    expect(extractReferences({ fieldsRequired: "customfield_1, customfield_2" })).toEqual([
      { refType: "field", refId: "customfield_1" },
      { refType: "field", refId: "customfield_2" },
    ]);
  });

  test("finds a custom field id inside free text, which is how app validators name fields", () => {
    expect(extractReferences({ config: "issue.customfield_18445 != null" })).toEqual([
      { refType: "field", refId: "customfield_18445" },
    ]);
  });

  test("treats a system field id under a field key as a field, but not an expression", () => {
    expect(extractReferences({ field: "resolution" })).toEqual([{ refType: "field", refId: "resolution" }]);
    expect(extractReferences({ field: "issue.status != 'Done'" })).toEqual([]);
  });

  test("tells a group id from a group name, and keeps spaces inside names", () => {
    expect(extractReferences({ groupIds: GROUP_ID })).toEqual([{ refType: "group", refId: GROUP_ID }]);
    expect(extractReferences({ groups: ["Plant Engineers", "jira-admins"] })).toEqual([
      { refType: "group-name", refId: "Plant Engineers" },
      { refType: "group-name", refId: "jira-admins" },
    ]);
  });

  test("carries the parent key into nested { id } objects from the deprecated shape", () => {
    expect(extractReferences({ fields: [{ id: "customfield_100" }] })).toEqual([
      { refType: "field", refId: "customfield_100" },
    ]);
  });

  test("reads roles, permissions and statuses, and ignores empty values", () => {
    expect(
      extractReferences({ roleIds: "10002,10003", permissionKeys: "EDIT_ISSUES", previousStatusIds: "3" }),
    ).toEqual([
      { refType: "role", refId: "10002" },
      { refType: "role", refId: "10003" },
      { refType: "permission", refId: "EDIT_ISSUES" },
      { refType: "status", refId: "3" },
    ]);
    expect(extractReferences({ permissionKeys: "" })).toEqual([]);
    expect(extractReferences(null)).toEqual([]);
  });

  test("counts a reference once however many times a rule repeats it", () => {
    expect(extractReferences({ fieldKey: "customfield_9", expression: "customfield_9 > 1" })).toHaveLength(1);
  });
});

describe("summarizeRule", () => {
  test("echoes only safe keys -- never the error message or an expression", () => {
    const summary = summarizeRule({
      ruleType: "fieldRequired",
      errorMessage: "secret plan",
      expression: "token == 'abc'",
    });
    expect(summary).toBe("fieldRequired");
    expect(summary).not.toMatch(/secret|token/);
  });

  test("returns null when nothing safe is present", () => {
    expect(summarizeRule({ script: "x" })).toBeNull();
    expect(summarizeRule(null)).toBeNull();
  });
});

describe("parseWorkflowProperty", () => {
  test("reads a group edit lock", () => {
    expect(parseWorkflowProperty("jira.permission.edit.group", GROUP_ID)).toMatchObject({
      effect: "restrict-permission",
      permission: "edit",
      holderType: "group",
      holder: GROUP_ID,
    });
  });

  test("reads numbered, sub-task and denied variants", () => {
    expect(parseWorkflowProperty("jira.permission.comment.group.1", "jira-admins")).toMatchObject({
      permission: "comment",
      holderType: "group",
    });
    expect(parseWorkflowProperty("jira.permission.subtasks.create.projectrole", "10002")).toMatchObject({
      permission: "create",
      subtasks: true,
      holderType: "projectrole",
    });
    expect(parseWorkflowProperty("jira.permission.delete.denied", "").description).toMatch(/nobody/);
  });

  test("reads the not-editable flag, and only when it is false", () => {
    expect(parseWorkflowProperty("jira.issue.editable", "false")).toMatchObject({ effect: "not-editable" });
    expect(parseWorkflowProperty("jira.issue.editable", "true")).toBeNull();
  });

  test("ignores properties that restrict nothing", () => {
    expect(parseWorkflowProperty("opsbar-sequence", "20")).toBeNull();
    expect(parseWorkflowProperty("jira.i18n.title", "x")).toBeNull();
  });

  test("propertyReferences names what a restriction points at", () => {
    expect(propertyReferences(parseWorkflowProperty("jira.permission.edit.group", GROUP_ID))).toEqual([
      { refType: "group", refId: GROUP_ID },
    ]);
    expect(propertyReferences(parseWorkflowProperty("jira.permission.edit.groupCF", "customfield_5"))).toEqual([
      { refType: "field", refId: "customfield_5" },
    ]);
    expect(propertyReferences(parseWorkflowProperty("approval.field.id", "customfield_7"))).toEqual([
      { refType: "field", refId: "customfield_7" },
    ]);
    expect(propertyReferences(null)).toEqual([]);
  });
});

describe("extractWorkflowRules — current endpoint", () => {
  const result = extractWorkflowRules(currentWorkflow, idByReference);
  const approve = result.transitions.find((t) => t.id === "21");

  test("resolves from and to statuses through the reference table", () => {
    expect(approve).toMatchObject({ name: "Approve", type: "DIRECTED", fromStatusIds: ["3"], toStatusId: "4" });
    expect(result.transitions.find((t) => t.id === "31")).toMatchObject({ type: "GLOBAL", fromStatusIds: [] });
  });

  test("captures conditions, validators and post-functions, dropping Jira's housekeeping", () => {
    expect(approve.rules.map((r) => [r.kind, r.ruleKey])).toEqual([
      ["condition", "system:restrict-issue-transition"],
      ["validator", "system:validate-field-value"],
      ["post-function", "system:update-field"],
    ]);
    expect(result.transitions.find((t) => t.id === "1").rules).toEqual([]);
  });

  test("names the fields a validator requires", () => {
    const validator = approve.rules.find((r) => r.kind === "validator");
    expect(validator.refs).toEqual([
      { refType: "field", refId: "customfield_15731" },
      { refType: "field", refId: "customfield_12574" },
    ]);
    expect(validator.label).toBe("Field value check");
  });

  test("reads status properties against real status ids", () => {
    expect(result.statusProperties).toEqual([
      { statusId: "3", key: "jira.permission.edit.group", value: GROUP_ID },
      { statusId: "4", key: "jira.issue.editable", value: "false" },
    ]);
  });

  test("never keeps an app validator's raw script", () => {
    const reopen = result.transitions.find((t) => t.id === "31");
    expect(JSON.stringify(reopen)).not.toMatch(/token|abc/);
    expect(reopen.rules[0].refs).toEqual([{ refType: "field", refId: "customfield_18445" }]);
  });
});

describe("extractWorkflowRules — deprecated endpoint", () => {
  const result = extractWorkflowRules(legacyWorkflow);
  const submit = result.transitions[0];

  test("reads from/to ids directly and normalises the type", () => {
    expect(submit).toMatchObject({ id: "11", fromStatusIds: ["1"], toStatusId: "3", type: "DIRECTED" });
  });

  test("flattens the condition tree and reads typed rules", () => {
    expect(submit.rules.map((r) => [r.kind, r.ruleKey])).toEqual([
      ["condition", "UserInGroupCondition"],
      ["validator", "FieldRequiredValidator"],
      ["post-function", "UpdateIssueFieldFunction"],
    ]);
    expect(submit.rules[1].refs).toEqual([{ refType: "field", refId: "customfield_100" }]);
    expect(submit.rules[0].refs).toEqual([{ refType: "group-name", refId: "jira-software-users" }]);
  });

  test("accepts properties as a key/value array too", () => {
    const out = extractWorkflowRules({
      statuses: [{ id: "9", properties: [{ key: "jira.issue.editable", value: "false" }] }],
    });
    expect(out.statusProperties).toEqual([{ statusId: "9", key: "jira.issue.editable", value: "false" }]);
  });

  test("redacts a property value that looks like a credential", () => {
    const out = extractWorkflowRules({
      statuses: [
        {
          id: "9",
          properties: { "webhook.url": "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX" },
        },
      ],
    });
    expect(out.statusProperties[0].value).toBe("[redacted]");
  });

  test("tolerates a workflow with nothing in it", () => {
    expect(extractWorkflowRules(null)).toEqual({ transitions: [], statusProperties: [] });
  });
});

describe("buildWorkflowRuleRows", () => {
  const workflows = [
    {
      name: currentWorkflow.name,
      id: currentWorkflow.id,
      scopeType: "GLOBAL",
      statusIds: ["1", "3", "4"],
      rules: extractWorkflowRules(currentWorkflow, idByReference),
    },
  ];
  const rows = buildWorkflowRuleRows(workflows, new Map([[currentWorkflow.name, 2]]));

  test("emits one inventory row per workflow with its counts", () => {
    expect(rows.workflows).toEqual([
      expect.objectContaining({
        workflowName: "Build Deviation WF",
        scopeType: "GLOBAL",
        statusCount: 3,
        transitionCount: 3,
        ruleCount: 4,
        schemeCount: 2,
      }),
    ]);
  });

  test("gives every reference the context it needs to render without a join", () => {
    const fieldRef = rows.refs.find((r) => r.refId === "customfield_15731");
    expect(fieldRef).toMatchObject({
      workflowName: "Build Deviation WF",
      source: "rule",
      ownerKind: "transition",
      ownerId: "21",
      ruleSeq: 1,
    });
    const groupLock = rows.refs.find((r) => r.source === "property" && r.refType === "group");
    expect(groupLock).toMatchObject({ ownerKind: "status", ownerId: "3", propKey: "jira.permission.edit.group" });
  });

  test("numbers references uniquely across the build", () => {
    const seqs = rows.refs.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test("skips a workflow that was read without its rules", () => {
    expect(buildWorkflowRuleRows([{ name: "Bare" }]).workflows).toEqual([]);
  });
});

describe("labelReferences", () => {
  const refs = [
    { refType: "field", refId: "customfield_1" },
    { refType: "field", refId: "customfield_404" },
    { refType: "field", refId: "resolution" },
    { refType: "group", refId: "g-live" },
    { refType: "group", refId: "g-gone" },
    { refType: "group", refId: "g-unknown" },
    { refType: "role", refId: "10002" },
  ];

  test("labels what exists and marks what is gone", () => {
    const out = labelReferences(refs, {
      fieldsById: new Map([
        ["customfield_1", { name: "Cost" }],
        ["resolution", { name: "Resolution" }],
      ]),
      groups: {
        byId: new Map([["g-live", "Plant Engineers"]]),
        missing: new Set(["g-gone"]),
        failed: new Set(["g-unknown"]),
      },
      rolesById: new Map([["10002", "Administrators"]]),
    });
    expect(out.map((r) => [r.refId, r.refLabel, r.refMissing])).toEqual([
      ["customfield_1", "Cost", false],
      ["customfield_404", null, true],
      ["resolution", "Resolution", false],
      ["g-live", "Plant Engineers", false],
      ["g-gone", null, true],
      // A lookup that failed is "could not check", never "missing".
      ["g-unknown", null, null],
      ["10002", "Administrators", false],
    ]);
  });

  test("judges nothing when the catalogues could not be read", () => {
    expect(labelReferences(refs).every((r) => r.refMissing === null)).toBe(true);
  });
});

describe("findBrokenReferences", () => {
  test("flags a deleted custom field and a deleted group, and nothing when it cannot judge", () => {
    const refs = [
      { refType: "field", refId: "customfield_1" },
      { refType: "field", refId: "customfield_2" },
      { refType: "group", refId: "g1" },
    ];
    expect(findBrokenReferences(refs, { knownFieldIds: new Set(["customfield_1"]), knownGroupIds: new Set() })).toEqual(
      [refs[1], refs[2]],
    );
    expect(findBrokenReferences(refs)).toEqual([]);
  });
});

describe("inactive workflows", () => {
  test("counts each scheme once per workflow, across default and per-type mappings", () => {
    const counts = countSchemesByWorkflow([
      { defaultWorkflow: "A", issueTypeMapping: { 10001: "B", 10002: "A" } },
      { defaultWorkflow: "A" },
    ]);
    expect(counts.get("A")).toBe(2);
    expect(counts.get("B")).toBe(1);
  });

  test("flags company-managed workflows no scheme uses, never team-managed ones", () => {
    const inactive = findInactiveWorkflows([
      { name: "Used", scopeType: "GLOBAL", schemeCount: 1 },
      { name: "Zombie", scopeType: "GLOBAL", schemeCount: 0 },
      { name: "Legacy shape", scopeType: null, schemeCount: 0 },
      { name: "Team WF", scopeType: "PROJECT", schemeCount: 0 },
    ]);
    expect(inactive.map((w) => w.name)).toEqual(["Legacy shape", "Zombie"]);
  });
});

describe("labels", () => {
  test("uses Jira's words for its own rules and the key for an app's", () => {
    expect(ruleLabel("system:validate-field-value")).toBe("Field value check");
    expect(ruleLabel("FieldRequiredValidator")).toBe("Field required");
    expect(ruleLabel("ari:cloud:ecosystem::extension/x")).toBe("ari:cloud:ecosystem::extension/x");
    expect(ruleLabel(null)).toBe("Unnamed rule");
    expect(isHousekeepingRule("system:reindex-issue")).toBe(true);
    expect(isHousekeepingRule("system:update-field")).toBe(false);
  });
});
