import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks } from "./test-harness.js";
import { __RAW_ADMIN_ONLY_FUNCTIONS, SHARED_RESOLVER_FUNCTIONS } from "../resolvers.js";
import { loadJsmView } from "./jsm.js";

const { getJsmInventory, buildJsmInventory } = __RAW_ADMIN_ONLY_FUNCTIONS;

installResolverTestDefaults();

const ctx = { context: { installContext: "ari:cloud:jira::site/x" } };

function builtSite() {
  mocks.readJsmSnapshotMeta.mockResolvedValue({
    state: "ready",
    version: "v1",
    refreshedAt: "2026-10-19T00:00:00Z",
    unreadCount: 1,
    summary: null,
  });
  mocks.loadJsmDesks.mockResolvedValue([
    { deskId: "1", projectKey: "SD", portalGroupCount: 1 },
    { deskId: "2", projectKey: "HR", portalGroupCount: null },
  ]);
  mocks.loadJsmRequestTypes.mockResolvedValue([
    { deskId: "1", id: "10", name: "Get help", hasDescription: true, groupIds: [], recentCount: 3 },
    { deskId: "2", id: "11", name: "Onboard", hasDescription: true, groupIds: [], recentCount: 3 },
  ]);
  mocks.loadJsmQueues.mockResolvedValue([
    { deskId: "1", id: "7", name: "Broken", jql: "cf[9] = 1", issueCount: 2, brokenRefs: ["customfield_9"] },
  ]);
  mocks.loadJsmSlas.mockResolvedValue([]);
  mocks.loadJsmOrganizations.mockResolvedValue([{ id: "4", name: "Acme", memberCount: 0, deskCount: 1 }]);
}

describe("getJsmInventory", () => {
  test("never built", async () => {
    const result = await getJsmInventory(ctx);
    expect(result).toMatchObject({ neverBuilt: true, jsmEnabled: true, requestTypes: [] });
    expect(mocks.loadJsmDesks).not.toHaveBeenCalled();
  });

  // A site with no service desk is a real answer, distinct from never built.
  test("a site with no service desk reports that, with the reason", async () => {
    mocks.readJsmSnapshotMeta.mockResolvedValue({
      state: "unavailable",
      lastError: "Jira Service Management is not on this site.",
    });
    expect(await getJsmInventory(ctx)).toMatchObject({
      neverBuilt: false,
      jsmEnabled: false,
      reason: "Jira Service Management is not on this site.",
    });
  });

  test("attaches findings to every row, with the desk's project key", async () => {
    builtSite();
    const result = await getJsmInventory(ctx);
    expect(result.unreadCount).toBe(1);
    // Desk 2's portal groups were not read, so its request type cannot be called hidden.
    expect(result.requestTypes.map((r) => [r.projectKey, r.findings.map((f) => f.code)])).toEqual([
      ["SD", ["hidden"]],
      ["HR", []],
    ]);
    expect(result.queues[0]).toMatchObject({
      projectKey: "SD",
      findings: [expect.objectContaining({ code: "broken-ref" })],
    });
    expect(result.organizations[0].findings.map((f) => f.code)).toEqual(["empty"]);
    // No stored summary (an older build): computed from the rows instead.
    expect(result.summary.queues.broken).toBe(1);
  });

  test("a row whose desk is missing from the snapshot carries no project key", async () => {
    builtSite();
    mocks.loadJsmQueues.mockResolvedValue([
      { deskId: "99", id: "1", name: "Stray", jql: "", issueCount: 1, brokenRefs: [] },
    ]);
    expect((await getJsmInventory(ctx)).queues[0].projectKey).toBeNull();
  });

  test("prefers the summary stored at build time", async () => {
    builtSite();
    mocks.readJsmSnapshotMeta.mockResolvedValue({ state: "ready", version: "v1", summary: { stored: true } });
    expect((await loadJsmView("test-install")).summary).toEqual({ stored: true });
  });
});

describe("buildJsmInventory", () => {
  test("queues a build", async () => {
    expect(await buildJsmInventory(ctx)).toEqual({ queued: true });
    expect(mocks.queueJsmSnapshotBuild).toHaveBeenCalledWith("test-install");
  });

  test("refuses while a live build runs", async () => {
    mocks.readJsmSnapshotMeta.mockResolvedValue({ state: "building" });
    expect(await buildJsmInventory(ctx)).toMatchObject({ queued: false, reason: "already-building" });
    expect(mocks.queueJsmSnapshotBuild).not.toHaveBeenCalled();
  });

  test("a stale build can be restarted", async () => {
    mocks.readJsmSnapshotMeta.mockResolvedValue({ state: "building" });
    mocks.isJsmBuildStale.mockReturnValue(true);
    expect(await buildJsmInventory(ctx)).toEqual({ queued: true });
  });

  test("refuses in read-only mode", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true });
    expect(await buildJsmInventory(ctx)).toMatchObject({ queued: false, error: expect.stringMatching(/Read-only/) });
    expect(mocks.queueJsmSnapshotBuild).not.toHaveBeenCalled();
  });

  test("both are admin-only", () => {
    expect(SHARED_RESOLVER_FUNCTIONS).not.toHaveProperty("getJsmInventory");
    expect(SHARED_RESOLVER_FUNCTIONS).not.toHaveProperty("buildJsmInventory");
  });
});
