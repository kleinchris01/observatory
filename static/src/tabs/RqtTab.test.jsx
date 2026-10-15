import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { RqtIndexView } from "./RqtTab";

// The RQT Index had no tests at all -- 139 functions, none executed. It is also the most
// filter-heavy view in the app: project, issue type, field, and an RQT value search all
// compose into one filtered tree, and they compose by intersection. A filter that widens
// results instead of narrowing them is the kind of bug that looks like working software.
//
// These tests exercise the composition rather than the markup, because the markup is
// presentational and the composition is where correctness lives.

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

const SITE = "https://example.atlassian.net";

// Two projects, two issue types, six issues -- small enough to assert exactly, large
// enough that every filter dimension has something to remove.
function rqtIndex(overrides = {}) {
  return {
    totalUniqueIssues: 6,
    fieldCount: 2,
    uniqueValues: ["RQT-000123-000001", "RQT-000123-000002"],
    rqtValueFrequency: [
      { rqtValue: "RQT-000123-000001", count: 4 },
      { rqtValue: "RQT-000123-000002", count: 2 },
    ],
    issuesByProject: [
      {
        projectKey: "ALPHA",
        total: 4,
        types: [
          { issueType: "Bug", count: 2, issues: ["ALPHA-1", "ALPHA-2"] },
          { issueType: "Task", count: 2, issues: ["ALPHA-3", "ALPHA-4"] },
        ],
      },
      {
        projectKey: "BRAVO",
        total: 2,
        types: [{ issueType: "Bug", count: 2, issues: ["BRAVO-1", "BRAVO-2"] }],
      },
    ],
    fields: [
      { fieldId: "customfield_1", name: "RQT Ref", count: 4 },
      { fieldId: "customfield_2", name: "Legacy Ref", count: 2 },
    ],
    fieldIssueIndex: {
      customfield_1: ["ALPHA-1", "ALPHA-2", "ALPHA-3", "ALPHA-4"],
      customfield_2: ["BRAVO-1", "BRAVO-2"],
    },
    issueRqtValues: {},
    jqlChunks: ["key in (ALPHA-1, ALPHA-2)"],
    ...overrides,
  };
}

function mockIndex(payload = rqtIndex(), searchResult = { issueKeys: [] }) {
  invoke.mockImplementation((fn) => {
    if (fn === "getRqtIndex") return Promise.resolve(payload);
    if (fn === "searchRqtValue") return Promise.resolve(searchResult);
    return Promise.resolve({});
  });
}

beforeEach(() => vi.clearAllMocks());

// "ALPHA" appears in the filter bar, the matrix header and the tree, so counting the
// non-button occurrences is how these tests tell "present in results" from "offered as a
// filter option".
const resultOccurrences = (text) => screen.queryAllByText(text).filter((el) => !el.closest("button")).length;

const findRqtSearch = () => screen.getByPlaceholderText("Find RQT value…");

describe("RqtIndexView", () => {
  test("loads the index on mount and renders both projects", async () => {
    mockIndex();
    render(<RqtIndexView siteOrigin={SITE} />);

    await waitFor(() => expect(resultOccurrences("ALPHA")).toBeGreaterThan(0));
    expect(resultOccurrences("BRAVO")).toBeGreaterThan(0);
    expect(invoke).toHaveBeenCalledWith("getRqtIndex");
  });

  test("settles instead of spinning forever when the index fails to load", async () => {
    invoke.mockImplementation((fn) =>
      fn === "getRqtIndex" ? Promise.reject(new Error("resolver down")) : Promise.resolve({}),
    );
    render(<RqtIndexView siteOrigin={SITE} />);

    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    expect(resultOccurrences("ALPHA")).toBe(0);
  });

  test("renders an empty index without crashing", async () => {
    mockIndex({ ...rqtIndex(), issuesByProject: [], uniqueValues: [], fields: [], rqtValueFrequency: [] });
    render(<RqtIndexView siteOrigin={SITE} />);

    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    expect(resultOccurrences("ALPHA")).toBe(0);
  });
});

// Every filter dimension must NARROW. A filter that silently fails to apply is
// indistinguishable from one that matches everything, so these assert on what
// disappeared rather than on what remains.
describe("RqtIndexView — RQT value search", () => {
  test("narrows to the matching issues only", async () => {
    mockIndex(rqtIndex(), { issueKeys: ["ALPHA-1"] });
    render(<RqtIndexView siteOrigin={SITE} />);
    await waitFor(() => expect(resultOccurrences("BRAVO")).toBeGreaterThan(0));

    await userEvent.type(findRqtSearch(), "RQT-000123-000001{Enter}");

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("searchRqtValue", { rqtValue: "RQT-000123-000001" }));
    // BRAVO holds none of the matched keys, so it must leave the results entirely.
    await waitFor(() => expect(resultOccurrences("BRAVO")).toBe(0));
  });

  test("normalises the term to upper case before querying", async () => {
    mockIndex(rqtIndex(), { issueKeys: [] });
    render(<RqtIndexView siteOrigin={SITE} />);
    await waitFor(() => expect(resultOccurrences("ALPHA")).toBeGreaterThan(0));

    await userEvent.type(findRqtSearch(), "rqt-000123-000001{Enter}");

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("searchRqtValue", { rqtValue: "RQT-000123-000001" }));
  });

  test("a failed search yields no matches rather than every issue", async () => {
    invoke.mockImplementation((fn) => {
      if (fn === "getRqtIndex") return Promise.resolve(rqtIndex());
      return Promise.reject(new Error("search failed"));
    });
    render(<RqtIndexView siteOrigin={SITE} />);
    await waitFor(() => expect(resultOccurrences("ALPHA")).toBeGreaterThan(0));

    const before = resultOccurrences("ALPHA");
    await userEvent.type(findRqtSearch(), "RQT-000123-000009{Enter}");

    // The catch sets an EMPTY set, not null. Falling back to null would leave every issue
    // on screen, reading as "all of these matched" -- the worst possible failure mode for
    // a search. Asserted as a strict reduction because the project x type matrix above the
    // tree lists project keys regardless of the active filter.
    await waitFor(() => expect(resultOccurrences("ALPHA")).toBeLessThan(before));
  });

  test("an all-whitespace search clears results without querying", async () => {
    mockIndex();
    render(<RqtIndexView siteOrigin={SITE} />);
    await waitFor(() => expect(resultOccurrences("ALPHA")).toBeGreaterThan(0));

    const before = invoke.mock.calls.filter((c) => c[0] === "searchRqtValue").length;
    await userEvent.type(findRqtSearch(), "   {Enter}");

    expect(invoke.mock.calls.filter((c) => c[0] === "searchRqtValue")).toHaveLength(before);
    expect(resultOccurrences("ALPHA")).toBeGreaterThan(0);
  });
});

describe("RqtIndexView — view modes", () => {
  test("the Tree/Table toggle switches which view is active", async () => {
    mockIndex();
    render(<RqtIndexView siteOrigin={SITE} />);
    await waitFor(() => expect(resultOccurrences("ALPHA")).toBeGreaterThan(0));

    const tree = screen.getByRole("button", { name: "Tree" });
    const table = screen.getByRole("button", { name: "Table" });
    expect(tree.className).toContain("--active");

    await userEvent.click(table);
    await waitFor(() => expect(table.className).toContain("--active"));
    expect(tree.className).not.toContain("--active");

    await userEvent.click(tree);
    await waitFor(() => expect(tree.className).toContain("--active"));
  });

  // Issue keys come from stored scan data, so a link built from them must never be able
  // to point somewhere other than the customer's own site.
  test("no rendered link escapes the configured site origin", async () => {
    mockIndex();
    render(<RqtIndexView siteOrigin={SITE} />);
    await waitFor(() => expect(resultOccurrences("ALPHA")).toBeGreaterThan(0));
    await userEvent.click(screen.getByRole("button", { name: "Table" }));

    for (const link of screen.queryAllByRole("link")) {
      const href = link.getAttribute("href") || "";
      if (href.startsWith("http")) expect(href.startsWith(SITE)).toBe(true);
    }
  });
});
