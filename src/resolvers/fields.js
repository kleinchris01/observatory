// Fields pillar: the field inventory, details, option search and the field configuration build.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { route } from "@forge/api";
import {
  incrMetric,
  METRIC_NAMES,
  makeJobToken,
  getInstallationKey,
  mapWithConcurrency,
  jiraRequest,
  loadFieldContexts,
  PROJECT_USAGE_PAGE_SIZE,
  loadFieldOptionsFromJira,
  getBrowsableProjectIds,
} from "../lib/jira-api.js";
import {
  requeueStaleSnapshotBuild,
  hydrateFieldForGovernance,
  ensureFieldSummaryJobRunning,
  queueSnapshotBuild,
} from "../lib/snapshot-engine.js";
import {
  ensureProjectStoreReady,
  readSnapshotMeta,
  writeSnapshotMeta,
  loadSnapshotFields,
  loadSnapshotField,
  loadSnapshotProjectUsage,
  countSnapshotProjectUsage,
  loadFieldSummary,
  replaceFieldSummary,
  listFieldSummaries,
  replaceFieldOptionsCache,
  loadFieldOptionsCache,
  searchFieldOptionsCache,
  loadSnapshotFieldIssueSums,
  sumSnapshotFieldIssueCount,
  loadFieldTypeUsage,
  loadFieldUserUsage,
  readUserSnapshotMeta,
  loadUsers,
  readFieldConfigSnapshotMeta,
} from "../lib/project-store.js";
import { queueFieldConfigSnapshotBuild, isFieldConfigBuildStale } from "../lib/fieldconfig-engine.js";
import {
  normalizeFieldName,
  buildDuplicateNameCountMap,
  filterInventoryFields,
  applyFindingsFilter,
  sortInventoryFields,
  summarizeFindings,
} from "../lib/analysis.js";
import { buildFieldJql, buildOverallFieldJql, getFieldNumericId } from "../lib/transform.js";
import { fallbackOn, logger, errorContext } from "../lib/logger.js";
import { requireNonEmptyString, requirePositiveInt, requireBoundedInt, optionalString } from "../lib/validate.js";
import { readAdminConfig } from "./admin-config.js";

// ----- Inventory UI helpers -----

export const OPTION_SEARCH_FIELD_BATCH_SIZE = 10;

// ----- Resolvers -----

export async function getFieldInventory({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    await ensureProjectStoreReady();
    const filters = payload || {};
    // Input validation
    if (filters.page !== undefined && filters.page !== null) requirePositiveInt(filters.page, "page");
    if (filters.pageSize !== undefined && filters.pageSize !== null)
      requireBoundedInt(filters.pageSize, "pageSize", 1, 100);
    optionalString(filters.sort, "sort");
    optionalString(filters.fieldType, "fieldType");
    optionalString(filters.search, "search");
    const installationKey = getInstallationKey(context);
    const pageSize = Math.max(1, Math.min(50, Number(filters.pageSize) || 10));
    const requestedPage = Math.max(1, Number(filters.page) || 1);
    const sortBy = filters.sortBy || "name-asc";
    const query = filters.query || "";
    const optionQuery = String(filters.optionQuery || "").trim();
    const type = filters.type || "all";
    const findingsFilter = filters.findingsFilter || "all";
    const projectUsageFilter = filters.projectUsageFilter || "all";
    const minIssuesWithValue = filters.minIssuesWithValue ?? "";
    const maxIssuesWithValue = filters.maxIssuesWithValue ?? "";
    const fieldOrigin = String(filters.fieldOrigin || "all").trim() || "all";
    const minActiveProjects = filters.minActiveProjects ?? "";
    const maxActiveProjects = filters.maxActiveProjects ?? "";
    const minContexts = filters.minContexts ?? "";
    const maxContexts = filters.maxContexts ?? "";
    const duplicateNamesOnly = Boolean(filters.duplicateNamesOnly);
    const hasDescription = filters.hasDescription || "all";
    const hideSystemFields = Boolean(filters.hideSystemFields);

    const [meta_initial, adminConfig] = await Promise.all([readSnapshotMeta(installationKey), readAdminConfig()]);
    let meta = meta_initial;

    if (filters.forceRefresh && meta?.state === "building") {
      meta = await requeueStaleSnapshotBuild(installationKey, meta);
    }

    // Only reset a job that was ALREADY stuck in "queued" before this request came in --
    // not one this request just transitioned into "queued" via requeueStaleSnapshotBuild
    // above, otherwise a successful requeue is undone on the very next line every time.
    if (filters.forceRefresh && meta_initial?.state === "queued" && meta?.state === "queued") {
      // Queue job never started â€” reset so forceRefresh can re-enqueue
      await writeSnapshotMeta(installationKey, {
        state: "idle",
        lastError: "Queue job did not start; reset by manual refresh.",
      });
      meta = await readSnapshotMeta(installationKey);
    }

    // Computed from the final state (after any recovery above), not the state the
    // request started with, so a reset-to-idle above can trigger a fresh requeue in
    // this same call instead of silently requiring a second click.
    const alreadyActive = meta?.state === "building" || meta?.state === "queued";
    const shouldQueue = Boolean(filters.forceRefresh && !alreadyActive && !adminConfig.readOnlyMode);

    if (shouldQueue) {
      // Claim the queue slot with a unique token, then verify we won before actually pushing.
      // This prevents two concurrent getFieldInventory calls from both enqueuing a build.
      const queueToken = makeJobToken();
      await writeSnapshotMeta(installationKey, { state: "queued", jobToken: queueToken, lastError: null });
      const claimed = await readSnapshotMeta(installationKey);
      if (claimed?.jobToken === queueToken) {
        await queueSnapshotBuild(installationKey);
      }
      meta = claimed || meta;
    }

    const snapshotStatus = {
      state: meta?.state || "idle",
      refreshedAt: meta?.refreshedAt || null,
      startedAt: meta?.startedAt || null,
      completedAt: meta?.completedAt || null,
      itemCount: meta?.totalFields || 0,
      processedFields: meta?.processedFields || 0,
      lastError: meta?.lastError || null,
      progressLog: meta?.progressLog || [],
    };

    const buildTotal = meta?.totalFields || 0;
    const buildProcessed = meta?.processedFields || 0;
    const buildProgress =
      meta?.state === "building" || meta?.state === "queued"
        ? {
            status: meta.state,
            startedAt: meta?.startedAt || null,
            totalFields: buildTotal,
            processedFields: buildProcessed,
            percent: buildTotal > 0 ? Math.round((buildProcessed / buildTotal) * 100) : 0,
            progressLog: meta?.progressLog || [],
          }
        : null;

    // No snapshot data at all yet â€” return empty while the first build runs
    if (!meta?.version) {
      return {
        refreshedAt: null,
        total: 0,
        page: 1,
        pageSize,
        totalPages: 1,
        availableTypes: [],
        fields: [],
        findingsSummary: null,
        snapshotStatus,
        buildProgress,
        readOnlyMode: adminConfig.readOnlyMode,
      };
    }

    // Load from last good version â€” works for "ready", "building" (shows stale), and "failed"
    const [snapshotFields, fieldSummaries, issueSumsMap] = await Promise.all([
      loadSnapshotFields(installationKey, meta.version),
      listFieldSummaries(installationKey, 5000).catch(
        fallbackOn("inventory.summaries_load_failed", () => [], { installationKey }),
      ),
      loadSnapshotFieldIssueSums(installationKey, meta.version).catch(
        fallbackOn("inventory.issue_sums_load_failed", () => new Map(), { installationKey }),
      ),
    ]);
    const summaryByFieldId = new Map(fieldSummaries.map((summary) => [summary.fieldId, summary]));
    const duplicateNameCounts = buildDuplicateNameCountMap(snapshotFields);
    const allFields = snapshotFields.map((field) => {
      const summary = summaryByFieldId.get(field.id);
      const derivedIssueCount = summary?.totalIssueCount || field.totalIssueCount || issueSumsMap.get(field.id) || 0;
      if (!summary) {
        return hydrateFieldForGovernance(
          {
            ...field,
            totalIssueCount: derivedIssueCount,
            projectUsageBuilt: derivedIssueCount <= 0,
            projectUsageState: derivedIssueCount <= 0 ? "not-needed" : "unbuilt",
          },
          null,
          duplicateNameCounts.get(normalizeFieldName(field.name)) ?? 1,
          adminConfig.governanceThresholds,
        );
      }
      const inferredBuilt = summary.summaryStatus === "ready";
      return hydrateFieldForGovernance(
        {
          ...field,
          activeProjectCount: summary.activeProjectCount ?? field.activeProjectCount,
          totalIssueCount: derivedIssueCount,
          projectUsageBuilt: inferredBuilt,
          projectUsageState: summary.summaryStatus || (inferredBuilt ? "ready" : "unbuilt"),
        },
        summary,
        duplicateNameCounts.get(normalizeFieldName(field.name)) ?? 1,
        adminConfig.governanceThresholds,
      );
    });

    const optionMatches = optionQuery ? await searchFieldOptionsCache(installationKey, optionQuery, 5000) : null;
    const optionMatchedFieldIds = optionMatches ? new Set(optionMatches.map((match) => match.fieldId)) : null;
    const optionFilteredFields = optionMatchedFieldIds
      ? allFields.filter((field) => optionMatchedFieldIds.has(field.id))
      : allFields;
    const filteredFields = sortInventoryFields(
      applyFindingsFilter(
        filterInventoryFields(
          optionFilteredFields,
          query,
          type,
          projectUsageFilter,
          maxIssuesWithValue,
          fieldOrigin,
          minIssuesWithValue,
          {
            minActiveProjects,
            maxActiveProjects,
            minContexts,
            maxContexts,
            duplicateNamesOnly,
            hasDescription,
            hideSystemFields,
          },
        ),
        findingsFilter,
      ),
      sortBy,
    );

    const total = filteredFields.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const startIndex = (page - 1) * pageSize;
    const availableTypes = Array.from(new Set(allFields.map((f) => f.type)))
      .filter(Boolean)
      .sort();

    return {
      refreshedAt: meta.refreshedAt,
      total,
      page,
      pageSize,
      totalPages,
      availableTypes,
      fields: filteredFields.slice(startIndex, startIndex + pageSize),
      findingsSummary: summarizeFindings(filteredFields),
      snapshotStatus,
      buildProgress,
      readOnlyMode: adminConfig.readOnlyMode,
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    logger.error("getFieldInventory.failed", errorContext(error));
    throw error;
  }
}

// Queue a field scheme / field configuration build. Same guard as every other inventory:
// a live build is not doubled, a wedged one is not honoured, and read-only mode refuses.
export async function buildFieldConfigInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readFieldConfigSnapshotMeta(installationKey);
  if (meta?.state === "building" && !isFieldConfigBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return {
      queued: false,
      error: "Read-only mode is enabled. Disable it before building the field scheme inventory.",
    };
  }

  await queueFieldConfigSnapshotBuild(installationKey);
  return { queued: true };
}

export async function getFieldDetails({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    await ensureProjectStoreReady();
    // Input validation
    requireNonEmptyString(payload?.fieldId, "fieldId");
    const fieldId = payload?.fieldId;
    if (!fieldId) throw new Error("fieldId is required");
    const usagePage = Math.max(1, Number(payload?.usagePage) || 1);
    const usagePageSize = Math.max(1, Math.min(25, Number(payload?.usagePageSize) || PROJECT_USAGE_PAGE_SIZE));
    const installationKey = getInstallationKey(context);

    const meta = await readSnapshotMeta(installationKey);
    if (!meta?.version) throw new Error("No completed snapshot available â€” build one first.");

    const offset = (usagePage - 1) * usagePageSize;
    const [
      snapshotField,
      projectUsageRows,
      projectCount,
      rawFieldSummary,
      projectUsageIssueSum,
      issueTypeUsage,
      userValueUsage,
    ] = await Promise.all([
      loadSnapshotField(installationKey, meta.version, fieldId),
      loadSnapshotProjectUsage(installationKey, meta.version, fieldId, usagePageSize, offset),
      countSnapshotProjectUsage(installationKey, meta.version, fieldId),
      loadFieldSummary(installationKey, fieldId),
      sumSnapshotFieldIssueCount(installationKey, meta.version, fieldId),
      // The field x issue-type axis from the last full crawl. Empty when the crawl predates
      // this feature or has not run since -- the UI treats [] as "not measured yet".
      loadFieldTypeUsage(installationKey, meta.version, fieldId).catch(() => []),
      // The field x user axis: how many distinct people hold a value, and the top holders.
      // Only populated for user-picker fields (and assignee/reporter). Names are resolved
      // against the licensed-user roster below so a deleted account still shows something.
      loadFieldUserUsage(installationKey, meta.version, fieldId).catch(() => ({
        distinctUsers: 0,
        issueTotal: 0,
        top: [],
      })),
    ]);

    if (!snapshotField) throw new Error(`Field not found in snapshot: ${fieldId}`);

    // Prefer the roster's current display name over the one the crawl captured, and mark an
    // account that is no longer licensed -- a picker still pointing at someone who has left.
    if (userValueUsage?.top?.length) {
      const userMeta = await readUserSnapshotMeta(installationKey).catch(() => null);
      const roster = userMeta?.version ? await loadUsers(installationKey, userMeta.version).catch(() => []) : [];
      const rosterById = new Map(roster.map((u) => [u.accountId, u]));
      userValueUsage.top = userValueUsage.top.map((row) => {
        const person = rosterById.get(row.accountId);
        return {
          ...row,
          displayName: person?.displayName || row.displayName || row.accountId,
          onRoster: userMeta?.version ? Boolean(person) : null,
        };
      });
    }
    const fieldSummary = await ensureFieldSummaryJobRunning(
      installationKey,
      meta.version,
      fieldId,
      rawFieldSummary,
      snapshotField,
    );

    let finalProjectRows = projectUsageRows;
    let finalProjectCount = projectCount;
    let finalContexts = fieldSummary?.contexts || [];
    let summaryStatus = fieldSummary?.summaryStatus || "ready";
    const hasBrokenReadySummary = Boolean(
      fieldSummary &&
      fieldSummary.summaryStatus === "ready" &&
      (fieldSummary.activeProjectCount > 0 || snapshotField.activeProjectCount > 0) &&
      (!Array.isArray(fieldSummary.activeProjects) || fieldSummary.activeProjects.length === 0) &&
      projectCount === 0,
    );

    if (fieldSummary && !hasBrokenReadySummary) {
      if (projectCount === 0 && Array.isArray(fieldSummary.activeProjects) && fieldSummary.activeProjects.length > 0) {
        finalProjectCount = fieldSummary.activeProjectCount || fieldSummary.activeProjects.length;
        finalProjectRows = fieldSummary.activeProjects.slice(offset, offset + usagePageSize).map((project) => ({
          projectId: project.projectId,
          projectKey: project.projectKey,
          projectName: project.projectName,
          issueCount: project.issueCount,
          jql: project.jql,
        }));
      } else if (fieldSummary.activeProjectCount > 0) {
        finalProjectCount = fieldSummary.activeProjectCount;
      }
    }

    if (hasBrokenReadySummary) {
      summaryStatus = "failed";
    } else if (!fieldSummary && !finalProjectRows.length && projectCount === 0 && snapshotField.totalIssueCount > 0) {
      summaryStatus = "idle";
    }

    if (!finalContexts.length) {
      try {
        finalContexts = await loadFieldContexts(fieldId);
        if (fieldSummary) {
          await replaceFieldSummary(installationKey, fieldId, {
            ...fieldSummary,
            refreshedAt: new Date().toISOString(),
            contexts: finalContexts,
          });
        }
      } catch (contextError) {
        logger.warn("getFieldDetails.context_load_failed", { fieldId, error: contextError?.message || contextError });
      }
    }

    const duplicateNameCounts = buildDuplicateNameCountMap(await loadSnapshotFields(installationKey, meta.version));
    const hydratedField = hydrateFieldForGovernance(
      {
        ...snapshotField,
        activeProjectCount: finalProjectCount,
        totalIssueCount: fieldSummary?.totalIssueCount || snapshotField.totalIssueCount || projectUsageIssueSum || 0,
      },
      fieldSummary,
      duplicateNameCounts.get(normalizeFieldName(snapshotField.name)) ?? 1,
    );

    // Never surface a project's identity to a viewer who lacks Browse Projects
    // on it in Jira. finalProjectCount/pagination totals are left as-is (a bare
    // number doesn't reveal a project's identity, same tradeoff already
    // accepted for field-inventory aggregate counts) -- only row-level identity
    // is filtered here.
    const browsableProjectIds = await getBrowsableProjectIds(
      context?.accountId,
      finalProjectRows.map((row) => row.projectId),
    );
    finalProjectRows = finalProjectRows.filter((row) => browsableProjectIds.has(String(row.projectId)));

    const projectUsage = finalProjectRows.map((row) => ({
      projectId: row.projectId,
      projectKey: row.projectKey,
      projectName: row.projectName,
      issueCount: row.issueCount,
      jql: row.jql || buildFieldJql(fieldId, row.projectKey),
      latestFieldChangeAt: null,
      latestIssueKey: null,
      latestIssueUpdatedAt: null,
    }));

    return {
      refreshedAt: meta.refreshedAt,
      field: {
        ...hydratedField,
        numericId: getFieldNumericId(snapshotField.id),
      },
      fieldJql: snapshotField.fieldJql || buildOverallFieldJql(fieldId),
      activeProjectCount: finalProjectCount,
      totalIssueCount: hydratedField.totalIssueCount,
      findings: hydratedField.findings || null,
      contexts: finalContexts,
      projects: projectUsage,
      issueTypeUsage,
      userValueUsage,
      projectUsagePage: usagePage,
      projectUsagePageSize: usagePageSize,
      projectUsageTotalProjects: finalProjectCount,
      projectUsageTotalPages: Math.max(1, Math.ceil(finalProjectCount / usagePageSize)),
      summaryStatus,
      processedIssueCount: fieldSummary?.processedIssueCount || 0,
      estimatedIssueTotal: fieldSummary?.estimatedIssueTotal || snapshotField.totalIssueCount || 0,
      progressLog: fieldSummary?.progressLog || [],
      startedAt: fieldSummary?.startedAt || null,
      completedAt: fieldSummary?.completedAt || null,
      lastError: fieldSummary?.lastError || null,
    };
  } catch (error) {
    logger.error("getFieldDetails.failed", errorContext(error));
    throw error;
  }
}

export async function getFilteredFieldIds({ payload, context }) {
  // Input validation
  optionalString(payload?.fieldType, "fieldType");
  optionalString(payload?.sort, "sort");
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const meta = await readSnapshotMeta(installationKey);
  if (!meta?.version) {
    return { fieldIds: [] };
  }

  const query = String(payload?.query || "").trim();
  const optionQuery = String(payload?.optionQuery || "").trim();
  const type = String(payload?.type || "all").trim() || "all";
  const findingsFilter = String(payload?.findingsFilter || "all").trim() || "all";
  const projectUsageFilter = String(payload?.projectUsageFilter || "all").trim() || "all";
  const minIssuesWithValue = payload?.minIssuesWithValue ?? "";
  const maxIssuesWithValue = payload?.maxIssuesWithValue ?? "";
  const fieldOrigin = String(payload?.fieldOrigin || "all").trim() || "all";
  const sortBy = String(payload?.sortBy || "name-asc").trim() || "name-asc";
  const minActiveProjects = payload?.minActiveProjects ?? "";
  const maxActiveProjects = payload?.maxActiveProjects ?? "";
  const minContexts = payload?.minContexts ?? "";
  const maxContexts = payload?.maxContexts ?? "";
  const duplicateNamesOnly = Boolean(payload?.duplicateNamesOnly);
  const hasDescription = payload?.hasDescription || "all";
  const hideSystemFields = Boolean(payload?.hideSystemFields);
  const snapshotFields = await loadSnapshotFields(installationKey, meta.version);
  const fieldSummaries = await listFieldSummaries(installationKey, 5000).catch(
    fallbackOn("resolver.summaries_load_failed", () => [], { installationKey }),
  );
  const summaryByFieldId = new Map(fieldSummaries.map((summary) => [summary.fieldId, summary]));
  const duplicateNameCounts = buildDuplicateNameCountMap(snapshotFields);
  const allFields = snapshotFields.map((field) => {
    const summary = summaryByFieldId.get(field.id);
    if (!summary) {
      return hydrateFieldForGovernance(
        {
          ...field,
          projectUsageBuilt: Number(field.totalIssueCount || 0) <= 0,
          projectUsageState: Number(field.totalIssueCount || 0) <= 0 ? "not-needed" : "unbuilt",
        },
        null,
        duplicateNameCounts.get(normalizeFieldName(field.name)) ?? 1,
      );
    }
    const inferredBuilt = summary.summaryStatus === "ready";
    return hydrateFieldForGovernance(
      {
        ...field,
        activeProjectCount: summary.activeProjectCount ?? field.activeProjectCount,
        totalIssueCount: summary.totalIssueCount ?? field.totalIssueCount,
        projectUsageBuilt: inferredBuilt,
        projectUsageState: summary.summaryStatus || (inferredBuilt ? "ready" : "unbuilt"),
      },
      summary,
      duplicateNameCounts.get(normalizeFieldName(field.name)) ?? 1,
    );
  });
  const optionMatches = optionQuery ? await searchFieldOptionsCache(installationKey, optionQuery, 5000) : null;
  const optionMatchedFieldIds = optionMatches ? new Set(optionMatches.map((match) => match.fieldId)) : null;
  const optionFilteredFields = optionMatchedFieldIds
    ? allFields.filter((field) => optionMatchedFieldIds.has(field.id))
    : allFields;
  const filtered = sortInventoryFields(
    applyFindingsFilter(
      filterInventoryFields(
        optionFilteredFields,
        query,
        type,
        projectUsageFilter,
        maxIssuesWithValue,
        fieldOrigin,
        minIssuesWithValue,
        {
          minActiveProjects,
          maxActiveProjects,
          minContexts,
          maxContexts,
          duplicateNamesOnly,
          hasDescription,
          hideSystemFields,
        },
      ),
      findingsFilter,
    ),
    sortBy,
  );
  return { fieldIds: filtered.map((field) => field.id) };
}

export async function searchFieldOptions({ payload, context }) {
  // Input validation
  requireNonEmptyString(payload?.fieldId, "fieldId");
  if (payload?.query !== undefined && payload?.query !== null) requireNonEmptyString(payload.query, "query");
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const optionQuery = String(payload?.optionQuery || "").trim();
  if (!optionQuery) {
    return { status: "empty", matches: [], nextIndex: 0, done: true, scanned: 0, totalCandidates: 0 };
  }

  const matches = await searchFieldOptionsCache(installationKey, optionQuery, 500);

  return {
    status: "ok",
    optionQuery,
    matches: matches.map((match) => match.fieldId),
    nextIndex: matches.length,
    done: true,
    scanned: matches.length,
    totalCandidates: matches.length,
  };
}

export async function getFieldOptions({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    await ensureProjectStoreReady();
    const fieldId = String(payload?.fieldId || "");
    const projectKeys = Array.isArray(payload?.projectKeys) ? payload.projectKeys.filter(Boolean) : [];

    if (!fieldId) return { fieldId: "", optionsByContext: [] };

    let { optionsByContext, refreshedAt } = await loadFieldOptionsCache(getInstallationKey(context), fieldId);
    if (!optionsByContext.length || payload?.forceRefresh) {
      optionsByContext = await loadFieldOptionsFromJira(fieldId);
      const cacheResult = await replaceFieldOptionsCache(getInstallationKey(context), fieldId, optionsByContext);
      refreshedAt = cacheResult.refreshedAt;
    }

    if (projectKeys.length > 0) {
      const numericId = getFieldNumericId(fieldId);
      const fieldSelector = numericId ? `cf[${numericId}]` : fieldId;
      const projectFilter = `project in (${projectKeys.map((k) => `"${k.replace(/"/g, '\\"')}"`).join(", ")})`;

      const allOptions = [];
      const seenIds = new Set();
      for (const ctx of optionsByContext) {
        for (const opt of ctx.options) {
          if (!seenIds.has(opt.id) && !opt.disabled) {
            seenIds.add(opt.id);
            allOptions.push(opt);
          }
          if (allOptions.length >= 100) break;
        }
        if (allOptions.length >= 100) break;
      }

      const counts = await mapWithConcurrency(allOptions, 4, async (opt) => {
        try {
          const safeValue = opt.value.replace(/"/g, '\\"');
          const data = await jiraRequest(route`/rest/api/3/search/jql`, {
            method: "POST",
            body: JSON.stringify({
              jql: `${projectFilter} AND ${fieldSelector} = "${safeValue}"`,
              maxResults: 0,
              fields: [],
            }),
          });
          return { id: opt.id, issueCount: Number(data?.total ?? 0) };
        } catch {
          return { id: opt.id, issueCount: null };
        }
      });

      const countById = new Map(counts.map((c) => [c.id, c.issueCount]));
      for (const ctx of optionsByContext) {
        for (const opt of ctx.options) {
          if (countById.has(opt.id)) opt.issueCount = countById.get(opt.id);
        }
      }
    }

    return { fieldId, optionsByContext, refreshedAt };
  } catch (error) {
    logger.error("getFieldOptions.failed", errorContext(error));
    throw error;
  }
}
