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
  issueTypes: "automation:issueTypes:",
  users: "automation:users:",
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

// ── Cascades ────────────────────────────────────────────────────────────────
//
// Every edge, not the first 150.
//
// The cascade list lived in the analysis document under a MAX_STORED_CASCADES cap, which
// existed because the document has to fit in a KVS value. This site produces 1,457 edges,
// so the tab was showing roughly a tenth of them behind a "showing 150 of 1,457" footnote --
// and no amount of scrolling could reach the rest.
//
// The cap also made the multi-hop question unanswerable. A chain A -> B -> C -> D is found
// by walking the edge set, and a walk over a truncated edge set finds truncated chains: the
// graph code has existed and been tested since it was written, and could not be wired to
// anything because the data it needed was thrown away at import.

// Rows per statement. Four bound params per row against the reference writer's five, so a
// slightly larger batch stays inside the same bound-parameter ceiling.
const CASCADE_BATCH = 40;

// Flatten the import document into rows.
//
// Tuples on the wire -- [sourceId, targetId, field, selfTriggering] -- because over 1,457
// edges the repeated key names cost more than the values do.
export function cascadeRowsFrom(document) {
  const rows = [];
  const seen = new Set();
  for (const edge of document?.edges ?? []) {
    const [sourceId, targetId, field, selfTriggering] = edge ?? [];
    if (sourceId == null || targetId == null) continue;
    const label = String(field ?? "").slice(0, 191);
    if (!label) continue;
    // The primary key is (scope, source, target, field), so a duplicate tuple would make the
    // INSERT a no-op anyway -- dropping it here keeps the batch sizes honest.
    const key = `${sourceId}|${targetId}|${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([String(sourceId), String(targetId), label, selfTriggering ? 1 : 0]);
  }
  return rows;
}

export async function replaceAutomationCascades(scopeKey, document) {
  const rows = cascadeRowsFrom(document).map((row) => [scopeKey, ...row]);
  return replaceRows(
    scopeKey,
    "automation_cascades",
    ["scope_key", "source_rule_id", "target_rule_id", "field", "self_triggering"],
    rows,
    CASCADE_BATCH
  );
}

// Headline counts, from the rows rather than from a number the writer had to remember.
//
// `pairs` is the count that belongs on screen next to `edges`: two rules linked by three
// fields are one relationship an admin can break, not three.
export async function loadCascadeSummary(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT
        COUNT(*) AS edges,
        COUNT(DISTINCT CONCAT(source_rule_id, '>', target_rule_id)) AS pairs,
        COUNT(DISTINCT CASE WHEN self_triggering = 1 THEN source_rule_id END) AS self_rules,
        COUNT(DISTINCT field) AS fields
      FROM automation_cascades WHERE scope_key = ?
    `).bindParams(scopeKey).execute()
  );
  const row = result.rows?.[0] || {};
  return {
    edges: toNumber(row.edges),
    pairs: toNumber(row.pairs),
    selfTriggeringRules: toNumber(row.self_rules),
    fields: toNumber(row.fields),
  };
}

// One page of cascades, grouped into the relationship an admin acts on.
//
// Grouped in SQL rather than in the browser. The old view grouped a 150-row page
// client-side, which is only correct because the page WAS the whole stored set; grouping a
// page of a larger set would split one relationship across two pages and render it twice.
//
// `direction` decides which end `ruleId` binds to, which is the difference between "what
// does this rule wake" and "what wakes this rule" -- the second being the question an admin
// asks when a rule fires and they cannot see why.
export async function loadCascades(scopeKey, {
  search = "",
  kind = "all",
  ruleId = null,
  direction = "source",
  field = null,
  limit = 100,
  offset = 0,
} = {}) {
  await ensureProjectStoreReady();
  // Interpolated, never bound: Forge SQL rejects a placeholder in LIMIT/OFFSET. Coercing to
  // a bounded integer here is the only thing between a caller and an injection, and
  // project-store.schema.test.js asserts no query binds either.
  const cap = Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 100));
  const skip = Math.max(0, Math.min(100000, Math.trunc(Number(offset)) || 0));

  const where = ["c.scope_key = ?"];
  const params = [scopeKey];

  if (kind === "self") where.push("c.self_triggering = 1");
  else if (kind === "cross") where.push("c.self_triggering = 0");

  if (ruleId) {
    where.push(direction === "target" ? "c.target_rule_id = ?" : "c.source_rule_id = ?");
    params.push(String(ruleId));
  }
  if (field) {
    where.push("LOWER(c.field) = LOWER(?)");
    params.push(String(field));
  }
  // Matches a rule at either end as well as the field, because "what is Story Points caught
  // up in" and "what is this rule caught up in" are the same search box to a reader.
  if (search.trim()) {
    where.push("(LOWER(c.field) LIKE LOWER(?) OR LOWER(COALESCE(s.name, '')) LIKE LOWER(?) OR LOWER(COALESCE(t.name, '')) LIKE LOWER(?))");
    const term = `%${search.trim()}%`;
    params.push(term, term, term);
  }

  const from = `
    FROM automation_cascades c
    LEFT JOIN automation_rules s ON s.scope_key = c.scope_key AND s.rule_id = c.source_rule_id
    LEFT JOIN automation_rules t ON t.scope_key = c.scope_key AND t.rule_id = c.target_rule_id
    WHERE ${where.join(" AND ")}
  `;

  const rows = await withSqlRetry(() =>
    sql.prepare(`
      SELECT
        c.source_rule_id, c.target_rule_id, c.self_triggering,
        s.name AS source_name, s.enabled AS source_enabled,
        t.name AS target_name, t.enabled AS target_enabled,
        COUNT(*) AS field_count,
        GROUP_CONCAT(c.field ORDER BY c.field SEPARATOR '\u001f') AS fields
      ${from}
      GROUP BY c.source_rule_id, c.target_rule_id, c.self_triggering,
               s.name, s.enabled, t.name, t.enabled
      ORDER BY c.self_triggering DESC, field_count DESC, c.source_rule_id ASC, c.target_rule_id ASC
      LIMIT ${cap} OFFSET ${skip}
    `).bindParams(...params).execute()
  );

  // The total is a count of GROUPS, matching what the rows are. Counting edges here would
  // page a reader through a number they can never reach.
  const counted = await withSqlRetry(() =>
    sql.prepare(`
      SELECT COUNT(*) AS total FROM (
        SELECT 1 ${from}
        GROUP BY c.source_rule_id, c.target_rule_id
      ) grouped
    `).bindParams(...params).execute()
  );

  return {
    cascades: (rows.rows || []).map((row) => ({
      sourceId: row.source_rule_id,
      sourceName: row.source_name || row.source_rule_id,
      sourceEnabled: row.source_enabled == null ? null : toNumber(row.source_enabled) === 1,
      targetId: row.target_rule_id,
      targetName: row.target_name || row.target_rule_id,
      targetEnabled: row.target_enabled == null ? null : toNumber(row.target_enabled) === 1,
      selfTriggering: toNumber(row.self_triggering) === 1,
      fields: String(row.fields || "").split("\u001f").filter(Boolean),
      fieldCount: toNumber(row.field_count),
    })),
    total: toNumber(counted.rows?.[0]?.total),
  };
}

// Every edge, for the graph walk.
//
// Deliberately unpaged and deliberately narrow: loops and chains are properties of the WHOLE
// graph, and a walk over a page finds chains that stop at the page boundary. Only the three
// columns the walk needs are selected -- names are attached afterwards from the directory,
// so the edge set stays small enough to hold whatever the estate's size.
export async function loadCascadeEdges(scopeKey, { limit = 20000 } = {}) {
  await ensureProjectStoreReady();
  const cap = Math.max(1, Math.min(50000, Math.trunc(Number(limit)) || 20000));
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT c.source_rule_id, c.target_rule_id, c.field
      FROM automation_cascades c
      WHERE c.scope_key = ?
      ORDER BY c.source_rule_id, c.target_rule_id, c.field
      LIMIT ${cap}
    `).bindParams(scopeKey).execute()
  );
  return (result.rows || []).map((row) => ({
    sourceId: row.source_rule_id,
    targetId: row.target_rule_id,
    field: row.field,
  }));
}

// Names and states for a set of rule ids, so a chain reads as rule names rather than a walk
// of numeric ids. Chunked against the bind-parameter ceiling like every other IN-list here.
export async function loadRuleDirectoryFor(scopeKey, ruleIds = []) {
  await ensureProjectStoreReady();
  const ids = [...new Set((ruleIds || []).map((id) => String(id)).filter(Boolean))];
  if (!ids.length) return new Map();

  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const result = await withSqlRetry(() =>
      sql.prepare(`
        SELECT rule_id, name, enabled, trigger_type
        FROM automation_rules
        WHERE scope_key = ? AND rule_id IN (${batch.map(() => "?").join(", ")})
      `).bindParams(scopeKey, ...batch).execute()
    );
    for (const row of result.rows || []) {
      out.set(String(row.rule_id), {
        id: String(row.rule_id),
        name: row.name || String(row.rule_id),
        enabled: toNumber(row.enabled) === 1,
        triggerType: row.trigger_type || null,
      });
    }
  }
  return out;
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
// Which of these statuses an automation rule actually references.
//
// The Workflows tab has carried a blanket caveat since before the automation pillar
// existed: "Automation rules are not included. Jira does not expose them to Forge apps, so
// a rule could still reference a status shown here." That was true then. It has not been
// true since rule exports started being imported and shredded into automation_references,
// where every status a rule reads, writes or transitions to is a row.
//
// A warning that applies to every row tells a reader nothing about any row. This answers it
// per status, so "never used" can mean what it says -- and the statuses a rule DOES touch
// stop hiding inside a caveat nobody can act on.
//
// Batched: the unreachable list runs to 67 statuses on the reference site, and asking per
// status is 67 round trips to render one panel.
export async function loadStatusAutomationReferences(scopeKey, labels = []) {
  await ensureProjectStoreReady();
  const names = [...new Set((labels || []).map((l) => String(l || "").trim()).filter(Boolean))];
  if (!names.length) return {};

  const out = {};
  // Chunked against the bind-parameter ceiling, like every other IN-list in this codebase.
  for (let i = 0; i < names.length; i += 100) {
    const batch = names.slice(i, i + 100);
    const placeholders = batch.map(() => "LOWER(?)").join(", ");
    const result = await withSqlRetry(() =>
      sql.prepare(`
        SELECT LOWER(r.label) AS label,
               COUNT(DISTINCT r.rule_id) AS rule_count,
               COUNT(DISTINCT CASE WHEN a.enabled = 1 THEN r.rule_id END) AS enabled_count
        FROM automation_references r
        LEFT JOIN automation_rules a
          ON a.scope_key = r.scope_key AND a.rule_id = r.rule_id
        WHERE r.scope_key = ? AND r.kind = 'status' AND LOWER(r.label) IN (${placeholders})
        GROUP BY LOWER(r.label)
      `).bindParams(scopeKey, ...batch).execute()
    );
    for (const row of result.rows || []) {
      out[String(row.label)] = {
        ruleCount: toNumber(row.rule_count),
        enabledRuleCount: toNumber(row.enabled_count),
      };
    }
  }
  return out;
}

// ── Blast radius ───────────────────────────────────────────────────────────
//
// SQL-only, like the cascade edges: one row per rule, replaced wholesale on every import.
// The tier histogram the overview needs also rides in the KVS analysis document; these rows
// back the sortable per-rule list and the factor breakdown the drawer shows.

const BLAST_BATCH = 40;

export function blastRowsFrom(document) {
  const rows = [];
  const seen = new Set();
  for (const rule of document?.rules ?? []) {
    const id = String(rule?.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push([
      id,
      Math.max(0, Math.min(100, Math.trunc(Number(rule.score)) || 0)),
      String(rule.tier || "contained").slice(0, 20),
      rule.estimated ? 1 : 0,
      rule.credential ? 1 : 0,
      rule.factors
        ? JSON.stringify({ factors: rule.factors, modifiers: rule.modifiers ?? [] }).slice(0, 8000)
        : null,
    ]);
  }
  return rows;
}

export async function replaceAutomationBlast(scopeKey, document) {
  const rows = blastRowsFrom(document).map((row) => [scopeKey, ...row]);
  return replaceRows(
    scopeKey,
    "automation_rule_blast",
    ["scope_key", "rule_id", "score", "tier", "estimated", "credential", "factors_json"],
    rows,
    BLAST_BATCH
  );
}

// The tier histogram plus the two health inputs, counted from the rows rather than trusted
// from a number the writer had to carry.
export async function loadBlastSummary(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT tier,
             COUNT(*) AS n,
             SUM(CASE WHEN estimated = 1 THEN 1 ELSE 0 END) AS estimated_n,
             SUM(CASE WHEN tier = 'estate' AND credential = 1 THEN 1 ELSE 0 END) AS estate_cred_n
      FROM automation_rule_blast
      WHERE scope_key = ?
      GROUP BY tier
    `).bindParams(scopeKey).execute()
  );

  const byTier = { estate: 0, "cross-project": 0, project: 0, contained: 0 };
  let total = 0;
  let estimatedCount = 0;
  let estateWideCredentialCount = 0;
  for (const row of result.rows || []) {
    const n = toNumber(row.n);
    total += n;
    if (byTier[row.tier] === undefined) byTier[row.tier] = 0;
    byTier[row.tier] += n;
    estimatedCount += toNumber(row.estimated_n);
    estateWideCredentialCount += toNumber(row.estate_cred_n);
  }
  const estateWideCount = byTier.estate || 0;

  return {
    available: total > 0,
    total,
    byTier,
    estateWideCount,
    estateWideShare: total > 0 ? estateWideCount / total : 0,
    estateWideCredentialCount,
    estimatedCount,
  };
}

function parseBlastFactors(json) {
  if (!json) return { factors: [], modifiers: [] };
  try {
    const parsed = JSON.parse(json);
    return {
      factors: Array.isArray(parsed?.factors) ? parsed.factors : [],
      modifiers: Array.isArray(parsed?.modifiers) ? parsed.modifiers : [],
    };
  } catch {
    return { factors: [], modifiers: [] };
  }
}

// One page of rules ordered by blast score, most first, with the rule's name and state
// joined from the directory so the list reads as names rather than numeric ids.
export async function loadBlastRules(scopeKey, { tier = null, search = "", limit = 100, offset = 0 } = {}) {
  await ensureProjectStoreReady();
  // Interpolated, never bound: Forge SQL rejects a placeholder in LIMIT/OFFSET.
  const cap = Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 100));
  const skip = Math.max(0, Math.min(100000, Math.trunc(Number(offset)) || 0));

  const where = ["b.scope_key = ?"];
  const params = [scopeKey];
  if (tier && tier !== "all") {
    where.push("b.tier = ?");
    params.push(String(tier));
  }
  if (String(search).trim()) {
    where.push("LOWER(COALESCE(a.name, '')) LIKE LOWER(?)");
    params.push(`%${String(search).trim()}%`);
  }

  const from = `
    FROM automation_rule_blast b
    LEFT JOIN automation_rules a ON a.scope_key = b.scope_key AND a.rule_id = b.rule_id
    WHERE ${where.join(" AND ")}
  `;

  const rows = await withSqlRetry(() =>
    sql.prepare(`
      SELECT b.rule_id, b.score, b.tier, b.estimated, b.credential, b.factors_json,
             a.name AS rule_name, a.enabled AS rule_enabled, a.trigger_type
      ${from}
      ORDER BY b.score DESC, b.rule_id ASC
      LIMIT ${cap} OFFSET ${skip}
    `).bindParams(...params).execute()
  );

  const counted = await withSqlRetry(() =>
    sql.prepare(`SELECT COUNT(*) AS total ${from}`).bindParams(...params).execute()
  );

  return {
    rules: (rows.rows || []).map((row) => ({
      ruleId: String(row.rule_id),
      name: row.rule_name || String(row.rule_id),
      enabled: row.rule_enabled == null ? null : toNumber(row.rule_enabled) === 1,
      triggerType: row.trigger_type || null,
      score: toNumber(row.score),
      tier: row.tier || "contained",
      estimated: toNumber(row.estimated) === 1,
      credential: toNumber(row.credential) === 1,
      ...parseBlastFactors(row.factors_json),
    })),
    total: toNumber(counted.rows?.[0]?.total),
  };
}

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
