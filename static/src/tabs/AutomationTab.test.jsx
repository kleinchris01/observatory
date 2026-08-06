import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { AutomationTab, analyzeExportFile, findingDetailLine, triggerLabel } from "./AutomationTab";

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
        id: 1, name: "Alexandria - Send to Approval", state: "ENABLED", enabled: true,
        triggerType: "jira.issue.field.changed", projectCount: 2, topSeverity: "high",
        risks: [{ code: "embedded-credential", severity: "high", detail: "Credential in plaintext." }],
      },
      {
        id: 2, name: "Old cleanup rule", state: "DISABLED", enabled: false,
        triggerType: "jira.jql.scheduled", projectCount: 0, topSeverity: "info",
        risks: [{ code: "disabled", severity: "info", detail: "Disabled 200 days ago." }],
      },
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

beforeEach(() => {
  invoke.mockReset();
});

describe("triggerLabel", () => {
  it("maps known trigger ids to readable names", () => {
    expect(triggerLabel("jira.issue.field.changed")).toBe("Field changed");
    expect(triggerLabel("jira.jql.scheduled")).toBe("Scheduled (JQL)");
  });

  it("degrades an unknown id to something readable rather than showing the raw namespace", () => {
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

describe("analyzeExportFile", () => {
  it("derives a storable analysis document from a real export shape", async () => {
    const doc = await analyzeExportFile(exportFile({ cloud: true, rules: [RULE] }));

    expect(doc).toMatchObject({ schemaVersion: 1, source: "automation-rules-202608060201.json" });
    expect(doc.estate).toMatchObject({ ruleCount: 1, enabledCount: 1, disabledCount: 0 });
    // The rule triggers on one field and writes another, so both are counted.
    expect(doc.estate.fieldsReferenced).toBe(2);
  });

  it("rejects a file that is not JSON, naming the fix", async () => {
    const bad = new File(["<html>not json</html>"], "wrong.json", { type: "application/json" });
    await expect(analyzeExportFile(bad)).rejects.toThrow(/not valid JSON.*Export the rules again/s);
  });

  it("rejects valid JSON that is not a rule export", async () => {
    await expect(analyzeExportFile(exportFile({ something: "else" }))).rejects.toThrow(/no rules in it/);
  });

  it("rejects an export with an empty rule list rather than storing an empty estate", async () => {
    await expect(analyzeExportFile(exportFile({ rules: [] }))).rejects.toThrow(/no rules in it/);
  });
});

describe("AutomationTab", () => {
  it("shows a loading state before the resolver answers", () => {
    invoke.mockReturnValue(new Promise(() => {}));
    render(<AutomationTab />);
    expect(screen.getByText(/loading automation insights/i)).toBeInTheDocument();
  });

  // "Never measured" and "measured, nothing wrong" are different claims. Rendering zeroes
  // for the first would assert the site is clean on no evidence.
  it("distinguishes an unbuilt analysis from a clean one", async () => {
    invoke.mockResolvedValue({ available: false, reason: "no-analysis" });
    render(<AutomationTab />);
    expect(await screen.findByText(/no automation analysis yet/i)).toBeInTheDocument();
    expect(screen.queryByText("1,477")).not.toBeInTheDocument();
  });

  it("surfaces a resolver failure instead of rendering an empty estate", async () => {
    invoke.mockRejectedValue(new Error("kvs exploded"));
    render(<AutomationTab />);
    expect(await screen.findByText(/could not load automation insights/i)).toBeInTheDocument();
    expect(screen.getByText(/kvs exploded/)).toBeInTheDocument();
  });

  it("renders the estate headline numbers", async () => {
    invoke.mockResolvedValue(analysis());
    render(<AutomationTab />);
    expect(await screen.findByText("1,477")).toBeInTheDocument();
    expect(screen.getByText("874")).toBeInTheDocument();
    expect(screen.getByText("603")).toBeInTheDocument();
    expect(screen.getByText("735")).toBeInTheDocument();
  });

  it("flags a heavily disabled estate as worth attention", async () => {
    invoke.mockResolvedValue(analysis());
    const { container } = render(<AutomationTab />);
    await screen.findByText("603");
    expect(screen.getByText("41% of the estate")).toBeInTheDocument();
    expect(container.querySelector(".ui-stat--warning, .ui-stat-tile--warning, [class*='warning']")).toBeTruthy();
  });

  it("lists cascade paths and calls out self-triggering rules separately", async () => {
    invoke.mockResolvedValue(analysis());
    const { container } = render(<AutomationTab />);
    expect(await screen.findByText(/Writer → Listener/)).toBeInTheDocument();
    expect(screen.getByText(/Loopy rule writes and triggers on this field/)).toBeInTheDocument();

    // Scoped to the list: "self-triggering" also appears in the panel's description, and a
    // bare getByText would match that instead of the badge on the row.
    const rows = container.querySelectorAll(".automation-cascades__row");
    expect(rows).toHaveLength(2);
    expect(rows[1].textContent).toContain("Self-triggering");
    expect(rows[0].textContent).toContain("Cascade");
  });

  it("says so when no rule can cascade, rather than showing an empty list", async () => {
    invoke.mockResolvedValue(analysis({ cascades: [], cascadesTotal: 0, selfTriggeringTotal: 0 }));
    render(<AutomationTab />);
    expect(await screen.findByText(/no rule writes a field that another rule triggers on/i)).toBeInTheDocument();
  });

  it("reports the true total when the stored cascade list is truncated", async () => {
    invoke.mockResolvedValue(analysis({ cascadesTotal: 1457 }));
    render(<AutomationTab />);
    expect(await screen.findByText(/showing 2 of 1,457 cascade paths/i)).toBeInTheDocument();
  });

  it("reports the true total when the findings list is truncated", async () => {
    invoke.mockResolvedValue(analysis({ findingsTotal: 468 }));
    render(<AutomationTab />);
    expect(await screen.findByText(/showing 2 of 468 rules with findings/i)).toBeInTheDocument();
  });

  it("renders each finding with a readable risk label rather than a code", async () => {
    invoke.mockResolvedValue(analysis());
    render(<AutomationTab />);
    expect(await screen.findByText("Credential stored in plaintext")).toBeInTheDocument();
    expect(screen.queryByText("embedded-credential")).not.toBeInTheDocument();
  });

  it("shows trigger type and project scope on each finding", async () => {
    invoke.mockResolvedValue(analysis());
    render(<AutomationTab />);
    await screen.findByText("Alexandria - Send to Approval");
    expect(screen.getByText("Field changed · 2 projects")).toBeInTheDocument();
    expect(screen.getByText("Scheduled (JQL) · site-wide · disabled")).toBeInTheDocument();
  });

  it("filters findings by severity", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue(analysis());
    render(<AutomationTab />);
    await screen.findByText("Alexandria - Send to Approval");

    await user.selectOptions(screen.getByLabelText(/filter by severity/i), "high");

    expect(screen.getByText("Alexandria - Send to Approval")).toBeInTheDocument();
    expect(screen.queryByText("Old cleanup rule")).not.toBeInTheDocument();
  });

  it("filters findings by rule name", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue(analysis());
    render(<AutomationTab />);
    await screen.findByText("Alexandria - Send to Approval");

    await user.type(screen.getByLabelText(/search rule names/i), "cleanup");

    expect(screen.queryByText("Alexandria - Send to Approval")).not.toBeInTheDocument();
    expect(screen.getByText("Old cleanup rule")).toBeInTheDocument();
  });

  it("distinguishes a filter with no matches from an estate with no findings", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue(analysis());
    render(<AutomationTab />);
    await screen.findByText("Alexandria - Send to Approval");

    await user.type(screen.getByLabelText(/search rule names/i), "zzzznomatch");
    expect(screen.getByText(/no rules match this filter/i)).toBeInTheDocument();

    invoke.mockResolvedValue(analysis({ findings: [], findingsTotal: 0 }));
    render(<AutomationTab />);
    await waitFor(() => expect(screen.getByText(/^No findings\.$/)).toBeInTheDocument());
  });

  it("labels trigger types readably in the trigger mix", async () => {
    invoke.mockResolvedValue(analysis());
    render(<AutomationTab />);
    expect(await screen.findByText("Field changed")).toBeInTheDocument();
    expect(screen.getByText("Scheduled (JQL)")).toBeInTheDocument();
  });

  it("requests the analysis exactly once", async () => {
    invoke.mockResolvedValue(analysis());
    render(<AutomationTab />);
    await screen.findByText("1,477");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("getAutomationInsights", {});
  });

  describe("importing an export", () => {
    it("offers the import control from the empty state", async () => {
      invoke.mockResolvedValue({ available: false, reason: "no-analysis" });
      render(<AutomationTab />);
      expect(await screen.findByRole("button", { name: /import rule export/i })).toBeInTheDocument();
    });

    it("says the rules stay in the browser, because that is the reason it is safe", async () => {
      invoke.mockResolvedValue({ available: false, reason: "no-analysis" });
      render(<AutomationTab />);
      expect(await screen.findByText(/never leave this page/i)).toBeInTheDocument();
    });

    // The whole point of analyzing client-side: the 10 MB export must not cross invoke().
    it("sends the derived analysis, not the raw export", async () => {
      const user = userEvent.setup();
      invoke.mockResolvedValueOnce({ available: false, reason: "no-analysis" });
      invoke.mockResolvedValueOnce({ saved: true });
      invoke.mockResolvedValueOnce(analysis());

      const { container } = render(<AutomationTab />);
      await screen.findByRole("button", { name: /import rule export/i });

      await user.upload(container.querySelector("input[type=file]"), exportFile({ rules: [RULE] }));

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("saveAutomationAnalysis", expect.any(Object)));
      const [, payload] = invoke.mock.calls.find((c) => c[0] === "saveAutomationAnalysis");
      expect(payload.analysis.schemaVersion).toBe(1);
      expect(payload.analysis).not.toHaveProperty("rules");
      expect(JSON.stringify(payload)).not.toContain("jira.issue.edit");
    });

    it("reloads the insights after a successful import", async () => {
      const user = userEvent.setup();
      invoke.mockResolvedValueOnce({ available: false, reason: "no-analysis" });
      invoke.mockResolvedValueOnce({ saved: true });
      invoke.mockResolvedValueOnce(analysis());

      const { container } = render(<AutomationTab />);
      await screen.findByRole("button", { name: /import rule export/i });

      await user.upload(container.querySelector("input[type=file]"), exportFile({ rules: [RULE] }));

      expect(await screen.findByText("1,477")).toBeInTheDocument();
    });

    it("shows the parse error against the control and keeps the empty state usable", async () => {
      const user = userEvent.setup();
      invoke.mockResolvedValue({ available: false, reason: "no-analysis" });

      const { container } = render(<AutomationTab />);
      await screen.findByRole("button", { name: /import rule export/i });

      await user.upload(container.querySelector("input[type=file]"), exportFile({ notRules: true }));

      expect(await screen.findByText(/no rules in it/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /import rule export/i })).toBeEnabled();
      expect(invoke).not.toHaveBeenCalledWith("saveAutomationAnalysis", expect.anything());
    });

    it("surfaces a save failure rather than pretending the import worked", async () => {
      const user = userEvent.setup();
      invoke.mockResolvedValueOnce({ available: false, reason: "no-analysis" });
      invoke.mockRejectedValueOnce(new Error("kvs write refused"));

      const { container } = render(<AutomationTab />);
      await screen.findByRole("button", { name: /import rule export/i });

      await user.upload(container.querySelector("input[type=file]"), exportFile({ rules: [RULE] }));

      expect(await screen.findByText(/kvs write refused/)).toBeInTheDocument();
    });

    it("offers a re-import once an analysis exists", async () => {
      invoke.mockResolvedValue(analysis());
      render(<AutomationTab />);
      expect(await screen.findByRole("button", { name: /re-import export/i })).toBeInTheDocument();
    });
  });
});
