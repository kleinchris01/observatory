import React from "react";
import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatTile, StatRow, Panel, Chip, EmptyState, BarList, FindingRow, LinkButton } from "./ui";

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
