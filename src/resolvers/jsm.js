// Jira Service Management: the four JSM pillars (request types, queues, SLAs, customers and
// organizations). The first module built under src/resolvers/ rather than moved there; the
// pillar's inventory and build resolvers join it. See docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES, getCloudId } from "../lib/jira-api.js";
import { probeServiceManagementApi as runServiceManagementProbe } from "../lib/jsm-probe.js";

// What the Service Management API answers on this site, per pillar and build stage. Admin-only,
// read-only, and it never throws: a diagnostic that can fail the page it runs on is worse than
// no diagnostic.
export async function probeServiceManagementApi({ context } = {}) {
  incrMetric(METRIC_NAMES.resolver);
  return runServiceManagementProbe({ cloudId: getCloudId(context) });
}
