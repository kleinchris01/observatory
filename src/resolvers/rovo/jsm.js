// Rovo actions. Service Management expert (observatory-jsm-expert).
//
// Over loadJsmView, so the agent, the Service Management tab, the report and remediation read
// one computation. Three actions, the same set as every pillar that can answer "what
// references this":
//
//   search-jsm   desks, request types, queues, SLAs and organizations by name
//   inspect-jsm  one service desk by project key or name: its request types with volume and
//                findings, its queues, and the SLA outcomes measured on it
//   jsm-impact   a field: which request types show it on the portal (and require it), and
//                which queues' JQL name it
//
// Three states, never collapsed: no snapshot ("service management-unavailable"), a site with
// no service desk (jsmEnabled: false -- a real answer), and a built snapshot.

import { incrMetric, METRIC_NAMES, getInstallationKey } from "../../lib/jira-api.js";
import { pillarUnavailable, agentOk, agentNotFound, rankMatches, clampResults } from "../../lib/rovo-agents.js";
import { readJsmSnapshotMeta, loadJsmRequestTypeFields } from "../../lib/project-store.js";
import { customFieldIdsInJql } from "../../lib/jsm-insights.js";
import { extractJqlFields } from "../../lib/jql-refs.js";
import { loadJsmView } from "../jsm.js";
import { logger, errorContext } from "../../lib/logger.js";

const PILLAR = "service management";

const findingList = (row) => (row.findings || []).map((f) => ({ code: f.code, title: f.title, detail: f.detail }));

const notEnabled = (view) =>
  agentOk(view.refreshedAt, {
    jsmEnabled: false,
    message:
      view.reason ||
      "Jira Service Management has no service desks on this site, so there is nothing for this pillar to report.",
  });

// Loads the view, or returns the answer that stands in for it.
async function viewOr(context) {
  const view = await loadJsmView(getInstallationKey(context));
  if (view.neverBuilt) return { early: pillarUnavailable(PILLAR, { state: view.state, refreshedAt: null }) };
  if (!view.jsmEnabled) return { early: notEnabled(view) };
  return { view };
}

const deskOf = (view) => {
  const byId = new Map(view.desks.map((d) => [d.deskId, d]));
  return (deskId) => byId.get(deskId) || null;
};

export async function rovoJsmSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const query = String(payload?.query || "").trim();
    if (!query) return { status: "error", message: "A search query is required." };
    const kind = String(payload?.kind || "any")
      .trim()
      .toLowerCase();
    const limit = clampResults(payload?.maxResults, 10, 20);
    const { view, early } = await viewOr(context);
    if (early) return early;
    const want = (k) => kind === "any" || kind === k;

    return agentOk(view.refreshedAt, {
      query,
      windowDays: view.windowDays,
      desks: want("desk")
        ? rankMatches(view.desks, query, (d) => [d.projectKey, d.projectName], limit).map((d) => ({
            projectKey: d.projectKey,
            name: d.projectName,
            customers: d.customerCount,
            customersIsLowerBound: d.customersComplete === false,
            organizations: d.orgCount,
          }))
        : [],
      requestTypes: want("request-type")
        ? rankMatches(view.requestTypes, query, (r) => [r.name], limit).map((r) => ({
            desk: r.projectKey,
            id: r.id,
            name: r.name,
            requestsInWindow: r.recentCount,
            findings: findingList(r),
          }))
        : [],
      queues: want("queue")
        ? rankMatches(view.queues, query, (q) => [q.name, q.jql], limit).map((q) => ({
            desk: q.projectKey,
            id: q.id,
            name: q.name,
            jql: q.jql,
            issues: q.issueCount,
            findings: findingList(q),
          }))
        : [],
      slas: want("sla")
        ? rankMatches(view.slas, query, (s) => [s.name, s.fieldId], limit).map((s) => ({
            name: s.name,
            fieldId: s.fieldId,
            requestsMeasured: s.measuredDesks > 0 ? s.activeCount : null,
            breached: s.measuredDesks > 0 ? s.breachedCount : null,
            findings: findingList(s),
          }))
        : [],
      organizations: want("organization")
        ? rankMatches(view.organizations, query, (o) => [o.name], limit).map((o) => ({
            id: o.id,
            name: o.name,
            members: o.memberCount,
            desks: o.deskCount,
            findings: findingList(o),
          }))
        : [],
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    logger.error("rovoJsmSearch.failed", errorContext(error));
    throw error;
  }
}

export async function rovoJsmInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const identifier = String(payload?.identifier || "").trim();
    if (!identifier) return { status: "error", message: "A service desk project key or name is required." };
    const { view, early } = await viewOr(context);
    if (early) return early;

    const id = identifier.toLowerCase();
    const desk =
      view.desks.find((d) => String(d.projectKey || "").toLowerCase() === id) ||
      view.desks.find((d) => String(d.projectName || "").toLowerCase() === id) ||
      rankMatches(view.desks, identifier, (d) => [d.projectKey, d.projectName], 1)[0];
    if (!desk) return agentNotFound(view.refreshedAt, `No service desk matching "${identifier}" is in the snapshot.`);

    const own = (rows) => rows.filter((r) => r.deskId === desk.deskId);
    const slasHere = view.slas
      .map((s) => ({ s, row: s.desks.find((d) => d.deskId === desk.deskId) }))
      .filter(({ row }) => row);

    return agentOk(view.refreshedAt, {
      windowDays: view.windowDays,
      desk: {
        projectKey: desk.projectKey,
        name: desk.projectName,
        portalGroups: desk.portalGroupCount,
        customers: desk.customerCount,
        customersIsLowerBound: desk.customersComplete === false,
        organizations: desk.orgCount,
      },
      requestTypes: own(view.requestTypes).map((r) => ({
        id: r.id,
        name: r.name,
        onPortal: (r.groupIds || []).length > 0,
        fields: r.fieldCount,
        requiredFields: r.requiredFieldCount,
        requestsInWindow: r.recentCount,
        findings: findingList(r),
      })),
      queues: own(view.queues).map((q) => ({
        id: q.id,
        name: q.name,
        jql: q.jql,
        issues: q.issueCount,
        findings: findingList(q),
      })),
      slas: slasHere.map(({ s, row }) => ({
        name: s.name,
        fieldId: s.fieldId,
        requestsMeasured: row.activeCount,
        breached: row.breachedCount,
      })),
      notes: [
        "SLA goals and calendars are not readable through the Jira API; SLAs are reported by outcome only.",
        "Customers are counted, never listed.",
      ],
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    logger.error("rovoJsmInspect.failed", errorContext(error));
    throw error;
  }
}

export async function rovoJsmImpact(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const field = String(payload?.field || "").trim();
    if (!field) return { status: "error", message: "A field id or name is required." };
    const { view, early } = await viewOr(context);
    if (early) return early;

    const meta = await readJsmSnapshotMeta(getInstallationKey(context));
    const all = await loadJsmRequestTypeFields(getInstallationKey(context), meta.version);
    const wanted = field.toLowerCase();
    const matches = all.filter(
      (f) => f.fieldId.toLowerCase() === wanted || String(f.label || "").toLowerCase() === wanted,
    );
    const fieldIds = new Set(matches.map((f) => f.fieldId.toLowerCase()));
    if (/^customfield_\d+$/i.test(field)) fieldIds.add(wanted);

    const desk = deskOf(view);
    const typeName = new Map(view.requestTypes.map((r) => [`${r.deskId}:${r.id}`, r.name]));
    const queues = view.queues.filter((q) => {
      if (customFieldIdsInJql(q.jql).some((id) => fieldIds.has(id.toLowerCase()))) return true;
      return extractJqlFields(q.jql).some((name) => String(name).toLowerCase() === wanted);
    });

    return agentOk(view.refreshedAt, {
      field,
      requestTypes: matches.map((f) => ({
        desk: desk(f.deskId)?.projectKey ?? null,
        requestType: typeName.get(`${f.deskId}:${f.requestTypeId}`) ?? f.requestTypeId,
        label: f.label,
        required: f.required,
      })),
      queues: queues.map((q) => ({ desk: q.projectKey, name: q.name, jql: q.jql })),
      coverage:
        "Covers the request type portal forms and queue JQL in the Service Management snapshot. It does not cover " +
        "SLA conditions, automation rules, workflows or screens; ask those pillars' experts.",
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    logger.error("rovoJsmImpact.failed", errorContext(error));
    throw error;
  }
}
