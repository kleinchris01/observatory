import { vi, describe, test, expect } from "vitest";

// The stage machine behind one scan that runs everything.
//
// Tested as pure functions rather than through the consumer, because the rules that make
// this trustworthy are all decisions about ordering and failure -- and asserting them
// through a queue would test the queue.

vi.mock("./queues.js", () => ({ inventorySnapshotQueue: { push: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("./logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  FULL_SCAN_STAGES,
  FULL_SCAN_STAGE_KEYS,
  initialStages,
  nextStage,
  summarizeStages,
  markStage,
} from "./full-scan.js";

describe("stage order", () => {
  // Not the dependency order alone. Structural inventories are minutes each and make a tab
  // useful the moment they land; the issue crawl is hours on a large site, so putting it
  // first would mean nothing appeared until it finished.
  test("runs the long issue crawl last, and records health after it", () => {
    expect(FULL_SCAN_STAGE_KEYS.indexOf("issues")).toBeGreaterThan(FULL_SCAN_STAGE_KEYS.indexOf("workflows"));
    expect(FULL_SCAN_STAGE_KEYS.indexOf("issues")).toBeGreaterThan(FULL_SCAN_STAGE_KEYS.indexOf("screens"));
    expect(FULL_SCAN_STAGE_KEYS.at(-1)).toBe("health");
  });

  // Automation cannot be a stage: Jira publishes no API to enumerate rules, so the analysis
  // is fed by a hand-imported export. A "run everything" that silently skipped it would be
  // worse than one that says what it covers.
  test("does not claim to cover automation", () => {
    expect(FULL_SCAN_STAGE_KEYS).not.toContain("automation");
  });

  test("every stage declaring a dependency has it earlier in the order", () => {
    for (const stage of FULL_SCAN_STAGES) {
      for (const need of stage.needs) {
        expect(FULL_SCAN_STAGE_KEYS.indexOf(need), `${stage.key} needs ${need}`)
          .toBeLessThan(FULL_SCAN_STAGE_KEYS.indexOf(stage.key));
      }
    }
  });
});

describe("nextStage", () => {
  test("walks the stages in order", () => {
    let stages = initialStages();
    expect(nextStage(stages).key).toBe("workflows");

    stages = markStage(stages, "workflows", { state: "done" });
    expect(nextStage(stages).key).toBe("screens");
  });

  test("returns null once every stage has settled", () => {
    const stages = initialStages().map((s) => ({ ...s, state: "done" }));
    expect(nextStage(stages)).toBeNull();
  });

  // A status history built from a workflow snapshot that did not refresh is not a partial
  // result, it is a wrong one -- so the stage is reported blocked rather than run.
  test("blocks a stage whose dependency failed instead of running it on stale input", () => {
    let stages = initialStages();
    stages = markStage(stages, "workflows", { state: "failed", error: "401" });
    // Every independent stage ahead of the blocked one has to be out of the way, or this
    // asserts stage ORDER rather than dependency blocking.
    for (const key of ["screens", "filters", "fields"]) stages = markStage(stages, key, { state: "done" });

    const next = nextStage(stages);
    expect(next.key).toBe("status-history");
    expect(next.blockedBy).toBe("workflows");
  });

  test("does not block a stage whose dependencies all succeeded", () => {
    let stages = initialStages();
    for (const key of ["workflows", "screens", "filters", "fields"]) stages = markStage(stages, key, { state: "done" });

    expect(nextStage(stages).blockedBy).toBeUndefined();
  });

  // The independent majority still runs. An admin whose screen inventory 401s still wants
  // the workflow and field data the same pass would have produced.
  test("keeps going after an independent stage fails", () => {
    let stages = initialStages();
    stages = markStage(stages, "workflows", { state: "done" });
    stages = markStage(stages, "screens", { state: "failed", error: "401" });

    // Whichever stage is next, the point is that the run continues rather than stopping at
    // the failure. nextStage returns the DEFINITION, not the stage row, so there is no
    // state on it to assert -- what matters is that it named one and it is not the failure.
    const next = nextStage(stages);
    expect(next).not.toBeNull();
    expect(next.key).not.toBe("screens");
  });
});

describe("summarizeStages", () => {
  test("reports plain success only when nothing failed or was skipped", () => {
    const stages = initialStages().map((s) => ({ ...s, state: "done" }));
    expect(summarizeStages(stages)).toMatchObject({ state: "ready", failed: 0, complete: true });
  });

  // Never a green tick over a stage that did not run. That is the kind of thing people act
  // on, and acting on it means trusting data that was never refreshed.
  test("never reports plain success when a stage failed", () => {
    let stages = initialStages().map((s) => ({ ...s, state: "done" }));
    stages = markStage(stages, "screens", { state: "failed", error: "401" });

    const summary = summarizeStages(stages);
    expect(summary.state).toBe("completed-with-failures");
    expect(summary.failed).toBe(1);
    expect(summary.complete).toBe(true);
  });

  test("a skipped stage counts against success too", () => {
    let stages = initialStages().map((s) => ({ ...s, state: "done" }));
    stages = markStage(stages, "status-history", { state: "skipped" });

    expect(summarizeStages(stages).state).toBe("completed-with-failures");
  });

  test("is incomplete while anything is still pending or running", () => {
    let stages = initialStages();
    stages = markStage(stages, "workflows", { state: "running" });

    expect(summarizeStages(stages).complete).toBe(false);
  });
});

describe("markStage", () => {
  test("touches only the named stage", () => {
    const stages = markStage(initialStages(), "screens", { state: "done" });

    expect(stages.find((s) => s.key === "screens").state).toBe("done");
    expect(stages.filter((s) => s.state === "pending")).toHaveLength(FULL_SCAN_STAGES.length - 1);
  });
});
