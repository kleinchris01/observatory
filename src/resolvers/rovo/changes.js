// Rovo actions. Change expert (observatory-change-expert): the configuration change history.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES, getInstallationKey } from "../../lib/jira-api.js";
import {
  pillarUnavailable,
  agentOk,
  agentNotFound,
  clampResults,
} from "../../lib/rovo-agents.js";
import { ensureProjectStoreReady, readDriftSnapshotMeta, loadConfigChanges } from "../../lib/project-store.js";

// ── Rovo: configuration change expert ──────────────────────────────────────
//
// The change-history timeline, over loadConfigChanges. Search filters by pillar/kind and
// substring-matches the label; inspect returns one entity's whole recorded history.

export async function rovoChangeSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    await ensureProjectStoreReady();
    const installationKey = getInstallationKey(context);
    const query = String(payload?.query || "").trim().toLowerCase();
    const pillar = payload?.pillar && payload.pillar !== "all" ? String(payload.pillar) : null;
    const kind = payload?.kind && payload.kind !== "all" ? String(payload.kind) : null;
    const limit = clampResults(payload?.maxResults, 20, 100);

    const meta = await readDriftSnapshotMeta(installationKey);
    if (!meta?.version) return pillarUnavailable("configuration changes", { state: meta?.state || "idle", refreshedAt: null });

    const rows = await loadConfigChanges(installationKey, { pillar, kind, limit: 300 });
    const filtered = (query
      ? rows.filter((r) => String(r.label || "").toLowerCase().includes(query) || String(r.summary || "").toLowerCase().includes(query))
      : rows
    ).slice(0, limit);

    return agentOk(meta.refreshedAt || null, {
      query: query || null, pillar, kind,
      totalRecorded: meta.totalChanges || 0,
      changes: filtered.map((r) => ({
        detectedAt: r.detectedAt, pillar: r.pillar, entityType: r.entityType,
        label: r.label, kind: r.changeKind, summary: r.summary,
      })),
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoChangeSearch failed:", error);
    throw error;
  }
}

export async function rovoChangeInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    await ensureProjectStoreReady();
    const installationKey = getInstallationKey(context);
    const label = String(payload?.label || "").trim();
    if (!label) return { status: "error", message: "The name of a scheme, status, field, filter or other entity is required." };

    const meta = await readDriftSnapshotMeta(installationKey);
    if (!meta?.version) return pillarUnavailable("configuration changes", { state: meta?.state || "idle", refreshedAt: null });

    const rows = await loadConfigChanges(installationKey, { limit: 500 });
    const forEntity = rows.filter((r) => String(r.label || "").toLowerCase() === label.toLowerCase());
    if (!forEntity.length) {
      return agentNotFound(meta.refreshedAt || null,
        `No recorded configuration change names "${label}". Either it has not changed since the drift baseline was set, or it is not one of the tracked entity kinds.`);
    }

    return agentOk(meta.refreshedAt || null, {
      label,
      pillar: forEntity[0].pillar,
      entityType: forEntity[0].entityType,
      changeCount: forEntity.length,
      history: forEntity.map((r) => ({ detectedAt: r.detectedAt, kind: r.changeKind, summary: r.summary })),
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoChangeInspect failed:", error);
    throw error;
  }
}
