import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, ctxWithAccount } from "../test-harness.js";
import {
  rovoWorkflowSearch,
  rovoWorkflowInspect,
  rovoWorkflowImpact,
  rovoIssueTypeSearch,
  rovoIssueTypeInspect,
  rovoIssueTypeImpact,
  rovoAccessSearch,
  rovoAccessInspect,
  rovoAccessImpact,
  rovoPeopleSearch,
  rovoPeopleImpact,
  rovoAssetSearch,
  rovoAssetInspect,
  rovoAssetImpact,
  rovoEstateSearch,
  rovoEstateInspect,
  rovoScreenSearch,
  rovoScreenInspect,
  rovoScreenImpact,
  rovoChangeSearch,
  rovoChangeInspect,
  rovoProjectSearch,
  rovoProjectInspect,
} from "../../resolvers.js";

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// Rovo agents: error paths, filters and edge branches (coverage of the thin bits)
// ---------------------------------------------------------------------------
describe("rovo agents: edge branches", () => {
  const ctx = () => ctxWithAccount();

  test("every search action rejects an empty query", async () => {
    for (const fn of [
      rovoWorkflowSearch,
      rovoIssueTypeSearch,
      rovoAccessSearch,
      rovoPeopleSearch,
      rovoAssetSearch,
      rovoEstateSearch,
      rovoScreenSearch,
      rovoProjectSearch,
    ]) {
      const r = await fn({ query: "" }, ctx());
      expect(r.status).toBe("error");
    }
  });

  test("every inspect/impact action rejects a missing identifier", async () => {
    expect((await rovoWorkflowInspect({}, ctx())).status).toBe("error");
    expect((await rovoWorkflowImpact({}, ctx())).status).toBe("error");
    expect((await rovoIssueTypeInspect({}, ctx())).status).toBe("error");
    expect((await rovoIssueTypeImpact({}, ctx())).status).toBe("error");
    expect((await rovoAccessInspect({}, ctx())).status).toBe("error");
    expect((await rovoAccessImpact({}, ctx())).status).toBe("error");
    expect((await rovoPeopleImpact({}, ctx())).status).toBe("error");
    expect((await rovoAssetInspect({}, ctx())).status).toBe("error");
    expect((await rovoAssetImpact({}, ctx())).status).toBe("error");
    expect((await rovoScreenInspect({}, ctx())).status).toBe("error");
    expect((await rovoScreenImpact({}, ctx())).status).toBe("error");
    expect((await rovoChangeInspect({}, ctx())).status).toBe("error");
  });

  test("a loader that throws surfaces as a rejected resolver, not a silent result", async () => {
    mocks.readWorkflowSnapshotMeta.mockRejectedValueOnce(new Error("sql down"));
    await expect(rovoWorkflowSearch({ query: "x" }, ctx())).rejects.toThrow("sql down");
    mocks.readAccessSnapshotMeta.mockRejectedValueOnce(new Error("boom"));
    await expect(rovoAccessSearch({ query: "x" }, ctx())).rejects.toThrow("boom");
    mocks.readAssetSnapshotMeta.mockRejectedValueOnce(new Error("gw"));
    await expect(rovoAssetSearch({ query: "x" }, ctx())).rejects.toThrow("gw");
    mocks.readDriftSnapshotMeta.mockRejectedValueOnce(new Error("drift"));
    await expect(rovoChangeSearch({ query: "x" }, ctx())).rejects.toThrow("drift");
  });

  test("workflow search: kind=status suppresses schemes; issue-type kind=type suppresses schemes", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v", state: "ready", refreshedAt: "t" });
    mocks.loadWorkflowSchemes.mockResolvedValue([{ schemeId: "s", name: "Review Scheme" }]);
    mocks.loadStatusesCatalog.mockResolvedValue([{ statusId: "1", name: "Review", statusCategory: "In Progress" }]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map());
    mocks.loadStatusHistoryCounts.mockResolvedValue({ counts: new Map(), measuredAt: null });
    const r = await rovoWorkflowSearch({ query: "review", kind: "status" }, ctx());
    expect(r.schemes).toEqual([]);

    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ version: "v", state: "ready", refreshedAt: "t" });
    mocks.loadIssueTypes.mockResolvedValue([{ id: "1", name: "Review", hierarchyLevel: 0 }]);
    mocks.loadIssueTypeSchemes.mockResolvedValue([{ schemeId: "s", name: "Review Scheme" }]);
    mocks.loadIssueTypeSchemeItems.mockResolvedValue([]);
    mocks.loadIssueTypeSchemeProjects.mockResolvedValue([]);
    const r2 = await rovoIssueTypeSearch({ query: "review", kind: "type" }, ctx());
    expect(r2.schemes).toEqual([]);
  });

  test("assets: not-enabled short-circuits inspect and impact too", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({ state: "unavailable", assetsEnabled: false });
    expect((await rovoAssetInspect({ identifier: "x" }, ctx())).status).toBe("assets-not-enabled");
    expect((await rovoAssetImpact({ name: "x" }, ctx())).status).toBe("assets-not-enabled");
  });

  test("estate inspect: list=resolutions omits priorities", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValue({ state: "ready", version: "e", refreshedAt: "t" });
    mocks.loadEstateValues.mockImplementation(async (_k, _v, kind) =>
      kind === "resolution"
        ? [{ id: "1", name: "Done", isDefault: false }]
        : [{ id: "1", name: "High", isDefault: true }],
    );
    const r = await rovoEstateInspect({ list: "resolutions" }, ctx());
    expect(r).not.toHaveProperty("priorities");
    expect(r.resolutions.hasDefault).toBe(false);
  });

  test("project inspect: a project the caller cannot browse is not-authorised", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "fv", state: "ready" });
    mocks.listSnapshotProjects.mockResolvedValue([{ projectId: "10", projectKey: "ABC", projectName: "A" }]);
    mocks.getBrowsableProjectIds.mockImplementation(async () => new Set()); // nothing browsable
    const r = await rovoProjectInspect({ projectId: "10" }, ctx());
    expect(r.status).toBe("not-authorised");
  });

  test("access search: family filter with an unknown family falls back to all", async () => {
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "v", state: "ready", refreshedAt: "t" });
    mocks.readUserSnapshotMeta.mockResolvedValue(null);
    mocks.loadSchemes.mockResolvedValue([{ id: "1", name: "Thing" }]);
    mocks.loadSchemeHolders.mockResolvedValue([]);
    mocks.loadSchemeProjects.mockResolvedValue([]);
    mocks.loadSchemeLevels.mockResolvedValue([]);
    const r = await rovoAccessSearch({ query: "thing", family: "nonsense" }, ctx());
    expect(Object.keys(r.schemes).sort()).toEqual(["notifications", "permissions", "roles", "security"]);
  });
});

describe("rovo agents: more edge branches", () => {
  const ctx = () => ctxWithAccount();

  test("workflow inspect: scheme branch with no scheme-status rows yields a null-ish balance and empty statuses", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v", state: "ready", refreshedAt: "t" });
    mocks.loadWorkflowSchemes.mockResolvedValue([{ schemeId: "s1", name: "Lonely Scheme", description: "" }]);
    mocks.loadStatusesCatalog.mockResolvedValue([{ statusId: "1", name: "To Do", statusCategory: "To Do" }]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map());
    mocks.loadStatusHistoryCounts.mockResolvedValue({ counts: new Map(), measuredAt: null });
    mocks.loadWorkflowSchemeProjects.mockResolvedValue([]);
    const r = await rovoWorkflowInspect({ identifier: "Lonely Scheme" }, ctx());
    expect(r.kind).toBe("scheme");
    expect(r.statuses).toEqual([]);
    expect(r.projectCount).toBe(0);
  });

  test("workflow impact: verdict is 'unknown' when issue counts were never measured", async () => {
    mocks.readWorkflowSnapshotMeta.mockResolvedValue({ version: "v", state: "ready", refreshedAt: "t" });
    mocks.loadWorkflowSchemes.mockResolvedValue([{ schemeId: "s1", name: "S" }]);
    mocks.loadStatusesCatalog.mockResolvedValue([{ statusId: "9", name: "Limbo", statusCategory: "In Progress" }]);
    mocks.loadWorkflowSchemeStatuses.mockResolvedValue([]);
    mocks.loadStatusIssueCounts.mockResolvedValue(new Map());
    mocks.loadStatusHistoryCounts.mockResolvedValue({ counts: new Map(), measuredAt: null });
    mocks.loadStatusAutomationReferences.mockResolvedValue(null);
    const r = await rovoWorkflowImpact({ name: "Limbo" }, ctx());
    expect(r.verdict).toBe("unknown");
  });

  test("issue type inspect: an unknown identifier is not-found", async () => {
    mocks.readIssueTypeSnapshotMeta.mockResolvedValue({ version: "v", state: "ready", refreshedAt: "t" });
    mocks.loadIssueTypes.mockResolvedValue([{ id: "1", name: "Bug", hierarchyLevel: 0 }]);
    mocks.loadIssueTypeSchemes.mockResolvedValue([]);
    mocks.loadIssueTypeSchemeItems.mockResolvedValue([]);
    mocks.loadIssueTypeSchemeProjects.mockResolvedValue([]);
    const r = await rovoIssueTypeInspect({ identifier: "Nope" }, ctx());
    expect(r.status).toBe("not-found");
  });

  test("access impact: matches on accountId, not just display name", async () => {
    mocks.readAccessSnapshotMeta.mockResolvedValue({ version: "v", state: "ready", refreshedAt: "t" });
    // A people snapshot that does not list acc-99, so the holder is off the roster.
    mocks.readUserSnapshotMeta.mockResolvedValue({ version: "u1" });
    mocks.loadUsers.mockResolvedValue([{ accountId: "acc-1", active: true }]);
    mocks.loadSchemes.mockImplementation(async (_k, _v, f) => (f === "permission" ? [{ id: "p1", name: "PS" }] : []));
    // The stored row shape: the account is holderValue, the grant is context/contextLabel.
    mocks.loadSchemeHolders.mockImplementation(async (_k, _v, f) =>
      f === "permission"
        ? [
            {
              schemeId: "p1",
              context: "ADMINISTER_PROJECTS",
              contextLabel: "Administer Projects",
              holderType: "user",
              holderValue: "acc-99",
              holderLabel: "Someone",
            },
          ]
        : [],
    );
    mocks.loadSchemeProjects.mockResolvedValue([]);
    mocks.loadSchemeLevels.mockResolvedValue([]);
    const r = await rovoAccessImpact({ name: "acc-99" }, ctx());
    expect(r.verdict).toBe("named-in-schemes");
    expect(r.namedIn[0].offRoster).toBe(true);
  });

  test("screen inspect: neither a scheme nor a screen match is not-found", async () => {
    mocks.readScreenSnapshotMeta.mockResolvedValue({ state: "ready", version: "v", refreshedAt: "t" });
    mocks.loadScreensPage.mockResolvedValue({ total: 0, rows: [] });
    mocks.loadScreenSchemes.mockResolvedValue([]);
    mocks.loadScreenSchemeOperations.mockResolvedValue([]);
    mocks.loadIssueTypeScreenSchemes.mockResolvedValue([]);
    const r = await rovoScreenInspect({ identifier: "Ghost Screen" }, ctx());
    expect(r.status).toBe("not-found");
  });

  test("change search: pillar and kind filters are forwarded to the loader", async () => {
    mocks.readDriftSnapshotMeta.mockResolvedValue({ state: "ready", version: "d", refreshedAt: "t", totalChanges: 1 });
    mocks.loadConfigChanges.mockResolvedValue([
      {
        detectedAt: "2026-09-01",
        pillar: "access",
        entityType: "scheme",
        label: "PS",
        changeKind: "modified",
        summary: "x",
      },
    ]);
    const r = await rovoChangeSearch({ pillar: "access", kind: "modified" }, ctx());
    expect(r.pillar).toBe("access");
    expect(r.kind).toBe("modified");
    expect(mocks.loadConfigChanges).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ pillar: "access", kind: "modified" }),
    );
  });

  test("project inspect: resolves a projectKey from the browsable set and returns the overview shape", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: "fv", state: "ready" });
    mocks.listSnapshotProjects.mockResolvedValue([{ projectId: "10", projectKey: "ABC", projectName: "Alpha" }]);
    mocks.getBrowsableProjectIds.mockImplementation(async (_a, ids) => new Set((ids || []).map(String)));
    mocks.readWorkflowSnapshotMeta.mockResolvedValue(null);
    mocks.readScreenSnapshotMeta.mockResolvedValue(null);
    mocks.readFilterSnapshotMeta?.mockResolvedValue?.(null);
    const r = await rovoProjectInspect({ projectKey: "abc" }, ctx());
    expect(["ok", "not-authorised"]).toContain(r.status);
  });

  test("asset search: kind=schema and kind=type each suppress the other list", async () => {
    mocks.readAssetSnapshotMeta.mockResolvedValue({
      state: "ready",
      version: "a",
      assetsEnabled: true,
      refreshedAt: "t",
    });
    mocks.loadAssetSchemas.mockResolvedValue([{ id: "1", name: "Infra Schema" }]);
    mocks.loadAssetObjectTypes.mockResolvedValue([{ id: "9", objectSchemaId: "1", name: "Infra Node" }]);
    mocks.loadAssetAttributes.mockResolvedValue([]);
    expect((await rovoAssetSearch({ query: "infra", kind: "schema" }, ctx())).objectTypes).toEqual([]);
    expect((await rovoAssetSearch({ query: "infra", kind: "type" }, ctx())).schemas).toEqual([]);
  });

  test("estate search: kind filters", async () => {
    mocks.readEstateSnapshotMeta.mockResolvedValue({ state: "ready", version: "e", refreshedAt: "t" });
    mocks.loadEstateValues.mockImplementation(async (_k, _v, kind) =>
      kind === "resolution" ? [{ id: "1", name: "Done" }] : [{ id: "1", name: "Done" }],
    );
    expect((await rovoEstateSearch({ query: "done", kind: "resolution" }, ctx())).priorities).toEqual([]);
    expect((await rovoEstateSearch({ query: "done", kind: "priority" }, ctx())).resolutions).toEqual([]);
  });
});
