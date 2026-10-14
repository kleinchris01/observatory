// Did the fix hold? Each remediation task names one item (a filter, a field, a project's
// group of role actors), and the scan that runs after it closes says whether that item is
// still flagged. This compares the two.
//
// Verdicts, per task:
//   held        closed, and the item is no longer flagged: the fix is proven
//   regressed   closed, but the item is still (or again) flagged
//   fixed-open  still open, but the item is no longer flagged: it can be closed
//   open        still open and still flagged: work in progress, nothing to say
//   superseded  an older task for an item a later quarter's task already covers
//   unverified  the finding's current items could not be read, so nothing can be claimed
//
// Pure. The resolver supplies the tickets and, per finding, the current candidate ids from
// the same loaders that created the tasks, so ids match exactly.
//
// Acting on a verdict -- reopening a regressed task, closing a fixed one -- is a separate,
// explicit admin action. Nothing here or in the resolver changes a Jira ticket on its own.

export const VERDICTS = ["regressed", "fixed-open", "held", "open", "superseded", "unverified"];

const isDone = (t) => t.lastStatusCategory === "done";

// tickets: remediation_tickets_v2 rows (store/remediation.js mapRow).
// current: Map findingKey -> { available: boolean, ids: Set<string>, reason? }.
export function verifyTickets({ tickets = [], current = new Map() } = {}) {
  const tasks = tickets.filter((t) => !t.isEpic);

  // The newest task per item. An item that regressed in an earlier quarter and was ticketed
  // again belongs to the new task; the old one has nothing more to say.
  const newest = new Map();
  for (const t of tasks) {
    const key = `${t.findingKey}\u0000${t.itemId}`;
    const prior = newest.get(key);
    if (!prior || String(t.period || "") > String(prior.period || "")) newest.set(key, t);
  }

  const rows = tasks.map((t) => {
    const base = {
      findingKey: t.findingKey,
      pillar: t.pillar || null,
      period: t.period || null,
      itemId: String(t.itemId),
      issueKey: t.issueKey,
      epicKey: t.epicKey || null,
      summary: t.summary || null,
      status: t.lastStatus || null,
      done: isDone(t),
      doneAt: t.doneAt || null,
      assigneeName: t.assigneeName || null,
    };
    if (newest.get(`${t.findingKey}\u0000${t.itemId}`) !== t) return { ...base, verdict: "superseded" };
    const finding = current.get(t.findingKey);
    if (!finding?.available) {
      return { ...base, verdict: "unverified", reason: finding?.reason || "The finding's current items could not be read." };
    }
    const flagged = finding.ids.has(String(t.itemId));
    const verdict = isDone(t) ? (flagged ? "regressed" : "held") : (flagged ? "open" : "fixed-open");
    return { ...base, verdict };
  });

  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const r of rows) counts[r.verdict] += 1;
  const closed = counts.held + counts.regressed;
  return {
    rows,
    counts,
    // Of the tasks closed and checkable, the share whose fix is proven. Null with nothing closed:
    // "100% held" over zero tasks would claim a track record nobody has.
    heldRate: closed > 0 ? counts.held / closed : null,
  };
}

// The comment an admin's action leaves on the task, so whoever opens it sees why it moved.
export function verificationComment(row, { checkedAt, findingLabel = null } = {}) {
  const what = findingLabel ? `${findingLabel} (${row.findingKey})` : row.findingKey;
  const when = checkedAt ? ` on ${String(checkedAt).slice(0, 10)}` : "";
  if (row.verdict === "regressed") {
    return [
      `Reopened by Observatory: the fix did not hold.`,
      "",
      `This task was closed, but the scan checked${when} still flags this item under ${what} (item ${row.itemId}).`,
      "",
      "Check whether the change was made, reverted, or made somewhere else, then close this again once the next scan no longer flags it.",
    ].join("\n");
  }
  if (row.verdict === "fixed-open") {
    return [
      `Closed by Observatory: the item is fixed.`,
      "",
      `The scan checked${when} no longer flags this item under ${what} (item ${row.itemId}).`,
      "",
      "If the work is not actually finished, reopen this task; the next scan will check again.",
    ].join("\n");
  }
  return null;
}

// Which status category an action moves a task to, by verdict. Null: no action applies.
export function targetCategory(verdict) {
  if (verdict === "regressed") return "reopen";
  if (verdict === "fixed-open") return "done";
  return null;
}
