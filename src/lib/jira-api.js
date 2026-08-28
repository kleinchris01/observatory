import api, { route, createRequestStargateAsApp } from "@forge/api";
import { fallbackOn } from "./logger.js";
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
export const SNAPSHOT_CONCURRENCY = 4;
export const SNAPSHOT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
export const SNAPSHOT_PROGRESS_FLUSH_INTERVAL_MS = 15000;
export const SNAPSHOT_DB_BATCH_SIZE = 25;
export const FIELD_SUMMARY_QUEUE_STALE_AFTER_MS = 60 * 1000;
export const FIELD_SUMMARY_BUILD_STALE_AFTER_MS = 5 * 60 * 1000;
export const ISSUE_SCAN_PAGE_SIZE = 100;      // Jira Cloud cursor-based search caps maxResults at 100
export const ISSUE_SCAN_WORKERS = 5;          // parallel Forge workers; keep low because each invocation has its own in-memory limiter
// Independent JQL slices crawled concurrently WITHIN one worker invocation.
//
// Pagination is sequential -- page N+1 needs page N's cursor -- so a worker crawling a single
// JQL keeps exactly one request in flight while BASE_JIRA_CONCURRENCY permits four. That is
// the whole reason a measured run sat at ~6.9s/page and ~64 issues/sec: five workers against
// a budget sized for twenty.
//
// Three rather than four, deliberately. It leaves a slot for the retry of a slice that 429s
// instead of putting every slot into steady-state traffic, and each concurrent slice holds its
// own page of issues plus accumulated buffers, so this multiplies invocation memory as well as
// throughput. Raise it only with the 429 telemetry from a real run in hand -- getScanTelemetry()
// reports rl429Count, and that is the number that says whether there is headroom.
export const ISSUE_SCAN_SLICES_PER_WORKER = 3;
// Fixed pause between pages per worker. Predates the adaptive limiter, which now handles
// Jira pressure reactively (widening the request interval on 429s, easing back on success
// streaks) -- so this is a static tax on top of a system that already self-regulates.
//
// Sized against a measured 325k-issue run: ~6.9s per page per worker, so 500ms was ~7% of
// scan wall-clock, and Forge bills GB-seconds of wall-clock including time spent asleep.
// 200ms keeps a politeness margin while returning most of that. If a site starts seeing
// sustained 429s the limiter absorbs it and recovers on its own; this constant is not the
// mechanism that protects Jira, it just makes the scan slower and more expensive.
export const ISSUE_SCAN_INTER_PAGE_DELAY_MS = 200;
// WAS queries hit Jira's issue-history index and are markedly slower than a plain status
// filter. This is pinned to the hard request deadline rather than above it: an outer
// budget larger than JIRA_REQUEST_HARD_TIMEOUT_MS can never fire, because the inner
// deadline wins first. A 15s value here looked generous and was simply dead code -- the
// real ceiling was always 12s, which is what the logs reported.
export const STATUS_HISTORY_TIMEOUT_MS = JIRA_REQUEST_HARD_TIMEOUT_MS;

// Lower than the 8 used for per-project counts. On a real site, 163 of 433 status history
// queries timed out while a 5-worker universe scan was saturating the same rate limiter --
// these are the slowest queries the app issues, and racing them against each other makes
// every one of them slower.
export const STATUS_HISTORY_CONCURRENCY = 4;
// Flush field counts + checkpoint the worker every N pages. Set to match
// ISSUE_SCAN_CHUNK_PAGES so the mid-loop flush never fires and each invocation flushes
// exactly once, at the end of its chunk.
//
// This was 3 (a flush every 300 issues/worker), which on a 325k-issue site produced
// ~1,080 flush cycles per scan, each costing several SQL requests -- SQL request count,
// not compute or storage, is the quota that binds first. The invocation boundary is
// already the durable checkpoint (the worker re-enqueues with nextPageToken), so
// flushing more often than that bought finer resume granularity and nothing else: the
// cost of losing a chunk is re-scanning up to 1,000 issues, ~14 seconds of work.
//
// Fewer flushes also means fewer windows in which an invocation can die between the
// count flush and the token checkpoint -- the one ordering that can double-count, since
// the buffer upsert is additive.
export const ISSUE_SCAN_FLUSH_EVERY_PAGES = 10;

// Cancellation is checked at invocation entry (runIssueScanWorkerV2 reads scan meta and
// bails unless state is "building"), so this is a second line of defence within a single
// ~70s chunk. Kept on its own cadence rather than riding the flush cycle: a cancel check
// is one cheap read, a flush is many writes, and they have no reason to share a rhythm.
export const ISSUE_SCAN_CANCEL_CHECK_EVERY_PAGES = 5;

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
  screenSnapshotStarted: "screen-snapshot-started",
  screenSnapshotCompleted: "screen-snapshot-completed",
  screenSnapshotFailed: "screen-snapshot-failed",
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
  // Deliberately silent, and the one place in this file that should be. The caller
  // still holds this promise and will surface its rejection; this attachment exists
  // only so an abandoned copy does not trip an unhandled-rejection warning. Logging
  // here would double-report every timeout.
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

// Does the CALLING user hold the Jira ADMINISTER global permission?
//
// Deliberately asUser, not asApp: asApp would report the app's own permissions, which
// are constant, and answer a question nobody asked. This must reflect the human whose
// click reached the resolver.
//
// Fails closed. Unlike macro access -- which fails open so an unrelated Jira API blip
// cannot black out a read-only Confluence page -- everything gated by this check mutates
// state or exposes governance internals, so an unanswerable question is a "no".
export async function callerHasJiraAdmin(accountId) {
  if (!accountId) return false;
  try {
    const data = await jiraRequestAsUser(route`/rest/api/3/permissions/check`, {
      method: "POST",
      body: JSON.stringify({
        accountId,
        globalPermissions: ["ADMINISTER"],
      }),
    });
    const granted = data?.globalPermissions;
    return Array.isArray(granted) && granted.includes("ADMINISTER");
  } catch (error) {
    console.error("callerHasJiraAdmin: permission check failed", error?.message || error);
    return false;
  }
}

export async function paginate(pathBuilder, valuesKey = "values", { onPage } = {}) {
  const results = [];
  let startAt = 0;
  while (true) {
    const data = await jiraRequest(pathBuilder(startAt));
    const values = data?.[valuesKey] || [];
    results.push(...values);
    const total = data?.total ?? values.length;
    const nextStart = startAt + values.length;
    // Called after each page so a long walk can report progress or stop itself. Awaited and
    // deliberately not caught: a caller that throws here -- an exhausted time budget -- means
    // to abort the walk, and swallowing that would defeat the point.
    if (onPage) await onPage({ fetched: results.length, total, startAt });
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
    // -1 signals "count unavailable" (timeout or error) — matches getFieldTotalIssueCount's
    // convention. Must NOT be 0: a real 0 means "no projects configured", while a timeout
    // means "we don't know", and callers need to tell those apart.
    return -1;
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
    getFieldContextProjectMappings(fieldId).catch(fallbackOn("jira.context_project_mappings_failed", () => [], { fieldId })),
    getFieldContextIssueTypeMappings(fieldId).catch(fallbackOn("jira.context_issuetype_mappings_failed", () => [], { fieldId })),
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

// ----- Screens -----
//
// The three reads at the bottom of the screen chain. Fields-per-tab is the expensive one:
// it is a call per TAB, not per screen, so its cost scales with a number nobody knows until
// it is measured. That is what screen-probe.js exists to find out before the full pipeline
// is built on an assumption about it.

// Every saved filter on the site, with the governance-relevant expansions.
//
// /rest/api/3/filter/search is the only endpoint that enumerates filters; /rest/api/3/filter
// alone returns just the caller's favourites, which is a personal list rather than a site
// inventory. Requires read:filter:jira -- the one new scope this pillar adds.
//
// `expand` is where the whole pillar lives. Without it the response carries an id and a name
// and nothing worth governing; with it, each filter brings its JQL, its owner (including
// whether that account is still active), its share permissions and its subscriptions.
//
// approximateLastUsed is requested but treated as optional: it is the newest field here and
// the one most likely to be absent on a given tenant, and "we could not tell when this was
// last opened" must never render as "never opened".
//
// It was documented as requested here without actually being in the list below -- every
// filter on every tenant came back with no lastUsedAt, which downstream code then read as
// "never opened" rather than "unknown," and a saved-filter estate of any size rendered as
// 100% stale. The field itself was never wrong; it was never asked for.
const FILTER_EXPAND = "description,owner,jql,sharePermissions,subscriptions,viewUrl,favouritedCount,approximateLastUsed";

// Every dashboard on the site, with the governance-relevant expansions.
//
// /rest/api/3/dashboard/search is the site-wide enumerator, the same way filter/search is --
// /rest/api/3/dashboard returns the caller's own, which is a personal list. Requires
// read:dashboard:jira.
//
// `popularity` is the count of people who have favourited it, and it is the closest thing
// Jira gives to "is anyone using this". It is not a view count: a dashboard somebody checks
// daily without favouriting reads as zero, so it bounds a claim about NEGLECT rather than
// proving one.
//
// NOT viewUrl. filter/search accepts it and this list was modelled on FILTER_EXPAND, but
// dashboard/search does not -- `expand=viewUrl` there is a hard 400 Bad Request, which is
// why the dashboard stage of every scan was failing on its first request. The search
// response already carries `view` unconditionally, and shapeDashboard reads that.
const DASHBOARD_EXPAND = "description,owner,favouritedCount,sharePermissions,editPermissions";

// One page of dashboards. Exposed alongside the full walk for the same reason as
// getFilterPage: the dashboard build is resumable and drives its own pagination.
export async function getDashboardPage(startAt = 0, maxResults = 50) {
  return jiraRequest(
    route`/rest/api/3/dashboard/search?maxResults=${maxResults}&startAt=${startAt}&expand=${DASHBOARD_EXPAND}`
  );
}

// What a gadget is configured to show.
//
// Two calls, because Jira models gadget config as arbitrary item properties: one to list the
// keys, one to read a value. There is no bulk form and no way to ask for "the filter this
// gadget uses" directly.
//
// Returns the referenced filter id, or null. Only the keys that actually carry one are read --
// a gadget can have half a dozen properties recording column widths and refresh intervals,
// and fetching those would double the cost of the walk for nothing.
export async function getGadgetFilterId(dashboardId, gadgetId) {
  const keyList = await jiraRequest(
    route`/rest/api/3/dashboard/${dashboardId}/items/${gadgetId}/properties`
  );
  const keys = (keyList?.keys || []).map((k) => k?.key).filter(Boolean);

  // "config" is where the standard Jira gadgets keep it. The others are what the common
  // first-party gadgets have been observed to use.
  const candidates = keys.filter((k) => /^(config|filter|filterId|savedFilter)$/i.test(k));

  for (const key of candidates) {
    const prop = await jiraRequest(
      route`/rest/api/3/dashboard/${dashboardId}/items/${gadgetId}/properties/${key}`
    );
    const id = extractFilterId(prop?.value);
    if (id) return id;
  }
  return null;
}

// A filter id out of a gadget config blob.
//
// Jira gadgets record this inconsistently: some store a bare id, some an object with
// `filterId`, some a string like "filter-10123" or a full JQL-search URL. Exported so the
// shapes can be tested without a Jira, because a parser that silently returns null for a shape
// nobody anticipated produces a dependency graph with quiet holes in it.
export function extractFilterId(value) {
  if (value == null) return null;
  if (typeof value === "number") return String(value);

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return trimmed;
    const tagged = trimmed.match(/(?:filter[-_]?|filterId=|requestId=)(\d+)/i);
    return tagged ? tagged[1] : null;
  }

  if (typeof value === "object") {
    // "config" is a container rather than a value: several gadgets nest the real config one
    // level down under it, and a walker that only looked at value-shaped keys returned null
    // for those -- a quiet hole in the dependency graph rather than a visible failure.
    for (const key of ["filterId", "filter", "id", "savedFilterId", "requestId", "config"]) {
      const nested = extractFilterId(value[key]);
      if (nested) return nested;
    }
  }
  return null;
}

export async function getAllDashboards() {
  return paginate((startAt) =>
    route`/rest/api/3/dashboard/search?maxResults=50&startAt=${startAt}&expand=${DASHBOARD_EXPAND}`);
}

// The gadgets on one dashboard.
//
// A flat { gadgets: [...] } payload rather than the paginated wrapper, like /status. One call
// per dashboard, which is why the engine walks these with a concurrency limit rather than
// firing them all at once.
//
// What this does NOT return is a gadget's configuration -- which filter a Filter Results
// gadget points at lives in dashboard item properties, two further calls per gadget. That is
// the field -> filter -> dashboard chain, and it is deliberately not attempted here; see
// dashboard-engine.js.
export async function getDashboardGadgets(dashboardId) {
  const data = await jiraRequest(route`/rest/api/3/dashboard/${dashboardId}/gadget`);
  return Array.isArray(data?.gadgets) ? data.gadgets : [];
}

// One page of filters.
//
// Exposed as a single page rather than only as a full walk, because the filter build is
// resumable: it fetches a bounded number of pages per invocation and checkpoints between them,
// so it needs to drive the pagination itself rather than hand it to paginate() and hope the
// whole estate arrives before the invocation is killed.
export async function getFilterPage(startAt = 0, maxResults = 50) {
  return jiraRequest(
    route`/rest/api/3/filter/search?maxResults=${maxResults}&startAt=${startAt}&expand=${FILTER_EXPAND}&overrideSharePermissions=false`
  );
}

export async function getAllFilters({ onPage } = {}) {
  return paginate((startAt) =>
    route`/rest/api/3/filter/search?maxResults=50&startAt=${startAt}&expand=${FILTER_EXPAND}&overrideSharePermissions=false`,
  "values", { onPage });
}

export async function getAllScreens() {
  return paginate((startAt) => route`/rest/api/3/screens?maxResults=100&startAt=${startAt}`);
}

// Flat array, like /status -- no {values, isLast} wrapper.
export async function getScreenTabs(screenId) {
  const data = await jiraRequest(route`/rest/api/3/screens/${screenId}/tabs`);
  return Array.isArray(data) ? data : [];
}

export async function getScreenTabFields(screenId, tabId) {
  const data = await jiraRequest(route`/rest/api/3/screens/${screenId}/tabs/${tabId}/fields`);
  return Array.isArray(data) ? data : [];
}

// Screen schemes, which carry screen ids in their payload.
//
// Added for the screen probe rather than for the pipeline, and the reason is worth keeping:
// /rest/api/3/screens returns 401 "scope does not match" on this install while
// /rest/api/3/screenscheme returns 200. So the endpoint that enumerates screens is the one
// that cannot supply a screen id, and this is the one that can -- each scheme names the
// screens it maps to under `screens: { default, create, edit, view }`.
//
// That also makes it a candidate route for the real inventory if the screen list stays
// closed: walking issue type screen scheme -> screen scheme -> screen reaches every screen a
// project can actually use, which is the population the pillar cares about. It would not
// reach orphaned screens, which is a finding in its own right and would be the casualty.
export async function getScreenSchemes({ maxResults = 100 } = {}) {
  return jiraRequest(route`/rest/api/3/screenscheme?maxResults=${maxResults}`);
}

// The two upper hops of the chain: screen scheme -> screen, and issue type screen scheme
// -> screen scheme -> project. Both paginate, both answer under scopes this install
// demonstrably has (200 on the live probe), and neither is expensive -- schemes are tens
// of rows where screens are hundreds.

// Each scheme names the screen serving each operation under `screens`. An operation absent
// from that object inherits `default`, and the DIFFERENCE matters: an admin reading the
// inventory needs to know which screen was chosen for edit and which merely fell through.
// So the raw object is returned intact and the inheritance is resolved at build time, not
// flattened away here.
export async function getAllScreenSchemes() {
  return paginate((startAt) => route`/rest/api/3/screenscheme?maxResults=100&startAt=${startAt}`);
}

export async function getAllIssueTypeScreenSchemes() {
  return paginate((startAt) => route`/rest/api/3/issuetypescreenscheme?maxResults=100&startAt=${startAt}`);
}

// Issue type -> screen scheme, per issue type screen scheme.
//
// Jira reports the catch-all entry with issueTypeId "default" rather than omitting it, and
// that row is load-bearing: on most sites it is the only mapping a project has, so treating
// it as noise would resolve the majority of projects to an empty screen set.
export async function getIssueTypeScreenSchemeMappings() {
  return paginate((startAt) => route`/rest/api/3/issuetypescreenscheme/mapping?maxResults=100&startAt=${startAt}`);
}

// ITSS -> projects. Returns { issueTypeScreenScheme: {id, name}, projectIds: [] } per row.
// Batch size for the repeated projectId parameter. Kept well under any URL length limit --
// 50 numeric ids is a few hundred characters, where a 142-project site in one call is fine
// and a 1,000-project one would not be.
export const ITSS_PROJECT_QUERY_BATCH = 50;

// ITSS -> projects. Returns { issueTypeScreenScheme: {id, name}, projectIds: [] } per row.
//
// projectId is REQUIRED and repeatable: this endpoint answers "which scheme governs these
// projects", not "list every association". Called bare it returns
// 400 "At least one projectId has to be provided" -- which is exactly what the first live
// build did, and the reason this takes an argument rather than none.
//
// The path is assembled as a plain string rather than through route's tagged form because
// the repeated parameter cannot be expressed as a single interpolation. Ids are encoded
// here since that bypasses route's own escaping.
export async function getIssueTypeScreenSchemeProjects(projectIds = []) {
  const ids = [...new Set((projectIds || []).map((id) => String(id).trim()).filter(Boolean))];
  if (!ids.length) return [];

  const rows = [];
  for (let i = 0; i < ids.length; i += ITSS_PROJECT_QUERY_BATCH) {
    const query = ids
      .slice(i, i + ITSS_PROJECT_QUERY_BATCH)
      .map((id) => `projectId=${encodeURIComponent(id)}`)
      .join("&");

    const page = await paginate((startAt) =>
      route([`/rest/api/3/issuetypescreenscheme/project?maxResults=100&startAt=${Number(startAt) || 0}&${query}`])
    );
    rows.push(...page);
  }
  return rows;
}

// GET /rest/api/3/status returns a flat array, not the usual {values, isLast} wrapper.
export async function getAllStatuses() {
  const data = await jiraRequest(route`/rest/api/3/status`);
  return Array.isArray(data) ? data : [];
}

// Normalize a workflow-search response into [{ name, statusIds }].
//
// Exported and shape-agnostic on purpose: Jira has two generations of this endpoint and
// they disagree about where statuses live.
//
//   Deprecated GET /rest/api/3/workflow/search  ->  values[].statuses[].id
//   Current  POST /rest/api/3/workflows/search  ->  workflows[].statuses[].statusReference,
//                                                   plus a top-level statuses[] mapping
//                                                   each reference to a real status id.
//
// A statusReference is a UUID, NOT a status id, so resolving it through that lookup is
// mandatory -- matching references straight against the status catalog silently yields
// zero overlap, which is indistinguishable from "this scheme has no statuses".
export function normalizeWorkflowSearchResponse(data) {
  const idByReference = new Map();
  for (const status of data?.statuses || []) {
    const reference = status?.statusReference || status?.id;
    if (reference && status?.id) idByReference.set(String(reference), String(status.id));
  }

  const workflows = data?.workflows || data?.values || [];
  return workflows.map((workflow) => {
    const name = workflow?.name || workflow?.id?.name || null;
    const statusIds = [];
    for (const entry of workflow?.statuses || []) {
      const direct = entry?.id ?? entry?.statusId;
      const reference = entry?.statusReference;
      const resolved = direct != null ? String(direct) : (reference ? idByReference.get(String(reference)) : null);
      if (resolved) statusIds.push(resolved);
    }
    return { name, statusIds, transitions: extractTransitionScreens(workflow) };
  }).filter((workflow) => workflow.name);
}

// Transitions that open a screen, and which screen that is.
//
// This is the second way a screen reaches a user, and until now the only one Observatory
// looked at was the scheme chain. A screen attached to a transition is in daily use without
// appearing in any screen scheme -- which made "no scheme routes to this screen" read as
// "nobody can reach this screen", and that is the premise for deleting it.
//
// Shape-agnostic for the same reason the status extraction is: the two endpoint generations
// disagree about where the screen lives on a transition.
//
//   Deprecated GET /rest/api/3/workflow/search   ->  transitions[].screen.id
//   Current    POST /rest/api/3/workflows/search ->  transitions[].transitionScreen.id,
//                                                    sometimes .screen.id
//
// A transition with no screen is normal and common -- most transitions just move the issue --
// so those are dropped rather than recorded with a null screen.
export function extractTransitionScreens(workflow) {
  const out = [];
  for (const transition of workflow?.transitions || []) {
    const screen = transition?.transitionScreen ?? transition?.screen ?? null;
    const screenId = screen?.id ?? screen?.screenId ?? (typeof screen === "string" || typeof screen === "number" ? screen : null);
    if (screenId == null || screenId === "") continue;
    out.push({
      id: transition?.id != null ? String(transition.id) : null,
      name: transition?.name || null,
      // "from -> to" is what makes a transition recognisable in Jira's own UI; the name
      // alone is frequently just "Done" on a dozen different transitions.
      toStatus: transition?.to?.statusReference ?? transition?.to?.id ?? transition?.to ?? null,
      screenId: String(screenId),
    });
  }
  return out;
}

// Every workflow on the site with the statuses it can reach.
//
// Tries the current endpoint first and falls back to the deprecated one. The fallback is
// not defensive programming for its own sake: the deprecated GET form returns 401
// "scope does not match" for an app declaring granular scopes, which is exactly how this
// failed on staging -- silently, leaving every status looking orphaned.
export async function getAllWorkflowsWithStatuses() {
  try {
    // expand=transitions alongside statuses. Asked for in the same call rather than a second
    // pass: the workflow list is the expensive part, and a site with 83 schemes has more
    // workflows than it has anything else worth paging twice.
    const data = await jiraRequest(route`/rest/api/3/workflows/search?expand=statuses,transitions`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const workflows = normalizeWorkflowSearchResponse(data);
    if (workflows.length > 0) return workflows;
    // A successful call returning nothing is worth saying out loud: it means the shape
    // changed again, not that the site has no workflows.
    console.warn("getAllWorkflowsWithStatuses: bulk endpoint returned no usable workflows; response keys:", Object.keys(data || {}));
  } catch (error) {
    console.warn("getAllWorkflowsWithStatuses: bulk endpoint failed, trying legacy:", error?.message || error);
  }

  const legacy = await paginate(
    (startAt) => route`/rest/api/3/workflow/search?expand=statuses,transitions&startAt=${startAt}&maxResults=${DEFAULT_PAGE_SIZE}`
  );
  return normalizeWorkflowSearchResponse({ values: legacy });
}

// Statuses reachable in one project, flattened across its issue types.
//
// This exists because BOTH workflow-search endpoints return 401 "scope does not match"
// on an installation that is fully upgraded and declares read:workflow:jira --
// /rest/api/3/workflow/search (deprecated) and /rest/api/3/workflows/search (current)
// alike. Consent is not the issue; `forge install --upgrade` reports the site already at
// the latest version.
//
// So the scheme -> status mapping is derived a different way. This endpoint needs only
// read:status:jira and read:project:jira, both of which demonstrably work on this
// install, and it answers a slightly better question: which statuses are actually
// reachable in this project, rather than which statuses a workflow defines.
//
// Response is an array of issue types, each carrying its own statuses:
//   [{ id, name, subtask, statuses: [{ id, name, statusCategory }] }]
export async function getProjectStatuses(projectIdOrKey) {
  const data = await jiraRequest(route`/rest/api/3/project/${projectIdOrKey}/statuses`);
  const ids = new Set();
  for (const issueType of Array.isArray(data) ? data : []) {
    for (const status of issueType?.statuses || []) {
      if (status?.id != null) ids.add(String(status.id));
    }
  }
  return [...ids];
}

// project id -> reachable status ids, for every project, at bounded concurrency.
//
// Per-project failures are collected rather than thrown: one project the app cannot read
// must not empty the whole mapping and make every status on the site look orphaned.
export async function getStatusesForProjects(projectIds = [], concurrency = 8) {
  const byProject = new Map();
  const failures = [];

  const results = await mapWithConcurrency(projectIds.map(String), concurrency, async (projectId) => {
    try {
      return { projectId, statusIds: await getProjectStatuses(projectId), error: null };
    } catch (error) {
      return { projectId, statusIds: null, error: String(error?.message || error) };
    }
  });

  for (const result of results) {
    if (result.error) failures.push({ projectId: result.projectId, error: result.error });
    else byProject.set(result.projectId, result.statusIds);
  }
  return { byProject, failures };
}

// How many issues have EVER been in each status, via JQL's WAS operator.
//
// This is the cheap answer to a question that otherwise needs a changelog crawl: on a
// 317k-issue site, re-reading every issue with expand=changelog is hours, while one
// approximate-count per status is a few hundred queries and minutes.
//
// Queried by status ID, never by name. A site with "Done" defined five times would give
// `status WAS "Done"` one meaningless number covering all of them; `status WAS 10001` is
// unambiguous.
//
// Returns Map<statusId, count> plus the failures, because a status whose count could not
// be measured must not be presented as zero -- zero is what makes a status look safe to
// delete.
export async function getEverInStatusCounts(statusIds = [], concurrency = STATUS_HISTORY_CONCURRENCY) {
  const counts = new Map();
  const failures = [];
  const ids = [...new Set(statusIds.filter((id) => id !== null && id !== undefined && id !== "").map(String))];

  const results = await mapWithConcurrency(ids, concurrency, async (statusId) => {
    try {
      const data = await withTimeout(
        jiraRequest(route`/rest/api/3/search/approximate-count`, {
          method: "POST",
          // Numeric id, unquoted: quoting makes Jira resolve it as a name.
          body: JSON.stringify({ jql: `status WAS ${statusId}` }),
        }),
        STATUS_HISTORY_TIMEOUT_MS
      );
      return { statusId, count: Number(data?.count ?? 0), error: null };
    } catch (error) {
      return { statusId, count: null, error: String(error?.message || error) };
    }
  });

  const probe = async (statusId) => {
    try {
      const data = await withTimeout(
        jiraRequest(route`/rest/api/3/search/approximate-count`, {
          method: "POST",
          body: JSON.stringify({ jql: `status WAS ${statusId}` }),
        }),
        STATUS_HISTORY_TIMEOUT_MS
      );
      return { statusId, count: Number(data?.count ?? 0), error: null };
    } catch (error) {
      return { statusId, count: null, error: String(error?.message || error) };
    }
  };

  for (const result of results) {
    if (result.error) failures.push({ statusId: result.statusId, error: result.error });
    else counts.set(result.statusId, result.count);
  }

  // One retry pass, serially, over the stragglers only. These failures are contention
  // rather than permanent errors -- the first pass ran alongside a universe scan -- so a
  // slow second attempt recovers most of them without doubling the cost of a clean run.
  if (failures.length > 0) {
    const stragglers = failures.splice(0, failures.length);
    for (const { statusId } of stragglers) {
      const retry = await probe(statusId);
      if (retry.error) failures.push({ statusId, error: retry.error });
      else counts.set(statusId, retry.count);
    }
  }

  return { counts, failures };
}

export async function getWorkflowSchemeForProject(projectId) {
  return jiraRequest(route`/rest/api/3/workflowscheme/project?projectId=${projectId}`);
}

// Pull the scheme out of the endpoint's container shape:
//   { values: [ { projectIds: [...], workflowScheme: {...} } ] }
//
// Returns null rather than guessing when the shape is unrecognized. The previous
// `data?.workflowScheme || data` fallback handed back the whole container, which has no
// id and no name -- so every project produced a distinct scheme named
// "(unnamed workflow scheme)" keyed `unknown-<projectId>`. A 142-project site rendered as
// 142 one-project schemes, and the "projects sharing a scheme" correlation could never
// fire. A null here is logged as a lookup failure and skipped, which is visible; a
// half-parsed object is not.
export function extractWorkflowScheme(data) {
  const entry = Array.isArray(data?.values) ? data.values[0] : null;
  const scheme = entry?.workflowScheme || data?.workflowScheme || null;
  return scheme && (scheme.id != null || scheme.name) ? scheme : null;
}

// One call per project (no confirmed bulk form for scheme<->project association at
// implementation time — see plan). Concurrency-limited like other per-project fetches.
export async function getWorkflowSchemesForProjects(projectIds, concurrency = 8) {
  return mapWithConcurrency(projectIds, concurrency, async (projectId) => {
    try {
      const data = await getWorkflowSchemeForProject(projectId);
      const scheme = extractWorkflowScheme(data);
      return {
        projectId,
        scheme,
        error: scheme ? null : "workflow scheme missing from response",
      };
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

// ── Endpoint probe ──────────────────────────────────────────────────────────
//
// Calls a candidate endpoint and reports exactly what came back, without throwing.
//
// This exists because three separate mysteries this week were only settled by making the
// system say what happened rather than reasoning about it: a 401 whose cause survived two
// wrong theories, a scan whose 400 is still unexplained, and an "Unknown SQL execution
// error" that turned out to be a placeholder in a LIMIT clause. Guessing at Atlassian's
// behaviour has a poor track record here; asking it directly does not.
//
// Read-only by construction: GET only, and the body is truncated because the point is the
// shape of the response, not its contents.
export async function probeEndpoint(path, { method = "GET" } = {}) {
  const started = Date.now();
  try {
    const response = await api.asApp().requestJira(route([path]), {
      method,
      headers: { Accept: "application/json" },
    });
    const text = await response.text();
    return {
      path,
      status: response.status,
      ok: response.ok,
      ms: Date.now() - started,
      // Enough to tell a rule list from an error envelope; not enough to leak issue data.
      sample: text.slice(0, 300),
    };
  } catch (error) {
    return {
      path,
      status: null,
      ok: false,
      ms: Date.now() - started,
      sample: String(error?.message || error).slice(0, 300),
    };
  }
}


// asUser() twin of probeEndpoint, for the one question probeEndpoint cannot answer.
//
// Every screen probe so far describes the APP's identity. Atlassian's own documentation is
// explicit that Jira permissions also control access to data and are not overridden by
// scopes, and the screen endpoints are Administer-Jira-gated -- so a call carrying the
// calling admin's permissions is a materially different request from the same call carrying
// the app's. Only an admin can reach the resolver that runs this, so the caller always holds
// the permission being tested.
//
// Same never-throws contract as probeEndpoint: a diagnostic that can fail the page it runs
// on is worse than no diagnostic.
export async function probeEndpointAsUser(path, { method = "GET" } = {}) {
  const started = Date.now();
  try {
    const response = await api.asUser().requestJira(route([path]), {
      method,
      headers: { Accept: "application/json" },
    });
    const text = await response.text();
    return {
      path,
      status: response.status,
      ok: response.ok,
      ms: Date.now() - started,
      sample: text.slice(0, 300),
    };
  } catch (error) {
    return {
      path,
      status: null,
      ok: false,
      ms: Date.now() - started,
      sample: String(error?.message || error).slice(0, 300),
    };
  }
}

// The cloud id, pulled out of the installation ARI.
//
// Forge's installContext looks like `ari:cloud:jira::site/<uuid>`, and that uuid IS the
// cloud id the api.atlassian.com gateway expects. Deriving it here avoids threading a
// second identifier through every caller.
export function getCloudId(context) {
  const key = String(context?.installContext || "");
  const match = /site\/([0-9a-f-]{36})/i.exec(key);
  return match ? match[1] : null;
}

// Probe an api.atlassian.com endpoint through Stargate.
//
// Distinct from probeEndpoint, which is site-relative. Every automation path probed
// earlier returned 401 because they were asked of the wrong server entirely: the
// automation API lives on the gateway host, not on the site. requestJira cannot reach it,
// so this uses the Stargate request surface instead.
export async function probeStargateEndpoint(path) {
  const started = Date.now();
  try {
    // A plain string, not a Route. createRequestStargateAsApp returns
    // `(url: string, init?) => Promise<Response>` -- wrapping the path in
    // assumeTrustedRoute produced INVALID_TARGET_URL before the request left the runtime.
    const requestStargate = createRequestStargateAsApp();
    const response = await requestStargate(path, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const text = await response.text();
    return {
      path,
      status: response.status,
      ok: response.ok,
      ms: Date.now() - started,
      sample: text.slice(0, 300),
    };
  } catch (error) {
    return {
      path,
      status: null,
      ok: false,
      ms: Date.now() - started,
      sample: String(error?.message || error).slice(0, 300),
    };
  }
}
