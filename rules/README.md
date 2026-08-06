# Automation rule snapshot

One file per Jira Automation rule, named `<ruleId>.json`, plus `_manifest.json` for
site-level facts (rule counts, connections, export timestamp).

This directory is a **governance history**, not application data. The Observatory app does
not read it at runtime — it exists so that week-over-week changes to the site's automation
estate are reviewable in a pull request and permanently recorded in git history.

## Refreshing it

```bash
npm run rules:snapshot -- automation-rules-<timestamp>.json
```

Then open a PR. `git status` alone describes the week:

| Git status | Meaning |
| --- | --- |
| Added file | New automation rule |
| Deleted file | Rule deleted, or moved out of export scope |
| Modified file | Rule edited |

Files are keyed on rule id rather than name, so renaming a rule keeps its history —
`git log --follow rules/28499275.json` shows every change ever made to that one rule.

## What the script does to the export

**Sorts all object keys recursively.** Atlassian does not guarantee key order between
exports; without this, a change in their serializer would rewrite all 1,477 files at once
and hide the week's real changes. Array order is left alone, because component order is
execution order.

**Strips fields that churn without meaning:** per-rule and per-component `checksum`
(derived from content the diff already shows), `partitionId` (storage shard), `clientKey`
(identical site-wide, recorded once in the manifest), `currentVersionId` (null on every
rule), and the `IS_RULE_UPDATED` tag (flips just from opening the rule editor). All other
tag types are kept — `CREATION_TYPE`, `TEMPLATE_ID`, `SAMPLE_RULE` and the `ORCHESTRATION_*`
family are real provenance.

**Redacts credentials.** See below.

## Credentials

Raw exports contain live secrets in plaintext. `automation-rules-*.json` is gitignored and
must stay that way.

Redacted values are replaced with `[[REDACTED:<8 hex>]]`, a truncated SHA-256 of the
original. This is deliberate: a bare `[REDACTED]` would make every secret look identical
forever, so rotating a credential — the thing most worth noticing — would produce no diff
at all. The hash preserves "this changed" while disclosing nothing.

Currently redacted: inbound webhook tokens (both at `trigger.value.webhookToken` and as
`WEBHOOK_TOKEN` tag values), Slack and Teams incoming webhook URLs, form-encoded
`client_secret` / `password` / `api_key` values in web-request bodies, and literal
`Authorization: Bearer` tokens. Smart-value references such as `{{graphtoken}}` are left
readable, since a reference is not a secret.

The script prints a count by kind on every run. If that count drops unexpectedly, assume
the redactor stopped matching rather than that the rules got cleaner.
