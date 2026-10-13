import { describe, test, expect } from "vitest";
import * as resolvers from "../resolvers.js";

// resolvers.js is being split into modules under src/resolvers/ (docs/resolvers-refactor.md).
// The failure a split can introduce is quiet: an import cycle that leaves a registry entry
// `undefined` at load time, so the resolver is registered as nothing and fails only when
// invoked. index.test.js cannot see it -- it mocks resolvers.js wholesale -- so this loads
// the real module and checks every entry.
describe("resolver registries (real module)", () => {
  const registries = {
    SHARED_RESOLVER_FUNCTIONS: resolvers.SHARED_RESOLVER_FUNCTIONS,
    ADMIN_ONLY_FUNCTIONS: resolvers.ADMIN_ONLY_FUNCTIONS,
    __RAW_ADMIN_ONLY_FUNCTIONS: resolvers.__RAW_ADMIN_ONLY_FUNCTIONS,
  };

  test.each(Object.entries(registries))("every entry in %s is a function", (_name, registry) => {
    const entries = Object.entries(registry);
    expect(entries.length).toBeGreaterThan(0);
    const notFunctions = entries.filter(([, fn]) => typeof fn !== "function").map(([key]) => key);
    expect(notFunctions).toEqual([]);
  });

  test("the guarded admin registry wraps exactly the raw registry", () => {
    expect(Object.keys(resolvers.ADMIN_ONLY_FUNCTIONS).sort()).toEqual(
      Object.keys(resolvers.__RAW_ADMIN_ONLY_FUNCTIONS).sort()
    );
  });

  test("no resolver is registered on both the macro and the admin-only registry", () => {
    const admin = new Set(Object.keys(resolvers.__RAW_ADMIN_ONLY_FUNCTIONS));
    expect(Object.keys(resolvers.SHARED_RESOLVER_FUNCTIONS).filter((k) => admin.has(k))).toEqual([]);
  });

  test("every named export resolves to a value", () => {
    const missing = Object.entries(resolvers).filter(([, v]) => v === undefined).map(([k]) => k);
    expect(missing).toEqual([]);
  });
});
