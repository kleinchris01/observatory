// Request type index (RQT): the index read and value search.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { getInstallationKey } from "../lib/jira-api.js";
import {
  ensureProjectStoreReady,
  readSnapshotMeta,
  loadSnapshotFields,
  loadRqtFieldIndex,
  loadRqtIssueKeys,
  loadRqtValueFrequency,
  searchRqtValueIssueKeys,
  loadRqtFieldIssueIndex,
  loadIssueRqtValues,
} from "../lib/project-store.js";
import { buildRqtJql } from "../lib/analysis.js";
import { logger } from "../lib/logger.js";

export async function getRqtIndex({ context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const [rqtFields, snapshotMeta, issuesByProject, rqtValueFrequency, issueRqtValues, fieldIssueIndex] = await Promise.all([
    loadRqtFieldIndex(installationKey),
    readSnapshotMeta(installationKey),
    loadRqtIssueKeys(installationKey),
    loadRqtValueFrequency(installationKey),
    loadIssueRqtValues(installationKey),
    loadRqtFieldIssueIndex(installationKey),
  ]);

  // Enrich field names from the live snapshot if available
  if (snapshotMeta?.version && rqtFields.length > 0) {
    try {
      const snapshotFields = await loadSnapshotFields(installationKey, snapshotMeta.version);
      const nameMap = {};
      for (const f of snapshotFields) nameMap[f.id] = f.name;
      for (const r of rqtFields) {
        if (nameMap[r.fieldId]) r.fieldName = nameMap[r.fieldId];
      }
    } catch (error) {
      // Best-effort: the RQT index is usable with raw field ids, just less readable.
      logger.warn("rqt.name_enrichment_failed", {
        installationKey,
        error: String(error?.message || error),
      });
    }
  }

  const jql = buildRqtJql(rqtFields.map((r) => r.fieldId));
  const allValues = [...new Set(rqtFields.flatMap((r) => r.sampleValues))].sort();
  const totalIssues = rqtFields.reduce((sum, r) => sum + r.issueCount, 0);
  const refreshedAt = rqtFields[0]?.refreshedAt || null;

  const totalUniqueIssues = issuesByProject.reduce((sum, p) => sum + p.total, 0);

  return {
    fields: rqtFields,
    jql,
    uniqueValues: allValues,
    totalIssues,
    totalUniqueIssues,
    issuesByProject,
    rqtValueFrequency,
    refreshedAt,
    fieldCount: rqtFields.length,
    issueRqtValues,
    fieldIssueIndex,
  };
}

export async function searchRqtValue({ payload, context }) {
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const rqtValue = String(payload?.rqtValue || "").trim().toUpperCase();
  if (!rqtValue) return { issueKeys: [] };
  const issueKeys = await searchRqtValueIssueKeys(installationKey, rqtValue);
  return { issueKeys };
}
