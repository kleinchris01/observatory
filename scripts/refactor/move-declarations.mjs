// Moves top-level declarations out of src/resolvers.js into a new module under src/resolvers/,
// without changing a character of the moved code. See docs/resolvers-refactor.md.
//
//   node scripts/refactor/move-declarations.mjs --to src/resolvers/admin-guard.js \
//     --names withAdminGuard,withAuditTrail,... [--header "One-line description"]
//     [--leave-comments name1,name2] [--accept-comments] [--statements line,line] [--dry-run]
//
// --leave-comments: for the named declarations, only the comment group directly above the
// code moves (the last run of comments after a blank line); earlier groups stay in
// resolvers.js. For file-level notes Babel attaches to whichever statement follows them.
//
// What it does:
//   - cuts each named statement (with its leading comments) from resolvers.js;
//   - writes them, in their original order, to the target module, adding `export` to each;
//   - gives the target module exactly the imports its code references, paths rewritten;
//   - in resolvers.js, imports back the moved names that remaining code still uses,
//     re-exports the ones that were public, and drops imports nothing references any more.
//
// It refuses (and changes nothing) when the moved code references a declaration that would
// stay behind in resolvers.js: that would be an import cycle. Move that dependency first, or
// with it. That rule is what makes the extraction order leaves-first.
import fs from "node:fs";
import path from "node:path";
import { ROOT, readSource, writeSource, analyse } from "./resolver-ast.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, []),
);
const SRC = path.join(ROOT, "src/resolvers.js");
const target = path.join(ROOT, args.to);
const names = String(args.names || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (!args.to || !names.length) throw new Error("--to and --names are required");
if (fs.existsSync(target)) throw new Error(`${args.to} already exists; move a module's declarations in one run`);

const { text, crlf } = readSource(SRC);
const { stmts, owner, imports } = analyse(text);

// ---- What moves ---------------------------------------------------------------------------
const moving = new Set();
for (const n of names) {
  const st = owner.get(n);
  if (!st) throw new Error(`No top-level declaration named ${n} in src/resolvers.js`);
  moving.add(st);
}
// Nameless top-level statements (e.g. `Object.assign(TABLE, {...})`) cannot be named, so they
// are picked by the line their code starts on: --statements 1561,1720.
const statementLines = String(args.statements || "")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter(Boolean);
const lineOf = (pos) => text.slice(0, pos).split("\n").length;
for (const line of statementLines) {
  const st = stmts.find((s) => !s.names.length && !s.isImport && lineOf(s.node.start) === line);
  if (!st) throw new Error(`No nameless top-level statement starts on line ${line}`);
  if (st.node.type !== "ExpressionStatement")
    throw new Error(`Line ${line} is a ${st.node.type}; only expression statements can be moved this way`);
  moving.add(st);
}
for (const st of moving) {
  const missing = st.names.filter((n) => !names.includes(n));
  if (missing.length) throw new Error(`${st.names[0]} is declared together with ${missing.join(", ")}; name them too`);
}
const moved = stmts.filter((s) => moving.has(s)); // original order
const leaveComments = new Set(
  String(args["leave-comments"] || "")
    .split(",")
    .filter(Boolean),
);
for (const st of moved) {
  if (!st.names.some((n) => leaveComments.has(n))) continue;
  const lead = text.slice(st.start, st.node.start);
  const cut = lead.trimEnd().lastIndexOf("\n\n");
  if (cut > -1) st.start += cut + 2;
}
// A statement whose leading comments hold more than one blank-line-separated group may be
// carrying a comment that belongs to the file or to a neighbour. Report each so a person
// decides, via --leave-comments, before anything is written.
const multiGroup = moved
  .map((st) => ({
    st,
    groups: text
      .slice(st.start, st.node.start)
      .trimEnd()
      .split(/\n\s*\n/)
      .filter((g) => g.trim()),
  }))
  .filter(({ groups }) => groups.length > 1);
for (const { st, groups } of multiGroup) {
  console.warn(
    `! ${st.names[0]} carries ${groups.length} comment groups; all move unless --leave-comments ${st.names[0]}:`,
  );
  for (const g of groups) console.warn(`    | ${g.trim().split("\n")[0].slice(0, 100)}`);
}
if (multiGroup.length && !args["accept-comments"] && !args["dry-run"]) {
  throw new Error("Review the comment groups above, then rerun with --leave-comments and/or --accept-comments");
}

const leftBehind = new Map();
for (const st of moved)
  for (const r of st.refs)
    if (!moving.has(owner.get(r))) {
      if (!leftBehind.has(r)) leftBehind.set(r, new Set());
      leftBehind.get(r).add(st.names[0]);
    }
if (leftBehind.size) {
  const lines = [...leftBehind].map(
    ([dep, users]) =>
      `  ${dep} (line ${text.slice(0, owner.get(dep).node.start).split("\n").length}) <- ${[...users].join(", ")}`,
  );
  throw new Error(
    `Moved code depends on declarations that would stay in resolvers.js (import cycle):\n${lines.join("\n")}`,
  );
}

// ---- The new module -----------------------------------------------------------------------
const targetDir = path.dirname(target);
const rel = (source) => {
  if (!source.startsWith(".")) return source;
  let r = path.relative(targetDir, path.resolve(path.dirname(SRC), source)).replace(/\\/g, "/");
  return r.startsWith(".") ? r : `./${r}`;
};
const usedImports = new Set(moved.flatMap((s) => [...s.importRefs]));
const bySource = new Map(); // keep resolvers.js's import order
for (const [local, info] of imports) {
  if (!usedImports.has(local)) continue;
  if (!bySource.has(info.source)) bySource.set(info.source, { def: null, ns: null, named: [] });
  const g = bySource.get(info.source);
  if (info.kind === "default") g.def = local;
  else if (info.kind === "namespace") g.ns = local;
  else g.named.push(info.imported === local ? local : `${info.imported} as ${local}`);
}
const importLines = [...bySource].map(([source, g]) => {
  const parts = [];
  if (g.def) parts.push(g.def);
  if (g.ns) parts.push(`* as ${g.ns}`);
  if (g.named.length) {
    const list = g.named.length > 3 ? `{\n${g.named.map((n) => `  ${n},`).join("\n")}\n}` : `{ ${g.named.join(", ")} }`;
    parts.push(list);
  }
  return `import ${parts.join(", ")} from "${rel(source)}";`;
});
const body = moved.map((st) => {
  const comments = text.slice(st.start, st.node.start);
  const code = text.slice(st.node.start, st.end);
  return comments + (st.exported || !st.names.length ? code : `export ${code}`);
});
const header = args.header
  ? `// ${args.header}\n//\n// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.\n\n`
  : "";
const moduleText = `${header}${importLines.join("\n")}\n\n${body.join("\n\n")}\n`;

// ---- resolvers.js -------------------------------------------------------------------------
// Cut each moved statement from the start of its first line through its trailing newline,
// plus one blank separator line, so the gaps close up cleanly.
let out = text;
for (const st of [...moved].reverse()) {
  let a = out.lastIndexOf("\n", st.start - 1) + 1;
  let b = out.indexOf("\n", st.end);
  b = b === -1 ? out.length : b + 1;
  if (out.slice(b).startsWith("\n") && (a === 0 || out.slice(0, a).endsWith("\n\n"))) b += 1;
  out = out.slice(0, a) + out.slice(b);
}

const movedNames = moved.flatMap((s) => s.names);
const stillUsed = new Set(
  stmts
    .filter((s) => !moving.has(s))
    .flatMap((s) => [...s.refs])
    .filter((r) => movedNames.includes(r)),
);
const wasPublic = moved.filter((s) => s.exported).flatMap((s) => s.names);
const modPath = `./${path.relative(path.dirname(SRC), target).replace(/\\/g, "/")}`;
const newLines = [];
const fmt = (list) => (list.length > 3 ? `{\n${list.map((n) => `  ${n},`).join("\n")}\n}` : `{ ${list.join(", ")} }`);
const keep = movedNames.filter((n) => stillUsed.has(n));
if (keep.length) newLines.push(`import ${fmt(keep)} from "${modPath}";`);
if (wasPublic.length) newLines.push(`export ${fmt(wasPublic)} from "${modPath}";`);

// Insert after the last import declaration.
let after = analyse(out);
const lastImport = after.stmts.filter((s) => s.isImport).at(-1);
if (newLines.length) out = out.slice(0, lastImport.end) + "\n" + newLines.join("\n") + out.slice(lastImport.end);

// Drop import specifiers nothing references any more.
after = analyse(out);
const referenced = new Set(after.stmts.flatMap((s) => [...s.importRefs]));
const edits = [];
for (const st of after.stmts.filter((s) => s.isImport)) {
  const node = st.node;
  if (node.source.value === modPath) continue;
  const dead = node.specifiers.filter((sp) => !referenced.has(sp.local.name));
  if (!dead.length) continue;
  const declText = out.slice(node.start, node.end);
  if (/\/\/|\/\*/.test(declText)) {
    console.warn(
      `! left unused imports in place (comment inside): ${dead.map((d) => d.local.name).join(", ")} from ${node.source.value}`,
    );
    continue;
  }
  const live = node.specifiers.filter((sp) => referenced.has(sp.local.name));
  let replacement = "";
  if (live.length) {
    const def = live.find((sp) => sp.type === "ImportDefaultSpecifier");
    const ns = live.find((sp) => sp.type === "ImportNamespaceSpecifier");
    const named = live.filter((sp) => sp.type === "ImportSpecifier").map((sp) => out.slice(sp.start, sp.end));
    const parts = [];
    if (def) parts.push(def.local.name);
    if (ns) parts.push(`* as ${ns.local.name}`);
    if (named.length)
      parts.push(
        declText.includes("\n") ? `{\n${named.map((n) => `  ${n},`).join("\n")}\n}` : `{ ${named.join(", ")} }`,
      );
    replacement = `import ${parts.join(", ")} from "${node.source.value}";`;
  }
  edits.push({ start: node.start, end: node.end, replacement, dead: dead.map((d) => d.local.name) });
}
for (const e of edits.sort((x, y) => y.start - x.start)) {
  let { start, end } = e;
  if (!e.replacement) {
    start = out.lastIndexOf("\n", start - 1) + 1;
    end = out.indexOf("\n", end) + 1;
  }
  out = out.slice(0, start) + e.replacement + out.slice(end);
}

// ---- Report / write -----------------------------------------------------------------------
const lineCount = (t) => t.split("\n").length;
console.log(
  `moving ${movedNames.length} declarations (${moved.reduce((n, s) => n + lineCount(text.slice(s.start, s.end)), 0)} lines) -> ${args.to}`,
);
console.log(`  imports in new module: ${[...bySource.keys()].map(rel).join(", ") || "none"}`);
console.log(`  imported back into resolvers.js: ${keep.join(", ") || "none"}`);
console.log(`  re-exported from resolvers.js: ${wasPublic.join(", ") || "none"}`);
for (const e of edits) console.log(`  dropped unused import(s): ${e.dead.join(", ")}`);
console.log(`  resolvers.js: ${lineCount(text)} -> ${lineCount(out)} lines`);
if (args["dry-run"]) {
  console.log("(dry run: nothing written)");
  process.exit(0);
}
writeSource(target, moduleText, crlf);
writeSource(SRC, out, crlf);
