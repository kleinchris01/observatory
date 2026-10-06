import { describe, test, expect } from "vitest";
import {
  analyzeFilter,
  classifyOwner,
  findBrokenProjectRefs,
  findUnknownTypeRefs,
  findDuplicateFilters,
  isSharedWithEveryone,
  summarizeFilters,
  summarizeFilterHealth,
  STALE_FILTER_DAYS,
} from "./filter-insights.js";

// A saved filter is the one piece of Jira configuration that fails silently in both
// directions: delete a field forty filters search on and the searches quietly return the
// wrong answer, and leave a filter owned by somebody who left and it keeps emailing a list
// from an account nobody administers.

const NOW = Date.parse("2026-08-21T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

const filter = (over = {}) => ({
  id: "1",
  name: "A filter",
  jql: "project = X",
  owner: { accountId: "a1", displayName: "Bob", active: true },
  ownerName: "Bob",
  shares: [],
  subscriptionCount: 0,
  lastUsedAt: daysAgo(10),
  projectRefs: ["X"],
  ...over,
});

const codes = (f) => analyzeFilter(f, { now: NOW }).map((x) => x.code);

describe("classifyOwner", () => {
  test("tells a deactivated account from a deleted one", () => {
    // Jira omits `owner` entirely once the account is gone, and that is the worse case: the
    // filter goes with it.
    expect(classifyOwner(filter())).toBe("active");
    expect(classifyOwner(filter({ owner: { active: false } }))).toBe("inactive");
    expect(classifyOwner(filter({ owner: null }))).toBe("missing");
  });
});

describe("analyzeFilter", () => {
  test("flags a filter whose owner is gone", () => {
    expect(codes(filter({ owner: null }))).toContain("orphaned-owner");
    expect(codes(filter({ owner: { active: false } }))).toContain("orphaned-owner");
  });

  // An orphaned filter feeding subscriptions is worse than one nobody reads: the email keeps
  // arriving right up until the filter vanishes.
  test("raises the severity when an orphaned filter is also emailing people", () => {
    const quiet = analyzeFilter(filter({ owner: null }), { now: NOW });
    const loud = analyzeFilter(filter({ owner: null, subscriptionCount: 3 }), { now: NOW });
    expect(quiet[0].severity).toBe("medium");
    expect(loud[0].severity).toBe("high");
  });

  test("flags a filter shared with every logged-in user", () => {
    for (const type of ["authenticated", "loggedin"]) {
      expect(codes(filter({ shares: [{ type }] }))).toContain("shared-with-everyone");
    }
    expect(codes(filter({ shares: [{ type: "project", project: { id: "1" } }] })))
      .not.toContain("shared-with-everyone");
  });

  test("flags a globally shared filter as public, high, and only as public", () => {
    const found = codes(filter({ shares: [{ type: "global" }, { type: "loggedin" }] }));
    expect(found).toContain("shared-publicly");
    expect(found).not.toContain("shared-with-everyone");
  });

  test("flags a subscription on a filter nobody opens", () => {
    expect(codes(filter({ subscriptionCount: 2, lastUsedAt: daysAgo(500) })))
      .toContain("subscribed-but-unused");
    expect(codes(filter({ subscriptionCount: 2, lastUsedAt: null })))
      .toContain("subscribed-but-unused");
  });

  // Filters are seasonal -- a release-readiness filter is untouched for ten months and
  // indispensable in the eleventh -- so the bound is deliberately generous.
  test("does not call a filter stale inside the window", () => {
    expect(codes(filter({ lastUsedAt: daysAgo(STALE_FILTER_DAYS - 5) }))).not.toContain("stale");
    expect(codes(filter({ lastUsedAt: daysAgo(STALE_FILTER_DAYS + 5) }))).toContain("stale");
  });

  test("tells never-opened from opened-long-ago", () => {
    // On a filter that has existed for years, no recorded view at all is stronger evidence
    // than an old timestamp.
    expect(codes(filter({ lastUsedAt: null }))).toContain("never-used");
    expect(codes(filter({ lastUsedAt: daysAgo(500) }))).toContain("stale");
  });

  test("says nothing about a healthy filter", () => {
    expect(codes(filter())).toEqual([]);
  });

  // On a tenant where Jira never populates approximateLastUsed, every filter comes back
  // null -- and "we could not tell" is not "never opened" (CONNECT-4091).
  test("suppresses every last-used finding when the tenant does not track last-used", () => {
    const opts = { now: NOW, lastUsedTracked: false };
    expect(analyzeFilter(filter({ lastUsedAt: null }), opts).map((x) => x.code)).not.toContain("never-used");
    expect(analyzeFilter(filter({ lastUsedAt: null, subscriptionCount: 3 }), opts).map((x) => x.code)).not.toContain("subscribed-but-unused");
    expect(analyzeFilter(filter({ lastUsedAt: daysAgo(500) }), opts).map((x) => x.code)).not.toContain("stale");
    // Owner / share findings are unaffected -- those do not depend on last-used.
    expect(analyzeFilter(filter({ lastUsedAt: null, owner: null }), opts).map((x) => x.code)).toContain("orphaned-owner");
  });

  test("survives a filter shaped nothing like a filter", () => {
    expect(() => analyzeFilter(null, { now: NOW })).not.toThrow();
    expect(() => analyzeFilter({}, { now: NOW })).not.toThrow();
  });
});

describe("isSharedWithEveryone", () => {
  test("ignores an empty or missing share list", () => {
    expect(isSharedWithEveryone([])).toBe(false);
    expect(isSharedWithEveryone(undefined)).toBe(false);
  });
});

describe("findDuplicateFilters", () => {
  test("groups filters whose queries differ only in casing and spacing", () => {
    const groups = findDuplicateFilters([
      filter({ id: "1", name: "Mine", jql: "project = ADVEV AND status = Done" }),
      filter({ id: "2", name: "Yours", jql: 'project="ADVEV"  and  STATUS = done' }),
      filter({ id: "3", name: "Other", jql: "project = OTHER" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
    expect(groups[0].filters.map((f) => f.name)).toEqual(["Mine", "Yours"]);
  });

  test("leads with the biggest pile", () => {
    // The interesting case is six people maintaining one search six times, not two.
    const groups = findDuplicateFilters([
      ...["a", "b"].map((id) => filter({ id, jql: "project = TWO" })),
      ...["c", "d", "e"].map((id) => filter({ id, jql: "project = THREE" })),
    ]);
    expect(groups[0].count).toBe(3);
  });

  test("ignores filters with no query at all", () => {
    expect(findDuplicateFilters([filter({ id: "1", jql: "" }), filter({ id: "2", jql: "" })])).toEqual([]);
  });
});

describe("findBrokenProjectRefs", () => {
  const keys = new Set(["ADVEV", "OTHER"]);

  test("finds a filter naming a project that does not exist", () => {
    const broken = findBrokenProjectRefs([filter({ id: "9", name: "Ghost", projectRefs: ["GHOST"] })], keys);
    expect(broken).toEqual([{ id: "9", name: "Ghost", ownerName: "Bob", missing: ["GHOST"] }]);
  });

  test("matches a project key case-insensitively", () => {
    expect(findBrokenProjectRefs([filter({ projectRefs: ["advev"] })], keys)).toEqual([]);
  });

  // `project = 10001` is an id, this module has no id-to-key map, and guessing would invent
  // broken filters out of correct ones.
  test("does not judge a numeric project id", () => {
    expect(findBrokenProjectRefs([filter({ projectRefs: ["10001"] })], keys)).toEqual([]);
  });

  test("checks nothing rather than everything when the catalog is unknown", () => {
    // "No broken references" and "nobody looked" are different claims.
    expect(findBrokenProjectRefs([filter({ projectRefs: ["GHOST"] })], null)).toEqual([]);
    expect(findBrokenProjectRefs([filter({ projectRefs: ["GHOST"] })], new Set())).toEqual([]);
  });
});

describe("findUnknownTypeRefs", () => {
  const names = new Set(["bug", "story", "epic"]);

  test("finds a filter naming an issue type the site does not define", () => {
    const found = findUnknownTypeRefs([filter({ id: "9", name: "Ghost", typeRefs: ["Sub-bug"] })], names);
    expect(found).toEqual([{ id: "9", name: "Ghost", ownerName: "Bob", missing: ["Sub-bug"] }]);
  });

  test("matches a defined type case-insensitively and does not judge a numeric id", () => {
    expect(findUnknownTypeRefs([filter({ typeRefs: ["BUG", "10001"] })], names)).toEqual([]);
  });

  test("checks nothing when the type catalog is unknown", () => {
    expect(findUnknownTypeRefs([filter({ typeRefs: ["Nope"] })], null)).toEqual([]);
    expect(findUnknownTypeRefs([filter({ typeRefs: ["Nope"] })], new Set())).toEqual([]);
  });
});

describe("summarizeFilters", () => {
  const estate = [
    filter({ id: "1", name: "Fine" }),
    filter({ id: "2", name: "Orphan", owner: { active: false } }),
    filter({ id: "3", name: "Everyone", shares: [{ type: "loggedin" }] }),
    filter({ id: "4", name: "Zombie", subscriptionCount: 2, lastUsedAt: daysAgo(500) }),
    filter({ id: "5", name: "Broken", projectRefs: ["GHOST"] }),
  ];

  test("counts each finding separately", () => {
    const s = summarizeFilters(estate, { now: NOW, projectKeys: new Set(["X"]) });
    expect(s).toMatchObject({
      available: true, total: 5,
      orphanedCount: 1, sharedWithEveryoneCount: 1, sharedPubliclyCount: 0, subscribedButUnusedCount: 1, brokenProjectCount: 1,
    });
  });

  test("reports whether the project join was possible", () => {
    expect(summarizeFilters(estate, { now: NOW }).projectsChecked).toBe(false);
    expect(summarizeFilters(estate, { now: NOW, projectKeys: new Set(["X"]) }).projectsChecked).toBe(true);
  });

  test("returns only the flagged filters, worst first", () => {
    const s = summarizeFilters(estate, { now: NOW, projectKeys: new Set(["X"]) });
    expect(s.filters.map((f) => f.name)).not.toContain("Fine");
    expect(s.filters.length).toBeGreaterThan(0);
  });

  test("reports unavailable rather than clean on an empty estate", () => {
    expect(summarizeFilters([], { now: NOW })).toMatchObject({ available: false, total: 0 });
  });

  test("reports lastUsedTracked, and stops counting stale/never-used, when no filter carries a date", () => {
    const untracked = summarizeFilters(
      [filter({ id: "a", lastUsedAt: null }), filter({ id: "b", lastUsedAt: null, subscriptionCount: 2 })],
      { now: NOW }
    );
    expect(untracked.lastUsedTracked).toBe(false);
    expect(untracked.neverUsedCount).toBe(0);
    expect(untracked.staleCount).toBe(0);
    expect(untracked.subscribedButUnusedCount).toBe(0);

    const tracked = summarizeFilters(
      [filter({ id: "a", lastUsedAt: null }), filter({ id: "b", lastUsedAt: daysAgo(3) })],
      { now: NOW }
    );
    expect(tracked.lastUsedTracked).toBe(true);
    expect(tracked.neverUsedCount).toBe(1);
  });
});

describe("summarizeFilterHealth", () => {
  // projectRefs has to agree with the jql, or every filter reads as naming a project that
  // does not exist and the rate is pinned at its ceiling before any other finding lands.
  const build = (over) => summarizeFilterHealth(summarizeFilters(
    Array.from({ length: 100 }, (_, i) => filter({ id: String(i), jql: `project = P${i}`, projectRefs: [`P${i}`] }))
      .map((f, i) => ({ ...f, ...(over(i) || {}) })),
    { now: NOW, projectKeys: new Set(Array.from({ length: 100 }, (_, i) => `P${i}`)) }
  ));

  // computeSiteHealth scores four filter dimensions from these raw counts directly. What this
  // function owes it is the counts, not a pre-combined rate -- the old `defectRate` was a
  // leftover from the single-dimension era with no consumer.
  test("passes the four scored counts through, and the total", () => {
    const summary = build((i) => (i < 10 ? { owner: null } : null));
    expect(summary).toMatchObject({ available: true, total: 100, orphanedCount: 10 });
    expect(summary).not.toHaveProperty("defectRate");
  });

  // The filter-scope dimension needs to know whether the project catalog was available to
  // join against -- without this passthrough it was permanently unavailable and
  // brokenProjectCount never reached the score.
  test("carries projectsChecked so the scope dimension can be scored", () => {
    expect(build(() => null).projectsChecked).toBe(true);
    const noCatalog = summarizeFilterHealth(summarizeFilters(
      [filter({ id: "1", jql: "project = P1", projectRefs: ["P1"] })], { now: NOW }
    ));
    expect(noCatalog.projectsChecked).toBe(false);
  });

  // Duplicates are the most numerous filter finding and the least consequential, and are
  // deliberately absent from every filter score -- the reducible count lives on the tab.
  test("does not surface a duplicate figure among the scored counts", () => {
    const identical = summarizeFilters(
      Array.from({ length: 50 }, (_, i) => filter({ id: String(i), jql: "project = SAME" })),
      { now: NOW }
    );
    expect(identical.reducibleCount).toBe(49);
    const health = summarizeFilterHealth(identical);
    expect(health.orphanedCount).toBe(0);
    expect(health.brokenProjectCount).toBe(0);
  });

  test("reports unavailable when there is no estate to rate", () => {
    expect(summarizeFilterHealth(summarizeFilters([], { now: NOW }))).toEqual({ available: false });
  });
});
