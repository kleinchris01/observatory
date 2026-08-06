// Normalize Jira Automation rules into a form that can be committed and diffed.
//
// The weekly governance loop is: export the rules, normalize them here, commit one file
// per rule, and read the change set out of git. That only works if serialization is a
// pure function of rule CONTENT -- anything that varies between two exports of an
// unchanged site shows up as a diff and buries the real changes.
//
// Two separate jobs, deliberately kept apart:
//
//   stripVolatileFields  removes values that carry no meaning and churn on every save
//   redactSecrets        removes values that carry too MUCH meaning to sit in a repo
//
// The second is not optional. A raw export of this site contains live Entra client
// secrets in web-request bodies, inbound webhook tokens, and a Slack webhook URL, all in
// plaintext. Committing an unredacted export writes those into git history, where
// deleting them later does not remove them.

import { createHash } from "node:crypto";

// Replaced values keep a fingerprint of what they held. A bare "[REDACTED]" would make
// every secret look identical forever, so a rotated credential -- the thing you most want
// to notice -- would produce no diff at all. Hashing preserves "this changed" while
// disclosing nothing: the input space is far too large to reverse from 8 hex characters.
export function redactionPlaceholder(value) {
  const digest = createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
  return `[[REDACTED:${digest}]]`;
}

// Recognizers for credential-bearing values, matched on the key name and the value shape
// rather than on JSON path. Automation nests components arbitrarily deep -- the same web
// request action appears at $.components[].value and six levels down inside nested
// branches -- so a path-based list would silently miss the deep copies.
const SECRET_MATCHERS = [
  {
    name: "webhook-token",
    // Inbound webhook triggers authenticate the caller with this token. Anyone holding it
    // can fire the rule.
    test: (key, value) => /^webhooktoken$/i.test(key) && typeof value === "string" && value.length > 0,
    redact: (value) => redactionPlaceholder(value),
  },
  {
    name: "incoming-webhook-url",
    // Slack/Teams style webhook URLs are bearer credentials: the secret IS the path.
    test: (key, value) =>
      typeof value === "string" && /^https:\/\/(hooks\.slack\.com|[a-z0-9-]+\.webhook\.office\.com)\//i.test(value),
    redact: (value) => {
      const origin = value.slice(0, value.indexOf("/", 8));
      return `${origin}/${redactionPlaceholder(value)}`;
    },
  },
  {
    name: "form-encoded-secret",
    // OAuth client-credentials bodies. Only the secret is removed; grant_type and
    // client_id stay, because "which app does this rule authenticate as" is exactly the
    // kind of question the analysis needs to answer.
    test: (key, value) => typeof value === "string" && FORM_SECRET_RE.test(value),
    redact: (value) =>
      value.replace(FORM_SECRET_RE, (match, prefix, secret) =>
        // A smart value is a reference, not a secret -- leave it legible.
        /^\{\{.*\}\}$/.test(secret) ? match : `${prefix}${redactionPlaceholder(secret)}`
      ),
  },
  {
    name: "literal-bearer-token",
    // `Bearer {{graphtoken}}` is a reference and stays; `Bearer eyJ0...` is a real token.
    test: (key, value) => typeof value === "string" && LITERAL_BEARER_RE.test(value),
    redact: (value) => value.replace(LITERAL_BEARER_RE, (match, scheme, token) => `${scheme}${redactionPlaceholder(token)}`),
  },
];

const FORM_SECRET_RE = /((?:client_secret|password|api[_-]?key|apikey)=)([^&\s"]+)/gi;
const LITERAL_BEARER_RE = /^(Bearer\s+)((?!\{\{)[A-Za-z0-9._~+/=-]{16,})$/i;

// Tags whose value is a credential rather than a label. These need sibling context to
// spot -- the key is the generic "tagValue", and only the adjacent "tagType" says what the
// string is -- so they are handled at the object level rather than by SECRET_MATCHERS.
//
// This exists because the first version of this module missed them: a webhook token is
// stored twice, once at trigger.value.webhookToken and again as a WEBHOOK_TOKEN tag, and
// redacting only the first still wrote all five tokens into the snapshot.
const SECRET_TAG_TYPES = new Set(["WEBHOOK_TOKEN"]);

function isSecretTag(node) {
  return isPlainObject(node) && SECRET_TAG_TYPES.has(node.tagType) && typeof node.tagValue === "string" && node.tagValue.length > 0;
}

// Fields removed before serialization, with the reason each one earns its place.
const VOLATILE_RULE_FIELDS = new Set([
  // Content hash. Derived from the rule itself, so it adds nothing a diff cannot already
  // see, and it changes on every edit -- including edits confined to one component.
  "checksum",
  // Storage shard. Infrastructure placement, not configuration.
  "partitionId",
  // Identical across every rule on the site. Recorded once in the manifest instead.
  "clientKey",
  // Null on all 1477 rules in the reference export. Kept out rather than committed as a
  // column of nulls that might start moving for reasons unrelated to rule content.
  "currentVersionId",
]);

const VOLATILE_COMPONENT_FIELDS = new Set(["checksum"]);

// Tag types that describe UI state rather than the rule. IS_RULE_UPDATED is set on 1211
// of 1477 rules and flips as a side effect of opening the editor. Every other tag type
// (CREATION_TYPE, TEMPLATE_ID, SAMPLE_RULE, ORCHESTRATION_*, EXTERNAL_AGENT_ID) is real
// provenance and is kept -- "which rules came from a template" is a governance question.
const VOLATILE_TAG_TYPES = new Set(["IS_RULE_UPDATED"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Recursively sort object keys. Arrays keep their order, which is load-bearing: component
// order is execution order, and reordering conditions would change what a rule does.
//
// Atlassian gives no ordering guarantee for the keys it emits. Without this, a change in
// their serializer would rewrite all 1477 files at once and the week's real changes would
// be unfindable.
export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
  return out;
}

export function redactSecrets(value, key = "") {
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, key));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactSecrets(v, k);
    if (isSecretTag(value)) out.tagValue = redactionPlaceholder(value.tagValue);
    return out;
  }
  if (typeof value !== "string") return value;

  let result = value;
  for (const matcher of SECRET_MATCHERS) {
    // A global regex advances lastIndex on every .test(), so the next call starts partway
    // through the string and can miss a match. Reset before each use.
    resetMatcherState();
    if (matcher.test(key, result)) result = matcher.redact(result);
  }
  return result;
}

function resetMatcherState() {
  FORM_SECRET_RE.lastIndex = 0;
  LITERAL_BEARER_RE.lastIndex = 0;
}

// Reports what redactSecrets would remove, without producing the redacted copy. The
// snapshot script prints this so a run that quietly stops redacting -- because Atlassian
// renamed a field -- is visible rather than silent.
export function findSecrets(value, key = "", path = "$", found = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, i) => findSecrets(entry, key, `${path}[${i}]`, found));
    return found;
  }
  if (isPlainObject(value)) {
    if (isSecretTag(value)) found.push({ kind: "secret-tag", path: `${path}.tagValue` });
    for (const [k, v] of Object.entries(value)) findSecrets(v, k, `${path}.${k}`, found);
    return found;
  }
  if (typeof value !== "string") return found;
  for (const matcher of SECRET_MATCHERS) {
    resetMatcherState();
    if (matcher.test(key, value)) found.push({ kind: matcher.name, path });
  }
  return found;
}

function stripComponent(component) {
  if (!isPlainObject(component)) return component;
  const out = {};
  for (const [k, v] of Object.entries(component)) {
    if (VOLATILE_COMPONENT_FIELDS.has(k)) continue;
    if (k === "children" || k === "conditions") out[k] = Array.isArray(v) ? v.map(stripComponent) : v;
    else out[k] = v;
  }
  return out;
}

export function stripVolatileFields(rule) {
  const out = {};
  for (const [k, v] of Object.entries(rule)) {
    if (VOLATILE_RULE_FIELDS.has(k)) continue;
    out[k] = v;
  }
  if (out.trigger) out.trigger = stripComponent(out.trigger);
  if (Array.isArray(out.components)) out.components = out.components.map(stripComponent);
  if (Array.isArray(out.tags)) {
    out.tags = out.tags
      .filter((tag) => !VOLATILE_TAG_TYPES.has(tag?.tagType))
      // The tag's own row id and ruleIdUuid are storage identifiers that are reissued when
      // a tag is rewritten; the type/value pair is the fact worth keeping.
      .map((tag) => ({ tagType: tag?.tagType ?? null, tagValue: tag?.tagValue ?? null }))
      .sort((a, b) => `${a.tagType}${a.tagValue}`.localeCompare(`${b.tagType}${b.tagValue}`));
  }
  return out;
}

export function normalizeRule(rule) {
  return sortKeysDeep(redactSecrets(stripVolatileFields(rule)));
}

// Trailing newline so the files are POSIX text and git does not report "\ No newline at
// end of file" on every one of them.
export function serializeRule(rule) {
  return `${JSON.stringify(normalizeRule(rule), null, 2)}\n`;
}

// Site-level facts that would otherwise be duplicated across 1477 files. Connections are
// site configuration rather than rule content, so they live here too.
export function buildManifest({ rules = [], connections = [], exportedAt = null, cloud = null }) {
  const clientKeys = [...new Set(rules.map((r) => r.clientKey).filter(Boolean))];
  return sortKeysDeep({
    cloud,
    exportedAt,
    ruleCount: rules.length,
    clientKey: clientKeys.length === 1 ? clientKeys[0] : clientKeys,
    enabledCount: rules.filter((r) => r.state === "ENABLED").length,
    disabledCount: rules.filter((r) => r.state !== "ENABLED").length,
    connections: redactSecrets(connections),
  });
}

export function ruleFileName(rule) {
  // Keyed on the numeric id, never the name. Names contain spaces, slashes and emoji, and
  // renaming a rule would otherwise read as a delete plus an add and lose its history.
  return `${rule.id}.json`;
}
