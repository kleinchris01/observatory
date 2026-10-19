import { describe, test, expect } from "vitest";
import {
  findDuplicateTypeNames,
  findOrphanTypes,
  analyzeSchemeHierarchy,
  summarizeIssueTypeInsights,
  summarizeIssueTypeHealth,
} from "./issuetype-insights.js";

const type = (id, name, over = {}) => ({
  id: String(id),
  name,
  subtask: false,
  hierarchyLevel: 0,
  scopeProjectId: null,
  ...over,
});

describe("findDuplicateTypeNames", () => {
  test("identical names are one group, whatever their scope", () => {
    const groups = findDuplicateTypeNames([
      type(1, "Task"),
      type(2, "Task", { scopeProjectId: "10001" }),
      type(3, "Task", { scopeProjectId: "10002" }),
      type(4, "Bug"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "identical", count: 3 });
  });

  test("spacing and punctuation collapse", () => {
    const groups = findDuplicateTypeNames([type(1, "Sub-task"), type(2, "Sub task"), type(3, "subtask")]);
    expect(groups[0]).toMatchObject({ kind: "spacing", count: 3 });
  });

  test("Bug and Defect are not flagged (different words), but a one-char spelling slip is", () => {
    const notDupes = findDuplicateTypeNames([type(1, "Bug"), type(2, "Defect")]);
    expect(notDupes).toHaveLength(0);

    const dupes = findDuplicateTypeNames([type(1, "Improvement"), type(2, "Improvment")]);
    expect(dupes[0]).toMatchObject({ kind: "spelling" });
  });

  test("a deliberate numbered series is not a duplicate", () => {
    expect(findDuplicateTypeNames([type(1, "Approval CP3"), type(2, "Approval CP4")])).toHaveLength(0);
  });
});

describe("findOrphanTypes", () => {
  test("a type on no scheme item is an orphan; one that is allowed is not", () => {
    const types = [type(1, "Story"), type(2, "Spike"), type(3, "Old Bug")];
    const schemeItems = [
      { schemeId: "5", issueTypeId: "1" },
      { schemeId: "5", issueTypeId: "2" },
    ];
    const orphans = findOrphanTypes(types, schemeItems);
    expect(orphans.map((o) => o.id)).toEqual(["3"]);
  });
});

describe("analyzeSchemeHierarchy", () => {
  const members = (arr) => new Map([["5", arr]]);

  test("flags a scheme with only sub-task types", () => {
    const [scheme] = analyzeSchemeHierarchy(
      [{ schemeId: "5", name: "Subs only", defaultIssueTypeId: "9" }],
      members([
        { id: "9", subtask: true },
        { id: "10", subtask: true },
      ]),
    );
    expect(scheme.flags.map((f) => f.code)).toContain("subtasks-only");
  });

  test("flags a default type that is a sub-task, or not in the scheme", () => {
    const [subDefault] = analyzeSchemeHierarchy(
      [{ schemeId: "5", name: "A", defaultIssueTypeId: "9" }],
      members([
        { id: "1", subtask: false },
        { id: "9", subtask: true },
      ]),
    );
    expect(subDefault.flags.map((f) => f.code)).toContain("default-is-subtask");

    const [notInScheme] = analyzeSchemeHierarchy(
      [{ schemeId: "5", name: "B", defaultIssueTypeId: "99" }],
      members([{ id: "1", subtask: false }]),
    );
    expect(notInScheme.flags.map((f) => f.code)).toContain("default-not-in-scheme");
  });

  test("a normal scheme carries no flags", () => {
    const [ok] = analyzeSchemeHierarchy(
      [{ schemeId: "5", name: "Normal", defaultIssueTypeId: "1" }],
      members([
        { id: "1", subtask: false },
        { id: "2", subtask: true },
      ]),
    );
    expect(ok.flags).toEqual([]);
  });
});

describe("summarizeIssueTypeInsights", () => {
  test("rolls the four scored counts up, tri-state on an empty catalog", () => {
    expect(summarizeIssueTypeInsights({ types: [] }).available).toBe(false);

    const summary = summarizeIssueTypeInsights({
      types: [type(1, "Story"), type(2, "Story"), type(3, "Orphan"), type(4, "Sub", { subtask: true })],
      schemes: [
        { schemeId: "5", name: "Used", defaultIssueTypeId: "1", projectCount: 3 },
        { schemeId: "6", name: "Unused", defaultIssueTypeId: "4", projectCount: 0 },
      ],
      schemeItems: [
        { schemeId: "5", issueTypeId: "1" },
        { schemeId: "5", issueTypeId: "2" },
        { schemeId: "6", issueTypeId: "4" },
      ],
    });

    expect(summary).toMatchObject({
      available: true,
      totalTypes: 4,
      totalSchemes: 2,
      orphanTypeCount: 1, // "Orphan" (id 3)
      unusedSchemeCount: 1, // scheme 6
      reducibleTypeCount: 1, // the two "Story" collapse to one
      duplicateTypeGroupCount: 1,
      subtasksOnlySchemeCount: 1, // scheme 6 allows only the sub-task
    });
  });
});

describe("summarizeIssueTypeHealth", () => {
  test("passes only the scored counts, tri-state on unavailable", () => {
    expect(summarizeIssueTypeHealth({ available: false })).toEqual({ available: false });
    const h = summarizeIssueTypeHealth({
      available: true,
      totalTypes: 10,
      totalSchemes: 4,
      orphanTypeCount: 1,
      unusedSchemeCount: 0,
      reducibleTypeCount: 2,
      duplicateTypeGroupCount: 1,
      hierarchyFlaggedSchemeCount: 0,
    });
    expect(h).toMatchObject({ available: true, totalTypes: 10, orphanTypeCount: 1, reducibleTypeCount: 2 });
    expect(h).not.toHaveProperty("orphanTypes");
  });
});

describe("summarizeIssueTypeInsights listLimit", () => {
  const schemes = Array.from({ length: 30 }, (_, i) => ({ schemeId: `s${i}`, name: `S${i}`, projectCount: 0 }));

  it("trims for the tab by default and lists everything for remediation", () => {
    expect(summarizeIssueTypeInsights({ types: [{ id: "1", name: "Bug" }], schemes }).unusedSchemes).toHaveLength(25);
    const full = summarizeIssueTypeInsights({ types: [{ id: "1", name: "Bug" }], schemes, listLimit: Infinity });
    expect(full.unusedSchemes).toHaveLength(30);
    expect(full.unusedSchemeCount).toBe(30);
  });
});
