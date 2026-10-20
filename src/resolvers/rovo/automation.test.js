import { describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks } from "../test-harness.js";
import { rovoSearchAutomationRules, rovoInspectAutomationRule, rovoAutomationUsage } from "../../resolvers.js";

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

describe("Rovo automation agent actions", () => {
  const directory = {
    schemaVersion: 1,
    total: 3,
    rules: [
      [10, "Copy fields to subtasks", 1, "jira.issue.field.changed", 2],
      // Shares the word "approval" with rule 12 so the enabled-first ordering is actually
      // exercised rather than being the only match.
      [11, "Old approval cleanup", 0, "jira.jql.scheduled", 0],
      [12, "Send to approval", 1, "jira.issue.event.trigger:created", 1],
    ],
  };
  const fields = {
    schemaVersion: 1,
    total: 1,
    entries: [
      {
        label: "Story Points",
        writeCount: 1,
        readCount: 1,
        triggerCount: 0,
        ruleCount: 2,
        enabledRules: 1,
        disabledRules: 1,
        write: [10],
        read: [11],
        trigger: [],
      },
    ],
  };
  const statuses = { schemaVersion: 1, total: 0, entries: [] };
  const findings = {
    schemaVersion: 1,
    total: 1,
    findings: [{ id: 12, n: "Send to approval", s: "high", r: [{ c: "embedded-credential", s: "high" }] }],
  };

  // Relative to now, not a fixed epoch. These actions now gate their answers on how old the
  // analysis is, so a hardcoded 2025 timestamp would make every one of them report "unknown"
  // and the tests below would be exercising the degraded path while claiming to test the
  // normal one. Stale and truncated are asserted deliberately, further down.
  const FRESH = () => Date.now() - 2 * 86400000;

  function stubAll({ analysis = { schemaVersion: 1, refreshedAt: FRESH() }, parts = {} } = {}) {
    mocks.readAutomationAnalysis.mockResolvedValue(analysis);
    const table = { fields, statuses, directory, findings, ...parts };
    mocks.readAutomationPart.mockImplementation((_k, part) => Promise.resolve(table[part] ?? null));
  }

  describe("rovoSearchAutomationRules", () => {
    test("matches rules by name and reports their state and findings", async () => {
      stubAll();
      const result = await rovoSearchAutomationRules({ query: "approval" }, {});

      expect(result.status).toBe("ok");
      expect(result.matches[0]).toMatchObject({ ruleId: 12, name: "Send to approval", state: "ENABLED" });
      expect(result.matches[0].findings).toContain("embedded-credential");
    });

    test("lists enabled rules first, since a disabled rule explains nothing happening now", async () => {
      stubAll();
      const result = await rovoSearchAutomationRules({ query: "approval" }, {});

      expect(result.matches).toHaveLength(2);
      expect(result.matches.map((m) => m.state)).toEqual(["ENABLED", "DISABLED"]);
    });

    test("filters by state when asked", async () => {
      stubAll();
      const result = await rovoSearchAutomationRules({ query: "", state: "disabled" }, {});
      expect(result.status).toBe("error");

      const disabled = await rovoSearchAutomationRules({ query: "cleanup", state: "disabled" }, {});
      expect(disabled.matches.map((m) => m.ruleId)).toEqual([11]);
    });

    // The agent must never answer "no rules" from an absent analysis.
    test("reports analysis-unavailable rather than an empty match list", async () => {
      mocks.readAutomationAnalysis.mockResolvedValue(null);
      mocks.readAutomationPart.mockResolvedValue(null);

      const result = await rovoSearchAutomationRules({ query: "anything" }, {});

      expect(result.status).toBe("analysis-unavailable");
      expect(result.matches).toBeUndefined();
    });

    test("carries the analysis age so the agent can caveat a stale answer", async () => {
      const refreshedAt = Date.now() - 5 * 86400000;
      stubAll({ analysis: { schemaVersion: 1, refreshedAt } });
      const result = await rovoSearchAutomationRules({ query: "approval" }, {});
      expect(result.analysisRefreshedAt).toBe(refreshedAt);
      // Not just the stamp: the age, worked out and ready to state.
      expect(result.evidence.ageDays).toBe(5);
    });
  });

  describe("rovoInspectAutomationRule", () => {
    test("resolves a rule by numeric id", async () => {
      stubAll();
      const result = await rovoInspectAutomationRule({ ruleIdentifier: "12" }, {});
      expect(result.rule).toMatchObject({ ruleId: 12, name: "Send to approval", state: "ENABLED" });
    });

    test("resolves a rule by partial name", async () => {
      stubAll();
      const result = await rovoInspectAutomationRule({ ruleIdentifier: "subtasks" }, {});
      expect(result.rule.ruleId).toBe(10);
    });

    test("lists the fields the rule touches and in which direction", async () => {
      stubAll();
      const result = await rovoInspectAutomationRule({ ruleIdentifier: "10" }, {});
      expect(result.fieldsTouched).toContainEqual({ field: "Story Points", direction: "write" });
    });

    test("turns a risk code into a sentence the agent can say out loud", async () => {
      stubAll();
      const result = await rovoInspectAutomationRule({ ruleIdentifier: "12" }, {});
      expect(result.findings[0].summary).toMatch(/anyone who can view the rule can read/i);
    });

    test("states the index cap as a caveat rather than implying the list is complete", async () => {
      stubAll();
      const result = await rovoInspectAutomationRule({ ruleIdentifier: "12" }, {});
      expect(result.caveat).toMatch(/capped index/i);
    });

    test("reports not-found for an unknown rule", async () => {
      stubAll();
      const result = await rovoInspectAutomationRule({ ruleIdentifier: "nonexistent" }, {});
      expect(result.status).toBe("not-found");
    });
  });

  describe("rovoAutomationUsage", () => {
    test("answers the deletion question directly", async () => {
      stubAll();
      const result = await rovoAutomationUsage({ name: "Story Points" }, {});

      expect(result.status).toBe("ok");
      expect(result.safeToDelete).toBe(false);
      expect(result.guidance).toMatch(/would break 1 rule/i);
      expect(result.writtenBy.rules[0]).toMatchObject({ name: "Copy fields to subtasks", state: "ENABLED" });
    });

    test("splits enabled from disabled, since only one of them runs today", async () => {
      stubAll();
      const result = await rovoAutomationUsage({ name: "Story Points" }, {});
      expect(result).toMatchObject({ enabledRules: 1, disabledRules: 1, ruleCount: 2 });
    });

    test("says a field is unreferenced only when an analysis exists", async () => {
      stubAll();
      const result = await rovoAutomationUsage({ name: "Never Used" }, {});
      expect(result).toMatchObject({ status: "not-referenced", safeToDelete: true });
    });

    test("refuses to answer at all when no analysis has been built", async () => {
      mocks.readAutomationAnalysis.mockResolvedValue(null);
      mocks.readAutomationPart.mockResolvedValue(null);

      const result = await rovoAutomationUsage({ name: "Story Points" }, {});

      expect(result.status).toBe("analysis-unavailable");
      expect(result.safeToDelete).toBeUndefined();
    });

    test("looks in the status index when asked about a status", async () => {
      stubAll();
      const result = await rovoAutomationUsage({ name: "Done", kind: "status" }, {});
      expect(result.status).toBe("not-referenced");
      // A status is never "safe to delete" on automation evidence alone.
      expect(result.safeToDelete).toBe(false);
    });

    // The defect this action shipped with: absence from the index was reported as proof of
    // non-reference, whatever the state of the index it was absent from.
    describe("will not assert safe-to-delete it cannot support", () => {
      test("degrades to unknown when the index was truncated", async () => {
        // total far above entries.length: rows were dropped, and the dropped rows are the
        // LEAST-referenced ones -- which is the population this question is asked about.
        stubAll({ parts: { fields: { ...fields, total: 1400 } } });

        const result = await rovoAutomationUsage({ name: "Never Indexed" }, {});

        expect(result.status).toBe("unknown");
        // Not false -- false would claim rules DO reference it. Null is the third state.
        expect(result.safeToDelete).toBeNull();
        expect(result.evidence.blockers.map((b) => b.code)).toContain("index-truncated");
        expect(result.guidance).toMatch(/truncated/i);
      });

      test("degrades to unknown when the analysis is older than the threshold", async () => {
        mocks.readAdminConfig?.mockResolvedValue?.({ automationStaleAfterDays: 7 });
        stubAll({ analysis: { schemaVersion: 1, refreshedAt: Date.now() - 30 * 86400000 } });

        const result = await rovoAutomationUsage({ name: "Never Used" }, {});

        expect(result.status).toBe("unknown");
        expect(result.safeToDelete).toBeNull();
        expect(result.evidence.blockers.map((b) => b.code)).toContain("analysis-stale");
        expect(result.guidance).toMatch(/re-import/i);
      });

      test("still says no when a rule DOES reference it, however old the analysis", async () => {
        // Positive evidence survives staleness. A rule that wrote this field a month ago
        // almost certainly still does, and "no" is the cautious answer either way.
        stubAll({ analysis: { schemaVersion: 1, refreshedAt: Date.now() - 90 * 86400000 } });

        const result = await rovoAutomationUsage({ name: "Story Points" }, {});

        expect(result.status).toBe("ok");
        expect(result.safeToDelete).toBe(false);
      });

      test("carries the age on every answer so the agent can state it", async () => {
        const refreshedAt = Date.now() - 3 * 86400000;
        stubAll({ analysis: { schemaVersion: 1, refreshedAt } });

        const [usage, inspect, search] = await Promise.all([
          rovoAutomationUsage({ name: "Story Points" }, {}),
          rovoInspectAutomationRule({ ruleIdentifier: "10" }, {}),
          rovoSearchAutomationRules({ query: "approval" }, {}),
        ]);

        for (const result of [usage, inspect, search]) {
          expect(result.evidence).toMatchObject({ ageDays: 3, stale: false });
        }
      });

      test("a rule search is not accused of truncation it cannot have", async () => {
        // A directory search consults no capped index, so only the age applies to it.
        stubAll({ parts: { fields: { ...fields, total: 1400 } } });

        const result = await rovoSearchAutomationRules({ query: "approval" }, {});

        expect(result.status).toBe("ok");
        expect(result.evidence.blockers).toEqual([]);
        expect(result.evidence.indexComplete).toBeNull();
      });
    });
  });
});
