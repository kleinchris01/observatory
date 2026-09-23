import React from "react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { DaySky, pickWeather } from "./DaySky";

function fakeCtx() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    save: vi.fn(),
    restore: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    globalAlpha: 1,
    filter: "none",
  };
}

let getContextSpy;
let reduced;

beforeEach(() => {
  reduced = false;
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(() => fakeCtx());
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
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

describe("pickWeather", () => {
  test("always returns one of the four named states", () => {
    for (let i = 0; i < 200; i++) {
      const w = pickWeather(Math.random);
      expect(["sunny", "partly", "cloudy", "rainy"]).toContain(w);
    }
  });

  // Pins the weighting rather than just "returns something": a caller passing a fixed rng
  // must get a deterministic, checkable answer, and the four states must partition [0,1)
  // with no gap -- a gap would mean some roll silently returns undefined.
  test("partitions [0,1) across the four states with no gap", () => {
    expect(pickWeather(() => 0)).toBe("sunny");
    expect(pickWeather(() => 0.34)).toBe("sunny");
    expect(pickWeather(() => 0.36)).toBe("partly");
    expect(pickWeather(() => 0.59)).toBe("partly");
    expect(pickWeather(() => 0.61)).toBe("cloudy");
    expect(pickWeather(() => 0.79)).toBe("cloudy");
    expect(pickWeather(() => 0.81)).toBe("rainy");
    expect(pickWeather(() => 0.999)).toBe("rainy");
  });
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
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });

  test("starts an animation loop and cancels it on unmount", () => {
    const { unmount } = render(<DaySky active />);
    expect(window.requestAnimationFrame).toHaveBeenCalled();
    unmount();
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
  });

  test("under prefers-reduced-motion it draws once and never loops", () => {
    reduced = true;
    const ctx = fakeCtx();
    getContextSpy.mockReturnValue(ctx);
    render(<DaySky active />);
    expect(ctx.fillRect).toHaveBeenCalled(); // the sky gradient, painted once
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });

  test("does not throw when the canvas has no 2D context", () => {
    getContextSpy.mockReturnValue(null);
    expect(() => render(<DaySky active />)).not.toThrow();
  });

  // The weather is picked once per mount and stamped on the canvas so a test (or a curious
  // operator) can see which sky is showing without reverse-engineering the draw calls.
  test("stamps the chosen weather onto the canvas as a data attribute", () => {
    const { container } = render(<DaySky active />);
    const canvas = container.querySelector("canvas.observatory-daysky");
    expect(["sunny", "partly", "cloudy", "rainy"]).toContain(canvas.dataset.weather);
  });
});
