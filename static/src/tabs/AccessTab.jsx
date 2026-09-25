import React from "react";
import { invoke } from "@forge/bridge";
import { formatNumber, formatRelativeTime, buildPermissionSchemeUrl, buildNotificationSchemeAdminUrl, buildIssueSecuritySchemeAdminUrl } from "../utils";
import {
  StatTile, StatRow, Panel, EmptyState, Chip, PageHeader, PillarHealthPanel, BarList, FindingRow, SortFilterBar,
  AskRovo, JiraLink, RebuildButton, BuildBanners, AttentionPanel, PillarOverview,
} from "../components/ui";
import { buildRovoPrompt } from "../utils";
import { SubNavLayout } from "../components/admin/primitives";
import { useNavIntent, usePersistentState, useSnapshotBuild, usePillarHealth } from "../hooks";

// The access pillar: permission schemes, issue-security schemes and notification schemes.
//
// The same "is this config risky / broken / unused" read the other structural pillars use,
// applied to who-can-do-what-where. Three scheme families, one scan stage, three governance
// pillars -- least privilege (permissions), data black holes (issue security) and fragile
// routing (notifications). Read-only; changing a grant stays a considered action in Jira's
// own admin UI.



const SCHEME_SORTS = [
  { value: "name-asc", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" },
  { value: "projects-desc", label: "Most projects" },
  { value: "flagged-first", label: "Flagged first" },
];

// One scheme, its project reach and whatever flags it carries, expandable to the grants /
// members / recipients behind it. `flags` are already-computed booleans from the parent.
// `jiraHref`/`jiraLabel`: the Jira back-link lives in the expanded body, not the header --
// the header is the expand <button>, and an anchor cannot legally nest inside one.
function SchemeRow({ scheme, holders, flags, contextNoun, holderNoun, jiraHref = null, jiraLabel = "Open in Jira" }) {
  const [open, setOpen] = React.useState(false);
  const rows = holders.filter((h) => String(h.schemeId) === String(scheme.id));

  return (
    <div className={`access-row${open ? " access-row--open" : ""}`}>
      <button type="button" className="access-row__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="access-row__chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="access-row__identity">
          <span className="access-row__name">{scheme.name}</span>
          {scheme.description && <span className="access-row__desc">{scheme.description}</span>}
        </span>
        <span className="access-row__meta">
          {scheme.isDefault && <Chip tone="neutral" title="The site-wide default scheme">default</Chip>}
          <Chip
            tone={scheme.projectCount === 0 && !scheme.isDefault ? "warning" : "neutral"}
            title={scheme.projectCount === 0 ? "No project is assigned to this scheme" : undefined}
          >
            {formatNumber(scheme.projectCount)} {scheme.projectCount === 1 ? "project" : "projects"}
          </Chip>
          {flags.map((f) => (
            <Chip key={f.label} tone={f.tone} title={f.title}>{f.label}</Chip>
          ))}
        </span>
      </button>

      {open && (
        <div className="access-row__detail">
          {jiraHref && (
            <p className="admin-config-row__hint">
              <JiraLink href={jiraHref} title={jiraLabel}>{jiraLabel}</JiraLink>
            </p>
          )}
          {rows.length === 0 ? (
            <p className="admin-config-row__hint">No {holderNoun} recorded on this scheme.</p>
          ) : (
            <ul className="access-holder-list">
              {rows.slice(0, 200).map((h, i) => (
                <li key={`${h.context}-${h.holderType}-${h.holderValue}-${i}`}>
                  <span className="access-holder-list__context">{h.contextLabel || h.context || contextNoun}</span>
                  <Chip
                    tone={h.holderType === "user" ? "warning" : h.holderType === "anyone" ? "critical" : "neutral"}
                    title={h.holderType === "user" ? "A grant to a named individual — should be a role" : undefined}
                  >
                    {h.holderType}
                    {h.holderLabel || h.holderValue ? `: ${h.holderLabel || h.holderValue}` : ""}
                  </Chip>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// The findings behind all three access pillars, one uniform list. Ordered most consequential
// first: least-privilege failures, then data black holes, then fragile routing, then clutter.
function AccessFindings({ permissions, security, notifications, roles }) {
  const rows = [];
  const p = permissions?.governance || {};
  const s = security?.governance || {};
  const n = notifications?.governance || {};
  const r = roles?.governance || {};

  if (p.riskySchemeCount > 0) {
    rows.push({
      tone: "critical", count: p.riskySchemeCount,
      title: "Permission schemes that break least privilege",
      detail: "Browse open to anyone, project admin handed to a whole group, or a permission held by a named individual. "
        + (p.riskySchemes || []).slice(0, 4).map((x) => x.name).join(", ") + ((p.riskySchemes || []).length > 4 ? "…" : ""),
    });
  }
  if (p.offRosterUserGrantCount > 0) {
    rows.push({
      tone: "critical", count: p.offRosterUserGrantCount,
      title: "Permission grants to someone off the roster",
      detail: "A permission is held directly by an account that is no longer licensed — nobody reviews it and nothing removes it.",
    });
  }
  if (s.brokenLevelCount > 0 || s.noLevelSchemeCount > 0) {
    rows.push({
      tone: "critical", count: (s.emptyLevelCount || 0) + (s.noLevelSchemeCount || 0),
      title: "Issue security levels nobody can see through",
      detail: "Levels with no members, or schemes with no levels at all. An issue set to one is invisible to everyone but a site admin.",
    });
  }
  if (n.fragileSchemeCount > 0) {
    rows.push({
      tone: "warning", count: n.fragileSchemeCount,
      title: "Notification schemes routing to a named individual",
      detail: "The notification stops silently the day that person leaves. Route to a project role or group instead.",
    });
  }
  if (r.projectsMissingAdminActorCount > 0) {
    rows.push({
      tone: "critical", count: r.projectsMissingAdminActorCount,
      title: "Projects with an empty administrator role",
      detail: "No group or user is in the project's admin role — only a site admin can administer it. "
        + (r.projectsMissingAdminActor || []).slice(0, 6).map((x) => x.projectKey).join(", "),
    });
  }
  if (r.offRosterActorCount > 0) {
    rows.push({
      tone: "warning", count: r.offRosterActorCount,
      title: "Project-role actors off the licensed roster",
      detail: "An account no longer licensed still sits in a project role.",
    });
  }
  const unused = (p.unusedSchemeCount || 0) + (s.unusedSchemeCount || 0) + (n.unusedSchemeCount || 0);
  if (unused > 0) {
    rows.push({
      tone: "info", count: unused,
      title: "Access schemes assigned to no project",
      detail: `${p.unusedSchemeCount || 0} permission, ${s.unusedSchemeCount || 0} security and ${n.unusedSchemeCount || 0} notification schemes nothing uses — clutter in every scheme picker.`,
    });
  }

  return (
    <AttentionPanel
      description="What the permission, issue-security, notification and project-role pillars of the site health score are built from."
      empty="Nothing flagged. No blanket grants, every security level has members, and no notification routes to a single person."
    >
      {rows.map((r) => <FindingRow key={r.title} tone={r.tone} title={r.title} detail={r.detail} count={r.count} />)}
    </AttentionPanel>
  );
}

function permissionFlags(scheme, governance) {
  const risky = (governance?.riskySchemes || []).find((x) => String(x.id) === String(scheme.id));
  const flags = [];
  if (risky) {
    for (const reason of risky.reasons || []) {
      flags.push({ label: reason, tone: reason.includes("anyone") ? "critical" : "warning", title: "Least-privilege concern" });
    }
  }
  return flags;
}

function AccessTabInner({ data, view, setView, search, setSearch, schemeSort, setSchemeSort, pillars, siteOrigin }) {
  const term = search.trim().toLowerCase();

  const filterSchemes = (schemes, governance, flagFn) => {
    let rows = schemes;
    if (term) rows = rows.filter((s) => s.name.toLowerCase().includes(term) || (s.description || "").toLowerCase().includes(term));
    const flaggedIds = new Set((governance?.riskySchemes || governance?.fragileSchemes || []).map((x) => String(x.id)));
    const by = {
      "name-asc": (a, b) => a.name.localeCompare(b.name),
      "name-desc": (a, b) => b.name.localeCompare(a.name),
      "projects-desc": (a, b) => (b.projectCount || 0) - (a.projectCount || 0) || a.name.localeCompare(b.name),
      "flagged-first": (a, b) =>
        (flaggedIds.has(String(b.id)) ? 1 : 0) - (flaggedIds.has(String(a.id)) ? 1 : 0) || a.name.localeCompare(b.name),
    };
    return [...rows].sort(by[schemeSort] || by["name-asc"]);
  };

  const perm = data.permissions || {};
  const sec = data.security || {};
  const notif = data.notifications || {};
  const role = data.roles || {};

  const items = [
    { key: "overview", label: "Overview", icon: "barChart" },
    { key: "permissions", label: "Permissions", icon: "shield", badge: formatNumber((perm.schemes || []).length) },
    { key: "security", label: "Issue security", icon: "lock", badge: formatNumber((sec.schemes || []).length) },
    { key: "notifications", label: "Notifications", icon: "bell", badge: formatNumber((notif.schemes || []).length) },
    { key: "roles", label: "Project roles", icon: "user", badge: formatNumber((role.schemes || []).length) },
  ];

  return (
    <SubNavLayout items={items} activeKey={view} onSelect={setView}>
      {view === "overview" && (
        <PillarOverview
          governance={
            <PillarHealthPanel
              pillars={[
                { key: "permissions", label: "Permission schemes", pillar: pillars.permissions },
                { key: "security", label: "Issue security", pillar: pillars.security },
                { key: "notifications", label: "Notifications", pillar: pillars.notifications },
                { key: "roles", label: "Project roles", pillar: pillars.roles },
              ]}
            />
          }
          attention={<AccessFindings permissions={perm} security={sec} notifications={notif} roles={role} />}
        >
          <Panel title="Permission schemes by project reach" icon="shield" description="A scheme on hundreds of projects is not a local edit.">
            <BarList
              items={(perm.schemes || []).slice().sort((a, b) => (b.projectCount || 0) - (a.projectCount || 0)).slice(0, 10)
                .map((s) => ({ label: s.name, count: s.projectCount || 0 }))}
              labelKey="label" valueKey="count" formatValue={formatNumber}
              emptyMessage="No permission schemes in this snapshot."
            />
          </Panel>
        </PillarOverview>
      )}

      {view === "permissions" && (
        <Panel title="Permission schemes" icon="shield" description="Every permission scheme, its grants and which projects use it. A grant to a named individual, or browse open to anyone, is flagged.">
          <SortFilterBar
            search={search} onSearchChange={setSearch}
            searchLabel="Search permission schemes" searchPlaceholder="Search schemes by name…"
            sort={schemeSort} onSortChange={setSchemeSort} sortOptions={SCHEME_SORTS}
            resultCount={filterSchemes(perm.schemes || [], perm.governance).length}
            totalCount={(perm.schemes || []).length}
            onClear={() => { setSearch(""); setSchemeSort("name-asc"); }}
          />
          {(perm.schemes || []).length === 0 ? (
            <EmptyState inline>No permission schemes in this snapshot.</EmptyState>
          ) : (
            <div className="access-list">
              {filterSchemes(perm.schemes, perm.governance).map((s) => (
                <SchemeRow
                  key={s.id} scheme={s} holders={perm.holders || []}
                  flags={permissionFlags(s, perm.governance)}
                  contextNoun="permission" holderNoun="grants"
                  jiraHref={buildPermissionSchemeUrl(siteOrigin, s.id)}
                  jiraLabel="Open this scheme's grants in Jira"
                />
              ))}
            </div>
          )}
        </Panel>
      )}

      {view === "security" && (
        <Panel title="Issue security schemes" icon="lock" description="Each scheme's security levels and their members. A level with no members hides every issue set to it from everyone but a site admin.">
          <SortFilterBar
            search={search} onSearchChange={setSearch}
            searchLabel="Search issue security schemes" searchPlaceholder="Search schemes by name…"
            sort={schemeSort} onSortChange={setSchemeSort} sortOptions={SCHEME_SORTS}
            resultCount={filterSchemes(sec.schemes || [], sec.governance).length}
            totalCount={(sec.schemes || []).length}
            onClear={() => { setSearch(""); setSchemeSort("name-asc"); }}
          />
          {(sec.schemes || []).length === 0 ? (
            <EmptyState inline>No issue security schemes on this site.</EmptyState>
          ) : (
            <div className="access-list">
              {filterSchemes(sec.schemes, sec.governance).map((s) => {
                const levels = (sec.levels || []).filter((l) => String(l.schemeId) === String(s.id));
                const emptyIds = new Set((sec.governance?.emptyLevels || [])
                  .filter((e) => String(e.schemeId) === String(s.id)).map((e) => String(e.levelId)));
                const flags = [];
                if (levels.length === 0) flags.push({ label: "no levels", tone: "critical", title: "The scheme defines no security levels" });
                if (emptyIds.size > 0) flags.push({ label: `${emptyIds.size} empty ${emptyIds.size === 1 ? "level" : "levels"}`, tone: "critical", title: "Security levels with no members" });
                return (
                  <SchemeRow
                    key={s.id} scheme={s} holders={sec.holders || []}
                    flags={flags} contextNoun="level" holderNoun="members"
                    jiraHref={buildIssueSecuritySchemeAdminUrl(siteOrigin)}
                    jiraLabel="Open issue security schemes in Jira"
                  />
                );
              })}
            </div>
          )}
        </Panel>
      )}

      {view === "notifications" && (
        <Panel title="Notification schemes" icon="bell" description="Each scheme's events and who they notify. A recipient that is a named account, rather than a role or group, breaks silently when that person leaves.">
          <SortFilterBar
            search={search} onSearchChange={setSearch}
            searchLabel="Search notification schemes" searchPlaceholder="Search schemes by name…"
            sort={schemeSort} onSortChange={setSchemeSort} sortOptions={SCHEME_SORTS}
            resultCount={filterSchemes(notif.schemes || [], notif.governance).length}
            totalCount={(notif.schemes || []).length}
            onClear={() => { setSearch(""); setSchemeSort("name-asc"); }}
          />
          {(notif.schemes || []).length === 0 ? (
            <EmptyState inline>No notification schemes in this snapshot.</EmptyState>
          ) : (
            <div className="access-list">
              {filterSchemes(notif.schemes, notif.governance).map((s) => {
                const fragile = (notif.governance?.fragileSchemes || []).find((x) => String(x.id) === String(s.id));
                const flags = fragile
                  ? [{ label: `${fragile.namedUserCount} named ${fragile.namedUserCount === 1 ? "recipient" : "recipients"}`, tone: "warning", title: "Routes an event to a specific person" }]
                  : [];
                return (
                  <SchemeRow
                    key={s.id} scheme={s} holders={notif.holders || []}
                    flags={flags} contextNoun="event" holderNoun="recipients"
                    jiraHref={buildNotificationSchemeAdminUrl(siteOrigin)}
                    jiraLabel="Open notification schemes in Jira"
                  />
                );
              })}
            </div>
          )}
        </Panel>
      )}

      {view === "roles" && (
        <Panel title="Project roles" icon="user" description="Each project role and who is in it, per project. Permission and notification schemes grant to these roles — an empty administrator role means only a site admin can manage that project.">
          <SortFilterBar
            search={search} onSearchChange={setSearch}
            searchLabel="Search project roles" searchPlaceholder="Search roles by name…"
            sort={schemeSort} onSortChange={setSchemeSort} sortOptions={SCHEME_SORTS}
            resultCount={filterSchemes(role.schemes || [], role.governance).length}
            totalCount={(role.schemes || []).length}
            onClear={() => { setSearch(""); setSchemeSort("name-asc"); }}
          />
          {(role.schemes || []).length === 0 ? (
            <EmptyState inline>No project roles in this snapshot.</EmptyState>
          ) : (
            <div className="access-list">
              {filterSchemes(role.schemes, role.governance).map((s) => {
                const emptyProjectKeys = (role.governance?.projectsMissingAdminActor || [])
                  .filter((x) => x.role === s.name).map((x) => x.projectKey);
                const flags = emptyProjectKeys.length
                  ? [{ label: `empty on ${emptyProjectKeys.length} ${emptyProjectKeys.length === 1 ? "project" : "projects"}`, tone: "critical", title: `No actor on: ${emptyProjectKeys.slice(0, 12).join(", ")}` }]
                  : [];
                return (
                  <SchemeRow
                    key={s.id} scheme={{ ...s, projectCount: s.projectCount }} holders={role.holders || []}
                    flags={flags} contextNoun="project" holderNoun="actors"
                  />
                );
              })}
            </div>
          )}
        </Panel>
      )}
    </SubNavLayout>
  );
}

export function AccessTab({ intent, siteOrigin }) {
  const [view, setView] = usePersistentState("observatory.section.access", "overview");
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [schemeSort, setSchemeSort] = React.useState("name-asc");

  useNavIntent(intent, (nav) => {
    if (nav.view) setView(nav.view);
    setSearch("");
  });

  const load = React.useCallback(async () => {
    try {
      const result = await invoke("getAccessInventory", {});
      setData(result);
      setError("");
    } catch (err) {
      setError(err?.message || "Could not load the access inventory.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  // The three access pillars of the site health score, on their own so this tab shows the
  // same governance reading the Overview does -- matching IssueTypesTab and AssetsTab.
  const pillars = {
    permissions: usePillarHealth("permissions", data?.refreshedAt),
    security: usePillarHealth("security", data?.refreshedAt),
    notifications: usePillarHealth("notifications", data?.refreshedAt),
    roles: usePillarHealth("roles", data?.refreshedAt),
  };

  const build = useSnapshotBuild({ resolver: "buildAccessInventory", data, load });
  const isBuilding = build.isBuilding;

  const buildAction = (
    <>
      <AskRovo
        agent="observatory-access-expert"
        scope="the access schemes"
        context="the snapshot age and the scheme counts per family"
        disabled={Boolean(data?.neverBuilt)}
        buildPrompt={() =>
          buildRovoPrompt({
            task: "Give me an overview of the permission, issue-security and notification schemes and project roles on this site, and what to review first.",
            facts: [
              ["Snapshot built", data?.refreshedAt || "unknown"],
              ["Permission schemes", (data?.permissions?.schemes || []).length || null],
              ["Issue-security schemes", (data?.security?.schemes || []).length || null],
              ["Notification schemes", (data?.notifications?.schemes || []).length || null],
              ["Project roles", (data?.roles?.schemes || []).length || null],
            ],
          })
        }
      />
      <RebuildButton onClick={build.startBuild} isBuilding={isBuilding} starting={build.starting} neverBuilt={Boolean(data?.neverBuilt)} buildLabel="Build inventory" />
    </>
  );

  if (loading && !data) {
    return <div className="empty-state">Loading the access inventory…</div>;
  }

  const header = (
    <PageHeader
      title="Access"
      description="Permission schemes, issue-security schemes and notification schemes — who can do what, where, and who gets told. Read-only."
      meta={data?.refreshedAt ? `Built ${formatRelativeTime(data.refreshedAt)}` : "Never built"}
      actions={buildAction}
    />
  );

  const banners = (
    <BuildBanners
      loadError={error} buildError={build.error} notice={build.notice}
      isBuilding={isBuilding} buildingMessage="Reading the scheme configuration… this page refreshes itself."
      staleBuild={data?.staleBuild} lastError={data?.lastError} builtAt={data?.neverBuilt ? null : data?.refreshedAt}
    />
  );

  if (data?.neverBuilt) {
    return (
      <div className="admin-access">
        {header}
        {banners}
        {isBuilding ? (
          <Panel title="Building the first inventory" icon="refreshCw">
            <p>
              Reading every permission scheme with its grants, every issue-security scheme
              with its levels and members, and every notification scheme with its events and
              recipients — plus which projects each is assigned to. A small structural build.
              This page refreshes itself; you can leave it.
            </p>
            {data?.startedAt && <p className="admin-config-row__hint">Started {formatRelativeTime(data.startedAt)}.</p>}
          </Panel>
        ) : (
          <EmptyState action={buildAction}>
            No access inventory has been built yet. It is also produced by every full and quick
            scan — or build it on its own here.
          </EmptyState>
        )}
      </div>
    );
  }

  const perm = data.permissions?.governance || {};
  const sec = data.security?.governance || {};
  const notif = data.notifications?.governance || {};
  const roleGov = data.roles?.governance || {};

  return (
    <div className="admin-access">
      {header}
      {banners}

      <StatRow>
        <StatTile
          label="Permission schemes"
          value={formatNumber(perm.totalSchemes ?? (data.permissions?.schemes || []).length)}
          hint={`${formatNumber(perm.unusedSchemeCount ?? 0)} unused`}
          icon="shield"
        />
        <StatTile
          label="Least-privilege flags"
          value={formatNumber(perm.riskySchemeCount ?? 0)}
          hint={(perm.riskySchemeCount ?? 0) > 0 ? "Blanket or direct grants" : "No blanket grants"}
          tone={(perm.riskySchemeCount ?? 0) > 0 ? "critical" : "success"}
          icon="alertTriangle"
        />
        <StatTile
          label="Security levels"
          value={formatNumber(sec.totalLevels ?? 0)}
          hint={(sec.emptyLevelCount ?? 0) + (sec.noLevelSchemeCount ?? 0) > 0
            ? `${formatNumber((sec.emptyLevelCount ?? 0) + (sec.noLevelSchemeCount ?? 0))} unreachable`
            : "Every level has members"}
          tone={(sec.emptyLevelCount ?? 0) + (sec.noLevelSchemeCount ?? 0) > 0 ? "critical" : "neutral"}
          icon="lock"
        />
        <StatTile
          label="Fragile notifications"
          value={formatNumber(notif.fragileSchemeCount ?? 0)}
          hint={(notif.fragileSchemeCount ?? 0) > 0 ? "Route to a named person" : "Route to roles and groups"}
          tone={(notif.fragileSchemeCount ?? 0) > 0 ? "warning" : "success"}
          icon="bell"
        />
        <StatTile
          label="Empty admin roles"
          value={formatNumber(roleGov.projectsMissingAdminActorCount ?? 0)}
          hint={(roleGov.projectsMissingAdminActorCount ?? 0) > 0 ? "Only a site admin can manage these" : "Every project has a role admin"}
          tone={(roleGov.projectsMissingAdminActorCount ?? 0) > 0 ? "critical" : "success"}
          icon="user"
        />
      </StatRow>


      <AccessTabInner
        data={data}
        view={view}
        setView={setView}
        search={search}
        setSearch={setSearch}
        schemeSort={schemeSort}
        setSchemeSort={setSchemeSort}
        pillars={pillars}
        siteOrigin={siteOrigin}
      />
    </div>
  );
}
