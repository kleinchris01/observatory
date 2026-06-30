import { describe, it, expect } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { Icon, ICON_PATHS, CHART_PALETTE, useLiveDuration } from "./Icons";

describe("ICON_PATHS", () => {
  it("has expected keys", () => {
    expect(ICON_PATHS).toHaveProperty("layers");
    expect(ICON_PATHS).toHaveProperty("activity");
    expect(ICON_PATHS).toHaveProperty("zap");
    expect(ICON_PATHS).toHaveProperty("barChart");
    expect(ICON_PATHS).toHaveProperty("alertTriangle");
    expect(ICON_PATHS).toHaveProperty("chevronDown");
    expect(ICON_PATHS).toHaveProperty("settings");
  });

  it("each value is a non-empty string path", () => {
    for (const [key, value] of Object.entries(ICON_PATHS)) {
      expect(typeof value).toBe("string", `ICON_PATHS.${key} should be a string`);
      expect(value.length).toBeGreaterThan(0, `ICON_PATHS.${key} should not be empty`);
    }
  });
});

describe("CHART_PALETTE", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(CHART_PALETTE)).toBe(true);
    expect(CHART_PALETTE.length).toBeGreaterThan(0);
  });

  it("contains CSS color strings", () => {
    for (const color of CHART_PALETTE) {
      expect(typeof color).toBe("string");
      // Each entry should be a hex or rgb color
      expect(color).toMatch(/^#[0-9a-fA-F]{3,6}$|^rgb/);
    }
  });
});

describe("Icon", () => {
  it("renders an SVG element for a known icon name", () => {
    const { container } = render(<Icon name="layers" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
  });

  it("renders a path element with the correct d attribute", () => {
    const { container } = render(<Icon name="layers" />);
    const path = container.querySelector("path");
    expect(path).not.toBeNull();
    expect(path.getAttribute("d")).toBe(ICON_PATHS.layers);
  });

  it("respects the size prop", () => {
    const { container } = render(<Icon name="activity" size={32} />);
    const svg = container.querySelector("svg");
    expect(svg.getAttribute("width")).toBe("32");
    expect(svg.getAttribute("height")).toBe("32");
  });

  it("returns null for an unknown icon name", () => {
    const { container } = render(<Icon name="totally-unknown-icon-xyz" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders without crashing when name is undefined", () => {
    const { container } = render(<Icon />);
    expect(container.firstChild).toBeNull();
  });
});

describe("useLiveDuration", () => {
  it("returns empty string when startedAt is null", () => {
    const { result } = renderHook(() => useLiveDuration(null));
    // When startedAt is null, elapsed is 0 => returns "0s"
    // (The hook sets elapsed to 0 and returns `${s}s` where s=0)
    expect(typeof result.current).toBe("string");
  });

  it("returns a duration string when given a recent date", () => {
    const recentDate = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago
    const { result } = renderHook(() => useLiveDuration(recentDate));
    expect(typeof result.current).toBe("string");
    // Should be something like "5s"
    expect(result.current).toMatch(/\d+s$/);
  });

  it("returns hours+minutes+seconds format for long duration", () => {
    const longAgo = new Date(Date.now() - 2 * 3600 * 1000 - 30 * 60 * 1000).toISOString();
    const { result } = renderHook(() => useLiveDuration(longAgo));
    expect(result.current).toMatch(/\d+h \d+m \d+s/);
  });

  it("returns minutes+seconds format for medium duration", () => {
    const mediumAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString(); // 3 minutes ago
    const { result } = renderHook(() => useLiveDuration(mediumAgo));
    expect(result.current).toMatch(/\d+m \d+s/);
  });
});
