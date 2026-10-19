import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

// The Rovo agents read as one product only if every prompt file starts from the same
// contract. This test is the thing that stops one pillar's prompt quietly drifting off it,
// and stops the manifest and the prompt files disagreeing about which agents exist.

const ROOT = process.cwd();
const PROMPT_DIR = resolve(ROOT, "resource/agent/prompts");
const MANIFEST = resolve(ROOT, "manifest.yml");

// A distinctive sentence from resource/agent/prompts/_preamble.md. If the preamble is
// reworded, update this and re-apply the preamble to every prompt file in the same change.
const PREAMBLE_MARKER = 'For any "does anything use / reference / depend on X" question there are three different';

const promptFiles = () => readdirSync(PROMPT_DIR).filter((f) => f.endsWith(".txt"));

describe("agent prompt files", () => {
  test("the canonical preamble exists", () => {
    expect(existsSync(join(PROMPT_DIR, "_preamble.md"))).toBe(true);
  });

  test("there is at least one pillar prompt", () => {
    expect(promptFiles().length).toBeGreaterThan(0);
  });

  test.each(promptFiles())("%s begins from the shared preamble", (file) => {
    const text = readFileSync(join(PROMPT_DIR, file), "utf8");
    expect(text).toContain(PREAMBLE_MARKER);
    expect(text).toContain("read-only Jira governance app");
    // The pillar-specific section comes after the preamble, never instead of it.
    expect(text.length - text.indexOf(PREAMBLE_MARKER)).toBeGreaterThan(200);
  });
});

describe("manifest <-> prompt files agree on the agent set", () => {
  const manifestText = readFileSync(MANIFEST, "utf8");
  // Dependency-free: pull the prompt-resource references straight out of the manifest text.
  const referenced = [...manifestText.matchAll(/prompt:\s*resource:agent-resources;prompts\/([a-z0-9-]+\.txt)/g)].map(
    (m) => m[1],
  );
  const agentKeys = [...manifestText.matchAll(/-\s*key:\s*(observatory-[a-z]+-expert)\b/g)].map((m) => m[1]);

  test("every declared agent key is observatory-<pillar>-expert", () => {
    expect(agentKeys.length).toBeGreaterThan(0);
    for (const key of agentKeys) expect(key).toMatch(/^observatory-[a-z]+-expert$/);
  });

  test("every referenced prompt resource exists on disk", () => {
    expect(referenced.length).toBeGreaterThan(0);
    for (const file of referenced) {
      expect(existsSync(join(PROMPT_DIR, file))).toBe(true);
    }
  });

  test("every pillar prompt file (*.txt) backs a declared agent", () => {
    const set = new Set(referenced);
    for (const file of promptFiles()) {
      expect(set.has(file)).toBe(true);
    }
  });

  test("one agent per prompt file -- no duplicates", () => {
    expect(new Set(referenced).size).toBe(referenced.length);
  });
});
