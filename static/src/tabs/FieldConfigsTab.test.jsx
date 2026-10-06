import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { FieldConfigsTab } from "./FieldConfigsTab";

// The tab must always say which model it read: field schemes and legacy field configurations
// answer different questions, and describing one with the other's words is how an admin goes
// looking for a "hidden" setting that does not exist.

function legacyInventory(over = {}) {
  return {
    state: "ready", neverBuilt: false, refreshedAt: "2026-10-05T10:00:00Z",
    source: "field-configurations", sourceLabel: "Field configurations (legacy)", fallbackReason: "404", unreadOwners: 1,
    summary: {
      source: "field-configurations", schemeCount: 2, configCount: 3, usageJudged: 4, unusedSchemes: 1, unusedConfigs: 1,
      duplicateJudged: 4, duplicateGroups: 1, reducible: 1, conflictJudged: 2, requiredHiddenConfigs: 1, requiredHiddenPairs: 2,
      unmeasured: 1, inconsistentRequiredFields: 1,
    },
    inconsistentRequired: [{ fieldId: "customfield_1", fieldName: "Total Cost", requiredIn: 1, optionalIn: 2 }],
    schemes: [
      { id: "fcs:default", name: "Default field configuration scheme", isDefault: true, projectCount: 3, projects: [{ projectKey: "OPS" }], codes: [], routes: [] },
      { id: "fcs:5", name: "Old scheme", isDefault: false, projectCount: 0, projects: [], codes: ["unused"], routes: [] },
    ],
    configs: [
      { id: "fc:1", name: "Default Field Configuration", isDefault: true, used: true, itemsRead: true, requiredCount: 1, codes: [], requiredHidden: [], routes: [{ schemeName: "Default field configuration scheme", workTypeName: "Default (unmapped work types)" }] },
      { id: "fc:2", name: "Build fields", isDefault: false, used: true, itemsRead: true, requiredCount: 3, codes: ["required-hidden", "duplicate"], duplicateOf: "fc:1", requiredHidden: [{ fieldId: "customfield_1", fieldName: "Total Cost" }], routes: [] },
      { id: "fc:3", name: "Orphan fields", isDefault: false, used: false, itemsRead: false, codes: ["unused", "unmeasured"], requiredHidden: [], routes: [] },
    ],
    ...over,
  };
}

const schemesInventory = () => legacyInventory({
  source: "field-schemes", sourceLabel: "Field schemes", fallbackReason: null, unreadOwners: 0,
  summary: { source: "field-schemes", schemeCount: 2, configCount: 0, usageJudged: 1, unusedSchemes: 0, unusedConfigs: 0, duplicateJudged: 2, duplicateGroups: 0, reducible: 0, conflictJudged: null },
  schemes: [{ id: "fs:1", name: "Default field scheme", isDefault: true, projectCount: 9, fieldCount: 120, requiredCount: 4, projects: [{ projectKey: "BLD" }], codes: [] }],
  configs: [],
});

function route(inventory) {
  invoke.mockImplementation(async (name) => {
    if (name === "getFieldConfigInventory") return inventory;
    if (name === "getPillarHealth") return { pillar: null };
    if (name === "getFieldConfigItems") return { available: true, total: 2, items: [
      { fieldId: "customfield_1", fieldName: "Total Cost", workTypeId: "*", workTypeName: "All work types", required: true, hidden: true, restrictedToNames: [] },
      { fieldId: "summary", fieldName: "Summary", workTypeId: "*", workTypeName: "All work types", required: true, hidden: false, restrictedToNames: [] },
    ] };
    if (name === "buildFieldConfigInventory") return { queued: true };
    return {};
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("FieldConfigsTab", () => {
  test("on a legacy site, says so, why field schemes were not read, and how many owners were not read", async () => {
    route(legacyInventory());
    render(<FieldConfigsTab />);
    expect(await screen.findByText(/This site uses/)).toHaveTextContent(/field configurations.*Field schemes were not available: 404.*1 could not be read/);
    expect(screen.getByText("Required but hidden").closest(".ui-stat")).toHaveClass("ui-stat--critical");
    expect(screen.getByRole("button", { name: /Field configurations/ })).toBeInTheDocument();
  });

  test("on field schemes, never mentions hiding and has no configurations view", async () => {
    route(schemesInventory());
    render(<FieldConfigsTab />);
    expect(await screen.findByText(/A field not in a project's scheme does not exist there/)).toBeInTheDocument();
    expect(screen.queryByText("Required but hidden")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Field configurations/ })).not.toBeInTheDocument();
  });

  test("the findings panel routes to the filtered list", async () => {
    const user = userEvent.setup();
    route(legacyInventory());
    render(<FieldConfigsTab />);
    const finding = (await screen.findByText("Fields required but hidden")).closest(".ui-finding");
    await user.click(within(finding).getByRole("button", { name: "Show" }));
    expect(await screen.findByText("Build fields")).toBeInTheDocument();
    expect(screen.queryByText("Default Field Configuration")).not.toBeInTheDocument();
    expect(screen.getByText("required but hidden")).toBeInTheDocument();
  });

  test("an Overview intent lands on the list it names, already filtered", async () => {
    route(legacyInventory());
    render(<FieldConfigsTab intent={{ view: "schemes", filter: "unused" }} />);
    expect(await screen.findByText("Old scheme")).toBeInTheDocument();
    expect(screen.queryByText("Default field configuration scheme")).not.toBeInTheDocument();
  });

  test("opening a configuration lists its fields and offers Ask Rovo about it", async () => {
    const user = userEvent.setup();
    route(legacyInventory());
    render(<FieldConfigsTab intent={{ view: "configs", filter: "all" }} />);
    await user.click(await screen.findByRole("button", { name: /Build fields/ }));
    expect(await screen.findByText("Total Cost")).toBeInTheDocument();
    expect(screen.getByText(/Only fields this configuration hides, requires or describes are listed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ask Rovo about this field configuration/ })).toBeInTheDocument();

    await user.click(screen.getByLabelText("Required only"));
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("getFieldConfigItems", expect.objectContaining({ ownerId: "fc:2", requiredOnly: true })));
  });

  test("never built offers the build, and the build queues it", async () => {
    const user = userEvent.setup();
    route({ state: "idle", neverBuilt: true, schemes: [], configs: [] });
    render(<FieldConfigsTab />);
    expect(await screen.findByText(/No field scheme inventory has been built yet/)).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /Build inventory/ })[0]);
    expect(invoke).toHaveBeenCalledWith("buildFieldConfigInventory", {});
    expect(await screen.findByText(/Build queued/)).toBeInTheDocument();
  });

  test("a build refused in read-only mode says why", async () => {
    const user = userEvent.setup();
    route(legacyInventory());
    invoke.mockImplementation(async (name) => (name === "buildFieldConfigInventory"
      ? { queued: false, error: "Read-only mode is enabled." }
      : name === "getFieldConfigInventory" ? legacyInventory() : { pillar: null }));
    render(<FieldConfigsTab />);
    await user.click(await screen.findByRole("button", { name: /Rebuild/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Read-only mode is enabled.");
  });
});
