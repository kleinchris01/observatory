# Observatory — Security Checklist

Last verified: **19 October 2026** against `master` at `7555b7d`, plus the denial-burst alerting
added in the same change as this revision.

This document records what Observatory actually enforces, what it deliberately does not, and
where the accepted risks and open items are. Every claim below is checkable against a named
file. If you change a control, change this file in the same commit — a checklist that drifts
from the code is worse than no checklist, because people quote it.

> **Why this revision exists.** The 31 July version had drifted by October. It still said
> Observatory never writes to Jira and requests 23 scopes; by then it requested 60, including
> `write:jira-work`, and created, commented on and transitioned remediation issues. Section
> 11 lists every item that is open today, so nobody reads a missing section as assurance.

---

## 1. Authorization

### 1.1 Admin functions require Jira ADMINISTER

**Enforced.** Every function in the admin registry verifies the *calling user* holds the Jira
`ADMINISTER` global permission before it runs (`withAdminGuard`, `src/resolvers/admin-guard.js`,
applied to `RAW_ADMIN_ONLY_FUNCTIONS` in `src/resolvers.js`).

The guard wraps the whole registry at export rather than being called inside each function. A
function added to the registry is guarded by construction — there is no step anyone can forget.

- Permission is checked via `POST /rest/api/3/permissions/check` **as the user**
  (`callerHasJiraAdmin`, `src/lib/jira-api.js`). Checking as the app would report the app's own
  permissions and answer nothing useful.
- Fails closed. A missing `accountId`, an API error, or an unparseable response all resolve to
  "not an admin". An anonymous caller is refused without a Jira round trip.
- Denials are audited, logged at `warn` (`auth.denied`), and counted for the burst alert (§2.2).

> **Why this exists.** The `jira:adminPage` module controls who can *see* the admin page. It does
> not control who can reach its resolver — an `invoke()` is an authenticated app endpoint, and
> module placement is a UI affordance, not an authorization boundary. Before 31 July 2026 there
> were no permission checks anywhere in the resolvers.

### 1.2 The macro resolver cannot reach admin functions

**Enforced.** Two registries, two handlers (`src/index.js`):

| Handler | Registers | Module |
|---|---|---|
| `handler` | `SHARED_RESOLVER_FUNCTIONS` only, behind the macro group gate | Confluence macro |
| `adminHandler` | shared + the guarded admin registry | `jira:adminPage` |

A function absent from the shared set is not registered on the macro's resolver, so an invoke
from the macro iframe fails to resolve rather than executing. `src/index.test.js` ("resolver
handler registries") asserts that `adminHandler` registers nothing beyond those two registries.

### 1.3 Macro viewer access is group-gated

**Enforced on every macro read, fails open.** When `macroAccess.restrictAccess` is on,
`withMacroAccessGuard` (`src/resolvers/macro-access.js`) checks the caller's Jira groups before
every shared resolver runs. The answer is cached per account for 60 seconds
(`MACRO_ACCESS_TTL_MS`); a failed lookup is not cached.

> **Accepted risk.** If the Jira group-lookup call fails, access is **granted**
> (`src/resolvers/macro-access.js`, "fail open"). The macro is read-only and shows the field
> catalogue, and blanking a Confluence page for everyone over an unrelated API blip was judged
> worse than briefly over-granting a field list. **This must be revisited before the macro shows
> anything more sensitive** — findings, people, access or licence data.

### 1.4 Project data respects the viewer's own permissions

**Enforced.** Reads returning per-project data intersect results with the projects the *calling
user* can browse (`getBrowsableProjectIds`, `src/lib/jira-api.js`, called as the user). This
includes the macro, `getProjectOverview` and the projects Rovo agent.

### 1.5 Admin permission caching

**Accepted risk.** The ADMINISTER answer is cached in memory per `accountId` for **60 seconds**
(`ADMIN_CHECK_TTL_MS`). Forge reuses warm invocations, so this spares a Jira round trip on polled
admin reads. **An admin whose permission is revoked keeps access for up to 60 seconds.** The cache
is keyed per account (covered by test) and does not survive a cold start.

### 1.6 Writes to Jira act as the person

**Enforced.** Every Jira write runs `asUser()` (§3.1), so Jira's own permission checks and issue
history apply to the admin who pressed the button, not to the app.

### 1.7 Tenant isolation

**Enforced.** Every table is keyed by `scope_key`, derived from the Forge installation context, so
one site's data is never readable from another's. Forge's own tenancy is Atlassian's boundary and
is trusted rather than verified here.

---

## 2. Audit logging and alerting

### 2.1 The audit log

**Enforced.** Privileged actions are recorded to the `audit_log` table (`recordAuditEvent`,
`src/lib/store/audit.js`): timestamp, actor `accountId`, action, outcome
(`allowed` / `denied` / `failed`), and a detail string.

**What is audited**
- Every **denial** by the admin guard.
- The **31 mutating admin actions** in `AUDITED_ADMIN_ACTIONS` (`src/resolvers/admin-guard.js`):
  scan control, snapshot cancel and clear, project-usage job control, inventory builds, report
  definition writes, `saveAdminConfig`, `migrateNamespaceKeys`, and the remediation actions
  `createRemediationEpic`, `applyRemediationVerification` and `syncRemediationNow`.

> **Open item.** `organiseRemediationHierarchy` creates Jira issues and re-parents epics but is
> **not** in `AUDITED_ADMIN_ACTIONS`. Add it, plus a test that fails when any resolver that
> writes to Jira is missing from the set.

**What is not audited, and why**
- **Admin reads** and **macro reads.** They are polled every 15 seconds during a scan; recording
  them would bury the events worth finding and spend the app's scarcest SQL quota.
- **Reads of the audit log itself.** That loop would bury the events worth finding.

**Properties**
- Audit writes **never block the action** (`safeAudit`). A broken audit table must not become an
  outage of every admin function, nor a denial-of-service anyone able to break the table could
  trigger. Failures surface as `audit.write_failed`.
- The audit log is **not** wiped by clearing a snapshot. An audit trail a privileged action can
  erase is not an audit trail.
- Retention: **180 days**, pruned by the weekly retention trigger (`pruneOldAuditEvents`).
- Viewer: Admin page → Configuration → Diagnostics → Audit log. The most recent 200 events,
  filterable by outcome, with denials called out above the table.

### 2.2 Denial-burst alerting

**Enforced, added 19 Oct 2026.** One denial is usually someone opening a link they shouldn't
have. **More than 5 denials in an hour** (`DENIAL_BURST_THRESHOLD`, `DENIAL_BURST_WINDOW_MS`,
`src/resolvers/admin-guard.js`) is the pattern of someone invoking admin resolvers directly.

- **Log event.** After each denial the guard counts the installation's denials in the trailing
  hour (`summarizeRecentDenials`, an index range read on `idx_audit_log_scope_at`). Past the
  threshold it logs **`security.denial_burst`** at `error`, with the denial count, the number of
  distinct accounts and the latest action. Point a Forge log drain alert at that event name.
- **Overview banner.** `getSecuritySignals` (admin-only, `src/resolvers/admin-tools.js`) applies
  the same rule, and `SecurityAlertBanner` shows a critical alert at the top of the Overview,
  polled every 5 minutes while visible. "Review denials" opens the audit log filtered to denials.
- **Bounded cost.** The alert fires at most once per 10 minutes per warm container per
  installation (`DENIAL_BURST_COOLDOWN_MS`), and the count query is skipped during that window. A
  flood of denials costs one audit insert each and nothing more.
- **Best-effort, never decisive.** A failed count never changes the guard's answer. A failed
  signals read shows "could not be checked" on the Overview rather than nothing — silence is not
  all-clear.

Covered by `src/resolvers.test.js` ("denial-burst alerting"), `src/lib/project-store.crud.test.js`
("audit log") and `SecurityAlertBanner.test.jsx`.

---

## 3. Data handling

### 3.1 Observatory writes to Jira through three admin actions

**Verified 19 Oct 2026.** Every other Jira call is a read; the remaining `POST` requests are
search, bulk-fetch, approximate-count and permission-check endpoints that use POST for the
request body.

| Action | What it changes in Jira | Runs as | Blocked by read-only mode | Audited |
|---|---|---|---|---|
| `createRemediationEpic` | Creates an epic and its tasks for a finding | Admin (`asUser`) | Yes | Yes |
| `applyRemediationVerification` | Reopens regressed tasks, closes fixed ones, withdraws stale ones as Won't Do, with a comment | Admin (`asUser`) | **No** | Yes |
| `organiseRemediationHierarchy` | Creates quarterly initiatives and puts epics under them | Admin (`asUser`) | Yes | **No** |

Each is an explicit, confirmed admin action; nothing changes Jira on a schedule. Any future
automatic mode (auto-close after a scan) must be an opt-in Config setting, off by default and
capped per run.

> **Open item.** `applyRemediationVerification` does not check `readOnlyMode`, so read-only mode
> does not stop it transitioning and commenting on issues. Add the same check the other two use.

Re-verify the write paths with:

```bash
grep -rnE 'method: "(POST|PUT|DELETE)"' src/ | grep -v '\.test\.'
grep -rn "asUser: true" src/resolvers/ src/lib/ | grep -v '\.test\.'
```

### 3.2 What is stored

| Data | Stored where | Personal | Kept for |
|---|---|---|---|
| Configuration inventory: fields, workflows, screens, schemes, rules, boards, filters, dashboards, Assets, estate values | Forge SQL | No | Until the next snapshot replaces it |
| Usage and issue **counts** per field and project; JQL strings | Forge SQL | No | 90-day usage window |
| Licensed users: `account_id`, display name, avatar URL, active flag, account type | Forge SQL `snapshot_users` | **Yes** | Until the next people snapshot |
| Licences per user and the access group that grants them | Forge SQL | **Yes** | Until the next people snapshot |
| Filter and dashboard owners; automation actors; user-picker field values | Forge SQL | **Yes** (account ids, some names) | Until the next snapshot |
| JSM customers and organisations | Counts and ids only, by design (the API returns PII) | Minimal | Pillar not built yet |
| Audit log | Forge SQL `audit_log` | Account id only | 180 days |
| Report jobs | Forge SQL | No | 7 days |
| Admin configuration | Forge KV, written only through the guarded, audited `saveAdminConfig` | No | Until changed |
| Issue summaries, descriptions, comments, attachments | **Never stored** | — | — |

Raw workflow-rule parameters are never stored either — scripts can contain secrets — only
references and a safe summary.

### 3.3 Personal data

- **No email addresses.** Jira Cloud runs in GDPR strict mode; `accountId` is the identifier
  everything joins on. Display names and avatar URLs are kept so the People tab renders without a
  per-row lookup.
- **Licence group membership is persisted** for the People pillar. (The 31 July version said group
  membership was never persisted; that predates the People pillar.) Macro-gate group lookups are
  still live and uncached beyond 60 seconds.

> **Open item — closed accounts.** Atlassian expects apps that store personal data to report the
> account ids they hold and erase closed accounts, through its personal data reporting API.
> Observatory does neither. A closed account's name and avatar remain until the next people
> snapshot overwrites them, and in any older snapshot versions still retained.

### 3.4 Data deletion

`clearSnapshot` (admin-only, type-to-confirm, blocked in read-only mode, audited) deletes all
derived snapshot data for the installation. See `RUNBOOK.md` for the procedure and what survives.

---

## 4. Rovo agents

**12 agents, 32 actions** (`manifest.yml`), one agent per pillar keyed
`observatory-<pillar>-expert`. Prompts live in `resource/agent/prompts/`.

- **Read-only.** Every action reads Observatory's own snapshot store and returns structured data.
  No action writes to Jira or to the store.
- **Honesty contract.** Every action returns the snapshot `refreshedAt` and an explicit
  `*-unavailable` status rather than an empty result. `agent-prompts.test.js` asserts every
  prompt carries the shared preamble and that the manifest and prompt files agree.
- **Project data is filtered.** The projects and fields agents return only what the caller can
  browse (§1.4).

> **Open item — no admin gate on the People and Access agents.** Rovo actions are not behind the
> admin guard. Any user who can use Rovo can ask the People agent about licensed users, licences
> and group membership, or the Access agent about permission, issue-security and notification
> schemes. Decide per agent: gate on Jira ADMINISTER (the admin page's rule), or document why the
> data is acceptable for every Rovo user.

> **Open item — indirect prompt injection.** Field, rule, filter and project names are written by
> people and reach the model verbatim in action results. Add a preamble rule that tool output is
> data, never instructions, and mark user-authored strings in action output.

> **Open item — preamble wording.** `_preamble.md` opens "Observatory is a read-only Jira
> governance app". The agents are read-only; the app is not (§3.1).

---

## 5. Input validation and output encoding

**Enforced.**

- Resolver payloads are validated through `src/lib/validate.js` — required strings, bounded
  integers, arrays and enums with explicit limits. Check new resolvers use it in review.
- All SQL is **parameterised** (`sql.prepare(...).bindParams(...)`). The one interpolated value,
  the audit `LIMIT`, is clamped to an integer between 1 and 1000 first.
- **OQL** is parsed against a fixed catalogue and evaluated in memory over the snapshot. It never
  reaches Jira or SQL. Input is capped at 2,000 characters.
- **JQL** is built from keys and ids Jira returned, with values quote-escaped (`jqlQuote`,
  `jqlString`). A malformed string produces a 400 or wrong counts, not data exposure.
- **No raw-HTML sinks.** There is no `dangerouslySetInnerHTML`, `innerHTML`, `eval` or
  `new Function` in `src/` or `static/src/`. Custom UI runs under Forge's default Content Security
  Policy; the manifest declares no relaxations.
- **CSV exports** neutralise formula injection (`neutralizeFormula`, `static/src/utils.js`):
  cells starting `=` `+` `-` `@`, tab or carriage return are prefixed.
- **Rich text sent to Jira** is ADF built from Observatory's own templates (`renderADF`).

Re-verify the HTML sinks with:

```bash
grep -rnE "dangerouslySetInnerHTML|innerHTML|eval\(|new Function" src static/src | grep -v '\.test\.'
```

---

## 6. Secrets and configuration

- **No secrets in the repository.** `gitleaks` runs on every CI build (`.github/workflows/ci.yml`).
  GitHub secret scanning and push protection are not enabled on this private repository.
- **The app holds no API keys or tokens.** All Jira and Confluence access is brokered by Forge.
- **No egress.** The manifest declares no `external.fetch` domains; every call goes through
  `requestJira` / `requestConfluence`. Adding one needs a security review and a line here.
- Admin configuration is in Forge KV, writable only through `saveAdminConfig`, which is
  admin-guarded and audited.
- **Read-only mode** (`readOnlyMode`) blocks scans, builds, `clearSnapshot`,
  `createRemediationEpic` and `organiseRemediationHierarchy`, independent of the permission
  check. It does **not** yet block `applyRemediationVerification` (§3.1).

**CI secrets** (`.github/SECRETS.md`):

| Name | Kind | Note |
|---|---|---|
| `FORGE_API_TOKEN`, `FORGE_EMAIL` | Secret | A personal Atlassian API token for one developer account. **Open item:** move to a dedicated deploy account, rotate every 90 days, record each rotation. |
| `CODECOV_TOKEN` | Secret | Coverage upload only |
| `SLACK_WEBHOOK_URL` | **Variable** | **Open item:** variables are not masked in logs. Move it to a secret and rotate the webhook. |

---

## 7. Permission scopes

The app requests **60 scopes** (`manifest.yml` is the authoritative list). Two allow changes:

- **`write:jira-work`** — remediation: creating epics and tasks, commenting, transitioning (§3.1).
- **`manage:jira-configuration`** — the broadest scope requested. Forge requires it to surface a
  `jira:adminPage` module; Observatory writes no configuration under it. Explain this on any
  install review.

The rest are reads, plus `storage:app`, `read:chat:rovo` and `read:confluence-content.summary`.

> **Open item — scopes ahead of their feature.** The 10 JSM scopes added 13 Oct 2026 (queues, SLAs,
> requests, request types, customers, organisations) serve the JSM probe and the planned JSM
> pillar. Until stage 1 ships, users grant permissions for a feature they cannot see. Ship it, or
> remove them.

**Closed.** The screen scopes flagged on 4 Aug are used by the Screens tab, which has shipped.

**Lessons that still apply** (from 11 Aug): granular scopes are **conjunctive** — an endpoint
needs every scope in its documented list, including ones whose names don't mention the feature.
`forge lint` checks that a scope exists, never that it is the right one. Read each endpoint's
documentation in full and confirm by probe against a real install. Adding a scope is a major
version: every install must be upgraded and an admin must accept it.

---

## 8. Dependencies and supply chain

- `npm audit --audit-level=high --omit=dev` runs on every CI build, but with
  `continue-on-error: true`: **it never fails a build.**
- Dependabot opens weekly grouped npm and GitHub Actions updates; majors of `@forge/*` are ignored.
- GitHub Actions are pinned by major tag (`@v7`), **not** by commit SHA.

**Runtime advisories, 19 Oct 2026: 9 (8 high, 1 moderate), 0 critical.** Up from 5 on 31 July.

| Package | Sev | Path | State |
|---|---|---|---|
| `undici` | high | `@forge/api` → `@forge/manifest` → `cheerio` | **Fixable** with `npm audit fix` (non-breaking) |
| `fast-uri` | high | `@forge/api` → `@forge/manifest` → `ajv` | **Fixable** with `npm audit fix` (non-breaking) |
| `brace-expansion` | high | `@forge/api` → `@forge/manifest` → `glob` | **Fixable** with `npm audit fix` (non-breaking) |
| `linkify-it`, `markdown-it`, `@atlaskit/adf-schema`, `@atlaskit/editor-prosemirror`, `prosemirror-view`, `@forge/bridge` | high / moderate | `@forge/bridge` → `@atlaskit/adf-schema` | No vendor fix. Client-side only; Observatory renders no user-authored ADF or markdown. Accepted. |

Development-only advisories (`vite`, `esbuild`) need a running dev server and never ship in the
Forge artifact; they clear with the Vite 8 migration, which needs `renameAdminHtml` rewritten
against rolldown's bundle API.

> **Open item.** Apply the three fixable updates, record an acceptance for each remaining
> advisory, and make the audit step fail on any new high advisory without one.

---

## 9. Delivery

| Control | State on 19 Oct 2026 |
|---|---|
| CI on every PR | Unit tests with coverage floors, ESLint + Prettier, Forge lint, frontend build, `npm audit`, gitleaks, behind one CI Gate job |
| Branch protection on `master` | **Not available.** The repository is private on a free GitHub plan. Required checks and CODEOWNERS review are advisory. |
| Deploy path | Push to `master` runs `forge deploy` to **development**. |
| Where the live site runs | **The live site (ford-advev, Jira and Confluence) is installed on the development environment** (v27), alongside the sandbox. Every merge to `master` reaches it with no staging step and no approval. |
| Staging and production | Staging: one sandbox install, v5. Production: no installs. GitHub has only a `development` environment, with no protection rules. |

> **Open items, highest priority on this list.** Install the live site from the **production**
> environment and promote deliberately (dev → staging → production). Move to a GitHub plan with
> branch protection: protect `master`, require the CI Gate, and require approval on the production
> environment.

---

## 10. Availability

- Crawls run at a concurrency of 3, widen their interval on 429 responses, and report the 429
  count in scan telemetry.
- Snapshots run on a Forge queue consumer (900-second timeout), sliced and resumable.
- New scan output is buffered and promoted only when complete; a partial scan never replaces the
  last good snapshot.
- Every pillar and Rovo action carries `refreshedAt`; an unbuilt pillar reads "not measured",
  never zero or healthy.
- **Not protected against:** an admin repeatedly starting scans, which spends Jira rate limit and
  Forge quota. The audit log records who did it.

---

## 11. Open items

In priority order. Each links to the section that explains it.

| # | Item | Section |
|---|---|---|
| 1 | Live site runs the development environment; every merge deploys to it | §9 |
| 2 | No branch protection on `master` | §9 |
| 3 | People and Access Rovo agents have no admin gate | §4 |
| 4 | `applyRemediationVerification` ignores read-only mode | §3.1 |
| 5 | `organiseRemediationHierarchy` is not audited | §2.1 |
| 6 | Slack webhook stored as an unmasked variable | §6 |
| 7 | 3 fixable runtime advisories; the audit step never fails | §8 |
| 8 | No closed-account handling for stored personal data | §3.3 |
| 9 | Indirect prompt injection into Rovo agents; outdated preamble wording | §4 |
| 10 | GitHub Actions pinned by tag, not SHA | §8 |
| 11 | No logger redaction for sensitive fields | §12 |
| 12 | 10 JSM scopes requested before their feature ships | §7 |
| 13 | Deploys use one person's long-lived API token | §6 |
| 14 | No threat model; no penetration test | §12 |

---

## 12. Measurements

Re-measure at every release and update this table in the same commit.

| Measure | 19 Oct 2026 | Target |
|---|---|---|
| Admin resolvers outside the guard | 0 | 0 |
| Unparameterised SQL statements | 0 | 0 |
| Raw-HTML sinks in the UI | 0 | 0 |
| External egress domains | 0 | 0 |
| CSP relaxations | 0 | 0 |
| Time for an admin revocation to take effect | ≤ 60 s | ≤ 60 s |
| Audit log retention | 180 days | ≥ 180 days |
| Alert on a burst of guard denials | Yes (§2.2) | Yes |
| Write-level scopes | 2 of 60 | ≤ 2, each justified |
| Scopes requested before their feature ships | 10 | 0 |
| Jira-writing actions missing from the audit log | 1 | 0 |
| Jira-writing actions not stopped by read-only mode | 1 | 0 |
| Rovo agents returning admin-domain data without an admin gate | 2 (People, Access) | 0, or each documented |
| Runtime advisories, high or critical | 8 high, 0 critical | 0 without a recorded acceptance |
| Merges that reach the live site without staging | 100% | 0% |
| Default branch protected with required checks | No | Yes |
| GitHub Actions pinned to a commit SHA | 0% | 100% |
| Closed-account erasure for stored personal data | None | Polled weekly |
| Bare `console.*` calls in backend code | 3 | 0 |

**What this checklist does not cover**, stated plainly so nobody reads absence as assurance:

- **No penetration test** has been performed.
- **No threat model** document exists.
- **No logger redaction.** The structured logger has no sensitive-field filter. Today the code
  logs ids and error context, not payloads; nothing stops a future call logging a JQL string or a
  display name.
- **Accessibility** is not a security control and is tracked separately (CONNECT-3865).

---

## Verification

The controls in §1 and §2 are covered by tests in `src/resolvers.test.js` ("admin authorization
guard", "denial-burst alerting", "audit trail"), `src/index.test.js` ("resolver handler
registries") and `src/lib/project-store.crud.test.js` ("audit log"). They assert the boundary
itself: the guard covers the entire registry, anonymous callers are rejected without a Jira round
trip, denials are audited and counted, the burst alert fires once per cooldown and never changes
the refusal, and `adminHandler` registers nothing unguarded.

```bash
npm test                 # full suite
npm run test:coverage    # with enforced thresholds
```
