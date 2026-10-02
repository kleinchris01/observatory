import React from "react";
import { invoke, view } from "@forge/bridge";
import { openFieldExpertRovo, buildFieldRovoPrompt, buildProjectRovoPrompt, buildReportRovoPrompt } from "../utils";
import { Icon } from "../components/Icons";
import { Chip, EmptyState, SortFilterBar } from "../components/ui";
import { useNavIntent } from "../hooks";
import { FieldCard } from "../components/FieldCard";

// The custom field inventory: filters, findings and per-field detail.

// The four finding categories, as the active-filter chip words them. Shared with the
// findings chip row below so the two can never disagree about what a filter is called.
const FINDINGS_FILTER_LABELS = {
  "admin-attention": "Admin attention",
  risky: "Risk",
  cleanup: "Cleanup",
  standardize: "Standardize",
  // Specific reason codes the Overview's promoted findings deep-link with, alongside the
  // four coarse categories above -- same map, since a chip does not care which kind of
  // string produced it, only that it has a readable label instead of a raw code.
  "global-context-low-usage": "Global context, low usage",
  "dead-configuration": "Dead configuration",
  "orphaned,configured-no-issues": "No populated issues",
  stale: "Stale",
  "context-sprawl": "Context sprawl",
  "missing-description": "Missing description",
};
const FIELD_SORT_OPTIONS = [
  { value: "name-asc", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" },
  { value: "usage-desc", label: "Most issues with value" },
  { value: "usage-asc", label: "Fewest issues with value" },
  { value: "active-projects-desc", label: "Most active projects" },
  { value: "active-projects-asc", label: "Fewest active projects" },
  { value: "contexts-desc", label: "Most contexts" },
  { value: "contexts-asc", label: "Fewest contexts" },
  { value: "priority-desc", label: "Highest priority" },
];

// The largest single tab, and the one most worth testing in isolation.

export function FieldBrowserTab({ selectedFieldIds = [], onToggleField, onSetSelectedFieldIds, onGoToReport, siteOrigin, intent = null }) {
  const selectedSet = React.useMemo(() => new Set(selectedFieldIds), [selectedFieldIds]);
  const [pageSize, setPageSize] = React.useState(() => {
    const saved = Number(localStorage.getItem("admin-field-pagesize"));
    return [10, 25, 50].includes(saved) ? saved : 25;
  });
  const [query, setQuery] = React.useState("");
  const [deferredQuery, setDeferredQuery] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState("all");
  const [fieldOrigin, setFieldOrigin] = React.useState("all");
  const [findingsFilter, setFindingsFilter] = React.useState("all");
  const [sortBy, setSortBy] = React.useState("usage-desc");
  const [page, setPage] = React.useState(1);

  // Advanced filters
  const [projectUsageFilter, setProjectUsageFilter] = React.useState("all");
  const [hasDescription, setHasDescription] = React.useState("all");
  const [duplicateNamesOnly, setDuplicateNamesOnly] = React.useState(false);
  // Independent of the origin dropdown: "User-created" already excludes system fields, but
  // also excludes Jira-provided custom fields the reader may still want visible. This asks
  // for "hide the ones that ship on every issue" without also hiding everything else.
  const [hideSystemFields, setHideSystemFields] = React.useState(false);
  const [minIssues, setMinIssues] = React.useState("");
  const [maxIssues, setMaxIssues] = React.useState("");
  const [minActiveProjects, setMinActiveProjects] = React.useState("");
  const [maxActiveProjects, setMaxActiveProjects] = React.useState("");
  const [minContexts, setMinContexts] = React.useState("");
  const [maxContexts, setMaxContexts] = React.useState("");
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const filterPanelRef = React.useRef(null);

  // Automation rule counts for the fields currently on screen.
  //
  // Fetched per page in one call rather than per card: the counts sit on the collapsed
  // header, so every row needs them before anything is expanded, and ten separate lookups
  // would each re-read the same index. Failure is silent -- the chips are supplementary,
  // and an automation analysis that has never been built is the normal fresh-install state,
  // not an error worth interrupting the field list for.
  const [automationCounts, setAutomationCounts] = React.useState({});

  // Screen counts for the same page, fetched the same way and for the same reason.
  //
  // Held as the whole response rather than just the map: the card has to be able to tell
  // "this field is on no screen" from "no screen inventory exists", and only the envelope
  // carries that. A bare {} would collapse both into an em dash with no explanation.
  const [screenCounts, setScreenCounts] = React.useState({ available: false, counts: {} });
  const [filterCounts, setFilterCounts] = React.useState({ available: false, counts: {} });
  const [dashboardGadgetCounts, setDashboardGadgetCounts] = React.useState({ available: false, counts: {} });

  React.useEffect(() => {
    if (!filtersOpen) return;
    function handleClickOutside(e) {
      if (filterPanelRef.current && !filterPanelRef.current.contains(e.target)) {
        setFiltersOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [filtersOpen]);

  const [deferredMinIssues, setDeferredMinIssues] = React.useState("");
  const [deferredMaxIssues, setDeferredMaxIssues] = React.useState("");
  const [deferredMinActiveProjects, setDeferredMinActiveProjects] = React.useState("");
  const [deferredMaxActiveProjects, setDeferredMaxActiveProjects] = React.useState("");
  const [deferredMinContexts, setDeferredMinContexts] = React.useState("");
  const [deferredMaxContexts, setDeferredMaxContexts] = React.useState("");
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState("");
  const [openFieldId, setOpenFieldId] = React.useState(null);
  const [fieldDetails, setFieldDetails] = React.useState({});
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState("");
  const [rovoEnabled, setRovoEnabled] = React.useState(false);

  React.useEffect(() => {
    view.getContext().then(() => setRovoEnabled(true)).catch(() => {});
  }, []);

  React.useEffect(() => {
    const t = setTimeout(() => { setDeferredQuery(query); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [query]);

  // Debounce the numeric range filters the same way the search query is debounced,
  // so typing in a min/max box doesn't fire a request per keystroke.
  React.useEffect(() => {
    const t = setTimeout(() => {
      setDeferredMinIssues(minIssues);
      setDeferredMaxIssues(maxIssues);
      setDeferredMinActiveProjects(minActiveProjects);
      setDeferredMaxActiveProjects(maxActiveProjects);
      setDeferredMinContexts(minContexts);
      setDeferredMaxContexts(maxContexts);
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [minIssues, maxIssues, minActiveProjects, maxActiveProjects, minContexts, maxContexts]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    invoke("getFieldInventory", {
      query: deferredQuery,
      type: typeFilter,
      fieldOrigin,
      findingsFilter,
      sortBy,
      page,
      pageSize,
      projectUsageFilter,
      hasDescription,
      duplicateNamesOnly,
      hideSystemFields,
      minIssuesWithValue: deferredMinIssues,
      maxIssuesWithValue: deferredMaxIssues,
      minActiveProjects: deferredMinActiveProjects,
      maxActiveProjects: deferredMaxActiveProjects,
      minContexts: deferredMinContexts,
      maxContexts: deferredMaxContexts,
    }).then((result) => {
      if (!cancelled) setData(result);
    }).catch((err) => {
      if (!cancelled) setLoadError(err.message || "Failed to load field inventory.");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [
    deferredQuery,
    typeFilter,
    fieldOrigin,
    findingsFilter,
    sortBy,
    page,
    pageSize,
    projectUsageFilter,
    hasDescription,
    duplicateNamesOnly,
    hideSystemFields,
    deferredMinIssues,
    deferredMaxIssues,
    deferredMinActiveProjects,
    deferredMaxActiveProjects,
    deferredMinContexts,
    deferredMaxContexts,
  ]);

  function openField(fieldId) {
    if (openFieldId === fieldId) { setOpenFieldId(null); return; }
    setOpenFieldId(fieldId);
    setDetailError("");
    if (!fieldDetails[fieldId]) {
      setDetailLoading(true);
      invoke("getFieldDetails", { fieldId, usagePage: 1 }).then((result) => {
        setFieldDetails((prev) => ({ ...prev, [fieldId]: result }));
      }).catch((err) => {
        setDetailError(err.message || "Failed to load field details.");
      }).finally(() => setDetailLoading(false));
    }
  }

  function loadDetailPage(fieldId, pg) {
    setDetailLoading(true);
    invoke("getFieldDetails", { fieldId, usagePage: pg }).then((result) => {
      setFieldDetails((prev) => ({ ...prev, [fieldId]: result }));
    }).catch((err) => {
      setDetailError(err.message || "Failed to load.");
    }).finally(() => setDetailLoading(false));
  }

  function refreshProjectUsage(fieldId, pg) {
    loadDetailPage(fieldId, pg);
  }

  const [selectingAll, setSelectingAll] = React.useState(false);

  async function selectAllFiltered() {
    setSelectingAll(true);
    try {
      const result = await invoke("getFilteredFieldIds", {
        query: deferredQuery,
        type: typeFilter,
        fieldOrigin,
        findingsFilter,
        sortBy,
        projectUsageFilter,
        hasDescription,
        duplicateNamesOnly,
        hideSystemFields,
        minIssuesWithValue: deferredMinIssues,
        maxIssuesWithValue: deferredMaxIssues,
        minActiveProjects: deferredMinActiveProjects,
        maxActiveProjects: deferredMaxActiveProjects,
        minContexts: deferredMinContexts,
        maxContexts: deferredMaxContexts,
      });
      onSetSelectedFieldIds?.(result.fieldIds || []);
    } catch {
      // silently fail — user can select manually
    } finally {
      setSelectingAll(false);
    }
  }

  const activeFilterCount = React.useMemo(() => {
    let count = 0;
    if (fieldOrigin !== "all") count++;
    if (projectUsageFilter !== "all") count++;
    if (hasDescription !== "all") count++;
    if (duplicateNamesOnly === true) count++;
    if (hideSystemFields === true) count++;
    if (minIssues !== "") count++;
    if (maxIssues !== "") count++;
    if (minActiveProjects !== "") count++;
    if (maxActiveProjects !== "") count++;
    if (minContexts !== "") count++;
    if (maxContexts !== "") count++;
    return count;
  }, [
    fieldOrigin,
    projectUsageFilter,
    hasDescription,
    duplicateNamesOnly,
    minIssues,
    maxIssues,
    minActiveProjects,
    maxActiveProjects,
    minContexts,
    maxContexts,
  ]);

  function clearAllFilters() {
    setTypeFilter("all");
    setFieldOrigin("all");
    setProjectUsageFilter("all");
    setHasDescription("all");
    setDuplicateNamesOnly(false);
    setHideSystemFields(false);
    setMinIssues("");
    setMaxIssues("");
    setMinActiveProjects("");
    setMaxActiveProjects("");
    setMinContexts("");
    setMaxContexts("");
    setDeferredMinIssues("");
    setDeferredMaxIssues("");
    setDeferredMinActiveProjects("");
    setDeferredMaxActiveProjects("");
    setDeferredMinContexts("");
    setDeferredMaxContexts("");
    setQuery("");
    setDeferredQuery("");
    setFindingsFilter("all");
    setPage(1);
  }

  const fields = data?.fields || [];

  // Keyed on the field ids currently rendered, so paging or refiltering refetches and
  // switching back to a page already seen does not.
  const pageFieldKey = fields.map((f) => f.id).join(",");
  React.useEffect(() => {
    if (!fields.length) return undefined;
    let cancelled = false;
    invoke("getAutomationFieldCounts", { fields: fields.map((f) => ({ id: f.id, name: f.name })) })
      .then((result) => { if (!cancelled) setAutomationCounts(result?.counts || {}); })
      .catch(() => { if (!cancelled) setAutomationCounts({}); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageFieldKey]);

  React.useEffect(() => {
    if (!fields.length) return undefined;
    let cancelled = false;
    // Name AND id, because JQL names most fields by name and reaches the rest through
    // cf[10001]. The resolver folds both back onto the field id.
    invoke("getFieldFilterCounts", { fields: fields.map((f) => ({ id: f.id, name: f.name })) })
      .then((result) => { if (!cancelled) setFilterCounts(result || { available: false, counts: {} }); })
      // Silent, like the two above: an unbuilt filter inventory is the normal fresh-install
      // state, and the chip renders that as unknown rather than as zero.
      .catch(() => { if (!cancelled) setFilterCounts({ available: false, counts: {} }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageFieldKey]);

  React.useEffect(() => {
    if (!fields.length) return undefined;
    let cancelled = false;
    invoke("getFieldScreenCounts", { fieldIds: fields.map((f) => f.id) })
      .then((result) => { if (!cancelled) setScreenCounts(result || { available: false, counts: {} }); })
      // Silent, like the automation counts above: an unbuilt screen inventory is the normal
      // fresh-install state, and the chip already renders that as unknown rather than zero.
      .catch(() => { if (!cancelled) setScreenCounts({ available: false, counts: {} }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageFieldKey]);

  React.useEffect(() => {
    if (!fields.length) return undefined;
    let cancelled = false;
    // Bulk, like the filter counts above: field -> filter ids -> gadgets, answered for a
    // whole page at once rather than the per-field chain the expanded card section uses.
    invoke("getFieldDashboardCounts", { fields: fields.map((f) => ({ id: f.id, name: f.name })) })
      .then((result) => { if (!cancelled) setDashboardGadgetCounts(result || { available: false, counts: {} }); })
      .catch(() => { if (!cancelled) setDashboardGadgetCounts({ available: false, counts: {} }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageFieldKey]);

  const totalPages = data?.totalPages || 1;
  const total = data?.total || 0;
  const availableTypes = data?.availableTypes || [];
  const summary = data?.findingsSummary || { adminAttention: 0, risky: 0, cleanup: 0, standardize: 0 };

  const startItem = total > 0 ? (page - 1) * pageSize + 1 : 0;
  const endItem = Math.min(page * pageSize, total);

  // Arrived from an Overview finding: show the fields it counted, not page one of 1,615.
  //
  // The finding names an exact set -- "123 fields need admin attention" -- and the chip it
  // maps to already existed here. What was missing was the hop: clicking the count opened
  // this tab unfiltered and left the reader to find the 123 by hand.
  useNavIntent(intent, (nav) => {
    // Ctrl+K lands here with the field's name -- applied at once, not after the debounce.
    if (nav.search != null) {
      setQuery(nav.search);
      setDeferredQuery(nav.search);
      setPage(1);
    }
    if (!nav.findings) return;
    setFindingsFilter(nav.findings);
    setPage(1);
  });

  const findingsChips = [
    { key: "all", label: "All fields" },
    { key: "admin-attention", label: "Admin attention", count: summary.adminAttention },
    { key: "risky", label: "Risk", count: summary.risky },
    { key: "cleanup", label: "Cleanup", count: summary.cleanup },
    { key: "standardize", label: "Standardize", count: summary.standardize },
  ];

  function PaginationBar({ top }) {
    return (
      <div className={`admin-field-browser__pagebar${top ? " admin-field-browser__pagebar--top" : ""}`}>
        <span className="admin-pagination__info">
          {total > 0
            ? `Showing ${startItem}–${endItem} of ${total.toLocaleString()} fields`
            : loading ? "Loading…" : "No fields match the current filter"}
        </span>
        {top && (
          <div className="admin-field-browser__pagesize">
            <span>Per page:</span>
            {[10, 25, 50].map((n) => (
              <button
                key={n}
                type="button"
                className={`admin-field-browser__pagesize-btn${pageSize === n ? " admin-field-browser__pagesize-btn--active" : ""}`}
                onClick={() => { localStorage.setItem("admin-field-pagesize", n); setPageSize(n); setPage(1); }}
              >{n}</button>
            ))}
          </div>
        )}
        <div className="admin-field-browser__page-nav">
          <button disabled={page <= 1} className="secondary-button secondary-button--small" type="button" onClick={() => setPage(1)}>First</button>
          <button disabled={page <= 1} className="secondary-button secondary-button--small" type="button" onClick={() => setPage((p) => p - 1)}>Previous</button>
          <button disabled={page >= totalPages} className="secondary-button secondary-button--small" type="button" onClick={() => setPage((p) => p + 1)}>Next</button>
          <button disabled={page >= totalPages} className="secondary-button secondary-button--small" type="button" onClick={() => setPage(totalPages)}>Last</button>
        </div>
      </div>
    );
  }

  // Build active filter chips list
  const activeFilterChips = React.useMemo(() => {
    const chips = [];
    if (fieldOrigin !== "all") {
      const label = fieldOrigin === "user-created" ? "User-created" : "Jira built-in";
      chips.push({ id: "fieldOrigin", label: `Origin: ${label}`, clear: () => { setFieldOrigin("all"); setPage(1); } });
    }
    if (projectUsageFilter !== "all") {
      const labels = { "not-built": "not-built", "built": "built", "building": "building", "incomplete": "incomplete" };
      chips.push({ id: "projectUsageFilter", label: `Build: ${labels[projectUsageFilter] || projectUsageFilter}`, clear: () => { setProjectUsageFilter("all"); setPage(1); } });
    }
    if (hasDescription !== "all") {
      chips.push({ id: "hasDescription", label: `Has description: ${hasDescription === "yes" ? "Yes" : "No"}`, clear: () => { setHasDescription("all"); setPage(1); } });
    }
    if (duplicateNamesOnly) {
      chips.push({ id: "duplicateNamesOnly", label: "Duplicate names only", clear: () => { setDuplicateNamesOnly(false); setPage(1); } });
    }
    if (hideSystemFields) {
      chips.push({ id: "hideSystemFields", label: "System fields hidden", clear: () => { setHideSystemFields(false); setPage(1); } });
    }
    if (minIssues !== "" || maxIssues !== "") {
      const range = [minIssues || "0", maxIssues || "∞"].join("–");
      chips.push({ id: "issues", label: `Issues: ${range}`, clear: () => { setMinIssues(""); setMaxIssues(""); setPage(1); } });
    }
    if (minActiveProjects !== "" || maxActiveProjects !== "") {
      const range = [minActiveProjects || "0", maxActiveProjects || "∞"].join("–");
      chips.push({ id: "activeProjects", label: `Active projects: ${range}`, clear: () => { setMinActiveProjects(""); setMaxActiveProjects(""); setPage(1); } });
    }
    if (minContexts !== "" || maxContexts !== "") {
      const range = [minContexts || "0", maxContexts || "∞"].join("–");
      chips.push({ id: "contexts", label: `Contexts: ${range}`, clear: () => { setMinContexts(""); setMaxContexts(""); setPage(1); } });
    }
    if (findingsFilter !== "all") {
      // Was hardcoded to "Admin attention" whichever filter was set, which is a lie the
      // moment a deep link can arrive with any of the four.
      const label = FINDINGS_FILTER_LABELS[findingsFilter] ?? findingsFilter;
      chips.push({ id: "findingsFilter", label: `Findings: ${label}`, clear: () => { setFindingsFilter("all"); setPage(1); } });
    }
    return chips;
  }, [fieldOrigin, projectUsageFilter, hasDescription, duplicateNamesOnly, hideSystemFields, minIssues, maxIssues, minActiveProjects, maxActiveProjects, minContexts, maxContexts, findingsFilter]);

  return (
    <div className="admin-field-browser">
      {/* Primary toolbar */}
      <div className="admin-field-browser__toolbar">
        <SortFilterBar
          search={query}
          onSearchChange={setQuery}
          searchLabel="Search fields"
          searchPlaceholder="Field name, ID, or description…"
          sort={sortBy}
          onSortChange={(value) => { setSortBy(value); setPage(1); }}
          sortOptions={FIELD_SORT_OPTIONS}
          filters={[{
            key: "type",
            label: "Type",
            value: typeFilter,
            onChange: (value) => { setTypeFilter(value); setPage(1); },
            options: [{ value: "all", label: "All types" }, ...availableTypes.map((t) => ({ value: t, label: t }))],
          }]}
          onClear={clearAllFilters}
        >
        <div className="admin-field-browser__filter-anchor" ref={filterPanelRef}>
          <button
            type="button"
            className={`admin-field-browser__filter-toggle${filtersOpen ? " admin-field-browser__filter-toggle--active" : ""}`}
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
          >
            Filters
            {activeFilterCount > 0 && (
              <span className="admin-field-browser__filter-badge">{activeFilterCount}</span>
            )}
          </button>

          {/* Floating filter popover */}
          {filtersOpen && (
            <div className="admin-field-browser__filter-panel">
              <div className="admin-field-browser__filter-group">
                <span className="admin-field-browser__filter-group-label">Origin &amp; status</span>
                <div className="admin-field-browser__filter-group-controls">
                  <select
                    aria-label="Field origin"
                    value={fieldOrigin}
                    onChange={(e) => { setFieldOrigin(e.target.value); setPage(1); }}
                  >
                    <option value="all">All fields</option>
                    <option value="user-created">User-created</option>
                    <option value="jira-builtin">Jira built-in</option>
                  </select>
                  <select
                    aria-label="Project usage build status"
                    value={projectUsageFilter}
                    onChange={(e) => { setProjectUsageFilter(e.target.value); setPage(1); }}
                  >
                    <option value="all">Any build status</option>
                    <option value="not-built">Not built</option>
                    <option value="built">Built</option>
                    <option value="building">Building</option>
                    <option value="incomplete">Incomplete</option>
                  </select>
                  <select
                    aria-label="Has description"
                    value={hasDescription}
                    onChange={(e) => { setHasDescription(e.target.value); setPage(1); }}
                  >
                    <option value="all">Description: any</option>
                    <option value="yes">Has description</option>
                    <option value="no">No description</option>
                  </select>
                  <label className="admin-field-browser__checkbox-label">
                    <input
                      type="checkbox"
                      checked={duplicateNamesOnly}
                      onChange={(e) => { setDuplicateNamesOnly(e.target.checked); setPage(1); }}
                    />
                    Duplicate names only
                  </label>
                  <label className="admin-field-browser__checkbox-label" title="Rank, Comment, Watches, and the rest of what ships on every issue type regardless of project or scheme -- never a customfield_ id, and never something a governance decision about a custom field applies to.">
                    <input
                      type="checkbox"
                      checked={hideSystemFields}
                      onChange={(e) => { setHideSystemFields(e.target.checked); setPage(1); }}
                    />
                    Hide system fields
                  </label>
                </div>
              </div>

              <div className="admin-field-browser__filter-group">
                <span className="admin-field-browser__filter-group-label">Issues with value</span>
                <div className="admin-field-browser__range-inputs">
                  <input
                    type="number"
                    min="0"
                    placeholder="Min"
                    aria-label="Minimum issues with value"
                    value={minIssues}
                    onChange={(e) => setMinIssues(e.target.value)}
                  />
                  <span className="admin-field-browser__range-sep">–</span>
                  <input
                    type="number"
                    min="0"
                    placeholder="Max"
                    aria-label="Maximum issues with value"
                    value={maxIssues}
                    onChange={(e) => setMaxIssues(e.target.value)}
                  />
                </div>
              </div>

              <div className="admin-field-browser__filter-group">
                <span className="admin-field-browser__filter-group-label">Active projects</span>
                <div className="admin-field-browser__range-inputs">
                  <input
                    type="number"
                    min="0"
                    placeholder="Min"
                    aria-label="Minimum active projects"
                    value={minActiveProjects}
                    onChange={(e) => setMinActiveProjects(e.target.value)}
                  />
                  <span className="admin-field-browser__range-sep">–</span>
                  <input
                    type="number"
                    min="0"
                    placeholder="Max"
                    aria-label="Maximum active projects"
                    value={maxActiveProjects}
                    onChange={(e) => setMaxActiveProjects(e.target.value)}
                  />
                </div>
              </div>

              <div className="admin-field-browser__filter-group">
                <span className="admin-field-browser__filter-group-label">Contexts</span>
                <div className="admin-field-browser__range-inputs">
                  <input
                    type="number"
                    min="0"
                    placeholder="Min"
                    aria-label="Minimum contexts"
                    value={minContexts}
                    onChange={(e) => setMinContexts(e.target.value)}
                  />
                  <span className="admin-field-browser__range-sep">–</span>
                  <input
                    type="number"
                    min="0"
                    placeholder="Max"
                    aria-label="Maximum contexts"
                    value={maxContexts}
                    onChange={(e) => setMaxContexts(e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
        </SortFilterBar>
        {activeFilterCount > 0 && (
          <button
            type="button"
            className="admin-field-browser__clear-filters"
            onClick={clearAllFilters}
          >
            Clear all
          </button>
        )}
      </div>

      {/* Active filter chips */}
      {activeFilterChips.length > 0 && (
        <div className="admin-field-browser__active-filters">
          {activeFilterChips.map((chip) => (
            <Chip key={chip.id} onRemove={chip.clear} removeLabel={`Remove filter ${chip.label}`}>
              {chip.label}
            </Chip>
          ))}
        </div>
      )}

      {/* Findings filter chips */}
      <div className="findings-filter-bar" style={{ marginTop: 4 }}>
        {findingsChips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            className={`findings-filter-button${findingsFilter === chip.key ? " findings-filter-button--active" : ""}`}
            onClick={() => { setFindingsFilter(chip.key); setPage(1); }}
          >
            <span>{chip.label}</span>
            {typeof chip.count === "number" ? <strong>{chip.count}</strong> : null}
          </button>
        ))}
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      <div className="admin-field-browser__report-bar">
        <span className="admin-field-browser__report-selection">
          {selectedFieldIds.length > 0
            ? `${selectedFieldIds.length} ${selectedFieldIds.length === 1 ? "field" : "fields"} selected for report`
            : "No fields selected"}
        </span>
        <div className="admin-field-browser__report-actions">
          <button
            className="secondary-button secondary-button--small"
            type="button"
            onClick={selectAllFiltered}
            disabled={selectingAll || loading || !total}
          >
            {selectingAll ? "Selecting…" : "Select filtered"}
          </button>
          {selectedFieldIds.length > 0 && (
            <button
              className="secondary-button secondary-button--small"
              type="button"
              onClick={() => onSetSelectedFieldIds?.([])}
            >
              Clear
            </button>
          )}
          <button
            className="primary-button"
            type="button"
            onClick={onGoToReport}
            disabled={!selectedFieldIds.length}
          >
            <Icon name="barChart" size={13} />
            {`Generate report (${selectedFieldIds.length})`}
          </button>
        </div>
      </div>

      <PaginationBar top />

      {loading && !fields.length ? (
        <EmptyState>Loading fields…</EmptyState>
      ) : fields.length === 0 && !loading ? (
        <EmptyState>No fields match the current filter.</EmptyState>
      ) : (
        <div className="admin-field-list">
          {fields.map((field) => {
            const isOpen = openFieldId === field.id;
            const detail = fieldDetails[field.id] || null;
            return (
              <FieldCard
                key={field.id}
                field={field}
                details={isOpen ? detail : null}
                expanded={isOpen}
                loading={isOpen && detailLoading && !detail}
                selected={selectedSet.has(field.id)}
                onSelectChange={(id, checked) => onToggleField?.(id, checked)}
                onToggle={() => openField(field.id)}
                onProjectUsagePageChange={loadDetailPage}
                onRefreshProjectUsage={refreshProjectUsage}
                // Positional arguments, NOT a wrapper object. buildReportRovoPrompt in the
                // same module does take a destructured object, and passing one here
                // instead produced a prompt reading "Field id: undefined. Field name:
                // undefined" with every count zeroed -- the field object ended up bound to
                // the `field` parameter's own `field` property, and `details` to nothing.
                // Rovo then answered confidently about a nonexistent "ghost field".
                onAskField={() => {
                  openFieldExpertRovo(buildFieldRovoPrompt(field, fieldDetails[field.id])).catch(() => {});
                }}
                onAskProject={(project) => {
                  openFieldExpertRovo(buildProjectRovoPrompt(field, fieldDetails[field.id], project)).catch(() => {});
                }}
                siteOrigin={siteOrigin}
                rovoEnabled={rovoEnabled}
                automationCounts={automationCounts[field.id]}
                screenCount={screenCounts.available ? (screenCounts.counts[field.id] ?? 0) : null}
                filterCount={filterCounts.available ? (filterCounts.counts[field.id] ?? 0) : null}
                dashboardGadgetCount={dashboardGadgetCounts.available ? (dashboardGadgetCounts.counts[field.id] ?? 0) : null}
                screenSnapshot={screenCounts}
              />
            );
          })}
        </div>
      )}

      {total > 0 && <PaginationBar />}
    </div>
  );
}
