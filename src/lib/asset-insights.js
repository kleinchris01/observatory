// Governance findings over the JSM Assets structure snapshot: schemas nothing lives in,
// object types whose parent is gone, reference attributes pointing at a type that no longer
// exists, and types carrying no attribute anyone added.
//
// Pure functions over already-loaded rows, like issuetype-insights.js: no I/O. The same
// "is this config dead / broken / unused" thesis as Fields and Issue Types, on the CMDB.

// A schema is dead when nothing is modelled in it: no object types defined, or types
// defined but zero objects of any of them. Both mean "a schema an admin can delete".
export function findDeadSchemas(schemas = []) {
  return schemas
    .filter((s) => (Number(s.objectTypeCount) || 0) === 0 || (Number(s.objectCount) || 0) === 0)
    .map((s) => ({
      id: String(s.id),
      name: s.name,
      reason: (Number(s.objectTypeCount) || 0) === 0 ? "no object types" : "no objects",
      objectTypeCount: Number(s.objectTypeCount) || 0,
      objectCount: Number(s.objectCount) || 0,
    }))
    .sort((l, r) => String(l.name).localeCompare(String(r.name)));
}

// Object types whose parent_id resolves to nothing in the same snapshot -- a hierarchy with
// a missing rung. Every child under it inherits attributes from a type that is not there.
export function findBrokenHierarchy(objectTypes = []) {
  const byId = new Set(objectTypes.map((t) => String(t.id)));
  return objectTypes
    .filter((t) => t.parentId != null && !byId.has(String(t.parentId)))
    .map((t) => ({ id: String(t.id), name: t.name, schemaId: String(t.schemaId), parentId: String(t.parentId) }))
    .sort((l, r) => String(l.name).localeCompare(String(r.name)));
}

// Object-reference attributes whose target object type is not in the catalogue -- the Assets
// analogue of a filter scoped to a deleted project. The attribute still renders on the
// object; picking a value for it either fails or offers nothing.
export function findBrokenReferences(attributes = [], objectTypes = []) {
  const byId = new Set(objectTypes.map((t) => String(t.id)));
  return attributes
    .filter((a) => a.referenceObjectTypeId != null && !byId.has(String(a.referenceObjectTypeId)))
    .map((a) => ({
      id: String(a.id),
      name: a.name,
      objectTypeId: a.objectTypeId != null ? String(a.objectTypeId) : null,
      referenceObjectTypeId: String(a.referenceObjectTypeId),
    }))
    .sort((l, r) => String(l.name).localeCompare(String(r.name)));
}

// Non-abstract object types with no attribute anyone added -- only the built-in Name (and
// whatever it inherits). A concrete type nobody gave a single field to is either unfinished
// or abandoned.
export function findBareTypes(objectTypes = [], attributes = []) {
  const customCountByType = new Map();
  for (const attr of attributes) {
    if (attr.system) continue;
    if (attr.objectTypeId == null) continue;
    const key = String(attr.objectTypeId);
    customCountByType.set(key, (customCountByType.get(key) || 0) + 1);
  }
  return objectTypes
    .filter((t) => !t.abstract && (customCountByType.get(String(t.id)) || 0) === 0)
    .map((t) => ({ id: String(t.id), name: t.name, schemaId: String(t.schemaId) }))
    .sort((l, r) => String(l.name).localeCompare(String(r.name)));
}

// Concrete object types the AQL crawl measured at zero live objects -- a type that is
// defined, has attributes, and has never been populated. Distinct from findBareTypes: a bare
// type has no fields, an empty type has fields but no data ever entered against them. Only
// types the crawl actually measured are considered; one it could not reach stays unmeasured
// rather than being counted as empty, the same rule every other tri-state signal here follows.
export function findEmptyObjectTypes(objectTypes = [], typeCounts = []) {
  const countByType = new Map(typeCounts.map((c) => [String(c.objectTypeId), Number(c.objectCount) || 0]));
  return objectTypes
    .filter((t) => !t.abstract && countByType.get(String(t.id)) === 0)
    .map((t) => ({ id: String(t.id), name: t.name, schemaId: String(t.schemaId) }))
    .sort((l, r) => String(l.name).localeCompare(String(r.name)));
}

// Everything the pillar reports, as counts a rate can be built from.
//
// `schemas` carry { id, name, objectTypeCount, objectCount }. `objectTypes` carry
// { id, schemaId, name, parentId, abstract }. `attributes` carry
// { id, objectTypeId, name, referenceObjectTypeId, system }. `typeCounts`, from the separate
// opt-in AQL crawl, carry { objectTypeId, objectCount } -- one entry per type it managed to
// measure, absent entirely until that crawl has ever run.
export function summarizeAssetInsights({
  schemas = [],
  objectTypes = [],
  attributes = [],
  typeCounts = [],
  assetsEnabled = true,
} = {}) {
  const deadSchemas = findDeadSchemas(schemas);
  const brokenHierarchy = findBrokenHierarchy(objectTypes);
  const brokenReferences = findBrokenReferences(attributes, objectTypes);
  const bareTypes = findBareTypes(objectTypes, attributes);
  const emptyObjectTypes = findEmptyObjectTypes(objectTypes, typeCounts);
  const referenceAttributes = attributes.filter((a) => a.referenceObjectTypeId != null).length;
  const concreteObjectTypes = objectTypes.filter((t) => !t.abstract);
  const measuredTypeIds = new Set(typeCounts.map((c) => String(c.objectTypeId)));
  const measuredConcreteTypes = concreteObjectTypes.filter((t) => measuredTypeIds.has(String(t.id))).length;

  return {
    // Tri-state like every other pillar. `assetsEnabled: false` is a fourth, distinct
    // state: the build ran and Assets is simply not licensed on this site.
    available: assetsEnabled && schemas.length > 0,
    assetsEnabled,
    totalSchemas: schemas.length,
    totalObjectTypes: objectTypes.length,
    concreteObjectTypes: concreteObjectTypes.length,
    totalAttributes: attributes.length,
    referenceAttributeCount: referenceAttributes,
    deadSchemaCount: deadSchemas.length,
    brokenHierarchyCount: brokenHierarchy.length,
    brokenReferenceCount: brokenReferences.length,
    bareTypeCount: bareTypes.length,
    // Object counts are a separate opt-in crawl; countsMeasured tells the tab and the score
    // whether it has ever run, rather than reading a zero measuredConcreteTypes as "every
    // type is empty".
    countsMeasured: typeCounts.length > 0,
    measuredConcreteTypes,
    emptyObjectTypeCount: emptyObjectTypes.length,
    // The worst few of each, for the tab. Full lists stay where they are built.
    deadSchemas: deadSchemas.slice(0, 25),
    brokenHierarchy: brokenHierarchy.slice(0, 25),
    brokenReferences: brokenReferences.slice(0, 25),
    bareTypes: bareTypes.slice(0, 50),
    emptyObjectTypes: emptyObjectTypes.slice(0, 50),
  };
}

// The counts the site health score takes from this pillar. computeSiteHealth scores the
// Assets dimensions straight from these, each against its own tolerance.
export function summarizeAssetHealth(summary) {
  if (!summary?.assetsEnabled) return { available: false, assetsEnabled: false };
  if (!summary?.available) return { available: false, assetsEnabled: true };
  return {
    available: true,
    assetsEnabled: true,
    totalSchemas: summary.totalSchemas,
    deadSchemaCount: summary.deadSchemaCount,
    concreteObjectTypes: summary.concreteObjectTypes,
    bareTypeCount: summary.bareTypeCount,
    brokenHierarchyCount: summary.brokenHierarchyCount,
    referenceAttributeCount: summary.referenceAttributeCount,
    brokenReferenceCount: summary.brokenReferenceCount,
    countsMeasured: summary.countsMeasured,
    measuredConcreteTypes: summary.measuredConcreteTypes,
    emptyObjectTypeCount: summary.emptyObjectTypeCount,
  };
}
