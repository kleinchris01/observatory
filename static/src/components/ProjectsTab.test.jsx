import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { TopFieldsChart, FieldTypeDonut, ProjectsTabView } from "./ProjectsTab";

// ---------------------------------------------------------------------------
// TopFieldsChart
// ---------------------------------------------------------------------------
describe("TopFieldsChart", () => {
  it("renders nothing (returns null) when no customfield_ entries", () => {
    // TopFieldsChart only shows fields starting with "customfield_"
    const { container } = render(<TopFieldsChart fields={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when all fields lack the customfield_ prefix", () => {
    const fields = [{ fieldId: "summary", fieldName: "Summary", issueCount: 5 }];
    const { container } = render(<TopFieldsChart fields={fields} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the chart title when valid customfield_ entries exist", () => {
    const fields = [
      { fieldId: "customfield_1", fieldName: "Epic Link", issueCount: 200 },
      { fieldId: "customfield_2", fieldName: "Story Points", issueCount: 100 },
    ];
    render(<TopFieldsChart fields={fields} />);
    expect(screen.getByText("Top fields by issue count")).toBeInTheDocument();
  });

  it("renders a bar for each qualifying field", () => {
    const fields = [
      { fieldId: "customfield_1", fieldName: "Epic Link", issueCount: 200 },
      { fieldId: "customfield_2", fieldName: "Story Points", issueCount: 100 },
    ];
    const { container } = render(<TopFieldsChart fields={fields} />);
    // Recharts' YAxis tick-collision avoidance depends on real text-measurement
    // APIs jsdom doesn't implement, so it unpredictably drops some tick labels
    // under test -- not something this component controls. Assert on the mark
    // count instead, which renders reliably regardless of label collision logic.
    expect(container.querySelectorAll(".recharts-bar-rectangle").length).toBe(2);
  });

  it("limits display to top 8 fields", () => {
    const fields = Array.from({ length: 12 }, (_, i) => ({
      fieldId: `customfield_${i + 1}`,
      fieldName: `Field ${i + 1}`,
      issueCount: 100 - i,
    }));
    const { container } = render(<TopFieldsChart fields={fields} />);
    const bars = container.querySelectorAll(".recharts-bar-rectangle");
    expect(bars.length).toBeLessThanOrEqual(8);
    expect(bars.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// FieldTypeDonut
// ---------------------------------------------------------------------------
describe("FieldTypeDonut", () => {
  it("renders nothing for empty fields array", () => {
    const { container } = render(<FieldTypeDonut fields={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the donut chart title when fields are provided", () => {
    const fields = [
      { fieldId: "customfield_1", fieldType: "text" },
      { fieldId: "customfield_2", fieldType: "number" },
      { fieldId: "customfield_3", fieldType: "text" },
    ];
    const { container } = render(<FieldTypeDonut fields={fields} />);
    // Retitled when system fields were excluded: the chart now describes how the project
    // is configured, not which fields Jira puts on every issue.
    expect(container.querySelector(".chart-title").textContent)
      .toMatch(/Custom field types on this project/);
  });

  it("renders SVG donut chart", () => {
    const fields = [
      { fieldId: "customfield_1", fieldType: "text" },
      { fieldId: "customfield_2", fieldType: "number" },
    ];
    const { container } = render(<FieldTypeDonut fields={fields} />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders legend items for each field type", () => {
    const fields = [
      { fieldId: "customfield_1", fieldType: "text" },
      { fieldId: "customfield_2", fieldType: "number" },
      { fieldId: "customfield_3", fieldType: "select" },
    ];
    render(<FieldTypeDonut fields={fields} />);
    expect(screen.getByText("text")).toBeInTheDocument();
    expect(screen.getByText("number")).toBeInTheDocument();
    expect(screen.getByText("select")).toBeInTheDocument();
  });

  it("renders counts in the legend", () => {
    const fields = [
      { fieldId: "customfield_1", fieldType: "text" },
      { fieldId: "customfield_2", fieldType: "text" },
      { fieldId: "customfield_3", fieldType: "number" },
    ];
    render(<FieldTypeDonut fields={fields} />);
    // text appears twice, number once
    const twos = screen.getAllByText("2");
    expect(twos.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// ProjectsTabView
// ---------------------------------------------------------------------------
describe("ProjectsTabView", () => {
  const defaultProps = {
    data: null,
    loading: false,
    siteOrigin: "https://example.atlassian.net",
    selectedProjectId: null,
    onSelectProject: vi.fn(),
    projectQuery: "",
    onProjectQueryChange: vi.fn(),
    fieldQuery: "",
    onFieldQueryChange: vi.fn(),
    fieldType: "all",
    onFieldTypeChange: vi.fn(),
    fieldSort: "issues-desc",
    onFieldSortChange: vi.fn(),
    onChangePage: vi.fn(),
    onRestoreProjectUsageCache: vi.fn(),
    projectUsageRestoring: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders without crashing when data is null and loading=false", () => {
    render(<ProjectsTabView {...defaultProps} />);
    expect(screen.getByText("Projects")).toBeInTheDocument();
  });

  it("shows 'Projects' heading always", () => {
    render(<ProjectsTabView {...defaultProps} />);
    expect(screen.getByText("Projects")).toBeInTheDocument();
  });

  it("shows empty state when no projects and not loading", () => {
    render(<ProjectsTabView {...defaultProps} />);
    expect(screen.getByText(/No projects with cached field usage were found/i)).toBeInTheDocument();
  });

  it("shows 'Select a project' placeholder when no project is selected", () => {
    render(<ProjectsTabView {...defaultProps} />);
    expect(screen.getByText("Select a project to inspect cached field usage.")).toBeInTheDocument();
  });

  it("shows skeleton items when loading=true and no projects", () => {
    const { container } = render(<ProjectsTabView {...defaultProps} loading={true} />);
    const skels = container.querySelectorAll(".skel-project-item");
    expect(skels.length).toBeGreaterThan(0);
  });

  it("renders project buttons when data contains projects", () => {
    const data = {
      projects: [
        { projectId: "P1", projectKey: "DEMO", projectName: "Demo Project", totalIssueCount: 50, fieldCount: 3, uniqueIssueCount: null },
        { projectId: "P2", projectKey: "TEST", projectName: "Test Project", totalIssueCount: 20, fieldCount: 1, uniqueIssueCount: null },
      ],
      selectedProject: null,
      fields: [],
      availableTypes: [],
      totalFields: 0,
      page: 1,
      totalPages: 1,
      refreshedAt: null,
    };
    render(<ProjectsTabView {...defaultProps} data={data} />);
    expect(screen.getByText("DEMO")).toBeInTheDocument();
    expect(screen.getByText("TEST")).toBeInTheDocument();
  });

  it("renders project detail section when a project is selected", () => {
    const data = {
      projects: [
        { projectId: "P1", projectKey: "DEMO", projectName: "Demo Project", totalIssueCount: 50, fieldCount: 3, uniqueIssueCount: null },
      ],
      selectedProject: {
        projectId: "P1",
        projectKey: "DEMO",
        projectName: "Demo Project",
        totalIssueCount: 50,
        fieldCount: 3,
        uniqueIssueCount: null,
      },
      fields: [],
      availableTypes: [],
      totalFields: 3,
      page: 1,
      totalPages: 1,
      refreshedAt: null,
    };
    render(<ProjectsTabView {...defaultProps} data={data} selectedProjectId="P1" />);
    expect(screen.getByText("DEMO project usage")).toBeInTheDocument();
    // Renamed with the connection-map redesign -- the field count is now stated as a
    // relationship of the project rather than as a standalone stat card.
    expect(screen.getByText(/fields in use/i)).toBeInTheDocument();
  });

  it("shows the 'Restore from field summaries' button when handler is provided", () => {
    render(
      <ProjectsTabView
        {...defaultProps}
        onRestoreProjectUsageCache={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /restore from field summaries/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Project <-> workflow correlation
//
// Two projects on the same workflow scheme are meant to run the same process, so a
// divergence in their field usage is a standardization signal that neither the field
// view nor the workflow view surfaces on its own. This panel is where they meet.
// ---------------------------------------------------------------------------
describe("ProjectsTabView workflow correlation", () => {
  const SCHEME = {
    schemeId: "s1",
    name: "ADVEV Standard",
    description: "Default scheme for engineering projects",
    sharedWithCount: 2,
    siblingProjects: [
      { projectId: "200", projectKey: "BBB", projectName: "Project B" },
      { projectId: "300", projectKey: "CCC", projectName: "Project C" },
    ],
    refreshedAt: "2026-07-31T10:00:00Z",
  };

  function dataWith(workflowScheme) {
    return {
      projects: [{ projectId: "100", projectKey: "AAA", projectName: "Project A", fieldCount: 12, totalIssueCount: 40, uniqueIssueCount: null }],
      selectedProject: { projectId: "100", projectKey: "AAA", projectName: "Project A", fieldCount: 12, totalIssueCount: 40, uniqueIssueCount: null },
      workflowScheme,
      fields: [],
      page: 1,
      totalPages: 1,
      refreshedAt: "2026-07-31T10:00:00Z",
    };
  }

  const props = {
    loading: false,
    siteOrigin: "https://example.atlassian.net",
    selectedProjectId: "100",
    onSelectProject: vi.fn(),
    projectQuery: "",
    onProjectQueryChange: vi.fn(),
    fieldQuery: "",
    onFieldQueryChange: vi.fn(),
    fieldType: "all",
    onFieldTypeChange: vi.fn(),
    fieldSort: "issues-desc",
    onFieldSortChange: vi.fn(),
    onChangePage: vi.fn(),
    onRestoreProjectUsageCache: vi.fn(),
    projectUsageRestoring: false,
  };

  it("names the scheme governing the selected project and who shares it", () => {
    render(<ProjectsTabView {...props} data={dataWith(SCHEME)} />);

    expect(screen.getByText("ADVEV Standard")).toBeInTheDocument();
    expect(screen.getByText(/shared with 2 other projects/i)).toBeInTheDocument();
    expect(screen.getByText("BBB")).toBeInTheDocument();
    expect(screen.getByText("CCC")).toBeInTheDocument();
  });

  it("says so plainly when a scheme is unique to this project", () => {
    render(<ProjectsTabView {...props} data={dataWith({ ...SCHEME, sharedWithCount: 0, siblingProjects: [] })} />);

    expect(screen.getByText(/used only by this project/i)).toBeInTheDocument();
  });

  // The workflow snapshot is versioned separately from the field snapshot and may not
  // exist. The field view is the reason anyone opened this tab; it must not depend on it.
  it("renders the field view unchanged when no workflow snapshot exists", () => {
    render(<ProjectsTabView {...props} data={dataWith(null)} />);

    expect(screen.queryByText("Workflow scheme")).not.toBeInTheDocument();
    // Label changed with the connection-map redesign: the field count is now a
    // relationship of the project ("fields in use") rather than a standalone stat card.
    expect(screen.getByText(/fields in use/i)).toBeInTheDocument();
  });
});

// System fields appear on every issue in every project, so counting them in a per-project
// breakdown describes Jira rather than the project. They also wreck the chart: each
// contributes its own name as a one-count "type", so five of them render as five slivers
// around one dominant wedge.
describe("FieldTypeDonut — system field exclusion", () => {
  const fields = [
    { fieldId: "customfield_1", fieldName: "Team", fieldType: "select" },
    { fieldId: "customfield_2", fieldName: "Points", fieldType: "float" },
    { fieldId: "customfield_3", fieldName: "Effort", fieldType: "float" },
    { fieldId: "comment", fieldName: "Comment", fieldType: "Comment" },
    { fieldId: "worklog", fieldName: "Worklog", fieldType: "Worklog" },
    { fieldId: "priority", fieldName: "Priority", fieldType: "Priority" },
  ];

  test("counts only custom fields and says how many were excluded", () => {
    const { container } = render(<FieldTypeDonut fields={fields} />);

    // Asserted on the title's full text: the excluded-count note is a nested span, so a
    // regex against a single text node would not span both.
    const title = container.querySelector(".chart-title");
    expect(title.textContent).toMatch(/Custom field types on this project/i);
    expect(title.textContent).toMatch(/3 system fields excluded/i);
  });

  test("does not render a slice for a system field", () => {
    const { container } = render(<FieldTypeDonut fields={fields} />);
    // Comment/Worklog/Priority would each be a one-count wedge; only real types remain.
    expect(container.textContent).not.toMatch(/Worklog/);
    expect(container.textContent).toMatch(/float/);
  });

  test("renders nothing when a project has only system fields", () => {
    const { container } = render(<FieldTypeDonut fields={fields.filter((f) => !f.fieldId.startsWith("customfield_"))} />);
    // An empty donut is worse than no donut: it implies the project has no configuration.
    expect(container.firstChild).toBeNull();
  });

  test("omits the excluded note when every field is custom", () => {
    const { container } = render(<FieldTypeDonut fields={fields.filter((f) => f.fieldId.startsWith("customfield_"))} />);
    expect(container.querySelector(".chart-title").textContent).not.toMatch(/system field/i);
  });
});
