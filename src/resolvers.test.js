import { describe, test, expect } from "vitest";
import { ADMIN_ONLY_FUNCTIONS } from "./resolvers.js";

const { saveReportDefinition, startProjectUsageReportJob } = ADMIN_ONLY_FUNCTIONS;

function manyFieldIds(count) {
  return Array.from({ length: count }, (_, i) => `customfield_${i}`);
}

// These two functions validate fieldIds as their very first step, before any
// Forge/DB calls -- so the "still enforces a minimum" cases can assert directly.
// The "cap removed" cases can't be asserted via a clean resolve (that would need
// mocking the full storage/queue stack), so instead they assert the specific
// capped-length error message is gone, whatever else happens downstream.
describe("saveReportDefinition field count validation", () => {
  test("still rejects an empty fieldIds array", async () => {
    await expect(saveReportDefinition({ payload: { name: "Test", fieldIds: [] }, context: {} }))
      .rejects.toThrow(/fieldIds must contain at least 1 element/);
  });

  test("no longer rejects more than 100 fieldIds", async () => {
    try {
      await saveReportDefinition({ payload: { name: "Test", fieldIds: manyFieldIds(150) }, context: {} });
    } catch (err) {
      expect(err.message).not.toMatch(/between 1 and 100/);
    }
  });
});

describe("startProjectUsageReportJob field count validation", () => {
  test("still rejects an empty fieldIds array", async () => {
    await expect(startProjectUsageReportJob({ payload: { fieldIds: [] }, context: {} }))
      .rejects.toThrow(/fieldIds must contain at least 1 element/);
  });

  test("no longer rejects more than 200 fieldIds", async () => {
    try {
      await startProjectUsageReportJob({ payload: { fieldIds: manyFieldIds(250) }, context: {} });
    } catch (err) {
      expect(err.message).not.toMatch(/between 1 and 200/);
    }
  });
});
