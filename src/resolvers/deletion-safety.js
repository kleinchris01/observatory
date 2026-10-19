// Deletion safety: every pillar's evidence about a field before anyone removes it, archived projects included.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import {
  incrMetric,
  METRIC_NAMES,
  getInstallationKey,
  mapWithConcurrency,
  getFieldProjectAssociations,
} from "../lib/jira-api.js";
import {
  ensureProjectStoreReady,
  readSnapshotMeta,
  loadSnapshotFields,
  readFilterSnapshotMeta,
  loadFilterReferencesFor,
  readDashboardSnapshotMeta,
  loadFieldSummary,
  loadRqtFieldIndex,
  readScreenSnapshotMeta,
  loadScreensForField,
  loadArchivedProjects,
  loadArchivedFieldUsage,
} from "../lib/project-store.js";
import { loadFieldWorkflowEvidence } from "../lib/workflow-rule-reads.js";
import { assessFieldDeletion, summarizeDeletionSafety } from "../lib/deletion-safety.js";
import { assessAutomationEvidence } from "../lib/automation-analysis.js";
import { fallbackOn } from "../lib/logger.js";
import { getDashboardUsage } from "./filters-dashboards.js";
import { getScreenFieldCrossSignal } from "./screens.js";
import { loadAutomationForAgent } from "./automation.js";

// "Build a field report from these screens." Returns the field union across the chosen
// screens and the projects those screens reach, so the Reports tab can pre-fill the field
// selection and scope the matrix to just the projects the report has something to say about.
// The cross-signal: screen reachability crossed with where field values actually exist.
//
// Costs no new Jira call. Both halves are already on disk -- the screen inventory the
// Screens tab reads, and the field x project usage the Field Browser reads -- and neither
// alone can answer the question this produces. See screen-insights.js for the four states
// and why two of them are invisible to every other pillar.
//
// Two snapshots with independent versions, so both are read and reported: a cross between a
// fresh screen build and a three-week-old field snapshot is a real answer about two
// different days, and the caller is told which days.
// The Deletion Safety report: every pillar's evidence about one field, in one answer.
//
// This is the product's thesis rendered as an artifact. Each pillar already held a piece of
// it and none could settle the question alone -- and the pieces were never joined, so the
// only way to answer "is this safe to delete" was to open five tabs and hold the result in
// your head.
//
// Bounded rather than resumable. The report-job contract exists and would let this run over
// the whole catalogue, but the answer is read one field at a time by somebody about to make
// a decision, and a synchronous call that refuses the 51st field is more honest than a job
// that quietly takes an hour. The remainder is reported, never silently dropped.
export const MAX_DELETION_SAFETY_FIELDS = 50;

// What archived projects say about each field, for assessFieldDeletion: the values counted in
// a project before it was archived (`held`), and archived projects the field is configured in
// whose values were never counted (`unknown`). Archived issues are invisible to Jira's search,
// so this is the only evidence there is. Reach is read live per field -- a global context
// reaches every archived project; otherwise the field's project associations decide.
export async function archivedEvidenceForFields(installationKey, fieldIds) {
  const list = await loadArchivedProjects(installationKey);
  const out = new Map();
  if (!list || !list.available) {
    const reason = !list
      ? "Archived projects have not been checked yet. They are read at the end of each full scan."
      : `The list of archived projects could not be read (${list.error || "refused"}), so values hidden in them cannot be ruled out.`;
    for (const id of fieldIds) out.set(id, { available: false, reason });
    return out;
  }
  if (!list.projects.length) {
    for (const id of fieldIds) out.set(id, { available: true, held: [], unknown: [] });
    return out;
  }
  const archivedIds = new Map(list.projects.map((p) => [p.id, p]));
  const usage = await loadArchivedFieldUsage(installationKey, fieldIds);
  await mapWithConcurrency(fieldIds, 4, async (fieldId) => {
    const held = (usage.get(fieldId) || []).filter((r) => archivedIds.has(r.projectId));
    const heldIds = new Set(held.map((r) => r.projectId));
    let reach = [];
    let reachUnknown = false;
    try {
      // A missing summary only means "global context unknown"; the associations still answer.
      let summary = null;
      try {
        summary = await loadFieldSummary(installationKey, fieldId);
      } catch {
        summary = null;
      }
      if (summary?.hasGlobalContext) {
        reach = list.projects;
      } else {
        const associated = await getFieldProjectAssociations(fieldId);
        reach = associated.map((a) => archivedIds.get(String(a.id))).filter(Boolean);
      }
    } catch {
      reachUnknown = true;
    }
    // An archived project Jira reports as holding no issues cannot hide any values.
    const unknown = reach
      .filter((p) => !heldIds.has(p.id) && p.issueCount !== 0)
      .map((p) => ({ projectKey: p.key, issueCount: p.issueCount }));
    out.set(fieldId, { available: true, held, unknown, reachUnknown });
  });
  return out;
}

export async function getDeletionSafety({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const requested = Array.isArray(payload?.fieldIds) ? payload.fieldIds.map(String).filter(Boolean) : [];
  if (!requested.length) return { available: false, reason: "No field was named.", fields: [], total: 0 };

  const fieldIds = requested.slice(0, MAX_DELETION_SAFETY_FIELDS);
  const skipped = requested.length - fieldIds.length;

  const [fieldMeta, screenMeta, filterMeta, dashMeta] = await Promise.all([
    readSnapshotMeta(installationKey),
    readScreenSnapshotMeta(installationKey).catch(() => null),
    readFilterSnapshotMeta(installationKey).catch(() => null),
    readDashboardSnapshotMeta(installationKey).catch(() => null),
  ]);

  // The one hard prerequisite. Without the field snapshot there is no catalogue to name the
  // fields, and a verdict about a field the app cannot describe is not worth printing.
  if (!fieldMeta?.version) {
    return {
      available: false,
      reason:
        "No field snapshot has been built yet, so there is nothing to assess. Run a full scan from the Scans tab.",
      fields: [],
      total: 0,
    };
  }

  const [catalog, automationParts, rqtRows, crossSummary] = await Promise.all([
    loadSnapshotFields(installationKey, fieldMeta.version).catch(() => null),
    loadAutomationForAgent(installationKey).catch(() => null),
    loadRqtFieldIndex(installationKey).catch(() => null),
    // Only to answer the invisible-data blocker. Read, not recomputed: the widest join in
    // the app has no business running behind a per-field question.
    getScreenFieldCrossSignal({ payload: {}, context }).catch(() => null),
  ]);

  // Null means the catalogue read FAILED; an empty array means it was read and is empty.
  // The difference matters more here than it looks: the automation, filter and dashboard
  // joins all key on the field's NAME, so without the catalogue they match nothing and
  // return clean -- three pillars silently not consulted, reported as three pillars
  // consulted and clear. That is the exact failure this whole report exists to prevent.
  const catalogAvailable = Array.isArray(catalog);
  const byId = new Map((catalog || []).map((f) => [String(f.id), f]));
  const rqtById = new Map((rqtRows || []).map((r) => [String(r.fieldId ?? r.field_id), r]));
  const invisibleById = new Map(
    (crossSummary?.available ? crossSummary.invisibleData : []).map((f) => [String(f.fieldId), f]),
  );

  const automationIndex = automationParts?.fields ?? null;
  const automationEvidence = automationParts?.analysis
    ? assessAutomationEvidence({
        index: automationIndex,
        refreshedAt: automationParts.analysis.refreshedAt ?? null,
        staleAfterDays: automationParts.staleAfterDays,
      })
    : null;

  const archivedById = await archivedEvidenceForFields(installationKey, fieldIds).catch(
    fallbackOn("deletion_safety.archived_failed", () => null, { installationKey }),
  );

  // Workflow rules naming these fields: one indexed read for the whole batch. Null when no
  // snapshot has captured rules, which the assessor reports as a gap rather than a pass.
  const workflowEvidence = await loadFieldWorkflowEvidence(installationKey, fieldIds).catch(
    fallbackOn("deletion_safety.workflow_rules_failed", () => null, { installationKey }),
  );

  const assessments = [];
  for (const fieldId of fieldIds) {
    const field = byId.get(fieldId) || { id: fieldId, name: null };
    // No name, no name-keyed join. Passing these as unavailable makes them gaps, which is
    // what they are, instead of empty results that read as evidence of absence.
    const nameKnown = Boolean(field.name);

    // Automation matches by NAME, which is how the index is keyed. An entry found is real
    // evidence; an entry missing is only evidence when the index is complete and current,
    // which is what automationEvidence decides.
    const entry = (automationIndex?.entries ?? []).find(
      (e) => String(e.label ?? "").toLowerCase() === String(field.name ?? "").toLowerCase(),
    );

    const [screens, filters, dashboards] = await Promise.all([
      screenMeta?.version
        ? loadScreensForField(installationKey, screenMeta.version, fieldId)
            .then((rows) => ({
              available: true,
              screens: rows,
              unresolvedScreens: Number(screenMeta.unresolvedScreens) || 0,
            }))
            .catch(() => null)
        : Promise.resolve(null),
      filterMeta?.version && nameKnown
        ? loadFilterReferencesFor(installationKey, filterMeta.version, "field", field.name)
            .then((rows) => ({ available: true, count: rows.length, names: rows.map((r) => r.name).filter(Boolean) }))
            .catch(() => null)
        : Promise.resolve(null),
      dashMeta?.version && nameKnown
        ? getDashboardUsage({ payload: { label: field.name }, context })
            .then((d) =>
              d?.available
                ? {
                    available: true,
                    count: Number(d.total) || 0,
                    names: (d.dashboards || []).map((x) => x.name).filter(Boolean),
                  }
                : null,
            )
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    assessments.push(
      assessFieldDeletion({
        field,
        usage:
          catalogAvailable && byId.has(fieldId)
            ? { totalIssueCount: field.totalIssueCount, activeProjectCount: field.activeProjectCount }
            : null,
        screens,
        automation:
          nameKnown && (entry || automationEvidence)
            ? {
                available: Boolean(automationParts?.analysis),
                writeCount: entry?.writeCount ?? 0,
                readCount: entry?.readCount ?? 0,
                triggerCount: entry?.triggerCount ?? 0,
                evidence: automationEvidence,
              }
            : null,
        filters,
        dashboards,
        rqt:
          rqtById.size > 0 || rqtRows
            ? { available: true, issueCount: Number(rqtById.get(fieldId)?.issueCount) || 0 }
            : null,
        invisibleData: invisibleById.get(fieldId) || null,
        workflowRules: workflowEvidence?.get(fieldId) ?? null,
        archived: archivedById
          ? archivedById.get(fieldId) || null
          : { available: false, reason: "Archived projects could not be checked for this field." },
      }),
    );
  }

  return {
    available: true,
    ...summarizeDeletionSafety(assessments),
    // Named rather than dropped. A report that silently answered 50 of 80 questions would be
    // worse than one that refused.
    skipped,
    maxFields: MAX_DELETION_SAFETY_FIELDS,
    // Per-pillar freshness: the halves refresh independently and the verdict is only as
    // current as the oldest one it drew on.
    freshness: {
      fields: fieldMeta.refreshedAt || null,
      screens: screenMeta?.refreshedAt || null,
      filters: filterMeta?.refreshedAt || null,
      dashboards: dashMeta?.refreshedAt || null,
      automation: automationParts?.analysis?.refreshedAt ?? null,
    },
  };
}
