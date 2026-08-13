import { describe, it, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  applyTableControls,
  compareValues,
  parseSortToken,
  matchesSearch,
  copyToClipboard,
  formatTimestamp,
  formatNumber,
  formatShortTime,
  formatRelativeTime,
  formatLogTime,
  formatContextList,
  isUsageAvailable,
  isSelectType,
  escapeCsvCell,
  downloadCsv,
  slugifyFilenamePart,
  normalizeReportData,
  groupReportFieldsByType,
  summarizeReportData,
  mergeFieldMetrics,
  buildFieldRovoPrompt,
  buildProjectRovoPrompt,
  buildReportRovoPrompt,
} from "./utils";

// ---------------------------------------------------------------------------
// formatTimestamp
// ---------------------------------------------------------------------------
describe("formatTimestamp", () => {
  it("returns fallback string for null input", () => {
    expect(formatTimestamp(null)).toBe("No field change detected");
    expect(formatTimestamp(undefined)).toBe("No field change detected");
    expect(formatTimestamp("")).toBe("No field change detected");
  });

  it("returns a non-empty string for a valid ISO date string", () => {
    const result = formatTimestamp("2024-01-15T10:30:00Z");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    // Should not return the fallback
    expect(result).not.toBe("No field change detected");
  });
});

// ---------------------------------------------------------------------------
// formatNumber
// ---------------------------------------------------------------------------
describe("formatNumber", () => {
  it("formats a plain integer", () => {
    const result = formatNumber(1000);
    expect(typeof result).toBe("string");
    expect(result).not.toBe("0");
  });

  it("returns fallback string for null", () => {
    expect(formatNumber(null)).toBe("0");
  });

  it("returns fallback string for undefined", () => {
    expect(formatNumber(undefined)).toBe("0");
  });

  it("returns a custom fallback when provided for non-numeric input", () => {
    // Number("not-a-number") is NaN (not finite), so fallback is used
    expect(formatNumber("not-a-number", "N/A")).toBe("N/A");
  });

  it("formats 0 correctly", () => {
    expect(formatNumber(0)).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// formatShortTime
// ---------------------------------------------------------------------------
describe("formatShortTime", () => {
  it("returns empty string for null", () => {
    expect(formatShortTime(null)).toBe("");
    expect(formatShortTime(undefined)).toBe("");
    expect(formatShortTime("")).toBe("");
  });

  it("returns a non-empty string for a valid date", () => {
    const result = formatShortTime("2024-01-15T10:30:00Z");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// formatRelativeTime
// ---------------------------------------------------------------------------
describe("formatRelativeTime", () => {
  it("returns null for null input", () => {
    expect(formatRelativeTime(null)).toBeNull();
    expect(formatRelativeTime(undefined)).toBeNull();
  });

  it("returns 'just now' for a very recent date (< 1 minute ago)", () => {
    const recent = new Date(Date.now() - 30 * 1000).toISOString();
    expect(formatRelativeTime(recent)).toBe("just now");
  });

  it("returns minutes ago for < 1 hour", () => {
    const fortyMinsAgo = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const result = formatRelativeTime(fortyMinsAgo);
    expect(result).toMatch(/\d+m ago/);
  });

  it("returns hours ago for < 24 hours", () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const result = formatRelativeTime(fiveHoursAgo);
    expect(result).toMatch(/\d+h ago/);
  });

  it("returns days ago for > 24 hours", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const result = formatRelativeTime(threeDaysAgo);
    expect(result).toMatch(/\d+d ago/);
  });
});

// ---------------------------------------------------------------------------
// formatLogTime
// ---------------------------------------------------------------------------
describe("formatLogTime", () => {
  it("returns empty string for null", () => {
    expect(formatLogTime(null)).toBe("");
    expect(formatLogTime(undefined)).toBe("");
    expect(formatLogTime("")).toBe("");
  });

  it("returns a time string for a valid date", () => {
    const result = formatLogTime("2024-01-15T10:30:45Z");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    // Should contain colons as time separators
    expect(result).toMatch(/:/);
  });
});

// ---------------------------------------------------------------------------
// formatContextList
// ---------------------------------------------------------------------------
describe("formatContextList", () => {
  it("returns fallback for empty array", () => {
    expect(formatContextList([], "none")).toBe("none");
  });

  it("returns fallback for null/undefined", () => {
    expect(formatContextList(null, "none")).toBe("none");
    expect(formatContextList(undefined, "none")).toBe("none");
  });

  it("returns single item without comma", () => {
    expect(formatContextList(["alpha"], "none")).toBe("alpha");
  });

  it("joins multiple items with comma+space", () => {
    expect(formatContextList(["alpha", "beta", "gamma"], "none")).toBe("alpha, beta, gamma");
  });
});

// ---------------------------------------------------------------------------
// isUsageAvailable
// ---------------------------------------------------------------------------
describe("isUsageAvailable", () => {
  it("returns true when usageStatus is 'ready'", () => {
    expect(isUsageAvailable({ usageStatus: "ready" })).toBe(true);
  });

  it("returns true when source has no usageStatus (defaults to 'ready')", () => {
    expect(isUsageAvailable({})).toBe(true);
    expect(isUsageAvailable(null)).toBe(true);
    expect(isUsageAvailable(undefined)).toBe(true);
  });

  it("returns false when usageStatus is 'building'", () => {
    expect(isUsageAvailable({ usageStatus: "building" })).toBe(false);
  });

  it("returns false when usageStatus is 'queued'", () => {
    expect(isUsageAvailable({ usageStatus: "queued" })).toBe(false);
  });

  it("returns false when usageStatus is 'failed'", () => {
    expect(isUsageAvailable({ usageStatus: "failed" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSelectType
// ---------------------------------------------------------------------------
describe("isSelectType", () => {
  it("returns true for 'select' type", () => {
    expect(isSelectType("select")).toBe(true);
  });

  it("returns true for 'multiselect' type", () => {
    expect(isSelectType("multiselect")).toBe(true);
  });

  it("returns true for 'radiobutton' type", () => {
    expect(isSelectType("radiobutton")).toBe(true);
  });

  it("returns true for 'checkbox' type", () => {
    expect(isSelectType("checkbox")).toBe(true);
  });

  it("returns true for 'cascadingselect' type", () => {
    expect(isSelectType("cascadingselect")).toBe(true);
  });

  it("returns true for case-insensitive 'Select'", () => {
    expect(isSelectType("Select")).toBe(true);
  });

  it("returns false for 'text' type", () => {
    expect(isSelectType("text")).toBe(false);
  });

  it("returns false for 'number' type", () => {
    expect(isSelectType("number")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isSelectType(null)).toBe(false);
    expect(isSelectType(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// escapeCsvCell
// ---------------------------------------------------------------------------
describe("escapeCsvCell", () => {
  it("returns plain string with no special characters unchanged", () => {
    expect(escapeCsvCell("hello world")).toBe("hello world");
  });

  it("wraps in double quotes and escapes existing quotes", () => {
    expect(escapeCsvCell('say "hello"')).toBe('"say ""hello"""');
  });

  it("wraps in double quotes when comma is present", () => {
    const result = escapeCsvCell("alpha,beta");
    expect(result).toBe('"alpha,beta"');
  });

  it("wraps in double quotes when newline is present", () => {
    const result = escapeCsvCell("line1\nline2");
    expect(result).toBe('"line1\nline2"');
  });

  it("converts null/undefined to empty string", () => {
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// downloadCsv
// ---------------------------------------------------------------------------
describe("downloadCsv", () => {
  it("creates an anchor element and calls click()", () => {
    const clickMock = vi.fn();
    const linkEl = { href: "", download: "", click: clickMock };
    const createElementSpy = vi.spyOn(document, "createElement").mockReturnValue(linkEl);

    // jsdom does not implement URL.createObjectURL — define stubs if absent
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn().mockReturnValue("blob:mock");
    URL.revokeObjectURL = vi.fn();

    downloadCsv("test.csv", [["a", "b"], ["1", "2"]]);

    expect(createElementSpy).toHaveBeenCalledWith("a");
    expect(linkEl.download).toBe("test.csv");
    expect(clickMock).toHaveBeenCalledOnce();

    createElementSpy.mockRestore();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });
});

// ---------------------------------------------------------------------------
// slugifyFilenamePart
// ---------------------------------------------------------------------------
describe("slugifyFilenamePart", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugifyFilenamePart("Hello World")).toBe("hello-world");
  });

  it("returns fallback for empty string", () => {
    expect(slugifyFilenamePart("")).toBe("report");
    expect(slugifyFilenamePart(null)).toBe("report");
    expect(slugifyFilenamePart(undefined)).toBe("report");
  });

  it("strips special characters", () => {
    expect(slugifyFilenamePart("field/name!@#")).toBe("field-name");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugifyFilenamePart("---hello---")).toBe("hello");
  });

  it("accepts a custom fallback", () => {
    expect(slugifyFilenamePart("", "custom")).toBe("custom");
  });
});

// ---------------------------------------------------------------------------
// normalizeReportData
// ---------------------------------------------------------------------------
describe("normalizeReportData", () => {
  it("returns normalized structure with empty arrays for null input", () => {
    const result = normalizeReportData(null);
    expect(result.fields).toEqual([]);
    expect(result.projects).toEqual([]);
    expect(result.pendingFields).toEqual([]);
    expect(result.uniqueIssueCount).toBeNull();
  });

  it("normalizes fields and ensures projects array on each field", () => {
    const input = {
      fields: [{ id: "f1", projects: [{ projectId: "p1" }] }, { id: "f2" }],
      projects: [{ projectId: "p1" }],
      pendingFields: [],
      uniqueIssueCount: 42,
    };
    const result = normalizeReportData(input);
    expect(result.fields).toHaveLength(2);
    expect(result.fields[0].projects).toHaveLength(1);
    expect(result.fields[1].projects).toEqual([]);
    expect(result.uniqueIssueCount).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// groupReportFieldsByType
// ---------------------------------------------------------------------------
describe("groupReportFieldsByType", () => {
  it("returns empty array for null/empty input", () => {
    expect(groupReportFieldsByType(null)).toEqual([]);
    expect(groupReportFieldsByType([])).toEqual([]);
  });

  it("groups fields by fieldType and sorts groups alphabetically", () => {
    const fields = [
      { fieldId: "customfield_1", fieldName: "Bravo", fieldType: "text" },
      { fieldId: "customfield_2", fieldName: "Alpha", fieldType: "number" },
      { fieldId: "customfield_3", fieldName: "Charlie", fieldType: "text" },
    ];
    const result = groupReportFieldsByType(fields);
    expect(result).toHaveLength(2);
    // Groups sorted alphabetically: "number" before "text"
    expect(result[0].fieldType).toBe("number");
    expect(result[1].fieldType).toBe("text");
    expect(result[1].fields).toHaveLength(2);
    // Within the "text" group, fields are sorted by name: "Bravo" then "Charlie"
    expect(result[1].fields[0].fieldName).toBe("Bravo");
    expect(result[1].fields[1].fieldName).toBe("Charlie");
  });

  it("fields within each group are sorted by name", () => {
    const fields = [
      { fieldId: "customfield_2", fieldName: "Zulu", fieldType: "text" },
      { fieldId: "customfield_1", fieldName: "Alpha", fieldType: "text" },
    ];
    const result = groupReportFieldsByType(fields);
    expect(result[0].fields[0].fieldName).toBe("Alpha");
    expect(result[0].fields[1].fieldName).toBe("Zulu");
  });
});

// ---------------------------------------------------------------------------
// summarizeReportData
// ---------------------------------------------------------------------------
describe("summarizeReportData", () => {
  const fields = [
    {
      fieldId: "customfield_1",
      fieldName: "Field A",
      fieldType: "text",
      projects: [
        { projectId: "P1", projectKey: "AA", projectName: "Alpha", issueCount: 50 },
        { projectId: "P2", projectKey: "BB", projectName: "Beta", issueCount: 20 },
      ],
    },
    {
      fieldId: "customfield_2",
      fieldName: "Field B",
      fieldType: "number",
      projects: [
        { projectId: "P1", projectKey: "AA", projectName: "Alpha", issueCount: 10 },
      ],
    },
  ];
  const projects = [{ projectId: "P1" }, { projectId: "P2" }];

  it("calculates populatedCells correctly", () => {
    const result = summarizeReportData(fields, projects);
    expect(result.populatedCells).toBe(3); // 2 + 1
  });

  it("calculates totalIssues correctly", () => {
    const result = summarizeReportData(fields, projects);
    expect(result.totalIssues).toBe(80); // 50+20+10
  });

  it("returns topFields sorted by issueCount descending", () => {
    const result = summarizeReportData(fields, projects);
    expect(result.topFields[0].fieldName).toBe("Field A");
  });

  it("returns topProjects sorted by issueCount descending", () => {
    const result = summarizeReportData(fields, projects);
    expect(result.topProjects[0].projectKey).toBe("AA");
  });

  it("passes through uniqueIssueCount", () => {
    const result = summarizeReportData(fields, projects, 99);
    expect(result.uniqueIssueCount).toBe(99);
  });

  it("returns empty arrays for null input", () => {
    const result = summarizeReportData(null, null);
    expect(result.populatedCells).toBe(0);
    expect(result.totalIssues).toBe(0);
    expect(result.topFields).toEqual([]);
    expect(result.topProjects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mergeFieldMetrics
// ---------------------------------------------------------------------------
describe("mergeFieldMetrics", () => {
  it("returns field unchanged when source is null/undefined", () => {
    const field = { id: "f1", configuredProjectCount: 5 };
    expect(mergeFieldMetrics(field, null)).toBe(field);
    expect(mergeFieldMetrics(field, undefined)).toBe(field);
  });

  it("merges source metrics, taking the max values", () => {
    const field = { id: "f1", configuredProjectCount: 3, activeProjectCount: 1, totalIssueCount: 10 };
    const source = { configuredProjectCount: 5, activeProjectCount: 4, totalIssueCount: 8 };
    const result = mergeFieldMetrics(field, source);
    expect(result.configuredProjectCount).toBe(5);
    expect(result.activeProjectCount).toBe(4);
    expect(result.totalIssueCount).toBe(10);
  });

  it("uses source findings when provided", () => {
    const field = { id: "f1", findings: null };
    const source = { findings: { tags: { risky: true } } };
    const result = mergeFieldMetrics(field, source);
    expect(result.findings).toEqual({ tags: { risky: true } });
  });

  it("falls back to field findings when source has none", () => {
    const fieldFindings = { tags: { cleanup: true } };
    const field = { id: "f1", findings: fieldFindings };
    const source = { configuredProjectCount: 2 };
    const result = mergeFieldMetrics(field, source);
    expect(result.findings).toEqual(fieldFindings);
  });
});

// ---------------------------------------------------------------------------
// buildFieldRovoPrompt
// ---------------------------------------------------------------------------
describe("buildFieldRovoPrompt", () => {
  const mockField = {
    id: "customfield_10001",
    name: "My Field",
    type: "text",
    description: "A test field",
    configuredProjectCount: 5,
    activeProjectCount: 3,
    totalIssueCount: 100,
    usageStatus: "ready",
    fieldJql: "cf[10001] is not EMPTY",
  };

  it("returns a non-empty string", () => {
    const result = buildFieldRovoPrompt(mockField, null);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes the field name", () => {
    const result = buildFieldRovoPrompt(mockField, null);
    expect(result).toContain("My Field");
  });

  it("includes the field id", () => {
    const result = buildFieldRovoPrompt(mockField, null);
    expect(result).toContain("customfield_10001");
  });
});

// ---------------------------------------------------------------------------
// buildProjectRovoPrompt
// ---------------------------------------------------------------------------
describe("buildProjectRovoPrompt", () => {
  const mockField = { id: "customfield_10001", name: "My Field", type: "text" };
  const mockDetails = { totalIssueCount: 100 };
  const mockProject = {
    projectKey: "DEMO",
    projectName: "Demo Project",
    issueCount: 42,
    latestFieldChangeAt: "2024-01-01T00:00:00Z",
    latestIssueKey: "DEMO-1",
    jql: "cf[10001] is not EMPTY AND project = DEMO",
  };

  it("returns a non-empty string", () => {
    const result = buildProjectRovoPrompt(mockField, mockDetails, mockProject);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes the project key", () => {
    const result = buildProjectRovoPrompt(mockField, mockDetails, mockProject);
    expect(result).toContain("DEMO");
  });

  it("includes the field name", () => {
    const result = buildProjectRovoPrompt(mockField, mockDetails, mockProject);
    expect(result).toContain("My Field");
  });
});

// ---------------------------------------------------------------------------
// buildReportRovoPrompt
// ---------------------------------------------------------------------------
describe("buildReportRovoPrompt", () => {
  const params = {
    reportName: "Q1 Report",
    fields: [
      { fieldType: "text", fieldName: "Field A", fieldId: "customfield_1" },
      { fieldType: "number", fieldName: "Field B", fieldId: "customfield_2" },
    ],
    projects: [{ projectKey: "AA" }, { projectKey: "BB" }],
    pendingFields: [],
    reportSummary: {
      topFields: [{ fieldName: "Field A", issueCount: 100 }],
      topProjects: [{ projectKey: "AA" }],
      populatedCells: 10,
      totalIssues: 200,
      uniqueIssueCount: 150,
    },
  };

  it("returns a non-empty string", () => {
    const result = buildReportRovoPrompt(params);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes the report name", () => {
    const result = buildReportRovoPrompt(params);
    expect(result).toContain("Q1 Report");
  });

  it("includes field count", () => {
    const result = buildReportRovoPrompt(params);
    expect(result).toContain("2");
  });
});

// ── copyToClipboard ──────────────────────────────────────────────────────────

describe("copyToClipboard", () => {
  afterEach(() => {
    delete document.execCommand;
  });

  function setClipboard(value) {
    Object.defineProperty(navigator, "clipboard", { value, configurable: true, writable: true });
  }

  test("uses navigator.clipboard when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    await expect(copyToClipboard("customfield_1")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("customfield_1");
  });

  // Forge Custom UI renders in a sandboxed iframe; without the clipboard-write
  // permission policy the API is absent, and the execCommand path is the only one left.
  test("falls back to execCommand when navigator.clipboard is missing", async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn().mockReturnValue(true);

    await expect(copyToClipboard("customfield_1")).resolves.toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  test("falls back to execCommand when the clipboard API rejects", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("permissions policy")) });
    document.execCommand = vi.fn().mockReturnValue(true);

    await expect(copyToClipboard("customfield_1")).resolves.toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  test("resolves false when both paths fail", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("nope")) });
    document.execCommand = vi.fn().mockReturnValue(false);

    await expect(copyToClipboard("customfield_1")).resolves.toBe(false);
  });

  test("resolves false for empty or nullish text without touching the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    await expect(copyToClipboard("")).resolves.toBe(false);
    await expect(copyToClipboard(null)).resolves.toBe(false);
    await expect(copyToClipboard(undefined)).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  test("removes the temporary textarea from the DOM after the fallback runs", async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn().mockReturnValue(true);

    await copyToClipboard("customfield_1");

    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  test("resolves false rather than throwing when execCommand itself throws", async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn(() => { throw new Error("not supported"); });

    await expect(copyToClipboard("customfield_1")).resolves.toBe(false);
  });
});

// ── Client-side table controls ──────────────────────────────────────────────
//
// The in-memory half of the shared SortFilterBar. Tested here rather than through a tab
// because the orderings are the part that has to be right, and asserting them through
// rendered rows tests the table more than the comparator.

describe("parseSortToken", () => {
  test("splits a token into its key and direction", () => {
    expect(parseSortToken("field-count-desc")).toEqual({ key: "field-count", dir: "desc" });
    expect(parseSortToken("name-asc")).toEqual({ key: "name", dir: "asc" });
  });

  // A bare key is a valid token; treating the whole thing as a direction would silently
  // sort by nothing.
  test("defaults an unsuffixed token to ascending", () => {
    expect(parseSortToken("name")).toEqual({ key: "name", dir: "asc" });
    expect(parseSortToken("total-issues")).toEqual({ key: "total-issues", dir: "asc" });
  });

  test("falls back when there is no token at all", () => {
    expect(parseSortToken("", { key: null, dir: "asc" })).toEqual({ key: null, dir: "asc" });
    expect(parseSortToken(undefined, { key: "x", dir: "desc" })).toEqual({ key: "x", dir: "desc" });
  });
});

describe("compareValues", () => {
  test("compares numbers numerically, not as strings", () => {
    // The string comparison this replaces put 100 before 9.
    expect(compareValues(9, 100, "asc")).toBeLessThan(0);
    expect(compareValues("9", "100", "asc")).toBeLessThan(0);
  });

  test("compares text case-insensitively", () => {
    expect(compareValues("apple", "Banana", "asc")).toBeLessThan(0);
  });

  // The rule that matters when a column is partly unmeasured: flipping the sort reorders
  // the rows that have values. It must not promote the blanks to the top.
  test("keeps missing values last in both directions", () => {
    expect(compareValues(null, 5, "asc")).toBeGreaterThan(0);
    expect(compareValues(null, 5, "desc")).toBeGreaterThan(0);
    expect(compareValues(5, null, "desc")).toBeLessThan(0);
    expect(compareValues("", 5, "asc")).toBeGreaterThan(0);
  });

  test("treats two missing values as equal", () => {
    expect(compareValues(null, undefined, "asc")).toBe(0);
  });
});

describe("matchesSearch", () => {
  const row = { name: "Story Points", id: "customfield_10001", meta: { owner: "Platform" } };

  test("matches case-insensitively across every named key", () => {
    expect(matchesSearch(row, "story", ["name", "id"])).toBe(true);
    expect(matchesSearch(row, "CUSTOMFIELD_10001", ["name", "id"])).toBe(true);
  });

  test("reads dotted paths so nested values are searchable", () => {
    expect(matchesSearch(row, "platform", ["meta.owner"])).toBe(true);
  });

  test("does not match a key the row is missing, and does not throw", () => {
    expect(matchesSearch(row, "anything", ["absent.deeply.nested"])).toBe(false);
    expect(() => matchesSearch(null, "x", ["name"])).not.toThrow();
  });

  test("an empty term matches everything", () => {
    expect(matchesSearch(row, "   ", ["name"])).toBe(true);
  });
});

describe("applyTableControls", () => {
  const rows = [
    { id: "a", name: "Beta", type: "date", issues: 50 },
    { id: "b", name: "alpha", type: "string", issues: 9 },
    { id: "c", name: "Gamma", type: "date", issues: null },
  ];

  test("searches, filters and sorts together", () => {
    const out = applyTableControls(rows, {
      search: "a",
      searchKeys: ["name"],
      filters: [{ key: "type", value: "date" }],
      sort: "name-asc",
      sortKeys: { name: "name" },
    });

    expect(out.map((r) => r.id)).toEqual(["a", "c"]);
  });

  test("ignores a filter left on its all-value", () => {
    const out = applyTableControls(rows, { filters: [{ key: "type", value: "all" }] });
    expect(out).toHaveLength(3);
  });

  test("supports a predicate for filters that are not equality", () => {
    const out = applyTableControls(rows, {
      filters: [{ key: "issues", value: "busy", predicate: (row) => (row.issues ?? 0) > 10 }],
    });
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });

  test("accepts an accessor function for a computed sort key", () => {
    // "Beta" 4, "alpha" 5, "Gamma" 5 -- so the accessor is asserted against a value only it
    // can produce, and on the row whose length is unique.
    const out = applyTableControls(rows, {
      sort: "namelen-asc",
      sortKeys: { namelen: (row) => row.name.length },
    });
    expect(out[0].id).toBe("a");
    expect(out.map((r) => r.name.length)).toEqual([4, 5, 5]);
  });

  // Sorting in place would mutate React state held by the caller, which shows up as a list
  // that refuses to re-render rather than as an obvious bug.
  test("never mutates or returns the caller's array", () => {
    const original = [...rows];
    const out = applyTableControls(rows, { sort: "name-asc", sortKeys: { name: "name" } });

    expect(rows).toEqual(original);
    expect(out).not.toBe(rows);
  });

  test("returns a copy even when nothing narrows or reorders it", () => {
    const out = applyTableControls(rows, {});
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows);
  });

  test("survives being handed nothing", () => {
    expect(applyTableControls()).toEqual([]);
    expect(applyTableControls(null, { sort: "name-asc" })).toEqual([]);
  });

  // Unmeasured rows stay at the bottom whichever way the column is sorted.
  test("keeps rows with no value last when sorting a partly measured column", () => {
    const asc = applyTableControls(rows, { sort: "issues-asc", sortKeys: { issues: "issues" } });
    const desc = applyTableControls(rows, { sort: "issues-desc", sortKeys: { issues: "issues" } });

    expect(asc[asc.length - 1].id).toBe("c");
    expect(desc[desc.length - 1].id).toBe("c");
  });
});
