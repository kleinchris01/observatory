// What a Forge app can learn about the Marketplace apps on this site, asked of the site rather
// than the docs -- before an Apps pillar is designed on top of it.
//
// There is no supported API that lists installed apps. What there is, is the footprint apps
// leave in Jira's own configuration, and every read here uses a scope the app already holds:
//
//   fieldCatalog       app custom fields: a Connect field's type names its app key, a Forge
//                      field's type is its extension ARI (read:jira-work / field catalog)
//   workflowRules      app conditions, validators and post-functions inside workflow
//                      definitions: connect:* rules carry `appKey` and a `disabled` flag,
//                      forge:* rules the app's extension ARI (read:workflow:jira)
//   capabilities       every Connect and Forge workflow rule type installed on the site, with
//                      the app providing it (read:workflow:jira)
//   dashboardGadgets   app gadgets on a sample of dashboards (read:dashboard:jira)
//   auditRecords       whether app installs and removals appear in the Jira audit log
//                      (manage:jira-configuration)
//   upm                the plugin manager (/rest/plugins/1.0/). Documented for Data Center,
//                      reported to work on Cloud with a person's session or API token, and
//                      reported to list only Atlassian's own modules when called as an app.
//                      So it is asked three ways -- as the app, as the admin pressing the
//                      button, and its install-log feed as that admin -- and whichever answers
//                      decides whether the Apps pillar can read the list directly or needs the
//                      admin to save it from their browser and upload it.
//
// Read-only. Rule parameters are inspected for the app's identity and never returned: a
// third-party rule's config can hold a whole script, and scripts hold credentials.

import { logger } from "./logger.js";
import { probeEndpoint, probeEndpointAsUser } from "./jira-api.js";

export const APP_SIGNALS = [
  { key: "fieldCatalog", label: "App custom fields" },
  { key: "workflowRules", label: "App workflow rules in use" },
  { key: "capabilities", label: "App workflow rule types installed" },
  { key: "dashboardGadgets", label: "App dashboard gadgets" },
  { key: "auditRecords", label: "App install events in the audit log" },
  { key: "upm", label: "Installed-app list (plugin manager, as the app)" },
  { key: "upmAsUser", label: "Installed-app list (plugin manager, as you)" },
  { key: "upmLog", label: "App install log (plugin manager feed, as you)" },
];

const CONNECT_PREFIX = "com.atlassian.plugins.atlassian-connect-plugin:";
const FORGE_PREFIX = "ari:cloud:ecosystem::extension/";
// Type-key prefixes that are Atlassian's own products, not Marketplace apps.
const ATLASSIAN_PREFIXES = [
  "com.atlassian.jira.plugin.system",
  "com.atlassian.jira.",
  "com.atlassian.servicedesk",
  "com.atlassian.jpo",
  "com.atlassian.teams",
  "com.atlassian.jconnect",
  "com.atlassian.jira-core",
  "com.pyxis.greenhopper",
  "com.atlassian.bonfire",
  "com.atlassian.plugins.jira-",
  "com.atlassian.jira.gadgets",
  "com.atlassian.gadgets",
  "com.atlassian.streams",
  "com.atlassian.confluence",
  "com.atlassian.bitbucket",
  "com.atlassian.opsgenie",
  // Jira Product Discovery: an Atlassian product whose fields use its own namespace.
  "jira.polaris",
];

// Gadgets can name their module by URI rather than key: rest/gadgets/1.0/g/<pluginKey>:<gadget>.
const GADGET_URI_PREFIX = /^\/?rest\/gadgets\/1\.0\/g\//;
// Forge-built gadgets surface as com.atlassian.forge:<...>; whose app sits after the colon.
const FORGE_GADGET_PREFIX = "com.atlassian.forge:";
const UUID_AT_START = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

// Display names for app keys an admin will recognise. Unknown keys are shown as the key itself.
export const KNOWN_VENDORS = {
  "com.onresolve.jira.groovy.groovyrunner": "ScriptRunner",
  "com.innovalog.jmwe.jira-misc-workflow-extensions": "JMWE",
  "com.googlecode.jira-suite-utilities": "JSU",
  "com.fca.jira.plugins.workflowToolbox.workflow-toolbox": "Jira Workflow Toolbox",
  "com.deviniti.jira.plugins.dynamic-forms": "Dynamic Forms",
  "com.tempoplugin.tempo-timesheets": "Tempo Timesheets",
  "is.origo.jira.tempo-plugin": "Tempo",
  "com.easesolutions.jira.plugins.requirements": "R4J",
  "com.xpandit.plugins.xray": "Xray",
  "com.thed.zephyr.je": "Zephyr",
  "com.kanoah.test-manager": "Zephyr Scale",
  "com.elements.jira.connect.elements-connect": "Elements Connect",
  "com.codebarrel.addons.automation": "Automation (legacy)",
  "com.okapya.jira.checklist": "Checklist for Jira",
  "com.herocoders.plugins.jira.issuechecklist-free": "Issue Checklist",
};

export function appLabel(identity) {
  return KNOWN_VENDORS[identity] || identity;
}

// A Connect app key, without the module suffix some payloads attach: JMWE's rules name their
// app as "com.innovalog.jmwe.jira-misc-workflow-extensions__ClearFieldsFunction".
export function connectAppKey(value) {
  const key = String(value || "");
  return key.split("__")[0] || key || null;
}

// Who provides a field or gadget type key: { kind, app } or null for Atlassian's own types.
export function classifyTypeKey(typeKey) {
  let key = String(typeKey || "").trim();
  if (!key) return null;
  key = key.replace(GADGET_URI_PREFIX, "");
  if (key.startsWith(CONNECT_PREFIX)) return { kind: "connect", app: connectAppKey(key.slice(CONNECT_PREFIX.length)) };
  if (key.startsWith(FORGE_PREFIX)) return { kind: "forge", app: forgeAppId(key) };
  if (key.startsWith(FORGE_GADGET_PREFIX)) {
    const rest = key.slice(FORGE_GADGET_PREFIX.length);
    if (rest.includes(FORGE_PREFIX)) return { kind: "forge", app: forgeAppId(rest) };
    const uuid = UUID_AT_START.exec(rest);
    // Unresolved: kept visible rather than guessed, with the raw keys in the probe's samples.
    return uuid
      ? { kind: "forge", app: uuid[1].toLowerCase() }
      : { kind: "forge-unresolved", app: "com.atlassian.forge" };
  }
  if (ATLASSIAN_PREFIXES.some((p) => key.startsWith(p))) return null;
  // A vendor key is namespaced (com.vendor.product:module). A bare "read-only-string-issue-field"
  // carries no vendor and is one of Jira's own internal types.
  const colon = key.indexOf(":");
  const namespace = colon > 0 ? key.slice(0, colon) : key;
  if (!namespace.includes(".")) return null;
  return { kind: "plugin", app: namespace };
}

// ari:cloud:ecosystem::extension/{appId}/{environmentId}/static/{moduleKey} -> appId
export function forgeAppId(ari) {
  const rest = String(ari || "").split(FORGE_PREFIX)[1] || "";
  return rest.split("/")[0] || null;
}

// Connect, plugin-style and plugin-manager evidence all name an app by its key, so they merge;
// a Forge app is named by its app id, which nothing else shares.
const identityOf = ({ kind, app }) => (kind === "forge" ? `forge:${app}` : `key:${app}`);

// Every connect:/forge: rule anywhere in a workflow payload, by its app. Parameters are read
// for identity only and dropped.
export function collectAppRules(node, out = [], depth = 0) {
  if (!node || depth > 40) return out;
  if (Array.isArray(node)) {
    for (const entry of node) collectAppRules(entry, out, depth + 1);
    return out;
  }
  if (typeof node !== "object") return out;
  const ruleKey = typeof node.ruleKey === "string" ? node.ruleKey : null;
  if (ruleKey && (ruleKey.startsWith("connect:") || ruleKey.startsWith("forge:"))) {
    const p = node.parameters || {};
    const kind = ruleKey.startsWith("connect:") ? "connect" : "forge";
    out.push({
      kind,
      ruleKey,
      app: kind === "connect" ? connectAppKey(p.appKey) || "unknown" : forgeAppId(p.key) || "unknown",
      disabled: String(p.disabled) === "true",
    });
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") collectAppRules(value, out, depth + 1);
  }
  return out;
}

// One row per app, across every signal that saw it.
export function mergeAppEvidence(evidence) {
  const apps = new Map();
  for (const { source, kind, app, count = 1, extra = null } of evidence) {
    if (!app) continue;
    const id = identityOf({ kind, app });
    if (!apps.has(id)) apps.set(id, { id, kind, app, label: appLabel(app), sources: {}, disabledRules: 0 });
    const row = apps.get(id);
    // The plugin manager only says "installed"; a field or rule says how the app is built.
    if (row.kind === "installed" && kind !== "installed") row.kind = kind;
    row.sources[source] = (row.sources[source] || 0) + count;
    if (extra?.disabled) row.disabledRules += extra.disabled;
  }
  return [...apps.values()].sort(
    (a, b) =>
      Object.keys(b.sources).length - Object.keys(a.sources).length ||
      Object.values(b.sources).reduce((s, n) => s + n, 0) - Object.values(a.sources).reduce((s, n) => s + n, 0),
  );
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function verdictOf(probe) {
  if (probe.status === null || probe.status === undefined) return "error";
  if (probe.ok) return "ok";
  if (probe.status === 401) return "missing-scope";
  if (probe.status === 403) return "forbidden";
  if (probe.status === 404) return "not-found";
  return "error";
}

const APP_WORDS = /\b(app|apps|add-on|addon|plugin|marketplace)\b/i;
const MAX_DASHBOARDS = 10;
const MAX_SAMPLES = 15;

export async function probeMarketplaceApps() {
  const started = Date.now();
  const results = [];
  const evidence = [];

  const add = (meta, probe, extra = {}) => {
    const row = {
      ...meta,
      path: probe.path ?? null,
      status: probe.status ?? null,
      ok: Boolean(probe.ok),
      ms: probe.ms ?? 0,
      verdict: verdictOf(probe),
      // Raw bodies are never returned: workflow and gadget payloads can carry scripts and URLs.
      sample: probe.ok ? null : probe.sample || null,
      ...extra,
    };
    results.push(row);
    return row;
  };

  // ---- Custom fields ------------------------------------------------------------------
  const fields = await probeEndpoint("/rest/api/3/field", { keepBody: true });
  {
    const parsed = fields.ok ? parseJson(fields.body) : null;
    const custom = Array.isArray(parsed) ? parsed.filter((f) => f?.custom) : [];
    const byKind = { connect: 0, forge: 0, plugin: 0, atlassian: 0 };
    const samples = new Set();
    for (const f of custom) {
      const who = classifyTypeKey(f?.schema?.custom);
      if (!who) {
        byKind.atlassian += 1;
        continue;
      }
      byKind[who.kind === "forge-unresolved" ? "forge" : who.kind] += 1;
      evidence.push({ source: "fields", kind: who.kind, app: who.app });
      if (samples.size < MAX_SAMPLES) samples.add(String(f.schema.custom));
    }
    add({ step: "fieldCatalog", signal: "fieldCatalog", note: "Custom field type keys, by provider" }, fields, {
      count: custom.length,
      // Type keys only (no field names): what each app-provided field type looks like here.
      samples: [...samples],
      summary: fields.ok
        ? `${custom.length} custom fields: ${byKind.connect} Connect, ${byKind.forge} Forge, ${byKind.plugin} other app keys, ${byKind.atlassian} Atlassian.`
        : null,
    });
  }

  // ---- Workflow rules in use ------------------------------------------------------------
  const workflows = await probeEndpoint("/rest/api/3/workflows/search?expand=values.transitions&maxResults=50", {
    keepBody: true,
  });
  let workflowId = null;
  let workflowScope = null;
  {
    const parsed = workflows.ok ? parseJson(workflows.body) : null;
    const values = Array.isArray(parsed?.values) ? parsed.values : [];
    // Capabilities are scoped to the workflow asked about. A team-managed (project-scoped)
    // workflow offers no app rule types, so ask about a company-managed one when there is one.
    const global = values.find((w) => w?.id && String(w?.scope?.type || "").toUpperCase() === "GLOBAL");
    const chosen = global || values.find((w) => w?.id) || null;
    workflowId = chosen?.id ?? null;
    workflowScope = chosen ? String(chosen?.scope?.type || "unknown").toUpperCase() : null;
    const rules = collectAppRules(values);
    const perApp = new Map();
    for (const r of rules) {
      const id = identityOf(r);
      const agg = perApp.get(id) || { kind: r.kind, app: r.app, count: 0, disabled: 0 };
      agg.count += 1;
      if (r.disabled) agg.disabled += 1;
      perApp.set(id, agg);
    }
    for (const a of perApp.values()) {
      evidence.push({
        source: "workflowRules",
        kind: a.kind,
        app: a.app,
        count: a.count,
        extra: { disabled: a.disabled },
      });
    }
    const disabled = rules.filter((r) => r.disabled).length;
    add(
      { step: "workflowRules", signal: "workflowRules", note: "connect:/forge: rules on the first 50 workflows" },
      workflows,
      {
        count: rules.length,
        more: parsed?.isLast === false,
        summary: workflows.ok
          ? `${rules.length} app rules across ${values.length} workflows, from ${perApp.size} apps${disabled ? `; ${disabled} marked disabled` : ""}.`
          : null,
      },
    );
  }

  // ---- Installed workflow rule types ----------------------------------------------------
  if (workflowId) {
    const caps = await probeEndpoint(
      `/rest/api/3/workflows/capabilities?workflowId=${encodeURIComponent(workflowId)}`,
      {
        keepBody: true,
      },
    );
    const parsed = caps.ok ? parseJson(caps.body) : null;
    const connectRules = Array.isArray(parsed?.connectRules) ? parsed.connectRules : [];
    const forgeRules = Array.isArray(parsed?.forgeRules) ? parsed.forgeRules : [];
    for (const r of connectRules) evidence.push({ source: "capabilities", kind: "connect", app: r?.addonKey });
    for (const r of forgeRules) evidence.push({ source: "capabilities", kind: "forge", app: forgeAppId(r?.id) });
    add({ step: "capabilities", signal: "capabilities", note: "Connect and Forge rule types available" }, caps, {
      count: connectRules.length + forgeRules.length,
      editorScope: parsed?.editorScope ?? null,
      summary: caps.ok
        ? `${connectRules.length} Connect and ${forgeRules.length} Forge rule types offered to a ${workflowScope === "GLOBAL" ? "company-managed" : (workflowScope || "unknown").toLowerCase()} workflow.`
        : null,
    });
  } else {
    results.push({
      step: "capabilities",
      signal: "capabilities",
      note: "Connect and Forge rule types available",
      path: null,
      status: null,
      ok: false,
      verdict: "skipped",
      sample: "Skipped: no workflow id to ask about.",
    });
  }

  // ---- Dashboard gadgets ----------------------------------------------------------------
  const dashboards = await probeEndpoint(`/rest/api/3/dashboard/search?maxResults=${MAX_DASHBOARDS}`, {
    keepBody: true,
  });
  {
    const parsed = dashboards.ok ? parseJson(dashboards.body) : null;
    const ids = (Array.isArray(parsed?.values) ? parsed.values : []).map((d) => d?.id).filter(Boolean);
    let gadgets = 0;
    let appGadgets = 0;
    const gadgetKeys = new Map();
    let lastFailure = null;
    for (const id of ids) {
      const g = await probeEndpoint(`/rest/api/3/dashboard/${encodeURIComponent(id)}/gadget`, { keepBody: true });
      if (!g.ok) {
        lastFailure = g;
        continue;
      }
      for (const gadget of parseJson(g.body)?.gadgets || []) {
        gadgets += 1;
        const raw = String(gadget?.moduleKey || gadget?.uri || "");
        gadgetKeys.set(raw, (gadgetKeys.get(raw) || 0) + 1);
        const who = classifyTypeKey(raw);
        if (who) {
          appGadgets += 1;
          evidence.push({ source: "gadgets", kind: who.kind, app: who.app });
        }
      }
    }
    add(
      { step: "dashboardGadgets", signal: "dashboardGadgets", note: `Gadgets on up to ${MAX_DASHBOARDS} dashboards` },
      lastFailure && gadgets === 0 ? lastFailure : dashboards,
      {
        count: gadgets,
        // Distinct module keys with their counts, most common first, so a key this probe
        // classified wrongly can be seen and corrected.
        samples: [...gadgetKeys]
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_SAMPLES)
          .map(([key, n]) => `${key} (${n})`),
        summary: dashboards.ok
          ? `${appGadgets} of ${gadgets} gadgets on ${ids.length} dashboards come from apps.`
          : null,
      },
    );
  }

  // ---- Audit log ------------------------------------------------------------------------
  // Two reads: the most recent records (what the log holds at all), and a text search for "app"
  // across up to 1,000 records, since 200 recent records is too narrow a window to prove that
  // app installs are not logged here.
  const audit = await probeEndpoint("/rest/api/3/auditing/record?limit=200", { keepBody: true });
  const auditSearch = await probeEndpoint("/rest/api/3/auditing/record?filter=app&limit=1000", { keepBody: true });
  {
    const parsed = audit.ok ? parseJson(audit.body) : null;
    const records = Array.isArray(parsed?.records) ? parsed.records : [];
    const categories = {};
    for (const r of records) categories[r?.category || "(none)"] = (categories[r?.category || "(none)"] || 0) + 1;
    const searched = auditSearch.ok ? parseJson(auditSearch.body)?.records || [] : [];
    const appRecords = [...records, ...searched].filter((r, i, all) => {
      if (!APP_WORDS.test(`${r?.category || ""} ${r?.summary || ""}`)) return false;
      return all.findIndex((x) => x?.id === r?.id && x?.created === r?.created) === i;
    });
    const oldest = searched.length ? searched[searched.length - 1]?.created : null;
    add({ step: "auditRecords", signal: "auditRecords", note: "App events in the audit log" }, audit, {
      count: records.length,
      searched: auditSearch.ok ? searched.length : null,
      categories,
      // Event summaries only ("App installed"), never the object or the person behind them.
      appEvents: appRecords
        .slice(0, 5)
        .map((r) => ({ summary: String(r?.summary || "").slice(0, 120), created: r?.created ?? null })),
      summary: audit.ok
        ? `${records.length} recent records${auditSearch.ok ? `, and ${searched.length} matching a search for "app"${oldest ? ` back to ${String(oldest).slice(0, 10)}` : ""}` : ""}; ${appRecords.length} mention an app, add-on or plugin. Categories: ${Object.keys(categories).join(", ") || "none"}.`
        : null,
    });
  }

  // ---- Plugin manager, three ways ------------------------------------------------------
  const readUpm = (probe, step, note) => {
    const parsed = probe.ok ? parseJson(probe.body) : null;
    const plugins = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
    const userInstalled = plugins.filter((p) => p?.userInstalled === true || p?.userInstalled === 1);
    for (const p of userInstalled) {
      if (p?.key) evidence.push({ source: step, kind: "installed", app: String(p.key) });
    }
    add({ step, signal: step, note }, probe, {
      count: plugins.length,
      userInstalled: userInstalled.length,
      summary: probe.ok
        ? parsed
          ? `${plugins.length} entries, ${userInstalled.length} marked user-installed.`
          : "Answered, but not with a JSON plugin list."
        : null,
    });
  };
  readUpm(
    await probeEndpoint("/rest/plugins/1.0/", { keepBody: true }),
    "upm",
    "Plugin manager list, called as the app",
  );
  readUpm(
    await probeEndpointAsUser("/rest/plugins/1.0/", { keepBody: true }),
    "upmAsUser",
    "Plugin manager list, called as the admin running the probe",
  );
  {
    // An Atom/RSS feed of install, update and removal events. Counted, never returned.
    const feed = await probeEndpointAsUser("/rest/plugins/1.0/log/feed", {
      keepBody: true,
      headers: { Accept: "application/atom+xml, application/xml, text/xml" },
    });
    const entries = feed.ok ? (String(feed.body || "").match(/<entry[\s>]/g) || []).length : 0;
    add({ step: "upmLog", signal: "upmLog", note: "App install log feed, as the admin" }, feed, {
      count: entries,
      summary: feed.ok ? `${entries} install-log entries.` : null,
    });
  }

  const apps = mergeAppEvidence(evidence);
  logger.info("apps-probe.summary", {
    apps: apps.length,
    signals: Object.fromEntries(results.map((r) => [r.step, `${r.verdict}:${r.count ?? "-"}`])),
  });

  return {
    signals: APP_SIGNALS.map(({ key, label }) => {
      const row = results.find((r) => r.signal === key);
      return { key, label, verdict: row?.verdict ?? "skipped", summary: row?.summary ?? row?.sample ?? null };
    }),
    apps,
    results,
    ms: Date.now() - started,
  };
}
