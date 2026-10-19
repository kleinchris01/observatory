import { vi, describe, test, expect, beforeEach } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks } from "./test-harness.js";
import {
  ADMIN_ONLY_FUNCTIONS,
  __RAW_ADMIN_ONLY_FUNCTIONS,
  CLEAR_SNAPSHOT_CONFIRMATION,
  __resetAdminCheckCache,
  AdminPermissionError,
} from "../resolvers.js";
import {
  AUDITED_ADMIN_ACTIONS,
  DENIAL_BURST_THRESHOLD,
  JIRA_WRITE_ACTIONS,
  __resetDenialBurstState,
} from "./admin-guard.js";
import { logger } from "../lib/logger.js";

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// Admin authorization guard
//
// Before this existed, the ONLY thing standing between an arbitrary authenticated
// user and clearSnapshot / saveAdminConfig / migrateNamespaceKeys was that the
// jira:adminPage module decides who sees the admin *page*. An invoke() does not
// go through the page. These tests assert the boundary is now in the resolver,
// where it belongs, and that it is applied to the whole registry rather than
// remembered function by function.
// ---------------------------------------------------------------------------
describe("admin authorization guard", () => {
  const ADMIN_CTX = { context: { accountId: "acct-admin" }, payload: {} };

  beforeEach(() => {
    __resetAdminCheckCache();
    mocks.callerHasJiraAdmin.mockResolvedValue(true);
  });

  test("every admin-only function is wrapped, not just the ones someone remembered", () => {
    // The guard is applied to the registry, so raw and wrapped must have identical
    // key sets and no entry may be the raw function itself.
    expect(Object.keys(ADMIN_ONLY_FUNCTIONS).sort()).toEqual(Object.keys(__RAW_ADMIN_ONLY_FUNCTIONS).sort());
    for (const [name, fn] of Object.entries(ADMIN_ONLY_FUNCTIONS)) {
      expect(fn, `${name} is unwrapped`).not.toBe(__RAW_ADMIN_ONLY_FUNCTIONS[name]);
    }
  });

  test("rejects a caller without Jira ADMINISTER", async () => {
    mocks.callerHasJiraAdmin.mockResolvedValue(false);

    await expect(ADMIN_ONLY_FUNCTIONS.clearSnapshot(ADMIN_CTX)).rejects.toThrow(AdminPermissionError);
    expect(mocks.clearAllSnapshotData).not.toHaveBeenCalled();
  });

  test("rejects an anonymous caller without even asking Jira", async () => {
    await expect(ADMIN_ONLY_FUNCTIONS.clearSnapshot({ context: {}, payload: {} })).rejects.toThrow(
      AdminPermissionError,
    );
    expect(mocks.callerHasJiraAdmin).not.toHaveBeenCalled();
  });

  test("allows a caller who holds Jira ADMINISTER", async () => {
    await expect(
      ADMIN_ONLY_FUNCTIONS.clearSnapshot({
        context: { accountId: "acct-admin" },
        payload: { confirmation: CLEAR_SNAPSHOT_CONFIRMATION },
      }),
    ).resolves.toMatchObject({ cleared: true });
  });

  test("guards the config and overview resolvers that used to bypass the registry", async () => {
    mocks.callerHasJiraAdmin.mockResolvedValue(false);

    for (const name of ["getAdminConfig", "saveAdminConfig", "getAdminOverview", "migrateNamespaceKeys"]) {
      await expect(ADMIN_ONLY_FUNCTIONS[name](ADMIN_CTX), name).rejects.toThrow(AdminPermissionError);
    }
  });

  test("records a denial in the audit log", async () => {
    mocks.callerHasJiraAdmin.mockResolvedValue(false);

    await expect(ADMIN_ONLY_FUNCTIONS.startIssueScan(ADMIN_CTX)).rejects.toThrow();

    expect(mocks.recordAuditEvent).toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({
        actorId: "acct-admin",
        action: "startIssueScan",
        outcome: "denied",
      }),
    );
  });

  test("caches the permission answer instead of asking Jira on every call", async () => {
    await ADMIN_ONLY_FUNCTIONS.getIssueScanStatus(ADMIN_CTX);
    await ADMIN_ONLY_FUNCTIONS.getIssueScanStatus(ADMIN_CTX);
    await ADMIN_ONLY_FUNCTIONS.getIssueScanStatus(ADMIN_CTX);

    expect(mocks.callerHasJiraAdmin).toHaveBeenCalledTimes(1);
  });

  test("caches per account, so one admin does not authorise everyone", async () => {
    mocks.callerHasJiraAdmin.mockImplementation(async (id) => id === "acct-admin");

    await expect(ADMIN_ONLY_FUNCTIONS.getIssueScanStatus(ADMIN_CTX)).resolves.toBeDefined();
    await expect(
      ADMIN_ONLY_FUNCTIONS.getIssueScanStatus({ context: { accountId: "acct-other" }, payload: {} }),
    ).rejects.toThrow(AdminPermissionError);
  });
});

// ---------------------------------------------------------------------------
// Denial-burst alerting
// ---------------------------------------------------------------------------
describe("denial-burst alerting", () => {
  const CTX = { context: { accountId: "acct-probe" }, payload: {} };
  const burstEvents = (spy) => spy.mock.calls.filter(([event]) => event === "security.denial_burst");

  beforeEach(() => {
    __resetAdminCheckCache();
    __resetDenialBurstState();
    mocks.callerHasJiraAdmin.mockResolvedValue(false);
    mocks.summarizeRecentDenials.mockResolvedValue({ denials: 1, actors: 1, latestAt: "2026-10-19T12:00:00Z" });
  });

  test("a denial at or under the threshold raises no alert", async () => {
    mocks.summarizeRecentDenials.mockResolvedValueOnce({ denials: DENIAL_BURST_THRESHOLD, actors: 1, latestAt: null });
    const spy = vi.spyOn(logger, "error");

    await expect(ADMIN_ONLY_FUNCTIONS.clearSnapshot(CTX)).rejects.toThrow(AdminPermissionError);

    expect(mocks.summarizeRecentDenials).toHaveBeenCalledWith("test-install", 60 * 60 * 1000);
    expect(burstEvents(spy)).toHaveLength(0);
    spy.mockRestore();
  });

  test("crossing the threshold logs security.denial_burst with the counts", async () => {
    mocks.summarizeRecentDenials.mockResolvedValueOnce({ denials: 6, actors: 2, latestAt: null });
    const spy = vi.spyOn(logger, "error");

    await expect(ADMIN_ONLY_FUNCTIONS.saveAdminConfig(CTX)).rejects.toThrow(AdminPermissionError);

    expect(burstEvents(spy)).toEqual([
      [
        "security.denial_burst",
        expect.objectContaining({ denials: 6, actors: 2, threshold: 5, latestAction: "saveAdminConfig" }),
      ],
    ]);
    spy.mockRestore();
  });

  // A flood must cost one audit insert per denial and nothing more: no repeat alerts, and no
  // count query, until the cooldown has passed.
  test("alerts once per cooldown and stops counting while it lasts", async () => {
    mocks.summarizeRecentDenials.mockResolvedValue({ denials: 40, actors: 1, latestAt: null });
    const spy = vi.spyOn(logger, "error");

    for (let i = 0; i < 4; i++) {
      await expect(ADMIN_ONLY_FUNCTIONS.clearSnapshot(CTX)).rejects.toThrow(AdminPermissionError);
    }

    expect(burstEvents(spy)).toHaveLength(1);
    expect(mocks.summarizeRecentDenials).toHaveBeenCalledTimes(1);
    expect(mocks.recordAuditEvent).toHaveBeenCalledTimes(4);
    spy.mockRestore();
  });

  test("a failing count never changes the refusal", async () => {
    mocks.summarizeRecentDenials.mockRejectedValueOnce(new Error("sql down"));

    await expect(ADMIN_ONLY_FUNCTIONS.clearSnapshot(CTX)).rejects.toThrow(AdminPermissionError);
    expect(mocks.clearAllSnapshotData).not.toHaveBeenCalled();
  });

  test("an allowed admin call never runs the burst check", async () => {
    mocks.callerHasJiraAdmin.mockResolvedValue(true);
    await ADMIN_ONLY_FUNCTIONS.getIssueScanStatus({ context: { accountId: "acct-admin" }, payload: {} });
    expect(mocks.summarizeRecentDenials).not.toHaveBeenCalled();
  });

  describe("getSecuritySignals", () => {
    const ADMIN = { context: { accountId: "acct-admin" }, payload: {} };
    beforeEach(() => mocks.callerHasJiraAdmin.mockResolvedValue(true));

    test("reports a burst by the same rule the guard alerts on", async () => {
      mocks.summarizeRecentDenials.mockResolvedValueOnce({ denials: 9, actors: 3, latestAt: "2026-10-19T12:00:00Z" });
      expect(await ADMIN_ONLY_FUNCTIONS.getSecuritySignals(ADMIN)).toEqual({
        ok: true,
        denials: {
          denials: 9,
          actors: 3,
          latestAt: "2026-10-19T12:00:00Z",
          windowMinutes: 60,
          threshold: 5,
          burst: true,
        },
      });
    });

    test("a quiet hour is not a burst", async () => {
      mocks.summarizeRecentDenials.mockResolvedValueOnce({ denials: 2, actors: 1, latestAt: null });
      const res = await ADMIN_ONLY_FUNCTIONS.getSecuritySignals(ADMIN);
      expect(res.denials.burst).toBe(false);
    });

    // Silence is not all-clear: a failed read must say so rather than report zero denials.
    test("a failed read is unavailable, not zero", async () => {
      mocks.summarizeRecentDenials.mockRejectedValueOnce(new Error("sql down"));
      expect(await ADMIN_ONLY_FUNCTIONS.getSecuritySignals(ADMIN)).toEqual({
        ok: false,
        unavailable: expect.stringContaining("could not be read"),
      });
    });

    test("is admin-only", async () => {
      mocks.callerHasJiraAdmin.mockResolvedValue(false);
      await expect(ADMIN_ONLY_FUNCTIONS.getSecuritySignals(ADMIN)).rejects.toThrow(AdminPermissionError);
    });
  });
});

// ---------------------------------------------------------------------------
// Jira write actions
// ---------------------------------------------------------------------------
describe("Jira write actions", () => {
  const ADMIN = { context: { accountId: "acct-admin" } };
  const WRITE_HELPERS = ["createJiraIssue", "updateJiraIssue", "transitionIssueWithComment"];

  beforeEach(() => {
    __resetAdminCheckCache();
    mocks.callerHasJiraAdmin.mockResolvedValue(true);
  });

  test("every Jira-writing action is audited and admin-only", () => {
    expect(JIRA_WRITE_ACTIONS.size).toBeGreaterThan(0);
    for (const name of JIRA_WRITE_ACTIONS) {
      expect(AUDITED_ADMIN_ACTIONS.has(name), `${name} is not audited`).toBe(true);
      expect(__RAW_ADMIN_ONLY_FUNCTIONS[name], `${name} is not in the admin registry`).toBeDefined();
    }
  });

  // The list above is only as good as its completeness. Today every Jira write goes through
  // the remediation module (and the hierarchy helper it hands the write functions to). A new
  // caller anywhere else fails here until its action is added to JIRA_WRITE_ACTIONS.
  test("no module outside remediation calls a Jira write helper", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const root = join(process.cwd(), "src");
    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".js") && !name.includes(".test.")) files.push(full);
      }
    };
    walk(root);
    const callers = files
      .filter((f) => {
        const text = readFileSync(f, "utf8");
        return WRITE_HELPERS.some((h) => new RegExp(`\\b${h}\\s*\\(`).test(text));
      })
      .map((f) => relative(root, f).replace(/\\/g, "/"))
      .sort();
    expect(callers).toEqual(["lib/jira-api.js", "lib/remediation-hierarchy.js", "resolvers/remediation.js"]);
  });

  test.each([...JIRA_WRITE_ACTIONS])("%s refuses in read-only mode before writing anything", async (name) => {
    mocks.kvsGet.mockResolvedValue({
      readOnlyMode: true,
      remediation: { projectKey: "OPS", hierarchyEnabled: true },
    });

    const result = await ADMIN_ONLY_FUNCTIONS[name]({
      ...ADMIN,
      payload: { findingKey: "filter-ownership", issueKeys: ["OPS-1"] },
    });

    expect(result.error).toMatch(/Read-only mode is enabled/);
    for (const helper of WRITE_HELPERS) expect(mocks[helper], helper).not.toHaveBeenCalled();
  });

  test("organiseRemediationHierarchy is recorded in the audit log", async () => {
    mocks.kvsGet.mockResolvedValue({ readOnlyMode: true });
    await ADMIN_ONLY_FUNCTIONS.organiseRemediationHierarchy(ADMIN);
    expect(mocks.recordAuditEvent).toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({ action: "organiseRemediationHierarchy", actorId: "acct-admin" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------
describe("audit trail", () => {
  const ADMIN_CTX = { context: { accountId: "acct-admin" }, payload: {} };

  beforeEach(() => {
    __resetAdminCheckCache();
    mocks.callerHasJiraAdmin.mockResolvedValue(true);
  });

  test("records a completed privileged action", async () => {
    await ADMIN_ONLY_FUNCTIONS.cancelSnapshot(ADMIN_CTX);

    expect(mocks.recordAuditEvent).toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({
        actorId: "acct-admin",
        action: "cancelSnapshot",
        outcome: "allowed",
      }),
    );
  });

  // Several resolvers signal refusal by returning { error } rather than throwing.
  // Recording those as plain successes would make the audit log say an action
  // happened when it did not.
  test("records a returned refusal as refused, not as a completed action", async () => {
    await ADMIN_ONLY_FUNCTIONS.clearSnapshot({
      context: { accountId: "acct-admin" },
      payload: { confirmation: "nope" },
    });

    expect(mocks.recordAuditEvent).toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({
        action: "clearSnapshot",
        outcome: "allowed",
        detail: expect.stringContaining("Refused:"),
      }),
    );
  });

  test("records a thrown failure and still propagates the error", async () => {
    mocks.clearAllSnapshotData.mockRejectedValueOnce(new Error("sql exploded"));

    await expect(
      ADMIN_ONLY_FUNCTIONS.clearSnapshot({
        context: { accountId: "acct-admin" },
        payload: { confirmation: CLEAR_SNAPSHOT_CONFIRMATION },
      }),
    ).rejects.toThrow("sql exploded");

    expect(mocks.recordAuditEvent).toHaveBeenCalledWith(
      "test-install",
      expect.objectContaining({
        action: "clearSnapshot",
        outcome: "failed",
        detail: expect.stringContaining("sql exploded"),
      }),
    );
  });

  // Admin reads are polled every 15s for the length of a scan. Auditing them would
  // bury the handful of events anyone actually wants to find.
  test("does not audit high-frequency admin reads", async () => {
    await ADMIN_ONLY_FUNCTIONS.getIssueScanStatus(ADMIN_CTX);
    expect(mocks.recordAuditEvent).not.toHaveBeenCalled();
  });

  // A broken audit table must not become an outage of every admin action -- nor a
  // denial-of-service that anyone able to break that table can trigger.
  test("an audit write failure never blocks the action", async () => {
    mocks.recordAuditEvent.mockRejectedValueOnce(new Error("audit table gone"));

    await expect(ADMIN_ONLY_FUNCTIONS.cancelSnapshot(ADMIN_CTX)).resolves.toEqual({ cancelled: true });
  });

  test("an audit write failure never turns a denial into a server error", async () => {
    mocks.callerHasJiraAdmin.mockResolvedValue(false);
    mocks.recordAuditEvent.mockRejectedValueOnce(new Error("audit table gone"));

    await expect(ADMIN_ONLY_FUNCTIONS.cancelSnapshot(ADMIN_CTX)).rejects.toThrow(AdminPermissionError);
  });
});
