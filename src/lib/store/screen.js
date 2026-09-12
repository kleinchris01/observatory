// Screens, tabs, screen fields, and the two scheme layers above them.
//
// Split out like store/workflow.js; imports only from core.js, so there is one arrow and
// no cycle to reason about.
//
// The write path is a full replace per scope, matching replaceWorkflowSnapshot. Screens are
// a site-wide catalog with no resume path: the live measurement (CONNECT-4137) put a full
// pass at ~1,528 calls and ~4.9 minutes against a 900s consumer, so the build completes
// inside one invocation and never needs to append to a partial version.

import { sql } from "@forge/sql";
import {
  chunkArray,
  ensureProjectStoreReady,
  safeParseJson,
  toNumber,
  withSqlRetry,
} from "./core.js";

// Field rows dominate this snapshot -- ~22,000 on the reference site against ~760 screens
// and tens of schemes -- so they get their own smaller batch. Every row carries 7 bind
// params, and Forge SQL has a bind-parameter ceiling that a 50-row batch would approach.
const FIELD_BATCH_SIZE = 40;
const DEFAULT_BATCH_SIZE = 50;

export async function replaceScreenSnapshot(scopeKey, version, {
  screens = [],
  tabs = [],
  fields = [],
  screenSchemes = [],
  schemeOperations = [],
  issueTypeScreenSchemes = [],
  itssMappings = [],
  itssProjects = [],
} = {}) {
  await ensureProjectStoreReady();

  // Scoped deletes, every one of them. An unscoped DELETE in a multi-tenant Forge app
  // destroys another customer's data, and project-store.writes.test.js asserts this
  // mechanically rather than trusting review to catch it.
  for (const table of [
    "snapshot_screens",
    "snapshot_screen_tabs",
    "snapshot_screen_fields",
    "snapshot_screen_schemes",
    "snapshot_screen_scheme_operations",
    "snapshot_issue_type_screen_schemes",
    "snapshot_itss_mappings",
    "snapshot_itss_projects",
  ]) {
    await withSqlRetry(() =>
      sql.prepare(`DELETE FROM ${table} WHERE scope_key = ?`).bindParams(scopeKey).execute()
    );
  }

  for (const batch of chunkArray(screens, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((s) => [
      scopeKey, version, String(s.id), s.name || null, s.description || null,
      s.tabCount ?? 0, s.fieldCount ?? 0,
      s.tabsResolved || "resolved", s.unresolvedReason || null,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_screens
          (scope_key, version, screen_id, name, description, tab_count, field_count, tabs_resolved, unresolved_reason)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(tabs, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((t) => [
      scopeKey, version, String(t.screenId), String(t.tabId),
      t.name || null, t.tabIndex ?? 0, t.fieldCount ?? 0,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_screen_tabs
          (scope_key, version, screen_id, tab_id, name, tab_index, field_count)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(fields, FIELD_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((f) => [
      scopeKey, version, String(f.screenId), String(f.tabId), String(f.fieldId),
      f.fieldName || null, f.tabIndex ?? 0, f.fieldIndex ?? 0,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_screen_fields
          (scope_key, version, screen_id, tab_id, field_id, field_name, tab_index, field_index)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(screenSchemes, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((s) => [
      scopeKey, version, String(s.id), s.name || null, s.description || null,
      JSON.stringify(s.screens || null),
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_screen_schemes
          (scope_key, version, scheme_id, name, description, screens_json)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(schemeOperations, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((op) => [
      scopeKey, version, String(op.schemeId), op.operation,
      op.screenId == null ? null : String(op.screenId),
      op.inherited ? 1 : 0, op.dangling ? 1 : 0,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_screen_scheme_operations
          (scope_key, version, scheme_id, operation, screen_id, inherited, dangling)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(issueTypeScreenSchemes, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((s) => [
      scopeKey, version, String(s.id), s.name || null, s.description || null, s.projectCount ?? 0,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_issue_type_screen_schemes
          (scope_key, version, itss_id, name, description, project_count)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(itssMappings, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((m) => [
      scopeKey, version, String(m.itssId), String(m.issueTypeId),
      m.screenSchemeId == null ? null : String(m.screenSchemeId),
      m.isDefault ? 1 : 0,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_itss_mappings
          (scope_key, version, itss_id, issue_type_id, screen_scheme_id, is_default)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }

  for (const batch of chunkArray(itssProjects, DEFAULT_BATCH_SIZE)) {
    const valuesSql = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((p) => [
      scopeKey, version, String(p.itssId), String(p.projectId),
      p.projectKey || null, p.projectName || null,
    ]);
    await withSqlRetry(() =>
      sql.prepare(`
        INSERT INTO snapshot_itss_projects
          (scope_key, version, itss_id, project_id, project_key, project_name)
        VALUES ${valuesSql}
      `).bindParams(...params).execute()
    );
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

// Sort tokens the Screens tab may ask for, mapped to ORDER BY fragments.
//
// A whitelist, not an interpolation. The token arrives from the browser, and the one thing
// that must never happen is a caller-supplied string reaching ORDER BY -- the LIMIT clause
// two lines below is interpolated for a Forge SQL reason, so this file already sits close
// enough to that mistake.
//
// Every ordering ends in a unique tiebreak on screen_id. Without one, rows with equal field
// counts can be returned in a different order per page, so paging a 760-screen catalog
// silently shows some screens twice and skips others.
const SCREEN_SORTS = {
  "fields-desc": "field_count DESC, name ASC, screen_id ASC",
  "fields-asc": "field_count ASC, name ASC, screen_id ASC",
  "name-asc": "name ASC, screen_id ASC",
  "name-desc": "name DESC, screen_id ASC",
  "tabs-desc": "tab_count DESC, field_count DESC, screen_id ASC",
  "id-asc": "CAST(screen_id AS UNSIGNED) ASC, screen_id ASC",
  // Unreadable screens first: they are the ones capping every other number on the tab.
  "unresolved-first": "CASE WHEN tabs_resolved <> 'resolved' THEN 0 ELSE 1 END ASC, field_count DESC, screen_id ASC",
};
export const DEFAULT_SCREEN_SORT = "fields-desc";
export const SCREEN_SORT_KEYS = Object.keys(SCREEN_SORTS);

// Which screens a finding is about, as a WHERE clause.
//
// The Overview counts these -- "252 screens nothing reaches" -- and until now clicking that
// count opened the Screens tab at page one of 746, leaving the reader to find the 252 by
// hand. There is no per-screen reachability column to filter on, because reachability is a
// question about two other tables, so each filter is the same NOT EXISTS pair the governance
// summary already counts with.
//
// Keyed by the finding rather than by the shape of the query, so the Overview asks for what
// it named on screen and cannot ask for something the summary does not count.
export const SCREEN_FILTERS = {
  // Read successfully and found to have nothing on them. Unreadable screens are excluded:
  // a screen whose contents could not be read is unmeasured, not empty.
  empty: {
    label: "Carrying no fields",
    where: () => ({ sql: "field_count = 0 AND tabs_resolved = 'resolved'", params: [] }),
  },
  // The build could not see them at all, so they cap every other figure on the tab.
  unresolved: {
    label: "Contents could not be read",
    where: () => ({ sql: "tabs_resolved <> 'resolved'", params: [] }),
  },
  // No scheme routes to them AND no transition opens them. Needs the workflow snapshot;
  // without it the claim is unknowable rather than false, so the filter refuses to apply.
  unreached: {
    label: "Nothing reaches them",
    needsWorkflow: true,
    where: (workflowVersion) => ({
      sql: `NOT EXISTS (
              SELECT 1 FROM snapshot_screen_scheme_operations o
              WHERE o.scope_key = snapshot_screens.scope_key AND o.version = snapshot_screens.version
                AND o.screen_id = snapshot_screens.screen_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM snapshot_transition_screens t
              WHERE t.scope_key = snapshot_screens.scope_key AND t.version = ?
                AND t.screen_id = snapshot_screens.screen_id
            )`,
      params: [workflowVersion],
    }),
  },
  // The correction to the finding above: no scheme names them, but a transition opens them
  // every time somebody moves an issue. Do not delete these.
  "transition-only": {
    label: "Opened only by a workflow transition",
    needsWorkflow: true,
    where: (workflowVersion) => ({
      sql: `NOT EXISTS (
              SELECT 1 FROM snapshot_screen_scheme_operations o
              WHERE o.scope_key = snapshot_screens.scope_key AND o.version = snapshot_screens.version
                AND o.screen_id = snapshot_screens.screen_id
            )
            AND EXISTS (
              SELECT 1 FROM snapshot_transition_screens t
              WHERE t.scope_key = snapshot_screens.scope_key AND t.version = ?
                AND t.screen_id = snapshot_screens.screen_id
            )`,
      params: [workflowVersion],
    }),
  },
};

export const SCREEN_FILTER_KEYS = Object.keys(SCREEN_FILTERS);

export async function loadScreensPage(scopeKey, version, { limit = 50, offset = 0, search = "", sort = DEFAULT_SCREEN_SORT, filter = null, workflowVersion = null } = {}) {
  await ensureProjectStoreReady();

  const safeLimit = Math.max(1, Math.min(200, Math.trunc(Number(limit)) || 50));
  const safeOffset = Math.max(0, Math.trunc(Number(offset)) || 0);
  const orderBy = SCREEN_SORTS[String(sort || "").trim()] || SCREEN_SORTS[DEFAULT_SCREEN_SORT];

  // Unqualified here, because the reachability sub-selects correlate on the outer table by
  // name and an alias would have to be threaded through all four of them.
  const where = ["scope_key = ?", "version = ?"];
  const params = [scopeKey, version];
  const term = String(search || "").trim();
  if (term) {
    where.push("(name LIKE ? OR screen_id LIKE ?)");
    params.push(`%${term}%`, `%${term}%`);
  }

  // An unknown filter is ignored rather than rejected: this is a read path reached from a
  // deep link, and a stale link should show the unfiltered tab rather than an error page.
  // A filter that needs the workflow snapshot is dropped when there is not one -- "we
  // cannot tell" must never render as "none", which is the rule the whole pillar follows.
  const requested = SCREEN_FILTERS[String(filter || "").trim()];
  const applied = requested && (!requested.needsWorkflow || workflowVersion) ? requested : null;
  if (applied) {
    const clause = applied.where(workflowVersion);
    where.push(`(${clause.sql})`);
    params.push(...clause.params);
  }

  const countResult = await withSqlRetry(() =>
    sql.prepare(`SELECT COUNT(*) AS total FROM snapshot_screens WHERE ${where.join(" AND ")}`)
      .bindParams(...params).execute()
  );

  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT screen_id, name, description, tab_count, field_count, tabs_resolved, unresolved_reason
      FROM snapshot_screens
      WHERE ${where.join(" AND ")}
      ORDER BY ${orderBy}
      LIMIT ${safeLimit} OFFSET ${safeOffset}
    `).bindParams(...params).execute()
  );

  return {
    total: toNumber(countResult.rows?.[0]?.total, 0),
    rows: (result.rows || []).map(mapScreenRow),
    // What was actually applied, which is not always what was asked for. A reachability
    // filter with no workflow snapshot behind it is dropped, and a tab that rendered the
    // whole catalogue while claiming to show 252 unreachable screens would be worse than
    // one that says the filter could not be applied.
    filter: applied ? String(filter).trim() : null,
    filterLabel: applied ? applied.label : null,
    filterRequested: requested ? String(filter).trim() : null,
  };
}

function mapScreenRow(row) {
  return {
    screenId: row.screen_id,
    name: row.name || row.screen_id,
    description: row.description || "",
    tabCount: toNumber(row.tab_count),
    fieldCount: toNumber(row.field_count),
    // Never collapsed to a boolean. "resolved", "unresolved" and the reason behind the
    // second are three different facts, and a finding built on the wrong one is worse
    // than no finding.
    tabsResolved: row.tabs_resolved || "resolved",
    unresolvedReason: row.unresolved_reason || null,
  };
}

export async function loadScreenFields(scopeKey, version, screenId) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT tab_id, field_id, field_name, tab_index, field_index
      FROM snapshot_screen_fields
      WHERE scope_key = ? AND version = ? AND screen_id = ?
      ORDER BY tab_index ASC, field_index ASC
    `).bindParams(scopeKey, version, String(screenId)).execute()
  );
  return (result.rows || []).map((row) => ({
    tabId: row.tab_id,
    fieldId: row.field_id,
    fieldName: row.field_name || row.field_id,
    tabIndex: toNumber(row.tab_index),
    fieldIndex: toNumber(row.field_index),
  }));
}

// Which screens carry one field. The reverse direction of the same table, and the read the
// field detail panel needs -- served by idx_snapshot_screen_fields_field rather than a scan.
export async function loadScreensForField(scopeKey, version, fieldId) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT f.screen_id, f.tab_id, f.tab_index, f.field_index, s.name AS screen_name
      FROM snapshot_screen_fields f
      LEFT JOIN snapshot_screens s
        ON s.scope_key = f.scope_key AND s.version = f.version AND s.screen_id = f.screen_id
      WHERE f.scope_key = ? AND f.version = ? AND f.field_id = ?
      ORDER BY s.name ASC
    `).bindParams(scopeKey, version, String(fieldId)).execute()
  );
  return (result.rows || []).map((row) => ({
    screenId: row.screen_id,
    screenName: row.screen_name || row.screen_id,
    tabId: row.tab_id,
    tabIndex: toNumber(row.tab_index),
    fieldIndex: toNumber(row.field_index),
  }));
}

// A handful of named screens, with the field list on each -- one query, not one per screen.
//
// The "build a field report from these screens" flow needs both the field union and enough
// per-screen metadata to tell a caller which of its chosen screens the build could not read
// (tabs_resolved) so the report can say the list may be incomplete rather than silently
// dropping them.
export async function loadScreensWithFieldsByIds(scopeKey, version, screenIds = []) {
  await ensureProjectStoreReady();
  const ids = [...new Set((screenIds || []).map((v) => String(v || "").trim()).filter(Boolean))];
  if (!ids.length) return [];

  const byId = new Map();
  for (const batch of chunkArray(ids, 100)) {
    const placeholders = batch.map(() => "?").join(", ");
    const metaRows = await withSqlRetry(() =>
      sql.prepare(`
        SELECT screen_id, name, field_count, tabs_resolved
        FROM snapshot_screens
        WHERE scope_key = ? AND version = ? AND screen_id IN (${placeholders})
      `).bindParams(scopeKey, version, ...batch).execute()
    );
    for (const row of metaRows.rows || []) {
      byId.set(String(row.screen_id), {
        screenId: String(row.screen_id),
        name: row.name || String(row.screen_id),
        fieldCount: toNumber(row.field_count),
        tabsResolved: row.tabs_resolved || "resolved",
        fields: [],
      });
    }

    const fieldRows = await withSqlRetry(() =>
      sql.prepare(`
        SELECT screen_id, field_id, field_name, tab_index, field_index
        FROM snapshot_screen_fields
        WHERE scope_key = ? AND version = ? AND screen_id IN (${placeholders})
        ORDER BY tab_index ASC, field_index ASC
      `).bindParams(scopeKey, version, ...batch).execute()
    );
    for (const row of fieldRows.rows || []) {
      const screen = byId.get(String(row.screen_id));
      if (!screen) continue;
      screen.fields.push({ fieldId: row.field_id, fieldName: row.field_name || row.field_id });
    }
  }

  // Preserve the caller's order, drop ids that resolved to nothing.
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

// Screen counts for a page of fields, in one pass rather than one query per card.
//
// The Field Browser renders 25-50 cards at a time and each wants "how many screens carry
// this field". Asking per card is 50 round trips against a table with 22,000 rows on the
// reference site; grouping the whole page into one IN-list is one, served by
// idx_snapshot_screen_fields_field.
//
// Returns a plain object keyed by field id, and omits fields on no screen rather than
// writing 0 -- the caller distinguishes "on no screen" from "not asked about" by presence,
// and a 0 written here would be indistinguishable from a field the page did not include.
export async function loadScreenCountsForFields(scopeKey, version, fieldIds = []) {
  await ensureProjectStoreReady();
  const ids = [...new Set((fieldIds || []).map((id) => String(id)).filter(Boolean))];
  if (!ids.length) return {};

  const counts = {};
  // Chunked for the same bind-parameter ceiling the write path batches against; each id is
  // one param, plus the two for scope and version.
  for (const batch of chunkArray(ids, 100)) {
    const placeholders = batch.map(() => "?").join(", ");
    const result = await withSqlRetry(() =>
      sql.prepare(`
        SELECT field_id, COUNT(DISTINCT screen_id) AS screen_count
        FROM snapshot_screen_fields
        WHERE scope_key = ? AND version = ? AND field_id IN (${placeholders})
        GROUP BY field_id
      `).bindParams(scopeKey, version, ...batch).execute()
    );
    for (const row of result.rows || []) {
      counts[row.field_id] = toNumber(row.screen_count);
    }
  }
  return counts;
}

export async function loadScreenSchemes(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT scheme_id, name, description, screens_json
      FROM snapshot_screen_schemes
      WHERE scope_key = ? AND version = ?
      ORDER BY name ASC
    `).bindParams(scopeKey, version).execute()
  );
  // How many issue type screen schemes map to each one.
  //
  // A screen scheme nothing maps to cannot route anything to a project, which the governance
  // summary already counts -- and the Screens tab could not filter to, because the mapping
  // layer was only ever sent as a separate list without the join. Counted here so the tab can
  // narrow to the exact schemes that count was about.
  const mapped = await withSqlRetry(() =>
    sql.prepare(`
      SELECT screen_scheme_id, COUNT(DISTINCT itss_id) AS itss_count
      FROM snapshot_itss_mappings
      WHERE scope_key = ? AND version = ? AND screen_scheme_id IS NOT NULL
      GROUP BY screen_scheme_id
    `).bindParams(scopeKey, version).execute()
  );
  const itssCounts = new Map((mapped.rows || []).map((row) => [String(row.screen_scheme_id), toNumber(row.itss_count)]));

  return (result.rows || []).map((row) => ({
    schemeId: row.scheme_id,
    name: row.name || row.scheme_id,
    description: row.description || "",
    screens: safeParseJson(row.screens_json, null),
    // 0 means no issue type screen scheme references it, which is the "unused scheme"
    // finding on the Overview.
    issueTypeSchemeCount: itssCounts.get(String(row.scheme_id)) ?? 0,
  }));
}

export async function loadScreenSchemeOperations(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT scheme_id, operation, screen_id, inherited, dangling
      FROM snapshot_screen_scheme_operations
      WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    schemeId: row.scheme_id,
    operation: row.operation,
    screenId: row.screen_id,
    inherited: Boolean(toNumber(row.inherited)),
    dangling: Boolean(toNumber(row.dangling)),
  }));
}

export async function loadIssueTypeScreenSchemes(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT itss_id, name, description, project_count
      FROM snapshot_issue_type_screen_schemes
      WHERE scope_key = ? AND version = ?
      ORDER BY project_count DESC, name ASC
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    itssId: row.itss_id,
    name: row.name || row.itss_id,
    description: row.description || "",
    projectCount: toNumber(row.project_count),
  }));
}

export async function loadItssMappings(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT itss_id, issue_type_id, screen_scheme_id, is_default
      FROM snapshot_itss_mappings
      WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    itssId: row.itss_id,
    issueTypeId: row.issue_type_id,
    screenSchemeId: row.screen_scheme_id,
    isDefault: Boolean(toNumber(row.is_default)),
  }));
}

export async function loadItssProjects(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT itss_id, project_id, project_key, project_name
      FROM snapshot_itss_projects
      WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()
  );
  return (result.rows || []).map((row) => ({
    itssId: row.itss_id,
    projectId: row.project_id,
    projectKey: row.project_key || "",
    projectName: row.project_name || "",
  }));
}

// Rates for the site health score and the overview findings, computed as aggregates rather
// than by loading the catalog. The field table alone is ~22,000 rows on the reference site;
// pulling it into a Lambda to count four things would cost more than the build did.
//
// Every count is scoped and versioned like the reads above. Screens whose contents could not
// be read are counted separately and never folded into "empty" -- a screen we failed to
// measure and a screen with no fields on it are opposite claims, and only one is a finding.
// `workflowVersion` is the WORKFLOW snapshot's version, not this one. The two pillars
// rebuild on their own cadences, so the caller resolves each version and passes both.
//
// Without it, "unreached" cannot be computed at all -- and is returned as null rather than
// as a number, because a screen opened by a workflow transition is in daily use while
// belonging to no screen scheme. Counting it as unreached is not a rounding error; it is
// the premise for deleting a screen people are using every day.
export async function loadScreenGovernanceSummary(scopeKey, version, { workflowVersion = null } = {}) {
  await ensureProjectStoreReady();

  const screenTotals = await withSqlRetry(() =>
    sql.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN tabs_resolved = 'resolved' AND field_count = 0 THEN 1 ELSE 0 END) AS empty_screens,
        SUM(CASE WHEN tabs_resolved <> 'resolved' THEN 1 ELSE 0 END) AS unresolved_screens
      FROM snapshot_screens
      WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()
  );

  // NOT EXISTS rather than (total - COUNT(DISTINCT screen_id)): a scheme operation can point
  // at a screen id the catalog does not contain, so the distinct count includes ids that are
  // not screens and the subtraction would under-report unreached screens.
  // Two routes reach a screen, and both have to be excluded before it can be called
  // unreached: the scheme chain, and a workflow transition that opens it. Queried across
  // pillars in SQL rather than by importing the workflow store, so this module still has
  // exactly one import arrow.
  const unreached = workflowVersion
    ? await withSqlRetry(() =>
      sql.prepare(`
        SELECT COUNT(*) AS unreached
        FROM snapshot_screens s
        WHERE s.scope_key = ? AND s.version = ?
          AND NOT EXISTS (
            SELECT 1 FROM snapshot_screen_scheme_operations o
            WHERE o.scope_key = s.scope_key AND o.version = s.version AND o.screen_id = s.screen_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM snapshot_transition_screens t
            WHERE t.scope_key = s.scope_key AND t.version = ? AND t.screen_id = s.screen_id
          )
      `).bindParams(scopeKey, version, workflowVersion).execute()
    )
    : null;

  // Screens reached ONLY by a transition. Reported in its own right rather than folded
  // away: these are exactly the screens the scheme-only view called unreachable, and an
  // admin who was told to clean them up needs to see the correction.
  const transitionOnly = workflowVersion
    ? await withSqlRetry(() =>
      sql.prepare(`
        SELECT COUNT(*) AS transition_only
        FROM snapshot_screens s
        WHERE s.scope_key = ? AND s.version = ?
          AND NOT EXISTS (
            SELECT 1 FROM snapshot_screen_scheme_operations o
            WHERE o.scope_key = s.scope_key AND o.version = s.version AND o.screen_id = s.screen_id
          )
          AND EXISTS (
            SELECT 1 FROM snapshot_transition_screens t
            WHERE t.scope_key = s.scope_key AND t.version = ? AND t.screen_id = s.screen_id
          )
      `).bindParams(scopeKey, version, workflowVersion).execute()
    )
    : null;

  const operations = await withSqlRetry(() =>
    sql.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN dangling = 1 THEN 1 ELSE 0 END) AS dangling
      FROM snapshot_screen_scheme_operations
      WHERE scope_key = ? AND version = ?
    `).bindParams(scopeKey, version).execute()
  );

  // A screen scheme no issue-type screen scheme maps to cannot route anything to a project.
  const schemes = await withSqlRetry(() =>
    sql.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN NOT EXISTS (
          SELECT 1 FROM snapshot_itss_mappings m
          WHERE m.scope_key = s.scope_key AND m.version = s.version AND m.screen_scheme_id = s.scheme_id
        ) THEN 1 ELSE 0 END) AS unused
      FROM snapshot_screen_schemes s
      WHERE s.scope_key = ? AND s.version = ?
    `).bindParams(scopeKey, version).execute()
  );

  const screenRow = screenTotals.rows?.[0] || {};
  const operationRow = operations.rows?.[0] || {};
  const schemeRow = schemes.rows?.[0] || {};

  return {
    totalScreens: toNumber(screenRow.total),
    emptyScreens: toNumber(screenRow.empty_screens),
    unresolvedScreens: toNumber(screenRow.unresolved_screens),
    // null, never 0, when no workflow snapshot exists. Every consumer treats null as
    // "cannot say" and suppresses the finding rather than reporting a clean site.
    unreachedScreens: unreached ? toNumber(unreached.rows?.[0]?.unreached) : null,
    transitionOnlyScreens: transitionOnly ? toNumber(transitionOnly.rows?.[0]?.transition_only) : null,
    transitionsKnown: Boolean(workflowVersion),
    totalOperations: toNumber(operationRow.total),
    danglingOperations: toNumber(operationRow.dangling),
    totalSchemes: toNumber(schemeRow.total),
    unusedSchemes: toNumber(schemeRow.unused),
  };
}

// Chart data for the Screens overview, as aggregates.
//
// Every one of these is a GROUP BY rather than a page of rows pulled into the Lambda and
// counted there. The field table alone is ~22,000 rows on the reference site; the overview
// is a glance, and a glance should not cost more than the tab it summarises.
export async function loadScreenDistributions(scopeKey, version, { topN = 10 } = {}) {
  await ensureProjectStoreReady();
  const capped = Math.max(1, Math.min(50, Math.trunc(Number(topN)) || 10));

  // Size distribution. Buckets rather than a raw histogram: "how many screens are enormous"
  // is the question, and 760 distinct field counts is not an answer anyone can read.
  const sizes = await withSqlRetry(() =>
    sql.prepare(`
      SELECT
        CASE
          WHEN field_count = 0 THEN 'Empty'
          WHEN field_count BETWEEN 1 AND 5 THEN '1-5 fields'
          WHEN field_count BETWEEN 6 AND 15 THEN '6-15 fields'
          WHEN field_count BETWEEN 16 AND 30 THEN '16-30 fields'
          WHEN field_count BETWEEN 31 AND 60 THEN '31-60 fields'
          ELSE '60+ fields'
        END AS bucket,
        COUNT(*) AS screens
      FROM snapshot_screens
      WHERE scope_key = ? AND version = ? AND tabs_resolved = 'resolved'
      GROUP BY bucket
    `).bindParams(scopeKey, version).execute()
  );

  const largest = await withSqlRetry(() =>
    sql.prepare(`
      SELECT name, screen_id, field_count
      FROM snapshot_screens
      WHERE scope_key = ? AND version = ? AND tabs_resolved = 'resolved'
      ORDER BY field_count DESC, screen_id ASC
      LIMIT ${capped}
    `).bindParams(scopeKey, version).execute()
  );

  // Which fields appear on the most forms. The reverse of the catalog, and the one that
  // says where a field change is felt: a field on 200 screens is not a local edit.
  const shared = await withSqlRetry(() =>
    sql.prepare(`
      SELECT field_name, field_id, COUNT(DISTINCT screen_id) AS screens
      FROM snapshot_screen_fields
      WHERE scope_key = ? AND version = ?
      GROUP BY field_id, field_name
      ORDER BY screens DESC, field_id ASC
      LIMIT ${capped}
    `).bindParams(scopeKey, version).execute()
  );

  const operations = await withSqlRetry(() =>
    sql.prepare(`
      SELECT operation, COUNT(*) AS mappings
      FROM snapshot_screen_scheme_operations
      WHERE scope_key = ? AND version = ?
      GROUP BY operation
      ORDER BY mappings DESC
    `).bindParams(scopeKey, version).execute()
  );

  return {
    sizeBuckets: (sizes.rows || []).map((r) => ({ bucket: r.bucket, screens: toNumber(r.screens) })),
    largestScreens: (largest.rows || []).map((r) => ({
      name: r.name || r.screen_id, screenId: r.screen_id, fieldCount: toNumber(r.field_count),
    })),
    mostSharedFields: (shared.rows || []).map((r) => ({
      name: r.field_name || r.field_id, fieldId: r.field_id, screens: toNumber(r.screens),
    })),
    operationMix: (operations.rows || []).map((r) => ({ operation: r.operation, mappings: toNumber(r.mappings) })),
  };
}

// Which screens a project actually routes to, by walking the whole chain in one query.
//
// project -> issue type screen scheme -> screen scheme -> operation -> screen. Five tables,
// and every hop is the reason the scopes list in manifest.yml is as long as it is. Done in
// SQL because doing it in the Lambda means loading every mapping on the site to answer a
// question about one project.
//
// DISTINCT on the screen: a project reaching one screen through three issue types is one
// form its users see, not three.
export async function loadScreensForProject(scopeKey, version, projectId) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT DISTINCT s.screen_id, s.name, s.field_count, s.tab_count, s.tabs_resolved
      FROM snapshot_itss_projects p
      JOIN snapshot_itss_mappings m
        ON m.scope_key = p.scope_key AND m.version = p.version AND m.itss_id = p.itss_id
      JOIN snapshot_screen_scheme_operations o
        ON o.scope_key = m.scope_key AND o.version = m.version AND o.scheme_id = m.screen_scheme_id
      JOIN snapshot_screens s
        ON s.scope_key = o.scope_key AND s.version = o.version AND s.screen_id = o.screen_id
      WHERE p.scope_key = ? AND p.version = ? AND p.project_id = ?
      ORDER BY s.field_count DESC, s.screen_id ASC
    `).bindParams(scopeKey, version, String(projectId)).execute()
  );

  return (result.rows || []).map((row) => ({
    screenId: row.screen_id,
    name: row.name || row.screen_id,
    fieldCount: toNumber(row.field_count),
    tabCount: toNumber(row.tab_count),
    // Carried so a caller never reports "0 fields" for a screen the build could not read.
    tabsResolved: row.tabs_resolved || "resolved",
  }));
}

// ── Meta ─────────────────────────────────────────────────────────────────────

export async function readScreenSnapshotMeta(scopeKey) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT state, version, started_at, completed_at, refreshed_at,
             total_screens, total_schemes, unresolved_screens, last_error
      FROM screen_snapshot_meta WHERE scope_key = ?
    `).bindParams(scopeKey).execute()
  );
  const row = result.rows?.[0];
  if (!row) return null;
  return {
    state: row.state || "idle",
    version: row.version || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    refreshedAt: row.refreshed_at || null,
    totalScreens: toNumber(row.total_screens),
    totalSchemes: toNumber(row.total_schemes),
    unresolvedScreens: toNumber(row.unresolved_screens),
    lastError: row.last_error || null,
  };
}

// Merge-patch over the current row, like writeWorkflowSnapshotMeta: callers patch the two
// or three fields they own and never have to restate the rest.
export async function writeScreenSnapshotMeta(scopeKey, patch = {}) {
  await ensureProjectStoreReady();
  const current = (await readScreenSnapshotMeta(scopeKey)) || {};
  const next = { ...current, ...patch };

  await withSqlRetry(() =>
    sql.prepare(`
      INSERT INTO screen_snapshot_meta
        (scope_key, state, version, started_at, completed_at, refreshed_at,
         total_screens, total_schemes, unresolved_screens, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        state = VALUES(state),
        version = VALUES(version),
        started_at = VALUES(started_at),
        completed_at = VALUES(completed_at),
        refreshed_at = VALUES(refreshed_at),
        total_screens = VALUES(total_screens),
        total_schemes = VALUES(total_schemes),
        unresolved_screens = VALUES(unresolved_screens),
        last_error = VALUES(last_error)
    `).bindParams(
      scopeKey,
      next.state || "idle",
      next.version || null,
      next.startedAt || null,
      next.completedAt || null,
      next.refreshedAt || null,
      next.totalScreens ?? 0,
      next.totalSchemes ?? 0,
      next.unresolvedScreens ?? 0,
      next.lastError || null
    ).execute()
  );
}

// ── Field reachability, per project ──────────────────────────────────────────
//
// Walks the whole chain in one query -- project -> issue type screen scheme -> screen
// scheme -> screen -> field -- and folds it to one row per (project, field) carrying which
// operations reach it. This is the input the cross-signal findings need: on its own the
// screen inventory says what a form contains, and the field snapshot says where values
// exist, but neither can say whether the two agree.
//
// Aggregated in SQL rather than returned raw. The unfolded join is every screen-field
// multiplied by every project that reaches that screen, which on a site where one screen
// serves forty projects is an order of magnitude more rows than the answer needs.
//
// `unresolved` counts the screens in a project's chain whose tab walk failed. A project
// with any is excluded from both findings by the caller -- "this field is not on a screen
// here" is the premise of a delete recommendation, and it cannot be made from a chain that
// was only partly read.
export async function loadFieldReachabilityByProject(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT
        p.project_id,
        sf.field_id,
        MAX(CASE WHEN o.operation = 'create' THEN 1 ELSE 0 END) AS on_create,
        MAX(CASE WHEN o.operation = 'edit'   THEN 1 ELSE 0 END) AS on_edit,
        MAX(CASE WHEN o.operation = 'view'   THEN 1 ELSE 0 END) AS on_view
      FROM snapshot_itss_projects p
      JOIN snapshot_itss_mappings m
        ON m.scope_key = p.scope_key AND m.version = p.version AND m.itss_id = p.itss_id
      JOIN snapshot_screen_scheme_operations o
        ON o.scope_key = m.scope_key AND o.version = m.version AND o.scheme_id = m.screen_scheme_id
      JOIN snapshot_screen_fields sf
        ON sf.scope_key = o.scope_key AND sf.version = o.version AND sf.screen_id = o.screen_id
      WHERE p.scope_key = ? AND p.version = ?
      GROUP BY p.project_id, sf.field_id
    `).bindParams(scopeKey, version).execute()
  );

  return (result.rows || []).map((row) => ({
    projectId: String(row.project_id),
    fieldId: String(row.field_id),
    onCreate: Boolean(toNumber(row.on_create)),
    onEdit: Boolean(toNumber(row.on_edit)),
    onView: Boolean(toNumber(row.on_view)),
  }));
}

// How much of each project's screen chain the last build could actually read.
//
// Separate from the reachability query on purpose: a screen whose tabs failed contributes
// no field rows at all, so its absence is invisible in the join above. Without this the two
// failure modes -- "the field really is on no screen here" and "we could not read three of
// this project's screens" -- would be the same shape, and the second would be reported as
// the first.
export async function loadProjectScreenCoverage(scopeKey, version) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT
        p.project_id,
        COUNT(DISTINCT s.screen_id) AS screen_count,
        SUM(CASE WHEN s.tabs_resolved <> 'resolved' THEN 1 ELSE 0 END) AS unresolved_count
      FROM snapshot_itss_projects p
      JOIN snapshot_itss_mappings m
        ON m.scope_key = p.scope_key AND m.version = p.version AND m.itss_id = p.itss_id
      JOIN snapshot_screen_scheme_operations o
        ON o.scope_key = m.scope_key AND o.version = m.version AND o.scheme_id = m.screen_scheme_id
      JOIN snapshot_screens s
        ON s.scope_key = o.scope_key AND s.version = o.version AND s.screen_id = o.screen_id
      WHERE p.scope_key = ? AND p.version = ?
      GROUP BY p.project_id
    `).bindParams(scopeKey, version).execute()
  );

  return (result.rows || []).map((row) => ({
    projectId: String(row.project_id),
    screenCount: toNumber(row.screen_count),
    unresolvedScreens: toNumber(row.unresolved_count),
  }));
}

// ── Cross-signal summary ─────────────────────────────────────────────────────

export async function writeScreenCrossSummary(scopeKey, summary = {}) {
  await ensureProjectStoreReady();
  await withSqlRetry(() =>
    sql.prepare(`
      INSERT INTO screen_cross_summary
        (scope_key, screen_version, field_version, computed_at, projects_total, projects_resolved,
         populated_field_count, create_placements, invisible_fields, invisible_issues,
         clutter_fields, clutter_placements, unreachable_fields, usage_truncated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        screen_version = VALUES(screen_version),
        field_version = VALUES(field_version),
        computed_at = VALUES(computed_at),
        projects_total = VALUES(projects_total),
        projects_resolved = VALUES(projects_resolved),
        populated_field_count = VALUES(populated_field_count),
        create_placements = VALUES(create_placements),
        invisible_fields = VALUES(invisible_fields),
        invisible_issues = VALUES(invisible_issues),
        clutter_fields = VALUES(clutter_fields),
        clutter_placements = VALUES(clutter_placements),
        unreachable_fields = VALUES(unreachable_fields),
        usage_truncated = VALUES(usage_truncated)
    `).bindParams(
      scopeKey,
      String(summary.screenVersion ?? ""),
      String(summary.fieldVersion ?? ""),
      summary.computedAt || new Date().toISOString(),
      toNumber(summary.projectsTotal),
      toNumber(summary.projectsResolved),
      toNumber(summary.populatedFieldCount),
      toNumber(summary.createPlacements),
      toNumber(summary.counts?.invisibleFields),
      toNumber(summary.counts?.invisibleIssues),
      toNumber(summary.counts?.clutterFields),
      toNumber(summary.counts?.clutterPlacements),
      toNumber(summary.counts?.unreachableFields),
      summary.usageTruncated ? 1 : 0,
    ).execute()
  );
}

// Reads the stored summary and decides whether it still describes the current estate.
//
// `available` is false when either source snapshot has been rebuilt since -- the numbers
// would still render, and they would be a two-builds-ago answer wearing this morning's
// timestamp, which is the failure this whole app exists to prevent elsewhere.
export async function readScreenCrossSummary(scopeKey, { screenVersion = null, fieldVersion = null } = {}) {
  await ensureProjectStoreReady();
  const result = await withSqlRetry(() =>
    sql.prepare(`
      SELECT screen_version, field_version, computed_at, projects_total, projects_resolved,
             populated_field_count, create_placements, invisible_fields, invisible_issues,
             clutter_fields, clutter_placements, unreachable_fields, usage_truncated
      FROM screen_cross_summary
      WHERE scope_key = ?
    `).bindParams(scopeKey).execute()
  );

  const row = (result.rows || [])[0];
  if (!row) return null;

  const matchesScreens = !screenVersion || String(row.screen_version) === String(screenVersion);
  const matchesFields = !fieldVersion || String(row.field_version) === String(fieldVersion);

  return {
    available: matchesScreens && matchesFields,
    staleAgainst: matchesScreens ? (matchesFields ? null : "fields") : "screens",
    reason: matchesScreens && matchesFields
      ? null
      : `The cross was computed against an older ${matchesScreens ? "field snapshot" : "screen inventory"}. It refreshes on the next scan.`,
    screenVersion: row.screen_version,
    fieldVersion: row.field_version,
    computedAt: row.computed_at || null,
    projectsTotal: toNumber(row.projects_total),
    projectsResolved: toNumber(row.projects_resolved),
    populatedFieldCount: toNumber(row.populated_field_count),
    createPlacements: toNumber(row.create_placements),
    usageTruncated: Boolean(toNumber(row.usage_truncated)),
    counts: {
      invisibleFields: toNumber(row.invisible_fields),
      invisibleIssues: toNumber(row.invisible_issues),
      clutterFields: toNumber(row.clutter_fields),
      clutterPlacements: toNumber(row.clutter_placements),
      unreachableFields: toNumber(row.unreachable_fields),
    },
  };
}
