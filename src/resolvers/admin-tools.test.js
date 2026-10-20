import { describe, test, expect, beforeEach } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks } from "./test-harness.js";
import {
  SHARED_RESOLVER_FUNCTIONS,
  ADMIN_ONLY_FUNCTIONS,
  migrateNamespaceKeys,
  __resetAdminCheckCache,
  AdminPermissionError,
} from "../resolvers.js";

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// migrateNamespaceKeys -- a real data migration, thin at the resolver layer
// (the actual row-rewriting logic lives in migrateOldScopeKeys/project-store.js,
// out of scope here). Covers the delegation contract: correct installation
// key derivation, result passed through verbatim, and errors not swallowed.
// ---------------------------------------------------------------------------
describe("migrateNamespaceKeys", () => {
  test("ensures storage is ready and delegates to migrateOldScopeKeys with the installation key", async () => {
    mocks.migrateOldScopeKeys.mockResolvedValue({ migrated: 42, skipped: 3 });

    const result = await migrateNamespaceKeys({ context: {} });

    expect(mocks.ensureProjectStoreReady).toHaveBeenCalled();
    expect(mocks.migrateOldScopeKeys).toHaveBeenCalledWith("test-install");
    expect(result).toEqual({ migrated: 42, skipped: 3 });
  });

  test("does not swallow an error from the underlying migration", async () => {
    mocks.migrateOldScopeKeys.mockRejectedValue(new Error("migration failed: duplicate key"));
    await expect(migrateNamespaceKeys({ context: {} })).rejects.toThrow("migration failed: duplicate key");
  });
});

// ---------------------------------------------------------------------------
// getAuditLog
// ---------------------------------------------------------------------------
describe("getAuditLog", () => {
  const ADMIN_CTX = { context: { accountId: "acct-admin" }, payload: {} };

  beforeEach(() => {
    __resetAdminCheckCache();
    mocks.callerHasJiraAdmin.mockResolvedValue(true);
    mocks.listAuditEvents.mockResolvedValue([
      { at: "2026-07-31T10:00:00Z", actorId: "acct-1", action: "clearSnapshot", outcome: "allowed", detail: null },
    ]);
  });

  test("returns events for the installation with a default limit", async () => {
    const result = await ADMIN_ONLY_FUNCTIONS.getAuditLog(ADMIN_CTX);

    expect(mocks.listAuditEvents).toHaveBeenCalledWith("test-install", 100);
    expect(result.events).toHaveLength(1);
    expect(result.limit).toBe(100);
  });

  test("honours a caller-supplied limit", async () => {
    await ADMIN_ONLY_FUNCTIONS.getAuditLog({ context: { accountId: "acct-admin" }, payload: { limit: 500 } });
    expect(mocks.listAuditEvents).toHaveBeenCalledWith("test-install", 500);
  });

  test("rejects a limit above the allowed ceiling", async () => {
    await expect(
      ADMIN_ONLY_FUNCTIONS.getAuditLog({ context: { accountId: "acct-admin" }, payload: { limit: 99999 } }),
    ).rejects.toThrow(/limit/i);
  });

  // Reading the audit log is not itself an audited event -- that loop would bury the
  // events worth finding, and it exposes nothing an admin could not already query.
  test("reading the audit log is not itself audited", async () => {
    await ADMIN_ONLY_FUNCTIONS.getAuditLog(ADMIN_CTX);
    expect(mocks.recordAuditEvent).not.toHaveBeenCalled();
  });

  test("is admin-guarded and never on the shared macro resolver", async () => {
    expect(SHARED_RESOLVER_FUNCTIONS.getAuditLog).toBeUndefined();

    mocks.callerHasJiraAdmin.mockResolvedValue(false);
    await expect(ADMIN_ONLY_FUNCTIONS.getAuditLog(ADMIN_CTX)).rejects.toThrow(AdminPermissionError);
  });
});
