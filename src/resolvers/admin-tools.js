// Admin tools: the audit log read and the namespace key migration.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { getInstallationKey } from "../lib/jira-api.js";
import { ensureProjectStoreReady, listAuditEvents, migrateOldScopeKeys } from "../lib/project-store.js";
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

export async function migrateNamespaceKeys({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const result = await migrateOldScopeKeys(installationKey);
  return result;
}
