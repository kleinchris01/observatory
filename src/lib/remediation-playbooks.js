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

const BASE_LABEL = "observatory-remediation";

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
    epicSummary: (n) => `Review ${n} orphaned custom field${n === 1 ? "" : "s"} for deletion`,
    epicDescription: ({ count = 0 } = {}) => `
## Why this matters
${count} custom field${count === 1 ? " has" : "s have"} no project context, no configuration, and no recorded issue
usage anywhere on the site. Each one is still in every field picker, every screen admin
search, and every "add field" dropdown a project admin sees -- pure clutter with nothing
behind it.

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
No project contexts, no configured screens, and no populated issues found in the last
Observatory scan.

## Steps
- Re-check the field in Observatory's Field Browser to confirm it is still orphaned (a
  screen or context change since the scan can un-orphan a field).
- Search for the field id in any saved filters, dashboards or automation rules before
  deleting -- Observatory's own dependency graph is the fastest way to check this.
- Delete the field in Jira -> Issues -> Custom fields.

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

for (const p of Object.values(REMEDIATION_PLAYBOOKS)) {
  p.labels = [BASE_LABEL, p.pillar];
}

export function getPlaybook(findingKey) {
  return REMEDIATION_PLAYBOOKS[findingKey] || null;
}

export function listPlaybookKeys() {
  return Object.keys(REMEDIATION_PLAYBOOKS);
}
