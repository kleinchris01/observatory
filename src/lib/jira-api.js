import api, { route } from "@forge/api";
import { internalMetrics } from "@forge/metrics";
import {
  buildFieldJql,
  buildOverallFieldJql,
  buildProjectUsageRecord,
  getFieldNumericId,
  summarizeContexts,
} from "./transform.js";
import { isSelectFieldType } from "./analysis.js";

// ----- Constants -----

export const DEFAULT_PAGE_SIZE = 100;
export const INVENTORY_PAGE_SIZE = 10;
export const PROJECT_USAGE_PAGE_SIZE = 12;
export const PROJECTS_VIEW_PAGE_SIZE = 24;
export const PROJECT_USAGE_ISSUE_SCAN_PAGE_SIZE = 100;
export const PROJECT_USAGE_SCAN_PAGES_PER_JOB = 1;
export const REPORT_JOB_FIELD_BATCH_SIZE = 40;
export const MAX_ACTIVE_PROJECT_USAGE_JOBS = 3;
export const MAX_AUTOQUEUED_REPORT_FIELDS = 12;
export const MAX_AUTOQUEUED_REPORT_ISSUE_BUDGET = 200000;
export const MAX_RETRY_ATTEMPTS = 8;
export const BASE_JIRA_REQUEST_INTERVAL_MS = 180;
export const MAX_JIRA_REQUEST_INTERVAL_MS = 1500;
export const BASE_JIRA_CONCURRENCY = 4;
export const JIRA_REQUEST_HARD_TIMEOUT_MS = 12000; // safety net — ensures jiraInflight always decrements
export const SNAPSHOT_QUEUE_KEY = "inventory-snapshot-queue";
export const SNAPSHOT_CONCURRENCY = 4;
export const SNAPSHOT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
export const SNAPSHOT_PROGRESS_FLUSH_INTERVAL_MS = 15000;
export const SNAPSHOT_DB_BATCH_SIZE = 25;
export const FIELD_SUMMARY_QUEUE_STALE_AFTER_MS = 60 * 1000;
export const FIELD_SUMMARY_BUILD_STALE_AFTER_MS = 5 * 60 * 1000;
export const ISSUE_SCAN_PAGE_SIZE = 100;      // Jira Cloud cursor-based search caps maxResults at 100
export const ISSUE_SCAN_WORKERS = 5;          // parallel Forge workers; keep low because each invocation has its own in-memory limiter
export const ISSUE_SCAN_INTER_PAGE_DELAY_MS = 500; // ms between pages per worker to ease Jira API pressure
export const ISSUE_SCAN_FLUSH_EVERY_PAGES = 3;    // flush field counts + update UI progress every N pages (300 issues/worker)

export const METRIC_NAMES = {
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
  workflowSnapshotStarted: "workflow-snapshot-started",
  workflowSnapshotCompleted: "workflow-snapshot-completed",
  workflowSnapshotFailed: "workflow-snapshot-failed",
};

// ----- Module-level rate limiter state -----

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

export function setSnapshotLogger(fn) { snapshotLogFn = fn; }
export function resetScanTelemetry() { rl429Count = 0; rlRetryCount = 0; }
export function getScanTelemetry() { return { rl429Count, rlRetryCount }; }

export function resetJiraRateLimiterState() {
  jiraSuccessStreak = 0;
  jiraCooldownUntil = 0;
  currentJiraRequestIntervalMs = BASE_JIRA_REQUEST_INTERVAL_MS;
  currentJiraConcurrency = BASE_JIRA_CONCURRENCY;
}

// ----- Core utilities -----

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function incrMetric(name, value = 1) {
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

export function getJitterMs(maxMs = 20) {
  return Math.floor(Math.random() * maxMs);
}

export function makeJobToken() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function sanitizeCacheKeyPart(value) {
  return String(value || "global").replace(/[^a-zA-Z0-9:._\s\-#]/g, "_").trim().slice(0, 180) || "global";
}

export function getInstallationKey(context) {
  const key = context?.installContext;
  if (!key) throw new Error("Missing installContext — cannot determine tenant scope key");
  // Normalize away the product name (confluence/jira/etc.) so the Jira admin page
  // and the Confluence macro share the same SQL namespace for the same cloud site.
  // ari:cloud:confluence::site/UUID and ari:cloud:jira::site/UUID both reduce to
  // ari:cloud::site/UUID after stripping the product segment.
  const normalized = String(key).replace(/^(ari:cloud:)[^:]+(:.*)$/, "$1$2");
  return sanitizeCacheKeyPart(normalized);
}

export function isSnapshotStale(meta) {
  if (!meta?.refreshedAt) return true;
  return (Date.now() - new Date(meta.refreshedAt).getTime()) > SNAPSHOT_STALE_AFTER_MS;
}

export function registerJiraRateLimit(delayMs) {
  jiraCooldownUntil = Math.max(jiraCooldownUntil, Date.now() + delayMs);
  currentJiraRequestIntervalMs = Math.min(
    MAX_JIRA_REQUEST_INTERVAL_MS,
    Math.max(currentJiraRequestIntervalMs * 1.5, BASE_JIRA_REQUEST_INTERVAL_MS + 120)
  );
  currentJiraConcurrency = Math.max(1, currentJiraConcurrency - 1);
  jiraSuccessStreak = 0;
}

export function registerJiraSuccess() {
  jiraSuccessStreak++;
  if (jiraSuccessStreak < 25) return;
  jiraSuccessStreak = 0;
  currentJiraRequestIntervalMs = Math.max(BASE_JIRA_REQUEST_INTERVAL_MS, currentJiraRequestIntervalMs - 40);
  currentJiraConcurrency = Math.min(BASE_JIRA_CONCURRENCY, currentJiraConcurrency + 1);
}

export async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  // Suppress unhandled rejection on the abandoned promise when timeout wins the race
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// shouldRetry and getRetryDelayMs are imported from analysis.js
import { shouldRetry, getRetryDelayMs } from "./analysis.js";

export async function withRetry(operation) {
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

export async function scheduleRateLimitedRequest(callback) {
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

export async function jiraRequest(path, options = {}) {
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

// asUser() variant of jiraRequest -- for calls that must reflect the CALLING
// user's own permissions rather than the app's broad service identity (e.g.
// getBrowsableProjectIds below). Same retry/rate-limit/error conventions.
export async function jiraRequestAsUser(path, options = {}) {
  return withRetry(async () => {
    const response = await scheduleRateLimitedRequest(() =>
      api.asUser().requestJira(path, {
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

// Bulk-checks BROWSE_PROJECTS for the given user across up to 1000 projects in
// one call, returning the subset of projectIds (as strings) they can browse.
// Used to filter project-level data down to what the CALLING user is actually
// permitted to see, independent of the app's own broad service-level access.
export async function getBrowsableProjectIds(accountId, projectIds) {
  const ids = Array.from(new Set((projectIds || []).map(String).filter(Boolean)));
  if (!accountId || !ids.length) return new Set();

  const data = await jiraRequestAsUser(route`/rest/api/3/permissions/check`, {
    method: "POST",
    body: JSON.stringify({
      accountId,
      projectPermissions: [{ permissions: ["BROWSE_PROJECTS"], projects: ids }],
    }),
  });

  const allowed = data?.projectPermissions?.[0]?.projects || [];
  return new Set(allowed.map(String));
}

export async function paginate(pathBuilder, valuesKey = "values") {
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

export async function mapWithConcurrency(items, concurrency, iteratee) {
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

export async function getAllCustomFields() {
  return paginate(
    (startAt) => route`/rest/api/3/field/search?type=custom&startAt=${startAt}&maxResults=${DEFAULT_PAGE_SIZE}&orderBy=name`
  );
}

export async function getAllSystemFields() {
  return paginate(
    (startAt) => route`/rest/api/3/field/search?type=system&startAt=${startAt}&maxResults=${DEFAULT_PAGE_SIZE}&orderBy=name`
  );
}

export async function getFieldProjectAssociations(fieldId) {
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
export async function getProjectBreakdownByAssociation(fieldId, startAt = 0, maxProjects = 20) {
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

export async function getProjectBreakdownByIssueScan(fieldId, nextPageToken = null, maxPages = PROJECT_USAGE_SCAN_PAGES_PER_JOB) {
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

const ISSUE_COUNT_TIMEOUT_MS = 8000;

export async function getFieldConfiguredProjectCount(fieldId) {
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

export async function getFieldTotalIssueCount(fieldId) {
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

export async function getDistinctIssueCountForFields(fieldIds) {
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

export async function getProjectById(projectId) {
  const project = await jiraRequest(route`/rest/api/3/project/${projectId}`);
  return {
    id: String(project.id || projectId),
    key: project.key || String(projectId),
    name: project.name || project.key || String(projectId),
  };
}

export async function getFieldContexts(fieldId) {
  return paginate(
    (startAt) => route`/rest/api/3/field/${fieldId}/context?startAt=${startAt}&maxResults=${DEFAULT_PAGE_SIZE}`,
    "values"
  );
}

export async function getFieldContextProjectMappings(fieldId) {
  return paginate(
    (startAt) => route`/rest/api/3/field/${fieldId}/context/projectmapping?startAt=${startAt}&maxResults=${DEFAULT_PAGE_SIZE}`,
    "values"
  );
}

export async function getFieldContextIssueTypeMappings(fieldId) {
  return paginate(
    (startAt) => route`/rest/api/3/field/${fieldId}/context/issuetypemapping?startAt=${startAt}&maxResults=${DEFAULT_PAGE_SIZE}`,
    "values"
  );
}

export async function loadFieldContexts(fieldId) {
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

export async function searchProjectFieldUsage(fieldId, projectKey) {
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

export async function collectRecentFieldProjectCandidates(hours = 24, maxIssues = 500) {
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

export async function getLiveFieldProjectUsage(fieldId, usagePage, usagePageSize) {
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

export async function getAllJiraProjects() {
  return paginate(
    (startAt) => route`/rest/api/3/project/search?maxResults=50&startAt=${startAt}`
  );
}

// GET /rest/api/3/status returns a flat array, not the usual {values, isLast} wrapper.
export async function getAllStatuses() {
  const data = await jiraRequest(route`/rest/api/3/status`);
  return Array.isArray(data) ? data : [];
}

export async function getAllWorkflowsWithStatuses() {
  return paginate(
    (startAt) => route`/rest/api/3/workflow/search?expand=statuses&startAt=${startAt}&maxResults=${DEFAULT_PAGE_SIZE}`
  );
}

export async function getWorkflowSchemeForProject(projectId) {
  return jiraRequest(route`/rest/api/3/workflowscheme/project?projectId=${projectId}`);
}

// One call per project (no confirmed bulk form for scheme<->project association at
// implementation time — see plan). Concurrency-limited like other per-project fetches.
export async function getWorkflowSchemesForProjects(projectIds, concurrency = 8) {
  return mapWithConcurrency(projectIds, concurrency, async (projectId) => {
    try {
      const data = await getWorkflowSchemeForProject(projectId);
      return { projectId, scheme: data?.workflowScheme || data || null, error: null };
    } catch (error) {
      return { projectId, scheme: null, error: String(error?.message || error) };
    }
  });
}

export async function getAllJiraProjectKeys() {
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

export async function findFieldIdsByOptionValue(fields, optionQuery, startIndex = 0, maxFields = 10) {
  const normalizedQuery = String(optionQuery || "").trim().toLowerCase();
  if (!normalizedQuery) return { matchingIds: null, nextIndex: 0, done: true, scanned: 0, totalCandidates: 0 };

  const selectFields = fields.filter((field) => isSelectFieldType(field.type));
  const offset = Math.max(0, Math.min(selectFields.length, Number(startIndex) || 0));
  const limit = Math.max(1, Math.min(25, Number(maxFields) || 10));
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

export async function loadFieldOptionsFromJira(fieldId) {
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
