# Splitting `src/resolvers.js`

Status: **in progress** — PR 1 of 6 (foundation) is this plan's first delivery.
Owner: platform. Started 13 Oct 2026.

## Why

`src/resolvers.js` was 11,162 lines: 22% of all backend source in one file, 190 top-level
functions, 117 registered resolvers, and an 11,767-line test file to match. Everything below it
is already split by domain (`src/lib/store/*.js`, one engine per pillar); the resolver layer is
the one place every pillar still shares a file. The cost is review (every PR touches it),
merge conflicts (#201 and this refactor collided before either was written), and coverage that
can only be pinned for the file as a whole.

## The end state

```
src/resolvers.js            registry + public surface: imports each module, builds
                            SHARED_RESOLVER_FUNCTIONS / RAW_ADMIN_ONLY_FUNCTIONS, applies
                            withAdminGuard(withAuditTrail(...)) once, re-exports what
                            index.js and full-scan-runner.js import. ~500 lines.
src/resolvers/<module>.js   the resolvers and helpers for one domain, verbatim.
```

`resolvers.js` stays the single entry point. `index.js`, `full-scan-runner.js` and every test
keep importing from it, and `index.test.js` keeps mocking it wholesale. Nothing outside
`src/resolvers*` changes during the split.

## Rules for every move PR

1. **Code moves; it does not change.** A move PR contains no edits to moved code — not a
   rename, not a reformat, not a fixed typo. Behaviour changes go in their own PR, before or
   after.
2. **The public surface is identical.** `resolvers.js` exports exactly the names it exported
   before, and both registries hold exactly the same keys.
3. **Leaves first.** A module may import only from `src/lib/` and from modules already
   extracted. Nothing in `src/resolvers/` imports `../resolvers.js`. That rule is what keeps
   the split free of import cycles, and the move tool enforces it.
4. **Comments travel with their code; file-level notes stay.** The PII / data-retention note
   stays at the top of `resolvers.js`.
5. **Coverage moves with the code.** `src/resolvers/**` is in the coverage `include`. A module
   that holds a security or correctness boundary gets a per-file floor pinned at its actuals.
6. **One dev deploy between merges.** The deploy workflow has no concurrency group. Let it
   finish before merging the next PR.

## Tooling (`scripts/refactor/`)

| Script | What it does |
| --- | --- |
| `move-declarations.mjs` | Cuts named top-level declarations (with their comments) out of `resolvers.js` into a new module, adds `export`, generates the module's imports from what its code references, imports back and re-exports in `resolvers.js`, and drops imports that became unused. **Refuses** if the moved code depends on something that would stay behind (cycle), and **stops** when a declaration carries more than one comment group so a person decides where each goes (`--leave-comments`, `--accept-comments`). `--dry-run` reports without writing. |
| `verify-split.mjs` | Compares `resolvers.js` at `--base` (default `master`) against the working tree's `resolvers.js` plus `src/resolvers/**`. Fails unless every declaration exists exactly once with **byte-identical** source (apart from an added `export`), none is new, and the export surface is identical. |
| `resolver-ast.mjs` | Shared Babel parsing for the two. `@babel/parser` and `@babel/traverse` are pinned dev dependencies, at the versions Vite already installs. |

Plus `src/resolvers/registry.test.js`, which loads the **real** `resolvers.js` and fails if any
registry entry or named export is `undefined` — the quiet failure a cycle produces, and one
`index.test.js` cannot see because it mocks the module.

### Checklist for each move PR

```
node scripts/refactor/move-declarations.mjs --dry-run --to src/resolvers/<m>.js --names ...
node scripts/refactor/move-declarations.mjs --to src/resolvers/<m>.js --header "..." --names ...
node scripts/refactor/verify-split.mjs           # paste the OK line into the PR description
npm test                                         # full suite, both projects
npx vitest run --coverage                        # floors hold; pin new boundary modules
npm run build                                    # both Vite bundles
```

## Order

Levels come from the dependency graph of every top-level declaration (no cycles between
modules). Sizes are lines of code including comments.

| PR | Modules | Lines | Depends on |
| --- | --- | ---: | --- |
| **1** | `admin-config`, `viewer`, `macro-access`, `admin-guard` — the foundation every other module imports | 570 | — |
| **2** | `issue-types`, `people`, `access`, `assets`, `boards`, `changes`, `estate`, `rqt`, `macro` — small pillar leaves | 1,340 | 1 |
| **3** | `filters-dashboards`, `screens`, `automation`, `fields` | 2,100 | 1 |
| **4** | `workflows`, `deletion-safety`, `project-usage`, `scans` | 2,330 | 3 |
| **5** | `overview`, `reports` (pillar health, pillar report, OQL), `project-overview`, `remediation` | 2,110 | 2, 3, 4 |
| **6** | `rovo` — sits on top: its actions call 13 of the UI resolvers | 1,315 | 2–5 |

After PR 6, `resolvers.js` holds the imports, the PII note and the two registries.

Notes on specific moves:

- **Rovo goes last, not first.** It looks like the easiest module (one export per action) but it
  is the top of the graph: `rovoAccessInspect` calls `getAccessInventory`, `rovoProjectInspect`
  calls `getProjectOverview`, and so on.
- `loadActiveRoster` (declared among the Rovo actions) moves with `access`;
  `loadAutomationForAgent` and `ruleDirectoryMap` move with `automation`;
  `loadWorkflowForAgent`, `statusRow`, `computeStatusDetail`, `getStatusDetail` move with
  `workflows`. Each is used by a non-Rovo resolver.
- `computeBoardStatusIds` moves with `workflows`; boards, remediation and Rovo import it.
- The `REMEDIATION_CANDIDATE_LOADERS` table and the statement that extends it move together.
- `full-scan-runner.js` reaches `captureSiteHealthForScan`, `runDeltaIssueScanJob` and
  `DELTA_SCOPE_SUFFIX` through dynamic `import("../resolvers.js")` to dodge a cycle. The
  re-exports keep that working. After PR 4 it can import from `./resolvers/scans.js` directly,
  which removes the cycle the comment there describes — a separate, behaviour-neutral PR.

## After the split

Each of these is its own PR and may change behaviour, so each comes with tests.

1. **One wrapper for resolver boilerplate.** 119 resolvers repeat `incrMetric(resolver)`, a
   try/catch that logs and rethrows with `resolverFailed`, and `getInstallationKey(context)`.
   A `defineResolver(name, fn)` in `src/resolvers/define.js` should remove on the order of
   1,000 lines and makes failure metrics uniform. Convert one module per PR; catch blocks that
   do something other than log-and-rethrow (fail-open checks, fallbacks) stay hand-written.
2. **Pure logic into `src/lib`.** `REMEDIATION_CANDIDATE_LOADERS` (149 lines) and the
   `getAdminOverview` aggregation (203 lines) are domain logic, not request handling. They move
   beside `remediation-playbooks.js` and `dashboard-engine.js`, where they can be tested
   without resolver mocks.
3. **Split `resolvers.test.js`** to one test file per module. The shared `vi.mock` block moves
   to a helper so each file does not repeat 300 lines of setup. Per-module coverage floors
   replace the one on `resolvers.js`.
4. **Ratchet the global coverage floors.** Actuals are 86.7% lines / 73.2% branches /
   78.7% functions against floors of 78 / 64.5 / 67. CLAUDE.md says floors sit just under
   actuals; today a regression of about 8 points passes CI. Independent of the split — can
   land any time.

## Other large files (not in scope here)

| File | Lines | Suggested split |
| --- | ---: | --- |
| `src/lib/store/core.js` | 2,614 | migrations (to v183) into their own folder, one file per range |
| `src/lib/jira-api.js` | 2,227 | per Jira API family: platform, agile, automation, Assets |
| `static/src/tabs/ScansTab.jsx`, `components/ProjectsTab.jsx`, `components/OverviewDashboard.jsx` | 1,600–1,730 each | per-section components in the tab's folder; shared pieces to `ui.jsx` |

The same tools work for `core.js` and `jira-api.js` with the source path made a flag.
