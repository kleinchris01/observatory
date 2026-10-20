import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks, snapshotField, ctxWithAccount } from "../test-harness.js";
import { rovoSearchFields, rovoInspectField } from "../../resolvers.js";

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// Rovo agent actions -- note the (payload, context) positional signature,
// different from every other resolver's ({ payload, context }) destructure.
// ---------------------------------------------------------------------------
describe("rovoSearchFields", () => {
  test("requires a query", async () => {
    const result = await rovoSearchFields({}, {});
    expect(result).toEqual({ status: "error", message: "A search query is required." });
  });

  test("reports snapshot-unavailable when no snapshot has completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    const result = await rovoSearchFields({ query: "story points" }, {});
    expect(result.status).toBe("snapshot-unavailable");
    expect(result.matches).toEqual([]);
  });

  test("returns matching fields, capped at maxResults", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.loadSnapshotFields.mockResolvedValue([
      snapshotField({ id: "customfield_1", name: "Story Points" }),
      snapshotField({ id: "customfield_2", name: "Story Estimate" }),
    ]);

    const result = await rovoSearchFields({ query: "story", maxResults: 1 }, {});

    expect(result.status).toBe("ok");
    expect(result.matches).toHaveLength(1);
    expect(result.totalMatches).toBe(1);
  });
});

describe("rovoInspectField", () => {
  test("requires a fieldIdentifier", async () => {
    const result = await rovoInspectField({}, {});
    expect(result).toEqual({ status: "error", message: "A field identifier is required." });
  });

  test("reports snapshot-unavailable when no snapshot has completed", async () => {
    mocks.readSnapshotMeta.mockResolvedValue(null);
    const result = await rovoInspectField({ fieldIdentifier: "Story Points" }, {});
    expect(result.status).toBe("snapshot-unavailable");
  });

  test("reports not-found when no field matches the identifier", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField({ id: "customfield_1", name: "Story Points" })]);
    const result = await rovoInspectField({ fieldIdentifier: "Nonexistent Field" }, {});
    expect(result.status).toBe("not-found");
  });

  test("matches by exact id, then exact name, then name prefix, then substring -- in that priority order", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField({ id: "customfield_10001", name: "Story Points" })]);
    mocks.getLiveFieldProjectUsage.mockResolvedValue({ projectUsage: [], total: 0, totalIssueCount: 0 });

    const byId = await rovoInspectField({ fieldIdentifier: "customfield_10001" }, {});
    expect(byId.field.id).toBe("customfield_10001");

    const byName = await rovoInspectField({ fieldIdentifier: "Story Points" }, {});
    expect(byName.field.id).toBe("customfield_10001");

    const byPrefix = await rovoInspectField({ fieldIdentifier: "Story" }, {});
    expect(byPrefix.field.id).toBe("customfield_10001");
  });

  test("returns governance and live project usage for a matched field", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField({ id: "customfield_1", name: "Story Points" })]);
    mocks.getLiveFieldProjectUsage.mockResolvedValue({
      projectUsage: [{ projectKey: "ABC", projectName: "Alpha", issueCount: 5, jql: "project = ABC" }],
      total: 1,
      totalIssueCount: 5,
    });

    const result = await rovoInspectField({ fieldIdentifier: "Story Points" }, {});

    expect(result.status).toBe("ok");
    expect(result.governance.activeProjectCount).toBe(1);
    expect(result.projectUsage).toHaveLength(1);
  });

  test("never returns a project the Rovo caller lacks Browse Projects permission on", async () => {
    mocks.readSnapshotMeta.mockResolvedValue({ version: 1, refreshedAt: "2026-01-01T00:00:00Z" });
    mocks.loadSnapshotFields.mockResolvedValue([snapshotField({ id: "customfield_1", name: "Story Points" })]);
    mocks.getLiveFieldProjectUsage.mockResolvedValue({
      projectUsage: [
        { projectId: "10", projectKey: "ABC", projectName: "Alpha", issueCount: 5, jql: "project = ABC" },
        { projectId: "20", projectKey: "SECRET", projectName: "Confidential", issueCount: 3, jql: "project = SECRET" },
      ],
      total: 2,
      totalIssueCount: 8,
    });
    mocks.getBrowsableProjectIds.mockResolvedValue(new Set(["10"]));

    const result = await rovoInspectField({ fieldIdentifier: "Story Points" }, ctxWithAccount());

    expect(result.projectUsage).toHaveLength(1);
    expect(result.projectUsage[0].projectKey).toBe("ABC");
  });
});
