import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, ctxWithAccount } from "../test-harness.js";
import {
  rovoWorkflowSearch,
  rovoWorkflowInspect,
  rovoWorkflowImpact,
  __RAW_ADMIN_ONLY_FUNCTIONS,
} from "../../resolvers.js";

const { getStatusDetail } = __RAW_ADMIN_ONLY_FUNCTIONS;

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// Rovo workflow & status agent (search / inspect / impact)
// ---------------------------------------------------------------------------
describe("rovo workflow agent", () => {
  const ctx = () => ctxWithAccount();

  function seedBuilt() {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({
      version: "v9",
      state: "ready",
      refreshedAt: "2026-09-01T00:00:00.000Z",
      workflowRules: 4,
    });
    mocks.loadTransitionsTouchingStatus.mockResolvedValue([]);
    mocks.loadStatusWorkflowProperties.mockResolvedValue([]);
    mocks.loadWorkflowRefsFor.mockResolvedValue([]);
    mocks.loadWorkflowRefsByType.mockResolvedValue([]);
    mocks.loadWorkflowSchemes.mockResolvedValue([
      {
        schemeId: "s1",
        name: "Software Simplified Workflow Scheme",
        description: "the default",
        defaultWorkflow: "SSW",
        projectCount: 3,
      },
      { schemeId: "s2", name: "Ops Scheme", description: "", defaultWorkflow: "Ops", projectCount: 1 },
    ]);
    mocks.loadStatusesCatalog.mockResolvedValue([
      { statusId: "1", name: "To Do", statusCategory: "To Do" },
      { statusId: "2", name: "In Review", statusCategory: "In Progress" },
      { statusId: "3", name: "In  Review", statusCategory: "In Progress" }, // spacing dup of #2
      { statusId: "9", name: "On Hold", statusCategory: "In Progress" },
    ]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([
      { schemeId: "s1", statusId: "1" },
      { schemeId: "s1", statusId: "2" },
      { schemeId: "s2", statusId: "1" },
    ]);
    mocks.loadStatusIssueCounts.mockResolvedValue(
      new Map([
        ["1", 40],
        ["2", 5],
        ["9", 0],
      ]),
    );
    mocks.loadStatusHistoryCounts.mockResolvedValue({ counts: new Map([["9", 12]]), measuredAt: "2026-08-01" });
    mocks.loadWorkflowSchemeProjects.mockResolvedValue([{ projectKey: "ABC", projectName: "Alpha" }]);
    mocks.loadStatusAutomationReferences.mockResolvedValue({});
    // Board and filter checks default to "checked and clean" -- an inventory exists and
    // references nothing -- so existing tests that only care about the scheme/automation
    // side keep working, and a test that wants "not yet built" overrides these explicitly.
    mocks.readBoardSnapshotMeta.mockResolvedValue({ version: "b1" });
    mocks.loadBoardColumns.mockResolvedValue([]);
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.loadFilterReferencesFor.mockResolvedValue({ total: 0, filters: [] });
  }

  test("search: returns workflows-unavailable when no snapshot exists", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ state: "idle" });
    const r = await rovoWorkflowSearch({ query: "review" }, ctx());
    expect(r.status).toBe("workflows-unavailable");
    expect(r.snapshotStatus).toEqual({ state: "idle", refreshedAt: null });
  });

  test("search: ranks scheme and status matches and carries refreshedAt", async () => {
    seedBuilt();
    const r = await rovoWorkflowSearch({ query: "review" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.refreshedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(r.statuses.map((s) => s.name)).toContain("In Review");
    expect(r.statuses[0]).toMatchObject({ issueCount: 5, category: "In Progress" });
  });

  test("search: kind=scheme suppresses status matches", async () => {
    seedBuilt();
    const r = await rovoWorkflowSearch({ query: "scheme", kind: "scheme" }, ctx());
    expect(r.statuses).toEqual([]);
    expect(r.schemes.length).toBeGreaterThan(0);
  });

  test("search: an empty query is an error", async () => {
    const r = await rovoWorkflowSearch({ query: "  " }, ctx());
    expect(r.status).toBe("error");
  });

  test("inspect: a scheme returns its statuses, balance and governed projects", async () => {
    seedBuilt();
    const r = await rovoWorkflowInspect({ identifier: "Software Simplified Workflow Scheme" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.kind).toBe("scheme");
    expect(r.statuses.map((s) => s.name).sort()).toEqual(["In Review", "To Do"]);
    expect(r.projects).toEqual([{ projectKey: "ABC", projectName: "Alpha" }]);
  });

  test("inspect: a status reports schemes that reach it and near-duplicate siblings", async () => {
    seedBuilt();
    const r = await rovoWorkflowInspect({ identifier: "In Review" }, ctx());
    expect(r.kind).toBe("status");
    expect(r.reachedBySchemes.map((s) => s.name)).toEqual(["Software Simplified Workflow Scheme"]);
    expect(r.duplicateSiblings.map((s) => s.name)).toContain("In  Review");
  });

  test("inspect: unknown identifier is not-found, not unavailable", async () => {
    seedBuilt();
    const r = await rovoWorkflowInspect({ identifier: "Nope" }, ctx());
    expect(r.status).toBe("not-found");
    expect(r.refreshedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  test("impact: a status no scheme reaches with a measured-zero count and no rules is no-evidence-of-use", async () => {
    seedBuilt();
    const r = await rovoWorkflowImpact({ name: "On Hold" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.reachedBySchemeCount).toBe(0);
    expect(r.issueCount).toBe(0);
    expect(r.boardChecked).toBe(true);
    expect(r.onAnyBoard).toBe(false);
    expect(r.filtersChecked).toBe(true);
    expect(r.referencingFilterCount).toBe(0);
    expect(r.verdict).toBe("no-evidence-of-use");
    // Drawn from the same assessStatusDeletion/computeVerdict core assessFieldDeletion uses --
    // not a bespoke boolean, so the response also carries the blockers/gaps shape.
    expect(r.blockers).toEqual([]);
    expect(r.gaps).toEqual([]);
    expect(r.verdictCaveat).toMatch(/board columns, saved filter JQL/);
  });

  test("impact: a status in a workflow no scheme reaches is still in use -- Jira will not delete it", async () => {
    seedBuilt();
    mocks.loadTransitionsTouchingStatus.mockResolvedValueOnce([
      {
        workflowName: "Old WF",
        transitionId: "21",
        transitionName: "Park",
        transitionType: "DIRECTED",
        fromStatusIds: ["1"],
        toStatusId: "9",
        ruleCount: 1,
      },
    ]);
    const r = await rovoWorkflowImpact({ name: "On Hold" }, ctx());
    expect(r.inWorkflows).toEqual(["Old WF"]);
    expect(r.verdict).toBe("in-use");
    expect(r.blockers).toEqual([expect.objectContaining({ source: "workflows", summary: "In 1 workflow: Old WF." })]);
  });

  test("impact: a snapshot that never read transitions leaves the workflows check a gap", async () => {
    seedBuilt();
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({
      version: "v9",
      state: "ready",
      refreshedAt: "2026-09-01T00:00:00.000Z",
      workflowRules: null,
    });
    const r = await rovoWorkflowImpact({ name: "On Hold" }, ctx());
    expect(r.workflowsChecked).toBe(false);
    expect(r.verdict).toBe("unknown");
    expect(r.gaps.map((g) => g.source)).toContain("workflows");
  });

  test("status detail: the drawer's read, with transitions in both directions and the restrictions on it", async () => {
    seedBuilt();
    mocks.loadTransitionsTouchingStatus.mockResolvedValueOnce([
      {
        workflowName: "SSW",
        transitionId: "11",
        transitionName: "Review",
        transitionType: "DIRECTED",
        fromStatusIds: ["1"],
        toStatusId: "2",
        ruleCount: 2,
      },
      {
        workflowName: "SSW",
        transitionId: "12",
        transitionName: "Back",
        transitionType: "GLOBAL",
        fromStatusIds: [],
        toStatusId: "1",
        ruleCount: 0,
      },
    ]);
    mocks.loadStatusWorkflowProperties.mockResolvedValueOnce([
      { workflowName: "SSW", key: "jira.issue.editable", value: "false" },
    ]);

    const r = await getStatusDetail({ payload: { statusId: "2" }, context: ctxWithAccount() });
    expect(r).toMatchObject({
      available: true,
      found: true,
      status: { statusId: "2", name: "In Review" },
      schemeCount: 1,
      workflows: ["SSW"],
      verdict: "in-use",
    });
    expect(r.transitions).toEqual([
      expect.objectContaining({ name: "Review", direction: "into", from: ["To Do"], to: "In Review", ruleCount: 2 }),
      expect.objectContaining({ name: "Back", direction: "out", from: ["Any status"], to: "To Do" }),
    ]);
    expect(r.restrictions.restrictions[0]).toMatchObject({ effect: "not-editable" });
    expect(r.schemes[0]).toMatchObject({ schemeId: "s1" });
  });

  test("status detail: unknown status and no snapshot are different answers", async () => {
    seedBuilt();
    expect(await getStatusDetail({ payload: { statusId: "404" }, context: ctxWithAccount() })).toMatchObject({
      available: true,
      found: false,
    });
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ state: "idle" });
    expect(await getStatusDetail({ payload: { statusId: "2" }, context: ctxWithAccount() })).toEqual({
      available: false,
      reason: "no-snapshot",
    });
  });

  test("impact: a status no board column maps and no filter references is still in-use when a board column DOES map it", async () => {
    seedBuilt();
    // "On Hold" (id 9) is otherwise the no-evidence case above; a board column mapping it
    // is the one thing left that should flip the verdict even with zero schemes, zero
    // issues and zero rules.
    mocks.loadBoardColumns.mockResolvedValue([{ boardId: "100", statusIds: ["9"] }]);
    const r = await rovoWorkflowImpact({ name: "On Hold" }, ctx());
    expect(r.onAnyBoard).toBe(true);
    expect(r.verdict).toBe("in-use");
    expect(r.blockers).toEqual([expect.objectContaining({ source: "boards" })]);
  });

  test("impact: a status referenced by a saved filter's JQL is not no-evidence, even with zero schemes, rules or issues", async () => {
    seedBuilt();
    mocks.loadFilterReferencesFor.mockResolvedValue({
      total: 1,
      filters: [{ id: "4001", name: "Everything On Hold" }],
    });
    const r = await rovoWorkflowImpact({ name: "On Hold" }, ctx());
    expect(r.referencingFilterCount).toBe(1);
    expect(r.referencingFilters).toEqual([{ id: "4001", name: "Everything On Hold" }]);
    expect(r.verdict).toBe("in-use");
    expect(r.blockers).toEqual([
      expect.objectContaining({ source: "filters", summary: expect.stringContaining("Everything On Hold") }),
    ]);
  });

  test("impact: no board inventory downgrades to unknown, never a false no-evidence, even at zero blockers", async () => {
    seedBuilt();
    mocks.readBoardSnapshotMeta.mockResolvedValue(null);
    const r = await rovoWorkflowImpact({ name: "On Hold" }, ctx());
    expect(r.boardChecked).toBe(false);
    expect(r.onAnyBoard).toBeNull();
    // Zero blockers everywhere else, but one pillar (boards) was never checked -- that is
    // exactly the unknown case, not a false no-evidence and not a false in-use.
    expect(r.verdict).toBe("unknown");
    expect(r.blockers).toEqual([]);
    expect(r.gaps).toEqual([expect.objectContaining({ source: "board columns" })]);
  });

  test("impact: a confirmed automation blocker is in-use even when issue counts were never measured", async () => {
    // The bug the previous ad-hoc noEvidence boolean had: a real, confirmed blocker (a rule
    // transitioning into the status) could still read "unknown" if issue counts happened to
    // be unmeasured, because the old fallback branched on hasIssueCounts instead of on
    // whether any blocker existed. computeVerdict does not repeat that.
    seedBuilt();
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map()); // hasIssueCounts becomes false
    mocks.loadStatusAutomationReferences.mockResolvedValue({ "on hold": { ruleCount: 2, enabledRuleCount: 2 } });
    const r = await rovoWorkflowImpact({ name: "On Hold" }, ctx());
    expect(r.issueCount).toBeNull();
    expect(r.verdict).toBe("in-use");
    expect(r.blockers).toEqual([expect.objectContaining({ source: "automation" })]);
  });

  test("impact: a status issues sit in is in-use with its governed project sample", async () => {
    seedBuilt();
    const r = await rovoWorkflowImpact({ name: "To Do" }, ctx());
    expect(r.verdict).toBe("in-use");
    expect(r.reachedBySchemeCount).toBe(2);
    expect(r.projectSample).toContain("ABC");
  });

  test("impact: unknown status is not-found", async () => {
    seedBuilt();
    const r = await rovoWorkflowImpact({ name: "Ghost" }, ctx());
    expect(r.status).toBe("not-found");
  });

  test("impact: missing snapshot is workflows-unavailable", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue(null);
    const r = await rovoWorkflowImpact({ name: "To Do" }, ctx());
    expect(r.status).toBe("workflows-unavailable");
  });
});
