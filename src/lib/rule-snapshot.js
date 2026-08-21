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
import {
  FORM_SECRET_RE,
  LITERAL_BEARER_RE,
  SECRET_MATCHERS,
  isSecretTag,
  resetMatcherState,
} from "./secret-detect.js";

// Re-exported because the snapshot script prints it: a run that quietly stops redacting --
// because Atlassian renamed a field -- should be visible rather than silent. Callers that
// only want to know what is in a rule import it from secret-detect.js directly.
export { findSecrets } from "./secret-detect.js";

// Replaced values keep a fingerprint of what they held. A bare "[REDACTED]" would make
// every secret look identical forever, so a rotated credential -- the thing you most want
// to notice -- would produce no diff at all. Hashing preserves "this changed" while
// disclosing nothing: the input space is far too large to reverse from 8 hex characters.
export function redactionPlaceholder(value) {
  const digest = createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
  return `[[REDACTED:${digest}]]`;
}

// Redaction is paired with the recognizers rather than owning them.
//
// SECRET_MATCHERS moved to secret-detect.js so the automation analysis could use the same
// list; it cannot import this module, which needs node:crypto for the fingerprint below.
// What stays here is the half that is specific to writing a snapshot: how each recognized
// value is rewritten so the file is safe to commit.
//
// Keyed by matcher name so a matcher added to the shared list without a redactor here is a
// loud failure at snapshot time rather than a silently unredacted secret in git.
const REDACTORS = {
  "webhook-token": (value) => redactionPlaceholder(value),
  "incoming-webhook-url": (value) => {
    const origin = value.slice(0, value.indexOf("/", 8));
    return `${origin}/${redactionPlaceholder(value)}`;
  },
  "form-encoded-secret": (value) =>
    value.replace(FORM_SECRET_RE, (match, prefix, secret) =>
      // A smart value is a reference, not a secret -- leave it legible.
      /^\{\{.*\}\}$/.test(secret) ? match : `${prefix}${redactionPlaceholder(secret)}`
    ),
  "literal-bearer-token": (value) =>
    value.replace(LITERAL_BEARER_RE, (match, scheme, token) => `${scheme}${redactionPlaceholder(token)}`),
};

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
    resetMatcherState();
    if (matcher.test(key, result)) result = REDACTORS[matcher.name](result);
  }
  return result;
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
