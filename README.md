# Observatory — Jira Custom Field Governance

[![Coverage](https://img.shields.io/badge/coverage-63.6%25-yellow)](#testing)
[![Tests](https://img.shields.io/badge/tests-934%20passing-brightgreen)](#testing)

<!--
  These badges are static and updated by hand — run `npm run test:coverage` and
  edit them. CI does upload to Codecov (see .github/workflows/ci.yml), so a
  dynamic badge is possible; these are deliberately static so the numbers can't
  drift out from under the README's prose without someone noticing.

  The enforced floor lives in vitest.config.js under coverage.thresholds and is
  set just below the actuals, so CI fails if coverage drops. Treat that as the
  source of truth; these badges are a summary of it.
-->

Observatory gives Jira admins a live, searchable inventory of every custom field on their site — with per-project usage data, automated governance findings, multi-field reports, workflow and status inventory, and an AI assistant.

It ships as two Forge surfaces against one backend:

- a **Confluence macro** for browsing fields and building reports, embeddable in any page
- a **Jira admin page** for running scans, reviewing governance findings, and tuning configuration

The split is deliberate. Governance findings, threshold configuration, and job control are admin-only; the macro is read-and-report. A macro viewer never sees a finding badge or a control that mutates state.

---

## What problem it solves

Jira sites accumulate hundreds of custom fields over time. Most admins have no easy way to answer:

- Which fields are actually being used, and on which projects?
- Are there fields configured globally with zero populated issues?
- Are there duplicate field names that should be consolidated?
- Which fields carry the most risk if changed or deleted?

Observatory answers all of these by snapshotting the Jira field catalog, enriching it with live usage data, running heuristic governance analysis, and surfacing the results in a structured UI. It replaced a manual process of crafting and copying JQL queries into spreadsheets.

---

## Features

### Confluence macro — three tabs

**Inventory.** A paginated, searchable, filterable list of every Jira custom field on the site. Each card shows the field ID (click to copy), name, type, admin description, configured and active project counts, and total populated issues. Expanding a card reveals the per-project usage breakdown with JQL deep-links.

Filters: free-text search, field type, sort order, project usage state, max issues cap.

**Projects.** Switch between every project that has cached field usage. Per project: the fields with populated values there, paginated and filterable; two charts (top fields by issue count, field type distribution); and a JQL deep-link for every field/project pair.

**Report.** Generate a cross-field comparison report for any set of selected fields, paginated by field type and filterable by type or project name. Reports can be named and saved for later recall, and exported to CSV from the generated report.

Governance findings are *not* shown in the macro — see the surface split above. The macro is for browsing and reporting.

### Jira admin page — seven tabs

**Overview.** Dashboard summarising snapshot state, catalog size, and the governance findings breakdown.

**Field Browser.** The Inventory view plus everything admin-only: finding badges on each card, a findings filter bar (admin attention / risk / cleanup / standardize), and per-field usage refresh.

**Project Usage.** The Projects view with admin controls, including the workflow scheme governing each project and its sibling projects on that scheme.

**Workflows.** Workflow scheme and status inventory, plus derived governance findings — duplicate statuses, statuses no scheme can reach, and per-scheme category balance. See below.

**Reports.** Report generation and saved-report management. Exports carry each project's workflow scheme as a second header row, so a field populated in one project but not its scheme-siblings is visible in the CSV.

**Scans.** Five sub-views over the data pipeline — Snapshot, Universe Scan, Quick Scan, RQT Index, and Field Usage Jobs — each with live progress, job tokens, per-item logs, and start/cancel/restart control.

**Configuration.** Governance thresholds, macro access groups, read-only mode, and retention settings.

### Workflow & status inventory
Which schemes exist, which projects each governs, and the full status catalog. Built by `src/lib/workflow-engine.js` on its own snapshot version, independent of the field snapshot, and queued to the consumer rather than run in a resolver — walking every project's scheme does not fit in a 25-second invocation.

**Governance findings** (`src/lib/workflow-insights.js`, pure functions over loaded rows):

- **Duplicate statuses** — three kinds, reported separately because they carry different confidence: the same name defined more than once, names differing only by spacing (`Back Log` / `Backlog`), and single-character spelling variants (`Cancelled` / `Canceled`). Enumerated series are deliberately excluded — `CP3/CP4/CP5 Sign Off Complete` are one edit apart and completely distinct, so a pair that becomes identical once digits are removed is never grouped.
- **Unreachable statuses** — defined on the site but not reachable from any scheme.
- **Scheme balance** — per-scheme category distribution, flagging schemes with no Done status, In Progress-heavy shapes, and uncategorised statuses that break Jira roll-up reporting.

**Two usage measures per status**, deliberately kept separate because they are produced by different jobs and refresh independently:

| Measure | Source | Meaning |
|---|---|---|
| Currently in | universe scan | Issues sitting in the status now |
| Ever been in | JQL `status WAS <id>` | Issues that have ever entered it |

The gap between them is the signal: a status with no current issues but tens of thousands historically is a stage people escaped, not one nobody uses. `WAS` is queried by status ID, never name — a site with `Done` defined five times would give `status WAS "Done"` one meaningless total. It is also why this does not need a changelog crawl: one approximate-count per status is minutes, where re-reading 300k+ issues with `expand=changelog` is hours.

**A status whose usage was never measured is reported as unknown, never as zero.** Zero is what marks a status safe to delete, so it is only ever asserted when a scan actually observed the catalog.

### Rovo AI agents
One Rovo agent per governance pillar — Field, Workflow & Status, Issue Type, Screen,
Access, People, Assets, Priorities & Resolutions, Automation, Configuration Change and
Project — plus the two that predate the pattern. Each agent has the same shape:

- **`search-<pillar>`** — ranked matches for a name or phrase
- **`inspect-<pillar>`** — the full governance detail for one entity
- **`<pillar>-impact`** — "what references / breaks if I change this" (where the pillar can
  answer it)

Every action returns the snapshot's `refreshedAt` and an explicit `*-unavailable` status
rather than an empty result. All agent keys are `observatory-<pillar>-expert` and are
listed in `ROVO_AGENTS` (`static/src/utils.js`); prompt files are in
`resource/agent/prompts/`, each starting from the shared preamble. In the UI, every
"Ask Rovo about …" button is the shared `<AskRovo>` primitive — its tooltip names the
agent and states that Rovo answers from the latest snapshot and never changes Jira. All
read-only; no `write:*` scope.

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
  ├── resolver           index.handler        macro invoke()  — shared functions only
  ├── admin-resolver     index.adminHandler   admin invoke()  — shared + admin-only
  ├── snapshot-consumer  index.consumeSnapshot        queue consumer, 900s timeout
  ├── auto-snapshot      index.autoSnapshotCheck      scheduled trigger, daily
  ├── retention-cleanup  index.runRetentionCleanup    scheduled trigger, weekly
  ├── rovo-search-fields index.rovoSearchFields       Rovo agent action
  ├── rovo-inspect-field index.rovoInspectField       Rovo agent action
  └── sql-migrate        index.runProjectStorageMigrations

Storage
  └── @forge/sql (MySQL) — 23 tables, 49 migration steps
```

Two resolvers, one codebase. `SHARED_RESOLVER_FUNCTIONS` are registered on both
handlers; `ADMIN_ONLY_FUNCTIONS` only on `adminHandler`. A function omitted from
the shared set is not merely hidden from the macro UI — it is not registered on
that resolver at all, so a crafted `invoke()` from the macro iframe fails to
resolve rather than executing. New mutating functions belong in the admin set.

### Module layout

The two largest modules were split by domain; both keep a compatibility entry point so
existing imports and tests are untouched.

```
src/lib/store/          storage layer, split by domain — import these directly in new code
  core.js               sql handle, schema, migrations, shared helpers  (no domain imports)
  snapshot.js           field snapshots and per-project usage
  scan.js               universe and delta scan state
  workflow.js           schemes, status catalog, usage counts
  rqt.js                the RQT value index
  reports.js            saved reports and async report jobs
  audit.js              privileged-action record
src/lib/project-store.js   barrel re-exporting the above (compatibility, not the entry point)

static/src/tabs/        one module per admin tab, components individually exported
static/src/components/admin/   primitives, JobsPanel, AuditLogPanel
static/src/components/ui.jsx   shared presentation primitives used across tabs
static/src/admin.jsx    AdminApp composition only
```

Domain modules import from `core.js`; `core.js` imports none of them. One arrow, so there
are no cycles to reason about.

### Error handling

Two helpers in `src/lib/logger.js` replace anonymous `.catch(() => value)` handlers, and
the distinction between them is deliberate:

| Helper | Level | Use when |
|---|---|---|
| `fallbackOn(event, fallback, context)` | `warn` | A read degrades to a default. The caller is about to treat a fabricated value as real data. |
| `ignoreWith(event, context)` | `debug` | A cleanup write fails while another error is already being handled and there is nothing further to do. |

Anonymous handlers are not acceptable in new code. Degrading gracefully is right;
degrading *invisibly* is what turns a bug into a mystery — a failed count once rendered as
a confident `Site-wide issue count: 0` on a site holding 317,907 issues. Silence is still
available, but it has to be named, which forces the author to say what was lost.

### Data pipeline

**1. Snapshot build**
User clicks "Build snapshot" → job enqueued on `inventory-snapshot-queue` → `consumeSnapshot` calls the Jira REST API to fetch all custom fields, their contexts, and configured project scopes → results written to `snapshot_fields` and `snapshot_meta` in batches.

If the consumer hits the 900 second timeout, it writes a resume token and re-enqueues itself. The next invocation picks up where it left off. This makes the snapshot resumable across arbitrarily large field catalogs.

**2. Field summary deep scans**
After the snapshot, per-field deep scans can be triggered from the UI. Each field runs a paginated Jira issue search (`field_summaries`) to count exactly how many issues have a populated value for that field, across all projects. These also use resume tokens for large fields.

**3. Project usage jobs**
A further enrichment layer that joins field usage data to individual projects. Results land in `snapshot_project_usage` — one row per field/project pair with issue count, JQL, and timestamps. Each field gets its own job, tracked in `field_summaries`. This is the only path that populates `latest_field_change_at`, which the staleness finding depends on.

**4. Universe Scan**
The alternative to per-field scanning, and much cheaper on large sites. Instead of one issue search per field, it walks the issue corpus once with parallel workers over partitioned key ranges, tallying which fields are populated on which projects as it goes. Workers buffer counts into `issue_scan_buffer` and flush periodically; a promote step folds the buffer into `snapshot_project_usage`.

Per-field scanning costs one search per field (hundreds of round trips); the Universe Scan costs one pass over the issues regardless of catalog size. The tradeoff is that it does not fetch changelogs, so `latest_field_change_at` stays `NULL` for rows it produces.

**Quick Scan** is the same machinery narrowed to issues updated in the last 24 hours — a cheap top-up between full passes.

**5. RQT index**
Builds the RQT token index — which `RQT-<n>-<n>` reference tokens appear in which field values on which issues — backing the per-value frequency and drilldown views. Two fields (`issuelinks`, `parent`) are skipped because their values describe *related* issues rather than the issue being indexed, and a dedup rule collapses tokens duplicated across four known overlapping fields.

**6. UI reads**
All reads go through `invoke()` to a resolver, which queries SQL and returns paginated, filtered, sorted results. No data is held in client state between page loads.

Every long-running stage above follows the same resumability contract: write a resume token, re-enqueue, pick up where you left off. Nothing depends on completing inside one invocation.

### Rate limiting

Jira API calls go through an adaptive concurrency controller. It starts at a configured concurrency and request interval, backs off exponentially on 429s (honouring `Retry-After` when present, with a cooldown window), and eases the interval back down on streaks of success. Requests carry a hard timeout so a hung call can't hold a concurrency slot indefinitely — slots are released on the failure path as well as the success path.

State is module-level within a single consumer invocation, so each invocation re-learns the site's tolerance rather than inheriting a stale estimate.

### Permission filtering

Project-level data is filtered by the viewer's own Jira permissions, not the app's. Reads that return per-project data call Jira as the user to establish which projects they can browse, then intersect the cached results against that set — so two people looking at the same snapshot see different project lists if their permissions differ.

---

## Governance findings

Computed by `buildGovernanceFindings()` in `src/lib/analysis.js` and stored as a JSON blob per field. Each finding has a category, severity, title, and detail string. Thirteen rules, in evaluation order:

| Signal | Category | Sev | Trigger (default threshold) | Score |
|---|---|---|---|---|
| High-impact field with broad live usage | `risky` | High | ≥10 projects AND ≥1,000 issues | +40 |
| App-provided field with heavy usage | `risky` | Med | app/plugin field with ≥500 issues | +22 |
| Global context with very low usage | `cleanup` | Med | global context, <50 issues | +20 |
| High dead-configuration ratio | `cleanup` | Med | ≥5 configured projects, ≥70% with no data | +20 |
| Orphaned field — not configured or used anywhere | `cleanup` | Med | 0 contexts, 0 issues, 0 active projects | +25 |
| Configured field with no populated issues | `cleanup` | Med | ≥3 configured projects, 0 issues | +18 |
| System field with no recorded usage | `cleanup` | Low | system field, 0 issues | +8 |
| Broadly scoped field with very light usage | `cleanup` | Med | ≥5 projects, 1–100 issues | +22 |
| No field activity in over a year | `cleanup` | Med | ≥1 issue, last recorded change ≥365 days ago | +20 |
| Context sprawl | `standardize` | Med | ≥8 separate contexts | +15 |
| Similar field naming detected | `standardize` | Med | normalized name shared by ≥2 fields | +20…50 |
| Actively used field lacks a meaningful description | `standardize` | Med | ≥5 projects **or** ≥500 issues, no description | +16 |
| Per-project usage is unavailable | `review` | Med | Jira returned no usage data for the field | +8 |

Every threshold in that table is admin-tunable from the Config tab; the defaults live in `DEFAULT_GOVERNANCE_THRESHOLDS` at the top of `analysis.js`.

A field is flagged **Admin Attention** if any finding is High severity, or if the combined priority score reaches **35**.

Two deliberate exclusions worth knowing about:

- Most rules skip system fields — a Jira built-in isn't a governance problem, and flagging Summary as "broadly scoped" is noise. `System field with no recorded usage` is the one rule that targets them.
- The staleness rule requires at least one populated issue, so it doesn't double-count fields the orphaned and unpopulated rules already flag. It means "this *was* used and then everyone stopped," not "this is empty."

**Staleness has a data-coverage limit.** The rule reads `snapshot_project_usage.latest_field_change_at`, which is populated only by per-field summary builds. The Universal Scan writes `NULL` there, and the rule treats a missing date as "unknown" rather than "not stale" — so on a site whose usage came from a scan alone, it stays silent for most fields. That's correct behaviour, not a bug, but it caps the rule's reach until the scan captures changelog dates.

---

## SQL schema

Twenty-three tables managed by a 49-step migration runner (`@forge/sql` + `migrationRunner`). All tables are namespaced by `scope_key` (derived from the Forge site context).

**Every `ADD COLUMN` migration is written `IF NOT EXISTS`, without exception.** The
`CREATE TABLE` constants describe each table's *current* shape, so a column added later
appears in both the CREATE and a later ALTER. On an existing database the ALTER does the
work; on a fresh one the CREATE already produced the column and a bare ALTER fails with a
duplicate-column error, halting the runner so every later migration never runs. This was
not hypothetical — it made every fresh install fatal until it was fixed, and went
unnoticed only because every environment had a pre-existing database.
`project-store.schema.test.js` enforces the rule mechanically.

**Field snapshot**

| Table | Purpose |
|---|---|
| `snapshot_fields` | One row per field per snapshot version. Metadata, usage state, context fingerprint |
| `snapshot_project_usage` | One row per field/project pair. Issue count, JQL, latest issue and field-change timestamps |
| `snapshot_meta` | One row per site. Snapshot state (idle/queued/building/ready), job token, progress log |
| `field_summaries` | One row per field. Computed totals, governance findings JSON, scan progress |
| `field_options_cache` | Cached select/multiselect option lists, which are expensive to refetch |

**Universal issue scan**

| Table | Purpose |
|---|---|
| `issue_scan_meta` | Scan state, cursor, and progress for the site-wide scan |
| `issue_scan_workers` | Per-worker partition assignment and resume position |
| `issue_scan_buffer` | Staging rows written by workers, promoted into `snapshot_project_usage` in batches |
| `issue_scan_status_totals` | Issues per status per project, accumulated during the scan. Status arrives on every issue already (`fields=*all`), so this costs no extra Jira calls |
| `issue_scan_project_totals` | Per-project issue totals accumulated during the scan |

**RQT index**

RQT tokens are site-specific reference identifiers matching `RQT-<n>-<n>`, which appear inside custom field *values* rather than as fields themselves. This index makes them queryable: which issues carry which token, in which field.

| Table | Purpose |
|---|---|
| `rqt_field_index` | Per-field RQT token frequency counters |
| `rqt_field_issue_index` | Field → issue associations backing the frequency view |
| `rqt_value_issue_index` | Token value → issue associations for per-value drilldown |
| `rqt_issue_keys` | Issue key dictionary, so the index tables store integers rather than repeated strings |

**Workflow & status snapshot**

| Table | Purpose |
|---|---|
| `snapshot_workflow_schemes` | One row per workflow scheme per version |
| `snapshot_workflow_scheme_projects` | Scheme → project assignments |
| `snapshot_statuses` | Site status catalog with the workflows using each status |
| `workflow_snapshot_meta` | State and progress for the workflow snapshot, versioned separately from fields |

**Reports**

| Table | Purpose |
|---|---|
| `saved_reports` | User-saved multi-field report results stored as JSON blobs |
| `report_jobs` | Async report generation job state and results |

The snapshot tables use a `version` column so a new snapshot can build in parallel with the active one, then swap atomically on completion. Old versions are pruned inline after each successful build.

---

## Tech stack

| Layer | Technology |
|---|---|
| Platform | Atlassian Forge — Custom UI macro + `jira:adminPage` |
| Runtime | Node.js 22.x |
| Frontend | React 18, Vite 5 (dual bundle) |
| Storage | `@forge/sql` (MySQL) |
| Queue | `@forge/events` |
| AI | Atlassian Rovo agent + actions |
| Tests | Vitest (Node + jsdom projects), `@vitest/coverage-v8` |
| CSS | Custom design system with CSS variables — no component library |
| Charts | Recharts |
| Icons | Phosphor Icons |

---

## Permissions

| Scope | Why |
|---|---|
| `read:jira-work` | Issue search for usage counts |
| `read:field:jira` | Fetch the custom field catalog |
| `read:field-configuration:jira` | Read field contexts and schemes |
| `read:project:jira` | Project metadata for usage breakdowns |
| `read:issue-meta:jira` | Field type and context data |
| `read:issue.changelog:jira` | Latest field-change timestamps |
| `read:custom-field-contextual-configuration:jira` | Configured project scope per field |
| `read:workflow:jira` | Workflow definitions and their statuses |
| `read:workflow-scheme:jira` | Workflow scheme → project assignments |
| `read:status:jira` | Site status catalog |
| `read:jira-user` | Identify the current user for permission checks |
| `manage:jira-configuration` | Required by Forge for the `jira:adminPage` module |
| `read:confluence-content.summary` | Macro host page context |
| `read:chat:rovo` | Rovo agent integration |
| `storage:app` | Forge KV storage (legacy state; SQL is primary) |

`manage:jira-configuration` is the broadest scope requested and is worth explaining on any install-consent review: Observatory writes nothing back to Jira. It's the scope Forge requires to surface an admin page, not a capability the app exercises. Every data path in the app is read-only against Jira; all writes go to the app's own SQL store.

---

## Development

```bash
npm install
npm run build       # dual Vite build → static/dist (macro) + static/dist-admin (admin page)
forge deploy        # deploy to development environment
forge install       # install on a Confluence site (first time only)
```

The frontend is a Vite project rooted at `static/`, built twice: once for the Confluence macro (`static/dist`) and once for the Jira admin page (`static/dist-admin`). Backend entry point is `src/index.js`. SQL migrations live in `src/lib/project-store.js`.

Note that `forge deploy` does **not** rebuild the Vite bundles — always run `npm run build` first, or use `npm run deploy`, which chains both.

---

## Testing

```bash
npm test              # unit + component tests (backend and frontend projects)
npm run test:backend  # backend only
npm run test:frontend # frontend only
npm run test:coverage # with coverage report
```

Tests are colocated with their source (`src/lib/analysis.test.js` sits next to `analysis.js`). The suite is split into two Vitest projects — `backend` runs in Node, `frontend` in jsdom with `@forge/bridge` aliased to a mock.

Coverage thresholds are enforced in `vitest.config.js` and set just below current actuals, so they act as a ratchet: coverage can rise freely, but a drop fails the run. Per-file floors pin the modules whose failure modes are hardest to diagnose in production — `src/lib/jira-api.js` (rate limiting, retry, cursor pagination), `src/index.js` (the queue job router, where an unrecognised job type would otherwise fail silently), `src/lib/report-engine.js`, and `src/resolvers.js`, which holds the authorization boundary: a regression there is a security regression, not a coverage statistic.

The storage layer is tested directly rather than only through its callers. Every other
suite mocks `project-store` wholesale, so nothing exercised the real SQL construction or
row mapping — which is exactly where a wrong column alias or an unscoped `DELETE` hides.
`project-store.crud.test.js` and `project-store.writes.test.js` assert query shape and row
mapping against a mocked Forge SQL, including that **every `DELETE` carries a `scope_key`
predicate** — in a multi-tenant Forge app an unscoped delete destroys another customer's
data, and no test that mocks the store could ever catch one.

Raising the thresholds is a deliberate edit to that config, not something that happens by accident.

---

## App identity

- **App ID:** `ari:cloud:ecosystem::app/c11559cd-90ed-43a7-9a9b-80866237cd15`
- **Macro key:** `atlasiq-custom-field-governance-macro`
- **Rovo agent key:** `observatory-field-expert`
- **Queue:** `inventory-snapshot-queue`
