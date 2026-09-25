import { describe, it, expect } from "vitest";
import {
  REMEDIATION_PLAYBOOKS,
  getPlaybook,
  listPlaybookKeys,
  groupBounded,
  listPlaybookCatalog,
  REMEDIATION_FINDING_INDEX,
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

describe("finding coverage", () => {
  it("maps each Overview finding to exactly one playbook", () => {
    const seen = new Map();
    for (const entry of listPlaybookCatalog()) {
      for (const f of entry.findings) {
        expect(seen.has(f), `${f} claimed by both ${seen.get(f)} and ${entry.key}`).toBe(false);
        seen.set(f, entry.key);
      }
    }
    expect(Object.keys(REMEDIATION_FINDING_INDEX).sort()).toEqual([...seen.keys()].sort());
  });

  it("covers the access findings", () => {
    for (const f of ["permission-risky", "permission-unused", "security-unused", "notification-unused", "security-broken-levels", "notification-fragile", "role-empty-admin", "role-offroster-actors"]) {
      expect(REMEDIATION_FINDING_INDEX[f], f).toBeTruthy();
    }
  });

  it("declares a granularity on every playbook", () => {
    for (const entry of listPlaybookCatalog()) expect(["item", "group", "bounded"]).toContain(entry.granularity);
  });
});

describe("links in tickets", () => {
  const ORIGIN = "https://acme.atlassian.net";

  it("adds an Open in Jira section with the item's own link when the site is known", () => {
    const text = getPlaybook("filter-ownership").taskDescription({ id: "4001", name: "Open Bugs" }, { origin: ORIGIN });
    expect(text).toMatch(/## Open in Jira/);
    expect(text).toContain("[Filter: Open Bugs](https://acme.atlassian.net/issues/?filter=4001)");
  });

  it("leaves the section out, rather than writing dead text, when the site is unknown", () => {
    expect(getPlaybook("filter-ownership").taskDescription({ id: "4001" })).not.toMatch(/Open in Jira/);
  });

  it("every playbook's links survive a threadbare item", () => {
    for (const key of Object.keys(REMEDIATION_PLAYBOOKS)) {
      const text = getPlaybook(key).taskDescription({}, { origin: ORIGIN });
      expect(text, key).not.toMatch(/undefined/);
    }
  });

  it("bounded tasks link every project they cover", () => {
    const text = getPlaybook("role-offroster-actors").taskDescription(
      { name: "DEV, OPS", owners: ["DEV", "OPS"], count: 2, members: [{ projectKey: "DEV", role: "Developers", accountId: "a" }] },
      { origin: ORIGIN },
    );
    expect(text).toContain("(https://acme.atlassian.net/plugins/servlet/project-config/DEV/roles)");
    expect(text).toContain("(https://acme.atlassian.net/plugins/servlet/project-config/OPS/roles)");
    expect(text).toContain("- DEV / Developers: a");
  });
});

describe("groupBounded", () => {
  const items = (keys) => keys.map((k, i) => ({ k, i }));

  it("one group per owner when there are few, sorted, members kept", () => {
    const groups = groupBounded(items(["B", "A", "B"]), { keyOf: (x) => x.k, max: 50 });
    expect(groups.map((g) => [g.id, g.count])).toEqual([["A", 1], ["B", 2]]);
  });

  it("past the cap, owners are bucketed into at most `max` stable groups and nothing is lost", () => {
    const keys = Array.from({ length: 200 }, (_, i) => `P${i}`);
    const a = groupBounded(items(keys), { keyOf: (x) => x.k, max: 10 });
    const b = groupBounded(items([...keys].reverse()), { keyOf: (x) => x.k, max: 10 });
    expect(a.length).toBeLessThanOrEqual(10);
    expect(a.reduce((n, g) => n + g.count, 0)).toBe(200);
    // Same owners land in the same bucket regardless of input order.
    expect(a.map((g) => [g.id, [...g.owners].sort()])).toEqual(b.map((g) => [g.id, [...g.owners].sort()]));
    expect(a[0].id).toMatch(/^bucket-\d\d$/);
  });
});
