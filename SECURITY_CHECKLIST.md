# Observatory — Security Checklist

Last verified: **31 July 2026** against `master`.

This document records what Observatory actually enforces, what it deliberately does
not, and where the accepted risks are. Every claim below is checkable against a named
file. If you change a control, change this file in the same commit — a checklist that
drifts from the code is worse than no checklist, because people quote it.

---

## 1. Authorization

### 1.1 Admin functions require Jira ADMINISTER

**Enforced.** Every function in `ADMIN_ONLY_FUNCTIONS` verifies the *calling user* holds
the Jira `ADMINISTER` global permission before running (`src/resolvers.js`,
`withAdminGuard`).

The check is applied by wrapping the whole registry at export, not by calling a helper
inside each function. A function added to the registry is guarded by construction —
there is no step anyone can forget.

- Permission is checked via `POST /rest/api/3/permissions/check` **as the user**, not as
  the app (`callerHasJiraAdmin`, `src/lib/jira-api.js`). Checking as the app would report
  the app's own permissions and answer nothing useful.
- Fails closed. A missing `accountId`, an API error, or an unparseable response all
  resolve to "not an admin".
- Denials are audited and logged at `warn` (`auth.denied`).

> **Why this exists.** The `jira:adminPage` module controls who can *see* the admin page.
> It does not control who can reach its resolver — an `invoke()` is an authenticated app
> endpoint, and module placement is a UI affordance, not an authorization boundary. Before
> 31 July 2026 there were **no permission checks anywhere in `resolvers.js`**, which meant
> `clearSnapshot`, `saveAdminConfig` and `migrateNamespaceKeys` were reachable by any
> authenticated user able to craft an invoke. This was the finding that prompted this
> document.

### 1.2 The macro resolver cannot reach admin functions

**Enforced.** Two registries, two handlers (`src/index.js`):

| Handler | Registers | Module |
|---|---|---|
| `handler` | `SHARED_RESOLVER_FUNCTIONS` only | Confluence macro |
| `adminHandler` | shared + `ADMIN_ONLY_FUNCTIONS` | `jira:adminPage` |

A function absent from the shared set is not merely hidden from the macro UI — it is not
registered on that resolver, so an invoke from the macro iframe fails to resolve rather
than executing.

`src/index.test.js` asserts that `adminHandler` registers **nothing** beyond those two
registries. Anything spread in directly would bypass the guard, and that test fails if
someone tries.

### 1.3 Macro viewer access is group-gated

**Enforced, fails open.** `checkMacroAccess` (`src/resolvers.js`) restricts macro
rendering to configured Jira groups when `macroAccess.restrictAccess` is on.

> **Accepted risk.** If the Jira group-lookup API call fails, access is **granted**
> (`src/resolvers.js`, "fail open — don't block on API error"). Rationale: the macro is
> read-only and shows no governance findings, so the cost of an unrelated Jira API blip
> blacking out a Confluence page for everyone was judged higher than the cost of briefly
> over-granting read access to a field catalog. An attacker who can reliably fail that
> specific API call could view the field inventory. **This is a deliberate choice, not an
> oversight.** If Observatory is ever extended to show sensitive data in the macro, this
> must be revisited first.

### 1.4 Project data respects the viewer's own permissions

**Enforced.** Reads returning per-project data intersect results against the projects the
*calling user* can browse (`getBrowsableProjectIds`, `src/lib/jira-api.js`, called as the
user). Two people looking at the same snapshot see different project lists if their
permissions differ.

### 1.5 Admin permission caching

**Accepted risk.** The result of the ADMINISTER check is cached in-memory per `accountId`
for **60 seconds** (`ADMIN_CHECK_TTL_MS`). Forge reuses warm invocations, so this spares a
Jira round trip on polled admin reads — `getIssueScanStatus` is polled every 15s for the
duration of a scan.

Consequence: **an admin whose permission is revoked retains access for up to 60 seconds.**
Cache is keyed per account, so one admin's result never authorises another user
(covered by test). Cache does not survive a cold start.

---

## 2. Audit logging

**Enforced.** Privileged actions are recorded to the `audit_log` table
(`recordAuditEvent`, `src/lib/project-store.js`).

Recorded per event: timestamp, actor `accountId`, action name, outcome
(`allowed` / `denied` / `failed`), and a detail string.

**What is audited**
- Every **denial** by the admin guard — a burst of these is the signal that someone is
  probing the resolver directly.
- Every **mutating** admin action: scan start/resume/cancel, snapshot cancel and clear,
  project-usage job control, report definition writes and deletes, `saveAdminConfig`,
  `migrateNamespaceKeys` (`AUDITED_ADMIN_ACTIONS`).

**What is not audited, and why**
- **Admin reads** (`getIssueScanStatus`, `getAdminOverview`, `getRqtIndex`, …). They are
  polled every 15 seconds during a scan; recording them would bury the handful of events
  anyone actually wants to find, and would add SQL writes to the app's most constrained
  quota. Reads expose no data the caller could not already obtain.
- **Macro reads.** Same reasoning; they are permission-filtered and read-only.

**Properties**
- Audit writes **never block the action** (`safeAudit`, `src/resolvers.js`). A broken audit
  table must not become an outage of every admin function, nor a denial-of-service that
  anyone able to break the table could trigger. Failures surface as `audit.write_failed`
  in the structured log.
- The audit log is **not** wiped by `clearAllSnapshotData`. An audit trail that a
  privileged action can erase is not an audit trail.
- Retention: **180 days**, pruned by the weekly retention trigger (`pruneOldAuditEvents`).
  Deliberately far longer than the 7 days kept for report jobs — "who cleared the snapshot
  in March" is usually asked long after March.

**Reading the audit log.** Admin page → Configuration → Audit log. Shows the most recent
200 events, filterable by outcome, with permission denials called out above the table —
a denial means an admin resolver was reached by a caller without admin permission, and
that should not require scanning a table to notice.

The viewer is admin-guarded like every other admin function, and reading it is
deliberately **not** itself audited: that loop would bury the events worth finding, and it
exposes nothing an admin could not already query directly.

---

## 3. Data handling

### 3.1 Observatory does not write to Jira

**Verified 31 July 2026.** Every Jira call is a read. The `POST` requests in the codebase
target only `/rest/api/3/search`, `/rest/api/3/search/jql`,
`/rest/api/3/search/approximate-count` and `/rest/api/3/permissions/check` — endpoints
that use POST for the request body, not to mutate. All writes go to the app's own
Forge SQL store.

Re-verify with:

```bash
grep -rn "method: \"POST\"" src/ | grep -v '\.test\.'
```

### 3.2 What is stored

Field metadata, per-project issue **counts**, JQL strings, timestamps, governance
findings, and RQT reference tokens. **Issue field values are not stored**, with one
deliberate exception: RQT reference tokens matching `RQT-<n>-<n>`, which are indexed to
make them queryable.

Issue *keys* are stored in the RQT index. No issue summaries, descriptions, comments,
or attachments are read into storage.

### 3.3 Personal data

- **`accountId` only.** The audit log stores the actor's Atlassian `accountId` and nothing
  else — no display names, no email addresses. The `accountId` is the durable identifier;
  resolving it to a person is a deliberate step someone takes in Jira.
- Group membership is queried live for access checks and never persisted.
- All tables are namespaced by `scope_key`, derived from the Forge installation context,
  so one site's data is never readable from another's.

### 3.4 Data deletion

`clearSnapshot` (admin-only, type-to-confirm, blocked in read-only mode) deletes all
derived snapshot data for the installation. See `RUNBOOK.md` for the full procedure and
the list of what survives.

---

## 4. Input validation

**Enforced.** Resolver payloads are validated through `src/lib/validate.js` —
`requireNonEmptyString`, `requireBoundedInt`, `requireArray`, `optionalEnum`, and
related helpers with explicit bounds.

All SQL uses **parameterised statements** via `sql.prepare(...).bindParams(...)`. No
user input is concatenated into SQL.

> **Note on JQL.** JQL strings are constructed from project keys and field IDs that come
> from the Jira API, not from user input. Project keys are quote-escaped when interpolated
> (`promoteIssueScanToSnapshotProjectUsage`). JQL is not SQL — a malformed string produces
> a Jira 400, not data exposure — but the escaping is there because a broken JQL string
> silently produces *wrong counts*, which is worse than an error.

---

## 5. Secrets and configuration

- **No secrets in the repository.** Verified by `gitleaks` on every CI run
  (`.github/workflows/ci.yml`).
- Observatory holds no API keys or tokens. All Jira access uses Forge's `asApp()` /
  `asUser()` authentication, brokered by the platform.
- Admin configuration is stored in Forge KV, writable only through `saveAdminConfig` —
  which is admin-guarded and audited.
- **Read-only mode** (`readOnlyMode`) blocks mutating operations including
  `clearSnapshot`, independent of the permission check.

---

## 6. Permission scopes

The app requests 15 OAuth scopes, all read-only against Jira. See `README.md` for the
full table and per-scope justification.

**`manage:jira-configuration` deserves specific attention on any install review.** It is
the broadest scope requested and it sounds like a write scope. Forge requires it to
surface a `jira:adminPage` module; Observatory exercises no configuration-write capability
under it. This is verifiable via §3.1.

> **Open item.** Three scopes — `read:workflow:jira`, `read:workflow-scheme:jira`,
> `read:status:jira` — support the workflow/status inventory backend, which currently has
> **no user interface**. Users are being asked to grant three permissions for a feature
> they cannot see. Either ship the UI or drop the scopes; leaving it as-is is a consent
> screen asking for more than the product delivers.

---

## 7. Dependencies and supply chain

- `npm audit` runs on every CI build (`.github/workflows/ci.yml`).
- Dependabot is enabled.
- **Open item, 31 July 2026:** GitHub reports 24 open Dependabot advisories on the default
  branch (1 critical, 12 high, 8 moderate, 3 low). These have not been triaged. This is the
  largest unaddressed item on this checklist.

---

## 8. What this checklist does not cover

Stated plainly so nobody reads absence as assurance:

- **No penetration test** has been performed.
- **No threat model** document exists.
- **No formal review** of the Forge platform's own tenancy isolation — that is Atlassian's
  boundary, and is trusted rather than verified here.
- **Accessibility** is not a security control and is tracked separately (CONNECT-3865).
- **Rate limiting** protects Jira and the app's own quota, not against a malicious
  authenticated admin. An admin can start scans repeatedly; the audit log records who did.

---

## Verification

The controls in §1 and §2 are covered by tests in `src/resolvers.test.js`
("admin authorization guard", "audit trail") and `src/index.test.js`
("resolver registration"). Those tests assert the boundary itself — that the guard is
applied to the entire registry, that anonymous callers are rejected without a Jira round
trip, that denials are audited, and that `adminHandler` registers nothing unguarded.

```bash
npm test                 # full suite
npm run test:coverage    # with enforced thresholds
```
