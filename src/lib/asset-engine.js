// Builds the JSM Assets (CMDB) structure snapshot: object schemas, the object types they
// contain, and those types' attributes -- versioned.
//
//   schema -> object type (hierarchical) -> attribute
//
// STRUCTURE ONLY. Assets object counts run to hundreds of thousands on a real CMDB and are
// never crawled here: the schema-list payload carries a per-schema object total, and
// per-type "is this used at all" counts are a separate opt-in stage (AQL count queries).
// This build is a schema list plus two calls per schema -- well inside one consumer
// invocation for the 1-30 schemas a site actually has.
//
// Assets is not on the site: its REST API is on the api.atlassian.com gateway, reached with
// requestAtlassianJson. It also needs JSM Premium/Enterprise, so "not reachable" is a
// first-class outcome the pillar renders as "Assets is not enabled here", exactly as the
// automation pillar does for the missing rules API -- never as an empty catalog.

import { logger } from "./logger.js";
import { inventorySnapshotQueue } from "./queues.js";
import {
  incrMetric,
  METRIC_NAMES,
  mapWithConcurrency,
  getAssetsWorkspaceId,
  requestAtlassianJson,
} from "./jira-api.js";
import {
  ensureProjectStoreReady,
  writeAssetSnapshotMeta,
  readAssetSnapshotMeta,
  replaceAssetSnapshot,
} from "./project-store.js";

// Matches ISSUE_TYPE_BUILD_STALE_MS: the consumer ceiling is 900s, plus a minute so a build
// finishing right at the limit is never declared stale out from under itself.
export const ASSET_BUILD_STALE_MS = 16 * 60 * 1000;

export function isAssetBuildStale(meta, now = Date.now()) {
  if (meta?.state !== "building") return false;
  const startedAt = Date.parse(meta?.startedAt || "");
  if (!Number.isFinite(startedAt)) return true;
  return now - startedAt > ASSET_BUILD_STALE_MS;
}

// Assets attribute `type` is a small integer enum. Only the object-reference case carries a
// governance signal this pillar acts on (a reference to a type that no longer exists is a
// broken pointer), so the rest collapse to readable labels and nothing more.
const ATTRIBUTE_TYPE_LABELS = {
  0: "default",
  1: "reference",
  2: "user",
  3: "confluence",
  4: "group",
  5: "version",
  6: "project",
  7: "status",
  8: "select",
};

// Relative to api.atlassian.com. requestAtlassian prepends the host.
function assetsBase(workspaceId) {
  return `/jsm/assets/workspace/${workspaceId}/v1`;
}

// A 401/403/404 from the gateway is "Assets is not enabled / not licensed here", not a bug.
// Anything else is a real failure and is rethrown so the build fails loudly.
function isAssetsUnavailable(error) {
  return [401, 403, 404].includes(Number(error?.status));
}

export function normalizeSchema(raw) {
  return {
    id: String(raw?.id),
    name: raw?.name || null,
    schemaKey: raw?.objectSchemaKey || raw?.key || null,
    description: raw?.description || null,
    objectTypeCount: Number(raw?.objectTypeCount) || 0,
    objectCount: Number(raw?.objectCount) || 0,
  };
}

export function normalizeObjectType(raw, schemaId) {
  return {
    id: String(raw?.id),
    schemaId: String(raw?.objectSchemaId ?? schemaId),
    name: raw?.name || null,
    description: raw?.description || null,
    parentId: raw?.parentObjectTypeId != null ? String(raw.parentObjectTypeId) : null,
    inherited: Boolean(raw?.inherited),
    abstract: Boolean(raw?.abstractObjectType),
  };
}

export function normalizeAttribute(raw, schemaId) {
  const typeCode = Number(raw?.type);
  const isReference = typeCode === 1;
  return {
    id: String(raw?.id),
    objectTypeId: raw?.objectType?.id != null ? String(raw.objectType.id) : null,
    schemaId: String(schemaId),
    name: raw?.name || null,
    dataType: ATTRIBUTE_TYPE_LABELS[typeCode]
      || raw?.defaultType?.name
      || (Number.isFinite(typeCode) ? `type-${typeCode}` : "unknown"),
    // Only set for an object-reference attribute: the object type it points at. A value not
    // in this snapshot's type set is a broken reference -- the Assets analogue of a filter
    // scoped to a deleted project.
    referenceObjectTypeId: isReference && raw?.referenceObjectTypeId != null
      ? String(raw.referenceObjectTypeId)
      : null,
    editable: raw?.editable !== false,
    system: Boolean(raw?.system),
  };
}

export async function queueAssetSnapshotBuild(installationKey) {
  await ensureProjectStoreReady();
  await writeAssetSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });
  await inventorySnapshotQueue.push({
    body: { jobType: "build-asset-snapshot", installationKey },
  });
}

export async function buildAssetSnapshot(installationKey) {
  incrMetric(METRIC_NAMES.assetSnapshotStarted);
  await ensureProjectStoreReady();
  await writeAssetSnapshotMeta(installationKey, {
    state: "building",
    startedAt: new Date().toISOString(),
    lastError: null,
  });

  try {
    const workspaceId = await getAssetsWorkspaceId().catch((error) => {
      if (isAssetsUnavailable(error)) return null;
      throw error;
    });

    if (!workspaceId) {
      return finishUnavailable(installationKey,
        "This site has no Assets workspace — Assets (JSM Premium/Enterprise) is not enabled here.");
    }

    const base = assetsBase(workspaceId);
    const version = String(Date.now());

    let rawSchemas;
    try {
      const listed = await requestAtlassianJson(`${base}/objectschema/list`);
      rawSchemas = Array.isArray(listed) ? listed : (listed?.values || listed?.objectSchemas || []);
    } catch (error) {
      if (isAssetsUnavailable(error)) {
        return finishUnavailable(installationKey,
          `The Assets API returned ${error.status} — Assets is not enabled or the app is not authorised for it here.`);
      }
      throw error;
    }

    const schemas = rawSchemas.filter((s) => s?.id != null).map(normalizeSchema);

    // Two calls per schema: the flat object-type list and the schema's attribute list. Both
    // are per-schema in the Assets API. Concurrency 3 keeps a 20-schema site to ~7 waves
    // without leaning on the shared rate limiter.
    const perSchema = await mapWithConcurrency(schemas, 3, async (schema) => {
      const [rawTypes, rawAttrs] = await Promise.all([
        requestAtlassianJson(`${base}/objectschema/${schema.id}/objecttypes/flat`).catch(() => []),
        requestAtlassianJson(`${base}/objectschema/${schema.id}/attributes`).catch(() => []),
      ]);
      const typeList = Array.isArray(rawTypes) ? rawTypes : (rawTypes?.values || []);
      const attrList = Array.isArray(rawAttrs) ? rawAttrs : (rawAttrs?.values || []);
      return {
        objectTypes: typeList.filter((t) => t?.id != null).map((t) => normalizeObjectType(t, schema.id)),
        attributes: attrList.filter((a) => a?.id != null).map((a) => normalizeAttribute(a, schema.id)),
      };
    });

    const objectTypes = perSchema.flatMap((r) => r.objectTypes);
    const attributes = perSchema.flatMap((r) => r.attributes);

    await replaceAssetSnapshot(installationKey, version, { schemas, objectTypes, attributes });

    const completedAt = new Date().toISOString();
    await writeAssetSnapshotMeta(installationKey, {
      state: "ready",
      version,
      completedAt,
      refreshedAt: completedAt,
      workspaceId,
      assetsEnabled: true,
      totalSchemas: schemas.length,
      totalObjectTypes: objectTypes.length,
      totalAttributes: attributes.length,
      lastError: null,
    });

    incrMetric(METRIC_NAMES.assetSnapshotCompleted);
    logger.info("asset-snapshot.completed", {
      version, workspaceId,
      schemas: schemas.length, objectTypes: objectTypes.length, attributes: attributes.length,
    });
    return { version, schemas: schemas.length, objectTypes: objectTypes.length, attributes: attributes.length };
  } catch (error) {
    incrMetric(METRIC_NAMES.assetSnapshotFailed);
    const message = String(error?.message || error);
    logger.error("asset-snapshot.failed", { error: message });
    await writeAssetSnapshotMeta(installationKey, {
      state: "failed",
      completedAt: new Date().toISOString(),
      lastError: message,
    });
    throw error;
  }
}

// A clean terminal state that is neither "ready" nor "failed": the build ran fine and the
// answer is "there is nothing to govern here". The tab reads `assetsEnabled` to show the
// explanation rather than an empty catalogue, and the health score treats the pillar as
// not-applicable rather than scoring it zero.
async function finishUnavailable(installationKey, reason) {
  incrMetric(METRIC_NAMES.assetSnapshotCompleted);
  const completedAt = new Date().toISOString();
  await writeAssetSnapshotMeta(installationKey, {
    state: "unavailable",
    completedAt,
    refreshedAt: completedAt,
    assetsEnabled: false,
    totalSchemas: 0,
    totalObjectTypes: 0,
    totalAttributes: 0,
    lastError: reason,
  });
  logger.info("asset-snapshot.unavailable", { reason });
  return { unavailable: true, reason };
}
