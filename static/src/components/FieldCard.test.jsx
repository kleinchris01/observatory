import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke, router } from "@forge/bridge";
import {
  MetricChip,
  FindingBadge,
  FindingsStrip,
  SkeletonFieldCard,
  FieldCard,
  CopyableFieldId,
  CollapsibleSection,
  ProjectUsageBuildBadge,
  AutomationUsageSection,
  ScreenUsageSection,
  IssueTypeUsageSection,
  PeopleUsageSection,
  FilterUsageSection,
  DeletionSafetySection,
  WorkflowRulesSection,
  FieldBehaviourSection,
} from "./FieldCard";

// ---------------------------------------------------------------------------
// CollapsibleSection
// ---------------------------------------------------------------------------
describe("CollapsibleSection", () => {
  it("renders open by default", () => {
    render(<CollapsibleSection title="Contexts"><p>inner</p></CollapsibleSection>);
    expect(screen.getByText("inner")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /contexts/i })).toHaveAttribute("aria-expanded", "true");
  });

  it("hides its body when collapsed", async () => {
    const user = userEvent.setup();
    render(<CollapsibleSection title="Contexts"><p>inner</p></CollapsibleSection>);

    await user.click(screen.getByRole("button", { name: /contexts/i }));

    expect(screen.queryByText("inner")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /contexts/i })).toHaveAttribute("aria-expanded", "false");
  });

  it("can start collapsed", () => {
    render(<CollapsibleSection title="Contexts" defaultOpen={false}><p>inner</p></CollapsibleSection>);
    expect(screen.queryByText("inner")).not.toBeInTheDocument();
  });

  // The actions are their own buttons. Nesting them inside the toggle would be invalid
  // markup, and clicking one would also fold the section away underneath the click.
  it("keeps action buttons outside the toggle and does not collapse when one is used", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <CollapsibleSection title="Findings" actions={<button type="button" onClick={onAction}>Refresh</button>}>
        <p>inner</p>
      </CollapsibleSection>
    );

    const toggle = screen.getByRole("button", { name: /findings/i });
    expect(toggle.querySelector("button")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(onAction).toHaveBeenCalled();
    expect(screen.getByText("inner")).toBeInTheDocument();
  });

  it("shows a badge beside the title when given one", () => {
    render(<CollapsibleSection title="Contexts" badge={7}><p>inner</p></CollapsibleSection>);
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("keeps each section's state separate", async () => {
    const user = userEvent.setup();
    render(
      <>
        <CollapsibleSection title="One"><p>first body</p></CollapsibleSection>
        <CollapsibleSection title="Two"><p>second body</p></CollapsibleSection>
      </>
    );

    await user.click(screen.getByRole("button", { name: /one/i }));

    expect(screen.queryByText("first body")).not.toBeInTheDocument();
    expect(screen.getByText("second body")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AutomationUsageSection
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ScreenUsageSection
// ---------------------------------------------------------------------------
//
// The screens pipeline has existed since #57 and the Field Browser never once asked it a
// question, so the single strongest delete signal this app can produce -- "no form anywhere
// on this site can fill this field" -- was sitting unread in the database.
describe("ScreenUsageSection", () => {
  const result = (over = {}) => ({
    available: true,
    unresolvedScreens: 0,
    screens: [
      { screenId: "100", screenName: "Default Screen", tabId: "1", tabIndex: 0, fieldIndex: 2 },
      { screenId: "220", screenName: "Bug Screen", tabId: "7", tabIndex: 3, fieldIndex: 11 },
    ],
    ...over,
  });

  it("lists each screen with the tab and position the field sits at", () => {
    render(<ScreenUsageSection result={result()} loading={false} />);

    expect(screen.getByText("Default Screen")).toBeInTheDocument();
    expect(screen.getByText("Bug Screen")).toBeInTheDocument();
    expect(screen.getByText("2 screens")).toBeInTheDocument();
  });

  // Membership alone hides the finding. A field on the fourth tab is present and invisible,
  // and only the position says so.
  it("reports position one-indexed, so the first tab reads as 1 rather than 0", () => {
    render(<ScreenUsageSection result={result()} loading={false} />);

    const tabs = screen.getAllByText("Tab").map((el) => el.parentElement.textContent);
    expect(tabs).toContain("Tab1");
    expect(tabs).toContain("Tab4");
  });

  // The distinction the whole section turns on.
  it("never says a field is on no screen when no inventory has been built", () => {
    render(<ScreenUsageSection result={{ available: false, reason: "No screen inventory has been built yet.", screens: [] }} loading={false} />);

    expect(screen.getByText(/No screen inventory has been built yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/no user can fill it/i)).not.toBeInTheDocument();
  });

  it("states the consequence when the inventory exists and the field is on nothing", () => {
    render(<ScreenUsageSection result={result({ screens: [] })} loading={false} />);
    expect(screen.getByText(/no user can fill it through a form/i)).toBeInTheDocument();
  });

  // A build that could not read part of the catalog cannot support "on no screen" as a
  // conclusion, and the copy has to stop short of it.
  it("withdraws the conclusion when part of the catalog could not be read", () => {
    render(<ScreenUsageSection result={result({ screens: [], unresolvedScreens: 30 })} loading={false} />);

    expect(screen.getByText(/not conclusive/i)).toBeInTheDocument();
    expect(screen.queryByText(/Automation and integrations can still write/i)).not.toBeInTheDocument();
  });

  it("caveats a populated list when the catalog was read incompletely", () => {
    render(<ScreenUsageSection result={result({ unresolvedScreens: 30 })} loading={false} />);
    expect(screen.getByText(/this list may be incomplete/i)).toBeInTheDocument();
  });

  it("shows a loading state rather than an empty conclusion while fetching", () => {
    render(<ScreenUsageSection result={null} loading />);

    expect(screen.getByText(/Loading screen usage/i)).toBeInTheDocument();
    expect(screen.queryByText(/no user can fill it/i)).not.toBeInTheDocument();
  });
});

describe("IssueTypeUsageSection", () => {
  it("lists each issue type the field carries a value on, biggest first", () => {
    render(<IssueTypeUsageSection usage={[
      { issueTypeId: "10001", issueTypeName: "Bug", issueCount: 40 },
      { issueTypeId: "10002", issueTypeName: "Task", issueCount: 5 },
    ]} />);

    expect(screen.getByText("Bug")).toBeInTheDocument();
    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.getByText("2 types")).toBeInTheDocument();
  });

  // Same tri-state discipline as Screen Usage: an empty list is "not measured", never
  // "used on no type".
  it("never claims zero-type usage when the crawl has not measured it", () => {
    render(<IssueTypeUsageSection usage={[]} />);
    expect(screen.getByText(/has not recorded which issue types/i)).toBeInTheDocument();
  });

  it("treats a missing prop the same as an empty list", () => {
    render(<IssueTypeUsageSection usage={undefined} />);
    expect(screen.getByText(/Run a full scan to populate it/i)).toBeInTheDocument();
  });
});

describe("PeopleUsageSection", () => {
  it("lists the top holders with a distinct-user badge and flags an unlicensed account", () => {
    render(<PeopleUsageSection usage={{
      distinctUsers: 42, issueTotal: 500,
      top: [
        { accountId: "acc-1", displayName: "Ann Admin", issueCount: 30, onRoster: true },
        { accountId: "acc-gone", displayName: "Ghost", issueCount: 4, onRoster: false },
      ],
    }} />);

    expect(screen.getByText("Ann Admin")).toBeInTheDocument();
    expect(screen.getByText("42 distinct")).toBeInTheDocument();
    expect(screen.getByText("not licensed")).toBeInTheDocument();
    expect(screen.getByText(/Showing the top 2 of 42 people/i)).toBeInTheDocument();
  });

  it("says 'not measured / not a user field' rather than claiming zero", () => {
    render(<PeopleUsageSection usage={{ distinctUsers: 0, top: [] }} />);
    expect(screen.getByText(/no user values for this field/i)).toBeInTheDocument();
  });
});

describe("FieldBehaviourSection", () => {
  const field = { id: "customfield_1", name: "Total Cost" };
  beforeEach(() => { invoke.mockReset(); });

  it("on field schemes, names where the field is required and where it does not exist", async () => {
    invoke.mockResolvedValue({
      available: true, source: "field-schemes", requiredIn: 1,
      missingFrom: [{ id: "fs:3", name: "Ops" }],
      owners: [
        { ownerKind: "scheme", id: "fs:2", name: "Build", projectCount: 1, projectKeys: ["BLD"], measured: true, associated: true, required: true, restrictedTo: ["Build Deviation"], overrides: [{ workTypeName: "Bug", required: false }] },
        { ownerKind: "scheme", id: "fs:3", name: "Ops", projectCount: 2, projectKeys: ["OPS"], measured: true, associated: false },
      ],
    });
    render(<FieldBehaviourSection field={field} />);
    expect(await screen.findByText("Build")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("getFieldBehaviour", { fieldId: "customfield_1" });
    expect(screen.getByText("required")).toBeInTheDocument();
    expect(screen.getByText("only Build Deviation")).toBeInTheDocument();
    expect(screen.getByText("Bug: optional")).toBeInTheDocument();
    expect(screen.getByText("not in this scheme")).toBeInTheDocument();
    expect(screen.getByText("required in 1 · absent from 1")).toBeInTheDocument();
  });

  it("on legacy configurations, warns about a required field that is hidden", async () => {
    invoke.mockResolvedValue({
      available: true, source: "field-configurations", requiredIn: 1, hiddenIn: 1,
      conflicts: [{ id: "fc:2", name: "Build fields" }],
      owners: [{ ownerKind: "config", id: "fc:2", name: "Build fields", measured: true, required: true, hidden: true, routes: [{ schemeName: "Build scheme", workTypeName: "Default" }] }],
    });
    render(<FieldBehaviourSection field={field} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Required but hidden in Build fields/);
    expect(screen.getByText("hidden")).toHaveClass("ui-chip--critical");
    expect(screen.getByRole("button", { name: /Field Configurations/ })).toBeInTheDocument();
  });

  it("an unbuilt or failed lookup is unknown, never 'nothing'", async () => {
    invoke.mockRejectedValueOnce(new Error("down"));
    render(<FieldBehaviourSection field={field} />);
    expect(await screen.findByText(/where this field is required or hidden is unknown/)).toBeInTheDocument();
  });

  it("does not query until the card is expanded", () => {
    render(<FieldBehaviourSection field={field} enabled={false} />);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("WorkflowRulesSection", () => {
  const field = { id: "customfield_15731", name: "Onsite Modification" };
  const usage = {
    available: true, total: 2, workflowCount: 2, refType: "field", refId: "customfield_15731",
    usages: [
      {
        workflowName: "Build Deviation WF", source: "rule",
        transition: { id: "21", name: "Approve", from: [{ id: "3", name: "In Review" }], to: { id: "4", name: "Approved" } },
        status: null, rule: { kind: "validator", key: "system:validate-field-value", label: "Field value check", summary: "fieldRequired" }, property: null,
      },
      {
        workflowName: "Other WF", source: "property", transition: null, status: { id: "3", name: "In Review" },
        rule: null, property: { key: "jira.permission.edit.groupCF", value: "customfield_15731", meaning: "Edit: only group in field customfield_15731" },
      },
    ],
  };

  beforeEach(() => { invoke.mockReset(); });

  it("asks by field id and names the transition, its statuses and the rule", async () => {
    invoke.mockResolvedValue(usage);
    render(<WorkflowRulesSection field={field} siteOrigin="https://acme.atlassian.net" />);

    expect(await screen.findByText("Approve")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("getWorkflowRuleUsage", { refType: "field", refId: "customfield_15731" });
    expect(screen.getByText("Field value check")).toBeInTheDocument();
    expect(screen.getByText("Status: In Review")).toBeInTheDocument();
    expect(screen.getByText("Edit: only group in field customfield_15731")).toBeInTheDocument();
    expect(screen.getByText("2 in 2 workflows")).toBeInTheDocument();
  });

  it("does not query until the card is expanded", () => {
    render(<WorkflowRulesSection field={field} enabled={false} />);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("says nothing was found only when it looked", async () => {
    invoke.mockResolvedValueOnce({ ...usage, total: 0, workflowCount: 0, usages: [] });
    const { unmount } = render(<WorkflowRulesSection field={field} />);
    expect(await screen.findByText(/No workflow validator, condition, post-function or status property names this field/)).toBeInTheDocument();
    unmount();

    invoke.mockRejectedValueOnce(new Error("down"));
    render(<WorkflowRulesSection field={field} />);
    expect(await screen.findByText(/whether a workflow rule uses this is unknown/)).toBeInTheDocument();
  });
});

describe("AutomationUsageSection", () => {
  const field = { id: "customfield_10001", name: "Story Points" };

  const usage = (over = {}) => ({
    available: true,
    referenced: true,
    label: "Story Points",
    write: { count: 2, rules: [{ id: 10, name: "Populate points", enabled: true }, { id: 11, name: "Copy to subtasks", enabled: false }] },
    read: { count: 1, rules: [{ id: 12, name: "Check points set", enabled: true }] },
    trigger: { count: 0, rules: [] },
    ...over,
  });

  beforeEach(() => {
    invoke.mockReset();
  });

  it("asks for the field by both id and name", async () => {
    invoke.mockResolvedValue(usage());
    render(<AutomationUsageSection field={field} />);

    await screen.findByText("Populate points");
    expect(invoke).toHaveBeenCalledWith("getAutomationFieldUsage", {
      fieldId: "customfield_10001", fieldName: "Story Points",
    });
  });

  it("does not query until the card is expanded", () => {
    render(<AutomationUsageSection field={field} enabled={false} />);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("names the rules, grouped by direction", async () => {
    invoke.mockResolvedValue(usage());
    render(<AutomationUsageSection field={field} />);

    expect(await screen.findByText("Writes this field")).toBeInTheDocument();
    expect(screen.getByText("Populate points")).toBeInTheDocument();
    expect(screen.getByText("Reads this field")).toBeInTheDocument();
    expect(screen.getByText("Check points set")).toBeInTheDocument();
  });

  // Direction is the actionable part: writes block a deletion, reads only break.
  it("states the consequence of each direction, not just a count", async () => {
    invoke.mockResolvedValue(usage());
    render(<AutomationUsageSection field={field} />);

    expect(await screen.findByText(/Deleting the field breaks these rules/i)).toBeInTheDocument();
    expect(screen.getByText(/check the field in a condition/i)).toBeInTheDocument();
  });

  it("omits directions with no rules rather than showing an empty group", async () => {
    invoke.mockResolvedValue(usage());
    render(<AutomationUsageSection field={field} />);

    await screen.findByText("Writes this field");
    expect(screen.queryByText("Triggers on this field")).not.toBeInTheDocument();
  });

  it("marks disabled rules, since they are not currently a dependency", async () => {
    invoke.mockResolvedValue(usage());
    const { container } = render(<AutomationUsageSection field={field} />);

    await screen.findByText("Copy to subtasks");
    const disabled = container.querySelector(".automation-usage__rule--disabled");
    expect(disabled.textContent).toContain("Copy to subtasks");
  });

  it("summarises the total on the section header", async () => {
    invoke.mockResolvedValue(usage());
    render(<AutomationUsageSection field={field} />);
    expect(await screen.findByText("3 rules")).toBeInTheDocument();
  });

  it("says plainly when no rule touches the field", async () => {
    invoke.mockResolvedValue({ available: true, referenced: false });
    render(<AutomationUsageSection field={field} />);
    expect(await screen.findByText(/No automation rule reads, writes or triggers on this field/i)).toBeInTheDocument();
  });

  // The distinction the pillar exists for. "Nobody has looked" must never render as
  // "nothing uses it" -- that is the false reassurance that gets a field deleted.
  it("distinguishes an unbuilt analysis from a field nothing uses", async () => {
    invoke.mockResolvedValue({ available: false, reason: "no-analysis" });
    render(<AutomationUsageSection field={field} />);

    expect(await screen.findByText(/automation usage is unknown for this field/i)).toBeInTheDocument();
    expect(screen.queryByText(/No automation rule reads, writes or triggers/i)).not.toBeInTheDocument();
  });

  it("reports a failed lookup instead of implying the field is unused", async () => {
    invoke.mockRejectedValue(new Error("kvs down"));
    render(<AutomationUsageSection field={field} />);

    expect(await screen.findByText(/Could not check automation rules/i)).toBeInTheDocument();
    expect(screen.queryByText(/No automation rule reads/i)).not.toBeInTheDocument();
  });

  // `defaultOpen` seeds useState on the first render, before the fetch returns. Keying it
  // to the loaded data left the section permanently shut with its content unreachable.
  it("is open once the data arrives, not stuck on its first-render state", async () => {
    invoke.mockResolvedValue(usage());
    render(<AutomationUsageSection field={field} />);

    expect(await screen.findByText("Populate points")).toBeVisible();
    expect(screen.getByRole("button", { name: /automation usage/i })).toHaveAttribute("aria-expanded", "true");
  });

  it("can still be collapsed by the reader", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue(usage());
    render(<AutomationUsageSection field={field} />);
    await screen.findByText("Populate points");

    await user.click(screen.getByRole("button", { name: /automation usage/i }));

    expect(screen.queryByText("Populate points")).not.toBeInTheDocument();
  });

  describe("rule links", () => {
    const siteOrigin = "https://example.atlassian.net";

    it("links each rule to its page in Jira automation", async () => {
      invoke.mockResolvedValue(usage());
      render(<AutomationUsageSection field={field} siteOrigin={siteOrigin} />);

      const link = await screen.findByRole("link", { name: "Populate points" });
      expect(link).toHaveAttribute("href", "https://example.atlassian.net/jira/settings/automation#/rule/10");
      expect(link).toHaveAttribute("target", "_blank");
    });

    // The origin comes from the Forge view context and is occasionally absent. A dead
    // anchor that does nothing on click is worse than a plain label.
    it("renders plain text when the site origin is unknown", async () => {
      invoke.mockResolvedValue(usage());
      render(<AutomationUsageSection field={field} siteOrigin="" />);

      expect(await screen.findByText("Populate points")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Populate points" })).not.toBeInTheDocument();
    });

    // Forge iframes cannot navigate the parent window, so the anchor is intercepted and
    // handed to router.open instead.
    it("opens through the Forge router rather than navigating the iframe", async () => {
      const user = userEvent.setup();
      invoke.mockResolvedValue(usage());
      render(<AutomationUsageSection field={field} siteOrigin={siteOrigin} />);

      await user.click(await screen.findByRole("link", { name: "Populate points" }));

      expect(router.open).toHaveBeenCalledWith("https://example.atlassian.net/jira/settings/automation#/rule/10");
    });

    it("names a rule the directory could not resolve, and still links it", async () => {
      invoke.mockResolvedValue(usage({ write: { count: 1, rules: [{ id: 99, name: "", enabled: null }] } }));
      render(<AutomationUsageSection field={field} siteOrigin={siteOrigin} />);

      const link = await screen.findByRole("link", { name: "Rule 99" });
      expect(link).toHaveAttribute("href", expect.stringContaining("/rule/99"));
    });
  });

  it("says when the stored rule list is truncated", async () => {
    invoke.mockResolvedValue(usage({ write: { count: 65, rules: [{ id: 1, name: "A", enabled: true }] } }));
    render(<AutomationUsageSection field={field} />);
    expect(await screen.findByText("Showing 1 of 65.")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// MetricChip
// ---------------------------------------------------------------------------
describe("MetricChip", () => {
  it("renders the label and value", () => {
    render(<MetricChip label="Issues" value={42} />);
    expect(screen.getByText("Issues")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("applies the default neutral tone class", () => {
    const { container } = render(<MetricChip label="L" value="V" />);
    expect(container.firstChild).toHaveClass("metric-chip--neutral");
  });

  it("applies the specified tone class", () => {
    const { container } = render(<MetricChip label="L" value="V" tone="success" />);
    expect(container.firstChild).toHaveClass("metric-chip--success");
  });
});

// ---------------------------------------------------------------------------
// FindingBadge
// ---------------------------------------------------------------------------
describe("FindingBadge", () => {
  it("renders the label text", () => {
    render(<FindingBadge label="Risk" tone="danger" />);
    expect(screen.getByText("Risk")).toBeInTheDocument();
  });

  it("applies the correct tone class for danger", () => {
    const { container } = render(<FindingBadge label="Risk" tone="danger" />);
    expect(container.firstChild).toHaveClass("finding-badge--danger");
  });

  it("applies the correct tone class for warn", () => {
    const { container } = render(<FindingBadge label="Cleanup" tone="warn" />);
    expect(container.firstChild).toHaveClass("finding-badge--warn");
  });

  it("applies the correct tone class for info", () => {
    const { container } = render(<FindingBadge label="Standardize" tone="info" />);
    expect(container.firstChild).toHaveClass("finding-badge--info");
  });
});

// ---------------------------------------------------------------------------
// FindingsStrip
// ---------------------------------------------------------------------------
describe("FindingsStrip", () => {
  // Deliberately still renders the (empty) strip rather than nothing: a flagged card and a
  // clean card have to reserve the same row in a card list, or the list reads as a column of
  // mismatched heights purely because some cards had nothing to flag. See .findings-strip's
  // min-height, which is what actually does the reserving.
  it("renders an empty strip, not nothing, when findings is null", () => {
    const { container } = render(<FindingsStrip findings={null} />);
    expect(container.firstChild).not.toBeNull();
    expect(container.querySelector(".findings-strip")).toBeInTheDocument();
    expect(container.querySelector(".findings-strip").children).toHaveLength(0);
  });

  it("renders an empty strip, not nothing, when findings has no tags", () => {
    const { container } = render(<FindingsStrip findings={{}} />);
    expect(container.querySelector(".findings-strip")).toBeInTheDocument();
    expect(container.querySelector(".findings-strip").children).toHaveLength(0);
  });

  it("renders Admin Attention badge when adminAttention tag is set", () => {
    render(<FindingsStrip findings={{ tags: { adminAttention: true } }} />);
    expect(screen.getByText("Admin Attention")).toBeInTheDocument();
  });

  it("renders Risk badge when risky tag is set", () => {
    render(<FindingsStrip findings={{ tags: { risky: true } }} />);
    expect(screen.getByText("Risk")).toBeInTheDocument();
  });

  it("renders Cleanup badge when cleanup tag is set", () => {
    render(<FindingsStrip findings={{ tags: { cleanup: true } }} />);
    expect(screen.getByText("Cleanup")).toBeInTheDocument();
  });

  it("renders Standardize badge when standardize tag is set", () => {
    render(<FindingsStrip findings={{ tags: { standardize: true } }} />);
    expect(screen.getByText("Standardize")).toBeInTheDocument();
  });

  it("renders multiple badges at once", () => {
    render(<FindingsStrip findings={{ tags: { risky: true, cleanup: true } }} />);
    expect(screen.getByText("Risk")).toBeInTheDocument();
    expect(screen.getByText("Cleanup")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// SkeletonFieldCard
// ---------------------------------------------------------------------------
describe("SkeletonFieldCard", () => {
  it("renders without crashing", () => {
    const { container } = render(<SkeletonFieldCard />);
    expect(container.firstChild).not.toBeNull();
  });

  it("has the skel-field-card class", () => {
    const { container } = render(<SkeletonFieldCard />);
    expect(container.firstChild).toHaveClass("skel-field-card");
  });

  it("renders skeleton placeholder elements", () => {
    const { container } = render(<SkeletonFieldCard />);
    const skels = container.querySelectorAll(".skel");
    expect(skels.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// FieldCard
// ---------------------------------------------------------------------------
describe("FieldCard", () => {
  const mockField = {
    id: "customfield_10001",
    name: "Test Field",
    type: "text",
    origin: "custom",
    contextCount: 2,
    issueCount: 100,
    activeProjectCount: 3,
    findings: [],
  };

  const defaultProps = {
    field: mockField,
    details: null,
    expanded: false,
    loading: false,
    selected: false,
    onSelectChange: vi.fn(),
    onToggle: vi.fn(),
    onProjectUsagePageChange: vi.fn(),
    onRefreshProjectUsage: vi.fn(),
    onAskField: vi.fn(),
    onAskProject: vi.fn(),
    siteOrigin: "https://example.atlassian.net",
    rovoEnabled: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the field name", () => {
    render(<FieldCard {...defaultProps} />);
    expect(screen.getByText("Test Field")).toBeInTheDocument();
  });

  it("renders the field id", () => {
    render(<FieldCard {...defaultProps} />);
    expect(screen.getByText("customfield_10001")).toBeInTheDocument();
  });

  it("renders a checkbox for selection", () => {
    render(<FieldCard {...defaultProps} />);
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();
  });

  it("renders the field type metric chip", () => {
    render(<FieldCard {...defaultProps} />);
    expect(screen.getByText("Type")).toBeInTheDocument();
    expect(screen.getByText("text")).toBeInTheDocument();
  });

  it("does not render expanded body when expanded=false", () => {
    render(<FieldCard {...defaultProps} expanded={false} />);
    expect(screen.queryByText("Governance Findings")).not.toBeInTheDocument();
  });

  it("renders expanded body with loading state when expanded=true and loading=true but no details", () => {
    render(<FieldCard {...defaultProps} expanded={true} loading={true} />);
    expect(screen.getByText("Loading field contexts and project usage...")).toBeInTheDocument();
  });

  it("renders 'no details' state when expanded=true and details=null and not loading", () => {
    render(<FieldCard {...defaultProps} expanded={true} loading={false} />);
    expect(screen.getByText("No field details are available.")).toBeInTheDocument();
  });

  describe("automation rule count chips", () => {
    it("shows enabled and disabled rule counts on the collapsed header", () => {
      render(<FieldCard {...defaultProps} automationCounts={{ enabled: 46, disabled: 12, total: 58 }} />);

      expect(screen.getByText("Active rules")).toBeInTheDocument();
      expect(screen.getByText("46")).toBeInTheDocument();
      expect(screen.getByText("Disabled rules")).toBeInTheDocument();
      expect(screen.getByText("12")).toBeInTheDocument();
    });

    // The chip answers "can I delete this field". A live rule writing it means no, so the
    // tone is applied on any non-zero count and withheld at zero.
    it("tones the active count only when rules actually run", () => {
      const { container, rerender } = render(
        <FieldCard {...defaultProps} automationCounts={{ enabled: 3, disabled: 0, total: 3 }} />
      );
      expect(container.querySelector(".metric-chip--danger")).toBeTruthy();

      rerender(<FieldCard {...defaultProps} automationCounts={{ enabled: 0, disabled: 4, total: 4 }} />);
      expect(container.querySelector(".metric-chip--danger")).toBeNull();
    });

    // "Never measured" is not "nothing uses it", and only one of those makes a field safe
    // to delete. An em dash says the first; a zero would assert the second.
    it("renders an em dash rather than zero when no analysis has been built", () => {
      const { container } = render(<FieldCard {...defaultProps} automationCounts={undefined} />);

      const chips = [...container.querySelectorAll(".metric-chip")]
        .filter((c) => /rules/i.test(c.textContent));
      expect(chips).toHaveLength(2);
      for (const chip of chips) expect(chip.textContent).toContain("—");
    });

    it("shows zero when the analysis exists and nothing references the field", () => {
      render(<FieldCard {...defaultProps} automationCounts={{ enabled: 0, disabled: 0, total: 0 }} />);
      const zeros = screen.getAllByText("0");
      expect(zeros.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("expanded body sections", () => {
    const details = {
      configuredProjectCount: 3,
      activeProjectCount: 2,
      totalIssueCount: 1200,
      fieldJql: 'cf[10001] is not EMPTY',
      refreshedAt: 1754400000000,
      projectUsagePage: 1,
      projectUsageTotalPages: 1,
      contexts: [
        { id: "ctx-1", name: "Global context", isGlobalContext: true, isAnyIssueType: true, issueTypeCount: 5, projects: [], description: "" },
      ],
      projects: [
        { projectId: "10015", projectKey: "CAVPSE", projectName: "Advanced Connected Vehicle", issueCount: 900, jql: "project = CAVPSE" },
      ],
      findings: { tags: {}, reasons: [] },
    };

    beforeEach(() => {
      invoke.mockResolvedValue({ available: true, referenced: false });
    });

    it("renders every detail section as a collapsible toggle", async () => {
      render(<FieldCard {...defaultProps} expanded details={details} />);

      // Field-Wide Query is deliberately absent: it is one link and a count, promoted to the
      // top of the card rather than hidden behind a header, a chevron and a collapsed state.
      for (const title of ["Governance Findings", "Automation Usage", "Contexts", "Project Usage"]) {
        expect(await screen.findByRole("button", { name: new RegExp(title, "i") })).toHaveAttribute("aria-expanded", "true");
      }
    });

    it("folds one section away without touching the others", async () => {
      const user = userEvent.setup();
      render(<FieldCard {...defaultProps} expanded details={details} />);
      await screen.findByText("No contexts were returned for this field.", { exact: false }).catch(() => {});

      await user.click(screen.getByRole("button", { name: /^Contexts/i }));

      expect(screen.getByRole("button", { name: /^Contexts/i })).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByRole("button", { name: /^Project Usage/i })).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("CAVPSE")).toBeInTheDocument();
    });

    it("keeps the section actions working while collapsed is available", async () => {
      const user = userEvent.setup();
      const onRefreshProjectUsage = vi.fn();
      render(<FieldCard {...defaultProps} expanded details={details} onRefreshProjectUsage={onRefreshProjectUsage} />);

      await user.click(screen.getByRole("button", { name: "Refresh usage" }));

      expect(onRefreshProjectUsage).toHaveBeenCalledWith("customfield_10001", 1);
      expect(screen.getByRole("button", { name: /Governance Findings/i })).toHaveAttribute("aria-expanded", "true");
    });

    it("queries automation usage for the expanded field", async () => {
      render(<FieldCard {...defaultProps} expanded details={details} />);

      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("getAutomationFieldUsage", {
          fieldId: "customfield_10001",
          fieldName: "Test Field",
        })
      );
    });

    it("omits the automation section outside the governance context", async () => {
      render(<FieldCard {...defaultProps} expanded details={details} showGovernance={false} />);

      await waitFor(() => expect(screen.getByRole("button", { name: /Contexts/i })).toBeInTheDocument());
      expect(screen.queryByRole("button", { name: /Automation Usage/i })).not.toBeInTheDocument();
      expect(invoke).not.toHaveBeenCalledWith("getAutomationFieldUsage", expect.anything());
    });
  });

  it("is collapsed by default (no open class)", () => {
    const { container } = render(<FieldCard {...defaultProps} />);
    const article = container.querySelector("article");
    expect(article).not.toHaveClass("field-card--open");
  });

  it("has field-card--open class when expanded=true", () => {
    const { container } = render(<FieldCard {...defaultProps} expanded={true} />);
    const article = container.querySelector("article");
    expect(article).toHaveClass("field-card--open");
  });

  it("shows selected checkbox when selected=true", () => {
    render(<FieldCard {...defaultProps} selected={true} />);
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeChecked();
  });
});

// ---------------------------------------------------------------------------
// CopyFieldIdButton
// ---------------------------------------------------------------------------
describe("CopyableFieldId", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  function stubClipboard(impl) {
    const writeText = vi.fn(impl);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    return writeText;
  }

  it("copies the field id to the clipboard on click", async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard(() => Promise.resolve());
    render(<CopyableFieldId fieldId="customfield_10001" />);

    await user.click(screen.getByRole("button", { name: /copy field id customfield_10001/i }));

    expect(writeText).toHaveBeenCalledWith("customfield_10001");
  });

  it("shows transient confirmation after a successful copy", async () => {
    const user = userEvent.setup();
    stubClipboard(() => Promise.resolve());
    render(<CopyableFieldId fieldId="customfield_10001" />);

    await user.click(screen.getByRole("button", { name: /copy field id/i }));

    expect(await screen.findByRole("status")).toHaveTextContent("Copied");
  });

  it("surfaces a failure state when the clipboard write is rejected and the fallback fails", async () => {
    const user = userEvent.setup();
    stubClipboard(() => Promise.reject(new Error("blocked by permissions policy")));
    document.execCommand = vi.fn().mockReturnValue(false);
    render(<CopyableFieldId fieldId="customfield_10001" />);

    await user.click(screen.getByRole("button", { name: /copy field id/i }));

    expect(await screen.findByText("Copy failed", { selector: ".copy-field-id__note" })).toBeInTheDocument();
  });

  it("falls back to execCommand when navigator.clipboard is unavailable", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true, writable: true });
    document.execCommand = vi.fn().mockReturnValue(true);
    render(<CopyableFieldId fieldId="customfield_10001" />);

    await user.click(screen.getByRole("button", { name: /copy field id/i }));

    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(await screen.findByRole("status")).toHaveTextContent("Copied");
  });

  // The control lives inside the card-header button that expands the panel; copying
  // must never also toggle the card.
  it("does not bubble its click to a parent handler", async () => {
    const user = userEvent.setup();
    stubClipboard(() => Promise.resolve());
    const onParentClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <CopyableFieldId fieldId="customfield_10001" />
      </div>
    );

    await user.click(screen.getByRole("button", { name: /copy field id/i }));

    expect(onParentClick).not.toHaveBeenCalled();
  });

  // The id is the value on the page, not a label on a button that stands in for it.
  it("keeps the field id visible at rest", () => {
    render(<CopyableFieldId fieldId="customfield_10001" />);
    expect(screen.getByText("customfield_10001")).toBeInTheDocument();
  });

  it("keeps the field id visible after a successful copy", async () => {
    const user = userEvent.setup();
    stubClipboard(() => Promise.resolve());
    render(<CopyableFieldId fieldId="customfield_10001" />);

    await user.click(screen.getByRole("button", { name: /copy field id/i }));

    expect(await screen.findByRole("status")).toHaveTextContent("Copied");
    expect(screen.getByText("customfield_10001")).toBeInTheDocument();
  });

  it("keeps the field id visible after a failed copy", async () => {
    const user = userEvent.setup();
    stubClipboard(() => Promise.reject(new Error("blocked")));
    document.execCommand = vi.fn().mockReturnValue(false);
    render(<CopyableFieldId fieldId="customfield_10001" />);

    await user.click(screen.getByRole("button", { name: /copy field id/i }));

    expect(await screen.findByText("Copy failed", { selector: ".copy-field-id__note" })).toBeInTheDocument();
    expect(screen.getByText("customfield_10001")).toBeInTheDocument();
  });

  it("is keyboard operable via Enter", async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard(() => Promise.resolve());
    render(<CopyableFieldId fieldId="customfield_10001" />);

    await user.tab();
    await user.keyboard("{Enter}");

    expect(writeText).toHaveBeenCalledWith("customfield_10001");
  });
});

describe("FieldCard copy affordance", () => {
  it("renders the field id as a copy control without hiding the id", () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
      writable: true,
    });
    render(
      <FieldCard
        field={{ id: "customfield_10001", name: "Test Field", type: "text", activeProjectCount: 3 }}
        details={null}
        expanded={false}
        loading={false}
        selected={false}
        onSelectChange={vi.fn()}
        onToggle={vi.fn()}
        onProjectUsagePageChange={vi.fn()}
        onRefreshProjectUsage={vi.fn()}
        onAskField={vi.fn()}
        onAskProject={vi.fn()}
        siteOrigin="https://example.atlassian.net"
        rovoEnabled={false}
      />
    );
    expect(screen.getByRole("button", { name: /copy field id customfield_10001/i })).toBeInTheDocument();
    expect(screen.getByText("customfield_10001")).toBeInTheDocument();
  });
});

// Two things the card got wrong on screen.
describe("FieldCard — header metrics and the field-wide query", () => {
  const details = {
    field: { id: "customfield_11322", name: "CAE Program", type: "select" },
    configuredProjectCount: undefined, // the payload that caused the blank
    activeProjectCount: 129,
    totalIssueCount: 319776,
    fieldJql: 'cf[11322] is not EMPTY',
    contexts: [],
    projects: [],
    projectUsagePage: 1,
    projectUsageTotalPages: 1,
    projectUsagePageSize: 10,
    projectUsageTotalProjects: 0,
  };
  const field = { id: "customfield_11322", name: "CAE Program", type: "select", configuredProjectCount: 138 };

  // The bug: expanding a card blanked the count. Collapsed it came from the field row;
  // expanded, the ternary switched to details.configuredProjectCount and rendered nothing,
  // so opening a card removed a number that had been on screen a moment earlier.
  it("keeps the configured-project count when the details payload omits it", () => {
    render(<FieldCard
      field={field}
      details={details}
      expanded
      onToggle={vi.fn()}
      onSelectChange={vi.fn()}
      onProjectUsagePageChange={vi.fn()}
      onRefreshProjectUsage={vi.fn()}
      onAskField={vi.fn()}
      onAskProject={vi.fn()}
    />);

    const chip = screen.getByText("Configured projects").closest(".metric-chip");
    expect(chip).toHaveTextContent("138");
  });

  it("shows the field-wide JQL at the top without a section to open first", () => {
    const { container } = render(<FieldCard
      field={field}
      details={details}
      expanded
      onToggle={vi.fn()}
      onSelectChange={vi.fn()}
      onProjectUsagePageChange={vi.fn()}
      onRefreshProjectUsage={vi.fn()}
      onAskField={vi.fn()}
      onAskProject={vi.fn()}
    />);

    expect(container.querySelector(".field-query-bar")).not.toBeNull();
    expect(screen.getByText("cf[11322] is not EMPTY")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Field-Wide Query/i })).not.toBeInTheDocument();
  });
});

// The badge said the opposite of the numbers beside it, then vanished on expand.
describe("ProjectUsageBuildBadge — never contradict the counts on the same row", () => {
  it("stays silent when the snapshot has already measured the usage", () => {
    const { container } = render(<ProjectUsageBuildBadge field={{
      totalIssueCount: 303233, activeProjectCount: 128, projectUsageState: "unbuilt",
    }} />);
    // "Usage Not Built" beside "128 active projects" is a contradiction, not a caveat.
    expect(container).toBeEmptyDOMElement();
  });

  // Absent is unknown. Turning it into a definite claim is what made every collapsed row
  // assert the badge, and expanding one -- which merges in a details payload that carries
  // the state -- silently withdraw it.
  it("says nothing when the state is unknown rather than assuming not built", () => {
    const { container } = render(<ProjectUsageBuildBadge field={{ totalIssueCount: 500 }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("still reports a genuinely unmeasured field", () => {
    render(<ProjectUsageBuildBadge field={{
      totalIssueCount: 500, activeProjectCount: 0, projectUsageState: "unbuilt",
    }} />);
    expect(screen.getByText(/Usage Not Built/i)).toBeInTheDocument();
  });

  it("still reports a build in flight", () => {
    render(<ProjectUsageBuildBadge field={{
      totalIssueCount: 500, activeProjectCount: 0, projectUsageState: "building",
    }} />);
    expect(screen.getByText(/Usage Building/i)).toBeInTheDocument();
  });
});

// The cross-pillar half that was missing. An automation rule breaking is loud -- it errors,
// it shows in the rule's audit log. A saved filter is not: delete a field forty filters search
// on and every one keeps running and quietly returns a different set of issues.
describe("FilterUsageSection", () => {
  const field = { id: "customfield_10001", name: "Story Points" };

  test("names the filters that would break, and says how they break", async () => {
    invoke.mockResolvedValue({
      available: true, label: "Story Points", kind: "field", total: 2,
      filters: [
        { id: "1", name: "Sprint readiness", ownerName: "Bob", ownerActive: true, subscriptionCount: 0 },
        { id: "2", name: "Weekly rollup", ownerName: "Ann", ownerActive: false, subscriptionCount: 3 },
      ],
    });

    render(<FilterUsageSection field={field} siteOrigin="https://example.atlassian.net" />);

    expect(await screen.findByText("Sprint readiness")).toBeInTheDocument();
    expect(screen.getByText(/quietly return a different set of issues/i)).toBeInTheDocument();
    // A subscription makes the silent failure worse: the wrong answer gets emailed.
    expect(screen.getByText("3 subscriptions")).toBeInTheDocument();
  });

  // "No filter uses this field" is permission to delete it. "We have not looked" is not, and
  // the two must never render the same.
  test("says nobody has looked rather than nothing uses it", async () => {
    invoke.mockResolvedValue({ available: false, reason: "no-inventory", label: "Story Points" });
    render(<FilterUsageSection field={field} />);

    expect(await screen.findByText(/filter usage is unknown for this field/i)).toBeInTheDocument();
  });

  test("reports a genuinely unreferenced field differently", async () => {
    invoke.mockResolvedValue({ available: true, total: 0, filters: [] });
    render(<FilterUsageSection field={field} />);

    expect(await screen.findByText(/No saved filter searches on, or sorts by, this field/i)).toBeInTheDocument();
  });

  test("asks by name, because that is how JQL names a field", async () => {
    invoke.mockResolvedValue({ available: true, total: 0, filters: [] });
    render(<FilterUsageSection field={field} />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("getFilterUsage", { kind: "field", label: "Story Points" }));
  });

  test("does not fetch while the card is collapsed", () => {
    invoke.mockClear();
    render(<FilterUsageSection field={field} enabled={false} />);
    expect(invoke).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DeletionSafetySection
// ---------------------------------------------------------------------------
// The product's whole thesis, in one panel. The strongest claim it is allowed to make is
// "no evidence of use" -- so what is asserted here is mostly the wording, and that a gap is
// never rendered as a clean result.
describe("DeletionSafetySection", () => {
  const field = { id: "customfield_1", name: "Vendor Ref" };

  const answer = (over = {}) => ({
    available: true,
    fields: [{
      fieldId: "customfield_1", fieldName: "Vendor Ref",
      verdict: "no-evidence-of-use",
      headline: "No evidence of use in anything this app can see.",
      blockers: [], gaps: [], checked: ["field usage", "screens"],
      caveat: "Observatory cannot read Marketplace app configuration (ScriptRunner listeners, JMWE post-functions).",
      ...over,
    }],
  });

  // Collapsed by default, and the check is behind a further click inside it: this reads five
  // pillars, and most card opens are not a deletion decision.
  const open = async () => {
    render(<DeletionSafetySection field={field} />);
    await userEvent.click(screen.getByRole("button", { name: /deletion safety/i }));
  };

  const run = async (payload) => {
    invoke.mockResolvedValue(payload);
    await open();
    await userEvent.click(screen.getByRole("button", { name: /check what depends on this field/i }));
  };

  it("does not run until asked — most card opens are not a deletion decision", async () => {
    await open();
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /check what depends on this field/i })).toBeInTheDocument();
  });

  it("never offers the phrase 'safe to delete', even on the cleanest verdict", async () => {
    await run(answer());

    // Twice: the verdict chip, and the headline sentence under it.
    expect((await screen.findAllByText(/no evidence of use/i)).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/safe to delete/i);
  });

  it("shows the Marketplace caveat on a clean verdict, where it matters most", async () => {
    // The clean verdict is the one somebody acts on, so it is the one that has to carry the
    // warning that ScriptRunner is invisible to this app.
    await run(answer());
    expect(await screen.findByText(/ScriptRunner/i)).toBeInTheDocument();
  });

  it("lists each blocker with what it costs", async () => {
    await run(answer({
      verdict: "in-use",
      headline: "In use — 1 reason not to delete this yet.",
      blockers: [{ source: "automation", severity: "high", summary: "2 automation rules write to this field.", detail: "Those rules break on deletion." }],
    }));

    expect(await screen.findByText(/2 automation rules write to this field/)).toBeInTheDocument();
    expect(screen.getByText(/Those rules break on deletion/)).toBeInTheDocument();
  });

  it("keeps what could not be checked separate from what was checked and found clean", async () => {
    await run(answer({
      verdict: "unknown",
      headline: "No evidence of use, but 1 source could not be checked.",
      gaps: [{ source: "automation rules", reason: "No automation analysis has been imported." }],
    }));

    expect(await screen.findByText("Could not be checked")).toBeInTheDocument();
    expect(screen.getByText(/no automation analysis has been imported/i)).toBeInTheDocument();
    expect(screen.getByText(/1 source could not be checked/i)).toBeInTheDocument();
  });

  it("reports why no verdict is possible rather than showing an empty one", async () => {
    await run({ available: false, reason: "No field snapshot has been built yet.", fields: [] });
    expect(await screen.findByText(/no field snapshot has been built yet/i)).toBeInTheDocument();
  });

  it("surfaces a resolver failure without breaking the card", async () => {
    invoke.mockRejectedValueOnce(new Error("resolver exploded"));
    await open();
    await userEvent.click(screen.getByRole("button", { name: /check what depends on this field/i }));
    expect(await screen.findByText(/resolver exploded/i)).toBeInTheDocument();
  });
});
