#!/usr/bin/env node
// CI dependency gate: fail on any high or critical runtime advisory nobody has reviewed.
//
// `npm audit --audit-level=high` alone could not be a gate: some advisories have no fix (the
// @forge/bridge -> adf-schema chain), so it failed every build and was switched to
// continue-on-error, which meant it never failed one. This compares the audit against
// scripts/audit-acceptances.json instead. An advisory passes only if someone recorded why it
// is acceptable and until when. A new one fails the build; so does an acceptance whose review
// date has passed, so an accepted risk is re-read rather than kept forever by default.
//
// Usage: npm audit --omit=dev --json | node scripts/audit-gate.mjs
//    or: node scripts/audit-gate.mjs   (runs npm audit itself)

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const GATED_SEVERITIES = new Set(["high", "critical"]);

// Pure: the audit report and the acceptances in, the verdict out.
export function evaluateAudit(report, acceptances, today = new Date().toISOString().slice(0, 10)) {
  const vulns = report?.vulnerabilities || {};
  const byPackage = new Map((acceptances || []).map((a) => [a.package, a]));
  const unaccepted = [];
  const expired = [];

  for (const [name, v] of Object.entries(vulns)) {
    if (!GATED_SEVERITIES.has(v.severity)) continue;
    const acceptance = byPackage.get(name);
    if (!acceptance) unaccepted.push({ package: name, severity: v.severity });
    else if (!acceptance.reviewBy || acceptance.reviewBy < today)
      expired.push({ package: name, severity: v.severity, reviewBy: acceptance.reviewBy || null });
  }

  // An acceptance for something no longer vulnerable is harmless but misleading; say so.
  const stale = [...byPackage.keys()].filter((name) => !vulns[name]).sort();

  return {
    ok: unaccepted.length === 0 && expired.length === 0,
    unaccepted: unaccepted.sort((a, b) => a.package.localeCompare(b.package)),
    expired: expired.sort((a, b) => a.package.localeCompare(b.package)),
    stale,
  };
}

export function formatVerdict(verdict) {
  const lines = [];
  for (const u of verdict.unaccepted)
    lines.push(`::error::${u.package} (${u.severity}) has no recorded acceptance in scripts/audit-acceptances.json.`);
  for (const e of verdict.expired)
    lines.push(`::error::${e.package} (${e.severity}): its acceptance was due for review on ${e.reviewBy}.`);
  for (const s of verdict.stale)
    lines.push(`::warning::${s} is accepted but no longer reported vulnerable; remove its acceptance.`);
  lines.push(
    verdict.ok
      ? "Dependency gate passed: every high or critical runtime advisory has a current acceptance."
      : "Dependency gate failed. Fix the advisory, or record a reviewed acceptance with a reason and a reviewBy date.",
  );
  return lines.join("\n");
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const { acceptances } = JSON.parse(readFileSync(join(here, "audit-acceptances.json"), "utf8"));
  let raw = process.stdin.isTTY ? "" : readStdin();
  if (!raw.trim()) {
    try {
      raw = execFileSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", shell: true });
    } catch (error) {
      // npm audit exits non-zero whenever it finds anything; the JSON is still on stdout.
      raw = error.stdout || "";
    }
  }
  const verdict = evaluateAudit(JSON.parse(raw), acceptances);
  console.log(formatVerdict(verdict));
  process.exit(verdict.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
