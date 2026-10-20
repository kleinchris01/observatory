import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, ctxWithAccount } from "./test-harness.js";
import { SHARED_RESOLVER_FUNCTIONS, __RAW_ADMIN_ONLY_FUNCTIONS } from "../resolvers.js";

const { getDeletionSafety } = { ...SHARED_RESOLVER_FUNCTIONS, ...__RAW_ADMIN_ONLY_FUNCTIONS };

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// The Deletion Safety report: the product's thesis as one answer. Its own success metric is
// "whether a recommended deletion was ever wrong", so what is pinned here is mostly what it
// refuses to claim when a pillar is missing.
describe("getDeletionSafety", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x", accountId: "acc-1" } };

  const everything = () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1", refreshedAt: "2026-09-11T00:00:00.000Z" });
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1", unresolvedScreens: 0 });
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "fi1" });
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "d1" });
    mocks.loadSnapshotFields.mockResolvedValue([
      { id: "customfield_1", name: "Vendor Ref", totalIssueCount: 0, activeProjectCount: 0 },
    ]);
    mocks.loadScreensForField.mockResolvedValue([]);
    mocks.loadFilterReferencesFor.mockResolvedValue([]);
    mocks.loadRqtFieldIndex.mockResolvedValue([]);
    mocks.loadFieldReachabilityByProject.mockResolvedValue([]);
    mocks.loadProjectScreenCoverage.mockResolvedValue([]);
    mocks.loadPopulatedProjectUsage.mockResolvedValue({ rows: [], truncated: false, limit: 20000 });
    mocks.readAutomationAnalysis.mockResolvedValue({ schemaVersion: 1, refreshedAt: Date.now() - 86400000 });
    mocks.readAutomationPart.mockImplementation((_k, part) =>
      Promise.resolve(part === "fields" ? { total: 0, entries: [] } : null),
    );
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({
      version: "w1",
      workflowRules: 12,
      refreshedAt: "2026-10-05T00:00:00.000Z",
    });
    mocks.loadStatusesCatalog.mockResolvedValue([
      { statusId: "3", name: "In Review" },
      { statusId: "4", name: "Approved" },
    ]);
    mocks.loadWorkflowRefsFor.mockResolvedValue([]);
  };

  test("refuses to answer without a field snapshot", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    const result = await getDeletionSafety({ payload: { fieldIds: ["customfield_1"] }, ...ctx });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/no field snapshot/i);
  });

  test("refuses an empty request rather than reporting a clean estate", async () => {
    everything();
    const result = await getDeletionSafety({ payload: { fieldIds: [] }, ...ctx });
    expect(result.available).toBe(false);
    expect(result.total).toBe(0);
  });

  test("returns a no-evidence verdict when every pillar was consulted and clean", async () => {
    everything();
    const result = await getDeletionSafety({ payload: { fieldIds: ["customfield_1"] }, ...ctx });

    expect(result.available).toBe(true);
    expect(result.fields[0].verdict).toBe("no-evidence-of-use");
    // Never the phrase somebody would act on without reading the rest.
    expect(JSON.stringify(result)).not.toMatch(/safe to delete/i);
  });

  test("blocks on a rule that writes the field", async () => {
    everything();
    mocks.readAutomationPart.mockImplementation((_k, part) =>
      Promise.resolve(
        part === "fields"
          ? { total: 1, entries: [{ label: "Vendor Ref", writeCount: 2, readCount: 0, triggerCount: 0 }] }
          : null,
      ),
    );

    const result = await getDeletionSafety({ payload: { fieldIds: ["customfield_1"] }, ...ctx });

    expect(result.fields[0].verdict).toBe("in-use");
    expect(result.fields[0].blockers[0].source).toBe("automation");
  });

  test("blocks on a workflow validator that names the field, and says where", async () => {
    everything();
    mocks.loadWorkflowRefsFor.mockResolvedValueOnce([
      {
        refType: "field",
        refId: "customfield_1",
        workflowName: "Build WF",
        source: "rule",
        ownerKind: "transition",
        ownerId: "21",
        ruleSeq: 0,
        transitionName: "Approve",
        transitionType: "DIRECTED",
        fromStatusIds: ["3"],
        toStatusId: "4",
        ruleKind: "validator",
        ruleKey: "system:validate-field-value",
        summary: "fieldRequired",
      },
    ]);

    const result = await getDeletionSafety({ payload: { fieldIds: ["customfield_1"] }, ...ctx });

    expect(result.fields[0].verdict).toBe("in-use");
    const blocker = result.fields[0].blockers.find((b) => b.source === "workflow-rules");
    expect(blocker.summary).toMatch(/Approve \(In Review -> Approved\) in Build WF/);
  });

  test("treats a workflow snapshot without rule capture as a gap", async () => {
    everything();
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "w1", workflowRules: null });

    const result = await getDeletionSafety({ payload: { fieldIds: ["customfield_1"] }, ...ctx });

    expect(result.fields[0].verdict).toBe("unknown");
    expect(result.fields[0].gaps.some((g) => g.source === "workflow rules")).toBe(true);
  });

  test("degrades to unknown when a pillar has never been built", async () => {
    everything();
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);

    const result = await getDeletionSafety({ payload: { fieldIds: ["customfield_1"] }, ...ctx });

    expect(result.fields[0].verdict).toBe("unknown");
    expect(result.fields[0].gaps.some((g) => g.source === "screens")).toBe(true);
  });

  test("names the fields it would not assess rather than silently dropping them", async () => {
    everything();
    const many = Array.from({ length: 80 }, (_, i) => `customfield_${i}`);

    const result = await getDeletionSafety({ payload: { fieldIds: many }, ...ctx });

    expect(result.total).toBe(50);
    expect(result.skipped).toBe(30);
  });

  test("dates every pillar it drew on, because they refresh independently", async () => {
    everything();
    const result = await getDeletionSafety({ payload: { fieldIds: ["customfield_1"] }, ...ctx });
    expect(result.freshness).toHaveProperty("fields");
    expect(result.freshness).toHaveProperty("automation");
  });
});

// The evidence-gathering legs of the deletion report, each of which can be absent on a real
// site. Covered separately because each one degrades the verdict differently.
describe("getDeletionSafety — gathering evidence", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x", accountId: "acc-1" } };

  const base = () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1", refreshedAt: "2026-09-11T00:00:00.000Z" });
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1", unresolvedScreens: 0 });
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "fi1" });
    mocks.readDashboardSnapshotMeta.mockResolvedValue(null);
    mocks.loadSnapshotFields.mockResolvedValue([
      { id: "customfield_1", name: "Vendor Ref", totalIssueCount: 0, activeProjectCount: 0 },
    ]);
    mocks.loadScreensForField.mockResolvedValue([]);
    mocks.loadFilterReferencesFor.mockResolvedValue([]);
    mocks.loadRqtFieldIndex.mockResolvedValue([]);
    mocks.loadFieldReachabilityByProject.mockResolvedValue([]);
    mocks.loadProjectScreenCoverage.mockResolvedValue([]);
    mocks.loadPopulatedProjectUsage.mockResolvedValue({ rows: [], truncated: false, limit: 20000 });
    mocks.readAutomationAnalysis.mockResolvedValue({ schemaVersion: 1, refreshedAt: Date.now() - 86400000 });
    mocks.readAutomationPart.mockImplementation((_k, part) =>
      Promise.resolve(part === "fields" ? { total: 0, entries: [] } : null),
    );
  };

  const first = async () => (await getDeletionSafety({ payload: { fieldIds: ["customfield_1"] }, ...ctx })).fields[0];

  test("blocks on the values the field already holds", async () => {
    base();
    mocks.loadSnapshotFields.mockResolvedValue([
      { id: "customfield_1", name: "Vendor Ref", totalIssueCount: 4820, activeProjectCount: 9 },
    ]);
    const f = await first();
    expect(f.verdict).toBe("in-use");
    expect(f.blockers.some((b) => b.source === "usage")).toBe(true);
  });

  test("blocks on a filter whose JQL names the field", async () => {
    base();
    mocks.loadFilterReferencesFor.mockResolvedValue([{ id: "1", name: "Open bugs" }]);
    const f = await first();
    expect(f.blockers.find((b) => b.source === "filters").summary).toMatch(/Open bugs/);
  });

  test("blocks on requirement tokens, which break traceability rather than data", async () => {
    base();
    mocks.loadRqtFieldIndex.mockResolvedValue([{ fieldId: "customfield_1", issueCount: 91 }]);
    const f = await first();
    expect(f.blockers.find((b) => b.source === "rqt").detail).toMatch(/breaks the trace/i);
  });

  test("carries the invisible-data blocker through from the screen cross", async () => {
    base();
    // Populated in a project whose screens do not show it: the blocker most likely to be the
    // reason a deletion breaks something.
    mocks.loadProjectScreenCoverage.mockResolvedValue([{ projectId: "10", screenCount: 2, unresolvedScreens: 0 }]);
    mocks.loadFieldReachabilityByProject.mockResolvedValue([
      { projectId: "10", fieldId: "customfield_9", onCreate: true, onEdit: false, onView: true },
    ]);
    mocks.loadPopulatedProjectUsage.mockResolvedValue({
      truncated: false,
      limit: 20000,
      rows: [{ fieldId: "customfield_1", projectId: "10", projectKey: "OPS", issueCount: 480 }],
    });

    const f = await first();
    expect(f.blockers.some((b) => b.source === "invisible-data")).toBe(true);
  });

  test("a dashboard inventory that was never built becomes a gap, not a pass", async () => {
    base();
    const f = await first();
    expect(f.gaps.some((g) => g.source === "dashboards")).toBe(true);
    expect(f.verdict).toBe("unknown");
  });

  test("assesses a field the catalogue does not contain rather than skipping it", async () => {
    base();
    const result = await getDeletionSafety({ payload: { fieldIds: ["customfield_missing"] }, ...ctx });
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].fieldId).toBe("customfield_missing");
  });
});

// Every pillar read here is best-effort. A field snapshot exists, so the question can be
// asked -- and one storage failure must narrow the answer rather than refuse it, because a
// report that throws when the filter table is unreachable is a report nobody can use on the
// day they most need it.
describe("getDeletionSafety — one pillar failing never takes the verdict down", () => {
  const ctx = { context: { installContext: "ari:cloud:jira::site/x", accountId: "acc-1" } };

  const base = () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "f1" });
    mocks.readScreenSnapshotMeta.mockResolvedValue({ version: "s1", unresolvedScreens: 0 });
    mocks.readFilterSnapshotMeta.mockResolvedValue({ version: "fi1" });
    mocks.readDashboardSnapshotMeta.mockResolvedValue({ version: "d1" });
    mocks.loadSnapshotFields.mockResolvedValue([{ id: "customfield_1", name: "Vendor Ref", totalIssueCount: 0 }]);
    mocks.loadScreensForField.mockResolvedValue([]);
    mocks.loadFilterReferencesFor.mockResolvedValue([]);
    mocks.loadRqtFieldIndex.mockResolvedValue([]);
    mocks.loadFieldReachabilityByProject.mockResolvedValue([]);
    mocks.loadProjectScreenCoverage.mockResolvedValue([]);
    mocks.loadPopulatedProjectUsage.mockResolvedValue({ rows: [], truncated: false, limit: 20000 });
    mocks.readAutomationAnalysis.mockResolvedValue({ schemaVersion: 1, refreshedAt: Date.now() - 86400000 });
    mocks.readAutomationPart.mockImplementation((_k, part) =>
      Promise.resolve(part === "fields" ? { total: 0, entries: [] } : null),
    );
    mocks.loadDashboardsForFilterIds?.mockResolvedValue?.([]);
  };

  const verdictFor = async () =>
    (await getDeletionSafety({ payload: { fieldIds: ["customfield_1"] }, ...ctx })).fields[0];

  test.each([
    ["screens", () => mocks.loadScreensForField.mockRejectedValueOnce(new Error("boom")), "screens"],
    ["filters", () => mocks.loadFilterReferencesFor.mockRejectedValueOnce(new Error("boom")), "filters"],
    ["the field catalogue", () => mocks.loadSnapshotFields.mockRejectedValueOnce(new Error("boom")), "field catalogue"],
  ])("a %s read failure degrades the verdict instead of throwing", async (_label, breakIt, gapSource) => {
    base();
    breakIt();

    const field = await verdictFor();

    expect(field.verdict).toBe("unknown");
    if (gapSource) expect(field.gaps.some((g) => g.source === gapSource)).toBe(true);
  });

  test("a screen-cross failure costs the invisible-data blocker, not the report", async () => {
    base();
    mocks.loadProjectScreenCoverage.mockRejectedValueOnce(new Error("boom"));

    const result = await getDeletionSafety({ payload: { fieldIds: ["customfield_1"] }, ...ctx });

    expect(result.available).toBe(true);
    expect(result.fields[0].blockers.some((b) => b.source === "invisible-data")).toBe(false);
  });

  test("counts dashboards when the chain resolves them", async () => {
    base();
    // field -> filters naming it -> gadgets on those filters -> dashboards. Every leg an
    // exact join, which is what makes the count safe to act on.
    mocks.loadFilterReferencesFor.mockResolvedValue([{ id: "500", name: "Open bugs" }]);

    const field = await verdictFor();

    expect(field.blockers.some((b) => b.source === "filters")).toBe(true);
  });
});

// Archived projects are invisible to Jira's search. A field whose data lives there must never
// read as unused, and deleting it must say what it would destroy (7 Oct 2026: an HR project
// archived for retention, with a field a remediation task said to delete).
describe("getDeletionSafety -- archived projects", () => {
  const TT = { id: "20001", key: "TT", name: "Talent Tracker", archivedAt: "2026-06-01", issueCount: 2340 };
  const EMPTY = { id: "20002", key: "OLD", name: "Old", archivedAt: "2025-01-01", issueCount: 0 };

  async function assess(fieldId = "customfield_500") {
    mocks.readSnapshotMeta.mockResolvedValueOnce({ version: "v1", refreshedAt: "2026-10-01" });
    mocks.loadSnapshotFields.mockResolvedValueOnce([
      { id: fieldId, name: "Hiring Manager", totalIssueCount: 0, activeProjectCount: 0 },
    ]);
    const r = await getDeletionSafety({ payload: { fieldIds: [fieldId] }, context: ctxWithAccount() });
    return r.fields?.[0] ?? r.assessments?.[0] ?? r.results?.[0] ?? r;
  }

  const findArchived = (a) => ({
    blocker: (a.blockers || []).find((b) => b.source === "archived"),
    gap: (a.gaps || []).find((g) => g.source === "archived projects"),
  });

  test("values counted before the project was archived are a high blocker naming it", async () => {
    mocks.loadArchivedProjects.mockResolvedValueOnce({ available: true, projects: [TT] });
    mocks.loadArchivedFieldUsage.mockResolvedValueOnce(
      new Map([
        ["customfield_500", [{ projectId: "20001", projectKey: "TT", issueCount: 2340, lastSeenAt: "2026-05-30" }]],
      ]),
    );
    const a = await assess();
    expect(a.verdict).toBe("in-use");
    expect(findArchived(a).blocker).toMatchObject({
      severity: "high",
      summary: expect.stringMatching(/2,340 values in 1 archived project.*TT \(2,340\)/),
    });
  });

  test("configured in an archived project never counted: a gap naming it, so never 'no evidence'", async () => {
    mocks.loadArchivedProjects.mockResolvedValueOnce({ available: true, projects: [TT, EMPTY] });
    mocks.getFieldProjectAssociations.mockResolvedValueOnce([{ id: "20001" }, { id: "20002" }, { id: "10000" }]);
    const a = await assess();
    expect(a.verdict).not.toBe("no-evidence-of-use");
    // OLD reports no issues at all, so it cannot hide values and is not named.
    expect(findArchived(a).gap.reason).toMatch(
      /Configured in 1 archived project whose values were never counted \(TT\)/,
    );
  });

  test("a global context reaches every archived project", async () => {
    mocks.loadArchivedProjects.mockResolvedValueOnce({ available: true, projects: [TT] });
    mocks.loadFieldSummary.mockResolvedValueOnce({ hasGlobalContext: true });
    const a = await assess();
    expect(findArchived(a).gap.reason).toMatch(/\(TT\)/);
    expect(mocks.getFieldProjectAssociations).not.toHaveBeenCalled();
  });

  test("an unreadable archived list is a gap, never 'nothing archived'", async () => {
    mocks.loadArchivedProjects.mockResolvedValueOnce({ available: false, error: "403 Forbidden", projects: [] });
    const a = await assess();
    expect(findArchived(a).gap.reason).toMatch(/could not be read \(403 Forbidden\)/);
  });

  test("before any scan has read the list, it says so", async () => {
    mocks.loadArchivedProjects.mockResolvedValueOnce(null);
    const a = await assess();
    expect(findArchived(a).gap.reason).toMatch(/have not been checked yet/);
  });

  test("a failed association read is 'could not check', not 'not configured'", async () => {
    mocks.loadArchivedProjects.mockResolvedValueOnce({ available: true, projects: [TT] });
    mocks.getFieldProjectAssociations.mockRejectedValueOnce(new Error("timeout"));
    const a = await assess();
    expect(findArchived(a).gap.reason).toMatch(/could not be checked/);
  });
});
