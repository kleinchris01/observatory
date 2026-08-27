# Observatory Forge App — Operational Runbook

## Section 1: Universe Scan Recovery

The universe scan crawls Jira to count field usage across all projects. Its state is stored in `issue_scan_meta`.

### Detecting a stuck scan

A scan is considered stuck when `state` stays `"building"` for more than 2 hours. Check via the admin Overview tab — the progress log timestamps will have stopped advancing.

Signs of a stuck scan:
- `state: "building"` with no new `progress_log` entries
- Workers in `issue_scan_workers` all show `status: "done"` but finalization never completed
- `processed_pages >= total_pages` but `state` never transitioned to `"ready"`

### Recovery steps

1. **Resume scan button** — use the "Resume scan" button in the admin panel. This re-queues the coordinator from the last checkpoint without discarding buffer data.

2. **Force resume** — if Resume has no effect after a few minutes, use the "Force resume" button. This resets the job token and re-dispatches the coordinator regardless of current state.

3. **Cancel and restart** — writing `state: "cancelled"` stops all in-progress workers on their next poll. After cancellation, use "Start scan" to begin a fresh run. The `issue_scan_buffer` is cleared at the start of each fresh scan, so partial data from the cancelled run is discarded.

> The `"cancelled"` state is terminal — the scan will not auto-resume from it. You must explicitly restart.

### Full / Quick Scan orchestrator — stall recovery

The **Full Scan** and **Quick Scan** are driven by one orchestrator (`full-scan-runner.js`) that steps a stage machine by re-queueing itself between stages. If that self-re-queued message is lost — or a consumer is killed after starting a stage but before it re-queues the next step — the loop stops. The shared meta row (`readFullScanMeta`) stays `state: "running"` with a frozen `updatedAt`, and because `startScan` refuses to begin over a `"running"` row, **every subsequent full and quick scan silently no-ops** until it is cleared.

**Detecting it:** the Scans tab shows "Scanning — last update *N* ago" with the timestamp no longer advancing. A live loop writes `updatedAt` on every step, so more than ~20 minutes of silence on a `running` scan means the loop is dead, not busy (a legitimately long issue crawl keeps `updatedAt` fresh via its poll).

**Recovery, in order:**

1. **Automatic.** The hourly `quick-scan-scheduler-trigger` runs `recoverStalledScan` *before* its schedule check — so it fires even when scheduled quick scans are disabled. It detects `now − updatedAt > FULL_SCAN_STALL_MS` (20 min) and re-queues the orchestrator from its last checkpoint (`FULL_SCAN_STALL_MS` / `MAX_SCAN_RECOVERIES` live in `full-scan.js`). After 3 consecutive kicks with no forward progress it fails the run out to `completed-with-failures` rather than leaving it wedged. Worst-case wait: ~1 hour.

2. **Resume (stalled)** button — Scans tab, on either scan panel once the 20-minute stall notice appears. Calls `resumeSiteScan`, which force-recovers immediately without waiting for the trigger.

3. **Abandon scan** button — same notice. Calls `cancelSiteScan`, which writes the terminal `"cancelled"` state and drops the job token, freeing the shared row. Start a fresh scan afterward from the same panel.

`recoveryCount` on the meta row resets to 0 on every real stage transition, so it only climbs across *consecutive* stalls — a scan that recovers once and then runs normally is not penalised later.

---

## Section 2: Snapshot Build Recovery

The snapshot build enumerates all Jira custom fields and stores them in `snapshot_fields`. State is stored in `snapshot_meta`.

### Detecting a stuck snapshot

A snapshot is stuck when `state` stays `"building"` for more than 6 hours with no progress.

### Recovery steps

1. **Auto-requeue** — `autoSnapshotCheck` runs hourly. It detects builds stuck for more than 20 minutes and re-queues them from the last `processedFields` checkpoint. No manual action needed in most cases.

2. **Manual requeue** — go to the admin Config tab and click "Build snapshot now". This queues a new snapshot run that will resume from the last checkpoint if `buildingVersion` is set.

3. **State is `"failed"`** — the snapshot wrote a `lastError`. Check it in the admin Overview tab, fix any underlying issue (e.g. Jira connectivity), then re-trigger via the Config tab.

### Field summary job recovery

Each field can have an independent background summary job (`field_summaries.summary_status`).

**Detecting orphaned "building" summaries:**
- Go to the admin Jobs tab
- Any field showing `summary_status: "building"` that has not updated `refreshed_at` in over 2 hours is orphaned

**Restart:**
- Click "Refresh jobs" on the Jobs tab — this triggers `ensureFieldSummaryJobRunning` for all stale jobs, which re-queues from the last checkpoint (`processedIssueCount` / `nextPageToken`)
- If queue backpressure is the cause, retries happen automatically with exponential back-off

---

## Section 3: Database Health

### Key tables and expected growth

| Table | Key | Growth pattern |
|---|---|---|
| `snapshot_fields` | `(scope_key, version, field_id)` | ~N rows per snapshot; pruned automatically after each build |
| `snapshot_project_usage` | `(scope_key, version, field_id, project_id)` | Largest table; ~N×P rows per snapshot; pruned automatically |
| `issue_scan_meta` | `scope_key` | One row per installation; stable |
| `issue_scan_buffer` | `(scope_key, field_id, project_id)` | Temporary; should be empty between scans |
| `issue_scan_workers` | `(scope_key, worker_id)` | Reset at scan start; small and stable |
| `field_summaries` | `(scope_key, field_id)` | One row per field; stable |
| `field_options_cache` | `(scope_key, field_id, context_id, option_id)` | Replaced on each scan; grows with field option count |
| `report_jobs` | `(scope_key, job_id)` | Accumulates completed jobs; pruned by the weekly retention trigger |

### Retention

Two prune paths run automatically. Neither needs operator action.

**After every snapshot.** `pruneOldSnapshotVersions` runs inline inside `runSnapshot` once a build completes, deleting `snapshot_fields` and `snapshot_project_usage` rows for every version except the new one. This keeps both tables at a single-version footprint.

**Weekly.** The `retention-cleanup-trigger` scheduled trigger calls `runRetentionCleanup` (`index.js`), which runs both prune functions in one pass:

- `pruneOldSnapshotVersions` — a safety net for the case where a build completed but its inline prune did not
- `pruneStaleReportJobs` — deletes `report_jobs` rows whose `completed_at` is older than 7 days

It is idempotent and safe to run repeatedly. It skips snapshot pruning when there is no active version, since without a version to keep it has no anchor and could delete the only snapshot present.

To confirm it ran, search the Forge logs for `runRetentionCleanup:` — it logs a line per prune that deleted anything, and nothing when there was nothing to delete.

> **Historical note.** Before 30 Jul 2026 this section told operators to "call `runRetentionCleanup`" directly. That was not possible: the function existed but was bound to no manifest function, so nothing could invoke it and `report_jobs` grew without bound. If you are looking at an installation deployed before that date, expect a backlog on the first weekly run.

### Clearing all snapshot data

Admin page → Scans → Snapshot → **Danger zone**. Requires typing `DELETE` to confirm, and is blocked while read-only mode is enabled.

This deletes the field catalog, per-project usage, field summaries, cached options, issue scan state, and report job history, then cancels any in-flight build. **Saved reports, workflow data and the RQT index survive.** A full rebuild is required afterwards and can take hours on a large site.

Use it to recover from a corrupted snapshot, or to purge site data on request. There is no undo.

### Warning signs

- Scan taking longer than 60 minutes: check `issue_scan_meta.total_pages` vs `processed_pages`
- Progress log entries have stopped: workers may be silently failing — check `issue_scan_workers.last_error`
- Workers stuck in `status: "building"`: trigger a Force resume
- `snapshot_project_usage` growing unexpectedly: `pruneOldSnapshotVersions` may not have run — verify last snapshot completed successfully (`snapshot_meta.state = "ready"`)

---

## Section 4: Deploy Procedure

### Pre-deploy

Always build before deploying. The Vite frontend bundles are not rebuilt by `forge deploy` alone.

```sh
npm run build && forge deploy
```

### Environments

| Environment | Purpose | How to promote |
|---|---|---|
| `development` | Always on; used for active development | `forge deploy` (default) |
| `staging` | Pre-production validation | `forge deploy --environment staging` |
| `production` | Live customer traffic | `forge deploy --environment production` |

Promote through environments in order: dev → staging → production.

### Rollback

Re-deploy the previous version tag to the affected environment:

```sh
forge deploy --environment <env>
```

Forge does not have a built-in "rollback" command. Keep track of working version tags and re-deploy them directly.

### Post-deploy checklist

- [ ] Admin page loads without errors
- [ ] Overview tab shows correct snapshot state
- [ ] Config tab renders and saves successfully
- [ ] Trigger a manual snapshot build and confirm it reaches `state: "ready"`
- [ ] Check browser console and Forge logs for unexpected errors

---

## Section 5: Schema Migrations

### How migrations run

Migrations run automatically on the first request after a new deploy via `ensureProjectStoreReady`. The `migrationRunner` from `@forge/sql` tracks which migration IDs have executed and skips already-applied ones.

All migration statements use `IF NOT EXISTS` or `ON DUPLICATE KEY` semantics — they are safe to replay and will not error if the object already exists.

### Current state

The highest migration is **v039** (`alter_issue_scan_meta_add_scan_history`).

New migrations must be appended to the `projectStoreMigrations` chain in `src/lib/project-store.js` with a new sequential ID (e.g. `v040_...`).

### Rules

- **Never delete old migrations.** Installations that have not yet applied an old migration will be permanently broken if its entry is removed.
- **Never reuse a migration ID.** The runner treats IDs as unique keys.
- **Destructive changes** (DROP COLUMN, DROP TABLE) require careful coordination — ensure all installations are on a version that no longer reads the column before dropping it.

---

## Section 6: Common Error Patterns

### `Queue backpressure hit` in scan log

Forge's internal queue rejected a push due to load. The scan or field summary job will retry automatically. No action required unless this persists for more than 30 minutes.

### `Rate limit hit` in scan log

The Jira API returned a 429. The app auto-throttles and retries with exponential back-off. No action required.

### `Finalization failed` in scan log

The universe scan completed page processing but failed during the finalization step (promoting buffer counts to `snapshot_project_usage`). The buffer data is intact. Use "Resume scan" → the coordinator will detect `processed_pages >= total_pages` and retry finalization.

### `state: "failed"` on snapshot

The snapshot wrote a terminal error to `lastError`. Steps:

1. Check `lastError` in the admin Overview tab
2. Identify the root cause (Jira connectivity, permission error, unexpected field data)
3. Fix the underlying issue
4. Re-trigger the snapshot via the Config tab

The snapshot does not auto-retry from `"failed"` state — manual re-trigger is required.

### `state: "cancelled"` on snapshot

Snapshot was explicitly cancelled by a user or by a concurrent-build conflict. Restart via the Config tab.
