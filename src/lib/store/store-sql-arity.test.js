import { describe, test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Every INSERT in the store layer, checked for the one defect unit tests structurally cannot see.
//
// `snapshot_filters` listed sixteen columns and supplied sixteen parameters against a template
// of fifteen placeholders. It was written that way and never worked -- but the filter build
// buffered the whole estate before writing, so on a large site it always died at the invocation
// ceiling first and the insert was never reached. Making that build resumable meant it reached
// the insert on its very first chunk, and a latent bug surfaced as "The last build failed:
// Unknown SQL execution error".
//
// No amount of mocking catches this. Every store test mocks @forge/sql, so the SQL string and
// the parameter list are never compared against each other by anything except the database.
// This reads the source, which is the only place the mismatch is visible before production.

const STORE_DIR = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(STORE_DIR).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));

// Pull out (table, columnCount, placeholders) for every INSERT in a file.
//
// Hand-walked rather than done with one large regex: a column list is delimited by the first
// balanced pair after the table name, and a regex spanning INSERT to VALUES will happily run
// past the end of one statement into the next -- which is how the first version of this test
// reported a table with 453 columns.
//
// A batched INSERT takes its placeholders from the template built immediately above it, so a
// dynamic VALUES resolves against the NEAREST PRECEDING template rather than "the template in
// this file". Several store modules build three or four in a row.
function findInserts(source) {
  const found = [];
  const templates = [...source.matchAll(/=> "(\([^"]*\))"/g)].map((m) => ({
    at: m.index,
    count: (m[1].match(/\?/g) || []).length,
  }));

  for (const match of source.matchAll(/INSERT\s+(?:IGNORE\s+)?INTO\s+(\w+)/g)) {
    const table = match[1];
    const open = source.indexOf("(", match.index + match[0].length);
    if (open === -1) continue;
    const close = source.indexOf(")", open);
    if (close === -1) continue;

    const columns = source
      .slice(open + 1, close)
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);

    // Column lists are plain identifiers. Anything else means this was not a column list --
    // an INSERT ... SELECT, say -- and guessing at it would produce noise, not findings.
    if (!columns.every((c) => /^[a-z_][a-z0-9_]*$/i.test(c))) continue;

    const tail = source.slice(close + 1, close + 400);
    const valuesAt = tail.indexOf("VALUES");
    if (valuesAt === -1) continue;
    const afterValues = tail.slice(valuesAt + "VALUES".length).trimStart();

    let placeholders = null;
    if (afterValues.startsWith("(")) {
      const literal = afterValues.slice(0, afterValues.indexOf(")") + 1);
      if (!literal.includes("$")) placeholders = (literal.match(/\?/g) || []).length;
    } else if (afterValues.startsWith("${")) {
      const preceding = templates.filter((t) => t.at < match.index);
      if (preceding.length) placeholders = preceding[preceding.length - 1].count;
    }

    if (placeholders === null || placeholders === 0) continue;
    found.push({ table, columns: columns.length, placeholders });
  }
  return found;
}

describe("store SQL placeholder arity", () => {
  const findings = [];
  let inspected = 0;

  for (const file of files) {
    const source = fs.readFileSync(path.join(STORE_DIR, file), "utf8");
    for (const insert of findInserts(source)) {
      inspected += 1;
      if (insert.placeholders !== insert.columns) findings.push({ file, ...insert });
    }
  }

  test("every INSERT supplies one placeholder per column", () => {
    expect(findings).toEqual([]);
  });

  // Guards the guard. A parser that quietly stopped matching would make the test above pass by
  // finding nothing at all, which is the failure mode of every test that reads source code.
  test("actually inspected the inserts it claims to cover", () => {
    expect(inspected).toBeGreaterThan(8);
  });
});
