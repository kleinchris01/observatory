# Observatory — Jira Custom Field Governance

[![Coverage](https://img.shields.io/badge/coverage-63.6%25-yellow)](#testing)
[![Tests](https://img.shields.io/badge/tests-934%20passing-brightgreen)](#testing)

<!--
  These badges are static. There is no coverage service wired up, so the numbers
  here are updated by hand — run `npm run test:coverage` and edit them.

  The enforced floor lives in vitest.config.js under coverage.thresholds and is
  set just below the actuals, so CI fails if coverage drops. Treat that as the
  source of truth; these badges are a summary of it.
-->

Observatory is an Atlassian Forge Confluence macro that gives Jira admins a live, searchable inventory of every custom field on their site — with per-project usage data, automated governance findings, multi-field reports, and an AI assistant — all embedded directly in a Confluence page.

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

### Inventory tab
A paginated, searchable, filterable list of every Jira custom field on the site. Each field card shows:
- Field ID, name, type, and admin description
- Configured project count, active project count, total populated issues
- **Governance findings** — automated signals (see [Governance findings](#governance-findings))
- Expandable detail view with per-project usage breakdown, JQL deep-links, and Rovo AI integration

Filters: free-text search, field type, sort order, project usage state, max issues cap. A findings filter bar narrows instantly to fields flagged for admin attention, risk, cleanup, or standardization.

### Projects tab
Switch between every project that has cached field usage. For each project:
- Fields with populated values on that project, paginated and filterable
- Two inline charts: top fields by issue count (horizontal bar chart), field type distribution (SVG donut)
- JQL deep-link for every field/project pair

### Snapshot Log tab
Live view of a running snapshot build — processed field count, progress percentage, job token, and a scrollable log of per-field processing events.

### Project Usage Jobs tab
Tracks the async per-field project-usage scan jobs. Each job shows state (queued, building, ready, failed, cancelled), progress, and error detail. Jobs can be restarted, refreshed, or cancelled individually.

### Report tab
Generate a cross-field comparison report for any set of selected fields. Reports are paginated by field type, show per-project breakdowns, and can be filtered by field type or project name. Reports can be named and saved for later recall. CSV export is supported.

### Rovo AI agent
An embedded Rovo agent ("Observatory Field Expert") with two callable actions:
- **Search field catalog** — natural-language search over the snapshot
- **Inspect field governance** — detailed breakdown for a specific field, by field ID or name

---

## Architecture

```
Confluence page
  └── Forge macro iframe (React SPA)
        ├── @forge/bridge  invoke() → backend resolver
        └── view.setAutoResizing(true)  iframe grows to content height

Forge backend (Node.js 22)
  ├── resolver          index.handler               UI invoke() calls
  ├── snapshot-consumer index.consumeSnapshot        queue consumer, 900s timeout
  ├── rovo-search-fields index.rovoSearchFields       Rovo agent action
  ├── rovo-inspect-field index.rovoInspectField       Rovo agent action
  └── sql-migrate       index.runProjectStorageMigrations

Storage
  └── @forge/sql (MySQL) — 6 tables, 27 migrations
```

### Data pipeline

**1. Snapshot build**
User clicks "Build snapshot" → job enqueued on `inventory-snapshot-queue` → `consumeSnapshot` calls the Jira REST API to fetch all custom fields, their contexts, and configured project scopes → results written to `snapshot_fields` and `snapshot_meta` in batches.

If the consumer hits the 900 second timeout, it writes a resume token and re-enqueues itself. The next invocation picks up where it left off. This makes the snapshot resumable across arbitrarily large field catalogs.

**2. Field summary deep scans**
After the snapshot, per-field deep scans can be triggered from the UI. Each field runs a paginated Jira issue search (`field_summaries`) to count exactly how many issues have a populated value for that field, across all projects. These also use resume tokens for large fields.

**3. Project usage jobs**
A further enrichment layer that joins field usage data to individual projects. Results land in `snapshot_project_usage` — one row per field/project pair with issue count, JQL, and timestamps. Each field gets its own job, tracked in `field_summaries`.

**4. UI reads**
All reads go through `invoke()` to the resolver, which queries SQL and returns paginated, filtered, sorted results. No data is held in client state between page loads.

### Rate limiting

Jira API calls use an adaptive concurrency controller: it starts at a configured concurrency level, backs off exponentially on 429 responses (with a cooldown window), and gradually reduces the interval on streaks of success. State is module-level within a single consumer invocation.

---

## Governance findings

Computed by `buildGovernanceFindings()` in `src/index.js` and stored as a JSON blob per field. Each finding has a category, severity, title, and detail string. The heuristics:

| Signal | Category | Severity | Trigger |
|---|---|---|---|
| High-impact field with broad live usage | Risk | High | ≥10 active projects AND ≥1,000 populated issues |
| App-provided field with heavy usage | Risk | Medium | App/plugin field with ≥500 issues |
| Configured field with no populated issues | Cleanup | Medium | ≥3 configured projects, 0 issues |
| Broadly scoped field with very light usage | Cleanup | Medium | ≥5 active projects, ≤100 issues |
| Similar field naming detected | Standardize | Medium | Duplicate normalized name across ≥2 fields |
| Actively used field lacks a description | Standardize | Medium | ≥5 active projects, no meaningful description |
| Per-project usage unavailable | Review | Medium | Jira API returned no usage data for the field |

A field is flagged **Admin Attention** if any finding is High severity, or if the combined priority score reaches 40.

---

## SQL schema

Six tables managed by a 27-step migration runner (`@forge/sql` + `migrationRunner`). All tables are namespaced by `scope_key` (derived from the Forge site context).

| Table | Purpose |
|---|---|
| `snapshot_fields` | One row per field per snapshot version. Stores metadata, usage state, context fingerprint |
| `snapshot_project_usage` | One row per field/project pair. Stores issue count, JQL, latest issue timestamps |
| `snapshot_meta` | One row per site. Tracks snapshot state (idle/queued/building/ready), job token, progress log |
| `field_summaries` | One row per field. Stores computed totals, governance findings JSON, scan progress |
| `saved_reports` | User-saved multi-field report results stored as JSON blobs |
| `report_jobs` | Tracks async report generation job state and results |

`snapshot_fields` and `snapshot_project_usage` use a `version` column so a new snapshot can build in parallel with the active one, then swap atomically on completion.

---

## Tech stack

| Layer | Technology |
|---|---|
| Platform | Atlassian Forge (Custom UI macro) |
| Runtime | Node.js 22.x |
| Frontend | React 18, Vite 5 |
| Storage | `@forge/sql` (MySQL) |
| Queue | `@forge/events` |
| AI | Atlassian Rovo agent + actions |
| CSS | Custom design system with CSS variables — no component library |
| Charts | Inline SVG + CSS — no chart library |
| Icons | Inline SVG paths (Lucide-style) — no icon library |

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
| `read:confluence-content.summary` | Macro host page context |
| `read:chat:rovo` | Rovo agent integration |
| `storage:app` | Forge KV storage (legacy state; SQL is primary) |

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
