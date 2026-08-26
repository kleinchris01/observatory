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
// Accumulated during the crawl like issue_scan_buffer, and cleared with it: this is the
// final shape rather than something promoted later, because unlike field counts there is
// nothing to reconcile against a catalogue.
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
  .enqueue("v101_alter_full_scan_meta_add_polls", "ALTER TABLE full_scan_meta ADD COLUMN IF NOT EXISTS polls INTEGER NOT NULL DEFAULT 0");
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

export async function withSqlRetry(operation) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isSqlRateLimitError(error) || attempt === 5) {
        throw error;
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
