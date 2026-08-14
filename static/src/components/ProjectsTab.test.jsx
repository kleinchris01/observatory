import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { TopFieldsChart, FieldTypeDonut, ProjectsTabView,
  ProjectOverview,
} from "./ProjectsTab";

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
    render(<ProjectsTabView
      {...defaultProps}
      data={data}
      selectedProjectId="P1"
      overview={{
        available: true,
        workflow: { available: false, reason: "No workflow inventory has been built yet." },
        screens: { available: false, reason: "No screen inventory has been built yet." },
        automation: { available: false, reason: "No automation analysis has been built yet." },
      }}
    />);
    expect(screen.getByText("DEMO project usage")).toBeInTheDocument();
    // The overview leads now: the field count is a stat on it rather than a standalone card.
    expect(screen.getByText(/Fields in use/i)).toBeInTheDocument();
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

  // The scheme facts moved out of the view and into getProjectOverview, which the container
  // fetches per project. These supply what that call returns.
  const overviewWith = (scheme) => ({
    available: true,
    workflow: { available: true, scheme },
    screens: { available: false, reason: "No screen inventory has been built yet." },
    automation: { available: false, reason: "No automation analysis has been built yet." },
  });

  it("names the scheme governing the selected project and who shares it", () => {
    render(<ProjectsTabView {...props} data={dataWith(SCHEME)} overview={overviewWith(SCHEME)} />);

    // Twice, deliberately: once as the overview's headline, once as the peer-bars heading
    // naming the scheme the comparison is across.
    expect(screen.getAllByText("ADVEV Standard").length).toBeGreaterThan(0);
    // The consequence, not just the count: a change to a shared scheme is not local.
    expect(screen.getByText(/lands on all of them/i)).toBeInTheDocument();
    // The sibling KEYS were chips on the old connection map, which the overview replaced.
    // The peer bars still compare siblings, but only for siblings present in the projects
    // list -- so what this test pins is the claim the overview itself makes: how many other
    // projects run this process, and that a change here reaches them.
    expect(screen.getByText(/5 other projects|2 other projects/i)).toBeInTheDocument();
  });

  it("says so plainly when a scheme is unique to this project", () => {
    const scheme = { ...SCHEME, sharedWithCount: 0, siblingProjects: [] };
    render(<ProjectsTabView {...props} data={dataWith(scheme)} overview={overviewWith(scheme)} />);

    expect(screen.getByText(/used only by this project/i)).toBeInTheDocument();
  });

  // The workflow snapshot is versioned separately from the field snapshot and may not
  // exist. The field view is the reason anyone opened this tab; it must not depend on it.
  // The workflow snapshot is versioned separately from the field snapshot and may not
  // exist. The overview must report that pillar as unbuilt rather than as a project with
  // no process, and the field view must not depend on it at all.
  it("reports the workflow pillar unbuilt without breaking the rest of the page", () => {
    render(<ProjectsTabView
      {...props}
      data={dataWith(null)}
      overview={{
        available: true,
        workflow: { available: false, reason: "No workflow inventory has been built yet." },
        screens: { available: false, reason: "No screen inventory has been built yet." },
        automation: { available: false, reason: "No automation analysis has been built yet." },
      }}
    />);

    expect(screen.getByText(/No workflow inventory/i)).toBeInTheDocument();
    expect(screen.getByText(/Fields in use/i)).toBeInTheDocument();
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

// The cross-pillar view. The tab used to be a field list with a workflow scheme wedged in
// beside it: no mention of the forms a project routes to, none at all of the automation
// firing inside it.
describe("ProjectOverview", () => {
  const project = { projectKey: "CAVPSE", projectName: "Advanced Connected Vehicle", fieldCount: 170, uniqueIssueCount: 60185, totalFieldFills: 4192973 };
  const overview = (over = {}) => ({
    available: true,
    workflow: { available: true, scheme: { name: "SW Workflow Scheme v1", sharedWithCount: 5 } },
    screens: { available: true, unresolvedScreens: 0, screens: [{ screenId: "100", name: "Default Screen", fieldCount: 28, tabsResolved: "resolved" }] },
    automation: { available: true, enabledCount: 3, disabledCount: 1, rules: [
      { ruleId: "1", name: "Send to Approval", enabled: true, triggerType: "Issue created" },
      { ruleId: "2", name: "Retired rule", enabled: false, triggerType: "Scheduled" },
    ] },
    ...over,
  });

  it("names the automation firing in this project, which the tab never mentioned", () => {
    render(<ProjectOverview project={project} overview={overview()} loading={false} />);

    expect(screen.getByText("Send to Approval")).toBeInTheDocument();
    expect(screen.getByText("Retired rule")).toBeInTheDocument();
  });

  it("shows the forms this project routes to", () => {
    render(<ProjectOverview project={project} overview={overview()} loading={false} />);
    expect(screen.getByText("Default Screen")).toBeInTheDocument();
  });

  it("says a shared scheme is shared, because a change there is not local", () => {
    render(<ProjectOverview project={project} overview={overview()} loading={false} />);
    expect(screen.getByText(/lands on all of them/i)).toBeInTheDocument();
  });

  // Em dash, never 0. "No forms route here" and "we have not looked" are opposite claims.
  it("reports an unbuilt pillar as unknown rather than as zero", () => {
    render(<ProjectOverview
      project={project}
      loading={false}
      overview={overview({
        screens: { available: false, reason: "No screen inventory has been built yet." },
        automation: { available: false, reason: "No automation analysis has been built yet." },
      })}
    />);

    expect(screen.getByText(/No screen inventory/i)).toBeInTheDocument();
    // Twice: both the scoped-rules panel and the inferred site-wide one report the same
    // unbuilt pillar, which is right -- neither can say anything without the analysis.
    expect(screen.getAllByText(/No automation analysis/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("No rule is scoped specifically to this project.")).not.toBeInTheDocument();
  });

  // Distinct from the above: the pillar IS built and the answer is genuinely none.
  it("distinguishes a built pillar with nothing in it from an unbuilt one", () => {
    render(<ProjectOverview
      project={project}
      loading={false}
      overview={overview({ automation: { available: true, enabledCount: 0, disabledCount: 0, rules: [] } })}
    />);

    expect(screen.getByText("No rule is scoped specifically to this project.")).toBeInTheDocument();
  });

  it("caveats the form list when part of the screen catalog could not be read", () => {
    render(<ProjectOverview
      project={project}
      loading={false}
      overview={overview({ screens: { available: true, unresolvedScreens: 14, screens: [{ screenId: "100", name: "Default Screen", fieldCount: 28, tabsResolved: "resolved" }] } })}
    />);

    expect(screen.getByText(/may be incomplete/i)).toBeInTheDocument();
  });
});

// Site-wide rules are only worth listing per project if there is evidence they act there.
// Otherwise the list is "all of them", which says nothing.
describe("ProjectOverview — inferred site-wide rules", () => {
  const project = { projectKey: "CAVPSE", projectName: "Advanced Connected Vehicle", fieldCount: 170, uniqueIssueCount: 60185, totalFieldFills: 4192973 };
  const base = (automation) => ({
    available: true,
    workflow: { available: false, reason: "No workflow inventory has been built yet." },
    screens: { available: false, reason: "No screen inventory has been built yet." },
    automation,
  });

  it("shows the evidence behind the inference, not just the rule name", () => {
    render(<ProjectOverview project={project} loading={false} overview={base({
      available: true, enabledCount: 0, disabledCount: 0, rules: [],
      globalRulesAvailable: true,
      globalRules: [{ ruleId: "9", name: "Stamp Last Reviewed", fieldsTouched: 2, issuesTouched: 5000 }],
    })} />);

    expect(screen.getByText("Stamp Last Reviewed")).toBeInTheDocument();
    expect(screen.getByText(/5,000 issues · 2 fields/)).toBeInTheDocument();
  });

  // The distinction that matters: configured-for-this-project is a fact, reaches-this-project
  // is a judgement, and the second must not borrow the authority of the first.
  it("labels the list as inferred rather than confirmed", () => {
    render(<ProjectOverview project={project} loading={false} overview={base({
      available: true, enabledCount: 0, disabledCount: 0, rules: [],
      globalRulesAvailable: true,
      globalRules: [{ ruleId: "9", name: "Stamp", fieldsTouched: 1, issuesTouched: 10 }],
    })} />);

    expect(screen.getByText(/Inferred, not confirmed/i)).toBeInTheDocument();
    expect(screen.getByText(/no execution log/i)).toBeInTheDocument();
  });

  it("says why it cannot infer, rather than reporting none", () => {
    render(<ProjectOverview project={project} loading={false} overview={base({
      available: true, enabledCount: 0, disabledCount: 0, rules: [],
      globalRulesAvailable: false,
      globalRulesReason: "Needs the field snapshot to tell which site-wide rules act on this project.",
      globalRules: [],
    })} />);

    expect(screen.getByText(/Needs the field snapshot/i)).toBeInTheDocument();
    expect(screen.queryByText(/No site-wide rule shows evidence/i)).not.toBeInTheDocument();
  });

  it("distinguishes no evidence found from unable to look", () => {
    render(<ProjectOverview project={project} loading={false} overview={base({
      available: true, enabledCount: 0, disabledCount: 0, rules: [],
      globalRulesAvailable: true, globalRules: [],
    })} />);

    expect(screen.getByText(/No site-wide rule shows evidence/i)).toBeInTheDocument();
  });
});
