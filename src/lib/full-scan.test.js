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
  QUICK_SCAN_STAGES,
  QUICK_SCAN_STAGE_KEYS,
  initialStages,
  nextStage,
  summarizeStages,
  markStage,
  scanRetryDelaySeconds,
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

  // A structural inventory like screens and workflows -- part of what "run everything" covers.
  test("includes the issue type inventory, before the long issue crawl", () => {
    expect(FULL_SCAN_STAGE_KEYS).toContain("issue-types");
    expect(FULL_SCAN_STAGE_KEYS.indexOf("issue-types")).toBeLessThan(FULL_SCAN_STAGE_KEYS.indexOf("issues"));
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

// Quick scan runs the same estate as full scan, minus the one thing Jira genuinely cannot
// tell us has changed: whether a filter, dashboard, screen, or workflow scheme was edited.
// There is no modified-since parameter on any of those APIs and no last-edited timestamp on
// the objects they return, so those four stages have no cheaper version to run -- they run in
// full, every time, exactly like full scan. Only the issue crawl is genuinely windowed.
describe("quick scan stages", () => {
  test("runs the same structural stages as full scan, in full", () => {
    for (const key of ["workflows", "screens", "filters", "dashboards", "issue-types"]) {
      expect(QUICK_SCAN_STAGE_KEYS).toContain(key);
    }
  });

  test("refetches boards in full, like the other structural stages", () => {
    expect(QUICK_SCAN_STAGE_KEYS).toContain("boards");
    expect(FULL_SCAN_STAGE_KEYS).toContain("boards");
    // Structural: independent, and ahead of drift and health.
    expect(QUICK_SCAN_STAGE_KEYS.indexOf("boards")).toBeLessThan(QUICK_SCAN_STAGE_KEYS.indexOf("drift"));
    expect(FULL_SCAN_STAGE_KEYS.indexOf("boards")).toBeLessThan(FULL_SCAN_STAGE_KEYS.indexOf("issues"));
  });

  // Not two stages that happen to run back to back -- one stage. runDeltaIssueScanJob already
  // updates field x project usage counts in the same pass it counts issues, so a separate
  // field-catalog stage would have nothing left to do.
  test("collapses fields and issues into one delta stage, not two", () => {
    expect(QUICK_SCAN_STAGE_KEYS).not.toContain("fields");
    expect(QUICK_SCAN_STAGE_KEYS).not.toContain("issues");
    expect(QUICK_SCAN_STAGE_KEYS).toContain("issues-delta");
  });

  test("does not claim to cover automation either", () => {
    expect(QUICK_SCAN_STAGE_KEYS).not.toContain("automation");
  });

  // People and Assets were scored pillars that no scan ever refreshed -- buildable only
  // from a queued job fired by hand off their own tab. So the Overview could show a roster
  // months older than everything beside it, with nothing on screen saying which number was
  // which age. Every scored pillar the app can refresh, the scan now refreshes.
  describe("people and assets refresh with everything else", () => {
    test.each(["people", "assets"])("%s is a stage in both scan types", (key) => {
      expect(FULL_SCAN_STAGE_KEYS).toContain(key);
      expect(QUICK_SCAN_STAGE_KEYS).toContain(key);
    });

    test.each(["people", "assets"])("%s runs before health, which scores it", (key) => {
      // A pillar scored from a snapshot the same run has not refreshed yet is a run-old
      // number wearing this run's timestamp.
      expect(FULL_SCAN_STAGE_KEYS.indexOf(key)).toBeLessThan(FULL_SCAN_STAGE_KEYS.indexOf("health"));
      expect(QUICK_SCAN_STAGE_KEYS.indexOf(key)).toBeLessThan(QUICK_SCAN_STAGE_KEYS.indexOf("health"));
    });

    test("both are structural: independent, and ahead of the issue crawl", () => {
      for (const key of ["people", "assets"]) {
        const stage = FULL_SCAN_STAGES.find((s) => s.key === key);
        expect(stage.needs).toEqual([]);
        expect(stage.mode).toBe("inline");
        expect(FULL_SCAN_STAGE_KEYS.indexOf(key)).toBeLessThan(FULL_SCAN_STAGE_KEYS.indexOf("issues"));
      }
    });

    test("every scored pillar the app can build has a stage, automation excepted", () => {
      // The guard that makes this class of omission impossible to repeat quietly: a new
      // pillar that never joins the pipeline now fails here rather than going unnoticed for
      // two months. Automation is the one deliberate exception -- Jira publishes no API to
      // enumerate rules, so a stage for it would claim coverage the app does not have.
      const buildable = ["workflows", "screens", "filters", "dashboards", "fields",
        "issue-types", "access", "estate", "boards", "people", "assets"];
      for (const key of buildable) {
        expect(FULL_SCAN_STAGE_KEYS, `${key} is scored but never refreshed by a scan`).toContain(key);
      }
    });
  });

  test("every quick-scan dependency resolves within the quick-scan stage list", () => {
    for (const stage of QUICK_SCAN_STAGES) {
      for (const need of stage.needs) {
        expect(QUICK_SCAN_STAGE_KEYS, `${stage.key} needs ${need}`).toContain(need);
        expect(QUICK_SCAN_STAGE_KEYS.indexOf(need)).toBeLessThan(QUICK_SCAN_STAGE_KEYS.indexOf(stage.key));
      }
    }
  });

  test("runs health last, after the delta crawl", () => {
    expect(QUICK_SCAN_STAGE_KEYS.at(-1)).toBe("health");
    expect(QUICK_SCAN_STAGE_KEYS.indexOf("issues-delta")).toBeLessThan(QUICK_SCAN_STAGE_KEYS.indexOf("health"));
  });
});

describe("initialStages and nextStage over an arbitrary stage list", () => {
  // Parameterized specifically so quick scan can reuse this instead of full-scan-runner.js
  // needing a second copy of "what stage comes next."
  test("initialStages seeds from whatever list it is given, not always the full-scan one", () => {
    const stages = initialStages(QUICK_SCAN_STAGES);
    expect(stages.map((s) => s.key)).toEqual(QUICK_SCAN_STAGE_KEYS);
    expect(stages.every((s) => s.state === "pending")).toBe(true);
  });

  test("nextStage walks the list it is given, not always the full-scan one", () => {
    const stages = initialStages(QUICK_SCAN_STAGES);
    const next = nextStage(stages, QUICK_SCAN_STAGES);
    expect(next.key).toBe(QUICK_SCAN_STAGES[0].key);
  });

  test("defaults to the full-scan list when no list is given, for backward compatibility", () => {
    expect(initialStages().map((s) => s.key)).toEqual(FULL_SCAN_STAGE_KEYS);
    expect(nextStage(initialStages()).key).toBe(FULL_SCAN_STAGES[0].key);
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
    for (const key of ["screens", "filters", "dashboards", "fields"]) stages = markStage(stages, key, { state: "done" });

    const next = nextStage(stages);
    expect(next.key).toBe("status-history");
    expect(next.blockedBy).toBe("workflows");
  });

  test("does not block a stage whose dependencies all succeeded", () => {
    let stages = initialStages();
    for (const key of ["workflows", "screens", "filters", "dashboards", "fields"]) stages = markStage(stages, key, { state: "done" });

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

  // The bug: a second orchestrator loop (a delayed queue message, or a recovery kick racing
  // the original) would call nextStage while an earlier stage was still running, skip past it
  // because it was not "pending", and return a LATER stage -- so status history and health
  // ran and completed while the field snapshot they score was still in flight.
  test("returns null rather than a later stage while an earlier one is still running", () => {
    let stages = initialStages();
    for (const key of ["workflows", "screens", "filters", "dashboards"]) stages = markStage(stages, key, { state: "done" });
    stages = markStage(stages, "fields", { state: "running" });
    // status-history and health are still pending and their listed deps are all satisfied --
    // the ONLY thing that should stop them is that fields has not finished.
    expect(nextStage(stages)).toBeNull();
  });

  test("resumes at the running stage's successor once it finishes, in order", () => {
    let stages = initialStages();
    for (const key of ["workflows", "screens", "filters", "dashboards", "fields"]) stages = markStage(stages, key, { state: "done" });
    expect(nextStage(stages).key).toBe("status-history");
  });

  test("health is last, and only reachable once every stage before it has settled", () => {
    let stages = initialStages();
    const beforeHealth = FULL_SCAN_STAGES.map((s) => s.key).filter((k) => k !== "health");
    // Every prior stage terminal (a mix of done and failed) -> health is next.
    for (const key of beforeHealth) stages = markStage(stages, key, { state: key === "screens" ? "failed" : "done" });
    expect(nextStage(stages).key).toBe("health");

    // ...but flip one back to running and health is unreachable again.
    stages = markStage(stages, "issues", { state: "running" });
    expect(nextStage(stages)).toBeNull();
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

describe("scanRetryDelaySeconds", () => {
  test("backs off exponentially, capped, with jitter -- same shape as the HTTP retry", () => {
    // 20 * 2^(n-1) + [0,10) jitter
    expect(scanRetryDelaySeconds(1)).toBeGreaterThanOrEqual(20);
    expect(scanRetryDelaySeconds(1)).toBeLessThan(30);
    expect(scanRetryDelaySeconds(2)).toBeGreaterThanOrEqual(40);
    expect(scanRetryDelaySeconds(2)).toBeLessThan(50);
    expect(scanRetryDelaySeconds(3)).toBeGreaterThanOrEqual(80);
    expect(scanRetryDelaySeconds(3)).toBeLessThan(90);
  });

  test("never exceeds the 300s cap however many attempts", () => {
    expect(scanRetryDelaySeconds(50)).toBeLessThan(311);
    expect(scanRetryDelaySeconds(50)).toBeGreaterThanOrEqual(300);
  });

  test("a missing or bad attempt count is treated as the first retry", () => {
    expect(scanRetryDelaySeconds()).toBeGreaterThanOrEqual(20);
    expect(scanRetryDelaySeconds(0)).toBeLessThan(30);
  });
});

describe("markStage", () => {
  test("touches only the named stage", () => {
    const stages = markStage(initialStages(), "screens", { state: "done" });

    expect(stages.find((s) => s.key === "screens").state).toBe("done");
    expect(stages.filter((s) => s.state === "pending")).toHaveLength(FULL_SCAN_STAGES.length - 1);
  });
});
