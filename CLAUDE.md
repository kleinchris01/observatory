# Observatory — working conventions

## UI: build on the shared primitives

**Every new tab, panel or feature is built from the shared primitives. Do not hand-roll a
widget that already exists.**

`static/src/components/ui.jsx` is the home for anything used by more than one tab:
`StatTile`, `StatRow`, `PageHeader`, `Panel`, `Chip`, `EmptyState`, `BarList`,
`FindingRow`, `StickyActions`, `LinkButton`.

`static/src/components/admin/primitives.jsx` holds admin-only controls — `Toggle`,
`ConfigSection`, `ConfigRow`, `ThresholdInput`, `JobStatusBadge`, `SubNavLayout`,
`ActivitySection`. Admin-only means *only* the admin surface can use it; anything the macro
could also want belongs in `ui.jsx`.

Tab-local components stay in their tab. This is a shared vocabulary, not a dumping ground.

### Why this is a rule and not a preference

The codebase has twice grown a second dialect of the same widget. Stat tiles existed as
`scan-stat-card`, `rqt-stat`, `wf-insight-stat` and `admin-stat-row` before the first
consolidation; afterwards a second tile (`StatCard`) survived in `admin/primitives.jsx`
alongside `StatTile` and was only retired later. The result both times was the same: one
product that reads as three or four, because a metric row looks different depending on
which tab you are standing on.

Six of the ten tabs were, at one point, using no shared primitives at all. That is what
"Workflows looks nothing like Fields looks nothing like Automation" actually was — not a
styling drift, but three separate implementations of the same ideas.

### Before adding a component

1. Does `ui.jsx` already have it? Use it.
2. Does it need one more prop to work for you? Add the prop. That is why `StatTile` takes
   `hint` and `children`.
3. Is it genuinely used by more than one tab? Put it in `ui.jsx`.
4. Only one tab will ever want it? Keep it in the tab.

Never add a second component that does an existing component's job. If the existing one is
wrong, change it — every call site is in this repo.

### Tone vocabulary

`tone` carries meaning, not decoration. `neutral`, `success`, `active` (in flight),
`warning`, `critical`. Use `critical` only when a person should act on the value, or it
stops meaning anything.

## Testing

Every new feature or change needs frontend *and* backend tests. Coverage floors are
enforced in `vitest.config.js` and sit just under the actuals — CI fails on regression.
When a test mocks an error, use `mockRejectedValueOnce`, not `mockRejectedValue`, to avoid
cross-test bleed.

## Delivery

- `npm run build` before `forge deploy` — deploying alone does not rebuild the Vite bundles.
- Open a PR; never commit straight to `master`. CI gating and CODEOWNERS only engage on a PR.
- Push to `master` auto-deploys to **development** only. Staging and production are manual.
- Merging several PRs quickly races the deploy workflow against itself — it has no
  concurrency group. Let each dev deploy finish before merging the next.
- Do not merge a stacked PR with `--delete-branch` while another PR still targets its
  branch: GitHub closes the dependent PR and will not reopen it. Retarget the successor to
  `master` first.
