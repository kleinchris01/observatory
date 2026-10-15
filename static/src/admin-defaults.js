// Default admin configuration, extracted from admin.jsx so ConfigTab and AdminApp
// can each import it without one depending on the other.

export const DEFAULT_THRESHOLDS = {
  highImpactMinProjects: 10,
  highImpactMinIssues: 1000,
  appFieldHeavyUsageMin: 500,
  broadScopeMinProjects: 3,
  lightUsageMinProjects: 5,
  lightUsageMaxIssues: 100,
  missingDescriptionMinProjects: 5,
  missingDescriptionMinIssues: 500,
  configuredActiveGapMinProjects: 5,
  configuredActiveGapMaxRatio: 0.7,
  globalContextMaxIssues: 50,
  contextSprawlMinContexts: 8,
  staleFieldMaxAgeDays: 365,
};

export const DEFAULT_MACRO_ACCESS = {
  restrictAccess: false,
  allowedGroups: [],
};

export const DEFAULT_REMEDIATION = {
  projectKey: "",
  epicIssueType: "Epic",
  taskIssueType: "Task",
  defaultAssigneeAccountId: "",
  hierarchyEnabled: false,
  rootIssueType: "Product",
  initiativeIssueType: "Initiative",
};

// Mirrors DEFAULT_ANALYSIS_STALE_AFTER_DAYS in src/lib/automation-analysis.js. Kept as a
// literal rather than imported so this module stays free of backend imports, the way the
// rest of the defaults here are; the ConfigTab test asserts the two agree.
export const DEFAULT_AUTOMATION_STALE_AFTER_DAYS = 7;

export const DEFAULT_CONFIG = {
  readOnlyMode: false,
  apiConcurrency: 4,
  automationStaleAfterDays: DEFAULT_AUTOMATION_STALE_AFTER_DAYS,
  autoSnapshotEnabled: false,
  autoSnapshotFrequency: "weekly",
  governanceThresholds: DEFAULT_THRESHOLDS,
  macroAccess: DEFAULT_MACRO_ACCESS,
  remediation: DEFAULT_REMEDIATION,
};
