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
