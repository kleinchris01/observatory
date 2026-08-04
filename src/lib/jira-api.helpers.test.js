import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// Companion to jira-api.test.js. That file covers the transport layer (retry,
// rate limiting, pagination primitives); this one covers the Jira-specific
// helpers built on top of it. Split for readability -- same module, same mocks.

const mockRequestJira = vi.fn();
const mockRequestJiraAsUser = vi.fn();

vi.mock("@forge/api", () => ({
  default: {
    asApp: () => ({ requestJira: mockRequestJira }),
    asUser: () => ({ requestJira: mockRequestJiraAsUser }),
  },
  route: (strings, ...values) => strings.reduce((acc, s, i) => acc + s + (values[i] ?? ""), ""),
}));

vi.mock("@forge/metrics", () => ({
  internalMetrics: { counter: () => ({ incr: vi.fn(), incrBy: vi.fn() }) },
}));

import {
  getFieldConfiguredProjectCount,
  getFieldTotalIssueCount,
  getDistinctIssueCountForFields,
  getProjectBreakdownByAssociation,
  getProjectBreakdownByIssueScan,
  loadFieldContexts,
  searchProjectFieldUsage,
  getLiveFieldProjectUsage,
  findFieldIdsByOptionValue,
  loadFieldOptionsFromJira,
  collectRecentFieldProjectCandidates,
  getFieldProjectAssociations,
  resetJiraRateLimiterState,
  extractWorkflowScheme,
  normalizeWorkflowSearchResponse,
  getAllWorkflowsWithStatuses,
  getEverInStatusCounts,
  getProjectStatuses,
  getStatusesForProjects,
  JIRA_REQUEST_HARD_TIMEOUT_MS,
} from "./jira-api.js";

// Not exported by the module; mirrored here so the timer mock can recognise it.
const ISSUE_COUNT_TIMEOUT_MS = 8000;
// Same reason: getEverInStatusCounts wraps each WAS query in this budget, and firing it
// would make every request look like a timeout.
const STATUS_HISTORY_TIMEOUT_MS = 15000;

function jiraResponse({ ok = true, status = 200, body = {}, text = "" } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => text,
    headers: { get: () => null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetJiraRateLimiterState();
  // Pin jitter to a fixed non-zero value FIRST. Retry backoff is
  // `min(30000, 2000 * 2^n) + jitter`, so with jitter 0 it can land exactly on a
  // deadline value (8000) and the timer mock below could not tell a delay from a
  // deadline. A fixed 500ms jitter makes the two sets disjoint.
  vi.spyOn(Math, "random").mockReturnValue(0.5);

  // Collapse delays, leave deadlines pending. The two deadlines in this module are
  // the 8s per-count budget and the 12s hard request deadline; firing either would
  // make it win its race and turn every result into a timeout.
  const DEADLINES = new Set([ISSUE_COUNT_TIMEOUT_MS, STATUS_HISTORY_TIMEOUT_MS, JIRA_REQUEST_HARD_TIMEOUT_MS]);
  vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms) => {
    if (!DEADLINES.has(ms)) fn();
    return 0;
  });
});

afterEach(() => vi.restoreAllMocks());

// ── Count helpers ─────────────────────────────────────────────────────────────
//
// These share one convention worth pinning: -1 means "could not determine", which
// is NOT 0 ("confirmed none"). Governance findings branch on that difference, so a
// timeout collapsing to 0 would silently flag healthy fields as unused.

describe("getFieldConfiguredProjectCount", () => {
  test("returns the association total", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { total: 12 } }));
    await expect(getFieldConfiguredProjectCount("customfield_1")).resolves.toBe(12);
  });

  test("falls back to the values length when total is absent", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { values: [{}, {}] } }));
    await expect(getFieldConfiguredProjectCount("customfield_1")).resolves.toBe(2);
  });

  test("returns 0 when the field is genuinely configured nowhere", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { total: 0 } }));
    await expect(getFieldConfiguredProjectCount("customfield_1")).resolves.toBe(0);
  });

  test("returns -1 rather than 0 when the lookup fails", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ ok: false, status: 403, text: "denied" }));
    await expect(getFieldConfiguredProjectCount("customfield_1")).resolves.toBe(-1);
  });
});

describe("getFieldTotalIssueCount", () => {
  test("prefers the purpose-built approximate-count endpoint", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { count: 4321 } }));
    await expect(getFieldTotalIssueCount("customfield_1")).resolves.toBe(4321);
    expect(mockRequestJira).toHaveBeenCalledTimes(1);
    expect(mockRequestJira.mock.calls[0][0]).toContain("approximate-count");
  });

  test("accepts an approximate count of zero without falling through", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { count: 0 } }));
    await expect(getFieldTotalIssueCount("customfield_1")).resolves.toBe(0);
    expect(mockRequestJira).toHaveBeenCalledTimes(1);
  });

  test("falls back to a JQL search when approximate-count is unavailable", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ ok: false, status: 404, text: "no endpoint" }))
      .mockResolvedValueOnce(jiraResponse({ body: { total: 99 } }));

    await expect(getFieldTotalIssueCount("customfield_1")).resolves.toBe(99);
    expect(mockRequestJira.mock.calls[1][0]).toContain("search/jql");
  });

  test("falls back when approximate-count returns a non-numeric count", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { count: null } }))
      .mockResolvedValueOnce(jiraResponse({ body: { total: 7 } }));
    await expect(getFieldTotalIssueCount("customfield_1")).resolves.toBe(7);
  });

  test("returns -1 when both paths fail", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ ok: false, status: 400, text: "bad jql" }));
    await expect(getFieldTotalIssueCount("customfield_1")).resolves.toBe(-1);
  });
});

describe("getDistinctIssueCountForFields", () => {
  test("ORs the field conditions into a single query", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { count: 500 } }));
    await getDistinctIssueCountForFields(["customfield_1", "customfield_2"]);

    const sent = JSON.parse(mockRequestJira.mock.calls[0][1].body);
    expect(sent.jql).toContain(" OR ");
    expect(sent.jql).toContain("cf[1]");
    expect(sent.jql).toContain("cf[2]");
  });

  test("deduplicates and trims the field list", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { count: 1 } }));
    await getDistinctIssueCountForFields([" customfield_1 ", "customfield_1", "", null]);

    const sent = JSON.parse(mockRequestJira.mock.calls[0][1].body);
    expect(sent.jql).not.toContain(" OR ");
  });

  test("short-circuits to 0 for an empty field list without calling Jira", async () => {
    await expect(getDistinctIssueCountForFields([])).resolves.toBe(0);
    await expect(getDistinctIssueCountForFields(null)).resolves.toBe(0);
    expect(mockRequestJira).not.toHaveBeenCalled();
  });

  test("returns -1 when both count paths fail", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ ok: false, status: 500, text: "boom" }));
    await expect(getDistinctIssueCountForFields(["customfield_1"])).resolves.toBe(-1);
  });
});

// ── Project associations and breakdowns ───────────────────────────────────────

describe("getFieldProjectAssociations", () => {
  // Jira returns either {projectId, projectKey, projectName} or {id, key, name}
  // depending on the endpoint version, so the helper normalizes both shapes and
  // always emits all three keys.
  test("normalizes the projectId/projectKey/projectName shape", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: { values: [{ projectId: "1", projectKey: "AAA", projectName: "Alpha" }] },
    }));
    await expect(getFieldProjectAssociations("customfield_1"))
      .resolves.toEqual([{ id: "1", key: "AAA", name: "Alpha" }]);
  });

  test("normalizes the plain id/key/name shape and defaults a missing name", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: { values: [{ id: "1", key: "AAA" }] },
    }));
    await expect(getFieldProjectAssociations("customfield_1"))
      .resolves.toEqual([{ id: "1", key: "AAA", name: "" }]);
  });

  // A row with no resolvable id cannot be joined to anything downstream.
  test("drops rows with no project id", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: { values: [{ key: "AAA" }, { id: "2", key: "BBB" }] },
    }));
    const result = await getFieldProjectAssociations("customfield_1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("2");
  });
});

describe("getProjectBreakdownByAssociation", () => {
  test("returns an empty complete result when the field is associated with nothing", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { values: [] } }));

    await expect(getProjectBreakdownByAssociation("customfield_1")).resolves.toMatchObject({
      projects: [],
      configuredProjectCount: 0,
      isComplete: true,
    });
  });

  test("counts issues per associated project", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({
        body: { values: [{ id: "1", key: "AAA", name: "Alpha" }, { id: "2", key: "BBB", name: "Beta" }] },
      }))
      .mockResolvedValue(jiraResponse({ body: { total: 5 } }));

    const result = await getProjectBreakdownByAssociation("customfield_1");
    expect(result.projects).toHaveLength(2);
    expect(result.configuredProjectCount).toBe(2);
    expect(result.projects[0]).toMatchObject({ issueCount: 5 });
    expect(result.projects[0].jql).toContain("cf[1]");
  });

  // A configured-but-empty project is noise in the usage table -- the point of the
  // view is where the field actually holds data.
  test("omits projects with a zero issue count", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: "1", key: "AAA", name: "Alpha" }] } }))
      .mockResolvedValue(jiraResponse({ body: { total: 0 } }));

    const result = await getProjectBreakdownByAssociation("customfield_1");
    expect(result.projects).toEqual([]);
    expect(result.configuredProjectCount).toBe(1);
  });

  test("reports incompleteness and the next offset when a batch is capped", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: String(i), key: "P" + i, name: "P" + i }));
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { values: many } }))
      .mockResolvedValue(jiraResponse({ body: { total: 1 } }));

    const result = await getProjectBreakdownByAssociation("customfield_1", 0, 2);
    expect(result.processedProjectCount).toBe(2);
    expect(result.nextStartAt).toBe(2);
    expect(result.isComplete).toBe(false);
  });

  test("escapes quotes in project keys so the JQL stays valid", async () => {
    const quotedKey = 'A"B';
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: "1", key: quotedKey, name: "Quoted" }] } }))
      .mockResolvedValue(jiraResponse({ body: { total: 1 } }));

    await getProjectBreakdownByAssociation("customfield_1");
    const sent = JSON.parse(mockRequestJira.mock.calls[1][1].body);
    expect(sent.jql).toContain('A\\"B');
  });

  test("resolves the project separately when the association omits a key", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: "42" }] } }))
      .mockResolvedValueOnce(jiraResponse({ body: { id: "42", key: "CCC", name: "Gamma" } }))
      .mockResolvedValue(jiraResponse({ body: { total: 2 } }));

    const result = await getProjectBreakdownByAssociation("customfield_1");
    expect(result.projects[0]).toMatchObject({ projectKey: "CCC", issueCount: 2 });
  });
});

describe("getProjectBreakdownByIssueScan", () => {
  test("tallies issues per project from a single page", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: {
        total: 2,
        isLast: true,
        issues: [
          { key: "AAA-1", fields: { project: { id: "1", key: "AAA", name: "Alpha" }, updated: "2026-01-01T00:00:00.000Z" } },
          { key: "AAA-2", fields: { project: { id: "1", key: "AAA", name: "Alpha" }, updated: "2026-02-01T00:00:00.000Z" } },
        ],
      },
    }));

    const result = await getProjectBreakdownByIssueScan("customfield_1");
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].issueCount).toBe(2);
    expect(result.isComplete).toBe(true);
  });

  test("keeps the newest issue as the latest-change marker", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: {
        total: 2,
        isLast: true,
        issues: [
          { key: "AAA-1", fields: { project: { id: "1", key: "AAA" }, updated: "2026-01-01T00:00:00.000Z" } },
          { key: "AAA-2", fields: { project: { id: "1", key: "AAA" }, updated: "2026-06-01T00:00:00.000Z" } },
        ],
      },
    }));

    const result = await getProjectBreakdownByIssueScan("customfield_1");
    expect(result.projects[0].latestIssueKey).toBe("AAA-2");
    expect(result.projects[0].latestFieldChangeAt).toBe("2026-06-01T00:00:00.000Z");
  });

  test("passes the cursor token through on a continued scan", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { issues: [], isLast: true } }));
    await getProjectBreakdownByIssueScan("customfield_1", "token-abc");

    const sent = JSON.parse(mockRequestJira.mock.calls[0][1].body);
    expect(sent.nextPageToken).toBe("token-abc");
  });

  test("omits nextPageToken on a fresh scan", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { issues: [], isLast: true } }));
    await getProjectBreakdownByIssueScan("customfield_1");

    const sent = JSON.parse(mockRequestJira.mock.calls[0][1].body);
    expect(sent).not.toHaveProperty("nextPageToken");
  });

  test("returns the continuation token when more pages remain", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: {
        total: 500,
        nextPageToken: "next-1",
        issues: [{ key: "AAA-1", fields: { project: { id: "1", key: "AAA" } } }],
      },
    }));

    const result = await getProjectBreakdownByIssueScan("customfield_1", null, 1);
    expect(result.nextPageToken).toBe("next-1");
    expect(result.isComplete).toBe(false);
  });

  // Jira has been observed returning issues with neither isLast nor a continuation
  // token while total says more remain. Without this flag the scan would report a
  // partial tally as complete.
  test("flags paginationBroken when Jira stops paginating mid-result", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: {
        total: 500,
        issues: [{ key: "AAA-1", fields: { project: { id: "1", key: "AAA" } } }],
      },
    }));

    const result = await getProjectBreakdownByIssueScan("customfield_1", null, 1);
    expect(result.paginationBroken).toBe(true);
    expect(result.isComplete).toBe(false);
  });

  test("skips issues with no resolvable project", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: { total: 1, isLast: true, issues: [{ key: "X-1", fields: {} }] },
    }));

    const result = await getProjectBreakdownByIssueScan("customfield_1");
    expect(result.projects).toEqual([]);
    expect(result.scannedIssueCount).toBe(1);
  });

  test("stops immediately on an empty first page", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { total: 0, issues: [] } }));
    const result = await getProjectBreakdownByIssueScan("customfield_1");
    expect(result.isComplete).toBe(true);
    expect(mockRequestJira).toHaveBeenCalledTimes(1);
  });
});

// ── Contexts, usage, options ──────────────────────────────────────────────────

describe("loadFieldContexts", () => {
  test("degrades to contexts alone when the mapping endpoints fail", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: "ctx-1", name: "Default" }] } }))
      .mockResolvedValue(jiraResponse({ ok: false, status: 403, text: "denied" }));

    await expect(loadFieldContexts("customfield_1")).resolves.toBeDefined();
  });

  test("resolves project ids from the mappings", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: "ctx-1", name: "Default" }] } }))
      .mockResolvedValueOnce(jiraResponse({ body: { values: [{ contextId: "ctx-1", projectId: "10" }] } }))
      .mockResolvedValueOnce(jiraResponse({ body: { values: [] } }))
      .mockResolvedValue(jiraResponse({ body: { id: "10", key: "AAA", name: "Alpha" } }));

    await expect(loadFieldContexts("customfield_1")).resolves.toBeDefined();
  });
});

describe("searchProjectFieldUsage", () => {
  test("returns the issue count with the most recent issue", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({
      body: {
        total: 3,
        issues: [{
          key: "AAA-9",
          fields: { updated: "2026-05-05T00:00:00.000Z", project: { id: "1", key: "AAA", name: "Alpha" } },
        }],
      },
    }));

    await expect(searchProjectFieldUsage("customfield_1", "AAA")).resolves.toMatchObject({
      issueCount: 3,
      project: { key: "AAA", name: "Alpha" },
      latestIssue: { key: "AAA-9", updated: "2026-05-05T00:00:00.000Z" },
    });
  });

  test("returns nulls when the project holds no matching issues", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { total: 0, issues: [] } }));
    await expect(searchProjectFieldUsage("customfield_1", "AAA")).resolves.toEqual({
      issueCount: 0,
      project: null,
      latestIssue: null,
    });
  });

  test("orders by updated so the first issue really is the newest", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { total: 0, issues: [] } }));
    await searchProjectFieldUsage("customfield_1", "AAA");
    expect(JSON.parse(mockRequestJira.mock.calls[0][1].body).jql).toContain("ORDER BY updated DESC");
  });
});

describe("getLiveFieldProjectUsage", () => {
  test("paginates populated projects and totals their issue counts", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({
        body: { values: [{ id: "1", key: "AAA", name: "Alpha" }, { id: "2", key: "BBB", name: "Beta" }] },
      }))
      .mockResolvedValue(jiraResponse({
        body: { total: 4, issues: [{ key: "X-1", fields: { updated: "2026-01-01T00:00:00.000Z" } }] },
      }));

    const result = await getLiveFieldProjectUsage("customfield_1", 1, 1);
    expect(result.total).toBe(2);
    expect(result.totalIssueCount).toBe(8);
    expect(result.projectUsage).toHaveLength(1);
  });

  test("excludes projects with no populated issues", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: "1", key: "AAA", name: "Alpha" }] } }))
      .mockResolvedValue(jiraResponse({ body: { total: 0, issues: [] } }));

    await expect(getLiveFieldProjectUsage("customfield_1", 1, 10)).resolves.toMatchObject({
      total: 0,
      totalIssueCount: 0,
      projectUsage: [],
    });
  });
});

describe("collectRecentFieldProjectCandidates", () => {
  test("maps changed custom fields to the projects they changed in", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: {
        total: 1,
        isLast: true,
        issues: [{
          id: "1",
          fields: { project: { key: "AAA" }, updated: "2026-07-01T00:00:00.000Z" },
          changelog: { histories: [{ items: [{ fieldId: "customfield_100" }] }] },
        }],
      },
    }));

    const result = await collectRecentFieldProjectCandidates(24, 100);
    expect(result.scannedIssues).toBe(1);
    expect(result.fields).toEqual([{ fieldId: "customfield_100", projectKeys: ["AAA"] }]);
  });

  test("ignores changelog entries for system fields", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: {
        total: 1,
        isLast: true,
        issues: [{
          id: "1",
          fields: { project: { key: "AAA" } },
          changelog: { histories: [{ items: [{ field: "status" }] }] },
        }],
      },
    }));

    await expect(collectRecentFieldProjectCandidates()).resolves.toMatchObject({ fields: [] });
  });

  test("skips issues with no project key", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: { total: 1, isLast: true, issues: [{ id: "1", fields: {} }] },
    }));

    const result = await collectRecentFieldProjectCandidates();
    expect(result.scannedIssues).toBe(1);
    expect(result.fields).toEqual([]);
  });

  test("returns empty for a site with no recent changes", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { total: 0, issues: [] } }));
    await expect(collectRecentFieldProjectCandidates()).resolves.toEqual({ scannedIssues: 0, fields: [] });
  });

  test("builds a JQL window from the requested hours", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { issues: [] } }));
    await collectRecentFieldProjectCandidates(48);
    expect(JSON.parse(mockRequestJira.mock.calls[0][1].body).jql).toContain("-48h");
  });
});

describe("findFieldIdsByOptionValue", () => {
  const selectFields = [
    { id: "customfield_1", type: "select" },
    { id: "customfield_2", type: "multiselect" },
  ];

  test("short-circuits on an empty query without scanning", async () => {
    await expect(findFieldIdsByOptionValue(selectFields, "   ")).resolves.toMatchObject({
      matchingIds: null,
      done: true,
      scanned: 0,
    });
    expect(mockRequestJira).not.toHaveBeenCalled();
  });

  test("matches option values case-insensitively on a substring", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: "ctx-1" }] } }))
      .mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: "o1", value: "DCV-Alpha" }] } }))
      .mockResolvedValue(jiraResponse({ body: { values: [] } }));

    const result = await findFieldIdsByOptionValue([selectFields[0]], "dcv");
    expect(result.matchingIds.has("customfield_1")).toBe(true);
  });

  test("ignores fields whose type cannot hold options", async () => {
    const result = await findFieldIdsByOptionValue([{ id: "customfield_9", type: "textfield" }], "x");
    expect(result.totalCandidates).toBe(0);
    expect(result.done).toBe(true);
  });

  // One field's options failing must not abort the whole option search.
  test("logs and continues when a field's option lookup fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRequestJira.mockResolvedValue(jiraResponse({ ok: false, status: 500, text: "boom" }));

    const result = await findFieldIdsByOptionValue([selectFields[0]], "dcv");
    expect(result.matchingIds.size).toBe(0);
    expect(console.warn).toHaveBeenCalled();
  });

  test("reports batch position so the caller can resume", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { values: [] } }));
    const result = await findFieldIdsByOptionValue(selectFields, "x", 0, 1);
    expect(result).toMatchObject({ scanned: 1, nextIndex: 1, done: false, totalCandidates: 2 });
  });
});

describe("loadFieldOptionsFromJira", () => {
  test("returns options grouped per context", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({
        body: { values: [{ id: "ctx-1", name: "Global", isGlobalContext: true }] },
      }))
      .mockResolvedValueOnce(jiraResponse({
        body: { values: [{ id: "o1", value: "Alpha", disabled: false }, { id: "o2", value: "Beta", disabled: true }] },
      }));

    const result = await loadFieldOptionsFromJira("customfield_1");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ contextId: "ctx-1", contextName: "Global", isGlobalContext: true });
    expect(result[0].options).toEqual([
      { id: "o1", value: "Alpha", disabled: false },
      { id: "o2", value: "Beta", disabled: true },
    ]);
  });

  test("defaults the context name when Jira omits it", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: "ctx-1" }] } }))
      .mockResolvedValueOnce(jiraResponse({ body: { values: [] } }));

    const result = await loadFieldOptionsFromJira("customfield_1");
    expect(result[0].contextName).toBe("Default context");
    expect(result[0].isGlobalContext).toBe(false);
  });

  // A failing context is reported inline rather than failing the whole modal, so
  // the admin still sees options from the contexts that did load.
  test("records fetchError for a context whose options fail to load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: "ctx-1", name: "Broken" }] } }))
      .mockResolvedValue(jiraResponse({ ok: false, status: 500, text: "boom" }));

    const result = await loadFieldOptionsFromJira("customfield_1");
    expect(result[0].options).toEqual([]);
    expect(result[0].fetchError).toBeTruthy();
  });
});

// The /workflowscheme/project endpoint returns a container, not a scheme. Reading it wrong
// is invisible in the UI -- it renders as a plausible-looking inventory of one-project
// schemes all named "(unnamed workflow scheme)" -- so the shape is pinned here.
describe("extractWorkflowScheme", () => {
  it("reads the scheme out of the values[] container", () => {
    const scheme = extractWorkflowScheme({
      values: [{ projectIds: ["10000"], workflowScheme: { id: 10000, name: "Ford ADV Scheme" } }],
    });
    expect(scheme).toEqual({ id: 10000, name: "Ford ADV Scheme" });
  });

  it("returns null for the bare container, rather than treating it as a scheme", () => {
    // This is the regression: the container has no id and no name, so using it as a scheme
    // fabricated a distinct `unknown-<projectId>` entry for every project on the site.
    expect(extractWorkflowScheme({ values: [] })).toBeNull();
    expect(extractWorkflowScheme({ values: [{ projectIds: ["1"] }] })).toBeNull();
  });

  it("returns null for empty or malformed responses", () => {
    expect(extractWorkflowScheme(null)).toBeNull();
    expect(extractWorkflowScheme({})).toBeNull();
    expect(extractWorkflowScheme({ values: null })).toBeNull();
  });

  it("accepts a scheme with an id but no name", () => {
    expect(extractWorkflowScheme({ values: [{ workflowScheme: { id: 7 } }] })).toEqual({ id: 7 });
  });

  it("falls back to a top-level workflowScheme if the API ever returns one", () => {
    expect(extractWorkflowScheme({ workflowScheme: { id: 3, name: "Direct" } }))
      .toEqual({ id: 3, name: "Direct" });
  });
});

// Two generations of Jira's workflow-search endpoint disagree about where statuses live,
// and the difference is silent: a statusReference is a UUID, not a status id, so matching
// references straight against the status catalog yields zero overlap -- indistinguishable
// from a site whose schemes genuinely have no statuses. That is exactly how this failed on
// staging, leaving all 435 statuses looking unreachable.
describe("normalizeWorkflowSearchResponse", () => {
  test("reads the deprecated shape, where statuses carry ids directly", () => {
    expect(normalizeWorkflowSearchResponse({
      values: [{ id: { name: "Bug WF" }, statuses: [{ id: "3" }, { id: "5" }] }],
    })).toEqual([{ name: "Bug WF", statusIds: ["3", "5"] }]);
  });

  test("resolves statusReference UUIDs through the current shape's lookup table", () => {
    const result = normalizeWorkflowSearchResponse({
      workflows: [{ name: "Bug WF", statuses: [{ statusReference: "uuid-a" }, { statusReference: "uuid-b" }] }],
      statuses: [
        { statusReference: "uuid-a", id: "3", name: "In Review" },
        { statusReference: "uuid-b", id: "5", name: "Done" },
      ],
    });

    // Real status ids, never the references themselves.
    expect(result).toEqual([{ name: "Bug WF", statusIds: ["3", "5"] }]);
  });

  test("drops references it cannot resolve rather than emitting a UUID as a status id", () => {
    const result = normalizeWorkflowSearchResponse({
      workflows: [{ name: "Bug WF", statuses: [{ statusReference: "unknown-uuid" }, { statusReference: "uuid-a" }] }],
      statuses: [{ statusReference: "uuid-a", id: "3" }],
    });

    expect(result).toEqual([{ name: "Bug WF", statusIds: ["3"] }]);
  });

  test("skips workflows with no resolvable name", () => {
    expect(normalizeWorkflowSearchResponse({ workflows: [{ statuses: [{ id: "3" }] }] })).toEqual([]);
  });

  test("returns an empty list for empty or malformed responses", () => {
    expect(normalizeWorkflowSearchResponse(null)).toEqual([]);
    expect(normalizeWorkflowSearchResponse({})).toEqual([]);
    expect(normalizeWorkflowSearchResponse({ workflows: [] })).toEqual([]);
  });

  test("tolerates a workflow with no statuses at all", () => {
    expect(normalizeWorkflowSearchResponse({ workflows: [{ name: "Empty WF" }] }))
      .toEqual([{ name: "Empty WF", statusIds: [] }]);
  });
});

// The endpoint fallback exists because the deprecated GET form returns 401
// "scope does not match" for an app declaring granular scopes -- which is how the scheme
// to status mapping silently came back empty on staging, making all 435 statuses look
// unreachable. These pin the order and the failure handling.
describe("getAllWorkflowsWithStatuses", () => {
  test("uses the current bulk endpoint and resolves status references", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: {
        workflows: [{ name: "Bug WF", statuses: [{ statusReference: "uuid-a" }] }],
        statuses: [{ statusReference: "uuid-a", id: "3" }],
      },
    }));

    await expect(getAllWorkflowsWithStatuses()).resolves.toEqual([{ name: "Bug WF", statusIds: ["3"] }]);
    expect(mockRequestJira).toHaveBeenCalledTimes(1);
    expect(mockRequestJira.mock.calls[0][0]).toContain("/workflows/search");
    expect(mockRequestJira.mock.calls[0][1].method).toBe("POST");
  });

  test("falls back to the legacy endpoint when the bulk one is rejected", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ ok: false, status: 401, text: "Unauthorized; scope does not match" }))
      .mockResolvedValueOnce(jiraResponse({
        body: { values: [{ id: { name: "Legacy WF" }, statuses: [{ id: "7" }] }], isLast: true },
      }));

    const result = await getAllWorkflowsWithStatuses();

    expect(result).toEqual([{ name: "Legacy WF", statusIds: ["7"] }]);
    expect(mockRequestJira.mock.calls.at(-1)[0]).toContain("/workflow/search");
  });

  test("falls back when the bulk endpoint succeeds but yields nothing usable", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { somethingElse: true } }))
      .mockResolvedValueOnce(jiraResponse({
        body: { values: [{ id: { name: "Legacy WF" }, statuses: [{ id: "7" }] }], isLast: true },
      }));

    // A 200 that parses to zero workflows means the shape changed, not that the site has
    // none -- so it must still try the other endpoint rather than report an empty site.
    await expect(getAllWorkflowsWithStatuses()).resolves.toEqual([{ name: "Legacy WF", statusIds: ["7"] }]);
  });

  test("propagates the error when both endpoints fail", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ ok: false, status: 500, text: "boom" }));
    await expect(getAllWorkflowsWithStatuses()).rejects.toThrow();
  });
});

// "Ever been in a status" via JQL's WAS operator: one approximate-count per status
// instead of re-reading every issue with expand=changelog, which on a 317k-issue site is
// the difference between minutes and hours.
describe("getEverInStatusCounts", () => {
  test("queries by status ID, unquoted, so duplicate names stay distinguishable", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { count: 4000 } }));

    await getEverInStatusCounts(["10001"]);

    const sent = JSON.parse(mockRequestJira.mock.calls[0][1].body);
    // A site with "Done" five times would give `status WAS "Done"` one meaningless total.
    expect(sent.jql).toBe("status WAS 10001");
  });

  test("returns a count per status", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { count: 4000 } }))
      .mockResolvedValueOnce(jiraResponse({ body: { count: 0 } }));

    const { counts, failures } = await getEverInStatusCounts(["1", "2"]);

    expect(counts.get("1")).toBe(4000);
    expect(counts.get("2")).toBe(0);
    expect(failures).toEqual([]);
  });

  // A status whose query failed must be absent from the map, not present as zero: zero is
  // exactly what marks a status safe to delete.
  test("reports failures separately instead of recording them as zero", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { count: 12 } }))
      .mockResolvedValue(jiraResponse({ ok: false, status: 400, text: "bad jql" }));

    const { counts, failures } = await getEverInStatusCounts(["1", "2"]);

    expect(counts.get("1")).toBe(12);
    expect(counts.has("2")).toBe(false);
    expect(failures).toHaveLength(1);
    expect(failures[0].statusId).toBe("2");
  });

  test("deduplicates and ignores blank ids", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { count: 1 } }));

    await getEverInStatusCounts(["1", "1", "", null, undefined]);

    expect(mockRequestJira).toHaveBeenCalledTimes(1);
  });

  test("makes no calls at all for an empty status list", async () => {
    const { counts } = await getEverInStatusCounts([]);
    expect(counts.size).toBe(0);
    expect(mockRequestJira).not.toHaveBeenCalled();
  });
});

// The route around the workflow endpoints, which 401 on a fully-upgraded install.
describe("getProjectStatuses / getStatusesForProjects", () => {
  test("flattens statuses across issue types and deduplicates", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: [
      { id: "1", name: "Bug", statuses: [{ id: "10" }, { id: "11" }] },
      { id: "2", name: "Task", statuses: [{ id: "11" }, { id: "12" }] },
    ] }));

    // 11 appears under both issue types but is one reachable status.
    await expect(getProjectStatuses("10000")).resolves.toEqual(["10", "11", "12"]);
  });

  test("returns an empty list for a project with no issue types", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: [] }));
    await expect(getProjectStatuses("10000")).resolves.toEqual([]);
  });

  test("tolerates a malformed response rather than throwing", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { notAnArray: true } }));
    await expect(getProjectStatuses("10000")).resolves.toEqual([]);
  });

  test("maps every project it can read", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: [{ statuses: [{ id: "1" }] }] }))
      .mockResolvedValueOnce(jiraResponse({ body: [{ statuses: [{ id: "2" }] }] }));

    const { byProject, failures } = await getStatusesForProjects(["10", "11"]);

    expect(byProject.get("10")).toEqual(["1"]);
    expect(byProject.get("11")).toEqual(["2"]);
    expect(failures).toEqual([]);
  });

  // One unreadable project must not empty the mapping for the whole site -- that would
  // make every status look orphaned.
  test("collects per-project failures instead of failing the batch", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: [{ statuses: [{ id: "1" }] }] }))
      .mockResolvedValue(jiraResponse({ ok: false, status: 403, text: "no permission" }));

    const { byProject, failures } = await getStatusesForProjects(["10", "11"]);

    expect(byProject.get("10")).toEqual(["1"]);
    expect(byProject.has("11")).toBe(false);
    expect(failures).toHaveLength(1);
    expect(failures[0].projectId).toBe("11");
  });

  test("makes no calls for an empty project list", async () => {
    const { byProject } = await getStatusesForProjects([]);
    expect(byProject.size).toBe(0);
    expect(mockRequestJira).not.toHaveBeenCalled();
  });
});
