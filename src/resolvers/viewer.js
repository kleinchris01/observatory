// Who is calling, and which projects they can see. Shared by the macro reads and project-scoped admin reads.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { getInstallationKey, getBrowsableProjectIds } from "../lib/jira-api.js";
import { readSnapshotMeta, listSnapshotProjects } from "../lib/project-store.js";

// How many projects this viewer can Browse, for the macro's scope statement.
//
// Best-effort and separate from the access decision: a viewer who is allowed in but whose
// project count cannot be established sees the generic "scoped to the projects you can
// browse" rather than being refused. Null means unknown, 0 means genuinely none -- and the
// macro says something different for each, because "you have no access to anything" is a
// thing somebody needs to be told plainly rather than left to infer from empty tabs.
export async function viewerProjectCount(context) {
  try {
    const installationKey = getInstallationKey(context);
    const scope = await viewerProjects(installationKey, context);
    return scope.available ? scope.projects.length : null;
  } catch {
    return null;
  }
}

// ── Macro viewer pillars ──────────────────────────────────────────────────────────────────
//
// The Confluence macro shows a viewer the projects they can Browse and the filters,
// dashboards and workflows attached to those projects -- nothing about a project they cannot
// already see in Jira. Every one of these SHARED resolvers starts from the same browsable
// set, exactly as the macro's Projects tab already does. They carry no governance findings:
// a macro viewer browses, an admin governs.

export const MACRO_PILLAR_PAGE_SIZE = 20;

export function macroPaginate(rows, page, pageSize = MACRO_PILLAR_PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (current - 1) * pageSize;
  return { slice: rows.slice(start, start + pageSize), page: current, pageSize, totalPages };
}

// The account behind a call, wherever the runtime put it. A resolver invocation carries it
// on context.accountId; a Rovo agent action's context nests it under principal, or -- for an
// agent-identity invocation with no end user -- does not carry one at all.
export function callerAccountId(context) {
  return (
    context?.accountId ||
    context?.principal?.accountId ||
    context?.context?.accountId ||
    context?.principal?.id ||
    null
  );
}

// Browse-permission filter that degrades to "trust the snapshot" when there is no caller to
// check against. Observatory is an admin-only app and its snapshots only ever hold what the
// app itself (asApp, broad read scopes) could see, so a Rovo agent action -- which reaches
// here with no user principal -- gets the project set the app already has rather than an
// empty one. Every resolver-driven caller still carries an accountId and stays filtered.
export async function browsableOrAll(context, projectIds) {
  const ids = (projectIds || []).map(String);
  const accountId = callerAccountId(context);
  if (!accountId) return new Set(ids);
  return getBrowsableProjectIds(accountId, ids);
}

// The viewer's browsable projects, with both id and key -- filters reference a project by
// KEY (from JQL), dashboard shares and the workflow map by ID.
export async function viewerProjects(installationKey, context) {
  const fieldMeta = await readSnapshotMeta(installationKey).catch(() => null);
  if (!fieldMeta?.version) return { available: false, projectIds: new Set(), projectKeys: new Set(), projects: [] };

  const all = await listSnapshotProjects(installationKey, fieldMeta.version).catch(() => []);
  const browsable = await browsableOrAll(context, all.map((p) => p.projectId));
  const projects = all
    .filter((p) => browsable.has(String(p.projectId)))
    .map((p) => ({ projectId: String(p.projectId), projectKey: p.projectKey, projectName: p.projectName }));

  return {
    available: true,
    projectIds: new Set(projects.map((p) => p.projectId)),
    projectKeys: new Set(projects.map((p) => String(p.projectKey || "").toLowerCase())),
    projects,
  };
}
