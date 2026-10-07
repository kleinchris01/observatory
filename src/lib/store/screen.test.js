import { vi, describe, test, expect, beforeEach } from "vitest";

// Storage for the screen and scheme snapshot.
//
// Tested directly against a mocked Forge SQL rather than only through its callers, for the
// same reason store/workflow.js is: this is where a wrong column alias or an unscoped
// DELETE hides, and no test that mocks project-store wholesale could ever catch one.

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
  replaceScreenSnapshot,
  loadScreensPage,
  SCREEN_FILTERS,
  loadScreenFields,
  loadScreensForField,
  loadScreenSchemes,
  loadScreenSchemeOperations,
  loadIssueTypeScreenSchemes,
  loadItssMappings,
  loadItssProjects,
  loadScreensWithFieldsByIds,
  loadScreenGovernanceSummary,
  loadScreenCountsForFields,
  SCREEN_SORT_KEYS,
  readScreenSnapshotMeta,
  writeScreenSnapshotMeta,
  loadScreenFieldLayout,
} from "./screen.js";

// Each prepare() gets its own stub so a statement stays paired with the params bound to
// it. A single shared stub collects every bindParams call in one list, which silently
// correlates the wrong params to the wrong SQL -- and a storage test that asserts against
// the wrong row is worse than no storage test.
let issued = [];
let nextRows = [];

function harness() {
  issued = [];
  sql.prepare.mockImplementation((statement) => {
    const entry = { statement: String(statement), params: null };
    issued.push(entry);
    const stub = {
      bindParams: (...params) => { entry.params = params; return stub; },
      execute: () => Promise.resolve({ rows: nextRows }),
    };
    return stub;
  });
}

function statements() {
  return issued.map((e) => e.statement);
}

function boundParamsFor(match) {
  return issued.find((e) => e.statement.includes(match))?.params ?? null;
}

function mockRows(rows) {
  nextRows = rows;
}

beforeEach(() => {
  vi.clearAllMocks();
  nextRows = [];
  harness();
});

describe("replaceScreenSnapshot", () => {
  const payload = {
    screens: [{ id: 100, name: "Default", tabCount: 1, fieldCount: 2 }],
    tabs: [{ screenId: 100, tabId: 1, name: "Tab", tabIndex: 0, fieldCount: 2 }],
    fields: [{ screenId: 100, tabId: 1, fieldId: "summary", fieldName: "Summary", tabIndex: 0, fieldIndex: 0 }],
    screenSchemes: [{ id: 5, name: "SS", screens: { default: 100 } }],
    schemeOperations: [{ schemeId: 5, operation: "default", screenId: 100, inherited: false, dangling: false }],
    issueTypeScreenSchemes: [{ id: 9, name: "ITSS", projectCount: 1 }],
    itssMappings: [{ itssId: 9, issueTypeId: "default", screenSchemeId: 5, isDefault: true }],
    itssProjects: [{ itssId: 9, projectId: "10000", projectKey: "OBS", projectName: "Observatory" }],
  };

  // The one that matters most. An unscoped DELETE in a multi-tenant Forge app destroys
  // another customer's data.
  test("every DELETE carries a scope_key predicate", async () => {
    await replaceScreenSnapshot("scope-1", "v1", payload);

    const deletes = statements().filter((s) => s.trim().startsWith("DELETE"));
    expect(deletes.length).toBe(8);
    expect(deletes.every((s) => s.includes("WHERE scope_key = ?"))).toBe(true);
  });

  test("clears all eight tables before writing", async () => {
    await replaceScreenSnapshot("scope-1", "v1", payload);
    const deletes = statements().filter((s) => s.trim().startsWith("DELETE")).join(" ");

    for (const table of [
      "snapshot_screens",
      "snapshot_screen_tabs",
      "snapshot_screen_fields",
      "snapshot_screen_schemes",
      "snapshot_screen_scheme_operations",
      "snapshot_issue_type_screen_schemes",
      "snapshot_itss_mappings",
      "snapshot_itss_projects",
    ]) {
      expect(deletes).toContain(table);
    }
  });

  test("writes the field row with its tab and field positions", async () => {
    await replaceScreenSnapshot("scope-1", "v1", payload);
    const params = boundParamsFor("INSERT INTO snapshot_screen_fields");

    expect(params).toEqual(["scope-1", "v1", "100", "1", "summary", "Summary", 0, 0]);
  });

  test("stores the tri-state on a screen rather than a boolean", async () => {
    await replaceScreenSnapshot("scope-1", "v1", {
      screens: [{ id: 100, tabsResolved: "unresolved", unresolvedReason: "401" }],
    });
    const params = boundParamsFor("INSERT INTO snapshot_screens");

    expect(params).toContain("unresolved");
    expect(params).toContain("401");
  });

  test("defaults a screen with no stated resolution to resolved", async () => {
    await replaceScreenSnapshot("scope-1", "v1", { screens: [{ id: 100 }] });
    expect(boundParamsFor("INSERT INTO snapshot_screens")).toContain("resolved");
  });

  test("persists inherited and dangling as flags, not as absence", async () => {
    await replaceScreenSnapshot("scope-1", "v1", {
      schemeOperations: [{ schemeId: 5, operation: "create", screenId: 999, inherited: true, dangling: true }],
    });
    const params = boundParamsFor("INSERT INTO snapshot_screen_scheme_operations");

    expect(params.slice(-2)).toEqual([1, 1]);
    // The dangling screen id is kept. Dropping it would make the scheme look correct.
    expect(params).toContain("999");
  });

  test("writes a null screen id for an operation that maps nowhere", async () => {
    await replaceScreenSnapshot("scope-1", "v1", {
      schemeOperations: [{ schemeId: 5, operation: "view", screenId: null }],
    });
    expect(boundParamsFor("INSERT INTO snapshot_screen_scheme_operations")).toContain(null);
  });

  test("issues no INSERT for a section with nothing in it", async () => {
    await replaceScreenSnapshot("scope-1", "v1", {});
    expect(statements().filter((s) => s.includes("INSERT"))).toHaveLength(0);
  });

  // Both ITSS inserts shipped with a five-placeholder tuple against six columns, so every
  // screen build died on the last two writes with an opaque "Unknown SQL execution error"
  // after several minutes of work. Nothing caught it: the tests asserted the params bound
  // to a statement but never that the statement had somewhere to put them, and the mocked
  // driver accepts any arity. Counted here rather than spot-checked per table, so the
  // arity of a table added later is covered the day it is added.
  test("every INSERT has one placeholder per column and per bound param", async () => {
    await replaceScreenSnapshot("scope-1", "v1", {
      // Two rows per table: a single row makes a tuple-vs-column mismatch look identical
      // to a batching bug, and hides any error in how tuples are repeated.
      screens: [{ id: 100 }, { id: 101 }],
      tabs: [{ screenId: 100, tabId: 1 }, { screenId: 101, tabId: 2 }],
      fields: [
        { screenId: 100, tabId: 1, fieldId: "summary" },
        { screenId: 101, tabId: 2, fieldId: "duedate" },
      ],
      screenSchemes: [{ id: 5 }, { id: 6 }],
      schemeOperations: [
        { schemeId: 5, operation: "default" },
        { schemeId: 6, operation: "create" },
      ],
      issueTypeScreenSchemes: [{ id: 9 }, { id: 10 }],
      itssMappings: [
        { itssId: 9, issueTypeId: "default" },
        { itssId: 10, issueTypeId: "10001" },
      ],
      itssProjects: [
        { itssId: 9, projectId: "10000" },
        { itssId: 10, projectId: "10001" },
      ],
    });

    const inserts = issued.filter((e) => e.statement.includes("INSERT INTO"));
    expect(inserts.length).toBe(8);

    for (const { statement, params } of inserts) {
      const [columnPart, valuesPart] = statement.split(/\bVALUES\b/);
      const table = statement.match(/INSERT INTO (\w+)/)[1];
      const columns = columnPart.match(/\(([^)]*)\)/)[1].split(",").length;
      const placeholders = (valuesPart.match(/\?/g) || []).length;

      expect(placeholders, `${table}: ${placeholders} placeholders for ${params.length} bound params`)
        .toBe(params.length);
      expect(placeholders % columns, `${table}: ${placeholders} placeholders is not a multiple of ${columns} columns`)
        .toBe(0);
    }
  });

  // Field rows dominate this snapshot and each carries 8 bind params, so they batch
  // smaller than everything else to stay clear of the bind-parameter ceiling.
  test("batches fields in smaller chunks than the other tables", async () => {
    const fields = Array.from({ length: 85 }, (_, i) => ({
      screenId: 1, tabId: 1, fieldId: `f${i}`, tabIndex: 0, fieldIndex: i,
    }));
    await replaceScreenSnapshot("scope-1", "v1", { fields });

    const inserts = statements().filter((s) => s.includes("INSERT INTO snapshot_screen_fields"));
    expect(inserts.length).toBe(3);
  });
});

describe("reads", () => {
  test("maps a screen row and keeps its unresolved reason", async () => {
    mockRows([{
      screen_id: "100", name: "Default", description: "d",
      tab_count: 2, field_count: 30, tabs_resolved: "unresolved", unresolved_reason: "401",
    }]);

    const { rows } = await loadScreensPage("scope-1", "v1");

    expect(rows[0]).toMatchObject({
      screenId: "100", name: "Default", tabCount: 2, fieldCount: 30,
      tabsResolved: "unresolved", unresolvedReason: "401",
    });
  });

  test("falls back to the id when a screen has no name", async () => {
    mockRows([{ screen_id: "100", name: null }]);
    const { rows } = await loadScreensPage("scope-1", "v1");
    expect(rows[0].name).toBe("100");
  });

  test("search narrows on name or id and stays parameterised", async () => {
    await loadScreensPage("scope-1", "v1", { search: "Default" });
    const params = boundParamsFor("FROM snapshot_screens");

    expect(params).toEqual(["scope-1", "v1", "%Default%", "%Default%"]);
  });

  test("clamps a hostile page size rather than trusting it", async () => {
    await loadScreensPage("scope-1", "v1", { limit: 99999, offset: -5 });
    const statement = statements().find((s) => s.includes("ORDER BY field_count"));

    expect(statement).toContain("LIMIT 200");
    expect(statement).toContain("OFFSET 0");
  });

  // Sorting has to happen in SQL. The tab shows 25 of ~760 screens, so sorting the page in
  // the browser reorders an arbitrary slice and presents it as the top of the catalog.
  test("orders by the requested sort, from a whitelist", async () => {
    await loadScreensPage("scope-1", "v1", { sort: "name-desc" });
    expect(statements().find((s) => s.includes("ORDER BY"))).toContain("ORDER BY name DESC");
  });

  // The token comes from the browser and must never reach ORDER BY as text -- this file
  // already interpolates LIMIT for a Forge SQL reason, so it sits close to that mistake.
  test("falls back to the default rather than interpolating an unknown token", async () => {
    await loadScreensPage("scope-1", "v1", { sort: "name; DROP TABLE snapshot_screens" });
    const statement = statements().find((s) => s.includes("ORDER BY"));

    expect(statement).toContain("ORDER BY field_count DESC");
    expect(statement).not.toContain("DROP TABLE");
  });

  // Without a unique tiebreak, rows with equal field counts can come back in a different
  // order per page, so paging shows some screens twice and skips others.
  test("every sort ends in a unique tiebreak so paging cannot repeat or skip a row", async () => {
    for (const sort of SCREEN_SORT_KEYS) {
      issued = [];
      await loadScreensPage("scope-1", "v1", { sort });
      const statement = statements().find((s) => s.includes("ORDER BY"));
      const orderBy = statement.split("ORDER BY")[1].split("LIMIT")[0];
      expect(orderBy, `${sort} has no screen_id tiebreak`).toMatch(/screen_id (ASC|DESC)/);
    }
  });

  test("orders screen fields by tab then position", async () => {
    await loadScreenFields("scope-1", "v1", 100);
    expect(statements().join(" ")).toContain("ORDER BY tab_index ASC, field_index ASC");
  });

  test("resolves screens for a field through the reverse index", async () => {
    mockRows([{ screen_id: "100", screen_name: "Default", tab_id: "1", tab_index: 0, field_index: 3 }]);

    const rows = await loadScreensForField("scope-1", "v1", "customfield_1");

    expect(rows[0]).toMatchObject({ screenId: "100", screenName: "Default", fieldIndex: 3 });
  });

  test("parses the raw operation object back off a scheme", async () => {
    mockRows([{ scheme_id: "5", name: "SS", screens_json: '{"default":100}' }]);
    const rows = await loadScreenSchemes("scope-1", "v1");
    expect(rows[0].screens).toEqual({ default: 100 });
  });

  test("survives an unparseable screens blob without throwing", async () => {
    mockRows([{ scheme_id: "5", screens_json: "{not json" }]);
    const rows = await loadScreenSchemes("scope-1", "v1");
    expect(rows[0].screens).toBeNull();
  });

  test("maps operation flags back to booleans", async () => {
    mockRows([{ scheme_id: "5", operation: "create", screen_id: "9", inherited: 1, dangling: 0 }]);
    const rows = await loadScreenSchemeOperations("scope-1", "v1");
    expect(rows[0]).toMatchObject({ inherited: true, dangling: false });
  });

  test("maps the ITSS layers", async () => {
    mockRows([{ itss_id: "9", name: "ITSS", project_count: 4 }]);
    expect((await loadIssueTypeScreenSchemes("scope-1", "v1"))[0]).toMatchObject({ itssId: "9", projectCount: 4 });

    mockRows([{ itss_id: "9", issue_type_id: "default", screen_scheme_id: "5", is_default: 1 }]);
    expect((await loadItssMappings("scope-1", "v1"))[0]).toMatchObject({ isDefault: true });

    mockRows([{ itss_id: "9", project_id: "10000", project_key: "OBS", project_name: "Observatory" }]);
    expect((await loadItssProjects("scope-1", "v1"))[0]).toMatchObject({ projectKey: "OBS" });
  });
});

describe("loadScreensWithFieldsByIds", () => {
  test("returns nothing for an empty id list without querying", async () => {
    expect(await loadScreensWithFieldsByIds("scope-1", "v1", [])).toEqual([]);
    expect(sql.prepare).not.toHaveBeenCalled();
  });

  test("joins each screen to its fields, preserves caller order, drops unknown ids", async () => {
    // Two SELECTs per batch: screen meta, then screen fields. Answer them by statement.
    sql.prepare.mockImplementation((statement) => {
      const s = String(statement);
      const rows = s.includes("FROM snapshot_screens")
        ? [
          { screen_id: "200", name: "Edit", field_count: 2, tabs_resolved: "resolved" },
          { screen_id: "100", name: "Create", field_count: 1, tabs_resolved: "unresolved" },
        ]
        : s.includes("FROM snapshot_screen_fields")
          ? [
            { screen_id: "100", field_id: "cf_1", field_name: "A", tab_index: 0, field_index: 0 },
            { screen_id: "200", field_id: "cf_2", field_name: "B", tab_index: 0, field_index: 0 },
            { screen_id: "200", field_id: "cf_3", field_name: "C", tab_index: 0, field_index: 1 },
          ]
          : [];
      return { bindParams: () => ({ execute: () => Promise.resolve({ rows }) }) };
    });

    const result = await loadScreensWithFieldsByIds("scope-1", "v1", ["100", "200", "999"]);

    expect(result.map((s) => s.screenId)).toEqual(["100", "200"]); // caller order, 999 dropped
    expect(result[0]).toMatchObject({ name: "Create", tabsResolved: "unresolved" });
    expect(result[0].fields.map((f) => f.fieldId)).toEqual(["cf_1"]);
    expect(result[1].fields.map((f) => f.fieldId)).toEqual(["cf_2", "cf_3"]);
  });
});

describe("loadScreenCountsForFields", () => {
  test("asks once for the whole page rather than once per field", async () => {
    mockRows([{ field_id: "customfield_1", screen_count: 6 }]);

    const counts = await loadScreenCountsForFields("scope-1", "v1", ["customfield_1", "customfield_2"]);

    const selects = statements().filter((s) => s.includes("snapshot_screen_fields"));
    expect(selects).toHaveLength(1);
    expect(selects[0]).toContain("field_id IN (?, ?)");
    expect(counts).toEqual({ customfield_1: 6 });
  });

  // Presence is the signal. Writing 0 for a field with no rows would be indistinguishable
  // from a field the caller never asked about, and the card renders those differently.
  test("omits fields on no screen instead of writing a zero", async () => {
    mockRows([]);
    expect(await loadScreenCountsForFields("scope-1", "v1", ["customfield_1"])).toEqual({});
  });

  test("dedupes ids and skips SQL entirely for an empty list", async () => {
    await loadScreenCountsForFields("scope-1", "v1", ["a", "a", "b"]);
    expect(boundParamsFor("snapshot_screen_fields")).toEqual(["scope-1", "v1", "a", "b"]);

    issued = [];
    expect(await loadScreenCountsForFields("scope-1", "v1", [])).toEqual({});
    expect(statements()).toHaveLength(0);
  });

  test("chunks a page larger than the bind ceiling into several statements", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `customfield_${i}`);
    await loadScreenCountsForFields("scope-1", "v1", ids);

    expect(statements().filter((s) => s.includes("snapshot_screen_fields"))).toHaveLength(3);
  });
});

describe("loadScreenGovernanceSummary", () => {
  test("scopes and versions every aggregate it runs", async () => {
    await loadScreenGovernanceSummary("scope-1", "v1", { workflowVersion: "w9" });

    const aggregates = issued.filter((e) => e.statement.includes("COUNT(*)"));
    expect(aggregates.length).toBe(5);
    for (const entry of aggregates) {
      expect(entry.statement).toContain("scope_key = ?");
      expect(entry.statement).toContain("version = ?");
      // The two reachability aggregates span pillars, so they bind the workflow snapshot's
      // version as a third param. Every one of them is still scoped to this tenant.
      expect(entry.params.slice(0, 2)).toEqual(["scope-1", "v1"]);
      expect(entry.params.length).toBeLessThanOrEqual(3);
    }
  });

  // Counted with NOT EXISTS rather than (total - COUNT(DISTINCT screen_id)). A scheme
  // operation can name a screen id the catalog does not contain, so the distinct count
  // includes non-screens and the subtraction under-reports unreached screens.
  test("derives unreached screens from an anti-join, not a subtraction", async () => {
    await loadScreenGovernanceSummary("scope-1", "v1", { workflowVersion: "w9" });

    const statement = statements().find((s) => s.includes("unreached"));
    expect(statement).toContain("NOT EXISTS");
    expect(statement).toContain("snapshot_screen_scheme_operations");
    expect(statement).not.toContain("COUNT(DISTINCT");
  });

  test("never counts an unreadable screen as empty", async () => {
    await loadScreenGovernanceSummary("scope-1", "v1");

    const statement = statements().find((s) => s.includes("empty_screens"));
    // The empty branch requires tabs_resolved = 'resolved'; a screen the build could not
    // read has to fall into unresolved_screens instead.
    expect(statement).toMatch(/tabs_resolved = 'resolved' AND field_count = 0/);
    expect(statement).toContain("tabs_resolved <> 'resolved'");
  });

  test("maps every aggregate to a number, including when a table is empty", async () => {
    // SUM() over no rows returns NULL in SQL, not 0 -- and NULL reaching the health score
    // as a rate makes the dimension unavailable rather than clean.
    mockRows([{ total: 0, empty_screens: null, unresolved_screens: null, dangling: null, unused: null, unreached: null }]);

    const summary = await loadScreenGovernanceSummary("scope-1", "v1", { workflowVersion: "w9" });

    // The reachability figures are deliberately nullable and transitionsKnown is a flag;
    // everything else must be a real number even when SUM() over no rows returns NULL.
    const nullable = new Set(["unreachedScreens", "transitionOnlyScreens", "transitionsKnown"]);
    for (const [key, value] of Object.entries(summary)) {
      if (nullable.has(key)) continue;
      expect(Number.isFinite(value), `${key} is ${value}`).toBe(true);
    }
  });
});


// A screen a workflow transition opens is in daily use while belonging to no screen scheme.
// Counting it as unreached is not a rounding error -- it is the premise for deleting a
// screen people use every time they move an issue.
describe("loadScreenGovernanceSummary - transition reachability", () => {
  test("excludes screens a transition opens from the unreached count", async () => {
    await loadScreenGovernanceSummary("scope-1", "v1", { workflowVersion: "w9" });

    const statement = statements().find((s) => s.includes("AS unreached"));
    expect(statement).toContain("snapshot_transition_screens");
    expect(statement).toMatch(/NOT EXISTS[\s\S]*snapshot_screen_scheme_operations/);
    expect(statement).toMatch(/NOT EXISTS[\s\S]*snapshot_transition_screens/);
  });

  // The two pillars rebuild on their own cadences, so the transition lookup is pinned to
  // the workflow snapshot's version, not the screen snapshot's.
  test("queries transitions at the workflow version, not the screen version", async () => {
    await loadScreenGovernanceSummary("scope-1", "v1", { workflowVersion: "w9" });
    const entry = issued.find((e) => e.statement.includes("AS unreached"));
    expect(entry.params).toEqual(["scope-1", "v1", "w9"]);
  });

  // The whole point of the fix: without the workflow snapshot we cannot say a screen is
  // unreachable, and null is how every consumer is told to suppress the claim.
  test("returns null rather than a number when no workflow snapshot exists", async () => {
    const summary = await loadScreenGovernanceSummary("scope-1", "v1");

    expect(summary.unreachedScreens).toBeNull();
    expect(summary.transitionOnlyScreens).toBeNull();
    expect(summary.transitionsKnown).toBe(false);
    expect(statements().some((s) => s.includes("AS unreached"))).toBe(false);
  });

  test("counts screens reached only by a transition as their own figure", async () => {
    await loadScreenGovernanceSummary("scope-1", "v1", { workflowVersion: "w9" });

    const statement = statements().find((s) => s.includes("AS transition_only"));
    // No scheme reaches it AND a transition does -- the correction to the old finding.
    expect(statement).toMatch(/NOT EXISTS[\s\S]*snapshot_screen_scheme_operations/);
    expect(statement).toMatch(/AND EXISTS[\s\S]*snapshot_transition_screens/);
  });
});

describe("meta", () => {
  test("returns null when no build has ever run", async () => {
    mockRows([]);
    expect(await readScreenSnapshotMeta("scope-1")).toBeNull();
  });

  test("maps a meta row including the unresolved count", async () => {
    mockRows([{
      state: "ready", version: "v1", total_screens: 760, total_schemes: 12,
      unresolved_screens: 30, refreshed_at: "2026-08-11T00:00:00.000Z", last_error: null,
    }]);

    expect(await readScreenSnapshotMeta("scope-1")).toMatchObject({
      state: "ready", version: "v1", totalScreens: 760, unresolvedScreens: 30,
    });
  });

  // Merge-patch, so a caller can set two fields without restating the rest -- and without
  // silently zeroing the counts somebody else wrote.
  test("patches over the current row rather than replacing it", async () => {
    mockRows([{ state: "ready", version: "v1", total_screens: 760, unresolved_screens: 30 }]);

    await writeScreenSnapshotMeta("scope-1", { state: "building" });
    const params = boundParamsFor("INSERT INTO screen_snapshot_meta");

    expect(params).toContain("building");
    expect(params).toContain("v1");
    expect(params).toContain(760);
  });

  test("defaults to idle when there is nothing to merge over", async () => {
    mockRows([]);
    await writeScreenSnapshotMeta("scope-1", {});
    expect(boundParamsFor("INSERT INTO screen_snapshot_meta")).toContain("idle");
  });
});

// The Overview counts "252 screens nothing reaches" and, until now, clicking that count
// opened page one of 746 and left the reader to find the 252 by hand.
//
// There is no per-screen reachability column to filter on -- reachability is a question
// about two other tables -- so each filter is the same NOT EXISTS pair the governance
// summary already counts with.
describe("loadScreensPage — filtering to a finding", () => {
  function capture(rows = []) {
    const calls = [];
    sql.prepare.mockImplementation((text) => ({
      bindParams: (...params) => {
        calls.push({ text, params });
        // First statement is the count, second is the page.
        return { execute: async () => ({ rows: calls.length === 1 ? [{ total: rows.length }] : rows }) };
      },
    }));
    return calls;
  }

  test("narrows to screens carrying no fields, excluding the unreadable", () => {
    const calls = capture();
    return loadScreensPage("scope-1", "v1", { filter: "empty" }).then(() => {
      // A screen whose contents could not be read is unmeasured, not empty.
      expect(calls[0].text).toContain("field_count = 0 AND tabs_resolved = 'resolved'");
    });
  });

  test("narrows to screens whose contents could not be read", async () => {
    const calls = capture();
    await loadScreensPage("scope-1", "v1", { filter: "unresolved" });
    expect(calls[0].text).toContain("tabs_resolved <> 'resolved'");
  });

  test("excludes both routes to a screen before calling it unreached", async () => {
    const calls = capture();
    await loadScreensPage("scope-1", "v1", { filter: "unreached", workflowVersion: "wf-9" });

    // The scheme chain AND a transition that opens it. Excluding only the first is what
    // called screens in daily use unreachable.
    expect(calls[0].text).toContain("NOT EXISTS");
    expect(calls[0].text).toContain("snapshot_screen_scheme_operations");
    expect(calls[0].text).toContain("snapshot_transition_screens");
    expect(calls[0].params).toContain("wf-9");
  });

  test("transition-only is the inverse: no scheme, but a transition", async () => {
    const calls = capture();
    await loadScreensPage("scope-1", "v1", { filter: "transition-only", workflowVersion: "wf-9" });
    const clause = calls[0].text;
    expect(clause).toMatch(/NOT EXISTS[\s\S]*snapshot_screen_scheme_operations/);
    expect(clause).toMatch(/AND EXISTS[\s\S]*snapshot_transition_screens/);
  });

  // "We cannot tell" must never render as "none". A reachability filter with no workflow
  // snapshot behind it is dropped, and the caller is told which happened.
  test("drops a reachability filter when there is no workflow snapshot", async () => {
    const calls = capture();
    const result = await loadScreensPage("scope-1", "v1", { filter: "unreached", workflowVersion: null });

    expect(calls[0].text).not.toContain("snapshot_transition_screens");
    expect(result.filter).toBeNull();
    expect(result.filterRequested).toBe("unreached");
  });

  test("reports which filter actually applied", async () => {
    capture();
    const result = await loadScreensPage("scope-1", "v1", { filter: "empty" });
    expect(result).toMatchObject({ filter: "empty", filterLabel: "Carrying no fields", filterRequested: "empty" });
  });

  // A stale deep link should show the unfiltered tab rather than an error page.
  test("ignores an unknown filter rather than rejecting it", async () => {
    const calls = capture();
    const result = await loadScreensPage("scope-1", "v1", { filter: "'; DROP TABLE snapshot_screens; --" });

    expect(calls[0].text).not.toContain("DROP TABLE");
    expect(result.filter).toBeNull();
    expect(result.filterRequested).toBeNull();
  });

  test("combines with search rather than replacing it", async () => {
    const calls = capture();
    await loadScreensPage("scope-1", "v1", { filter: "empty", search: "Bug" });
    expect(calls[0].text).toContain("name LIKE ?");
    expect(calls[0].text).toContain("field_count = 0");
    expect(calls[0].params).toContain("%Bug%");
  });

  test("every filter the Overview can ask for has a label", () => {
    for (const key of ["empty", "unresolved", "unreached", "transition-only"]) {
      expect(SCREEN_FILTERS[key]?.label).toBeTruthy();
    }
  });
});

describe("loadScreenFieldLayout", () => {
  test("one scoped read, grouped per screen in tab and field order", async () => {
    nextRows = [
      { screen_id: "1", tab_id: "t1", field_id: "summary" },
      { screen_id: "1", tab_id: "t2", field_id: "customfield_1" },
      { screen_id: "2", tab_id: "t1", field_id: "description" },
    ];
    const layout = await loadScreenFieldLayout("inst", "v1");
    const q = issued.find((e) => e.statement.includes("FROM snapshot_screen_fields"));
    expect(q.statement).toContain("WHERE scope_key = ? AND version = ?");
    expect(q.statement).toContain("ORDER BY screen_id ASC, tab_index ASC, field_index ASC");
    expect(q.params).toEqual(["inst", "v1"]);
    expect(layout.get("1")).toEqual(["t1:summary", "t2:customfield_1"]);
    expect(layout.get("2")).toEqual(["t1:description"]);
  });
});
