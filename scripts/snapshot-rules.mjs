#!/usr/bin/env node
//
// Turn a raw Jira Automation export into the committed per-rule snapshot under rules/.
//
//   npm run rules:snapshot -- automation-rules-202608060201.json
//
// One file per rule, keyed on rule id, normalized and redacted by src/lib/rule-snapshot.js.
// Rules that disappeared from the export have their files deleted, so `git status` alone
// describes the week: added files are new rules, deleted files are removed rules, modified
// files are edits.
//
// The raw export is gitignored and must stay that way -- it contains live credentials.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, findSecrets, ruleFileName, serializeRule } from "../src/lib/rule-snapshot.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { exportPath: null, outDir: path.join(REPO_ROOT, "rules"), dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") args.outDir = path.resolve(argv[++i]);
    else if (arg === "--dry-run") args.dryRun = true;
    else if (!args.exportPath) args.exportPath = path.resolve(arg);
  }
  return args;
}

function fail(message) {
  console.error(`\nsnapshot-rules: ${message}\n`);
  process.exit(1);
}

function main() {
  const { exportPath, outDir, dryRun } = parseArgs(process.argv.slice(2));
  if (!exportPath) fail("usage: snapshot-rules <export.json> [--out rules] [--dry-run]");
  if (!fs.existsSync(exportPath)) fail(`export not found: ${exportPath}`);

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(exportPath, "utf8"));
  } catch (error) {
    fail(`export is not valid JSON: ${error.message}`);
  }

  const rules = payload?.rules;
  // Guard against writing an empty snapshot from a truncated or unexpected file. Deleting
  // 1477 rule files because someone passed the wrong path is not a recoverable mistake in
  // a review, because the diff is too large to read.
  if (!Array.isArray(rules) || rules.length === 0) {
    fail("export contains no `rules` array -- refusing to write an empty snapshot");
  }
  const missingIds = rules.filter((r) => r?.id === undefined || r?.id === null).length;
  if (missingIds > 0) fail(`${missingIds} rules have no id and cannot be keyed to a file`);

  const ids = new Set(rules.map((r) => String(r.id)));
  if (ids.size !== rules.length) fail(`export contains duplicate rule ids (${rules.length} rules, ${ids.size} unique)`);

  fs.mkdirSync(outDir, { recursive: true });

  const existing = new Set(fs.readdirSync(outDir).filter((f) => f.endsWith(".json") && f !== "_manifest.json"));

  let added = 0;
  let changed = 0;
  let unchanged = 0;
  const secretCounts = new Map();

  for (const rule of rules) {
    for (const { kind } of findSecrets(rule)) {
      secretCounts.set(kind, (secretCounts.get(kind) || 0) + 1);
    }

    const fileName = ruleFileName(rule);
    const target = path.join(outDir, fileName);
    const next = serializeRule(rule);
    const prior = existing.has(fileName) ? fs.readFileSync(target, "utf8") : null;

    if (prior === null) added += 1;
    else if (prior !== next) changed += 1;
    else unchanged += 1;

    if (!dryRun && prior !== next) fs.writeFileSync(target, next, "utf8");
    existing.delete(fileName);
  }

  // Whatever is left in `existing` was not in this export.
  const removed = [...existing];
  for (const fileName of removed) {
    if (!dryRun) fs.unlinkSync(path.join(outDir, fileName));
  }

  const manifest = buildManifest({
    rules,
    connections: payload.connections || [],
    cloud: payload.cloud ?? null,
    // The export carries no timestamp of its own, so the source file's mtime is the best
    // available answer to "when was this taken".
    exportedAt: fs.statSync(exportPath).mtime.toISOString(),
  });
  if (!dryRun) {
    fs.writeFileSync(path.join(outDir, "_manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  const rel = path.relative(REPO_ROOT, outDir) || outDir;
  console.log(`\nsnapshot-rules${dryRun ? " (dry run)" : ""} -> ${rel}/`);
  console.log(
    `  ${rules.length} rules in export (${manifest.enabledCount} enabled, ${manifest.disabledCount} disabled)`,
  );
  console.log(`  added     ${added}`);
  console.log(`  changed   ${changed}`);
  console.log(`  removed   ${removed.length}`);
  console.log(`  unchanged ${unchanged}`);

  // Printed every run. A week where this suddenly reads 0 means either the rules were
  // cleaned up or the redaction stopped matching -- both worth knowing, and silence would
  // hide the second.
  console.log("\n  redacted secrets:");
  if (secretCounts.size === 0) {
    console.log("    none detected");
  } else {
    for (const [kind, count] of [...secretCounts].sort()) {
      console.log(`    ${kind.padEnd(22)} ${count}`);
    }
  }
  console.log("");
}

main();
