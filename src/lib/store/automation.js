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

// The document's shape and its size caps live in the analysis module, which imports
// nothing and can therefore be used from the frontend bundle too. Re-exported here so
// callers that only care about storage have one import.
export {
  MAX_STORED_FINDINGS,
  MAX_STORED_CASCADES,
  buildAnalysisDocument,
} from "../automation-analysis.js";

// Four documents under four keys rather than one.
//
// A KVS value holds roughly 240 KB. The analysis alone is ~130 KB on the reference site and
// the field index another ~116 KB, so a single document would not fit. Splitting also means
// the tab's first paint fetches only the analysis: the field and status indexes are loaded
// when someone opens those sections, which most visits never do.
export const AUTOMATION_PARTS = {
  analysis: "automation:analysis:",
  fields: "automation:fields:",
  statuses: "automation:statuses:",
  directory: "automation:directory:",
};

function keyFor(part, scopeKey) {
  const prefix = AUTOMATION_PARTS[part];
  if (!prefix) throw new Error(`unknown automation storage part: ${part}`);
  return `${prefix}${scopeKey}`;
}

export async function writeAutomationPart(scopeKey, part, document) {
  await kvs.set(keyFor(part, scopeKey), document);
  return document;
}

// Returns null rather than throwing when nothing has been built yet. "No analysis" is the
// normal state on a fresh install, not an error, and the tab renders an empty state for it.
export async function readAutomationPart(scopeKey, part) {
  const stored = await kvs
    .get(keyFor(part, scopeKey))
    .catch(fallbackOn("automation.part_read_failed", () => null, { scopeKey, part }));
  if (!stored || typeof stored !== "object") return null;
  // A document written by an older build may not have the fields the current UI reads.
  // Returning null lets the caller say "rebuild required" instead of rendering half a page.
  if (stored.schemaVersion !== 1) return null;
  return stored;
}

export function writeAutomationAnalysis(scopeKey, document) {
  return writeAutomationPart(scopeKey, "analysis", document);
}

export function readAutomationAnalysis(scopeKey) {
  return readAutomationPart(scopeKey, "analysis");
}

export async function clearAutomationAnalysis(scopeKey) {
  // Every part goes, not just the analysis. Leaving a stale field index behind would let
  // the Fields section render data from a build the estate no longer matches.
  await Promise.all(
    Object.keys(AUTOMATION_PARTS).map((part) =>
      kvs.delete(keyFor(part, scopeKey)).catch(fallbackOn("automation.part_clear_failed", () => null, { scopeKey, part }))
    )
  );
}
