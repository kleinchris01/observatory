import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Scans the committed automation snapshot for credential shapes.
//
// This exists because .gitleaks.toml narrows the generic-api-key detector inside rules/ --
// that heuristic matches orchestration variable ids and JQL text, and a check that always
// fails stops being read. This is the purpose-built replacement: it knows what this data
// actually looks like, so it can be specific where a generic scanner cannot.
//
// It runs on the committed output rather than on the redactor's own report. The redactor
// once reported a clean pass while writing five live webhook tokens into the snapshot,
// because the tokens are stored twice and it only knew about one of the places. Checking
// the artifact is the only check that would have caught that.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RULES_DIR = path.join(REPO_ROOT, "rules");

const PLACEHOLDER = /^\[\[REDACTED:[0-9a-f]{8}\]\]$/;

// Each entry is a shape known to appear in a raw export as a real credential.
const CREDENTIAL_SHAPES = [
  {
    name: "inbound webhook token",
    // Any non-placeholder value on a webhookToken key, or a WEBHOOK_TOKEN tag.
    find(value, key, node) {
      if (/^webhooktoken$/i.test(key) && typeof value === "string" && value && !PLACEHOLDER.test(value)) return value;
      if (node?.tagType === "WEBHOOK_TOKEN" && typeof node.tagValue === "string" && !PLACEHOLDER.test(node.tagValue)) {
        return node.tagValue;
      }
      return null;
    },
  },
  {
    name: "incoming webhook URL with a live path",
    find(value) {
      if (typeof value !== "string") return null;
      const m = value.match(/^https:\/\/(?:hooks\.slack\.com|[a-z0-9-]+\.webhook\.office\.com)\/(.+)$/i);
      // The redactor keeps the origin and replaces the path with a placeholder.
      return m && !PLACEHOLDER.test(m[1]) ? value : null;
    },
  },
  {
    name: "form-encoded secret",
    find(value) {
      if (typeof value !== "string") return null;
      for (const m of value.matchAll(/(?:client_secret|password|api[_-]?key|apikey)=([^&\s"]+)/gi)) {
        const secret = m[1];
        // A smart value is a reference, not a secret, and stays readable by design.
        if (!PLACEHOLDER.test(secret) && !/^\{\{.*\}\}$/.test(secret)) return secret;
      }
      return null;
    },
  },
  {
    name: "literal bearer token",
    find(value) {
      if (typeof value !== "string") return null;
      const m = value.match(/^Bearer\s+(.+)$/i);
      if (!m) return null;
      const token = m[1];
      if (PLACEHOLDER.test(token) || /^\{\{.*\}\}$/.test(token)) return null;
      return token.length >= 16 ? value : null;
    },
  },
  {
    name: "private key block",
    find(value) {
      return typeof value === "string" && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) ? "private key" : null;
    },
  },
];

function scan(node, findings, file, key = "") {
  if (Array.isArray(node)) {
    for (const entry of node) scan(entry, findings, file, key);
    return;
  }
  if (node && typeof node === "object") {
    for (const shape of CREDENTIAL_SHAPES) {
      const hit = shape.find(undefined, "", node);
      if (hit) findings.push({ file, shape: shape.name });
    }
    for (const [k, v] of Object.entries(node)) scan(v, findings, file, k);
    return;
  }
  for (const shape of CREDENTIAL_SHAPES) {
    const hit = shape.find(node, key, null);
    // Never report the value itself -- a failing test's output goes into CI logs.
    if (hit) findings.push({ file, shape: shape.name });
  }
}

const snapshotExists = fs.existsSync(RULES_DIR);

// 30s, not vitest's 5s default. These read and concatenate all ~1,477 committed rule files
// -- roughly 9 MB of synchronous I/O -- then regex-scan the blob. That legitimately takes
// 5-7 seconds, so under a loaded full-suite run it was tipping past the default and failing
// intermittently. A security test that flakes is a security test people learn to ignore,
// which is worse than not having it.
describe.skipIf(!snapshotExists)("committed rule snapshot redaction", { timeout: 30000 }, () => {
  const files = snapshotExists ? fs.readdirSync(RULES_DIR).filter((f) => f.endsWith(".json")) : [];

  it("has a snapshot to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("contains no unredacted credential of any known shape", () => {
    const findings = [];
    for (const file of files) {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(RULES_DIR, file), "utf8"));
      } catch (error) {
        throw new Error(`rules/${file} is not valid JSON: ${error.message}`);
      }
      scan(parsed, findings, file);
    }

    // Reported by file and shape, never by value.
    const summary = findings.map((f) => `${f.file}: ${f.shape}`).sort();
    expect(summary).toEqual([]);
  });

  it("still carries redaction placeholders, so the redactor has not silently stopped", () => {
    const blob = files.map((f) => fs.readFileSync(path.join(RULES_DIR, f), "utf8")).join("\n");
    const placeholders = blob.match(/\[\[REDACTED:[0-9a-f]{8}\]\]/g) || [];

    // A snapshot with zero placeholders means either the estate genuinely has no secrets --
    // possible, and worth noticing -- or the redactor broke. Either way somebody should look.
    expect(placeholders.length).toBeGreaterThan(0);
  });
});
