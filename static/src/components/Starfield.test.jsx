import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import {
  Starfield,
  makeMeteor,
  meteorPose,
  makeShowerSibling,
  starRGB,
  hashString,
  bearingColumn,
  BEARING_ORDER,
  makeField,
} from "./Starfield";

// A fake 2D context: every method the component calls, recording nothing but not throwing.
function fakeCtx() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    font: "",
    textAlign: "left",
  };
}

let getContextSpy;
let reduced;

beforeEach(() => {
  reduced = false;
  getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => fakeCtx());
  // A hand-driven rAF: returns an id, never auto-fires, so a test controls the frames.
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

  test("tracks the pointer for parallax and drops the listener on unmount", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<Starfield active />);
    expect(add).toHaveBeenCalledWith("pointermove", expect.any(Function), expect.anything());
    unmount();
    expect(remove).toHaveBeenCalledWith("pointermove", expect.any(Function));
  });

  test("under prefers-reduced-motion it does not track the pointer", () => {
    reduced = true;
    const add = vi.spyOn(window, "addEventListener");
    render(<Starfield active />);
    expect(add).not.toHaveBeenCalledWith("pointermove", expect.any(Function), expect.anything());
  });

  test("a bearing change does not tear down or restart the animation loop", () => {
    const { rerender } = render(<Starfield active bearing="overview" />);
    const rafCalls = window.requestAnimationFrame.mock.calls.length;
    const cafCalls = window.cancelAnimationFrame.mock.calls.length;
    rerender(<Starfield active bearing="boards" />);
    // The effect is keyed on `active`, not `bearing` -- the slew is picked up inside the
    // running loop, so no cancel/restart.
    expect(window.cancelAnimationFrame.mock.calls.length).toBe(cafCalls);
    expect(window.requestAnimationFrame.mock.calls.length).toBe(rafCalls);
  });

  test("renders without throwing when a bearing is supplied", () => {
    expect(() => render(<Starfield active bearing="fields" />)).not.toThrow();
  });
});

describe("starRGB", () => {
  test("runs cool at u=0 and hot-blue at u=1", () => {
    const cool = starRGB(0, 1);
    const hot = starRGB(1, 1);
    // Cool: red channel dominates blue. Hot: blue channel dominates red.
    expect(cool[0]).toBeGreaterThan(cool[2]);
    expect(hot[2]).toBeGreaterThan(hot[0]);
  });

  test("low saturation collapses toward white", () => {
    const [r, g, b] = starRGB(0, 0);
    expect(r).toBe(255);
    expect(g).toBe(255);
    expect(b).toBe(255);
  });

  test("stays in gamut for any input", () => {
    for (const u of [-1, 0, 0.3, 0.7, 1, 2]) {
      for (const [r, g, b] of [starRGB(u, 1), starRGB(u, 0.4)]) {
        for (const c of [r, g, b]) {
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(255);
        }
      }
    }
  });
});

describe("hashString / bearingColumn", () => {
  test("hashString is deterministic and order-sensitive", () => {
    expect(hashString("boards")).toBe(hashString("boards"));
    expect(hashString("boards")).not.toBe(hashString("fields"));
  });

  test("bearingColumn places tabs on the nav line, with unknowns at 0", () => {
    expect(bearingColumn("overview")).toBe(0);
    expect(bearingColumn("not-a-tab")).toBe(0);
    // Direction follows nav order: a later tab has a higher column, so the pan goes right.
    expect(bearingColumn("boards")).toBeGreaterThan(bearingColumn("dashboards"));
    expect(bearingColumn("fields")).toBeLessThan(bearingColumn("projects"));
  });

  test("every admin tab key is on the bearing line", () => {
    for (const key of ["overview", "fields", "projects", "workflows", "boards", "config"]) {
      expect(BEARING_ORDER).toContain(key);
    }
  });
});

describe("makeField", () => {
  const rng = () => 0.5;

  test("produces stars, galaxies and a band angle", () => {
    const f = makeField(1600, 900, rng);
    expect(f.stars.length).toBeGreaterThan(0);
    expect(f.galaxies.length).toBeGreaterThanOrEqual(2);
    expect(f.bandAngle).toBeGreaterThanOrEqual(0);
    expect(f.bandAngle).toBeLessThanOrEqual(Math.PI);
  });

  test("every star carries a colour triplet and a depth in [0,1]", () => {
    const f = makeField(1200, 800, rng);
    for (const s of f.stars) {
      expect(s.col).toMatch(/^\d+, \d+, \d+$/);
      expect(s.depth).toBeGreaterThanOrEqual(0);
      expect(s.depth).toBeLessThanOrEqual(1);
    }
  });

  test("is reproducible from the same seed", () => {
    const a = makeField(1000, 1000, () => 0.42);
    const b = makeField(1000, 1000, () => 0.42);
    expect(a.stars[0]).toEqual(b.stars[0]);
    expect(a.bandAngle).toBe(b.bandAngle);
  });
});

describe("makeMeteor", () => {
  const seq = (values) => {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
  };

  test("enters high and travels down-right on a shallow angle", () => {
    const m = makeMeteor(1600, 900, 1000, seq([0.5, 0.5, 0.5, 0.5, 0.5]));
    expect(m.dx).toBeGreaterThan(0);
    expect(m.dy).toBeGreaterThan(0);
    // Shallow: more horizontal than vertical travel.
    expect(m.dx).toBeGreaterThan(m.dy);
    expect(m.startAt).toBe(1000);
    expect(m.dur).toBeGreaterThan(0);
    expect(m.len).toBeGreaterThan(0);
    expect(m.tail).toBeGreaterThan(0);
  });

  test("angle stays within the 18-42 degree band across the rng range", () => {
    for (const r of [0, 0.5, 0.999]) {
      const m = makeMeteor(1000, 1000, 0, () => r);
      const deg = (Math.atan2(m.dy, m.dx) * 180) / Math.PI;
      expect(deg).toBeGreaterThanOrEqual(18);
      expect(deg).toBeLessThanOrEqual(42);
    }
  });
});

describe("meteorPose", () => {
  const m = makeMeteor(1600, 900, 0, () => 0.5);

  test("is null before it starts and after it ends", () => {
    expect(meteorPose(m, -1)).toBeNull();
    expect(meteorPose(m, m.dur)).toBeNull();
    expect(meteorPose(m, m.dur + 500)).toBeNull();
    expect(meteorPose(null, 0)).toBeNull();
  });

  test("the head advances along the trajectory and brightness stays in [0,1]", () => {
    const early = meteorPose(m, m.dur * 0.05);
    const mid = meteorPose(m, m.dur * 0.5);
    const late = meteorPose(m, m.dur * 0.9);

    // Monotonic progress along the path.
    expect(mid.hx).toBeGreaterThan(early.hx);
    expect(late.hx).toBeGreaterThan(mid.hx);

    for (const pose of [early, mid, late]) {
      expect(pose.k).toBeGreaterThanOrEqual(0);
      expect(pose.k).toBeLessThanOrEqual(1);
    }
    // Ramps up early, holds in the middle, fades late.
    expect(early.k).toBeLessThan(1);
    expect(mid.k).toBe(1);
    expect(late.k).toBeLessThan(1);
  });

  test("the tail sits behind the head and never longer than the tail length", () => {
    const pose = meteorPose(m, m.dur * 0.8);
    const tailLen = Math.hypot(pose.hx - pose.tx, pose.hy - pose.ty);
    expect(tailLen).toBeGreaterThan(0);
    expect(tailLen).toBeLessThanOrEqual(m.tail + 0.001);
  });
});

describe("makeShowerSibling", () => {
  const lead = makeMeteor(1600, 900, 1000, () => 0.5);

  test("keeps the lead's heading but starts later and offset from it", () => {
    const sib = makeShowerSibling(lead, 1000, 1, () => 0.5);
    // Same direction of travel.
    expect(sib.dx).toBe(lead.dx);
    expect(sib.dy).toBe(lead.dy);
    // Staggered start, positive duration and length.
    expect(sib.startAt).toBeGreaterThan(lead.startAt);
    expect(sib.dur).toBeGreaterThan(0);
    expect(sib.len).toBeGreaterThan(0);
    // Displaced from the lead's start point.
    expect(Math.hypot(sib.x0 - lead.x0, sib.y0 - lead.y0)).toBeGreaterThan(0);
  });

  test("odd and even siblings fan to opposite sides", () => {
    const perpX = -lead.dy;
    const perpY = lead.dx;
    const side = (i) => {
      const s = makeShowerSibling(lead, 0, i, () => 0.5);
      return Math.sign((s.x0 - lead.x0) * perpX + (s.y0 - lead.y0) * perpY);
    };
    expect(side(1)).not.toBe(side(2));
  });

  test("each successive sibling starts after the one before it", () => {
    const s1 = makeShowerSibling(lead, 0, 1, () => 0.5);
    const s2 = makeShowerSibling(lead, 0, 2, () => 0.5);
    expect(s2.startAt).toBeGreaterThan(s1.startAt);
  });
});
