import { vi, describe, test, expect } from "vitest";

// Schema-consistency tests for the migration list.
//
// These do not exercise the runner (project-store.migrations.test.js does that). They read
// the enqueued SQL as text and check it against itself, catching a class of bug that no
// amount of runtime testing against an existing database can find: a migration that only
// fails on a database created from scratch.
//
// The mock records what project-store.js enqueues instead of discarding it, which is the
// whole point of a separate file -- the runner tests need an enqueue that returns the
// runner and nothing more.

const enqueued = [];

vi.mock("@forge/sql", () => {
  const runner = {
    enqueue: (name, sqlText) => {
      enqueued.push({ name, sql: sqlText });
      return runner;
    },
    run: vi.fn().mockResolvedValue(undefined),
  };
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

// Importing for the module-level side effect: the migration list is built as
// project-store.js evaluates, so `enqueued` is populated by the time the tests run.
await import("./project-store.js");

const NON_COLUMN_TOKENS = new Set(["PRIMARY", "KEY", "UNIQUE", "INDEX", "CONSTRAINT", "FOREIGN"]);

// Column names declared inside a CREATE TABLE body. Deliberately simple line-based
// parsing -- these constants are hand-written one-column-per-line, and a parser clever
// enough for arbitrary SQL would be harder to trust than the thing it checks.
function columnsInCreate(sqlText) {
  const body = sqlText.slice(sqlText.indexOf("(") + 1, sqlText.lastIndexOf(")"));
  const columns = new Set();
  for (const rawLine of body.split("\n")) {
    const first = rawLine.trim().split(/[\s(]/)[0].replace(/,$/, "");
    if (first && !NON_COLUMN_TOKENS.has(first.toUpperCase())) columns.add(first.toLowerCase());
  }
  return columns;
}

const creates = new Map();
for (const { sql: sqlText } of enqueued) {
  const match = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)/i.exec(sqlText);
  if (match) creates.set(match[1].toLowerCase(), columnsInCreate(sqlText));
}

const addColumns = enqueued
  .map(({ name, sql: sqlText }) => {
    const match = /ALTER TABLE (\w+)\s+ADD COLUMN\s+(IF NOT EXISTS\s+)?(\w+)/i.exec(sqlText);
    return match
      ? { name, table: match[1].toLowerCase(), guarded: Boolean(match[2]), column: match[3].toLowerCase() }
      : null;
  })
  .filter(Boolean);

describe("migration schema consistency", () => {
  test("the list actually parsed", () => {
    // Guards the guard: if enqueue's shape ever changes, the checks below would vacuously
    // pass over an empty list rather than failing.
    expect(creates.size).toBeGreaterThan(5);
    expect(addColumns.length).toBeGreaterThan(10);
  });

  // The rule, stated positively. A bare ADD COLUMN is a latent fresh-install failure even
  // when it does not collide today, because the column it adds is normally also appended
  // to the CREATE TABLE constant -- at which point it starts colliding.
  test("every ADD COLUMN migration is idempotent", () => {
    const bare = addColumns.filter((entry) => !entry.guarded).map((entry) => entry.name);
    expect(bare, `these ALTERs need "ADD COLUMN IF NOT EXISTS": ${bare.join(", ")}`).toEqual([]);
  });

  // The specific failure mode, checked directly: on a fresh database the CREATE runs first
  // and already produces these columns, so an unguarded ALTER aborts the whole run.
  test("no unguarded ADD COLUMN targets a column its CREATE TABLE already declares", () => {
    const collisions = addColumns
      .filter((entry) => !entry.guarded && creates.get(entry.table)?.has(entry.column))
      .map((entry) => `${entry.name} (${entry.table}.${entry.column})`);
    expect(collisions, `fresh-install breakage: ${collisions.join(", ")}`).toEqual([]);
  });

  // Regression test for the reported incident: staging died on this exact migration
  // because CREATE_SNAPSHOT_META_TABLE has declared job_token since the initial commit.
  test("v010 is guarded, and its column is one the CREATE already declares", () => {
    const v010 = addColumns.find((entry) => entry.name.startsWith("v010_"));
    expect(v010).toBeDefined();
    expect(v010.guarded).toBe(true);
    expect(creates.get("snapshot_meta").has("job_token")).toBe(true);
  });
});

// Forge SQL rejects a placeholder in LIMIT, failing with an opaque "Unknown SQL execution
// error". The audit viewer shipped with `LIMIT ?` and never worked. This scans the
// storage modules as text so the pattern cannot come back.
describe("SQL dialect constraints", () => {
  test("no query binds LIMIT as a parameter", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = "src/lib/store";
    const offenders = [];

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".js")) continue;
      const text = fs.readFileSync(path.join(dir, file), "utf-8");
      // Ignore the comment that explains the rule.
      for (const line of text.split("\n")) {
        if (line.trim().startsWith("//")) continue;
        if (/limit\s+\?/i.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }

    expect(offenders, `LIMIT must be interpolated from a clamped integer: ${offenders.join(" | ")}`).toEqual([]);
  });
});
