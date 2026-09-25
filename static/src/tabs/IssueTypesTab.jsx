import React from "react";
import { invoke } from "@forge/bridge";
import { formatNumber, formatRelativeTime, buildIssueTypeAdminUrl } from "../utils";
import {
  StatTile, StatRow, Panel, EmptyState, Chip, PageHeader, BarList, PillarHealthPanel, FindingRow, SortFilterBar, AskRovo, JiraLink, RebuildButton, BuildBanners, AttentionPanel, PillarOverview,
} from "../components/ui";
import { buildRovoPrompt } from "../utils";
import { SubNavLayout } from "../components/admin/primitives";
import { useNavIntent, usePersistentState, useSnapshotBuild, usePillarHealth } from "../hooks";

// Issue type inventory.
//
// The issue-type -> screen layer shipped with the Screens pillar. This is the tier above
// it: the type catalog with Jira's hierarchy level, and the issue type schemes that gate
// which types a project may use. Read-only, like the rest of Observatory -- it reports what
// is configured; changing a scheme stays a considered action in Jira's own admin UI.


// Third application of the same threshold the macro warning and the Screens tab use. A
// reader who has learned what "stale" means elsewhere should not relearn it here.


// A type's chips: what makes it notable at a glance. Order matters -- the finding-shaped
// ones (project-scoped, sub-task) come before the identifier.
// The count, and the three states it can be in.
//
// Zero is what makes a type look safe to delete, so it is only ever SHOWN as a zero when a
// crawl actually finished. "Not measured" and "measured, and it is nought" are opposite
// claims, and rendering a dash for the first is the whole point of this component -- the
// data has carried this tri-state since the crawl shipped, and the tab had no column to
// show it in.
export function TypeUsageChip({ type, measurement }) {
  if (measurement === "not-measured") {
    return (
      <Chip tone="neutral" title="No issue crawl has completed, so nothing is known about how much this type is used. Run a full scan from the Scans tab.">
        Not measured
      </Chip>
    );
  }
  if (measurement === "measurement-failed") {
    return (
      <Chip tone="warning" title="The usage counts could not be read. This is not a count of zero.">
        Count unavailable
      </Chip>
    );
  }
  if (type.issueCount === null || type.issueCount === undefined) {
    return (
      <Chip tone="warning" title="The last crawl did not finish, so this type was not reached. Not evidence that nobody uses it.">
        Not reached
      </Chip>
    );
  }
  if (type.issueCount === 0) {
    return (
      <Chip tone="warning" title="A completed crawl found no issue of this type anywhere on the site.">
        No issues
      </Chip>
    );
  }
  return (
    <Chip
      tone="neutral"
      title={type.usedInProjects ? `In ${formatNumber(type.usedInProjects)} project${type.usedInProjects === 1 ? "" : "s"}` : undefined}
    >
      {formatNumber(type.issueCount)} {type.issueCount === 1 ? "issue" : "issues"}
    </Chip>
  );
}

function TypeChips({ type, measurement }) {
  return (
    <>
      <TypeUsageChip type={type} measurement={measurement} />
      {type.subtask && (
        <Chip tone="neutral" title="A sub-task type: it lives under another issue, never on its own">
          Sub-task
        </Chip>
      )}
      {type.scopeProjectId && (
        <Chip tone="warning" title="Belongs to one team-managed project. Classic projects cannot use it.">
          Project-scoped
        </Chip>
      )}
      <Chip tone="neutral" title="Issue type id">#{type.id}</Chip>
    </>
  );
}

export function HierarchyLevelPanel({ level, search, measurement = "not-measured" }) {
  const term = search.trim().toLowerCase();
  const types = term
    ? level.types.filter((t) => t.name.toLowerCase().includes(term) || String(t.id) === term)
    : level.types;

  if (!types.length) return null;

  return (
    <Panel
      title={level.label}
      icon={level.level < 0 ? "layers" : level.level >= 1 ? "barChart" : "copy"}
      description={`Hierarchy level ${level.level} — ${formatNumber(level.types.length)} ${level.types.length === 1 ? "type" : "types"}`}
    >
      <div className="issue-type-list">
        {types.map((type) => (
          <div className="issue-type-row" key={type.id}>
            <div className="issue-type-row__identity">
              <span className="issue-type-row__name">{type.name}</span>
              {type.description && <span className="issue-type-row__desc">{type.description}</span>}
            </div>
            <div className="issue-type-row__meta">
              <TypeChips type={type} measurement={measurement} />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function SchemeCard({ scheme }) {
  return (
    <div className="issue-type-scheme">
      <div className="issue-type-scheme__head">
        <span className="issue-type-scheme__name">{scheme.name}</span>
        {scheme.isDefault && (
          <Chip tone="neutral" title="The site-wide fallback every classic project starts on">Default scheme</Chip>
        )}
        <Chip
          tone={scheme.projectCount === 0 ? "warning" : "neutral"}
          title={scheme.projectCount === 0 ? "No project uses this scheme" : undefined}
        >
          {formatNumber(scheme.projectCount)} {scheme.projectCount === 1 ? "project" : "projects"}
        </Chip>
      </div>

      {scheme.description && <p className="issue-type-scheme__desc">{scheme.description}</p>}

      {/* Membership in the order an admin arranged it -- that order is what shows on the
          create dialog, so it is preserved rather than sorted. A member the catalog no
          longer contains is kept and flagged: a scheme allowing a type that was deleted is
          a finding, not noise. */}
      <div className="issue-type-scheme__members">
        {scheme.issueTypes.length === 0 ? (
          <span className="issue-type-scheme__empty">No issue types — projects on this scheme can create nothing.</span>
        ) : (
          scheme.issueTypes.map((t) => (
            <Chip
              key={t.id}
              tone={t.missing ? "critical" : "neutral"}
              title={
                t.missing
                  ? "This type is no longer in the catalog, but the scheme still allows it"
                  : t.id === scheme.defaultIssueTypeId
                    ? "Pre-selected on the create screen"
                    : undefined
              }
            >
              {t.missing ? `#${t.id} (missing)` : t.name}
              {t.id === scheme.defaultIssueTypeId && !t.missing ? " ·default" : ""}
            </Chip>
          ))
        )}
      </div>

      {scheme.projects.length > 0 && (
        <div className="issue-type-scheme__projects">
          {scheme.projects.slice(0, 12).map((p) => (
            <span className="issue-type-scheme__project" key={p.projectId} title={p.projectName}>{p.projectKey}</span>
          ))}
          {scheme.projects.length > 12 && (
            <span className="issue-type-scheme__project issue-type-scheme__project--more">
              +{formatNumber(scheme.projects.length - 12)} more
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// The governance findings behind the pillar score, as one uniform list. Ordered most
// consequential first: types nothing can create, then schemes that cannot start an issue,
// then near-duplicate names, then schemes nobody uses.
export function IssueTypeFindings({ findings }) {
  if (!findings || !findings.available) {
    return <AttentionPanel empty="No issue type inventory has been built yet." />;
  }

  const rows = [];
  if (findings.orphanTypeCount > 0) {
    rows.push({
      tone: "critical", count: findings.orphanTypeCount,
      title: "Issue types on no scheme",
      detail: `No project can create ${findings.orphanTypeCount === 1 ? "this type" : "these"}. ${findings.orphanSubtaskCount > 0 ? `${findings.orphanSubtaskCount} are sub-tasks. ` : ""}${(findings.orphanTypes || []).slice(0, 6).map((t) => t.name).join(", ")}${findings.orphanTypes?.length > 6 ? "…" : ""}`,
    });
  }
  if (findings.hierarchyFlaggedSchemeCount > 0) {
    rows.push({
      tone: "critical", count: findings.hierarchyFlaggedSchemeCount,
      title: "Schemes that cannot start an issue",
      detail: `Sub-tasks with no standalone type, or a default that cannot be created. ${(findings.flaggedSchemes || []).slice(0, 4).map((s) => s.name).join(", ")}${findings.flaggedSchemes?.length > 4 ? "…" : ""}`,
    });
  }
  if (findings.reducibleTypeCount > 0) {
    rows.push({
      tone: "warning", count: findings.reducibleTypeCount,
      title: "Near-duplicate type names",
      detail: `${findings.duplicateTypeGroupCount} group${findings.duplicateTypeGroupCount === 1 ? "" : "s"} — a Bug / Defect split makes every by-type report wrong by however many issues sit on the wrong one.`,
    });
  }
  if (findings.unusedSchemeCount > 0) {
    rows.push({
      tone: "warning", count: findings.unusedSchemeCount,
      title: "Issue type schemes assigned to no project",
      detail: "A scheme no project uses is a decision nobody made.",
    });
  }

  return (
    <AttentionPanel
      description="What the issue types pillar of the site health score is built from."
      empty="No issue type governance findings. Every type is reachable, every scheme is in use, and no names collide."
    >
      {rows.map((r) => <FindingRow key={r.title} tone={r.tone} title={r.title} detail={r.detail} count={r.count} />)}
    </AttentionPanel>
  );
}

export function IssueTypesTab({ intent, siteOrigin }) {
  const [view, setView] = usePersistentState("observatory.section.issueTypes", "overview");
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [search, setSearch] = React.useState("");

  useNavIntent(intent, (nav) => {
    if (nav.view) setView(nav.view);
    setSearch("");
  });

  const load = React.useCallback(async () => {
    try {
      const result = await invoke("getIssueTypeInventory", {});
      setData(result);
      setError("");
    } catch (err) {
      // A transient poll failure keeps the last good state rather than blanking the page.
      setError(err?.message || "Could not load the issue type inventory.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  // The issue types pillar of the site health score, fetched on its own so this tab shows
  // the same governance reading the Overview does -- matching ScreensTab.
  const pillar = usePillarHealth("issueTypes", data?.refreshedAt);

  // "queued" counts as in flight, not just "building" -- the row is marked building at queue
  // time, but a consumer that has not picked the job up can leave either value on the meta.
  const build = useSnapshotBuild({ resolver: "buildIssueTypeInventory", data, load });
  const isBuilding = build.isBuilding;

  const buildAction = (
    <>
      <AskRovo
        agent="observatory-issuetype-expert"
        scope="the issue type catalogue"
        context="the snapshot age and the current orphan / near-duplicate / unused-scheme counts"
        disabled={Boolean(data?.neverBuilt)}
        buildPrompt={() =>
          buildRovoPrompt({
            task: "Give me an overview of this site's issue type catalogue and its schemes, and what to look at first.",
            facts: [
              ["Snapshot built", data?.refreshedAt || "unknown"],
              ["Issue types", data?.totalTypes ?? null],
              ["Issue type schemes", data?.totalSchemes ?? null],
              ["Types no scheme reaches", data?.governance?.orphanTypeCount ?? null],
              ["Near-duplicate type names", data?.governance?.reducibleTypeCount ?? null],
              ["Schemes no project uses", data?.governance?.unusedSchemeCount ?? null],
            ],
          })
        }
      />
      <RebuildButton onClick={build.startBuild} isBuilding={isBuilding} starting={build.starting} neverBuilt={Boolean(data?.neverBuilt)} buildLabel="Build inventory" />
    </>
  );

  if (loading && !data) {
    return <div className="empty-state">Loading issue type inventory…</div>;
  }

  const banners = (
    <BuildBanners
      loadError={error} buildError={build.error} notice={build.notice}
      isBuilding={isBuilding} buildingMessage="Building the inventory… this page refreshes itself."
      staleBuild={data?.staleBuild} lastError={data?.lastError} builtAt={data?.neverBuilt ? null : data?.refreshedAt} staleDetail="Every full and quick scan refreshes it — run one, or rebuild here. A scheme changed since the last build is not reflected until then."
    />
  );

  if (data?.neverBuilt) {
    return (
      <div className="admin-issue-types">
        <PageHeader
          title="Issue Types"
          description="The issue type catalog by hierarchy level, and the schemes that decide which types each project may use."
          actions={buildAction}
        />
        {banners}

        {isBuilding ? (
          <Panel title="Building the first inventory" icon="refreshCw">
            <p>
              Reading every issue type, every issue type scheme, its ordered membership and its
              project assignments. This is a small structural build — under a minute on most
              sites. This page refreshes itself; you can leave it.
            </p>
            {data?.startedAt && <p className="admin-config-row__hint">Started {formatRelativeTime(data.startedAt)}.</p>}
          </Panel>
        ) : (
          <EmptyState action={buildAction}>
            No issue type inventory has been built yet. It is also produced by every full and
            quick scan — or build it on its own here.
          </EmptyState>
        )}
      </div>
    );
  }

  const g = data?.governance || null;

  const items = [
    { key: "overview", label: "Overview", icon: "barChart" },
    { key: "hierarchy", label: "Types", icon: "layers", badge: formatNumber(data?.totalTypes ?? 0) },
    { key: "schemes", label: "Schemes", icon: "folder", badge: formatNumber(data?.totalSchemes ?? 0) },
    { key: "screen-schemes", label: "Screen schemes", icon: "copy", badge: formatNumber(data?.issueTypeScreenSchemes?.length ?? 0) },
  ];

  const term = search.trim().toLowerCase();

  const filteredSchemes = (() => {
    if (!term) return data?.schemes || [];
    return (data?.schemes || []).filter((s) =>
      s.name.toLowerCase().includes(term) ||
      s.issueTypes.some((t) => (t.name || "").toLowerCase().includes(term)) ||
      s.projects.some((p) => p.projectKey.toLowerCase().includes(term)));
  })();

  const matchingTypeCount = term
    ? (data?.hierarchy || []).reduce((n, level) => n + level.types.filter(
        (t) => t.name.toLowerCase().includes(term) || String(t.id) === term).length, 0)
    : (data?.totalTypes ?? 0);

  return (
    <div className="admin-issue-types">
      <PageHeader
        title="Issue Types"
        description="Issue types by hierarchy level, and the schemes that gate which types each project may use. Read-only — changes stay in Jira's admin UI."
        meta={data?.refreshedAt ? `Built ${formatRelativeTime(data.refreshedAt)}` : "Never built"}
        actions={<>
          <JiraLink className="ui-linkbutton" href={buildIssueTypeAdminUrl(siteOrigin)} title="Manage issue types in Jira">Manage in Jira</JiraLink>
          {buildAction}
        </>}
      />

      {banners}

      <StatRow>
        <StatTile label="Issue types" value={formatNumber(data?.totalTypes ?? 0)} hint="Defined across the site" icon="layers" />
        <StatTile label="Issue type schemes" value={formatNumber(data?.totalSchemes ?? 0)} hint="Gate which types a project can use" icon="folder" />
        <StatTile
          label="Unused schemes"
          value={formatNumber(g?.unusedSchemes ?? 0)}
          hint={(g?.unusedSchemes ?? 0) > 0 ? "No project is assigned to them" : "Every scheme is in use"}
          tone={(g?.unusedSchemes ?? 0) > 0 ? "warning" : "success"}
          icon="alertTriangle"
        />
        <StatTile
          label="Orphan types"
          value={formatNumber(g?.orphanTypes ?? 0)}
          hint={(g?.orphanTypes ?? 0) > 0 ? "On no scheme — no project can create one" : "Every type is on a scheme"}
          tone={(g?.orphanTypes ?? 0) > 0 ? "warning" : "success"}
          icon="alertTriangle"
        />
      </StatRow>


      <SubNavLayout items={items} activeKey={view} onSelect={setView}>
        {view === "overview" && (
          <PillarOverview
            governance={<PillarHealthPanel pillar={pillar} />}
            attention={<IssueTypeFindings findings={data?.governanceFindings} />}
          >
            <Panel title="Types by hierarchy level" icon="layers" description="Jira's level: −1 sub-task, 0 base, 1 Epic, 2+ custom hierarchy above Epic.">
              <BarList
                items={(data?.hierarchy || []).map((h) => ({ label: h.label, count: h.types.length }))}
                labelKey="label"
                valueKey="count"
                formatValue={formatNumber}
                emptyMessage="No issue types in this snapshot"
              />
            </Panel>
            <Panel title="Widest-reaching schemes" icon="folder" description="How many projects each issue type scheme governs. A scheme on hundreds of projects is not a local edit.">
              <BarList
                items={(data?.schemes || []).slice(0, 10).map((s) => ({ label: s.name, count: s.projectCount }))}
                labelKey="label"
                valueKey="count"
                formatValue={formatNumber}
                tone="warn"
                emptyMessage="No schemes in this snapshot"
              />
            </Panel>
            <Panel title="Coverage" icon="info" description="What this snapshot holds.">
              <StatRow>
                <StatTile label="Sub-task types" value={formatNumber(g?.subtaskTypes ?? 0)} hint="Live under another issue" />
                <StatTile
                  label="Project-scoped types"
                  value={formatNumber(g?.projectScopedTypes ?? 0)}
                  hint="Belong to one team-managed project"
                />
                <StatTile label="Hierarchy levels" value={formatNumber(g?.hierarchyLevels ?? 0)} hint="Distinct levels in use" />
              </StatRow>
            </Panel>
          </PillarOverview>
        )}

        {view === "hierarchy" && (
          <div className="issue-type-hierarchy">
            <SortFilterBar
              search={search}
              onSearchChange={setSearch}
              searchLabel="Search issue types"
              searchPlaceholder="Search types by name or id…"
              resultCount={matchingTypeCount}
              totalCount={data?.totalTypes ?? 0}
              onClear={() => setSearch("")}
            />
            {(data?.hierarchy || []).length === 0 ? (
              <EmptyState inline>No issue types in this snapshot.</EmptyState>
            ) : (
              (data.hierarchy).map((level) => (
                <HierarchyLevelPanel key={level.level} level={level} search={search} measurement={data?.usage?.measurement || "not-measured"} />
              ))
            )}
          </div>
        )}

        {view === "schemes" && (
          <Panel
            title="Issue type schemes"
            icon="folder"
            description="Which set of types each project is allowed to use, in the order they appear on the create dialog."
          >
            <SortFilterBar
              search={search}
              onSearchChange={setSearch}
              searchLabel="Search issue type schemes"
              searchPlaceholder="Search schemes by name, type or project key…"
              resultCount={filteredSchemes.length}
              totalCount={data?.schemes?.length ?? 0}
              onClear={() => setSearch("")}
            />
            {filteredSchemes.length === 0 ? (
              <EmptyState inline>{search ? "No schemes match that search." : "No issue type schemes in this snapshot."}</EmptyState>
            ) : (
              <div className="issue-type-scheme-list">
                {filteredSchemes.map((scheme) => (
                  <SchemeCard key={scheme.schemeId} scheme={scheme} />
                ))}
              </div>
            )}
          </Panel>
        )}

        {view === "screen-schemes" && (
          <Panel
            title="Issue type screen schemes"
            icon="copy"
            description="The tier below: which screen scheme each issue type resolves to. Read from the Screens snapshot — build that from the Screens tab if it is missing."
          >
            {(data?.issueTypeScreenSchemes || []).length === 0 ? (
              <EmptyState inline>
                No issue type screen schemes are available. They come from the Screens snapshot;
                build it from the Screens tab.
              </EmptyState>
            ) : (
              <div className="issue-type-scheme-list">
                {data.issueTypeScreenSchemes.map((itss) => (
                  <div className="issue-type-scheme" key={itss.itssId}>
                    <div className="issue-type-scheme__head">
                      <span className="issue-type-scheme__name">{itss.name}</span>
                      <Chip tone="neutral">
                        {formatNumber(itss.projectCount ?? 0)} {itss.projectCount === 1 ? "project" : "projects"}
                      </Chip>
                    </div>
                    <div className="issue-type-scheme__members">
                      {itss.mappings.length === 0 ? (
                        <span className="issue-type-scheme__empty">No mappings recorded.</span>
                      ) : (
                        itss.mappings.map((m, i) => (
                          <Chip
                            key={`${m.issueTypeId}-${i}`}
                            tone="neutral"
                            title={m.screenSchemeId ? `Screen scheme #${m.screenSchemeId}` : "Maps to no screen scheme"}
                          >
                            {m.issueTypeName || `#${m.issueTypeId}`} → {m.screenSchemeId ? `#${m.screenSchemeId}` : "none"}
                          </Chip>
                        ))
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        )}
      </SubNavLayout>
    </div>
  );
}
