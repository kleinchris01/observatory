import React from "react";
import { invoke } from "@forge/bridge";
import { formatNumber, formatRelativeTime } from "../utils";
import { Icon } from "../components/Icons";
import { StatTile, StatRow, Panel, EmptyState, Chip, PageHeader, PanelGrid, BarList } from "../components/ui";
import { SubNavLayout } from "../components/admin/primitives";
import { useVisiblePolling } from "../hooks";

// The People pillar: the who, not just the what.
//
// The roster is every member of the site's application-access groups, read live from
// GET /rest/api/3/applicationrole -- so "licensed" needs no admin configuration. This first
// slice is the catalog and the seat numbers; project roles, activity and the ownership joins
// (filters / dashboards / automation) land in follow-ups.

const BUILD_POLL_MS = 3000;
const STALE_AFTER_DAYS = 7;

function daysSince(iso) {
  const at = Date.parse(iso || "");
  if (!Number.isFinite(at)) return null;
  return (Date.now() - at) / (24 * 60 * 60 * 1000);
}

function shortProduct(key) {
  return String(key || "")
    .replace(/^jira-/, "")
    .replace("servicedesk", "service management")
    .replace("core", "work management")
    .replace("product-discovery", "product discovery");
}

function UserRow({ user }) {
  return (
    <div className="issue-type-row">
      <div className="issue-type-row__identity">
        <span className="issue-type-row__name">{user.displayName}</span>
        <span className="issue-type-row__desc">
          {user.groups.length
            ? `via ${user.groups.map((g) => g.name).join(", ")}`
            : "no access group recorded"}
        </span>
      </div>
      <div className="issue-type-row__meta">
        {user.applications.map((p) => (
          <Chip key={p.key} tone="neutral" title={`Licensed for ${p.name}`}>{shortProduct(p.key)}</Chip>
        ))}
        {user.accountType === "app" && (
          <Chip tone="warning" title="This account is an app, not a person">app</Chip>
        )}
        {!user.active && <Chip tone="critical" title="Deactivated in Jira">inactive</Chip>}
      </div>
    </div>
  );
}

export function PeopleTab() {
  const [view, setView] = React.useState("overview");
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [building, setBuilding] = React.useState(false);
  const [search, setSearch] = React.useState("");

  const load = React.useCallback(async () => {
    try {
      const result = await invoke("getUserInventory", {});
      setData(result);
      setError("");
    } catch (err) {
      setError(err?.message || "Failed to load the people inventory.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const isBuilding = ["building", "queued"].includes(data?.state) && !data?.staleBuild;
  useVisiblePolling(isBuilding, load, BUILD_POLL_MS);

  async function startBuild() {
    setBuilding(true);
    setError("");
    setNotice("");
    try {
      const result = await invoke("buildUserInventory", {});
      if (result?.error) {
        setError(result.error);
      } else if (result?.reason === "already-building") {
        setNotice("A build is already running. This page refreshes itself while it does.");
      } else {
        setNotice("Build queued. This page refreshes itself while it runs.");
      }
      await load();
    } catch (err) {
      setError(err?.message || "Failed to queue the build.");
    } finally {
      setBuilding(false);
    }
  }

  const buildAction = (
    <button type="button" className="secondary-button" onClick={startBuild} disabled={building || isBuilding}>
      <Icon name="refreshCw" size={13} />
      {isBuilding ? "Building…" : data?.neverBuilt ? "Build roster" : "Rebuild"}
    </button>
  );

  if (loading && !data) {
    return <div className="empty-state">Loading the people inventory…</div>;
  }

  if (data?.neverBuilt) {
    return (
      <div className="admin-people">
        <PageHeader
          title="People"
          description="Every licensed Jira user on the site, from the members of your application-access groups."
          actions={buildAction}
        />
        {error && <div className="danger-zone__error" role="alert">{error}</div>}
        {notice && !error && <p className="admin-config-row__hint" role="status">{notice}</p>}
        {data?.lastError && !isBuilding && (
          <div className="danger-zone__error" role="alert">Last build failed: {data.lastError}</div>
        )}
        {data?.staleBuild && (
          <p className="admin-config-row__hint">A build was started but is no longer running. Rebuild to recover it.</p>
        )}
        {isBuilding ? (
          <Panel title="Building the first roster" icon="refreshCw">
            <p>
              Reading the site's application roles, then enumerating the members of every
              access group. This page refreshes itself; you can leave it.
            </p>
            {data?.startedAt && <p className="admin-config-row__hint">Started {formatRelativeTime(data.startedAt)}.</p>}
          </Panel>
        ) : (
          <EmptyState action={buildAction}>
            No licensed-user roster has been built yet. Build it here — it needs the Jira admin
            permission the rest of this page already requires.
          </EmptyState>
        )}
      </div>
    );
  }

  const g = data?.governance || null;
  const summary = data?.applicationSummary || [];
  const buildAgeDays = daysSince(data?.refreshedAt);
  const isStale = buildAgeDays != null && buildAgeDays > STALE_AFTER_DAYS;

  const seatsUsed = summary.reduce((sum, s) => sum + (Number(s.userCount) || 0), 0);
  const seatsTotal = summary.reduce(
    (sum, s) => sum + (s.hasUnlimitedSeats ? 0 : (Number(s.numberOfSeats) || 0)),
    0
  );

  const roster = (() => {
    const term = search.trim().toLowerCase();
    const all = data?.users || [];
    if (!term) return all;
    return all.filter((u) =>
      u.displayName.toLowerCase().includes(term) ||
      u.accountId.toLowerCase().includes(term) ||
      u.applications.some((p) => shortProduct(p.key).includes(term)) ||
      u.groups.some((gr) => gr.name.toLowerCase().includes(term)));
  })();

  const items = [
    { key: "overview", label: "Overview", icon: "barChart" },
    { key: "roster", label: "Roster", icon: "user", badge: formatNumber(data?.users?.length ?? 0) },
  ];

  return (
    <div className="admin-people">
      <PageHeader
        title="People"
        description="Licensed Jira users, from application-access group membership. Read-only — access changes stay in Jira's admin UI."
        meta={data?.refreshedAt ? `Built ${formatRelativeTime(data.refreshedAt)}` : "Never built"}
        actions={buildAction}
      />

      {error && <div className="danger-zone__error" role="alert">{error}</div>}
      {notice && !error && <p className="admin-config-row__hint" role="status">{notice}</p>}
      {isBuilding && <p className="admin-config-row__hint">Building the roster… this page refreshes itself.</p>}
      {data?.staleBuild && (
        <p className="admin-config-row__hint">A build was started but is no longer running. Rebuild to recover it.</p>
      )}
      {data?.lastError && !isBuilding && (
        <div className="danger-zone__error" role="alert">Last build failed: {data.lastError}</div>
      )}

      <StatRow>
        <StatTile label="Licensed users" value={formatNumber(g?.totalUsers ?? data?.users?.length ?? 0)} hint="Across every access group" icon="user" />
        <StatTile
          label="Seats used"
          value={seatsTotal > 0 ? `${formatNumber(seatsUsed)} / ${formatNumber(seatsTotal)}` : formatNumber(seatsUsed)}
          hint={seatsTotal > 0 ? "Product seats reported by Jira" : "Jira did not report a seat cap"}
          icon="checkCircle"
        />
        <StatTile label="Multi-product" value={formatNumber(g?.multiProductUsers ?? 0)} hint="Hold more than one product licence" icon="layers" />
        <StatTile
          label="App accounts"
          value={formatNumber(g?.appUsers ?? 0)}
          hint={(g?.appUsers ?? 0) > 0 ? "Non-human accounts in an access group" : "No app accounts hold a licence"}
          tone={(g?.appUsers ?? 0) > 0 ? "warning" : "success"}
          icon="alertTriangle"
        />
      </StatRow>

      {isStale && (
        <Panel title="This roster is stale" icon="alertTriangle">
          <p>
            It was built {Math.floor(buildAgeDays)} days ago. Rebuild here to pick up new or
            removed licences.
          </p>
        </Panel>
      )}

      <SubNavLayout items={items} activeKey={view} onSelect={setView}>
        {view === "overview" && (
          <PanelGrid>
            <Panel
              title="Seats by product"
              icon="barChart"
              description="Straight from GET /rest/api/3/applicationrole — the site's own seat numbers."
            >
              {summary.length ? (
                <BarList
                  items={summary.map((s) => ({
                    label: s.name || shortProduct(s.key),
                    count: Number(s.userCount) || 0,
                    hint: s.hasUnlimitedSeats
                      ? "unlimited seats"
                      : s.numberOfSeats != null
                        ? `${formatNumber(s.userCount || 0)} of ${formatNumber(s.numberOfSeats)}`
                        : null,
                  }))}
                  labelKey="label"
                  valueKey="count"
                  formatValue={(v) => formatNumber(v)}
                  emptyMessage="No application roles were returned."
                />
              ) : (
                <EmptyState inline>No application roles were returned for this site.</EmptyState>
              )}
            </Panel>

            <Panel
              title="Licences held per user"
              icon="layers"
              description="How many users hold one product versus several — the seats worth reviewing first."
            >
              <BarList
                items={[
                  { label: "One product", count: Math.max(0, (g?.totalUsers ?? 0) - (g?.multiProductUsers ?? 0)) },
                  { label: "Multiple products", count: g?.multiProductUsers ?? 0 },
                ]}
                labelKey="label"
                valueKey="count"
                formatValue={(v) => formatNumber(v)}
                emptyMessage="No roster yet."
              />
            </Panel>
          </PanelGrid>
        )}

        {view === "roster" && (
          <Panel
            title="Licensed users"
            icon="user"
            description="Everyone in an access group, with the products they hold and the group they hold them through."
            actions={
              <input
                type="search"
                className="admin-jobs-search__input"
                placeholder="Filter by name, product or group…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            }
          >
            {roster.length ? (
              <div className="issue-type-list">
                {roster.map((user) => <UserRow key={user.accountId} user={user} />)}
              </div>
            ) : (
              <EmptyState inline>{search ? "No users match that filter." : "No licensed users in this roster."}</EmptyState>
            )}
          </Panel>
        )}
      </SubNavLayout>
    </div>
  );
}
