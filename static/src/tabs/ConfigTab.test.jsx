import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { AutomationProbePanel, ConfigTab } from "./ConfigTab";
import { DEFAULT_THRESHOLDS, DEFAULT_MACRO_ACCESS } from "../admin-defaults";

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
});
