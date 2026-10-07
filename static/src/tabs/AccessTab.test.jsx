import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { AccessTab, HOLDER_ROW_LIMIT, emptyRoleProjects } from "./AccessTab";

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

const inventory = (over = {}) => ({
  neverBuilt: false,
  state: "ready",
  staleBuild: false,
  version: "v1",
  refreshedAt: new Date().toISOString(),
  permissions: {
    schemes: [
      { id: "1", name: "Prod permissions", description: "", isDefault: false, defaultLevelId: null, projectCount: 12 },
      { id: "2", name: "Default Permission Scheme", description: "", isDefault: true, defaultLevelId: null, projectCount: 3 },
      { id: "3", name: "Legacy open", description: "", isDefault: false, defaultLevelId: null, projectCount: 0 },
    ],
    holders: [
      { schemeId: "3", context: "BROWSE_PROJECTS", contextLabel: "Browse Projects", holderType: "anyone", holderValue: "", holderLabel: null },
      { schemeId: "1", context: "ADMINISTER_PROJECTS", contextLabel: "Administer Projects", holderType: "group", holderValue: "g-1", holderLabel: "site-admins" },
    ],
    governance: {
      available: true, totalSchemes: 3, unusedSchemeCount: 1, riskySchemeCount: 1,
      directUserGrantCount: 0, offRosterUserGrantCount: 0,
      unusedSchemes: [{ id: "3", name: "Legacy open" }],
      riskySchemes: [{ id: "3", name: "Legacy open", reasons: ["browse open to anyone (public)"] }],
    },
  },
  security: {
    schemes: [
      { id: "s1", name: "Restricted", description: "", isDefault: false, defaultLevelId: "L1", projectCount: 4 },
      { id: "s2", name: "Empty scheme", description: "", isDefault: false, defaultLevelId: null, projectCount: 0 },
    ],
    levels: [
      { schemeId: "s1", id: "L1", name: "Internal", description: "", isDefault: true },
      { schemeId: "s1", id: "L2", name: "Nobody", description: "", isDefault: false },
    ],
    holders: [
      { schemeId: "s1", context: "L1", contextLabel: "Internal", holderType: "group", holderValue: "g-staff", holderLabel: "staff" },
    ],
    governance: {
      available: true, totalSchemes: 2, totalLevels: 2, unusedSchemeCount: 1,
      noLevelSchemeCount: 1, emptyLevelCount: 1, offRosterMemberCount: 0,
      unusedSchemes: [{ id: "s2", name: "Empty scheme" }],
      emptyLevels: [{ schemeId: "s1", schemeName: "Restricted", levelId: "L2", levelName: "Nobody" }],
    },
  },
  notifications: {
    schemes: [
      { id: "n1", name: "Prod notifications", description: "", isDefault: false, defaultLevelId: null, projectCount: 8 },
      { id: "n2", name: "Default Notification Scheme", description: "", isDefault: true, defaultLevelId: null, projectCount: 2 },
    ],
    holders: [
      { schemeId: "n1", context: "1", contextLabel: "Issue Created", holderType: "user", holderValue: "acc-1", holderLabel: "Ann" },
    ],
    governance: {
      available: true, totalSchemes: 2, unusedSchemeCount: 0, fragileSchemeCount: 1, offRosterRecipientCount: 0,
      unusedSchemes: [],
      fragileSchemes: [{ id: "n1", name: "Prod notifications", namedUserCount: 1 }],
    },
  },
  roles: {
    schemes: [
      { id: "10002", name: "Administrators", description: "", projectCount: 1 },
      { id: "10003", name: "Members", description: "", projectCount: 2 },
    ],
    holders: [
      { schemeId: "10002", context: "1", contextLabel: "OPS", holderType: "group", holderValue: "g-admins", holderLabel: "site-admins" },
      { schemeId: "10002", context: "2", contextLabel: "DEV", holderType: "empty", holderValue: "", holderLabel: "Administrators" },
      { schemeId: "10003", context: "1", contextLabel: "OPS", holderType: "user", holderValue: "acc-1", holderLabel: "Ann" },
    ],
    governance: {
      available: true, totalRoles: 2, projectsWithRoles: 2, projectsMissingAdminActorCount: 1,
      offRosterActorCount: 0, directUserActorCount: 1,
      projectsMissingAdminActor: [{ projectKey: "DEV", role: "Administrators" }],
    },
  },
  lastError: null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("emptyRoleProjects", () => {
  // Counted from every holder row, not the 25-item governance sample, so a large site
  // reports the real number.
  test("lists every project where the role has no user or group actor", () => {
    const holders = [
      ...Array.from({ length: 40 }, (_, i) => ({ schemeId: "r1", context: String(i), contextLabel: `P${i}`, holderType: "empty" })),
      { schemeId: "r1", context: "0", contextLabel: "P0", holderType: "group", holderValue: "g" },
      { schemeId: "r2", context: "5", contextLabel: "P5", holderType: "empty" },
    ];
    const empty = emptyRoleProjects("r1", holders);
    expect(empty).toHaveLength(39);
    expect(empty).not.toContain("P0");
  });

  test("a role filled everywhere is empty nowhere", () => {
    expect(emptyRoleProjects("r1", [{ schemeId: "r1", context: "1", holderType: "user", holderValue: "a" }])).toEqual([]);
  });
});

describe("AccessTab", () => {
  test("reports never-built rather than an empty catalogue", async () => {
    invoke.mockImplementation((fn) => fn === "getAccessInventory"
      ? Promise.resolve({ neverBuilt: true, state: "idle", permissions: null, security: null, notifications: null })
      : Promise.resolve({}));
    render(<AccessTab />);
    expect(await screen.findByText(/No access inventory has been built yet/i)).toBeInTheDocument();
  });

  test("shows the headline stats and the combined findings", async () => {
    invoke.mockImplementation((fn) => fn === "getAccessInventory" ? Promise.resolve(inventory()) : Promise.resolve({}));
    render(<AccessTab />);

    expect(await screen.findByText("Access")).toBeInTheDocument();
    expect(screen.getByText("Permission schemes")).toBeInTheDocument();
    expect(screen.getByText("Least-privilege flags")).toBeInTheDocument();
    expect(screen.getByText("Empty admin roles")).toBeInTheDocument();
    expect(screen.getByText("Permission schemes that break least privilege")).toBeInTheDocument();
    expect(screen.getByText("Issue security levels nobody can see through")).toBeInTheDocument();
    expect(screen.getByText("Notification schemes routing to a named individual")).toBeInTheDocument();
    expect(screen.getByText("Projects nobody can administer")).toBeInTheDocument();
  });

  test("the Project roles view lists each role and flags the empty admin role", async () => {
    invoke.mockImplementation((fn) => fn === "getAccessInventory" ? Promise.resolve(inventory()) : Promise.resolve({}));
    render(<AccessTab />);
    await screen.findByText("Access");
    await userEvent.click(screen.getByRole("button", { name: /^Project roles/ }));

    expect(await screen.findByText("Administrators")).toBeInTheDocument();
    expect(screen.getByText("empty on 1 project")).toBeInTheDocument();
    // Members is filled on OPS and has no row elsewhere, so it carries no chip.
    expect(screen.getAllByText(/^empty on/)).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: /Administrators/ }));
    expect(await screen.findByText(/group: site-admins/i)).toBeInTheDocument();
  });

  test("permissions view lists schemes with their least-privilege flag and expands to the grants", async () => {
    invoke.mockImplementation((fn) => fn === "getAccessInventory" ? Promise.resolve(inventory()) : Promise.resolve({}));
    render(<AccessTab />);
    await screen.findByText("Access");
    await userEvent.click(screen.getByRole("button", { name: /^Permissions/ }));

    expect(await screen.findByText("Legacy open")).toBeInTheDocument();
    expect(screen.getByText("browse open to anyone (public)")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: /search permission schemes/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Prod permissions/ }));
    expect(await screen.findByText(/group: site-admins/i)).toBeInTheDocument();
  });

  // Past the row limit the list says how many it shows; it used to stop silently.
  test("says how many grants it is showing when a scheme has more than the row limit", async () => {
    const base = inventory();
    const many = Array.from({ length: HOLDER_ROW_LIMIT + 5 }, (_, i) => ({
      schemeId: base.permissions.schemes[0].id, context: "BROWSE_PROJECTS", contextLabel: "Browse Projects",
      holderType: "group", holderValue: `g${i}`, holderLabel: `group-${i}`,
    }));
    invoke.mockImplementation((fn) => fn === "getAccessInventory"
      ? Promise.resolve({ ...base, permissions: { ...base.permissions, holders: many } })
      : Promise.resolve({}));
    render(<AccessTab />);
    await screen.findByText("Access");
    await userEvent.click(screen.getByRole("button", { name: /^Permissions/ }));
    await userEvent.click(await screen.findByRole("button", { name: new RegExp(base.permissions.schemes[0].name) }));

    expect(await screen.findByText(new RegExp(`Showing ${HOLDER_ROW_LIMIT} of ${HOLDER_ROW_LIMIT + 5}`))).toBeInTheDocument();
  });

  test("security view flags a scheme with no levels and one with an empty level", async () => {
    invoke.mockImplementation((fn) => fn === "getAccessInventory" ? Promise.resolve(inventory()) : Promise.resolve({}));
    render(<AccessTab />);
    await screen.findByText("Access");
    await userEvent.click(screen.getByRole("button", { name: /^Issue security/ }));

    expect(await screen.findByText("Empty scheme")).toBeInTheDocument();
    expect(screen.getByText("no levels")).toBeInTheDocument();
    expect(screen.getByText("1 empty level")).toBeInTheDocument();
  });

  test("shows the three access pillars of the site health score on the overview", async () => {
    invoke.mockImplementation((fn, args) => {
      if (fn === "getAccessInventory") return Promise.resolve(inventory());
      if (fn === "getPillarHealth" && args?.pillar === "permissions") return Promise.resolve({
        pillar: {
          key: "permissions", available: true, score: 62, grade: "C", total: 2,
          dimensions: [{ key: "permission-least-privilege", label: "Least privilege", available: true, score: 40, detail: "1 of 3 schemes flagged." }],
        },
      });
      if (fn === "getPillarHealth" && args?.pillar === "security") return Promise.resolve({
        pillar: { key: "security", available: true, score: 55, grade: "D", total: 2,
          dimensions: [{ key: "security-level-integrity", label: "Level integrity", available: true, score: 30, detail: "levels broken." }] },
      });
      if (fn === "getPillarHealth" && args?.pillar === "notifications") return Promise.resolve({
        pillar: { key: "notifications", available: true, score: 80, grade: "B", total: 2,
          dimensions: [{ key: "notification-routing", label: "Routing resilience", available: true, score: 70, detail: "1 fragile." }] },
      });
      return Promise.resolve({});
    });
    render(<AccessTab />);

    await screen.findByText("Access");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("getPillarHealth", { pillar: "notifications" }));
    expect(await screen.findByText("Least privilege")).toBeInTheDocument();
    expect(screen.getByText("Level integrity")).toBeInTheDocument();
    expect(screen.getByText("Routing resilience")).toBeInTheDocument();
  });

  test("queues a build and reports it", async () => {
    invoke.mockImplementation((fn) => {
      if (fn === "getAccessInventory") return Promise.resolve(inventory());
      if (fn === "buildAccessInventory") return Promise.resolve({ queued: true });
      return Promise.resolve({});
    });
    render(<AccessTab />);

    await screen.findByText("Access");
    await userEvent.click(screen.getByRole("button", { name: /Rebuild/ }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("buildAccessInventory", {}));
    expect(await screen.findByText(/Build queued/i)).toBeInTheDocument();
  });
});
