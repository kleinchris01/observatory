// The admin authorization boundary: the Jira ADMINISTER check and the audit trail applied to every admin-only resolver.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { getInstallationKey, callerHasJiraAdmin } from "../lib/jira-api.js";
import { recordAuditEvent, summarizeRecentDenials } from "../lib/project-store.js";
import { logger } from "../lib/logger.js";

// â”€â”€ Admin authorization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// The jira:adminPage module controls who can SEE the admin page. It does not control
// who can reach its resolver: an invoke() is an authenticated app endpoint, and module
// placement is a UI affordance, not an authorization boundary. Every function below
// therefore verifies the calling user holds Jira ADMINISTER before running.
//
// The check is applied by wrapping the registry rather than by calling a helper inside
// each function, so a function added to ADMIN_ONLY_FUNCTIONS is guarded by construction.
// Remembering to add a guard is exactly the kind of thing that gets forgotten once.

export const ADMIN_CHECK_TTL_MS = 60 * 1000;

export const adminCheckCache = new Map();

// Forge reuses warm invocations, so this cache survives across calls within one container
// and spares a Jira round trip per admin read -- getIssueScanStatus is polled every 15s
// for the length of a scan. The cost is that a revoked admin keeps access for up to 60s.
// Accepted, and recorded in SECURITY_CHECKLIST.md.
export async function isCallerJiraAdmin(accountId) {
  if (!accountId) return false;
  const cached = adminCheckCache.get(accountId);
  if (cached && cached.expires > Date.now()) return cached.allowed;

  const allowed = await callerHasJiraAdmin(accountId);
  adminCheckCache.set(accountId, { allowed, expires: Date.now() + ADMIN_CHECK_TTL_MS });
  return allowed;
}

export function __resetAdminCheckCache() {
  adminCheckCache.clear();
}

// recordAuditEvent already swallows its own failures, but this layer must not depend on
// that: if writing the audit row ever did throw, an unguarded await here would turn a
// broken audit table into a total outage of every admin action -- and into a denial-of-
// service anyone able to break that table could trigger. Availability wins over
// completeness here; the loss is loud in the structured log rather than silent.
export async function safeAudit(scopeKey, event) {
  try {
    await recordAuditEvent(scopeKey, event);
  } catch (error) {
    logger.error("audit.write_failed", { action: event?.action, error: error?.message || String(error) });
  }
}

// ── Denial-burst alert ──────────────────────────────────────────────────────────────
//
// One denial is usually someone opening a link they shouldn't have. More than
// DENIAL_BURST_THRESHOLD in an hour is the pattern of someone invoking admin resolvers
// directly, which is the probe this guard exists to stop. The guard already refuses them;
// this makes sure a person hears about it, through a structured `security.denial_burst`
// event a log drain can alert on, and the banner the Overview shows (getSecuritySignals).
//
// The cooldown is per warm container and per installation. It bounds the alert to one event
// per 10 minutes while a burst lasts, and skips the count query entirely in that window, so a
// flood of denials costs one audit insert each and nothing more.
export const DENIAL_BURST_THRESHOLD = 5;
export const DENIAL_BURST_WINDOW_MS = 60 * 60 * 1000;
export const DENIAL_BURST_COOLDOWN_MS = 10 * 60 * 1000;

const denialBurstAlertedAt = new Map();

export function __resetDenialBurstState() {
  denialBurstAlertedAt.clear();
}

// Never throws and never changes the guard's answer: the alert is best-effort, the refusal is not.
export async function checkDenialBurst(installationKey, action) {
  const last = denialBurstAlertedAt.get(installationKey);
  if (last && Date.now() - last < DENIAL_BURST_COOLDOWN_MS) return false;
  try {
    const summary = await summarizeRecentDenials(installationKey, DENIAL_BURST_WINDOW_MS);
    if (summary.denials <= DENIAL_BURST_THRESHOLD) return false;
    denialBurstAlertedAt.set(installationKey, Date.now());
    logger.error("security.denial_burst", {
      installationKey,
      denials: summary.denials,
      actors: summary.actors,
      windowMinutes: DENIAL_BURST_WINDOW_MS / 60000,
      threshold: DENIAL_BURST_THRESHOLD,
      latestAction: action,
    });
    return true;
  } catch (error) {
    logger.warn("security.denial_burst_check_failed", { error: error?.message || String(error) });
    return false;
  }
}

// ── Rovo agents that need Jira ADMINISTER ───────────────────────────────────────────
//
// Rovo actions are not resolvers, so the registry guard above never sees them. Most agents
// answer about configuration any Jira user can already see the shape of. The People agent
// (licences, group membership, who owns what) and the Access agent (permission, issue-security
// and notification schemes, project roles) answer about data the admin page reserves for Jira
// administrators, so they get the same check: as the user, fail closed, the same 60-second cache.
//
// A refused caller gets a structured answer, not a thrown error, so the agent can tell them
// why. It is not audited and does not count toward the denial-burst alert: someone without
// admin rights asking Rovo a question is ordinary use, not a probe of an admin resolver.
export const ROVO_ADMIN_REQUIRED_STATUS = "admin-required";

export function withRovoAdminGate(agentName, fn) {
  return async (payload, context) => {
    const accountId = context?.accountId || null;
    // Fails closed even if the check itself throws.
    const allowed = await isCallerJiraAdmin(accountId).catch(() => false);
    if (!allowed) {
      logger.info("rovo.admin_required", { agent: agentName, actorId: accountId });
      return {
        status: ROVO_ADMIN_REQUIRED_STATUS,
        refreshedAt: null,
        message:
          `The ${agentName} agent answers Jira administrators only, because it reports on ` +
          `${agentName === "People" ? "licences, group membership and ownership" : "permission, security and notification schemes"}. ` +
          `Ask a Jira administrator, or use Observatory's admin page if you are one.`,
      };
    }
    return fn(payload, context);
  };
}

export class AdminPermissionError extends Error {
  constructor() {
    super("This action requires Jira administrator permission.");
    this.name = "AdminPermissionError";
  }
}

export function withAdminGuard(functions) {
  return Object.fromEntries(
    Object.entries(functions).map(([name, fn]) => [
      name,
      async (req) => {
        const accountId = req?.context?.accountId || null;
        if (!(await isCallerJiraAdmin(accountId))) {
          // Denials are audited: a burst of them is the signal that someone is probing
          // the resolver directly, which is the whole reason this guard exists.
          const installationKey = getInstallationKey(req?.context);
          await safeAudit(installationKey, {
            actorId: accountId,
            action: name,
            outcome: "denied",
            detail: "Caller does not hold Jira ADMINISTER permission",
          });
          logger.warn("auth.denied", { action: name, actorId: accountId });
          await checkDenialBurst(installationKey, name);
          throw new AdminPermissionError();
        }
        return fn(req);
      },
    ]),
  );
}

// Actions worth a permanent record: they mutate state, destroy data, or change the rules
// the governance engine runs by. Admin *reads* are not audited -- they are frequent
// (polled during scans) and recording them would bury the events that matter.
export const AUDITED_ADMIN_ACTIONS = new Set([
  "startFullSiteScan",
  "startQuickSiteScan",
  "resumeSiteScan",
  "cancelSiteScan",
  "startIssueScan",
  "resumeIssueScan",
  "cancelIssueScan",
  "startDeltaIssueScan",
  "cancelSnapshot",
  "clearSnapshot",
  "cancelProjectUsageJob",
  "restartProjectUsageJob",
  "resumeProjectUsageJob",
  "restoreProjectUsageCache",
  "refreshRecentProjectUsage",
  "saveReportDefinition",
  "deleteReportDefinition",
  "saveAdminConfig",
  "migrateNamespaceKeys",
  "buildScreenInventory",
  "buildIssueTypeInventory",
  "buildUserInventory",
  "buildAssetInventory",
  "buildAccessInventory",
  "buildChangeHistory",
  "buildEstateInventory",
  "buildFieldConfigInventory",
  "buildBoardInventory",
  "createRemediationEpic",
  "syncRemediationNow",
  "applyRemediationVerification",
  "organiseRemediationHierarchy",
]);

// Every admin action that writes to Jira. Each must be audited, and each must refuse in
// read-only mode before it writes anything; src/resolvers.test.js ("Jira write actions")
// holds every member to both, and fails if any other module starts calling a Jira write
// helper without being listed here.
export const JIRA_WRITE_ACTIONS = new Set([
  "createRemediationEpic",
  "applyRemediationVerification",
  "organiseRemediationHierarchy",
]);

export function withAuditTrail(functions) {
  return Object.fromEntries(
    Object.entries(functions).map(([name, fn]) => [
      name,
      !AUDITED_ADMIN_ACTIONS.has(name)
        ? fn
        : async (req) => {
            const accountId = req?.context?.accountId || null;
            const installationKey = getInstallationKey(req?.context);
            try {
              const result = await fn(req);
              await safeAudit(installationKey, {
                actorId: accountId,
                action: name,
                outcome: "allowed",
                // Resolvers signal a refusal by returning a shape rather than throwing
                // (clearSnapshot's confirmation mismatch, read-only mode), so carry that
                // through instead of recording a blocked action as a completed one.
                detail: result && result.error ? `Refused: ${result.error}` : null,
              });
              return result;
            } catch (error) {
              await safeAudit(installationKey, {
                actorId: accountId,
                action: name,
                outcome: "failed",
                detail: error?.message || String(error),
              });
              throw error;
            }
          },
    ]),
  );
}
