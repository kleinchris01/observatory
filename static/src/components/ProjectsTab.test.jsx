import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(() => Promise.resolve({})),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

import { invoke } from "@forge/bridge";
import { TopFieldsChart, FieldTypeDonut, ProjectsTabView,
  ProjectOverview, buildProjectFilters, projectFilterCount, ProjectAdoptionPanel, ActivitySparkbars,
  ProjectHealthPanel, ProjectFiltersPanel, ProjectScreenReportPanel,
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

// The rail had no filtering at all, so "64 projects configured well past the site norm"
// dropped the reader at whichever project happened to sort first.
//
// The predicates are derived here rather than sent down, because the rail already holds
// every project the reader may browse and the thresholds are a function of that list. One
// honest consequence: a count here can be lower than the same count on the Overview, because
// the rail is permission-filtered and the score is not.
describe("buildProjectFilters", () => {
  const project = (key, over = {}) => ({
    projectId: key, projectKey: key, projectName: key,
    fieldCount: 20, totalIssueCount: 5000, uniqueIssueCount: null,
    latestIssueUpdatedAt: new Date().toISOString(), ...over,
  });
  const match = (projects, key) => {
    const filter = buildProjectFilters(projects).find((f) => f.key === key);
    return projects.filter(filter.match).map((p) => p.projectKey);
  };

  it("derives the over-configured floor from the site's own median", () => {
    const projects = [...Array.from({ length: 20 }, (_, i) => project(`B${i}`, { fieldCount: 30 })), project("BIG", { fieldCount: 90 })];
    // max(10, median * 2) -- the same floor the score judges against.
    expect(buildProjectFilters(projects).find((f) => f.key === "over-configured").label).toBe("60+ fields");
    expect(match(projects, "over-configured")).toEqual(["BIG"]);
  });

  it("guards the floor on a site whose median project carries one field", () => {
    const projects = [...Array.from({ length: 10 }, (_, i) => project(`B${i}`, { fieldCount: 1 })), project("SMALL", { fieldCount: 6 })];
    // Twice the median is 2, which would make a six-field project an outlier. It is not.
    expect(match(projects, "over-configured")).toEqual([]);
  });

  it("counts a busy project past the norm as over-configured", () => {
    // The measure is field count alone. Requiring light volume too is what made this
    // finding impossible to trip on an active site.
    const projects = [...Array.from({ length: 10 }, (_, i) => project(`B${i}`, { fieldCount: 20 })), project("BUSY", { fieldCount: 90, totalIssueCount: 400000 })];
    expect(match(projects, "over-configured")).toEqual(["BUSY"]);
  });

  it("finds projects with fields and no work", () => {
    const projects = [project("A", { uniqueIssueCount: 500 }), project("EMPTY", { fieldCount: 12, uniqueIssueCount: 0, totalIssueCount: 0 })];
    expect(match(projects, "no-work")).toEqual(["EMPTY"]);
  });

  // A project the scan has not reached is unmeasured, not empty. Coercing it to zero would
  // report most of the estate as abandoned halfway through every scan.
  it("does not call an unmeasured project empty", () => {
    const projects = [project("SCANNED", { uniqueIssueCount: 5000 }), project("PENDING", { uniqueIssueCount: null, totalIssueCount: 0 })];
    expect(match(projects, "no-work")).toEqual([]);
  });

  it("finds projects that have gone quiet", () => {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const projects = [project("LIVE"), project("QUIET", { latestIssueUpdatedAt: old })];
    expect(match(projects, "stale")).toEqual(["QUIET"]);
  });

  it("does not call a project that never started stale", () => {
    // Staleness needs recorded work to have gone quiet. A project that never started is the
    // other finding, and counting it as both would double-charge one project.
    const projects = [project("NEVER", { totalIssueCount: 0, uniqueIssueCount: 0, latestIssueUpdatedAt: "2019-01-01T00:00:00Z" })];
    expect(match(projects, "stale")).toEqual([]);
  });

  it("keeps everything under the default", () => {
    const projects = [project("A"), project("B")];
    expect(match(projects, "all")).toEqual(["A", "B"]);
  });

  it("survives an empty rail", () => {
    expect(buildProjectFilters([]).map((f) => f.key)).toEqual(["all", "over-configured", "no-work", "fell-off", "stale"]);
  });
});

describe("ProjectsTabView — arriving from a finding", () => {
  const project = (key, over = {}) => ({
    projectId: key, projectKey: key, projectName: `Project ${key}`,
    fieldCount: 20, totalIssueCount: 5000, uniqueIssueCount: 500,
    latestIssueUpdatedAt: new Date().toISOString(), ...over,
  });
  const data = {
    projects: [
      ...Array.from({ length: 10 }, (_, i) => project(`B${i}`)),
      project("BIG", { fieldCount: 90 }),
    ],
    selectedProject: null, fields: [], availableTypes: [], totalFields: 0, page: 1, totalPages: 1,
  };
  const noop = () => {};

  it("narrows the rail to the projects the finding counted", () => {
    const { container } = render(<ProjectsTabView
      data={data} loading={false} selectedProjectId="BIG" onSelectProject={noop}
      projectQuery="" onProjectQueryChange={noop} fieldQuery="" onFieldQueryChange={noop}
      fieldType="all" onFieldTypeChange={noop} fieldSort="issues-desc" onFieldSortChange={noop}
      onChangePage={noop} projectFilter="over-configured" onProjectFilterChange={noop}
    />);

    const keys = [...container.querySelectorAll(".projects-rail__item strong")].map((n) => n.textContent);
    expect(keys).toEqual(["BIG"]);
  });

  it("shows every project when opened normally", () => {
    const { container } = render(<ProjectsTabView
      data={data} loading={false} selectedProjectId="BIG" onSelectProject={noop}
      projectQuery="" onProjectQueryChange={noop} fieldQuery="" onFieldQueryChange={noop}
      fieldType="all" onFieldTypeChange={noop} fieldSort="issues-desc" onFieldSortChange={noop}
      onChangePage={noop} projectFilter="all" onProjectFilterChange={noop}
    />);

    expect(container.querySelectorAll(".projects-rail__item")).toHaveLength(11);
  });

  it("says the filter matched nothing rather than looking like an empty site", () => {
    const { container } = render(<ProjectsTabView
      data={data} loading={false} selectedProjectId="BIG" onSelectProject={noop}
      projectQuery="" onProjectQueryChange={noop} fieldQuery="" onFieldQueryChange={noop}
      fieldType="all" onFieldTypeChange={noop} fieldSort="issues-desc" onFieldSortChange={noop}
      onChangePage={noop} projectFilter="no-work" onProjectFilterChange={noop}
    />);

    expect(container.textContent).toMatch(/No project matches/);
    expect(container.textContent).not.toMatch(/No projects with cached field usage/);
  });
});

// "Fell off" is the finding people will actually chase: a project that had a real life and
// lost it, which a lifetime total can never show.
describe("buildProjectFilters — adoption", () => {
  const project = (key, over = {}) => ({
    projectId: key, projectKey: key, projectName: key,
    fieldCount: 20, totalIssueCount: 5000, uniqueIssueCount: 500,
    latestIssueUpdatedAt: new Date().toISOString(), ...over,
  });

  it("narrows to the projects people left", () => {
    const projects = [
      project("LIVE", { adoption: { fellOff: false, score: 70 } }),
      project("LEFT", { adoption: { fellOff: true, score: 22, declineFrom: "2023-04" } }),
    ];
    const filter = buildProjectFilters(projects).find((f) => f.key === "fell-off");
    expect(projects.filter(filter.match).map((p) => p.projectKey)).toEqual(["LEFT"]);
  });

  // A site scanned before issue dates were captured has no adoption on any row. The filter
  // matches nothing rather than throwing, and the rail says so.
  it("matches nothing rather than throwing when adoption was never measured", () => {
    const projects = [project("A"), project("B")];
    const filter = buildProjectFilters(projects).find((f) => f.key === "fell-off");
    expect(projects.filter(filter.match)).toEqual([]);
  });
});

describe("ProjectAdoptionPanel", () => {
  const adoption = (over = {}) => ({
    measured: true, oldEnough: true,
    firstIssueCreatedAt: "2019-03-11T09:00:00.000Z",
    ageDays: 2726, issuesPerDay: 22.2, recentIssuesPerDay: 0.4, momentum: 0.02,
    fillsPerIssue: 14.2, score: 45, volumePercentile: 75,
    peakMonth: "2022-07", peakIssues: 1910, declineFrom: "2023-02",
    fellOff: true, neverAdopted: false,
    months: [
      { month: "2022-06", issueCount: 1800 },
      { month: "2022-07", issueCount: 1910 },
      { month: "2023-02", issueCount: 400 },
      { month: "2023-03", issueCount: 90 },
    ],
    ...over,
  });

  it("dates the decline, which is the question the whole feature answers", () => {
    render(<ProjectAdoptionPanel adoption={adoption()} context={{ medianIssuesPerDay: 4.4 }} />);
    expect(screen.getByText("2022-07")).toBeInTheDocument();
    expect(screen.getByText("2023-02")).toBeInTheDocument();
  });

  it("reads the recent rate against the project's own history", () => {
    render(<ProjectAdoptionPanel adoption={adoption()} context={{}} />);
    expect(screen.getByText(/0\.02× its lifetime rate/)).toBeInTheDocument();
  });

  it("puts the volume percentile against the site, not against a constant", () => {
    render(<ProjectAdoptionPanel adoption={adoption()} context={{ medianIssuesPerDay: 4.4 }} />);
    expect(screen.getByText(/busier than 75% of projects here/)).toBeInTheDocument();
  });

  // Unmeasured is not unused, and this pillar exists because the two used to be
  // indistinguishable: a project with no captured dates would read as created today and
  // never adopted.
  it("asks for a scan rather than reporting a project as unused", () => {
    render(<ProjectAdoptionPanel adoption={{ measured: false, reason: "No issue dates captured. Run a Universal Scan." }} />);
    expect(screen.getByText(/Run a Universal Scan/)).toBeInTheDocument();
    expect(screen.queryByText(/Adoption score/)).not.toBeInTheDocument();
  });

  it("refuses to judge a project too new to judge", () => {
    render(<ProjectAdoptionPanel adoption={adoption({ oldEnough: false, fellOff: false, declineFrom: null })} context={{}} />);
    expect(screen.getByText(/Too new to judge/)).toBeInTheDocument();
  });

  it("says a project never picked up, which is a different finding from falling off", () => {
    render(<ProjectAdoptionPanel adoption={adoption({ fellOff: false, declineFrom: null, neverAdopted: true })} context={{}} />);
    expect(screen.getByText(/Never picked up/)).toBeInTheDocument();
  });

  // When the activity histogram everywhere stops near a fixed month, the recent rate is a
  // measurement of the gap in the data, not of the project.
  describe("when the site's activity data is stale", () => {
    const ctx = { dataStale: true, dataThroughMonth: "2026-01" };

    it("warns that the recent figures are stale and names the month", () => {
      render(<ProjectAdoptionPanel adoption={adoption()} context={ctx} />);
      expect(screen.getByText(/Activity data ends 2026-01/)).toBeInTheDocument();
    });

    it("shows the recent rate as unknown rather than a stale zero", () => {
      render(<ProjectAdoptionPanel adoption={adoption({ recentIssuesPerDay: 0, momentum: 0 })} context={ctx} />);
      expect(screen.getByText("data ends 2026-01")).toBeInTheDocument();
      expect(screen.queryByText(/its lifetime rate/)).not.toBeInTheDocument();
    });

    it("holds back the decline story the stale data cannot support", () => {
      render(<ProjectAdoptionPanel adoption={adoption()} context={ctx} />);
      expect(screen.queryByText(/Dropped below half/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Running far below/)).not.toBeInTheDocument();
    });
  });
});

describe("ProjectScreenReportPanel", () => {
  beforeEach(() => { invoke.mockReset(); });

  const inputs = {
    available: true,
    projectId: "10000",
    scopeProjectIds: ["10000"],
    schemes: [
      { schemeId: "SS_STORY", schemeName: "Story screens", issueTypeCount: 1, isDefault: true, fieldIds: ["cf_1", "cf_2"], screens: [{ screenId: "S1", name: "Story", fieldIds: ["cf_1", "cf_2"] }] },
      { schemeId: "SS_BUG", schemeName: "Bug screens", issueTypeCount: 2, isDefault: false, fieldIds: ["cf_3"], screens: [{ screenId: "S2", name: "Bug", fieldIds: ["cf_3"] }] },
    ],
    allFieldIds: ["cf_1", "cf_2", "cf_3"],
  };

  it("lists the project's screen schemes and builds a scoped report from the ticked ones", async () => {
    invoke.mockResolvedValue(inputs);
    const onBuildFieldReport = vi.fn();
    render(<ProjectScreenReportPanel projectId="10000" onBuildFieldReport={onBuildFieldReport} />);

    expect(await screen.findByText("Story screens")).toBeInTheDocument();
    expect(screen.getByText("Bug screens")).toBeInTheDocument();
    // Everything is ticked by default -> the build carries every field, scoped to the project.
    await userEvent.click(screen.getByRole("button", { name: /Build report/i }));
    expect(onBuildFieldReport).toHaveBeenCalledWith(["cf_1", "cf_2", "cf_3"], ["10000"]);
  });

  it("drops a scheme's fields from the build when it is unticked", async () => {
    invoke.mockResolvedValue(inputs);
    const onBuildFieldReport = vi.fn();
    render(<ProjectScreenReportPanel projectId="10000" onBuildFieldReport={onBuildFieldReport} />);

    await screen.findByText("Bug screens");
    // Untick "Bug screens" (second checkbox).
    await userEvent.click(screen.getAllByRole("checkbox")[1]);
    await userEvent.click(screen.getByRole("button", { name: /Build report/i }));
    expect(onBuildFieldReport).toHaveBeenCalledWith(["cf_1", "cf_2"], ["10000"]);
  });

  it("says so when the project's screens do not resolve through an ITSS", async () => {
    invoke.mockResolvedValue({ available: true, projectId: "10000", schemes: [], reason: "This project's screens could not be resolved through an issue type screen scheme." });
    render(<ProjectScreenReportPanel projectId="10000" onBuildFieldReport={vi.fn()} />);
    expect(await screen.findByText(/could not be resolved through an issue type screen scheme/i)).toBeInTheDocument();
  });
});

describe("ProjectHealthPanel", () => {
  const health = (over = {}) => ({
    band: "warning",
    headline: "Worth a look",
    signals: [
      { key: "adoption", label: "Adoption", value: 38, detail: "busier than 60% of projects here", tone: "neutral" },
      { key: "configuration", label: "Configuration weight", value: "64.6 fields/issue", detail: "site median 12.0 — 5.4× heavier", tone: "warning" },
    ],
    ...over,
  });

  it("shows the band headline and one tile per signal with its detail", () => {
    render(<ProjectHealthPanel health={health()} />);
    expect(screen.getByText("Worth a look")).toBeInTheDocument();
    expect(screen.getByText("Configuration weight")).toBeInTheDocument();
    expect(screen.getByText(/5.4× heavier/)).toBeInTheDocument();
  });

  it("carries a critical signal's tone into the tile", () => {
    const { container } = render(<ProjectHealthPanel health={health({ band: "critical", signals: [
      { key: "adoption", label: "Adoption", value: "—", detail: "running far below its own historical rate", tone: "critical" },
    ] })} />);
    expect(container.querySelector(".ui-stat--critical")).not.toBeNull();
  });

  it("says so rather than inventing a score when nothing has been scanned", () => {
    render(<ProjectHealthPanel health={{ band: "healthy", headline: "Looks healthy", signals: [] }} />);
    expect(screen.getByText(/Not enough has been scanned/)).toBeInTheDocument();
  });
});

describe("ProjectFiltersPanel", () => {
  const filters = (over = {}) => ({
    available: true,
    total: 2,
    filters: [
      { id: "5", name: "PT2 open bugs", ownerName: "Bo", ownerActive: true, subscriptionCount: 3, lastUsedAt: "2026-08-01T00:00:00Z" },
      { id: "6", name: "PT2 backlog", ownerName: "Al", ownerActive: false, subscriptionCount: 0, lastUsedAt: null },
    ],
    ...over,
  });

  it("links each filter to Jira and shows owner + subscription detail", () => {
    render(<ProjectFiltersPanel filters={filters()} siteOrigin="https://x.atlassian.net" />);
    const link = screen.getByRole("link", { name: "PT2 open bugs" });
    expect(link).toHaveAttribute("href", "https://x.atlassian.net/issues/?filter=5");
    expect(screen.getByText(/Bo · 3 subscriptions/)).toBeInTheDocument();
    expect(screen.getByText(/Al · inactive/)).toBeInTheDocument();
  });

  it("distinguishes 'no filter targets this' from 'no inventory built'", () => {
    const { rerender } = render(<ProjectFiltersPanel filters={filters({ filters: [], total: 0 })} siteOrigin="" />);
    expect(screen.getByText(/No saved filter scopes its JQL/)).toBeInTheDocument();
    rerender(<ProjectFiltersPanel filters={{ available: false, reason: "No saved-filter inventory has been built yet." }} siteOrigin="" />);
    expect(screen.getByText(/No saved-filter inventory/)).toBeInTheDocument();
  });
});

describe("ActivitySparkbars", () => {
  const months = Array.from({ length: 60 }, (_, i) => ({ month: `20${20 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`, issueCount: 100 }));

  it("caps how much history it draws", () => {
    // A long-lived project has more months than there are pixels.
    const { container } = render(<ActivitySparkbars months={months} peakIssues={100} />);
    expect(container.querySelectorAll(".adoption-bars__bar")).toHaveLength(48);
  });

  it("marks the months after the decline began", () => {
    const { container } = render(<ActivitySparkbars months={months} peakIssues={100} declineFrom="2023-01" />);
    expect(container.querySelectorAll(".adoption-bars__bar--after").length).toBeGreaterThan(0);
  });

  it("draws nothing from a single month, because one point is not a shape", () => {
    const { container } = render(<ActivitySparkbars months={[{ month: "2026-01", issueCount: 5 }]} />);
    expect(container.firstChild).toBeNull();
  });
});

// The bug: every one of these chips read "0" on a live site with 126 projects, because the
// inputs they need had never been collected. A zero says "we looked and found none". Using
// it for "we have not looked" is the false all-clear this whole app is built to refuse -- and
// the field card two tabs over already renders a dash for exactly this case.
describe("buildProjectFilters — measured, or honestly not", () => {
  const project = (key, over = {}) => ({
    projectId: key, projectKey: key, projectName: key,
    fieldCount: 20, totalIssueCount: 5000, uniqueIssueCount: 500,
    latestIssueUpdatedAt: new Date().toISOString(), ...over,
  });
  const option = (projects, key) => buildProjectFilters(projects).find((f) => f.key === key);

  // Adoption needs the activity series, which only a Universal Scan populates. Until one has
  // run, every project carries adoption: null.
  it("cannot answer 'fell off' before a Universal Scan has run", () => {
    const projects = [project("A"), project("B")];
    const fellOff = option(projects, "fell-off");

    expect(fellOff.measurable).toBe(false);
    expect(projectFilterCount(fellOff, projects)).toBeNull();
    expect(fellOff.unmeasuredHint).toMatch(/Universal Scan/);
  });

  it("answers 'fell off' the moment any project has adoption", () => {
    const projects = [
      project("A", { adoption: { fellOff: true, score: 20 } }),
      project("B", { adoption: { fellOff: false, score: 70 } }),
    ];
    const fellOff = option(projects, "fell-off");

    expect(fellOff.measurable).toBe(true);
    expect(projectFilterCount(fellOff, projects)).toBe(1);
  });

  // Zero and null are different answers, and this is the pair that proves it: the same
  // projects, one measured and one not.
  it("tells a measured zero from an unmeasured one", () => {
    const measured = [project("A", { adoption: { fellOff: false } })];
    const unmeasured = [project("A")];

    expect(projectFilterCount(option(measured, "fell-off"), measured)).toBe(0);
    expect(projectFilterCount(option(unmeasured, "fell-off"), unmeasured)).toBeNull();
  });

  it("cannot answer 'quiet 6 months' with no activity dates", () => {
    const projects = [project("A", { latestIssueUpdatedAt: null })];
    const stale = option(projects, "stale");

    expect(stale.measurable).toBe(false);
    expect(projectFilterCount(stale, projects)).toBeNull();
  });

  it("answers 'quiet 6 months' once any project has a date", () => {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const projects = [project("LIVE"), project("QUIET", { latestIssueUpdatedAt: old })];

    expect(projectFilterCount(option(projects, "stale"), projects)).toBe(1);
  });

  // Field counts come from the snapshot every row is built from, so this one is answerable
  // whenever the rail has anything in it at all.
  it("can always answer the field-count question", () => {
    const projects = [project("A", { adoption: undefined, latestIssueUpdatedAt: null, uniqueIssueCount: null })];
    expect(option(projects, "over-configured").measurable).toBe(true);
    expect(option(projects, "all").measurable).toBe(true);
  });
});

describe("ProjectsTabView — an unanswerable filter", () => {
  const project = (key, over = {}) => ({
    projectId: key, projectKey: key, projectName: key,
    fieldCount: 20, totalIssueCount: 5000, uniqueIssueCount: 500,
    latestIssueUpdatedAt: new Date().toISOString(), ...over,
  });
  const data = { projects: [project("A"), project("B")], selectedProject: null, fields: [], availableTypes: [], totalFields: 0, page: 1, totalPages: 1 };
  const noop = () => {};

  const render_ = (props = {}) => render(<ProjectsTabView
    data={data} loading={false} selectedProjectId="A" onSelectProject={noop}
    projectQuery="" onProjectQueryChange={noop} fieldQuery="" onFieldQueryChange={noop}
    fieldType="all" onFieldTypeChange={noop} fieldSort="issues-desc" onFieldSortChange={noop}
    onChangePage={noop} projectFilter="all" onProjectFilterChange={noop} {...props}
  />);

  it("shows a dash rather than a zero", () => {
    const { container } = render_();
    const fellOff = [...container.querySelectorAll(".findings-filter-button")]
      .find((b) => b.textContent.includes("Fell off"));

    expect(fellOff.textContent).toContain("—");
    expect(fellOff.textContent).not.toMatch(/Fell off\s*0/);
  });

  it("will not let a reader select a filter that cannot answer", () => {
    const { container } = render_();
    const fellOff = [...container.querySelectorAll(".findings-filter-button")]
      .find((b) => b.textContent.includes("Fell off"));

    expect(fellOff).toBeDisabled();
    expect(fellOff.getAttribute("title")).toMatch(/Universal Scan/);
  });

  it("keeps a measurable filter clickable", () => {
    const { container } = render_();
    const overConfigured = [...container.querySelectorAll(".findings-filter-button")]
      .find((b) => b.textContent.includes("fields"));

    expect(overConfigured).not.toBeDisabled();
  });

  // Arriving from an Overview deep link before the input exists must explain itself rather
  // than look like an empty site.
  it("explains an empty rail rather than implying nothing matched", () => {
    const { container } = render_({ projectFilter: "fell-off" });
    expect(container.textContent).toMatch(/Universal Scan/);
    expect(container.textContent).not.toMatch(/No project matches/);
  });
});

