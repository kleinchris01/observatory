import React from "react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVisiblePolling, useRefreshOnVisible, useNavIntent, usePersistentState, useSnapshotBuild, usePillarHealth, daysSince } from "./hooks";
import { invoke } from "@forge/bridge";

const setVisibility = (state) => {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});
afterEach(() => vi.useRealTimers());

// The admin overview used to run the heaviest read in the product on a 60s timer. These
// assert the replacement costs nothing while nobody is looking.
describe("useRefreshOnVisible", () => {
  test("does not fire on mount -- the caller already loads once", () => {
    const fn = vi.fn();
    renderHook(() => useRefreshOnVisible(fn));
    expect(fn).not.toHaveBeenCalled();
  });

  test("creates no timer, so idle cost is zero", () => {
    const fn = vi.fn();
    renderHook(() => useRefreshOnVisible(fn));
    act(() => { vi.advanceTimersByTime(10 * 60 * 1000); });
    expect(fn).not.toHaveBeenCalled();
  });

  test("fires when the page becomes visible again", () => {
    const fn = vi.fn();
    renderHook(() => useRefreshOnVisible(fn));
    act(() => { setVisibility("hidden"); });
    act(() => { setVisibility("visible"); });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("does not fire on becoming hidden", () => {
    const fn = vi.fn();
    renderHook(() => useRefreshOnVisible(fn));
    act(() => { setVisibility("hidden"); });
    expect(fn).not.toHaveBeenCalled();
  });

  test("detaches its listener on unmount", () => {
    const fn = vi.fn();
    const { unmount } = renderHook(() => useRefreshOnVisible(fn));
    unmount();
    act(() => { setVisibility("hidden"); setVisibility("visible"); });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("useVisiblePolling still guards the Scans panels", () => {
  test("polls while active and visible", () => {
    const fn = vi.fn();
    renderHook(() => useVisiblePolling(true, fn, 1000));
    fn.mockClear();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("useNavIntent", () => {
  // Keyed on object identity rather than on the values inside it, deliberately: the shell
  // mints a fresh object per navigation, so clicking the same finding twice re-applies its
  // filter after the reader has changed it. Comparing values would make the second click
  // silently do nothing.
  test("applies an intent when one arrives", () => {
    const apply = vi.fn();
    renderHook(({ intent }) => useNavIntent(intent, apply), {
      initialProps: { intent: { filter: "unreached" } },
    });
    expect(apply).toHaveBeenCalledWith({ filter: "unreached" });
  });

  test("does nothing when a tab is opened normally", () => {
    const apply = vi.fn();
    renderHook(({ intent }) => useNavIntent(intent, apply), { initialProps: { intent: null } });
    expect(apply).not.toHaveBeenCalled();
  });

  test("re-applies when the same finding is clicked again", () => {
    const apply = vi.fn();
    const { rerender } = renderHook(({ intent }) => useNavIntent(intent, apply), {
      initialProps: { intent: { filter: "empty" } },
    });
    // A fresh object with identical values -- what the shell produces on a second click.
    rerender({ intent: { filter: "empty" } });
    expect(apply).toHaveBeenCalledTimes(2);
  });

  test("does not re-apply on an unrelated re-render", () => {
    const apply = vi.fn();
    const intent = { filter: "empty" };
    const { rerender } = renderHook(({ intent: i }) => useNavIntent(i, apply), {
      initialProps: { intent },
    });
    rerender({ intent });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  // The handler is held in a ref, so a tab that rebuilds its closure every render does not
  // re-run the filter on every keystroke.
  test("a new handler identity does not re-apply the intent", () => {
    const intent = { filter: "empty" };
    let calls = 0;
    const { rerender } = renderHook(() => useNavIntent(intent, () => { calls += 1; }));
    rerender();
    rerender();
    expect(calls).toBe(1);
  });
});

describe("usePersistentState", () => {
  test("starts at the fallback, then remembers what it was set to", () => {
    const first = renderHook(() => usePersistentState("observatory.section.test", "overview"));
    expect(first.result.current[0]).toBe("overview");
    act(() => first.result.current[1]("roles"));
    first.unmount();

    const second = renderHook(() => usePersistentState("observatory.section.test", "overview"));
    expect(second.result.current[0]).toBe("roles");
  });

  test("a deep-link override beats the remembered value, and becomes the remembered value", () => {
    window.localStorage.setItem("observatory.section.test", "roles");
    const { result, unmount } = renderHook(() => usePersistentState("observatory.section.test", "overview", "rqt"));
    expect(result.current[0]).toBe("rqt");
    unmount();
    expect(window.localStorage.getItem("observatory.section.test")).toBe("rqt");
  });
});


// The build lifecycle seven pillar tabs used to carry a copy of.
describe("useSnapshotBuild", () => {
  test("queues the build, reloads, then says it was queued", async () => {
    invoke.mockResolvedValueOnce({ queued: true });
    const load = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useSnapshotBuild({ resolver: "buildX", data: { state: "ready" }, load }));

    await act(async () => { await result.current.startBuild(); });

    expect(invoke).toHaveBeenCalledWith("buildX", {});
    expect(load).toHaveBeenCalled();
    expect(result.current.notice).toMatch(/Build queued/);
    expect(result.current.starting).toBe(false);
  });

  test("reports a build that is already running as a notice, not an error", async () => {
    invoke.mockResolvedValueOnce({ queued: false, reason: "already-building" });
    const { result } = renderHook(() => useSnapshotBuild({ resolver: "buildX", data: null, load: vi.fn() }));
    await act(async () => { await result.current.startBuild(); });
    expect(result.current.notice).toMatch(/already running/);
    expect(result.current.error).toBe("");
  });

  test("reports a refusal and a thrown call as errors", async () => {
    invoke.mockResolvedValueOnce({ error: "Read-only mode is on." });
    const { result } = renderHook(() => useSnapshotBuild({ resolver: "buildX", data: null, load: vi.fn() }));
    await act(async () => { await result.current.startBuild(); });
    expect(result.current.error).toBe("Read-only mode is on.");

    invoke.mockRejectedValueOnce(new Error("network"));
    await act(async () => { await result.current.startBuild(); });
    expect(result.current.error).toBe("network");
  });

  test("a wedged build is not building, so the control that recovers it stays enabled", () => {
    const { result, rerender } = renderHook(
      ({ data }) => useSnapshotBuild({ resolver: "buildX", data, load: vi.fn() }),
      { initialProps: { data: { state: "building", staleBuild: true } } }
    );
    expect(result.current.isBuilding).toBe(false);
    rerender({ data: { state: "queued", staleBuild: false } });
    expect(result.current.isBuilding).toBe(true);
  });
});

describe("usePillarHealth", () => {
  test("reads the pillar, and is null rather than an error when it cannot", async () => {
    invoke.mockResolvedValueOnce({ pillar: { key: "boards", score: 80 } });
    const { result } = renderHook(() => usePillarHealth("boards", "t1"));
    await act(async () => { await Promise.resolve(); });
    expect(invoke).toHaveBeenCalledWith("getPillarHealth", { pillar: "boards" });
    expect(result.current).toEqual({ key: "boards", score: 80 });

    invoke.mockRejectedValueOnce(new Error("nope"));
    const failed = renderHook(() => usePillarHealth("boards", "t2"));
    await act(async () => { await Promise.resolve(); });
    expect(failed.result.current).toBeNull();
  });
});

describe("daysSince", () => {
  test("is null, never zero, for a missing or unreadable date", () => {
    expect(daysSince(null)).toBeNull();
    expect(daysSince("not a date")).toBeNull();
    expect(Math.round(daysSince(new Date(Date.now() - 3 * 86400000).toISOString()))).toBe(3);
  });
});
