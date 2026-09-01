import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { IssueTypesTab, HierarchyLevelPanel, SchemeCard } from "./IssueTypesTab";

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

const inventory = (over = {}) => ({
  neverBuilt: false,
  state: "ready",
  staleBuild: false,
  version: "v1",
  refreshedAt: new Date().toISOString(),
  totalTypes: 3,
  totalSchemes: 2,
  governance: {
    totalTypes: 3, subtaskTypes: 1, projectScopedTypes: 1, hierarchyLevels: 3,
    totalSchemes: 2, unusedSchemes: 1, orphanTypes: 0,
  },
  hierarchy: [
    { level: 1, label: "Epic", types: [{ id: "1", name: "Epic", subtask: false, hierarchyLevel: 1, scopeProjectId: null }] },
    { level: 0, label: "Base (Story, Task, Bug)", types: [{ id: "2", name: "Story", subtask: false, hierarchyLevel: 0, scopeProjectId: null }] },
    { level: -1, label: "Sub-task", types: [{ id: "3", name: "Sub-task", subtask: true, hierarchyLevel: -1, scopeProjectId: null }] },
  ],
  schemes: [
    {
      schemeId: "5", name: "Default Issue Type Scheme", description: "", defaultIssueTypeId: "2",
      isDefault: true, projectCount: 8,
      issueTypes: [
        { id: "1", name: "Epic", hierarchyLevel: 1, subtask: false, missing: false },
        { id: "2", name: "Story", hierarchyLevel: 0, subtask: false, missing: false },
      ],
      projects: [{ projectId: "10000", projectKey: "OBS", projectName: "Observatory" }],
    },
    {
      schemeId: "6", name: "Unused Scheme", description: "", defaultIssueTypeId: null,
      isDefault: false, projectCount: 0,
      issueTypes: [{ id: "999", name: null, hierarchyLevel: null, subtask: null, missing: true }],
      projects: [],
    },
  ],
  issueTypeScreenSchemes: [
    {
      itssId: "9", name: "Default ITSS", projectCount: 4,
      mappings: [
        { issueTypeId: "1", issueTypeName: "Epic", screenSchemeId: "5", isDefault: false },
        { issueTypeId: "default", issueTypeName: "All unmapped types", screenSchemeId: "6", isDefault: true },
      ],
    },
  ],
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("HierarchyLevelPanel", () => {
  const level = {
    level: -1,
    label: "Sub-task",
    types: [
      { id: "3", name: "Sub-task", subtask: true, hierarchyLevel: -1, scopeProjectId: null },
      { id: "4", name: "Team Bug", subtask: false, hierarchyLevel: -1, scopeProjectId: "10000" },
    ],
  };

  test("labels a sub-task type and a project-scoped type distinctly", () => {
    render(<HierarchyLevelPanel level={level} search="" />);
    expect(screen.getByText("Sub-task", { selector: ".issue-type-row__name" })).toBeInTheDocument();
    expect(screen.getByText("Project-scoped")).toBeInTheDocument();
  });

  test("filters its types by the search term", () => {
    render(<HierarchyLevelPanel level={level} search="team" />);
    expect(screen.getByText("Team Bug")).toBeInTheDocument();
    expect(screen.queryByText("Sub-task", { selector: ".issue-type-row__name" })).not.toBeInTheDocument();
  });

  test("renders nothing when no type matches the search", () => {
    const { container } = render(<HierarchyLevelPanel level={level} search="zzz" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("SchemeCard", () => {
  test("shows membership in order, marking the default type", () => {
    render(<SchemeCard scheme={inventory().schemes[0]} />);
    expect(screen.getByText(/Story ·default/)).toBeInTheDocument();
    expect(screen.getByText("Default scheme")).toBeInTheDocument();
  });

  // A scheme allowing a type the catalog no longer contains is a finding, not noise.
  test("keeps and flags a member the catalog does not contain", () => {
    render(<SchemeCard scheme={inventory().schemes[1]} />);
    expect(screen.getByText(/#999 \(missing\)/)).toBeInTheDocument();
  });

  test("warns when no project uses the scheme", () => {
    render(<SchemeCard scheme={inventory().schemes[1]} />);
    expect(screen.getByText("0 projects")).toBeInTheDocument();
  });
});

describe("IssueTypesTab", () => {
  test("reports never-built rather than an empty catalog", async () => {
    invoke.mockResolvedValueOnce({ neverBuilt: true, state: "idle" });
    render(<IssueTypesTab />);
    expect(await screen.findByText(/No issue type inventory has been built yet/i)).toBeInTheDocument();
  });

  test("renders the governance stats and hierarchy breakdown", async () => {
    invoke.mockImplementation((fn) => {
      if (fn === "getIssueTypeInventory") return Promise.resolve(inventory());
      return Promise.resolve({});
    });
    render(<IssueTypesTab />);

    expect(await screen.findByText("Issue types")).toBeInTheDocument();
    // Orphan-types stat reads as success at 0.
    expect(screen.getByText("Orphan types")).toBeInTheDocument();
    // Unused schemes surfaced as a warning count.
    expect(screen.getByText("Unused schemes")).toBeInTheDocument();
  });

  test("shows a scheme's members after switching to the Schemes view", async () => {
    invoke.mockImplementation((fn) => {
      if (fn === "getIssueTypeInventory") return Promise.resolve(inventory());
      return Promise.resolve({});
    });
    render(<IssueTypesTab />);

    await screen.findByText("Issue types");
    await userEvent.click(screen.getByRole("button", { name: /^Schemes/ }));

    expect(await screen.findByText("Default Issue Type Scheme")).toBeInTheDocument();
    expect(screen.getByText(/Story ·default/)).toBeInTheDocument();
  });

  test("queues a build and reports it", async () => {
    invoke.mockImplementation((fn) => {
      if (fn === "getIssueTypeInventory") return Promise.resolve(inventory());
      if (fn === "buildIssueTypeInventory") return Promise.resolve({ queued: true });
      return Promise.resolve({});
    });
    render(<IssueTypesTab />);

    await screen.findByText("Issue types");
    await userEvent.click(screen.getByRole("button", { name: /Rebuild/ }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("buildIssueTypeInventory", {});
    });
    expect(await screen.findByText(/Build queued/i)).toBeInTheDocument();
  });

  test("surfaces a stale inventory notice", async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    invoke.mockImplementation((fn) => {
      if (fn === "getIssueTypeInventory") return Promise.resolve(inventory({ refreshedAt: old }));
      return Promise.resolve({});
    });
    render(<IssueTypesTab />);

    expect(await screen.findByText("This inventory is stale")).toBeInTheDocument();
  });
});
