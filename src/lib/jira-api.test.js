import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────
//
// api.asApp()/asUser() are the only things this module cannot exercise for real.
// analysis.js and transform.js are deliberately NOT mocked -- shouldRetry,
// getRetryDelayMs, and the JQL builders are pure and already tested, and running
// the real ones here means these tests fail if retry classification ever drifts.

const mockRequestJira = vi.fn();
const mockRequestJiraAsUser = vi.fn();

vi.mock("@forge/api", () => ({
  default: {
    asApp: () => ({ requestJira: mockRequestJira }),
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
  paginate,
  mapWithConcurrency,
  getAllCustomFields,
  getAllSystemFields,
  getProjectById,
  getFieldContexts,
  getAllJiraProjects,
  getAllStatuses,
  getWorkflowSchemesForProjects,
  getAllJiraProjectKeys,
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
