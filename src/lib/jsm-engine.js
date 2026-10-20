// Builds the Jira Service Management snapshot behind four pillars: request types (and the
// fields each shows on the portal), queues, SLA outcomes, and customers & organizations.
//
// Read-only, and only through the granular read:*:jira-service-management scopes the manifest
// already declares -- no new consent. Three things the API cannot give are said plainly
// rather than worked around:
//
//   - SLA configuration (goals, calendars) has no REST endpoint. What Jira does answer is the
//     JQL SLA functions, so the SLA pillar is outcomes over the last 90 days: how many requests
//     ran against each SLA, and how many ever breached it.
//   - Customer and organization reads return names and email addresses. They are counted
//     here and never kept.
//   - Knowledge base, approvals and CSAT need scopes this app does not hold.
//
// A site with no service desk is not a failure. The build records a terminal "unavailable"
// state and every JSM pillar reports not-applicable, the same way Assets does off Premium.
//
// Everything runs inside one consumer invocation under a time budget. Work the budget does not
// reach is recorded as unread (null counts), never as zero: zero is what makes a request
// type look safe to retire.

import { logger } from "./logger.js";
import { inventorySnapshotQueue } from "./queues.js";
import {
  incrMetric,
  METRIC_NAMES,
  getFieldCatalog,
  getServiceDesks,
  getServiceDeskRequestTypes,
  getServiceDeskRequestTypeGroups,
  getRequestTypeFields,
  getServiceDeskQueues,
  countServiceDeskCustomers,
  getServiceDeskOrganizations,
  getOrganizations,
  countOrganizationMembers,
  countIssues,
  mapWithConcurrency,
} from "./jira-api.js";
import { ensureProjectStoreReady, writeJsmSnapshotMeta, replaceJsmSnapshot } from "./project-store.js";
import { serviceFields, cfRef, jqlString } from "./jsm-probe.js";
import { summarizeJsm, brokenFieldRefs, JSM_WINDOW_DAYS } from "./jsm-insights.js";

export const JSM_BUILD_STALE_MS = 16 * 60 * 1000;
// The consumer ceiling is 900s; this leaves room for the writes after the walk.
export const JSM_WALK_BUDGET_MS = 9 * 60 * 1000;
// Counted lists stop here and report a lower bound. A desk with 40,000 customers is "2,000+",
// not 800 calls.
export const CUSTOMER_COUNT_CAP = 2000;
export const ORG_MEMBER_COUNT_CAP = 500;
const DESK_CONCURRENCY = 3;
const COUNT_CONCURRENCY = 4;

export function isJsmBuildStale(meta, now = Date.now()) {
  if (meta?.state !== "building") return false;
  const startedAt = Date.parse(meta?.startedAt || "");
  if (!Number.isFinite(startedAt)) return true;
  return now - startedAt > JSM_BUILD_STALE_MS;
}

export async function queueJsmSnapshotBuild(installationKey) {
  await ensureProjectStoreReady();
  await writeJsmSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });
  await inventorySnapshotQueue.push({ body: { jobType: "build-jsm-snapshot", installationKey } });
}

const str = (v) => (v === null || v === undefined || v === "" ? null : String(v));

export function normalizeDesk(raw) {
  return {
    deskId: String(raw.id),
    projectId: str(raw.projectId),
    projectKey: str(raw.projectKey),
    projectName: str(raw.projectName),
  };
}

export function normalizeRequestType(deskId, raw) {
  return {
    deskId: String(deskId),
    id: String(raw.id),
    name: str(raw.name) || String(raw.id),
    hasDescription: Boolean(str(raw.description) || str(raw.helpText)),
    issueTypeId: str(raw.issueTypeId),
    groupIds: (raw.groupIds || []).map(String),
  };
}

export function normalizeQueue(deskId, raw, knownFieldIds) {
  const jql = typeof raw?.jql === "string" ? raw.jql : "";
  return {
    deskId: String(deskId),
    id: String(raw.id),
    name: str(raw.name) || String(raw.id),
    jql,
    issueCount: typeof raw?.issueCount === "number" ? raw.issueCount : null,
    brokenRefs: brokenFieldRefs(jql, knownFieldIds),
  };
}

// What a JSM read failure means for the whole build. Only the service desk list decides this;
// everything after it degrades to unread rather than failing the build.
export function desksUnavailableReason(error) {
  const status = error?.status;
  if (status === 404) return "Jira Service Management is not on this site.";
  if (status === 401)
    return "The service desk list returned 401: a Service Management scope is missing. Redeploy and upgrade the install.";
  if (status === 403) return "The service desk list returned 403: the app may not read service desks on this site.";
  return null;
}

async function finishUnavailable(installationKey, reason) {
  incrMetric(METRIC_NAMES.jsmSnapshotCompleted);
  const completedAt = new Date().toISOString();
  await writeJsmSnapshotMeta(installationKey, {
    state: "unavailable",
    completedAt,
    refreshedAt: completedAt,
    jsmEnabled: false,
    totalDesks: 0,
    totalRequestTypes: 0,
    totalQueues: 0,
    totalOrganizations: 0,
    unreadCount: 0,
    summary: summarizeJsm({ jsmEnabled: false }),
    lastError: reason,
  });
  logger.info("jsm-snapshot.unavailable", { reason });
  return { unavailable: true, reason };
}

export async function buildJsmSnapshot(installationKey, { now = Date.now } = {}) {
  incrMetric(METRIC_NAMES.jsmSnapshotStarted);
  await ensureProjectStoreReady();
  const started = now();
  await writeJsmSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date(started).toISOString(),
    lastError: null,
  });
  const overBudget = () => now() - started > JSM_WALK_BUDGET_MS;
  let unread = 0;

  try {
    let rawDesks;
    try {
      rawDesks = await getServiceDesks();
    } catch (error) {
      // 401 is a manifest gap the admin must fix, so it fails loudly. 404/403 mean there is no
      // JSM to govern here, which is a terminal answer.
      if (error?.status === 404 || error?.status === 403) {
        return await finishUnavailable(installationKey, desksUnavailableReason(error));
      }
      throw new Error(desksUnavailableReason(error) || String(error?.message || error));
    }
    if (!rawDesks.length) {
      return await finishUnavailable(
        installationKey,
        "Jira Service Management is on this site but has no service desks.",
      );
    }
    const desks = rawDesks.filter((d) => d?.id != null).map(normalizeDesk);

    // The field catalog: SLA fields and the request type field are found by type, and a queue
    // naming a custom field the catalog lacks is broken. Unread catalog -> both unmeasured.
    const catalog = await getFieldCatalog().catch(() => null);
    const knownFieldIds = catalog ? new Set(catalog.map((f) => String(f.id))) : null;
    const { slaFields, requestTypeField } = serviceFields(catalog || []);
    const rtRef = requestTypeField ? cfRef(requestTypeField.id) : null;
    const fieldNameById = new Map((catalog || []).map((f) => [String(f.id), f.name]));

    const siteOrgs = await getOrganizations().catch(() => null);

    const requestTypes = [];
    const requestTypeFields = [];
    const queues = [];
    const groupsReadByDesk = new Map();
    const orgIdsByDesk = new Map();

    // ---- Structure, desk by desk ------------------------------------------------------
    await mapWithConcurrency(desks, DESK_CONCURRENCY, async (desk) => {
      if (overBudget()) {
        unread += 1;
        groupsReadByDesk.set(desk.deskId, false);
        return;
      }
      const [types, groups, deskQueues, deskOrgs, customers] = await Promise.all([
        getServiceDeskRequestTypes(desk.deskId).catch(() => null),
        getServiceDeskRequestTypeGroups(desk.deskId).catch(() => null),
        getServiceDeskQueues(desk.deskId).catch(() => null),
        getServiceDeskOrganizations(desk.deskId).catch(() => null),
        countServiceDeskCustomers(desk.deskId, CUSTOMER_COUNT_CAP).catch(() => null),
      ]);
      if (types === null || deskQueues === null) unread += 1;
      groupsReadByDesk.set(desk.deskId, groups !== null);
      desk.portalGroupCount = groups ? groups.length : null;
      desk.customerCount = customers ? customers.count : null;
      desk.customersComplete = customers ? customers.complete : null;
      desk.orgCount = deskOrgs ? deskOrgs.length : null;
      orgIdsByDesk.set(desk.deskId, deskOrgs ? new Set(deskOrgs.map((o) => String(o.id))) : null);

      for (const raw of types || []) {
        if (raw?.id == null) continue;
        const rt = normalizeRequestType(desk.deskId, raw);
        const fields = overBudget() ? null : await getRequestTypeFields(desk.deskId, rt.id).catch(() => null);
        if (fields === null) unread += 1;
        rt.fieldCount = fields ? fields.length : null;
        rt.requiredFieldCount = fields ? fields.filter((f) => f?.required).length : null;
        for (const f of fields || []) {
          if (!f?.fieldId) continue;
          requestTypeFields.push({
            deskId: desk.deskId,
            requestTypeId: rt.id,
            fieldId: String(f.fieldId),
            label: str(f.name),
            required: Boolean(f.required),
          });
        }
        requestTypes.push(rt);
      }
      for (const raw of deskQueues || []) {
        if (raw?.id == null) continue;
        queues.push(normalizeQueue(desk.deskId, raw, knownFieldIds));
      }
    });

    // ---- Usage and outcomes, by JQL count ---------------------------------------------
    const deskById = new Map(desks.map((d) => [d.deskId, d]));
    const projectClause = (deskId) => {
      const key = deskById.get(deskId)?.projectKey;
      return key ? `project = ${jqlString(key)}` : null;
    };
    const count = async (jql) => (overBudget() || !jql ? null : countIssues(jql));

    await mapWithConcurrency(requestTypes, COUNT_CONCURRENCY, async (rt) => {
      const scope = projectClause(rt.deskId);
      if (!rtRef || !scope) {
        rt.issueCount = null;
        rt.recentCount = null;
        return;
      }
      const base = `${scope} AND ${rtRef} = ${jqlString(rt.name)}`;
      rt.recentCount = await count(`${base} AND created >= -${JSM_WINDOW_DAYS}d`);
      // The lifetime count only matters when the recent one is zero: "never used" and "used
      // before" are different retirements.
      rt.issueCount = rt.recentCount === 0 ? await count(base) : null;
    });

    const slaPairs = [];
    for (const desk of desks) {
      for (const f of slaFields) slaPairs.push({ deskId: desk.deskId, fieldId: f.id, fieldName: f.name });
    }
    const slas = await mapWithConcurrency(slaPairs, COUNT_CONCURRENCY, async (pair) => {
      const scope = projectClause(pair.deskId);
      const ref = cfRef(pair.fieldId);
      if (!scope || !ref) return { ...pair, activeCount: null, breachedCount: null };
      const window = `${scope} AND created >= -${JSM_WINDOW_DAYS}d`;
      const activeCount = await count(`${window} AND (${ref} = running() OR ${ref} = completed())`);
      const breachedCount = activeCount === 0 ? 0 : await count(`${window} AND ${ref} = everBreached()`);
      return {
        ...pair,
        fieldName: pair.fieldName || fieldNameById.get(pair.fieldId) || pair.fieldId,
        activeCount,
        breachedCount,
      };
    });

    // ---- Organizations ------------------------------------------------------------------
    const allDeskOrgsRead = [...orgIdsByDesk.values()].every((set) => set !== null);
    const organizations = await mapWithConcurrency(siteOrgs || [], COUNT_CONCURRENCY, async (raw) => {
      const id = String(raw.id);
      const members = overBudget() ? null : await countOrganizationMembers(id, ORG_MEMBER_COUNT_CAP).catch(() => null);
      const deskCount = allDeskOrgsRead ? [...orgIdsByDesk.values()].filter((set) => set && set.has(id)).length : null;
      return {
        id,
        name: str(raw.name) || id,
        memberCount: members ? members.count : null,
        membersComplete: members ? members.complete : null,
        deskCount,
      };
    });
    if (siteOrgs === null) unread += 1;

    const summary = summarizeJsm({
      desks,
      requestTypes,
      queues,
      slas,
      organizations,
      groupsReadByDesk,
      slaFieldsKnown: catalog !== null,
    });

    const version = String(started);
    await replaceJsmSnapshot(installationKey, version, {
      desks,
      requestTypes,
      requestTypeFields,
      queues,
      slas,
      organizations,
    });

    const completedAt = new Date().toISOString();
    await writeJsmSnapshotMeta(installationKey, {
      state: "ready",
      version,
      completedAt,
      refreshedAt: completedAt,
      jsmEnabled: true,
      totalDesks: desks.length,
      totalRequestTypes: requestTypes.length,
      totalQueues: queues.length,
      totalOrganizations: organizations.length,
      unreadCount: unread,
      summary,
      lastError: null,
    });

    incrMetric(METRIC_NAMES.jsmSnapshotCompleted);
    logger.info("jsm-snapshot.completed", {
      version,
      desks: desks.length,
      requestTypes: requestTypes.length,
      queues: queues.length,
      slaFields: slaFields.length,
      organizations: organizations.length,
      unread,
      ms: now() - started,
    });
    return { version, desks: desks.length, requestTypes: requestTypes.length, queues: queues.length, unread };
  } catch (error) {
    incrMetric(METRIC_NAMES.jsmSnapshotFailed);
    const message = String(error?.message || error);
    logger.error("jsm-snapshot.failed", { error: message });
    await writeJsmSnapshotMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: message,
    });
    throw error;
  }
}
