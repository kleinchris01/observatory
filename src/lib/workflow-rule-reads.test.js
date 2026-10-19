import { vi, describe, test, expect, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  readWorkflowSnapshotMeta: vi.fn(),
  loadStatusesCatalog: vi.fn(),
  loadWorkflowRefsFor: vi.fn(),
  loadWorkflowRefsByType: vi.fn(),
  loadWorkflowRulesPage: vi.fn(),
  loadRefsForRules: vi.fn(),
  loadRestrictingProperties: vi.fn(),
  loadStatusWorkflowProperties: vi.fn(),
  loadWorkflowsCatalog: vi.fn(),
}));

vi.mock("./jira-api.js", () => ({
  incrMetric: vi.fn(),
  METRIC_NAMES: { resolver: "resolver" },
  getInstallationKey: () => "site",
}));

vi.mock("./project-store.js", () => ({
  ensureProjectStoreReady: vi.fn().mockResolvedValue(undefined),
  ...mocks,
}));

import {
  getWorkflowRuleUsage,
  getWorkflowRules,
  getWorkflowRestrictions,
  getWorkflowRuleInsights,
  loadFieldWorkflowEvidence,
  describeTransition,
  summarizeRuleInsights,
} from "./workflow-rule-reads.js";

const GROUP_ID = "5a2c1b9e-0f3d-4c6a-9e1b-7d8f2a3c4b5e";
const ctx = { context: {} };

const validatorRow = {
  refType: "field",
  refId: "customfield_1",
  refLabel: "Cost",
  refMissing: false,
  workflowName: "Build WF",
  source: "rule",
  ownerKind: "transition",
  ownerId: "21",
  ruleSeq: 0,
  propKey: null,
  propValue: null,
  transitionName: "Approve",
  transitionType: "DIRECTED",
  fromStatusIds: ["3"],
  toStatusId: "4",
  ruleKind: "validator",
  ruleKey: "system:validate-field-value",
  summary: "fieldRequired",
};
const propertyRow = {
  refType: "field",
  refId: "customfield_1",
  workflowName: "Other WF",
  source: "property",
  ownerKind: "status",
  ownerId: "3",
  ruleSeq: null,
  propKey: "jira.permission.edit.groupCF",
  propValue: "customfield_1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readWorkflowSnapshotMeta.mockResolvedValue({
    version: "v1",
    workflowRules: 12,
    refreshedAt: "2026-10-05T00:00:00.000Z",
  });
  mocks.loadStatusesCatalog.mockResolvedValue([
    { statusId: "1", name: "Open" },
    { statusId: "3", name: "In Review" },
    { statusId: "4", name: "Approved" },
  ]);
  mocks.loadWorkflowRefsFor.mockResolvedValue([]);
  mocks.loadWorkflowRefsByType.mockResolvedValue([]);
});

describe("availability", () => {
  test("no snapshot and a snapshot without rule capture are different answers, and neither is empty", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce(null);
    expect(await getWorkflowRuleUsage({ payload: { refType: "field", refId: "customfield_1" }, ...ctx })).toMatchObject(
      { available: false, reason: "no-snapshot" },
    );

    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce({ version: "v1", workflowRules: null });
    expect(await getWorkflowRuleUsage({ payload: { refType: "field", refId: "customfield_1" }, ...ctx })).toMatchObject(
      { available: false, reason: "rules-not-read" },
    );
  });

  test("zero captured rules is still an answer", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce({ version: "v1", workflowRules: 0 });
    expect(await getWorkflowRuleUsage({ payload: { refType: "field", refId: "customfield_1" }, ...ctx })).toMatchObject(
      { available: true, total: 0, usages: [] },
    );
  });

  test("rejects an unknown reference type and an empty id", async () => {
    await expect(getWorkflowRuleUsage({ payload: { refType: "issue", refId: "x" }, ...ctx })).rejects.toThrow(
      /refType/,
    );
    await expect(getWorkflowRuleUsage({ payload: { refType: "field", refId: " " }, ...ctx })).rejects.toThrow(/refId/);
  });
});

describe("getWorkflowRuleUsage", () => {
  test("says which transition, between which statuses, and what kind of rule", async () => {
    mocks.loadWorkflowRefsFor.mockResolvedValueOnce([validatorRow, propertyRow]);
    const result = await getWorkflowRuleUsage({ payload: { refType: "field", refId: "customfield_1" }, ...ctx });

    expect(result).toMatchObject({ available: true, total: 2, workflowCount: 2 });
    expect(result.usages[0]).toMatchObject({
      workflowName: "Build WF",
      transition: { name: "Approve", from: [{ id: "3", name: "In Review" }], to: { id: "4", name: "Approved" } },
      rule: { kind: "validator", label: "Field value check", summary: "fieldRequired" },
      property: null,
    });
    expect(result.usages[1]).toMatchObject({
      status: { id: "3", name: "In Review" },
      transition: null,
      property: { key: "jira.permission.edit.groupCF", meaning: expect.stringMatching(/Edit: only group in field/) },
    });
  });

  test("a group lookup also matches properties that name the group rather than its id", async () => {
    await getWorkflowRuleUsage({ payload: { refType: "group", refId: GROUP_ID, refName: "Plant Engineers" }, ...ctx });
    expect(mocks.loadWorkflowRefsFor).toHaveBeenCalledWith("site", "v1", "group", [GROUP_ID]);
    expect(mocks.loadWorkflowRefsFor).toHaveBeenCalledWith("site", "v1", "group-name", ["Plant Engineers"]);
  });
});

describe("describeTransition", () => {
  const names = new Map([["3", "In Review"]]);
  test("names the create step and global transitions the way Jira's editor does", () => {
    expect(describeTransition({ transitionType: "INITIAL", toStatusId: "3" }, names).from).toEqual([
      { id: null, name: "Create" },
    ]);
    expect(describeTransition({ transitionType: "GLOBAL", fromStatusIds: [] }, names).from).toEqual([
      { id: null, name: "Any status" },
    ]);
    expect(describeTransition({ fromStatusIds: ["99"] }, names).from).toEqual([{ id: "99", name: "Status 99" }]);
  });
});

describe("getWorkflowRules", () => {
  test("pages rules and attaches each one's references", async () => {
    mocks.loadWorkflowRulesPage.mockResolvedValueOnce({
      total: 1,
      rules: [
        {
          workflowName: "Build WF",
          transitionId: "21",
          ruleSeq: 0,
          kind: "validator",
          ruleKey: "system:validate-field-value",
          summary: "fieldRequired",
          transitionName: "Approve",
          transitionType: "DIRECTED",
          fromStatusIds: ["3"],
          toStatusId: "4",
        },
      ],
    });
    mocks.loadRefsForRules.mockResolvedValueOnce([{ ...validatorRow }]);

    const result = await getWorkflowRules({ payload: { query: "approve", kind: "validator" }, ...ctx });
    expect(mocks.loadWorkflowRulesPage).toHaveBeenCalledWith(
      "site",
      "v1",
      expect.objectContaining({ query: "approve", kind: "validator" }),
    );
    expect(result.rules[0]).toMatchObject({
      label: "Field value check",
      transition: { from: [{ name: "In Review" }], to: { name: "Approved" } },
      refs: [{ type: "field", id: "customfield_1", label: "Cost", missing: false }],
    });
  });

  test("rejects an unknown kind", async () => {
    await expect(getWorkflowRules({ payload: { kind: "trigger-happy" }, ...ctx })).rejects.toThrow(/kind/);
  });
});

describe("getWorkflowRestrictions", () => {
  test("parses edit locks, labels the group, and counts edit-locked statuses", async () => {
    mocks.loadRestrictingProperties.mockResolvedValueOnce([
      {
        workflowName: "Build WF",
        ownerKind: "status",
        ownerId: "3",
        key: "jira.permission.edit.group",
        value: GROUP_ID,
      },
      { workflowName: "Build WF", ownerKind: "status", ownerId: "4", key: "jira.issue.editable", value: "false" },
      { workflowName: "Build WF", ownerKind: "status", ownerId: "4", key: "opsbar-sequence", value: "10" },
    ]);
    mocks.loadWorkflowRefsByType.mockResolvedValueOnce([
      { refType: "group", refId: GROUP_ID, refLabel: "Plant Engineers", refMissing: false },
    ]);

    const result = await getWorkflowRestrictions({ payload: {}, ...ctx });
    expect(result.total).toBe(2);
    expect(result.summary).toEqual({ editLockedStatuses: 2, workflows: 1, missingHolders: 0 });
    expect(result.restrictions[0]).toMatchObject({
      status: { name: "In Review" },
      permission: "edit",
      holder: { type: "group", id: GROUP_ID, label: "Plant Engineers", missing: false },
    });
    expect(result.restrictions[1]).toMatchObject({ effect: "not-editable", holder: null });
  });

  test("narrows to one status for the status drawer", async () => {
    mocks.loadStatusWorkflowProperties.mockResolvedValueOnce([
      { workflowName: "WF", key: "jira.permission.edit.group", value: "gone-group-id-0000-0000-000000000000" },
    ]);
    mocks.loadWorkflowRefsByType.mockResolvedValueOnce([]);
    const result = await getWorkflowRestrictions({ payload: { statusId: 3 }, ...ctx });
    expect(mocks.loadStatusWorkflowProperties).toHaveBeenCalledWith("site", "v1", "3");
    expect(result.restrictions[0].status).toEqual({ id: "3", name: "In Review" });
  });

  test("counts holders that no longer exist", async () => {
    mocks.loadRestrictingProperties.mockResolvedValueOnce([
      { workflowName: "WF", ownerKind: "status", ownerId: "3", key: "jira.permission.edit.group", value: GROUP_ID },
    ]);
    mocks.loadWorkflowRefsByType.mockResolvedValueOnce([
      { refType: "group", refId: GROUP_ID, refLabel: null, refMissing: true },
    ]);
    expect((await getWorkflowRestrictions({ payload: {}, ...ctx })).summary.missingHolders).toBe(1);
  });
});

describe("insights", () => {
  test("broken references and inactive workflows", async () => {
    mocks.loadWorkflowsCatalog.mockResolvedValueOnce([
      { name: "Live", scopeType: "GLOBAL", schemeCount: 2, ruleCount: 5 },
      { name: "Zombie", scopeType: "GLOBAL", schemeCount: 0, ruleCount: 1 },
      { name: "Team", scopeType: "PROJECT", schemeCount: 0, ruleCount: 0 },
    ]);
    mocks.loadWorkflowRefsByType.mockResolvedValueOnce([
      {
        refType: "field",
        refId: "customfield_9",
        refMissing: true,
        workflowName: "Live",
        source: "rule",
        ownerKind: "transition",
        ownerId: "21",
        ruleSeq: 0,
      },
      {
        refType: "field",
        refId: "customfield_8",
        refMissing: true,
        workflowName: "Live",
        source: "rule",
        ownerKind: "transition",
        ownerId: "21",
        ruleSeq: 0,
      },
      {
        refType: "group",
        refId: "g",
        refMissing: true,
        workflowName: "Live",
        source: "property",
        ownerKind: "status",
        ownerId: "3",
        propKey: "jira.permission.edit.group",
      },
      {
        refType: "field",
        refId: "customfield_1",
        refMissing: false,
        workflowName: "Live",
        source: "rule",
        ownerKind: "transition",
        ownerId: "22",
        ruleSeq: 0,
      },
    ]);

    const result = await getWorkflowRuleInsights(ctx);
    expect(result.totals).toEqual({
      workflows: 3,
      teamManaged: 1,
      rules: 6,
      brokenRules: 1,
      brokenProperties: 1,
      inactive: 1,
    });
    expect(result.inactive.map((w) => w.name)).toEqual(["Zombie"]);
    expect(result.brokenRefs[2]).toMatchObject({ type: "group", status: { name: "In Review" } });
  });

  test("summarizeRuleInsights is safe on empty input", () => {
    expect(summarizeRuleInsights({}).totals).toEqual({
      workflows: 0,
      teamManaged: 0,
      rules: 0,
      brokenRules: 0,
      brokenProperties: 0,
      inactive: 0,
    });
  });
});

describe("loadFieldWorkflowEvidence", () => {
  test("null when rules were never captured -- a gap, not a pass", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValueOnce({ version: "v1", workflowRules: null });
    expect(await loadFieldWorkflowEvidence("site", ["customfield_1"])).toBeNull();
  });

  test("counts per field with readable examples, and zero for fields nothing names", async () => {
    mocks.loadWorkflowRefsFor.mockResolvedValueOnce([validatorRow, propertyRow]);
    const evidence = await loadFieldWorkflowEvidence("site", ["customfield_1", "customfield_2"]);
    expect(evidence.get("customfield_1")).toMatchObject({ available: true, count: 2, workflowCount: 2 });
    expect(evidence.get("customfield_1").examples[0]).toBe(
      "Field value check on Approve (In Review -> Approved) in Build WF",
    );
    expect(evidence.get("customfield_1").examples[1]).toBe("jira.permission.edit.groupCF on In Review in Other WF");
    expect(evidence.get("customfield_2")).toEqual({ available: true, count: 0, workflowCount: 0, examples: [] });
  });
});
