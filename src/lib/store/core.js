// Shared foundation for the storage layer: the Forge SQL handle, the schema, the
// migration list, and the small helpers every domain module needs.
//
// Everything here is imported by the domain modules beside it; nothing here imports them.
// That direction is the whole reason the split is safe -- there are no cycles to reason
// about, because there is only one arrow.

import { sql, migrationRunner } from "@forge/sql";
import { fallbackOn } from "../logger.js";

export const CREATE_SNAPSHOT_FIELDS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_fields (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    field_id VARCHAR(191) NOT NULL,
    name TEXT NOT NULL,
    description TEXT NULL,
    type VARCHAR(255) NULL,
    primitive_type VARCHAR(255) NULL,
    custom_type TEXT NULL,
    searcher_key TEXT NULL,
    usage_count BIGINT NOT NULL,
    configured_project_count BIGINT NOT NULL,
    total_issue_count BIGINT NOT NULL,
    active_project_count BIGINT NOT NULL,
    field_jql TEXT NULL,
    findings_json LONGTEXT NULL,
    PRIMARY KEY (scope_key, version, field_id)
  )
`;

export const CREATE_FIELD_SUMMARIES_TABLE = `
  CREATE TABLE IF NOT EXISTS field_summaries (
    scope_key VARCHAR(191) NOT NULL,
    field_id VARCHAR(191) NOT NULL,
    refreshed_at VARCHAR(64) NOT NULL,
    field_json LONGTEXT NOT NULL,
    field_jql TEXT NULL,
    configured_project_count BIGINT NOT NULL,
    has_global_context TINYINT(1) NOT NULL,
    active_project_count BIGINT NOT NULL,
    total_issue_count BIGINT NOT NULL,
    active_projects_json LONGTEXT NOT NULL,
    contexts_json LONGTEXT NOT NULL,
    findings_json LONGTEXT NULL,
    summary_status VARCHAR(32) NOT NULL,
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    last_error TEXT NULL,
    progress_log LONGTEXT NULL,
    job_token VARCHAR(96) NULL,
    processed_issue_count BIGINT NOT NULL DEFAULT 0,
    estimated_issue_total BIGINT NOT NULL DEFAULT 0,
    next_start_at BIGINT NOT NULL DEFAULT 0,
    next_page_token TEXT NULL,
    PRIMARY KEY (scope_key, field_id)
  )
`;

export const CREATE_SNAPSHOT_PROJECT_USAGE_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_project_usage (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    field_id VARCHAR(191) NOT NULL,
    project_id VARCHAR(191) NOT NULL,
    project_key VARCHAR(191) NOT NULL,
    project_name TEXT NOT NULL,
    issue_count BIGINT NOT NULL,
    jql TEXT NULL,
    latest_field_change_at VARCHAR(64) NULL,
    latest_issue_key VARCHAR(64) NULL,
    latest_issue_updated_at VARCHAR(64) NULL,
    PRIMARY KEY (scope_key, version, field_id, project_id)
  )
`;

export const CREATE_SUMMARY_REFRESH_INDEX = `
  CREATE INDEX idx_field_summaries_scope_refresh
  ON field_summaries (scope_key, refreshed_at)
`;

export const CREATE_SNAPSHOT_PROJECT_USAGE_INDEX = `
  CREATE INDEX idx_snapshot_project_usage_field
  ON snapshot_project_usage (scope_key, version, field_id, issue_count)
`;

// Which issue types a field actually carries a value on, from the issue crawl. The Field
// Browser can already say how many issues and which projects use a field; this is the third
// axis -- a field on a screen for issue types no issue of that type ever populates is
// configured wider than it is used. Mirrors snapshot_project_usage's shape and lifecycle:
// staged in issue_scan_type_buffer as pages arrive, promoted here on a clean finalize.
export const CREATE_SNAPSHOT_FIELD_TYPE_USAGE_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_field_type_usage (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    field_id VARCHAR(191) NOT NULL,
    issue_type_id VARCHAR(191) NOT NULL,
    issue_type_name TEXT NOT NULL,
    issue_count BIGINT NOT NULL,
    PRIMARY KEY (scope_key, version, field_id, issue_type_id)
  )
`;

export const CREATE_SNAPSHOT_FIELD_TYPE_USAGE_INDEX = `
  CREATE INDEX idx_snapshot_field_type_usage_field
  ON snapshot_field_type_usage (scope_key, version, field_id, issue_count)
`;

// The fourth usage axis for a field: WHICH PEOPLE hold a value in it. Only user-picker
// fields (single and multi) contribute -- the crawl tests a value for an accountId before
// tallying. One row per field x account, promoted from issue_scan_field_user_buffer on a
// clean finalize, same lifecycle as snapshot_field_type_usage. Powers "how many distinct
// people does this picker actually reference" on the Field Browser and "which pickers does
// this person appear in" on the People tab.
export const CREATE_SNAPSHOT_FIELD_USER_USAGE_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_field_user_usage (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    field_id VARCHAR(191) NOT NULL,
    account_id VARCHAR(128) NOT NULL,
    display_name TEXT NULL,
    issue_count BIGINT NOT NULL,
    PRIMARY KEY (scope_key, version, field_id, account_id)
  )
`;

// The reverse-lookup index: every field one account appears in, biggest first. The forward
// lookup (field -> people) is covered by the primary key's leading columns.
export const CREATE_SNAPSHOT_FIELD_USER_USAGE_BY_ACCOUNT_INDEX = `
  CREATE INDEX idx_snapshot_field_user_usage_account
  ON snapshot_field_user_usage (scope_key, version, account_id, issue_count)
`;

// The crawl accumulator. One row per field x account, incremented as pages land, cleared at
// the start of every scan like issue_scan_type_buffer -- a re-scan on stale rows would
// double every count.
export const CREATE_ISSUE_SCAN_FIELD_USER_BUFFER_TABLE = `
  CREATE TABLE IF NOT EXISTS issue_scan_field_user_buffer (
    scope_key VARCHAR(191) NOT NULL,
    field_id VARCHAR(191) NOT NULL,
    account_id VARCHAR(128) NOT NULL,
    display_name TEXT NULL,
    issue_count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, field_id, account_id)
  )
`;

// The crawl accumulator behind it. One row per field x issue type, incremented as pages land,
// cleared at the start of every scan for the same reason issue_scan_buffer is -- a re-scan
// on top of stale rows would double every count. No project dimension: a slice restart can
// double-count a field x type pair for the restarted projects, which is accepted here
// because the governance question is "used on this type at all", not an exact tally.
export const CREATE_ISSUE_SCAN_TYPE_BUFFER_TABLE = `
  CREATE TABLE IF NOT EXISTS issue_scan_type_buffer (
    scope_key VARCHAR(191) NOT NULL,
    field_id VARCHAR(191) NOT NULL,
    issue_type_id VARCHAR(191) NOT NULL,
    issue_type_name TEXT NOT NULL,
    issue_count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, field_id, issue_type_id)
  )
`;

export const CREATE_SNAPSHOT_META_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_meta (
    scope_key VARCHAR(191) NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'idle',
    version VARCHAR(64) NULL,
    job_token VARCHAR(96) NULL,
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    refreshed_at VARCHAR(64) NULL,
    total_fields INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    PRIMARY KEY (scope_key)
  )
`;

export const CREATE_SAVED_REPORTS_TABLE = `
  CREATE TABLE IF NOT EXISTS saved_reports (
    scope_key VARCHAR(191) NOT NULL,
    report_id VARCHAR(96) NOT NULL,
    name VARCHAR(255) NOT NULL,
    field_ids_json LONGTEXT NOT NULL,
    created_at VARCHAR(64) NOT NULL,
    updated_at VARCHAR(64) NOT NULL,
    PRIMARY KEY (scope_key, report_id)
  )
`;

export const CREATE_REPORT_JOBS_TABLE = `
  CREATE TABLE IF NOT EXISTS report_jobs (
    scope_key VARCHAR(191) NOT NULL,
    job_id VARCHAR(96) NOT NULL,
    report_name VARCHAR(255) NOT NULL,
    status VARCHAR(32) NOT NULL,
    field_ids_json LONGTEXT NOT NULL,
    processed_fields BIGINT NOT NULL DEFAULT 0,
    total_fields BIGINT NOT NULL DEFAULT 0,
    next_offset BIGINT NOT NULL DEFAULT 0,
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    refreshed_at VARCHAR(64) NOT NULL,
    last_error TEXT NULL,
    progress_log LONGTEXT NULL,
    result_json LONGTEXT NULL,
    PRIMARY KEY (scope_key, job_id)
  )
`;

export const CREATE_ISSUE_SCAN_META_TABLE = `
  CREATE TABLE IF NOT EXISTS issue_scan_meta (
    scope_key VARCHAR(191) NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'idle',
    job_token VARCHAR(96) NULL,
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    total_pages INTEGER NOT NULL DEFAULT 0,
    processed_pages INTEGER NOT NULL DEFAULT 0,
    total_issues BIGINT NOT NULL DEFAULT 0,
    processed_issues BIGINT NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    progress_log LONGTEXT NULL,
    next_start_at BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key)
  )
`;

export const CREATE_ISSUE_SCAN_BUFFER_TABLE = `
  CREATE TABLE IF NOT EXISTS issue_scan_buffer (
    scope_key VARCHAR(191) NOT NULL,
    field_id VARCHAR(191) NOT NULL,
    project_id VARCHAR(191) NOT NULL,
    project_key VARCHAR(191) NOT NULL,
    project_name TEXT NOT NULL,
    issue_count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, field_id, project_id)
  )
`;

export const CREATE_ISSUE_SCAN_PROJECT_TOTALS_TABLE = `
  CREATE TABLE IF NOT EXISTS issue_scan_project_totals (
    scope_key VARCHAR(191) NOT NULL,
    project_id VARCHAR(191) NOT NULL,
    project_key VARCHAR(191) NOT NULL,
    project_name TEXT NOT NULL,
    unique_issue_count BIGINT NOT NULL DEFAULT 0,
    scanned_at VARCHAR(64) NULL,
    PRIMARY KEY (scope_key, project_id)
  )
`;

export const CREATE_ISSUE_SCAN_WORKERS_TABLE = `
  CREATE TABLE IF NOT EXISTS issue_scan_workers (
    scope_key VARCHAR(191) NOT NULL,
    worker_id INTEGER NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'queued',
    jql_filter LONGTEXT NULL,
    field_ids_json LONGTEXT NULL,
    next_page_token TEXT NULL,
    processed_pages BIGINT NOT NULL DEFAULT 0,
    processed_issues BIGINT NOT NULL DEFAULT 0,
    updated_at VARCHAR(64) NOT NULL,
    last_error TEXT NULL,
    PRIMARY KEY (scope_key, worker_id)
  )
`;

export const CREATE_FIELD_OPTIONS_CACHE_TABLE = `
  CREATE TABLE IF NOT EXISTS field_options_cache (
    scope_key VARCHAR(191) NOT NULL,
    field_id VARCHAR(191) NOT NULL,
    context_id VARCHAR(191) NOT NULL,
    context_name TEXT NOT NULL,
    is_global_context TINYINT(1) NOT NULL DEFAULT 0,
    option_id VARCHAR(191) NOT NULL,
    option_value TEXT NOT NULL,
    disabled TINYINT(1) NOT NULL DEFAULT 0,
    refreshed_at VARCHAR(64) NOT NULL,
    PRIMARY KEY (scope_key, field_id, context_id, option_id)
  )
`;

export const CREATE_RQT_FIELD_INDEX_TABLE = `
  CREATE TABLE IF NOT EXISTS rqt_field_index (
    scope_key VARCHAR(191) NOT NULL,
    field_id VARCHAR(191) NOT NULL,
    field_name TEXT NOT NULL,
    issue_count BIGINT NOT NULL DEFAULT 0,
    unique_value_count BIGINT NOT NULL DEFAULT 0,
    sample_values_json LONGTEXT NULL,
    refreshed_at VARCHAR(64) NULL,
    PRIMARY KEY (scope_key, field_id)
  )
`;


// Automation analysis, relational.
//
// This lived in KVS as four documents. That shape forced every cap in
// automation-analysis.js -- 1,000 indexed entries, 50 rule ids per direction, 150 cascades
// -- because a KVS value holds ~240 KB and the indexes alone were already past half of it
// on one estate. None of those limits were product decisions; they were storage artifacts.
//
// It also made the most valuable join in the product a string match in memory: answering
// "does any rule touch this field" meant loading five documents totalling ~440 KB and
// filtering in JavaScript, whether the question was about one field or all of them.
//
// One row per reference, so a field referenced by 542 rules is 542 rows rather than a list
// truncated at 50. Direction is a column because it carries the consequence: a rule that
// WRITES a field keeps it alive, one that only READS it breaks when the field disappears.
export const CREATE_AUTOMATION_REFERENCES_TABLE = `
  CREATE TABLE IF NOT EXISTS automation_references (
    scope_key VARCHAR(191) NOT NULL,
    kind VARCHAR(16) NOT NULL,
    label VARCHAR(191) NOT NULL,
    rule_id VARCHAR(64) NOT NULL,
    direction VARCHAR(16) NOT NULL,
    PRIMARY KEY (scope_key, kind, label, rule_id, direction)
  )
`;

// Lookup by rule, for "what does this rule touch" -- the reverse of the primary key's
// ordering, which only serves "what touches this label".
export const CREATE_AUTOMATION_REFERENCES_RULE_INDEX = `
  CREATE INDEX idx_automation_references_rule
  ON automation_references (scope_key, rule_id)
`;

// The rule directory: id -> name, so a drill-down from a field to the rules that write it
// can show names rather than bare numeric ids.
export const CREATE_AUTOMATION_RULES_TABLE = `
  CREATE TABLE IF NOT EXISTS automation_rules (
    scope_key VARCHAR(191) NOT NULL,
    rule_id VARCHAR(64) NOT NULL,
    name TEXT NULL,
    enabled TINYINT NOT NULL DEFAULT 1,
    trigger_type VARCHAR(191) NULL,
    project_count INT NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, rule_id)
  )
`;

// Which projects each rule is scoped to.
//
// summary.projectIds has been computed on every import since cascades needed it -- scope
// overlap is what stops a rule in one project being reported as triggering a rule in
// another -- and then only its LENGTH was kept, as automation_rules.project_count. The ids
// were discarded, which is the entire reason the Projects tab could not say a word about
// automation: the join existed in memory for the duration of one import and was never
// written down.
//
// A rule scoped to the whole site has no rows here rather than a row per project. Site-wide
// is a different fact from "scoped to all 200 of them", and materialising 200 rows per
// global rule would both lie about that and dwarf the table.
export const CREATE_AUTOMATION_RULE_PROJECTS_TABLE = `
  CREATE TABLE IF NOT EXISTS automation_rule_projects (
    scope_key VARCHAR(191) NOT NULL,
    rule_id VARCHAR(64) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    PRIMARY KEY (scope_key, rule_id, project_id)
  )
`;

// The direction the Projects tab reads in: given a project, which rules touch it.
export const CREATE_AUTOMATION_RULE_PROJECTS_BY_PROJECT_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_automation_rule_projects_project
    ON automation_rule_projects (scope_key, project_id)
`;

// Cascade edges: rule A writes a field rule B triggers on, and their project scopes overlap.
//
// These lived in the analysis document, capped at MAX_STORED_CASCADES = 150. This site has
// 1,457 of them, so the tab has been showing a tenth of the estate's cascades under a
// footnote -- and the cap was not arbitrary, it was what kept the document inside the ~240 KB
// a KVS value holds. In SQL there is no cap to apply, which also makes the multi-hop
// question answerable: a chain A -> B -> C cannot be found in a list that was truncated
// before C.
//
// One row per (source, target, field). Two rules linked by three fields are three rows and
// one relationship; collapsing them here would lose which field carries which hop, which is
// the thing an admin has to break to stop the cascade.
//
// self_triggering is stored rather than derived from source = target, because it is what the
// UI filters and sorts on and a computed column is not indexable here.
export const CREATE_AUTOMATION_CASCADES_TABLE = `
  CREATE TABLE IF NOT EXISTS automation_cascades (
    scope_key VARCHAR(191) NOT NULL,
    source_rule_id VARCHAR(64) NOT NULL,
    target_rule_id VARCHAR(64) NOT NULL,
    field VARCHAR(191) NOT NULL,
    self_triggering TINYINT NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, source_rule_id, target_rule_id, field)
  )
`;

// The reverse direction: "what wakes this rule", which is the question an admin asks when a
// rule fires and they cannot see why. The primary key only serves "what does this rule wake".
export const CREATE_AUTOMATION_CASCADES_TARGET_INDEX = `
  CREATE INDEX idx_automation_cascades_target
  ON automation_cascades (scope_key, target_rule_id)
`;

// Blast radius per rule: how much of the estate the rule can move if it misfires. One row
// per rule, replaced wholesale on every import like the cascade edges. `tier` is stored
// rather than derived from `score` because it is what the tab filters and sorts on and a
// computed column is not indexable here; `factors_json` is the weighted breakdown, so the
// drawer can explain a number without the raw rules the score was built from.
export const CREATE_AUTOMATION_RULE_BLAST_TABLE = `
  CREATE TABLE IF NOT EXISTS automation_rule_blast (
    scope_key VARCHAR(191) NOT NULL,
    rule_id VARCHAR(64) NOT NULL,
    score INT NOT NULL DEFAULT 0,
    tier VARCHAR(20) NOT NULL DEFAULT 'contained',
    estimated TINYINT NOT NULL DEFAULT 0,
    credential TINYINT NOT NULL DEFAULT 0,
    factors_json TEXT NULL,
    PRIMARY KEY (scope_key, rule_id)
  )
`;

// The order the tab reads in: most blast first.
export const CREATE_AUTOMATION_RULE_BLAST_SCORE_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_automation_rule_blast_score
  ON automation_rule_blast (scope_key, score)
`;

// The dashboard inventory, versioned like every other snapshot here.
//
// A dashboard is the most visible thing in Jira and the least owned: it goes on a wall
// screen, gets linked in a status report, and is never opened again. It is also the end of a
// dependency chain nobody can see from either end -- a gadget reads a filter, the filter
// searches a field -- so deleting the field breaks the dashboard three steps later with no
// error at any of them.
//
// owner_active is the same tri-state the filter table uses: 1 active, 0 deactivated, NULL
// when the owner is gone. Jira deletes a dashboard with its owner, so the third case is a
// deletion date nobody has written down.
//
// gadget_count is nullable for a reason that is not cosmetic. NULL means the per-dashboard
// gadget walk did not reach this one, and a partial walk can say a dashboard HAS gadgets but
// cannot say one has none. Storing 0 for "we did not look" would turn an unfinished pass
// into a list of empty dashboards.
export const CREATE_SNAPSHOT_DASHBOARDS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_dashboards (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    dashboard_id VARCHAR(64) NOT NULL,
    name TEXT NULL,
    description TEXT NULL,
    owner_account_id VARCHAR(191) NULL,
    owner_name TEXT NULL,
    owner_active TINYINT NULL,
    popularity INT NOT NULL DEFAULT 0,
    gadget_count INT NULL,
    shared_with_everyone TINYINT NOT NULL DEFAULT 0,
    editable_by_everyone TINYINT NOT NULL DEFAULT 0,
    share_count INT NOT NULL DEFAULT 0,
    view_url TEXT NULL,
    PRIMARY KEY (scope_key, version, dashboard_id)
  )
`;

// The gadgets on each dashboard.
//
// Stored rather than only counted, because the count alone cannot answer "what is on this
// thing" -- and because a gadget's module key is what a later pass will join to a filter once
// gadget properties are read.
export const CREATE_SNAPSHOT_DASHBOARD_GADGETS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_dashboard_gadgets (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    dashboard_id VARCHAR(64) NOT NULL,
    gadget_id VARCHAR(64) NOT NULL,
    title TEXT NULL,
    module_key VARCHAR(255) NULL,
    position_row INT NULL,
    position_column INT NULL,
    PRIMARY KEY (scope_key, version, dashboard_id, gadget_id)
  )
`;

// Who a dashboard is shared with, and who may edit it. `permission_kind` separates the two
// because they are different claims: readable by everyone is usually intended, editable by
// everyone is a shared document with no owner in practice.
export const CREATE_SNAPSHOT_DASHBOARD_SHARES_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_dashboard_shares (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    dashboard_id VARCHAR(64) NOT NULL,
    permission_kind VARCHAR(16) NOT NULL,
    share_index INT NOT NULL,
    share_type VARCHAR(32) NOT NULL,
    target_id VARCHAR(191) NULL,
    target_name TEXT NULL,
    PRIMARY KEY (scope_key, version, dashboard_id, permission_kind, share_index)
  )
`;

// Build state, mirroring filter_snapshot_meta and screen_snapshot_meta.
//
// gadgets_walked is the honesty column: a pass that enumerated dashboards but could not read
// every gadget list has to be able to say so, or "12 empty dashboards" becomes a claim the
// build never established.
export const CREATE_DASHBOARD_SNAPSHOT_META_TABLE = `
  CREATE TABLE IF NOT EXISTS dashboard_snapshot_meta (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'idle',
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    refreshed_at VARCHAR(64) NULL,
    total_dashboards INTEGER NOT NULL DEFAULT 0,
    gadgets_walked INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    PRIMARY KEY (scope_key)
  )
`;

// The saved filter inventory, versioned like every other snapshot here.
//
// Filters are the one piece of Jira configuration that fails silently in both directions:
// delete a field forty filters search on and those searches quietly return the wrong answer,
// and leave a filter owned by somebody who left and it keeps emailing a subscription list
// from an account nobody administers.
//
// owner_active is a tri-state and the column is nullable for that reason: 1 active,
// 0 deactivated, NULL when the owner is gone entirely. Jira deletes a filter with its owner,
// so the third case is the one that takes boards and dashboards with it.
export const CREATE_SNAPSHOT_FILTERS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_filters (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    filter_id VARCHAR(64) NOT NULL,
    name TEXT NULL,
    description TEXT NULL,
    jql LONGTEXT NULL,
    jql_normalized VARCHAR(512) NULL,
    owner_account_id VARCHAR(191) NULL,
    owner_name TEXT NULL,
    owner_active TINYINT NULL,
    subscription_count INT NOT NULL DEFAULT 0,
    favourited_count INT NOT NULL DEFAULT 0,
    shared_with_everyone TINYINT NOT NULL DEFAULT 0,
    share_count INT NOT NULL DEFAULT 0,
    last_used_at VARCHAR(64) NULL,
    view_url TEXT NULL,
    PRIMARY KEY (scope_key, version, filter_id)
  )
`;

// Duplicate detection is a GROUP BY on the normalized JQL, so it gets an index rather than a
// full scan of a LONGTEXT column across every filter on the site.
export const CREATE_SNAPSHOT_FILTERS_JQL_INDEX = `
  CREATE INDEX idx_snapshot_filters_jql
  ON snapshot_filters (scope_key, version, jql_normalized)
`;

// What each filter depends on: one row per (filter, kind, label).
//
// The same shape automation_references uses, and for the same reason -- this is the join that
// answers "is anything using this field" from a second source. A field that no rule writes
// and forty filters search on is not unused, and until this table existed there was no way
// to know that.
export const CREATE_SNAPSHOT_FILTER_REFS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_filter_refs (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    filter_id VARCHAR(64) NOT NULL,
    kind VARCHAR(16) NOT NULL,
    label VARCHAR(191) NOT NULL,
    PRIMARY KEY (scope_key, version, filter_id, kind, label)
  )
`;

// The direction the cross-pillar reads go in: given a field or status, which filters use it.
export const CREATE_SNAPSHOT_FILTER_REFS_LABEL_INDEX = `
  CREATE INDEX idx_snapshot_filter_refs_label
  ON snapshot_filter_refs (scope_key, version, kind, label)
`;

// Who a filter is shared with. Split from the filter row because one filter has many shares
// and the interesting question -- "what is shared with everyone" -- is a filter over these.
export const CREATE_SNAPSHOT_FILTER_SHARES_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_filter_shares (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    filter_id VARCHAR(64) NOT NULL,
    share_index INT NOT NULL,
    share_type VARCHAR(32) NOT NULL,
    target_id VARCHAR(191) NULL,
    target_name TEXT NULL,
    role_id VARCHAR(191) NULL,
    PRIMARY KEY (scope_key, version, filter_id, share_index)
  )
`;

// Build state, mirroring workflow_snapshot_meta and screen_snapshot_meta.
export const CREATE_FILTER_SNAPSHOT_META_TABLE = `
  CREATE TABLE IF NOT EXISTS filter_snapshot_meta (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'idle',
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    refreshed_at VARCHAR(64) NULL,
    total_filters INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    PRIMARY KEY (scope_key)
  )
`;

// When work actually happened in each project, by month.
//
// Every rate on the Projects tab was a lifetime total with nothing to divide it by, which
// systematically flatters old projects and buries new ones: a project spun up three weeks
// ago with 40 issues looks abandoned next to one carrying 61,000 over eight years, when the
// first is being adopted twice as fast. "Is anyone using this" is a rate, and a rate needs
// an age.
//
// Jira Cloud does not expose a project creation date -- there is no `created` on the project
// resource at any endpoint -- so the anchor is the first issue ever created in the project.
// That is arguably the better anchor anyway: it is when work started rather than when an
// admin clicked Create, and where the two differ it is the one that makes a rate mean
// something. A project with fields and no first issue is already its own finding.
//
// Month granularity for the histogram, exact timestamps for the boundaries. The histogram
// answers "when did this fall off"; the timestamps answer "how old is it", which month
// granularity would get badly wrong on a project three weeks old.
//
// The live month histogram: the last good series, promoted from the buffer below only when
// a scan finalizes. It is NOT cleared at scan start -- a crawl that dies partway (the normal
// failure mode on a large site) must never be able to leave this table holding nothing but
// the oldest months it happened to reach before it stopped.
export const CREATE_ISSUE_SCAN_PROJECT_ACTIVITY_TABLE = `
  CREATE TABLE IF NOT EXISTS issue_scan_project_activity (
    scope_key VARCHAR(191) NOT NULL,
    project_id VARCHAR(191) NOT NULL,
    month CHAR(7) NOT NULL,
    issue_count BIGINT NOT NULL DEFAULT 0,
    first_created_at VARCHAR(64) NULL,
    last_created_at VARCHAR(64) NULL,
    PRIMARY KEY (scope_key, project_id, month)
  )
`;

// Where the crawl accumulates the histogram, one row per project per month, exactly like
// issue_scan_buffer accumulates field counts. Cleared at scan start and promoted -- per
// project, so a partial run leaves untouched projects alone -- into the live table above at
// finalization. Same shape as the live table on purpose: promotion is a straight copy.
export const CREATE_ISSUE_SCAN_ACTIVITY_BUFFER_TABLE = `
  CREATE TABLE IF NOT EXISTS issue_scan_activity_buffer (
    scope_key VARCHAR(191) NOT NULL,
    project_id VARCHAR(191) NOT NULL,
    month CHAR(7) NOT NULL,
    issue_count BIGINT NOT NULL DEFAULT 0,
    first_created_at VARCHAR(64) NULL,
    last_created_at VARCHAR(64) NULL,
    PRIMARY KEY (scope_key, project_id, month)
  )
`;

// Findings per rule. Paginating these was the reason the analysis document grew a preview
// alongside a full list; in SQL the preview is just a LIMIT.
export const CREATE_AUTOMATION_FINDINGS_TABLE = `
  CREATE TABLE IF NOT EXISTS automation_findings (
    scope_key VARCHAR(191) NOT NULL,
    rule_id VARCHAR(64) NOT NULL,
    code VARCHAR(64) NOT NULL,
    severity VARCHAR(16) NOT NULL,
    hosts_json TEXT NULL,
    disabled_days INT NULL,
    PRIMARY KEY (scope_key, rule_id, code)
  )
`;

export const CREATE_AUTOMATION_FINDINGS_SEVERITY_INDEX = `
  CREATE INDEX idx_automation_findings_severity
  ON automation_findings (scope_key, severity)
`;

export const CREATE_RQT_ISSUE_KEYS_TABLE = `
  CREATE TABLE IF NOT EXISTS rqt_issue_keys (
    scope_key VARCHAR(191) NOT NULL,
    project_key VARCHAR(64) NOT NULL,
    issue_type VARCHAR(128) NOT NULL DEFAULT '',
    issue_key VARCHAR(64) NOT NULL,
    PRIMARY KEY (scope_key, issue_key)
  )
`;

export const CREATE_RQT_VALUE_ISSUE_INDEX_TABLE = `
  CREATE TABLE IF NOT EXISTS rqt_value_issue_index (
    scope_key VARCHAR(191) NOT NULL,
    rqt_value VARCHAR(64) NOT NULL,
    issue_key VARCHAR(64) NOT NULL,
    PRIMARY KEY (scope_key, rqt_value, issue_key)
  )
`;

export const CREATE_RQT_FIELD_ISSUE_INDEX_TABLE = `
  CREATE TABLE IF NOT EXISTS rqt_field_issue_index (
    scope_key VARCHAR(191) NOT NULL,
    field_id VARCHAR(128) NOT NULL,
    issue_key VARCHAR(64) NOT NULL,
    PRIMARY KEY (scope_key, field_id, issue_key)
  )
`;

export const CREATE_SNAPSHOT_WORKFLOW_SCHEMES_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_workflow_schemes (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    scheme_id VARCHAR(191) NOT NULL,
    name TEXT NOT NULL,
    description TEXT NULL,
    default_workflow VARCHAR(255) NULL,
    issue_type_mapping_json LONGTEXT NULL,
    project_count BIGINT NOT NULL DEFAULT 0,
    findings_json LONGTEXT NULL,
    PRIMARY KEY (scope_key, version, scheme_id)
  )
`;

export const CREATE_SNAPSHOT_WORKFLOW_SCHEME_PROJECTS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_workflow_scheme_projects (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    scheme_id VARCHAR(191) NOT NULL,
    project_id VARCHAR(191) NOT NULL,
    project_key VARCHAR(191) NOT NULL,
    project_name TEXT NOT NULL,
    PRIMARY KEY (scope_key, version, scheme_id, project_id)
  )
`;

export const CREATE_SNAPSHOT_WORKFLOW_SCHEME_PROJECTS_BY_PROJECT_INDEX = `
  CREATE INDEX idx_workflow_scheme_projects_by_project
  ON snapshot_workflow_scheme_projects (scope_key, version, project_id)
`;

export const CREATE_SNAPSHOT_STATUSES_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_statuses (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    status_id VARCHAR(191) NOT NULL,
    name TEXT NOT NULL,
    status_category VARCHAR(64) NULL,
    findings_json LONGTEXT NULL,
    PRIMARY KEY (scope_key, version, status_id)
  )
`;

// Which statuses each scheme can reach, resolved from scheme -> workflow -> statuses.
//
// Without this the status catalog is a flat list with no way to ask "is anything using
// this?" -- which is the question behind both orphan detection and per-scheme balance.
export const CREATE_SNAPSHOT_WORKFLOW_STATUSES_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_workflow_statuses (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    scheme_id VARCHAR(191) NOT NULL,
    status_id VARCHAR(191) NOT NULL,
    PRIMARY KEY (scope_key, version, scheme_id, status_id)
  )
`;

// The site health score, once per day, with every dimension it was made of.
//
// The point of the score was never the number -- it was whether cleaning something up moved
// it. That question needs a series, and a series cannot be back-filled: a day without a row
// is a hole in the record forever. So this records early and cheaply rather than waiting for
// a chart to justify it.
//
// Keyed on the DAY rather than a timestamp, upserted. An admin who fixes something and
// rebuilds three times in an afternoon wants the afternoon's best state on the chart, not
// three points of noise -- and a year of daily rows is 365, which is a rounding error.
//
// dimensions_json holds {key: score} for every scored dimension. Stored as a blob rather
// than a column per dimension because the dimension list grows (ten to thirteen in one
// change), and a schema migration per new metric would guarantee the history stops the day
// somebody adds one.
export const CREATE_HEALTH_HISTORY_TABLE = `
  CREATE TABLE IF NOT EXISTS health_history (
    scope_key VARCHAR(191) NOT NULL,
    measured_on VARCHAR(10) NOT NULL,
    measured_at VARCHAR(64) NOT NULL,
    score INTEGER NULL,
    grade VARCHAR(2) NULL,
    dimensions_scored INTEGER NOT NULL DEFAULT 0,
    dimensions_total INTEGER NOT NULL DEFAULT 0,
    dimensions_json TEXT NULL,
    PRIMARY KEY (scope_key, measured_on)
  )
`;

// One row per scope tracking a full scan through its stages.
//
// The pipelines it drives already existed and were already queue jobs; what was missing was
// anything on top of them. An admin had to know that a "Universe Scan" scans issues but not
// screens, that the workflow inventory is a different button on a different tab, and that
// running them out of order leaves the tabs disagreeing with each other. Five things to
// sequence by hand is a checklist, not a scan.
//
// stages_json holds [{key, state, startedAt, completedAt, error}] rather than a column per
// stage, for the same reason health history stores dimensions as a blob: the stage list will
// grow, and a migration per stage would guarantee a half-written schema the first time one
// is added.
export const CREATE_FULL_SCAN_META_TABLE = `
  CREATE TABLE IF NOT EXISTS full_scan_meta (
    scope_key VARCHAR(191) NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'idle',
    job_token VARCHAR(96) NULL,
    current_stage VARCHAR(32) NULL,
    stages_json LONGTEXT NULL,
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    last_error TEXT NULL,
    PRIMARY KEY (scope_key)
  )
`;

// One row per finished scan run -- full_scan_meta only ever holds the LATEST run, so without
// this there is nothing to compare a run against. Written once by the orchestrator's finish()
// path (which is also where a recovered-then-abandoned scan lands), pruned to the most recent
// few dozen per site. stages_json is the per-stage timing/attempt breakdown; summary_json is
// what each stage produced (filters counted, dashboards counted, issues crawled, ...), so the
// scan page can show "4,115 filters, +38 vs last run" without re-reading every pillar.
export const CREATE_FULL_SCAN_RUNS_TABLE = `
  CREATE TABLE IF NOT EXISTS full_scan_runs (
    scope_key VARCHAR(191) NOT NULL,
    run_id VARCHAR(96) NOT NULL,
    scan_type VARCHAR(16) NOT NULL DEFAULT 'full',
    state VARCHAR(32) NOT NULL DEFAULT 'ready',
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    duration_ms BIGINT NOT NULL DEFAULT 0,
    failed_count INT NOT NULL DEFAULT 0,
    skipped_count INT NOT NULL DEFAULT 0,
    total_stages INT NOT NULL DEFAULT 0,
    sweep INT NOT NULL DEFAULT 0,
    stages_json LONGTEXT NULL,
    summary_json LONGTEXT NULL,
    PRIMARY KEY (scope_key, run_id)
  )
`;

export const CREATE_FULL_SCAN_RUNS_BY_COMPLETED_INDEX = `
  CREATE INDEX IF NOT EXISTS full_scan_runs_by_completed ON full_scan_runs (scope_key, scan_type, completed_at)
`;

// Which transitions open which screen.
//
// The second way a screen reaches a user, and the one that was missing. A screen attached
// to a transition is in daily use without appearing in any screen scheme, so a catalog that
// only walks the scheme chain reports it as reachable by nobody -- and that sentence is the
// premise for deleting it.
//
// Keyed on the workflow snapshot's version, not the screen snapshot's: the two pillars
// rebuild on their own cadences, and pinning this to the screen version would make a
// workflow rebuild look like it had lost every transition.
//
// workflow_name rather than a workflow id, matching snapshot_workflow_statuses: the scheme
// association gives names, and the join everything else in this pillar performs is by name.
export const CREATE_SNAPSHOT_TRANSITION_SCREENS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_transition_screens (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    workflow_name VARCHAR(255) NOT NULL,
    transition_id VARCHAR(64) NOT NULL,
    transition_name VARCHAR(255) NULL,
    to_status VARCHAR(191) NULL,
    screen_id VARCHAR(64) NOT NULL,
    PRIMARY KEY (scope_key, version, workflow_name, transition_id, screen_id)
  )
`;

// Answers "is any transition using this screen" without scanning the table per screen,
// which is the lookup the screen catalog and its unreached count both need.
export const CREATE_SNAPSHOT_TRANSITION_SCREENS_BY_SCREEN_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_snapshot_transition_screens_screen
    ON snapshot_transition_screens (scope_key, version, screen_id)
`;

// Issue counts per status per project, accumulated by the universe scan.
//
// Unversioned, like the other issue_scan_* tables: it reflects the last completed scan
// rather than a snapshot version. The project dimension is carried even though the
// headline number is site-wide, because adding it later would mean a second full re-scan
// -- and it is what lets a scheme's balance be weighted by real issue volume instead of
// by how many statuses someone happened to define.
export const CREATE_ISSUE_SCAN_STATUS_TOTALS_TABLE = `
  CREATE TABLE IF NOT EXISTS issue_scan_status_totals (
    scope_key VARCHAR(191) NOT NULL,
    status_id VARCHAR(191) NOT NULL,
    project_id VARCHAR(191) NOT NULL,
    status_name TEXT NULL,
    status_category VARCHAR(64) NULL,
    project_key VARCHAR(191) NULL,
    issue_count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, status_id, project_id)
  )
`;

// How many issues have EVER been in each status, from JQL's WAS operator.
//
// Separate from issue_scan_status_totals, which counts issues CURRENTLY in a status: the
// two are measured by different mechanisms, refresh independently, and the gap between
// them is itself the signal -- a status with no current issues but tens of thousands
// historically is a bottleneck people escaped, not a status nobody uses.
//
// measured_at is per row rather than per table so a partial run (some statuses timed out)
// leaves the successful rows usable and dated.
export const CREATE_STATUS_HISTORY_TOTALS_TABLE = `
  CREATE TABLE IF NOT EXISTS status_history_totals (
    scope_key VARCHAR(191) NOT NULL,
    status_id VARCHAR(191) NOT NULL,
    ever_count BIGINT NOT NULL DEFAULT 0,
    measured_at VARCHAR(64) NULL,
    PRIMARY KEY (scope_key, status_id)
  )
`;

export const CREATE_WORKFLOW_SNAPSHOT_META_TABLE = `
  CREATE TABLE IF NOT EXISTS workflow_snapshot_meta (
    scope_key VARCHAR(191) NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'idle',
    version VARCHAR(64) NULL,
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    refreshed_at VARCHAR(64) NULL,
    total_schemes INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    PRIMARY KEY (scope_key)
  )
`;

// ── Screen and scheme snapshot ───────────────────────────────────────────────
//
// The full presentation chain, versioned like the field and workflow snapshots:
//   project -> issue type screen scheme -> screen scheme -> screen -> tab -> field
//
// Sized from a live measurement rather than a guess (CONNECT-4137): 760 screens at a mean
// of 28.8 fields each is ~22,000 field rows, which is the largest of these by an order of
// magnitude and still small. Tabs measured at exactly 1 per screen on the reference site,
// but the tab table is kept separate rather than folded into the field row -- tab POSITION
// is the signal behind the "buried field" finding, and a site with multi-tab screens would
// otherwise have nowhere to record it.

export const CREATE_SNAPSHOT_SCREENS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_screens (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    screen_id VARCHAR(64) NOT NULL,
    name VARCHAR(255) NULL,
    description TEXT NULL,
    tab_count INTEGER NOT NULL DEFAULT 0,
    field_count INTEGER NOT NULL DEFAULT 0,
    -- Tri-state, not a boolean. A screen whose tabs could not be read is NOT a screen with
    -- no fields, and every downstream finding depends on telling those apart.
    tabs_resolved VARCHAR(16) NOT NULL DEFAULT 'resolved',
    unresolved_reason TEXT NULL,
    PRIMARY KEY (scope_key, version, screen_id)
  )
`;

export const CREATE_SNAPSHOT_SCREEN_TABS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_screen_tabs (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    screen_id VARCHAR(64) NOT NULL,
    tab_id VARCHAR(64) NOT NULL,
    name VARCHAR(255) NULL,
    tab_index INTEGER NOT NULL DEFAULT 0,
    field_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, version, screen_id, tab_id)
  )
`;

// One row per field per tab. field_index preserves order within the tab, which together
// with tab_index is what "buried past the first tab" is computed from -- discard either and
// the finding cannot be recovered from the snapshot.
export const CREATE_SNAPSHOT_SCREEN_FIELDS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_screen_fields (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    screen_id VARCHAR(64) NOT NULL,
    tab_id VARCHAR(64) NOT NULL,
    field_id VARCHAR(128) NOT NULL,
    field_name VARCHAR(255) NULL,
    tab_index INTEGER NOT NULL DEFAULT 0,
    field_index INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, version, screen_id, tab_id, field_id)
  )
`;

// Answers "which screens is this field on" without scanning the field table by screen.
export const CREATE_SNAPSHOT_SCREEN_FIELDS_BY_FIELD_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_snapshot_screen_fields_field
    ON snapshot_screen_fields (scope_key, version, field_id)
`;

// screens_json holds the raw operation -> screen object. Inheritance is resolved into
// snapshot_screen_scheme_operations rather than being flattened here, so the inventory can
// still say which operation was set explicitly and which fell through to default.
export const CREATE_SNAPSHOT_SCREEN_SCHEMES_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_screen_schemes (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    scheme_id VARCHAR(64) NOT NULL,
    name VARCHAR(255) NULL,
    description TEXT NULL,
    screens_json TEXT NULL,
    PRIMARY KEY (scope_key, version, scheme_id)
  )
`;

export const CREATE_SNAPSHOT_SCREEN_SCHEME_OPERATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_screen_scheme_operations (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    scheme_id VARCHAR(64) NOT NULL,
    operation VARCHAR(32) NOT NULL,
    screen_id VARCHAR(64) NULL,
    inherited TINYINT NOT NULL DEFAULT 0,
    -- A scheme referencing a screen absent from the catalog keeps the dangling reference
    -- rather than dropping the row: a broken mapping is a finding, and silently omitting
    -- it would make the scheme look correctly configured.
    dangling TINYINT NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, version, scheme_id, operation)
  )
`;

export const CREATE_SNAPSHOT_ITSS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_issue_type_screen_schemes (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    itss_id VARCHAR(64) NOT NULL,
    name VARCHAR(255) NULL,
    description TEXT NULL,
    project_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, version, itss_id)
  )
`;

// issue_type_id is the literal "default" for the catch-all entry, which is kept as its own
// row rather than folded into the explicit list. On most sites it is the ONLY mapping a
// project has, so treating it as absent would resolve the majority of projects to nothing.
export const CREATE_SNAPSHOT_ITSS_MAPPINGS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_itss_mappings (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    itss_id VARCHAR(64) NOT NULL,
    issue_type_id VARCHAR(64) NOT NULL,
    screen_scheme_id VARCHAR(64) NULL,
    is_default TINYINT NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, version, itss_id, issue_type_id)
  )
`;

export const CREATE_SNAPSHOT_ITSS_PROJECTS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_itss_projects (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    itss_id VARCHAR(64) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    project_key VARCHAR(64) NULL,
    project_name VARCHAR(255) NULL,
    PRIMARY KEY (scope_key, version, itss_id, project_id)
  )
`;

export const CREATE_SNAPSHOT_ITSS_PROJECTS_BY_PROJECT_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_snapshot_itss_projects_by_project
    ON snapshot_itss_projects (scope_key, version, project_id)
`;

// Versioned separately from fields and workflows: the three pillars refresh on their own
// cadences, and a shared meta row would make any one rebuild look like all three.
export const CREATE_SCREEN_SNAPSHOT_META_TABLE = `
  CREATE TABLE IF NOT EXISTS screen_snapshot_meta (
    scope_key VARCHAR(191) NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'idle',
    version VARCHAR(64) NULL,
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    refreshed_at VARCHAR(64) NULL,
    total_screens INTEGER NOT NULL DEFAULT 0,
    total_schemes INTEGER NOT NULL DEFAULT 0,
    unresolved_screens INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    PRIMARY KEY (scope_key)
  )
`;

// ── Issue type pillar ────────────────────────────────────────────────────────
//
// Distinct from the screen pillar's snapshot_issue_type_SCREEN_schemes: that layer routes
// issue-type -> screen, this one is the issue-type catalog and the schemes that decide which
// types a project may use. They refresh together (one scan stage) but are versioned on their
// own meta row so a rebuild of one does not make the other look refreshed.

// The issue-type catalog. hierarchy_level is Jira's own integer: -1 sub-task, 0 base
// (Story/Task/Bug), 1 Epic, and 2+ only on sites with custom hierarchy above Epic. Kept as
// the raw number rather than a label so the tab can group by it without a lookup table that
// would rot the moment someone adds a level.
//
// scope_project_id is set only for project-scoped ("next-gen"/team-managed) types; a NULL
// there means the type is global and available to classic projects. The two are opposite
// facts about where a type can be used, so the column is nullable rather than defaulted.
export const CREATE_SNAPSHOT_ISSUE_TYPES_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_issue_types (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    issue_type_id VARCHAR(64) NOT NULL,
    name VARCHAR(255) NULL,
    description TEXT NULL,
    subtask TINYINT NOT NULL DEFAULT 0,
    hierarchy_level INTEGER NOT NULL DEFAULT 0,
    scope_project_id VARCHAR(64) NULL,
    PRIMARY KEY (scope_key, version, issue_type_id)
  )
`;

// One row per issue type scheme. default_issue_type_id is the type Jira pre-selects on the
// create screen; is_default marks the site-wide fallback scheme every classic project starts
// on. project_count is denormalised at build time so the tab can sort by reach without a
// join against the assignments table.
export const CREATE_SNAPSHOT_ISSUE_TYPE_SCHEMES_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_issue_type_schemes (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    scheme_id VARCHAR(64) NOT NULL,
    name VARCHAR(255) NULL,
    description TEXT NULL,
    default_issue_type_id VARCHAR(64) NULL,
    is_default TINYINT NOT NULL DEFAULT 0,
    project_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, version, scheme_id)
  )
`;

// Ordered membership: which issue types a scheme allows, and in what order they appear on
// the create dialog. item_index preserves that order -- Jira returns it and admins arrange
// it deliberately, so dropping it would lose information the tab is meant to show.
export const CREATE_SNAPSHOT_ISSUE_TYPE_SCHEME_ITEMS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_issue_type_scheme_items (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    scheme_id VARCHAR(64) NOT NULL,
    issue_type_id VARCHAR(64) NOT NULL,
    item_index INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, version, scheme_id, issue_type_id)
  )
`;

// Which projects each issue type scheme is assigned to. project_key/project_name are
// resolved at build time so the inventory reads without a second lookup; the row is kept
// even when the project is not in the catalog rather than dropped, matching the ITSS
// projects table.
export const CREATE_SNAPSHOT_ISSUE_TYPE_SCHEME_PROJECTS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_issue_type_scheme_projects (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    scheme_id VARCHAR(64) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    project_key VARCHAR(64) NULL,
    project_name VARCHAR(255) NULL,
    PRIMARY KEY (scope_key, version, scheme_id, project_id)
  )
`;

export const CREATE_SNAPSHOT_ISSUE_TYPE_SCHEME_PROJECTS_BY_PROJECT_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_snapshot_its_projects_by_project
    ON snapshot_issue_type_scheme_projects (scope_key, version, project_id)
`;

// Versioned separately from the screen pillar for the same reason screen_snapshot_meta is
// versioned separately from fields and workflows: a shared meta row would make any one
// rebuild look like all of them.
export const CREATE_ISSUE_TYPE_SNAPSHOT_META_TABLE = `
  CREATE TABLE IF NOT EXISTS issue_type_snapshot_meta (
    scope_key VARCHAR(191) NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'idle',
    version VARCHAR(64) NULL,
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    refreshed_at VARCHAR(64) NULL,
    total_types INTEGER NOT NULL DEFAULT 0,
    total_schemes INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    PRIMARY KEY (scope_key)
  )
`;

// The People pillar. One row per licensed Jira user, from enumerating the members of the
// application-access groups (see getApplicationRoles). account_id is the durable Atlassian
// identifier; display_name is stored so the tab reads without a per-row lookup, matching how
// filter owner names are already kept. No email -- Jira Cloud is in GDPR strict mode and the
// accountId is the identifier the rest of the app joins on.
export const CREATE_SNAPSHOT_USERS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_users (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    account_id VARCHAR(128) NOT NULL,
    display_name VARCHAR(255) NULL,
    active TINYINT NOT NULL DEFAULT 1,
    account_type VARCHAR(32) NULL,
    avatar_url VARCHAR(512) NULL,
    PRIMARY KEY (scope_key, version, account_id)
  )
`;

// Which Jira products each user is licensed for, and via which access group. A user in both
// jira-software-users and jira-servicedesk-users gets one row per product; the group is kept
// so the tab can say "licensed for Jira Software via <group>" and so a later governance
// check can flag a user who only holds a licence through a group nobody meant to grant it.
export const CREATE_SNAPSHOT_USER_ACCESS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_user_access (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    account_id VARCHAR(128) NOT NULL,
    application_key VARCHAR(64) NOT NULL,
    application_name VARCHAR(128) NULL,
    via_group_id VARCHAR(128) NOT NULL,
    via_group_name VARCHAR(255) NULL,
    PRIMARY KEY (scope_key, version, account_id, application_key, via_group_id)
  )
`;

export const CREATE_SNAPSHOT_USER_ACCESS_BY_APP_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_snapshot_user_access_by_app
    ON snapshot_user_access (scope_key, version, application_key)
`;

// Build state plus the site's own seat numbers, read straight from getApplicationRoles at
// build time. application_summary is a small JSON array -- one entry per product with
// numberOfSeats / remainingSeats / userCount -- so the tab can show "377 of 500 Jira
// Software seats used" and cross-check it against the roster this snapshot built.
export const CREATE_USER_SNAPSHOT_META_TABLE = `
  CREATE TABLE IF NOT EXISTS user_snapshot_meta (
    scope_key VARCHAR(191) NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'idle',
    version VARCHAR(64) NULL,
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    refreshed_at VARCHAR(64) NULL,
    total_users INTEGER NOT NULL DEFAULT 0,
    active_users INTEGER NOT NULL DEFAULT 0,
    application_summary LONGTEXT NULL,
    last_error TEXT NULL,
    PRIMARY KEY (scope_key)
  )
`;

// The JSM Assets (CMDB) pillar. Structure only: one row per object schema, per object type
// and per attribute. Object counts run to hundreds of thousands and are never stored here;
// the schema row carries the per-schema total the list API already returns, and per-type
// counts are a later opt-in stage.
export const CREATE_SNAPSHOT_ASSET_SCHEMAS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_asset_schemas (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    schema_id VARCHAR(64) NOT NULL,
    name VARCHAR(255) NULL,
    schema_key VARCHAR(64) NULL,
    description TEXT NULL,
    object_type_count INTEGER NOT NULL DEFAULT 0,
    object_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, version, schema_id)
  )
`;

// Hierarchical: parent_id points at another row's object_type_id. A parent_id that resolves
// to nothing in the same version is a broken hierarchy -- surfaced as a finding, not fixed.
export const CREATE_SNAPSHOT_ASSET_OBJECT_TYPES_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_asset_object_types (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    object_type_id VARCHAR(64) NOT NULL,
    schema_id VARCHAR(64) NOT NULL,
    name VARCHAR(255) NULL,
    description TEXT NULL,
    parent_id VARCHAR(64) NULL,
    inherited TINYINT NOT NULL DEFAULT 0,
    is_abstract TINYINT NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, version, object_type_id)
  )
`;

// reference_object_type_id is set only for an object-reference attribute: the object type it
// points at. A value that resolves to no row in the same version is the Assets analogue of a
// filter scoped to a deleted project.
export const CREATE_SNAPSHOT_ASSET_ATTRIBUTES_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_asset_attributes (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    attribute_id VARCHAR(64) NOT NULL,
    object_type_id VARCHAR(64) NULL,
    schema_id VARCHAR(64) NOT NULL,
    name VARCHAR(255) NULL,
    data_type VARCHAR(48) NULL,
    reference_object_type_id VARCHAR(64) NULL,
    is_system TINYINT NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, version, attribute_id)
  )
`;

export const CREATE_SNAPSHOT_ASSET_OBJECT_TYPES_BY_SCHEMA_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_snapshot_asset_object_types_by_schema
    ON snapshot_asset_object_types (scope_key, version, schema_id)
`;

// Build state plus the workspace id the gateway URLs need, and assets_enabled: false when
// the build ran fine and the answer was "Assets is not licensed here". The tab reads that
// flag to explain rather than show an empty catalogue.
export const CREATE_ASSET_SNAPSHOT_META_TABLE = `
  CREATE TABLE IF NOT EXISTS asset_snapshot_meta (
    scope_key VARCHAR(191) NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'idle',
    version VARCHAR(64) NULL,
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    refreshed_at VARCHAR(64) NULL,
    workspace_id VARCHAR(64) NULL,
    assets_enabled TINYINT NOT NULL DEFAULT 0,
    total_schemas INTEGER NOT NULL DEFAULT 0,
    total_object_types INTEGER NOT NULL DEFAULT 0,
    total_attributes INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    PRIMARY KEY (scope_key)
  )
`;

// Per-object-type live counts from the Assets AQL endpoint -- the "later opt-in stage" the
// structure snapshot's own comment names. Unversioned, like issue_scan_estate_totals: this
// is a second, slower crawl over the CURRENT structure snapshot, full-replaced on every run
// rather than tied to a structure version, so a re-run always reports against what is on
// screen now. measured_at is per-row because a crawl that fails partway through still wrote
// real counts for the types it got to before the failure.
export const CREATE_SNAPSHOT_ASSET_TYPE_COUNTS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_asset_type_counts (
    scope_key VARCHAR(191) NOT NULL,
    object_type_id VARCHAR(64) NOT NULL,
    schema_id VARCHAR(64) NOT NULL,
    object_count INTEGER NOT NULL DEFAULT 0,
    measured_at VARCHAR(64) NULL,
    PRIMARY KEY (scope_key, object_type_id)
  )
`;

// Build state for the object-count crawl, separate from asset_snapshot_meta because it is a
// separate job on a separate cadence -- an admin can rebuild the structure without waiting
// on hundreds of AQL calls, and vice versa. measured_types / unmeasured_types name the split
// so a partial crawl (one type's AQL call failed) is visible rather than silently rolled into
// a count that looks complete.
export const CREATE_ASSET_TYPE_COUNT_META_TABLE = `
  CREATE TABLE IF NOT EXISTS asset_type_count_meta (
    scope_key VARCHAR(191) NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'idle',
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    refreshed_at VARCHAR(64) NULL,
    measured_types INTEGER NOT NULL DEFAULT 0,
    unmeasured_types INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    PRIMARY KEY (scope_key)
  )
`;

// ── Access & routing schemes: permission, issue-security, notification ────────
//
// Three scheme types, one shape: a header, a set of holders (users / groups / project roles
// / application roles / special tokens like "anyone" or "assignee"), and a set of project
// assignments. scheme_type keeps them in one set of tables so the cross-pillar joins ("which
// schemes name this account", "which schemes does this project use") are one query, not three.
export const CREATE_SNAPSHOT_SCHEMES_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_schemes (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    scheme_type VARCHAR(16) NOT NULL,
    scheme_id VARCHAR(64) NOT NULL,
    name VARCHAR(255) NULL,
    description TEXT NULL,
    is_default TINYINT NOT NULL DEFAULT 0,
    default_level_id VARCHAR(64) NULL,
    PRIMARY KEY (scope_key, version, scheme_type, scheme_id)
  )
`;

// One row per (scheme, context, holder). `context` is the permission key for a permission
// scheme, the level id for a security scheme, the event id for a notification scheme --
// context_label carries its human name. holder_value is "" (not NULL) for the value-less
// holder types so it can sit in the primary key.
export const CREATE_SNAPSHOT_SCHEME_HOLDERS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_scheme_holders (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    scheme_type VARCHAR(16) NOT NULL,
    scheme_id VARCHAR(64) NOT NULL,
    context VARCHAR(128) NOT NULL,
    context_label VARCHAR(255) NULL,
    holder_type VARCHAR(48) NOT NULL,
    holder_value VARCHAR(191) NOT NULL DEFAULT '',
    holder_label VARCHAR(255) NULL,
    PRIMARY KEY (scope_key, version, scheme_type, scheme_id, context, holder_type, holder_value)
  )
`;

// The reverse-lookup index for the People cross-pillar join: every scheme that names one
// account / group / role directly.
export const CREATE_SNAPSHOT_SCHEME_HOLDERS_BY_HOLDER_INDEX = `
  CREATE INDEX idx_snapshot_scheme_holders_by_holder
  ON snapshot_scheme_holders (scope_key, version, holder_type, holder_value)
`;

// Security scheme levels, including the ones with no members (a level nobody is in makes any
// issue set to it invisible to everyone but a site admin -- a data black hole).
export const CREATE_SNAPSHOT_SCHEME_LEVELS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_scheme_levels (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    scheme_id VARCHAR(64) NOT NULL,
    level_id VARCHAR(64) NOT NULL,
    name VARCHAR(255) NULL,
    description TEXT NULL,
    is_default TINYINT NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, version, scheme_id, level_id)
  )
`;

// Which projects each scheme is assigned to -- across all three types. A scheme with no row
// here is unused clutter; two projects with wildly different schemes is sprawl.
export const CREATE_SNAPSHOT_SCHEME_PROJECTS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_scheme_projects (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    scheme_type VARCHAR(16) NOT NULL,
    scheme_id VARCHAR(64) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    project_key VARCHAR(64) NULL,
    project_name VARCHAR(255) NULL,
    PRIMARY KEY (scope_key, version, scheme_type, scheme_id, project_id)
  )
`;

export const CREATE_ACCESS_SNAPSHOT_META_TABLE = `
  CREATE TABLE IF NOT EXISTS access_snapshot_meta (
    scope_key VARCHAR(191) NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'idle',
    version VARCHAR(64) NULL,
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    refreshed_at VARCHAR(64) NULL,
    total_permission_schemes INTEGER NOT NULL DEFAULT 0,
    total_security_schemes INTEGER NOT NULL DEFAULT 0,
    total_notification_schemes INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    PRIMARY KEY (scope_key)
  )
`;

// ── Configuration drift: the change-history timeline ────────────────────────
//
// Every other pillar full-replaces its snapshot, so there is no history to diff after the
// fact. These two tables are the exception, kept deliberately thin:
//
//   snapshot_entity_digest  one row per live config entity (a scheme, a status, a field...),
//                           holding a hash of its STRUCTURAL fields only -- never usage
//                           counts, which move every scan and would drown the log in noise.
//                           Full-replaced per (pillar) each drift pass. This is the state
//                           the next pass diffs against.
//
//   config_change_log       append-only: one row per detected add / remove / modify, with a
//                           human sentence. Pruned by the retention job on age, like the
//                           audit log. This is the timeline the Changes tab renders.
export const CREATE_SNAPSHOT_ENTITY_DIGEST_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_entity_digest (
    scope_key VARCHAR(191) NOT NULL,
    pillar VARCHAR(32) NOT NULL,
    entity_type VARCHAR(48) NOT NULL,
    entity_id VARCHAR(191) NOT NULL,
    label VARCHAR(255) NULL,
    digest VARCHAR(32) NOT NULL,
    fields_json TEXT NULL,
    PRIMARY KEY (scope_key, pillar, entity_type, entity_id)
  )
`;

export const CREATE_CONFIG_CHANGE_LOG_TABLE = `
  CREATE TABLE IF NOT EXISTS config_change_log (
    scope_key VARCHAR(191) NOT NULL,
    change_id VARCHAR(64) NOT NULL,
    detected_at VARCHAR(64) NOT NULL,
    scan_version VARCHAR(64) NULL,
    pillar VARCHAR(32) NOT NULL,
    entity_type VARCHAR(48) NOT NULL,
    entity_id VARCHAR(191) NOT NULL,
    label VARCHAR(255) NULL,
    change_kind VARCHAR(16) NOT NULL,
    summary VARCHAR(1024) NULL,
    PRIMARY KEY (scope_key, change_id)
  )
`;

export const CREATE_CONFIG_CHANGE_LOG_BY_TIME_INDEX = `
  CREATE INDEX idx_config_change_log_by_time
  ON config_change_log (scope_key, detected_at)
`;

export const CREATE_DRIFT_SNAPSHOT_META_TABLE = `
  CREATE TABLE IF NOT EXISTS drift_snapshot_meta (
    scope_key VARCHAR(191) NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'idle',
    version VARCHAR(64) NULL,
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    refreshed_at VARCHAR(64) NULL,
    last_run_changes INTEGER NOT NULL DEFAULT 0,
    total_changes INTEGER NOT NULL DEFAULT 0,
    seeded_pillars TEXT NULL,
    last_error TEXT NULL,
    PRIMARY KEY (scope_key)
  )
`;

// ── Estate config: the global value lists (resolutions, priorities) ─────────
//
// Statuses and issue types get their own pillars; these are the other two things in Jira's
// "Issues" admin section. Neither has a scheme layer worth modelling yet (resolutions have
// none at all), so one table with a `kind` discriminator holds both. The governance read is
// the same duplicate-name detection the workflow and issue-type pillars already run --
// fifteen resolutions that all mean "done" wreck resolution-based reporting exactly the way
// duplicate statuses wreck status-based reporting.
export const CREATE_SNAPSHOT_ESTATE_VALUES_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_estate_values (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    kind VARCHAR(24) NOT NULL,
    item_id VARCHAR(64) NOT NULL,
    name VARCHAR(255) NULL,
    description TEXT NULL,
    is_default TINYINT NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, version, kind, item_id)
  )
`;

export const CREATE_ESTATE_SNAPSHOT_META_TABLE = `
  CREATE TABLE IF NOT EXISTS estate_snapshot_meta (
    scope_key VARCHAR(191) NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'idle',
    version VARCHAR(64) NULL,
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    refreshed_at VARCHAR(64) NULL,
    total_resolutions INTEGER NOT NULL DEFAULT 0,
    total_priorities INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    PRIMARY KEY (scope_key)
  )
`;

// ── Agile boards ────────────────────────────────────────────────────────────
//
// One row per board plus one row per column. Versioned and fully replaced per scope, like
// the estate lists: a site has a few hundred boards at most and the build finishes in one
// invocation, so nothing appends to a partial version. `config_readable` records that a
// team-managed board's configuration endpoint 404'd -- the board is still listed, its column
// and backing-filter facts are just unknown rather than absent.
export const CREATE_SNAPSHOT_BOARDS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_boards (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    board_id VARCHAR(64) NOT NULL,
    name VARCHAR(255) NULL,
    type VARCHAR(24) NULL,
    location_type VARCHAR(24) NULL,
    location_id VARCHAR(64) NULL,
    location_key VARCHAR(64) NULL,
    location_name VARCHAR(255) NULL,
    filter_id VARCHAR(64) NULL,
    sub_query TEXT NULL,
    estimation_field VARCHAR(255) NULL,
    ranking_field VARCHAR(64) NULL,
    column_count INTEGER NOT NULL DEFAULT 0,
    config_readable TINYINT NOT NULL DEFAULT 1,
    PRIMARY KEY (scope_key, version, board_id)
  )
`;

export const CREATE_SNAPSHOT_BOARD_COLUMNS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_board_columns (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    board_id VARCHAR(64) NOT NULL,
    column_index INTEGER NOT NULL,
    name VARCHAR(255) NULL,
    status_ids TEXT NULL,
    min_constraint INTEGER NULL,
    max_constraint INTEGER NULL,
    PRIMARY KEY (scope_key, version, board_id, column_index)
  )
`;

export const CREATE_BOARD_SNAPSHOT_META_TABLE = `
  CREATE TABLE IF NOT EXISTS board_snapshot_meta (
    scope_key VARCHAR(191) NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'idle',
    version VARCHAR(64) NULL,
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    refreshed_at VARCHAR(64) NULL,
    total_boards INTEGER NOT NULL DEFAULT 0,
    total_columns INTEGER NOT NULL DEFAULT 0,
    boards_unreadable INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    PRIMARY KEY (scope_key)
  )
`;

// Remediation ticketing. One row per Jira issue Observatory created for a governance
// finding: the epic (item_id = '') and one task per item to fix. Keyed on
// (scope, finding, item) so re-running never creates a duplicate -- "this finding already
// has an epic", "this filter already has a task". NOT versioned and NOT wiped with the
// snapshots: a remediation ticket outlives the scan that flagged it.
// The screen cross-signal's summary, computed once per scan and read cheaply thereafter.
//
// The cross itself is the widest join in the app -- every project's screen chain, down to
// each screen's fields, against every populated field x project pair. That is fine once on a
// queue consumer with a 900s budget and far too expensive on the Overview read, which is
// what the rest of this table exists to avoid.
//
// Both source versions are stored, not just the counts. The screen inventory and the field
// snapshot refresh independently, so a summary is only current while BOTH are still the
// versions it was computed from; readers compare and report it stale rather than presenting
// a two-builds-ago number as this morning's.
export const CREATE_SCREEN_CROSS_SUMMARY_TABLE = `
  CREATE TABLE IF NOT EXISTS screen_cross_summary (
    scope_key VARCHAR(191) NOT NULL,
    screen_version VARCHAR(64) NOT NULL,
    field_version VARCHAR(64) NOT NULL,
    computed_at VARCHAR(64) NULL,
    projects_total INTEGER NOT NULL DEFAULT 0,
    projects_resolved INTEGER NOT NULL DEFAULT 0,
    populated_field_count INTEGER NOT NULL DEFAULT 0,
    create_placements INTEGER NOT NULL DEFAULT 0,
    invisible_fields INTEGER NOT NULL DEFAULT 0,
    invisible_issues BIGINT NOT NULL DEFAULT 0,
    clutter_fields INTEGER NOT NULL DEFAULT 0,
    clutter_placements INTEGER NOT NULL DEFAULT 0,
    unreachable_fields INTEGER NOT NULL DEFAULT 0,
    usage_truncated INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key)
  )
`;

// Three counters over data the crawl already has in hand.
//
// Every one of these rides an issue the universe scan is walking anyway, requesting "*all",
// so each costs an accumulator and no Jira traffic. They exist because the pillars they feed
// could all describe their objects and none of them could say whether anyone uses one --
// which is the difference between a naming observation and a merge decision.

// Issues currently OF each type, per project. The sibling of issue_scan_status_totals, and
// distinct from issue_scan_type_buffer, which counts field x type pairs: summing that across
// fields would count an issue once per populated field on it.
export const CREATE_ISSUE_SCAN_TYPE_TOTALS_TABLE = `
  CREATE TABLE IF NOT EXISTS issue_scan_type_totals (
    scope_key VARCHAR(191) NOT NULL,
    issue_type_id VARCHAR(191) NOT NULL,
    project_id VARCHAR(191) NOT NULL,
    issue_type_name TEXT NULL,
    project_key VARCHAR(191) NULL,
    issue_count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, issue_type_id, project_id)
  )
`;

// Issues carrying each priority and each resolution, kind-discriminated the same way
// snapshot_estate_values is so the two join without translation.
//
// value_id is the empty string for an UNSET value, which is a real answer rather than a
// missing one: "1,400 issues have no resolution" is the shape of an unresolved backlog, and
// dropping those rows would silently rebase every percentage in the pillar.
export const CREATE_ISSUE_SCAN_ESTATE_TOTALS_TABLE = `
  CREATE TABLE IF NOT EXISTS issue_scan_estate_totals (
    scope_key VARCHAR(191) NOT NULL,
    kind VARCHAR(32) NOT NULL,
    value_id VARCHAR(191) NOT NULL,
    value_name TEXT NULL,
    issue_count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, kind, value_id)
  )
`;

// The most recent issue activity per account, from max(issue.updated) where that account is
// the assignee or the reporter.
//
// The People pillar's missing denominator. "This licence has had no activity in a year" is
// the only finding in the product with a currency figure attached to it, and it was blocked
// on this one column. MAX rather than an increment, so a worker re-running a slice cannot
// move the answer.
export const CREATE_ISSUE_SCAN_USER_ACTIVITY_TABLE = `
  CREATE TABLE IF NOT EXISTS issue_scan_user_activity (
    scope_key VARCHAR(191) NOT NULL,
    account_id VARCHAR(191) NOT NULL,
    display_name TEXT NULL,
    last_activity_at VARCHAR(64) NULL,
    issue_count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, account_id)
  )
`;

export const CREATE_REMEDIATION_TICKETS_TABLE = `
  CREATE TABLE IF NOT EXISTS remediation_tickets (
    scope_key VARCHAR(191) NOT NULL,
    finding_key VARCHAR(64) NOT NULL,
    pillar VARCHAR(24) NULL,
    item_id VARCHAR(191) NOT NULL,
    issue_key VARCHAR(32) NOT NULL,
    issue_id VARCHAR(32) NULL,
    is_epic TINYINT NOT NULL DEFAULT 0,
    epic_key VARCHAR(32) NULL,
    summary VARCHAR(500) NULL,
    last_status VARCHAR(64) NULL,
    last_status_category VARCHAR(24) NULL,
    assignee_account_id VARCHAR(128) NULL,
    assignee_name VARCHAR(255) NULL,
    created_by VARCHAR(128) NULL,
    created_at VARCHAR(64) NULL,
    synced_at VARCHAR(64) NULL,
    PRIMARY KEY (scope_key, finding_key, item_id)
  )
`;

// Quarter-aware successor to remediation_tickets. Remediation runs by calendar quarter: each
// finding gets one epic per quarter ("2026-Q3"), reused for the whole quarter, and the next
// quarter's epic carries whatever is flagged then. The v1 key had no period in it, so a
// second epic for the same finding would have overwritten the first one's row, and a
// re-ticketed item its old task. A primary key cannot be changed in place, hence a new
// table; v159 copies every existing row across under the quarter its epic was created in.
export const CREATE_REMEDIATION_TICKETS_V2_TABLE = `
  CREATE TABLE IF NOT EXISTS remediation_tickets_v2 (
    scope_key VARCHAR(191) NOT NULL,
    finding_key VARCHAR(64) NOT NULL,
    period VARCHAR(8) NOT NULL,
    pillar VARCHAR(24) NULL,
    item_id VARCHAR(191) NOT NULL,
    issue_key VARCHAR(32) NOT NULL,
    issue_id VARCHAR(32) NULL,
    is_epic TINYINT NOT NULL DEFAULT 0,
    epic_key VARCHAR(32) NULL,
    summary VARCHAR(500) NULL,
    last_status VARCHAR(64) NULL,
    last_status_category VARCHAR(24) NULL,
    assignee_account_id VARCHAR(128) NULL,
    assignee_name VARCHAR(255) NULL,
    created_by VARCHAR(128) NULL,
    created_at VARCHAR(64) NULL,
    synced_at VARCHAR(64) NULL,
    done_at VARCHAR(64) NULL,
    status_changed_at VARCHAR(64) NULL,
    PRIMARY KEY (scope_key, finding_key, period, item_id)
  )
`;

// Every row takes the quarter of its finding's EPIC, not its own created_at: a task added in
// October under an epic raised in September belongs to that September (Q3) epic. created_at
// is an ISO string, so its first ten characters are a date QUARTER() can read. A finding with
// no epic row cannot occur in practice; "legacy" keeps such a row rather than dropping it.
const COPY_REMEDIATION_TICKETS_TO_V2 = `
  INSERT IGNORE INTO remediation_tickets_v2
    (scope_key, finding_key, period, pillar, item_id, issue_key, issue_id, is_epic, epic_key,
     summary, last_status, last_status_category, assignee_account_id, assignee_name,
     created_by, created_at, synced_at)
  SELECT t.scope_key, t.finding_key,
     COALESCE(CONCAT(SUBSTRING(e.created_at, 1, 4), '-Q', QUARTER(SUBSTRING(e.created_at, 1, 10))), 'legacy'),
     t.pillar, t.item_id, t.issue_key, t.issue_id, t.is_epic, t.epic_key,
     t.summary, t.last_status, t.last_status_category, t.assignee_account_id, t.assignee_name,
     t.created_by, t.created_at, t.synced_at
  FROM remediation_tickets t
  LEFT JOIN remediation_tickets e
    ON e.scope_key = t.scope_key AND e.finding_key = t.finding_key AND e.item_id = ''
`;

// Append-only record of privileged actions: who did what, when, and whether it was
// allowed. Deliberately not versioned by snapshot and deliberately NOT wiped by
// clearAllSnapshotData -- an audit trail that a privileged action can erase is not an
// audit trail. Pruned only by the scheduled retention job, on age.
//
// actor_id is the Atlassian accountId. No display names or emails are stored: the
// accountId is already the durable identifier, and resolving it to a person is a
// deliberate step someone takes in Jira rather than something this table leaks.
export const CREATE_AUDIT_LOG_TABLE = `
  CREATE TABLE IF NOT EXISTS audit_log (
    id BIGINT NOT NULL AUTO_INCREMENT,
    scope_key VARCHAR(191) NOT NULL,
    at VARCHAR(64) NOT NULL,
    actor_id VARCHAR(128) NULL,
    action VARCHAR(128) NOT NULL,
    outcome VARCHAR(32) NOT NULL,
    detail TEXT NULL,
    PRIMARY KEY (id)
  )
`;

export const CREATE_AUDIT_LOG_SCOPE_AT_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_audit_log_scope_at ON audit_log (scope_key, at)
`;

// What each workflow enforces (workflow-rules.js). Four tables, all versioned with the
// workflow snapshot and replaced with it:
//
//   snapshot_workflow_transitions  every transition: type, from-statuses, to-status
//   snapshot_workflow_rules        each condition / validator / post-function on one -- the
//                                  rule key and a safe summary, NEVER its raw parameters
//   snapshot_workflow_properties   every property on a status or a transition
//   snapshot_workflow_refs         what those point at (field, group, role, permission,
//                                  status, user), one row per reference, carrying enough
//                                  context to render without a join
//
// refs is keyed by a per-build sequence rather than by its context columns: the natural key
// (workflow name + owner + rule + property key) runs past TiDB's 3072-byte key limit.
export const CREATE_SNAPSHOT_WORKFLOW_TRANSITIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_workflow_transitions (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    workflow_name VARCHAR(255) NOT NULL,
    transition_id VARCHAR(64) NOT NULL,
    transition_name VARCHAR(255) NULL,
    transition_type VARCHAR(16) NULL,
    from_status_ids TEXT NULL,
    to_status_id VARCHAR(64) NULL,
    rule_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, version, workflow_name, transition_id)
  )
`;

export const CREATE_SNAPSHOT_WORKFLOW_RULES_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_workflow_rules (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    workflow_name VARCHAR(255) NOT NULL,
    transition_id VARCHAR(64) NOT NULL,
    rule_seq INTEGER NOT NULL,
    rule_kind VARCHAR(16) NOT NULL,
    rule_key VARCHAR(191) NULL,
    summary VARCHAR(500) NULL,
    PRIMARY KEY (scope_key, version, workflow_name, transition_id, rule_seq)
  )
`;

export const CREATE_SNAPSHOT_WORKFLOW_PROPERTIES_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_workflow_properties (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    workflow_name VARCHAR(255) NOT NULL,
    owner_kind VARCHAR(16) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    prop_key VARCHAR(160) NOT NULL,
    prop_value TEXT NULL,
    PRIMARY KEY (scope_key, version, workflow_name, owner_kind, owner_id, prop_key)
  )
`;

export const CREATE_SNAPSHOT_WORKFLOW_REFS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_workflow_refs (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    seq INTEGER NOT NULL,
    ref_type VARCHAR(16) NOT NULL,
    ref_id VARCHAR(191) NOT NULL,
    ref_label VARCHAR(255) NULL,
    ref_missing TINYINT NULL,
    workflow_name VARCHAR(255) NOT NULL,
    source VARCHAR(16) NOT NULL,
    owner_kind VARCHAR(16) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    rule_seq INTEGER NULL,
    prop_key VARCHAR(160) NULL,
    PRIMARY KEY (scope_key, version, seq)
  )
`;

// One row per workflow: the inventory #16 asked for, and what lets "inactive" exclude
// team-managed workflows (scope PROJECT), which never sit in a scheme at all.
export const CREATE_SNAPSHOT_WORKFLOWS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_workflows (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    workflow_name VARCHAR(255) NOT NULL,
    workflow_id VARCHAR(64) NULL,
    scope_type VARCHAR(16) NULL,
    scope_project_id VARCHAR(64) NULL,
    status_count INTEGER NOT NULL DEFAULT 0,
    transition_count INTEGER NOT NULL DEFAULT 0,
    rule_count INTEGER NOT NULL DEFAULT 0,
    scheme_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, version, workflow_name)
  )
`;

// "Which workflow rules touch this field / this group" is a single-key read.
export const CREATE_SNAPSHOT_WORKFLOW_REFS_BY_TARGET_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_snapshot_workflow_refs_target
    ON snapshot_workflow_refs (scope_key, version, ref_type, ref_id)
`;

// The field behaviour pillar (fieldconfig-engine.js): field schemes, or legacy field
// configuration schemes + field configurations, normalised into one shape. Findings are
// computed at build time and stored on the scheme and configuration rows.
export const CREATE_FIELDCONFIG_SNAPSHOT_META_TABLE = `
  CREATE TABLE IF NOT EXISTS fieldconfig_snapshot_meta (
    scope_key VARCHAR(191) NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'idle',
    version VARCHAR(64) NULL,
    started_at VARCHAR(64) NULL,
    completed_at VARCHAR(64) NULL,
    refreshed_at VARCHAR(64) NULL,
    source VARCHAR(32) NULL,
    fallback_reason VARCHAR(500) NULL,
    total_schemes INTEGER NOT NULL DEFAULT 0,
    total_configs INTEGER NOT NULL DEFAULT 0,
    unread_owners INTEGER NOT NULL DEFAULT 0,
    summary_json TEXT NULL,
    inconsistent_json TEXT NULL,
    last_error TEXT NULL,
    PRIMARY KEY (scope_key)
  )
`;

export const CREATE_SNAPSHOT_FIELDCFG_SCHEMES_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_fieldcfg_schemes (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    scheme_id VARCHAR(64) NOT NULL,
    source VARCHAR(32) NOT NULL,
    source_id VARCHAR(64) NULL,
    name VARCHAR(255) NULL,
    description TEXT NULL,
    is_default TINYINT NOT NULL DEFAULT 0,
    project_count INTEGER NOT NULL DEFAULT 0,
    measured TINYINT NULL,
    field_count INTEGER NULL,
    required_count INTEGER NOT NULL DEFAULT 0,
    restricted_count INTEGER NOT NULL DEFAULT 0,
    finding_codes TEXT NULL,
    duplicate_of VARCHAR(64) NULL,
    PRIMARY KEY (scope_key, version, scheme_id)
  )
`;

export const CREATE_SNAPSHOT_FIELDCFG_SCHEME_PROJECTS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_fieldcfg_scheme_projects (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    scheme_id VARCHAR(64) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    project_key VARCHAR(64) NULL,
    project_name VARCHAR(255) NULL,
    PRIMARY KEY (scope_key, version, scheme_id, project_id)
  )
`;

export const CREATE_SNAPSHOT_FIELDCFG_CONFIGS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_fieldcfg_configs (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    config_id VARCHAR(64) NOT NULL,
    source_id VARCHAR(64) NULL,
    name VARCHAR(255) NULL,
    description TEXT NULL,
    is_default TINYINT NOT NULL DEFAULT 0,
    used TINYINT NOT NULL DEFAULT 0,
    items_read TINYINT NOT NULL DEFAULT 0,
    total_field_count INTEGER NULL,
    notable_count INTEGER NOT NULL DEFAULT 0,
    required_count INTEGER NOT NULL DEFAULT 0,
    hidden_count INTEGER NOT NULL DEFAULT 0,
    required_hidden TEXT NULL,
    finding_codes TEXT NULL,
    duplicate_of VARCHAR(64) NULL,
    PRIMARY KEY (scope_key, version, config_id)
  )
`;

export const CREATE_SNAPSHOT_FIELDCFG_MAPPINGS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_fieldcfg_mappings (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    scheme_id VARCHAR(64) NOT NULL,
    work_type_id VARCHAR(64) NOT NULL,
    config_id VARCHAR(64) NOT NULL,
    PRIMARY KEY (scope_key, version, scheme_id, work_type_id)
  )
`;

export const CREATE_SNAPSHOT_FIELDCFG_ITEMS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_fieldcfg_items (
    scope_key VARCHAR(191) NOT NULL,
    version VARCHAR(64) NOT NULL,
    owner_kind VARCHAR(8) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    work_type_id VARCHAR(64) NOT NULL,
    field_id VARCHAR(128) NOT NULL,
    associated TINYINT NULL,
    hidden TINYINT NULL,
    required TINYINT NULL,
    description TEXT NULL,
    renderer VARCHAR(64) NULL,
    restricted_to TEXT NULL,
    PRIMARY KEY (scope_key, version, owner_kind, owner_id, work_type_id, field_id)
  )
`;

// "What does each scheme do to this field" is a single-key read.
export const CREATE_SNAPSHOT_FIELDCFG_ITEMS_BY_FIELD_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_snapshot_fieldcfg_items_field
    ON snapshot_fieldcfg_items (scope_key, version, field_id)
`;

// Every ADD COLUMN below is written IF NOT EXISTS, without exception.
//
// The CREATE TABLE constants above describe the CURRENT shape of each table, not the
// shape it had when its migration was first written -- a column added later gets appended
// to the CREATE *and* enqueued as an ALTER. On a database that already existed, the ALTER
// does the work. On a fresh database the CREATE already produced the column, so a bare
// ALTER fails with a duplicate-column error, the runner stops there, and every migration
// after it never runs.
//
// That is not hypothetical: v010 adds snapshot_meta.job_token, which CREATE_SNAPSHOT_META_TABLE
// has contained since the initial commit. Any database built from scratch by this code
// died at v010 until this was fixed -- it went unnoticed only because every environment
// had a pre-existing database. Deploying to a fresh staging site surfaced it.
//
// So: idempotent ALTERs are the rule here, not a patch applied where a collision is known.
// Applying it only to the columns that collide today leaves the trap armed for whoever
// adds the next column. project-store.migrations.test.js enforces this mechanically.
const projectStoreMigrations = migrationRunner
  .enqueue("v001_create_snapshot_fields_table", CREATE_SNAPSHOT_FIELDS_TABLE)
  .enqueue("v002_create_field_summaries_table", CREATE_FIELD_SUMMARIES_TABLE)
  .enqueue("v003_create_field_summaries_refresh_index", CREATE_SUMMARY_REFRESH_INDEX)
  .enqueue("v004_create_snapshot_project_usage_table", CREATE_SNAPSHOT_PROJECT_USAGE_TABLE)
  .enqueue("v005_create_snapshot_project_usage_index", CREATE_SNAPSHOT_PROJECT_USAGE_INDEX)
  .enqueue("v006_alter_snapshot_fields_add_fingerprint", "ALTER TABLE snapshot_fields ADD COLUMN IF NOT EXISTS project_usage_fingerprint VARCHAR(128) NULL")
  .enqueue("v007_create_snapshot_meta_table", CREATE_SNAPSHOT_META_TABLE)
  .enqueue("v008_alter_snapshot_fields_add_usage_status", "ALTER TABLE snapshot_fields ADD COLUMN IF NOT EXISTS usage_status VARCHAR(32) NOT NULL DEFAULT 'ready'")
  .enqueue("v009_alter_snapshot_fields_add_usage_status_detail", "ALTER TABLE snapshot_fields ADD COLUMN IF NOT EXISTS usage_status_detail TEXT NULL")
  .enqueue("v010_alter_snapshot_meta_add_job_token", "ALTER TABLE snapshot_meta ADD COLUMN IF NOT EXISTS job_token VARCHAR(96) NULL")
  .enqueue("v011_alter_snapshot_meta_add_processed_fields", "ALTER TABLE snapshot_meta ADD COLUMN IF NOT EXISTS processed_fields INTEGER NOT NULL DEFAULT 0")
  .enqueue("v012_alter_snapshot_meta_add_progress_log", "ALTER TABLE snapshot_meta ADD COLUMN IF NOT EXISTS progress_log LONGTEXT NULL")
  .enqueue("v013_alter_snapshot_meta_add_building_version", "ALTER TABLE snapshot_meta ADD COLUMN IF NOT EXISTS building_version VARCHAR(64) NULL")
  .enqueue("v014_alter_field_summaries_add_started_at", "ALTER TABLE field_summaries ADD COLUMN IF NOT EXISTS started_at VARCHAR(64) NULL")
  .enqueue("v015_alter_field_summaries_add_completed_at", "ALTER TABLE field_summaries ADD COLUMN IF NOT EXISTS completed_at VARCHAR(64) NULL")
  .enqueue("v016_alter_field_summaries_add_last_error", "ALTER TABLE field_summaries ADD COLUMN IF NOT EXISTS last_error TEXT NULL")
  .enqueue("v017_alter_field_summaries_add_progress_log", "ALTER TABLE field_summaries ADD COLUMN IF NOT EXISTS progress_log LONGTEXT NULL")
  .enqueue("v018_alter_field_summaries_add_job_token", "ALTER TABLE field_summaries ADD COLUMN IF NOT EXISTS job_token VARCHAR(96) NULL")
  .enqueue("v019_alter_field_summaries_add_processed_issue_count", "ALTER TABLE field_summaries ADD COLUMN IF NOT EXISTS processed_issue_count BIGINT NOT NULL DEFAULT 0")
  .enqueue("v020_alter_field_summaries_add_estimated_issue_total", "ALTER TABLE field_summaries ADD COLUMN IF NOT EXISTS estimated_issue_total BIGINT NOT NULL DEFAULT 0")
  .enqueue("v021_alter_field_summaries_add_next_start_at", "ALTER TABLE field_summaries ADD COLUMN IF NOT EXISTS next_start_at BIGINT NOT NULL DEFAULT 0")
  .enqueue("v022_alter_field_summaries_add_next_page_token", "ALTER TABLE field_summaries ADD COLUMN IF NOT EXISTS next_page_token TEXT NULL")
  .enqueue("v023_create_saved_reports_table", CREATE_SAVED_REPORTS_TABLE)
  .enqueue("v024_alter_snapshot_project_usage_add_latest_field_change_at", "ALTER TABLE snapshot_project_usage ADD COLUMN IF NOT EXISTS latest_field_change_at VARCHAR(64) NULL")
  .enqueue("v025_alter_snapshot_project_usage_add_latest_issue_key", "ALTER TABLE snapshot_project_usage ADD COLUMN IF NOT EXISTS latest_issue_key VARCHAR(64) NULL")
  .enqueue("v026_alter_snapshot_project_usage_add_latest_issue_updated_at", "ALTER TABLE snapshot_project_usage ADD COLUMN IF NOT EXISTS latest_issue_updated_at VARCHAR(64) NULL")
  .enqueue("v027_create_report_jobs_table", CREATE_REPORT_JOBS_TABLE)
  .enqueue("v028_create_issue_scan_meta_table", CREATE_ISSUE_SCAN_META_TABLE)
  .enqueue("v029_create_issue_scan_buffer_table", CREATE_ISSUE_SCAN_BUFFER_TABLE)
  .enqueue("v030_create_issue_scan_project_totals_table", CREATE_ISSUE_SCAN_PROJECT_TOTALS_TABLE)
  .enqueue("v031_alter_issue_scan_meta_add_next_page_token", "ALTER TABLE issue_scan_meta ADD COLUMN IF NOT EXISTS next_page_token TEXT NULL")
  .enqueue("v032_alter_issue_scan_meta_add_next_start_at", "ALTER TABLE issue_scan_meta ADD COLUMN IF NOT EXISTS next_start_at BIGINT NULL DEFAULT 0")
  .enqueue("v033_create_issue_scan_workers_table", CREATE_ISSUE_SCAN_WORKERS_TABLE)
  .enqueue("v034_create_field_options_cache_table", CREATE_FIELD_OPTIONS_CACHE_TABLE)
  .enqueue("v035_create_rqt_field_index_table", CREATE_RQT_FIELD_INDEX_TABLE)
  .enqueue("v036_create_rqt_issue_keys_table", CREATE_RQT_ISSUE_KEYS_TABLE)
  .enqueue("v037_create_rqt_value_issue_index_table", CREATE_RQT_VALUE_ISSUE_INDEX_TABLE)
  .enqueue("v038_create_rqt_field_issue_index_table", CREATE_RQT_FIELD_ISSUE_INDEX_TABLE)
  .enqueue("v039_alter_issue_scan_meta_add_scan_history", "ALTER TABLE issue_scan_meta ADD COLUMN IF NOT EXISTS scan_history LONGTEXT NULL")
  .enqueue("v040_create_snapshot_workflow_schemes_table", CREATE_SNAPSHOT_WORKFLOW_SCHEMES_TABLE)
  .enqueue("v041_create_snapshot_workflow_scheme_projects_table", CREATE_SNAPSHOT_WORKFLOW_SCHEME_PROJECTS_TABLE)
  .enqueue("v042_create_workflow_scheme_projects_by_project_index", CREATE_SNAPSHOT_WORKFLOW_SCHEME_PROJECTS_BY_PROJECT_INDEX)
  .enqueue("v043_create_snapshot_statuses_table", CREATE_SNAPSHOT_STATUSES_TABLE)
  .enqueue("v044_create_workflow_snapshot_meta_table", CREATE_WORKFLOW_SNAPSHOT_META_TABLE)
  .enqueue("v045_create_audit_log_table", CREATE_AUDIT_LOG_TABLE)
  .enqueue("v046_create_audit_log_scope_at_index", CREATE_AUDIT_LOG_SCOPE_AT_INDEX)
  .enqueue("v047_create_snapshot_workflow_statuses_table", CREATE_SNAPSHOT_WORKFLOW_STATUSES_TABLE)
  .enqueue("v048_create_issue_scan_status_totals_table", CREATE_ISSUE_SCAN_STATUS_TOTALS_TABLE)
  .enqueue("v049_create_status_history_totals_table", CREATE_STATUS_HISTORY_TOTALS_TABLE)
  .enqueue("v050_create_automation_references_table", CREATE_AUTOMATION_REFERENCES_TABLE)
  .enqueue("v051_create_automation_references_rule_index", CREATE_AUTOMATION_REFERENCES_RULE_INDEX)
  .enqueue("v052_create_automation_rules_table", CREATE_AUTOMATION_RULES_TABLE)
  .enqueue("v053_create_automation_findings_table", CREATE_AUTOMATION_FINDINGS_TABLE)
  .enqueue("v054_create_automation_findings_severity_index", CREATE_AUTOMATION_FINDINGS_SEVERITY_INDEX)
  .enqueue("v055_create_snapshot_screens_table", CREATE_SNAPSHOT_SCREENS_TABLE)
  .enqueue("v056_create_snapshot_screen_tabs_table", CREATE_SNAPSHOT_SCREEN_TABS_TABLE)
  .enqueue("v057_create_snapshot_screen_fields_table", CREATE_SNAPSHOT_SCREEN_FIELDS_TABLE)
  .enqueue("v058_create_snapshot_screen_fields_by_field_index", CREATE_SNAPSHOT_SCREEN_FIELDS_BY_FIELD_INDEX)
  .enqueue("v059_create_snapshot_screen_schemes_table", CREATE_SNAPSHOT_SCREEN_SCHEMES_TABLE)
  .enqueue("v060_create_snapshot_screen_scheme_operations_table", CREATE_SNAPSHOT_SCREEN_SCHEME_OPERATIONS_TABLE)
  .enqueue("v061_create_snapshot_itss_table", CREATE_SNAPSHOT_ITSS_TABLE)
  .enqueue("v062_create_snapshot_itss_mappings_table", CREATE_SNAPSHOT_ITSS_MAPPINGS_TABLE)
  .enqueue("v063_create_snapshot_itss_projects_table", CREATE_SNAPSHOT_ITSS_PROJECTS_TABLE)
  .enqueue("v064_create_snapshot_itss_projects_by_project_index", CREATE_SNAPSHOT_ITSS_PROJECTS_BY_PROJECT_INDEX)
  .enqueue("v065_create_screen_snapshot_meta_table", CREATE_SCREEN_SNAPSHOT_META_TABLE)
  .enqueue("v066_create_transition_screens_table", CREATE_SNAPSHOT_TRANSITION_SCREENS_TABLE)
  .enqueue("v067_create_transition_screens_by_screen_index", CREATE_SNAPSHOT_TRANSITION_SCREENS_BY_SCREEN_INDEX)
  // v066 and v067 keep the transition tables' names: they already ran on development under
  // them, and the runner keys on the name. Rebinding v066 to a different table would make
  // it look applied and silently skip creating this one.
  .enqueue("v068_create_health_history_table", CREATE_HEALTH_HISTORY_TABLE)
  .enqueue("v069_create_full_scan_meta_table", CREATE_FULL_SCAN_META_TABLE)
  .enqueue("v070_create_automation_rule_projects_table", CREATE_AUTOMATION_RULE_PROJECTS_TABLE)
  .enqueue("v071_create_automation_rule_projects_by_project_index", CREATE_AUTOMATION_RULE_PROJECTS_BY_PROJECT_INDEX)
  // NULL, not 0: a snapshot built before transition capture existed never looked, and
  // that is a different fact from having looked and found none. Without this column the
  // two are indistinguishable, and the tab reported the first as the second.
  .enqueue("v072_alter_workflow_meta_add_transition_screens",
    "ALTER TABLE workflow_snapshot_meta ADD COLUMN IF NOT EXISTS transition_screens INTEGER NULL")
  .enqueue("v073_create_automation_cascades_table", CREATE_AUTOMATION_CASCADES_TABLE)
  .enqueue("v074_create_automation_cascades_target_index", CREATE_AUTOMATION_CASCADES_TARGET_INDEX)
  .enqueue("v075_create_issue_scan_project_activity_table", CREATE_ISSUE_SCAN_PROJECT_ACTIVITY_TABLE)
  .enqueue("v076_create_snapshot_filters_table", CREATE_SNAPSHOT_FILTERS_TABLE)
  .enqueue("v077_create_snapshot_filters_jql_index", CREATE_SNAPSHOT_FILTERS_JQL_INDEX)
  .enqueue("v078_create_snapshot_filter_refs_table", CREATE_SNAPSHOT_FILTER_REFS_TABLE)
  .enqueue("v079_create_snapshot_filter_refs_label_index", CREATE_SNAPSHOT_FILTER_REFS_LABEL_INDEX)
  .enqueue("v080_create_snapshot_filter_shares_table", CREATE_SNAPSHOT_FILTER_SHARES_TABLE)
  .enqueue("v081_create_filter_snapshot_meta_table", CREATE_FILTER_SNAPSHOT_META_TABLE)
  .enqueue("v082_create_snapshot_dashboards_table", CREATE_SNAPSHOT_DASHBOARDS_TABLE)
  .enqueue("v083_create_snapshot_dashboard_gadgets_table", CREATE_SNAPSHOT_DASHBOARD_GADGETS_TABLE)
  .enqueue("v084_create_snapshot_dashboard_shares_table", CREATE_SNAPSHOT_DASHBOARD_SHARES_TABLE)
  .enqueue("v085_create_dashboard_snapshot_meta_table", CREATE_DASHBOARD_SNAPSHOT_META_TABLE)
  // Resumable-build state for the filter and dashboard inventories.
  //
  // Both were single-invocation builds and both died at the 900s ceiling on a large site. These
  // five columns are what lets them checkpoint instead: the version being written (kept apart
  // from the published `version`, so a reader never sees a half-built snapshot as current), the
  // token that distinguishes a build resuming itself from a second person clicking Rebuild, an
  // opaque JSON cursor, and progress for the UI.
  //
  // `updated_at` is the heartbeat and is load-bearing: staleness is judged from it rather than
  // started_at, or a long healthy build would be declared abandoned while still working.
  .enqueue("v086_alter_filter_meta_add_building_version", "ALTER TABLE filter_snapshot_meta ADD COLUMN IF NOT EXISTS building_version VARCHAR(64) NULL")
  .enqueue("v087_alter_filter_meta_add_build_token", "ALTER TABLE filter_snapshot_meta ADD COLUMN IF NOT EXISTS build_token VARCHAR(96) NULL")
  .enqueue("v088_alter_filter_meta_add_build_cursor", "ALTER TABLE filter_snapshot_meta ADD COLUMN IF NOT EXISTS build_cursor TEXT NULL")
  .enqueue("v089_alter_filter_meta_add_processed", "ALTER TABLE filter_snapshot_meta ADD COLUMN IF NOT EXISTS processed INTEGER NOT NULL DEFAULT 0")
  .enqueue("v090_alter_filter_meta_add_total_expected", "ALTER TABLE filter_snapshot_meta ADD COLUMN IF NOT EXISTS total_expected INTEGER NOT NULL DEFAULT 0")
  .enqueue("v091_alter_filter_meta_add_updated_at", "ALTER TABLE filter_snapshot_meta ADD COLUMN IF NOT EXISTS updated_at VARCHAR(64) NULL")
  .enqueue("v092_alter_dashboard_meta_add_building_version", "ALTER TABLE dashboard_snapshot_meta ADD COLUMN IF NOT EXISTS building_version VARCHAR(64) NULL")
  .enqueue("v093_alter_dashboard_meta_add_build_token", "ALTER TABLE dashboard_snapshot_meta ADD COLUMN IF NOT EXISTS build_token VARCHAR(96) NULL")
  .enqueue("v094_alter_dashboard_meta_add_build_cursor", "ALTER TABLE dashboard_snapshot_meta ADD COLUMN IF NOT EXISTS build_cursor TEXT NULL")
  .enqueue("v095_alter_dashboard_meta_add_processed", "ALTER TABLE dashboard_snapshot_meta ADD COLUMN IF NOT EXISTS processed INTEGER NOT NULL DEFAULT 0")
  .enqueue("v096_alter_dashboard_meta_add_total_expected", "ALTER TABLE dashboard_snapshot_meta ADD COLUMN IF NOT EXISTS total_expected INTEGER NOT NULL DEFAULT 0")
  .enqueue("v097_alter_dashboard_meta_add_updated_at", "ALTER TABLE dashboard_snapshot_meta ADD COLUMN IF NOT EXISTS updated_at VARCHAR(64) NULL")
  // Marks a dashboard as having had its gadget list walked, whether or not that walk could
  // read anything. Distinct from gadget_count, which is NULL both for "not yet walked" and for
  // "walked and unreadable" -- without this flag the resumable build would keep handing the
  // unreadable ones back to itself and never terminate on a site with one broken dashboard.
  .enqueue("v098_alter_snapshot_dashboards_add_gadget_walk_done", "ALTER TABLE snapshot_dashboards ADD COLUMN IF NOT EXISTS gadget_walk_done TINYINT NOT NULL DEFAULT 0")
  // Per-slice cursors for the issue crawl. A worker used to hold one JQL and one page token,
  // which meant one request in flight against a concurrency budget of four. Slices are how it
  // uses the rest; each carries its own query, cursor and done flag.
  .enqueue("v099_alter_issue_scan_workers_add_slices", "ALTER TABLE issue_scan_workers ADD COLUMN IF NOT EXISTS slices_json LONGTEXT NULL")
  // full_scan_meta has existed since v069 and was never written to -- the orchestrator was
  // built and never wired. Wiring it needs two columns it did not anticipate: a heartbeat, and
  // a count of how many times a handoff stage has been waited on.
  //
  // `polls` bounds that wait. Filters, dashboards and the issue crawl are multi-invocation
  // machines with their own state; the orchestrator starts them and waits by re-queueing
  // itself on a delay. Counting the waits is what stops a pillar that dies without writing a
  // terminal state from holding the whole scan open forever.
  .enqueue("v100_alter_full_scan_meta_add_updated_at", "ALTER TABLE full_scan_meta ADD COLUMN IF NOT EXISTS updated_at VARCHAR(64) NULL")
  .enqueue("v101_alter_full_scan_meta_add_polls", "ALTER TABLE full_scan_meta ADD COLUMN IF NOT EXISTS polls INTEGER NOT NULL DEFAULT 0")
  // The gadget -> filter link, which is what makes dashboard -> field resolvable at all.
  //
  // config_walk_done is separate from filter_id for the same reason gadget_walk_done is
  // separate from gadget_count: NULL filter_id means both "not looked at yet" and "looked at,
  // points at no filter", and without the flag the build hands the second kind back to itself
  // forever.
  .enqueue("v102_alter_dashboard_gadgets_add_filter_id", "ALTER TABLE snapshot_dashboard_gadgets ADD COLUMN IF NOT EXISTS filter_id VARCHAR(64) NULL")
  .enqueue("v103_alter_dashboard_gadgets_add_config_walk_done", "ALTER TABLE snapshot_dashboard_gadgets ADD COLUMN IF NOT EXISTS config_walk_done TINYINT NOT NULL DEFAULT 0")
  // The quick scan. Both scan types share full_scan_meta and must never run concurrently --
  // they would otherwise race each other over the same handoff-stage builds -- so which one
  // is running has to be recorded on the shared row, not inferred from the stage list.
  .enqueue("v104_alter_full_scan_meta_add_scan_type", "ALTER TABLE full_scan_meta ADD COLUMN IF NOT EXISTS scan_type VARCHAR(16) NULL")
  .enqueue("v105_alter_full_scan_meta_add_quick_scan_window_hours", "ALTER TABLE full_scan_meta ADD COLUMN IF NOT EXISTS quick_scan_window_hours INTEGER NULL")
  // Resilience bookkeeping. `recovery_count` was written by the stall watchdog since it
  // shipped but had no column to land in, so it always read back as 0 -- the "give up after
  // 3 kicks" bound never engaged. `sweep` counts full retry passes over the stage list;
  // `stage_progress_sig` is the last-seen progress signature of the handoff sub-build in
  // flight, so a slow-but-advancing build resets its patience counter instead of being
  // abandoned. All three are on the shared row because both scan types read them.
  .enqueue("v106_alter_full_scan_meta_add_recovery_count", "ALTER TABLE full_scan_meta ADD COLUMN IF NOT EXISTS recovery_count INTEGER NOT NULL DEFAULT 0")
  .enqueue("v107_alter_full_scan_meta_add_sweep", "ALTER TABLE full_scan_meta ADD COLUMN IF NOT EXISTS sweep INTEGER NOT NULL DEFAULT 0")
  .enqueue("v108_alter_full_scan_meta_add_stage_progress_sig", "ALTER TABLE full_scan_meta ADD COLUMN IF NOT EXISTS stage_progress_sig VARCHAR(255) NULL")
  // The month histogram gets a staging buffer so a half-finished crawl can no longer wipe
  // the live series -- the same buffer/promote shape issue_scan_buffer already has.
  .enqueue("v109_create_issue_scan_activity_buffer_table", CREATE_ISSUE_SCAN_ACTIVITY_BUFFER_TABLE)
  // Per-run scan history. full_scan_meta holds only the latest run, so run-over-run deltas
  // and a "recent runs" list had nothing to read.
  .enqueue("v110_create_full_scan_runs_table", CREATE_FULL_SCAN_RUNS_TABLE)
  .enqueue("v111_create_full_scan_runs_by_completed_index", CREATE_FULL_SCAN_RUNS_BY_COMPLETED_INDEX)
  // The issue type pillar: the type catalog, the schemes that gate which types a project may
  // use, their ordered membership and project assignments, plus a meta row versioned on its
  // own cadence. The issue-type -> screen layer (snapshot_issue_type_screen_schemes) already
  // shipped with the screen pillar at v061-v064; this is the tier above it.
  .enqueue("v112_create_snapshot_issue_types_table", CREATE_SNAPSHOT_ISSUE_TYPES_TABLE)
  .enqueue("v113_create_snapshot_issue_type_schemes_table", CREATE_SNAPSHOT_ISSUE_TYPE_SCHEMES_TABLE)
  .enqueue("v114_create_snapshot_issue_type_scheme_items_table", CREATE_SNAPSHOT_ISSUE_TYPE_SCHEME_ITEMS_TABLE)
  .enqueue("v115_create_snapshot_issue_type_scheme_projects_table", CREATE_SNAPSHOT_ISSUE_TYPE_SCHEME_PROJECTS_TABLE)
  .enqueue("v116_create_snapshot_its_projects_by_project_index", CREATE_SNAPSHOT_ISSUE_TYPE_SCHEME_PROJECTS_BY_PROJECT_INDEX)
  .enqueue("v117_create_issue_type_snapshot_meta_table", CREATE_ISSUE_TYPE_SNAPSHOT_META_TABLE)
  // Field x issue-type usage: the third axis of the Field Browser, filled by the issue crawl.
  .enqueue("v118_create_issue_scan_type_buffer_table", CREATE_ISSUE_SCAN_TYPE_BUFFER_TABLE)
  .enqueue("v119_create_snapshot_field_type_usage_table", CREATE_SNAPSHOT_FIELD_TYPE_USAGE_TABLE)
  .enqueue("v120_create_snapshot_field_type_usage_index", CREATE_SNAPSHOT_FIELD_TYPE_USAGE_INDEX)
  // The People pillar: the licensed-user roster (from application-access group membership)
  // and which products each user holds, versioned on its own cadence like the issue-type
  // pillar. Project roles, activity and ownership joins land in follow-up migrations.
  .enqueue("v121_create_snapshot_users_table", CREATE_SNAPSHOT_USERS_TABLE)
  .enqueue("v122_create_snapshot_user_access_table", CREATE_SNAPSHOT_USER_ACCESS_TABLE)
  .enqueue("v123_create_snapshot_user_access_by_app_index", CREATE_SNAPSHOT_USER_ACCESS_BY_APP_INDEX)
  .enqueue("v124_create_user_snapshot_meta_table", CREATE_USER_SNAPSHOT_META_TABLE)

  // ── v125-v129: the JSM Assets (CMDB) pillar ──────────────────────────────
  .enqueue("v125_create_snapshot_asset_schemas_table", CREATE_SNAPSHOT_ASSET_SCHEMAS_TABLE)
  .enqueue("v126_create_snapshot_asset_object_types_table", CREATE_SNAPSHOT_ASSET_OBJECT_TYPES_TABLE)
  .enqueue("v127_create_snapshot_asset_attributes_table", CREATE_SNAPSHOT_ASSET_ATTRIBUTES_TABLE)
  .enqueue("v128_create_snapshot_asset_object_types_by_schema_index", CREATE_SNAPSHOT_ASSET_OBJECT_TYPES_BY_SCHEMA_INDEX)
  .enqueue("v129_create_asset_snapshot_meta_table", CREATE_ASSET_SNAPSHOT_META_TABLE)

  // ── v130-v132: field x user (user-picker value) usage, a fourth field axis ──
  .enqueue("v130_create_snapshot_field_user_usage_table", CREATE_SNAPSHOT_FIELD_USER_USAGE_TABLE)
  .enqueue("v131_create_snapshot_field_user_usage_by_account_index", CREATE_SNAPSHOT_FIELD_USER_USAGE_BY_ACCOUNT_INDEX)
  .enqueue("v132_create_issue_scan_field_user_buffer_table", CREATE_ISSUE_SCAN_FIELD_USER_BUFFER_TABLE)

  // ── v133-v138: the access pillar — permission / security / notification schemes ──
  .enqueue("v133_create_snapshot_schemes_table", CREATE_SNAPSHOT_SCHEMES_TABLE)
  .enqueue("v134_create_snapshot_scheme_holders_table", CREATE_SNAPSHOT_SCHEME_HOLDERS_TABLE)
  .enqueue("v135_create_snapshot_scheme_holders_by_holder_index", CREATE_SNAPSHOT_SCHEME_HOLDERS_BY_HOLDER_INDEX)
  .enqueue("v136_create_snapshot_scheme_levels_table", CREATE_SNAPSHOT_SCHEME_LEVELS_TABLE)
  .enqueue("v137_create_snapshot_scheme_projects_table", CREATE_SNAPSHOT_SCHEME_PROJECTS_TABLE)
  .enqueue("v138_create_access_snapshot_meta_table", CREATE_ACCESS_SNAPSHOT_META_TABLE)

  // ── v139-v142: configuration drift — the change-history timeline ──
  .enqueue("v139_create_snapshot_entity_digest_table", CREATE_SNAPSHOT_ENTITY_DIGEST_TABLE)
  .enqueue("v140_create_config_change_log_table", CREATE_CONFIG_CHANGE_LOG_TABLE)
  .enqueue("v141_create_config_change_log_by_time_index", CREATE_CONFIG_CHANGE_LOG_BY_TIME_INDEX)
  .enqueue("v142_create_drift_snapshot_meta_table", CREATE_DRIFT_SNAPSHOT_META_TABLE)

  // ── v143-v144: estate config — the global value lists (resolutions, priorities) ──
  .enqueue("v143_create_snapshot_estate_values_table", CREATE_SNAPSHOT_ESTATE_VALUES_TABLE)
  .enqueue("v144_create_estate_snapshot_meta_table", CREATE_ESTATE_SNAPSHOT_META_TABLE)

  // ── v145: project roles fold into the access pillar (scheme_type = 'project-role') ──
  .enqueue(
    "v145_alter_access_snapshot_meta_add_project_roles",
    "ALTER TABLE access_snapshot_meta ADD COLUMN IF NOT EXISTS total_project_roles INTEGER NOT NULL DEFAULT 0"
  )

  // ── v146-v148: agile boards — one row per board and per column, plus the build meta ──
  .enqueue("v146_create_snapshot_boards_table", CREATE_SNAPSHOT_BOARDS_TABLE)
  .enqueue("v147_create_snapshot_board_columns_table", CREATE_SNAPSHOT_BOARD_COLUMNS_TABLE)
  .enqueue("v148_create_board_snapshot_meta_table", CREATE_BOARD_SNAPSHOT_META_TABLE)

  // ── v149-v150: automation blast radius — one row per rule, scored on every import ──
  .enqueue("v149_create_automation_rule_blast_table", CREATE_AUTOMATION_RULE_BLAST_TABLE)
  .enqueue("v150_create_automation_rule_blast_score_index", CREATE_AUTOMATION_RULE_BLAST_SCORE_INDEX)


  // ── v151: remediation ticketing -- the epics and tasks Observatory creates in Jira ──
  .enqueue("v151_create_remediation_tickets_table", CREATE_REMEDIATION_TICKETS_TABLE)

  // ── v152: the screen cross-signal summary, computed on the scan and read cheap ──
  .enqueue("v152_create_screen_cross_summary_table", CREATE_SCREEN_CROSS_SUMMARY_TABLE)

  // ── v153-v155: three counters over issues the crawl already walks ──
  .enqueue("v153_create_issue_scan_type_totals_table", CREATE_ISSUE_SCAN_TYPE_TOTALS_TABLE)
  .enqueue("v154_create_issue_scan_estate_totals_table", CREATE_ISSUE_SCAN_ESTATE_TOTALS_TABLE)
  .enqueue("v155_create_issue_scan_user_activity_table", CREATE_ISSUE_SCAN_USER_ACTIVITY_TABLE)
  .enqueue("v156_create_snapshot_asset_type_counts_table", CREATE_SNAPSHOT_ASSET_TYPE_COUNTS_TABLE)
  .enqueue("v157_create_asset_type_count_meta_table", CREATE_ASSET_TYPE_COUNT_META_TABLE)
  .enqueue("v158_create_remediation_tickets_v2_table", CREATE_REMEDIATION_TICKETS_V2_TABLE)
  // Idempotent (INSERT IGNORE), so a re-run after a partial failure copies only what is missing.
  .enqueue("v159_copy_remediation_tickets_to_v2", COPY_REMEDIATION_TICKETS_TO_V2)
  // When Jira says a remediation ticket reached Done (resolution date, else the status-category
  // change date). The Remediation tab's burn-down and time-to-close need it; last_status alone
  // says a ticket is done, never when. Existing rows fill in on their next sync.
  .enqueue(
    "v160_alter_remediation_tickets_v2_add_done_at",
    "ALTER TABLE remediation_tickets_v2 ADD COLUMN IF NOT EXISTS done_at VARCHAR(64) NULL"
  )
  .enqueue(
    "v161_alter_remediation_tickets_v2_add_status_changed_at",
    "ALTER TABLE remediation_tickets_v2 ADD COLUMN IF NOT EXISTS status_changed_at VARCHAR(64) NULL"
  )

  // ── v162-v167: what each workflow enforces -- transitions, rules, properties, references ──
  .enqueue("v162_create_snapshot_workflow_transitions_table", CREATE_SNAPSHOT_WORKFLOW_TRANSITIONS_TABLE)
  .enqueue("v163_create_snapshot_workflow_rules_table", CREATE_SNAPSHOT_WORKFLOW_RULES_TABLE)
  .enqueue("v164_create_snapshot_workflow_properties_table", CREATE_SNAPSHOT_WORKFLOW_PROPERTIES_TABLE)
  .enqueue("v165_create_snapshot_workflow_refs_table", CREATE_SNAPSHOT_WORKFLOW_REFS_TABLE)
  .enqueue("v166_create_snapshot_workflow_refs_by_target_index", CREATE_SNAPSHOT_WORKFLOW_REFS_BY_TARGET_INDEX)
  // NULL = this snapshot never read workflow rules (it predates capture, or the read failed);
  // a number, including zero, = it did. Same contract as transition_screens.
  .enqueue("v167_alter_workflow_meta_add_workflow_rules",
    "ALTER TABLE workflow_snapshot_meta ADD COLUMN IF NOT EXISTS workflow_rules INTEGER NULL")
  .enqueue("v168_create_snapshot_workflows_table", CREATE_SNAPSHOT_WORKFLOWS_TABLE)

  // ── v169-v175: the field behaviour pillar -- field schemes / field configurations ──
  .enqueue("v169_create_fieldconfig_snapshot_meta_table", CREATE_FIELDCONFIG_SNAPSHOT_META_TABLE)
  .enqueue("v170_create_snapshot_fieldcfg_schemes_table", CREATE_SNAPSHOT_FIELDCFG_SCHEMES_TABLE)
  .enqueue("v171_create_snapshot_fieldcfg_scheme_projects_table", CREATE_SNAPSHOT_FIELDCFG_SCHEME_PROJECTS_TABLE)
  .enqueue("v172_create_snapshot_fieldcfg_configs_table", CREATE_SNAPSHOT_FIELDCFG_CONFIGS_TABLE)
  .enqueue("v173_create_snapshot_fieldcfg_mappings_table", CREATE_SNAPSHOT_FIELDCFG_MAPPINGS_TABLE)
  .enqueue("v174_create_snapshot_fieldcfg_items_table", CREATE_SNAPSHOT_FIELDCFG_ITEMS_TABLE)
  .enqueue("v175_create_snapshot_fieldcfg_items_by_field_index", CREATE_SNAPSHOT_FIELDCFG_ITEMS_BY_FIELD_INDEX)
  // Whether a gadget's filter can be read: readable / private / missing / unknown, from
  // probeFilter during the dashboard build. NULL = not probed (a snapshot that predates it,
  // or a gadget with no filter), which the dimension treats as unmeasured.
  .enqueue("v176_alter_dashboard_gadgets_add_filter_state",
    "ALTER TABLE snapshot_dashboard_gadgets ADD COLUMN IF NOT EXISTS filter_state VARCHAR(16) NULL");
  // v037 creates rqt_value_issue_index(scope_key, rqt_value, issue_key)
  // v038 creates rqt_field_issue_index(scope_key, field_id, issue_key)
  // v039 adds scan_history LONGTEXT for multi-run audit history
  // v040-v044 add workflow scheme / status inventory tables (Workflow & Status Tracking, Phase 1)

let migrationPromise = null;

export function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// A single unbounded `DELETE FROM table WHERE scope_key = ?` can exceed TiDB's per-query
// memory quota (error 8175) once a table's row count for a scope_key grows large enough --
// hit in production against snapshot_scheme_holders, whose rows were never version-pruned
// (see replaceAccessSnapshot in access.js). Repeating a LIMIT-bounded DELETE keeps every
// individual statement's footprint small regardless of how many rows are queued up behind it.
// `extraWhereSql`/`extraParams` let a caller narrow the match (e.g. "AND version <> ?") while
// still going through the same bounded-chunk loop.
export async function deleteScopeInChunks(table, scopeKey, { limit = 2000, extraWhereSql = "", extraParams = [] } = {}) {
  // Forge SQL rejects a placeholder in LIMIT, so the bound is interpolated -- from a clamped
  // integer, never from caller-supplied text.
  const chunk = Math.max(1, Math.min(10000, Math.floor(toNumber(limit, 2000))));
  let totalDeleted = 0;
  for (;;) {
    const result = await withSqlRetry(() =>
      sql.prepare(`DELETE FROM ${table} WHERE scope_key = ?${extraWhereSql} LIMIT ${chunk}`)
        .bindParams(scopeKey, ...extraParams)
        .execute()
    );
    const deleted = toNumber(result?.rowsAffected, 0);
    totalDeleted += deleted;
    if (deleted < chunk) break;
  }
  return totalDeleted;
}

export function safeParseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function toNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

export function isSqlRateLimitError(error) {
  return error?.code === "RATE_LIMIT_EXCEEDED" || error?.responseDetails?.status === 429;
}

// Everything a ForgeSQLAPIError knows, flattened into one line.
//
// Forge SQL answers a statement MySQL rejected with code UNKNOWN_ERROR and the message
// "Unknown SQL execution error" -- the same sentence whether the real cause was a column
// overflow, a duplicate key, or a placeholder somewhere MySQL will not take one. What the
// cause actually was arrives alongside it: ForgeSQLAPIError carries `code`, `suggestion`,
// `context` (which absorbs every extra field the service sent, including the raw response
// body) and `responseDetails.traceId`.
//
// Every one of those was being dropped. Three separate defects in this codebase reached
// production wearing that one sentence -- an INSERT with one placeholder fewer than it had
// columns, a bound placeholder in LIMIT, and a second bound LIMIT after it -- and each cost
// a diagnosis that the service had already answered and nobody read. The trace id is the
// most valuable of them: it is what Atlassian support needs to look the failure up.
const SQL_DETAIL_ATTACHED = Symbol.for("observatory.sqlDetailAttached");

export function describeSqlError(error) {
  if (!error || typeof error !== "object") return null;

  const parts = [];
  if (error.code) parts.push(`code=${error.code}`);
  const trace = error.responseDetails?.traceId;
  if (trace) parts.push(`trace=${trace}`);
  const status = error.responseDetails?.status;
  if (status) parts.push(`status=${status}`);
  if (error.suggestion) parts.push(`suggestion=${error.suggestion}`);

  // `context` is where the service puts anything it could not name, the raw response body
  // included. Serialised whole and truncated rather than cherry-picked: the next unfamiliar
  // failure will put its cause in a field nobody here has thought of yet, and a key this
  // function does not know about is exactly the one worth seeing.
  const context = error.context;
  if (context && typeof context === "object" && Object.keys(context).length) {
    let serialised;
    try {
      serialised = JSON.stringify(context);
    } catch {
      serialised = String(context);
    }
    if (serialised && serialised !== "{}") {
      parts.push(`context=${serialised.length > 600 ? `${serialised.slice(0, 600)}…` : serialised}`);
    }
  }

  return parts.length ? parts.join(" ") : null;
}

// Attach the detail to the error's own message, once.
//
// The message is what propagates: every engine's catch does String(error.message), writes it
// to a pillar's meta, and the Scans tab renders it. Enriching anywhere else would mean
// editing eighty catch blocks and still missing the eighty-first. Idempotent, because an
// error crossing two retry wrappers would otherwise carry its trace id twice.
export function attachSqlErrorDetail(error) {
  if (!error || typeof error !== "object" || error[SQL_DETAIL_ATTACHED]) return error;

  const detail = describeSqlError(error);
  if (!detail) return error;

  try {
    error.message = `${error.message || "SQL error"} (${detail})`;
    error[SQL_DETAIL_ATTACHED] = true;
  } catch {
    // A frozen error still throws -- it just throws without the detail, which is where we
    // were before. Never let diagnostics be the thing that fails.
  }
  return error;
}

export async function withSqlRetry(operation) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isSqlRateLimitError(error) || attempt === 5) {
        // The one choke point every SQL call in the app passes through, which is why the
        // detail is attached here rather than at 333 call sites.
        throw attachSqlErrorDetail(error);
      }

      const delayMs = Math.min(8000, 250 * (2 ** attempt)) + Math.floor(Math.random() * 150);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// A brand-new installation's first page load fires several resolvers concurrently (each
// its own Forge function invocation, so the in-process migrationPromise memoization below
// doesn't protect across them), and each one calls this. Against a completely empty
// database, multiple invocations can race on the same CREATE/ALTER TABLE statement. The
// migration runner tracks which migrations already succeeded, so retrying the whole run is
// safe -- a retry just resumes from whichever one lost the race, it doesn't redo work.

// A brand-new installation's first page load fires several resolvers concurrently (each
// its own Forge function invocation, so the in-process migrationPromise memoization below
// doesn't protect across them), and each one calls this. Against a completely empty
// database, multiple invocations can race on the same CREATE/ALTER TABLE statement. The
// migration runner tracks which migrations already succeeded, so retrying the whole run is
// safe -- a retry just resumes from whichever one lost the race, it doesn't redo work.
async function runMigrationsWithRetry() {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await projectStoreMigrations.run();
    } catch (error) {
      if (attempt === MAX_ATTEMPTS - 1) throw error;
      const delayMs = 500 * (attempt + 1) + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function ensureProjectStoreReady() {
  if (!migrationPromise) {
    migrationPromise = runMigrationsWithRetry().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  return migrationPromise;
}
