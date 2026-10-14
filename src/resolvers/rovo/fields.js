// Rovo actions. Fields expert (observatory-field-expert): search and inspect fields.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import {
  incrMetric,
  METRIC_NAMES,
  getInstallationKey,
  getLiveFieldProjectUsage,
  PROJECT_USAGE_PAGE_SIZE,
  getBrowsableProjectIds,
} from "../../lib/jira-api.js";
import { ensureProjectStoreReady, readSnapshotMeta, loadSnapshotFields } from "../../lib/project-store.js";
import { filterInventoryFields, sortInventoryFields } from "../../lib/analysis.js";

// ----- Rovo agent actions -----

export function formatFieldCandidate(field) {
  return {
    id: field.id,
    name: field.name,
    type: field.type,
    description: field.description || "",
    activeProjectCount: field.activeProjectCount ?? 0,
    totalIssueCount: field.totalIssueCount ?? 0,
    fieldJql: field.fieldJql,
    findings: field.findings || null,
  };
}

export function findFieldFromSnapshot(fields, identifier) {
  const n = String(identifier || "").trim().toLowerCase();
  if (!n) return null;
  return (
    fields.find((f) => f.id.toLowerCase() === n) ||
    fields.find((f) => f.name.trim().toLowerCase() === n) ||
    fields.find((f) => f.name.trim().toLowerCase().startsWith(n)) ||
    fields.find((f) =>
      [f.name, f.id, f.description].filter(Boolean).some((v) => v.toLowerCase().includes(n))
    ) ||
    null
  );
}

export async function getSnapshotFieldsForAgent(installationKey) {
  await ensureProjectStoreReady();
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    return { fields: [], meta: null, status: { state: meta?.state || "idle" } };
  }
  const fields = await loadSnapshotFields(installationKey, meta.version);
  return { fields, meta, status: { state: meta.state, refreshedAt: meta.refreshedAt } };
}

export async function rovoSearchFields(payload, context) {
  incrMetric(METRIC_NAMES.rovoSearchFields);
  const installationKey = getInstallationKey(context);
  const query = String(payload?.query || "").trim();
  const fieldType = String(payload?.fieldType || "all").trim() || "all";
  const sortBy = String(payload?.sortBy || "usage-desc").trim() || "usage-desc";
  const maxResults = Math.max(1, Math.min(10, Number(payload?.maxResults) || 5));

  if (!query) return { status: "error", message: "A search query is required." };

  const { fields, meta, status } = await getSnapshotFieldsForAgent(installationKey);
  if (!meta) {
    return {
      status: "snapshot-unavailable",
      snapshotStatus: status,
      message: "No snapshot available yet â€” building one now.",
      matches: [],
    };
  }

  const matches = sortInventoryFields(filterInventoryFields(fields, query, fieldType), sortBy).slice(0, maxResults);
  return {
    status: "ok",
    snapshotRefreshedAt: meta.refreshedAt,
    query,
    totalMatches: matches.length,
    matches: matches.map(formatFieldCandidate),
  };
}

export async function rovoInspectField(payload, context) {
  incrMetric(METRIC_NAMES.rovoInspectField);
  const installationKey = getInstallationKey(context);
  const fieldIdentifier = String(payload?.fieldIdentifier || "").trim();
  const usagePage = Math.max(1, Number(payload?.projectPage) || 1);

  if (!fieldIdentifier) return { status: "error", message: "A field identifier is required." };

  const { fields, meta, status } = await getSnapshotFieldsForAgent(installationKey);
  if (!meta) {
    return { status: "snapshot-unavailable", snapshotStatus: status, message: "No snapshot available yet." };
  }

  const matchedField = findFieldFromSnapshot(fields, fieldIdentifier);
  if (!matchedField) {
    return { status: "not-found", snapshotRefreshedAt: meta.refreshedAt, message: `No field matched "${fieldIdentifier}".` };
  }

  const {
    projectUsage: rawProjectUsage,
    total: projectCount,
    totalIssueCount,
  } = await getLiveFieldProjectUsage(matchedField.id, usagePage, PROJECT_USAGE_PAGE_SIZE);

  // Never surface a project's identity to a Rovo caller who lacks Browse
  // Projects on it. projectCount/pagination totals are left as-is, same
  // bare-number tradeoff already accepted elsewhere in this file.
  const browsableProjectIds = await getBrowsableProjectIds(
    context?.accountId,
    rawProjectUsage.map((p) => p.projectId)
  );
  const projectUsage = rawProjectUsage.filter((p) => browsableProjectIds.has(String(p.projectId)));

  return {
    status: "ok",
    snapshotRefreshedAt: meta.refreshedAt,
    field: formatFieldCandidate(matchedField),
    governance: {
      activeProjectCount: projectCount,
      totalIssueCount,
      fieldJql: matchedField.fieldJql,
      findings: matchedField.findings || null,
      projectUsagePage: usagePage,
      projectUsageTotalPages: Math.max(1, Math.ceil(projectCount / PROJECT_USAGE_PAGE_SIZE)),
      projectUsageTotalProjects: projectCount,
    },
    projectUsage: projectUsage.map((p) => ({
      projectKey: p.projectKey,
      projectName: p.projectName,
      issueCount: p.issueCount,
      jql: p.jql,
    })),
  };
}
