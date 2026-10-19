import { vi, describe, test, expect, beforeEach } from "vitest";

// Storage for the issue type snapshot. Tested directly against a mocked Forge SQL, like
// store/screen.test.js: this is where an unscoped DELETE or a tuple-vs-column arity bug
// hides, and no test that mocks project-store wholesale would catch one.

vi.mock("@forge/sql", () => {
  const runner = { enqueue: () => runner, run: vi.fn().mockResolvedValue(undefined) };
  return {
    sql: {
      prepare: vi.fn().mockReturnValue({
        bindParams: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
      }),
      executeInTransaction: vi.fn().mockResolvedValue(undefined),
    },
    migrationRunner: runner,
  };
});

import { sql } from "@forge/sql";
import {
  replaceIssueTypeSnapshot,
  loadIssueTypes,
  loadIssueTypeSchemes,
  loadIssueTypeSchemeItems,
  loadIssueTypeSchemeProjects,
  loadIssueTypeSchemeForProject,
  loadIssueTypeGovernanceSummary,
  readIssueTypeSnapshotMeta,
  writeIssueTypeSnapshotMeta,
} from "./issuetype.js";

let issued = [];
let nextRows = [];

function harness() {
  issued = [];
  sql.prepare.mockImplementation((statement) => {
    const entry = { statement: String(statement), params: null };
    issued.push(entry);
    const stub = {
      bindParams: (...params) => {
        entry.params = params;
        return stub;
      },
      execute: () => Promise.resolve({ rows: nextRows }),
    };
    return stub;
  });
}

const statements = () => issued.map((e) => e.statement);
const boundParamsFor = (match) => issued.find((e) => e.statement.includes(match))?.params ?? null;
const mockRows = (rows) => {
  nextRows = rows;
};

beforeEach(() => {
  vi.clearAllMocks();
  nextRows = [];
  harness();
});

describe("replaceIssueTypeSnapshot", () => {
  const payload = {
    issueTypes: [
      { id: 10001, name: "Epic", description: "big", subtask: false, hierarchyLevel: 1 },
      { id: 10002, name: "Sub-task", subtask: true, hierarchyLevel: -1, scopeProjectId: "10000" },
    ],
    schemes: [{ id: 5, name: "Default", defaultIssueTypeId: 10001, isDefault: true, projectCount: 3 }],
    schemeItems: [
      { schemeId: 5, issueTypeId: 10001, itemIndex: 0 },
      { schemeId: 5, issueTypeId: 10002, itemIndex: 1 },
    ],
    schemeProjects: [{ schemeId: 5, projectId: "10000", projectKey: "OBS", projectName: "Observatory" }],
  };

  // The one that matters most: an unscoped DELETE in a multi-tenant Forge app destroys
  // another customer's data.
  test("every DELETE carries a scope_key predicate", async () => {
    await replaceIssueTypeSnapshot("scope-1", "v1", payload);

    const deletes = statements().filter((s) => s.trim().startsWith("DELETE"));
    expect(deletes.length).toBe(4);
    expect(deletes.every((s) => s.includes("WHERE scope_key = ?"))).toBe(true);
  });

  test("clears all four tables before writing", async () => {
    await replaceIssueTypeSnapshot("scope-1", "v1", payload);
    const deletes = statements()
      .filter((s) => s.trim().startsWith("DELETE"))
      .join(" ");

    for (const table of [
      "snapshot_issue_types",
      "snapshot_issue_type_schemes",
      "snapshot_issue_type_scheme_items",
      "snapshot_issue_type_scheme_projects",
    ]) {
      expect(deletes).toContain(table);
    }
  });

  // hierarchyLevel is Jira's signed integer. A `|| 0` anywhere on the write path turns a
  // sub-task's -1 into 0 and misfiles it as a base-level type.
  test("preserves a negative hierarchy level rather than zeroing it", async () => {
    await replaceIssueTypeSnapshot("scope-1", "v1", {
      issueTypes: [{ id: 10002, name: "Sub-task", subtask: true, hierarchyLevel: -1 }],
    });
    const params = boundParamsFor("INSERT INTO snapshot_issue_types");
    expect(params).toContain(-1);
    expect(params).toContain(1); // subtask flag
  });

  test("writes a project-scoped type's owning project, and null for a global one", async () => {
    await replaceIssueTypeSnapshot("scope-1", "v1", {
      issueTypes: [
        { id: 1, name: "Global", hierarchyLevel: 0 },
        { id: 2, name: "Team", hierarchyLevel: 0, scopeProjectId: "10000" },
      ],
    });
    const params = boundParamsFor("INSERT INTO snapshot_issue_types");
    expect(params).toContain(null);
    expect(params).toContain("10000");
  });

  test("issues no INSERT for a section with nothing in it", async () => {
    await replaceIssueTypeSnapshot("scope-1", "v1", {});
    expect(statements().filter((s) => s.includes("INSERT"))).toHaveLength(0);
  });

  // The arity guard store/screen.test.js added after both ITSS inserts shipped with a
  // five-placeholder tuple against six columns. Same shape of bug, same mechanical check.
  test("every INSERT has one placeholder per column and per bound param", async () => {
    await replaceIssueTypeSnapshot("scope-1", "v1", {
      issueTypes: [{ id: 1 }, { id: 2 }],
      schemes: [{ id: 5 }, { id: 6 }],
      schemeItems: [
        { schemeId: 5, issueTypeId: 1, itemIndex: 0 },
        { schemeId: 5, issueTypeId: 2, itemIndex: 1 },
      ],
      schemeProjects: [
        { schemeId: 5, projectId: "10000" },
        { schemeId: 6, projectId: "10001" },
      ],
    });

    const inserts = issued.filter((e) => e.statement.includes("INSERT INTO"));
    expect(inserts.length).toBe(4);

    for (const { statement, params } of inserts) {
      const [columnPart, valuesPart] = statement.split(/\bVALUES\b/);
      const table = statement.match(/INSERT INTO (\w+)/)[1];
      const columns = columnPart.match(/\(([^)]*)\)/)[1].split(",").length;
      const placeholders = (valuesPart.match(/\?/g) || []).length;

      expect(placeholders, `${table}: ${placeholders} placeholders for ${params.length} bound params`).toBe(
        params.length,
      );
      expect(
        placeholders % columns,
        `${table}: ${placeholders} placeholders is not a multiple of ${columns} columns`,
      ).toBe(0);
    }
  });
});

describe("reads", () => {
  test("maps an issue type row and keeps its tri-state scope", async () => {
    mockRows([
      { issue_type_id: "1", name: "Epic", description: "d", subtask: 0, hierarchy_level: 1, scope_project_id: null },
      { issue_type_id: "2", name: "Bug", description: null, subtask: 0, hierarchy_level: 0, scope_project_id: "10000" },
    ]);

    const rows = await loadIssueTypes("scope-1", "v1");

    expect(rows[0]).toMatchObject({ id: "1", name: "Epic", subtask: false, hierarchyLevel: 1, scopeProjectId: null });
    expect(rows[1]).toMatchObject({ scopeProjectId: "10000" });
  });

  test("orders issue types by hierarchy level, highest first", async () => {
    await loadIssueTypes("scope-1", "v1");
    expect(statements().join(" ")).toContain("ORDER BY hierarchy_level DESC");
  });

  test("maps a scheme row with its default type and reach", async () => {
    mockRows([
      {
        scheme_id: "5",
        name: "Default",
        description: "",
        default_issue_type_id: "1",
        is_default: 1,
        project_count: 42,
      },
    ]);
    expect((await loadIssueTypeSchemes("scope-1", "v1"))[0]).toMatchObject({
      schemeId: "5",
      isDefault: true,
      defaultIssueTypeId: "1",
      projectCount: 42,
    });
  });

  test("returns scheme membership carrying its order index", async () => {
    mockRows([
      { scheme_id: "5", issue_type_id: "1", item_index: 0 },
      { scheme_id: "5", issue_type_id: "2", item_index: 1 },
    ]);
    const items = await loadIssueTypeSchemeItems("scope-1", "v1");
    expect(items).toEqual([
      { schemeId: "5", issueTypeId: "1", itemIndex: 0 },
      { schemeId: "5", issueTypeId: "2", itemIndex: 1 },
    ]);
  });

  test("maps scheme project assignments", async () => {
    mockRows([{ scheme_id: "5", project_id: "10000", project_key: "OBS", project_name: "Observatory" }]);
    expect((await loadIssueTypeSchemeProjects("scope-1", "v1"))[0]).toMatchObject({ projectKey: "OBS" });
  });

  test("returns null for a project no scheme is assigned to", async () => {
    mockRows([]);
    expect(await loadIssueTypeSchemeForProject("scope-1", "v1", "99999")).toBeNull();
  });

  test("assembles one scheme with its ordered types for a project", async () => {
    mockRows([
      {
        scheme_id: "5",
        name: "Default",
        description: "",
        default_issue_type_id: "1",
        is_default: 1,
        issue_type_id: "1",
        type_name: "Epic",
        subtask: 0,
        hierarchy_level: 1,
        item_index: 0,
      },
      {
        scheme_id: "5",
        name: "Default",
        description: "",
        default_issue_type_id: "1",
        is_default: 1,
        issue_type_id: "2",
        type_name: "Story",
        subtask: 0,
        hierarchy_level: 0,
        item_index: 1,
      },
    ]);

    const result = await loadIssueTypeSchemeForProject("scope-1", "v1", "10000");
    expect(result).toMatchObject({ schemeId: "5", isDefault: true, defaultIssueTypeId: "1" });
    expect(result.issueTypes.map((t) => t.name)).toEqual(["Epic", "Story"]);
  });
});

describe("loadIssueTypeGovernanceSummary", () => {
  test("scopes and versions every aggregate it runs", async () => {
    await loadIssueTypeGovernanceSummary("scope-1", "v1");

    const aggregates = issued.filter((e) => e.statement.includes("COUNT("));
    expect(aggregates.length).toBe(3);
    for (const entry of aggregates) {
      expect(entry.statement).toContain("scope_key = ?");
      expect(entry.statement).toContain("version = ?");
      expect(entry.params.slice(0, 2)).toEqual(["scope-1", "v1"]);
    }
  });

  // SUM() over no rows returns NULL, not 0 -- and NULL reaching a health rate makes the
  // dimension unavailable rather than clean.
  test("maps every aggregate to a number even when a table is empty", async () => {
    mockRows([{ total: 0, subtasks: null, project_scoped: null, hierarchy_levels: null, unused: null, orphan: null }]);

    const summary = await loadIssueTypeGovernanceSummary("scope-1", "v1");
    for (const [key, value] of Object.entries(summary)) {
      expect(Number.isFinite(value), `${key} is ${value}`).toBe(true);
    }
  });

  test("counts orphan types with an anti-join against scheme membership", async () => {
    await loadIssueTypeGovernanceSummary("scope-1", "v1");
    const statement = statements().find((s) => s.includes("orphan"));
    expect(statement).toContain("NOT EXISTS");
    expect(statement).toContain("snapshot_issue_type_scheme_items");
  });
});

describe("meta", () => {
  test("returns null when no build has ever run", async () => {
    mockRows([]);
    expect(await readIssueTypeSnapshotMeta("scope-1")).toBeNull();
  });

  test("maps a meta row", async () => {
    mockRows([
      { state: "ready", version: "v1", total_types: 42, total_schemes: 7, refreshed_at: "t", last_error: null },
    ]);
    expect(await readIssueTypeSnapshotMeta("scope-1")).toMatchObject({
      state: "ready",
      version: "v1",
      totalTypes: 42,
      totalSchemes: 7,
    });
  });

  // Merge-patch, so a caller setting one field cannot silently zero the counts another wrote.
  test("patches over the current row rather than replacing it", async () => {
    mockRows([{ state: "ready", version: "v1", total_types: 42, total_schemes: 7 }]);

    await writeIssueTypeSnapshotMeta("scope-1", { state: "building" });
    const params = boundParamsFor("INSERT INTO issue_type_snapshot_meta");

    expect(params).toContain("building");
    expect(params).toContain("v1");
    expect(params).toContain(42);
  });

  test("defaults to idle when there is nothing to merge over", async () => {
    mockRows([]);
    await writeIssueTypeSnapshotMeta("scope-1", {});
    expect(boundParamsFor("INSERT INTO issue_type_snapshot_meta")).toContain("idle");
  });
});
