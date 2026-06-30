import { makeResolver } from "@forge/resolver";
import api, { route } from "@forge/api";
import { kvs } from "@forge/kvs";
import { Queue } from "@forge/events";
import { internalMetrics } from "@forge/metrics";
import {
  buildFieldJql,
  buildOverallFieldJql,
  buildProjectUsageRecord,
  getFieldNumericId,
  getFieldTypeLabel,
  summarizeContexts,
} from "./lib/transform.js";
import {
  ensureProjectStoreReady,
  readSnapshotMeta,
  writeSnapshotMeta,
  clearSnapshotVersion,
  clearOtherSnapshotVersions,
  appendSnapshotFields,
  appendSnapshotProjectUsage,
  replaceSnapshotProjectUsageForField,
  loadSnapshotFields,
  loadSnapshotField,
  loadSnapshotProjectUsage,
  loadAllSnapshotProjectUsage,
  loadAnySnapshotProjectUsage,
  listSnapshotProjects,
  loadSnapshotProjectFields,
  countSnapshotProjectUsage,
  getSnapshotProcessedFieldIds,
  loadFieldSummary,
  replaceFieldSummary,
  listFieldSummaries,
  listSavedReports,
  saveSavedReport,
  deleteSavedReport,
  replaceReportJob,
  loadReportJob,
  readIssueScanMeta,
  writeIssueScanMeta,
  clearIssueScanBuffer,
  replaceIssueScanWorkers,
  readIssueScanWorker,
  updateIssueScanWorker,
  replaceFieldOptionsCache,
  loadFieldOptionsCache,
  searchFieldOptionsCache,
  flushIssueScanCounts,
  finalizeIssueScan,
  clearRqtFieldIndex,
  upsertRqtFieldHits,
  loadRqtFieldIndex,
  clearRqtIssueKeys,
  upsertRqtIssueKeys,
  loadRqtIssueKeys,
  clearRqtValueIndex,
  upsertRqtValueIssueKeys,
  loadRqtValueFrequency,
  searchRqtValueIssueKeys,
  clearRqtFieldIssueIndex,
  upsertRqtFieldIssueKeys,
  loadRqtFieldIssueIndex,
  loadIssueRqtValues,
  carryForwardSnapshotProjectUsage,
  restoreSnapshotProjectUsageFromSummaries,
  fillSnapshotProjectUsageFromSummaries,
  promoteIssueScanToSnapshotProjectUsage,
  atomicAccumulateIssueScanProgress,
  appendIssueScanLogEntry,
  tryClaimIssueScanFinalization,
  loadIssueScanProjectTotals,
  upsertProjectTotalsForDelta,
  upsertDeltaFieldProjectUsage,
  countOldScopeKeyRows,
  migrateOldScopeKeys,
  loadSnapshotFieldIssueSums,
  sumSnapshotFieldIssueCount,
} from "./lib/project-store.js";
import {
  USAGE_STATUS_READY,
  USAGE_STATUS_UNAVAILABLE,
  USAGE_STATUS_UNSUPPORTED,
  STRUCTURAL_SYSTEM_FIELDS,
  RQT_SKIP_FIELDS,
  RQT_DEDUP_PRIORITY_FIELD,
  RQT_DEDUP_SUBORDINATE_FIELDS,
  isFieldValueNonEmpty,
  extractRqtValues,
  buildRqtJql,
  collectIssueRqtValues,
  estimateProjectUsageJobIssues,
  isFieldSummaryQueuedForDispatch,
  isFieldSummaryRunning,
  summarizeProjectUsageCapacity,
  shouldRetry,
  getRetryDelayMs,
  normalizeFieldName,
  buildDuplicateNameCountMap,
  hasMeaningfulDescription,
  isLikelyAppProvidedField,
  isJiraBuiltinField,
  classifyFieldUsageStatus,
  DEFAULT_GOVERNANCE_THRESHOLDS,
  buildGovernanceFindings,
  mergeProjectUsageCounts,
  compareFields,
  filterInventoryFields,
  isSelectFieldType,
  applyFindingsFilter,
  sortInventoryFields,
  summarizeFindings,
  buildInventoryRecord,
} from "./lib/analysis.js";

const DEFAULT_PAGE_SIZE = 100;
const INVENTORY_PAGE_SIZE = 10;
const PROJECT_USAGE_PAGE_SIZE = 12;
const PROJECTS_VIEW_PAGE_SIZE = 24;
const PROJECT_USAGE_ISSUE_SCAN_PAGE_SIZE = 100;
const PROJECT_USAGE_SCAN_PAGES_PER_JOB = 1;
const REPORT_JOB_FIELD_BATCH_SIZE = 40;
const MAX_ACTIVE_PROJECT_USAGE_JOBS = 3;
const MAX_AUTOQUEUED_REPORT_FIELDS = 12;
const MAX_AUTOQUEUED_REPORT_ISSUE_BUDGET = 200000;
const MAX_RETRY_ATTEMPTS = 8;
const BASE_JIRA_REQUEST_INTERVAL_MS = 180;
const MAX_JIRA_REQUEST_INTERVAL_MS = 1500;
const BASE_JIRA_CONCURRENCY = 4;
const JIRA_REQUEST_HARD_TIMEOUT_MS = 12000; // safety net — ensures jiraInflight always decrements
const SNAPSHOT_QUEUE_KEY = "inventory-snapshot-queue";
const SNAPSHOT_CONCURRENCY = 4;
const SNAPSHOT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const SNAPSHOT_PROGRESS_FLUSH_INTERVAL_MS = 15000;
const SNAPSHOT_DB_BATCH_SIZE = 25;
const FIELD_SUMMARY_QUEUE_STALE_AFTER_MS = 60 * 1000;
const FIELD_SUMMARY_BUILD_STALE_AFTER_MS = 5 * 60 * 1000;
const ISSUE_SCAN_PAGE_SIZE = 100;      // Jira Cloud cursor-based search caps maxResults at 100
const ISSUE_SCAN_WORKERS = 5;          // parallel Forge workers; keep low because each invocation has its own in-memory limiter
const ISSUE_SCAN_INTER_PAGE_DELAY_MS = 500; // ms between pages per worker to ease Jira API pressure
const ISSUE_SCAN_FLUSH_EVERY_PAGES = 3;    // flush field counts + update UI progress every N pages (300 issues/worker)

const METRIC_NAMES = {
  inventorySnapshot: "inventory-snapshot",
  resolver: "resolver",
  resolverFailed: "resolver-failed",
  rovoInspectField: "rovo-inspect-field",
  rovoSearchFields: "rovo-search-fields",
  snapshotConsumer: "snapshot-consumer",
  snapshotConsumerFailed: "snapshot-consumer-failed",
  snapshotScheduler: "snapshot-scheduler",
  sqlMigrate: "sql-migrate",
  projectUsageJobStarted: "project-usage-job-started",
  projectUsageJobCompleted: "project-usage-job-completed",
  projectUsageJobFailed: "project-usage-job-failed",
  projectUsageDeltaStarted: "project-usage-delta-started",
  projectUsageDeltaCompleted: "project-usage-delta-completed",
  reportJobStarted: "report-job-started",
  reportJobCompleted: "report-job-completed",
  reportJobFailed: "report-job-failed",
};

const inventorySnapshotQueue = new Queue({ key: SNAPSHOT_QUEUE_KEY });
let jiraRequestChain = Promise.resolve();
let lastJiraRequestAt = 0;
let jiraInflight = 0;
let currentJiraRequestIntervalMs = BASE_JIRA_REQUEST_INTERVAL_MS;
let currentJiraConcurrency = BASE_JIRA_CONCURRENCY;
let jiraCooldownUntil = 0;
let jiraSuccessStreak = 0;

// Rate-limit telemetry — reset at start of each build, read in log entries
let rl429Count = 0;
let rlRetryCount = 0;
let snapshotLogFn = null; // set by runSnapshot so withRetry can surface events

// ----- Core utilities -----

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function incrMetric(name, value = 1) {
  try {
    const counter = internalMetrics.counter(name);
    if (value === 1) {
      counter.incr();
      return;
    }
    counter.incrBy(value);
  } catch (_error) {
    // Metrics should never affect app behavior.
  }
}

function getJitterMs(maxMs = 20) {
  return Math.floor(Math.random() * maxMs);
}

function makeJobToken() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function registerJiraRateLimit(delayMs) {
  jiraCooldownUntil = Math.max(jiraCooldownUntil, Date.now() + delayMs);
  currentJiraRequestIntervalMs = Math.min(
    MAX_JIRA_REQUEST_INTERVAL_MS,
    Math.max(currentJiraRequestIntervalMs * 1.5, BASE_JIRA_REQUEST_INTERVAL_MS + 120)
  );
  currentJiraConcurrency = Math.max(1, currentJiraConcurrency - 1);
  jiraSuccessStreak = 0;
}

function registerJiraSuccess() {
  jiraSuccessStreak++;
  if (jiraSuccessStreak < 25) return;
  jiraSuccessStreak = 0;
  currentJiraRequestIntervalMs = Math.max(BASE_JIRA_REQUEST_INTERVAL_MS, currentJiraRequestIntervalMs - 40);
  currentJiraConcurrency = Math.min(BASE_JIRA_CONCURRENCY, currentJiraConcurrency + 1);
}

async function withRetry(operation) {
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      const result = await operation();
      registerJiraSuccess();
      return result;
    } catch (error) {
      if (!shouldRetry(error) || attempt === MAX_RETRY_ATTEMPTS - 1) throw error;
      const delayMs = getRetryDelayMs(error, attempt);
      rlRetryCount++;
      if (error?.status === 429) {
        rl429Count++;
        registerJiraRateLimit(delayMs);
        snapshotLogFn?.(`⚠ 429 rate-limited — backing off ${delayMs}ms (total 429s: ${rl429Count}, retries: ${rlRetryCount})`);
      } else {
        snapshotLogFn?.(`⚠ ${error?.status ?? "network"} error (attempt ${attempt + 1}) — retrying in ${delayMs}ms`);
      }
      await sleep(delayMs);
    }
  }
}

async function scheduleRateLimitedRequest(callback) {
  // Serialize slot acquisition — but release BEFORE making the API call so
  // multiple requests can be in-flight simultaneously (up to MAX_JIRA_CONCURRENCY).
  // Previously, release() ran in finally{} AFTER the callback, serializing all requests.
  while (true) {
    const previous = jiraRequestChain;
    let release;
    jiraRequestChain = new Promise((resolve) => { release = resolve; });
    await previous;

    if (jiraCooldownUntil > Date.now()) {
      release();
      await sleep(jiraCooldownUntil - Date.now());
      continue;
    }

    if (jiraInflight < currentJiraConcurrency) {
      // Got a slot — apply rate limit, increment, then release chain so the next
      // request can start dispatching while this one is still in-flight.
      const waitMs = Math.max(
        0,
        (lastJiraRequestAt + currentJiraRequestIntervalMs + getJitterMs()) - Date.now()
      );
      if (waitMs > 0) await sleep(waitMs);
      lastJiraRequestAt = Date.now();
      jiraInflight++;
      release();
      break;
    }

    // No slot available — release chain and back off before retrying
    release();
    await sleep(50);
  }

  try {
    // Hard deadline ensures jiraInflight always decrements even when the caller
    // abandons this promise via an outer withTimeout (e.g. getFieldTotalIssueCount).
    // Without this, abandoned in-flight requests leak slots until all 8 are stuck.
    return await withTimeout(callback(), JIRA_REQUEST_HARD_TIMEOUT_MS);
  } finally {
    jiraInflight--;
  }
}

async function jiraRequest(path, options = {}) {
  return withRetry(async () => {
    const response = await scheduleRateLimitedRequest(() =>
      api.asApp().requestJira(path, {
        headers: {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
        ...options,
      })
    );

    if (!response.ok) {
      const message = await response.text();
      const error = new Error(`Jira request failed (${response.status}): ${message}`);
      error.status = response.status;
      error.originalResponse = response;
      throw error;
    }

    return response.json();
  });
}

async function paginate(pathBuilder, valuesKey = "values") {
  const results = [];
  let startAt = 0;
  while (true) {
    const data = await jiraRequest(pathBuilder(startAt));
    const values = data?.[valuesKey] || [];
    results.push(...values);
    const total = data?.total ?? values.length;
    const nextStart = startAt + values.length;
    if (!values.length || data?.isLast === true || nextStart >= total) break;
    startAt = nextStart;
  }
  return results;
}

async function mapWithConcurrency(items, concurrency, iteratee) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await iteratee(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ----- Jira API helpers -----

async function getAllCustomFields() {
  return paginate(
    (startAt) => route`/rest/api/3/field/search?type=custom&startAt=${startAt}&maxResults=${DEFAULT_PAGE_SIZE}&orderBy=name`
  );
}

async function getAllSystemFields() {
  return paginate(
    (startAt) => route`/rest/api/3/field/search?type=system&startAt=${startAt}&maxResults=${DEFAULT_PAGE_SIZE}&orderBy=name`
  );
}

async function getFieldProjectAssociations(fieldId) {
  const rows = await paginate(
    (startAt) => route`/rest/api/3/field/${fieldId}/association/project?startAt=${startAt}&maxResults=${DEFAULT_PAGE_SIZE}`,
    "values"
  );
  return rows
    .map((row) => ({
      id: String(row.projectId || row.id || ""),
      key: row.projectKey || row.key || "",
      name: row.projectName || row.name || "",
    }))
    .filter((row) => row.id);
}

// For each project where the field is configured, run one count-only JQL query.
// Project key/name come from the first returned issue — no separate getProjectById calls.
// Returns { projects, apiTotal, configuredProjectCount }.
async function getProjectBreakdownByAssociation(fieldId, startAt = 0, maxProjects = 20) {
  const associatedProjects = await getFieldProjectAssociations(fieldId);
  if (!associatedProjects.length) {
    return {
      projects: [],
      configuredProjectCount: 0,
      processedProjectCount: 0,
      nextStartAt: 0,
      isComplete: true,
    };
  }

  const fieldCondition = buildOverallFieldJql(fieldId);
  const offset = Math.max(0, Number(startAt) || 0);
  const projectBatch = associatedProjects.slice(offset, offset + maxProjects);

  const results = await mapWithConcurrency(projectBatch, 2, async (associatedProject) => {
    const project = associatedProject.key
      ? {
          id: associatedProject.id,
          key: associatedProject.key,
          name: associatedProject.name || associatedProject.key,
        }
      : await getProjectById(associatedProject.id);
    const projectKey = String(project.key || "").trim();
    if (!projectKey) return null;

    const data = await jiraRequest(route`/rest/api/3/search/jql`, {
      method: "POST",
      body: JSON.stringify({
        jql: `project = "${projectKey.replace(/"/g, '\\"')}" AND ${fieldCondition}`,
        maxResults: 1,
        fields: [],
      }),
    });
    const count = Number(data?.total ?? 0);
    if (count === 0) return null;
    // Project key/name come free from the first issue — no extra API call needed
    return {
      projectId: project.id,
      projectKey,
      projectName: project.name || projectKey,
      issueCount: count,
    };
  });

  const projects = results
    .filter(Boolean)
    .map((p) => ({ ...p, jql: buildFieldJql(fieldId, p.projectKey) }))
    .sort((a, b) => b.issueCount - a.issueCount || a.projectKey.localeCompare(b.projectKey));

  return {
    projects,
    configuredProjectCount: associatedProjects.length,
    processedProjectCount: projectBatch.length,
    nextStartAt: offset + projectBatch.length,
    isComplete: offset + projectBatch.length >= associatedProjects.length,
  };
}

async function getProjectBreakdownByIssueScan(fieldId, nextPageToken = null, maxPages = PROJECT_USAGE_SCAN_PAGES_PER_JOB) {
  const jql = `${buildOverallFieldJql(fieldId)} ORDER BY issueKey ASC`;
  const countsByProjectId = new Map();
  let pagesProcessed = 0;
  let scannedIssueCount = 0;
  let totalIssues = 0;
  let cursorToken = nextPageToken || null;
  let lastResponseNextPageToken = null;
  let reachedEnd = false;
  let paginationBroken = false;

  while (pagesProcessed < maxPages) {
    const body = {
      jql,
      maxResults: PROJECT_USAGE_ISSUE_SCAN_PAGE_SIZE,
      fields: ["project", "updated"],
      fieldsByKeys: false,
    };
    if (cursorToken) {
      body.nextPageToken = cursorToken;
    }

    const data = await jiraRequest(route`/rest/api/3/search/jql`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    const issues = data?.issues || [];
    totalIssues = Number(data?.total ?? totalIssues);
    pagesProcessed++;
    scannedIssueCount += issues.length;
    lastResponseNextPageToken = data?.nextPageToken || null;
    paginationBroken = Boolean(
      issues.length
      && totalIssues > 0
      && scannedIssueCount < totalIssues
      && data?.isLast !== true
      && !lastResponseNextPageToken
    );
    reachedEnd = !issues.length || data?.isLast === true || (!lastResponseNextPageToken && !paginationBroken);

    for (const issue of issues) {
      const project = issue?.fields?.project;
      const projectId = String(project?.id || "");
      if (!projectId) continue;

      const current = countsByProjectId.get(projectId) || {
        projectId,
        projectKey: project?.key || projectId,
        projectName: project?.name || project?.key || projectId,
        issueCount: 0,
        latestFieldChangeAt: null,
        latestIssueKey: null,
        latestIssueUpdatedAt: null,
      };

      current.issueCount += 1;
      const updatedAt = issue?.fields?.updated || null;
      if (updatedAt && (!current.latestIssueUpdatedAt || updatedAt > current.latestIssueUpdatedAt)) {
        current.latestFieldChangeAt = updatedAt;
        current.latestIssueKey = issue?.key || null;
        current.latestIssueUpdatedAt = updatedAt;
      }
      countsByProjectId.set(projectId, current);
    }

    if (reachedEnd) {
      break;
    }

    if (paginationBroken) {
      break;
    }

    cursorToken = lastResponseNextPageToken;
  }

  const projects = Array.from(countsByProjectId.values())
    .map((project) => ({
      ...project,
      jql: buildFieldJql(fieldId, project.projectKey),
    }))
    .sort((left, right) => right.issueCount - left.issueCount || left.projectKey.localeCompare(right.projectKey));

  return {
    projects,
    totalIssues,
    scannedIssueCount,
    nextPageToken: reachedEnd ? null : lastResponseNextPageToken,
    isComplete: !paginationBroken && (reachedEnd || (totalIssues > 0 && scannedIssueCount >= totalIssues)),
    paginationBroken,
  };
}

async function getFieldConfiguredProjectCount(fieldId) {
  try {
    const data = await withTimeout(
      jiraRequest(route`/rest/api/3/field/${fieldId}/association/project?startAt=0&maxResults=1`),
      ISSUE_COUNT_TIMEOUT_MS
    );
    return Number(data?.total ?? data?.values?.length ?? 0);
  } catch {
    return 0;
  }
}

const ISSUE_COUNT_TIMEOUT_MS = 8000;

async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  // Suppress unhandled rejection on the abandoned promise when timeout wins the race
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function getFieldTotalIssueCount(fieldId) {
  const jql = buildOverallFieldJql(fieldId);
  try {
    // approximate-count is purpose-built for fast counts — try it first
    const approx = await withTimeout(
      jiraRequest(route`/rest/api/3/search/approximate-count`, {
        method: "POST",
        body: JSON.stringify({ jql }),
      }),
      ISSUE_COUNT_TIMEOUT_MS
    );
    if (typeof approx?.count === "number") return approx.count;
  } catch {
    // endpoint unavailable or timed out, fall through
  }
  try {
    const data = await withTimeout(
      jiraRequest(route`/rest/api/3/search/jql`, {
        method: "POST",
        body: JSON.stringify({ jql, fields: [], maxResults: 1 }),
      }),
      ISSUE_COUNT_TIMEOUT_MS
    );
    return Number(data?.total ?? 0);
  } catch {
    return -1; // -1 signals "count unavailable" (timeout or error)
  }
}

async function getDistinctIssueCountForFields(fieldIds) {
  const uniqueFieldIds = Array.from(new Set((fieldIds || []).map((value) => String(value || "").trim()).filter(Boolean)));
  if (!uniqueFieldIds.length) {
    return 0;
  }

  const jql = uniqueFieldIds.map((fieldId) => `(${buildOverallFieldJql(fieldId)})`).join(" OR ");
  try {
    const approx = await withTimeout(
      jiraRequest(route`/rest/api/3/search/approximate-count`, {
        method: "POST",
        body: JSON.stringify({ jql }),
      }),
      ISSUE_COUNT_TIMEOUT_MS
    );
    if (typeof approx?.count === "number") return approx.count;
  } catch {
    // fall through
  }

  try {
    const data = await withTimeout(
      jiraRequest(route`/rest/api/3/search/jql`, {
        method: "POST",
        body: JSON.stringify({ jql, fields: [], maxResults: 1 }),
      }),
      ISSUE_COUNT_TIMEOUT_MS
    );
    return Number(data?.total ?? 0);
  } catch {
    return -1;
  }
}

async function getProjectById(projectId) {
  const project = await jiraRequest(route`/rest/api/3/project/${projectId}`);
  return {
    id: String(project.id || projectId),
    key: project.key || String(projectId),
    name: project.name || project.key || String(projectId),
  };
}

async function getFieldContexts(fieldId) {
  return paginate(
    (startAt) => route`/rest/api/3/field/${fieldId}/context?startAt=${startAt}&maxResults=${DEFAULT_PAGE_SIZE}`,
    "values"
  );
}

async function getFieldContextProjectMappings(fieldId) {
  return paginate(
    (startAt) => route`/rest/api/3/field/${fieldId}/context/projectmapping?startAt=${startAt}&maxResults=${DEFAULT_PAGE_SIZE}`,
    "values"
  );
}

async function getFieldContextIssueTypeMappings(fieldId) {
  return paginate(
    (startAt) => route`/rest/api/3/field/${fieldId}/context/issuetypemapping?startAt=${startAt}&maxResults=${DEFAULT_PAGE_SIZE}`,
    "values"
  );
}

async function loadFieldContexts(fieldId) {
  const [contexts, projectMappings, issueTypeMappings] = await Promise.all([
    getFieldContexts(fieldId),
    getFieldContextProjectMappings(fieldId).catch(() => []),
    getFieldContextIssueTypeMappings(fieldId).catch(() => []),
  ]);

  const projectIds = Array.from(
    new Set(
      projectMappings
        .map((mapping) => String(mapping.projectId || ""))
        .filter(Boolean)
    )
  );

  const projectLookup = new Map();
  if (projectIds.length) {
    const projects = await mapWithConcurrency(projectIds, 4, async (projectId) => getProjectById(projectId));
    for (const project of projects) {
      projectLookup.set(String(project.id), project);
    }
  }

  return summarizeContexts({
    contexts,
    projectMappings,
    issueTypeMappings,
    projectLookup,
  });
}

async function searchProjectFieldUsage(fieldId, projectKey) {
  const jql = buildFieldJql(fieldId, projectKey);
  const data = await jiraRequest(route`/rest/api/3/search/jql`, {
    method: "POST",
    body: JSON.stringify({
      jql: `${jql} ORDER BY updated DESC`,
      maxResults: 1,
      fields: ["updated", "project"],
    }),
  });

  const latestProject = data?.issues?.[0]?.fields?.project
    ? {
        id: String(data.issues[0].fields.project.id || projectKey),
        key: data.issues[0].fields.project.key || projectKey,
        name: data.issues[0].fields.project.name || data.issues[0].fields.project.key || projectKey,
      }
    : null;
  const latestIssue = data?.issues?.[0]
    ? {
        key: data.issues[0].key,
        updated: data.issues[0].fields?.updated || null,
      }
    : null;

  return {
    issueCount: Number(data?.total || 0),
    project: latestProject,
    latestIssue,
  };
}

async function collectRecentFieldProjectCandidates(hours = 24, maxIssues = 500) {
  const changedProjectsByFieldId = new Map();
  const seenIssues = new Set();
  const jql = `updated >= -${Math.max(1, Math.trunc(Number(hours)) || 24)}h ORDER BY updated DESC`;
  let startAt = 0;
  let scanned = 0;

  while (scanned < maxIssues) {
    const remaining = maxIssues - scanned;
    // Use the classic /search endpoint — /search/jql does not support expand=changelog
    const data = await jiraRequest(route`/rest/api/3/search`, {
      method: "POST",
      body: JSON.stringify({
        jql,
        startAt,
        maxResults: Math.min(100, remaining),
        fields: ["project", "updated"],
        expand: ["changelog"],
      }),
    });

    const issues = data?.issues || [];
    if (!issues.length) {
      break;
    }

    for (const issue of issues) {
      if (seenIssues.has(issue.id)) {
        continue;
      }
      seenIssues.add(issue.id);
      scanned += 1;
      const projectKey = String(issue?.fields?.project?.key || "").trim();
      if (!projectKey) {
        continue;
      }
      const histories = issue?.changelog?.histories || [];
      for (const history of histories) {
        for (const item of history?.items || []) {
          const rawFieldId = String(item?.fieldId || item?.field || "").trim();
          const match = rawFieldId.match(/customfield_\d+/i);
          if (!match) {
            continue;
          }
          const fieldId = match[0].toLowerCase();
          const current = changedProjectsByFieldId.get(fieldId) || new Set();
          current.add(projectKey);
          changedProjectsByFieldId.set(fieldId, current);
        }
      }
    }

    startAt += issues.length;
    const total = Number(data?.total ?? 0);
    if (!issues.length || data?.isLast === true || startAt >= total || scanned >= maxIssues) {
      break;
    }
  }

  return {
    scannedIssues: scanned,
    fields: Array.from(changedProjectsByFieldId.entries()).map(([fieldId, projectKeys]) => ({
      fieldId,
      projectKeys: Array.from(projectKeys).sort((left, right) => left.localeCompare(right)),
    })),
  };
}

async function getLiveFieldProjectUsage(fieldId, usagePage, usagePageSize) {
  const associatedProjects = await getFieldProjectAssociations(fieldId);
  const projects = await mapWithConcurrency(associatedProjects, 4, async (associatedProject) => {
    const project = associatedProject.key
      ? {
          id: associatedProject.id,
          key: associatedProject.key,
          name: associatedProject.name || associatedProject.key,
        }
      : await getProjectById(associatedProject.id);
    const usage = await searchProjectFieldUsage(fieldId, project.key);
    if (usage.issueCount <= 0) return null;

    return buildProjectUsageRecord({
      project,
      fieldId,
      issueCount: usage.issueCount,
      latestIssue: usage.latestIssue,
    });
  });

  const populatedProjects = projects
    .filter(Boolean)
    .sort((a, b) => b.issueCount - a.issueCount || a.projectKey.localeCompare(b.projectKey));

  const total = populatedProjects.length;
  const totalIssueCount = populatedProjects.reduce((sum, project) => sum + (project.issueCount ?? 0), 0);
  const offset = (usagePage - 1) * usagePageSize;
  return {
    projectUsage: populatedProjects.slice(offset, offset + usagePageSize),
    total,
    totalIssueCount,
  };
}

async function processFieldSummaryChunk(
  scopeKey,
  version,
  snapshotField,
  jobToken,
  startAt = 0,
  nextPageToken = null,
  maxPages = PROJECT_USAGE_SCAN_PAGES_PER_JOB
) {
  const fieldId = snapshotField.id;
  const existing = await loadFieldSummary(scopeKey, fieldId);
  if (!existing || existing.jobToken !== jobToken || existing.summaryStatus === "cancelled") {
    return;
  }

  const progressLog = [...(existing.progressLog || [])];
  const addJobLog = (msg) => {
    progressLog.push({ t: new Date().toISOString(), msg });
    if (progressLog.length > 100) progressLog.shift();
  };

  if (existing.summaryStatus === "queued") {
    incrMetric(METRIC_NAMES.projectUsageJobStarted);
    addJobLog(`Started project-usage build for ${snapshotField.name} (${fieldId})`);
  }

  addJobLog(
    `Scanning up to ${(PROJECT_USAGE_ISSUE_SCAN_PAGE_SIZE * maxPages).toLocaleString()} matching issues for project usage`
  );

  let scan;
  try {
    scan = await getProjectBreakdownByIssueScan(
      fieldId,
      nextPageToken || existing.nextPageToken || null,
      maxPages
    );
  } catch (scanError) {
    if (isExpiredPageTokenError(scanError)) {
      addJobLog("Jira page cursor expired; restarting scan from the beginning");
      await replaceFieldSummary(scopeKey, fieldId, {
        ...existing,
        summaryStatus: "queued",
        nextPageToken: null,
        processedIssueCount: 0,
        nextStartAt: 0,
        activeProjects: [],
        progressLog,
      });
      await queueFieldSummaryContinuationWithRetry(scopeKey, version, fieldId, jobToken, 0, "");
      return;
    }
    throw scanError;
  }
  const mergedProjects = mergeProjectUsageCounts(existing.activeProjects || [], scan.projects);
  const processedIssueCount = Number(existing.processedIssueCount || 0) + Number(scan.scannedIssueCount || 0);
  const estimatedIssueTotal = Number(scan.totalIssues || existing.estimatedIssueTotal || snapshotField.totalIssueCount || 0);
  const sourceIssueTotal = Number(snapshotField.totalIssueCount || existing.totalIssueCount || 0);
  const totalIssueCount = mergedProjects.reduce((sum, project) => sum + Number(project.issueCount || 0), 0);
  const isComplete = scan.isComplete || processedIssueCount >= estimatedIssueTotal;

  addJobLog(
    estimatedIssueTotal > 0
      ? `Processed ${processedIssueCount.toLocaleString()} of ${estimatedIssueTotal.toLocaleString()} matching issues`
      : `Processed ${processedIssueCount.toLocaleString()} matching issues`
  );

  const baseSummary = {
    refreshedAt: new Date().toISOString(),
    field: snapshotField,
    fieldJql: snapshotField.fieldJql || buildOverallFieldJql(fieldId),
    configuredProjectCount: snapshotField.configuredProjectCount ?? snapshotField.usageCount ?? 0,
    hasGlobalContext: false,
    activeProjectCount: mergedProjects.length,
    totalIssueCount: Math.max(totalIssueCount, sourceIssueTotal),
    activeProjects: mergedProjects,
    contexts: existing.contexts || [],
    findings: snapshotField.findings || null,
    startedAt: existing.startedAt || new Date().toISOString(),
    completedAt: isComplete ? new Date().toISOString() : null,
    lastError: null,
    progressLog,
    jobToken,
    processedIssueCount,
    estimatedIssueTotal,
    nextStartAt: processedIssueCount,
    nextPageToken: scan.nextPageToken,
  };

  if (scan.paginationBroken) {
    addJobLog(
      `Field scan pagination broke after ${processedIssueCount.toLocaleString()} of ${estimatedIssueTotal.toLocaleString()} issues; Jira did not return a continuation token`
    );
    await replaceFieldSummary(scopeKey, fieldId, {
      ...baseSummary,
      totalIssueCount: Math.max(sourceIssueTotal, processedIssueCount),
      summaryStatus: "failed",
      completedAt: new Date().toISOString(),
      lastError: "Project usage pagination ended unexpectedly before all matching issues were scanned",
      progressLog,
    });
    incrMetric(METRIC_NAMES.projectUsageJobFailed);
    return;
  }

  if (isComplete) {
    if (mergedProjects.length === 0 && sourceIssueTotal > 0) {
      addJobLog(
        `Completed matching-issue scan but found 0 active projects despite ${sourceIssueTotal.toLocaleString()} populated issues`
      );
      await replaceFieldSummary(scopeKey, fieldId, {
        ...baseSummary,
        totalIssueCount: sourceIssueTotal,
        summaryStatus: "failed",
        completedAt: new Date().toISOString(),
        lastError: "Project usage scan found no active projects despite populated issues",
        progressLog,
      });
      incrMetric(METRIC_NAMES.projectUsageJobFailed);
      return;
    }
    await replaceSnapshotProjectUsageForField(scopeKey, version, fieldId, mergedProjects);
    addJobLog(`Cached ${mergedProjects.length} project usage rows`);
    await replaceFieldSummary(scopeKey, fieldId, {
      ...baseSummary,
      summaryStatus: "ready",
      completedAt: new Date().toISOString(),
      progressLog,
    });
    incrMetric(METRIC_NAMES.projectUsageJobCompleted);
    return;
  }

  await replaceFieldSummary(scopeKey, fieldId, {
    ...baseSummary,
    summaryStatus: "building",
  });

  const queueResult = await queueFieldSummaryContinuationWithRetry(
    scopeKey,
    version,
    fieldId,
    jobToken,
    processedIssueCount,
    scan.nextPageToken || ""
  );

  if (!queueResult.queued) {
    addJobLog(
      `Automatic continuation could not be scheduled after ${processedIssueCount.toLocaleString()} scanned issues; job remains queued at checkpoint`
    );
    await replaceFieldSummary(scopeKey, fieldId, {
      ...baseSummary,
      summaryStatus: "queued",
      progressLog,
    });
    return;
  }

  if (queueResult.attempts > 1) {
    addJobLog(
      `Scheduled continuation after ${processedIssueCount.toLocaleString()} scanned issues (${queueResult.attempts} queue attempts)`
    );
  }
}

async function processFieldUsageDelta(scopeKey, version, snapshotField, jobToken, projectKeys = [], windowHours = 24) {
  const fieldId = snapshotField.id;
  const existing = await loadFieldSummary(scopeKey, fieldId);
  if (!existing || existing.jobToken !== jobToken || existing.summaryStatus === "cancelled") {
    return;
  }

  const normalizedProjectKeys = Array.from(new Set((projectKeys || []).map((value) => String(value || "").trim()).filter(Boolean)));
  if (!normalizedProjectKeys.length) {
    await replaceFieldSummary(scopeKey, fieldId, {
      ...existing,
      refreshedAt: new Date().toISOString(),
      summaryStatus: "ready",
      completedAt: new Date().toISOString(),
      lastError: null,
      progressLog: [
        ...(existing.progressLog || []).slice(-80),
        { t: new Date().toISOString(), msg: `No affected projects were found for the last ${windowHours}h incremental refresh` },
      ].slice(-100),
    });
    return;
  }

  const progressLog = [...(existing.progressLog || [])];
  const addJobLog = (msg) => {
    progressLog.push({ t: new Date().toISOString(), msg });
    if (progressLog.length > 100) progressLog.shift();
  };

  addJobLog(`Started incremental project-usage refresh for ${snapshotField.name} across ${normalizedProjectKeys.length} affected projects`);
  incrMetric(METRIC_NAMES.projectUsageDeltaStarted);

  await replaceFieldSummary(scopeKey, fieldId, {
    ...existing,
    refreshedAt: new Date().toISOString(),
    summaryStatus: "building",
    startedAt: existing.startedAt || new Date().toISOString(),
    completedAt: null,
    lastError: null,
    progressLog,
  });

  const currentByProjectKey = new Map((existing.activeProjects || []).map((project) => [project.projectKey, { ...project }]));
  const refreshedProjects = await mapWithConcurrency(normalizedProjectKeys, 2, async (projectKey) => {
    const usage = await searchProjectFieldUsage(fieldId, projectKey);
    if (usage.issueCount <= 0) {
      return { projectKey, remove: true };
    }
    const prior = currentByProjectKey.get(projectKey);
    const project =
      usage.project
      || (prior ? { id: prior.projectId, key: prior.projectKey, name: prior.projectName } : { id: projectKey, key: projectKey, name: projectKey });
    return buildProjectUsageRecord({
      project,
      fieldId,
      issueCount: usage.issueCount,
      latestIssue: usage.latestIssue,
    });
  });

  for (const project of refreshedProjects) {
    if (!project) continue;
    if (project.remove) {
      currentByProjectKey.delete(project.projectKey);
      continue;
    }
    currentByProjectKey.set(project.projectKey, project);
  }

  const nextProjects = Array.from(currentByProjectKey.values())
    .sort((left, right) => Number(right.issueCount || 0) - Number(left.issueCount || 0) || left.projectKey.localeCompare(right.projectKey));
  const nextTotalIssueCount = nextProjects.reduce((sum, project) => sum + Number(project.issueCount || 0), 0);

  await replaceSnapshotProjectUsageForField(scopeKey, version, fieldId, nextProjects);
  await replaceFieldSummary(scopeKey, fieldId, {
    ...existing,
    refreshedAt: new Date().toISOString(),
    field: snapshotField,
    fieldJql: existing.fieldJql || snapshotField.fieldJql || buildOverallFieldJql(fieldId),
    configuredProjectCount: existing.configuredProjectCount ?? snapshotField.configuredProjectCount ?? snapshotField.usageCount ?? 0,
    totalIssueCount: Math.max(nextTotalIssueCount, Number(snapshotField.totalIssueCount || 0)),
    activeProjectCount: nextProjects.length,
    activeProjects: nextProjects,
    summaryStatus: "ready",
    completedAt: new Date().toISOString(),
    lastError: null,
    progressLog: [
      ...progressLog,
      { t: new Date().toISOString(), msg: `Incremental refresh complete for ${normalizedProjectKeys.length} affected projects` },
    ].slice(-100),
  });
  incrMetric(METRIC_NAMES.projectUsageDeltaCompleted);
}

function hydrateFieldForGovernance(field, summary, duplicateNameCount = 1, thresholds = {}) {
  const activeProjectCount = Number(summary?.activeProjectCount ?? field?.activeProjectCount ?? 0);
  const totalIssueCount = Number(summary?.totalIssueCount ?? field?.totalIssueCount ?? 0);
  const configuredProjectCount = Number(field?.configuredProjectCount ?? field?.usageCount ?? summary?.configuredProjectCount ?? 0);
  const usageStatus = field?.usageStatus ?? USAGE_STATUS_READY;
  const usageStatusDetail = field?.usageStatusDetail || null;

  const isSystemField = !String(field.id || "").startsWith("customfield_");
  const contexts = Array.isArray(summary?.contexts) ? summary.contexts : [];
  const contextCount = contexts.length;
  const hasGlobalContext = Boolean(summary?.hasGlobalContext || contexts.some((c) => c.isGlobal));
  return {
    ...field,
    configuredProjectCount,
    usageCount: configuredProjectCount,
    activeProjectCount,
    totalIssueCount,
    isJiraBuiltin: isJiraBuiltinField(field),
    isSystemField,
    findings: buildGovernanceFindings(field, {
      configuredProjectCount,
      totalIssueCount,
      activeProjectCount,
      duplicateNameCount,
      usageStatus,
      usageStatusDetail,
      isSystemField,
      contextCount,
      hasGlobalContext,
    }, thresholds),
  };
}

// ----- Installation key -----

function sanitizeCacheKeyPart(value) {
  return String(value || "global").replace(/[^a-zA-Z0-9:._\s\-#]/g, "_").trim().slice(0, 180) || "global";
}

function getInstallationKey(context) {
  const key = context?.installContext;
  if (!key) throw new Error("Missing installContext — cannot determine tenant scope key");
  // Normalize away the product name (confluence/jira/etc.) so the Jira admin page
  // and the Confluence macro share the same SQL namespace for the same cloud site.
  // ari:cloud:confluence::site/UUID and ari:cloud:jira::site/UUID both reduce to
  // ari:cloud::site/UUID after stripping the product segment.
  const normalized = String(key).replace(/^(ari:cloud:)[^:]+(:.*)$/, "$1$2");
  return sanitizeCacheKeyPart(normalized);
}

// ----- Snapshot helpers -----

function isSnapshotStale(meta) {
  if (!meta?.refreshedAt) return true;
  return (Date.now() - new Date(meta.refreshedAt).getTime()) > SNAPSHOT_STALE_AFTER_MS;
}

async function queueSnapshotBuild(installationKey) {
  await inventorySnapshotQueue.push({
    body: { jobType: "run-snapshot", installationKey },
  });
}

async function queueFieldSummaryBuild(installationKey, version, fieldId, jobToken, startAt = 0, nextPageToken = "") {
  if (!installationKey || !version || !fieldId || !jobToken) {
    throw new Error("Invalid field summary queue payload");
  }
  await inventorySnapshotQueue.push({
    body: { jobType: "build-field-summary", installationKey, version, fieldId, jobToken, startAt, nextPageToken },
  });
}

async function queueFieldUsageDeltaRefresh(installationKey, version, fieldId, jobToken, projectKeys = [], windowHours = 24) {
  if (!installationKey || !version || !fieldId || !jobToken) {
    throw new Error("Invalid field usage delta queue payload");
  }
  await inventorySnapshotQueue.push({
    body: {
      jobType: "refresh-field-project-delta",
      installationKey,
      version,
      fieldId,
      jobToken,
      projectKeys,
      windowHours,
    },
  });
}

async function queueReportBuild(installationKey, version, jobId) {
  if (!installationKey || !version || !jobId) {
    throw new Error("Invalid report build queue payload");
  }
  await inventorySnapshotQueue.push({
    body: {
      jobType: "build-project-usage-report",
      installationKey,
      version,
      jobId,
    },
  });
}

async function queueProjectUsageRestore(installationKey, version) {
  await inventorySnapshotQueue.push({
    body: { jobType: "restore-project-usage", installationKey, version },
  });
}

async function tryQueueFieldSummaryBuild(installationKey, version, fieldId, jobToken, startAt = 0, nextPageToken = "") {
  if (!installationKey || !version || !fieldId || !jobToken) {
    return { queued: false, reason: "invalid-payload" };
  }

  try {
    await queueFieldSummaryBuild(installationKey, version, fieldId, jobToken, startAt, nextPageToken);
    return { queued: true };
  } catch (error) {
    const message = String(error?.message || "");
    if (
      message.toLowerCase().includes("too many requests")
      || message.toLowerCase().includes("cyclic invocation")
      || message.toLowerCase().includes("limit on cyclic invocation")
      || message.toLowerCase().includes("400 bad request")
    ) {
      return { queued: false, reason: "queue-backpressure", error };
    }
    throw error;
  }
}

async function queueFieldSummaryContinuationWithRetry(
  installationKey,
  version,
  fieldId,
  jobToken,
  startAt = 0,
  nextPageToken = ""
) {
  const retryDelaysMs = [0, 1500, 3000, 5000];
  let lastResult = { queued: false, reason: "queue-backpressure" };

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    if (retryDelaysMs[attempt] > 0) {
      await sleep(retryDelaysMs[attempt]);
    }

    lastResult = await tryQueueFieldSummaryBuild(
      installationKey,
      version,
      fieldId,
      jobToken,
      startAt,
      nextPageToken
    );

    if (lastResult.queued) {
      return { queued: true, attempts: attempt + 1 };
    }

    if (lastResult.reason !== "queue-backpressure") {
      return { ...lastResult, attempts: attempt + 1 };
    }
  }

  return { ...lastResult, attempts: retryDelaysMs.length };
}

async function queueFieldUsageDeltaRefreshWithRetry(
  installationKey,
  version,
  fieldId,
  jobToken,
  projectKeys = [],
  windowHours = 24
) {
  const retryDelaysMs = [0, 1500, 3000, 5000];
  let lastResult = { queued: false, reason: "queue-backpressure" };

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    if (retryDelaysMs[attempt] > 0) {
      await sleep(retryDelaysMs[attempt]);
    }

    try {
      await queueFieldUsageDeltaRefresh(
        installationKey,
        version,
        fieldId,
        jobToken,
        projectKeys,
        windowHours
      );
      return { queued: true, attempts: attempt + 1 };
    } catch (error) {
      const message = String(error?.message || "");
      if (
        message.toLowerCase().includes("too many requests")
        || message.toLowerCase().includes("cyclic invocation")
        || message.toLowerCase().includes("limit on cyclic invocation")
        || message.toLowerCase().includes("400 bad request")
      ) {
        lastResult = { queued: false, reason: "queue-backpressure", error };
        continue;
      }
      throw error;
    }
  }

  return { ...lastResult, attempts: retryDelaysMs.length };
}

async function topOffDeferredFieldSummaryJobs(installationKey, version, jobs = []) {
  const capacity = summarizeProjectUsageCapacity(jobs);
  let availableSlots = Math.max(0, MAX_ACTIVE_PROJECT_USAGE_JOBS - capacity.runningJobCount);
  if (!availableSlots) {
    return jobs;
  }

  const queuedContinuations = jobs
    .filter((job) => job.fieldId && job.summaryStatus === "queued" && Number(job.processedIssueCount || 0) > 0)
    .sort((left, right) => {
      const leftRef = new Date(left.refreshedAt || left.startedAt || 0).getTime();
      const rightRef = new Date(right.refreshedAt || right.startedAt || 0).getTime();
      return leftRef - rightRef;
    });

  if (!queuedContinuations.length) {
    return jobs;
  }

  const nextJobs = [...jobs];
  for (const job of queuedContinuations) {
    if (!availableSlots) break;

    const queueResult = await tryQueueFieldSummaryBuild(
      installationKey,
      version,
      job.fieldId,
      job.jobToken || makeJobToken(),
      Number(job.processedIssueCount || job.nextStartAt || 0),
      job.nextPageToken || ""
    );

    if (!queueResult.queued) {
      break;
    }

    const fullJob = await loadFieldSummary(installationKey, job.fieldId).catch(() => job);
    const updatedJob = {
      ...fullJob,
      fieldId: job.fieldId,
      refreshedAt: new Date().toISOString(),
      summaryStatus: "building",
      lastError: null,
      progressLog: [
        ...(fullJob?.progressLog || []),
        { t: new Date().toISOString(), msg: "Resuming queued continuation under current job cap" },
      ].slice(-100),
    };
    await replaceFieldSummary(installationKey, job.fieldId, updatedJob);
    const index = nextJobs.findIndex((candidate) => candidate.fieldId === job.fieldId);
    if (index >= 0) {
      nextJobs[index] = updatedJob;
    }
    availableSlots--;
  }

  return nextJobs;
}

async function ensureFieldSummaryJobRunning(installationKey, version, fieldId, summary, snapshotField = null) {
  if (!summary || !version || !fieldId) {
    return summary;
  }

  if (summary.summaryStatus !== "queued" && summary.summaryStatus !== "building") {
    return summary;
  }

  const now = Date.now();
  const refreshedAtMs = summary.refreshedAt ? new Date(summary.refreshedAt).getTime() : 0;
  const startedAtMs = summary.startedAt ? new Date(summary.startedAt).getTime() : 0;
  const queuedIsStale =
    summary.summaryStatus === "queued" &&
    refreshedAtMs > 0 &&
    (now - refreshedAtMs) > FIELD_SUMMARY_QUEUE_STALE_AFTER_MS;
  const buildIsStale =
    summary.summaryStatus === "building" &&
    ((startedAtMs > 0 && (now - startedAtMs) > FIELD_SUMMARY_BUILD_STALE_AFTER_MS) ||
      (refreshedAtMs > 0 && (now - refreshedAtMs) > FIELD_SUMMARY_BUILD_STALE_AFTER_MS));

  if (!queuedIsStale && !buildIsStale) {
    return summary;
  }

  const fieldRecord = snapshotField || summary.field || await loadSnapshotField(installationKey, version, fieldId).catch(() => null);
  if (!fieldRecord) {
    return summary;
  }

  const progressLog = [
    ...(summary.progressLog || []),
    {
      t: new Date().toISOString(),
      msg: queuedIsStale
        ? "Queued job appeared stalled; re-queueing from checkpoint"
        : "Background job appeared stalled; re-queueing from checkpoint",
    },
  ].slice(-100);

  const recoveredJobToken = summary.jobToken || makeJobToken();
  const recoveredSummary = {
    ...summary,
    fieldId,
    refreshedAt: new Date().toISOString(),
    field: fieldRecord,
    summaryStatus: "queued",
    completedAt: null,
    lastError: null,
    progressLog,
    jobToken: recoveredJobToken,
  };

  await replaceFieldSummary(installationKey, fieldId, recoveredSummary);
  const queueResult = await tryQueueFieldSummaryBuild(
    installationKey,
    version,
    fieldId,
    recoveredJobToken,
    recoveredSummary.processedIssueCount || recoveredSummary.nextStartAt || 0,
    recoveredSummary.nextPageToken || ""
  );

  if (!queueResult.queued) {
    await replaceFieldSummary(installationKey, fieldId, {
      ...recoveredSummary,
      progressLog: [
        ...progressLog,
        { t: new Date().toISOString(), msg: "Re-queue deferred due to queue backpressure; try Refresh jobs again" },
      ].slice(-100),
    });
  }

  return recoveredSummary;
}

async function requeueStaleSnapshotBuild(installationKey, meta) {
  const currentMeta = meta || await readSnapshotMeta(installationKey);
  const startedMs = currentMeta?.startedAt ? new Date(currentMeta.startedAt).getTime() : 0;
  const buildIsStuck =
    currentMeta?.state === "building" &&
    (!startedMs || (Date.now() - startedMs > 20 * 60 * 1000));

  if (!buildIsStuck) {
    return currentMeta;
  }

  const queueToken = makeJobToken();
  await writeSnapshotMeta(installationKey, {
    state: "queued",
    jobToken: queueToken,
    lastError: currentMeta?.lastError || "Previous build stalled; re-queuing from checkpoint.",
  });

  const claimed = await readSnapshotMeta(installationKey);
  if (claimed?.jobToken === queueToken) {
    await queueSnapshotBuild(installationKey);
    return claimed;
  }

  return claimed || currentMeta;
}


// ----- Core snapshot pipeline -----
// Runs entirely inside a single Forge queue invocation.
// 1. Fetch all custom fields (~1,300).
// 2. For each field call /field/{id}/usage to get per-project issue counts.
// 3. Write to SQL. No KVS, no batching, no separate plan phase.

class CancelError extends Error {
  constructor() {
    super("Build cancelled by user");
    this.isCancelError = true;
  }
}

async function runSnapshot(installationKey) {
  incrMetric(METRIC_NAMES.inventorySnapshot);
  const progressLog = [];
  let processedCount = 0;
  let skipCount = 0;
  let totalCount = 0;
  let progressInterval = null;
  let cancelled = false;
  let version = null;
  const pendingFieldRecords = [];

  // Reset telemetry for this invocation and expose logEntry to withRetry
  rl429Count = 0;
  rlRetryCount = 0;
  jiraSuccessStreak = 0;
  jiraCooldownUntil = 0;
  currentJiraRequestIntervalMs = BASE_JIRA_REQUEST_INTERVAL_MS;
  currentJiraConcurrency = BASE_JIRA_CONCURRENCY;

  function logEntry(msg) {
    const entry = { t: new Date().toISOString(), msg };
    progressLog.push(entry);
    if (progressLog.length > 200) progressLog.shift();
    console.log(`runSnapshot: ${msg}`);
  }
  snapshotLogFn = logEntry;

  async function flushProgress() {
    try {
      await writeSnapshotMeta(installationKey, {
        processedFields: processedCount,
        totalFields: totalCount,
        progressLog: [...progressLog],
      });
    } catch {}
  }

  async function flushPendingFieldRecords() {
    if (!pendingFieldRecords.length) return;
    const batch = pendingFieldRecords.splice(0, pendingFieldRecords.length);
    await appendSnapshotFields(installationKey, version, batch);
  }

  try {
    await ensureProjectStoreReady();

    const existingMeta = await readSnapshotMeta(installationKey);

    let resuming = false;

    if (existingMeta?.state === "building") {
      const startedMs = existingMeta?.startedAt ? new Date(existingMeta.startedAt).getTime() : 0;
      const isStale = Date.now() - startedMs > 16 * 60 * 1000;
      if (!isStale) {
        console.log("runSnapshot: build already in progress, skipping duplicate");
        return;
      }
      if (existingMeta.buildingVersion) {
        version = existingMeta.buildingVersion;
        resuming = true;
        console.log(`runSnapshot: resuming stale build (version ${version})`);
      } else {
        console.log("runSnapshot: existing build had no version, starting fresh");
      }
    }

    if (!version) {
      version = String(Date.now());
      await clearSnapshotVersion(installationKey, version);
    }

    if (resuming && Array.isArray(existingMeta.progressLog)) {
      progressLog.push(...existingMeta.progressLog.slice(-80));
    }
    processedCount = resuming ? (existingMeta.processedFields || 0) : 0;

    await writeSnapshotMeta(installationKey, {
      state: "building",
      buildingVersion: version,
      startedAt: resuming ? existingMeta.startedAt : new Date().toISOString(),
      completedAt: null,
      lastError: null,
      processedFields: processedCount,
      progressLog: [...progressLog],
    });

    // Race-check: if multiple queue consumers started concurrently, only the last writer
    // of buildingVersion proceeds. Others detect the mismatch and exit cleanly.
    const raceCheck = await readSnapshotMeta(installationKey);
    if (raceCheck?.buildingVersion !== version) {
      console.log(`runSnapshot: lost startup race (our=${version} winner=${raceCheck?.buildingVersion}) — exiting`);
      return;
    }

    progressInterval = setInterval(() => {
      flushProgress().catch(() => {});
    }, SNAPSHOT_PROGRESS_FLUSH_INTERVAL_MS);

    const [customFields, systemFields] = await Promise.all([
      getAllCustomFields(),
      getAllSystemFields().catch(() => []),
    ]);
    const allFields = [
      ...customFields,
      ...systemFields.map((f) => ({ ...f, isSystemField: true })),
    ];
    totalCount = allFields.length;

    const nameCountMap = new Map();
    for (const field of allFields) {
      const key = normalizeFieldName(field.name);
      nameCountMap.set(key, (nameCountMap.get(key) || 0) + 1);
    }

    // Checkpoint: skip fields already written to DB in this version
    let alreadyDoneIds = new Set();
    if (resuming) {
      alreadyDoneIds = await getSnapshotProcessedFieldIds(installationKey, version);
      skipCount = alreadyDoneIds.size;
      processedCount = skipCount;
      logEntry(`Resuming — ${skipCount} of ${totalCount} fields already done, ${totalCount - skipCount} remaining`);
    } else {
      logEntry(`Found ${totalCount} custom fields — starting build`);
    }

    const fieldsToProcess = allFields.filter((f) => !alreadyDoneIds.has(f.id));

    await mapWithConcurrency(fieldsToProcess, SNAPSHOT_CONCURRENCY, async (field, index) => {
      if (cancelled) throw new CancelError();

      // Poll DB every 50 fields to pick up a cancel signal written by the resolver.
      // Also exit if a newer build has taken over the buildingVersion slot.
      if ((index + 1) % 50 === 0) {
        const currentMeta = await readSnapshotMeta(installationKey);
        if (currentMeta?.state !== "building" || currentMeta?.buildingVersion !== version) {
          cancelled = true;
          throw new CancelError();
        }
      }

      let totalIssueCount = 0;
      let configuredProjectCount = 0;
      let activeProjectCount = 0;
      const fieldsDone = skipCount + index + 1;
      const fieldTag = `[${fieldsDone}/${totalCount}] ${field.name} (${field.id})`;
      const t0 = Date.now();

      logEntry(`⋯ ${fieldTag} — querying`);

      // System fields are globally available — skip context/project association endpoint,
      // use JQL directly. Custom fields use project count to gate the issue count call.
      try {
        if (field.isSystemField) {
          totalIssueCount = await getFieldTotalIssueCount(field.id);
          configuredProjectCount = 0; // global — not tracked per-project context
        } else {
          configuredProjectCount = await getFieldConfiguredProjectCount(field.id);
          if (configuredProjectCount > 0 && getFieldNumericId(field.id)) {
            totalIssueCount = await getFieldTotalIssueCount(field.id);
          }
        }
        activeProjectCount = 0;
        const elapsed = Date.now() - t0;
        if (totalIssueCount > 0) {
          logEntry(`✓ ${fieldTag} — ${field.isSystemField ? "global" : `${configuredProjectCount} projects`}, ${totalIssueCount.toLocaleString()} issues (${elapsed}ms)`);
        } else if (totalIssueCount === -1) {
          logEntry(`⏱ ${fieldTag} — count timed out (${elapsed}ms)`);
        } else if (!field.isSystemField && configuredProjectCount > 0) {
          logEntry(`○ ${fieldTag} — ${configuredProjectCount} projects, 0 issues (${elapsed}ms)`);
        } else {
          logEntry(`— ${fieldTag} — 0 issues (${elapsed}ms)`);
        }
      } catch (usageErr) {
        const elapsed = Date.now() - t0;
        logEntry(`✗ ${fieldTag} — ERROR: ${usageErr?.message} (${elapsed}ms)`);
        console.warn(`runSnapshot: usage stats failed for ${field.id}: ${usageErr?.message}`);
      }

      // -1 means the count query timed out — store 0 so the record is valid,
      // governance findings won't fire for "unknown" fields
      const resolvedIssueCount = totalIssueCount < 0 ? 0 : totalIssueCount;

      const duplicateNameCount = nameCountMap.get(normalizeFieldName(field.name)) ?? 1;

      const findings = buildGovernanceFindings(field, {
        configuredProjectCount,
        totalIssueCount: resolvedIssueCount,
        activeProjectCount,
        duplicateNameCount,
        usageStatus: USAGE_STATUS_READY,
        usageStatusDetail: null,
        isSystemField: Boolean(field.isSystemField),
      });

      const record = buildInventoryRecord(field, {
        configuredProjectCount,
        activeProjectCount,
        totalIssueCount: resolvedIssueCount,
        usageStatus: USAGE_STATUS_READY,
        usageStatusDetail: null,
        findings,
      });

      // Write field record — per-project breakdown populated on-demand in getFieldDetails
      pendingFieldRecords.push(record);
      if (pendingFieldRecords.length >= SNAPSHOT_DB_BATCH_SIZE) {
        await flushPendingFieldRecords();
      }
      processedCount = skipCount + index + 1;
    });

    logEntry(`Finalizing — ${totalCount} fields complete | 429s: ${rl429Count} retries: ${rlRetryCount}`);
    await flushPendingFieldRecords();
    // Preserve historical per-field project usage built up by individual field scans.
    // Must run before clearOtherSnapshotVersions or the old data is lost.
    await carryForwardSnapshotProjectUsage(installationKey, version);
    await clearOtherSnapshotVersions(installationKey, version);

    // Fill any gaps in project usage from field_summaries (INSERT IGNORE — won't touch data that carried forward).
    // This recovers silently from version-transition data loss without overwriting fresh per-field scan results.
    const fillResult = await fillSnapshotProjectUsageFromSummaries(installationKey, version);
    if (fillResult.rowsInserted > 0) {
      logEntry(`Filled ${fillResult.fieldsRestored} fields (${fillResult.rowsInserted} project rows) from field summaries`);
    }

    const refreshedAt = new Date().toISOString();
    clearInterval(progressInterval);
    progressInterval = null;

    await writeSnapshotMeta(installationKey, {
      state: "ready",
      version,
      buildingVersion: null,
      completedAt: refreshedAt,
      refreshedAt,
      totalFields: totalCount,
      processedFields: totalCount,
      progressLog: [...progressLog],
      lastError: null,
    });

    try {
      await inventorySnapshotQueue.push({ body: { jobType: "run-delta-issue-scan", installationKey } });
    } catch { /* non-critical */ }
  } catch (err) {
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
    // Before writing back, verify we still own the build slot.
    // A newer build may have taken over — don't clobber its state.
    const finalMeta = await readSnapshotMeta(installationKey).catch(() => null);
    const stillOwner = finalMeta?.buildingVersion === version;

    if (err?.isCancelError) {
      logEntry(`Build cancelled — ${processedCount} of ${totalCount} fields processed`);
      if (stillOwner) {
        await writeSnapshotMeta(installationKey, {
          state: "cancelled",
          buildingVersion: null,
          lastError: null,
          processedFields: processedCount,
          progressLog: [...progressLog],
        }).catch(() => {});
      }
    } else {
      console.error("runSnapshot failed:", err?.message || err);
      if (stillOwner) {
        // Keep state as "building" (not "failed") so stale-build detection can resume
        await writeSnapshotMeta(installationKey, {
          state: "building",
          lastError: err?.message || String(err),
          processedFields: processedCount,
          progressLog: [...progressLog],
        }).catch(() => {});
      }
    }
  } finally {
    if (progressInterval) clearInterval(progressInterval);
    snapshotLogFn = null;
  }
}

// ----- Universe issue scan -----
// Processes up to ISSUE_SCAN_CHUNK_PAGES pages per Forge invocation using cursor-based
// pagination (/rest/api/3/search/jql uses nextPageToken, not startAt).
// Self-queues the next chunk until the scan completes. On final chunk:
//   1. Writes unique-issue-counts-per-project to issue_scan_project_totals
//   2. Promotes field×project counts into snapshot_project_usage
//   3. Updates snapshot_fields.active_project_count for each promoted field
const ISSUE_SCAN_CHUNK_PAGES = 10;
const ISSUE_SCAN_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

function isJiraRateLimitError(error) {
  return Number(error?.status) === 429;
}

function isExpiredPageTokenError(error) {
  return Number(error?.status) === 400 && String(error?.message || "").toLowerCase().includes("next page token");
}

async function getAllJiraProjectKeys() {
  const keys = [];
  let startAt = 0;
  for (;;) {
    const data = await jiraRequest(
      route`/rest/api/3/project/search?maxResults=50&startAt=${startAt}`,
      {}
    );
    const values = data?.values || [];
    for (const p of values) if (p.key) keys.push(p.key);
    if (data?.isLast || values.length === 0) break;
    startAt += values.length;
  }
  return keys;
}

async function queueIssueScanChunk(installationKey, progressLog = [], nextStartAt = 0) {
  const retryDelaysMs = [0, 2000, 5000];
  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    if (retryDelaysMs[attempt] > 0) await sleep(retryDelaysMs[attempt]);
    try {
      await inventorySnapshotQueue.push({
        body: { jobType: "run-issue-scan", installationKey },
      });
      return true;
    } catch (pushError) {
      if (attempt < retryDelaysMs.length - 1) continue;
      const delayMs = ISSUE_SCAN_RATE_LIMIT_COOLDOWN_MS;
      const queuedLog = [
        ...progressLog,
        {
          t: new Date().toISOString(),
          msg: `Queue backpressure hit; pausing universe scan for ${Math.round(delayMs / 1000)}s before retry`,
        },
      ];
      await writeIssueScanMeta(installationKey, {
        state: "queued",
        nextStartAt: nextStartAt || (Date.now() + delayMs),
        lastError: null,
        progressLog: queuedLog,
      }).catch(() => {});
      return false;
    }
  }
  return false;
}

async function queueIssueScanWorker(installationKey, workerId) {
  await inventorySnapshotQueue.push({
    body: { jobType: "run-issue-scan-worker", installationKey, workerId },
  });
}

async function queueFieldOptionsCache(installationKey, fieldId) {
  await inventorySnapshotQueue.push({
    body: { jobType: "cache-field-options", installationKey, fieldId },
  });
}

async function loadFieldOptionsFromJira(fieldId) {
  const contexts = await getFieldContexts(fieldId);
  return Promise.all(
    contexts.map(async (ctx) => {
      try {
        const options = await paginate(
          (startAt) => route`/rest/api/3/field/${fieldId}/context/${ctx.id}/option?startAt=${startAt}&maxResults=100`,
          "values"
        );
        return {
          contextId: String(ctx.id),
          contextName: String(ctx.name || "Default context"),
          isGlobalContext: Boolean(ctx.isGlobalContext),
          options: options.map((opt) => ({
            id: String(opt.id),
            value: String(opt.value || ""),
            disabled: Boolean(opt.disabled),
          })),
        };
      } catch (optError) {
        console.error(`loadFieldOptionsFromJira: context ${ctx.id} options fetch failed:`, optError?.message || optError);
        return {
          contextId: String(ctx.id),
          contextName: String(ctx.name || "Default context"),
          isGlobalContext: Boolean(ctx.isGlobalContext),
          options: [],
          fetchError: optError?.message || String(optError),
        };
      }
    })
  );
}

async function cacheFieldOptionsForField(installationKey, fieldId) {
  if (!fieldId) return { fieldId, optionCount: 0 };
  const optionsByContext = await loadFieldOptionsFromJira(fieldId);
  const result = await replaceFieldOptionsCache(installationKey, fieldId, optionsByContext);
  return { fieldId, ...result };
}

async function completeIssueScanFinalization(installationKey, tag, workerError = null) {
  try {
    console.log(`${tag}: finalizing scan...`);
    await finalizeIssueScan(installationKey);

    const snapshotMeta = await readSnapshotMeta(installationKey);
    if (snapshotMeta?.version) {
      const promoted = await promoteIssueScanToSnapshotProjectUsage(installationKey, snapshotMeta.version);
      console.log(`${tag}: promoted ${promoted.fieldsPromoted} fields (${promoted.rowsInserted} rows)`);
    }

    try {
      await inventorySnapshotQueue.push({ body: { jobType: "run-delta-issue-scan", installationKey } });
    } catch { /* non-critical */ }

    const finalMeta = await readIssueScanMeta(installationKey);
    await writeIssueScanMeta(installationKey, {
      state: "ready",
      completedAt: new Date().toISOString(),
      nextPageToken: null,
      nextStartAt: 0,
      lastError: workerError,
      progressLog: [
        ...((finalMeta?.progressLog || []).slice(-40)),
        { t: new Date().toISOString(), msg: `Scan complete - ${(finalMeta?.processedIssues || 0).toLocaleString()} issues` },
      ],
    });
    console.log(`${tag}: scan finalized and marked ready`);
  } catch (error) {
    const message = error?.message || String(error);
    console.error(`${tag}: finalization failed:`, message);
    const finalMeta = await readIssueScanMeta(installationKey).catch(() => null);
    await writeIssueScanMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      nextPageToken: null,
      nextStartAt: 0,
      lastError: `Finalization failed: ${message}`,
      progressLog: [
        ...((finalMeta?.progressLog || []).slice(-40)),
        { t: new Date().toISOString(), msg: `Finalization failed - ${message}` },
      ],
    }).catch(() => {});
  }
}

async function runIssueScanCoordinator(installationKey) {
  try {
    await ensureProjectStoreReady();

    const existing = await readIssueScanMeta(installationKey);
    if (existing?.state !== "queued") {
      console.log("runIssueScanCoordinator: not in queued state, skipping");
      return;
    }

    const log = (msg) => console.log(`runIssueScanCoordinator: ${msg}`);

    log("Fetching all project keys...");
    const allProjectKeys = await getAllJiraProjectKeys();

    if (allProjectKeys.length === 0) {
      await writeIssueScanMeta(installationKey, {
        state: "ready",
        completedAt: new Date().toISOString(),
        totalIssues: 0,
        processedIssues: 0,
        totalPages: 0,
        processedPages: 0,
        progressLog: [{ t: new Date().toISOString(), msg: "No projects found — scan skipped" }],
      });
      return;
    }

    // Get site-wide issue count for progress tracking
    log("Fetching site-wide issue count...");
    const globalCountResult = await withTimeout(
      jiraRequest(route`/rest/api/3/search/approximate-count`, {
        method: "POST",
        body: JSON.stringify({ jql: "project is not empty" }),
      }),
      ISSUE_COUNT_TIMEOUT_MS
    ).catch(() => null);
    const totalEstimatedIssues = Number(globalCountResult?.count ?? 0);
    log(`Site-wide issue count: ${totalEstimatedIssues.toLocaleString()}`);

    // Get per-project approximate counts to load-balance workers.
    // Prefer historical data; fall back to live approximate-count for unknown projects.
    const knownTotals = await loadIssueScanProjectTotals(installationKey).catch(() => []);
    const issueCountByKey = new Map(knownTotals.map((r) => [r.projectKey, r.uniqueIssueCount]));
    const unknownKeys = allProjectKeys.filter((k) => !issueCountByKey.has(k));
    if (unknownKeys.length > 0) {
      log(`Fetching approximate counts for ${unknownKeys.length} unknown projects...`);
      const APPROX_BATCH = 8;
      for (let i = 0; i < unknownKeys.length; i += APPROX_BATCH) {
        const batch = unknownKeys.slice(i, i + APPROX_BATCH);
        const results = await Promise.all(
          batch.map((key) =>
            withTimeout(
              jiraRequest(route`/rest/api/3/search/approximate-count`, {
                method: "POST",
                body: JSON.stringify({ jql: `project = "${key}"` }),
              }),
              ISSUE_COUNT_TIMEOUT_MS
            )
              .then((r) => [key, Number(r?.count ?? 0)])
              .catch(() => [key, 100])
          )
        );
        for (const [key, count] of results) issueCountByKey.set(key, count || 1);
        if (i + APPROX_BATCH < unknownKeys.length) await sleep(150);
      }
    }

    // Greedy bin-pack: assign projects to ISSUE_SCAN_WORKERS bins so each bin has
    // approximately equal total issue count. Sort largest-first (LPT heuristic).
    const sortedKeys = [...allProjectKeys].sort(
      (a, b) => (issueCountByKey.get(b) ?? 1) - (issueCountByKey.get(a) ?? 1)
    );
    const bins = Array.from({ length: ISSUE_SCAN_WORKERS }, () => ({ keys: [], count: 0 }));
    for (const key of sortedKeys) {
      const smallest = bins.reduce((min, b) => b.count < min.count ? b : min);
      smallest.keys.push(key);
      smallest.count += issueCountByKey.get(key) ?? 1;
    }

    // Build one JQL filter per worker covering all its assigned projects
    const workerJqls = bins.map((bin) =>
      bin.keys.length === 0 ? null : `project IN (${bin.keys.map((k) => `"${k}"`).join(", ")})`
    );

    // Targeted fields from the active snapshot — smaller payloads, faster per-page processing
    const snapshotMeta = await readSnapshotMeta(installationKey);
    let fieldIds = null;
    if (snapshotMeta?.version) {
      const snapshotFields = await loadSnapshotFields(installationKey, snapshotMeta.version);
      const ids = new Set(snapshotFields.map((field) => field.id));
      if (ids.size > 0) fieldIds = ["project", ...ids];
      const selectFields = snapshotFields.filter((field) => isSelectFieldType(field.type));
      for (const field of selectFields) {
        try {
          await queueFieldOptionsCache(installationKey, field.id);
        } catch (pushError) {
          console.warn(`runIssueScanCoordinator: failed to queue option cache for ${field.id}:`, pushError?.message || pushError);
        }
      }
    }

    log(`Starting ${ISSUE_SCAN_WORKERS} workers across ${allProjectKeys.length} projects (${totalEstimatedIssues.toLocaleString()} issues on site)`);

    await clearIssueScanBuffer(installationKey);
    await clearRqtFieldIndex(installationKey);
    await clearRqtIssueKeys(installationKey);
    await clearRqtValueIndex(installationKey);
    await clearRqtFieldIssueIndex(installationKey);
    await writeIssueScanMeta(installationKey, {
      state: "building",
      startedAt: new Date().toISOString(),
      completedAt: null,
      totalPages: ISSUE_SCAN_WORKERS,  // one slot per worker; finalization fires when all done
      processedPages: 0,
      totalIssues: totalEstimatedIssues,
      processedIssues: 0,
      nextPageToken: null,
      nextStartAt: 0,
      lastError: null,
      progressLog: [{ t: new Date().toISOString(), msg: `Starting ${ISSUE_SCAN_WORKERS} workers — ${totalEstimatedIssues.toLocaleString()} issues on site` }],
    });

    await replaceIssueScanWorkers(
      installationKey,
      workerJqls.map((jqlFilter, workerId) => ({
        workerId,
        status: "queued",
        jqlFilter,
        fieldIds,
      }))
    );

    for (let i = 0; i < ISSUE_SCAN_WORKERS; i++) {
      await queueIssueScanWorker(installationKey, i);
    }

    log(`All ${ISSUE_SCAN_WORKERS} workers queued`);
  } catch (error) {
    console.error("runIssueScanCoordinator failed:", error?.message || error);
    await writeIssueScanMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: error?.message || String(error),
    }).catch(() => {});
  }
}

async function runIssueScanWorker(installationKey, workerId, jqlFilter, fieldIds) {
  const tag = `runIssueScanWorker[${workerId}]`;
  if (!jqlFilter) {
    // Empty bin — no projects assigned; count this worker done immediately
    console.log(`${tag}: no projects assigned, skipping`);
    const updatedMeta = await atomicAccumulateIssueScanProgress(installationKey, 1, 0).catch(() => null);
    if (updatedMeta && updatedMeta.processedPages >= updatedMeta.totalPages && updatedMeta.totalPages > 0) {
      const claimToken = makeJobToken();
      const claimed = await tryClaimIssueScanFinalization(installationKey, claimToken).catch(() => false);
      if (claimed) await finalizeIssueScan(installationKey).catch(() => {});
    }
    return;
  }
  const jql = jqlFilter;
  console.log(`${tag}: starting — jql: ${jql}`);

  let pendingIssues = 0;
  const fieldProjectCounts = new Map();
  const projectTotals = new Map();
  const rqtFieldHits = new Map(); // fieldId → { count, values: Set<string> }
  const rqtIssueBuffer = []; // { projectKey, issueKey }
  const rqtValueBuffer = []; // { rqtValue, issueKey }
  const rqtFieldIssueBuffer = []; // { fieldId, issueKey }

  try {
    await ensureProjectStoreReady();

    const scanFields = fieldIds || ["*all"];
    let currentNextPageToken = null;
    let pageCount = 0;
    let issueCount = 0;

    for (let page = 0; ; page++) {
      // Periodic flush + progress push + cancellation check
      if (page > 0 && page % ISSUE_SCAN_FLUSH_EVERY_PAGES === 0) {
        if (fieldProjectCounts.size > 0 || projectTotals.size > 0) {
          await flushIssueScanCounts(installationKey, fieldProjectCounts, projectTotals);
          fieldProjectCounts.clear();
          projectTotals.clear();
        }
        if (pendingIssues > 0) {
          const updMid = await atomicAccumulateIssueScanProgress(installationKey, 0, pendingIssues).catch(() => null);
          if (updMid) {
            const cur = updMid.processedIssues ?? 0;
            const prev = cur - pendingIssues;
            if (Math.floor(prev / 5000) < Math.floor(cur / 5000)) {
              const tot = updMid.totalIssues ?? 0;
              await appendIssueScanLogEntry(installationKey,
                `${cur.toLocaleString()}${tot > 0 ? ` / ${tot.toLocaleString()}` : ""} issues scanned`
              ).catch(() => {});
            }
          }
          pendingIssues = 0;
        }
        const cancelCheck = await readIssueScanMeta(installationKey);
        if (cancelCheck?.state === "cancelled") {
          console.log(`${tag}: scan cancelled`);
          return;
        }
      }

      const reqBody = {
        jql,
        maxResults: ISSUE_SCAN_PAGE_SIZE,
        fields: scanFields,
        fieldsByKeys: false,
      };
      if (currentNextPageToken) reqBody.nextPageToken = currentNextPageToken;

      const data = await jiraRequest(route`/rest/api/3/search/jql`, {
        method: "POST",
        body: JSON.stringify(reqBody),
      });

      const issues = data?.issues || [];
      const newNextPageToken = data?.nextPageToken || null;

      for (const issue of issues) {
        const projectId = String(issue.fields?.project?.id || "");
        if (!projectId) continue;
        const projectKey_ = String(issue.fields?.project?.key || "");
        const projectName = String(issue.fields?.project?.name || projectKey_);

        const projEntry = projectTotals.get(projectId) || { count: 0, key: projectKey_, name: projectName };
        projEntry.count++;
        projectTotals.set(projectId, projEntry);

        for (const [fieldId, value] of Object.entries(issue.fields || {})) {
          if (STRUCTURAL_SYSTEM_FIELDS.has(fieldId)) continue;
          if (!isFieldValueNonEmpty(value)) continue;
          let byProject = fieldProjectCounts.get(fieldId);
          if (!byProject) { byProject = new Map(); fieldProjectCounts.set(fieldId, byProject); }
          const entry = byProject.get(projectId) || { count: 0, key: projectKey_, name: projectName };
          entry.count++;
          byProject.set(projectId, entry);
        }

        const issueRqt = collectIssueRqtValues(issue.fields, issue.fields?.summary);
        for (const [fieldId, values] of issueRqt) {
          const rqtEntry = rqtFieldHits.get(fieldId) || { count: 0, values: new Set() };
          rqtEntry.count++;
          for (const v of values) rqtEntry.values.add(v);
          rqtFieldHits.set(fieldId, rqtEntry);
        }

        if (issueRqt.size > 0 && issue.key) {
          rqtIssueBuffer.push({
            projectKey: projectKey_,
            issueType: issue.fields?.issuetype?.name || "Unknown",
            issueKey: issue.key,
          });
          const allValues = new Set();
          for (const vals of issueRqt.values()) for (const v of vals) allValues.add(v);
          for (const v of allValues) rqtValueBuffer.push({ rqtValue: v, issueKey: issue.key });
        }
        if (issueRqt.size > 0 && issue.key) {
          for (const fieldId of issueRqt.keys()) {
            rqtFieldIssueBuffer.push({ fieldId, issueKey: issue.key });
          }
        }
      }

      pageCount++;
      issueCount += issues.length;
      pendingIssues += issues.length;
      currentNextPageToken = newNextPageToken;
      if (!newNextPageToken || issues.length === 0) break;
      await sleep(ISSUE_SCAN_INTER_PAGE_DELAY_MS);
    }

    // Flush remaining counts then mark this worker done (processedPages += 1)
    if (fieldProjectCounts.size > 0 || projectTotals.size > 0) {
      await flushIssueScanCounts(installationKey, fieldProjectCounts, projectTotals);
    }
    if (rqtFieldHits.size > 0) {
      await upsertRqtFieldHits(installationKey, rqtFieldHits).catch((e) => {
        console.error(`${tag}: RQT flush error`, e?.message || e);
      });
    }
    if (rqtIssueBuffer.length > 0) {
      await upsertRqtIssueKeys(installationKey, rqtIssueBuffer).catch((e) => {
        console.error(`${tag}: RQT issue key flush error`, e?.message || e);
      });
    }
    if (rqtValueBuffer.length > 0) {
      await upsertRqtValueIssueKeys(installationKey, rqtValueBuffer).catch((e) => {
        console.error(`${tag}: RQT value index flush error`, e?.message || e);
      });
    }
    if (rqtFieldIssueBuffer.length > 0) {
      await upsertRqtFieldIssueKeys(installationKey, rqtFieldIssueBuffer).catch((e) => {
        console.error(`RQT field issue index flush error`, e?.message || e);
      });
    }
    const updatedMeta = await atomicAccumulateIssueScanProgress(installationKey, 1, pendingIssues);
    pendingIssues = 0;
    console.log(`${tag}: done — ${issueCount} issues, ${pageCount} pages`);

    // Last worker to finish claims finalization
    const doneWorkers = updatedMeta?.processedPages ?? 0;
    const totalWorkers = updatedMeta?.totalPages ?? 0;
    if (doneWorkers >= totalWorkers && totalWorkers > 0) {
      const claimToken = makeJobToken();
      const claimed = await tryClaimIssueScanFinalization(installationKey, claimToken);
      if (claimed) {
        console.log(`${tag}: finalizing scan...`);
        await finalizeIssueScan(installationKey);

        const snapshotMeta = await readSnapshotMeta(installationKey);
        if (snapshotMeta?.version) {
          const promoted = await promoteIssueScanToSnapshotProjectUsage(installationKey, snapshotMeta.version);
          console.log(`${tag}: promoted ${promoted.fieldsPromoted} fields (${promoted.rowsInserted} rows)`);
        }

        try {
          await inventorySnapshotQueue.push({ body: { jobType: "run-delta-issue-scan", installationKey } });
        } catch { /* non-critical */ }

        const finalMeta = await readIssueScanMeta(installationKey);
        await writeIssueScanMeta(installationKey, {
          state: "ready",
          completedAt: new Date().toISOString(),
          nextStartAt: 0,
          lastError: null,
          progressLog: [
            ...((finalMeta?.progressLog || []).slice(-40)),
            { t: new Date().toISOString(), msg: `Scan complete — ${(finalMeta?.processedIssues || 0).toLocaleString()} issues` },
          ],
        });
        console.log(`${tag}: scan finalized and marked ready`);
      }
    }

  } catch (error) {
    const errMsg = error?.message || String(error);
    if (isJiraRateLimitError(error)) {
      const retryAfterMs = getRetryDelayMs(error, 0);
      const retryAt = Date.now() + retryAfterMs;
      console.warn(`${tag}: rate-limited; checkpoint kept and worker will retry in ${Math.round(retryAfterMs / 1000)}s`);
      await updateIssueScanWorker(installationKey, workerId, {
        status: "queued",
        lastError: `Rate-limited; retrying after ${new Date(retryAt).toISOString()}`,
      }).catch(() => {});
      await appendIssueScanLogEntry(
        installationKey,
        `Worker ${workerId} rate-limited - retrying in ${Math.round(retryAfterMs / 1000)}s`
      ).catch(() => {});
      await sleep(retryAfterMs);
      await queueIssueScanWorker(installationKey, workerId).catch(async (pushError) => {
        await writeIssueScanMeta(installationKey, {
          state: "queued",
          nextStartAt: Date.now() + ISSUE_SCAN_RATE_LIMIT_COOLDOWN_MS,
          lastError: `Queue retry failed after rate limit: ${pushError?.message || String(pushError)}`,
        }).catch(() => {});
      });
      return;
    }
    console.error(`${tag} failed:`, errMsg);
    await appendIssueScanLogEntry(installationKey, `Worker ${workerId} failed — ${errMsg}`).catch(() => {});
    // Count this worker done so finalization can still fire if it was the last one
    const updatedMeta = await atomicAccumulateIssueScanProgress(installationKey, 1, pendingIssues).catch(() => null);
    if (updatedMeta && updatedMeta.processedPages >= updatedMeta.totalPages && updatedMeta.totalPages > 0) {
      const claimToken = makeJobToken();
      const claimed = await tryClaimIssueScanFinalization(installationKey, claimToken).catch(() => false);
      if (claimed) {
        await finalizeIssueScan(installationKey).catch(() => {});
        const snapshotMeta = await readSnapshotMeta(installationKey).catch(() => null);
        if (snapshotMeta?.version) {
          await promoteIssueScanToSnapshotProjectUsage(installationKey, snapshotMeta.version).catch(() => {});
        }
        try { await inventorySnapshotQueue.push({ body: { jobType: "run-delta-issue-scan", installationKey } }); } catch { /* non-critical */ }
        await writeIssueScanMeta(installationKey, {
          state: "ready",
          completedAt: new Date().toISOString(),
          nextStartAt: 0,
          lastError: `Worker ${workerId} failed — ${errMsg}`,
        }).catch(() => {});
      }
    }
  }
}

async function runIssueScanWorkerV2(installationKey, workerId) {
  const tag = `runIssueScanWorker[${workerId}]`;
  let pendingIssues = 0;
  const fieldProjectCounts = new Map();
  const projectTotals = new Map();
  const rqtFieldHits = new Map();
  const rqtIssueBuffer = [];
  const rqtValueBuffer = []; // { rqtValue, issueKey }
  const rqtFieldIssueBuffer = []; // { fieldId, issueKey }

  try {
    await ensureProjectStoreReady();

    const meta = await readIssueScanMeta(installationKey);
    if (meta?.state !== "building") {
      console.log(`${tag}: scan state is ${meta?.state || "missing"}, skipping`);
      return;
    }

    let worker = await readIssueScanWorker(installationKey, workerId);
    if (!worker) throw new Error(`Missing worker checkpoint for worker ${workerId}`);
    if (worker.status === "done") {
      console.log(`${tag}: already done`);
      return;
    }
    if (worker.status === "building" && worker.updatedAt) {
      const ageMs = Date.now() - new Date(worker.updatedAt).getTime();
      if (Number.isFinite(ageMs) && ageMs < 2 * 60 * 1000) {
        console.log(`${tag}: worker already active, skipping duplicate event`);
        return;
      }
    }

    if (!worker.jqlFilter) {
      console.log(`${tag}: no projects assigned, marking done`);
      await updateIssueScanWorker(installationKey, workerId, { status: "done", nextPageToken: null, lastError: null });
      const updatedMeta = await atomicAccumulateIssueScanProgress(installationKey, 1, 0).catch(() => null);
      if (updatedMeta && updatedMeta.processedPages >= updatedMeta.totalPages && updatedMeta.totalPages > 0) {
        const claimToken = makeJobToken();
        const claimed = await tryClaimIssueScanFinalization(installationKey, claimToken).catch(() => false);
        if (claimed) await completeIssueScanFinalization(installationKey, tag);
      }
      return;
    }

    await updateIssueScanWorker(installationKey, workerId, { status: "building", lastError: null });

    const scanFields = Array.isArray(worker.fieldIds) && worker.fieldIds.length ? worker.fieldIds : ["*all"];
    let currentNextPageToken = worker.nextPageToken || null;
    let pageCount = 0;
    let issueCount = 0;

    for (let page = 0; page < ISSUE_SCAN_CHUNK_PAGES; page++) {
      if (page > 0 && page % ISSUE_SCAN_FLUSH_EVERY_PAGES === 0) {
        if (fieldProjectCounts.size > 0 || projectTotals.size > 0) {
          await flushIssueScanCounts(installationKey, fieldProjectCounts, projectTotals);
          fieldProjectCounts.clear();
          projectTotals.clear();
        }
        if (rqtFieldHits.size > 0) {
          await upsertRqtFieldHits(installationKey, rqtFieldHits).catch(() => {});
          rqtFieldHits.clear();
        }
        if (pendingIssues > 0) {
          const updMid = await atomicAccumulateIssueScanProgress(installationKey, 0, pendingIssues).catch(() => null);
          if (updMid) {
            const cur = updMid.processedIssues ?? 0;
            const prev = cur - pendingIssues;
            if (Math.floor(prev / 5000) < Math.floor(cur / 5000)) {
              await appendIssueScanLogEntry(installationKey, `${cur.toLocaleString()} issues scanned`).catch(() => {});
            }
          }
          worker = await updateIssueScanWorker(installationKey, workerId, {
            status: "building",
            nextPageToken: currentNextPageToken,
            processedIssues: Number(worker.processedIssues || 0) + issueCount,
            processedPages: Number(worker.processedPages || 0) + pageCount,
            lastError: null,
          }) || worker;
          issueCount = 0;
          pageCount = 0;
          pendingIssues = 0;
        }
        const cancelCheck = await readIssueScanMeta(installationKey);
        if (cancelCheck?.state === "cancelled") {
          console.log(`${tag}: scan cancelled`);
          return;
        }
      }

      const reqBody = {
        jql: worker.jqlFilter,
        maxResults: ISSUE_SCAN_PAGE_SIZE,
        fields: scanFields,
        fieldsByKeys: false,
      };
      if (currentNextPageToken) reqBody.nextPageToken = currentNextPageToken;

      let data;
      try {
        data = await jiraRequest(route`/rest/api/3/search/jql`, {
          method: "POST",
          body: JSON.stringify(reqBody),
        });
      } catch (searchErr) {
        const errStr = String(searchErr?.message || searchErr || "");
        const is400 = errStr.includes("400") || searchErr?.statusCode === 400 || searchErr?.status === 400;
        if (is400 && currentNextPageToken) {
          // Cursor token expired — flush buffered data and restart this worker from the beginning
          console.warn(`${tag}: 400 on paginated search — nextPageToken likely expired; flushing and restarting worker`);
          await appendIssueScanLogEntry(installationKey, `Worker ${workerId}: page token expired (400), restarting from page 1`).catch(() => {});
          if (fieldProjectCounts.size > 0 || projectTotals.size > 0) {
            await flushIssueScanCounts(installationKey, fieldProjectCounts, projectTotals).catch(() => {});
            fieldProjectCounts.clear(); projectTotals.clear();
          }
          if (rqtFieldHits.size > 0) { await upsertRqtFieldHits(installationKey, rqtFieldHits).catch(() => {}); rqtFieldHits.clear(); }
          if (rqtIssueBuffer.length > 0) { await upsertRqtIssueKeys(installationKey, rqtIssueBuffer).catch(() => {}); rqtIssueBuffer.length = 0; }
          if (rqtValueBuffer.length > 0) { await upsertRqtValueIssueKeys(installationKey, rqtValueBuffer).catch(() => {}); rqtValueBuffer.length = 0; }
          if (rqtFieldIssueBuffer.length > 0) { await upsertRqtFieldIssueKeys(installationKey, rqtFieldIssueBuffer).catch(() => {}); rqtFieldIssueBuffer.length = 0; }
          await updateIssueScanWorker(installationKey, workerId, {
            status: "queued", nextPageToken: null, lastError: "Page token expired; restarting from beginning",
          }).catch(() => {});
          await queueIssueScanWorker(installationKey, workerId);
          return;
        }
        throw searchErr;
      }

      const issues = data?.issues || [];
      const newNextPageToken = data?.nextPageToken || null;

      for (const issue of issues) {
        const projectId = String(issue.fields?.project?.id || "");
        if (!projectId) continue;
        const projectKey_ = String(issue.fields?.project?.key || "");
        const projectName = String(issue.fields?.project?.name || projectKey_);

        const projEntry = projectTotals.get(projectId) || { count: 0, key: projectKey_, name: projectName };
        projEntry.count++;
        projectTotals.set(projectId, projEntry);

        for (const [fieldId, value] of Object.entries(issue.fields || {})) {
          if (STRUCTURAL_SYSTEM_FIELDS.has(fieldId)) continue;
          if (!isFieldValueNonEmpty(value)) continue;
          let byProject = fieldProjectCounts.get(fieldId);
          if (!byProject) {
            byProject = new Map();
            fieldProjectCounts.set(fieldId, byProject);
          }
          const entry = byProject.get(projectId) || { count: 0, key: projectKey_, name: projectName };
          entry.count++;
          byProject.set(projectId, entry);
        }

        const issueRqt = collectIssueRqtValues(issue.fields, issue.fields?.summary);
        for (const [fieldId, values] of issueRqt) {
          const rqtEntry = rqtFieldHits.get(fieldId) || { count: 0, values: new Set() };
          rqtEntry.count++;
          for (const v of values) rqtEntry.values.add(v);
          rqtFieldHits.set(fieldId, rqtEntry);
        }

        if (issueRqt.size > 0 && issue.key) {
          rqtIssueBuffer.push({
            projectKey: projectKey_,
            issueType: issue.fields?.issuetype?.name || "Unknown",
            issueKey: issue.key,
          });
          const allValues = new Set();
          for (const vals of issueRqt.values()) for (const v of vals) allValues.add(v);
          for (const v of allValues) rqtValueBuffer.push({ rqtValue: v, issueKey: issue.key });
        }
        if (issueRqt.size > 0 && issue.key) {
          for (const fieldId of issueRqt.keys()) {
            rqtFieldIssueBuffer.push({ fieldId, issueKey: issue.key });
          }
        }
      }

      pageCount++;
      issueCount += issues.length;
      pendingIssues += issues.length;
      currentNextPageToken = newNextPageToken;
      if (!newNextPageToken || issues.length === 0) break;
      await sleep(ISSUE_SCAN_INTER_PAGE_DELAY_MS);
    }

    if (fieldProjectCounts.size > 0 || projectTotals.size > 0) {
      await flushIssueScanCounts(installationKey, fieldProjectCounts, projectTotals);
    }
    if (rqtFieldHits.size > 0) {
      await upsertRqtFieldHits(installationKey, rqtFieldHits).catch((e) => {
        console.error(`${tag}: RQT flush error`, e?.message || e);
      });
    }
    if (rqtIssueBuffer.length > 0) {
      await upsertRqtIssueKeys(installationKey, rqtIssueBuffer).catch((e) => {
        console.error(`${tag}: RQT issue key flush error`, e?.message || e);
      });
    }
    if (rqtValueBuffer.length > 0) {
      await upsertRqtValueIssueKeys(installationKey, rqtValueBuffer).catch((e) => {
        console.error(`${tag}: RQT value index flush error`, e?.message || e);
      });
    }
    if (rqtFieldIssueBuffer.length > 0) {
      await upsertRqtFieldIssueKeys(installationKey, rqtFieldIssueBuffer).catch((e) => {
        console.error(`RQT field issue index flush error`, e?.message || e);
      });
    }

    const processedIssues = Number(worker.processedIssues || 0) + issueCount;
    const processedPages = Number(worker.processedPages || 0) + pageCount;
    const isDone = !currentNextPageToken;
    await updateIssueScanWorker(installationKey, workerId, {
      status: isDone ? "done" : "queued",
      nextPageToken: currentNextPageToken,
      processedIssues,
      processedPages,
      lastError: null,
    });

    const updatedMeta = await atomicAccumulateIssueScanProgress(installationKey, isDone ? 1 : 0, pendingIssues);
    pendingIssues = 0;

    if (!isDone) {
      await queueIssueScanWorker(installationKey, workerId);
      console.log(`${tag}: checkpointed - ${processedIssues} issues, ${processedPages} pages; requeued`);
      return;
    }

    console.log(`${tag}: done - ${processedIssues} issues, ${processedPages} pages`);
    if ((updatedMeta?.processedPages ?? 0) >= (updatedMeta?.totalPages ?? 0) && (updatedMeta?.totalPages ?? 0) > 0) {
      const claimToken = makeJobToken();
      const claimed = await tryClaimIssueScanFinalization(installationKey, claimToken);
      if (claimed) await completeIssueScanFinalization(installationKey, tag);
    }
  } catch (error) {
    const errMsg = error?.message || String(error);
    console.error(`${tag} failed:`, errMsg);
    await updateIssueScanWorker(installationKey, workerId, { status: "failed", lastError: errMsg }).catch(() => {});
    await appendIssueScanLogEntry(installationKey, `Worker ${workerId} failed - ${errMsg}`).catch(() => {});
    await writeIssueScanMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      nextPageToken: null,
      nextStartAt: 0,
      lastError: `Worker ${workerId} failed - ${errMsg}`,
    }).catch(() => {});
  }
}

// ----- Inventory UI helpers -----

const OPTION_SEARCH_FIELD_BATCH_SIZE = 10;

async function findFieldIdsByOptionValue(fields, optionQuery, startIndex = 0, maxFields = OPTION_SEARCH_FIELD_BATCH_SIZE) {
  const normalizedQuery = String(optionQuery || "").trim().toLowerCase();
  if (!normalizedQuery) return { matchingIds: null, nextIndex: 0, done: true, scanned: 0, totalCandidates: 0 };

  const selectFields = fields.filter((field) => isSelectFieldType(field.type));
  const offset = Math.max(0, Math.min(selectFields.length, Number(startIndex) || 0));
  const limit = Math.max(1, Math.min(25, Number(maxFields) || OPTION_SEARCH_FIELD_BATCH_SIZE));
  const batch = selectFields.slice(offset, offset + limit);
  const matchingIds = new Set();

  await mapWithConcurrency(batch, 2, async (field) => {
    if (matchingIds.has(field.id)) return;
    try {
      const contexts = await getFieldContexts(field.id);
      for (const ctx of contexts) {
        if (matchingIds.has(field.id)) break;
        const options = await paginate(
          (startAt) => route`/rest/api/3/field/${field.id}/context/${ctx.id}/option?startAt=${startAt}&maxResults=100`,
          "values"
        );
        if (options.some((opt) => String(opt.value || "").toLowerCase().includes(normalizedQuery))) {
          matchingIds.add(field.id);
          break;
        }
      }
    } catch (error) {
      console.warn(`findFieldIdsByOptionValue: option lookup failed for ${field.id}:`, error?.message || error);
    }
  });

  const nextIndex = offset + batch.length;
  return {
    matchingIds,
    nextIndex,
    done: nextIndex >= selectFields.length,
    scanned: batch.length,
    totalCandidates: selectFields.length,
  };
}

// ----- Resolvers -----

async function getFieldInventory({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    await ensureProjectStoreReady();
    const filters = payload || {};
    const installationKey = getInstallationKey(context);
    const pageSize = Math.max(1, Math.min(50, Number(filters.pageSize) || INVENTORY_PAGE_SIZE));
    const requestedPage = Math.max(1, Number(filters.page) || 1);
    const sortBy = filters.sortBy || "name-asc";
    const query = filters.query || "";
    const optionQuery = String(filters.optionQuery || "").trim();
    const type = filters.type || "all";
    const findingsFilter = filters.findingsFilter || "all";
    const projectUsageFilter = filters.projectUsageFilter || "all";
    const minIssuesWithValue = filters.minIssuesWithValue ?? "";
    const maxIssuesWithValue = filters.maxIssuesWithValue ?? "";
    const fieldOrigin = String(filters.fieldOrigin || "all").trim() || "all";
    const minActiveProjects = filters.minActiveProjects ?? "";
    const maxActiveProjects = filters.maxActiveProjects ?? "";
    const minContexts = filters.minContexts ?? "";
    const maxContexts = filters.maxContexts ?? "";
    const duplicateNamesOnly = Boolean(filters.duplicateNamesOnly);
    const hasDescription = filters.hasDescription || "all";

    const [meta_initial, adminConfig] = await Promise.all([
      readSnapshotMeta(installationKey),
      readAdminConfig(),
    ]);
    let meta = meta_initial;

    const alreadyActive = meta?.state === "building" || meta?.state === "queued";
    const shouldQueue = Boolean(filters.forceRefresh && !alreadyActive && !adminConfig.readOnlyMode);

    if (filters.forceRefresh && meta?.state === "building") {
      meta = await requeueStaleSnapshotBuild(installationKey, meta);
    }

    if (filters.forceRefresh && meta?.state === "queued") {
      // Queue job never started — reset so forceRefresh can re-enqueue
      await writeSnapshotMeta(installationKey, {
        state: "idle",
        lastError: "Queue job did not start; reset by manual refresh.",
      });
      meta = await readSnapshotMeta(installationKey);
    }

    if (shouldQueue) {
      // Claim the queue slot with a unique token, then verify we won before actually pushing.
      // This prevents two concurrent getFieldInventory calls from both enqueuing a build.
      const queueToken = makeJobToken();
      await writeSnapshotMeta(installationKey, { state: "queued", jobToken: queueToken, lastError: null });
      const claimed = await readSnapshotMeta(installationKey);
      if (claimed?.jobToken === queueToken) {
        await queueSnapshotBuild(installationKey);
      }
      meta = claimed || meta;
    }

    const snapshotStatus = {
      state: meta?.state || "idle",
      refreshedAt: meta?.refreshedAt || null,
      startedAt: meta?.startedAt || null,
      completedAt: meta?.completedAt || null,
      itemCount: meta?.totalFields || 0,
      processedFields: meta?.processedFields || 0,
      lastError: meta?.lastError || null,
      progressLog: meta?.progressLog || [],
    };

    const buildTotal = meta?.totalFields || 0;
    const buildProcessed = meta?.processedFields || 0;
    const buildProgress = (meta?.state === "building" || meta?.state === "queued")
      ? {
          status: meta.state,
          startedAt: meta?.startedAt || null,
          totalFields: buildTotal,
          processedFields: buildProcessed,
          percent: buildTotal > 0 ? Math.round((buildProcessed / buildTotal) * 100) : 0,
          progressLog: meta?.progressLog || [],
        }
      : null;

    // No snapshot data at all yet — return empty while the first build runs
    if (!meta?.version) {
      return {
        refreshedAt: null,
        total: 0,
        page: 1,
        pageSize,
        totalPages: 1,
        availableTypes: [],
        fields: [],
        findingsSummary: null,
        snapshotStatus,
        buildProgress,
        readOnlyMode: adminConfig.readOnlyMode,
      };
    }

    // Load from last good version — works for "ready", "building" (shows stale), and "failed"
    const [snapshotFields, fieldSummaries, issueSumsMap] = await Promise.all([
      loadSnapshotFields(installationKey, meta.version),
      listFieldSummaries(installationKey, 5000).catch(() => []),
      loadSnapshotFieldIssueSums(installationKey, meta.version).catch(() => new Map()),
    ]);
    const summaryByFieldId = new Map(fieldSummaries.map((summary) => [summary.fieldId, summary]));
    const duplicateNameCounts = buildDuplicateNameCountMap(snapshotFields);
    const allFields = snapshotFields.map((field) => {
      const summary = summaryByFieldId.get(field.id);
      const derivedIssueCount = summary?.totalIssueCount || field.totalIssueCount || issueSumsMap.get(field.id) || 0;
      if (!summary) {
        return hydrateFieldForGovernance({
          ...field,
          totalIssueCount: derivedIssueCount,
          projectUsageBuilt: derivedIssueCount <= 0,
          projectUsageState: derivedIssueCount <= 0 ? "not-needed" : "unbuilt",
        }, null, duplicateNameCounts.get(normalizeFieldName(field.name)) ?? 1, adminConfig.governanceThresholds);
      }
      const inferredBuilt = summary.summaryStatus === "ready";
      return hydrateFieldForGovernance({
        ...field,
        activeProjectCount: summary.activeProjectCount ?? field.activeProjectCount,
        totalIssueCount: derivedIssueCount,
        projectUsageBuilt: inferredBuilt,
        projectUsageState: summary.summaryStatus || (inferredBuilt ? "ready" : "unbuilt"),
      }, summary, duplicateNameCounts.get(normalizeFieldName(field.name)) ?? 1, adminConfig.governanceThresholds);
    });

    const optionMatches = optionQuery ? await searchFieldOptionsCache(installationKey, optionQuery, 5000) : null;
    const optionMatchedFieldIds = optionMatches ? new Set(optionMatches.map((match) => match.fieldId)) : null;
    const optionFilteredFields = optionMatchedFieldIds
      ? allFields.filter((field) => optionMatchedFieldIds.has(field.id))
      : allFields;
    const filteredFields = sortInventoryFields(
      applyFindingsFilter(
        filterInventoryFields(optionFilteredFields, query, type, projectUsageFilter, maxIssuesWithValue, fieldOrigin, minIssuesWithValue, {
          minActiveProjects, maxActiveProjects, minContexts, maxContexts, duplicateNamesOnly, hasDescription,
        }),
        findingsFilter
      ),
      sortBy
    );

    const total = filteredFields.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const startIndex = (page - 1) * pageSize;
    const availableTypes = Array.from(new Set(allFields.map((f) => f.type))).filter(Boolean).sort();

    return {
      refreshedAt: meta.refreshedAt,
      total,
      page,
      pageSize,
      totalPages,
      availableTypes,
      fields: filteredFields.slice(startIndex, startIndex + pageSize),
      findingsSummary: summarizeFindings(filteredFields),
      snapshotStatus,
      buildProgress,
      readOnlyMode: adminConfig.readOnlyMode,
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    if (jobType === "build-field-summary" || jobType === "refresh-field-project-delta") {
      const fieldId = String(event?.body?.fieldId || "");
      if (fieldId) {
        const existing = await loadFieldSummary(installationKey, fieldId).catch(() => null);
        if (existing) {
          await replaceFieldSummary(installationKey, fieldId, {
            ...existing,
            summaryStatus: "failed",
            completedAt: new Date().toISOString(),
            lastError: error?.message || String(error),
            progressLog: [
              ...(existing.progressLog || []),
              { t: new Date().toISOString(), msg: `Job failed: ${error?.message || String(error)}` },
            ],
          }).catch(() => {});
        }
      }
    }
    if (jobType === "build-field-summary") {
      const fieldId = String(event?.body?.fieldId || "");
      if (fieldId) {
        const existing = await loadFieldSummary(installationKey, fieldId).catch(() => null);
        await replaceFieldSummary(installationKey, fieldId, {
          refreshedAt: existing?.refreshedAt || new Date().toISOString(),
          field: existing?.field || null,
          fieldJql: existing?.fieldJql || null,
          configuredProjectCount: existing?.configuredProjectCount ?? 0,
          hasGlobalContext: existing?.hasGlobalContext || false,
          activeProjectCount: existing?.activeProjectCount ?? 0,
          totalIssueCount: existing?.totalIssueCount ?? 0,
          activeProjects: existing?.activeProjects || [],
          contexts: existing?.contexts || [],
          findings: existing?.findings || null,
          summaryStatus: "failed",
          startedAt: existing?.startedAt || new Date().toISOString(),
          completedAt: new Date().toISOString(),
          lastError: error?.message || String(error),
          progressLog: [
            ...(existing?.progressLog || []),
            { t: new Date().toISOString(), msg: `Job failed: ${error?.message || String(error)}` },
          ],
        }).catch(() => {});
      }
    }
    console.error("getFieldInventory failed:", error);
    throw error;
  }
}

async function getFieldDetails({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    await ensureProjectStoreReady();
    const fieldId = payload?.fieldId;
    if (!fieldId) throw new Error("fieldId is required");
    const usagePage = Math.max(1, Number(payload?.usagePage) || 1);
    const usagePageSize = Math.max(1, Math.min(25, Number(payload?.usagePageSize) || PROJECT_USAGE_PAGE_SIZE));
    const installationKey = getInstallationKey(context);

    const meta = await readSnapshotMeta(installationKey);
    if (!meta?.version) throw new Error("No completed snapshot available — build one first.");

    const offset = (usagePage - 1) * usagePageSize;
    const [snapshotField, projectUsageRows, projectCount, rawFieldSummary, projectUsageIssueSum] = await Promise.all([
      loadSnapshotField(installationKey, meta.version, fieldId),
      loadSnapshotProjectUsage(installationKey, meta.version, fieldId, usagePageSize, offset),
      countSnapshotProjectUsage(installationKey, meta.version, fieldId),
      loadFieldSummary(installationKey, fieldId),
      sumSnapshotFieldIssueCount(installationKey, meta.version, fieldId),
    ]);

    if (!snapshotField) throw new Error(`Field not found in snapshot: ${fieldId}`);
    const fieldSummary = await ensureFieldSummaryJobRunning(
      installationKey,
      meta.version,
      fieldId,
      rawFieldSummary,
      snapshotField
    );

    let finalProjectRows = projectUsageRows;
    let finalProjectCount = projectCount;
    let finalContexts = fieldSummary?.contexts || [];
    let summaryStatus = fieldSummary?.summaryStatus || "ready";
    const hasBrokenReadySummary = Boolean(
      fieldSummary &&
      fieldSummary.summaryStatus === "ready" &&
      (fieldSummary.activeProjectCount > 0 || snapshotField.activeProjectCount > 0) &&
      (!Array.isArray(fieldSummary.activeProjects) || fieldSummary.activeProjects.length === 0) &&
      projectCount === 0
    );

    if (fieldSummary && !hasBrokenReadySummary) {
      if (projectCount === 0 && Array.isArray(fieldSummary.activeProjects) && fieldSummary.activeProjects.length > 0) {
        finalProjectCount = fieldSummary.activeProjectCount || fieldSummary.activeProjects.length;
        finalProjectRows = fieldSummary.activeProjects
          .slice(offset, offset + usagePageSize)
          .map((project) => ({
            projectId: project.projectId,
            projectKey: project.projectKey,
            projectName: project.projectName,
            issueCount: project.issueCount,
            jql: project.jql,
          }));
      } else if (fieldSummary.activeProjectCount > 0) {
        finalProjectCount = fieldSummary.activeProjectCount;
      }
    }

    if (hasBrokenReadySummary) {
      summaryStatus = "failed";
    } else if (!fieldSummary && !finalProjectRows.length && projectCount === 0 && snapshotField.totalIssueCount > 0) {
      summaryStatus = "idle";
    }

    if (!finalContexts.length) {
      try {
        finalContexts = await loadFieldContexts(fieldId);
        if (fieldSummary) {
          await replaceFieldSummary(installationKey, fieldId, {
            ...fieldSummary,
            refreshedAt: new Date().toISOString(),
            contexts: finalContexts,
          });
        }
      } catch (contextError) {
        console.warn(`getFieldDetails: context load failed for ${fieldId}: ${contextError?.message || contextError}`);
      }
    }

    const duplicateNameCounts = buildDuplicateNameCountMap(
      await loadSnapshotFields(installationKey, meta.version)
    );
    const hydratedField = hydrateFieldForGovernance({
      ...snapshotField,
      activeProjectCount: finalProjectCount,
      totalIssueCount: fieldSummary?.totalIssueCount || snapshotField.totalIssueCount || projectUsageIssueSum || 0,
    }, fieldSummary, duplicateNameCounts.get(normalizeFieldName(snapshotField.name)) ?? 1);

    const projectUsage = finalProjectRows.map((row) => ({
      projectId: row.projectId,
      projectKey: row.projectKey,
      projectName: row.projectName,
      issueCount: row.issueCount,
      jql: row.jql || buildFieldJql(fieldId, row.projectKey),
      latestFieldChangeAt: null,
      latestIssueKey: null,
      latestIssueUpdatedAt: null,
    }));

    return {
      refreshedAt: meta.refreshedAt,
      field: {
        ...hydratedField,
        numericId: getFieldNumericId(snapshotField.id),
      },
      fieldJql: snapshotField.fieldJql || buildOverallFieldJql(fieldId),
      activeProjectCount: finalProjectCount,
      totalIssueCount: hydratedField.totalIssueCount,
      findings: hydratedField.findings || null,
      contexts: finalContexts,
      projects: projectUsage,
      projectUsagePage: usagePage,
      projectUsagePageSize: usagePageSize,
      projectUsageTotalProjects: finalProjectCount,
      projectUsageTotalPages: Math.max(1, Math.ceil(finalProjectCount / usagePageSize)),
      summaryStatus,
      processedIssueCount: fieldSummary?.processedIssueCount || 0,
      estimatedIssueTotal: fieldSummary?.estimatedIssueTotal || snapshotField.totalIssueCount || 0,
      progressLog: fieldSummary?.progressLog || [],
      startedAt: fieldSummary?.startedAt || null,
      completedAt: fieldSummary?.completedAt || null,
      lastError: fieldSummary?.lastError || null,
    };
  } catch (error) {
    console.error("getFieldDetails failed:", error);
    throw error;
  }
}

async function cancelSnapshot({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  // Hard-stop: null out buildingVersion so every running build's version-check fails,
  // regardless of how many are active or what state they think they're in.
  await writeSnapshotMeta(installationKey, {
    state: "cancelled",
    buildingVersion: null,
    lastError: null,
  });
  return { cancelled: true };
}

async function getProjectUsageJobs({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const jobs = await listFieldSummaries(installationKey, 200);

  return {
    jobs: jobs.map((job, index) => ({
      fieldId: job.fieldId || jobs[index]?.fieldId,
      fieldName: job.field?.name || job.fieldId,
      fieldType: job.field?.type || "unknown",
      summaryStatus: job.summaryStatus,
      configuredProjectCount: job.configuredProjectCount,
      activeProjectCount: job.activeProjectCount,
      totalIssueCount: job.totalIssueCount,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      refreshedAt: job.refreshedAt,
      lastError: job.lastError,
      progressLog: job.progressLog || [],
      processedIssueCount: job.processedIssueCount || 0,
      estimatedIssueTotal: job.estimatedIssueTotal || 0,
      nextStartAt: job.nextStartAt || 0,
      percentComplete: job.estimatedIssueTotal > 0
        ? Math.min(100, Math.round(((job.processedIssueCount || 0) / job.estimatedIssueTotal) * 100))
        : (job.summaryStatus === "ready" ? 100 : 0),
    })),
  };
}

async function refreshRecentProjectUsage({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    throw new Error("No completed snapshot available — build one first.");
  }

  const hours = Math.max(1, Math.min(168, Math.trunc(Number(payload?.hours)) || 24));
  const maxIssues = Math.max(50, Math.min(2000, Math.trunc(Number(payload?.maxIssues)) || 500));
  const recent = await collectRecentFieldProjectCandidates(hours, maxIssues);
  const allSummaries = await listFieldSummaries(installationKey, 5000).catch(() => []);
  const summaryByFieldId = new Map(allSummaries.map((summary) => [summary.fieldId, summary]));

  let queuedCount = 0;
  let fullRebuildCount = 0;
  for (const candidate of recent.fields) {
    const fieldId = String(candidate.fieldId || "").trim();
    if (!fieldId) continue;

    const snapshotField = await loadSnapshotField(installationKey, meta.version, fieldId).catch(() => null);
    if (!snapshotField) continue;

    const summary = summaryByFieldId.get(fieldId) || null;
    if (!summary || summary.summaryStatus !== "ready") {
      const queued = await ensureProjectUsageJobQueued(installationKey, meta.version, snapshotField, summary);
      if (queued.queued) {
        queuedCount++;
        fullRebuildCount++;
      }
      continue;
    }

    const jobToken = makeJobToken();
    await replaceFieldSummary(installationKey, fieldId, {
      ...summary,
      refreshedAt: new Date().toISOString(),
      field: summary.field || snapshotField,
      fieldJql: summary.fieldJql || snapshotField.fieldJql || buildOverallFieldJql(fieldId),
      summaryStatus: "queued",
      completedAt: null,
      lastError: null,
      progressLog: [
        ...(summary.progressLog || []).slice(-80),
        {
          t: new Date().toISOString(),
          msg: `Queued incremental project-usage refresh from issues updated in the last ${hours}h`,
        },
      ].slice(-100),
      jobToken,
    });

    const queueResult = await queueFieldUsageDeltaRefreshWithRetry(
      installationKey,
      meta.version,
      fieldId,
      jobToken,
      candidate.projectKeys,
      hours
    );

    if (!queueResult.queued) {
      await replaceFieldSummary(installationKey, fieldId, {
        ...summary,
        refreshedAt: new Date().toISOString(),
        field: summary.field || snapshotField,
        fieldJql: summary.fieldJql || snapshotField.fieldJql || buildOverallFieldJql(fieldId),
        summaryStatus: "deferred",
        completedAt: summary.completedAt || null,
        lastError: null,
        progressLog: [
          ...(summary.progressLog || []).slice(-80),
          {
            t: new Date().toISOString(),
            msg: `Deferred incremental refresh after ${queueResult.attempts || 1} queue attempts`,
          },
        ].slice(-100),
        jobToken,
      });
      continue;
    }

    queuedCount++;
  }

  return {
    queuedCount,
    fullRebuildCount,
    scannedIssues: recent.scannedIssues,
    changedFieldCount: recent.fields.length,
    windowHours: hours,
  };
}

async function cancelProjectUsageJob({ payload, context }) {
  await ensureProjectStoreReady();
  const fieldId = String(payload?.fieldId || "").trim();
  if (!fieldId) throw new Error("fieldId is required");

  const installationKey = getInstallationKey(context);
  const existing = await loadFieldSummary(installationKey, fieldId);
  if (!existing) {
    return { cancelled: false, reason: "not-found" };
  }

  await replaceFieldSummary(installationKey, fieldId, {
    ...existing,
    summaryStatus: "cancelled",
    completedAt: new Date().toISOString(),
    progressLog: [
      ...(existing.progressLog || []),
      { t: new Date().toISOString(), msg: "Job cancelled by user" },
    ],
  });

  return { cancelled: true };
}

async function restartProjectUsageJob({ payload, context }) {
  await ensureProjectStoreReady();
  const fieldId = String(payload?.fieldId || "").trim();
  if (!fieldId) throw new Error("fieldId is required");

  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    throw new Error("No completed snapshot available — build one first.");
  }

  const snapshotField = await loadSnapshotField(installationKey, meta.version, fieldId);
  if (!snapshotField) {
    throw new Error(`Field not found in snapshot: ${fieldId}`);
  }

  const jobToken = makeJobToken();
  await replaceSnapshotProjectUsageForField(installationKey, meta.version, fieldId, []);
  await replaceFieldSummary(installationKey, fieldId, {
    refreshedAt: new Date().toISOString(),
    field: snapshotField,
    fieldJql: snapshotField.fieldJql || buildOverallFieldJql(fieldId),
    configuredProjectCount: snapshotField.configuredProjectCount ?? snapshotField.usageCount ?? 0,
    hasGlobalContext: false,
    activeProjectCount: 0,
    totalIssueCount: snapshotField.totalIssueCount ?? 0,
    activeProjects: [],
    contexts: [],
    findings: snapshotField.findings || null,
    summaryStatus: "queued",
    startedAt: null,
    completedAt: null,
    lastError: null,
    progressLog: [{ t: new Date().toISOString(), msg: "Queued fresh project-usage background job" }],
    jobToken,
    processedIssueCount: 0,
    estimatedIssueTotal: snapshotField.totalIssueCount ?? 0,
    nextStartAt: 0,
    nextPageToken: null,
  });
  await processFieldSummaryChunk(
    installationKey,
    meta.version,
    snapshotField,
    jobToken,
    0,
    null,
    1
  );

  return { queued: true, fieldId };
}

async function resumeProjectUsageJob({ payload, context }) {
  await ensureProjectStoreReady();
  const fieldId = String(payload?.fieldId || "").trim();
  if (!fieldId) throw new Error("fieldId is required");

  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    throw new Error("No completed snapshot available — build one first.");
  }

  const [snapshotField, existing] = await Promise.all([
    loadSnapshotField(installationKey, meta.version, fieldId),
    loadFieldSummary(installationKey, fieldId),
  ]);
  if (!snapshotField) {
    throw new Error(`Field not found in snapshot: ${fieldId}`);
  }
  if (!existing) {
    throw new Error(`No existing project-usage job state found for ${fieldId}`);
  }
  if (existing.summaryStatus === "queued" || existing.summaryStatus === "building") {
    return { queued: false, fieldId, reason: "already-running" };
  }

  const jobToken = makeJobToken();
  const resumedSummary = {
    ...existing,
    refreshedAt: new Date().toISOString(),
    field: snapshotField,
    fieldJql: existing.fieldJql || snapshotField.fieldJql || buildOverallFieldJql(fieldId),
    configuredProjectCount: existing.configuredProjectCount ?? snapshotField.configuredProjectCount ?? snapshotField.usageCount ?? 0,
    totalIssueCount: Math.max(existing.totalIssueCount ?? 0, snapshotField.totalIssueCount ?? 0),
    findings: existing.findings || snapshotField.findings || null,
    summaryStatus: "queued",
    completedAt: null,
    lastError: null,
    progressLog: [
      ...(existing.progressLog || []).slice(-80),
      {
        t: new Date().toISOString(),
        msg: `Resuming project-usage build from ${Number(existing.processedIssueCount || 0).toLocaleString()} scanned issues`,
      },
    ].slice(-100),
    jobToken,
  };

  await replaceFieldSummary(installationKey, fieldId, resumedSummary);
  await processFieldSummaryChunk(
    installationKey,
    meta.version,
    snapshotField,
    jobToken,
    Number(existing.processedIssueCount || existing.nextStartAt || 0),
    existing.nextPageToken || null,
    1
  );

  return {
    queued: true,
    fieldId,
    resumedFrom: Number(existing.processedIssueCount || 0),
  };
}

async function ensureProjectUsageJobQueued(installationKey, version, snapshotField, existingSummary = null) {
  if (!snapshotField?.id) {
    return { queued: false, reason: "missing-field" };
  }

  if (Number(snapshotField.totalIssueCount || 0) <= 0) {
    return { queued: false, reason: "no-issues" };
  }

  const fieldId = snapshotField.id;
  const summary = existingSummary || await loadFieldSummary(installationKey, fieldId).catch(() => null);
  if (summary?.summaryStatus === "queued" || summary?.summaryStatus === "building") {
    return { queued: false, reason: "already-running" };
  }

  const jobToken = makeJobToken();
  await replaceSnapshotProjectUsageForField(installationKey, version, fieldId, []);
  await replaceFieldSummary(installationKey, fieldId, {
    refreshedAt: new Date().toISOString(),
    field: snapshotField,
    fieldJql: snapshotField.fieldJql || buildOverallFieldJql(fieldId),
    configuredProjectCount: snapshotField.configuredProjectCount ?? snapshotField.usageCount ?? 0,
    hasGlobalContext: false,
    activeProjectCount: 0,
    totalIssueCount: snapshotField.totalIssueCount ?? 0,
    activeProjects: [],
    contexts: summary?.contexts || [],
    findings: snapshotField.findings || null,
    summaryStatus: "queued",
    startedAt: null,
    completedAt: null,
    lastError: null,
    progressLog: [
      ...(summary?.progressLog || []).slice(-40),
      { t: new Date().toISOString(), msg: "Queued project-usage build for report generation" },
    ],
    jobToken,
    processedIssueCount: 0,
    estimatedIssueTotal: snapshotField.totalIssueCount ?? 0,
    nextStartAt: 0,
    nextPageToken: null,
  });
  const queueResult = await queueFieldSummaryContinuationWithRetry(
    installationKey,
    version,
    fieldId,
    jobToken,
    0,
    ""
  );
  if (!queueResult.queued) {
    await replaceFieldSummary(installationKey, fieldId, {
      refreshedAt: new Date().toISOString(),
      field: snapshotField,
      fieldJql: snapshotField.fieldJql || buildOverallFieldJql(fieldId),
      configuredProjectCount: snapshotField.configuredProjectCount ?? snapshotField.usageCount ?? 0,
      hasGlobalContext: false,
      activeProjectCount: 0,
      totalIssueCount: snapshotField.totalIssueCount ?? 0,
      activeProjects: [],
      contexts: summary?.contexts || [],
      findings: snapshotField.findings || null,
      summaryStatus: "deferred",
      startedAt: null,
      completedAt: null,
      lastError: null,
      progressLog: [
        ...(summary?.progressLog || []).slice(-40),
        {
          t: new Date().toISOString(),
          msg: `Queue backpressure hit while starting project-usage build after ${queueResult.attempts || 1} queue attempt${(queueResult.attempts || 1) === 1 ? "" : "s"}; job deferred`,
        },
      ],
      jobToken,
      processedIssueCount: 0,
      estimatedIssueTotal: snapshotField.totalIssueCount ?? 0,
      nextStartAt: 0,
      nextPageToken: null,
    });
    return { queued: false, reason: "queue-backpressure" };
  }
  return { queued: true, reason: "queued" };
}

async function ensureDeferredProjectUsageJobRecorded(installationKey, snapshotField, existingSummary = null, reason = "deferred") {
  if (!snapshotField?.id) {
    return;
  }

  const fieldId = snapshotField.id;
  const summary = existingSummary || await loadFieldSummary(installationKey, fieldId).catch(() => null);
  if (summary?.summaryStatus === "queued" || summary?.summaryStatus === "building" || summary?.summaryStatus === "ready") {
    return;
  }

  const reasonMessages = {
    "deferred-active-job-cap": "Deferred project-usage build because the active job cap has been reached",
    "deferred-field-cap": "Deferred project-usage build because the per-report field queue cap has been reached",
    "deferred-issue-budget": "Deferred project-usage build because the report issue budget has been reached",
    "queue-backpressure": "Deferred project-usage build because the Forge queue is under backpressure",
  };

  await replaceFieldSummary(installationKey, fieldId, {
    refreshedAt: new Date().toISOString(),
    field: snapshotField,
    fieldJql: snapshotField.fieldJql || buildOverallFieldJql(fieldId),
    configuredProjectCount: snapshotField.configuredProjectCount ?? snapshotField.usageCount ?? 0,
    hasGlobalContext: false,
    activeProjectCount: summary?.activeProjectCount ?? 0,
    totalIssueCount: snapshotField.totalIssueCount ?? summary?.totalIssueCount ?? 0,
    activeProjects: summary?.activeProjects || [],
    contexts: summary?.contexts || [],
    findings: summary?.findings || snapshotField.findings || null,
    summaryStatus: "deferred",
    startedAt: summary?.startedAt || null,
    completedAt: summary?.completedAt || null,
    lastError: null,
    progressLog: [
      ...(summary?.progressLog || []).slice(-40),
      { t: new Date().toISOString(), msg: reasonMessages[reason] || "Deferred project-usage build for later execution" },
    ].slice(-100),
    jobToken: summary?.jobToken || makeJobToken(),
    processedIssueCount: Number(summary?.processedIssueCount || 0),
    estimatedIssueTotal: snapshotField.totalIssueCount ?? summary?.estimatedIssueTotal ?? 0,
    nextStartAt: Number(summary?.nextStartAt || summary?.processedIssueCount || 0),
    nextPageToken: summary?.nextPageToken || null,
  });
}

async function getSavedReports({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const reports = await listSavedReports(installationKey);
  return { reports };
}

async function saveReportDefinition({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const name = String(payload?.name || "").trim();
  const fieldIds = Array.from(new Set((payload?.fieldIds || []).map((value) => String(value || "").trim()).filter(Boolean)));
  const reportId = String(payload?.reportId || "").trim() || makeJobToken();

  if (!name) throw new Error("Report name is required.");
  if (!fieldIds.length) throw new Error("Select at least one field to save a report.");

  const existingReports = await listSavedReports(installationKey);
  const existing = existingReports.find((report) => report.reportId === reportId);
  await saveSavedReport(installationKey, {
    reportId,
    name,
    fieldIds,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  return getSavedReports({ context });
}

async function deleteReportDefinition({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const reportId = String(payload?.reportId || "").trim();
  if (!reportId) throw new Error("reportId is required");

  await deleteSavedReport(installationKey, reportId);
  return getSavedReports({ context });
}

async function getProjectUsageReport({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const fieldIds = Array.from(new Set((payload?.fieldIds || []).map((value) => String(value || "").trim()).filter(Boolean)));
  if (!fieldIds.length) {
    return { fields: [], projects: [] };
  }

  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    throw new Error("No completed snapshot available — build one first.");
  }

  const pendingFields = [];
  const allSummaries = await listFieldSummaries(installationKey, 5000).catch(() => []);
  const summaryByFieldId = new Map(allSummaries.map((summary) => [summary.fieldId, summary]));
  const queueCandidates = [];
  const rows = await Promise.all(fieldIds.map(async (fieldId) => {
    const [field, projectUsage, fieldSummary] = await Promise.all([
      loadSnapshotField(installationKey, meta.version, fieldId),
      loadAllSnapshotProjectUsage(installationKey, meta.version, fieldId),
      loadFieldSummary(installationKey, fieldId).catch(() => summaryByFieldId.get(fieldId) || null),
    ]);
    if (!field) {
      return null;
    }

    // Fallback chain when current-version snapshot_project_usage is empty:
    // 1. Any-version snapshot data (handles post-migration version mismatch)
    // 2. field_summaries.activeProjects (populated by Field Usage Jobs)
    let finalProjects = projectUsage;
    if (!finalProjects.length) {
      finalProjects = await loadAnySnapshotProjectUsage(installationKey, fieldId).catch(() => []);
    }
    if (!finalProjects.length) {
      finalProjects = (fieldSummary?.activeProjects || []).map((p) => ({
        projectId: p.projectId,
        projectKey: p.projectKey,
        projectName: p.projectName,
        issueCount: p.issueCount || 0,
        jql: p.jql || buildFieldJql(fieldId, p.projectKey),
        latestFieldChangeAt: null,
        latestIssueKey: null,
        latestIssueUpdatedAt: null,
      }));
    }

    const derivedTotalIssueCount = field.totalIssueCount
      || fieldSummary?.totalIssueCount
      || finalProjects.reduce((s, p) => s + (p.issueCount || 0), 0)
      || 0;

    if (!finalProjects.length && derivedTotalIssueCount > 0) {
      if (fieldSummary?.summaryStatus === "queued" || fieldSummary?.summaryStatus === "building") {
        pendingFields.push({
          fieldId: field.id,
          fieldName: field.name,
          summaryStatus: fieldSummary.summaryStatus,
          reason: "already-running",
        });
      } else {
        queueCandidates.push({
          field,
          fieldSummary,
          issueCount: derivedTotalIssueCount,
        });
      }
    }

    return {
      fieldId: field.id,
      fieldName: field.name,
      fieldType: field.type,
      totalIssueCount: derivedTotalIssueCount,
      activeProjectCount: field.activeProjectCount || finalProjects.length || 0,
      fieldJql: field.fieldJql || buildOverallFieldJql(field.id),
      projects: finalProjects,
    };
  }));

  const queueCapacity = summarizeProjectUsageCapacity(allSummaries);
  let runningJobCount = queueCapacity.runningJobCount;
  let runningIssueBudget = queueCapacity.runningIssueBudget;
  let newlyQueuedFieldCount = 0;
  let newlyQueuedIssueBudget = 0;
  const sortedCandidates = queueCandidates.sort((left, right) =>
    left.issueCount - right.issueCount || left.field.name.localeCompare(right.field.name)
  );

  for (const candidate of sortedCandidates) {
    const candidateIssueCount = candidate.issueCount;
    let reason = null;

    if (runningJobCount >= MAX_ACTIVE_PROJECT_USAGE_JOBS) {
      reason = "deferred-active-job-cap";
    } else if (newlyQueuedFieldCount >= MAX_AUTOQUEUED_REPORT_FIELDS) {
      reason = "deferred-field-cap";
    } else if (
      (runningIssueBudget + newlyQueuedIssueBudget + candidateIssueCount) > MAX_AUTOQUEUED_REPORT_ISSUE_BUDGET
      && (newlyQueuedFieldCount > 0 || runningJobCount > 0)
    ) {
      reason = "deferred-issue-budget";
    }

    if (reason) {
      await ensureDeferredProjectUsageJobRecorded(
        installationKey,
        candidate.field,
        candidate.fieldSummary,
        reason
      );
      pendingFields.push({
        fieldId: candidate.field.id,
        fieldName: candidate.field.name,
        summaryStatus: "deferred",
        reason,
      });
      continue;
    }

    const queued = await ensureProjectUsageJobQueued(
      installationKey,
      meta.version,
      candidate.field,
      candidate.fieldSummary
    );

    if (queued.queued) {
      pendingFields.push({
        fieldId: candidate.field.id,
        fieldName: candidate.field.name,
        summaryStatus: "queued",
        reason: "project-usage-missing",
      });
      runningJobCount++;
      runningIssueBudget += candidateIssueCount;
      newlyQueuedFieldCount++;
      newlyQueuedIssueBudget += candidateIssueCount;
      continue;
    }

    pendingFields.push({
      fieldId: candidate.field.id,
      fieldName: candidate.field.name,
      summaryStatus: queued.reason === "already-running" ? "queued" : "deferred",
      reason: queued.reason || "project-usage-missing",
    });
  }

  const fields = rows.filter(Boolean);
  const projectMap = new Map();
  for (const field of fields) {
    for (const project of field.projects) {
      if (!projectMap.has(project.projectId)) {
        projectMap.set(project.projectId, {
          projectId: project.projectId,
          projectKey: project.projectKey,
          projectName: project.projectName,
        });
      }
    }
  }

  const projects = Array.from(projectMap.values()).sort(
    (left, right) => left.projectKey.localeCompare(right.projectKey) || left.projectName.localeCompare(right.projectName)
  );

  const uniqueIssueCount = await getDistinctIssueCountForFields(fields.map((field) => field.fieldId));

  return { fields, projects, pendingFields, uniqueIssueCount };
}

async function buildProjectUsageReportResult(installationKey, version, fieldIds, offset = 0, partialResult = null) {
  const fields = Array.isArray(partialResult?.fields) ? [...partialResult.fields] : [];
  const projectMap = new Map(
    Array.isArray(partialResult?.projects)
      ? partialResult.projects.map((project) => [project.projectId, project])
      : []
  );
  const pendingFields = Array.isArray(partialResult?.pendingFields) ? [...partialResult.pendingFields] : [];

  const batchFieldIds = fieldIds.slice(offset, offset + REPORT_JOB_FIELD_BATCH_SIZE);
  for (const fieldId of batchFieldIds) {
    const [field, projectUsage] = await Promise.all([
      loadSnapshotField(installationKey, version, fieldId),
      loadAllSnapshotProjectUsage(installationKey, version, fieldId),
    ]);
    if (!field) {
      continue;
    }

    if (!projectUsage.length && Number(field.totalIssueCount || 0) > 0) {
      pendingFields.push({
        fieldId: field.id,
        fieldName: field.name,
        summaryStatus: "missing",
        reason: "project-usage-missing",
      });
    }

    fields.push({
      fieldId: field.id,
      fieldName: field.name,
      fieldType: field.type,
      totalIssueCount: field.totalIssueCount ?? 0,
      activeProjectCount: field.activeProjectCount ?? 0,
      fieldJql: field.fieldJql || buildOverallFieldJql(field.id),
      projects: projectUsage,
    });

    for (const project of projectUsage) {
      if (!projectMap.has(project.projectId)) {
        projectMap.set(project.projectId, {
          projectId: project.projectId,
          projectKey: project.projectKey,
          projectName: project.projectName,
        });
      }
    }
  }

  const nextOffset = offset + batchFieldIds.length;
  const isComplete = nextOffset >= fieldIds.length;

  return {
    result: {
      fields,
      projects: Array.from(projectMap.values()).sort(
        (left, right) => left.projectKey.localeCompare(right.projectKey) || left.projectName.localeCompare(right.projectName)
      ),
      pendingFields,
      uniqueIssueCount: partialResult?.uniqueIssueCount ?? null,
    },
    processedFields: nextOffset,
    nextOffset,
    isComplete,
  };
}

async function processProjectUsageReportJob(scopeKey, version, jobId) {
  const existing = await loadReportJob(scopeKey, jobId);
  if (!existing || existing.status === "cancelled" || existing.status === "ready") {
    return;
  }

  const progressLog = [...(existing.progressLog || [])];
  const addLog = (msg) => {
    progressLog.push({ t: new Date().toISOString(), msg });
    if (progressLog.length > 100) progressLog.shift();
  };

  if (existing.status === "queued") {
    incrMetric(METRIC_NAMES.reportJobStarted);
    addLog(`Started report build for ${existing.reportName}`);
  }

  addLog(`Processing fields ${existing.nextOffset + 1}-${Math.min(existing.totalFields, existing.nextOffset + REPORT_JOB_FIELD_BATCH_SIZE)} of ${existing.totalFields}`);

  const next = await buildProjectUsageReportResult(
    scopeKey,
    version,
    existing.fieldIds,
    Number(existing.nextOffset || 0),
    existing.result || null
  );

  if (next.isComplete) {
    const uniqueIssueCount = await getDistinctIssueCountForFields(next.result.fields.map((field) => field.fieldId));
    next.result.uniqueIssueCount = uniqueIssueCount;
    addLog(`Completed report build for ${existing.reportName}`);
    await replaceReportJob(scopeKey, jobId, {
      ...existing,
      status: "ready",
      processedFields: next.processedFields,
      nextOffset: next.nextOffset,
      completedAt: new Date().toISOString(),
      refreshedAt: new Date().toISOString(),
      progressLog,
      result: next.result,
      lastError: null,
    });
    incrMetric(METRIC_NAMES.reportJobCompleted);
    return;
  }

  await replaceReportJob(scopeKey, jobId, {
    ...existing,
    status: "building",
    startedAt: existing.startedAt || new Date().toISOString(),
    processedFields: next.processedFields,
    nextOffset: next.nextOffset,
    refreshedAt: new Date().toISOString(),
    progressLog,
    result: next.result,
    lastError: null,
  });

  await queueReportBuild(scopeKey, version, jobId);
}

async function startProjectUsageReportJob({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const fieldIds = Array.from(new Set((payload?.fieldIds || []).map((value) => String(value || "").trim()).filter(Boolean)));
  if (!fieldIds.length) {
    throw new Error("Select at least one field for the report.");
  }

  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    throw new Error("No completed snapshot available — build one first.");
  }

  const jobId = makeJobToken();
  const reportName = String(payload?.reportName || "").trim() || "Project Usage Report";
  await replaceReportJob(installationKey, jobId, {
    reportName,
    status: "queued",
    fieldIds,
    processedFields: 0,
    totalFields: fieldIds.length,
    nextOffset: 0,
    startedAt: null,
    completedAt: null,
    refreshedAt: new Date().toISOString(),
    lastError: null,
    progressLog: [{ t: new Date().toISOString(), msg: `Queued report build for ${fieldIds.length.toLocaleString()} fields` }],
    result: { fields: [], projects: [], pendingFields: [], uniqueIssueCount: null },
  });
  await queueReportBuild(installationKey, meta.version, jobId);
  return { jobId };
}

async function getProjectUsageReportJob({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const jobId = String(payload?.jobId || "").trim();
  if (!jobId) {
    return { job: null };
  }
  const job = await loadReportJob(installationKey, jobId);
  if (!job) {
    return { job: null };
  }
  return {
    job: {
      ...job,
      percentComplete: job.totalFields > 0 ? Math.min(100, Math.round((job.processedFields / job.totalFields) * 100)) : 0,
    },
  };
}

async function getProjectsView({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    return {
      projects: [],
      availableTypes: [],
      selectedProject: null,
      fields: [],
      totalFields: 0,
      page: 1,
      totalPages: 1,
      pageSize: PROJECTS_VIEW_PAGE_SIZE,
      refreshedAt: null,
    };
  }

  const projectQuery = String(payload?.projectQuery || "").trim();
  const fieldQuery = String(payload?.fieldQuery || "").trim();
  const fieldType = String(payload?.fieldType || "all").trim() || "all";
  const sortBy = String(payload?.sortBy || "issues-desc").trim() || "issues-desc";
  const requestedPage = Math.max(1, Math.trunc(Number(payload?.page)) || 1);

  const [projects, issueScanMeta] = await Promise.all([
    listSnapshotProjects(installationKey, meta.version, projectQuery),
    readIssueScanMeta(installationKey).catch(() => null),
  ]);
  const selectedProjectId = String(payload?.projectId || "").trim() || projects[0]?.projectId || "";
  const selectedProject = projects.find((project) => project.projectId === selectedProjectId) || projects[0] || null;

  if (!selectedProject) {
    return {
      projects: [],
      availableTypes: [],
      selectedProject: null,
      fields: [],
      totalFields: 0,
      page: 1,
      totalPages: 1,
      pageSize: PROJECTS_VIEW_PAGE_SIZE,
      refreshedAt: meta.refreshedAt || null,
      issueScan: issueScanMeta ? {
        state: issueScanMeta.state,
        completedAt: issueScanMeta.completedAt,
        totalIssues: issueScanMeta.totalIssues,
        processedIssues: issueScanMeta.processedIssues,
        totalPages: issueScanMeta.totalPages,
        processedPages: issueScanMeta.processedPages,
        lastError: issueScanMeta.lastError,
      } : null,
    };
  }

  const offset = (requestedPage - 1) * PROJECTS_VIEW_PAGE_SIZE;
  const projectFieldsResult = await loadSnapshotProjectFields(
    installationKey,
    meta.version,
    selectedProject.projectId,
    {
      query: fieldQuery,
      type: fieldType,
      sortBy,
      limit: PROJECTS_VIEW_PAGE_SIZE,
      offset,
    }
  );

  const fields = projectFieldsResult.rows.map((field) => ({
    fieldId: field.fieldId,
    fieldName: field.fieldName,
    description: field.description,
    fieldType: field.fieldType,
    configuredProjectCount: field.configuredProjectCount,
    totalIssueCount: field.totalIssueCount,
    activeProjectCount: field.activeProjectCount,
    issueCount: field.issueCount,
    jql: field.jql || buildFieldJql(selectedProject.projectKey, field.fieldId),
    latestFieldChangeAt: field.latestFieldChangeAt,
    latestIssueKey: field.latestIssueKey,
    latestIssueUpdatedAt: field.latestIssueUpdatedAt,
    findings: field.findings || null,
  }));

  const availableTypes = Array.from(
    new Set(projectFieldsResult.rows.map((field) => field.fieldType).filter(Boolean))
  ).sort((left, right) => left.localeCompare(right));
  const totalFields = Number(projectFieldsResult.total || 0);
  const totalPages = Math.max(1, Math.ceil(totalFields / PROJECTS_VIEW_PAGE_SIZE));

  return {
    projects,
    availableTypes,
    selectedProject,
    fields,
    totalFields,
    page: Math.min(requestedPage, totalPages),
    totalPages,
    pageSize: PROJECTS_VIEW_PAGE_SIZE,
    refreshedAt: meta.refreshedAt || null,
    issueScan: issueScanMeta ? {
      state: issueScanMeta.state,
      completedAt: issueScanMeta.completedAt,
      totalIssues: issueScanMeta.totalIssues,
      processedIssues: issueScanMeta.processedIssues,
      totalPages: issueScanMeta.totalPages,
      processedPages: issueScanMeta.processedPages,
      lastError: issueScanMeta.lastError,
    } : null,
  };
}

async function getFilteredFieldIds({ payload, context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    return { fieldIds: [] };
  }

  const query = String(payload?.query || "").trim();
  const optionQuery = String(payload?.optionQuery || "").trim();
  const type = String(payload?.type || "all").trim() || "all";
  const findingsFilter = String(payload?.findingsFilter || "all").trim() || "all";
  const projectUsageFilter = String(payload?.projectUsageFilter || "all").trim() || "all";
  const minIssuesWithValue = payload?.minIssuesWithValue ?? "";
  const maxIssuesWithValue = payload?.maxIssuesWithValue ?? "";
  const fieldOrigin = String(payload?.fieldOrigin || "all").trim() || "all";
  const sortBy = String(payload?.sortBy || "name-asc").trim() || "name-asc";
  const minActiveProjects = payload?.minActiveProjects ?? "";
  const maxActiveProjects = payload?.maxActiveProjects ?? "";
  const minContexts = payload?.minContexts ?? "";
  const maxContexts = payload?.maxContexts ?? "";
  const duplicateNamesOnly = Boolean(payload?.duplicateNamesOnly);
  const hasDescription = payload?.hasDescription || "all";
  const snapshotFields = await loadSnapshotFields(installationKey, meta.version);
  const fieldSummaries = await listFieldSummaries(installationKey, 5000).catch(() => []);
  const summaryByFieldId = new Map(fieldSummaries.map((summary) => [summary.fieldId, summary]));
  const duplicateNameCounts = buildDuplicateNameCountMap(snapshotFields);
  const allFields = snapshotFields.map((field) => {
    const summary = summaryByFieldId.get(field.id);
    if (!summary) {
      return hydrateFieldForGovernance({
        ...field,
        projectUsageBuilt: Number(field.totalIssueCount || 0) <= 0,
        projectUsageState: Number(field.totalIssueCount || 0) <= 0 ? "not-needed" : "unbuilt",
      }, null, duplicateNameCounts.get(normalizeFieldName(field.name)) ?? 1);
    }
    const inferredBuilt = summary.summaryStatus === "ready";
    return hydrateFieldForGovernance({
      ...field,
      activeProjectCount: summary.activeProjectCount ?? field.activeProjectCount,
      totalIssueCount: summary.totalIssueCount ?? field.totalIssueCount,
      projectUsageBuilt: inferredBuilt,
      projectUsageState: summary.summaryStatus || (inferredBuilt ? "ready" : "unbuilt"),
    }, summary, duplicateNameCounts.get(normalizeFieldName(field.name)) ?? 1);
  });
  const optionMatches = optionQuery ? await searchFieldOptionsCache(installationKey, optionQuery, 5000) : null;
  const optionMatchedFieldIds = optionMatches ? new Set(optionMatches.map((match) => match.fieldId)) : null;
  const optionFilteredFields = optionMatchedFieldIds
    ? allFields.filter((field) => optionMatchedFieldIds.has(field.id))
    : allFields;
  const filtered = sortInventoryFields(
    applyFindingsFilter(
      filterInventoryFields(optionFilteredFields, query, type, projectUsageFilter, maxIssuesWithValue, fieldOrigin, minIssuesWithValue, {
        minActiveProjects, maxActiveProjects, minContexts, maxContexts, duplicateNamesOnly, hasDescription,
      }),
      findingsFilter
    ),
    sortBy
  );
  return { fieldIds: filtered.map((field) => field.id) };
}

async function searchFieldOptions({ payload, context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const optionQuery = String(payload?.optionQuery || "").trim();
  if (!optionQuery) {
    return { status: "empty", matches: [], nextIndex: 0, done: true, scanned: 0, totalCandidates: 0 };
  }

  const matches = await searchFieldOptionsCache(installationKey, optionQuery, 500);

  return {
    status: "ok",
    optionQuery,
    matches: matches.map((match) => match.fieldId),
    nextIndex: matches.length,
    done: true,
    scanned: matches.length,
    totalCandidates: matches.length,
  };
}

async function startIssueScan({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const currentMeta = await readIssueScanMeta(installationKey);
  if (currentMeta?.state === "building" || currentMeta?.state === "queued") {
    return { started: false, reason: "already-running", meta: currentMeta };
  }

  const jobToken = makeJobToken();
  await writeIssueScanMeta(installationKey, {
    state: "queued",
    jobToken,
    lastError: null,
    progressLog: [{ t: new Date().toISOString(), msg: "Issue scan queued" }],
  });

  try {
    await inventorySnapshotQueue.push({
      body: { jobType: "run-issue-scan", installationKey },
    });
  } catch (pushError) {
    await writeIssueScanMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: `Queue push failed: ${pushError?.message || String(pushError)}`,
      progressLog: [{ t: new Date().toISOString(), msg: `Failed to queue scan: ${pushError?.message || String(pushError)}` }],
    }).catch(() => {});
    throw pushError;
  }

  return { started: true, jobToken };
}

async function resumeIssueScan({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const currentMeta = await readIssueScanMeta(installationKey);

  if (!currentMeta) {
    return { resumed: false, reason: "no-scan" };
  }

  if (currentMeta.state === "ready") {
    return { resumed: false, reason: "already-complete", meta: currentMeta };
  }

  const jobToken = currentMeta.jobToken || makeJobToken();
  const progressLog = [
    ...(currentMeta.progressLog || []).slice(-180),
    { t: new Date().toISOString(), msg: "Resume requested; re-queueing incomplete workers from saved checkpoint" },
  ];

  // Mark scan as building again (preserving all existing progress state)
  const meta = await writeIssueScanMeta(installationKey, {
    ...currentMeta,
    state: "building",
    jobToken,
    completedAt: null,
    lastError: null,
    progressLog,
  });

  // Re-queue only workers that haven't finished — do NOT call the coordinator
  // (the coordinator wipes all accumulated data and starts over)
  const queueErrors = [];
  for (let workerId = 0; workerId < ISSUE_SCAN_WORKERS; workerId++) {
    const worker = await readIssueScanWorker(installationKey, workerId).catch(() => null);
    if (!worker || worker.status === "done") continue;
    // Reset failed workers back to queued so they can run again
    if (worker.status === "failed") {
      await updateIssueScanWorker(installationKey, workerId, { status: "queued", lastError: null }).catch(() => {});
    }
    try {
      await queueIssueScanWorker(installationKey, workerId);
    } catch (pushError) {
      queueErrors.push(`worker ${workerId}: ${pushError?.message || String(pushError)}`);
    }
  }

  if (queueErrors.length > 0) {
    const errMsg = `Resume partially failed: ${queueErrors.join("; ")}`;
    await writeIssueScanMeta(installationKey, { state: "failed", lastError: errMsg }).catch(() => {});
    throw new Error(errMsg);
  }

  return { resumed: true, jobToken, meta };
}

async function getIssueScanStatus({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const meta = await readIssueScanMeta(installationKey);
  // "finalizing" is an internal transition state — surface it as "building" to the UI
  if (meta?.state === "finalizing") return { meta: { ...meta, state: "building" } };
  return { meta: meta || null };
}

async function cancelIssueScan({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const current = await readIssueScanMeta(installationKey);
  if (!current || current.state === "idle" || current.state === "ready") {
    return { cancelled: false, reason: "not-running" };
  }

  await writeIssueScanMeta(installationKey, {
    state: "cancelled",
    completedAt: new Date().toISOString(),
    progressLog: [
      ...(current.progressLog || []).slice(-80),
      { t: new Date().toISOString(), msg: "Scan cancelled by user" },
    ],
  });

  return { cancelled: true };
}

async function restoreProjectUsageCache({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    return { started: false, reason: "no-snapshot" };
  }
  await queueProjectUsageRestore(installationKey, meta.version);
  return { started: true, version: meta.version };
}

// ----- Rovo agent actions -----

function formatFieldCandidate(field) {
  return {
    id: field.id,
    name: field.name,
    type: field.type,
    description: field.description || "",
    activeProjectCount: field.activeProjectCount ?? 0,
    totalIssueCount: field.totalIssueCount ?? 0,
    fieldJql: field.fieldJql,
    findings: field.findings || null,
  };
}

function findFieldFromSnapshot(fields, identifier) {
  const n = String(identifier || "").trim().toLowerCase();
  if (!n) return null;
  return (
    fields.find((f) => f.id.toLowerCase() === n) ||
    fields.find((f) => f.name.trim().toLowerCase() === n) ||
    fields.find((f) => f.name.trim().toLowerCase().startsWith(n)) ||
    fields.find((f) =>
      [f.name, f.id, f.description].filter(Boolean).some((v) => v.toLowerCase().includes(n))
    ) ||
    null
  );
}

async function getSnapshotFieldsForAgent(installationKey) {
  await ensureProjectStoreReady();
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    return { fields: [], meta: null, status: { state: meta?.state || "idle" } };
  }
  const fields = await loadSnapshotFields(installationKey, meta.version);
  return { fields, meta, status: { state: meta.state, refreshedAt: meta.refreshedAt } };
}

export async function rovoSearchFields(payload, context) {
  incrMetric(METRIC_NAMES.rovoSearchFields);
  const installationKey = getInstallationKey(context);
  const query = String(payload?.query || "").trim();
  const fieldType = String(payload?.fieldType || "all").trim() || "all";
  const sortBy = String(payload?.sortBy || "usage-desc").trim() || "usage-desc";
  const maxResults = Math.max(1, Math.min(10, Number(payload?.maxResults) || 5));

  if (!query) return { status: "error", message: "A search query is required." };

  const { fields, meta, status } = await getSnapshotFieldsForAgent(installationKey);
  if (!meta) {
    return {
      status: "snapshot-unavailable",
      snapshotStatus: status,
      message: "No snapshot available yet — building one now.",
      matches: [],
    };
  }

  const matches = sortInventoryFields(filterInventoryFields(fields, query, fieldType), sortBy).slice(0, maxResults);
  return {
    status: "ok",
    snapshotRefreshedAt: meta.refreshedAt,
    query,
    totalMatches: matches.length,
    matches: matches.map(formatFieldCandidate),
  };
}

export async function rovoInspectField(payload, context) {
  incrMetric(METRIC_NAMES.rovoInspectField);
  const installationKey = getInstallationKey(context);
  const fieldIdentifier = String(payload?.fieldIdentifier || "").trim();
  const usagePage = Math.max(1, Number(payload?.projectPage) || 1);

  if (!fieldIdentifier) return { status: "error", message: "A field identifier is required." };

  const { fields, meta, status } = await getSnapshotFieldsForAgent(installationKey);
  if (!meta) {
    return { status: "snapshot-unavailable", snapshotStatus: status, message: "No snapshot available yet." };
  }

  const matchedField = findFieldFromSnapshot(fields, fieldIdentifier);
  if (!matchedField) {
    return { status: "not-found", snapshotRefreshedAt: meta.refreshedAt, message: `No field matched "${fieldIdentifier}".` };
  }

  const {
    projectUsage,
    total: projectCount,
    totalIssueCount,
  } = await getLiveFieldProjectUsage(matchedField.id, usagePage, PROJECT_USAGE_PAGE_SIZE);

  return {
    status: "ok",
    snapshotRefreshedAt: meta.refreshedAt,
    field: formatFieldCandidate(matchedField),
    governance: {
      activeProjectCount: projectCount,
      totalIssueCount,
      fieldJql: matchedField.fieldJql,
      findings: matchedField.findings || null,
      projectUsagePage: usagePage,
      projectUsageTotalPages: Math.max(1, Math.ceil(projectCount / PROJECT_USAGE_PAGE_SIZE)),
      projectUsageTotalProjects: projectCount,
    },
    projectUsage: projectUsage.map((p) => ({
      projectKey: p.projectKey,
      projectName: p.projectName,
      issueCount: p.issueCount,
      jql: p.jql,
    })),
  };
}

// ----- Admin config -----

const ADMIN_CONFIG_KEY = "atlasiq-admin-config";

const DEFAULT_MACRO_ACCESS = {
  restrictAccess: false,
  allowedGroups: [],
};

const DEFAULT_ADMIN_CONFIG = {
  readOnlyMode: false,
  apiConcurrency: BASE_JIRA_CONCURRENCY,
  autoSnapshotEnabled: false,
  autoSnapshotFrequency: "weekly",
  governanceThresholds: DEFAULT_GOVERNANCE_THRESHOLDS,
  macroAccess: DEFAULT_MACRO_ACCESS,
};

async function readAdminConfig() {
  try {
    const stored = await kvs.get(ADMIN_CONFIG_KEY);
    if (!stored) return DEFAULT_ADMIN_CONFIG;
    return {
      ...DEFAULT_ADMIN_CONFIG,
      ...stored,
      governanceThresholds: {
        ...DEFAULT_GOVERNANCE_THRESHOLDS,
        ...(stored.governanceThresholds || {}),
      },
      macroAccess: {
        ...DEFAULT_MACRO_ACCESS,
        ...(stored.macroAccess || {}),
      },
    };
  } catch {
    return DEFAULT_ADMIN_CONFIG;
  }
}

async function getAdminConfigResolver(_payload, _context) {
  return readAdminConfig();
}

async function saveAdminConfigResolver({ payload }) {
  const current = await readAdminConfig();
  const updated = {
    ...current,
    ...(payload || {}),
    governanceThresholds: {
      ...current.governanceThresholds,
      ...(payload?.governanceThresholds || {}),
    },
    macroAccess: {
      ...current.macroAccess,
      ...(payload?.macroAccess || {}),
    },
  };
  updated.apiConcurrency = Math.max(1, Math.min(10, Number(updated.apiConcurrency) || BASE_JIRA_CONCURRENCY));
  await kvs.set(ADMIN_CONFIG_KEY, updated);
  return { ok: true, config: updated };
}

async function checkMacroAccess({ context }) {
  try {
    const config = await readAdminConfig();
    const { restrictAccess, allowedGroups } = config.macroAccess || {};

    if (!restrictAccess) return { allowed: true };

    const groups = (allowedGroups || []).filter(Boolean);
    if (!groups.length) {
      return {
        allowed: false,
        reason: "Macro access is restricted but no allowed groups have been configured. Contact your Jira administrator.",
      };
    }

    const accountId = context?.accountId;
    if (!accountId) {
      return { allowed: false, reason: "Please sign in to Jira to view this Observatory." };
    }

    const resp = await api.asApp().requestJira(
      route`/rest/api/3/user/groups?accountId=${accountId}`,
      { headers: { Accept: "application/json" } }
    );

    if (!resp.ok) {
      console.error("checkMacroAccess: group lookup failed", resp.status);
      return { allowed: true }; // fail open — don't block on API error
    }

    const userGroups = await resp.json();
    const userGroupNames = Array.isArray(userGroups) ? userGroups.map((g) => g.name) : [];
    const hasAccess = groups.some((g) => userGroupNames.includes(g));

    return hasAccess
      ? { allowed: true }
      : {
          allowed: false,
          reason: "You don't have permission to view this Observatory. Contact your Jira administrator to request access.",
        };
  } catch (err) {
    console.error("checkMacroAccess error:", err);
    return { allowed: true }; // fail open
  }
}

async function getAdminOverview({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const [meta, summaries, config, legacySummaryCount] = await Promise.all([
    readSnapshotMeta(installationKey),
    listFieldSummaries(installationKey, 5000).catch(() => []),
    readAdminConfig(),
    countOldScopeKeyRows(installationKey).catch(() => 0),
  ]);

  const jobCounts = { queued: 0, building: 0, ready: 0, failed: 0, cancelled: 0, unbuilt: 0 };
  for (const s of summaries) {
    const state = s.summaryStatus || "unbuilt";
    if (state in jobCounts) jobCounts[state]++;
    else jobCounts.unbuilt++;
  }

  let findingsSummary = { adminAttention: 0, risky: 0, cleanup: 0, standardize: 0 };
  if (meta?.version) {
    try {
      const fields = await loadSnapshotFields(installationKey, meta.version);
      const dup = buildDuplicateNameCountMap(fields);
      const hydrated = fields.map((f) =>
        hydrateFieldForGovernance(f, null, dup.get(normalizeFieldName(f.name)) ?? 1, config.governanceThresholds)
      );
      findingsSummary = summarizeFindings(hydrated);
    } catch {}
  }

  return {
    config,
    snapshot: {
      state: meta?.state || "idle",
      refreshedAt: meta?.refreshedAt || null,
      startedAt: meta?.startedAt || null,
      completedAt: meta?.completedAt || null,
      totalFields: meta?.totalFields || 0,
      processedFields: meta?.processedFields || 0,
      percent: meta?.totalFields > 0
        ? Math.min(100, Math.round(((meta.processedFields || 0) / meta.totalFields) * 100))
        : 0,
      lastError: meta?.lastError || null,
      progressLog: (meta?.progressLog || []).slice(-50),
    },
    jobCounts,
    findingsSummary,
    totalSummaries: summaries.length,
    legacySummaryCount,
  };
}

async function migrateNamespaceKeys({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const result = await migrateOldScopeKeys(installationKey);
  return result;
}

// ----- Exports -----

export async function scheduleSnapshot(_event, context) {
  incrMetric(METRIC_NAMES.snapshotScheduler);
  const installationKey = getInstallationKey(context);
  await queueSnapshotBuild(installationKey);
  return { queued: true };
}

export async function autoSnapshotCheck(_event, context) {
  const config = await readAdminConfig();
  if (!config.autoSnapshotEnabled) return { skipped: true, reason: "disabled" };

  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);

  if (meta?.state === "building" || meta?.state === "queued") {
    return { skipped: true, reason: "already running" };
  }

  const lastRun = meta?.refreshedAt ? new Date(meta.refreshedAt).getTime() : 0;
  const minAgeMs = config.autoSnapshotFrequency === "daily"
    ? 20 * 60 * 60 * 1000
    : 6 * 24 * 60 * 60 * 1000;

  if (Date.now() - lastRun < minAgeMs) {
    return { skipped: true, reason: "not due yet" };
  }

  await queueSnapshotBuild(installationKey);
  incrMetric(METRIC_NAMES.snapshotScheduler);
  return { queued: true };
}

export async function runProjectStorageMigrations() {
  incrMetric(METRIC_NAMES.sqlMigrate);
  await ensureProjectStoreReady();
  return { ok: true };
}

export async function consumeSnapshot(event) {
  incrMetric(METRIC_NAMES.snapshotConsumer);
  const installationKey = sanitizeCacheKeyPart(
    event?.body?.installationKey || event?.installationKey || "global"
  );
  const jobType = event?.body?.jobType || "run-snapshot";
  try {
    if (jobType === "build-field-summary") {
      const version = String(event?.body?.version || "");
      const fieldId = String(event?.body?.fieldId || "");
      const jobToken = String(event?.body?.jobToken || "");
      const startAt = Math.max(0, Number(event?.body?.startAt) || 0);
      const nextPageToken = String(event?.body?.nextPageToken || "");
      if (!version || !fieldId) {
        console.warn("consumeSnapshot: missing version or fieldId for build-field-summary job");
        return;
      }

      const snapshotField = await loadSnapshotField(installationKey, version, fieldId);
      if (!snapshotField) {
        console.warn(`consumeSnapshot: snapshot field not found for summary build: ${fieldId}`);
        return;
      }

      await processFieldSummaryChunk(
        installationKey,
        version,
        snapshotField,
        jobToken,
        startAt,
        nextPageToken || null
      );
      return;
    }

    if (jobType === "refresh-field-project-delta") {
      const version = String(event?.body?.version || "");
      const fieldId = String(event?.body?.fieldId || "");
      const jobToken = String(event?.body?.jobToken || "");
      const projectKeys = Array.isArray(event?.body?.projectKeys) ? event.body.projectKeys : [];
      const windowHours = Number(event?.body?.windowHours || 24);
      if (!version || !fieldId || !jobToken) {
        console.warn("consumeSnapshot: missing version or fieldId for refresh-field-project-delta job");
        return;
      }

      const snapshotField = await loadSnapshotField(installationKey, version, fieldId);
      if (!snapshotField) {
        console.warn(`consumeSnapshot: snapshot field not found for incremental refresh: ${fieldId}`);
        return;
      }

      await processFieldUsageDelta(
        installationKey,
        version,
        snapshotField,
        jobToken,
        projectKeys,
        windowHours
      );
      return;
    }

    if (jobType === "build-project-usage-report") {
      const version = String(event?.body?.version || "");
      const jobId = String(event?.body?.jobId || "");
      if (!version || !jobId) {
        console.warn("consumeSnapshot: missing version or jobId for build-project-usage-report job");
        return;
      }

      await processProjectUsageReportJob(installationKey, version, jobId);
      return;
    }

    if (jobType === "run-issue-scan") {
      await runIssueScanCoordinator(installationKey);
      return;
    }

    if (jobType === "run-issue-scan-worker") {
      const workerId = Number(event?.body?.workerId ?? 0);
      await runIssueScanWorkerV2(installationKey, workerId);
      return;
    }

    if (jobType === "cache-field-options") {
      const fieldId = String(event?.body?.fieldId || "");
      if (!fieldId) {
        console.warn("consumeSnapshot: missing fieldId for cache-field-options job");
        return;
      }
      const result = await cacheFieldOptionsForField(installationKey, fieldId);
      console.log(`cache-field-options: cached ${result.optionCount || 0} options for ${fieldId}`);
      return;
    }

    if (jobType === "restore-project-usage") {
      const version = String(event?.body?.version || "");
      if (!version) {
        console.warn("consumeSnapshot: missing version for restore-project-usage job");
        return;
      }
      const result = await restoreSnapshotProjectUsageFromSummaries(installationKey, version);
      console.log(`restore-project-usage: restored ${result.fieldsRestored} fields, ${result.rowsInserted} rows`);
      return;
    }

    if (jobType === "run-delta-issue-scan") {
      const windowHours = Number(event?.body?.windowHours || DELTA_ISSUE_SCAN_DEFAULT_WINDOW_HOURS);
      await runDeltaIssueScanJob(installationKey, windowHours);
      return;
    }

    await runSnapshot(installationKey);
  } catch (error) {
    incrMetric(METRIC_NAMES.snapshotConsumerFailed);
    // Last-resort catch — runSnapshot already handles its own errors, but never rethrow
    // here regardless, because Forge would retry the message indefinitely.
    if (jobType === "build-field-summary") {
      const fieldId = String(event?.body?.fieldId || "");
      const existing = fieldId ? await loadFieldSummary(installationKey, fieldId).catch(() => null) : null;
      if (existing) {
        const message = String(error?.message || "Unknown error");
        const isRecoverableQueuePressure =
          message.toLowerCase().includes("too many requests")
          || message.toLowerCase().includes("cyclic invocation")
          || message.toLowerCase().includes("limits for the current installation have been exceeded");
        await replaceFieldSummary(installationKey, fieldId, {
          ...existing,
          refreshedAt: new Date().toISOString(),
          summaryStatus: isRecoverableQueuePressure ? "queued" : "failed",
          completedAt: isRecoverableQueuePressure ? null : new Date().toISOString(),
          lastError: isRecoverableQueuePressure ? null : message,
          progressLog: [
            ...(existing.progressLog || []),
            {
              t: new Date().toISOString(),
              msg: isRecoverableQueuePressure
                ? `Backpressure encountered: ${message}. Leaving job queued for safe continuation.`
                : `${jobType === "refresh-field-project-delta" ? "Incremental refresh failed" : "Job failed"}: ${message}`,
            },
          ].slice(-100),
        }).catch(() => {});
        if (!isRecoverableQueuePressure) {
          incrMetric(METRIC_NAMES.projectUsageJobFailed);
        }
      }
    }
    if (jobType === "build-project-usage-report") {
      const jobId = String(event?.body?.jobId || "");
      const existing = jobId ? await loadReportJob(installationKey, jobId).catch(() => null) : null;
      if (existing) {
        const message = String(error?.message || "Unknown error");
        await replaceReportJob(installationKey, jobId, {
          ...existing,
          status: "failed",
          completedAt: new Date().toISOString(),
          refreshedAt: new Date().toISOString(),
          lastError: message,
          progressLog: [
            ...(existing.progressLog || []),
            { t: new Date().toISOString(), msg: `Report job failed: ${message}` },
          ].slice(-100),
        }).catch(() => {});
        incrMetric(METRIC_NAMES.reportJobFailed);
      }
    }
    console.error("consumeSnapshot unhandled error:", error?.message || error);
  }
}

const DELTA_SCOPE_SUFFIX = "::delta";
const DELTA_ISSUE_SCAN_MAX_PAGES = 200; // cap at ~20,000 issues per delta run
const DELTA_ISSUE_SCAN_DEFAULT_WINDOW_HOURS = 24;

async function runDeltaIssueScanJob(installationKey, windowHours = DELTA_ISSUE_SCAN_DEFAULT_WINDOW_HOURS) {
  const deltaScopeKey = `${installationKey}${DELTA_SCOPE_SUFFIX}`;
  const progressLog = [];

  function logEntry(msg) {
    progressLog.push({ t: new Date().toISOString(), msg });
    if (progressLog.length > 100) progressLog.shift();
    console.log(`runDeltaIssueScanJob: ${msg}`);
  }

  try {
    await ensureProjectStoreReady();

    const existing = await readIssueScanMeta(deltaScopeKey);
    if (existing?.state === "building") {
      const startedMs = existing.startedAt ? new Date(existing.startedAt).getTime() : 0;
      if (startedMs && (Date.now() - startedMs) < 10 * 60 * 1000) {
        console.log("runDeltaIssueScanJob: already in progress, skipping");
        return;
      }
    }

    const windowDays = Math.max(1, Math.round(windowHours / 24));
    const jql = `created >= "-${windowDays}d" OR updated >= "-${windowDays}d" ORDER BY issueKey ASC`;
    logEntry(`Starting ${windowHours}h delta scan`);

    let totalDeltaIssues = 0;
    try {
      const countData = await jiraRequest(route`/rest/api/3/search/jql`, {
        method: "POST",
        body: JSON.stringify({ jql, maxResults: 0, fields: [] }),
      });
      totalDeltaIssues = Number(countData?.total ?? 0);
    } catch { /* non-critical */ }

    const totalDeltaPages = Math.ceil(totalDeltaIssues / ISSUE_SCAN_PAGE_SIZE);
    logEntry(`${totalDeltaIssues.toLocaleString()} issues created/updated in last ${windowDays}d (${totalDeltaPages} pages)`);

    await writeIssueScanMeta(deltaScopeKey, {
      state: "building",
      jobToken: makeJobToken(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      totalIssues: totalDeltaIssues,
      processedIssues: 0,
      processedPages: 0,
      totalPages: totalDeltaPages,
      nextPageToken: null,
      nextStartAt: 0,
      lastError: null,
      progressLog: [...progressLog],
    });

    // Map<fieldId, Map<projectId, { count, key, name }>> — same structure as baseline scan
    const fieldProjectCounts = new Map();
    const affectedProjects = new Map();
    const rqtFieldHits = new Map();
    const rqtIssueBuffer = [];
    const rqtValueBuffer = []; // { rqtValue, issueKey }
    const rqtFieldIssueBuffer = []; // { fieldId, issueKey }
    let cursorToken = null;
    let pagesScanned = 0;
    let issuesScanned = 0;

    while (pagesScanned < DELTA_ISSUE_SCAN_MAX_PAGES) {
      const reqBody = { jql, maxResults: ISSUE_SCAN_PAGE_SIZE, fields: ["*all"], fieldsByKeys: false };
      if (cursorToken) reqBody.nextPageToken = cursorToken;

      const data = await jiraRequest(route`/rest/api/3/search/jql`, {
        method: "POST",
        body: JSON.stringify(reqBody),
      });

      const issues = data?.issues || [];
      for (const issue of issues) {
        const projectId = String(issue.fields?.project?.id || "");
        if (!projectId) continue;
        const projectKey = String(issue.fields?.project?.key || "");
        const projectName = String(issue.fields?.project?.name || projectKey);

        affectedProjects.set(projectId, { key: projectKey, name: projectName });

        for (const [fieldId, value] of Object.entries(issue.fields || {})) {
          if (STRUCTURAL_SYSTEM_FIELDS.has(fieldId)) continue;
          if (!isFieldValueNonEmpty(value)) continue;

          let byProject = fieldProjectCounts.get(fieldId);
          if (!byProject) {
            byProject = new Map();
            fieldProjectCounts.set(fieldId, byProject);
          }
          const entry = byProject.get(projectId) || { count: 0, key: projectKey, name: projectName };
          entry.count++;
          byProject.set(projectId, entry);
        }

        const issueRqt = collectIssueRqtValues(issue.fields, issue.fields?.summary);
        for (const [fieldId, values] of issueRqt) {
          const rqtEntry = rqtFieldHits.get(fieldId) || { count: 0, values: new Set() };
          rqtEntry.count++;
          for (const v of values) rqtEntry.values.add(v);
          rqtFieldHits.set(fieldId, rqtEntry);
        }

        if (issueRqt.size > 0 && issue.key) {
          rqtIssueBuffer.push({
            projectKey,
            issueType: issue.fields?.issuetype?.name || "Unknown",
            issueKey: issue.key,
          });
          const allValues = new Set();
          for (const vals of issueRqt.values()) for (const v of vals) allValues.add(v);
          for (const v of allValues) rqtValueBuffer.push({ rqtValue: v, issueKey: issue.key });
        }
        if (issueRqt.size > 0 && issue.key) {
          for (const fieldId of issueRqt.keys()) {
            rqtFieldIssueBuffer.push({ fieldId, issueKey: issue.key });
          }
        }
      }

      issuesScanned += issues.length;
      pagesScanned++;
      cursorToken = data?.nextPageToken || null;

      if (pagesScanned % 5 === 0) {
        await writeIssueScanMeta(deltaScopeKey, {
          processedIssues: issuesScanned,
          processedPages: pagesScanned,
          progressLog: [...progressLog],
        }).catch(() => {});
      }

      if (!cursorToken || issues.length === 0) break;
    }

    if (pagesScanned >= DELTA_ISSUE_SCAN_MAX_PAGES) {
      logEntry(`Delta cap reached (${DELTA_ISSUE_SCAN_MAX_PAGES} pages) — results may be partial`);
    }

    logEntry(`Scanned ${issuesScanned.toLocaleString()} delta issues — ${fieldProjectCounts.size} fields across ${affectedProjects.size} projects`);

    if (rqtFieldHits.size > 0) {
      await upsertRqtFieldHits(installationKey, rqtFieldHits).catch((e) => {
        console.error("runDeltaIssueScanJob: RQT flush error", e?.message || e);
      });
      logEntry(`RQT index updated — ${rqtFieldHits.size} field(s) with RQT values`);
    }
    if (rqtIssueBuffer.length > 0) {
      await upsertRqtIssueKeys(installationKey, rqtIssueBuffer).catch((e) => {
        console.error("runDeltaIssueScanJob: RQT issue key flush error", e?.message || e);
      });
      logEntry(`RQT issue keys updated — ${rqtIssueBuffer.length} issue(s)`);
    }
    if (rqtValueBuffer.length > 0) {
      await upsertRqtValueIssueKeys(installationKey, rqtValueBuffer).catch((e) => {
        console.error("runDeltaIssueScanJob: RQT value index flush error", e?.message || e);
      });
    }
    if (rqtFieldIssueBuffer.length > 0) {
      await upsertRqtFieldIssueKeys(installationKey, rqtFieldIssueBuffer).catch((e) => {
        console.error(`RQT field issue index flush error`, e?.message || e);
      });
    }

    // Update project totals (accurate: re-count total issues per affected project)
    const projectRows = [];
    if (affectedProjects.size > 0) {
      const projectEntries = Array.from(affectedProjects.entries());
      const counts = await mapWithConcurrency(projectEntries, 4, async ([projectId, proj]) => {
        try {
          const safeKey = proj.key.replace(/"/g, '\\"');
          const countData = await jiraRequest(route`/rest/api/3/search/jql`, {
            method: "POST",
            body: JSON.stringify({ jql: `project = "${safeKey}"`, maxResults: 0, fields: [] }),
          });
          return { projectId, projectKey: proj.key, projectName: proj.name, uniqueIssueCount: Number(countData?.total ?? 0) };
        } catch {
          return null;
        }
      });
      projectRows.push(...counts.filter(Boolean));
      await upsertProjectTotalsForDelta(installationKey, projectRows);
      logEntry(`Updated total issue counts for ${projectRows.length} project${projectRows.length !== 1 ? "s" : ""}`);
    }

    // Update field×project usage: for each touched pair, get accurate total count via JQL
    const snapshotMeta = await readSnapshotMeta(installationKey);
    let fieldProjectPairsUpdated = 0;

    if (snapshotMeta?.version && fieldProjectCounts.size > 0) {
      const touchedPairs = [];
      for (const [fieldId, byProject] of fieldProjectCounts) {
        for (const [projectId, proj] of byProject) {
          touchedPairs.push({ fieldId, projectId, projectKey: proj.key, projectName: proj.name, deltaCount: proj.count });
        }
      }
      touchedPairs.sort((a, b) => b.deltaCount - a.deltaCount);
      const cappedPairs = touchedPairs.slice(0, 500);
      if (touchedPairs.length > 500) {
        logEntry(`Capped field×project count queries at 500 of ${touchedPairs.length} pairs`);
      }

      logEntry(`Running ${cappedPairs.length} field×project count queries...`);

      const usageRows = await mapWithConcurrency(cappedPairs, 6, async ({ fieldId, projectId, projectKey, projectName }) => {
        try {
          const numericId = getFieldNumericId(fieldId);
          const fieldSelector = numericId ? `cf[${numericId}]` : fieldId;
          const safeKey = projectKey.replace(/"/g, '\\"');
          const countData = await jiraRequest(route`/rest/api/3/search/jql`, {
            method: "POST",
            body: JSON.stringify({
              jql: `project = "${safeKey}" AND ${fieldSelector} is not EMPTY`,
              maxResults: 0,
              fields: [],
            }),
          });
          return {
            fieldId,
            projectId,
            projectKey,
            projectName,
            issueCount: Number(countData?.total ?? 0),
            jql: buildFieldJql(fieldId, projectKey),
          };
        } catch {
          return null;
        }
      });

      const validRows = usageRows.filter(Boolean).filter((r) => r.issueCount > 0);
      fieldProjectPairsUpdated = await upsertDeltaFieldProjectUsage(installationKey, snapshotMeta.version, validRows);
      logEntry(`Updated ${fieldProjectPairsUpdated} field×project usage rows in snapshot`);
    } else if (!snapshotMeta?.version) {
      logEntry("No snapshot found — skipping field usage update (run a snapshot first)");
    }

    await writeIssueScanMeta(deltaScopeKey, {
      state: "ready",
      completedAt: new Date().toISOString(),
      processedIssues: issuesScanned,
      processedPages: pagesScanned,
      totalIssues: totalDeltaIssues,
      totalPages: totalDeltaPages,
      nextPageToken: null,
      nextStartAt: 0,
      lastError: null,
      projectsUpdated: projectRows.length,
      fieldProjectPairsUpdated,
      progressLog: [...progressLog],
    });

  } catch (error) {
    await writeIssueScanMeta(deltaScopeKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: error?.message || String(error),
      progressLog: [...progressLog, { t: new Date().toISOString(), msg: `Delta scan failed: ${error?.message || error}` }],
    }).catch(() => {});
    console.error("runDeltaIssueScanJob failed:", error?.message || error);
  }
}

async function startDeltaIssueScan({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const deltaScopeKey = `${installationKey}${DELTA_SCOPE_SUFFIX}`;

  const existing = await readIssueScanMeta(deltaScopeKey);
  if (existing?.state === "building" || existing?.state === "queued") {
    return { started: false, reason: "already-running" };
  }

  try {
    await writeIssueScanMeta(deltaScopeKey, {
      state: "queued",
      progressLog: [{ t: new Date().toISOString(), msg: "Delta scan queued" }],
    });
    await inventorySnapshotQueue.push({
      body: { jobType: "run-delta-issue-scan", installationKey },
    });
    return { started: true };
  } catch (pushError) {
    await writeIssueScanMeta(deltaScopeKey, {
      state: "failed",
      lastError: `Queue push failed: ${pushError?.message || pushError}`,
    }).catch(() => {});
    throw pushError;
  }
}

async function getDeltaIssueScanStatus({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const deltaScopeKey = `${installationKey}${DELTA_SCOPE_SUFFIX}`;
  const meta = await readIssueScanMeta(deltaScopeKey);
  return { meta: meta || null };
}

async function getRqtIndex({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const [rqtFields, snapshotMeta, issuesByProject, rqtValueFrequency, issueRqtValues, fieldIssueIndex] = await Promise.all([
    loadRqtFieldIndex(installationKey),
    readSnapshotMeta(installationKey),
    loadRqtIssueKeys(installationKey),
    loadRqtValueFrequency(installationKey),
    loadIssueRqtValues(installationKey),
    loadRqtFieldIssueIndex(installationKey),
  ]);

  // Enrich field names from the live snapshot if available
  if (snapshotMeta?.version && rqtFields.length > 0) {
    try {
      const snapshotFields = await loadSnapshotFields(installationKey, snapshotMeta.version);
      const nameMap = {};
      for (const f of snapshotFields) nameMap[f.id] = f.name;
      for (const r of rqtFields) {
        if (nameMap[r.fieldId]) r.fieldName = nameMap[r.fieldId];
      }
    } catch {
      // Name enrichment is best-effort
    }
  }

  const jql = buildRqtJql(rqtFields.map((r) => r.fieldId));
  const allValues = [...new Set(rqtFields.flatMap((r) => r.sampleValues))].sort();
  const totalIssues = rqtFields.reduce((sum, r) => sum + r.issueCount, 0);
  const refreshedAt = rqtFields[0]?.refreshedAt || null;

  const totalUniqueIssues = issuesByProject.reduce((sum, p) => sum + p.total, 0);

  return {
    fields: rqtFields,
    jql,
    uniqueValues: allValues,
    totalIssues,
    totalUniqueIssues,
    issuesByProject,
    rqtValueFrequency,
    refreshedAt,
    fieldCount: rqtFields.length,
    issueRqtValues,
    fieldIssueIndex,
  };
}

async function searchRqtValue({ payload, context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const rqtValue = String(payload?.rqtValue || "").trim().toUpperCase();
  if (!rqtValue) return { issueKeys: [] };
  const issueKeys = await searchRqtValueIssueKeys(installationKey, rqtValue);
  return { issueKeys };
}

async function getFieldOptions({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    await ensureProjectStoreReady();
    const fieldId = String(payload?.fieldId || "");
    const projectKeys = Array.isArray(payload?.projectKeys) ? payload.projectKeys.filter(Boolean) : [];

    if (!fieldId) return { fieldId: "", optionsByContext: [] };

    let { optionsByContext, refreshedAt } = await loadFieldOptionsCache(getInstallationKey(context), fieldId);
    if (!optionsByContext.length || payload?.forceRefresh) {
      optionsByContext = await loadFieldOptionsFromJira(fieldId);
      const cacheResult = await replaceFieldOptionsCache(getInstallationKey(context), fieldId, optionsByContext);
      refreshedAt = cacheResult.refreshedAt;
    }

    if (projectKeys.length > 0) {
      const numericId = getFieldNumericId(fieldId);
      const fieldSelector = numericId ? `cf[${numericId}]` : fieldId;
      const projectFilter = `project in (${projectKeys.map((k) => `"${k.replace(/"/g, '\\"')}"`).join(", ")})`;

      const allOptions = [];
      const seenIds = new Set();
      for (const ctx of optionsByContext) {
        for (const opt of ctx.options) {
          if (!seenIds.has(opt.id) && !opt.disabled) {
            seenIds.add(opt.id);
            allOptions.push(opt);
          }
          if (allOptions.length >= 100) break;
        }
        if (allOptions.length >= 100) break;
      }

      const counts = await mapWithConcurrency(allOptions, 4, async (opt) => {
        try {
          const safeValue = opt.value.replace(/"/g, '\\"');
          const data = await jiraRequest(route`/rest/api/3/search/jql`, {
            method: "POST",
            body: JSON.stringify({ jql: `${projectFilter} AND ${fieldSelector} = "${safeValue}"`, maxResults: 0, fields: [] }),
          });
          return { id: opt.id, issueCount: Number(data?.total ?? 0) };
        } catch {
          return { id: opt.id, issueCount: null };
        }
      });

      const countById = new Map(counts.map((c) => [c.id, c.issueCount]));
      for (const ctx of optionsByContext) {
        for (const opt of ctx.options) {
          if (countById.has(opt.id)) opt.issueCount = countById.get(opt.id);
        }
      }
    }

    return { fieldId, optionsByContext, refreshedAt };
  } catch (error) {
    console.error("getFieldOptions failed:", error);
    throw error;
  }
}

const MACRO_RESOLVER_FUNCTIONS = {
  checkMacroAccess,
  getFieldInventory,
  getFieldDetails,
  getProjectsView,
  getFilteredFieldIds,
  getFieldOptions,
  searchFieldOptions,
  getSavedReports,
  saveReportDefinition,
  deleteReportDefinition,
  startProjectUsageReportJob,
  getProjectUsageReportJob,
  getProjectUsageReport,
};

const ADMIN_ONLY_FUNCTIONS = {
  cancelSnapshot,
  startIssueScan,
  resumeIssueScan,
  getIssueScanStatus,
  cancelIssueScan,
  restoreProjectUsageCache,
  startDeltaIssueScan,
  getDeltaIssueScanStatus,
  getProjectUsageJobs,
  cancelProjectUsageJob,
  restartProjectUsageJob,
  resumeProjectUsageJob,
  getRqtIndex,
  searchRqtValue,
  refreshRecentProjectUsage,
};

export const handler = makeResolver(MACRO_RESOLVER_FUNCTIONS);

export const adminHandler = makeResolver({
  ...MACRO_RESOLVER_FUNCTIONS,
  ...ADMIN_ONLY_FUNCTIONS,
  getAdminConfig: getAdminConfigResolver,
  saveAdminConfig: saveAdminConfigResolver,
  getAdminOverview,
  migrateNamespaceKeys,
});
