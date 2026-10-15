import React from "react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { DaySky } from "./DaySky";

function fakeCtx() {
  return {
    setTransform: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fillStyle: "",
  };
}

let getContextSpy;

beforeEach(() => {
  getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => fakeCtx());
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DaySky", () => {
  test("renders an inert, aria-hidden canvas when active", () => {
    const { container } = render(<DaySky active />);
    const canvas = container.querySelector("canvas.observatory-daysky");
    expect(canvas).toBeInTheDocument();
    expect(canvas).toHaveAttribute("aria-hidden", "true");
  });

  test("renders nothing when inactive", () => {
    const { container } = render(<DaySky active={false} />);
    expect(container.querySelector("canvas")).toBeNull();
  });

  // A clear sky and the sun: the sky gradient once, and the sun's three layers. No clouds, no
  // rain, and nothing moving, so no animation loop at all.
  test("paints the sky and the sun once, with no animation loop", () => {
    const ctx = fakeCtx();
    getContextSpy.mockReturnValue(ctx);
    render(<DaySky active />);

    expect(ctx.fillRect).toHaveBeenCalledTimes(1);
    expect(ctx.arc).toHaveBeenCalledTimes(3);
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });

  test("repaints after the window is resized, and stops listening on unmount", () => {
    vi.useFakeTimers();
    const ctx = fakeCtx();
    getContextSpy.mockReturnValue(ctx);
    const { unmount } = render(<DaySky active />);

    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(200);
    expect(ctx.fillRect).toHaveBeenCalledTimes(2);

    unmount();
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(200);
    expect(ctx.fillRect).toHaveBeenCalledTimes(2);
  });

  test("does not throw when the canvas has no 2D context", () => {
    getContextSpy.mockReturnValue(null);
    expect(() => render(<DaySky active />)).not.toThrow();
  });
});
