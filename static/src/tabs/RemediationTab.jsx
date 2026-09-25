import React from "react";
import { invoke } from "@forge/bridge";
import { buildIssueUrl, handleJiraLinkClick, formatRelativeTime } from "../utils";
import { Icon } from "../components/Icons";
import { PageHeader, Panel, StatRow, StatTile, EmptyState, RemediationStatus } from "../components/ui";
import { useNavIntent } from "../hooks";

// The playbook catalog is served with the tickets (getRemediationTickets -> catalog), so this
// tab never holds its own copy of which playbooks exist. It used to: a static list here that
// had to be kept in step with remediation-playbooks.js by hand.

// Display names for the health-pillar keys a playbook is filed under, in the order the admin
// nav lists the pillars.
const PILLAR_ORDER = [
  ["fields", "Fields"], ["projects", "Projects"], ["workflows", "Workflows"], ["issueTypes", "Issue Types"],
  ["estate", "Priorities"], ["users", "People"], ["assets", "Assets"], ["permissions", "Access"],
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
// whether the hourly sync has ever actually reached this ticket -- a task created seconds ago
// and not yet synced is a different fact from one the sync checked an hour ago and found
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
function FindingCard({ entry, group, period, siteOrigin, onCreate, creating, progress, error, focused = false }) {
  const [expanded, setExpanded] = React.useState(focused);
  const [confirming, setConfirming] = React.useState(false);
  const cardRef = React.useRef(null);

  // Arrived from an Overview finding: open this card and bring it into view.
  React.useEffect(() => {
    if (!focused) return;
    setExpanded(true);
    try { cardRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }); } catch { /* jsdom */ }
  }, [focused]);
  const [candidates, setCandidates] = React.useState(null);
  const [loadingCandidates, setLoadingCandidates] = React.useState(false);

  const epic = group?.epic || null;
  const tasks = group?.tasks || [];
  const openCount = group?.openCount ?? 0;

  async function loadCandidates() {
    if (candidates || loadingCandidates) return;
    setLoadingCandidates(true);
    try {
      const result = await invoke("getRemediationCandidates", { findingKey: entry.key });
      setCandidates(result);
    } finally {
      setLoadingCandidates(false);
    }
  }

  React.useEffect(() => {
    if (expanded) loadCandidates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  // Mirrors loadTicketedItemIds: this quarter's tasks block re-ticketing outright; an earlier
  // quarter's tasks block it only while still open. (The server re-checks; this is the count
  // the button shows.)
  const isCurrent = Boolean(group?.isCurrent);
  const alreadyTicketed = new Set(tasks.filter((t) => isCurrent || t.lastStatusCategory !== "done").map((t) => t.itemId));
  const untracked = (candidates?.items || []).filter((it) => !alreadyTicketed.has(it.id));
  const needsConfirm = untracked.length > CONFIRM_ABOVE;

  function create() {
    if (needsConfirm && !confirming) { setConfirming(true); return; }
    setConfirming(false);
    onCreate(entry.key, candidates.items);
  }

  return (
    <div ref={cardRef}>
    <Panel
      title={entry.label}
      icon="checkCircle"
      description={<RemediationStatus group={group} period={period} siteOrigin={siteOrigin} compact />}
      // Every finding is independently collapsible -- the epic chip above stays visible in
      // the collapsed header, so a tracked finding is never mistaken for an untouched one
      // just because it is folded away.
      collapsible
    >
      {(
        <>
          {(group?.previousPeriods || []).length > 0 && (
            <p className="remediation-history">
              Earlier quarters:{" "}
              {group.previousPeriods.map((p, i) => (
                <span key={p.period}>
                  {i > 0 ? ", " : ""}
                  {p.period}{" "}
                  {p.epicKey ? <IssueLink issueKey={p.epicKey} siteOrigin={siteOrigin}>{p.epicKey}</IssueLink> : "(no epic)"}
                  {` (${p.taskCount - p.openCount} of ${p.taskCount} closed)`}
                </span>
              ))}
            </p>
          )}
          {epic && isCurrent && (
            <StatRow>
              <StatTile label="Tasks" value={tasks.length} icon="layers" />
              <StatTile label="Open" value={openCount} tone={openCount > 0 ? "active" : "success"} icon="clock" />
              <StatTile label="Closed" value={tasks.length - openCount} tone="success" icon="checkCircle" />
            </StatRow>
          )}

          {tasks.length > 0 && (
            <div className="remediation-tasks">
              {tasks.map((task) => <TaskRow key={task.issueKey} task={task} siteOrigin={siteOrigin} />)}
            </div>
          )}

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

export function RemediationTab({ siteOrigin, intent = null }) {
  // Which finding the reader arrived for, from an Overview "Start remediation" / "Manage".
  const [focusKey, setFocusKey] = React.useState(null);
  useNavIntent(intent, (nav) => setFocusKey(nav.finding ?? null));
  const [tickets, setTickets] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [creatingKey, setCreatingKey] = React.useState(null);
  const [progress, setProgress] = React.useState({});
  const [errors, setErrors] = React.useState({});

  const fetchTickets = React.useCallback(async () => {
    try {
      const result = await invoke("getRemediationTickets", {});
      setTickets(result);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { fetchTickets(); }, [fetchTickets]);

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
  async function handleCreate(findingKey, items) {
    setCreatingKey(findingKey);
    setErrors((e) => ({ ...e, [findingKey]: null }));
    setProgress((p) => ({ ...p, [findingKey]: { done: 0, total: items.length } }));

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
        setProgress((p) => ({ ...p, [findingKey]: { done: totalCreated, total: items.length } }));
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
      if (allFailures.length) {
        setErrors((e) => ({
          ...e,
          [findingKey]: `${totalCreated} task${totalCreated === 1 ? "" : "s"} created, but ${allFailures.length} item${allFailures.length === 1 ? "" : "s"} failed: ${allFailures.slice(0, 3).map((f) => f.error).join("; ")}${allFailures.length > 3 ? "…" : ""}`,
        }));
      }
    } catch (err) {
      setErrors((e) => ({ ...e, [findingKey]: err?.message || "Failed to create the remediation ticket." }));
    } finally {
      setCreatingKey(null);
      setProgress((p) => ({ ...p, [findingKey]: null }));
    }
  }

  // The catalog, grouped under the pillar each playbook is filed under, in nav order.
  const sections = React.useMemo(() => {
    const byLabel = new Map();
    const sorted = [...(tickets?.catalog || [])].sort((a, b) => (PILLAR_RANK[a.pillar] ?? 99) - (PILLAR_RANK[b.pillar] ?? 99));
    for (const entry of sorted) {
      const label = PILLAR_LABEL[entry.pillar] || entry.pillar;
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(entry);
    }
    return [...byLabel.entries()];
  }, [tickets]);

  const totalOpen = (tickets?.groups || []).reduce((sum, g) => sum + (g.openCount || 0), 0);
  const totalClosed = (tickets?.groups || []).reduce((sum, g) => sum + ((g.taskCount || 0) - (g.openCount || 0)), 0);

  return (
    <div className="admin-remediation-tab">
      <PageHeader
        title="Remediation"
        description="Turn a governance finding into tracked Jira work — one epic per finding per quarter, a task per item (or per owner, where items are many and alike), every ticket linking straight to what it is about, and status synced hourly from Jira."
        meta={tickets?.period ? `Current quarter: ${tickets.period}` : null}
      />

      {loading ? (
        <EmptyState inline>Loading…</EmptyState>
      ) : (
        <>
          <StatRow>
            <StatTile label="Findings tracked" value={(tickets?.groups || []).length} icon="layers" />
            <StatTile label="Open tasks" value={totalOpen} tone={totalOpen > 0 ? "active" : "success"} icon="clock" />
            <StatTile label="Closed tasks" value={totalClosed} tone="success" icon="checkCircle" />
          </StatRow>

          {sections.map(([label, entries]) => (
            <section key={label}>
              <h3 className="remediation-group__title">{label}</h3>
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
                />
              ))}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
