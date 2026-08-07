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

const KEY_PREFIX = "automation:analysis:";

function keyFor(scopeKey) {
  return `${KEY_PREFIX}${scopeKey}`;
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
