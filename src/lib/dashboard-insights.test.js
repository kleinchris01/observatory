import { describe, test, expect } from "vitest";
import {
  analyzeDashboard,
  classifyOwner,
  isEditableByEveryone,
  isSharedWithEveryone,
  summarizeDashboards,
  summarizeDashboardHealth,
} from "./dashboard-insights.js";

// A dashboard is the most visible thing in Jira and the least owned. The failure modes worth
// pinning are the ones nobody notices: a wall screen with a deletion date nobody wrote down,
// and a shared grid anybody can rearrange for everybody.

const dashboard = (over = {}) => ({
  id: "1",
  name: "Delivery overview",
  owner: { accountId: "a1", displayName: "Bob", active: true },
  ownerName: "Bob",
  shares: [],
  editShares: [],
  popularity: 3,
  gadgetCount: 5,
  ...over,
});

const codes = (d) => analyzeDashboard(d).map((f) => f.code);

describe("classifyOwner", () => {
  test("tells a deactivated account from a deleted one", () => {
    expect(classifyOwner(dashboard())).toBe("active");
    expect(classifyOwner(dashboard({ owner: { active: false } }))).toBe("inactive");
    expect(classifyOwner(dashboard({ owner: null }))).toBe("missing");
  });
});

describe("share classification", () => {
  test("recognises every spelling Jira has used for everyone", () => {
    for (const type of ["global", "authenticated", "loggedin"]) {
      expect(isSharedWithEveryone([{ type }])).toBe(true);
      expect(isEditableByEveryone([{ type }])).toBe(true);
    }
  });

  test("a project or group share is not everyone", () => {
    expect(isSharedWithEveryone([{ type: "project", project: { id: "1" } }])).toBe(false);
    expect(isEditableByEveryone([{ type: "group", group: { name: "admins" } }])).toBe(false);
  });

  test("survives a missing permission list", () => {
    expect(isSharedWithEveryone(undefined)).toBe(false);
    expect(isEditableByEveryone(undefined)).toBe(false);
  });
});

describe("analyzeDashboard", () => {
  test("flags a dashboard whose owner is gone", () => {
    expect(codes(dashboard({ owner: null }))).toContain("orphaned-owner");
    expect(codes(dashboard({ owner: { active: false } }))).toContain("orphaned-owner");
  });

  // Blast radius, not owner state alone: a dashboard fifty people have favourited
  // disappearing is a different event from a private one doing so.
  test("raises the severity when a popular dashboard is the one that will vanish", () => {
    expect(analyzeDashboard(dashboard({ owner: null, popularity: 0 }))[0].severity).toBe("medium");
    expect(analyzeDashboard(dashboard({ owner: null, popularity: 12 }))[0].severity).toBe("high");
  });

  // Readable by everyone is usually intended. Editable by everyone is a shared document with
  // no owner in practice.
  test("separates who can view from who can rewrite", () => {
    expect(codes(dashboard({ shares: [{ type: "global" }] }))).not.toContain("editable-by-everyone");
    expect(codes(dashboard({ editShares: [{ type: "global" }] }))).toContain("editable-by-everyone");
  });

  test("only calls a dashboard published-and-unwanted when it is both", () => {
    expect(codes(dashboard({ shares: [{ type: "global" }], popularity: 0 }))).toContain("published-unused");
    // Shared with everyone and actually favourited is just a site-wide dashboard.
    expect(codes(dashboard({ shares: [{ type: "global" }], popularity: 9 }))).not.toContain("published-unused");
    // Unfavourited and private is nobody's business.
    expect(codes(dashboard({ popularity: 0 }))).not.toContain("published-unused");
  });

  test("flags an empty grid", () => {
    expect(codes(dashboard({ gadgetCount: 0 }))).toContain("empty");
  });

  // The distinction the nullable column exists for: a partial walk can say a dashboard HAS
  // gadgets and cannot say one has none.
  test("does not call a dashboard empty when its gadgets were never read", () => {
    expect(codes(dashboard({ gadgetCount: null }))).not.toContain("empty");
    expect(codes(dashboard({ gadgetCount: undefined }))).not.toContain("empty");
  });

  test("says nothing about a healthy dashboard", () => {
    expect(codes(dashboard())).toEqual([]);
  });

  test("survives a payload shaped nothing like a dashboard", () => {
    expect(() => analyzeDashboard(null)).not.toThrow();
    expect(() => analyzeDashboard({})).not.toThrow();
  });
});

describe("summarizeDashboards", () => {
  const estate = [
    dashboard({ id: "1", name: "Fine" }),
    // Popular as well as orphaned, which is what makes it high severity and therefore the
    // one a reader should meet first. An unfavourited orphan ties with an open edit list at
    // medium, and the tie breaks on name -- that is the design, not an accident.
    dashboard({ id: "2", name: "Orphan", owner: { active: false }, popularity: 12 }),
    dashboard({ id: "3", name: "Open edit", editShares: [{ type: "global" }] }),
    dashboard({ id: "4", name: "Published", shares: [{ type: "global" }], popularity: 0 }),
    dashboard({ id: "5", name: "Empty", gadgetCount: 0 }),
  ];

  test("counts each finding separately", () => {
    expect(summarizeDashboards(estate)).toMatchObject({
      available: true, total: 5,
      orphanedCount: 1, editableByEveryoneCount: 1, publishedUnusedCount: 1, emptyCount: 1,
    });
  });

  test("totals the gadgets it did see", () => {
    // 5 + 5 + 5 + 5 + 0
    expect(summarizeDashboards(estate).totalGadgets).toBe(20);
  });

  // A partial walk can say which of the dashboards it reached are empty and nothing about
  // the rest. Reporting a shortfall in the BUILD as a defect in the estate is the failure
  // this guards.
  test("suppresses the empty count entirely when the walk was partial", () => {
    const partial = summarizeDashboards([dashboard({ gadgetCount: null }), dashboard({ id: "9", gadgetCount: 0 })]);
    expect(partial.gadgetsKnown).toBe(false);
    expect(partial.emptyCount).toBeNull();
  });

  test("returns only the flagged dashboards, worst first", () => {
    const flagged = summarizeDashboards(estate).dashboards;
    expect(flagged.map((d) => d.name)).not.toContain("Fine");
    expect(flagged[0].name).toBe("Orphan");
  });

  test("reports unavailable rather than clean on an empty estate", () => {
    expect(summarizeDashboards([])).toMatchObject({ available: false, total: 0 });
  });
});

describe("summarizeDashboardHealth", () => {
  const build = (over) => summarizeDashboardHealth(summarizeDashboards(
    Array.from({ length: 100 }, (_, i) => dashboard({ id: String(i) })).map((d, i) => ({ ...d, ...(over(i) || {}) }))
  ));

  test("a clean estate rates zero", () => {
    expect(build(() => null).defectRate).toBe(0);
  });

  test("weights a vanishing dashboard above an editable one", () => {
    const orphans = build((i) => (i < 10 ? { owner: null } : null));
    const editable = build((i) => (i < 10 ? { editShares: [{ type: "global" }] } : null));
    expect(orphans.defectRate).toBeGreaterThan(editable.defectRate);
  });

  test("an empty grid counts least of the three", () => {
    const empty = build((i) => (i < 10 ? { gadgetCount: 0 } : null));
    const editable = build((i) => (i < 10 ? { editShares: [{ type: "global" }] } : null));
    expect(empty.defectRate).toBeLessThan(editable.defectRate);
  });

  // A partial walk contributes nothing to the rate rather than contributing zero, which
  // would quietly flatter the score.
  test("an unmeasured empty count does not move the rate", () => {
    const partial = summarizeDashboards([dashboard({ gadgetCount: null }), dashboard({ id: "2", owner: null, gadgetCount: null })]);
    const health = summarizeDashboardHealth(partial);
    expect(health.emptyCount).toBeNull();
    // Only the orphan contributes: 1 * 2 / (2 * 2).
    expect(health.defectRate).toBe(0.5);
  });

  test("reports unavailable when there is no estate to rate", () => {
    expect(summarizeDashboardHealth(summarizeDashboards([]))).toEqual({ available: false });
  });
});
