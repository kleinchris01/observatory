// What each remediation playbook tickets, as pure functions over an inventory that has already
// been loaded.
//
// Split out of src/resolvers/remediation.js (docs/resolvers-refactor.md, follow-up 2). Every
// candidate loader there did two things: read a pillar's inventory (I/O, with its own "not built
// yet" reasons) and pick that finding's items out of it (pure). The picking lives here, keyed by
// finding, so it is tested on plain data without mocking a single store read. The resolver keeps
// the reads (CANDIDATE_SOURCES in remediation.js) and builds REMEDIATION_CANDIDATE_LOADERS from
// the two halves, so a finding's count and its epic's task count still come from one computation.
//
// A selector returns the same result shape a loader always did: { available: true, items } or
// { available: false, reason, items: [] }. It may still refuse -- "no-roster", "no-usage" -- when
// the inventory exists but the measurement this finding needs does not.

import { groupBounded } from "./remediation-playbooks.js";
import { summarizeEstateInsights } from "./estate-insights.js";
import { summarizeDashboards } from "./dashboard-insights.js";
import { hydrateRuleDirectory } from "./automation-analysis.js";

const withStringId = (sc) => ({ ...sc, id: String(sc.id) });
const noRoster = { available: false, reason: "no-roster", items: [] };

// ── Shared item shapes ─────────────────────────────────────────────────────

export const reasonsWithCode = (code) => (f) => {
  const hits = (f.findings?.reasons || []).filter((r) => r.code === code);
  return hits.length ? hits : null;
};

// `reasonsOf(field)` returns the reasons that put the field in this finding, or null.
export function fieldCandidates(fields, reasonsOf) {
  const items = [];
  for (const f of fields) {
    const reasons = reasonsOf(f);
    if (!reasons) continue;
    items.push({
      id: f.id,
      name: f.name || null,
      type: f.type || null,
      configuredProjectCount: f.configuredProjectCount ?? null,
      totalIssueCount: f.totalIssueCount ?? null,
      reasons: reasons.map((r) => r.title || r.detail || r.code),
    });
  }
  return { available: true, items };
}

// The adoption flags, on exactly the terms the Overview counts them: judged projects only
// (measured, old enough), and nothing at all while the activity data is stale.
export function adoptionFlagged(adoption, flag) {
  if (!adoption?.available || adoption.dataStale) return [];
  return adoption.projects
    .filter((p) => p.measured && p.oldEnough && p[flag])
    .map((p) => ({
      id: p.projectKey,
      projectKey: p.projectKey,
      projectName: p.projectName,
      issuesPerDay: p.issuesPerDay != null ? Math.round(p.issuesPerDay * 100) / 100 : null,
      recentIssuesPerDay: p.recentIssuesPerDay != null ? Math.round(p.recentIssuesPerDay * 100) / 100 : null,
      peakMonth: p.peakMonth || null,
      ageDays: p.ageDays ?? null,
    }));
}

// The stored analysis keeps a preview of the highest-severity rules, not every flagged rule.
// `partial` and `expected` say so, so the tab can state how many are not listed rather than
// present the preview as the whole finding.
export function partialOf(items, expected) {
  const total = Number(expected);
  return Number.isFinite(total) && total > items.length
    ? { available: true, partial: true, expected: total, items }
    : { available: true, items };
}

export function automationRiskCandidates(analysis, riskCode, countKey) {
  const items = (analysis.findingsPreview || [])
    .filter((f) => (f.r || []).some((r) => r.c === riskCode))
    .map((f) => ({
      id: f.id,
      name: f.n || null,
      enabled: f.e === 1,
      triggerType: f.t || null,
      projectCount: f.p ?? null,
      hosts: (f.r || []).find((r) => r.c === riskCode)?.h || [],
    }));
  return partialOf(items, analysis.estate?.health?.[countKey]);
}

export function filterCandidates(withFindings, code) {
  const items = withFindings
    .filter((f) => (f.findings || []).some((x) => x.code === code))
    .map((f) => ({
      id: String(f.id),
      name: f.name || null,
      ownerName: f.owner?.displayName || f.ownerName || null,
      subscriptionCount: Number(f.subscriptionCount) || 0,
      favouritedCount: Number(f.favouritedCount) || 0,
      lastUsedAt: f.lastUsedAt || null,
    }));
  return { available: true, items };
}

export function dashboardCandidates(dashboards, code) {
  // Broken gadgets are only known for gadgets whose filter was probed. A snapshot built before
  // the probe existed has filter gadgets with no state at all, and an empty list from it is
  // "not checked", not "clean". (A site with no filter gadgets is genuinely clean.)
  if (code === "broken-gadget") {
    const filterGadgets = dashboards.flatMap((d) => d.gadgets || []).filter((g) => g.filterId);
    if (filterGadgets.length && !filterGadgets.some((g) => g.filterState)) {
      return { available: false, reason: "not-probed", items: [] };
    }
  }
  const summary = summarizeDashboards(dashboards);
  const items = summary.dashboards
    .filter((d) => (d.findings || []).some((x) => x.code === code))
    .map((d) => ({
      id: String(d.id),
      name: d.name || null,
      ownerName: d.owner?.displayName || d.ownerName || null,
      popularity: Number(d.popularity) || 0,
      gadgetCount: d.gadgetCount ?? null,
      // The broken gadgets themselves, for the broken-gadget playbook; empty for the rest.
      brokenGadgets: (d.findings || []).find((x) => x.code === "broken-gadget")?.gadgets || [],
    }));
  return { available: true, items };
}

// Priorities or resolutions no issue carries. Unavailable until the issue crawl has measured
// usage -- before that every value would read as unused.
export function estateUnusedValues(inv, listKey, kind) {
  if (!inv.usageMeasured) return { available: false, reason: "no-usage", items: [] };
  return {
    available: true,
    items: (inv[listKey] || [])
      .filter((v) => v.issueCount === 0)
      .map((v) => ({ id: String(v.id), kind, name: v.name, isDefault: Boolean(v.isDefault) })),
  };
}

export function estateGroups(inv, listKey) {
  const insights = summarizeEstateInsights({
    resolutions: inv.resolutions,
    priorities: inv.priorities,
    listLimit: Infinity,
  });
  return { available: true, items: insights[listKey].map((g) => ({ id: g.key, ...g })) };
}

// ── The selectors ──────────────────────────────────────────────────────────
//
// `source` names the inventory a selector reads; the resolver's CANDIDATE_SOURCES loads it.

const access = (select) => ({ source: "access", select });
const estate = (select) => ({ source: "estate", select });
const fields = (reasonsOf) => ({ source: "fields", select: (all) => fieldCandidates(all, reasonsOf) });
const workflow = (pick) => ({ source: "workflow", select: (w) => ({ available: true, items: pick(w) }) });
const projects = (pick) => ({ source: "projects", select: (p) => ({ available: true, items: pick(p) }) });
const filters = (code) => ({ source: "filters", select: (withFindings) => filterCandidates(withFindings, code) });
const dashboards = (code) => ({ source: "dashboards", select: (all) => dashboardCandidates(all, code) });
const automationRisk = (riskCode, countKey) => ({
  source: "automationAnalysis",
  select: (analysis) => automationRiskCandidates(analysis, riskCode, countKey),
});
const fieldConfigs = (select) => ({ source: "fieldConfigs", select });
const workflowRules = (select) => ({ source: "workflowRules", select });

export const CANDIDATE_SELECTORS = {
  // ── Access ──
  "permission-risky": access((inv) => ({
    available: true,
    items: inv.permissions.governance.riskySchemes.map(withStringId),
  })),
  "access-unused-schemes": access((inv) => {
    const tag = (type, list) =>
      list.map((sc) => ({ id: `${type}:${sc.id}`, type, schemeId: String(sc.id), name: sc.name }));
    return {
      available: true,
      items: [
        ...tag("permission", inv.permissions.governance.unusedSchemes),
        ...tag("security", inv.security.governance.unusedSchemes),
        ...tag("notification", inv.notifications.governance.unusedSchemes),
      ],
    };
  }),
  "security-broken-levels": access((inv) => {
    const g = inv.security.governance;
    return {
      available: true,
      items: [
        ...(g.noLevelSchemes || []).map((sc) => ({
          id: `scheme:${sc.id}`,
          kind: "no-levels",
          schemeId: String(sc.id),
          schemeName: sc.name,
        })),
        ...(g.emptyLevels || []).map((l) => ({
          id: `level:${l.schemeId}:${l.levelId}`,
          kind: "empty-level",
          schemeId: String(l.schemeId),
          schemeName: l.schemeName,
          levelId: String(l.levelId),
          levelName: l.levelName,
        })),
      ],
    };
  }),
  "notification-fragile": access((inv) => ({
    available: true,
    items: inv.notifications.governance.fragileSchemes.map(withStringId),
  })),
  "role-empty-admin": access((inv) => ({
    available: true,
    items: inv.roles.governance.projectsMissingAdminActor.map((p) => ({
      id: String(p.projectId ?? p.projectKey),
      projectKey: p.projectKey,
      role: p.role,
    })),
  })),
  // Bounded: grouped by project (bundled past 50), per the playbook's granularity.
  "role-offroster-actors": access((inv) => ({
    available: true,
    items: groupBounded(inv.roles.governance.offRosterMemberships, { keyOf: (m) => m.projectKey, max: 50 }),
  })),
  // The thin-pillar checks (14 Oct 2026): one task per scheme, role or value. Departed-account
  // selectors need the People roster; without it every account would read as gone, so they
  // report "no-roster" rather than a task list of everyone.
  "permission-public-access": access((inv) => ({
    available: true,
    items: inv.permissions.governance.publicSchemes.map(withStringId),
  })),
  "permission-everyone-sensitive": access((inv) => ({
    available: true,
    items: inv.permissions.governance.everyoneSensitiveSchemes.map(withStringId),
  })),
  "permission-direct-grants": access((inv) => ({
    available: true,
    items: inv.permissions.governance.directGrantSchemes.map(withStringId),
  })),
  "permission-departed-grants": access((inv) => {
    const g = inv.permissions.governance;
    if (!g.rosterMeasured) return noRoster;
    return {
      available: true,
      items: g.directGrantSchemes
        .map((sc) => ({ ...sc, id: String(sc.id), grants: sc.grants.filter((x) => x.departed) }))
        .filter((sc) => sc.grants.length),
    };
  }),
  "security-direct-members": access((inv) => ({
    available: true,
    items: inv.security.governance.userMemberSchemes.map(withStringId),
  })),
  "security-departed-members": access((inv) => {
    const g = inv.security.governance;
    if (!g.rosterMeasured) return noRoster;
    return {
      available: true,
      items: g.userMemberSchemes
        .map((sc) => ({ ...sc, id: String(sc.id), members: sc.members.filter((m) => m.departed) }))
        .filter((sc) => sc.members.length),
    };
  }),
  "notification-external-email": access((inv) => ({
    available: true,
    items: inv.notifications.governance.emailRecipientSchemes.map(withStringId),
  })),
  "notification-departed-recipients": access((inv) => {
    const g = inv.notifications.governance;
    if (!g.rosterMeasured) return noRoster;
    return {
      available: true,
      items: g.namedRecipientSchemes
        .map((sc) => ({ ...sc, id: String(sc.id), recipients: sc.recipients.filter((r) => r.departed) }))
        .filter((sc) => sc.recipients.length),
    };
  }),
  // Bounded, like off-roster actors: one task per project, bundled past 50.
  "role-group-actors": access((inv) => ({
    available: true,
    items: groupBounded(inv.roles.governance.userActorMemberships, { keyOf: (m) => m.projectKey, max: 50 }),
  })),
  "role-unused": access((inv) => ({ available: true, items: inv.roles.governance.emptyRoles })),

  // ── Priorities and resolutions ──
  "priority-usage": estate((inv) => estateUnusedValues(inv, "priorities", "priority")),
  "resolution-usage": estate((inv) => estateUnusedValues(inv, "resolutions", "resolution")),
  "estate-defaults": estate((inv) => {
    const missing = (rows) => rows.length > 0 && !rows.some((v) => v.isDefault);
    return {
      available: true,
      items: [
        missing(inv.priorities || []) && {
          id: "priority",
          kind: "priority",
          valueCount: (inv.priorities || []).length,
        },
        missing(inv.resolutions || []) && {
          id: "resolution",
          kind: "resolution",
          valueCount: (inv.resolutions || []).length,
        },
      ].filter(Boolean),
    };
  }),
  "estate-duplicate-priorities": estate((inv) => estateGroups(inv, "priorityDuplicateGroups")),
  "estate-duplicate-resolutions": estate((inv) => estateGroups(inv, "resolutionDuplicateGroups")),

  // ── Filters and dashboards: the same analysis their tabs run, every row ──
  "filters-zombie-subscriptions": filters("subscribed-but-unused"),
  "filters-shared-everyone": filters("shared-with-everyone"),
  "filters-public": filters("shared-publicly"),
  "dashboards-public": dashboards("shared-publicly"),
  "dashboards-broken-gadgets": dashboards("broken-gadget"),
  "dashboards-open-edit": dashboards("editable-by-everyone"),
  "dashboards-empty": dashboards("empty"),
  "dashboards-published-unused": dashboards("published-unused"),

  // ── People ──
  "people-dormant-licences": {
    source: "users",
    select: (inv) => {
      if (!inv.governance?.activityMeasured) return { available: false, reason: "no-activity", items: [] };
      return {
        available: true,
        items: inv.users
          .filter((u) => u.dormant === true)
          .map((u) => ({
            id: u.accountId,
            accountId: u.accountId,
            displayName: u.displayName,
            lastActivityAt: u.lastActivityAt,
            products: (u.applications || []).map((a) => a.name),
            groups: (u.groups || []).map((g) => g.name),
            ownedCount: (u.ownedFilters || 0) + (u.ownedDashboards || 0) + (u.authoredRules || 0),
          })),
      };
    },
  },

  // ── Issue types ──
  "issue-type-hierarchy": {
    source: "issueTypes",
    select: (insights) => ({
      available: true,
      items: insights.flaggedSchemes.map((sc) => ({
        id: sc.schemeId,
        schemeId: sc.schemeId,
        name: sc.name,
        projectCount: sc.projectCount,
        flags: sc.flags.map((f) => f.message),
      })),
    }),
  },
  "issue-type-unused-schemes": {
    source: "issueTypes",
    select: (insights) => ({
      available: true,
      items: insights.unusedSchemes.map((sc) => ({ id: sc.schemeId, schemeId: sc.schemeId, name: sc.name })),
    }),
  },

  // ── Assets ──
  "asset-broken-references": {
    source: "assets",
    select: ({ inv, insights }) => {
      const attrById = new Map(inv.attributes.map((x) => [String(x.id), x]));
      const typeById = new Map(inv.objectTypes.map((t) => [String(t.id), t]));
      return {
        available: true,
        items: insights.brokenReferences.map((r) => ({
          ...r,
          schemaId: attrById.get(String(r.id))?.schemaId ?? typeById.get(String(r.objectTypeId))?.schemaId ?? null,
          objectTypeName: typeById.get(String(r.objectTypeId))?.name ?? null,
        })),
      };
    },
  },
  "asset-broken-hierarchy": {
    source: "assets",
    select: ({ insights }) => ({ available: true, items: insights.brokenHierarchy }),
  },
  "asset-bare-types": { source: "assets", select: ({ insights }) => ({ available: true, items: insights.bareTypes }) },

  // ── Fields ──
  "field-admin-attention": fields((f) => (f.findings?.tags?.adminAttention ? f.findings.reasons : null)),
  "field-risky": fields((f) =>
    f.findings?.tags?.risky ? f.findings.reasons.filter((r) => r.category === "risky") : null,
  ),
  "field-global-context-low-usage": fields(reasonsWithCode("global-context-low-usage")),
  "field-dead-configuration": fields(reasonsWithCode("dead-configuration")),
  "field-stale": fields(reasonsWithCode("stale")),
  "field-context-sprawl": fields(reasonsWithCode("context-sprawl")),
  "field-missing-description": fields(reasonsWithCode("missing-description")),

  // ── Workflows ──
  "workflow-duplicate-statuses": workflow((w) =>
    w.duplicateGroups.map((g) => ({
      id: g.key,
      key: g.key,
      kind: g.kind,
      count: g.count,
      statuses: g.statuses.map((st) => {
        const statusId = String(st.statusId ?? st.id);
        return {
          statusId,
          name: st.name,
          issueCount: w.hasIssueCounts ? Number(w.issueCounts.get(statusId) ?? 0) : null,
        };
      }),
    })),
  ),
  "rule-only-statuses": workflow((w) =>
    w.orphans
      .filter((o) => o.ruleOnly)
      .map((o) => ({
        id: String(o.statusId),
        name: o.name,
        automationRuleCount: o.automationRuleCount ?? null,
        issueCount: o.issueCount ?? null,
      })),
  ),
  "unreachable-with-issues": workflow((w) =>
    w.orphans
      .filter((o) => !o.ruleOnly && (o.issueCount ?? 0) > 0)
      .map((o) => ({ id: String(o.statusId), name: o.name, issueCount: o.issueCount })),
  ),
  "workflow-scheme-structure": workflow((w) =>
    w.balance
      .filter((b) => b.flags.length > 0)
      .map((b) => ({
        id: b.schemeId,
        name: b.name,
        projectCount: b.projectCount,
        flags: b.flags.map((f) => f.message),
      })),
  ),
  "workflow-broken-references": workflowRules((insights) => {
    const byWorkflow = new Map();
    for (const ref of insights.brokenRefs) {
      if (!byWorkflow.has(ref.workflowName)) byWorkflow.set(ref.workflowName, []);
      byWorkflow.get(ref.workflowName).push({
        type: ref.type,
        id: ref.id,
        where: ref.status ? `status ${ref.status.name}` : `transition ${ref.transitionId}`,
      });
    }
    return {
      available: true,
      items: [...byWorkflow.entries()].map(([name, refs]) => ({ id: name, name, count: refs.length, refs })),
    };
  }),
  "workflows-inactive": workflowRules((insights) => ({
    available: true,
    items: insights.inactive.map((w) => ({
      id: w.name,
      name: w.name,
      statusCount: w.statusCount,
      ruleCount: w.ruleCount,
    })),
  })),

  // ── Field schemes / configurations: all three from the stored findings ──
  "fieldconfig-required-hidden": fieldConfigs((inv) => ({
    available: true,
    items: inv.configs
      .filter((c) => c.requiredHidden.length)
      .map((c) => ({
        id: c.id,
        sourceId: c.sourceId,
        name: c.name,
        fieldNames: c.requiredHidden.map((f) => f.fieldName),
        usedBy: (c.routes || []).map((r) => `${r.schemeName} (${r.workTypeName})`),
      })),
  })),
  "fieldconfig-unused": fieldConfigs((inv) => {
    const pick = (rows, kind) =>
      rows
        .filter((r) => r.codes.includes("unused"))
        .map((r) => ({ id: r.id, sourceId: r.sourceId, name: r.name, kind }));
    return { available: true, items: [...pick(inv.schemes, "scheme"), ...pick(inv.configs, "config")] };
  }),
  "fieldconfig-duplicates": fieldConfigs((inv) => {
    const groups = [];
    for (const [rows, kind] of [
      [inv.schemes, "scheme"],
      [inv.configs, "config"],
    ]) {
      const byId = new Map(rows.map((r) => [r.id, r]));
      const byKeep = new Map();
      for (const row of rows) {
        if (!row.duplicateOf) continue;
        if (!byKeep.has(row.duplicateOf)) byKeep.set(row.duplicateOf, [row.duplicateOf]);
        byKeep.get(row.duplicateOf).push(row.id);
      }
      for (const [keep, members] of byKeep) {
        groups.push({
          id: `${kind}:${keep}`,
          kind,
          keep,
          keepName: byId.get(keep)?.name || keep,
          members,
          memberNames: members.map((m) => byId.get(m)?.name || m),
          memberSourceIds: members.map((m) => byId.get(m)?.sourceId || null),
          name: byId.get(keep)?.name || keep,
          count: members.length,
        });
      }
    }
    return { available: true, items: groups };
  }),

  // ── Projects ──
  "project-over-configured": projects(({ insights }) => {
    const idle = new Set(insights.idleOverConfigured.map((p) => p.projectKey));
    return insights.overConfigured.map((p) => ({ id: p.projectKey, ...p, idle: idle.has(p.projectKey) }));
  }),
  "unused-projects": projects(({ insights }) => insights.unusedProjects.map((p) => ({ id: p.projectKey, ...p }))),
  "stale-projects": projects(({ insights }) => insights.staleProjects.map((p) => ({ id: p.projectKey, ...p }))),
  "projects-fell-off": projects(({ adoption }) => adoptionFlagged(adoption, "fellOff")),
  "projects-never-adopted": projects(({ adoption }) => adoptionFlagged(adoption, "neverAdopted")),

  // ── Automation ──
  "automation-disabled": {
    source: "automationDirectory",
    select: (directory) => ({
      available: true,
      items: [...hydrateRuleDirectory(directory).values()].filter((r) => !r.enabled),
    }),
  },
  "automation-credentials": automationRisk("embedded-credential", "credentialRuleCount"),
  "automation-external": automationRisk("external-http", "externalHttpCount"),
  "automation-inert": automationRisk("no-actions", "noActionCount"),
  "automation-self-triggering": {
    source: "automationCascades",
    select: ({ analysis, directory }) => {
      const rules = directory ? hydrateRuleDirectory(directory) : new Map();
      const seen = new Map();
      for (const c of analysis.cascades || []) {
        if (!c.selfTriggering || seen.has(String(c.sourceId))) continue;
        const rule = rules.get(c.sourceId) || rules.get(Number(c.sourceId)) || {};
        seen.set(String(c.sourceId), { ...rule, id: c.sourceId, name: rule.name || c.sourceName || null });
      }
      return partialOf([...seen.values()], analysis.estate?.health?.selfTriggeringCount);
    },
  },
};
