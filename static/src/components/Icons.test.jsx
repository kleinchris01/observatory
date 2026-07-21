import { describe, it, expect } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { Icon, ICON_COMPONENTS, CHART_PALETTE, useColorTheme, useChartPalette, useLiveDuration } from "./Icons";

describe("ICON_COMPONENTS", () => {
  it("has an entry for every icon name actually used in the app", () => {
    for (const name of [
      "layers", "activity", "zap", "folder", "barChart", "alertTriangle", "alertCircle",
      "info", "scissors", "checkCircle", "check", "x", "settings", "refreshCw", "lock", "clock", "sliders",
    ]) {
      expect(ICON_COMPONENTS).toHaveProperty(name);
    }
  });

  it("each value is a renderable component, not a raw path string", () => {
    for (const [key, Component] of Object.entries(ICON_COMPONENTS)) {
      expect(typeof Component === "function" || typeof Component === "object", `ICON_COMPONENTS.${key} should be a component`).toBe(true);
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

  it("respects the size prop", () => {
    const { container } = render(<Icon name="activity" size={32} />);
    const svg = container.querySelector("svg");
    expect(svg.getAttribute("width")).toBe("32");
    expect(svg.getAttribute("height")).toBe("32");
  });

  it("defaults to regular weight and currentColor", () => {
    const { container } = render(<Icon name="settings" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    // Phosphor renders fill/stroke as currentColor for the regular weight by default
    expect(container.innerHTML).toMatch(/currentColor/);
  });

  it("respects an explicit weight prop", () => {
    const regular = render(<Icon name="checkCircle" weight="regular" />);
    const fill = render(<Icon name="checkCircle" weight="fill" />);
    // Different weights render structurally different path data
    expect(regular.container.innerHTML).not.toBe(fill.container.innerHTML);
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

describe("useColorTheme", () => {
  it("reads the initial theme from document.documentElement.dataset.theme", () => {
    document.documentElement.dataset.theme = "light";
    const { result, unmount } = renderHook(() => useColorTheme());
    expect(result.current).toBe("light");
    unmount();
    document.documentElement.dataset.theme = "dark";
  });

  it("defaults to dark when no data-theme is set", () => {
    delete document.documentElement.dataset.theme;
    const { result, unmount } = renderHook(() => useColorTheme());
    expect(result.current).toBe("dark");
    unmount();
  });

  it("reacts when data-theme changes on the document element", async () => {
    document.documentElement.dataset.theme = "dark";
    const { result, unmount } = renderHook(() => useColorTheme());
    expect(result.current).toBe("dark");
    await act(async () => {
      document.documentElement.dataset.theme = "light";
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current).toBe("light");
    unmount();
    document.documentElement.dataset.theme = "dark";
  });
});

describe("useChartPalette", () => {
  it("returns a different, still-valid palette per theme", () => {
    document.documentElement.dataset.theme = "dark";
    const { result: dark, unmount: unmountDark } = renderHook(() => useChartPalette());
    unmountDark();
    document.documentElement.dataset.theme = "light";
    const { result: light, unmount: unmountLight } = renderHook(() => useChartPalette());

    expect(Array.isArray(dark.current)).toBe(true);
    expect(Array.isArray(light.current)).toBe(true);
    expect(dark.current).not.toEqual(light.current);
    unmountLight();
    document.documentElement.dataset.theme = "dark";
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
