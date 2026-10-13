// Admin configuration: defaults, the stored config, and its read/save resolvers.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { kvs } from "@forge/kvs";
import { BASE_JIRA_CONCURRENCY } from "../lib/jira-api.js";
import { DEFAULT_HEALTH_TOLERANCES, DEFAULT_HEALTH_TARGETS } from "../lib/health-score.js";
import { DEFAULT_ANALYSIS_STALE_AFTER_DAYS } from "../lib/automation-analysis.js";
import { DEFAULT_GOVERNANCE_THRESHOLDS } from "../lib/analysis.js";
import { requirePositiveInt, requireBoundedInt, optionalEnum } from "../lib/validate.js";

// ----- Admin config -----

export const ADMIN_CONFIG_KEY = "atlasiq-admin-config";

export const DEFAULT_MACRO_ACCESS = {
  restrictAccess: false,
  allowedGroups: [],
};

// Quick scan's schedule. dayOfWeek only matters when frequency is "weekly" -- 0 is Sunday, to
// match Date#getUTCDay() and the way most people say a day of the week.
//
// windowHours defaults to matching the interval (weekly -> 168h, daily -> 24h) but can be set
// wider than the interval on purpose: a schedule that is sometimes late for reasons outside
// this app's control (Forge's own scheduling looseness, a site down for maintenance) should
// still catch everything that changed, not lose the gap in between. Narrower than the
// interval would be the opposite mistake -- a quiet hole between two quick scans that nothing
// ever re-checks.
// What the admin has explicitly acknowledged during first run, and whether they have put
// the panel away. Only ACKNOWLEDGEMENTS live here -- a human confirming they have read
// something is a real fact with nowhere else to live. Every step that describes the state of
// the estate is derived from that estate on read, never stored: a stored flag drifts, lies
// after a data wipe, and survives a reinstall it should not.
export const DEFAULT_FIRST_RUN = {
  acknowledged: [],
  dismissed: false,
};

export const DEFAULT_QUICK_SCAN_SCHEDULE = {
  enabled: false,
  frequency: "weekly",
  dayOfWeek: 0,
  hourUtc: 0,
  windowHours: 168,
  lastScheduledRunAt: null,
};

export const DEFAULT_REMEDIATION_CONFIG = {
  // The project remediation epics and tasks are created in. Empty means "not set up yet" --
  // every create action refuses until an admin picks one.
  projectKey: "",
  epicIssueType: "Epic",
  taskIssueType: "Task",
  // Optional: an accountId every created task is assigned to. Empty means unassigned.
  defaultAssigneeAccountId: "",
  // The quarter's hierarchy above the epics (lib/remediation-hierarchy.js): a top-level item
  // and one initiative per pillar. Off by default -- it needs those issue types to exist in
  // the remediation project, above Epic in the site's hierarchy.
  hierarchyEnabled: false,
  rootIssueType: "Product",
  initiativeIssueType: "Initiative",
};

export const DEFAULT_ADMIN_CONFIG = {
  readOnlyMode: false,
  apiConcurrency: BASE_JIRA_CONCURRENCY,
  // How old an imported automation analysis may be before its answers stop being treated as
  // current. 7 days matches the macro's existing snapshot warning and the Quick Scan panel's
  // full-scan age, so an admin meets one staleness rule across the product rather than three.
  automationStaleAfterDays: DEFAULT_ANALYSIS_STALE_AFTER_DAYS,
  autoSnapshotEnabled: false,
  autoSnapshotFrequency: "weekly",
  governanceThresholds: DEFAULT_GOVERNANCE_THRESHOLDS,
  macroAccess: DEFAULT_MACRO_ACCESS,
  quickScanSchedule: DEFAULT_QUICK_SCAN_SCHEDULE,
  remediation: DEFAULT_REMEDIATION_CONFIG,
  firstRun: DEFAULT_FIRST_RUN,
};

export async function readAdminConfig() {
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
      quickScanSchedule: {
        ...DEFAULT_QUICK_SCAN_SCHEDULE,
        ...(stored.quickScanSchedule || {}),
      },
      remediation: {
        ...DEFAULT_REMEDIATION_CONFIG,
        ...(stored.remediation || {}),
      },
      firstRun: {
        ...DEFAULT_FIRST_RUN,
        ...(stored.firstRun || {}),
      },
    };
  } catch {
    return DEFAULT_ADMIN_CONFIG;
  }
}

export async function getAdminConfigResolver(_payload, _context) {
  return readAdminConfig();
}

export async function saveAdminConfigResolver({ payload }) {
  // Input validation for admin config shape
  const cfg = payload || {};
  if (cfg.apiConcurrency !== undefined && cfg.apiConcurrency !== null) {
    requireBoundedInt(cfg.apiConcurrency, "apiConcurrency", 1, 20);
  }
  // Bounded at both ends on purpose. Zero or negative would make every analysis stale and
  // the pillar would answer "unknown" forever; an unbounded upper end would let someone set
  // it high enough to silence the warning permanently, which is the same as removing it.
  if (cfg.automationStaleAfterDays !== undefined && cfg.automationStaleAfterDays !== null) {
    requireBoundedInt(cfg.automationStaleAfterDays, "automationStaleAfterDays", 1, 90);
  }
  if (cfg.autoSnapshotFrequency !== undefined && cfg.autoSnapshotFrequency !== null) {
    optionalEnum(cfg.autoSnapshotFrequency, "autoSnapshotFrequency", ["daily", "weekly", "monthly"], null);
  }
  const thresholds = cfg.governanceThresholds || {};
  const thresholdKeys = [
    "unusedFieldDaysThreshold",
    "lowUsageIssueThreshold",
    "highUsageIssueThreshold",
    "highProjectCountThreshold",
  ];
  for (const key of thresholdKeys) {
    if (thresholds[key] !== undefined && thresholds[key] !== null) {
      requirePositiveInt(thresholds[key], `governanceThresholds.${key}`);
    }
  }
  // Health tolerances are rates, not counts: the share of an estate at which a dimension
  // bottoms out. Validated as a fraction so a value typed as a percentage (15 rather than
  // 0.15) is rejected here rather than silently zeroing that dimension for everyone.
  const tolerances = cfg.healthTolerances || {};
  for (const key of Object.keys(DEFAULT_HEALTH_TOLERANCES)) {
    const value = tolerances[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
      throw new Error(`healthTolerances.${key} must be a rate greater than 0 and at most 1`);
    }
  }
  // v2 scoring targets: each is { target, floor } as rates in [0,1]. Only the shape is
  // enforced here -- resolveHealthTargets rejects a degenerate pair for the direction and
  // keeps the default, so a bad band costs one tuned dimension, not the score.
  const healthTargets = cfg.healthTargets || {};
  for (const key of Object.keys(DEFAULT_HEALTH_TARGETS)) {
    const band = healthTargets[key];
    if (band === undefined || band === null) continue;
    if (typeof band !== "object" || Array.isArray(band)) {
      throw new Error(`healthTargets.${key} must be an object with target and floor rates`);
    }
    for (const field of ["target", "floor"]) {
      const v = band[field];
      if (v === undefined || v === null) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
        throw new Error(`healthTargets.${key}.${field} must be a rate between 0 and 1`);
      }
    }
  }
  // Remediation ticketing target. Every field is optional here; a create action does its
  // own "is this actually set up" check. What is enforced is the shape, so a typo cannot
  // wedge issue creation for everyone — a project KEY, not a name or an id, and issue-type
  // names that are non-empty strings.
  if (cfg.remediation) {
    const rem = cfg.remediation;
    if (rem.projectKey !== undefined && rem.projectKey !== null && rem.projectKey !== "") {
      if (typeof rem.projectKey !== "string" || !/^[A-Za-z][A-Za-z0-9_]{1,49}$/.test(rem.projectKey)) {
        throw new Error("remediation.projectKey must be a Jira project key (letters, digits and underscores, starting with a letter).");
      }
    }
    if (rem.hierarchyEnabled !== undefined && typeof rem.hierarchyEnabled !== "boolean") {
      throw new Error("remediation.hierarchyEnabled must be true or false.");
    }
    for (const key of ["epicIssueType", "taskIssueType", "rootIssueType", "initiativeIssueType"]) {
      if (rem[key] !== undefined && rem[key] !== null && rem[key] !== "") {
        if (typeof rem[key] !== "string" || rem[key].length > 100) {
          throw new Error(`remediation.${key} must be an issue type name.`);
        }
      }
    }
    if (rem.defaultAssigneeAccountId !== undefined && rem.defaultAssigneeAccountId !== null && rem.defaultAssigneeAccountId !== "") {
      if (typeof rem.defaultAssigneeAccountId !== "string" || rem.defaultAssigneeAccountId.length > 128) {
        throw new Error("remediation.defaultAssigneeAccountId must be an Atlassian accountId.");
      }
    }
  }
  if (cfg.quickScanSchedule) {
    const sched = cfg.quickScanSchedule;
    if (sched.frequency !== undefined && sched.frequency !== null) {
      optionalEnum(sched.frequency, "quickScanSchedule.frequency", ["daily", "weekly"], null);
    }
    if (sched.dayOfWeek !== undefined && sched.dayOfWeek !== null) {
      requireBoundedInt(sched.dayOfWeek, "quickScanSchedule.dayOfWeek", 0, 6);
    }
    if (sched.hourUtc !== undefined && sched.hourUtc !== null) {
      requireBoundedInt(sched.hourUtc, "quickScanSchedule.hourUtc", 0, 23);
    }
    if (sched.windowHours !== undefined && sched.windowHours !== null) {
      requireBoundedInt(sched.windowHours, "quickScanSchedule.windowHours", 1, 24 * 90);
    }
  }
  const current = await readAdminConfig();
  const updated = {
    ...current,
    ...(payload || {}),
    governanceThresholds: {
      ...current.governanceThresholds,
      ...(payload?.governanceThresholds || {}),
    },
    healthTolerances: {
      ...current.healthTolerances,
      ...(payload?.healthTolerances || {}),
    },
    healthTargets: {
      ...current.healthTargets,
      ...(payload?.healthTargets || {}),
    },
    macroAccess: {
      ...current.macroAccess,
      ...(payload?.macroAccess || {}),
    },
    quickScanSchedule: {
      ...current.quickScanSchedule,
      ...(payload?.quickScanSchedule || {}),
    },
    remediation: {
      ...current.remediation,
      ...(payload?.remediation || {}),
    },
    firstRun: {
      ...current.firstRun,
      ...(payload?.firstRun || {}),
    },
  };
  updated.apiConcurrency = Math.max(1, Math.min(10, Number(updated.apiConcurrency) || BASE_JIRA_CONCURRENCY));
  // Clamped as well as validated, so a value that reached storage some other way (an older
  // build, a hand-edited record) still lands inside the band rather than disabling the gate.
  updated.automationStaleAfterDays = Math.max(1, Math.min(90,
    Number(updated.automationStaleAfterDays) || DEFAULT_ANALYSIS_STALE_AFTER_DAYS));
  await kvs.set(ADMIN_CONFIG_KEY, updated);
  return { ok: true, config: updated };
}
