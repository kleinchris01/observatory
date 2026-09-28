# Observatory — Jira configuration governance

[![Coverage](https://img.shields.io/badge/coverage-lines%20%E2%89%A5%2078%25-yellow)](#testing)
[![Tests](https://img.shields.io/badge/tests-3959%20passing-brightgreen)](#testing)

<!--
  These badges are deliberately coarse rather than a hand-copied point figure. The test
  count above (3959) is exact and was verified by a full run on 23 September 2026 -- the
  previous badge said 3827, which had already drifted. A percentage drifts on every merge;
  a coverage FLOOR does not, because CI enforces it -- so the coverage badge states the
  enforced floor (vitest.config.js, coverage.thresholds) rather than a snapshot that will be
  stale again within a week. CI also uploads to Codecov (.github/workflows/ci.yml) for the
  live number if you want it.
-->

Observatory reads an entire Jira site's configuration — fields, screens, workflows, issue
types, boards, filters, dashboards, permission schemes, project roles, priorities,
resolutions, the user roster, the Assets CMDB and your automation rules — stores it, scores
it, and tells you what is safe to change.

It ships as two Forge surfaces against one backend:

- a **Jira admin page** (19 sections) for scanning, governance findings, health scoring and
  configuration
- a **Confluence macro** (9 sections) that gives everyone else a read-only view of the same
  estate, filtered to the projects each reader can already browse in Jira

The split is deliberate and structural. Findings, thresholds, job control, the access
pillar and the people roster are admin-only — not hidden from the macro UI, but *not
registered on the macro's resolver at all*, so a crafted `invoke()` from the macro iframe
fails to resolve rather than executing.

---

## The rule the whole product is built on

**A thing nobody measured is reported as unknown, never as zero.**

Zero is what makes a field look safe to delete. A status with no issues looks retired. A
scheme with no projects looks unused. So Observatory only ever shows a zero when a scan
actually looked and found none — and when it has not looked, it says so, in those words, on
that number, in that place.

This is why the app has tri-states almost everywhere something else would have a count, why
the Deletion Safety view can return `NO_EVIDENCE` but never "safe to delete", and why the
automation pillar refuses to call a field unreferenced until you have imported your rules.
It is also the single most common reason a number here differs from a number somewhere
else: the other tool counted a gap as a zero.

---

## What problem it solves

Jira sites accumulate configuration for years and nobody can answer basic questions about
it without a spreadsheet and a week:

- Which of these 480 custom fields is anyone actually using, and where?
- If I delete this field, what breaks — screens, filters, dashboard gadgets, automation rules?
- Which statuses are duplicates of each other with different spellings?
- Which projects share a workflow scheme, so a "small change" hits eleven teams?
- Who is licensed, who has not logged in for a year, and who is the only admin on a project?
- What changed in this site's configuration last week, and who changed it?

Observatory answers these by crawling the site once, storing the result as a versioned
snapshot, running pure analysis over the stored rows, and surfacing the results as
inventories, findings, cross-signals and a site health score.

---

## Getting started

The first run is deliberately front-loaded: the app is not useful until a scan has walked
the estate, and on a real site that is a multi-hour job. The Overview opens with a
**Getting started** panel that tracks five steps and then retires itself. Three of those
steps are derived from the estate on every read rather than stored as flags, so the panel
cannot congratulate you on a scan that did not happen.

1. **Run the first scan.** Admin page → Scans → Full scan. Fifteen stages, run on
   Atlassian's servers; you can close the tab. Everything except the issue crawl finishes in
   minutes.
2. **Understand "not measured".** The rule above. Every screen in the app depends on the
   distinction.
3. **Import your automation rules.** Jira publishes no API that lets an app read automation
   rules, so this one is exported from Jira and uploaded. Until you do, Observatory will not
   claim a field or status is unreferenced — it will say unknown.
4. **Set a scan schedule.** A quick scan re-reads everything except the full issue crawl.
   Without one, every number ages until somebody runs a scan by hand.
5. **Share the Confluence macro.** It is how this stops being a tool one person opens.

While the first scan runs, the same panel doubles as an **arrivals board**: each of the
fifteen stages lands separately, with what it produced and a link straight into the section
it filled. Workflows and screens are readable long before the issue crawl finishes.

---

## The seventeen pillars

Each pillar is an inventory, a set of governance findings, a Rovo agent, and one or more
dimensions in the site health score. A pillar that has not been scanned reports itself
unmeasured rather than scoring zero.

| Pillar | What it inventories | Weight |
|---|---|---|
| Fields | Custom field catalog, contexts, per-project usage, populated issue counts | 1.5 |
| Workflows & statuses | Schemes, their projects, the status catalog, two usage measures per status | 1.5 |
| Automation | Rules, their references, cascades, blast radius, plaintext-credential hits | 2 |
| Permission schemes | Grants, holders, project assignments | 1.5 |
| Screens | Screens, tabs, fields, screen schemes and the issue-type screen scheme chain | 1 |
| Issue types | The type catalog and the schemes that gate which types a project may use | 1 |
| Projects | Adoption, activity, scheme siblings, administrability | 1 |
| Filters | Saved filters, their JQL, shares, and the fields and statuses each references | 1 |
| Dashboards | Dashboards, gadgets, shares, and gadget → filter → field resolution | 1 |
| Boards | Agile boards, their columns, filters and unmapped statuses | 1 |
| People | The licensed roster, access groups, activity, orphaned ownership | 1 |
| Issue security | Security schemes and their levels | 1 |
| Project roles | Roles and their actors, per project | 1 |
| Assets (CMDB) | Schemas, object types and attributes — JSM Premium only | 1 |
| Priorities & resolutions | The two global value lists every issue draws on | 0.5 |
| Notification schemes | Notification events and recipients | 0.5 |
| Configuration drift | Pass-over-pass change history across every tracked entity | 1 |

Weights are the pillar's contribution to the site health score. Automation is heaviest
because a plaintext credential in an automation rule is the highest-consequence thing this
app finds anywhere. Configuration drift is the one exception to "pillar weight, defect
score": it does not score a problem, it scores a *rate of motion* — how much of the tracked
estate changed in the trailing window. High is not bad on its own; it means an admin is
looking at a moving target, which is worth surfacing before anything else on this page is
trusted at face value.

### Cross-signals

Some findings only exist where two pillars meet, and these are the ones an admin cannot
reproduce by hand:

- **Deletion safety** — for one field, the verdict across usage, screens, automation,
  filters, dashboards and the RQT index. Three outcomes: `IN_USE`, `NO_EVIDENCE`, `UNKNOWN`.
  Never "safe to delete"; a test asserts that string appears nowhere in the module.
- **Invisible data** — a field carrying values on issues in a project where no screen in
  that project's chain displays it. The data is there and nobody can see it.
- **Form clutter** — the inverse: a field on a project's screens that has never been
  populated in that project.
- **Unreachable fields** — configured for a project but on no screen in its chain, so
  nobody can ever fill it in.
- **Automation blast radius** — which projects a rule actually reaches, rather than which
  project it is filed under.
- **Config drift** — pass-over-pass diffs of the structural configuration, so "what changed
  last week" is a query rather than an archaeology exercise.

Projects whose screen chain did not fully resolve are excluded from the screen
cross-signals entirely rather than reported as clean — a partial traversal would otherwise
manufacture "invisible data" findings out of a permissions gap.

---

## The two surfaces

### Jira admin page — 19 sections

`Overview` · `Field Browser` · `Project Usage` · `Workflows` · `Issue Types` ·
`Priorities` · `People` · `Assets` · `Access` · `Screens` · `Saved Filters` ·
`Dashboards` · `Boards` · `Automation` · `Remediation` · `Reports` · `Changes` · `Scans` ·
`Configuration`

**Overview** carries the getting-started panel, the site health score with its per-pillar
breakdown, and the governance ledger. **Scans** is the pipeline control room: per-stage
progress, produced counts, job tokens, per-item logs, and start/cancel/resume for the full
scan, quick scan, RQT index and field usage jobs. **Changes** is the configuration
timeline. **Configuration** holds every governance threshold and health tolerance, macro
access groups, read-only mode, and retention settings.

**Remediation** turns a governance finding into a real Jira issue in a project you
nominate, one epic per finding and one task per item, synced from Jira three times a business day so status
here stays current, and remembers which items already have a task so the same cleanup is
never raised twice. Every governance finding that has an item-level source behind it is
connected to a playbook — fields, workflows, boards and people included, not only the two
ownership findings the first version shipped with. Its **Progress** view charts the burn-down against
quarter end, closures per week, time to close and the age of open work; **Findings** can be
searched by finding, task summary or issue key and filtered by pillar and state.

### Confluence macro — 9 sections

`Fields` · `Projects` · `Screens` · `Issue types` · `Workflows` · `Boards` · `Filters` ·
`Dashboards` · `Report`

The macro is for the people who ask admins questions. Every project-scoped section is
filtered to the projects the *viewer* can browse in Jira, established by calling Jira as
the user — so two people reading the same Confluence page see different project lists.

A viewer who can browse no projects at all sees those sections **disabled with a reason
attached**, not hidden. A section that silently disappears reads as a missing feature and
gets raised as a bug; one that is present, dimmed and says why is the difference between
"this app is broken" and "you cannot browse any project that has one". The reason lands on
`title` and on `aria-description`, so it reaches a screen reader too.

Findings, thresholds, the access pillar, the people roster and automation insights are not
in the macro. Access schemes and the roster are a disclosure risk on a page anyone in
Confluence can open, and automation findings include plaintext-credential hits.

---

## Rovo AI agents

One agent per pillar, keyed `observatory-<pillar>-expert`. Eleven of them. Each has the
same shape:

- **`search-<pillar>`** — ranked matches for a name or phrase
- **`inspect-<pillar>`** — the full governance detail for one entity
- **`<pillar>-impact`** — "what references this / what breaks if I change it", where the
  pillar can answer it

Every action returns the snapshot's `refreshedAt` and an explicit `*-unavailable` status
rather than an empty result — an agent that answers "no rules reference that field" when
the automation pillar was never imported is worse than one that declines. Keys are listed
in `ROVO_AGENTS` (`static/src/utils.js`) and must match the `rovo:agent` entries in
`manifest.yml`; prompts live in `resource/agent/prompts/`, each starting from the shared
preamble. In the UI every "Ask Rovo about …" button is the shared `<AskRovo>` primitive,
whose tooltip names the agent and states that Rovo answers from the latest snapshot and
never changes Jira. All read-only; no `write:*` scope.

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
  ├── resolver              index.handler        macro invoke()  — shared functions only
  ├── admin-resolver        index.adminHandler   admin invoke()  — shared + admin-only
  ├── snapshot-consumer     index.consumeSnapshot        queue consumer, 900s timeout
  ├── auto-snapshot         index.autoSnapshotCheck      scheduled trigger, daily
  ├── quick-scan-scheduler  index.quickScanScheduleCheck scheduled trigger
  ├── retention-cleanup     index.runRetentionCleanup    scheduled trigger, weekly
  ├── rovo-*                29 Rovo agent action handlers
  └── sql-migrate           index.runProjectStorageMigrations

Storage
  └── @forge/sql (MySQL) — 88 tables, 157 migration steps
```

Two resolvers, one codebase. `SHARED_RESOLVER_FUNCTIONS` are registered on both handlers;
`ADMIN_ONLY_FUNCTIONS` only on `adminHandler`, and are wrapped in the admin guard *at the
point of export* — so an admin-only function is guarded by construction rather than by
remembering to add a check. New mutating functions belong in the admin set.

### Module layout

```
src/
  index.js                 Forge entry points: resolvers, consumers, triggers, Rovo actions
  resolvers.js             every resolver, and the two registries that divide them
  lib/
    store/                 storage layer, split by domain — import these directly
      core.js              sql handle, schema, migrations, shared helpers (no domain imports)
      snapshot.js          field snapshots and per-project usage
      scan.js              universe and delta scan state
      workflow.js  screen.js   issuetype.js  access.js  boards.js  asset.js
      user.js      filter.js   dashboard.js  estate.js  drift.js   health.js
      automation.js  remediation.js  rqt.js
      reports.js           saved reports and async report jobs
      audit.js             privileged-action record
    project-store.js       barrel re-exporting the above (compatibility, not the entry point)
    *-engine.js            the crawlers: one per pillar, all resumable
    *-insights.js          pure analysis over loaded rows — no I/O, fully unit-tested
    full-scan.js           the stage list
    full-scan-runner.js    the orchestrator: stage order, handoff vs inline, resume, sweeps
    health-score.js        50 dimensions, 16 pillars, the site score
    jira-api.js            adaptive-concurrency Jira client
    logger.js              structured logging and the two named-degradation helpers

static/src/
  main.jsx                 the Confluence macro shell
  admin.jsx                AdminApp composition only
  tabs/                    one module per admin section, components individually exported
  components/ui.jsx        shared presentation primitives used by both surfaces
  components/admin/        admin-only primitives, panels, the first-run panel
```

Domain store modules import from `core.js`; `core.js` imports none of them. One arrow, so
there are no cycles to reason about. The `*-insights.js` modules are import-free by design,
which is what lets several of them run in the browser bundle as well as the backend.

### Error handling

Two helpers in `src/lib/logger.js` replace anonymous `.catch(() => value)` handlers, and
the distinction between them is deliberate:

| Helper | Level | Use when |
|---|---|---|
| `fallbackOn(event, fallback, context)` | `warn` | A read degrades to a default. The caller is about to treat a fabricated value as real data. |
| `ignoreWith(event, context)` | `debug` | A cleanup write fails while another error is already being handled and there is nothing further to do. |

Anonymous handlers are not acceptable in new code. Degrading gracefully is right; degrading
*invisibly* is what turns a bug into a mystery — a failed count once rendered as a confident
`Site-wide issue count: 0` on a site holding 317,907 issues. Silence is still available, but
it has to be named, which forces the author to say what was lost.

---

## The scan

A **full scan** is fifteen stages, run in dependency order by `full-scan-runner.js`:

```
workflows → screens → filters → dashboards → fields → status-history → issue-types
→ access → estate → boards → people → assets → issues → drift → health
```

A **quick scan** is fourteen: the same list with `fields` and `issues` collapsed into a
single `issues-delta` stage narrowed to issues updated recently.

Every stage is one of two kinds. An **inline** stage runs inside the orchestrator's
invocation because it fits. A **handoff** stage enqueues itself onto the snapshot queue and
reports progress back — the issue crawl is the obvious one, but so is any traversal whose
cost scales with project count. Both follow the same resumability contract: write a resume
token, re-enqueue, pick up where you left off. Nothing depends on completing inside one
invocation, and the orchestrator will take a second sweep over stages that failed.

**The issue crawl** is the expensive part and the reason the first run is measured in
hours. Rather than one issue search per field — hundreds of round trips on a large catalog —
it walks the issue corpus once with parallel workers over partitioned key ranges, tallying
as it goes: which fields are populated in which projects, issues per status per project,
issues per type, per-project activity, per-user activity, priority and resolution
distribution. Workers buffer into staging tables and flush periodically; a promote step
folds the buffer into the live tables. Adding a counter to this pass costs nothing extra in
Jira calls, which is why several pillars get their numbers for free.

**Two usage measures per status**, deliberately kept separate because different jobs produce
them and they refresh independently:

| Measure | Source | Meaning |
|---|---|---|
| Currently in | issue crawl | Issues sitting in the status now |
| Ever been in | JQL `status WAS <id>` | Issues that have ever entered it |

The gap between them is the signal: a status with no current issues but tens of thousands
historically is a stage people escaped, not one nobody uses. `WAS` is queried by status ID,
never name — on a site with `Done` defined five times, `status WAS "Done"` gives one
meaningless total.

### Rate limiting

Jira API calls go through an adaptive concurrency controller. It starts at a configured
concurrency and request interval, backs off exponentially on 429s (honouring `Retry-After`
when present, with a cooldown window), and eases the interval back down on streaks of
success. Requests carry a hard timeout so a hung call cannot hold a concurrency slot
indefinitely — slots are released on the failure path as well as the success path.

State is module-level within a single consumer invocation, so each invocation re-learns the
site's tolerance rather than inheriting a stale estimate.

### Permission filtering

Project-level data is filtered by the viewer's own Jira permissions, not the app's. Reads
that return per-project data call Jira *as the user* to establish which projects they can
browse, then intersect the cached results against that set. Two people looking at the same
snapshot see different project lists if their permissions differ.

---

## Governance findings

Each pillar contributes its own findings from a pure `*-insights.js` module. The field
rules are the oldest and the most tuned; they are computed by `buildGovernanceFindings()`
in `src/lib/analysis.js` and stored as a JSON blob per field. Thirteen rules, in evaluation
order:

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

Every threshold in that table is admin-tunable from the Configuration section; the defaults
live in `DEFAULT_GOVERNANCE_THRESHOLDS` at the top of `analysis.js`. A field is flagged
**Admin Attention** if any finding is High severity, or if the combined priority score
reaches **35**.

Two deliberate exclusions worth knowing about:

- Most rules skip system fields — a Jira built-in is not a governance problem, and flagging
  Summary as "broadly scoped" is noise. `System field with no recorded usage` is the one
  rule that targets them.
- The staleness rule requires at least one populated issue, so it does not double-count
  fields the orphaned and unpopulated rules already flag. It means "this *was* used and then
  everyone stopped", not "this is empty".

**Staleness has a data-coverage limit.** The rule reads
`snapshot_project_usage.latest_field_change_at`, which is populated only by per-field
summary builds. The issue crawl writes `NULL` there, and the rule treats a missing date as
"unknown" rather than "not stale" — so on a site whose usage came from a crawl alone, it
stays silent for most fields. That is correct behaviour under the rule at the top of this
README, not a bug, but it caps the rule's reach.

**Duplicate statuses** are reported in three kinds rather than one, because they carry
different confidence: the same name defined more than once, names differing only by spacing
(`Back Log` / `Backlog`), and single-character spelling variants (`Cancelled` / `Canceled`).
Enumerated series are deliberately excluded — `CP3/CP4/CP5 Sign Off Complete` are one edit
apart and completely distinct, so a pair that becomes identical once digits are removed is
never grouped.

### Site health score

`computeSiteHealth` scores 50 dimensions across the 16 pillars. A dimension is scored one of
two ways: against a **target band** with a tolerance either side, or as a **rate** where any
non-zero is a problem. Each carries a blast multiplier — how many people or projects the
dimension's failure actually reaches — and a direction adjustment, so a pillar moving the
wrong way is marked down even while it is still inside its band.

A dimension whose inputs were never measured contributes **nothing**, in either direction.
It does not score zero and it does not silently score full marks; the pillar reports how
many of its dimensions are unmeasured, and the site score is computed over the rest.
Scores are written to `health_history` on every scan, so the score has a trend.

---

## SQL schema

86 tables managed by a 155-step migration runner (`@forge/sql` + `migrationRunner`). All
tables are namespaced by `scope_key`, derived from the Forge site context.

**Every `ADD COLUMN` migration is written `IF NOT EXISTS`, without exception.** The
`CREATE TABLE` constants describe each table's *current* shape, so a column added later
appears in both the CREATE and a later ALTER. On an existing database the ALTER does the
work; on a fresh one the CREATE already produced the column and a bare ALTER fails with a
duplicate-column error, halting the runner so every later migration never runs. This was not
hypothetical — it made every fresh install fatal until it was fixed, and went unnoticed only
because every environment had a pre-existing database.
`project-store.schema.test.js` enforces the rule mechanically.

Table families, roughly:

| Family | Tables | Notes |
|---|---|---|
| Field snapshot | `snapshot_fields`, `snapshot_project_usage`, `snapshot_meta`, `field_summaries`, `field_options_cache` | One row per field per snapshot version; usage is one row per field/project pair |
| Issue crawl | `issue_scan_meta`, `issue_scan_workers`, and the buffer/totals tables | Workers stage into buffers; a promote step folds them into the live tables |
| Workflows | `snapshot_workflow_schemes`, `snapshot_workflow_scheme_projects`, `snapshot_statuses`, `status_history_totals` | |
| Screens | `snapshot_screens`, `snapshot_screen_tabs`, `snapshot_screen_fields`, `snapshot_screen_schemes`, `snapshot_issue_type_screen_schemes`, `screen_cross_summary` | The full project → ITSS → screen scheme → screen → tab → field chain |
| Access | `snapshot_schemes`, `snapshot_scheme_holders`, `snapshot_scheme_levels`, `snapshot_scheme_projects` | One table set discriminated by `scheme_type`, covering permission, issue-security, notification and project-role schemes |
| Automation | `automation_rules`, `automation_references`, `automation_findings`, `automation_cascades`, `automation_rule_blast`, `automation_rule_projects` | Built from an uploaded export, not a crawl |
| Filters & dashboards | `snapshot_filters`, `snapshot_filter_refs`, `snapshot_filter_shares`, `snapshot_dashboards`, `snapshot_dashboard_gadgets`, `snapshot_dashboard_shares` | `snapshot_filter_refs` is what makes field → filter → dashboard resolvable |
| Drift | `snapshot_entity_digest`, `config_change_log` | Digest per entity per pass; the log is the diff |
| RQT index | `rqt_field_index`, `rqt_field_issue_index`, `rqt_value_issue_index`, `rqt_issue_keys` | Site-specific `RQT-<n>-<n>` tokens that live inside field *values* |
| Operations | `full_scan_meta`, `full_scan_runs`, `health_history`, `remediation_tickets`, `audit_log`, `saved_reports`, `report_jobs` | |

Snapshot tables carry a `version` column so a new snapshot builds in parallel with the
active one and swaps atomically on completion. Old versions are pruned inline after each
successful build.

---

## Tech stack

| Layer | Technology |
|---|---|
| Platform | Atlassian Forge — Custom UI macro + `jira:adminPage` |
| Runtime | Node.js 22.x |
| Frontend | React 18, Vite (dual bundle) |
| Storage | `@forge/sql` (MySQL) |
| Queue | `@forge/events` |
| AI | Atlassian Rovo agents + actions |
| Tests | Vitest (Node + jsdom projects), `@vitest/coverage-v8` |
| CSS | Custom design system with CSS variables — no component library |
| Charts | Recharts |
| Icons | Phosphor Icons |

---

## Permissions

Observatory requests a lot of read scopes because it reads a lot of configuration. Granular
Jira scopes are **conjunctive** — an endpoint needs every scope in its own list, not any one
of them — so each pillar's endpoints pull in their own set. `manifest.yml` carries a comment
against each group explaining which endpoint needs it and why.

| Group | Scopes |
|---|---|
| Fields | `read:field:jira`, `read:field-configuration:jira`, `read:custom-field-contextual-configuration:jira`, `read:issue-meta:jira` |
| Issues | `read:jira-work`, `read:issue.changelog:jira` |
| Projects | `read:project:jira`, `read:project-category:jira`, `read:avatar:jira` |
| Workflows | `read:workflow:jira`, `read:workflow-scheme:jira`, `read:status:jira` |
| Screens | `read:screen:jira`, `read:screen-tab:jira`, `read:screenable-field:jira`, `read:screen-scheme:jira`, `read:issue-type-screen-scheme:jira` |
| Issue types | `read:issue-type:jira`, `read:issue-type-scheme:jira` |
| Access | `read:permission-scheme:jira`, `read:issue-security-scheme:jira`, `read:issue-security-level:jira`, `read:notification-scheme:jira`, `read:project-role:jira`, `read:permission:jira`, `read:group:jira` |
| People | `read:jira-user`, `read:user:jira`, `read:application-role:jira` |
| Filters & dashboards | `read:filter:jira`, `read:dashboard:jira`, `read:dashboard.property:jira` |
| Estate | `read:priority:jira`, `read:resolution:jira` |
| Assets | `read:cmdb-*`, `read:servicedesk-request`, `read:servicemanagement-insight-objects` |
| Platform | `manage:jira-configuration`, `read:confluence-content.summary`, `read:chat:rovo`, `storage:app` |
| **Write** | **`write:jira-work`** |

Two scopes are worth explaining on any install-consent review, for opposite reasons.

`manage:jira-configuration` is the broadest scope requested and the one that looks most
alarming — but it is the scope Forge requires to surface an admin page at all, and the
Jira-admin gate several read endpoints check, not a capability the app exercises.
Observatory changes no Jira configuration through it.

`write:jira-work` is smaller-looking and is the one that's actually true: it backs
**remediation ticketing**, which creates a Jira issue — an epic and its tasks — in a
project you nominate, behind an explicit button, gated on Jira `ADMINISTER`, blocked when
read-only mode is on, and audited. It is the only write Observatory makes anywhere. Every
other data path in the app is read-only against Jira; every other write goes to the app's
own SQL store.

---

## Development

```bash
npm install
npm run build       # dual Vite build → static/dist (macro) + static/dist-admin (admin page)
npm run deploy      # build, then forge deploy
forge install       # install on a site (first time only)
```

The frontend is a Vite project rooted at `static/`, built twice: once for the Confluence
macro (`static/dist`) and once for the Jira admin page (`static/dist-admin`). The backend
entry point is `src/index.js`.

`forge deploy` does **not** rebuild the Vite bundles — always run `npm run build` first, or
use `npm run deploy`, which chains both. Pushing to `master` auto-deploys to
**development** only; staging and production are manual. See `RUNBOOK.md`.

Conventions that CI and review enforce are in `CLAUDE.md` — in particular: build new UI
from the shared primitives rather than hand-rolling a widget that exists, every pillar gets
exactly one Rovo agent, every new pillar is wired into `computeSiteHealth` rather than
shipping as an inventory tab alone, and every change needs frontend *and* backend tests.

---

## Testing

```bash
npm test              # unit + component tests (backend and frontend projects)
npm run test:backend  # backend only
npm run test:frontend # frontend only
npm run test:coverage # with coverage report
```

Tests are colocated with their source (`src/lib/analysis.test.js` sits next to
`analysis.js`). The suite is split into two Vitest projects — `backend` runs in Node,
`frontend` in jsdom with `@forge/bridge` aliased to a mock.

Coverage thresholds are enforced in `vitest.config.js` and set just below current actuals,
so they act as a ratchet: coverage can rise freely, but a drop fails the run. Per-file
floors pin the modules whose failure modes are hardest to diagnose in production —
`src/lib/jira-api.js` (rate limiting, retry, cursor pagination), `src/index.js` (the queue
job router, where an unrecognised job type would otherwise fail silently),
`src/lib/report-engine.js`, and `src/resolvers.js`, which holds the authorization boundary:
a regression there is a security regression, not a coverage statistic.

The storage layer is tested directly rather than only through its callers. Every other
suite mocks `project-store` wholesale, so nothing exercised the real SQL construction or row
mapping — which is exactly where a wrong column alias or an unscoped `DELETE` hides.
`project-store.crud.test.js` and `project-store.writes.test.js` assert query shape and row
mapping against a mocked Forge SQL, including that **every `DELETE` carries a `scope_key`
predicate** — in a multi-tenant Forge app an unscoped delete destroys another customer's
data, and no test that mocks the store could ever catch one.

Raising the thresholds is a deliberate edit to that config, not something that happens by
accident.

---

## App identity

- **App ID:** `ari:cloud:ecosystem::app/c11559cd-90ed-43a7-9a9b-80866237cd15`
- **Macro key:** `atlasiq-custom-field-governance-macro`
- **Queue:** `inventory-snapshot-queue`
- **Rovo agents:** `observatory-<pillar>-expert` × 11
