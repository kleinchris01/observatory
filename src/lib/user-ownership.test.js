import { describe, test, expect, vi } from "vitest";

// user-ownership.js imports the store for buildOwnershipIndex; the pure helpers under test
// never touch it.
vi.mock("./project-store.js", () => ({}));
vi.mock("./store/automation.js", () => ({}));

import { activeRosterIds, summarizeOrphanedOwnership } from "./user-ownership.js";

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
