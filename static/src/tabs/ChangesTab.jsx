import React from "react";
import { invoke } from "@forge/bridge";
import { formatNumber, formatRelativeTime, formatLogTime, buildRovoPrompt } from "../utils";
import { Icon } from "../components/Icons";
import {
  StatTile, StatRow, Panel, EmptyState, Chip, PageHeader, SortFilterBar, AskRovo,
} from "../components/ui";
import { useNavIntent, useVisiblePolling } from "../hooks";

// Configuration drift: what changed in the estate's configuration, and when.
//
// Every other tab shows the estate as it is now. This one is the diff between scans -- the
// drift stage digests each pillar's structural config every scan and appends the deltas to
// a timeline. Read-only; a change here is a fact that already happened in Jira.

const BUILD_POLL_MS = 3000;

const KIND_TONE = { added: "success", removed: "critical", modified: "active" };
const KIND_LABEL = { added: "added", removed: "removed", modified: "changed" };

function ChangeRow({ change, pillarLabel }) {
  return (
    <div className="change-row">
      <Chip tone={KIND_TONE[change.changeKind] || "neutral"}>{KIND_LABEL[change.changeKind] || change.changeKind}</Chip>
      <span className="change-row__summary">{change.summary || change.label || change.entityId}</span>
      <span className="change-row__meta">
        <Chip tone="neutral">{pillarLabel || change.pillar}</Chip>
        <span className="change-row__time" title={change.detectedAt}>{formatLogTime(change.detectedAt)}</span>
      </span>
    </div>
  );
}

// The timeline, grouped by calendar day so a burst of changes from one scan reads as one
// event rather than forty.
function groupByDay(changes) {
  const groups = [];
  let current = null;
  for (const c of changes) {
    const day = (c.detectedAt || "").slice(0, 10);
    if (!current || current.day !== day) {
      current = { day, changes: [] };
      groups.push(current);
    }
    current.changes.push(c);
  }
  return groups;
}

export function ChangesTab({ intent }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [building, setBuilding] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [pillar, setPillar] = React.useState("all");
  const [kind, setKind] = React.useState("all");
  const [extraPages, setExtraPages] = React.useState([]);
  const [loadingMore, setLoadingMore] = React.useState(false);

  useNavIntent(intent, (nav) => {
    if (nav.pillar) setPillar(nav.pillar);
    if (nav.kind) setKind(nav.kind);
    setSearch("");
  });

  const load = React.useCallback(async () => {
    try {
      const result = await invoke("getChangeHistory", { pillar, kind });
      setData(result);
      setExtraPages([]);
      setError("");
    } catch (err) {
      setError(err?.message || "Could not load the change history.");
    } finally {
      setLoading(false);
    }
  }, [pillar, kind]);

  React.useEffect(() => { load(); }, [load]);

  const isBuilding = ["building", "queued"].includes(data?.state) && !data?.staleBuild;
  useVisiblePolling(isBuilding, load, BUILD_POLL_MS);

  async function startBuild() {
    setBuilding(true);
    setError("");
    setNotice("");
    try {
      const result = await invoke("buildChangeHistory", {});
      await load();
      if (result?.error) {
        setError(result.error);
      } else if (result?.queued === false && result?.reason === "already-building") {
        setNotice("A drift pass is already running. This page refreshes itself while it does.");
      } else {
        setNotice("Drift pass queued. This page refreshes itself while it runs.");
      }
    } catch (err) {
      setError(err?.message || "Could not start the drift pass.");
    } finally {
      setBuilding(false);
    }
  }

  async function loadMore() {
    const pages = [data, ...extraPages];
    const cursor = pages[pages.length - 1]?.nextCursor;
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const next = await invoke("getChangeHistory", { pillar, kind, before: cursor });
      setExtraPages((p) => [...p, next]);
    } catch (err) {
      setError(err?.message || "Could not load more changes.");
    } finally {
      setLoadingMore(false);
    }
  }

  const buildAction = (
    <>
      <AskRovo
        agent="observatory-change-expert"
        scope="the configuration change history"
        context="the last drift-pass time and the recorded change counts by pillar and kind"
        disabled={Boolean(data?.neverBuilt)}
        buildPrompt={() =>
          buildRovoPrompt({
            task: "Summarise what has changed in the estate's configuration recently and which pillar has seen the most change.",
            facts: [["Last drift pass", data?.refreshedAt || "unknown"], ["Changes recorded last pass", data?.lastRunChanges ?? null], ["Total changes recorded", data?.totalChanges ?? null], ["Window (days)", data?.windowDays ?? null]],
          })
        }
      />
      <button type="button" className="secondary-button" onClick={startBuild} disabled={building || isBuilding}>
        <Icon name="refreshCw" size={13} />
      {isBuilding ? "Running…" : "Run drift pass"}
    </button>
    </>
  );

  if (loading && !data) {
    return <div className="empty-state">Loading the change history…</div>;
  }

  const header = (
    <PageHeader
      title="Changes"
      description="Every add, removal and edit to the estate's configuration, newest first — the diff between one scan and the next. Read-only."
      meta={data?.refreshedAt ? `Last pass ${formatRelativeTime(data.refreshedAt)}` : "Never run"}
      actions={buildAction}
    />
  );

  const banners = (
    <>
      {error && <div className="danger-zone__error" role="alert">{error}</div>}
      {notice && !error && <p className="admin-config-row__hint" role="status">{notice}</p>}
      {isBuilding && <p className="admin-config-row__hint">Diffing every pillar against the last pass… this page refreshes itself.</p>}
      {data?.staleBuild && (
        <p className="admin-config-row__hint">A drift pass was started but is no longer running. Run one to recover.</p>
      )}
      {data?.lastError && !isBuilding && (
        <div className="danger-zone__error" role="alert">Last pass failed: {data.lastError}</div>
      )}
    </>
  );

  const trackedPillars = data?.trackedPillars || [];
  const pillarLabel = (key) => trackedPillars.find((p) => p.key === key)?.label || key;

  if (data?.neverBuilt) {
    return (
      <div className="admin-changes">
        {header}
        {banners}
        {isBuilding ? (
          <Panel title="Running the first drift pass" icon="refreshCw">
            <p>
              Recording a digest of every scheme, status, field and filter as the baseline.
              This first pass finds nothing to report — the timeline starts from the next
              scan, when there is a previous state to diff against.
            </p>
          </Panel>
        ) : (
          <EmptyState action={buildAction}>
            No drift pass has run yet. It also runs at the end of every full and quick scan —
            or run one now to set the baseline. Tracked: {trackedPillars.map((p) => p.label).join(", ")}.
          </EmptyState>
        )}
      </div>
    );
  }

  const allChanges = [data, ...extraPages].flatMap((p) => p?.changes || []);
  const term = search.trim().toLowerCase();
  const filtered = term
    ? allChanges.filter((c) => (c.summary || "").toLowerCase().includes(term) || (c.label || "").toLowerCase().includes(term))
    : allChanges;
  const groups = groupByDay(filtered);
  const lastPage = extraPages[extraPages.length - 1] || data;
  const summary = data?.summary || { total: 0, byKind: { added: 0, removed: 0, modified: 0 } };

  const pillarFilterOptions = [
    { value: "all", label: "All pillars" },
    ...trackedPillars.map((p) => ({ value: p.key, label: p.label })),
  ];
  const kindFilterOptions = [
    { value: "all", label: "All kinds" },
    { value: "added", label: "Added" },
    { value: "removed", label: "Removed" },
    { value: "modified", label: "Changed" },
  ];

  return (
    <div className="admin-changes">
      {header}
      {banners}

      <StatRow>
        <StatTile
          label={`Changes · last ${data?.windowDays ?? 30}d`}
          value={formatNumber(summary.total)}
          hint="Across every tracked pillar"
          icon="activity"
        />
        <StatTile label="Added" value={formatNumber(summary.byKind?.added ?? 0)} tone="success" icon="check" />
        <StatTile label="Removed" value={formatNumber(summary.byKind?.removed ?? 0)} tone={(summary.byKind?.removed ?? 0) > 0 ? "critical" : "neutral"} icon="x" />
        <StatTile label="Changed" value={formatNumber(summary.byKind?.modified ?? 0)} tone="active" icon="refreshCw" />
      </StatRow>

      <Panel
        title="Timeline"
        icon="clock"
        description={`Grouped by day. ${data?.lastRunChanges ? `${formatNumber(data.lastRunChanges)} change${data.lastRunChanges === 1 ? "" : "s"} in the last pass.` : "Nothing in the last pass."}`}
      >
        <SortFilterBar
          search={search}
          onSearchChange={setSearch}
          searchLabel="Search changes"
          searchPlaceholder="Search by what changed…"
          filters={[
            { key: "pillar", label: "Pillar", value: pillar, onChange: setPillar, options: pillarFilterOptions, allValue: "all" },
            { key: "kind", label: "Kind", value: kind, onChange: setKind, options: kindFilterOptions, allValue: "all" },
          ]}
          resultCount={filtered.length}
          totalCount={allChanges.length}
          onClear={() => { setSearch(""); setPillar("all"); setKind("all"); }}
        />

        {groups.length === 0 ? (
          <EmptyState inline>
            {term || pillar !== "all" || kind !== "all"
              ? "No changes match these filters."
              : (data?.seededPillars?.length
                ? "No changes recorded yet. The baseline is set — the next scan will start the timeline."
                : "No configuration changes have been detected.")}
          </EmptyState>
        ) : (
          <div className="change-timeline">
            {groups.map((g) => (
              <section key={g.day} className="change-day">
                <h4 className="change-day__label">{g.day}</h4>
                <div className="change-day__list">
                  {g.changes.map((c) => (
                    <ChangeRow key={c.changeId} change={c} pillarLabel={pillarLabel(c.pillar)} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        {lastPage?.nextCursor && !term && (
          <div className="change-timeline__more">
            <button type="button" className="secondary-button" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load older changes"}
            </button>
          </div>
        )}
      </Panel>
    </div>
  );
}
