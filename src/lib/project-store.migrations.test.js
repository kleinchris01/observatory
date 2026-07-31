import { vi, describe, test, expect, beforeEach, afterEach } from "vitest";

// Migration-runner tests live in their own FILE, not just their own describe block.
//
// They call vi.resetModules() so that project-store.js's module-level migrationPromise
// singleton is rebuilt per test -- without it a later test would see the promise from an
// earlier successful run and never call .run() again.
//
// The cost is that after a reset, a statically-imported binding no longer refers to the
// module instance the code under test is now using. Sharing a file with tests that patch
// `sql.prepare` through a top-level import meant those tests were patching a stale object.
// Vitest 2 tolerated this by accident; Vitest 4 does not. Splitting the file removes the
// hazard rather than relying on describe ordering to hide it.

vi.mock("@forge/sql", () => {
  const runner = { enqueue: () => runner, run: vi.fn().mockResolvedValue(undefined) };
  return {
    sql: {
      prepare: vi.fn().mockReturnValue({
        bindParams: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
      }),
      executeInTransaction: vi.fn().mockResolvedValue(undefined),
    },
    migrationRunner: runner,
  };
});

afterEach(() => vi.restoreAllMocks());

// ── ensureProjectStoreReady ──────────────────────────────────────────────────
//
// A brand-new install's first page load fires several resolvers concurrently, each its
// own Forge invocation, each calling this against a completely empty database -- they can
// race on the same CREATE/ALTER TABLE statement. Regression coverage for the retry added
// to absorb that: the migration runner tracks which migrations already succeeded, so
// retrying the whole run is safe and should resume past a one-time collision.
//
// Uses vi.resetModules() + a fresh dynamic import per test because migrationPromise is
// module-level singleton state in project-store.js -- without a reset, a later test would
// see the promise from an earlier test's successful run and never call .run() again.

describe("ensureProjectStoreReady", () => {
  // vi.resetModules() rebuilds project-store.js, but it does NOT re-run the vi.mock
  // factory above -- the migrationRunner object, and the vi.fn() on it, survive every
  // reset. Under Vitest 2 the afterEach restoreAllMocks() happened to clear that fn's
  // call history too; Vitest 4 tightened restore to only undo spies, so counts and
  // implementations leaked between tests (the "expected 3 calls, got 5" failure was
  // this test's 3 plus the previous test's 2).
  //
  // Reset and re-arm the default explicitly rather than relying on any framework's
  // interpretation of "restore".
  beforeEach(async () => {
    vi.resetModules();
    const sqlMod = await import("@forge/sql");
    sqlMod.migrationRunner.run.mockReset();
    sqlMod.migrationRunner.run.mockResolvedValue(undefined);
  });

  test("retries the migration run after a transient failure and eventually succeeds", async () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn) => { fn(); return 0; });
    const sqlMod = await import("@forge/sql");
    sqlMod.migrationRunner.run
      .mockRejectedValueOnce(new Error("Failed to execute migration with name v010_alter_snapshot_meta_add_job_token"))
      .mockResolvedValueOnce(undefined);

    const { ensureProjectStoreReady } = await import("./project-store.js");
    await expect(ensureProjectStoreReady()).resolves.toBeUndefined();
    expect(sqlMod.migrationRunner.run).toHaveBeenCalledTimes(2);
  });

  test("throws after exhausting all retry attempts on a persistent failure", async () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn) => { fn(); return 0; });
    const sqlMod = await import("@forge/sql");
    sqlMod.migrationRunner.run.mockRejectedValue(new Error("still broken"));

    const { ensureProjectStoreReady } = await import("./project-store.js");
    await expect(ensureProjectStoreReady()).rejects.toThrow("still broken");
    expect(sqlMod.migrationRunner.run).toHaveBeenCalledTimes(3);
  });

  test("only runs migrations once for concurrent callers within the same invocation", async () => {
    const sqlMod = await import("@forge/sql");
    const { ensureProjectStoreReady } = await import("./project-store.js");

    await Promise.all([ensureProjectStoreReady(), ensureProjectStoreReady(), ensureProjectStoreReady()]);

    expect(sqlMod.migrationRunner.run).toHaveBeenCalledTimes(1);
  });
});

