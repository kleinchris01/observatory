import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import {
  AutomationTab,
  DIRECTIONS,
  analyzeExportFile,
  findingDetailLine,
  groupCascades,
  persistAnalysis,
  sortEntries,
  triggerLabel,
} from "./AutomationTab";

function exportFile(payload, name = "automation-rules-202608060201.json") {
  return new File([JSON.stringify(payload)], name, { type: "application/json" });
}

const RULE = {
  id: 1, name: "Set due date", state: "ENABLED", canOtherRuleTrigger: false, updated: 1,
  trigger: { id: "t", component: "TRIGGER", type: "jira.issue.field.changed", value: { fields: [{ type: "fieldName", value: "Actual SEOBD" }] }, children: [], conditions: [] },
  components: [{
    id: "a", component: "ACTION", type: "jira.issue.edit", children: [], conditions: [],
    value: { operations: [{ field: { type: "NAME", value: "Post sourcing cost review" }, type: "SET", value: "{{now}}" }] },
  }],
  projects: [{ projectId: "10518" }],
};

function analysis(overrides = {}) {
  return {
    available: true,
    refreshedAt: Date.now() - 3600_000,
    source: "export-file",
    estate: {
      ruleCount: 1477, enabledCount: 874, disabledCount: 603,
      fieldsReferenced: 735, statusesReferenced: 324,
      triggerBreakdown: [
        { type: "jira.issue.field.changed", count: 401 },
        { type: "jira.jql.scheduled", count: 231 },
      ],
    },
    findings: [
      { id: 1, name: "Alexandria - Send to Approval", state: "ENABLED", enabled: true,
        triggerType: "jira.issue.field.changed", projectCount: 2, topSeverity: "high",
        risks: [{ code: "embedded-credential", severity: "high", detail: "Credential in plaintext." }] },
      { id: 2, name: "Old cleanup rule", state: "DISABLED", enabled: false,
        triggerType: "jira.jql.scheduled", projectCount: 0, topSeverity: "info",
        risks: [{ code: "disabled", severity: "info", detail: "Disabled 200 days ago." }] },
    ],
    findingsTotal: 2,
    cascades: [
      { sourceId: 1, targetId: 2, sourceName: "Writer", targetName: "Listener", field: "Actual SEOBD", selfTriggering: false },
      { sourceId: 7, targetId: 7, sourceName: "Loopy rule", targetName: "Loopy rule", field: "Loopy", selfTriggering: true },
    ],
    cascadesTotal: 2,
    selfTriggeringTotal: 1,
    ...overrides,
  };
}

const FIELD_INDEX = {
  available: true, part: "fields", total: 735,
  entries: [
    { label: "ADVEV Vehicle Program", writeCount: 65, readCount: 66, triggerCount: 17, write: [10, 11], read: [12], trigger: [13] },
    { label: "Story Points", writeCount: 3, readCount: 1, triggerCount: 0, write: [10], read: [12], trigger: [] },
  ],
};

const DIRECTORY = {
  available: true, part: "directory", total: 4,
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
    expect(findingDetailLine({ triggerType: "jira.issue.field.changed", projectCount: 2, enabled: true }))
      .toBe("Field changed · 2 projects");
  });

  it("singularizes a one-project scope", () => {
    expect(findingDetailLine({ triggerType: null, projectCount: 1, enabled: true })).toBe("No trigger · 1 project");
  });

  it("names a site-wide rule rather than showing zero projects", () => {
    expect(findingDetailLine({ triggerType: null, projectCount: 0, enabled: true })).toBe("No trigger · site-wide");
  });

  it("appends the disabled state", () => {
    expect(findingDetailLine({ triggerType: null, projectCount: 0, enabled: false })).toBe("No trigger · site-wide · disabled");
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

describe("groupCascades", () => {
  // One row per edge produced 25 consecutive lines naming the same rule; grouping is the
  // whole reason the section is readable.
  it("collapses many edges between the same pair into one row", () => {
    const groups = groupCascades([
      { sourceId: 1, targetId: 2, sourceName: "A", targetName: "B", field: "F1", selfTriggering: false },
      { sourceId: 1, targetId: 2, sourceName: "A", targetName: "B", field: "F2", selfTriggering: false },
      { sourceId: 1, targetId: 2, sourceName: "A", targetName: "B", field: "F3", selfTriggering: false },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].fields).toEqual(["F1", "F2", "F3"]);
  });

  it("keeps separate rule pairs apart", () => {
    const groups = groupCascades([
      { sourceId: 1, targetId: 2, field: "F", selfTriggering: false },
      { sourceId: 1, targetId: 3, field: "F", selfTriggering: false },
    ]);
    expect(groups).toHaveLength(2);
  });

  it("puts self-triggering rules first, since they are likeliest and cheapest to fix", () => {
    const groups = groupCascades([
      { sourceId: 1, targetId: 2, field: "F", selfTriggering: false },
      { sourceId: 9, targetId: 9, field: "G", selfTriggering: true },
    ]);
    expect(groups[0].selfTriggering).toBe(true);
  });

  it("deduplicates a field repeated on the same pair", () => {
    const groups = groupCascades([
      { sourceId: 1, targetId: 2, field: "F", selfTriggering: false },
      { sourceId: 1, targetId: 2, field: "F", selfTriggering: false },
    ]);
    expect(groups[0].fields).toEqual(["F"]);
  });

  it("handles an empty list", () => {
    expect(groupCascades([])).toEqual([]);
  });
});

describe("analyzeExportFile", () => {
  it("derives every document from a real export shape", async () => {
    const docs = await analyzeExportFile(exportFile({ cloud: true, rules: [RULE] }));
    expect(Object.keys(docs).sort()).toEqual(["analysis", "directory", "fields", "statuses"]);
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
    await persistAnalysis({ analysis: { a: 1 }, fields: { f: 1 }, statuses: { s: 1 }, directory: { d: 1 } }, { save });

    const order = save.mock.calls.map((c) => (c[0] === "saveAutomationIndex" ? c[1].part : c[0]));
    expect(order).toEqual(["fields", "statuses", "directory", "saveAutomationAnalysis"]);
  });

  it("stops before the commit point if an index write fails", async () => {
    const save = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("kvs full"));

    await expect(persistAnalysis({ analysis: {}, fields: {}, statuses: {}, directory: {} }, { save })).rejects.toThrow("kvs full");
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
          available: true, part: "statuses", total: 324,
          entries: [{ label: "Done", writeCount: 73, readCount: 18, triggerCount: 40, write: [10], read: [12], trigger: [13] }],
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

  describe("cascades", () => {
    async function openCascades(data = analysis()) {
      const user = userEvent.setup();
      routeInvoke({ getAutomationInsights: data });
      const view = render(<AutomationTab />);
      await screen.findByText("1,477");
      await user.click(within(view.container.querySelector(".sub-nav")).getByText("Cascades"));
      return { user, ...view };
    }

    it("names both rules on a cross-rule cascade", async () => {
      const { container } = await openCascades();
      const rows = container.querySelectorAll(".cascade");
      expect([...rows].map((r) => r.textContent).join(" ")).toContain("Writer");
      expect([...rows].map((r) => r.textContent).join(" ")).toContain("Listener");
    });

    it("flags self-triggering rules and lists them first", async () => {
      const { container } = await openCascades();
      const first = container.querySelector(".cascade");
      expect(first.className).toContain("cascade--self");
      expect(first.textContent).toContain("Loopy rule");
    });

    it("lists the fields involved once per rule pair rather than repeating the rule", async () => {
      const { container } = await openCascades(analysis({
        cascades: [
          { sourceId: 1, targetId: 2, sourceName: "Auto-Populate", targetName: "Child", field: "A", selfTriggering: false },
          { sourceId: 1, targetId: 2, sourceName: "Auto-Populate", targetName: "Child", field: "B", selfTriggering: false },
          { sourceId: 1, targetId: 2, sourceName: "Auto-Populate", targetName: "Child", field: "C", selfTriggering: false },
        ],
        cascadesTotal: 3, selfTriggeringTotal: 0,
      }));

      expect(container.querySelectorAll(".cascade")).toHaveLength(1);
      const row = container.querySelector(".cascade");
      expect(row.textContent.match(/Auto-Populate/g)).toHaveLength(1);
      for (const f of ["A", "B", "C"]) expect(row.textContent).toContain(f);
    });

    it("says so when nothing can cascade", async () => {
      await openCascades(analysis({ cascades: [], cascadesTotal: 0, selfTriggeringTotal: 0 }));
      expect(await screen.findByText(/no rule writes a field that another rule triggers on/i)).toBeInTheDocument();
    });

    it("reports the true total when the stored list is truncated", async () => {
      await openCascades(analysis({ cascadesTotal: 1457 }));
      expect(await screen.findByText(/showing 2 of 1,457 cascade paths/i)).toBeInTheDocument();
    });
  });

  describe("findings", () => {
    async function openFindings(data = analysis()) {
      const user = userEvent.setup();
      routeInvoke({ getAutomationInsights: data });
      const view = render(<AutomationTab />);
      await screen.findByText("1,477");
      await user.click(within(view.container.querySelector(".sub-nav")).getByText("Findings"));
      return { user, ...view };
    }

    it("renders a readable risk label rather than a code", async () => {
      await openFindings();
      expect(await screen.findByText("Credential stored in plaintext")).toBeInTheDocument();
      expect(screen.queryByText("embedded-credential")).not.toBeInTheDocument();
    });

    it("filters by severity", async () => {
      const { user } = await openFindings();
      await user.selectOptions(screen.getByLabelText(/filter by severity/i), "high");

      expect(screen.getByText("Alexandria - Send to Approval")).toBeInTheDocument();
      expect(screen.queryByText("Old cleanup rule")).not.toBeInTheDocument();
    });

    it("distinguishes a filter with no matches from an estate with no findings", async () => {
      const { user } = await openFindings();
      await user.type(screen.getByLabelText(/search rule names/i), "zzzznomatch");
      expect(screen.getByText(/no rules match this filter/i)).toBeInTheDocument();
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
      invoke
        .mockResolvedValueOnce({ available: false, reason: "no-analysis" })
        .mockResolvedValue({ saved: true });

      const { container } = render(<AutomationTab />);
      await screen.findByRole("button", { name: /import rule export/i });

      await user.upload(container.querySelector("input[type=file]"), exportFile({ rules: [RULE] }));

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("saveAutomationAnalysis", expect.any(Object)));
      const sent = JSON.stringify(invoke.mock.calls.filter((c) => c[0].startsWith("save")));
      expect(sent).not.toContain("jira.issue.edit");
      expect(sent).not.toContain("operations");
    });

    it("writes all four documents", async () => {
      const user = userEvent.setup();
      invoke
        .mockResolvedValueOnce({ available: false, reason: "no-analysis" })
        .mockResolvedValue({ saved: true });

      const { container } = render(<AutomationTab />);
      await screen.findByRole("button", { name: /import rule export/i });
      await user.upload(container.querySelector("input[type=file]"), exportFile({ rules: [RULE] }));

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("saveAutomationAnalysis", expect.any(Object)));
      const parts = invoke.mock.calls.filter((c) => c[0] === "saveAutomationIndex").map((c) => c[1].part);
      expect(parts).toEqual(["fields", "statuses", "directory"]);
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
