import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import {
  MetricChip,
  FindingBadge,
  FindingsStrip,
  SkeletonFieldCard,
  FieldCard,
  CopyableFieldId,
  CollapsibleSection,
  AutomationUsageSection,
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
  it("renders nothing when findings is null", () => {
    const { container } = render(<FindingsStrip findings={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when findings has no tags", () => {
    const { container } = render(<FindingsStrip findings={{}} />);
    expect(container.firstChild).toBeNull();
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

      for (const title of ["Governance Findings", "Automation Usage", "Field-Wide Query", "Contexts", "Project Usage"]) {
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
