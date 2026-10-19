import { describe, test, expect } from "vitest";
import { HEALTH_PILLARS, PILLAR_WEIGHTS } from "./health-score.js";
import { PILLAR_REPORTS } from "./pillar-reports.js";
import { PILLAR_MEASURES } from "./oql-index.js";
import { DRIFT_PILLARS } from "./drift-engine.js";
import { listPlaybookCatalog } from "./remediation-playbooks.js";
import { INITIATIVE_LABELS } from "./remediation-hierarchy.js";

// Every pillar is treated like every other. A new pillar has to be wired into each of these
// before it ships, and this test is what says so -- not a checklist someone has to remember.
// When it fails, the message names the pillar and the missing piece.
//
//   score weight       health-score.js PILLAR_WEIGHTS
//   report             pillar-reports.js PILLAR_REPORTS (`health` lists the scored pillars)
//   search measures    oql-index.js PILLAR_MEASURES, keyed by the report
//   change history     drift-engine.js DRIFT_PILLARS (`health` lists the scored pillars)
//   remediation        a playbook in remediation-playbooks.js filed under the pillar
//   initiative         remediation-hierarchy.js INITIATIVE_LABELS
//
// "drift" is the change log itself: it is scored, but it has no items to report, search,
// remediate or track changes in.
const META_PILLARS = new Set(["drift"]);

const scored = HEALTH_PILLARS.map((p) => p.key).filter((k) => !META_PILLARS.has(k));
const reportFor = (key) => PILLAR_REPORTS.find((r) => (r.health || []).includes(key));
const driftCovers = new Set(DRIFT_PILLARS.flatMap((d) => d.health || []));
const playbookPillars = new Set(listPlaybookCatalog().map((p) => p.pillar));

describe("every scored pillar is wired into everything", () => {
  test.each(scored)("%s", (key) => {
    const missing = [];
    if (PILLAR_WEIGHTS[key] == null) missing.push("score weight (PILLAR_WEIGHTS)");
    const report = reportFor(key);
    if (!report) missing.push("report (PILLAR_REPORTS health)");
    else if (!PILLAR_MEASURES[report.key]) missing.push(`search measures (PILLAR_MEASURES.${report.key})`);
    if (!driftCovers.has(key)) missing.push("change history (DRIFT_PILLARS health)");
    if (!playbookPillars.has(key)) missing.push("remediation playbook");
    if (!INITIATIVE_LABELS[key]) missing.push("initiative (INITIATIVE_LABELS)");
    expect(missing).toEqual([]);
  });

  test("nothing points at a pillar that does not exist", () => {
    const known = new Set(HEALTH_PILLARS.map((p) => p.key));
    const strays = [
      ...Object.keys(PILLAR_WEIGHTS)
        .filter((k) => !known.has(k))
        .map((k) => `PILLAR_WEIGHTS.${k}`),
      ...[...driftCovers].filter((k) => !known.has(k)).map((k) => `DRIFT_PILLARS health ${k}`),
      ...[...playbookPillars].filter((k) => !known.has(k)).map((k) => `playbook pillar ${k}`),
      ...Object.keys(INITIATIVE_LABELS)
        .filter((k) => !known.has(k))
        .map((k) => `INITIATIVE_LABELS.${k}`),
    ];
    expect(strays).toEqual([]);
  });
});
