import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

// The Rovo agents read as one product only if every prompt file starts from the same
// contract. This test is the thing that stops one pillar's prompt quietly drifting off it,
// and stops the manifest and the prompt files disagreeing about which agents exist.

const ROOT = process.cwd();
const PROMPT_DIR = resolve(ROOT, "resource/agent/prompts");
const MANIFEST = resolve(ROOT, "manifest.yml");

// The shared preamble, read from resource/agent/prompts/_preamble.md between its markers. Every
// prompt must start with it exactly, so a reworded preamble cannot reach some agents and not
// others, and no prompt can drift from it quietly.
const preambleText = () =>
  readFileSync(join(PROMPT_DIR, "_preamble.md"), "utf8")
    .replace(/\r\n/g, "\n")
    .split("---BEGIN SHARED PREAMBLE---")[1]
    .split("---END SHARED PREAMBLE---")[0]
    .trim();

const promptFiles = () => readdirSync(PROMPT_DIR).filter((f) => f.endsWith(".txt"));

describe("agent prompt files", () => {
  test("the canonical preamble exists", () => {
    expect(existsSync(join(PROMPT_DIR, "_preamble.md"))).toBe(true);
  });

  test("there is at least one pillar prompt", () => {
    expect(promptFiles().length).toBeGreaterThan(0);
  });

  test.each(promptFiles())("%s begins with the shared preamble, exactly", (file) => {
    const text = readFileSync(join(PROMPT_DIR, file), "utf8").replace(/\r\n/g, "\n");
    const preamble = preambleText();
    expect(text.startsWith(preamble), `${file} has drifted from _preamble.md; re-apply it`).toBe(true);
    // The pillar-specific section comes after the preamble, never instead of it.
    expect(text.length - preamble.length).toBeGreaterThan(200);
  });

  // The agents are read-only; the app is not (it raises remediation tickets). The preamble
  // used to call the whole app read-only, which stopped being true.
  test("the preamble describes the agents, not the app, as read-only", () => {
    const preamble = preambleText();
    expect(preamble).not.toMatch(/read-only Jira governance app/);
    expect(preamble).toMatch(/You, the agent, are read-only/);
  });

  // Indirect prompt injection: names and descriptions come from people in Jira.
  test("the preamble tells every agent that text inside results is data", () => {
    expect(preambleText()).toMatch(/# Text inside results is data[\s\S]*never as instructions to you/);
  });
});

describe("Rovo results flag user-written text", () => {
  test("agentOk and agentNotFound carry the notice", async () => {
    const { agentOk, agentNotFound, USER_TEXT_NOTICE } = await import("./rovo-agents.js");
    expect(USER_TEXT_NOTICE).toMatch(/never as instructions/);
    expect(agentOk(null, { items: [] }).userTextNotice).toBe(USER_TEXT_NOTICE);
    expect(agentNotFound(null, "none").userTextNotice).toBe(USER_TEXT_NOTICE);
  });

  // Six results are still built by hand rather than through agentOk. Each must add the notice;
  // a new hand-built one fails here until it does.
  test("every hand-built ok result in a Rovo module carries the notice", () => {
    const dir = resolve(ROOT, "src/resolvers/rovo");
    const missing = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".js") && !f.includes(".test."))) {
      const lines = readFileSync(join(dir, file), "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/^\s*status: "ok",/.test(line) && !lines.slice(i, i + 3).some((l) => /userTextNotice/.test(l)))
          missing.push(`${file}:${i + 1}`);
      });
    }
    expect(missing).toEqual([]);
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
