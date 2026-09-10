// Shared shape for the per-pillar Rovo agent resolvers.
//
// Every pillar agent exposes the same three actions -- search / inspect / impact -- and
// every one of them must answer the way the shared prompt preamble promises:
//
//   - a real result, or
//   - an explicit "<pillar>-unavailable" when the snapshot has not been built, never an
//     empty result that reads as "nothing here", and
//   - always carrying the snapshot's refreshedAt so the agent can report staleness.
//
// These helpers are the one place that contract is enforced, so a new pillar agent is a
// thin wrapper over its existing get<Pillar>Inventory resolver rather than 150 lines of
// bespoke plumbing that drifts.

// The snapshot for this pillar has not been built. The agent must say so and must not
// infer "nothing uses / references this" from it.
export function pillarUnavailable(pillar, snapshotStatus = null) {
  return {
    status: `${pillar}-unavailable`,
    message:
      `No ${pillar} snapshot has been built yet. An administrator can build one from the ` +
      `${pillar} tab in Observatory. Until then this pillar cannot answer questions about ` +
      `what exists or what references what.`,
    snapshotStatus: snapshotStatus || { state: "idle", refreshedAt: null },
  };
}

// A successful agent result. `refreshedAt` is mandatory -- pass null explicitly if the
// pillar genuinely has no timestamp, so the omission is a decision rather than a bug.
export function agentOk(refreshedAt, payload) {
  return { status: "ok", refreshedAt: refreshedAt ?? null, ...payload };
}

// "I looked and found nothing" -- distinct from pillarUnavailable. Safe to return an empty
// list here; the caller has a built snapshot, the thing just is not in it.
export function agentNotFound(refreshedAt, message) {
  return { status: "not-found", refreshedAt: refreshedAt ?? null, message };
}

// Rank free-text matches the same way across every pillar's search action: exact id or
// name first, then name prefix, then substring anywhere in the searchable fields, then a
// loose token overlap. Stable, dependency-free, good enough for "find the thing the user
// half-remembered the name of".
export function rankMatches(items, query, getFields, limit = 10) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);

  const scored = [];
  for (const item of items || []) {
    const fields = getFields(item).map((f) => String(f ?? "").toLowerCase()).filter(Boolean);
    if (!fields.length) continue;

    let score = 0;
    for (const field of fields) {
      if (field === q) { score = Math.max(score, 100); continue; }
      if (field.startsWith(q)) { score = Math.max(score, 70); continue; }
      if (field.includes(q)) { score = Math.max(score, 45); continue; }
      const hit = tokens.filter((t) => field.includes(t)).length;
      if (hit) score = Math.max(score, 10 + hit * 5);
    }
    if (score > 0) scored.push({ item, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}

// Clamp an agent's maxResults input to a sane window.
export function clampResults(value, fallback = 5, max = 20) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(n)));
}
