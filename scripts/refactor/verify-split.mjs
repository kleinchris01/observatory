// Proves a resolvers.js split moved code without changing it. See docs/resolvers-refactor.md.
//
//   node scripts/refactor/verify-split.mjs [--base master]
//
// Compares src/resolvers.js at --base against the working tree's src/resolvers.js plus every
// module under src/resolvers/, and fails unless:
//   1. every top-level declaration at base exists exactly once now, and its source text is
//      identical apart from an added `export` keyword;
//   2. no declaration exists now that did not exist at base;
//   3. src/resolvers.js exports exactly the names it exported at base.
// Imports are not compared: they are regenerated per module, and a missing one fails the
// module's own load in the test suite.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, readSource, analyse, exportedNames } from "./resolver-ast.mjs";

const baseIdx = process.argv.indexOf("--base");
const base = baseIdx > -1 ? process.argv[baseIdx + 1] : "master";

const baseText = execFileSync("git", ["show", `${base}:src/resolvers.js`], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 }).replace(/\r\n/g, "\n");
const files = [path.join(ROOT, "src/resolvers.js")];
const dir = path.join(ROOT, "src/resolvers");
if (fs.existsSync(dir)) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js") && !e.name.endsWith(".test.js")) files.push(p);
  });
  walk(dir);
}

const declText = (text, st) => {
  const node = st.node.type === "ExportNamedDeclaration" && st.node.declaration ? st.node.declaration : st.node;
  return text.slice(node.start, node.end);
};
const collect = (text, where) => analyse(text).stmts.filter((s) => s.names.length).map((s) => ({ key: s.names.join(","), code: declText(text, s), where }));

const before = new Map(collect(baseText, `${base}:src/resolvers.js`).map((d) => [d.key, d]));
const now = new Map();
const problems = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, "/");
  for (const d of collect(readSource(f).text, rel)) {
    if (now.has(d.key)) problems.push(`${d.key} is declared twice: ${now.get(d.key).where} and ${rel}`);
    now.set(d.key, d);
  }
}
let moved = 0;
for (const [key, d] of before) {
  const n = now.get(key);
  if (!n) { problems.push(`${key} is missing`); continue; }
  if (n.code !== d.code) problems.push(`${key} changed (now in ${n.where})`);
  if (n.where !== "src/resolvers.js") moved++;
}
for (const key of now.keys()) if (!before.has(key)) problems.push(`${key} is new (in ${now.get(key).where})`);

const exBefore = exportedNames(baseText);
const exNow = exportedNames(readSource(files[0]).text);
for (const n of exBefore) if (!exNow.has(n)) problems.push(`src/resolvers.js no longer exports ${n}`);
for (const n of exNow) if (!exBefore.has(n)) problems.push(`src/resolvers.js now also exports ${n}`);

const lines = (t) => t.split("\n").length;
console.log(`base ${base}: ${before.size} declarations, ${exBefore.size} exports, ${lines(baseText)} lines`);
console.log(`now: ${moved} declarations moved into ${files.length - 1} module(s); src/resolvers.js is ${lines(readSource(files[0]).text)} lines`);
if (problems.length) {
  console.error(`\nFAILED (${problems.length}):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("OK: every declaration is present once and unchanged; the export surface is identical.");
