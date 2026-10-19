import { describe, test, expect } from "vitest";
import {
  normalizeStatusName,
  editDistanceWithin,
  findDuplicateStatusGroups,
  findOrphanedStatuses,
  computeSchemeCategoryBalance,
  isSpellingVariant,
  summarizeWorkflowInsights,
} from "./workflow-insights.js";

// Pure functions, no mocks. The fixtures below are drawn from the real ford-advev-sandbox
// status catalog (435 statuses), which is where every one of these patterns came from.

const status = (id, name, statusCategory = "In Progress") => ({ statusId: String(id), name, statusCategory });

describe("normalizeStatusName", () => {
  test("removes separators entirely so spacing variants collapse", () => {
    expect(normalizeStatusName("Back Log")).toBe("backlog");
    expect(normalizeStatusName("Backlog")).toBe("backlog");
    expect(normalizeStatusName("Sign-Off")).toBe("signoff");
    expect(normalizeStatusName("  SIGN OFF  ")).toBe("signoff");
  });

  test("survives empty and non-string input", () => {
    expect(normalizeStatusName(null)).toBe("");
    expect(normalizeStatusName("")).toBe("");
    expect(normalizeStatusName("---")).toBe("");
  });
});

describe("editDistanceWithin", () => {
  test("catches the single-character variants that matter", () => {
    expect(editDistanceWithin("cancelled", "canceled", 1)).toBe(1);
    expect(editDistanceWithin("analyse", "analyze", 1)).toBe(1);
  });

  test("rejects anything beyond the budget", () => {
    expect(editDistanceWithin("blocked", "blocker", 1)).toBe(1);
    expect(editDistanceWithin("backlog", "delivery", 1)).toBeGreaterThan(1);
    // Length gap alone is enough to bail before doing the work.
    expect(editDistanceWithin("done", "doneish", 1)).toBeGreaterThan(1);
  });

  test("is zero for identical input", () => {
    expect(editDistanceWithin("done", "done", 1)).toBe(0);
  });
});

describe("findDuplicateStatusGroups", () => {
  test("reports the same literal name used more than once as identical", () => {
    const groups = findDuplicateStatusGroups([
      status(1, "Discovery"),
      status(2, "Discovery"),
      status(3, "Discovery"),
      status(4, "Approved"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("identical");
    expect(groups[0].count).toBe(3);
  });

  test("groups spacing and punctuation variants", () => {
    const groups = findDuplicateStatusGroups([status(1, "Backlog"), status(2, "Back Log")]);

    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("spacing");
    expect(groups[0].statuses.map((s) => s.name).sort()).toEqual(["Back Log", "Backlog"]);
  });

  test("groups single-character spelling variants", () => {
    const groups = findDuplicateStatusGroups([status(1, "Cancelled"), status(2, "Canceled")]);

    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("spelling");
    expect(groups[0].count).toBe(2);
  });

  test("leaves genuinely distinct statuses alone", () => {
    expect(findDuplicateStatusGroups([status(1, "Backlog"), status(2, "In Review"), status(3, "Delivered")])).toEqual(
      [],
    );
  });

  test("orders the largest group first so the worst offender leads", () => {
    const groups = findDuplicateStatusGroups([
      status(1, "Delivery"),
      status(2, "Delivery"),
      status(3, "Discovery"),
      status(4, "Discovery"),
      status(5, "Discovery"),
    ]);

    expect(groups[0].count).toBe(3);
    expect(groups[1].count).toBe(2);
  });

  test("never places one status in two groups", () => {
    const groups = findDuplicateStatusGroups([status(1, "Backlog"), status(2, "Back Log"), status(3, "Backlogs")]);

    const ids = groups.flatMap((g) => g.statuses.map((s) => s.statusId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("ignores unnamed statuses rather than grouping them all together", () => {
    expect(
      findDuplicateStatusGroups([{ statusId: "1", name: "" }, { statusId: "2", name: null }, { statusId: "3" }]),
    ).toEqual([]);
  });
});

describe("findOrphanedStatuses", () => {
  const statuses = [status(1, "Used"), status(2, "Unused"), status(3, "Also Unused")];
  const pairs = [{ schemeId: "s1", statusId: "1" }];

  test("returns statuses no scheme references", () => {
    const orphans = findOrphanedStatuses(statuses, pairs);
    expect(orphans.map((o) => o.name).sort()).toEqual(["Also Unused", "Unused"]);
  });

  test("marks a zero-issue orphan as safe to remove", () => {
    const counts = new Map([
      ["2", 0],
      ["3", 412],
    ]);
    const orphans = findOrphanedStatuses(statuses, pairs, counts);

    const unused = orphans.find((o) => o.statusId === "2");
    const alsoUnused = orphans.find((o) => o.statusId === "3");
    expect(unused.safeToRemove).toBe(true);
    // Unreachable but historically populated -- a finding, not a cleanup.
    expect(alsoUnused.safeToRemove).toBe(false);
    expect(alsoUnused.issueCount).toBe(412);
  });

  test("never claims safety when the scan has not run", () => {
    const orphans = findOrphanedStatuses(statuses, pairs, null);
    expect(orphans.every((o) => o.issueCount === null)).toBe(true);
    expect(orphans.every((o) => o.safeToRemove === false)).toBe(true);
  });

  test("returns nothing when every status is referenced", () => {
    const allPairs = statuses.map((s) => ({ schemeId: "s1", statusId: s.statusId }));
    expect(findOrphanedStatuses(statuses, allPairs)).toEqual([]);
  });

  // A status no scheme reaches and no issue ever entered is STILL load-bearing if a rule
  // transitions into it -- deleting it breaks the rule silently. This lived in the
  // Workflows tab's JSX as `safeToRemove && !automationRuleCount`, so the model asserted
  // one thing and one call site quietly disagreed. The health score read the model.
  describe("automation references", () => {
    const counts = new Map([
      ["2", 0],
      ["3", 0],
    ]);

    test("a rule reference stops a status being safe to remove", () => {
      const orphans = findOrphanedStatuses(statuses, pairs, counts, {
        unused: { ruleCount: 2, enabledRuleCount: 1 },
      });

      const held = orphans.find((o) => o.name === "Unused");
      const dead = orphans.find((o) => o.name === "Also Unused");

      expect(held).toMatchObject({ automationRuleCount: 2, ruleOnly: true, safeToRemove: false });
      expect(dead).toMatchObject({ automationRuleCount: 0, ruleOnly: false, safeToRemove: true });
    });

    test("matches on the status name, case-insensitively", () => {
      const orphans = findOrphanedStatuses(statuses, pairs, counts, { "also unused": { ruleCount: 5 } });
      expect(orphans.find((o) => o.name === "Also Unused").automationRuleCount).toBe(5);
    });

    test("counts are null, not zero, when no analysis has been built", () => {
      const orphans = findOrphanedStatuses(statuses, pairs, counts, null);
      expect(orphans.every((o) => o.automationRuleCount === null)).toBe(true);
      expect(orphans.every((o) => o.ruleOnly === false)).toBe(true);
      // Degrades to what the claim used to mean; automationChecked tells a reader which.
      expect(orphans.every((o) => o.safeToRemove === true)).toBe(true);
    });

    test("a status present in the analysis with no rules reads as zero, not unknown", () => {
      const orphans = findOrphanedStatuses(statuses, pairs, counts, {});
      expect(orphans.every((o) => o.automationRuleCount === 0)).toBe(true);
    });
  });

  // The same shape as the automation block above, for a board column instead of a rule. A
  // status a board maps is load-bearing even at zero issues and zero rules -- deleting it
  // drops that column's cards off the board with no error anywhere.
  describe("board references", () => {
    const counts = new Map([
      ["2", 0],
      ["3", 0],
    ]);

    test("a board column mapping the status stops it being safe to remove", () => {
      const boardStatusIds = new Set(["2"]);
      const orphans = findOrphanedStatuses(statuses, pairs, counts, null, boardStatusIds);

      const held = orphans.find((o) => o.name === "Unused");
      const dead = orphans.find((o) => o.name === "Also Unused");

      expect(held).toMatchObject({ boardCount: 1, boardOnly: true, safeToRemove: false });
      expect(dead).toMatchObject({ boardCount: 0, boardOnly: false, safeToRemove: true });
    });

    test("board and rule references are independent -- either alone blocks safety", () => {
      const orphans = findOrphanedStatuses(statuses, pairs, counts, { unused: { ruleCount: 1 } }, new Set(["3"]));
      const ruleHeld = orphans.find((o) => o.name === "Unused");
      const boardHeld = orphans.find((o) => o.name === "Also Unused");

      expect(ruleHeld).toMatchObject({ ruleOnly: true, boardOnly: false, safeToRemove: false });
      expect(boardHeld).toMatchObject({ ruleOnly: false, boardOnly: true, safeToRemove: false });
    });

    test("boardOnly and boardCount are null, not false, when no board inventory exists", () => {
      const orphans = findOrphanedStatuses(statuses, pairs, counts, null, null);
      expect(orphans.every((o) => o.boardOnly === null)).toBe(true);
      expect(orphans.every((o) => o.boardCount === null)).toBe(true);
      // Degrades to what the claim used to mean without a board inventory.
      expect(orphans.every((o) => o.safeToRemove === true)).toBe(true);
    });
  });
});

describe("computeSchemeCategoryBalance", () => {
  const schemes = [{ id: "s1", name: "Alpha", projectCount: 4 }];

  test("counts statuses by category", () => {
    const statuses = [status(1, "Open", "To Do"), status(2, "Doing", "In Progress"), status(3, "Shipped", "Done")];
    const pairs = statuses.map((s) => ({ schemeId: "s1", statusId: s.statusId }));

    const [balance] = computeSchemeCategoryBalance(schemes, pairs, statuses);
    expect(balance).toMatchObject({ todo: 1, inProgress: 1, done: 1, total: 3, projectCount: 4 });
    expect(balance.flags).toEqual([]);
  });

  test("flags a scheme that cannot represent completion", () => {
    const statuses = [status(1, "Open", "To Do"), status(2, "Doing", "In Progress")];
    const pairs = statuses.map((s) => ({ schemeId: "s1", statusId: s.statusId }));

    const [balance] = computeSchemeCategoryBalance(schemes, pairs, statuses);
    expect(balance.flags.map((f) => f.code)).toContain("no-done");
  });

  test("flags an In Progress-heavy scheme", () => {
    const statuses = [
      ...Array.from({ length: 12 }, (_, i) => status(100 + i, `Step ${i}`, "In Progress")),
      status(1, "Shipped", "Done"),
    ];
    const pairs = statuses.map((s) => ({ schemeId: "s1", statusId: s.statusId }));

    const [balance] = computeSchemeCategoryBalance(schemes, pairs, statuses);
    expect(balance.flags.map((f) => f.code)).toContain("in-progress-heavy");
  });

  test("flags uncategorised statuses, which break Jira roll-up reporting", () => {
    const statuses = [status(1, "Limbo", null), status(2, "Shipped", "Done")];
    const pairs = statuses.map((s) => ({ schemeId: "s1", statusId: s.statusId }));

    const [balance] = computeSchemeCategoryBalance(schemes, pairs, statuses);
    expect(balance.uncategorised).toBe(1);
    expect(balance.flags.map((f) => f.code)).toContain("uncategorised");
  });

  test("does not flag a small healthy scheme", () => {
    const statuses = [
      status(1, "Open", "To Do"),
      status(2, "Doing", "In Progress"),
      status(3, "Review", "In Progress"),
      status(4, "Shipped", "Done"),
    ];
    const pairs = statuses.map((s) => ({ schemeId: "s1", statusId: s.statusId }));

    expect(computeSchemeCategoryBalance(schemes, pairs, statuses)[0].flags).toEqual([]);
  });

  test("puts flagged schemes ahead of clean ones", () => {
    const many = [
      { id: "clean", name: "Clean", projectCount: 1 },
      { id: "broken", name: "Broken", projectCount: 1 },
    ];
    const statuses = [status(1, "Open", "To Do"), status(2, "Shipped", "Done")];
    const pairs = [
      { schemeId: "clean", statusId: "1" },
      { schemeId: "clean", statusId: "2" },
      { schemeId: "broken", statusId: "1" },
    ];

    const result = computeSchemeCategoryBalance(many, pairs, statuses);
    expect(result[0].schemeId).toBe("broken");
  });

  test("reports a scheme with no statuses as empty rather than crashing", () => {
    const [balance] = computeSchemeCategoryBalance(schemes, [], []);
    expect(balance.total).toBe(0);
    // An empty scheme has no Done status, but flagging that says nothing useful.
    expect(balance.flags).toEqual([]);
  });
});

describe("summarizeWorkflowInsights", () => {
  test("counts what consolidation would actually save", () => {
    const summary = summarizeWorkflowInsights({
      duplicateGroups: [
        { count: 3, statuses: [] },
        { count: 2, statuses: [] },
      ],
      orphans: [
        { safeToRemove: true, ruleOnly: false, automationRuleCount: 0 },
        { safeToRemove: false, ruleOnly: true, automationRuleCount: 4 },
      ],
      balance: [{ flags: [{ code: "no-done" }] }, { flags: [] }],
    });

    expect(summary.duplicateGroupCount).toBe(2);
    expect(summary.duplicateStatusCount).toBe(5);
    // Collapsing 3->1 and 2->1 removes 3 statuses, not 5.
    expect(summary.reducibleStatusCount).toBe(3);
    expect(summary.orphanCount).toBe(2);
    expect(summary.safeToRemoveCount).toBe(1);
    // The two halves of the orphan count, which status reachability and status coverage
    // are scored on separately.
    expect(summary.ruleOnlyStatusCount).toBe(1);
    expect(summary.unreachableNoRuleCount).toBe(1);
    expect(summary.automationChecked).toBe(true);
    // No fixture row sets boardOnly at all here -- summarizeWorkflowInsights must read that
    // as "not checked", not as `undefined !== null` reading true.
    expect(summary.boardOnlyStatusCount).toBe(0);
    expect(summary.boardChecked).toBe(false);
    expect(summary.flaggedSchemeCount).toBe(1);
    expect(summary.noDoneSchemeCount).toBe(1);
    // The lone orphan with no rule (orphans[0]) carries no issueCount in this fixture, so it
    // is cleanup, not something stuck -- see the dedicated test below for the case where it is.
    expect(summary.unreachableWithIssuesCount).toBe(0);
  });

  // The subset of "unreachable, no rule" that is not simply cleanup: it is also holding live
  // issues, which nothing in the workflow admin -- no scheme, no rule -- can move anywhere.
  test("counts unreachable statuses that are also holding live issues, separately from safe-to-remove ones", () => {
    const summary = summarizeWorkflowInsights({
      orphans: [
        { safeToRemove: true, ruleOnly: false, issueCount: 0, automationRuleCount: 0 },
        { safeToRemove: false, ruleOnly: false, issueCount: 40, automationRuleCount: 0 },
        { safeToRemove: false, ruleOnly: true, issueCount: 12, automationRuleCount: 3 },
      ],
    });

    expect(summary.unreachableNoRuleCount).toBe(2);
    // Only the middle one: unreachable, no rule, AND carrying issues. The first is safe to
    // remove precisely because it has none; the third is excluded by ruleOnly.
    expect(summary.unreachableWithIssuesCount).toBe(1);
  });

  test("reports automationChecked false when no orphan carries a rule answer", () => {
    const summary = summarizeWorkflowInsights({
      orphans: [{ safeToRemove: true, ruleOnly: false, automationRuleCount: null }],
    });
    expect(summary.automationChecked).toBe(false);
    expect(summary.ruleOnlyStatusCount).toBe(0);
  });

  test("reports boardChecked and boardOnlyStatusCount from real orphan rows", () => {
    const summary = summarizeWorkflowInsights({
      orphans: [
        { safeToRemove: false, ruleOnly: false, boardOnly: true, automationRuleCount: null },
        { safeToRemove: true, ruleOnly: false, boardOnly: false, automationRuleCount: null },
      ],
    });
    expect(summary.boardChecked).toBe(true);
    expect(summary.boardOnlyStatusCount).toBe(1);
  });

  test("reports boardChecked false when no orphan carries a board answer", () => {
    const summary = summarizeWorkflowInsights({
      orphans: [{ safeToRemove: true, ruleOnly: false, boardOnly: null, automationRuleCount: null }],
    });
    expect(summary.boardChecked).toBe(false);
    expect(summary.boardOnlyStatusCount).toBe(0);
  });

  test("is all zeroes for a clean site", () => {
    expect(summarizeWorkflowInsights({})).toMatchObject({
      duplicateGroupCount: 0,
      reducibleStatusCount: 0,
      orphanCount: 0,
      flaggedSchemeCount: 0,
      unreachableWithIssuesCount: 0,
      noDoneSchemeCount: 0,
    });
  });
});

// Precision guards. These came from the real 435-status catalog, where the first cut of
// the spelling heuristic flagged deliberate series as duplicates -- the fastest way to
// get a governance report dismissed wholesale.
describe("isSpellingVariant — false positives", () => {
  test("rejects enumerated series that differ only by a digit", () => {
    expect(isSpellingVariant("cp3signoffcomplete", "cp4signoffcomplete")).toBe(false);
    expect(isSpellingVariant("phase1review", "phase2review")).toBe(false);
  });

  test("rejects short codes where one character carries the meaning", () => {
    // Customer hold vs user hold -- distinct statuses, one character apart.
    expect(isSpellingVariant("chold", "uhold")).toBe(false);
  });

  test("still accepts genuine spelling variants", () => {
    expect(isSpellingVariant("cancelled", "canceled")).toBe(true);
    expect(isSpellingVariant("completed", "complete")).toBe(true);
  });

  test("groups the real catalog's variants without merging its series", () => {
    const groups = findDuplicateStatusGroups([
      status(1, "CP3 Sign Off Complete"),
      status(2, "CP4 Sign Off Complete"),
      status(3, "CP5 Sign Off Complete"),
      status(4, "CHOLD"),
      status(5, "UHOLD"),
      status(6, "Cancelled"),
      status(7, "Canceled"),
    ]);

    const names = groups.flatMap((g) => g.statuses.map((s) => s.name));
    expect(names).toEqual(expect.arrayContaining(["Cancelled", "Canceled"]));
    expect(names).not.toContain("CP3 Sign Off Complete");
    expect(names).not.toContain("CHOLD");
  });
});
