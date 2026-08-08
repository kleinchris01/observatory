import React from "react";

// Poll only while there is something to poll for AND the tab is being looked at.
//
// Lives here rather than in a tab because three surfaces need it and none of them owns it:
// the admin shell's overview refresh, the Scans panels, and the macro's report job.
//
// The rule this encodes: a background refresh that nobody can see is pure cost. Every poll
// in this app hits a resolver, and every resolver hits SQL. An admin page left open in a
// background tab was running the heaviest read in the product once a minute, indefinitely.
//
// Fires once immediately on becoming visible, so a tab returned to after an hour shows
// current state rather than waiting out the interval first.
export function useVisiblePolling(active, fn, intervalMs) {
  const saved = React.useRef(fn);
  saved.current = fn;

  React.useEffect(() => {
    if (!active) return undefined;

    let timer = null;
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const start = () => { if (!timer) timer = setInterval(() => saved.current(), intervalMs); };

    const sync = () => {
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      if (hidden) { stop(); return; }
      saved.current();
      start();
    };

    sync();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", sync);
    return () => {
      stop();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", sync);
    };
  }, [active, intervalMs]);
}

// Refresh when someone comes back to the page, and at no other time.
//
// This replaced a 60-second interval on the admin overview. The interval existed to catch
// changes made elsewhere -- a snapshot finishing, config edited in another session -- and
// ran 1,440 times a day to catch an event that happens about once. getAdminOverview is the
// heaviest read in the product, so that was the worst possible thing to put on a timer.
//
// Coming back to the tab is the moment staleness starts to matter, and it is the only
// moment. Idle cost is zero: no timer exists, so there is nothing to leave running.
//
// What this gives up: sitting on the page for ten minutes without touching anything will
// not surface a change made elsewhere until you look away and back. The overview is not a
// live-monitoring surface -- Scans polls its own state properly while a build runs -- so
// that is the right thing to trade away.
export function useRefreshOnVisible(fn) {
  const saved = React.useRef(fn);
  saved.current = fn;

  React.useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onVisible = () => {
      if (document.visibilityState === "visible") saved.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
}
