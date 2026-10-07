import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { AutomationProbePanel, AssetsProbePanel, GlobalPermissionsProbePanel, ConfigTab, ScreenCostProbePanel } from "./ConfigTab";
import { DEFAULT_THRESHOLDS, DEFAULT_MACRO_ACCESS, DEFAULT_AUTOMATION_STALE_AFTER_DAYS } from "../admin-defaults";

// ConfigTab had no test file, which is how a panel calling an unimported `invoke` reached
// staging: nothing ever rendered it. The first test here is the one that would have caught
// it -- rendering the component at all is most of the value.

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

const probeResult = (over = {}) => ({
  projectId: "10000",
  reachable: [],
  results: [
    { scope: "global", path: "/rest/cb-automation/latest/project/GLOBAL/rule", status: 401, ok: false, looksLikeRules: false, sample: "scope does not match" },
    { scope: "project", path: "/rest/cb-automation/latest/project/10000/rule", status: 404, ok: false, looksLikeRules: false, sample: "not found" },
  ],
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("AssetsProbePanel", () => {
  test("renders the probe button and, on success, names the workspace and reachable endpoints", async () => {
    invoke.mockResolvedValue({
      assetsEnabled: true,
      workspaceId: "ws-abc",
      reachable: ["schemas", "objectTypes"],
      results: [
        { step: "workspace", via: "site", path: "/rest/servicedeskapi/assets/workspace", status: 200, ok: true, sample: "{}" },
        { step: "schemas", via: "stargate", path: "https://api.atlassian.com/jsm/assets/workspace/ws-abc/v1/objectschema/list", status: 200, ok: true, looksLikeAssets: true, sample: "[]" },
      ],
    });
    render(<AssetsProbePanel />);
    await userEvent.click(screen.getByRole("button", { name: /Probe Assets endpoints/i }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("probeAssetsApi", {}));
    expect(await screen.findByText(/Assets is reachable/i)).toBeInTheDocument();
    expect(screen.getByText("ws-abc")).toBeInTheDocument();
  });

  test("shows the reason when Assets is not reachable", async () => {
    invoke.mockResolvedValue({
      assetsEnabled: false,
      workspaceId: null,
      reason: "The workspace endpoint did not answer — Assets needs JSM Premium/Enterprise.",
      reachable: [],
      results: [{ step: "workspace", via: "site", path: "/rest/servicedeskapi/assets/workspace", status: 404, ok: false, sample: "" }],
    });
    render(<AssetsProbePanel />);
    await userEvent.click(screen.getByRole("button", { name: /Probe Assets endpoints/i }));

    expect(await screen.findByText(/Assets needs JSM Premium/i)).toBeInTheDocument();
  });

  test("surfaces a resolver failure without breaking the panel", async () => {
    invoke.mockRejectedValue(new Error("boom"));
    render(<AssetsProbePanel />);
    await userEvent.click(screen.getByRole("button", { name: /Probe Assets endpoints/i }));
    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Probe Assets endpoints/i })).toBeEnabled();
  });
});

describe("GlobalPermissionsProbePanel", () => {
  test("reports the catalog is readable but grant enumeration is not available", async () => {
    invoke.mockResolvedValue({
      catalogAvailable: true,
      globalPermissionKeys: ["ADMINISTER", "SYSTEM_ADMIN"],
      grantEnumerationAvailable: false,
      rows: [
        { path: "/rest/api/3/permissions", ok: true, status: 200, note: "The permission catalog — definitions only, no holders" },
      ],
    });
    render(<GlobalPermissionsProbePanel />);
    await userEvent.click(screen.getByRole("button", { name: /Probe global-permissions API/i }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("probeGlobalPermissions", {}));
    expect(await screen.findByText(/2 global permissions defined/i)).toBeInTheDocument();
    expect(screen.getByText(/blocked on that gap/i)).toBeInTheDocument();
  });
});

describe("AutomationProbePanel", () => {
  test("renders without crashing and offers the probe", () => {
    render(<AutomationProbePanel />);
    expect(screen.getByRole("button", { name: /Probe automation endpoints/i })).toBeInTheDocument();
  });

  test("calls the resolver and lists every endpoint it tried", async () => {
    invoke.mockResolvedValue(probeResult());
    render(<AutomationProbePanel />);

    await userEvent.click(screen.getByRole("button", { name: /Probe automation endpoints/i }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("probeAutomationApi", {}));
    expect(await screen.findByText(/project\/GLOBAL\/rule/)).toBeInTheDocument();
    expect(screen.getByText(/project\/10000\/rule/)).toBeInTheDocument();
  });

  test("says extraction is impossible when nothing returned usable rules", async () => {
    invoke.mockResolvedValue(probeResult());
    render(<AutomationProbePanel />);

    await userEvent.click(screen.getByRole("button", { name: /Probe automation endpoints/i }));

    expect(await screen.findByText(/No endpoint returned usable rule data/i)).toBeInTheDocument();
  });

  test("reports extraction as possible only when a body looked like rules", async () => {
    invoke.mockResolvedValue(probeResult({
      reachable: ["/rest/cb-automation/latest/project/GLOBAL/rule"],
      results: [{
        scope: "global", path: "/rest/cb-automation/latest/project/GLOBAL/rule",
        status: 200, ok: true, looksLikeRules: true, sample: '{"rules":[{"id":1}]}',
      }],
    }));
    render(<AutomationProbePanel />);

    await userEvent.click(screen.getByRole("button", { name: /Probe automation endpoints/i }));

    expect(await screen.findByText(/1 endpoint returned usable rule data/i)).toBeInTheDocument();
  });

  // A 200 carrying an HTML login page is not usable rule data. Reporting it as reachable
  // would tell someone to build an extractor on an endpoint that returns nothing useful.
  test("does not call a 200 reachable when the body is not rules", async () => {
    invoke.mockResolvedValue(probeResult({
      reachable: [],
      results: [{
        scope: "global", path: "/rest/cb-automation/latest/rule",
        status: 200, ok: true, looksLikeRules: false, sample: "<html>login</html>",
      }],
    }));
    render(<AutomationProbePanel />);

    await userEvent.click(screen.getByRole("button", { name: /Probe automation endpoints/i }));

    expect(await screen.findByText(/No endpoint returned usable rule data/i)).toBeInTheDocument();
  });

  // A diagnostic that breaks the page it runs on is worse than no diagnostic.
  test("surfaces a resolver failure without breaking the panel", async () => {
    invoke.mockRejectedValue(new Error("resolver exploded"));
    render(<AutomationProbePanel />);

    await userEvent.click(screen.getByRole("button", { name: /Probe automation endpoints/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/resolver exploded/i);
    expect(screen.getByRole("button", { name: /Probe automation endpoints/i })).toBeEnabled();
  });

  test("disables the button while a probe is in flight", async () => {
    let resolveProbe;
    invoke.mockReturnValue(new Promise((resolve) => { resolveProbe = resolve; }));
    render(<AutomationProbePanel />);

    await userEvent.click(screen.getByRole("button", { name: /Probe/i }));
    expect(screen.getByRole("button", { name: /Probing/i })).toBeDisabled();

    resolveProbe(probeResult());
    await waitFor(() => expect(screen.getByRole("button", { name: /Probe automation endpoints/i })).toBeEnabled());
  });
});

// ── Areas ──────────────────────────────────────────────────────────────────
//
// The tab was a single scroll of five stacked sections. It is now four areas behind a
// rail, which means two things can regress that could not before: a pane can fail to
// render, and the save bar can appear where it makes no sense.

describe("ConfigTab — areas", () => {
  const cfg = () => ({
    readOnlyMode: false,
    apiConcurrency: 4,
    autoSnapshotEnabled: false,
    autoSnapshotFrequency: "daily",
    governanceThresholds: { ...DEFAULT_THRESHOLDS },
    macroAccess: { ...DEFAULT_MACRO_ACCESS },
  });

  test("opens on Access and shows only that area", () => {
    render(<ConfigTab config={cfg()} onSave={vi.fn()} saving={false} />);

    expect(screen.getByRole("heading", { name: "Access", level: 2 })).toBeInTheDocument();
    expect(screen.getByText(/Read-only mode/i)).toBeInTheDocument();
    // Governance rules live in another pane and must not be mounted alongside it.
    expect(screen.queryByText(/High-impact field/i)).not.toBeInTheDocument();
  });

  // Read-only mode refuses admin builds and scans too. The hint used to say admins could
  // still run jobs, which sent people looking for a bug when a build was refused.
  test("describes read-only mode as freezing admin work too", () => {
    render(<ConfigTab config={cfg()} onSave={vi.fn()} saving={false} />);
    expect(screen.getByText(/admins included/i)).toBeInTheDocument();
    expect(screen.queryByText(/Admins can still run jobs/i)).not.toBeInTheDocument();
  });

  test("every area renders when selected", async () => {
    render(<ConfigTab config={cfg()} onSave={vi.fn()} saving={false} />);

    for (const [label, marker] of [
      ["Scanning", /Scan concurrency/i],
      ["Governance rules", /High-impact field/i],
      ["Diagnostics", /Probe automation endpoints/i],
    ]) {
      await userEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
      expect(screen.getByText(marker)).toBeInTheDocument();
    }
  });

  test("groups the nine rules under Risk, Cleanup and Standardize", async () => {
    render(<ConfigTab config={cfg()} onSave={vi.fn()} saving={false} />);
    await userEvent.click(screen.getByRole("button", { name: /Governance rules/ }));

    for (const group of ["Risk", "Cleanup", "Standardize"]) {
      expect(screen.getByText(group, { selector: ".admin-config-section__header, .admin-config-section__header *" }))
        .toBeInTheDocument();
    }
  });

  test("hides the save bar on Diagnostics, which changes nothing", async () => {
    render(<ConfigTab config={cfg()} onSave={vi.fn()} saving={false} />);
    expect(screen.getByRole("button", { name: /Save configuration/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Diagnostics/ }));
    expect(screen.queryByRole("button", { name: /Save configuration/i })).not.toBeInTheDocument();
  });

  test("reports saved state until something is edited", async () => {
    render(<ConfigTab config={cfg()} onSave={vi.fn()} saving={false} />);
    expect(screen.getByText("All changes saved")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("switch", { name: /Read-only mode/i }));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });
});

// ── Copy matches the rule it describes ─────────────────────────────────────
//
// The Config tab told admins a field was "added to N or more project screens". The rule
// reads broadScopeMinProjects, which counts projects a field's CONTEXT covers -- the app
// holds no screen data at all. The sentence described evidence never gathered.
//
// These assertions are what stops the words and the rule drifting apart again. If the
// screen inventory later repoints this rule at real screen reachability, this test should
// be updated in the same commit -- which is the point.

describe("ConfigTab — copy describes the rule it controls", () => {
  const cfg = () => ({
    readOnlyMode: false, apiConcurrency: 4,
    autoSnapshotEnabled: false, autoSnapshotFrequency: "daily",
    governanceThresholds: { ...DEFAULT_THRESHOLDS },
    macroAccess: { ...DEFAULT_MACRO_ACCESS },
  });

  async function openRules() {
    render(<ConfigTab config={cfg()} onSave={vi.fn()} saving={false} />);
    await userEvent.click(screen.getByRole("button", { name: /Governance rules/ }));
  }

  test("no rule claims screen knowledge the app does not have", async () => {
    await openRules();
    const pane = document.body.textContent;
    expect(pane).not.toMatch(/project screens/i);
    expect(pane).not.toMatch(/active screens/i);
  });

  test("the configured-but-unused rule describes contexts and projects", async () => {
    await openRules();
    const rule = screen.getByText(/Configured but unused/i).closest(".admin-threshold-rule");
    expect(rule.textContent).toMatch(/context covers/i);
    expect(rule.textContent).toMatch(/or more projects/i);
    // And still edits the threshold it names.
    expect(rule.querySelector("input")).toHaveValue(DEFAULT_THRESHOLDS.broadScopeMinProjects);
  });

  // Not a tolerance and not a target band: this one is measured in days and it gates whether
  // an answer is given at all, rather than how a rate is scored.
  describe("the automation staleness threshold", () => {
    test("is tunable, and says what passing it costs", async () => {
      await openRules();
      const rule = screen.getByText(/Analysis staleness/i).closest(".admin-threshold-rule");

      expect(rule.querySelector("input")).toHaveValue(DEFAULT_AUTOMATION_STALE_AFTER_DAYS);
      expect(rule.textContent).toMatch(/degrades to/i);
      expect(rule.textContent).toMatch(/unknown/i);
    });

    test("saves the edited value", async () => {
      const onSave = vi.fn();
      render(<ConfigTab config={cfg()} onSave={onSave} saving={false} />);
      await userEvent.click(screen.getByRole("button", { name: /Governance rules/ }));

      const input = screen.getByText(/Analysis staleness/i).closest(".admin-threshold-rule").querySelector("input");
      // Set rather than cleared-and-typed: clearing a number input fires a change with an
      // empty value, which InlineThresholdInput floors to `min`, and the typed digits then
      // append to that instead of replacing it.
      fireEvent.change(input, { target: { value: "21" } });
      await userEvent.click(screen.getByRole("button", { name: /^Save/ }));

      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ automationStaleAfterDays: 21 }));
    });

    test("the frontend default matches the backend's", async () => {
      // Two literals in two bundles. They only stay equal because this asserts it.
      const { DEFAULT_ANALYSIS_STALE_AFTER_DAYS } = await import("../../../src/lib/automation-analysis.js");
      expect(DEFAULT_AUTOMATION_STALE_AFTER_DAYS).toBe(DEFAULT_ANALYSIS_STALE_AFTER_DAYS);
    });
  });
});

describe("ScreenCostProbePanel endpoint table", () => {
  const authFailure = (endpoints) => ({
    ok: false,
    error: 'Jira request failed (401): {"code":401,"message":"Unauthorized; scope does not match"}',
    hint: "Authorization failure. The table below shows which screen endpoints accept the app's scopes.",
    endpoints,
  });

  async function runProbe(endpoints) {
    invoke.mockResolvedValue(authFailure(endpoints));
    render(<ScreenCostProbePanel />);
    await userEvent.click(screen.getByRole("button", { name: /Measure screen fetch cost/i }));
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
  }

  test("renders a row per probed endpoint, keeping the breakdown on failure", async () => {
    await runProbe([
      { label: "screens", scope: "read:screen:jira", path: "/rest/api/3/screens", status: 401, scopeAccepted: false },
      { label: "screen schemes", scope: "read:screen-scheme:jira", path: "/rest/api/3/screenscheme", status: 200, scopeAccepted: true },
    ]);

    expect(screen.getByText("screens")).toBeInTheDocument();
    expect(screen.getByText("screen schemes")).toBeInTheDocument();
    expect(screen.getByText("401")).toBeInTheDocument();
  });

  // The bug this guards: `scopeAccepted ? "yes" : "no"` renders an unmeasured row as a
  // rejection, which is the one reading a diagnostic must never invent.
  test("an unresolved row reads as unknown, not as rejected", async () => {
    await runProbe([
      { label: "screens", scope: "read:screen:jira", path: "/rest/api/3/screens", status: 401, scopeAccepted: false },
      {
        label: "tab fields (real ids)",
        scope: "—",
        path: "(tab fields (real ids))",
        status: null,
        scopeAccepted: null,
        sample: "Screen 10500 reported no tabs, so the field probe has no real tab id.",
      },
    ]);

    const unresolved = screen.getByText("tab fields (real ids)").closest("tr");
    const cells = [...unresolved.querySelectorAll("td")].map((c) => c.textContent);
    expect(cells).not.toContain("no");
    expect(cells.filter((c) => c === "—").length).toBeGreaterThanOrEqual(2);
  });

  test("says why a row could not be measured", async () => {
    await runProbe([
      {
        label: "real-id re-probe",
        scope: "—",
        path: "(real-id re-probe)",
        status: null,
        scopeAccepted: null,
        sample: "Could not read screen schemes: 401 nope",
      },
    ]);

    // A dash with no explanation reads as a bug in the probe rather than a fact about
    // the site.
    expect(screen.getByText(/Could not read screen schemes/i)).toBeInTheDocument();
  });

  test("distinguishes real-id rows from placeholder-id rows in the copy", async () => {
    await runProbe([
      { label: "screens", scope: "read:screen:jira", path: "/rest/api/3/screens", status: 401, scopeAccepted: false },
    ]);

    expect(screen.getByText(/real id/i)).toBeInTheDocument();
    expect(screen.getByText(/404 is a pass/i)).toBeInTheDocument();
  });
});

describe("ConfigTab — remediation hierarchy", () => {
  const cfg = () => ({
    readOnlyMode: false, apiConcurrency: 4, autoSnapshotEnabled: false, autoSnapshotFrequency: "daily",
    governanceThresholds: { ...DEFAULT_THRESHOLDS }, macroAccess: { ...DEFAULT_MACRO_ACCESS },
    remediation: { projectKey: "ATLASDEV", epicIssueType: "Epic", taskIssueType: "Task", hierarchyEnabled: false, rootIssueType: "Product", initiativeIssueType: "Initiative" },
  });

  test("the two issue types appear only once the hierarchy is switched on, and save with it", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<ConfigTab config={cfg()} onSave={onSave} saving={false} />);
    const toggle = await screen.findByRole("switch", { name: "Place epics under quarterly initiatives" });
    expect(screen.queryByText("Top-level issue type")).not.toBeInTheDocument();

    await user.click(toggle);
    expect(screen.getByText("Top-level issue type")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Product")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Initiative")).toBeInTheDocument();
  });
});
