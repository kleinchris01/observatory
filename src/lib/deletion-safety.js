// "Is this field safe to delete" -- the product's thesis, rendered as one answer.
//
// Every pillar already holds a piece of this and none of them can settle it alone. Field
// usage knows where values are, screens know where a person could enter one, automation
// knows what writes it, filters and dashboards know what reads it, and the RQT index knows
// whether it carries requirement tokens. A verdict drawn from any one of them is wrong in a
// way that only shows up after the field is gone.
//
// The strongest thing this ever says is NO EVIDENCE OF USE. Not "safe to delete" -- the app
// cannot see Marketplace app configuration, Jira's own internal references, or anything
// written through the REST API by something nobody remembers building, so absence of a
// reference here is absence of a reference THIS APP CAN SEE. The verdict names what was
// checked, what was found, and what could not be checked at all; the reader decides.
//
// Pure functions over evidence already loaded, like every other insights module here.

export const VERDICT = {
  IN_USE: "in-use",
  NO_EVIDENCE: "no-evidence-of-use",
  UNKNOWN: "unknown",
};

// Each blocker is a reason this field is load-bearing somewhere. Severity orders the list;
// it does not gate the verdict -- any blocker at all means in-use.
const BLOCKER_ORDER = { high: 0, medium: 1, low: 2 };

// A source that could not be consulted. Distinct from a source that was consulted and found
// nothing, and the distinction is the whole point: one narrows the claim, the other supports
// it. Anything unchecked downgrades a clean result from NO_EVIDENCE to UNKNOWN.
function gap(source, reason) {
  return { source, reason };
}

// `evidence` is everything the caller could gather. Each key is either a result object or
// null, and null means "not available" rather than "empty" -- so a pillar that has never
// been built narrows the claim instead of silently strengthening it.
export function assessFieldDeletion({
  field = {},
  usage = null,        // { totalIssueCount, activeProjectCount } | null
  screens = null,      // { available, screens: [], unresolvedScreens } | null
  automation = null,   // { available, writeCount, readCount, triggerCount, evidence } | null
  filters = null,      // { available, count, names: [] } | null
  dashboards = null,   // { available, count, names: [] } | null
  rqt = null,          // { available, issueCount } | null
  invisibleData = null, // { projects: [], totalIssues } | null -- from the screen cross
} = {}) {
  const blockers = [];
  const gaps = [];
  const checked = [];

  // ── Values in issues ──────────────────────────────────────────────────────
  //
  // A field with no name is a field the catalogue could not describe, and almost every join
  // below keys on the name. Said once, plainly, rather than letting three pillars each
  // report an empty result that reads as a clean one.
  if (!(field.name ?? field.fieldName)) {
    gaps.push(gap("field catalogue", "The field catalogue could not be read, so this field's name is unknown — and the automation, filter and dashboard joins all match on name."));
  }

  if (usage) {
    checked.push("field usage");
    const issues = Number(usage.totalIssueCount) || 0;
    if (issues > 0) {
      blockers.push({
        source: "usage",
        severity: "high",
        summary: `${issues} issue${issues === 1 ? "" : "s"} carry a value in this field.`,
        detail: "Deleting the field deletes that data. Jira does not put it back.",
      });
    }
  } else {
    gaps.push(gap("field usage", "No field snapshot has been built, so where values exist is unknown."));
  }

  // ── The cross-signal, which is the one that catches integrations ───────────
  //
  // Populated in a project whose screens do not show it. This is the blocker most likely to
  // be the reason a deletion breaks something, because by construction nobody can see the
  // thing writing it by looking at Jira.
  if (invisibleData && Number(invisibleData.totalIssues) > 0) {
    const where = (invisibleData.projects || []).slice(0, 3).map((p) => p.projectKey).join(", ");
    blockers.push({
      source: "invisible-data",
      severity: "high",
      summary: `Written by something outside the UI in ${invisibleData.projects?.length ?? 0} project(s)${where ? `: ${where}` : ""}.`,
      detail: "The field holds values in projects whose screens do not display it, so an importer, integration or rule is maintaining it. Find that first.",
    });
  }

  // ── Automation ────────────────────────────────────────────────────────────
  if (automation?.available) {
    checked.push("automation rules");
    const writes = Number(automation.writeCount) || 0;
    const reads = Number(automation.readCount) || 0;
    const triggers = Number(automation.triggerCount) || 0;

    if (writes > 0) {
      blockers.push({
        source: "automation",
        severity: "high",
        summary: `${writes} automation rule${writes === 1 ? "" : "s"} write to this field.`,
        detail: "Those rules break on deletion, and whatever they were maintaining stops being maintained.",
      });
    }
    if (reads > 0 || triggers > 0) {
      blockers.push({
        source: "automation",
        severity: "medium",
        summary: `${reads + triggers} automation rule${reads + triggers === 1 ? "" : "s"} read or trigger on this field.`,
        detail: "These do not keep the field alive, but they misbehave silently once it is gone.",
      });
    }
    // Item 1's assessment, carried through verbatim. An automation answer drawn from a
    // truncated or stale index is not evidence, and it is the half of this verdict most
    // likely to be quietly wrong.
    for (const b of automation.evidence?.blockers ?? []) {
      gaps.push(gap("automation rules", b.message));
    }
  } else {
    gaps.push(gap("automation rules", "No automation analysis has been imported, so no rule reference can be ruled out."));
  }

  // ── Where a person can see or type it ─────────────────────────────────────
  if (screens?.available) {
    checked.push("screens");
    const count = (screens.screens || []).length;
    if (count > 0) {
      blockers.push({
        source: "screens",
        severity: "medium",
        summary: `On ${count} screen${count === 1 ? "" : "s"}.`,
        detail: "Removing the field removes it from those forms. Nothing breaks, but people who use them will notice.",
      });
    }
    if (Number(screens.unresolvedScreens) > 0) {
      gaps.push(gap("screens", `${screens.unresolvedScreens} screen(s) could not be read in the last build, so the screen list may be incomplete.`));
    }
  } else {
    gaps.push(gap("screens", "No screen inventory has been built, so whether a form carries this field is unknown."));
  }

  // ── What reads it ─────────────────────────────────────────────────────────
  for (const [key, source, label, severity] of [
    ["filters", filters, "saved filter", "medium"],
    ["dashboards", dashboards, "dashboard", "medium"],
  ]) {
    if (source?.available) {
      checked.push(key);
      const count = Number(source.count) || 0;
      if (count > 0) {
        const names = (source.names || []).slice(0, 3).join(", ");
        blockers.push({
          source: key,
          severity,
          summary: `${count} ${label}${count === 1 ? "" : "s"} reference this field${names ? `: ${names}` : ""}.`,
          detail: key === "filters"
            ? "A filter whose JQL names a deleted field errors for everyone who runs it, and every board and subscription on top of it."
            : "A gadget built on that filter shows an error instead of a chart.",
        });
      }
    } else {
      gaps.push(gap(key, `No ${key} inventory has been built, so references from ${key} cannot be ruled out.`));
    }
  }

  // ── Requirement tokens ────────────────────────────────────────────────────
  if (rqt?.available) {
    checked.push("requirement tokens");
    const issues = Number(rqt.issueCount) || 0;
    if (issues > 0) {
      blockers.push({
        source: "rqt",
        severity: "high",
        summary: `Carries requirement tokens on ${issues} issue${issues === 1 ? "" : "s"}.`,
        detail: "Traceability to requirements runs through this field. Deleting it breaks the trace, not just the value.",
      });
    }
  }

  blockers.sort((a, b) => (BLOCKER_ORDER[a.severity] ?? 3) - (BLOCKER_ORDER[b.severity] ?? 3));

  const { verdict, headline } = computeVerdict(blockers, gaps);

  return {
    fieldId: field.id ?? field.fieldId ?? null,
    fieldName: field.name ?? field.fieldName ?? null,
    verdict,
    blockers,
    gaps,
    checked,
    headline,
    // Said on every verdict, including the clean ones. The app cannot read Marketplace app
    // configuration, and a site running ScriptRunner can have a post-function writing this
    // field on every transition with nothing here to show for it.
    caveat: "Observatory cannot read Marketplace app configuration (ScriptRunner listeners, JMWE post-functions) or anything writing through the REST API. Absence of a reference here is absence of one this app can see.",
  };
}

// ── The reusable core ────────────────────────────────────────────────────────
//
// Everything above this point is field-specific: what counts as a blocker for a field, and
// what evidence there is to gather. This part is not -- it is the same three-state judgement
// for ANY entity, and it is the part that must never drift between one assess*Deletion
// function and the next. A second entity type that reimplemented this independently is
// exactly how "safe to delete" would eventually leak back in through a copy nobody re-read
// this file's own opening comment before writing.
//
// Blockers and gaps carry no assumption about what kind of entity they describe -- a status
// blocker and a field blocker are the same shape, `{ source, severity, summary, detail }` --
// so this function is pure arithmetic over two arrays, nothing more.
export function computeVerdict(blockers, gaps) {
  const verdict = blockers.length > 0
    ? VERDICT.IN_USE
    : (gaps.length > 0 ? VERDICT.UNKNOWN : VERDICT.NO_EVIDENCE);

  return {
    verdict,
    // Never "safe to delete", at any confidence. The strongest claim the product makes, in
    // the words it makes it in.
    headline: verdict === VERDICT.IN_USE
      ? `In use — ${blockers.length} reason${blockers.length === 1 ? "" : "s"} not to delete this yet.`
      : verdict === VERDICT.NO_EVIDENCE
        ? "No evidence of use in anything this app can see."
        : `No evidence of use, but ${gaps.length} source${gaps.length === 1 ? "" : "s"} could not be checked.`,
  };
}

// "Is this status safe to retire" -- the same question as assessFieldDeletion, for the other
// entity the app already had scattered, ad-hoc versions of this answer for (rovoWorkflowImpact
// used to compute its own bespoke noEvidence boolean inline; this is that logic, pulled out
// to the one place the rule can't drift a second time).
//
// `evidence` mirrors what a caller has already gathered to answer "does anything reference
// this status" -- the same five checks rovoWorkflowImpact already makes: scheme reachability,
// measured issue counts, automation, board columns, and saved filter JQL. Each key is null
// when that source was never consulted, exactly as assessFieldDeletion treats a missing
// pillar -- a narrowed claim, never a clean one it did not earn.
export function assessStatusDeletion({
  status = {},
  schemes = null,     // { reachedByCount: number } | null
  issueUsage = null,  // { count: number } | null
  automation = null,  // { available, writeCount, readCount, triggerCount } | null
  boards = null,      // { available, onBoard: boolean } | null
  filters = null,     // { available, count, names: [] } | null
} = {}) {
  const blockers = [];
  const gaps = [];
  const checked = [];

  if (!(status.name ?? status.statusName)) {
    gaps.push(gap("status catalogue", "The status catalogue could not be read, so this status's name is unknown — the automation and filter joins both match on name."));
  }

  // ── Workflow schemes ──────────────────────────────────────────────────────
  //
  // The one check with no "unavailable" state: a caller only reaches this function once it
  // has the scheme->status mapping, so a status is either reached by some schemes or by none.
  if (schemes) {
    checked.push("workflow schemes");
    const count = Number(schemes.reachedByCount) || 0;
    if (count > 0) {
      blockers.push({
        source: "schemes",
        severity: "high",
        summary: `Reachable from ${count} workflow scheme${count === 1 ? "" : "s"}.`,
        detail: "Every project on one of those schemes can put an issue into this status today. Deleting it breaks the scheme's workflow diagram.",
      });
    }
  } else {
    gaps.push(gap("workflow schemes", "No scheme->status mapping has been built, so reachability is unknown."));
  }

  // ── Issues currently in it ────────────────────────────────────────────────
  if (issueUsage) {
    checked.push("issue counts");
    const count = Number(issueUsage.count) || 0;
    if (count > 0) {
      blockers.push({
        source: "usage",
        severity: "high",
        summary: `${count} issue${count === 1 ? " sits" : "s sit"} in this status right now.`,
        detail: "Deleting the status without moving those issues first strands them where nothing can find or transition them.",
      });
    }
  } else {
    gaps.push(gap("issue counts", "No universe scan has measured current issue counts, so whether issues sit here is unknown."));
  }

  // ── Automation ────────────────────────────────────────────────────────────
  if (automation?.available) {
    checked.push("automation rules");
    const writes = Number(automation.writeCount ?? automation.ruleCount) || 0;
    const readsAndTriggers = Number(automation.readCount ?? 0) + Number(automation.triggerCount ?? 0);
    if (writes > 0) {
      blockers.push({
        source: "automation",
        severity: "high",
        summary: `${writes} automation rule${writes === 1 ? "" : "s"} transition into this status.`,
        detail: "Those rules break on deletion, silently, the next time they fire.",
      });
    }
    if (readsAndTriggers > 0) {
      blockers.push({
        source: "automation",
        severity: "medium",
        summary: `${readsAndTriggers} automation rule${readsAndTriggers === 1 ? "" : "s"} read or trigger on this status.`,
        detail: "These do not keep the status alive, but they misbehave silently once it is gone.",
      });
    }
  } else {
    gaps.push(gap("automation rules", "No automation analysis has been imported, so no rule reference can be ruled out."));
  }

  // ── Board columns ─────────────────────────────────────────────────────────
  //
  // Invisible to the workflow admin in the same way automation is: a board column mapping a
  // status holds it open with nothing in Jira's own status admin to show for it.
  if (boards?.available) {
    checked.push("board columns");
    if (boards.onBoard) {
      blockers.push({
        source: "boards",
        severity: "medium",
        summary: "At least one board column maps this status.",
        detail: "Deleting the status drops that column's cards off the board with no error anywhere.",
      });
    }
  } else {
    gaps.push(gap("board columns", "No board inventory has been built, so whether a column maps this status is unknown."));
  }

  // ── Saved filters ─────────────────────────────────────────────────────────
  if (filters?.available) {
    checked.push("saved filters");
    const count = Number(filters.count) || 0;
    if (count > 0) {
      const names = (filters.names || []).slice(0, 3).join(", ");
      blockers.push({
        source: "filters",
        severity: "medium",
        summary: `${count} saved filter${count === 1 ? "" : "s"} reference this status${names ? `: ${names}` : ""}.`,
        detail: "A filter whose JQL names a deleted status errors for everyone who runs it, and every board and subscription on top of it.",
      });
    }
  } else {
    gaps.push(gap("saved filters", "No filter inventory has been built, so references from saved filters cannot be ruled out."));
  }

  blockers.sort((a, b) => (BLOCKER_ORDER[a.severity] ?? 3) - (BLOCKER_ORDER[b.severity] ?? 3));

  const { verdict, headline } = computeVerdict(blockers, gaps);

  return {
    statusId: status.id ?? status.statusId ?? null,
    statusName: status.name ?? status.statusName ?? null,
    verdict,
    blockers,
    gaps,
    checked,
    headline,
    caveat: "Observatory cannot read Marketplace app configuration (ScriptRunner post-functions, JMWE listeners) or anything transitioning an issue through the REST API directly. Absence of a reference here is absence of one this app can see.",
  };
}

// A set of fields, ordered so the ones a reader can act on come first.
export function summarizeDeletionSafety(assessments = []) {
  const byVerdict = { [VERDICT.IN_USE]: 0, [VERDICT.NO_EVIDENCE]: 0, [VERDICT.UNKNOWN]: 0 };
  for (const a of assessments) byVerdict[a.verdict] = (byVerdict[a.verdict] ?? 0) + 1;

  // No-evidence first: those are the decisions this report exists to enable. In-use last,
  // because "do not touch this" needs no follow-up.
  //
  // Sorted by whichever name key the entity carries -- fieldName for a field, statusName for
  // a status, and so on for whatever assess*Deletion comes next. Every one of them names its
  // subject with `<kind>Name`, so this stays generic without a type tag threading through.
  const nameOf = (a) => a.fieldName ?? a.statusName ?? a.screenName ?? a.name ?? "";
  const rank = { [VERDICT.NO_EVIDENCE]: 0, [VERDICT.UNKNOWN]: 1, [VERDICT.IN_USE]: 2 };
  const fields = [...assessments].sort((a, b) =>
    (rank[a.verdict] - rank[b.verdict]) || String(nameOf(a)).localeCompare(String(nameOf(b)))
  );

  return { total: assessments.length, byVerdict, fields };
}
