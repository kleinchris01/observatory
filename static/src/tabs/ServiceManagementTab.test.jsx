import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { ServiceManagementTab } from "./ServiceManagementTab";

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
  rovo: { open: vi.fn() },
}));

const finding = (code, title, severity = "medium") => ({ code, title, severity, detail: `${title} detail` });

const inventory = (over = {}) => ({
  neverBuilt: false,
  jsmEnabled: true,
  state: "ready",
  staleBuild: false,
  refreshedAt: new Date().toISOString(),
  windowDays: 90,
  unreadCount: 0,
  lastError: null,
  desks: [
    {
      deskId: "1",
      projectKey: "SD",
      projectName: "IT Help",
      customerCount: 2000,
      customersComplete: false,
      orgCount: 1,
      portalGroupCount: 2,
    },
  ],
  requestTypes: [
    {
      deskId: "1",
      id: "10",
      name: "Laptop request",
      fieldCount: 5,
      requiredFieldCount: 2,
      recentCount: 30,
      findings: [],
    },
    {
      deskId: "1",
      id: "11",
      name: "Legacy form",
      fieldCount: null,
      requiredFieldCount: null,
      recentCount: null,
      findings: [finding("hidden", "Not on the portal")],
    },
  ],
  queues: [
    {
      deskId: "1",
      id: "7",
      name: "Broken queue",
      jql: "cf[9] = 1",
      issueCount: 3,
      findings: [finding("broken-ref", "Names a deleted field", "high")],
    },
  ],
  slas: [
    {
      fieldId: "customfield_1",
      name: "Time to resolution",
      desks: [{ deskId: "1" }],
      measuredDesks: 1,
      activeCount: 20,
      breachedCount: 15,
      breachRate: 0.75,
      findings: [finding("high-breach", "Breaches more often than it is met")],
    },
  ],
  organizations: [
    {
      id: "4",
      name: "Acme",
      memberCount: 0,
      membersComplete: true,
      deskCount: 1,
      findings: [finding("empty", "No members")],
    },
  ],
  summary: {
    available: true,
    totalDesks: 1,
    requestTypes: { total: 2, hidden: 1, recentRequests: 30 },
    queues: { total: 1, broken: 1 },
    slas: { activeRequests: 20, breachedRequests: 15, breachRate: 0.75, highBreach: 1 },
    customers: { emptyOrganizations: 1 },
  },
  ...over,
});

const serve = (inv) =>
  invoke.mockImplementation((fn) => {
    if (fn === "getJsmInventory") return Promise.resolve(inv);
    if (fn === "buildJsmInventory") return Promise.resolve({ queued: true });
    return Promise.resolve({});
  });

beforeEach(() => vi.clearAllMocks());

describe("ServiceManagementTab", () => {
  test("never built: offers the build", async () => {
    serve(inventory({ neverBuilt: true }));
    render(<ServiceManagementTab />);
    expect(await screen.findByText(/No Service Management inventory has been built yet/)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: /Build inventory/ })[0]);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("buildJsmInventory", {}));
    expect(await screen.findByText(/Build queued/)).toBeInTheDocument();
  });

  test("a site with no service desk says so instead of showing an empty catalogue", async () => {
    serve(inventory({ jsmEnabled: false, reason: "Jira Service Management is not on this site." }));
    render(<ServiceManagementTab />);
    expect(await screen.findByText(/not on this site/)).toBeInTheDocument();
    expect(screen.getByText(/left out of the health score/)).toBeInTheDocument();
  });

  test("the overview leads with the headline numbers and what needs attention", async () => {
    serve(inventory());
    render(<ServiceManagementTab />);
    expect(await screen.findByText("75%")).toBeInTheDocument();
    expect(screen.getByText("Queues naming a deleted custom field")).toBeInTheDocument();
    expect(screen.getByText(/SLA goals and calendars have no REST endpoint/)).toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("getPillarHealth", { pillar: "customers" }));
  });

  test("request types: unmeasured reads differently from a count, and findings filter", async () => {
    serve(inventory());
    render(<ServiceManagementTab />);
    await userEvent.click(await screen.findByRole("button", { name: /^Request types/ }));
    expect(await screen.findByText("30 requests")).toBeInTheDocument();
    expect(screen.getByText("Not measured")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Finding"), "hidden");
    expect(screen.queryByText("Laptop request")).not.toBeInTheDocument();
    expect(screen.getByText("Legacy form")).toBeInTheDocument();
  });

  test("queues, SLAs, organizations and desks each list their rows", async () => {
    serve(inventory());
    render(<ServiceManagementTab />);
    await userEvent.click(await screen.findByRole("button", { name: /^Queues/ }));
    expect(await screen.findByText("Broken queue")).toBeInTheDocument();
    expect(screen.getByText("Names a deleted field")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^SLAs/ }));
    expect(await screen.findByText("75% breached")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^Organizations/ }));
    expect(await screen.findByText("0 members")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^Desks/ }));
    const desk = await screen.findByText("IT Help (SD)");
    expect(within(desk.closest(".issue-type-row")).getByText("2,000+ customers")).toBeInTheDocument();
  });

  test("search narrows the list", async () => {
    serve(inventory());
    render(<ServiceManagementTab />);
    await userEvent.click(await screen.findByRole("button", { name: /^Request types/ }));
    await userEvent.type(await screen.findByPlaceholderText(/Search by name or desk/), "laptop");
    expect(screen.queryByText("Legacy form")).not.toBeInTheDocument();
  });

  test("a build error, a stale build and unread reads are each said", async () => {
    serve(inventory({ lastError: "boom", staleBuild: true, unreadCount: 3 }));
    render(<ServiceManagementTab />);
    expect(await screen.findByText(/Last build failed: boom/)).toBeInTheDocument();
    expect(screen.getByText(/no longer running/)).toBeInTheDocument();
    expect(screen.getByText(/3 reads did not finish/)).toBeInTheDocument();
  });

  test("a failed load shows the error", async () => {
    invoke.mockRejectedValueOnce(new Error("nope"));
    render(<ServiceManagementTab />);
    expect(await screen.findByText("nope")).toBeInTheDocument();
  });

  test("a refused build shows why", async () => {
    invoke.mockImplementation((fn) =>
      fn === "getJsmInventory"
        ? Promise.resolve(inventory())
        : fn === "buildJsmInventory"
          ? Promise.resolve({ queued: false, error: "Read-only mode is enabled." })
          : Promise.resolve({}),
    );
    render(<ServiceManagementTab />);
    await userEvent.click(await screen.findByRole("button", { name: /Rebuild/ }));
    expect(await screen.findByText("Read-only mode is enabled.")).toBeInTheDocument();
  });
});
