import { describe, test, expect } from "vitest";
import {
  findDeadSchemas,
  findBrokenHierarchy,
  findBrokenReferences,
  findBareTypes,
  summarizeAssetInsights,
  summarizeAssetHealth,
} from "./asset-insights.js";

describe("findDeadSchemas", () => {
  test("flags a schema with no object types and one with types but no objects", () => {
    const dead = findDeadSchemas([
      { id: "1", name: "Live", objectTypeCount: 5, objectCount: 200 },
      { id: "2", name: "NoTypes", objectTypeCount: 0, objectCount: 0 },
      { id: "3", name: "NoObjects", objectTypeCount: 3, objectCount: 0 },
    ]);
    expect(dead.map((s) => s.name)).toEqual(["NoObjects", "NoTypes"]);
    expect(dead.find((s) => s.name === "NoTypes").reason).toBe("no object types");
    expect(dead.find((s) => s.name === "NoObjects").reason).toBe("no objects");
  });
});

describe("findBrokenHierarchy", () => {
  test("flags an object type whose parent is not in the snapshot", () => {
    const broken = findBrokenHierarchy([
      { id: "9", name: "Server", parentId: null },
      { id: "10", name: "VM", parentId: "9" },
      { id: "11", name: "Orphan", parentId: "999" },
    ]);
    expect(broken.map((t) => t.name)).toEqual(["Orphan"]);
  });
});

describe("findBrokenReferences", () => {
  test("flags a reference attribute whose target type is gone", () => {
    const types = [{ id: "9", name: "Server" }];
    const broken = findBrokenReferences([
      { id: "1", name: "Runs on", referenceObjectTypeId: "9" },
      { id: "2", name: "Depends on", referenceObjectTypeId: "404" },
      { id: "3", name: "Hostname", referenceObjectTypeId: null },
    ], types);
    expect(broken.map((a) => a.name)).toEqual(["Depends on"]);
  });
});

describe("findBareTypes", () => {
  test("flags a concrete type with only system attributes, not an abstract one", () => {
    const types = [
      { id: "9", name: "Server", abstract: false },
      { id: "10", name: "Abstract base", abstract: true },
      { id: "11", name: "App", abstract: false },
    ];
    const attributes = [
      { id: "a", objectTypeId: "9", system: true },   // Server: only a system attr -> bare
      { id: "b", objectTypeId: "11", system: false },  // App: a real attr -> not bare
    ];
    expect(findBareTypes(types, attributes).map((t) => t.name)).toEqual(["Server"]);
  });
});

describe("summarizeAssetInsights", () => {
  const schemas = [
    { id: "1", name: "Infra", objectTypeCount: 3, objectCount: 100 },
    { id: "2", name: "Empty", objectTypeCount: 0, objectCount: 0 },
  ];
  const objectTypes = [
    { id: "9", schemaId: "1", name: "Server", parentId: null, abstract: false },
    { id: "10", schemaId: "1", name: "VM", parentId: "9", abstract: false },
    { id: "11", schemaId: "1", name: "Ghost child", parentId: "999", abstract: false },
  ];
  const attributes = [
    { id: "a", objectTypeId: "9", name: "OS", referenceObjectTypeId: null, system: false },
    { id: "b", objectTypeId: "10", name: "Host", referenceObjectTypeId: "9", system: false },
    { id: "c", objectTypeId: "10", name: "Broken", referenceObjectTypeId: "404", system: false },
  ];

  test("rolls the four findings into counts a rate can use", () => {
    const s = summarizeAssetInsights({ schemas, objectTypes, attributes, assetsEnabled: true });
    expect(s).toMatchObject({
      available: true,
      assetsEnabled: true,
      totalSchemas: 2,
      deadSchemaCount: 1,
      concreteObjectTypes: 3,
      totalAttributes: 3,
      referenceAttributeCount: 2,
      brokenReferenceCount: 1,
      brokenHierarchyCount: 1,
      // Server has an attr; VM has two; Ghost child has none -> one bare type.
      bareTypeCount: 1,
    });
  });

  test("is unavailable-but-enabled when the site has Assets but no schemas built", () => {
    const s = summarizeAssetInsights({ schemas: [], objectTypes: [], attributes: [], assetsEnabled: true });
    expect(s).toMatchObject({ available: false, assetsEnabled: true });
  });

  test("carries assetsEnabled: false straight through", () => {
    const s = summarizeAssetInsights({ assetsEnabled: false });
    expect(s).toMatchObject({ available: false, assetsEnabled: false, totalSchemas: 0 });
  });
});

describe("summarizeAssetHealth", () => {
  test("returns the score inputs when the pillar is available", () => {
    const summary = summarizeAssetInsights({
      schemas: [{ id: "1", name: "Infra", objectTypeCount: 2, objectCount: 10 }],
      objectTypes: [{ id: "9", schemaId: "1", name: "Server", parentId: null, abstract: false }],
      attributes: [{ id: "a", objectTypeId: "9", name: "OS", referenceObjectTypeId: null, system: false }],
      assetsEnabled: true,
    });
    expect(summarizeAssetHealth(summary)).toMatchObject({
      available: true, assetsEnabled: true, totalSchemas: 1, concreteObjectTypes: 1,
    });
  });

  test("reports not-applicable when Assets is not licensed", () => {
    expect(summarizeAssetHealth(summarizeAssetInsights({ assetsEnabled: false })))
      .toEqual({ available: false, assetsEnabled: false });
  });

  test("reports unmeasured (enabled) when Assets is on but nothing is built", () => {
    expect(summarizeAssetHealth(summarizeAssetInsights({ assetsEnabled: true })))
      .toEqual({ available: false, assetsEnabled: true });
  });
});
