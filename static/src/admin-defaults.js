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
  configuredActiveGapMaxRatio: 0.70,
  globalContextMaxIssues: 50,
  contextSprawlMinContexts: 8,
  staleFieldMaxAgeDays: 365,
};

export const DEFAULT_MACRO_ACCESS = {
  restrictAccess: false,
  allowedGroups: [],
};

export const DEFAULT_CONFIG = {
  readOnlyMode: false,
  apiConcurrency: 4,
  autoSnapshotEnabled: false,
  autoSnapshotFrequency: "weekly",
  governanceThresholds: DEFAULT_THRESHOLDS,
  macroAccess: DEFAULT_MACRO_ACCESS,
};
