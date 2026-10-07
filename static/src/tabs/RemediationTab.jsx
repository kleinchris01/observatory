import React from "react";
import { invoke } from "@forge/bridge";
import { buildIssueUrl, buildJiraSearchUrl, handleJiraLinkClick, formatRelativeTime } from "../utils";
import { Icon } from "../components/Icons";
import { PageHeader, Panel, StatRow, StatTile, EmptyState, RemediationStatus, SortFilterBar, Chip } from "../components/ui";
import { SubNavLayout } from "../components/admin/primitives";
import { useNavIntent, usePersistentState } from "../hooks";
import { RemediationProgress } from "./RemediationProgress";

// The playbook catalog is served with the tickets (getRemediationTickets -> catalog), so this
// tab never holds its own copy of which playbooks exist. It used to: a static list here that
// had to be kept in step with remediation-playbooks.js by hand.

// Display names for the health-pillar keys a playbook is filed under, in the order the admin
// nav lists the pillars.
const PILLAR_ORDER = [
  ["fields", "Fields"], ["projects", "Projects"], ["workflows", "Workflows"], ["issueTypes", "Issue Types"],
  ["fieldConfigs", "Field Schemes"], ["estate", "Priorities"], ["users", "People"], ["assets", "Assets"], ["permissions", "Access"],
  ["security", "Access"], ["notifications", "Access"], ["roles", "Access"], ["screens", "Screens"],
  ["filters", "Saved Filters"], ["dashboards", "Dashboards"], ["boards", "Boards"], ["automation", "Automation"],
];
const PILLAR_LABEL = Object.fromEntries(PILLAR_ORDER);
const PILLAR_RANK = Object.fromEntries(PILLAR_ORDER.map(([key], i) => [key, i]));

// Past this many new tasks in one go, the create button asks first. Jira will take them, but
// a few hundred tickets landing in a project is something a person should decide to do.
export const CONFIRM_ABOVE = 200;

const STATUS_TONE = { done: "success", indeterminate: "active", new: "neutral" };

function StatusChip({ category, label }) {
  const tone = STATUS_TONE[category] || "neutral";
  return <span className={`chip chip--${tone}`}>{label || category || "Unknown"}</span>;
}

function IssueLink({ issueKey, siteOrigin, children }) {
  const href = buildIssueUrl(siteOrigin, issueKey);
  if (!href) return <span>{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => handleJiraLinkClick(event, href)}
    >
      {children}
    </a>
  );
}

// One task row: its own status, assignee and last sync time. `syncedAt` is the tell for
// whether the sync (three times a business day) has ever actually reached this ticket -- a task created seconds ago
// and not yet synced is a different fact from one the sync checked this morning and found
// untouched, and collapsing them into the same "To Do" would hide that difference.
function TaskRow({ task, siteOrigin }) {
  return (
    <div className="remediation-task">
      <IssueLink issueKey={task.issueKey} siteOrigin={siteOrigin}>{task.issueKey}</IssueLink>
      <span className="remediation-task__summary">{task.summary}</span>
      <StatusChip category={task.lastStatusCategory} label={task.lastStatus} />
      <span className="remediation-task__assignee">{task.assigneeName || "Unassigned"}</span>
      <span className="remediation-task__synced">
        {task.syncedAt ? `synced ${formatRelativeTime(task.syncedAt)}` : "not yet synced"}
      </span>
    </div>
  );
}

// One finding: the epic (if raised), its tasks, and the create/update action. The epic sits
// visually above its tasks -- the same "epic on top, one task per item below" shape asked for,
// because that is also just how Jira itself nests them.
// Open tasks, from any quarter, for items the finding no longer flags: fixed since, or never
// should have been (as when the roles rule was corrected on 7 Oct 2026 and dozens of
// "add an administrator" tasks turned out to be for projects that had one). Someone acting
// on one of these is acting on stale advice, so the card says so.
export function openTasksNoLongerFlagged(group, items = []) {
  if (!group) return [];
  const flagged = new Set(items.map((it) => String(it.id ?? it.name)));
  const all = [...(group.tasks || []), ...(group.previousPeriods || []).flatMap((p) => p.tasks || [])];
  return all.filter((t) => t.lastStatusCategory !== "done" && t.itemId != null && t.itemId !== "" && !flagged.has(String(t.itemId)));
}

// Every quarter's task counts on a finding. Older servers sent only the latest quarter's.
export function allTaskCountOf(group) {
  return group?.allTaskCount ?? (group?.taskCount || 0);
}
export function allOpenCountOf(group) {
  return group?.allOpenCount ?? (group?.openCount || 0);
}

// The quarters before this one, newest first, each with its epic and tasks. When the latest
// epic is itself an earlier quarter's (this quarter not started), it leads the list.
export function earlierQuartersOf(group) {
  if (!group) return [];
  const latest = group.isCurrent ? [] : [{
    period: group.period, epicKey: group.epic?.issueKey ?? null,
    tasks: group.tasks || [], taskCount: group.taskCount ?? (group.tasks || []).length, openCount: group.openCount || 0,
  }];
  return [...latest, ...(group.previousPeriods || []).map((p) => ({ ...p, tasks: p.tasks || [] }))];
}

// One earlier quarter on a finding card: its epic, how far it got, and its tasks behind a
// toggle -- a quarter can hold hundreds, and they are history next to this quarter's list.
// Opens by itself when a search matched one of its tasks.
function EarlierQuarter({ quarter, siteOrigin, taskQuery }) {
  const shown = taskQuery ? quarter.tasks.filter((t) => taskMatches(t, taskQuery)) : quarter.tasks;
  const [open, setOpen] = React.useState(false);
  const visible = open || (taskQuery && shown.length > 0);
  const closed = quarter.taskCount - quarter.openCount;
  if (taskQuery && shown.length === 0) return null;
  return (
    <div className="remediation-quarter">
      <p className="remediation-history">
        {quarter.period}{" "}
        {quarter.epicKey ? <IssueLink issueKey={quarter.epicKey} siteOrigin={siteOrigin}>{quarter.epicKey}</IssueLink> : "(no epic)"}
        {` · ${quarter.openCount} open, ${closed} of ${quarter.taskCount} closed`}
        {quarter.tasks.length > 0 && !(taskQuery && shown.length > 0) && (
          <>
            {" "}
            <button type="button" className="secondary-button secondary-button--small" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              {open ? `Hide ${quarter.period} tasks` : `Show ${quarter.tasks.length} ${quarter.period} task${quarter.tasks.length === 1 ? "" : "s"}`}
            </button>
          </>
        )}
      </p>
      {visible && shown.length > 0 && (
        <div className="remediation-tasks">
          {shown.map((task) => <TaskRow key={task.issueKey} task={task} siteOrigin={siteOrigin} />)}
        </div>
      )}
    </div>
  );
}

// The chip on each finding's header: how many of its flagged items still need a task, readable
// with the card folded away. This is what lets an admin see which findings to generate tickets
// for without opening each one.
function TicketChip({ ticketing, checking }) {
  if (!ticketing) return checking ? <Chip>checking…</Chip> : null;
  const { bucket, untracked, heldEarlier, flagged } = ticketing;
  if (bucket === "to-ticket") {
    const held = heldEarlier.length ? `; ${heldEarlier.length} more still open under an earlier quarter's epic` : "";
    return <Chip tone="warning" title={`${untracked.length} of ${flagged} flagged items have no task yet${held}.`}>{untracked.length} to ticket</Chip>;
  }
  if (bucket === "ticketed") return <Chip tone="success" title={`Every one of the ${flagged} flagged items has a task.`}>all ticketed</Chip>;
  if (bucket === "clean") return <Chip title="Nothing is flagged for this finding right now.">nothing flagged</Chip>;
  return <Chip title="This finding's items could not be read. Open it for the reason.">no data</Chip>;
}

function FindingCard({ entry, group, period, siteOrigin, onCreate, creating, progress, error, focused = false, taskQuery = "", candidates, ticketing, checking, onLoadCandidates }) {
  const [expanded, setExpanded] = React.useState(focused);
  const [confirming, setConfirming] = React.useState(false);
  const cardRef = React.useRef(null);

  // Arrived from an Overview finding: open this card and bring it into view.
  React.useEffect(() => {
    if (!focused) return;
    setExpanded(true);
    try { cardRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }); } catch { /* jsdom */ }
  }, [focused]);

  const epic = group?.epic || null;
  const isCurrent = Boolean(group?.isCurrent);
  // This quarter's tasks are listed inline. When the latest epic is an earlier quarter's, its
  // tasks join the earlier quarters below instead -- they are not this quarter's work.
  const tasks = isCurrent ? group?.tasks || [] : [];
  const earlierQuarters = earlierQuartersOf(group);
  // A search that matched this finding by one of its tasks, not by its name, lists only the
  // matching tasks -- the counts above them still describe the whole finding.
  const shownTasks = taskQuery ? tasks.filter((t) => taskMatches(t, taskQuery)) : tasks;
  // Counts across every quarter: a task still open under last quarter's epic is open work.
  const allTasks = group ? allTaskCountOf(group) : 0;
  const allOpen = group ? allOpenCountOf(group) : 0;
  const earlierTaskCount = earlierQuarters.reduce((n, q) => n + (q.taskCount ?? q.tasks.length), 0);

  // The tab checks every finding in the background; opening one before its turn asks now.
  const loadingCandidates = !candidates;
  React.useEffect(() => {
    if (expanded && !candidates && !checking) onLoadCandidates(entry.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const untracked = ticketing?.untracked || [];
  const heldEarlier = ticketing?.heldEarlier || [];
  const earlierEpics = [...new Set(heldEarlier.map((it) => it.ticketed.epicKey).filter(Boolean))];
  // Only once the finding's items were actually read: an unreadable finding must not make
  // every task look stale.
  const staleTasks = candidates && candidates.available !== false && Array.isArray(candidates.items)
    ? openTasksNoLongerFlagged(group, candidates.items) : [];
  const staleUrl = staleTasks.length
    ? buildJiraSearchUrl(siteOrigin, `issuekey in (${staleTasks.map((t) => t.issueKey).join(", ")}) ORDER BY key`)
    : null;
  const needsConfirm = untracked.length > CONFIRM_ABOVE;

  function create() {
    if (needsConfirm && !confirming) { setConfirming(true); return; }
    setConfirming(false);
    onCreate(entry.key, candidates.items, untracked.length);
  }

  return (
    <div ref={cardRef}>
    <Panel
      title={entry.label}
      icon="checkCircle"
      description={<RemediationStatus group={group} period={period} siteOrigin={siteOrigin} compact />}
      action={<TicketChip ticketing={ticketing} checking={checking} />}
      // Every finding is independently collapsible -- the epic chip above stays visible in
      // the collapsed header, so a tracked finding is never mistaken for an untouched one
      // just because it is folded away.
      collapsible
    >
      {(
        <>
          {staleTasks.length > 0 && (
            <p className="remediation-stale" data-testid="stale-tasks">
              <strong>{staleTasks.length} open task{staleTasks.length === 1 ? " is" : "s are"} for items this finding no longer flags</strong>
              {" "}— fixed since, or the finding no longer applies. Check {staleTasks.length === 1 ? "it" : "them"} before anyone acts on stale advice.
              {staleUrl && <>{" "}<a href={staleUrl} target="_blank" rel="noreferrer" onClick={(e) => handleJiraLinkClick(e, staleUrl)}>Open {staleTasks.length === 1 ? "it" : `all ${staleTasks.length}`} in Jira</a></>}
            </p>
          )}
          {allTasks > 0 && (
            <StatRow>
              <StatTile
                label="Tasks"
                value={allTasks}
                icon="layers"
                hint={earlierTaskCount > 0 ? `${tasks.length} this quarter · ${earlierTaskCount} from earlier quarters` : null}
              />
              <StatTile label="Open" value={allOpen} tone={allOpen > 0 ? "active" : "success"} icon="clock" />
              <StatTile label="Closed" value={allTasks - allOpen} tone="success" icon="checkCircle" />
            </StatRow>
          )}

          {taskQuery && shownTasks.length < tasks.length && (
            <p className="remediation-history">Showing {shownTasks.length} of {tasks.length} tasks matching the search.</p>
          )}
          {shownTasks.length > 0 && (
            <div className="remediation-tasks">
              {earlierQuarters.length > 0 && <h4 className="remediation-quarter__title">{period} {epic && <IssueLink issueKey={epic.issueKey} siteOrigin={siteOrigin}>{epic.issueKey}</IssueLink>}</h4>}
              {shownTasks.map((task) => <TaskRow key={task.issueKey} task={task} siteOrigin={siteOrigin} />)}
            </div>
          )}
          {earlierQuarters.map((q) => (
            <EarlierQuarter key={q.period} quarter={q} siteOrigin={siteOrigin} taskQuery={taskQuery} />
          ))}

          <button
            type="button"
            className="secondary-button secondary-button--small"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Hide current items" : "Check current items"}
          </button>

          {expanded && (
            loadingCandidates ? (
              <EmptyState inline>Loading current items…</EmptyState>
            ) : candidates?.available === false ? (
              <EmptyState inline>
                {candidates.reason === "no-snapshot"
                  ? "No snapshot yet for this pillar — build one before remediating it."
                  : candidates.reason === "transitions-unknown"
                    ? "The last workflow build could not read transitions, so a screen a transition opens would look unreached. Rebuild the workflow inventory before remediating this."
                    : candidates.reason === "error"
                      ? `Could not read this finding's items: ${candidates.error || "unknown error"}. Open it again to retry.`
                      : candidates.reason === "not-probed"
                        ? "The last dashboard build ran before gadget filters were checked, so a broken gadget would look fine. Rebuild the dashboard inventory (or run a scan) before remediating this."
                        : "No data available for this finding right now."}
              </EmptyState>
            ) : (candidates?.items?.length ?? 0) === 0 ? (
              <EmptyState inline>Nothing currently flagged for this finding. Clean.</EmptyState>
            ) : (
              <>
                <p className="remediation-candidates__summary">
                  {candidates.items.length} item{candidates.items.length === 1 ? "" : "s"} flagged
                  {untracked.length !== candidates.items.length
                    ? `, ${untracked.length} not yet ticketed`
                    : ""}.
                </p>
                {heldEarlier.length > 0 && (
                  <p className="remediation-candidates__summary" role="note">
                    {heldEarlier.length} {heldEarlier.length === 1 ? "is" : "are"} still open under an earlier quarter's epic
                    {earlierEpics.length > 0 && <> ({earlierEpics.map((key, i) => (
                      <span key={key}>{i > 0 ? ", " : ""}<IssueLink issueKey={key} siteOrigin={siteOrigin}>{key}</IssueLink></span>
                    ))})</>}
                    {" "}and stay{heldEarlier.length === 1 ? "s" : ""} there until closed. Close or finish those tasks and anything still flagged comes into this quarter's epic.
                  </p>
                )}
                {candidates.partial && (
                  // The stored automation analysis keeps a preview of the highest-severity
                  // rules, not all of them. Said outright, so the epic is not mistaken for the
                  // whole finding.
                  <p className="remediation-candidates__summary" role="note">
                    Only the {candidates.items.length} highest-severity of {candidates.expected} flagged rules are
                    listed: the stored automation analysis keeps a preview, so the other{" "}
                    {candidates.expected - candidates.items.length} cannot be ticketed from here yet.
                  </p>
                )}
                <button
                  type="button"
                  className="primary-button"
                  disabled={creating || untracked.length === 0}
                  onClick={create}
                >
                  {creating
                    ? (progress ? `Creating… ${progress.done} of ${progress.total}` : "Creating…")
                    : untracked.length === 0
                      ? "Everything is already ticketed"
                      : epic && isCurrent
                        ? `Add ${untracked.length} task${untracked.length === 1 ? "" : "s"} to ${epic.issueKey}`
                        : `Create ${period ? `${period} ` : ""}remediation epic (${untracked.length} task${untracked.length === 1 ? "" : "s"})`}
                </button>
                {confirming && !creating && (
                  <div className="remediation-confirm" role="alert">
                    <span>
                      This creates {untracked.length} tasks in Jira
                      {entry.granularity === "item" ? ", one per item" : ""}. Continue?
                    </span>
                    <button type="button" className="primary-button" onClick={create}>Create {untracked.length} tasks</button>
                    <button type="button" className="secondary-button" onClick={() => setConfirming(false)}>Cancel</button>
                  </div>
                )}
                {creating && progress && progress.total > 20 && (
                  <p className="remediation-candidates__summary">
                    Creating tasks in Jira, {progress.done} of {progress.total} so far — a large finding can
                    take several minutes. Stay on this tab while it runs; if you navigate away it stops, but
                    nothing already created is lost, and pressing the button again picks up where it left off.
                  </p>
                )}
                {error && <div className="danger-zone__error" role="alert">{error}</div>}
              </>
            )
          )}
        </>
      )}
    </Panel>
    </div>
  );
}

// createRemediationEpic only ever creates up to this many tasks per call -- a synchronous
// Forge resolver has a hard execution ceiling, and issue creation is sequential and
// rate-limited, so one invocation cannot safely promise more than a bounded batch. The
// resolver says so in `itemsRemaining`; this is the safety cap on how many batches the UI
// will chain automatically before giving up and telling the admin to click again, so a bug
// that made itemsRemaining stop shrinking cannot turn into a runaway loop invoking Jira
// forever. 100 batches is 2,000 items at the current cap -- far past anything a single
// governance finding should ever produce.
const MAX_REMEDIATION_BATCHES = 100;

// How often, and for how long, the tab re-reads the tickets after "Sync now": every 10s for
// up to 10 minutes, well past what a few thousand tickets take.
export const SYNC_POLL_MS = 10000;
const SYNC_MAX_POLLS = 60;

function taskMatches(task, q) {
  return String(task.summary || "").toLowerCase().includes(q) || String(task.issueKey || "").toLowerCase().includes(q);
}

// Where a finding stands this quarter, for the State filter.
export function findingState(group) {
  if (!group || !allTaskCountOf(group)) return "untracked";
  return allOpenCountOf(group) > 0 ? "open" : "closed";
}

const STATE_OPTIONS = [
  ["all", "All"], ["open", "Has open tasks"], ["closed", "All tasks closed"], ["untracked", "Not started"],
];

// Which of a finding's flagged items still need a task. What is already ticketed comes from the
// server: each candidate carries `ticketed` when an open task holds it, by the same rule the
// create call skips by -- including tasks still open under an earlier quarter's epic, which the
// group cannot show (group.tasks is the latest quarter only). The local set covers tasks
// created since the candidates were read. Null until the finding has been checked.
export function ticketingState(candidates, group, period) {
  if (!candidates) return null;
  if (candidates.available === false) return { bucket: "unavailable", flagged: 0, untracked: [], heldEarlier: [] };
  const tasks = group?.tasks || [];
  const isCurrent = Boolean(group?.isCurrent);
  const alreadyTicketed = new Set(tasks.filter((t) => isCurrent || t.lastStatusCategory !== "done").map((t) => t.itemId));
  const items = candidates.items || [];
  const untracked = items.filter((it) => !it.ticketed && !alreadyTicketed.has(it.id));
  const heldEarlier = items.filter((it) => it.ticketed && it.ticketed.period !== period && !alreadyTicketed.has(it.id));
  const bucket = !items.length ? "clean" : untracked.length ? "to-ticket" : "ticketed";
  return { bucket, flagged: items.length, untracked, heldEarlier };
}

const TICKET_OPTIONS = [
  ["all", "All"], ["to-ticket", "Needs tickets"], ["ticketed", "All ticketed"], ["clean", "Nothing flagged"], ["unavailable", "No data"],
];

// Findings checked at once. Each check is its own resolver call with its own time limit, so
// the tab fans out rather than asking one call to read every pillar's snapshot.
export const CHECK_CONCURRENCY = 4;

const SORT_OPTIONS = [
  { value: "pillar", label: "Pillar" },
  { value: "to-ticket", label: "Most to ticket" },
  { value: "open", label: "Most open tasks" },
  { value: "name", label: "Name (A–Z)" },
];

const VIEWS = [
  { key: "progress", label: "Progress", icon: "activity" },
  { key: "findings", label: "Findings", icon: "checkCircle" },
];

export function RemediationTab({ siteOrigin, intent = null }) {
  // Which finding the reader arrived for, from an Overview "Start remediation" / "Manage".
  const [focusKey, setFocusKey] = React.useState(null);
  // Progress first; a deep link to a finding lands on Findings instead.
  const [view, setView] = usePersistentState("observatory.section.remediation", "progress", intent?.finding ? "findings" : null);
  useNavIntent(intent, (nav) => {
    setFocusKey(nav.finding ?? null);
    if (nav.finding) setView("findings");
  });
  const [search, setSearch] = React.useState("");
  const [pillarFilter, setPillarFilter] = React.useState("all");
  const [stateFilter, setStateFilter] = React.useState("all");
  const [ticketFilter, setTicketFilter] = React.useState("all");
  const [sort, setSort] = React.useState("pillar");
  // Every finding's current items, keyed by finding: read in the background when Findings
  // opens so each header can say how much is left to ticket. `checkingKeys` is what is in
  // flight; `checkRun` is the progress of the whole sweep.
  const [candidatesByKey, setCandidatesByKey] = React.useState({});
  const [checkingKeys, setCheckingKeys] = React.useState(() => new Set());
  const [checkRun, setCheckRun] = React.useState(null); // { done, total, finishedAt }
  const [tickets, setTickets] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [creatingKey, setCreatingKey] = React.useState(null);
  const [progress, setProgress] = React.useState({});
  const [errors, setErrors] = React.useState({});

  // "Sync now": the sync runs queued (minutes, not seconds), so the tab watches for
  // lastSyncedAt to move past where it was when the button was pressed, then stops.
  const [syncingSince, setSyncingSince] = React.useState(null); // { baseline } while a sync is out
  const [syncError, setSyncError] = React.useState(null);

  const fetchTickets = React.useCallback(async () => {
    try {
      const result = await invoke("getRemediationTickets", {});
      setTickets(result);
      return result;
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { fetchTickets(); }, [fetchTickets]);

  // One finding's current items. A failed read is stored as unavailable with the reason, so
  // the card says what went wrong instead of spinning.
  const loadCandidates = React.useCallback(async (findingKey) => {
    setCheckingKeys((s) => new Set(s).add(findingKey));
    let result;
    try {
      result = await invoke("getRemediationCandidates", { findingKey });
    } catch (err) {
      result = { available: false, reason: "error", error: err?.message || null, items: [] };
    }
    setCandidatesByKey((m) => ({ ...m, [findingKey]: result || { available: false, items: [] } }));
    setCheckingKeys((s) => { const next = new Set(s); next.delete(findingKey); return next; });
    return result;
  }, []);

  // Check every finding, a few at a time.
  const checkAll = React.useCallback(async (keys) => {
    let done = 0;
    setCheckRun({ done: 0, total: keys.length, finishedAt: null });
    const queue = [...keys];
    const worker = async () => {
      while (queue.length) {
        const key = queue.shift();
        // eslint-disable-next-line no-await-in-loop -- bounded fan-out, one call per worker at a time
        await loadCandidates(key);
        done += 1;
        setCheckRun((r) => (r ? { ...r, done } : r));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, keys.length) }, worker));
    setCheckRun({ done: keys.length, total: keys.length, finishedAt: new Date().toISOString() });
  }, [loadCandidates]);

  const catalogKeys = React.useMemo(() => (tickets?.catalog || []).map((e) => e.key), [tickets?.catalog]);
  const sweptRef = React.useRef(false);
  React.useEffect(() => {
    if (view !== "findings" || sweptRef.current || !catalogKeys.length) return;
    sweptRef.current = true;
    checkAll(catalogKeys);
  }, [view, catalogKeys, checkAll]);

  async function syncNow() {
    setSyncError(null);
    try {
      await invoke("syncRemediationNow", {});
      setSyncingSince({ baseline: tickets?.lastSyncedAt || null, polls: 0 });
    } catch (err) {
      setSyncError(err?.message || "Could not start the sync.");
    }
  }

  React.useEffect(() => {
    if (!syncingSince) return undefined;
    const timer = setTimeout(async () => {
      const result = await fetchTickets().catch(() => null);
      const moved = result?.lastSyncedAt && result.lastSyncedAt !== syncingSince.baseline;
      if (moved) setSyncingSince(null);
      else if (syncingSince.polls + 1 >= SYNC_MAX_POLLS) {
        setSyncingSince(null);
        setSyncError("The sync is taking longer than expected. It keeps running; check back in a few minutes.");
      } else setSyncingSince((s) => (s ? { ...s, polls: s.polls + 1 } : s));
    }, SYNC_POLL_MS);
    return () => clearTimeout(timer);
  }, [syncingSince, fetchTickets]);

  const groupsByFinding = React.useMemo(() => {
    const map = new Map();
    for (const g of tickets?.groups || []) map.set(g.findingKey, g);
    return map;
  }, [tickets]);

  // Keeps calling createRemediationEpic with the same item list until the finding's own
  // itemsRemaining says there is nothing left, or a batch fails outright. Safe to repeat --
  // the resolver is idempotent per item id -- so a page reload or a click mid-loop only ever
  // continues, never re-creates. Progress updates and a ticket-list refresh happen after
  // every batch, not just at the end, so 455 items reads as visible motion rather than one
  // long silence followed by "done" or a truncated "20 of 455" with no way to tell why.
  // `toCreate` is how many of `items` are not yet ticketed -- the progress total. The server
  // re-derives that set itself; this is only the count shown.
  async function handleCreate(findingKey, items, toCreate = items.length) {
    setCreatingKey(findingKey);
    setErrors((e) => ({ ...e, [findingKey]: null }));
    setProgress((p) => ({ ...p, [findingKey]: { done: 0, total: toCreate } }));

    let totalCreated = 0;
    const allFailures = [];
    try {
      for (let batchNum = 0; batchNum < MAX_REMEDIATION_BATCHES; batchNum++) {
        // eslint-disable-next-line no-await-in-loop -- each batch must land before the next
        // is asked for, both because the epic only needs creating once and because chaining
        // unawaited invokes would flood the same rate-limited Jira write path this exists to
        // stay within.
        const result = await invoke("createRemediationEpic", { findingKey, items });
        if (result?.error) {
          setErrors((e) => ({ ...e, [findingKey]: result.error }));
          break;
        }
        totalCreated += result.tasksCreated || 0;
        if (result.failures?.length) allFailures.push(...result.failures);
        setProgress((p) => ({ ...p, [findingKey]: { done: totalCreated, total: toCreate } }));
        // eslint-disable-next-line no-await-in-loop
        await fetchTickets();
        if (!result.itemsRemaining) break;
        if (batchNum === MAX_REMEDIATION_BATCHES - 1) {
          setErrors((e) => ({
            ...e,
            [findingKey]: `Stopped after ${MAX_REMEDIATION_BATCHES} batches with ${result.itemsRemaining} items still remaining. Click "Add tasks" again to continue.`,
          }));
        }
      }
      // A run that created nothing and failed nothing means the server found every item already
      // held by an open ticket. Said, so the button never just starts and stops.
      if (totalCreated === 0 && !allFailures.length) {
        setErrors((e) => (e[findingKey] ? e : {
          ...e,
          [findingKey]: "Nothing was created: every item is already held by an open remediation task, this quarter's or an earlier one's. Reload the tab to see where.",
        }));
      }
      if (allFailures.length) {
        setErrors((e) => ({
          ...e,
          [findingKey]: `${totalCreated} task${totalCreated === 1 ? "" : "s"} created, but ${allFailures.length} item${allFailures.length === 1 ? "" : "s"} failed: ${allFailures.slice(0, 3).map((f) => f.error).join("; ")}${allFailures.length > 3 ? "…" : ""}`,
        }));
      }
    } catch (err) {
      setErrors((e) => ({ ...e, [findingKey]: err?.message || "Failed to create the remediation ticket." }));
      // Some tasks may have landed before the failure; show them rather than a stale list.
      fetchTickets().catch(() => {});
    } finally {
      setCreatingKey(null);
      setProgress((p) => ({ ...p, [findingKey]: null }));
      // Re-read the finding so its "to ticket" count reflects what was just created.
      loadCandidates(findingKey);
    }
  }

  const catalog = React.useMemo(() => tickets?.catalog || [], [tickets]);
  const query = search.trim().toLowerCase();

  // What each finding matched the search on: its own name (show every task) or only some of
  // its tasks (show just those). Null when it did not match at all.
  const matchOf = React.useCallback((entry) => {
    if (!query || entry.label.toLowerCase().includes(query)) return { taskQuery: "" };
    const group = groupsByFinding.get(entry.key);
    const tasks = [...(group?.tasks || []), ...(group?.previousPeriods || []).flatMap((p) => p.tasks || [])];
    return tasks.some((t) => taskMatches(t, query)) ? { taskQuery: query } : null;
  }, [query, groupsByFinding]);

  // Each filter's option counts are what that choice would show given the other filters, so
  // "(0)" is never a surprise after picking it.
  // Each finding's "to ticket" state, once its items have been read.
  const ticketingByKey = React.useMemo(() => {
    const map = new Map();
    for (const entry of catalog) {
      map.set(entry.key, ticketingState(candidatesByKey[entry.key], groupsByFinding.get(entry.key), tickets?.period || null));
    }
    return map;
  }, [catalog, candidatesByKey, groupsByFinding, tickets?.period]);
  const ticketBucketOf = React.useCallback((entry) => ticketingByKey.get(entry.key)?.bucket ?? null, [ticketingByKey]);
  const toTicketOf = React.useCallback((entry) => ticketingByKey.get(entry.key)?.untracked.length || 0, [ticketingByKey]);

  const passes = React.useCallback((entry, { skipPillar = false, skipState = false, skipTicket = false } = {}) => {
    if (!skipPillar && pillarFilter !== "all" && (PILLAR_LABEL[entry.pillar] || entry.pillar) !== pillarFilter) return false;
    if (!skipState && stateFilter !== "all" && findingState(groupsByFinding.get(entry.key)) !== stateFilter) return false;
    if (!skipTicket && ticketFilter !== "all" && ticketBucketOf(entry) !== ticketFilter) return false;
    return Boolean(matchOf(entry));
  }, [pillarFilter, stateFilter, ticketFilter, groupsByFinding, matchOf, ticketBucketOf]);

  const visible = React.useMemo(() => catalog.filter((entry) => passes(entry)), [catalog, passes]);

  const pillarOptions = React.useMemo(() => {
    const labels = [...new Set(
      [...catalog].sort((a, b) => (PILLAR_RANK[a.pillar] ?? 99) - (PILLAR_RANK[b.pillar] ?? 99))
        .map((e) => PILLAR_LABEL[e.pillar] || e.pillar)
    )];
    const pool = catalog.filter((e) => passes(e, { skipPillar: true }));
    return [
      { value: "all", label: "All pillars" },
      ...labels.map((label) => ({ value: label, label, count: pool.filter((e) => (PILLAR_LABEL[e.pillar] || e.pillar) === label).length })),
    ];
  }, [catalog, passes]);

  const stateOptions = React.useMemo(() => {
    const pool = catalog.filter((e) => passes(e, { skipState: true }));
    return STATE_OPTIONS.map(([value, label]) => ({
      value,
      label,
      count: value === "all" ? undefined : pool.filter((e) => findingState(groupsByFinding.get(e.key)) === value).length,
    }));
  }, [catalog, passes, groupsByFinding]);

  // Counts per bucket among the findings checked so far; a finding not yet checked is in none.
  const ticketOptions = React.useMemo(() => {
    const pool = catalog.filter((e) => passes(e, { skipTicket: true }));
    return TICKET_OPTIONS.map(([value, label]) => ({
      value,
      label,
      count: value === "all" ? undefined : pool.filter((e) => ticketBucketOf(e) === value).length,
    }));
  }, [catalog, passes, ticketBucketOf]);

  // The visible findings, grouped under the pillar each playbook is filed under, in nav order.
  // Any other sort drops the grouping: a "most open" list split by pillar would not be
  // most-open-first.
  const sections = React.useMemo(() => {
    if (sort !== "pillar") {
      const openOf = (e) => allOpenCountOf(groupsByFinding.get(e.key));
      const sorted = [...visible].sort(sort === "open"
        ? (a, b) => openOf(b) - openOf(a) || a.label.localeCompare(b.label)
        : sort === "to-ticket"
          ? (a, b) => toTicketOf(b) - toTicketOf(a) || a.label.localeCompare(b.label)
          : (a, b) => a.label.localeCompare(b.label));
      return sorted.length ? [[null, sorted]] : [];
    }
    const byLabel = new Map();
    const sorted = [...visible].sort((a, b) => (PILLAR_RANK[a.pillar] ?? 99) - (PILLAR_RANK[b.pillar] ?? 99));
    for (const entry of sorted) {
      const label = PILLAR_LABEL[entry.pillar] || entry.pillar;
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(entry);
    }
    return [...byLabel.entries()];
  }, [visible, sort, groupsByFinding, toTicketOf]);

  function clearFilters() {
    setSearch("");
    setPillarFilter("all");
    setStateFilter("all");
    setTicketFilter("all");
  }

  const needTickets = catalog.filter((e) => ticketBucketOf(e) === "to-ticket");
  const itemsToTicket = needTickets.reduce((sum, e) => sum + toTicketOf(e), 0);
  const sweeping = checkRun && !checkRun.finishedAt;

  // Every quarter's tasks, with how many of the open ones sit under an earlier quarter's epic.
  const groupsList = tickets?.groups || [];
  const totalOpen = groupsList.reduce((sum, g) => sum + allOpenCountOf(g), 0);
  const totalClosed = groupsList.reduce((sum, g) => sum + (allTaskCountOf(g) - allOpenCountOf(g)), 0);
  const earlierOpen = groupsList.reduce((sum, g) => sum + earlierQuartersOf(g).reduce((n, q) => n + (q.openCount || 0), 0), 0);
  const earlierClosed = groupsList.reduce((sum, g) => sum + earlierQuartersOf(g).reduce((n, q) => n + ((q.taskCount || 0) - (q.openCount || 0)), 0), 0);

  return (
    <div className="admin-remediation-tab">
      <PageHeader
        title="Remediation"
        description="Turn a governance finding into tracked Jira work — one epic per finding per quarter, a task per item (or per owner, where items are many and alike), every ticket linking straight to what it is about, and status synced from Jira three times a business day."
        meta={tickets?.period ? `Current quarter: ${tickets.period}` : null}
        actions={tickets?.total > 0 && (
          <>
            <span className="ui-pagehead__meta remediation-sync__status" role="status">
              {syncingSince
                ? "Syncing with Jira…"
                : tickets.lastSyncedAt ? `Last synced ${formatRelativeTime(tickets.lastSyncedAt)}` : "Never synced"}
            </span>
            <button
              type="button"
              className="secondary-button secondary-button--small"
              onClick={syncNow}
              disabled={Boolean(syncingSince)}
            >
              {syncingSince ? "Syncing…" : "Sync now"}
            </button>
          </>
        )}
      />
      {syncError && <div className="danger-zone__error" role="alert">{syncError}</div>}

      <SubNavLayout items={VIEWS} activeKey={view} onSelect={setView}>
        {view === "progress" ? (
          <RemediationProgress />
        ) : loading ? (
          <EmptyState inline>Loading…</EmptyState>
        ) : (
          <>
            <StatRow>
              <StatTile label="Findings tracked" value={(tickets?.groups || []).length} icon="layers" />
              <StatTile label="Open tasks" value={totalOpen} tone={totalOpen > 0 ? "active" : "success"} icon="clock"
                hint={earlierOpen > 0 ? `${earlierOpen} from earlier quarters` : null} />
              <StatTile label="Closed tasks" value={totalClosed} tone="success" icon="checkCircle"
                hint={earlierClosed > 0 ? `${earlierClosed} from earlier quarters` : null} />
              <StatTile
                label="Need tickets"
                value={needTickets.length}
                tone={needTickets.length > 0 ? "warning" : "neutral"}
                icon="wrench"
                hint={sweeping
                  ? `checking ${checkRun.done} of ${checkRun.total} findings…`
                  : `${itemsToTicket} item${itemsToTicket === 1 ? "" : "s"} with no task yet`}
              />
            </StatRow>
            <p className="remediation-history" aria-live="polite">
              {sweeping
                ? `Checking which findings still need tickets: ${checkRun.done} of ${checkRun.total}.`
                : checkRun?.finishedAt
                  ? `Checked every finding ${formatRelativeTime(checkRun.finishedAt)}.`
                  : null}
              {!sweeping && checkRun?.finishedAt && (
                <>
                  {" "}
                  {needTickets.length > 0 && ticketFilter !== "to-ticket" && (
                    <button type="button" className="secondary-button secondary-button--small" onClick={() => { setTicketFilter("to-ticket"); setSort("to-ticket"); }}>
                      Show the {needTickets.length} that need tickets
                    </button>
                  )}{" "}
                  <button type="button" className="secondary-button secondary-button--small" onClick={() => checkAll(catalogKeys)}>
                    Recheck
                  </button>
                </>
              )}
            </p>

            <SortFilterBar
              search={search}
              onSearchChange={setSearch}
              searchPlaceholder="Search findings, task summaries or issue keys"
              searchLabel="Search remediation"
              sort={sort}
              onSortChange={setSort}
              sortOptions={SORT_OPTIONS}
              filters={[
                { key: "pillar", label: "Pillar", value: pillarFilter, onChange: setPillarFilter, options: pillarOptions },
                { key: "state", label: "State", value: stateFilter, onChange: setStateFilter, options: stateOptions },
                { key: "tickets", label: "Tickets", value: ticketFilter, onChange: setTicketFilter, options: ticketOptions },
              ]}
              resultCount={visible.length}
              totalCount={catalog.length}
              onClear={clearFilters}
            />

            {sections.length === 0 && (
              <EmptyState inline>No findings match. Clear the search or filters to see them all.</EmptyState>
            )}

            {sections.map(([label, entries]) => (
              <section key={label || "all"}>
                {label && <h3 className="remediation-group__title">{label}</h3>}
                {entries.map((entry) => (
                  <FindingCard
                    key={entry.key}
                    entry={entry}
                    group={groupsByFinding.get(entry.key)}
                    period={tickets?.period || null}
                    siteOrigin={siteOrigin}
                    onCreate={handleCreate}
                    creating={creatingKey === entry.key}
                    progress={progress[entry.key] || null}
                    error={errors[entry.key]}
                    focused={focusKey === entry.key}
                    taskQuery={matchOf(entry)?.taskQuery || ""}
                    candidates={candidatesByKey[entry.key] || null}
                    ticketing={ticketingByKey.get(entry.key) || null}
                    checking={checkingKeys.has(entry.key)}
                    onLoadCandidates={loadCandidates}
                  />
                ))}
              </section>
            ))}
          </>
        )}
      </SubNavLayout>
    </div>
  );
}
