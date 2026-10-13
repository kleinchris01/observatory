import { describe, test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Every name imported from project-store.js must really be exported by it.
//
// Unit tests mock project-store.js wholesale, so a mock can supply a name the real module does
// not have -- and the bundle then fails at deploy. That happened on 7 Oct 2026: drift-engine.js
// imported readAutomationPart from project-store.js (it lives in store/automation.js and is not
// re-exported), every test passed, and the development deploy failed to bundle.
//
// This file deliberately has no vi.mock, so it sees the real module.

const SRC = path.resolve(__dirname, "..");

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    return /\.js$/.test(entry.name) && !/\.test\.js$/.test(entry.name) ? [full] : [];
  });
}

describe("project-store imports", () => {
  test("every imported name exists on the real module", async () => {
    const real = await import("./project-store.js");
    const missing = [];
    for (const file of sourceFiles(SRC)) {
      const text = fs.readFileSync(file, "latin1");
      for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']*project-store\.js)["']/g)) {
        const names = match[1].split(",")
          .map((part) => part.replace(/\/\/.*$/gm, "").trim().split(/\s+as\s+/)[0].trim())
          .filter(Boolean);
        for (const name of names) {
          if (!(name in real)) missing.push(`${path.relative(SRC, file)}: ${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  // Loads the real store module and reads every source file: slow under coverage
  // instrumentation, so it gets a generous timeout rather than the 5s default.
  }, 60000);
});
