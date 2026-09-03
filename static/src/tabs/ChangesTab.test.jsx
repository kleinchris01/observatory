import React from "react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { ChangesTab } from "./ChangesTab";

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

const TRACKED = [
  { key: "fields", label: "Fields" },
  { key: "workflow", label: "Workflows" },
  { key: "access", label: "Access" },
];

const history = (over = {}) => ({
  neverBuilt: false,
  state: "ready",
  staleBuild: false,
  refreshedAt: new Date().toISOString(),
  lastRunChanges: 3,
  totalChanges: 40,
  seededPillars: ["fields", "workflow", "access"],
  trackedPillars: TRACKED,
  windowDays: 30,
  changes: [
    { changeId: "v2-0", detectedAt: "2026-09-03T09:00:00Z", pillar: "access", entityType: "permission-scheme", entityId: "1", label: "Prod", changeKind: "modified", summary: 'Permission scheme "Prod" changed: name' },
    { changeId: "v2-1", detectedAt: "2026-09-03T09:00:00Z", pillar: "workflow", entityType: "status", entityId: "9", label: "In Review", changeKind: "added", summary: 'Status "In Review" added' },
    { changeId: "v1-4", detectedAt: "2026-09-01T12:00:00Z", pillar: "fields", entityType: "field", entityId: "customfield_5", label: "Story Points", changeKind: "removed", summary: 'Field "Story Points" removed' },
  ],
  nextCursor: null,
  summary: { total: 8, byPillar: { access: 3, workflow: 4, fields: 1 }, byKind: { added: 4, removed: 1, modified: 3 } },
  lastError: null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("ChangesTab", () => {
  test("reports never-built and names the tracked pillars", async () => {
    invoke.mockImplementation((fn) => fn === "getChangeHistory"
      ? Promise.resolve({ neverBuilt: true, state: "idle", changes: [], trackedPillars: TRACKED, summary: { total: 0, byKind: { added: 0, removed: 0, modified: 0 } } })
      : Promise.resolve({}));
    render(<ChangesTab />);
    expect(await screen.findByText(/No drift pass has run yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Fields, Workflows, Access/)).toBeInTheDocument();
  });

  test("renders the day-grouped timeline with a kind chip per change", async () => {
    invoke.mockImplementation((fn) => fn === "getChangeHistory" ? Promise.resolve(history()) : Promise.resolve({}));
    render(<ChangesTab />);

    expect(await screen.findByText("Changes")).toBeInTheDocument();
    expect(screen.getByText('Permission scheme "Prod" changed: name')).toBeInTheDocument();
    expect(screen.getByText('Status "In Review" added')).toBeInTheDocument();
    expect(screen.getByText('Field "Story Points" removed')).toBeInTheDocument();
    // Two calendar-day groups.
    expect(screen.getByText("2026-09-03")).toBeInTheDocument();
    expect(screen.getByText("2026-09-01")).toBeInTheDocument();
    // Trailing-window summary tiles.
    expect(screen.getByText(/Changes · last 30d/)).toBeInTheDocument();
  });

  test("re-queries when the pillar filter changes", async () => {
    invoke.mockImplementation((fn) => fn === "getChangeHistory" ? Promise.resolve(history()) : Promise.resolve({}));
    render(<ChangesTab />);
    await screen.findByText("Changes");

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Pillar" }), "access");

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("getChangeHistory", { pillar: "access", kind: "all" }));
  });

  test("loads an older page through the keyset cursor", async () => {
    invoke.mockImplementation((fn, args) => {
      if (fn !== "getChangeHistory") return Promise.resolve({});
      if (args?.before === "2026-09-01T12:00:00Z") {
        return Promise.resolve(history({
          changes: [{ changeId: "v0-1", detectedAt: "2026-08-20T00:00:00Z", pillar: "access", entityType: "permission-grant", entityId: "x", label: "y", changeKind: "added", summary: "Permission grant added" }],
          nextCursor: null,
        }));
      }
      return Promise.resolve(history({ nextCursor: "2026-09-01T12:00:00Z" }));
    });
    render(<ChangesTab />);
    await screen.findByText("Changes");

    await userEvent.click(screen.getByRole("button", { name: /Load older changes/i }));

    expect(await screen.findByText("Permission grant added")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("getChangeHistory", { pillar: "all", kind: "all", before: "2026-09-01T12:00:00Z" });
  });

  test("queues a drift pass and reports it", async () => {
    invoke.mockImplementation((fn) => {
      if (fn === "getChangeHistory") return Promise.resolve(history());
      if (fn === "buildChangeHistory") return Promise.resolve({ queued: true });
      return Promise.resolve({});
    });
    render(<ChangesTab />);
    await screen.findByText("Changes");

    await userEvent.click(screen.getByRole("button", { name: /Run drift pass/i }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("buildChangeHistory", {}));
    expect(await screen.findByText(/Drift pass queued/i)).toBeInTheDocument();
  });
});
