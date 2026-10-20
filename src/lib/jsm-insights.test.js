import { describe, test, expect } from "vitest";
import {
  customFieldIdsInJql,
  brokenFieldRefs,
  analyzeRequestTypes,
  analyzeQueues,
  analyzeSlas,
  analyzeOrganizations,
  summarizeJsm,
  summarizeJsmHealth,
} from "./jsm-insights.js";

const codes = (row) => row.findings.map((f) => f.code);

describe("custom field references in queue JQL", () => {
  test("reads both unambiguous forms, never names", () => {
    expect(customFieldIdsInJql('cf[10030] = x AND customfield_10031 is EMPTY AND "Team" = y').sort()).toEqual([
      "customfield_10030",
      "customfield_10031",
    ]);
    expect(customFieldIdsInJql("")).toEqual([]);
  });

  // "We did not check" must never render as "nothing is broken".
  test("broken refs are null when the catalog was not read", () => {
    expect(brokenFieldRefs("cf[1] = x", null)).toBeNull();
    expect(brokenFieldRefs("cf[1] = x AND cf[2] = y", new Set(["customfield_1"]))).toEqual(["customfield_2"]);
  });
});

describe("request types", () => {
  const rt = (over) => ({
    deskId: "1",
    id: "10",
    name: "Get help",
    hasDescription: true,
    groupIds: ["1"],
    recentCount: 5,
    issueCount: null,
    ...over,
  });

  test("hidden only when the desk's portal groups were read", () => {
    expect(codes(analyzeRequestTypes([rt({ groupIds: [] })])[0])).toContain("hidden");
    const unread = analyzeRequestTypes([rt({ groupIds: [] })], { groupsReadByDesk: new Map([["1", false]]) });
    expect(codes(unread[0])).not.toContain("hidden");
  });

  // Only a measured zero is evidence of non-use.
  test("unused needs a measured zero, and says never-used from used-before", () => {
    expect(codes(analyzeRequestTypes([rt({ recentCount: null })])[0])).not.toContain("unused");
    const [never] = analyzeRequestTypes([rt({ recentCount: 0, issueCount: 0 })]);
    expect(never.findings.find((f) => f.code === "unused").detail).toMatch(/Never used/);
    const [before] = analyzeRequestTypes([rt({ recentCount: 0, issueCount: 30 })]);
    expect(before.findings.find((f) => f.code === "unused").detail).toMatch(/Used before/);
  });

  test("duplicate names are judged per desk", () => {
    const rows = analyzeRequestTypes([
      rt({ id: "1", name: "Get IT help" }),
      rt({ id: "2", name: "Get IT  help" }),
      rt({ id: "3", deskId: "2", name: "Get IT help" }),
    ]);
    expect(rows.map((r) => codes(r).includes("duplicate-name"))).toEqual([true, true, false]);
    expect(rows[0].duplicateGroup).toBe(rows[1].duplicateGroup);
  });

  test("no description is flagged", () => {
    expect(codes(analyzeRequestTypes([rt({ hasDescription: false })])[0])).toEqual(["undescribed"]);
  });
});

describe("queues", () => {
  const q = (over) => ({
    deskId: "1",
    id: "7",
    name: "Open",
    jql: "project = SD",
    issueCount: 4,
    brokenRefs: [],
    ...over,
  });

  test("broken, empty and duplicate queries", () => {
    const rows = analyzeQueues([
      q({ id: "1", brokenRefs: ["customfield_9"] }),
      q({ id: "2", issueCount: 0, jql: "status = Open" }),
      q({ id: "3", jql: "project=SD" }),
      q({ id: "4", deskId: "2" }),
      q({ id: "5", issueCount: null, jql: "" }),
    ]);
    expect(rows.map(codes)).toEqual([["broken-ref", "duplicate-jql"], ["empty"], ["duplicate-jql"], [], []]);
  });
});

describe("SLAs", () => {
  const row = (over) => ({
    deskId: "1",
    fieldId: "customfield_1",
    fieldName: "TTR",
    activeCount: 10,
    breachedCount: 2,
    ...over,
  });

  test("aggregate per field across desks", () => {
    const [sla] = analyzeSlas([row(), row({ deskId: "2", activeCount: 30, breachedCount: 2 })]);
    expect(sla).toMatchObject({ activeCount: 40, breachedCount: 4, measuredDesks: 2, breachRate: 0.1, findings: [] });
  });

  test("unused only when every desk was measured at zero", () => {
    expect(codes(analyzeSlas([row({ activeCount: 0, breachedCount: 0 })])[0])).toEqual(["unused"]);
    const partly = analyzeSlas([row({ activeCount: 0, breachedCount: 0 }), row({ deskId: "2", activeCount: null })]);
    expect(codes(partly[0])).toEqual([]);
  });

  test("high breach needs a real sample", () => {
    expect(codes(analyzeSlas([row({ activeCount: 20, breachedCount: 15 })])[0])).toEqual(["high-breach"]);
    expect(codes(analyzeSlas([row({ activeCount: 4, breachedCount: 4 })])[0])).toEqual([]);
  });
});

describe("organizations", () => {
  test("empty and unattached, each only when measured", () => {
    const rows = analyzeOrganizations([
      { id: "1", name: "A", memberCount: 0, deskCount: 0 },
      { id: "2", name: "B", memberCount: null, deskCount: null },
    ]);
    expect(rows.map(codes)).toEqual([["empty", "unattached"], []]);
  });
});

describe("summary and health", () => {
  test("a site with no service desk is not-applicable on every pillar", () => {
    const summary = summarizeJsm({ jsmEnabled: false });
    expect(summary).toEqual({ available: false, jsmEnabled: false });
    const health = summarizeJsmHealth(summary);
    for (const key of ["requestTypes", "queues", "slas", "customers"]) {
      expect(health[key]).toEqual({ available: false, jsmEnabled: false });
    }
  });

  test("counts every finding and keeps measured denominators", () => {
    const summary = summarizeJsm({
      desks: [{ deskId: "1", customerCount: 0, orgCount: 0 }],
      requestTypes: [
        { deskId: "1", id: "1", name: "A", hasDescription: false, groupIds: [], recentCount: 0, issueCount: 0 },
        { deskId: "1", id: "2", name: "B", hasDescription: true, groupIds: ["1"], recentCount: null },
      ],
      queues: [{ deskId: "1", id: "1", name: "Q", jql: "cf[9] = 1", issueCount: 3, brokenRefs: ["customfield_9"] }],
      slas: [{ deskId: "1", fieldId: "customfield_1", fieldName: "TTR", activeCount: 20, breachedCount: 5 }],
      organizations: [{ id: "1", name: "O", memberCount: 0, deskCount: 0 }],
    });
    expect(summary.requestTypes).toMatchObject({ total: 2, hidden: 1, undescribed: 1, usageMeasured: 1, unused: 1 });
    expect(summary.queues).toMatchObject({ total: 1, broken: 1, brokenChecked: 1, openIssues: 3 });
    expect(summary.slas).toMatchObject({ activeRequests: 20, breachedRequests: 5, breachRate: 0.25 });
    expect(summary.customers).toMatchObject({
      emptyOrganizations: 1,
      unattachedOrganizations: 1,
      desksWithoutCustomers: 1,
    });
    expect(summarizeJsmHealth(summary).queues).toMatchObject({ available: true, jsmEnabled: true, broken: 1 });
  });

  test("an empty snapshot is unavailable, and no summary is unmeasured", () => {
    expect(summarizeJsmHealth(summarizeJsm({ desks: [] })).slas).toEqual({ available: false });
    expect(summarizeJsmHealth(null).queues).toBeNull();
  });
});
