// Project overview: every pillar that touches one project, and its health roll-up.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES, getInstallationKey } from "../lib/jira-api.js";
import {
  ensureProjectStoreReady,
  readSnapshotMeta,
  listSnapshotProjects,
  loadProjectActivity,
  readFilterSnapshotMeta,
  loadFilterReferencesFor,
  readWorkflowSnapshotMeta,
  loadWorkflowSchemeForProject,
  readScreenSnapshotMeta,
  loadScreensForProject,
  readAccessSnapshotMeta,
  loadProjectSchemes,
  loadProjectRoleActors,
  readBoardSnapshotMeta,
  loadBoards,
} from "../lib/project-store.js";
import { attachUniqueIssueCounts } from "../lib/site-health.js";
import { summarizeAdoption } from "../lib/project-adoption.js";
import { loadRulesForProject, loadGlobalRulesAffectingProject } from "../lib/store/automation.js";
import { requireNonEmptyString } from "../lib/validate.js";
import { browsableOrAll } from "./viewer.js";

// Everything that touches one project, across every pillar.
//
// This is the view the Projects tab existed to give and could not: it had the field list and
// a workflow scheme wedged in beside it, and no way to say which forms a project routes to
// or which automation rules fire in it. Both joins existed as data and neither had a query.
//
// Each pillar is independent and independently unavailable. A project whose screen inventory
// has never been built reports screens as unknown and still shows its workflow, fields and
// rules -- the alternative is one unbuilt pillar blanking the whole page.
// A project's overall health, rolled up from the pillar signals rather than compressed into
// one invented number. The app's rule everywhere else: publish the rate the judgement came
// from, because "ADVEV scores 41" tells an admin nothing they can act on.
//
// The band is deliberately coarse -- "needs a look" vs "looks fine" -- and only the signals
// carry detail. `configHeavy` is the one principled threshold: 3x the site's own median
// fills-per-issue, the same median-derived approach the field pillar already uses.
export function buildProjectHealthRollup({ perIssue, siteMedianPerIssue, adoption, automation, screens, workflow }) {
  const signals = [];

  if (adoption?.measured) {
    const tone = adoption.fellOff ? "critical" : adoption.neverAdopted ? "warning"
      : (adoption.score ?? 0) >= 66 ? "success" : "neutral";
    signals.push({
      key: "adoption",
      label: "Adoption",
      value: adoption.score ?? "—",
      detail: adoption.fellOff ? "running far below its own historical rate"
        : adoption.neverAdopted ? "never picked up — under an issue a month across its life"
        : adoption.volumePercentile != null ? `busier than ${adoption.volumePercentile}% of projects here`
        : "measured",
      tone,
    });
  } else {
    signals.push({
      key: "adoption",
      label: "Adoption",
      value: "—",
      detail: adoption?.dataStale ? "activity data is stale — the last full scan didn't finish"
        : "no scanned activity yet",
      tone: "neutral",
    });
  }

  const ratio = perIssue != null && siteMedianPerIssue ? perIssue / siteMedianPerIssue : null;
  const configHeavy = ratio != null && ratio >= 3;
  signals.push({
    key: "configuration",
    label: "Configuration weight",
    value: perIssue != null ? `${perIssue.toFixed(1)} fields/issue` : "—",
    detail: perIssue == null ? "needs a Universal Scan for issue counts"
      : siteMedianPerIssue ? `site median ${siteMedianPerIssue.toFixed(1)}${ratio >= 2 ? ` — ${ratio.toFixed(1)}× heavier` : ""}`
      : "how much of the form gets filled",
    tone: ratio != null && ratio >= 6 ? "critical" : configHeavy ? "warning" : "neutral",
  });

  if (automation?.available) {
    signals.push({
      key: "automation",
      label: "Automation",
      value: automation.enabledCount,
      detail: `${automation.enabledCount} active${automation.disabledCount ? `, ${automation.disabledCount} disabled` : ""} scoped here`,
      // A soft flag at a round number: a project carrying dozens of its own rules is a
      // maintenance surface, not a defect. 40 is where "complex" starts to read as "nobody
      // fully understands this any more".
      tone: automation.enabledCount >= 40 ? "warning" : "neutral",
    });
  }

  if (screens?.available) {
    const readable = (screens.screens || []).filter((s) => s.tabsResolved === "resolved").length;
    signals.push({
      key: "forms",
      label: "Forms",
      value: readable,
      detail: screens.unresolvedScreens > 0
        ? `${screens.unresolvedScreens} screens on this site could not be read`
        : "screens this project routes to",
      tone: screens.unresolvedScreens > 0 ? "warning" : "neutral",
    });
  }

  if (workflow?.available && workflow.scheme) {
    signals.push({
      key: "process",
      label: "Process",
      value: workflow.scheme.sharedWithCount > 0 ? "shared" : "local",
      detail: workflow.scheme.sharedWithCount > 0
        ? `workflow scheme shared with ${workflow.scheme.sharedWithCount} other ${workflow.scheme.sharedWithCount === 1 ? "project" : "projects"}`
        : "workflow scheme used only here",
      tone: "neutral",
    });
  }

  const worst = signals.some((s) => s.tone === "critical") ? "critical"
    : signals.some((s) => s.tone === "warning") ? "warning" : "healthy";

  return {
    band: worst,
    headline: worst === "critical" ? "Needs attention"
      : worst === "warning" ? "Worth a look" : "Looks healthy",
    signals,
  };
}

export async function getProjectOverview({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  await ensureProjectStoreReady();
  const installationKey = getInstallationKey(context);
  const projectId = requireNonEmptyString(payload?.projectId, "projectId");
  const projectKeyHint = typeof payload?.projectKey === "string" ? payload.projectKey.trim() : "";

  // Permission first, and before any pillar is read. Every other project read in this file
  // filters by browsable project, and a cross-pillar view must not become the one place a
  // caller can learn about a project they cannot see. browsableOrAll keeps that check for
  // every resolver caller and only relaxes it for a Rovo agent action, which arrives with no
  // user principal to check against (see its comment).
  const browsable = await browsableOrAll(context, [projectId]);
  if (!browsable.has(String(projectId))) {
    return { available: false, reason: "You do not have Browse Projects on this project." };
  }

  const [fieldMeta, workflowMeta, screenMeta, filterMeta, accessMeta, boardMeta] = await Promise.all([
    readSnapshotMeta(installationKey),
    readWorkflowSnapshotMeta(installationKey).catch(() => null),
    readScreenSnapshotMeta(installationKey).catch(() => null),
    readFilterSnapshotMeta(installationKey).catch(() => null),
    readAccessSnapshotMeta(installationKey).catch(() => null),
    readBoardSnapshotMeta(installationKey).catch(() => null),
  ]);

  // The agile boards whose location is this project. loadBoards returns the whole estate for
  // a version -- a few hundred rows -- so filtering in memory is cheaper than a scoped query.
  const projectBoards = boardMeta?.version
    ? (await loadBoards(installationKey, boardMeta.version).catch(() => []))
        .filter((b) => b.locationType === "project" &&
          (String(b.locationId) === String(projectId) ||
           (projectKeyHint && String(b.locationKey || "").toLowerCase() === projectKeyHint.toLowerCase())))
    : [];

  // The project's own row, plus every browsable project's activity -- needed both for this
  // project's fills-per-issue and for the site median it is judged against, and for the
  // adoption percentile, which is only meaningful against a population.
  const allProjectsRaw = fieldMeta?.version
    ? await listSnapshotProjects(installationKey, fieldMeta.version).catch(() => [])
    : [];
  const allProjects = await attachUniqueIssueCounts(installationKey, allProjectsRaw).catch(() => allProjectsRaw);
  const thisProject = allProjects.find((p) => String(p.projectId) === String(projectId)) || null;
  const projectKey = projectKeyHint || thisProject?.projectKey || "";

  const [scheme, screens, rules, globalRules, projectFilters, activityByProject, projectSchemeRows, projectRoleRows] = await Promise.all([
    workflowMeta?.version
      ? loadWorkflowSchemeForProject(installationKey, workflowMeta.version, projectId).catch(() => null)
      : Promise.resolve(null),
    screenMeta?.version
      ? loadScreensForProject(installationKey, screenMeta.version, projectId).catch(() => null)
      : Promise.resolve(null),
    loadRulesForProject(installationKey, projectId).catch(() => null),
    // Needs the field snapshot: the evidence is field usage in this project, so without it
    // there is nothing to infer from and the list is withheld rather than guessed at.
    fieldMeta?.version
      ? loadGlobalRulesAffectingProject(installationKey, fieldMeta.version, projectId).catch(() => null)
      : Promise.resolve(null),
    // Filters whose JQL names this project. The filter snapshot already indexes project refs
    // pulled out of each filter's JQL, so this is the same join the field pillar uses.
    filterMeta?.version && projectKey
      ? loadFilterReferencesFor(installationKey, filterMeta.version, "project", projectKey).catch(() => null)
      : Promise.resolve(null),
    loadProjectActivity(installationKey).catch(() => new Map()),
    accessMeta?.version
      ? loadProjectSchemes(installationKey, accessMeta.version, projectId).catch(() => null)
      : Promise.resolve(null),
    accessMeta?.version
      ? loadProjectRoleActors(installationKey, accessMeta.version, projectId).catch(() => null)
      : Promise.resolve(null),
  ]);

  const workflowPillar = workflowMeta?.version
    ? { available: true, scheme }
    : { available: false, reason: "No workflow inventory has been built yet." };
  const screensPillar = screenMeta?.version && screens
    ? { available: true, screens, unresolvedScreens: screenMeta.unresolvedScreens || 0 }
    : { available: false, reason: "No screen inventory has been built yet." };
  const automationPillar = rules
    ? {
      available: true,
      rules,
      enabledCount: rules.filter((r) => r.enabled).length,
      disabledCount: rules.filter((r) => !r.enabled).length,
      globalRules: globalRules || [],
      globalRulesAvailable: Boolean(globalRules),
      globalRulesReason: globalRules ? null : "Needs the field snapshot to tell which site-wide rules act on this project.",
    }
    : { available: false, reason: "No automation analysis has been built yet." };

  // Adoption for this project, scored against every browsable project so its percentile means
  // something. Reuses summarizeAdoption rather than re-deriving the site median here.
  let adoptionRow = null;
  let siteMedianPerIssue = null;
  if (thisProject) {
    const adoption = summarizeAdoption(allProjects, activityByProject);
    adoptionRow = adoption.projects.find((r) => String(r.projectId) === String(projectId)) || null;
    if (adoptionRow) adoptionRow.dataStale = adoption.dataStale;
    const perIssueValues = allProjects
      .map((p) => {
        const f = Number(p.totalIssueCount), u = Number(p.uniqueIssueCount);
        return Number.isFinite(f) && Number.isFinite(u) && u > 0 ? f / u : null;
      })
      .filter((v) => v != null)
      .sort((a, b) => a - b);
    siteMedianPerIssue = perIssueValues.length ? perIssueValues[Math.floor(perIssueValues.length / 2)] : null;
  }

  const thisFills = Number(thisProject?.totalIssueCount);
  const thisIssues = Number(thisProject?.uniqueIssueCount);
  const perIssue = Number.isFinite(thisFills) && Number.isFinite(thisIssues) && thisIssues > 0
    ? thisFills / thisIssues
    : null;

  return {
    available: true,
    projectId,
    projectKey: projectKey || null,
    projectName: thisProject?.projectName || null,
    // When the field snapshot this view is anchored on was built. Null with no snapshot.
    refreshedAt: fieldMeta?.refreshedAt || null,
    // Tri-state per pillar, never an empty list standing in for an unbuilt one. "No rule
    // touches this project" and "no automation analysis exists" are opposite claims, and
    // only one of them means the project is simple.
    workflow: workflowPillar,
    screens: screensPillar,
    automation: automationPillar,
    // Filters whose JQL scopes to this project -- the ones that break, or narrow, if it is
    // renamed or archived. Tri-state like the rest: no filter snapshot is not "no filters".
    filters: filterMeta?.version
      ? {
        available: true,
        total: projectFilters?.total ?? 0,
        filters: projectFilters?.filters ?? [],
      }
      : { available: false, reason: "No saved-filter inventory has been built yet." },
    adoption: adoptionRow,
    // The permission / issue-security / notification scheme this project uses, each flagged
    // if it is the site default. Tri-state like the rest.
    schemes: accessMeta?.version
      ? {
        available: true,
        permission: (projectSchemeRows || []).find((s) => s.schemeType === "permission") || null,
        security: (projectSchemeRows || []).find((s) => s.schemeType === "security") || null,
        notification: (projectSchemeRows || []).find((s) => s.schemeType === "notification") || null,
      }
      : { available: false, reason: "No access scheme inventory has been built yet." },
    // Project-role actors, grouped by role. An "empty" holder means the role exists here
    // with nobody in it.
    roles: accessMeta?.version
      ? {
        available: true,
        byRole: Object.values((projectRoleRows || []).reduce((acc, r) => {
          const key = r.roleId;
          acc[key] = acc[key] || { roleId: r.roleId, roleName: r.roleName, actors: [] };
          if (r.holderType === "user" || r.holderType === "group") {
            acc[key].actors.push({ type: r.holderType, value: r.holderValue, label: r.holderLabel });
          }
          return acc;
        }, {})),
      }
      : { available: false, reason: "No access scheme inventory has been built yet." },
    // The agile boards that live in this project, with their backing filter and column state.
    // Tri-state like the rest: no board snapshot is not "no boards".
    boards: boardMeta?.version
      ? {
        available: true,
        boards: projectBoards.map((b) => ({
          boardId: b.boardId,
          name: b.name,
          type: b.type,
          filterId: b.filterId,
          columnCount: b.columnCount,
          configReadable: b.configReadable,
        })),
      }
      : { available: false, reason: "No board inventory has been built yet." },
    // One rolled-up read of the project's overall health, from the pillar signals above.
    health: buildProjectHealthRollup({
      perIssue,
      siteMedianPerIssue,
      adoption: adoptionRow,
      automation: automationPillar,
      screens: screensPillar,
      workflow: workflowPillar,
    }),
    fields: { available: Boolean(fieldMeta?.version) },
  };
}
