// Persistence for the automation rule analysis.
//
// Unlike the field and workflow snapshots this does NOT store the source objects. The
// reference site has 1,477 rules averaging 6 KB each; keeping the raw JSON would be ~9 MB
// per scope, far past what a KVS value holds, and nothing in the UI reads a whole rule.
// What is stored is the analysis output -- an estate summary, the rules carrying findings,
// and the cascade edges -- which is small enough to fetch in one call and is the only
// shape the tab actually renders.
//
// The consequence to keep in mind: a question the analysis did not answer at build time
// cannot be answered later without rebuilding. That trade is deliberate. Re-deriving from
// raw rules on demand would mean holding the raw rules, which is the cost being avoided.

import { kvs } from "@forge/kvs";
import { sql } from "@forge/sql";
import { fallbackOn } from "../logger.js";
import { ensureProjectStoreReady, toNumber, withSqlRetry } from "./core.js";

// The document's shape and its size caps live in the analysis module, which imports
// nothing and can therefore be used from the frontend bundle too. Re-exported here so
// callers that only care about storage have one import.
export {
  MAX_PREVIEW_FINDINGS,
  MAX_STORED_CASCADES,
  buildAnalysisDocument,
  buildFindingsDocument,
} from "../automation-analysis.js";

// Four documents under four keys rather than one.
//
// A KVS value holds roughly 240 KB. The analysis alone is ~130 KB on the reference site and
// the field index another ~116 KB, so a single document would not fit. Splitting also means
// the tab's first paint fetches only the analysis: the field and status indexes are loaded
// when someone opens those sections, which most visits never do.
export const AUTOMATION_PARTS = {
  analysis: "automation:analysis:",
  fields: "automation:fields:",
  statuses: "automation:statuses:",
  directory: "automation:directory:",
  findings: "automation:findings:",
};

function keyFor(part, scopeKey) {
  const prefix = AUTOMATION_PARTS[part];
  if (!prefix) throw new Error(`unknown automation storage part: ${part}`);
  return `${prefix}${scopeKey}`;
}

export async function writeAutomationPart(scopeKey, part, document) {
  await kvs.set(keyFor(part, scopeKey), document);
  return document;
}

// Returns null rather than throwing when nothing has been built yet. "No analysis" is the
// normal state on a fresh install, not an error, and the tab renders an empty state for it.
export async function readAutomationPart(scopeKey, part) {
  const stored = await kvs
    .get(keyFor(part, scopeKey))
    .catch(fallbackOn("automation.part_read_failed", () => null, { scopeKey, part }));
  if (!stored || typeof stored !== "object") return null;
  // A document written by an older build may not have the fields the current UI reads.
  // Returning null lets the caller say "rebuild required" instead of rendering half a page.
  if (stored.schemaVersion !== 1) return null;
  return stored;
}

export function writeAutomationAnalysis(scopeKey, document) {
  return writeAutomationPart(scopeKey, "analysis", document);
}

export function readAutomationAnalysis(scopeKey) {
  return readAutomationPart(scopeKey, "analysis");
}

export async function clearAutomationAnalysis(scopeKey) {
  // Every part goes, not just the analysis. Leaving a stale field index behind would let
  // the Fields section render data from a build the estate no longer matches.
  await Promise.all(
    Object.keys(AUTOMATION_PARTS).map((part) =>
      kvs.delete(keyFor(part, scopeKey)).catch(fallbackOn("automation.part_clear_failed", () => null, { scopeKey, part }))
    )
  );
}

// ── Relational index ────────────────────────────────────────────────────────
//
// The three index documents moved to SQL; the `analysis` summary stays in KVS because it
// is small, read whole on first paint, and never joined. See core.js for why.
//
// Everything below writes rows the extraction module produced. automation-analysis.js is
// untouched by this and still imports nothing, so it keeps running in the browser bundle --
// the shredding happens here, on the resolver side, after the document arrives.

// Rows per statement. Deliberately below the RQT writer's 50: an automation reference row
// binds five params against that writer's three, and the ceiling that matters is total
// bound parameters per statement, not rows.
const REF_BATCH = 30;

async function replaceRows(scopeKey, table, columns, rows, batchSize) {
  await ensureProjectStoreReady();
  // Replace, never merge. A re-import describes the whole estate as it now stands, so a
  // reference that disappeared from the export must disappear here -- otherwise a rule
  // deleted in Jira keeps blocking a field deletion forever.
  await withSqlRetry(() =>
    sql.prepare(`DELETE FROM ${table} WHERE scope_key = ?`).bindParams(scopeKey).execute()
  );
  if (!rows?.length) return 0;

  const placeholder = `(${columns.map(() => "?").join(", ")})`;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    await withSqlRetry(() =>
      sql
        .prepare(
          `INSERT IGNORE INTO ${table} (${columns.join(", ")}) VALUES ${batch.map(() => placeholder).join(", ")}`
        )
        .bindParams(...batch.flat())
        .execute()
    );
  }
  return rows.length;
}

// Flatten an index document into one row per (label, rule, direction).
//
// This is where the caps stop applying: the document carried at most 50 rule ids per
// direction and 1,000 labels, and the true totals travelled beside them as separate
// counts. Rows have no such ceiling, so the count becomes derivable again rather than
// something the writer has to remember to preserve.
export function referenceRowsFrom(indexDocument, kind) {
  const rows = [];
  for (const entry of indexDocument?.entries ?? []) {
    const label = String(entry?.label ?? "").trim();
    if (!label) continue;
    for (const direction of ["write", "read", "trigger"]) {
      for (const ruleId of entry[direction] ?? []) {
        rows.push([kind, label, String(ruleId), direction]);
      }
    }
  }
  return rows;
}

export async function replaceAutomationReferences(scopeKey, { fields, statuses }) {
  const rows = [
    ...referenceRowsFrom(fields, "field"),
    ...referenceRowsFrom(statuses, "status"),
  ].map((row) => [scopeKey, ...row]);
  return replaceRows(
    scopeKey,
    "automation_references",
    ["scope_key", "kind", "label", "rule_id", "direction"],
    rows,
    REF_BATCH
  );
}

export async function replaceAutomationRules(scopeKey, directory) {
  // Stored as tuples rather than objects, because over 1,477 rules the repeated key names
  // cost more than the data. Positions: id, name, enabled, triggerType, projectCount.
  const rows = (directory?.rules ?? []).map(([id, name, enabled, triggerType, projectCount]) => [
    scopeKey,
    String(id),
    name ?? null,
    enabled ? 1 : 0,
    triggerType || null,
    Number(projectCount) || 0,
  ]);
  const written = await replaceRows(
    scopeKey,
    "automation_rules",
    ["scope_key", "rule_id", "name", "enabled", "trigger_type", "project_count"],
    rows,
    REF_BATCH
  );

  // The scope rows, from the same document. Written here rather than as their own import
  // part so a directory save can never leave the two disagreeing about which rules exist.
  const projectRows = [];
  for (const [ruleId, ...projectIds] of directory?.projects ?? []) {
    for (const projectId of projectIds) projectRows.push([scopeKey, String(ruleId), String(projectId)]);
  }
  const projectsWritten = await replaceRows(
    scopeKey,
    "automation_rule_projects",
    ["scope_key", "rule_id", "project_id"],
    projectRows,
    REF_BATCH
  );

  return written + projectsWritten;
}

// Site-wide rules with evidence that they actually act on one project.
//
// A rule scoped to the whole site applies to every project by definition, which makes
// "site-wide rules affecting this project" a useless list if it just means all of them.
// What makes it useful is evidence, and there is a real chain for it:
//
//   the rule WRITES a field  ->  that field has populated issues in THIS project
//                            ->  and those values changed recently
//
// Enabled rules only. A disabled rule cannot be updating anything, and listing one here
// under the heading "actively updating this project" would be plainly false.
//
// Two honest limits, both surfaced to the caller rather than buried:
//
//   1. automation_references stores the field NAME, not its id, so the join to the field
//      catalog is by name. This site has 34 groups of fields sharing a name, so a rule
//      writing "Owner" matches every field called "Owner". Over-matching, not under.
//   2. Recency comes from when the field's values last changed in this project, which is
//      evidence that SOMETHING wrote them -- not proof it was this rule. Jira exposes no
//      execution log to an app, so proof is not available at any price.
//
// It is inference. It is labelled as inference where it renders.
export async function loadGlobalRulesAffectingProject(scopeKey, version, projectId, { activeSinceDays = 90, limit = 25 } = {}) {
  await ensureProjectStoreReady();
  const capped = Math.max(1, Math.min(100, Math.trunc(Number(limit)) || 25));
  const since = new Date(Date.now() - Math.max(1, activeSinceDays) * 24 * 60 * 60 * 1000).toISOString();

  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT
        r.rule_id, r.name, r.trigger_type,
        COUNT(DISTINCT pu.field_id) AS fields_touched,
        SUM(pu.issue_count) AS issues_touched,
        MAX(pu.latest_field_change_at) AS last_change
      FROM automation_references ref
      JOIN automation_rules r
        ON r.scope_key = ref.scope_key AND r.rule_id = ref.rule_id
      JOIN snapshot_fields sf
        ON sf.scope_key = ref.scope_key AND sf.version = ? AND LOWER(sf.name) = LOWER(ref.label)
      JOIN snapshot_project_usage pu
        ON pu.scope_key = sf.scope_key AND pu.version = sf.version
       AND pu.field_id = sf.field_id AND pu.project_id = ?
      WHERE ref.scope_key = ?
        AND ref.kind = 'field'
        AND ref.direction = 'write'
        AND r.enabled = 1
        AND pu.issue_count > 0
        AND pu.latest_field_change_at IS NOT NULL
        AND pu.latest_field_change_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM automation_rule_projects arp
          WHERE arp.scope_key = ref.scope_key AND arp.rule_id = ref.rule_id
        )
      GROUP BY r.rule_id, r.name, r.trigger_type
      ORDER BY issues_touched DESC, r.rule_id ASC
      LIMIT ${capped}
    `).bindParams(version, String(projectId), scopeKey, since).execute()
  );

  return (result.rows || []).map((row) => ({
    ruleId: row.rule_id,
    name: row.name || row.rule_id,
    triggerType: row.trigger_type || null,
    // The evidence itself, so a reader can judge the inference rather than trust it.
    fieldsTouched: toNumber(row.fields_touched),
    issuesTouched: toNumber(row.issues_touched),
    lastChangeAt: row.last_change || null,
  }));
}

// Which rules touch one project, and how.
//
// The join the Projects tab needed and could not make. Site-wide rules are deliberately not
// returned: they apply to this project the way they apply to every project, and folding them
// in would make every project look like it carries the whole estate.
export async function loadRulesForProject(scopeKey, projectId, { limit = 100 } = {}) {
  await ensureProjectStoreReady();
  const capped = Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 100));

  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT r.rule_id, r.name, r.enabled, r.trigger_type
      FROM automation_rule_projects p
      JOIN automation_rules r
        ON r.scope_key = p.scope_key AND r.rule_id = p.rule_id
      WHERE p.scope_key = ? AND p.project_id = ?
      ORDER BY r.enabled DESC, r.name ASC
      LIMIT ${capped}
    `).bindParams(scopeKey, String(projectId)).execute()
  );

  return (result.rows || []).map((row) => ({
    ruleId: row.rule_id,
    name: row.name || row.rule_id,
    enabled: toNumber(row.enabled) === 1,
    triggerType: row.trigger_type || null,
  }));
}

export async function replaceAutomationFindings(scopeKey, findingsDocument) {
  const rows = [];
  for (const row of findingsDocument?.findings ?? []) {
    for (const finding of row?.r ?? []) {
      rows.push([
        scopeKey,
        String(row.id),
        String(finding.c),
        String(finding.s ?? "low"),
        finding.h ? JSON.stringify(finding.h) : null,
        Number.isFinite(finding.d) ? finding.d : null,
      ]);
    }
  }
  return replaceRows(
    scopeKey,
    "automation_findings",
    ["scope_key", "rule_id", "code", "severity", "hosts_json", "disabled_days"],
    rows,
    REF_BATCH
  );
}

// The join the whole pillar model wanted: one indexed query instead of five KVS reads and
// a string match over ~440 KB.
//
// Returns every reference, with the rule's name and state alongside. `total` is a count,
// not the length of a truncated array, so a caller can page without ever being told a
// smaller number than the truth.
export async function loadAutomationReferencesFor(scopeKey, kind, label, limit = 200) {
  await ensureProjectStoreReady();
  // Forge's SQL dialect will not bind LIMIT as a parameter, so it is interpolated -- which
  // makes coercing it to a bounded integer here the only thing standing between a caller
  // and an injection. project-store.schema.test.js asserts no query binds LIMIT at all.
  const cap = Math.max(1, Math.min(1000, Math.trunc(Number(limit)) || 200));
  const rows = await withSqlRetry(() =>
    sql
      .prepare(
        `SELECT r.direction, r.rule_id, a.name, a.enabled
           FROM automation_references r
           LEFT JOIN automation_rules a
             ON a.scope_key = r.scope_key AND a.rule_id = r.rule_id
          WHERE r.scope_key = ? AND r.kind = ? AND LOWER(r.label) = LOWER(?)
          ORDER BY r.direction, a.name
          LIMIT ${cap}`
      )
      .bindParams(scopeKey, kind, label)
      .execute()
  );
  const counted = await withSqlRetry(() =>
    sql
      .prepare(
        `SELECT COUNT(*) AS total, COUNT(DISTINCT rule_id) AS rules
           FROM automation_references
          WHERE scope_key = ? AND kind = ? AND LOWER(label) = LOWER(?)`
      )
      .bindParams(scopeKey, kind, label)
      .execute()
  );
  const summary = counted?.rows?.[0] || {};
  return {
    references: rows?.rows ?? [],
    total: Number(summary.total) || 0,
    ruleCount: Number(summary.rules) || 0,
  };
}
