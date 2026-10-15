import { describe, test, expect } from "vitest";
import {
  extractJqlFields,
  extractJqlProjects,
  extractJqlStatuses,
  extractJqlIssueTypes,
  extractJqlReferences,
  normalizeJql,
  scanJql,
} from "./jql-refs.js";

// This is the join that makes filters a pillar rather than a list: a saved filter searching
// on a field is the same "do not delete this" evidence an automation rule writing it already
// gives. So the thing worth pinning is not that it finds references -- it is that it does
// not INVENT them, because a field wrongly reported as in use is a cleanup nobody performs.

describe("extractJqlFields", () => {
  test("finds bare, quoted and custom-field operands", () => {
    expect(extractJqlFields('assignee = bob AND "Story Points" >= 5 AND cf[10001] IS NOT EMPTY')).toEqual([
      "assignee",
      "Story Points",
      "cf[10001]",
    ]);
  });

  test("does not mistake keywords for fields", () => {
    // Without this, every "AND status = Open" contributes "AND" and every sort contributes
    // "BY".
    const fields = extractJqlFields("project = X AND status = Open OR priority = High ORDER BY created");
    expect(fields).toEqual(["project", "status", "priority", "created"]);
  });

  test("counts a field named only in ORDER BY", () => {
    // Deleting it reorders every result with no error, which is the harder failure to notice.
    expect(extractJqlFields('issuetype = Bug ORDER BY "Landed Piece Price" ASC, priority DESC')).toEqual([
      "issuetype",
      "Landed Piece Price",
      "priority",
    ]);
  });

  test("does not treat a JQL function as a field", () => {
    expect(extractJqlFields("assignee = currentUser() AND sprint in openSprints()")).toEqual(["assignee", "sprint"]);
  });

  test("collapses a field referenced twice", () => {
    expect(extractJqlFields("status = Open OR status = Reopened")).toEqual(["status"]);
  });

  test("survives empty and malformed input", () => {
    for (const input of ["", null, undefined, "((((", "= = =", "ORDER BY"]) {
      expect(() => extractJqlFields(input)).not.toThrow();
    }
    expect(extractJqlFields("")).toEqual([]);
  });
});

// The defect that made a tokenizer necessary. Both sides of an operator can be quoted, and
// position is the only thing that distinguishes them -- so matching on shape alone got one
// of the two wrong whichever way it was tuned.
describe("a quoted FIELD and a quoted VALUE are not the same thing", () => {
  test("a quoted field is a field", () => {
    expect(extractJqlFields('"Story Points" >= 5')).toEqual(["Story Points"]);
  });

  test("a quoted value is not a field, even when it contains JQL", () => {
    // Searching for the text "status = Done" must not report a `status` dependency, or a
    // status nobody uses reads as held open by a filter that merely mentions it.
    const refs = extractJqlReferences('summary ~ "status = Done" AND resolution = Unresolved');
    expect(refs.fields).toEqual(["summary", "resolution"]);
    expect(refs.statuses).toEqual([]);
  });

  test("a value containing an escaped quote does not end the value early", () => {
    const refs = extractJqlReferences('summary ~ "the \\"thing\\"" AND status = Open');
    expect(refs.fields).toEqual(["summary", "status"]);
    expect(refs.statuses).toEqual(["Open"]);
  });
});

describe("extractJqlStatuses", () => {
  test("keeps every value in an IN list, not just the first", () => {
    expect(extractJqlStatuses('status in ("In Progress", "On Ice", Done)')).toEqual(["In Progress", "On Ice", "Done"]);
  });

  test("reads a status behind a multi-word operator", () => {
    expect(extractJqlStatuses("status WAS NOT IN (Done, Closed)")).toEqual(["Done", "Closed"]);
  });

  test("does not take another field's values", () => {
    expect(extractJqlStatuses('status = Open AND resolution = "Won\'t Do"')).toEqual(["Open"]);
  });

  test("ignores EMPTY, which is the absence of a value", () => {
    expect(extractJqlStatuses("status is EMPTY")).toEqual([]);
  });
});

describe("extractJqlProjects", () => {
  test("reads a single project and an IN list", () => {
    expect(extractJqlProjects("project = ADVEV")).toEqual(["ADVEV"]);
    expect(extractJqlProjects("project in (ABC, DEF)")).toEqual(["ABC", "DEF"]);
  });

  test("reads an exclusion, because it still names the project", () => {
    // A filter excluding a project breaks the same way when that project is archived.
    expect(extractJqlProjects("project not in (X, Y)")).toEqual(["X", "Y"]);
  });
});

describe("scanJql", () => {
  test("pairs each value with the field it belongs to", () => {
    const { pairs } = scanJql("project = ADVEV AND status in (Open, Done)");
    expect(pairs).toEqual([
      { field: "project", value: "ADVEV" },
      { field: "status", value: "Open" },
      { field: "status", value: "Done" },
    ]);
  });

  test("closes a list so the next term is a field again", () => {
    const { fields } = scanJql("status in (Open, Done) AND priority = High");
    expect(fields).toEqual(["status", "priority"]);
  });
});

describe("normalizeJql", () => {
  test("collapses the ways two people write the same search", () => {
    expect(normalizeJql("project = ADVEV AND status = Done")).toBe(normalizeJql('project="ADVEV"  and  STATUS = done'));
  });

  test("does not claim two different searches are the same", () => {
    expect(normalizeJql("project = A AND status = Done")).not.toBe(normalizeJql("project = B AND status = Done"));
  });

  // Reordering an AND chain is safe, but proving that in general means implementing the
  // grammar. A duplicate report that is narrow and always right beats one that is broad and
  // occasionally wrong.
  test("does not attempt to reorder clauses", () => {
    expect(normalizeJql("a = 1 AND b = 2")).not.toBe(normalizeJql("b = 2 AND a = 1"));
  });
});

describe("extractJqlReferences", () => {
  test("returns the four kinds a filter can depend on", () => {
    const refs = extractJqlReferences(
      'project = ADVEV AND issuetype = Bug AND status IN ("In Progress", Done) AND "Story Points" >= 5 ORDER BY created DESC',
    );
    expect(refs).toEqual({
      fields: ["project", "issuetype", "status", "Story Points", "created"],
      projects: ["ADVEV"],
      statuses: ["In Progress", "Done"],
      issueTypes: ["Bug"],
    });
  });

  test("reads the `type` shorthand as well as `issuetype`", () => {
    expect(extractJqlReferences('type IN (Story, "Sub-task")').issueTypes).toEqual(["Story", "Sub-task"]);
  });

  test("returns empty lists rather than throwing on nothing", () => {
    expect(extractJqlReferences(null)).toEqual({ fields: [], projects: [], statuses: [], issueTypes: [] });
  });
});

describe("extractJqlIssueTypes", () => {
  test("pulls issue type names, from either alias, deduped", () => {
    expect(extractJqlIssueTypes("issuetype = Bug OR type = bug OR issuetype IN (Story, Epic)").sort()).toEqual([
      "Bug",
      "Epic",
      "Story",
    ]);
  });

  test("ignores a quoted value that merely contains the word", () => {
    expect(extractJqlIssueTypes('summary ~ "issuetype = Bug"')).toEqual([]);
  });
});
