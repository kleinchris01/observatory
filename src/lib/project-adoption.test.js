import { describe, test, expect } from "vitest";
import {
  computeProjectAdoption,
  percentileOf,
  scoreAdoption,
  summarizeAdoption,
  FELL_OFF_MOMENTUM,
  MIN_AGE_DAYS_TO_JUDGE,
} from "./project-adoption.js";

// The defect this module exists to fix: every project figure was a lifetime total with
// nothing to divide it by. A project spun up three weeks ago with 40 issues read as abandoned
// next to one carrying 61,000 over eight years -- when the first may be growing twice as
// fast. "Is anyone using this" is a rate, and a rate needs an age.

const NOW = Date.parse("2026-08-21T00:00:00Z");

// A monthly series ending `endingMonthsAgo` months before NOW.
function series(counts, { endingMonthsAgo = 0 } = {}) {
  const end = new Date(NOW);
  end.setUTCMonth(end.getUTCMonth() - endingMonthsAgo);
  return counts.map((issueCount, i) => {
    const d = new Date(end);
    d.setUTCMonth(d.getUTCMonth() - (counts.length - 1 - i));
    return { month: d.toISOString().slice(0, 7), issueCount };
  });
}

function activity(counts, options = {}) {
  const months = series(counts, options);
  return {
    months,
    firstIssueCreatedAt: `${months[0].month}-01T00:00:00.000Z`,
    lastIssueCreatedAt: `${months[months.length - 1].month}-28T00:00:00.000Z`,
  };
}

const project = (over = {}) => ({ projectId: "1", projectKey: "P", projectName: "P", totalIssueCount: 0, ...over });
const compute = (counts, options = {}, proj = project()) =>
  computeProjectAdoption(proj, activity(counts, options), { now: NOW });

describe("computeProjectAdoption — age and rate", () => {
  test("divides by age, so a young project is not punished for being young", () => {
    // The whole point. 120 issues in 3 months beats 3,600 issues in 20 years.
    const young = compute([40, 40, 40]);
    const ancient = computeProjectAdoption(project(), activity(Array(240).fill(15)), { now: NOW });

    expect(young.issuesPerDay).toBeGreaterThan(ancient.issuesPerDay);
  });

  test("anchors age on the first issue, not on today", () => {
    const adoption = compute([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
    // Twelve months of history.
    expect(adoption.ageDays).toBeGreaterThan(330);
    expect(adoption.ageDays).toBeLessThan(400);
  });

  // A project whose first issue is today would otherwise divide by zero and read as
  // infinitely productive.
  test("floors age at a day", () => {
    const months = [{ month: NOW ? new Date(NOW).toISOString().slice(0, 7) : "", issueCount: 5 }];
    const adoption = computeProjectAdoption(project(), {
      months,
      firstIssueCreatedAt: new Date(NOW).toISOString(),
      lastIssueCreatedAt: new Date(NOW).toISOString(),
    }, { now: NOW });

    expect(adoption.ageDays).toBe(1);
    expect(Number.isFinite(adoption.issuesPerDay)).toBe(true);
  });

  test("reports fills per issue, which is the configuration cost of one unit of work", () => {
    const adoption = compute([100], {}, project({ totalIssueCount: 1400 }));
    expect(adoption.fillsPerIssue).toBe(14);
  });
});

describe("computeProjectAdoption — momentum", () => {
  test("compares a project against its own history, not against the site", () => {
    // A project doing 3 a day has not declined because another does 300. It has declined
    // because it used to do 12.
    const steady = compute(Array(24).fill(100));
    // A band rather than a point. Month granularity makes the window's edges approximate,
    // and this fixture gives the partial current month a full month's issues, which a real
    // project never has. What matters is that steady reads as steady rather than as the
    // 1.33x growth it did when the window divided four months of issues by ninety days.
    expect(steady.momentum).toBeGreaterThan(0.9);
    expect(steady.momentum).toBeLessThan(1.15);
  });

  test("a collapse reads as a collapse", () => {
    // Two years busy, then nothing for the last four months.
    const adoption = compute([...Array(24).fill(300), 0, 0, 0, 0]);
    expect(adoption.momentum).toBeLessThan(FELL_OFF_MOMENTUM);
    expect(adoption.fellOff).toBe(true);
  });

  test("growth reads as growth", () => {
    const adoption = compute([...Array(20).fill(20), 200, 300, 400]);
    expect(adoption.momentum).toBeGreaterThan(1.5);
    expect(adoption.fellOff).toBe(false);
  });

  // Seasonal work and release cycles move a project by half without anything being wrong.
  test("a slow quarter is not a collapse", () => {
    const adoption = compute([...Array(20).fill(100), 60, 55, 60]);
    expect(adoption.fellOff).toBe(false);
  });
});

describe("computeProjectAdoption — when it changed", () => {
  test("names the peak month", () => {
    const adoption = compute([10, 50, 900, 40, 20, 10]);
    expect(adoption.peakIssues).toBe(900);
    expect(adoption.peakMonth).toBe(adoption.months[2].month);
  });

  test("dates the month the decline began", () => {
    // Walked forward from the peak to the first month below half of it -- the answer to
    // "when did everyone stop using this".
    const adoption = compute([100, 400, 380, 350, 120, 30, 10]);
    expect(adoption.declineFrom).toBe(adoption.months[4].month);
  });

  test("names no decline for a project still near its peak", () => {
    expect(compute([100, 200, 300, 290, 310]).declineFrom).toBeNull();
  });
});

describe("computeProjectAdoption — what it refuses to claim", () => {
  // A project two weeks old with four issues is not under-adopted, it is new. Reporting it
  // as a finding is how a governance report teaches people to ignore it.
  test("does not judge a project too young to judge", () => {
    const young = compute([2, 2]);
    expect(young.ageDays).toBeLessThan(MIN_AGE_DAYS_TO_JUDGE);
    expect(young.oldEnough).toBe(false);
    expect(young.fellOff).toBe(false);
    expect(young.neverAdopted).toBe(false);
  });

  test("reports unmeasured rather than empty when no dates were captured", () => {
    // A scan built before issue dates were requested has no activity. Every figure would be
    // an invention, and a project dated today would read as brand new and under-adopted.
    const adoption = computeProjectAdoption(project(), null, { now: NOW });
    expect(adoption.measured).toBe(false);
    expect(adoption.issuesPerDay).toBeNull();
    expect(adoption.ageDays).toBeNull();
    expect(adoption.reason).toMatch(/no scanned activity/i);
  });

  test("asks for a scan when there is a row but no dates in it", () => {
    const adoption = computeProjectAdoption(project(), { months: [], firstIssueCreatedAt: null }, { now: NOW });
    expect(adoption.measured).toBe(false);
    expect(adoption.reason).toMatch(/Universal Scan/);
  });

  test("survives a project with no activity object at all", () => {
    expect(() => computeProjectAdoption(null, undefined, { now: NOW })).not.toThrow();
  });
});

describe("percentileOf", () => {
  test("places a rate against the site rather than against a constant", () => {
    // There is no such thing as a good issues-per-day figure in the abstract: 3 a day is
    // thriving on one site and moribund on another.
    const rates = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentileOf(1, rates)).toBe(0);
    expect(percentileOf(6, rates)).toBe(50);
    expect(percentileOf(10, rates)).toBe(90);
  });

  test("returns null rather than a number it cannot derive", () => {
    expect(percentileOf(5, [])).toBeNull();
    expect(percentileOf(NaN, [1, 2])).toBeNull();
  });
});

describe("scoreAdoption", () => {
  const rates = Array.from({ length: 20 }, (_, i) => i + 1);

  test("holding steady scores as holding steady", () => {
    const { momentumScore } = scoreAdoption({ measured: true, issuesPerDay: 10, momentum: 1 }, rates);
    expect(momentumScore).toBe(70);
  });

  // A project that tripled from two issues to six has not earned a 100.
  test("caps growth rather than letting it run away", () => {
    const { momentumScore } = scoreAdoption({ measured: true, issuesPerDay: 10, momentum: 8 }, rates);
    expect(momentumScore).toBe(100);
  });

  test("the busiest project on the site is still the busiest, even in decline", () => {
    // Volume is weighted above momentum for exactly this case.
    const dying = scoreAdoption({ measured: true, issuesPerDay: 20, momentum: 0 }, rates);
    const tiny = scoreAdoption({ measured: true, issuesPerDay: 1, momentum: 1 }, rates);
    expect(dying.volumePercentile).toBe(95);
    expect(dying.score).toBeGreaterThan(tiny.score);
  });

  test("scores nothing for a project it could not measure", () => {
    expect(scoreAdoption({ measured: false }, rates)).toMatchObject({ score: null });
  });
});

describe("summarizeAdoption", () => {
  const build = (defs) => {
    const projects = defs.map((d) => project({ projectId: d.id, projectKey: d.id, totalIssueCount: d.fills ?? 0 }));
    const map = new Map(defs.map((d) => [d.id, activity(d.counts, d.options ?? {})]));
    return summarizeAdoption(projects, map, { now: NOW });
  };

  test("ranks every project against the same population", () => {
    const out = build([
      { id: "BUSY", counts: Array(24).fill(300) },
      { id: "QUIET", counts: Array(24).fill(3) },
    ]);
    const busy = out.projects.find((p) => p.projectKey === "BUSY");
    const quiet = out.projects.find((p) => p.projectKey === "QUIET");

    expect(busy.volumePercentile).toBeGreaterThan(quiet.volumePercentile);
    expect(out.medianIssuesPerDay).toBeGreaterThan(0);
  });

  test("counts what fell off and what never started, separately", () => {
    const out = build([
      { id: "LEFT", counts: [...Array(24).fill(400), 0, 0, 0, 0] },
      { id: "NEVER", counts: Array(36).fill(0).map(() => 0) },
      { id: "FINE", counts: Array(24).fill(100) },
    ]);

    expect(out.fellOffCount).toBe(1);
    expect(out.projects.find((p) => p.projectKey === "LEFT").fellOff).toBe(true);
    expect(out.projects.find((p) => p.projectKey === "FINE").fellOff).toBe(false);
  });

  test("judges only the projects old enough to judge", () => {
    const out = build([
      { id: "OLD", counts: Array(24).fill(100) },
      { id: "NEW", counts: [5, 5] },
    ]);
    expect(out.totalProjects).toBe(2);
    expect(out.judgeableProjects).toBe(1);
  });

  test("reports unavailable rather than clean when nothing was measured", () => {
    const out = summarizeAdoption([project()], new Map(), { now: NOW });
    expect(out.available).toBe(false);
    expect(out.fellOffCount).toBe(0);
  });

  test("survives an empty site", () => {
    expect(summarizeAdoption([], new Map(), { now: NOW })).toMatchObject({ available: false, totalProjects: 0 });
  });
});
