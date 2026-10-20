import { describe, test, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ probe: vi.fn(), incrMetric: vi.fn() }));
vi.mock("../lib/apps-probe.js", () => ({ probeMarketplaceApps: mocks.probe }));
vi.mock("../lib/jira-api.js", async (importOriginal) => ({
  ...(await importOriginal()),
  incrMetric: mocks.incrMetric,
}));

import { probeMarketplaceApps } from "./apps.js";
import * as resolvers from "../resolvers.js";

beforeEach(() => vi.clearAllMocks());

describe("probeMarketplaceApps resolver", () => {
  test("returns the probe's report and counts the call", async () => {
    mocks.probe.mockResolvedValueOnce({ apps: [], signals: [] });
    expect(await probeMarketplaceApps()).toEqual({ apps: [], signals: [] });
    expect(mocks.incrMetric).toHaveBeenCalledTimes(1);
  });

  // It reads workflow definitions and the audit log: admin page only, behind the guard.
  test("is registered as admin-only, never on the macro handler", () => {
    expect(resolvers.__RAW_ADMIN_ONLY_FUNCTIONS.probeMarketplaceApps).toBe(probeMarketplaceApps);
    expect(resolvers.SHARED_RESOLVER_FUNCTIONS).not.toHaveProperty("probeMarketplaceApps");
  });
});
