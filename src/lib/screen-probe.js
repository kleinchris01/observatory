// Measures what a full screen inventory pass would cost, without performing one.
//
// The screen chain's last hop is fields-on-a-tab, and that is a Jira call per TAB, not per
// screen. So the cost of the whole pipeline turns on a number nobody knows in advance: how
// many tabs the average screen has, and how bad the tail is. A site of 500 single-tab
// screens and a site of 500 four-tab screens differ by 1,500 calls for the same screen
// count, and only one of them fits a queue invocation.
//
// Rather than guess, this samples. The screen list itself is cheap and exact -- one call
// per 100 screens -- so the denominator is measured, not estimated. Only the per-tab cost
// is sampled, then extrapolated with its own tail reported alongside the mean.
//
// Deliberately a probe and not the first half of the real fetcher: if it walked every
// screen it would have done the expensive thing it exists to avoid committing to.

import { logger } from "./logger.js";
import {
  getAllScreens,
  getScreenTabs,
  getScreenTabFields,
  getScanTelemetry,
  mapWithConcurrency,
  probeEndpoint,
} from "./jira-api.js";

// Which endpoint answers, and which does not.
//
// Added after the first live run returned 401 "scope does not match" on a site whose
// install was already upgraded to the version carrying the scopes -- so the obvious
// explanation was wrong, and reasoning about which scope covers which endpoint produced
// three plausible theories and no answer.
//
// This is the same move that settled the automation-rule question: ask each endpoint
// directly and report exactly what came back, rather than arguing about it. Every scope
// name is confirmed present in Atlassian's registry, so the question is not whether they
// exist but which of these three reads each one actually authorizes.
export async function probeScreenEndpoints() {
  const candidates = [
    { label: "screens", scope: "read:screen:jira", path: "/rest/api/3/screens?maxResults=1" },
    // Tabs and fields need a real screen id, which is only available if the first call
    // works. Probed anyway with id 1: a 404 is a materially different answer from a 401,
    // because it proves the scope was accepted and only the id was wrong.
    { label: "screen tabs", scope: "read:screen-tab:jira", path: "/rest/api/3/screens/1/tabs" },
    { label: "tab fields", scope: "read:screen-field:jira", path: "/rest/api/3/screens/1/tabs/1/fields" },
    { label: "screen schemes", scope: "read:screen-scheme:jira", path: "/rest/api/3/screenscheme?maxResults=1" },
    { label: "issue type screen schemes", scope: "read:issue-type-screen-scheme:jira", path: "/rest/api/3/issuetypescreenscheme?maxResults=1" },
  ];

  const results = [];
  for (const candidate of candidates) {
    const probe = await probeEndpoint(candidate.path);
    results.push({
      ...candidate,
      status: probe.status,
      ok: probe.ok,
      // A 404 means the scope was accepted and the id was not found -- which for the tab
      // and field probes is a PASS, not a failure. Distinguishing the two is the whole
      // point of probing with a deliberately invalid id.
      scopeAccepted: probe.status !== 401 && probe.status !== 403,
      sample: probe.sample,
    });
  }

  return results;
}

// Enough screens to see a tail without the probe itself becoming the cost it is measuring.
// At 4 tabs a screen this is ~125 calls, comfortably inside one invocation.
export const DEFAULT_SAMPLE_SIZE = 25;

// Matches the consumer's timeoutSeconds in manifest.yml. The question the probe exists to
// answer is whether a full pass fits inside one of these.
export const CONSUMER_BUDGET_MS = 900 * 1000;

// Leave headroom rather than judging against the raw ceiling: a pass that needs 880s of a
// 900s budget does not fit in any useful sense, because the promotion write and any
// retry has to happen inside it too.
export const SAFE_BUDGET_FRACTION = 0.7;

function percentile(sortedValues, fraction) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * fraction));
  return sortedValues[index];
}

// Random sample, not the first N.
//
// Screens come back in roughly creation order, and the oldest screens on a site are
// systematically different from the newest -- more tabs, more accumulated fields, more
// likely to be the sprawling default everything was cloned from. Taking the head would
// measure the wrong end of the distribution and would do it consistently.
export function sampleScreens(screens, sampleSize, random = Math.random) {
  if (screens.length <= sampleSize) return [...screens];
  const pool = [...screens];
  const picked = [];
  for (let i = 0; i < sampleSize; i++) {
    const index = Math.floor(random() * pool.length);
    picked.push(pool.splice(index, 1)[0]);
  }
  return picked;
}

// Turn a sample into a projection for the whole catalog.
//
// Pure and exported so the arithmetic is testable without standing up Jira. Every figure
// it returns is either measured or explicitly labelled as extrapolated -- the caller
// should never have to guess which is which.
export function projectFullPassCost({
  totalScreens,
  screenListCalls,
  tabCounts,
  measuredCalls,
  measuredMs,
}) {
  const sampled = tabCounts.length;
  const sorted = [...tabCounts].sort((a, b) => a - b);
  const totalTabs = tabCounts.reduce((sum, n) => sum + n, 0);
  const meanTabs = sampled ? totalTabs / sampled : 0;

  // One tabs call plus one fields call per tab, for every screen on the site.
  const projectedCalls = screenListCalls + Math.round(totalScreens * (1 + meanTabs));

  // Per-call cost from the sample, including whatever the limiter added. Using observed
  // wall time rather than a nominal interval is the point: the adaptive limiter widens
  // under pressure, and a projection built on the base interval would be optimistic
  // exactly when it matters.
  const msPerCall = measuredCalls ? measuredMs / measuredCalls : 0;
  const projectedMs = Math.round(projectedCalls * msPerCall);

  const budget = CONSUMER_BUDGET_MS * SAFE_BUDGET_FRACTION;

  return {
    sampledScreens: sampled,
    meanTabsPerScreen: Number(meanTabs.toFixed(2)),
    medianTabsPerScreen: percentile(sorted, 0.5),
    // The tail is the number that decides whether batching is needed. A mean of 2.1 with a
    // max of 19 is a different engineering problem from a flat 2.1 everywhere.
    p90TabsPerScreen: percentile(sorted, 0.9),
    maxTabsPerScreen: sorted.length ? sorted[sorted.length - 1] : 0,
    msPerCall: Math.round(msPerCall),
    projectedCalls,
    projectedMs,
    projectedMinutes: Number((projectedMs / 60000).toFixed(1)),
    fitsOneInvocation: projectedMs > 0 && projectedMs <= budget,
    budgetMs: Math.round(budget),
  };
}

// Runs the sampled measurement. Never throws for a per-screen failure -- a screen whose
// tabs cannot be read is counted as a failure and excluded from the distribution, because
// folding it in as zero tabs would understate the very cost being measured.
export async function measureScreenFetchCost({ sampleSize = DEFAULT_SAMPLE_SIZE } = {}) {
  const before = getScanTelemetry();
  const startedAt = Date.now();

  const screens = await getAllScreens();
  const screenListCalls = Math.max(1, Math.ceil(screens.length / 100));

  if (!screens.length) {
    return {
      ok: true,
      totalScreens: 0,
      screenListCalls,
      note: "No screens returned. Either the site has none, or the scopes are not yet granted on this installation.",
      elapsedMs: Date.now() - startedAt,
    };
  }

  const sample = sampleScreens(screens, sampleSize);
  let measuredCalls = screenListCalls;
  const tabCounts = [];
  const failures = [];
  let totalFields = 0;

  const sampleStartedAt = Date.now();

  // Concurrency 4 to match the app's own limiter rather than racing it. Measuring at a
  // concurrency the real pipeline would not use produces a per-call figure the real
  // pipeline will not see.
  await mapWithConcurrency(sample, 4, async (screen) => {
    const screenId = String(screen.id);
    try {
      const tabs = await getScreenTabs(screenId);
      measuredCalls += 1;
      tabCounts.push(tabs.length);

      for (const tab of tabs) {
        try {
          const fields = await getScreenTabFields(screenId, String(tab.id));
          measuredCalls += 1;
          totalFields += fields.length;
        } catch (error) {
          measuredCalls += 1;
          failures.push({ screenId, tabId: String(tab.id), error: String(error?.message || error) });
        }
      }
    } catch (error) {
      measuredCalls += 1;
      failures.push({ screenId, tabId: null, error: String(error?.message || error) });
    }
  });

  const sampleMs = Date.now() - sampleStartedAt;
  const after = getScanTelemetry();

  const projection = projectFullPassCost({
    totalScreens: screens.length,
    screenListCalls,
    tabCounts,
    measuredCalls: measuredCalls - screenListCalls,
    measuredMs: sampleMs,
  });

  const result = {
    ok: true,
    totalScreens: screens.length,
    screenListCalls,
    requestedSampleSize: sampleSize,
    measuredCalls,
    elapsedMs: Date.now() - startedAt,
    meanFieldsPerScreen: tabCounts.length ? Number((totalFields / tabCounts.length).toFixed(1)) : 0,
    // Rate-limit pressure attributable to this probe specifically, by difference. The
    // counters are process-global, so an absolute reading would include whatever else ran.
    rateLimit: {
      hit429: after.rl429Count - before.rl429Count,
      retries: after.rlRetryCount - before.rlRetryCount,
    },
    failures: failures.slice(0, 10),
    failureCount: failures.length,
    ...projection,
  };

  logger.info("screen-probe.measured", {
    totalScreens: result.totalScreens,
    meanTabs: result.meanTabsPerScreen,
    maxTabs: result.maxTabsPerScreen,
    projectedCalls: result.projectedCalls,
    projectedMinutes: result.projectedMinutes,
    fitsOneInvocation: result.fitsOneInvocation,
  });

  return result;
}
