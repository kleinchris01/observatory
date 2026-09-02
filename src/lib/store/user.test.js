import { vi, describe, test, expect, beforeEach } from "vitest";

// Storage for the People snapshot. Tested directly against a mocked Forge SQL, like
// store/issuetype.test.js: this is where an unscoped DELETE or a tuple-vs-column arity bug
// hides, and no test that mocks project-store wholesale would catch one.

vi.mock("@forge/sql", () => {
  const runner = { enqueue: () => runner, run: vi.fn().mockResolvedValue(undefined) };
  return {
    sql: { prepare: vi.fn(), executeInTransaction: vi.fn().mockResolvedValue(undefined) },
    migrationRunner: runner,
  };
});

import { sql } from "@forge/sql";
import {
  replaceUserSnapshot,
  loadUsers,
  loadUserGovernanceSummary,
  readUserSnapshotMeta,
  writeUserSnapshotMeta,
} from "./user.js";

let issued = [];
let rowsFor = () => [];

function harness() {
  issued = [];
  sql.prepare.mockImplementation((statement) => {
    const entry = { statement: String(statement).replace(/\s+/g, " ").trim(), params: null };
    issued.push(entry);
    const stub = {
      bindParams: (...params) => { entry.params = params; return stub; },
      execute: () => Promise.resolve({ rows: rowsFor(entry) }),
    };
    return stub;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rowsFor = () => [];
  harness();
});

const writes = () => issued.filter((e) => /^(INSERT|DELETE)/.test(e.statement));

describe("replaceUserSnapshot", () => {
  test("scopes every delete and inserts users then access rows with matching arity", async () => {
    await replaceUserSnapshot("inst", "v1", {
      users: [{ accountId: "a1", displayName: "Ann", active: true, accountType: "atlassian", avatarUrl: "u" }],
      access: [{ accountId: "a1", applicationKey: "jira-software", applicationName: "Jira Software", viaGroupId: "g1", viaGroupName: "sw-users" }],
    });

    const deletes = writes().filter((e) => e.statement.startsWith("DELETE"));
    expect(deletes).toHaveLength(2);
    expect(deletes.every((e) => /WHERE scope_key = \?$/.test(e.statement))).toBe(true);

    const userInsert = writes().find((e) => /INSERT INTO snapshot_users/.test(e.statement));
    expect(userInsert.params).toEqual(["inst", "v1", "a1", "Ann", 1, "atlassian", "u"]);

    const accessInsert = writes().find((e) => /INSERT INTO snapshot_user_access/.test(e.statement));
    expect(accessInsert.params).toEqual(["inst", "v1", "a1", "jira-software", "Jira Software", "g1", "sw-users"]);
  });

  test("writes an inactive user as active = 0", async () => {
    await replaceUserSnapshot("inst", "v1", { users: [{ accountId: "a1", active: false }] });
    const userInsert = writes().find((e) => /INSERT INTO snapshot_users/.test(e.statement));
    expect(userInsert.params[4]).toBe(0);
  });
});

describe("loadUsers", () => {
  test("collapses the user x access join into one row per account", async () => {
    rowsFor = () => [
      { account_id: "a1", display_name: "Ann", active: 1, account_type: "atlassian", avatar_url: null,
        application_key: "jira-software", application_name: "Jira Software", via_group_id: "g1", via_group_name: "sw" },
      { account_id: "a1", display_name: "Ann", active: 1, account_type: "atlassian", avatar_url: null,
        application_key: "jira-servicedesk", application_name: "JSM", via_group_id: "g2", via_group_name: "sd" },
    ];

    const users = await loadUsers("inst", "v1");

    expect(users).toHaveLength(1);
    expect(users[0].applications.map((p) => p.key).sort()).toEqual(["jira-servicedesk", "jira-software"]);
    expect(users[0].groups.map((g) => g.id).sort()).toEqual(["g1", "g2"]);
  });
});

describe("loadUserGovernanceSummary", () => {
  test("reads the aggregate counts", async () => {
    rowsFor = (entry) => /COUNT\(DISTINCT application_key\)/.test(entry.statement)
      ? [{ multi: 4 }]
      : [{ total: 20, active_count: 18, app_count: 2 }];

    const g = await loadUserGovernanceSummary("inst", "v1");
    expect(g).toEqual({ totalUsers: 20, activeUsers: 18, appUsers: 2, multiProductUsers: 4 });
  });
});

describe("user_snapshot_meta", () => {
  test("round-trips the application summary as JSON", async () => {
    rowsFor = () => [];
    await writeUserSnapshotMeta("inst", {
      state: "ready", version: "v1", totalUsers: 5, activeUsers: 5,
      applicationSummary: [{ key: "jira-software", numberOfSeats: 10, userCount: 5 }],
    });
    const insert = issued.find((e) => /INSERT INTO user_snapshot_meta/.test(e.statement));
    expect(insert.params).toContain('[{"key":"jira-software","numberOfSeats":10,"userCount":5}]');

    rowsFor = () => [{
      state: "ready", version: "v1", started_at: null, completed_at: null, refreshed_at: null,
      total_users: 5, active_users: 5,
      application_summary: '[{"key":"jira-software","numberOfSeats":10,"userCount":5}]', last_error: null,
    }];
    const meta = await readUserSnapshotMeta("inst");
    expect(meta.applicationSummary).toEqual([{ key: "jira-software", numberOfSeats: 10, userCount: 5 }]);
  });
});
