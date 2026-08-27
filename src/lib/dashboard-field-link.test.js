import { describe, test, expect } from "vitest";
import { extractFilterId } from "./jira-api.js";

// A gadget's filter id, out of whatever shape Jira stored it in.
//
// This parser is the first leg of dashboard -> gadget -> filter -> field, and it fails in the
// worst possible way: a shape it does not recognise returns null, the gadget records "points
// at no filter", and the dependency graph gets a hole in it that nothing reports. A field card
// then says "no dashboard uses this field" — which is permission to delete it.
//
// So the shapes are pinned rather than discovered in production.
describe("gadget filter id", () => {
  test("reads the shapes Jira actually stores", () => {
    expect(extractFilterId(10123)).toBe("10123");
    expect(extractFilterId("10123")).toBe("10123");
    expect(extractFilterId("filter-10123")).toBe("10123");
    expect(extractFilterId({ filterId: 10123 })).toBe("10123");
    expect(extractFilterId({ filterId: "10123" })).toBe("10123");
  });

  // "config" is a container, not a value. Several first-party gadgets nest the real config one
  // level down, and a walker that only inspected value-shaped keys returned null for every one
  // of them — silently, and only for those gadgets.
  test("descends into a nested config object", () => {
    expect(extractFilterId({ config: { filterId: "10123" } })).toBe("10123");
    expect(extractFilterId({ config: "filter-99" })).toBe("99");
  });

  test("returns null rather than a guess when there is no filter in it", () => {
    // Null here means "this gadget references no filter", which is a real answer. It must not
    // be reachable by accident from a shape that does contain one.
    expect(extractFilterId(null)).toBeNull();
    expect(extractFilterId(undefined)).toBeNull();
    expect(extractFilterId({})).toBeNull();
    expect(extractFilterId({ color: "blue", refreshInterval: 15 })).toBeNull();
    expect(extractFilterId("jql=project = ADVEV")).toBeNull();
    expect(extractFilterId("")).toBeNull();
  });

  test("does not mistake another number in the string for a filter id", () => {
    // A bare number is a filter id; a number embedded in unrelated text is not.
    expect(extractFilterId("columns-3")).toBeNull();
    expect(extractFilterId("refresh-15-minutes")).toBeNull();
  });
});
