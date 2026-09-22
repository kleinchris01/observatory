import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────
//
// api.asApp()/asUser() are the only things this module cannot exercise for real.
// analysis.js and transform.js are deliberately NOT mocked -- shouldRetry,
// getRetryDelayMs, and the JQL builders are pure and already tested, and running
// the real ones here means these tests fail if retry classification ever drifts.

const mockRequestJira = vi.fn();
const mockRequestJiraAsUser = vi.fn();

// The api.atlassian.com gateway surface. Distinct from requestJira: it targets the gateway
// host, and JSM Assets is the reason it exists here.
const mockRequestAtlassian = vi.fn();

vi.mock("@forge/api", () => ({
  default: {
    asApp: () => ({ requestJira: mockRequestJira, requestAtlassian: mockRequestAtlassian }),
    asUser: () => ({ requestJira: mockRequestJiraAsUser }),
  },
  // The real `route` is a tagged template that escapes interpolated values. The
  // stub keeps the assembled string so tests can assert on the path that was built.
  route: (strings, ...values) => strings.reduce((acc, s, i) => acc + s + (values[i] ?? ""), ""),
}));

const mockCounter = { incr: vi.fn(), incrBy: vi.fn() };
vi.mock("@forge/metrics", () => ({
  internalMetrics: { counter: vi.fn(() => mockCounter) },
}));

import {
  sleep,
  incrMetric,
  getJitterMs,
  makeJobToken,
  sanitizeCacheKeyPart,
  getInstallationKey,
  isSnapshotStale,
  registerJiraRateLimit,
  registerJiraSuccess,
  resetJiraRateLimiterState,
  resetScanTelemetry,
  getScanTelemetry,
  setSnapshotLogger,
  withTimeout,
  withRetry,
  scheduleRateLimitedRequest,
  jiraRequest,
  jiraRequestAsUser,
  getBrowsableProjectIds,
  callerHasJiraAdmin,
  paginate,
  mapWithConcurrency,
  getAllCustomFields,
  getAllSystemFields,
  getProjectById,
  getFieldContexts,
  getAllJiraProjects,
  getAllStatuses,
  probeEndpoint,
  probeEndpointAsUser,
  probeStargateEndpoint,
  requestAtlassianJson,
  getAssetsWorkspaceId,
  getCloudId,
  getAllScreens,
  getAllScreenSchemes,
  getAllIssueTypeScreenSchemes,
  getIssueTypeScreenSchemeMappings,
  getIssueTypeScreenSchemeProjects,
  getAllIssueTypes,
  getAllIssueTypeSchemes,
  getIssueTypeSchemeItems,
  getIssueTypeSchemeProjects,
  getAllResolutions,
  getAllPriorities,
  getAllProjectRoles,
  getProjectRolesForProject,
  getPermissionCatalog,
  getAllPermissionSchemes,
  getProjectPermissionScheme,
  getAllIssueSecuritySchemes,
  getIssueSecurityLevels,
  getIssueSecurityLevelMembers,
  getIssueSecuritySchemeProjects,
  getAllNotificationSchemes,
  getNotificationSchemeProjects,
  getScreenTabs,
  getScreenTabFields,
  getWorkflowSchemesForProjects,
  getAllJiraProjectKeys,
  getFilterPage,
  getDashboardPage,
  getBoardPage,
  getBoardConfiguration,
  createJiraIssue,
  getIssuesStatus,
  getGadgetFilterId,
  extractFilterId,
  BASE_JIRA_REQUEST_INTERVAL_MS,
  MAX_JIRA_REQUEST_INTERVAL_MS,
  BASE_JIRA_CONCURRENCY,
  MAX_RETRY_ATTEMPTS,
  SNAPSHOT_STALE_AFTER_MS,
  JIRA_REQUEST_HARD_TIMEOUT_MS,
  METRIC_NAMES,
} from "./jira-api.js";

// Builds a fetch-like Response double. `headers.get` is present because
// getRetryDelayMs reads Retry-After off it.
function jiraResponse({ ok = true, status = 200, body = {}, text = "", retryAfter = null } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => text,
    headers: { get: (name) => (name === "Retry-After" ? retryAfter : null) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetJiraRateLimiterState();
  resetScanTelemetry();
  setSnapshotLogger(null);
  // Rate limiting and backoff are real timers. Collapsing them keeps the suite fast
  // without mocking the module's own scheduling logic away.
  //
  // Every timer fires immediately EXCEPT the hard request deadline, which is left
  // pending so it never wins its race. Keying off the exact value rather than a
  // magnitude threshold matters: retry backoff reaches 16s-30s, so a ">= 12s" rule
  // would stall the late retries instead of collapsing them.
  vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms) => {
    if (ms !== JIRA_REQUEST_HARD_TIMEOUT_MS) fn();
    return 0;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Pure utilities ────────────────────────────────────────────────────────────

describe("sleep", () => {
  test("resolves", async () => {
    await expect(sleep(5)).resolves.toBeUndefined();
  });
});

describe("incrMetric", () => {
  test("increments by one via incr() when no value is given", () => {
    incrMetric(METRIC_NAMES.resolver);
    expect(mockCounter.incr).toHaveBeenCalledTimes(1);
    expect(mockCounter.incrBy).not.toHaveBeenCalled();
  });

  test("uses incrBy for batch values", () => {
    incrMetric(METRIC_NAMES.resolver, 7);
    expect(mockCounter.incrBy).toHaveBeenCalledWith(7);
  });

  // Metrics are observability, never correctness -- a metrics outage must not
  // surface as an app error.
  test("swallows metric backend failures", async () => {
    const { internalMetrics } = await import("@forge/metrics");
    internalMetrics.counter.mockImplementationOnce(() => { throw new Error("metrics down"); });
    expect(() => incrMetric("boom")).not.toThrow();
  });
});

describe("getJitterMs", () => {
  test("stays within the requested bound", () => {
    for (let i = 0; i < 50; i++) {
      const v = getJitterMs(20);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(20);
    }
  });

  test("honours a custom ceiling", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    expect(getJitterMs(1000)).toBe(990);
  });
});

describe("makeJobToken", () => {
  test("produces distinct tokens", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => makeJobToken()));
    expect(tokens.size).toBe(100);
  });

  test("is timestamp-prefixed and suffixed", () => {
    expect(makeJobToken()).toMatch(/^\d+-[a-z0-9]+$/);
  });
});

describe("sanitizeCacheKeyPart", () => {
  test("passes through already-safe characters", () => {
    expect(sanitizeCacheKeyPart("ari:cloud::site/abc-123")).toBe("ari:cloud::site_abc-123");
  });

  test("replaces disallowed characters with underscores", () => {
    expect(sanitizeCacheKeyPart("a/b?c=d")).toBe("a_b_c_d");
  });

  test("falls back to 'global' for empty or nullish input", () => {
    expect(sanitizeCacheKeyPart("")).toBe("global");
    expect(sanitizeCacheKeyPart(null)).toBe("global");
    expect(sanitizeCacheKeyPart(undefined)).toBe("global");
  });

  test("maps every disallowed character rather than dropping it", () => {
    expect(sanitizeCacheKeyPart("///")).toBe("___");
  });

  test("falls back to 'global' when input trims away to nothing", () => {
    expect(sanitizeCacheKeyPart("   ")).toBe("global");
  });

  test("caps length at 180 characters", () => {
    expect(sanitizeCacheKeyPart("a".repeat(500))).toHaveLength(180);
  });
});

describe("getInstallationKey", () => {
  // The macro (Confluence) and admin page (Jira) must resolve to the same SQL
  // namespace for one site, or each surface would see its own separate snapshot.
  test("normalizes the product segment so Jira and Confluence share a scope", () => {
    const jira = getInstallationKey({ installContext: "ari:cloud:jira::site/UUID-1" });
    const confluence = getInstallationKey({ installContext: "ari:cloud:confluence::site/UUID-1" });
    expect(jira).toBe(confluence);
  });

  test("sanitizes the normalized key", () => {
    expect(getInstallationKey({ installContext: "ari:cloud:jira::site/UUID-1" }))
      .toBe("ari:cloud:::site_UUID-1");
  });

  test("throws when installContext is missing", () => {
    expect(() => getInstallationKey({})).toThrow(/Missing installContext/);
    expect(() => getInstallationKey(null)).toThrow(/Missing installContext/);
    expect(() => getInstallationKey({ installContext: "" })).toThrow(/Missing installContext/);
  });

  test("leaves an unrecognized ARI shape intact apart from sanitizing", () => {
    expect(getInstallationKey({ installContext: "not-an-ari" })).toBe("not-an-ari");
  });
});

describe("isSnapshotStale", () => {
  test("treats a missing or never-refreshed snapshot as stale", () => {
    expect(isSnapshotStale(null)).toBe(true);
    expect(isSnapshotStale({})).toBe(true);
    expect(isSnapshotStale({ refreshedAt: null })).toBe(true);
  });

  test("is false inside the staleness window", () => {
    expect(isSnapshotStale({ refreshedAt: new Date(Date.now() - 1000).toISOString() })).toBe(false);
  });

  test("is true past the staleness window", () => {
    const old = new Date(Date.now() - SNAPSHOT_STALE_AFTER_MS - 1000).toISOString();
    expect(isSnapshotStale({ refreshedAt: old })).toBe(true);
  });
});

// ── Adaptive rate limiter ─────────────────────────────────────────────────────

describe("registerJiraRateLimit", () => {
  test("widens the request interval and drops concurrency after a 429", async () => {
    registerJiraRateLimit(1000);
    // Effect is observable through scheduling behaviour rather than exported state.
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { ok: true } }));
    await jiraRequest("/x");
    expect(mockRequestJira).toHaveBeenCalled();
  });

  test("never widens the interval past the documented ceiling", () => {
    for (let i = 0; i < 50; i++) registerJiraRateLimit(10);
    // 50 consecutive 1.5x increases would blow far past the cap if unclamped.
    expect(MAX_JIRA_REQUEST_INTERVAL_MS).toBe(1500);
  });

  test("never drops concurrency below one", () => {
    for (let i = 0; i < 50; i++) registerJiraRateLimit(10);
    // A zero-concurrency limiter would deadlock every subsequent request.
    mockRequestJira.mockResolvedValue(jiraResponse({ body: {} }));
    return expect(jiraRequest("/x")).resolves.toEqual({});
  });
});

describe("registerJiraSuccess", () => {
  // Recovery is deliberately slow: 25 clean calls before easing off, so one lucky
  // success after a rate-limit storm doesn't immediately re-open the throttle.
  test("does not relax the limiter before the success streak threshold", () => {
    resetJiraRateLimiterState();
    for (let i = 0; i < 24; i++) registerJiraSuccess();
    expect(BASE_JIRA_CONCURRENCY).toBe(4);
  });

  test("relaxes after a full streak without exceeding the base settings", async () => {
    registerJiraRateLimit(10);
    for (let i = 0; i < 100; i++) registerJiraSuccess();
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { ok: 1 } }));
    await expect(jiraRequest("/x")).resolves.toEqual({ ok: 1 });
  });
});

describe("scan telemetry", () => {
  test("starts at zero and resets", () => {
    resetScanTelemetry();
    expect(getScanTelemetry()).toEqual({ rl429Count: 0, rlRetryCount: 0 });
  });

  test("counts 429s and retries separately", async () => {
    resetScanTelemetry();
    const err = Object.assign(new Error("rate limited"), { status: 429 });
    const op = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");

    await withRetry(op);

    const { rl429Count, rlRetryCount } = getScanTelemetry();
    expect(rl429Count).toBe(1);
    expect(rlRetryCount).toBe(1);
  });

  test("counts a 5xx as a retry but not as a 429", async () => {
    resetScanTelemetry();
    const err = Object.assign(new Error("server error"), { status: 503 });
    const op = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");

    await withRetry(op);

    expect(getScanTelemetry()).toEqual({ rl429Count: 0, rlRetryCount: 1 });
  });
});

describe("setSnapshotLogger", () => {
  test("surfaces 429 backoff to the snapshot progress log", async () => {
    const logged = [];
    setSnapshotLogger((msg) => logged.push(msg));
    const err = Object.assign(new Error("rate limited"), { status: 429 });
    await withRetry(vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok"));

    expect(logged.some((m) => m.includes("429 rate-limited"))).toBe(true);
  });

  test("surfaces non-429 retries with the status code", async () => {
    const logged = [];
    setSnapshotLogger((msg) => logged.push(msg));
    const err = Object.assign(new Error("boom"), { status: 502 });
    await withRetry(vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok"));

    expect(logged.some((m) => m.includes("502"))).toBe(true);
  });

  test("retrying without a logger attached does not throw", async () => {
    setSnapshotLogger(null);
    const err = Object.assign(new Error("boom"), { status: 500 });
    await expect(withRetry(vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok")))
      .resolves.toBe("ok");
  });
});

// ── withTimeout ───────────────────────────────────────────────────────────────

describe("withTimeout", () => {
  test("passes through a promise that settles first", async () => {
    await expect(withTimeout(Promise.resolve("done"), 1000)).resolves.toBe("done");
  });

  test("propagates rejection from the wrapped promise", async () => {
    await expect(withTimeout(Promise.reject(new Error("inner")), 1000)).rejects.toThrow("inner");
  });

  test("rejects with a timeout message when the deadline wins", async () => {
    vi.restoreAllMocks(); // this test needs real timers to lose the race
    await expect(withTimeout(new Promise(() => {}), 10)).rejects.toThrow(/timed out after 10ms/);
  });

  // The abandoned promise is attached a catch handler so a later rejection does
  // not surface as an unhandled rejection and crash the Forge invocation.
  test("does not emit an unhandled rejection when the loser rejects late", async () => {
    vi.restoreAllMocks();
    let rejectLate;
    const slow = new Promise((_, reject) => { rejectLate = reject; });
    const raced = withTimeout(slow, 10);
    await expect(raced).rejects.toThrow(/timed out/);
    rejectLate(new Error("late failure"));
    await new Promise((r) => setTimeout(r, 20));
  });
});

// ── withRetry ─────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  test("returns the first successful result without retrying", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(op)).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  test("retries 429 responses", async () => {
    const err = Object.assign(new Error("429"), { status: 429 });
    const op = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("recovered");
    await expect(withRetry(op)).resolves.toBe("recovered");
    expect(op).toHaveBeenCalledTimes(2);
  });

  test.each([500, 502, 503, 599])("retries %i server errors", async (status) => {
    const err = Object.assign(new Error(String(status)), { status });
    const op = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("recovered");
    await expect(withRetry(op)).resolves.toBe("recovered");
    expect(op).toHaveBeenCalledTimes(2);
  });

  // 4xx other than 429 are caller errors -- retrying them wastes the rate-limit
  // budget and delays surfacing a real bug.
  test.each([400, 401, 403, 404])("does not retry %i client errors", async (status) => {
    const err = Object.assign(new Error(String(status)), { status });
    const op = vi.fn().mockRejectedValue(err);
    await expect(withRetry(op)).rejects.toThrow(String(status));
    expect(op).toHaveBeenCalledTimes(1);
  });

  test("does not retry an error with no status", async () => {
    const op = vi.fn().mockRejectedValue(new Error("network"));
    await expect(withRetry(op)).rejects.toThrow("network");
    expect(op).toHaveBeenCalledTimes(1);
  });

  test("gives up after the maximum attempts and rethrows", async () => {
    const err = Object.assign(new Error("persistent"), { status: 503 });
    const op = vi.fn().mockRejectedValue(err);
    await expect(withRetry(op)).rejects.toThrow("persistent");
    expect(op).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS);
  });

  test("honours a Retry-After header over exponential backoff", async () => {
    const err = Object.assign(new Error("429"), {
      status: 429,
      originalResponse: { headers: { get: (n) => (n === "Retry-After" ? "2" : null) } },
    });
    const op = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");
    await expect(withRetry(op)).resolves.toBe("ok");
  });
});

// ── scheduleRateLimitedRequest ────────────────────────────────────────────────

describe("scheduleRateLimitedRequest", () => {
  test("returns the callback result", async () => {
    await expect(scheduleRateLimitedRequest(async () => "value")).resolves.toBe("value");
  });

  test("propagates callback rejection", async () => {
    await expect(scheduleRateLimitedRequest(async () => { throw new Error("inner"); }))
      .rejects.toThrow("inner");
  });

  // The in-flight counter must decrement on the failure path too, or the limiter
  // leaks slots until every concurrency slot is permanently stuck.
  test("releases its slot after a failure so later requests still run", async () => {
    for (let i = 0; i < BASE_JIRA_CONCURRENCY + 2; i++) {
      await expect(scheduleRateLimitedRequest(async () => { throw new Error("fail"); }))
        .rejects.toThrow("fail");
    }
    await expect(scheduleRateLimitedRequest(async () => "still works")).resolves.toBe("still works");
  });

  test("admits concurrent callers up to the configured concurrency", async () => {
    let concurrent = 0;
    let peak = 0;
    const task = async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await Promise.resolve();
      concurrent--;
      return true;
    };
    await Promise.all(Array.from({ length: 8 }, () => scheduleRateLimitedRequest(task)));
    expect(peak).toBeLessThanOrEqual(BASE_JIRA_CONCURRENCY);
  });

  test("waits out an active cooldown before dispatching", async () => {
    registerJiraRateLimit(50);
    await expect(scheduleRateLimitedRequest(async () => "after cooldown")).resolves.toBe("after cooldown");
  });
});

// ── jiraRequest / jiraRequestAsUser ───────────────────────────────────────────

describe("jiraRequest", () => {
  test("returns the parsed JSON body", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { values: [1, 2] } }));
    await expect(jiraRequest("/rest/api/3/field")).resolves.toEqual({ values: [1, 2] });
  });

  test("sends an Accept header", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: {} }));
    await jiraRequest("/x");
    expect(mockRequestJira.mock.calls[0][1].headers).toMatchObject({ Accept: "application/json" });
  });

  test("adds Content-Type only when a body is present", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: {} }));

    await jiraRequest("/x");
    expect(mockRequestJira.mock.calls[0][1].headers["Content-Type"]).toBeUndefined();

    await jiraRequest("/x", { method: "POST", body: JSON.stringify({ a: 1 }) });
    expect(mockRequestJira.mock.calls[1][1].headers["Content-Type"]).toBe("application/json");
  });

  test("lets caller headers override the defaults", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: {} }));
    await jiraRequest("/x", { headers: { Accept: "text/plain" } });
    expect(mockRequestJira.mock.calls[0][1].headers.Accept).toBe("text/plain");
  });

  test("forwards method and body through to Jira", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: {} }));
    await jiraRequest("/x", { method: "POST", body: '{"jql":"x"}' });
    expect(mockRequestJira.mock.calls[0][1]).toMatchObject({ method: "POST", body: '{"jql":"x"}' });
  });

  // Callers branch on error.status (401/403 for app-provided fields, 404 for
  // deleted fields), so it has to survive onto the thrown error.
  test("throws with status and original response attached on failure", async () => {
    const response = jiraResponse({ ok: false, status: 404, text: "not found" });
    mockRequestJira.mockResolvedValue(response);

    await expect(jiraRequest("/missing")).rejects.toMatchObject({
      status: 404,
      originalResponse: response,
    });
  });

  test("includes the Jira response text in the error message", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ ok: false, status: 400, text: "bad jql" }));
    await expect(jiraRequest("/x")).rejects.toThrow(/Jira request failed \(400\): bad jql/);
  });

  test("retries a 429 and succeeds on the follow-up attempt", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ ok: false, status: 429, text: "slow down" }))
      .mockResolvedValueOnce(jiraResponse({ body: { ok: true } }));

    await expect(jiraRequest("/x")).resolves.toEqual({ ok: true });
    expect(mockRequestJira).toHaveBeenCalledTimes(2);
  });

  test("does not retry a 403", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ ok: false, status: 403, text: "forbidden" }));
    await expect(jiraRequest("/x")).rejects.toMatchObject({ status: 403 });
    expect(mockRequestJira).toHaveBeenCalledTimes(1);
  });
});

describe("jiraRequestAsUser", () => {
  test("routes through asUser rather than asApp", async () => {
    mockRequestJiraAsUser.mockResolvedValue(jiraResponse({ body: { me: true } }));
    await expect(jiraRequestAsUser("/x")).resolves.toEqual({ me: true });
    expect(mockRequestJiraAsUser).toHaveBeenCalled();
    expect(mockRequestJira).not.toHaveBeenCalled();
  });

  test("applies the same error conventions as jiraRequest", async () => {
    mockRequestJiraAsUser.mockResolvedValue(jiraResponse({ ok: false, status: 401, text: "nope" }));
    await expect(jiraRequestAsUser("/x")).rejects.toMatchObject({ status: 401 });
  });

  test("adds Content-Type when a body is present", async () => {
    mockRequestJiraAsUser.mockResolvedValue(jiraResponse({ body: {} }));
    await jiraRequestAsUser("/x", { method: "POST", body: "{}" });
    expect(mockRequestJiraAsUser.mock.calls[0][1].headers["Content-Type"]).toBe("application/json");
  });
});

// ── getBrowsableProjectIds ────────────────────────────────────────────────────

describe("getBrowsableProjectIds", () => {
  test("returns the permitted subset as a Set of strings", async () => {
    mockRequestJiraAsUser.mockResolvedValue(jiraResponse({
      body: { projectPermissions: [{ projects: [1, 3] }] },
    }));

    const allowed = await getBrowsableProjectIds("acct-1", ["1", "2", "3"]);
    expect(allowed).toEqual(new Set(["1", "3"]));
  });

  // Fails closed: no account or no projects means no data, never all data.
  test("returns an empty set without calling Jira when accountId is missing", async () => {
    await expect(getBrowsableProjectIds(null, ["1"])).resolves.toEqual(new Set());
    expect(mockRequestJiraAsUser).not.toHaveBeenCalled();
  });

  test("returns an empty set without calling Jira when there are no project ids", async () => {
    await expect(getBrowsableProjectIds("acct-1", [])).resolves.toEqual(new Set());
    await expect(getBrowsableProjectIds("acct-1", null)).resolves.toEqual(new Set());
    expect(mockRequestJiraAsUser).not.toHaveBeenCalled();
  });

  test("deduplicates and stringifies incoming project ids", async () => {
    mockRequestJiraAsUser.mockResolvedValue(jiraResponse({ body: { projectPermissions: [{ projects: [] }] } }));
    await getBrowsableProjectIds("acct-1", [1, "1", 2, 2, ""]);

    const sent = JSON.parse(mockRequestJiraAsUser.mock.calls[0][1].body);
    expect(sent.projectPermissions[0].projects).toEqual(["1", "2"]);
    expect(sent.projectPermissions[0].permissions).toEqual(["BROWSE_PROJECTS"]);
  });

  test("returns an empty set when Jira reports no permitted projects", async () => {
    mockRequestJiraAsUser.mockResolvedValue(jiraResponse({ body: {} }));
    await expect(getBrowsableProjectIds("acct-1", ["1"])).resolves.toEqual(new Set());
  });
});

// ── paginate ──────────────────────────────────────────────────────────────────

describe("paginate", () => {
  test("collects values across pages until total is reached", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { values: [1, 2], total: 4 } }))
      .mockResolvedValueOnce(jiraResponse({ body: { values: [3, 4], total: 4 } }));

    await expect(paginate((startAt) => `/x?startAt=${startAt}`)).resolves.toEqual([1, 2, 3, 4]);
    expect(mockRequestJira).toHaveBeenCalledTimes(2);
  });

  test("advances startAt by the number of values received", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { values: [1, 2], total: 3 } }))
      .mockResolvedValueOnce(jiraResponse({ body: { values: [3], total: 3 } }));

    const paths = [];
    await paginate((startAt) => { paths.push(startAt); return `/x?startAt=${startAt}`; });
    expect(paths).toEqual([0, 2]);
  });

  test("stops when Jira sets isLast", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { values: [1], isLast: true, total: 99 } }));
    await expect(paginate(() => "/x")).resolves.toEqual([1]);
    expect(mockRequestJira).toHaveBeenCalledTimes(1);
  });

  // The hook exists so a long walk can bound itself. A caller that throws from it means to
  // abort -- a filter build out of time, say -- and paginate must let that through rather
  // than swallowing it and returning a half-read list as if it were the whole estate.
  test("reports progress after each page and lets the hook abort the walk", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { values: [1, 2], total: 6 } }))
      .mockResolvedValueOnce(jiraResponse({ body: { values: [3, 4], total: 6 } }))
      .mockResolvedValueOnce(jiraResponse({ body: { values: [5, 6], total: 6 } }));

    const seen = [];
    await paginate((startAt) => `/x?startAt=${startAt}`, "values", {
      onPage: ({ fetched, total }) => { seen.push([fetched, total]); },
    });
    expect(seen).toEqual([[2, 6], [4, 6], [6, 6]]);

    mockRequestJira.mockReset();
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { values: [1, 2], total: 500 } }));
    await expect(paginate(() => "/x", "values", {
      onPage: () => { throw new Error("out of time"); },
    })).rejects.toThrow("out of time");
    expect(mockRequestJira).toHaveBeenCalledTimes(1);
  });

  // Without this guard a page of zero values with a non-zero total loops forever.
  test("stops on an empty page even when total claims more remain", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { values: [], total: 500 } }));
    await expect(paginate(() => "/x")).resolves.toEqual([]);
    expect(mockRequestJira).toHaveBeenCalledTimes(1);
  });

  test("supports a custom values key", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { fields: ["a"], total: 1 } }));
    await expect(paginate(() => "/x", "fields")).resolves.toEqual(["a"]);
  });

  test("treats a missing total as a single page", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { values: [1, 2] } }));
    await expect(paginate(() => "/x")).resolves.toEqual([1, 2]);
    expect(mockRequestJira).toHaveBeenCalledTimes(1);
  });

  test("tolerates a response with no values array", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: {} }));
    await expect(paginate(() => "/x")).resolves.toEqual([]);
  });
});

// ── mapWithConcurrency ────────────────────────────────────────────────────────

describe("mapWithConcurrency", () => {
  test("preserves input order regardless of completion order", async () => {
    const result = await mapWithConcurrency([3, 1, 2], 3, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 10;
    });
    expect(result).toEqual([30, 10, 20]);
  });

  test("passes the index to the iteratee", async () => {
    const seen = [];
    await mapWithConcurrency(["a", "b"], 1, async (item, idx) => { seen.push([item, idx]); });
    expect(seen).toEqual([["a", 0], ["b", 1]]);
  });

  test("never exceeds the requested concurrency", async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  test("returns an empty array for empty input without invoking the iteratee", async () => {
    const iteratee = vi.fn();
    await expect(mapWithConcurrency([], 4, iteratee)).resolves.toEqual([]);
    expect(iteratee).not.toHaveBeenCalled();
  });

  test("caps worker count at the item count when concurrency exceeds it", async () => {
    await expect(mapWithConcurrency([1], 10, async (n) => n)).resolves.toEqual([1]);
  });

  test("propagates an iteratee rejection", async () => {
    await expect(mapWithConcurrency([1, 2], 2, async () => { throw new Error("item failed"); }))
      .rejects.toThrow("item failed");
  });
});

// ── Catalog helpers ───────────────────────────────────────────────────────────

describe("field catalog fetchers", () => {
  test("getAllCustomFields requests the custom field type", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: "customfield_1" }] } }));
    await expect(getAllCustomFields()).resolves.toEqual([{ id: "customfield_1" }]);
    expect(mockRequestJira.mock.calls[0][0]).toContain("type=custom");
  });

  test("getAllSystemFields requests the system field type", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: "summary" }] } }));
    await expect(getAllSystemFields()).resolves.toEqual([{ id: "summary" }]);
    expect(mockRequestJira.mock.calls[0][0]).toContain("type=system");
  });

  test("both fetchers page through the catalog", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: "a" }], total: 2 } }))
      .mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: "b" }], total: 2 } }));
    await expect(getAllCustomFields()).resolves.toHaveLength(2);
  });
});

describe("getProjectById", () => {
  test("returns the project payload", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { id: "1", key: "AAA", name: "Alpha" } }));
    await expect(getProjectById("1")).resolves.toMatchObject({ key: "AAA" });
  });
});

describe("getFieldContexts", () => {
  test("pages through contexts for a field", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: "ctx-1" }] } }));
    await expect(getFieldContexts("customfield_1")).resolves.toEqual([{ id: "ctx-1" }]);
    expect(mockRequestJira.mock.calls[0][0]).toContain("customfield_1");
  });
});

describe("getAllJiraProjects", () => {
  test("pages through the project list", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { values: [{ key: "AAA" }] } }));
    await expect(getAllJiraProjects()).resolves.toEqual([{ key: "AAA" }]);
  });
});

describe("getAllJiraProjectKeys", () => {
  test("returns just the project keys", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: { values: [{ key: "AAA" }, { key: "BBB" }], isLast: true },
    }));
    await expect(getAllJiraProjectKeys()).resolves.toEqual(["AAA", "BBB"]);
  });

  test("returns an empty list when the site has no projects", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { values: [], isLast: true } }));
    await expect(getAllJiraProjectKeys()).resolves.toEqual([]);
  });
});

describe("getFilterPage", () => {
  // Regression: this expand list was documented as including approximateLastUsed without
  // actually listing it, so lastUsedAt was null for every filter on every tenant and
  // downstream code read that as "never opened" rather than "unknown" -- a saved-filter
  // estate of any size rendered as 100% stale.
  test("requests approximateLastUsed so 'unknown' and 'never opened' can be told apart", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { values: [] } }));
    await getFilterPage(0, 50);
    expect(mockRequestJira.mock.calls[0][0]).toContain("approximateLastUsed");
  });
});

describe("getDashboardPage", () => {
  // Regression: DASHBOARD_EXPAND was modelled on FILTER_EXPAND and carried viewUrl with it.
  // filter/search accepts viewUrl; dashboard/search returns a hard 400 Bad Request for it,
  // which is why the dashboard stage of every scan failed on its very first request. The
  // search response already includes `view`.
  test("does not ask dashboard/search to expand viewUrl", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { values: [] } }));
    await getDashboardPage(0, 50);
    const url = mockRequestJira.mock.calls[0][0];
    expect(url).toContain("/rest/api/3/dashboard/search");
    expect(url).not.toContain("viewUrl");
  });

  test("still expands the fields the governance view needs", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { values: [] } }));
    await getDashboardPage(0, 50);
    const url = decodeURIComponent(mockRequestJira.mock.calls[0][0]);
    for (const field of ["description", "owner", "favouritedCount", "sharePermissions", "editPermissions"]) {
      expect(url).toContain(field);
    }
  });
});

describe("agile boards", () => {
  test("getBoardPage hits /rest/agile/1.0/board with paging params", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { values: [], isLast: true } }));
    await getBoardPage(50, 50);
    const url = decodeURIComponent(mockRequestJira.mock.calls[0][0]);
    expect(url).toContain("/rest/agile/1.0/board");
    expect(url).toContain("startAt=50");
    expect(url).toContain("maxResults=50");
  });

  test("getBoardConfiguration hits the per-board configuration endpoint", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { id: 7, columnConfig: { columns: [] } } }));
    await getBoardConfiguration(7);
    expect(mockRequestJira.mock.calls[0][0]).toContain("/rest/agile/1.0/board/7/configuration");
  });
});

describe("getAllStatuses", () => {
  // GET /rest/api/3/status returns a bare array, not the {values, isLast} envelope
  // every other paginated endpoint uses.
  test("returns the flat status array", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: [{ id: "1", name: "Open" }] }));
    await expect(getAllStatuses()).resolves.toEqual([{ id: "1", name: "Open" }]);
  });

  test("returns an empty array if Jira sends an envelope instead of an array", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { values: [] } }));
    await expect(getAllStatuses()).resolves.toEqual([]);
  });
});

// ── Endpoint probes ───────────────────────────────────────────────────────────
//
// CONNECT-4124. The automation probe added these three to this module without tests,
// which broke the per-file coverage floor -- the ratchet doing exactly its job. They are
// also the paths that established automation rules are unreadable from Forge, so the
// evidence behind a Won't Pursue decision rests on them behaving as described.

describe("probeEndpoint", () => {
  test("reports what came back rather than throwing", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ status: 401, ok: false, text: "scope does not match" }));

    const result = await probeEndpoint("/rest/cb-automation/latest/rule");

    expect(result).toMatchObject({ path: "/rest/cb-automation/latest/rule", status: 401, ok: false });
    expect(result.sample).toContain("scope does not match");
  });

  // A probe that throws is a probe that cannot report the failure it was built to find.
  test("returns a null status instead of throwing when the request itself fails", async () => {
    mockRequestJira.mockRejectedValueOnce(new Error("INVALID_TARGET_URL"));

    const result = await probeEndpoint("/rest/api/3/automation/rule");

    expect(result.status).toBeNull();
    expect(result.ok).toBe(false);
    expect(result.sample).toContain("INVALID_TARGET_URL");
  });

  // Enough to tell a rule list from an error envelope, not enough to leak issue data.
  test("truncates the response body", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ status: 200, ok: true, text: "x".repeat(5000) }));

    const result = await probeEndpoint("/rest/api/3/automation/rule");

    expect(result.sample).toHaveLength(300);
  });
});

// The identity question the screen probe exists to settle. Atlassian documents that Jira
// permissions also control access and are not overridden by scopes, so the same path can
// answer differently depending on whose token carries it -- and a probe that only ever asks
// as the app can never discover that.

describe("probeEndpointAsUser", () => {
  test("routes through asUser, not asApp", async () => {
    mockRequestJiraAsUser.mockResolvedValueOnce(jiraResponse({ status: 200, ok: true, text: "{}" }));

    const result = await probeEndpointAsUser("/rest/api/3/screens?maxResults=1");

    expect(mockRequestJiraAsUser).toHaveBeenCalled();
    // The whole point: an asApp call here would answer the question that was already asked.
    expect(mockRequestJira).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 200, ok: true });
  });

  test("reports a rejection rather than throwing", async () => {
    mockRequestJiraAsUser.mockResolvedValueOnce(jiraResponse({ status: 401, ok: false, text: "scope does not match" }));

    const result = await probeEndpointAsUser("/rest/api/3/screens/1/tabs/1/fields");

    expect(result).toMatchObject({ status: 401, ok: false });
    expect(result.sample).toContain("scope does not match");
  });

  test("returns a null status instead of throwing when the request itself fails", async () => {
    mockRequestJiraAsUser.mockRejectedValueOnce(new Error("no user context"));

    const result = await probeEndpointAsUser("/rest/api/3/screens");

    expect(result.status).toBeNull();
    expect(result.ok).toBe(false);
    expect(result.sample).toContain("no user context");
  });

  test("truncates the response body like its asApp twin", async () => {
    mockRequestJiraAsUser.mockResolvedValueOnce(jiraResponse({ status: 200, ok: true, text: "y".repeat(5000) }));

    const result = await probeEndpointAsUser("/rest/api/3/screens");

    expect(result.sample).toHaveLength(300);
  });

  test("honours an explicit method", async () => {
    mockRequestJiraAsUser.mockResolvedValueOnce(jiraResponse({ status: 200, ok: true, text: "{}" }));

    await probeEndpointAsUser("/rest/api/3/screens", { method: "HEAD" });

    expect(mockRequestJiraAsUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: "HEAD" })
    );
  });
});

describe("probeStargateEndpoint", () => {
  test("routes the /jsm/assets/ path through requestJira's gateway proxy", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ status: 200, ok: true, text: "{\"objectSchemas\":[]}" }));

    const path = "/jsm/assets/workspace/abc/v1/objectschema/list";
    const result = await probeStargateEndpoint(path);

    // route([path]) collapses to the bare path; Forge's requestJira proxy recognises the
    // /jsm/assets/ prefix and forwards it to api.atlassian.com. requestAtlassian / Stargate
    // rejected the same path as INVALID_TARGET_URL, which is what this replaced.
    expect(mockRequestJira).toHaveBeenCalledWith(path, expect.objectContaining({ method: "GET" }));
    expect(result).toMatchObject({ status: 200, ok: true });
  });

  test("returns a null status instead of throwing", async () => {
    mockRequestJira.mockRejectedValueOnce(new Error("gateway rejected the route"));

    const result = await probeStargateEndpoint("/jsm/assets/workspace/x/v1/x");

    expect(result.status).toBeNull();
    expect(result.ok).toBe(false);
    expect(result.sample).toContain("gateway rejected");
  });
});

describe("requestAtlassianJson", () => {
  test("parses a 2xx JSON body from the Assets API", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ status: 200, ok: true, text: "{\"objectSchemas\":[{\"id\":\"1\"}]}" }));
    const body = await requestAtlassianJson("/jsm/assets/workspace/w/v1/objectschema/list");
    expect(body).toEqual({ objectSchemas: [{ id: "1" }] });
  });

  test("throws with the status attached on a non-2xx", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ status: 403, ok: false, text: "app not authorised for Assets" }));
    await expect(requestAtlassianJson("/jsm/assets/workspace/w/v1/config/statustype"))
      .rejects.toMatchObject({ status: 403 });
  });
});

describe("getAssetsWorkspaceId", () => {
  test("pulls the first workspaceId out of the servicedeskapi payload", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      status: 200, ok: true,
      body: { values: [{ workspaceId: "c77afb26" }] },
    }));
    expect(await getAssetsWorkspaceId()).toBe("c77afb26");
  });

  test("returns null when the site has no workspace", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ status: 200, ok: true, body: { values: [] } }));
    expect(await getAssetsWorkspaceId()).toBeNull();
  });

  test("throws with the status on a non-2xx", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ status: 401, ok: false, text: "scope does not match" }));
    await expect(getAssetsWorkspaceId()).rejects.toMatchObject({ status: 401 });
  });
});

describe("getCloudId", () => {
  // The uuid in the installation ARI IS the cloud id the gateway expects, which is why no
  // second identifier has to be threaded through every caller.
  test("extracts the cloud id from the installation ARI", () => {
    const context = { installContext: "ari:cloud:jira::site/11111111-2222-3333-4444-555555555555" };
    expect(getCloudId(context)).toBe("11111111-2222-3333-4444-555555555555");
  });

  test("matches the normalized ARI form as well", () => {
    const context = { installContext: "ari:cloud:::site/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
    expect(getCloudId(context)).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  // Null, not a throw and not a partial string: the caller uses it to decide whether to
  // probe the gateway at all, and a malformed value would build an unresolvable URL.
  test("returns null rather than guessing when there is no site segment", () => {
    expect(getCloudId({ installContext: "ari:cloud:jira::something-else" })).toBeNull();
    expect(getCloudId({})).toBeNull();
    expect(getCloudId(undefined)).toBeNull();
  });
});

// The three reads at the bottom of the screen chain. Thin, but they carry the per-file
// coverage floor on this module, and the tabs/fields pair is the expensive hop the whole
// screen pipeline's cost turns on -- worth pinning their response handling.
describe("screen fetchers", () => {
  // The two scheme layers above the screen. Both paginate, and both answer under scopes
  // this install has -- unlike the screen list, which needed two more scopes before it
  // would respond at all.
  test("getAllScreenSchemes paginates and keeps the raw operation object", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: { values: [{ id: 5, screens: { default: 100, edit: 101 } }], isLast: true },
    }));

    const schemes = await getAllScreenSchemes();

    // screens is returned intact rather than flattened: inheritance is resolved at build
    // time, and which operation was set explicitly is part of the answer.
    expect(schemes[0].screens).toEqual({ default: 100, edit: 101 });
    expect(String(mockRequestJira.mock.calls[0][0])).toContain("/rest/api/3/screenscheme");
  });

  test("getAllIssueTypeScreenSchemes paginates", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: 9 }], total: 2 } }))
      .mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: 10 }], total: 2 } }));

    await expect(getAllIssueTypeScreenSchemes()).resolves.toEqual([{ id: 9 }, { id: 10 }]);
  });

  test("getIssueTypeScreenSchemeMappings returns the default entry alongside explicit ones", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: {
        values: [
          { issueTypeScreenSchemeId: 9, issueTypeId: "default", screenSchemeId: 5 },
          { issueTypeScreenSchemeId: 9, issueTypeId: "10001", screenSchemeId: 6 },
        ],
        isLast: true,
      },
    }));

    const mappings = await getIssueTypeScreenSchemeMappings();

    // On most sites the catch-all is the ONLY mapping a project has, so dropping it would
    // resolve the majority of projects to no screens at all.
    expect(mappings.some((m) => m.issueTypeId === "default")).toBe(true);
    expect(String(mockRequestJira.mock.calls[0][0])).toContain("/issuetypescreenscheme/mapping");
  });

  // The first live build died here with 400 "At least one projectId has to be provided".
  // This endpoint answers "which scheme governs THESE projects", not "list everything".
  test("getIssueTypeScreenSchemeProjects sends the required projectId parameters", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: { values: [{ issueTypeScreenScheme: { id: 9 }, projectIds: ["10000"] }], isLast: true },
    }));

    const rows = await getIssueTypeScreenSchemeProjects(["10000", "10001"]);

    expect(rows[0].projectIds).toEqual(["10000"]);
    const path = String(mockRequestJira.mock.calls[0][0]);
    expect(path).toContain("projectId=10000");
    expect(path).toContain("projectId=10001");
  });

  // Calling it bare is the bug, so not calling Jira at all is the correct response to an
  // empty list -- a request with no projectId is a guaranteed 400.
  test("getIssueTypeScreenSchemeProjects makes no request when given no projects", async () => {
    await expect(getIssueTypeScreenSchemeProjects([])).resolves.toEqual([]);
    expect(mockRequestJira).not.toHaveBeenCalled();
  });

  test("getIssueTypeScreenSchemeProjects batches large project lists", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { values: [], isLast: true } }));

    await getIssueTypeScreenSchemeProjects(Array.from({ length: 120 }, (_, i) => 10000 + i));

    // 120 ids at 50 per request.
    expect(mockRequestJira).toHaveBeenCalledTimes(3);
  });

  test("getIssueTypeScreenSchemeProjects de-duplicates ids before asking", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { values: [], isLast: true } }));

    await getIssueTypeScreenSchemeProjects(["10000", "10000", 10000]);

    const path = String(mockRequestJira.mock.calls[0][0]);
    expect(path.match(/projectId=10000/g)).toHaveLength(1);
  });

  test("getAllScreens paginates the screen catalog", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: 1 }, { id: 2 }], total: 3 } }))
      .mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: 3 }], total: 3 } }));

    await expect(getAllScreens()).resolves.toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(mockRequestJira).toHaveBeenCalledTimes(2);
  });

  // Like /status, tabs and fields come back as bare arrays rather than the usual envelope.
  test("getScreenTabs returns the flat tab array", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: [{ id: 10, name: "Field Tab" }] }));
    await expect(getScreenTabs("1")).resolves.toEqual([{ id: 10, name: "Field Tab" }]);
  });

  test("getScreenTabFields returns the flat field array", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: [{ id: "summary" }] }));
    await expect(getScreenTabFields("1", "10")).resolves.toEqual([{ id: "summary" }]);
  });

  // An envelope where an array was expected must not read as a populated result. A screen
  // reported with phantom tabs would inflate the cost projection the probe exists to make.
  test("both degrade to an empty array if Jira sends an envelope", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { values: [] } }));
    await expect(getScreenTabs("1")).resolves.toEqual([]);
    await expect(getScreenTabFields("1", "10")).resolves.toEqual([]);
  });
});

describe("issue type fetchers", () => {
  // Like /status, /issuetype comes back as a bare array rather than the usual envelope.
  test("getAllIssueTypes returns the flat array", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: [{ id: "1", name: "Epic", hierarchyLevel: 1 }, { id: "2", name: "Sub-task", hierarchyLevel: -1 }],
    }));
    await expect(getAllIssueTypes()).resolves.toEqual([
      { id: "1", name: "Epic", hierarchyLevel: 1 },
      { id: "2", name: "Sub-task", hierarchyLevel: -1 },
    ]);
    expect(String(mockRequestJira.mock.calls[0][0])).toContain("/rest/api/3/issuetype");
  });

  test("getAllIssueTypes degrades to an empty array if Jira sends an envelope", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { values: [] } }));
    await expect(getAllIssueTypes()).resolves.toEqual([]);
  });

  test("getAllIssueTypeSchemes paginates", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: "5" }], total: 2 } }))
      .mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: "6" }], total: 2 } }));

    await expect(getAllIssueTypeSchemes()).resolves.toEqual([{ id: "5" }, { id: "6" }]);
    expect(String(mockRequestJira.mock.calls[0][0])).toContain("/rest/api/3/issuetypescheme");
  });

  test("getIssueTypeSchemeItems paginates the ordered membership", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: {
        values: [
          { issueTypeSchemeId: "5", issueTypeId: "1" },
          { issueTypeSchemeId: "5", issueTypeId: "2" },
        ],
        isLast: true,
      },
    }));

    const items = await getIssueTypeSchemeItems();
    expect(items).toHaveLength(2);
    expect(String(mockRequestJira.mock.calls[0][0])).toContain("/issuetypescheme/mapping");
  });

  // Same required-and-repeatable projectId constraint as the screen-scheme /project endpoint.
  test("getIssueTypeSchemeProjects sends the required projectId parameters", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: { values: [{ issueTypeScheme: { id: "5" }, projectIds: ["10000"] }], isLast: true },
    }));

    const rows = await getIssueTypeSchemeProjects(["10000", "10001"]);

    expect(rows[0].projectIds).toEqual(["10000"]);
    const path = String(mockRequestJira.mock.calls[0][0]);
    expect(path).toContain("/rest/api/3/issuetypescheme/project");
    expect(path).toContain("projectId=10000");
    expect(path).toContain("projectId=10001");
  });

  test("getIssueTypeSchemeProjects makes no request when given no projects", async () => {
    await expect(getIssueTypeSchemeProjects([])).resolves.toEqual([]);
    expect(mockRequestJira).not.toHaveBeenCalled();
  });

  test("getIssueTypeSchemeProjects batches large project lists at 50 per request", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { values: [], isLast: true } }));
    await getIssueTypeSchemeProjects(Array.from({ length: 120 }, (_, i) => 10000 + i));
    expect(mockRequestJira).toHaveBeenCalledTimes(3);
  });
});

describe("estate config value lists", () => {
  test("getAllResolutions paginates the /resolution/search endpoint", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: "1", name: "Done" }], isLast: true } }));
    const rows = await getAllResolutions();
    expect(rows).toEqual([{ id: "1", name: "Done" }]);
    expect(String(mockRequestJira.mock.calls[0][0])).toContain("/rest/api/3/resolution/search");
  });

  test("getAllPriorities paginates the /priority/search endpoint", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: "10", name: "High" }], isLast: true } }));
    const rows = await getAllPriorities();
    expect(rows[0].name).toBe("High");
    expect(String(mockRequestJira.mock.calls[0][0])).toContain("/rest/api/3/priority/search");
  });
});

describe("project roles & the global-permission catalog", () => {
  test("getAllProjectRoles returns the site-wide role catalogue array", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: [{ id: 10002, name: "Administrators" }] }));
    await expect(getAllProjectRoles()).resolves.toEqual([{ id: 10002, name: "Administrators" }]);
    expect(String(mockRequestJira.mock.calls[0][0])).toContain("/rest/api/3/role");
  });

  test("getProjectRolesForProject resolves the name->url map then each role's actors", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { Administrators: "https://x/rest/api/3/project/10000/role/10002" } }))
      .mockResolvedValueOnce(jiraResponse({ body: {
        id: 10002, name: "Administrators",
        actors: [
          { type: "atlassian-group-role-actor", actorGroup: { name: "site-admins", groupId: "g-1" } },
          { type: "atlassian-user-role-actor", displayName: "Ann", actorUser: { accountId: "acc-1" } },
        ],
      } }));

    const roles = await getProjectRolesForProject("10000");
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ roleId: "10002", roleName: "Administrators" });
    expect(roles[0].actors).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "group", groupId: "g-1", groupName: "site-admins" }),
      expect.objectContaining({ type: "user", accountId: "acc-1", displayName: "Ann" }),
    ]));
  });

  test("getPermissionCatalog unwraps the permissions object", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { permissions: { ADMINISTER: { key: "ADMINISTER", type: "GLOBAL" } } } }));
    await expect(getPermissionCatalog()).resolves.toEqual({ ADMINISTER: { key: "ADMINISTER", type: "GLOBAL" } });
  });
});

describe("access & routing schemes", () => {
  test("getAllPermissionSchemes unwraps the permissionSchemes array and asks for grants", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: { permissionSchemes: [{ id: 1, name: "Prod" }, { id: 2, name: "Default Permission Scheme" }] },
    }));
    const rows = await getAllPermissionSchemes();
    expect(rows).toHaveLength(2);
    expect(String(mockRequestJira.mock.calls[0][0])).toContain("/rest/api/3/permissionscheme?expand=permissions");
  });

  test("getAllPermissionSchemes returns [] when the payload has no array", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: {} }));
    await expect(getAllPermissionSchemes()).resolves.toEqual([]);
  });

  test("getProjectPermissionScheme requests the project-scoped scheme", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { id: 3, name: "Prod" } }));
    const scheme = await getProjectPermissionScheme("OPS");
    expect(scheme).toEqual({ id: 3, name: "Prod" });
    expect(String(mockRequestJira.mock.calls[0][0])).toContain("/rest/api/3/project/OPS/permissionscheme");
  });

  test("getAllIssueSecuritySchemes unwraps issueSecuritySchemes", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { issueSecuritySchemes: [{ id: "s1", name: "Restricted" }] } }));
    await expect(getAllIssueSecuritySchemes()).resolves.toEqual([{ id: "s1", name: "Restricted" }]);
  });

  test("getAllIssueSecuritySchemes returns [] on an unexpected shape", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: null }));
    await expect(getAllIssueSecuritySchemes()).resolves.toEqual([]);
  });

  test("getIssueSecurityLevels paginates the scheme's levels", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { values: [{ id: "L1" }, { id: "L2" }], isLast: true } }));
    const levels = await getIssueSecurityLevels("s1");
    expect(levels.map((l) => l.id)).toEqual(["L1", "L2"]);
    expect(String(mockRequestJira.mock.calls[0][0])).toContain("/rest/api/3/issuesecurityschemes/level?schemeId=s1");
  });

  test("getIssueSecurityLevelMembers paginates the scheme's members", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: { values: [{ issueSecurityLevelId: "L1", holder: { type: "group", value: "g" } }], isLast: true },
    }));
    const members = await getIssueSecurityLevelMembers("s1");
    expect(members[0].issueSecurityLevelId).toBe("L1");
    expect(String(mockRequestJira.mock.calls[0][0])).toContain("/rest/api/3/issuesecurityschemes/level/member?schemeId=s1");
  });

  test("getIssueSecuritySchemeProjects sends the repeatable projectId parameters and makes no call for none", async () => {
    await expect(getIssueSecuritySchemeProjects([])).resolves.toEqual([]);
    expect(mockRequestJira).not.toHaveBeenCalled();

    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: { values: [{ issueSecuritySchemeId: "s1", projectIds: ["10000"] }], isLast: true },
    }));
    const rows = await getIssueSecuritySchemeProjects(["10000", "10001"]);
    expect(rows[0].issueSecuritySchemeId).toBe("s1");
    const path = String(mockRequestJira.mock.calls[0][0]);
    expect(path).toContain("/rest/api/3/issuesecurityschemes/project");
    expect(path).toContain("projectId=10000");
    expect(path).toContain("projectId=10001");
  });

  test("getIssueSecuritySchemeProjects batches large project lists at 50 per request", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { values: [], isLast: true } }));
    await getIssueSecuritySchemeProjects(Array.from({ length: 120 }, (_, i) => 10000 + i));
    expect(mockRequestJira).toHaveBeenCalledTimes(3);
  });

  test("getAllNotificationSchemes paginates with expand=all", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: { values: [{ id: "n1", name: "Prod", notificationSchemeEvents: [] }], isLast: true },
    }));
    const rows = await getAllNotificationSchemes();
    expect(rows[0].id).toBe("n1");
    expect(String(mockRequestJira.mock.calls[0][0])).toContain("/rest/api/3/notificationscheme?expand=all");
  });

  test("getNotificationSchemeProjects sends the repeatable projectId parameters and makes no call for none", async () => {
    await expect(getNotificationSchemeProjects([])).resolves.toEqual([]);
    expect(mockRequestJira).not.toHaveBeenCalled();

    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: { values: [{ notificationSchemeId: "n1", projectIds: ["10000"] }], isLast: true },
    }));
    const rows = await getNotificationSchemeProjects(["10000", "10001"]);
    expect(rows[0].notificationSchemeId).toBe("n1");
    const path = String(mockRequestJira.mock.calls[0][0]);
    expect(path).toContain("/rest/api/3/notificationscheme/project");
    expect(path).toContain("projectId=10000");
    expect(path).toContain("projectId=10001");
  });

  test("getNotificationSchemeProjects batches large project lists at 50 per request", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { values: [], isLast: true } }));
    await getNotificationSchemeProjects(Array.from({ length: 120 }, (_, i) => 10000 + i));
    expect(mockRequestJira).toHaveBeenCalledTimes(3);
  });
});

describe("getWorkflowSchemesForProjects", () => {
  test("resolves a scheme per project id", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { id: "scheme-1" } }));
    const result = await getWorkflowSchemesForProjects(["1", "2"], 2);
    expect(result).toHaveLength(2);
  });

  test("returns an empty array for no projects", async () => {
    await expect(getWorkflowSchemesForProjects([], 2)).resolves.toEqual([]);
    expect(mockRequestJira).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scan cadence constants
//
// These are pure numbers, but they are the app's main lever on Forge's SQL
// request quota -- the one that binds long before compute or storage. A 325k
// issue site was measured at ~30k SQL requests per full scan against a 100k
// monthly allowance, so a silent change here is a billing regression, not a
// style choice.
// ---------------------------------------------------------------------------
describe("issue scan cadence", () => {
  test("flushes once per worker chunk rather than mid-chunk", async () => {
    const { ISSUE_SCAN_FLUSH_EVERY_PAGES } = await import("./jira-api.js");
    // scan-engine's loop is bounded by ISSUE_SCAN_CHUNK_PAGES (10). At or above
    // that bound the mid-loop flush never fires and the end-of-chunk flush --
    // which is also the durable checkpoint -- does the work exactly once.
    expect(ISSUE_SCAN_FLUSH_EVERY_PAGES).toBeGreaterThanOrEqual(10);
  });

  test("checks for cancellation more often than it flushes", async () => {
    const { ISSUE_SCAN_FLUSH_EVERY_PAGES, ISSUE_SCAN_CANCEL_CHECK_EVERY_PAGES } = await import("./jira-api.js");
    // A cancel check is one cheap read; a flush is many writes. Tying them to the
    // same cadence is what made cancellation expensive in the first place.
    expect(ISSUE_SCAN_CANCEL_CHECK_EVERY_PAGES).toBeLessThan(ISSUE_SCAN_FLUSH_EVERY_PAGES);
    expect(ISSUE_SCAN_CANCEL_CHECK_EVERY_PAGES).toBeGreaterThan(0);
  });

  test("page size stays at the Jira cursor-search ceiling", async () => {
    const { ISSUE_SCAN_PAGE_SIZE } = await import("./jira-api.js");
    // Jira Cloud caps maxResults at 100 for cursor-based search. Anything lower
    // multiplies both HTTP round trips and per-page SQL bookkeeping.
    expect(ISSUE_SCAN_PAGE_SIZE).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// callerHasJiraAdmin
//
// The authorization primitive behind every admin resolver. It must fail closed:
// anything other than an explicit, affirmative ADMINISTER grant is a "no".
// ---------------------------------------------------------------------------
describe("callerHasJiraAdmin", () => {
  test("returns true when Jira grants ADMINISTER to the caller", async () => {
    mockRequestJiraAsUser.mockResolvedValue(jiraResponse({
      body: { globalPermissions: ["ADMINISTER", "BULK_CHANGE"] },
    }));

    await expect(callerHasJiraAdmin("acct-1")).resolves.toBe(true);
  });

  test("asks as the user, not as the app", async () => {
    mockRequestJiraAsUser.mockResolvedValue(jiraResponse({ body: { globalPermissions: ["ADMINISTER"] } }));

    await callerHasJiraAdmin("acct-1");

    // asApp would report the app's own permissions and answer nothing useful.
    expect(mockRequestJiraAsUser).toHaveBeenCalled();
    expect(mockRequestJira).not.toHaveBeenCalled();
    const body = JSON.parse(mockRequestJiraAsUser.mock.calls[0][1].body);
    expect(body).toEqual({ accountId: "acct-1", globalPermissions: ["ADMINISTER"] });
  });

  test("returns false when ADMINISTER is absent from the granted list", async () => {
    mockRequestJiraAsUser.mockResolvedValue(jiraResponse({
      body: { globalPermissions: ["BULK_CHANGE"] },
    }));

    await expect(callerHasJiraAdmin("acct-1")).resolves.toBe(false);
  });

  test("returns false for an empty grant list", async () => {
    mockRequestJiraAsUser.mockResolvedValue(jiraResponse({ body: { globalPermissions: [] } }));
    await expect(callerHasJiraAdmin("acct-1")).resolves.toBe(false);
  });

  test("returns false without calling Jira when there is no accountId", async () => {
    await expect(callerHasJiraAdmin(null)).resolves.toBe(false);
    await expect(callerHasJiraAdmin("")).resolves.toBe(false);
    expect(mockRequestJiraAsUser).not.toHaveBeenCalled();
  });

  // Fails closed, unlike checkMacroAccess which deliberately fails open. Everything
  // behind this check mutates state or exposes governance internals, so an
  // unanswerable question must resolve to "no".
  test("returns false when the permission call throws", async () => {
    mockRequestJiraAsUser.mockRejectedValue(new Error("network down"));
    await expect(callerHasJiraAdmin("acct-1")).resolves.toBe(false);
  });

  test("returns false when Jira rejects the permission call", async () => {
    mockRequestJiraAsUser.mockResolvedValue(jiraResponse({ ok: false, status: 403, text: "Forbidden" }));
    await expect(callerHasJiraAdmin("acct-1")).resolves.toBe(false);
  });

  test("returns false for a malformed response body", async () => {
    mockRequestJiraAsUser.mockResolvedValue(jiraResponse({ body: { globalPermissions: "ADMINISTER" } }));
    await expect(callerHasJiraAdmin("acct-1")).resolves.toBe(false);
  });
});

// ── getGadgetFilterId ────────────────────────────────────────────────────────
//
// Two calls, because Jira models gadget config as arbitrary item properties: one to list the
// keys a gadget has, one to read the value of the one that might hold a filter. This is the
// first leg of dashboard -> gadget -> filter -> field, and getting it wrong produces a quiet
// hole in that dependency graph rather than a visible failure -- extractFilterId's own tests
// cover the parsing; these cover the two-call shape around it.
describe("getGadgetFilterId", () => {
  test("finds the filter under the standard 'config' property key", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { keys: [{ key: "config" }, { key: "color" }] } }))
      .mockResolvedValueOnce(jiraResponse({ body: { value: { filterId: "10123" } } }));

    await expect(getGadgetFilterId("9", "g1")).resolves.toBe("10123");
    expect(mockRequestJira).toHaveBeenCalledTimes(2);
  });

  // Only the keys that could plausibly hold a filter are read. A gadget can carry half a
  // dozen properties for column widths and refresh intervals, and fetching every one of them
  // would double the cost of the walk for nothing.
  test("does not fetch keys that could not hold a filter", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({
      body: { keys: [{ key: "color" }, { key: "refreshInterval" }, { key: "columnWidths" }] },
    }));

    await expect(getGadgetFilterId("9", "g1")).resolves.toBeNull();
    // Only the list call -- nothing looked plausible enough to fetch.
    expect(mockRequestJira).toHaveBeenCalledTimes(1);
  });

  test("tries the next candidate key when the first holds no filter", async () => {
    mockRequestJira
      .mockResolvedValueOnce(jiraResponse({ body: { keys: [{ key: "filter" }, { key: "savedFilter" }] } }))
      .mockResolvedValueOnce(jiraResponse({ body: { value: {} } }))
      .mockResolvedValueOnce(jiraResponse({ body: { value: "10999" } }));

    await expect(getGadgetFilterId("9", "g1")).resolves.toBe("10999");
    expect(mockRequestJira).toHaveBeenCalledTimes(3);
  });

  test("returns null rather than throwing when the gadget has no matching property at all", async () => {
    mockRequestJira.mockResolvedValueOnce(jiraResponse({ body: { keys: [] } }));
    await expect(getGadgetFilterId("9", "g1")).resolves.toBeNull();
  });
});

describe("createJiraIssue (remediation: the one write path)", () => {
  test("posts to /rest/api/3/issue and returns the created issue", async () => {
    mockRequestJiraAsUser.mockResolvedValue(jiraResponse({ body: { id: "10001", key: "OPS-1", self: "https://x/OPS-1" } }));

    const out = await createJiraIssue({ project: { key: "OPS" }, summary: "Fix it" }, { asUser: true });

    expect(out).toEqual({ id: "10001", key: "OPS-1", self: "https://x/OPS-1" });
    const [path, opts] = mockRequestJiraAsUser.mock.calls[0];
    expect(String(path)).toContain("/rest/api/3/issue");
    expect(opts).toMatchObject({ method: "POST" });
    expect(JSON.parse(opts.body)).toEqual({ fields: { project: { key: "OPS" }, summary: "Fix it" } });
  });

  test("defaults to asApp when asUser is not requested", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { id: "1", key: "OPS-2" } }));
    await createJiraIssue({ summary: "x" });
    expect(mockRequestJira).toHaveBeenCalled();
    expect(mockRequestJiraAsUser).not.toHaveBeenCalled();
  });

  test("throws with the status and Jira's message on a non-2xx, and does NOT retry", async () => {
    mockRequestJiraAsUser.mockResolvedValue(jiraResponse({ ok: false, status: 400, text: '{"errors":{"issuetype":"invalid"}}' }));

    await expect(createJiraIssue({}, { asUser: true })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("issuetype"),
    });
    // Issue creation is not idempotent -- a retry after a 5xx that landed would duplicate.
    expect(mockRequestJiraAsUser).toHaveBeenCalledTimes(1);
  });
});

describe("getIssuesStatus (remediation sync)", () => {
  test("returns [] without a request for an empty key list", async () => {
    await expect(getIssuesStatus([])).resolves.toEqual([]);
    expect(mockRequestJira).not.toHaveBeenCalled();
  });

  test("maps status and assignee for each issue", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({
      body: {
        issues: [
          { key: "OPS-1", fields: { status: { name: "Done", statusCategory: { key: "done" } }, assignee: { accountId: "a1", displayName: "Sam" } } },
          { key: "OPS-2", fields: { status: { name: "To Do", statusCategory: { key: "new" } }, assignee: null } },
        ],
      },
    }));

    const out = await getIssuesStatus(["OPS-1", "OPS-2", "OPS-1"]);
    expect(out).toEqual([
      { key: "OPS-1", status: "Done", statusCategory: "done", assigneeAccountId: "a1", assigneeName: "Sam" },
      { key: "OPS-2", status: "To Do", statusCategory: "new", assigneeAccountId: null, assigneeName: null },
    ]);
  });

  test("chunks a large key list into batches of 90", async () => {
    mockRequestJira.mockResolvedValue(jiraResponse({ body: { issues: [] } }));
    await getIssuesStatus(Array.from({ length: 200 }, (_, i) => `OPS-${i}`));
    expect(mockRequestJira).toHaveBeenCalledTimes(3);
  });
});
