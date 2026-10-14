// "Do this first": every governance row on the Overview, ranked across pillars into one list.
//
// The Governance ledger answers "what is wrong in each pillar". This answers the question an
// admin opens the app with: of all of it, what is worth doing first. It reads the ledger's own
// rows -- each already joins a scored check to the findings that are its evidence, with an
// urgency band, an item count and a way in -- so the two can never disagree about the facts.
//
// value = lift x urgency / effort
//
//   lift     headline points gained if the check were fully fixed (src/lib/score-lift.js).
//            A finding nothing scores gets UNSCORED_LIFT, so it competes without pretending
//            to a number the score never measured.
//   urgency  the ledger's band: Act now 3, Worth reviewing 2, Cleanup when convenient 1.
//            Only a finding can make a row "Act now", so exposure and credentials rise first.
//   effort   1 + log10(1 + items): ten items is not ten times the work of one, but it is more.
//            Unknown counts sit at EFFORT_UNKNOWN, between one item and a handful.
//
// Work already under way this quarter (an epic with open tasks) leaves the top of the list
// and is counted instead: ranking it first would tell an admin to start what has started.

import { scoreLifts } from "../../../src/lib/score-lift.js";

export const URGENCY = { critical: 3, warning: 2, info: 1 };
export const UNSCORED_LIFT = 0.5;
export const EFFORT_UNKNOWN = 1.5;

export function effortOf(count) {
  return typeof count === "number" && count > 0 ? 1 + Math.log10(1 + count) : EFFORT_UNKNOWN;
}

// "+2.4 points", "under 0.1 points", or null when nothing scores it.
export function formatLift(lift) {
  if (typeof lift !== "number") return null;
  if (lift < 0.05) return "under 0.1 points";
  return `+${lift.toFixed(1)} point${lift.toFixed(1) === "1.0" ? "" : "s"}`;
}

// Whether a finding's remediation is in progress this quarter: its playbook's current epic
// still has open tasks.
function inProgress(findingKeys, remediation) {
  if (!remediation) return false;
  return findingKeys.some((key) => {
    const playbook = remediation.findingIndex?.[key];
    if (!playbook) return false;
    const group = (remediation.groups || []).find((g) => g.findingKey === playbook);
    return Boolean(group?.isCurrent && (group.openCount ?? 0) > 0);
  });
}

function playbookFor(findingKeys, remediation) {
  for (const key of findingKeys) {
    const playbook = remediation?.findingIndex?.[key];
    if (playbook) return playbook;
  }
  return null;
}

// ledger: buildGovernanceLedger's result. health: the computed score it was built from.
// remediation: getRemediationTickets' result, or null while it loads (nothing is then
// treated as in progress, and no row offers a plan).
export function rankPriorities({ ledger, health, remediation = null, limit = 8 } = {}) {
  const lifts = scoreLifts(health);
  const candidates = [];
  for (const pillar of ledger?.pillars || []) {
    for (const row of pillar.rows || []) {
      if (!URGENCY[row.band]) continue;
      const findings = row.findings || [];
      const findingKeys = row.unscored ? [row.key] : findings.map((f) => f.key);
      const counted = row.unscored ? [row.count] : findings.map((f) => f.count);
      const known = counted.filter((n) => typeof n === "number");
      const count = known.length ? known.reduce((a, b) => a + b, 0) : null;
      const lift = row.unscored ? null : lifts.get(row.key) ?? null;
      // A scored check already at 100 lifts nothing; it is here only because a finding beneath
      // it is urgent, so it competes as an unscored finding would.
      const effectiveLift = lift && lift > 0 ? lift : findingKeys.length ? UNSCORED_LIFT : 0;
      if (effectiveLift <= 0) continue;
      const value = (effectiveLift * URGENCY[row.band]) / effortOf(count);
      const onOpen = row.unscored ? row.onOpen : findings.find((f) => f.onOpen)?.onOpen;
      candidates.push({
        key: row.key,
        title: row.label,
        pillar: pillar.key,
        pillarLabel: pillar.label || pillar.key,
        band: row.band,
        lift,
        count,
        action: row.action || row.detail || null,
        value,
        inProgress: inProgress(findingKeys, remediation),
        playbook: playbookFor(findingKeys, remediation),
        onOpen: onOpen || null,
      });
    }
  }
  candidates.sort((a, b) => b.value - a.value || (b.lift ?? 0) - (a.lift ?? 0) || a.title.localeCompare(b.title));
  const open = candidates.filter((c) => !c.inProgress);
  return {
    items: open.slice(0, limit),
    remaining: Math.max(0, open.length - limit),
    inProgress: candidates.filter((c) => c.inProgress),
    // Headline points on the table across everything listed, for the panel's summary line.
    totalLift: open.slice(0, limit).reduce((sum, c) => sum + (c.lift ?? 0), 0),
  };
}
