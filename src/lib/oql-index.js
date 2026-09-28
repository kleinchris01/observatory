// The OQL entity index: every pillar's report rows as one queryable list, with `usage` and
// `impact` levels added to each.
//
// Rows come from the pillar reports (pillar-reports.js), so OQL can only ever say what the
// Reports tab says -- same columns, same findings, same "blank means unmeasured". What this
// adds is the one thing a report cannot: a comparison across the rows. `usage = low` means
// "in the bottom quarter of its own pillar", which is only knowable with the whole pillar in
// hand.
//
// Levels are per pillar, never across pillars: 40 issues is a lot for an issue type and
// nothing for a field, and ranking them on one scale would make every field "high".
//
// Pure, and imported by the Search tab too: the catalog it builds is what autocomplete offers.

import { PILLAR_REPORTS, PILLAR_REPORT_BUILDERS } from "./pillar-reports.js";

// Every report except the change log, which lists events, not things.
export const OQL_PILLARS = PILLAR_REPORTS
  .filter((r) => r.key !== "changes")
  .map(({ key, label, entity }) => ({ key, label, entity }));

const sum = (...values) => (values.every((v) => v == null) ? null : values.reduce((t, v) => t + (Number(v) || 0), 0));
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// What `usage` and `impact` measure in each pillar. Usage: how much people actually use it.
// Impact: how much a change to it would touch. Null `value` means the pillar has no such
// signal and every row is "unmeasured" -- said on the page, never faked with a proxy.
export const PILLAR_MEASURES = {
  fields: {
    usage: { label: "Issues with a value", value: (r) => num(r.issues) },
    impact: { label: "Projects it is configured in", value: (r) => num(r.configuredProjects) },
  },
  projects: {
    usage: { label: "Issues created per day", value: (r) => num(r.issuesPerDay) },
    impact: { label: "Issues in the project", value: (r) => num(r.issues) },
  },
  workflows: {
    usage: { label: "Projects using the scheme", value: (r) => num(r.projects) },
    impact: { label: "Issue type mappings it carries", value: (r) => num(r.mappedIssueTypes) },
  },
  issueTypes: {
    usage: { label: "Issues of this type", value: (r) => num(r.issues) },
    impact: { label: "Projects it is used in", value: (r) => num(r.projects) },
  },
  priorities: {
    usage: { label: "Not measured: no usage data is collected for priorities and resolutions", value: null },
    impact: { label: "Not measured", value: null },
  },
  people: {
    usage: { label: "Not measured: no last-active data is collected", value: null },
    impact: { label: "Filters and dashboards owned, plus automation references", value: (r) => sum(num(r.ownedFilters), num(r.ownedDashboards), num(r.automationRefs)) },
  },
  assets: {
    usage: { label: "Objects of this type", value: (r) => num(r.objects) },
    impact: { label: "Attributes defined on the type", value: (r) => num(r.attributes) },
  },
  access: {
    usage: { label: "Projects using the scheme or role", value: (r) => num(r.projects) },
    impact: { label: "Grants, holders or actors", value: (r) => num(r.grants) },
  },
  screens: {
    usage: { label: "Projects it reaches through screen schemes (transition screens not counted)", value: (r) => num(r.projects) },
    impact: { label: "Fields on the screen", value: (r) => num(r.fields) },
  },
  filters: {
    usage: { label: "Users who favourited it", value: (r) => num(r.favourites) },
    impact: { label: "Subscriptions emailing it", value: (r) => num(r.subscriptions) },
  },
  dashboards: {
    usage: { label: "Users who favourited it", value: (r) => num(r.favourites) },
    impact: { label: "Gadgets on it", value: (r) => num(r.gadgets) },
  },
  boards: {
    usage: { label: "Not measured: no board activity is collected", value: null },
    impact: { label: "Not measured", value: null },
  },
  automation: {
    usage: { label: "Not measured: no execution counts are collected", value: null },
    impact: { label: "Projects in scope (blank for global rules)", value: (r) => num(r.projects) },
  },
};

// Fewer measured rows than this and "a quarter" is one or two rows; every measured row is
// "medium" instead of pretending to a spread that is not there.
export const MIN_ROWS_FOR_LEVELS = 4;

// Nearest-rank percentile of an ascending list.
function percentile(sorted, q) {
  const idx = Math.max(0, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.min(idx, sorted.length - 1)];
}

// Bottom quarter = low, top quarter = high, the middle half = medium, blank = unmeasured.
// When the quartiles coincide (most rows share one value, typically zero), that shared value
// is "medium" only if there is nothing below it; otherwise ties go to the end they sit on.
export function quartileLevels(values) {
  const measured = values.filter((v) => v != null).sort((a, b) => a - b);
  const total = values.length;
  if (measured.length < MIN_ROWS_FOR_LEVELS) {
    return { p25: null, p75: null, measured: measured.length, total, levelOf: (v) => (v == null ? "unmeasured" : "medium") };
  }
  const p25 = percentile(measured, 0.25);
  const p75 = percentile(measured, 0.75);
  const levelOf = (v) => {
    if (v == null) return "unmeasured";
    if (p25 === p75) return v < p25 ? "low" : v > p75 ? "high" : (measured[0] === p25 ? "low" : "medium");
    if (v <= p25) return "low";
    if (v >= p75) return "high";
    return "medium";
  };
  return { p25, p75, measured: measured.length, total, levelOf };
}

function entityId(pillar, row) {
  if (pillar === "people") return row.accountId;
  if (pillar === "projects") return row.key;
  return row.id;
}

/**
 * @param reports finalized pillar reports (buildPillarReport output), any status
 * @returns { entities, thresholds, pillars }
 */
export function buildEntityIndex(reports = []) {
  const entities = [];
  const thresholds = {};
  const pillars = [];
  const labelOf = new Map(OQL_PILLARS.map((p) => [p.key, p.label]));

  for (const report of reports) {
    const key = report.pillar;
    if (!PILLAR_MEASURES[key]) continue;
    pillars.push({
      key,
      label: labelOf.get(key) || report.label,
      status: report.status,
      reason: report.reason || null,
      refreshedAt: report.refreshedAt || null,
      total: report.total ?? 0,
      truncated: Boolean(report.truncated),
    });
    if (report.status !== "ok") continue;

    const measures = PILLAR_MEASURES[key];
    const usageValues = report.rows.map((r) => (measures.usage.value ? measures.usage.value(r) : null));
    const impactValues = report.rows.map((r) => (measures.impact.value ? measures.impact.value(r) : null));
    const usage = quartileLevels(usageValues);
    const impact = quartileLevels(impactValues);
    thresholds[key] = {
      usage: { label: measures.usage.label, p25: usage.p25, p75: usage.p75, measured: usage.measured, total: usage.total },
      impact: { label: measures.impact.label, p25: impact.p25, p75: impact.p75, measured: impact.measured, total: impact.total },
    };

    report.rows.forEach((row, i) => {
      const id = entityId(key, row);
      entities.push({
        ...row,
        pillar: key,
        pillarLabel: labelOf.get(key) || report.label,
        uid: `${key}:${row.kind ? `${row.kind}:` : ""}${row.type && key === "access" ? `${row.type}:` : ""}${id}`,
        id: id == null ? null : String(id),
        name: row.name ?? String(id ?? ""),
        usage: usage.levelOf(usageValues[i]),
        impact: impact.levelOf(impactValues[i]),
        usageValue: usageValues[i],
        impactValue: impactValues[i],
        findings: Array.isArray(row.findings) ? row.findings : [],
      });
    });
  }
  return { entities, thresholds, pillars };
}

// ── Catalog ─────────────────────────────────────────────────────────────────

const PILLAR_ALIASES = {
  issuetypes: "issueTypes", "issue-types": "issueTypes", "issue types": "issueTypes", "issue type": "issueTypes", issuetype: "issueTypes",
  field: "fields", project: "projects", workflow: "workflows", screen: "screens", filter: "filters",
  "saved filters": "filters", "saved-filters": "filters", savedfilters: "filters",
  dashboard: "dashboards", board: "boards", rules: "automation", rule: "automation",
  users: "people", user: "people", resolutions: "priorities", priority: "priorities",
  "priorities & resolutions": "priorities", estate: "priorities",
  permissions: "access", security: "access", notifications: "access", roles: "access",
  asset: "assets", "object types": "assets",
};

const CORE_FIELDS = [
  { key: "pillar", label: "Pillar", kind: "enum", detail: "Which pillar the item belongs to" },
  { key: "name", label: "Name", kind: "text", detail: "Name" },
  { key: "id", label: "ID", kind: "text", detail: "ID or key" },
  { key: "usage", label: "Usage", kind: "level", detail: "low / medium / high within its pillar, or unmeasured" },
  { key: "impact", label: "Impact", kind: "level", detail: "low / medium / high within its pillar, or unmeasured" },
  { key: "findings", label: "Findings", kind: "list", aliases: ["finding"], detail: "Finding codes on the item" },
  { key: "usageValue", label: "Usage value", kind: "number", detail: "The number behind usage" },
  { key: "impactValue", label: "Impact value", kind: "number", detail: "The number behind impact" },
];

const LEVEL_DETAILS = {
  low: "Bottom quarter of its pillar",
  medium: "Middle half of its pillar",
  high: "Top quarter of its pillar",
  unmeasured: "No data for this measure",
};

/**
 * Everything OQL can query. Static apart from `findingCodes`, which the caller may pass so the
 * catalog can offer the codes actually present.
 */
export function buildOqlCatalog({ findingCodes = [] } = {}) {
  const pillarKeys = OQL_PILLARS.map((p) => p.key);
  const valueAliases = { ...PILLAR_ALIASES };
  for (const p of OQL_PILLARS) {
    valueAliases[p.key.toLowerCase()] = p.key;
    valueAliases[p.label.toLowerCase()] = p.key;
  }

  const fields = CORE_FIELDS.map((f) => {
    if (f.key === "pillar") {
      return {
        ...f,
        values: pillarKeys,
        valueAliases,
        valueDetails: Object.fromEntries(OQL_PILLARS.map((p) => [p.key, p.label])),
        pillars: null,
      };
    }
    if (f.kind === "level") return { ...f, valueDetails: LEVEL_DETAILS, pillars: null };
    if (f.key === "findings") return { ...f, values: [...new Set(findingCodes)].sort(), pillars: null };
    return { ...f, pillars: null };
  });

  const coreKeys = new Set(CORE_FIELDS.map((f) => f.key));
  const byKey = new Map();
  for (const p of OQL_PILLARS) {
    const { columns = [] } = PILLAR_REPORT_BUILDERS[p.key]({});
    for (const col of columns) {
      if (coreKeys.has(col.key)) continue;
      if (!byKey.has(col.key)) byKey.set(col.key, { key: col.key, label: col.label, kind: col.kind, pillars: [], labels: {} });
      byKey.get(col.key).pillars.push(p.key);
      // The same key can mean slightly different things per pillar ("fields" is "Fields in
      // use" on a project, "Fields" on a screen); each pillar keeps its own header.
      byKey.get(col.key).labels[p.key] = col.label;
    }
  }
  const labelOf = new Map(OQL_PILLARS.map((p) => [p.key, p.label]));
  const pillarFields = [...byKey.values()]
    .map((f) => ({ ...f, detail: `${f.label} · ${f.pillars.map((k) => labelOf.get(k)).join(", ")}` }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return { fields: [...fields, ...pillarFields], pillars: OQL_PILLARS };
}

export const OQL_EXAMPLES = [
  { query: "pillar = screens AND usage = low AND impact = high", why: "Heavy screens few projects reach" },
  { query: "findings IS NOT EMPTY AND impact = high ORDER BY impactValue DESC", why: "Flagged items with the widest blast radius" },
  { query: "pillar IN (filters, dashboards) AND ownerActive = false", why: "Owned by someone who has left" },
  { query: "pillar = fields AND usage = low AND system = false", why: "Custom fields almost nobody fills in" },
  { query: "pillar = filters AND lastUsed < -180d AND subscriptions > 0", why: "Stale filters still emailing people" },
  { query: "usage = unmeasured AND pillar != priorities", why: "Where the data is missing" },
];
