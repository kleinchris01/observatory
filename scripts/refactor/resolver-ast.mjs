// Shared parsing for the resolvers.js split (docs/resolvers-refactor.md). Reads a module's
// top-level statements, what each declares, and which top-level bindings each references.
//
// Text is normalised to LF before parsing so offsets are stable; callers write back with the
// line ending the file had (the working tree is CRLF under core.autocrlf, the index is LF).
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { parse } = require("@babel/parser");
const traverse = require("@babel/traverse").default;

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function readSource(file) {
  const raw = fs.readFileSync(file, "utf8");
  return { text: raw.replace(/\r\n/g, "\n"), crlf: raw.includes("\r\n") };
}

export function writeSource(file, text, crlf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, crlf ? text.replace(/\n/g, "\r\n") : text);
}

export function parseModule(text) {
  return parse(text, { sourceType: "module", plugins: ["jsx"] });
}

// One entry per top-level statement: what it declares, whether it is exported, its span
// including leading comments, and the top-level bindings it references.
export function analyse(text) {
  const ast = parseModule(text);
  const stmts = [];
  const owner = new Map();
  const imports = new Map(); // local name -> { source, imported, kind }
  for (const node of ast.program.body) {
    const st = { node, names: [], exported: false, isImport: false, refs: new Set(), importRefs: new Set() };
    if (node.type === "ImportDeclaration") {
      st.isImport = true;
      for (const sp of node.specifiers) {
        const kind = sp.type === "ImportDefaultSpecifier" ? "default" : sp.type === "ImportNamespaceSpecifier" ? "namespace" : "named";
        imports.set(sp.local.name, { source: node.source.value, imported: kind === "named" ? (sp.imported.name ?? sp.imported.value) : null, kind });
      }
    } else {
      let decl = node;
      if (node.type === "ExportNamedDeclaration" && node.declaration) { decl = node.declaration; st.exported = true; }
      if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") st.names.push(decl.id.name);
      if (decl.type === "VariableDeclaration") {
        for (const d of decl.declarations) {
          if (d.id.type !== "Identifier") throw new Error(`Destructured top-level declaration at line ${node.loc.start.line} is not supported`);
          st.names.push(d.id.name);
        }
      }
    }
    const lead = node.leadingComments?.length ? node.leadingComments[0].start : node.start;
    st.start = lead;
    st.end = node.end;
    stmts.push(st);
    for (const n of st.names) owner.set(n, st);
  }
  const stmtAt = (pos) => stmts.find((s) => pos >= s.node.start && pos < s.node.end);
  traverse(ast, {
    ReferencedIdentifier(p) {
      const b = p.scope.getBinding(p.node.name);
      if (!b || b.scope.block.type !== "Program") return;
      const st = stmtAt(p.node.start);
      if (!st || st.isImport) return;
      if (imports.has(p.node.name)) st.importRefs.add(p.node.name);
      else if (owner.has(p.node.name) && owner.get(p.node.name) !== st) st.refs.add(p.node.name);
    },
    // `export { a, b }` and `export { a } from` -- the first references locals.
    ExportNamedDeclaration(p) {
      if (p.node.declaration || p.node.source) return;
      const st = stmtAt(p.node.start);
      for (const sp of p.node.specifiers) {
        const n = sp.local.name;
        if (imports.has(n)) st.importRefs.add(n);
        else if (owner.has(n)) st.refs.add(n);
      }
    },
  });
  return { ast, stmts, owner, imports };
}

// Every name the module exports, from declarations, `export { … }` and `export { … } from`.
export function exportedNames(text) {
  const { ast } = analyse(text);
  const out = new Set();
  for (const node of ast.program.body) {
    if (node.type !== "ExportNamedDeclaration") continue;
    if (node.declaration) {
      const d = node.declaration;
      if (d.id) out.add(d.id.name);
      else for (const v of d.declarations) out.add(v.id.name);
    }
    for (const sp of node.specifiers || []) out.add(sp.exported.name ?? sp.exported.value);
  }
  return out;
}
