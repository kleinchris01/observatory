import { vi, describe, test, expect, beforeEach } from "vitest";

vi.mock("@forge/sql", () => {
  const runner = { enqueue: () => runner, run: vi.fn().mockResolvedValue(undefined) };
  return { sql: { prepare: vi.fn(), executeInTransaction: vi.fn() }, migrationRunner: runner };
});

import { sql } from "@forge/sql";
import {
  replaceJsmSnapshot,
  loadJsmDesks,
  loadJsmRequestTypes,
  loadJsmRequestTypeFields,
  loadJsmQueues,
  loadJsmSlas,
  loadJsmOrganizations,
  readJsmSnapshotMeta,
  writeJsmSnapshotMeta,
} from "./jsm.js";

let issued = [];
let rowsFor = () => [];
beforeEach(() => {
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
      execute: () => Promise.resolve({ rows: rowsFor(entry.statement), rowsAffected: 0 }),
    };
    return stub;
  });
});
const placeholders = (s) => (s.match(/\?/g) || []).length;
const inserts = (table) => issued.filter((e) => e.statement.includes(`INSERT INTO ${table} `));

describe("replaceJsmSnapshot", () => {
  test("clears every JSM table for the scope, then inserts each row set with matching binds", async () => {
    await replaceJsmSnapshot("inst", "v1", {
      desks: [
        {
          deskId: "1",
          projectId: 100,
          projectKey: "SD",
          customerCount: 2000,
          customersComplete: false,
          orgCount: null,
        },
      ],
      requestTypes: [
        { deskId: "1", id: "10", name: "Get help", hasDescription: true, groupIds: ["1", "2"], recentCount: 4 },
      ],
      requestTypeFields: [{ deskId: "1", requestTypeId: "10", fieldId: "summary", label: "Summary", required: true }],
      queues: [
        { deskId: "1", id: "7", name: "Q", jql: "x", issueCount: 0, brokenRefs: [] },
        { deskId: "1", id: "8", name: "R", jql: "y", issueCount: null, brokenRefs: null },
      ],
      slas: [{ deskId: "1", fieldId: "customfield_1", fieldName: "TTR", activeCount: 5, breachedCount: null }],
      organizations: [{ id: "4", name: "Acme", memberCount: 3, membersComplete: true, deskCount: 1 }],
    });

    const deletes = issued.filter((e) => e.statement.startsWith("DELETE FROM"));
    expect(deletes).toHaveLength(6);
    expect(deletes.every((d) => d.params[0] === "inst")).toBe(true);
    for (const e of issued.filter((x) => x.statement.startsWith("INSERT"))) {
      expect(placeholders(e.statement)).toBe(e.params.length);
    }
    // Unknown stays NULL; a measured zero stays zero; checked-and-clean is "", unchecked NULL.
    expect(inserts("snapshot_jsm_desks")[0].params).toEqual([
      "inst",
      "v1",
      "1",
      "100",
      "SD",
      null,
      null,
      2000,
      0,
      null,
    ]);
    expect(inserts("snapshot_jsm_request_types")[0].params.slice(7)).toEqual(["1,2", null, null, null, 4]);
    // Both queues go in one batched insert: checked-and-clean "" first, unchecked NULL second.
    const queueParams = inserts("snapshot_jsm_queues")[0].params;
    expect(queueParams.length).toBe(16);
    expect(queueParams.slice(6, 8)).toEqual([0, ""]);
    expect(queueParams.slice(14)).toEqual([null, null]);
    expect(inserts("snapshot_jsm_slas")[0].params.slice(5)).toEqual([5, null]);
    expect(inserts("snapshot_jsm_organizations")[0].params).toEqual(["inst", "v1", "4", "Acme", 3, 1, 1]);
  });

  test("writes nothing but the deletes when the snapshot is empty", async () => {
    await replaceJsmSnapshot("inst", "v1");
    expect(issued.every((e) => e.statement.startsWith("DELETE FROM"))).toBe(true);
  });
});

describe("readers", () => {
  test("desks keep null counts as null", async () => {
    rowsFor = (s) =>
      s.includes("snapshot_jsm_desks")
        ? [
            {
              desk_id: 1,
              project_key: "SD",
              customer_count: null,
              customers_complete: null,
              org_count: "2",
              portal_group_count: 0,
            },
          ]
        : [];
    expect(await loadJsmDesks("inst", "v1")).toEqual([
      {
        deskId: "1",
        projectId: null,
        projectKey: "SD",
        projectName: null,
        portalGroupCount: 0,
        customerCount: null,
        customersComplete: null,
        orgCount: 2,
      },
    ]);
  });

  test("request types split their groups and keep unmeasured volume null", async () => {
    rowsFor = () => [
      { desk_id: "1", request_type_id: "10", name: null, has_description: 1, group_ids: "1,2", recent_count: null },
    ];
    const [rt] = await loadJsmRequestTypes("inst", "v1");
    expect(rt).toMatchObject({ id: "10", name: "10", hasDescription: true, groupIds: ["1", "2"], recentCount: null });
  });

  test("request type fields can be read for one field", async () => {
    rowsFor = () => [{ desk_id: "1", request_type_id: "10", field_id: "customfield_9", label: "Asset", required: 1 }];
    expect(await loadJsmRequestTypeFields("inst", "v1", { fieldId: "customfield_9" })).toEqual([
      { deskId: "1", requestTypeId: "10", fieldId: "customfield_9", label: "Asset", required: true },
    ]);
    expect(issued.at(-1).params).toEqual(["inst", "v1", "customfield_9"]);
    await loadJsmRequestTypeFields("inst", "v1");
    expect(issued.at(-1).params).toEqual(["inst", "v1"]);
  });

  test("queues tell unchecked refs from clean ones", async () => {
    rowsFor = () => [
      { desk_id: "1", queue_id: "7", name: "Q", jql: "x", issue_count: 3, broken_refs: "" },
      { desk_id: "1", queue_id: "8", name: "R", jql: null, issue_count: null, broken_refs: null },
      { desk_id: "1", queue_id: "9", name: "S", jql: "y", issue_count: 1, broken_refs: "customfield_1" },
    ];
    expect((await loadJsmQueues("inst", "v1")).map((q) => [q.brokenRefs, q.issueCount, q.jql])).toEqual([
      [[], 3, "x"],
      [null, null, ""],
      [["customfield_1"], 1, "y"],
    ]);
  });

  test("SLAs and organizations", async () => {
    rowsFor = (s) =>
      s.includes("snapshot_jsm_slas")
        ? [{ desk_id: "1", field_id: "customfield_1", field_name: null, active_count: 5, breached_count: null }]
        : [{ org_id: "4", name: "Acme", member_count: 0, members_complete: 1, desk_count: null }];
    expect(await loadJsmSlas("inst", "v1")).toEqual([
      { deskId: "1", fieldId: "customfield_1", fieldName: "customfield_1", activeCount: 5, breachedCount: null },
    ]);
    expect(await loadJsmOrganizations("inst", "v1")).toEqual([
      { id: "4", name: "Acme", memberCount: 0, membersComplete: true, deskCount: null },
    ]);
  });
});

describe("meta", () => {
  test("reads null when absent, and parses the summary", async () => {
    expect(await readJsmSnapshotMeta("inst")).toBeNull();
    rowsFor = () => [
      { state: "ready", version: "v1", jsm_enabled: 0, total_desks: 2, summary_json: '{"available":true}' },
    ];
    expect(await readJsmSnapshotMeta("inst")).toMatchObject({
      state: "ready",
      jsmEnabled: false,
      totalDesks: 2,
      summary: { available: true },
    });
  });

  test("writes merge over the current row and serialize the summary", async () => {
    rowsFor = (s) => (s.startsWith("SELECT") ? [{ state: "building", version: "v0", jsm_enabled: 1 }] : []);
    await writeJsmSnapshotMeta("inst", { state: "ready", summary: { a: 1 }, jsmEnabled: false });
    const insert = issued.find((e) => e.statement.includes("INSERT INTO jsm_snapshot_meta"));
    expect(placeholders(insert.statement)).toBe(insert.params.length);
    expect(insert.params.slice(0, 3)).toEqual(["inst", "ready", "v0"]);
    expect(insert.params[6]).toBe(0);
    expect(insert.params[12]).toBe('{"a":1}');
  });
});
