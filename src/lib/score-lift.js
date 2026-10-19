// How much the site health score would rise if one check were fully fixed.
//
// computeSiteHealth (health-score.js) scores in two steps: each pillar is the weighted mean of
// its available checks, and the headline is the weighted mean of the scored pillars, by
// PILLAR_WEIGHTS. Fixing one check -- taking its score to 100 while everything else holds --
// therefore raises the headline by exactly
//
//   (100 - checkScore) x checkWeight / pillarCheckWeight x pillarWeight / scoredPillarWeight
//
// This is that formula, applied to a computed score. It is the "how much is this worth"
// half of ranking what to fix first, and because it is exact it can be shown to an admin as
// a number ("+2.4 points") rather than as an opaque priority.
//
// Unrounded on purpose: the headline is rounded for display, so a lift under half a point may
// not move the displayed number on its own. Callers present it to one decimal place.
//
// Pure, with no imports beyond health-score.js (which has none), so the admin bundle can use
// it as well as the backend.

import { PILLAR_WEIGHTS } from "./health-score.js";

const pillarWeight = (key) => PILLAR_WEIGHTS[key] ?? 1;

// Lift for every available check, keyed by check key. A check is missing from the map when
// it cannot lift anything: unavailable, unscored, or in a pillar the headline does not count.
export function scoreLifts(health) {
  const lifts = new Map();
  const pillars = Array.isArray(health?.pillars) ? health.pillars : [];
  const scoredPillars = pillars.filter((p) => p.available && typeof p.score === "number");
  const headlineWeight = scoredPillars.reduce((sum, p) => sum + pillarWeight(p.key), 0);
  if (headlineWeight <= 0) return lifts;

  for (const pillar of scoredPillars) {
    const checks = (pillar.dimensions || []).filter((d) => d.available && typeof d.score === "number");
    const checkWeight = checks.reduce((sum, d) => sum + (Number(d.weight) || 0), 0);
    if (checkWeight <= 0) continue;
    const share = pillarWeight(pillar.key) / headlineWeight;
    for (const check of checks) {
      const gap = Math.max(0, 100 - check.score);
      lifts.set(check.key, ((gap * (Number(check.weight) || 0)) / checkWeight) * share);
    }
  }
  return lifts;
}

// Lift for one check, or null when it cannot lift the headline.
export function scoreLift(health, checkKey) {
  const lift = scoreLifts(health).get(checkKey);
  return lift === undefined ? null : lift;
}
