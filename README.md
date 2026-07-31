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

### Jira admin page — six tabs

**Overview.** Dashboard summarising snapshot state, catalog size, and the governance findings breakdown.

**Field Browser.** The Inventory view plus everything admin-only: finding badges on each card, a findings filter bar (admin attention / risk / cleanup / standardize), and per-field usage refresh.

**Project Usage.** The Projects view with admin controls.

**Reports.** Report generation and saved-report management.

**Scans.** Five sub-views over the data pipeline — Snapshot, Universe Scan, Quick Scan, RQT Index, and Field Usage Jobs — each with live progress, job tokens, per-item logs, and start/cancel/restart control.

**Configuration.** Governance thresholds, macro access groups, read-only mode, and retention settings.

### Workflow & status inventory
The same inventory treatment applied to workflow schemes and statuses: which schemes exist, which projects each is assigned to, and the full status catalog with the workflows using each one. Built by `src/lib/workflow-engine.js` on its own snapshot version, independent of the field snapshot.

### Rovo AI agent
An embedded Rovo agent ("Observatory Field Expert") with two callable actions:
- **Search field catalog** — natural-language search over the snapshot
- **Inspect field governance** — detailed breakdown for a specific field, by field ID or name

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
  ├── rovo-search-fields index.rovoSearchFields       Rovo agent action
  ├── rovo-inspect-field index.rovoInspectField       Rovo agent action
  └── sql-migrate        index.runProjectStorageMigrations

Storage
  └── @forge/sql (MySQL) — 19 tables, 44 migration steps
```

Two resolvers, one codebase. `SHARED_RESOLVER_FUNCTIONS` are registered on both
handlers; `ADMIN_ONLY_FUNCTIONS` only on `adminHandler`. A function omitted from
the shared set is not merely hidden from the macro UI — it is not registered on
that resolver at all, so a crafted `invoke()` from the macro iframe fails to
resolve rather than executing. New mutating functions belong in the admin set.

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

Nineteen tables managed by a 44-step migration runner (`@forge/sql` + `migrationRunner`). All tables are namespaced by `scope_key` (derived from the Forge site context).

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

Coverage thresholds are enforced in `vitest.config.js` and set just below current actuals, so they act as a ratchet: coverage can rise freely, but a drop fails the run. Per-file floors pin the two modules whose failure modes are hardest to diagnose in production — `src/lib/jira-api.js` (rate limiting, retry, cursor pagination) and `src/index.js` (the queue job router, where an unrecognised job type would otherwise fail silently).

Raising the thresholds is a deliberate edit to that config, not something that happens by accident.

---

## App identity

- **App ID:** `ari:cloud:ecosystem::app/c11559cd-90ed-43a7-9a9b-80866237cd15`
- **Macro key:** `atlasiq-custom-field-governance-macro`
- **Rovo agent key:** `observatory-field-expert`
- **Queue:** `inventory-snapshot-queue`
