import "@testing-library/jest-dom";

// Mock createPortal to render children inline so jsdom can find them
import { createPortal } from "react-dom";
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createPortal: (children, _container) => children,
  };
});
