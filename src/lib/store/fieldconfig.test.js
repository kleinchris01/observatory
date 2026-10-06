import { vi, describe, test, expect, beforeEach } from "vitest";

vi.mock("@forge/sql", () => {
  const runner = { enqueue: () => runner, run: vi.fn().mockResolvedValue(undefined) };
  return { sql: { prepare: vi.fn(), executeInTransaction: vi.fn() }, migrationRunner: runner };
});

import { sql } from "@forge/sql";
import {
  replaceFieldConfigSnapshot,
  loadFieldConfigSchemes,
  loadFieldConfigConfigs,
  loadFieldConfigItemsForField,
  loadFieldConfigItemsForOwner,
  readFieldConfigSnapshotMeta,
  writeFieldConfigSnapshotMeta,
} from "./fieldconfig.js";

let issued = [];
let rowsFor = () => [];
beforeEach(() => {
  issued = [];
  rowsFor = () => [];
  sql.prepare.mockImplementation((statement) => {
    const entry = { statement: String(statement), params: null };
    issued.push(entry);
    const stub = {
      bindParams: (...params) => { entry.params = params; return stub; },
      execute: () => Promise.resolve({ rows: rowsFor(entry.statement), rowsAffected: 0 }),
    };
    return stub;
  });
});
const placeholders = (s) => (s.match(/\?/g) || []).length;

describe("replaceFieldConfigSnapshot", () => {
  const data = {
    schemes: [{ id: "fs:1", source: "field-schemes", sourceId: "1", name: "Build", isDefault: false, projectCount: 2, measured: true, fieldCount: 40, requiredCount: 3, restrictedCount: 1, codes: ["duplicate"], duplicateOf: "fs:0" }],
    schemeProjects: [{ schemeId: "fs:1", projectId: "10", projectKey: "BLD", projectName: "Build" }],
    configs: [{ id: "fc:2", sourceId: "2", name: "Cfg", used: true, itemsRead: true, totalFieldCount: 900, notableCount: 5, requiredCount: 2, hiddenCount: 3, requiredHidden: ["customfield_1"], codes: ["required-hidden"] }],
    mappings: [{ schemeId: "fcs:5", workTypeId: "default", configId: "fc:2" }],
    items: [{ ownerKind: "scheme", ownerId: "fs:1", workTypeId: "*", fieldId: "customfield_1", associated: true, hidden: null, required: true, description: "Cost", renderer: "text", restrictedTo: ["10001"] }],
  };

  test("binds one parameter per placeholder on every insert, and keeps null tri-states null", async () => {
    await replaceFieldConfigSnapshot("site", "v1", data);
    const inserts = issued.filter((e) => /INSERT/.test(e.statement));
    expect(inserts.map((e) => e.statement.match(/INTO (\w+)/)[1])).toEqual([
      "snapshot_fieldcfg_schemes", "snapshot_fieldcfg_scheme_projects", "snapshot_fieldcfg_configs",
      "snapshot_fieldcfg_mappings", "snapshot_fieldcfg_items",
    ]);
    for (const insert of inserts) expect(insert.params).toHaveLength(placeholders(insert.statement));
    const item = inserts.at(-1).params;
    expect(item).toEqual(["site", "v1", "scheme", "fs:1", "*", "customfield_1", 1, null, 1, "Cost", "text", '["10001"]']);
  });

  test("clears every table for this site only, in bounded deletes", async () => {
    await replaceFieldConfigSnapshot("site", "v1", {});
    const deletes = issued.filter((e) => /DELETE FROM/.test(e.statement));
    expect(deletes).toHaveLength(5);
    for (const d of deletes) {
      expect(d.statement).toMatch(/WHERE scope_key = \? .*LIMIT \d+|WHERE scope_key = \?[\s\S]*LIMIT \d+/);
      expect(d.params[0]).toBe("site");
    }
  });
});

describe("loaders", () => {
  test("schemes map counts, tri-states and findings", async () => {
    rowsFor = () => [{ scheme_id: "fs:1", source: "field-schemes", source_id: "1", name: "Build", description: null, is_default: 0, project_count: "2", measured: null, field_count: null, required_count: 3, restricted_count: 0, finding_codes: '["unused"]', duplicate_of: null }];
    const [scheme] = await loadFieldConfigSchemes("site", "v1");
    expect(scheme).toMatchObject({ id: "fs:1", projectCount: 2, measured: null, fieldCount: null, codes: ["unused"] });
  });

  test("configurations parse their required-hidden list", async () => {
    rowsFor = () => [{ config_id: "fc:2", is_default: 0, used: 1, items_read: 1, required_hidden: '["customfield_1"]', finding_codes: "[]", notable_count: 5 }];
    const [config] = await loadFieldConfigConfigs("site", "v1");
    expect(config).toMatchObject({ used: true, itemsRead: true, requiredHidden: ["customfield_1"], notableCount: 5 });
  });

  test("items for a field read by field id", async () => {
    rowsFor = () => [{ owner_kind: "config", owner_id: "fc:2", work_type_id: "*", field_id: "customfield_1", associated: null, hidden: 1, required: 1, restricted_to: null }];
    const [item] = await loadFieldConfigItemsForField("site", "v1", "customfield_1");
    expect(issued.at(-1).params).toEqual(["site", "v1", "customfield_1"]);
    expect(item).toMatchObject({ hidden: true, required: true, associated: null, restrictedTo: [] });
  });

  test("an owner's items page, clamp and filter to required", async () => {
    rowsFor = (s) => (/COUNT/.test(s) ? [{ n: 9 }] : []);
    const page = await loadFieldConfigItemsForOwner("site", "v1", "scheme", "fs:1", { limit: 9999, offset: -1, requiredOnly: true });
    const select = issued.find((e) => /SELECT owner_kind/.test(e.statement));
    expect(select.statement).toMatch(/AND required = 1/);
    expect(select.statement).toMatch(/LIMIT 500 OFFSET 0/);
    expect(page.total).toBe(9);
  });
});

describe("meta", () => {
  test("round-trips the summary and the model it was read from", async () => {
    rowsFor = () => [];
    await writeFieldConfigSnapshotMeta("site", { state: "ready", version: "v1", source: "field-schemes", summary: { usageJudged: 3 }, inconsistentRequired: [{ fieldId: "x" }] });
    const write = issued.find((e) => /INSERT INTO fieldconfig_snapshot_meta/.test(e.statement));
    expect(write.params).toHaveLength(placeholders(write.statement));
    expect(write.params).toContain('{"usageJudged":3}');

    rowsFor = () => [{ state: "ready", version: "v1", source: "field-schemes", summary_json: '{"usageJudged":3}', inconsistent_json: null, total_schemes: 4 }];
    expect(await readFieldConfigSnapshotMeta("site")).toMatchObject({ source: "field-schemes", summary: { usageJudged: 3 }, inconsistentRequired: [], totalSchemes: 4 });
  });

  test("no row is null", async () => {
    expect(await readFieldConfigSnapshotMeta("site")).toBeNull();
  });
});
