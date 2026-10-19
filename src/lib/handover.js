// The handover report: everything that depends on one person's account, ordered by what
// happens when that account is removed. Built for offboarding, the question every Jira admin
// is asked and Jira itself does not answer: "this person is leaving -- what breaks?"
//
// Pure. The resolver (src/resolvers/people.js getHandoverReport) gathers the inputs:
//
//   details       getUserDetails' footprint (owned filters, dashboards, rules; rules naming
//                 them; user-field values; scheme grants)
//   boards        the board snapshot, each with its backing filter id, or null when unbuilt
//   gadgets       dashboard gadgets reading any of the person's filters, or null when unbuilt
//   projectsLed   projects whose lead is this account, or null when the read failed
//   openAssigned  open issues assigned to them (a count), or null when Jira could not say
//
// Sections run from consequence to housekeeping: what is deleted with the account, what breaks
// because of that, work that will keep arriving for nobody, then what merely names them. An
// input that could not be read makes its section "unmeasured" with the reason -- never an
// empty list, which would tell an admin there is nothing to hand over.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function section(key, title, why, action, items, { available = true, reason = null } = {}) {
  return {
    key,
    title,
    why,
    action,
    items: available ? items : [],
    count: available ? items.length : null,
    status: !available ? "unmeasured" : items.length ? "action" : "clear",
    reason: available ? null : reason,
  };
}

export function buildHandoverReport({
  details,
  boards = null,
  gadgets = null,
  projectsLed = null,
  openAssigned = null,
} = {}) {
  if (!details?.available) {
    return { available: false, reason: details?.reason || "no-roster", sections: [] };
  }
  const owned = { filters: details.ownedFilters || [], dashboards: details.ownedDashboards || [] };
  const ownership = details.ownershipAvailable || {};
  const filterIds = new Set(owned.filters.map((f) => String(f.id)));
  const filterName = new Map(owned.filters.map((f) => [String(f.id), f.name || `Filter ${f.id}`]));
  const ownDashboardIds = new Set(owned.dashboards.map((d) => String(d.id)));

  // 1. Deleted with the account.
  const deleted = section(
    "deleted",
    "Deleted with the account",
    "Jira deletes a saved filter or dashboard when its owner's account is removed.",
    "Change the owner of each one before the account is removed.",
    [
      ...owned.filters.map((f) => ({
        kind: "filter",
        id: String(f.id),
        name: f.name || `Filter ${f.id}`,
        url: f.viewUrl || null,
        detail: "Saved filter",
      })),
      ...owned.dashboards.map((d) => ({
        kind: "dashboard",
        id: String(d.id),
        name: d.name || `Dashboard ${d.id}`,
        url: d.viewUrl || null,
        detail: "Dashboard",
      })),
    ],
    {
      available: ownership.filters !== false && ownership.dashboards !== false,
      reason: "Build the filter and dashboard inventories to see what this person owns.",
    },
  );

  // 2. Breaks downstream: boards and gadgets built on those filters. A gadget on a dashboard
  // they own is already counted above -- the whole dashboard goes -- so it is not repeated.
  const brokenBoards = (boards || [])
    .filter((b) => b.filterId && filterIds.has(String(b.filterId)))
    .map((b) => ({
      kind: "board",
      id: String(b.boardId),
      name: b.name || `Board ${b.boardId}`,
      url: null,
      projectKey: b.locationKey || null,
      detail: `Board${b.locationKey ? ` in ${b.locationKey}` : ""}, built on "${filterName.get(String(b.filterId))}"`,
    }));
  const brokenGadgets = (gadgets || [])
    .filter((g) => filterIds.has(String(g.filterId)) && !ownDashboardIds.has(String(g.dashboardId)))
    .map((g) => ({
      kind: "gadget",
      id: `${g.dashboardId}:${g.gadgetTitle || g.filterId}`,
      name: `${g.dashboardName || `Dashboard ${g.dashboardId}`}${g.gadgetTitle ? ` › ${g.gadgetTitle}` : ""}`,
      url: g.viewUrl || null,
      detail: `Gadget reading "${filterName.get(String(g.filterId))}"${g.ownerName ? `, on ${g.ownerName}'s dashboard` : ""}`,
    }));
  const breaks = section(
    "breaks",
    "Breaks when those filters go",
    "A board or gadget built on a deleted filter stops working, and its owner is not told.",
    "Reassigning the filters above prevents all of these.",
    [...brokenBoards, ...brokenGadgets],
    {
      available: !owned.filters.length || (boards !== null && gadgets !== null),
      reason: "Build the board and dashboard inventories to see what is built on this person's filters.",
    },
  );

  // 3. Work that keeps arriving for nobody.
  const routing = (details.referencedInRules || []).filter((r) => r.direction === "write");
  const work = [];
  if (typeof openAssigned === "number" && openAssigned > 0) {
    work.push({
      kind: "issues",
      id: "open-assigned",
      name: plural(openAssigned, "open issue"),
      url: null,
      detail: "Assigned to them and not done",
      jql: `assignee = "${details.user?.accountId}" AND statusCategory != Done`,
    });
  }
  for (const p of projectsLed || []) {
    work.push({
      kind: "project",
      id: String(p.id),
      name: p.name || p.key,
      url: null,
      projectKey: p.key || null,
      detail: `Project lead${p.key ? ` of ${p.key}` : ""}; also the default assignee where the project assigns to its lead`,
    });
  }
  for (const r of routing) {
    work.push({
      kind: "rule",
      id: String(r.id),
      name: r.name,
      url: null,
      detail: `Automation rule that assigns or sets them${r.enabled === false ? " (disabled)" : ""}`,
    });
  }
  const unreadable = [
    openAssigned === null && "open issues assigned to them",
    projectsLed === null && "projects they lead",
    details.automationRefsAvailable === false && "automation rules that route work to them",
  ].filter(Boolean);
  const workSection = section(
    "work",
    "Work routed to them",
    "Work keeps arriving for this account after it is gone, and nobody sees it.",
    "Reassign the open issues, change the project lead, and point each rule at someone else.",
    work,
  );
  if (unreadable.length) workSection.reason = `Could not read ${unreadable.join(", ")}; check those by hand.`;

  // 4. Rules they own.
  const rules = section(
    "rules",
    "Automation rules they own",
    "A rule's owner receives its error notifications. Nobody will once this account is gone.",
    "Make someone who maintains each rule its owner.",
    (details.authoredRules || []).map((r) => ({
      kind: "rule",
      id: String(r.id),
      name: r.name,
      url: null,
      detail: r.enabled === false ? "Disabled" : "Enabled",
    })),
    {
      available: ownership.rules !== false,
      reason: "Rule ownership needs a rule export that carries account ids. Import one on the Automation tab.",
    },
  );

  // 5. Issues that name them in a user field: the values stay, pointing at a gone account.
  const named = section(
    "named",
    "Issues that name them",
    "User-picker values stay on the issues and show a deactivated user.",
    "Decide whether each field's values should move to someone else.",
    (details.fieldAppearances || []).map((f) => ({
      kind: "field",
      id: f.fieldId,
      name: f.fieldName,
      url: null,
      detail: `${plural(f.issueCount ?? 0, "issue")} hold them in this field`,
    })),
    {
      available: details.fieldAppearancesAvailable !== false,
      reason: "Run a full scan to see which user fields hold this person.",
    },
  );

  // 6. Access to remove.
  const access = section(
    "access",
    "Access to remove",
    "Direct grants outlive the reason they were made. Groups and licences are listed so nothing is missed.",
    "Remove direct scheme grants, then the group memberships and licences.",
    [
      ...(details.grantedBySchemes || []).map((g, i) => ({
        kind: "grant",
        id: `grant-${i}`,
        name: g.schemeName,
        url: null,
        detail: `Named directly in a ${g.schemeType} scheme (${g.contextLabel || g.context})`,
      })),
      ...(details.user?.groups || []).map((g) => ({
        kind: "group",
        id: `group-${g.id || g.name}`,
        name: g.name || g.id,
        url: null,
        detail: "Group membership",
      })),
      ...(details.user?.applications || []).map((a) => ({
        kind: "licence",
        id: `app-${a.key}`,
        name: a.name || a.key,
        url: null,
        detail: "Product licence",
      })),
    ],
    {
      available: details.accessGrantsAvailable !== false,
      reason: "Build the access inventory to see which schemes name this person.",
    },
  );

  const sections = [deleted, breaks, workSection, rules, named, access];
  return {
    available: true,
    person: {
      accountId: details.user?.accountId || null,
      displayName: details.user?.displayName || details.user?.accountId || null,
      active: details.user?.active ?? null,
      inRoster: Boolean(details.inRoster),
    },
    summary: summarize({ deleted, brokenBoards, brokenGadgets, openAssigned, projectsLed, routing }),
    // The items to deal with before the account is removed: the first three sections.
    beforeRemoval: [deleted, breaks, workSection].reduce((n, s) => n + (s.count || 0), 0),
    sections,
  };
}

// One sentence an admin can paste into the leaver's ticket.
export function summarize({
  deleted,
  brokenBoards = [],
  brokenGadgets = [],
  openAssigned = null,
  projectsLed = null,
  routing = [],
}) {
  const parts = [];
  const filters = deleted.items.filter((i) => i.kind === "filter").length;
  const dashboards = deleted.items.filter((i) => i.kind === "dashboard").length;
  if (filters || dashboards) {
    const what = [filters && plural(filters, "filter"), dashboards && plural(dashboards, "dashboard")]
      .filter(Boolean)
      .join(" and ");
    const breaking = [
      brokenBoards.length && plural(brokenBoards.length, "board"),
      brokenGadgets.length && plural(brokenGadgets.length, "dashboard gadget"),
    ]
      .filter(Boolean)
      .join(" and ");
    parts.push(`Removing this account deletes ${what}${breaking ? `, breaking ${breaking}` : ""}.`);
  }
  const work = [
    typeof openAssigned === "number" && openAssigned > 0 && `${plural(openAssigned, "open issue")} assigned to them`,
    projectsLed?.length && `${plural(projectsLed.length, "project")} they lead`,
    routing.length && `${plural(routing.length, "automation rule")} routing work to them`,
  ].filter(Boolean);
  if (work.length) parts.push(`Hand over ${work.join(", ")}.`);
  return parts.length ? parts.join(" ") : "Nothing is deleted with this account and no work is routed to it.";
}
