import { describe, test, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ probe: vi.fn(), incrMetric: vi.fn() }));
vi.mock("../lib/jsm-probe.js", () => ({ probeServiceManagementApi: mocks.probe }));
vi.mock("../lib/jira-api.js", async (importOriginal) => ({
  ...(await importOriginal()),
  incrMetric: mocks.incrMetric,
}));

import { probeServiceManagementApi } from "./jsm.js";
import * as resolvers from "../resolvers.js";

beforeEach(() => vi.clearAllMocks());

describe("probeServiceManagementApi resolver", () => {
  test("passes the cloud id from the install context and returns the probe's report", async () => {
    mocks.probe.mockResolvedValueOnce({ jsmAvailable: true });

    const result = await probeServiceManagementApi({
      context: { installContext: "ari:cloud:jira::site/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b" },
    });

    expect(mocks.probe).toHaveBeenCalledWith({ cloudId: "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b" });
    expect(mocks.incrMetric).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ jsmAvailable: true });
  });

  test("passes a null cloud id when the context has none", async () => {
    mocks.probe.mockResolvedValueOnce({ jsmAvailable: false });

    await probeServiceManagementApi({});

    expect(mocks.probe).toHaveBeenCalledWith({ cloudId: null });
  });

  // It reads site configuration and customer counts: admin page only, behind the guard.
  test("is registered as admin-only, never on the macro handler", () => {
    expect(resolvers.__RAW_ADMIN_ONLY_FUNCTIONS.probeServiceManagementApi).toBe(probeServiceManagementApi);
    expect(resolvers.SHARED_RESOLVER_FUNCTIONS).not.toHaveProperty("probeServiceManagementApi");
  });
});
