import React from "react";
import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { router } from "@forge/bridge";
import { StatTile, StatRow, Panel, Chip, EmptyState, BarList, FindingRow, LinkButton, PageHeader, RuleLink, SortFilterBar } from "./ui";

// These are the shared vocabulary that replaced four separate stat-card idioms. They are
// small, but they now render on every tab, so a regression here is a regression
// everywhere -- which is exactly the argument for having them in one place.

describe("StatTile", () => {
  test("renders label, value and hint", () => {
    render(<StatTile label="Statuses" value="435" hint="20 removable" />);
    expect(screen.getByText("Statuses")).toBeInTheDocument();
    expect(screen.getByText("435")).toBeInTheDocument();
    expect(screen.getByText("20 removable")).toBeInTheDocument();
  });

  test("omits the hint entirely when there is nothing to say", () => {
    const { container } = render(<StatTile label="Statuses" value="435" />);
    expect(container.querySelector(".ui-stat__hint")).toBeNull();
  });

  // Tone is meaning, not decoration: it is what makes a row scannable for what needs action.
  test("carries its tone into the class name", () => {
    const { container } = render(<StatTile label="Unreachable" value="7" tone="warning" />);
    expect(container.querySelector(".ui-stat--warning")).not.toBeNull();
  });

  // Inherited from the retired admin StatCard, which owned these two states. If the merge
  // had dropped them the Scans job row would render five identical neutral tiles, losing
  // the at-a-glance difference between "ready" and "failed" that the row exists for.
  test.each([
    ["success", ".ui-stat--success"],
    ["active", ".ui-stat--active"],
    ["critical", ".ui-stat--critical"],
  ])("supports the %s tone absorbed from StatCard", (tone, selector) => {
    const { container } = render(<StatTile label="Ready" value={4} tone={tone} />);
    expect(container.querySelector(selector)).not.toBeNull();
  });

  // Also inherited: a count of zero is a real reading, not a missing one. A job row that
  // hid its zeroes would make "no failures" indistinguishable from "never measured".
  test("renders a zero value rather than treating it as absent", () => {
    render(<StatTile label="Failed" value={0} />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });
});

describe("Panel", () => {
  test("renders a title, description, action and children", async () => {
    const onClick = vi.fn();
    render(
      <Panel title="Workflows" description="Scheme health" action={<LinkButton onClick={onClick}>Open</LinkButton>}>
        <p>body content</p>
      </Panel>
    );

    expect(screen.getByRole("heading", { name: /Workflows/ })).toBeInTheDocument();
    expect(screen.getByText("Scheme health")).toBeInTheDocument();
    expect(screen.getByText("body content")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Open/ }));
    expect(onClick).toHaveBeenCalled();
  });
});

describe("Chip", () => {
  test("renders its content and tone", () => {
    const { container } = render(<Chip tone="critical" title="why">3 issues</Chip>);
    expect(screen.getByText("3 issues")).toBeInTheDocument();
    expect(container.querySelector(".ui-chip--critical")).not.toBeNull();
  });

  // Without onRemove a chip is a label, and labels must not be focusable or announce
  // themselves as controls.
  test("stays a plain span when there is nothing to remove", () => {
    const { container } = render(<Chip>Type: date</Chip>);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("span.ui-chip")).not.toBeNull();
  });

  test("becomes a button that clears the filter when given onRemove", async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(<Chip onRemove={onRemove}>Type: date</Chip>);
    await user.click(screen.getByRole("button"));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  // "Type: date" read aloud on a button says nothing about what activating it does. The
  // Field Browser's own chip had the same gap, which is part of why it was worth absorbing
  // rather than leaving in place.
  test("names the action, not just the filter, for screen readers", () => {
    render(<Chip onRemove={() => {}}>Type: date</Chip>);
    expect(screen.getByRole("button", { name: /remove filter type: date/i })).toBeInTheDocument();
  });
});

describe("EmptyState", () => {
  test("shows the message and an action that fixes it", async () => {
    const onClick = vi.fn();
    render(<EmptyState action={<LinkButton onClick={onClick}>Build</LinkButton>}>No inventory yet.</EmptyState>);

    expect(screen.getByText("No inventory yet.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Build/ }));
    expect(onClick).toHaveBeenCalled();
  });
});

describe("BarList", () => {
  const items = [
    { projectKey: "ALPHA", projectName: "Alpha", count: 90 },
    { projectKey: "BRAVO", projectName: "Bravo", count: 30 },
  ];

  test("renders a row per item with formatted values", () => {
    render(<BarList items={items} labelKey="projectKey" valueKey="count" formatValue={(v) => `${v} issues`} />);
    expect(screen.getByText("ALPHA")).toBeInTheDocument();
    expect(screen.getByText("90 issues")).toBeInTheDocument();
  });

  test("scales bars against the largest value, not the sum", () => {
    const { container } = render(<BarList items={items} labelKey="projectKey" valueKey="count" />);
    const bars = container.querySelectorAll(".ui-barlist__bar");
    expect(bars[0].style.width).toBe("100%");
    // 30 of 90 is a third; scaling against the sum would wrongly render it as a quarter.
    expect(bars[1].style.width).toBe("33.33333333333333%");
  });

  test("shows the supplied empty message instead of an empty chart", () => {
    render(<BarList items={[]} labelKey="projectKey" valueKey="count" emptyMessage="Nothing scanned yet" />);
    expect(screen.getByText("Nothing scanned yet")).toBeInTheDocument();
  });

  // A zero-valued list would divide by zero without the floor, collapsing the layout.
  test("survives a list whose values are all zero", () => {
    const { container } = render(
      <BarList items={[{ projectKey: "ZERO", count: 0 }]} labelKey="projectKey" valueKey="count" />
    );
    expect(container.querySelector(".ui-barlist__bar")).not.toBeNull();
  });
});

describe("FindingRow", () => {
  test("pairs a count with its consequence and control", async () => {
    const onClick = vi.fn();
    render(
      <FindingRow
        tone="warning"
        count="12"
        title="Duplicate statuses"
        detail="Consolidating removes 20."
        action={<LinkButton onClick={onClick}>Workflows</LinkButton>}
      />
    );

    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("Consolidating removes 20.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Workflows/ }));
    expect(onClick).toHaveBeenCalled();
  });

  test("renders without a count when there is no number to lead with", () => {
    const { container } = render(<FindingRow title="Something" />);
    expect(container.querySelector(".ui-finding__count")).toBeNull();
  });

  test("treats a zero count as a value, not as absent", () => {
    render(<FindingRow title="Something" count={0} />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });
});

describe("StatRow", () => {
  test("groups its children", () => {
    const { container } = render(<StatRow><StatTile label="A" value="1" /></StatRow>);
    expect(container.querySelector(".ui-stat-row")).not.toBeNull();
  });
});

// ── PageHeader ──────────────────────────────────────────────────────────────

describe("PageHeader", () => {
  test("renders freshness beside the action rather than as a stat", () => {
    const { container } = render(
      <PageHeader title="Screens" description="What each form contains." meta="Built 18m ago" actions={<button>Rebuild</button>} />
    );

    expect(screen.getByText("Built 18m ago")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rebuild" })).toBeInTheDocument();
    // Both live in the same side region, so every tab puts freshness in one place.
    expect(container.querySelector(".ui-pagehead__side .ui-pagehead__meta")).not.toBeNull();
  });

  test("omits the meta slot entirely when a tab has no freshness to report", () => {
    const { container } = render(<PageHeader title="Fields" />);
    expect(container.querySelector(".ui-pagehead__meta")).toBeNull();
  });
});

// ── SortFilterBar ───────────────────────────────────────────────────────────
//
// Six tabs had grown their own version of this. The rules it enforces are the ones that
// differed between them: a filtered count always states what it is out of, every active
// filter is visible as something you can remove, and "all" is not an active filter.

describe("SortFilterBar", () => {
  const filters = (over = {}) => ([{
    key: "type",
    label: "Type",
    value: "all",
    onChange: vi.fn(),
    options: [{ value: "all", label: "All types" }, { value: "date", label: "Date", count: 12 }],
    ...over,
  }]);

  test("reports a filtered count against the total, so rows never look lost", () => {
    render(<SortFilterBar search="bug" onSearchChange={vi.fn()} resultCount={40} totalCount={760} />);
    expect(screen.getByText(/40 of 760/)).toBeInTheDocument();
  });

  test("shows a bare count when nothing is narrowing the list", () => {
    render(<SortFilterBar search="" onSearchChange={vi.fn()} resultCount={760} totalCount={760} />);
    expect(screen.getByText("760")).toBeInTheDocument();
    expect(screen.queryByText(/of 760/)).not.toBeInTheDocument();
  });

  test("treats the all-value as no filter rather than as an active one", () => {
    const { container } = render(<SortFilterBar search="" onSearchChange={vi.fn()} filters={filters()} />);
    expect(container.querySelector(".ui-chip--removable")).toBeNull();
  });

  test("surfaces an active filter as a chip that clears it", async () => {
    const onChange = vi.fn();
    render(<SortFilterBar search="" onSearchChange={vi.fn()} filters={filters({ value: "date", onChange })} />);

    const chip = screen.getByRole("button", { name: /Clear Type filter/i });
    expect(chip).toHaveTextContent("Type: Date");
    await userEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith("all");
  });

  test("surfaces the search term as its own clearable chip", async () => {
    const onSearchChange = vi.fn();
    render(<SortFilterBar search="payment" onSearchChange={onSearchChange} />);

    await userEvent.click(screen.getByRole("button", { name: /Clear search/i }));
    expect(onSearchChange).toHaveBeenCalledWith("");
  });

  test("gives the search box an accessible name, not just a placeholder", () => {
    render(<SortFilterBar search="" onSearchChange={vi.fn()} searchLabel="Search screens" searchPlaceholder="Search screens by name or id" />);
    expect(screen.getByRole("searchbox", { name: /Search screens/i })).toBeInTheDocument();
  });

  test("emits the sort token the resolvers and the client helper both understand", async () => {
    const onSortChange = vi.fn();
    render(
      <SortFilterBar
        search="" onSearchChange={vi.fn()}
        sort="name-asc" onSortChange={onSortChange}
        sortOptions={[{ value: "name-asc", label: "Name A-Z" }, { value: "fields-desc", label: "Most fields" }]}
      />
    );

    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Sort/i }), "fields-desc");
    expect(onSortChange).toHaveBeenCalledWith("fields-desc");
  });

  test("renders option counts when a caller supplies them", () => {
    render(<SortFilterBar search="" onSearchChange={vi.fn()} filters={filters()} />);
    expect(screen.getByRole("option", { name: "Date (12)" })).toBeInTheDocument();
  });
});

// RuleLink moved here from AutomationTab.jsx when the Workflows tab started rendering one
// too: importing it across tabs would have pulled the whole AutomationTab chunk into the
// Workflows bundle for a single anchor. Its tests came with it.
describe("RuleLink", () => {
  const siteOrigin = "https://example.atlassian.net";

  it("deep links to the rule in Jira automation", () => {
    render(<RuleLink id={28499275} name="Update cost review" siteOrigin={siteOrigin} />);
    expect(screen.getByRole("link", { name: "Update cost review" }))
      .toHaveAttribute("href", "https://example.atlassian.net/jira/settings/automation#/rule/28499275");
  });

  it("falls back to plain text when the site origin is unknown", () => {
    render(<RuleLink id={1} name="Nameless" siteOrigin="" />);
    expect(screen.getByText("Nameless")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("names a rule the directory could not resolve", () => {
    render(<RuleLink id={77} siteOrigin={siteOrigin} />);
    expect(screen.getByRole("link", { name: "Rule 77" })).toBeInTheDocument();
  });

  // Forge iframes cannot navigate the parent window; the click is handed to router.open.
  it("opens through the Forge router rather than navigating the iframe", async () => {
    const user = userEvent.setup();
    render(<RuleLink id={5} name="Any rule" siteOrigin={siteOrigin} />);

    await user.click(screen.getByRole("link", { name: "Any rule" }));

    expect(router.open).toHaveBeenCalledWith("https://example.atlassian.net/jira/settings/automation#/rule/5");
  });
});
