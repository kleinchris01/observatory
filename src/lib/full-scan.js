// One scan that runs everything.
//
// Every pipeline here already existed and was already a queue job. What was missing was
// anything above them: an admin had to know that the "Universe Scan" scans issues but not
// screens, that the workflow inventory is a different button on a different tab, that the
// status history is a third, and that running them in the wrong order leaves the tabs
// disagreeing with each other. Five things to sequence by hand is a checklist, not a scan.
//
// Automation is deliberately not a stage. Jira publishes no API to enumerate automation
// rules -- the analysis is fed by importing a rule export by hand -- so a "run everything"
// that silently skipped it would be worse than one that says what it covers.

import { inventorySnapshotQueue } from "./queues.js";
import { logger } from "./logger.js";

// Order matters, and it is not the dependency order alone.
//
// Structural inventories run first because they take minutes and each one makes a tab
// useful the moment it lands. The issue crawl runs last because it is the long pole -- on a
// large site it is hours -- and putting it first would mean nothing else appeared until it
// finished. Health records at the end, when every input it scores has been refreshed.
//
// `needs` is the real dependency, asserted rather than assumed: status history joins against
// the workflow snapshot, and the issue crawl needs the field catalog to know what to count.
export const FULL_SCAN_STAGES = [
  {
    key: "workflows",
    label: "Workflow & status inventory",
    needs: [],
    // Runs inline: it fits inside one consumer invocation, and chaining through the queue
    // gives the next stage a fresh 900s rather than spending this one's remainder.
    mode: "inline",
  },
  { key: "screens", label: "Screen & scheme inventory", needs: [], mode: "inline" },
  // Cheapest structural stage by a wide margin: one paginated endpoint with everything
  // expanded, ~40 calls for 2,000 filters, no per-item walk. It earns its place early
  // because the field snapshot below is the thing its references protect.
  { key: "filters", label: "Saved filter inventory", needs: [], mode: "inline" },
  { key: "fields", label: "Field snapshot", needs: [], mode: "inline" },
  { key: "status-history", label: "Status history", needs: ["workflows"], mode: "inline" },
  {
    key: "issues",
    label: "Issue crawl",
    needs: ["fields"],
    // Handed off rather than run inline. The crawl is a multi-worker, multi-invocation
    // machine with its own resumption state; wrapping it in this one would be a second
    // implementation of something that already works.
    mode: "handoff",
  },
  { key: "health", label: "Record site health", needs: [], mode: "inline" },
];

export const FULL_SCAN_STAGE_KEYS = FULL_SCAN_STAGES.map((s) => s.key);

// A stage older than this is treated as abandoned rather than in flight.
//
// Matches the workflow build's ceiling for the same reason: the consumer tops out at
// timeoutSeconds 900, so nothing legitimately running can still be working past it, plus a
// minute so a stage finishing right at the limit is never declared stale out from under it.
export const FULL_SCAN_STAGE_STALE_MS = 16 * 60 * 1000;

export function initialStages() {
  return FULL_SCAN_STAGES.map((stage) => ({
    key: stage.key,
    label: stage.label,
    state: "pending",
    startedAt: null,
    completedAt: null,
    error: null,
  }));
}

// The next stage to run, or null when the scan is done.
//
// Skips stages whose dependencies failed rather than running them against stale inputs: a
// status history built from a workflow snapshot that did not refresh is not a partial
// result, it is a wrong one.
export function nextStage(stages = []) {
  const byKey = new Map(stages.map((s) => [s.key, s]));
  for (const definition of FULL_SCAN_STAGES) {
    const stage = byKey.get(definition.key);
    if (!stage || stage.state !== "pending") continue;

    const blocked = definition.needs.find((need) => {
      const dependency = byKey.get(need);
      return dependency && (dependency.state === "failed" || dependency.state === "skipped");
    });
    if (blocked) return { ...definition, blockedBy: blocked };
    return definition;
  }
  return null;
}

// A stage failing does not fail the scan.
//
// Four of the six are independent, and an admin whose screen inventory 401s still wants the
// workflow and field data the same run would have produced. The scan reports "completed with
// failures" rather than throwing the whole pass away -- but it never reports plain success,
// because a green tick over a stage that did not run is the kind of thing people act on.
export function summarizeStages(stages = []) {
  const failed = stages.filter((s) => s.state === "failed");
  const skipped = stages.filter((s) => s.state === "skipped");
  const done = stages.filter((s) => s.state === "done");

  return {
    total: stages.length,
    done: done.length,
    failed: failed.length,
    skipped: skipped.length,
    complete: stages.every((s) => ["done", "failed", "skipped"].includes(s.state)),
    state: failed.length || skipped.length ? "completed-with-failures" : "ready",
  };
}

export function markStage(stages, key, patch) {
  return stages.map((stage) => (stage.key === key ? { ...stage, ...patch } : stage));
}

// Queue the next step of a running scan. One job per stage, so each gets its own invocation
// budget instead of sharing one.
export async function queueFullScanStage(installationKey, stageKey, jobToken) {
  await inventorySnapshotQueue.push({
    jobType: "run-full-scan",
    installationKey,
    stage: stageKey,
    jobToken,
  });
  logger.info("full-scan.stage_queued", { installationKey, stage: stageKey });
}
