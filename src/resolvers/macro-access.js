// The macro's reader-group restriction: the access decision, its cache, and the guard applied to the macro handler.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import api, { route } from "@forge/api";
import { logger, errorContext } from "../lib/logger.js";
import { readAdminConfig } from "./admin-config.js";
import { viewerProjectCount } from "./viewer.js";

// The group-membership answer, cached briefly per account and group list. The macro makes
// several reads per page load, and every one of them is now gated, so without this each
// would cost a Jira round trip. Same 60-second window, and the same accepted risk, as the
// admin check: a viewer removed from the group keeps access for up to a minute.
export const MACRO_ACCESS_TTL_MS = 60 * 1000;

export const macroAccessCache = new Map();

export function __clearMacroAccessCache() {
  macroAccessCache.clear();
}

// One decision, used both by checkMacroAccess (which the macro asks before rendering) and by
// withMacroAccessGuard (which every macro read passes through). Before the guard existed the
// restriction was only a UI decision: the macro hid itself, but any Confluence user could
// invoke getMacroFields and the rest directly. `failedOpen` marks the accepted risk in
// SECURITY_CHECKLIST.md 1.3: a failed group lookup grants access rather than blanking the page.
export async function macroAccessDecision(context) {
  try {
    const config = await readAdminConfig();
    const { restrictAccess, allowedGroups } = config.macroAccess || {};

    if (!restrictAccess) return { allowed: true };

    const groups = (allowedGroups || []).filter(Boolean);
    if (!groups.length) {
      return {
        allowed: false,
        reason:
          "Macro access is restricted but no allowed groups have been configured. Contact your Jira administrator.",
      };
    }

    const accountId = context?.accountId;
    if (!accountId) {
      return { allowed: false, reason: "Please sign in to Jira to view this Observatory." };
    }

    const cacheKey = `${accountId}|${JSON.stringify(groups)}`;
    const cached = macroAccessCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.decision;

    const resp = await api
      .asApp()
      .requestJira(route`/rest/api/3/user/groups?accountId=${accountId}`, { headers: { Accept: "application/json" } });

    if (!resp.ok) {
      logger.error("checkMacroAccess.group_lookup_failed", { status: resp.status });
      // Fail open -- do not block on an API error. Not cached, so the next call retries.
      return { allowed: true, failedOpen: true };
    }

    const userGroups = await resp.json();
    const userGroupNames = Array.isArray(userGroups) ? userGroups.map((g) => g.name) : [];
    const hasAccess = groups.some((g) => userGroupNames.includes(g));

    const decision = hasAccess
      ? { allowed: true }
      : {
          allowed: false,
          reason:
            "You don't have permission to view this Observatory. Contact your Jira administrator to request access.",
        };
    macroAccessCache.set(cacheKey, { decision, expires: Date.now() + MACRO_ACCESS_TTL_MS });
    return decision;
  } catch (err) {
    logger.error("checkMacroAccess.failed", errorContext(err));
    return { allowed: true, failedOpen: true }; // fail open
  }
}

export async function checkMacroAccess({ context }) {
  const decision = await macroAccessDecision(context);
  if (!decision.allowed) return { allowed: false, reason: decision.reason };
  // On a failed lookup the count is left unknown rather than guessed at, which the macro
  // renders as its generic scope line.
  return { allowed: true, projectCount: decision.failedOpen ? null : await viewerProjectCount(context) };
}

export class MacroAccessError extends Error {
  constructor(reason) {
    super(reason || "You don't have permission to view this Observatory.");
    this.name = "MacroAccessError";
  }
}

// Applied to the macro handler's registry in index.js. Not applied on the admin handler:
// the admin page is gated by Jira ADMINISTER, and the macro's group list is a setting about
// Confluence readers, not admins.
export function withMacroAccessGuard(functions) {
  return Object.fromEntries(
    Object.entries(functions).map(([name, fn]) => {
      // The check itself must stay callable, or a denied viewer could not be told why.
      if (name === "checkMacroAccess") return [name, fn];
      return [
        name,
        async (req) => {
          const decision = await macroAccessDecision(req?.context);
          if (!decision.allowed) {
            logger.warn("macro.denied", { action: name, actorId: req?.context?.accountId || null });
            throw new MacroAccessError(decision.reason);
          }
          return fn(req);
        },
      ];
    }),
  );
}
