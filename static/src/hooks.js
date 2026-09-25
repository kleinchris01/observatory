import React from "react";
import { invoke } from "@forge/bridge";
import { readStored, writeStored } from "./utils";

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

// Apply a navigation intent once per navigation.
//
// The Overview's findings name an exact set -- "252 screens nothing reaches", "86 statuses
// only an automation rule can reach" -- and used to hand the reader the tab and nothing
// else, at page one of the whole catalogue. An intent is the filter that turns the tab into
// the set the finding named.
//
// Keyed on object identity rather than on the values inside it, which is deliberate: the
// shell mints a fresh object on every navigation, so clicking the same finding twice
// re-applies the filter after the reader has changed it. Comparing values would make the
// second click do nothing.
//
// `apply` is called with the intent, never with null, so a tab opened normally is left
// exactly as the reader left it.
export function useNavIntent(intent, apply) {
  const saved = React.useRef(apply);
  saved.current = apply;

  React.useEffect(() => {
    if (!intent) return;
    saved.current(intent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent]);
}

// A piece of UI state that survives a reload -- which tab, which section -- kept per viewer in
// localStorage.
//
// `override` wins over the stored value: a deep link ("open the RQT index", "build this
// report") must land where it points, not where the reader last was. A stored value that no
// longer names a real section is harmless: SubNavLayout falls back to its first item.
export function usePersistentState(storageKey, fallback, override = null) {
  const [value, setValue] = React.useState(() => override || readStored(storageKey, null) || fallback);
  React.useEffect(() => { writeStored(storageKey, value); }, [storageKey, value]);
  return [value, setValue];
}

// The build lifecycle every pillar inventory shares: start a build, poll while it runs, say
// what happened. Seven tabs carried an identical copy of this -- same notices, same poll
// interval, same refusal handling -- differing only in the resolver name, which is how the
// copies had begun to drift in wording and in whether a refusal was reported before or
// after the reload.
//
// Owns only the build's own state. The tab's load error stays the tab's; BuildBanners shows
// both. Reload happens before a refusal is reported, because load() clears the banner.
export const BUILD_POLL_MS = 3000;

export function useSnapshotBuild({ resolver, data, load }) {
  const [starting, setStarting] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  const [error, setError] = React.useState("");

  const isBuilding = ["building", "queued"].includes(data?.state) && !data?.staleBuild;
  useVisiblePolling(isBuilding, load, BUILD_POLL_MS);

  async function startBuild() {
    setStarting(true);
    setError("");
    setNotice("");
    try {
      const result = await invoke(resolver, {});
      await load();
      if (result?.error) {
        setError(result.error);
      } else if (result?.reason === "already-building") {
        setNotice("A build is already running. This page refreshes itself while it does.");
      } else {
        setNotice("Build queued. This page refreshes itself while it runs.");
      }
    } catch (err) {
      setError(err?.message || "Could not start the build.");
    } finally {
      setStarting(false);
    }
  }

  return { isBuilding, starting, notice, error, startBuild };
}

// Whole days since an ISO timestamp, or null when there is none. For "this inventory is N
// days old" -- a missing date is unknown, never zero days.
export function daysSince(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ms) ? ms / 86400000 : null;
}

// One pillar's slice of the site health score, re-read whenever the inventory it scores is
// rebuilt. Every pillar tab fetched this the same way; a failure is "not scored", never an
// error banner, because the inventory is still worth reading without its score.
export function usePillarHealth(pillarKey, refreshKey) {
  const [pillar, setPillar] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    invoke("getPillarHealth", { pillar: pillarKey })
      .then((result) => { if (!cancelled) setPillar(result?.pillar || null); })
      .catch(() => { if (!cancelled) setPillar(null); });
    return () => { cancelled = true; };
  }, [pillarKey, refreshKey]);
  return pillar;
}
