import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MetricChip,
  FindingBadge,
  FindingsStrip,
  SkeletonFieldCard,
  FieldCard,
  CopyableFieldId,
} from "./FieldCard";

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
