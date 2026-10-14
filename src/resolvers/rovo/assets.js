// Rovo actions. Assets expert (observatory-assets-expert): schemas, object types and references.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import { incrMetric, METRIC_NAMES } from "../../lib/jira-api.js";
import {
  pillarUnavailable,
  agentOk,
  agentNotFound,
  rankMatches,
  clampResults,
} from "../../lib/rovo-agents.js";
import { getAssetInventory } from "../assets.js";

// ── Rovo: assets (CMDB) expert ──────────────────────────────────────────────
//
// Object schemas, hierarchical object types and their attributes, over getAssetInventory.

export async function rovoAssetSearch(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const query = String(payload?.query || "").trim();
    const kind = String(payload?.kind || "any").trim().toLowerCase();
    const limit = clampResults(payload?.maxResults, 8, 20);
    if (!query) return { status: "error", message: "A search query is required." };

    const inv = await getAssetInventory({ context });
    if (inv.state === "unavailable" || inv.assetsEnabled === false) {
      return { status: "assets-not-enabled", message: "JSM Assets is not enabled on this site (it needs JSM Premium or Enterprise), so there is no object structure to search." };
    }
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("assets", { state: inv.state, refreshedAt: null });

    const schemas = kind === "type" ? [] : rankMatches(inv.schemas, query, (s) => [s.name, s.objectSchemaKey, s.key], limit);
    const types = kind === "schema" ? [] : rankMatches(inv.objectTypes, query, (t) => [t.name], limit);

    return agentOk(inv.refreshedAt || null, {
      query,
      schemas: schemas.map((s) => ({ id: s.id, name: s.name, key: s.objectSchemaKey || s.key || null, objectTypeCount: s.objectTypeCount ?? null })),
      objectTypes: types.map((t) => ({ id: t.id, name: t.name, schemaId: t.objectSchemaId ?? t.schemaId ?? null, parentId: t.parentObjectTypeId ?? t.parentId ?? null })),
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoAssetSearch failed:", error);
    throw error;
  }
}

export async function rovoAssetInspect(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const identifier = String(payload?.identifier || "").trim();
    if (!identifier) return { status: "error", message: "An object schema or object type name is required." };
    const inv = await getAssetInventory({ context });
    if (inv.state === "unavailable" || inv.assetsEnabled === false) {
      return { status: "assets-not-enabled", message: "JSM Assets is not enabled on this site." };
    }
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("assets", { state: inv.state, refreshedAt: null });
    const idLower = identifier.toLowerCase();

    const schema = (inv.schemas || []).find((s) => String(s.id) === identifier || String(s.name || "").toLowerCase() === idLower);
    if (schema) {
      const types = (inv.objectTypes || []).filter((t) => String(t.objectSchemaId ?? t.schemaId) === String(schema.id));
      return agentOk(inv.refreshedAt || null, {
        kind: "schema",
        schema: { id: schema.id, name: schema.name, key: schema.objectSchemaKey || schema.key || null },
        objectTypes: types.slice(0, 100).map((t) => ({ id: t.id, name: t.name, parentId: t.parentObjectTypeId ?? t.parentId ?? null })),
        objectTypeCount: types.length,
      });
    }

    const type = (inv.objectTypes || []).find((t) => String(t.id) === identifier || String(t.name || "").toLowerCase() === idLower);
    if (!type) return agentNotFound(inv.refreshedAt || null, `No object schema or object type matched "${identifier}".`);

    const attrs = (inv.attributes || []).filter((a) => String(a.objectTypeId ?? a.typeId) === String(type.id));
    const children = (inv.objectTypes || []).filter((t) => String(t.parentObjectTypeId ?? t.parentId) === String(type.id));
    const referencedBy = (inv.attributes || []).filter((a) => String(a.referenceObjectTypeId ?? a.referenceTypeId) === String(type.id));

    return agentOk(inv.refreshedAt || null, {
      kind: "type",
      objectType: { id: type.id, name: type.name, schemaId: type.objectSchemaId ?? type.schemaId ?? null, parentId: type.parentObjectTypeId ?? type.parentId ?? null },
      attributes: attrs.slice(0, 100).map((a) => ({ name: a.name, type: a.type || a.dataType || null, referenceType: a.referenceObjectTypeName || null })),
      attributeCount: attrs.length,
      childTypes: children.map((c) => ({ id: c.id, name: c.name })),
      referencedByAttributeCount: referencedBy.length,
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoAssetInspect failed:", error);
    throw error;
  }
}

export async function rovoAssetImpact(payload, context) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const name = String(payload?.name || "").trim();
    if (!name) return { status: "error", message: "An object type name is required." };
    const inv = await getAssetInventory({ context });
    if (inv.state === "unavailable" || inv.assetsEnabled === false) {
      return { status: "assets-not-enabled", message: "JSM Assets is not enabled on this site." };
    }
    if (inv.neverBuilt || !inv.version) return pillarUnavailable("assets", { state: inv.state, refreshedAt: null });

    const type = (inv.objectTypes || []).find((t) => String(t.name || "").toLowerCase() === name.toLowerCase());
    if (!type) return agentNotFound(inv.refreshedAt || null, `No object type named "${name}" was found.`);

    const children = (inv.objectTypes || []).filter((t) => String(t.parentObjectTypeId ?? t.parentId) === String(type.id));
    const referencingAttrs = (inv.attributes || []).filter((a) => String(a.referenceObjectTypeId ?? a.referenceTypeId) === String(type.id));

    return agentOk(inv.refreshedAt || null, {
      objectType: { id: type.id, name: type.name },
      childTypes: children.map((c) => ({ id: c.id, name: c.name })),
      childTypeCount: children.length,
      referencedByAttributes: referencingAttrs.slice(0, 100).map((a) => ({ attribute: a.name, onType: a.objectTypeName || a.objectTypeId })),
      referencedByAttributeCount: referencingAttrs.length,
      verdict: children.length === 0 && referencingAttrs.length === 0 ? "nothing-references-it" : "referenced",
      verdictCaveat:
        "This covers the object type hierarchy and reference attributes within Assets. It does not cover the objects themselves, Assets automation, or object-reference custom fields on Jira issues.",
    });
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("rovoAssetImpact failed:", error);
    throw error;
  }
}
