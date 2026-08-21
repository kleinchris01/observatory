import React from "react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVisiblePolling, useRefreshOnVisible, useNavIntent } from "./hooks";

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
