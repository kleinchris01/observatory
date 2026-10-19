import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { FieldBrowserTab } from "./FieldBrowserTab";

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn(),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

const FIELD = { id: "customfield_10001", name: "Landed Piece Price", type: "number", isCustom: true };

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockImplementation(async (fn) => {
    if (fn === "getFieldInventory") return { fields: [FIELD], total: 1, totalPages: 1 };
    if (fn === "getFieldDetails") throw new Error("Jira returned 503");
    return {};
  });
});

describe("FieldBrowserTab", () => {
  // A failed detail load used to be stored in state and never rendered: the card opened onto
  // nothing, with no hint that anything had gone wrong.
  test("says so when a field's details fail to load", async () => {
    render(<FieldBrowserTab />);
    await userEvent.click(await screen.findByRole("button", { name: /Landed Piece Price/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load this field's details: Jira returned 503");
    expect(invoke).toHaveBeenCalledWith("getFieldDetails", { fieldId: "customfield_10001", usagePage: 1 });
  });
});
