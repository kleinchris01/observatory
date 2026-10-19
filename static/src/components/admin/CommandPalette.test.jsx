import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { CommandPalette, entityIntent, oqlForTerm, buildPaletteItems, readRecent, pushRecent } from "./CommandPalette";

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

const TABS = [
  { key: "overview", label: "Overview", icon: "barChart", group: null },
  { key: "fields", label: "Field Browser", icon: "layers", group: "Pillars" },
  { key: "workflows", label: "Workflows", icon: "activity", group: "Pillars" },
  { key: "search", label: "Search", icon: "sliders", group: "Act" },
  { key: "scans", label: "Scans", icon: "zap", group: "Operate" },
];

const row = (over = {}) => ({
  uid: "fields:customfield_11412",
  pillar: "fields",
  pillarLabel: "Fields",
  name: "Plant",
  id: "customfield_11412",
  kind: null,
  type: null,
  rank: 0,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
});

describe("entityIntent", () => {
  test("opens each pillar on the list that holds its items, already searched", () => {
    expect(entityIntent(row())).toEqual({ search: "Plant" });
    expect(entityIntent(row({ pillar: "workflows", name: "SOLVE WF" }))).toEqual({
      search: "SOLVE WF",
      view: "schemes",
    });
    expect(entityIntent(row({ pillar: "people", name: "Joe" }))).toEqual({ search: "Joe", view: "roster" });
    expect(entityIntent(row({ pillar: "automation", name: "Rule" }))).toEqual({ search: "Rule", section: "blast" });
  });

  test("picks the right view for priorities and access by kind and type", () => {
    expect(entityIntent(row({ pillar: "priorities", kind: "Resolution", name: "Done" }))).toEqual({
      search: "Done",
      view: "resolutions",
    });
    expect(entityIntent(row({ pillar: "priorities", kind: "Priority", name: "High" }))).toEqual({
      search: "High",
      view: "priorities",
    });
    expect(entityIntent(row({ pillar: "access", type: "Project role", name: "Developers" }))).toEqual({
      search: "Developers",
      view: "roles",
    });
    expect(entityIntent(row({ pillar: "access", type: "Unknown", name: "X" }))).toEqual({ search: "X" });
  });

  test("tolerates a row with no name", () => {
    expect(entityIntent({ pillar: "fields" })).toEqual({ search: "" });
  });
});

describe("oqlForTerm", () => {
  test("searches name and id, quoting so punctuation cannot break the query", () => {
    expect(oqlForTerm(" plant ")).toBe('name ~ "plant" OR id ~ "plant"');
    expect(oqlForTerm('a "b" \\c')).toBe('name ~ "a \\"b\\" \\\\c" OR id ~ "a \\"b\\" \\\\c"');
  });
});

describe("recent items", () => {
  test("most recent first, de-duplicated, capped at eight, and survives bad storage", () => {
    for (let i = 0; i < 10; i += 1) pushRecent(row({ uid: `u${i}`, name: `N${i}` }));
    pushRecent(row({ uid: "u3", name: "N3" }));
    const recent = readRecent();
    expect(recent).toHaveLength(8);
    expect(recent[0].uid).toBe("u3");
    expect(recent.filter((r) => r.uid === "u3")).toHaveLength(1);

    localStorage.setItem("observatory.palette.recent", "{not json");
    expect(readRecent()).toEqual([]);
  });
});

describe("buildPaletteItems", () => {
  test("an empty box shows recent items, then every tab", () => {
    const items = buildPaletteItems({ term: "", tabs: TABS, recents: [row()] });
    expect(items.map((i) => i.group)).toEqual(["Recent", "Go to", "Go to", "Go to", "Go to", "Go to"]);
  });

  test("a term shows matching tabs, then results, then the OQL row", () => {
    const items = buildPaletteItems({
      term: "work",
      tabs: TABS,
      results: [row({ uid: "w1", pillar: "workflows", name: "Work WF" })],
    });
    expect(items.map((i) => `${i.group}:${i.type}`)).toEqual(["Go to:tab", "Items:entity", "Search:oql"]);
    expect(items[2].term).toBe("work");
  });

  test("a one-letter term offers tabs but no OQL row", () => {
    expect(buildPaletteItems({ term: "s", tabs: TABS }).every((i) => i.type === "tab")).toBe(true);
  });
});

describe("CommandPalette", () => {
  function renderPalette(over = {}) {
    const props = {
      open: true,
      onClose: vi.fn(),
      onNavigate: vi.fn(),
      tabs: TABS,
      load: vi.fn().mockResolvedValue({ ok: true, results: [row()], unavailable: [] }),
      ...over,
    };
    render(<CommandPalette {...props} />);
    return props;
  }

  test("renders nothing when closed", () => {
    const { container } = render(<CommandPalette open={false} onClose={() => {}} onNavigate={() => {}} tabs={TABS} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("searches as you type and opens the chosen item on its pillar, already searched", async () => {
    const props = renderPalette();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "plant" } });
    await waitFor(() => expect(props.load).toHaveBeenCalledWith("searchEntities", { term: "plant", limit: 20 }));
    const option = await screen.findByRole("option", { name: /Plant/ });
    fireEvent.mouseDown(option);
    expect(props.onNavigate).toHaveBeenCalledWith("fields", { search: "Plant" });
    expect(props.onClose).toHaveBeenCalled();
    expect(readRecent()[0].uid).toBe("fields:customfield_11412");
  });

  test("arrow keys and Enter pick a tab; Escape closes", async () => {
    const props = renderPalette();
    const input = screen.getByRole("combobox");
    // Empty box: the five tabs. Down twice -> Workflows.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onNavigate).toHaveBeenCalledWith("workflows");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
  });

  // Focus reaches the input a frame after opening. An Escape pressed before then lands on the
  // page, and used to do nothing.
  test("Escape closes even before focus reaches the input, and closes once", () => {
    const props = renderPalette();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  test("End wraps to the last row and Up from the top wraps to the bottom", () => {
    const props = renderPalette();
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onNavigate).toHaveBeenLastCalledWith("scans");
    fireEvent.keyDown(input, { key: "Home" });
    fireEvent.keyDown(input, { key: "End" });
    expect(screen.getByRole("option", { name: /Scans/ })).toHaveAttribute("aria-selected", "true");
  });

  test("the last row runs the term as OQL in the Search tab", async () => {
    const props = renderPalette({ load: vi.fn().mockResolvedValue({ ok: true, results: [], unavailable: [] }) });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "deviation" } });
    const oql = await screen.findByRole("option", { name: /Search all pillars for "deviation"/ });
    fireEvent.mouseDown(oql);
    expect(props.onNavigate).toHaveBeenCalledWith("search", { query: 'name ~ "deviation" OR id ~ "deviation"' });
  });

  test("says when nothing matched and names the pillars it could not search", async () => {
    renderPalette({
      load: vi.fn().mockResolvedValue({ ok: true, results: [], unavailable: [{ key: "assets", label: "Assets" }] }),
    });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzz" } });
    expect(await screen.findByText(/No items named "zzz"/)).toBeInTheDocument();
    expect(screen.getByText(/Not searched .*Assets/)).toBeInTheDocument();
  });

  test("shows the error when the search fails", async () => {
    renderPalette({ load: vi.fn().mockRejectedValueOnce(new Error("Search is down")) });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "plant" } });
    expect(await screen.findByText("Search is down")).toBeInTheDocument();
  });

  test("a stale response never overwrites a newer one", async () => {
    let resolveFirst;
    const load = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ ok: true, results: [row({ uid: "new", name: "Newer" })], unavailable: [] });
    renderPalette({ load });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "ol" } });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: "older" } });
    await screen.findByRole("option", { name: /Newer/ });
    await act(async () => {
      resolveFirst({ ok: true, results: [row({ uid: "old", name: "Older" })], unavailable: [] });
    });
    expect(screen.queryByRole("option", { name: /^Older/ })).not.toBeInTheDocument();
  });

  test("clicking outside closes; clicking inside does not", () => {
    const props = renderPalette();
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement);
    expect(props.onClose).toHaveBeenCalled();
  });

  test("lists recent items while the box is empty", () => {
    pushRecent(row({ uid: "r1", name: "Recently opened" }));
    renderPalette();
    expect(screen.getByRole("option", { name: /Recently opened/ })).toBeInTheDocument();
    expect(screen.getByText("Recent")).toBeInTheDocument();
  });
});
