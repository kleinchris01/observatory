# Observatory — Jira configuration governance and change safety

[![Coverage](https://img.shields.io/badge/coverage-lines%20%E2%89%A5%2078%25-yellow)](#testing)
[![Tests](https://img.shields.io/badge/tests-3918%20passing-brightgreen)](#testing)

<!--
  These badges are deliberately coarse. An exact percentage hand-copied from a local
  run decays silently — the previous badge read 63.6% while vitest.config.js was
  enforcing a floor of 78, and nobody noticed for two months.

  So the badge now states the ENFORCED FLOOR, which is a fact CI guarantees, rather
  than a measurement that was true once. The floor lives in vitest.config.js under
  coverage.thresholds; raising it is a deliberate edit. CI also uploads to Codecov
  (.github/workflows/ci.yml) if you want the live number.

  The test count IS exact and was verified by a full run (104 files, 3918 tests,
  23 September 2026). It only moves when tests are added, so it decays slowly and
  visibly — unlike a percentage, which drifts on every merge.
-->

Observatory answers one question about a Jira site, across every part of its configuration:

> **What breaks if I change or delete this?**

It snapshots the configuration estate — fields, workflows, screens, issue types, schemes, filters, dashboards, boards, automation rules, assets and users — enriches it with live usage data measured from the issue corpus, resolves the dependency graph between those things, and reports what is safe to remove, what is quietly rotting, and what is load-bearing.

It ships as two Forge surfaces against one backend:

- a **Confluence macro** for browsing fields and building reports, embeddable in any page
- a **Jira admin page** with nineteen tabs covering the full estate, scans, findings and remediation

The split is deliberate. Governance findings, threshold configuration, job control and remediation are admin-only; the macro is read-and-report. A macro viewer never sees a finding badge or a control that mutates state.

---

## What problem it solves

Jira sites accumulate configuration for years and shed almost none of it. The questions that matter are easy to ask and nearly impossible to answer from the admin UI:

- Which of these 400 custom fields is anyone actually using, and where?
- If I delete this field, which dashboards, filters, boards and automation rules break?
- Which statuses can no scheme reach? Which schemes have no Done status?
- Which automation rules store a credential in plaintext?
- Who holds admin through which group, and which licences are unused?
- What changed in this site's configuration last month, and who changed it?

Observatory answers these from measured data rather than inference. The distinction matters more than it sounds: a dependency graph built by matching gadget titles against filter names would be right most of the time, and **most of the time is the worst possible accuracy for a claim someone is about to delete a field on**. Every edge in Observatory's graph is resolved through the API that actually records the relationship — dashboard → gadget configuration → filter → JQL → field — which is why several of the permission scopes below exist.

It replaced a manual process of crafting JQL queries and pasting results into spreadsheets.

---

## Governance pillars

Each pillar has a snapshot engine, an insights module of pure functions over loaded rows, its own store module, an admin tab, and — for most — a Rovo agent.

| Pillar | What it inventories | Insights |
|---|---|---|
| **Fields** | Custom field catalog, contexts, per-project usage, populated issue counts | 13 rules (below) |
| **Workflows & statuses** | Schemes, their projects, the site status catalog, two usage measures per status | Duplicate statuses, unreachable statuses, scheme category balance |
| **Issue types** | Type catalog, issue type schemes, scheme→project mapping | Unused types, scheme sprawl |
| **Screens** | Screens, tabs, fields, screen schemes, issue-type screen schemes, transition screens | Orphaned screens, empty tabs, field placement |
| **Access** | Permission schemes, issue-security schemes, notification schemes, holders, project assignments | Over-broad grants, unused schemes, cross-rule risk |
| **People** | Licensed-user roster via application roles, groups, membership, ownership graph | Licence utilisation, ownership concentration |
| **Assets** | JSM Assets/CMDB schemas, object types, attributes, live object counts | Empty schemas, attribute sprawl |
| **Priorities & resolutions** | The global value lists, versioned | Unused values |
| **Filters** | Every saved filter site-wide, its JQL, its shares | Broken references, over-sharing, field and status joins |
| **Dashboards** | Dashboards, gadgets, gadget configuration, shares | What a dashboard actually depends on |
| **Boards** | Agile boards, their backing filter, column→status mapping | Boards on deleted filters, column gaps |
| **Automation** | Every rule, its components, references, and project scope | Credentials in plaintext, blast radius, cascades between rules |
| **Changes / drift** | Configuration change history over time | Rate of motion per area |
| **Projects** | Project estate, adoption, scheme membership | Adoption outliers |
| **Remediation** | Playbooks per finding, and the Jira tickets raised from them | — |

Above the pillars sit three cross-cutting engines:

- **`cascade-graph.js`** — resolves the reference graph between entities across pillars.
- **`deletion-safety.js`** — turns that graph into a verdict for one entity: what references it, what breaks, what is unknown.
- **`health-score.js` / `site-health.js`** — a composite site score with history, so a site can be seen improving or decaying rather than only inspected at a point in time.

---

## Features

### Confluence macro — three tabs

**Inventory.** A paginated, searchable, filterable list of every Jira custom field on the site. Each card shows the field ID (click to copy), name, type, admin description, configured and active project counts, and total populated issues. Expanding a card reveals the per-project usage breakdown with JQL deep-links.

Filters: free-text search, field type, sort order, project usage state, max issues cap.

**Projects.** Switch between every project that has cached field usage. Per project: the fields with populated values there, paginated and filterable; two charts (top fields by issue count, field type distribution); and a JQL deep-link for every field/project pair.

**Report.** Generate a cross-field comparison report for any set of selected fields, paginated by field type and filterable by type or project name. Reports can be named and saved for later recall, and exported to CSV.

Governance findings are *not* shown in the macro — see the surface split above. The macro is for browsing and reporting.

### Jira admin page — nineteen tabs

| Tab | Purpose |
|---|---|
| **Overview** | Site health score and history, snapshot state, catalog size, findings breakdown |
| **Field Browser** | Inventory plus finding badges, the findings filter bar, per-field usage refresh |
| **Project Usage** | Per-project field usage with the workflow scheme governing each project and its scheme siblings |
| **Workflows** | Scheme and status inventory with derived findings |
| **Issue Types** | Type catalog, schemes, and project mapping |
| **Priorities** | Priority and resolution value lists |
| **People** | Licensed-user roster, groups, ownership graph |
| **Assets** | JSM Assets schemas, object types, live object counts |
| **Access** | Permission, issue-security and notification schemes with holders |
| **Screens** | Screen, tab, field and scheme inventory |
| **Saved Filters** | Every filter site-wide, its JQL and what it references |
| **Dashboards** | Dashboards, gadgets and resolved dependencies |
| **Boards** | Boards, backing filters, column mapping |
| **Automation** | Rule inventory, credential findings, blast radius, cross-rule cascades |
| **Remediation** | Playbooks per finding, and the Jira tickets raised from them |
| **Reports** | Report generation and saved-report management |
| **Changes** | Configuration change timeline |
| **Scans** | Five sub-views over the pipeline — Snapshot, Universe Scan, Quick Scan, RQT Index, Field Usage Jobs — each with live progress, job tokens, per-item logs and start/cancel/restart control |
| **Configuration** | Governance thresholds, macro access groups, read-only mode, remediation project, retention |

The admin page carries three themes — **dark**, **light** and **day** — cycled from the header.

### Workflow & status inventory

Built by `src/lib/workflow-engine.js` on its own snapshot version, independent of the field snapshot, and queued to the consumer rather than run in a resolver — walking every project's scheme does not fit in a 25-second invocation.

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

**A status whose usage was never measured is reported as unknown, never as zero.** Zero is what marks a status safe to delete, so it is only ever asserted when a scan actually observed the catalog. This rule holds across every pillar and is the single most important invariant in the codebase.

### Remediation — the one place Observatory writes to Jira

Every other data path in the app is read-only against Jira. Remediation is the exception, and it is worth stating plainly rather than burying:

**`createRemediationEpic` creates issues in Jira.** For a governance finding with a playbook, it creates one epic in an admin-configured project and one task per item to fix. It requires the `write:jira-work` scope, which the app declares.

Controls on that path:

| Control | Where |
|---|---|
| Registered in `ADMIN_ONLY_FUNCTIONS`, so the macro resolver cannot reach it | `src/resolvers.js` |
| Caller must hold Jira `ADMINISTER`, checked as the user, failing closed | `withAdminGuard` |
| Blocked entirely when read-only mode is on | `createRemediationEpic` |
| Requires a remediation project to be configured first — no default target | Configuration tab |
| `reporter` is set to the admin who clicked, not the app | `createRemediationEpic` |
| Idempotent — an existing epic for a finding gains missing tasks rather than a duplicate | `getRemediationEpic` |
| Recorded in `AUDITED_ADMIN_ACTIONS` | `audit_log` |

A scheduled trigger (`remediationSyncCheck`, three times daily at Pacific business hours) re-reads status and assignee for every open remediation ticket so the tab reflects reality rather than the state at creation.

Nothing else writes to Jira. All other writes go to the app's own SQL store.

### Rovo AI agents

Eleven agents, one per pillar, keyed `observatory-<pillar>-expert`: Field, Workflow, Issue Type, Access, People, Assets, Priorities, Screen, Change, Project, Automation. Each has the same shape:

- **`search-<pillar>`** — ranked matches for a name or phrase
- **`inspect-<pillar>`** — the full governance detail for one entity
- **`<pillar>-impact`** — "what references / breaks if I change this", where the pillar can answer it

Every action returns the snapshot's `refreshedAt` and an explicit `*-unavailable` status rather than an empty result — an agent must never let a missing snapshot read as "nothing found". Agent keys are listed in `ROVO_AGENTS` (`static/src/utils.js`) and must match the `rovo:agent` entries in `manifest.yml`; prompt files live in `resource/agent/prompts/`, each starting from the shared preamble.

In the UI, every "Ask Rovo about …" affordance is the shared `<AskRovo>` primitive — its tooltip names the agent and states that Rovo answers from the latest snapshot and never changes Jira. **The agents are read-only. None of them can reach the remediation write path.**

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
  ├── resolver            index.handler              macro invoke()  — shared functions only
  ├── admin-resolver      index.adminHandler         admin invoke()  — shared + admin-only
  ├── snapshot-consumer   index.consumeSnapshot      queue consumer, 900s timeout
  ├── auto-snapshot       index.autoSnapshotCheck            scheduled, daily
  ├── quick-scan-scheduler index.quickScanScheduleCheck      scheduled
  ├── remediation-sync    index.remediationSyncCheck         scheduled, 3x daily
  ├── retention-cleanup   index.runRetentionCleanup          scheduled, weekly
  ├── sql-migrate         index.runProjectStorageMigrations
  └── 28 Rovo action functions  index.rovo*

Storage
  └── @forge/sql (MySQL) — 88 tables, 157 migration steps
```

Two resolvers, one codebase. `SHARED_RESOLVER_FUNCTIONS` are registered on both handlers; `ADMIN_ONLY_FUNCTIONS` only on `adminHandler`. A function omitted from the shared set is not merely hidden from the macro UI — it is not registered on that resolver at all, so a crafted `invoke()` from the macro iframe fails to resolve rather than executing. New mutating functions belong in the admin set.

The admin guard is applied by **wrapping the whole registry at export**, not by calling a helper inside each function. A function added to the registry is guarded by construction; there is no step anyone can forget. `src/index.test.js` asserts that `adminHandler` registers nothing beyond the two registries, so a function spread in directly fails the build.

### Module layout

```
src/lib/                    one engine + one insights module per pillar
  <pillar>-engine.js        builds that pillar's snapshot (queued, resumable)
  <pillar>-insights.js      pure functions over loaded rows — no I/O, trivially testable
  cascade-graph.js          cross-pillar reference graph
  deletion-safety.js        "what breaks if this goes" verdicts
  health-score.js           composite site score
  jira-api.js               rate limiting, retry, cursor pagination, permission checks
  logger.js                 structured logging + the two named degradation helpers

src/lib/store/            storage layer, split by domain — import these directly in new code
  core.js                 sql handle, schema, 157 migrations, shared helpers (no domain imports)
  snapshot.js             field snapshots and per-project usage
  scan.js                 universe and delta scan state
  workflow.js             schemes, status catalog, usage counts
  screen.js / access.js / issuetype.js / asset.js / boards.js / dashboard.js /
  filter.js / automation.js / estate.js / drift.js / health.js / user.js /
  remediation.js / rqt.js / reports.js / audit.js
src/lib/project-store.js  barrel re-exporting the above (compatibility, not the entry point)

static/src/tabs/               one module per admin tab, components individually exported
static/src/components/admin/   primitives, JobsPanel, AuditLogPanel
static/src/components/ui.jsx   shared presentation primitives used across tabs
static/src/admin.jsx           AdminApp composition only
```

Domain modules import from `core.js`; `core.js` imports none of them. One arrow, so there are no cycles to reason about.

The engine/insights split is the same idea one level up: an engine does I/O and knows about queues and resume tokens; an insights module is pure functions over rows it was handed. Every governance rule in the product is therefore testable without mocking a single API.

**Known debt:** `src/resolvers.js` is ~9,200 lines and holds the authorization boundary alongside every handler body. The registries and `withAdminGuard` belong there; the handlers should move to per-pillar modules that export their own function maps. The registry-membership test makes that refactor safe to do incrementally.

### Error handling

Two helpers in `src/lib/logger.js` replace anonymous `.catch(() => value)` handlers, and the distinction between them is deliberate:

| Helper | Level | Use when |
|---|---|---|
| `fallbackOn(event, fallback, context)` | `warn` | A read degrades to a default. The caller is about to treat a fabricated value as real data. |
| `ignoreWith(event, context)` | `debug` | A cleanup write fails while another error is already being handled and there is nothing further to do. |

Anonymous handlers are not acceptable in new code. Degrading gracefully is right; degrading *invisibly* is what turns a bug into a mystery — a failed count once rendered as a confident `Site-wide issue count: 0` on a site holding 317,907 issues. Silence is still available, but it has to be named, which forces the author to say what was lost.

### Data pipeline

**1. Snapshot build**
User clicks "Build snapshot" → job enqueued on `inventory-snapshot-queue` → `consumeSnapshot` calls the Jira REST API to fetch all custom fields, their contexts, and configured project scopes → results written to `snapshot_fields` and `snapshot_meta` in batches.

If the consumer hits the 900 second timeout, it writes a resume token and re-enqueues itself. The next invocation picks up where it left off. This makes the snapshot resumable across arbitrarily large field catalogs.

**2. Field summary deep scans**
Per-field deep scans triggered from the UI. Each field runs a paginated Jira issue search to count exactly how many issues have a populated value, across all projects. Also resume-token driven.

**3. Project usage jobs**
Joins field usage to individual projects. Results land in `snapshot_project_usage` — one row per field/project pair with issue count, JQL and timestamps. This is the only path that populates `latest_field_change_at`, which the staleness finding depends on.

**4. Universe Scan**
The alternative to per-field scanning, and much cheaper on large sites. Instead of one issue search per field, it walks the issue corpus once with parallel workers over partitioned key ranges, tallying which fields are populated on which projects as it goes. Workers buffer counts into `issue_scan_buffer` and flush periodically; a promote step folds the buffer into `snapshot_project_usage`.

The same pass also accumulates status totals, project totals, issue-type totals, per-user field activity and estate values — status and type arrive on every issue already (`fields=*all`), so these cost no extra Jira calls.

Per-field scanning costs one search per field (hundreds of round trips); the Universe Scan costs one pass over the issues regardless of catalog size. The tradeoff is that it does not fetch changelogs, so `latest_field_change_at` stays `NULL` for rows it produces.

**Quick Scan** is the same machinery narrowed to issues updated in the last 24 hours — a cheap top-up between full passes, on its own scheduled trigger.

**5. Structural pillar builds**
Workflows, screens, issue types, access schemes, filters, dashboards, boards, assets, users and estate values each build on their own snapshot version, independently of the field snapshot. Most are two or three paginated endpoints and fit inside one consumer invocation; the ones that walk a per-project chain (screens, workflow schemes) are resumable like the field snapshot.

**6. Automation rule ingest**
Rules are imported from a Jira automation export, redacted, and analysed. `scripts/snapshot-rules.mjs` writes one redacted JSON file per rule into `rules/`. **Raw exports are never committed** — they carry live credentials in plaintext (OAuth client secrets in web-request bodies, inbound webhook tokens, Slack webhook URLs), and `.gitignore` excludes `automation-rules-*.json` for that reason.

`src/lib/secret-detect.js` holds the credential recognizers, deliberately separate from the redactor: `rule-snapshot.js` pairs each recognizer with a redactor, and `automation-analysis.js` (which runs in the admin's browser and cannot import `node:crypto`) pairs each with a finding. One list, so a matcher added for the redactor is a matcher the analysis reports on the same day. Every matcher must reject its own output — `client_secret=[[REDACTED:5d417630]]` matches a naive form-encoded matcher as readily as a live secret does.

**7. RQT index**
Builds the RQT token index — which `RQT-<n>-<n>` reference tokens appear in which field values on which issues — backing the per-value frequency and drilldown views. Two fields (`issuelinks`, `parent`) are skipped because their values describe *related* issues rather than the issue being indexed, and a dedup rule collapses tokens duplicated across four known overlapping fields.

**8. UI reads**
All reads go through `invoke()` to a resolver, which queries SQL and returns paginated, filtered, sorted results. No data is held in client state between page loads.

Every long-running stage above follows the same resumability contract: write a resume token, re-enqueue, pick up where you left off. Nothing depends on completing inside one invocation.

### Rate limiting

Jira API calls go through an adaptive concurrency controller. It starts at a configured concurrency and request interval, backs off exponentially on 429s (honouring `Retry-After` when present, with a cooldown window), and eases the interval back down on streaks of success. Requests carry a hard timeout so a hung call can't hold a concurrency slot indefinitely — slots are released on the failure path as well as the success path.

State is module-level within a single consumer invocation, so each invocation re-learns the site's tolerance rather than inheriting a stale estimate.

### Permission filtering

Project-level data is filtered by the viewer's own Jira permissions, not the app's. Reads that return per-project data call Jira as the user to establish which projects they can browse, then intersect the cached results against that set — so two people looking at the same snapshot see different project lists if their permissions differ.

---

## Field governance findings

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

Every threshold is admin-tunable from the Configuration tab; the defaults live in `DEFAULT_GOVERNANCE_THRESHOLDS` at the top of `analysis.js`.

A field is flagged **Admin Attention** if any finding is High severity, or if the combined priority score reaches **35**.

Two deliberate exclusions worth knowing about:

- Most rules skip system fields — a Jira built-in isn't a governance problem, and flagging Summary as "broadly scoped" is noise. `System field with no recorded usage` is the one rule that targets them.
- The staleness rule requires at least one populated issue, so it doesn't double-count fields the orphaned and unpopulated rules already flag. It means "this *was* used and then everyone stopped," not "this is empty."

**Staleness has a data-coverage limit.** The rule reads `snapshot_project_usage.latest_field_change_at`, which is populated only by per-field summary builds. The Universe Scan writes `NULL` there, and the rule treats a missing date as "unknown" rather than "not stale" — so on a site whose usage came from a scan alone, it stays silent for most fields. That's correct behaviour, not a bug, but it caps the rule's reach until the scan captures changelog dates.

Each other pillar carries its own insights module with the same shape; see the pillar table above.

---

## SQL schema

**88 tables managed by a 157-step migration runner** (`@forge/sql` + `migrationRunner`, declared in `src/lib/store/core.js` as `v001`…`v157`). All tables are namespaced by `scope_key`, derived from the Forge site context.

**Every `ADD COLUMN` migration is written `IF NOT EXISTS`, without exception.** The `CREATE TABLE` constants describe each table's *current* shape, so a column added later appears in both the CREATE and a later ALTER. On an existing database the ALTER does the work; on a fresh one the CREATE already produced the column and a bare ALTER fails with a duplicate-column error, halting the runner so every later migration never runs. This was not hypothetical — it made every fresh install fatal until it was fixed, and went unnoticed only because every environment had a pre-existing database. `project-store.schema.test.js` enforces the rule mechanically.

Tables by domain:

| Domain | Tables |
|---|---|
| Field snapshot | `snapshot_fields`, `snapshot_project_usage`, `snapshot_meta`, `field_summaries`, `field_options_cache`, `snapshot_field_type_usage`, `snapshot_field_user_usage` |
| Universe scan | `issue_scan_meta`, `issue_scan_workers`, `issue_scan_buffer`, and the accumulator tables for status, project, type, estate and user activity totals |
| Full / quick scan | `full_scan_meta`, `full_scan_runs` |
| Workflows | `snapshot_workflow_schemes`, `snapshot_workflow_scheme_projects`, `snapshot_statuses`, `snapshot_workflow_statuses`, `status_history_totals`, `workflow_snapshot_meta` |
| Screens | `snapshot_screens`, `snapshot_screen_tabs`, `snapshot_screen_fields`, `snapshot_screen_schemes`, `snapshot_screen_scheme_operations`, `snapshot_issue_type_screen_schemes`, `snapshot_itss_mappings`, `snapshot_itss_projects`, `snapshot_transition_screens`, `screen_cross_summary`, `screen_snapshot_meta` |
| Issue types | `snapshot_issue_types`, `snapshot_issue_type_schemes`, `snapshot_issue_type_scheme_items`, `snapshot_issue_type_scheme_projects`, `issue_type_snapshot_meta` |
| Access | `snapshot_schemes`, `snapshot_scheme_holders`, `snapshot_scheme_levels`, `snapshot_scheme_projects`, `access_snapshot_meta` |
| People | `snapshot_users`, `snapshot_user_access`, `user_snapshot_meta` |
| Assets | `snapshot_asset_schemas`, `snapshot_asset_object_types`, `snapshot_asset_attributes`, `snapshot_asset_type_counts`, `asset_type_count_meta` |
| Filters / dashboards / boards | `snapshot_filters`, `snapshot_filter_refs`, `snapshot_filter_shares`, `snapshot_dashboards`, `snapshot_dashboard_gadgets`, `snapshot_dashboard_shares`, `snapshot_boards`, `snapshot_board_columns`, plus a meta table each |
| Automation | `automation_rules`, `automation_rule_projects`, `automation_references`, `automation_findings`, `automation_cascades`, `automation_rule_blast` |
| Estate / drift / health | `snapshot_estate_values`, `snapshot_entity_digest`, `config_change_log`, `health_history`, plus meta tables |
| RQT index | `rqt_field_index`, `rqt_field_issue_index`, `rqt_value_issue_index`, `rqt_issue_keys` |
| Reports & remediation | `saved_reports`, `report_jobs`, `remediation_tickets` |
| Audit | `audit_log` |

Snapshot tables use a `version` column so a new snapshot can build in parallel with the active one, then swap atomically on completion. Old versions are pruned inline after each successful build.

**Every `DELETE` carries a `scope_key` predicate.** In a multi-tenant Forge app an unscoped delete destroys another customer's data, and no test that mocks the store could ever catch one — so `project-store.writes.test.js` asserts it against a mocked Forge SQL directly.

---

## Tech stack

| Layer | Technology |
|---|---|
| Platform | Atlassian Forge — Custom UI macro + `jira:adminPage` |
| Runtime | Node.js 22.x |
| Frontend | React 18, Vite 5 (dual bundle) |
| Storage | `@forge/sql` (MySQL) |
| Queue | `@forge/events` |
| AI | Atlassian Rovo agents + actions |
| Tests | Vitest (Node + jsdom projects), `@vitest/coverage-v8` |
| CSS | Custom design system with CSS variables — no component library |
| Charts | Recharts |
| Icons | Phosphor Icons |

No external network egress. Observatory calls Jira and Confluence through the Forge proxy and stores everything in Forge SQL; there is no vendor backend, no third-party analytics and no `remote:` declaration in the manifest.

---

## Permissions

Observatory declares **49 scopes**. That is a lot for a consent screen, and the reason is structural rather than acquisitive: Forge's granular scopes are **conjunctive**, so an endpoint needs *every* scope in its list, not any one of them — and the scope set for an endpoint is not guessable from what the endpoint sounds like. `GET /rest/api/3/screens` requires `read:avatar:jira` and `read:project-category:jira`, neither of which has anything to do with screens by name.

`manifest.yml` documents each group inline with the endpoints that forced it. The summary:

| Group | Scopes | Why |
|---|---|---|
| Issues & fields | `read:jira-work`, `read:issue:jira`, `read:field:jira`, `read:field-configuration:jira`, `read:issue-meta:jira`, `read:issue.changelog:jira`, `read:custom-field-contextual-configuration:jira` | The field catalog, contexts, and the issue searches that measure usage |
| Projects | `read:project:jira`, `read:project-category:jira`, `read:project-role:jira`, `read:avatar:jira` | Project metadata, and the two non-obvious scopes the screens endpoint requires |
| Workflows & statuses | `read:workflow:jira`, `read:workflow-scheme:jira`, `read:status:jira` | Scheme → project assignment and the status catalog |
| Screens | `read:screen:jira`, `read:screen-tab:jira`, `read:screenable-field:jira`, `read:screen-scheme:jira`, `read:issue-type-screen-scheme:jira`, `read:screen-field:jira` | The chain project → ITSS → screen scheme → screen → tab → field, gated hop by hop |
| Issue types | `read:issue-type:jira`, `read:issue-type-scheme:jira` | Type catalog and the schemes that gate which types a project may use |
| Access schemes | `read:permission:jira`, `read:permission-scheme:jira`, `read:issue-security-scheme:jira`, `read:issue-security-level:jira`, `read:notification-scheme:jira` | Permission, security and notification schemes with holders |
| People | `read:jira-user`, `read:user:jira`, `read:group:jira`, `read:application-role:jira` | The licensed-user roster and group membership |
| Filters, dashboards, boards | `read:filter:jira`, `read:dashboard:jira`, `read:dashboard.property:jira`, `read:board-scope:jira-software`, `read:board-scope.admin:jira-software` | Site-wide enumeration, and gadget *configuration* — which is where the filter a gadget points at is actually recorded |
| Estate values | `read:priority:jira`, `read:resolution:jira` | The global value lists |
| Assets (JSM) | `read:cmdb-schema:jira`, `read:cmdb-object:jira`, `read:cmdb-type:jira`, `read:cmdb-attribute:jira`, `read:servicedesk-request`, `read:servicemanagement-insight-objects` | Assets schemas, object types, attributes and live counts |
| Platform | `manage:jira-configuration`, `read:confluence-content.summary`, `read:chat:rovo`, `storage:app` | Required by the `jira:adminPage` module, the macro host page context, Rovo, and legacy KV state |
| **Write** | **`write:jira-work`** | **Remediation ticket creation — the only write the app performs. See the Remediation section for the controls on it.** |

Two scopes deserve a note on any install-consent review:

- **`manage:jira-configuration`** is the broadest scope requested. It is the scope Forge requires to surface an admin page, not a capability the app exercises — Observatory changes no Jira configuration.
- **`write:jira-work`** is real and is used. It creates remediation epics and tasks in an admin-configured project, behind an explicit button, gated on Jira `ADMINISTER`, blocked in read-only mode, and audited. It is not used anywhere else, and no Rovo agent can reach it.

`forge lint` validates that a scope *exists*. It never validates that it is the right one for the endpoints the app calls — which is how a pillar can pass lint and still return 401. Read the scope set off each endpoint's own documentation.

---

## Security

`SECURITY_CHECKLIST.md` is the full account: what is enforced, what is deliberately not, and where the accepted risks are, each traceable to a named file. Headlines:

- **Admin functions require Jira `ADMINISTER`**, checked as the calling user via `POST /rest/api/3/permissions/check`, failing closed on any error, applied by wrapping the registry at export rather than per function.
- **The macro resolver cannot reach admin functions** — they are not registered on it.
- **Per-viewer permission filtering** on all project-scoped reads.
- **Audit log** of every denial and every mutating admin action, 180-day retention, not erasable by `clearAllSnapshotData`.
- **Accepted risks, documented:** macro group-gating fails *open* on a Jira API error (the macro is read-only and shows no findings); the admin permission check is cached 60 seconds per account, so revocation lags by up to a minute.

If you change a control, change that file in the same commit. A checklist that drifts from the code is worse than no checklist, because people quote it — and this README's own "Observatory never writes to Jira" claim survived two months past the day it stopped being true.

---

## Development

```bash
npm install
npm run build       # dual Vite build → static/dist (macro) + static/dist-admin (admin page)
forge deploy        # deploy to development environment
forge install       # install on a site (first time only)
```

`forge deploy` does **not** rebuild the Vite bundles — always run `npm run build` first, or use `npm run deploy`, which chains both.

**Delivery rules** (see `CLAUDE.md` for the full set):

- Open a PR; never commit straight to `master`. CI gating and CODEOWNERS only engage on a PR.
- Push to `master` auto-deploys to **development** only. Staging and production are manual.
- Merging several PRs quickly races the deploy workflow against itself — it has no concurrency group. Let each dev deploy finish before merging the next.
- Every new tab, panel or feature is built from the shared primitives in `static/src/components/ui.jsx`. The codebase has twice grown a second dialect of the same widget, and the result both times was one product that read as three.

Operational procedures — stuck scans, stuck snapshots, database health, rollback, migration rules and six named error patterns — are in `RUNBOOK.md`.

---

## Testing

```bash
npm test              # unit + component tests (backend and frontend projects)
npm run test:backend  # backend only
npm run test:frontend # frontend only
npm run test:coverage # with coverage report
```

104 test files, colocated with their source (`src/lib/analysis.test.js` sits next to `analysis.js`). The suite is split into two Vitest projects — `backend` runs in Node, `frontend` in jsdom with `@forge/bridge` aliased to a mock.

Coverage thresholds are enforced in `vitest.config.js` and set just below current actuals, so they act as a ratchet: coverage can rise freely, but a drop fails the run. Per-file floors pin the modules whose failure modes are hardest to diagnose in production — `src/lib/jira-api.js` (rate limiting, retry, cursor pagination), `src/index.js` (the queue job router, where an unrecognised job type would otherwise fail silently), `src/lib/report-engine.js`, and `src/resolvers.js`, which holds the authorization boundary: a regression there is a security regression, not a coverage statistic.

The storage layer is tested directly rather than only through its callers. Every other suite mocks `project-store` wholesale, so nothing exercised the real SQL construction or row mapping — which is exactly where a wrong column alias or an unscoped `DELETE` hides.

When a test mocks an error, use `mockRejectedValueOnce`, not `mockRejectedValue`, to avoid cross-test bleed.

Raising the thresholds is a deliberate edit to that config, not something that happens by accident.

---

## App identity

- **App ID:** `ari:cloud:ecosystem::app/c11559cd-90ed-43a7-9a9b-80866237cd15`
- **Macro key:** `atlasiq-custom-field-governance-macro` — retained deliberately; changing a macro key breaks every existing Confluence embed
- **Admin page key:** `atlasiq-observatory-admin`
- **Rovo agent keys:** `observatory-<pillar>-expert`
- **Queue:** `inventory-snapshot-queue`

The `atlasiq-` prefix and the `custom-field-governance-macro` package name predate the product's current scope. They are load-bearing identifiers, not a description of what this is.
