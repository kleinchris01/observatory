// Read resolvers over the workflow-rule snapshot (workflow-rules.js, workflow-engine.js).
//
// Kept out of resolvers.js, which is past ten thousand lines. Registered there, in the admin
// registry, so the admin guard covers every one of these by construction.
//
// Every read is tri-state, like the rest of the app:
//   available: false, reason "no-snapshot"     -- no workflow snapshot at all
//   available: false, reason "rules-not-read"  -- a snapshot that predates rule capture, or
//                                                whose workflow read failed
//   available: true, with possibly-empty lists -- looked, and this is the answer
// "No workflow rule touches this field" is the premise for deleting it. "We have not
// looked" is not, and the two must never render the same.

import { incrMetric, METRIC_NAMES, getInstallationKey } from "./jira-api.js";
import {
  ensureProjectStoreReady,
  readWorkflowSnapshotMeta,
  loadStatusesCatalog,
  loadWorkflowRefsFor,
  loadWorkflowRefsByType,
  loadWorkflowRulesPage,
  loadRefsForRules,
  loadRestrictingProperties,
  loadStatusWorkflowProperties,
  loadWorkflowsCatalog,
} from "./project-store.js";
import { ruleLabel, parseWorkflowProperty, summarizeRuleInsights, RULE_KINDS } from "./workflow-rules.js";

export { summarizeRuleInsights };

export const WORKFLOW_REF_TYPES = ["field", "group", "group-name", "role", "permission", "status", "user"];

// The snapshot to read, or the reason there is none.
export async function ruleSnapshot(installationKey) {
  await ensureProjectStoreReady();
  const meta = await readWorkflowSnapshotMeta(installationKey);
  if (!meta?.version) {
    return { unavailable: { available: false, reason: "no-snapshot", refreshedAt: null } };
  }
  if (meta.workflowRules == null) {
    return {
      unavailable: {
        available: false,
        reason: "rules-not-read",
        refreshedAt: meta.refreshedAt || null,
      },
    };
  }
  return { meta };
}

async function statusNameMap(installationKey, version) {
  const statuses = await loadStatusesCatalog(installationKey, version).catch(() => []);
  return new Map(statuses.map((s) => [String(s.statusId ?? s.id), s.name]));
}

function statusRef(id, names) {
  if (id == null || id === "") return null;
  return { id: String(id), name: names.get(String(id)) || `Status ${id}` };
}

// "From -> To" in the words Jira's own editor uses. A global transition has no from-status
// (any status can take it); the initial one is the create step.
export function describeTransition({ transitionId, transitionName, transitionType, fromStatusIds, toStatusId }, names) {
  const type = String(transitionType || "").toUpperCase();
  let from;
  if (type === "INITIAL") from = [{ id: null, name: "Create" }];
  else if (!fromStatusIds?.length) from = [{ id: null, name: "Any status" }];
  else from = fromStatusIds.map((id) => statusRef(id, names));
  return {
    id: transitionId ?? null,
    name: transitionName || transitionId || null,
    type: type || null,
    from,
    to: statusRef(toStatusId, names),
  };
}

function describeUsage(row, names) {
  const onTransition = row.ownerKind === "transition";
  return {
    workflowName: row.workflowName,
    source: row.source,
    transition: onTransition
      ? describeTransition({
          transitionId: row.ownerId,
          transitionName: row.transitionName,
          transitionType: row.transitionType,
          fromStatusIds: row.fromStatusIds,
          toStatusId: row.toStatusId,
        }, names)
      : null,
    status: onTransition ? null : statusRef(row.ownerId, names),
    rule: row.source === "rule"
      ? { kind: row.ruleKind, key: row.ruleKey, label: ruleLabel(row.ruleKey), summary: row.summary }
      : null,
    property: row.source === "property"
      ? {
          key: row.propKey,
          value: row.propValue,
          meaning: parseWorkflowProperty(row.propKey, row.propValue)?.description ?? null,
        }
      : null,
  };
}

// Every workflow rule and property that points at one thing.
//
// payload: { refType: "field" | "group" | ..., refId, refName? }. For a group, refName also
// matches properties that name the group rather than its id -- older workflows do.
export async function getWorkflowRuleUsage({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  const refType = String(payload?.refType || "");
  const refId = String(payload?.refId || "").trim();
  if (!WORKFLOW_REF_TYPES.includes(refType)) throw new Error(`refType must be one of ${WORKFLOW_REF_TYPES.join(", ")}`);
  if (!refId) throw new Error("refId is required");

  const { meta, unavailable } = await ruleSnapshot(installationKey);
  if (unavailable) return { ...unavailable, refType, refId, usages: [] };

  const lookups = [loadWorkflowRefsFor(installationKey, meta.version, refType, [refId])];
  const refName = String(payload?.refName || "").trim();
  if (refType === "group" && refName) {
    lookups.push(loadWorkflowRefsFor(installationKey, meta.version, "group-name", [refName]));
  }
  const [names, ...results] = await Promise.all([statusNameMap(installationKey, meta.version), ...lookups]);
  const rows = results.flat();
  const usages = rows.map((row) => describeUsage(row, names));

  return {
    available: true,
    refreshedAt: meta.refreshedAt || null,
    refType,
    refId,
    total: usages.length,
    workflowCount: new Set(usages.map((u) => u.workflowName)).size,
    // Whether the lookup hit its row cap; a capped answer must say so.
    truncated: rows.length >= 2000,
    usages,
  };
}

// One page of transition rules for the Workflows tab, each with what it points at.
export async function getWorkflowRules({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  const kind = payload?.kind ? String(payload.kind) : null;
  if (kind && !RULE_KINDS.includes(kind)) throw new Error(`kind must be one of ${RULE_KINDS.join(", ")}`);

  const { meta, unavailable } = await ruleSnapshot(installationKey);
  if (unavailable) return { ...unavailable, rules: [], total: 0 };

  const page = await loadWorkflowRulesPage(installationKey, meta.version, {
    query: String(payload?.query || "").slice(0, 200),
    kind,
    brokenOnly: payload?.brokenOnly === true,
    offset: payload?.offset,
    limit: payload?.limit,
  });
  const [names, refs] = await Promise.all([
    statusNameMap(installationKey, meta.version),
    loadRefsForRules(installationKey, meta.version, page.rules),
  ]);
  const refsByRule = new Map();
  for (const ref of refs) {
    const key = `${ref.workflowName}\u0000${ref.ownerId}\u0000${ref.ruleSeq}`;
    if (!refsByRule.has(key)) refsByRule.set(key, []);
    refsByRule.get(key).push({ type: ref.refType, id: ref.refId, label: ref.refLabel, missing: ref.refMissing });
  }

  return {
    available: true,
    refreshedAt: meta.refreshedAt || null,
    total: page.total,
    rules: page.rules.map((rule) => ({
      workflowName: rule.workflowName,
      transition: describeTransition(rule, names),
      kind: rule.kind,
      key: rule.ruleKey,
      label: ruleLabel(rule.ruleKey),
      summary: rule.summary,
      refs: refsByRule.get(`${rule.workflowName}\u0000${rule.transitionId}\u0000${rule.ruleSeq}`) || [],
    })),
  };
}

// The holder a parsed property names, labelled from the reference rows the build resolved.
function holderOf(parsed, labels) {
  if (!parsed?.holder) return null;
  const type = parsed.holderType === "group"
    ? (/^[0-9a-f-]{36}$/i.test(parsed.holder) ? "group" : "group-name")
    : (parsed.holderType === "groupCF" || parsed.holderType === "userCF" || parsed.holderType === "field")
      ? "field"
      : (parsed.holderType === "projectrole" || parsed.holderType === "inProjectRole") ? "role" : parsed.holderType;
  const hit = labels.get(`${type}\u0000${parsed.holder}`);
  return { type, id: parsed.holder, label: hit?.label ?? (type === "group-name" ? parsed.holder : null), missing: hit?.missing ?? null };
}

// What each workflow restricts, and to whom: every jira.permission.* and jira.issue.editable
// property on a status or transition, parsed. payload.statusId narrows to one status (the
// status drawer); without it the whole site is returned (the Restrictions view).
export async function getWorkflowRestrictions({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  const statusId = payload?.statusId != null && payload.statusId !== "" ? String(payload.statusId) : null;

  const { meta, unavailable } = await ruleSnapshot(installationKey);
  if (unavailable) return { ...unavailable, restrictions: [] };

  const [names, props, refs] = await Promise.all([
    statusNameMap(installationKey, meta.version),
    statusId
      ? loadStatusWorkflowProperties(installationKey, meta.version, statusId)
          .then((rows) => rows.map((r) => ({ ...r, ownerKind: "status", ownerId: statusId })))
      : loadRestrictingProperties(installationKey, meta.version),
    loadWorkflowRefsByType(installationKey, meta.version, ["group", "group-name", "role", "field"]),
  ]);
  const labels = new Map(refs.map((r) => [`${r.refType}\u0000${r.refId}`, { label: r.refLabel, missing: r.refMissing }]));

  const restrictions = [];
  for (const prop of props) {
    const parsed = parseWorkflowProperty(prop.key, prop.value);
    if (!parsed) continue;
    restrictions.push({
      workflowName: prop.workflowName,
      ownerKind: prop.ownerKind,
      status: prop.ownerKind === "status" ? statusRef(prop.ownerId, names) : null,
      transitionId: prop.ownerKind === "transition" ? prop.ownerId : null,
      key: prop.key,
      value: prop.value,
      effect: parsed.effect,
      permission: parsed.permission,
      holderType: parsed.holderType,
      holder: holderOf(parsed, labels),
      description: parsed.description,
    });
  }

  const editLocks = restrictions.filter((r) => r.ownerKind === "status" && (r.effect === "not-editable" || r.permission === "edit"));
  return {
    available: true,
    refreshedAt: meta.refreshedAt || null,
    statusId,
    total: restrictions.length,
    summary: {
      // Distinct workflow+status pairs where editing is locked or narrowed: the number an
      // admin asks for first.
      editLockedStatuses: new Set(editLocks.map((r) => `${r.workflowName}\u0000${r.status?.id}`)).size,
      workflows: new Set(restrictions.map((r) => r.workflowName)).size,
      missingHolders: restrictions.filter((r) => r.holder?.missing === true).length,
    },
    restrictions,
  };
}

// The workflow inventory, with the two findings this data makes possible: references that
// point at nothing, and company-managed workflows no project uses.
export async function getWorkflowRuleInsights({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);

  const { meta, unavailable } = await ruleSnapshot(installationKey);
  if (unavailable) return { ...unavailable, workflows: [], brokenRefs: [], inactive: [] };

  const [names, catalog, refs] = await Promise.all([
    statusNameMap(installationKey, meta.version),
    loadWorkflowsCatalog(installationKey, meta.version),
    loadWorkflowRefsByType(installationKey, meta.version, ["field", "group", "role"]),
  ]);
  return summarizeRuleInsights({ meta, names, catalog, refs });
}

// Deletion-safety evidence for a batch of fields: Map<fieldId, { available, count,
// workflowCount, examples }>, or null when no snapshot has captured rules -- which the
// assessor reports as a gap, not as "no rule names this field".
export async function loadFieldWorkflowEvidence(installationKey, fieldIds = []) {
  const { meta, unavailable } = await ruleSnapshot(installationKey);
  if (unavailable) return null;
  const [names, rows] = await Promise.all([
    statusNameMap(installationKey, meta.version),
    loadWorkflowRefsFor(installationKey, meta.version, "field", fieldIds),
  ]);
  const out = new Map(fieldIds.map((id) => [String(id), { available: true, count: 0, workflowCount: 0, examples: [] }]));
  const workflowsByField = new Map();
  for (const row of rows) {
    const entry = out.get(String(row.refId));
    if (!entry) continue;
    entry.count += 1;
    if (!workflowsByField.has(row.refId)) workflowsByField.set(row.refId, new Set());
    workflowsByField.get(row.refId).add(row.workflowName);
    if (entry.examples.length < 3) entry.examples.push(exampleOf(describeUsage(row, names)));
  }
  for (const [fieldId, set] of workflowsByField) out.get(String(fieldId)).workflowCount = set.size;
  return out;
}

// "Approve (In Review -> Approved) in Build WF" / "In Review status in Build WF".
function exampleOf(usage) {
  if (usage.transition) {
    const from = usage.transition.from.map((s) => s?.name).filter(Boolean).join(", ");
    const to = usage.transition.to?.name || "?";
    return `${usage.rule?.label || usage.property?.key || "Rule"} on ${usage.transition.name} (${from} -> ${to}) in ${usage.workflowName}`;
  }
  return `${usage.property?.key || "Property"} on ${usage.status?.name || "a status"} in ${usage.workflowName}`;
}
