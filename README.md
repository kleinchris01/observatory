# Observatory — Jira estate governance

[![Coverage](https://img.shields.io/badge/coverage-~84%25-brightgreen)](#testing)
[![Tests](https://img.shields.io/badge/tests-3629%20passing-brightgreen)](#testing)

<!--
  These badges are static and updated by hand — run `npm run test:coverage` and
  edit them. CI does upload to Codecov (see .github/workflows/ci.yml), so a
  dynamic badge is possible; these are deliberately static so the numbers can't
  drift out from under the README's prose without someone noticing.

  The enforced floor lives in vitest.config.js under coverage.thresholds and is
  set just below the actuals, so CI fails if coverage drops. Treat that as the
  source of truth; these badges are a summary of it.
-->

Observatory gives a Jira Cloud admin a live, searchable inventory of **sixteen
configuration pillars** — from custom fields to agile boards to permission
schemes — enriches each with usage data, runs heuristic governance findings, and
rolls the whole estate into one weighted health score. An AI agent per pillar
answers questions against the latest snapshot, and a finding can be pushed to
Jira as an epic-plus-tasks remediation ticket.

It ships as two Forge surfaces against one backend:

- a **Confluence macro** for browsing fields and building reports, embeddable in any page
- a **Jira admin page** for running scans, reviewing every pillar's findings, tuning the score, and creating remediation work

The split is deliberate. Governance findings, configuration, job control and the
one write path are admin-only; the macro is read-and-report. A macro viewer never
sees a finding badge or a control that mutates anything.

---

## What problem it solves

A Jira Cloud site accumulates configuration for years, usually faster than anyone
retires it, and usually across more than one admin. The questions that go
unanswered:

- Which of the hundreds of custom fields, filters, dashboards and boards are actually used, and on which projects?
- What breaks if this filter's owner is deprovisioned — which boards, which dashboards, which automation rules?
- Which automation rules can move every project at once, and which store a credential in plaintext?
- Which statuses can no workflow scheme reach? Which permission schemes open browse to anyone?
- Is the estate getting tidier or messier since the last scan?
- And when a finding is real: how does it become work in the admin team's backlog?

Observatory answers these by snapshotting each pillar's configuration, joining the
pillars to each other, scoring the result against tunable targets, and — for the
findings that matter — creating the Jira tickets to fix them.

---

## The sixteen pillars

| Pillar | What it inventories | Signature findings |
|---|---|---|
| **Fields** | Every custom field, its contexts and per-project usage | Duplicate names, global context with no data, orphaned, stale, undocumented-but-busy |
| **Filters** | Saved filters, their JQL, shares and subscriptions | No live owner, shared with everyone, broken project scope, subscribed-but-unread |
| **Dashboards** | Dashboards, gadgets and the filters they resolve to | No live owner, editable by anyone, empty, gadget on a deleted filter |
| **Workflows & statuses** | Workflow schemes, the status catalogue, scheme→project map | Duplicate statuses, statuses no scheme reaches, rule-only statuses, category imbalance |
| **Screens** | Screens, tabs, fields, screen schemes and their operation mapping | Unreachable screens, dangling scheme operations, empty screens |
| **Issue types** | The type catalogue, hierarchy and issue-type schemes | Orphan types, unused schemes, near-duplicate names, broken hierarchy |
| **People** | The licensed-user roster, groups, and the cross-pillar ownership graph | Deactivated licence holders, filters/dashboards/rules owned by gone accounts |
| **Assets (CMDB)** | JSM Assets object schemas, object types and attributes (JSM Premium) | Dead schemas, bare object types, reference attributes pointing at a removed type |
| **Permission schemes** | Permission schemes, their grants and project assignments | Least-privilege violations (anyone-browse, group project-admin, named individuals), unused |
| **Issue security** | Issue-security schemes and levels | Levels with no members, schemes with no levels, unused |
| **Notification schemes** | Notification schemes, their events and recipients | Events routed to a named individual, unused schemes |
| **Project roles** | Per-project role actors and the site-wide role catalogue | Empty administrator roles, off-roster user actors, global-permission probe |
| **Priorities & resolutions** | The two global value lists every issue draws on | Near-duplicate names, missing default |
| **Boards** | Agile boards, their backing filter and column→status mapping | Broken / ownerless backing filter, column mapping no status, unmapped statuses |
| **Automation** | Every rule's JSON (redacted), with a cascade graph and blast-radius score | Plaintext credentials, self-triggering loops, cascade chains, estate-wide blast radius |
| **Projects** | Every project's resolved schemes, adoption and configuration weight | Fell off / never adopted, over-configured, bespoke single-project schemes |

Every new pillar is wired into the health score (`computeSiteHealth`), not just an
inventory tab — that is enforced by convention and by test.

---

## Surfaces

### Confluence macro — three tabs

**Inventory.** A paginated, searchable list of every Jira custom field. Each card
shows the field ID (click to copy), name, type, admin description, configured and
active project counts, and total populated issues. Expanding a card reveals the
per-project usage breakdown with JQL deep-links. Filters: free-text, field type,
sort order, usage state, max-issues cap.

**Projects.** Every project with cached field usage: the fields populated there,
paginated and filterable, two charts, and a JQL deep-link per field/project pair.

**Report.** A cross-field comparison report for any set of selected fields,
paginated by type, filterable, nameable, saveable, exportable to CSV.

Governance findings are *not* shown in the macro — the macro is for browsing and
reporting.

### Jira admin page — one tab per pillar, plus the operational tabs

**Overview** rolls up the health score, its per-pillar breakdown, and the
cross-pillar signals worth acting on now. **Field Browser** and **Project Usage**
are the macro views with the admin-only additions (finding badges, findings
filter, per-field refresh, the workflow scheme governing each project). The
**Projects** tab is a field-browser-style list of every project with metric chips,
range filters and expand-in-place detail.

The pillar tabs — **Workflows, Screens, Issue Types, Access, People, Assets,
Priorities, Boards, Automation, Dashboards, Filters** — each render their
inventory, their derived findings, and the cross-pillar joins that pillar
participates in. Every entity carries an **Ask Rovo** affordance scoped to it.

**Changes** is the configuration change-history timeline — a per-pillar digest
diffed pass over pass. **Reports** and **Scans** are report generation and the
data-pipeline control surface (five sub-views over snapshot, universe scan, quick
scan, RQT index and field-usage jobs, each with live progress and start/cancel).
**Configuration** holds the governance thresholds, the v2 scoring targets, macro
access, read-only mode, retention, and the **Remediation** project setup.

---

## The site health score

`src/lib/health-score.js`. The number is a way into the findings, not a finding
itself: every dimension carries its own score, the value it was derived from, and
a sentence naming what would move it.

Two scoring models coexist:

- **v1 — `scoreFromRate(rate, tolerance)`.** A bad rate against a floor it bottoms
  out at. Most dimensions still use it. Every tolerance is admin-tunable from the
  Configuration tab (`DEFAULT_HEALTH_TOLERANCES`).
- **v2 — `scoreAgainstTarget(value, {target, floor, direction})`.** Score against
  a *definable good state*, not just a bad one. Three parts:
  - **level** — 100 at the target, 0 at the floor, linear between, in whichever
    direction is "good" (reuse and coverage go up; exposure and sprawl go down).
  - **blast weight** — `blastMultiplier(affected, estate)` scales the dimension's
    weight in the roll-up from 0.5× to 2× by the share of issues / users /
    dependents it touches, so the same finding rate on a bigger blast radius moves
    the score more. Same shape as the automation blast-radius reach factor.
  - **direction** — `directionAdjust` folds in a small capped nudge from the change
    since the last scan (`snapshot_health_dimensions`-style history stored inside
    `health_history`), with regression penalised harder than improvement is
    rewarded.

  The `{target, floor}` bands are admin-tunable (`DEFAULT_HEALTH_TARGETS`, the
  Configuration tab's **Scoring targets** section). Dimensions on v2 today:
  least-privilege conformance, board backing integrity, process standardisation,
  security-level integrity, project admin-role coverage, screen reachability —
  with the remaining A-bucket metrics migrating pillar by pillar.

The headline is a weighted mean over **pillars**, not over dimensions, so adding a
rule to a pillar changes how precisely it is measured, never how much it counts
(`PILLAR_WEIGHTS`). A pillar with nothing scored keeps `score: null` and is
excluded — "we have not looked" is never scored as zero.

---

## Rovo AI agents

Eleven agents, one per pillar, keyed `observatory-<pillar>-expert`: Field,
Automation, Workflow, Issue Type, Access, People, Assets, Priorities, Screen,
Change and Project. Each has the same shape:

- **`search-<pillar>`** — ranked matches for a name or phrase
- **`inspect-<pillar>`** — the full governance detail for one entity
- **`<pillar>-impact`** — "what references / breaks if I change this", where the pillar can answer it

Every action returns the snapshot's `refreshedAt` and an explicit
`*-unavailable` status rather than an empty result. Agent keys are listed in
`ROVO_AGENTS` (`static/src/utils.js`) and must match the `rovo:agent` entries in
`manifest.yml`; prompt files live in `resource/agent/prompts/`, each starting from
a shared preamble. In the UI every "Ask Rovo about …" button is the shared
`<AskRovo>` primitive, and its tooltip names the agent and states that Rovo
answers from the latest snapshot and never changes Jira. All read-only — the agent
layer holds no `write:*` scope.

The Project agent is permission-scoped: it only answers for projects the calling
user can browse.

---

## Remediation ticketing — the one write path

Every other data path in the app is read-only against Jira. Remediation ticketing
is the exception, and it is fenced accordingly.

From a governance finding, an admin can create **one epic** in a configured
project and **a task per item to fix** underneath it. The playbook for each
finding (`src/lib/remediation-playbooks.js`) supplies the remediation *strategy*
in the epic and step-by-step instructions in each task, rendered to ADF at create
time (`src/lib/adf.js`).

- Created **as the calling admin** (`api.asUser()`), so the tickets carry their
  reporter and are checked against their permissions.
- **Idempotent** — the epic is keyed on the finding and a task on the item, in
  `remediation_tickets`, so re-running only fills in what is missing.
- **Blocked in read-only mode**, and **audited** like every other privileged
  action.
- The synchronous create is bounded (20 tasks per call, with the remainder
  reported); a queued job for large findings and a status-sync trigger follow.

Requires `write:jira-work` and `read:issue:jira` — the only write scope the app
holds, added in a major version bump. The remediation project, epic/task issue
types and default assignee are set in Configuration → Remediation; nothing is
created until a project is configured.

---

## Architecture

```
Confluence page                      Jira admin settings
  └── macro iframe (React SPA)         └── admin page iframe (React SPA)
        static/dist                          static/dist-admin
            │                                    │
            └──── @forge/bridge invoke() ────────┘
                        │
Forge backend (Node.js 22)
  ├── resolver           index.handler        macro invoke()  — SHARED_RESOLVER_FUNCTIONS only
  ├── admin-resolver     index.adminHandler   admin invoke()  — shared + ADMIN_ONLY_FUNCTIONS
  ├── snapshot-consumer  index.consumeSnapshot        queue consumer, 900s timeout
  ├── auto-snapshot      index.autoSnapshotCheck      scheduled trigger, daily
  ├── quick-scan-scheduler index.quickScanScheduleCheck  scheduled trigger, hourly
  ├── retention-cleanup  index.runRetentionCleanup    scheduled trigger, weekly
  ├── rovo-*             one handler per Rovo action
  └── sql-migrate        index.runProjectStorageMigrations

Storage
  └── @forge/sql (MySQL) — 82 tables, 151 migration steps
```

Two resolvers, one codebase. `SHARED_RESOLVER_FUNCTIONS` are registered on both
handlers; `RAW_ADMIN_ONLY_FUNCTIONS` only on `adminHandler`, wrapped at export by
`withAdminGuard` (verifies the *calling user* holds Jira `ADMINISTER`, fails
closed) and `withAuditTrail` (records the mutating ones). A function omitted from
the shared set is not merely hidden from the macro UI — it is not registered on
that resolver at all, so a crafted `invoke()` from the macro iframe fails to
resolve rather than executing.

### Storage layer

`src/lib/store/` is split by domain — `core.js` (sql handle, schema, migrations,
shared helpers; imports none of the others), then `snapshot.js`, `scan.js`,
`workflow.js`, `rqt.js`, `reports.js`, `audit.js`, `health.js`, `filter.js`,
`dashboard.js`, `access.js`, `drift.js`, `estate.js`, `boards.js`,
`automation.js`, `remediation.js`. `src/lib/project-store.js` is a compatibility
barrel re-exporting all of them. One arrow, no cycles.

**Every `ADD COLUMN` migration is written `IF NOT EXISTS`, without exception.**
The `CREATE TABLE` constants describe each table's *current* shape, so a column
added later appears in both the CREATE and a later ALTER; on a fresh database the
CREATE already produced the column and a bare ALTER would fail with a
duplicate-column error and halt the runner. `project-store.schema.test.js`
enforces the rule, and that **every `DELETE` carries a `scope_key` predicate** —
in a shared Forge database an unscoped delete destroys another tenant's data.

### Data pipeline

Every pillar builds its own snapshot, versioned independently, on the
`inventory-snapshot-queue` consumer (900s timeout). Every long stage follows the
same contract: write a resume token, re-enqueue, pick up where it left off —
nothing depends on finishing inside one invocation.

- **Field snapshot** — the custom-field catalogue, contexts and configured scopes.
- **Per-field deep scans** — one paginated issue search per field for an exact
  populated count, with `latest_field_change_at` from the changelog.
- **Universe Scan** — the cheaper alternative on a large site: one pass over the
  issue corpus with partitioned parallel workers, tallying which fields are
  populated on which projects, plus per-status and per-project totals. Trades the
  changelog dates for a flat cost in catalogue size.
- **Quick Scan** — the same machinery narrowed to issues updated in the last 24h.
- **RQT index** — the `RQT-<n>-<n>` reference-token index behind the per-value
  drilldowns.
- **Pillar structural scans** — workflow, screen, issue-type, people, assets,
  access, estate, board and drift snapshots, each queued rather than run in a
  resolver because walking every project's schemes does not fit a 25s invocation.
- **`drift` stage** — digests each pillar's structural config and diffs it pass
  over pass into `config_change_log`, backing the Changes timeline.

Jira API calls go through an adaptive concurrency controller: starts at a
configured concurrency and interval, backs off exponentially on 429 (honouring
`Retry-After`), eases back on success streaks, and hard-times-out a hung call so a
slot is never held indefinitely.

### Cross-pillar joins

The joins are the product. Field → filter → dashboard → board resolves exactly, so
a field card can name the dashboards that break if the field goes and a board can
name the filter that backs it. User references (owned filters/dashboards/rules,
automation actor and user-picker field values) are wired both directions between
People and every pillar that names an account. The automation analysis feeds the
workflow and field pillars so "this status is unreachable" is not asserted when a
rule transitions into it.

### Permission filtering

Project-level data is filtered by the *viewer's* Jira permissions, not the app's.
Reads that return per-project data call Jira as the user to establish which
projects they can browse, then intersect the cached results — two people looking
at the same snapshot see different project lists if their permissions differ.

### Error handling

Two helpers in `src/lib/logger.js` replace anonymous `.catch(() => value)`:
`fallbackOn(event, fallback, context)` (`warn` — a read degraded to a default) and
`ignoreWith(event, context)` (`debug` — a cleanup write failed while another error
was already being handled). Degrading gracefully is right; degrading *invisibly*
is what turns a bug into a mystery.

---

## Tech stack

| Layer | Technology |
|---|---|
| Platform | Atlassian Forge — Custom UI macro + `jira:adminPage` + `rovo:agent` |
| Runtime | Node.js 22.x |
| Frontend | React 18, Vite 5 (dual bundle: `static/dist`, `static/dist-admin`) |
| Storage | `@forge/sql` (MySQL), `@forge/kvs` for a few bounded documents |
| Queue | `@forge/events` |
| AI | Atlassian Rovo agents + actions |
| Tests | Vitest (Node + jsdom projects), `@vitest/coverage-v8` |
| CSS | Custom design system with CSS variables — no component library |
| Charts | Recharts · Icons | Phosphor |

---

## Permissions

49 scopes. All but two are read-only against Jira.

`manage:jira-configuration` is required by Forge to surface a `jira:adminPage`; it
is not a capability the app exercises. `write:jira-work` and `read:issue:jira` are
the remediation-ticketing write path described above — every use is behind an
explicit button, gated by read-only mode, and audited. The rest are granular reads
for the pillars: field / context / screen / workflow / status / issue-type /
filter / dashboard / permission-scheme / issue-security / notification-scheme /
project-role / group / user / resolution / priority / CMDB / agile-board reads,
plus `read:confluence-content.summary` for the macro host page and
`read:chat:rovo` for the agents.

Granular scopes are **conjunctive** — an endpoint needs every scope in its list,
not any one of them. `manifest.yml` documents, per scope, which endpoint requires
it and why.

---

## Development

```bash
npm install
npm run build       # dual Vite build → static/dist (macro) + static/dist-admin (admin page)
forge deploy        # deploy to development environment
forge install       # install on a site (first time only)
```

`forge deploy` does **not** rebuild the Vite bundles — always `npm run build`
first, or use `npm run deploy`, which chains both. A scope change triggers
`MAJOR_VERSION_RULE`: deploy with `forge deploy --approve MAJOR_VERSION_RULE` and
run `forge install --upgrade` on each install.

Backend entry point is `src/index.js`; SQL migrations live in
`src/lib/store/core.js`.

---

## Testing

```bash
npm test              # unit + component tests (backend and frontend projects)
npm run test:backend  # backend only (Node)
npm run test:frontend # frontend only (jsdom, @forge/bridge aliased to a mock)
npm run test:coverage # with coverage report
```

3,629 tests across 98 files, colocated with their source. Coverage thresholds are
enforced in `vitest.config.js` and set just below current actuals, so they ratchet
— coverage can rise freely, a drop fails the run. Per-file floors pin the modules
whose failure modes are hardest to diagnose in production: `src/lib/jira-api.js`
(rate limiting, retry, cursor pagination), `src/index.js` (the queue job router),
`src/lib/report-engine.js`, and `src/resolvers.js`, which holds the authorization
boundary.

The storage layer is tested directly against a mocked Forge SQL — query shape, row
mapping, and that every `DELETE` carries a `scope_key` predicate — because no test
that mocks `project-store` wholesale could catch an unscoped delete.

`ConfigTab.parity.test.jsx` checks the Configuration page and the scoring
algorithm against each other: every tolerance and every target the score reads has
a control on the page, and every control on the page changes a number.

---

## Delivery

- Open a PR; never commit straight to `master`. CI gating and CODEOWNERS only engage on a PR.
- Push to `master` auto-deploys to **development** only. Staging and production are manual (`npm run deploy:staging` / `deploy:production`, which run the full suite first).
- The dev deploy workflow has no concurrency group — merging PRs in quick succession races it against itself. Let each dev deploy finish before merging the next.
- Do not merge a stacked PR with `--delete-branch` while another PR still targets its branch; retarget the successor to `master` first.

---

## App identity

- **App ID:** `ari:cloud:ecosystem::app/c11559cd-90ed-43a7-9a9b-80866237cd15`
- **Macro key:** `atlasiq-custom-field-governance-macro`
- **Admin page key:** `atlasiq-observatory-admin`
- **Queue:** `inventory-snapshot-queue`
- **Package version:** `0.1.1` (the Forge app version is independent and bumps on every deploy)
