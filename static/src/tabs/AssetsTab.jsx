import React from "react";
import { invoke } from "@forge/bridge";
import { formatNumber, formatRelativeTime, buildAssetSchemaUrl } from "../utils";
import { Icon } from "../components/Icons";
import {
  StatTile, StatRow, Panel, EmptyState, Chip, PageHeader,
  PanelGrid, GridSpan, PillarHealthPanel, BarList, FindingRow, SortFilterBar, AskRovo, JiraLink,
} from "../components/ui";
import { buildRovoPrompt } from "../utils";
import { SubNavLayout } from "../components/admin/primitives";
import { useNavIntent, useVisiblePolling, usePersistentState } from "../hooks";

// The JSM Assets (CMDB) pillar: object schemas, their hierarchical object types and those
// types' attributes. The same "is this config dead / broken / unused" read as Fields and
// Issue Types, on the CMDB -- structure only, never the objects themselves.
//
// Assets needs JSM Premium/Enterprise. On every other site the build returns "not enabled
// here" and this tab says so plainly rather than showing an empty catalogue.

const BUILD_POLL_MS = 3000;
const STALE_AFTER_DAYS = 7;

function daysSince(iso) {
  const at = Date.parse(iso || "");
  if (!Number.isFinite(at)) return null;
  return (Date.now() - at) / (24 * 60 * 60 * 1000);
}

const TYPE_SORTS = [
  { value: "name-asc", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" },
  { value: "schema", label: "By schema" },
];

const ATTR_SORTS = [
  { value: "name-asc", label: "Name A–Z" },
  { value: "type", label: "By data type" },
  { value: "broken-first", label: "Broken references first" },
];

function SchemaRow({ schema, siteOrigin }) {
  const dead = schema.objectTypeCount === 0 || schema.objectCount === 0;
  return (
    <div className="issue-type-row">
      <div className="issue-type-row__identity">
        <JiraLink className="issue-type-row__name" href={buildAssetSchemaUrl(siteOrigin, schema.id)} title={`Open ${schema.name} in Assets`}>{schema.name}</JiraLink>
        <span className="issue-type-row__desc">
          {schema.schemaKey ? `${schema.schemaKey} · ` : ""}
          {formatNumber(schema.objectTypeCount)} object type{schema.objectTypeCount === 1 ? "" : "s"} ·{" "}
          {formatNumber(schema.objectCount)} object{schema.objectCount === 1 ? "" : "s"}
        </span>
      </div>
      <div className="issue-type-row__meta">
        {dead && (
          <Chip tone="warning" title={schema.objectTypeCount === 0 ? "No object types defined" : "No objects of any type"}>
            {schema.objectTypeCount === 0 ? "no types" : "no objects"}
          </Chip>
        )}
      </div>
    </div>
  );
}

function ObjectTypeRow({ type, schemaName, orphan, bare, objectCount }) {
  const measured = objectCount != null;
  return (
    <div className="issue-type-row">
      <div className="issue-type-row__identity">
        <span className="issue-type-row__name">{type.name}</span>
        <span className="issue-type-row__desc">
          {schemaName}
          {type.parentId ? ` · child of ${type.parentName || `#${type.parentId}`}` : ""}
          {measured && !type.abstract ? ` · ${formatNumber(objectCount)} object${objectCount === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      <div className="issue-type-row__meta">
        {type.abstract && <Chip tone="neutral" title="An abstract type — nothing is an instance of it directly">abstract</Chip>}
        {orphan && <Chip tone="critical" title="Its parent object type is not in the catalogue">broken parent</Chip>}
        {bare && !type.abstract && <Chip tone="warning" title="No attribute beyond the built-in Name">no attributes</Chip>}
        {measured && !type.abstract && objectCount === 0 && (
          <Chip tone="info" title="The object-count crawl found no objects of this type">empty</Chip>
        )}
      </div>
    </div>
  );
}

function AttributeRow({ attr, typeName, broken }) {
  return (
    <div className="issue-type-row">
      <div className="issue-type-row__identity">
        <span className="issue-type-row__name">{attr.name}</span>
        <span className="issue-type-row__desc">
          {typeName ? `${typeName} · ` : ""}{attr.dataType}
          {attr.referenceObjectTypeId ? ` → ${attr.referenceTargetName || `#${attr.referenceObjectTypeId}`}` : ""}
        </span>
      </div>
      <div className="issue-type-row__meta">
        {attr.system && <Chip tone="neutral" title="A built-in system attribute">system</Chip>}
        {broken && <Chip tone="critical" title="Points at an object type that is not in the catalogue">broken reference</Chip>}
      </div>
    </div>
  );
}

function AssetFindings({ governance }) {
  const g = governance || {};
  const rows = [];
  if (g.deadSchemaCount > 0) {
    rows.push({
      key: "dead-schemas", tone: "warning", count: g.deadSchemaCount,
      title: "Object schemas with nothing in them",
      detail: "No object types, or types but no objects — a namespace every AQL autocomplete resolves to nothing.",
    });
  }
  if (g.brokenReferenceCount > 0) {
    rows.push({
      key: "broken-references", tone: "critical", count: g.brokenReferenceCount,
      title: "Reference attributes pointing at a type that is gone",
      detail: "The attribute still shows on every object of its type and resolves to nothing.",
    });
  }
  if (g.brokenHierarchyCount > 0) {
    rows.push({
      key: "broken-hierarchy", tone: "critical", count: g.brokenHierarchyCount,
      title: "Object types whose parent is missing",
      detail: "Every child under the gap inherits attributes from a type that is not there.",
    });
  }
  if (g.bareTypeCount > 0) {
    rows.push({
      key: "bare-types", tone: "info", count: g.bareTypeCount,
      title: "Concrete object types with no attribute of their own",
      detail: "Only the built-in Name — the type records nothing about the thing it represents.",
    });
  }
  if (g.countsMeasured && g.emptyObjectTypeCount > 0) {
    rows.push({
      key: "empty-types", tone: "info", count: g.emptyObjectTypeCount,
      title: "Object types with attributes but never an object",
      detail: `Measured against the ${formatNumber(g.measuredConcreteTypes)} types the object-count crawl has reached — populate them or retire them.`,
    });
  }

  return (
    <Panel title="What needs attention" icon="alertTriangle" description="What the Assets pillar of the site health score is built from.">
      {rows.length === 0
        ? <EmptyState inline>Nothing flagged. Every schema is populated, every reference resolves and every concrete type has an attribute of its own.</EmptyState>
        : rows.map((r) => <FindingRow key={r.key} tone={r.tone} count={r.count} title={r.title} detail={r.detail} />)}
    </Panel>
  );
}

export function AssetsTab({ intent, siteOrigin }) {
  const [view, setView] = usePersistentState("observatory.section.assets", "overview");
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [building, setBuilding] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [typeSort, setTypeSort] = React.useState("name-asc");
  const [attrSort, setAttrSort] = React.useState("name-asc");

  useNavIntent(intent, (nav) => {
    if (nav.view) setView(nav.view);
    setSearch(nav.search ?? "");
  });

  const load = React.useCallback(async () => {
    try {
      const result = await invoke("getAssetInventory", {});
      setData(result);
      setError("");
    } catch (err) {
      setError(err?.message || "Could not load the Assets inventory.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  // The Assets pillar of the site health score, on its own so this tab shows the same
  // governance reading the Overview does -- matching ScreensTab and IssueTypesTab.
  const [pillar, setPillar] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    invoke("getPillarHealth", { pillar: "assets" })
      .then((result) => { if (!cancelled) setPillar(result?.pillar || null); })
      .catch(() => { if (!cancelled) setPillar(null); });
    return () => { cancelled = true; };
  }, [data?.refreshedAt]);

  const isBuilding = ["building", "queued"].includes(data?.state) && !data?.staleBuild;
  const isCountCrawling = data?.typeCountCrawl?.state === "building" && !data?.typeCountCrawl?.staleBuild;
  useVisiblePolling(isBuilding || isCountCrawling, load, BUILD_POLL_MS);

  async function startBuild() {
    setBuilding(true);
    setError("");
    setNotice("");
    try {
      const result = await invoke("buildAssetInventory", {});
      await load();
      if (result?.error) {
        setError(result.error);
      } else if (result?.queued === false && result?.reason === "already-building") {
        setNotice("A build is already running. This page refreshes itself while it does.");
      } else {
        setNotice("Build queued. This page refreshes itself while it runs.");
      }
    } catch (err) {
      setError(err?.message || "Could not start the build.");
    } finally {
      setBuilding(false);
    }
  }

  const [countCrawling, setCountCrawling] = React.useState(false);

  async function startCountCrawl() {
    setCountCrawling(true);
    setError("");
    setNotice("");
    try {
      const result = await invoke("buildAssetTypeCountCrawl", {});
      await load();
      if (result?.error) {
        setError(result.error);
      } else if (result?.queued === false && result?.reason === "already-building") {
        setNotice("An object-count crawl is already running. This page refreshes itself while it does.");
      } else {
        setNotice("Object-count crawl queued — one AQL call per concrete object type. This page refreshes itself while it runs.");
      }
    } catch (err) {
      setError(err?.message || "Could not start the object-count crawl.");
    } finally {
      setCountCrawling(false);
    }
  }

  const buildAction = (
    <>
      <AskRovo
        agent="observatory-assets-expert"
        scope="the Assets object structure"
        context="the snapshot age and the schema / object-type counts"
        disabled={Boolean(data?.neverBuilt)}
        buildPrompt={() =>
          buildRovoPrompt({
            task: "Give me an overview of the Assets object structure on this site and what to look at first.",
            facts: [["Snapshot built", data?.refreshedAt || "unknown"], ["Assets enabled", data?.assetsEnabled === false ? "no (needs JSM Premium)" : "yes"], ["Object schemas", data?.schemas?.length ?? null], ["Object types", data?.objectTypes?.length ?? null], ["Attributes", data?.attributes?.length ?? null]],
          })
        }
      />
      <button type="button" className="secondary-button" onClick={startBuild} disabled={building || isBuilding}>
      <Icon name="refreshCw" size={13} />
      {isBuilding ? "Building…" : data?.neverBuilt || data?.assetsEnabled === false ? "Check again" : "Rebuild"}
      </button>
      {!data?.neverBuilt && data?.assetsEnabled !== false && (
        <button
          type="button"
          className="secondary-button"
          onClick={startCountCrawl}
          disabled={countCrawling || isCountCrawling}
          title="One AQL call per concrete object type. A separate, opt-in crawl — the structure build above never counts live objects."
        >
          <Icon name="barChart" size={13} />
          {isCountCrawling ? "Measuring…" : data?.governance?.countsMeasured ? "Remeasure object counts" : "Measure object counts"}
        </button>
      )}
    </>
  );

  if (loading && !data) {
    return <div className="empty-state">Loading the Assets inventory…</div>;
  }

  const header = (
    <PageHeader
      title="Assets"
      description="JSM Assets object schemas, their object types and attributes — the CMDB's shape. Read-only; structure only, never the objects."
      meta={data?.refreshedAt ? `Built ${formatRelativeTime(data.refreshedAt)}` : "Never built"}
      actions={buildAction}
    />
  );

  const banners = (
    <>
      {error && <div className="danger-zone__error" role="alert">{error}</div>}
      {notice && !error && <p className="admin-config-row__hint" role="status">{notice}</p>}
      {isBuilding && <p className="admin-config-row__hint">Reading the CMDB structure… this page refreshes itself.</p>}
      {data?.staleBuild && (
        <p className="admin-config-row__hint">A build was started but is no longer running. Rebuild to recover it.</p>
      )}
      {isCountCrawling && <p className="admin-config-row__hint">Measuring live object counts, one AQL call per concrete type… this page refreshes itself.</p>}
      {data?.typeCountCrawl?.unmeasuredTypes > 0 && !isCountCrawling && (
        <p className="admin-config-row__hint">
          The last object-count crawl could not measure {formatNumber(data.typeCountCrawl.unmeasuredTypes)} of the concrete types — they stay unmeasured rather than counted as empty.
        </p>
      )}
    </>
  );

  // Assets is not licensed on this site. A distinct, terminal state -- not an error and not
  // an empty catalogue.
  if (data?.assetsEnabled === false) {
    return (
      <div className="admin-assets">
        {header}
        {banners}
        <EmptyState action={buildAction}>
          <strong>Assets is not enabled on this site.</strong>
          <div>{data?.lastError || "JSM Assets (formerly Insight) needs a Jira Service Management Premium or Enterprise plan. Nothing to govern here until it is provisioned."}</div>
        </EmptyState>
      </div>
    );
  }

  if (data?.neverBuilt) {
    return (
      <div className="admin-assets">
        {header}
        {banners}
        {data?.lastError && !isBuilding && (
          <div className="danger-zone__error" role="alert">Last build failed: {data.lastError}</div>
        )}
        {isBuilding ? (
          <Panel title="Building the first inventory" icon="refreshCw">
            <p>
              Discovering the Assets workspace, then reading every object schema, its object
              types and their attributes. Structure only — no objects are walked. This page
              refreshes itself; you can leave it.
            </p>
            {data?.startedAt && <p className="admin-config-row__hint">Started {formatRelativeTime(data.startedAt)}.</p>}
          </Panel>
        ) : (
          <EmptyState action={buildAction}>
            No Assets inventory has been built yet. It is also produced by every full and quick
            scan — or build it on its own here.
          </EmptyState>
        )}
      </div>
    );
  }

  const g = data?.governance || null;
  const schemas = data?.schemas || [];
  const objectTypes = data?.objectTypes || [];
  const attributes = data?.attributes || [];

  const schemaNameById = new Map(schemas.map((s) => [String(s.id), s.name]));
  const typeById = new Map(objectTypes.map((t) => [String(t.id), t]));

  const orphanTypeIds = new Set((g?.brokenHierarchy || []).map((t) => String(t.id)));
  const brokenAttrIds = new Set((g?.brokenReferences || []).map((a) => String(a.id)));
  const bareTypeIds = new Set((g?.bareTypes || []).map((t) => String(t.id)));
  const objectCountByType = new Map((data?.typeCounts || []).map((c) => [String(c.objectTypeId), c.objectCount]));

  const buildAgeDays = daysSince(data?.refreshedAt);
  const isStale = buildAgeDays != null && buildAgeDays > STALE_AFTER_DAYS;

  const items = [
    { key: "overview", label: "Overview", icon: "barChart" },
    { key: "schemas", label: "Schemas", icon: "folder", badge: formatNumber(schemas.length) },
    { key: "types", label: "Object types", icon: "layers", badge: formatNumber(objectTypes.length) },
    { key: "attributes", label: "Attributes", icon: "sliders", badge: formatNumber(attributes.length) },
  ];

  const term = search.trim().toLowerCase();

  const filteredTypes = (() => {
    let rows = objectTypes;
    if (term) {
      rows = rows.filter((t) =>
        t.name.toLowerCase().includes(term) ||
        (schemaNameById.get(String(t.schemaId)) || "").toLowerCase().includes(term));
    }
    const by = {
      "name-asc": (a, b) => a.name.localeCompare(b.name),
      "name-desc": (a, b) => b.name.localeCompare(a.name),
      "schema": (a, b) =>
        (schemaNameById.get(String(a.schemaId)) || "").localeCompare(schemaNameById.get(String(b.schemaId)) || "")
        || a.name.localeCompare(b.name),
    };
    return [...rows].sort(by[typeSort] || by["name-asc"]);
  })();

  const filteredAttrs = (() => {
    let rows = attributes;
    if (term) {
      rows = rows.filter((a) =>
        a.name.toLowerCase().includes(term) ||
        (a.dataType || "").toLowerCase().includes(term));
    }
    const by = {
      "name-asc": (a, b) => a.name.localeCompare(b.name),
      "type": (a, b) => (a.dataType || "").localeCompare(b.dataType || "") || a.name.localeCompare(b.name),
      "broken-first": (a, b) =>
        (brokenAttrIds.has(String(b.id)) ? 1 : 0) - (brokenAttrIds.has(String(a.id)) ? 1 : 0)
        || a.name.localeCompare(b.name),
    };
    return [...rows].sort(by[attrSort] || by["name-asc"]);
  })();

  return (
    <div className="admin-assets">
      {header}
      {banners}
      {data?.lastError && !isBuilding && (
        <div className="danger-zone__error" role="alert">Last build failed: {data.lastError}</div>
      )}

      <StatRow>
        <StatTile label="Object schemas" value={formatNumber(g?.totalSchemas ?? schemas.length)} hint="Namespaces in the CMDB" icon="folder" />
        <StatTile label="Object types" value={formatNumber(g?.totalObjectTypes ?? objectTypes.length)} hint={`${formatNumber(g?.concreteObjectTypes ?? 0)} concrete`} icon="layers" />
        <StatTile label="Attributes" value={formatNumber(g?.totalAttributes ?? attributes.length)} hint={`${formatNumber(g?.referenceAttributeCount ?? 0)} object references`} icon="sliders" />
        <StatTile
          label="Broken references"
          value={formatNumber(g?.brokenReferenceCount ?? 0)}
          hint={(g?.brokenReferenceCount ?? 0) > 0 ? "Point at a type that is gone" : "Every reference resolves"}
          tone={(g?.brokenReferenceCount ?? 0) > 0 ? "critical" : "success"}
          icon="alertTriangle"
        />
        <StatTile
          label="Empty object types"
          value={g?.countsMeasured ? formatNumber(g.emptyObjectTypeCount) : "—"}
          hint={g?.countsMeasured ? `of ${formatNumber(g.measuredConcreteTypes)} measured` : "Never measured — run the object-count crawl"}
          tone={g?.countsMeasured && g.emptyObjectTypeCount > 0 ? "warning" : "neutral"}
          icon="database"
        />
      </StatRow>

      {isStale && (
        <Panel title="This inventory is stale" icon="alertTriangle">
          <p>It was built {Math.floor(buildAgeDays)} days ago. Every full and quick scan refreshes it — run one, or rebuild here.</p>
        </Panel>
      )}

      <SubNavLayout items={items} activeKey={view} onSelect={setView}>
        {view === "overview" && (
          <PanelGrid>
            <GridSpan>
              <PillarHealthPanel pillar={pillar} />
            </GridSpan>

            <GridSpan>
              <AssetFindings governance={g} />
            </GridSpan>

            <GridSpan>
              <Panel title="Schemas by object count" icon="barChart" description="Where the CMDB's objects actually live.">
                <BarList
                  items={schemas.slice(0, 10).map((s) => ({ label: s.name, count: s.objectCount }))}
                  labelKey="label"
                  valueKey="count"
                  formatValue={formatNumber}
                  emptyMessage="No object schemas in this snapshot."
                />
              </Panel>
            </GridSpan>
          </PanelGrid>
        )}

        {view === "schemas" && (
          <Panel title="Object schemas" icon="folder" description="Every namespace in the CMDB, with its type and object totals.">
            {schemas.length ? (
              <div className="issue-type-list">
                {schemas.map((s) => <SchemaRow key={s.id} schema={s} siteOrigin={siteOrigin} />)}
              </div>
            ) : (
              <EmptyState inline>No object schemas in this snapshot.</EmptyState>
            )}
          </Panel>
        )}

        {view === "types" && (
          <Panel title="Object types" icon="layers" description="The hierarchical type catalogue across every schema.">
            <SortFilterBar
              search={search}
              onSearchChange={setSearch}
              searchLabel="Search object types"
              searchPlaceholder="Search types by name or schema…"
              sort={typeSort}
              onSortChange={setTypeSort}
              sortOptions={TYPE_SORTS}
              resultCount={filteredTypes.length}
              totalCount={objectTypes.length}
              onClear={() => { setSearch(""); setTypeSort("name-asc"); }}
            />
            {filteredTypes.length ? (
              <div className="issue-type-list">
                {filteredTypes.map((t) => (
                  <ObjectTypeRow
                    key={t.id}
                    type={{ ...t, parentName: t.parentId ? typeById.get(String(t.parentId))?.name : null }}
                    schemaName={schemaNameById.get(String(t.schemaId)) || `#${t.schemaId}`}
                    orphan={orphanTypeIds.has(String(t.id))}
                    bare={bareTypeIds.has(String(t.id))}
                    objectCount={objectCountByType.has(String(t.id)) ? objectCountByType.get(String(t.id)) : null}
                  />
                ))}
              </div>
            ) : (
              <EmptyState inline>{term ? "No object types match that search." : "No object types in this snapshot."}</EmptyState>
            )}
          </Panel>
        )}

        {view === "attributes" && (
          <Panel title="Attributes" icon="sliders" description="Every attribute defined on every object type. Object references are the ones that can break.">
            <SortFilterBar
              search={search}
              onSearchChange={setSearch}
              searchLabel="Search attributes"
              searchPlaceholder="Search attributes by name or data type…"
              sort={attrSort}
              onSortChange={setAttrSort}
              sortOptions={ATTR_SORTS}
              resultCount={filteredAttrs.length}
              totalCount={attributes.length}
              onClear={() => { setSearch(""); setAttrSort("name-asc"); }}
            />
            {filteredAttrs.length ? (
              <div className="issue-type-list">
                {filteredAttrs.map((a) => (
                  <AttributeRow
                    key={a.id}
                    attr={{ ...a, referenceTargetName: a.referenceObjectTypeId ? typeById.get(String(a.referenceObjectTypeId))?.name : null }}
                    typeName={a.objectTypeId ? typeById.get(String(a.objectTypeId))?.name : null}
                    broken={brokenAttrIds.has(String(a.id))}
                  />
                ))}
              </div>
            ) : (
              <EmptyState inline>{term ? "No attributes match that search." : "No attributes in this snapshot."}</EmptyState>
            )}
          </Panel>
        )}
      </SubNavLayout>
    </div>
  );
}
