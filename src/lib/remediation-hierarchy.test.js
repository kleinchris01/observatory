import { describe, test, expect, vi } from "vitest";
import {
  INITIATIVE_LABELS, ROOT_NODE, ensureNode, ensureInitiativeFor, initiativeLabelFor, initiativeNode,
  initiativeSummary, normalizeSummary, rootSummary,
} from "./remediation-hierarchy.js";
import { listPlaybookCatalog } from "./remediation-playbooks.js";

const issue = (key, summary) => ({ key, id: `id-${key}`, fields: { summary } });

function makeDeps({ nodes = new Map(), byType = {} } = {}) {
  let next = 100;
  return {
    nodes,
    existing: new Map(),
    searchIssuesPage: vi.fn(async (jql) => {
      const type = /issuetype = "([^"]+)"/.exec(jql)[1];
      return [...(byType[type] || [])];
    }),
    createJiraIssue: vi.fn(async () => { next += 1; return { key: `OPS-${next}`, id: String(next) }; }),
    recordHierarchyNode: vi.fn(async () => {}),
  };
}

const base = { scopeKey: "inst", period: "2026-Q4", projectKey: "ATLASDEV", accountId: "admin-1" };
const config = { rootIssueType: "Product", initiativeIssueType: "Initiative" };

describe("naming", () => {
  test("summaries follow the hierarchy the site already uses", () => {
    expect(rootSummary("2026-Q4")).toBe("2026-Q4 Observatory Findings and Remediations");
    expect(initiativeSummary("2026-Q4", "Fields")).toBe("2026-Q4 - Fields Remediation");
  });

  test("matching ignores dashes, spaces and case", () => {
    expect(normalizeSummary("2026-Q4 Roles Remediation")).toBe(normalizeSummary(initiativeSummary("2026-Q4", "Roles")));
    expect(normalizeSummary("2026-q4 - ROLES remediation")).toBe(normalizeSummary("2026-Q4 Roles Remediation"));
  });

  test("every playbook pillar has an initiative, so no epic lands under a made-up one", () => {
    const pillars = [...new Set(listPlaybookCatalog().map((p) => p.pillar))];
    expect(pillars.filter((p) => !INITIATIVE_LABELS[p])).toEqual([]);
    expect(initiativeLabelFor("issueTypes")).toBe("Work Types");
    expect(initiativeLabelFor("fieldConfigs")).toBe("Field Configuration");
  });
});

describe("ensureNode", () => {
  test("a recorded node is used without touching Jira", async () => {
    const deps = makeDeps({ nodes: new Map([[ROOT_NODE, { issueKey: "OPS-1" }]]) });
    const r = await ensureNode({ ...base, node: ROOT_NODE, summary: rootSummary("2026-Q4"), issueType: "Product" }, deps);
    expect(r).toEqual({ issueKey: "OPS-1", created: false, adopted: false });
    expect(deps.searchIssuesPage).not.toHaveBeenCalled();
    expect(deps.createJiraIssue).not.toHaveBeenCalled();
  });

  test("an item already in Jira with a matching summary is adopted and recorded, not duplicated", async () => {
    const deps = makeDeps({ byType: { Initiative: [issue("ATLASDEV-5624", "2026-Q4 Roles Remediation")] } });
    const r = await ensureNode({ ...base, node: initiativeNode("Roles"), summary: initiativeSummary("2026-Q4", "Roles"), issueType: "Initiative" }, deps);
    expect(r).toEqual({ issueKey: "ATLASDEV-5624", created: false, adopted: true });
    expect(deps.createJiraIssue).not.toHaveBeenCalled();
    expect(deps.recordHierarchyNode).toHaveBeenCalledWith("inst", "2026-Q4", "initiative:Roles", { issueKey: "ATLASDEV-5624", issueId: "id-ATLASDEV-5624", adopted: true });
    expect(deps.searchIssuesPage.mock.calls[0][0]).toBe('project = "ATLASDEV" AND issuetype = "Initiative" ORDER BY created DESC');
  });

  test("otherwise it is created as the caller, under its parent, and recorded", async () => {
    const deps = makeDeps();
    const r = await ensureNode({ ...base, node: initiativeNode("Fields"), summary: initiativeSummary("2026-Q4", "Fields"), issueType: "Initiative", parentKey: "OPS-1" }, deps);
    expect(r.created).toBe(true);
    expect(deps.createJiraIssue).toHaveBeenCalledWith({
      project: { key: "ATLASDEV" }, issuetype: { name: "Initiative" }, summary: "2026-Q4 - Fields Remediation",
      reporter: { id: "admin-1" }, parent: { key: "OPS-1" },
    }, { asUser: true });
    expect(deps.nodes.get("initiative:Fields")).toEqual({ issueKey: r.issueKey });
  });

  test("an item from another quarter is never adopted", async () => {
    const deps = makeDeps({ byType: { Initiative: [issue("OPS-9", "2026-Q3 - Fields Remediation")] } });
    const r = await ensureNode({ ...base, node: initiativeNode("Fields"), summary: initiativeSummary("2026-Q4", "Fields"), issueType: "Initiative" }, deps);
    expect(r.created).toBe(true);
  });
});

describe("ensureInitiativeFor", () => {
  test("root first, then the pillar's initiative under it; each type searched once per call chain", async () => {
    const deps = makeDeps({ byType: { Product: [issue("ATLASDEV-5627", "2026-Q4 Observatory Findings and Remediations")] } });
    const a = await ensureInitiativeFor({ ...base, pillar: "screens", config }, deps);
    const b = await ensureInitiativeFor({ ...base, pillar: "fields", config }, deps);
    const again = await ensureInitiativeFor({ ...base, pillar: "screens", config }, deps);

    expect(a.rootKey).toBe("ATLASDEV-5627");
    expect(a.label).toBe("Screen");
    expect(deps.createJiraIssue.mock.calls.map(([f]) => [f.summary, f.parent?.key])).toEqual([
      ["2026-Q4 - Screen Remediation", "ATLASDEV-5627"],
      ["2026-Q4 - Fields Remediation", "ATLASDEV-5627"],
    ]);
    expect(again.initiativeKey).toBe(a.initiativeKey);
    expect(b.initiativeKey).not.toBe(a.initiativeKey);
    // One search for Product, one for Initiative -- not one per call.
    expect(deps.searchIssuesPage).toHaveBeenCalledTimes(2);
  });

  test("an unmapped pillar still gets an initiative, named after itself", async () => {
    const deps = makeDeps();
    const one = await ensureInitiativeFor({ ...base, pillar: "unknownPillar", config }, deps);
    expect(one.label).toBe("unknownPillar");
  });
});
