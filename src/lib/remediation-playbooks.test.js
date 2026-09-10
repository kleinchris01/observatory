import { describe, it, expect } from "vitest";
import {
  REMEDIATION_PLAYBOOKS,
  getPlaybook,
  listPlaybookKeys,
} from "./remediation-playbooks.js";
import { HEALTH_PILLARS } from "./health-score.js";

const KEYS = listPlaybookKeys();

describe("remediation playbooks", () => {
  it("keys every playbook by a health-score dimension concept and names a real pillar", () => {
    const pillarKeys = new Set(HEALTH_PILLARS.map((p) => p.key));
    for (const key of KEYS) {
      const p = getPlaybook(key);
      expect(p.pillar, `${key} pillar`).toBeTruthy();
      expect(pillarKeys.has(p.pillar), `${key} -> pillar "${p.pillar}" is a known health pillar`).toBe(true);
    }
  });

  it("gives every playbook the shared shape and a labelled label set", () => {
    for (const key of KEYS) {
      const p = getPlaybook(key);
      expect(typeof p.epicSummary).toBe("function");
      expect(typeof p.epicDescription).toBe("function");
      expect(typeof p.taskSummary).toBe("function");
      expect(typeof p.taskDescription).toBe("function");
      expect(p.labels).toEqual(["observatory-remediation", p.pillar]);
    }
  });

  it("produces non-empty strings even from a threadbare item", () => {
    for (const key of KEYS) {
      const p = getPlaybook(key);
      expect(p.epicSummary(0)).toMatch(/\S/);
      expect(p.epicSummary(1)).toMatch(/\S/);
      expect(p.epicDescription({ count: 3 })).toMatch(/\S/);
      expect(p.epicDescription()).toMatch(/\S/); // no ctx at all
      const thin = {};
      expect(p.taskSummary(thin)).toMatch(/\S/);
      expect(p.taskDescription(thin)).toMatch(/\S/);
      expect(p.taskDescription(thin)).not.toMatch(/undefined/);
    }
  });

  it("singularises and pluralises the epic summary on the count", () => {
    const p = getPlaybook("filter-ownership");
    expect(p.epicSummary(1)).toMatch(/1 saved filter\b/);
    expect(p.epicSummary(5)).toMatch(/5 saved filters\b/);
  });

  it("getPlaybook returns null for an unknown key", () => {
    expect(getPlaybook("no-such-finding")).toBeNull();
    expect(getPlaybook("")).toBeNull();
  });

  it("covers the findings a first release turns into work", () => {
    expect(KEYS).toEqual(
      expect.arrayContaining(["filter-ownership", "dashboard-ownership", "user-ownership", "board-backing"])
    );
  });
});
