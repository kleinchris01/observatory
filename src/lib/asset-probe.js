// Confirms what the JSM Assets (CMDB) API will answer, before an engine is written against
// specific paths.
//
// Assets is not on the site. Its REST API lives on the gateway host --
// api.atlassian.com/jsm/assets/workspace/{workspaceId}/v1/... -- so requestJira cannot
// reach it. probeStargateEndpoint goes through `asApp().requestAtlassian`, which takes a
// path relative to api.atlassian.com; the workspace-id discovery hop comes first because
// every Assets URL needs it.
//
// Deliberately a probe and not the first half of the real fetcher: it fetches one schema's
// worth of structure at most, enough to see the shapes, and never walks objects.

import { logger } from "./logger.js";
import { probeEndpoint, probeStargateEndpoint } from "./jira-api.js";

// The site-relative JSM endpoint that hands back the Assets workspace id. One workspace per
// site is the norm; Data Center migrations can leave more than one.
const WORKSPACE_PATH = "/rest/servicedeskapi/assets/workspace";

// Relative to api.atlassian.com -- requestAtlassian prepends the host.
function assetsBase(workspaceId) {
  return `/jsm/assets/workspace/${workspaceId}/v1`;
}

// A 401 "scope does not match" means a missing scope, not a missing licence. A 403 or 404 is
// the real "Assets is not on this site" case. Keeping these apart is the whole point of the
// probe -- the first version collapsed both into "needs JSM Premium" and sent someone
// checking their subscription when the fix was a manifest scope.
export function workspaceReason(probe) {
  const scopeGap = probe.status === 401 || /scope does not match/i.test(probe.sample || "");
  if (scopeGap) {
    return "The workspace endpoint returned 401 (scope does not match) — the app is missing "
      + "the scope for /rest/servicedeskapi/assets/workspace. Redeploy with it and upgrade the install.";
  }
  if (probe.ok) {
    return "The workspace endpoint answered but named no workspace — Assets may not be provisioned on this site.";
  }
  return `The workspace endpoint returned ${probe.status ?? "no response"} — Assets is not enabled here (it needs JSM Premium/Enterprise).`;
}

// Pull the first workspace id out of whatever shape the endpoint returned. It is normally
// { values: [{ workspaceId }] }, but a bare array and a single object have both been seen.
export function firstWorkspaceId(sample) {
  let parsed;
  try {
    parsed = typeof sample === "string" ? JSON.parse(sample) : sample;
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.values) ? parsed.values : [parsed]);
  for (const entry of list) {
    const id = entry?.workspaceId || entry?.id;
    if (id) return String(id);
  }
  return null;
}

// A payload "looks like Assets" when it carries one of the identifying keys rather than an
// error envelope or an HTML login page. Kept loose on purpose -- the point is to tell a real
// answer from a 200-that-is-not-JSON, not to validate the schema.
function looksLikeAssets(sample) {
  return /"(objectSchemas|objectTypeAttributes|objectschema|workspaceId|globalId|referenceTypes|typeName)"\s*[:[]/i.test(sample || "")
    || /^\s*\[\s*\{/.test(sample || "");
}

// Discover the workspace, then hit the handful of structure endpoints the pillar would be
// built on. Returns a flat report the tab can render row by row.
export async function probeAssetsApi() {
  const started = Date.now();

  // 1. Workspace id (site-relative).
  const workspaceProbe = await probeEndpoint(WORKSPACE_PATH);
  const workspaceId = workspaceProbe.ok ? firstWorkspaceId(workspaceProbe.sample) : null;

  const results = [{
    step: "workspace",
    path: WORKSPACE_PATH,
    via: "site",
    status: workspaceProbe.status,
    ok: workspaceProbe.ok,
    ms: workspaceProbe.ms,
    sample: workspaceProbe.sample,
  }];

  if (!workspaceId) {
    logger.info("assets-probe.summary", {
      reachable: 0, workspaceId: null,
      reason: workspaceProbe.status === 200 ? "no-workspace-in-payload" : `workspace-${workspaceProbe.status}`,
    });
    return {
      assetsEnabled: false,
      workspaceId: null,
      reason: workspaceReason(workspaceProbe),
      results,
      reachable: [],
      ms: Date.now() - started,
    };
  }

  const base = assetsBase(workspaceId);
  const candidates = [
    { step: "schemas", path: `${base}/objectschema/list` },
    { step: "statuses", path: `${base}/config/statustype` },
    { step: "referenceTypes", path: `${base}/config/referencetype` },
  ];

  for (const candidate of candidates) {
    const probe = await probeStargateEndpoint(candidate.path);
    results.push({
      step: candidate.step, path: candidate.path, via: "stargate",
      status: probe.status, ok: probe.ok, ms: probe.ms, sample: probe.sample,
      looksLikeAssets: looksLikeAssets(probe.sample),
    });
  }

  // If the schema list came back, follow it one level: the object-type and attribute
  // endpoints are per-schema, and their exact spelling is the thing most worth confirming.
  const schemasRow = results.find((r) => r.step === "schemas");
  const schemaId = schemasRow?.ok ? firstSchemaId(schemasRow.sample) : null;
  if (schemaId) {
    for (const candidate of [
      { step: "objectTypes", path: `${base}/objectschema/${schemaId}/objecttypes/flat` },
      { step: "schemaAttributes", path: `${base}/objectschema/${schemaId}/attributes` },
    ]) {
      const probe = await probeStargateEndpoint(candidate.path);
      results.push({
        step: candidate.step, path: candidate.path, via: "stargate",
        status: probe.status, ok: probe.ok, ms: probe.ms, sample: probe.sample,
        looksLikeAssets: looksLikeAssets(probe.sample),
      });
    }
  }

  const reachable = results.filter((r) => r.via === "stargate" && r.ok && r.looksLikeAssets);
  logger.info("assets-probe.summary", {
    workspaceId, probed: results.length, reachable: reachable.length,
    reachablePaths: reachable.map((r) => r.path),
  });

  return {
    assetsEnabled: reachable.length > 0,
    workspaceId,
    schemaIdSampled: schemaId,
    results,
    reachable: reachable.map((r) => r.step),
    ms: Date.now() - started,
  };
}

// First object schema id from the /objectschema/list payload -- normally
// { objectSchemas: [{ id }] }, occasionally a bare array.
export function firstSchemaId(sample) {
  let parsed;
  try {
    parsed = typeof sample === "string" ? JSON.parse(sample) : sample;
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.objectSchemas) ? parsed.objectSchemas : (Array.isArray(parsed?.values) ? parsed.values : []));
  const id = list[0]?.id;
  return id != null ? String(id) : null;
}
