import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// The Jira Service Management reads in jira-api.js. servicedeskapi pages on start/limit with
// an isLastPage flag, and the customer/organization endpoints need the experimental header.

const mockRequestJira = vi.fn();

vi.mock("@forge/api", () => ({
  default: { asApp: () => ({ requestJira: mockRequestJira }), asUser: () => ({ requestJira: vi.fn() }) },
  route: (strings, ...values) => strings.reduce((acc, s, i) => acc + s + (values[i] ?? ""), ""),
}));
vi.mock("@forge/metrics", () => ({
  internalMetrics: { counter: () => ({ incr: vi.fn(), incrBy: vi.fn() }) },
}));

import {
  paginateServiceDesk,
  getServiceDesks,
  getServiceDeskRequestTypes,
  getServiceDeskRequestTypeGroups,
  getRequestTypeFields,
  getServiceDeskQueues,
  countServiceDeskCustomers,
  getServiceDeskOrganizations,
  getOrganizations,
  countOrganizationMembers,
  resetJiraRateLimiterState,
  JSM_EXPERIMENTAL,
} from "./jira-api.js";

const ok = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => "",
  headers: { get: () => null },
});
const page = (values, isLastPage) => ok({ values, isLastPage });
const paths = () => mockRequestJira.mock.calls.map((c) => c[0]);
const headersOf = (i) => mockRequestJira.mock.calls[i][1]?.headers || {};

beforeEach(() => {
  vi.clearAllMocks();
  resetJiraRateLimiterState();
  vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms) => {
    if (ms !== 12000) fn();
    return 0;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("paginateServiceDesk", () => {
  test("walks start/limit until isLastPage", async () => {
    mockRequestJira.mockResolvedValueOnce(page([1, 2], false)).mockResolvedValueOnce(page([3], true));
    const result = await paginateServiceDesk((start, limit) => `/x?start=${start}&limit=${limit}`);
    expect(result).toEqual({ values: [1, 2, 3], complete: true });
    expect(paths()).toEqual(["/x?start=0&limit=50", "/x?start=2&limit=50"]);
  });

  test("stops at the cap and reports a lower bound", async () => {
    mockRequestJira.mockResolvedValue(page([1, 2, 3], false));
    expect(await paginateServiceDesk(() => "/x", { maxItems: 4 })).toEqual({ values: [1, 2, 3, 1], complete: false });
  });

  test("a bare array, an empty page or no flag ends the walk", async () => {
    mockRequestJira.mockResolvedValueOnce(ok([1, 2]));
    expect((await paginateServiceDesk(() => "/x")).values).toEqual([1, 2]);
    mockRequestJira.mockResolvedValueOnce(page([], false));
    expect((await paginateServiceDesk(() => "/x")).complete).toBe(true);
    mockRequestJira.mockResolvedValueOnce(ok({ values: [1] }));
    expect((await paginateServiceDesk(() => "/x")).values).toEqual([1]);
  });
});

describe("structure reads", () => {
  test("desks, request types, groups and queues use the desk paths", async () => {
    mockRequestJira.mockResolvedValue(page([{ id: 1 }], true));
    await getServiceDesks();
    await getServiceDeskRequestTypes(5);
    await getServiceDeskRequestTypeGroups(5);
    await getServiceDeskQueues(5);
    expect(paths()).toEqual([
      "/rest/servicedeskapi/servicedesk?start=0&limit=50",
      "/rest/servicedeskapi/servicedesk/5/requesttype?start=0&limit=50",
      "/rest/servicedeskapi/servicedesk/5/requesttypegroup?start=0&limit=50",
      "/rest/servicedeskapi/servicedesk/5/queue?includeCount=true&start=0&limit=50",
    ]);
  });

  test("request type fields come back as a list, or empty", async () => {
    mockRequestJira.mockResolvedValueOnce(ok({ requestTypeFields: [{ fieldId: "summary" }] }));
    expect(await getRequestTypeFields(5, 10)).toEqual([{ fieldId: "summary" }]);
    mockRequestJira.mockResolvedValueOnce(ok({}));
    expect(await getRequestTypeFields(5, 10)).toEqual([]);
  });
});

describe("customer and organization reads", () => {
  // Counted, never kept, and only with the experimental opt-in.
  test("send the experimental header and count", async () => {
    mockRequestJira.mockResolvedValue(page([{ accountId: "a" }, { accountId: "b" }], true));
    expect(await countServiceDeskCustomers(5, 100)).toEqual({ count: 2, complete: true });
    expect(await countOrganizationMembers(9, 100)).toEqual({ count: 2, complete: true });
    await getOrganizations();
    await getServiceDeskOrganizations(5);
    for (let i = 0; i < 4; i++) expect(headersOf(i)).toMatchObject(JSM_EXPERIMENTAL);
    expect(paths()).toEqual([
      "/rest/servicedeskapi/servicedesk/5/customer?start=0&limit=50",
      "/rest/servicedeskapi/organization/9/user?start=0&limit=50",
      "/rest/servicedeskapi/organization?start=0&limit=50",
      "/rest/servicedeskapi/servicedesk/5/organization?start=0&limit=50",
    ]);
  });
});
