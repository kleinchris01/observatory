import {
  buildFieldJql,
  extractLatestFieldChange,
  getFieldNumericId,
  summarizeContexts,
} from "./transform.js";

describe("custom field transform helpers", () => {
  test("extracts the numeric custom field id", () => {
    expect(getFieldNumericId("customfield_12345")).toBe("12345");
    expect(getFieldNumericId("summary")).toBeNull();
  });

  test("builds the per-project JQL", () => {
    expect(buildFieldJql("customfield_12345", "DEMO")).toBe(
      "project = \"DEMO\" AND cf[12345] is not EMPTY"
    );
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
});
