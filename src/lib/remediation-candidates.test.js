import { describe, test, expect } from "vitest";
import {
  CANDIDATE_SELECTORS,
  adoptionFlagged,
  automationRiskCandidates,
  dashboardCandidates,
  estateUnusedValues,
  fieldCandidates,
  filterCandidates,
  jsmFlagged,
  jsmSlas,
  partialOf,
  reasonsWithCode,
} from "./remediation-candidates.js";

// The selectors are pure: an inventory in, a finding's tickets out. None of these tests mocks a
// store read -- that is the point of moving them out of the resolver.

const select = (key, data) => CANDIDATE_SELECTORS[key].select(data);

describe("CANDIDATE_SELECTORS", () => {
  test("every selector names a source and a select function", () => {
    const sources = new Set();
    for (const [key, sel] of Object.entries(CANDIDATE_SELECTORS)) {
      expect(typeof sel.source, key).toBe("string");
      expect(typeof sel.select, key).toBe("function");
      sources.add(sel.source);
    }
    // The resolver's CANDIDATE_SOURCES must cover each of these; remediation.test.js runs them.
    expect([...sources].sort()).toEqual([
      "access",
      "assets",
      "automationAnalysis",
      "automationCascades",
      "automationDirectory",
      "dashboards",
      "estate",
      "fieldConfigs",
      "fields",
      "filters",
      "issueTypes",
      "jsm",
      "projects",
      "users",
      "workflow",
      "workflowRules",
    ]);
  });

  test("access: risky permission schemes, ids as strings", () => {
    const inv = { permissions: { governance: { riskySchemes: [{ id: 10, name: "Prod" }] } } };
    expect(select("permission-risky", inv)).toEqual({ available: true, items: [{ id: "10", name: "Prod" }] });
  });

  test("access: unused schemes of all three kinds, tagged by type", () => {
    const g = (list) => ({ governance: { unusedSchemes: list } });
    const inv = {
      permissions: g([{ id: 1, name: "P" }]),
      security: g([{ id: 2, name: "S" }]),
      notifications: g([]),
    };
    expect(select("access-unused-schemes", inv).items).toEqual([
      { id: "permission:1", type: "permission", schemeId: "1", name: "P" },
      { id: "security:2", type: "security", schemeId: "2", name: "S" },
    ]);
  });

  // Without the People roster every account would read as departed.
  test("access: departed-account findings refuse without a roster, and keep only departed rows", () => {
    const scheme = { id: 5, name: "X", grants: [{ departed: true }, { departed: false }] };
    expect(
      select("permission-departed-grants", {
        permissions: { governance: { rosterMeasured: false, directGrantSchemes: [scheme] } },
      }),
    ).toEqual({ available: false, reason: "no-roster", items: [] });
    const ok = select("permission-departed-grants", {
      permissions: {
        governance: { rosterMeasured: true, directGrantSchemes: [scheme, { id: 6, grants: [{ departed: false }] }] },
      },
    });
    expect(ok.items).toEqual([{ id: "5", name: "X", grants: [{ departed: true }] }]);
  });

  test("access: role findings bundle past 50 projects", () => {
    const memberships = Array.from({ length: 60 }, (_, i) => ({ projectKey: `P${i}` }));
    const res = select("role-offroster-actors", { roles: { governance: { offRosterMemberships: memberships } } });
    expect(res.available).toBe(true);
    expect(res.items.length).toBeLessThanOrEqual(51);
  });

  test("estate: the missing-default check lists only lists with values and no default", () => {
    const res = select("estate-defaults", {
      priorities: [{ isDefault: false }, { isDefault: false }],
      resolutions: [{ isDefault: true }],
    });
    expect(res.items).toEqual([{ id: "priority", kind: "priority", valueCount: 2 }]);
  });

  test("people: dormant licences refuse until activity is measured", () => {
    expect(select("people-dormant-licences", { governance: { activityMeasured: false }, users: [] })).toEqual({
      available: false,
      reason: "no-activity",
      items: [],
    });
    const res = select("people-dormant-licences", {
      governance: { activityMeasured: true },
      users: [
        {
          accountId: "a",
          displayName: "A",
          dormant: true,
          applications: [{ name: "JSW" }],
          groups: [],
          ownedFilters: 2,
        },
        { accountId: "b", dormant: false },
      ],
    });
    expect(res.items).toEqual([
      {
        id: "a",
        accountId: "a",
        displayName: "A",
        lastActivityAt: undefined,
        products: ["JSW"],
        groups: [],
        ownedCount: 2,
      },
    ]);
  });

  test("workflow: rule-only statuses keep their counts, unknown as null", () => {
    const res = select("rule-only-statuses", {
      orphans: [
        { statusId: 3, name: "Parked", ruleOnly: true, automationRuleCount: 2 },
        { statusId: 4, name: "Lost", ruleOnly: false },
      ],
    });
    expect(res).toEqual({
      available: true,
      items: [{ id: "3", name: "Parked", automationRuleCount: 2, issueCount: null }],
    });
  });

  test("workflow rules: broken references grouped per workflow", () => {
    const res = select("workflow-broken-references", {
      brokenRefs: [
        { workflowName: "W", type: "field", id: "cf1", status: { name: "Open" } },
        { workflowName: "W", type: "group", id: "g", transitionId: 11 },
      ],
    });
    expect(res.items).toEqual([
      {
        id: "W",
        name: "W",
        count: 2,
        refs: [
          { type: "field", id: "cf1", where: "status Open" },
          { type: "group", id: "g", where: "transition 11" },
        ],
      },
    ]);
  });

  test("field configurations: duplicates grouped under the one to keep", () => {
    const res = select("fieldconfig-duplicates", {
      schemes: [],
      configs: [
        { id: "c1", name: "Keep", sourceId: "1" },
        { id: "c2", name: "Copy", sourceId: "2", duplicateOf: "c1" },
      ],
    });
    expect(res.items).toEqual([
      {
        id: "config:c1",
        kind: "config",
        keep: "c1",
        keepName: "Keep",
        members: ["c1", "c2"],
        memberNames: ["Keep", "Copy"],
        memberSourceIds: ["1", "2"],
        name: "Keep",
        count: 2,
      },
    ]);
  });

  test("projects: over-configured projects carry whether they are also idle", () => {
    const res = select("project-over-configured", {
      insights: {
        overConfigured: [{ projectKey: "A" }, { projectKey: "B" }],
        idleOverConfigured: [{ projectKey: "B" }],
      },
    });
    expect(res.items).toEqual([
      { id: "A", projectKey: "A", idle: false },
      { id: "B", projectKey: "B", idle: true },
    ]);
  });

  test("assets: broken references resolve their schema through the attribute or the type", () => {
    const res = select("asset-broken-references", {
      inv: { attributes: [{ id: 1, schemaId: "S1" }], objectTypes: [{ id: 7, name: "Laptop", schemaId: "S2" }] },
      insights: {
        brokenReferences: [
          { id: 1, objectTypeId: 7 },
          { id: 9, objectTypeId: 7 },
        ],
      },
    });
    expect(res.items).toEqual([
      { id: 1, objectTypeId: 7, schemaId: "S1", objectTypeName: "Laptop" },
      { id: 9, objectTypeId: 7, schemaId: "S2", objectTypeName: "Laptop" },
    ]);
  });

  test("automation: disabled rules from the directory", () => {
    const res = select("automation-disabled", { rules: [] });
    expect(res.available).toBe(true);
    expect(Array.isArray(res.items)).toBe(true);
  });

  test("automation: self-triggering cascades, one per source rule, partial against the count", () => {
    const res = select("automation-self-triggering", {
      analysis: {
        cascades: [
          { sourceId: 1, sourceName: "Loop", selfTriggering: true },
          { sourceId: 1, selfTriggering: true },
          { sourceId: 2, selfTriggering: false },
        ],
        estate: { health: { selfTriggeringCount: 3 } },
      },
      directory: null,
    });
    expect(res).toEqual({ available: true, partial: true, expected: 3, items: [{ id: 1, name: "Loop" }] });
  });
});

describe("shared item shapes", () => {
  test("reasonsWithCode picks a field's reasons with that code, or null", () => {
    const f = { findings: { reasons: [{ code: "stale" }, { code: "risky" }] } };
    expect(reasonsWithCode("stale")(f)).toEqual([{ code: "stale" }]);
    expect(reasonsWithCode("other")(f)).toBeNull();
  });

  test("fieldCandidates lists flagged fields with readable reasons", () => {
    const fields = [
      { id: "cf1", name: "Cost", type: "number", findings: { reasons: [{ code: "stale", title: "Stale" }] } },
      { id: "cf2", findings: { reasons: [] } },
    ];
    expect(fieldCandidates(fields, reasonsWithCode("stale"))).toEqual({
      available: true,
      items: [
        {
          id: "cf1",
          name: "Cost",
          type: "number",
          configuredProjectCount: null,
          totalIssueCount: null,
          reasons: ["Stale"],
        },
      ],
    });
  });

  // On the same terms the Overview counts: judged projects only, nothing while data is stale.
  test("adoptionFlagged counts judged projects only, and nothing while the data is stale", () => {
    const adoption = {
      available: true,
      dataStale: false,
      projects: [
        { projectKey: "A", measured: true, oldEnough: true, fellOff: true, issuesPerDay: 1.234 },
        { projectKey: "B", measured: true, oldEnough: false, fellOff: true },
      ],
    };
    expect(adoptionFlagged(adoption, "fellOff").map((p) => [p.projectKey, p.issuesPerDay])).toEqual([["A", 1.23]]);
    expect(adoptionFlagged({ ...adoption, dataStale: true }, "fellOff")).toEqual([]);
  });

  test("partialOf says when a preview is not the whole finding", () => {
    expect(partialOf([1], 3)).toEqual({ available: true, partial: true, expected: 3, items: [1] });
    expect(partialOf([1], 1)).toEqual({ available: true, items: [1] });
    expect(partialOf([1], undefined)).toEqual({ available: true, items: [1] });
  });

  test("automationRiskCandidates filters the preview by risk and reads the hosts", () => {
    const analysis = {
      findingsPreview: [
        { id: 1, n: "Webhook", e: 1, t: "issue_created", p: 2, r: [{ c: "external-http", h: ["x.io"] }] },
        { id: 2, r: [{ c: "no-actions" }] },
      ],
      estate: { health: { externalHttpCount: 1 } },
    };
    expect(automationRiskCandidates(analysis, "external-http", "externalHttpCount")).toEqual({
      available: true,
      items: [
        { id: 1, name: "Webhook", enabled: true, triggerType: "issue_created", projectCount: 2, hosts: ["x.io"] },
      ],
    });
  });

  test("filterCandidates keeps filters carrying the finding", () => {
    const res = filterCandidates(
      [
        {
          id: 1,
          name: "F",
          owner: { displayName: "Ann" },
          subscriptionCount: "2",
          findings: [{ code: "shared-publicly" }],
        },
        { id: 2, findings: [] },
      ],
      "shared-publicly",
    );
    expect(res.items).toEqual([
      { id: "1", name: "F", ownerName: "Ann", subscriptionCount: 2, favouritedCount: 0, lastUsedAt: null },
    ]);
  });

  // An empty list from a snapshot that never probed gadget filters is "not checked", not clean.
  test("dashboardCandidates refuses broken-gadget until gadget filters were probed", () => {
    const unprobed = [{ id: 1, gadgets: [{ filterId: 10 }] }];
    expect(dashboardCandidates(unprobed, "broken-gadget")).toEqual({
      available: false,
      reason: "not-probed",
      items: [],
    });
    expect(dashboardCandidates([], "broken-gadget")).toEqual({ available: true, items: [] });
  });

  test("estateUnusedValues waits for measured usage", () => {
    expect(estateUnusedValues({ usageMeasured: false }, "priorities", "priority")).toEqual({
      available: false,
      reason: "no-usage",
      items: [],
    });
    expect(
      estateUnusedValues(
        {
          usageMeasured: true,
          priorities: [
            { id: 1, name: "Low", issueCount: 0 },
            { id: 2, issueCount: 4 },
          ],
        },
        "priorities",
        "priority",
      ),
    ).toEqual({ available: true, items: [{ id: "1", kind: "priority", name: "Low", isDefault: false }] });
  });
});

describe("Jira Service Management candidates", () => {
  const f = (code) => ({ code });
  const view = {
    desks: [
      { deskId: "1", projectKey: "SD" },
      { deskId: "2", projectKey: "HR" },
    ],
    requestTypes: [
      { deskId: "1", id: "10", name: "Get help", projectKey: "SD", findings: [f("hidden"), f("unused")] },
      { deskId: "2", id: "10", name: "Onboard", projectKey: "HR", findings: [] },
    ],
    queues: [{ deskId: "1", id: "7", name: "Broken", projectKey: "SD", findings: [f("broken-ref")] }],
    slas: [
      {
        fieldId: "customfield_1",
        name: "TTR",
        activeCount: 40,
        breachedCount: 30,
        desks: [{ deskId: "1" }, { deskId: "2" }],
        findings: [f("high-breach")],
      },
    ],
    organizations: [{ id: "4", name: "Acme", findings: [f("empty")] }],
  };

  // Two desks can each have a request type 10, and they are different things to fix.
  test("request types and queues are ticketed per desk, keeping the raw id for links", () => {
    expect(jsmFlagged(view.requestTypes, "hidden").items).toEqual([
      expect.objectContaining({ id: "1:10", itemId: "10", projectKey: "SD", name: "Get help" }),
    ]);
    expect(CANDIDATE_SELECTORS["queue-integrity"].select(view).items.map((q) => q.id)).toEqual(["1:7"]);
    expect(CANDIDATE_SELECTORS["rt-descriptions"].select(view).items).toEqual([]);
  });

  test("an SLA is one ticket linking every desk it runs on", () => {
    expect(jsmSlas(view, "high-breach").items).toEqual([
      {
        id: "customfield_1",
        fieldId: "customfield_1",
        name: "TTR",
        activeCount: 40,
        breachedCount: 30,
        projectKeys: ["SD", "HR"],
      },
    ]);
    expect(CANDIDATE_SELECTORS["sla-usage"].select(view).items).toEqual([]);
  });

  test("every JSM selector picks only its own finding", () => {
    const row = (code) => ({ deskId: "1", id: code, name: code, findings: [f(code)] });
    const all = {
      desks: [],
      requestTypes: ["hidden", "unused", "undescribed", "duplicate-name"].map(row),
      queues: ["broken-ref", "empty", "duplicate-jql"].map(row),
      slas: ["high-breach", "unused"].map((code) => ({ fieldId: code, name: code, desks: [], findings: [f(code)] })),
      organizations: ["empty", "unattached"].map((code) => ({ id: code, name: code, findings: [f(code)] })),
    };
    const expected = {
      "rt-visibility": "1:hidden",
      "rt-usage": "1:unused",
      "rt-descriptions": "1:undescribed",
      "rt-naming": "1:duplicate-name",
      "queue-integrity": "1:broken-ref",
      "queue-usage": "1:empty",
      "queue-duplicates": "1:duplicate-jql",
      "sla-breach-rate": "high-breach",
      "sla-usage": "unused",
      "org-membership": "empty",
      "org-attachment": "unattached",
    };
    for (const [key, id] of Object.entries(expected)) {
      expect(CANDIDATE_SELECTORS[key].source, key).toBe("jsm");
      expect(
        CANDIDATE_SELECTORS[key].select(all).items.map((i) => i.id),
        key,
      ).toEqual([id]);
    }
    expect(jsmFlagged(undefined, "hidden")).toEqual({ available: true, items: [] });
    expect(jsmSlas({}, "unused")).toEqual({ available: true, items: [] });
  });

  test("organizations are keyed by their own id", () => {
    expect(CANDIDATE_SELECTORS["org-membership"].select(view).items.map((o) => o.id)).toEqual(["4"]);
  });
});
