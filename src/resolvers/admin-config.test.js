import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks } from "./test-harness.js";
import { readAdminConfig, getAdminConfigResolver, saveAdminConfigResolver } from "../resolvers.js";

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// Admin config -- readAdminConfig / getAdminConfigResolver / saveAdminConfigResolver
// ---------------------------------------------------------------------------
describe("readAdminConfig", () => {
  test("returns defaults when nothing is stored", async () => {
    mocks.kvsGet.mockResolvedValue(null);
    const config = await readAdminConfig();
    expect(config.readOnlyMode).toBe(false);
    expect(config.macroAccess).toEqual({ restrictAccess: false, allowedGroups: [] });
  });

  test("deep-merges stored config over defaults, not a shallow overwrite", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true, macroAccess: { restrictAccess: true } });
    const config = await readAdminConfig();
    expect(config.readOnlyMode).toBe(true);
    // allowedGroups wasn't in the stored macroAccess -- must still come from defaults, not vanish
    expect(config.macroAccess).toEqual({ restrictAccess: true, allowedGroups: [] });
  });

  test("falls back to defaults if kvs.get throws", async () => {
    mocks.kvsGet.mockRejectedValue(new Error("kvs unavailable"));
    const config = await readAdminConfig();
    expect(config.readOnlyMode).toBe(false);
  });
});

describe("getAdminConfigResolver", () => {
  test("delegates to readAdminConfig", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true });
    const config = await getAdminConfigResolver({}, {});
    expect(config.readOnlyMode).toBe(true);
  });
});

describe("saveAdminConfigResolver", () => {
  test("validates apiConcurrency bounds", async () => {
    await expect(saveAdminConfigResolver({ payload: { apiConcurrency: 99 } })).rejects.toThrow(/apiConcurrency/);
  });

  test("validates autoSnapshotFrequency against the allowed enum", async () => {
    await expect(saveAdminConfigResolver({ payload: { autoSnapshotFrequency: "hourly" } })).rejects.toThrow(
      /autoSnapshotFrequency/,
    );
  });

  test("validates governance threshold values are positive integers", async () => {
    await expect(
      saveAdminConfigResolver({ payload: { governanceThresholds: { lowUsageIssueThreshold: -5 } } }),
    ).rejects.toThrow(/lowUsageIssueThreshold/);
  });

  test("validates the quick-scan schedule's frequency, day, hour, and window", async () => {
    await expect(saveAdminConfigResolver({ payload: { quickScanSchedule: { frequency: "hourly" } } })).rejects.toThrow(
      /quickScanSchedule\.frequency/,
    );
    await expect(saveAdminConfigResolver({ payload: { quickScanSchedule: { dayOfWeek: 9 } } })).rejects.toThrow(
      /quickScanSchedule\.dayOfWeek/,
    );
    await expect(saveAdminConfigResolver({ payload: { quickScanSchedule: { hourUtc: 24 } } })).rejects.toThrow(
      /quickScanSchedule\.hourUtc/,
    );
    await expect(saveAdminConfigResolver({ payload: { quickScanSchedule: { windowHours: 0 } } })).rejects.toThrow(
      /quickScanSchedule\.windowHours/,
    );
  });

  test("rejects a remediation project key that is not a Jira key", async () => {
    await expect(saveAdminConfigResolver({ payload: { remediation: { projectKey: "not a key!" } } })).rejects.toThrow(
      /remediation\.projectKey/,
    );
    await expect(saveAdminConfigResolver({ payload: { remediation: { epicIssueType: 123 } } })).rejects.toThrow(
      /remediation\.epicIssueType/,
    );
  });

  test("accepts and merges a valid remediation config, keeping the rest", async () => {
    mocks.kvsGet.mockResolvedValue({
      remediation: { projectKey: "OLD", epicIssueType: "Epic", taskIssueType: "Task", defaultAssigneeAccountId: "" },
    });
    const result = await saveAdminConfigResolver({ payload: { remediation: { projectKey: "ADMIN" } } });
    expect(result.config.remediation).toMatchObject({
      projectKey: "ADMIN",
      epicIssueType: "Epic",
      taskIssueType: "Task",
    });
  });

  test("an empty remediation project key is allowed — it just disables the feature", async () => {
    const result = await saveAdminConfigResolver({ payload: { remediation: { projectKey: "" } } });
    expect(result.ok).toBe(true);
  });

  test("merges a partial schedule update over the stored one, keeping the rest", async () => {
    mocks.kvsGet.mockResolvedValue({
      quickScanSchedule: { enabled: true, frequency: "weekly", dayOfWeek: 3, hourUtc: 6, windowHours: 168 },
    });

    const result = await saveAdminConfigResolver({ payload: { quickScanSchedule: { hourUtc: 12 } } });

    // Only hourUtc was sent; everything else the admin already configured must survive.
    expect(result.config.quickScanSchedule).toMatchObject({
      enabled: true,
      frequency: "weekly",
      dayOfWeek: 3,
      hourUtc: 12,
      windowHours: 168,
    });
  });

  test("merges partial updates over the current stored config and persists via kvs.set", async () => {
    mocks.kvsGet.mockResolvedValue({
      readOnlyMode: false,
      apiConcurrency: 4,
      macroAccess: { restrictAccess: false, allowedGroups: [] },
    });

    const result = await saveAdminConfigResolver({ payload: { readOnlyMode: true } });

    expect(result.ok).toBe(true);
    expect(result.config.readOnlyMode).toBe(true);
    expect(mocks.kvsSet).toHaveBeenCalledWith("atlasiq-admin-config", expect.objectContaining({ readOnlyMode: true }));
  });

  test("clamps apiConcurrency into [1, 10] even if a valid-but-out-of-clamp-range value slips through", async () => {
    mocks.kvsGet.mockResolvedValue(null);
    const result = await saveAdminConfigResolver({ payload: { apiConcurrency: 1 } });
    expect(result.config.apiConcurrency).toBe(1);
  });

  // The automation staleness gate is only a gate while its threshold is inside a sane band.
  // Zero would mark every analysis stale and silence the pillar; a very large value would
  // silence the warning instead, which is the same as deleting it.
  test("rejects an automation staleness threshold outside 1-90 days", async () => {
    for (const bad of [0, -1, 365]) {
      await expect(saveAdminConfigResolver({ payload: { automationStaleAfterDays: bad } })).rejects.toThrow(
        /automationStaleAfterDays/,
      );
    }
  });

  test("accepts and stores a tuned automation staleness threshold", async () => {
    mocks.kvsGet.mockResolvedValue(null);
    const result = await saveAdminConfigResolver({ payload: { automationStaleAfterDays: 14 } });
    expect(result.config.automationStaleAfterDays).toBe(14);
  });

  test("clamps a stored staleness threshold that reached storage some other way", async () => {
    // An older build, or a hand-edited record. Validation only guards the write path.
    mocks.kvsGet.mockResolvedValue({ automationStaleAfterDays: 9999 });
    const result = await saveAdminConfigResolver({ payload: {} });
    expect(result.config.automationStaleAfterDays).toBe(90);
  });

  test("defaults the staleness threshold rather than disabling the gate on a junk value", async () => {
    mocks.kvsGet.mockResolvedValue({ automationStaleAfterDays: "soon" });
    const result = await saveAdminConfigResolver({ payload: {} });
    expect(result.config.automationStaleAfterDays).toBe(7);
  });
});
