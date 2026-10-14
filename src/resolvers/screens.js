// Screens pillar: inventory, build, screen-to-field reachability and the screen x field cross signal.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import {
  incrMetric,
  METRIC_NAMES,
  getInstallationKey,
  getBrowsableProjectIds,
} from "../lib/jira-api.js";
import {
  ensureProjectStoreReady,
  readSnapshotMeta,
  loadSnapshotFields,
  readWorkflowSnapshotMeta,
  transitionAwareWorkflowVersion,
  readScreenSnapshotMeta,
  loadScreensPage,
  loadScreensForField,
  loadScreenSchemes,
  loadScreenSchemeOperations,
  loadIssueTypeScreenSchemes,
  loadItssMappings,
  loadItssProjects,
  loadScreensWithFieldsByIds,
  loadScreenGovernanceSummary,
  loadFieldReachabilityByProject,
  loadProjectScreenCoverage,
  loadPopulatedProjectUsage,
  loadPopulatedFieldProjectPairs,
  writeScreenCrossSummary,
  loadScreenCountsForFields,
  loadScreenDistributions,
  DEFAULT_SCREEN_SORT,
  SCREEN_SORT_KEYS,
  loadTransitionScreens,
} from "../lib/project-store.js";
import { measureScreenFetchCost, probeScreenEndpoints, DEFAULT_SAMPLE_SIZE } from "../lib/screen-probe.js";
import { queueScreenSnapshotBuild, isScreenBuildStale } from "../lib/screen-engine.js";
import { REPORT_ROW_LIMIT } from "../lib/pillar-reports.js";
import { summarizeScreenFieldCross } from "../lib/screen-insights.js";
import { STRUCTURAL_SYSTEM_FIELDS } from "../lib/analysis.js";
import { logger, fallbackOn, ignoreWith } from "../lib/logger.js";
import { requireNonEmptyString, requireArray, optionalString } from "../lib/validate.js";
import { readAdminConfig } from "./admin-config.js";

// Read path for the Screens surface. Mirrors getWorkflowInventory: one call returns the
// meta, a page of screens, and the two scheme layers, so the tab renders from a single
// round trip rather than four.
export async function getScreenInventory({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readScreenSnapshotMeta(installationKey);
  const staleBuild = isScreenBuildStale(meta);

  // No snapshot has ever completed. Report that plainly rather than returning empty rows
  // that read as "this site has no screens" -- the two are opposite claims.
  if (!meta?.version) {
    return {
      state: meta?.state || "idle",
      staleBuild,
      // Carried even with no version: the first build runs for minutes before it produces
      // one, and the UI needs something to show for that time other than "nothing here".
      startedAt: meta?.startedAt || null,
      version: null,
      screens: { total: 0, rows: [] },
      screenSchemes: [],
      schemeOperations: [],
      issueTypeScreenSchemes: [],
      lastError: meta?.lastError || null,
      neverBuilt: true,
    };
  }

  const page = Math.max(1, Number(payload?.page) || 1);
  const pageSize = Math.max(1, Math.min(100, Number(payload?.pageSize) || 25));
  const search = optionalString(payload?.search, "search") || "";

  // The workflow snapshot's version, for the transition layer. Screens and workflows
  // rebuild independently, so this is resolved per request rather than assumed to match.
  const workflowMeta = await readWorkflowSnapshotMeta(installationKey).catch(() => null);

  const [screens, screenSchemes, schemeOperations, issueTypeScreenSchemes, distributions, governance, transitionScreens] = await Promise.all([
    loadScreensPage(installationKey, meta.version, {
      limit: pageSize,
      offset: (page - 1) * pageSize,
      search,
      // Passed straight through; the store whitelists it. Sorting has to happen in SQL
      // because the tab shows 25 of ~760 screens -- sorting the page in the browser would
      // reorder an arbitrary slice and present it as the top of the catalog.
      sort: optionalString(payload?.sort, "sort") || DEFAULT_SCREEN_SORT,
      // Which finding the reader arrived from, if they arrived from one. Whitelisted by the
      // store, and dropped there when it needs a workflow snapshot that does not exist --
      // the result says which of those happened rather than silently showing everything.
      filter: optionalString(payload?.filter, "filter") || null,
      workflowVersion: transitionAwareWorkflowVersion(workflowMeta),
    }),
    loadScreenSchemes(installationKey, meta.version),
    loadScreenSchemeOperations(installationKey, meta.version),
    loadIssueTypeScreenSchemes(installationKey, meta.version),
    loadScreenDistributions(installationKey, meta.version),
    loadScreenGovernanceSummary(installationKey, meta.version, { workflowVersion: transitionAwareWorkflowVersion(workflowMeta) }),
    workflowMeta?.version
      ? loadTransitionScreens(installationKey, workflowMeta.version)
      : Promise.resolve([]),
  ]);

  return {
    state: meta.state,
    staleBuild,
    startedAt: meta.startedAt || null,
    version: meta.version,
    refreshedAt: meta.refreshedAt,
    completedAt: meta.completedAt,
    totalScreens: meta.totalScreens,
    totalSchemes: meta.totalSchemes,
    // Surfaced at the top level, not buried in the rows. A pass that could not read part
    // of the catalog caps every finding built on it, and the reader needs that before the
    // numbers rather than after.
    unresolvedScreens: meta.unresolvedScreens,
    lastError: meta.lastError || null,
    page,
    pageSize,
    // Echoed back so the toolbar reflects what the rows were actually ordered by,
    // including when an unrecognised token fell back to the default.
    sort: SCREEN_SORT_KEYS.includes(String(payload?.sort || "")) ? String(payload.sort) : DEFAULT_SCREEN_SORT,
    screens,
    screenSchemes,
    schemeOperations,
    issueTypeScreenSchemes,
    // The second route to a screen. Sent whole rather than per screen: the list is bounded
    // by transitions-that-open-a-screen, which is far smaller than the screen catalog, and
    // the tab groups it by screen client-side to avoid a query per expanded row.
    // Aggregates for the tab's own overview, so it stops being a list with no summary.
    distributions,
    governance,
    transitionScreens,
    // Three states, not two. A workflow snapshot EXISTING is not the same as that snapshot
    // having looked for transition screens: every inventory built before the capture shipped
    // has none recorded, and reporting that as "no transition opens a screen" states a fact
    // the build never established. transitionScreens is null on those, a number on the rest.
    transitionsAvailable: workflowMeta?.transitionScreens != null,
    transitionsReason: workflowMeta?.version && workflowMeta.transitionScreens == null
      ? "The last workflow build could not read this site's workflows, so which screens transitions open is unknown. Screens are not called unreached until it can. Rebuild from the Workflows tab; if this persists, check the build's log for the workflow read error."
      : null,
    neverBuilt: false,
  };
}

// Screen counts for a page of fields, for the chip on each Field Browser card.
//
// Mirrors getAutomationFieldCounts, including its posture on a missing snapshot: reports
// available: false rather than a map of zeroes, because "no screen inventory" and "this
// field is on no screen" are opposite claims and the second is a premise for deleting it.
export async function getFieldScreenCounts({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readScreenSnapshotMeta(installationKey);
  if (!meta?.version) {
    return { available: false, reason: "No screen inventory has been built yet.", counts: {} };
  }

  const fieldIds = Array.isArray(payload?.fieldIds) ? payload.fieldIds.slice(0, 500) : [];
  return {
    available: true,
    version: meta.version,
    refreshedAt: meta.refreshedAt,
    // Carried with the counts so a card can caveat its own number: a build that could not
    // read 30 screens cannot claim a field is on none of them.
    unresolvedScreens: meta.unresolvedScreens,
    counts: await loadScreenCountsForFields(installationKey, meta.version, fieldIds),
  };
}

// Which screens carry one field, for the field detail panel.
export async function getFieldScreenReachability({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const fieldId = requireNonEmptyString(payload?.fieldId, "fieldId");

  const meta = await readScreenSnapshotMeta(installationKey);
  if (!meta?.version) {
    // Tri-state again: "no screen snapshot" is not "this field is on no screen", and the
    // second is the premise of a delete recommendation.
    return { available: false, reason: "No screen inventory has been built yet.", screens: [] };
  }

  return {
    available: true,
    version: meta.version,
    refreshedAt: meta.refreshedAt,
    unresolvedScreens: meta.unresolvedScreens,
    screens: await loadScreensForField(installationKey, meta.version, fieldId),
  };
}

export async function buildScreenInventory({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const meta = await readScreenSnapshotMeta(installationKey);
  // Suppress only a build that is both building AND not stale. A wedged row would
  // otherwise block every future rebuild with no way out of the UI.
  if (meta?.state === "building" && !isScreenBuildStale(meta)) {
    return { queued: false, reason: "already-building", meta };
  }

  const adminConfig = await readAdminConfig();
  if (adminConfig.readOnlyMode) {
    return { queued: false, error: "Read-only mode is enabled. Disable it before building the screen inventory." };
  }

  await queueScreenSnapshotBuild(installationKey);
  return { queued: true };
}

// Probe the endpoints that might expose Jira Automation rules.
//
// Automation is a real blind spot in the findings this app produces: "this status is
// unreachable and never used" is a claim made without looking at automation rules. If a
// rule transitions issues into that status, or sets that field, the finding is wrong --
// and someone could delete something load-bearing on our advice.
//
// Jira Automation came from the Code Barrel acquisition and its REST surface has
// historically been undocumented. Rather than assert which path works, this asks, and
// Answers what a full screen inventory pass would cost, by sampling rather than doing one.
//
// Exists because the screen pipeline's cost turns on tabs-per-screen, which is unknowable
// without asking the site. Building the fetcher first and discovering the number afterwards
// means building it twice. Read-only, admin-only, and it never throws -- like the
// automation probe, a diagnostic that can fail the page it runs on is worse than none.
export async function probeScreenFetchCost({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  const requested = Math.trunc(Number(payload?.sampleSize)) || DEFAULT_SAMPLE_SIZE;
  // Bounded: below 5 the tail is invisible, and above 100 the probe becomes the expense it
  // was written to avoid.
  const sampleSize = Math.max(5, Math.min(100, requested));

  try {
    return await measureScreenFetchCost({ sampleSize });
  } catch (error) {
    const message = String(error?.message || error);
    logger.warn("screen-probe.failed", { error: message });

    // On an authorization failure, stop guessing and ask each endpoint directly.
    //
    // The first live run failed with 401 "scope does not match" and this returned a hint
    // saying the install needed upgrading. That was wrong -- the install was already on the
    // version carrying the scopes. A hint that confidently names the wrong cause is worse
    // than no hint, because it sends the reader somewhere that cannot help.
    //
    // Every scope name is confirmed present in Atlassian's registry, so the open question
    // is which endpoint each one authorizes. Probing answers that; reasoning did not.
    const isAuthFailure = /\b401\b|\b403\b|scope does not match/i.test(message);
    let endpoints = null;
    if (isAuthFailure) {
      endpoints = await probeScreenEndpoints().catch(() => null);
    }

    return {
      ok: false,
      error: message,
      endpoints,
      hint: isAuthFailure
        ? "Authorization failure. The table below shows which screen endpoints accept the app's scopes and which reject them â€” a 404 is a pass, since it means the scope was accepted and only the placeholder id was wrong."
        : null,
    };
  }
}

// The projects a set of screens is actually applied to, walking the screen -> screen scheme
// -> ITSS -> project chain (the reverse of loadScreensForProject). A screen only reaches a
// project if a screen scheme's operation points at it, an issue type screen scheme maps that
// scheme, and a project uses that ITSS.
export async function screensToProjects(installationKey, version, screenIds) {
  const screenSet = new Set(screenIds.map(String));
  const [ops, mappings, itssProjects] = await Promise.all([
    loadScreenSchemeOperations(installationKey, version).catch(() => []),
    loadItssMappings(installationKey, version).catch(() => []),
    loadItssProjects(installationKey, version).catch(() => []),
  ]);

  const schemeIds = new Set(ops.filter((o) => screenSet.has(String(o.screenId))).map((o) => String(o.schemeId)));
  const itssIds = new Set(
    mappings.filter((m) => m.screenSchemeId && schemeIds.has(String(m.screenSchemeId))).map((m) => String(m.itssId))
  );

  const byProject = new Map();
  for (const row of itssProjects) {
    if (!itssIds.has(String(row.itssId))) continue;
    byProject.set(String(row.projectId), {
      projectId: String(row.projectId),
      projectKey: row.projectKey || "",
      projectName: row.projectName || "",
    });
  }
  return [...byProject.values()];
}

export async function getScreenFieldCrossSignal({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);

  const [screenMeta, fieldMeta] = await Promise.all([
    readScreenSnapshotMeta(installationKey),
    readSnapshotMeta(installationKey),
  ]);

  // Either half missing makes the cross meaningless rather than empty. Saying which half is
  // missing is the difference between a next step and a shrug.
  if (!screenMeta?.version || !fieldMeta?.version) {
    return {
      available: false,
      reason: !screenMeta?.version
        ? "No screen inventory has been built yet. Build one from the Screens tab or run a full scan."
        : "No field snapshot has been built yet, so there is no usage to cross the screens against.",
      screenRefreshedAt: screenMeta?.refreshedAt || null,
      fieldRefreshedAt: fieldMeta?.refreshedAt || null,
      invisibleData: [],
      formClutter: [],
      unreachableFields: [],
    };
  }

  const clutterMaxIssues = Math.max(0, Number(payload?.clutterMaxIssues) || 0);
  const summary = await runScreenFieldCross(installationKey, screenMeta, fieldMeta, { clutterMaxIssues });

  return {
    ...summary,
    // Per-pillar freshness, because the two halves refresh independently and a verdict that
    // blends them is only as current as the older one.
    screenRefreshedAt: screenMeta.refreshedAt || null,
    fieldRefreshedAt: fieldMeta.refreshedAt || null,
  };
}

// The join itself, shared by the on-demand read above and the scan stage below so the tab
// and the health score can never be computing it two different ways.
//
// This is the widest join in the app: every project's screen chain down to each screen's
// fields, against every populated field x project pair. Fine once on a queue consumer;
// deliberately never on the Overview read, which takes the stored summary instead.
export async function runScreenFieldCross(installationKey, screenMeta, fieldMeta, { clutterMaxIssues = 0 } = {}) {
  const [reachabilityRows, coverage, usageRead, catalog, pairRead] = await Promise.all([
    loadFieldReachabilityByProject(installationKey, screenMeta.version),
    loadProjectScreenCoverage(installationKey, screenMeta.version),
    loadPopulatedProjectUsage(installationKey, fieldMeta.version),
    loadSnapshotFields(installationKey, fieldMeta.version).catch(() => []),
    // Form clutter reads a missing pair as "never filled", so it needs every pair, not the
    // capped top of the list invisible data can live with. A failed read withholds it.
    loadPopulatedFieldProjectPairs(installationKey, fieldMeta.version, { minIssues: clutterMaxIssues })
      .catch(fallbackOn("screen_cross.pairs_load_failed", { pairs: null, complete: false }, { installationKey })),
  ]);

  const fields = new Map((catalog || []).map((f) => [String(f.id), { name: f.name }]));

  return summarizeScreenFieldCross({
    reachabilityRows,
    coverage,
    usage: usageRead.rows,
    usageTruncated: usageRead.truncated,
    fieldIds: [...fields.keys()],
    fields,
    clutterMaxIssues,
    populatedPairs: pairRead.pairs || new Set(),
    pairsComplete: Boolean(pairRead.pairs) && pairRead.complete,
    // Never tallied by the issue crawl, so never absent for a reason that means anything.
    unmeasuredFieldIds: STRUCTURAL_SYSTEM_FIELDS,
  });
}

// Run on the health stage of every scan, where an expensive join belongs, and persist only
// the counts. Returns the same shape the score consumes so the caller does not have to read
// back what it just wrote.
//
// Best-effort by construction: a site with no screen inventory, or a failure in either half,
// leaves the two dimensions unavailable rather than failing the health stage. An absent
// dimension is excluded from the mean; a thrown one would cost the whole score.
export async function computeAndStoreScreenCross(installationKey) {
  try {
    const [screenMeta, fieldMeta] = await Promise.all([
      readScreenSnapshotMeta(installationKey),
      readSnapshotMeta(installationKey),
    ]);
    if (!screenMeta?.version || !fieldMeta?.version) return null;

    const summary = await runScreenFieldCross(installationKey, screenMeta, fieldMeta);
    if (!summary.available) return summary;

    await writeScreenCrossSummary(installationKey, {
      ...summary,
      screenVersion: screenMeta.version,
      fieldVersion: fieldMeta.version,
      computedAt: new Date().toISOString(),
    }).catch(ignoreWith("screen_cross.summary_write_failed", { installationKey }));

    return summary;
  } catch (error) {
    logger.warn("screen_cross.compute_failed", { installationKey, error: String(error?.message || error) });
    return null;
  }
}

export async function getScreenFieldReportInputs({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const screenIds = Array.from(new Set(requireArray(payload?.screenIds, "screenIds").map((v) => String(v || "").trim()).filter(Boolean)));
  if (!screenIds.length) throw new Error("Select at least one screen.");

  const meta = await readScreenSnapshotMeta(installationKey);
  if (!meta?.version) return { available: false, reason: "No screen inventory has been built yet." };

  const screens = await loadScreensWithFieldsByIds(installationKey, meta.version, screenIds);
  const fieldMap = new Map();
  for (const screen of screens) {
    for (const field of screen.fields) {
      if (!fieldMap.has(field.fieldId)) fieldMap.set(field.fieldId, field.fieldName);
    }
  }

  const projects = await screensToProjects(installationKey, meta.version, screenIds);
  // Only projects the caller may browse, for the same reason getProjectUsageReport filters:
  // the report must never be the one place a project's existence leaks.
  const browsable = await getBrowsableProjectIds(context?.accountId, projects.map((p) => p.projectId));
  const scopedProjects = projects.filter((p) => browsable.has(String(p.projectId)));

  return {
    available: true,
    fieldIds: [...fieldMap.keys()],
    fields: [...fieldMap.entries()].map(([fieldId, fieldName]) => ({ fieldId, fieldName })),
    projectIds: scopedProjects.map((p) => p.projectId),
    projects: scopedProjects,
    screens: screens.map((s) => ({ screenId: s.screenId, name: s.name, fieldCount: s.fields.length, tabsResolved: s.tabsResolved })),
    // Screens the caller asked for that the catalog does not have, or whose tabs the build
    // could not read -- so the tab can say the field list may be incomplete.
    unresolvedScreens: screens.filter((s) => s.tabsResolved !== "resolved").map((s) => s.name),
    missingScreenIds: screenIds.filter((id) => !screens.some((s) => s.screenId === id)),
  };
}

// "Build a field report from this project's screens, organised by screen scheme." The
// project has one issue type screen scheme; that ITSS maps issue types to screen schemes,
// each of which routes create/edit/view operations to screens. Grouped by screen scheme so
// the caller can pick which parts of the process to report on.
export async function getProjectScreenReportInputs({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const projectId = requireNonEmptyString(payload?.projectId, "projectId");

  const browsable = await getBrowsableProjectIds(context?.accountId, [projectId]);
  if (!browsable.has(String(projectId))) {
    return { available: false, reason: "You do not have Browse Projects on this project." };
  }

  const meta = await readScreenSnapshotMeta(installationKey);
  if (!meta?.version) return { available: false, reason: "No screen inventory has been built yet." };

  const [itssProjects, mappings, ops, schemes] = await Promise.all([
    loadItssProjects(installationKey, meta.version).catch(() => []),
    loadItssMappings(installationKey, meta.version).catch(() => []),
    loadScreenSchemeOperations(installationKey, meta.version).catch(() => []),
    loadScreenSchemes(installationKey, meta.version).catch(() => []),
  ]);

  const itssIds = new Set(itssProjects.filter((p) => String(p.projectId) === String(projectId)).map((p) => String(p.itssId)));
  if (!itssIds.size) {
    return { available: true, projectId, itss: [], reason: "This project's screens could not be resolved through an issue type screen scheme." };
  }

  const schemeName = new Map(schemes.map((s) => [String(s.schemeId), s.name]));
  const projectMappings = mappings.filter((m) => itssIds.has(String(m.itssId)) && m.screenSchemeId);

  // scheme id -> { issueTypeCount, isDefault, screenIds }
  const bySchemeId = new Map();
  for (const m of projectMappings) {
    const key = String(m.screenSchemeId);
    if (!bySchemeId.has(key)) bySchemeId.set(key, { schemeId: key, issueTypeCount: 0, isDefault: false, screenIds: new Set() });
    const entry = bySchemeId.get(key);
    entry.issueTypeCount += 1;
    if (m.isDefault) entry.isDefault = true;
  }
  for (const o of ops) {
    const entry = bySchemeId.get(String(o.schemeId));
    if (entry && o.screenId) entry.screenIds.add(String(o.screenId));
  }

  const allScreenIds = [...new Set([...bySchemeId.values()].flatMap((e) => [...e.screenIds]))];
  const screens = await loadScreensWithFieldsByIds(installationKey, meta.version, allScreenIds);
  const screenById = new Map(screens.map((s) => [s.screenId, s]));

  const schemeGroups = [...bySchemeId.values()]
    .map((entry) => {
      const groupScreens = [...entry.screenIds]
        .map((id) => screenById.get(id))
        .filter(Boolean)
        .map((s) => ({ screenId: s.screenId, name: s.name, fieldIds: s.fields.map((f) => f.fieldId), fieldCount: s.fields.length }));
      const fieldIds = [...new Set(groupScreens.flatMap((s) => s.fieldIds))];
      return {
        schemeId: entry.schemeId,
        schemeName: schemeName.get(entry.schemeId) || entry.schemeId,
        issueTypeCount: entry.issueTypeCount,
        isDefault: entry.isDefault,
        screens: groupScreens,
        fieldIds,
      };
    })
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.fieldIds.length - a.fieldIds.length || a.schemeName.localeCompare(b.schemeName));

  return {
    available: true,
    projectId,
    scopeProjectIds: [String(projectId)],
    schemes: schemeGroups,
    allFieldIds: [...new Set(schemeGroups.flatMap((g) => g.fieldIds))],
  };
}

// Every screen, in pages of the store's maximum. Stops one page past the report cap so the
// report can still say it was truncated.
export async function loadAllScreenPages(installationKey, version, { workflowVersion = null, filter = null } = {}) {
  const rows = [];
  for (let offset = 0; rows.length <= REPORT_ROW_LIMIT; offset += 200) {
    const page = await loadScreensPage(installationKey, version, { limit: 200, offset, filter, workflowVersion });
    rows.push(...page.rows);
    if (page.rows.length < 200) break;
  }
  return rows;
}
