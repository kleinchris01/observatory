// Marketplace apps: what this site reveals about its installed apps, before an Apps pillar is
// built on it. The probe only, for now. See docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES } from "../lib/jira-api.js";
import { probeMarketplaceApps as runMarketplaceAppsProbe } from "../lib/apps-probe.js";

// Admin-only, read-only, and it never throws: each signal reports its own failure.
export async function probeMarketplaceApps() {
  incrMetric(METRIC_NAMES.resolver);
  return runMarketplaceAppsProbe();
}
