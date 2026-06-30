import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@forge/bridge";
import { FieldOptionsModal } from "./FieldOptionsModal";

// invoke is auto-mocked via __mocks__/@forge/bridge.js
// We reset and re-configure it per test via beforeEach / per-test vi.fn()

const defaultProps = {
  fieldId: "customfield_10001",
  fieldName: "My Select Field",
  fieldType: "select",
  projectKeys: [],
  onClose: vi.fn(),
};

describe("FieldOptionsModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the field name in the modal header", async () => {
    invoke.mockResolvedValue({ optionsByContext: [] });
    render(<FieldOptionsModal {...defaultProps} />);
    // The header renders immediately
    expect(screen.getByText("My Select Field")).toBeInTheDocument();
  });

  it("shows the field id in the modal header", async () => {
    invoke.mockResolvedValue({ optionsByContext: [] });
    render(<FieldOptionsModal {...defaultProps} />);
    expect(screen.getByText("customfield_10001")).toBeInTheDocument();
  });

  it("shows loading state while invoke is pending", () => {
    // Return a promise that never resolves to keep it in loading state
    invoke.mockReturnValue(new Promise(() => {}));
    render(<FieldOptionsModal {...defaultProps} />);
    expect(screen.getByText(/Loading options/i)).toBeInTheDocument();
  });

  it("renders empty state after load when no options returned", async () => {
    invoke.mockResolvedValue({ optionsByContext: [] });
    render(<FieldOptionsModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("No contexts or options found for this field.")).toBeInTheDocument();
    });
  });

  it("renders option values after load", async () => {
    invoke.mockResolvedValue({
      optionsByContext: [
        {
          contextId: "ctx1",
          contextName: "Global Context",
          isGlobalContext: true,
          fetchError: null,
          options: [
            { id: "1", value: "Option A", disabled: false },
            { id: "2", value: "Option B", disabled: false },
          ],
        },
      ],
    });
    render(<FieldOptionsModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Option A")).toBeInTheDocument();
      expect(screen.getByText("Option B")).toBeInTheDocument();
    });
  });

  it("calls onClose when the close button is clicked", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue({ optionsByContext: [] });
    const onClose = vi.fn();
    render(<FieldOptionsModal {...defaultProps} onClose={onClose} />);
    const closeBtn = screen.getByRole("button", { name: /close/i });
    await user.click(closeBtn);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows error state when invoke rejects", async () => {
    invoke.mockRejectedValue(new Error("Network error"));
    render(<FieldOptionsModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load options: Network error/i)).toBeInTheDocument();
    });
  });
});
