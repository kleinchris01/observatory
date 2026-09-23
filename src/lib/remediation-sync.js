// The hourly remediation sync: re-reads live status and assignee for every open remediation
// ticket from Jira, and writes it back.
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
import { getIssuesStatus } from "./jira-api.js";
import { loadOpenRemediationTickets, updateRemediationSync } from "./store/remediation.js";

export async function syncRemediationTickets(installationKey) {
  const open = await loadOpenRemediationTickets(installationKey);
  if (!open.length) return { checked: 0, updated: 0 };

  const statuses = await getIssuesStatus(open.map((t) => t.issueKey));
  const byKey = new Map(statuses.map((s) => [s.key, s]));
  const syncedAt = new Date().toISOString();

  let updated = 0;
  for (const ticket of open) {
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
      syncedAt,
    }).catch(ignoreWith("remediation.sync_write_failed", { installationKey, issueKey: ticket.issueKey }));
    updated += 1;
  }

  logger.info("remediation.synced", { installationKey, checked: open.length, updated });
  return { checked: open.length, updated };
}
