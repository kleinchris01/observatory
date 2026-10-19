import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { SecurityAlertBanner } from "./SecurityAlertBanner";

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

const signals = (over = {}) => ({
  ok: true,
  denials: {
    denials: 9,
    actors: 2,
    latestAt: new Date().toISOString(),
    windowMinutes: 60,
    threshold: 5,
    burst: true,
    ...over,
  },
});

describe("SecurityAlertBanner", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  test("shows a critical alert during a denial burst", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(signals());
    render(<SecurityAlertBanner onNavigate={vi.fn()} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("9 permission denials in the last 60 minutes, from 2 accounts.");
    expect(alert).toHaveTextContent("Every call was refused");
    expect(invoke).toHaveBeenCalledWith("getSecuritySignals");
  });

  test("uses the singular for one account", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(signals({ actors: 1 }));
    render(<SecurityAlertBanner onNavigate={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("from 1 account.");
  });

  test("renders nothing in a quiet hour", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(signals({ denials: 2, actors: 1, burst: false }));
    const { container } = render(<SecurityAlertBanner onNavigate={vi.fn()} />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  // Silence is not all-clear: a check that could not run says so.
  test("says so when the check is unavailable", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      ok: false,
      unavailable: "Recent permission denials could not be read just now.",
    });
    render(<SecurityAlertBanner onNavigate={vi.fn()} />);
    expect(await screen.findByRole("status")).toHaveTextContent("could not be read just now");
  });

  test("says so when the invoke itself fails", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("network"));
    render(<SecurityAlertBanner onNavigate={vi.fn()} />);
    expect(await screen.findByRole("status")).toHaveTextContent("could not be checked just now");
  });

  test("Review denials opens the audit log filtered to denials", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(signals());
    const onNavigate = vi.fn();
    render(<SecurityAlertBanner onNavigate={onNavigate} />);

    await userEvent.click(await screen.findByRole("button", { name: "Review denials" }));
    expect(onNavigate).toHaveBeenCalledWith("config", { area: "diagnostics", auditOutcome: "denied" });
  });
});
