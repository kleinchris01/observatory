import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { IssueTypesTab, HierarchyLevelPanel, SchemeCard, IssueTypeFindings, TypeUsageChip } from "./IssueTypesTab";

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
    totalTypes: 3,
    subtaskTypes: 1,
    projectScopedTypes: 1,
    hierarchyLevels: 3,
    totalSchemes: 2,
    unusedSchemes: 1,
    orphanTypes: 0,
  },
  hierarchy: [
    {
      level: 1,
      label: "Epic",
      types: [{ id: "1", name: "Epic", subtask: false, hierarchyLevel: 1, scopeProjectId: null }],
    },
    {
      level: 0,
      label: "Base (Story, Task, Bug)",
      types: [{ id: "2", name: "Story", subtask: false, hierarchyLevel: 0, scopeProjectId: null }],
    },
    {
      level: -1,
      label: "Sub-task",
      types: [{ id: "3", name: "Sub-task", subtask: true, hierarchyLevel: -1, scopeProjectId: null }],
    },
  ],
  schemes: [
    {
      schemeId: "5",
      name: "Default Issue Type Scheme",
      description: "",
      defaultIssueTypeId: "2",
      isDefault: true,
      projectCount: 8,
      issueTypes: [
        { id: "1", name: "Epic", hierarchyLevel: 1, subtask: false, missing: false },
        { id: "2", name: "Story", hierarchyLevel: 0, subtask: false, missing: false },
      ],
      projects: [{ projectId: "10000", projectKey: "OBS", projectName: "Observatory" }],
    },
    {
      schemeId: "6",
      name: "Unused Scheme",
      description: "",
      defaultIssueTypeId: null,
      isDefault: false,
      projectCount: 0,
      issueTypes: [{ id: "999", name: null, hierarchyLevel: null, subtask: null, missing: true }],
      projects: [],
    },
  ],
  issueTypeScreenSchemes: [
    {
      itssId: "9",
      name: "Default ITSS",
      projectCount: 4,
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

describe("IssueTypeFindings", () => {
  test("renders nothing-to-report when every count is clean", () => {
    render(
      <IssueTypeFindings
        findings={{
          available: true,
          orphanTypeCount: 0,
          hierarchyFlaggedSchemeCount: 0,
          reducibleTypeCount: 0,
          unusedSchemeCount: 0,
        }}
      />,
    );
    expect(screen.getByText(/No issue type governance findings/i)).toBeInTheDocument();
  });

  test("ranks orphan types and broken schemes above naming and unused", () => {
    render(
      <IssueTypeFindings
        findings={{
          available: true,
          orphanTypeCount: 3,
          orphanSubtaskCount: 1,
          orphanTypes: [{ name: "Spike" }, { name: "Old Bug" }],
          hierarchyFlaggedSchemeCount: 1,
          flaggedSchemes: [{ name: "Subs only" }],
          reducibleTypeCount: 4,
          duplicateTypeGroupCount: 2,
          unusedSchemeCount: 2,
        }}
      />,
    );

    const titles = [...document.querySelectorAll(".ui-finding__title")].map((n) => n.textContent);
    expect(titles[0]).toMatch(/on no scheme/);
    expect(titles[1]).toMatch(/cannot start an issue/);
    expect(titles).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Near-duplicate/),
        expect.stringMatching(/assigned to no project/),
      ]),
    );
    expect(screen.getByText(/1 are sub-tasks/)).toBeInTheDocument();
  });

  test("says never-built when the pillar has no snapshot", () => {
    render(<IssueTypeFindings findings={{ available: false }} />);
    expect(screen.getByText(/No issue type inventory has been built yet/i)).toBeInTheDocument();
  });
});

describe("IssueTypesTab", () => {
  test("reports never-built rather than an empty catalog", async () => {
    invoke.mockImplementation((fn) =>
      fn === "getIssueTypeInventory" ? Promise.resolve({ neverBuilt: true, state: "idle" }) : Promise.resolve({}),
    );
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

// The tri-state the crawl has carried since it shipped and the tab had nowhere to show.
//
// Zero is what makes a type look safe to delete, so "a completed crawl found none" and
// "nobody has counted" must never render the same way. These four cases are the whole
// reason the column exists.
describe("TypeUsageChip", () => {
  const type = (over = {}) => ({ id: "10001", name: "Bug", issueCount: 0, usedInProjects: 0, ...over });

  test("shows a real count when a crawl completed", () => {
    render(<TypeUsageChip type={type({ issueCount: 4820, usedInProjects: 12 })} measurement="measured" />);
    expect(screen.getByText(/4,820 issues/)).toBeInTheDocument();
  });

  test("says 'no issues' only when a completed crawl found none", () => {
    render(<TypeUsageChip type={type({ issueCount: 0 })} measurement="measured" />);
    expect(screen.getByText("No issues")).toBeInTheDocument();
  });

  test("says 'not measured' when no crawl has ever finished", () => {
    // The distinction that stops somebody deleting a type on the strength of a scan nobody
    // has run.
    render(<TypeUsageChip type={type({ issueCount: null })} measurement="not-measured" />);
    expect(screen.getByText("Not measured")).toBeInTheDocument();
    expect(screen.queryByText("No issues")).not.toBeInTheDocument();
  });

  test("says 'not reached' for a type a partial crawl never got to", () => {
    render(<TypeUsageChip type={type({ issueCount: null })} measurement="partial" />);
    expect(screen.getByText("Not reached")).toBeInTheDocument();
  });

  test("says the count is unavailable rather than zero when the read failed", () => {
    render(<TypeUsageChip type={type({ issueCount: null })} measurement="measurement-failed" />);
    expect(screen.getByText("Count unavailable")).toBeInTheDocument();
  });
});

describe("IssueTypesTab usage", () => {
  test("each type shows how many issues, how many created in 90 days, and when last", () => {
    const usage = {
      available: true,
      basis: "created",
      windowDays: 90,
      measuredAt: "2026-10-07T00:00:00.000Z",
      items: { 2: { total: 4200, recent: 130, lastAt: new Date().toISOString(), projectCount: 12 } },
    };
    render(<HierarchyLevelPanel level={inventory().hierarchy[1]} search="" measurement="measured" usage={usage} />);
    expect(screen.getByText("4,200")).toBeInTheDocument();
    expect(screen.getByText(/created 90d/)).toBeInTheDocument();
    expect(screen.getByText("today")).toBeInTheDocument();
  });

  test("the tab asks for issue type usage once", async () => {
    invoke.mockImplementation((fn) => {
      if (fn === "getIssueTypeInventory") return Promise.resolve(inventory());
      return Promise.resolve({});
    });
    render(<IssueTypesTab />);
    await screen.findByText("Issue types");
    expect(invoke.mock.calls.filter(([fn]) => fn === "getPillarUsage")).toEqual([
      ["getPillarUsage", { pillar: "issuetype" }],
    ]);
  });
});
