import {
  buildFieldJql,
  buildOverallFieldJql,
  buildProjectUsageRecord,
  extractLatestFieldChange,
  getFieldNumericId,
  getFieldTypeLabel,
  summarizeContexts,
} from "./transform.js";

describe("custom field transform helpers", () => {
  test("extracts the numeric custom field id", () => {
    expect(getFieldNumericId("customfield_12345")).toBe("12345");
    expect(getFieldNumericId("summary")).toBeNull();
  });

  test("returns null for null/undefined field id", () => {
    expect(getFieldNumericId(null)).toBeNull();
    expect(getFieldNumericId(undefined)).toBeNull();
    expect(getFieldNumericId("")).toBeNull();
  });

  test("builds the per-project JQL", () => {
    expect(buildFieldJql("customfield_12345", "DEMO")).toBe('project = "DEMO" AND cf[12345] is not EMPTY');
  });

  test("buildFieldJql uses bare field id for non-custom fields", () => {
    expect(buildFieldJql("summary", "DEMO")).toBe('project = "DEMO" AND summary is not EMPTY');
  });

  test("buildFieldJql escapes double quotes in project key", () => {
    expect(buildFieldJql("customfield_1", 'A"B')).toContain('\\"');
  });

  test("summarizes contexts with project and issue type mappings", () => {
    const contexts = [
      { id: "10", name: "Global Context", isGlobalContext: true, isAnyIssueType: true },
      { id: "11", name: "Delivery", isGlobalContext: false, isAnyIssueType: false },
    ];
    const projectMappings = [
      { contextId: "11", projectId: "10001" },
      { contextId: "11", projectId: "10002" },
    ];
    const issueTypeMappings = [{ contextId: "11", issueTypeId: "10010" }];
    const projectLookup = new Map([
      ["10001", { id: "10001", key: "OPS", name: "Operations" }],
      ["10002", { id: "10002", key: "PLAT", name: "Platform" }],
    ]);

    const summary = summarizeContexts({
      contexts,
      projectMappings,
      issueTypeMappings,
      projectLookup,
    });

    expect(summary).toHaveLength(2);
    expect(summary[0]).toMatchObject({
      id: "10",
      isGlobalContext: true,
      isAnyIssueType: true,
    });
    expect(summary[1]).toMatchObject({
      id: "11",
      projectCount: 2,
      issueTypeCount: 1,
    });
    expect(summary[1].projects.map((project) => project.key)).toEqual(["OPS", "PLAT"]);
  });

  test("buildOverallFieldJql for a custom field", () => {
    expect(buildOverallFieldJql("customfield_99")).toBe("cf[99] is not EMPTY");
  });

  test("buildOverallFieldJql for a system field", () => {
    expect(buildOverallFieldJql("summary")).toBe("summary is not EMPTY");
  });

  test("getFieldTypeLabel extracts suffix from customType", () => {
    const field = { schema: { custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield" } };
    expect(getFieldTypeLabel(field)).toBe("textfield");
  });

  test("getFieldTypeLabel uses systemKey capitalized when no customType", () => {
    const field = { schema: { system: "summary" } };
    expect(getFieldTypeLabel(field)).toBe("Summary");
  });

  test("getFieldTypeLabel falls back to primitiveType", () => {
    const field = { schema: { type: "number" } };
    expect(getFieldTypeLabel(field)).toBe("number");
  });

  test("getFieldTypeLabel returns 'unknown' for empty schema", () => {
    expect(getFieldTypeLabel({})).toBe("unknown");
    expect(getFieldTypeLabel()).toBe("unknown");
  });

  test("getFieldTypeLabel replaces hyphens with spaces in customType suffix", () => {
    const field = { schema: { custom: "com.example:multi-select" } };
    expect(getFieldTypeLabel(field)).toBe("multi select");
  });

  test("buildProjectUsageRecord populates all fields", () => {
    const project = { id: "10001", key: "OPS", name: "Operations" };
    const record = buildProjectUsageRecord({
      project,
      fieldId: "customfield_12345",
      issueCount: 42,
      latestFieldChangeAt: "2026-01-01T00:00:00Z",
      latestIssue: { key: "OPS-5", updated: "2026-01-02T00:00:00Z" },
    });
    expect(record.projectId).toBe("10001");
    expect(record.projectKey).toBe("OPS");
    expect(record.projectName).toBe("Operations");
    expect(record.issueCount).toBe(42);
    expect(record.jql).toContain("OPS");
    expect(record.latestFieldChangeAt).toBe("2026-01-01T00:00:00Z");
    expect(record.latestIssueKey).toBe("OPS-5");
    expect(record.latestIssueUpdatedAt).toBe("2026-01-02T00:00:00Z");
  });

  test("buildProjectUsageRecord falls back to latestIssue.updated when no latestFieldChangeAt", () => {
    const project = { id: "1", key: "AA", name: "Alpha" };
    const record = buildProjectUsageRecord({
      project,
      fieldId: "customfield_1",
      issueCount: 0,
      latestFieldChangeAt: null,
      latestIssue: { key: "AA-1", updated: "2026-03-01T00:00:00Z" },
    });
    expect(record.latestFieldChangeAt).toBe("2026-03-01T00:00:00Z");
  });

  test("buildProjectUsageRecord handles no latestIssue", () => {
    const project = { id: "1", key: "AA", name: "Alpha" };
    const record = buildProjectUsageRecord({
      project,
      fieldId: "customfield_1",
      issueCount: 0,
      latestFieldChangeAt: null,
      latestIssue: null,
    });
    expect(record.latestIssueKey).toBeNull();
    expect(record.latestIssueUpdatedAt).toBeNull();
  });

  test("finds the latest field change timestamp in nested changelog payloads", () => {
    const payload = {
      issueChangeLogs: [
        {
          issueId: "10000",
          changeHistories: [
            {
              created: "2026-04-20T09:30:00.000Z",
              items: [{ fieldId: "customfield_12345" }],
            },
          ],
        },
        {
          issueId: "10001",
          changeHistories: [
            {
              created: "2026-04-24T16:45:00.000Z",
              items: [{ fieldId: "12345" }],
            },
          ],
        },
      ],
    };

    expect(extractLatestFieldChange(payload, "customfield_12345")).toBe("2026-04-24T16:45:00.000Z");
  });

  test("extractLatestFieldChange returns null when field not present in changelog", () => {
    const payload = {
      issueChangeLogs: [
        {
          issueId: "1",
          changeHistories: [{ created: "2026-01-01T00:00:00Z", items: [{ fieldId: "customfield_99" }] }],
        },
      ],
    };
    expect(extractLatestFieldChange(payload, "customfield_12345")).toBeNull();
  });

  test("extractLatestFieldChange returns null for empty payload", () => {
    expect(extractLatestFieldChange(null, "customfield_1")).toBeNull();
    expect(extractLatestFieldChange({}, "customfield_1")).toBeNull();
  });

  test("summarizeContexts places global contexts before named contexts", () => {
    const contexts = [
      { id: "2", name: "Specific", isGlobalContext: false, isAnyIssueType: false },
      { id: "1", name: "Global", isGlobalContext: true, isAnyIssueType: true },
    ];
    const summary = summarizeContexts({
      contexts,
      projectMappings: [],
      issueTypeMappings: [],
      projectLookup: new Map(),
    });
    expect(summary[0].isGlobalContext).toBe(true);
  });

  test("summarizeContexts uses UNKNOWN for unmapped project IDs", () => {
    const contexts = [{ id: "1", name: "Ctx", isGlobalContext: false, isAnyIssueType: false }];
    const projectMappings = [{ contextId: "1", projectId: "99999" }];
    const summary = summarizeContexts({ contexts, projectMappings, issueTypeMappings: [], projectLookup: new Map() });
    expect(summary[0].projects[0].key).toBe("UNKNOWN");
  });
});
