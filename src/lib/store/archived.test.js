import { vi, describe, test, expect, beforeEach } from "vitest";

// Archived projects (store/archived.js) against a mocked Forge SQL: an unscoped DELETE, a
// refused read that wipes the list, or a copy that misses the live rows would hide here.

vi.mock("@forge/sql", () => {
  const runner = { enqueue: () => runner, run: vi.fn().mockResolvedValue(undefined) };
  return {
    sql: {
      prepare: vi
        .fn()
        .mockReturnValue({ bindParams: vi.fn().mockReturnThis(), execute: vi.fn().mockResolvedValue({ rows: [] }) }),
    },
    migrationRunner: runner,
  };
});

import { sql } from "@forge/sql";
import {
  replaceArchivedProjects,
  loadArchivedProjects,
  preserveArchivedFieldUsage,
  pruneRestoredArchivedUsage,
  loadArchivedFieldUsage,
} from "./archived.js";

let issued = [];
let rowsFor = () => [];
beforeEach(() => {
  vi.clearAllMocks();
  issued = [];
  rowsFor = () => [];
  sql.prepare.mockImplementation((statement) => {
    const entry = { statement: String(statement), params: null };
    issued.push(entry);
    const stub = {
      bindParams: (...params) => {
        entry.params = params;
        return stub;
      },
      execute: () => Promise.resolve({ rows: rowsFor(entry.statement) }),
    };
    return stub;
  });
});
const find = (re) => issued.find((e) => re.test(e.statement));

describe("replaceArchivedProjects", () => {
  test("replaces this site's list and marks it readable", async () => {
    await replaceArchivedProjects(
      "inst",
      [{ id: "20001", key: "TT", name: "Talent Tracker", archivedAt: "2026-06-01", issueCount: 2340 }],
      { now: new Date("2026-10-07T00:00:00Z") },
    );
    expect(find(/DELETE FROM archived_projects WHERE scope_key = \?/).params).toEqual(["inst"]);
    expect(find(/INSERT INTO archived_projects \(/).params).toEqual([
      "inst",
      "20001",
      "TT",
      "Talent Tracker",
      "2026-06-01",
      2340,
      "2026-10-07T00:00:00.000Z",
    ]);
    expect(find(/INSERT INTO archived_projects_meta/).params).toEqual(["inst", "2026-10-07T00:00:00.000Z", 1, null]);
  });

  test("a refused read keeps the last list and records why", async () => {
    await replaceArchivedProjects("inst", [], { available: false, error: "403 Forbidden" });
    expect(find(/DELETE FROM archived_projects/)).toBeUndefined();
    expect(find(/INSERT INTO archived_projects_meta/).params.slice(2)).toEqual([0, "403 Forbidden"]);
  });
});

describe("loadArchivedProjects", () => {
  test("null before it has ever been read", async () => {
    expect(await loadArchivedProjects("inst")).toBeNull();
  });

  test("the list with its readability", async () => {
    rowsFor = (st) =>
      st.includes("archived_projects_meta")
        ? [{ checked_at: "2026-10-07", available: 1, last_error: null }]
        : [
            {
              project_id: "20001",
              project_key: "TT",
              project_name: "Talent Tracker",
              archived_at: "2026-06-01",
              issue_count: "2340",
            },
          ];
    expect(await loadArchivedProjects("inst")).toEqual({
      checkedAt: "2026-10-07",
      available: true,
      error: null,
      projects: [{ id: "20001", key: "TT", name: "Talent Tracker", archivedAt: "2026-06-01", issueCount: 2340 }],
    });
  });
});

describe("archived field usage", () => {
  test("copies the archived projects' live counts out before the crawl deletes them", async () => {
    rowsFor = (st) =>
      st.includes("FROM snapshot_project_usage")
        ? [{ field_id: "customfield_9", project_id: "20001", project_key: "TT", issue_count: "40" }]
        : [];
    const r = await preserveArchivedFieldUsage("inst", "v1", ["20001"], new Date("2026-10-07T00:00:00Z"));
    expect(r).toEqual({ copied: 1 });
    expect(find(/FROM snapshot_project_usage/).params).toEqual(["inst", "v1", "20001"]);
    expect(find(/INSERT INTO field_archived_usage/).params).toEqual([
      "inst",
      "customfield_9",
      "20001",
      "TT",
      40,
      "2026-10-07T00:00:00.000Z",
    ]);
  });

  test("restored projects lose their saved counts; with nothing archived, all go", async () => {
    await pruneRestoredArchivedUsage("inst", ["20001"]);
    expect(find(/DELETE FROM field_archived_usage WHERE scope_key = \? AND project_id NOT IN/).params).toEqual([
      "inst",
      "20001",
    ]);
    issued = [];
    await pruneRestoredArchivedUsage("inst", []);
    expect(find(/DELETE FROM field_archived_usage WHERE scope_key = \?$/m).params).toEqual(["inst"]);
  });

  test("loads per field", async () => {
    rowsFor = () => [
      {
        field_id: "customfield_9",
        project_id: "20001",
        project_key: "TT",
        issue_count: "40",
        last_seen_at: "2026-10-07",
      },
    ];
    const map = await loadArchivedFieldUsage("inst", ["customfield_9"]);
    expect(map.get("customfield_9")).toEqual([
      { projectId: "20001", projectKey: "TT", issueCount: 40, lastSeenAt: "2026-10-07" },
    ]);
  });
});
