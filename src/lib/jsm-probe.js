// Confirms what the Jira Service Management API answers on this site, before the four JSM
// pillars (request types, queues, SLAs, customers and organizations) are built on it.
//
// The same reason the Assets probe existed: Atlassian's documentation and a live site have
// disagreed before (a transport only one Forge surface reaches, a 401 that was a missing
// scope rather than a missing licence). This asks the site rather than the docs.
//
// It samples ONE service desk -- enough to see every shape the engine will rely on -- and is
// read-only throughout. Each row records which pillar it serves and which build stage needs
// it: stage 1 is structure (what is configured), stage 2 is usage and outcomes (counts from
// JQL). summarizeAreas() turns the rows into a ready / missing-scope / blocked answer per
// pillar and stage.
//
// Customer and organization payloads hold people's names and email addresses. Those rows
// report counts only: their response bodies are never returned or logged.

import { logger } from "./logger.js";
import { probeEndpoint, probeJqlCount } from "./jira-api.js";

const SD = "/rest/servicedeskapi";
// The customer and organization endpoints are flagged experimental and answer 400 without it.
const EXPERIMENTAL = { "X-ExperimentalApi": "opt-in" };
const SLA_FIELD_TYPE = "com.atlassian.servicedesk:sd-sla-field";
const REQUEST_TYPE_FIELD_TYPE = "com.atlassian.servicedesk:vp-origin";
const PERSONAL_SAMPLE = "(contents not shown: customer and organization data)";

export const PROBE_AREAS = [
  { key: "requestTypes", label: "Request types, portal and forms" },
  { key: "queues", label: "Queues" },
  { key: "slas", label: "SLAs" },
  { key: "customers", label: "Customers and organizations" },
];

// What one row's answer means. A 401 "scope does not match" is a manifest gap, fixed by a
// redeploy and upgrade; a 403 is the app lacking a permission on the site; keeping them apart
// is the point of the probe.
export function verdictOf(row) {
  if (row.verdict === "skipped" || row.verdict === "unexpected-shape") return row.verdict;
  if (row.status === null || row.status === undefined) return "error";
  if (row.ok) return "ok";
  if (row.status === 401 || /scope does not match/i.test(row.sample || "")) return "missing-scope";
  if (row.status === 403) return "forbidden";
  if (row.status === 404) return "not-found";
  if (row.status === 400 && row.jql) return "jql-rejected";
  return "error";
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// servicedeskapi pages are { size, isLastPage, values: [...] }; a few endpoints answer with
// a bare array, and the request type field endpoint with { requestTypeFields: [...] }.
export function pageValues(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.values)) return parsed.values;
  if (Array.isArray(parsed?.requestTypeFields)) return parsed.requestTypeFields;
  return [];
}

export function hasMorePages(parsed) {
  return parsed?.isLastPage === false;
}

// JQL string literal. Request type names are admin-entered and can hold quotes.
export function jqlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// "customfield_10030" -> "cf[10030]": the JQL form that cannot collide with another field's name.
export function cfRef(fieldId) {
  const match = /^customfield_(\d+)$/.exec(String(fieldId || ""));
  return match ? `cf[${match[1]}]` : null;
}

// SLA fields and the request type field, from the field catalog.
export function serviceFields(fields) {
  const list = Array.isArray(fields) ? fields : [];
  return {
    slaFields: list.filter((f) => f?.schema?.custom === SLA_FIELD_TYPE).map((f) => ({ id: f.id, name: f.name })),
    requestTypeField: list.find((f) => f?.schema?.custom === REQUEST_TYPE_FIELD_TYPE) || null,
  };
}

// Per pillar, whether stage 1 (structure) and stage 2 (usage) can be built on what answered.
// Only `required` rows decide; optional rows (forms, per-request SLA) are reported but never
// block a stage.
export function summarizeAreas(results) {
  return PROBE_AREAS.map(({ key, label }) => {
    const rows = results.filter((r) => r.area === key);
    const tier = (stage) => {
      const required = rows.filter((r) => r.stage === stage && r.required);
      if (!required.length) return { state: "untested", detail: "Nothing was probed for this stage." };
      const failing = required.filter((r) => r.verdict !== "ok");
      if (!failing.length) return { state: "ready", detail: null };
      if (failing.every((r) => r.verdict === "skipped")) return { state: "untested", detail: failing[0].sample };
      const scope = failing.filter((r) => r.verdict === "missing-scope");
      if (scope.length) {
        return {
          state: "missing-scope",
          detail: `Scope not granted for: ${scope.map((r) => r.step).join(", ")}. Redeploy and upgrade the install.`,
        };
      }
      return {
        state: "blocked",
        detail: failing.map((r) => `${r.step}: ${r.verdict}${r.status ? ` (${r.status})` : ""}`).join("; "),
      };
    };
    return { key, label, structure: tier(1), usage: tier(2) };
  });
}

// Why the probe could not get started, when the service desk list did not answer.
export function availabilityReason(desksRow) {
  const verdict = verdictOf(desksRow);
  if (verdict === "missing-scope") {
    return "The service desk list returned 401 (scope does not match): the app is missing a Service Management scope. Redeploy and upgrade the install.";
  }
  if (verdict === "not-found") return "Jira Service Management is not on this site.";
  if (verdict === "forbidden")
    return "The service desk list returned 403: the app is not allowed to read service desks on this site.";
  if (desksRow.ok) return "Jira Service Management answered but has no service desks.";
  return `The service desk list returned ${desksRow.status ?? "no response"}.`;
}

export async function probeServiceManagementApi({ cloudId = null } = {}) {
  const started = Date.now();
  const results = [];

  const add = (meta, probe, { personal = false } = {}) => {
    const row = {
      ...meta,
      path: probe.path ?? meta.path ?? null,
      status: probe.status,
      ok: probe.ok,
      ms: probe.ms,
      sample: personal && probe.ok ? PERSONAL_SAMPLE : probe.sample,
    };
    if (probe.jql !== undefined) {
      row.jql = probe.jql;
      row.count = probe.count;
    }
    row.verdict = verdictOf(row);
    results.push(row);
    return row;
  };
  const skip = (meta, reason) => {
    const row = {
      ...meta,
      path: meta.path ?? null,
      status: null,
      ok: false,
      ms: 0,
      sample: reason,
      verdict: "skipped",
    };
    results.push(row);
    return row;
  };
  const counted = (row, parsed) => {
    row.count = pageValues(parsed).length;
    row.more = hasMorePages(parsed);
    return row;
  };

  // ---- Site level -------------------------------------------------------------------------
  const info = await probeEndpoint(`${SD}/info`, { keepBody: true });
  add({ step: "info", area: null, stage: 1, required: false, note: "JSM version on this site" }, info);
  const version = info.ok ? (parseJson(info.body)?.version ?? null) : null;

  const desksProbe = await probeEndpoint(`${SD}/servicedesk?limit=50`, { keepBody: true });
  const desksRow = add(
    { step: "serviceDesks", area: null, stage: 1, required: true, note: "Every service desk, with its project" },
    desksProbe,
  );
  const desksParsed = desksProbe.ok ? parseJson(desksProbe.body) : null;
  const desks = pageValues(desksParsed);
  counted(desksRow, desksParsed);
  const desk = desks[0] || null;

  const fieldsProbe = await probeEndpoint("/rest/api/3/field", { keepBody: true });
  const { slaFields, requestTypeField } = serviceFields(fieldsProbe.ok ? parseJson(fieldsProbe.body) : null);
  const catalogRow = add(
    {
      step: "slaFieldDiscovery",
      area: "slas",
      stage: 1,
      required: true,
      note: "SLA fields, found by type in the field catalog",
    },
    fieldsProbe,
  );
  if (fieldsProbe.ok) {
    catalogRow.sample =
      `SLA fields: ${slaFields.map((f) => `${f.name} (${f.id})`).join(", ") || "none"}. ` +
      `Request type field: ${requestTypeField ? requestTypeField.id : "none"}.`;
    catalogRow.count = slaFields.length;
  }

  // ---- One sampled service desk -----------------------------------------------------------
  const noDesk = desksProbe.ok
    ? "Skipped: no service desk to sample."
    : "Skipped: the service desk list did not answer.";
  const deskPath = desk ? `${SD}/servicedesk/${desk.id}` : null;
  const projectClause = desk ? `project = ${jqlString(desk.projectKey)}` : null;

  // Request types, portal groups, request type fields.
  let requestType = null;
  if (desk) {
    const probe = await probeEndpoint(`${deskPath}/requesttype?limit=50`, { keepBody: true });
    const parsed = probe.ok ? parseJson(probe.body) : null;
    counted(
      add(
        { step: "requestTypes", area: "requestTypes", stage: 1, required: true, note: "The desk's request types" },
        probe,
      ),
      parsed,
    );
    requestType = pageValues(parsed)[0] || null;
    const groups = await probeEndpoint(`${deskPath}/requesttypegroup`, { keepBody: true });
    counted(
      add(
        {
          step: "portalGroups",
          area: "requestTypes",
          stage: 1,
          required: true,
          note: "Portal groups (a request type in none is hidden)",
        },
        groups,
      ),
      groups.ok ? parseJson(groups.body) : null,
    );
  } else {
    skip({ step: "requestTypes", area: "requestTypes", stage: 1, required: true }, noDesk);
    skip({ step: "portalGroups", area: "requestTypes", stage: 1, required: true }, noDesk);
  }
  if (desk && requestType) {
    const probe = await probeEndpoint(`${deskPath}/requesttype/${requestType.id}/field`, { keepBody: true });
    counted(
      add(
        {
          step: "requestTypeFields",
          area: "requestTypes",
          stage: 1,
          required: true,
          note: "Fields a request type shows, with labels and required flags",
        },
        probe,
      ),
      probe.ok ? parseJson(probe.body) : null,
    );
  } else {
    skip(
      { step: "requestTypeFields", area: "requestTypes", stage: 1, required: true },
      desk ? "Skipped: the desk has no request types to sample." : noDesk,
    );
  }
  // Every request type on the site in one call, if this answers -- one call instead of one per desk.
  const allTypes = await probeEndpoint(`${SD}/requesttype?limit=1`, { keepBody: true });
  counted(
    add(
      {
        step: "allRequestTypes",
        area: "requestTypes",
        stage: 1,
        required: false,
        note: "Site-wide request type list (saves a call per desk)",
      },
      allTypes,
    ),
    allTypes.ok ? parseJson(allTypes.body) : null,
  );

  // Forms live on the gateway; whether requestJira's proxy reaches them is the open question.
  if (cloudId && desk?.projectId) {
    const forms = await probeEndpoint(`/jira/forms/cloud/${cloudId}/project/${desk.projectId}/form`);
    add(
      {
        step: "forms",
        area: "requestTypes",
        stage: 1,
        required: false,
        note: "Form templates on the project (Forms API)",
      },
      forms,
    );
  } else {
    skip(
      { step: "forms", area: "requestTypes", stage: 1, required: false },
      cloudId ? noDesk : "Skipped: no cloud id in the install context.",
    );
  }

  // Queues: the engine needs each queue's JQL, and its count for usage.
  if (desk) {
    const probe = await probeEndpoint(`${deskPath}/queue?includeCount=true&limit=50`, { keepBody: true });
    const parsed = probe.ok ? parseJson(probe.body) : null;
    const row = counted(
      add({ step: "queues", area: "queues", stage: 1, required: true, note: "Queues with their JQL" }, probe),
      parsed,
    );
    const first = pageValues(parsed)[0];
    if (probe.ok && first && typeof first.jql !== "string") {
      row.verdict = "unexpected-shape";
      row.sample = `Queues answered without a jql property: ${probe.sample}`;
    }
    const countsRow = {
      step: "queueCounts",
      area: "queues",
      stage: 2,
      required: true,
      path: row.path,
      note: "Issue count per queue (includeCount)",
      status: probe.status,
      ok: probe.ok,
      ms: 0,
    };
    if (!probe.ok) countsRow.sample = "See the queues row.";
    else if (!first)
      Object.assign(countsRow, { verdict: "skipped", sample: "Skipped: the desk has no queues to sample." });
    else if (typeof first.issueCount !== "number")
      Object.assign(countsRow, { verdict: "unexpected-shape", sample: "Queues answered without issueCount." });
    else countsRow.sample = `First queue holds ${first.issueCount} issues.`;
    countsRow.verdict = countsRow.verdict ?? verdictOf(countsRow);
    results.push(countsRow);
  } else {
    skip({ step: "queues", area: "queues", stage: 1, required: true }, noDesk);
    skip({ step: "queueCounts", area: "queues", stage: 2, required: true }, noDesk);
  }

  // Customers and organizations: counts only.
  const orgs = await probeEndpoint(`${SD}/organization?limit=50`, { keepBody: true, headers: EXPERIMENTAL });
  counted(
    add(
      { step: "organizations", area: "customers", stage: 1, required: true, note: "Every organization on the site" },
      orgs,
      { personal: true },
    ),
    orgs.ok ? parseJson(orgs.body) : null,
  );
  if (desk) {
    const deskOrgs = await probeEndpoint(`${deskPath}/organization?limit=50`, {
      keepBody: true,
      headers: EXPERIMENTAL,
    });
    counted(
      add(
        {
          step: "deskOrganizations",
          area: "customers",
          stage: 1,
          required: true,
          note: "Organizations attached to the desk",
        },
        deskOrgs,
        { personal: true },
      ),
      deskOrgs.ok ? parseJson(deskOrgs.body) : null,
    );
    const customers = await probeEndpoint(`${deskPath}/customer?limit=50`, { keepBody: true, headers: EXPERIMENTAL });
    counted(
      add(
        { step: "deskCustomers", area: "customers", stage: 1, required: true, note: "Customers of the desk" },
        customers,
        { personal: true },
      ),
      customers.ok ? parseJson(customers.body) : null,
    );
  } else {
    skip({ step: "deskOrganizations", area: "customers", stage: 1, required: true }, noDesk);
    skip({ step: "deskCustomers", area: "customers", stage: 1, required: true }, noDesk);
  }

  // ---- Stage 2: usage and outcomes, by JQL count -----------------------------------------
  const sla = slaFields[0] ? cfRef(slaFields[0].id) : null;
  for (const [step, fn] of [
    ["slaBreached", "breached()"],
    ["slaRunning", "running()"],
  ]) {
    const meta = { step, area: "slas", stage: 2, required: true, note: `Issues whose first SLA is ${fn}` };
    if (desk && sla) add(meta, await probeJqlCount(`${projectClause} AND ${sla} = ${fn}`));
    else skip(meta, desk ? "Skipped: no SLA field on this site." : noDesk);
  }

  const rtRef = requestTypeField ? cfRef(requestTypeField.id) : null;
  {
    const meta = {
      step: "requestTypeVolume",
      area: "requestTypes",
      stage: 2,
      required: true,
      note: "Requests raised through one request type",
    };
    if (desk && rtRef && requestType)
      add(meta, await probeJqlCount(`${projectClause} AND ${rtRef} = ${jqlString(requestType.name)}`));
    else
      skip(
        meta,
        !desk
          ? noDesk
          : !rtRef
            ? "Skipped: no request type field found."
            : "Skipped: the desk has no request types to sample.",
      );
  }
  {
    const meta = {
      step: "portalChannel",
      area: "requestTypes",
      stage: 2,
      required: false,
      note: "Requests raised on the portal in the last 90 days",
    };
    if (desk) add(meta, await probeJqlCount(`${projectClause} AND request-channel-type = portal AND created >= -90d`));
    else skip(meta, noDesk);
  }
  {
    const meta = {
      step: "organizationRequests",
      area: "customers",
      stage: 2,
      required: true,
      note: "Requests raised on behalf of an organization",
    };
    if (desk) add(meta, await probeJqlCount(`${projectClause} AND organizations IS NOT EMPTY`));
    else skip(meta, noDesk);
  }

  // Per-request SLA detail: one recent request. Optional -- the JQL functions above are the plan.
  if (desk) {
    const jql = encodeURIComponent(`${projectClause} ORDER BY created DESC`);
    const search = await probeEndpoint(`/rest/api/3/search/jql?jql=${jql}&maxResults=1&fields=key`, { keepBody: true });
    const key = search.ok ? (parseJson(search.body)?.issues?.[0]?.key ?? null) : null;
    const meta = { step: "requestSla", area: "slas", stage: 2, required: false, note: "SLA cycles on one request" };
    if (key) add(meta, await probeEndpoint(`${SD}/request/${key}/sla`));
    else
      skip(
        meta,
        search.ok
          ? "Skipped: the desk has no requests."
          : `Skipped: could not read a recent request (${search.status ?? "no response"}).`,
      );
  } else {
    skip({ step: "requestSla", area: "slas", stage: 2, required: false }, noDesk);
  }

  const jsmAvailable = desksRow.ok;
  const areas = summarizeAreas(results);
  logger.info("jsm-probe.summary", {
    jsmAvailable,
    version,
    serviceDesks: desks.length,
    slaFields: slaFields.length,
    areas: Object.fromEntries(areas.map((a) => [a.key, `${a.structure.state}/${a.usage.state}`])),
    failing: results.filter((r) => r.verdict !== "ok" && r.verdict !== "skipped").map((r) => `${r.step}:${r.status}`),
  });

  return {
    jsmAvailable,
    reason: jsmAvailable ? null : availabilityReason(desksRow),
    version,
    serviceDeskCount: desks.length,
    moreServiceDesks: hasMorePages(desksParsed),
    sampledDesk: desk
      ? {
          id: String(desk.id),
          projectKey: desk.projectKey ?? null,
          projectId: desk.projectId != null ? String(desk.projectId) : null,
        }
      : null,
    slaFields,
    areas,
    results,
    ms: Date.now() - started,
  };
}
