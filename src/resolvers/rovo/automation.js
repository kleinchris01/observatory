// Rovo actions. Automation expert (observatory-automation-expert): rules, risk and field/status usage.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES, getInstallationKey } from "../../lib/jira-api.js";
import { assessAutomationEvidence } from "../../lib/automation-analysis.js";
import { loadAutomationForAgent, ruleDirectoryMap } from "../automation.js";
import { USER_TEXT_NOTICE } from "../../lib/rovo-agents.js";

export const RISK_SENTENCES = {
  "embedded-credential": "stores a credential in plaintext that anyone who can view the rule can read",
  "no-actions": "has a trigger but no actions",
  "external-http": "sends data to a host outside Atlassian",
  disabled: "is disabled",
};

export async function rovoSearchAutomationRules(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  const query = String(payload?.query || "").trim();
  const maxResults = Math.max(1, Math.min(20, Number(payload?.maxResults) || 10));
  const stateFilter = String(payload?.state || "any").toLowerCase();

  const { analysis, directory, findings, staleAfterDays } = await loadAutomationForAgent(installationKey);
  if (!analysis || !directory) {
    return {
      status: "analysis-unavailable",
      message:
        "No automation analysis has been built for this site yet. An administrator can build one from the Automation tab by importing a rule export.",
    };
  }

  if (!query) return { status: "error", message: "A search query is required." };

  const riskByRuleId = new Map();
  for (const row of findings?.findings ?? []) {
    riskByRuleId.set(
      row.id,
      (row.r ?? []).map((r) => r.c),
    );
  }

  const term = query.toLowerCase();
  const matches = [];
  for (const rule of ruleDirectoryMap(directory).values()) {
    if (
      !String(rule.name || "")
        .toLowerCase()
        .includes(term)
    )
      continue;
    if (stateFilter === "enabled" && !rule.enabled) continue;
    if (stateFilter === "disabled" && rule.enabled) continue;
    matches.push({
      ruleId: rule.id,
      name: rule.name,
      state: rule.enabled ? "ENABLED" : "DISABLED",
      trigger: rule.triggerType,
      projectCount: rule.projectCount,
      findings: riskByRuleId.get(rule.id) ?? [],
    });
  }

  // Enabled first: a disabled rule cannot be the cause of anything happening now, which is
  // what most questions are actually about.
  matches.sort((a, b) => (a.state === b.state ? 0 : a.state === "ENABLED" ? -1 : 1));

  return {
    status: "ok",
    userTextNotice: USER_TEXT_NOTICE,
    // Age travels with a search result too. A rule created after the last import simply is
    // not here, and "no rule matched" would otherwise read as "no such rule exists".
    analysisRefreshedAt: analysis.refreshedAt ?? null,
    evidence: assessAutomationEvidence({
      indexRequired: false, // a directory search consults no index; only the age applies
      refreshedAt: analysis.refreshedAt ?? null,
      staleAfterDays,
    }),
    totalRules: directory.total ?? 0,
    matchCount: matches.length,
    matches: matches.slice(0, maxResults),
  };
}

export async function rovoInspectAutomationRule(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  const identifier = String(payload?.ruleIdentifier || "").trim();
  if (!identifier) return { status: "error", message: "A rule id or name is required." };

  const { analysis, directory, findings, fields, statuses, staleAfterDays } =
    await loadAutomationForAgent(installationKey);
  if (!analysis || !directory) {
    return { status: "analysis-unavailable", message: "No automation analysis has been built for this site yet." };
  }
  const evidence = assessAutomationEvidence({
    index: fields,
    refreshedAt: analysis.refreshedAt ?? null,
    staleAfterDays,
  });

  const byId = ruleDirectoryMap(directory);
  const wanted = identifier.toLowerCase();
  const rule =
    byId.get(Number(identifier)) ??
    [...byId.values()].find((r) => String(r.name || "").toLowerCase() === wanted) ??
    [...byId.values()].find((r) =>
      String(r.name || "")
        .toLowerCase()
        .includes(wanted),
    );

  if (!rule) return { status: "not-found", message: `No automation rule matched "${identifier}".` };

  // Which fields and statuses this rule touches, derived by scanning the indexes for its id.
  const touches = (index, kind) => {
    const out = [];
    for (const entry of index?.entries ?? []) {
      for (const direction of ["write", "read", "trigger"]) {
        if ((entry[direction] ?? []).includes(rule.id)) out.push({ [kind]: entry.label, direction });
      }
    }
    return out;
  };

  const findingRow = (findings?.findings ?? []).find((f) => f.id === rule.id);

  return {
    status: "ok",
    userTextNotice: USER_TEXT_NOTICE,
    analysisRefreshedAt: evidence.refreshedAt,
    evidence,
    rule: {
      ruleId: rule.id,
      name: rule.name,
      state: rule.enabled ? "ENABLED" : "DISABLED",
      trigger: rule.triggerType,
      projectCount: rule.projectCount,
    },
    fieldsTouched: touches(fields, "field"),
    statusesTouched: touches(statuses, "status"),
    findings: (findingRow?.r ?? []).map((r) => ({
      code: r.c,
      severity: r.s,
      summary: RISK_SENTENCES[r.c] ? `This rule ${RISK_SENTENCES[r.c]}.` : r.c,
      hosts: r.h,
      disabledForDays: r.d,
    })),
    // Stated rather than implied. The indexes cap stored rule ids at 50 per direction, so a
    // rule touching a very heavily referenced field can be missing from this list -- and on
    // top of that the analysis itself may be old, which the blockers spell out.
    caveat: [
      "Field and status lists are derived from a capped index and may omit references on fields used by more than 50 rules in one direction.",
      ...evidence.blockers.map((b) => b.message),
    ].join(" "),
  };
}

export async function rovoAutomationUsage(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);
  const name = String(payload?.name || "").trim();
  const kind = String(payload?.kind || "field").toLowerCase() === "status" ? "status" : "field";
  if (!name) return { status: "error", message: "A field or status name is required." };

  const { analysis, fields, statuses, directory, staleAfterDays } = await loadAutomationForAgent(installationKey);
  if (!analysis) {
    return { status: "analysis-unavailable", message: "No automation analysis has been built for this site yet." };
  }

  const index = kind === "status" ? statuses : fields;
  // Settled once, before anything is claimed. `evidence` decides whether this answer is
  // allowed to be a verdict at all; without it an absence from a capped or three-week-old
  // index read exactly like a clean bill of health.
  const evidence = assessAutomationEvidence({
    index,
    refreshedAt: analysis.refreshedAt ?? null,
    staleAfterDays,
  });
  const entry = (index?.entries ?? []).find((e) => String(e.label ?? "").toLowerCase() === name.toLowerCase());

  if (!entry) {
    // The branch this whole assessment exists for. "We looked and found nothing" and "we
    // have not really looked" are different claims and only one of them justifies a
    // deletion, so when the index cannot carry the weight this degrades to unknown with
    // the reason attached rather than returning safeToDelete: true.
    if (!evidence.absenceIsEvidence) {
      return {
        status: "unknown",
        analysisRefreshedAt: evidence.refreshedAt,
        evidence,
        message: `Whether any automation rule touches the ${kind} "${name}" cannot be established from this analysis.`,
        // Not false -- false would claim rules DO reference it. Null is the third state.
        safeToDelete: null,
        guidance: evidence.blockers.map((b) => b.message).join(" "),
      };
    }
    return {
      status: "not-referenced",
      analysisRefreshedAt: evidence.refreshedAt,
      evidence,
      message: `No automation rule reads, writes or triggers on the ${kind} "${name}".`,
      safeToDelete: kind === "field",
    };
  }

  const byId = ruleDirectoryMap(directory);
  const expand = (ids = []) =>
    ids.map((id) => {
      const r = byId.get(id);
      return { ruleId: id, name: r?.name ?? `Rule ${id}`, state: r ? (r.enabled ? "ENABLED" : "DISABLED") : "UNKNOWN" };
    });

  const referenced = entry.writeCount > 0 || entry.readCount > 0 || entry.triggerCount > 0;

  return {
    status: "ok",
    userTextNotice: USER_TEXT_NOTICE,
    analysisRefreshedAt: evidence.refreshedAt,
    evidence,
    kind,
    name: entry.label,
    ruleCount: entry.ruleCount ?? 0,
    enabledRules: entry.enabledRules ?? 0,
    disabledRules: entry.disabledRules ?? 0,
    writtenBy: { count: entry.writeCount, rules: expand(entry.write) },
    readBy: { count: entry.readCount, rules: expand(entry.read) },
    triggers: { count: entry.triggerCount, rules: expand(entry.trigger) },
    // The single most important thing this action exists to say, and now a tri-state.
    //
    // A reference that WAS found is positive evidence and survives a stale analysis -- a
    // rule that wrote this field a fortnight ago almost certainly still does, and "no" is
    // the cautious answer anyway. An entry found with no references in any direction is an
    // absence claim like the not-found branch above, so it answers to the same test.
    safeToDelete: referenced ? false : evidence.absenceIsEvidence ? true : null,
    guidance:
      entry.writeCount > 0
        ? `Deleting this ${kind} would break ${entry.writeCount} rule(s) that write to it.`
        : referenced
          ? "No rule writes this, but rules that read it will misbehave if it is removed."
          : evidence.blockers.map((b) => b.message).join(" ") || "No rule references this.",
  };
}
