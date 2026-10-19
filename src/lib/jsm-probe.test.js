import { describe, test, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ probeEndpoint: vi.fn(), probeJqlCount: vi.fn(), info: vi.fn() }));
vi.mock("./jira-api.js", () => ({ probeEndpoint: mocks.probeEndpoint, probeJqlCount: mocks.probeJqlCount }));
vi.mock("./logger.js", () => ({ logger: { info: mocks.info, warn: vi.fn(), error: vi.fn() } }));

import {
  probeServiceManagementApi,
  verdictOf,
  jqlString,
  cfRef,
  serviceFields,
  pageValues,
  summarizeAreas,
  availabilityReason,
} from "./jsm-probe.js";

const SD = "/rest/servicedeskapi";
const EMAIL = "pat.customer@example.com";

// A simulated site: one service desk (SD, project 10000) with one request type, one queue,
// one SLA field and customers whose payloads carry an email address. `overrides` replaces
// the answer for any path that starts with the given prefix.
function site(overrides = {}) {
  const page = (values, more = false) => JSON.stringify({ size: values.length, isLastPage: !more, values });
  const answers = {
    [`${SD}/info`]: { status: 200, body: JSON.stringify({ version: "10.4.0" }) },
    [`${SD}/servicedesk?`]: {
      status: 200,
      body: page([{ id: "1", projectId: "10000", projectKey: "SD", projectName: "Service" }]),
    },
    "/rest/api/3/field": {
      status: 200,
      body: JSON.stringify([
        {
          id: "customfield_10030",
          name: "Time to resolution",
          schema: { custom: "com.atlassian.servicedesk:sd-sla-field" },
        },
        { id: "customfield_10010", name: "Request Type", schema: { custom: "com.atlassian.servicedesk:vp-origin" } },
        { id: "summary", name: "Summary", schema: { system: "summary" } },
      ]),
    },
    [`${SD}/servicedesk/1/requesttype/7/field`]: {
      status: 200,
      body: JSON.stringify({ requestTypeFields: [{ fieldId: "summary" }] }),
    },
    [`${SD}/servicedesk/1/requesttype?`]: { status: 200, body: page([{ id: "7", name: 'Get "IT" help' }]) },
    [`${SD}/servicedesk/1/requesttypegroup`]: { status: 200, body: page([{ id: "g1", name: "General" }]) },
    [`${SD}/requesttype?`]: { status: 200, body: page([{ id: "7" }], true) },
    "/jira/forms/": { status: 200, body: "[]" },
    [`${SD}/servicedesk/1/queue?`]: {
      status: 200,
      body: page([{ id: "q1", name: "Open", jql: "project = SD", issueCount: 12 }]),
    },
    [`${SD}/organization?`]: { status: 200, body: page([{ id: "o1", name: "Acme" }]) },
    [`${SD}/servicedesk/1/organization?`]: { status: 200, body: page([{ id: "o1", name: "Acme" }]) },
    [`${SD}/servicedesk/1/customer?`]: { status: 200, body: page([{ accountId: "a1", emailAddress: EMAIL }]) },
    "/rest/api/3/search/jql?": { status: 200, body: JSON.stringify({ issues: [{ key: "SD-9" }] }) },
    [`${SD}/request/SD-9/sla`]: { status: 200, body: page([{ name: "Time to resolution" }]) },
    ...overrides,
  };
  mocks.probeEndpoint.mockImplementation(async (path, opts = {}) => {
    const key = Object.keys(answers)
      .filter((k) => path.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const a = key ? answers[key] : { status: 404, body: "not found" };
    const ok = a.status >= 200 && a.status < 300;
    return {
      path,
      status: a.status,
      ok,
      ms: 1,
      sample: String(a.body).slice(0, 300),
      ...(opts.keepBody ? { body: a.body } : {}),
    };
  });
  mocks.probeJqlCount.mockImplementation(async (jql) => ({
    jql,
    status: 200,
    ok: true,
    count: 3,
    ms: 1,
    sample: '{"count":3}',
  }));
}

const row = (result, step) => result.results.find((r) => r.step === step);
const area = (result, key) => result.areas.find((a) => a.key === key);

beforeEach(() => vi.clearAllMocks());

describe("probeServiceManagementApi — a site where everything answers", () => {
  test("every pillar is ready at both stages", async () => {
    site();
    const result = await probeServiceManagementApi({ cloudId: "cloud-1" });

    expect(result.jsmAvailable).toBe(true);
    expect(result.version).toBe("10.4.0");
    expect(result.sampledDesk).toEqual({ id: "1", projectKey: "SD", projectId: "10000" });
    for (const a of result.areas) {
      expect([a.key, a.structure.state, a.usage.state]).toEqual([a.key, "ready", "ready"]);
    }
  });

  test("builds JQL from field ids, and quotes request type names safely", async () => {
    site();
    const result = await probeServiceManagementApi({ cloudId: "cloud-1" });

    expect(row(result, "slaBreached").jql).toBe('project = "SD" AND cf[10030] = breached()');
    expect(row(result, "slaRunning").jql).toBe('project = "SD" AND cf[10030] = running()');
    expect(row(result, "requestTypeVolume").jql).toBe('project = "SD" AND cf[10010] = "Get \\"IT\\" help"');
    expect(result.slaFields).toEqual([{ id: "customfield_10030", name: "Time to resolution" }]);
  });

  test("sends the experimental opt-in header to customer and organization endpoints", async () => {
    site();
    await probeServiceManagementApi({ cloudId: "cloud-1" });

    const calls = mocks.probeEndpoint.mock.calls.filter(([path]) => /\/(customer|organization)\?/.test(path));
    expect(calls).toHaveLength(3);
    for (const [, opts] of calls) expect(opts.headers).toEqual({ "X-ExperimentalApi": "opt-in" });
  });

  // Customer payloads carry names and email addresses: counts only, anywhere they could surface.
  test("never returns or logs customer and organization contents", async () => {
    site();
    const result = await probeServiceManagementApi({ cloudId: "cloud-1" });

    expect(JSON.stringify(result)).not.toContain(EMAIL);
    expect(JSON.stringify(result)).not.toContain("Acme");
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(EMAIL);
    expect(row(result, "deskCustomers").count).toBe(1);
    expect(result.results.some((r) => "body" in r)).toBe(false);
  });

  test("counts pages and flags when there are more", async () => {
    site();
    const result = await probeServiceManagementApi({ cloudId: "cloud-1" });

    expect(row(result, "allRequestTypes")).toMatchObject({ count: 1, more: true });
    expect(row(result, "queueCounts").sample).toBe("First queue holds 12 issues.");
  });
});

describe("probeServiceManagementApi — failures it must tell apart", () => {
  test("JSM not on the site: unavailable, with every desk-scoped step skipped", async () => {
    site({ [`${SD}/servicedesk?`]: { status: 404, body: "not found" } });
    const result = await probeServiceManagementApi({ cloudId: "cloud-1" });

    expect(result.jsmAvailable).toBe(false);
    expect(result.reason).toBe("Jira Service Management is not on this site.");
    expect(row(result, "queues").verdict).toBe("skipped");
    expect(area(result, "queues").structure.state).toBe("untested");
    expect(mocks.probeJqlCount).not.toHaveBeenCalled();
  });

  test("a missing scope is reported as a scope gap, not as JSM being absent", async () => {
    site({
      [`${SD}/servicedesk/1/requesttype?`]: {
        status: 401,
        body: '{"code":401,"message":"Unauthorized; scope does not match"}',
      },
    });
    const result = await probeServiceManagementApi({ cloudId: "cloud-1" });

    expect(area(result, "requestTypes").structure).toMatchObject({ state: "missing-scope" });
    expect(area(result, "requestTypes").structure.detail).toContain("requestTypes");
    expect(area(result, "queues").structure.state).toBe("ready");
  });

  test("queues that answer without their JQL block the queues pillar", async () => {
    site({
      [`${SD}/servicedesk/1/queue?`]: {
        status: 200,
        body: JSON.stringify({ isLastPage: true, values: [{ id: "q1", name: "Open" }] }),
      },
    });
    const result = await probeServiceManagementApi({ cloudId: "cloud-1" });

    expect(row(result, "queues").verdict).toBe("unexpected-shape");
    expect(row(result, "queueCounts").verdict).toBe("unexpected-shape");
    expect(area(result, "queues")).toMatchObject({ structure: { state: "blocked" }, usage: { state: "blocked" } });
  });

  test("a site with no SLA fields leaves SLA usage untested rather than failed", async () => {
    site({ "/rest/api/3/field": { status: 200, body: "[]" } });
    const result = await probeServiceManagementApi({ cloudId: "cloud-1" });

    expect(row(result, "slaBreached").verdict).toBe("skipped");
    expect(area(result, "slas").usage.state).toBe("untested");
    expect(row(result, "requestTypeVolume").sample).toContain("no request type field");
  });

  test("a rejected JQL function blocks only the stage that needs it", async () => {
    site();
    mocks.probeJqlCount.mockImplementationOnce(async (jql) => ({
      jql,
      status: 400,
      ok: false,
      count: null,
      ms: 1,
      sample: "bad function",
    }));
    const result = await probeServiceManagementApi({ cloudId: "cloud-1" });

    expect(row(result, "slaBreached").verdict).toBe("jql-rejected");
    expect(area(result, "slas")).toMatchObject({ structure: { state: "ready" }, usage: { state: "blocked" } });
  });

  test("optional steps never block a stage", async () => {
    site({
      "/jira/forms/": { status: 401, body: "scope does not match" },
      [`${SD}/request/SD-9/sla`]: { status: 403, body: "no" },
    });
    const result = await probeServiceManagementApi({ cloudId: "cloud-1" });

    expect(row(result, "forms").verdict).toBe("missing-scope");
    expect(area(result, "requestTypes").structure.state).toBe("ready");
    expect(area(result, "slas").usage.state).toBe("ready");
  });

  test("without a cloud id the forms step is skipped and says why", async () => {
    site();
    const result = await probeServiceManagementApi({});

    expect(row(result, "forms")).toMatchObject({
      verdict: "skipped",
      sample: "Skipped: no cloud id in the install context.",
    });
  });

  test("a desk with no request types skips the steps that need one", async () => {
    site({
      [`${SD}/servicedesk/1/requesttype?`]: { status: 200, body: JSON.stringify({ isLastPage: true, values: [] }) },
    });
    const result = await probeServiceManagementApi({ cloudId: "cloud-1" });

    expect(row(result, "requestTypeFields").sample).toBe("Skipped: the desk has no request types to sample.");
    expect(row(result, "requestTypeVolume").verdict).toBe("skipped");
  });

  test("a desk with no requests skips the per-request SLA read", async () => {
    site({ "/rest/api/3/search/jql?": { status: 200, body: JSON.stringify({ issues: [] }) } });
    const result = await probeServiceManagementApi({ cloudId: "cloud-1" });

    expect(row(result, "requestSla")).toMatchObject({
      verdict: "skipped",
      sample: "Skipped: the desk has no requests.",
    });
  });
});

describe("pure helpers", () => {
  test("verdictOf tells a scope gap from a permission gap from absence", () => {
    expect(verdictOf({ status: 200, ok: true })).toBe("ok");
    expect(verdictOf({ status: 401, ok: false })).toBe("missing-scope");
    expect(verdictOf({ status: 400, ok: false, sample: "Unauthorized; scope does not match" })).toBe("missing-scope");
    expect(verdictOf({ status: 403, ok: false })).toBe("forbidden");
    expect(verdictOf({ status: 404, ok: false })).toBe("not-found");
    expect(verdictOf({ status: 400, ok: false, jql: "x" })).toBe("jql-rejected");
    expect(verdictOf({ status: 500, ok: false })).toBe("error");
    expect(verdictOf({ status: null, ok: false })).toBe("error");
  });

  test("jqlString escapes quotes and backslashes", () => {
    expect(jqlString('a "b" \\c')).toBe('"a \\"b\\" \\\\c"');
  });

  test("cfRef only accepts custom field ids", () => {
    expect(cfRef("customfield_10030")).toBe("cf[10030]");
    expect(cfRef("summary")).toBeNull();
    expect(cfRef(undefined)).toBeNull();
  });

  test("serviceFields finds SLA fields and the request type field by type", () => {
    expect(serviceFields(null)).toEqual({ slaFields: [], requestTypeField: null });
  });

  test("pageValues reads every page shape the API uses", () => {
    expect(pageValues([1])).toEqual([1]);
    expect(pageValues({ values: [2] })).toEqual([2]);
    expect(pageValues({ requestTypeFields: [3] })).toEqual([3]);
    expect(pageValues(null)).toEqual([]);
  });

  test("summarizeAreas reports untested when nothing was probed", () => {
    expect(summarizeAreas([])[0]).toMatchObject({ structure: { state: "untested" }, usage: { state: "untested" } });
  });

  test("availabilityReason names the cause", () => {
    expect(availabilityReason({ status: 401, ok: false })).toMatch(/missing a Service Management scope/);
    expect(availabilityReason({ status: 403, ok: false })).toMatch(/not allowed/);
    expect(availabilityReason({ status: 200, ok: true })).toMatch(/no service desks/);
    expect(availabilityReason({ status: 502, ok: false })).toBe("The service desk list returned 502.");
  });
});
