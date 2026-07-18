import "@testing-library/jest-dom";

// ResizeObserver is not implemented in jsdom — provide a no-op stub so
// components that use it (ScrollableTableWrap, etc.) don't throw.
global.ResizeObserver = class ResizeObserver {
  constructor(cb) { this._cb = cb; }
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock createPortal to render children inline so jsdom can find them
import { createPortal } from "react-dom";
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createPortal: (children, _container) => children,
  };
});
