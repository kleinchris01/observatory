import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { AutomationProbePanel } from "./ConfigTab";

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
