import { describe, test, expect } from "vitest";
import { SECRET_KIND_LABELS, detectRuleSecretKinds, findSecrets, isSecretTag } from "./secret-detect.js";
import { normalizeRule } from "./rule-snapshot.js";

// These recognizers were extracted from rule-snapshot.js so the automation analysis could
// use them. The bug that prompted it: the analysis tested for the redactor's OUTPUT marker
// rather than for a credential, so on a raw export -- the only thing the browser ever
// analyses -- it reported zero credentials on a site carrying 86.
//
// So the properties worth pinning are (1) a raw secret is found, (2) a redacted one is not
// found twice, and (3) the two halves of the split agree about what a secret is.

const webRequest = (value) => ({
  id: "c1",
  component: "ACTION",
  type: "jira.issue.outgoing.webhook",
  value,
});

const rule = (over = {}) => ({ id: 1, name: "R", state: "ENABLED", components: [], ...over });

describe("findSecrets — what counts as a credential", () => {
  test("finds a client secret in a form-encoded request body", () => {
    const found = findSecrets(
      rule({
        components: [
          webRequest({
            url: "https://login.microsoftonline.com/t/oauth2/v2.0/token",
            customBody: "grant_type=client_credentials&client_id=abc&client_secret=Xq7~vN2rL8pZ",
          }),
        ],
      }),
    );
    expect(found.map((f) => f.kind)).toContain("form-encoded-secret");
  });

  test("leaves a smart-value reference alone", () => {
    // `client_secret={{graphSecret}}` is a pointer at a stored value, not the value.
    // Flagging it would make the finding meaningless: the fix it advises is already done.
    const found = findSecrets(
      rule({
        components: [webRequest({ customBody: "grant_type=client_credentials&client_secret={{graphSecret}}" })],
      }),
    );
    expect(found).toEqual([]);
  });

  test("separates a literal bearer token from a smart-value one", () => {
    const literal = findSecrets(
      rule({
        components: [webRequest({ headers: [{ name: "Authorization", value: "Bearer eyJhbGciOiJIUzI1NiJ9abcdef" }] })],
      }),
    );
    const reference = findSecrets(
      rule({
        components: [webRequest({ headers: [{ name: "Authorization", value: "Bearer {{graphtoken}}" }] })],
      }),
    );

    expect(literal.map((f) => f.kind)).toEqual(["literal-bearer-token"]);
    expect(reference).toEqual([]);
  });

  test("finds an inbound webhook token, and the tag that duplicates it", () => {
    // The token is stored twice. The first version of the redactor handled only the
    // trigger copy and still wrote every token to disk via the tag.
    const found = findSecrets(
      rule({
        trigger: { component: "TRIGGER", type: "jira.incoming.webhook", value: { webhookToken: "9f2c4a1e77" } },
        tags: [{ tagType: "WEBHOOK_TOKEN", tagValue: "9f2c4a1e77" }],
      }),
    );
    expect(found.map((f) => f.kind).sort()).toEqual(["secret-tag", "webhook-token"]);
  });

  test("treats a Slack webhook URL as a credential, because the path is the secret", () => {
    const found = findSecrets(
      rule({
        components: [webRequest({ url: "https://hooks.slack.com/services/T00/B00/XXXXXXXXXXXX" })],
      }),
    );
    expect(found.map((f) => f.kind)).toEqual(["incoming-webhook-url"]);
  });

  test("does not flag an ordinary Atlassian or third-party URL", () => {
    expect(
      findSecrets(
        rule({
          components: [webRequest({ url: "https://example.atlassian.net/rest/api/3/issue" })],
        }),
      ),
    ).toEqual([]);
  });

  test("survives a rule shaped nothing like a rule", () => {
    expect(findSecrets(null)).toEqual([]);
    expect(findSecrets(undefined)).toEqual([]);
    expect(findSecrets(42)).toEqual([]);
    expect(findSecrets([{ a: [{ b: null }] }])).toEqual([]);
  });
});

// The property that made this a bug rather than a refactor. Every matcher has to reject
// its own output, or an analysis built from the committed snapshot would report every
// already-handled secret as a live one -- and `findSecrets` would report a redacted file
// as still leaking.
describe("recognizers reject their own redacted output", () => {
  const cases = [
    ["form-encoded body", rule({ components: [webRequest({ customBody: "client_secret=Xq7~vN2rL8pZ" })] })],
    [
      "bearer header",
      rule({
        components: [webRequest({ headers: [{ name: "Authorization", value: "Bearer eyJhbGciOiJIUzI1NiJ9abcdef" }] })],
      }),
    ],
    ["slack url", rule({ components: [webRequest({ url: "https://hooks.slack.com/services/T00/B00/XXXXXXXXXXXX" })] })],
    [
      "webhook token and its tag",
      rule({
        trigger: { component: "TRIGGER", type: "jira.incoming.webhook", value: { webhookToken: "9f2c4a1e77" } },
        tags: [{ tagType: "WEBHOOK_TOKEN", tagValue: "9f2c4a1e77" }],
      }),
    ],
  ];

  test.each(cases)("%s is found once and not again after redaction", (_label, raw) => {
    expect(findSecrets(raw).length).toBeGreaterThan(0);
    expect(findSecrets(normalizeRule(raw))).toEqual([]);
  });
});

describe("isSecretTag", () => {
  test("needs the type, a value, and an unredacted one", () => {
    expect(isSecretTag({ tagType: "WEBHOOK_TOKEN", tagValue: "abc" })).toBe(true);
    expect(isSecretTag({ tagType: "CREATION_TYPE", tagValue: "abc" })).toBe(false);
    expect(isSecretTag({ tagType: "WEBHOOK_TOKEN", tagValue: "" })).toBe(false);
    expect(isSecretTag({ tagType: "WEBHOOK_TOKEN", tagValue: "[[REDACTED:deadbeef]]" })).toBe(false);
    expect(isSecretTag(null)).toBe(false);
  });
});

describe("detectRuleSecretKinds — what the analysis reports", () => {
  test("names every distinct kind a rule carries", () => {
    const kinds = detectRuleSecretKinds(
      rule({
        components: [
          webRequest({ customBody: "client_secret=Xq7~vN2rL8pZ" }),
          webRequest({ headers: [{ name: "Authorization", value: "Bearer eyJhbGciOiJIUzI1NiJ9abcdef" }] }),
        ],
      }),
    );
    expect(kinds).toEqual(["form-encoded-secret", "literal-bearer-token"]);
  });

  test("returns nothing for a clean rule", () => {
    expect(detectRuleSecretKinds(rule())).toEqual([]);
  });

  test("still reports a credential when analysing an already-redacted snapshot", () => {
    // A snapshot-built analysis must not report a clean bill of health for an estate whose
    // secrets were removed on the way to disk. The kind does not survive redaction, so it
    // reports the fact under a kind of its own rather than guessing.
    const redacted = normalizeRule(rule({ components: [webRequest({ customBody: "client_secret=Xq7~vN2rL8pZ" })] }));
    expect(detectRuleSecretKinds(redacted)).toEqual(["redacted"]);
  });

  test("does not leak a path to the secret", () => {
    // The finding travels into KVS, through a resolver log and into the browser. A JSON
    // path would take a reader straight to the value; the rule id is enough to act on.
    const kinds = detectRuleSecretKinds(
      rule({ components: [webRequest({ customBody: "client_secret=Xq7~vN2rL8pZ" })] }),
    );
    expect(JSON.stringify(kinds)).not.toMatch(/components|value|\$\./);
  });

  test("every kind it can emit has a label", () => {
    for (const kind of [
      "form-encoded-secret",
      "literal-bearer-token",
      "webhook-token",
      "incoming-webhook-url",
      "secret-tag",
      "redacted",
    ]) {
      expect(SECRET_KIND_LABELS[kind]).toBeTruthy();
    }
  });
});
