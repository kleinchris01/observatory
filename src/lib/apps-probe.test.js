import { vi, describe, test, expect, beforeEach } from "vitest";

vi.mock("./jira-api.js", () => ({ probeEndpoint: vi.fn(), probeEndpointAsUser: vi.fn() }));
vi.mock("./logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  classifyTypeKey,
  connectAppKey,
  forgeAppId,
  collectAppRules,
  mergeAppEvidence,
  appLabel,
  probeMarketplaceApps,
  APP_SIGNALS,
} from "./apps-probe.js";
import { probeEndpoint, probeEndpointAsUser } from "./jira-api.js";

const FORGE = "ari:cloud:ecosystem::extension/aaaa-1111/env-2/static/my-module";
const ok = (path, body) => ({
  path,
  status: 200,
  ok: true,
  ms: 1,
  sample: "",
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const fail = (path, status) => ({ path, status, ok: false, ms: 1, sample: `failed ${status}` });

describe("identifying apps", () => {
  test("classifies field and gadget type keys by provider", () => {
    expect(classifyTypeKey("com.atlassian.plugins.atlassian-connect-plugin:com.example.app__estimate")).toEqual({
      kind: "connect",
      app: "com.example.app",
    });
    expect(classifyTypeKey(FORGE)).toEqual({ kind: "forge", app: "aaaa-1111" });
    expect(classifyTypeKey("com.onresolve.jira.groovy.groovyrunner:scripted-field")).toEqual({
      kind: "plugin",
      app: "com.onresolve.jira.groovy.groovyrunner",
    });
    expect(classifyTypeKey("com.atlassian.jira.plugin.system.customfieldtypes:select")).toBeNull();
    expect(classifyTypeKey("com.pyxis.greenhopper.jira:gh-sprint")).toBeNull();
    // No vendor namespace: Jira's own internal types.
    expect(classifyTypeKey("noColonKey")).toBeNull();
    expect(classifyTypeKey("read-only-string-issue-field")).toBeNull();
    // Jira Product Discovery is Atlassian's.
    expect(classifyTypeKey("jira.polaris:votes")).toBeNull();
    // Built-in gadgets named by URI.
    expect(classifyTypeKey("rest/gadgets/1.0/g/com.atlassian.jira.gadgets:filter-results-gadget")).toBeNull();
    expect(classifyTypeKey("/rest/gadgets/1.0/g/com.vendor.app:chart")).toEqual({
      kind: "plugin",
      app: "com.vendor.app",
    });
    // Forge-built gadgets: app id when the key carries one, otherwise left visibly unresolved.
    expect(classifyTypeKey(`com.atlassian.forge:${FORGE}`)).toEqual({ kind: "forge", app: "aaaa-1111" });
    expect(classifyTypeKey("com.atlassian.forge:671CB257-7C61-452D-83C6-AC96D40EE11C/x")).toEqual({
      kind: "forge",
      app: "671cb257-7c61-452d-83c6-ac96d40ee11c",
    });
    expect(classifyTypeKey("com.atlassian.forge:something-else")).toEqual({
      kind: "forge-unresolved",
      app: "com.atlassian.forge",
    });
    expect(classifyTypeKey(null)).toBeNull();
  });

  test("a Connect app key drops the module suffix some payloads attach", () => {
    expect(connectAppKey("com.innovalog.jmwe.jira-misc-workflow-extensions__ClearFieldsFunction")).toBe(
      "com.innovalog.jmwe.jira-misc-workflow-extensions",
    );
    expect(connectAppKey("com.a")).toBe("com.a");
    expect(connectAppKey(null)).toBeNull();
  });

  test("reads the app id out of a Forge extension ARI", () => {
    expect(forgeAppId(FORGE)).toBe("aaaa-1111");
    expect(forgeAppId("nonsense")).toBeNull();
  });

  test("names known vendors, and falls back to the key", () => {
    expect(appLabel("com.onresolve.jira.groovy.groovyrunner")).toBe("ScriptRunner");
    expect(appLabel("com.unknown")).toBe("com.unknown");
  });

  // A third-party rule's config can hold a script; only the app's identity leaves this function.
  test("collects connect and forge rules anywhere in a workflow, keeping identity only", () => {
    const workflow = {
      transitions: [
        {
          actions: [
            {
              ruleKey: "connect:remote-workflow-function",
              parameters: { appKey: "com.a__SetFieldValueFunction", config: "SECRET", disabled: "true" },
            },
            { ruleKey: "system:update-issue-status", parameters: {} },
          ],
          conditions: { conditions: [{ ruleKey: "forge:expression-condition", parameters: { key: FORGE } }] },
          validators: [{ ruleKey: "connect:expression-validator", parameters: {} }],
        },
      ],
    };
    const rules = collectAppRules([workflow]);
    expect(rules).toEqual([
      { kind: "connect", ruleKey: "connect:remote-workflow-function", app: "com.a", disabled: true },
      { kind: "forge", ruleKey: "forge:expression-condition", app: "aaaa-1111", disabled: false },
      { kind: "connect", ruleKey: "connect:expression-validator", app: "unknown", disabled: false },
    ]);
    expect(JSON.stringify(rules)).not.toMatch(/SECRET/);
    expect(collectAppRules(null)).toEqual([]);
  });

  test("merges evidence by app key across sources, Forge apps by id", () => {
    const apps = mergeAppEvidence([
      { source: "upmAsUser", kind: "installed", app: "com.onresolve.jira.groovy.groovyrunner" },
      { source: "fields", kind: "plugin", app: "com.onresolve.jira.groovy.groovyrunner" },
      {
        source: "workflowRules",
        kind: "connect",
        app: "com.onresolve.jira.groovy.groovyrunner",
        count: 4,
        extra: { disabled: 1 },
      },
      { source: "fields", kind: "forge", app: "aaaa-1111" },
      { source: "fields", kind: "connect", app: null },
    ]);
    expect(apps).toEqual([
      {
        id: "key:com.onresolve.jira.groovy.groovyrunner",
        kind: "plugin",
        app: "com.onresolve.jira.groovy.groovyrunner",
        label: "ScriptRunner",
        sources: { upmAsUser: 1, fields: 1, workflowRules: 4 },
        disabledRules: 1,
      },
      {
        id: "forge:aaaa-1111",
        kind: "forge",
        app: "aaaa-1111",
        label: "aaaa-1111",
        sources: { fields: 1 },
        disabledRules: 0,
      },
    ]);
  });
});

describe("probeMarketplaceApps", () => {
  beforeEach(() => vi.clearAllMocks());

  function healthySite() {
    probeEndpoint.mockImplementation(async (path) => {
      if (path === "/rest/api/3/field")
        return ok(path, [
          {
            id: "customfield_1",
            custom: true,
            schema: { custom: "com.atlassian.plugins.atlassian-connect-plugin:com.a__f" },
          },
          {
            id: "customfield_2",
            custom: true,
            schema: { custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
          },
          { id: "summary", custom: false, schema: {} },
        ]);
      if (path.startsWith("/rest/api/3/workflows/search"))
        return ok(path, {
          isLast: true,
          values: [
            { id: "wf-team", scope: { type: "PROJECT" }, transitions: [] },
            {
              id: "wf-1",
              scope: { type: "GLOBAL" },
              transitions: [
                {
                  actions: [
                    { ruleKey: "connect:remote-workflow-function", parameters: { appKey: "com.a", disabled: "true" } },
                  ],
                },
              ],
            },
          ],
        });
      if (path.startsWith("/rest/api/3/workflows/capabilities"))
        return ok(path, { connectRules: [{ addonKey: "com.a" }], forgeRules: [{ id: FORGE }] });
      if (path.startsWith("/rest/api/3/dashboard/search")) return ok(path, { values: [{ id: "10" }, { id: "11" }] });
      if (path === "/rest/api/3/dashboard/10/gadget")
        return ok(path, { gadgets: [{ moduleKey: "com.atlassian.jira.gadgets:filter-results" }, { uri: FORGE }] });
      if (path === "/rest/api/3/dashboard/11/gadget") return fail(path, 403);
      if (path.includes("filter=app"))
        return ok(path, {
          records: [
            { id: 9, category: "system", summary: "App installed", created: "2026-10-01" },
            { id: 8, category: "system", summary: "App uninstalled", created: "2026-03-01" },
          ],
        });
      if (path.startsWith("/rest/api/3/auditing/record"))
        return ok(path, {
          records: [
            { category: "user management", summary: "User created" },
            { id: 9, category: "system", summary: "App installed", created: "2026-10-01" },
          ],
        });
      if (path === "/rest/plugins/1.0/")
        return ok(path, { plugins: [{ key: "com.atlassian.x", userInstalled: false }] });
      return fail(path, 404);
    });
    probeEndpointAsUser.mockImplementation(async (path) =>
      path === "/rest/plugins/1.0/"
        ? ok(path, {
            plugins: [
              { key: "com.b", userInstalled: true },
              { key: "com.atlassian.y", userInstalled: false },
            ],
          })
        : ok(path, "<feed><entry><title>Installed</title></entry><entry></entry></feed>"),
    );
  }

  test("reports every signal and the apps it reveals", async () => {
    healthySite();
    const result = await probeMarketplaceApps();

    expect(result.signals.map((s) => s.key)).toEqual(APP_SIGNALS.map((s) => s.key));
    expect(result.signals.every((s) => s.verdict === "ok")).toBe(true);
    const step = (k) => result.results.find((r) => r.step === k);
    expect(step("fieldCatalog").summary).toMatch(/2 custom fields: 1 Connect, 0 Forge, 0 other app keys, 1 Atlassian/);
    expect(step("workflowRules").summary).toMatch(/1 app rules across 2 workflows, from 1 apps; 1 marked disabled/);
    // The team-managed workflow comes first; capabilities are asked of the company-managed one.
    expect(step("capabilities").path).toContain("workflowId=wf-1");
    expect(step("capabilities").summary).toMatch(/offered to a company-managed workflow/);
    expect(step("fieldCatalog").samples).toEqual(["com.atlassian.plugins.atlassian-connect-plugin:com.a__f"]);
    expect(step("dashboardGadgets").samples[0]).toMatch(/\(1\)$/);
    expect(step("dashboardGadgets").summary).toBe("1 of 2 gadgets on 2 dashboards come from apps.");
    // Recent and searched records are merged without duplicating the same event.
    expect(step("auditRecords").appEvents).toEqual([
      { summary: "App installed", created: "2026-10-01" },
      { summary: "App uninstalled", created: "2026-03-01" },
    ]);
    expect(step("auditRecords").summary).toMatch(/2 matching a search for "app" back to 2026-03-01; 2 mention/);
    expect(step("upm")).toMatchObject({ count: 1, userInstalled: 0 });
    expect(step("upmAsUser")).toMatchObject({ count: 2, userInstalled: 1 });
    expect(step("upmLog")).toMatchObject({ count: 2, summary: "2 install-log entries." });

    const byApp = Object.fromEntries(result.apps.map((a) => [a.app, a]));
    expect(byApp["com.a"]).toMatchObject({
      kind: "connect",
      disabledRules: 1,
      sources: { fields: 1, workflowRules: 1, capabilities: 1 },
    });
    expect(byApp["aaaa-1111"].sources).toEqual({ capabilities: 1, gadgets: 1 });
    expect(byApp["com.b"]).toMatchObject({ kind: "installed", sources: { upmAsUser: 1 } });
    // Bodies never leave the probe.
    expect(JSON.stringify(result)).not.toMatch(/"body"/);
  });

  test("failures are reported per signal, never thrown", async () => {
    probeEndpoint.mockImplementation(async (path) => fail(path, path.includes("auditing") ? 401 : 403));
    probeEndpointAsUser.mockImplementation(async (path) => ({
      path,
      status: null,
      ok: false,
      ms: 0,
      sample: "network",
    }));
    const result = await probeMarketplaceApps();
    const verdict = Object.fromEntries(result.signals.map((s) => [s.key, s.verdict]));
    expect(verdict).toEqual({
      fieldCatalog: "forbidden",
      workflowRules: "forbidden",
      capabilities: "skipped",
      dashboardGadgets: "forbidden",
      auditRecords: "missing-scope",
      upm: "forbidden",
      upmAsUser: "error",
      upmLog: "error",
    });
    expect(result.apps).toEqual([]);
  });

  test("a plugin manager answer that is not JSON is said plainly", async () => {
    healthySite();
    probeEndpointAsUser.mockImplementation(async (path) => ok(path, "<html>login</html>"));
    const result = await probeMarketplaceApps();
    expect(result.results.find((r) => r.step === "upmAsUser").summary).toBe(
      "Answered, but not with a JSON plugin list.",
    );
    expect(result.results.find((r) => r.step === "upmLog").count).toBe(0);
  });

  test("with only team-managed workflows, says which scope it asked; a failed audit search narrows the claim", async () => {
    healthySite();
    const base = probeEndpoint.getMockImplementation();
    probeEndpoint.mockImplementation(async (path) => {
      if (path.startsWith("/rest/api/3/workflows/search"))
        return ok(path, { values: [{ id: "wf-team", scope: { type: "PROJECT" }, transitions: [] }] });
      if (path.includes("filter=app")) return fail(path, 500);
      return base(path);
    });
    const result = await probeMarketplaceApps();
    const step = (k) => result.results.find((r) => r.step === k);
    expect(step("capabilities").path).toContain("workflowId=wf-team");
    expect(step("capabilities").summary).toMatch(/offered to a project workflow/);
    expect(step("auditRecords")).toMatchObject({ searched: null });
    expect(step("auditRecords").summary).not.toMatch(/search for/);
  });

  test("a 404 reads as not here", async () => {
    probeEndpoint.mockImplementation(async (path) => fail(path, 404));
    probeEndpointAsUser.mockImplementation(async (path) => fail(path, 500));
    const result = await probeMarketplaceApps();
    expect(result.signals.find((s) => s.key === "upm").verdict).toBe("not-found");
    expect(result.signals.find((s) => s.key === "upmAsUser").verdict).toBe("error");
  });
});
