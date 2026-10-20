// Governance over Jira Service Management: four pillars on one snapshot.
//
//   requestTypes  what a customer can ask for -- hidden from the portal, never used, no
//                 description, two request types with one name on the same desk
//   queues        what agents work from -- a queue whose JQL names a custom field that no
//                 longer exists, empty queues, two queues with the same query
//   slas          outcomes, not configuration: Jira publishes no endpoint for SLA goals or
//                 calendars, so this reads what the JQL SLA functions say happened in the
//                 last 90 days -- the breach rate, and SLAs nothing has run against
//   customers     organizations nobody belongs to, and organizations no desk uses
//
// Pure functions over already-loaded rows, like estate-insights.js. Every count is
// tri-state: a number is measured, null is "not read" (budget, refusal, or a JQL Jira could
// not answer), and only a measured zero is evidence of non-use.

import { findDuplicateStatusGroups } from "./workflow-insights.js";
import { normalizeJql } from "./jql-refs.js";

// The window every usage and outcome count is measured over.
export const JSM_WINDOW_DAYS = 90;

export const REQUEST_TYPE_FINDINGS = {
  hidden: { severity: "medium", title: "Not on the portal" },
  unused: { severity: "low", title: `No requests in ${JSM_WINDOW_DAYS} days` },
  undescribed: { severity: "low", title: "No description for customers" },
  "duplicate-name": { severity: "medium", title: "Same name as another request type on this desk" },
};

export const QUEUE_FINDINGS = {
  "broken-ref": { severity: "high", title: "Names a custom field that no longer exists" },
  empty: { severity: "low", title: "Empty queue" },
  "duplicate-jql": { severity: "low", title: "Same query as another queue on this desk" },
};

export const ORGANIZATION_FINDINGS = {
  empty: { severity: "medium", title: "No members" },
  unattached: { severity: "low", title: "Not attached to any service desk" },
};

export const SLA_FINDINGS = {
  unused: { severity: "low", title: `Nothing ran against this SLA in ${JSM_WINDOW_DAYS} days` },
  "high-breach": { severity: "medium", title: "Breaches more often than it is met" },
};

const n = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const measured = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const finding = (catalog, code, detail) => ({ code, ...catalog[code], detail });

// Custom field ids a JQL string names in the unambiguous forms: cf[10030] or customfield_10030.
// Field NAMES are deliberately not checked -- a queue saying "Team" might mean a system field,
// a field renamed since, or an alias, and guessing would invent broken queues.
export function customFieldIdsInJql(jql) {
  const ids = new Set();
  for (const m of String(jql || "").matchAll(/\bcf\[(\d+)\]/gi)) ids.add(`customfield_${m[1]}`);
  for (const m of String(jql || "").matchAll(/\bcustomfield_(\d+)\b/gi)) ids.add(`customfield_${m[1]}`);
  return [...ids];
}

// The custom fields a queue names that the field catalog does not have. Null when the catalog
// could not be read: "we did not check" must never render as "nothing is broken".
export function brokenFieldRefs(jql, knownFieldIds) {
  if (!knownFieldIds) return null;
  return customFieldIdsInJql(jql).filter((id) => !knownFieldIds.has(id));
}

// Request types, each with its findings. Duplicate names are judged per desk -- two desks may
// both have "Get IT help" and that is the point of separate desks.
export function analyzeRequestTypes(requestTypes = [], { groupsReadByDesk = new Map() } = {}) {
  const dupGroupOf = new Map();
  const byDesk = new Map();
  for (const rt of requestTypes) {
    if (!byDesk.has(rt.deskId)) byDesk.set(rt.deskId, []);
    byDesk.get(rt.deskId).push(rt);
  }
  for (const rows of byDesk.values()) {
    for (const group of findDuplicateStatusGroups(rows.map((r) => ({ id: r.id, name: r.name })))) {
      for (const s of group.statuses) dupGroupOf.set(String(s.id), `${rows[0].deskId}|${group.key}`);
    }
  }

  return requestTypes.map((rt) => {
    const findings = [];
    const groupIds = rt.groupIds || [];
    // Hidden only when the desk's groups were actually read; an unread group list proves nothing.
    if (groupsReadByDesk.get(rt.deskId) !== false && groupIds.length === 0) {
      findings.push(
        finding(
          REQUEST_TYPE_FINDINGS,
          "hidden",
          "In no portal group, so customers cannot see it. Fine for an agent-only type; otherwise add it to a group.",
        ),
      );
    }
    const recent = n(rt.recentCount);
    if (measured(recent) && recent === 0) {
      const total = n(rt.issueCount);
      findings.push(
        finding(
          REQUEST_TYPE_FINDINGS,
          "unused",
          measured(total) && total === 0
            ? "Never used: no request has ever been raised through it."
            : `Used before, but nothing raised in the last ${JSM_WINDOW_DAYS} days.`,
        ),
      );
    }
    if (!rt.hasDescription) {
      findings.push(
        finding(
          REQUEST_TYPE_FINDINGS,
          "undescribed",
          "Customers choose from the name alone; a line of help text cuts misfiled requests.",
        ),
      );
    }
    const duplicateGroup = dupGroupOf.get(String(rt.id)) ?? null;
    if (duplicateGroup) {
      findings.push(
        finding(
          REQUEST_TYPE_FINDINGS,
          "duplicate-name",
          "Another request type on this desk has the same or nearly the same name.",
        ),
      );
    }
    return { ...rt, duplicateGroup, findings };
  });
}

export function analyzeQueues(queues = []) {
  const byKey = new Map();
  for (const q of queues) {
    const key = `${q.deskId}|${normalizeJql(q.jql)}`;
    if (!normalizeJql(q.jql)) continue;
    byKey.set(key, (byKey.get(key) || 0) + 1);
  }
  return queues.map((q) => {
    const findings = [];
    if (Array.isArray(q.brokenRefs) && q.brokenRefs.length > 0) {
      findings.push(
        finding(
          QUEUE_FINDINGS,
          "broken-ref",
          `Its JQL names ${q.brokenRefs.join(", ")}, which the site no longer has. The queue errors or silently drops that clause.`,
        ),
      );
    }
    const count = n(q.issueCount);
    if (measured(count) && count === 0) {
      findings.push(finding(QUEUE_FINDINGS, "empty", "Holds no issues right now."));
    }
    if (normalizeJql(q.jql) && byKey.get(`${q.deskId}|${normalizeJql(q.jql)}`) > 1) {
      findings.push(finding(QUEUE_FINDINGS, "duplicate-jql", "Another queue on this desk runs the same query."));
    }
    return { ...q, findings };
  });
}

// SLAs are global fields applied per desk. Aggregated per field across every desk it was
// measured on; a field with any unmeasured desk cannot be called unused.
export function analyzeSlas(slas = []) {
  const byField = new Map();
  for (const row of slas) {
    if (!byField.has(row.fieldId)) {
      byField.set(row.fieldId, {
        fieldId: row.fieldId,
        name: row.fieldName || row.fieldId,
        desks: [],
        activeCount: 0,
        breachedCount: 0,
        measuredDesks: 0,
        unmeasuredDesks: 0,
      });
    }
    const agg = byField.get(row.fieldId);
    agg.desks.push(row);
    if (measured(row.activeCount) && measured(row.breachedCount)) {
      agg.measuredDesks += 1;
      agg.activeCount += Number(row.activeCount);
      agg.breachedCount += Number(row.breachedCount);
    } else {
      agg.unmeasuredDesks += 1;
    }
  }
  return [...byField.values()].map((agg) => {
    const findings = [];
    if (agg.unmeasuredDesks === 0 && agg.measuredDesks > 0 && agg.activeCount === 0) {
      findings.push(
        finding(SLA_FINDINGS, "unused", `No request on any desk ran against it in the last ${JSM_WINDOW_DAYS} days.`),
      );
    }
    const breachRate = agg.activeCount > 0 ? agg.breachedCount / agg.activeCount : null;
    if (breachRate !== null && breachRate > 0.5 && agg.activeCount >= 10) {
      findings.push(
        finding(
          SLA_FINDINGS,
          "high-breach",
          `${agg.breachedCount} of ${agg.activeCount} requests breached it. A goal missed this often is either wrong or under-resourced.`,
        ),
      );
    }
    return { ...agg, breachRate, findings };
  });
}

export function analyzeOrganizations(organizations = []) {
  return organizations.map((org) => {
    const findings = [];
    const members = n(org.memberCount);
    if (measured(members) && members === 0) {
      findings.push(
        finding(ORGANIZATION_FINDINGS, "empty", "Nobody belongs to it; requests shared with it reach no one."),
      );
    }
    if (measured(org.deskCount) && Number(org.deskCount) === 0) {
      findings.push(finding(ORGANIZATION_FINDINGS, "unattached", "No service desk uses it."));
    }
    return { ...org, findings };
  });
}

const countWith = (rows, code) => rows.filter((r) => r.findings.some((f) => f.code === code)).length;

// Every count the tab, the report, the score and the Rovo agent read. `jsmEnabled: false` is a
// distinct, correct answer -- the build ran and there is no service desk on this site -- and
// every pillar reports not-applicable rather than unmeasured.
export function summarizeJsm({
  jsmEnabled = true,
  desks = [],
  requestTypes = [],
  queues = [],
  slas = [],
  organizations = [],
  groupsReadByDesk,
  slaFieldsKnown = true,
} = {}) {
  if (!jsmEnabled) {
    return { available: false, jsmEnabled: false };
  }
  const rts = analyzeRequestTypes(requestTypes, { groupsReadByDesk });
  const qs = analyzeQueues(queues);
  const sla = analyzeSlas(slas);
  const orgs = analyzeOrganizations(organizations);

  const usageMeasured = rts.filter((r) => measured(r.recentCount));
  const countsMeasured = qs.filter((q) => measured(q.issueCount));
  const brokenChecked = qs.filter((q) => Array.isArray(q.brokenRefs));
  const slaMeasured = sla.filter((s) => s.measuredDesks > 0);
  const active = slaMeasured.reduce((sum, s) => sum + s.activeCount, 0);
  const breached = slaMeasured.reduce((sum, s) => sum + s.breachedCount, 0);
  const membersMeasured = orgs.filter((o) => measured(o.memberCount));
  const dupGroups = new Set(rts.map((r) => r.duplicateGroup).filter(Boolean));

  return {
    available: desks.length > 0,
    jsmEnabled: true,
    totalDesks: desks.length,
    requestTypes: {
      total: rts.length,
      hidden: countWith(rts, "hidden"),
      undescribed: countWith(rts, "undescribed"),
      duplicateNames: countWith(rts, "duplicate-name"),
      duplicateGroups: dupGroups.size,
      usageMeasured: usageMeasured.length,
      unused: countWith(rts, "unused"),
      recentRequests: usageMeasured.reduce((sum, r) => sum + Number(r.recentCount), 0),
    },
    queues: {
      total: qs.length,
      brokenChecked: brokenChecked.length,
      broken: countWith(qs, "broken-ref"),
      countsMeasured: countsMeasured.length,
      empty: countWith(qs, "empty"),
      duplicates: countWith(qs, "duplicate-jql"),
      openIssues: countsMeasured.reduce((sum, q) => sum + Number(q.issueCount), 0),
    },
    slas: {
      known: slaFieldsKnown,
      total: sla.length,
      measured: slaMeasured.length,
      unused: countWith(sla, "unused"),
      highBreach: countWith(sla, "high-breach"),
      activeRequests: active,
      breachedRequests: breached,
      breachRate: active > 0 ? breached / active : null,
    },
    customers: {
      totalOrganizations: orgs.length,
      membersMeasured: membersMeasured.length,
      emptyOrganizations: countWith(orgs, "empty"),
      unattachedOrganizations: countWith(orgs, "unattached"),
      desksWithoutCustomers: desks.filter(
        (d) => measured(d.customerCount) && Number(d.customerCount) === 0 && !Number(d.orgCount),
      ).length,
      customersMeasured: desks.filter((d) => measured(d.customerCount)).length,
    },
  };
}

// The four health inputs computeSiteHealth takes, Access-style: one object per pillar.
export function summarizeJsmHealth(summary) {
  if (!summary) return { requestTypes: null, queues: null, slas: null, customers: null };
  if (summary.jsmEnabled === false) {
    const na = { available: false, jsmEnabled: false };
    return { requestTypes: na, queues: na, slas: na, customers: na };
  }
  const on = summary.available;
  return {
    requestTypes: on ? { available: true, jsmEnabled: true, ...summary.requestTypes } : { available: false },
    queues: on ? { available: true, jsmEnabled: true, ...summary.queues } : { available: false },
    slas: on ? { available: true, jsmEnabled: true, ...summary.slas } : { available: false },
    customers: on ? { available: true, jsmEnabled: true, ...summary.customers } : { available: false },
  };
}
