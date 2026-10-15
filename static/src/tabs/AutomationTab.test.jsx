import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke, router } from "@forge/bridge";
import {
  AutomationTab,
  DIRECTIONS,
  analyzeExportFile,
  crossRuleHint,
  crossRuleValue,
  filterFindings,
  findingDetailLine,
  persistAnalysis,
  riskDetail,
  sortEntries,
  triggerLabel,
} from "./AutomationTab";

function exportFile(payload, name = "automation-rules-202608060201.json") {
  return new File([JSON.stringify(payload)], name, { type: "application/json" });
}

const RULE = {
  id: 1,
  name: "Set due date",
  state: "ENABLED",
  canOtherRuleTrigger: false,
  updated: 1,
  trigger: {
    id: "t",
    component: "TRIGGER",
    type: "jira.issue.field.changed",
    value: { fields: [{ type: "fieldName", value: "Actual SEOBD" }] },
    children: [],
    conditions: [],
  },
  components: [
    {
      id: "a",
      component: "ACTION",
      type: "jira.issue.edit",
      children: [],
      conditions: [],
      value: {
        operations: [{ field: { type: "NAME", value: "Post sourcing cost review" }, type: "SET", value: "{{now}}" }],
      },
    },
  ],
  projects: [{ projectId: "10518" }],
};

function analysis(overrides = {}) {
  return {
    available: true,
    refreshedAt: Date.now() - 3600_000,
    source: "export-file",
    estate: {
      ruleCount: 1477,
      enabledCount: 874,
      disabledCount: 603,
      fieldsReferenced: 735,
      statusesReferenced: 324,
      triggerBreakdown: [
        { type: "jira.issue.field.changed", count: 401 },
        { type: "jira.jql.scheduled", count: 231 },
      ],
    },
    findings: [
      {
        id: 1,
        name: "Alexandria - Send to Approval",
        state: "ENABLED",
        enabled: true,
        triggerType: "jira.issue.field.changed",
        projectCount: 2,
        topSeverity: "high",
        risks: [{ code: "embedded-credential", severity: "high", detail: "Credential in plaintext." }],
      },
      {
        id: 2,
        name: "Old cleanup rule",
        state: "DISABLED",
        enabled: false,
        triggerType: "jira.jql.scheduled",
        projectCount: 0,
        topSeverity: "info",
        risks: [{ code: "disabled", severity: "info", detail: "Disabled 200 days ago." }],
      },
    ],
    findingsTotal: 2,
    cascades: [
      {
        sourceId: 1,
        targetId: 2,
        sourceName: "Writer",
        targetName: "Listener",
        field: "Actual SEOBD",
        selfTriggering: false,
      },
      {
        sourceId: 7,
        targetId: 7,
        sourceName: "Loopy rule",
        targetName: "Loopy rule",
        field: "Loopy",
        selfTriggering: true,
      },
    ],
    cascadesTotal: 2,
    selfTriggeringTotal: 1,
    blast: {
      available: true,
      total: 1477,
      byTier: { estate: 12, "cross-project": 40, project: 300, contained: 1125 },
      estateWideCount: 12,
      estateWideShare: 12 / 1477,
      estateWideCredentialCount: 3,
      estimatedCount: 1477,
      top: [],
    },
    ...overrides,
  };
}

const FIELD_INDEX = {
  available: true,
  part: "fields",
  total: 735,
  entries: [
    {
      label: "ADVEV Vehicle Program",
      writeCount: 65,
      readCount: 66,
      triggerCount: 17,
      write: [10, 11],
      read: [12],
      trigger: [13],
    },
    { label: "Story Points", writeCount: 3, readCount: 1, triggerCount: 0, write: [10], read: [12], trigger: [] },
  ],
};

const DIRECTORY = {
  available: true,
  part: "directory",
  total: 4,
  rules: [
    [10, "Populate program", 1, "jira.issue.field.changed", 2],
    [11, "Copy to subtasks", 0, "jira.manual.trigger.issue", 1],
    [12, "Check program set", 1, "jira.jql.scheduled", 0],
    [13, "React to program", 1, "jira.issue.field.changed", 3],
  ],
};

// invoke() is called with different resolver names; route by name rather than by call order,
// which the lazy section loading makes unstable.
function routeInvoke(map) {
  invoke.mockImplementation((name, payload) => {
    const key = name === "getAutomationIndex" ? `getAutomationIndex:${payload.part}` : name;
    if (!(key in map)) return Promise.reject(new Error(`unexpected invoke: ${key}`));
    const value = map[key];
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  });
}

beforeEach(() => {
  invoke.mockReset();
});

// An analysis imported before the cross-rule checks were stored was never measured for
// them; a zero would claim it was checked and found clean.
describe("crossRuleValue / crossRuleHint", () => {
  it("shows the count when the check was measured, including a real zero", () => {
    expect(crossRuleValue(12)).toBe("12");
    expect(crossRuleValue(0)).toBe("0");
    expect(crossRuleHint(0, "the hint")).toBe("the hint");
  });

  it("says not measured, and how to measure it, when the total is absent", () => {
    expect(crossRuleValue(null)).toBe("Not measured");
    expect(crossRuleValue(undefined)).toBe("Not measured");
    expect(crossRuleHint(null, "the hint")).toMatch(/re-import/i);
  });
});

describe("triggerLabel", () => {
  it("maps known trigger ids to readable names", () => {
    expect(triggerLabel("jira.issue.field.changed")).toBe("Field changed");
    expect(triggerLabel("jira.jql.scheduled")).toBe("Scheduled (JQL)");
  });

  it("degrades an unknown id rather than showing the raw namespace", () => {
    expect(triggerLabel("jira.something.new")).toBe("something new");
  });

  it("names the absence of a trigger", () => {
    expect(triggerLabel(null)).toBe("No trigger");
  });
});

describe("findingDetailLine", () => {
  it("reads as one sentence rather than a run of fragments", () => {
    expect(findingDetailLine({ triggerType: "jira.issue.field.changed", projectCount: 2, enabled: true })).toBe(
      "Field changed · 2 projects",
    );
  });

  it("singularizes a one-project scope", () => {
    expect(findingDetailLine({ triggerType: null, projectCount: 1, enabled: true })).toBe("No trigger · 1 project");
  });

  it("names a site-wide rule rather than showing zero projects", () => {
    expect(findingDetailLine({ triggerType: null, projectCount: 0, enabled: true })).toBe("No trigger · site-wide");
  });

  it("appends the disabled state", () => {
    expect(findingDetailLine({ triggerType: null, projectCount: 0, enabled: false })).toBe(
      "No trigger · site-wide · disabled",
    );
  });
});

describe("sortEntries", () => {
  // Beta totals 11 references, Alpha 10 -- but Alpha has the most writes and Beta the most
  // reads, so each sort key produces a visibly different order.
  const entries = [
    { label: "Beta", writeCount: 1, readCount: 10, triggerCount: 0 },
    { label: "Alpha", writeCount: 9, readCount: 0, triggerCount: 1 },
  ];

  it("sorts by total references by default", () => {
    expect(sortEntries(entries, "total").map((e) => e.label)).toEqual(["Beta", "Alpha"]);
  });

  it("sorts by a single direction when asked", () => {
    expect(sortEntries(entries, "read").map((e) => e.label)).toEqual(["Beta", "Alpha"]);
    expect(sortEntries(entries, "write").map((e) => e.label)).toEqual(["Alpha", "Beta"]);
  });

  it("sorts alphabetically", () => {
    expect(sortEntries(entries, "label").map((e) => e.label)).toEqual(["Alpha", "Beta"]);
  });

  it("does not mutate the input", () => {
    const original = [...entries];
    sortEntries(entries, "label");
    expect(entries).toEqual(original);
  });
});

describe("riskDetail", () => {
  // The sentences were stored 675 times, most of them identical. Rebuilding them from the
  // code is what let the whole findings list fit under one key.
  it("rebuilds the sentence for each risk code", () => {
    expect(riskDetail({ code: "embedded-credential" })).toMatch(/credential stored in plaintext/i);
    expect(riskDetail({ code: "no-actions" })).toMatch(/no actions/i);
  });

  it("uses the stored parameters where they vary", () => {
    expect(
      riskDetail({ code: "external-http", hosts: ["graph.microsoft.com", "login.microsoftonline.com"] }),
    ).toContain("graph.microsoft.com, login.microsoftonline.com");
    expect(riskDetail({ code: "disabled", ageDays: 90 })).toContain("90 days ago");
  });

  it("degrades rather than showing a blank when a parameter is missing", () => {
    expect(riskDetail({ code: "disabled" })).toBe("Rule is disabled.");
    expect(riskDetail({ code: "external-http" })).toMatch(/outside Atlassian\.$/);
  });

  it("falls back to the code for an unrecognized risk", () => {
    expect(riskDetail({ code: "brand-new-risk" })).toBe("brand-new-risk");
  });
});

describe("filterFindings", () => {
  const rows = [
    {
      id: 1,
      name: "Alpha",
      enabled: true,
      triggerType: "t1",
      topSeverity: "high",
      writesFields: ["Story Points"],
      risks: [{ code: "embedded-credential" }],
    },
    {
      id: 2,
      name: "Beta",
      enabled: false,
      triggerType: "t2",
      topSeverity: "info",
      writesFields: [],
      risks: [{ code: "disabled" }],
    },
  ];

  it("returns everything when no filter is set", () => {
    expect(filterFindings(rows)).toHaveLength(2);
  });

  it("filters by severity, risk code, state and trigger", () => {
    expect(filterFindings(rows, { severity: "high" }).map((r) => r.id)).toEqual([1]);
    expect(filterFindings(rows, { risk: "disabled" }).map((r) => r.id)).toEqual([2]);
    expect(filterFindings(rows, { state: "disabled" }).map((r) => r.id)).toEqual([2]);
    expect(filterFindings(rows, { trigger: "t2" }).map((r) => r.id)).toEqual([2]);
  });

  it("searches rule names and written field names together", () => {
    expect(filterFindings(rows, { search: "alpha" }).map((r) => r.id)).toEqual([1]);
    expect(filterFindings(rows, { search: "story points" }).map((r) => r.id)).toEqual([1]);
  });

  it("applies every active filter, not just the last one", () => {
    expect(filterFindings(rows, { severity: "high", state: "disabled" })).toEqual([]);
  });
});

// groupCascades was deleted rather than moved.
//
// It collapsed many edges between one rule pair into a single row, which is the right shape
// -- but it did it in the browser over whatever survived MAX_STORED_CASCADES. That is only
// correct while the stored list IS the whole set. Grouping a PAGE of 1,457 edges splits one
// relationship across a page boundary and renders it twice, so the GROUP BY moved into
// loadCascades and is tested in src/lib/store/automation.test.js.

describe("analyzeExportFile", () => {
  it("derives every document from a real export shape", async () => {
    const docs = await analyzeExportFile(exportFile({ cloud: true, rules: [RULE] }));
    expect(Object.keys(docs).sort()).toEqual([
      "analysis",
      "blast",
      "cascades",
      "directory",
      "fields",
      "findings",
      "issueTypes",
      "statuses",
      "users",
    ]);
    expect(docs.analysis.estate).toMatchObject({ ruleCount: 1, enabledCount: 1 });
    expect(docs.fields.entries.map((e) => e.label).sort()).toEqual(["Actual SEOBD", "Post sourcing cost review"]);
  });

  it("rejects a file that is not JSON, naming the fix", async () => {
    const bad = new File(["<html>not json</html>"], "wrong.json", { type: "application/json" });
    await expect(analyzeExportFile(bad)).rejects.toThrow(/not valid JSON.*Export the rules again/s);
  });

  it("rejects valid JSON that is not a rule export", async () => {
    await expect(analyzeExportFile(exportFile({ something: "else" }))).rejects.toThrow(/no rules in it/);
  });

  it("rejects an empty rule list rather than storing an empty estate", async () => {
    await expect(analyzeExportFile(exportFile({ rules: [] }))).rejects.toThrow(/no rules in it/);
  });
});

describe("persistAnalysis", () => {
  // The analysis is what getAutomationInsights checks to decide whether anything exists, so
  // writing it last makes it the commit point for the whole import.
  it("writes the analysis last, after every index", async () => {
    const save = vi.fn().mockResolvedValue({});
    await persistAnalysis(
      {
        analysis: { a: 1 },
        fields: { f: 1 },
        statuses: { s: 1 },
        issueTypes: { it: 1 },
        users: { u: 1 },
        directory: { d: 1 },
        findings: { fi: 1 },
        cascades: { c: 1 },
      },
      { save },
    );

    const order = save.mock.calls.map((c) => (c[0] === "saveAutomationIndex" ? c[1].part : c[0]));
    // Cascades go after the directory, which the cascade views join to for rule names, and
    // before the analysis, which is the commit point.
    expect(order).toEqual([
      "fields",
      "statuses",
      "issueTypes",
      "users",
      "directory",
      "findings",
      "cascades",
      "blast",
      "saveAutomationAnalysis",
    ]);
  });

  it("stops before the commit point if an index write fails", async () => {
    const save = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("kvs full"));

    await expect(
      persistAnalysis({ analysis: {}, fields: {}, statuses: {}, directory: {}, findings: {} }, { save }),
    ).rejects.toThrow("kvs full");
    expect(save).not.toHaveBeenCalledWith("saveAutomationAnalysis", expect.anything());
  });
});

describe("AutomationTab", () => {
  it("shows a loading state before the resolver answers", () => {
    invoke.mockReturnValue(new Promise(() => {}));
    render(<AutomationTab />);
    expect(screen.getByText(/loading automation insights/i)).toBeInTheDocument();
  });

  it("distinguishes an unbuilt analysis from a clean one", async () => {
    routeInvoke({ getAutomationInsights: { available: false, reason: "no-analysis" } });
    render(<AutomationTab />);
    expect(await screen.findByText(/no automation analysis yet/i)).toBeInTheDocument();
    expect(screen.queryByText("1,477")).not.toBeInTheDocument();
  });

  it("surfaces a resolver failure instead of rendering an empty estate", async () => {
    routeInvoke({ getAutomationInsights: new Error("kvs exploded") });
    render(<AutomationTab />);
    expect(await screen.findByText(/could not load automation insights/i)).toBeInTheDocument();
    expect(screen.getByText(/kvs exploded/)).toBeInTheDocument();
  });

  // The only pillar fed by hand, so the only one that can quietly go out of date while
  // every other tab refreshes on a schedule. Nothing in the shape of the data says so.
  describe("staleness", () => {
    it("warns when the analysis has passed the threshold, and says what it costs", async () => {
      routeInvoke({
        getAutomationInsights: analysis({
          evidence: { stale: true, ageDays: 23, staleAfterDays: 7, blockers: [{ code: "analysis-stale" }] },
        }),
      });
      render(<AutomationTab />);

      expect(await screen.findByText(/this analysis is 23 days old/i)).toBeInTheDocument();
      // Not just "old" -- what being old does to the answers.
      expect(screen.getByText(/answers "unknown" rather than "no rule touches this"/i)).toBeInTheDocument();
      // And where to change the line it was judged against.
      expect(screen.getByText(/threshold is 7 days/i)).toBeInTheDocument();
    });

    it("says so when the analysis cannot be dated at all", async () => {
      routeInvoke({
        getAutomationInsights: analysis({
          evidence: { stale: true, ageDays: null, staleAfterDays: 7, blockers: [] },
        }),
      });
      render(<AutomationTab />);
      expect(await screen.findByText(/carries no build date/i)).toBeInTheDocument();
    });

    it("stays quiet on a current analysis", async () => {
      routeInvoke({
        getAutomationInsights: analysis({
          evidence: { stale: false, ageDays: 1, staleAfterDays: 7, blockers: [] },
        }),
      });
      render(<AutomationTab />);

      await screen.findByText("1,477");
      expect(screen.queryByText(/days old/i)).not.toBeInTheDocument();
    });

    it("shows the build time absolutely as well as relatively", async () => {
      // "3 days ago" is the readable one; the timestamp is the one you can compare against
      // a change somebody made on a date they remember.
      routeInvoke({ getAutomationInsights: analysis() });
      render(<AutomationTab />);

      const meta = await screen.findByText(/^Analyzed /);
      expect(meta.textContent).toMatch(/\(.+\)/);
    });
  });

  it("opens on the overview with the estate headline numbers", async () => {
    routeInvoke({ getAutomationInsights: analysis() });
    render(<AutomationTab />);
    expect(await screen.findByText("1,477")).toBeInTheDocument();
    expect(screen.getByText("874")).toBeInTheDocument();
    expect(screen.getByText("41% of the estate")).toBeInTheDocument();
  });

  it("carries counts on the section navigation so the shape is visible before clicking", async () => {
    routeInvoke({ getAutomationInsights: analysis() });
    const { container } = render(<AutomationTab />);
    await screen.findByText("1,477");

    const nav = container.querySelector(".sub-nav");
    expect(within(nav).getByText("Fields")).toBeInTheDocument();
    expect(within(nav).getByText("735")).toBeInTheDocument();
    expect(within(nav).getByText("324")).toBeInTheDocument();
  });

  // The field index is ~116 KB; fetching it for a visit that never opens the section is
  // waste the user pays for on every page load.
  it("does not fetch the field index until the Fields section is opened", async () => {
    const user = userEvent.setup();
    routeInvoke({
      getAutomationInsights: analysis(),
      "getAutomationIndex:fields": FIELD_INDEX,
      "getAutomationIndex:directory": DIRECTORY,
    });
    const { container } = render(<AutomationTab />);
    await screen.findByText("1,477");

    expect(invoke).not.toHaveBeenCalledWith("getAutomationIndex", { part: "fields" });

    await user.click(within(container.querySelector(".sub-nav")).getByText("Fields"));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("getAutomationIndex", { part: "fields" }));
  });

  describe("field explorer", () => {
    async function openFields() {
      const user = userEvent.setup();
      routeInvoke({
        getAutomationInsights: analysis(),
        "getAutomationIndex:fields": FIELD_INDEX,
        "getAutomationIndex:directory": DIRECTORY,
      });
      const view = render(<AutomationTab />);
      await screen.findByText("1,477");
      await user.click(within(view.container.querySelector(".sub-nav")).getByText("Fields"));
      await screen.findByText("ADVEV Vehicle Program");
      return { user, ...view };
    }

    it("lists fields with their per-direction counts", async () => {
      const { container } = await openFields();
      const row = container.querySelectorAll(".ref-row")[0];
      expect(row.textContent).toContain("ADVEV Vehicle Program");
      expect(row.textContent).toContain("65");
      expect(row.textContent).toContain("66");
      expect(row.textContent).toContain("17");
    });

    it("shows the true total, not just the number of rows rendered", async () => {
      await openFields();
      expect(screen.getByText("735 fields")).toBeInTheDocument();
    });

    // The whole point of the drill-down: naming the rules, not their numeric ids.
    it("names the rules touching a field when the row is expanded", async () => {
      const { user } = await openFields();
      await user.click(screen.getByText("ADVEV Vehicle Program"));

      expect(await screen.findByText("Populate program")).toBeInTheDocument();
      expect(screen.getByText("Copy to subtasks")).toBeInTheDocument();
      expect(screen.getByText("Check program set")).toBeInTheDocument();
      expect(screen.queryByText("Rule 10")).not.toBeInTheDocument();
    });

    it("separates the rules by direction, since only writes block a deletion", async () => {
      const { user, container } = await openFields();
      await user.click(screen.getByText("ADVEV Vehicle Program"));

      const groups = container.querySelectorAll(".ref-detail__group");
      expect(groups[0].textContent).toContain("Writes");
      expect(groups[0].textContent).toContain("Populate program");
      expect(groups[1].textContent).toContain("Reads");
      expect(groups[1].textContent).toContain("Check program set");
    });

    it("says when the stored rule list is truncated", async () => {
      const { user } = await openFields();
      await user.click(screen.getByText("ADVEV Vehicle Program"));
      // 65 writes recorded, 2 ids stored.
      expect(await screen.findByText("Showing 2 of 65.")).toBeInTheDocument();
    });

    it("collapses an expanded row when clicked again", async () => {
      const { user } = await openFields();
      await user.click(screen.getByText("ADVEV Vehicle Program"));
      expect(await screen.findByText("Populate program")).toBeInTheDocument();

      await user.click(screen.getByText("ADVEV Vehicle Program"));
      await waitFor(() => expect(screen.queryByText("Populate program")).not.toBeInTheDocument());
    });

    it("filters fields by name and reports the narrowed count", async () => {
      const { user } = await openFields();
      await user.type(screen.getByLabelText(/search fields/i), "story");

      expect(screen.getByText("Story Points")).toBeInTheDocument();
      expect(screen.queryByText("ADVEV Vehicle Program")).not.toBeInTheDocument();
      expect(screen.getByText("1 of 735")).toBeInTheDocument();
    });

    it("says so when a search matches nothing", async () => {
      const { user } = await openFields();
      await user.type(screen.getByLabelText(/search fields/i), "zzzz");
      expect(screen.getByText(/nothing matches/i)).toBeInTheDocument();
    });

    it("reorders when the sort changes", async () => {
      const { user, container } = await openFields();
      await user.selectOptions(screen.getByLabelText(/sort fields/i), "write");

      const labels = [...container.querySelectorAll(".ref-row__label")].map((n) => n.textContent);
      expect(labels[0]).toBe("ADVEV Vehicle Program");

      await user.selectOptions(screen.getByLabelText(/sort fields/i), "label");
      const alpha = [...container.querySelectorAll(".ref-row__label")].map((n) => n.textContent);
      expect(alpha).toEqual(["ADVEV Vehicle Program", "Story Points"]);
    });

    it("marks disabled rules in the drill-down, since they do not currently run", async () => {
      const { user, container } = await openFields();
      await user.click(screen.getByText("ADVEV Vehicle Program"));

      const disabled = [...container.querySelectorAll(".ref-detail__rule--disabled")].map((n) => n.textContent);
      expect(disabled.join(" ")).toContain("Copy to subtasks");
    });

    it("recovers from a failed index load", async () => {
      const user = userEvent.setup();
      routeInvoke({
        getAutomationInsights: analysis(),
        "getAutomationIndex:fields": new Error("index gone"),
        "getAutomationIndex:directory": DIRECTORY,
      });
      const { container } = render(<AutomationTab />);
      await screen.findByText("1,477");
      await user.click(within(container.querySelector(".sub-nav")).getByText("Fields"));

      expect(await screen.findByText(/could not load fields references/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });
  });

  describe("status explorer", () => {
    it("loads the status index independently of the field index", async () => {
      const user = userEvent.setup();
      routeInvoke({
        getAutomationInsights: analysis(),
        "getAutomationIndex:statuses": {
          available: true,
          part: "statuses",
          total: 324,
          entries: [
            { label: "Done", writeCount: 73, readCount: 18, triggerCount: 40, write: [10], read: [12], trigger: [13] },
          ],
        },
        "getAutomationIndex:directory": DIRECTORY,
      });
      const { container } = render(<AutomationTab />);
      await screen.findByText("1,477");
      await user.click(within(container.querySelector(".sub-nav")).getByText("Statuses"));

      expect(await screen.findByText("Done")).toBeInTheDocument();
      expect(screen.getByText("324 statuses")).toBeInTheDocument();
      expect(invoke).not.toHaveBeenCalledWith("getAutomationIndex", { part: "fields" });
    });
  });

  describe("issue type explorer", () => {
    it("heads the column 'Issue type', not 'Status', and shows the resolved names", async () => {
      const user = userEvent.setup();
      routeInvoke({
        getAutomationInsights: analysis(),
        "getAutomationIndex:issueTypes": {
          available: true,
          part: "issueTypes",
          total: 2,
          entries: [
            { label: "Incident", writeCount: 30, readCount: 0, triggerCount: 0, write: [10], read: [], trigger: [] },
            { label: "Bug", writeCount: 0, readCount: 12, triggerCount: 0, write: [], read: [11], trigger: [] },
          ],
        },
        "getAutomationIndex:directory": DIRECTORY,
      });
      const { container } = render(<AutomationTab />);
      await screen.findByText("1,477");
      await user.click(within(container.querySelector(".sub-nav")).getByText("Issue types"));

      expect(await screen.findByText("Incident")).toBeInTheDocument();
      const head = container.querySelector(".ref-head");
      expect(head).toHaveTextContent("Issue type");
      expect(head).not.toHaveTextContent("Status");
    });
  });

  describe("users explorer", () => {
    it("lists the people rules name, under a 'User' column", async () => {
      const user = userEvent.setup();
      routeInvoke({
        getAutomationInsights: analysis({ estate: { ...analysis().estate, usersReferenced: 2 } }),
        "getAutomationIndex:users": {
          available: true,
          part: "users",
          total: 2,
          entries: [
            { label: "Ann Admin", writeCount: 5, readCount: 0, triggerCount: 0, write: [10], read: [], trigger: [] },
            { label: "acc-gone", writeCount: 0, readCount: 3, triggerCount: 0, write: [], read: [11], trigger: [] },
          ],
        },
        "getAutomationIndex:directory": DIRECTORY,
      });
      const { container } = render(<AutomationTab />);
      await screen.findByText("1,477");
      await user.click(within(container.querySelector(".sub-nav")).getByText("Users"));

      expect(await screen.findByText("Ann Admin")).toBeInTheDocument();
      expect(container.querySelector(".ref-head")).toHaveTextContent("User");
    });
  });

  describe("cascades", () => {
    // Every cascade now comes from automation_cascades through a paged resolver, rather than
    // from whatever fitted in the analysis document. The tab renders what it is given and
    // filters by asking again -- so these pin the wiring, and the grouping and filtering
    // themselves are tested against the query in src/lib/store/automation.test.js.
    const cascadePage = (over = {}) => ({
      available: true,
      summary: { edges: 1457, pairs: 1143, selfTriggeringRules: 123, fields: 214 },
      cascades: [
        {
          sourceId: "9",
          sourceName: "Loopy rule",
          targetId: "9",
          targetName: "Loopy rule",
          selfTriggering: true,
          fields: ["Owner"],
          fieldCount: 1,
        },
        {
          sourceId: "1",
          sourceName: "Writer",
          targetId: "2",
          targetName: "Listener",
          selfTriggering: false,
          fields: ["A", "B", "C"],
          fieldCount: 3,
        },
      ],
      total: 2,
      page: 1,
      pageSize: 50,
      ...over,
    });

    async function openCascades({ page = cascadePage(), graph = null, data = analysis() } = {}) {
      const user = userEvent.setup();
      routeInvoke({
        getAutomationInsights: data,
        getAutomationCascades: page,
        getCascadeGraph: graph ?? { available: false, reason: "no-cascades" },
      });
      const view = render(<AutomationTab />);
      await screen.findByText("1,477");
      await user.click(within(view.container.querySelector(".sub-nav")).getByText("Cascades"));
      await screen.findByText("Relationships");
      return { user, ...view };
    }

    it("names both rules on a cross-rule cascade", async () => {
      const { container } = await openCascades();
      await waitFor(() => expect(container.querySelectorAll(".cascade").length).toBe(2));

      const text = [...container.querySelectorAll(".cascade")].map((r) => r.textContent).join(" ");
      expect(text).toContain("Writer");
      expect(text).toContain("Listener");
    });

    it("flags a self-triggering rule and shows it without a second rule", async () => {
      const { container } = await openCascades();
      await waitFor(() => expect(container.querySelector(".cascade")).toBeTruthy());

      const first = container.querySelector(".cascade");
      expect(first.className).toContain("cascade--self");
      expect(first.textContent).toContain("Loopy rule");
    });

    it("lists the fields involved once per rule pair rather than repeating the rule", async () => {
      const { container } = await openCascades();
      await waitFor(() => expect(container.querySelectorAll(".cascade").length).toBe(2));

      const row = [...container.querySelectorAll(".cascade")].find((r) => r.textContent.includes("Writer"));
      expect(row.textContent.match(/Writer/g)).toHaveLength(1);
      for (const field of ["A", "B", "C"]) expect(row.textContent).toContain(field);
    });

    it("pages rather than truncating, and says how many there are", async () => {
      // The defect this replaces: 150 of 1,457 were stored and the rest were unreachable by
      // any amount of scrolling, under a footnote saying so.
      const { container } = await openCascades({
        page: cascadePage({ total: 1143 }),
      });

      await waitFor(() => expect(container.querySelector(".pagination-bar")).toBeTruthy());
      expect(container.querySelector(".pagination-bar__status").textContent).toMatch(/1,143 relationships/);
      expect(screen.getByText("1,457")).toBeInTheDocument();
    });

    it("asks the resolver again when the filter changes", async () => {
      const { user } = await openCascades();

      await user.selectOptions(screen.getByLabelText(/kind/i), "self");

      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith(
          "getAutomationCascades",
          expect.objectContaining({ kind: "self", page: 1 }),
        ),
      );
    });

    // Neither empty state renders the sub-view switcher, so these cannot wait on it.
    async function openEmptyCascades(data) {
      const user = userEvent.setup();
      routeInvoke({
        getAutomationInsights: data,
        getAutomationCascades: {
          available: false,
          summary: { edges: 0, pairs: 0, selfTriggeringRules: 0, fields: 0 },
          cascades: [],
          total: 0,
        },
        getCascadeGraph: { available: false, reason: "no-cascades" },
      });
      const view = render(<AutomationTab />);
      await screen.findByText("1,477");
      await user.click(within(view.container.querySelector(".sub-nav")).getByText("Cascades"));
      return view;
    }

    it("says so when nothing can cascade", async () => {
      await openEmptyCascades(analysis({ cascades: [], cascadesTotal: 0, selfTriggeringTotal: 0 }));
      expect(await screen.findByText(/no rule writes a field that another rule triggers on/i)).toBeInTheDocument();
    });

    // An install that imported before the table existed has an estate summary claiming
    // cascades and no rows behind it. Saying "nothing cascades" there would be a false
    // all-clear over data we simply never wrote.
    it("asks for a re-import rather than claiming nothing cascades", async () => {
      await openEmptyCascades(analysis({ cascadesTotal: 1457 }));
      expect(await screen.findByText(/imported before cascades were stored in full/i)).toBeInTheDocument();
    });
  });

  describe("cascade loops and chains", () => {
    // The multi-hop view the cap made impossible. A chain A -> B -> C is found by walking the
    // edge set, and walking a set truncated at 150 finds chains that stop where the
    // truncation did -- so the answer was not "fewer chains", it was "wrong chains".
    const graph = (over = {}) => ({
      available: true,
      ruleCount: 318,
      edgeCount: 1143,
      rulesInLoops: 89,
      deepestChain: 9,
      truncated: false,
      maxDepth: 8,
      loops: [
        {
          size: 3,
          selfTriggering: false,
          ruleIds: ["1", "2", "3"],
          ruleNames: ["Alpha", "Beta", "Gamma"],
          path: [
            { id: "1", name: "Alpha", viaFields: ["Owner"], enabled: true },
            { id: "2", name: "Beta", viaFields: ["Status"], enabled: true },
            { id: "3", name: "Gamma", viaFields: ["Owner"], enabled: false },
            { id: "1", name: "Alpha", viaFields: [], enabled: true },
          ],
        },
      ],
      chains: [
        {
          length: 4,
          ruleIds: ["7", "8", "9", "10"],
          steps: [
            { id: "7", name: "Start", viaFields: ["Milestone"], enabled: true },
            { id: "8", name: "Middle", viaFields: ["Checkpoint"], enabled: true },
            { id: "9", name: "Later", viaFields: ["Fix Version"], enabled: true },
            { id: "10", name: "End", viaFields: [], enabled: true },
          ],
        },
      ],
      ...over,
    });

    async function openChains(over = {}) {
      const user = userEvent.setup();
      routeInvoke({
        getAutomationInsights: analysis(),
        getAutomationCascades: {
          available: true,
          summary: { edges: 1457, pairs: 1143, selfTriggeringRules: 123, fields: 214 },
          cascades: [],
          total: 0,
          page: 1,
          pageSize: 50,
        },
        getCascadeGraph: graph(over),
      });
      const view = render(<AutomationTab />);
      await screen.findByText("1,477");
      await user.click(within(view.container.querySelector(".sub-nav")).getByText("Cascades"));
      await user.click(await screen.findByText(/Loops and chains/));
      return { user, ...view };
    }

    it("shows a loop as a walkable path, naming the field that carries each hop", async () => {
      const { container } = await openChains();

      await waitFor(() => expect(container.querySelector(".cascade-path")).toBeTruthy());
      const path = container.querySelector(".cascade-path");
      expect(path.textContent).toContain("Alpha");
      expect(path.textContent).toContain("Beta");
      expect(path.textContent).toContain("Gamma");
      // The field is what an admin breaks to stop the loop, so it is on the hop rather than
      // summarised at the end.
      expect(path.textContent).toContain("Owner");
      expect(path.textContent).toContain("Status");
    });

    it("marks a disabled rule inside a path, because it does not currently fire", async () => {
      const { container } = await openChains();
      await waitFor(() => expect(container.querySelector(".cascade-path")).toBeTruthy());
      expect(container.querySelector(".cascade-path").textContent).toContain("disabled");
    });

    it("counts the rules caught in a loop, not the loops", async () => {
      await openChains();
      // A rule in two loops is one rule with a problem.
      expect(await screen.findByText(/89 rules caught in one/)).toBeInTheDocument();
    });

    it("switches to the chains that are not loops", async () => {
      const { user, container } = await openChains();

      await user.click(await screen.findByText(/^Chains$/));
      await waitFor(() => expect(container.querySelector(".cascade-chain").textContent).toContain("4 rules deep"));

      const path = container.querySelector(".cascade-path");
      expect(path.textContent).toContain("Start");
      expect(path.textContent).toContain("End");
      expect(path.className).not.toContain("cascade-path--loop");
    });

    // A truncated answer presented as a complete one is worse than a smaller one that says
    // what it left out -- and the distinction matters: loops are found by decomposition
    // rather than by walking paths, so they are complete even when the chain walk is not.
    it("says when the walk hit its bound, and that loops are unaffected", async () => {
      await openChains({ truncated: true });
      expect(await screen.findByText(/sample rather than the full set/i)).toBeInTheDocument();
      expect(screen.getByText(/Loops are unaffected/)).toBeInTheDocument();
    });

    it("says so when no rule can reach itself", async () => {
      await openChains({ loops: [], rulesInLoops: 0 });
      expect(await screen.findByText(/no rule can reach itself through other rules/i)).toBeInTheDocument();
    });
  });

  describe("blast radius", () => {
    const blastPage = (over = {}) => ({
      available: true,
      total: 2,
      page: 1,
      pageSize: 50,
      rules: [
        {
          ruleId: "1",
          name: "Site-wide status sweep",
          enabled: true,
          triggerType: "jira.jql.scheduled",
          score: 88,
          tier: "estate",
          estimated: true,
          credential: false,
          factors: [
            { key: "reach", label: "Reach", weight: 0.4, value: 1, detail: "Scoped to the whole site." },
            { key: "cadence", label: "Trigger cadence", weight: 0.15, value: 1, detail: "Scheduled." },
            { key: "writes", label: "Action weight", weight: 0.25, value: 0.6, detail: "Actions: 2 transitions." },
            { key: "fanout", label: "Fan-out", weight: 0.2, value: 0.3, detail: "Can wake other rules." },
          ],
          modifiers: [],
        },
        {
          ruleId: "2",
          name: "One project label tidy",
          enabled: false,
          triggerType: "jira.manual.trigger.issue",
          score: 8,
          tier: "contained",
          estimated: true,
          credential: false,
          factors: [],
          modifiers: [{ key: "disabled", detail: "Rule is disabled; this is its latent blast radius." }],
        },
      ],
      ...over,
    });

    async function openBlast({ data = analysis(), page = blastPage() } = {}) {
      const user = userEvent.setup();
      routeInvoke({ getAutomationInsights: data, getAutomationBlast: page });
      const view = render(<AutomationTab />);
      await screen.findByText("1,477");
      await user.click(within(view.container.querySelector(".sub-nav")).getByText("Blast radius"));
      return { user, ...view };
    }

    it("shows the tier histogram from the analysis summary", async () => {
      const { container } = await openBlast();
      await screen.findByText("Site-wide status sweep");
      const tiles = [...container.querySelectorAll(".ui-stat")].map((t) => t.textContent);
      // Estate-wide tile carries byTier.estate (12) and the credential hint.
      expect(tiles.some((t) => /Estate-wide/.test(t) && /12/.test(t))).toBe(true);
      expect(tiles.some((t) => /also store a credential/.test(t))).toBe(true);
    });

    it("lists rules by score with a tier chip and expands to the factor breakdown", async () => {
      const { user, container } = await openBlast();
      const row = await screen.findByText("Site-wide status sweep");
      await user.click(row.closest(".blast-row"));
      expect(await screen.findByText(/Scheduled\./)).toBeInTheDocument();
      expect(container.querySelector(".blast-factor")).toBeTruthy();
    });

    it("re-queries the resolver when the tier filter changes", async () => {
      const { user } = await openBlast();
      await screen.findByText("Site-wide status sweep");
      await user.selectOptions(screen.getByLabelText(/tier/i), "estate");
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("getAutomationBlast", expect.objectContaining({ tier: "estate", page: 1 })),
      );
    });

    it("prompts for a re-import when the analysis predates blast scoring", async () => {
      await openBlast({ data: analysis({ blast: null }) });
      expect(await screen.findByText(/imported before blast radius was scored/i)).toBeInTheDocument();
    });
  });

  describe("findings", () => {
    // 120 rows so pagination is exercised at the real page size of 50.
    const MANY = Array.from({ length: 120 }, (_, i) => ({
      id: i + 1,
      n: `Rule ${i + 1}`,
      e: i % 3 === 0 ? 0 : 1,
      t: i % 2 === 0 ? "jira.jql.scheduled" : "jira.issue.field.changed",
      u: 1,
      p: 1,
      w: i === 0 ? ["Story Points"] : [],
      s: i < 10 ? "high" : "info",
      r: i < 10 ? [{ c: "embedded-credential", s: "high" }] : [{ c: "disabled", s: "info", d: 200 }],
    }));

    async function openFindings({ findings = MANY, data = analysis({ findingsTotal: findings.length }) } = {}) {
      const user = userEvent.setup();
      routeInvoke({
        getAutomationInsights: data,
        "getAutomationIndex:findings": { available: true, part: "findings", total: findings.length, findings },
        "getAutomationIndex:directory": DIRECTORY,
      });
      const view = render(<AutomationTab />);
      await screen.findByText("1,477");
      await user.click(within(view.container.querySelector(".sub-nav")).getByText("Findings"));
      await screen.findByText("Rule 1");
      return { user, ...view };
    }

    it("does not fetch findings until the section is opened", async () => {
      routeInvoke({ getAutomationInsights: analysis() });
      render(<AutomationTab />);
      await screen.findByText("1,477");
      expect(invoke).not.toHaveBeenCalledWith("getAutomationIndex", { part: "findings" });
    });

    it("loads every finding, not a capped subset", async () => {
      await openFindings();
      expect(screen.getByText("120 rules")).toBeInTheDocument();
    });

    it("pages rather than rendering 120 rows at once", async () => {
      const { container } = await openFindings();
      expect(container.querySelectorAll(".ui-finding")).toHaveLength(50);
      expect(screen.getByText("1–50 of 120")).toBeInTheDocument();
    });

    it("moves between pages", async () => {
      const { user } = await openFindings();
      await user.click(screen.getByRole("button", { name: /next/i }));

      expect(screen.getByText("51–100 of 120")).toBeInTheDocument();
      expect(screen.getByText("Rule 51")).toBeInTheDocument();
      expect(screen.queryByText("Rule 1")).not.toBeInTheDocument();
    });

    it("disables Previous on the first page and Next on the last", async () => {
      const { user } = await openFindings();
      expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();

      await user.click(screen.getByRole("button", { name: /next/i }));
      await user.click(screen.getByRole("button", { name: /next/i }));

      expect(screen.getByText("101–120 of 120")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
    });

    // Staying on page 3 of a list that just became one page long shows an empty screen.
    it("returns to the first page when a filter narrows the list", async () => {
      const { user } = await openFindings();
      await user.click(screen.getByRole("button", { name: /next/i }));
      expect(screen.getByText("51–100 of 120")).toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText(/filter by severity/i), "high");

      expect(screen.getByText("Rule 1")).toBeInTheDocument();
      expect(screen.getByText("10 of 120")).toBeInTheDocument();
    });

    it("filters by severity", async () => {
      const { user } = await openFindings();
      await user.selectOptions(screen.getByLabelText(/filter by severity/i), "high");
      expect(screen.getByText("10 of 120")).toBeInTheDocument();
    });

    it("filters by finding type, offering only the types present", async () => {
      const { user } = await openFindings();
      const select = screen.getByLabelText(/filter by finding/i);
      expect(within(select).getByText("Credential stored in plaintext")).toBeInTheDocument();
      expect(within(select).queryByText("Trigger with no actions")).not.toBeInTheDocument();

      await user.selectOptions(select, "embedded-credential");
      expect(screen.getByText("10 of 120")).toBeInTheDocument();
    });

    it("filters by rule state", async () => {
      const { user } = await openFindings();
      await user.selectOptions(screen.getByLabelText(/filter by rule state/i), "disabled");
      expect(screen.getByText("40 of 120")).toBeInTheDocument();
    });

    it("filters by trigger type", async () => {
      const { user } = await openFindings();
      await user.selectOptions(screen.getByLabelText(/filter by trigger/i), "jira.jql.scheduled");
      expect(screen.getByText("60 of 120")).toBeInTheDocument();
    });

    // "Which rules write Story Points and have a finding" is a question people arrive with,
    // and the rule name rarely contains the field name.
    it("searches the fields a rule writes, not just its name", async () => {
      const { user } = await openFindings();
      await user.type(screen.getByLabelText(/search rule names/i), "story points");

      expect(screen.getByText("1 of 120")).toBeInTheDocument();
      expect(screen.getByText("Rule 1")).toBeInTheDocument();
    });

    it("combines filters rather than replacing them", async () => {
      const { user } = await openFindings();
      await user.selectOptions(screen.getByLabelText(/filter by severity/i), "info");
      await user.selectOptions(screen.getByLabelText(/filter by rule state/i), "disabled");

      // 40 rows are disabled; 4 of those are also high-severity, leaving 36.
      expect(screen.getByText("36 of 120")).toBeInTheDocument();
    });

    it("renders a readable risk label rather than a code", async () => {
      await openFindings();
      expect(screen.getAllByText("Credential stored in plaintext").length).toBeGreaterThan(0);
      expect(screen.queryByText("embedded-credential")).not.toBeInTheDocument();
    });

    it("says so when filters match nothing", async () => {
      const { user } = await openFindings();
      await user.type(screen.getByLabelText(/search rule names/i), "zzzznomatch");
      expect(screen.getByText(/no rules match these filters/i)).toBeInTheDocument();
    });

    it("recovers from a failed findings load", async () => {
      const user = userEvent.setup();
      routeInvoke({
        getAutomationInsights: analysis(),
        "getAutomationIndex:findings": new Error("findings gone"),
        "getAutomationIndex:directory": DIRECTORY,
      });
      const { container } = render(<AutomationTab />);
      await screen.findByText("1,477");
      await user.click(within(container.querySelector(".sub-nav")).getByText("Findings"));

      expect(await screen.findByText(/could not load findings/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });
  });

  describe("importing an export", () => {
    it("offers the import control from the empty state", async () => {
      routeInvoke({ getAutomationInsights: { available: false, reason: "no-analysis" } });
      render(<AutomationTab />);
      expect(await screen.findByRole("button", { name: /import rule export/i })).toBeInTheDocument();
    });

    it("says the rules stay in the browser, because that is why it is safe", async () => {
      routeInvoke({ getAutomationInsights: { available: false, reason: "no-analysis" } });
      render(<AutomationTab />);
      expect(await screen.findByText(/never leave this page/i)).toBeInTheDocument();
    });

    it("sends the derived documents, never the raw export", async () => {
      const user = userEvent.setup();
      invoke.mockResolvedValueOnce({ available: false, reason: "no-analysis" }).mockResolvedValue({ saved: true });

      const { container } = render(<AutomationTab />);
      await screen.findByRole("button", { name: /import rule export/i });

      await user.upload(container.querySelector("input[type=file]"), exportFile({ rules: [RULE] }));

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("saveAutomationAnalysis", expect.any(Object)));
      const sent = JSON.stringify(invoke.mock.calls.filter((c) => c[0].startsWith("save")));
      expect(sent).not.toContain("jira.issue.edit");
      expect(sent).not.toContain("operations");
    });

    it("writes every supporting index before the analysis", async () => {
      const user = userEvent.setup();
      invoke.mockResolvedValueOnce({ available: false, reason: "no-analysis" }).mockResolvedValue({ saved: true });

      const { container } = render(<AutomationTab />);
      await screen.findByRole("button", { name: /import rule export/i });
      await user.upload(container.querySelector("input[type=file]"), exportFile({ rules: [RULE] }));

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("saveAutomationAnalysis", expect.any(Object)));
      const parts = invoke.mock.calls.filter((c) => c[0] === "saveAutomationIndex").map((c) => c[1].part);
      expect(parts).toEqual([
        "fields",
        "statuses",
        "issueTypes",
        "users",
        "directory",
        "findings",
        "cascades",
        "blast",
      ]);
    });

    it("shows a parse error against the control and keeps it usable", async () => {
      const user = userEvent.setup();
      routeInvoke({ getAutomationInsights: { available: false, reason: "no-analysis" } });

      const { container } = render(<AutomationTab />);
      await screen.findByRole("button", { name: /import rule export/i });
      await user.upload(container.querySelector("input[type=file]"), exportFile({ notRules: true }));

      expect(await screen.findByText(/no rules in it/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /import rule export/i })).toBeEnabled();
      expect(invoke).not.toHaveBeenCalledWith("saveAutomationAnalysis", expect.anything());
    });

    it("offers a re-import once an analysis exists", async () => {
      routeInvoke({ getAutomationInsights: analysis() });
      render(<AutomationTab />);
      expect(await screen.findByRole("button", { name: /re-import export/i })).toBeInTheDocument();
    });
  });
});

describe("DIRECTIONS", () => {
  it("keeps write first, because it is the direction that blocks a deletion", () => {
    expect(DIRECTIONS[0].key).toBe("write");
  });

  it("gives every direction a plain-language consequence", () => {
    for (const d of DIRECTIONS) {
      expect(d.hint.length).toBeGreaterThan(20);
      expect(d.label).toBeTruthy();
    }
  });
});

// "86 rules storing a credential in plaintext" used to open the Findings section showing all
// 675 rules that carry any finding at all, leaving the reader to set the filter themselves.
describe("AutomationTab — arriving from a finding", () => {
  test("opens the section the finding lives in", async () => {
    routeInvoke({ getAutomationInsights: analysis() });
    const { container } = render(<AutomationTab intent={{ section: "cascades", cascadeKind: "self" }} />);

    await waitFor(() => expect(container.querySelector(".sub-nav__item--active")?.textContent).toMatch(/Cascades/));
  });

  test("filters the findings list to the risk the finding counted", async () => {
    routeInvoke({
      getAutomationInsights: analysis({ findingsTotal: 2 }),
      "getAutomationIndex:findings": {
        available: true,
        part: "findings",
        total: 2,
        findings: [
          {
            id: 1,
            n: "Leaks a secret",
            e: 1,
            t: "jira.jql.scheduled",
            u: 1,
            p: 1,
            w: [],
            s: "high",
            r: [{ c: "embedded-credential", s: "high" }],
          },
          {
            id: 2,
            n: "Merely disabled",
            e: 0,
            t: "jira.jql.scheduled",
            u: 1,
            p: 1,
            w: [],
            s: "info",
            r: [{ c: "disabled", s: "info", d: 30 }],
          },
        ],
      },
      "getAutomationIndex:directory": DIRECTORY,
    });

    render(<AutomationTab intent={{ section: "findings", risk: "embedded-credential" }} />);

    expect(await screen.findByText("Leaks a secret")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Merely disabled")).not.toBeInTheDocument());
  });

  // Self-triggering is a cascade property rather than a rule finding, which is why it routes
  // to the cascade list and not to Findings.
  test("filters the cascade list to self-triggering rules", async () => {
    routeInvoke({
      getAutomationInsights: analysis(),
      getAutomationCascades: {
        available: true,
        summary: { edges: 1457, pairs: 1143, selfTriggeringRules: 123, fields: 214 },
        cascades: [],
        total: 0,
        page: 1,
        pageSize: 50,
      },
      getCascadeGraph: { available: false, reason: "no-cascades" },
    });

    render(<AutomationTab intent={{ section: "cascades", cascadeKind: "self" }} />);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("getAutomationCascades", expect.objectContaining({ kind: "self" })),
    );
  });

  test("opened normally, it filters nothing", async () => {
    routeInvoke({ getAutomationInsights: analysis() });
    const { container } = render(<AutomationTab />);

    await screen.findByText("1,477");
    expect(container.querySelector(".sub-nav__item--active")?.textContent).toMatch(/Overview/);
  });
});
