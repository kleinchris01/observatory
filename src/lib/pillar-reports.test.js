import { describe, test, expect } from "vitest";
import {
  PILLAR_REPORTS,
  PILLAR_REPORT_BUILDERS,
  REPORT_ROW_LIMIT,
  buildPillarReport,
  finalizeReport,
  isPillarReportKey,
  unavailableReport, countScreenProjects } from "./pillar-reports.js";

describe("registry", () => {
  test("every registered pillar has a builder, and every builder is registered", () => {
    expect(Object.keys(PILLAR_REPORT_BUILDERS).sort()).toEqual(PILLAR_REPORTS.map((r) => r.key).sort());
  });

  test("every report names the governance pillars scored beside it", () => {
    for (const r of PILLAR_REPORTS) expect(r.health.length).toBeGreaterThan(0);
  });

  test("isPillarReportKey accepts registered keys only", () => {
    expect(isPillarReportKey("filters")).toBe(true);
    expect(isPillarReportKey("nope")).toBe(false);
    expect(isPillarReportKey(undefined)).toBe(false);
  });

  test("every builder produces a valid report from empty input", () => {
    for (const { key } of PILLAR_REPORTS) {
      const report = buildPillarReport(key, {});
      expect(report.status).toBe("ok");
      expect(report.total).toBe(0);
      expect(report.columns.length).toBeGreaterThan(0);
    }
  });
});

describe("finalizeReport", () => {
  const columns = [{ key: "name", label: "Name", kind: "text" }];

  test("appends the findings column last and sorts flagged rows first, stably", () => {
    const report = finalizeReport("filters", {
      columns,
      rows: [
        { name: "a", findings: [] },
        { name: "b", findings: ["stale"] },
        { name: "c" },
        { name: "d", findings: ["orphaned-owner", "orphaned-owner", null] },
      ],
    });
    expect(report.columns.at(-1)).toEqual({ key: "findings", label: "Findings", kind: "list" });
    expect(report.rows.map((r) => r.name)).toEqual(["b", "d", "a", "c"]);
    expect(report.rows[1].findings).toEqual(["orphaned-owner"]);
    expect(report.rows[3].findings).toEqual([]);
    expect(report.flaggedCount).toBe(2);
    expect(report.healthPillars).toEqual(["filters"]);
  });

  test("opens the summary with the total and the flagged tile", () => {
    const report = finalizeReport("filters", { columns, rows: [{ name: "a", findings: ["stale"] }] });
    expect(report.summary.slice(0, 2)).toEqual([
      { label: "Filters", value: 1 },
      { label: "With findings", value: 1, tone: "warning" },
    ]);
  });

  test("truncates past the limit, keeps flagged rows, and says so", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => ({ name: `clean-${i}`, findings: [] })),
      { name: "flagged", findings: ["stale"] },
    ];
    const report = finalizeReport("filters", { columns, rows }, { limit: 3 });
    expect(report.truncated).toBe(true);
    expect(report.total).toBe(6);
    expect(report.rows).toHaveLength(3);
    expect(report.rows[0].name).toBe("flagged");
    expect(report.notes.at(-1)).toMatch(/first 3 of 6 filters/);
  });

  test("a report with no findings concept carries no findings column or tile", () => {
    const report = finalizeReport("changes", { columns, rows: [{ name: "x" }] });
    expect(report.columns.some((c) => c.key === "findings")).toBe(false);
    expect(report.summary.some((t) => t.label === "With findings")).toBe(false);
    expect(report.rows[0]).toEqual({ name: "x" });
  });

  test("normalizes an epoch refreshedAt to ISO", () => {
    const report = finalizeReport("filters", { refreshedAt: 0 + Date.UTC(2026, 8, 1), columns, rows: [] });
    expect(report.refreshedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  test("default limit is the exported cap", () => {
    const rows = Array.from({ length: REPORT_ROW_LIMIT + 1 }, (_, i) => ({ name: String(i) }));
    expect(finalizeReport("filters", { columns, rows }).rows).toHaveLength(REPORT_ROW_LIMIT);
  });

  test("rejects an unknown pillar", () => {
    expect(() => finalizeReport("nope", {})).toThrow(/Unknown pillar report/);
  });
});

describe("unavailableReport", () => {
  test("is explicit, never an empty ok report", () => {
    const report = unavailableReport("boards", "No board inventory.");
    expect(report).toMatchObject({ pillar: "boards", status: "unavailable", reason: "No board inventory.", rows: [], total: 0, healthPillars: ["boards"] });
  });

  test("falls back to a generic reason", () => {
    expect(unavailableReport("boards").reason).toMatch(/not been scanned/);
  });
});

describe("builders", () => {
  test("fields: maps governance findings to codes and counts never-populated custom fields", () => {
    const report = buildPillarReport("fields", {
      refreshedAt: "2026-09-01T00:00:00Z",
      fields: [
        { id: "customfield_1", name: "A", type: "select", isSystemField: false, configuredProjectCount: 3, activeProjectCount: 0, totalIssueCount: 0, findings: { reasons: [{ code: "orphaned" }] } },
        { id: "summary", name: "Summary", type: "string", isSystemField: true, totalIssueCount: 0, findings: { reasons: [] } },
      ],
    });
    expect(report.rows[0]).toMatchObject({ id: "customfield_1", configuredProjects: 3, findings: ["orphaned"] });
    expect(report.summary.find((t) => t.label === "Never populated").value).toBe(1);
  });

  test("projects: flags fell-off / never-adopted only for judgeable rows on fresh data", () => {
    const projects = [
      { projectId: "1", projectKey: "A", projectName: "Alpha", fieldCount: 4, uniqueIssueCount: 100 },
      { projectId: "2", projectKey: "B", projectName: "Beta", fieldCount: 1, uniqueIssueCount: 5 },
    ];
    const adoption = {
      available: true,
      dataStale: false,
      projects: [
        { projectId: "1", measured: true, oldEnough: true, fellOff: true, issuesPerDay: 1.234, score: 40 },
        { projectId: "2", measured: true, oldEnough: false, neverAdopted: true, issuesPerDay: 0, score: 5 },
      ],
    };
    const report = buildPillarReport("projects", { projects, adoption });
    const byKey = Object.fromEntries(report.rows.map((r) => [r.key, r]));
    expect(byKey.A.findings).toEqual(["fell-off"]);
    expect(byKey.A.issuesPerDay).toBe(1.23);
    expect(byKey.B.findings).toEqual([]);

    const stale = buildPillarReport("projects", { projects, adoption: { ...adoption, dataStale: true } });
    expect(stale.flaggedCount).toBe(0);
    expect(stale.notes[0]).toMatch(/suppressed/);

    expect(buildPillarReport("projects", { projects }).notes[0]).toMatch(/unmeasured/);
  });

  test("workflows: a scheme on no project is unused", () => {
    const report = buildPillarReport("workflows", {
      schemes: [
        { id: "1", name: "Used", projectCount: 2, issueTypeMapping: { 10: "wf" } },
        { id: "2", name: "Idle", projectCount: 0 },
      ],
      statusCount: 42,
    });
    expect(report.rows[0]).toMatchObject({ name: "Idle", findings: ["unused-scheme"] });
    expect(report.rows[1].mappedIssueTypes).toBe(1);
    expect(report.summary.find((t) => t.label === "Statuses").value).toBe(42);
  });

  test("issue types: orphaned globals and duplicate names are flagged; team-managed types are not orphans", () => {
    const report = buildPillarReport("issueTypes", {
      issueTypes: [
        { id: "1", name: "Bug", hierarchyLevel: 0 },
        { id: "2", name: "Bugs", hierarchyLevel: 0 },
        { id: "3", name: "Story", hierarchyLevel: 0, scopeProjectId: "100" },
        { id: "4", name: "Epic", hierarchyLevel: 1 },
        { id: "5", name: "Sub-task", subtask: true, hierarchyLevel: -1 },
      ],
      schemeItems: [{ schemeId: "s", issueTypeId: "1" }, { schemeId: "s", issueTypeId: "4" }, { schemeId: "s", issueTypeId: "5" }],
      usage: { measurement: "not-measured" },
    });
    const byId = Object.fromEntries(report.rows.map((r) => [r.id, r]));
    expect(byId["2"].findings).toContain("no-scheme");
    expect(byId["3"].findings).not.toContain("no-scheme");
    expect(byId["3"].scope).toBe("Team-managed");
    expect(byId["4"].level).toBe("Level 1");
    expect(byId["5"].level).toBe("Sub-task");
    expect(report.notes[0]).toMatch(/not fully measured/);
  });

  test("fieldConfigs: schemes and configurations, with the stored finding codes and projects through routes", () => {
    const report = buildPillarReport("fieldConfigs", {
      sourceLabel: "Field configurations (legacy)",
      summary: { unmeasured: 1 },
      schemes: [
        { id: "fcs:default", source: "field-configurations", name: "Default", isDefault: true, projectCount: 4, codes: [] },
        { id: "fcs:5", source: "field-configurations", sourceId: "5", name: "Old", projectCount: 0, codes: ["unused"] },
      ],
      configs: [
        { id: "fc:2", sourceId: "2", name: "Build", itemsRead: true, requiredCount: 3, totalFieldCount: 900, codes: ["required-hidden"], routes: [{ schemeId: "fcs:default" }] },
        { id: "fc:3", sourceId: "3", name: "Unread", itemsRead: false, codes: ["unused", "unmeasured"], routes: [] },
      ],
    });
    expect(report.total).toBe(4);
    const byId = Object.fromEntries(report.rows.map((r) => [r.id, r]));
    expect(byId["fc:2"]).toMatchObject({ kind: "Field configuration", projects: 4, required: 3, fields: 900, findings: ["required-hidden"] });
    // Unread is "not measured", never a finding and never zero.
    expect(byId["fc:3"]).toMatchObject({ required: null, fields: null, findings: ["unused"] });
    expect(report.summary).toEqual(expect.arrayContaining([{ label: "Model", value: "Field configurations (legacy)" }]));
    expect(report.notes[0]).toMatch(/1 could not be read/);
  });

  test("priorities: both lists in one report, near-duplicates flagged per list", () => {
    const report = buildPillarReport("priorities", {
      priorities: [{ id: "1", name: "High", isDefault: true }],
      resolutions: [{ id: "10", name: "Done" }, { id: "11", name: "done" }],
    });
    expect(report.total).toBe(3);
    expect(report.flaggedCount).toBe(2);
    expect(report.rows.filter((r) => r.findings.length).every((r) => r.kind === "Resolution")).toBe(true);
  });

  test("priorities: carries each value's issue count, null where unmeasured", () => {
    const report = buildPillarReport("priorities", {
      priorities: [{ id: "1", name: "High", issueCount: 31 }],
      resolutions: [{ id: "10", name: "Done", issueCount: null }],
    });
    expect(report.columns.some((c) => c.key === "issues")).toBe(true);
    expect(report.rows.find((r) => r.name === "High").issues).toBe(31);
    expect(report.rows.find((r) => r.name === "Done").issues).toBeNull();
  });

  test("people: a dormant licence is a finding, with the last activity date beside it", () => {
    const report = buildPillarReport("people", {
      users: [
        { displayName: "Idle", accountId: "a", active: true, lastActivityAt: "2025-01-01T00:00:00Z", dormant: true },
        { displayName: "Unseen", accountId: "b", active: true, lastActivityAt: null, dormant: null },
      ],
    });
    const byName = Object.fromEntries(report.rows.map((r) => [r.name, r]));
    expect(byName.Idle.findings).toEqual(["dormant-licence"]);
    expect(byName.Unseen.findings).toEqual([]);
    expect(report.columns.some((c) => c.key === "lastActivity")).toBe(true);
  });

  test("people: only inactive accounts that still own things are flagged", () => {
    const report = buildPillarReport("people", {
      users: [
        { accountId: "a", displayName: "Ann", active: true, ownedFilters: 3, applications: [{ name: "Jira" }], groups: [{}] },
        { accountId: "b", displayName: "Bob", active: false, ownedDashboards: 1, automationRefs: 2 },
        { accountId: "c", displayName: "Cy", active: false },
      ],
    });
    const byId = Object.fromEntries(report.rows.map((r) => [r.accountId, r]));
    expect(byId.a).toMatchObject({ products: ["Jira"], accessGroups: 1, findings: [] });
    expect(byId.b.findings).toEqual(["inactive-owner", "inactive-in-automation"]);
    expect(byId.c.findings).toEqual([]);
    expect(report.summary.find((t) => t.label === "Inactive").value).toBe(2);
  });

  test("assets: one row per object type with the structural findings", () => {
    const report = buildPillarReport("assets", {
      schemas: [{ id: "s1", name: "IT" }],
      objectTypes: [
        { id: "t1", schemaId: "s1", name: "Laptop" },
        { id: "t2", schemaId: "s1", name: "Orphan", parentId: "gone" },
      ],
      attributes: [
        { id: "a1", objectTypeId: "t1", name: "Serial" },
        { id: "a2", objectTypeId: "t1", name: "Owner", referenceObjectTypeId: "missing" },
      ],
      typeCounts: [],
    });
    const byId = Object.fromEntries(report.rows.map((r) => [r.id, r]));
    expect(byId.t1).toMatchObject({ schema: "IT", attributes: 2, objects: null, findings: ["broken-reference"] });
    expect(byId.t2.findings).toEqual(["no-custom-attributes", "missing-parent"]);
    expect(report.notes[0]).toMatch(/not been crawled/);

    const counted = buildPillarReport("assets", {
      schemas: [{ id: "s1", name: "IT" }],
      objectTypes: [{ id: "t1", schemaId: "s1", name: "Laptop" }],
      attributes: [{ id: "a1", objectTypeId: "t1", name: "Serial" }],
      typeCounts: [{ objectTypeId: "t1", objectCount: 0 }],
    });
    expect(counted.rows[0]).toMatchObject({ objects: 0, findings: ["no-objects"] });
  });

  test("access: every scheme type in one table; unassigned non-default schemes and actor-less roles flagged", () => {
    const report = buildPillarReport("access", {
      inventory: {
        permissions: {
          schemes: [{ id: "p1", name: "Default", isDefault: true, projectCount: 0 }, { id: "p2", name: "Spare", projectCount: 0 }],
          holders: [{ schemeId: "p1" }, { schemeId: "p1" }],
        },
        security: null,
        notifications: { schemes: [{ id: "n1", name: "N", projectCount: 4 }], holders: [] },
        roles: { schemes: [{ id: "r1", name: "Admins", projectCount: 0 }], holders: [] },
      },
    });
    const byId = Object.fromEntries(report.rows.map((r) => [r.id, r]));
    expect(byId.p1).toMatchObject({ type: "Permission scheme", grants: 2, findings: [] });
    expect(byId.p2.findings).toEqual(["unassigned-scheme"]);
    expect(byId.n1.findings).toEqual([]);
    expect(byId.r1.findings).toEqual(["no-actors"]);
  });

  test("screens: unreadable, empty and unreached; reachability caveated when unchecked", () => {
    const screens = [
      { screenId: "1", name: "Blank", tabCount: 1, fieldCount: 0, tabsResolved: "resolved" },
      { screenId: "2", name: "Locked", tabsResolved: "unresolved" },
      { screenId: "3", name: "Fine", tabCount: 2, fieldCount: 9, tabsResolved: "resolved" },
    ];
    const report = buildPillarReport("screens", { screens, unreachedIds: new Set(["3"]) });
    const byId = Object.fromEntries(report.rows.map((r) => [r.id, r]));
    expect(byId["1"].findings).toEqual(["empty"]);
    expect(byId["2"].findings).toEqual(["unreadable"]);
    expect(byId["3"].findings).toEqual(["unreached"]);
    expect(report.notes).toEqual([]);

    expect(buildPillarReport("screens", { screens, unreachedIds: null }).notes[0]).toMatch(/not checked/);
  });

  test("screens: projects reached through screen schemes, blank when the chain was not loaded", () => {
    const screens = [
      { screenId: "1", name: "A", tabCount: 1, fieldCount: 3, tabsResolved: "resolved" },
      { screenId: "2", name: "B", tabCount: 1, fieldCount: 3, tabsResolved: "resolved" },
    ];
    const withReach = buildPillarReport("screens", { screens, unreachedIds: new Set(), projectsByScreen: new Map([["1", 4]]) });
    expect(withReach.columns.map((c) => c.key)).toContain("projects");
    expect(withReach.rows.map((r) => [r.id, r.projects])).toEqual([["1", 4], ["2", 0]]);
    expect(buildPillarReport("screens", { screens, unreachedIds: new Set() }).rows[0].projects).toBeNull();
  });

  test("countScreenProjects: screen -> screen scheme -> issue type screen scheme -> distinct projects", () => {
    const reach = countScreenProjects({
      operations: [
        { schemeId: "ss1", operation: "default", screenId: "10" },
        { schemeId: "ss1", operation: "create", screenId: "11" },
        { schemeId: "ss2", operation: "default", screenId: "10" },
        { schemeId: "ss3", operation: "default", screenId: "12" }, // scheme no ITSS maps
        { schemeId: "ss1", operation: "edit", screenId: "13", dangling: true },
        { schemeId: "ss1", operation: "view", screenId: null },
      ],
      mappings: [
        { itssId: "i1", screenSchemeId: "ss1" },
        { itssId: "i2", screenSchemeId: "ss2" },
        { itssId: "i2", screenSchemeId: null },
      ],
      itssProjects: [
        { itssId: "i1", projectId: "P1" }, { itssId: "i1", projectId: "P2" },
        { itssId: "i2", projectId: "P2" }, { itssId: "i2", projectId: "P3" },
      ],
    });
    expect(Object.fromEntries(reach)).toEqual({ 10: 3, 11: 2, 12: 0 });
    expect(countScreenProjects().size).toBe(0);
  });

  test("filters: findings are the analysis codes", () => {
    const report = buildPillarReport("filters", {
      filters: [{ id: "1", name: "F", ownerName: "Ann", ownerActive: false, subscriptionCount: 2, findings: [{ code: "orphaned-owner" }] }],
    });
    expect(report.rows[0]).toMatchObject({ owner: "Ann", ownerActive: false, subscriptions: 2, findings: ["orphaned-owner"] });
  });

  test("dashboards: findings come from analyzeDashboard", () => {
    const report = buildPillarReport("dashboards", {
      dashboards: [{ id: "1", name: "Empty", gadgetCount: 0, owner: { accountId: "a", active: true }, shares: [], editShares: [] }],
    });
    expect(report.rows[0].findings).toContain("empty");
  });

  test("boards: unreadable config plus the per-board issue codes", () => {
    const report = buildPillarReport("boards", {
      boards: [
        { boardId: "1", name: "A", configReadable: false, issues: [] },
        { boardId: "2", name: "B", configReadable: true, columnCount: 3, issues: ["backing-filter-deleted"] },
      ],
    });
    const byId = Object.fromEntries(report.rows.map((r) => [r.id, r]));
    expect(byId["1"].findings).toEqual(["config-unreadable"]);
    expect(byId["2"]).toMatchObject({ columns: 3, findings: ["backing-filter-deleted"] });
  });

  test("automation: risks only for previewed rules, with a caveat when the preview is partial", () => {
    const report = buildPillarReport("automation", {
      rules: [{ id: 1, name: "R1", enabled: true }, { id: 2, name: "R2", enabled: false }],
      findingsPreview: [{ id: 1, r: [{ c: "plaintext-secret" }] }],
      findingsTotal: 5,
    });
    expect(report.rows[0]).toMatchObject({ id: 1, findings: ["plaintext-secret"] });
    expect(report.rows[1].findings).toEqual([]);
    expect(report.notes[0]).toMatch(/1 highest-severity rules of 5/);
    expect(report.summary.find((t) => t.label === "Enabled").value).toBe(1);
  });

  test("changes: one row per change with a kind breakdown and the window noted", () => {
    const report = buildPillarReport("changes", {
      changes: [
        { detectedAt: "2026-09-02", pillar: "fields", entityType: "field", entityId: "cf1", label: "Team", changeKind: "added" },
        { detectedAt: "2026-09-01", pillar: "fields", entityType: "field", entityId: "cf2", changeKind: "modified" },
      ],
      windowDays: 30,
    });
    expect(report.rows[1].entity).toBe("cf2");
    expect(report.summary.find((t) => t.label === "Added").value).toBe(1);
    expect(report.notes[0]).toMatch(/30 days/);
  });
});
