import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { AssetsTab } from "./AssetsTab";

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

const inventory = (over = {}) => ({
  neverBuilt: false,
  state: "ready",
  assetsEnabled: true,
  staleBuild: false,
  version: "v1",
  workspaceId: "ws-1",
  refreshedAt: new Date().toISOString(),
  schemas: [
    { id: "1", name: "Infrastructure", schemaKey: "INFRA", objectTypeCount: 3, objectCount: 420 },
    { id: "2", name: "Abandoned", schemaKey: "OLD", objectTypeCount: 0, objectCount: 0 },
  ],
  objectTypes: [
    { id: "9", schemaId: "1", name: "Server", parentId: null, abstract: false },
    { id: "10", schemaId: "1", name: "Virtual Machine", parentId: "9", abstract: false },
    { id: "11", schemaId: "1", name: "Ghost", parentId: "999", abstract: false },
  ],
  attributes: [
    {
      id: "a",
      objectTypeId: "9",
      name: "Operating System",
      dataType: "default",
      referenceObjectTypeId: null,
      system: false,
    },
    {
      id: "b",
      objectTypeId: "10",
      name: "Hosted on",
      dataType: "reference",
      referenceObjectTypeId: "9",
      system: false,
    },
    {
      id: "c",
      objectTypeId: "10",
      name: "Depends on",
      dataType: "reference",
      referenceObjectTypeId: "404",
      system: false,
    },
  ],
  governance: {
    available: true,
    assetsEnabled: true,
    totalSchemas: 2,
    totalObjectTypes: 3,
    concreteObjectTypes: 3,
    totalAttributes: 3,
    referenceAttributeCount: 2,
    deadSchemaCount: 1,
    brokenReferenceCount: 1,
    brokenHierarchyCount: 1,
    bareTypeCount: 1,
    deadSchemas: [{ id: "2", name: "Abandoned" }],
    brokenReferences: [{ id: "c", name: "Depends on" }],
    brokenHierarchy: [{ id: "11", name: "Ghost" }],
    bareTypes: [{ id: "11", name: "Ghost" }],
  },
  lastError: null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("AssetsTab", () => {
  test("shows the 'not enabled' state as its own thing, not an error or an empty list", async () => {
    invoke.mockImplementation((fn) =>
      fn === "getAssetInventory"
        ? Promise.resolve({
            state: "unavailable",
            assetsEnabled: false,
            neverBuilt: false,
            schemas: [],
            governance: { assetsEnabled: false },
            lastError: "This site has no Assets workspace.",
          })
        : Promise.resolve({}),
    );
    render(<AssetsTab />);

    expect(await screen.findByText(/Assets is not enabled on this site/i)).toBeInTheDocument();
    expect(screen.getByText(/This site has no Assets workspace/i)).toBeInTheDocument();
  });

  test("reports never-built rather than an empty catalogue", async () => {
    invoke.mockImplementation((fn) =>
      fn === "getAssetInventory"
        ? Promise.resolve({ neverBuilt: true, state: "idle", assetsEnabled: null, schemas: [], governance: null })
        : Promise.resolve({}),
    );
    render(<AssetsTab />);
    expect(await screen.findByText(/No Assets inventory has been built yet/i)).toBeInTheDocument();
  });

  test("shows the structure totals and the governance findings", async () => {
    invoke.mockImplementation((fn) =>
      fn === "getAssetInventory" ? Promise.resolve(inventory()) : Promise.resolve({}),
    );
    render(<AssetsTab />);

    expect(await screen.findByText("Assets")).toBeInTheDocument();
    expect(screen.getByText("Object schemas")).toBeInTheDocument();
    expect(screen.getByText("Broken references")).toBeInTheDocument();
    // The findings panel spells out each problem.
    expect(screen.getByText("Object schemas with nothing in them")).toBeInTheDocument();
    expect(screen.getByText("Reference attributes pointing at a type that is gone")).toBeInTheDocument();
  });

  test("lists object types with their broken-parent and no-attributes flags", async () => {
    invoke.mockImplementation((fn) =>
      fn === "getAssetInventory" ? Promise.resolve(inventory()) : Promise.resolve({}),
    );
    render(<AssetsTab />);
    await screen.findByText("Assets");
    await userEvent.click(screen.getByRole("button", { name: /^Object types/ }));

    expect(await screen.findByText("Ghost")).toBeInTheDocument();
    expect(screen.getByText("broken parent")).toBeInTheDocument();
    // The type search box is the shared toolbar.
    expect(screen.getByRole("searchbox", { name: /search object types/i })).toBeInTheDocument();
  });

  test("flags the attribute whose reference target is gone", async () => {
    invoke.mockImplementation((fn) =>
      fn === "getAssetInventory" ? Promise.resolve(inventory()) : Promise.resolve({}),
    );
    render(<AssetsTab />);
    await screen.findByText("Assets");
    await userEvent.click(screen.getByRole("button", { name: /^Attributes/ }));

    expect(await screen.findByText("Depends on")).toBeInTheDocument();
    expect(screen.getByText("broken reference")).toBeInTheDocument();
  });

  test("shows the Assets pillar of the site health score on the overview", async () => {
    invoke.mockImplementation((fn) => {
      if (fn === "getAssetInventory") return Promise.resolve(inventory());
      if (fn === "getPillarHealth")
        return Promise.resolve({
          pillar: {
            key: "assets",
            available: true,
            score: 68,
            grade: "C",
            total: 3,
            dimensions: [
              {
                key: "asset-schema-hygiene",
                label: "Schema hygiene",
                available: true,
                score: 55,
                detail: "1 of 2 schemas are dead.",
              },
              {
                key: "asset-reference-integrity",
                label: "Reference integrity",
                available: true,
                score: 40,
                detail: "1 of 2 references are broken.",
              },
            ],
          },
        });
      return Promise.resolve({});
    });
    render(<AssetsTab />);

    await screen.findByText("Assets");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("getPillarHealth", { pillar: "assets" }));
    expect(await screen.findByText("Schema hygiene")).toBeInTheDocument();
    expect(screen.getByText("Reference integrity")).toBeInTheDocument();
  });

  test("queues a build and reports it", async () => {
    invoke.mockImplementation((fn) => {
      if (fn === "getAssetInventory") return Promise.resolve(inventory());
      if (fn === "buildAssetInventory") return Promise.resolve({ queued: true });
      return Promise.resolve({});
    });
    render(<AssetsTab />);

    await screen.findByText("Assets");
    await userEvent.click(screen.getByRole("button", { name: /Rebuild/ }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("buildAssetInventory", {}));
    expect(await screen.findByText(/Build queued/i)).toBeInTheDocument();
  });

  test("queues the object-count crawl and reports it", async () => {
    invoke.mockImplementation((fn) => {
      if (fn === "getAssetInventory") return Promise.resolve(inventory());
      if (fn === "buildAssetTypeCountCrawl") return Promise.resolve({ queued: true });
      return Promise.resolve({});
    });
    render(<AssetsTab />);

    await screen.findByText("Assets");
    await userEvent.click(screen.getByRole("button", { name: /Measure object counts/ }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("buildAssetTypeCountCrawl", {}));
    expect(await screen.findByText(/Object-count crawl queued/i)).toBeInTheDocument();
  });

  test("shows measured object counts on the type rows and the empty-type finding once the crawl has run", async () => {
    invoke.mockImplementation((fn) =>
      fn === "getAssetInventory"
        ? Promise.resolve(
            inventory({
              typeCounts: [
                { objectTypeId: "9", schemaId: "1", objectCount: 0 },
                { objectTypeId: "10", schemaId: "1", objectCount: 12 },
              ],
              typeCountCrawl: {
                state: "ready",
                refreshedAt: new Date().toISOString(),
                measuredTypes: 2,
                unmeasuredTypes: 0,
              },
              governance: {
                ...inventory().governance,
                countsMeasured: true,
                measuredConcreteTypes: 2,
                emptyObjectTypeCount: 1,
                emptyObjectTypes: [{ id: "9", name: "Server" }],
              },
            }),
          )
        : Promise.resolve({}),
    );
    render(<AssetsTab />);

    await screen.findByText("Assets");
    expect(screen.getByRole("button", { name: /Remeasure object counts/ })).toBeInTheDocument();
    expect(screen.getByText("Object types with attributes but never an object")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^Object types/ }));
    expect(await screen.findByText(/12 objects/)).toBeInTheDocument();
    expect(screen.getByText("empty")).toBeInTheDocument();
  });
});
