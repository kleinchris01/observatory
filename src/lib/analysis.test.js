import { describe, test, expect, vi, afterEach } from "vitest";
import {
  USAGE_STATUS_READY,
  USAGE_STATUS_UNAVAILABLE,
  USAGE_STATUS_UNSUPPORTED,
  DEFAULT_GOVERNANCE_THRESHOLDS,
  STRUCTURAL_SYSTEM_FIELDS,
  RQT_SKIP_FIELDS,
  RQT_DEDUP_PRIORITY_FIELD,
  RQT_DEDUP_SUBORDINATE_FIELDS,
  isFieldValueNonEmpty,
  extractRqtValues,
  buildRqtJql,
  collectIssueRqtValues,
  estimateProjectUsageJobIssues,
  isFieldSummaryQueuedForDispatch,
  isFieldSummaryRunning,
  summarizeProjectUsageCapacity,
  shouldRetry,
  getRetryDelayMs,
  normalizeFieldName,
  buildDuplicateNameCountMap,
  hasMeaningfulDescription,
  isLikelyAppProvidedField,
  isJiraBuiltinField,
  classifyFieldUsageStatus,
  buildGovernanceFindings,
  mergeProjectUsageCounts,
  compareFields,
  filterInventoryFields,
  isSelectFieldType,
  applyFindingsFilter,
  sortInventoryFields,
  summarizeFindings,
  buildInventoryRecord,
  daysSince,
} from "./analysis.js";

afterEach(() => vi.restoreAllMocks());

// ── Constants ───────────────────────────────────────────────────────────────

describe("exported constants", () => {
  test("usage status strings are stable", () => {
    expect(USAGE_STATUS_READY).toBe("ready");
    expect(USAGE_STATUS_UNAVAILABLE).toBe("unavailable");
    expect(USAGE_STATUS_UNSUPPORTED).toBe("unsupported");
  });

  test("DEFAULT_GOVERNANCE_THRESHOLDS has all expected keys", () => {
    expect(DEFAULT_GOVERNANCE_THRESHOLDS).toMatchObject({
      highImpactMinProjects: expect.any(Number),
      highImpactMinIssues: expect.any(Number),
      broadScopeMinProjects: expect.any(Number),
      lightUsageMinProjects: expect.any(Number),
      lightUsageMaxIssues: expect.any(Number),
      missingDescriptionMinProjects: expect.any(Number),
      missingDescriptionMinIssues: expect.any(Number),
      configuredActiveGapMinProjects: expect.any(Number),
      configuredActiveGapMaxRatio: expect.any(Number),
      globalContextMaxIssues: expect.any(Number),
      contextSprawlMinContexts: expect.any(Number),
      appFieldHeavyUsageMin: expect.any(Number),
    });
  });

  test("STRUCTURAL_SYSTEM_FIELDS contains core Jira fields", () => {
    expect(STRUCTURAL_SYSTEM_FIELDS.has("project")).toBe(true);
    expect(STRUCTURAL_SYSTEM_FIELDS.has("summary")).toBe(true);
    expect(STRUCTURAL_SYSTEM_FIELDS.has("status")).toBe(true);
    expect(STRUCTURAL_SYSTEM_FIELDS.has("customfield_12345")).toBe(false);
  });

  test("RQT_SKIP_FIELDS excludes relational link fields", () => {
    expect(RQT_SKIP_FIELDS.has("issuelinks")).toBe(true);
    expect(RQT_SKIP_FIELDS.has("parent")).toBe(true);
    expect(RQT_SKIP_FIELDS.has("summary")).toBe(false);
  });

  test("RQT_DEDUP_SUBORDINATE_FIELDS is a Set of custom field IDs", () => {
    expect(RQT_DEDUP_SUBORDINATE_FIELDS.has(RQT_DEDUP_PRIORITY_FIELD)).toBe(false);
    expect(RQT_DEDUP_SUBORDINATE_FIELDS.size).toBeGreaterThan(0);
    for (const id of RQT_DEDUP_SUBORDINATE_FIELDS) {
      expect(id).toMatch(/customfield_\d+/);
    }
  });
});

// ── isFieldValueNonEmpty ─────────────────────────────────────────────────────

describe("isFieldValueNonEmpty", () => {
  test.each([
    [null, false],
    [undefined, false],
    ["", false],
    [0, false],
    [NaN, false],
    [Infinity, false],
    -[Infinity], // intentional quirk — handled below
  ])("handles falsy-ish value %s", () => {}); // placeholder; real cases below

  test("returns false for null and undefined", () => {
    expect(isFieldValueNonEmpty(null)).toBe(false);
    expect(isFieldValueNonEmpty(undefined)).toBe(false);
  });

  test("returns false for empty string, true for non-empty string", () => {
    expect(isFieldValueNonEmpty("")).toBe(false);
    expect(isFieldValueNonEmpty("hello")).toBe(true);
  });

  test("returns false for non-finite numbers (NaN, Infinity)", () => {
    expect(isFieldValueNonEmpty(NaN)).toBe(false);
    expect(isFieldValueNonEmpty(Infinity)).toBe(false);
    expect(isFieldValueNonEmpty(-Infinity)).toBe(false);
  })

  test("returns true for 0 (a valid populated field value)", () => {
    expect(isFieldValueNonEmpty(0)).toBe(true);
  });

  test("returns true for any finite number including negative", () => {
    expect(isFieldValueNonEmpty(1)).toBe(true);
    expect(isFieldValueNonEmpty(-5)).toBe(true);
    expect(isFieldValueNonEmpty(0.001)).toBe(true);
  });

  test("returns true for any boolean", () => {
    expect(isFieldValueNonEmpty(true)).toBe(true);
    expect(isFieldValueNonEmpty(false)).toBe(true);
  });

  test("returns false for empty array, true for non-empty array", () => {
    expect(isFieldValueNonEmpty([])).toBe(false);
    expect(isFieldValueNonEmpty([1])).toBe(true);
  });

  test("returns false for empty object, true for non-empty object", () => {
    expect(isFieldValueNonEmpty({})).toBe(false);
    expect(isFieldValueNonEmpty({ key: "val" })).toBe(true);
  });
});

// ── extractRqtValues ─────────────────────────────────────────────────────────

describe("extractRqtValues", () => {
  test("returns empty Set for null or undefined", () => {
    expect(extractRqtValues(null).size).toBe(0);
    expect(extractRqtValues(undefined).size).toBe(0);
  });

  test("extracts a single RQT token from a string", () => {
    const result = extractRqtValues("This references RQT-12345-67890");
    expect(result).toEqual(new Set(["RQT-12345-67890"]));
  });

  test("normalizes tokens to uppercase", () => {
    const result = extractRqtValues("rqt-100-200 and RQT-100-200");
    expect(result).toEqual(new Set(["RQT-100-200"]));
  });

  test("extracts from a nested array", () => {
    const result = extractRqtValues([{ value: "RQT-1-2" }, "RQT-3-4"]);
    expect(result).toEqual(new Set(["RQT-1-2", "RQT-3-4"]));
  });

  test("extracts from a nested object", () => {
    const result = extractRqtValues({ a: { b: "RQT-9-9" } });
    expect(result).toEqual(new Set(["RQT-9-9"]));
  });

  test("returns empty Set when no RQT tokens present", () => {
    expect(extractRqtValues("no tokens here").size).toBe(0);
    expect(extractRqtValues(42).size).toBe(0);
  });

  test("does not match partial or malformed tokens", () => {
    expect(extractRqtValues("RQT-123").size).toBe(0);
    expect(extractRqtValues("XRQT-1-2").size).toBe(0);
    expect(extractRqtValues("RQT-1-2X").size).toBe(0);
  });
});

// ── buildRqtJql ──────────────────────────────────────────────────────────────

describe("buildRqtJql", () => {
  test("returns null for empty fieldIds array", () => {
    expect(buildRqtJql([])).toBeNull();
  });

  test("builds cf[N] clause for customfield IDs", () => {
    expect(buildRqtJql(["customfield_11426"])).toBe('cf[11426] ~ "RQT"');
  });

  test("builds clause for summary", () => {
    expect(buildRqtJql(["summary"])).toBe('summary ~ "RQT"');
  });

  test("builds clause for description and comment", () => {
    expect(buildRqtJql(["description"])).toBe('description ~ "RQT"');
    expect(buildRqtJql(["comment"])).toBe('comment ~ "RQT"');
  });

  test("skips unrecognized field IDs", () => {
    expect(buildRqtJql(["issuelinks", "attachment"])).toBeNull();
  });

  test("joins multiple valid fields with OR", () => {
    const jql = buildRqtJql(["customfield_100", "summary"]);
    expect(jql).toBe('cf[100] ~ "RQT" OR summary ~ "RQT"');
  });
});

// ── collectIssueRqtValues ────────────────────────────────────────────────────

describe("collectIssueRqtValues", () => {
  const PRIORITY = RQT_DEDUP_PRIORITY_FIELD;
  const [SUB1] = [...RQT_DEDUP_SUBORDINATE_FIELDS];

  test("returns empty Map when issueFields is empty and summaryValue has no RQTs", () => {
    expect(collectIssueRqtValues({}, "no rqt here").size).toBe(0);
  });

  test("skips structural system fields", () => {
    const fields = { project: "RQT-1-2", summary: null };
    const result = collectIssueRqtValues(fields, "");
    expect(result.has("project")).toBe(false);
  });

  test("skips RQT_SKIP_FIELDS (issuelinks, parent)", () => {
    const fields = { issuelinks: "RQT-1-2", parent: "RQT-3-4" };
    const result = collectIssueRqtValues(fields, "");
    expect(result.has("issuelinks")).toBe(false);
    expect(result.has("parent")).toBe(false);
  });

  test("collects matching custom fields", () => {
    const result = collectIssueRqtValues({ customfield_99999: "RQT-10-20" }, "");
    expect(result.get("customfield_99999")).toEqual(new Set(["RQT-10-20"]));
  });

  test("collects RQTs from summaryValue separately", () => {
    const result = collectIssueRqtValues({}, "RQT-5-6");
    expect(result.get("summary")).toEqual(new Set(["RQT-5-6"]));
  });

  test("deduplicates values from subordinate fields when priority field has the same value", () => {
    const rqt = "RQT-1-1";
    const fields = {
      [PRIORITY]: rqt,
      [SUB1]: rqt,
    };
    const result = collectIssueRqtValues(fields, "");
    expect(result.has(PRIORITY)).toBe(true);
    expect(result.has(SUB1)).toBe(false);
  });

  test("subordinate keeps unique values not in priority", () => {
    const fields = {
      [PRIORITY]: "RQT-1-1",
      [SUB1]: "RQT-2-2",
    };
    const result = collectIssueRqtValues(fields, "");
    expect(result.has(SUB1)).toBe(true);
    expect(result.get(SUB1)).toEqual(new Set(["RQT-2-2"]));
  });
});

// ── estimateProjectUsageJobIssues ─────────────────────────────────────────────

describe("estimateProjectUsageJobIssues", () => {
  test("prefers estimatedIssueTotal", () => {
    expect(estimateProjectUsageJobIssues({ estimatedIssueTotal: 500, totalIssueCount: 100 })).toBe(500);
  });

  test("falls back to totalIssueCount when estimatedIssueTotal missing", () => {
    expect(estimateProjectUsageJobIssues({ totalIssueCount: 200 })).toBe(200);
  });

  test("falls back to field.totalIssueCount", () => {
    expect(estimateProjectUsageJobIssues({ field: { totalIssueCount: 300 } })).toBe(300);
  });

  test("returns 0 for null/undefined input", () => {
    expect(estimateProjectUsageJobIssues(null)).toBe(0);
    expect(estimateProjectUsageJobIssues(undefined)).toBe(0);
    expect(estimateProjectUsageJobIssues({})).toBe(0);
  });

  test("coerces NaN/non-numeric values to 0", () => {
    expect(estimateProjectUsageJobIssues({ estimatedIssueTotal: "bad" })).toBe(0);
  });
});

// ── isFieldSummaryQueuedForDispatch ───────────────────────────────────────────

describe("isFieldSummaryQueuedForDispatch", () => {
  test("returns true when queued with 0 processedIssueCount", () => {
    expect(isFieldSummaryQueuedForDispatch({ summaryStatus: "queued", processedIssueCount: 0 })).toBe(true);
  });

  test("returns false when queued but processedIssueCount > 0", () => {
    expect(isFieldSummaryQueuedForDispatch({ summaryStatus: "queued", processedIssueCount: 1 })).toBe(false);
  });

  test("returns false for non-queued statuses", () => {
    expect(isFieldSummaryQueuedForDispatch({ summaryStatus: "building" })).toBe(false);
    expect(isFieldSummaryQueuedForDispatch({ summaryStatus: "ready" })).toBe(false);
  });

  test("returns false for null", () => {
    expect(isFieldSummaryQueuedForDispatch(null)).toBe(false);
  });
});

// ── isFieldSummaryRunning ─────────────────────────────────────────────────────

describe("isFieldSummaryRunning", () => {
  test("returns true when building", () => {
    expect(isFieldSummaryRunning({ summaryStatus: "building" })).toBe(true);
  });

  test("returns true when queued and unprocessed", () => {
    expect(isFieldSummaryRunning({ summaryStatus: "queued", processedIssueCount: 0 })).toBe(true);
  });

  test("returns false when queued but already processing", () => {
    expect(isFieldSummaryRunning({ summaryStatus: "queued", processedIssueCount: 10 })).toBe(false);
  });

  test("returns false for idle or ready", () => {
    expect(isFieldSummaryRunning({ summaryStatus: "ready" })).toBe(false);
    expect(isFieldSummaryRunning(null)).toBe(false);
  });
});

// ── summarizeProjectUsageCapacity ─────────────────────────────────────────────

describe("summarizeProjectUsageCapacity", () => {
  test("returns zero counts for empty array", () => {
    const result = summarizeProjectUsageCapacity([]);
    expect(result.runningJobCount).toBe(0);
    expect(result.runningIssueBudget).toBe(0);
    expect(result.runningJobs).toHaveLength(0);
  });

  test("counts only running jobs", () => {
    const summaries = [
      { summaryStatus: "building", estimatedIssueTotal: 100 },
      { summaryStatus: "ready", estimatedIssueTotal: 200 },
      { summaryStatus: "queued", processedIssueCount: 0, estimatedIssueTotal: 50 },
    ];
    const result = summarizeProjectUsageCapacity(summaries);
    expect(result.runningJobCount).toBe(2);
    expect(result.runningIssueBudget).toBe(150);
  });

  test("defaults to empty array when no arg provided", () => {
    const result = summarizeProjectUsageCapacity();
    expect(result.runningJobCount).toBe(0);
  });
});

// ── shouldRetry ───────────────────────────────────────────────────────────────

describe("shouldRetry", () => {
  test("returns true for 429", () => {
    expect(shouldRetry({ status: 429 })).toBe(true);
  });

  test("returns true for 5xx errors", () => {
    expect(shouldRetry({ status: 500 })).toBe(true);
    expect(shouldRetry({ status: 503 })).toBe(true);
    expect(shouldRetry({ status: 599 })).toBe(true);
  });

  test("returns false for 4xx client errors (except 429)", () => {
    expect(shouldRetry({ status: 400 })).toBe(false);
    expect(shouldRetry({ status: 401 })).toBe(false);
    expect(shouldRetry({ status: 404 })).toBe(false);
  });

  test("returns false for 2xx success", () => {
    expect(shouldRetry({ status: 200 })).toBe(false);
  });

  test("returns false for null or no status", () => {
    expect(shouldRetry(null)).toBe(false);
    expect(shouldRetry({})).toBe(false);
    expect(shouldRetry(undefined)).toBe(false);
  });
});

// ── getRetryDelayMs ───────────────────────────────────────────────────────────

describe("getRetryDelayMs", () => {
  afterEach(() => vi.restoreAllMocks());

  test("uses Retry-After header when present and valid", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const error = { originalResponse: { headers: { get: (h) => h === "Retry-After" ? "5" : null } } };
    expect(getRetryDelayMs(error, 0)).toBe(5000);
  });

  test("ignores non-positive Retry-After header", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const error = { originalResponse: { headers: { get: () => "0" } } };
    const delay = getRetryDelayMs(error, 0);
    expect(delay).toBe(2000); // 2000 * 2^0 + 0 jitter
  });

  test("exponential backoff: attempt 0 gives ~2s base", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(getRetryDelayMs({}, 0)).toBe(2000);
  });

  test("exponential backoff: attempt 1 gives ~4s base", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(getRetryDelayMs({}, 1)).toBe(4000);
  });

  test("caps at 30s regardless of attempt number", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(getRetryDelayMs({}, 20)).toBe(30000);
  });

  test("caps a large Retry-After header at 30s instead of honoring it verbatim", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const error = { originalResponse: { headers: { get: (h) => h === "Retry-After" ? "123" : null } } };
    expect(getRetryDelayMs(error, 0)).toBe(30000);
  });

  test("adds up to 999ms jitter on top of base", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const delay = getRetryDelayMs({}, 0);
    expect(delay).toBeGreaterThan(2000);
    expect(delay).toBeLessThan(3000);
  });
});

// ── normalizeFieldName ────────────────────────────────────────────────────────

describe("normalizeFieldName", () => {
  test("lowercases and collapses non-alphanumeric to spaces", () => {
    expect(normalizeFieldName("Sprint Name")).toBe("sprint name");
    expect(normalizeFieldName("Field-Name_123")).toBe("field name 123");
  });

  test("trims leading and trailing whitespace", () => {
    expect(normalizeFieldName("  hello  ")).toBe("hello");
  });

  test("handles empty string and null", () => {
    expect(normalizeFieldName("")).toBe("");
    expect(normalizeFieldName(null)).toBe("");
    expect(normalizeFieldName(undefined)).toBe("");
  });
});

// ── buildDuplicateNameCountMap ────────────────────────────────────────────────

describe("buildDuplicateNameCountMap", () => {
  test("returns empty map for empty array", () => {
    expect(buildDuplicateNameCountMap([]).size).toBe(0);
  });

  test("counts unique names as 1", () => {
    const map = buildDuplicateNameCountMap([{ name: "Sprint" }, { name: "Epic" }]);
    expect(map.get("sprint")).toBe(1);
    expect(map.get("epic")).toBe(1);
  });

  test("counts duplicate names (normalized) correctly", () => {
    const map = buildDuplicateNameCountMap([
      { name: "Sprint Name" },
      { name: "sprint name" },
      { name: "Sprint-Name" },
    ]);
    expect(map.get("sprint name")).toBe(3);
  });
});

// ── hasMeaningfulDescription ──────────────────────────────────────────────────

describe("hasMeaningfulDescription", () => {
  test.each([
    [null, false],
    [undefined, false],
    ["", false],
    ["  ", false],
    ["No admin description is set for this field.", false],
    ["no description", false],
    ["N/A", false],
    ["NA", false],
    ["This field stores the sprint goal.", true],
    ["Custom field for tracking requirements.", true],
  ])("hasMeaningfulDescription(%s) → %s", (input, expected) => {
    expect(hasMeaningfulDescription(input)).toBe(expected);
  });
});

// ── isLikelyAppProvidedField ──────────────────────────────────────────────────

describe("isLikelyAppProvidedField", () => {
  test("returns false when no customType", () => {
    expect(isLikelyAppProvidedField({ schema: {} })).toBe(false);
    expect(isLikelyAppProvidedField({})).toBe(false);
  });

  test("returns false for Atlassian system customfield types", () => {
    const field = { customType: "com.atlassian.jira.plugin.system.customfieldtypes:textfield" };
    expect(isLikelyAppProvidedField(field)).toBe(false);
  });

  test("returns true for third-party app types", () => {
    const field = { customType: "com.somevendor.plugin:customtype" };
    expect(isLikelyAppProvidedField(field)).toBe(true);
  });

  test("reads from schema.custom when customType not present", () => {
    const field = { schema: { custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield" } };
    expect(isLikelyAppProvidedField(field)).toBe(false);
  });
});

// ── isJiraBuiltinField ────────────────────────────────────────────────────────

describe("isJiraBuiltinField", () => {
  test("returns false when no customType", () => {
    expect(isJiraBuiltinField({ schema: {} })).toBe(false);
  });

  test("returns true for com.atlassian.jira.plugin.system.customfieldtypes prefix", () => {
    const field = { customType: "com.atlassian.jira.plugin.system.customfieldtypes:textfield" };
    expect(isJiraBuiltinField(field)).toBe(true);
  });

  test("returns true for Greenhopper (Agile) fields", () => {
    const field = { customType: "com.pyxis.greenhopper.jira:gh-sprint" };
    expect(isJiraBuiltinField(field)).toBe(true);
  });

  test("returns true for servicedesk fields", () => {
    const field = { customType: "com.atlassian.servicedesk.approvals-plugin:sd-approvals" };
    expect(isJiraBuiltinField(field)).toBe(true);
  });

  test("returns false for third-party app fields", () => {
    const field = { customType: "com.somevendor.plugin:custom" };
    expect(isJiraBuiltinField(field)).toBe(false);
  });
});

// ── classifyFieldUsageStatus ──────────────────────────────────────────────────

describe("classifyFieldUsageStatus", () => {
  const atlassianField = { customType: "com.atlassian.jira.plugin.system.customfieldtypes:textfield" };
  const appField = { customType: "com.somevendor.plugin:custom" };

  test("returns UNAVAILABLE with snapshot detail when error is null", () => {
    const result = classifyFieldUsageStatus(atlassianField, null);
    expect(result.status).toBe(USAGE_STATUS_UNAVAILABLE);
    expect(result.detail).toContain("background snapshot");
  });

  test("returns UNSUPPORTED for app-provided field with 401", () => {
    const result = classifyFieldUsageStatus(appField, { status: 401 });
    expect(result.status).toBe(USAGE_STATUS_UNSUPPORTED);
  });

  test("returns UNAVAILABLE for system field with 401", () => {
    const result = classifyFieldUsageStatus(atlassianField, { status: 401 });
    expect(result.status).toBe(USAGE_STATUS_UNAVAILABLE);
    expect(result.detail).toContain("401");
  });

  test("returns UNAVAILABLE for 403", () => {
    const result = classifyFieldUsageStatus(atlassianField, { status: 403 });
    expect(result.status).toBe(USAGE_STATUS_UNAVAILABLE);
    expect(result.detail).toContain("403");
  });

  test("returns UNAVAILABLE with error message for other errors", () => {
    const result = classifyFieldUsageStatus(atlassianField, { status: 500, message: "Server error" });
    expect(result.status).toBe(USAGE_STATUS_UNAVAILABLE);
    expect(result.detail).toBe("Server error");
  });
});

// ── buildGovernanceFindings ───────────────────────────────────────────────────

const customField = { id: "customfield_12345", name: "Sprint Goal", description: "Describes the sprint." };
const systemField = { id: "summary", name: "Summary", description: "" };

function findings(field, metrics, thresholds = {}) {
  return buildGovernanceFindings(field, metrics, thresholds);
}

describe("buildGovernanceFindings — rule: high-impact broad usage", () => {
  test("fires when activeProjectCount >= threshold AND totalIssueCount >= threshold", () => {
    const result = findings(customField, { activeProjectCount: 10, totalIssueCount: 1000, usageStatus: "ready" });
    const rule = result.reasons.find((r) => r.title.includes("High-impact"));
    expect(rule).toBeDefined();
    expect(rule.category).toBe("risky");
    expect(rule.severity).toBe("high");
    expect(result.adminAttention).toBe(true);
  });

  test("does not fire when below both thresholds", () => {
    const result = findings(customField, { activeProjectCount: 5, totalIssueCount: 500, usageStatus: "ready" });
    expect(result.reasons.find((r) => r.title.includes("High-impact"))).toBeUndefined();
  });

  test("uses configuredProjectCount when activeProjectCount is 0 (configured-scope mode)", () => {
    const result = findings(customField, { activeProjectCount: 0, configuredProjectCount: 15, totalIssueCount: 2000, usageStatus: "ready" });
    const rule = result.reasons.find((r) => r.title.includes("High-impact"));
    expect(rule).toBeDefined();
    expect(rule.detail).toContain("Configured in 15 projects");
  });
});

describe("buildGovernanceFindings — rule: app-provided heavy usage", () => {
  const appField = { id: "customfield_1", name: "App Field", description: "", customType: "com.vendor:custom" };

  test("fires for non-system app field with totalIssueCount >= threshold", () => {
    const result = findings(appField, { totalIssueCount: 500, usageStatus: "ready" });
    expect(result.reasons.find((r) => r.title.includes("App-provided"))).toBeDefined();
  });

  test("does not fire for Atlassian system field", () => {
    const atlField = { id: "customfield_1", name: "F", customType: "com.atlassian.jira.plugin.system.customfieldtypes:textfield" };
    const result = findings(atlField, { totalIssueCount: 1000, usageStatus: "ready" });
    expect(result.reasons.find((r) => r.title.includes("App-provided"))).toBeUndefined();
  });
});

describe("buildGovernanceFindings — rule: global context with low usage", () => {
  test("fires for non-system field with global context and low issues", () => {
    const result = findings(customField, { hasGlobalContext: true, totalIssueCount: 10, usageStatus: "ready" });
    expect(result.reasons.find((r) => r.title.includes("Global context"))).toBeDefined();
  });

  test("does not fire when issue count meets or exceeds threshold", () => {
    const result = findings(customField, { hasGlobalContext: true, totalIssueCount: 100, usageStatus: "ready" });
    expect(result.reasons.find((r) => r.title.includes("Global context"))).toBeUndefined();
  });
});

describe("buildGovernanceFindings — rule: high dead-configuration ratio", () => {
  test("fires when inactive ratio >= configuredActiveGapMaxRatio", () => {
    // 10 configured, 2 active → 80% inactive (> 70%)
    const result = findings(customField, { configuredProjectCount: 10, activeProjectCount: 2, usageStatus: "ready" });
    expect(result.reasons.find((r) => r.title.includes("dead-configuration"))).toBeDefined();
  });

  test("does not fire below minimum configured project count", () => {
    const result = findings(customField, { configuredProjectCount: 2, activeProjectCount: 0, usageStatus: "ready" });
    expect(result.reasons.find((r) => r.title.includes("dead-configuration"))).toBeUndefined();
  });

  test("does not fire when inactive ratio is within acceptable range", () => {
    // 10 configured, 5 active → 50% inactive (< 70%)
    const result = findings(customField, { configuredProjectCount: 10, activeProjectCount: 5, usageStatus: "ready" });
    expect(result.reasons.find((r) => r.title.includes("dead-configuration"))).toBeUndefined();
  });
});

describe("buildGovernanceFindings — rule: orphaned field", () => {
  const orphanField = { id: "customfield_orphan", name: "Orphan", description: "" };

  test("fires when no configuration, no issues, no activity, and not app-provided", () => {
    const result = findings(orphanField, { configuredProjectCount: 0, totalIssueCount: 0, activeProjectCount: 0, usageStatus: "ready" });
    expect(result.reasons.find((r) => r.title.includes("Orphaned"))).toBeDefined();
  });

  test("does not fire for app-provided field (even if unused)", () => {
    const appOrphan = { id: "customfield_x", name: "X", customType: "com.vendor:type" };
    const result = findings(appOrphan, { configuredProjectCount: 0, totalIssueCount: 0, activeProjectCount: 0, usageStatus: "ready" });
    expect(result.reasons.find((r) => r.title.includes("Orphaned"))).toBeUndefined();
  });
});

describe("buildGovernanceFindings — rule: configured with no issues", () => {
  test("fires when configured in >= broadScopeMinProjects but zero issues", () => {
    const result = findings(customField, { configuredProjectCount: 5, totalIssueCount: 0, activeProjectCount: 0, usageStatus: "ready" });
    expect(result.reasons.find((r) => r.title.includes("no populated issues"))).toBeDefined();
  });

  test("does not fire when configured in fewer than broadScopeMinProjects", () => {
    const result = findings(customField, { configuredProjectCount: 2, totalIssueCount: 0, activeProjectCount: 0, usageStatus: "ready" });
    expect(result.reasons.find((r) => r.title.includes("no populated issues"))).toBeUndefined();
  });
});

describe("buildGovernanceFindings — rule: system field with no usage", () => {
  test("fires for system field with zero issues", () => {
    const result = findings(systemField, { isSystemField: true, totalIssueCount: 0, usageStatus: "ready" });
    expect(result.reasons.find((r) => r.title.includes("System field"))).toBeDefined();
  });

  test("does not fire for custom field", () => {
    const result = findings(customField, { isSystemField: false, totalIssueCount: 0, usageStatus: "ready" });
    expect(result.reasons.find((r) => r.title.includes("System field"))).toBeUndefined();
  });
});

describe("buildGovernanceFindings — rule: broadly scoped with light usage", () => {
  test("fires when breadth >= threshold but issues are within light-usage band", () => {
    const result = findings(customField, { activeProjectCount: 5, totalIssueCount: 50, usageStatus: "ready" });
    expect(result.reasons.find((r) => r.title.includes("very light usage"))).toBeDefined();
  });

  test("does not fire when totalIssueCount is 0 (different rule handles that)", () => {
    const result = findings(customField, { activeProjectCount: 5, totalIssueCount: 0, usageStatus: "ready" });
    expect(result.reasons.find((r) => r.title.includes("very light usage"))).toBeUndefined();
  });

  test("does not fire when issues exceed lightUsageMaxIssues", () => {
    const result = findings(customField, { activeProjectCount: 5, totalIssueCount: 500, usageStatus: "ready" });
    expect(result.reasons.find((r) => r.title.includes("very light usage"))).toBeUndefined();
  });
});

describe("buildGovernanceFindings — rule: no field activity in over a year", () => {
  const NOW = Date.parse("2026-07-30T00:00:00.000Z");
  const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
  const stale = (over, extra = {}) =>
    findings(customField, {
      totalIssueCount: 400,
      activeProjectCount: 2,
      usageStatus: "ready",
      lastFieldChangeAt: daysAgo(over),
      now: NOW,
      ...extra,
    });
  const rule = (result) => result.reasons.find((r) => r.title.includes("No field activity"));

  test("fires for a populated field whose last change is older than the threshold", () => {
    const result = stale(400);
    expect(rule(result)).toBeDefined();
    expect(rule(result).category).toBe("cleanup");
    expect(rule(result).severity).toBe("medium");
  });

  test("does not fire when the last change is inside the threshold", () => {
    expect(rule(stale(364))).toBeUndefined();
  });

  test("fires exactly at the threshold boundary", () => {
    expect(rule(stale(365))).toBeDefined();
  });

  test("respects a custom staleFieldMaxAgeDays threshold", () => {
    const result = findings(
      customField,
      { totalIssueCount: 400, usageStatus: "ready", lastFieldChangeAt: daysAgo(200), now: NOW },
      { staleFieldMaxAgeDays: 180 }
    );
    expect(rule(result)).toBeDefined();
  });

  // The whole point of the totalIssueCount > 0 guard: an unpopulated field is already
  // reported by the orphaned / "configured but no populated issues" rules.
  test("does not fire for a field with no populated issues", () => {
    expect(rule(stale(1000, { totalIssueCount: 0 }))).toBeUndefined();
  });

  test("does not fire when no change date is known", () => {
    expect(rule(stale(400, { lastFieldChangeAt: null }))).toBeUndefined();
  });

  test("does not fire when usage data is unavailable", () => {
    expect(rule(stale(400, { usageStatus: "unavailable" }))).toBeUndefined();
  });

  test("does not fire for system fields", () => {
    const result = findings(systemField, {
      totalIssueCount: 400,
      usageStatus: "ready",
      isSystemField: true,
      lastFieldChangeAt: daysAgo(900),
      now: NOW,
    });
    expect(rule(result)).toBeUndefined();
  });

  test("reports years once past two years, days below that", () => {
    expect(rule(stale(400)).detail).toContain("400 days ago");
    expect(rule(stale(800)).detail).toContain("2 years ago");
  });

  test("tags the field for cleanup", () => {
    expect(stale(400).tags.cleanup).toBe(true);
  });
});

describe("daysSince", () => {
  const NOW = Date.parse("2026-07-30T00:00:00.000Z");

  test("returns whole days elapsed", () => {
    expect(daysSince(new Date(NOW - 10 * 86400000).toISOString(), NOW)).toBe(10);
  });

  test("floors partial days", () => {
    expect(daysSince(new Date(NOW - (10 * 86400000 + 3600000)).toISOString(), NOW)).toBe(10);
  });

  test("returns null for missing, unparseable, or future dates", () => {
    expect(daysSince(null, NOW)).toBeNull();
    expect(daysSince("", NOW)).toBeNull();
    expect(daysSince("not-a-date", NOW)).toBeNull();
    expect(daysSince(new Date(NOW + 86400000).toISOString(), NOW)).toBeNull();
  });

  test("accepts a plain date string", () => {
    expect(daysSince("2026-07-20", NOW)).toBe(10);
  });
});

describe("buildGovernanceFindings — rule: context sprawl", () => {
  test("fires when contextCount >= threshold", () => {
    const result = findings(customField, { contextCount: 8 });
    expect(result.reasons.find((r) => r.title.includes("Context sprawl"))).toBeDefined();
  });

  test("does not fire below threshold", () => {
    const result = findings(customField, { contextCount: 3 });
    expect(result.reasons.find((r) => r.title.includes("Context sprawl"))).toBeUndefined();
  });
});

describe("buildGovernanceFindings — rule: duplicate naming", () => {
  test("fires when duplicateNameCount > 1", () => {
    const result = findings(customField, { duplicateNameCount: 3 });
    expect(result.reasons.find((r) => r.title.includes("Similar field naming"))).toBeDefined();
  });

  test("does not fire when name is unique (count == 1)", () => {
    const result = findings(customField, { duplicateNameCount: 1 });
    expect(result.reasons.find((r) => r.title.includes("Similar field naming"))).toBeUndefined();
  });

  test("duplicate score scales with count but caps at 50", () => {
    const two = findings(customField, { duplicateNameCount: 2 });
    const ten = findings(customField, { duplicateNameCount: 10 });
    expect(ten.priorityScore).toBeGreaterThan(two.priorityScore);
    const twoScore = two.priorityScore;
    const tenScore = ten.priorityScore;
    expect(tenScore - twoScore).toBeLessThanOrEqual(30); // max additional from dup scaling
  });
});

describe("buildGovernanceFindings — rule: missing description", () => {
  const noDescField = { id: "customfield_1", name: "Field", description: "" };

  test("fires when breadth is wide and no meaningful description", () => {
    const result = findings(noDescField, { activeProjectCount: 5, totalIssueCount: 1000, usageStatus: "ready" });
    expect(result.reasons.find((r) => r.title.includes("lacks a meaningful description"))).toBeDefined();
  });

  test("does not fire when description is present", () => {
    const withDesc = { ...noDescField, description: "A helpful description." };
    const result = findings(withDesc, { activeProjectCount: 5, usageStatus: "ready" });
    expect(result.reasons.find((r) => r.title.includes("lacks a meaningful description"))).toBeUndefined();
  });

  test("fires based on issue count alone even without broad project scope", () => {
    const result = findings(noDescField, { activeProjectCount: 1, totalIssueCount: 600, usageStatus: "ready" });
    expect(result.reasons.find((r) => r.title.includes("lacks a meaningful description"))).toBeDefined();
  });
});

describe("buildGovernanceFindings — rule: usage data unavailable", () => {
  test("fires when usageStatus is not ready", () => {
    const result = findings(customField, { usageStatus: USAGE_STATUS_UNAVAILABLE });
    expect(result.reasons.find((r) => r.title.includes("unavailable"))).toBeDefined();
    expect(result.tags.review).toBe(true);
  });

  test("uses usageStatusDetail in the detail message", () => {
    const result = findings(customField, { usageStatus: USAGE_STATUS_UNAVAILABLE, usageStatusDetail: "Custom detail." });
    const rule = result.reasons.find((r) => r.title.includes("unavailable"));
    expect(rule.detail).toBe("Custom detail.");
  });

  test("does not fire when usageStatus is ready", () => {
    const result = findings(customField, { usageStatus: USAGE_STATUS_READY });
    expect(result.reasons.find((r) => r.title.includes("unavailable"))).toBeUndefined();
  });
});

describe("buildGovernanceFindings — adminAttention and tags", () => {
  test("adminAttention is true when any reason has severity high", () => {
    const result = findings(customField, { activeProjectCount: 10, totalIssueCount: 1000, usageStatus: "ready" });
    expect(result.adminAttention).toBe(true);
    expect(result.tags.adminAttention).toBe(true);
  });

  test("adminAttention is true when priorityScore >= 35 (no high-severity needed)", () => {
    // orphaned field scores 25; add context sprawl (15) = 40 >= 35
    const result = findings(customField, { contextCount: 8, configuredProjectCount: 0, totalIssueCount: 0, activeProjectCount: 0, usageStatus: "ready" });
    expect(result.priorityScore).toBeGreaterThanOrEqual(35);
    expect(result.adminAttention).toBe(true);
  });

  test("adminAttention is false when score < 35 and no high-severity", () => {
    const result = findings(customField, {});
    expect(result.adminAttention).toBe(false);
    expect(result.tags.adminAttention).toBe(false);
  });

  test("tags reflect categories found in reasons", () => {
    const result = findings(customField, { activeProjectCount: 10, totalIssueCount: 1000, usageStatus: "ready" });
    expect(result.tags.risky).toBe(true);
    expect(result.categories).toContain("risky");
  });

  test("custom thresholds override defaults", () => {
    // Lower highImpactMinProjects to 3 — should fire with activeProjectCount=5
    const result = findings(customField, { activeProjectCount: 5, totalIssueCount: 1000, usageStatus: "ready" }, { highImpactMinProjects: 3 });
    expect(result.reasons.find((r) => r.title.includes("High-impact"))).toBeDefined();
  });
});

// ── mergeProjectUsageCounts ───────────────────────────────────────────────────

describe("mergeProjectUsageCounts", () => {
  const makeProject = (id, key, issueCount, extra = {}) => ({
    projectId: id, projectKey: key, projectName: `Project ${key}`,
    jql: `project = ${key}`, issueCount, ...extra,
  });

  test("returns empty array when both inputs are empty", () => {
    expect(mergeProjectUsageCounts([], [])).toHaveLength(0);
  });

  test("returns existing projects when nextProjects is empty", () => {
    const result = mergeProjectUsageCounts([makeProject("1", "AAA", 100)], []);
    expect(result).toHaveLength(1);
    expect(result[0].projectId).toBe("1");
  });

  test("adds new projects from nextProjects", () => {
    const result = mergeProjectUsageCounts([], [makeProject("2", "BBB", 50)]);
    expect(result).toHaveLength(1);
    expect(result[0].issueCount).toBe(50);
  });

  test("accumulates issueCount for the same project", () => {
    const existing = [makeProject("1", "AAA", 100)];
    const next = [makeProject("1", "AAA", 50)];
    const result = mergeProjectUsageCounts(existing, next);
    expect(result).toHaveLength(1);
    expect(result[0].issueCount).toBe(150);
  });

  test("updates timestamp when nextUpdatedAt is newer", () => {
    const existing = [makeProject("1", "AAA", 10, { latestIssueUpdatedAt: "2025-01-01T00:00:00Z" })];
    const next = [makeProject("1", "AAA", 5, { latestIssueUpdatedAt: "2026-01-01T00:00:00Z" })];
    const result = mergeProjectUsageCounts(existing, next);
    expect(result[0].latestIssueUpdatedAt).toBe("2026-01-01T00:00:00Z");
  });

  test("sorts by issueCount descending, then projectKey ascending", () => {
    const existing = [makeProject("1", "AAA", 50), makeProject("2", "BBB", 200)];
    const result = mergeProjectUsageCounts(existing, []);
    expect(result[0].projectKey).toBe("BBB");
    expect(result[1].projectKey).toBe("AAA");
  });
});

// ── compareFields ─────────────────────────────────────────────────────────────

describe("compareFields", () => {
  const field = (name, totalIssueCount, configuredProjectCount, activeProjectCount, priorityScore) => ({
    name, totalIssueCount, configuredProjectCount, activeProjectCount,
    findings: { priorityScore: priorityScore ?? 0 },
  });

  test("name-asc: alphabetical ascending", () => {
    expect(compareFields(field("Bravo", 0), field("Alpha", 0), "name-asc")).toBeGreaterThan(0);
  });

  test("name-desc: alphabetical descending", () => {
    expect(compareFields(field("Alpha", 0), field("Bravo", 0), "name-desc")).toBeGreaterThan(0);
  });

  test("usage-desc (default): higher totalIssueCount first", () => {
    expect(compareFields(field("A", 10), field("B", 100), "usage-desc")).toBeGreaterThan(0);
  });

  test("usage-desc: falls back to priorityScore when issue counts are equal", () => {
    expect(compareFields(field("A", 100, 0, 0, 5), field("B", 100, 0, 0, 50), "usage-desc")).toBeGreaterThan(0);
  });

  test("usage-asc: lower totalIssueCount first", () => {
    expect(compareFields(field("A", 100), field("B", 10), "usage-asc")).toBeGreaterThan(0);
  });

  test("active-projects-desc: higher activeProjectCount first", () => {
    expect(compareFields(field("A", 0, 0, 2), field("B", 0, 0, 5), "active-projects-desc")).toBeGreaterThan(0);
  });

  test("active-projects-asc: lower activeProjectCount first", () => {
    expect(compareFields(field("A", 0, 0, 5), field("B", 0, 0, 2), "active-projects-asc")).toBeGreaterThan(0);
  });

  test("uses configuredProjectCount as usage when totalIssueCount is 0", () => {
    const a = field("A", 0, 20, 0);
    const b = field("B", 0, 5, 0);
    expect(compareFields(a, b, "usage-asc")).toBeGreaterThan(0);
  });

  const fieldWithContexts = (name, contextCount, priorityScore) => ({
    name, totalIssueCount: 0, configuredProjectCount: 0, activeProjectCount: 0,
    contextCount, findings: { priorityScore: priorityScore ?? 0 },
  });

  test("contexts-desc: higher contextCount first", () => {
    expect(compareFields(fieldWithContexts("A", 2), fieldWithContexts("B", 5), "contexts-desc")).toBeGreaterThan(0);
  });

  test("contexts-desc: ties broken by name", () => {
    expect(compareFields(fieldWithContexts("Bravo", 3), fieldWithContexts("Alpha", 3), "contexts-desc")).toBeGreaterThan(0);
  });

  test("contexts-asc: lower contextCount first", () => {
    expect(compareFields(fieldWithContexts("A", 5), fieldWithContexts("B", 2), "contexts-asc")).toBeGreaterThan(0);
  });

  test("contexts-asc: ties broken by name", () => {
    expect(compareFields(fieldWithContexts("Bravo", 3), fieldWithContexts("Alpha", 3), "contexts-asc")).toBeGreaterThan(0);
  });

  test("priority-desc: higher priorityScore first, independent of usage", () => {
    const a = field("A", 1000, 0, 0, 5);
    const b = field("B", 1, 0, 0, 50);
    expect(compareFields(a, b, "priority-desc")).toBeGreaterThan(0);
  });

  test("priority-desc: ties broken by name", () => {
    expect(compareFields(field("Bravo", 0, 0, 0, 10), field("Alpha", 0, 0, 0, 10), "priority-desc")).toBeGreaterThan(0);
  });

  test("priority-desc: missing priorityScore treated as 0", () => {
    const a = { name: "A", totalIssueCount: 0, findings: {} };
    const b = { name: "B", totalIssueCount: 0, findings: { priorityScore: 5 } };
    expect(compareFields(a, b, "priority-desc")).toBeGreaterThan(0);
  });
});

// ── filterInventoryFields ─────────────────────────────────────────────────────

const makeField = (overrides) => ({
  id: "customfield_1",
  name: "My Field",
  type: "text",
  customType: null,
  description: "",
  isJiraBuiltin: false,
  isSystemField: false,
  totalIssueCount: 100,
  projectUsageState: "unbuilt",
  projectUsageBuilt: false,
  findings: { tags: {} },
  ...overrides,
});

describe("filterInventoryFields", () => {
  test("returns all fields when no filters applied", () => {
    const fields = [makeField({ name: "A" }), makeField({ name: "B" })];
    expect(filterInventoryFields(fields)).toHaveLength(2);
  });

  test("filters by query (name match, case-insensitive)", () => {
    const fields = [makeField({ name: "Sprint Goal" }), makeField({ name: "Epic Link" })];
    expect(filterInventoryFields(fields, "sprint")).toHaveLength(1);
    expect(filterInventoryFields(fields, "SPRINT")).toHaveLength(1);
  });

  test("filters by exact type", () => {
    const fields = [makeField({ type: "select" }), makeField({ type: "text" })];
    expect(filterInventoryFields(fields, "", "select")).toHaveLength(1);
  });

  test("filters by fieldOrigin: jira-builtin", () => {
    const fields = [makeField({ isJiraBuiltin: true }), makeField({ isJiraBuiltin: false })];
    expect(filterInventoryFields(fields, "", "all", "all", "", "jira-builtin")).toHaveLength(1);
  });

  test("filters by fieldOrigin: user-created", () => {
    const fields = [makeField({ isJiraBuiltin: false, isSystemField: false }), makeField({ isJiraBuiltin: true })];
    expect(filterInventoryFields(fields, "", "all", "all", "", "user-created")).toHaveLength(1);
  });

  test("filters projectUsageFilter: built", () => {
    const fields = [makeField({ projectUsageBuilt: true }), makeField({ projectUsageBuilt: false })];
    expect(filterInventoryFields(fields, "", "all", "built")).toHaveLength(1);
  });

  test("filters projectUsageFilter: not-built (only when has issues)", () => {
    const fields = [
      makeField({ projectUsageBuilt: false, totalIssueCount: 50 }),
      makeField({ projectUsageBuilt: false, totalIssueCount: 0 }),
      makeField({ projectUsageBuilt: true, totalIssueCount: 50 }),
    ];
    expect(filterInventoryFields(fields, "", "all", "not-built")).toHaveLength(1);
  });

  test("filters by minIssuesWithValue", () => {
    const fields = [makeField({ totalIssueCount: 5 }), makeField({ totalIssueCount: 50 })];
    expect(filterInventoryFields(fields, "", "all", "all", "", "all", "10")).toHaveLength(1);
  });

  test("filters by maxIssuesWithValue", () => {
    const fields = [makeField({ totalIssueCount: 5 }), makeField({ totalIssueCount: 50 })];
    expect(filterInventoryFields(fields, "", "all", "all", "20")).toHaveLength(1);
  });

  describe("extra options (8th arg)", () => {
    test("minActiveProjects: keeps fields at or above the threshold", () => {
      const fields = [
        makeField({ name: "A", activeProjectCount: 2 }),
        makeField({ name: "B", activeProjectCount: 5 }),
        makeField({ name: "C", activeProjectCount: 10 }),
      ];
      const result = filterInventoryFields(fields, "", "all", "all", "", "all", "", { minActiveProjects: "5" });
      expect(result.map((f) => f.name)).toEqual(["B", "C"]);
    });

    test("minActiveProjects: boundary value is inclusive", () => {
      const fields = [makeField({ name: "A", activeProjectCount: 5 }), makeField({ name: "B", activeProjectCount: 4 })];
      const result = filterInventoryFields(fields, "", "all", "all", "", "all", "", { minActiveProjects: "5" });
      expect(result.map((f) => f.name)).toEqual(["A"]);
    });

    test("maxActiveProjects: keeps fields at or below the threshold", () => {
      const fields = [
        makeField({ name: "A", activeProjectCount: 2 }),
        makeField({ name: "B", activeProjectCount: 5 }),
        makeField({ name: "C", activeProjectCount: 10 }),
      ];
      const result = filterInventoryFields(fields, "", "all", "all", "", "all", "", { maxActiveProjects: "5" });
      expect(result.map((f) => f.name)).toEqual(["A", "B"]);
    });

    test("minActiveProjects/maxActiveProjects: empty string applies no filter", () => {
      const fields = [makeField({ activeProjectCount: 0 }), makeField({ activeProjectCount: 100 })];
      expect(filterInventoryFields(fields, "", "all", "all", "", "all", "", { minActiveProjects: "", maxActiveProjects: "" })).toHaveLength(2);
    });

    test("minActiveProjects/maxActiveProjects: combined range filters within bounds", () => {
      const fields = [
        makeField({ name: "A", activeProjectCount: 1 }),
        makeField({ name: "B", activeProjectCount: 5 }),
        makeField({ name: "C", activeProjectCount: 9 }),
      ];
      const result = filterInventoryFields(fields, "", "all", "all", "", "all", "", { minActiveProjects: "3", maxActiveProjects: "7" });
      expect(result.map((f) => f.name)).toEqual(["B"]);
    });

    test("minContexts: keeps fields at or above the threshold", () => {
      const fields = [
        makeField({ name: "A", contextCount: 1 }),
        makeField({ name: "B", contextCount: 3 }),
        makeField({ name: "C", contextCount: 8 }),
      ];
      const result = filterInventoryFields(fields, "", "all", "all", "", "all", "", { minContexts: "3" });
      expect(result.map((f) => f.name)).toEqual(["B", "C"]);
    });

    test("maxContexts: keeps fields at or below the threshold", () => {
      const fields = [
        makeField({ name: "A", contextCount: 1 }),
        makeField({ name: "B", contextCount: 3 }),
        makeField({ name: "C", contextCount: 8 }),
      ];
      const result = filterInventoryFields(fields, "", "all", "all", "", "all", "", { maxContexts: "3" });
      expect(result.map((f) => f.name)).toEqual(["A", "B"]);
    });

    test("minContexts/maxContexts: empty string applies no filter", () => {
      const fields = [makeField({ contextCount: 0 }), makeField({ contextCount: 100 })];
      expect(filterInventoryFields(fields, "", "all", "all", "", "all", "", { minContexts: "", maxContexts: "" })).toHaveLength(2);
    });

    test("minContexts/maxContexts: boundary values are inclusive", () => {
      const fields = [makeField({ name: "A", contextCount: 4 }), makeField({ name: "B", contextCount: 6 })];
      const result = filterInventoryFields(fields, "", "all", "all", "", "all", "", { minContexts: "4", maxContexts: "4" });
      expect(result.map((f) => f.name)).toEqual(["A"]);
    });

    test("duplicateNamesOnly: true keeps only fields with duplicateNameCount > 1", () => {
      const fields = [
        makeField({ name: "A", duplicateNameCount: 1 }),
        makeField({ name: "B", duplicateNameCount: 2 }),
        makeField({ name: "C", duplicateNameCount: 3 }),
      ];
      const result = filterInventoryFields(fields, "", "all", "all", "", "all", "", { duplicateNamesOnly: true });
      expect(result.map((f) => f.name)).toEqual(["B", "C"]);
    });

    test("duplicateNamesOnly: false/omitted applies no filter", () => {
      const fields = [makeField({ duplicateNameCount: 1 }), makeField({ duplicateNameCount: 3 })];
      expect(filterInventoryFields(fields, "", "all", "all", "", "all", "", { duplicateNamesOnly: false })).toHaveLength(2);
      expect(filterInventoryFields(fields, "", "all", "all", "", "all", "", {})).toHaveLength(2);
    });

    test("hasDescription: 'yes' keeps only fields with non-empty description", () => {
      const fields = [
        makeField({ name: "A", description: "Has text" }),
        makeField({ name: "B", description: "" }),
        makeField({ name: "C", description: "   " }),
      ];
      const result = filterInventoryFields(fields, "", "all", "all", "", "all", "", { hasDescription: "yes" });
      expect(result.map((f) => f.name)).toEqual(["A"]);
    });

    test("hasDescription: 'no' keeps only fields with empty/missing description", () => {
      const fields = [
        makeField({ name: "A", description: "Has text" }),
        makeField({ name: "B", description: "" }),
        makeField({ name: "C", description: undefined }),
      ];
      const result = filterInventoryFields(fields, "", "all", "all", "", "all", "", { hasDescription: "no" });
      expect(result.map((f) => f.name)).toEqual(["B", "C"]);
    });

    test("hasDescription: 'all'/omitted applies no filter", () => {
      const fields = [makeField({ description: "" }), makeField({ description: "text" })];
      expect(filterInventoryFields(fields, "", "all", "all", "", "all", "", { hasDescription: "all" })).toHaveLength(2);
      expect(filterInventoryFields(fields, "", "all", "all", "", "all", "")).toHaveLength(2);
    });

    test("combines multiple new filters together", () => {
      const fields = [
        makeField({ name: "A", activeProjectCount: 5, contextCount: 4, duplicateNameCount: 2, description: "desc" }),
        makeField({ name: "B", activeProjectCount: 1, contextCount: 4, duplicateNameCount: 2, description: "desc" }),
        makeField({ name: "C", activeProjectCount: 5, contextCount: 1, duplicateNameCount: 2, description: "desc" }),
        makeField({ name: "D", activeProjectCount: 5, contextCount: 4, duplicateNameCount: 1, description: "desc" }),
        makeField({ name: "E", activeProjectCount: 5, contextCount: 4, duplicateNameCount: 2, description: "" }),
      ];
      const result = filterInventoryFields(fields, "", "all", "all", "", "all", "", {
        minActiveProjects: "3",
        minContexts: "2",
        duplicateNamesOnly: true,
        hasDescription: "yes",
      });
      expect(result.map((f) => f.name)).toEqual(["A"]);
    });
  });
});

// ── isSelectFieldType ─────────────────────────────────────────────────────────

describe("isSelectFieldType", () => {
  test.each([
    ["select", true],
    ["multiselect", true],
    ["radiobutton", true],
    ["checkbox", true],
    ["cascadingselect", true],
    ["multi-select", true],
    ["text", false],
    ["number", false],
    ["", false],
    [null, false],
  ])("isSelectFieldType(%s) → %s", (input, expected) => {
    expect(isSelectFieldType(input)).toBe(expected);
  });
});

// ── applyFindingsFilter ───────────────────────────────────────────────────────

describe("applyFindingsFilter", () => {
  const fields = [
    makeField({ findings: { tags: { adminAttention: true, risky: true } } }),
    makeField({ findings: { tags: { cleanup: true } } }),
    makeField({ findings: { tags: { standardize: true } } }),
    makeField({ findings: { tags: {} } }),
  ];

  test("returns all fields for 'all' filter", () => {
    expect(applyFindingsFilter(fields, "all")).toHaveLength(4);
  });

  test("returns all fields when findingsFilter is empty/falsy", () => {
    expect(applyFindingsFilter(fields, null)).toHaveLength(4);
    expect(applyFindingsFilter(fields, "")).toHaveLength(4);
  });

  test("filters by admin-attention", () => {
    expect(applyFindingsFilter(fields, "admin-attention")).toHaveLength(1);
  });

  test("filters by risky", () => {
    expect(applyFindingsFilter(fields, "risky")).toHaveLength(1);
  });

  test("filters by cleanup", () => {
    expect(applyFindingsFilter(fields, "cleanup")).toHaveLength(1);
  });

  test("filters by standardize", () => {
    expect(applyFindingsFilter(fields, "standardize")).toHaveLength(1);
  });
});

// ── sortInventoryFields ───────────────────────────────────────────────────────

describe("sortInventoryFields", () => {
  test("returns a new array (does not mutate original)", () => {
    const fields = [makeField({ name: "B", totalIssueCount: 100 }), makeField({ name: "A", totalIssueCount: 200 })];
    const sorted = sortInventoryFields(fields, "name-asc");
    expect(sorted).not.toBe(fields);
    expect(fields[0].name).toBe("B");
  });

  test("sorts by name-asc", () => {
    const fields = [makeField({ name: "Zebra" }), makeField({ name: "Alpha" })];
    const sorted = sortInventoryFields(fields, "name-asc");
    expect(sorted[0].name).toBe("Alpha");
  });

  test("sorts by contexts-desc", () => {
    const fields = [
      makeField({ name: "A", contextCount: 1 }),
      makeField({ name: "B", contextCount: 9 }),
      makeField({ name: "C", contextCount: 4 }),
    ];
    const sorted = sortInventoryFields(fields, "contexts-desc");
    expect(sorted.map((f) => f.name)).toEqual(["B", "C", "A"]);
  });

  test("sorts by contexts-asc", () => {
    const fields = [
      makeField({ name: "A", contextCount: 1 }),
      makeField({ name: "B", contextCount: 9 }),
      makeField({ name: "C", contextCount: 4 }),
    ];
    const sorted = sortInventoryFields(fields, "contexts-asc");
    expect(sorted.map((f) => f.name)).toEqual(["A", "C", "B"]);
  });

  test("contexts-desc: ties broken by name", () => {
    const fields = [
      makeField({ name: "Bravo", contextCount: 3 }),
      makeField({ name: "Alpha", contextCount: 3 }),
    ];
    const sorted = sortInventoryFields(fields, "contexts-desc");
    expect(sorted.map((f) => f.name)).toEqual(["Alpha", "Bravo"]);
  });

  test("sorts by priority-desc, independent of usage/issue count", () => {
    const fields = [
      makeField({ name: "A", totalIssueCount: 1000, findings: { tags: {}, priorityScore: 1 } }),
      makeField({ name: "B", totalIssueCount: 1, findings: { tags: {}, priorityScore: 9 } }),
      makeField({ name: "C", totalIssueCount: 500, findings: { tags: {}, priorityScore: 4 } }),
    ];
    const sorted = sortInventoryFields(fields, "priority-desc");
    expect(sorted.map((f) => f.name)).toEqual(["B", "C", "A"]);
  });

  test("priority-desc: ties broken by name", () => {
    const fields = [
      makeField({ name: "Bravo", findings: { tags: {}, priorityScore: 5 } }),
      makeField({ name: "Alpha", findings: { tags: {}, priorityScore: 5 } }),
    ];
    const sorted = sortInventoryFields(fields, "priority-desc");
    expect(sorted.map((f) => f.name)).toEqual(["Alpha", "Bravo"]);
  });
});

// ── summarizeFindings ─────────────────────────────────────────────────────────

describe("summarizeFindings", () => {
  test("returns all-zero summary for empty array", () => {
    expect(summarizeFindings([])).toEqual({ adminAttention: 0, risky: 0, cleanup: 0, standardize: 0 });
  });

  test("counts all active tag categories", () => {
    const fields = [
      makeField({ findings: { tags: { adminAttention: true, risky: true } } }),
      makeField({ findings: { tags: { cleanup: true, standardize: true } } }),
      makeField({ findings: { tags: { adminAttention: true } } }),
    ];
    expect(summarizeFindings(fields)).toEqual({ adminAttention: 2, risky: 1, cleanup: 1, standardize: 1 });
  });

  test("ignores fields with no findings", () => {
    const fields = [makeField({ findings: null }), makeField({ findings: { tags: {} } })];
    expect(summarizeFindings(fields)).toEqual({ adminAttention: 0, risky: 0, cleanup: 0, standardize: 0 });
  });
});

// ── buildInventoryRecord ──────────────────────────────────────────────────────

describe("buildInventoryRecord", () => {
  const rawField = {
    id: "customfield_12345",
    name: "Sprint Goal",
    description: "Track sprint objectives.",
    schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea" },
    searcherKey: "com.atlassian.jira.plugin.system.customfieldtypes:textsearcher",
  };

  test("maps field and default metrics correctly", () => {
    const record = buildInventoryRecord(rawField, {});
    expect(record.id).toBe("customfield_12345");
    expect(record.name).toBe("Sprint Goal");
    expect(record.primitiveType).toBe("string");
    expect(record.customType).toBe("com.atlassian.jira.plugin.system.customfieldtypes:textarea");
    expect(record.usageStatus).toBe(USAGE_STATUS_READY);
    expect(record.configuredProjectCount).toBe(0);
    expect(record.isSystemField).toBe(false);
  });

  test("marks non-customfield IDs as system fields", () => {
    const sysField = { id: "summary", name: "Summary", schema: { type: "string" } };
    const record = buildInventoryRecord(sysField, {});
    expect(record.isSystemField).toBe(true);
  });

  test("sets projectUsageBuilt from metrics", () => {
    const record = buildInventoryRecord(rawField, { projectUsageBuilt: true, projectUsageState: "ready" });
    expect(record.projectUsageBuilt).toBe(true);
    expect(record.projectUsageState).toBe("ready");
  });

  test("fieldJql is a non-empty string", () => {
    const record = buildInventoryRecord(rawField, {});
    expect(typeof record.fieldJql).toBe("string");
    expect(record.fieldJql.length).toBeGreaterThan(0);
  });

  test("isJiraBuiltin is set from field's customType", () => {
    const record = buildInventoryRecord(rawField, {});
    expect(record.isJiraBuiltin).toBe(true);
  });
});
