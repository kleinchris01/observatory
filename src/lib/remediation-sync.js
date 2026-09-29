// The remediation sync: re-reads live status, assignee and completion date for remediation
// tickets from Jira, and writes them back. Triggered hourly; acts three times a business day
// (see remediationSyncCheck in index.js).
//
// Without this, the tab could create Jira work but never show what happened to it -- an epic
// and its tasks would sit forever at whatever state they were in the moment they were
// created, which is a worse position than not tracking status at all: a stale "To Do" reads
// as "nobody has started this" long after somebody finished it.
//
// Pure over its inputs except for the two calls it makes (the Jira read, the store write),
// mirroring reviveStalledIssueScanWorkers: the orchestration (which installation, when) lives
// in index.js; this is what actually happens once triggered.

import { logger, ignoreWith } from "./logger.js";
import { getIssuesStatus, ISSUE_STATUS_BATCH } from "./jira-api.js";
import { loadRemediationTicketsToSync, updateRemediationSync } from "./store/remediation.js";
import { inventorySnapshotQueue } from "./queues.js";

// The sync always runs on the queue consumer, whether the scheduled trigger or "Sync now"
// started it. A few thousand tickets need minutes; a trigger function has a fixed, short
// ceiling (Forge allows a custom timeout only on consumers and scheduledTrigger modules), and
// running the sync inline there meant every run was killed mid-read with nothing logged.
export async function queueRemediationSync(installationKey) {
  await inventorySnapshotQueue.push({ body: { jobType: "sync-remediation", installationKey } });
  return { queued: true };
}

// How long a Done ticket keeps being re-read, so a reopen in Jira is seen. Long enough to
// cover a reopen after review; short enough that the sync does not re-read every ticket ever
// closed, forever.
export const REOPEN_WINDOW_DAYS = 30;

// When a ticket became Done: Jira's resolution date, else when its status category last
// changed, else the date already stored, else now (the first sync that saw it Done). Not Done
// means no done date -- a reopened ticket loses its old one, so it counts as open again.
export function resolveDoneAt(live, stored, syncedAt) {
  if (live.statusCategory !== "done") return null;
  return live.resolvedAt || live.statusCategoryChangedAt || stored?.doneAt || syncedAt;
}

export async function syncRemediationTickets(installationKey, now = new Date()) {
  const reopenWindowStart = new Date(now.getTime() - REOPEN_WINDOW_DAYS * 86400000).toISOString();
  const tickets = await loadRemediationTicketsToSync(installationKey, reopenWindowStart);
  if (!tickets.length) return { checked: 0, updated: 0 };

  // One read per batch, each on its own: a batch Jira refuses leaves those tickets as they
  // were and the rest still sync. Before this, one failed read threw away the whole run.
  const keys = [...new Set(tickets.map((t) => t.issueKey))];
  const byKey = new Map();
  let failedBatches = 0;
  for (let i = 0; i < keys.length; i += ISSUE_STATUS_BATCH) {
    const batch = keys.slice(i, i + ISSUE_STATUS_BATCH);
    try {
      // eslint-disable-next-line no-await-in-loop -- the Jira client rate-limits; parallel
      // batches would only queue behind each other.
      for (const s of await getIssuesStatus(batch)) byKey.set(s.key, s);
    } catch (error) {
      failedBatches += 1;
      logger.warn("remediation.sync_batch_failed", {
        installationKey, firstKey: batch[0], size: batch.length, error: error?.message || String(error),
      });
    }
  }
  const syncedAt = now.toISOString();

  let updated = 0;
  for (const ticket of tickets) {
    const live = byKey.get(ticket.issueKey);
    // Not in the result: the issue was deleted, or the search silently dropped it (a project
    // permission change, most often). Leaving the stored row alone is the safe choice --
    // there is nothing here to disprove it, and overwriting it with nulls would erase the
    // last status Jira actually confirmed.
    if (!live) continue;
    // eslint-disable-next-line no-await-in-loop -- sequential, matching every other loop over
    // per-ticket writes in this module family (recordRemediationTickets, createRemediationEpic).
    await updateRemediationSync(installationKey, ticket.issueKey, {
      lastStatus: live.status,
      lastStatusCategory: live.statusCategory,
      assigneeAccountId: live.assigneeAccountId,
      assigneeName: live.assigneeName,
      doneAt: resolveDoneAt(live, ticket, syncedAt),
      statusChangedAt: live.statusCategoryChangedAt || null,
      syncedAt,
    }).catch(ignoreWith("remediation.sync_write_failed", { installationKey, issueKey: ticket.issueKey }));
    updated += 1;
  }

  logger.info("remediation.synced", { installationKey, checked: tickets.length, updated, failedBatches });
  return { checked: tickets.length, updated, failedBatches };
}
