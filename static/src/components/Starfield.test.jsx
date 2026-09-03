import React from "react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Starfield } from "./Starfield";

// A fake 2D context: every method the component calls, recording nothing but not throwing.
function fakeCtx() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fillStyle: "",
  };
}

let getContextSpy;
let rafSpy;
let cafSpy;
let reduced;

beforeEach(() => {
  reduced = false;
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(() => fakeCtx());
  // A hand-driven rAF: returns an id, never auto-fires, so a test controls the frames.
  rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  cafSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  vi.stubGlobal("matchMedia", (q) => ({
    matches: q.includes("reduced-motion") ? reduced : false,
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Starfield", () => {
  test("renders an inert, aria-hidden canvas when active", () => {
    const { container } = render(<Starfield active />);
    const canvas = container.querySelector("canvas.observatory-starfield");
    expect(canvas).toBeInTheDocument();
    expect(canvas).toHaveAttribute("aria-hidden", "true");
  });

  test("renders nothing when inactive", () => {
    const { container } = render(<Starfield active={false} />);
    expect(container.querySelector("canvas")).toBeNull();
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });

  test("starts an animation loop and cancels it on unmount", () => {
    const { unmount } = render(<Starfield active />);
    expect(window.requestAnimationFrame).toHaveBeenCalled();
    unmount();
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
  });

  test("under prefers-reduced-motion it draws once and never loops", () => {
    reduced = true;
    const ctx = fakeCtx();
    getContextSpy.mockReturnValue(ctx);
    render(<Starfield active />);
    // One static frame was painted...
    expect(ctx.clearRect).toHaveBeenCalled();
    // ...and no rAF loop was scheduled.
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });

  test("no-ops without a 2D context rather than throwing", () => {
    getContextSpy.mockReturnValue(null);
    expect(() => render(<Starfield active />)).not.toThrow();
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });
});
