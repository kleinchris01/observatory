import "@testing-library/jest-dom";

// ResizeObserver is not implemented in jsdom — provide a no-op stub so
// components that use it (ScrollableTableWrap, etc.) don't throw.
global.ResizeObserver = class ResizeObserver {
  constructor(cb) { this._cb = cb; }
  observe() {}
  unobserve() {}
  disconnect() {}
};

// jsdom does no layout, so getBoundingClientRect always reports 0x0. Recharts'
// ResponsiveContainer reads this to size its chart and, at 0x0, renders nothing
// at all -- not a bug in the chart code, a known Recharts+jsdom gap. A plausible
// non-zero default lets chart components actually render their content in tests.
Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return { width: 400, height: 300, top: 0, left: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} };
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

// The admin shell and its tabs remember the open tab and section in localStorage. jsdom keeps
// that store for the whole file, so without this one test's click decides where the next
// test's render opens.
import { beforeEach } from "vitest";
beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* storage unavailable: nothing to clear */ }
});
