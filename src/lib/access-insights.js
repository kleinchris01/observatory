// Governance findings over the access snapshot: least-privilege violations in permission
// schemes, data black holes in issue-security schemes, and fragile routing in notification
// schemes. Pure functions over already-loaded rows, like issuetype-insights.js.

const BROWSE = "BROWSE_PROJECTS";
const ADMIN = "ADMINISTER_PROJECTS";

function bySchemeId(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.schemeId)) map.set(r.schemeId, []);
    map.get(r.schemeId).push(r);
  }
  return map;
}

function projectCounts(schemeProjects) {
  const map = new Map();
  for (const p of schemeProjects) map.set(p.schemeId, (map.get(p.schemeId) || 0) + 1);
  return map;
}

// ── Permission schemes ──────────────────────────────────────────────────────
export function summarizePermissionInsights({ schemes = [], holders = [], schemeProjects = [], rosterAccountIds = new Set() } = {}) {
  const holdersBy = bySchemeId(holders);
  const projCount = projectCounts(schemeProjects);

  const unused = [];
  const risky = [];
  let directUserGrants = 0;
  let offRosterUserGrants = 0;

  for (const scheme of schemes) {
    const g = holdersBy.get(scheme.id) || [];
    const count = projCount.get(scheme.id) || 0;
    if (count === 0 && !scheme.isDefault) {
      unused.push({ id: scheme.id, name: scheme.name });
    }

    const reasons = [];
    if (g.some((h) => h.context === BROWSE && h.holderType === "anyone")) reasons.push("browse open to anyone (public)");
    if (g.some((h) => h.context === ADMIN && (h.holderType === "anyone" || h.holderType === "group"))) reasons.push("project admin granted to a group or to anyone");
    const userGrants = g.filter((h) => h.holderType === "user" && h.holderValue);
    if (userGrants.length) reasons.push(`${userGrants.length} grant${userGrants.length === 1 ? "" : "s"} to a named individual`);
    directUserGrants += userGrants.length;
    offRosterUserGrants += userGrants.filter((h) => !rosterAccountIds.has(h.holderValue)).length;

    if (reasons.length) risky.push({ id: scheme.id, name: scheme.name, reasons });
  }

  return {
    available: schemes.length > 0,
    totalSchemes: schemes.length,
    unusedSchemeCount: unused.length,
    riskySchemeCount: risky.length,
    directUserGrantCount: directUserGrants,
    offRosterUserGrantCount: offRosterUserGrants,
    unusedSchemes: unused.slice(0, 25),
    riskySchemes: risky.slice(0, 25),
  };
}

export function summarizePermissionHealth(s) {
  if (!s?.available) return { available: false };
  return {
    available: true,
    totalSchemes: s.totalSchemes,
    riskySchemeCount: s.riskySchemeCount,
    unusedSchemeCount: s.unusedSchemeCount,
  };
}

// ── Issue-security schemes ──────────────────────────────────────────────────
export function summarizeSecurityInsights({ schemes = [], levels = [], holders = [], schemeProjects = [], rosterAccountIds = new Set() } = {}) {
  const levelsBy = bySchemeId(levels);
  const projCount = projectCounts(schemeProjects);
  // members keyed by "schemeId|levelId" (holder.context is the level id)
  const memberCountByLevel = new Map();
  let offRosterMembers = 0;
  for (const h of holders) {
    const key = `${h.schemeId}|${h.context}`;
    memberCountByLevel.set(key, (memberCountByLevel.get(key) || 0) + 1);
    if (h.holderType === "user" && h.holderValue && !rosterAccountIds.has(h.holderValue)) offRosterMembers += 1;
  }

  const unused = [];
  const noLevels = [];
  const emptyLevels = [];

  for (const scheme of schemes) {
    const lvls = levelsBy.get(scheme.id) || [];
    if ((projCount.get(scheme.id) || 0) === 0) unused.push({ id: scheme.id, name: scheme.name });
    if (lvls.length === 0) noLevels.push({ id: scheme.id, name: scheme.name });
    for (const lvl of lvls) {
      if ((memberCountByLevel.get(`${scheme.id}|${lvl.id}`) || 0) === 0) {
        emptyLevels.push({ schemeId: scheme.id, schemeName: scheme.name, levelId: lvl.id, levelName: lvl.name });
      }
    }
  }

  return {
    available: schemes.length > 0,
    totalSchemes: schemes.length,
    totalLevels: levels.length,
    unusedSchemeCount: unused.length,
    noLevelSchemeCount: noLevels.length,
    emptyLevelCount: emptyLevels.length,
    offRosterMemberCount: offRosterMembers,
    unusedSchemes: unused.slice(0, 25),
    emptyLevels: emptyLevels.slice(0, 40),
  };
}

export function summarizeSecurityHealth(s) {
  if (!s?.available) return { available: false };
  return {
    available: true,
    totalSchemes: s.totalSchemes,
    totalLevels: s.totalLevels,
    brokenLevelCount: s.emptyLevelCount + s.noLevelSchemeCount,
    unusedSchemeCount: s.unusedSchemeCount,
  };
}

// ── Notification schemes ────────────────────────────────────────────────────
export function summarizeNotificationInsights({ schemes = [], holders = [], schemeProjects = [], rosterAccountIds = new Set() } = {}) {
  const holdersBy = bySchemeId(holders);
  const projCount = projectCounts(schemeProjects);

  const unused = [];
  const fragile = [];
  let offRosterRecipients = 0;

  for (const scheme of schemes) {
    const h = holdersBy.get(scheme.id) || [];
    if ((projCount.get(scheme.id) || 0) === 0 && !scheme.isDefault) unused.push({ id: scheme.id, name: scheme.name });

    const namedUsers = h.filter((r) => r.holderType === "user" && r.holderValue);
    if (namedUsers.length) {
      fragile.push({ id: scheme.id, name: scheme.name, namedUserCount: namedUsers.length });
    }
    offRosterRecipients += namedUsers.filter((r) => !rosterAccountIds.has(r.holderValue)).length;
  }

  return {
    available: schemes.length > 0,
    totalSchemes: schemes.length,
    unusedSchemeCount: unused.length,
    fragileSchemeCount: fragile.length,
    offRosterRecipientCount: offRosterRecipients,
    unusedSchemes: unused.slice(0, 25),
    fragileSchemes: fragile.slice(0, 25),
  };
}

export function summarizeNotificationHealth(s) {
  if (!s?.available) return { available: false };
  return {
    available: true,
    totalSchemes: s.totalSchemes,
    fragileSchemeCount: s.fragileSchemeCount,
    unusedSchemeCount: s.unusedSchemeCount,
  };
}
