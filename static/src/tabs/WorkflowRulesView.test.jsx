import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkflowRulesView, WorkflowRestrictionsView, WorkflowCatalogView } from "./WorkflowRulesView";

// The answer to "where is this field validated, between which statuses" and "which statuses
// lock editing to this group". Every test here guards the same thing from a different side:
// an empty list must only ever mean "looked and found nothing".

const ORIGIN = "https://acme.atlassian.net";
const GROUP_ID = "5a2c1b9e-0f3d-4c6a-9e1b-7d8f2a3c4b5e";

const rulePage = {
  available: true,
  total: 1,
  rules: [
    {
      workflowName: "Build Deviation WF",
      transition: {
        id: "21",
        name: "Approve",
        type: "DIRECTED",
        from: [{ id: "3", name: "In Review" }],
        to: { id: "4", name: "Approved" },
      },
      kind: "validator",
      key: "system:validate-field-value",
      label: "Field value check",
      summary: "fieldRequired",
      refs: [
        { type: "field", id: "customfield_15731", label: "Onsite Modification", missing: false },
        { type: "field", id: "customfield_404", label: null, missing: true },
      ],
    },
  ],
};

describe("WorkflowRulesView", () => {
  let load;
  beforeEach(() => {
    load = vi.fn().mockResolvedValue(rulePage);
  });

  test("shows the workflow, the transition, the statuses it runs between and what the rule names", async () => {
    render(<WorkflowRulesView siteOrigin={ORIGIN} load={load} />);

    expect(await screen.findByText("Approve")).toBeInTheDocument();
    expect(screen.getByText(/In Review/)).toBeInTheDocument();
    expect(screen.getByText(/Approved/)).toBeInTheDocument();
    expect(screen.getByText("Validator")).toBeInTheDocument();
    expect(screen.getByText("Field value check")).toBeInTheDocument();
    expect(screen.getByText("Onsite Modification")).toBeInTheDocument();
    expect(screen.getByText("customfield_404 (missing)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Build Deviation WF" }).getAttribute("href")).toContain(
      "workflowName=Build%20Deviation%20WF",
    );
  });

  test("searches by what a rule points at, debounced, and resets to the first page", async () => {
    const user = userEvent.setup();
    render(<WorkflowRulesView siteOrigin={ORIGIN} load={load} />);
    await screen.findByText("Approve");

    await user.type(screen.getByRole("searchbox"), "Onsite");
    await waitFor(() =>
      expect(load).toHaveBeenLastCalledWith(
        "getWorkflowRules",
        expect.objectContaining({ query: "Onsite", offset: 0 }),
      ),
    );
  });

  test("narrows by kind and to rules naming something missing", async () => {
    const user = userEvent.setup();
    render(<WorkflowRulesView siteOrigin={ORIGIN} load={load} />);
    await screen.findByText("Approve");

    await user.selectOptions(screen.getByLabelText("Kind"), "validator");
    await user.selectOptions(screen.getByLabelText("References"), "broken");
    await waitFor(() =>
      expect(load).toHaveBeenLastCalledWith(
        "getWorkflowRules",
        expect.objectContaining({ kind: "validator", brokenOnly: true }),
      ),
    );
  });

  test("arrives from the Overview finding already filtered to broken references", async () => {
    render(<WorkflowRulesView siteOrigin={ORIGIN} load={load} intent={{ view: "rules", filter: "broken" }} />);
    await waitFor(() =>
      expect(load).toHaveBeenCalledWith("getWorkflowRules", expect.objectContaining({ brokenOnly: true })),
    );
  });

  test("a snapshot that predates rule capture asks for a rebuild instead of showing nothing", async () => {
    load.mockResolvedValueOnce({ available: false, reason: "rules-not-read", rules: [], total: 0 });
    render(<WorkflowRulesView siteOrigin={ORIGIN} load={load} />);
    expect(await screen.findByText(/built before transition rules were captured/i)).toBeInTheDocument();
  });

  test("pages through a long list", async () => {
    const user = userEvent.setup();
    load.mockResolvedValue({ ...rulePage, total: 120 });
    render(<WorkflowRulesView siteOrigin={ORIGIN} load={load} />);
    await screen.findByText("Page 1 of 3");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(load).toHaveBeenLastCalledWith("getWorkflowRules", expect.objectContaining({ offset: 50 })),
    );
  });

  test("says what failed", async () => {
    load.mockRejectedValueOnce(new Error("boom"));
    render(<WorkflowRulesView siteOrigin={ORIGIN} load={load} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});

const restrictions = {
  available: true,
  total: 3,
  summary: { editLockedStatuses: 2, workflows: 2, missingHolders: 1 },
  restrictions: [
    {
      workflowName: "Build Deviation WF",
      ownerKind: "status",
      status: { id: "3", name: "In Review" },
      key: "jira.permission.edit.group",
      value: GROUP_ID,
      effect: "restrict-permission",
      permission: "edit",
      holderType: "group",
      holder: { type: "group", id: GROUP_ID, label: "Plant Engineers", missing: false },
      description: `Edit: only group ${GROUP_ID}`,
    },
    {
      workflowName: "Build Deviation WF",
      ownerKind: "status",
      status: { id: "4", name: "Approved" },
      key: "jira.issue.editable",
      value: "false",
      effect: "not-editable",
      permission: "edit",
      holderType: null,
      holder: null,
      description: "Issues cannot be edited in this status",
    },
    {
      workflowName: "Legacy WF",
      ownerKind: "status",
      status: { id: "5", name: "Closed" },
      key: "jira.permission.comment.group",
      value: "gone",
      effect: "restrict-permission",
      permission: "comment",
      holderType: "group",
      holder: { type: "group", id: "gone", label: null, missing: true },
      description: "Comment: only group gone",
    },
  ],
};

describe("WorkflowRestrictionsView", () => {
  test("names the status, the permission and the group that holds it", async () => {
    render(<WorkflowRestrictionsView siteOrigin={ORIGIN} load={vi.fn().mockResolvedValue(restrictions)} />);

    expect(await screen.findByText("Status: In Review")).toBeInTheDocument();
    expect(screen.getByText("Plant Engineers")).toBeInTheDocument();
    expect(screen.getByText("Not editable by anyone")).toBeInTheDocument();
    expect(screen.getByText("missing")).toBeInTheDocument();
    expect(screen.getByText("Statuses with editing locked").closest(".ui-stat")).toHaveTextContent("2");
    expect(screen.getByText("Holders that no longer exist").closest(".ui-stat")).toHaveClass("ui-stat--critical");
  });

  test("filters by permission and by group name", async () => {
    const user = userEvent.setup();
    render(<WorkflowRestrictionsView siteOrigin={ORIGIN} load={vi.fn().mockResolvedValue(restrictions)} />);
    await screen.findByText("Status: In Review");

    await user.selectOptions(screen.getByLabelText("Permission"), "comment");
    expect(screen.queryByText("Status: In Review")).not.toBeInTheDocument();
    expect(screen.getByText("Status: Closed")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Permission"), "all");
    await user.type(screen.getByRole("searchbox"), "plant");
    expect(screen.getByText("Status: In Review")).toBeInTheDocument();
    expect(screen.queryByText("Status: Approved")).not.toBeInTheDocument();
  });

  test("an estate with no restrictions says so in words", async () => {
    render(
      <WorkflowRestrictionsView
        load={vi
          .fn()
          .mockResolvedValue({
            ...restrictions,
            total: 0,
            restrictions: [],
            summary: { editLockedStatuses: 0, workflows: 0, missingHolders: 0 },
          })}
      />,
    );
    expect(await screen.findByText(/No workflow restricts editing/)).toBeInTheDocument();
  });

  test("no snapshot is not 'no restrictions'", async () => {
    render(
      <WorkflowRestrictionsView
        load={vi.fn().mockResolvedValue({ available: false, reason: "no-snapshot", restrictions: [] })}
      />,
    );
    expect(await screen.findByText(/No workflow inventory yet/)).toBeInTheDocument();
  });
});

const insights = {
  available: true,
  totals: { workflows: 3, teamManaged: 1, rules: 14, brokenRules: 1, brokenProperties: 0, inactive: 1 },
  workflows: [
    {
      name: "Build Deviation WF",
      scopeType: "GLOBAL",
      statusCount: 6,
      transitionCount: 9,
      ruleCount: 12,
      schemeCount: 2,
    },
    { name: "Old WF", scopeType: "GLOBAL", statusCount: 3, transitionCount: 2, ruleCount: 2, schemeCount: 0 },
    { name: "Team WF", scopeType: "PROJECT", statusCount: 3, transitionCount: 3, ruleCount: 0, schemeCount: 0 },
  ],
  inactive: [{ name: "Old WF", scopeType: "GLOBAL", schemeCount: 0 }],
  brokenRefs: [
    {
      type: "field",
      id: "customfield_404",
      workflowName: "Build Deviation WF",
      source: "rule",
      transitionId: "21",
      status: null,
      propKey: null,
    },
  ],
};

describe("WorkflowCatalogView", () => {
  test("lists every workflow with whether a project uses it", async () => {
    render(<WorkflowCatalogView siteOrigin={ORIGIN} load={vi.fn().mockResolvedValue(insights)} />);

    const list = await screen.findAllByRole("listitem");
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("inactive")).toBeInTheDocument();
    expect(screen.getByText("team-managed")).toBeInTheDocument();
    expect(screen.getByText("2 schemes")).toBeInTheDocument();
    expect(screen.getByText("1 broken")).toBeInTheDocument();
  });

  test("puts the broken references in their own panel", async () => {
    render(<WorkflowCatalogView siteOrigin={ORIGIN} load={vi.fn().mockResolvedValue(insights)} />);
    const panel = (await screen.findByText("References to things that no longer exist")).closest("section");
    expect(within(panel).getByText("customfield_404")).toBeInTheDocument();
    expect(within(panel).getByText("Transition 21")).toBeInTheDocument();
  });

  test("arrives from the Overview showing only inactive workflows", async () => {
    render(
      <WorkflowCatalogView
        siteOrigin={ORIGIN}
        load={vi.fn().mockResolvedValue(insights)}
        intent={{ filter: "inactive" }}
      />,
    );
    await screen.findByText("Old WF");
    expect(screen.queryByText("Team WF")).not.toBeInTheDocument();
    expect(screen.getByText(/^1 of 3/)).toBeInTheDocument();
  });

  test("asks for a rebuild when the snapshot has no rules", async () => {
    render(<WorkflowCatalogView load={vi.fn().mockResolvedValue({ available: false, reason: "rules-not-read" })} />);
    expect(await screen.findByText(/Rebuild it/)).toBeInTheDocument();
  });
});
