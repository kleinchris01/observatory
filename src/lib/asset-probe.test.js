import { vi, describe, test, expect, beforeEach } from "vitest";

vi.mock("./jira-api.js", () => ({
  probeEndpoint: vi.fn(),
  probeStargateEndpoint: vi.fn(),
}));

vi.mock("./logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { probeAssetsApi, firstWorkspaceId, firstSchemaId } from "./asset-probe.js";
import { probeEndpoint, probeStargateEndpoint } from "./jira-api.js";

beforeEach(() => vi.clearAllMocks());

describe("firstWorkspaceId", () => {
  test("reads the { values: [{ workspaceId }] } shape, a bare array, and a single object", () => {
    expect(firstWorkspaceId('{"values":[{"workspaceId":"ws-1"}]}')).toBe("ws-1");
    expect(firstWorkspaceId('[{"workspaceId":"ws-2"}]')).toBe("ws-2");
    expect(firstWorkspaceId('{"id":"ws-3"}')).toBe("ws-3");
    expect(firstWorkspaceId("not json")).toBe(null);
    expect(firstWorkspaceId('{"values":[]}')).toBe(null);
  });
});

describe("firstSchemaId", () => {
  test("reads objectSchemas[].id and a bare array", () => {
    expect(firstSchemaId('{"objectSchemas":[{"id":7,"name":"IT"}]}')).toBe("7");
    expect(firstSchemaId('[{"id":"9"}]')).toBe("9");
    expect(firstSchemaId('{"objectSchemas":[]}')).toBe(null);
  });
});

describe("probeAssetsApi", () => {
  test("reports not-enabled when the workspace endpoint does not answer", async () => {
    probeEndpoint.mockResolvedValue({ status: 404, ok: false, ms: 5, sample: "not found" });

    const result = await probeAssetsApi();

    expect(result.assetsEnabled).toBe(false);
    expect(result.workspaceId).toBe(null);
    expect(result.reason).toMatch(/JSM Premium/i);
    expect(probeStargateEndpoint).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({ step: "workspace", via: "site" });
  });

  test("reports not-enabled when the workspace endpoint answers but names no workspace", async () => {
    probeEndpoint.mockResolvedValue({ status: 200, ok: true, ms: 5, sample: '{"values":[]}' });

    const result = await probeAssetsApi();

    expect(result.assetsEnabled).toBe(false);
    expect(result.reason).toMatch(/named no workspace/i);
  });

  test("discovers the workspace then probes the gateway structure endpoints", async () => {
    probeEndpoint.mockResolvedValue({ status: 200, ok: true, ms: 5, sample: '{"values":[{"workspaceId":"ws-abc"}]}' });
    probeStargateEndpoint.mockImplementation(async (path) => {
      if (path.endsWith("/objectschema/list")) {
        return { status: 200, ok: true, ms: 8, sample: '{"objectSchemas":[{"id":"3","name":"IT Assets"}]}' };
      }
      if (path.includes("/objecttypes/flat")) {
        return { status: 200, ok: true, ms: 8, sample: '[{"id":"10","name":"Laptop"}]' };
      }
      return { status: 200, ok: true, ms: 8, sample: '[{"id":"1","name":"x"}]' };
    });

    const result = await probeAssetsApi();

    expect(result.assetsEnabled).toBe(true);
    expect(result.workspaceId).toBe("ws-abc");
    expect(result.schemaIdSampled).toBe("3");
    // Both the schema-level and the per-schema follow-up calls ran.
    const gatewayPaths = probeStargateEndpoint.mock.calls.map((c) => c[0]);
    expect(gatewayPaths.some((p) => p.includes("/jsm/assets/workspace/ws-abc/v1/objectschema/list"))).toBe(true);
    expect(gatewayPaths.some((p) => p.includes("/objectschema/3/objecttypes/flat"))).toBe(true);
    expect(result.reachable).toEqual(expect.arrayContaining(["schemas", "objectTypes"]));
  });

  test("records a gateway 401 as reachable:false without throwing", async () => {
    probeEndpoint.mockResolvedValue({ status: 200, ok: true, ms: 5, sample: '{"values":[{"workspaceId":"ws-1"}]}' });
    probeStargateEndpoint.mockResolvedValue({ status: 401, ok: false, ms: 8, sample: '{"code":"UNAUTHORIZED"}' });

    const result = await probeAssetsApi();

    expect(result.assetsEnabled).toBe(false);
    expect(result.results.filter((r) => r.via === "stargate").every((r) => r.ok === false)).toBe(true);
  });
});
