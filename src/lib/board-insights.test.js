import { describe, test, expect } from "vitest";
import { summarizeBoardInsights, summarizeBoardHealth } from "./board-insights.js";

const board = (over = {}) => ({
  boardId: "1", name: "B", type: "scrum", locationKey: "AAA",
  configReadable: true, filterId: "100", columns: [{ statusIds: ["1", "2"] }], ...over,
});

describe("summarizeBoardInsights", () => {
  test("clean estate flags nothing", () => {
    const r = summarizeBoardInsights({
      boards: [board()],
      filters: [{ id: "100", ownerActive: true }],
      knownStatusIds: new Set(["1", "2"]),
    });
    expect(r).toMatchObject({ available: true, total: 1, flaggedCount: 0, joinedFilters: true, joinedStatuses: true });
  });

  test("a filterId with no matching filter is a deleted backing filter", () => {
    const r = summarizeBoardInsights({
      boards: [board({ filterId: "999" })],
      filters: [{ id: "100", ownerActive: true }],
    });
    expect(r.missingFilter).toBe(1);
    expect(r.flagged[0].issues).toContain("backing-filter-deleted");
  });

  test("an inactive backing-filter owner is flagged, not counted as deleted", () => {
    const r = summarizeBoardInsights({
      boards: [board()],
      filters: [{ id: "100", ownerActive: false }],
    });
    expect(r.missingFilter).toBe(0);
    expect(r.inactiveFilterOwner).toBe(1);
  });

  test("config readable but no filterId is 'no backing filter'", () => {
    const r = summarizeBoardInsights({ boards: [board({ filterId: null })], filters: [] });
    expect(r.noFilter).toBe(1);
  });

  test("a column mapping an unknown status is a stale mapping; an empty column is unmapped", () => {
    const r = summarizeBoardInsights({
      boards: [board({ columns: [{ statusIds: ["1", "gone"] }, { statusIds: [] }] })],
      knownStatusIds: new Set(["1", "2"]),
    });
    expect(r.staleColumnBoards).toBe(1);
    expect(r.unmappedColumnBoards).toBe(1);
    expect(r.flagged[0].issues).toEqual(expect.arrayContaining(["unmapped-column", "stale-column-status"]));
  });

  test("checks that could not run are reported, not assumed clean", () => {
    const r = summarizeBoardInsights({ boards: [board()] });
    expect(r.joinedFilters).toBe(false);
    expect(r.joinedStatuses).toBe(false);
    // With no filter snapshot, a real filterId is not treated as deleted.
    expect(r.missingFilter).toBe(0);
    expect(r.staleColumnBoards).toBe(0);
  });

  test("an unreadable-config board is not judged on filter or columns", () => {
    const r = summarizeBoardInsights({
      boards: [board({ configReadable: false, filterId: null, columns: [] })],
      filters: [],
      knownStatusIds: new Set(),
    });
    expect(r.flaggedCount).toBe(0);
  });
});

describe("unreadable boards", () => {
  // Team-managed boards often refuse their configuration. They were never checked, so they
  // must not count toward the denominator that makes a board estate look clean.
  test("counts readable and unreadable boards separately", () => {
    const r = summarizeBoardInsights({
      boards: [board(), board({ boardId: "2", configReadable: false, columns: [] }), board({ boardId: "3", configReadable: false, columns: [] })],
      filters: [{ id: "100", ownerActive: true }],
    });
    expect(r).toMatchObject({ total: 3, readable: 1, unreadable: 2 });
    expect(summarizeBoardHealth(r)).toMatchObject({ total: 3, readable: 1, unreadable: 2 });
  });
});

describe("summarizeBoardHealth", () => {
  test("unavailable when the pillar has nothing", () => {
    expect(summarizeBoardHealth({ available: false })).toEqual({ available: false });
  });

  test("rolls the broken-backing counts together", () => {
    const h = summarizeBoardHealth({ available: true, total: 10, missingFilter: 2, noFilter: 1, inactiveFilterOwner: 3, staleColumnBoards: 1, unmappedColumnBoards: 4 });
    expect(h).toMatchObject({ available: true, total: 10, brokenBackingCount: 3, inactiveFilterOwner: 3, staleColumnBoards: 1, unmappedColumnBoards: 4 });
  });
});
