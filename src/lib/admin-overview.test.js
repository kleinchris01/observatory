import { describe, test, expect } from "vitest";
import {
  EMPTY_DASHBOARD,
  buildOverviewDashboard,
  jobCountsOf,
  overviewAdoption,
  overviewAutomation,
  siteHealthInputs,
} from "./admin-overview.js";

// The Overview's aggregation on plain data. The resolver tests (overview.test.js) cover the
// reads and the fallbacks around them; these cover what is done with the data once it is in.

describe("jobCountsOf", () => {
  test("passes counts through, and reads a failed count as all zeros", () => {
    const counts = { queued: 1, building: 0, ready: 5, failed: 0, cancelled: 0, unbuilt: 2 };
    expect(jobCountsOf({ counts })).toBe(counts);
    expect(jobCountsOf({ counts: null })).toEqual({
      queued: 0,
      building: 0,
      ready: 0,
      failed: 0,
      cancelled: 0,
      unbuilt: 0,
    });
  });
});

describe("overviewAdoption", () => {
  const row = (projectKey, declineFrom, fellOff = true) => ({
    projectKey,
    projectName: projectKey,
    declineFrom,
    fellOff,
  });

  // Most recent decline first, at most eight: the ones somebody might remember the reason for.
  test("lists fell-off projects most recent decline first, at most eight", () => {
    const projects = [
      row("OLD", "2025-01"),
      row("NEW", "2026-09"),
      row("MID", "2026-03"),
      row("FINE", null, false),
      ...Array.from({ length: 8 }, (_, i) => row(`X${i}`, "2024-01")),
    ];
    const out = overviewAdoption({ available: true, projects, fellOffCount: 11 });
    expect(out.fellOff.map((p) => p.projectKey).slice(0, 3)).toEqual(["NEW", "MID", "OLD"]);
    expect(out.fellOff).toHaveLength(8);
    expect(out.fellOffCount).toBe(11);
  });

  test("carries only the summary fields, never the per-project series", () => {
    const out = overviewAdoption({ available: false, projects: [], measuredProjects: 0 });
    expect(out).not.toHaveProperty("projects");
    expect(out).toMatchObject({ available: false, measuredProjects: 0, fellOff: [] });
  });
});

describe("overviewAutomation", () => {
  test("no analysis reads as unavailable with zero rules, not as a clean estate", () => {
    expect(overviewAutomation(null)).toEqual({
      health: { available: false },
      summary: { available: false, refreshedAt: null, ruleCount: 0 },
    });
  });

  // The whole health summary reaches the Overview, not just its headline fields.
  test("passes the whole stored health summary through", () => {
    const analysis = {
      refreshedAt: "2026-10-01T00:00:00Z",
      estate: { health: { available: true, ruleCount: 40, credentialRuleCount: 2 } },
    };
    const { health, summary } = overviewAutomation(analysis);
    expect(health).toBe(analysis.estate.health);
    expect(summary).toEqual({
      available: true,
      ruleCount: 40,
      credentialRuleCount: 2,
      refreshedAt: "2026-10-01T00:00:00Z",
    });
  });
});

describe("buildOverviewDashboard", () => {
  test("summarises findings and builds the cards from hydrated fields and projects", () => {
    const out = buildOverviewDashboard({ hydrated: [], projects: [], activity: new Map() });
    expect(out.findingsSummary).toEqual(expect.any(Object));
    expect(out.findingsByCode).toEqual(expect.any(Object));
    expect(out.dashboard.fieldUsage.totalFields).toBe(0);
    expect(out.dashboard.projects).toMatchObject({ totalProjects: 0 });
    expect(out.dashboard.adoption).toMatchObject({ fellOff: [] });
  });

  test("an empty dashboard has the same shape the cards read", () => {
    expect(Object.keys(EMPTY_DASHBOARD).sort()).toEqual(["fieldUsage", "projects"]);
  });
});

describe("siteHealthInputs", () => {
  // An unread pillar is scored as unmeasured, never as zero.
  test("passes null for every pillar that could not be read", () => {
    const inputs = siteHealthInputs({ priorValues: {} });
    for (const key of ["filters", "dashboards", "issueTypes", "users", "assets", "permissions", "security"]) {
      expect(inputs[key], key).toBeNull();
    }
    expect(inputs.priorValues).toEqual({});
  });

  test("routes each pillar's health, the access families separately, and the tunable config", () => {
    const h = (n) => ({ health: { n } });
    const inputs = siteHealthInputs({
      dashboard: { fieldUsage: "fu", projects: "pr" },
      automationHealth: "auto",
      filterOverview: h("f"),
      accessOverview: { permissions: h("p"), security: h("s"), notifications: h("n"), roles: h("r") },
      boardOverview: h("b"),
      driftHealth: "drift",
      config: { healthTolerances: "tol", healthTargets: "tgt" },
    });
    expect(inputs).toMatchObject({
      fieldUsage: "fu",
      projects: "pr",
      automation: "auto",
      filters: { n: "f" },
      permissions: { n: "p" },
      security: { n: "s" },
      notifications: { n: "n" },
      roles: { n: "r" },
      boards: { n: "b" },
      drift: "drift",
      tolerances: "tol",
      targets: "tgt",
    });
  });
});
