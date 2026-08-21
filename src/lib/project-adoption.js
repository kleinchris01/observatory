// How much a project is actually being used, and when that changed.
//
// Every project figure in this app was a lifetime total with nothing to divide it by, which
// systematically flatters old projects and buries new ones. A project spun up three weeks
// ago with 40 issues reads as abandoned next to one carrying 61,000 over eight years -- and
// on a per-day basis the new one may be growing twice as fast. "Is anyone using this" is a
// rate, and a rate needs an age.
//
// Three questions, kept separate because they have different answers and different fixes:
//
//   How much work happens here?      volume, against the site rather than in the abstract
//   Is that going up or down?        momentum, recent rate against its own lifetime rate
//   When did it change?              the peak, and the month the decline started
//
// Pure over already-loaded rows, like workflow-insights.js: no I/O, so the resolver decides
// what to load and this decides what it means.

// Jira Cloud does not expose a project creation date. There is no `created` on the project
// resource at any endpoint, so the anchor is the first issue ever created in the project.
//
// That is the better anchor for this question anyway: it is when work started rather than
// when an admin clicked Create. Where they differ -- a project made in January and first
// used in April -- the first issue is the one that makes a rate mean anything, because
// nobody was failing to adopt it during the three months it did not exist to them.
export const AGE_ANCHOR = "first-issue";

const DAY_MS = 24 * 60 * 60 * 1000;

// The window "recent" means. Ninety days is long enough that a quiet fortnight does not read
// as collapse, and short enough that a project which stopped six months ago is unmistakable.
export const RECENT_WINDOW_DAYS = 90;

// Below this a project has not had time to be judged. A project two weeks old with four
// issues is not under-adopted, it is new -- and reporting it as a finding is how a governance
// report teaches people to ignore it.
export const MIN_AGE_DAYS_TO_JUDGE = 90;

// A rate this far below its own lifetime rate is a project people have left rather than one
// having a slow quarter. Deliberately generous: seasonal work and release cycles move a
// project by half without anything being wrong.
export const FELL_OFF_MOMENTUM = 0.25;

function daysBetween(fromIso, toMs) {
  const from = Date.parse(fromIso || "");
  if (!Number.isFinite(from)) return null;
  // Floor at one day so a project whose first issue is today cannot divide by zero, and
  // reads as "one day old" rather than as infinitely productive.
  return Math.max(1, (toMs - from) / DAY_MS);
}

function monthKey(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

// Issues created inside the recent window, from the monthly histogram.
//
// Month granularity means the window is approximate at its trailing edge: a 90-day window
// covers three full months plus part of a fourth, and this counts whole months. Reported as
// `recentMonths` so a caller can say what was actually measured rather than implying a
// to-the-day figure the data cannot support.
function recentActivity(months, nowMs, windowDays) {
  const cutoff = monthKey(nowMs - windowDays * DAY_MS);
  const inWindow = months.filter((m) => m.month >= cutoff);
  if (!inWindow.length) return { issues: 0, months: 0, days: windowDays };

  // Divided by the days the counted months actually span, not by the nominal window.
  //
  // A 90-day cutoff selects whole months, and "months at or after the month 90 days ago" is
  // usually four of them -- around 120 days of issues. Dividing those by 90 inflated every
  // rate by a third, so a perfectly steady project reported 1.33x growth and a real decline
  // had to be severe before it showed. Momentum is a ratio of two rates, so a systematic
  // error in one of them is a systematic error in the finding.
  const windowStart = Date.parse(`${inWindow[0].month}-01T00:00:00.000Z`);
  const days = Number.isFinite(windowStart) ? Math.max(1, (nowMs - windowStart) / DAY_MS) : windowDays;

  return {
    issues: inWindow.reduce((sum, m) => sum + m.issueCount, 0),
    months: inWindow.length,
    days,
  };
}

// The month the decline began.
//
// Walked backwards from the peak rather than forwards from the start: a project that grew,
// peaked and fell has many months below its peak, and the one worth naming is the last month
// it was still near it. "Fell off in 2023-04" is actionable; "was below peak from 2019" is
// not.
//
// Returns null when there is no decline to name -- a project still at or near its peak, or
// one too short to have a shape.
function declineOnset(months, peakIndex, peakCount) {
  if (peakIndex < 0 || peakCount <= 0) return null;
  const floor = peakCount * 0.5;
  for (let i = peakIndex + 1; i < months.length; i++) {
    if (months[i].issueCount < floor) return months[i].month;
  }
  return null;
}

// One project's adoption, from its activity series and its totals.
//
// `now` is injected rather than read, because every rate here is relative to it and a test
// that cannot fix the clock can only assert that numbers exist.
export function computeProjectAdoption(project, activity, { now = Date.now(), recentWindowDays = RECENT_WINDOW_DAYS } = {}) {
  const months = (activity?.months ?? []).filter((m) => m && m.month);
  const firstIssueCreatedAt = activity?.firstIssueCreatedAt ?? null;
  const lastIssueCreatedAt = activity?.lastIssueCreatedAt ?? null;

  // No activity captured at all. Distinct from a project with zero issues: this one has not
  // been measured, and every figure below would be an invention. Callers must present it as
  // unmeasured -- the same rule the rest of this app follows.
  if (!firstIssueCreatedAt || months.length === 0) {
    return {
      projectId: project?.projectId ?? null,
      measured: false,
      reason: activity ? "No issue dates captured. Run a Universal Scan." : "This project has no scanned activity.",
      ageDays: null,
      issuesPerDay: null,
      recentIssuesPerDay: null,
      momentum: null,
      fillsPerIssue: null,
      peakMonth: null,
      peakIssues: null,
      declineFrom: null,
      fellOff: false,
      neverAdopted: false,
      months: [],
    };
  }

  const ageDays = daysBetween(firstIssueCreatedAt, now);
  const totalIssues = months.reduce((sum, m) => sum + m.issueCount, 0);
  const issuesPerDay = totalIssues / ageDays;

  const recent = recentActivity(months, now, recentWindowDays);
  // Capped at the project's own age: a project six weeks old has not been quiet for the
  // other seven weeks of the window, it did not exist for them.
  const recentDays = Math.max(1, Math.min(ageDays, recent.days));
  const recentIssuesPerDay = recent.issues / recentDays;

  // Its own lifetime rate is the baseline, not the site's. A project doing 3 issues a day
  // has not declined because another project does 300; it has declined because it used to do
  // 12. Comparison against the site is a separate measure, and it lives in the summary.
  const momentum = issuesPerDay > 0 ? recentIssuesPerDay / issuesPerDay : null;

  let peakIndex = -1;
  let peakIssues = 0;
  months.forEach((m, i) => { if (m.issueCount > peakIssues) { peakIssues = m.issueCount; peakIndex = i; } });

  const oldEnough = ageDays >= MIN_AGE_DAYS_TO_JUDGE;
  // Had a real life and lost it. Distinct from never having started: the fix for one is to
  // find out what people moved to, and for the other it is to find out why they never came.
  const fellOff = Boolean(oldEnough && momentum !== null && momentum < FELL_OFF_MOMENTUM && peakIssues > 0);
  const neverAdopted = Boolean(oldEnough && totalIssues > 0 && peakIssues > 0 && totalIssues < ageDays / 30);

  // Field values written per issue. The configuration cost of one unit of work, which is
  // what makes a heavily-configured project with little work expensive rather than merely
  // untidy.
  const fills = Number(project?.totalIssueCount) || 0;
  const fillsPerIssue = totalIssues > 0 ? fills / totalIssues : null;

  return {
    projectId: project?.projectId ?? null,
    measured: true,
    reason: null,
    firstIssueCreatedAt,
    lastIssueCreatedAt,
    ageDays,
    totalIssues,
    issuesPerDay,
    recentIssuesPerDay,
    recentIssues: recent.issues,
    recentMonths: recent.months,
    momentum,
    fillsPerIssue,
    peakMonth: peakIndex >= 0 ? months[peakIndex].month : null,
    peakIssues,
    declineFrom: declineOnset(months, peakIndex, peakIssues),
    fellOff,
    neverAdopted,
    oldEnough,
    months,
  };
}

// Where a rate sits against every other project on the site.
//
// Scored as a percentile rather than against an absolute number, because there is no such
// thing as a good issues-per-day figure in the abstract: 3 a day is thriving on a site of
// small team projects and moribund on one running a service desk. The same reasoning the
// field thresholds already use, where "well past the norm" is derived from the site's median
// rather than from a constant.
export function percentileOf(value, sortedValues) {
  if (!sortedValues.length || !Number.isFinite(value)) return null;
  let below = 0;
  for (const other of sortedValues) {
    if (other < value) below += 1;
    else break;
  }
  return Math.round((below / sortedValues.length) * 100);
}

// The adoption score, and the two things it is made of.
//
// Deliberately not a single opaque number. The rest of this app scores nothing without
// publishing the rate it came from, for the same reason: "ADVEV scores 41" tells an admin
// nothing they can act on, and "top 12% by volume but running at a third of its own
// historical rate" tells them exactly what happened and roughly when.
//
// Volume is where it sits on the site; momentum is where it is going. They are averaged with
// momentum weighted lower, because a project can be the busiest on the site and still be in
// decline -- and it is still the busiest project on the site.
export function scoreAdoption(adoption, sortedRates) {
  if (!adoption?.measured) return { score: null, volumePercentile: null, momentumScore: null };

  const volumePercentile = percentileOf(adoption.issuesPerDay, sortedRates);
  // 1.0x holds steady and scores 70; growth is capped rather than unbounded, because a
  // project that tripled from two issues to six has not earned a 100.
  const momentumScore = adoption.momentum === null
    ? null
    : Math.max(0, Math.min(100, Math.round(adoption.momentum * 70)));

  if (volumePercentile === null) return { score: null, volumePercentile, momentumScore };
  if (momentumScore === null) return { score: volumePercentile, volumePercentile, momentumScore };

  return {
    score: Math.round(volumePercentile * 0.6 + momentumScore * 0.4),
    volumePercentile,
    momentumScore,
  };
}

// Adoption across every project, plus the site-relative context each one needs.
//
// One pass, because the percentile every project is scored against is a property of the set:
// computing them independently would mean sorting the site's rates once per project.
export function summarizeAdoption(projects = [], activityByProject = new Map(), { now = Date.now() } = {}) {
  const rows = projects.map((project) => ({
    project,
    adoption: computeProjectAdoption(project, activityByProject.get(String(project.projectId)), { now }),
  }));

  const measured = rows.filter((r) => r.adoption.measured);
  const sortedRates = measured.map((r) => r.adoption.issuesPerDay).sort((a, b) => a - b);

  const scored = rows.map(({ project, adoption }) => ({
    ...adoption,
    projectKey: project.projectKey,
    projectName: project.projectName,
    fieldCount: project.fieldCount ?? 0,
    ...scoreAdoption(adoption, sortedRates),
  }));

  // Judged only where there was time to judge. A site of new projects has no adoption
  // problem, and reporting one would be an artefact of when it was measured.
  const judgeable = scored.filter((row) => row.measured && row.oldEnough);

  return {
    // Tri-state, like every other pillar: no activity captured at all is "not measured",
    // never "nothing is used".
    available: measured.length > 0,
    measuredProjects: measured.length,
    totalProjects: projects.length,
    judgeableProjects: judgeable.length,
    fellOffCount: judgeable.filter((row) => row.fellOff).length,
    neverAdoptedCount: judgeable.filter((row) => row.neverAdopted).length,
    // The site's own middle, so a reader can tell what normal looks like here.
    medianIssuesPerDay: sortedRates.length ? sortedRates[Math.floor(sortedRates.length / 2)] : null,
    projects: scored,
  };
}
