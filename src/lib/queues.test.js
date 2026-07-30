import { describe, test, expect, vi } from "vitest";

// The queue key here must match the `queue` field on the consumer entry in
// manifest.yml exactly. A mismatch means messages are pushed to a queue nothing
// consumes -- jobs vanish silently with no error anywhere.

// vi.hoisted, not a plain const: vi.mock factories are lifted above normal
// declarations, and this one runs at import time when queues.js constructs the
// Queue -- a plain const would still be in its temporal dead zone.
const { constructedWith } = vi.hoisted(() => ({ constructedWith: [] }));

vi.mock("@forge/events", () => ({
  Queue: class {
    constructor(config) {
      constructedWith.push(config);
      this.config = config;
    }
  },
}));

import { inventorySnapshotQueue } from "./queues.js";

describe("inventorySnapshotQueue", () => {
  test("is constructed once at module load", () => {
    expect(constructedWith).toHaveLength(1);
  });

  test("uses the queue key declared in manifest.yml", () => {
    expect(constructedWith[0]).toEqual({ key: "inventory-snapshot-queue" });
  });

  test("exports a single shared queue instance", () => {
    expect(inventorySnapshotQueue).toBeDefined();
    expect(inventorySnapshotQueue.config.key).toBe("inventory-snapshot-queue");
  });
});
