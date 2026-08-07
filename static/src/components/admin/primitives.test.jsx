import React from "react";
import { describe, test, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Toggle, ConfigSection, ConfigRow, ThresholdInput,
  InlineThresholdInput, JobStatusBadge, SubNavLayout, ActivitySection,
} from "./primitives";

// These lived inside admin.jsx and could not be rendered without mounting the whole app,
// which is why none of them had ever been tested. They are small, but they carry the
// admin surface's input handling -- a threshold that silently coerces to NaN, or a toggle
// that reports the wrong new value, corrupts governance config rather than throwing.

// StatCard's tests moved to ui.test.jsx alongside StatTile, which absorbed it.

describe("Toggle", () => {
  test("exposes switch semantics with its checked state", () => {
    render(<Toggle checked onChange={() => {}} />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  // It reports the NEXT value, not the current one. Getting this backwards would make
  // every config toggle a no-op that still looks like it worked.
  test("reports the inverted value on click", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<Toggle checked={false} onChange={onChange} />);

    await userEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);

    onChange.mockClear();
    rerender(<Toggle checked onChange={onChange} />);
    await userEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  test("does not fire while disabled", async () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} disabled />);

    await userEvent.click(screen.getByRole("switch"));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("ThresholdInput", () => {
  test("renders its label bound to the field", () => {
    render(<ThresholdInput label="Min projects" value={10} onChange={() => {}} />);
    expect(screen.getByText("Min projects")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton")).toHaveValue(10);
  });

  test("emits integers for an integer step", async () => {
    const onChange = vi.fn();
    render(<ThresholdInput label="Min projects" value={10} onChange={onChange} />);

    await userEvent.type(screen.getByRole("spinbutton"), "5");
    expect(onChange).toHaveBeenLastCalledWith(105);
  });

  // A cleared field must fall back to the minimum, never to NaN: NaN would be written
  // straight into the governance thresholds and make every downstream comparison false.
  test("falls back to the minimum instead of emitting NaN when cleared", async () => {
    const onChange = vi.fn();
    render(<ThresholdInput label="Min projects" value={10} min={3} onChange={onChange} />);

    await userEvent.clear(screen.getByRole("spinbutton"));
    expect(onChange).toHaveBeenLastCalledWith(3);
  });

  // fireEvent.change, not userEvent.type: this input is controlled by a `value` prop
  // that the test does not update, so typing would re-send one character at a time
  // against an unchanging base. The behaviour under test is the coercion, not the typing.
  test("emits fractional values for a fractional step", () => {
    const onChange = vi.fn();
    render(<ThresholdInput label="Ratio" value={0.7} step="0.05" min={0.1} onChange={onChange} />);

    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0.85" } });
    expect(onChange).toHaveBeenLastCalledWith(0.85);
  });
});

describe("InlineThresholdInput", () => {
  test("emits a number and floors an empty field at the minimum", async () => {
    const onChange = vi.fn();
    render(<InlineThresholdInput value={5} min={2} onChange={onChange} />);

    await userEvent.clear(screen.getByRole("spinbutton"));
    expect(onChange).toHaveBeenLastCalledWith(2);
  });

  test("honours a fractional step", () => {
    const onChange = vi.fn();
    render(<InlineThresholdInput value={0.5} step={0.1} min={0.1} onChange={onChange} />);

    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0.25" } });
    expect(onChange).toHaveBeenLastCalledWith(0.25);
  });
});

describe("JobStatusBadge", () => {
  test.each([
    ["ready", "success"],
    ["building", "building"],
    ["queued", "queued"],
    ["failed", "danger"],
    ["cancelled", "muted"],
    ["unbuilt", "neutral"],
  ])("maps %s to the %s variant", (status, variant) => {
    const { container } = render(<JobStatusBadge status={status} />);
    expect(container.querySelector(`.admin-job-badge--${variant}`)).not.toBeNull();
    expect(screen.getByText(status)).toBeInTheDocument();
  });

  // An unknown status must still render something readable rather than an empty chip.
  test("falls back to unbuilt for a missing or unrecognised status", () => {
    render(<JobStatusBadge status={undefined} />);
    expect(screen.getByText("unbuilt")).toBeInTheDocument();

    const { container } = render(<JobStatusBadge status="something-new" />);
    expect(container.querySelector(".admin-job-badge--neutral")).not.toBeNull();
  });
});

describe("SubNavLayout", () => {
  const items = [
    { key: "snapshot", label: "Snapshot" },
    { key: "universe", label: "Universe Scan" },
  ];

  test("renders an entry per item and marks the active one", () => {
    const { container } = render(
      <SubNavLayout items={items} activeKey="universe" onSelect={() => {}}>
        <p>panel body</p>
      </SubNavLayout>
    );

    expect(screen.getByText("Snapshot")).toBeInTheDocument();
    expect(screen.getByText("panel body")).toBeInTheDocument();
    // Active state must be structural, not just colour.
    expect(container.querySelectorAll("[class*='--active']").length).toBeGreaterThan(0);
  });

  test("reports the selected key", async () => {
    const onSelect = vi.fn();
    render(<SubNavLayout items={items} activeKey="snapshot" onSelect={onSelect}><p>x</p></SubNavLayout>);

    await userEvent.click(screen.getByText("Universe Scan"));
    expect(onSelect).toHaveBeenCalledWith("universe");
  });

  test("renders with no items rather than crashing", () => {
    render(<SubNavLayout items={[]} activeKey={null} onSelect={() => {}}><p>only body</p></SubNavLayout>);
    expect(screen.getByText("only body")).toBeInTheDocument();
  });
});

describe("ActivitySection", () => {
  test("shows its children only when open", () => {
    const { rerender } = render(
      <ActivitySection title="Scan" subtitle="last run" open={false} onToggle={() => {}}>
        <p>details</p>
      </ActivitySection>
    );
    expect(screen.queryByText("details")).not.toBeInTheDocument();

    rerender(
      <ActivitySection title="Scan" subtitle="last run" open onToggle={() => {}}>
        <p>details</p>
      </ActivitySection>
    );
    expect(screen.getByText("details")).toBeInTheDocument();
  });

  test("renders its title, subtitle and actions", () => {
    render(
      <ActivitySection title="Scan" subtitle="last run 2h ago" open onToggle={() => {}}
        actions={<button type="button">Start</button>}>
        <p>details</p>
      </ActivitySection>
    );

    expect(screen.getByText("Scan")).toBeInTheDocument();
    expect(screen.getByText("last run 2h ago")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
  });

  test("toggles when the header is activated", async () => {
    const onToggle = vi.fn();
    render(<ActivitySection title="Scan" open={false} onToggle={onToggle}><p>d</p></ActivitySection>);

    await userEvent.click(screen.getByText("Scan"));
    expect(onToggle).toHaveBeenCalled();
  });
});

describe("ConfigSection / ConfigRow", () => {
  test("ConfigSection renders its title and children", () => {
    render(<ConfigSection title="Thresholds"><p>inner</p></ConfigSection>);
    expect(screen.getByText("Thresholds")).toBeInTheDocument();
    expect(screen.getByText("inner")).toBeInTheDocument();
  });

  test("ConfigRow renders label, hint and control together", () => {
    const { container } = render(
      <ConfigRow label="Read-only mode" hint="Blocks every mutating action">
        <button type="button">toggle</button>
      </ConfigRow>
    );

    expect(screen.getByText("Read-only mode")).toBeInTheDocument();
    expect(screen.getByText("Blocks every mutating action")).toBeInTheDocument();
    expect(within(container).getByRole("button", { name: "toggle" })).toBeInTheDocument();
  });

  test("ConfigRow omits the hint when there is none", () => {
    const { container } = render(<ConfigRow label="Read-only mode"><span>c</span></ConfigRow>);
    expect(container.querySelector(".admin-config-row__hint")).toBeNull();
  });
});
