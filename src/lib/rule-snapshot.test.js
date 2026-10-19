import { describe, it, expect } from "vitest";
import {
  buildManifest,
  findSecrets,
  normalizeRule,
  redactSecrets,
  redactionPlaceholder,
  ruleFileName,
  serializeRule,
  sortKeysDeep,
  stripVolatileFields,
} from "./rule-snapshot.js";

const PLACEHOLDER = /^\[\[REDACTED:[0-9a-f]{8}\]\]$/;

function ruleWith(overrides = {}) {
  return {
    id: 123,
    name: "Test rule",
    state: "ENABLED",
    clientKey: "client-1",
    checksum: "abc123",
    partitionId: "part-1",
    currentVersionId: null,
    trigger: {
      id: "t1",
      component: "TRIGGER",
      type: "jira.issue.created",
      value: {},
      children: [],
      conditions: [],
      checksum: "t-sum",
    },
    components: [],
    tags: [],
    ...overrides,
  };
}

describe("sortKeysDeep", () => {
  it("sorts object keys at every depth", () => {
    const sorted = sortKeysDeep({ b: 1, a: { d: 2, c: 3 } });
    expect(Object.keys(sorted)).toEqual(["a", "b"]);
    expect(Object.keys(sorted.a)).toEqual(["c", "d"]);
  });

  it("preserves array order, because component order is execution order", () => {
    const sorted = sortKeysDeep({ components: [{ z: 1 }, { a: 2 }, { m: 3 }] });
    expect(sorted.components.map((c) => Object.keys(c)[0])).toEqual(["z", "a", "m"]);
  });

  it("sorts keys inside array elements", () => {
    const sorted = sortKeysDeep([{ b: 1, a: 2 }]);
    expect(Object.keys(sorted[0])).toEqual(["a", "b"]);
  });

  it("passes through primitives and null untouched", () => {
    expect(sortKeysDeep(null)).toBeNull();
    expect(sortKeysDeep(7)).toBe(7);
    expect(sortKeysDeep("x")).toBe("x");
  });

  it("produces byte-identical output for objects differing only in key order", () => {
    const a = JSON.stringify(sortKeysDeep({ x: 1, y: { p: 1, q: 2 } }));
    const b = JSON.stringify(sortKeysDeep({ y: { q: 2, p: 1 }, x: 1 }));
    expect(a).toBe(b);
  });
});

describe("redactionPlaceholder", () => {
  it("is stable for the same input", () => {
    expect(redactionPlaceholder("secret")).toBe(redactionPlaceholder("secret"));
  });

  it("differs when the secret changes, so a rotation still shows as a diff", () => {
    expect(redactionPlaceholder("secret-v1")).not.toBe(redactionPlaceholder("secret-v2"));
  });

  it("never contains the original value", () => {
    expect(redactionPlaceholder("hunter2")).not.toContain("hunter2");
    expect(redactionPlaceholder("hunter2")).toMatch(PLACEHOLDER);
  });
});

describe("redactSecrets", () => {
  it("redacts an inbound webhook token", () => {
    const out = redactSecrets({ trigger: { value: { webhookToken: "example-inbound-token-not-real" } } });
    expect(out.trigger.value.webhookToken).toMatch(PLACEHOLDER);
  });

  it("redacts the secret path of a Slack webhook URL but keeps the host", () => {
    const url = "https://hooks.slack.com/services/FAKE/FAKE/not-a-real-token";
    const out = redactSecrets({ webhookUrl: url });
    expect(out.webhookUrl).toContain("https://hooks.slack.com/");
    expect(out.webhookUrl).not.toContain("FAKE");
    expect(out.webhookUrl).not.toContain("not-a-real-token");
  });

  it("redacts a Teams webhook URL", () => {
    const out = redactSecrets({ webhookUrl: "https://acme.webhook.office.com/webhookb2/abc-def/IncomingWebhook/xyz" });
    expect(out.webhookUrl).toContain("https://acme.webhook.office.com/");
    expect(out.webhookUrl).not.toContain("IncomingWebhook");
  });

  it("removes client_secret from a form-encoded body but keeps grant_type and client_id", () => {
    const body =
      "grant_type=client_credentials&client_id=00000000-0000-0000&client_secret=Ab-cD~efGhIjKlMn-opQrStUv~wXyZ01&scope=x";
    const out = redactSecrets({ customBody: body });
    expect(out.customBody).toContain("grant_type=client_credentials");
    expect(out.customBody).toContain("client_id=00000000-0000-0000");
    expect(out.customBody).toContain("scope=x");
    expect(out.customBody).not.toContain("Ab-cD~efGhIjKlMn-opQrStUv~wXyZ01");
  });

  it("leaves a smart-value client_secret legible, since a reference is not a secret", () => {
    const body = "grant_type=client_credentials&client_secret={{graphSecret}}";
    expect(redactSecrets({ customBody: body }).customBody).toContain("{{graphSecret}}");
  });

  it("redacts password and api_key in form bodies", () => {
    const out = redactSecrets({ customBody: "password=s3cr3tvalue&api_key=AKIAIOSFODNN7EXAMPLE" });
    expect(out.customBody).not.toContain("s3cr3tvalue");
    expect(out.customBody).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("keeps a smart-value bearer header but redacts a literal token", () => {
    const out = redactSecrets({ headers: [{ name: "Authorization", value: "Bearer {{graphtoken}}" }] });
    expect(out.headers[0].value).toBe("Bearer {{graphtoken}}");

    const literal = redactSecrets({
      headers: [{ name: "Authorization", value: "Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghij" }],
    });
    expect(literal.headers[0].value).toMatch(/^Bearer \[\[REDACTED:[0-9a-f]{8}\]\]$/);
  });

  it("finds secrets nested arbitrarily deep inside component children", () => {
    const deep = {
      components: [{ children: [{ children: [{ value: { customBody: "client_secret=deadbeefdeadbeef" } }] }] }],
    };
    const out = redactSecrets(deep);
    expect(JSON.stringify(out)).not.toContain("deadbeefdeadbeef");
  });

  it("redacts every occurrence, not just the first, across sibling values", () => {
    const out = redactSecrets({
      a: { customBody: "client_secret=firstsecretvalue" },
      b: { customBody: "client_secret=secondsecretvalue" },
    });
    expect(JSON.stringify(out)).not.toContain("firstsecretvalue");
    expect(JSON.stringify(out)).not.toContain("secondsecretvalue");
  });

  it("leaves non-secret strings and non-strings alone", () => {
    const input = { name: "Send to approval", delayMs: null, enabled: true, count: 5 };
    expect(redactSecrets(input)).toEqual(input);
  });

  // A webhook token is stored twice: once at trigger.value.webhookToken, and again as a
  // WEBHOOK_TOKEN tag whose key is the generic "tagValue". Redacting only the first left
  // all five of this site's tokens in the snapshot.
  it("redacts a token carried as a WEBHOOK_TOKEN tag value", () => {
    const out = redactSecrets({ tags: [{ tagType: "WEBHOOK_TOKEN", tagValue: "example-inbound-token-not-real" }] });
    expect(out.tags[0].tagValue).toMatch(PLACEHOLDER);
    expect(out.tags[0].tagType).toBe("WEBHOOK_TOKEN");
  });

  it("leaves non-secret tag values readable", () => {
    const out = redactSecrets({ tags: [{ tagType: "CREATION_TYPE", tagValue: "USER" }] });
    expect(out.tags[0].tagValue).toBe("USER");
  });

  it("redacts both copies of the same token to the same placeholder", () => {
    const token = "example-inbound-token-not-real";
    const out = redactSecrets({
      trigger: { value: { webhookToken: token } },
      tags: [{ tagType: "WEBHOOK_TOKEN", tagValue: token }],
    });
    expect(out.trigger.value.webhookToken).toBe(out.tags[0].tagValue);
    expect(JSON.stringify(out)).not.toContain(token);
  });
});

describe("findSecrets", () => {
  it("reports the kind and path of each secret without exposing the value", () => {
    const found = findSecrets({ trigger: { value: { webhookToken: "tok-abcdef" } } });
    expect(found).toEqual([{ kind: "webhook-token", path: "$.trigger.value.webhookToken" }]);
  });

  it("returns an empty list for a clean rule", () => {
    expect(findSecrets(ruleWith())).toEqual([]);
  });

  it("reports a secret-bearing tag", () => {
    const found = findSecrets({ tags: [{ tagType: "WEBHOOK_TOKEN", tagValue: "abc123def456" }] });
    expect(found).toEqual([{ kind: "secret-tag", path: "$.tags[0].tagValue" }]);
  });

  it("indexes into arrays so the report points at the right component", () => {
    const found = findSecrets({ components: [{ value: {} }, { value: { webhookToken: "t" } }] });
    expect(found[0].path).toBe("$.components[1].value.webhookToken");
  });
});

describe("stripVolatileFields", () => {
  it("drops derived and infrastructure fields", () => {
    const out = stripVolatileFields(ruleWith());
    for (const key of ["checksum", "partitionId", "clientKey", "currentVersionId"]) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it("keeps the fields the analysis depends on", () => {
    const out = stripVolatileFields(ruleWith({ updated: 123, projects: [{ projectId: "1" }] }));
    expect(out).toMatchObject({ id: 123, name: "Test rule", state: "ENABLED", updated: 123 });
    expect(out.projects).toEqual([{ projectId: "1" }]);
  });

  it("strips component checksums at every nesting level", () => {
    const rule = ruleWith({
      components: [
        { id: "c1", checksum: "x", children: [{ id: "c2", checksum: "y", conditions: [{ id: "c3", checksum: "z" }] }] },
      ],
    });
    const out = stripVolatileFields(rule);
    expect(JSON.stringify(out)).not.toContain("checksum");
    // Structure survives the strip.
    expect(out.components[0].children[0].conditions[0].id).toBe("c3");
  });

  it("drops the IS_RULE_UPDATED tag, which flips just from opening the editor", () => {
    const out = stripVolatileFields(
      ruleWith({ tags: [{ id: 1, ruleIdUuid: "u", tagType: "IS_RULE_UPDATED", tagValue: "true" }] }),
    );
    expect(out.tags).toEqual([]);
  });

  it("keeps provenance tags but discards their storage identifiers", () => {
    const out = stripVolatileFields(
      ruleWith({ tags: [{ id: 99, ruleIdUuid: "uuid-1", tagType: "CREATION_TYPE", tagValue: "USER" }] }),
    );
    expect(out.tags).toEqual([{ tagType: "CREATION_TYPE", tagValue: "USER" }]);
  });

  it("sorts tags so reordering by the API is not a diff", () => {
    const a = stripVolatileFields(
      ruleWith({
        tags: [
          { tagType: "TEMPLATE_ID", tagValue: "t1" },
          { tagType: "CREATION_TYPE", tagValue: "USER" },
        ],
      }),
    );
    const b = stripVolatileFields(
      ruleWith({
        tags: [
          { tagType: "CREATION_TYPE", tagValue: "USER" },
          { tagType: "TEMPLATE_ID", tagValue: "t1" },
        ],
      }),
    );
    expect(a.tags).toEqual(b.tags);
  });

  it("tolerates a rule with no tags array", () => {
    const out = stripVolatileFields(ruleWith({ tags: undefined }));
    expect(out.tags).toBeUndefined();
  });
});

describe("serializeRule", () => {
  it("emits pretty-printed JSON ending in a newline", () => {
    const text = serializeRule(ruleWith());
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "id": 123');
  });

  it("is byte-stable across two exports that differ only in key order and volatile fields", () => {
    const first = serializeRule({
      ...ruleWith(),
      checksum: "sum-A",
      tags: [{ tagType: "IS_RULE_UPDATED", tagValue: "true" }],
    });
    const second = serializeRule({
      tags: [],
      state: "ENABLED",
      name: "Test rule",
      id: 123,
      checksum: "sum-B",
      trigger: ruleWith().trigger,
      components: [],
      clientKey: "client-1",
      partitionId: "part-2",
      currentVersionId: null,
    });
    expect(first).toBe(second);
  });

  it("produces a diff when real content changes", () => {
    expect(serializeRule(ruleWith())).not.toBe(serializeRule(ruleWith({ state: "DISABLED" })));
  });

  it("never emits a raw secret", () => {
    const rule = ruleWith({ trigger: { value: { webhookToken: "example-inbound-token-not-real" } } });
    expect(serializeRule(rule)).not.toContain("example-inbound-token-not-real");
  });
});

describe("normalizeRule", () => {
  it("applies strip, redact and sort together", () => {
    const out = normalizeRule(ruleWith({ trigger: { value: { webhookToken: "abc123def456" } }, checksum: "s" }));
    expect(out).not.toHaveProperty("checksum");
    expect(out.trigger.value.webhookToken).toMatch(PLACEHOLDER);
    expect(Object.keys(out)).toEqual([...Object.keys(out)].sort());
  });
});

describe("ruleFileName", () => {
  it("keys on the numeric id so a rename keeps the file's history", () => {
    expect(ruleFileName({ id: 28499275, name: "11. Update Post Sourcing / Cost Review" })).toBe("28499275.json");
  });
});

describe("buildManifest", () => {
  const rules = [
    { id: 1, clientKey: "ck", state: "ENABLED" },
    { id: 2, clientKey: "ck", state: "DISABLED" },
    { id: 3, clientKey: "ck", state: "ENABLED" },
  ];

  it("counts rules by state", () => {
    const m = buildManifest({ rules, exportedAt: "2026-08-05T00:00:00Z", cloud: true });
    expect(m).toMatchObject({ ruleCount: 3, enabledCount: 2, disabledCount: 1, cloud: true });
  });

  it("collapses a site-wide clientKey to a single value", () => {
    expect(buildManifest({ rules }).clientKey).toBe("ck");
  });

  it("keeps every clientKey when they disagree, rather than silently picking one", () => {
    const mixed = [
      { id: 1, clientKey: "a" },
      { id: 2, clientKey: "b" },
    ];
    expect(buildManifest({ rules: mixed }).clientKey).toEqual(["a", "b"]);
  });

  it("redacts secrets inside connection config", () => {
    const m = buildManifest({ rules, connections: [{ id: "c", targetConfigJson: "client_secret=topsecretvalue" }] });
    expect(JSON.stringify(m)).not.toContain("topsecretvalue");
  });

  it("handles an empty export", () => {
    expect(buildManifest({})).toMatchObject({ ruleCount: 0, enabledCount: 0, disabledCount: 0 });
  });
});
