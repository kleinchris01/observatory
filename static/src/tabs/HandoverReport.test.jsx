import React from "react";
import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HandoverReport } from "./HandoverReport";

const report = {
  available: true,
  person: { accountId: "acc-1", displayName: "Pat Leaver", active: true, inRoster: true },
  summary: "Removing this account deletes 1 filter, breaking 1 board. Hand over 23 open issues assigned to them.",
  beforeRemoval: 3,
  sections: [
    {
      key: "deleted",
      title: "Deleted with the account",
      status: "action",
      count: 1,
      why: "Jira deletes a saved filter or dashboard when its owner's account is removed.",
      action: "Change the owner of each one before the account is removed.",
      items: [
        {
          kind: "filter",
          id: "10",
          name: "Sprint scope",
          url: "https://acme.atlassian.net/issues/?filter=10",
          detail: "Saved filter",
        },
      ],
      reason: null,
    },
    {
      key: "breaks",
      title: "Breaks when those filters go",
      status: "action",
      count: 1,
      why: "A board or gadget built on a deleted filter stops working.",
      action: "Reassigning the filters above prevents all of these.",
      items: [
        {
          kind: "board",
          id: "5",
          name: "Team board",
          url: null,
          projectKey: "TEAM",
          detail: 'Board in TEAM, built on "Sprint scope"',
        },
      ],
      reason: null,
    },
    {
      key: "work",
      title: "Work routed to them",
      status: "action",
      count: 1,
      why: "Work keeps arriving for this account.",
      action: "Reassign the open issues.",
      items: [
        {
          kind: "issues",
          id: "open-assigned",
          name: "23 open issues",
          url: null,
          detail: "Assigned to them and not done",
          jql: 'assignee = "acc-1" AND statusCategory != Done',
        },
      ],
      reason: "Could not read projects they lead; check those by hand.",
    },
    {
      key: "rules",
      title: "Automation rules they own",
      status: "unmeasured",
      count: null,
      why: "Owners get error notifications.",
      action: "",
      items: [],
      reason: "Rule ownership needs a rule export that carries account ids.",
    },
    {
      key: "named",
      title: "Issues that name them",
      status: "clear",
      count: 0,
      why: "Values stay.",
      action: "",
      items: [],
      reason: null,
    },
  ],
};

describe("HandoverReport", () => {
  test("loads on request, then shows the summary and each section in order", async () => {
    const load = vi.fn().mockResolvedValueOnce(report);
    render(<HandoverReport accountId="acc-1" siteOrigin="https://acme.atlassian.net" load={load} />);

    await userEvent.click(screen.getByRole("button", { name: "Prepare handover report" }));

    expect(load).toHaveBeenCalledWith("getHandoverReport", { accountId: "acc-1" });
    expect(await screen.findByText("Handover report for Pat Leaver")).toBeInTheDocument();
    expect(screen.getByText(report.summary)).toBeInTheDocument();
    expect(screen.getByText("3 items to deal with before the account is removed.")).toBeInTheDocument();
    const titles = screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
    expect(titles.slice(1).map((t) => t.split(" ").slice(0, 2).join(" "))).toEqual([
      "Deleted with",
      "Breaks when",
      "Work routed",
      "Automation rules",
      "Issues that",
    ]);
  });

  test("links each item to Jira: its own URL, the board, and a search for the open issues", async () => {
    render(
      <HandoverReport
        accountId="acc-1"
        siteOrigin="https://acme.atlassian.net"
        load={vi.fn().mockResolvedValueOnce(report)}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Prepare handover report" }));

    expect(await screen.findByRole("link", { name: "Sprint scope" })).toHaveAttribute(
      "href",
      "https://acme.atlassian.net/issues/?filter=10",
    );
    expect(screen.getByRole("link", { name: "Team board" }).getAttribute("href")).toContain("TEAM");
    expect(screen.getByRole("link", { name: "23 open issues" }).getAttribute("href")).toContain(
      encodeURIComponent('assignee = "acc-1"'),
    );
  });

  test("says what could not be measured instead of showing an empty list", async () => {
    render(<HandoverReport accountId="acc-1" load={vi.fn().mockResolvedValueOnce(report)} />);
    await userEvent.click(screen.getByRole("button", { name: "Prepare handover report" }));

    expect(await screen.findByText("Not measured")).toBeInTheDocument();
    expect(screen.getByText(/Rule ownership needs a rule export/)).toBeInTheDocument();
    expect(screen.getByText("Could not read projects they lead; check those by hand.")).toBeInTheDocument();
    expect(screen.getByText("Nothing")).toBeInTheDocument();
  });

  test("without a site origin, items without their own URL are plain text", async () => {
    render(<HandoverReport accountId="acc-1" load={vi.fn().mockResolvedValueOnce(report)} />);
    await userEvent.click(screen.getByRole("button", { name: "Prepare handover report" }));

    expect(await screen.findByText("Team board")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Team board" })).toBeNull();
  });

  test("asks for a roster build when there is none", async () => {
    render(
      <HandoverReport
        accountId="acc-1"
        load={vi.fn().mockResolvedValueOnce({ available: false, reason: "no-roster", sections: [] })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Prepare handover report" }));
    expect(await screen.findByText(/Build the people roster/)).toBeInTheDocument();
  });

  test("shows a failure and lets the admin try again", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("Jira timed out")).mockResolvedValueOnce(report);
    render(<HandoverReport accountId="acc-1" load={load} />);

    await userEvent.click(screen.getByRole("button", { name: "Prepare handover report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Jira timed out");

    await userEvent.click(screen.getByRole("button", { name: "Prepare handover report" }));
    expect(await screen.findByText("Handover report for Pat Leaver")).toBeInTheDocument();
  });
});
