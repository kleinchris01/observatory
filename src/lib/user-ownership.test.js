import { describe, test, expect, vi } from "vitest";

// user-ownership.js imports the store for buildOwnershipIndex; the pure helpers under test
// never touch it.
vi.mock("./project-store.js", () => ({}));
vi.mock("./store/automation.js", () => ({}));

import { activeRosterIds, summarizeOrphanedOwnership, classifyUserActivity, DORMANT_ACCOUNT_DAYS } from "./user-ownership.js";

describe("activeRosterIds", () => {
  // The roster now carries deactivated accounts so the People tab and licence hygiene can
  // see them. A deactivated account still owning config is what the off-roster checks exist
  // to find, so it must not count as present.
  test("counts active accounts and leaves deactivated ones out", () => {
    const ids = activeRosterIds([
      { accountId: "a", active: true },
      { accountId: "b", active: false },
      { accountId: "c" },
    ]);
    expect([...ids].sort()).toEqual(["a", "c"]);
  });

  test("treats a missing roster as empty", () => {
    expect(activeRosterIds().size).toBe(0);
    expect(activeRosterIds([null]).size).toBe(0);
  });

  test("feeds orphaned ownership so a deactivated owner is still orphaned", () => {
    const ownership = {
      byAccount: new Map([
        ["a", { filters: [1], dashboards: [], rules: [] }],
        ["b", { filters: [2, 3], dashboards: [], rules: [] }],
      ]),
    };
    const roster = activeRosterIds([{ accountId: "a", active: true }, { accountId: "b", active: false }]);
    const result = summarizeOrphanedOwnership(ownership, roster);
    expect(result.orphanedOwners).toBe(1);
    expect(result.orphanedFilters).toBe(2);
  });
});

// The one dormancy rule the score, the roster, the report and remediation share.
describe("classifyUserActivity", () => {
  const now = Date.parse("2026-10-06T00:00:00Z");
  const users = [
    { accountId: "idle", active: true },
    { accountId: "busy", active: true },
    { accountId: "gone", active: false },
    { accountId: "unseen", active: true },
  ];
  const rows = [
    { accountId: "idle", lastActivityAt: "2025-06-01T00:00:00Z" },
    { accountId: "busy", lastActivityAt: "2026-09-30T00:00:00Z" },
    { accountId: "gone", lastActivityAt: "2024-01-01T00:00:00Z" },
  ];

  test("an account idle for over a year is dormant; recent activity is not", () => {
    const r = classifyUserActivity(users, rows, { now });
    expect(r.byAccount.get("idle")).toEqual({ lastActivityAt: "2025-06-01T00:00:00Z", dormant: true });
    expect(r.byAccount.get("busy").dormant).toBe(false);
    expect(r).toMatchObject({ measured: true, measuredAccounts: 2, dormantAccounts: 1, dormantAfterDays: DORMANT_ACCOUNT_DAYS });
  });

  test("a deactivated account and an account the crawl never saw are neither dormant nor counted", () => {
    const r = classifyUserActivity(users, rows, { now });
    expect(r.byAccount.get("gone").dormant).toBeNull();
    expect(r.byAccount.get("unseen")).toEqual({ lastActivityAt: null, dormant: null });
  });

  test("no activity rows at all is unmeasured, never 'everyone idle'", () => {
    const r = classifyUserActivity(users, [], { now });
    expect(r).toMatchObject({ measured: false, measuredAccounts: 0, dormantAccounts: 0 });
    expect([...r.byAccount.values()].every((a) => a.dormant === null)).toBe(true);
  });
});
