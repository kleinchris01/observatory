import { describe, test, expect } from "vitest";
import { analyzeFieldBehaviour, fingerprint, summarizeFieldConfigHealth } from "./fieldconfig-insights.js";

const item = (ownerKind, ownerId, fieldId, over = {}) => ({
  ownerKind, ownerId, workTypeId: "*", fieldId, associated: ownerKind === "scheme" ? true : null,
  hidden: ownerKind === "config" ? false : null, required: false, description: null, renderer: null, restrictedTo: [], ...over,
});

describe("fingerprint", () => {
  test("is stable for the same parts and differs for different ones", () => {
    expect(fingerprint(["a", "b"])).toBe(fingerprint(["a", "b"]));
    expect(fingerprint(["a", "b"])).not.toBe(fingerprint(["a", "c"]));
  });
});

describe("analyzeFieldBehaviour — legacy field configurations", () => {
  const model = {
    source: "field-configurations",
    schemes: [
      { id: "fcs:default", isDefault: true },
      { id: "fcs:1", isDefault: false },
      { id: "fcs:2", isDefault: false },
      { id: "fcs:3", isDefault: false },
    ],
    schemeProjects: [
      { schemeId: "fcs:default", projectId: "p0" },
      { schemeId: "fcs:1", projectId: "p1" },
      { schemeId: "fcs:2", projectId: "p2" },
    ],
    configs: [
      { id: "fc:d", isDefault: true, itemsRead: true },
      { id: "fc:a", isDefault: false, itemsRead: true },
      { id: "fc:b", isDefault: false, itemsRead: true },
      { id: "fc:orphan", isDefault: false, itemsRead: true },
      { id: "fc:unread", isDefault: false, itemsRead: false },
    ],
    mappings: [
      { schemeId: "fcs:default", workTypeId: "default", configId: "fc:d" },
      { schemeId: "fcs:1", workTypeId: "default", configId: "fc:a" },
      { schemeId: "fcs:2", workTypeId: "default", configId: "fc:b" },
      { schemeId: "fcs:3", workTypeId: "default", configId: "fc:unread" },
    ],
    items: [
      item("config", "fc:d", "customfield_1", { required: true }),
      // a and b are identical; a also requires a field it hides.
      item("config", "fc:a", "customfield_2", { required: true, hidden: true }),
      item("config", "fc:b", "customfield_2", { required: true, hidden: true }),
    ],
  };
  const result = analyzeFieldBehaviour(model);
  const config = (id) => result.configs.find((c) => c.id === id);
  const scheme = (id) => result.schemes.find((s) => s.id === id);

  test("an unused non-default scheme or configuration is flagged; defaults never are", () => {
    expect(scheme("fcs:3").codes).toContain("unused");
    expect(scheme("fcs:default").codes).not.toContain("unused");
    expect(config("fc:orphan").codes).toContain("unused");
    // fcs:3 is unused, so the configuration it routes to is unused too.
    expect(config("fc:unread").codes).toEqual(["unused", "unmeasured"]);
  });

  test("names the fields a configuration both requires and hides", () => {
    expect(config("fc:a").requiredHidden).toEqual(["customfield_2"]);
    expect(config("fc:a").codes).toContain("required-hidden");
    expect(config("fc:d").requiredHidden).toEqual([]);
  });

  test("groups identical configurations, and the schemes routing to them, keeping one", () => {
    const dupes = [config("fc:a"), config("fc:b")].filter((c) => c.codes.includes("duplicate"));
    expect(dupes).toHaveLength(1);
    expect(dupes[0].duplicateOf).toBeTruthy();
    // Two schemes routing "default" to identical configurations are the same scheme.
    expect([scheme("fcs:1"), scheme("fcs:2")].filter((s) => s.codes.includes("duplicate"))).toHaveLength(1);
  });

  test("a scheme routing to an unread configuration is unmeasured, not clean", () => {
    expect(scheme("fcs:3").measured).toBe(false);
    expect(scheme("fcs:3").print).toBeNull();
  });

  test("summarises every rate on what it could judge", () => {
    expect(result.summary).toMatchObject({
      source: "field-configurations",
      usageJudged: 7, unusedSchemes: 1, unusedConfigs: 2,
      conflictJudged: 4, requiredHiddenConfigs: 2, requiredHiddenPairs: 2,
      duplicateGroups: 2, reducible: 2, unmeasured: 2,
    });
  });

  test("finds fields required in one used configuration and optional in another", () => {
    expect(result.inconsistentRequired.map((r) => r.fieldId).sort()).toEqual(["customfield_1", "customfield_2"]);
  });
});

describe("analyzeFieldBehaviour — field schemes", () => {
  const model = {
    source: "field-schemes",
    schemes: [
      { id: "fs:1", isDefault: true, fieldsRead: true },
      { id: "fs:2", isDefault: false, fieldsRead: true },
      { id: "fs:3", isDefault: false, fieldsRead: true },
      { id: "fs:4", isDefault: false, fieldsRead: false },
    ],
    schemeProjects: [{ schemeId: "fs:1", projectId: "p1" }, { schemeId: "fs:2", projectId: "p2" }],
    items: [
      item("scheme", "fs:1", "customfield_1", { required: true }),
      item("scheme", "fs:1", "customfield_9", { restrictedTo: ["10001"] }),
      item("scheme", "fs:2", "customfield_1"),
      item("scheme", "fs:3", "customfield_1"),
      item("scheme", "fs:3", "customfield_1", { workTypeId: "10001", required: true }),
    ],
  };
  const result = analyzeFieldBehaviour(model);
  const scheme = (id) => result.schemes.find((s) => s.id === id);

  test("counts required and restricted fields per scheme", () => {
    expect(scheme("fs:1")).toMatchObject({ requiredCount: 1, restrictedCount: 1, used: true, measured: true });
  });

  test("never reports required-but-hidden, which field schemes cannot express", () => {
    expect(result.summary.conflictJudged).toBeNull();
    expect(result.summary.requiredHiddenConfigs).toBeNull();
  });

  test("a work-type override makes a scheme different from one without it", () => {
    expect(scheme("fs:2").print).not.toBe(scheme("fs:3").print);
    expect(result.summary.reducible).toBe(0);
  });

  test("an unread scheme is unmeasured and left out of the duplicate rate", () => {
    expect(scheme("fs:4").codes).toEqual(["unused", "unmeasured"]);
    expect(result.summary.duplicateJudged).toBe(3);
  });

  test("a field required in one used scheme and optional in another is inconsistent", () => {
    expect(result.inconsistentRequired).toEqual([{ fieldId: "customfield_1", requiredIn: 1, optionalIn: 1 }]);
  });
});

describe("summarizeFieldConfigHealth", () => {
  test("is unavailable without a build", () => {
    expect(summarizeFieldConfigHealth(null, null)).toEqual({ available: false });
    expect(summarizeFieldConfigHealth({ version: "v" }, null)).toEqual({ available: false });
  });

  test("carries the stored summary when there is one", () => {
    expect(summarizeFieldConfigHealth({ version: "v", refreshedAt: "t" }, { usageJudged: 3 }))
      .toEqual({ available: true, refreshedAt: "t", usageJudged: 3 });
  });
});
