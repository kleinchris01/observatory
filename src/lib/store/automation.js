// Persistence for the automation rule analysis.
//
// Unlike the field and workflow snapshots this does NOT store the source objects. The
// reference site has 1,477 rules averaging 6 KB each; keeping the raw JSON would be ~9 MB
// per scope, far past what a KVS value holds, and nothing in the UI reads a whole rule.
// What is stored is the analysis output -- an estate summary, the rules carrying findings,
// and the cascade edges -- which is small enough to fetch in one call and is the only
// shape the tab actually renders.
//
// The consequence to keep in mind: a question the analysis did not answer at build time
// cannot be answered later without rebuilding. That trade is deliberate. Re-deriving from
// raw rules on demand would mean holding the raw rules, which is the cost being avoided.

import { kvs } from "@forge/kvs";
import { fallbackOn } from "../logger.js";

const KEY_PREFIX = "automation:analysis:";

// KVS caps a single value at roughly 240 KB. These bounds keep the stored document well
// under that even on a site several times larger than the reference one, and each is a
// visible truncation rather than a silent drop -- the counts in `estate` are computed
// before truncation, so the UI can say "showing 200 of 1,457".
export const MAX_STORED_FINDINGS = 300;
export const MAX_STORED_CASCADES = 200;

function keyFor(scopeKey) {
  return `${KEY_PREFIX}${scopeKey}`;
}

export function buildAnalysisDocument({ estate, summaries = [], cascades = [], refreshedAt = Date.now(), source = "unknown" }) {
  // Rules with no findings are the majority and carry no information here; the estate
  // counts already say how many there are.
  const withFindings = summaries
    .filter((summary) => summary.risks.length > 0)
    .sort((a, b) => severityRank(a.topSeverity) - severityRank(b.topSeverity));

  const selfTriggering = cascades.filter((c) => c.selfTriggering);
  const others = cascades.filter((c) => !c.selfTriggering);

  return {
    schemaVersion: 1,
    refreshedAt,
    source,
    estate,
    findingsTotal: withFindings.length,
    findings: withFindings.slice(0, MAX_STORED_FINDINGS).map(compactSummary),
    cascadesTotal: cascades.length,
    selfTriggeringTotal: selfTriggering.length,
    // Self-triggering loops are both the most likely to be real and the cheapest to fix,
    // so they survive truncation ahead of cross-rule edges.
    cascades: [...selfTriggering, ...others].slice(0, MAX_STORED_CASCADES),
  };
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2, info: 3 };
function severityRank(severity) {
  return SEVERITY_RANK[severity] ?? 99;
}

function compactSummary(summary) {
  return {
    id: summary.id,
    name: summary.name,
    state: summary.state,
    enabled: summary.enabled,
    triggerType: summary.triggerType,
    updated: summary.updated,
    actionCount: summary.actionCount,
    projectIds: summary.projectIds.slice(0, 10),
    projectCount: summary.projectIds.length,
    writesFields: summary.writesFields.slice(0, 10),
    topSeverity: summary.topSeverity,
    risks: summary.risks,
  };
}

export async function writeAutomationAnalysis(scopeKey, document) {
  await kvs.set(keyFor(scopeKey), document);
  return document;
}

// Returns null rather than throwing when nothing has been built yet. "No analysis" is the
// normal state on a fresh install, not an error, and the tab renders an empty state for it.
export async function readAutomationAnalysis(scopeKey) {
  const stored = await kvs
    .get(keyFor(scopeKey))
    .catch(fallbackOn("automation.analysis_read_failed", () => null, { scopeKey }));
  if (!stored || typeof stored !== "object") return null;
  // A document written by an older build may not have the fields the current UI reads.
  // Surfacing the version lets the resolver say "rebuild required" instead of rendering
  // half a page.
  if (stored.schemaVersion !== 1) return null;
  return stored;
}

export async function clearAutomationAnalysis(scopeKey) {
  await kvs.delete(keyFor(scopeKey)).catch(fallbackOn("automation.analysis_clear_failed", () => null, { scopeKey }));
}
