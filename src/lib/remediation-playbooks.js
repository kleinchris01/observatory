// The remediation playbook for each governance finding Observatory can turn into Jira work.
//
// Keyed by the health-score dimension key (see health-score.js). Each entry produces:
//   - epicSummary(count)      -- the epic title
//   - epicDescription(ctx)    -- the remediation *strategy*, as a plain-text template
//   - taskSummary(item)       -- one task's title
//   - taskDescription(item)   -- step-by-step for fixing that one item
//   - labels                  -- applied to every issue it creates
//
// The templates use the tiny markup renderADF() understands: "## " headings, "- " bullets,
// blank lines between paragraphs. Kept as text here so the playbooks stay readable and
// reviewable; the resolver renders them to ADF at create time.
//
// An `item` is whatever the finding's own inventory returns for one thing to fix. Every
// playbook is defensive about missing fields -- a task with a thin item still reads.

import { jiraLinks as L, md } from "./jira-links.js";

const BASE_LABEL = "observatory-remediation";

const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);

export const REMEDIATION_PLAYBOOKS = {
  "filter-ownership": {
    pillar: "filters",
    epicSummary: (n) => `Reassign ${n} saved filter${n === 1 ? "" : "s"} with no live owner`,
    epicDescription: ({ count = 0 } = {}) => `
## Why this matters
Jira deletes a saved filter when its owner's account is removed, and every board and
dashboard built on that filter breaks at the same moment with no warning to anyone.
${count} filter${count === 1 ? " has" : "s have"} an owner that is deactivated or no longer on the licensed roster.

## Strategy
Work through the child tasks. For each filter, decide who should own it now -- a person on
the team who relies on it, or a shared service account -- and change the owner. This changes
ownership only; the filter's JQL and its shares are untouched.

## Definition of done
Every child task is closed and the next Observatory scan reports zero filters with no live
owner.
`,
    taskSummary: (it) => `Reassign filter "${it.name || it.id || "(unknown)"}" (${it.id})`,
    taskDescription: (it) => `
## The filter
Name: ${it.name || "(unnamed)"}
Filter id: ${it.id || "(unknown)"}
Current owner: ${it.ownerName || "unknown"} (${it.ownerActive === false ? "deactivated" : "not on the licensed roster"})
${it.subscriptionCount ? `Subscriptions: ${it.subscriptionCount}` : ""}

## Steps
- Open the filter in Jira by its id, or find it under Filters -> View all filters.
- Choose a new owner: someone on the team who uses it, or a shared account that will not be deprovisioned.
- Use Details -> Change owner (a filter admin or Jira admin can do this).
- Confirm any boards or dashboards backed by this filter still resolve after the change.

## Done when
The filter has an active owner and the next Observatory scan no longer flags it.
`,
  },

  "dashboard-ownership": {
    pillar: "dashboards",
    epicSummary: (n) => `Reassign ${n} dashboard${n === 1 ? "" : "s"} with no live owner`,
    epicDescription: ({ count = 0 } = {}) => `
## Why this matters
A dashboard is deleted with its owner's account. A wall-screen dashboard owned by somebody
who left has a deletion date nobody has written down. ${count} dashboard${count === 1 ? " is" : "s are"} in this state.

## Strategy
For each dashboard, transfer ownership to an active account -- ideally a shared one for
anything on a wall screen or used by a whole team.

## Definition of done
Every child task is closed and the next scan reports zero dashboards with no live owner.
`,
    taskSummary: (it) => `Reassign dashboard "${it.name || it.id || "(unknown)"}" (${it.id})`,
    taskDescription: (it) => `
## The dashboard
Name: ${it.name || "(unnamed)"}
Dashboard id: ${it.id || "(unknown)"}
Current owner: ${it.ownerName || "unknown"}
${it.popularity ? `Favourited by: ${it.popularity}` : ""}

## Steps
- Open the dashboard in Jira.
- Use the ... menu -> Share dashboard -> change owner, or ask a Jira admin to transfer it.
- Set the owner to an active account; use a shared account for anything team-wide.

## Done when
The dashboard has an active owner and the next Observatory scan no longer flags it.
`,
  },

  "user-licence-hygiene": {
    pillar: "users",
    epicSummary: (n) => `Remove ${n} deactivated account${n === 1 ? "" : "s"} from Jira access groups`,
    epicDescription: ({ count = 0 } = {}) => `
## Why this matters
${count} account${count === 1 ? " is" : "s are"} still in a Jira access group despite being deactivated. Each is a seat
being paid for, and a login that -- if the account is ever reactivated -- comes back with
its old access intact.

## Strategy
Remove each account from the access group that grants it a Jira licence. Confirm first that
the account is genuinely gone and not deactivated pending a return.

## Definition of done
Every child task is closed and the next scan reports zero deactivated licence holders.
`,
    taskSummary: (it) => `Remove ${it.displayName || it.accountId || "(unknown)"} from its Jira access group`,
    taskDescription: (it) => `
## The account
Name: ${it.displayName || "(unknown)"}
Account id: ${it.accountId || it.id || "(unknown)"}
${it.groups ? `In groups: ${Array.isArray(it.groups) ? it.groups.join(", ") : it.groups}` : ""}

## Steps
- Confirm the account is deactivated and not expected back.
- In admin.atlassian.com -> Groups, remove the account from every group that grants a Jira product licence.
- Reassign anything the account owns (see the ownership-continuity finding) before or alongside this.

## Done when
The account is in no Jira licence group and the seat is freed.
`,
  },

  "user-ownership": {
    pillar: "users",
    epicSummary: (n) => `Reassign ${n} filter${n === 1 ? "" : "s"}, dashboard${n === 1 ? "" : "s"} and rule${n === 1 ? "" : "s"} owned by gone accounts`,
    epicDescription: ({ count = 0 } = {}) => `
## Why this matters
${count} owned filter${count === 1 ? ", dashboard or rule belongs" : "s, dashboards and rules belong"} to an account that is not on the
licensed roster. It works until Jira garbage-collects the account, and then every board and
dashboard built on it breaks at once.

## Strategy
Reassign each artifact to a live owner before the accounts are purged.

## Definition of done
Every child task is closed and the next scan reports zero orphaned ownership.
`,
    taskSummary: (it) => `Reassign ${it.kind || "artifact"} "${it.name || it.id || "(unknown)"}"`,
    taskDescription: (it) => `
## The artifact
Type: ${it.kind || "unknown (filter / dashboard / automation rule)"}
Name: ${it.name || "(unnamed)"}
Id: ${it.id || "(unknown)"}
Owner: ${it.ownerName || "unknown"} (not on the licensed roster)

## Steps
- Open the artifact in Jira by its id.
- Change its owner to an active account -- a person who uses it, or a shared account.
- For an automation rule, also check the rule's actor if it runs "as" a specific user.

## Done when
The artifact has a live owner and the next Observatory scan no longer flags it.
`,
  },

  "status-reachability": {
    pillar: "workflows",
    epicSummary: (n) => `Retire ${n} status${n === 1 ? "" : "es"} no scheme and no rule reaches`,
    epicDescription: ({ count = 0 } = {}) => `
## Why this matters
${count} status${count === 1 ? " is" : "es are"} in the catalogue that no workflow scheme and no automation rule can put
an issue into. They are clutter in every status picker and every board column dropdown.

## Strategy
For each status, confirm no historical issue still sits in it, then delete it from Jira's
status admin. A status that has held issues cannot be deleted until those issues are moved.

## Definition of done
Every child task is closed and the next scan reports zero unreachable statuses.
`,
    taskSummary: (it) => `Retire status "${it.name || it.id || "(unknown)"}" (${it.id})`,
    taskDescription: (it) => `
## The status
Name: ${it.name || "(unnamed)"}
Status id: ${it.id || "(unknown)"}
${it.category ? `Category: ${it.category}` : ""}
${it.everCount != null ? `Issues that have ever been in it: ${it.everCount}` : ""}

## Steps
- Confirm no workflow uses this status (the Workflows tab lists which do).
- Confirm no automation rule transitions into it.
- If any issue is currently in this status, bulk-move those issues to the correct status first.
- Delete the status in Jira -> Issues -> Statuses.

## Done when
The status is deleted and the next Observatory scan no longer flags it.
`,
  },

  "field-cleanup": {
    pillar: "fields",
    epicSummary: (n) => `Review ${n} custom field${n === 1 ? "" : "s"} no issue has ever filled in`,
    epicDescription: ({ count = 0 } = {}) => `
## Why this matters
${count} custom field${count === 1 ? " has" : "s have"} no populated issue anywhere on the site. Some are orphaned
outright (no context, no configuration); the rest are configured for projects that have never
used them. Each one is still in every field picker, every screen admin search, and every "add
field" dropdown a project admin sees.

## Strategy
For each field, confirm the finding is current (a scan can be stale), then delete it from
Jira. Field deletion is destructive and cannot be undone, so this always creates a
Jira task per field for a human to actually action -- Observatory never deletes a field
itself.

## Definition of done
Every child task is closed and the next Observatory scan reports zero orphaned fields.
`,
    taskSummary: (it) => `Delete orphaned field "${it.name || it.id || "(unknown)"}" (${it.id})`,
    taskDescription: (it) => `
## The field
Name: ${it.name || "(unnamed)"}
Field id: ${it.id || "(unknown)"}
Type: ${it.type || "unknown"}
${it.description ? `Current description: ${it.description}` : "No description set."}

## Why it is flagged
${it.reason === "configured-no-issues"
    ? "Configured for at least one project, but no issue in any of them has a value in it."
    : "No project contexts, no configured screens, and no populated issues found in the last Observatory scan."}

## Steps
- Re-check the field in Observatory's Field Browser to confirm it is still orphaned (a
  screen or context change since the scan can un-orphan a field).
- Search for the field id in any saved filters, dashboards or automation rules before
  deleting -- Observatory's own dependency graph is the fastest way to check this.
- If it is configured for projects that never use it, remove those contexts; if nothing
  needs it at all, delete the field in Jira -> Issues -> Custom fields.

## Done when
The field no longer exists in Jira and the next Observatory scan no longer flags it.
`,
  },

  "board-backing": {
    pillar: "boards",
    epicSummary: (n) => `Fix ${n} board${n === 1 ? "" : "s"} with a broken backing filter`,
    epicDescription: ({ count = 0 } = {}) => `
## Why this matters
${count} board${count === 1 ? " has" : "s have"} no backing filter, name one that was deleted, or run on a filter
whose owner is deactivated. A board with no live backing filter falls back to showing every
issue in the site.

## Strategy
For each board, point it at a valid saved filter, or reassign the backing filter to an
active owner.

## Definition of done
Every child task is closed and the next scan reports zero boards with a broken backing filter.
`,
    taskSummary: (it) => `Fix backing filter for board "${it.name || it.id || "(unknown)"}"`,
    taskDescription: (it) => `
## The board
Name: ${it.name || "(unnamed)"}
Board id: ${it.boardId || it.id || "(unknown)"}
Type: ${it.type || "unknown"}
Backing filter: ${it.filterId ? `id ${it.filterId} (deleted or unreadable)` : "none set"}

## Steps
- Open the board in Jira -> Board settings -> General.
- Set the board's filter to a saved filter that returns the intended issues.
- If the filter exists but its owner is gone, reassign the filter to an active owner instead.
- Check the board's columns still map the right statuses afterwards.

## Done when
The board runs on a live saved filter and the next Observatory scan no longer flags it.
`,
  },

  "filter-duplicates": {
    pillar: "filters",
    epicSummary: (n) => `Consolidate ${n} group${n === 1 ? "" : "s"} of duplicate saved filters`,
    epicDescription: ({ count = 0 } = {}) => `
## Why this matters
${count} group${count === 1 ? " of filters shares" : "s of filters share"} the exact same JQL. Each duplicate is a
separate thing to maintain, a separate entry in every picker, and a separate answer when
someone asks "which filter has the open bugs" -- untidy rather than broken, but the most
numerous filter finding on most sites by a wide margin.

## Strategy
For each group, pick the filter with the most subscriptions or the most recent activity as
the survivor, point anything using the others at it (boards, dashboards, subscriptions),
then delete the rest.

## Definition of done
Every child task is closed and the next Observatory scan reports zero duplicate groups.
`,
    taskSummary: (it) => `Consolidate ${it.count || 0} filters sharing one JQL (keep one, delete the rest)`,
    taskDescription: (it) => `
## The group
${(it.filters || []).length} filter${(it.filters || []).length === 1 ? "" : "s"} share this JQL:
${it.jql || "(JQL unavailable)"}

Filters in this group:
${(it.filters || []).map((f) => `- ${f.name || "(unnamed)"} (${f.id})${f.ownerName ? `, owned by ${f.ownerName}` : ""}`).join("\n") || "- (list unavailable)"}

## Steps
- Pick a survivor -- the one with the most subscriptions, or the most recently used.
- Check every board and dashboard for the other filters in this group and repoint them at
  the survivor.
- Delete the remaining filters in Jira -> Filters -> the "..." menu -> Delete.

## Done when
Only the survivor remains and the next Observatory scan no longer groups it with anything.
`,
  },

  "filter-scope": {
    pillar: "filters",
    epicSummary: (n) => `Fix ${n} saved filter${n === 1 ? "" : "s"} whose JQL names something that no longer exists`,
    epicDescription: ({ count = 0 } = {}) => `
## Why this matters
${count} saved filter${count === 1 ? "" : "s"} name a project or issue type in their JQL that the site does not
define. A clause like \`project = "Old Team"\` or \`issuetype = "Sub-bug"\` that can never
match returns fewer issues than the filter's author expects, silently, with no error to
explain why.

## Strategy
For each filter, open it and correct or remove the clause naming the missing project or
issue type. This is the cheapest filter defect to prove and the easiest to fix -- unlike
most filter findings, it produces a visible wrong-answer rather than a silent one, so it is
usually obvious once you look.

## Definition of done
Every child task is closed and the next Observatory scan reports zero broken scope
references.
`,
    taskSummary: (it) => `Fix the ${it.refKind || "scope"} reference in filter "${it.name || it.id || "(unknown)"}"`,
    taskDescription: (it) => `
## The filter
Name: ${it.name || "(unnamed)"}
Filter id: ${it.id || "(unknown)"}
${it.ownerName ? `Owner: ${it.ownerName}` : ""}

## The problem
This filter's JQL names the following ${it.refKind === "type" ? "issue type(s)" : "project(s)"} the site does not
define: ${(it.missing || []).join(", ") || "(unavailable)"}

## Steps
- Open the filter in Jira and review its JQL.
- Confirm whether the ${it.refKind === "type" ? "issue type" : "project"} was renamed, deleted, or was always a typo.
- Correct or remove the clause so the filter's JQL only names things that exist.

## Done when
The filter's JQL resolves cleanly and the next Observatory scan no longer flags it.
`,
  },

  "screen-unreachable-fields": {
    pillar: "screens",
    epicSummary: (n) => `Review ${n} field${n === 1 ? "" : "s"} configured for a project but on no screen there`,
    epicDescription: ({ count = 0 } = {}) => `
## Why this matters
${count} field${count === 1 ? " is" : "s are"} configured for a project (it appears in the field's context) but no
screen in that project's chain shows it anywhere -- to any issue type, on any operation. No
one working in Jira can ever fill this field in for that project, even though it is
technically "in scope" there.

## Strategy
For each field/project pair, either add the field to a screen in that project's chain (if
someone needs to set it), or remove the project from the field's context (if it was
configured there by mistake and nobody needs it).

## Definition of done
Every child task is closed and the next Observatory scan reports zero unreachable
field/project pairs.
`,
    taskSummary: (it) => `"${it.fieldName || it.fieldId || "(unknown)"}" is configured but unreachable on any screen`,
    taskDescription: (it) => `
## The field
Name: ${it.fieldName || "(unnamed)"}
Field id: ${it.fieldId || "(unknown)"}

## Why it is flagged
This field is configured for at least one project, but no screen in that project's issue
type -> screen scheme -> screen -> tab chain displays it. It is in scope and unreachable at
the same time.

## Steps
- Check the field's contexts in Jira -> Issues -> Custom fields -> this field -> Contexts,
  to see which projects it is configured for.
- For each project where it should be fillable, add it to the right screen.
- For a project where it should not be configured at all, remove that project from the
  field's context instead.

## Done when
Either a screen shows the field, or the field's context no longer includes the project, and
the next Observatory scan no longer flags the pair.
`,
  },

  "issue-type-reach": {
    pillar: "issueTypes",
    epicSummary: (n) => `Review ${n} issue type${n === 1 ? "" : "s"} on no scheme at all`,
    epicDescription: ({ count = 0 } = {}) => `
## Why this matters
${count} issue type${count === 1 ? " is" : "s are"} defined on the site but assigned to no issue type scheme anywhere.
No project can ever create an issue of this type -- it exists in the catalogue and nowhere
else, taking up a row in every "add issue type" admin screen with nothing behind it.

## Strategy
For each type, either add it to the scheme where it belongs (if a project needs it and this
was an oversight), or delete it (if nothing does).

## Definition of done
Every child task is closed and the next Observatory scan reports zero orphaned issue types.
`,
    taskSummary: (it) => `"${it.name || it.id || "(unknown)"}" is on no issue type scheme`,
    taskDescription: (it) => `
## The issue type
Name: ${it.name || "(unnamed)"}
Type id: ${it.id || "(unknown)"}
${it.subtask ? "This is a sub-task type." : ""}

## Steps
- Confirm with the team whether this type is still needed.
- If it is, add it to the issue type scheme for the project(s) that need it, in Jira ->
  Issue type schemes.
- If it is not, delete the type in Jira -> Issues -> Issue types. A type that has ever been
  used on an issue cannot be deleted until those issues are migrated to another type.

## Done when
The type is either on a scheme or deleted, and the next Observatory scan no longer flags it.
`,
  },

  "issue-type-naming": {
    pillar: "issueTypes",
    epicSummary: (n) => `Consolidate ${n} group${n === 1 ? "" : "s"} of duplicate or near-duplicate issue type names`,
    epicDescription: ({ count = 0 } = {}) => `
## Why this matters
${count} group${count === 1 ? " of issue types shares" : "s of issue types share"} an identical, spacing-only, or
single-character-different name. "Bug" and "Bug " are different types to Jira and the same
word to everyone typing in the create dialog -- a standing source of the wrong type being
picked.

## Strategy
For each group, pick the type that is actually in use (check its scheme membership and
issue count), migrate any issues on the others to it, then delete the duplicates.

## Definition of done
Every child task is closed and the next Observatory scan reports zero duplicate name groups.
`,
    taskSummary: (it) => `Consolidate ${it.count || 0} issue types sharing the name "${it.key || "(unknown)"}"`,
    taskDescription: (it) => `
## The group
${(it.types || []).length} issue type${(it.types || []).length === 1 ? "" : "s"} share this name (${it.kind || "similar"} match):
${(it.types || []).map((t) => `- ${t.name || "(unnamed)"} (${t.id})`).join("\n") || "- (list unavailable)"}

## Steps
- Check each type's scheme membership and issue count to find the one actually in use.
- Bulk-move any issues on the other types to the survivor (Jira -> bulk change -> edit
  issues -> change issue type).
- Delete the duplicate types once no issue references them.

## Done when
Only the survivor remains and the next Observatory scan no longer groups it with anything.
`,
  },

  "asset-schema-hygiene": {
    pillar: "assets",
    epicSummary: (n) => `Review ${n} dead JSM Assets schema${n === 1 ? "" : "s"} for deletion`,
    epicDescription: ({ count = 0 } = {}) => `
## Why this matters
${count} Assets schema${count === 1 ? " has" : "s have"} no object types defined, or types defined but zero objects
in any of them. Each is a schema an admin opens into and finds nothing -- a candidate for
deletion rather than a structure anyone is building on.

## Strategy
For each schema, confirm nobody has started modelling in it (check with the team that owns
the CMDB), then delete it.

## Definition of done
Every child task is closed and the next Observatory scan reports zero dead schemas.
`,
    taskSummary: (it) => `Delete dead Assets schema "${it.name || it.id || "(unknown)"}" (${it.reason || "empty"})`,
    taskDescription: (it) => `
## The schema
Name: ${it.name || "(unnamed)"}
Schema id: ${it.id || "(unknown)"}
Reason flagged: ${it.reason || "unknown"}
Object types: ${it.objectTypeCount ?? "unknown"}
Objects: ${it.objectCount ?? "unknown"}

## Steps
- Confirm with the team that owns JSM Assets that nothing is planned for this schema.
- Delete it in Jira Service Management -> Assets -> this schema -> Schema settings ->
  Delete schema.

## Done when
The schema no longer exists and the next Observatory scan no longer flags it.
`,
  },

  "asset-type-usage": {
    pillar: "assets",
    epicSummary: (n) => `Review ${n} JSM Assets object type${n === 1 ? "" : "s"} with zero objects`,
    epicDescription: ({ count = 0 } = {}) => `
## Why this matters
${count} Assets object type${count === 1 ? " is" : "s are"} defined, non-abstract, and carries zero objects. Each is
a type someone can create in the picker that nothing actually uses -- clutter in the CMDB's
own structure.

## Strategy
For each type, confirm nothing is planned to be modelled with it, then either delete it or
mark it abstract if it exists only as a base for other types.

## Definition of done
Every child task is closed and the next Observatory scan reports zero empty object types.
`,
    taskSummary: (it) => `Review empty Assets object type "${it.name || it.id || "(unknown)"}"`,
    taskDescription: (it) => `
## The object type
Name: ${it.name || "(unnamed)"}
Type id: ${it.id || "(unknown)"}
Schema id: ${it.schemaId || "(unknown)"}

## Why it is flagged
This type is not abstract (it can be instantiated directly) and carries zero objects in the
last measured crawl.

## Steps
- Confirm with the team that owns JSM Assets whether this type is still needed.
- If nothing is planned for it, delete it in the schema's object type tree.
- If it exists only to be a parent for other types, mark it abstract instead of deleting it.

## Done when
The type is either deleted, marked abstract, or has objects, and the next Observatory scan
no longer flags it.
`,
  },
};


// ── Playbooks built from the shared shape ──────────────────────────────────
//
// The hand-written playbooks above predate this. Everything added since goes through
// definePlaybook so every epic and task reads the same way: why it matters, the strategy,
// the definition of done; then per task, the facts as a list, the steps, and done-when.
// Facts with no value are dropped, so a thin item never renders "undefined" or "Owner: ".
function definePlaybook({ pillar, label, findings, granularity = "item", epic, task, links, epicLinks }) {
  return {
    pillar,
    label,
    findings,
    granularity,
    links,
    epicLinks,
    epicSummary: epic.summary,
    epicDescription: ({ count = 0 } = {}) => `
## Why this matters
${epic.why(count)}

## Strategy
${epic.strategy}

## Definition of done
${epic.done}
`,
    taskSummary: task.summary,
    taskDescription: (it = {}) => {
      const facts = task.facts(it).filter(([, v]) => v !== null && v !== undefined && v !== "");
      return `
## ${task.heading}
${facts.map(([k, v]) => `- ${k}: ${v}`).join("\n") || "- (details unavailable)"}

## Steps
${task.steps(it).map((step) => `- ${step}`).join("\n")}

## Done when
${task.done}
`;
    },
  };
}

// Stable bucketing for the "bounded" granularity: many near-identical items, grouped by a
// natural owner (a project, say) so each task goes to the person who can act on it. When
// there are more owners than `max`, owners are hashed into `max` buckets -- by name, so an
// owner lands in the same bucket every time the finding is re-read within a quarter, and a
// re-run adds only what is new rather than reshuffling every task.
export function groupBounded(items, { keyOf, max = 50 } = {}) {
  const byKey = new Map();
  for (const item of items) {
    const key = String(keyOf(item) ?? "(none)");
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(item);
  }
  const keys = [...byKey.keys()].sort();
  if (keys.length <= max) {
    return keys.map((key) => ({ id: key, name: key, owners: [key], members: byKey.get(key), count: byKey.get(key).length }));
  }
  const hash = (text) => [...text].reduce((h, c) => ((h * 31) + c.charCodeAt(0)) >>> 0, 7);
  const buckets = new Map();
  for (const key of keys) {
    const b = hash(key) % max;
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(key);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([b, owners]) => {
      const members = owners.flatMap((k) => byKey.get(k));
      return {
        id: `bucket-${String(b).padStart(2, "0")}`,
        name: owners.length <= 3 ? owners.join(", ") : `${owners.slice(0, 3).join(", ")} +${owners.length - 3} more`,
        owners,
        members,
        count: members.length,
      };
    });
}

// ── Access: permission, issue-security and notification schemes, project roles ──

const ACCESS_SCHEME_LINK = {
  permission: L.permissionScheme,
  security: L.securityScheme,
  notification: L.notificationScheme,
};
const ACCESS_SCHEME_NOUN = {
  permission: "permission scheme",
  security: "issue security scheme",
  notification: "notification scheme",
};

Object.assign(REMEDIATION_PLAYBOOKS, {
  "permission-risky": definePlaybook({
    pillar: "permissions",
    label: "Least-privilege permission schemes",
    findings: ["permission-risky"],
    epic: {
      summary: (n) => `Tighten ${n} permission ${plural(n, "scheme")} that break least privilege`,
      why: (n) => `${n} permission ${plural(n, "scheme opens", "schemes open")} browse to anyone, hand project administration to a whole group, or grant a permission to a named individual. Browse-to-anyone is a data-exposure fact on every project the scheme governs; a named-individual grant stops working, or keeps working, silently, when that person moves on.`,
      strategy: `For each scheme, replace each flagged grant with a project role (and put the right people in the role per project). Remove browse-to-anyone unless the project is genuinely meant to be public.`,
      done: `Every child task is closed and the next Observatory scan reports no permission scheme breaking least privilege.`,
    },
    task: {
      heading: "The permission scheme",
      summary: (it) => `Tighten permission scheme "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Scheme", it.name || "(unnamed)"],
        ["Scheme id", it.id],
        ["Projects using it", it.projectCount],
        ["Why flagged", (it.reasons || []).join("; ")],
      ],
      steps: () => [
        "Open the scheme (link below) and find each flagged grant.",
        "Replace a grant to a named person or a broad group with a project role; add the right people to that role in each project.",
        "Remove \"Anyone\" from Browse Projects unless the projects on this scheme are meant to be public.",
        "Changes apply to every project on the scheme at once -- check the project list first.",
      ],
      done: "The scheme grants through roles only, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Permission scheme: ${it.name || it.id}`, L.permissionScheme(o, it.id)]],
  }),

  "access-unused-schemes": definePlaybook({
    pillar: "permissions",
    label: "Access schemes assigned to no project",
    findings: ["permission-unused", "security-unused", "notification-unused"],
    epic: {
      summary: (n) => `Delete ${n} access ${plural(n, "scheme")} no project uses`,
      why: (n) => `${n} permission, issue security or notification ${plural(n, "scheme is", "schemes are")} assigned to no project. Each is one more option in every scheme picker and one more thing to audit, and none of them does anything.`,
      strategy: `Confirm each scheme is genuinely unassigned (the scan can be stale), then delete it. Default schemes are never included.`,
      done: `Every child task is closed and the next scan reports no unassigned access schemes.`,
    },
    task: {
      heading: "The scheme",
      summary: (it) => `Delete unused ${ACCESS_SCHEME_NOUN[it.type] || "scheme"} "${it.name || it.schemeId || "(unknown)"}"`,
      facts: (it) => [
        ["Type", ACCESS_SCHEME_NOUN[it.type]],
        ["Scheme", it.name || "(unnamed)"],
        ["Scheme id", it.schemeId],
      ],
      steps: () => [
        "Open the scheme (link below) and confirm no project is associated with it.",
        "Delete it from the scheme list in Jira administration.",
      ],
      done: "The scheme no longer exists and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`${ACCESS_SCHEME_NOUN[it.type] || "Scheme"}: ${it.name || it.schemeId}`, ACCESS_SCHEME_LINK[it.type]?.(o, it.schemeId) ?? null]],
  }),

  "security-broken-levels": definePlaybook({
    pillar: "security",
    label: "Issue security levels nobody can see",
    findings: ["security-broken-levels"],
    epic: {
      summary: (n) => `Fix ${n} issue security ${plural(n, "problem")}: empty levels and schemes with no levels`,
      why: (n) => `${n} issue security ${plural(n, "level has", "levels have")} no members, or ${plural(n, "a scheme defines", "schemes define")} no levels at all. An issue set to an empty level is invisible to everyone except admins -- it has effectively disappeared.`,
      strategy: `For each empty level, add the role or group that should see those issues, or delete the level if nothing uses it. For a scheme with no levels, add the levels it was meant to have or delete the scheme.`,
      done: `Every child task is closed and the next scan reports no empty levels or level-less schemes.`,
    },
    task: {
      heading: "The security level",
      summary: (it) => (it.kind === "no-levels"
        ? `Issue security scheme "${it.schemeName || it.schemeId || "(unknown)"}" has no levels`
        : `Security level "${it.levelName || it.levelId || "(unknown)"}" has no members`),
      facts: (it) => [
        ["Scheme", it.schemeName],
        ["Scheme id", it.schemeId],
        ["Level", it.kind === "no-levels" ? "(none defined)" : it.levelName],
      ],
      steps: (it) => (it.kind === "no-levels"
        ? ["Open the scheme (link below).", "Add the levels it was meant to have, or delete the scheme if no project needs it."]
        : [
            "Search for issues at this level before changing it -- anyone who can see them today is an admin.",
            "Add the project role or group that should see these issues, or delete the level if it is unused.",
          ]),
      done: "The level has members (or the scheme has levels), and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Issue security scheme: ${it.schemeName || it.schemeId}`, L.securityScheme(o, it.schemeId)]],
  }),

  "notification-fragile": definePlaybook({
    pillar: "notifications",
    label: "Notification schemes naming individuals",
    findings: ["notification-fragile"],
    epic: {
      summary: (n) => `Replace named individuals in ${n} notification ${plural(n, "scheme")}`,
      why: (n) => `${n} notification ${plural(n, "scheme sends", "schemes send")} mail to a named person rather than a role or group. When that person leaves, the notification goes nowhere -- or keeps going to an address that no longer should receive it.`,
      strategy: `Replace each named user with the role, group or issue field (assignee, reporter, watchers) the notification was really meant for.`,
      done: `Every child task is closed and the next scan reports no notification scheme naming an individual.`,
    },
    task: {
      heading: "The notification scheme",
      summary: (it) => `Replace named recipients in notification scheme "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Scheme", it.name || "(unnamed)"],
        ["Scheme id", it.id],
        ["Named individuals", it.namedUserCount],
      ],
      steps: () => [
        "Open the scheme (link below) and find each event that notifies a single user.",
        "Replace the user with a project role, group or issue field (assignee, reporter, watchers).",
      ],
      done: "The scheme notifies no named individual, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Notification scheme: ${it.name || it.id}`, L.notificationScheme(o, it.id)]],
  }),

  "role-empty-admin": definePlaybook({
    pillar: "roles",
    label: "Projects with an empty administrator role",
    findings: ["role-empty-admin"],
    epic: {
      summary: (n) => `Give ${n} ${plural(n, "project")} a project administrator`,
      why: (n) => `${n} ${plural(n, "project has", "projects have")} no user or group in the administrator role, so only a site admin can change the project's settings, components, versions or people. Every small change becomes a request to the Jira admins.`,
      strategy: `For each project, add the project lead (or a group owned by the team) to the administrator role.`,
      done: `Every child task is closed and the next scan reports no project with an empty administrator role.`,
    },
    task: {
      heading: "The project",
      summary: (it) => `Add a project administrator to ${it.projectKey || it.id || "(unknown)"}`,
      facts: (it) => [
        ["Project", it.projectName ? `${it.projectName} (${it.projectKey})` : it.projectKey],
        ["Role", it.role],
      ],
      steps: () => [
        "Open the project's People / roles settings (link below).",
        "Add the project lead, or a group the team owns, to the administrator role.",
      ],
      done: "The administrator role has at least one user or group, and the next Observatory scan no longer flags the project.",
    },
    links: (it, o) => [
      [`${it.projectKey} roles`, L.projectRoles(o, it.projectKey)],
      [`${it.projectKey} project`, L.project(o, it.projectKey)],
    ],
  }),

  // Bounded: one task per project, so each project's admin cleans their own roles. Past 50
  // projects the projects are bundled (groupBounded) -- a reasonable number of tasks, never
  // one per actor and never one for everything.
  "role-offroster-actors": definePlaybook({
    pillar: "roles",
    label: "Project-role actors off the licensed roster",
    findings: ["role-offroster-actors"],
    granularity: "bounded",
    epic: {
      summary: (n) => `Remove off-roster accounts from project roles (${n} ${plural(n, "task")})`,
      why: () => `Accounts that are no longer on the licensed roster still sit in project roles. They grant nothing today, but they clutter every role, confuse "who can do what here", and come straight back with full access if the account is ever reactivated.`,
      strategy: `Each task covers one project (or a small bundle of projects). Remove every listed account from the listed roles. Nothing here needs a judgement call per account -- they are all off the roster.`,
      done: `Every child task is closed and the next scan reports no off-roster project-role actors.`,
    },
    task: {
      heading: "What to remove",
      summary: (it) => `Remove ${it.count || 0} off-roster ${plural(it.count || 0, "actor")} from project roles in ${it.name || "(unknown)"}`,
      facts: (it) => [
        ["Projects", (it.owners || []).join(", ")],
        ["Role memberships to remove", it.count],
        ...(it.members || []).slice(0, 60).map((m) => [`${m.projectKey} / ${m.role}`, m.accountId]),
        ...((it.members || []).length > 60 ? [["More", `${it.members.length - 60} further memberships -- see the Access tab`]] : []),
      ],
      steps: () => [
        "Open each project's People / roles settings (links below).",
        "Remove each listed account from the listed role.",
      ],
      done: "None of these projects has an off-roster account in any role, and the next Observatory scan agrees.",
    },
    links: (it, o) => (it.owners || []).slice(0, 25).map((key) => [`${key} roles`, L.projectRoles(o, key)]),
  }),
});

// ── Filters and dashboards ──────────────────────────────────────────────────

const ownerFact = (it) => it.ownerName || null;

// JQL string literal for a name: double quotes, inner quotes escaped.
const jqlString = (value) => `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

Object.assign(REMEDIATION_PLAYBOOKS, {
  "filters-zombie-subscriptions": definePlaybook({
    pillar: "filters",
    label: "Subscriptions on filters nobody opens",
    findings: ["filters-zombie-subscriptions"],
    epic: {
      summary: (n) => `Review email subscriptions on ${n} saved ${plural(n, "filter")} nobody opens`,
      why: (n) => `${n} saved ${plural(n, "filter sends", "filters send")} scheduled email to subscribers, but nobody has opened the filter in over a year. That is mail people have learned to ignore -- and the habit takes the subscriptions that matter down with it.`,
      strategy: `Ask each owner whether anyone still reads the mail. Remove the subscriptions nobody needs; if the filter itself is dead, delete it.`,
      done: `Every child task is closed and the next scan reports no subscribed-but-unused filters.`,
    },
    task: {
      heading: "The filter",
      summary: (it) => `Review subscriptions on filter "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [["Filter", it.name || "(unnamed)"], ["Filter id", it.id], ["Owner", ownerFact(it)], ["Subscriptions", it.subscriptionCount], ["Last opened", it.lastUsedAt || "never recorded"]],
      steps: () => [
        "Open the filter (link below) and check its subscriptions (Details -> Subscriptions).",
        "Confirm with the owner whether anyone still reads the mail.",
        "Remove unwanted subscriptions, or delete the filter if nothing uses it.",
      ],
      done: "The filter has no subscription nobody reads, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Filter: ${it.name || it.id}`, L.filter(o, it.id)]],
  }),

  "filters-shared-everyone": definePlaybook({
    pillar: "filters",
    label: "Filters shared with every logged-in user",
    findings: ["filters-shared-everyone"],
    epic: {
      summary: (n) => `Narrow sharing on ${n} saved ${plural(n, "filter")} shared with everyone`,
      why: (n) => `${n} saved ${plural(n, "filter is", "filters are")} shared with every logged-in user. Anyone can run them, including against projects they can browse but were never meant to survey, and they clutter everyone's filter search.`,
      strategy: `Share each filter with the project, group or role that actually uses it. Keep site-wide sharing only for filters that genuinely serve everyone.`,
      done: `Every child task is closed and the next scan reports no filter shared with everyone that should not be.`,
    },
    task: {
      heading: "The filter",
      summary: (it) => `Narrow sharing on filter "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [["Filter", it.name || "(unnamed)"], ["Filter id", it.id], ["Owner", ownerFact(it)], ["Favourited by", it.favouritedCount]],
      steps: () => [
        "Open the filter (link below) -> Details -> Edit permissions.",
        "Replace \"Any logged-in user\" with the project, group or role that uses it.",
      ],
      done: "The filter is shared only with its audience, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Filter: ${it.name || it.id}`, L.filter(o, it.id)]],
  }),

  "dashboards-open-edit": definePlaybook({
    pillar: "dashboards",
    label: "Dashboards anyone can edit",
    findings: ["dashboards-open-edit"],
    epic: {
      summary: (n) => `Lock down edit rights on ${n} ${plural(n, "dashboard")} anyone can edit`,
      why: (n) => `${n} ${plural(n, "dashboard lets", "dashboards let")} any logged-in user rearrange it for everybody who uses it, and the owner is not told.`,
      strategy: `Restrict edit rights to the owner and the team that maintains each dashboard; leave view sharing as it is.`,
      done: `Every child task is closed and the next scan reports no dashboard editable by everyone.`,
    },
    task: {
      heading: "The dashboard",
      summary: (it) => `Restrict editing on dashboard "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [["Dashboard", it.name || "(unnamed)"], ["Dashboard id", it.id], ["Owner", ownerFact(it)], ["Favourited by", it.popularity]],
      steps: () => [
        "Open the dashboard (link below) -> ... -> Edit and share.",
        "Remove \"Any logged-in user\" from the editors; add the maintaining team instead.",
      ],
      done: "Only its maintainers can edit the dashboard, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Dashboard: ${it.name || it.id}`, L.dashboard(o, it.id)]],
  }),

  "dashboards-empty": definePlaybook({
    pillar: "dashboards",
    label: "Empty dashboards",
    findings: ["dashboards-empty"],
    epic: {
      summary: (n) => `Delete or fill ${n} empty ${plural(n, "dashboard")}`,
      why: (n) => `${n} ${plural(n, "dashboard has", "dashboards have")} no gadgets. Anyone opening one sees an empty grid, and each is one more entry in every dashboard search.`,
      strategy: `Ask each owner whether the dashboard was abandoned or never finished. Delete the abandoned ones.`,
      done: `Every child task is closed and the next scan reports no empty dashboards.`,
    },
    task: {
      heading: "The dashboard",
      summary: (it) => `Delete or fill empty dashboard "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [["Dashboard", it.name || "(unnamed)"], ["Dashboard id", it.id], ["Owner", ownerFact(it)]],
      steps: () => ["Open the dashboard (link below) and confirm it has no gadgets.", "Delete it, or add the gadgets it was meant to have."],
      done: "The dashboard has gadgets or no longer exists, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Dashboard: ${it.name || it.id}`, L.dashboard(o, it.id)]],
  }),

  "dashboards-published-unused": definePlaybook({
    pillar: "dashboards",
    label: "Dashboards published to everyone, favourited by nobody",
    findings: ["dashboards-published-unused"],
    epic: {
      summary: (n) => `Retire or unpublish ${n} site-wide ${plural(n, "dashboard")} nobody favourites`,
      why: (n) => `${n} ${plural(n, "dashboard is", "dashboards are")} shared with every logged-in user and favourited by nobody -- published to everyone, wanted by no one, and in everyone's dashboard search.`,
      strategy: `Check with each owner. Delete dashboards nobody uses; narrow the sharing on any that serve one team.`,
      done: `Every child task is closed and the next scan reports no published-but-unused dashboards.`,
    },
    task: {
      heading: "The dashboard",
      summary: (it) => `Retire or unpublish dashboard "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [["Dashboard", it.name || "(unnamed)"], ["Dashboard id", it.id], ["Owner", ownerFact(it)], ["Gadgets", it.gadgetCount]],
      steps: () => ["Open the dashboard (link below) and confirm with the owner whether anyone uses it.", "Delete it, or share it only with the team that does."],
      done: "The dashboard is used, narrowed, or gone, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Dashboard: ${it.name || it.id}`, L.dashboard(o, it.id)]],
  }),
});

// ── People, issue types, priorities, Assets ─────────────────────────────────

Object.assign(REMEDIATION_PLAYBOOKS, {
  "people-offroster-automation-refs": definePlaybook({
    pillar: "users",
    label: "Automation rules naming off-roster people",
    findings: ["people-offroster-automation-refs"],
    epic: {
      summary: (n) => `Repoint automation rules that name ${n} off-roster ${plural(n, "person", "people")}`,
      why: (n) => `Automation rules name ${n} ${plural(n, "account", "accounts")} no longer on the licensed roster -- assigning work to them, notifying them, or conditioning on them. Assignment to a gone account fails or lands work nowhere; conditions on them silently never match.`,
      strategy: `One task per person: repoint each listed rule to the person or role who took over the work, or retire the rule.`,
      done: `Every child task is closed and the next scan reports no automation rule naming an off-roster account.`,
    },
    task: {
      heading: "The account and its rules",
      summary: (it) => `Repoint ${it.ruleCount || 0} automation ${plural(it.ruleCount || 0, "rule")} naming off-roster account ${it.accountId || it.id || "(unknown)"}`,
      facts: (it) => [
        ["Account id", it.accountId || it.id],
        ["Rules naming it", it.ruleCount],
        ...(it.rules || []).slice(0, 40).map((r) => [r.name || `Rule ${r.id}`, r.direction === "write" ? "assigns or sets this account" : r.direction === "trigger" ? "triggers on this account" : "conditions on this account"]),
      ],
      steps: () => [
        "Open each rule (links below); rules that assign or set the account matter most.",
        "Replace the account with its successor, a role, or a smart value (e.g. the project lead).",
        "Disable or delete any rule that no longer has a purpose.",
      ],
      done: "No rule names this account, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => (it.rules || []).slice(0, 25).map((r) => [`Rule: ${r.name || r.id}`, L.automationRule(o, r.id)]),
  }),

  "issue-type-hierarchy": definePlaybook({
    pillar: "issueTypes",
    label: "Issue type schemes with a broken hierarchy",
    findings: ["issue-type-hierarchy"],
    epic: {
      summary: (n) => `Fix ${n} issue type ${plural(n, "scheme")} with a broken hierarchy`,
      why: (n) => `${n} issue type ${plural(n, "scheme is", "schemes are")} configured so that issues cannot be created sensibly: only sub-task types, or a default type the scheme does not allow or that is a sub-task.`,
      strategy: `For each scheme, add the standard types its projects need and set a standard type as the default.`,
      done: `Every child task is closed and the next scan reports no hierarchy problems.`,
    },
    task: {
      heading: "The issue type scheme",
      summary: (it) => `Fix the hierarchy of issue type scheme "${it.name || it.schemeId || "(unknown)"}"`,
      facts: (it) => [["Scheme", it.name || "(unnamed)"], ["Scheme id", it.schemeId], ["Projects using it", it.projectCount], ...(it.flags || []).map((f) => ["Problem", f])],
      steps: () => [
        "Open the scheme (link below).",
        "Add the standard issue types its projects need, and make one of them the default.",
      ],
      done: "The scheme has standard types and a valid default, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Issue type scheme: ${it.name || it.schemeId}`, L.issueTypeScheme(o, it.schemeId)]],
  }),

  "issue-type-unused-schemes": definePlaybook({
    pillar: "issueTypes",
    label: "Issue type schemes no project uses",
    findings: ["issue-type-unused-schemes"],
    epic: {
      summary: (n) => `Delete ${n} issue type ${plural(n, "scheme")} no project uses`,
      why: (n) => `${n} issue type ${plural(n, "scheme is", "schemes are")} associated with no project -- one more option in every scheme picker, doing nothing.`,
      strategy: `Confirm each is unassigned, then delete it.`,
      done: `Every child task is closed and the next scan reports no unused issue type schemes.`,
    },
    task: {
      heading: "The issue type scheme",
      summary: (it) => `Delete unused issue type scheme "${it.name || it.schemeId || "(unknown)"}"`,
      facts: (it) => [["Scheme", it.name || "(unnamed)"], ["Scheme id", it.schemeId]],
      steps: () => ["Open the scheme (link below) and confirm no project uses it.", "Delete it from Issue type schemes."],
      done: "The scheme no longer exists and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Issue type scheme: ${it.name || it.schemeId}`, L.issueTypeScheme(o, it.schemeId)]],
  }),
});

function estatePlaybook({ kind, noun, nouns, admin, field }) {
  return definePlaybook({
    pillar: "estate",
    label: `Near-duplicate ${nouns}`,
    findings: [`estate-duplicate-${nouns}`],
    granularity: "group",
    epic: {
      summary: (n) => `Consolidate ${n} ${plural(n, "group")} of near-duplicate ${nouns}`,
      why: (n) => `${n} ${plural(n, "group")} of ${nouns} differ only by case, spacing or a character. Every report grouped by ${noun} is split across the synonyms, and people pick whichever they see first.`,
      strategy: `For each group, keep the value that is used most, move issues off the others (Jira offers a replacement when you delete one), then delete them.`,
      done: `Every child task is closed and the next scan reports no near-duplicate ${nouns}.`,
    },
    task: {
      heading: `The ${nouns}`,
      summary: (it) => `Consolidate ${it.count || (it.names || []).length || 0} near-duplicate ${nouns} ("${(it.names || [])[0] || it.key || "?"}")`,
      facts: (it) => [["Match", it.kind], ...(it.names || []).map((name) => [`${noun[0].toUpperCase()}${noun.slice(1)}`, name])],
      steps: () => [
        "Use the search link below to see how many issues use each value.",
        "Keep the most-used one; delete the others, choosing it as the replacement when Jira asks.",
        ...(kind === "priority" ? ["Check priority schemes still list the survivor."] : []),
      ],
      done: `Only one ${noun} remains from this group, and the next Observatory scan no longer flags it.`,
    },
    links: (it, o) => [
      [`${noun[0].toUpperCase()}${noun.slice(1)} admin`, admin(o)],
      ...((it.names || []).length ? [[`Issues using these ${nouns}`, L.search(o, `${field} in (${it.names.map(jqlString).join(", ")})`)]] : []),
    ],
  });
}

Object.assign(REMEDIATION_PLAYBOOKS, {
  "estate-duplicate-priorities": estatePlaybook({ kind: "priority", noun: "priority", nouns: "priorities", admin: L.priorityAdmin, field: "priority" }),
  "estate-duplicate-resolutions": estatePlaybook({ kind: "resolution", noun: "resolution", nouns: "resolutions", admin: L.resolutionAdmin, field: "resolution" }),

  "asset-broken-references": definePlaybook({
    pillar: "assets",
    label: "Assets attributes referencing a missing type",
    findings: ["asset-broken-references"],
    epic: {
      summary: (n) => `Fix ${n} Assets reference ${plural(n, "attribute")} pointing at a missing object type`,
      why: (n) => `${n} reference ${plural(n, "attribute points", "attributes point")} at an object type that no longer exists. The link can never be filled in, and anything relying on it (automation, JQL on Assets fields) silently finds nothing.`,
      strategy: `Repoint each attribute at the type it should reference, or delete the attribute if it is obsolete.`,
      done: `Every child task is closed and the next scan reports no broken references.`,
    },
    task: {
      heading: "The attribute",
      summary: (it) => `Fix broken reference attribute "${it.name || it.id || "(unknown)"}"${it.objectTypeName ? ` on ${it.objectTypeName}` : ""}`,
      facts: (it) => [["Attribute", it.name || "(unnamed)"], ["Attribute id", it.id], ["On object type", it.objectTypeName || it.objectTypeId], ["References missing type id", it.referenceObjectTypeId]],
      steps: () => ["Open the object type (link below) -> Attributes.", "Point the attribute at the right object type, or delete it."],
      done: "The attribute references a type that exists, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Object type: ${it.objectTypeName || it.objectTypeId}`, L.assetType(o, it.schemaId, it.objectTypeId)]],
  }),

  "asset-broken-hierarchy": definePlaybook({
    pillar: "assets",
    label: "Assets object types with a missing parent",
    findings: ["asset-broken-hierarchy"],
    epic: {
      summary: (n) => `Re-parent ${n} Assets object ${plural(n, "type")} whose parent is missing`,
      why: (n) => `${n} object ${plural(n, "type names", "types name")} a parent type that no longer exists, so inherited attributes and the type tree are broken for them.`,
      strategy: `Move each type under the right parent, or make it top-level.`,
      done: `Every child task is closed and the next scan reports no broken hierarchy.`,
    },
    task: {
      heading: "The object type",
      summary: (it) => `Re-parent Assets object type "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [["Object type", it.name || "(unnamed)"], ["Type id", it.id], ["Missing parent id", it.parentId]],
      steps: () => ["Open the object type (link below).", "Move it under the correct parent type, or make it a top-level type."],
      done: "The type has a parent that exists (or none), and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Object type: ${it.name || it.id}`, L.assetType(o, it.schemaId, it.id)]],
  }),

  "asset-bare-types": definePlaybook({
    pillar: "assets",
    label: "Assets object types with no attributes of their own",
    findings: ["asset-bare-types"],
    epic: {
      summary: (n) => `Model or remove ${n} bare Assets object ${plural(n, "type")}`,
      why: (n) => `${n} concrete object ${plural(n, "type has", "types have")} no attributes beyond the system ones -- objects of that type can hold nothing but a name.`,
      strategy: `Add the attributes each type was meant to carry, make it abstract if it is only a grouping, or delete it.`,
      done: `Every child task is closed and the next scan reports no bare object types.`,
    },
    task: {
      heading: "The object type",
      summary: (it) => `Model or remove bare Assets object type "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [["Object type", it.name || "(unnamed)"], ["Type id", it.id], ["Schema id", it.schemaId]],
      steps: () => ["Open the object type (link below).", "Add its attributes, mark it abstract, or delete it."],
      done: "The type has attributes, is abstract, or is gone, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Object type: ${it.name || it.id}`, L.assetType(o, it.schemaId, it.id)]],
  }),
});

// ── Links and finding coverage for the hand-written playbooks ──────────────

const LEGACY_META = {
  "filter-ownership": { label: "Filter ownership", findings: ["filters-orphaned"], links: (it, o) => [[`Filter: ${it.name || it.id}`, L.filter(o, it.id)]] },
  "dashboard-ownership": { label: "Dashboard ownership", findings: ["dashboards-orphaned"], links: (it, o) => [[`Dashboard: ${it.name || it.id}`, L.dashboard(o, it.id)]] },
  "user-licence-hygiene": { label: "Licence hygiene", findings: ["people-deactivated-licence"], links: (it, o) => [[`Profile: ${it.displayName || it.accountId}`, L.person(o, it.accountId || it.id)]] },
  "user-ownership": {
    label: "Ownership continuity",
    findings: ["people-orphaned-ownership"],
    links: (it, o) => {
      const [kind, id] = String(it.id || "").split(":");
      const url = kind === "filter" ? L.filter(o, id) : kind === "dashboard" ? L.dashboard(o, id) : kind === "rule" ? L.automationRule(o, id) : null;
      return [[`${it.kind || "Artifact"}: ${it.name || id}`, url]];
    },
  },
  "status-reachability": {
    label: "Status reachability",
    findings: ["unused-statuses"],
    links: (it, o) => [
      ["Statuses admin", L.statusAdmin(o)],
      [`Issues in "${it.name || it.id}"`, it.id ? L.search(o, `status = ${it.id}`) : null],
    ],
  },
  "board-backing": {
    label: "Board backing filters",
    findings: [],
    links: (it, o) => [[`Board: ${it.name || it.id}`, L.board(o, it.id)], ...(it.filterId ? [[`Filter ${it.filterId}`, L.filter(o, it.filterId)]] : [])],
  },
  "field-cleanup": {
    label: "Fields with no populated issues",
    findings: ["field-no-populated-issues"],
    links: (it, o) => [[`Field: ${it.name || it.id}`, L.field(o, it.id)], ["Field contexts", L.fieldContexts(o, it.id)]],
  },
  "filter-duplicates": {
    label: "Duplicate filters",
    findings: ["filters-duplicates"],
    granularity: "group",
    links: (it, o) => (it.filters || []).map((f) => [`Filter: ${f.name || f.id}`, L.filter(o, f.id)]),
  },
  "filter-scope": {
    label: "Filter scope references",
    findings: ["filters-broken-scope", "filters-unknown-type"],
    links: (it, o) => [[`Filter: ${it.name || it.id}`, L.filter(o, it.filterId || String(it.id || "").split(":")[0])]],
  },
  "screen-unreachable-fields": { label: "Unreachable fields", findings: [], links: (it, o) => [[`Field contexts: ${it.fieldName || it.fieldId}`, L.fieldContexts(o, it.fieldId)]] },
  "issue-type-reach": { label: "Orphaned issue types", findings: ["issue-type-orphans"], links: (it, o) => [["Issue types admin", L.issueTypeAdmin(o)], [`Issues of type "${it.name || it.id}"`, it.id ? L.search(o, `issuetype = ${it.id}`) : null]] },
  "issue-type-naming": { label: "Duplicate issue type names", findings: ["issue-type-duplicates"], granularity: "group", links: (it, o) => [["Issue types admin", L.issueTypeAdmin(o)], ...(it.types || []).map((t) => [`Issues of type "${t.name || t.id}"`, L.search(o, `issuetype = ${t.id}`)])] },
  "asset-schema-hygiene": { label: "Dead Assets schemas", findings: ["asset-dead-schemas"], links: (it, o) => [[`Assets schema: ${it.name || it.id}`, L.assetSchema(o, it.id)]] },
  "asset-type-usage": { label: "Empty Assets object types", findings: [], links: (it, o) => [[`Object type: ${it.name || it.id}`, L.assetType(o, it.schemaId, it.id)]] },
};
for (const [key, meta] of Object.entries(LEGACY_META)) {
  Object.assign(REMEDIATION_PLAYBOOKS[key], { granularity: "item", ...meta });
}

// Every description gets an "Open in Jira" section built from the playbook's links, so a
// ticket takes its reader straight to what it is about. `ctx.origin` is the site's base URL;
// without one the section is left out rather than rendered as dead text.
function withLinks(text, pairs) {
  const valid = (pairs || []).filter(([, url]) => url);
  if (!valid.length) return text;
  return `${text}
## Open in Jira
${valid.map(([label, url]) => `- ${md(label, url)}`).join("\n")}
`;
}

for (const p of Object.values(REMEDIATION_PLAYBOOKS)) {
  p.labels = [BASE_LABEL, p.pillar];
  const task = p.taskDescription;
  const epic = p.epicDescription;
  p.taskDescription = (it = {}, ctx = {}) => withLinks(task(it), p.links ? p.links(it || {}, ctx.origin || null) : []);
  p.epicDescription = (ctx = {}) => withLinks(epic(ctx), p.epicLinks ? p.epicLinks(ctx.origin || null) : []);
}

export function getPlaybook(findingKey) {
  return REMEDIATION_PLAYBOOKS[findingKey] || null;
}

export function listPlaybookKeys() {
  return Object.keys(REMEDIATION_PLAYBOOKS);
}

// Overview finding key -> the playbook that remediates it. The Overview, the Remediation tab
// and each pillar tab all resolve a finding through this, so a finding's epic is the same
// epic wherever it is shown.
export const REMEDIATION_FINDING_INDEX = Object.fromEntries(
  Object.entries(REMEDIATION_PLAYBOOKS).flatMap(([key, p]) => (p.findings || []).map((f) => [f, key]))
);

// What the UI needs to list the playbooks without holding its own copy of them.
export function listPlaybookCatalog() {
  return Object.entries(REMEDIATION_PLAYBOOKS).map(([key, p]) => ({
    key,
    label: p.label || key,
    pillar: p.pillar,
    findings: p.findings || [],
    granularity: p.granularity || "item",
  }));
}
