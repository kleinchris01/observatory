// Remediation: candidates per finding, quarterly epics and tasks, the hierarchy, status sync, and verifying fixes held.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import {
  incrMetric,
  METRIC_NAMES,
  getInstallationKey,
  mapWithConcurrency,
  createJiraIssue,
  updateJiraIssue,
  searchIssuesPage,
  transitionIssueWithComment,
  getSiteBaseUrl,
  normalizeSiteOrigin,
} from "../lib/jira-api.js";
import { hydrateFieldsForGovernance } from "../lib/snapshot-engine.js";
import {
  ensureProjectStoreReady,
  readSnapshotMeta,
  loadSnapshotFields,
  listSnapshotProjects,
  loadProjectActivity,
  loadFilters,
  readFilterSnapshotMeta,
  loadFilterReferenceCounts,
  loadDashboards,
  readDashboardSnapshotMeta,
  readWorkflowSnapshotMeta,
  transitionAwareWorkflowVersion,
  loadStatusesCatalog,
  loadWorkflowSchemeStatuses,
  loadStatusIssueCounts,
  readScreenSnapshotMeta,
  loadScreenSchemes,
  loadScreenSchemeOperations,
  readIssueTypeSnapshotMeta,
  loadIssueTypes,
  loadIssueTypeSchemeItems,
  readUserSnapshotMeta,
  loadUsers,
  readBoardSnapshotMeta,
  loadBoards,
  loadBoardColumns,
  recordRemediationTicket,
  loadRemediationTickets,
  getRemediationEpic,
  loadTicketedItemIds,
  loadTicketedItems,
  loadHierarchyNodes,
  recordHierarchyNode,
  currentPeriod,
  loadArchivedFieldUsage,
} from "../lib/project-store.js";
import { getPlaybook, listPlaybookCatalog, REMEDIATION_FINDING_INDEX } from "../lib/remediation-playbooks.js";
import { ensureInitiativeFor, ROOT_NODE } from "../lib/remediation-hierarchy.js";
import { computeRemediationMetrics } from "../lib/remediation-metrics.js";
import { queueRemediationSync } from "../lib/remediation-sync.js";
import { renderADF } from "../lib/adf.js";
import { verifyTickets, verificationComment, targetCategory } from "../lib/remediation-verify.js";
import { getWorkflowRuleInsights } from "../lib/workflow-rule-reads.js";
import { CANDIDATE_SELECTORS } from "../lib/remediation-candidates.js";
import { getFieldConfigInventory } from "../lib/fieldconfig-reads.js";
import { summarizeBoardInsights } from "../lib/board-insights.js";
import { summarizeIssueTypeInsights } from "../lib/issuetype-insights.js";
import { summarizeAssetInsights } from "../lib/asset-insights.js";
import { buildProjectInsights, attachUniqueIssueCounts } from "../lib/site-health.js";
import { summarizeAdoption } from "../lib/project-adoption.js";
import { summarizeFilters } from "../lib/filter-insights.js";
import { summarizeDashboards } from "../lib/dashboard-insights.js";
import { findOrphanedStatuses } from "../lib/workflow-insights.js";
import { activeRosterIds, buildOwnershipIndex } from "../lib/user-ownership.js";
import { readAutomationAnalysis, readAutomationPart, loadStatusAutomationReferences } from "../lib/store/automation.js";
import { logger, fallbackOn } from "../lib/logger.js";
import { requireArray } from "../lib/validate.js";
import { readAdminConfig } from "./admin-config.js";
import { callerAccountId } from "./viewer.js";
import { getIssueTypeInventory } from "./issue-types.js";
import { getUserInventory, collectRuleUserReferences } from "./people.js";
import { getAccessInventory } from "./access.js";
import { getAssetInventory } from "./assets.js";
import { getEstateInventory } from "./estate.js";
import { loadJsmView } from "./jsm.js";
import { loadFiltersWithFindings } from "./filters-dashboards.js";
import { getScreenFieldCrossSignal, loadAllScreenPages } from "./screens.js";
import { computeBoardStatusIds, computeWorkflowInsightsFull } from "./workflows.js";

// ── Remediation ticketing ──────────────────────────────────────────────────
//
// The one place Observatory writes to Jira. A governance finding becomes an epic in a
// project the admin configures, and each item to fix becomes a task under it. Every write
// is as the calling admin (attribution + their permissions), behind the read-only-mode
// gate, and audited. Idempotent: the epic is keyed on the finding and a task on the item,
// so re-running only fills in what is missing.

// A synchronous resolver creates a bounded batch. A finding with hundreds of items is
// finished by the queued job (a later change); this covers the common case in one click.
export const MAX_SYNC_REMEDIATION_TASKS = 20;

// The count cap alone is not enough: a Forge resolver is killed at ~25s, and on a slow site
// one issue create plus its row write takes ~3-4s, so 20 never fit -- the invocation died
// around task 7, the UI got no itemsRemaining back and stopped, and a create cut off mid-flight
// could land in Jira unrecorded. No new task starts once this much of the invocation has
// gone; the UI chains the next batch off itemsRemaining.
export const REMEDIATION_TIME_BUDGET_MS = 15000;

export async function getRemediationTickets({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const findingKey = payload?.findingKey ? String(payload.findingKey) : null;
  const tickets = await loadRemediationTickets(installationKey, findingKey);

  // Grouped by finding: the most recent quarter's epic and tasks, which is what the UI works
  // on, plus a one-line summary of each earlier quarter, so a finding that keeps coming back
  // reads as such. `isCurrent` says whether that latest epic is this quarter's -- if not, the
  // next "Create remediation" opens a new one. `open` counts anything not "done".
  const period = currentPeriod();
  const byFinding = new Map();
  for (const t of tickets) {
    if (!byFinding.has(t.findingKey))
      byFinding.set(t.findingKey, { findingKey: t.findingKey, pillar: t.pillar, periods: new Map() });
    const f = byFinding.get(t.findingKey);
    if (!f.periods.has(t.period)) f.periods.set(t.period, { period: t.period, epic: null, tasks: [] });
    const p = f.periods.get(t.period);
    if (t.isEpic) p.epic = t;
    else p.tasks.push(t);
  }
  const openOf = (tasks) => tasks.filter((t) => t.lastStatusCategory !== "done").length;
  const groups = [...byFinding.values()].map((f) => {
    const periods = [...f.periods.values()].sort((a, b) => String(b.period).localeCompare(String(a.period)));
    const latest = periods[0];
    return {
      findingKey: f.findingKey,
      pillar: f.pillar,
      period: latest.period,
      isCurrent: latest.period === period,
      epic: latest.epic,
      tasks: latest.tasks,
      taskCount: latest.tasks.length,
      openCount: openOf(latest.tasks),
      // Every quarter's work, not just the latest: a task still open under last quarter's
      // epic is open work on this finding, and the tab lists and counts it.
      allTaskCount: periods.reduce((n, p) => n + p.tasks.length, 0),
      allOpenCount: periods.reduce((n, p) => n + openOf(p.tasks), 0),
      previousPeriods: periods.slice(1).map((p) => ({
        period: p.period,
        epicKey: p.epic?.issueKey ?? null,
        epicStatusCategory: p.epic?.lastStatusCategory ?? null,
        taskCount: p.tasks.length,
        openCount: openOf(p.tasks),
        tasks: p.tasks,
      })),
    };
  });

  // The latest time the sync reached any ticket. Null means it never has, which the tab says in
  // those words rather than implying the tickets were checked and found untouched.
  const lastSyncedAt = tickets.reduce(
    (latest, t) => (t.syncedAt && (!latest || t.syncedAt > latest) ? t.syncedAt : latest),
    null,
  );

  // The catalog and the finding index travel with the tickets, so neither the Remediation tab
  // nor the Overview keeps its own copy of which playbooks exist or which finding each covers.
  // The quarter's hierarchy, when it is on: whether it is set up and where its top item is.
  const rc = (await readAdminConfig().catch(() => ({})))?.remediation || {};
  let hierarchy = null;
  if (rc.hierarchyEnabled) {
    const nodes = await loadHierarchyNodes(installationKey, period).catch(
      fallbackOn("remediation.hierarchy_read_failed", () => new Map(), { installationKey }),
    );
    hierarchy = {
      enabled: true,
      rootKey: nodes.get(ROOT_NODE)?.issueKey || null,
      initiativeCount: [...nodes.keys()].filter((k) => k.startsWith("initiative:")).length,
    };
  }

  return {
    available: tickets.length > 0,
    total: tickets.length,
    lastSyncedAt,
    period,
    hierarchy,
    groups,
    catalog: listPlaybookCatalog(),
    findingIndex: REMEDIATION_FINDING_INDEX,
  };
}

// Progress metrics for the Remediation tab: burn-down, throughput, time to close, ageing, and
// where the open work sits. The numbers come from computeRemediationMetrics, a pure function
// over the stored ticket rows; this only loads them. `scope` is "quarter" (default) or "all".
// Did the fixes hold? Every remediation task checked against the latest scan: closed and no
// longer flagged (held), closed but still flagged (regressed), open but already fixed, or still
// open. Candidates come from the same loaders that created the tasks, so item ids match.
// Admin read; it changes nothing in Jira.
// For findings whose fix REMOVES the item: why an item that is no longer flagged but still
// exists was never a candidate after all. A task for it is withdrawn ("do not act"), not
// closed as fixed. Map item id -> evidence; an item absent from the map was really fixed.
// Field cleanup is the case that matters: "delete this field, nobody uses it" for a field
// whose data is in archived projects (or newly populated) would destroy data.
export const WITHDRAWAL_EVIDENCE = {
  "field-cleanup": async (installationKey) => {
    const fields = await hydratedFields(installationKey);
    if (!fields) return null;
    const holding = fields.filter((f) => (f.totalIssueCount || 0) > 0 || (f.archivedIssueCount || 0) > 0);
    const archived = holding.some((f) => f.archivedIssueCount > 0)
      ? await loadArchivedFieldUsage(
          installationKey,
          holding.filter((f) => f.archivedIssueCount > 0).map((f) => f.id),
        )
      : new Map();
    const n = (v) => Number(v).toLocaleString("en-US");
    return new Map(
      holding.map((f) => {
        const parts = [];
        if (f.totalIssueCount > 0)
          parts.push(
            `it holds values on ${n(f.totalIssueCount)} issue${f.totalIssueCount === 1 ? "" : "s"} in active projects`,
          );
        if (f.archivedIssueCount > 0) {
          const keys = (archived.get(String(f.id)) || []).map((r) => r.projectKey).filter(Boolean);
          parts.push(
            `it holds values on ${n(f.archivedIssueCount)} issue${f.archivedIssueCount === 1 ? "" : "s"} in archived projects${keys.length ? ` (${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ", …" : ""})` : ""}, which Jira's search cannot see`,
          );
        }
        return [String(f.id), `${parts.join("; ")}. Deleting it would destroy that data`];
      }),
    );
  },
};

// `payload.findingKey` narrows it to one finding: the finding card's "Review and close".
export async function getRemediationVerification({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  const only = payload?.findingKey ? String(payload.findingKey) : null;
  const tickets = (await loadRemediationTickets(installationKey)).filter((t) => !only || t.findingKey === only);
  const findingKeys = [...new Set(tickets.filter((t) => !t.isEpic).map((t) => t.findingKey))];
  const current = new Map();
  await mapWithConcurrency(findingKeys, 3, async (findingKey) => {
    try {
      const result = await loadRemediationCandidates({ payload: { findingKey }, context });
      const withdrawn =
        result?.available !== false && WITHDRAWAL_EVIDENCE[findingKey]
          ? await WITHDRAWAL_EVIDENCE[findingKey](installationKey).catch(
              fallbackOn("remediation.withdrawal_evidence_failed", () => null, { installationKey, findingKey }),
            )
          : null;
      current.set(
        findingKey,
        result?.available === false
          ? { available: false, ids: new Set(), reason: result.reason || "unavailable" }
          : { available: true, ids: new Set((result?.items || []).map((it) => String(it.id ?? it.name))), withdrawn },
      );
    } catch (error) {
      logger.warn("remediation.verify_candidates_failed", {
        installationKey,
        findingKey,
        error: String(error?.message || error),
      });
      current.set(findingKey, { available: false, ids: new Set(), reason: "error" });
    }
  });
  const labels = Object.fromEntries(listPlaybookCatalog().map((p) => [p.key, p.label]));
  return { checkedAt: new Date().toISOString(), labels, ...verifyTickets({ tickets, current }) };
}

// Act on verification: reopen tasks whose fix did not hold, close tasks whose item is fixed.
// Explicit admin action only -- the page lists the candidates, an admin chooses them. Verdicts
// are recomputed here rather than trusted from the page, so a task that changed since the page
// loaded is left alone and says why. Each task gets a comment explaining the move, written as
// the admin. Mutating and audited.
export const MAX_VERIFICATION_APPLY = 50;

export async function applyRemediationVerification({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  requireArray(payload?.issueKeys, "issueKeys");
  // Read-only mode is the kill switch for every Jira write; this one used to miss it and would
  // still reopen, close and comment on tasks.
  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode)
    return { error: "Read-only mode is enabled. Disable it before changing remediation tickets." };
  const issueKeys = [...new Set(payload.issueKeys.map(String))].slice(0, MAX_VERIFICATION_APPLY);

  const verification = await getRemediationVerification({
    payload: { findingKey: payload.findingKey || null },
    context,
  });
  const byKey = new Map(verification.rows.map((r) => [r.issueKey, r]));
  const results = [];
  for (const issueKey of issueKeys) {
    const row = byKey.get(issueKey);
    const target = row ? targetCategory(row.verdict) : null;
    if (!target) {
      results.push({
        issueKey,
        transitioned: false,
        commented: false,
        reason: row
          ? `Its verdict is now "${row.verdict}", so it was left as it is.`
          : "Not an Observatory remediation task.",
      });
      continue;
    }
    const text = verificationComment(row, {
      checkedAt: verification.checkedAt,
      findingLabel: verification.labels[row.findingKey],
    });
    try {
      // eslint-disable-next-line no-await-in-loop -- one ticket at a time; each is a write.
      results.push(await transitionIssueWithComment(issueKey, { target, commentBody: renderADF(text), asUser: true }));
    } catch (error) {
      results.push({ issueKey, transitioned: false, commented: false, reason: String(error?.message || error) });
    }
  }
  // Pull the new statuses back now rather than at the next hourly sync.
  await queueRemediationSync(installationKey).catch(
    fallbackOn("remediation.verify_sync_queue_failed", null, { installationKey }),
  );
  return {
    results,
    applied: results.filter((r) => r.transitioned).length,
    skipped: payload.issueKeys.length - issueKeys.length,
  };
}

export async function getRemediationMetrics({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const scope = payload?.scope === "all" ? "all" : "quarter";
  const tickets = await loadRemediationTickets(installationKey);
  const labels = Object.fromEntries(listPlaybookCatalog().map((entry) => [entry.key, entry.label]));
  return computeRemediationMetrics({ tickets, now: new Date(), period: currentPeriod(), scope, labels });
}

// "Sync now": queues the same job the scheduled trigger queues, run by the queue consumer,
// which has the time a few thousand tickets need and a resolver does not. It reads Jira and writes only
// Observatory's own rows, so it is not behind the read-only-mode gate -- the scheduled sync
// is not either.
export async function syncRemediationNow({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  return queueRemediationSync(getInstallationKey(context));
}

// What ensureInitiativeFor needs, bound to this site and quarter.
export async function hierarchyDeps(installationKey, period) {
  return {
    nodes: await loadHierarchyNodes(installationKey, period),
    existing: new Map(),
    searchIssuesPage,
    createJiraIssue,
    recordHierarchyNode,
  };
}

// "Organise under initiatives": puts this quarter's epics under their pillar's initiative,
// creating or adopting the quarter's Product and Initiatives as needed. Only epics whose parent
// is not already the right initiative are edited. Time-budgeted like the task create, with the
// rest handed back as `remaining` for the tab to ask for again.
export async function organiseRemediationHierarchy({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  const startedAt = Date.now();
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode)
    return { error: "Read-only mode is enabled. Disable it before changing remediation tickets." };
  const rc = adminConfig.remediation || {};
  if (!rc.projectKey)
    return { error: "No remediation project is configured. Set one in Configuration → Remediation first." };
  if (!rc.hierarchyEnabled)
    return { error: "The remediation hierarchy is off. Turn it on in Configuration → Remediation first." };
  const accountId = callerAccountId(context);
  if (!accountId) return { error: "Could not identify the calling user." };

  const period = currentPeriod();
  const epics = (await loadRemediationTickets(installationKey)).filter((t) => t.isEpic && t.period === period);
  if (!epics.length) return { ok: true, period, organised: 0, alreadyPlaced: 0, remaining: 0, failures: [] };

  // Each epic's current parent, in one search.
  const keys = epics.map((e) => e.issueKey);
  const current = await searchIssuesPage(`issuekey in (${keys.join(", ")})`, ["parent"], Math.min(keys.length, 100));
  const parentOf = new Map(current.map((i) => [i.key, i.fields?.parent?.key || null]));

  const deps = await hierarchyDeps(installationKey, period);
  let organised = 0;
  let alreadyPlaced = 0;
  let attempted = 0;
  const failures = [];
  for (const epic of epics) {
    if (attempted > 0 && Date.now() - startedAt > REMEDIATION_TIME_BUDGET_MS) break;
    attempted += 1;
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential: nodes are created once and reused
      const { initiativeKey } = await ensureInitiativeFor(
        { scopeKey: installationKey, period, pillar: epic.pillar, config: rc, projectKey: rc.projectKey, accountId },
        deps,
      );
      if (parentOf.get(epic.issueKey) === initiativeKey) {
        alreadyPlaced += 1;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await updateJiraIssue(epic.issueKey, { parent: { key: initiativeKey } }, { asUser: true });
      organised += 1;
    } catch (error) {
      failures.push({ epicKey: epic.issueKey, error: String(error?.message || error) });
    }
  }
  logger.info("remediation.hierarchy_organised", {
    installationKey,
    period,
    organised,
    alreadyPlaced,
    failures: failures.length,
  });
  return {
    ok: true,
    period,
    organised,
    alreadyPlaced,
    rootKey: deps.nodes.get(ROOT_NODE)?.issueKey || null,
    remaining: Math.max(0, epics.length - attempted),
    failures,
  };
}

export async function createRemediationEpic({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  const startedAt = Date.now();
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const findingKey = String(payload?.findingKey || "").trim();
  const playbook = getPlaybook(findingKey);
  if (!playbook) return { error: `No remediation playbook for "${findingKey}".` };

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { error: "Read-only mode is enabled. Disable it before creating remediation tickets." };
  }

  const rc = adminConfig.remediation || {};
  if (!rc.projectKey) {
    return { error: "No remediation project is configured. Set one in Configuration → Remediation first." };
  }

  const accountId = callerAccountId(context);
  if (!accountId) return { error: "Could not identify the calling user, so the tickets would have no reporter." };

  const rawItems = Array.isArray(payload?.items) ? payload.items : [];
  const items = rawItems
    .filter((it) => it && (it.id != null || it.name))
    .map((it) => ({
      ...it,
      id: String(it.id ?? it.name),
      name: it.name != null ? String(it.name).slice(0, 240) : null,
    }));
  const pillar = payload?.pillar ? String(payload.pillar) : playbook.pillar;
  const nowIso = () => new Date().toISOString();
  // Every ticket links straight to what it is about. The invocation context carries the site
  // URL; serverInfo is the fallback. Neither is required -- without one, tickets go out unlinked.
  const origin = normalizeSiteOrigin(context?.siteUrl) || (await getSiteBaseUrl());

  // One epic per finding per calendar quarter. Within the quarter a second click adds only
  // the tasks still missing; the next quarter starts a fresh epic carrying what is flagged
  // then (loadTicketedItemIds decides which items that is).
  const period = currentPeriod();
  let epic = await getRemediationEpic(installationKey, findingKey, period);
  let epicCreated = false;
  if (!epic) {
    // The quarter's Product and this pillar's Initiative first, when the hierarchy is on: the
    // first epic of a quarter brings them with it (found and adopted if they already exist).
    let initiativeKey = null;
    if (rc.hierarchyEnabled) {
      try {
        ({ initiativeKey } = await ensureInitiativeFor(
          { scopeKey: installationKey, period, pillar, config: rc, projectKey: rc.projectKey, accountId },
          await hierarchyDeps(installationKey, period),
        ));
      } catch (error) {
        return {
          error: `Placing the epic under its initiative failed: ${error?.message || error}. Check the Product and Initiative issue types in Configuration → Remediation, or turn the hierarchy off.`,
        };
      }
    }
    try {
      const fields = {
        project: { key: rc.projectKey },
        issuetype: { name: rc.epicIssueType || "Epic" },
        summary: `${period}: ${playbook.epicSummary(items.length)}`.slice(0, 250),
        description: renderADF(playbook.epicDescription({ count: items.length, origin })),
        labels: playbook.labels,
        reporter: { id: accountId },
        ...(initiativeKey ? { parent: { key: initiativeKey } } : {}),
      };
      const created = await createJiraIssue(fields, { asUser: true });
      await recordRemediationTicket(installationKey, {
        findingKey,
        period,
        pillar,
        isEpic: true,
        issueKey: created.key,
        issueId: created.id,
        epicKey: created.key,
        summary: fields.summary,
        createdBy: accountId,
        createdAt: nowIso(),
      });
      epic = { issueKey: created.key, issueId: created.id };
      epicCreated = true;
    } catch (error) {
      return { error: `Creating the epic failed: ${error?.message || error}` };
    }
  }

  const alreadyTicketed = await loadTicketedItemIds(installationKey, findingKey, period);
  const todo = items.filter((it) => !alreadyTicketed.has(it.id));
  const batch = todo.slice(0, MAX_SYNC_REMEDIATION_TASKS);

  let tasksCreated = 0;
  let attempted = 0;
  const failures = [];
  for (const it of batch) {
    // Always attempt at least one, so a slow epic create cannot stall the chain at zero.
    if (attempted > 0 && Date.now() - startedAt > REMEDIATION_TIME_BUDGET_MS) break;
    attempted += 1;
    const fields = {
      project: { key: rc.projectKey },
      issuetype: { name: rc.taskIssueType || "Task" },
      summary: playbook.taskSummary(it).slice(0, 250),
      description: renderADF(playbook.taskDescription(it, { origin })),
      labels: playbook.labels,
      parent: { key: epic.issueKey },
      reporter: { id: accountId },
    };
    if (rc.defaultAssigneeAccountId) fields.assignee = { id: rc.defaultAssigneeAccountId };
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential on purpose: each task links
      // to the epic and issue creation is rate-limited and non-idempotent.
      const created = await createJiraIssue(fields, { asUser: true });
      // eslint-disable-next-line no-await-in-loop
      await recordRemediationTicket(installationKey, {
        findingKey,
        period,
        pillar,
        itemId: it.id,
        issueKey: created.key,
        issueId: created.id,
        epicKey: epic.issueKey,
        summary: fields.summary,
        createdBy: accountId,
        createdAt: nowIso(),
      });
      tasksCreated += 1;
    } catch (error) {
      failures.push({ itemId: it.id, error: String(error?.message || error) });
    }
  }

  logger.info("remediation.epic_created", {
    installationKey,
    findingKey,
    epicKey: epic.issueKey,
    epicCreated,
    tasksCreated,
    itemsTotal: items.length,
    failures: failures.length,
  });

  return {
    ok: true,
    epicKey: epic.issueKey,
    epicCreated,
    period,
    tasksCreated,
    itemsTotal: items.length,
    itemsRemaining: Math.max(0, todo.length - attempted),
    failures,
  };
}

// The current items behind one remediation finding -- what "Create remediation" actually
// tickets. Every branch here re-reads the same snapshot rows the finding's own tab already
// loads (getUserInventory's roster, getBoardInventory's insights, getWorkflowInsights'
// orphans, getFieldInventory's governance findings) rather than re-deriving the join, so a
// finding and its remediation candidates can never disagree about what is currently flagged.
//
// Each item comes back marked with the open ticket that already holds it, if any -- decided by
// loadTicketedItems, the same rule createRemediationEpic skips by. The tab used to work that
// out itself from the current quarter's tasks only, so after a quarter rolled over it offered
// to ticket items still open under last quarter's epic, and the button "ran" and created
// nothing: the server skipped every one.
export async function getRemediationCandidates({ payload, context }) {
  const result = await loadRemediationCandidates({ payload, context });
  if (!result?.items?.length) return result;
  const installationKey = getInstallationKey(context);
  const findingKey = String(payload?.findingKey || "");
  const ticketed = await loadTicketedItems(installationKey, findingKey, currentPeriod()).catch(
    fallbackOn("remediation.candidates_ticketed_failed", () => null, { installationKey, findingKey }),
  );
  if (!ticketed) return result;
  return {
    ...result,
    items: result.items.map((it) => {
      const t = ticketed.get(String(it.id ?? it.name));
      return t ? { ...it, ticketed: t } : it;
    }),
  };
}

export async function loadRemediationCandidates({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  const findingKey = String(payload?.findingKey || "");

  if (findingKey === "filter-ownership") {
    const meta = await readFilterSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
    const filters = await loadFilters(installationKey, meta.version);
    const summary = summarizeFilters(filters);
    const items = summary.filters
      .filter((f) => f.findings.some((finding) => finding.code === "orphaned-owner"))
      .map((f) => ({
        id: String(f.id),
        name: f.name || null,
        ownerName: f.owner?.displayName || null,
        ownerActive: f.owner ? f.owner.active !== false : false,
        subscriptionCount: Number(f.subscriptionCount) || 0,
      }));
    return { available: true, items };
  }

  if (findingKey === "dashboard-ownership") {
    const meta = await readDashboardSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
    const dashboards = await loadDashboards(installationKey, meta.version);
    const summary = summarizeDashboards(dashboards);
    const items = summary.dashboards
      .filter((d) => d.findings.some((finding) => finding.code === "orphaned-owner"))
      .map((d) => ({
        id: String(d.id),
        name: d.name || null,
        ownerName: d.owner?.displayName || null,
        popularity: Number(d.popularity) || 0,
      }));
    return { available: true, items };
  }

  // Licensed accounts still sitting in a Jira access group after Jira deactivated them --
  // each one a paid seat and a login that returns with its old access intact if reactivated.
  // Same roster the People tab reads; a user is a candidate when it is both deactivated AND
  // still carries at least one licence-granting group (a deactivated account in no group is
  // not costing a seat, so it is not a remediation target).
  if (findingKey === "user-licence-hygiene") {
    const meta = await readUserSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
    const users = await loadUsers(installationKey, meta.version);
    const items = users
      .filter((u) => u.active === false && (u.groups || []).length > 0)
      .map((u) => ({
        id: u.accountId,
        accountId: u.accountId,
        displayName: u.displayName || null,
        groups: (u.groups || []).map((g) => g.name || g.id),
      }));
    return { available: true, items };
  }

  // Filters, dashboards and automation rules owned by an account that has fallen off the
  // licensed roster -- the account is gone or unlicensed, but Jira has not yet garbage-
  // collected what it owns. buildOwnershipIndex already carries the per-artifact id/name;
  // this just flattens the accounts not on the roster into one ticketable list.
  if (findingKey === "user-ownership") {
    const meta = await readUserSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
    const users = await loadUsers(installationKey, meta.version);
    const rosterIds = activeRosterIds(users);
    const ownership = await buildOwnershipIndex(installationKey);
    const items = [];
    for (const [accountId, owned] of ownership.byAccount) {
      if (rosterIds.has(accountId)) continue;
      for (const f of owned.filters) items.push({ id: `filter:${f.id}`, kind: "filter", name: f.name || null });
      for (const d of owned.dashboards)
        items.push({ id: `dashboard:${d.id}`, kind: "dashboard", name: d.name || null });
      for (const r of owned.rules) items.push({ id: `rule:${r.id}`, kind: "automation rule", name: r.name || null });
    }
    return { available: true, items };
  }

  // Statuses no workflow scheme reaches, no automation rule transitions into, AND no board
  // column maps -- the same basis the "status-reachability" health dimension scores, so the
  // epic's item count matches the number the finding itself reports. Requires the
  // scheme->status mapping; without it every status looks orphaned, which is why
  // status-reachability is unavailable rather than wrong in that case.
  if (findingKey === "status-reachability") {
    const meta = await readWorkflowSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
    const [statuses, schemeStatuses] = await Promise.all([
      loadStatusesCatalog(installationKey, meta.version),
      loadWorkflowSchemeStatuses(installationKey, meta.version),
    ]);
    if (schemeStatuses.length === 0) return { available: false, reason: "no-scheme-mapping", items: [] };
    const issueCounts = await loadStatusIssueCounts(installationKey).catch(() => new Map());
    const hasIssueCounts = issueCounts.size > 0;
    const provisional = findOrphanedStatuses(statuses, schemeStatuses, hasIssueCounts ? issueCounts : null);
    // A status only a rule reaches, only a board column maps, or only a saved filter's JQL
    // names is not safe to retire -- ask the same three sources rovoWorkflowImpact's
    // assessStatusDeletion checks before deciding, rather than treating "not yet checked" as
    // "nothing uses it". The filter check was missing here until now: a status a filter's
    // JQL still names could be auto-ticketed for retirement by this very playbook while the
    // status detail drawer, reading the same data through rovoWorkflowImpact, already said
    // "in use" -- two answers to the same question is exactly what a shared check prevents.
    const provisionalNames = provisional.map((o) => o.name).filter(Boolean);
    const [automationByStatus, boardStatusIds, filterMeta] = await Promise.all([
      provisionalNames.length
        ? loadStatusAutomationReferences(installationKey, provisionalNames).catch(() => null)
        : Promise.resolve(null),
      computeBoardStatusIds(installationKey).catch(() => null),
      readFilterSnapshotMeta(installationKey).catch(() => null),
    ]);
    const filterCountByStatus =
      filterMeta?.version && provisionalNames.length
        ? await loadFilterReferenceCounts(installationKey, filterMeta.version, "status", provisionalNames).catch(
            () => null,
          )
        : null;
    const orphans = findOrphanedStatuses(
      statuses,
      schemeStatuses,
      hasIssueCounts ? issueCounts : null,
      automationByStatus,
      boardStatusIds,
    );
    const items = orphans
      .filter((o) => !o.ruleOnly && !o.boardOnly)
      .filter((o) => !(filterCountByStatus && (filterCountByStatus[String(o.name || "").toLowerCase()] ?? 0) > 0))
      .map((o) => ({
        id: o.statusId,
        name: o.name,
        category: o.statusCategory,
        everCount: o.issueCount,
      }));
    return { available: true, items };
  }

  // Boards with no live backing filter -- none set, the filter was deleted, or the filter's
  // owner is deactivated. Column-mapping issues are a separate health dimension
  // ("board-columns") with no playbook, so they are deliberately excluded here even though
  // summarizeBoardInsights flags both kinds on the same board.
  if (findingKey === "board-backing") {
    const meta = await readBoardSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
    const [boards, columns, filterMeta] = await Promise.all([
      loadBoards(installationKey, meta.version),
      loadBoardColumns(installationKey, meta.version),
      readFilterSnapshotMeta(installationKey).catch(() => null),
    ]);
    const filters = filterMeta?.version
      ? await loadFilters(installationKey, filterMeta.version).catch(() => null)
      : null;
    const columnsByBoard = new Map();
    for (const col of columns) {
      if (!columnsByBoard.has(col.boardId)) columnsByBoard.set(col.boardId, []);
      columnsByBoard.get(col.boardId).push(col);
    }
    const rows = boards.map((board) => ({ ...board, columns: columnsByBoard.get(board.boardId) || [] }));
    const insights = summarizeBoardInsights({ boards: rows, filters });
    const BACKING_ISSUES = new Set(["no-backing-filter", "backing-filter-deleted", "backing-filter-owner-inactive"]);
    const items = insights.flagged
      .filter((b) => b.issues.some((code) => BACKING_ISSUES.has(code)))
      .map((b) => ({ id: b.boardId, name: b.name || null, type: b.type || null, issues: b.issues }));
    return { available: true, items };
  }

  // Custom fields with zero contexts, zero configuration and zero recorded issue usage --
  // the "orphaned" governance rule from analysis.js, read straight off the stored findings
  // JSON rather than re-run here, so the candidate list can never disagree with the badge
  // the Field Browser shows for the same field.
  const NO_ISSUE_CODES = new Set(["orphaned", "configured-no-issues"]);
  if (findingKey === "field-cleanup") {
    // Hydrated against the current thresholds, exactly as getAdminOverview counts the
    // finding -- the stored findings reflect whatever thresholds applied at scan time.
    const fields = await hydratedFields(installationKey);
    if (!fields) return { available: false, reason: "no-snapshot", items: [] };
    const items = fields
      // Stored findings are buildGovernanceFindings' object ({ reasons, tags, ... }), not a
      // list. This read `.some()` straight off that object and threw on every real site; the
      // unit test mocked an array, which is the only reason it ever passed.
      // Both codes the Overview's "no populated issues" finding counts, so the epic's task
      // count matches the number on the Overview.
      .filter((f) => (f.findings?.reasons || []).some((finding) => NO_ISSUE_CODES.has(finding.code)))
      .map((f) => ({
        id: f.id,
        name: f.name || null,
        type: f.type || null,
        description: f.description || null,
        reason: (f.findings.reasons.find((r) => NO_ISSUE_CODES.has(r.code)) || {}).code,
      }));
    return { available: true, items };
  }

  // Filters sharing identical JQL -- summarizeFilters already groups these for the tab
  // (duplicateGroups); this is that same computation, not a second one.
  if (findingKey === "filter-duplicates") {
    const meta = await readFilterSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
    const filters = await loadFilters(installationKey, meta.version);
    const summary = summarizeFilters(filters);
    const items = summary.duplicateGroups.map((g) => ({
      id: g.key,
      jql: g.jql,
      count: g.count,
      filters: g.filters,
    }));
    return { available: true, items };
  }

  // A filter's JQL naming a project or issue type the site does not define -- the two
  // "references something that doesn't exist" findings summarizeFilters already computes,
  // folded into one playbook since the fix (correct the JQL) is the same shape for both.
  // Needs the project catalog and the issue type catalog to join against; each degrades to
  // "not checked" independently, matching summarizeFilters' own projectsChecked/typesChecked
  // tri-state.
  if (findingKey === "filter-scope") {
    const meta = await readFilterSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return { available: false, reason: "no-snapshot", items: [] };
    const filters = await loadFilters(installationKey, meta.version);

    const fieldMeta = await readSnapshotMeta(installationKey).catch(() => null);
    let projectKeys = null;
    if (fieldMeta?.version) {
      const projects = await listSnapshotProjects(installationKey, fieldMeta.version).catch(() => []);
      if (projects.length)
        projectKeys = new Set(projects.flatMap((p) => [p.projectKey, p.projectName]).filter(Boolean));
    }

    const itMeta = await readIssueTypeSnapshotMeta(installationKey).catch(() => null);
    let typeNames = null;
    if (itMeta?.version) {
      const types = await loadIssueTypes(installationKey, itMeta.version).catch(() => []);
      if (types.length) typeNames = new Set(types.map((t) => String(t.name || "").toLowerCase()).filter(Boolean));
    }

    if (!projectKeys && !typeNames) return { available: false, reason: "no-catalog", items: [] };

    const summary = summarizeFilters(filters, { projectKeys, typeNames });
    const items = [
      ...summary.brokenProjects.map((f) => ({
        id: `${f.id}:project`,
        name: f.name,
        ownerName: f.ownerName,
        missing: f.missing,
        refKind: "project",
      })),
      ...summary.unknownTypeRefs.map((f) => ({
        id: `${f.id}:type`,
        name: f.name,
        ownerName: f.ownerName,
        missing: f.missing,
        refKind: "type",
      })),
    ];
    return { available: true, items };
  }

  // A field configured for a project (it is in the field's context) but on no screen that
  // project's issue types route to -- getScreenFieldCrossSignal is the widest join in the
  // app and already computes this for the tab; called directly rather than re-derived here.
  if (findingKey === "screen-unreachable-fields") {
    const cross = await getScreenFieldCrossSignal({ payload: {}, context }).catch(() => null);
    if (!cross?.available) return { available: false, reason: cross ? "no-snapshot" : "error", items: [] };
    const items = (cross.unreachableFields || []).map((f) => ({
      id: f.fieldId,
      fieldId: f.fieldId,
      fieldName: f.fieldName,
    }));
    return { available: true, items };
  }

  // Issue types on no scheme at all. getIssueTypeInventory computes two different
  // "governance" things: `.governance` is aggregate counts from SQL (loadIssueTypeGovernance
  // Summary, for the health score), and `.governanceFindings` is the live per-item
  // computation (summarizeIssueTypeInsights, for the tab) that actually carries the list --
  // this reads the second one, the same one the Issue Types tab does.
  if (findingKey === "issue-type-reach") {
    const inv = await getIssueTypeInventory({ context });
    if (inv.neverBuilt || !inv.version) return { available: false, reason: "no-snapshot", items: [] };
    const items = (inv.governanceFindings?.orphanTypes || []).map((t) => ({
      id: t.id,
      name: t.name,
      subtask: t.subtask,
    }));
    return { available: true, items };
  }

  // Issue types sharing an identical, spacing-only, or single-character-different name --
  // same governanceFindings computation as above, a different list on it.
  if (findingKey === "issue-type-naming") {
    const inv = await getIssueTypeInventory({ context });
    if (inv.neverBuilt || !inv.version) return { available: false, reason: "no-snapshot", items: [] };
    const items = (inv.governanceFindings?.duplicateGroups || []).map((g) => ({
      id: g.key,
      key: g.key,
      kind: g.kind,
      count: g.count,
      types: g.types,
    }));
    return { available: true, items };
  }

  // JSM Assets schemas with no object types or no objects -- getAssetInventory's own
  // governance summary already computes this for the tab.
  if (findingKey === "asset-schema-hygiene") {
    const inv = await getAssetInventory({ context });
    if (!inv.governance?.available)
      return {
        available: false,
        reason: inv.assetsEnabled === false ? "assets-not-enabled" : "no-snapshot",
        items: [],
      };
    const items = (inv.governance.deadSchemas || []).map((s) => ({
      id: s.id,
      name: s.name,
      reason: s.reason,
      objectTypeCount: s.objectTypeCount,
      objectCount: s.objectCount,
    }));
    return { available: true, items };
  }

  // Non-abstract JSM Assets object types carrying zero objects in the last measured crawl --
  // same governance summary, gated on the object-count crawl having ever run (countsMeasured)
  // since an unmeasured type must never render as an empty one.
  if (findingKey === "asset-type-usage") {
    const inv = await getAssetInventory({ context });
    if (!inv.governance?.available)
      return {
        available: false,
        reason: inv.assetsEnabled === false ? "assets-not-enabled" : "no-snapshot",
        items: [],
      };
    if (!inv.governance.countsMeasured) return { available: false, reason: "no-object-count-crawl", items: [] };
    const items = (inv.governance.emptyObjectTypes || []).map((t) => ({
      id: t.id,
      name: t.name,
      schemaId: t.schemaId,
    }));
    return { available: true, items };
  }

  const loader = REMEDIATION_CANDIDATE_LOADERS[findingKey];
  if (loader) return loader({ installationKey, context });

  return { available: false, reason: "not-connected", items: [] };
}

// Candidate loaders for the playbooks built on definePlaybook. A map rather than more branches
// above: each entry reads the same inventory its pillar's tab reads, so a finding's count and its
// epic's task count come from one computation. Items carry the fields the playbook's task
// template and links use.
//
// Most loaders are a source (below: the reads, and each pillar's "not built yet" reasons) plus a
// pure selector from src/lib/remediation-candidates.js (which items that finding tickets). The
// few that pass their filter into the query itself, or need a resolver-only join, stay whole
// further down.

const noSnapshot = { available: false, reason: "no-snapshot", items: [] };
const ready = (data) => ({ data });
const unavailable = (result) => ({ unavailable: result });

export async function accessGovernance(context) {
  const inv = await getAccessInventory({ context }, { listLimit: Infinity });
  return inv.neverBuilt ? null : inv;
}

export const ACCESS_UNAVAILABLE = { available: false, reason: "no-snapshot", items: [] };

// Every field, hydrated for governance against the CURRENT thresholds -- the computation
// getAdminOverview's field counts come from, so each field epic matches its Overview number.
export async function hydratedFields(installationKey) {
  const meta = await readSnapshotMeta(installationKey).catch(() => null);
  if (!meta?.version) return null;
  const [fields, config] = await Promise.all([loadSnapshotFields(installationKey, meta.version), readAdminConfig()]);
  return hydrateFieldsForGovernance(fields, config.governanceThresholds);
}

// The issue type findings, uncapped. getIssueTypeInventory does not return the flat scheme
// membership, so it is read alongside -- the same pairing the issue types pillar report uses.
export async function issueTypeInsightsFull(installationKey, context) {
  const inv = await getIssueTypeInventory({ context });
  if (inv.neverBuilt || !inv.version) return null;
  const schemeItems = await loadIssueTypeSchemeItems(installationKey, inv.version);
  return summarizeIssueTypeInsights({ types: inv.issueTypes, schemes: inv.schemes, schemeItems, listLimit: Infinity });
}

export async function assetInsightsFull(context) {
  const inv = await getAssetInventory({ context });
  if (inv.assetsEnabled === false)
    return { available: false, result: { available: false, reason: "assets-not-enabled", items: [] } };
  if (!inv.governance?.available)
    return { available: false, result: { available: false, reason: "no-snapshot", items: [] } };
  const insights = summarizeAssetInsights({
    schemas: inv.schemas,
    objectTypes: inv.objectTypes,
    attributes: inv.attributes,
    typeCounts: inv.typeCounts || [],
    assetsEnabled: true,
    listLimit: Infinity,
  });
  return { available: true, inv, insights };
}

// Each source answers { data } for its selector, or { unavailable } with the result to return
// as-is. The reasons are the ones each loader always gave.
export const CANDIDATE_SOURCES = {
  access: async ({ context }) => {
    const inv = await accessGovernance(context);
    return inv ? ready(inv) : unavailable(ACCESS_UNAVAILABLE);
  },
  estate: async ({ context }) => {
    const inv = await getEstateInventory({ context });
    return inv.neverBuilt ? unavailable(noSnapshot) : ready(inv);
  },
  users: async ({ context }) => {
    const inv = await getUserInventory({ context });
    return inv.neverBuilt ? unavailable({ available: false, reason: "no-roster", items: [] }) : ready(inv);
  },
  issueTypes: async ({ installationKey, context }) => {
    const insights = await issueTypeInsightsFull(installationKey, context);
    return insights ? ready(insights) : unavailable(noSnapshot);
  },
  assets: async ({ context }) => {
    const a = await assetInsightsFull(context);
    return a.available ? ready({ inv: a.inv, insights: a.insights }) : unavailable(a.result);
  },
  fields: async ({ installationKey }) => {
    const fields = await hydratedFields(installationKey);
    return fields ? ready(fields) : unavailable(noSnapshot);
  },
  fieldConfigs: async ({ context }) => {
    const inv = await getFieldConfigInventory({ context });
    return inv.neverBuilt ? unavailable(noSnapshot) : ready(inv);
  },
  workflow: async ({ installationKey }) => {
    const meta = await readWorkflowSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return unavailable(noSnapshot);
    const w = await computeWorkflowInsightsFull(installationKey, meta.version);
    if (!w.schemeStatusesAvailable) return unavailable({ available: false, reason: "no-scheme-mapping", items: [] });
    return ready(w);
  },
  workflowRules: async ({ context }) => {
    const insights = await getWorkflowRuleInsights({ context });
    return insights.available ? ready(insights) : unavailable({ available: false, reason: insights.reason, items: [] });
  },
  projects: async ({ installationKey }) => {
    const meta = await readSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return unavailable(noSnapshot);
    const projects = await attachUniqueIssueCounts(
      installationKey,
      await listSnapshotProjects(installationKey, meta.version),
    );
    const activity = await loadProjectActivity(installationKey).catch(
      fallbackOn("remediation.project_activity_load_failed", () => new Map(), { installationKey }),
    );
    return ready({
      insights: buildProjectInsights(projects, { listLimit: Infinity }),
      adoption: summarizeAdoption(projects, activity),
    });
  },
  filters: async ({ installationKey }) => {
    const meta = await readFilterSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return unavailable(noSnapshot);
    const { withFindings } = await loadFiltersWithFindings(installationKey, meta.version);
    return ready(withFindings);
  },
  dashboards: async ({ installationKey }) => {
    const meta = await readDashboardSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return unavailable(noSnapshot);
    return ready(await loadDashboards(installationKey, meta.version));
  },
  jsm: async ({ installationKey }) => {
    const view = await loadJsmView(installationKey);
    if (view.neverBuilt) return unavailable(noSnapshot);
    if (!view.jsmEnabled) return unavailable({ available: false, reason: "no-jsm", items: [] });
    return ready(view);
  },
  automationAnalysis: async ({ installationKey }) => {
    const analysis = await readAutomationAnalysis(installationKey).catch(() => null);
    return analysis ? ready(analysis) : unavailable({ available: false, reason: "no-analysis", items: [] });
  },
  automationDirectory: async ({ installationKey }) => {
    const directory = await readAutomationPart(installationKey, "directory").catch(() => null);
    return directory ? ready(directory) : unavailable({ available: false, reason: "no-automation-index", items: [] });
  },
  automationCascades: async ({ installationKey }) => {
    const [analysis, directory] = await Promise.all([
      readAutomationAnalysis(installationKey).catch(() => null),
      readAutomationPart(installationKey, "directory").catch(() => null),
    ]);
    return analysis
      ? ready({ analysis, directory })
      : unavailable({ available: false, reason: "no-analysis", items: [] });
  },
};

// A selector's loader: read its source, then select -- or pass the source's refusal through.
export function loaderFor({ source, select }) {
  const read = CANDIDATE_SOURCES[source];
  if (!read) throw new Error(`Unknown remediation candidate source "${source}"`);
  return async (args) => {
    const loaded = await read(args);
    return loaded.unavailable ?? select(loaded.data);
  };
}

export async function screenItems(installationKey, filter, { needsWorkflow = false } = {}) {
  const meta = await readScreenSnapshotMeta(installationKey).catch(() => null);
  if (!meta?.version) return noSnapshot;
  const workflowMeta = await readWorkflowSnapshotMeta(installationKey).catch(() => null);
  // A screen a transition opens is in use, so "unreached" needs a snapshot that read them.
  const workflowVersion = transitionAwareWorkflowVersion(workflowMeta);
  if (needsWorkflow && !workflowVersion) {
    return {
      available: false,
      reason: workflowMeta?.version ? "transitions-unknown" : "no-workflow-snapshot",
      items: [],
    };
  }
  const rows = await loadAllScreenPages(installationKey, meta.version, { workflowVersion, filter });
  return {
    available: true,
    items: rows.map((r) => ({ id: String(r.screenId), name: r.name, tabCount: r.tabCount, fieldCount: r.fieldCount })),
  };
}

export const REMEDIATION_CANDIDATE_LOADERS = {
  ...Object.fromEntries(Object.entries(CANDIDATE_SELECTORS).map(([key, selector]) => [key, loaderFor(selector)])),

  // ── Loaders that stay whole ──
  // The screen filters run inside the paged query itself, so there is no separate inventory to
  // select from.
  "screen-empty": ({ installationKey }) => screenItems(installationKey, "empty"),
  "screen-unresolved": ({ installationKey }) => screenItems(installationKey, "unresolved"),
  "screen-unreached": ({ installationKey }) => screenItems(installationKey, "unreached", { needsWorkflow: true }),
  "screen-transition-only": ({ installationKey }) =>
    screenItems(installationKey, "transition-only", { needsWorkflow: true }),
  // One task per screen scheme, listing each operation that points at a missing screen.
  "screen-dangling": async ({ installationKey }) => {
    const meta = await readScreenSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return noSnapshot;
    const [ops, schemes] = await Promise.all([
      loadScreenSchemeOperations(installationKey, meta.version),
      loadScreenSchemes(installationKey, meta.version),
    ]);
    const names = new Map(schemes.map((sc) => [String(sc.schemeId), sc.name]));
    const bySchemeId = new Map();
    for (const op of ops.filter((o) => o.dangling)) {
      const id = String(op.schemeId);
      if (!bySchemeId.has(id)) bySchemeId.set(id, { id, name: names.get(id) || null, operations: [] });
      bySchemeId.get(id).operations.push({ operation: op.operation, screenId: op.screenId || null });
    }
    return { available: true, items: [...bySchemeId.values()] };
  },
  "screen-unused-schemes": async ({ installationKey }) => {
    const meta = await readScreenSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return noSnapshot;
    const schemes = await loadScreenSchemes(installationKey, meta.version);
    return {
      available: true,
      items: schemes
        .filter((sc) => (sc.issueTypeSchemeCount ?? 0) === 0)
        .map((sc) => ({ id: String(sc.schemeId), name: sc.name })),
    };
  },
  // One item per off-roster account an automation rule names, with the rules that name it --
  // the same join getUserInventory counts and getUserDetails lists. Stays here because that
  // join (collectRuleUserReferences) lives in the people resolver module.
  "people-offroster-automation-refs": async ({ installationKey }) => {
    const meta = await readUserSnapshotMeta(installationKey).catch(() => null);
    if (!meta?.version) return noSnapshot;
    const [users, userIndex, directory] = await Promise.all([
      loadUsers(installationKey, meta.version),
      readAutomationPart(installationKey, "users").catch(() => null),
      readAutomationPart(installationKey, "directory").catch(() => null),
    ]);
    if (!userIndex) return { available: false, reason: "no-automation-index", items: [] };
    const roster = activeRosterIds(users);
    const items = (userIndex.entries || [])
      .map((e) => String(e.label))
      .filter((accountId) => !roster.has(accountId))
      .map((accountId) => {
        const rules = collectRuleUserReferences(accountId, userIndex, directory);
        return { id: accountId, accountId, ruleCount: rules.length, rules };
      })
      .filter((it) => it.ruleCount > 0);
    return { available: true, items };
  },
};
