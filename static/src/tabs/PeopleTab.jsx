import React from "react";
import { invoke } from "@forge/bridge";
import { formatNumber, formatRelativeTime } from "../utils";
import { Icon } from "../components/Icons";
import { StatTile, StatRow, Panel, EmptyState, Chip, PageHeader, PanelGrid, GridSpan, PillarHealthPanel, BarList, SortFilterBar } from "../components/ui";
import { SubNavLayout } from "../components/admin/primitives";
import { useVisiblePolling } from "../hooks";

// The People pillar: the who, not just the what.
//
// The roster is every member of the site's application-access groups, read live from
// GET /rest/api/3/applicationrole -- so "licensed" needs no admin configuration. Each user
// carries their cross-pillar footprint: the filters, dashboards and automation rules they
// own, joined from those pillars' snapshots. Project roles and per-issue activity are still
// to come.

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

function ownsCount(user) {
  return (Number(user.ownedFilters) || 0) + (Number(user.ownedDashboards) || 0) + (Number(user.authoredRules) || 0);
}

function ownsSummary(user) {
  const parts = [];
  if (user.ownedFilters) parts.push(`${user.ownedFilters} filter${user.ownedFilters === 1 ? "" : "s"}`);
  if (user.ownedDashboards) parts.push(`${user.ownedDashboards} dashboard${user.ownedDashboards === 1 ? "" : "s"}`);
  if (user.authoredRules) parts.push(`${user.authoredRules} rule${user.authoredRules === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function OwnedList({ title, items, empty }) {
  return (
    <div className="ui-split__col">
      <h4 className="ui-subhead">{title} <span className="people-owned__count">{items.length || ""}</span></h4>
      {items.length ? (
        <ul className="people-owned-list">
          {items.map((it) => (
            <li key={it.id}>
              {it.viewUrl
                ? <a href={it.viewUrl} target="_blank" rel="noopener noreferrer">{it.name || it.id}</a>
                : (it.name || it.id)}
              {it.enabled === false && <Chip tone="neutral" title="Disabled rule">off</Chip>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="admin-config-row__hint">{empty}</p>
      )}
    </div>
  );
}

function UserRow({ user, expanded, detail, detailLoading, onToggle }) {
  const owns = ownsSummary(user);
  return (
    <div className={`people-row${expanded ? " people-row--open" : ""}`}>
      <button
        type="button"
        className="people-row__head"
        onClick={() => onToggle(user.accountId)}
        aria-expanded={expanded}
      >
        <span className="people-row__chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        <span className="people-row__identity">
          <span className="people-row__name">{user.displayName}</span>
          <span className="people-row__via">
            {user.groups.length
              ? `via ${user.groups.map((g) => g.name).join(", ")}`
              : "no access group recorded"}
          </span>
        </span>
        <span className="people-row__meta">
          {owns && <Chip tone="neutral" title="Filters, dashboards and automation rules this user owns">owns {owns}</Chip>}
          {user.automationRefs > 0 && (
            <Chip tone={user.active ? "neutral" : "critical"} title="Automation rules that assign to or condition on this account">
              in {user.automationRefs} rule{user.automationRefs === 1 ? "" : "s"}
            </Chip>
          )}
          {user.applications.map((p) => (
            <Chip key={p.key} tone="neutral" title={`Licensed for ${p.name}`}>{shortProduct(p.key)}</Chip>
          ))}
          {user.accountType === "app" && (
            <Chip tone="warning" title="This account is an app, not a person">app</Chip>
          )}
          {!user.active && <Chip tone="critical" title="Deactivated in Jira">inactive</Chip>}
        </span>
      </button>

      {expanded && (
        <div className="people-row__detail">
          {detailLoading && !detail ? (
            <p className="admin-config-row__hint">Loading…</p>
          ) : (
            <div className="ui-split">
              <OwnedList title="Filters" items={detail?.ownedFilters || []} empty="Owns no saved filter." />
              <OwnedList title="Dashboards" items={detail?.ownedDashboards || []} empty="Owns no dashboard." />
              <OwnedList
                title="Automation rules"
                items={detail?.authoredRules || []}
                empty={detail?.ownershipAvailable?.rules === false
                  ? "Rule authorship needs a rule export that carries account ids — import one on the Automation tab."
                  : "Authored no automation rule."}
              />
              <div className="ui-split__col">
                <h4 className="ui-subhead">
                  Named in rules <span className="people-owned__count">{(detail?.referencedInRules || []).length || ""}</span>
                </h4>
                {(detail?.referencedInRules || []).length ? (
                  <ul className="people-owned-list">
                    {detail.referencedInRules.map((r) => (
                      <li key={r.id}>
                        {r.name}
                        {r.direction === "write" && <Chip tone="warning" title="A rule assigns to or sets a user field to this account">assigned</Chip>}
                        {r.enabled === false && <Chip tone="neutral" title="Disabled rule">off</Chip>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="admin-config-row__hint">
                    {detail?.automationRefsAvailable === false
                      ? "Import a rule export on the Automation tab to see which rules name this person."
                      : "No automation rule assigns to or conditions on this person."}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const ROSTER_SORTS = [
  { value: "name-asc", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" },
  { value: "owned-desc", label: "Most owned" },
  { value: "products-desc", label: "Most products" },
];

const ROSTER_FILTERS = [
  { value: "all", label: "Everyone" },
  { value: "app", label: "App accounts" },
  { value: "inactive", label: "Deactivated" },
  { value: "multi", label: "Multi-product" },
  { value: "owners", label: "Owns config" },
];

function matchesRosterFilter(user, filter) {
  if (filter === "app") return user.accountType === "app";
  if (filter === "inactive") return !user.active;
  if (filter === "multi") return (user.applications?.length ?? 0) > 1;
  if (filter === "owners") return ownsCount(user) > 0;
  return true;
}

function sortRoster(users, sort) {
  const by = {
    "name-asc": (a, b) => a.displayName.localeCompare(b.displayName),
    "name-desc": (a, b) => b.displayName.localeCompare(a.displayName),
    "owned-desc": (a, b) => ownsCount(b) - ownsCount(a) || a.displayName.localeCompare(b.displayName),
    "products-desc": (a, b) => (b.applications?.length ?? 0) - (a.applications?.length ?? 0) || a.displayName.localeCompare(b.displayName),
  };
  return [...users].sort(by[sort] || by["name-asc"]);
}

export function PeopleTab() {
  const [view, setView] = React.useState("overview");
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [building, setBuilding] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState("name-asc");
  const [rosterFilter, setRosterFilter] = React.useState("all");
  const [openUser, setOpenUser] = React.useState(null);
  const [details, setDetails] = React.useState({});   // accountId -> detail
  const [detailLoading, setDetailLoading] = React.useState(false);

  const toggleUser = React.useCallback(async (accountId) => {
    if (openUser === accountId) { setOpenUser(null); return; }
    setOpenUser(accountId);
    if (details[accountId]) return;
    setDetailLoading(true);
    try {
      const detail = await invoke("getUserDetails", { accountId });
      setDetails((d) => ({ ...d, [accountId]: detail }));
    } catch {
      setDetails((d) => ({ ...d, [accountId]: { ownedFilters: [], ownedDashboards: [], authoredRules: [] } }));
    } finally {
      setDetailLoading(false);
    }
  }, [openUser, details]);

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

  // The People pillar of the site health score, fetched on its own so this tab shows the
  // same governance reading the Overview does -- matching ScreensTab and IssueTypesTab.
  const [pillar, setPillar] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    invoke("getPillarHealth", { pillar: "users" })
      .then((result) => { if (!cancelled) setPillar(result?.pillar || null); })
      .catch(() => { if (!cancelled) setPillar(null); });
    return () => { cancelled = true; };
  }, [data?.refreshedAt]);

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

  const allUsers = data?.users || [];
  const roster = (() => {
    const term = search.trim().toLowerCase();
    let rows = allUsers.filter((u) => matchesRosterFilter(u, rosterFilter));
    if (term) {
      rows = rows.filter((u) =>
        u.displayName.toLowerCase().includes(term) ||
        u.accountId.toLowerCase().includes(term) ||
        u.applications.some((p) => shortProduct(p.key).includes(term)) ||
        u.groups.some((gr) => gr.name.toLowerCase().includes(term)));
    }
    return sortRoster(rows, sort);
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
            <GridSpan>
              <PillarHealthPanel pillar={pillar} />
            </GridSpan>

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

            <Panel
              title="Orphaned ownership"
              icon="alertTriangle"
              description="Filters, dashboards and automation rules owned by an account that is not in the licensed roster — a deleted or unlicensed user still holding site config."
            >
              {(g?.orphanedOwners ?? 0) > 0 ? (
                <BarList
                  items={[
                    { label: "Filters", count: g?.orphanedFilters ?? 0 },
                    { label: "Dashboards", count: g?.orphanedDashboards ?? 0 },
                    { label: "Automation rules", count: g?.orphanedRules ?? 0 },
                  ]}
                  labelKey="label"
                  valueKey="count"
                  formatValue={(v) => formatNumber(v)}
                  tone="warn"
                  emptyMessage="None."
                />
              ) : (
                <EmptyState inline>Every owned filter, dashboard and rule belongs to a licensed user.</EmptyState>
              )}
            </Panel>
          </PanelGrid>
        )}

        {view === "roster" && (
          <Panel
            title="Licensed users"
            icon="user"
            description="Everyone in an access group, with the products they hold and the group they hold them through."
          >
            <SortFilterBar
              search={search}
              onSearchChange={setSearch}
              searchLabel="Search the roster"
              searchPlaceholder="Search by name, account id, product or group…"
              sort={sort}
              onSortChange={setSort}
              sortOptions={ROSTER_SORTS}
              filters={[{
                key: "roster",
                label: "Show",
                value: rosterFilter,
                onChange: setRosterFilter,
                options: ROSTER_FILTERS,
              }]}
              resultCount={roster.length}
              totalCount={allUsers.length}
              onClear={() => { setSearch(""); setSort("name-asc"); setRosterFilter("all"); }}
            />

            {roster.length ? (
              <div className="people-list">
                {roster.map((user) => (
                  <UserRow
                    key={user.accountId}
                    user={user}
                    expanded={openUser === user.accountId}
                    detail={details[user.accountId]}
                    detailLoading={detailLoading}
                    onToggle={toggleUser}
                  />
                ))}
              </div>
            ) : (
              <EmptyState inline>{search || rosterFilter !== "all" ? "No users match that filter." : "No licensed users in this roster."}</EmptyState>
            )}
          </Panel>
        )}
      </SubNavLayout>
    </div>
  );
}
