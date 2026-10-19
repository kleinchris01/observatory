// Admin tools: the audit log read and the namespace key migration.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { getInstallationKey } from "../lib/jira-api.js";
import {
  ensureProjectStoreReady,
  listAuditEvents,
  migrateOldScopeKeys,
  summarizeRecentDenials,
} from "../lib/project-store.js";
import { DENIAL_BURST_THRESHOLD, DENIAL_BURST_WINDOW_MS } from "./admin-guard.js";
import { logger } from "../lib/logger.js";
import { optionalPositiveInt } from "../lib/validate.js";

// Admin read. Guarded like everything else in the registry, but deliberately NOT in
// AUDITED_ADMIN_ACTIONS -- auditing reads of the audit log is a loop that buries the
// events worth finding, and this exposes nothing an admin could not already query.
export async function getAuditLog({ payload, context }) {
  await ensureProjectStoreReady();
  const limit = optionalPositiveInt(payload?.limit, "limit", 100, 1000);
  const installationKey = getInstallationKey(context);
  const events = await listAuditEvents(installationKey, limit);
  return { events, limit };
}

// Admin read: the Overview's security banner. A burst is the same rule the guard alerts on,
// so the banner and the `security.denial_burst` event can never disagree about what counts.
// A failed read answers `unavailable` rather than "no denials" -- silence is not all-clear.
export async function getSecuritySignals({ context }) {
  const installationKey = getInstallationKey(context);
  try {
    const summary = await summarizeRecentDenials(installationKey, DENIAL_BURST_WINDOW_MS);
    return {
      ok: true,
      denials: {
        ...summary,
        windowMinutes: DENIAL_BURST_WINDOW_MS / 60000,
        threshold: DENIAL_BURST_THRESHOLD,
        burst: summary.denials > DENIAL_BURST_THRESHOLD,
      },
    };
  } catch (error) {
    logger.warn("security.signals_read_failed", { installationKey, error: error?.message || String(error) });
    return { ok: false, unavailable: "Recent permission denials could not be read just now." };
  }
}

export async function migrateNamespaceKeys({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const result = await migrateOldScopeKeys(installationKey);
  return result;
}
