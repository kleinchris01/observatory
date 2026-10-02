import React from "react";
import { invoke } from "@forge/bridge";
import { Icon } from "../Icons";
import { readStored, writeStored } from "../../utils";

// Ctrl+K / Cmd+K: jump to any tab, or to any item in any pillar, the way Jira's command
// palette does. Admin-only -- the cross-pillar index behind it is an admin read.
//
// Picking an item opens its pillar tab on the list it lives in, with its name already in that
// tab's search box (see entityIntent). The last row hands the term to the Search tab as OQL,
// for when "find by name" is not the question.

const RECENT_KEY = "observatory.palette.recent";
const RECENT_MAX = 8;
const DEBOUNCE_MS = 200;
const MIN_TERM = 2;
const TAB_MATCH_MAX = 6;
const ENTITY_LIMIT = 20;

// The list inside each pillar tab that holds its items. Tabs not named here have one list.
const PILLAR_VIEW = {
  workflows: "schemes",
  issueTypes: "hierarchy",
  people: "roster",
  assets: "types",
  screens: "screens",
  filters: "filters",
  boards: "boards",
};
// Access and Priorities hold several kinds of item, each on its own view.
const ACCESS_VIEW = {
  "Permission scheme": "permissions",
  "Issue security scheme": "security",
  "Notification scheme": "notifications",
  "Project role": "roles",
};

/** The navigation intent that opens a search result where it lives, already searched for. */
export function entityIntent(row) {
  const intent = { search: row.name ?? "" };
  if (row.pillar === "automation") return { ...intent, section: "blast" };
  if (row.pillar === "priorities") return { ...intent, view: row.kind === "Resolution" ? "resolutions" : "priorities" };
  if (row.pillar === "access") return ACCESS_VIEW[row.type] ? { ...intent, view: ACCESS_VIEW[row.type] } : intent;
  if (PILLAR_VIEW[row.pillar]) return { ...intent, view: PILLAR_VIEW[row.pillar] };
  return intent;
}

/** A name/ID search as OQL, quoted so punctuation in the term cannot break the query. */
export function oqlForTerm(term) {
  const quoted = `"${String(term).trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `name ~ ${quoted} OR id ~ ${quoted}`;
}

export function readRecent() {
  try {
    const parsed = JSON.parse(readStored(RECENT_KEY, "[]"));
    return Array.isArray(parsed) ? parsed.filter((r) => r && r.uid && r.pillar && r.name != null) : [];
  } catch {
    return [];
  }
}

export function pushRecent(row) {
  const keep = { uid: row.uid, pillar: row.pillar, pillarLabel: row.pillarLabel, name: row.name, id: row.id ?? null, kind: row.kind ?? null, type: row.type ?? null };
  const next = [keep, ...readRecent().filter((r) => r.uid !== keep.uid)].slice(0, RECENT_MAX);
  writeStored(RECENT_KEY, JSON.stringify(next));
  return next;
}

/**
 * Everything the palette lists, in order, as one flat list so the arrow keys walk all of it.
 * Groups: Recent (only while the box is empty), Go to (tabs), Items (search results), Search.
 */
export function buildPaletteItems({ term = "", tabs = [], recents = [], results = [] }) {
  const t = term.trim().toLowerCase();
  const items = [];

  if (!t) {
    for (const row of recents) items.push({ type: "entity", group: "Recent", key: `recent:${row.uid}`, row });
    for (const tab of tabs) items.push({ type: "tab", group: "Go to", key: `tab:${tab.key}`, tab });
    return items;
  }

  tabs
    .filter((tab) => tab.label.toLowerCase().includes(t) || tab.key.toLowerCase().includes(t))
    .slice(0, TAB_MATCH_MAX)
    .forEach((tab) => items.push({ type: "tab", group: "Go to", key: `tab:${tab.key}`, tab }));
  for (const row of results) items.push({ type: "entity", group: "Items", key: `item:${row.uid}`, row });
  if (t.length >= MIN_TERM) items.push({ type: "oql", group: "Search", key: "oql", term: term.trim() });
  return items;
}

function itemLabel(item) {
  if (item.type === "tab") return item.tab.label;
  if (item.type === "oql") return `Search all pillars for "${item.term}"`;
  return item.row.name || item.row.id || "(unnamed)";
}

function itemDetail(item) {
  if (item.type === "tab") return item.tab.group || "Page";
  if (item.type === "oql") return "OQL";
  const where = item.row.kind || item.row.type;
  return [item.row.pillarLabel || item.row.pillar, where].filter(Boolean).join(" · ");
}

function itemIcon(item, tabsByKey) {
  if (item.type === "tab") return item.tab.icon || "layers";
  if (item.type === "oql") return "sliders";
  if (item.group === "Recent") return "clock";
  return tabsByKey.get(item.row.pillar)?.icon || "layers";
}

function shortcutLabel() {
  const platform = typeof navigator === "undefined" ? "" : (navigator.userAgentData?.platform || navigator.platform || "");
  return /mac/i.test(platform) ? "⌘K" : "Ctrl K";
}

export function CommandPalette({ open, onClose, tabs = [], onNavigate, load = invoke }) {
  const [term, setTerm] = React.useState("");
  const [results, setResults] = React.useState([]);
  const [unavailable, setUnavailable] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [failure, setFailure] = React.useState("");
  const [active, setActive] = React.useState(0);
  const [recents, setRecents] = React.useState(readRecent);
  const inputRef = React.useRef(null);
  const listRef = React.useRef(null);
  const requestId = React.useRef(0);
  const tabsByKey = React.useMemo(() => new Map(tabs.map((tab) => [tab.key, tab])), [tabs]);

  // Fresh each time it opens; focus goes back where it was when it closes.
  React.useEffect(() => {
    if (!open) return undefined;
    const previous = typeof document !== "undefined" ? document.activeElement : null;
    setTerm("");
    setResults([]);
    setUnavailable([]);
    setFailure("");
    setActive(0);
    setRecents(readRecent());
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (previous && typeof previous.focus === "function") previous.focus();
    };
  }, [open]);

  // Debounced search; a slower, older response never overwrites a newer one.
  React.useEffect(() => {
    if (!open) return undefined;
    const t = term.trim();
    if (t.length < MIN_TERM) {
      requestId.current += 1;
      setResults([]);
      setUnavailable([]);
      setLoading(false);
      setFailure("");
      return undefined;
    }
    const id = ++requestId.current;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const response = await load("searchEntities", { term: t, limit: ENTITY_LIMIT });
        if (id !== requestId.current) return;
        setResults(response?.results || []);
        setUnavailable(response?.unavailable || []);
        setFailure("");
      } catch (err) {
        if (id !== requestId.current) return;
        setResults([]);
        setFailure(err?.message || "Search could not run.");
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [term, open, load]);

  const items = React.useMemo(() => buildPaletteItems({ term, tabs, recents, results }), [term, tabs, recents, results]);
  React.useEffect(() => { setActive(0); }, [term, results]);

  // Keep the highlighted row in view as the arrow keys move it.
  React.useEffect(() => {
    const node = listRef.current?.querySelector(`[data-index="${active}"]`);
    if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  function choose(item) {
    if (!item) return;
    if (item.type === "tab") {
      onNavigate(item.tab.key);
    } else if (item.type === "oql") {
      onNavigate("search", { query: oqlForTerm(item.term) });
    } else {
      setRecents(pushRecent(item.row));
      onNavigate(item.row.pillar, entityIntent(item.row));
    }
    onClose();
  }

  function onKeyDown(event) {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (!items.length) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => (i + 1) % items.length); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => (i <= 0 ? items.length - 1 : i - 1)); return; }
    if (event.key === "Home") { event.preventDefault(); setActive(0); return; }
    if (event.key === "End") { event.preventDefault(); setActive(items.length - 1); return; }
    if (event.key === "Enter") { event.preventDefault(); choose(items[active]); }
  }

  const searching = term.trim().length >= MIN_TERM;
  const emptyResults = searching && !loading && !failure && results.length === 0;

  return (
    <div className="command-palette__overlay" onMouseDown={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Jump to"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-palette__search">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-autocomplete="list"
            aria-activedescendant={items[active] ? `command-palette-item-${active}` : undefined}
            aria-label="Jump to a page or item"
            placeholder="Jump to a page, field, workflow, screen, filter, person…"
            spellCheck={false}
            autoComplete="off"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {loading && <span className="command-palette__status" role="status">Searching…</span>}
        </div>

        <ul className="command-palette__list" id="command-palette-list" role="listbox" aria-label="Results" ref={listRef}>
          {items.map((item, index) => {
            const heading = index === 0 || items[index - 1].group !== item.group;
            return (
              <React.Fragment key={item.key}>
                {heading && <li className="command-palette__group" role="presentation">{item.group}</li>}
                <li
                  id={`command-palette-item-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={index === active}
                  className={`command-palette__item${index === active ? " is-active" : ""}`}
                  onMouseMove={() => { if (index !== active) setActive(index); }}
                  // mousedown, not click: it must win before anything else takes focus.
                  onMouseDown={(event) => { event.preventDefault(); choose(item); }}
                >
                  <span className="command-palette__icon" aria-hidden="true"><Icon name={itemIcon(item, tabsByKey)} size={14} /></span>
                  <span className="command-palette__label">{itemLabel(item)}</span>
                  <span className="command-palette__detail">{itemDetail(item)}</span>
                </li>
              </React.Fragment>
            );
          })}
        </ul>

        {(emptyResults || failure || (searching && unavailable.length > 0)) && (
          <div className="command-palette__notes">
            {failure && <p className="command-palette__note command-palette__note--error">{failure}</p>}
            {emptyResults && <p className="command-palette__note">No items named "{term.trim()}". Try the OQL search above for more.</p>}
            {searching && unavailable.length > 0 && (
              <p className="command-palette__note">
                Not searched (not built yet or unreadable): {unavailable.map((p) => p.label || p.key).join(", ")}.
              </p>
            )}
          </div>
        )}

        <div className="command-palette__footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
          <span className="command-palette__shortcut">{shortcutLabel()} to open anywhere</span>
        </div>
      </div>
    </div>
  );
}

export { shortcutLabel as paletteShortcutLabel };
