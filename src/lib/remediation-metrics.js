// Remediation progress metrics: burn-down, throughput, time to close, ageing, and where the open
// work sits. Pure over the stored ticket rows -- no I/O -- so every number is unit-testable.
//
// Tasks only; epics are containers, not work. A task counts as closed when its last synced status
// category is "done". Its close date is done_at (Jira's resolution date, from the sync); a done
// task synced before done_at existed falls back to its sync time, so it still lands on the
// burn-down rather than vanishing from it.

const DAY_MS = 86400000;

export const AGE_BUCKETS = [
  { key: "under-7", label: "Under 7 days", min: 0, max: 7 },
  { key: "7-30", label: "7–30 days", min: 7, max: 30 },
  { key: "30-90", label: "30–90 days", min: 30, max: 90 },
  { key: "over-90", label: "Over 90 days", min: 90, max: Infinity },
];

const WEEKS_OF_THROUGHPUT = 12;
const RATE_WINDOW_DAYS = 14;
const TOP_ASSIGNEES = 8;

// "2026-Q3" -> its first day and its last day (UTC).
export function periodBounds(period) {
  const m = /^(\d{4})-Q([1-4])$/.exec(String(period || ""));
  if (!m) return null;
  const year = Number(m[1]);
  const q = Number(m[2]);
  const start = new Date(Date.UTC(year, (q - 1) * 3, 1));
  const end = new Date(Date.UTC(year, q * 3, 0)); // day 0 of the next quarter's first month
  return { start, end };
}

const dayStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const isoDay = (d) => d.toISOString().slice(0, 10);
const parse = (iso) => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? new Date(ms) : null;
};
const isDone = (t) => t.lastStatusCategory === "done";
const closedAt = (t) => (isDone(t) ? parse(t.doneAt) || parse(t.syncedAt) : null);

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

// Monday (UTC) of the week a date falls in.
function weekStart(d) {
  const day = dayStart(d);
  const offset = (day.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day.getTime() - offset * DAY_MS);
}

/**
 * @param tickets   every stored remediation row (epics and tasks, every quarter)
 * @param now       the current time
 * @param period    the current quarter, e.g. "2026-Q3"
 * @param scope     "quarter" (this quarter's tasks) or "all" (every quarter)
 * @param labels    findingKey -> display label (from the playbook catalog)
 */
export function computeRemediationMetrics({ tickets = [], now = new Date(), period, scope = "quarter", labels = {} }) {
  const allTasks = tickets.filter((t) => !t.isEpic);
  const tasks = scope === "all" ? allTasks : allTasks.filter((t) => t.period === period);
  const today = dayStart(now);

  const open = tasks.filter((t) => !isDone(t));
  const closed = tasks.filter(isDone);
  const closedWithin = (days) =>
    closed.filter((t) => {
      const at = closedAt(t);
      return at && now.getTime() - at.getTime() <= days * DAY_MS;
    }).length;

  // Time to close: created -> done, for tasks with both dates.
  const closeDays = closed
    .map((t) => {
      const c = parse(t.createdAt);
      const d = closedAt(t);
      return c && d ? Math.max(0, (d - c) / DAY_MS) : null;
    })
    .filter((v) => v != null);

  // Ageing of open work, from creation.
  const openAges = open.map((t) => {
    const c = parse(t.createdAt);
    return c ? Math.max(0, (now - c) / DAY_MS) : null;
  });
  const ageing = AGE_BUCKETS.map((b) => ({
    key: b.key,
    label: b.label,
    count: openAges.filter((a) => a != null && a >= b.min && a < b.max).length,
  }));
  const knownAges = openAges.filter((a) => a != null);

  // Pace and projection: closures per day over the last two weeks.
  const recentClosed = closedWithin(RATE_WINDOW_DAYS);
  const ratePerDay = recentClosed / RATE_WINDOW_DAYS;
  const projectedClearDate =
    open.length === 0 ? isoDay(today)
      : ratePerDay > 0 ? isoDay(new Date(today.getTime() + Math.ceil(open.length / ratePerDay) * DAY_MS))
        : null;

  // Burn-down: open tasks at the end of each day, from the first day any task existed (or the
  // quarter start) to today; the pace line runs from that first day's open count to zero at the
  // quarter's end, so being above it means behind.
  const bounds = scope === "quarter" ? periodBounds(period) : null;
  const createdDates = tasks.map((t) => parse(t.createdAt)).filter(Boolean);
  const firstCreated = createdDates.length ? dayStart(new Date(Math.min(...createdDates))) : null;
  const seriesStart = bounds && firstCreated ? (firstCreated < bounds.start ? bounds.start : firstCreated) : firstCreated;
  const seriesEnd = bounds ? bounds.end : today;

  const burndown = [];
  if (seriesStart) {
    const stepDays = (seriesEnd - seriesStart) / DAY_MS > 400 ? 7 : 1;
    for (let d = seriesStart; d <= seriesEnd; d = new Date(d.getTime() + stepDays * DAY_MS)) {
      const endOfDay = d.getTime() + DAY_MS - 1;
      const isFuture = d > today;
      const openThen = isFuture ? null : tasks.filter((t) => {
        const c = parse(t.createdAt);
        if (!c || c.getTime() > endOfDay) return false;
        const done = closedAt(t);
        return !(done && done.getTime() <= endOfDay);
      }).length;
      burndown.push({ date: isoDay(d), open: openThen });
    }
    if (bounds && burndown.length > 1) {
      const startOpen = burndown.find((p) => p.open != null)?.open ?? 0;
      const span = burndown.length - 1;
      burndown.forEach((p, i) => { p.pace = round1(startOpen * (1 - i / span)); });
    }
  }

  // Throughput: tasks closed per week, last 12 weeks.
  const thisWeek = weekStart(now);
  const throughput = Array.from({ length: WEEKS_OF_THROUGHPUT }, (_, i) => {
    const start = new Date(thisWeek.getTime() - (WEEKS_OF_THROUGHPUT - 1 - i) * 7 * DAY_MS);
    const end = start.getTime() + 7 * DAY_MS;
    const inWeek = (at) => at && at.getTime() >= start.getTime() && at.getTime() < end;
    return {
      weekStart: isoDay(start),
      closed: closed.filter((t) => inWeek(closedAt(t))).length,
      created: tasks.filter((t) => inWeek(parse(t.createdAt))).length,
    };
  });

  // Where the work is: per finding, and open tasks per assignee.
  const byFindingMap = new Map();
  for (const t of tasks) {
    if (!byFindingMap.has(t.findingKey)) {
      byFindingMap.set(t.findingKey, { findingKey: t.findingKey, label: labels[t.findingKey] || t.findingKey, pillar: t.pillar, total: 0, open: 0, closed: 0, oldestOpenDays: null });
    }
    const f = byFindingMap.get(t.findingKey);
    f.total += 1;
    if (isDone(t)) f.closed += 1;
    else {
      f.open += 1;
      const c = parse(t.createdAt);
      const age = c ? Math.floor((now - c) / DAY_MS) : null;
      if (age != null && (f.oldestOpenDays == null || age > f.oldestOpenDays)) f.oldestOpenDays = age;
    }
  }
  const byFinding = [...byFindingMap.values()]
    .map((f) => ({ ...f, pctClosed: f.total ? Math.round((f.closed / f.total) * 100) : null }))
    .sort((a, b) => b.open - a.open || a.label.localeCompare(b.label));

  const assigneeCounts = new Map();
  for (const t of open) {
    const name = t.assigneeName || "Unassigned";
    assigneeCounts.set(name, (assigneeCounts.get(name) || 0) + 1);
  }
  const sortedAssignees = [...assigneeCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const byAssignee = sortedAssignees.slice(0, TOP_ASSIGNEES).map(([name, count]) => ({ name, count }));
  const otherCount = sortedAssignees.slice(TOP_ASSIGNEES).reduce((sum, [, count]) => sum + count, 0);
  if (otherCount) byAssignee.push({ name: "Everyone else", count: otherCount });

  // Came back: an item whose task was closed in an earlier quarter and is ticketed again now.
  const doneEarlier = new Set(
    allTasks.filter((t) => isDone(t) && t.period !== period).map((t) => `${t.findingKey}|${t.itemId}`)
  );
  const cameBack = new Set(
    allTasks.filter((t) => t.period === period && doneEarlier.has(`${t.findingKey}|${t.itemId}`)).map((t) => `${t.findingKey}|${t.itemId}`)
  ).size;

  const synced = tasks.map((t) => t.syncedAt).filter(Boolean).sort();

  return {
    scope,
    period,
    totals: {
      tasks: tasks.length,
      open: open.length,
      closed: closed.length,
      pctClosed: tasks.length ? Math.round((closed.length / tasks.length) * 100) : null,
      closedLast7: closedWithin(7),
      closedLast30: closedWithin(30),
      unassignedOpen: open.filter((t) => !t.assigneeName).length,
      cameBack,
    },
    timing: {
      medianDaysToClose: round1(median(closeDays)),
      oldestOpenDays: knownAges.length ? Math.floor(Math.max(...knownAges)) : null,
      ratePerWeek: round1(ratePerDay * 7),
      projectedClearDate,
      quarterEnd: bounds ? isoDay(bounds.end) : null,
      onTrack: projectedClearDate && bounds ? projectedClearDate <= isoDay(bounds.end) : null,
    },
    burndown,
    throughput,
    ageing,
    byFinding,
    byAssignee,
    sync: {
      lastSyncedAt: synced.length ? synced[synced.length - 1] : null,
      neverSynced: tasks.filter((t) => !t.syncedAt).length,
    },
  };
}
