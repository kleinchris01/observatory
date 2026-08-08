import React from "react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVisiblePolling, useRefreshOnVisible } from "./hooks";

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
