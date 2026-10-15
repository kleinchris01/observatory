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
    epicSummary: (n) =>
      `Reassign ${n} filter${n === 1 ? "" : "s"}, dashboard${n === 1 ? "" : "s"} and rule${n === 1 ? "" : "s"} owned by gone accounts`,
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
For each field, confirm the finding is current (a scan can be stale) and that no archived
project holds data in it (Jira's search cannot see archived issues), then delete it from Jira. Field deletion is destructive and cannot be undone, so this always creates a
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
${
  it.reason === "configured-no-issues"
    ? "Configured for at least one project, but no issue in any of them has a value in it."
    : "No project contexts, no configured screens, and no populated issues found in the last Observatory scan."
}

## Steps
- Re-check the field in Observatory's Field Browser to confirm it is still orphaned (a
  screen or context change since the scan can un-orphan a field).
- Search for the field id in any saved filters, dashboards or automation rules before
  deleting -- Observatory's own dependency graph is the fastest way to check this.
- Check archived projects. Jira hides archived issues from search, so a field can hold data
  in an archived project (kept for retention, for example) while looking unused everywhere
  else. Deleting it deletes that data, and a restored project comes back with the field
  empty. Open the field's Deletion Safety in Observatory: it names any archived project the
  field is configured in. If one is listed, ask its owner before going further.
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
${task
  .steps(it)
  .map((step) => `- ${step}`)
  .join("\n")}

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
    return keys.map((key) => ({
      id: key,
      name: key,
      owners: [key],
      members: byKey.get(key),
      count: byKey.get(key).length,
    }));
  }
  const hash = (text) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
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
      why: (n) =>
        `${n} permission ${plural(n, "scheme opens", "schemes open")} browse to anyone, hand project administration to a whole group, or grant a permission to a named individual. Browse-to-anyone is a data-exposure fact on every project the scheme governs; a named-individual grant stops working, or keeps working, silently, when that person moves on.`,
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
        'Remove "Anyone" from Browse Projects unless the projects on this scheme are meant to be public.',
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
      why: (n) =>
        `${n} permission, issue security or notification ${plural(n, "scheme is", "schemes are")} assigned to no project. Each is one more option in every scheme picker and one more thing to audit, and none of them does anything.`,
      strategy: `Confirm each scheme is genuinely unassigned (the scan can be stale), then delete it. Default schemes are never included.`,
      done: `Every child task is closed and the next scan reports no unassigned access schemes.`,
    },
    task: {
      heading: "The scheme",
      summary: (it) =>
        `Delete unused ${ACCESS_SCHEME_NOUN[it.type] || "scheme"} "${it.name || it.schemeId || "(unknown)"}"`,
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
    links: (it, o) => [
      [
        `${ACCESS_SCHEME_NOUN[it.type] || "Scheme"}: ${it.name || it.schemeId}`,
        ACCESS_SCHEME_LINK[it.type]?.(o, it.schemeId) ?? null,
      ],
    ],
  }),

  "security-broken-levels": definePlaybook({
    pillar: "security",
    label: "Issue security levels nobody can see",
    findings: ["security-broken-levels"],
    epic: {
      summary: (n) => `Fix ${n} issue security ${plural(n, "problem")}: empty levels and schemes with no levels`,
      why: (n) =>
        `${n} issue security ${plural(n, "level has", "levels have")} no members, or ${plural(n, "a scheme defines", "schemes define")} no levels at all. An issue set to an empty level is invisible to everyone except admins -- it has effectively disappeared.`,
      strategy: `For each empty level, add the role or group that should see those issues, or delete the level if nothing uses it. For a scheme with no levels, add the levels it was meant to have or delete the scheme.`,
      done: `Every child task is closed and the next scan reports no empty levels or level-less schemes.`,
    },
    task: {
      heading: "The security level",
      summary: (it) =>
        it.kind === "no-levels"
          ? `Issue security scheme "${it.schemeName || it.schemeId || "(unknown)"}" has no levels`
          : `Security level "${it.levelName || it.levelId || "(unknown)"}" has no members`,
      facts: (it) => [
        ["Scheme", it.schemeName],
        ["Scheme id", it.schemeId],
        ["Level", it.kind === "no-levels" ? "(none defined)" : it.levelName],
      ],
      steps: (it) =>
        it.kind === "no-levels"
          ? [
              "Open the scheme (link below).",
              "Add the levels it was meant to have, or delete the scheme if no project needs it.",
            ]
          : [
              "Search for issues at this level before changing it -- anyone who can see them today is an admin.",
              "Add the project role or group that should see these issues, or delete the level if it is unused.",
            ],
      done: "The level has members (or the scheme has levels), and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Issue security scheme: ${it.schemeName || it.schemeId}`, L.securityScheme(o, it.schemeId)]],
  }),

  "notification-fragile": definePlaybook({
    pillar: "notifications",
    label: "Notification schemes naming individuals or raw email addresses",
    findings: ["notification-fragile"],
    epic: {
      summary: (n) => `Replace hard-coded recipients in ${n} notification ${plural(n, "scheme")}`,
      why: (n) =>
        `${n} notification ${plural(n, "scheme sends", "schemes send")} mail to a named person or a raw email address rather than a role or group. When that person leaves, the notification goes nowhere; a raw address keeps receiving issue content wherever that mailbox now goes.`,
      strategy: `Replace each named user or email address with the role, group or issue field (assignee, reporter, watchers) the notification was really meant for.`,
      done: `Every child task is closed and the next scan reports no notification scheme naming an individual.`,
    },
    task: {
      heading: "The notification scheme",
      summary: (it) => `Replace named recipients in notification scheme "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Scheme", it.name || "(unnamed)"],
        ["Scheme id", it.id],
        ["Named individuals", it.namedUserCount],
        ["Raw email addresses", it.emailAddressCount],
      ],
      steps: () => [
        "Open the scheme (link below) and find each event that notifies a single user or an email address.",
        "Replace it with a project role, group or issue field (assignee, reporter, watchers).",
      ],
      done: "The scheme notifies no named individual, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Notification scheme: ${it.name || it.id}`, L.notificationScheme(o, it.id)]],
  }),

  "role-empty-admin": definePlaybook({
    pillar: "roles",
    label: "Projects nobody can administer",
    findings: ["role-empty-admin"],
    epic: {
      summary: (n) => `Give ${n} ${plural(n, "project")} a project administrator`,
      why: (n) =>
        `${n} ${plural(n, "project has", "projects have")} no user or group in any role that can administer the project, and no direct Administer Projects grant, so only a site admin can change the project's settings, components, versions or people. Every small change becomes a request to the Jira admins. A project with someone in any one administering role (for example Administrators or Administrators-EXTERNAL) is not counted.`,
      strategy: `For each project, add the project lead (or a group owned by the team) to the administrator role.`,
      done: `Every child task is closed and the next scan reports no project without an administrator.`,
    },
    task: {
      heading: "The project",
      summary: (it) => `Add a project administrator to ${it.projectKey || it.id || "(unknown)"}`,
      facts: (it) => [
        ["Project", it.projectName ? `${it.projectName} (${it.projectKey})` : it.projectKey],
        [it.roles?.length > 1 ? "Administering roles (all empty)" : "Administering role (empty)", it.role],
      ],
      steps: () => [
        "Open the project's People / roles settings (link below).",
        "Add the project lead, or a group the team owns, to any one of the roles above. One filled role is enough.",
      ],
      done: "At least one role that can administer the project has a user or group, and the next Observatory scan no longer flags the project.",
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
      why: () =>
        `Accounts that are no longer on the licensed roster still sit in project roles. They grant nothing today, but they clutter every role, confuse "who can do what here", and come straight back with full access if the account is ever reactivated.`,
      strategy: `Each task covers one project (or a small bundle of projects). Remove every listed account from the listed roles. Nothing here needs a judgement call per account -- they are all off the roster.`,
      done: `Every child task is closed and the next scan reports no off-roster project-role actors.`,
    },
    task: {
      heading: "What to remove",
      summary: (it) =>
        `Remove ${it.count || 0} off-roster ${plural(it.count || 0, "actor")} from project roles in ${it.name || "(unknown)"}`,
      facts: (it) => [
        ["Projects", (it.owners || []).join(", ")],
        ["Role memberships to remove", it.count],
        ...(it.members || []).slice(0, 60).map((m) => [`${m.projectKey} / ${m.role}`, m.accountId]),
        ...((it.members || []).length > 60
          ? [["More", `${it.members.length - 60} further memberships -- see the Access tab`]]
          : []),
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

// ── The thin-pillar checks (14 Oct 2026) ────────────────────────────────────
//
// One playbook per new health check. Each finding key matches its check, so the ticket, the
// Overview chip and the scored card are the same thing seen three ways.

const grantLines = (grants = [], limit = 40) => [
  ...grants.slice(0, limit).map((x) => [x.permission, `${x.accountId}${x.departed ? " (left)" : ""}`]),
  ...(grants.length > limit ? [["More", `${grants.length - limit} further grants -- see the Access tab`]] : []),
];

Object.assign(REMEDIATION_PLAYBOOKS, {
  "permission-public-access": definePlaybook({
    pillar: "permissions",
    label: "Permission schemes open to anonymous users",
    findings: ["permission-public-access"],
    epic: {
      summary: (n) => `Close anonymous access in ${n} permission ${plural(n, "scheme")}`,
      why: (n) =>
        `${n} permission ${plural(n, "scheme grants", "schemes grant")} a permission to anonymous users. On a site that allows public access, anyone at all can use those permissions on every project the scheme governs.`,
      strategy: `For each scheme, remove each grant to Anyone. If a project genuinely needs to be public, keep the browse grant there and document why; give everything else to a group or project role.`,
      done: `Every child task is closed and the next scan reports no permission scheme open to anonymous users.`,
    },
    task: {
      heading: "The permission scheme",
      summary: (it) => `Remove anonymous access from permission scheme "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Scheme", it.name || "(unnamed)"],
        ["Scheme id", it.id],
        ["Projects using it", it.projectCount],
        ["Permissions open to anonymous users", (it.permissions || []).join(", ")],
      ],
      steps: () => [
        "Open the scheme (link below) and find each permission granted to Anyone.",
        "Remove the grant, or replace it with the group or project role that should have it.",
        "The change applies to every project on the scheme at once -- check the project list first.",
      ],
      done: "The scheme grants nothing to anonymous users, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Permission scheme: ${it.name || it.id}`, L.permissionScheme(o, it.id)]],
  }),

  "permission-everyone-sensitive": definePlaybook({
    pillar: "permissions",
    label: "Sensitive permissions granted to every logged-in user",
    findings: ["permission-everyone-sensitive"],
    epic: {
      summary: (n) => `Narrow sensitive permissions in ${n} permission ${plural(n, "scheme")}`,
      why: (n) =>
        `${n} permission ${plural(n, "scheme gives", "schemes give")} a sensitive permission -- delete issues, move issues, administer projects, edit others' comments or work logs -- to every logged-in user. Anyone with a licence can do it on every project the scheme governs.`,
      strategy: `For each scheme, move each listed permission from "any logged-in user" to the project role that should hold it.`,
      done: `Every child task is closed and the next scan reports no sensitive permission granted to every logged-in user.`,
    },
    task: {
      heading: "The permission scheme",
      summary: (it) => `Narrow sensitive permissions in permission scheme "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Scheme", it.name || "(unnamed)"],
        ["Scheme id", it.id],
        ["Projects using it", it.projectCount],
        ["Granted to every logged-in user", (it.permissions || []).join(", ")],
      ],
      steps: () => [
        "Open the scheme (link below) and find each listed permission.",
        'Remove the "any logged-in user" grant and give it to the project role that needs it.',
      ],
      done: "None of the listed permissions is granted to every logged-in user, and the next Observatory scan no longer flags the scheme.",
    },
    links: (it, o) => [[`Permission scheme: ${it.name || it.id}`, L.permissionScheme(o, it.id)]],
  }),

  "permission-direct-grants": definePlaybook({
    pillar: "permissions",
    label: "Permissions granted to named individuals",
    findings: ["permission-direct-grants"],
    epic: {
      summary: (n) => `Move grants to individuals into roles in ${n} permission ${plural(n, "scheme")}`,
      why: (n) =>
        `${n} permission ${plural(n, "scheme grants", "schemes grant")} permissions to named people. A grant to a person is reviewed by nobody, applies on every project the scheme governs, and outlives the reason it was made.`,
      strategy: `For each scheme, replace each grant to a person with a project role, and add that person to the role only in the projects where they need it.`,
      done: `Every child task is closed and the next scan reports no permission granted to a named individual.`,
    },
    task: {
      heading: "The grants to individuals",
      summary: (it) =>
        `Move ${(it.grants || []).length} named ${plural((it.grants || []).length, "grant")} to roles in permission scheme "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Scheme", it.name || "(unnamed)"],
        ["Scheme id", it.id],
        ["Projects using it", it.projectCount],
        ...grantLines(it.grants),
      ],
      steps: () => [
        "Open the scheme (link below).",
        "For each listed grant, grant the permission to a project role instead and remove the named person.",
        "Add the person to that role in the projects where they need the permission.",
      ],
      done: "The scheme grants nothing to named individuals, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Permission scheme: ${it.name || it.id}`, L.permissionScheme(o, it.id)]],
  }),

  "permission-departed-grants": definePlaybook({
    pillar: "permissions",
    label: "Permissions granted to accounts that have left",
    findings: ["permission-departed-grants"],
    epic: {
      summary: (n) => `Remove grants to departed accounts from ${n} permission ${plural(n, "scheme")}`,
      why: (n) =>
        `${n} permission ${plural(n, "scheme grants", "schemes grant")} permissions to accounts no longer on the licensed roster. They grant nothing today, hide what the scheme really allows, and come straight back if an account is reactivated.`,
      strategy: `Remove every listed grant. If the permission is still needed, give it to the project role that should hold it.`,
      done: `Every child task is closed and the next scan reports no permission granted to a departed account.`,
    },
    task: {
      heading: "The grants to remove",
      summary: (it) =>
        `Remove ${(it.grants || []).length} ${plural((it.grants || []).length, "grant")} to departed accounts from permission scheme "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [["Scheme", it.name || "(unnamed)"], ["Scheme id", it.id], ...grantLines(it.grants)],
      steps: () => [
        "Open the scheme (link below).",
        "Remove each listed grant; give the permission to a project role if it is still needed.",
      ],
      done: "No grant in the scheme names a departed account, and the next Observatory scan agrees.",
    },
    links: (it, o) => [[`Permission scheme: ${it.name || it.id}`, L.permissionScheme(o, it.id)]],
  }),

  "security-direct-members": definePlaybook({
    pillar: "security",
    label: "Issue security levels held by named individuals",
    findings: ["security-direct-members"],
    epic: {
      summary: (n) => `Move named members into roles in ${n} issue security ${plural(n, "scheme")}`,
      why: (n) =>
        `${n} issue security ${plural(n, "scheme names", "schemes name")} individual people as level members. Who can see a restricted issue then depends on a list nobody maintains, and it goes stale as people change teams.`,
      strategy: `For each scheme, replace named members with the project role or group they stand for.`,
      done: `Every child task is closed and the next scan reports no security level held by named individuals.`,
    },
    task: {
      heading: "The named members",
      summary: (it) =>
        `Replace ${(it.members || []).length} named ${plural((it.members || []).length, "member")} in issue security scheme "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Scheme", it.name || "(unnamed)"],
        ["Scheme id", it.id],
        ...(it.members || []).slice(0, 40).map((m) => [m.levelName, `${m.accountId}${m.departed ? " (left)" : ""}`]),
      ],
      steps: () => [
        "Open the scheme (link below).",
        "For each level, add the project role or group these people belong to, then remove the named people.",
        "Check each level still has members afterwards -- an empty level hides its issues from everyone.",
      ],
      done: "The scheme's levels are held by roles or groups, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Issue security scheme: ${it.name || it.id}`, L.securityScheme(o, it.id)]],
  }),

  "security-departed-members": definePlaybook({
    pillar: "security",
    label: "Issue security level members who have left",
    findings: ["security-departed-members"],
    epic: {
      summary: (n) => `Remove departed members from ${n} issue security ${plural(n, "scheme")}`,
      why: (n) =>
        `${n} issue security ${plural(n, "scheme lists", "schemes list")} accounts that are no longer on the licensed roster as level members. If they were the only members, the issues at that level are now visible to nobody but a site admin.`,
      strategy: `Remove each listed member, and give the level to the role or group that should see its issues.`,
      done: `Every child task is closed and the next scan reports no departed security level members.`,
    },
    task: {
      heading: "The members to remove",
      summary: (it) =>
        `Remove ${(it.members || []).length} departed ${plural((it.members || []).length, "member")} from issue security scheme "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Scheme", it.name || "(unnamed)"],
        ["Scheme id", it.id],
        ...(it.members || []).slice(0, 40).map((m) => [m.levelName, m.accountId]),
      ],
      steps: () => [
        "Search for issues at each listed level first -- if the departed person was its only member, nobody can see them today.",
        "Open the scheme (link below), add the right role or group to the level, then remove the departed account.",
      ],
      done: "No level in the scheme names a departed account, every level still has members, and the next Observatory scan agrees.",
    },
    links: (it, o) => [[`Issue security scheme: ${it.name || it.id}`, L.securityScheme(o, it.id)]],
  }),

  "notification-external-email": definePlaybook({
    pillar: "notifications",
    label: "Notifications sent to raw email addresses",
    findings: ["notification-external-email"],
    epic: {
      summary: (n) => `Replace raw email recipients in ${n} notification ${plural(n, "scheme")}`,
      why: (n) =>
        `${n} notification ${plural(n, "scheme sends", "schemes send")} issue mail to raw email addresses. They sit outside the user directory, so nothing changes when someone leaves, and issue content goes wherever that mailbox forwards.`,
      strategy: `Replace each address with the group, project role or issue field (assignee, reporter, watchers) the mail was meant for. If an outside party really must receive it, confirm that with the data owner and record it.`,
      done: `Every child task is closed and the next scan reports no notification scheme sending to a raw email address.`,
    },
    task: {
      heading: "The raw email recipients",
      summary: (it) =>
        `Replace ${(it.addresses || []).length} raw email ${plural((it.addresses || []).length, "address", "addresses")} in notification scheme "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Scheme", it.name || "(unnamed)"],
        ["Scheme id", it.id],
        ["Events sending to an address", it.events],
        ["Addresses", (it.addresses || []).join(", ")],
      ],
      steps: () => [
        "Open the scheme (link below) and find each event that notifies an email address.",
        "Replace it with a group, project role or issue field; remove the address.",
      ],
      done: "The scheme sends to no raw email address, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Notification scheme: ${it.name || it.id}`, L.notificationScheme(o, it.id)]],
  }),

  "notification-departed-recipients": definePlaybook({
    pillar: "notifications",
    label: "Notifications sent to accounts that have left",
    findings: ["notification-departed-recipients"],
    epic: {
      summary: (n) => `Re-route notifications to departed accounts in ${n} notification ${plural(n, "scheme")}`,
      why: (n) =>
        `${n} notification ${plural(n, "scheme sends", "schemes send")} events to accounts that are no longer on the licensed roster. Those events now reach nobody.`,
      strategy: `For each listed event, send it to the project role or group that should hear about it instead.`,
      done: `Every child task is closed and the next scan reports no notification sent to a departed account.`,
    },
    task: {
      heading: "The recipients to replace",
      summary: (it) =>
        `Re-route ${(it.recipients || []).length} ${plural((it.recipients || []).length, "notification")} to departed accounts in "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Scheme", it.name || "(unnamed)"],
        ["Scheme id", it.id],
        ...(it.recipients || []).slice(0, 40).map((r) => [`Event ${r.event}`, r.accountId]),
      ],
      steps: () => [
        "Open the scheme (link below).",
        "For each listed event, add the right project role or group and remove the departed account.",
      ],
      done: "No event in the scheme notifies a departed account, and the next Observatory scan agrees.",
    },
    links: (it, o) => [[`Notification scheme: ${it.name || it.id}`, L.notificationScheme(o, it.id)]],
  }),

  // Bounded, like off-roster actors: one task per project, bundled past 50.
  "role-group-actors": definePlaybook({
    pillar: "roles",
    label: "Project roles held by individuals",
    findings: ["role-group-actors"],
    granularity: "bounded",
    epic: {
      summary: (n) => `Fill project roles with groups instead of individuals (${n} ${plural(n, "task")})`,
      why: () =>
        `Project roles are filled person by person in these projects. A group is one place to change membership; a person per role per project is many, and none of them changes when someone moves team.`,
      strategy: `Each task covers one project (or a small bundle). Where the people in a role share a team, add that team's group to the role and remove the individuals. Leave individuals where no group fits -- this is a tidy-up, not a rule.`,
      done: `Every child task is closed. The check scores a rate, so a few individuals left on purpose are fine.`,
    },
    task: {
      heading: "The individuals in roles",
      summary: (it) =>
        `Review ${it.count || 0} individual role ${plural(it.count || 0, "member")} in ${it.name || "(unknown)"}`,
      facts: (it) => [
        ["Projects", (it.owners || []).join(", ")],
        ["Role memberships", it.count],
        ...(it.members || []).slice(0, 60).map((m) => [`${m.projectKey} / ${m.role}`, m.accountId]),
        ...((it.members || []).length > 60
          ? [["More", `${it.members.length - 60} further memberships -- see the Access tab`]]
          : []),
      ],
      steps: () => [
        "Open each project's People / roles settings (links below).",
        "Where the people in a role belong to one team, add that team's group and remove them individually.",
      ],
      done: "The roles in these projects are held by groups wherever a group fits.",
    },
    links: (it, o) => (it.owners || []).slice(0, 25).map((key) => [`${key} roles`, L.projectRoles(o, key)]),
  }),

  "role-unused": definePlaybook({
    pillar: "roles",
    label: "Project roles nobody holds",
    findings: ["role-unused"],
    epic: {
      summary: (n) => `Retire ${n} project ${plural(n, "role")} nobody holds`,
      why: (n) =>
        `${n} project ${plural(n, "role has", "roles have")} no user or group in any project. Each still appears in every role picker and permission scheme, granting nothing and inviting the wrong choice.`,
      strategy: `Confirm each role is unused (check permission and notification schemes that reference it), then delete it, or take it out of those schemes.`,
      done: `Every child task is closed and the next scan reports no project role that nobody holds.`,
    },
    task: {
      heading: "The project role",
      summary: (it) => `Retire project role "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Role", it.name],
        ["Role id", it.id],
      ],
      steps: () => [
        "Open Project roles in Jira administration (link below) and view the role's usage.",
        "Remove it from any permission or notification scheme that references it, then delete the role.",
      ],
      done: "The role no longer exists (or holds someone), and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [["Project roles", L.projectRolesAdmin(o)]],
  }),

  "priority-usage": definePlaybook({
    pillar: "estate",
    label: "Priorities no issue uses",
    findings: ["priority-usage"],
    epic: {
      summary: (n) => `Retire ${n} unused ${plural(n, "priority", "priorities")}`,
      why: (n) =>
        `${n} ${plural(n, "priority is", "priorities are")} on no issue at all. Each is one more option everyone reads past when creating an issue.`,
      strategy: `Confirm each priority is unused and not referenced by a priority scheme you rely on, then delete it.`,
      done: `Every child task is closed and the next scan reports no unused priorities.`,
    },
    task: {
      heading: "The priority",
      summary: (it) => `Retire unused priority "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Priority", it.name],
        ["Priority id", it.id],
        ["Default", it.isDefault ? "Yes -- pick a new default first" : null],
      ],
      steps: (it) => [
        ...(it.isDefault ? ["It is the default priority: set another default first."] : []),
        "Open Priorities in Jira administration (link below) and delete it.",
      ],
      done: "The priority no longer exists, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [["Priorities", L.priorityAdmin(o)]],
  }),

  "resolution-usage": definePlaybook({
    pillar: "estate",
    label: "Resolutions no issue uses",
    findings: ["resolution-usage"],
    epic: {
      summary: (n) => `Retire ${n} unused ${plural(n, "resolution")}`,
      why: (n) =>
        `${n} ${plural(n, "resolution is", "resolutions are")} on no issue at all. Each is one more choice on every resolve screen and one more row in every resolution report.`,
      strategy: `Confirm each resolution is unused and not set by a workflow post-function, then delete it.`,
      done: `Every child task is closed and the next scan reports no unused resolutions.`,
    },
    task: {
      heading: "The resolution",
      summary: (it) => `Retire unused resolution "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Resolution", it.name],
        ["Resolution id", it.id],
        ["Default", it.isDefault ? "Yes -- pick a new default first" : null],
      ],
      steps: (it) => [
        ...(it.isDefault ? ["It is the default resolution: set another default first."] : []),
        "Check no workflow transition sets this resolution (the Workflows tab's rule usage shows it).",
        "Open Resolutions in Jira administration (link below) and delete it.",
      ],
      done: "The resolution no longer exists, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [["Resolutions", L.resolutionAdmin(o)]],
  }),

  "estate-defaults": definePlaybook({
    pillar: "estate",
    label: "Priority or resolution list with no default",
    findings: ["estate-defaults"],
    epic: {
      summary: (n) => `Set a default for ${n} value ${plural(n, "list")}`,
      why: () =>
        `A priority or resolution list with no default makes every create or resolve screen choose, or leaves the value empty, so reports split across "none" and real values.`,
      strategy: `Pick the value most issues should start with and make it the default.`,
      done: `Every child task is closed and the next scan reports both lists with a default.`,
    },
    task: {
      heading: "The value list",
      summary: (it) => `Set a default ${it.kind || "value"}`,
      facts: (it) => [
        ["List", it.kind === "priority" ? "Priorities" : "Resolutions"],
        ["Values in the list", it.valueCount],
      ],
      steps: (it) => [
        `Open ${it.kind === "priority" ? "Priorities" : "Resolutions"} in Jira administration (link below).`,
        "Choose the value most issues should start with and set it as the default.",
      ],
      done: "The list has a default, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [
      [
        it.kind === "priority" ? "Priorities" : "Resolutions",
        it.kind === "priority" ? L.priorityAdmin(o) : L.resolutionAdmin(o),
      ],
    ],
  }),
});

// ── Filters and dashboards ──────────────────────────────────────────────────

const ownerFact = (it) => it.ownerName || null;

// JQL string literal for a name: double quotes, inner quotes escaped.
const jqlString = (value) =>
  `"${String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')}"`;

Object.assign(REMEDIATION_PLAYBOOKS, {
  "filters-zombie-subscriptions": definePlaybook({
    pillar: "filters",
    label: "Subscriptions on filters nobody opens",
    findings: ["filters-zombie-subscriptions"],
    epic: {
      summary: (n) => `Review email subscriptions on ${n} saved ${plural(n, "filter")} nobody opens`,
      why: (n) =>
        `${n} saved ${plural(n, "filter sends", "filters send")} scheduled email to subscribers, but nobody has opened the filter in over a year. That is mail people have learned to ignore -- and the habit takes the subscriptions that matter down with it.`,
      strategy: `Ask each owner whether anyone still reads the mail. Remove the subscriptions nobody needs; if the filter itself is dead, delete it.`,
      done: `Every child task is closed and the next scan reports no subscribed-but-unused filters.`,
    },
    task: {
      heading: "The filter",
      summary: (it) => `Review subscriptions on filter "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Filter", it.name || "(unnamed)"],
        ["Filter id", it.id],
        ["Owner", ownerFact(it)],
        ["Subscriptions", it.subscriptionCount],
        ["Last opened", it.lastUsedAt || "never recorded"],
      ],
      steps: () => [
        "Open the filter (link below) and check its subscriptions (Details -> Subscriptions).",
        "Confirm with the owner whether anyone still reads the mail.",
        "Remove unwanted subscriptions, or delete the filter if nothing uses it.",
      ],
      done: "The filter has no subscription nobody reads, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Filter: ${it.name || it.id}`, L.filter(o, it.id)]],
  }),

  "filters-public": definePlaybook({
    pillar: "filters",
    label: "Saved filters shared publicly",
    findings: ["filters-public"],
    epic: {
      summary: (n) => `Take ${n} saved ${plural(n, "filter")} off public sharing`,
      why: (n) =>
        `${n} saved ${plural(n, "filter is", "filters are")} shared globally. On a site that allows anonymous access, anyone on the internet with the link can run ${plural(n, "it", "them")} and read every issue ${plural(n, "it returns", "they return")}.`,
      strategy: `Share each filter with the group, project or role that uses it. If the site does not allow anonymous access, the exposure is to every logged-in user instead -- still narrower is better.`,
      done: `Every child task is closed and the next scan reports no publicly shared filter.`,
    },
    task: {
      heading: "The filter",
      summary: (it) => `Remove public sharing from filter "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Filter", it.name || it.id],
        ["Owner", it.ownerName],
        ["Subscriptions", it.subscriptionCount],
      ],
      steps: () => [
        "Open the filter (link below) and edit its share permissions.",
        "Remove the public (global) share; add the group, project or role that needs it.",
      ],
      done: "The filter is no longer shared publicly, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Filter: ${it.name || it.id}`, L.filter(o, it.id)]],
  }),

  // One task per dashboard: its owner fixes every broken gadget on it in one sitting.
  "dashboards-broken-gadgets": definePlaybook({
    pillar: "dashboards",
    label: "Dashboards with gadgets reading a missing or private filter",
    findings: ["dashboards-broken-gadgets"],
    epic: {
      summary: (n) => `Repair broken gadgets on ${n} ${plural(n, "dashboard")}`,
      why: (n) =>
        `${n} ${plural(n, "dashboard has", "dashboards have")} a gadget reading a filter that is deleted, or private to its owner. Everyone else opening ${plural(n, "it", "them")} sees an error where the chart should be -- and nothing tells the dashboard's owner.`,
      strategy: `For each gadget, point it at a filter its viewers can read (share the existing one, or pick a replacement), or remove the gadget.`,
      done: `Every child task is closed and the next scan reports no dashboard with a broken gadget.`,
    },
    task: {
      heading: "The dashboard",
      summary: (it) =>
        `Repair ${it.brokenGadgets?.length || "the"} broken ${plural(it.brokenGadgets?.length || 0, "gadget")} on "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Dashboard", it.name || it.id],
        ["Owner", it.ownerName],
        [
          "Broken gadgets",
          (it.brokenGadgets || [])
            .map(
              (g) =>
                `${g.title || g.id} (filter ${g.filterId}: ${g.filterState === "private" ? "private" : "missing"})`,
            )
            .join("; "),
        ],
      ],
      steps: () => [
        "Open the dashboard (link below) as someone other than the filter's owner, and find each gadget showing an error.",
        "If the filter is private, share it with the dashboard's audience; if it is gone, choose a replacement filter or remove the gadget.",
      ],
      done: "Every gadget renders for the dashboard's viewers, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Dashboard: ${it.name || it.id}`, L.dashboard(o, it.id)]],
  }),

  "dashboards-public": definePlaybook({
    pillar: "dashboards",
    label: "Dashboards shared publicly",
    findings: ["dashboards-public"],
    epic: {
      summary: (n) => `Take ${n} ${plural(n, "dashboard")} off public sharing`,
      why: (n) =>
        `${n} ${plural(n, "dashboard is", "dashboards are")} shared globally. On a site that allows anonymous access, anyone with the link can open ${plural(n, "it", "them")}, and every gadget renders for them.`,
      strategy: `Share each dashboard with the group or project that uses it.`,
      done: `Every child task is closed and the next scan reports no publicly shared dashboard.`,
    },
    task: {
      heading: "The dashboard",
      summary: (it) => `Remove public sharing from dashboard "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Dashboard", it.name || it.id],
        ["Owner", it.ownerName],
        ["Favourited by", it.popularity],
      ],
      steps: () => [
        "Open the dashboard (link below) and edit its share permissions.",
        "Remove the public (global) share; add the group or project that uses it.",
      ],
      done: "The dashboard is no longer shared publicly, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Dashboard: ${it.name || it.id}`, L.dashboard(o, it.id)]],
  }),

  // One task per account: each is a person (or their manager) to ask, and a seat to free.
  "people-dormant-licences": definePlaybook({
    pillar: "users",
    label: "Licensed accounts idle for a year",
    findings: ["people-dormant-licences"],
    epic: {
      summary: (n) => `Review ${n} licensed ${plural(n, "account")} idle for a year`,
      why: (n) =>
        `${n} licensed ${plural(n, "account has", "accounts have")} not created, updated or been assigned an issue in a year. Each holds a paid seat, and an unused login with its old access intact.`,
      strategy: `Confirm with each person or their manager. Remove the account from its product access group (which frees the seat) or deactivate it; keep it only with a reason written on the ticket.`,
      done: `Every child task is closed and the next scan reports no account idle for a year, or each remaining one carries a documented reason.`,
    },
    task: {
      heading: "The account",
      summary: (it) => `Review idle licence for ${it.displayName || it.accountId || "(unknown)"}`,
      facts: (it) => [
        ["Account", it.displayName],
        ["Account id", it.accountId],
        ["Last issue activity", it.lastActivityAt],
        ["Products", (it.products || []).join(", ")],
        ["Access groups", (it.groups || []).join(", ")],
        ["Owns", it.ownedCount ? `${it.ownedCount} filters, dashboards or rules` : null],
      ],
      steps: () => [
        "Ask the person, or their manager, whether they still need Jira.",
        "If not: reassign anything they own first (the People tab lists it), then remove them from the product access group or deactivate the account.",
        "If they do: note why on this ticket and close it.",
      ],
      done: "The account no longer holds an unused licence, or the reason it does is on this ticket.",
    },
    links: (it, o) => [[`Profile: ${it.displayName || it.accountId}`, L.person(o, it.accountId)]],
  }),

  "filters-shared-everyone": definePlaybook({
    pillar: "filters",
    label: "Filters shared with every logged-in user",
    findings: ["filters-shared-everyone"],
    epic: {
      summary: (n) => `Narrow sharing on ${n} saved ${plural(n, "filter")} shared with everyone`,
      why: (n) =>
        `${n} saved ${plural(n, "filter is", "filters are")} shared with every logged-in user. Anyone can run them, including against projects they can browse but were never meant to survey, and they clutter everyone's filter search.`,
      strategy: `Share each filter with the project, group or role that actually uses it. Keep site-wide sharing only for filters that genuinely serve everyone.`,
      done: `Every child task is closed and the next scan reports no filter shared with everyone that should not be.`,
    },
    task: {
      heading: "The filter",
      summary: (it) => `Narrow sharing on filter "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Filter", it.name || "(unnamed)"],
        ["Filter id", it.id],
        ["Owner", ownerFact(it)],
        ["Favourited by", it.favouritedCount],
      ],
      steps: () => [
        "Open the filter (link below) -> Details -> Edit permissions.",
        'Replace "Any logged-in user" with the project, group or role that uses it.',
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
      why: (n) =>
        `${n} ${plural(n, "dashboard lets", "dashboards let")} any logged-in user rearrange it for everybody who uses it, and the owner is not told.`,
      strategy: `Restrict edit rights to the owner and the team that maintains each dashboard; leave view sharing as it is.`,
      done: `Every child task is closed and the next scan reports no dashboard editable by everyone.`,
    },
    task: {
      heading: "The dashboard",
      summary: (it) => `Restrict editing on dashboard "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Dashboard", it.name || "(unnamed)"],
        ["Dashboard id", it.id],
        ["Owner", ownerFact(it)],
        ["Favourited by", it.popularity],
      ],
      steps: () => [
        "Open the dashboard (link below) -> ... -> Edit and share.",
        'Remove "Any logged-in user" from the editors; add the maintaining team instead.',
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
      why: (n) =>
        `${n} ${plural(n, "dashboard has", "dashboards have")} no gadgets. Anyone opening one sees an empty grid, and each is one more entry in every dashboard search.`,
      strategy: `Ask each owner whether the dashboard was abandoned or never finished. Delete the abandoned ones.`,
      done: `Every child task is closed and the next scan reports no empty dashboards.`,
    },
    task: {
      heading: "The dashboard",
      summary: (it) => `Delete or fill empty dashboard "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Dashboard", it.name || "(unnamed)"],
        ["Dashboard id", it.id],
        ["Owner", ownerFact(it)],
      ],
      steps: () => [
        "Open the dashboard (link below) and confirm it has no gadgets.",
        "Delete it, or add the gadgets it was meant to have.",
      ],
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
      why: (n) =>
        `${n} ${plural(n, "dashboard is", "dashboards are")} shared with every logged-in user and favourited by nobody -- published to everyone, wanted by no one, and in everyone's dashboard search.`,
      strategy: `Check with each owner. Delete dashboards nobody uses; narrow the sharing on any that serve one team.`,
      done: `Every child task is closed and the next scan reports no published-but-unused dashboards.`,
    },
    task: {
      heading: "The dashboard",
      summary: (it) => `Retire or unpublish dashboard "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Dashboard", it.name || "(unnamed)"],
        ["Dashboard id", it.id],
        ["Owner", ownerFact(it)],
        ["Gadgets", it.gadgetCount],
      ],
      steps: () => [
        "Open the dashboard (link below) and confirm with the owner whether anyone uses it.",
        "Delete it, or share it only with the team that does.",
      ],
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
      why: (n) =>
        `Automation rules name ${n} ${plural(n, "account", "accounts")} no longer on the licensed roster -- assigning work to them, notifying them, or conditioning on them. Assignment to a gone account fails or lands work nowhere; conditions on them silently never match.`,
      strategy: `One task per person: repoint each listed rule to the person or role who took over the work, or retire the rule.`,
      done: `Every child task is closed and the next scan reports no automation rule naming an off-roster account.`,
    },
    task: {
      heading: "The account and its rules",
      summary: (it) =>
        `Repoint ${it.ruleCount || 0} automation ${plural(it.ruleCount || 0, "rule")} naming off-roster account ${it.accountId || it.id || "(unknown)"}`,
      facts: (it) => [
        ["Account id", it.accountId || it.id],
        ["Rules naming it", it.ruleCount],
        ...(it.rules || [])
          .slice(0, 40)
          .map((r) => [
            r.name || `Rule ${r.id}`,
            r.direction === "write"
              ? "assigns or sets this account"
              : r.direction === "trigger"
                ? "triggers on this account"
                : "conditions on this account",
          ]),
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
      why: (n) =>
        `${n} issue type ${plural(n, "scheme is", "schemes are")} configured so that issues cannot be created sensibly: only sub-task types, or a default type the scheme does not allow or that is a sub-task.`,
      strategy: `For each scheme, add the standard types its projects need and set a standard type as the default.`,
      done: `Every child task is closed and the next scan reports no hierarchy problems.`,
    },
    task: {
      heading: "The issue type scheme",
      summary: (it) => `Fix the hierarchy of issue type scheme "${it.name || it.schemeId || "(unknown)"}"`,
      facts: (it) => [
        ["Scheme", it.name || "(unnamed)"],
        ["Scheme id", it.schemeId],
        ["Projects using it", it.projectCount],
        ...(it.flags || []).map((f) => ["Problem", f]),
      ],
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
      why: (n) =>
        `${n} issue type ${plural(n, "scheme is", "schemes are")} associated with no project -- one more option in every scheme picker, doing nothing.`,
      strategy: `Confirm each is unassigned, then delete it.`,
      done: `Every child task is closed and the next scan reports no unused issue type schemes.`,
    },
    task: {
      heading: "The issue type scheme",
      summary: (it) => `Delete unused issue type scheme "${it.name || it.schemeId || "(unknown)"}"`,
      facts: (it) => [
        ["Scheme", it.name || "(unnamed)"],
        ["Scheme id", it.schemeId],
      ],
      steps: () => [
        "Open the scheme (link below) and confirm no project uses it.",
        "Delete it from Issue type schemes.",
      ],
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
      why: (n) =>
        `${n} ${plural(n, "group")} of ${nouns} differ only by case, spacing or a character. Every report grouped by ${noun} is split across the synonyms, and people pick whichever they see first.`,
      strategy: `For each group, keep the value that is used most, move issues off the others (Jira offers a replacement when you delete one), then delete them.`,
      done: `Every child task is closed and the next scan reports no near-duplicate ${nouns}.`,
    },
    task: {
      heading: `The ${nouns}`,
      summary: (it) =>
        `Consolidate ${it.count || (it.names || []).length || 0} near-duplicate ${nouns} ("${(it.names || [])[0] || it.key || "?"}")`,
      facts: (it) => [
        ["Match", it.kind],
        ...(it.names || []).map((name) => [`${noun[0].toUpperCase()}${noun.slice(1)}`, name]),
      ],
      steps: () => [
        "Use the search link below to see how many issues use each value.",
        "Keep the most-used one; delete the others, choosing it as the replacement when Jira asks.",
        ...(kind === "priority" ? ["Check priority schemes still list the survivor."] : []),
      ],
      done: `Only one ${noun} remains from this group, and the next Observatory scan no longer flags it.`,
    },
    links: (it, o) => [
      [`${noun[0].toUpperCase()}${noun.slice(1)} admin`, admin(o)],
      ...((it.names || []).length
        ? [[`Issues using these ${nouns}`, L.search(o, `${field} in (${it.names.map(jqlString).join(", ")})`)]]
        : []),
    ],
  });
}

Object.assign(REMEDIATION_PLAYBOOKS, {
  "estate-duplicate-priorities": estatePlaybook({
    kind: "priority",
    noun: "priority",
    nouns: "priorities",
    admin: L.priorityAdmin,
    field: "priority",
  }),
  "estate-duplicate-resolutions": estatePlaybook({
    kind: "resolution",
    noun: "resolution",
    nouns: "resolutions",
    admin: L.resolutionAdmin,
    field: "resolution",
  }),

  "asset-broken-references": definePlaybook({
    pillar: "assets",
    label: "Assets attributes referencing a missing type",
    findings: ["asset-broken-references"],
    epic: {
      summary: (n) => `Fix ${n} Assets reference ${plural(n, "attribute")} pointing at a missing object type`,
      why: (n) =>
        `${n} reference ${plural(n, "attribute points", "attributes point")} at an object type that no longer exists. The link can never be filled in, and anything relying on it (automation, JQL on Assets fields) silently finds nothing.`,
      strategy: `Repoint each attribute at the type it should reference, or delete the attribute if it is obsolete.`,
      done: `Every child task is closed and the next scan reports no broken references.`,
    },
    task: {
      heading: "The attribute",
      summary: (it) =>
        `Fix broken reference attribute "${it.name || it.id || "(unknown)"}"${it.objectTypeName ? ` on ${it.objectTypeName}` : ""}`,
      facts: (it) => [
        ["Attribute", it.name || "(unnamed)"],
        ["Attribute id", it.id],
        ["On object type", it.objectTypeName || it.objectTypeId],
        ["References missing type id", it.referenceObjectTypeId],
      ],
      steps: () => [
        "Open the object type (link below) -> Attributes.",
        "Point the attribute at the right object type, or delete it.",
      ],
      done: "The attribute references a type that exists, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [
      [`Object type: ${it.objectTypeName || it.objectTypeId}`, L.assetType(o, it.schemaId, it.objectTypeId)],
    ],
  }),

  "asset-broken-hierarchy": definePlaybook({
    pillar: "assets",
    label: "Assets object types with a missing parent",
    findings: ["asset-broken-hierarchy"],
    epic: {
      summary: (n) => `Re-parent ${n} Assets object ${plural(n, "type")} whose parent is missing`,
      why: (n) =>
        `${n} object ${plural(n, "type names", "types name")} a parent type that no longer exists, so inherited attributes and the type tree are broken for them.`,
      strategy: `Move each type under the right parent, or make it top-level.`,
      done: `Every child task is closed and the next scan reports no broken hierarchy.`,
    },
    task: {
      heading: "The object type",
      summary: (it) => `Re-parent Assets object type "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Object type", it.name || "(unnamed)"],
        ["Type id", it.id],
        ["Missing parent id", it.parentId],
      ],
      steps: () => [
        "Open the object type (link below).",
        "Move it under the correct parent type, or make it a top-level type.",
      ],
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
      why: (n) =>
        `${n} concrete object ${plural(n, "type has", "types have")} no attributes beyond the system ones -- objects of that type can hold nothing but a name.`,
      strategy: `Add the attributes each type was meant to carry, make it abstract if it is only a grouping, or delete it.`,
      done: `Every child task is closed and the next scan reports no bare object types.`,
    },
    task: {
      heading: "The object type",
      summary: (it) => `Model or remove bare Assets object type "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Object type", it.name || "(unnamed)"],
        ["Type id", it.id],
        ["Schema id", it.schemaId],
      ],
      steps: () => ["Open the object type (link below).", "Add its attributes, mark it abstract, or delete it."],
      done: "The type has attributes, is abstract, or is gone, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Object type: ${it.name || it.id}`, L.assetType(o, it.schemaId, it.id)]],
  }),
});

// ── Fields ──────────────────────────────────────────────────────────────────
//
// Every field finding is one field to adjust, so one shape serves all seven: what the
// finding says, the field's own numbers, and the steps that finding calls for.

const fieldCfNumber = (id) => (String(id || "").match(/^customfield_(\d+)$/) || [])[1] || null;

function fieldPlaybook({ finding, label, epicSummary, why, strategy, steps }) {
  return definePlaybook({
    pillar: "fields",
    label,
    findings: [finding],
    epic: {
      summary: epicSummary,
      why,
      strategy,
      done: `Every child task is closed and the next Observatory scan no longer flags these fields.`,
    },
    task: {
      heading: "The field",
      summary: (it) => `${label}: "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Field", it.name || "(unnamed)"],
        ["Field id", it.id],
        ["Type", it.type],
        ["Projects configured", it.configuredProjectCount],
        ["Issues with a value", it.totalIssueCount],
        ...(it.reasons || []).map((r) => ["Flagged", r]),
      ],
      steps: () => steps,
      done: "The field no longer carries this finding in the next Observatory scan.",
    },
    links: (it, o) => [
      [`Field: ${it.name || it.id}`, L.field(o, it.id)],
      ["Field contexts", L.fieldContexts(o, it.id)],
      ...(fieldCfNumber(it.id)
        ? [["Issues with a value", L.search(o, `cf[${fieldCfNumber(it.id)}] is not EMPTY`)]]
        : []),
    ],
  });
}

Object.assign(REMEDIATION_PLAYBOOKS, {
  "field-admin-attention": fieldPlaybook({
    finding: "admin-attention",
    label: "Field needing admin attention",
    epicSummary: (n) => `Review ${n} custom ${plural(n, "field")} flagged for admin attention`,
    why: (n) =>
      `${n} ${plural(n, "field carries", "fields carry")} a high-severity governance finding, or enough lesser ones to add up to one. These are the fields most likely to cause a problem or cost the most to leave alone.`,
    strategy: `Each task lists why its field was flagged. Work the reasons in order of severity; the field's own findings in the Field Browser explain each one.`,
    steps: [
      "Read the reasons listed above.",
      "Open the field (links below) and address each reason, or record why it stands.",
      "Re-check the field in Observatory's Field Browser.",
    ],
  }),
  "field-risky": fieldPlaybook({
    finding: "risky",
    label: "High-impact field",
    epicSummary: (n) => `Review ${n} high-impact custom ${plural(n, "field")}`,
    why: (n) =>
      `${n} ${plural(n, "field is", "fields are")} flagged risky: used so widely, or by an app so heavily, that a careless change reaches a large share of the site.`,
    strategy: `No field here is broken. Each task makes sure someone owns the field, its description says what it is for, and changes to it go through review.`,
    steps: [
      "Confirm who owns this field and record it in the description.",
      "Check its contexts and options are deliberate.",
      "Treat any future change to it as a reviewed change.",
    ],
  }),
  "field-global-context-low-usage": fieldPlaybook({
    finding: "field-global-context-low-usage",
    label: "Global field used by few projects",
    epicSummary: (n) => `Scope ${n} global ${plural(n, "field")} to the projects that use them`,
    why: (n) =>
      `${n} ${plural(n, "field has", "fields have")} a global context -- offered in every project -- but hardly any issues use it. Every project sees it in pickers, screens and search for nothing.`,
    strategy: `Replace each global context with one scoped to the projects that actually use the field.`,
    steps: [
      "Use the search link below to see which projects have values in it.",
      "Edit the field's context (links below) so it applies to those projects only.",
    ],
  }),
  "field-dead-configuration": fieldPlaybook({
    finding: "field-dead-configuration",
    label: "Field configured where it is not used",
    epicSummary: (n) => `Remove dead configuration from ${n} custom ${plural(n, "field")}`,
    why: (n) =>
      `${n} ${plural(n, "field is", "fields are")} configured for many projects but used in only a few. The rest carry the field for nothing.`,
    strategy: `Trim each field's contexts to the projects with values in it.`,
    steps: [
      "Use the search link below to see which projects use it.",
      "Remove the other projects from its contexts (links below).",
    ],
  }),
  "field-stale": fieldPlaybook({
    finding: "field-stale",
    label: "Field nobody has filled in recently",
    epicSummary: (n) => `Review ${n} custom ${plural(n, "field")} nobody has filled in recently`,
    why: (n) =>
      `${n} ${plural(n, "field has", "fields have")} values, but none has been set in a long time. Either the process that used ${plural(n, "it", "them")} ended, or ${plural(n, "it is", "they are")} kept only for history.`,
    strategy: `Confirm with the owning team. Remove a field no longer needed from its screens (history stays); delete it only if the history does not matter.`,
    steps: [
      "Ask the owning team whether the field is still part of their process.",
      "If not, take it off its screens so nobody fills it in by mistake.",
      "Delete it only if its historical values are not needed.",
    ],
  }),
  "field-context-sprawl": fieldPlaybook({
    finding: "field-context-sprawl",
    label: "Field with many contexts",
    epicSummary: (n) => `Consolidate contexts on ${n} custom ${plural(n, "field")}`,
    why: (n) =>
      `${n} ${plural(n, "field has", "fields have")} many contexts. Each context carries its own option list and default, so the same field behaves differently from project to project and every option change has to be made several times.`,
    strategy: `Merge contexts that share the same options, leaving separate contexts only where projects genuinely need different ones.`,
    steps: [
      "Open the field's contexts (links below).",
      "Merge contexts with identical options; keep separate ones only where the options really differ.",
    ],
  }),
  "field-missing-description": fieldPlaybook({
    finding: "field-missing-description",
    label: "Widely used field with no description",
    epicSummary: (n) => `Describe ${n} widely used custom ${plural(n, "field")}`,
    why: (n) =>
      `${n} ${plural(n, "field is", "fields are")} used across many projects or issues and ${plural(n, "has", "have")} no description, so the only way to learn what ${plural(n, "it is", "they are")} for is to ask someone.`,
    strategy: `Write one sentence per field: what it records and who owns it.`,
    steps: [
      "Open the field (link below) -> Edit details.",
      "Add a one-sentence description: what it records, and who owns it.",
    ],
  }),
});

// ── Field schemes / field configurations ────────────────────────────────────

// A legacy owner links to its admin page; a field scheme has no published URL yet.
const fieldOwnerLink = (it, o) => {
  if (it.kind === "config") return L.fieldConfiguration(o, it.sourceId);
  if (it.kind === "scheme" && String(it.id || "").startsWith("fcs:") && it.sourceId)
    return L.fieldConfigurationScheme(o, it.sourceId);
  return null;
};
const FIELD_OWNER_NOUN = { config: "field configuration", scheme: "field scheme" };

Object.assign(REMEDIATION_PLAYBOOKS, {
  "fieldconfig-required-hidden": definePlaybook({
    pillar: "fieldConfigs",
    label: "Fields required but hidden",
    findings: ["fieldconfig-required-hidden"],
    epic: {
      summary: (n) => `Fix ${n} field ${plural(n, "configuration")} that require a field they also hide`,
      why: (n) =>
        `${n} field ${plural(n, "configuration requires", "configurations require")} at least one field that ${plural(n, "it", "they")} also hide${n === 1 ? "s" : ""}. Nobody can fill in a hidden field, so every create or edit through ${plural(n, "it", "them")} fails with a validation error that names a field the user cannot see.`,
      strategy: `For each configuration, decide per field whether it should be visible (unhide it) or not required (make it optional). Check the projects and work types that use the configuration first.`,
      done: `Every child task is closed and the next scan reports no required-and-hidden fields.`,
    },
    task: {
      heading: "The field configuration",
      summary: (it) =>
        `Unhide or make optional ${it.fieldNames?.length ?? "the"} ${plural(it.fieldNames?.length || 0, "field")} in "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Field configuration", it.name || it.id],
        ["Required but hidden", (it.fieldNames || []).join(", ")],
        ["Used by", (it.usedBy || []).join("; ")],
      ],
      steps: () => [
        "Open the field configuration (link below).",
        "For each field listed, either Show it or make it Optional.",
        "Create an issue in one of the affected projects to confirm the form submits.",
      ],
      done: "No field in the configuration is both required and hidden, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Field configuration: ${it.name || it.id}`, fieldOwnerLink({ ...it, kind: "config" }, o)]],
  }),

  "fieldconfig-unused": definePlaybook({
    pillar: "fieldConfigs",
    label: "Field schemes and configurations no project uses",
    findings: ["fieldconfig-unused"],
    epic: {
      summary: (n) => `Delete ${n} unused field ${plural(n, "scheme or configuration", "schemes and configurations")}`,
      why: (n) =>
        `${n} field ${plural(n, "scheme or configuration is", "schemes and configurations are")} used by no project. Each is one more option in every picker, and one more place a field's required or hidden setting can be changed for nobody.`,
      strategy: `Confirm each is genuinely unassigned (the scan can be a day old), then delete it. Default schemes and configurations are never included. Keep any held deliberately as a template, and say so on its ticket.`,
      done: `Every child task is closed and the next scan reports no unused field schemes or configurations.`,
    },
    task: {
      heading: "The unused item",
      summary: (it) =>
        `Delete unused ${FIELD_OWNER_NOUN[it.kind] || "field scheme"} "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Kind", FIELD_OWNER_NOUN[it.kind]],
        ["Name", it.name || it.id],
        ["Id", it.sourceId],
      ],
      steps: () => [
        "Open it (link below) and confirm no project uses it.",
        "Delete it, or close this ticket noting it is kept as a template.",
      ],
      done: "It no longer exists or is documented as a template, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [
      [`${FIELD_OWNER_NOUN[it.kind] || "Field scheme"}: ${it.name || it.id}`, fieldOwnerLink(it, o)],
      ["Field configurations admin", it.kind === "config" ? L.fieldConfigurationsAdmin(o) : null],
    ],
  }),

  "fieldconfig-duplicates": definePlaybook({
    pillar: "fieldConfigs",
    label: "Duplicate field schemes and configurations",
    findings: ["fieldconfig-duplicates"],
    granularity: "group",
    epic: {
      summary: (n) => `Consolidate ${n} group${n === 1 ? "" : "s"} of identical field schemes or configurations`,
      why: (n) =>
        `${n} group${n === 1 ? " of field schemes or configurations is" : "s of field schemes or configurations are"} identical. Every change to a required field or a description has to be made in each copy, and the copy somebody forgets is how two projects drift apart.`,
      strategy: `For each group, keep the one named on the ticket, point every project using the others at it, then delete the others.`,
      done: `Every child task is closed and the next scan reports no duplicate groups.`,
    },
    task: {
      heading: "The duplicates",
      summary: (it) =>
        `Consolidate ${it.members?.length ?? "the"} identical ${FIELD_OWNER_NOUN[it.kind] || "field scheme"}s into "${it.keepName || it.keep || "(unknown)"}"`,
      facts: (it) => [
        ["Keep", it.keepName || it.keep],
        ["Duplicates", (it.memberNames || []).filter((n) => n !== it.keepName).join(", ")],
      ],
      steps: (it) => [
        `Move every project using a duplicate onto "${it.keepName || it.keep || "the one to keep"}".`,
        "Delete each duplicate once no project uses it.",
      ],
      done: "One remains from the group, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) =>
      (it.members || []).map((m, i) => [
        `${FIELD_OWNER_NOUN[it.kind] || "Field scheme"}: ${(it.memberNames || [])[i] || m}`,
        fieldOwnerLink({ kind: it.kind, id: m, sourceId: (it.memberSourceIds || [])[i] }, o),
      ]),
  }),
});

// ── Workflows ───────────────────────────────────────────────────────────────

const REF_NOUN = { field: "field", group: "group", role: "project role" };

Object.assign(REMEDIATION_PLAYBOOKS, {
  // One task per workflow, listing every broken reference in it: the person who fixes them
  // opens one workflow once, not one ticket per validator.
  "workflow-broken-references": definePlaybook({
    pillar: "workflows",
    label: "Workflow rules naming deleted fields or groups",
    findings: ["workflow-broken-references"],
    granularity: "group",
    epic: {
      summary: (n) => `Repair ${n} ${plural(n, "workflow")} whose rules name a deleted field, group or role`,
      why: (n) =>
        `${n} ${plural(n, "workflow has", "workflows have")} a condition, validator, post-function or status property pointing at something the site no longer has. A validator requiring a deleted field blocks the transition or stops validating; a status locked to a deleted group may lock everyone out of editing.`,
      strategy: `Open each workflow, find the transitions and statuses listed, and either point the rule at the field or group that replaced it or remove the rule.`,
      done: `Every child task is closed and the next scan reports no workflow rule naming a missing field, group or role.`,
    },
    task: {
      heading: "The workflow",
      summary: (it) =>
        `Repair ${it.count ?? "the"} broken ${plural(Number(it.count) || 0, "reference")} in workflow "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Workflow", it.name || it.id],
        [
          "Broken references",
          (it.refs || []).map((r) => `${REF_NOUN[r.type] || r.type} ${r.id} (${r.where})`).join("; "),
        ],
      ],
      steps: () => [
        "Open the workflow (link below) and edit a draft.",
        "For each transition or status listed, open its conditions, validators, post-functions or properties.",
        "Point the rule at the field, group or role that replaced the missing one, or remove the rule.",
        "Publish the draft.",
      ],
      done: "The workflow names nothing missing, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Workflow: ${it.name || it.id}`, L.workflow(o, it.name || it.id)]],
  }),

  "workflows-inactive": definePlaybook({
    pillar: "workflows",
    label: "Inactive workflows",
    findings: ["workflows-inactive"],
    epic: {
      summary: (n) => `Delete ${n} inactive ${plural(n, "workflow")}`,
      why: (n) =>
        `${n} company-managed ${plural(n, "workflow is", "workflows are")} used by no project's workflow scheme. ${plural(n, "It governs", "They govern")} nothing, but ${plural(n, "its", "their")} rules and properties still name fields and groups, which keeps those looking in use.`,
      strategy: `Confirm each workflow is genuinely unused (Jira lists inactive workflows separately), then delete it. Keep any you are deliberately holding as a template.`,
      done: `Every child task is closed and the next scan reports no inactive workflows.`,
    },
    task: {
      heading: "The workflow",
      summary: (it) => `Delete inactive workflow "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Workflow", it.name || it.id],
        ["Statuses", it.statusCount],
        ["Transition rules", it.ruleCount],
      ],
      steps: () => [
        "Open the workflow list (link below) and confirm this workflow is under Inactive.",
        "If it is kept as a template, say so on this ticket and close it; otherwise delete it.",
      ],
      done: "The workflow is deleted or documented as a template, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [
      [`Workflow: ${it.name || it.id}`, L.workflow(o, it.name || it.id)],
      ["Workflows admin", L.workflowsAdmin(o)],
    ],
  }),

  "workflow-duplicate-statuses": definePlaybook({
    pillar: "workflows",
    label: "Duplicate statuses",
    findings: ["duplicate-statuses", "reducible-statuses"],
    granularity: "group",
    epic: {
      summary: (n) => `Consolidate ${n} ${plural(n, "group")} of duplicate statuses`,
      why: (n) =>
        `${n} ${plural(n, "group")} of statuses are the same status under different spellings. Boards, filters and reports split across the variants, and people pick whichever they see first.`,
      strategy: `For each group, keep the most-used status, change every workflow to use it, move issues off the others, then delete them.`,
      done: `Every child task is closed and the next scan reports no duplicate statuses.`,
    },
    task: {
      heading: "The statuses",
      summary: (it) =>
        `Consolidate ${it.count || (it.statuses || []).length || 0} duplicate statuses ("${(it.statuses || [])[0]?.name || it.key || "?"}")`,
      facts: (it) => [
        ["Match", it.kind],
        ...(it.statuses || []).map((st) => [
          st.name || st.statusId,
          st.issueCount != null ? `${st.issueCount} issues now` : `id ${st.statusId}`,
        ]),
      ],
      steps: () => [
        "Pick the survivor -- usually the one with the most issues.",
        "In every workflow using the others, swap in the survivor (workflow schemes migrate issues when published).",
        "Delete the leftover statuses once no workflow uses them.",
      ],
      done: "Only one status remains from this group, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [
      ["Statuses admin", L.statusAdmin(o)],
      ...(it.statuses || []).map((st) => [
        `Issues in "${st.name || st.statusId}"`,
        L.search(o, `status = ${st.statusId}`),
      ]),
    ],
  }),

  "rule-only-statuses": definePlaybook({
    pillar: "workflows",
    label: "Statuses only automation reaches",
    findings: ["rule-only-statuses"],
    epic: {
      summary: (n) => `Resolve ${n} ${plural(n, "status", "statuses")} only an automation rule can reach`,
      why: (n) =>
        `${n} ${plural(n, "status is", "statuses are")} on no workflow, yet an automation rule still names ${plural(n, "it", "them")}. The rule either fails when it runs or sets a status no workflow can move an issue out of.`,
      strategy: `For each status, either put it back on the workflow that should have it, or change the rule to use a status that exists in that workflow.`,
      done: `Every child task is closed and the next scan reports no rule-only statuses.`,
    },
    task: {
      heading: "The status",
      summary: (it) => `Resolve rule-only status "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Status", it.name],
        ["Status id", it.id],
        ["Rules naming it", it.automationRuleCount],
        ["Issues in it now", it.issueCount],
      ],
      steps: () => [
        "Find the rules naming this status (Workflows tab -> the status's detail).",
        "Add the status to the workflow that should have it, or repoint the rule to an existing status.",
      ],
      done: "A workflow reaches the status or no rule names it, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [
      ["Statuses admin", L.statusAdmin(o)],
      [`Issues in "${it.name || it.id}"`, it.id ? L.search(o, `status = ${it.id}`) : null],
    ],
  }),

  "unreachable-with-issues": definePlaybook({
    pillar: "workflows",
    label: "Unreachable statuses still holding issues",
    findings: ["unreachable-with-issues"],
    epic: {
      summary: (n) => `Rescue issues stuck in ${n} unreachable ${plural(n, "status", "statuses")}`,
      why: (n) =>
        `${n} ${plural(n, "status holds", "statuses hold")} issues, but no workflow includes ${plural(n, "it", "them")} any more. Those issues cannot be transitioned: they are stuck until someone moves them by hand.`,
      strategy: `Move each status's issues into a status their workflow does have, then retire the status.`,
      done: `Every child task is closed and the next scan reports no unreachable status holding issues.`,
    },
    task: {
      heading: "The status",
      summary: (it) =>
        `Move ${it.issueCount ?? "the"} ${plural(Number(it.issueCount) || 0, "issue")} out of unreachable status "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Status", it.name],
        ["Status id", it.id],
        ["Issues stuck in it", it.issueCount],
      ],
      steps: () => [
        "Open the stuck issues (link below).",
        "Temporarily add the status back to their workflow with a transition out, or migrate the project's workflow scheme and map the status.",
        "Move the issues out, then remove the status from the workflow again.",
      ],
      done: "No issue sits in the status, and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [
      [`Issues in "${it.name || it.id}"`, it.id ? L.search(o, `status = ${it.id}`) : null],
      ["Statuses admin", L.statusAdmin(o)],
    ],
  }),

  "workflow-scheme-structure": definePlaybook({
    pillar: "workflows",
    label: "Workflow schemes with a structural problem",
    findings: ["scheme-balance", "scheme-no-done"],
    epic: {
      summary: (n) => `Fix ${n} workflow ${plural(n, "scheme")} with a structural problem`,
      why: (n) =>
        `${n} workflow ${plural(n, "scheme has", "schemes have")} a structural problem: no Done status (nothing can ever be completed), uncategorised statuses that fall out of reporting, far more In Progress than Done statuses, or too many statuses to hold in your head.`,
      strategy: `Each task lists its scheme's problems. Fix no-Done first -- it breaks resolution, reports and board completion outright.`,
      done: `Every child task is closed and the next scan reports no flagged workflow schemes.`,
    },
    task: {
      heading: "The workflow scheme",
      summary: (it) => `Fix workflow scheme "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Scheme", it.name],
        ["Scheme id", it.id],
        ["Projects using it", it.projectCount],
        ...(it.flags || []).map((f) => ["Problem", f]),
      ],
      steps: () => [
        "Open the scheme (link below) and edit the workflows it uses.",
        "No Done status: add one and a transition into it. Uncategorised: give each status a category.",
        "Too many statuses: merge the ones that mean the same thing.",
      ],
      done: "The scheme has no structural finding in the next Observatory scan.",
    },
    links: (it, o) => [[`Workflow scheme: ${it.name || it.id}`, L.workflowScheme(o, it.id)]],
  }),
});

// ── Projects ────────────────────────────────────────────────────────────────

function projectPlaybook({ findings, label, epicSummary, why, strategy, facts, steps }) {
  return definePlaybook({
    pillar: "projects",
    label,
    findings,
    epic: {
      summary: epicSummary,
      why,
      strategy,
      done: `Every child task is closed and the next Observatory scan no longer flags these projects.`,
    },
    task: {
      heading: "The project",
      summary: (it) => `${label}: ${it.projectKey || it.id || "(unknown)"}`,
      facts: (it) => [
        ["Project", it.projectName ? `${it.projectName} (${it.projectKey})` : it.projectKey],
        ...facts(it),
      ],
      steps: () => steps,
      done: "The project no longer carries this finding in the next Observatory scan.",
    },
    links: (it, o) => [
      [`${it.projectKey} project`, L.project(o, it.projectKey)],
      [`${it.projectKey} settings`, L.projectSettings(o, it.projectKey)],
    ],
  });
}

Object.assign(REMEDIATION_PLAYBOOKS, {
  "project-over-configured": projectPlaybook({
    findings: ["over-configured", "idle-over-configured"],
    label: "Over-configured project",
    epicSummary: (n) => `Trim field configuration in ${n} over-configured ${plural(n, "project")}`,
    why: (n) =>
      `${n} ${plural(n, "project carries", "projects carry")} at least twice the site's typical number of fields -- more to fill in on every create screen, and more for every field change to reach. Idle projects among them carry it for almost no work.`,
    strategy: `For each project, remove the fields it never fills in from its screens and contexts. Idle projects first: they carry the most configuration per issue.`,
    facts: (it) => [
      ["Fields in use", it.fieldCount],
      ["Issue volume", it.volume],
      ["Idle", it.idle ? "yes -- very little work for its size" : null],
    ],
    steps: [
      "Open the project in Observatory's Projects tab to see which fields it never fills in.",
      "Remove those fields from its screens, and the project from their contexts.",
    ],
  }),
  "unused-projects": projectPlaybook({
    findings: ["unused-projects"],
    label: "Project with no issues",
    epicSummary: (n) => `Archive or delete ${n} ${plural(n, "project")} with no issues`,
    why: (n) =>
      `${n} ${plural(n, "project has", "projects have")} fields configured but no issues at all -- set up and never used, still in every project picker.`,
    strategy: `Confirm with each lead, then archive the project (or delete it if it was never meant to exist).`,
    facts: (it) => [["Fields configured", it.fieldCount]],
    steps: [
      "Confirm with the project lead that it is not about to be used.",
      "Archive it (Project settings -> Archive), or delete it.",
    ],
  }),
  "stale-projects": projectPlaybook({
    findings: ["stale-projects"],
    label: "Project untouched for six months",
    epicSummary: (n) => `Review ${n} ${plural(n, "project")} nobody has touched in six months`,
    why: (n) =>
      `No issue in ${n} ${plural(n, "project has", "projects have")} been updated in over 180 days. Either the work moved elsewhere or the project is finished.`,
    strategy: `Confirm with each lead, then archive finished projects so they leave pickers and search.`,
    facts: (it) => [
      ["Last issue update", it.latestIssueUpdatedAt],
      ["Fields", it.fieldCount],
    ],
    steps: ["Confirm with the lead whether the project is finished or the work moved.", "Archive it if it is done."],
  }),
  "projects-fell-off": projectPlaybook({
    findings: ["projects-fell-off"],
    label: "Project whose activity fell off",
    epicSummary: (n) => `Check on ${n} ${plural(n, "project")} whose activity fell off`,
    why: (n) =>
      `${n} ${plural(n, "project is", "projects are")} running far below ${plural(n, "its", "their")} own historical rate. Work may have moved to another project or tool, leaving this one half-used.`,
    strategy: `Ask each lead where the work went. Consolidate or archive where it moved; leave alone where it is simply quiet.`,
    facts: (it) => [
      ["Issues per day now", it.recentIssuesPerDay],
      ["Issues per day historically", it.issuesPerDay],
      ["Peak month", it.peakMonth],
    ],
    steps: [
      "Ask the lead where the project's work is happening now.",
      "Consolidate into the project it moved to, archive, or record that it is simply quiet.",
    ],
  }),
  "projects-never-adopted": projectPlaybook({
    findings: ["projects-never-adopted"],
    label: "Project never adopted",
    epicSummary: (n) => `Check on ${n} ${plural(n, "project")} that never took off`,
    why: (n) =>
      `${n} ${plural(n, "project was", "projects were")} set up and used a little, but never reached a working rate.`,
    strategy: `Ask each lead whether the project is still wanted. Archive the ones that are not.`,
    facts: (it) => [
      ["Issues per day", it.issuesPerDay],
      ["Age (days)", it.ageDays],
    ],
    steps: ["Ask the lead whether the project is still wanted.", "Archive it if not."],
  }),
});

// ── Screens ─────────────────────────────────────────────────────────────────

function screenPlaybook({ finding, label, epicSummary, why, strategy, steps }) {
  return definePlaybook({
    pillar: "screens",
    label,
    findings: [finding],
    epic: {
      summary: epicSummary,
      why,
      strategy,
      done: `Every child task is closed and the next Observatory scan no longer flags these screens.`,
    },
    task: {
      heading: "The screen",
      summary: (it) => `${label}: "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Screen", it.name],
        ["Screen id", it.id],
        ["Tabs", it.tabCount],
        ["Fields", it.fieldCount],
      ],
      steps: () => steps,
      done: "The screen no longer carries this finding in the next Observatory scan.",
    },
    links: (it, o) => [[`Screen: ${it.name || it.id}`, L.screen(o, it.id)]],
  });
}

Object.assign(REMEDIATION_PLAYBOOKS, {
  "screen-empty": screenPlaybook({
    finding: "screen-empty",
    label: "Screen with no fields",
    epicSummary: (n) => `Delete or fill ${n} ${plural(n, "screen")} with no fields`,
    why: (n) =>
      `${n} ${plural(n, "screen carries", "screens carry")} no fields at all. Anything routed to one shows an empty form.`,
    strategy: `Delete screens nothing routes to; add fields to any a scheme still uses.`,
    steps: [
      "Open the screen (link below) and check which screen schemes use it.",
      "Delete it if none do; otherwise add the fields it was meant to carry.",
    ],
  }),
  "screen-unreached": screenPlaybook({
    finding: "screen-unreached",
    label: "Screen nothing reaches",
    epicSummary: (n) => `Delete ${n} ${plural(n, "screen")} nothing reaches`,
    why: (n) =>
      `${n} ${plural(n, "screen is", "screens are")} used by no screen scheme and opened by no workflow transition. Nobody can ever see ${plural(n, "it", "them")}; ${plural(n, "it is", "they are")} clutter in every screen search.`,
    strategy: `Confirm each is unused, then delete it.`,
    steps: ["Open the screen (link below) and confirm no scheme or transition uses it.", "Delete it."],
  }),
  "screen-transition-only": screenPlaybook({
    finding: "screen-transition-only",
    label: "Screen opened only by a transition",
    epicSummary: (n) => `Review ${n} ${plural(n, "screen")} opened only by a workflow transition`,
    why: (n) =>
      `${n} ${plural(n, "screen is", "screens are")} reached only as a transition screen. That is often deliberate -- but a transition screen that asks for fields nobody reads is friction on every transition.`,
    strategy: `For each, confirm the transition still needs to ask for these fields; drop the screen from the transition if not.`,
    steps: [
      "Open the screen (link below) and find the transition that shows it (Workflows tab).",
      "Keep it if the transition genuinely needs the input; otherwise remove it from the transition and delete it.",
    ],
  }),
  "screen-unresolved": screenPlaybook({
    finding: "screen-unresolved",
    label: "Screen whose contents could not be read",
    epicSummary: (n) => `Check ${n} ${plural(n, "screen")} Observatory could not read`,
    why: (n) =>
      `Observatory could not read the tabs and fields of ${n} ${plural(n, "screen")}, so every screen finding for ${plural(n, "it", "them")} is "unknown" rather than clean.`,
    strategy: `Open each screen to confirm it is intact; a screen Jira itself cannot render is usually broken and should be rebuilt or deleted.`,
    steps: [
      "Open the screen (link below).",
      "If it renders, re-run the screen scan; if it does not, rebuild or delete it.",
    ],
  }),
  "screen-dangling": definePlaybook({
    pillar: "screens",
    label: "Screen schemes pointing at a missing screen",
    findings: ["screen-dangling"],
    granularity: "group",
    epic: {
      summary: (n) => `Repair ${n} screen ${plural(n, "scheme")} pointing at a missing screen`,
      why: (n) =>
        `${n} screen ${plural(n, "scheme maps", "schemes map")} an operation (create, edit, view) to a screen that no longer exists. Jira falls back unpredictably for those operations.`,
      strategy: `For each scheme, point every listed operation at a screen that exists.`,
      done: `Every child task is closed and the next scan reports no dangling screen operations.`,
    },
    task: {
      heading: "The screen scheme",
      summary: (it) =>
        `Repair ${(it.operations || []).length || "the"} dangling ${plural((it.operations || []).length, "operation")} in screen scheme "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Screen scheme", it.name],
        ["Scheme id", it.id],
        ...(it.operations || []).map((op) => [
          `Operation: ${op.operation}`,
          `missing screen ${op.screenId || "(none)"}`,
        ]),
      ],
      steps: () => ["Open the screen scheme (link below).", "For each listed operation, choose a screen that exists."],
      done: "Every operation in the scheme maps to a real screen, and the next Observatory scan agrees.",
    },
    links: (it, o) => [[`Screen scheme: ${it.name || it.id}`, L.screenScheme(o, it.id)]],
  }),
  "screen-unused-schemes": definePlaybook({
    pillar: "screens",
    label: "Screen schemes nothing uses",
    findings: ["screen-unused-schemes"],
    epic: {
      summary: (n) => `Delete ${n} screen ${plural(n, "scheme")} no issue type screen scheme uses`,
      why: (n) =>
        `${n} screen ${plural(n, "scheme is", "schemes are")} mapped by no issue type screen scheme, so ${plural(n, "it", "they")} can route nothing to any project.`,
      strategy: `Confirm each is unused, then delete it.`,
      done: `Every child task is closed and the next scan reports no unused screen schemes.`,
    },
    task: {
      heading: "The screen scheme",
      summary: (it) => `Delete unused screen scheme "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Screen scheme", it.name],
        ["Scheme id", it.id],
      ],
      steps: () => ["Open the scheme (link below) and confirm nothing maps to it.", "Delete it."],
      done: "The scheme no longer exists and the next Observatory scan no longer flags it.",
    },
    links: (it, o) => [[`Screen scheme: ${it.name || it.id}`, L.screenScheme(o, it.id)]],
  }),
});

// ── Automation ──────────────────────────────────────────────────────────────
//
// Only disabled rules are known in full: the rule directory lists every rule. The risk
// findings come from the stored analysis, which keeps a preview of the highest-severity rules
// -- the loaders say so (`partial`) rather than presenting the preview as the whole list.

function automationPlaybook({ finding, label, epicSummary, why, strategy, facts = () => [], steps }) {
  return definePlaybook({
    pillar: "automation",
    label,
    findings: [finding],
    epic: {
      summary: epicSummary,
      why,
      strategy,
      done: `Every child task is closed and the next automation import no longer flags these rules.`,
    },
    task: {
      heading: "The rule",
      summary: (it) => `${label}: "${it.name || it.id || "(unknown)"}"`,
      facts: (it) => [
        ["Rule", it.name],
        ["Rule id", it.id],
        ["Enabled", it.enabled == null ? null : it.enabled ? "yes" : "no"],
        ["Trigger", it.triggerType],
        ["Projects", it.projectCount],
        ...facts(it),
      ],
      steps: () => steps,
      done: "The rule no longer carries this finding after the next automation import.",
    },
    links: (it, o) => [[`Rule: ${it.name || it.id}`, L.automationRule(o, it.id)]],
  });
}

Object.assign(REMEDIATION_PLAYBOOKS, {
  "automation-credentials": automationPlaybook({
    finding: "automation-credentials",
    label: "Rule storing a credential in plaintext",
    epicSummary: (n) => `Rotate and remove plaintext credentials from ${n} automation ${plural(n, "rule")}`,
    why: (n) =>
      `${n} automation ${plural(n, "rule stores", "rules store")} a credential -- a token, secret or password -- in plaintext. Anyone who can view the rule, or its audit log or export, can read it.`,
    strategy: `Treat every credential here as exposed: rotate it at the source first, then change the rule to authenticate without embedding it. This ticket never contains the credential itself.`,
    steps: [
      "Identify the system the credential belongs to (the rule's web request or action).",
      "Rotate the credential at its source now -- assume it is compromised.",
      "Change the rule to authenticate without a plaintext secret (a connection or a narrowly scoped token), or remove the action.",
    ],
  }),
  "automation-external": automationPlaybook({
    finding: "automation-external",
    label: "Rule calling an external host",
    epicSummary: (n) => `Review ${n} automation ${plural(n, "rule")} sending data to external hosts`,
    why: (n) =>
      `${n} automation ${plural(n, "rule sends", "rules send")} web requests outside Atlassian. Each is a path for issue data to leave the site, and fails silently if the host changes.`,
    strategy: `Confirm each host is approved and still needed; remove requests to anything unrecognised.`,
    facts: (it) => [["Hosts", (it.hosts || []).join(", ")]],
    steps: [
      "Confirm the host is an approved destination.",
      "Check what issue data the request sends.",
      "Remove or disable the request if the host is not approved or no longer needed.",
    ],
  }),
  "automation-inert": automationPlaybook({
    finding: "automation-inert",
    label: "Rule with no actions",
    epicSummary: (n) => `Finish or delete ${n} automation ${plural(n, "rule")} with no actions`,
    why: (n) =>
      `${n} automation ${plural(n, "rule has", "rules have")} a trigger but no actions -- ${plural(n, "it runs", "they run")}, count against the execution limit, and ${plural(n, "does", "do")} nothing.`,
    strategy: `Finish each rule if it was abandoned half-built; delete it otherwise.`,
    steps: ["Open the rule and confirm it has no actions.", "Add the actions it was meant to have, or delete it."],
  }),
  "automation-self-triggering": automationPlaybook({
    finding: "automation-self-triggering",
    label: "Rule that can trigger itself",
    epicSummary: (n) =>
      `Guard ${n} automation ${plural(n, "rule")} that can trigger ${plural(n, "itself", "themselves")}`,
    why: (n) =>
      `${n} automation ${plural(n, "rule changes", "rules change")} the very thing that triggers ${plural(n, "it", "them")}. Without a guard condition, one event can loop until Jira's loop limit stops it -- burning executions and spamming history.`,
    strategy: `Add a condition that stops the second run, or narrow the trigger.`,
    steps: [
      "Open the rule and find the action that re-triggers it.",
      "Add a condition that is false after the rule's own change, or narrow the trigger.",
    ],
  }),
  "automation-disabled": automationPlaybook({
    finding: "automation-disabled",
    label: "Disabled rule",
    epicSummary: (n) => `Delete or re-enable ${n} disabled automation ${plural(n, "rule")}`,
    why: (n) =>
      `${n} automation ${plural(n, "rule is", "rules are")} disabled. Each is clutter in the rule list and a question for the next admin: switched off on purpose, or by accident?`,
    strategy: `Confirm with each rule's owner. Delete rules nobody needs; re-enable the ones switched off by mistake.`,
    steps: [
      "Check with the rule's author or owning team.",
      "Delete it if obsolete, or re-enable it if it was switched off by mistake.",
    ],
  }),
});

// ── Links and finding coverage for the hand-written playbooks ──────────────

const LEGACY_META = {
  "filter-ownership": {
    label: "Filter ownership",
    findings: ["filters-orphaned"],
    links: (it, o) => [[`Filter: ${it.name || it.id}`, L.filter(o, it.id)]],
  },
  "dashboard-ownership": {
    label: "Dashboard ownership",
    findings: ["dashboards-orphaned"],
    links: (it, o) => [[`Dashboard: ${it.name || it.id}`, L.dashboard(o, it.id)]],
  },
  "user-licence-hygiene": {
    label: "Licence hygiene",
    findings: ["people-deactivated-licence"],
    links: (it, o) => [[`Profile: ${it.displayName || it.accountId}`, L.person(o, it.accountId || it.id)]],
  },
  "user-ownership": {
    label: "Ownership continuity",
    findings: ["people-orphaned-ownership"],
    links: (it, o) => {
      const [kind, id] = String(it.id || "").split(":");
      const url =
        kind === "filter"
          ? L.filter(o, id)
          : kind === "dashboard"
            ? L.dashboard(o, id)
            : kind === "rule"
              ? L.automationRule(o, id)
              : null;
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
    links: (it, o) => [
      [`Board: ${it.name || it.id}`, L.board(o, it.id)],
      ...(it.filterId ? [[`Filter ${it.filterId}`, L.filter(o, it.filterId)]] : []),
    ],
  },
  "field-cleanup": {
    label: "Fields with no populated issues",
    findings: ["field-no-populated-issues"],
    links: (it, o) => [
      [`Field: ${it.name || it.id}`, L.field(o, it.id)],
      ["Field contexts", L.fieldContexts(o, it.id)],
    ],
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
  "screen-unreachable-fields": {
    label: "Unreachable fields",
    findings: [],
    links: (it, o) => [[`Field contexts: ${it.fieldName || it.fieldId}`, L.fieldContexts(o, it.fieldId)]],
  },
  "issue-type-reach": {
    label: "Orphaned issue types",
    findings: ["issue-type-orphans"],
    links: (it, o) => [
      ["Issue types admin", L.issueTypeAdmin(o)],
      [`Issues of type "${it.name || it.id}"`, it.id ? L.search(o, `issuetype = ${it.id}`) : null],
    ],
  },
  "issue-type-naming": {
    label: "Duplicate issue type names",
    findings: ["issue-type-duplicates"],
    granularity: "group",
    links: (it, o) => [
      ["Issue types admin", L.issueTypeAdmin(o)],
      ...(it.types || []).map((t) => [`Issues of type "${t.name || t.id}"`, L.search(o, `issuetype = ${t.id}`)]),
    ],
  },
  "asset-schema-hygiene": {
    label: "Dead Assets schemas",
    findings: ["asset-dead-schemas"],
    links: (it, o) => [[`Assets schema: ${it.name || it.id}`, L.assetSchema(o, it.id)]],
  },
  "asset-type-usage": {
    label: "Empty Assets object types",
    findings: [],
    links: (it, o) => [[`Object type: ${it.name || it.id}`, L.assetType(o, it.schemaId, it.id)]],
  },
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
  Object.entries(REMEDIATION_PLAYBOOKS).flatMap(([key, p]) => (p.findings || []).map((f) => [f, key])),
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
