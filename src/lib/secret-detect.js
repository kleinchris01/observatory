// Recognizers for credential-bearing values inside an automation rule.
//
// These lived inside rule-snapshot.js, next to the redactor that consumes them. That was
// the right home while redaction was the only caller -- and it is why the automation
// analysis reported that this site stores no credentials at all while 86 of its rules
// carry one.
//
// The analysis could not import them. rule-snapshot.js imports node:crypto for the
// redaction fingerprint, and automation-analysis.js runs in the admin's browser, so the
// import would have broken the bundle. What it did instead was test the redacted OUTPUT
// for the `[[REDACTED:xxxxxxxx]]` marker -- which is only ever present in a rule that has
// already been through the snapshot script. The browser imports the raw export from Jira,
// where that marker cannot exist, so the test could only ever return false.
//
// Hence this module: the recognizers alone, no crypto, no imports. rule-snapshot.js pairs
// each one with a redactor; automation-analysis.js pairs each one with a finding. One list,
// so a matcher added for the redactor is a matcher the analysis reports on the same day.

// A value that has already been through the redactor. Still evidence a credential exists,
// but not a fresh one -- see `unredacted` below.
export const REDACTED_MARKER_RE = /\[\[REDACTED:[0-9a-f]{8}\]\]/;

// Every matcher has to reject its own output.
//
// `client_secret=[[REDACTED:5d417630]]` matches the form-encoded matcher as readily as
// `client_secret=Xk3...` does: the value pattern is "not an ampersand or a space", which a
// placeholder satisfies. That was invisible while redaction was the only caller -- nothing
// ever ran the recognizers over redacted output -- and it stops being invisible the moment
// the analysis uses the same list, because a snapshot-built analysis would report every
// already-handled secret as a live one.
function unredacted(value) {
  return String(value).replace(new RegExp(REDACTED_MARKER_RE.source, "g"), "");
}

// Deliberately shaped as key/value tests rather than JSON paths. Automation nests
// components arbitrarily deep -- the same web request action appears at
// $.components[].value and six levels down inside nested branches -- so a path-based list
// would silently miss the deep copies.
export const SECRET_MATCHERS = [
  {
    name: "webhook-token",
    // Inbound webhook triggers authenticate the caller with this token. Anyone holding it
    // can fire the rule.
    label: "Inbound webhook token",
    test: (key, value) =>
      /^webhooktoken$/i.test(key) && typeof value === "string" && unredacted(value).length > 0,
  },
  {
    name: "incoming-webhook-url",
    // Slack/Teams style webhook URLs are bearer credentials: the secret IS the path.
    label: "Slack or Teams webhook URL",
    test: (key, value) =>
      typeof value === "string"
      && /^https:\/\/(hooks\.slack\.com|[a-z0-9-]+\.webhook\.office\.com)\/./i.test(unredacted(value)),
  },
  {
    name: "form-encoded-secret",
    // OAuth client-credentials bodies. Only the secret is a credential; grant_type and
    // client_id are configuration, and "which app does this rule authenticate as" is
    // exactly the kind of question the analysis needs to keep answering.
    label: "Client secret or API key in a request body",
    test: (key, value) => typeof value === "string" && hasLiteralFormSecret(unredacted(value)),
  },
  {
    name: "literal-bearer-token",
    // `Bearer {{graphtoken}}` is a reference and is not a finding; `Bearer eyJ0...` is a
    // real token sitting in the rule.
    label: "Literal bearer token in a header",
    test: (key, value) => typeof value === "string" && LITERAL_BEARER_RE.test(unredacted(value)),
  },
];

export const FORM_SECRET_RE = /((?:client_secret|password|api[_-]?key|apikey)=)([^&\s"]+)/gi;

// True only when at least one occurrence holds a literal rather than a smart value.
//
// `client_secret={{graphSecret}}` is a reference to a value held elsewhere -- it is
// precisely the remediation this finding advises -- so counting it as a credential would
// mean a rule could never clear the finding by doing the right thing. The redactor has
// always made this distinction per occurrence; the recognizer did not, which was invisible
// while only the redactor consumed it.
//
// Per occurrence, not for the whole string: a body can carry a literal and a reference at
// once, and the literal is still a credential.
function hasLiteralFormSecret(value) {
  FORM_SECRET_RE.lastIndex = 0;
  for (const match of value.matchAll(FORM_SECRET_RE)) {
    if (!/^\{\{.*\}\}$/.test(match[2])) return true;
  }
  return false;
}
export const LITERAL_BEARER_RE = /^(Bearer\s+)((?!\{\{)[A-Za-z0-9._~+/=-]{16,})$/i;

// Tags whose value is a credential rather than a label. These need sibling context to
// spot -- the key is the generic "tagValue", and only the adjacent "tagType" says what the
// string is -- so they are handled at the object level rather than by SECRET_MATCHERS.
//
// This exists because the first version of the redactor missed them: a webhook token is
// stored twice, once at trigger.value.webhookToken and again as a WEBHOOK_TOKEN tag, and
// handling only the first still left all five tokens in the snapshot.
export const SECRET_TAG_TYPES = new Set(["WEBHOOK_TOKEN"]);

export const SECRET_TAG_KIND = "secret-tag";

export const SECRET_KIND_LABELS = {
  ...Object.fromEntries(SECRET_MATCHERS.map((m) => [m.name, m.label])),
  [SECRET_TAG_KIND]: "Webhook token stored as a rule tag",
  // Only ever produced by an analysis built from the committed snapshot rather than a
  // fresh export. The credential is real; which kind it was did not survive redaction.
  redacted: "Credential redacted in this snapshot",
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isSecretTag(node) {
  return isPlainObject(node)
    && SECRET_TAG_TYPES.has(node.tagType)
    && typeof node.tagValue === "string"
    && unredacted(node.tagValue).length > 0;
}

// A global regex advances lastIndex on every .test(), so the next call starts partway
// through the string and can miss a match. Reset before each use.
export function resetMatcherState() {
  FORM_SECRET_RE.lastIndex = 0;
  LITERAL_BEARER_RE.lastIndex = 0;
}

// Every credential-bearing value in a structure, with the path that reached it.
//
// Best-effort by construction, like everything else that reads rule JSON: an unrecognized
// shape contributes nothing rather than throwing. Callers must read the result as
// "credentials we can prove", never as "all credentials".
export function findSecrets(value, key = "", path = "$", found = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, i) => findSecrets(entry, key, `${path}[${i}]`, found));
    return found;
  }
  if (isPlainObject(value)) {
    if (isSecretTag(value)) found.push({ kind: SECRET_TAG_KIND, path: `${path}.tagValue` });
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

// The distinct kinds of credential one rule carries, for a finding that names the evidence
// rather than just asserting a verdict.
//
// Paths are deliberately NOT returned. The finding travels to the browser, into KVS, and
// through a resolver log; "$.components[3].value.body" is enough to lead someone straight
// to the secret, and the rule id already tells an admin where to look.
export function detectRuleSecretKinds(rule) {
  const kinds = new Set(findSecrets(rule).map((hit) => hit.kind));
  // An already-redacted rule proves a credential was there without proving which kind, so
  // it contributes the fact but no kind label.
  if (!kinds.size && REDACTED_MARKER_RE.test(JSON.stringify(rule ?? {}))) return ["redacted"];
  return [...kinds].sort();
}
