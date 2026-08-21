import { describe, test, expect } from "vitest";
import { shapeFilter, isFilterBuildStale, FILTER_BUILD_STALE_MS } from "./filter-engine.js";

// The shapes this has to survive are all things a real tenant produces, and none of them are
// worth discovering in production: a missing owner, subscriptions arriving as an object on
// one payload and an array on another, sharePermissions absent entirely.

const raw = (over = {}) => ({
  id: 10001,
  name: "Open bugs",
  description: "Everything still open",
  jql: 'project = ADVEV AND status = "In Progress" AND "Story Points" >= 5',
  owner: { accountId: "a1", displayName: "Bob", active: true },
  sharePermissions: [],
  subscriptions: { size: 0, items: [] },
  favouritedCount: 3,
  approximateLastUsed: "2026-08-01T00:00:00.000Z",
  viewUrl: "https://example.atlassian.net/issues/?filter=10001",
  ...over,
});

describe("shapeFilter", () => {
  test("flattens a filter into its row, references and shares", () => {
    const shaped = shapeFilter(raw());

    expect(shaped.filter).toMatchObject({
      id: "10001", name: "Open bugs", ownerAccountId: "a1", ownerActive: true,
      subscriptionCount: 0, favouritedCount: 3, sharedWithEveryone: false, shareCount: 0,
      lastUsedAt: "2026-08-01T00:00:00.000Z",
    });
    // The dependency join: this is what stops a field forty filters search on being reported
    // as unused.
    expect(shaped.refs.filter((r) => r.kind === "field").map((r) => r.label))
      .toEqual(["project", "status", "Story Points"]);
    expect(shaped.refs.filter((r) => r.kind === "project").map((r) => r.label)).toEqual(["ADVEV"]);
    expect(shaped.refs.filter((r) => r.kind === "status").map((r) => r.label)).toEqual(["In Progress"]);
  });

  // Jira omits `owner` entirely once the account is deleted, and that is a different fact
  // from an account that exists and is switched off -- the first takes the filter with it.
  test("keeps owner state tri-valued", () => {
    expect(shapeFilter(raw()).filter.ownerActive).toBe(true);
    expect(shapeFilter(raw({ owner: { accountId: "a", displayName: "B", active: false } })).filter.ownerActive).toBe(false);
    expect(shapeFilter(raw({ owner: null })).filter.ownerActive).toBeNull();
  });

  test("reads subscriptions in either shape Jira sends", () => {
    expect(shapeFilter(raw({ subscriptions: { size: 4 } })).filter.subscriptionCount).toBe(4);
    expect(shapeFilter(raw({ subscriptions: [{}, {}] })).filter.subscriptionCount).toBe(2);
    expect(shapeFilter(raw({ subscriptions: undefined })).filter.subscriptionCount).toBe(0);
  });

  test("flags a filter shared with everyone", () => {
    const shaped = shapeFilter(raw({ sharePermissions: [{ type: "global" }] }));
    expect(shaped.filter.sharedWithEveryone).toBe(true);
    expect(shaped.shares).toHaveLength(1);
  });

  test("reads a share target from whichever key names it", () => {
    // Jira nests the target under a key named after the type, so this reads a union.
    const shaped = shapeFilter(raw({
      sharePermissions: [
        { type: "project", project: { id: "1", name: "ADVEV" } },
        { type: "group", group: { groupId: "g1", name: "jira-users" } },
      ],
    }));
    expect(shaped.shares.map((s) => s.targetName)).toEqual(["ADVEV", "jira-users"]);
  });

  // Null means "we could not tell", never "never opened". approximateLastUsed is the newest
  // field on this endpoint and the likeliest to be absent on a given tenant.
  test("leaves last-used null rather than inventing a date", () => {
    expect(shapeFilter(raw({ approximateLastUsed: undefined })).filter.lastUsedAt).toBeNull();
  });

  test("rejects a filter with no id rather than storing a blank key", () => {
    // One malformed entry must not cost the other 1,999.
    expect(shapeFilter({ name: "No id" })).toBeNull();
    expect(shapeFilter(null)).toBeNull();
  });

  test("survives a filter with no query", () => {
    const shaped = shapeFilter(raw({ jql: undefined }));
    expect(shaped.filter.jql).toBe("");
    expect(shaped.refs).toEqual([]);
  });
});

describe("isFilterBuildStale", () => {
  // A Forge invocation timeout is a hard kill: state is marked "building" before the first
  // API call and the catch that would mark it failed never runs. Without this the row stays
  // "building" forever and every future rebuild is suppressed.
  const now = Date.parse("2026-08-21T12:00:00Z");

  test("is not stale while a build could still be running", () => {
    expect(isFilterBuildStale({ state: "building", startedAt: new Date(now - 60_000).toISOString() }, now)).toBe(false);
  });

  test("is stale once no invocation could still be alive", () => {
    expect(isFilterBuildStale({ state: "building", startedAt: new Date(now - FILTER_BUILD_STALE_MS - 1000).toISOString() }, now)).toBe(true);
  });

  test("treats a building row with no start time as stale", () => {
    expect(isFilterBuildStale({ state: "building" }, now)).toBe(true);
  });

  test("says nothing about a row that is not building", () => {
    expect(isFilterBuildStale({ state: "ready" }, now)).toBe(false);
    expect(isFilterBuildStale(null, now)).toBe(false);
  });
});
