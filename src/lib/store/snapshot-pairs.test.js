import { vi, describe, test, expect, beforeEach } from "vitest";

// The complete populated-pair read behind form clutter, and the helper that decides whether
// a workflow snapshot may be used to call a screen unreached. Both exist because a missing
// row was being read as a zero: Summary "never filled" on 135 create screens, and "no
// workflow transition on this site opens a screen" on a site whose workflows were never read.

vi.mock("@forge/sql", () => {
  const runner = { enqueue: () => runner, run: vi.fn().mockResolvedValue(undefined) };
  return {
    sql: {
      prepare: vi.fn(),
      executeInTransaction: vi.fn().mockResolvedValue(undefined),
    },
    migrationRunner: runner,
  };
});

import { sql } from "@forge/sql";
import { loadPopulatedFieldProjectPairs } from "./snapshot.js";
import { transitionAwareWorkflowVersion } from "./workflow.js";

// One stub per prepare() so each statement stays paired with its own params; `pages` is
// served in order, one per SELECT.
let issued = [];
function harness(pages) {
  issued = [];
  let page = 0;
  sql.prepare.mockImplementation((statement) => {
    const entry = { statement: String(statement), params: null };
    const isPairRead = /FROM snapshot_project_usage/.test(entry.statement);
    if (isPairRead) issued.push(entry);
    const stub = {
      bindParams: (...params) => { entry.params = params; return stub; },
      execute: () => Promise.resolve({ rows: isPairRead ? (pages[page++] || []) : [] }),
    };
    return stub;
  });
}

const row = (field, project) => ({ field_id: field, project_id: project });

describe("loadPopulatedFieldProjectPairs", () => {
  beforeEach(() => vi.clearAllMocks());

  test("reads every page to completion, keyed project|field", async () => {
    harness([[row("cf_1", "10"), row("cf_1", "11")], [row("cf_2", "10")]]);

    const { pairs, complete } = await loadPopulatedFieldProjectPairs("scope-a", "v1", { pageSize: 2 });

    expect(complete).toBe(true);
    expect([...pairs]).toEqual(["10|cf_1", "11|cf_1", "10|cf_2"]);
    expect(issued).toHaveLength(2);
    // Keyset paging resumes after the last row of the previous page.
    expect(issued[1].params).toEqual(["scope-a", "v1", 0, "cf_1", "cf_1", "11"]);
  });

  test("scopes every read to the installation and applies the issue-count floor", async () => {
    harness([[row("cf_1", "10")]]);

    await loadPopulatedFieldProjectPairs("scope-a", "v1", { minIssues: 5 });

    expect(issued[0].statement).toMatch(/WHERE scope_key = \? AND version = \? AND issue_count > \?/);
    expect(issued[0].params.slice(0, 3)).toEqual(["scope-a", "v1", 5]);
  });

  test("reports an incomplete read at the ceiling rather than passing it off as whole", async () => {
    harness([[row("cf_1", "10"), row("cf_1", "11")], [row("cf_2", "10"), row("cf_2", "11")]]);

    const { complete } = await loadPopulatedFieldProjectPairs("scope-a", "v1", { pageSize: 2, ceiling: 2 });

    expect(complete).toBe(false);
  });
});

describe("transitionAwareWorkflowVersion", () => {
  test("uses the version only when that build actually read transitions", () => {
    expect(transitionAwareWorkflowVersion({ version: "v9", transitionScreens: 12 })).toBe("v9");
    expect(transitionAwareWorkflowVersion({ version: "v9", transitionScreens: 0 })).toBe("v9");
  });

  test("returns null when transitions are unknown, so no screen is called unreached", () => {
    expect(transitionAwareWorkflowVersion({ version: "v9", transitionScreens: null })).toBeNull();
    expect(transitionAwareWorkflowVersion(null)).toBeNull();
    expect(transitionAwareWorkflowVersion({ version: null, transitionScreens: 4 })).toBeNull();
  });
});
