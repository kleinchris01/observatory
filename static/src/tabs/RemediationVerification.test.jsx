import React from "react";
import { describe, test, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RemediationVerification } from "./RemediationVerification";

const verification = (over = {}) => ({
  checkedAt: "2026-10-14T09:30:00.000Z",
  labels: { "filter-ownership": "Filter ownership" },
  counts: { held: 3, regressed: 1, "fixed-open": 2, open: 4, superseded: 0, unverified: 1 },
  heldRate: 0.75,
  rows: [
    { issueKey: "ADMIN-2", verdict: "regressed", findingKey: "filter-ownership", itemId: "7", summary: "Reassign filter Orphaned", status: "Done", period: "2026-Q4" },
    { issueKey: "ADMIN-4", verdict: "fixed-open", findingKey: "filter-ownership", itemId: "9", summary: "Reassign filter Old", status: "To Do", period: "2026-Q4", assigneeName: "Sam" },
    { issueKey: "ADMIN-5", verdict: "fixed-open", findingKey: "filter-ownership", itemId: "10", summary: "Reassign filter Older", status: "In Progress", period: "2026-Q3" },
    { issueKey: "ADMIN-6", verdict: "held", findingKey: "filter-ownership", itemId: "11", summary: "Done right", status: "Done" },
  ],
  ...over,
});

function loader(apply = { applied: 1, results: [{ issueKey: "ADMIN-2", transitioned: true }] }) {
  return vi.fn(async (name) => (name === "getRemediationVerification" ? verification() : apply));
}

describe("RemediationVerification", () => {
  test("summarises what held, what regressed and what is fixed but open", async () => {
    render(<RemediationVerification load={loader()} />);

    expect(await screen.findByText("Fixes that held")).toBeInTheDocument();
    expect(screen.getByText("75% of closed tasks")).toBeInTheDocument();
    expect(screen.getByText("1 could not be checked")).toBeInTheDocument();
    expect(screen.getByText("Closed, but still flagged (1)")).toBeInTheDocument();
    expect(screen.getByText("Fixed, but still open (2)")).toBeInTheDocument();
    // Held tasks are counted, not listed for action.
    expect(screen.queryByText("Done right")).toBeNull();
  });

  test("links each ticket to Jira when the site is known", async () => {
    render(<RemediationVerification siteOrigin="https://acme.atlassian.net" load={loader()} />);
    expect(await screen.findByRole("link", { name: "ADMIN-2" })).toHaveAttribute("href", "https://acme.atlassian.net/browse/ADMIN-2");
  });

  // Nothing moves in Jira until the admin selects tickets and confirms on the page.
  test("reopens selected tickets only after an in-page confirmation", async () => {
    const load = loader();
    render(<RemediationVerification load={load} />);
    await screen.findByText("Closed, but still flagged (1)");

    const action = screen.getByRole("button", { name: "Reopen with evidence" });
    expect(action).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/ADMIN-2/));
    await userEvent.click(screen.getByRole("button", { name: "Reopen with evidence (1)" }));

    const dialog = screen.getByRole("alertdialog", { name: "Confirm the change in Jira" });
    expect(within(dialog).getByText(/Reopen 1 ticket in Jira, as you/)).toBeInTheDocument();
    expect(load).not.toHaveBeenCalledWith("applyRemediationVerification", expect.anything());

    await userEvent.click(within(dialog).getByRole("button", { name: "Reopen with evidence" }));
    expect(load).toHaveBeenCalledWith("applyRemediationVerification", { issueKeys: ["ADMIN-2"] });
    expect(await screen.findByText("1 ticket moved.")).toBeInTheDocument();
  });

  test("select all picks every ticket in its group, and cancel changes nothing", async () => {
    const load = loader();
    render(<RemediationVerification load={load} />);
    await screen.findByText("Fixed, but still open (2)");

    await userEvent.click(screen.getAllByLabelText("Select all")[1]);
    await userEvent.click(screen.getByRole("button", { name: "Close as fixed (2)" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(load).not.toHaveBeenCalledWith("applyRemediationVerification", expect.anything());
  });

  test("reports tickets Jira would not move, with the reason", async () => {
    const load = loader({ applied: 0, results: [{ issueKey: "ADMIN-2", transitioned: false, reason: "No transition from its current status leads to an open status." }] });
    render(<RemediationVerification load={load} />);
    await screen.findByText("Closed, but still flagged (1)");
    await userEvent.click(screen.getByLabelText(/ADMIN-2/));
    await userEvent.click(screen.getByRole("button", { name: "Reopen with evidence (1)" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Reopen with evidence" }));

    expect(await screen.findByText(/0 tickets moved\. ADMIN-2: No transition/)).toBeInTheDocument();
  });

  test("says so when there is nothing to act on, or no tasks at all", async () => {
    const quiet = vi.fn(async () => verification({ rows: [{ issueKey: "A-1", verdict: "held", findingKey: "f" }], counts: { held: 1 } }));
    const { unmount } = render(<RemediationVerification load={quiet} />);
    expect(await screen.findByText("Every closed task held, and no open task is already fixed.")).toBeInTheDocument();
    unmount();

    render(<RemediationVerification load={vi.fn(async () => verification({ rows: [], counts: {} }))} />);
    expect(await screen.findByText(/No remediation tasks yet/)).toBeInTheDocument();
  });

  test("shows a load failure", async () => {
    render(<RemediationVerification load={vi.fn().mockRejectedValueOnce(new Error("store down"))} />);
    expect(await screen.findByText("store down")).toBeInTheDocument();
  });
});
